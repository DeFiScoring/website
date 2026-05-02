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
//   loan_reliability     0.35   Aave HF + debt utilization across chains
//   portfolio_health     0.25   Diversification (top-N concentration) + size
//   liquidity_provision  0.15   Uni V3 LP count + DEX exposure
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

// Re-implemented from worker/index.js so the legacy handleHealthScore stays
// untouched. Callers pass { from, to, perpage, sort } to the providers
// layer if they want to use the existing fetcher; we use direct provider
// helpers here for the multi-chain version.

// =============================================================================
// Pillar 1: Loan reliability — Aave V3 health factor + debt utilization.
// =============================================================================

export function pillarLoanReliability(defiByChain) {
  // Find the riskiest position (lowest HF) and the largest leverage user
  // across every chain. Wallet with no debt anywhere -> neutral 80 (good
  // signal but not "best possible" — paying down debt successfully is the
  // gold standard).
  let lowestHf = null;
  let totalCollateral = 0;
  let totalDebt = 0;
  let hasAnyPosition = false;
  for (const c of defiByChain) {
    for (const p of c.protocols || []) {
      if (p.protocol === 'aave-v3' && p.hasPosition) {
        hasAnyPosition = true;
        totalCollateral += p.collateralUsd || 0;
        totalDebt       += p.debtUsd || 0;
        if (typeof p.healthFactor === 'number') {
          if (lowestHf == null || p.healthFactor < lowestHf) lowestHf = p.healthFactor;
        }
      }
    }
  }
  if (!hasAnyPosition) {
    return { real: false, value: 50, lowestHealthFactor: null, totalCollateralUsd: 0, totalDebtUsd: 0,
             rationale: 'No Aave V3 positions found across any chain — neutral score.' };
  }
  // No debt? Wallet is supplying as a saver — that's a positive signal but
  // not as informative as a successfully managed leveraged position.
  if (totalDebt === 0) {
    return { real: true, value: 80, lowestHealthFactor: null, totalCollateralUsd: totalCollateral,
             totalDebtUsd: 0, rationale: 'Aave supplier with no outstanding debt.' };
  }
  // Map HF to score band (Aave HF semantics: <1 liquidatable, 1-1.5 risky,
  // 1.5-2 caution, >2 safe). 100 best possible, 0 worst.
  let value;
  if (lowestHf == null)      value = 50;
  else if (lowestHf < 1)     value = 0;
  else if (lowestHf < 1.25)  value = 20;
  else if (lowestHf < 1.5)   value = 40;
  else if (lowestHf < 2)     value = 65;
  else if (lowestHf < 3)     value = 85;
  else                        value = 95;
  return {
    real: true, value, lowestHealthFactor: lowestHf,
    totalCollateralUsd: totalCollateral, totalDebtUsd: totalDebt,
    utilization: totalCollateral > 0 ? totalDebt / totalCollateral : 0,
    rationale: `Lowest Aave health factor across all chains: ${lowestHf.toFixed(2)}.`,
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
  let totalLpCount = 0;
  let chainsWithLp = 0;
  for (const c of defiByChain) {
    for (const p of c.protocols || []) {
      if (p.protocol === 'uniswap-v3-lp' && (p.lpCount || 0) > 0) {
        totalLpCount += p.lpCount;
        chainsWithLp += 1;
      }
    }
  }
  if (totalLpCount === 0) {
    return { real: false, value: 50, lpCount: 0, chainsWithLp: 0,
             rationale: 'No Uniswap V3 LP positions found — neutral score.' };
  }
  // Each LP NFT is a real concentrated-liquidity position. 1 = engaged user;
  // 5+ = active LP'er; 20+ = market maker.
  let value;
  if (totalLpCount >= 20)     value = 95;
  else if (totalLpCount >= 5) value = 80;
  else if (totalLpCount >= 2) value = 65;
  else                         value = 50;
  if (chainsWithLp >= 2) value = Math.min(100, value + 5);
  return { real: true, value, lpCount: totalLpCount, chainsWithLp,
           rationale: `${totalLpCount} Uniswap V3 LP position(s) across ${chainsWithLp} chain(s).` };
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
  const score_band = score >= 720 ? 'excellent' : score >= 660 ? 'good' : score >= 580 ? 'fair' : 'poor';

  return {
    success: true,
    wallet,
    score,
    score_band,
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
