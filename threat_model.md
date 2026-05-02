# Threat Model

## Project Overview

DeFiScoring (`defiscoring.com`) is a two-tier system that produces an on-chain
credit score (300–850), portfolio risk heatmaps, AI risk profiles, and live
alerts for any Ethereum / EVM wallet.

- **Frontend**: a Jekyll static site served from Replit (dev) and Cloudflare
  Pages (prod). All UI is plain JS — no SPA framework. Sensitive state lives
  in HTTP-only cookies; nothing security-critical is held in `localStorage`.
- **Backend**: a single Cloudflare Worker (`worker/index.js`) bound to D1
  (`HEALTH_DB`), KV (`PROFILE_CACHE`, `DEFI_CACHE`), and Workers AI.
- **Identity**: Sign-In With Ethereum (EIP-4361). No passwords, no email
  signups. A user is created the first time a wallet completes SIWE.
- **Billing**: Stripe Checkout + Customer Portal (webhook-driven sync to a
  `subscriptions` table). Tiers: Free / Pro $15 / Plus $49 / Enterprise.
- **Notifications**: outbound email via the Gmail API (service account with
  domain-wide delegation) and outbound Telegram via a single bot token.
- **Sanctions**: every inbound wallet address is screened against an
  in-memory OFAC SDN deny-list (Tornado Cash et al.).

## Assets

- **Session cookies (`ds_session`)** — HMAC-signed (HMAC-SHA256, key
  `SESSION_HMAC_KEY`) bearer tokens granting full account access. Theft
  enables impersonation, alert tampering, billing portal access, wallet
  unlinking. The cookie value is `<sessionId>.<hmac>`; the row in
  `sessions` is the source of truth.
- **Linked wallet ownership claims** — each row in `wallet_connections`
  asserts that user X controls wallet Y, backed by a stored SIWE
  `signature` + `message_hash`. False entries here would let an attacker
  receive alerts and PDF reports on someone else's portfolio.
- **Subscription state** — `subscriptions.tier` is the single column read
  by every paid-feature gate. Tampering with it (or with the Stripe
  webhook flow) would unlock paid features for free.
