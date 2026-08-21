// worker/lib/score.js
// ----------------------------------------------------------------------------
// Multi-chain wallet credit score (300–850, FICO-style).
//
// Composes the outputs of T3 (portfolio) + T4 (defi, nfts) into 5 named
// pillars, each tagged `real: true/false` so the dashboard can be honest
// about coverage. A pillar with `real: false` falls back to a neutral 50,
// never a fabricated number.
//
// This is the multi-chain successor to the Eth-only `handleHealthScore` in
// worker/index.js. The legacy endpoint is kept untouched for backward compat
// (front-end's dashboard.js + health-score.js still call it); /api/wallet-score
// is the new path the SPA (T7) will move to.
//
// Pillars (weights sum to 1.0):
//   loan_reliability     0.35   Aave HF + Compound-derived HF, across chains
//   portfolio_health     0.25   Diversification (top-N concentration) + size
//   liquidity_provision  0.15   Uni V3 live LP positions (liquidity > 0)
//   governance           0.10   Snapshot vote count
//   account_age          0.15   First-tx age on Ethereum
//
// Bonuses/penalties:
//   +50  if any chain has Aave HF > 2.0 (proven safe lender)
//   +30  if portfolio is on >=3 chains (multichain user)
//   -150 if any Aave HF < 1.0 (active liquidation risk)
//   -50  if single-protocol concentration > 80%
// ----------------------------------------------------------------------------

import { CHAINS } from './chains.js';
import { getAllDeFiPositions } from './defi.js';
import { ethCall, abiEncodeSingleAddr, abiHexWord } from './providers.js';

// =============================================================================
// Score bands — the single source of truth for the 300–850 → label mapping.
//
// This used to be redeclared inline wherever a band was needed, and the
// copies drifted: worker/handlers/badge.js and the legacy handleHealthScore
// in worker/index.js matched this file (720/660/580), but the *dashboard* —
// assets/js/dashboard.js's bandFor() and assets/js/defi-onchain.js's
// preliminaryScore() — used 750/670/580, and the landing page's static gauge
// legend and its animating JS each stated a third and fourth set (740/670
// and 670/580 with a "Great" label instead of "Excellent"). The same wallet
// could show "Good" on its badge and "Excellent" on its dashboard depending
// on which of these four copies answered.
//
// Fix: this array is the only place a threshold is allowed to be a literal.
// Every other surface — worker/handlers/badge.js, assets/js/dashboard.js,
// assets/js/defi-onchain.js, assets/js/landing.js, index.html's gauge legend
// — either imports BANDS (server-side) or mirrors it verbatim with a comment
// pointing back here (browser-side, where there's no bundler to import
// across). If you change a threshold, this is the only edit that matters;
// everywhere else is a copy that must be kept byte-identical to it.
//
// Ordered highest floor first so bandForScore can return on first match.
// The scoring model's version. Bump this whenever a change would move an
// existing wallet's score without its on-chain position changing — new or
// reweighted pillars, changed banding, new adjustments, a new data source
// feeding an existing pillar. Do NOT bump it for bug fixes that only affect
// which wallets can be scored at all, or for refactors.
//
// It is stamped into every score payload and persisted alongside every
// health_scores row, so a trend line spanning a model change can say so
// instead of presenting the discontinuity as if the wallet had moved.
// Format is YYYY.MM of the release that introduced the model.
export const SCORE_MODEL_VERSION = '2026.08';

export const BANDS = [
  { key: 'excellent', label: 'Excellent', floor: 720 },
  { key: 'good',      label: 'Good',      floor: 660 },
  { key: 'fair',      label: 'Fair',      floor: 580 },
  { key: 'poor',      label: 'Poor',      floor: 300 },
];

// Weight of each pillar in the composite, and the single source for both the
// coverage calculation and the weights published in the payload.
export const PILLAR_WEIGHTS = {
  loan_reliability:    0.35,
  portfolio_health:    0.25,
  liquidity_provision: 0.15,
  governance:          0.10,
  account_age:         0.15,
};

