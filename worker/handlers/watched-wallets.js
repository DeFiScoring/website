/* DeFiScoring – Watched wallets
 *
 * Not to be confused with the older per-wallet protocol/token watchlist
 * (worker/index.js /api/watchlist/{wallet}, D1 table `watchlists`) that
 * assets/js/watchlist.js consumes — that one bookmarks protocols for a
 * wallet, this one follows wallets for a user.
 *
 *   GET    /api/watched-wallets            list, enriched with each wallet's
 *                                    latest persisted score/band/coverage
 *   POST   /api/watched-wallets            { wallet, label? }  add
 *   PUT    /api/watched-wallets/{id}       { label }           rename
 *   DELETE /api/watched-wallets/{id}       remove
 *
 * A watchlist entry is deliberately NOT required to be a linked wallet —
 * watching other addresses is the point. What it buys beyond a bookmark:
 * watched wallets join the scheduled re-score queue, so their score
 * history accrues without anyone pressing scan.
 *
 * Size is a per-tier cardinality cap (tiers.js watchlist.size), enforced
 * at insert the same way alert rules enforce theirs.
 */

import { requireSession, newId } from "../lib/auth.js";
import { getSubscription, tierLimit } from "../lib/tiers.js";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json" },
  });
}
function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

export async function handleWatchedWalletsList(request, env) {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;

  const { results } = await env.HEALTH_DB.prepare(
    `SELECT w.id, w.wallet, w.label, w.created_at,
            h.score, h.computed_at AS scored_at, h.source_json
     FROM watched_wallets w
     LEFT JOIN health_scores h ON h.wallet = w.wallet
       AND h.computed_at = (SELECT MAX(h2.computed_at) FROM health_scores h2 WHERE h2.wallet = w.wallet)
     WHERE w.user_id = ?
     ORDER BY w.created_at ASC`
  ).bind(auth.user.id).all();

  const entries = (results || []).map((r) => {
    const src = safeJson(r.source_json) || {};
    return {
      id: r.id, wallet: r.wallet, label: r.label, created_at: r.created_at,
      score: r.score ?? null,
      score_band: r.score != null ? (src.score_band || null) : null,
      coverage: typeof src.coverage === "number" ? src.coverage : null,
      scored_at: r.scored_at ?? null,
    };
  });
  return json({ success: true, entries, count: entries.length });
}

export async function handleWatchedWalletsAdd(request, env) {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;

  let body; try { body = await request.json(); } catch { return json({ success: false, error: "invalid_json" }, 400); }
  const wallet = String(body?.wallet || "").toLowerCase();
  const label = typeof body?.label === "string" ? body.label.slice(0, 80) : null;
  if (!ADDR_RE.test(wallet)) return json({ success: false, error: "invalid_wallet_address" }, 400);

  const sub = await getSubscription(env, auth.user.id);
  const cap = tierLimit(sub.tier, "watchlist.size");
  const { n } = await env.HEALTH_DB.prepare(
    "SELECT COUNT(*) AS n FROM watched_wallets WHERE user_id = ?"
  ).bind(auth.user.id).first();
  if (n >= cap) {
    return json({
      success: false, error: "watchlist_limit_reached",
      current: n, limit: cap, current_tier: sub.tier, upgrade_url: "/pricing/",
    }, 402);
  }

  const id = newId();
  try {
    await env.HEALTH_DB.prepare(
      "INSERT INTO watched_wallets (id, user_id, wallet, label, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(id, auth.user.id, wallet, label, Date.now()).run();
  } catch (e) {
    // UNIQUE(user_id, wallet) — watching the same wallet twice is a no-op
    // worth naming, not a 500.
    if (/UNIQUE/i.test(String(e.message || e))) {
      return json({ success: false, error: "already_watching", wallet }, 409);
    }
    throw e;
  }
  return json({ success: true, id, wallet, label });
}

export async function handleWatchedWalletsUpdate(request, env, id) {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  let body; try { body = await request.json(); } catch { return json({ success: false, error: "invalid_json" }, 400); }
  const label = typeof body?.label === "string" ? body.label.slice(0, 80) : null;
  const res = await env.HEALTH_DB.prepare(
    "UPDATE watched_wallets SET label = ? WHERE id = ? AND user_id = ?"
  ).bind(label, id, auth.user.id).run();
  if (!res?.meta?.changes) return json({ success: false, error: "not_found" }, 404);
  return json({ success: true, id, label });
}

export async function handleWatchedWalletsDelete(request, env, id) {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  // Scoped to the caller: someone else's entry id is indistinguishable from
  // a missing one, by design.
  const res = await env.HEALTH_DB.prepare(
    "DELETE FROM watched_wallets WHERE id = ? AND user_id = ?"
  ).bind(id, auth.user.id).run();
  if (!res?.meta?.changes) return json({ success: false, error: "not_found" }, 404);
  return json({ success: true, id });
}
