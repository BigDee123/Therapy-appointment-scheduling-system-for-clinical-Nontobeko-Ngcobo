-- ═══════════════════════════════════════════════════════════════
--  Nontobeko Ngcobo Booking System — Supabase Database Schema
--  Run this ONCE in the Supabase SQL Editor
--  Dashboard → SQL Editor → New query → paste → Run
-- ═══════════════════════════════════════════════════════════════

-- ── Patients ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS patients (
  id            TEXT PRIMARY KEY,
  full_name     TEXT NOT NULL,
  email         TEXT NOT NULL,
  mobile        TEXT NOT NULL,
  consent_given BOOLEAN DEFAULT TRUE,
  consent_at    TIMESTAMPTZ,
  anonymised_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS patients_email_idx ON patients(email);

-- ── Appointments ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS appointments (
  id                   TEXT PRIMARY KEY,
  patient_id           TEXT REFERENCES patients(id),
  patient_name         TEXT,
  patient_email        TEXT,
  patient_mobile       TEXT,
  service_type         TEXT NOT NULL,
  start_time           TIMESTAMPTZ NOT NULL,
  end_time             TIMESTAMPTZ NOT NULL,
  session_mode         TEXT NOT NULL,
  notes                TEXT,
  status               TEXT DEFAULT 'confirmed',
  reminders_consented  BOOLEAN DEFAULT TRUE,
  google_event_id      TEXT,
  anonymised_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS appointments_start_time_idx ON appointments(start_time);
CREATE INDEX IF NOT EXISTS appointments_status_idx ON appointments(status);
CREATE INDEX IF NOT EXISTS appointments_patient_id_idx ON appointments(patient_id);

-- ── Consent records ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS consent_records (
  id            TEXT PRIMARY KEY,
  patient_id    TEXT REFERENCES patients(id),
  patient_email TEXT,
  purposes      TEXT[],
  consent_text  TEXT,
  given_at      TIMESTAMPTZ DEFAULT NOW(),
  ip_address    TEXT,
  user_agent    TEXT,
  method        TEXT DEFAULT 'explicit_checkbox',
  withdrawn     BOOLEAN DEFAULT FALSE,
  withdrawn_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS consent_patient_idx ON consent_records(patient_id);

-- ── Reminders ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reminders (
  id             TEXT PRIMARY KEY,
  appointment_id TEXT REFERENCES appointments(id),
  channel        TEXT NOT NULL,
  hours_ahead    INTEGER NOT NULL,
  scheduled_at   TIMESTAMPTZ NOT NULL,
  status         TEXT DEFAULT 'pending',
  sent_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS reminders_status_idx ON reminders(status);
CREATE INDEX IF NOT EXISTS reminders_scheduled_idx ON reminders(scheduled_at);

-- ── Audit logs ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id             BIGSERIAL PRIMARY KEY,
  action         TEXT NOT NULL,
  appointment_id TEXT,
  patient_id     TEXT,
  performed_by   TEXT,
  ip             TEXT,
  detail         TEXT,
  fields         TEXT[],
  count          INTEGER,
  anonymised     INTEGER,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS audit_action_idx ON audit_logs(action);
CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_logs(created_at DESC);

-- ── Security events ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS security_events (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  detail      TEXT,
  ip          TEXT,
  user_agent  TEXT,
  timestamp   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS security_type_idx ON security_events(type);

-- ── Availability (single row, id=1) ───────────────────────────
CREATE TABLE IF NOT EXISTS availability (
  id            INTEGER PRIMARY KEY DEFAULT 1,
  working_hours JSONB NOT NULL DEFAULT '{
    "1": {"start": "08:00", "end": "17:00"},
    "2": {"start": "08:00", "end": "17:00"},
    "3": {"start": "08:00", "end": "17:00"},
    "4": {"start": "08:00", "end": "17:00"},
    "5": {"start": "08:00", "end": "13:00"}
  }',
  blocked_dates JSONB NOT NULL DEFAULT '[]',
  slot_duration INTEGER NOT NULL DEFAULT 60,
  CONSTRAINT single_row CHECK (id = 1)
);

-- Insert default availability row if not exists
INSERT INTO availability (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ── Row Level Security (disable for service key access) ───────
ALTER TABLE patients          DISABLE ROW LEVEL SECURITY;
ALTER TABLE appointments      DISABLE ROW LEVEL SECURITY;
ALTER TABLE consent_records   DISABLE ROW LEVEL SECURITY;
ALTER TABLE reminders         DISABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs        DISABLE ROW LEVEL SECURITY;
ALTER TABLE security_events   DISABLE ROW LEVEL SECURITY;
ALTER TABLE availability      DISABLE ROW LEVEL SECURITY;
