require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const path      = require('path');

const publicRoutes = require('./routes/public');
const adminRoutes  = require('./routes/admin');
const scheduler    = require('./services/scheduler');
const popia        = require('./popia/compliance');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// Trust proxy (needed for Railway/Render to get real IPs)
app.set('trust proxy', 1);

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use('/api/appointments', rateLimit({ windowMs: 60_000, max: 10,
  message: { error: 'Too many requests. Please wait a moment.' } }));
app.use('/api/admin/login', rateLimit({ windowMs: 15 * 60_000, max: 10,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' } }));
app.use('/api/dsr', rateLimit({ windowMs: 60 * 60_000, max: 5,
  message: { error: 'Too many data requests. Try again later.' } }));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api', publicRoutes);
app.use('/api/admin', adminRoutes);

// ── Static frontend ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));
app.get('/{*path}', (_req, res) =>
  res.sendFile(path.join(__dirname, '../public/index.html'))
);

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🟢  Booking system  →  http://localhost:${PORT}`);
  console.log(`🔐  Admin dashboard →  http://localhost:${PORT}/admin.html`);
  console.log(`🛡️   POPIA compliant  →  http://localhost:${PORT}/privacy.html\n`);
  scheduler.start();

  // Run retention check on startup (safe no-op if nothing expired)
  popia.enforceRetentionPolicy();
});
