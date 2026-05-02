// worker/lib/defi.js
// ----------------------------------------------------------------------------
// DeFi position reader — one-call-per-chain summaries of lending health,
// stable-supply yield, and LP exposure. Every reader returns a uniform shape
// so the handler / score engine never branches on protocol.
//
// Designed to fail soft: a chain without Aave returns { hasPosition: false },
// not an error. An RPC timeout returns { error } on the row, not a 500.
// ----------------------------------------------------------------------------

import { ethCall, abiEncodeSingleAddr, abiHexWord } from './providers.js';
import { CHAINS_BY_ID } from './chains.js';
import {
  AAVE_V3_POOLS,
  COMPOUND_V3_MARKETS,
  UNI_V3_POSITION_MANAGER,
  UNI_V3_NPM_CHAINS,
  YIELD_TOKENS,
  YIELD_CONTRACT_INDEX,
} from './defi-protocols.js';

// Function selectors. Computed offline as the first 4 bytes of keccak256(sig).
const SEL_BALANCE_OF             = '0x70a08231'; // balanceOf(address)
const SEL_GET_USER_ACCOUNT_DATA  = '0xbf92857c'; // Aave V3 Pool: getUserAccountData(address)
const SEL_COMET_BALANCE_OF       = '0x70a08231'; // Compound V3 Comet: balanceOf(address) — supply
const SEL_COMET_BORROW_BALANCE   = '0x374c49b4'; // Compound V3 Comet: borrowBalanceOf(address)
const SEL_COMET_BASE_TOKEN       = '0xc55dae63'; // Compound V3 Comet: baseToken() — for symbol resolution

// =============================================================================
// Aave V3 — single eth_call per chain returns full account summary in 8d base.
// =============================================================================

export async function getAaveV3Position(chain, env, wallet) {
  const pool = AAVE_V3_POOLS[chain.id];
  if (!pool) return { protocol: 'aave-v3', chain: chain.id, hasPosition: false, deployed: false };
  const data = abiEncodeSingleAddr(SEL_GET_USER_ACCOUNT_DATA, wallet);
  const r = await ethCall(chain, env, pool, data);
  if (!r || r === '0x') return { protocol: 'aave-v3', chain: chain.id, hasPosition: false, deployed: true };
  // Returns: totalCollateralBase, totalDebtBase, availableBorrowsBase,
  //          currentLiquidationThreshold, ltv, healthFactor.
  // *Base values are in the protocol's reference asset (usually USD) at 8 decimals.
  // healthFactor is 1e18-scaled.
  const totalCollateralBase = abiHexWord(r, 0);
  const totalDebtBase       = abiHexWord(r, 1);
  const availBorrowsBase    = abiHexWord(r, 2);
  const liqThreshold        = abiHexWord(r, 3); // basis points
  const ltv                 = abiHexWord(r, 4); // basis points
  const healthFactorRaw     = abiHexWord(r, 5);
  // healthFactor for a no-debt position is uint256 max — surface as null,
  // not Infinity, so JSON.stringify works and the dashboard can show "—".
  const healthFactor = totalDebtBase === 0n ? null : Number(healthFactorRaw) / 1e18;
  return {
    protocol:           'aave-v3',
    category:           'lending',
    chain:              chain.id,
    chainName:          chain.name,
    chainId:            chain.chainId,
    deployed:           true,
    hasPosition:        totalCollateralBase > 0n || totalDebtBase > 0n,
    collateralUsd:      Number(totalCollateralBase) / 1e8,
    debtUsd:            Number(totalDebtBase) / 1e8,
    availableBorrowsUsd: Number(availBorrowsBase) / 1e8,
    netUsd:             (Number(totalCollateralBase) - Number(totalDebtBase)) / 1e8,
    healthFactor,
    ltvBps:             Number(ltv),
    liquidationThresholdBps: Number(liqThreshold),
  };
}

// =============================================================================
// Compound V3 — supply (cUSDCv3 balanceOf returns USDC units; baseToken is
// USDC so 6 decimals) + borrow (borrowBalanceOf in same units). Two eth_calls
// per market. We only ship the cUSDCv3 market right now (deepest TVL); other
// markets can be added to defi-protocols.js without touching this file.
// =============================================================================

