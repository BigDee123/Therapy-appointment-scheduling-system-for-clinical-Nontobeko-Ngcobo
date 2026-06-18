/**
 * Availability service — computes free time slots for a given date.
 * Now async because store is backed by Supabase.
 */
const store = require('../data/store');

async function getSlotsForDate(dateStr) {
  const avail     = await store.getAvailability();
  const date      = new Date(dateStr + 'T00:00:00');
  const dayOfWeek = date.getDay();

  const hours = avail.workingHours[dayOfWeek];
  if (!hours) return [];

  const isBlocked = (avail.blockedDates || []).some(b => b.date === dateStr);
  if (isBlocked) return [];

  const [startH, startM] = hours.start.split(':').map(Number);
  const [endH,   endM]   = hours.end.split(':').map(Number);
  const duration          = avail.slotDuration || 60;

  const slots = [];
  let current  = startH * 60 + startM;
  const endMin = endH   * 60 + endM;
  const now    = new Date();

  while (current + duration <= endMin) {
    const slotStart = `${dateStr}T${pad(Math.floor(current / 60))}:${pad(current % 60)}:00`;
    const slotEnd   = `${dateStr}T${pad(Math.floor((current + duration) / 60))}:${pad((current + duration) % 60)}:00`;

    if (new Date(slotStart) > now) {
      const taken = await store.isSlotTaken(slotStart, slotEnd);
      if (!taken) {
        slots.push({
          startTime: slotStart,
          endTime:   slotEnd,
          display:   `${pad(Math.floor(current / 60))}:${pad(current % 60)}`,
        });
      }
    }
    current += duration;
  }
  return slots;
}

function pad(n) { return String(n).padStart(2, '0'); }

module.exports = { getSlotsForDate };
