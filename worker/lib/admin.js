/* DeFiScoring – Admin middleware + audit log helper
 *
 * `requireAdmin(request, env)` is the SIWE-based gate for every /api/admin/*
 * handler. It piggybacks on the existing `requireSession` flow (HMAC-signed
 * `ds_session` cookie → sessions row → users row) and then checks the
 * `users.is_admin` column. The legacy `Authorization: Bearer <ADMIN_TOKEN>`
 * gate (used by /api/intel/*) stays in place — this module is purely additive.
 *
 * `auditLog(env, …)` writes one row to `admin_audit_log` per admin mutation.
 * It is intentionally swallow-on-error: a failure to log MUST NOT prevent
 * the underlying admin action from completing, because the action has
 * already happened by the time we log. We log to console.warn instead so
 * the operator can spot persistent log-write failures via tail.
 */

import { requireSession, newId } from "./auth.js";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";

function utf8(s) { return new TextEncoder().encode(s); }
function bytesToHex(arr) {
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function forbidden(reason) {
  return new Response(
    JSON.stringify({ success: false, error: "forbidden", reason }),
    { status: 403, headers: { "content-type": "application/json" } },
  );
}

/**
 * Resolve the calling admin. Returns `{ user, session }` or a `Response`
 * (401 if no session, 403 if signed in but not admin).
 */
export async function requireAdmin(request, env) {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  if (!auth.user || auth.user.is_admin !== 1) return forbidden("not_admin");
  return auth;
}

/**
 * Hash an IP for audit log storage. Same posture as `worker/index.js`'s
 * rate-limit IP hashing — pepper is `IP_HASH_PEPPER`. Returns null if no
 * pepper is configured (audit log keeps working, just without IP).
 */
function hashIp(env, request) {
  if (!env.IP_HASH_PEPPER) return null;
  const ip = request.headers.get("cf-connecting-ip")
          || request.headers.get("x-forwarded-for")
          || "";
  if (!ip) return null;
  return bytesToHex(hmac(sha256, utf8(env.IP_HASH_PEPPER), utf8(ip.split(",")[0].trim())));
}

/**
 * Append one row to `admin_audit_log`. Never throws.
 *
 *   await auditLog(env, {
 *     actor:       auth.user,
 *     action:      "user.suspend",
 *     targetType:  "user",
 *     targetId:    targetUserId,
 *     before:      { suspended_at: null },
 *     after:       { suspended_at: now },
 *     request,
 *   });
 */
export async function auditLog(env, { actor, action, targetType, targetId, before, after, request } = {}) {
  if (!env.HEALTH_DB || !actor || !action) return;
  try {
    const id = newId();
    const ipHash = request ? hashIp(env, request) : null;
    await env.HEALTH_DB.prepare(
      `INSERT INTO admin_audit_log
         (id, actor_id, actor_wallet, action, target_type, target_id,
          before_json, after_json, ip_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      actor.id,
      actor.primary_wallet || "",
      action,
      targetType || null,
      targetId || null,
      before == null ? null : JSON.stringify(before),
      after  == null ? null : JSON.stringify(after),
      ipHash,
      Date.now(),
    ).run();
  } catch (e) {
    console.warn("[auditLog] failed:", e && e.message ? e.message : String(e));
  }
}
