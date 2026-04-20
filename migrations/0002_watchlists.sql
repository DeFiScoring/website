-- DeFiScoring – Watchlists (D1)
-- One row per (wallet, item). `item` is a stable identifier:
--   • DeFiLlama protocol slug, e.g. "aave-v3", "uniswap-v3"
--   • Or a chain-prefixed token contract, e.g. "ethereum:0xa0b8...c606" (USDC)
-- The frontend chooses the kind via the `kind` column so renderers can pick
-- the right data source.

CREATE TABLE IF NOT EXISTS watchlists (
  wallet           TEXT    NOT NULL,
  item             TEXT    NOT NULL,
  kind             TEXT    NOT NULL CHECK (kind IN ('protocol', 'token')),
  label            TEXT,                              -- optional display name
  alert_threshold  REAL,                              -- e.g. score < threshold => notify
  added_at         INTEGER NOT NULL,                  -- unix ms
  PRIMARY KEY (wallet, item)
);

CREATE INDEX IF NOT EXISTS idx_watchlists_wallet
  ON watchlists (wallet, added_at DESC);
