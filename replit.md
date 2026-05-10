# DeFi Scoring (on Snowlake Jekyll base)

## Overview

DeFi Scoring (defiscoring.com) is a Jekyll-based static site providing on-chain
credit scoring (300–850), portfolio risk heatmaps, real-time alerts, and an
AI-powered risk profiler. Initial chain support: Ethereum, Arbitrum, Polygon
(plus 8 more EVM chains in the worker registry). The frontend is a Jekyll
static site; the backend is a single Cloudflare Worker.

## User Preferences

I prefer iterative development, focusing on delivering core features and
refining them. When making changes, prioritize security and privacy,
especially regarding user data and wallet information. I value clear and
concise explanations for any complex technical decisions or architectural
patterns. Before implementing major architectural changes or integrating new
third-party services, please ask for confirmation.

## System Architecture

- **Static site:** Jekyll 4.3.x, vanilla JS, Chart.js v4, selective Bootstrap 5.
- **Aesthetic tokens:** dark `#0a0a0a` background, cyan `#00f5ff`,
  purple `#a855f7`, gold `#facc15` — consistent glass + neon look across
  dashboards and components.
- **Wallet integration:** EIP-6963 multi-wallet discovery via a custom
  vanilla JS modal (`wallet-modal.js`) — no third-party wallet kit.
- **Authentication:** SIWE (EIP-4361) HMAC-signed cookie sessions
  (`worker/lib/auth.js`). User row created on first SIWE.
- **Data persistence:** Cloudflare D1 (`HEALTH_DB`) is the system of record;
  `localStorage` is a graceful offline fallback for read-only views.
- **Backend:** single Cloudflare Worker (`worker/index.js`) with modular
  handlers under `worker/handlers/` and shared helpers under `worker/lib/`.
- **Telemetry:** anonymized opt-in events (SHA256 + HMAC-rekey with
  `INTEL_SALT`) feed an admin Market Intelligence dashboard.

## External Dependencies

- **Static site generator:** Jekyll (Ruby gems `jekyll`, `jekyll-feed`,
  `jekyll-paginate-v2`, `jekyll-archives`, `kramdown-parser-gfm`, `rouge`,
  `webrick`).
- **Frontend libs:** Chart.js v4 (CDN), Bootstrap 5.
- **Data sources / APIs:** CoinGecko Pro/free, Alchemy (T1), Moralis (T2),
  Etherscan v2 multichain (T3 fallback), DeFiLlama, Reservoir, Snapshot.
- **Cloudflare:** D1 (database), Workers (backend), Pages (static hosting),
  KV (`PROFILE_CACHE`, `DEFI_CACHE`), Workers AI (LLM). R2 planned.
- **Payments / notifications:** Stripe Checkout + Customer Portal, Gmail API
  via Google service account, Telegram bot.
- **Tools:** Bundler, npm, Wrangler.
- **GitHub:** in-app issue reporting via `GITHUB_TOKEN`.

## Worker Module Layout (current)

Routes live in `worker/index.js`'s single `dispatch()` switch. New work goes
into modular files; the legacy monolithic blocks remain for backward compat.

- `worker/lib/chains.js` — registry for 11 EVM chains.
- `worker/lib/cache.js` — KV wrapper with in-memory fallback.
- `worker/lib/prices.js` — CoinGecko batched native-price calls.
- `worker/lib/providers.js` — `getNativeBalance`, `getErc20Balances`,
  `getFirstTxTimestamp`, `getTransactionCount`, `ethCall` with 3-tier
  fallback (Alchemy → Moralis → Etherscan v2).
- `worker/lib/defi-protocols.js` — per-chain registry of Aave V3 / Compound V3
  / Uni V3 NFT manager / yield-bearing ERC-20s.
- `worker/lib/defi.js` — Aave V3 / Compound V3 / Uni V3 LP readers.
- `worker/lib/nft.js` — collection fetcher (Alchemy → Moralis → Reservoir).
- `worker/lib/protocols-data.js` + `protocols.js` — bundled catalog +
  DeFiLlama TVL enrichment.
