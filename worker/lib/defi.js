// worker/lib/defi.js
// ----------------------------------------------------------------------------
// DeFi position reader — one-call-per-chain summaries of lending health,
// stable-supply yield, and LP exposure. Every reader returns a uniform shape
// so the handler / score engine never branches on protocol.
//
// Designed to fail soft: a chain without Aave returns { hasPosition: false },
// not an error. An RPC timeout returns { error } on the row, not a 500.
// ----------------------------------------------------------------------------

import { ethCall, abiEncodeSingleAddr, abiHexWord, abiPadAddr } from './providers.js';
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
// Collateral-side reads. Comet keeps collateral in a separate accounting slot
// from the base asset, so these are the only way to see what backs a borrow.
const SEL_COMET_NUM_ASSETS       = '0xa46fe83b'; // numAssets()
const SEL_COMET_GET_ASSET_INFO   = '0xc8c7fe6b'; // getAssetInfo(uint8)
const SEL_COMET_USER_COLLATERAL  = '0x2b92a07d'; // userCollateral(address,address)
const SEL_COMET_GET_PRICE        = '0x41976e09'; // getPrice(address)
const SEL_COMET_IS_LIQUIDATABLE  = '0x042e02cf'; // isLiquidatable(address)

// Comet quotes every price feed against USD with 8 decimals, and stores
// collateral factors as 18-decimal fractions.
const COMET_PRICE_SCALE  = 1e8;
const COMET_FACTOR_SCALE = 1e18;

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

// Comet's collateral asset list (addresses, price feeds, scales, liquidation
// factors) is static until the market is reconfigured, so it is cached in KV.
// Without the cache a borrowing wallet would re-read getAssetInfo() for every
// asset on every scan, which is the bulk of the subrequest cost here.
async function cometAssetMeta(chain, env, marketAddr) {
  const key = `comet:assets:v1:${chain.id}:${marketAddr.toLowerCase()}`;
  if (env.DEFI_CACHE) {
    const hit = await env.DEFI_CACHE.get(key, 'json').catch(() => null);
    if (hit && Array.isArray(hit)) return hit;
  }
  const nHex = await ethCall(chain, env, marketAddr, SEL_COMET_NUM_ASSETS);
  const n = Number(abiHexWord(nHex || '0x', 0));
  // Comet caps collateral assets at 15; anything outside that is a bad decode.
  if (!Number.isInteger(n) || n <= 0 || n > 15) return [];

  const infos = await Promise.all(Array.from({ length: n }, (_, i) =>
    ethCall(chain, env, marketAddr, SEL_COMET_GET_ASSET_INFO + i.toString(16).padStart(64, '0'))
      .catch(() => null)));

  // AssetInfo tuple: (uint8 offset, address asset, address priceFeed,
  // uint64 scale, uint64 borrowCF, uint64 liquidateCF, uint128 supplyCap).
  const assets = [];
  for (const hex of infos) {
    if (!hex || hex === '0x') continue;
    const asset     = wordToAddress(hex, 1);
    const priceFeed = wordToAddress(hex, 2);
    const scale     = Number(abiHexWord(hex, 3));
    const liquidateCf = Number(abiHexWord(hex, 5)) / COMET_FACTOR_SCALE;
    if (!asset || !priceFeed || !(scale > 0)) continue;
    if (!(liquidateCf > 0) || liquidateCf > 1) continue;
    assets.push({ asset, priceFeed, scale, liquidateCf });
  }
  if (assets.length && env.DEFI_CACHE) {
    await env.DEFI_CACHE.put(key, JSON.stringify(assets), { expirationTtl: 604800 }).catch(() => {});
  }
  return assets;
}

function wordToAddress(hex, wordIndex) {
  const w = abiHexWord(hex, wordIndex);
  if (w === 0n) return null;
  return '0x' + w.toString(16).padStart(40, '0').slice(-40);
}

