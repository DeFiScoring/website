-- DeFiScoring – Address book (T7-followup)
-- ---------------------------------------------------------------------------
-- Lets a signed-in user tag their linked wallets with categories
-- ("Cold storage", "DeFi degen", "Treasury") in addition to the existing
-- single `label` column. Tags are a comma-separated list of trimmed,
-- lowercased strings; we keep them in one TEXT column rather than a side
-- table because the cardinality per user is tiny (≤ tier wallet cap × ≤4
-- tags) and we never query "find all wallets with tag X" — only the
-- per-user fetch path needs them.

ALTER TABLE wallet_connections ADD COLUMN tags TEXT;
