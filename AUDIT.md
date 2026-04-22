# DeFiScoring.com — Phase 0 Audit

**Date:** 2026-04-22
**Scope:** Pre-overhaul snapshot of the Jekyll site, the Cloudflare Worker, the dashboard surface, D1 migrations, third-party scripts, link health, and security headers. No code was modified during this phase.
**Audit method:** Static read of the repo + spot HTTP checks against the local Jekyll dev server (`http://localhost:5000`) running `bundle exec jekyll serve`.

---

## 1. Jekyll build

| Item | Value | Notes |
| --- | --- | --- |
| Jekyll version constraint | `~> 4.3.2` (`Gemfile`) | Current |
| `.ruby-version` | `3.3.5` | |
| Cloudflare build env | `RUBY_VERSION = "3.3.5"` (`cloudflare.toml`) | Matches `.ruby-version`. |
| Replit workspace Ruby | `3.2.2` (`ruby --version`) | **Mismatch.** Local builds run on a different Ruby than CI/Cloudflare. Low risk (Jekyll 4.3 supports both), but install Ruby 3.3.5 in the Replit toolchain to eliminate "works on my machine" drift. |
| `Gemfile.lock` | Present, 2.2 KB | Healthy, not stale. |
| Plugins declared in `Gemfile` (`group :jekyll_plugins`) | `jekyll-feed`, `jekyll-paginate-v2`, `jekyll-archives` | |
| Plugins actually enabled in `_config.yml` (`plugins:`) | `jekyll-feed` only | **Inconsistency.** `jekyll-paginate-v2` and `jekyll-archives` are bundled but never activated. Either drop them from the Gemfile or enable them. |
| Other build-time gems | `webrick`, `kramdown-parser-gfm`, `rouge`, `csv`, `base64`, `logger`, `bigdecimal` | Standard. |
| Collections | `audits` (`output: true`, permalink `/audits/:path/`) | 6 audit MD files in `_audits/`. |
| Ignored from build | `worker/`, `migrations/`, `wrangler.jsonc`, `cloudflare.toml`, `attached_assets/`, `.local/`, `.jekyll-cache/`, etc. — well scoped | |
| Site URL | `https://defiscoring.com` (CNAME confirms) | |
| `_includes/head.html` | Centralised SEO/OG/Twitter/JSON-LD block, looks complete (`<title>`, canonical, OG, Twitter card, Organization + WebSite JSON-LD, favicons, manifest) | Strong. Pages can override per front-matter. |
| `robots.txt` + `sitemap.xml` | Both present and served (`200`) | |

**Risk:** Low. The Jekyll layer is in good shape.

---

## 2. Cloudflare Worker (`worker/index.js`, 1,909 lines, ~80 KB)

### 2.1 Bindings

From `wrangler.jsonc`:

| Binding | Type | Purpose |
| --- | --- | --- |
| `ASSETS` | Static assets (`./_site`, SPA fallback, `run_worker_first: true`) | Worker serves Jekyll output. |
| `AI` | Workers AI | Llama 3.1 calls for risk profile + audits. |
| `PROFILE_CACHE` | KV | AI profile responses (TTL `CACHE_TTL_SECONDS` = 600 s). |
| `DEFI_CACHE` | KV | DeFiLlama / Etherscan / chatbot caches. |
| `HEALTH_DB` | D1 (`defi_health`) | All persistent tables. |

**No R2.** **No Durable Objects.** That is fine for current functionality but flagged because Phase 2 (SIWE rate-limit) and Phase 3 (admin export jobs) may want them later.

### 2.2 Vars (non-secret) and Secrets

**Public vars** (in `wrangler.jsonc`): `CACHE_TTL_SECONDS`, `SCORE_CACHE_TTL_SECONDS`, `PROTOCOL_CATALOG_URL`, `PROTOCOL_CATALOG_TTL_SECONDS`, `EXPOSURE_CACHE_TTL_SECONDS`, `AUDIT_CACHE_TTL_SECONDS`, `AUDIT_MAX_SOURCE_CHARS`, `HEALTH_CACHE_TTL_SECONDS`, `ETH_RPC_URL`, `SNAPSHOT_API_URL`, `ALLOWED_ORIGINS`, `GITHUB_REPO_OWNER`, `GITHUB_REPO_NAME`.

