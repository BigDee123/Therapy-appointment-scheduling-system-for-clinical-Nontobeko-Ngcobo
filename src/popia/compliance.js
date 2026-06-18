/**
 * POPIA Compliance Engine — async version for Supabase store
 */
const crypto = require('crypto');
const store  = require('../data/store');

const ENCRYPTION_KEY = (() => {
  const key = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || 'default-dev-key-change-in-production';
  return crypto.createHash('sha256').update(key).digest();
})();

function encrypt(plaintext) {
  if (!plaintext) return null;
  const iv        = crypto.randomBytes(12);
  const cipher    = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag   = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(ciphertext) {
  if (!ciphertext) return null;
  try {
    const [ivHex, tagHex, dataHex] = ciphertext.split(':');
    if (!ivHex || !tagHex || !dataHex) return null;
    const iv      = Buffer.from(ivHex,  'hex');
    const authTag = Buffer.from(tagHex, 'hex');
    const data    = Buffer.from(dataHex,'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch { return null; }
}

function pseudonymise(value) {
  if (!value) return null;
  return crypto.createHmac('sha256', ENCRYPTION_KEY).update(String(value)).digest('hex').slice(0, 16);
}

function anonymiseRecord(record) {
  return {
    ...record,
    patientName:   '[anonymised]',
    patientEmail:  '[anonymised]',
    patientMobile: '[anonymised]',
    notes:         null,
    anonymisedAt:  new Date().toISOString(),
  };
}

const CONSENT_PURPOSES = {
  APPOINTMENT_BOOKING: {
    id: 'APPOINTMENT_BOOKING',
    description: 'To schedule and manage therapy appointments',
    lawfulBasis: 'Consent (s.11(1)(a)) and contract (s.11(1)(b))',
    dataCategories: ['name','email','mobile'],
    retentionYears: 5,
  },
  HEALTH_DATA_PROCESSING: {
    id: 'HEALTH_DATA_PROCESSING',
    description: 'To process health information for therapy delivery',
    lawfulBasis: 'Explicit consent for Special Personal Information (s.26(a))',
    dataCategories: ['service_type','clinical_notes'],
    retentionYears: 5,
    isSpecialPI: true,
  },
  REMINDER_COMMUNICATIONS: {
    id: 'REMINDER_COMMUNICATIONS',
    description: 'To send appointment reminders via email and WhatsApp',
    lawfulBasis: 'Consent (s.11(1)(a))',
    dataCategories: ['email','mobile'],
    retentionYears: 5,
  },
};

async function recordConsent({ patientId, patientEmail, purposes, ipAddress, userAgent, consentText }) {
  const { v4: uuidv4 } = require('uuid');
  const record = {
    id:           uuidv4(),
    patientId,
    patientEmail: pseudonymise(patientEmail),
    purposes,
    consentText,
    givenAt:      new Date().toISOString(),
    ipAddress:    ipAddress || null,
    userAgent:    userAgent ? userAgent.slice(0, 200) : null,
    method:       'explicit_checkbox',
    withdrawn:    false,
    withdrawnAt:  null,
  };
  await store.addConsentRecord(record);
  await store.addAuditLog({
    action:      'CONSENT_RECORDED',
    patientId,
    performedBy: 'patient',
    detail:      `Consent for: ${purposes.join(', ')}`,
  });
  return record;
}

async function withdrawConsent(patientId) {
  const records = await store.getConsentRecords(patientId);
  for (const r of records) {
    await store.updateConsentRecord(r.id, { withdrawn: true, withdrawnAt: new Date().toISOString() });
  }
  await store.addAuditLog({
    action: 'CONSENT_WITHDRAWN', patientId, performedBy: 'patient',
    detail: 'Patient withdrew all consent',
  });
}

async function handleAccessRequest(patientId) {
  const patient      = await store.getPatientById(patientId);
  const appointments = (await store.getAppointments({})).filter(a => a.patientId === patientId);
  const consents     = await store.getConsentRecords(patientId);
  if (!patient) return null;

  await store.addAuditLog({
    action: 'DATA_ACCESS_REQUEST', patientId, performedBy: 'patient',
    detail: 'Patient exercised Section 23 right of access',
  });

  return {
    personalInformation: {
      fullName:     patient.fullName,
      email:        patient.email,
      mobile:       patient.mobile,
      registeredAt: patient.createdAt,
    },
    appointments: appointments.map(a => ({
      id:          a.id,
      serviceType: a.serviceType,
      date:        a.startTime,
      mode:        a.sessionMode,
      status:      a.status,
      notes:       decrypt(a.notes),
    })),
    consentHistory: consents.map(c => ({
      purposes:    c.purposes,
      givenAt:     c.givenAt,
      withdrawn:   c.withdrawn,
      withdrawnAt: c.withdrawnAt,
    })),
    retentionPolicy: 'Personal information is retained for 5 years then anonymised.',
    infoOfficer:      process.env.INFO_OFFICER_NAME  || 'Nontobeko Ngcobo',
    infoOfficerEmail: process.env.INFO_OFFICER_EMAIL || process.env.PRACTICE_EMAIL,
  };
}

async function handleCorrectionRequest(patientId, corrections) {
  const allowed = ['fullName','email','mobile'];
  const safe    = Object.fromEntries(Object.entries(corrections).filter(([k]) => allowed.includes(k)));
  const updated = await store.updatePatient(patientId, safe);
  await store.addAuditLog({
    action: 'DATA_CORRECTION_REQUEST', patientId, performedBy: 'patient',
    detail: `Corrected: ${Object.keys(safe).join(', ')}`,
  });
  return updated;
}

async function handleDeletionRequest(patientId) {
  const appointments = (await store.getAppointments({})).filter(a => a.patientId === patientId);
  for (const a of appointments) {
    await store.updateAppointment(a.id, anonymiseRecord(a));
  }
  await store.anonymisePatient(patientId);
  await store.addAuditLog({
    action: 'DATA_DELETION_REQUEST', patientId, performedBy: 'patient',
    detail: 'Patient data anonymised per Section 24 deletion request',
  });
  return { message: 'Your personal information has been anonymised. Appointment records are retained in anonymous form as required by law.' };
}

async function enforceRetentionPolicy() {
  const cutoff      = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 5);
  const appointments = await store.getAppointments({});
  let anonymised     = 0;
  for (const a of appointments) {
    if (a.anonymisedAt) continue;
    if (new Date(a.startTime) < cutoff) {
      await store.updateAppointment(a.id, anonymiseRecord(a));
      anonymised++;
    }
  }
  if (anonymised > 0) {
    await store.addAuditLog({
      action: 'RETENTION_ENFORCEMENT', performedBy: 'system',
      detail: `Anonymised ${anonymised} records older than 5 years`,
    });
    console.log(`[POPIA] Retention: anonymised ${anonymised} records`);
  }
  return anonymised;
}

function logSecurityEvent(type, detail, req) {
  const { v4: uuidv4 } = require('uuid');
  store.addSecurityEvent({
    id:        uuidv4(),
    type,
    detail,
    ip:        req?.ip || null,
    userAgent: req?.headers?.['user-agent']?.slice(0, 200) || null,
    timestamp: new Date().toISOString(),
  }).catch(err => console.error('[popia] logSecurityEvent failed:', err.message));
}

module.exports = {
  encrypt, decrypt, pseudonymise, anonymiseRecord,
  CONSENT_PURPOSES,
  recordConsent, withdrawConsent,
  handleAccessRequest, handleCorrectionRequest, handleDeletionRequest,
  enforceRetentionPolicy, logSecurityEvent,
};
