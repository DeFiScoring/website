# DeFi Scoring (on Snowlake Jekyll base)

## Overview

A Jekyll static site for **DeFi Scoring** (defiscoring.com) — on-chain credit scoring (300–850), portfolio risk heatmaps, real-time alerts, and an AI-powered risk profiler. Phase 1 chains: Ethereum, Arbitrum, Polygon. Originally bootstrapped from the Snowlake Jekyll theme; all theme demo content (e-commerce, agency, blog, portfolio, multi-variant nav/footers) has been stripped — only the DeFi surface remains.

## Tech Stack

- **Static Site Generator**: Jekyll 4.3.x (Ruby)
- **Frontend**: Vanilla JS, Chart.js v4 (CDN), Bootstrap 5 (only on Snowlake demo pages)
- **Wallet**: EIP-6963 multi-wallet discovery + vanilla JS picker modal (`wallet-modal.js`). RainbowKit/Privy were intentionally not adopted — they require a React build pipeline that doesn't fit a Jekyll static site. The native modal gives the same UX (icon-list picker, last-used pinning, install CTA) at ~3 kb with zero deps.
- **Persistence**: Cloudflare D1 on the existing Worker (`HEALTH_DB` binding). Tables: `health_scores`, `watchlists`. localStorage is used as a graceful offline fallback when the Worker is unreachable; the UI shows a clear "syncing locally" banner so users never assume data is synced when it isn't. Supabase / Replit DB were intentionally not added — the Worker is already the backend, and one DB is simpler than two.
- **Auth model**: address-keyed only (wallet = identity). Anyone who knows an address can read/replace its watchlist. This is fine for MVP but should be hardened with SIWE (Sign-In-With-Ethereum) before any production launch.
- **Backend (planned)**: Cloudflare Pages (static), Cloudflare Workers (APIs), Workers AI (LLM), KV (cache), D1 (storage), R2 (assets)
- **Package Manager**: Bundler (site) · npm/wrangler (worker)

## Project Structure

```
.
├── _includes/
│   ├── head.html               CENTRAL SEO block — meta/OG/Twitter/canonical/JSON-LD
│   └── dashboard/              dashboard partials (sidebar, wallet-bar, …)
├── _layouts/                   exactly 3 layouts: default.html, dashboard.html, audit.html
├── sitemap.xml                 Liquid-templated sitemap (auto-collects pages + audits)
├── robots.txt                  Sitemap ref + disallows /dashboard, /admin, /api
├── _data/
│   ├── risk_profiles.yml       conservative/balanced/aggressive/degen presets
│   ├── protocols.yml           Aave / Uniswap / Compound metadata + chains
│   └── scores.yml              snapshot of latest composite scores (cron-refreshed)
├── assets/
│   ├── css/                    landing.css, dashboard.css (+ Snowlake CSS)
│   ├── js/
│   │   ├── wallet-connect.js   NEW – EIP-6963 + EIP-1193 connector (DefiWallet)
│   │   ├── wallet-modal.js     NEW – RainbowKit-style multi-wallet picker modal
│   │   ├── watchlist.js        NEW – D1-synced watchlist with localStorage fallback
│   │   ├── data-aggregation.js NEW – live DeFiLlama + CoinGecko + Aave V3 widget
│   │   ├── charts.js           NEW – Chart.js helpers + risk heatmap renderer
│   │   ├── profiler.js         NEW – calls AI Worker (with local fallback)
│   │   ├── dashboard.js        wallet UI + DefiAPI client (mock fallback)
│   │   ├── dashboard-{home,score,portfolio,alerts,risk}.js   per-page logic
│   │   └── ...                 (existing Snowlake JS)
│   └── defiscoring-logo*.png   brand marks (white for dark UIs, dark for light UIs)
├── dashboard/
│   ├── index.html              Overview
│   ├── score.html              My Score
│   ├── portfolio.html          Portfolio Heatmap
│   ├── risk-profiler.html      NEW – target profile + AI recommendations
│   └── alerts.html             Alerts
├── worker/
│   └── index.js                THE worker — single source of truth for the API.
│                               Deployed at defiscoring.guillaumelauzier.workers.dev.
│                               Routes: /api/score/:slug, /api/exposure, /api/audit,
│                               /api/health-score, /api/health-score/:wallet/history,
│                               /api/gas, /api/votes/:slug, /api/watchlist/:wallet,
│                               POST /api/profile (also accepts POST / and POST /profile
│                               as legacy aliases — wired from assets/js/profiler.js).
├── migrations/                 D1 schema migrations applied to HEALTH_DB
├── index.html                  DeFi Scoring marketing landing page
├── wrangler.jsonc              Cloudflare Worker config (KV/D1/AI bindings)
├── cloudflare.toml             Cloudflare Pages headers/cache (legacy, kept for ref)
├── github.toml                 GitHub Pages mirror config
├── _config.yml                 Jekyll config (lean — see file for excludes)
├── .gitignore                  Excludes _site/, .wrangler/, node_modules/, etc.
└── replit.md                   this file
```

