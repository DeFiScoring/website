/* DeFiScoring – Admin: chatbot leads
 *
 *   GET    /api/admin/leads?q=&optedOut=&limit=&offset=
 *   PATCH  /api/admin/leads/{email}    { optOut: boolean }
 *   DELETE /api/admin/leads/{email}    (full erase – DSAR support)
 */

import { requireAdmin, auditLog } from "../../lib/admin.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export async function handleAdminLeadsList(request, env, url) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  const q        = (url.searchParams.get("q") || "").toLowerCase().trim();
  const optedOut = url.searchParams.get("optedOut"); // "1" | "0" | null
  const limit    = Math.max(1, Math.min(500, parseInt(url.searchParams.get("limit")  || "100", 10) || 100));
  const offset   = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);

  const where = []; const binds = [];
  if (q) { where.push("LOWER(email) LIKE ?"); binds.push(`%${q}%`); }
  if (optedOut === "1" || optedOut === "0") {
    where.push("marketing_opt_out = ?"); binds.push(parseInt(optedOut, 10));
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  binds.push(limit, offset);
  const rows = await env.HEALTH_DB.prepare(
    `SELECT email, source, consented_at, last_seen_at, sessions_count,
            last_risk_profile, marketing_opt_out
     FROM chatbot_leads ${whereSql}
     ORDER BY last_seen_at DESC LIMIT ? OFFSET ?`
  ).bind(...binds).all();

  return json({ success: true, leads: rows.results || [], limit, offset });
}

export async function handleAdminLeadPatch(request, env, email) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  let body; try { body = await request.json(); } catch { body = {}; }
  if (typeof body.optOut !== "boolean") {
    return json({ success: false, error: "optOut_required_boolean" }, 400);
  }
  const lower = String(email || "").toLowerCase();
  const before = await env.HEALTH_DB.prepare(
    "SELECT marketing_opt_out FROM chatbot_leads WHERE email = ?"
  ).bind(lower).first();
  if (!before) return json({ success: false, error: "lead_not_found" }, 404);

  await env.HEALTH_DB.prepare(
    "UPDATE chatbot_leads SET marketing_opt_out = ? WHERE email = ?"
  ).bind(body.optOut ? 1 : 0, lower).run();

  await auditLog(env, {
    actor: auth.user, action: "lead.opt_out",
    targetType: "lead", targetId: lower,
    before: { marketing_opt_out: before.marketing_opt_out },
    after:  { marketing_opt_out: body.optOut ? 1 : 0 },
    request,
  });

  return json({ success: true, marketing_opt_out: body.optOut ? 1 : 0 });
}

export async function handleAdminLeadDelete(request, env, email) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  const lower = String(email || "").toLowerCase();
  const r = await env.HEALTH_DB.prepare(
    "DELETE FROM chatbot_leads WHERE email = ?"
  ).bind(lower).run();

  const changes = (r && r.meta && r.meta.changes) || 0;
  if (!changes) return json({ success: false, error: "lead_not_found" }, 404);

  await auditLog(env, {
    actor: auth.user, action: "lead.delete",
    targetType: "lead", targetId: lower,
    before: { existed: true },
    after:  { deleted: true },
    request,
  });

  return json({ success: true, deleted: changes });
}
