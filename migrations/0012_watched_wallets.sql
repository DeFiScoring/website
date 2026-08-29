-- Watched wallets: addresses a user follows without necessarily owning them.
-- (Named watched_wallets, not watchlists — migrations/0002 already has a
-- `watchlists` table for the older per-wallet protocol/token watchlist that
-- assets/js/watchlist.js still uses. Different feature, kept apart.)
-- Tier caps for watchlist.size have existed in lib/tiers.js since T6;
-- this table is what they were waiting for. Watched wallets join the
-- scheduled re-score queue (handlers/rescore.js), which is what makes a
-- watched_wallets entry live data rather than a bookmark.
CREATE TABLE IF NOT EXISTS watched_wallets (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet     TEXT NOT NULL,
  label      TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, wallet)
);
CREATE INDEX IF NOT EXISTS idx_watched_wallets_user ON watched_wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_watched_wallets_wallet ON watched_wallets(wallet);
