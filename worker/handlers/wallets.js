/* DeFiScoring – Multi-wallet linking
 *
 *   GET    /api/wallets               → list every wallet linked to the session user
 *   POST   /api/wallets/link          → prove ownership of a NEW wallet via SIWE,
 *                                        then attach it to the current user
 *   DELETE /api/wallets/{address}     → unlink a non-primary wallet
 *
 * Linking another wallet requires a fresh SIWE signature from THAT wallet
 * (not the primary), so the user must connect each wallet in turn from the
 * frontend wallet picker.
 */

import { requireSession, verifySiwe, newId } from "../lib/auth.js";
import { requireTier, tierLimit } from "../lib/tiers.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json" },
  });
}

function allowedDomains(env) {
  const list = String(env.ALLOWED_ORIGINS || "")
    .split(/[\s,]+/).filter(Boolean)
    .map((o) => { try { return new URL(o).host; } catch { return null; } })
    .filter(Boolean);
  if (!list.includes("defiscoring.com")) list.push("defiscoring.com");
  return list;
}

export async function handleWalletsList(request, env) {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;

  const { results } = await env.HEALTH_DB.prepare(
    `SELECT wallet_address, label, is_primary, connected_at, last_seen_at
     FROM wallet_connections WHERE user_id = ? ORDER BY is_primary DESC, connected_at ASC`
  ).bind(auth.user.id).all();
  return json({ success: true, wallets: results || [] });
}

export async function handleWalletLink(request, env) {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;

  // Tier gate: wallets-linked cap
  const sub = await requireTier(auth.user.id, "free", env); // any tier OK; we just need the tier
  if (sub instanceof Response) return sub;

  let body;
  try { body = await request.json(); }
  catch { return json({ success: false, error: "invalid_json" }, 400); }

  const { message, signature, label } = body || {};
  const result = await verifySiwe(env, {
    message, signature,
    expectedDomains: allowedDomains(env),
  });
  if (!result.ok) return json({ success: false, error: result.error }, 401);

  const newWallet = result.address.toLowerCase();

  // Reject if this address belongs to a different user already.
  const owner = await env.HEALTH_DB.prepare(
    "SELECT user_id FROM wallet_connections WHERE wallet_address = ? LIMIT 1"
  ).bind(newWallet).first();
  if (owner && owner.user_id !== auth.user.id) {
    return json({ success: false, error: "wallet_owned_by_another_user" }, 409);
  }
  if (owner && owner.user_id === auth.user.id) {
    return json({ success: false, error: "wallet_already_linked" }, 200);
  }

  // Quota: how many wallets can this tier link?
  // Atomic check-and-insert: a single SQL statement guards the cap so two
  // concurrent /api/wallets/link requests can't both pass a stale COUNT(*)
  // and double-insert past the limit. The UNIQUE(user_id, wallet_address)
  // constraint also forms a second backstop against duplicates.
  const cap = tierLimit(sub.tier, "wallets.linked");
  const now = Date.now();
  const ins = await env.HEALTH_DB.prepare(
    `INSERT INTO wallet_connections
       (user_id, wallet_address, label, signature, message_hash, is_primary, connected_at, last_seen_at)
     SELECT ?, ?, ?, ?, ?, 0, ?, ?
      WHERE (SELECT COUNT(*) FROM wallet_connections WHERE user_id = ?) < ?`
  ).bind(
    auth.user.id, newWallet, label || null, signature, result.messageHash, now, now,
    auth.user.id, cap,
  ).run();

  if (!ins?.meta?.changes) {
    // Either we hit the cap or another concurrent request raced us in. Re-
    // read so we can return an accurate error to the user.
    const { count } = await env.HEALTH_DB.prepare(
      "SELECT COUNT(*) as count FROM wallet_connections WHERE user_id = ?"
    ).bind(auth.user.id).first();
    return json({
      success: false, error: "wallet_limit_reached",
      current: count, limit: cap, current_tier: sub.tier, upgrade_url: "/pricing/",
    }, 402);
  }

  return json({ success: true, wallet: { wallet_address: newWallet, label: label || null } });
}

export async function handleWalletUnlink(request, env, walletAddress) {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;

  const target = (walletAddress || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(target)) return json({ success: false, error: "invalid_address" }, 400);
  if (target === auth.user.primary_wallet) {
    return json({ success: false, error: "cannot_unlink_primary_wallet" }, 400);
  }

  const res = await env.HEALTH_DB.prepare(
    "DELETE FROM wallet_connections WHERE user_id = ? AND wallet_address = ? AND is_primary = 0"
  ).bind(auth.user.id, target).run();

  return json({ success: true, removed: res?.meta?.changes || 0 });
}
