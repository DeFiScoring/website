// worker/lib/protocols.js
// ----------------------------------------------------------------------------
// Protocols catalog with optional DeFiLlama enrichment. The bundled catalog
// (PROTOCOLS) is the source of truth for slug/category/contracts; DeFiLlama
// adds live TVL + per-chain TVL when a slug match exists.
//
// Cached 1h in KV — DeFiLlama TVL doesn't move fast enough to need a tighter
// window, and an hourly TTL bounds DeFiLlama traffic to ~24 calls/day even
// if the catalog endpoint is hot.
// ----------------------------------------------------------------------------

import { PROTOCOLS, PROTOCOLS_BY_SLUG, RISK_PROFILES } from './protocols-data.js';
import { cacheGet, cacheSet } from './cache.js';

const DEFILLAMA_PROTOCOL = 'https://api.llama.fi/protocol/';
const CATALOG_CACHE_TTL = 3600; // 1h

async function fetchDefillamaTvl(slug) {
  try {
    const r = await fetch(DEFILLAMA_PROTOCOL + encodeURIComponent(slug), {
      headers: { accept: 'application/json' },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return {
      tvlUsd:      Number(j.tvl ?? 0),
      chainTvls:   j.chainTvls || {},
      audits:      Number(j.audits ?? 0),
      auditLinks:  j.audit_links || [],
      url:         j.url || null,
      twitter:     j.twitter || null,
      description: j.description || null,
      logo:        j.logo || null,
    };
  } catch { return null; }
}

// Public: enriched single-protocol record. Catalog row + live TVL/audits.
export async function getProtocolEnriched(slug, env) {
  const base = PROTOCOLS_BY_SLUG.get(slug);
  if (!base) return null;
  const cacheKey = `protocol:${slug}:v1`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return cached;
  const tvl = await fetchDefillamaTvl(slug);
  const enriched = { ...base, defillama: tvl };
  await cacheSet(env, cacheKey, enriched, CATALOG_CACHE_TTL);
  return enriched;
}

// Public: full catalog, optionally enriched. enrichLimit caps how many
// concurrent DeFiLlama lookups happen (the catalog has ~15 entries today,
// so all-at-once is fine, but the cap exists so a future 200-protocol
// catalog doesn't fan out 200 HTTPs simultaneously).
/**
 * Returns the catalog plus WHEN its TVL figures were actually fetched.
 *
 * The handler used to stamp `new Date()` on every response, so an hour-old
 * cached catalog was presented as if it had just been read. For a tool people
 * make decisions with, a timestamp that always says "now" is worse than none:
 * it converts "we do not know how fresh this is" into a false claim of
 * freshness. `fetched_at` travels with the cached payload so it survives the
 * cache and reports the truth.
 */
export async function getCatalogWithMeta(env, opts = {}) {
  const { enrich = true, enrichLimit = 20 } = opts;
  const cacheKey = `catalog:enriched:v1`;
  if (enrich) {
    const cached = await cacheGet(env, cacheKey);
    if (cached && cached.protocols) {
      return { protocols: cached.protocols, fetched_at: cached.fetched_at, cached: true };
    }
    // Payload written before this field existed: report unknown, never now.
    if (Array.isArray(cached)) return { protocols: cached, fetched_at: null, cached: true };
  }
  if (!enrich) return { protocols: PROTOCOLS, fetched_at: null, cached: false };

  const fresh = await enrichAll(env, enrichLimit);
  const fetched_at = Date.now();
  await cacheSet(env, cacheKey, { protocols: fresh, fetched_at }, CATALOG_CACHE_TTL);
  return { protocols: fresh, fetched_at, cached: false };
}

async function enrichAll(env, enrichLimit) {
  const out = [];
  for (let i = 0; i < PROTOCOLS.length; i += enrichLimit) {
    const slice = PROTOCOLS.slice(i, i + enrichLimit);
    const enriched = await Promise.all(slice.map(async (p) => {
      const tvl = await fetchDefillamaTvl(p.slug);
      return { ...p, defillama: tvl };
    }));
    out.push(...enriched);
  }
  return out;
}

export async function getCatalog(env, { enrich = true, enrichLimit = 20 } = {}) {
  const r = await getCatalogWithMeta(env, { enrich, enrichLimit });
  return r.protocols;
}

async function getCatalogLegacy(env, { enrich = true, enrichLimit = 20 } = {}) {
  const cacheKey = `catalog:enriched:v1`;
  if (enrich) {
    const cached = await cacheGet(env, cacheKey);
    if (cached) return cached;
  }
  if (!enrich) return PROTOCOLS;

  // Process in chunks to bound concurrency.
  const out = [];
  for (let i = 0; i < PROTOCOLS.length; i += enrichLimit) {
    const slice = PROTOCOLS.slice(i, i + enrichLimit);
    const enriched = await Promise.all(slice.map(async (p) => {
      const tvl = await fetchDefillamaTvl(p.slug);
      return { ...p, defillama: tvl };
    }));
    out.push(...enriched);
  }
  await cacheSet(env, cacheKey, out, CATALOG_CACHE_TTL);
  return out;
}

// Public: re-export risk profiles so handlers can resolve `?profile=` params
// without importing from -data.js directly.
export { RISK_PROFILES };
