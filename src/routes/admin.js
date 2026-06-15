/**
 * Admin API — JWT-protected, POPIA audit trail, calendar sync on reschedule
 */
const router = require('express').Router();
const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const store  = require('../data/store');
const popia  = require('../popia/compliance');
const { requireAuth }                          = require('../middleware/auth');
const { sendCancellationEmail,
        sendRescheduleEmail }                  = require('../services/notifications');
const { createCalendarEvent,
        cancelCalendarEvent }                  = require('../services/calendar');

// ── POST /api/admin/login ─────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required.' });

  const adminEmail = process.env.ADMIN_EMAIL || '';
  const adminPass  = process.env.ADMIN_PASSWORD || '';

  if (email.toLowerCase() !== adminEmail.toLowerCase()) {
    popia.logSecurityEvent('FAILED_LOGIN', `Unknown email: ${email}`, req);
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  const valid = adminPass.startsWith('$2')
    ? await bcrypt.compare(password, adminPass)
    : password === adminPass;

  if (!valid) {
    popia.logSecurityEvent('FAILED_LOGIN', `Wrong password for: ${email}`, req);
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  store.addAuditLog({ action: 'ADMIN_LOGIN', performedBy: email, ip: req.ip });
  const token = jwt.sign(
    { email: adminEmail, role: 'admin' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
  res.json({ token });
});

router.use(requireAuth);

// ── GET /api/admin/appointments ───────────────────────────────────────────────
router.get('/appointments', (req, res) => {
  const list      = store.getAppointments(req.query);
  const decrypted = list.map(a => ({ ...a, notes: popia.decrypt(a.notes) }));
  res.json({ appointments: decrypted, total: decrypted.length });
});

// ── GET /api/admin/appointments/:id ──────────────────────────────────────────
router.get('/appointments/:id', (req, res) => {
  const appt = store.getAppointmentById(req.params.id);
  if (!appt) return res.status(404).json({ error: 'Not found.' });
  res.json({ ...appt, notes: popia.decrypt(appt.notes) });
});

// ── PATCH /api/admin/appointments/:id ────────────────────────────────────────
// Handles: status change, reschedule, notes update
router.patch('/appointments/:id', async (req, res) => {
  const { status, startTime, endTime, notes } = req.body;
  const existing = store.getAppointmentById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found.' });

  const updates = {};
  if (status)              updates.status    = status;
  if (startTime)           updates.startTime = startTime;
  if (endTime)             updates.endTime   = endTime;
  if (notes !== undefined) updates.notes     = popia.encrypt(notes);

  // Reschedule: check new slot isn't taken
  if (startTime && startTime !== existing.startTime) {
    const newEnd = endTime || new Date(
      new Date(startTime).getTime() + (store.getAvailability().slotDuration || 60) * 60_000
    ).toISOString();
    if (store.isSlotTaken(startTime, newEnd, req.params.id))
      return res.status(409).json({ error: 'That slot is already taken.' });
    if (!endTime) updates.endTime = newEnd;
  }

  const updated = store.updateAppointment(req.params.id, updates);

  store.addAuditLog({
    action: 'APPOINTMENT_UPDATED', appointmentId: req.params.id,
    performedBy: req.admin.email, fields: Object.keys(updates),
    detail: Object.entries(updates).filter(([k]) => k !== 'notes').map(([k,v]) => `${k}=${v}`).join(', '),
  });

  // Non-blocking side effects
  setImmediate(async () => {
    // Cancellation
    if (status === 'cancelled') {
      await sendCancellationEmail({ ...existing, ...updates, notes: notes || popia.decrypt(existing.notes) });
      if (existing.googleEventId) await cancelCalendarEvent(existing.googleEventId);
    }
    // Reschedule
    if (startTime && startTime !== existing.startTime) {
      const merged = { ...existing, ...updates, notes: notes || popia.decrypt(existing.notes) };
      await sendRescheduleEmail(merged);
      // Update calendar event: cancel old, create new
      if (existing.googleEventId) await cancelCalendarEvent(existing.googleEventId);
      const newGoogleId = await createCalendarEvent(merged);
      if (newGoogleId) store.updateAppointment(req.params.id, { googleEventId: newGoogleId });
    }
  });

  res.json({ ...updated, notes: popia.decrypt(updated.notes) });
});

// ── DELETE /api/admin/appointments/:id ───────────────────────────────────────
router.delete('/appointments/:id', async (req, res) => {
  const existing = store.getAppointmentById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found.' });
  store.deleteAppointment(req.params.id);
  store.addAuditLog({ action: 'APPOINTMENT_DELETED', appointmentId: req.params.id, performedBy: req.admin.email });
  if (existing.googleEventId) cancelCalendarEvent(existing.googleEventId).catch(console.error);
  res.json({ message: 'Appointment deleted.' });
});

// ── GET /api/admin/export ─────────────────────────────────────────────────────
router.get('/export', (req, res) => {
  const list = store.getAppointments(req.query);
  store.addAuditLog({ action: 'DATA_EXPORT', performedBy: req.admin.email, count: list.length });
  const headers = ['ID','Patient','Email','Mobile','Service','Date','Time','Mode','Status','Notes','Created'];
  const rows = list.map(a => [
    a.id?.slice(0,8),
    `"${(a.patientName||'').replace(/"/g,'""')}"`,
    a.patientEmail || '',
    a.patientMobile || '',
    `"${(a.serviceType||'').replace(/"/g,'""')}"`,
    a.startTime?.split('T')[0],
    a.startTime?.split('T')[1]?.slice(0,5),
    a.sessionMode || '',
    a.status || '',
    `"${(popia.decrypt(a.notes)||'').replace(/"/g,'""')}"`,
    a.createdAt?.split('T')[0],
  ]);
  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="appointments.csv"');
  res.send(csv);
});

// ── Patients ──────────────────────────────────────────────────────────────────
router.get('/patients', (req, res) => {
  const patients = store.getPatients(req.query.search || '');
  res.json({ patients, total: patients.length });
});

router.get('/patients/:id', (req, res) => {
  const patient = store.getPatientById(req.params.id);
  if (!patient) return res.status(404).json({ error: 'Not found.' });
  const history = store.getAppointments({})
    .filter(a => a.patientId === patient.id)
    .map(a => ({ ...a, notes: popia.decrypt(a.notes) }));
  store.addAuditLog({ action: 'PATIENT_RECORD_VIEWED', patientId: patient.id, performedBy: req.admin.email });
  res.json({ ...patient, appointmentHistory: history });
});

// ── Availability ──────────────────────────────────────────────────────────────
router.get('/availability', (_req, res) => res.json(store.getAvailability()));

router.put('/availability', (req, res) => {
  const { workingHours, slotDuration } = req.body;
  const updated = store.updateAvailability({ workingHours, slotDuration });
  store.addAuditLog({ action: 'AVAILABILITY_UPDATED', performedBy: req.admin.email });
  res.json(updated);
});

router.post('/availability/block', (req, res) => {
  const { date, reason } = req.body;
  if (!date) return res.status(400).json({ error: 'Date required.' });
  res.json(store.addBlockedDate(date, reason || ''));
});

router.delete('/availability/block/:date', (req, res) => {
  res.json(store.removeBlockedDate(req.params.date));
});

// ── Audit log ─────────────────────────────────────────────────────────────────
router.get('/audit-log', (req, res) => {
  const logs = store.getAuditLogs(req.query);
  res.json({ logs, total: logs.length });
});

// ── Security events ───────────────────────────────────────────────────────────
router.get('/security-events', (_req, res) => {
  res.json({ events: store.getSecurityEvents() });
});

// ── POPIA: retention enforcement ──────────────────────────────────────────────
router.post('/popia/enforce-retention', (req, res) => {
  const count = popia.enforceRetentionPolicy();
  store.addAuditLog({ action: 'RETENTION_MANUAL_TRIGGER', performedBy: req.admin.email, anonymised: count });
  res.json({ message: `Retention policy applied. ${count} records anonymised.` });
});

// ── POPIA: consent records ────────────────────────────────────────────────────
router.get('/popia/consents', (_req, res) => {
  res.json({ consents: store.getAllConsentRecords() });
});

module.exports = router;
