-- DeFiScoring – T6.5 Auth + Subscriptions (D1)
-- ---------------------------------------------------------------------------
-- Schema for SIWE (EIP-4361) authentication, multi-wallet linking, session
-- cookies, and Stripe-backed subscriptions.
--
-- Identity model
-- --------------
--   • A `user` is created the first time a wallet successfully completes SIWE.
--   • A user can link additional wallets (each requires its own SIWE sig).
--   • A user has exactly one current subscription (free/pro/plus/enterprise).
--   • Sessions are HTTP-only cookies signed with SESSION_HMAC_KEY; the cookie
--     stores only the session id; the row is the source of truth.
--
-- Privacy
-- -------
--   • We never store passwords, emails, IPs, or User-Agent strings.
--   • Email is OPTIONAL (only if user opts in to email alerts).
--   • Sessions auto-expire and are pruned by the daily retention cron.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id                   TEXT PRIMARY KEY,                -- ulid
  primary_wallet       TEXT NOT NULL UNIQUE,            -- lowercased 0x-address from first SIWE
  email                TEXT,                            -- optional, for email alerts only
  display_name         TEXT,                            -- optional, user-set
  is_admin             INTEGER NOT NULL DEFAULT 0,      -- 1 = full admin access
  created_at           INTEGER NOT NULL,                -- unix ms
  last_login_at        INTEGER NOT NULL                 -- unix ms
);

CREATE INDEX IF NOT EXISTS idx_users_primary_wallet
  ON users (primary_wallet);

-- Wallet connections — every wallet a user has linked, plus the audit trail
-- of when/how they proved ownership. The first row per user mirrors
-- users.primary_wallet; additional rows are linked via /api/wallets/link.
CREATE TABLE IF NOT EXISTS wallet_connections (
  user_id          TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_address   TEXT    NOT NULL,                    -- lowercased 0x-address
  label            TEXT,                                -- optional, e.g. "Ledger Cold"
  signature        TEXT    NOT NULL,                    -- SIWE signature proving ownership
  message_hash     TEXT    NOT NULL,                    -- keccak256 of the signed SIWE message
  is_primary       INTEGER NOT NULL DEFAULT 0,
  connected_at     INTEGER NOT NULL,                    -- unix ms (first link)
  last_seen_at     INTEGER NOT NULL,                    -- unix ms (last activity)
  PRIMARY KEY (user_id, wallet_address)
);

CREATE INDEX IF NOT EXISTS idx_wallet_connections_address
  ON wallet_connections (wallet_address);

-- Sessions — cookie-backed authentication state. Cookie value is just the
-- session id (HMAC-signed); the row is consulted on every authed request.
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,                     -- ulid (also the cookie value, signed)
  user_id         TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_address  TEXT    NOT NULL,                     -- which wallet this session was opened with
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,                     -- unix ms, 30 days default
  last_seen_at    INTEGER NOT NULL,
  user_agent_hash TEXT                                  -- HMAC-SHA256 of UA, for theft detection only
);

CREATE INDEX IF NOT EXISTS idx_sessions_user
  ON sessions (user_id, expires_at DESC);

-- Subscriptions — single source of truth for billing tier. Stripe webhooks
-- upsert into this table. `tier` is the gating column read by middleware.
CREATE TABLE IF NOT EXISTS subscriptions (
  user_id              TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tier                 TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'plus', 'enterprise')),
  stripe_customer_id   TEXT,                            -- nullable for free tier
  stripe_subscription_id TEXT,                          -- nullable for free tier
  status               TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'past_due', 'canceled', 'trialing', 'incomplete')),
  current_period_end   INTEGER,                         -- unix ms
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  metadata             TEXT,                            -- JSON, freeform from Stripe
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer
  ON subscriptions (stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_sub
  ON subscriptions (stripe_subscription_id);

-- Tier quotas — per-user counters reset on a rolling window. Used to enforce
-- "5 alerts on Free", "3 AI explanations/day", etc. without paying KV traffic
-- on every request. The middleware reads + increments here.
CREATE TABLE IF NOT EXISTS tier_quotas (
  user_id      TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quota_key    TEXT    NOT NULL,                        -- e.g. 'alerts.created.month', 'ai.explain.day'
  used         INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,                        -- unix ms (start of current window)
  window_end   INTEGER NOT NULL,                        -- unix ms (when this row resets)
  PRIMARY KEY (user_id, quota_key)
);

CREATE INDEX IF NOT EXISTS idx_tier_quotas_window
  ON tier_quotas (user_id, window_end);

-- SIWE nonces — short-lived (~5min) one-time-use nonces for the SIWE flow.
-- Stored in D1 instead of KV so we get atomic delete-on-verify semantics.
CREATE TABLE IF NOT EXISTS siwe_nonces (
  nonce       TEXT PRIMARY KEY,
  issued_at   INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL                          -- unix ms (issued_at + 5min)
);

CREATE INDEX IF NOT EXISTS idx_siwe_nonces_expires
  ON siwe_nonces (expires_at);
