# Secrets registry — DeFi Scoring

This document is the **single source of truth** for every secret the
Cloudflare Worker (`worker/index.js`) needs. The Worker is the only
runtime that reads secrets; the Jekyll site is fully static and reads
nothing from `process.env`. Secrets are never committed to source.

## Audit status (last reviewed: 2026-05-03)

A full repository scan confirmed:

- ✅ No `.env` files committed (and none ever existed in `git log`).
- ✅ No `sk_live_*`, `sk_test_*`, `pk_live_*`, `whsec_*`, `ghp_*`,
  `xoxb-*`, `AIza*`, `eyJ*` JWT, or PEM private-key literals anywhere
  in tracked source, configs, frontend, `_site/` build output, or
  `attached_assets/`.
- ✅ Every secret is read via `env.X` (e.g. `env.STRIPE_SECRET_KEY`)
  inside the Worker. No fallback string literals.
- ✅ No GitHub Actions workflows exist (`.github/` directory absent),
  so no GHA secret references to audit.
- ✅ Frontend reads only **public** values: `STRIPE_PUBLISHABLE_KEY`
  arrives via `GET /api/billing/config` (server-side injected at
  request time, never bundled). `WC_PROJECT_ID` and
  `TURNSTILE_SITE_KEY` are not yet wired to the frontend; when they
  are, they must be served the same way (via a Worker endpoint), not
  baked into the Jekyll build.
- ✅ `dashboard/market-intel.html` accepts `ADMIN_TOKEN` as a
  user-typed password (stored in `localStorage` only on that device).
  No embedded value.
- ✅ Hardcoded URLs (`defiscoring.com`, `*.workers.dev`) are domain
  identifiers, not secrets.

**No rotation required.** Nothing is exposed.

## Secret categories

### 1. Server-side secrets (Cloudflare Worker only)

These MUST be set as Cloudflare Worker secrets (`wrangler secret put`).
They are never sent to the browser.

| Name | Purpose | Format |
|---|---|---|
| `STRIPE_SECRET_KEY` | Stripe API auth for `/api/billing/*` | `sk_live_…` (prod) / `sk_test_…` (staging) |
| `STRIPE_WEBHOOK_SECRET` | Verify Stripe webhook HMAC at `/api/webhooks/stripe` | `whsec_…` |
| `STRIPE_PRICE_ID_PRO` | Stripe Price ID — Pro plan ($15/mo) | `price_…` |
| `STRIPE_PRICE_ID_PLUS` | Stripe Price ID — Plus plan ($49/mo) | `price_…` |
| `SESSION_HMAC_KEY` | HMAC-SHA256 key signing `ds_session` cookies | 32+ random hex chars |
| `IP_HASH_PEPPER` | HMAC pepper for IP-derived rate-limit keys | 32+ random hex chars |
| `INTEL_SALT` | HMAC pepper for hashed wallets in `/api/intel/event` and DSAR exports | 32+ random hex chars |
| `ADMIN_TOKEN` | Bearer token for `/api/intel/{summary,export}` and `/api/account/retention/run` | 32+ random chars |
| `GITHUB_TOKEN` | Classic PAT, `repo` scope, for `/api/report-issue` | `ghp_…` |
| `ALCHEMY_KEY` | Token discovery + RPC fallback (Tier 1 in providers.js) | 32 chars |
| `ETHERSCAN_API_KEY` | Etherscan v2 multichain (native balance, tx history, fallback erc20) | 34 chars |
| `MORALIS_KEY` | Tier 2 token-balance fallback (optional) | JWT-ish |
| `RESERVOIR_KEY` | NFT metadata enrichment (optional) | UUID |
| `COINGECKO_KEY` | Pro pricing tier (optional; free tier works without) | CG-… |
| `GOOGLE_SA_EMAIL` | Gmail SA email for outbound alerts | `*@*.iam.gserviceaccount.com` |
| `GOOGLE_SA_PRIVATE_KEY` | PEM PKCS#8 RSA key (Gmail send domain-wide delegation) | `-----BEGIN PRIVATE KEY-----…` |
| `GMAIL_SENDER` | Workspace user the SA impersonates | `alerts@defiscoring.com` |
| `TELEGRAM_BOT_TOKEN` | BotFather token for `/api/alerts` Telegram delivery | `<botid>:<hash>` |
| `TURNSTILE_SECRET` | Cloudflare Turnstile server-side verify | `0x…` |
| `OFAC_LIST_URL` | Pre-signed URL for the OFAC SDN snapshot | `https://…` |
| `ETH_RPC_URL` | Ethereum RPC fallback | `https://…` (currently public node, but treat as secret) |

### 2. Public values (still set via `wrangler secret put`)

These end up in browser code via Worker-served config endpoints. They
are not sensitive but **must not be hardcoded** so they can rotate
without a frontend rebuild.

| Name | Delivered to frontend via | Format |
|---|---|---|
| `STRIPE_PUBLISHABLE_KEY` | `GET /api/billing/config` | `pk_live_…` / `pk_test_…` |
| `WC_PROJECT_ID` | (TODO when WalletConnect ships) `GET /api/wallet/config` | UUID |
| `TURNSTILE_SITE_KEY` | (TODO) Same | `0x…` |

### 3. Non-secret config (`vars` block in `wrangler.jsonc`, public)

Visible in the deployed bundle. Not secret.

| Name | Purpose |
|---|---|
| `ADMIN_BOOTSTRAP_ADDRESS` | Wallet that auto-grants `admin` role on first SIWE login |
| `ALLOWED_ORIGINS` | CORS allow-list (comma-separated) |
| `DSAR_CONTACT_EMAIL` | Email shown on the privacy page |
| `DATA_RETENTION_DAYS` | Days before retention prune deletes audit rows |
| `*_CACHE_TTL_SECONDS` | KV cache TTLs (audit, score, exposure, health, profile) |
| `PROTOCOL_CATALOG_URL` | Public protocol catalog JSON URL |
| `SNAPSHOT_API_URL` | Snapshot.org GraphQL endpoint |
| `GITHUB_REPO_OWNER`, `GITHUB_REPO_NAME` | Issue target for `/api/report-issue` |

### 4. KV / D1 / R2 binding IDs (`wrangler.jsonc`)

The IDs (`5ff718ea7c8d4df1b23b2924dec9bf91` etc.) identify Cloudflare
resources. Cloudflare's threat model treats these as non-secret —
access is gated by your Cloudflare account, not the ID. Leave them in
`wrangler.jsonc`.

## Setting secrets

Run `./scripts/setup-worker-secrets.sh` for the full interactive
sequence, or run individual commands as documented in that script.

## Rotation runbook

See `threat_model.md` § "Rotation runbook" — covers `SESSION_HMAC_KEY`,
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN`,
`GOOGLE_SA_PRIVATE_KEY`, `IP_HASH_PEPPER`, `INTEL_SALT`.
