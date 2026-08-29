/* DeFiScoring – Morpho Blue reader
 *
 * Morpho Blue is the largest lending protocol the loan-reliability pillar did
 * not cover; the methodology named it by name as the example of a borrower we
 * score `real: false`. This closes that.
 *
 * WHY IT IS NOT A DROP-IN LIKE SPARK
 *
 * Aave and its forks answer everything in one call: getUserAccountData(user)
 * returns total collateral, total debt and a health factor. Morpho Blue has no
 * such view, because it has no such concept — it is a set of ISOLATED markets,
 * each its own (loanToken, collateralToken, oracle, irm, lltv) tuple, and a
 * position exists per market. There is no on-chain enumeration of "markets
 * this user is in".
 *
 * So this reader works in two stages:
 *
 *   1. DISCOVER  which markets the wallet has borrowed in, by scanning Borrow
 *                logs filtered on the indexed `onBehalf` topic. Same shape as
 *                the ERC-20 approval scanner: one getLogs per chain, and the
 *                topic filter makes it selective enough that most wallets
 *                match nothing.
 *   2. READ      position, market state and oracle price for each discovered
 *                market, batched.
 *
 * A health factor is then derived per market on the same definition Aave
 * publishes — risk-adjusted collateral over debt — so Morpho positions land on
 * the same scale as Aave, Spark and Compound with no conversion factor:
 *
 *     collateralValue = collateral × oraclePrice / 1e36
 *     maxBorrow       = collateralValue × lltv / 1e18
 *     healthFactor    = maxBorrow / borrowedAssets
 *
 * A discovery failure is reported as UNKNOWN, never as "no position". A wallet
 * we could not scan and a wallet with nothing to find must not look alike —
 * the first is a gap in our data, the second is a fact about the wallet.
 */

import { etherscanCall, alchemyRpcBatch, ethCall, abiHexWord } from './providers.js';
import { MORPHO_BLUE } from './defi-protocols.js';

// keccak256("Borrow(bytes32,address,address,address,uint256,uint256)")
export const BORROW_TOPIC =
  '0x570954540bed6b1304a87dfe815a5eda4a648f7097a16240dcd85c9b5fd42a43';

const SEL_POSITION            = '0x93c52062'; // position(bytes32,address)
const SEL_MARKET              = '0x5c60e39a'; // market(bytes32)
const SEL_ID_TO_MARKET_PARAMS = '0x2c3c9157'; // idToMarketParams(bytes32)
const SEL_ORACLE_PRICE        = '0xa035b1fe'; // price()

// Morpho's oracle scale and the LLTV scale (WAD).
const ORACLE_SCALE = 10n ** 36n;
const WAD = 10n ** 18n;

// A wallet in more markets than this is an outlier; we read the most recent
// ones and report the result as a floor rather than blowing the subrequest
// budget on one chain.
const MAX_MARKETS = 8;

/**
 * Which chains we spend a discovery call on.
 *
 * Discovery costs one getLogs per chain and CANNOT be avoided — Morpho Blue
 * publishes no on-chain index of a user's markets. The Tier-1 scan already
 * sits at 48 of Cloudflare's 50 subrequests, so scanning all five chains
 * (+5) would break every scan rather than add coverage.
 *
 * So we spend the headroom where the protocol actually is: Morpho Blue's TVL
 * is overwhelmingly on Ethereum. Chains we skip are reported as NOT CHECKED,
 * never as "no position" — the distinction this codebase keeps everywhere
 * else, and the one that matters most here, because a wallet borrowing on
 * Base would otherwise be silently recorded as having no Morpho debt.
 *
 * Widening this list needs subrequest headroom in the scan first; it is not a
 * matter of editing the array.
 */
export const MORPHO_SCAN_CHAINS = ['ethereum'];

export function morphoScanChains(env) {
  const raw = env?.MORPHO_SCAN_CHAINS;
  if (typeof raw !== 'string' || !raw.trim()) return MORPHO_SCAN_CHAINS;
  return raw.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
}

