# Changelog

## Unreleased — Wallet backend fixes

Bug-fix pass over the wallet path: SIWE sign-in, sessions, multi-wallet
linking, and the wallet-scoped scoring endpoints.

**Sign-in was broken end to end in the deployed topology**

- `ds_session` was always issued `SameSite=Lax`. The dashboard is served from
  `defiscoring.com` and calls the worker on its own hostname, so every API
  call is cross-site — and a Lax cookie is never sent on one. `/api/auth/verify`
  set a cookie the browser then refused to return, so `/api/auth/me` 401'd
  immediately after a valid signature and no wallet could stay signed in. The
  cookie now follows the request: `SameSite=None; Partitioned` when the caller
  is cross-site, `Lax` when the worker also serves the site. The logout cookie
  carries matching attributes so it actually clears the session.
- New: Origin allowlist check on every mutating `/api/` request. `SameSite=None`
  gives up SameSite's incidental CSRF protection; this replaces it. Requests
  with no Origin (curl, the Stripe webhook) are unaffected.

**Wallets that could never sign in**

- Smart-contract wallets — Safe, Argent, Coinbase Smart Wallet, every ERC-4337
  account — are contracts with no recoverable key, so ECDSA recovery could
  never validate them. Added EIP-1271 verification (`isValidSignature`, both
  the final `bytes32` ABI and the pre-final `bytes` ABI used by older Safe and
  Argent deploys) as a fallback when recovery doesn't match.
- 64-byte EIP-2098 compact signatures were rejected outright; now accepted.
- `ethCall` gained a public-RPC tier (`ETH_RPC_URL` / `RPC_URL_<chainId>`) so
  contract-wallet sign-in still works without an Alchemy key.

**SIWE message parsing**

- Key/value pairs were scanned across the whole message, including the
  statement — the one field a calling dapp fully controls — so a
  `Nonce: …`-shaped statement could shadow real fields. Parsing is now scoped
  to the field block proper, located by the mandatory `URI:` line.
- Fixes along the way: multi-line statements, messages with no statement at
  all (the wagmi/rainbowkit default), a `Resources:` block, scheme-prefixed
  domains (`https://defiscoring.com wants you to…`), and CRLF line endings.
- Nonce consumption is now a single guarded `DELETE`, so two concurrent
  `/api/auth/verify` calls carrying the same nonce can no longer both mint a
  session.

**Wallet data + linking**

- Native-coin prices had no fallback: one CoinGecko 429 (routine on the
  keyless free tier) priced ETH at 0, reported the wallet as $0, and silently
  dropped the portfolio pillar — 25% of the score — to a neutral 50. Added the
  DefiLlama tier that ERC-20s already had.
- `/api/wallet-score` read `?tier=1` while `/api/portfolio` reads `?tier=all`,
  so a default call scored DeFi positions over 11 chains and the portfolio over
  5 — two pillars computed on different chain sets, at ~2× the intended
  subrequest budget. Both now share one contract.
- Alchemy token metadata was fetched one subrequest per token (up to 100 per
  chain), blowing the 50-subrequest Worker limit on the first chain and leaving
  the rest of a wallet's chains unscanned. Batched 25 per request.
- Etherscan's `proxy` module speaks raw JSON-RPC and never sets `status`, so a
  reverted or rate-limited `eth_call` returned `undefined` as though it were a
  successful empty result — a failed `balanceOf` became "holds 0 of that token".
- `/api/wallet-score` now persists to `health_scores`, so `/badge/{addr}.svg`
  and the score history are populated by the endpoint the dashboard actually
  calls (previously only the legacy Ethereum-only `POST /api/health-score` wrote).
- Re-linking an already-linked wallet returns success instead of an error — it
  is the desired end state, and a double-click surfaced as "link_failed".
- Unlinking a wallet now deactivates its alert rules. `alert_rules.wallet_address`
  is not a foreign key, so the 5-minute cron kept scanning and emailing about
  wallets the user had explicitly disconnected.
- `POST /api/account/delete` (DSAR erasure) was hard-wired to a 503 saying it
  needed SIWE proof of ownership. SIWE has shipped, so it is implemented:
  session-gated, erases the user and every wallet they have proved ownership of.
- The daily retention cron never pruned `siwe_nonces` or expired `sessions`;
  both grew unbounded on the hot path of every signed-in request.

**Tests**

- `npm test` — four suites booting the real worker against a `node:sqlite`-backed
  D1 shim running the real `migrations/`. Requires Node >= 22.5.

## Unreleased — DeFiScoring Overhaul

The overhaul is being shipped in numbered phases. Each phase lands as one or
more focused commits on `main`. Phase 0 is read-only.

### Phase 0 — Audit (no code changes)

- `AUDIT.md` written. Covers Jekyll config + Ruby drift, the 1.9 kLOC
  Cloudflare Worker (routes, bindings, CORS, secrets, write endpoints), the
  vanilla-JS dashboard surface, the five existing D1 migrations, third-party
  scripts and SRI gaps, link health, and security headers.
