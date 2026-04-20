-- DeFiScoring – Health Score history (D1)
-- Each row is one score computation. The dashboard reads the most recent N
-- rows for a wallet to render the trend chart and breakdown deltas.

CREATE TABLE IF NOT EXISTS health_scores (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet              TEXT    NOT NULL,
  score               INTEGER NOT NULL,             -- 300..850
  loan_reliability    REAL,                         -- 0..100
  liquidity_provision REAL,                         -- 0..100
  governance          REAL,                         -- 0..100
  account_age         REAL,                         -- 0..100
  raw_h_s             REAL,                         -- weighted Hs (0..100) before mapping
  source_json         TEXT,                         -- JSON snapshot of underlying signals
  computed_at         INTEGER NOT NULL              -- unix ms
);

CREATE INDEX IF NOT EXISTS idx_health_wallet_time
  ON health_scores (wallet, computed_at DESC);
