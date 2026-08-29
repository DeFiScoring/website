// worker/handlers/protocols.js
// ----------------------------------------------------------------------------
// GET /api/protocols          -> full enriched catalog
// GET /api/protocols?slug=X   -> single protocol enriched
//
// Catalog enrichment = bundled metadata + live DeFiLlama TVL/audits/links.
// Cached 1h in KV. The legacy /api/score/:protocol endpoint in worker/index.js
// still works (different scoring formula) — this handler is the catalog-level
// counterpart for the new SPA (T7).
// ----------------------------------------------------------------------------

import { getCatalogWithMeta, getProtocolEnriched } from '../lib/protocols.js';

export async function handleProtocols(request, env, baseHeaders = {}) {
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug');
  const enrich = url.searchParams.get('enrich') !== '0'; // default true

  if (slug) {
    const p = await getProtocolEnriched(slug, env);
    if (!p) return jsonRes({ success: false, error: `unknown protocol: ${slug}` }, 404, baseHeaders);
    return jsonRes({ success: true, protocol: p }, 200, baseHeaders);
  }

  const { protocols, fetched_at, cached } = await getCatalogWithMeta(env, { enrich });
  return jsonRes({
    success: true,
    count: protocols.length,
    enriched: enrich,
    protocols,
    // When the TVL figures were actually read from upstream — NOT when this
    // response was assembled. A cached catalog is honestly reported as such.
    fetched_at: fetched_at || null,
    cached,
    timestamp: new Date().toISOString(),
  }, 200, baseHeaders);
}

function jsonRes(data, status, baseHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=600',
      ...baseHeaders,
    },
  });
}
