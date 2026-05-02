-- DeFiScoring – T6 Alerts (D1)
-- ---------------------------------------------------------------------------
-- Server-side alert rules (replacing the localStorage-only dashboard-alerts.js).
-- A scheduled Worker runs every 5 minutes, evaluates every active rule against
-- current chain state, and dispatches notifications via the user's configured
-- channels (email + telegram). Each delivery is logged for audit + dedupe.
-- ---------------------------------------------------------------------------

-- Alert rules — what to watch for. `kind` controls the evaluation logic;
-- `params_json` stores type-specific config (threshold values, target wallet,
-- etc.) so we don't have to migrate the schema for every new rule type.
CREATE TABLE IF NOT EXISTS alert_rules (
  id              TEXT PRIMARY KEY,                     -- ulid
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_address  TEXT NOT NULL,                        -- the wallet being monitored
  kind            TEXT NOT NULL CHECK (kind IN (
                       'health_factor',                 -- HF drops below threshold
                       'price',                         -- token price crosses threshold
                       'score_change',                  -- wallet score moves N points
                       'approval_change',               -- new infinite approval granted
                       'liquidation_risk',              -- HF in danger zone
                       'protocol_event'                 -- protocol exploit/peg-break
                     )),
  params_json     TEXT NOT NULL,                        -- JSON, kind-specific config
  channels_json   TEXT NOT NULL DEFAULT '["email"]',    -- ["email","telegram"]
  is_active       INTEGER NOT NULL DEFAULT 1,
  cooldown_secs   INTEGER NOT NULL DEFAULT 3600,        -- min seconds between fires
  last_fired_at   INTEGER,                              -- unix ms (null if never fired)
  last_value      TEXT,                                 -- JSON snapshot of last evaluation
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_alert_rules_active
  ON alert_rules (is_active, wallet_address);
CREATE INDEX IF NOT EXISTS idx_alert_rules_user
  ON alert_rules (user_id, created_at DESC);

-- Alert delivery channels — per-user destination addresses. A user may have
-- multiple channels of the same kind (e.g. two telegram chats). The
-- `is_verified` flag gates delivery — we won't send to unverified channels.
CREATE TABLE IF NOT EXISTS alert_channels (
  id              TEXT PRIMARY KEY,                     -- ulid
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('email', 'telegram', 'webhook')),
  destination     TEXT NOT NULL,                        -- email addr / telegram chat_id / webhook URL
  label           TEXT,                                 -- optional, user-set
  is_verified     INTEGER NOT NULL DEFAULT 0,
  verification_token TEXT,                              -- one-time token for opt-in flow
  created_at      INTEGER NOT NULL,
  verified_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_alert_channels_user
  ON alert_channels (user_id, kind);

-- Delivery log — audit trail + dedupe. Inserted by the cron handler before
-- attempting delivery; status updated after. Pruned by the existing daily
-- retention cron (worker/index.js runRetentionPrune).
CREATE TABLE IF NOT EXISTS alert_deliveries (
  id              TEXT PRIMARY KEY,                     -- ulid
  rule_id         TEXT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  channel_id      TEXT NOT NULL REFERENCES alert_channels(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL,                        -- denormalized for audit query speed
  fired_at        INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed', 'suppressed')),
  payload_json    TEXT NOT NULL,                        -- what was actually sent
  error_message   TEXT,
  delivered_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_alert_deliveries_rule
  ON alert_deliveries (rule_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_deliveries_user
  ON alert_deliveries (user_id, fired_at DESC);
