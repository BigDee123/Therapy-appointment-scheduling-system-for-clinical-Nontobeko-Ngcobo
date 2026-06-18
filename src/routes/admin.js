const router = require('express').Router();
const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const store  = require('../data/store');
const popia  = require('../popia/compliance');
const { requireAuth }                    = require('../middleware/auth');
const { sendCancellationEmail, sendRescheduleEmail } = require('../services/notifications');
const { createCalendarEvent, cancelCalendarEvent }   = require('../services/calendar');

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  const adminEmail = process.env.ADMIN_EMAIL || '';
  const adminPass  = process.env.ADMIN_PASSWORD || '';
  if (email.toLowerCase() !== adminEmail.toLowerCase()) {
    popia.logSecurityEvent('FAILED_LOGIN', `Unknown email: ${email}`, req);
    return res.status(401).json({ error: 'Invalid credentials.' });
  }
  const valid = adminPass.startsWith('$2')
    ? await bcrypt.compare(password, adminPass) : password === adminPass;
  if (!valid) {
    popia.logSecurityEvent('FAILED_LOGIN', `Wrong password for: ${email}`, req);
    return res.status(401).json({ error: 'Invalid credentials.' });
  }
  await store.addAuditLog({ action: 'ADMIN_LOGIN', performedBy: email, ip: req.ip });
  const token = jwt.sign({ email: adminEmail, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '8h' });
  res.json({ token });
});

router.use(requireAuth);

router.get('/appointments', async (req, res) => {
  try {
    const list      = await store.getAppointments(req.query);
    const decrypted = list.map(a => ({ ...a, notes: popia.decrypt(a.notes) }));
    res.json({ appointments: decrypted, total: decrypted.length });
  } catch (err) { res.status(500).json({ error: 'Failed to load appointments.' }); }
});

