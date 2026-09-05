# Pricing, paywall and data packages

Written against the code, not against a template. Every entitlement number
below is expressed in `worker/lib/tiers.js`'s own limit keys so it can be typed
straight into `TIERS`.

**Provenance rule for this document.** Anything about *our* product is verified
against the repository and cited by file. Anything about *other companies'*
pricing is from my own knowledge, is marked `[recall]`, and should be checked
against a live pricing page before it is used in a board deck or a sales call.
Competitor pricing moves quarterly and I could not reach those sites from the
build environment.

---

## 0. The finding that should change the plan

**Paying for API access currently buys you 432× less throughput than taking it
for free.**

- Anonymous: `GET /api/wallet-score` is rate-limited at **30 requests/minute
  per IP** (`api.md:21`, `rateLimit()` in `worker/index.js`). That is
  **43,200 wallet scores per day** from a single IP.
- With a key on Plus ($49/mo): the shared limit is *replaced* by the account's
  metered budget of `bulk_api.requests.day = 100` — **100 scores per day**
  (`worker/lib/tiers.js`).

So the rational move for any integrator who wants volume is to not buy
anything. The paid tier is not a weak offer, it is a *negative* one, and no
amount of pricing-page copy fixes a plan that is strictly worse than the free
path beside it. Everything in §1 follows from closing this.

Two supporting facts, both verified:

- `rateLimit()` and `rateLimitByAddress()` key on (path, IP) and (path,
  address). **Neither reads a tier.** There is no rate-limit benefit to any
  paid plan today, which is why the "Higher scan rate limits" bullet was
  removed from the Pro card earlier in this effort.
- `migrations/0013_api_keys.sql` has **not** been applied to production D1.
  Until it is, `authenticateApiKey` selects from a table that does not exist,
  so in production today *presenting a key is an error*. The entire developer
  ladder below is blocked on that one migration.

---

## 1. The recommendation: split the ladder in two

The product has two buyers and one price list, and that is the root problem.

A credit score is worth a lot to whoever is **extending credit**, and
comparatively little to the **subject** of the score. This is not a theory
about DeFi; it is how the consumer bureaus work — Experian, Equifax and
TransUnion earn the large majority of revenue from B2B data services, not from
consumers buying their own score `[recall, high confidence]`. A borrower checks
their score, feels something, and leaves. A lender pulls scores forever.

So: **consumer plans exist to fund retention and the growth loop. The developer
plans exist to make money.**

### 1a. Consumer ladder

| | Free | Pro | Plus |
|---|---|---|---|
| **Price** | $0 | **$19/mo** (was $15) · $190/yr | **$49/mo** · $490/yr |
| `wallets.linked` | 1 | 3 | 10 |
| `history.days` | 7 | **90** (was 30) | 365 |
| `alerts.rules` | 0 | **25** (was 10) | 100 |
| `alerts.channels` | 0 | 2 | 10 |
| `ai.explain.day` | 0 | 20 | 200 |
| `simulator.runs.day` | 0 | 10 | 100 |
| `watchlist.size` | 5 | 50 | 500 |
| `bulk_api.requests.day` | 0 | 0 | **0** (moves to the developer ladder) |

**Value metric: wallets you monitor.** It grows with the customer's own
portfolio, it is predictable, and a user can tell in one sentence which tier
they need. History depth and alert count are the supporting metrics.

Three changes and their reasons:

- **Pro $15 → $19.** $15 reads as an impulse purchase; $19 reads as a tool and
  is still comfortably consumer. It is a 27% revenue increase per subscriber
  against, in my judgement, negligible conversion loss at this price elasticity
  `[recall, medium confidence]`. Grandfather existing subscribers — the
  goodwill is worth more than the delta on a small base.
- **Pro history 30 → 90 days.** 30 days is too short to show a trend a borrower
  can act on, which undermines the one thing Pro is selling. 365 stays the Plus
  differentiator.
