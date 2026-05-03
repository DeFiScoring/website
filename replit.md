# DeFi Scoring (on Snowlake Jekyll base)

## Overview

DeFi Scoring (defiscoring.com) is a Jekyll-based static site providing on-chain credit scoring (300–850), portfolio risk heatmaps, real-time alerts, and an AI-powered risk profiler. The project aims to offer comprehensive DeFi risk assessment. Initial support covers Ethereum, Arbitrum, and Polygon. The project leverages a Jekyll static site for the frontend and Cloudflare Workers for the backend infrastructure.

## User Preferences

I prefer iterative development, focusing on delivering core features and refining them. When making changes, prioritize security and privacy, especially regarding user data and wallet information. I value clear and concise explanations for any complex technical decisions or architectural patterns. Before implementing major architectural changes or integrating new third-party services, please ask for confirmation.

## System Architecture

The project uses Jekyll 4.3.x for static site generation, with a frontend built using Vanilla JS, Chart.js v4, and Bootstrap 5 (selectively). UI/UX maintains a dark aesthetic with a specific palette (`#0a0a0a` background, cyan `#00f5ff`, purple `#a855f7`, gold `#facc15`) for a consistent glass + neon look across dashboards and components.

**Key Technical Implementations:**

-   **Wallet Integration:** EIP-6963 multi-wallet discovery with a custom vanilla JS modal (`wallet-modal.js`) for a lightweight, dependency-free solution.
-   **Data Persistence:** Cloudflare D1 (`HEALTH_DB`) for `health_scores` and `watchlists`, with `localStorage` providing a graceful offline fallback.
-   **Authentication:** Address-keyed identity (wallet = identity) for MVP, with plans for SIWE (Sign-In-With-Ethereum) for production.
-   **Backend:** Primarily Cloudflare Workers for APIs, with future plans to utilize Workers AI (LLM), KV (cache), and R2 (assets). A single unified worker handles all API routes.
-   **Market Intelligence Hub:** Anonymized, opt-in telemetry for an admin dashboard. Wallet addresses are SHA256-hashed and re-keyed with HMAC-SHA256 using `INTEL_SALT` for privacy.

**Core Features:**

-   **Dashboard:** Provides an overview of scores, portfolio value, positions, alerts, and 12-month trends.
-   **My Score:** Detailed breakdown of the user's credit score.
-   **Portfolio Heatmap:** Visual representation of portfolio risk.
-   **Risk Profiler:** Allows users to set target profiles and receive AI-powered recommendations.
-   **Alerts:** Rule builder for custom alerts and a view of recent triggers.

## External Dependencies

-   **Static Site Generator:** Jekyll (Ruby Gems: `jekyll`, `jekyll-feed`, `jekyll-paginate-v2`, `jekyll-archives`, `kramdown-parser-gfm`, `rouge`, `webrick`).
-   **Frontend Libraries:** Chart.js v4 (CDN), Bootstrap 5.
-   **Data Sources/APIs:**
    -   CoinGecko Pro/free API (for price data).
    -   Alchemy (Tier-1 provider for on-chain data).
    -   Moralis (Tier-2 fallback for on-chain data).
    -   Etherscan v2 (Multichain fallback for on-chain data).
-   **Cloudflare Services:**
    -   Cloudflare D1 (database).
    -   Cloudflare Workers (backend API).
    -   Cloudflare Pages (static site hosting).
    -   Cloudflare KV (cache, planned).
    -   Cloudflare R2 (assets, planned).
    -   Cloudflare Workers AI (LLM, planned).
-   **Development/Deployment Tools:**
    -   Bundler (Ruby package manager).
    -   npm (Node.js package manager).
    -   Wrangler (Cloudflare Workers CLI).
-   **GitHub:** Used for issue reporting via `GITHUB_TOKEN`.

## Worker Module Layout (T1+T2+T3 — May 2026)

The monolithic `worker/index.js` was kept intact for backward compat, but new
work goes into a modular layout under `worker/lib/` and `worker/handlers/`:

-   `worker/lib/chains.js` — single-source-of-truth registry for the 11 EVM
    chains (ethereum, optimism, arbitrum, base, polygon, bnb, avalanche,
    gnosis, linea, scroll, zksync). Adding a chain here flows through every
    other module with no further edits.