function pad32(hex) {
  return String(hex).replace(/^0x/, '').padStart(64, '0');
}

/**
 * Discover market ids this wallet has borrowed in.
 *
 * Returns { ok, ids } — ok:false is a failed scan, distinct from ok:true with
 * an empty list. Collapsing the two would report "no Morpho debt" for a wallet
 * we simply could not read.
 */
export async function discoverMarkets(chain, env, wallet) {
  const morpho = MORPHO_BLUE[chain.id];
  if (!morpho) return { ok: true, ids: [], deployed: false };

  // Borrow indexes (id, onBehalf, receiver) → topic1 = id, topic2 = onBehalf.
  const topic2 = '0x' + '0'.repeat(24) + wallet.toLowerCase().slice(2);
  try {
    const r = await etherscanCall(chain, env, {
      module: 'logs', action: 'getLogs',
      fromBlock: 0, toBlock: 'latest',
      address: morpho,
      topic0: BORROW_TOPIC, topic2, topic0_2_opr: 'and',
    });
    if (!Array.isArray(r)) return { ok: false, ids: [], deployed: true };
    const seen = new Set();
    // Newest first: if a wallet exceeds MAX_MARKETS we want its current
    // activity, not its oldest.
    for (const log of r.slice().reverse()) {
      const topics = log.topics || [];
      if (String(topics[0] || '').toLowerCase() !== BORROW_TOPIC) continue;
      const id = String(topics[1] || '').toLowerCase();
      if (/^0x[0-9a-f]{64}$/.test(id)) seen.add(id);
    }
    const ids = [...seen];
    return {
      ok: true, deployed: true,
      ids: ids.slice(0, MAX_MARKETS),
      truncated: ids.length > MAX_MARKETS,
    };
  } catch {
    return { ok: false, ids: [], deployed: true };
  }
}

/** Batch helper that degrades to serial ethCall when no batch endpoint exists. */
async function readMany(chain, env, calls) {
  if (chain.alchemy && env.ALCHEMY_KEY) {
    return alchemyRpcBatch(chain, env, calls.map((c) => ({
      method: 'eth_call', params: [{ to: c.to, data: c.data }, 'latest'],
    }))).catch(() => []);
  }
  // Without batching each read is its own subrequest, so this path is only
  // affordable because MAX_MARKETS is small.
  const out = [];
  for (const c of calls) {
    out.push(await ethCall(chain, env, c.to, c.data).catch(() => null));
  }
  return out;
}

/**
 * Health factor for one market, from the raw reads.
 *
 * Exported and pure so the arithmetic is testable without a chain: this is
 * where a wrong scale silently produces a plausible number.
 */
export function healthFactorFor({ collateral, borrowShares, totalBorrowAssets, totalBorrowShares, lltv, price }) {
  if (!borrowShares || borrowShares === 0n) return null;   // no debt, no HF
  if (!totalBorrowShares || totalBorrowShares === 0n) return null;
  if (!price || price === 0n) return null;

  // Debt owed = shares × assets / shares, rounded UP: understating debt would
  // overstate health, which is the direction that hurts.
  const debt = (borrowShares * totalBorrowAssets + totalBorrowShares - 1n) / totalBorrowShares;
  if (debt === 0n) return null;

  const collateralValue = (collateral * price) / ORACLE_SCALE;
  const maxBorrow = (collateralValue * lltv) / WAD;
  if (maxBorrow === 0n) return 0;

  // Ratio in float: the pillar bands it, it is never used for settlement.
  const hf = Number(maxBorrow) / Number(debt);
  return Number.isFinite(hf) && hf >= 0 ? hf : null;
}

/**
 * Read the wallet's Morpho Blue position on one chain.
 *
 * Shape matches the other protocol readers in lib/defi.js so the pillar can
 * treat it uniformly: { protocol, hasPosition, healthFactor, ... }.
 */