- `worker/lib/score.js` — multi-chain composite 300–850 score with 5
  pillars (loan_reliability, portfolio_health, liquidity_provision,
  governance, account_age).
- `worker/lib/recommendations.js` — score-band-aware ranker.
- `worker/lib/auth.js` — SIWE verify, session cookie HMAC, user upsert,
  `requireSession` / `optionalSession`.
- `worker/lib/admin.js` — `requireAdmin` (SIWE + `users.is_admin = 1`) and
  `auditLog` helper for `admin_audit_log`.
- `worker/lib/tiers.js` — `TIERS`, `requireTier`, `tierLimit`,
  `consumeQuota` (rolling-window quota counter).
- `worker/lib/email.js` — Gmail API via Google SA JWT (RS256, WebCrypto).
- `worker/lib/telegram.js` — Bot API `sendMessage` wrapper.
- `worker/lib/stripe.js` — REST client (no SDK), HMAC-SHA256 webhook verify,
  `createCheckoutSession`, `createPortalSession`, `cancelSubscription`,
  `createRefund`, `listInvoices`.
- `worker/lib/alerts.js` — pure-function rule evaluator.

Handlers under `worker/handlers/`:

- `portfolio.js`, `defi.js`, `nfts.js`, `wallet-score.js`,
  `recommendations.js`, `protocols.js` (T3–T5).
- `auth-siwe.js`, `wallets.js`, `billing.js`, `quota.js`, `badge.js`,
  `alerts.js` (T6–T8 user-facing).
- `cron.js` — `scanAlertRules` for the 5-min alerts cron.
- `admin/{users,subscriptions,alerts,leads,retention,audit}.js` — Stream B
  admin SPA backend (every endpoint SIWE-gated via `requireAdmin`,
  every mutation writes one row to `admin_audit_log`).

## Key endpoints

Public (rate-limited):
`/api/portfolio`, `/api/defi`, `/api/nfts`, `/api/wallet-score`,
`/api/recommendations`, `/api/protocols`, `/api/health-score/*`,
`/api/score/:protocol`, `/api/exposure`, `/api/audit`, `/api/gas`,
`/api/votes/:slug`, `/api/intel/event`, `/badge/{addr}.svg`, `/health`.

Authed (SIWE cookie):
`/api/auth/{nonce,verify,me,logout}`, `/api/wallets*`, `/api/billing/{config,checkout,portal}`,
`/api/alerts/{rules,channels,deliveries}`, `/api/quota`,
`/api/account/{export,delete}`.

Admin (SIWE cookie + `is_admin = 1`):
`/api/admin/{users,subscriptions,alerts/deliveries,leads,audit,retention/run}*`.

Admin (legacy `Bearer ADMIN_TOKEN`):
`/api/intel/{summary,export}`, `/api/account/retention/run`.

## Frontend layout

- `dashboard/` — main app. Sidebar driven by `_data/nav.yml` (5 sections:
  Overview, Risk, RWA, Audits, Settings). Topbar breadcrumb in
  `_includes/dashboard/wallet-bar.html`.
- `dashboard/settings.html` — combined wallets/billing/upgrade/account/
  privacy/sign-out hub.
- `pricing/` — 4-tier plan compare + Stripe Checkout entry.
- `account/` and `account/privacy/` — DSAR + privacy preferences.
- `admin/` — vanilla JS SPA at `/admin/`. Uses `/api/admin/*` and the
  existing SIWE cookie. Tabs: Users, Subscriptions, Alerts, Leads,
  Retention, Audit Log. Non-admin sees a 403 lockout card.
- `assets/js/` — eager: `auth.js`. Deferred per-page: `dashboard*.js`,
  `wallet-picker.js`, `onboarding.js`, `pricing.js`, `quota-widget.js`,
  `score-breakdown.js`, `admin.js`, etc.
