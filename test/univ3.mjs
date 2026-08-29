// Uniswap V3 position math.
//
// Scoring deployed CAPITAL instead of a count of NFTs only works if the
// amounts are right, so these check the formulas against cases computable by
// hand rather than against a fixture produced by the same code.
import {
  tickToSqrtPrice, sqrtPriceX96ToSqrtPrice, positionAmounts, fromRaw,
  positionValueUsd, abiWordToInt, MIN_TICK, MAX_TICK,
} from "../worker/lib/univ3-math.js";

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log((cond ? "PASS  " : "FAIL  ") + name + (cond ? "" : "  →  " + JSON.stringify(detail)));
}
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

// --- signed ABI words ------------------------------------------------------
// tickLower/tickUpper are int24 and are routinely negative: any pool where
// token1 is worth more per unit than token0 sits below tick 0. Read unsigned,
// −100 becomes ~1.16e77, the range degenerates and every such position values
// at zero — the single sharpest edge in this calculation.
const twosComp = (n) => (1n << 256n) + BigInt(n);
check("a negative int24 decodes to its negative value",
  abiWordToInt(twosComp(-100)) === -100, abiWordToInt(twosComp(-100)));
check("Uniswap's minimum tick round-trips",
  abiWordToInt(twosComp(MIN_TICK)) === MIN_TICK, abiWordToInt(twosComp(MIN_TICK)));
check("a positive word is unchanged", abiWordToInt(887272n) === 887272, null);
check("zero decodes to zero", abiWordToInt(0n) === 0, null);
check("a negative tick still produces a usable √price",
  Number.isFinite(tickToSqrtPrice(abiWordToInt(twosComp(-60)))) &&
  tickToSqrtPrice(abiWordToInt(twosComp(-60))) < 1,
  tickToSqrtPrice(abiWordToInt(twosComp(-60))));

// --- tick → √price --------------------------------------------------------
check("tick 0 is √price 1", near(tickToSqrtPrice(0), 1), tickToSqrtPrice(0));
check("√price of tick t squared is 1.0001^t",
  near(Math.pow(tickToSqrtPrice(2000), 2), Math.pow(1.0001, 2000)), null);
check("a higher tick is a higher price", tickToSqrtPrice(100) > tickToSqrtPrice(-100), null);
check("the tick bounds are representable",
  Number.isFinite(tickToSqrtPrice(MIN_TICK)) && Number.isFinite(tickToSqrtPrice(MAX_TICK)),
  [tickToSqrtPrice(MIN_TICK), tickToSqrtPrice(MAX_TICK)]);
check("a tick beyond Uniswap's bounds is refused, not extrapolated",
  tickToSqrtPrice(MAX_TICK + 1) === null && tickToSqrtPrice(MIN_TICK - 1) === null, null);
check("a non-numeric tick is refused", tickToSqrtPrice("abc") === null, null);

// --- Q64.96 ---------------------------------------------------------------
check("2^96 decodes to √price 1", near(sqrtPriceX96ToSqrtPrice(2n ** 96n), 1), null);
check("2^97 decodes to √price 2", near(sqrtPriceX96ToSqrtPrice(2n ** 97n), 2), null);
check("zero is refused", sqrtPriceX96ToSqrtPrice(0n) === null, null);

// --- position amounts, hand-computable cases ------------------------------
// Range √P ∈ [1, 2], liquidity 1000.
const RANGE = { sqrtLower: 1, sqrtUpper: 2, liquidity: 1000 };

// At/below the lower bound the position is entirely token0:
//   amount0 = L (1/√lower − 1/√upper) = 1000 (1 − 0.5) = 500
let a = positionAmounts({ ...RANGE, sqrtPrice: 1 });
check("at the lower bound the position is all token0", a.amount1 === 0 && near(a.amount0, 500), a);
a = positionAmounts({ ...RANGE, sqrtPrice: 0.5 });
check("below the range it stays all token0, unchanged",
  a.amount1 === 0 && near(a.amount0, 500), a);

// At/above the upper bound it is entirely token1:
//   amount1 = L (√upper − √lower) = 1000 (2 − 1) = 1000
a = positionAmounts({ ...RANGE, sqrtPrice: 2 });
check("at the upper bound the position is all token1", a.amount0 === 0 && near(a.amount1, 1000), a);
a = positionAmounts({ ...RANGE, sqrtPrice: 4 });
check("above the range it stays all token1, unchanged",
  a.amount0 === 0 && near(a.amount1, 1000), a);