/**
 * How much of a score rests on data we actually observed: the summed weight
 * of the pillars backed by real data. 1.0 means every pillar was answered;
 * 0.5 means half the score is a neutral placeholder.
 *
 * The rounding is not cosmetic. Of the 32 possible real/estimated
 * combinations exactly one drifts in binary floating point —
 * loan_reliability + governance sums to 0.44999999999999996 — and without
 * the guard that wallet's dashboard would read "45.000000000000004% live
 * data" after the percentage conversion.
 */
export function coverageOf(pillars) {
  let sum = 0;
  for (const [key, weight] of Object.entries(PILLAR_WEIGHTS)) {
    if (pillars && pillars[key] && pillars[key].real) sum += weight;
  }
  return Number(sum.toFixed(4));
}

export function bandForScore(score) {
  for (const b of BANDS) {
    if (score >= b.floor) return b.key;
  }
  return BANDS[BANDS.length - 1].key;
}

// Re-implemented from worker/index.js so the legacy handleHealthScore stays
// untouched. Callers pass { from, to, perpage, sort } to the providers
// layer if they want to use the existing fetcher; we use direct provider
// helpers here for the multi-chain version.

// =============================================================================
// Pillar 1: Loan reliability — Aave V3 health factor + debt utilization.
// =============================================================================

export function pillarLoanReliability(defiByChain) {
  // Score the riskiest lending position the wallet holds anywhere, across
  // both supported lenders. A wallet that is comfortable on four chains and
  // about to be liquidated on a fifth is a liquidation risk.
  //
  // Aave reports a health factor directly. Compound V3 has no healthFactor()
  // view, but lib/defi.js derives one on the same definition (risk-adjusted
  // collateral / debt) from Comet's per-asset balances, price feeds, and
  // liquidation collateral factors — so both protocols land on one scale and
  // share the bands below.
  let lowestHf = null;
  let lowestHfProtocol = null;
  let totalCollateral = 0;
  let totalDebt = 0;
  let hasAnyPosition = false;
  // Debt we can see but cannot assess: a Comet borrow whose collateral read
  // failed. Scoring it as if it were safe would be a guess in the wallet's
  // favour; scoring it as liquidatable would be a guess against it.
  let unassessableDebt = 0;
  const seen = new Set();

  const noteHf = (hf, label) => {
    if (typeof hf !== 'number' || !Number.isFinite(hf)) return;
    if (lowestHf == null || hf < lowestHf) { lowestHf = hf; lowestHfProtocol = label; }
  };

  for (const c of defiByChain) {
    for (const p of c.protocols || []) {
      if (p.protocol === 'aave-v3' && p.hasPosition) {
        hasAnyPosition = true;
        seen.add('Aave V3');
        totalCollateral += p.collateralUsd || 0;
        totalDebt       += p.debtUsd || 0;
        noteHf(p.healthFactor, 'Aave V3');
      } else if (p.protocol === 'compound-v3' && p.hasPosition) {
        hasAnyPosition = true;
        seen.add('Compound V3');
        // Comet's base-asset supply is a lending position, not collateral for
        // it — collateral is a separate slot, read only when there is a borrow.
        totalCollateral += (p.supplyUsd || 0) + (p.collateralUsd || 0);
        totalDebt       += p.borrowUsd || 0;
        if ((p.borrowUsd || 0) > 0) {
          if (typeof p.healthFactor === 'number' && Number.isFinite(p.healthFactor)) {
            noteHf(p.healthFactor, 'Compound V3');
          } else {
            unassessableDebt += p.borrowUsd || 0;
          }
        }
      }
    }
  }

  const protocols = [...seen];
  const named = protocols.length ? protocols.join(' + ') : 'Aave V3 or Compound V3';

  if (!hasAnyPosition) {
    return { real: false, value: 50, lowestHealthFactor: null, totalCollateralUsd: 0, totalDebtUsd: 0,
             protocols: [],
             rationale: 'No Aave V3 or Compound V3 positions found across any chain — neutral score.' };
  }
  // No debt? Wallet is supplying as a saver — that's a positive signal but
  // not as informative as a successfully managed leveraged position.
  if (totalDebt === 0) {
    return { real: true, value: 80, lowestHealthFactor: null, totalCollateralUsd: totalCollateral,
             totalDebtUsd: 0, protocols,
             rationale: `${named} supplier with no outstanding debt.` };
  }

  const utilization = totalCollateral > 0 ? totalDebt / totalCollateral : null;

  // Borrowing, but every borrow's backing was unreadable — we know there is
  // debt and nothing about how well it is covered. Neutral, and say so.
  if (lowestHf == null) {
    return {
      real: true, value: 50, lowestHealthFactor: null,
      totalCollateralUsd: totalCollateral, totalDebtUsd: totalDebt,
      utilization, unassessableDebtUsd: unassessableDebt, protocols,
      rationale: `${named} borrower, but the collateral backing the debt could not be read — neutral score.`,
    };
  }

  // Map health factor to score band (Aave HF semantics: <1 liquidatable,
  // 1-1.5 risky, 1.5-2 caution, >2 safe). 100 best possible, 0 worst.
  let value;
  if (lowestHf < 1)          value = 0;
  else if (lowestHf < 1.25)  value = 20;
  else if (lowestHf < 1.5)   value = 40;
  else if (lowestHf < 2)     value = 65;
  else if (lowestHf < 3)     value = 85;
  else                        value = 95;

  let rationale = `Lowest health factor across ${named}: ${lowestHf.toFixed(2)}`;
  rationale += lowestHfProtocol ? ` (${lowestHfProtocol}).` : '.';
  if (unassessableDebt > 0) {
    rationale += ` $${Math.round(unassessableDebt).toLocaleString()} of Compound debt had unreadable collateral and is excluded from the health factor.`;
  }

  return {
    real: true, value, lowestHealthFactor: lowestHf, lowestHealthFactorProtocol: lowestHfProtocol,
    totalCollateralUsd: totalCollateral, totalDebtUsd: totalDebt,
    utilization: utilization != null ? utilization : 0,
    unassessableDebtUsd: unassessableDebt,
    protocols,
    rationale,
  };
}

