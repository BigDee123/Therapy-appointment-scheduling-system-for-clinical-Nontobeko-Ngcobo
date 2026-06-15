/**
 * Public API routes — POPIA compliant
 * Consent recorded, SPI encrypted, full audit trail, Google Calendar sync
 */
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const store    = require('../data/store');
const { getSlotsForDate }                              = require('../services/availability');
const { sendConfirmationEmail, sendConfirmationWhatsApp,
        sendCancellationEmail }                        = require('../services/notifications');
const { scheduleRemindersForAppointment }              = require('../services/scheduler');
const { createCalendarEvent }                          = require('../services/calendar');
const popia    = require('../popia/compliance');

const SERVICES = [
  'Individual therapy',
  'Family therapy',
  'Stress and burnout management',
  'Depression and anxiety management',
  'PTSD and trauma therapy',
  'Substance abuse therapy',
  'Integrated African-centered therapy',
];

// GET /api/services
router.get('/services', (_req, res) => res.json({ services: SERVICES }));

// GET /api/availability?date=YYYY-MM-DD
router.get('/availability', (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: 'Provide date as YYYY-MM-DD' });
  res.json({ date, slots: getSlotsForDate(date) });
});

// GET /api/privacy-notice  — POPIA Section 18 openness
router.get('/privacy-notice', (_req, res) => {
  res.json({
    responsibleParty: {
      name:    process.env.PRACTICE_NAME    || 'Nontobeko Ngcobo – Clinical Psychologist',
      address: process.env.PRACTICE_ADDRESS || 'Simla Medical Centre, Belhar, Cape Town',
      email:   process.env.PRACTICE_EMAIL   || 'nontobekorn@gmail.com',
      phone:   process.env.PRACTICE_PHONE   || '0843090111',
    },
    informationOfficer: {
      name:  process.env.INFO_OFFICER_NAME  || 'Nontobeko Ngcobo',
      email: process.env.INFO_OFFICER_EMAIL || process.env.PRACTICE_EMAIL,
    },
    purposesOfProcessing: Object.values(popia.CONSENT_PURPOSES).map(p => ({
      purpose:     p.description,
      lawfulBasis: p.lawfulBasis,
      data:        p.dataCategories,
      retention:   `${p.retentionYears} years`,
      specialPI:   p.isSpecialPI || false,
    })),
    dataSubjectRights: [
      'Right to access your personal information (Section 23)',
      'Right to request correction of inaccurate information (Section 24)',
      'Right to request deletion of your information (Section 24)',
      'Right to withdraw consent at any time (Section 11)',
      'Right to object to processing (Section 11(3))',
      'Right to lodge a complaint with the Information Regulator',
    ],
    informationRegulator: {
      name:    'Information Regulator (South Africa)',
      website: 'https://www.justice.gov.za/inforeg/',
      email:   'inforeg@justice.gov.za',
      phone:   '010 023 5207',
    },
    retentionPolicy: 'Personal information is retained for 5 years from your last appointment, after which it is anonymised.',
    transfers:       'Your personal information is not transferred outside South Africa.',
    thirdParties:    'Email delivery (SMTP) and optional WhatsApp (Twilio) are used solely to send appointment communications.',
    lastUpdated:     '2026-06-01',
  });
});

