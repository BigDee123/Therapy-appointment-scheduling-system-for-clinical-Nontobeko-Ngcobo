require('dotenv').config();
const nodemailer = require('nodemailer');

const PRACTICE = {
  name:    process.env.PRACTICE_NAME    || 'Nontobeko Ngcobo – Clinical Psychologist',
  phone:   process.env.PRACTICE_PHONE   || '0843090111',
  email:   process.env.PRACTICE_EMAIL   || 'nontobekorn@gmail.com',
  address: process.env.PRACTICE_ADDRESS || 'Simla Medical Centre, Belhar, Cape Town',
};

function createTransport() {
  const port   = Number(process.env.SMTP_PORT || 587);
  const secure = process.env.SMTP_SECURE === 'true' || port === 465;
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    // 30 second timeout
    connectionTimeout: 30_000,
    greetingTimeout:   15_000,
    socketTimeout:     30_000,
  });
}

function fmtFull(iso) {
  return new Date(iso).toLocaleString('en-ZA', {
    weekday:'long', year:'numeric', month:'long', day:'numeric',
    hour:'2-digit', minute:'2-digit', timeZone:'Africa/Johannesburg',
  });
}
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('en-ZA', {
    hour:'2-digit', minute:'2-digit', timeZone:'Africa/Johannesburg',
  });
}
function modeText(appt) {
  if (appt.sessionMode === 'virtual') {
    const link = process.env.TEAMS_MEETING_LINK;
    return link
      ? `Virtual session — join via Microsoft Teams: <a href="${link}" style="color:#1D9E75">${link}</a>`
      : 'Virtual session (link will be sent before your appointment)';
  }
  return `In-person – ${PRACTICE.address}`;
}

