# Production deployment — Cloudflare Worker (unified)

Production is served entirely by the Cloudflare Worker defined in [`wrangler.jsonc`](../wrangler.jsonc). A single `wrangler deploy` (triggered by [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) on every push to `main`) runs `bundle exec jekyll build` and ships the `_site` output plus all API routes from one origin.

## Canonical URLs

| Surface | URL |
| --- | --- |
| Site + dashboard | `https://defiscoring.com` |
| API | `https://defiscoring.com/api/…` (same origin) |
| Badge SVG | `https://defiscoring.com/badge/{wallet}.svg` |
| Share card | `https://defiscoring.com/card/{wallet}.svg` |
| Health | `https://defiscoring.com/health` |
| Staging alias | `https://defiscoring.guillaumelauzier.workers.dev` |

`www.defiscoring.com` is redirected to the apex by the Worker.

## GitHub Pages — decommission checklist

The repo previously published static HTML to GitHub Pages while the Worker served API routes on a subdomain. That split is retired. After merging the unified deployment:

1. **GitHub repo → Settings → Pages** — remove the custom domain `defiscoring.com` and disable Pages (or set source to “None”).
2. **Cloudflare DNS** — ensure apex and `www` point at the Worker custom domain (automatic once routes in `wrangler.jsonc` are deployed). Remove any CNAME to `*.github.io`.
3. **Verify** — `curl -sI https://defiscoring.com/health` returns `200` with Worker security headers and **no** `x-github-request-id` header.

The [`CNAME`](../CNAME) file has been removed from the repo so GitHub Pages cannot reclaim the domain on the next Pages build.

## Legacy config files (not used in production)

These files are **not** read by the Cloudflare Worker deploy path:

- [`cloudflare.toml`](../cloudflare.toml) — Cloudflare Pages format; headers here do not ship.
- [`github.toml`](../github.toml) — GitHub Pages / Netlify-style config.

Security headers, CORS, and caching are injected by [`worker/index.js`](../worker/index.js) via `applySecurityHeaders` / `finalizeResponse`.

## Required secrets

See [`SECRETS.md`](../SECRETS.md). CI needs `CLOUDFLARE_API_TOKEN` in GitHub Actions secrets.

## Local development

```bash
bundle install --path vendor/bundle
npm ci
npm run migrate:local
bundle exec jekyll build
npx wrangler dev --local --port 8787
```

Set `window.DEFI_API_BASE = "http://127.0.0.1:8787"` in the browser console when testing the dashboard against local wrangler dev.
