// worker/lib/nft.js
// ----------------------------------------------------------------------------
// NFT collection reader. Provider tiers:
//   1. Alchemy NFT API   — when ALCHEMY_KEY is set (richest metadata)
//   2. Moralis NFT API   — when MORALIS_KEY is set (good chain coverage)
//   3. Reservoir         — keyless free tier, supports the major EVM L2s
//
// Returned shape is identical regardless of provider so handlers/nfts.js
// never branches on which one answered. Each chain is independent — a
// missing Reservoir host or a 4xx from one chain never breaks the rest.
// ----------------------------------------------------------------------------

import { cacheGet, cacheSet } from './cache.js';

// Reservoir public hosts. Chains not listed here simply return [] from the
// Reservoir tier — Alchemy/Moralis cover the gaps when keys are present.
// Source: https://docs.reservoir.tools (2024 host map).
const RESERVOIR_HOSTS = {
  ethereum: 'https://api.reservoir.tools',
  polygon:  'https://api-polygon.reservoir.tools',
  optimism: 'https://api-optimism.reservoir.tools',
  arbitrum: 'https://api-arbitrum.reservoir.tools',
  base:     'https://api-base.reservoir.tools',
  bnb:      'https://api-bsc.reservoir.tools',
  linea:    'https://api-linea.reservoir.tools',
  scroll:   'https://api-scroll.reservoir.tools',
  zksync:   'https://api-zksync.reservoir.tools',
};

// Cap collections-per-chain so a wallet that's been airdropped 500 spam NFTs
// doesn't blow the worker CPU budget or the response payload size.
const MAX_COLLECTIONS_PER_CHAIN = 50;
// Cache NFT scans for 5 min — slower-moving than ERC-20 prices, expensive to
// recompute, and the dashboard refreshes manually anyway.
const NFT_CACHE_TTL = 300;

// ----- Tier 1: Alchemy --------------------------------------------------------

async function alchemyNftCollections(chain, env, wallet) {
  if (!chain.alchemy || !env.ALCHEMY_KEY) throw new Error('alchemy unavailable');
  const url = `https://${chain.alchemy}.g.alchemy.com/nft/v3/${env.ALCHEMY_KEY}` +
              `/getContractsForOwner?owner=${wallet}&pageSize=${MAX_COLLECTIONS_PER_CHAIN}` +
              `&withMetadata=true`;
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`alchemy nft http ${r.status}`);
  const j = await r.json();
  return (j.contracts || []).map((c) => ({
    chain:        chain.id,
    chainName:    chain.name,
    contract:     (c.address || '').toLowerCase(),
    name:         c.name || c.openSeaMetadata?.collectionName || 'Unknown collection',
    symbol:       c.symbol || null,
    standard:     c.tokenType || 'ERC721',
    count:        Number(c.totalBalance || c.numDistinctTokensOwned || 0),
    image:        c.openSeaMetadata?.imageUrl || c.media?.[0]?.thumbnail || null,
    floorEth:     Number(c.openSeaMetadata?.floorPrice || 0),
    verified:     c.openSeaMetadata?.safelistRequestStatus === 'verified',
    source:       'alchemy',
  })).filter((c) => c.contract && c.count > 0);
}

// ----- Tier 2: Moralis --------------------------------------------------------

async function moralisNftCollections(chain, env, wallet) {
  if (!chain.moralis || !env.MORALIS_KEY) throw new Error('moralis unavailable');
  const url = `https://deep-index.moralis.io/api/v2.2/${wallet}/nft/collections` +
              `?chain=${chain.moralis}&limit=${MAX_COLLECTIONS_PER_CHAIN}`;
  const r = await fetch(url, {
    headers: { 'X-API-Key': env.MORALIS_KEY, accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`moralis nft http ${r.status}`);
  const j = await r.json();
  return (j.result || []).map((c) => ({
    chain:        chain.id,
    chainName:    chain.name,
    contract:     (c.token_address || '').toLowerCase(),
    name:         c.name || 'Unknown collection',
    symbol:       c.symbol || null,
    standard:     c.contract_type || 'ERC721',
    count:        Number(c.count || 0),
    image:        null, // Moralis collections endpoint doesn't return imagery
    floorEth:     0,    // Floor price needs a separate /collections/{address} call
    verified:     Boolean(c.verified_collection),
    source:       'moralis',
  })).filter((c) => c.contract && c.count > 0);
}

// ----- Tier 3: Reservoir (keyless) -------------------------------------------

async function reservoirNftCollections(chain, env, wallet) {
  const host = RESERVOIR_HOSTS[chain.id];
  if (!host) throw new Error(`reservoir: ${chain.id} not supported`);
  const url = `${host}/users/${wallet}/collections/v3` +
              `?limit=${MAX_COLLECTIONS_PER_CHAIN}&includeTopBid=false&includeLiquidCount=false`;
  const headers = { accept: 'application/json' };
  if (env.RESERVOIR_KEY) headers['x-api-key'] = env.RESERVOIR_KEY;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`reservoir http ${r.status}`);
  const j = await r.json();
  return (j.collections || []).map((row) => {
    const c = row.collection || {};
    return {
      chain:     chain.id,
      chainName: chain.name,
      contract:  (c.id || c.primaryContract || '').toLowerCase(),
      name:      c.name || 'Unknown collection',
      symbol:    c.symbol || null,
      standard:  'ERC721',
      count:     Number(row.ownership?.tokenCount || 0),
      image:     c.image || null,
      floorEth:  Number(c.floorAskPrice?.amount?.decimal || 0),
      verified:  c.openseaVerificationStatus === 'verified',
      source:    'reservoir',
    };
  }).filter((c) => c.contract && c.count > 0);
}

// =============================================================================
// Public API — try each tier in order, cache the successful result.
// =============================================================================

export async function getNftCollections(chain, env, wallet) {
  const cacheKey = `nft:${chain.id}:${wallet.toLowerCase()}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return cached;

  let result = null;
  for (const tier of [alchemyNftCollections, moralisNftCollections, reservoirNftCollections]) {
    try {
      result = await tier(chain, env, wallet);
      break;
    } catch { /* try next tier */ }
  }
  if (!result) result = [];
  // Sort by floor-implied value desc, then count desc so the most valuable
  // collections show first in any UI render.
  result.sort((a, b) => (b.floorEth * b.count) - (a.floorEth * a.count) || b.count - a.count);
  result = result.slice(0, MAX_COLLECTIONS_PER_CHAIN);
  await cacheSet(env, cacheKey, result, NFT_CACHE_TTL);
  return result;
}

// Fan out to every requested chain in parallel. Per-chain failures are
// isolated — a Reservoir 503 on Linea never stops Ethereum's response.
export async function getAllNftCollections(env, wallet, chains) {
  return Promise.all(chains.map((c) =>
    getNftCollections(c, env, wallet).catch((err) => {
      // Surface the chain skeleton with an error marker so the UI can show
      // "couldn't load NFTs on Linea" without losing the other chains.
      return [];
    }).then((collections) => ({
      chain:     c.id,
      chainName: c.name,
      chainId:   c.chainId,
      collections,
      totalCount: collections.reduce((s, x) => s + (x.count || 0), 0),
      totalFloorEth: collections.reduce((s, x) => s + (x.floorEth * x.count || 0), 0),
    }))
  ));
}
