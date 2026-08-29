/* DeFiScoring – API key issuance and authentication
 *
 * The licensing primitive. A customer integrating the score into their own
 * underwriting pipeline authenticates with a key rather than a browser
 * session, and their tier's `bulk_api.requests.day` budget is what they are
 * actually paying for.
 *
 * Key format:  dfs_live_<40 hex chars>
 *              └──┬───┘ └──────┬─────┘
 *          shown in UI      the secret
 *
 * Storage: only SHA-256(key) is persisted, plus the non-secret prefix. We
 * cannot show a key again after creation and we say so in the UI — that is a
 * deliberate trade for a database leak yielding no usable credentials.
 *
 * Authentication is ADDITIVE, never a new wall. /api/wallet-score stays public
 * under its IP rate limit exactly as the pricing page promises; presenting a
 * key swaps that shared limit for the account's own metered budget.
 */

import { newId } from "./auth.js";
import { getSubscription, tierLimit, consumeQuota } from "./tiers.js";

const KEY_PREFIX = "dfs_live_";
const SECRET_BYTES = 20;              // 40 hex chars
export const QUOTA_KEY = "bulk_api.requests.day";

function toHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Generate a new raw key. Returned once, to the creating user, then discarded. */
export function generateKey() {
  const buf = new Uint8Array(SECRET_BYTES);
  crypto.getRandomValues(buf);
  const raw = KEY_PREFIX + toHex(buf);
  return { raw, prefix: raw.slice(0, KEY_PREFIX.length + 6) };
}

export async function hashKey(raw) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return toHex(new Uint8Array(digest));
}

/** Pull a bearer key off the request. Returns null when absent or malformed. */
export function readBearerKey(request) {
  const h = request.headers.get("authorization") || "";
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  if (!m) return null;
  const raw = m[1];
  // Shape-check before touching the database so junk headers cost nothing.
  if (!raw.startsWith(KEY_PREFIX)) return null;
  if (raw.length !== KEY_PREFIX.length + SECRET_BYTES * 2) return null;
  return raw;
}

function utcDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Resolve a bearer key to its owner.
 *
 * Returns null when there is no key at all (caller falls back to public
 * access), or { error } when a key was presented but is not usable — those are
 * different outcomes and must not be collapsed: a revoked key deserves a 401,
 * not a silent downgrade to anonymous rate limiting.
 */
export async function authenticateApiKey(request, env) {
  const raw = readBearerKey(request);
  if (!raw) return null;
  if (!env.HEALTH_DB) return { error: "db_unavailable", status: 503 };

  const key_hash = await hashKey(raw);
  const row = await env.HEALTH_DB.prepare(
    "SELECT id, user_id, name, revoked_at FROM api_keys WHERE key_hash = ?"
  ).bind(key_hash).first();

  if (!row) return { error: "invalid_api_key", status: 401 };
  if (row.revoked_at) return { error: "api_key_revoked", status: 401 };

  const sub = await getSubscription(env, row.user_id);
  return { key_id: row.id, user_id: row.user_id, name: row.name, tier: sub.tier };
}

/**
 * Charge one request against the account's daily budget and record it against
 * the key. Returns { ok } or { ok:false, ...limit detail } for a 429.
 */
export async function chargeApiRequest(env, auth, now = Date.now()) {
  const limit = tierLimit(auth.tier, QUOTA_KEY);
  if (!limit) {
    return {
      ok: false, status: 402, error: "api_access_not_in_plan",
      tier: auth.tier, limit: 0, upgrade_url: "/pricing/",
    };
  }

  const q = await consumeQuota(env, auth.user_id, auth.tier, QUOTA_KEY, 1);
  if (!q.ok) {
    return {
      ok: false, status: 429, error: "api_quota_exceeded",
      used: q.used, limit: q.limit, retry_at: q.retry_at, upgrade_url: "/pricing/",
    };
  }

  // Per-key attribution is observability, not enforcement — a failure here
  // must never reject a request the customer has already been charged for.
  try {
    await env.HEALTH_DB.prepare(
      `INSERT INTO api_key_usage (key_id, day, requests) VALUES (?, ?, 1)
       ON CONFLICT(key_id, day) DO UPDATE SET requests = api_key_usage.requests + 1`
    ).bind(auth.key_id, utcDay(now)).run();
    await env.HEALTH_DB.prepare(
      "UPDATE api_keys SET last_used_at = ? WHERE id = ?"
    ).bind(now, auth.key_id).run();
  } catch (_) { /* attribution is best-effort */ }

  return { ok: true, used: q.used, limit: q.limit, retry_at: q.retry_at };
}

/** Create a key for a user. The raw value is returned exactly once. */
export async function createApiKey(env, userId, name, now = Date.now()) {
  const { raw, prefix } = generateKey();
  const id = newId();
  await env.HEALTH_DB.prepare(
    `INSERT INTO api_keys (id, user_id, name, prefix, key_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, userId, name || null, prefix, await hashKey(raw), now).run();
  return { id, raw, prefix, name: name || null, created_at: now };
}

export { KEY_PREFIX, utcDay };
