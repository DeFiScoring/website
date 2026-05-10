/* DeFiScoring – Admin: alerts (deliveries view + replay)
 *
 *   GET   /api/admin/alerts/deliveries?status=&limit=&offset=
 *   POST  /api/admin/alerts/deliveries/{id}/replay
 *
 * "Replay" re-sends the original payload through email or telegram via
 * the existing libs. We never mutate the original delivery row — we
 * append a NEW row with status='sent'|'failed' and a payload that
 * references the source delivery in `payload_json.replayed_from`.
 */

import { requireAdmin, auditLog } from "../../lib/admin.js";
import { newId } from "../../lib/auth.js";
import { send as sendEmail, isConfigured as emailConfigured } from "../../lib/email.js";
import { send as sendTelegram, isConfigured as telegramConfigured } from "../../lib/telegram.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export async function handleAdminAlertDeliveries(request, env, url) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  const status = url.searchParams.get("status");
  const limit  = Math.max(1, Math.min(500, parseInt(url.searchParams.get("limit")  || "100", 10) || 100));
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);

  const where = []; const binds = [];
  if (status) { where.push("d.status = ?"); binds.push(status); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  binds.push(limit, offset);
  const rows = await env.HEALTH_DB.prepare(
    `SELECT d.id, d.rule_id, d.channel_id, d.user_id, d.fired_at, d.status,
            d.payload_json, d.error_message, d.delivered_at,
            u.primary_wallet, c.kind AS channel_kind, c.destination
     FROM alert_deliveries d
     LEFT JOIN users u ON u.id = d.user_id
     LEFT JOIN alert_channels c ON c.id = d.channel_id
     ${whereSql}
     ORDER BY d.fired_at DESC LIMIT ? OFFSET ?`
  ).bind(...binds).all();

  return json({ success: true, deliveries: rows.results || [], limit, offset });
}

export async function handleAdminAlertReplay(request, env, deliveryId) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  const orig = await env.HEALTH_DB.prepare(
    `SELECT d.id, d.rule_id, d.channel_id, d.user_id, d.payload_json,
            c.kind AS channel_kind, c.destination, c.is_verified
     FROM alert_deliveries d
     LEFT JOIN alert_channels c ON c.id = d.channel_id
     WHERE d.id = ?`
  ).bind(deliveryId).first();
  if (!orig) return json({ success: false, error: "delivery_not_found" }, 404);
  if (!orig.channel_kind) return json({ success: false, error: "channel_no_longer_exists" }, 400);

  let payload;
  try { payload = JSON.parse(orig.payload_json || "{}"); } catch { payload = {}; }

  let status = "failed", errorMsg = null;
  try {
    if (orig.channel_kind === "email") {
      if (!emailConfigured(env)) throw new Error("email_not_configured");
      await sendEmail(env, {
        to:      orig.destination,
        subject: payload.subject || "[DeFiScoring] Replay",
        html:    payload.html || payload.text || "(no body)",
        text:    payload.text || "(no body)",
      });
      status = "sent";
    } else if (orig.channel_kind === "telegram") {
      if (!telegramConfigured(env)) throw new Error("telegram_not_configured");
      await sendTelegram(env, {
        chatId: orig.destination,
        text:   payload.telegram || payload.text || "(no body)",
      });
      status = "sent";
    } else {
      throw new Error("unsupported_channel_kind:" + orig.channel_kind);
    }
  } catch (e) {
    errorMsg = e.message || String(e);
  }

  // Append a new delivery row tagged as a replay.
  const now = Date.now();
  const newRow = {
    id: newId(),
    rule_id: orig.rule_id,
    channel_id: orig.channel_id,
    user_id: orig.user_id,
    fired_at: now,
    status,
    payload_json: JSON.stringify({ ...payload, replayed_from: orig.id, replayed_by: auth.user.id }),
    error_message: errorMsg,
    delivered_at: status === "sent" ? now : null,
  };
  await env.HEALTH_DB.prepare(
    `INSERT INTO alert_deliveries (id, rule_id, channel_id, user_id, fired_at,
        status, payload_json, error_message, delivered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(newRow.id, newRow.rule_id, newRow.channel_id, newRow.user_id,
         newRow.fired_at, newRow.status, newRow.payload_json,
         newRow.error_message, newRow.delivered_at).run();

  await auditLog(env, {
    actor: auth.user, action: "alert.replay",
    targetType: "alert_delivery", targetId: orig.id,
    before: null,
    after: { new_delivery_id: newRow.id, status, error: errorMsg },
    request,
  });

  return json({ success: status === "sent", delivery_id: newRow.id, status, error: errorMsg });
}