/**
 * Value the collateral backing a Comet borrow, and derive an Aave-comparable
 * health factor from it.
 *
 * Comet has no healthFactor() view, but it exposes everything the formula
 * needs: per-asset balances, USD price feeds, and each asset's liquidation
 * collateral factor. Risk-adjusted collateral over debt is exactly Aave's
 * definition of a health factor, so the value returned here lands on the same
 * scale as `getAaveV3Position().healthFactor` and can share its score bands
 * without any fudge factor.
 *
 * Only called for markets where the wallet actually has a borrow — for the
 * common no-debt wallet this costs nothing. The trade-off is that a wallet
 * holding Comet collateral without borrowing against it stays invisible:
 * `hasPosition` is driven by the base-asset principal, which is zero for a
 * collateral-only account. Surfacing those would mean paying the per-asset
 * reads on every scan of every wallet, which does not fit the subrequest
 * budget; they are also the case where nothing is at risk.
 */
async function getCompoundV3Collateral(chain, env, marketAddr, wallet, borrowUsd) {
  const meta = await cometAssetMeta(chain, env, marketAddr);
  if (!meta.length) return { read: false };

  const balances = await Promise.all(meta.map((a) =>
    ethCall(chain, env, marketAddr, SEL_COMET_USER_COLLATERAL + abiPadAddr(wallet) + abiPadAddr(a.asset))
      .catch(() => null)));

  // userCollateral returns (uint128 balance, uint128 _reserved) — word 0.
  const held = [];
  meta.forEach((a, i) => {
    const raw = abiHexWord(balances[i] || '0x', 0);
    if (raw > 0n) held.push({ ...a, amount: Number(raw) / a.scale });
  });
  // Price only what the wallet actually holds.
  const prices = await Promise.all(held.map((a) =>
    ethCall(chain, env, marketAddr, abiEncodeSingleAddr(SEL_COMET_GET_PRICE, a.priceFeed))
      .catch(() => null)));

  let collateralUsd = 0;
  let riskAdjustedUsd = 0;
  const assets = [];
  held.forEach((a, i) => {
    const price = Number(abiHexWord(prices[i] || '0x', 0)) / COMET_PRICE_SCALE;
    if (!(price > 0)) return;
    const valueUsd = a.amount * price;
    collateralUsd   += valueUsd;
    riskAdjustedUsd += valueUsd * a.liquidateCf;
    assets.push({ asset: a.asset, amount: a.amount, valueUsd, liquidateCf: a.liquidateCf });
  });

  // Comet's own verdict, used as a cross-check on the arithmetic above: if the
  // protocol says the account is liquidatable, that is the truth regardless of
  // what our decode produced.
  const liqHex = await ethCall(chain, env, marketAddr,
    abiEncodeSingleAddr(SEL_COMET_IS_LIQUIDATABLE, wallet)).catch(() => null);
  const isLiquidatable = liqHex && liqHex !== '0x' ? abiHexWord(liqHex, 0) === 1n : null;

  let healthFactor = borrowUsd > 0 && riskAdjustedUsd > 0 ? riskAdjustedUsd / borrowUsd : null;
  if (isLiquidatable === true && (healthFactor == null || healthFactor >= 1)) healthFactor = 0.99;

  return { read: true, collateralUsd, riskAdjustedCollateralUsd: riskAdjustedUsd,
           healthFactor, isLiquidatable, assets };
}

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

    // Comet stores one signed principal per account, so balanceOf and
    // borrowBalanceOf are mutually exclusive: a borrower always reads
    // supply 0. The collateral backing a borrow lives in a separate slot,
    // so borrow/supply is never a collateralisation ratio — we have to read
    // the collateral side explicitly to say anything about risk.
    let collateral = null;
    if (borrowRaw > 0n) {
      collateral = await getCompoundV3Collateral(chain, env, m.address, wallet, borrow)
        .catch(() => ({ read: false }));
    }

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
      // Present only when the wallet borrows here. `healthFactor` is derived
      // on Aave's definition (risk-adjusted collateral / debt) so the score
      // engine can band it identically.
      collateralUsd:            collateral?.read ? collateral.collateralUsd : null,
      riskAdjustedCollateralUsd: collateral?.read ? collateral.riskAdjustedCollateralUsd : null,
      healthFactor:             collateral?.read ? collateral.healthFactor : null,
      isLiquidatable:           collateral?.read ? collateral.isLiquidatable : null,
      collateralRead:           borrowRaw > 0n ? !!collateral?.read : null,
      collateralAssets:         collateral?.read ? collateral.assets : undefined,
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