// Inside: √P = 1.5 →
//   amount0 = 1000 (1/1.5 − 1/2)   = 1000 (0.6666… − 0.5) = 166.666…
//   amount1 = 1000 (1.5 − 1)       = 500
a = positionAmounts({ ...RANGE, sqrtPrice: 1.5 });
check("inside the range both sides are held",
  near(a.amount0, 1000 * (1 / 1.5 - 0.5), 1e-12) && near(a.amount1, 500), a);

// Liquidity scales the amounts linearly — the invariant that makes value
// comparable across positions.
const base = positionAmounts({ ...RANGE, sqrtPrice: 1.5 });
const dbl = positionAmounts({ ...RANGE, sqrtPrice: 1.5, liquidity: 2000 });
check("doubling liquidity doubles both amounts",
  near(dbl.amount0, base.amount0 * 2) && near(dbl.amount1, base.amount1 * 2), { base, dbl });

// --- refusals rather than confident zeros ---------------------------------
check("zero liquidity is unvaluable, not zero-valued",
  positionAmounts({ ...RANGE, sqrtPrice: 1.5, liquidity: 0 }) === null, null);
check("an inverted range is refused",
  positionAmounts({ sqrtLower: 2, sqrtUpper: 1, sqrtPrice: 1.5, liquidity: 1000 }) === null, null);
check("a zero-width range is refused",
  positionAmounts({ sqrtLower: 1, sqrtUpper: 1, sqrtPrice: 1, liquidity: 1000 }) === null, null);
check("a missing price is refused",
  positionAmounts({ ...RANGE, sqrtPrice: NaN, liquidity: 1000 }) === null, null);

// --- decimals --------------------------------------------------------------
check("18 decimals scales as expected", near(fromRaw(1e18, 18), 1), fromRaw(1e18, 18));
check("6 decimals (USDC) scales as expected", near(fromRaw(2_500_000, 6), 2.5), null);
check("an absurd decimals value is refused", fromRaw(1, 99) === null, null);

// --- USD valuation ---------------------------------------------------------
const T0 = "0xaaaa000000000000000000000000000000000000";
const T1 = "0xbbbb000000000000000000000000000000000000";
// Inside the range, both sides priced at $1 and 0 decimals for arithmetic
// that stays hand-checkable: 166.666… + 500 = 666.666…
const pos = { ...RANGE, sqrtPrice: 1.5, token0: T0, token1: T1, decimals0: 0, decimals1: 0 };
check("a fully priced position gets a USD value",
  near(positionValueUsd(pos, { [T0]: 1, [T1]: 1 }), 1000 * (1 / 1.5 - 0.5) + 500, 1e-12),
  positionValueUsd(pos, { [T0]: 1, [T1]: 1 }));
check("prices are matched case-insensitively",
  positionValueUsd({ ...pos, token0: T0.toUpperCase().replace("0X", "0x") },
    { [T0]: 1, [T1]: 1 }) !== null, null);
// The important refusal: half a valuation looks like a real number.
check("a position with one unpriceable leg is unvalued, not half-valued",
  positionValueUsd(pos, { [T0]: 1 }) === null, positionValueUsd(pos, { [T0]: 1 }));
// The dangerous shape: an explicit null price arithmetically coerces to 0, so
// a laxer guard would return HALF the position's value as if it were the whole
// thing — a plausible-looking number rather than an honest refusal.
check("an explicitly null price is refused, not coerced to zero",
  positionValueUsd(pos, { [T0]: 1, [T1]: null }) === null,
  positionValueUsd(pos, { [T0]: 1, [T1]: null }));
check("a string price is refused rather than coerced",
  positionValueUsd(pos, { [T0]: 1, [T1]: "2" }) === null, null);
check("no prices at all is unvalued", positionValueUsd(pos, {}) === null, null);
check("a negative price is refused", positionValueUsd(pos, { [T0]: -1, [T1]: 1 }) === null, null);
check("a zero price is allowed (a worthless token is a real answer)",
  positionValueUsd(pos, { [T0]: 0, [T1]: 1 }) === 500, positionValueUsd(pos, { [T0]: 0, [T1]: 1 }));