- **Pro alerts 10 → 25.** Partly because 10 is stingy for a monitoring product,
  and partly because the in-product upgrade nudge was *already promising 25*
  (`assets/js/onboarding.js`). That was a false claim and has been corrected
  down to 10 with a guard; raising the limit to 25 is the alternative fix and
  the better one, if the ops cost of 2.5× the alert rules is acceptable. **Pick
  one deliberately** — the guard now fails the build if the copy and the code
  disagree again.

### 1b. Developer ladder — new, and where the revenue is

| | Build | Scale | Underwrite | Enterprise |
|---|---|---|---|---|
| **Price** | $0 | **$299/mo** | **$1,499/mo** | Custom |
| Scored wallets / month | 1,000 | 50,000 | 500,000 | By contract |
| Burst | 5 req/s | 25 req/s | 100 req/s | By contract |
| Bulk endpoint | — | ✓ | ✓ | ✓ |
| Score-change webhooks | — | ✓ | ✓ | ✓ |
| Historical time-series | — | ✓ | ✓ | ✓ |
| Model-version pinning | — | — | ✓ | ✓ |
| Uptime target | none | 99.5% | 99.9% | Contractual |
| Attribution required | ✓ | — | — | — |

**Value metric: scored wallets per month.** Not "API calls" — that is an
implementation detail the customer cannot forecast. Not seats — nothing here is
consumed by a human. Wallets-scored maps directly onto the customer's own
economics: a lender scoring more borrowers is underwriting more loans.

Why these numbers: at $299 for 50,000 the unit price is $0.006 per score, and
at $1,499 for 500,000 it is $0.003 — a volume discount that reads as fair and
still leaves a very large margin over the marginal cost of a cached edge read.
For comparison `[recall, medium confidence]`, the on-chain data market clusters
around a free tier, roughly $50–100 for an individual seat, roughly $300–800
for a team/professional tier, and four-to-five figures for institutional
contracts. $299 and $1,499 sit deliberately at the professional and
institutional rungs of that ladder rather than inventing a new one.

**Monthly, not daily.** `bulk_api.requests.day` with a rolling 24h window is
the wrong shape for a B2B buyer, who has monthly budget cycles and bursty
weekly load. A daily cap turns a normal Monday spike into a service outage the
customer cannot buy their way out of until tomorrow. Add
`bulk_api.requests.month` alongside the daily key and enforce the month.

---

## 2. Where the paywall goes

**Free forever, non-negotiable:**

- **The score itself.** It is the aha moment. A credit score you cannot see is
  not a product, and gating it kills the funnel at step one.
- **The public keyless endpoint for a single wallet**, at a rate that serves a
  human and not a scraper (see §4).
- **The badge and the share card** (`/badge/<addr>.svg`, `/card/<addr>.svg`).
  This is the growth loop: a user pastes their score into a README, a forum
  signature or a Discord profile, and every view is an impression we did not
  pay for. Anything that makes the badge harder to embed is a marketing cut
  disguised as a pricing decision.

**Behind the first paid tier:** *time* and *breadth*, never the number itself.
History depth, multiple wallets, and monitoring. This is exactly the
credit-monitoring model — the score is free, being *told when it moves* is what
people pay for, which is the whole business of the consumer credit-monitoring
category `[recall, high confidence]`.

**Behind the developer tiers:** *volume and integration*. Bulk, webhooks,
time-series, throughput, and the right to depend on it (SLA, model pinning).

The test to apply to any future gate: *does this block someone from
experiencing the product, or does it block someone from operating a business on
it?* Gate the second, never the first.

---

## 3. What changes from today

### Re-price only (no engineering)
- Pro $15 → $19; add annual billing at 10 months' price on both paid tiers.
  Requires new Stripe prices, not new code.
- `history.days` pro 30 → 90; `alerts.rules` pro 10 → 25. Two integers in
  `TIERS`.

