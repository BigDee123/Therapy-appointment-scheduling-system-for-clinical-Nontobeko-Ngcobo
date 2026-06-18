const router = require('express').Router();
const { v4: uuidv4 }     = require('uuid');
const store              = require('../data/store');
const { getSlotsForDate }= require('../services/availability');
const { sendConfirmationEmail, sendConfirmationWhatsApp } = require('../services/notifications');
const { scheduleRemindersForAppointment } = require('../services/scheduler');
const { createCalendarEvent }            = require('../services/calendar');
const popia              = require('../popia/compliance');

const SERVICES = [
  'Individual therapy','Family therapy','Stress and burnout management',
  'Depression and anxiety management','PTSD and trauma therapy',
  'Substance abuse therapy','Integrated African-centered therapy',
];

router.get('/services', (_req, res) => res.json({ services: SERVICES }));

router.get('/availability', async (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: 'Provide date as YYYY-MM-DD' });
  try {
    const slots = await getSlotsForDate(date);
    res.json({ date, slots });
  } catch (err) {
    res.status(500).json({ error: 'Could not load availability.' });
  }
});

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
    dataSubjectRights: [
      'Right to access (Section 23)','Right to correction (Section 24)',
      'Right to deletion (Section 24)','Right to withdraw consent (Section 11)',
    ],
    informationRegulator: {
      website:'https://www.justice.gov.za/inforeg/',
      email:  'inforeg@justice.gov.za', phone:'010 023 5207',
    },
    retentionPolicy: '5 years from last appointment, then anonymised.',
    lastUpdated: '2026-06-01',
  });
});

router.post('/appointments', async (req, res) => {
  const {
    patientName, patientEmail, patientMobile,
    serviceType, startTime, sessionMode, notes,
    consentAppointment, consentHealthData, consentReminders,
  } = req.body;

  const errors = {};
  if (!patientName?.trim())                               errors.patientName   = 'Full name is required.';
  if (!patientEmail?.trim() || !patientEmail.includes('@')) errors.patientEmail = 'Valid email is required.';
  if (!patientMobile?.trim())                             errors.patientMobile = 'Mobile number is required.';
  if (!serviceType || !SERVICES.includes(serviceType))    errors.serviceType   = 'Please select a valid service.';
  if (!startTime)                                         errors.startTime     = 'Please select a date and time.';
  if (!sessionMode || !['in-person','virtual'].includes(sessionMode)) errors.sessionMode = 'Please select session mode.';
  if (!consentAppointment) errors.consentAppointment = 'Appointment consent is required.';
  if (!consentHealthData)  errors.consentHealthData  = 'Health data consent is required.';
  if (Object.keys(errors).length) return res.status(422).json({ errors });

  try {
    const avail   = await store.getAvailability();
    const endTime = new Date(new Date(startTime).getTime() + (avail.slotDuration || 60) * 60_000).toISOString();

    if (await store.isSlotTaken(startTime, endTime))
      return res.status(409).json({ error: 'That slot is no longer available. Please choose another time.' });

    const patient = await store.upsertPatient({
      id:        uuidv4(),
      fullName:  patientName.trim(),
      email:     patientEmail.trim().toLowerCase(),
      mobile:    patientMobile.trim(),
      createdAt: new Date().toISOString(),
    });

    const grantedPurposes = [
      popia.CONSENT_PURPOSES.APPOINTMENT_BOOKING.id,
      popia.CONSENT_PURPOSES.HEALTH_DATA_PROCESSING.id,
    ];
    if (consentReminders) grantedPurposes.push(popia.CONSENT_PURPOSES.REMINDER_COMMUNICATIONS.id);

    await popia.recordConsent({
      patientId:    patient.id,
      patientEmail: patient.email,
      purposes:     grantedPurposes,
      ipAddress:    req.ip,
      userAgent:    req.headers['user-agent'],
      consentText:  `Appointment:${consentAppointment} Health:${consentHealthData} Reminders:${!!consentReminders}`,
    });

    const appt = await store.createAppointment({
      id:                uuidv4(),
      patientId:         patient.id,
      patientName:       patient.fullName,
      patientEmail:      patient.email,
      patientMobile:     patient.mobile,
      serviceType,
      startTime,
      endTime,
      sessionMode,
      notes:             popia.encrypt(notes?.trim() || ''),
      status:            'confirmed',
      remindersConsented: !!consentReminders,
      googleEventId:     null,
      createdAt:         new Date().toISOString(),
    });

    await store.addAuditLog({
      action: 'APPOINTMENT_CREATED', appointmentId: appt.id,
      patientId: patient.id, performedBy: 'patient', ip: req.ip,
      detail: `Service: ${serviceType} | Mode: ${sessionMode}`,
    });

    setImmediate(async () => {
      await sendConfirmationEmail(appt);
      await sendConfirmationWhatsApp(appt);
      const googleEventId = await createCalendarEvent(appt);
      if (googleEventId) await store.updateAppointment(appt.id, { googleEventId });
      if (appt.remindersConsented) await scheduleRemindersForAppointment(appt);
    });

    res.status(201).json({
      message: 'Appointment booked successfully.',
      appointment: { id: appt.id, serviceType, startTime, endTime, sessionMode, status: 'confirmed' },
    });
  } catch (err) {
    console.error('[booking] Error:', err.message);
    res.status(500).json({ error: 'Booking failed. Please try again.' });
  }
});

// ── Data Subject Rights ───────────────────────────────────────────────────────
router.post('/dsr/access', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required.' });
  try {
    const patients = await store.getPatients('');
    const patient  = patients.find(p => p.email === email.toLowerCase().trim());
    if (!patient) return res.status(404).json({ error: 'No record found for that email address.' });
    const report   = await popia.handleAccessRequest(patient.id);
    res.json({ message: 'Data access report generated.', data: report });
  } catch (err) { res.status(500).json({ error: 'Request failed.' }); }
});

router.post('/dsr/correct', async (req, res) => {
  const { email, corrections } = req.body;
  if (!email || !corrections) return res.status(400).json({ error: 'Email and corrections required.' });
  try {
    const patients = await store.getPatients('');
    const patient  = patients.find(p => p.email === email.toLowerCase().trim());
    if (!patient) return res.status(404).json({ error: 'No record found.' });
    const updated  = await popia.handleCorrectionRequest(patient.id, corrections);
    res.json({ message: 'Your information has been updated.', updated });
  } catch (err) { res.status(500).json({ error: 'Request failed.' }); }
});

router.post('/dsr/delete', async (req, res) => {
  const { email, confirmDeletion } = req.body;
  if (!email || !confirmDeletion) return res.status(400).json({ error: 'Email and confirmation required.' });
  try {
    const patients = await store.getPatients('');
    const patient  = patients.find(p => p.email === email.toLowerCase().trim());
    if (!patient) return res.status(404).json({ error: 'No record found.' });
    const result   = await popia.handleDeletionRequest(patient.id);
    res.json(result);
  } catch (err) { res.status(500).json({ error: 'Request failed.' }); }
});

router.post('/dsr/withdraw-consent', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required.' });
  try {
    const patients = await store.getPatients('');
    const patient  = patients.find(p => p.email === email.toLowerCase().trim());
    if (!patient) return res.status(404).json({ error: 'No record found.' });
    await popia.withdrawConsent(patient.id);
    res.json({ message: 'Your consent has been withdrawn. We will no longer send reminders.' });
  } catch (err) { res.status(500).json({ error: 'Request failed.' }); }
});

module.exports = router;