- Top finding: the headers declared in `cloudflare.toml` are almost certainly
  not being shipped in production because the live deploy uses
  Cloudflare Workers (`wrangler.jsonc`), which does not read `cloudflare.toml`,
  `_headers`, or `_redirects` (both empty in the repo). Phase 1 fixes this by
  injecting headers from inside the Worker.

### Phase 1 — Hygiene & hardening

**Worker / API**

- New: security-header middleware applied to every static + API response —
  `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`,
  `Content-Security-Policy` (per-origin allowlist; jsdelivr + unpkg for the
  dashboard libs, Google Fonts, the Worker subdomain + chain RPCs in
  `connect-src`, `frame-ancestors 'none'`, `object-src 'none'`,
  `upgrade-insecure-requests`), `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=(),
  usb=(), interest-cohort=()`, `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Resource-Policy: same-site`. (`worker/index.js`,
  `applySecurityHeaders`.)
- New: real CORS allowlist driven by `env.ALLOWED_ORIGINS` (comma- or
  whitespace-separated). The previous `Access-Control-Allow-Origin: *` was
  hardcoded and the env var was dead config; now the var is the source of
  truth, the matched origin is echoed back, and `Vary: Origin` is set so
  caches key correctly. Wildcard is still accepted for transitional/dev use
  and will be removed when Phase 2 introduces session cookies (which are
  incompatible with `*`). (`worker/index.js`, `corsHeadersFor`,
  `wrangler.jsonc`.)
- New: `finalizeResponse` middleware in the `fetch()` entrypoint —
  every outgoing response (including those built by the legacy `json()`
  helper) is re-stamped with the request-aware CORS headers and the
  security-headers bundle. This was the fix for an issue caught in code
  review: the original allowlist only ran on `OPTIONS` / 429 / 404, while
  the bulk of API responses still went out with the legacy wildcard.
- New: KV-backed sliding-window rate limiter (`rateLimit`) wired into the
  expensive endpoints — `POST /`, `/profile`, `/api/profile`, `/api/exposure`,
  `/api/audit`, `/api/health-score`, `/api/chatbot/message`,
  `/api/report-issue`. 20 req/IP/min for AI endpoints, 5 req/IP/min for
  GitHub-issue creation. Returns 429 + `Retry-After` when exceeded.
  (`worker/index.js`.)

**Frontend / supply chain**

- Pinned `lucide` from `@latest` to `0.474.0` and added Subresource Integrity
  (`integrity="sha384-…"` + `crossorigin="anonymous"`
  + `referrerpolicy="no-referrer"`) to all four CDN scripts loaded by
  `_layouts/dashboard.html` (chart.js, jspdf, jspdf-autotable, lucide). A
  compromised CDN can no longer inject arbitrary JS into the dashboard.

**Accessibility**

- Skip-to-content link added to `_layouts/default.html` (target `#main`) and
  `_layouts/dashboard.html` (target `#defi-main`). Hidden until keyboard
  focus, then visible at top-left with brand cyan + gold focus ring.
- `:focus-visible` baseline added to `assets/css/footer.css` so every
  button / link / input shows a clear 2px cyan ring under keyboard
  navigation, even where component CSS reset `outline: none`.

**Privacy / consent**

- The opt-in telemetry banner (previously dashboard-only) is now also
  included from `_layouts/default.html`, so the consent prompt is shown
  consistently across the public landing area as well — the banner stays
  hidden until a wallet is connected, no analytics fire without explicit
  opt-in, and the choice is persisted under `defi:intel:consent` in
  `localStorage`.

