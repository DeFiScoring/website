---
layout: default
title: Scoring Methodology
permalink: /methodology/
description: "How DeFi Scoring calculates protocol safety scores from security, governance, economics, and maturity signals."
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
</style>

<div class="legal-page" markdown="1">

# DeFi Scoring Methodology

<div class="legal-meta">Version 1.0 · Last Updated: April 20, 2026</div>

At DeFi Scoring we believe that transparency is the ultimate hedge against risk. Our scoring system is designed to move beyond Total Value Locked (TVL) and focus on the technical, economic, and governance health of a protocol.

The **DeFi Scoring Safety Rating** is a quantitative index ranging from **0 (high risk)** to **100 (verified safety)**.

## 1. The Four Pillars of Risk

<div class="pillar-grid">
  <div class="pillar"><div class="weight">35%</div><h4>Security &amp; Code Integrity</h4><p>Audit quality, bug-bounty coverage, AI code-pattern scan.</p></div>
  <div class="pillar"><div class="weight">30%</div><h4>Decentralization &amp; Governance</h4><p>Admin keys, timelocks, governance participation.</p></div>
  <div class="pillar"><div class="weight">25%</div><h4>Market &amp; Economic Health</h4><p>Liquidity concentration, TVL stability, oracle reliability.</p></div>
  <div class="pillar"><div class="weight">10%</div><h4>Protocol Maturity</h4><p>Days under live fire, Lindy resilience through volatility events.</p></div>
</div>

### A. Security & Code Integrity (35%)

- **Audit quality.** We don't just count audits, we weigh them. An audit from a top-tier firm (e.g. OpenZeppelin, Trail of Bits) carries more weight than a self-published report.
- **Bug-bounty programs.** Protocols with active, high-reward bug bounties (via platforms like Immunefi) receive a score boost.
- **AI-driven code scan.** Using our Cloudflare Workers-AI auditor, we scan for red-flag patterns in the Solidity code such as `selfdestruct` functions or unverified implementation contracts.

### B. Decentralization & Governance (30%)

- **Admin-key security.** Is the protocol controlled by a single EOA or a secure multi-sig?
- **Timelocks.** We check for the presence of a timelock (minimum 48 hours). Protocols that can change their logic instantly receive a significant penalty.
- **Governance participation.** Using Snapshot data, we measure how decentralised the decision-making process truly is.

### C. Market & Economic Health (25%)

- **Liquidity concentration.** If 80% of the TVL is held by 5 “whale” wallets, the score is penalised due to exit-risk volatility.
- **TVL stability.** We track the 7-day and 30-day TVL trends. Rapid bleeding of assets often precedes a protocol failure.
- **Oracle reliability.** We verify if the protocol uses decentralised oracles (Chainlink/Pyth) or relies on easily manipulated spot-price pools.

### D. Protocol Maturity (10%)

- **Days since genesis.** The longer a protocol survives under live fire (with millions in TVL) without an exploit, the higher its trust score.
- **Lindy effect.** We reward protocols that have successfully navigated major market crashes or volatility events.

## 2. The Calculation Formula

The final score `S` is a weighted average of the four pillars:

<div class="formula">
S = (Security × 0.35) + (Decentralization × 0.30) + (Economics × 0.25) + (Maturity × 0.10)
</div>

| Score Range | Rating | Actionable Insight |
| :--- | :--- | :--- |
| **90 – 100** | **AAA** | Industry standard. Low trust assumptions. |
| **70 – 89**  | **B**   | Solid protocol, but may have minor centralisation risks. |
| **50 – 69**  | **C**   | Caution advised. Significant admin privileges or low audit count. |
| **Below 50** | **D / F** | High risk. Potential for rug-pull or major technical failure. |

## 3. Data Sources

To ensure neutrality, we pull data from multiple independent sources via our Cloudflare Web3 infrastructure:

- **On-chain data:** Cloudflare Web3 Gateways (Ethereum, Arbitrum, Polygon).
- **Metric aggregation:** DeFiLlama API.
- **Governance:** Snapshot &amp; Tally subgraphs.
- **Verification:** Etherscan &amp; Sourcify.
- **AI inference:** Cloudflare Workers AI (`@cf/meta/llama-3.1-8b-instruct-fast`) for narrative summaries.

## 4. Limitations

While our methodology is rigorous, no algorithm can predict a zero-day exploit. A high score indicates that a protocol has followed best practices and demonstrated historical resilience, but it is **not a guarantee of fund safety**. Users should always perform their own due diligence — see the [Financial Disclaimer](/disclaimer/).

</div>

{% include site-footer.html %}