export async function getMorphoPosition(chain, env, wallet) {
  const morpho = MORPHO_BLUE[chain.id];
  const base = { protocol: 'morpho-blue', category: 'lending', chain: chain.id,
                 chainName: chain.name, chainId: chain.chainId };
  if (!morpho) return { ...base, deployed: false, hasPosition: false };

  // Deployed here, but outside the chains we can afford to scan. Say NOT
  // CHECKED — reporting hasPosition:false would assert something we never
  // looked for.
  if (!morphoScanChains(env).includes(chain.id)) {
    return { ...base, deployed: true, hasPosition: false, unknown: true,
             reason: 'chain_not_scanned' };
  }

  const found = await discoverMarkets(chain, env, wallet);
  if (!found.ok) {
    // Could not scan. Say so — do not imply the wallet has no Morpho debt.
    return { ...base, deployed: true, hasPosition: false, unknown: true,
             reason: 'market_discovery_failed' };
  }
  if (!found.ids.length) return { ...base, deployed: true, hasPosition: false };

  const ids = found.ids;
  const [positions, markets, params] = await Promise.all([
    readMany(chain, env, ids.map((id) => ({
      to: morpho, data: SEL_POSITION + pad32(id) + pad32(wallet) }))),
    readMany(chain, env, ids.map((id) => ({ to: morpho, data: SEL_MARKET + pad32(id) }))),
    readMany(chain, env, ids.map((id) => ({ to: morpho, data: SEL_ID_TO_MARKET_PARAMS + pad32(id) }))),
  ]);

  // Oracles differ per market, so their prices are a second round.
  const oracles = ids.map((_, i) => {
    const p = params[i];
    if (typeof p !== 'string' || p === '0x') return null;
    const addr = '0x' + abiHexWord(p, 2).toString(16).padStart(40, '0');
    return /^0x0+$/.test(addr) ? null : addr;
  });
  const priceCalls = oracles.filter(Boolean).map((o) => ({ to: o, data: SEL_ORACLE_PRICE }));
  const priceResults = priceCalls.length ? await readMany(chain, env, priceCalls) : [];
  const priceByOracle = {};
  let pi = 0;
  for (const o of oracles) {
    if (!o) continue;
    const hex = priceResults[pi++];
    if (typeof hex === 'string' && hex !== '0x') priceByOracle[o] = abiHexWord(hex, 0);
  }

  let lowestHf = null;
  let read = 0;
  let withDebt = 0;
  for (let i = 0; i < ids.length; i++) {
    const pos = positions[i], mkt = markets[i], par = params[i];
    if ([pos, mkt, par].some((x) => typeof x !== 'string' || x === '0x')) continue;
    read += 1;
    // position: supplyShares, borrowShares, collateral
    const borrowShares = abiHexWord(pos, 1);
    const collateral   = abiHexWord(pos, 2);
    if (borrowShares === 0n) continue;
    withDebt += 1;
    // market: totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, ...
    const totalBorrowAssets = abiHexWord(mkt, 2);
    const totalBorrowShares = abiHexWord(mkt, 3);
    // params: loanToken, collateralToken, oracle, irm, lltv
    const lltv = abiHexWord(par, 4);
    const price = priceByOracle[oracles[i]];

    const hf = healthFactorFor({ collateral, borrowShares, totalBorrowAssets,
                                 totalBorrowShares, lltv, price });
    if (hf == null) continue;
    if (lowestHf == null || hf < lowestHf) lowestHf = hf;
  }

  if (!read) {
    return { ...base, deployed: true, hasPosition: false, unknown: true,
             reason: 'market_reads_failed', marketsFound: ids.length };
  }

  return {
    ...base,
    deployed: true,
    hasPosition: withDebt > 0 && lowestHf != null,
    healthFactor: lowestHf,
    marketsFound: ids.length,
    marketsWithDebt: withDebt,
    // The wallet borrows in more markets than we read; the lowest HF we
    // report is therefore a ceiling on the real risk, not a total picture.
    truncated: !!found.truncated,
  };
}