**Deferred to a Phase 1 follow-up (called out so they aren't forgotten)**

- _Nonce-based CSP._ Current CSP still allows `'unsafe-inline'` for inline
  JSON-LD blocks and the small bootstrap scripts in the layouts. Migrating
  to `'strict-dynamic'` + per-request nonce via `HTMLRewriter` is queued.
- _Image transcoding to WebP/AVIF + responsive `srcset`._ The largest assets
  in `attached_assets/` are excluded from the build by `_config.yml`; the
  in-build candidate (`assets/media/movie.jpg`) is the only material win.
  Needs `sharp` / `imagemagick` in the toolchain — separate PR.
- _`bundle update` + `bundle audit`._ Risky alongside the other Phase 1
  changes; will land as its own commit after smoke-testing the build with
  Ruby 3.3.5 (current Replit workspace runs 3.2.2 vs CI's 3.3.5 — also
  flagged).
- _Live `axe-core` sweep._ Needs a headless browser; recommended to wire
  `@axe-core/cli` into CI alongside `lighthouse-ci`.
- _`privacy.md` + `terms.md` rewrite._ The Phase 1 spec itself notes these
  should be updated to "match what the site actually does once wallet
  connect + dashboard ship" — i.e. after Phases 2 and 3 land.

### Phase 2 — Read-only SIWE wallet auth (planned, not yet implemented)
### Phase 3 — Admin SPA at `/admin` with R&D data capture (planned)

### Phase 4 — Compliance &amp; safety rails

Phase 4 was scoped against the assumption that Phases 2 (SIWE auth) and 3
(admin SPA + `wallet_snapshots` table) had already shipped. They have not, so
this phase ships every safety rail that stands on its own and registers
fail-closed routes for the items that genuinely need wallet-ownership proof.

**Sanctions screening (OFAC SDN, fail-closed)**

- `worker/index.js` ships an inline `SANCTIONED_ADDRESSES` set seeded with the
  Aug 2022 OFAC Tornado Cash designation and runs `extractAddressFromRequest()`
  on every incoming request before any handler. URLs and JSON bodies are both
  checked; matches return a generic `403 { success:false, error:"Request
  blocked." }` with no detail about why. The list is intentionally swappable
  for a KV-backed live feed (Chainalysis / TRM / OFAC SDN XML) without
  changing the `isSanctioned()` interface.

**Per-address + per-IP rate limits**

- New `rateLimitByAddress()` runs alongside the existing per-IP `rateLimit()`
  so a botnet rotating IPs but reusing a wallet still hits the cap, and a
  single host hammering many wallets still hits the per-IP cap.
- Wired into the address-aware endpoints: `/api/intel/event` (≈ /api/track,
  30/min/IP + 60/min/address), `/api/report-issue` (≈ /api/feedback,
  5/min/IP + 10/hour/address), and the existing AI / score / profile /
  audit / chatbot endpoints (20/min/IP + 30/min/address default).

**Data retention &amp; nightly Cron Trigger**

- `wrangler.jsonc` now declares `triggers.crons: ["17 3 * * *"]` and a
  `DATA_RETENTION_DAYS=180` var. The new `scheduled()` handler in
  `worker/index.js` calls `runRetentionPrune(env)` which deletes
  `intel_events` and `health_scores` rows older than the cutoff. The
  `intel_daily_aggregates` rollup table is intentionally untouched — those
  aggregates are kept indefinitely per the data retention policy.
- Operations can run the prune on demand via
  `POST /api/account/retention/run` (gated by the existing `ADMIN_TOKEN`
  secret).

**DSAR endpoints**

- `GET /api/account/export?address=0x…` returns a JSON dump of every row in
  D1 that references the address (`health_scores`, `watchlists`,
  `community_votes`, plus `intel_events` resolved by recomputing the
  `HMAC-SHA256(sha256(addr), INTEL_SALT)` double-hash). Read-only; no auth.
  Anyone can call this for any address — but the response reveals nothing
  not already on the public chain. The signed-link-via-email variant from
  the spec is queued behind Phase 2 (SIWE) + a mail integration.
- `POST /api/account/delete` returns a fail-closed `503` with a message
  pointing the user at `privacy@defiscoring.com` for manual deletion. Soft-
  delete with a 30-day purge cannot ship safely without SIWE proof of
  wallet ownership — otherwise anyone could delete anyone's data.

**Disclaimer surfacing on every scoring output**

- The `json()` helper now stamps `disclaimer: "Not financial advice. …"`
  onto every successful response that contains a scoring-shaped field
  (`score`, `scores`, `profile`, `audit`, `breakdown`, `riskProfile`,
  `history`). The full text continues to live at `/disclaimer/`. The
  footer disclaimer remains on every public page, and the dashboard's
  "Not Financial Advice" callout is unchanged.

**Account &amp; Privacy pages (`/account/`, `/account/privacy/`)**

- New `account/index.html` — landing page that links to the privacy
  preferences, the DSAR export endpoint, and the email-based deletion
  flow, plus a plain-language data retention summary.
- New `account/privacy.html` — granular consent UI with two toggles:
  - Anonymized usage telemetry (`defi:intel:consent`, the existing
    dashboard banner key).
  - "Share anonymized wallet snapshots with DeFiScoring research"
    (`defi:research:consent`, default off, revocable). The snapshot
    table itself lands with the admin SPA in Phase 3; consent is captured
    now so we have it on file from day one.

**Deferred to a follow-up (called out so they aren't forgotten)**

- _Account-bound DSAR delete with 30-day purge._ Needs SIWE.
- _Email-delivered signed download link for DSAR export._ Needs a mail
  integration (Resend / SES / Mailgun) and an account model.
- _`wallet_snapshots` table + the 24-hour delete job triggered by revoking
  the research consent._ Needs the table, which is a Phase 3 deliverable.
- _Login-time SDN check that fails closed with a generic error._ Login
  itself doesn't exist yet (Phase 2). The same `isSanctioned()` helper
  will be reused at the SIWE handler when it ships.

### Phase 5-6 — TBD per spec
