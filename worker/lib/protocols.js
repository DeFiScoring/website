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
export async function getCatalog(env, { enrich = true, enrichLimit = 20 } = {}) {
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
