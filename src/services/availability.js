const store = require('../data/store');

/**
 * Returns available time slots for a given date string 'YYYY-MM-DD'.
 */
function getSlotsForDate(dateStr) {
  const avail    = store.getAvailability();
  const date     = new Date(dateStr + 'T00:00:00');
  const dayOfWeek = date.getDay(); // 0=Sun, 1=Mon...

  // Check if day is in working hours
  const hours = avail.workingHours[dayOfWeek];
  if (!hours) return [];

  // Check blocked dates
  const isBlocked = avail.blockedDates.some(b => b.date === dateStr);
  if (isBlocked) return [];

  // Generate slots
  const [startH, startM] = hours.start.split(':').map(Number);
  const [endH,   endM]   = hours.end.split(':').map(Number);
  const duration = avail.slotDuration || 60;

  const slots = [];
  let current = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  while (current + duration <= endMinutes) {
    const slotStart = `${dateStr}T${pad(Math.floor(current / 60))}:${pad(current % 60)}:00`;
    const slotEnd   = `${dateStr}T${pad(Math.floor((current + duration) / 60))}:${pad((current + duration) % 60)}:00`;

    const taken = store.isSlotTaken(slotStart, slotEnd);
    // Don't show slots in the past
    const now = new Date();
    const slotDate = new Date(slotStart);

    if (!taken && slotDate > now) {
      slots.push({
        startTime: slotStart,
        endTime:   slotEnd,
        display:   `${pad(Math.floor(current / 60))}:${pad(current % 60)}`,
      });
    }
    current += duration;
  }
  return slots;
}

function pad(n) { return String(n).padStart(2, '0'); }

module.exports = { getSlotsForDate };
