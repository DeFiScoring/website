// worker/lib/defi.js
// ----------------------------------------------------------------------------
// DeFi position reader — one-call-per-chain summaries of lending health,
// stable-supply yield, and LP exposure. Every reader returns a uniform shape
// so the handler / score engine never branches on protocol.
//
// Designed to fail soft: a chain without Aave returns { hasPosition: false },
// not an error. An RPC timeout returns { error } on the row, not a 500.
// ----------------------------------------------------------------------------

import { ethCall, abiEncodeSingleAddr, abiHexWord, abiPadAddr, alchemyRpcBatch } from './providers.js';
import {
  tickToSqrtPrice, sqrtPriceX96ToSqrtPrice, positionValueUsd, abiWordToInt,
} from './univ3-math.js';
import { getMorphoPosition } from './morpho.js';
import { priceTokensWithFallback } from './prices.js';
import { CHAINS_BY_ID } from './chains.js';
import {
  AAVE_V3_POOLS,
  SPARK_POOLS,
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
const SEL_TOKEN_OF_OWNER_BY_IDX  = '0x2f745c59'; // ERC-721Enumerable: tokenOfOwnerByIndex(address,uint256)
const SEL_UNI_V3_POSITIONS       = '0x99fbab88'; // Uniswap V3 NPM: positions(uint256)

// Enumerating every position of a farming wallet is unbounded work; 20 is
// deep enough to separate a real LP from a dust holder and is what the two
// batched subrequests below can carry.
const UNI_V3_MAX_ENUMERATE = 20;

// Valuing a position needs the pool it belongs to, that pool's current price,
// and both tokens' decimals. The factory is at the same address on every chain
// the canonical V3 deployment reached.
const UNI_V3_FACTORY   = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const SEL_GET_POOL     = '0x1698ee82'; // getPool(address,address,uint24)
const SEL_SLOT0        = '0x3850c7bd'; // slot0()
const SEL_DECIMALS     = '0x313ce567'; // decimals()

// =============================================================================
// Aave V3 — single eth_call per chain returns full account summary in 8d base.
// =============================================================================

export async function getAaveV3Position(chain, env, wallet) {
  return readAaveStylePool(chain, env, wallet, AAVE_V3_POOLS[chain.id], 'aave-v3');
}

// Spark is an Aave V3 fork with an unchanged Pool ABI, so its reader IS the
// Aave reader pointed at Spark's pools — same decode, same healthFactor
// semantics, no conversion. Only the protocol slug differs.
export async function getSparkPosition(chain, env, wallet) {
  return readAaveStylePool(chain, env, wallet, SPARK_POOLS[chain.id], 'spark');
}

async function readAaveStylePool(chain, env, wallet, pool, slug) {
  if (!pool) return { protocol: slug, chain: chain.id, hasPosition: false, deployed: false };
  const data = abiEncodeSingleAddr(SEL_GET_USER_ACCOUNT_DATA, wallet);
  const r = await ethCall(chain, env, pool, data);
  if (!r || r === '0x') return { protocol: slug, chain: chain.id, hasPosition: false, deployed: true };
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
    protocol:           slug,
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

/**
 * Resolve how many of a wallet's Uniswap V3 position NFTs are actually live.
 *
 * balanceOf on the position manager counts NFTs, and burning is optional:
 * a fully-withdrawn position keeps its token, so a wallet that closed ten
 * positions still reads as a ten-position LP. Only `liquidity > 0` means
 * capital is currently deployed.
 *
 * Costs two subrequests regardless of position count: one batched
 * tokenOfOwnerByIndex sweep, one batched positions() sweep. Alchemy-only,
 * because Etherscan's proxy endpoint has no batch equivalent and doing this
 * one call at a time would cost up to 40 subrequests per chain.
 *
 * Returns null when the data can't be had, so callers can fall back to the
 * raw count instead of reporting a confident zero.
 */
async function getUniV3ActivePositions(chain, env, wallet, nftCount) {
  const want = Math.min(nftCount, UNI_V3_MAX_ENUMERATE);
  if (want <= 0) return null;

  const idCalls = Array.from({ length: want }, (_, i) => ({
    method: 'eth_call',
    params: [{
      to: UNI_V3_POSITION_MANAGER,
      data: SEL_TOKEN_OF_OWNER_BY_IDX + abiPadAddr(wallet) + i.toString(16).padStart(64, '0'),
    }, 'latest'],
  }));
  const idResults = await alchemyRpcBatch(chain, env, idCalls);

  const tokenIds = [];
  for (const hex of idResults) {
    if (typeof hex !== 'string' || hex === '0x') continue;
    const id = abiHexWord(hex, 0);
    tokenIds.push(id);
  }
  // Every enumeration slot failed — report unknown rather than zero.
  if (!tokenIds.length) return null;

  const posCalls = tokenIds.map((id) => ({
    method: 'eth_call',
    params: [{
      to: UNI_V3_POSITION_MANAGER,
      data: SEL_UNI_V3_POSITIONS + id.toString(16).padStart(64, '0'),
    }, 'latest'],
  }));
  const posResults = await alchemyRpcBatch(chain, env, posCalls);

  // positions() returns 12 words:
  //   0 nonce, 1 operator, 2 token0, 3 token1, 4 fee,
  //   5 tickLower, 6 tickUpper, 7 liquidity, ...
  // Ticks are int24 and are routinely NEGATIVE, so they must be read signed —
  // see abiWordToInt. The rest are unsigned.
  let active = 0;
  let read = 0;
  const positions = [];
  for (const hex of posResults) {
    if (typeof hex !== 'string' || hex === '0x') continue;
    read += 1;
    const liquidity = abiHexWord(hex, 7);
    if (liquidity <= 0n) continue;          // closed position, holds nothing
    active += 1;
    positions.push({
      token0:    '0x' + abiHexWord(hex, 2).toString(16).padStart(40, '0'),
      token1:    '0x' + abiHexWord(hex, 3).toString(16).padStart(40, '0'),
      fee:       Number(abiHexWord(hex, 4)),
      tickLower: abiWordToInt(abiHexWord(hex, 5)),
      tickUpper: abiWordToInt(abiHexWord(hex, 6)),
      liquidity,
    });
  }
  if (!read) return null;

  return { activeLpCount: active, positionsRead: read, enumerated: tokenIds.length,
           positions, truncated: nftCount > UNI_V3_MAX_ENUMERATE };
}

/**
 * Put a USD value on live Uniswap V3 positions.
 *
 * Counting positions treats twenty dust NFTs as more liquidity provision than
 * one seven-figure position. Valuing them fixes that, at the cost of three
 * extra reads per chain — each a BATCH, so three HTTP subrequests, not three
 * per position:
 *
 *   1. factory.getPool(token0, token1, fee)  → the pool for each position
 *   2. pool.slot0()                          → its current √price
 *   3. token.decimals()                      → to scale raw amounts
 *
 * then one price lookup for the distinct tokens.
 *
 * Requires the Alchemy batch endpoint. Without it the caller keeps the count
 * and says the value is unknown — an unpriced position must never be treated
 * as a worthless one.
 *
 * Returns { valueUsd, valuedCount, unvaluedCount } or null if nothing could be
 * valued at all.
 */
async function valueUniV3Positions(chain, env, positions, fiat = 'USD') {
  if (!positions?.length || !chain.alchemy || !env.ALCHEMY_KEY) return null;

  // 1 — resolve each position's pool.
  const poolCalls = positions.map((p) => ({
    method: 'eth_call',
    params: [{
      to: UNI_V3_FACTORY,
      data: SEL_GET_POOL + abiPadAddr(p.token0) + abiPadAddr(p.token1) +
            p.fee.toString(16).padStart(64, '0'),
    }, 'latest'],
  }));
  const poolResults = await alchemyRpcBatch(chain, env, poolCalls).catch(() => []);

  const withPool = [];
  poolResults.forEach((hex, i) => {
    if (typeof hex !== 'string' || hex === '0x') return;
    const addr = '0x' + abiHexWord(hex, 0).toString(16).padStart(40, '0');
    if (/^0x0+$/.test(addr)) return;      // factory returned the zero address
    withPool.push({ ...positions[i], pool: addr });
  });
  if (!withPool.length) return null;

  // 2 — current √price per pool. Distinct pools only: several positions
  // commonly share one.
  const pools = [...new Set(withPool.map((p) => p.pool))];
  const slotCalls = pools.map((pool) => ({
    method: 'eth_call', params: [{ to: pool, data: SEL_SLOT0 }, 'latest'],
  }));
  const slotResults = await alchemyRpcBatch(chain, env, slotCalls).catch(() => []);
  const sqrtByPool = {};
  slotResults.forEach((hex, i) => {
    if (typeof hex !== 'string' || hex === '0x') return;
    const sp = sqrtPriceX96ToSqrtPrice(abiHexWord(hex, 0));   // slot0 word 0
    if (sp != null) sqrtByPool[pools[i]] = sp;
  });

  // 3 — decimals for every distinct token.
  const tokens = [...new Set(withPool.flatMap((p) => [p.token0, p.token1]))];
  const decCalls = tokens.map((t) => ({
    method: 'eth_call', params: [{ to: t, data: SEL_DECIMALS }, 'latest'],
  }));
  const decResults = await alchemyRpcBatch(chain, env, decCalls).catch(() => []);
  const decimalsByToken = {};
  decResults.forEach((hex, i) => {
    if (typeof hex !== 'string' || hex === '0x') return;
    const d = Number(abiHexWord(hex, 0));
    if (Number.isFinite(d) && d >= 0 && d <= 36) decimalsByToken[tokens[i]] = d;
  });

  // 4 — prices for those tokens.
  // priceTokensWithFallback takes {contract} rows and returns
  // { contract: { usd: price } }, keyed lowercase.
  const fiatLow = String(fiat || 'USD').toLowerCase();
  let priceMap = {};
  try {
    const priced = await priceTokensWithFallback(
      chain, env, tokens.map((t) => ({ contract: t })), fiat);
    for (const [addr, px] of Object.entries(priced || {})) {
      const v = px && typeof px === 'object' ? Number(px[fiatLow]) : Number(px);
      if (Number.isFinite(v) && v >= 0) priceMap[addr.toLowerCase()] = v;
    }
  } catch { /* unpriced positions are reported as such, not as zero */ }

  let valueUsd = 0;
  let valued = 0;
  let unvalued = 0;
  for (const p of withPool) {
    const sqrtPrice = sqrtByPool[p.pool];
    const sqrtLower = tickToSqrtPrice(p.tickLower);
    const sqrtUpper = tickToSqrtPrice(p.tickUpper);
    const usd = (sqrtPrice == null || sqrtLower == null || sqrtUpper == null)
      ? null
      : positionValueUsd({
          liquidity: p.liquidity, sqrtPrice, sqrtLower, sqrtUpper,
          token0: p.token0, token1: p.token1,
          decimals0: decimalsByToken[p.token0], decimals1: decimalsByToken[p.token1],
        }, priceMap);
    if (usd == null) { unvalued += 1; continue; }
    valueUsd += usd;
    valued += 1;
  }

  if (!valued) return null;
  return { valueUsd, valuedCount: valued, unvaluedCount: unvalued + (positions.length - withPool.length) };
}

export async function getUniV3LpCount(chain, env, wallet) {
  if (!UNI_V3_NPM_CHAINS.includes(chain.id)) {
    return { protocol: 'uniswap-v3-lp', chain: chain.id, hasPosition: false, deployed: false };
  }
  const data = abiEncodeSingleAddr(SEL_BALANCE_OF, wallet);
  const r = await ethCall(chain, env, UNI_V3_POSITION_MANAGER, data);
  if (!r || r === '0x') return { protocol: 'uniswap-v3-lp', chain: chain.id, hasPosition: false, deployed: true };
  const count = Number(abiHexWord(r, 0));

  // lpCount is NFTs held, which over-counts: closed positions keep their
  // token. Resolve how many are live where we can afford to.
  let live = null;
  let valued = null;
  if (count > 0 && chain.alchemy && env.ALCHEMY_KEY) {
    live = await getUniV3ActivePositions(chain, env, wallet, count).catch(() => null);
    if (live?.positions?.length) {
      valued = await valueUniV3Positions(chain, env, live.positions).catch(() => null);
    }
  }

  return {
    protocol:    'uniswap-v3-lp',
    category:    'dex',
    chain:       chain.id,
    chainName:   chain.name,
    chainId:     chain.chainId,
    deployed:    true,
    // A wallet holding only closed positions has no LP exposure, so an
    // active count of 0 means no position even though it holds NFTs.
    hasPosition: live ? live.activeLpCount > 0 : count > 0,
    lpCount:     count,
    // null when un-resolvable (no Alchemy key, or the reads failed) — the
    // scorer must be able to tell "none live" from "we couldn't check".
    activeLpCount:   live ? live.activeLpCount : null,
    positionsRead:   live ? live.positionsRead : null,
    // True when the wallet holds more NFTs than we enumerate; activeLpCount
    // is then a floor, not a total.
    lpCountTruncated: live ? live.truncated : null,
    // USD of live liquidity. null means "we could not value it", never zero —
    // an unpriced position is not a worthless one, and the pillar scores those
    // two cases differently.
    lpValueUsd:       valued ? valued.valueUsd : null,
    lpValuedCount:    valued ? valued.valuedCount : null,
    lpUnvaluedCount:  valued ? valued.unvaluedCount : null,
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
      const [aave, spark, compoundList, morpho, uni] = await Promise.all([
        getAaveV3Position(chain, env, wallet).catch((e) => ({ protocol: 'aave-v3', chain: chain.id, error: String(e.message || e) })),
        getSparkPosition(chain, env, wallet).catch((e) => ({ protocol: 'spark', chain: chain.id, error: String(e.message || e) })),
        getCompoundV3Positions(chain, env, wallet).catch((e) => [{ protocol: 'compound-v3', chain: chain.id, error: String(e.message || e) }]),
        getMorphoPosition(chain, env, wallet).catch((e) => ({ protocol: 'morpho-blue', chain: chain.id, error: String(e.message || e) })),
        getUniV3LpCount(chain, env, wallet).catch((e) => ({ protocol: 'uniswap-v3-lp', chain: chain.id, error: String(e.message || e) })),
      ]);
      const protocols = [aave, spark, ...compoundList, morpho, uni];
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
