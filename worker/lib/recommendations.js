// worker/lib/recommendations.js
// ----------------------------------------------------------------------------
// Score-band-aware protocol recommendations.
//
// Inputs: a wallet's score band (excellent/good/fair/poor), a risk profile id
// (conservative/balanced/aggressive/degen), and the live protocol catalog.
//
// Output: ranked list of protocol picks with `score`, `category`, `rationale`,
// and `defillama` enrichment. Filters out categories the profile excludes
// (e.g. perps for conservative). Penalizes protocols the wallet is already
// over-allocated to (concentration risk).
// ----------------------------------------------------------------------------

import { getCatalog, RISK_PROFILES } from './protocols.js';

// Map catalog categories to risk_profiles.yml weight buckets.
const CATEGORY_TO_BUCKET = {
  lending:        'lending_bluechip',
  liquid_staking: 'lending_bluechip',
  stablecoin:     'lending_bluechip',
  dex:            'eth_btc_lp',
  yield:          'stables_lp',
  derivatives:    'perps',
};

// Score-band → risk-tolerance multiplier. A "poor" wallet should see safer
// recs (lending heavy); an "excellent" wallet can be shown the full menu.
const BAND_RISK_TOLERANCE = {
  excellent: { lending: 1.0, dex: 1.0, yield: 1.0, derivatives: 1.0, liquid_staking: 1.0, stablecoin: 1.0 },
  good:      { lending: 1.0, dex: 1.0, yield: 0.9, derivatives: 0.8, liquid_staking: 1.0, stablecoin: 1.0 },
  fair:      { lending: 1.1, dex: 0.8, yield: 0.7, derivatives: 0.4, liquid_staking: 1.1, stablecoin: 1.2 },
  poor:      { lending: 1.3, dex: 0.5, yield: 0.4, derivatives: 0.0, liquid_staking: 1.3, stablecoin: 1.5 },
};

export async function getRecommendations(env, {
  scoreBand   = 'good',
  profileId   = 'balanced',
  walletExposure = {},  // { <slug>: <pct> } — current allocation share, optional
  limit       = 10,
} = {}) {
  const profile = RISK_PROFILES[profileId];
  if (!profile) return { error: `unknown profile: ${profileId}`, recommendations: [] };

  const catalog = await getCatalog(env, { enrich: true });
  const tolerance = BAND_RISK_TOLERANCE[scoreBand] || BAND_RISK_TOLERANCE.good;

  const ranked = [];
  for (const p of catalog) {
    // Filter by profile category allowlist / excludelist.
    if (profile.excludedCategories.includes(p.category)) continue;
    if (profile.allowedCategories.length && !profile.allowedCategories.includes(p.category)) continue;

    // Base score from DeFiLlama TVL (log-scaled so a $1B protocol doesn't
    // 1000x outscore a $1M one). Defaults to 30 if no DeFiLlama data.
    const tvl = p.defillama?.tvlUsd || 0;
    const tvlScore = tvl > 0 ? Math.min(100, 30 + Math.log10(tvl) * 8) : 30;

    // Audits boost.
    const auditBoost = (p.defillama?.audits || 0) * 5;

    // Profile weight for this bucket — recs for buckets the profile cares
    // about rank higher.
    const bucket = CATEGORY_TO_BUCKET[p.category] || 'long_tail';
    const profileWeight = (profile.weights[bucket] || 0) * 100;

    // Score-band tolerance.
    const bandMul = tolerance[p.category] ?? 1.0;

    // Concentration penalty. If the wallet already holds >max_single_protocol_pct
    // in this slug, penalize.
    const currentPct = walletExposure[p.slug] || 0;
    const maxPct = profile.target.max_single_protocol_pct || 100;
    const concentrationPenalty = currentPct > maxPct ? 30 : 0;

    const finalScore = (tvlScore + auditBoost + profileWeight) * bandMul - concentrationPenalty;

    ranked.push({
      slug: p.slug,
      name: p.name,
      category: p.category,
      score: Math.round(finalScore),
      tvlUsd: tvl,
      audits: p.defillama?.audits || 0,
      url: p.defillama?.url || null,
      logo: p.defillama?.logo || null,
      rationale: buildRationale(p, scoreBand, profile, tvl, currentPct > maxPct),
      currentExposurePct: currentPct,
    });
  }

  ranked.sort((a, b) => b.score - a.score);
  return {
    success: true,
    scoreBand,
    profile: profile.id,
    profileName: profile.name,
    recommendations: ranked.slice(0, limit),
    totalConsidered: ranked.length,
    catalogSize: catalog.length,
    timestamp: new Date().toISOString(),
  };
}

function buildRationale(protocol, band, profile, tvl, overConcentrated) {
  const parts = [];
  if (tvl > 1e9)      parts.push(`$${(tvl/1e9).toFixed(1)}B TVL`);
  else if (tvl > 1e6) parts.push(`$${(tvl/1e6).toFixed(0)}M TVL`);
  if (protocol.category === 'lending')        parts.push('blue-chip lending');
  else if (protocol.category === 'liquid_staking') parts.push('staking yield');
  else if (protocol.category === 'derivatives') parts.push('perps exposure');
  else if (protocol.category === 'dex')        parts.push('LP opportunity');
  else if (protocol.category === 'yield')      parts.push('yield strategy');
  if (band === 'poor' || band === 'fair') parts.push('lower-risk option');
  if (overConcentrated) parts.push(`already over-allocated (${profile.target.max_single_protocol_pct}% cap)`);
  return `${protocol.name}: ${parts.join(', ')}.`;
}