function emailShell(headerColor, title, bodyHtml) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
body{font-family:Georgia,serif;background:#f4f0eb;margin:0;padding:28px 12px}
.card{background:#fff;max-width:540px;margin:0 auto;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)}
.hdr{background:${headerColor};padding:24px 28px;color:#fff}
.hdr h1{margin:0;font-size:20px;font-weight:400}
.hdr p{margin:5px 0 0;opacity:.8;font-size:13px}
.body{padding:26px 28px;font-size:14px;color:#444}
.row{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #f0ece6;font-size:14px}
.row:last-child{border:none}
.lbl{color:#888;min-width:110px}
.val{color:#222;font-weight:500;text-align:right}
.footer{background:#f4f0eb;padding:16px 28px;font-size:11px;color:#999;text-align:center;line-height:1.6}
</style></head><body>
<div class="card">
  <div class="hdr"><h1>${title}</h1><p>${PRACTICE.name}</p></div>
  <div class="body">${bodyHtml}</div>
  <div class="footer">
    Your information is protected under POPIA.<br>
    Questions? ${PRACTICE.phone} · ${PRACTICE.email}
  </div>
</div></body></html>`;
}

function confirmHtml(appt) {
  return emailShell('#0F6E56', 'Appointment Confirmed ✓', `
    <p style="margin:0 0 18px">Dear <strong>${appt.patientName}</strong>, your appointment has been confirmed.</p>
    <div class="row"><span class="lbl">Service</span><span class="val">${appt.serviceType}</span></div>
    <div class="row"><span class="lbl">Date &amp; Time</span><span class="val">${fmtFull(appt.startTime)}</span></div>
    <div class="row"><span class="lbl">Mode</span><span class="val">${modeText(appt)}</span></div>
    <div class="row"><span class="lbl">Reference</span><span class="val">${appt.id.slice(0,8).toUpperCase()}</span></div>
    <p style="margin:18px 0 0;font-size:13px;color:#666">
      To reschedule or cancel, contact us at least 24 hours in advance:<br>
      📞 ${PRACTICE.phone} &nbsp;|&nbsp; ✉️ ${PRACTICE.email}
    </p>`);
}

function cancellationHtml(appt) {
  return emailShell('#b91c1c', 'Appointment Cancelled', `
    <p style="margin:0 0 18px">Dear <strong>${appt.patientName}</strong>, your appointment has been cancelled.</p>
    <div class="row"><span class="lbl">Service</span><span class="val">${appt.serviceType}</span></div>
    <div class="row"><span class="lbl">Was scheduled</span><span class="val">${fmtFull(appt.startTime)}</span></div>
    <div class="row"><span class="lbl">Reference</span><span class="val">${appt.id.slice(0,8).toUpperCase()}</span></div>
    <p style="margin:18px 0 0;font-size:13px;color:#666">
      To rebook: 📞 ${PRACTICE.phone} &nbsp;|&nbsp; ✉️ ${PRACTICE.email}
    </p>`);
}

function rescheduleHtml(appt) {
  return emailShell('#0369a1', 'Appointment Rescheduled', `
    <p style="margin:0 0 18px">Dear <strong>${appt.patientName}</strong>, your appointment has been rescheduled.</p>
    <div class="row"><span class="lbl">Service</span><span class="val">${appt.serviceType}</span></div>
    <div class="row"><span class="lbl">New date &amp; time</span><span class="val">${fmtFull(appt.startTime)}</span></div>
    <div class="row"><span class="lbl">Mode</span><span class="val">${modeText(appt)}</span></div>
    <div class="row"><span class="lbl">Reference</span><span class="val">${appt.id.slice(0,8).toUpperCase()}</span></div>
    <p style="margin:18px 0 0;font-size:13px;color:#666">
      Questions? 📞 ${PRACTICE.phone} &nbsp;|&nbsp; ✉️ ${PRACTICE.email}
    </p>`);
}

function reminderHtml(appt, hoursAhead) {
  const when = hoursAhead === 24 ? 'tomorrow' : 'in 2 hours';
  return emailShell('#085041', `Reminder: Appointment ${hoursAhead === 24 ? 'Tomorrow' : 'in 2 Hours'}`, `
    <p style="margin:0 0 16px">Dear <strong>${appt.patientName}</strong>, this is a reminder about your upcoming appointment.</p>
    <div style="background:#E1F5EE;border-left:3px solid #1D9E75;padding:13px 16px;border-radius:0 8px 8px 0;margin:0 0 16px">
      <strong>${appt.serviceType}</strong><br>
      🗓 ${fmtFull(appt.startTime)}<br>
      📍 ${modeText(appt)}
    </div>
    <p style="font-size:13px;color:#666">
      Your appointment is <strong>${when}</strong>.<br>
      To reschedule: 📞 ${PRACTICE.phone}
    </p>`);
}

function noShowHtml(appt) {
  return emailShell('#92400e', 'Missed Appointment', `
    <p style="margin:0 0 18px">Dear <strong>${appt.patientName}</strong>, we noted you were unable to attend your scheduled appointment.</p>
    <div class="row"><span class="lbl">Service</span><span class="val">${appt.serviceType}</span></div>
    <div class="row"><span class="lbl">Was scheduled</span><span class="val">${fmtFull(appt.startTime)}</span></div>
    <div class="row"><span class="lbl">Reference</span><span class="val">${appt.id.slice(0,8).toUpperCase()}</span></div>
    <p style="margin:18px 0 0;font-size:13px;color:#666">
      If you'd like to rebook, please contact us:<br>
      📞 ${PRACTICE.phone} &nbsp;|&nbsp; ✉️ ${PRACTICE.email}
    </p>`);
}

// Strips accidental quotes/whitespace from EMAIL_FROM and falls back to a known-good
// address if the configured one doesn't match the required "Name <email>" or "email" format.
function getSafeFromAddress(fallback) {
  const raw = (process.env.EMAIL_FROM || '').trim().replace(/^["']|["']$/g, '');
  const validPattern = /^([^<>]+<\S+@\S+\.\S+>|\S+@\S+\.\S+)$/;
  if (raw && validPattern.test(raw)) return raw;
  if (raw) console.warn(`[email] EMAIL_FROM "${raw}" is not in a valid format — falling back to default sender`);
  return fallback;
}

function parseFromAddress(fromString) {
  const match = fromString.match(/^(.*)<(.+)>$/);
  if (match) return { name: match[1].trim(), email: match[2].trim() };
  return { name: 'Nontobeko Ngcobo', email: fromString.trim() };
}

async function sendEmail({ to, subject, html, label }) {
  // ── SendGrid (HTTP API) — free tier sends to ANY recipient once a single
  // sender email is verified. No domain required. ──
  if (process.env.SENDGRID_API_KEY) {
    try {
      const from = parseFromAddress(getSafeFromAddress('Nontobeko Ngcobo <' + (process.env.SMTP_USER || 'noreply@example.com') + '>'));
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from:    { name: from.name, email: from.email },
          subject,
          content: [{ type: 'text/html', value: html }],
        }),
      });
      if (res.ok || res.status === 202) {
        console.log(`[email] ${label} → ${to} (via SendGrid)`);
        return;
      }
      const data = await res.json().catch(() => ({}));
      console.error(`[email] ${label} failed via SendGrid:`, data.errors?.map(e => e.message).join('; ') || res.status);
    } catch (err) {
      console.error(`[email] ${label} SendGrid error:`, err.message);
    }
    return;
  }

  // ── Brevo (HTTP API) — free tier sends to ANY recipient immediately,
  // no domain verification required, just your Gmail/any email as the sender. ──
  if (process.env.BREVO_API_KEY) {
    try {
      const from = parseFromAddress(getSafeFromAddress('Nontobeko Ngcobo <' + (process.env.SMTP_USER || 'noreply@example.com') + '>'));
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key':       process.env.BREVO_API_KEY,
          'Content-Type':  'application/json',
          'Accept':        'application/json',
        },
        body: JSON.stringify({
          sender:      { name: from.name, email: from.email },
          to:          [{ email: to }],
          subject,
          htmlContent: html,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        console.log(`[email] ${label} → ${to} (via Brevo)`);
        return;
      }
      console.error(`[email] ${label} failed via Brevo:`, data.message || JSON.stringify(data));
    } catch (err) {
      console.error(`[email] ${label} Brevo error:`, err.message);
    }
    return;
  }

  // ── Resend (HTTP API) — works on Render free tier, but free plan only allows
  // sending to your own verified email unless a domain is verified. ──
  if (process.env.RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from:    getSafeFromAddress('Nontobeko Ngcobo <onboarding@resend.dev>'),
          to:      [to],
          subject,
          html,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        console.log(`[email] ${label} → ${to} (via Resend)`);
        return;
      }
      console.error(`[email] ${label} failed via Resend:`, data.message || JSON.stringify(data));
    } catch (err) {
      console.error(`[email] ${label} Resend error:`, err.message);
    }
    return;
  }

  // ── Fallback to raw SMTP if no HTTP provider is configured — works locally /
  // on non-Render hosts where SMTP ports aren't blocked. ──
  if (!process.env.SMTP_USER) {
    console.log(`[email] No email provider configured — skipping ${label}`);
    return;
  }
  try {
    const transport = createTransport();
    await transport.verify();
    await transport.sendMail({ from: process.env.EMAIL_FROM, to, subject, html });
    console.log(`[email] ${label} → ${to} (via SMTP)`);
  } catch (err) {
    console.error(`[email] ${label} failed via SMTP:`, err.message);
  }
}

async function sendWhatsApp(mobile, message) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_WHATSAPP_FROM;
  if (!sid || !token || !from) { console.log('[whatsapp] Not configured — skipping'); return; }
  const to = 'whatsapp:' + mobile.replace(/^0/, '+27').replace(/\s/g, '');
  try {
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    const r    = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: from, To: to, Body: message }),
    });
    const d = await r.json();
    if (d.sid) console.log(`[whatsapp] Sent to ${to}`);
    else       console.error('[whatsapp]', d.message);
  } catch (err) { console.error('[whatsapp] Error:', err.message); }
}

async function sendConfirmationEmail(appt) {
  await sendEmail({ to: appt.patientEmail, subject: `Appointment confirmed – ${fmtTime(appt.startTime)}`, html: confirmHtml(appt), label: 'confirmation' });
}
async function sendCancellationEmail(appt) {
  await sendEmail({ to: appt.patientEmail, subject: `Appointment cancelled – ${appt.serviceType}`, html: cancellationHtml(appt), label: 'cancellation' });
}
async function sendRescheduleEmail(appt) {
  await sendEmail({ to: appt.patientEmail, subject: `Appointment rescheduled – ${fmtTime(appt.startTime)}`, html: rescheduleHtml(appt), label: 'reschedule' });
}
async function sendReminderEmail(appt, hoursAhead) {
  await sendEmail({ to: appt.patientEmail, subject: `Reminder: appointment ${hoursAhead === 24 ? 'tomorrow' : 'in 2 hours'} – ${fmtTime(appt.startTime)}`, html: reminderHtml(appt, hoursAhead), label: `${hoursAhead}h reminder` });
}
async function sendNoShowEmail(appt) {
  await sendEmail({ to: appt.patientEmail, subject: `Missed appointment – ${appt.serviceType}`, html: noShowHtml(appt), label: 'no-show notice' });
}
async function sendConfirmationWhatsApp(appt) {
  await sendWhatsApp(appt.patientMobile, `Hello ${appt.patientName},\n\nYour appointment with *Nontobeko Ngcobo* has been confirmed ✅\n\n📅 *Date & Time:* ${fmtFull(appt.startTime)}\n🩺 *Service:* ${appt.serviceType}\n📍 *Mode:* ${appt.sessionMode === 'virtual' ? 'Virtual session' : PRACTICE.address}\n🔖 *Ref:* ${appt.id.slice(0,8).toUpperCase()}\n\nTo reschedule or cancel, please contact us at least 24 hours in advance:\n📞 ${PRACTICE.phone}\n\nThank you.`);
}
async function sendReminderWhatsApp(appt, hoursAhead) {
  const when = hoursAhead === 24 ? 'tomorrow' : 'in 2 hours';
  await sendWhatsApp(appt.patientMobile, `Hello ${appt.patientName},\n\nReminder: appointment *${when}* with Nontobeko Ngcobo.\n\n🕐 *Time:* ${fmtTime(appt.startTime)}\n🩺 *Service:* ${appt.serviceType}\n📍 ${modeText(appt)}\n\nWe look forward to seeing you.\n📞 ${PRACTICE.phone}`);
}

module.exports = {
  sendConfirmationEmail, sendCancellationEmail, sendRescheduleEmail,
  sendReminderEmail, sendNoShowEmail, sendConfirmationWhatsApp, sendReminderWhatsApp,
};
