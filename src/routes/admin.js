const router = require('express').Router();
const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const store  = require('../data/store');
const popia  = require('../popia/compliance');
const { requireAuth }                    = require('../middleware/auth');
const { sendCancellationEmail, sendRescheduleEmail, sendNoShowEmail } = require('../services/notifications');
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
      if (status === 'no-show') {
        await sendNoShowEmail({ ...existing, ...updates });
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

// ── Invoices ───────────────────────────────────────────────────────────────────
router.get('/invoices', async (req, res) => {
  try {
    const invoices = await store.getInvoices(req.query);
    res.json({ invoices, total: invoices.length });
  } catch (err) { res.status(500).json({ error: 'Failed to load invoices.' }); }
});

router.get('/invoices/next-number', async (_req, res) => {
  try { res.json({ invoiceNumber: await store.getNextInvoiceNumber() }); }
  catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

router.get('/invoices/:id', async (req, res) => {
  try {
    const invoice = await store.getInvoiceById(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Not found.' });
    res.json(invoice);
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

router.post('/invoices', async (req, res) => {
  const { v4: uuidv4 } = require('uuid');
  const {
    appointmentId, patientId, patientName, patientDob, patientIdNo, patientContact,
    paymentType, medicalAidName, medicalAidNo, lineItems, invoiceDate,
  } = req.body;

  if (!patientName?.trim())         return res.status(422).json({ error: 'Patient name is required.' });
  if (!Array.isArray(lineItems) || !lineItems.length)
                                     return res.status(422).json({ error: 'At least one line item is required.' });

  try {
    const invoiceNumber = await store.getNextInvoiceNumber();
    const total = lineItems.reduce((sum, li) => sum + (Number(li.total) || 0), 0);

    const invoice = await store.createInvoice({
      id:              uuidv4(),
      invoiceNumber,
      appointmentId:   appointmentId || null,
      patientId:       patientId || null,
      patientName:     patientName.trim(),
      patientDob:      patientDob || null,
      patientIdNo:     patientIdNo || null,
      patientContact:  patientContact || null,
      paymentType:     paymentType || 'cash',
      medicalAidName:  paymentType === 'medical-aid' ? (medicalAidName || null) : null,
      medicalAidNo:    paymentType === 'medical-aid' ? (medicalAidNo   || null) : null,
      lineItems,
      total,
      invoiceDate:     invoiceDate || new Date().toISOString().split('T')[0],
      createdBy:       req.admin.email,
      createdAt:       new Date().toISOString(),
    });

    await store.addAuditLog({
      action: 'INVOICE_CREATED', appointmentId: appointmentId || null,
      patientId: patientId || null, performedBy: req.admin.email,
      detail: `Invoice ${invoiceNumber} created — total R${total.toFixed(2)}`,
    });

    res.status(201).json(invoice);
  } catch (err) {
    console.error('[invoices] create error:', err.message);
    res.status(500).json({ error: 'Failed to create invoice.' });
  }
});

// Printable invoice — opens in browser, patient/admin can print → Save as PDF
router.get('/invoices/:id/print', async (req, res) => {
  try {
    const invoice = await store.getInvoiceById(req.params.id);
    if (!invoice) return res.status(404).send('Invoice not found.');
    res.send(renderInvoiceHtml(invoice));
  } catch (err) { res.status(500).send('Failed to render invoice.'); }
});

function renderInvoiceHtml(inv) {
  const PRACTICE = {
    name:    process.env.PRACTICE_NAME    || 'Nontobeko Ngcobo',
    phone:   process.env.PRACTICE_PHONE   || '0843090111',
    email:   process.env.PRACTICE_EMAIL   || 'nontobekorn@gmail.com',
    address: process.env.PRACTICE_ADDRESS || 'Akeso Milnerton | Belhar 37 Organ Street',
    hpcsa:   process.env.PRACTICE_HPCSA_NO || '0157120',
    practiceNo: process.env.PRACTICE_NUMBER || '1196871',
    bankName: process.env.PRACTICE_BANK_NAME || 'Standard Bank',
    bankAcc:  process.env.PRACTICE_BANK_ACCOUNT || '10117278279',
    bankAccType: process.env.PRACTICE_BANK_ACC_TYPE || 'Current',
    bankBranch:  process.env.PRACTICE_BANK_BRANCH || '003326',
  };
  const fmtDate = (d) => new Date(d).toLocaleDateString('en-ZA', { day: '2-digit', month: 'long', year: 'numeric' });
  const rows = (inv.lineItems || []).map(li => `
    <tr>
      <td>${esc(li.rxDate || inv.invoiceDate)}</td>
      <td>${esc(PRACTICE.name)}<br><span style="color:#888;font-size:11px">${esc(PRACTICE.hpcsa)}</span></td>
      <td>${esc(li.icd10 || '')}</td>
      <td>${esc(li.tariffCode || '')}</td>
      <td>R ${Number(li.fee || 0).toFixed(2)}</td>
      <td>R ${Number(li.total || 0).toFixed(2)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Invoice ${esc(inv.invoiceNumber)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:'Helvetica Neue',Arial,sans-serif}
body{background:#fff;color:#111;padding:40px;max-width:880px;margin:0 auto}
.top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:30px}
.top h1{font-size:32px;font-weight:800;letter-spacing:1px}
.top .date{font-size:13px;color:#555;margin-top:6px}
.contact{text-align:right;font-size:13px;color:#333;line-height:1.6}
.contact strong{display:block;margin-bottom:4px}
.practice-meta{text-align:right;font-size:12px;color:#444;margin-top:10px;line-height:1.6}
.cols{display:flex;justify-content:space-between;margin:28px 0;gap:30px}
.col h3{font-size:13px;font-weight:700;margin-bottom:8px}
.col p{font-size:13px;color:#222;line-height:1.7}
table{width:100%;border-collapse:collapse;margin-top:20px}
th{background:#f3f3f3;border:1px solid #ddd;padding:10px;font-size:12px;text-align:left}
td{border:1px solid #ddd;padding:10px;font-size:13px}
.total-box{display:flex;justify-content:flex-end;margin-top:20px}
.total-box div{background:#f3f3f3;border:1px solid #ccc;padding:12px 24px;font-weight:700;font-size:15px}
.bank{margin-top:40px;font-size:12px;color:#333;line-height:1.8}
.bank strong{font-weight:700}
.practice-no{margin-top:30px;font-size:13px;font-weight:700}
@media print{.no-print{display:none}}
.no-print{text-align:center;margin-top:30px}
.no-print button{padding:10px 24px;border:none;border-radius:6px;background:#1D9E75;color:#fff;font-size:14px;cursor:pointer}
</style></head><body>
<div class="top">
  <div>
    <h1>INVOICE</h1>
    <div class="date">Date: ${fmtDate(inv.invoiceDate)}</div>
    <div class="date">Invoice #: ${esc(inv.invoiceNumber)}</div>
  </div>
  <div>
    <div class="contact">
      <strong>Contact details</strong>
      Tel: ${esc(PRACTICE.phone)}<br>
      Email: ${esc(PRACTICE.email)}<br>
      ${esc(PRACTICE.address)}
    </div>
    <div class="practice-meta">
      Practice number: ${esc(PRACTICE.practiceNo)}<br>
      HPCSA: ${esc(PRACTICE.hpcsa)}
    </div>
  </div>
</div>

<div class="cols">
  <div class="col">
    <h3>Bill to:</h3>
    ${inv.paymentType === 'medical-aid' ? `
      <p>Medical aid: ${esc(inv.medicalAidName || '—')}</p>
      <p>Medical aid number: ${esc(inv.medicalAidNo || '—')}</p>
    ` : `<p>Payment method: Cash / EFT</p>`}
  </div>
  <div class="col">
    <h3>Patient information</h3>
    <p>Patient name: ${esc(inv.patientName)}</p>
    ${inv.patientDob ? `<p>Date of birth: ${esc(inv.patientDob)}</p>` : ''}
    ${inv.patientIdNo ? `<p>ID number: ${esc(inv.patientIdNo)}</p>` : ''}
    ${inv.patientContact ? `<p>Contact details: ${esc(inv.patientContact)}</p>` : ''}
  </div>
</div>

<table>
  <thead><tr><th>Rx Date</th><th>Practitioner</th><th>ICD 10 Code</th><th>Tariff code</th><th>Consultation fee</th><th>Total</th></tr></thead>
  <tbody>${rows}</tbody>
</table>

<div class="total-box"><div>Total: R ${Number(inv.total || 0).toFixed(2)}</div></div>

<div class="practice-no">PRACTICE NUMBER ${esc(PRACTICE.practiceNo)}</div>

<div class="bank">
  <strong>Bank:</strong> ${esc(PRACTICE.bankName)}<br>
  <strong>Account Number:</strong> ${esc(PRACTICE.bankAcc)}<br>
  <strong>Account Type:</strong> ${esc(PRACTICE.bankAccType)}<br>
  <strong>Branch Code:</strong> ${esc(PRACTICE.bankBranch)}<br>
  Reference: ${esc(inv.patientName)}
</div>

<div class="no-print"><button onclick="window.print()">Print / Save as PDF</button></div>
</body></html>`;
}

function esc(str) { return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

module.exports = router;
