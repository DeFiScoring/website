-- DeFiScoring – Community votes (D1)
-- One row per (wallet, protocol_slug). Wallets cast a single +1 ("safe") or
-- -1 ("unsafe") vote per protocol; sending a new vote upserts. The aggregate
-- read counts up/down/total and computes a 0..100 community score plus a
-- "verified" flag once a minimum quorum is reached.
--
-- NB. Auth is wallet-address-keyed only. Before production, gate POST/DELETE
-- behind SIWE (sign-in-with-ethereum) so a signed nonce proves wallet ownership.

CREATE TABLE IF NOT EXISTS community_votes (
  wallet         TEXT    NOT NULL,
  protocol_slug  TEXT    NOT NULL,
  vote           INTEGER NOT NULL CHECK (vote IN (-1, 1)),
  comment        TEXT,                              -- optional, ≤ 280 chars
  created_at     INTEGER NOT NULL,                  -- unix ms (first cast)
  updated_at     INTEGER NOT NULL,                  -- unix ms (last change)
  PRIMARY KEY (wallet, protocol_slug)
);

CREATE INDEX IF NOT EXISTS idx_votes_protocol
  ON community_votes (protocol_slug, updated_at DESC);
