---
layout: default
title: Scoring Methodology
permalink: /methodology/
description: "How DeFi Scoring computes the 300–850 wallet score from five on-chain pillars, and the separate 0–100 protocol safety score."
---

<style>
  .legal-page { max-width: 860px; margin: 0 auto; }
  .legal-page h1 { font-size: clamp(28px, 3.4vw, 40px); margin: 0 0 8px; }
  .legal-page .legal-meta { color: #6f7aa0; font-size: 13px; margin-bottom: 32px; }
  .legal-page h2 { margin-top: 36px; font-size: 22px; }
  .legal-page h3 { margin-top: 22px; font-size: 17px; color: #e6ebff; }
  .legal-page p, .legal-page li { color: #c8d2f5; font-size: 15px; line-height: 1.7; }
  .legal-page ul { padding-left: 22px; }
  .legal-page strong { color: #fff; }
  .legal-page code {
    background: rgba(255,255,255,.06); padding: 1px 5px; border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; color: #e6ebff;
  }
  .legal-page table {
    width: 100%; border-collapse: collapse; margin: 18px 0; font-size: 14px;
    background: rgba(255,255,255,.02); border: 1px solid rgba(255,255,255,.08);
    border-radius: 10px; overflow: hidden;
  }
  .legal-page th, .legal-page td {
    padding: 11px 14px; text-align: left;
    border-bottom: 1px solid rgba(255,255,255,.06);
  }
  .legal-page th { color: #c8d2f5; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  .pillar-grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); margin: 18px 0 4px; }
  .pillar {
    background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08);
    border-radius: 12px; padding: 16px;
  }
  .pillar h4 { margin: 0 0 4px; font-size: 14px; color: #fff; }
  .pillar .weight { font-size: 26px; font-weight: 700; color: #5b8cff; }
  .formula {
    background: rgba(91,140,255,.08); border: 1px solid rgba(91,140,255,.3);
    border-radius: 10px; padding: 16px 18px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 14px; color: #e6ebff; margin: 18px 0;
  }
  .callout {
    background: rgba(250,204,21,.07); border: 1px solid rgba(250,204,21,.28);
    border-radius: 10px; padding: 14px 18px; margin: 18px 0;
  }
  .callout p:last-child { margin-bottom: 0; }
  .band-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 8px; vertical-align: middle; }
</style>

<div class="legal-page" markdown="1">

# DeFi Scoring Methodology

<div class="legal-meta">Version 2.0 · Last Updated: August 20, 2026</div>

DeFi Scoring publishes **two separate scores**. They answer different questions, run on different data, and are never mixed:

| Score | Range | Subject | Endpoint |
| :--- | :--- | :--- | :--- |
| **Wallet Score** | 300 – 850 | A single wallet address | `GET /api/wallet-score` |
| **Protocol Safety Score** | 0 – 100 | A DeFi protocol | `GET /api/score/{slug}` |

Most of this page documents the **wallet score**, which is what the dashboard, the trend chart, and the public badge all display. The protocol score is documented separately in [section 3](#protocol-safety-score-0100).

---

## 1. Wallet Score (300–850)

The wallet score is a FICO-style index computed from on-chain activity only. There is no off-chain data, no KYC, no self-reported input, and no manual override.

### 1.1 Chain coverage

By default the score is computed across the five **Tier 1** chains:

**Ethereum · Optimism · Arbitrum One · Base · Polygon**

Passing `?tier=all` extends the scan to all eleven supported chains, adding BNB Chain, Avalanche, Gnosis, Linea, Scroll, and zkSync Era. `?chains=` accepts an explicit comma-separated list.

One pillar is not multi-chain by construction: **governance** reads Snapshot, which is chain-agnostic. **Account age** queries all five Tier 1 chains regardless of the requested tier, since a wallet's age is a property of its whole history rather than of the chains being scored.

### 1.2 Real signals vs. neutral defaults

Every pillar is tagged `real: true` or `real: false` in the API response.

- **`real: true`** — we found data and scored it.
- **`real: false`** — the signal was absent or the source failed. The pillar falls back to a **neutral 50**, never an invented number, and the dashboard shows it as uncovered.

A neutral 50 is deliberately mid-range: it neither rewards nor punishes a wallet for a signal we could not observe.

### 1.3 The five pillars

<div class="pillar-grid">
  <div class="pillar"><div class="weight">35%</div><h4>Loan Reliability</h4><p>Aave V3 health factor and debt utilisation across chains.</p></div>
  <div class="pillar"><div class="weight">25%</div><h4>Portfolio Health</h4><p>Diversification, portfolio size, multi-chain presence.</p></div>
  <div class="pillar"><div class="weight">15%</div><h4>Liquidity Provision</h4><p>Uniswap V3 concentrated-liquidity positions.</p></div>
  <div class="pillar"><div class="weight">15%</div><h4>Account Age</h4><p>Days since the wallet's first Ethereum transaction.</p></div>
  <div class="pillar"><div class="weight">10%</div><h4>Governance</h4><p>Snapshot voting record across DAOs.</p></div>
</div>

Each pillar produces a **0–100** sub-score. The weights sum to exactly 1.00.

#### A. Loan Reliability — 35%

**Input:** every Aave V3 position found on the scanned chains — collateral, debt, and health factor.

We score the **riskiest** position, not the average: the lowest health factor across all chains sets the band. A wallet that is safe on four chains and about to be liquidated on a fifth is a liquidation risk.

| Condition | Sub-score | Coverage |
| :--- | :--- | :--- |
| No Aave V3 position on any chain | 50 | `real: false` |
| Supplying with **zero debt** | 80 | `real: true` |
| Lowest HF ≥ 3.00 | 95 | `real: true` |
| Lowest HF 2.00 – 3.00 | 85 | `real: true` |
| Lowest HF 1.50 – 2.00 | 65 | `real: true` |
| Lowest HF 1.25 – 1.50 | 40 | `real: true` |
| Lowest HF 1.00 – 1.25 | 20 | `real: true` |
| Lowest HF < 1.00 (liquidatable) | 0 | `real: true` |

A zero-debt supplier scores 80 rather than 100 by design: successfully managing a leveraged position is a stronger credit signal than never borrowing at all.

#### B. Portfolio Health — 25%

**Input:** priced token balances from the portfolio scan.

Three components combine:

<div class="formula">
portfolio_health = min(100, round(diversity × 0.5 + size × 0.5 + chain_bonus))
</div>

**Diversity** — the share of the portfolio held in the single largest position. Concentration is fragility.

| Top position share | Diversity |
| :--- | :--- |
| > 95% | 20 |
| 80 – 95% | 45 |
| 60 – 80% | 65 |
| 40 – 60% | 80 |
| ≤ 40% | 95 |

**Size** — portfolio depth distinguishes a real user from a burner address. It intentionally caps at $10k, because the goal is to detect genuine engagement, not to reward whales.

| Portfolio value | Size |
| :--- | :--- |
| ≥ $10,000 | 95 |
| $1,000 – $10,000 | 80 |
| $250 – $1,000 | 60 |
| $50 – $250 | 35 |
| < $50 | 10 |

**Chain bonus** — `+10` for activity on 3 or more chains, `+5` for 2, otherwise `0`.

If no portfolio value is detected at all, the pillar is `real: false` at a neutral 50.

#### C. Liquidity Provision — 15%

**Input:** the number of Uniswap V3 LP NFTs held, summed across the scanned chains.

| LP positions | Sub-score | Coverage |
| :--- | :--- | :--- |
| ≥ 20 | 95 | `real: true` |
| 5 – 19 | 80 | `real: true` |
| 2 – 4 | 65 | `real: true` |
| 1 | 50 | `real: true` |
| 0 | 50 | `real: false` |

A further **+5** (capped at 100) applies when LP positions exist on two or more chains.

Note that one LP position and zero LP positions both land on 50 — the difference is the coverage flag, which is what the dashboard reads.

#### D. Account Age — 15%

**Input:** the timestamp of the wallet's earliest transaction on any Tier 1 chain.

All five chains are queried in parallel and the **oldest** answer wins, so a wallet that started on an L2 keeps that age, and one that later bridged to Ethereum does not have its history reset to the bridging date. The chain the age came from is named in the pillar's rationale.

| Age since first transaction | Sub-score | Coverage |
| :--- | :--- | :--- |
| ≥ 3 years | 100 | `real: true` |
| 1 – 3 years | 85 | `real: true` |
| 6 – 12 months | 70 | `real: true` |
| 1 – 6 months | 50 | `real: true` |
| < 30 days | 25 | `real: true` |
| No transaction history on any Tier 1 chain | 20 | `real: true` |
| Every chain's lookup failed | 50 | `real: false` |

"No history found" is a real, observed answer and is scored as such. "Lookup failed" is not an answer, and falls back to neutral. With five chains queried, the distinction is drawn on the whole set: as long as one chain answers, an empty result is an observation; only when every lookup fails does the pillar go neutral.

#### E. Governance — 10%

**Input:** the wallet's Snapshot voting record (up to 1,000 votes), plus the number of distinct DAOs voted in.

| Snapshot votes | Sub-score | Coverage |
| :--- | :--- | :--- |
| ≥ 100 | 100 | `real: true` |
| 25 – 99 | 90 | `real: true` |
| 5 – 24 | 75 | `real: true` |
| 1 – 4 | 55 | `real: true` |
| 0 | 30 | `real: true` |
| Snapshot unavailable | 50 | `real: false` |

A confirmed zero-vote record scores 30 — below the neutral 50 — because non-participation is itself a (weak, lightly weighted) signal. A Snapshot outage is not, and returns neutral.

### 1.4 The composite formula

The five pillars fold into a raw health score `Hs` on a 0–100 scale, which is then mapped linearly onto the 300–850 range:

<div class="formula">
Hs = 0.35·Lr + 0.25·Ph + 0.15·Lp + 0.10·Gv + 0.15·Ag<br>
base = round(300 + (Hs ÷ 100) × 550)
</div>

The raw `Hs` value is returned in the API payload as `raw_h_s`, so any published score can be recomputed from its pillars.

### 1.5 Adjustments

Four adjustments apply to the base score. Each one that fires is listed explicitly in the `adjustments` array of the response, with its name, delta, and the value that triggered it — so a score is always fully reconstructable.

| Adjustment | Delta | Condition |
| :--- | :--- | :--- |
| `aave_safe_lender` | **+50** | Lowest Aave health factor **> 2.0** |
| `multichain_user` | **+30** | Portfolio active on **3 or more chains** |
| `over_concentrated` | **−50** | Largest single position **> 80%** of portfolio |
| `liquidation_risk` | **−150** | Any Aave health factor **< 1.0** |

The liquidation penalty is deliberately the largest single term in the model — larger than any pillar's full contribution — because an under-collateralised position is an active, time-sensitive risk rather than a historical pattern.

Adjustments are applied to the base score, and the result is then **clamped to the 300–850 range**. A wallet cannot fall below 300 or exceed 850 regardless of how many adjustments stack.

### 1.6 Bands

<div class="formula">
score = clamp(300, base + adjustments, 850)
</div>

| Band | Range | |
| :--- | :--- | :--- |
| <span class="band-dot" style="background:#2bd4a4"></span>**Excellent** | 720 – 850 | |
| <span class="band-dot" style="background:#00f5ff"></span>**Good** | 660 – 719 | |
| <span class="band-dot" style="background:#facc15"></span>**Fair** | 580 – 659 | |
| <span class="band-dot" style="background:#ff5d6c"></span>**Poor** | 300 – 579 | |
| <span class="band-dot" style="background:#7c8a9b"></span>**Unscored** | — | See §1.7 |

These four thresholds are defined once in the scoring engine and mirrored everywhere a band is displayed — dashboard, badge, and landing page — so the same wallet always reads the same band on every surface.

### 1.7 When we do not produce a score

<div class="callout" markdown="1">
**A wallet we cannot score returns `scored: false` and `score: null` — never an invented number.**
</div>

Credit bureaus settled this decades ago: a thin file is *unscorable*, not *poor*. Emitting a low number for an address we know nothing about would be a fabrication, and it would be indistinguishable from a genuine low score.

Two conditions produce an unscored result:

- **`no_onchain_history`** — our sources responded, and the wallet has no footprint: no portfolio value, no tokens, no DeFi positions, no governance votes, and no Ethereum transaction history. A brand-new address lands here.
- **`data_unavailable`** — no data source responded at all (RPC outage, rate limiting, missing API key). Scoring on zero real signals would grade our infrastructure rather than the wallet.

In both cases the response still includes **all five pillars** with their coverage flags and rationale, plus a plain-language `explanation`, so the dashboard can show exactly what was checked and what was found.

Unscored results are **not written to score history**. They do not appear in the trend chart, and the public badge continues to read "no scan yet" rather than displaying a placeholder number.

### 1.8 Persistence

A scored result is written to the wallet's score history, which backs the trend chart and the public badge at `/badge/{address}.svg`. The stored row keeps the pillar sub-scores, the raw `Hs`, the band, and the adjustment list alongside the final number.

---

## 2. Wallet Score Limitations

- **Aave V3 and Uniswap V3 only.** Two of the five pillars read specific protocols. A wallet that borrows exclusively on Compound, Morpho, or Spark scores `real: false` on loan reliability and receives a neutral 50 — not a penalty, but not credit for that activity either.
- **Account age stops at Tier 1.** All five Tier 1 chains are queried, but a wallet whose entire history predates its Tier 1 activity — living only on Gnosis, Linea, zkSync Era or another Tier 2 chain — is still under-rated.
- **Point-in-time.** The score reflects the moment of the scan. A health factor can deteriorate within a single block.
- **Prices depend on third-party feeds.** When every price tier is unavailable, tokens are still detected but unpriced, and portfolio health degrades to `real: false`.
- **No Sybil resistance.** The score describes an address, not a person. One person may hold many addresses, and one address may be controlled by many people.

A wallet score is an analytical signal, **not a creditworthiness guarantee and not financial advice** — see the [Financial Disclaimer](/disclaimer/).

---

## 3. Protocol Safety Score (0–100)

A separate, coarser score covering **protocols** rather than wallets, served from `GET /api/score/{slug}` and cached for six hours.

<div class="formula">
S = 0.4 · Trust + 0.3 · Liveness + 0.3 · Security
</div>

### 3.1 Trust — 40%

Half from contract age, half from audit count.

- **Age component** — scales linearly from 0 to 50 across the first two years of contract life, then caps.
- **Audit component** — 50 for two or more audits, 25 for one, 0 for none. Audit counts come from DeFiLlama.

### 3.2 Liveness — 30%

- **TVL-to-market-cap ratio** — up to 50 points, capped at a ratio of 2.0. When market cap is unavailable, a non-zero TVL earns partial credit of 25.
- **7-day TVL stability** — 50 points for flat or growing TVL, scaling down to 0 at a 20% or worse seven-day decline.

### 3.3 Security — 30%

Source-verification signals only:

- **+60** — contract source code is verified on the block explorer.
- **+40** — contract is not a proxy. Upgradeable proxies score 0 here, reflecting that their logic can change.

If source code cannot be retrieved, this pillar returns 0 and is flagged `real: false`.

### 3.4 Protocol bands

| Band | Range |
| :--- | :--- |
| <span class="band-dot" style="background:#2bd4a4"></span>**Green** | 80 – 100 |
| <span class="band-dot" style="background:#facc15"></span>**Yellow** | 50 – 79 |
| <span class="band-dot" style="background:#ff5d6c"></span>**Red** | 0 – 49 |

### 3.5 Protocol score limitations

This model reads **three signals**: contract age, audit count, and source verification, plus TVL movement. It is a coarse screen, not a security review.

It does **not** analyse admin-key custody, timelock configuration, oracle design, or governance-token distribution, and it does not perform static analysis of contract logic. A green band means a protocol is old, audited, verified, and financially stable — not that it is safe.

Contract-level pattern analysis is available separately through the AI contract auditor (`POST /api/audit`), which reviews Solidity source for centralisation, upgradeability, and oracle-risk patterns. **Its output does not feed this score.**

---

## 4. Data Sources

| Source | Used for |
| :--- | :--- |
| **Etherscan v2 API** | Native and token balances, contract calls, first-transaction age, source verification |
| **Aave V3 contracts** | Health factor, collateral, debt (read directly on-chain) |
| **Uniswap V3 contracts** | LP position counts (read directly on-chain) |
| **CoinGecko** | Token pricing (first tier) |
| **DefiLlama** | Token pricing (second and third tiers), protocol TVL, market cap, audit counts |
| **Snapshot** | Wallet governance voting records |
| **Cloudflare Workers AI** | Narrative summaries and the separate contract auditor — never score inputs |

Scores are computed at request time from these sources. No score is ever set, adjusted, or overridden by hand.

---

## 5. Changes in Version 2.0

Version 1.0 of this page described a four-pillar protocol model (Security 35% / Decentralization 30% / Market 25% / Maturity 10%) and a 0–100 protocol rating as the platform's primary score. That model was never the one in production: the wallet score has always used the five pillars documented in section 1, and the protocol score has always used the three pillars in section 3.

This version documents what the code computes. Where version 1.0 described signals we do not collect — timelock detection, admin-key custody analysis, oracle reliability grading, whale-concentration analysis of protocol TVL — those claims have been removed rather than restated, and the limitations sections now say plainly what each model does not look at.

</div>

{% include site-footer.html %}
