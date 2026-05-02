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
import { computeWalletScore } from '../lib/score.js';

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const isAddress = (a) => ADDR_RE.test(a || '');

export async function handleWalletScore(request, env, baseHeaders = {}) {
  const url = new URL(request.url);
  const address = (url.searchParams.get('address') || url.searchParams.get('wallet') || '').toLowerCase();
  const fiat = (url.searchParams.get('fiat') || 'USD').toUpperCase();
  const chainFilter = url.searchParams.get('chains');
  const tier1Only = url.searchParams.get('tier') === '1';

  if (!isAddress(address)) {
    return jsonRes({ success: false, error: 'invalid wallet address' }, 400, baseHeaders);
  }

  let chainsToScan = CHAINS;
  if (chainFilter) {
    const wanted = new Set(chainFilter.split(',').map((s) => s.trim()).filter(Boolean));
    chainsToScan = CHAINS.filter((c) => wanted.has(c.id));
  } else if (tier1Only) {
    chainsToScan = CHAINS.filter((c) => c.tier === 1);
  }

  // Run portfolio + defi scans in parallel — both are needed by the score
  // engine and each is independently rate-limited at the lower /api/portfolio
  // and /api/defi handlers (this composite endpoint pays the same cost).
  const portfolioReq = new Request(
    `${url.origin}/api/portfolio?wallet=${address}&fiat=${fiat}` +
    (chainFilter ? `&chains=${chainFilter}` : '') + (tier1Only ? '&tier=1' : ''),
    { method: 'GET' }
  );
  const [portfolioRes, defiByChain] = await Promise.all([
    handlePortfolio(portfolioReq, env, {}),
    getAllDeFiPositions(env, address, chainsToScan),
  ]);
  const portfolio = await portfolioRes.json();

  const result = await computeWalletScore(env, address, { portfolio, defiByChain });
  return jsonRes(result, 200, baseHeaders);
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
