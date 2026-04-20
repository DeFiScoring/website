-- DeFiScoring – Risk Profile Chatbot leads (D1)
--
-- One row per email that has accepted the consent prompt and started a
-- chatbot session. Email is the natural primary key so re-using the same
-- form simply updates `last_seen_at` rather than creating duplicates.
--
-- Session conversation history is intentionally NOT stored here — it lives
-- in KV (DEFI_CACHE) under `chatbot:{sessionId}` with a 1h TTL so the
-- transcripts age out automatically and we never accumulate raw user
-- chat content beyond that window.

CREATE TABLE IF NOT EXISTS chatbot_leads (
  email              TEXT    PRIMARY KEY,
  source             TEXT    NOT NULL DEFAULT 'chatbot',
  consented_at       INTEGER NOT NULL,                    -- unix ms (first opt-in)
  last_seen_at       INTEGER NOT NULL,                    -- unix ms (most recent activity)
  sessions_count     INTEGER NOT NULL DEFAULT 1,
  last_risk_profile  TEXT,                                -- 'Conservative' | 'Moderate' | 'Aggressive'
  marketing_opt_out  INTEGER NOT NULL DEFAULT 0           -- 0 = subscribed, 1 = unsubscribed
);

CREATE INDEX IF NOT EXISTS idx_chatbot_leads_seen
  ON chatbot_leads (last_seen_at DESC);