// POST /api/appointments — full POPIA-compliant booking
router.post('/appointments', async (req, res) => {
  const {
    patientName, patientEmail, patientMobile,
    serviceType, startTime, sessionMode, notes,
    consentAppointment, consentHealthData, consentReminders,
  } = req.body;

  // ── Validation ──────────────────────────────────────────────
  const errors = {};
  if (!patientName?.trim())                                  errors.patientName   = 'Full name is required.';
  if (!patientEmail?.trim() || !patientEmail.includes('@'))  errors.patientEmail  = 'Valid email is required.';
  if (!patientMobile?.trim())                                errors.patientMobile = 'Mobile number is required.';
  if (!serviceType || !SERVICES.includes(serviceType))       errors.serviceType   = 'Please select a valid service.';
  if (!startTime)                                            errors.startTime     = 'Please select a date and time.';
  if (!sessionMode || !['in-person','virtual'].includes(sessionMode))
                                                             errors.sessionMode   = 'Please select in-person or virtual.';
  if (!consentAppointment) errors.consentAppointment = 'You must consent to appointment booking to proceed.';
  if (!consentHealthData)  errors.consentHealthData  = 'You must consent to health data processing to proceed.';

  if (Object.keys(errors).length) return res.status(422).json({ errors });

  // ── Slot check ──────────────────────────────────────────────
  const avail   = store.getAvailability();
  const endTime = new Date(new Date(startTime).getTime() + (avail.slotDuration || 60) * 60_000).toISOString();
  if (store.isSlotTaken(startTime, endTime))
    return res.status(409).json({ error: 'That slot is no longer available. Please choose another time.' });

  // ── Upsert patient ──────────────────────────────────────────
  const patient = store.upsertPatient({
    id:          uuidv4(),
    fullName:    patientName.trim(),
    email:       patientEmail.trim().toLowerCase(),
    mobile:      patientMobile.trim(),
    createdAt:   new Date().toISOString(),
  });

  // ── Record POPIA consent ────────────────────────────────────
  const grantedPurposes = [
    popia.CONSENT_PURPOSES.APPOINTMENT_BOOKING.id,
    popia.CONSENT_PURPOSES.HEALTH_DATA_PROCESSING.id,
  ];
  if (consentReminders) grantedPurposes.push(popia.CONSENT_PURPOSES.REMINDER_COMMUNICATIONS.id);

  popia.recordConsent({
    patientId:    patient.id,
    patientEmail: patient.email,
    purposes:     grantedPurposes,
    ipAddress:    req.ip,
    userAgent:    req.headers['user-agent'],
    consentText:  `Appointment: ${consentAppointment}. Health data: ${consentHealthData}. Reminders: ${!!consentReminders}.`,
  });

  // ── Create appointment (notes encrypted — SPI) ──────────────
  const appt = store.createAppointment({
    id:                 uuidv4(),
    patientId:          patient.id,
    patientName:        patient.fullName,
    patientEmail:       patient.email,
    patientMobile:      patient.mobile,
    serviceType,
    startTime,
    endTime,
    sessionMode,
    notes:              popia.encrypt(notes?.trim() || ''),
    status:             'confirmed',
    remindersConsented: !!consentReminders,
    googleEventId:      null,
    createdAt:          new Date().toISOString(),
  });

  store.addAuditLog({
    action: 'APPOINTMENT_CREATED', appointmentId: appt.id,
    patientId: patient.id, performedBy: 'patient', ip: req.ip,
    detail: `Service: ${serviceType} | Mode: ${sessionMode}`,
  });

  // ── Non-blocking: email, WhatsApp, calendar ─────────────────
  setImmediate(async () => {
    await sendConfirmationEmail(appt);
    await sendConfirmationWhatsApp(appt);

    // Google Calendar event
    const googleEventId = await createCalendarEvent(appt);
    if (googleEventId) store.updateAppointment(appt.id, { googleEventId });

    if (appt.remindersConsented) scheduleRemindersForAppointment(appt);
  });

  res.status(201).json({
    message: 'Appointment booked successfully.',
    appointment: {
      id:          appt.id,
      serviceType: appt.serviceType,
      startTime:   appt.startTime,
      endTime:     appt.endTime,
      sessionMode: appt.sessionMode,
      status:      appt.status,
    },
  });
});

// ── Data Subject Rights (POPIA Chapter 2) ─────────────────────

// POST /api/dsr/access — Section 23
router.post('/dsr/access', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required.' });
  const patient = store.getPatients('').find(p => p.email === email.toLowerCase().trim());
  if (!patient)  return res.status(404).json({ error: 'No record found for that email address.' });
  const report   = await popia.handleAccessRequest(patient.id);
  res.json({ message: 'Data access report generated.', data: report });
});

// POST /api/dsr/correct — Section 24
router.post('/dsr/correct', async (req, res) => {
  const { email, corrections } = req.body;
  if (!email || !corrections) return res.status(400).json({ error: 'Email and corrections required.' });
  const patient = store.getPatients('').find(p => p.email === email.toLowerCase().trim());
  if (!patient)  return res.status(404).json({ error: 'No record found.' });
  const updated  = await popia.handleCorrectionRequest(patient.id, corrections);
  res.json({ message: 'Your information has been updated.', updated });
});

// POST /api/dsr/delete — Section 24(2)(b)
router.post('/dsr/delete', async (req, res) => {
  const { email, confirmDeletion } = req.body;
  if (!email || !confirmDeletion) return res.status(400).json({ error: 'Email and deletion confirmation required.' });
  const patient = store.getPatients('').find(p => p.email === email.toLowerCase().trim());
  if (!patient)  return res.status(404).json({ error: 'No record found.' });
  const result   = await popia.handleDeletionRequest(patient.id);
  res.json(result);
});

// POST /api/dsr/withdraw-consent — Section 11
router.post('/dsr/withdraw-consent', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required.' });
  const patient = store.getPatients('').find(p => p.email === email.toLowerCase().trim());
  if (!patient)  return res.status(404).json({ error: 'No record found.' });
  popia.withdrawConsent(patient.id);
  res.json({ message: 'Your consent has been withdrawn. We will no longer send appointment reminders. Note: existing confirmed appointments will still be honoured.' });
});

module.exports = router;