// =============================================================================
// Pillar 2: Portfolio health — diversification + size.
// =============================================================================

export function pillarPortfolioHealth(portfolio) {
  if (!portfolio || !portfolio.success || (portfolio.portfolioFiat || 0) === 0) {
    return { real: false, value: 50, totalUsd: 0, activeChains: 0,
             rationale: 'No portfolio value detected — neutral score.' };
  }
  const total = portfolio.portfolioFiat;
  const activeChains = portfolio.activeChains || 0;
  // Concentration = largest single-position share of portfolio. A wallet
  // with everything in one token is more fragile than one spread across 10.
  let positions = [];
  for (const c of (portfolio.chains || [])) {
    for (const t of (c.tokens || [])) {
      if (t.valueFiat > 0) positions.push(t.valueFiat);
    }
  }
  positions.sort((a, b) => b - a);
  const topShare = positions.length ? positions[0] / total : 1;
  const top3Share = positions.slice(0, 3).reduce((s, v) => s + v, 0) / total;

  // Diversification score: lower top-position share = better.
  let diversityScore;
  if (topShare > 0.95)      diversityScore = 20;
  else if (topShare > 0.80) diversityScore = 45;
  else if (topShare > 0.60) diversityScore = 65;
  else if (topShare > 0.40) diversityScore = 80;
  else                       diversityScore = 95;

  // Size score: portfolio depth signals real engagement (not a burner).
  // Caps at $10k+ since the goal is to detect "real user", not whales.
  let sizeScore;
  if (total < 50)       sizeScore = 10;
  else if (total < 250) sizeScore = 35;
  else if (total < 1000) sizeScore = 60;
  else if (total < 10000) sizeScore = 80;
  else                    sizeScore = 95;

  // Multichain bonus: a wallet active on 3+ chains has demonstrated more
  // sophisticated DeFi usage than a single-chain wallet of the same value.
  const chainBonus = activeChains >= 3 ? 10 : activeChains >= 2 ? 5 : 0;

  const value = Math.min(100, Math.round(diversityScore * 0.5 + sizeScore * 0.5 + chainBonus));
  return {
    real: true, value, totalUsd: total, activeChains,
    topPositionShare: Number(topShare.toFixed(3)), top3Share: Number(top3Share.toFixed(3)),
    rationale: `$${Math.round(total).toLocaleString()} across ${activeChains} chain(s); top position ${Math.round(topShare*100)}% of portfolio.`,
  };
}

