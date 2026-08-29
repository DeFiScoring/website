---
layout: default
title: API Documentation
permalink: /api/
description: "Programmatic access to DeFi Scoring risk metrics, AI security narratives, and on-chain health scores."
---

<style>
  .legal-page { max-width: 920px; margin: 0 auto; }
  .legal-page h1 { font-size: clamp(28px, 3.4vw, 40px); margin: 0 0 8px; }
  .legal-page .legal-meta { color: #6f7aa0; font-size: 13px; margin-bottom: 32px; }
  .legal-page h2 { margin-top: 40px; font-size: 22px; }
  .legal-page h3 { margin-top: 26px; font-size: 17px; color: #e6ebff; }
  .legal-page p, .legal-page li { color: #c8d2f5; font-size: 15px; line-height: 1.7; }
  .legal-page ul { padding-left: 22px; }
  .legal-page strong { color: #fff; }
  .legal-page code {
    background: rgba(255,255,255,.06); padding: 1px 6px; border-radius: 4px;
    font-size: 13px; color: #e6ebff;
  }
  .legal-page pre {
    background: #0b1228; border: 1px solid rgba(255,255,255,.08);
    border-radius: 10px; padding: 16px 18px; overflow-x: auto;
    font-size: 13px; line-height: 1.55; color: #d6def5;
  }
  .legal-page pre code { background: transparent; padding: 0; color: inherit; }
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
  .endpoint {
    display: inline-block; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    background: rgba(91,140,255,.12); border: 1px solid rgba(91,140,255,.3);
    border-radius: 6px; padding: 2px 8px; font-size: 13px; color: #e6ebff;
  }
  .method-get {
    display: inline-block; background: #2bd4a4; color: #03110a;
    font-weight: 700; font-size: 11px; padding: 2px 8px; border-radius: 4px;
    margin-right: 6px; letter-spacing: .04em;
  }
</style>

<div class="legal-page" markdown="1">

# API Documentation

<div class="legal-meta">v1.0 · Cloudflare Workers backend · Updated April 20, 2026</div>

The DeFi Scoring API provides programmatic access to real-time risk metrics, AI-driven security narratives, and on-chain health scores. Our backend runs on Cloudflare Workers, so endpoints are served from the network edge with low latency worldwide.

## 1. General Information

- **Base URL:** `https://api.defiscoring.com/v1`
- **Format:** All responses are returned in `application/json`.
- **Rate limits:** 100 requests/minute on the free tier. For higher limits, contact `api@defiscoring.com`.

## 2. Authentication

**No key is required to read a score.** `GET /api/wallet-score` is public and
stays that way, under a shared per-IP rate limit.

A key changes *which budget you spend*, not what you can reach. Present one and
your requests are metered against your plan's own daily quota instead of the
shared public limit — which is what makes the API usable from a server that
would otherwise share an IP bucket with everyone else.

```
Authorization: Bearer dfs_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Keys are issued and revoked in **Settings → API keys** on the dashboard. Notes:

* The key is shown **once**, at creation. We store only a SHA-256 hash, so we
  cannot recover it for you — issue a new one and revoke the old.
* Revocation takes effect immediately; the next request with that key gets
  `401 api_key_revoked`.
* A key that is present but unknown or revoked is an **error**, never a silent
  fall back to anonymous access. If it were, a revoked key would appear to keep
  working intermittently.
* Daily quota is per **account**, not per key, so adding keys does not add
  budget. Per-key request counts are shown in the dashboard so you can tell
  which integration is spending it.

| Plan | Requests / day with a key |
|---|---|
| Free | — (no key issuance) |
| Pro | — (no key issuance) |
| Plus | 100 |
| Enterprise | Custom |

Quota responses:

```json
// 429 — daily budget exhausted (also sends a Retry-After header)
{ "success": false, "error": "api_quota_exceeded",
  "used": 100, "limit": 100, "retry_at": 1793491200000 }
```

## 3. Endpoints

### A. Get Protocol Risk Score

<span class="method-get">GET</span><span class="endpoint">/score/{protocol_slug}</span>

Returns the current aggregate risk score and pillar breakdown for a specific protocol.

**Example request:** `GET /v1/score/uniswap-v3`

**Success response:**

```json
{
  "protocol": "Uniswap V3",
  "slug": "uniswap-v3",
  "timestamp": "2026-04-20T16:00:00Z",
  "aggregate_score": 94,
  "rating": "AAA",
  "pillars": {
    "security": 98,
    "decentralization": 92,
    "economics": 95,
    "maturity": 90
  },
  "audit_count": 4,
  "last_audit_date": "2025-11-12"
}
```

### B. Get AI-Powered Security Assessment

<span class="method-get">GET</span><span class="endpoint">/ai-assessment/{contract_address}</span>

Returns a narrative summary generated by our AI Auditor regarding a specific contract.

**Example request:** `GET /v1/ai-assessment/0x1f9840...`

**Success response:**

```json
{
  "address": "0x1f9840...",
  "ai_model": "llama-3.1-8b-instruct-fast",
  "risk_summary": "Centralized admin keys detected with no timelock. High risk of parameter manipulation.",
  "red_flags": ["No-Timelock", "Single-Owner-Admin"],
  "score_impact": -25
}
```

### C. Get User Health Score

<span class="method-get">GET</span><span class="endpoint">/health/{wallet_address}</span>

Analyses a wallet's on-chain history to return a DeFi credit score (300 – 850, FICO scale).

**Example request:** `GET /v1/health/0x71C765...`

**Success response:**

```json
{
  "wallet": "0x71C765...",
  "health_score": 720,
  "status": "Healthy",
  "metrics": {
    "loan_reliability": "High",
    "gov_participation": 12,
    "liquidity_provision_duration": "450 days"
  },
  "alerts": [
    {
      "type": "Risk-Exposure",
      "message": "You have $500 in a protocol with a score < 40."
    }
  ]
}
```

## 4. Error Codes

| Code | Name | Description |
| :--- | :--- | :--- |
| **400** | Bad Request | Missing parameters or invalid address format. |
| **401** | Unauthorized | Invalid or missing API key. |
| **404** | Not Found | Protocol or contract not yet indexed. |
| **429** | Rate Limit | You have exceeded the 100 req/min limit. |

## 5. Integration Example

Scoring a wallet from your own backend, with a key:

```javascript
const WALLET = "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984";

const res = await fetch(
  `https://defiscoring.com/api/wallet-score?wallet=${WALLET}`,
  { headers: { Authorization: `Bearer ${process.env.DEFISCORING_API_KEY}` } }
);

if (res.status === 429) {
  // Daily budget exhausted. Retry-After is in seconds.
  const wait = Number(res.headers.get("Retry-After") || 3600);
  throw new Error(`Quota exhausted, retry in ${wait}s`);
}
if (res.status === 401) throw new Error("Key invalid or revoked");

const data = await res.json();
console.log(data.score, data.score_band, data.coverage);
```

The same call works with no `Authorization` header at all — it is then subject
to the shared public rate limit rather than your plan's budget.

```bash
curl "https://defiscoring.com/api/wallet-score?wallet=0x1f98...f984"
```

**Read `coverage` before you act on `score`.** It is the fraction of the model's
pillars that were backed by real data for this wallet; the rest fell back to a
neutral default. A 720 at `coverage: 1.0` and a 720 at `coverage: 0.4` are not
the same claim, and the API tells you which one you have.

## 6. Webhooks (Pro feature)

Stay updated in real-time. We can push data to your server whenever a protocol's score drops by more than 10 points.

- **Event:** `score.dropped`
- **Payload:** Includes `protocol_slug`, `old_score`, `new_score`, and `reason`.

## 7. Status

There is no separate status page yet. If you suspect a degradation, check the [GitHub repo](https://github.com/DeFiScoring/website) issues or email `admin@defiscoring.com`.

</div>

{% include site-footer.html %}
