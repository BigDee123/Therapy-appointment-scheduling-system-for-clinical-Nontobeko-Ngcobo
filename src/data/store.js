/**
 * Persistent data store — backed by Supabase (PostgreSQL)
 * Data survives server restarts and redeploys.
 *
 * Tables required in Supabase (run schema.sql once in Supabase SQL editor):
 *   patients, appointments, consent_records, reminders, audit_logs, security_events, availability
 */
const db = require('./db');

// ── helper: throw readable errors ────────────────────────────────────────────
async function q(promise, label) {
  const { data, error } = await promise;
  if (error) {
    console.error(`[store] ${label} error:`, error.message);
    throw new Error(error.message);
  }
  return data;
}

const store = {

  // ══ APPOINTMENTS ════════════════════════════════════════════════════════════

  async getAppointments(filters = {}) {
    let query = db.from('appointments').select('*');
    if (filters.date)   query = query.like('start_time', `${filters.date}%`);
    if (filters.status) query = query.eq('status', filters.status);
    if (filters.search) {
      query = query.or(
        `patient_name.ilike.%${filters.search}%,patient_email.ilike.%${filters.search}%`
      );
    }
    const data = await q(query.order('start_time', { ascending: true }), 'getAppointments');
    return (data || []).map(camelCase);
  },

  async getAppointmentById(id) {
    const data = await q(
      db.from('appointments').select('*').eq('id', id).maybeSingle(),
      'getAppointmentById'
    );
    return data ? camelCase(data) : null;
  },

  async createAppointment(appt) {
    const row = snakeCase(appt);
    const data = await q(
      db.from('appointments').insert(row).select().single(),
      'createAppointment'
    );
    return camelCase(data);
  },

  async updateAppointment(id, updates) {
    const row = { ...snakeCase(updates), updated_at: new Date().toISOString() };
    const data = await q(
      db.from('appointments').update(row).eq('id', id).select().single(),
      'updateAppointment'
    );
    return data ? camelCase(data) : null;
  },

  async deleteAppointment(id) {
    // Delete dependent reminders first to satisfy the foreign key constraint
    await q(db.from('reminders').delete().eq('appointment_id', id), 'deleteAppointment-reminders');
    await q(db.from('appointments').delete().eq('id', id), 'deleteAppointment');
    return true;
  },

  async isSlotTaken(startTime, endTime, excludeId = null) {
    let query = db.from('appointments')
      .select('id')
      .not('status', 'in', '("cancelled","no-show")')
      .is('anonymised_at', null)
      .lt('start_time', endTime)
      .gt('end_time', startTime);
    if (excludeId) query = query.neq('id', excludeId);
    const data = await q(query, 'isSlotTaken');
    return (data || []).length > 0;
  },

  // ══ PATIENTS ════════════════════════════════════════════════════════════════

  async getPatients(search = '') {
    let query = db.from('patients').select('*').is('anonymised_at', null);
    if (search) {
      query = query.or(
        `full_name.ilike.%${search}%,email.ilike.%${search}%,mobile.ilike.%${search}%`
      );
    }
    const data = await q(query.order('created_at', { ascending: false }), 'getPatients');
    return (data || []).map(camelCase);
  },

  async getPatientById(id) {
    const data = await q(
      db.from('patients').select('*').eq('id', id).maybeSingle(),
      'getPatientById'
    );
    return data ? camelCase(data) : null;
  },

  async upsertPatient(patient) {
    const row = snakeCase(patient);
    delete row.id; // never overwrite the primary key of an existing row
    // Try to find existing by email
    const existing = await q(
      db.from('patients').select('*').eq('email', patient.email.toLowerCase()).maybeSingle(),
      'upsertPatient-find'
    );
    if (existing) {
      const updated = await q(
        db.from('patients').update({ ...row, updated_at: new Date().toISOString() })
          .eq('id', existing.id).select().single(),
        'upsertPatient-update'
      );
      return camelCase(updated);
    }
    const created = await q(
      db.from('patients').insert({ ...row, id: patient.id, created_at: new Date().toISOString() })
        .select().single(),
      'upsertPatient-insert'
    );
    return camelCase(created);
  },

  async updatePatient(id, updates) {
    const data = await q(
      db.from('patients').update({ ...snakeCase(updates), updated_at: new Date().toISOString() })
        .eq('id', id).select().single(),
      'updatePatient'
    );
    return data ? camelCase(data) : null;
  },

  async anonymisePatient(id) {
    await q(
      db.from('patients').update({
        full_name: '[anonymised]', email: '[anonymised]', mobile: '[anonymised]',
        anonymised_at: new Date().toISOString(),
      }).eq('id', id),
      'anonymisePatient'
    );
  },

  // ══ CONSENT RECORDS ══════════════════════════════════════════════════════════

  async getConsentRecords(patientId) {
    const data = await q(
      db.from('consent_records').select('*').eq('patient_id', patientId),
      'getConsentRecords'
    );
    return (data || []).map(camelCase);
  },

  async getAllConsentRecords() {
    const data = await q(
      db.from('consent_records').select('*').order('given_at', { ascending: false }),
      'getAllConsentRecords'
    );
    return (data || []).map(camelCase);
  },

  async addConsentRecord(record) {
    const data = await q(
      db.from('consent_records').insert(snakeCase(record)).select().single(),
      'addConsentRecord'
    );
    return camelCase(data);
  },

  async updateConsentRecord(id, updates) {
    await q(
      db.from('consent_records').update(snakeCase(updates)).eq('id', id),
      'updateConsentRecord'
    );
  },

  // ══ AVAILABILITY ════════════════════════════════════════════════════════════

  async getAvailability() {
    const data = await q(
      db.from('availability').select('*').eq('id', 1).maybeSingle(),
      'getAvailability'
    );
    if (!data) {
      // Return default availability if not yet configured
      return {
        workingHours: {
          1: { start: '08:00', end: '17:00' },
          2: { start: '08:00', end: '17:00' },
          3: { start: '08:00', end: '17:00' },
          4: { start: '08:00', end: '17:00' },
          5: { start: '08:00', end: '13:00' },
        },
        blockedDates: [],
        slotDuration: 60,
      };
    }
    return {
      workingHours: data.working_hours,
      blockedDates:  data.blocked_dates || [],
      slotDuration:  data.slot_duration || 60,
    };
  },

  async updateAvailability(updates) {
    const row = {
      working_hours: updates.workingHours,
      slot_duration: updates.slotDuration,
    };
    await q(
      db.from('availability').upsert({ id: 1, ...row }),
      'updateAvailability'
    );
    return this.getAvailability();
  },

  async addBlockedDate(date, reason = '') {
    const current = await this.getAvailability();
    const blocked  = current.blockedDates.filter(b => b.date !== date);
    blocked.push({ date, reason });
    await q(
      db.from('availability').upsert({ id: 1, blocked_dates: blocked }),
      'addBlockedDate'
    );
    return this.getAvailability();
  },

  async removeBlockedDate(date) {
    const current = await this.getAvailability();
    const blocked  = current.blockedDates.filter(b => b.date !== date);
    await q(
      db.from('availability').upsert({ id: 1, blocked_dates: blocked }),
      'removeBlockedDate'
    );
    return this.getAvailability();
  },

  // ══ REMINDERS ═══════════════════════════════════════════════════════════════

  async getReminders() {
    const data = await q(
      db.from('reminders').select('*').eq('status', 'pending'),
      'getReminders'
    );
    return (data || []).map(camelCase);
  },

  async addReminder(reminder) {
    const data = await q(
      db.from('reminders').insert(snakeCase(reminder)).select().single(),
      'addReminder'
    );
    return camelCase(data);
  },

  async updateReminder(id, updates) {
    const data = await q(
      db.from('reminders').update(snakeCase(updates)).eq('id', id).select().single(),
      'updateReminder'
    );
    return data ? camelCase(data) : null;
  },

  // ══ AUDIT LOG ════════════════════════════════════════════════════════════════

  async addAuditLog(entry) {
    await q(
      db.from('audit_logs').insert({
        ...snakeCase(entry),
        created_at: new Date().toISOString(),
      }),
      'addAuditLog'
    ).catch(err => console.error('[store] audit log failed:', err.message));
  },

  async getAuditLogs(filters = {}) {
    let query = db.from('audit_logs').select('*');
    if (filters.patientId) query = query.eq('patient_id', filters.patientId);
    if (filters.action)    query = query.eq('action', filters.action);
    const data = await q(query.order('created_at', { ascending: false }).limit(200), 'getAuditLogs');
    return (data || []).map(camelCase);
  },

  // ══ SECURITY EVENTS ══════════════════════════════════════════════════════════

  async addSecurityEvent(event) {
    await q(
      db.from('security_events').insert(snakeCase(event)),
      'addSecurityEvent'
    ).catch(err => console.error('[store] security event failed:', err.message));
  },

  async getSecurityEvents() {
    const data = await q(
      db.from('security_events').select('*').order('timestamp', { ascending: false }).limit(100),
      'getSecurityEvents'
    );
    return (data || []).map(camelCase);
  },

  // ══ INVOICES ════════════════════════════════════════════════════════════════

  async getInvoices(filters = {}) {
    let query = db.from('invoices').select('*');
    if (filters.patientId) query = query.eq('patient_id', filters.patientId);
    if (filters.search) {
      query = query.or(`patient_name.ilike.%${filters.search}%,invoice_number.ilike.%${filters.search}%`);
    }
    const data = await q(query.order('created_at', { ascending: false }), 'getInvoices');
    return (data || []).map(camelCase);
  },

  async getInvoiceById(id) {
    const data = await q(
      db.from('invoices').select('*').eq('id', id).maybeSingle(),
      'getInvoiceById'
    );
    return data ? camelCase(data) : null;
  },

  async createInvoice(invoice) {
    const data = await q(
      db.from('invoices').insert(snakeCase(invoice)).select().single(),
      'createInvoice'
    );
    return camelCase(data);
  },

  async getNextInvoiceNumber() {
    const data = await q(
      db.from('invoices').select('invoice_number').order('created_at', { ascending: false }).limit(1),
      'getNextInvoiceNumber'
    );
    const last = data?.[0]?.invoice_number;
    const lastNum = last ? parseInt(last.replace(/\D/g, ''), 10) || 0 : 0;
    return `INV-${String(lastNum + 1).padStart(4, '0')}`;
  },
};

// ── Column name converters ────────────────────────────────────────────────────
function snakeCase(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const snake = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    result[snake] = value;
  }
  return result;
}

function camelCase(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    result[camel] = value;
  }
  return result;
}

module.exports = store;
