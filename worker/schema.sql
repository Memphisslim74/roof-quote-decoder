-- Roof Claim Decoder — D1 schema
-- Deliberately narrow: sales-qualification data only. No policy numbers,
-- no signatures, no banking info, no full estimate text.

CREATE TABLE IF NOT EXISTS leads (
  id               TEXT PRIMARY KEY,
  created_at       TEXT NOT NULL,

  first_name       TEXT NOT NULL,
  last_name        TEXT NOT NULL,
  phone            TEXT NOT NULL,
  email            TEXT NOT NULL,
  address          TEXT NOT NULL,

  carrier          TEXT,
  claim_number     TEXT,
  date_of_loss     TEXT,

  rcv              REAL,
  acv              REAL,
  deductible       REAL,
  net_claim        REAL,
  depreciation     REAL,

  confidence       REAL,
  needs_review     INTEGER DEFAULT 0,
  scanned_fallback INTEGER DEFAULT 0,
  source_ip        TEXT,

  contacted_at     TEXT,
  notes            TEXT
);

CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads (created_at);
CREATE INDEX IF NOT EXISTS idx_leads_needs_review ON leads (needs_review);
