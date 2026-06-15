/**
 * POPIA-compliant JSON datastore
 * Supports: consent records, audit logs, security events,
 * anonymisation, data subject requests, retention management.
 */
const fs   = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'db.json');

const DEFAULTS = {
  appointments:   [],
  patients:       [],
  consentRecords: [],
  securityEvents: [],
  auditLogs:      [],
  availability: {
    workingHours: {
      1: { start: '08:00', end: '17:00' },
      2: { start: '08:00', end: '17:00' },
      3: { start: '08:00', end: '17:00' },
      4: { start: '08:00', end: '17:00' },
      5: { start: '08:00', end: '13:00' },
    },
    blockedDates:  [],
    slotDuration:  60,
  },
  reminders: [],
};

function load() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(DEFAULTS, null, 2));
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return JSON.parse(JSON.stringify(DEFAULTS)); }
}
function save(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }

const store = {
  // ── Appointments ────────────────────────────────────────
  getAppointments(filters = {}) {
    const db = load();
    let list = db.appointments;
    if (filters.date)   list = list.filter(a => a.startTime?.startsWith(filters.date));
    if (filters.status) list = list.filter(a => a.status === filters.status);
    if (filters.search) {
      const q = filters.search.toLowerCase();
      list = list.filter(a =>
        a.patientName?.toLowerCase().includes(q) ||
        a.patientEmail?.toLowerCase().includes(q)
      );
    }
    return list.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  },
  getAppointmentById(id) { return load().appointments.find(a => a.id === id) || null; },
  createAppointment(appt) {
    const db = load(); db.appointments.push(appt); save(db); return appt;
  },
  updateAppointment(id, updates) {
    const db  = load();
    const idx = db.appointments.findIndex(a => a.id === id);
    if (idx === -1) return null;
    db.appointments[idx] = { ...db.appointments[idx], ...updates, updatedAt: new Date().toISOString() };
    save(db); return db.appointments[idx];
  },
  deleteAppointment(id) {
    const db  = load();
    const idx = db.appointments.findIndex(a => a.id === id);
    if (idx === -1) return false;
    db.appointments.splice(idx, 1); save(db); return true;
  },
  isSlotTaken(startTime, endTime, excludeId = null) {
    const start = new Date(startTime), end = new Date(endTime);
    return load().appointments.some(a => {
      if (a.id === excludeId) return false;
      if (['cancelled','no-show'].includes(a.status)) return false;
      if (a._anonymisedAt) return false;
      return start < new Date(a.endTime) && end > new Date(a.startTime);
    });
  },

  // ── Patients ─────────────────────────────────────────────
  getPatients(search = '') {
    const db = load();
    if (!search) return db.patients.filter(p => !p._anonymisedAt);
    const q  = search.toLowerCase();
    return db.patients.filter(p =>
      !p._anonymisedAt && (
        p.fullName?.toLowerCase().includes(q) ||
        p.email?.toLowerCase().includes(q) ||
        p.mobile?.includes(q)
      )
    );
  },
  getPatientById(id) { return load().patients.find(p => p.id === id) || null; },
  upsertPatient(data) {
    const db = load();
    let p    = db.patients.find(p => p.email?.toLowerCase() === data.email?.toLowerCase());
    if (p) { Object.assign(p, { ...data, updatedAt: new Date().toISOString() }); }
    else   { p = { ...data, createdAt: new Date().toISOString() }; db.patients.push(p); }
    save(db); return p;
  },
  updatePatient(id, updates) {
    const db  = load();
    const idx = db.patients.findIndex(p => p.id === id);
    if (idx === -1) return null;
    db.patients[idx] = { ...db.patients[idx], ...updates, updatedAt: new Date().toISOString() };
    save(db); return db.patients[idx];
  },
  anonymisePatient(id) {
    const db  = load();
    const idx = db.patients.findIndex(p => p.id === id);
    if (idx === -1) return;
    db.patients[idx] = {
      id,
      fullName:      '[anonymised]',
      email:         '[anonymised]',
      mobile:        '[anonymised]',
      _anonymisedAt: new Date().toISOString(),
      _popia:        'anonymised-per-retention-policy',
    };
    save(db);
  },

  // ── Consent records ──────────────────────────────────────
  getConsentRecords(patientId) {
    return load().consentRecords.filter(r => r.patientId === patientId);
  },
  getAllConsentRecords() { return load().consentRecords; },
  addConsentRecord(record) {
    const db = load(); db.consentRecords.push(record); save(db); return record;
  },
  updateConsentRecord(id, updates) {
    const db  = load();
    const idx = db.consentRecords.findIndex(r => r.id === id);
    if (idx !== -1) { db.consentRecords[idx] = { ...db.consentRecords[idx], ...updates }; save(db); }
  },

  // ── Availability ─────────────────────────────────────────
  getAvailability() { return load().availability; },
  updateAvailability(updates) {
    const db = load();
    db.availability = { ...db.availability, ...updates };
    save(db); return db.availability;
  },
  addBlockedDate(date, reason = '') {
    const db = load();
    if (!db.availability.blockedDates.find(b => b.date === date)) {
      db.availability.blockedDates.push({ date, reason });
      save(db);
    }
    return db.availability;
  },
  removeBlockedDate(date) {
    const db = load();
    db.availability.blockedDates = db.availability.blockedDates.filter(b => b.date !== date);
    save(db); return db.availability;
  },

  // ── Reminders ─────────────────────────────────────────────
  getReminders() { return load().reminders; },
  addReminder(r) { const db = load(); db.reminders.push(r); save(db); return r; },
  updateReminder(id, updates) {
    const db  = load();
    const idx = db.reminders.findIndex(r => r.id === id);
    if (idx !== -1) { db.reminders[idx] = { ...db.reminders[idx], ...updates }; save(db); }
    return db.reminders[idx] || null;
  },

  // ── Audit log ─────────────────────────────────────────────
  addAuditLog(entry) {
    const db = load();
    db.auditLogs.push({ ...entry, createdAt: new Date().toISOString() });
    save(db);
  },
  getAuditLogs(filters = {}) {
    let logs = load().auditLogs;
    if (filters.patientId) logs = logs.filter(l => l.patientId === filters.patientId);
    if (filters.action)    logs = logs.filter(l => l.action === filters.action);
    return logs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },

  // ── Security events ───────────────────────────────────────
  addSecurityEvent(event) {
    const db = load(); db.securityEvents.push(event); save(db);
  },
  getSecurityEvents() {
    return load().securityEvents.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  },
};

module.exports = store;
