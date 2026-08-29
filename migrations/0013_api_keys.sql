-- API keys: the licensing primitive.
--
-- Until now `bulk_api.requests.day` existed in lib/tiers.js with nothing to
-- issue or enforce against, so "Dedicated API quota" was a pricing-page claim
-- with no implementation. These two tables are what it was waiting for.
--
-- The raw key is NEVER stored. We keep a SHA-256 hash for lookup and a short
-- prefix so the dashboard can show the user which key is which. A leaked
-- database therefore does not yield working credentials.
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT,                        -- user-supplied label, e.g. "underwriting-prod"
  prefix       TEXT NOT NULL,               -- leading chars, shown in the UI; not a secret
  key_hash     TEXT NOT NULL,               -- SHA-256 hex of the full key
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER                      -- soft delete: revoked keys stay for the audit trail
);

-- Lookup path on every authenticated API request.
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id, revoked_at);

-- Per-key daily counters. The TIER limit is enforced per user through
-- tier_quotas (one budget however many keys you hold); this table answers the
-- different question a customer actually asks: "which of my keys is burning
-- the quota?" Keeping them separate means revoking a key never distorts the
-- account's enforced usage.
CREATE TABLE IF NOT EXISTS api_key_usage (
  key_id   TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  day      TEXT NOT NULL,                   -- 'YYYY-MM-DD' in UTC
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, day)
);

CREATE INDEX IF NOT EXISTS idx_api_key_usage_day ON api_key_usage (day);
