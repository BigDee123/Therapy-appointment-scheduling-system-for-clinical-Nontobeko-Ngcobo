const store = require('../data/store');
const { sendReminderEmail, sendReminderWhatsApp } = require('./notifications');

let intervalId = null;

function start() {
  if (intervalId) return;
  console.log('[scheduler] Reminder scheduler started (checks every 60s)');
  intervalId = setInterval(runCheck, 60_000);
  runCheck(); // immediate first run
}

async function runCheck() {
  const now       = new Date();
  const reminders = store.getReminders().filter(r => r.status === 'pending');

  for (const reminder of reminders) {
    const due = new Date(reminder.scheduledAt);
    if (due > now) continue; // not yet

    const appt = store.getAppointmentById(reminder.appointmentId);
    if (!appt || appt.status === 'cancelled') {
      store.updateReminder(reminder.id, { status: 'skipped' });
      continue;
    }

    try {
      if (reminder.channel === 'email') {
        await sendReminderEmail(appt, reminder.hoursAhead);
      } else if (reminder.channel === 'whatsapp') {
        await sendReminderWhatsApp(appt, reminder.hoursAhead);
      }
      store.updateReminder(reminder.id, { status: 'sent', sentAt: new Date().toISOString() });
    } catch (err) {
      console.error(`[scheduler] Reminder ${reminder.id} failed:`, err.message);
      store.updateReminder(reminder.id, { status: 'failed' });
    }
  }
}

function scheduleRemindersForAppointment(appt) {
  const { v4: uuidv4 } = require('uuid');
  const apptTime = new Date(appt.startTime).getTime();
  const now      = Date.now();

  const schedule = [
    { hoursAhead: 24, channels: ['email', 'whatsapp'] },
    { hoursAhead: 2,  channels: ['email', 'whatsapp'] },
  ];

  for (const { hoursAhead, channels } of schedule) {
    const scheduledAt = new Date(apptTime - hoursAhead * 3600_000);
    if (scheduledAt.getTime() <= now) continue; // already past

    for (const channel of channels) {
      store.addReminder({
        id:            uuidv4(),
        appointmentId: appt.id,
        channel,
        hoursAhead,
        scheduledAt:   scheduledAt.toISOString(),
        status:        'pending',
        createdAt:     new Date().toISOString(),
      });
    }
  }
}

module.exports = { start, scheduleRemindersForAppointment };
