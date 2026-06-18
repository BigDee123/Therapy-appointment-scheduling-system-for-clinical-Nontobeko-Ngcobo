/**
 * Reminder scheduler — checks every 60 seconds for due reminders.
 * Now fully async with Supabase store.
 */
const store = require('../data/store');
const { sendReminderEmail, sendReminderWhatsApp } = require('./notifications');

let intervalId = null;

function start() {
  if (intervalId) return;
  console.log('[scheduler] Reminder scheduler started (checks every 60s)');
  intervalId = setInterval(runCheck, 60_000);
  runCheck();
}

async function runCheck() {
  try {
    const reminders = await store.getReminders();
    const now       = new Date();

    for (const reminder of reminders) {
      if (new Date(reminder.scheduledAt) > now) continue;

      const appt = await store.getAppointmentById(reminder.appointmentId);
      if (!appt || appt.status === 'cancelled') {
        await store.updateReminder(reminder.id, { status: 'skipped' });
        continue;
      }

      try {
        if (reminder.channel === 'email') {
          await sendReminderEmail(appt, reminder.hoursAhead);
        } else if (reminder.channel === 'whatsapp') {
          await sendReminderWhatsApp(appt, reminder.hoursAhead);
        }
        await store.updateReminder(reminder.id, {
          status: 'sent', sentAt: new Date().toISOString(),
        });
      } catch (err) {
        console.error(`[scheduler] Reminder ${reminder.id} failed:`, err.message);
        await store.updateReminder(reminder.id, { status: 'failed' });
      }
    }
  } catch (err) {
    console.error('[scheduler] runCheck error:', err.message);
  }
}

async function scheduleRemindersForAppointment(appt) {
  const { v4: uuidv4 } = require('uuid');
  const apptTime = new Date(appt.startTime).getTime();
  const now      = Date.now();

  const schedule = [
    { hoursAhead: 24, channels: ['email', 'whatsapp'] },
    { hoursAhead: 2,  channels: ['email', 'whatsapp'] },
  ];

  for (const { hoursAhead, channels } of schedule) {
    const scheduledAt = new Date(apptTime - hoursAhead * 3_600_000);
    if (scheduledAt.getTime() <= now) continue;

    for (const channel of channels) {
      try {
        await store.addReminder({
          id:            uuidv4(),
          appointmentId: appt.id,
          channel,
          hoursAhead,
          scheduledAt:   scheduledAt.toISOString(),
          status:        'pending',
          createdAt:     new Date().toISOString(),
        });
      } catch (err) {
        console.error('[scheduler] addReminder failed:', err.message);
      }
    }
  }
}

module.exports = { start, scheduleRemindersForAppointment };
