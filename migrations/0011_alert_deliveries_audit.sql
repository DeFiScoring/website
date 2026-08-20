-- DeFiScoring – Make alert_deliveries usable as an audit log
-- ---------------------------------------------------------------------------
-- Two defects in the 0007 definition of alert_deliveries made the table lose
-- exactly the records an audit log exists to keep:
--
--   1. channel_id was NOT NULL with an FK to alert_channels, but the "rule
--      fired and you had no verified channel" path has no channel to point at.
--      It bound the literal string 'none', the FK rejected the INSERT, and the
--      suppression was never recorded — the user's rule fired, nothing was
--      delivered, and nothing said so.
--
--   2. ON DELETE CASCADE on channel_id meant removing a channel erased every
--      delivery ever made through it. An audit trail that disappears when the
--      subject of the audit is deleted is not an audit trail.
--
-- Fix both by rebuilding the table: channel_id becomes nullable with
-- ON DELETE SET NULL, so a suppression records as NULL and history outlives
-- the channel. rule_id keeps its CASCADE — deleting a rule is a user-initiated
-- "forget this" and the delivery rows are meaningless without it.
--
-- SQLite cannot ALTER a constraint, so this is the standard
-- create/copy/drop/rename rebuild. No PRAGMA statements: D1 rejects them, and
-- nothing else in the schema references alert_deliveries, so the drop and
-- rename are safe with foreign keys enforced.
-- ---------------------------------------------------------------------------

CREATE TABLE alert_deliveries_rebuild (
  id              TEXT PRIMARY KEY,
  rule_id         TEXT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  channel_id      TEXT REFERENCES alert_channels(id) ON DELETE SET NULL,
  user_id         TEXT NOT NULL,
  fired_at        INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed', 'suppressed')),
  payload_json    TEXT NOT NULL,
  error_message   TEXT,
  delivered_at    INTEGER
);

-- Carry existing rows over, mapping the 'none' sentinel (and any id whose
-- channel has since been deleted) to a real NULL.
INSERT INTO alert_deliveries_rebuild
  (id, rule_id, channel_id, user_id, fired_at, status, payload_json, error_message, delivered_at)
SELECT d.id, d.rule_id,
       CASE WHEN c.id IS NULL THEN NULL ELSE d.channel_id END,
       d.user_id, d.fired_at, d.status, d.payload_json, d.error_message, d.delivered_at
FROM alert_deliveries d
LEFT JOIN alert_channels c ON c.id = d.channel_id;

DROP TABLE alert_deliveries;
ALTER TABLE alert_deliveries_rebuild RENAME TO alert_deliveries;

CREATE INDEX IF NOT EXISTS idx_alert_deliveries_rule
  ON alert_deliveries (rule_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_deliveries_user
  ON alert_deliveries (user_id, fired_at DESC);
