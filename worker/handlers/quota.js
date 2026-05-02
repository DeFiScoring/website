/* DeFiScoring – Quota observability
 *
 *   GET /api/quota
 *
 * Returns a flat snapshot of every quota key in the active tier alongside
 * the user's current consumption + window reset time. The dashboard
 * topbar widget polls this on load (and after any quota-consuming action)
 * to render a "AI explain: 12/20 today" bar.
 *
 * Why a dedicated endpoint instead of X-Quota-* headers on every JSON
 * response: there are ~30 handlers in worker/index.js and only a handful
 * actually consume quota. Sprinkling header logic into every handler
 * (and remembering to do it for new ones) is far more error-prone than
 * a single read endpoint that the UI calls explicitly. The dashboard
 * widget only needs a snapshot, not per-request deltas.
 */

import { requireSession } from "../lib/auth.js";
import { getSubscription, TIERS } from "../lib/tiers.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// Quota keys that map onto a tier_quotas row (rolling-window counters).
// Capacity-style limits like "wallets.linked" / "watchlist.size" are
// *current cardinality* limits, not rate-windowed — we surface those
// separately via a live SELECT COUNT.
const ROLLING_KEYS = new Set([
  "ai.explain.day",
  "simulator.runs.day",
  "bulk_api.requests.day",
]);

const CARDINALITY_KEYS = new Set([
  "wallets.linked",
  "alerts.rules",
  "alerts.channels",
  "watchlist.size",
]);

async function cardinalityFor(env, userId, key) {
  // Defensive: if the table doesn't exist (e.g. fresh dev DB), report 0
  // rather than 500-ing the whole endpoint.
  try {
    if (key === "wallets.linked") {
      const r = await env.HEALTH_DB
        .prepare("SELECT COUNT(*) AS n FROM wallet_connections WHERE user_id = ?")
        .bind(userId).first();
      return r?.n || 0;
    }
    if (key === "alerts.rules") {
      const r = await env.HEALTH_DB
        .prepare("SELECT COUNT(*) AS n FROM alert_rules WHERE user_id = ? AND deleted_at IS NULL")
        .bind(userId).first();
      return r?.n || 0;
    }
    if (key === "alerts.channels") {
      const r = await env.HEALTH_DB
        .prepare("SELECT COUNT(*) AS n FROM alert_channels WHERE user_id = ? AND deleted_at IS NULL")
        .bind(userId).first();
      return r?.n || 0;
    }
    // watchlist not yet shipped
    return 0;
  } catch {
    return 0;
  }
}

export async function handleQuota(request, env) {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;

  const sub = await getSubscription(env, auth.user.id);
  const tier = sub.tier;
  const limits = (TIERS[tier] || TIERS.free).limits;

  // Rolling-window counters (one D1 SELECT covers them all)
  const rollingRows = await env.HEALTH_DB.prepare(
    "SELECT quota_key, used, window_end FROM tier_quotas WHERE user_id = ?"
  ).bind(auth.user.id).all();
  const rollingMap = {};
  for (const r of (rollingRows.results || [])) {
    // Skip stale rows whose window has already expired — UI should see 0.
    if (r.window_end > Date.now()) rollingMap[r.quota_key] = r;
  }

  const out = {};
  for (const [key, limit] of Object.entries(limits)) {
    if (ROLLING_KEYS.has(key)) {
      const row = rollingMap[key];
      const used = row ? row.used : 0;
      out[key] = {
        kind: "rolling",
        used,
        limit,
        remaining: Math.max(0, limit - used),
        reset_at: row ? row.window_end : null,
      };
    } else if (CARDINALITY_KEYS.has(key)) {
      const used = await cardinalityFor(env, auth.user.id, key);
      out[key] = {
        kind: "cardinality",
        used,
        limit,
        remaining: Math.max(0, limit - used),
        reset_at: null,
      };
    } else {
      // Plain entitlement (e.g. history.days) — surface limit only.
      out[key] = { kind: "entitlement", limit };
    }
  }

  return json({ success: true, tier, status: sub.status, quotas: out });
}
