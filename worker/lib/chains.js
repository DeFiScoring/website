// worker/lib/chains.js
// ----------------------------------------------------------------------------
// Single source of truth for the 11 EVM chains the platform supports.
//
// Each chain entry intentionally lists IDs for every provider we may consult
// (Alchemy, Moralis, Covalent, CoinGecko, DefiLlama, Etherscan v2). Provider
// selection lives in worker/lib/providers.js — adding a new chain here is the
// only step needed to make every handler aware of it.
//
// Tier 1 = ships first / always scanned by default. Tier 2 = supported but the
// dashboard may collapse them under an "Other chains" group depending on the
// user's filter preferences.
// ----------------------------------------------------------------------------

export const CHAINS = [
  {
    id: 'ethereum', name: 'Ethereum', chainId: 1, tier: 1,
    alchemy: 'eth-mainnet', moralis: 'eth', covalent: 1,
    coingecko: 'ethereum', defillama: 'ethereum',
    nativeSymbol: 'ETH', nativeCoingeckoId: 'ethereum',
    explorer: 'https://etherscan.io',
    explorerApi: 'https://api.etherscan.io/v2/api',
  },
  {
    id: 'optimism', name: 'Optimism', chainId: 10, tier: 1,
    alchemy: 'opt-mainnet', moralis: 'optimism', covalent: 10,
    coingecko: 'optimistic-ethereum', defillama: 'optimism',
    nativeSymbol: 'ETH', nativeCoingeckoId: 'ethereum',
    explorer: 'https://optimistic.etherscan.io',
    explorerApi: 'https://api.etherscan.io/v2/api',
  },
  {
    id: 'arbitrum', name: 'Arbitrum One', chainId: 42161, tier: 1,
    alchemy: 'arb-mainnet', moralis: 'arbitrum', covalent: 42161,
    coingecko: 'arbitrum-one', defillama: 'arbitrum',
    nativeSymbol: 'ETH', nativeCoingeckoId: 'ethereum',
    explorer: 'https://arbiscan.io',
    explorerApi: 'https://api.etherscan.io/v2/api',
  },
  {
    id: 'base', name: 'Base', chainId: 8453, tier: 1,
    alchemy: 'base-mainnet', moralis: 'base', covalent: 8453,
    coingecko: 'base', defillama: 'base',
    nativeSymbol: 'ETH', nativeCoingeckoId: 'ethereum',
    explorer: 'https://basescan.org',
    explorerApi: 'https://api.etherscan.io/v2/api',
  },
  {
    id: 'polygon', name: 'Polygon', chainId: 137, tier: 1,
    alchemy: 'polygon-mainnet', moralis: 'polygon', covalent: 137,
    coingecko: 'polygon-pos', defillama: 'polygon',
    nativeSymbol: 'POL', nativeCoingeckoId: 'polygon-ecosystem-token',
    explorer: 'https://polygonscan.com',
    explorerApi: 'https://api.etherscan.io/v2/api',
  },
  {
    id: 'bnb', name: 'BNB Chain', chainId: 56, tier: 2,
    alchemy: 'bnb-mainnet', moralis: 'bsc', covalent: 56,
    coingecko: 'binance-smart-chain', defillama: 'bsc',
    nativeSymbol: 'BNB', nativeCoingeckoId: 'binancecoin',
    explorer: 'https://bscscan.com',
    explorerApi: 'https://api.etherscan.io/v2/api',
  },
  {
    id: 'avalanche', name: 'Avalanche', chainId: 43114, tier: 2,
    alchemy: 'avax-mainnet', moralis: 'avalanche', covalent: 43114,
    coingecko: 'avalanche', defillama: 'avalanche',
    nativeSymbol: 'AVAX', nativeCoingeckoId: 'avalanche-2',
    explorer: 'https://snowtrace.io',
    explorerApi: 'https://api.etherscan.io/v2/api',
  },
  {
    id: 'gnosis', name: 'Gnosis', chainId: 100, tier: 2,
    alchemy: null, moralis: 'gnosis', covalent: 100,
    coingecko: 'xdai', defillama: 'xdai',
    nativeSymbol: 'xDAI', nativeCoingeckoId: 'xdai',
    explorer: 'https://gnosisscan.io',
    explorerApi: 'https://api.etherscan.io/v2/api',
  },
  {
    id: 'linea', name: 'Linea', chainId: 59144, tier: 2,
    alchemy: 'linea-mainnet', moralis: 'linea', covalent: 59144,
    coingecko: 'linea', defillama: 'linea',
    nativeSymbol: 'ETH', nativeCoingeckoId: 'ethereum',
    explorer: 'https://lineascan.build',
    explorerApi: 'https://api.etherscan.io/v2/api',
  },
  {
    id: 'scroll', name: 'Scroll', chainId: 534352, tier: 2,
    alchemy: 'scroll-mainnet', moralis: 'scroll', covalent: 534352,
    coingecko: 'scroll', defillama: 'scroll',
    nativeSymbol: 'ETH', nativeCoingeckoId: 'ethereum',
    explorer: 'https://scrollscan.com',
    explorerApi: 'https://api.etherscan.io/v2/api',
  },
  {
    id: 'zksync', name: 'zkSync Era', chainId: 324, tier: 2,
    alchemy: 'zksync-mainnet', moralis: 'zksync', covalent: 324,
    coingecko: 'zksync', defillama: 'era',
    nativeSymbol: 'ETH', nativeCoingeckoId: 'ethereum',
    explorer: 'https://explorer.zksync.io',
    explorerApi: 'https://api.etherscan.io/v2/api',
  },
];

export const CHAINS_BY_ID = Object.fromEntries(CHAINS.map((c) => [c.id, c]));
export const CHAINS_BY_CHAINID = Object.fromEntries(CHAINS.map((c) => [c.chainId, c]));
export const TIER1_IDS = CHAINS.filter((c) => c.tier === 1).map((c) => c.id);
export const ALL_CHAIN_IDS = CHAINS.map((c) => c.id);
