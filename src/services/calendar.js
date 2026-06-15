/**
 * Google Calendar integration
 * Creates/cancels calendar events when appointments are booked or cancelled.
 *
 * Setup: See README.md Section 4 — Google Calendar setup.
 * If GOOGLE_CALENDAR_* env vars are not set, this module silently skips.
 */

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY  = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

function isConfigured() {
  return !!(CALENDAR_ID && CLIENT_EMAIL && PRIVATE_KEY);
}

/**
 * Get a Google OAuth2 access token using a service account JWT.
 */
async function getAccessToken() {
  const now   = Math.floor(Date.now() / 1000);
  const claim = {
    iss:   CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600,
    iat:   now,
  };

  // Build JWT manually (no extra deps needed)
  const header  = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claim));
  const signing = `${header}.${payload}`;

  const crypto  = require('crypto');
  const sign    = crypto.createSign('RSA-SHA256');
  sign.update(signing);
  const sig = sign.sign(PRIVATE_KEY, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const jwt = `${signing}.${sig}`;

  const res  = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  jwt,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Google auth failed: ' + JSON.stringify(data));
  return data.access_token;
}

function b64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Create a Google Calendar event for a confirmed appointment.
 * Stores the Google event ID back onto the appointment record.
 */
async function createCalendarEvent(appt) {
  if (!isConfigured()) {
    console.log('[calendar] Not configured — skipping event creation');
    return null;
  }
  try {
    const token = await getAccessToken();
    const body  = {
      summary:     `${appt.serviceType} — ${appt.patientName}`,
      description: `Patient: ${appt.patientName}\nService: ${appt.serviceType}\nMode: ${appt.sessionMode}\nRef: ${appt.id.slice(0,8).toUpperCase()}\n\nBooked via online booking system.`,
      location:    appt.sessionMode === 'virtual'
        ? 'Virtual session — link to be sent 30 min before'
        : process.env.PRACTICE_ADDRESS || 'Simla Medical Centre, Belhar, Cape Town',
      start: { dateTime: new Date(appt.startTime).toISOString(), timeZone: 'Africa/Johannesburg' },
      end:   { dateTime: new Date(appt.endTime).toISOString(),   timeZone: 'Africa/Johannesburg' },
      reminders: {
        useDefault: false,
        overrides:  [{ method: 'popup', minutes: 30 }, { method: 'email', minutes: 1440 }],
      },
      colorId: '2', // sage green
    };

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    const data = await res.json();
    if (data.id) {
      console.log(`[calendar] Event created: ${data.id}`);
      return data.id;
    }
    console.error('[calendar] Failed to create event:', data.error?.message);
    return null;
  } catch (err) {
    console.error('[calendar] Error:', err.message);
    return null;
  }
}

/**
 * Cancel (delete) a Google Calendar event when appointment is cancelled.
 */
async function cancelCalendarEvent(googleEventId) {
  if (!isConfigured() || !googleEventId) return;
  try {
    const token = await getAccessToken();
    await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${googleEventId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
    );
    console.log(`[calendar] Event cancelled: ${googleEventId}`);
  } catch (err) {
    console.error('[calendar] Cancel error:', err.message);
  }
}

module.exports = { createCalendarEvent, cancelCalendarEvent, isConfigured };