// =============================================================================
// Pillar 3: Liquidity provision — Uni V3 LP NFT count summed across chains.
// =============================================================================

export function pillarLiquidityProvision(defiByChain) {
  // lpCount is the number of position NFTs the wallet holds, which over-counts
  // real LP activity: Uniswap V3 does not burn the token when a position is
  // fully withdrawn, so a wallet that closed ten positions still holds ten
  // NFTs. activeLpCount (liquidity > 0) is the honest number and is preferred
  // wherever the reader could resolve it.
  let totalLpCount = 0;
  let chainsWithLp = 0;
  let verified = false;      // at least one chain resolved live positions
  let unverified = false;    // at least one chain could only give a raw count
  let truncated = false;
  let heldNfts = 0;

  for (const c of defiByChain) {
    for (const p of c.protocols || []) {
      if (p.protocol !== 'uniswap-v3-lp') continue;
      const resolved = p.activeLpCount != null;
      if (resolved) verified = true;
      const n = resolved ? p.activeLpCount : (p.lpCount || 0);
      if ((p.lpCount || 0) > 0) heldNfts += p.lpCount;
      if (!resolved && (p.lpCount || 0) > 0) unverified = true;
      if (p.lpCountTruncated) truncated = true;
      if (n > 0) {
        totalLpCount += n;
        chainsWithLp += 1;
      }
    }
  }

  if (totalLpCount === 0) {
    // Distinguish "holds NFTs but every one is closed" from "never provided
    // liquidity" — the first is an observation about a former LP.
    const rationale = verified && heldNfts > 0
      ? `${heldNfts} Uniswap V3 position NFT(s) held, but none currently hold liquidity — neutral score.`
      : 'No Uniswap V3 LP positions found — neutral score.';
    return { real: false, value: 50, lpCount: 0, activeLpCount: verified ? 0 : null,
             heldNftCount: heldNfts, chainsWithLp: 0, rationale };
  }

  // Each live position is real deployed capital. 1 = engaged user;
  // 5+ = active LP'er; 20+ = market maker.
  let value;
  if (totalLpCount >= 20)     value = 95;
  else if (totalLpCount >= 5) value = 80;
  else if (totalLpCount >= 2) value = 65;
  else                         value = 50;
  if (chainsWithLp >= 2) value = Math.min(100, value + 5);

  const noun = verified && !unverified ? 'live Uniswap V3 position' : 'Uniswap V3 LP position';
  let rationale = `${totalLpCount} ${noun}(s) across ${chainsWithLp} chain(s).`;
  if (verified && heldNfts > totalLpCount) {
    rationale += ` ${heldNfts - totalLpCount} further position NFT(s) hold no liquidity and were not counted.`;
  }
  if (unverified) {
    // Say so rather than implying the count is live positions.
    rationale += ' Counts on some chains are position NFTs held, which may include closed positions (no Alchemy key).';
  }
  if (truncated) {
    rationale += ` Only the first ${20} positions per chain are checked, so this is a floor.`;
  }

  return { real: true, value, lpCount: totalLpCount,
           activeLpCount: verified ? totalLpCount : null,
           heldNftCount: heldNfts, chainsWithLp, verified, truncated, rationale };
}

// =============================================================================
// Pillar 4: Governance — Snapshot vote count.
// =============================================================================

export async function pillarGovernance(env, wallet) {
  const url = env.SNAPSHOT_API_URL || 'https://hub.snapshot.org/graphql';
  const query = `query($voter: String!) { votes(first: 1000, where: { voter: $voter }) { id space { id } } }`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { voter: wallet } }),
    });
    if (!res.ok) return { real: false, value: 50, rationale: 'Snapshot API unavailable — neutral score.' };
    const j = await res.json();
    const votes = j?.data?.votes || [];
    const voteCount = votes.length;
    const uniqueDaos = new Set(votes.map((v) => v.space?.id).filter(Boolean)).size;
    let value;
    if (voteCount === 0)        value = 30;
    else if (voteCount < 5)     value = 55;
    else if (voteCount < 25)    value = 75;
    else if (voteCount < 100)   value = 90;
    else                         value = 100;
    return { real: true, value, voteCount, uniqueDaos,
             rationale: `${voteCount} Snapshot votes across ${uniqueDaos} DAOs.` };
  } catch (e) {
    return { real: false, value: 50, error: String(e.message || e),
             rationale: 'Snapshot fetch failed — neutral score.' };
  }
}