- `assets/css/` — `dashboard.css` (sidebar/topbar/breadcrumb), `pricing.css`,
  `wallet-picker.css`, `onboarding.css`, `score-breakdown.css`, `admin.css`.

## Operational notes (deploy checklist)

After any worker change, run `wrangler deploy`. Stream B requires a D1
migration:

```
wrangler d1 execute HEALTH_DB --file migrations/0009_admin.sql
```

For dev/preview SIWE testing on Replit, the preview hostname must be in the
worker's `ALLOWED_ORIGINS` env var or sign-in returns `domain_mismatch`.
Production (`defiscoring.com`) is always in the allowlist.

Optional worker secrets that upgrade behavior when set: `ALCHEMY_KEY`,
`MORALIS_KEY`, `RESERVOIR_KEY`, `COINGECKO_KEY`, `STRIPE_*` (PRO/PLUS price
ids, secret key, webhook secret, publishable key), Google service account
keys (`GOOGLE_SA_*`), `GMAIL_SENDER`, `TELEGRAM_BOT_TOKEN`,
`SESSION_HMAC_KEY` (required), `IP_HASH_PEPPER`, `INTEL_SALT`,
`ADMIN_BOOTSTRAP_ADDRESS`, `ADMIN_TOKEN`, `TURNSTILE_SECRET`,
`DATA_RETENTION_DAYS` (default 180).

Cron triggers (`wrangler.jsonc`):
- `"17 3 * * *"` — daily 03:17 UTC: `runRetentionPrune`.
- `"*/5 * * * *"` — every 5 min: `scanAlertRules`.

Sprint 2/3 backlog lives in `.local/session_plan.md` when active. The full
threat model lives in `threat_model.md`.

---

## Changelog (sprint history)

Older sprint detail (T1 → T8 + P5) is preserved here as an appendix for
context. Anything load-bearing has been promoted into the sections above;
this section is reference-only.

### T1+T2+T3 (May 2026) — Modular portfolio scan
Introduced `worker/lib/{chains,cache,prices,providers}.js` and
`worker/handlers/portfolio.js` with 3-tier fallback (Alchemy → Moralis →
Etherscan v2). Returns both new shape (`address`, `fiat`, `portfolioFiat`,
`activeChains`, `chains[]`) and legacy shape (`wallet`, `total_value_usd`,
`positions[]`) for backward compat with `dashboard.js`. Fixed long-standing
$0-portfolio bug. Rate-limited 30/min/IP + 10/min/address.

### T4 — DeFi positions + NFT collections
Added `worker/lib/defi-protocols.js`, `defi.js`, `nft.js` and handlers
`defi.js`, `nfts.js`. Aave V3 collateral/debt/HF, Compound V3 markets,
Uni V3 LP NFT count; NFT collections via Alchemy → Moralis → Reservoir.
Capped at 50 collections/chain, cached 5min.

### T5 — Wallet score + recommendations + protocols catalog
Added `worker/lib/score.js` (5 pillars: loan_reliability 0.35,
portfolio_health 0.25, liquidity_provision 0.15, governance 0.10,
account_age 0.15; bonuses HF>2 and 3+ chains; penalties HF<1 and >80%
single position; clamped 300–850). `recommendations.js` ranks the catalog
by TVL+audits+profile-bucket weight × score-band tolerance.
`protocols.js` enriches with live DeFiLlama TVL (cached 1h).

### T6 + T6.5 — Auth, billing, alerts
Migrations `0006_auth_subscriptions.sql`, `0007_alerts.sql`. Added
`worker/lib/{auth,tiers,email,telegram,stripe,alerts}.js` and handlers
`auth-siwe.js`, `wallets.js`, `billing.js`, `alerts.js`, `cron.js`. SIWE
via `@noble/curves` + `@noble/hashes`. HMAC-signed `ds_session` cookie
(HttpOnly, Secure, SameSite=Lax). Stripe checkout/portal + webhook
(idempotent, 5-min replay window). Tier matrix: Free $0 / Pro $15 /
Plus $49 / Enterprise. Per-tier quotas in `tier_quotas`. Alerts cron
every 5min with email/telegram delivery + `alert_deliveries` audit log.

