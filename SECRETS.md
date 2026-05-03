# Secrets registry — DeFi Scoring

Single source of truth for every credential the project uses, where it lives, and why.

## TL;DR — destination policy

| Destination | What goes here | How to set |
|---|---|---|
| **Cloudflare Worker Secrets** | Every runtime secret. The Worker is the only thing that reads them. | `wrangler secret put NAME` (or `./scripts/setup-worker-secrets.sh`) |
| **Cloudflare `vars` block** (`wrangler.jsonc`) | Public, non-sensitive runtime config (URLs, TTLs, allow-lists, public addresses) | Edit `wrangler.jsonc` and `wrangler deploy` |
| **GitHub Actions Secrets** | CI/CD-only credentials needed by the deploy workflow | Repo → Settings → Secrets and variables → Actions |
| **`.env.example` → local `.env`** | Local-dev script config (no real secrets) | Copy `.env.example` to `.env`, fill placeholders |

## Architecture (why this split)

- **Cloudflare Worker** (`worker/index.js`) is the only runtime. It serves the API *and* the static Jekyll site (`assets.directory: ./_site` in `wrangler.jsonc`).
- **Static site** is fully prerendered — it never reads `process.env` / `import.meta.env` at runtime. Public values it needs (e.g. `STRIPE_PUBLISHABLE_KEY`) are fetched from Worker endpoints like `/api/billing/config` so they can rotate without a rebuild.
- **`scripts/refresh_scores.py`** is a local-dev helper that hits the deployed Worker. It only needs non-secret config (`WORKER_BASE_URL`, `REQUEST_TIMEOUT`).
- **GitHub Actions** (added in `.github/workflows/deploy.yml`) needs exactly **one** secret to deploy: `CLOUDFLARE_API_TOKEN`.

## Audit status (last reviewed: 2026-05-03)

✅ No `.env` files committed. None ever existed in `git log`.
✅ No `sk_live_*`, `sk_test_*`, `pk_live_*`, `whsec_*`, `ghp_*`, `xoxb-*`, `AIza*`, JWT (`eyJ*`), or PEM private-key literals anywhere in tracked source, configs, frontend, `_site/` build output, or `attached_assets/`.
✅ Every Worker consumer reads `env.X`. No fallback string literals.
✅ `.gitignore` blocks `.env`, `.env.*`, `*.env`, `secrets.*`, `*.pem`, `*.key`.
✅ Frontend never imports secrets. `STRIPE_PUBLISHABLE_KEY` is delivered via `/api/billing/config` server-side at request time.
✅ `dashboard/market-intel.html` accepts `ADMIN_TOKEN` as a user-typed password into `localStorage` only. No embedded value.

**No rotation required.** Nothing is exposed.

## 1. Cloudflare Worker Secrets (CF-S)

Set with `wrangler secret put NAME` from the project root. **Every entry below MUST be set before production traffic is served.**

### 1a. Server-only secrets (never reach the browser)

| Name | Used by | Format | Notes |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | `worker/lib/stripe.js`, `/api/billing/*` | `sk_live_…` / `sk_test_…` | |
| `STRIPE_WEBHOOK_SECRET` | `/api/webhooks/stripe` HMAC verify | `whsec_…` | |
| `STRIPE_PRICE_ID_PRO` | `/api/billing/checkout` | `price_…` | $15/mo Pro plan |
| `STRIPE_PRICE_ID_PLUS` | `/api/billing/checkout` | `price_…` | $49/mo Plus plan |
| `SESSION_HMAC_KEY` | `lib/auth.js` cookie signing | 32+ random hex chars | Rotating logs out everyone |
| `IP_HASH_PEPPER` | rate-limit hashing | 32+ random hex chars | |
| `INTEL_SALT` | `/api/intel/event` wallet hashing + DSAR | 32+ random hex chars | |
| `ADMIN_TOKEN` | `/api/intel/{summary,export}`, `/api/account/retention/run` | 32+ random chars | Bearer auth |
| `GITHUB_TOKEN` | `/api/report-issue` (runtime, not CI) | `ghp_…`, `repo` scope | Distinct from `CLOUDFLARE_API_TOKEN` in GHA |
| `ALCHEMY_KEY` | `lib/providers.js` token-balance + RPC | 32 chars | |
| `ETHERSCAN_API_KEY` | `lib/providers.js` v2 multichain | 34 chars | |
| `MORALIS_KEY` *(optional)* | Tier 2 token-balance fallback | JWT-ish | |
| `RESERVOIR_KEY` *(optional)* | NFT enrichment | UUID | |
| `COINGECKO_KEY` *(optional)* | Pro pricing tier | `CG-…` | Free tier works without |
| `GOOGLE_SA_EMAIL` | Gmail SA for outbound alerts | `*@*.iam.gserviceaccount.com` | |
| `GOOGLE_SA_PRIVATE_KEY` | Gmail SA PEM PKCS#8 | `-----BEGIN PRIVATE KEY-----…` | |
| `GMAIL_SENDER` | Workspace user the SA impersonates | `alerts@defiscoring.com` | |
| `TELEGRAM_BOT_TOKEN` | `/api/alerts` Telegram delivery | `<botid>:<hash>` | |
| `TURNSTILE_SECRET` | Cloudflare Turnstile server verify | `0x…` | |
| `OFAC_LIST_URL` | OFAC SDN snapshot fetch | `https://…` | Pre-signed URL — treat as secret |

