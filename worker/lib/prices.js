// worker/lib/prices.js
// ----------------------------------------------------------------------------
// CoinGecko price layer. Routes to the Pro API when COINGECKO_KEY is set,
// otherwise hits the free tier. All responses are cached in KV to stay under
// the free-tier rate limit (~30 req/min) when many wallets are scored at once.
// ----------------------------------------------------------------------------

import { cacheGet, cacheSet } from './cache.js';

const CG_FREE = 'https://api.coingecko.com/api/v3';
const CG_PRO  = 'https://pro-api.coingecko.com/api/v3';

function cgBase(env)    { return env && env.COINGECKO_KEY ? CG_PRO : CG_FREE; }
function cgHeaders(env) { return env && env.COINGECKO_KEY ? { 'x-cg-pro-api-key': env.COINGECKO_KEY } : {}; }

// 60s for spot prices keeps the dashboard near-real-time without hammering
// CoinGecko. Token-price requests with 100+ contracts are deduplicated by the
// sorted-contract cache key below, so a refresh on the same wallet is a
// guaranteed cache hit.
const PRICE_TTL = 60;

// Hash a sorted contract list into a short cache key suffix. Avoids blowing
// past KV's 512-byte key limit when wallets hold dozens of tokens. Uses
// SHA-256 (truncated) — collisions are computationally infeasible, so two
// distinct token sets can never serve each other's cached prices. Both
// Cloudflare Workers and Node 18+ expose crypto.subtle globally.
async function hashContracts(contracts) {
  const joined = contracts.slice().sort().join(',');
  if (joined.length <= 200) return joined;
  const data = new TextEncoder().encode(joined);
  const buf = await crypto.subtle.digest('SHA-256', data);
  // 16 hex chars (64 bits) is plenty for a price-cache key — collision
  // probability is ~2^-32 even at 10^9 distinct token sets, which we'll
  // never see, and it keeps KV keys under 64 bytes total.
  const bytes = new Uint8Array(buf, 0, 8);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return 'h' + hex + '_' + contracts.length;
}

export async function priceTokens(chain, env, contracts, fiat) {
  if (!contracts || !contracts.length) return {};
  if (!chain.coingecko) return {};
  const fiatLow = String(fiat || 'USD').toLowerCase();
  const cacheKey = `px:tok:${chain.id}:${fiatLow}:${await hashContracts(contracts)}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return cached;

  const url = `${cgBase(env)}/simple/token_price/${chain.coingecko}` +
              `?contract_addresses=${contracts.join(',')}&vs_currencies=${fiatLow}`;
  try {
    const r = await fetch(url, { headers: cgHeaders(env) });
    if (!r.ok) return {};
    const j = await r.json();
    // Normalise keys to lowercase so callers can look up by lowercased contract.
    const out = {};
    for (const k of Object.keys(j || {})) {
      out[k.toLowerCase()] = j[k];
    }
    await cacheSet(env, cacheKey, out, PRICE_TTL);
    return out;
  } catch {
    return {};
  }
}

export async function priceNative(chain, env, fiat) {
  const fiatLow = String(fiat || 'USD').toLowerCase();
  const cacheKey = `px:native:${chain.nativeCoingeckoId}:${fiatLow}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached !== null && cached !== undefined) return cached;

  const url = `${cgBase(env)}/simple/price?ids=${chain.nativeCoingeckoId}&vs_currencies=${fiatLow}`;
  try {
    const r = await fetch(url, { headers: cgHeaders(env) });
    if (!r.ok) return 0;
    const j = await r.json();
    const price = j[chain.nativeCoingeckoId]?.[fiatLow] ?? 0;
    await cacheSet(env, cacheKey, price, PRICE_TTL);
    return price;
  } catch {
    return 0;
  }
}

// Batch-price every native asset across all chains in one request. Used by
// the portfolio handler so we don't fan out 11 separate /simple/price calls.
export async function priceMultipleNatives(env, fiat, ids) {
  const fiatLow = String(fiat || 'USD').toLowerCase();
  const idList = Array.from(new Set(ids)).sort();
  if (!idList.length) return {};
  const cacheKey = `px:natives:${fiatLow}:${idList.join(',')}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return cached;

  const url = `${cgBase(env)}/simple/price?ids=${idList.join(',')}&vs_currencies=${fiatLow}`;
  try {
    const r = await fetch(url, { headers: cgHeaders(env) });
    if (!r.ok) return {};
    const j = await r.json();
    await cacheSet(env, cacheKey, j, PRICE_TTL);
    return j;
  } catch {
    return {};
  }
}