### Must be built
| Item | Why | Where |
|---|---|---|
| `bulk_api.requests.month` | Daily caps are the wrong shape for B2B | `worker/lib/tiers.js`, `consumeQuota` |
| Bulk scoring endpoint | One request, N wallets. Today a customer must make N calls | new handler |
| Tier-aware rate limiting | `rateLimit()` is tier-blind, so burst tiers are unenforceable | `worker/index.js` |
| Score-change webhooks for API keys | Alert webhooks exist and are SSRF-guarded and signed, but they are wired to *user alert rules*, not to an API customer's watched set | `worker/handlers/alerts.js` has the delivery primitive to reuse |
| Free-tier key issuance | The Build tier needs keys on a $0 plan; issuance is Plus-gated today | `worker/lib/api-keys.js` |
| Model-version pinning | Underwriters cannot have the model change under a live book | `SCORE_MODEL_VERSION` is already persisted per row |

### Already built, and currently under-sold
- Key issuance, SHA-256 hashing, revocation with immediate `401`, and per-key
  usage attribution — all in `worker/lib/api-keys.js`, covered by
  `test/api-keys.mjs`.
- Rolling-window metering with `429` + `Retry-After`.
- Score history per wallet (`/api/health-score/{wallet}/history?days=`).
- Signed, SSRF-guarded webhook delivery.
- The `coverage` field — which is the single most underrated asset here. It
  tells an integrator how much of the score was backed by real data. **No
  competitor's score tells you how much to trust it.** That is a
  differentiator worth naming on the pricing page.

### Blocked
- **Everything with a key is blocked on `migrations/0013_api_keys.sql`.** Apply
  it before any of this ships (`npm run migrate:remote`).

---

## 4. Risks, and the arguments against this plan

**The free-rider hole is the precondition, not a footnote.** Closing it without
wrecking the free experience means separating *a human checking wallets* from
*a machine harvesting them*. The honest lever is the per-IP budget: 30/min is
far more than a person needs and far less than a scraper wants, which is the
worst of both. Something like 10/min per IP for keyless traffic still serves
every real human session, while making 43,200/day impractical. Combined with
the existing 10/min per address, this does not degrade the consumer product in
any way a user would notice. **Do this before charging for volume**, or the
Build tier's 1,000/month looks like a punishment.

**Counter-argument to my own recommendation, stated plainly:** the developer
ladder assumes demand that has not been demonstrated. There is no evidence in
this repository of a single B2B integration, and $1,499/mo tiers are usually
discovered through sales conversations rather than designed in advance. A
reasonable alternative is to ship *only* the Build tier ($0, 1,000/month,
attribution required), instrument who uses it, and let the actual usage
distribution set the paid tiers three months later. That is slower but it
prices from evidence instead of from my judgement. If you have no pipeline
today, take that path and treat §1b as the hypothesis it is.

**Regulatory.** The site uses "credit score" in 18 places. In the US, FCRA
attaches to *consumer reports used for credit decisions*, and a score sold to
lenders for underwriting is much closer to that line than a score shown to a
wallet owner. `disclaimer.md` currently covers investment advice
("educational and informational purposes only"), which is the wrong disclaimer
for this risk. Before selling to lenders: get counsel, and in the meantime
avoid "creditworthiness", "credit report", "credit file" and any adverse-action
framing in pricing and sales copy. Keep describing an on-chain behaviour score.
This is a flag for a lawyer, not legal advice from me.

**Churn without email.** SIWE means there may be no email address, so standard
dunning and win-back sequences do not exist. A failed card silently becomes a
downgrade. Capture an optional email at checkout explicitly for billing
notices, and treat the dashboard itself as the dunning channel.

**Enterprise is not "dedicated".** All tiers share `tier_quotas`, the same
worker, the same code path, with a larger integer. That wording was already
corrected on the pricing page; keep it corrected. Selling isolation would mean
building it.

---

## 5. Claude Design prompt

Copy-paste as-is.

