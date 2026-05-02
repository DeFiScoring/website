// worker/lib/cache.js
// ----------------------------------------------------------------------------
// Thin wrapper over Cloudflare KV with an in-memory fallback so the new
// modules work in `wrangler dev` even before a CACHE binding is provisioned.
//
// We piggyback on the existing DEFI_CACHE namespace (already declared in
// wrangler.jsonc) when no dedicated binding is wired — same TTL semantics,
// just a different key prefix. This avoids forcing a `wrangler kv:namespace
// create` step on every developer.
// ----------------------------------------------------------------------------

const memoryCache = new Map();

function pickKv(env) {
  if (env && env.CACHE) return env.CACHE;
  if (env && env.DEFI_CACHE) return env.DEFI_CACHE;
  return null;
}

export async function cacheGet(env, key) {
  const kv = pickKv(env);
  if (kv) {
    try {
      const v = await kv.get(key);
      return v ? JSON.parse(v) : null;
    } catch {
      return null;
    }
  }
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    memoryCache.delete(key);
    return null;
  }
  return entry.value;
}

export async function cacheSet(env, key, value, ttlSeconds = 60) {
  const kv = pickKv(env);
  if (kv) {
    try {
      await kv.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, ttlSeconds) });
    } catch { /* swallow KV errors — cache is best-effort */ }
    return;
  }
  memoryCache.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
}