### T7 — Pricing + dashboard SPA + onboarding
Pages: `pricing/index.html` (4-tier compare + FAQ + CTA),
`dashboard/alerts.html` (CRUD UI). JS modules: `auth.js` (SIWE singleton),
`wallet-picker.js`, `dashboard-alerts.js`, `pricing.js`,
`billing-return.js`, `onboarding.js` (4-step modal + soft upgrade nudge),
`dashboard-home.js` updates for tier-clamped history. CSS:
`wallet-picker.css`, `onboarding.css`, `pricing.css`. No worker changes —
everything consumed pre-existing T6/T6.5 endpoints.

### T8 Sprint 1 — Quick wins
- **S1-A** P3 cleanup (BigInt path, stripe `stripeRequest` collapse,
  alerts `next_eligible_at`, tiers rolling-window comment).
- **S1-B** Public score badge SVG: `worker/handlers/badge.js`
  (`GET /badge/{0x..}.svg`, public, 5min edge cache) + `badge/index.html`
  embed page.
- **S1-C** Address book labels + tags: migration `0008_address_book.sql`
  (added `tags TEXT` to `wallet_connections`) + `PATCH /api/wallets/{addr}`
  + rename pencil in wallet picker.
- **S1-D** Score breakdown explainability modal: `score-breakdown.js` +
  `score-breakdown.css`. `dashboard-score.js drawFactors` emits
  `data-factor-*` attrs and HTML-escapes every factor field.
- **S1-E** Quota observability: `worker/handlers/quota.js`
  (`GET /api/quota`) + `quota-widget.js` topbar mount.
- **S1-F** `threat_model.md` (STRIDE-style, root).

### P5 — Multi-fiat dropdown
User-selectable display currency (USD/EUR/GBP/CHF/JPY/AUD/CAD). Worker
already accepts `?fiat=<ISO4217>` and asks CoinGecko to quote in that
currency directly — no client-side FX. Files: `assets/js/fiat-pref.js`
(new) + `_includes/dashboard/wallet-bar.html` mount slot +
`dashboard-home.js` + `dashboard-portfolio.js` listeners. Not yet
currency-aware: `market-strip.js`, `rwa-asset-score.js`,
`portfolio-rwa-exposure.js`, `data-aggregation.js`,
`issuer-due-diligence.js`, `dashboard-risk.js` (still hardcode `$`).
Deferred: D1 sync of preference (migration 0009 was reused for admin
work; if D1 sync ships later it'll be `migrations/0010_user_prefs.sql`).

### Stream A (May 2026) — Dashboard regroup
Rewrote `_data/nav.yml` into 5 sections (Overview / Risk / RWA / Audits /
Settings) without changing any URLs. Added Liquid breadcrumb in
`_includes/dashboard/wallet-bar.html` + CSS. New combined
`dashboard/settings.html` (6-card grid for wallets/billing/upgrade/
account/privacy/signout).

### Stream B (May 2026) — Admin SPA at /admin/
Migration `0009_admin.sql` adds `admin_audit_log`, `admin_notes`, and
`users.suspended_at`. New `worker/lib/admin.js` (`requireAdmin` +
`auditLog`). New `worker/lib/stripe.js` helpers (`cancelSubscription`,
`createRefund`, `listInvoices`). Six handler modules under
`worker/handlers/admin/` and 14 dispatch entries in `worker/index.js`.
Vanilla JS SPA at `admin/index.html` + `assets/css/admin.css` +
`assets/js/admin.js` (no Vite/React build pipeline introduced — matches
the rest of the codebase). Tabs: Users, Subscriptions, Alerts, Leads,
Retention, Audit Log. Non-admins see a 403 lockout card.