-   `worker/lib/cache.js` — KV wrapper (reuses `DEFI_CACHE` binding) with
    in-memory fallback so modules work in `wrangler dev` without extra config.
-   `worker/lib/prices.js` — CoinGecko Pro/free with batched native-price
    calls (one HTTP per portfolio scan, not 11) and SHA-256-truncated cache
    keys.
-   `worker/lib/providers.js` — unified `getNativeBalance`,
    `getErc20Balances`, `getFirstTxTimestamp`, `getTransactionCount` with a
    3-tier fallback: Alchemy → Moralis → Etherscan v2 multichain. Caps at
    100 ERC-20s/chain (Alchemy/Moralis) or 50 candidates/chain (Etherscan
    tokentx) to bound CPU on dust-airdropped wallets.
-   `worker/handlers/portfolio.js` — `GET /api/portfolio?wallet=&fiat=
    &chains=&tier=`. Parallel per-chain scan; per-chain failures isolated
    (returned as `{ error }` on the chain row, never bubble out as a 500).
    Returns BOTH a new shape (`address`, `fiat`, `portfolioFiat`,
    `activeChains`, `chains[]`) AND the legacy shape (`wallet`,
    `total_value_usd`, `positions[]`) so the existing `dashboard.js` keeps
    working unchanged. Fixes the long-standing $0-portfolio bug.
-   Route is rate-limited at 30 req/min/IP + 10 req/min/address (using the
    existing `rateLimit()` and `rateLimitByAddress()` helpers in `index.js`).

Optional Cloudflare Worker secrets that upgrade `/api/portfolio` when set
(falls back to Etherscan v2 + free CoinGecko if absent):
`ALCHEMY_KEY`, `MORALIS_KEY`, `COINGECKO_KEY`. Set with
`wrangler secret put <NAME>`.

## Worker Module Layout (T4 — May 2026)

T4 added DeFi position reading and NFT collection reading in the same modular
pattern. Both endpoints share the provider layer with T3 and isolate per-chain
failures (one chain timing out never produces a 500).

-   `worker/lib/defi-protocols.js` — per-chain registry of Aave V3 Pool
    addresses, Compound V3 (Comet) market addresses, the Uniswap V3
    NonfungiblePositionManager, and yield-bearing ERC-20s
    (stETH/wstETH/rETH/sfrxETH/cbETH/swETH/mETH/sDAI). Adding a protocol or
    chain only requires editing this file.
-   `worker/lib/defi.js` — readers for Aave V3 (`getUserAccountData` decodes
    collateral, debt, healthFactor in 8-decimal base units), Compound V3
    (`balanceOf` + `borrowBalanceOf` on each market), and Uni V3 LP NFT count
    (`balanceOf` on the position manager). Plus `classifyYieldTokens()` which
    re-tags ERC-20s already returned by the portfolio scan as DeFi positions
    (no extra RPC calls).
-   `worker/lib/nft.js` — collection fetcher with 3-tier fallback: Alchemy
    (`getContractsForOwner`) → Moralis (`/nft/collections`) → Reservoir
    (keyless `/users/.../collections/v3`, supports 9 EVM chains). Capped at
    50 collections/chain, cached 5 min.
-   `worker/lib/providers.js` — extended with `ethCall(chain, env, to, data)`
    (Alchemy → Etherscan v2 fallback) plus ABI helpers `abiPadAddr`,
    `abiHexWord`, `abiEncodeSingleAddr`.
-   `worker/handlers/defi.js` — `GET /api/defi?wallet=&chains=&fiat=&tier=`.
    Aggregates totalCollateralUsd, totalDebtUsd, totalNetUsd, and
    healthSummary (lowest HF + risk band: liquidatable/risky/caution/safe).
-   `worker/handlers/nfts.js` — `GET /api/nfts?wallet=&chains=&tier=`.
    Aggregates totalCollections, totalNfts, totalFloorEth.
-   Both routes wired in `worker/index.js` with the same rate-limiter
    posture as `/api/portfolio` (30 req/min/IP + 10 req/min/address).

Optional secrets that upgrade T4 endpoints when set (none required):
`ALCHEMY_KEY` (faster eth_call + best NFT metadata), `MORALIS_KEY`
(NFT fallback), `RESERVOIR_KEY` (higher rate limit on NFT free tier).

