/* DeFiScoring – OFAC / sanctions screening
 *
 * Every wallet address crossing the worker boundary is checked against a deny
 * list before any handler runs. This module owns the list, its refresh and its
 * observable health.
 *
 * TWO LAYERS, DELIBERATELY:
 *
 *   SEED    — the compiled-in set below. Small, conservative, and always
 *             enforced. It is the floor.
 *   OVERLAY — a larger list an operator loads into KV from whatever feed they
 *             licence (OFAC SDN export, Chainalysis, TRM). Refreshed by cron
 *             from SANCTIONS_FEED_URL.
 *
 * The runtime list is always SEED ∪ OVERLAY, never the overlay alone. That is
 * the whole safety argument: a feed that returns garbage, an empty array, or a
 * truncated response can only fail to ADD coverage — it can never silently
 * REMOVE it. Sanctions screening that quietly degrades to nothing is worse
 * than no screening, because nobody notices.
 *
 * For the same reason refreshSanctionsList() refuses to install a list that
 * looks broken (unparseable, or a sudden collapse in size), and leaves the
 * previous overlay in place instead.
 */

// Tornado Cash — OFAC SDN List, Aug 8 2022, plus historical designations.
// The floor, never removed by a refresh.
const SEED_ADDRESSES = new Set([
  "0x8589427373d6d84e98730d7795d8f6f8731fda16",
  "0x722122df12d4e14e13ac3b6895a86e84145b6967",
  "0xdd4c48c0b24039969fc16d1cdf626eab821d3384",
  "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b",
  "0xd96f2b1c14db8458374d9aca76e26c3d18364307",
  "0x4736dcf1b7a3d580672ccce6213ca176d69c8b81",
  "0x910cbd523d972eb0a6f4cae4618ad62622b39dbf",
  "0xa160cdab225685da1d56aa342ad8841c3b53f291",
  "0xd4b88df4d29f5cedd6857912842cff3b20c8cfa3",
  "0xfd8610d20aa15b7b2e3be39b396a1bc3516c7144",
  "0xf60dd140cff0706bae9cd734ac3ae76ad9ebc32a",
  "0x22aaa7720ddd5388a3c0a3333430953c68f1849b",
  "0xba214c1c1928a32bffe790263e38b4af9bfcd659",
  "0xb1c8094b234dce6e03f10a5b673c1d8c69739a00",
  "0x527653ea119f3e6a1f5bd18fbf4714081d7b31ce",
  "0x58e8dcc13be9780fc42e8723d8ead4cf46943df2",
  "0x2fc93484614a34f26f7970cbb94615ba109bb4bf",
  "0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc",
  "0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936",
  "0x23773e65ed146a459791799d01336db287f25334",
  "0xd21be7248e0197ee08e0c20d4a96debdac3d20af",
  "0x610b717796ad172b316836ac95a2ffad065ceab4",
  "0x178169b423a011fff22b9e3f3abea13414ddd0f1",
  "0xbb93e510bbcd0b7beb5a853875f9ec60275cf498",
]);

const KV_KEY = "sanctions:v1";
// Per-isolate cache. The check runs on every request, so we must not hit KV
// each time; a few minutes of staleness on a deny list is an acceptable trade
// against adding a KV read to every single request.
const OVERLAY_TTL_MS = 5 * 60 * 1000;
let cache = { addresses: null, meta: null, loadedAt: 0 };

/** Test seam — drops the per-isolate cache. */
export function _resetSanctionsCache() {
  cache = { addresses: null, meta: null, loadedAt: 0 };
}

function normalise(a) {
  return typeof a === "string" ? a.trim().toLowerCase() : null;
}
const ADDR_RE = /^0x[0-9a-f]{40}$/;

async function overlay(env, now = Date.now()) {
  if (cache.addresses && now - cache.loadedAt < OVERLAY_TTL_MS) return cache;
  if (!env || !env.DEFI_CACHE) return { addresses: new Set(), meta: null, loadedAt: now };
  try {
    const raw = await env.DEFI_CACHE.get(KV_KEY, "json");
    const list = Array.isArray(raw?.addresses) ? raw.addresses : [];
    cache = {
      addresses: new Set(list.map(normalise).filter((a) => a && ADDR_RE.test(a))),
      meta: raw ? { updated_at: raw.updated_at || null, source: raw.source || null, count: list.length } : null,
      loadedAt: now,
    };
  } catch {
    // KV unavailable: fall back to the seed alone rather than failing open.
    cache = { addresses: new Set(), meta: null, loadedAt: now };
  }
  return cache;
}