**Secrets** (declared in a comment, set via `wrangler secret put`):
- `GITHUB_TOKEN` — classic PAT, `repo` scope, used to file issues from `/api/report-issue`.
- `ADMIN_TOKEN` — bearer token for `/api/intel/{summary,export}` (constant-time compared).
- `INTEL_SALT` — HMAC pepper for hashing wallets in `/api/intel/event`.
- `ETHERSCAN_API_KEY`, `ARB_RPC_URL` — on-chain enrichment.

**Hardcoded secrets in source:** none found. All sensitive values are read from `env.*`. ✅

### 2.3 Routes

```
GET  /health
GET  /onchain/:wallet                       (Etherscan multichain history)
GET  /api/score/:protocol                    (DeFiLlama composite score, KV-cached 6h)
GET  /api/gas
GET  /api/health-score/:wallet/history
GET  /api/votes/:slug                        (read aggregated votes)
GET  /api/watchlist/:wallet                  (read watchlist)
GET  /api/intel/summary                      (ADMIN)
GET  /api/intel/export                       (ADMIN, CSV)

POST /                                       (AI risk profile)
POST /profile                                (alias)
POST /api/profile                            (alias)
POST /api/exposure                           (wallet → contract interactions)
POST /api/audit                              (AI source-code audit, KV-cached 30 d)
POST /api/health-score                       (writes health_scores row)
POST /api/votes/:slug                        (writes/upserts a vote)
POST /api/watchlist/:wallet (PUT)            (replaces watchlist for wallet)
POST /api/report-issue                       (creates a real GitHub issue)
POST /api/chatbot/consent                    (writes chatbot_leads row)
POST /api/chatbot/message                    (chatbot turn)
POST /api/intel/event                        (writes intel_events row)

DELETE /api/votes/:slug
DELETE /api/watchlist/:wallet

OPTIONS *                                    (returns 204 + CORS)
```

### 2.4 CORS

```js
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};
```