- **Application secrets** — `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `SESSION_HMAC_KEY`, `IP_HASH_PEPPER`, `TURNSTILE_SECRET`,
  `GOOGLE_SA_PRIVATE_KEY`, `TELEGRAM_BOT_TOKEN`, `GMAIL_SENDER`. Stored as
  Cloudflare Worker env secrets and Replit Secrets in dev. Compromise of
  any of these is a critical incident.
- **D1 database (`HEALTH_DB`)** — full system of record: users, sessions,
  wallets, subscriptions, alert rules + channels + deliveries, score
  history, retention/audit data. SQL injection here is game over.
- **Workers AI quota** — paid resource. Unauthenticated burst use of
  `/api/audit`, `/api/risk-chatbot/*`, etc. would be a financial DoS.
- **Outbound delivery channels** — every email or Telegram message sent
  from `GMAIL_SENDER` and the bot has implicit trust to recipients. Abuse
  routes mail / Telegram spam through our domain and could damage sender
  reputation.

## Trust Boundaries

- **Browser ↔ Worker** — every call from JS in the static site crosses
  this boundary. The Worker authenticates (cookie), authorises (tier),
  rate-limits (per-IP + per-address), and screens (OFAC) on every
  protected route. The browser is untrusted.
- **Worker ↔ D1** — direct SQL via the prepared-statement API. Every
  query in the codebase MUST be parameterised; no string concatenation
  with user input is permitted.
- **Worker ↔ Stripe** — outbound calls signed with `STRIPE_SECRET_KEY`;
  inbound webhooks signed by Stripe and verified with
  `STRIPE_WEBHOOK_SECRET` (`worker/lib/stripe.js: verifyWebhook`).
- **Worker ↔ Gmail / Telegram** — outbound only. The service-account JWT
  for Gmail is minted per-call from `GOOGLE_SA_*`; the Telegram bot token
  is a long-lived secret. Neither service has a callback into the Worker
  yet (planned: Telegram webhook for `/score 0xabc` two-way commands).
- **Public ↔ Authenticated routes** — `/health`, `/api/portfolio`,
  `/api/defi`, `/api/nfts`, `/api/wallet-score`, `/api/health-score/*`,
  `/api/protocols`, `/api/recommendations`, `/badge/*` are public.
  Everything under `/api/auth/*`, `/api/wallets/*` (except `/link` POST
  body which requires SIWE proof), `/api/billing/*`, `/api/alerts/*`,
  `/api/account/*` requires a valid session cookie.
- **User ↔ Admin** — `users.is_admin = 1` (currently bootstrapped via
  `ADMIN_BOOTSTRAP_ADDRESS`). Admin-only paths live behind
  `requireAdmin()`. Regular sessions MUST NOT reach admin routes.

## Scan Anchors

- Production entry point: `worker/index.js` — single `dispatch()` switch.
- Auth + session lifecycle: `worker/lib/auth.js`,
  `worker/handlers/auth-siwe.js`.
- Tier gating + quota windows: `worker/lib/tiers.js`. All `requireTier`
  and `consumeQuota` callers should be re-audited after any limit change.
- Stripe webhook + secret-key surface: `worker/lib/stripe.js`,
  `worker/handlers/billing.js`.
- Outbound delivery (PII routing): `worker/lib/email.js`,
  `worker/lib/telegram.js`, `worker/handlers/cron.js` (the single
  fan-out point).
- Sanctions screening (deny-list): `worker/index.js` — `SANCTIONED_ADDRESSES`
  set + `isSanctioned()` and the `peekedAddrs.some(isSanctioned)` gate.
- Public unauthenticated endpoints (highest exposure surface):
  `/api/portfolio`, `/api/defi`, `/api/nfts`, `/api/wallet-score`,
  `/badge/*`, `/health`. All MUST stay rate-limited.
- Dev-only / not yet reachable in prod: anything under `_site/`,
  `attached_assets/`, `screenshots/` is build/output; ignore for security
  scans.

## Threat Categories

### Spoofing

The single sign-in path is SIWE. The Worker MUST refuse a session creation
if any of the following fail (`worker/lib/auth.js: verifySiwe`):

- Domain field in the signed message is not in the allow-list (env
  `ALLOWED_ORIGINS` plus the always-on `defiscoring.com`).
- `IssuedAt` is outside the rolling 5-minute nonce window (with a 60s
  clock-skew allowance).
- The nonce is not present in `siwe_nonces` (or has been consumed).
- The recovered address from the personal_sign signature does not match
  the `address` field of the signed message. Signature S-values are
  normalised to the low-half of the curve to defeat malleability replay.

After a session exists, every authed request MUST verify the cookie HMAC
in constant time (`verifySessionToken`) before the session row is loaded.
The session ID alone is never trusted.

Stripe webhooks MUST be verified with `verifyWebhook` against
`STRIPE_WEBHOOK_SECRET` and have a timestamp within 5 minutes of `now`.
The Worker MUST reject any `/api/webhooks/stripe` call that fails either.

The Telegram bot token is shared between every deployment. When the
two-way bot ships, the inbound webhook handler MUST verify Telegram's
`secret_token` header — the bot token alone is insufficient because
Telegram's API does not sign webhook payloads.

### Tampering

- Subscription tier MUST be derived only from the `subscriptions` row
  written by the Stripe webhook flow. The frontend's `auth.js` snapshot
  is for UI rendering only; every paid endpoint MUST re-check via
  `requireTier()` server-side.
- Wallet-link ownership MUST require a fresh SIWE signature from the
  wallet being added. The legacy `wallet_connections` upsert path in
  `findOrCreateUser()` writes `signature = ''` for the *primary* wallet
  only — that case is OK because the primary wallet's signature was just
  verified. Any future code path that inserts into `wallet_connections`
  MUST come via `handleWalletLink`, never an arbitrary `body.address`.
- Alert rules MUST verify the rule's `wallet_address` is linked to the
  acting user before insert (existing check in
  `worker/handlers/alerts.js: handleAlertRuleCreate`). Without this an
  attacker could set up alerts against arbitrary wallets and exfiltrate
  signal about activity on them.
- All D1 access is via prepared statements (`.prepare(...).bind(...)`).
  Any new query MUST follow the same pattern. String-concatenated SQL is
  forbidden.

### Repudiation

- `alert_deliveries` is the audit log for every triggered alert; rows
  are immutable once written and include `fired_at`, `status`, payload.
- A planned `audit_events` table (Sprint 2) will record session
  creation, wallet link/unlink, billing tier changes, and account
  deletion so a user can later reconcile what happened on their
  account.
- Stripe Dashboard is the second source of truth for billing; the
  worker writes `subscriptions.metadata` from each webhook so any future
  reconciliation script can replay history.

### Information Disclosure

- The `users` table stores `email` only when the user opts in to email
  alerts; we never store passwords, IPs, or User-Agent strings.
- `sessions.user_agent_hash` is HMAC-SHA256 of the UA, never the raw
  string. The HMAC key is `SESSION_HMAC_KEY` so an attacker who exfils
  the table cannot rainbow-table common UAs.
- IPs used in rate-limit keys are hashed with `IP_HASH_PEPPER` before
  being written to KV. The pepper rotation procedure is "delete the KV
  namespace and re-key the env var" — we accept a momentary rate-limit
  reset as the cost.
- Stripe customer IDs are stored but no card data ever touches our
  Worker; the customer portal handles all PCI scope.
- API error responses use stable, machine-readable error codes
  (`error: "wallet_owned_by_another_user"`) without leaking row IDs,
  internal stack traces, or other-user PII.
- `/badge/{addr}.svg` exposes whatever score is in `health_scores` for
  that address — by design, this is public information any wallet owner
  can opt into. The endpoint MUST NOT leak any other field (email,
  user_id, last login, etc.).
- The OFAC deny-list match returns a *generic* `403 Request blocked.`
  with no detail about why, so an attacker cannot probe membership of
  the list.

### Denial of Service

- Every public scan endpoint (`/api/portfolio`, `/api/defi`, `/api/nfts`,
  `/api/wallet-score`) has both a per-IP (30/min) and per-address
  (10/min) rate-limit applied before the handler runs.
- AI endpoints (`/api/audit`, `/api/risk-chatbot/*`) are quota-gated per
  user via `consumeQuota()` against `tier_quotas`. Quota windows are
  rolling, not calendar-aligned (see comment in `worker/lib/tiers.js`),
  so a user cannot burst across midnight.
- The Worker's KV-backed rate limiter MUST fail open (allow the request)
  on KV errors — same posture as the existing `rateLimit()` helpers — to
  avoid turning a KV outage into a total outage.
- Outbound calls (Etherscan, Alchemy, Moralis, CoinGecko, DeFiLlama)
  MUST have explicit timeouts and never be awaited unbounded.
- Stripe checkout creates a Stripe customer on first paid signup; we
  MUST enforce the `requireSession` middleware on `/api/billing/checkout`
  so anonymous traffic cannot drive Stripe customer creation.

### Elevation of Privilege

- Every authed handler MUST start with
  `const auth = await requireSession(request, env); if (auth instanceof Response) return auth;`
  A handler that forgets this is a critical bug.
- Every paid handler MUST then call
  `const sub = await requireTier(auth.user.id, "<tier>", env); if (sub instanceof Response) return sub;`
  before touching the privileged resource.
- IDOR is the highest-risk class here. Every query that reads or mutates
  per-user data MUST scope by `user_id = ?` (never trust an ID supplied
  in the URL or body alone). Existing handlers do this; new ones MUST
  follow the pattern.
- `users.is_admin = 1` is bootstrapped only via `ADMIN_BOOTSTRAP_ADDRESS`
  on first SIWE login. There is no "promote to admin" endpoint. Any
  future admin-grant path MUST require an existing admin's session.
- D1 access uses parameterised statements exclusively — there is no
  raw SQL execution path that takes user input.

## Key rotation procedures

These are the operationally-relevant procedures we MUST be able to
execute without downtime if a secret is exposed:

- **`SESSION_HMAC_KEY` compromise** — rotate the key in Cloudflare
  Worker secrets. All existing session cookies will fail HMAC
  verification on the next request and users will be re-prompted to SIWE.
  Acceptable: it forces a global re-login but no data is lost.
- **`STRIPE_SECRET_KEY` compromise** — roll the key in Stripe Dashboard,
  update the Worker secret, redeploy. In-flight checkout sessions
  continue to work because they're already created on Stripe's side.
- **`STRIPE_WEBHOOK_SECRET` compromise** — Stripe Dashboard → Webhooks →
  Roll secret. Update Worker secret + redeploy. Brief window where
  webhooks may be lost; Stripe retries with exponential backoff.
- **`TELEGRAM_BOT_TOKEN` compromise** — `/revoke` from BotFather, mint
  a new token, update secret. All linked Telegram channels remain valid
  (chat IDs are stable) but inbound webhook URL needs to be re-set with
  the new token.
- **`GOOGLE_SA_PRIVATE_KEY` compromise** — disable the key in Google
  Cloud IAM, mint a new one, update secret. Outbound mail pauses for
  the duration of the rotation.
- **`IP_HASH_PEPPER` rotation** — drop the rate-limit KV namespace and
  re-key. Acceptable momentary loss of rate-limit memory.
