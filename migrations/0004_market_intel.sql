-- DeFiScoring – Market Intelligence (D1)
--
-- Anonymized, aggregated telemetry from in-app actions (score render,
-- profiler run, approvals scan). Writes happen via POST /api/intel/event
-- and are gated by an explicit user opt-in stored in localStorage.
--
-- Privacy model
-- -------------
--   • The browser only ever sends sha256(walletAddress) — the raw address
--     never leaves the client when intel logging is on.
--   • The Worker re-hashes that with HMAC-SHA256 keyed by INTEL_SALT
--     before insertion. Without the salt, a stolen DB cannot be reversed
--     by precomputing hashes of known active wallets.
--   • No PII, no IPs, no User-Agent strings stored.
--
-- The aggregate row uses a composite primary key (date, chain) and stores
-- *sums* + *counters* rather than running means, so we recompute the
-- average on read and never accumulate floating-point drift.

CREATE TABLE IF NOT EXISTS intel_daily_aggregates (
  date                       TEXT    NOT NULL,           -- YYYY-MM-DD (UTC)
  chain                      TEXT    NOT NULL,           -- e.g. "ethereum"
  total_events               INTEGER NOT NULL DEFAULT 0,
  unique_wallets             INTEGER NOT NULL DEFAULT 0, -- best-effort, see below
  score_sum                  INTEGER NOT NULL DEFAULT 0, -- sum of defi_score across rows
  score_count                INTEGER NOT NULL DEFAULT 0, -- denom for avg (events with a score)
  aggressive_count           INTEGER NOT NULL DEFAULT 0,
  conservative_count         INTEGER NOT NULL DEFAULT 0,
  moderate_count             INTEGER NOT NULL DEFAULT 0,
  unlimited_approvals_count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, chain)
);

CREATE TABLE IF NOT EXISTS intel_events (
  id              TEXT PRIMARY KEY,                -- uuid
  hashed_wallet   TEXT NOT NULL,                   -- HMAC-SHA256(sha256(wallet), INTEL_SALT)
  event_type      TEXT NOT NULL,                   -- 'score_render' | 'profiler_run' | 'approvals_scan'
  defi_score      INTEGER,                         -- 300..850 (nullable)
  risk_profile    TEXT,                            -- 'Conservative' | 'Moderate' | 'Aggressive'
  chain           TEXT NOT NULL DEFAULT 'ethereum',
  metadata        TEXT,                            -- JSON, must contain no PII
  created_at      INTEGER NOT NULL                 -- unix ms
);

CREATE INDEX IF NOT EXISTS idx_intel_events_type_time
  ON intel_events (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intel_events_wallet_time
  ON intel_events (hashed_wallet, created_at DESC);