- `Access-Control-Allow-Origin: *` is hardcoded; the `ALLOWED_ORIGINS` var in `wrangler.jsonc` is **dead config** (never read in `worker/index.js`).
- For the read-only/anonymous endpoints this is acceptable.
- For the **write** endpoints (votes, watchlist, health-score, intel/event, report-issue, chatbot/*) it lets any origin call them with the user's CSRF surface = no surface, since there is no cookie session today. **However:** as soon as Phase 2 introduces a `__Host-` session cookie, `Access-Control-Allow-Origin: *` is **incompatible with credentialed requests** and CORS must move to an allowlist (`defiscoring.com`, the local dev origin, and explicitly NOT `*`). Track this as a Phase 2 prerequisite.

### 2.5 Authentication / authorization model today

| Endpoint group | Current guard |
| --- | --- |
| Read-only public APIs | None (intentional). |
| Write APIs (`/api/votes`, `/api/watchlist`, `/api/health-score`, `/api/intel/event`, `/api/chatbot/*`) | **None.** Wallet address is supplied by the client in the body or path. No signature, no cookie, no rate limit. The `0003_community_votes.sql` migration even comments: *"Before production, gate POST/DELETE behind SIWE so a signed nonce proves wallet ownership."* This is the central gap Phase 2 closes. |
| `/api/report-issue` | Server-side `GITHUB_TOKEN`. **No client auth, no rate limit, no Turnstile.** Caller can spam the public GitHub repo. Add Turnstile + per-IP KV rate limit. |
| `/api/intel/{summary,export}` | `Authorization: Bearer <ADMIN_TOKEN>`, constant-time compare. ✅ correctly implemented (see lines 1432-1449). |

### 2.6 Other worker observations

- `intel_event` validation is good: `hashedWallet` must match `^[0-9a-f]{64}$`, `eventType` is gated by an enum set, `metadata` capped at 2 KB serialized, server re-keys the client hash with HMAC-SHA256(`INTEL_SALT`).
- AI calls (`/api/exposure`, `/api/audit`, `/api/profile`) have **no per-IP/per-wallet rate limit** — a single bad actor can run up the Workers AI bill. Add KV-backed rate limit.
- No global error envelope normalization beyond `json({ success, error })`. Acceptable.
- No structured logging or request ID correlation. Observability is enabled in `wrangler.jsonc` (`head_sampling_rate: 1`) so traces will land in Cloudflare; consider attaching a `cf-ray` echo to error responses.

**Severity of worker findings:** Most are **Medium**. The lack of write-endpoint auth is intentional (Phase 2 fixes it) but should not be left in production once a session model exists.

---

## 3. Dashboard (`/dashboard/*`)

| Question | Answer |
| --- | --- |
| Framework? | **Vanilla HTML + JavaScript.** No React, Vue, Svelte, or Solid. Each page in `dashboard/` is a Jekyll page using `_layouts/dashboard.html`. |
| Build tool? | **None.** Jekyll only. JS files are static under `assets/js/` and shipped as-is — no bundler, no minifier (other than the legacy `bootstrap.min.js` / `jquery.min.js` files that ship pre-minified). |
| Module system? | Plain `<script>` tags, no ES modules / `type="module"`. |
| Auth model? | **None.** All `/dashboard/*` pages are publicly accessible. The "wallet connect" button only stores the wallet address in client memory + LocalStorage; the server does not know who you are. |
| API talk | `assets/js/*` calls `https://defiscoring.guillaumelauzier.workers.dev` directly via `fetch()`. The worker URL comes from `_config.yml > defi.worker_url`. Same-origin once mounted under `defiscoring.com` because the Worker also serves the static assets. |
| State store | LocalStorage (wallet, last-used wallet provider, intel-consent flag, watchlist mirror). No IndexedDB. |
| 24 dashboard pages | `index, alerts, approvals, audits, audit-toolkit, custody-por, issuer-due-diligence, legal-compliance, liquidity-redemption, market-intel, oracle-integrity, portfolio, portfolio-rwa-exposure, report (perma → /dashboard/report-issue/), risk-chatbot, risk-profiler, rwa-asset-score, rwa-chatbot, scanner, score, yield-risk-adjusted` |

**Implication for Phase 3:** The "rebuild dashboard as React/Vite/TS at `/admin`" requirement is essentially a greenfield SPA living next to the existing Jekyll dashboard. Recommend keeping the public Jekyll `/dashboard/` surface intact and mounting the new admin SPA under a separate `/admin/` path (the Worker SPA fallback is already configured: `not_found_handling: "single-page-application"`).

---

## 4. Migrations (`migrations/*.sql`)

| File | Tables | Notes |
| --- | --- | --- |
| `0001_init.sql` | `health_scores` | History of computed 300-850 scores per wallet. |
| `0002_watchlists.sql` | `watchlists` | Per-wallet watchlist of protocol slugs / token contracts. |
| `0003_community_votes.sql` | `community_votes` | +1/-1 votes per (wallet, protocol). **Comment explicitly says SIWE is required before production.** |
| `0004_market_intel.sql` | `intel_events`, `intel_daily_aggregates` | Hashed-wallet telemetry, daily roll-ups. |
| `0005_risk_chatbot.sql` | `chatbot_leads` | Email leads from the chatbot consent form. |

**Tables Phase 2 / 3 will need but don't exist yet:**
- `users` (id, address_lowercase UNIQUE, ens_name, role, country, …)
- `sessions` (SIWE session cookies, ip_hash, ua_hash, revoked_at)
- `nonces` (or KV) for SIWE nonces with TTL + IP/UA binding
- `events` (analytics pageview/click stream)
- `wallet_snapshots` (opt-in on-chain snapshot)
- `feedback` (in-app feedback widget)
- `scoring_runs` (R&D model replay)
- `webauthn_credentials` (passkey step-up for sensitive admin actions)
- `admin_audit_log` (every admin action — append-only)

Plan to add these as `0006_users_sessions.sql` … `0013_admin_audit_log.sql`.

---

## 5. Third-party scripts

### 5.1 Loaded site-wide (via `_includes/head.html` / `index.html`)

| Asset | Source | Pinned? | SRI? | Loaded over HTTPS? |
| --- | --- | --- | --- | --- |
| Inter + JetBrains Mono | `https://fonts.googleapis.com/css2?…` | n/a | No (browsers do not currently support SRI on stylesheets without `integrity`; Google Fonts CSS rotates) | ✅ |
| Google Fonts files | `https://fonts.gstatic.com/…` (preconnect) | n/a | n/a | ✅ |

The landing page (`index.html`) ships **only** its own `assets/js/landing.js`. ✅

### 5.2 Loaded by `_layouts/dashboard.html`

| Script | Pinned? | SRI? | Risk |
| --- | --- | --- | --- |
| `https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js` | ✅ | ❌ | **Medium** — pinned version mitigates supply chain, but no `integrity=` means a CDN compromise or MITM (would need TLS break) still ships arbitrary JS. |
| `https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js` | ✅ | ❌ | Medium |
| `https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js` | ✅ | ❌ | Medium |
| `https://unpkg.com/lucide@latest/dist/umd/lucide.min.js` | ❌ **`@latest`** | ❌ | **High** — unpinned + no SRI on a transitively-published package. A compromised lucide release would execute on every dashboard page. |

All loaded over HTTPS. No mixed content. No `http://` references found in the layouts/includes/index. ✅

**Recommendation in Phase 1:** pin `lucide` to a specific version, add `integrity=` (sha384 of the file from jsdelivr's API) and `crossorigin="anonymous"` to all four scripts. Or — better, given the Phase 3 React/Vite move — vendor them through the Vite bundler and stop hitting third-party CDNs at runtime.

---

## 6. Link health & 404s

Spot-checked against the running Jekyll server (full Lighthouse-style crawl is below in §7).

```
200 /                                    200 /sitemap.xml
200 /audits/                             200 /robots.txt
200 /dashboard/                          200 /methodology/
200 /dashboard/score/                    200 /privacy/
200 /dashboard/scanner/                  200 /terms/
200 /dashboard/portfolio/                200 /disclaimer/
200 /dashboard/risk-chatbot/             200 /api/
200 /dashboard/rwa-chatbot/              404 /dashboard/report/   ← see note
200 /dashboard/audits/
200 /dashboard/report-issue/
```

The `404 /dashboard/report/` is **not** a broken link — it was a probe. The page lives at `dashboard/report.html` with `permalink: /dashboard/report-issue/`, which renders correctly. All `href="…"` attributes I extracted from the layouts, includes, index, and dashboard pages resolve to `200`.

**Console errors:** cannot be enumerated reliably from a server-side audit (would need a headless browser run). I did not spot any obvious sources (no missing JS file references, no broken `src` attributes, no `<script>` referencing files that aren't in `assets/js/`).

**Limitation:** A full link-check should use `htmlproofer` (`bundle add html-proofer && htmlproofer ./_site`) or `lychee` against the deployed origin. Recommended to wire this into CI.

---

## 7. Lighthouse

**Cannot run from this environment.** The Replit container does not have a headless Chrome installed and Lighthouse needs a real browser plus network egress to the live site. I am explicitly flagging this rather than fabricating numbers.

**Recommended ways to run it:**
1. PageSpeed Insights for live URLs:
   - https://pagespeed.web.dev/analysis?url=https%3A%2F%2Fdefiscoring.com%2F
   - https://pagespeed.web.dev/analysis?url=https%3A%2F%2Fdefiscoring.com%2Fmethodology%2F
   - https://pagespeed.web.dev/analysis?url=https%3A%2F%2Fdefiscoring.com%2Faudits%2F
   - https://pagespeed.web.dev/analysis?url=https%3A%2F%2Fdefiscoring.com%2Fapi%2F
2. Local CLI: `npx lighthouse https://defiscoring.com --view`.
3. Wire `lighthouse-ci` into the GitHub Actions deploy workflow with budgets (`lhci autorun --collect.url=…`).

**Static perf signals I *can* observe from the source:**
- Render-blocking CSS: `landing.css`, `footer.css` — both `<link rel="stylesheet">` in `<head>`, **not** preloaded asynchronously.
- Render-blocking script: `landing.js` is `defer`'d ✅. Dashboard layout has 24 `<script>` tags; a quick count suggests the page footer has multiple CDN scripts and many same-origin scripts loading in series.
- Asset cache headers in `cloudflare.toml`: `*.css/.js/.png/.jpg/.svg` get `public, max-age=31536000, immutable` ✅ — but only when served by Cloudflare Pages with a `_headers` file. The current Worker deployment **does not** apply these (see §8 below).
- Favicons + manifest present. ✅
- OG image (`/assets/defiscoring-logo-white-2_1776667771148.png`) is the 500×500 brand mark, not 1200×630. Google/X may downgrade preview quality. Replace with a true 1200×630 OG image.
- Fonts loaded with `preconnect` + `display=swap` ✅.

**Likely Lighthouse drag points (informed guesses, not measurements):**
- LCP on `/dashboard/*` due to ~24 same-origin scripts and 3+ CDN scripts loading after first paint.
- TBT on dashboard pages from chart.js + jspdf parsing.
- A11y: many dashboard cards use color tokens (cyan/purple/gold) on `#0a0a0a` — contrast probably passes but should be audited per-component.
- SEO: dashboard pages have `noindex` (intentional) ✅. Public pages (`/`, `/methodology/`, `/audits/`, `/api/`, legal pages) have full meta + JSON-LD ✅.

---

## 8. Security headers

### 8.1 Declared in `cloudflare.toml`

```toml
[[headers]]
  for = "/*"
  [headers.values]
    Strict-Transport-Security = "max-age=31536000; includeSubDomains; preload"
    X-Content-Type-Options    = "nosniff"
    X-Frame-Options           = "DENY"
    Referrer-Policy           = "strict-origin-when-cross-origin"
    Content-Security-Policy   = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'"
```

### 8.2 The catch: these headers are not actually shipped today

`cloudflare.toml` is the **Cloudflare Pages** netlify-style config. The current production deploy uses **Cloudflare Workers** (`wrangler.jsonc`, with the Worker serving `_site` via the `ASSETS` binding and `run_worker_first: true`). Workers do **not** read `cloudflare.toml`. Neither do they read `_headers` or `_redirects` (both files are present but empty in the repo).

> **This means the live site at https://defiscoring.com almost certainly ships none of those headers right now.** This must be verified against production with `curl -I https://defiscoring.com/` and `curl -I https://defiscoring.com/dashboard/score/`. If confirmed, the fix is to inject these headers from inside the Worker's response path.

### 8.3 Issues with the declared CSP itself (independent of whether it ships)

| Issue | Detail |
| --- | --- |
| `'unsafe-inline'` + `'unsafe-eval'` in `script-src` | Defeats CSP's primary XSS protection. Move inline JSON-LD blocks behind a per-response `nonce-…` and remove `unsafe-eval`. |
| Missing `connect-src` | Browser falls back to `default-src 'self'`, which would block `fetch()` to `https://defiscoring.guillaumelauzier.workers.dev` (and any non-same-origin worker). Add `connect-src 'self' https://defiscoring.guillaumelauzier.workers.dev`. |
| Missing `cdn.jsdelivr.net` and `unpkg.com` in `script-src` | The dashboard's chart.js / jspdf / lucide CDN scripts violate the declared policy; would be blocked if it were enforced. |
| Missing `https://fonts.googleapis.com` in `style-src` | Google Fonts stylesheet would be blocked. |
| Missing `https://fonts.gstatic.com` in `font-src` | Font files would be blocked (no `font-src` directive at all → falls back to `'self'`). |
| Missing `img-src` | `data:` favicons, OG image, dashboard images need `img-src 'self' data: https:`. |
| Missing `frame-ancestors` | Mostly covered by `X-Frame-Options: DENY`, but modern guidance prefers CSP `frame-ancestors 'none'`. |
| Missing `Permissions-Policy` | Should set `camera=(), microphone=(), geolocation=(), payment=(), usb=()` etc. |
| Missing `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Resource-Policy: same-site` | Recommended for isolation; particularly relevant once an admin SPA exists. |

### 8.4 Recommended baseline for Phase 1

Inject from the Worker on every response (and keep it in `cloudflare.toml` as a backup for if the deploy moves to Pages):

```
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-site
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'nonce-{{nonce}}' https://cdn.jsdelivr.net https://unpkg.com;
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  font-src 'self' https://fonts.gstatic.com;
  img-src 'self' data: https:;
  connect-src 'self' https://defiscoring.guillaumelauzier.workers.dev https://api.etherscan.io https://api.llama.fi https://hub.snapshot.org;
  frame-ancestors 'none';
  base-uri 'self';
  form-action 'self';
  object-src 'none';
  upgrade-insecure-requests
```

`X-Frame-Options: DENY` can stay as a belt-and-braces.

---

## 9. Cross-cutting non-negotiables — current state vs. requirement

| Non-negotiable | Status today |
| --- | --- |
| Read-only wallet, no signing of value-bearing tx | ✅ The current dashboard never calls `eth_sendTransaction`, never requests approvals. Wallet connect is detection + display only. |
| No custodial flows / no `eth_sendTransaction` / no approvals | ✅ Verified by grep — no such calls in `assets/js/*`. |
| Secrets in env vars only | ✅ All sensitive values come from `env.*` in the Worker; nothing in the repo. |
| Public Jekyll site keeps building & deploying | ✅ Build is green; Worker config is intact. **But:** §8.2 says the security headers from `cloudflare.toml` are likely not in the live response — that needs verification before Phase 1 starts moving headers around. |

---

## 10. Phase 0 verdict and recommended Phase 1 entry points

**Top-priority issues (in order):**

1. **Security headers are likely not being shipped in production.** Verify with `curl -I https://defiscoring.com/`. If true, Phase 1 must add a Worker response wrapper that injects HSTS/CSP/Permissions-Policy/etc. — the existing `cloudflare.toml` is a no-op for the current Workers deployment.
2. **CORS will break the moment Phase 2 ships.** `Access-Control-Allow-Origin: *` is incompatible with credentialed cookies. Move to an env-driven origin allowlist.
3. **Unauthenticated write endpoints** (`/api/votes`, `/api/watchlist`, `/api/health-score`, `/api/intel/event`, `/api/chatbot/*`, `/api/report-issue`). Phase 2 (SIWE) fixes most of these; `/api/report-issue` also needs Cloudflare Turnstile + per-IP rate limiting independently.
4. **Lucide loaded as `@latest` with no SRI.** Pin + add `integrity=` immediately (one-line fix; do it in Phase 1 even before the React/Vite migration).
5. **Ruby version drift** between Replit (3.2.2) and CI/Cloudflare (3.3.5). Bump the Replit toolchain to 3.3.5.
6. **Dead config**: `ALLOWED_ORIGINS` var is unused; either delete or wire it into `CORS_HEADERS`.
7. **AI endpoints have no rate limit** — Workers AI bill exposure. Add a KV-backed token bucket per IP / per hashed wallet.
8. **OG image is 500×500**, should be 1200×630 for proper card rendering on social.
9. Plugin drift: `jekyll-paginate-v2` and `jekyll-archives` are bundled but not enabled.
10. Add `htmlproofer` (or `lychee`) to CI for an authoritative link check.

**Out of scope for this audit (deferred):**
- True Lighthouse numbers — needs a headless Chrome run from an external machine (see §7).
- Live CSP/HSTS verification — needs `curl -I` against `https://defiscoring.com`, which I cannot do from this Worker-less workspace without your sign-off to make outbound requests to the live origin.
- Penetration testing of the unauthenticated write endpoints.

---

## Stop point

Phase 0 deliverable complete. **Not proceeding to Phase 1 / 2 / 3 until you confirm.** When you give the go-ahead, I will:

- Open Phase 1 as a focused project task (security headers from the Worker, SRI/pinning for CDN scripts, CORS allowlist, AI rate limiting, Ruby pin).
- Then Phase 2 (SIWE: nonce → sign → cookie session in D1, plus the SIWE migrations and Vitest suite) as a second task, depending on Phase 1.
- Then Phase 3 (React/Vite/TS admin SPA at `/admin`, role check, WebAuthn step-up, all the new D1 tables, analytics ingest from `_includes/analytics.html`) as a third task, depending on Phase 2.

One conflict you'll want to resolve before I draft the tasks: your earlier answer said admin auth should be **GitHub OAuth gated to the DeFiScoring org**, but the Phase 2 / Phase 3 specs you just pasted say admin uses the **SIWE session + role check** (with WebAuthn step-up). Tell me which one wins (or whether the answer is "both — SIWE is the public login, GitHub OAuth is the admin door") and I'll plan accordingly.
