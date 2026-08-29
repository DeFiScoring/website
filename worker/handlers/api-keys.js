/* DeFiScoring – API key management
 *
 *   GET    /api/keys        – list this user's keys (never the secrets)
 *   POST   /api/keys        – issue a key; the raw value is returned ONCE
 *   DELETE /api/keys/{id}   – revoke
 *
 * Issuing is gated on the tier actually including API access, so a free-tier
 * user gets a 402 pointing at /pricing/ rather than a key that 402s on first
 * use — failing at the point of the decision is kinder than failing later in
 * someone's integration.
 */

import { requireSession } from "../lib/auth.js";
import { getSubscription, tierLimit } from "../lib/tiers.js";
import { createApiKey, QUOTA_KEY, utcDay } from "../lib/api-keys.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// How many keys one account may hold at once. Not a revenue lever — a blast
// radius limit, so a compromised dashboard session cannot mint keys forever.
const MAX_ACTIVE_KEYS = 10;

export async function handleApiKeysList(request, env) {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;

  const sub = await getSubscription(env, auth.user.id);
  const limit = tierLimit(sub.tier, QUOTA_KEY) || 0;
  const today = utcDay();

  const { results } = await env.HEALTH_DB.prepare(
    `SELECT k.id, k.name, k.prefix, k.created_at, k.last_used_at, k.revoked_at,
            COALESCE(u.requests, 0) AS requests_today
       FROM api_keys k
       LEFT JOIN api_key_usage u ON u.key_id = k.id AND u.day = ?
      WHERE k.user_id = ?
      ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC`
  ).bind(today, auth.user.id).all();

  // The account-wide budget the keys draw on, so the panel can show
  // "412 / 1000 today" without a second call.
  const q = await env.HEALTH_DB.prepare(
    "SELECT used, window_end FROM tier_quotas WHERE user_id = ? AND quota_key = ?"
  ).bind(auth.user.id, QUOTA_KEY).first();
  const windowLive = q && q.window_end > Date.now();

  return json({
    success: true,
    tier: sub.tier,
    api_access: limit > 0,
    quota: {
      key: QUOTA_KEY,
      limit,
      used: windowLive ? q.used : 0,
      resets_at: windowLive ? q.window_end : null,
    },
    max_active_keys: MAX_ACTIVE_KEYS,
    keys: (results || []).map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      created_at: r.created_at,
      last_used_at: r.last_used_at,
      revoked: !!r.revoked_at,
      revoked_at: r.revoked_at,
      requests_today: r.requests_today,
    })),
  });
}

export async function handleApiKeysCreate(request, env) {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;

  let body = {};
  try { body = await request.json(); } catch { /* name is optional */ }
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 60) : null;

  const sub = await getSubscription(env, auth.user.id);
  const limit = tierLimit(sub.tier, QUOTA_KEY) || 0;
  if (limit <= 0) {
    return json({
      success: false, error: "api_access_not_in_plan",
      current_tier: sub.tier, upgrade_url: "/pricing/",
      message: "Programmatic API access is available on Plus and Enterprise plans.",
    }, 402);
  }

  const { n } = await env.HEALTH_DB.prepare(
    "SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL"
  ).bind(auth.user.id).first();
  if (n >= MAX_ACTIVE_KEYS) {
    return json({
      success: false, error: "too_many_keys",
      current: n, limit: MAX_ACTIVE_KEYS,
      message: "Revoke an unused key before issuing another.",
    }, 409);
  }

  const key = await createApiKey(env, auth.user.id, name);
  return json({
    success: true,
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    created_at: key.created_at,
    // The only time this value ever leaves the worker.
    api_key: key.raw,
    warning: "Copy this key now — it is hashed on save and cannot be shown again.",
  }, 201);
}

export async function handleApiKeysRevoke(request, env, id) {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;

  // Scoped to the caller, and already-revoked keys are not re-revoked, so the
  // audit trail keeps the first revocation time.
  const res = await env.HEALTH_DB.prepare(
    "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL"
  ).bind(Date.now(), id, auth.user.id).run();

  if (!res?.meta?.changes) return json({ success: false, error: "not_found" }, 404);
  return json({ success: true, id, revoked: true });
}