// --- the pillar: value beats count ----------------------------------------
// The defect this replaces, stated as a test: a wallet holding twenty dust
// positions used to outscore a wallet holding one seven-figure position,
// because only the count was read.
const { pillarLiquidityProvision } = await import("../worker/lib/score.js");
const chainWith = (rows) => [{ protocols: rows.map((r) => ({ protocol: "uniswap-v3-lp", ...r })) }];

const whale = pillarLiquidityProvision(chainWith([
  { lpCount: 1, activeLpCount: 1, lpValueUsd: 2_000_000, lpValuedCount: 1, lpUnvaluedCount: 0 },
]));
const dust = pillarLiquidityProvision(chainWith([
  { lpCount: 20, activeLpCount: 20, lpValueUsd: 20, lpValuedCount: 20, lpUnvaluedCount: 0 },
]));
check("a single seven-figure position outscores twenty dust positions",
  whale.value > dust.value, { whale: whale.value, dust: dust.value });
check("dust is scored as dust, not as a market maker", dust.value === 50, dust);
check("a seven-figure position reaches the top band", whale.value === 95, whale);
check("the rationale leads with the value, not the count",
  /\$2\.0M/.test(whale.rationale), whale.rationale);

// Monotonic across the bands — a bigger position never scores lower.
const at = (usd) => pillarLiquidityProvision(chainWith([
  { lpCount: 1, activeLpCount: 1, lpValueUsd: usd, lpValuedCount: 1, lpUnvaluedCount: 0 },
])).value;
const ladder = [50, 500, 5_000, 20_000, 100_000, 500_000].map(at);
check("score is monotonic in position value",
  ladder.every((v, i) => i === 0 || v >= ladder[i - 1]), ladder);

// Falling back to count must SAY it is a count, so nobody reads the score as
// a statement about capital.
const counted = pillarLiquidityProvision(chainWith([{ lpCount: 20, activeLpCount: 20 }]));
check("with no value resolved the pillar falls back to count",
  counted.value === 95, counted.value);
check("...and says so in the rationale",
  /scored on position count/.test(counted.rationale), counted.rationale);
check("a valued pillar does not claim to be count-based",
  !/scored on position count/.test(whale.rationale), whale.rationale);

// Partially priced: the total must be described as a floor.
const partial = pillarLiquidityProvision(chainWith([
  { lpCount: 5, activeLpCount: 5, lpValueUsd: 12_000, lpValuedCount: 3, lpUnvaluedCount: 2 },
]));
check("unpriced positions are disclosed as making the total a floor",
  /floor/.test(partial.rationale) && /2 further/.test(partial.rationale), partial.rationale);

// An unpriceable position is not a worthless one.
const unpriced = pillarLiquidityProvision(chainWith([
  { lpCount: 2, activeLpCount: 2, lpValueUsd: null },
]));
check("a position we could not price is not scored as zero value",
  unpriced.value === 65 && /scored on position count/.test(unpriced.rationale), unpriced);

// Closed positions still score nothing, and say why.
const closed = pillarLiquidityProvision(chainWith([
  { lpCount: 10, activeLpCount: 0, lpValueUsd: null },
]));
check("holding only closed NFTs is real:false, not a score",
  closed.real === false && closed.value === 50, closed);
check("...and the rationale distinguishes a former LP from a never-LP",
  /none currently hold liquidity/.test(closed.rationale), closed.rationale);

// Multi-chain bonus still applies on top of a value-based score.
const twoChains = pillarLiquidityProvision([
  { protocols: [{ protocol: "uniswap-v3-lp", lpCount: 1, activeLpCount: 1, lpValueUsd: 60_000, lpValuedCount: 1, lpUnvaluedCount: 0 }] },
  { protocols: [{ protocol: "uniswap-v3-lp", lpCount: 1, activeLpCount: 1, lpValueUsd: 60_000, lpValuedCount: 1, lpUnvaluedCount: 0 }] },
]);
// $120K total sits in the >=$50K band (85); two chains adds the +5 bonus.
check("liquidity on two chains still earns the diversification bonus",
  twoChains.value === 90, twoChains.value);
check("values across chains are summed",
  /\$120K/.test(twoChains.rationale), twoChains.rationale);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
