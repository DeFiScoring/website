/* DeFiScoring – SIWE authentication endpoints
 *
 *   GET  /api/auth/nonce   → mint a single-use nonce (5 min TTL)
 *   POST /api/auth/verify  → consume nonce, verify signature, set cookie
 *   POST /api/auth/logout  → destroy session, clear cookie
 *   GET  /api/auth/me      → return current session's user (or 401)
 */

import {
  mintNonce, verifySiwe, findOrCreateUser, createSession, destroySession,
  buildSessionCookie, buildLogoutCookie, signSessionToken,
  requireSession, readCookie, verifySessionToken,
} from "../lib/auth.js";
import { getSubscription } from "../lib/tiers.js";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function allowedDomains(env) {
  const list = String(env.ALLOWED_ORIGINS || "")
    .split(/[\s,]+/).filter(Boolean)
    .map((origin) => {
      try { return new URL(origin).host; } catch { return null; }
    })
    .filter(Boolean);
  // Always accept the canonical production domain even if ALLOWED_ORIGINS is misconfigured.
  if (!list.includes("defiscoring.com")) list.push("defiscoring.com");
  return list;
}

export async function handleAuthNonce(request, env) {
  if (!env.HEALTH_DB) return json({ success: false, error: "db_unavailable" }, 503);
  try {
    const { nonce, expiresAt } = await mintNonce(env);
    return json({ success: true, nonce, expires_at: expiresAt });
  } catch (e) {
    return json({ success: false, error: "nonce_mint_failed", detail: e.message }, 500);
  }
}

export async function handleAuthVerify(request, env) {
  if (!env.HEALTH_DB) return json({ success: false, error: "db_unavailable" }, 503);
  if (!env.SESSION_HMAC_KEY) return json({ success: false, error: "session_hmac_key_unset" }, 503);

  let body;
  try { body = await request.json(); }
  catch { return json({ success: false, error: "invalid_json" }, 400); }

  const { message, signature } = body || {};
  const result = await verifySiwe(env, {
    message, signature,
    expectedDomains: allowedDomains(env),
  });
  if (!result.ok) return json({ success: false, error: result.error }, 401);

  const user = await findOrCreateUser(env, result.address);
  const session = await createSession(env, {
    userId: user.id,
    walletAddress: result.address,
    request,
  });
  const token = signSessionToken(session.id, env.SESSION_HMAC_KEY);
  const cookie = buildSessionCookie(token);

  return json(
    {
      success: true,
      user: {
        id: user.id,
        primary_wallet: user.primary_wallet,
        is_admin: !!user.is_admin,
        is_new: !!user.isNew,
      },
      session: { expires_at: session.expiresAt },
    },
    200,
    { "set-cookie": cookie },
  );
}

export async function handleAuthLogout(request, env) {
  const cookie = readCookie(request);
  if (cookie) {
    const sessionId = verifySessionToken(cookie, env.SESSION_HMAC_KEY || "");
    if (sessionId) await destroySession(env, sessionId);
  }
  return json({ success: true }, 200, { "set-cookie": buildLogoutCookie() });
}

export async function handleAuthMe(request, env) {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const sub = await getSubscription(env, auth.user.id);
  return json({
    success: true,
    user: {
      id: auth.user.id,
      primary_wallet: auth.user.primary_wallet,
      email: auth.user.email,
      display_name: auth.user.display_name,
      is_admin: !!auth.user.is_admin,
    },
    subscription: {
      tier: sub.tier,
      status: sub.status,
      current_period_end: sub.current_period_end || null,
      cancel_at_period_end: !!sub.cancel_at_period_end,
    },
    session: {
      wallet_address: auth.session.wallet_address,
      expires_at: auth.session.expires_at,
    },
  });
}