## Worker Module Layout (T5 — May 2026)

T5 added the multi-chain composite wallet score (300–850), score-band-aware
protocol recommendations, and an enriched protocols catalog. All three new
endpoints compose T3 + T4 outputs without duplicating their fetchers, and
the legacy `POST /api/health-score` (Eth-only, used by `dashboard.js` and
`health-score.js`) is left COMPLETELY UNTOUCHED for backward compat.

-   `worker/lib/protocols-data.js` — bundled mirror of `_data/protocols.yml`
    + `_data/risk_profiles.yml`. Avoids cross-origin fetches back to the
    Jekyll site (which would create a circular dep). Indexed lookups by
    slug and by lowercased contract address.
-   `worker/lib/protocols.js` — catalog enrichment with live DeFiLlama TVL,
    audits, links. Cached 1h. Best-effort: catalog returns even if
    DeFiLlama is down.
-   `worker/lib/score.js` — multi-chain wallet score with 5 named pillars:
    `loan_reliability` (0.35, Aave HF across all chains),
    `portfolio_health` (0.25, diversification + size + multichain bonus),
    `liquidity_provision` (0.15, Uni V3 LP NFT count),
    `governance` (0.10, Snapshot vote count),
    `account_age` (0.15, Eth first-tx age). Each pillar tagged
    `real: true/false`; `false` means "data unavailable, neutral 50 used".
    Bonuses: +50 (HF>2), +30 (3+ chains). Penalties: −150 (HF<1),
    −50 (>80% in single position). Clamped to 300–850.
-   `worker/lib/recommendations.js` — ranks the catalog by TVL + audits +
    profile-bucket weight × score-band tolerance, minus a concentration
    penalty. Conservative profile excludes derivatives entirely; degen
    keeps the full menu.
-   `worker/handlers/wallet-score.js` — `GET /api/wallet-score?wallet=&fiat=`.
    Internally fans out to `handlePortfolio` + `getAllDeFiPositions` in
    parallel, then to Snapshot + Etherscan first-tx for the gov/age pillars.
-   `worker/handlers/recommendations.js` — `GET /api/recommendations?wallet=
    &profile=&band=&limit=`. If `wallet` is provided and `band` isn't,
    derives the band from `/api/wallet-score` internally.
-   `worker/handlers/protocols.js` — `GET /api/protocols` (full enriched
    catalog) or `?slug=X` (single protocol).
