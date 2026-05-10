-- DeFiScoring – Stream B: Admin SPA backing tables (D1)
-- ---------------------------------------------------------------------------
-- Adds three things:
--   1. `admin_audit_log` — append-only record of every admin mutation. Used
--      by the /admin/ "Audit Log" tab and as evidence in any future
--      dispute. Per the threat model, admin actions MUST be auditable.
--   2. `admin_notes`     — free-form per-user notes that an admin can leave
--      on a user (e.g. "support ticket #42 — refunded $15").
--   3. `users.suspended_at` — soft-ban timestamp. When set, requireSession()
--      callers continue to work for read endpoints but mutating handlers
--      should reject. (Wiring of the reject is out of scope for this
--      migration; the column is the prerequisite.)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id            TEXT PRIMARY KEY,                 -- ulid
  actor_id      TEXT NOT NULL,                    -- admin user.id who did the action
  actor_wallet  TEXT NOT NULL,                    -- denormalized for display
  action        TEXT NOT NULL,                    -- e.g. 'user.suspend', 'sub.refund'
  target_type   TEXT,                             -- 'user' | 'subscription' | 'alert_rule' | 'lead' | 'retention'
  target_id     TEXT,                             -- the affected row's id (or wallet, or 'global')
  before_json   TEXT,                             -- JSON snapshot before the change (nullable)
  after_json    TEXT,                             -- JSON snapshot after the change (nullable)
  ip_hash       TEXT,                             -- HMAC-SHA256 of request IP (IP_HASH_PEPPER)
  created_at    INTEGER NOT NULL                  -- unix ms
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_actor
  ON admin_audit_log (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target
  ON admin_audit_log (target_type, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created
  ON admin_audit_log (created_at DESC);

CREATE TABLE IF NOT EXISTS admin_notes (
  id          TEXT PRIMARY KEY,                   -- ulid
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id   TEXT NOT NULL,                      -- admin user.id who wrote it
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_notes_user
  ON admin_notes (user_id, created_at DESC);

-- Soft-ban marker. Null = active. Non-null = suspended at that ts.
-- Existing rows default to NULL. We can't ADD COLUMN with a NOT NULL
-- constraint in SQLite without a default, but DEFAULT NULL is fine.
--
-- NOTE: SQLite/D1 has no `ADD COLUMN IF NOT EXISTS`, so re-running this
-- migration on a database that already has `suspended_at` will return
-- `duplicate column name: suspended_at`. That error is benign and means
-- the column is already present — operators may safely ignore it.
ALTER TABLE users ADD COLUMN suspended_at INTEGER;
