// worker/handlers/wallet-score.js
// ----------------------------------------------------------------------------
// GET /api/wallet-score?wallet=&fiat=&chains=&tier=
//
// Multi-chain composite credit score (300–850, FICO-style). Composes T3
// portfolio + T4 DeFi positions + governance + account age into 5 named
// pillars with `real:true/false` flags.
//
// Sibling to (not replacement for) the legacy POST /api/health-score in
// worker/index.js — that endpoint is still wired for the existing
// dashboard.js + health-score.js consumers.
// ----------------------------------------------------------------------------

import { CHAINS } from '../lib/chains.js';
import { handlePortfolio } from './portfolio.js';
import { getAllDeFiPositions } from '../lib/defi.js';
import { computeWalletScore, SCORE_MODEL_VERSION } from '../lib/score.js';

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const isAddress = (a) => ADDR_RE.test(a || '');

export async function handleWalletScore(request, env, baseHeaders = {}) {
  const url = new URL(request.url);
  const address = (url.searchParams.get('address') || url.searchParams.get('wallet') || '').toLowerCase();
  const fiat = (url.searchParams.get('fiat') || 'USD').toUpperCase();
  const chainFilter = url.searchParams.get('chains');
  // Match /api/portfolio's contract exactly: `?tier=all` means every chain,
  // anything else (including absent) means Tier 1 only. This handler used to
  // read `?tier=1` instead, so a default call scored DeFi positions across
  // all 11 chains while the portfolio half of the same score only covered 5 —
  // two pillars computed over different chain sets, and ~2x the subrequest
  // budget the portfolio handler was carefully sized for.
  const allChains = url.searchParams.get('tier') === 'all';

  if (!isAddress(address)) {
    return jsonRes({ success: false, error: 'invalid wallet address' }, 400, baseHeaders);
  }

  let chainsToScan = CHAINS;
  if (chainFilter) {
    const wanted = new Set(chainFilter.split(',').map((s) => s.trim()).filter(Boolean));
    chainsToScan = CHAINS.filter((c) => wanted.has(c.id));
  } else if (!allChains) {
    chainsToScan = CHAINS.filter((c) => c.tier === 1);
  }
  if (!chainsToScan.length) {
    return jsonRes({ success: false, error: 'no known chains in ?chains= filter' }, 400, baseHeaders);
  }

  // Run portfolio + defi scans in parallel — both are needed by the score
  // engine and each is independently rate-limited at the lower /api/portfolio
  // and /api/defi handlers (this composite endpoint pays the same cost).
  const portfolioReq = new Request(
    `${url.origin}/api/portfolio?wallet=${address}&fiat=${fiat}` +
    (chainFilter ? `&chains=${encodeURIComponent(chainFilter)}` : '') +
    (allChains ? '&tier=all' : ''),
    { method: 'GET' }
  );
  const [portfolioRes, defiByChain] = await Promise.all([
    handlePortfolio(portfolioReq, env, {}),
    getAllDeFiPositions(env, address, chainsToScan),
  ]);
  const portfolio = await portfolioRes.json();

  const result = await computeWalletScore(env, address, { portfolio, defiByChain });

  // Persist so the wallet's score has a history and a badge. Only the legacy
  // Ethereum-only POST /api/health-score wrote to health_scores, which meant
  // scanning a wallet through this (newer, multi-chain) endpoint left
  // /badge/{addr}.svg and /api/health-score/{addr}/history permanently empty.
  // Best-effort: a write failure must never fail the score response.
  await persistWalletScore(env, address, result);

  return jsonRes(result, 200, baseHeaders);
}

async function persistWalletScore(env, wallet, payload) {
  if (!env.HEALTH_DB || !payload || !payload.pillars) return false;
  // Unscored results (no on-chain footprint / all providers down) carry no
  // number worth charting — persisting them would pollute the trend and the
  // badge with nulls.
  if (payload.scored === false) return false;
  try {
    const p = payload.pillars;
    await env.HEALTH_DB.prepare(
      'INSERT INTO health_scores (wallet, score, loan_reliability, liquidity_provision, ' +
      'governance, account_age, raw_h_s, source_json, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      wallet,
      payload.score,
      p.loan_reliability?.value ?? null,
      p.liquidity_provision?.value ?? null,
      p.governance?.value ?? null,
      p.account_age?.value ?? null,
      payload.raw_h_s ?? null,
      JSON.stringify({
        source: 'wallet-score',
        // Which scoring model produced this row. Read back by the history
        // endpoint so the trend chart can mark where the model changed.
        model: payload.model || SCORE_MODEL_VERSION,
        // Share of the score's weight backed by observed data (0..1). Read
        // back by the public badge so a thin-coverage score is labelled as
        // such there too, not only on the dashboard.
        coverage: typeof payload.coverage === 'number' ? payload.coverage : null,
        score_band: payload.score_band,
        adjustments: payload.adjustments || [],
        portfolio_health: p.portfolio_health || null,
        // Compact per-pillar summaries so the explanation endpoint can
        // narrate a persisted score without recomputing it. Values and
        // weights already live in dedicated columns; what's new here is the
        // rationale strings and real flags.
        pillars: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, {
          value: v?.value ?? null,
          weight: v?.weight ?? null,
          real: v?.real === true,
          rationale: typeof v?.rationale === 'string' ? v.rationale.slice(0, 300) : null,
        }])),
      }),
      Date.now(),
    ).run();
    return true;
  } catch (e) {
    console.warn('[wallet-score] persist failed:', e && e.message ? e.message : e);
    return false;
  }
}

function jsonRes(data, status, baseHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=120',
      ...baseHeaders,
    },
  });
}
