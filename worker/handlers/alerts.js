/* DeFiScoring – Alert rule + channel CRUD
 *
 *   GET    /api/alerts/rules               → list current user's rules
 *   POST   /api/alerts/rules               → create a rule (Pro+)
 *   PUT    /api/alerts/rules/{id}          → update rule
 *   DELETE /api/alerts/rules/{id}          → delete rule
 *
 *   GET    /api/alerts/channels            → list delivery channels
 *   POST   /api/alerts/channels            → add an email or telegram channel
 *   POST   /api/alerts/channels/{id}/verify → mark verified (token check)
 *   DELETE /api/alerts/channels/{id}       → remove a channel
 *
 *   GET    /api/alerts/deliveries          → recent delivery audit log
 */

import { requireSession, newId } from "../lib/auth.js";
import { requireTier, tierLimit } from "../lib/tiers.js";

const VALID_KINDS = new Set([
  "health_factor", "price", "score_change",
  "approval_change", "liquidation_risk", "protocol_event",
]);
const VALID_CHANNELS = new Set(["email", "telegram"]); // webhook reserved for Plus+ later

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json" },
  });
}

/* ============================================================
 * Rules
 * ============================================================ */

export async function handleAlertRulesList(request, env) {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;

  const { results } = await env.HEALTH_DB.prepare(
    `SELECT id, wallet_address, kind, params_json, channels_json, is_active,
            cooldown_secs, last_fired_at, last_value, created_at, updated_at
     FROM alert_rules WHERE user_id = ? ORDER BY created_at DESC LIMIT 200`
  ).bind(auth.user.id).all();
  return json({
    success: true,
    rules: (results || []).map(deserializeRule),
  });
}

export async function handleAlertRuleCreate(request, env) {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;

  const sub = await requireTier(auth.user.id, "pro", env);
  if (sub instanceof Response) return sub;

  let body; try { body = await request.json(); } catch { return json({ success: false, error: "invalid_json" }, 400); }
  const { wallet_address, kind, params, channels, cooldown_secs, is_active } = body || {};

  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet_address || "")) {
    return json({ success: false, error: "invalid_wallet_address" }, 400);
  }
  if (!VALID_KINDS.has(kind)) return json({ success: false, error: "invalid_kind" }, 400);
  if (!Array.isArray(channels) || !channels.length || !channels.every((c) => VALID_CHANNELS.has(c))) {
    return json({ success: false, error: "invalid_channels" }, 400);
  }

  // Wallet must be linked to this user
  const owns = await env.HEALTH_DB.prepare(
    "SELECT 1 FROM wallet_connections WHERE user_id = ? AND wallet_address = ?"
  ).bind(auth.user.id, wallet_address.toLowerCase()).first();
  if (!owns) return json({ success: false, error: "wallet_not_linked_to_user" }, 403);

  // Quota
  const cap = tierLimit(sub.tier, "alerts.rules");
  const { count } = await env.HEALTH_DB.prepare(
    "SELECT COUNT(*) as count FROM alert_rules WHERE user_id = ?"
  ).bind(auth.user.id).first();
  if (count >= cap) {
    return json({
      success: false, error: "alert_limit_reached",
      current: count, limit: cap, current_tier: sub.tier, upgrade_url: "/pricing/",
    }, 402);
  }

  const id = newId();
  const now = Date.now();
  await env.HEALTH_DB.prepare(
    `INSERT INTO alert_rules
       (id, user_id, wallet_address, kind, params_json, channels_json, is_active, cooldown_secs, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, auth.user.id, wallet_address.toLowerCase(), kind,
    JSON.stringify(params || {}),
    JSON.stringify(channels),
    is_active === false ? 0 : 1,
    Math.max(60, Math.min(86400, parseInt(cooldown_secs, 10) || 3600)),
    now, now,
  ).run();

  return json({ success: true, id });
}

export async function handleAlertRuleUpdate(request, env, id) {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;

  let body; try { body = await request.json(); } catch { return json({ success: false, error: "invalid_json" }, 400); }
  const updates = [];
  const binds = [];
  if (body.params)         { updates.push("params_json = ?");   binds.push(JSON.stringify(body.params)); }
  if (body.channels)       {
    if (!body.channels.every((c) => VALID_CHANNELS.has(c))) return json({ success: false, error: "invalid_channels" }, 400);
    updates.push("channels_json = ?"); binds.push(JSON.stringify(body.channels));
  }
  if (typeof body.is_active === "boolean") { updates.push("is_active = ?"); binds.push(body.is_active ? 1 : 0); }
  if (Number.isFinite(body.cooldown_secs)) {
    updates.push("cooldown_secs = ?"); binds.push(Math.max(60, Math.min(86400, body.cooldown_secs)));
  }
  if (!updates.length) return json({ success: false, error: "nothing_to_update" }, 400);
  updates.push("updated_at = ?"); binds.push(Date.now());

  binds.push(id, auth.user.id);
  const res = await env.HEALTH_DB.prepare(
    `UPDATE alert_rules SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`
  ).bind(...binds).run();

  if (!res.meta?.changes) return json({ success: false, error: "rule_not_found" }, 404);
  return json({ success: true });
}

export async function handleAlertRuleDelete(request, env, id) {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const res = await env.HEALTH_DB.prepare(
    "DELETE FROM alert_rules WHERE id = ? AND user_id = ?"
  ).bind(id, auth.user.id).run();
  if (!res.meta?.changes) return json({ success: false, error: "rule_not_found" }, 404);
  return json({ success: true });
}

/* ============================================================
 * Channels
 * ============================================================ */

export async function handleAlertChannelsList(request, env) {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const { results } = await env.HEALTH_DB.prepare(
    `SELECT id, kind, destination, label, is_verified, created_at, verified_at
     FROM alert_channels WHERE user_id = ? ORDER BY created_at DESC`
  ).bind(auth.user.id).all();
  return json({ success: true, channels: results || [] });
}

export async function handleAlertChannelCreate(request, env) {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;

  const sub = await requireTier(auth.user.id, "pro", env);
  if (sub instanceof Response) return sub;

  let body; try { body = await request.json(); } catch { return json({ success: false, error: "invalid_json" }, 400); }
  const { kind, destination, label } = body || {};
  if (!VALID_CHANNELS.has(kind)) return json({ success: false, error: "invalid_kind" }, 400);
  if (!destination || typeof destination !== "string" || destination.length > 200) {
    return json({ success: false, error: "invalid_destination" }, 400);
  }
  if (kind === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(destination)) {
    return json({ success: false, error: "invalid_email" }, 400);
  }
  if (kind === "telegram" && !/^-?\d+$/.test(destination)) {
    return json({ success: false, error: "invalid_telegram_chat_id" }, 400);
  }

  // Quota
  const cap = tierLimit(sub.tier, "alerts.channels");
  const { count } = await env.HEALTH_DB.prepare(
    "SELECT COUNT(*) as count FROM alert_channels WHERE user_id = ?"
  ).bind(auth.user.id).first();
  if (count >= cap) {
    return json({
      success: false, error: "channel_limit_reached",
      current: count, limit: cap, current_tier: sub.tier, upgrade_url: "/pricing/",
    }, 402);
  }

  const id = newId();
  const verifToken = newId();
  const now = Date.now();
  await env.HEALTH_DB.prepare(
    `INSERT INTO alert_channels (id, user_id, kind, destination, label, is_verified, verification_token, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
  ).bind(id, auth.user.id, kind, destination, label || null, verifToken, now).run();

  // For email: persist user.email if not yet set, so billing/portal can prefill it.
  if (kind === "email" && !auth.user.email) {
    await env.HEALTH_DB.prepare("UPDATE users SET email = ? WHERE id = ?")
      .bind(destination, auth.user.id).run().catch(() => {});
  }

  return json({ success: true, id, verification_token: verifToken });
}