/** True when the address is on the seed list or the KV overlay. */
export async function isSanctioned(addr, env) {
  const a = normalise(addr);
  if (!a) return false;
  if (SEED_ADDRESSES.has(a)) return true;          // enforced even if KV is down
  const o = await overlay(env);
  return o.addresses.has(a);
}

/** True when ANY of the addresses is sanctioned. */
export async function anySanctioned(addrs, env) {
  if (!Array.isArray(addrs) || !addrs.length) return false;
  for (const a of addrs) {
    const n = normalise(a);
    if (n && SEED_ADDRESSES.has(n)) return true;
  }
  const o = await overlay(env);
  if (!o.addresses.size) return false;
  return addrs.some((a) => {
    const n = normalise(a);
    return n ? o.addresses.has(n) : false;
  });
}

// A refresh that shrinks the list by more than this fraction is treated as a
// broken feed, not a real delisting. Real SDN removals are incremental; a
// collapse means a truncated download or an upstream outage.
const MAX_SHRINK_RATIO = 0.5;

/**
 * Pull SANCTIONS_FEED_URL into KV. Returns a result object rather than
 * throwing so the cron can log it and the admin panel can show it.
 *
 * Expected shape:  { "addresses": ["0x..", ...], "source": "…", "updated_at": … }
 * A bare JSON array is also accepted.
 */
export async function refreshSanctionsList(env, now = Date.now()) {
  // OFAC_LIST_URL is the name SECRETS.md has documented since Phase 4;
  // SANCTIONS_FEED_URL is accepted for operators pointing at a non-OFAC
  // provider (Chainalysis, TRM) so the variable name is not a lie.
  const url = env?.OFAC_LIST_URL || env?.SANCTIONS_FEED_URL;
  if (!url) return { ok: false, skipped: "no_feed_configured" };
  if (!env.DEFI_CACHE) return { ok: false, skipped: "kv_unavailable" };

  let payload;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return { ok: false, error: "feed_http_" + res.status };
    payload = await res.json();
  } catch (e) {
    return { ok: false, error: "feed_unreachable" };
  }

  const list = Array.isArray(payload) ? payload : payload?.addresses;
  if (!Array.isArray(list)) return { ok: false, error: "feed_malformed" };

  const clean = [...new Set(list.map(normalise).filter((a) => a && ADDR_RE.test(a)))];
  if (!clean.length) {
    // Never install an empty list over a working one.
    return { ok: false, error: "feed_empty", kept_previous: true };
  }

  const prev = await env.DEFI_CACHE.get(KV_KEY, "json").catch(() => null);
  const prevCount = Array.isArray(prev?.addresses) ? prev.addresses.length : 0;
  if (prevCount && clean.length < prevCount * MAX_SHRINK_RATIO) {
    return {
      ok: false, error: "feed_shrank_implausibly", kept_previous: true,
      previous_count: prevCount, incoming_count: clean.length,
    };
  }

  await env.DEFI_CACHE.put(KV_KEY, JSON.stringify({
    addresses: clean,
    source: (typeof payload?.source === "string" && payload.source) || url,
    updated_at: now,
  }));
  _resetSanctionsCache();
  return { ok: true, count: clean.length, previous_count: prevCount };
}

/**
 * What the admin panel needs to answer "is screening actually working?".
 * A configured feed that has not refreshed in over two days is reported as
 * stale — silence is the failure mode that matters here.
 */
const STALE_AFTER_MS = 48 * 60 * 60 * 1000;

export async function sanctionsStatus(env, now = Date.now()) {
  const o = await overlay(env, now);
  const configured = !!(env?.OFAC_LIST_URL || env?.SANCTIONS_FEED_URL);
  const updatedAt = o.meta?.updated_at || null;
  const stale = configured && (!updatedAt || now - updatedAt > STALE_AFTER_MS);
  return {
    seed_count: SEED_ADDRESSES.size,
    overlay_count: o.addresses ? o.addresses.size : 0,
    total_enforced: SEED_ADDRESSES.size + (o.addresses ? o.addresses.size : 0),
    feed_configured: configured,
    feed_source: o.meta?.source || null,
    updated_at: updatedAt,
    stale,
    // Screening is always on — the seed list guarantees it — but say plainly
    // whether it is running on seed alone.
    enforcing: true,
    seed_only: !o.addresses || o.addresses.size === 0,
  };
}

export { SEED_ADDRESSES, KV_KEY };
