/* DeFiScoring – Admin: users
 *
 *   GET    /api/admin/users?q=&limit=&offset=  list/search users
 *   GET    /api/admin/users/{id}               full user detail (sub, wallets, notes)
 *   PATCH  /api/admin/users/{id}               { suspended?, is_admin?, note? }
 *
 * Suspension is a soft-ban (sets users.suspended_at). is_admin can only be
 * granted by an existing admin (you already are one to call this endpoint).
 * Notes are append-only (each PATCH with a `note` adds a new row).
 */

import { requireAdmin, auditLog } from "../../lib/admin.js";
import { newId } from "../../lib/auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export async function handleAdminUsersList(request, env, url) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  const q      = (url.searchParams.get("q") || "").toLowerCase().trim();
  const limit  = Math.max(1, Math.min(200, parseInt(url.searchParams.get("limit")  || "50", 10) || 50));
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);

  let rows;
  if (q) {
    const like = `%${q}%`;
    rows = await env.HEALTH_DB.prepare(
      `SELECT u.id, u.primary_wallet, u.email, u.display_name, u.is_admin,
              u.suspended_at, u.created_at, u.last_login_at,
              s.tier, s.status AS sub_status
       FROM users u
       LEFT JOIN subscriptions s ON s.user_id = u.id
       WHERE LOWER(u.primary_wallet) LIKE ? OR LOWER(u.email) LIKE ? OR LOWER(u.id) LIKE ?
       ORDER BY u.last_login_at DESC LIMIT ? OFFSET ?`
    ).bind(like, like, like, limit, offset).all();
  } else {
    rows = await env.HEALTH_DB.prepare(
      `SELECT u.id, u.primary_wallet, u.email, u.display_name, u.is_admin,
              u.suspended_at, u.created_at, u.last_login_at,
              s.tier, s.status AS sub_status
       FROM users u
       LEFT JOIN subscriptions s ON s.user_id = u.id
       ORDER BY u.last_login_at DESC LIMIT ? OFFSET ?`
    ).bind(limit, offset).all();
  }

  return json({ success: true, users: rows.results || [], limit, offset });
}

export async function handleAdminUserDetail(request, env, userId) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  const user = await env.HEALTH_DB.prepare(
    `SELECT id, primary_wallet, email, display_name, is_admin, suspended_at,
            created_at, last_login_at FROM users WHERE id = ?`
  ).bind(userId).first();
  if (!user) return json({ success: false, error: "user_not_found" }, 404);

  const sub = await env.HEALTH_DB.prepare(
    `SELECT tier, stripe_customer_id, stripe_subscription_id, status,
            current_period_end, cancel_at_period_end, created_at, updated_at
     FROM subscriptions WHERE user_id = ?`
  ).bind(userId).first();

  const wallets = await env.HEALTH_DB.prepare(
    `SELECT wallet_address, label, is_primary, connected_at, last_seen_at
     FROM wallet_connections WHERE user_id = ? ORDER BY is_primary DESC, connected_at ASC`
  ).bind(userId).all();

  const notes = await env.HEALTH_DB.prepare(
    `SELECT id, author_id, body, created_at FROM admin_notes
     WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`
  ).bind(userId).all();

  const sessionsCount = await env.HEALTH_DB.prepare(
    "SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?"
  ).bind(userId, Date.now()).first();

  return json({
    success: true,
    user, subscription: sub || null,
    wallets: wallets.results || [],
    notes:   notes.results   || [],
    active_sessions: (sessionsCount && sessionsCount.n) || 0,
  });
}

export async function handleAdminUserPatch(request, env, userId) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  const user = await env.HEALTH_DB.prepare(
    "SELECT id, primary_wallet, is_admin, suspended_at FROM users WHERE id = ?"
  ).bind(userId).first();
  if (!user) return json({ success: false, error: "user_not_found" }, 404);

  let body;
  try { body = await request.json(); } catch { body = {}; }

  const before = { is_admin: user.is_admin, suspended_at: user.suspended_at };
  const updates = [];
  const binds = [];
  const after = { ...before };

  if (typeof body.suspended === "boolean") {
    const ts = body.suspended ? Date.now() : null;
    updates.push("suspended_at = ?");
    binds.push(ts);
    after.suspended_at = ts;
  }
  if (typeof body.is_admin === "boolean") {
    // Self-demotion guard — refuse to remove admin from your own account
    // via the API. Forces a multi-admin scenario or a manual D1 update.
    if (user.id === auth.user.id && body.is_admin === false) {
      return json({ success: false, error: "cannot_self_demote" }, 400);
    }
    const v = body.is_admin ? 1 : 0;
    updates.push("is_admin = ?");
    binds.push(v);
    after.is_admin = v;
  }

  if (updates.length) {
    binds.push(userId);
    await env.HEALTH_DB.prepare(
      `UPDATE users SET ${updates.join(", ")} WHERE id = ?`
    ).bind(...binds).run();

    // If suspending, also kill all active sessions for this user.
    if (body.suspended === true) {
      await env.HEALTH_DB.prepare("DELETE FROM sessions WHERE user_id = ?")
        .bind(userId).run().catch(() => {});
    }
  }

  // Optional note
  if (typeof body.note === "string" && body.note.trim()) {
    const text = body.note.trim().slice(0, 4000);
    await env.HEALTH_DB.prepare(
      "INSERT INTO admin_notes (id, user_id, author_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(newId(), userId, auth.user.id, text, Date.now(), Date.now()).run();
  }

  await auditLog(env, {
    actor: auth.user, action: "user.patch",
    targetType: "user", targetId: userId,
    before, after,
    request,
  });

  return json({ success: true, before, after });
}