### 1b. Public values that still live in CF Secrets (rotatable without rebuild)

These reach the browser via Worker config endpoints. Storing them as secrets (not `vars`) lets you rotate them without redeploying the static site.

| Name | Delivered to frontend via | Format |
|---|---|---|
| `STRIPE_PUBLISHABLE_KEY` | `GET /api/billing/config` | `pk_live_…` / `pk_test_…` |
| `WC_PROJECT_ID` | (TODO) `GET /api/wallet/config` | UUID |
| `TURNSTILE_SITE_KEY` | (TODO) Same | `0x…` |

## 2. Cloudflare `vars` (public, in `wrangler.jsonc`)

Visible in the deployed bundle. Not secret. Edit `wrangler.jsonc` and redeploy.

| Name | Purpose |
|---|---|
| `ADMIN_BOOTSTRAP_ADDRESS` | Public 0x address that auto-grants `admin` on first SIWE login. ⚠️ moved here from secrets — see "Migration steps" below |
| `ALLOWED_ORIGINS` | CORS allow-list (comma-separated) |
| `ETH_RPC_URL` | Public RPC fallback |
| `PROTOCOL_CATALOG_URL`, `SNAPSHOT_API_URL` | Public data sources |
| `DSAR_CONTACT_EMAIL` | Email shown on the privacy page |
| `DATA_RETENTION_DAYS` | Days before retention prune deletes raw event rows |
| `*_CACHE_TTL_SECONDS` | KV cache TTLs (audit, score, exposure, health, profile, protocol catalog) |
| `AUDIT_MAX_SOURCE_CHARS` | Audit input cap |
| `GITHUB_REPO_OWNER`, `GITHUB_REPO_NAME` | Issue target for `/api/report-issue` |

## 3. KV / D1 / R2 / AI bindings (`wrangler.jsonc`)

The IDs (`5ff718ea7c8d4df1b23b2924dec9bf91`, etc.) identify Cloudflare resources. Cloudflare's threat model treats these as non-secret — access is gated by your Cloudflare account, not the ID. Leave them in `wrangler.jsonc`.

## 4. GitHub Actions Secrets (CI/CD only)

Set at: *Repo → Settings → Secrets and variables → Actions → New repository secret*.

| Name | Used by | Why |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | `.github/workflows/deploy.yml` | Auth for `cloudflare/wrangler-action@v3`. Create at https://dash.cloudflare.com/profile/api-tokens with the **"Edit Cloudflare Workers"** template scoped to the `defiscoring` account. |

`CLOUDFLARE_ACCOUNT_ID` is **not** a secret — it's already public in `wrangler.jsonc` line 7.

## 5. Local development (`.env.example` → `.env`)

The only env vars local devs need are for `scripts/refresh_scores.py`:

| Name | Default | Purpose |
|---|---|---|
| `WORKER_BASE_URL` | `https://defiscoring.guillaumelauzier.workers.dev` | Worker to hit from the script |
| `REQUEST_TIMEOUT` | `20` | HTTP timeout in seconds |

Copy `.env.example` to `.env` and edit. `.env` is gitignored.

## Migration steps (one-time)

To execute the destination changes documented above:

1. **Set `CLOUDFLARE_API_TOKEN` in GitHub Actions Secrets** so the new workflow can deploy.
2. **Paste your real admin address** into `wrangler.jsonc` → `vars.ADMIN_BOOTSTRAP_ADDRESS` (currently `0x0000…0000` placeholder).
3. **Deploy once** (manually or via a push) so the new var is live.
4. **Remove the old secret** so it can't drift:
   ```sh
   npx wrangler secret delete ADMIN_BOOTSTRAP_ADDRESS
   ```
5. **For any optional secret you don't use yet** (`MORALIS_KEY`, `RESERVOIR_KEY`, `COINGECKO_KEY`, `WC_PROJECT_ID`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET`), the Worker treats them as falsy and falls back gracefully — no need to set placeholders.

## Setting all CF Worker Secrets at once

Run `./scripts/setup-worker-secrets.sh` for the full interactive sequence, or run individual `wrangler secret put NAME` commands.

## Rotation runbook

See `threat_model.md` § "Rotation runbook" — covers `SESSION_HMAC_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN`, `GOOGLE_SA_PRIVATE_KEY`, `IP_HASH_PEPPER`, `INTEL_SALT`.