> **Deployment**: only Cloudflare Workers (production) and GitHub Pages (mirror).
> `netlify.toml` was removed to eliminate cross-provider deploy confusion.

> **One worker, not two.** A duplicate `workers/risk-profiler-worker/` folder
> previously shipped the same routes as `worker/index.js` and was a frequent
> source of "the AI worker isn't wired" misdiagnosis. It has been deleted.
> The frontend already calls the unified worker via
> `window.DEFI_RISK_WORKER_URL` (set in `_layouts/dashboard.html` and
> `_layouts/default.html`).

### Worker secrets (set on Cloudflare, not in Replit)

Some routes need credentials that must be set as **Cloudflare Worker secrets**
(not Replit secrets — those don't reach the deployed Worker):

| Secret              | Required by                       | Set with                                  |
| ------------------- | --------------------------------- | ----------------------------------------- |
| `GITHUB_TOKEN`      | `POST /api/report-issue`          | `wrangler secret put GITHUB_TOKEN`        |
| `ADMIN_TOKEN`       | `GET /api/intel/{summary,export}` | `wrangler secret put ADMIN_TOKEN`         |
| `INTEL_SALT`        | `POST /api/intel/event` (HMAC)    | `wrangler secret put INTEL_SALT`          |
| `ETHERSCAN_API_KEY` | `/api/exposure`, on-chain reads   | `wrangler secret put ETHERSCAN_API_KEY`   |
| `ARB_RPC_URL`       | `/api/gas` Arbitrum reading       | `wrangler secret put ARB_RPC_URL`         |

`GITHUB_TOKEN` should be a classic PAT scoped to `repo` on
`{{ GITHUB_REPO_OWNER }}/{{ GITHUB_REPO_NAME }}` (defaults: `DeFiScoring/website`,
configurable via the `vars` block in `wrangler.jsonc`). Until the secret is
set, `POST /api/report-issue` returns HTTP 503 with a clear error message
that the in-app form surfaces verbatim.

### Market Intelligence Hub

Anonymized, **opt-in** telemetry that powers the admin dashboard at
`/dashboard/market-intel/` (admin-gated, `noindex`, deliberately omitted
from the sidebar nav).

- **Schema** lives in `migrations/0004_market_intel.sql` and uses the
  same `HEALTH_DB` D1 binding (one database; second binding rejected to
  avoid the same proliferation that bit us with the old duplicate worker).
  Run `wrangler d1 migrations apply defi_health` after deploy.
- **Privacy**: the browser only ever transmits `sha256(walletAddress)`;
  the Worker re-keys it with HMAC-SHA256 using `INTEL_SALT` before
  inserting. A stolen DB cannot be reversed by precomputing hashes of
  known wallets without that salt.
- **Consent**: `_includes/dashboard/intel-consent.html` shows a banner
  on the dashboard until the user opts in or out (state in
  `localStorage` under `defi:intel:consent`). `assets/js/market-data-logger.js`
  is a no-op until consent is `on`.
- **Hooks**: `health-score.js` (after a score renders), `dashboard-risk.js`
  (after a profiler run), `approvals-checker.js` (after a scan). Each is
  fire-and-forget with a 60s per-(event,wallet) coalesce so navigation
  doesn't spam the backend.
- **Admin endpoints** require `Authorization: Bearer <ADMIN_TOKEN>`.
  Aggregates are stored as sums + counters, so averages are recomputed
  on read and never accumulate floating-point drift.
- **MVP gate, not production auth**: the bearer-token check is a shared
  secret. Move `/dashboard/market-intel/` and `/api/intel/*` behind
  Cloudflare Access before opening this URL externally.

## Site Map

- `/` — DeFi Scoring marketing landing page
- `/dashboard/` — Overview (score, value, positions, alerts + 12-month trend)
- `/dashboard/score/` — My Score (gauge + factor breakdown)
- `/dashboard/portfolio/` — Portfolio Heatmap (risk-colored cells + table)
- `/dashboard/risk-profiler/` — **NEW** Risk Profiler (preset picker, drift charts, AI recs)
- `/dashboard/alerts/` — Alerts (rule builder + recent triggers)
- `/snowlake/` — Original Snowlake theme demo (other Snowlake pages still live at their original paths)

## Dashboard architecture

`_layouts/dashboard.html` is the dark, self-contained shell — no Snowlake header/footer. Each page sets `dashboard_section` in front matter to drive the active sidebar item and load its per-page JS. Shared JS:

- `wallet-connect.js` — minimal `DefiWallet` (connect/disconnect/address/on-change). Loaded on every dashboard page.
- `dashboard.js` — wallet UI binding + `DefiAPI` (score/portfolio/alerts) with deterministic mock fallback when `window.DEFI_API_BASE` is unset.
- `charts.js` — `DefiCharts.scoreTrend`, `allocationDoughnut`, `targetVsActualBars`, `heatmap`.
- `profiler.js` — `DefiProfiler.profile({wallet, portfolio, target_profile_id, target})`. Calls the Worker; falls back to a local computation that mirrors the Worker's deterministic logic.

The Risk Profiler page injects the protocol→class map and profile presets from `_data/risk_profiles.yml` into the page via Liquid so the client can classify positions without an extra fetch.

## Wiring the Cloudflare Worker

1. `cd workers/risk-profiler-worker && npm install`
2. `npx wrangler login`
3. `npx wrangler deploy --env production`
4. Route the worker to e.g. `api.defiscoring.com` in the Cloudflare dashboard.
5. On the website, set `window.DEFI_API_BASE = "https://api.defiscoring.com"` (or edit `DEFAULT_API_BASE` in `assets/js/dashboard.js` and `assets/js/profiler.js`).

Until set, all dashboard pages return deterministic mock data seeded from the connected wallet, so everything is fully demoable offline.

## Development

```bash
bundle exec jekyll serve --host 0.0.0.0 --port 5000 --livereload
```

Workflow: **Start application** → port 5000.

## Deployment

Static deploy (Cloudflare Pages):

- Build: `bundle exec jekyll build`
- Output: `_site`
- Headers/cache config: `cloudflare.toml`

The Worker deploys separately with `wrangler` from `workers/risk-profiler-worker/`.

## Dependencies

- Site: `Gemfile` — `jekyll ~> 4.3.2`, `jekyll-feed`, `jekyll-paginate-v2`, `jekyll-archives`, `kramdown-parser-gfm`, `rouge`, `webrick`.
- Worker: `workers/risk-profiler-worker/package.json` — `wrangler ^3.90`.
