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
  // Empty objects ARE truthy in JS — never serve a cached empty as a hit.
  // A real "no tokens are priced" response is rare and cheap to recompute,
  // and caching empties traps the wallet at $0 for 60s.
  if (cached && Object.keys(cached).length > 0) return cached;

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
// ----------------------------------------------------------------------------
// Token pricing with fallbacks. Real-world failure modes we cover:
//   - CoinGecko `/simple/token_price/<chain>?contract=<addr>` returns {} when
//     the token isn't in their per-chain index (extremely common on Polygon
//     for migrated/bridged tokens like RNDR→RENDER).
//   - Free-tier rate limits intermittently 429.
//
// Fallback order:
//   1. CoinGecko per-chain by contract           (cheapest, batched)
//   2. CoinGecko by symbol-to-id lookup          (one /search per token, capped)
//   3. DefiLlama coins.llama.fi by chain:contract (free, no auth, batched)
//
// Returns { [contract]: { [fiat]: number } } with lowercased keys, identical
// shape to priceTokens() so callers don't have to branch on which tier won.
// ----------------------------------------------------------------------------

const LLAMA_PRICES = 'https://coins.llama.fi/prices/current';

// CoinGecko-id cache for symbol lookups. Bounded; keyed by uppercased symbol.
async function cgIdForSymbol(env, symbol) {
  if (!symbol) return null;
  const sym = String(symbol).toUpperCase();
  const ck = `px:cgid:${sym}`;
  const cached = await cacheGet(env, ck);
  if (cached !== null && cached !== undefined) return cached || null;
  try {
    const url = `${cgBase(env)}/search?query=${encodeURIComponent(sym)}`;
    const r = await fetch(url, { headers: cgHeaders(env) });
    if (!r.ok) return null;
    const j = await r.json();
    const hit = (j.coins || []).find((c) => String(c.symbol || '').toUpperCase() === sym);
    const id = hit?.id || '';
    // Cache empty results too (24h) to avoid hot-spot retries on UNKNOWN/spam.
    await cacheSet(env, ck, id, 86400);
    return id || null;
  } catch { return null; }
}

async function priceBySymbols(env, tokens, fiat) {
  const fiatLow = String(fiat).toLowerCase();
  // Resolve symbol → CoinGecko id (parallel, but cap to 10 to avoid 429).
  const slice = tokens.slice(0, 10);
  const ids = await Promise.all(slice.map((t) => cgIdForSymbol(env, t.symbol)));
  const idToContracts = {};
  slice.forEach((t, i) => {
    const id = ids[i];
    if (!id) return;
    (idToContracts[id] = idToContracts[id] || []).push(t.contract.toLowerCase());
  });
  const idList = Object.keys(idToContracts);
  if (!idList.length) return {};
  const url = `${cgBase(env)}/simple/price?ids=${idList.join(',')}&vs_currencies=${fiatLow}`;
  try {
    const r = await fetch(url, { headers: cgHeaders(env) });
    if (!r.ok) return {};
    const j = await r.json();
    const out = {};
    for (const id of idList) {
      const px = j[id]?.[fiatLow];
      if (px == null) continue;
      for (const c of idToContracts[id]) {
        out[c] = { [fiatLow]: px };
      }
    }
    return out;
  } catch { return {}; }
}

// USD→<fiat> cross-rate, cached. DefiLlama quotes in USD only, so every
// non-USD portfolio needs one. This used to be refetched on every call (and
// with a `cacheGet` whose result was assigned to an unused variable), which
// meant an 11-chain scan in EUR spent 11 subrequests re-asking CoinGecko for
// the same number.
async function usdToFiatRate(env, fiatLow) {
  if (fiatLow === 'usd') return 1;
  const ck = `px:fx:usd:${fiatLow}`;
  const cached = await cacheGet(env, ck);
  if (typeof cached === 'number' && cached > 0) return cached;
  try {
    const r = await fetch(`${cgBase(env)}/simple/price?ids=usd-coin&vs_currencies=${fiatLow}`,
      { headers: cgHeaders(env) });
    if (!r.ok) return 1;
    const j = await r.json();
    const rate = Number(j['usd-coin']?.[fiatLow]) || 0;
    if (rate > 0) {
      await cacheSet(env, ck, rate, 600);
      return rate;
    }
  } catch { /* fall through */ }
  return 1;
}

