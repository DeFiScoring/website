/* DeFiScoring – Admin: audit log read
 *
 *   GET /api/admin/audit?action=&actor=&target=&limit=&offset=
 */

import { requireAdmin } from "../../lib/admin.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export async function handleAdminAuditList(request, env, url) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  const action = url.searchParams.get("action");
  const actor  = url.searchParams.get("actor");
  const target = url.searchParams.get("target");
  const limit  = Math.max(1, Math.min(500, parseInt(url.searchParams.get("limit")  || "100", 10) || 100));
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);

  const where = []; const binds = [];
  if (action) { where.push("action = ?"); binds.push(action); }
  if (actor)  { where.push("actor_id = ?"); binds.push(actor); }
  if (target) { where.push("target_id = ?"); binds.push(target); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  binds.push(limit, offset);
  const rows = await env.HEALTH_DB.prepare(
    `SELECT id, actor_id, actor_wallet, action, target_type, target_id,
            before_json, after_json, ip_hash, created_at
     FROM admin_audit_log ${whereSql}
     ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).bind(...binds).all();

  return json({ success: true, entries: rows.results || [], limit, offset });
}