-   All three routes wired in `worker/index.js` with the same rate-limit
    posture as the T3/T4 endpoints (30/min/IP + 10/min/address on the
    wallet-scoped ones; 60/min/IP on `/api/protocols` since it's catalog-only).

Existing endpoints `POST /api/health-score`, `GET /api/score/:protocol`,
`POST /api/exposure` — all unchanged.

## Worker Module Layout (T6 + T6.5 — May 2026)

T6 + T6.5 ship the paywall + alerts in one sprint. The dashboard becomes a
real product (sign-in, tiers, recurring revenue, server-side notifications)
without breaking any existing T1–T5 endpoint for anonymous callers.

**Pricing (USD/month):** Free $0 / Pro $15 / Plus $49 / Enterprise custom.
Tier matrix and per-tier quotas live in `worker/lib/tiers.js`.

### New schema (`migrations/0006_auth_subscriptions.sql`, `0007_alerts.sql`)
- `users`, `sessions`, `wallet_connections`, `subscriptions`, `tier_quotas`,
  `siwe_nonces` — auth + billing state.
- `alert_rules`, `alert_channels`, `alert_deliveries` — alerts state +
  audit trail (used for dedupe and the user-facing "recent triggers" view).

### New worker libs (`worker/lib/`)
- `auth.js` — SIWE (EIP-4361) verify via `@noble/curves/secp256k1` +
  `@noble/hashes/sha3` (audited, ~14kB). HMAC-SHA256-signed `ds_session`
  cookie (HttpOnly, Secure, SameSite=Lax). Exports `requireSession()`
  and `optionalSession()` — the latter is what enables free vs. signed-in
  branches on otherwise-public endpoints.
- `tiers.js` — `TIERS` constant, `requireTier(userId, minTier, env)`,
  `tierLimit(tier, key)`, `consumeQuota()` (atomic check-and-increment
  in `tier_quotas`). One source of truth for entitlements.
- `email.js` — Gmail API send via Google service-account JWT (RS256,
  signed with `WebCrypto.subtle`, exchanged for an OAuth bearer token,
  token cached in `PROFILE_CACHE` for 50min). Impersonates `GMAIL_SENDER`.
- `telegram.js` — Bot API `sendMessage` wrapper. No-op + clear log when
  `TELEGRAM_BOT_TOKEN` is missing.
- `stripe.js` — REST client (no SDK), HMAC-SHA256 webhook signature verify
  with 5-min replay window. Wraps `checkout.sessions.create`,
  `billing_portal.sessions.create`, `customers.create`, `subscriptions.retrieve`.
- `alerts.js` — pure-function rule evaluator. Supports `health_factor.lt`,
  `score.lt`, `score.gt`, `price.lt`, `price.gt`, `approval.changed`. No
  I/O — takes wallet-state snapshots in, emits delivery intents out.

### New handlers (`worker/handlers/`)
- `auth-siwe.js`  — `GET /api/auth/{nonce,me}`, `POST /api/auth/{verify,logout}`.
- `wallets.js`    — `GET /api/wallets`, `POST /api/wallets/link`,
                    `DELETE /api/wallets/{address}`. Each link requires a
                    fresh SIWE signature *from the wallet being added*.
- `billing.js`    — `GET /api/billing/config`, `POST /api/billing/{checkout,portal}`,
                    `POST /api/webhooks/stripe`. Webhook is idempotent
                    (dedupes on `stripe_evt:<id>` rows in `siwe_nonces`).
- `alerts.js`     — CRUD on `/api/alerts/{rules,channels,deliveries}`.
                    Pro+ required to create rules; Plus required for
                    Telegram channels.
- `cron.js`       — `scanAlertRules(env, ctx)`. Paginates active rules,
                    pulls live wallet state via the T1–T5 endpoints,
                    evaluates, and dispatches deliveries through `email.js`
                    + `telegram.js`. Per-rule failures isolated.

### Wiring (`worker/index.js`)
- Imports the 5 handler modules + `optionalSession` + `getSubscription` +
  `tierLimit`.
- `corsHeadersFor()` now sets `Access-Control-Allow-Credentials: true`
  whenever it echoes a specific origin (required for cookie auth — the
  browser refuses to honor credentials together with `Origin: *`).
- `scheduled()` dispatches by `event.cron`:
    - `"17 3 * * *"` → `runRetentionPrune()` (Phase 4, unchanged)
    - `"*/5 * * * *"` → `scanAlertRules()` (T6 alerts)
- Routes added below the watchlist block: auth, wallets, billing,
  alerts. Webhook `POST /api/webhooks/stripe` is unauthenticated by
  design (Stripe signs the body).
- `handleHealthHistory()` now reads the caller's session via
  `optionalSession` and clamps `?limit=` to the tier's `history.days`
  (free=7, pro=30, plus=365, enterprise=∞). Anonymous callers stay on
  the 7-day free window — no breaking change for the existing dashboard.

### `wrangler.jsonc`
- `triggers.crons` now `["17 3 * * *", "*/5 * * * *"]`.
- All new secrets documented inline (Stripe price IDs, Gmail SA, Telegram
  token, session HMAC key, Turnstile + WC keys for T7).

### Graceful degradation
Every handler that depends on a not-yet-provisioned secret returns a clear
`503 { error: "service_not_configured", missing: "STRIPE_SECRET_KEY" }`
instead of crashing. So the build passes and unrelated endpoints keep
working while the operator (you) provisions Stripe / Gmail / Telegram.

### npm dependencies
- `@noble/curves` ^1.x — secp256k1 SIWE verify
- `@noble/hashes` ^1.x — keccak256, hmac-sha256

Both are pure ESM, dependency-free, and routinely audited.

## T7 — Pricing + Dashboard SPA + Onboarding (May 2026)

T7 turns the site into a self-serve product: visitors can compare plans, pay
on Stripe, sign in with their wallet, link multiple wallets, configure real
alerts against the worker API, and walk through a guided first-run flow.

### New pages
- `pricing/index.html` — 4-tier comparison (Free / Pro $15 / Plus $49 /
  Enterprise) + FAQ + CTA band. Buttons hit `POST /api/billing/checkout
  { tier }` and redirect to Stripe; the user's current plan is shown as a
  badge from `/api/auth/me`. The "Manage subscription" link routes to
  `/api/billing/portal`.
- `dashboard/alerts.html` — full CRUD UI for delivery channels (email,
  Telegram), alert rules, and a recent triggers audit log. Free-tier
  visitors see a paywall card; signed-out visitors see a sign-in
  required state.

### New JS modules (all under `assets/js/`)
- `auth.js` — `window.DefiAuth` singleton. Methods: `init`, `refresh`,
  `signIn`, `signOut`, `linkWallet`, `unlinkWallet`, `listWallets`,
  `subscribe(cb)`. Builds EIP-4361 SIWE messages client-side, signs via
  `personal_sign`, calls `/api/auth/{nonce,verify,me,logout}`. Truth lives
  in the `ds_session` cookie; nothing sensitive in localStorage.
- `wallet-picker.js` — drives the dashboard wallet bar: tier pill,
  connection state, dropdown of linked wallets, add/unlink, sign in/out,
  cross-page toast helper. Syncs the active wallet back to the legacy
  `window.DefiState.setWallet()` so existing dashboard widgets re-render
  on wallet switch.
- `dashboard-alerts.js` — full CRUD against `/api/alerts/{rules,channels,
  deliveries}`; tier-aware (paywall for free).
- `pricing.js` — checkout button wiring + current-plan badge.
- `billing-return.js` — loaded on every dashboard page; toasts post-
  Stripe `?billing=success&tier=X` and cleans the URL.
- `onboarding.js` — 4-step modal (welcome → first scan with confetti →
  HF<1.3 alert → upsell) gated on `defi_onboarding_state` localStorage.
  Also renders a soft upgrade nudge above the dashboard topbar after the
  Nth (=5) free-tier scan, dismissible with a 7-day re-arm.
- `dashboard-home.js` (modified) — fetches `/api/health-score/{wallet}/
  history?days=365` so the worker clamps to the tier cap, then renders
  the trend chart with `computed_at`-based date labels and a "Showing N
  days · Upgrade for full 30-day history" upsell note for free users.

### New CSS
- `assets/css/wallet-picker.css` — dropdown, tier pill, toast, channel
  verification overlay.
- `assets/css/onboarding.css` — modal, progress bar, score display,
  confetti canvas, soft nudge banner.
- `assets/css/pricing.css` — `.pr-*` scoped, reuses landing tokens.

### Layout/include changes
- `_layouts/dashboard.html` — added wallet-picker + onboarding CSS, and
  `auth.js` (eager) + `wallet-picker.js` + `onboarding.js` (deferred).
- `_includes/dashboard/wallet-bar.html` — added picker dropdown markup
  + tier pill.
- `_data/nav.yml` — added "Upgrade plan" sidebar item.
- `_layouts/default.html` — added "Pricing" link to landing nav.
- `assets/js/dashboard.js` — exposed `setWallet` on `window.DefiState`
  so the picker can switch the active wallet without reloading.

### Worker contracts consumed (no worker code changes for T7)
- `GET  /api/auth/{nonce,me}` · `POST /api/auth/{verify,logout}`
- `GET  /api/wallets` · `POST /api/wallets/link` · `DELETE /api/wallets/{addr}`
- `GET/POST/PUT/DELETE /api/alerts/rules` and `/channels`
- `POST /api/alerts/channels/{id}/verify` · `GET /api/alerts/deliveries`
- `GET  /api/health-score/{wallet}/history?days=`
- `POST /api/billing/checkout` · `POST /api/billing/portal`

### Operational notes
- Worker is **not yet redeployed** for T7 (no worker code changed, but
  `wrangler deploy` should be run anyway so the production worker has the
  latest of T6+T6.5). All new front-end calls hit endpoints that already
  exist in `worker/index.js`.
- For dev/preview SIWE testing on Replit, the preview hostname must be
  added to the worker's `ALLOWED_ORIGINS` env var or sign-in returns
  `domain_mismatch`. Production (`defiscoring.com`) is always in the
  allowlist.

## T8 — Sprint 1 (this session)

Six quick-win items shipped on top of T7:

- **S1-A** — P3 cleanup: `worker/lib/auth.js` Y2106 BigInt-only path,
  `worker/lib/stripe.js` checkout collapsed into `stripeRequest` with
  rationale comment, `worker/handlers/alerts.js` `deserializeRule` now
  emits `next_eligible_at` + `is_cooling_down`, `worker/lib/tiers.js`
  rolling-window comment.
- **S1-B** — Public score badge SVG. New
  `worker/handlers/badge.js` (`GET /badge/{0x..}.svg`, public, 5min
  edge cache, sources from `health_scores`). New `badge/index.html`
  embed-your-score page with markdown/HTML/BBCode snippet copying.
- **S1-C** — Address book labels + tags. `migrations/0008_address_book.sql`
  adds `tags TEXT` to `wallet_connections`. New
  `handleWalletUpdate` in `worker/handlers/wallets.js`
  (`PATCH /api/wallets/{addr}` body `{label, tags}`). Wallet picker UI
  gains a rename pencil button.
- **S1-D** — Score breakdown explainability modal. New
  `assets/js/score-breakdown.js` + `assets/css/score-breakdown.css`.
  `dashboard-score.js` `drawFactors` emits `data-factor-*` attrs and
  HTML-escapes every factor field. Conditionally loaded on
  `/dashboard/score/`.
- **S1-E** — Quota observability. New `worker/handlers/quota.js`
  (`GET /api/quota` returns flat `{tier, quotas:{key:{used, limit,
  remaining, reset_at}}}` for both rolling-window and cardinality
  keys). New `assets/js/quota-widget.js` shows AI-explain remaining in
  the topbar. Mount in `_includes/dashboard/wallet-bar.html`.
- **S1-F** — `threat_model.md` (root). STRIDE-style document covering
  SIWE replay, session theft, Stripe webhook forgery, Telegram bot
  impersonation, OFAC bypass, rate-limit evasion, and key rotation
  procedures.

### Operational notes (T8 deltas)

- Worker has **new routes** that need `wrangler deploy`:
  - `GET /badge/{0x..}.svg` (public)
  - `GET /api/quota` (auth required)
  - `PATCH /api/wallets/{addr}` (auth required)
- D1 migration to apply after deploy:
  `wrangler d1 execute HEALTH_DB --file migrations/0008_address_book.sql`

### P5 — Multi-fiat dropdown (May 2026)

User-selectable display currency (USD/EUR/GBP/CHF/JPY/AUD/CAD).
Worker side already accepts `?fiat=<ISO4217>` and asks CoinGecko to quote
in that currency directly — no client-side FX is performed.

- `assets/js/fiat-pref.js` (new) — renders a `<select>` into the
  `#defi-fiat-pref` slot, persists choice in `localStorage["defi.fiat"]`,
  dispatches `document` event `defi:fiat-changed` with `{ fiat }` detail.
  Exposes `window.DefiFiat.get()` / `set(code)` for programmatic use.
- `_includes/dashboard/wallet-bar.html` — added the mount slot.
- `_layouts/dashboard.html` — registered the script with cache-busting.
- `assets/js/dashboard-home.js` — listens for `defi:fiat-changed` and
  re-fetches portfolio in the new currency.
- `assets/js/dashboard-portfolio.js` — replaced `fmtUsd` with
  `fmtFiat`, also subscribes to `defi:fiat-changed`.

**Not yet currency-aware** (still hardcode `$` — out of P5 scope, follow up
when those modules get next touch): `assets/js/market-strip.js`,
`assets/js/rwa-asset-score.js`, `assets/js/portfolio-rwa-exposure.js`,
`assets/js/data-aggregation.js`, `assets/js/issuer-due-diligence.js`,
`assets/js/dashboard-risk.js`. They will display dollar-denominated
numbers regardless of the selected currency.

**Deferred:** D1 sync of the preference (migration 0009 + new
`user.preferred_fiat` column). LocalStorage already meets the acceptance
criterion; D1 sync only matters for cross-device persistence and can ship
when there's other migration work.

### Sprint 2 / 3 backlog

See `.local/session_plan.md` for the full Sprint 2 (status page, OFAC API,
audit log, webhook delivery, PDF report) and Sprint 3 follow-ups
(multi-chain audit, Telegram two-way bot, leaderboard, Discord bot, twin
search, backfill, e2e suite).