export async function handleAlertChannelVerify(request, env, id) {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;

  let body; try { body = await request.json(); } catch { return json({ success: false, error: "invalid_json" }, 400); }
  const { token } = body || {};
  if (!token) return json({ success: false, error: "missing_token" }, 400);

  const row = await env.HEALTH_DB.prepare(
    "SELECT verification_token FROM alert_channels WHERE id = ? AND user_id = ?"
  ).bind(id, auth.user.id).first();
  if (!row) return json({ success: false, error: "channel_not_found" }, 404);
  if (row.verification_token !== token) return json({ success: false, error: "invalid_token" }, 401);

  await env.HEALTH_DB.prepare(
    "UPDATE alert_channels SET is_verified = 1, verified_at = ?, verification_token = NULL WHERE id = ? AND user_id = ?"
  ).bind(Date.now(), id, auth.user.id).run();
  return json({ success: true });
}

export async function handleAlertChannelDelete(request, env, id) {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const res = await env.HEALTH_DB.prepare(
    "DELETE FROM alert_channels WHERE id = ? AND user_id = ?"
  ).bind(id, auth.user.id).run();
  if (!res.meta?.changes) return json({ success: false, error: "channel_not_found" }, 404);
  return json({ success: true });
}

/* ============================================================
 * Deliveries (audit log)
 * ============================================================ */

export async function handleAlertDeliveriesList(request, env) {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get("limit") || "50", 10)));

  const { results } = await env.HEALTH_DB.prepare(
    `SELECT id, rule_id, channel_id, fired_at, status, payload_json, error_message, delivered_at
     FROM alert_deliveries WHERE user_id = ?
     ORDER BY fired_at DESC LIMIT ?`
  ).bind(auth.user.id, limit).all();

  return json({
    success: true,
    deliveries: (results || []).map((r) => ({
      ...r,
      payload: safeParseJson(r.payload_json),
      payload_json: undefined,
    })),
  });
}

/* ---------- helpers ---------- */

function deserializeRule(row) {
  // Surface the next time this rule is eligible to fire so clients can
  // render "armed" vs "cooling down (next eligible 14:32 UTC)" without a
  // second roundtrip. Mirrors the cron's gating logic
  // (cron.js: `now - last_fired_at < cooldown_secs * 1000`).
  const cooldownMs = (row.cooldown_secs || 3600) * 1000;
  const nextEligibleAt = row.last_fired_at ? row.last_fired_at + cooldownMs : null;
  return {
    id: row.id,
    wallet_address: row.wallet_address,
    kind: row.kind,
    params: safeParseJson(row.params_json) || {},
    channels: safeParseJson(row.channels_json) || [],
    is_active: !!row.is_active,
    cooldown_secs: row.cooldown_secs,
    last_fired_at: row.last_fired_at,
    last_value: safeParseJson(row.last_value),
    next_eligible_at: nextEligibleAt,
    is_cooling_down: nextEligibleAt != null && nextEligibleAt > Date.now(),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
function safeParseJson(s) { try { return JSON.parse(s); } catch { return null; } }