router.get('/appointments/:id', async (req, res) => {
  try {
    const appt = await store.getAppointmentById(req.params.id);
    if (!appt) return res.status(404).json({ error: 'Not found.' });
    res.json({ ...appt, notes: popia.decrypt(appt.notes) });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

router.patch('/appointments/:id', async (req, res) => {
  const { status, startTime, endTime, notes } = req.body;
  try {
    const existing = await store.getAppointmentById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found.' });
    const updates = {};
    if (status)              updates.status    = status;
    if (notes !== undefined) updates.notes     = popia.encrypt(notes);
    if (startTime) {
      const avail  = await store.getAvailability();
      const newEnd = endTime || new Date(new Date(startTime).getTime() + (avail.slotDuration || 60) * 60_000).toISOString();
      if (await store.isSlotTaken(startTime, newEnd, req.params.id))
        return res.status(409).json({ error: 'That slot is already taken.' });
      updates.startTime = startTime;
      updates.endTime   = newEnd;
    }
    const updated = await store.updateAppointment(req.params.id, updates);
    await store.addAuditLog({
      action: 'APPOINTMENT_UPDATED', appointmentId: req.params.id,
      performedBy: req.admin.email, detail: Object.keys(updates).join(', '),
    });
    setImmediate(async () => {
      if (status === 'cancelled') {
        await sendCancellationEmail({ ...existing, ...updates });
        if (existing.googleEventId) await cancelCalendarEvent(existing.googleEventId);
      }
      if (startTime && startTime !== existing.startTime) {
        const merged = { ...existing, ...updates, notes: notes || popia.decrypt(existing.notes) };
        await sendRescheduleEmail(merged);
        if (existing.googleEventId) await cancelCalendarEvent(existing.googleEventId);
        const newGid = await createCalendarEvent(merged);
        if (newGid) await store.updateAppointment(req.params.id, { googleEventId: newGid });
      }
    });
    res.json({ ...updated, notes: popia.decrypt(updated.notes) });
  } catch (err) { res.status(500).json({ error: 'Update failed.' }); }
});

router.delete('/appointments/:id', async (req, res) => {
  try {
    const existing = await store.getAppointmentById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found.' });
    await store.deleteAppointment(req.params.id);
    await store.addAuditLog({ action: 'APPOINTMENT_DELETED', appointmentId: req.params.id, performedBy: req.admin.email });
    if (existing.googleEventId) cancelCalendarEvent(existing.googleEventId).catch(console.error);
    res.json({ message: 'Appointment deleted.' });
  } catch (err) { res.status(500).json({ error: 'Delete failed.' }); }
});

router.get('/export', async (req, res) => {
  try {
    const list = await store.getAppointments(req.query);
    await store.addAuditLog({ action: 'DATA_EXPORT', performedBy: req.admin.email, count: list.length });
    const headers = ['ID','Patient','Email','Mobile','Service','Date','Time','Mode','Status','Notes','Created'];
    const rows = list.map(a => [
      a.id?.slice(0,8), `"${(a.patientName||'').replace(/"/g,'""')}"`,
      a.patientEmail||'', a.patientMobile||'',
      `"${(a.serviceType||'').replace(/"/g,'""')}"`,
      a.startTime?.split('T')[0], a.startTime?.split('T')[1]?.slice(0,5),
      a.sessionMode||'', a.status||'',
      `"${(popia.decrypt(a.notes)||'').replace(/"/g,'""')}"`,
      a.createdAt?.split('T')[0],
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    res.setHeader('Content-Type','text/csv');
    res.setHeader('Content-Disposition','attachment; filename="appointments.csv"');
    res.send(csv);
  } catch (err) { res.status(500).json({ error: 'Export failed.' }); }
});

router.get('/patients', async (req, res) => {
  try {
    const patients = await store.getPatients(req.query.search || '');
    res.json({ patients, total: patients.length });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

router.get('/patients/:id', async (req, res) => {
  try {
    const patient = await store.getPatientById(req.params.id);
    if (!patient) return res.status(404).json({ error: 'Not found.' });
    const history = (await store.getAppointments({}))
      .filter(a => a.patientId === patient.id)
      .map(a => ({ ...a, notes: popia.decrypt(a.notes) }));
    await store.addAuditLog({ action: 'PATIENT_RECORD_VIEWED', patientId: patient.id, performedBy: req.admin.email });
    res.json({ ...patient, appointmentHistory: history });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

router.get('/availability', async (_req, res) => {
  try { res.json(await store.getAvailability()); }
  catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

router.put('/availability', async (req, res) => {
  try {
    const { workingHours, slotDuration } = req.body;
    const updated = await store.updateAvailability({ workingHours, slotDuration });
    await store.addAuditLog({ action: 'AVAILABILITY_UPDATED', performedBy: req.admin.email });
    res.json(updated);
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

router.post('/availability/block', async (req, res) => {
  const { date, reason } = req.body;
  if (!date) return res.status(400).json({ error: 'Date required.' });
  try { res.json(await store.addBlockedDate(date, reason || '')); }
  catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

router.delete('/availability/block/:date', async (req, res) => {
  try { res.json(await store.removeBlockedDate(req.params.date)); }
  catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

router.get('/audit-log', async (req, res) => {
  try {
    const logs = await store.getAuditLogs(req.query);
    res.json({ logs, total: logs.length });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

router.get('/security-events', async (_req, res) => {
  try { res.json({ events: await store.getSecurityEvents() }); }
  catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

router.post('/popia/enforce-retention', async (req, res) => {
  try {
    const count = await popia.enforceRetentionPolicy();
    await store.addAuditLog({ action: 'RETENTION_MANUAL_TRIGGER', performedBy: req.admin.email, anonymised: count });
    res.json({ message: `Retention policy applied. ${count} records anonymised.` });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

router.get('/popia/consents', async (_req, res) => {
  try { res.json({ consents: await store.getAllConsentRecords() }); }
  catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

module.exports = router;