export async function getCompoundV3Positions(chain, env, wallet) {
  const markets = COMPOUND_V3_MARKETS[chain.id] || [];
  if (!markets.length) return [{ protocol: 'compound-v3', chain: chain.id, hasPosition: false, deployed: false }];
  const out = await Promise.all(markets.map(async (m) => {
    const supplyData = abiEncodeSingleAddr(SEL_COMET_BALANCE_OF, wallet);
    const borrowData = abiEncodeSingleAddr(SEL_COMET_BORROW_BALANCE, wallet);
    const [supplyHex, borrowHex] = await Promise.all([
      ethCall(chain, env, m.address, supplyData),
      ethCall(chain, env, m.address, borrowData),
    ]);
    const supplyRaw = abiHexWord(supplyHex || '0x', 0);
    const borrowRaw = abiHexWord(borrowHex || '0x', 0);
    // cUSDCv3 base token is USDC (6 decimals). If we add WETH/USDT markets
    // later, decimals will need to come from baseToken() — flagged for T5.
    const decimals = 6;
    const supply = Number(supplyRaw) / 10 ** decimals;
    const borrow = Number(borrowRaw) / 10 ** decimals;
    return {
      protocol:    'compound-v3',
      category:    'lending',
      chain:       chain.id,
      chainName:   chain.name,
      chainId:     chain.chainId,
      market:      m.symbol,
      marketAddr:  m.address,
      deployed:    true,
      hasPosition: supplyRaw > 0n || borrowRaw > 0n,
      supplyUsd:   supply,                        // base token IS USD-pegged for cUSDCv3
      borrowUsd:   borrow,
      netUsd:      supply - borrow,
    };
  }));
  return out;
}

// =============================================================================
// Uniswap V3 — single balanceOf on the NonfungiblePositionManager returns
// the count of LP NFTs the wallet owns. Doesn't tell us position value
// without enumerating each tokenId + reading the pool — that's a T5 follow-up
// when we add the score factor for "active LP'er".
// =============================================================================

export async function getUniV3LpCount(chain, env, wallet) {
  if (!UNI_V3_NPM_CHAINS.includes(chain.id)) {
    return { protocol: 'uniswap-v3-lp', chain: chain.id, hasPosition: false, deployed: false };
  }
  const data = abiEncodeSingleAddr(SEL_BALANCE_OF, wallet);
  const r = await ethCall(chain, env, UNI_V3_POSITION_MANAGER, data);
  if (!r || r === '0x') return { protocol: 'uniswap-v3-lp', chain: chain.id, hasPosition: false, deployed: true };
  const count = Number(abiHexWord(r, 0));
  return {
    protocol:    'uniswap-v3-lp',
    category:    'dex',
    chain:       chain.id,
    chainName:   chain.name,
    chainId:     chain.chainId,
    deployed:    true,
    hasPosition: count > 0,
    lpCount:     count,
    // valueUsd intentionally omitted — needs per-tokenId pool reads (T5).
  };
}

// =============================================================================
// Yield-bearing ERC-20 re-classification. The portfolio handler (T3) already
// fetched the wallet's ERC-20 balances; this just looks them up in
// YIELD_CONTRACT_INDEX and returns enriched rows. No extra RPC calls.
// =============================================================================

export function classifyYieldTokens(chainId, erc20Rows, fiatPriceMap) {
  const idx = YIELD_CONTRACT_INDEX[chainId];
  if (!idx) return [];
  const out = [];
  for (const row of erc20Rows) {
    const meta = idx.get((row.contract || '').toLowerCase());
    if (!meta) continue;
    const px = fiatPriceMap[(row.contract || '').toLowerCase()] ?? row.priceFiat ?? 0;
    out.push({
      protocol:    meta.slug,
      category:    meta.category,
      chain:       chainId,
      contract:    row.contract,
      symbol:      meta.symbol,
      name:        meta.name,
      underlying:  meta.underlying,
      priceModel:  meta.priceModel,
      amount:      row.amount,
      priceFiat:   px,
      valueFiat:   px * row.amount,
      hasPosition: row.amount > 0,
    });
  }
  return out;
}

// =============================================================================
// Top-level fan-out: scan every chain in parallel, aggregate per-protocol
// totals. Each chain row is independent — one chain failing never breaks the
// rest of the response.
// =============================================================================

export async function getAllDeFiPositions(env, wallet, chains) {
  const perChain = await Promise.all(chains.map(async (chain) => {
    try {
      const [aave, compoundList, uni] = await Promise.all([
        getAaveV3Position(chain, env, wallet).catch((e) => ({ protocol: 'aave-v3', chain: chain.id, error: String(e.message || e) })),
        getCompoundV3Positions(chain, env, wallet).catch((e) => [{ protocol: 'compound-v3', chain: chain.id, error: String(e.message || e) }]),
        getUniV3LpCount(chain, env, wallet).catch((e) => ({ protocol: 'uniswap-v3-lp', chain: chain.id, error: String(e.message || e) })),
      ]);
      const protocols = [aave, ...compoundList, uni];
      const collateralUsd = protocols.reduce((s, p) => s + (p.collateralUsd || p.supplyUsd || 0), 0);
      const debtUsd       = protocols.reduce((s, p) => s + (p.debtUsd || p.borrowUsd || 0), 0);
      return {
        chain:       chain.id,
        chainName:   chain.name,
        chainId:     chain.chainId,
        protocols,
        collateralUsd,
        debtUsd,
        netUsd:      collateralUsd - debtUsd,
      };
    } catch (e) {
      return { chain: chain.id, chainName: chain.name, chainId: chain.chainId, protocols: [], error: String(e.message || e) };
    }
  }));
  return perChain;
}
