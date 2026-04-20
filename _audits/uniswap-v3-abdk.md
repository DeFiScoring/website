---
protocol: Uniswap V3
protocol_slug: uniswap-v3
auditor: ABDK Consulting
date: 2021-03-16
scope: v3-core (math libraries, oracle, Pool)
severity_breakdown:
  high: 0
  medium: 0
  low: 4
  informational: 13
status: Resolved
report_url: https://github.com/Uniswap/v3-core/blob/main/audits/abdk/audit.pdf
title: Uniswap V3 — ABDK Consulting audit
---

ABDK reviewed the math-heavy portions of Uniswap V3, with particular focus on
fixed-point arithmetic, the TWAP oracle, and price-tick computations. No
high-severity issues were identified; lower-severity items were patched.
