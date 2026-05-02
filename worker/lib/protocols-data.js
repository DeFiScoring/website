// worker/lib/protocols-data.js
// ----------------------------------------------------------------------------
// Bundled copy of the DeFiScoring protocol catalog + risk-profile presets.
// Mirrors _data/protocols.yml and _data/risk_profiles.yml exactly so the
// Worker doesn't need a cross-origin fetch back to the Jekyll site (which
// would create a circular dependency and a cold-start failure mode).
//
// When _data/*.yml changes, also update this file. A future T8 polish task
// can codegen this from YAML at deploy time, but for T5 a hand-mirrored
// copy is simpler and avoids adding a build step.
// ----------------------------------------------------------------------------

// Catalog mirrors _data/protocols.yml. Addresses lowercased for indexed lookup.
export const PROTOCOLS = [
  // ── Lending ─────────────────────────────────────────────────────────────
  { slug: 'aave-v3', name: 'Aave V3', category: 'lending', contracts: [
    { chain_id: 1,     address: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2', label: 'Pool (Eth)' },
    { chain_id: 42161, address: '0x794a61358d6845594f94dc1db02a252b5b4814ad', label: 'Pool (Arb)' },
    { chain_id: 137,   address: '0x794a61358d6845594f94dc1db02a252b5b4814ad', label: 'Pool (Pol)' },
  ]},
  { slug: 'aave-v2', name: 'Aave V2', category: 'lending', contracts: [
    { chain_id: 1, address: '0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9', label: 'LendingPool' },
  ]},
  { slug: 'compound-v3', name: 'Compound V3', category: 'lending', contracts: [
    { chain_id: 1,     address: '0xc3d688b66703497daa19211eedff47f25384cdc3', label: 'cUSDCv3 (Eth)' },
    { chain_id: 42161, address: '0xa5edbdd9646f8dff606d7448e414884c7d905dca', label: 'cUSDCv3 (Arb)' },
    { chain_id: 137,   address: '0xf25212e676d1f7f89cd72ffee66158f541246445', label: 'cUSDCv3 (Pol)' },
  ]},
  { slug: 'morpho-blue', name: 'Morpho Blue', category: 'lending', contracts: [
    { chain_id: 1, address: '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb', label: 'Morpho' },
  ]},

  // ── DEX ────────────────────────────────────────────────────────────────
  { slug: 'uniswap', name: 'Uniswap', category: 'dex', contracts: [
    { chain_id: 1,     address: '0xe592427a0aece92de3edee1f18e0157c05861564', label: 'V3 SwapRouter' },
    { chain_id: 1,     address: '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', label: 'V3 SwapRouter02' },
    { chain_id: 1,     address: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', label: 'V2 Router' },
    { chain_id: 42161, address: '0xe592427a0aece92de3edee1f18e0157c05861564', label: 'V3 Router (Arb)' },
    { chain_id: 137,   address: '0xe592427a0aece92de3edee1f18e0157c05861564', label: 'V3 Router (Pol)' },
  ]},
  { slug: 'curve-finance', name: 'Curve', category: 'dex', contracts: [
    { chain_id: 1, address: '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7', label: '3pool' },
    { chain_id: 1, address: '0xdc24316b9ae028f1497c275eb9192a3ea0f67022', label: 'stETH/ETH' },
  ]},
  { slug: 'quickswap', name: 'QuickSwap', category: 'dex', contracts: [
    { chain_id: 137, address: '0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff', label: 'Router' },
  ]},
  { slug: 'camelot', name: 'Camelot', category: 'dex', contracts: [
    { chain_id: 42161, address: '0xc873fecbd354f5a56e00e710b90ef4201db2448d', label: 'Router' },
  ]},

  // ── Liquid staking ─────────────────────────────────────────────────────
  { slug: 'lido', name: 'Lido', category: 'liquid_staking', contracts: [
    { chain_id: 1, address: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84', label: 'stETH' },
  ]},
  { slug: 'rocket-pool', name: 'Rocket Pool', category: 'liquid_staking', contracts: [
    { chain_id: 1, address: '0xae78736cd615f374d3085123a210448e74fc6393', label: 'rETH' },
  ]},

  // ── Yield aggregators ──────────────────────────────────────────────────
  { slug: 'convex-finance', name: 'Convex', category: 'yield', contracts: [
    { chain_id: 1, address: '0xf403c135812408bfbe8713b5a23a04b3d48aae31', label: 'Booster' },
  ]},
  { slug: 'yearn-finance', name: 'Yearn', category: 'yield', contracts: [
    { chain_id: 1, address: '0x444045c5c13c246e117ed36437303cac8e250ab0', label: 'V3 Factory' },
  ]},
  { slug: 'pendle', name: 'Pendle', category: 'yield', contracts: [
    { chain_id: 1,     address: '0x888888888889758f76e7103c6cbf23abbf58f946', label: 'V2 Router' },
    { chain_id: 42161, address: '0x888888888889758f76e7103c6cbf23abbf58f946', label: 'V2 Router (Arb)' },
  ]},

  // ── Derivatives / perps ────────────────────────────────────────────────
  { slug: 'gmx-v2', name: 'GMX V2', category: 'derivatives', contracts: [
    { chain_id: 42161, address: '0x489ee077994b6658eafa855c308275ead8097c4a', label: 'Vault' },
  ]},

  // ── Stablecoins / CDPs ─────────────────────────────────────────────────
  { slug: 'makerdao', name: 'MakerDAO', category: 'stablecoin', contracts: [
    { chain_id: 1, address: '0x83f20f44975d03b1b09e64809b757c47f942beea', label: 'sDAI' },
  ]},
];

// Risk profile presets. Mirrors _data/risk_profiles.yml.
export const RISK_PROFILES = {
  conservative: {
    id: 'conservative', name: 'Conservative', color: '#2bd4a4',
    summary: 'Capital preservation first. Prefers blue-chip lending markets, avoids perps and long-tail LPs.',
    target: { max_ltv: 0.40, min_health_factor: 2.5, max_single_protocol_pct: 25, max_long_tail_pct: 5 },
    weights: { lending_bluechip: 0.60, stables_lp: 0.25, eth_btc_lp: 0.10, perps: 0.0, long_tail: 0.05 },
    allowedCategories: ['lending', 'liquid_staking', 'stablecoin'],
    excludedCategories: ['derivatives'],
  },
  balanced: {
    id: 'balanced', name: 'Balanced', color: '#5b8cff',
    summary: 'Diversified mix of lending and LP exposure with modest perp use for hedging.',
    target: { max_ltv: 0.55, min_health_factor: 1.8, max_single_protocol_pct: 35, max_long_tail_pct: 15 },
    weights: { lending_bluechip: 0.40, stables_lp: 0.20, eth_btc_lp: 0.20, perps: 0.10, long_tail: 0.10 },
    allowedCategories: ['lending', 'liquid_staking', 'stablecoin', 'dex', 'yield'],
    excludedCategories: [],
  },
  aggressive: {
    id: 'aggressive', name: 'Aggressive', color: '#ffb547',
    summary: 'Yield maximizing. Higher leverage on lending, larger LP/perp allocations.',
    target: { max_ltv: 0.75, min_health_factor: 1.3, max_single_protocol_pct: 50, max_long_tail_pct: 30 },
    weights: { lending_bluechip: 0.25, stables_lp: 0.10, eth_btc_lp: 0.20, perps: 0.20, long_tail: 0.25 },
    allowedCategories: ['lending', 'liquid_staking', 'stablecoin', 'dex', 'yield', 'derivatives'],
    excludedCategories: [],
  },
  degen: {
    id: 'degen', name: 'Degen', color: '#ff5d6c',
    summary: 'Maximum risk, maximum yield. Long-tail farms, high leverage perps, experimental protocols.',
    target: { max_ltv: 0.85, min_health_factor: 1.1, max_single_protocol_pct: 70, max_long_tail_pct: 60 },
    weights: { lending_bluechip: 0.10, stables_lp: 0.05, eth_btc_lp: 0.10, perps: 0.30, long_tail: 0.45 },
    allowedCategories: ['lending', 'liquid_staking', 'stablecoin', 'dex', 'yield', 'derivatives'],
    excludedCategories: [],
  },
};

// Indexed lookup: catalog by slug (O(1) for handlers/recommendations.js).
export const PROTOCOLS_BY_SLUG = new Map(PROTOCOLS.map((p) => [p.slug, p]));

// Indexed lookup: catalog by lowercased contract address (across all chains).
// Returned shape: { protocol: <slug>, chain_id, label }
export const PROTOCOLS_BY_CONTRACT = (() => {
  const map = new Map();
  for (const p of PROTOCOLS) {
    for (const c of p.contracts) {
      map.set(c.address.toLowerCase(), { slug: p.slug, name: p.name, category: p.category, chain_id: c.chain_id, label: c.label });
    }
  }
  return map;
})();
