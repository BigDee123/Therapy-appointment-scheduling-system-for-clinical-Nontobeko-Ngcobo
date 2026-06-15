/**
 * POPIA Compliance Engine
 * Protection of Personal Information Act 4 of 2013 (South Africa)
 * Commenced 1 July 2021
 *
 * Covers all 8 conditions for lawful processing:
 *   1. Accountability
 *   2. Processing limitation
 *   3. Purpose specification
 *   4. Further processing limitation
 *   5. Information quality
 *   6. Openness
 *   7. Security safeguards
 *   8. Data subject participation
 *
 * Special Personal Information (Section 26):
 *   Health and medical data requires EXPLICIT consent and enhanced protection.
 *   All clinical notes and service types in this system qualify as SPI.
 */

const crypto = require('crypto');
const store  = require('../data/store');

// ── Encryption (AES-256-GCM) ──────────────────────────────────────────────────
// Used for Special Personal Information (health/clinical data)
const ENCRYPTION_KEY = (() => {
  const key = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || 'default-dev-key-change-in-production';
  return crypto.createHash('sha256').update(key).digest(); // 32 bytes
})();

function encrypt(plaintext) {
  if (!plaintext) return null;
  const iv         = crypto.randomBytes(12);
  const cipher     = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const encrypted  = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag    = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(ciphertext) {
  if (!ciphertext) return null;
  try {
    const [ivHex, tagHex, dataHex] = ciphertext.split(':');
    const iv       = Buffer.from(ivHex,  'hex');
    const authTag  = Buffer.from(tagHex, 'hex');
    const data     = Buffer.from(dataHex,'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return '[decryption error]';
  }
}

// ── Pseudonymisation ──────────────────────────────────────────────────────────
// POPIA Section 22: allows re-identification only when necessary
function pseudonymise(value) {
  if (!value) return null;
  return crypto.createHmac('sha256', ENCRYPTION_KEY).update(String(value)).digest('hex').slice(0, 16);
}

// ── Anonymisation ─────────────────────────────────────────────────────────────
// POPIA Section 14: irreversible — used after retention period expires
function anonymiseRecord(record) {
  return {
    ...record,
    patientName:   '[anonymised]',
    patientEmail:  '[anonymised]',
    patientMobile: '[anonymised]',
    notes:         null,
    patientId:     pseudonymise(record.patientId),
    _anonymisedAt: new Date().toISOString(),
    _popia:        'anonymised-per-retention-policy',
  };
}

// ── Consent management (POPIA Section 11 & 26) ───────────────────────────────
const CONSENT_PURPOSES = {
  APPOINTMENT_BOOKING: {
    id:          'APPOINTMENT_BOOKING',
    description: 'To schedule, manage and administer therapy appointments',
    lawfulBasis: 'Consent (Section 11(1)(a)) and performance of contract (Section 11(1)(b))',
    dataCategories: ['name', 'email', 'mobile'],
    retentionYears: 5,
  },
  HEALTH_DATA_PROCESSING: {
    id:          'HEALTH_DATA_PROCESSING',
    description: 'To record and process health-related information (service type, clinical notes) necessary for therapy',
    lawfulBasis: 'Explicit consent for Special Personal Information (Section 26(a))',
    dataCategories: ['service_type', 'clinical_notes', 'session_mode'],
    retentionYears: 5,
    isSpecialPI:  true,
  },
  REMINDER_COMMUNICATIONS: {
    id:          'REMINDER_COMMUNICATIONS',
    description: 'To send appointment reminders via email and WhatsApp',
    lawfulBasis: 'Consent (Section 11(1)(a))',
    dataCategories: ['email', 'mobile'],
    retentionYears: 5,
  },
};

function recordConsent({ patientId, patientEmail, purposes, ipAddress, userAgent, consentText }) {
  const { v4: uuidv4 } = require('uuid');
  const record = {
    id:          uuidv4(),
    patientId,
    patientEmail: pseudonymise(patientEmail), // store pseudonymised for audit
    purposes,
    consentText,  // exact text shown to user at time of consent
    givenAt:     new Date().toISOString(),
    ipAddress:   ipAddress || null,
    userAgent:   userAgent ? userAgent.slice(0, 200) : null,
    method:      'explicit_checkbox',
    withdrawn:   false,
    withdrawnAt: null,
  };
  store.addConsentRecord(record);
  store.addAuditLog({
    action:      'CONSENT_RECORDED',
    patientId,
    purposes,
    performedBy: 'patient',
    detail:      `Consent recorded for purposes: ${purposes.join(', ')}`,
  });
  return record;
}

function withdrawConsent(patientId) {
  const records = store.getConsentRecords(patientId);
  records.forEach(r => {
    store.updateConsentRecord(r.id, { withdrawn: true, withdrawnAt: new Date().toISOString() });
  });
  store.addAuditLog({
    action:      'CONSENT_WITHDRAWN',
    patientId,
    performedBy: 'patient',
    detail:      'Patient withdrew all consent',
  });
}

function hasValidConsent(patientId, purpose) {
  const records = store.getConsentRecords(patientId);
  return records.some(r =>
    !r.withdrawn &&
    r.purposes.includes(purpose)
  );
}

// ── Data subject rights (POPIA Chapter 2, Part A) ─────────────────────────────
async function handleAccessRequest(patientId) {
  // Section 23: Right of access to personal information
  const patient      = store.getPatientById(patientId);
  const appointments = store.getAppointments({}).filter(a => a.patientId === patientId);
  const consents     = store.getConsentRecords(patientId);

  if (!patient) return null;

  // Decrypt SPI fields for the data subject's own access
  const decryptedAppts = appointments.map(a => ({
    ...a,
    notes: decrypt(a.notes),
  }));

  store.addAuditLog({
    action:      'DATA_ACCESS_REQUEST',
    patientId,
    performedBy: 'patient',
    detail:      'Patient exercised Section 23 right of access',
  });

  return {
    personalInformation: {
      fullName:   patient.fullName,
      email:      patient.email,
      mobile:     patient.mobile,
      registeredAt: patient.createdAt,
    },
    appointments: decryptedAppts.map(a => ({
      id:          a.id,
      serviceType: a.serviceType,
      date:        a.startTime,
      mode:        a.sessionMode,
      status:      a.status,
      notes:       a.notes,
    })),
    consentHistory: consents.map(c => ({
      purposes:   c.purposes,
      givenAt:    c.givenAt,
      withdrawn:  c.withdrawn,
      withdrawnAt: c.withdrawnAt,
    })),
    retentionPolicy: 'Personal information is retained for 5 years from last appointment, then anonymised.',
    infoOfficer:     process.env.INFO_OFFICER_NAME  || 'Nontobeko Ngcobo',
    infoOfficerEmail: process.env.INFO_OFFICER_EMAIL || process.env.PRACTICE_EMAIL,
  };
}

async function handleCorrectionRequest(patientId, corrections) {
  // Section 24: Right to request correction
  const allowed = ['fullName', 'email', 'mobile'];
  const safe    = Object.fromEntries(
    Object.entries(corrections).filter(([k]) => allowed.includes(k))
  );
  const updated = store.updatePatient(patientId, safe);
  store.addAuditLog({
    action:      'DATA_CORRECTION_REQUEST',
    patientId,
    performedBy: 'patient',
    fields:      Object.keys(safe),
    detail:      'Patient exercised Section 24 right to correction',
  });
  return updated;
}

async function handleDeletionRequest(patientId) {
  // Section 24(2)(b): Right to request deletion
  // In healthcare, complete deletion is balanced against record-keeping obligations.
  // We anonymise rather than hard-delete to preserve appointment audit trail.
  const appointments = store.getAppointments({}).filter(a => a.patientId === patientId);
  appointments.forEach(a => {
    store.updateAppointment(a.id, anonymiseRecord(a));
  });
  store.anonymisePatient(patientId);
  store.addAuditLog({
    action:      'DATA_DELETION_REQUEST',
    patientId,
    performedBy: 'patient',
    detail:      'Patient data anonymised per Section 24 deletion request. Appointment records retained in anonymised form for audit purposes.',
  });
  return { message: 'Your personal information has been anonymised. Appointment records are retained in anonymous form as required by law.' };
}

// ── Retention enforcement (POPIA Section 14) ──────────────────────────────────
// Call this periodically (e.g. nightly) to anonymise expired records
function enforceRetentionPolicy() {
  const cutoff      = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 5); // 5-year retention
  const appointments = store.getAppointments({});
  let anonymised     = 0;

  appointments.forEach(a => {
    if (a._anonymisedAt) return; // already done
    if (new Date(a.startTime) < cutoff) {
      store.updateAppointment(a.id, anonymiseRecord(a));
      anonymised++;
    }
  });

  if (anonymised > 0) {
    store.addAuditLog({
      action:      'RETENTION_ENFORCEMENT',
      performedBy: 'system',
      detail:      `Anonymised ${anonymised} appointment records older than 5 years`,
    });
    console.log(`[POPIA] Retention policy: anonymised ${anonymised} records`);
  }
  return anonymised;
}

// ── Security event logging (POPIA Section 19 & 22) ───────────────────────────
function logSecurityEvent(type, detail, req) {
  store.addSecurityEvent({
    id:        require('uuid').v4(),
    type,      // e.g. 'FAILED_LOGIN', 'RATE_LIMIT', 'INVALID_TOKEN'
    detail,
    ip:        req?.ip || null,
    userAgent: req?.headers?.['user-agent']?.slice(0, 200) || null,
    timestamp: new Date().toISOString(),
  });
}

// ── Breach notification helper (POPIA Section 22) ────────────────────────────
function reportBreach(description, affectedRecords) {
  const report = {
    id:               require('uuid').v4(),
    reportedAt:       new Date().toISOString(),
    description,
    affectedRecords,
    notifiedInfoReg:  false, // must notify Information Regulator within 72 hours
    notifiedSubjects: false,
    status:           'open',
  };
  store.addSecurityEvent({ type: 'DATA_BREACH', ...report });
  console.error('[POPIA BREACH]', report);
  return report;
}

module.exports = {
  // Encryption
  encrypt,
  decrypt,
  pseudonymise,
  anonymiseRecord,
  // Consent
  CONSENT_PURPOSES,
  recordConsent,
  withdrawConsent,
  hasValidConsent,
  // Data subject rights
  handleAccessRequest,
  handleCorrectionRequest,
  handleDeletionRequest,
  // Retention
  enforceRetentionPolicy,
  // Security
  logSecurityEvent,
  reportBreach,
};