// =============================================================================
// Pillar 5: Account age — Ethereum first-tx age in days.
// Reuses the providers.js helper so we don't duplicate the multi-tier logic.
// =============================================================================

export async function pillarAccountAge(env, wallet) {
  // Direct Etherscan v2 lookup for Ethereum first tx (most users have ETH
  // mainnet history; L2-only wallets are still rare). One HTTP call.
  if (!env.ETHERSCAN_API_KEY) {
    return { real: false, value: 50, rationale: 'No Etherscan key — neutral score.' };
  }
  const url = `https://api.etherscan.io/v2/api?chainid=1&module=account&action=txlist&address=${wallet}&startblock=0&endblock=99999999&page=1&offset=1&sort=asc&apikey=${env.ETHERSCAN_API_KEY}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return { real: false, value: 50, rationale: `Etherscan http ${r.status} — neutral score.` };
    const j = await r.json();
    const tx = (j.result || [])[0];
    if (!tx || !tx.timeStamp) {
      return { real: true, value: 20, ageDays: 0, firstTxAt: null,
               rationale: 'No Ethereum transaction history found.' };
    }
    const firstMs = Number(tx.timeStamp) * 1000;
    const ageDays = Math.floor((Date.now() - firstMs) / 86400000);
    let value;
    if (ageDays < 30)       value = 25;
    else if (ageDays < 180) value = 50;
    else if (ageDays < 365) value = 70;
    else if (ageDays < 1095) value = 85;
    else                     value = 100;
    return { real: true, value, ageDays, firstTxAt: new Date(firstMs).toISOString(),
             rationale: `${ageDays} days since first Ethereum transaction.` };
  } catch (e) {
    return { real: false, value: 50, error: String(e.message || e),
             rationale: 'First-tx fetch failed — neutral score.' };
  }
}

// =============================================================================
// Main entry: compute everything in parallel, fold into one score payload.
// =============================================================================

export async function computeWalletScore(env, wallet, { portfolio, defiByChain } = {}) {
  // Pillars 1, 2, 3 work off T3/T4 outputs that the caller passed in.
  // Pillars 4, 5 fan out their own HTTP calls (Snapshot + Etherscan).
  const [Lr, Ph, Lp, Gv, Ag] = await Promise.all([
    Promise.resolve(pillarLoanReliability(defiByChain || [])),
    Promise.resolve(pillarPortfolioHealth(portfolio || {})),
    Promise.resolve(pillarLiquidityProvision(defiByChain || [])),
    pillarGovernance(env, wallet),
    pillarAccountAge(env, wallet),
  ]);

  // ---- Honest-score gate -----------------------------------------------
  //
  // Two situations must NOT produce a 300-850 number, because any number we
  // emit for them is fabricated:
  //
  //   1. `no_onchain_history` — the wallet has no footprint at all: zero
  //      portfolio value, zero DeFi positions, zero governance votes, zero
  //      Ethereum transactions. A fresh address used to come out around
  //      the low 500s here (every empty pillar defaults to a neutral 50),
  //      and the client-side fallback famously minted "322 · Poor" from
  //      nothing but a `hasBalance ? 70 : 20` floor. Credit bureaus solved
  //      this decades ago: a thin file is "unscorable", not "poor".
  //
  //   2. `data_unavailable` — every data source failed (RPC outage, rate
  //      limits, missing keys). Scoring on zero real signals would grade
  //      our infrastructure, not the wallet.
  //
  // Callers get `scored:false` + a machine-readable reason and the pillar
  // detail so the UI can explain exactly what was checked.
  const anyRealSignal = [Lr, Ph, Lp, Gv, Ag].some((p) => p.real);
  const hasFootprint =
    (Ph.real && (Ph.totalUsd || 0) > 0) ||
    // Tokens found but none priced (every price tier down) is still a real
    // footprint — don't let a pricing outage demote a wallet to "unscored".
    ((portfolio?.totalTokens || 0) > 0) ||
    Lr.real || Lp.real ||
    (Gv.real && (Gv.voteCount || 0) > 0) ||
    // firstTxAt (not ageDays) is the history signal: a wallet whose first
    // transaction was today has ageDays === 0 but very much has a footprint.
    (Ag.real && (Ag.firstTxAt != null || (Ag.ageDays || 0) > 0));

  if (!anyRealSignal || !hasFootprint) {
    const reason = anyRealSignal ? "no_onchain_history" : "data_unavailable";
    return {
      success: true,
      wallet,
      scored: false,
      score: null,
      score_band: "unscored",
      model: SCORE_MODEL_VERSION,
      reason,
      explanation: reason === "no_onchain_history"
        ? "This wallet has no on-chain footprint yet — no transactions, balances, " +
          "DeFi positions, or governance votes were found on any scanned chain. " +
          "A score would be meaningless; use the wallet and re-scan."
        : "None of our data sources responded for this wallet, so no score can " +
          "be computed right now. Try again shortly.",
      pillars: {
        loan_reliability:    { weight: 0.35, ...Lr },
        portfolio_health:    { weight: 0.25, ...Ph },
        liquidity_provision: { weight: 0.15, ...Lp },
        governance:          { weight: 0.10, ...Gv },
        account_age:         { weight: 0.15, ...Ag },
      },
      adjustments: [],
      timestamp: new Date().toISOString(),
    };
  }

  // Weighted composite. Weights chosen to match the original 4-pillar
  // model (Lr 0.4, LPv 0.3, Gv 0.2, Ag 0.1) but rebalanced to make room
  // for the new portfolio_health pillar at 0.25.
  const Hs = (0.35 * Lr.value)
           + (0.25 * Ph.value)
           + (0.15 * Lp.value)
           + (0.10 * Gv.value)
           + (0.15 * Ag.value);

  let baseScore = Math.round(300 + (Hs / 100) * 550);

  // Bonuses & penalties.
  const adjustments = [];
  if (Lr.lowestHealthFactor != null && Lr.lowestHealthFactor > 2.0) {
    baseScore += 50;
    adjustments.push({ name: 'aave_safe_lender', delta: +50, reason: `HF > 2.0 (${Lr.lowestHealthFactor.toFixed(2)})` });
  }
  if (Ph.activeChains >= 3) {
    baseScore += 30;
    adjustments.push({ name: 'multichain_user', delta: +30, reason: `Active on ${Ph.activeChains} chains` });
  }
  if (Lr.lowestHealthFactor != null && Lr.lowestHealthFactor < 1.0) {
    baseScore -= 150;
    adjustments.push({ name: 'liquidation_risk', delta: -150, reason: `HF < 1.0 (${Lr.lowestHealthFactor.toFixed(2)})` });
  }
  if (Ph.topPositionShare != null && Ph.topPositionShare > 0.80) {
    baseScore -= 50;
    adjustments.push({ name: 'over_concentrated', delta: -50, reason: `${Math.round(Ph.topPositionShare*100)}% in single position` });
  }

  // Clamp to FICO range.
  const score = Math.max(300, Math.min(850, baseScore));
  const score_band = bandForScore(score);

  // Each pillar that fell back to a neutral 50 (`real: false`) contributes
  // its weight to the shortfall rather than to coverage.
  const coverage = coverageOf({
    loan_reliability: Lr, portfolio_health: Ph,
    liquidity_provision: Lp, governance: Gv, account_age: Ag,
  });

  return {
    success: true,
    wallet,
    scored: true,
    score,
    score_band,
    model: SCORE_MODEL_VERSION,
    coverage,
    raw_h_s: Number(Hs.toFixed(2)),
    pillars: {
      loan_reliability:    { weight: 0.35, ...Lr },
      portfolio_health:    { weight: 0.25, ...Ph },
      liquidity_provision: { weight: 0.15, ...Lp },
      governance:          { weight: 0.10, ...Gv },
      account_age:         { weight: 0.15, ...Ag },
    },
    adjustments,
    methodology:
      'Hs = 0.35*Lr + 0.25*Ph + 0.15*Lp + 0.10*Gv + 0.15*Ag, mapped to 300..850. ' +
      'Bonuses: +50 HF>2, +30 multichain. Penalties: -150 HF<1, -50 concentration>80%.',
    timestamp: new Date().toISOString(),
  };
}