async function priceByLlama(chain, env, tokens, fiat) {
  if (!chain.defillama || !tokens.length) return {};
  const fiatLow = String(fiat).toLowerCase();
  const keys = tokens.map((t) => `${chain.defillama}:${t.contract.toLowerCase()}`);
  const url = `${LLAMA_PRICES}/${keys.join(',')}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return {};
    const j = await r.json();
    const coins = j.coins || {};
    const usdToFiat = await usdToFiatRate(env, fiatLow);
    const out = {};
    for (const [k, v] of Object.entries(coins)) {
      const contract = k.split(':')[1]?.toLowerCase();
      if (!contract || typeof v?.price !== 'number') continue;
      out[contract] = { [fiatLow]: v.price * usdToFiat };
    }
    return out;
  } catch { return {}; }
}

// Native-coin prices from DefiLlama, keyed by CoinGecko id. Same shape as the
// CoinGecko /simple/price response so it can be merged straight in.
async function nativesByLlama(env, fiatLow, ids) {
  if (!ids.length) return {};
  const url = `${LLAMA_PRICES}/${ids.map((id) => `coingecko:${id}`).join(',')}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return {};
    const j = await r.json();
    const coins = j.coins || {};
    const usdToFiat = await usdToFiatRate(env, fiatLow);
    const out = {};
    for (const [k, v] of Object.entries(coins)) {
      const id = k.slice('coingecko:'.length);
      if (!id || typeof v?.price !== 'number') continue;
      out[id] = { [fiatLow]: v.price * usdToFiat };
    }
    return out;
  } catch { return {}; }
}

export async function priceTokensWithFallback(chain, env, tokens, fiat) {
  if (!tokens || !tokens.length) return {};
  const fiatLow = String(fiat || 'USD').toLowerCase();

  // Tier 1 — CoinGecko by contract (existing path).
  const contracts = tokens.map((t) => (t.contract || '').toLowerCase()).filter(Boolean);
  const tier1 = await priceTokens(chain, env, contracts, fiat).catch(() => ({}));
  const have = (c) => tier1[c.toLowerCase()] && Number(tier1[c.toLowerCase()][fiatLow]) > 0;

  // Tier 2 — by symbol for tokens still unpriced.
  const missing2 = tokens.filter((t) => t.contract && !have(t.contract));
  const tier2 = missing2.length ? await priceBySymbols(env, missing2, fiat).catch(() => ({})) : {};

  // Tier 3 — DefiLlama for what's still missing.
  const merged2 = { ...tier1, ...tier2 };
  const missing3 = tokens.filter((t) => t.contract && !(merged2[t.contract.toLowerCase()] && Number(merged2[t.contract.toLowerCase()][fiatLow]) > 0));
  const tier3 = missing3.length ? await priceByLlama(chain, env, missing3, fiat).catch(() => ({})) : {};

  return { ...tier1, ...tier2, ...tier3 };
}

export async function priceMultipleNatives(env, fiat, ids) {
  const fiatLow = String(fiat || 'USD').toLowerCase();
  const idList = Array.from(new Set(ids)).sort();
  if (!idList.length) return {};
  const cacheKey = `px:natives:${fiatLow}:${idList.join(',')}`;
  const cached = await cacheGet(env, cacheKey);
  // Same empty-cache guard as priceTokens. A native-price miss costs us
  // showing $0 for the chain header — strictly worse than refetching.
  if (cached && Object.keys(cached).length > 0) return cached;

  let out = {};
  const url = `${cgBase(env)}/simple/price?ids=${idList.join(',')}&vs_currencies=${fiatLow}`;
  try {
    const r = await fetch(url, { headers: cgHeaders(env) });
    if (r.ok) {
      const j = await r.json();
      if (j && typeof j === 'object') out = j;
    }
  } catch { /* fall through to the DefiLlama tier */ }

  // ERC-20s already had a three-tier price fallback; native coins had none, so
  // a single CoinGecko 429 (routine on the keyless free tier) priced ETH at 0
  // and the whole wallet reported $0 — which then made the portfolio_health
  // pillar report `real: false` and quietly dropped 25% of the score to a
  // neutral 50. Fill whatever CoinGecko missed from DefiLlama.
  const missing = idList.filter((id) => !(Number(out[id]?.[fiatLow]) > 0));
  if (missing.length) {
    const llama = await nativesByLlama(env, fiatLow, missing).catch(() => ({}));
    out = { ...out, ...llama };
  }

  if (Object.keys(out).length > 0) {
    await cacheSet(env, cacheKey, out, PRICE_TTL);
  }
  return out;
}
