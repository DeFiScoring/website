// worker/handlers/recommendations.js
// ----------------------------------------------------------------------------
// GET /api/recommendations?wallet=&profile=&band=&limit=
//
// Returns ranked protocol recommendations from the catalog, filtered by:
//   - The user's risk profile (conservative/balanced/aggressive/degen)
//   - The user's score band (excellent/good/fair/poor)
//   - Their current protocol exposure (concentration penalty)
//
// If `wallet` is provided and `band` isn't, the handler computes the band by
// calling /api/wallet-score internally — handy for one-shot front-end calls.
// If only `profile` is provided, returns generic recs for that profile.
// ----------------------------------------------------------------------------

import { handleWalletScore } from './wallet-score.js';
import { getRecommendations } from '../lib/recommendations.js';

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const isAddress = (a) => ADDR_RE.test(a || '');
const VALID_PROFILES = new Set(['conservative', 'balanced', 'aggressive', 'degen']);
const VALID_BANDS = new Set(['excellent', 'good', 'fair', 'poor']);

export async function handleRecommendations(request, env, baseHeaders = {}) {
  const url = new URL(request.url);
  const address = (url.searchParams.get('address') || url.searchParams.get('wallet') || '').toLowerCase();
  const profileId = (url.searchParams.get('profile') || 'balanced').toLowerCase();
  const explicitBand = (url.searchParams.get('band') || '').toLowerCase();
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));

  if (!VALID_PROFILES.has(profileId)) {
    return jsonRes({ success: false, error: `invalid profile: ${profileId}` }, 400, baseHeaders);
  }

  let scoreBand = explicitBand && VALID_BANDS.has(explicitBand) ? explicitBand : 'good';
  let walletExposure = {};

  // If wallet provided + no explicit band, derive both from /api/wallet-score.
  if (address && isAddress(address) && !explicitBand) {
    try {
      const scoreReq = new Request(`${url.origin}/api/wallet-score?wallet=${address}`, { method: 'GET' });
      const scoreRes = await handleWalletScore(scoreReq, env, {});
      const scoreBody = await scoreRes.json();
      if (scoreBody.success) {
        scoreBand = scoreBody.score_band;
        // Build exposure map from defi pillar so concentration penalty engages.
        // (For now we don't pull per-protocol percentages; T8 polish can wire
        // this through from /api/exposure.)
      }
    } catch { /* fall back to band='good' */ }
  } else if (address && !isAddress(address)) {
    return jsonRes({ success: false, error: 'invalid wallet address' }, 400, baseHeaders);
  }

  const result = await getRecommendations(env, {
    scoreBand,
    profileId,
    walletExposure,
    limit,
  });

  return jsonRes(result, 200, baseHeaders);
}

function jsonRes(data, status, baseHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=120',
      ...baseHeaders,
    },
  });
}