> Design the **subscription plans** surface for DeFi Scoring, at **1440** and
> **390**. DeFi Scoring gives an Ethereum wallet a 300–850 credit score from
> five weighted pillars, read across five chains.
>
> **Aesthetic: terminal-grade, not template-grade.** Hairline rules instead of
> glass cards or drop shadows. Tabular monospace for every figure — prices,
> limits, quotas — so columns align down the page. Dark ground. Exactly one
> accent colour, and it is reserved for the score itself; plan cards earn
> emphasis through weight and rule contrast, not colour. No gradient buttons,
> no glow except on the score.
>
> **Two ladders on one page, clearly separated**, because there are two buyers:
> someone monitoring their own wallets, and a protocol scoring other people's.
> Give the developer ladder its own band with its own heading and a visible
> rule between them. Do not blend them into one six-column table.
>
> **Consumer ladder — three cards:**
> - **Free · $0** — Live credit score (300–850), 1 linked wallet, 7-day score
>   history, watchlist of 5, embeddable badge and share card. No alerts.
> - **Pro · $19/mo or $190/yr** — everything in Free, plus 3 linked wallets,
>   90-day history, 25 alert rules, 2 delivery channels (email + Telegram),
>   20 AI explanations/day, 10 simulator runs/day, watchlist of 50.
> - **Plus · $49/mo or $490/yr** — everything in Pro, plus 10 linked wallets,
>   365-day history, 100 alert rules, 10 channels including webhook delivery,
>   200 AI explanations/day, 100 simulator runs/day, watchlist of 500, PDF
>   report export, RWA research suite.
>
> Pro carries the only "most popular" treatment on this ladder.
>
> **Developer ladder — three cards plus a contact strip:**
> - **Build · $0** — 1,000 scored wallets/month, 5 req/s, attribution required,
>   no uptime target.
> - **Scale · $299/mo** — 50,000 scored wallets/month, 25 req/s, bulk endpoint,
>   score-change webhooks, historical time-series, 99.5% uptime target.
> - **Underwrite · $1,499/mo** — 500,000 scored wallets/month, 100 req/s,
>   everything in Scale plus model-version pinning and a 99.9% uptime target.
> - **Enterprise** — a contact strip, not a fourth column: volume by contract,
>   white-label embeds, custom scoring weights, SLA by contract.
>
> Show the unit economics inline and quietly — "$0.006 per scored wallet" under
> Scale, "$0.003" under Underwrite — in the dim text colour, not as a badge.
>
> **A monthly/annual toggle** at the top of the consumer ladder, defaulting to
> monthly, with annual showing the yearly figure and the words "2 months free".
> The developer ladder is monthly only; do not draw a toggle over it.
>
> **A comparison table** below both ladders, one row per real entitlement, in
> this order: linked wallets · score history · alert rules · delivery channels ·
> AI explanations per day · simulator runs per day · watchlist size · API
> access. Every cell carries a per-tier label so the table can restack into
> per-tier accordions at 390px rather than scrolling sideways. The page body
> must never scroll horizontally at 390px.
>
> **States to draw, all of them:**
> 1. Signed out — every card shows its own call to action.
> 2. Signed in on Free — the Free card reads "Current plan" and its button is
>    disabled; Pro and Plus show upgrade actions.
> 3. Signed in on Pro — same treatment moved to Pro, and Plus reads "Upgrade".
> 4. At-limit nudge — a user on Pro who has linked their third wallet, showing
>    an inline "3 of 3 wallets linked" state on the Pro card with the upgrade
>    path, not a modal.
> 5. A developer-plan card in its **quota-exhausted** state, showing used /
>    limit for the month and when the window resets.
>
> **Two rules about honesty, and they are the point of this design:**
> - Every number shown must come from the entitlement list above. Invent no
>   figure, and show no capability that is not in this brief.
> - Anything not yet shipped must be visibly marked **Planned** — a dim label,
>   not a bright badge — and must never be drawn as though it works today. In
>   this brief that applies to the bulk endpoint, score-change webhooks,
>   model-version pinning, custom scoring weights, white-label embeds and SSO.
>
> Also draw a short trust strip beneath the ladders, three items: the score is
> free and needs no account; every score reports its own **coverage**, so an
> integrator knows how much of it was backed by real data rather than a neutral
> default; and the methodology is published. Keep it factual and unadorned.
