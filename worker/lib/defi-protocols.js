// worker/lib/defi-protocols.js
// ----------------------------------------------------------------------------
// Per-chain protocol-contract registry. Adding a new protocol or chain here
// flows through worker/lib/defi.js and worker/handlers/defi.js with no other
// edits — same single-source-of-truth pattern as worker/lib/chains.js.
//
// Addresses verified from official docs (docs.aave.com, docs.compound.finance,
// docs.lido.fi, etc.) at the time of writing. If a protocol redeploys, only
// this file needs updating.
//
// Deployments matrix (intentionally narrower than the 11-chain registry —
// many chains simply don't have these protocols deployed yet, and a missing
// entry is correctly handled as "no position" by lib/defi.js):
//   Aave V3:     ethereum, optimism, arbitrum, base, polygon, bnb, avalanche,
//                gnosis, scroll  (NOT linea, NOT zksync as of 2024-2025)
//   Compound V3: ethereum, optimism, arbitrum, base, polygon
//   Uni V3 LP:   ethereum, optimism, arbitrum, base, polygon, bnb (same NPM
//                contract address on every chain it's deployed to)
//   LSTs / yield-bearing ERC-20s: ethereum (most LSTs live on mainnet)
// ----------------------------------------------------------------------------

// Aave V3 Pool addresses. Most L2s share the same multi-chain deployment
// 0x794a61358D6845594F94dc1DB02A252b5b4814aD; Ethereum/Base/BNB/Gnosis/Scroll
// have unique addresses.
export const AAVE_V3_POOLS = {
  ethereum:  '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  optimism:  '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  arbitrum:  '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  base:      '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  polygon:   '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  bnb:       '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
  avalanche: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  gnosis:    '0xb50201558B00496A145fE76f7424749556E326D8',
  scroll:    '0x11fCfe756c05AD438e312a7fd934381537D3cFfe',
};

// Compound V3 (Comet) markets. Each market is a separate contract per
// collateral asset; we list the headline USDC market per chain since that
// has the deepest TVL. Future: extend to {chainId: [{symbol, address}]} if
// users want WETH/USDT market positions surfaced.
export const COMPOUND_V3_MARKETS = {
  ethereum: [{ symbol: 'cUSDCv3', address: '0xc3d688B66703497DAA19211EEdff47f25384cdc3' }],
  optimism: [{ symbol: 'cUSDCv3', address: '0x2e44e174f7D53F0212823acC11C01A11d58c5bCB' }],
  arbitrum: [{ symbol: 'cUSDCv3', address: '0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA' }],
  base:     [{ symbol: 'cUSDCv3', address: '0xb125E6687d4313864e53df431d5425969c15Eb2F' }],
  polygon:  [{ symbol: 'cUSDCv3', address: '0xF25212E676D1F7F89Cd72fFEe66158f541246445' }],
};

// Uniswap V3 NonfungiblePositionManager — same address on every chain the
// canonical V3 deployment landed on. Contract holds the user's LP position
// NFTs; balanceOf(user) gives the count.
export const UNI_V3_POSITION_MANAGER = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
export const UNI_V3_NPM_CHAINS = ['ethereum', 'optimism', 'arbitrum', 'base', 'polygon', 'bnb'];

// Yield-bearing / liquid-staking ERC-20s. These show up in the raw ERC-20
// scan from T3 already, but lib/defi.js re-classifies them under the right
// protocol slug + category so the dashboard can render them as DeFi positions
// (with strategy + APY context) instead of generic tokens.
//
// chain → array of { slug, category, contract, symbol, name, underlying, priceModel }
//   priceModel: 'erc20'      — price comes from the ERC-20 scan / CoinGecko
//               'rebasing'   — balance reflects yield accumulation directly
//               'wrapped'    — value derived from underlying * exchange rate
export const YIELD_TOKENS = {
  ethereum: [
    { slug: 'lido',         category: 'liquid_staking', contract: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84', symbol: 'stETH',   name: 'Lido Staked ETH',          underlying: 'ETH', priceModel: 'rebasing' },
    { slug: 'lido',         category: 'liquid_staking', contract: '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0', symbol: 'wstETH',  name: 'Wrapped stETH',             underlying: 'ETH', priceModel: 'wrapped' },
    { slug: 'rocket-pool',  category: 'liquid_staking', contract: '0xae78736cd615f374d3085123a210448e74fc6393', symbol: 'rETH',    name: 'Rocket Pool ETH',           underlying: 'ETH', priceModel: 'wrapped' },
    { slug: 'frax-ether',   category: 'liquid_staking', contract: '0xac3e018457b222d93114458476f3e3416abbe38f', symbol: 'sfrxETH', name: 'Staked Frax Ether',         underlying: 'ETH', priceModel: 'wrapped' },
    { slug: 'coinbase-wbeth', category: 'liquid_staking', contract: '0xbe9895146f7af43049ca1c1ae358b0541ea49704', symbol: 'cbETH', name: 'Coinbase Wrapped Staked ETH', underlying: 'ETH', priceModel: 'wrapped' },
    { slug: 'swell',        category: 'liquid_staking', contract: '0xf951e335afb289353dc249e82926178eac7ded78', symbol: 'swETH',   name: 'Swell ETH',                 underlying: 'ETH', priceModel: 'wrapped' },
    { slug: 'mantle-meth',  category: 'liquid_staking', contract: '0xd5f7838f5c461feff7fe49ea5ebaf7728bb0adfa', symbol: 'mETH',    name: 'Mantle Staked ETH',         underlying: 'ETH', priceModel: 'wrapped' },
    { slug: 'makerdao',     category: 'stablecoin',     contract: '0x83f20f44975d03b1b09e64809b757c47f942beea', symbol: 'sDAI',    name: 'Savings DAI',               underlying: 'DAI', priceModel: 'wrapped' },
  ],
};

// Helper — fold every yield-token contract into one set for fast lookup
// during the ERC-20 re-classification pass.
export const YIELD_CONTRACT_INDEX = (() => {
  const out = {};
  for (const [chainId, list] of Object.entries(YIELD_TOKENS)) {
    out[chainId] = new Map(list.map((t) => [t.contract.toLowerCase(), t]));
  }
  return out;
})();
