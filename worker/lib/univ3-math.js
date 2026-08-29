/* DeFiScoring – Uniswap V3 position math
 *
 * Converts a concentrated-liquidity position into the token amounts it
 * currently holds, so the liquidity pillar can score deployed CAPITAL rather
 * than a count of NFTs. Counting treats a wallet holding twenty dust positions
 * as a bigger liquidity provider than one holding a single seven-figure
 * position, which is backwards.
 *
 * Pure functions, no network, no BigInt-precision games beyond what the result
 * needs: the output feeds a USD valuation that is then bucketed into a
 * sub-score, so a relative error of ~1e-15 is irrelevant. Exactness would
 * matter if we were settling trades; we are sizing a position.
 *
 * Reference: Uniswap V3 whitepaper §6.29–6.30 (LiquidityAmounts.sol).
 */

const Q96 = 2 ** 96;

// Uniswap's tick bounds. Positions cannot exist outside them, so a tick beyond
// this range means we misread the calldata and should not guess.
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

/** √P at a tick: price = 1.0001^tick, so √price = 1.0001^(tick/2). */
export function tickToSqrtPrice(tick) {
  if (!Number.isFinite(tick) || tick < MIN_TICK || tick > MAX_TICK) return null;
  return Math.pow(1.0001, tick / 2);
}

/** Convert the on-chain Q64.96 fixed-point √price into a plain number. */
export function sqrtPriceX96ToSqrtPrice(sqrtPriceX96) {
  const v = typeof sqrtPriceX96 === "bigint" ? Number(sqrtPriceX96) : Number(sqrtPriceX96);
  if (!Number.isFinite(v) || v <= 0) return null;
  return v / Q96;
}

/**
 * Token amounts held by a position, in RAW units (pre-decimals).
 *
 *   { amount0, amount1 }
 *
 * Which side the capital sits in depends on where the current price is
 * relative to the range — that is the whole point of concentrated liquidity:
 *
 *   price below the range  → entirely token0 (waiting to be bought)
 *   price above the range  → entirely token1 (already sold)
 *   price inside the range → a mix
 *
 * Returns null if any input is unusable, so the caller reports "could not
 * value" rather than a confident zero.
 */
export function positionAmounts({ liquidity, sqrtPrice, sqrtLower, sqrtUpper }) {
  const L = typeof liquidity === "bigint" ? Number(liquidity) : Number(liquidity);
  if (!Number.isFinite(L) || L <= 0) return null;
  if (![sqrtPrice, sqrtLower, sqrtUpper].every((x) => Number.isFinite(x) && x > 0)) return null;
  if (sqrtLower >= sqrtUpper) return null;

  if (sqrtPrice <= sqrtLower) {
    // Entirely token0.
    return { amount0: L * (1 / sqrtLower - 1 / sqrtUpper), amount1: 0 };
  }
  if (sqrtPrice >= sqrtUpper) {
    // Entirely token1.
    return { amount0: 0, amount1: L * (sqrtUpper - sqrtLower) };
  }
  return {
    amount0: L * (1 / sqrtPrice - 1 / sqrtUpper),
    amount1: L * (sqrtPrice - sqrtLower),
  };
}

/** Scale a raw amount by the token's decimals. */
export function fromRaw(amount, decimals) {
  const d = Number(decimals);
  if (!Number.isFinite(amount) || !Number.isFinite(d) || d < 0 || d > 36) return null;
  return amount / Math.pow(10, d);
}

/**
 * USD value of one position.
 *
 * A position is only valued when BOTH sides can be priced. Valuing one leg and
 * calling it the total would understate by roughly half and look like a real
 * number, which is worse than admitting we could not price it — the caller
 * treats null as "unvalued" and says so in the rationale.
 */
export function positionValueUsd(pos, prices) {
  const amounts = positionAmounts(pos);
  if (!amounts) return null;

  const p0 = prices?.[(pos.token0 || "").toLowerCase()];
  const p1 = prices?.[(pos.token1 || "").toLowerCase()];
  if (typeof p0 !== "number" || typeof p1 !== "number") return null;
  if (!(p0 >= 0) || !(p1 >= 0)) return null;

  const a0 = fromRaw(amounts.amount0, pos.decimals0);
  const a1 = fromRaw(amounts.amount1, pos.decimals1);
  if (a0 == null || a1 == null) return null;

  const usd = a0 * p0 + a1 * p1;
  return Number.isFinite(usd) && usd >= 0 ? usd : null;
}

/**
 * Read an ABI word as a SIGNED integer.
 *
 * tickLower/tickUpper are int24 and are routinely negative — any pool where
 * token1 is worth more than token0 per unit sits below tick 0. Read unsigned,
 * a tick of -100 becomes ~1.16e77 and every such position silently values at
 * zero. This is the sharpest edge in the whole calculation.
 */
export function abiWordToInt(word) {
  const v = typeof word === "bigint" ? word : BigInt(word || 0);
  const TWO_255 = 1n << 255n;
  const TWO_256 = 1n << 256n;
  return v >= TWO_255 ? Number(v - TWO_256) : Number(v);
}
