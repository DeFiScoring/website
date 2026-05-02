// worker/handlers/nfts.js
// ----------------------------------------------------------------------------
// GET /api/nfts?wallet=&chains=
//
// Returns NFT collections owned by the wallet across every supported chain.
// Each chain row contains an array of collections sorted by floor-implied
// value. Per-chain failures are isolated.
//
// Response shape:
//   {
//     success, address,
//     totalCollections, totalNfts, totalFloorEth,
//     chains: [
//       { chain, chainName, chainId, collections: [...], totalCount, totalFloorEth }
//     ],
//     updatedAt
//   }
// ----------------------------------------------------------------------------

import { CHAINS } from '../lib/chains.js';
import { getAllNftCollections } from '../lib/nft.js';

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const isAddress = (a) => ADDR_RE.test(a || '');

export async function handleNfts(request, env, baseHeaders = {}) {
  const url = new URL(request.url);
  const address = (url.searchParams.get('address') || url.searchParams.get('wallet') || '').toLowerCase();
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

  const perChain = await getAllNftCollections(env, address, chainsToScan);

  const totalCollections = perChain.reduce((s, c) => s + (c.collections?.length || 0), 0);
  const totalNfts        = perChain.reduce((s, c) => s + (c.totalCount || 0), 0);
  const totalFloorEth    = perChain.reduce((s, c) => s + (c.totalFloorEth || 0), 0);

  return jsonRes({
    success: true,
    address,
    totalCollections,
    totalNfts,
    totalFloorEth,
    chains: perChain,
    updatedAt: new Date().toISOString(),
  }, 200, baseHeaders);
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
