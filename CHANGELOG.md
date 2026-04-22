# Changelog

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
### Phase 4-6 — TBD per spec
