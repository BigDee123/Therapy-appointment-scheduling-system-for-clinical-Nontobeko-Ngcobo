-- ═══════════════════════════════════════════════════════════════
--  MIGRATION: Add invoices table to an existing database
--  Run this ONCE in the Supabase SQL Editor if you already ran
--  schema.sql before invoices were added.
--  Dashboard → SQL Editor → New query → paste → Run
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS invoices (
  id              TEXT PRIMARY KEY,
  invoice_number  TEXT NOT NULL,
  appointment_id  TEXT REFERENCES appointments(id),
  patient_id      TEXT REFERENCES patients(id),
  patient_name    TEXT NOT NULL,
  patient_dob     TEXT,
  patient_id_no   TEXT,
  patient_contact TEXT,
  payment_type    TEXT NOT NULL DEFAULT 'cash',
  medical_aid_name TEXT,
  medical_aid_no   TEXT,
  line_items      JSONB NOT NULL DEFAULT '[]',
  total           NUMERIC(10,2) NOT NULL DEFAULT 0,
  invoice_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  created_by      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS invoices_patient_idx ON invoices(patient_id);
CREATE INDEX IF NOT EXISTS invoices_date_idx ON invoices(invoice_date DESC);

ALTER TABLE invoices DISABLE ROW LEVEL SECURITY;
