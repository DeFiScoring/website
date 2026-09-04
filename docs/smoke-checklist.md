# Live smoke checklist

Everything in the redesign — phases 0 and A–G — was verified against `_site`
served locally in Chromium with a stubbed API. That is real verification of
rendering and behaviour, but it is **not** verification of production: the
agent environment's egress proxy rejects both `workers.dev` and
`defiscoring.com`, so nothing here has ever been opened against the deployed
site.

This is that pass. It is ordered so a failure early explains the failures
below it — if step 0 fails, nothing else means anything.

Each item names **what proves it**, because the point is not "does the page
look right" but "does the real worker return the shape the stub returned".

---

## 0. Which host actually serves?

Open both:

- `https://defiscoring.com/`
- `https://defiscoring.guillaumelauzier.workers.dev/`

| Result | Meaning |
|---|---|
| Both serve | Cutover complete, staging alias intact. Continue. |
| Apex only | Fine. `workers_dev: true` is now set in `wrangler.jsonc`, so the alias returns on the next deploy. |
| workers.dev only | DNS cutover has not finished — see `docs/DEPLOYMENT.md`. |
| **Neither** | **The site is down.** Stop and fix before anything else. |

Also check `https://defiscoring.com/health` returns `{"ok":true}`, and that
`curl -sI https://defiscoring.com/` shows **no** `x-github-request-id` header
(that header means GitHub Pages is still answering, not the Worker).

## 1. Is the backend reachable at all?

`/dashboard/` with a wallet connected. The five pillars must render with real
values, not the empty state.

This is Phase 0's whole premise: `API_BASE === ""` was being read as "no
backend" rather than "same origin", so the dashboard had never rendered the
five-pillar score. If this fails, everything below is meaningless.

## 2. The credential

`/dashboard/score/` — gauge, band pill carrying **glyph + label + colour**,
coverage strip, five pillar cards, and the adjustments ledger reconciling on
screen to the number above it.

A wallet at 850 shows the clamp row; most will not. Do not treat its absence
as a failure unless the wallet is actually at a clamp.

## 3. The unscored state

Same page and `/dashboard/`, with a wallet that has never been scored. It must
read **`Not scored`** in **`#7c8a9b`** in both places. That was the one
deliberate visible copy-and-colour change in Phase C, and the two surfaces
used to disagree.

## 4. Badge and share card

Open each **as its own document** — not inlined into a test page:

- `/badge/<addr>.svg`
- `/card/<addr>.svg`

Every badge SVG contains `<clipPath id="r">`; inlining several into one HTML
document makes every `url(#r)` resolve to the first one, which looks exactly
like text clipping. Served individually each is its own document, so this is
only ever a harness artefact.

Check the chip row (`Coverage … · Band … · Model …`) and the SVG mark inside
the gauge. Then an **unscored** address: 200, grey card, and **no chip row at
all** — three chips asserting ignorance make an unscanned wallet look like a
data failure.

Then paste a card URL into Slack or Discord. The mark is `<path>` geometry
precisely because their renderers have no font we control; `★` and `◆` are
outside WGL4 and would tofu.

## 5. Badge embed snippets

`/badge/`, paste an address, and check the three snippets (Markdown, HTML,
BBCode) are **absolute** — `https://defiscoring.com/badge/0x….svg`.

Paste the Markdown one into a real GitHub README or gist preview and confirm
the image loads. Relative URLs render fine on our own page and 404 everywhere
they are actually meant to be used, which is how this shipped broken.

## 6. Community votes

`/dashboard/risk-profiler/`. The vote widgets must show real aggregates. If
any reads **"Worker URL not set on this page."**, the same-origin fix has
regressed.

## 7. Alerts

`/dashboard/alerts/`:

- `webhook` appears in the channel `<select>`, `protocol_event` in the
  rule-kind `<select>`.
- On a below-Plus account the webhook row is **visible and locked**, not
  hidden — the capability should be visible before it is bought.
- Create a rule; the table renders `last_value`, `updated_at`, and the
  cooling-down state. A rule that is armed, matching and still silent is the
  state that confuses people most, so it must not read as "not firing".

## 8. Chrome

Sidebar shows `Curated dossiers · not live feeds` on the RWA group and
`Scores read 5 chains`. Footer tagline names the chains.

## 9. Dashboard home

`/dashboard/`:

- Contribution bars **differ per pillar** — this chart used to plot the same
  five weights for every wallet on the platform.
- The watched-wallets tile reads from `/api/quota`.
- The trend either draws, or says *the chart library did not load*. It must
  never say "no snapshots yet" when snapshots exist — that is a false
  statement about the user's own data.

## 10. Landing page

`/`:

- Gauge animates to **712**, labelled `Good · B`, and the pillar strip below
  it reads 65 / 90 / 79 / 85 / 50 with Governance marked estimated and
  coverage 90%. Those numbers are checked against the engine by
  `test/facts.mjs`; this is confirming they render.
- At 390px: no horizontal scroll, guarantees stack.
- No "private beta", "no signups", or "free" claim anywhere. Also check the
  Google rich result for the site — the FAQ JSON-LD is republished by search
  engines, so a stale answer outlives the page.

## 11. Pricing

`/pricing/` at 390px: **no horizontal scroll**, compare table restacks per
tier, Enterprise in its own strip.

Signed in: `#pr-current-plan` appears and the current tier's CTA reads
"Current plan". Signed out: it stays hidden.

## 12. API keys — only after the migration in §B below

Issue a key in `/dashboard/settings/`, then:

```
curl -H "Authorization: Bearer dfs_live_…" \
  "https://defiscoring.com/api/wallet-score?address=0x…"
```

- Plus account → `200`.
- Free or Pro key path → `402 api_access_not_in_plan`.
- Exhausted budget → `429 api_quota_exceeded` **with a `Retry-After` header**.

This is the item that decides whether the pricing page can honestly add
"100 API requests/day" to the Plus column. It is deliberately absent today.

---

# Infrastructure actions

Three pending items. The order is not arbitrary.

## A. Restrict Workers Builds to `main` — first

Cloudflare dashboard → Workers & Pages → `defiscoring` → Settings → Builds.
Set the production branch to `main` and disable non-production branch builds.

**Do this first.** Every draft PR in this effort deployed straight to
production — the Cloudflare bot posted "Deployment successful" on drafts #41
and #42 before either was reviewed. Doing it before the migration also stops
an in-flight branch deploying over a freshly migrated database.

## B. Apply migration `0013_api_keys.sql`

```bash
npm run migrate:remote      # wrangler d1 migrations apply defi_health --remote
```

Wrangler applies only unapplied migrations, so this should report `0013`
alone; `0001`–`0012` are already live.

**Use `--remote`.** `npm run migrate:local` writes to the miniflare copy and
its output looks identical.

Verify by listing tables — `api_keys` and `api_key_usage` — or just by running
smoke item 12.

Until this runs, `authenticateApiKey`'s first statement selects from a table
that does not exist, so **every API key errors**, and the Plus quota claim
stays off the pricing page.

## C. Set `ALCHEMY_KEY`

```bash
wrangler secret put ALCHEMY_KEY
```

Paste the value **at the interactive prompt**. Never as a command argument, an
environment variable, or into any agent prompt — prompts are stored in history.

`SECRETS.md` lists it as a required server-only secret, used by
`worker/lib/providers.js` for token balances and RPC. It is last because it
improves data quality on paths that already degrade gracefully, whereas A and
B change what can be deployed and what the database can store.

Then redeploy once (`npm run deploy`) so the worker picks up the secret, and
run this checklist top to bottom.
