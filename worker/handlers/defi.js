// worker/handlers/defi.js
// ----------------------------------------------------------------------------
// GET /api/defi?wallet=&chains=&fiat=
//
// Returns per-chain DeFi position summary (Aave V3, Compound V3, Uniswap V3
// LP count) for the wallet. Each chain is scanned in parallel; per-chain
// failures are isolated.
//
// Response shape:
//   {
//     success, address, fiat,
//     totalCollateralUsd, totalDebtUsd, totalNetUsd, healthSummary,
//     chains: [
//       { chain, chainName, chainId, protocols: [...], collateralUsd, debtUsd, netUsd }
//     ],
//     updatedAt
//   }
// ----------------------------------------------------------------------------

import { CHAINS } from '../lib/chains.js';
import { getAllDeFiPositions } from '../lib/defi.js';

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const isAddress = (a) => ADDR_RE.test(a || '');

export async function handleDeFi(request, env, baseHeaders = {}) {
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

  const perChain = await getAllDeFiPositions(env, address, chainsToScan);

  const totalCollateralUsd = perChain.reduce((s, c) => s + (c.collateralUsd || 0), 0);
  const totalDebtUsd       = perChain.reduce((s, c) => s + (c.debtUsd || 0), 0);
  const totalNetUsd        = totalCollateralUsd - totalDebtUsd;

  // Surface the lowest health factor across all Aave positions — that's the
  // one a liquidator will hit first, so it's what the dashboard should warn on.
  let lowestHealth = null;
  for (const c of perChain) {
    for (const p of c.protocols || []) {
      if (typeof p.healthFactor === 'number' && (lowestHealth == null || p.healthFactor < lowestHealth)) {
        lowestHealth = p.healthFactor;
      }
    }
  }

  return jsonRes({
    success: true,
    address,
    fiat,
    totalCollateralUsd,
    totalDebtUsd,
    totalNetUsd,
    healthSummary: {
      lowestHealthFactor: lowestHealth,
      // Aave convention: <1 = liquidatable, 1-1.5 = risky, 1.5-2 = caution, >2 = safe
      band: lowestHealth == null ? 'no-debt'
          : lowestHealth < 1   ? 'liquidatable'
          : lowestHealth < 1.5 ? 'risky'
          : lowestHealth < 2   ? 'caution'
                                : 'safe',
    },
    chains: perChain,
    updatedAt: new Date().toISOString(),
  }, 200, baseHeaders);
}

function jsonRes(data, status, baseHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=60',
      ...baseHeaders,
    },
  });
}
