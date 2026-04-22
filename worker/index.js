/**
 * DeFiScoring – Risk Profiler Worker
 *
 * Routes:
 *   POST /                       -> AI risk profile (cached in PROFILE_CACHE)
 *   POST /profile                -> alias of POST /
 *   GET  /onchain/:wallet        -> Etherscan V2 multichain history (Eth/Arb/Polygon)
 *   GET  /api/score/:protocol    -> DeFiLlama+Etherscan composite score (cached 6h in DEFI_CACHE)
 *   POST /api/exposure           -> { wallet } -> wallet's contract interactions matched against
 *                                   the published protocol catalog + per-protocol risk score
 *   POST /api/audit              -> { address, chain_id? } -> AI-generated source-code audit
 *                                   (follows proxies, truncates large source, cached 30d)
 *   POST /api/health-score       -> { wallet } -> 300..850 DeFi health score with breakdown +
 *                                   trend history (D1-backed)
 *   GET  /api/health-score/:wallet/history?limit=N -> historical scores for trend chart
 *   GET  /health                 -> { ok, bindings: {...} }
 *
 * Bindings (see wrangler.toml):
 *   env.AI                       – Workers AI (Llama 3.1)
 *   env.PROFILE_CACHE            – KV: AI response cache
 *   env.DEFI_CACHE               – KV: DeFiLlama protocol score cache (6h)
 *   env.CACHE_TTL_SECONDS        – var, default "600"  (AI cache)
 *   env.SCORE_CACHE_TTL_SECONDS  – var, default "21600" (protocol cache, 6h)
 *   env.ETHERSCAN_API_KEY        – secret
 */

// ---------------------------------------------------------------------------
// CORS — origin allowlist driven by env.ALLOWED_ORIGINS (comma-separated).
// "*" is still supported for transitional/dev use, but as soon as a session
// cookie ships (Phase 2), the deploy must set an explicit allowlist because
// `Access-Control-Allow-Credentials: true` is incompatible with a wildcard
// origin.
//
// We always echo the matched origin (not "*") and add `Vary: Origin` so any
// cache layer keys responses correctly.
// ---------------------------------------------------------------------------
const BASE_CORS = {
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
};
function parseAllowedOrigins(env) {
  const raw = String(env && env.ALLOWED_ORIGINS || "").trim();
  if (!raw || raw === "*") return ["*"];
  return raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}
function corsHeadersFor(request, env) {
  const allowed = parseAllowedOrigins(env);
  const origin = request.headers.get("Origin") || "";
  const out = { ...BASE_CORS };
  if (allowed.includes("*")) {
    out["Access-Control-Allow-Origin"] = "*";
  } else if (origin && allowed.includes(origin)) {
    out["Access-Control-Allow-Origin"] = origin;
  } else {
    // Unknown origin: still safe to omit the header (browser blocks the read).
    // Same-origin requests (no Origin header) are unaffected.
    if (!origin) out["Access-Control-Allow-Origin"] = allowed[0] || "*";
  }
  return out;
}
// Legacy export kept for the few code paths that don't have request/env yet.
// All new handlers should go through corsHeadersFor(request, env).
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  ...BASE_CORS,
};

// ---------------------------------------------------------------------------
// Security headers applied to every response (HTML and API).
//
// CSP allows the specific external origins the dashboard actually uses
// (jsdelivr + unpkg for chart.js / jspdf / lucide, Google Fonts) and the
// upstream APIs called from the browser. `'unsafe-inline'` is still required
// for the inline JSON-LD blocks and small inline bootstrap scripts; a
// nonce-based hardening pass is queued as a follow-up to Phase 1.
// ---------------------------------------------------------------------------
// connect-src must list every origin the dashboard JS can fetch directly:
//   - the worker itself (API)
//   - Etherscan v2 + DeFiLlama + Snapshot (some calls go direct from browser)
//   - CoinGecko (assets/js/defi-onchain.js, assets/js/market-strip.js)
//   - Public RPC endpoints used as fallbacks (assets/js/defi-onchain.js)
//   - LiveReload websocket (dev only) — covered by 'self' on localhost
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' " +
    "https://defiscoring.guillaumelauzier.workers.dev " +
    "https://api.etherscan.io " +
    "https://api.llama.fi " +
    "https://hub.snapshot.org " +
    "https://api.coingecko.com " +
    "https://ethereum-rpc.publicnode.com " +
    "https://eth.llamarpc.com " +
    "https://arb1.arbitrum.io " +
    "https://polygon-rpc.com " +
    "wss:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

const SECURITY_HEADERS = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy":
    "geolocation=(), microphone=(), camera=(), payment=(), usb=(), interest-cohort=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-site",
  "Content-Security-Policy": CSP,
};

function applySecurityHeaders(response) {
  // Workers Response headers are immutable on the original; clone if needed.
  const h = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!h.has(k)) h.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: h,
  });
}

// Final outgoing response middleware. Applied to *every* response by the
// fetch() entrypoint so we don't have to plumb (request, env) into every
// handler / json() helper. Order matters: CORS overrides must run AFTER
// handlers (which may have set the legacy wildcard via the json() helper)
// so the request-aware allowlist wins.
function finalizeResponse(response, request, env) {
  const cors = corsHeadersFor(request, env);
  const h = new Headers(response.headers);
  // Override any legacy wildcard CORS the handler may have stamped on.
  for (const [k, v] of Object.entries(cors)) h.set(k, v);
  // Add security headers (HSTS, CSP, XFO, etc.) where missing.
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!h.has(k)) h.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: h,
  });
}

// ---------------------------------------------------------------------------
// Phase 4 — short, machine-readable disclaimer attached to every scoring
// response (full text lives at /disclaimer/). Imported by `withDisclaimer()`
// below so any handler that returns a score / risk profile / audit can stamp
// it onto the JSON body without the dashboard having to re-fetch it.
// ---------------------------------------------------------------------------
const DISCLAIMER_TEXT =
  "Not financial advice. DeFi Scoring outputs are research opinions, " +
  "not audits and not investment guidance. See https://defiscoring.com/disclaimer/.";

function withDisclaimer(payload) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return { ...payload, disclaimer: DISCLAIMER_TEXT };
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Phase 4 — OFAC SDN block list.
//
// This is a fail-closed, deny-list check applied to every wallet address
// that crosses the worker boundary (request URL or POST body). Matches
// return a deliberately *generic* 403 ("Request blocked.") with no detail
// about why, so an attacker can't probe the list.
//
// SOURCING: This starter set covers the well-known sanctioned ETH addresses
// from the August 2022 Tornado Cash OFAC action plus a handful of historical
// SDN designations. It is intentionally short and conservative; production
// deployments should swap this for a live feed (OFAC SDN XML, Chainalysis,
// or TRM) loaded into KV at boot. The interface (`isSanctioned`) does not
// change — only the source of `SANCTIONED_ADDRESSES`.
// ---------------------------------------------------------------------------
const SANCTIONED_ADDRESSES = new Set([
  // Tornado Cash – OFAC SDN List, Aug 8 2022
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

function isSanctioned(addr) {
  if (!addr || typeof addr !== "string") return false;
  return SANCTIONED_ADDRESSES.has(addr.toLowerCase());
}

// Collect EVERY 0x… address that appears anywhere in the request — URL
// path, every query-param value, and recursively every string in the JSON
// body. We return an array (lowercased, deduplicated) so the sanctions
// check can scan all of them and the per-address rate limiter has a
// stable identity to key on. Reads request.clone() so the original body
// stays consumable by handlers.
async function extractAddressesFromRequest(request) {
  const ADDR_RE_GLOBAL = /0x[a-fA-F0-9]{40}/g;
  const found = new Set();
  const pushFromString = (s) => {
    if (typeof s !== "string") return;
    const m = s.match(ADDR_RE_GLOBAL);
    if (m) for (const a of m) found.add(a.toLowerCase());
  };
  try {
    const url = new URL(request.url);
    pushFromString(url.pathname);
    for (const v of url.searchParams.values()) pushFromString(v);
  } catch { /* fall through */ }
  if (request.method === "POST" || request.method === "PUT" || request.method === "PATCH") {
    try {
      const body = await request.clone().json();
      const walk = (node, depth) => {
        if (depth > 6 || node == null) return;
        if (typeof node === "string") return pushFromString(node);
        if (Array.isArray(node)) { for (const x of node) walk(x, depth + 1); return; }
        if (typeof node === "object") { for (const k of Object.keys(node)) walk(node[k], depth + 1); }
      };
      walk(body, 0);
    } catch { /* not JSON, ignore */ }
  }
  return Array.from(found);
}

// Back-compat single-address helper. Returns the FIRST address found, or
// null. Keep callers that only want a stable per-request identity (rate
// limiter) using this; sanctions enforcement uses the full set above.
async function extractAddressFromRequest(request) {
  const all = await extractAddressesFromRequest(request);
  return all.length ? all[0] : null;
}

// ---------------------------------------------------------------------------
// KV-backed sliding-window rate limiter for expensive endpoints (AI calls,
// GitHub issue creation, telemetry ingest). Returns null if allowed, or a
// 429 Response if not. Uses DEFI_CACHE so we don't need a new binding.
//
// Two flavours:
//   • rateLimit()           — keys on (path, IP)
//   • rateLimitByAddress()  — keys on (path, normalized wallet address)
// Call BOTH at the entry of any address-aware endpoint to defend against
// botnets that rotate IPs but reuse a wallet, AND single hosts hammering
// many wallets.
// ---------------------------------------------------------------------------
async function rateLimit(request, env, key, max, windowSec) {
  if (!env.DEFI_CACHE) return null;            // fail open if KV unavailable
  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For") ||
    "anon";
  const bucket = "rl:" + key + ":ip:" + ip;
  const now = Math.floor(Date.now() / 1000);
  let count = 0;
  try {
    const cur = await env.DEFI_CACHE.get(bucket);
    count = cur ? parseInt(cur, 10) || 0 : 0;
  } catch { /* fail open */ }
  if (count >= max) {
    const cors = corsHeadersFor(request, env);
    return new Response(
      JSON.stringify({ success: false, error: "Rate limit exceeded. Try again shortly." }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(windowSec),
          ...cors,
        },
      }
    );
  }
  // Best-effort increment; KV is eventually-consistent so this isn't atomic
  // but it's good enough for spam mitigation.
  try {
    await env.DEFI_CACHE.put(bucket, String(count + 1), { expirationTtl: windowSec });
  } catch { /* fail open */ }
  return null;
}

async function rateLimitByAddress(request, env, addr, key, max, windowSec) {
  if (!env.DEFI_CACHE || !addr) return null;
  const bucket = "rl:" + key + ":addr:" + addr.toLowerCase();
  let count = 0;
  try {
    const cur = await env.DEFI_CACHE.get(bucket);
    count = cur ? parseInt(cur, 10) || 0 : 0;
  } catch { /* fail open */ }
  if (count >= max) {
    const cors = corsHeadersFor(request, env);
    return new Response(
      JSON.stringify({ success: false, error: "Rate limit exceeded for this address. Try again shortly." }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(windowSec),
          ...cors,
        },
      }
    );
  }
  try {
    await env.DEFI_CACHE.put(bucket, String(count + 1), { expirationTtl: windowSec });
  } catch { /* fail open */ }
  return null;
}

const ETHERSCAN_V2 = "https://api.etherscan.io/v2/api";
const DEFILLAMA = "https://api.llama.fi";
const CHAIN_IDS = { ethereum: 1, arbitrum: 42161, polygon: 137 };
const CHAIN_NAME_TO_ID = {
  Ethereum: 1, Arbitrum: 42161, Polygon: 137, "Polygon zkEVM": 1101,
  Optimism: 10, Base: 8453, BSC: 56, Avalanche: 43114, Fantom: 250,
};

function json(data, status = 200) {
  // Phase 4: stamp the disclaimer onto every successful scoring-shaped
  // response. We detect by field name rather than by route so admin tools
  // that call internal helpers also pick it up. Errors and non-scoring
  // success payloads (watchlist confirmations, consent acks, etc.) are
  // left alone so the field doesn't appear in places it would only confuse.
  let body = data;
  if (
    data && typeof data === "object" && !Array.isArray(data) && data.success === true && (
      "score" in data || "scores" in data || "profile" in data || "audit" in data ||
      "breakdown" in data || "riskProfile" in data || "history" in data
    )
  ) {
    body = { ...data, disclaimer: DISCLAIMER_TEXT };
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ----------------------------- AI risk profile ----------------------------- */

async function handleProfile(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ success: false, error: "Invalid JSON" }, 400); }

  const { wallet, deFiScore, recentActivity } = body;
  if (!wallet || deFiScore == null) {
    return json({ success: false, error: "wallet and deFiScore are required" }, 400);
  }

  const cacheKey = "profile:" + (await sha256(wallet + "|" + deFiScore + "|" + (recentActivity || "")));
  if (env.PROFILE_CACHE) {
    const hit = await env.PROFILE_CACHE.get(cacheKey, "json");
    if (hit) return json({ success: true, profile: hit, cached: true, timestamp: new Date().toISOString() });
  }

  let aiResponse;
  try {
    aiResponse = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
      messages: [
        {
          role: "system",
          content:
            "You are a senior DeFi risk advisor. Analyze the user's wallet data and give a concise risk profile + 3-5 tailored crypto project recommendations.\n" +
            "Output ONLY valid JSON in this exact format (no extra text, no markdown fences):\n" +
            "{\n" +
            "  \"riskProfile\": \"Conservative / Moderate / Aggressive\",\n" +
            "  \"summary\": \"short 2-3 sentence summary\",\n" +
            "  \"recommendations\": [\n" +
            "    { \"project\": \"project name\", \"reason\": \"why it fits this user\", \"riskLevel\": \"Low/Medium/High\" }\n" +
            "  ]\n" +
            "}",
        },
        {
          role: "user",
          content:
            "Wallet address: " + wallet + "\n" +
            "DeFi Credit Score: " + deFiScore + "/850\n" +
            "Recent activity summary: " + (recentActivity || "No activity provided"),
        },
      ],
      max_tokens: 800,
      temperature: 0.7,
    });
  } catch (e) {
    return json({ success: false, error: "AI call failed: " + e.message }, 502);
  }

  const raw = (aiResponse && (aiResponse.response || aiResponse)) || "";
  let profile;
  try {
    const cleaned = String(raw).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    profile = JSON.parse(cleaned);
  } catch {
    profile = {
      riskProfile: "Moderate",
      summary: "AI returned non-JSON output. Please retry.",
      recommendations: [],
      _raw: typeof raw === "string" ? raw.slice(0, 500) : null,
    };
  }

  if (env.PROFILE_CACHE && profile.recommendations && profile.recommendations.length) {
    const ttl = Number(env.CACHE_TTL_SECONDS || "600");
    await env.PROFILE_CACHE.put(cacheKey, JSON.stringify(profile), { expirationTtl: ttl });
  }

  return json({ success: true, profile, cached: false, timestamp: new Date().toISOString() });
}

/* --------------------------- Etherscan multichain -------------------------- */

async function etherscanCall(env, chainId, params) {
  if (!env.ETHERSCAN_API_KEY) throw new Error("ETHERSCAN_API_KEY not configured");
  const url = new URL(ETHERSCAN_V2);
  url.searchParams.set("chainid", String(chainId));
  url.searchParams.set("apikey", env.ETHERSCAN_API_KEY);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error("Etherscan HTTP " + res.status);
  const data = await res.json();
  if (data.status === "0" && data.message !== "No transactions found") {
    throw new Error("Etherscan: " + (data.result || data.message));
  }
  return data.result;
}

// CoinGecko platform IDs for the chains in CHAIN_IDS — used to batch-price
// ERC-20 tokens by contract address. Keys must match the CHAIN_IDS values.
const COINGECKO_PLATFORM = { 1: "ethereum", 42161: "arbitrum-one", 137: "polygon-pos" };

// ERC-20 balanceOf(address) selector. Used with Etherscan's proxy/eth_call to
// read current token balances without needing a separate RPC binding.
const ERC20_BALANCE_OF_SELECTOR = "0x70a08231";
function pad32Hex(addr) {
  return addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}
function hexToBigIntSafe(hex) {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]*$/.test(hex)) return 0n;
  return hex === "0x" || hex === "0x0" ? 0n : BigInt(hex);
}

// Read balanceOf(wallet) for a list of token contracts on a single chain.
// Sequential to stay under Etherscan's free-tier 5 calls/sec limit; for the
// typical EOA this is < 20 tokens. Failures on individual tokens are swallowed
// so one bad contract doesn't blank the whole portfolio.
async function getErc20BalancesViaEtherscan(env, chainId, wallet, tokens) {
  const out = [];
  const data = ERC20_BALANCE_OF_SELECTOR + pad32Hex(wallet);
  for (const t of tokens) {
    try {
      const hex = await etherscanCall(env, chainId, {
        module: "proxy", action: "eth_call",
        to: t.contract, data, tag: "latest",
      });
      const raw = hexToBigIntSafe(hex);
      if (raw === 0n) continue;
      const decimals = Math.max(0, Math.min(36, Number(t.decimals) || 18));
      const amount = Number(raw) / Math.pow(10, decimals);
      if (!Number.isFinite(amount) || amount === 0) continue;
      out.push({ ...t, balance_raw: raw.toString(), balance: amount });
    } catch (_e) { /* skip unreadable token */ }
  }
  return out;
}

// Best-effort CoinGecko price fetch — returns { contract: priceUsd }. Free
// tier is rate-limited; failures degrade to no-price, the dashboard still
// shows the token + amount.
async function getTokenPricesByContract(platform, contracts) {
  if (!platform || !contracts.length) return {};
  try {
    const url = "https://api.coingecko.com/api/v3/simple/token_price/" + platform +
      "?contract_addresses=" + contracts.join(",") + "&vs_currencies=usd";
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!res.ok) return {};
    const j = await res.json();
    const map = {};
    Object.keys(j || {}).forEach((k) => { if (j[k] && typeof j[k].usd === "number") map[k.toLowerCase()] = j[k].usd; });
    return map;
  } catch (_e) { return {}; }
}

async function handleOnchain(wallet, env) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return json({ success: false, error: "Invalid wallet address" }, 400);
  }
  const out = { wallet, chains: {} };
  for (const [name, chainId] of Object.entries(CHAIN_IDS)) {
    try {
      const [txs, tokenTxs] = await Promise.all([
        etherscanCall(env, chainId, { module: "account", action: "txlist", address: wallet, page: 1, offset: 100, sort: "desc" }),
        // Bumped from 100 -> 1000 so token discovery covers wallets with
        // moderate ERC-20 history. Etherscan caps a single page at 10000.
        etherscanCall(env, chainId, { module: "account", action: "tokentx", address: wallet, page: 1, offset: 1000, sort: "desc" }),
      ]);
      const txsArr = Array.isArray(txs) ? txs : [];
      const tokArr = Array.isArray(tokenTxs) ? tokenTxs : [];
      const uniqueContracts = new Set(txsArr.filter((t) => t.to).map((t) => t.to.toLowerCase()));
      const uniqueTokens = new Set(tokArr.map((t) => (t.contractAddress || "").toLowerCase()).filter(Boolean));
      const firstTx = txsArr.length ? Number(txsArr[txsArr.length - 1].timeStamp) * 1000 : null;
      const lastTx = txsArr.length ? Number(txsArr[0].timeStamp) * 1000 : null;

      // Build a deduped token catalog from tokentx (which conveniently carries
      // tokenName/tokenSymbol/tokenDecimal alongside contractAddress), then
      // read live balances for each. Drop tokens whose current balance is 0
      // so the heatmap isn't polluted by historical-only positions.
      const catalog = new Map();
      for (const t of tokArr) {
        const c = (t.contractAddress || "").toLowerCase();
        if (!c || catalog.has(c)) continue;
        catalog.set(c, {
          contract: c,
          symbol: t.tokenSymbol || "",
          name:   t.tokenName   || "",
          decimals: Number(t.tokenDecimal) || 18,
        });
      }
      const balances = await getErc20BalancesViaEtherscan(env, chainId, wallet, Array.from(catalog.values()));
      // Price lookup is best-effort; tokens without a price still surface
      // (with value_usd = 0) so the user sees them in the heatmap.
      const prices = await getTokenPricesByContract(COINGECKO_PLATFORM[chainId], balances.map((b) => b.contract));
      const tokens = balances.map((b) => {
        const price = prices[b.contract] || 0;
        return { ...b, price_usd: price, value_usd: b.balance * price };
      });

      out.chains[name] = {
        chain_id: chainId,
        tx_count: txsArr.length,
        token_tx_count: tokArr.length,
        unique_contracts: uniqueContracts.size,
        unique_tokens: uniqueTokens.size,
        first_tx_at: firstTx,
        last_tx_at: lastTx,
        wallet_age_days: firstTx ? Math.floor((Date.now() - firstTx) / 86400000) : 0,
        tokens, // current ERC-20 holdings with amount + USD value (best-effort)
      };
    } catch (e) {
      out.chains[name] = { chain_id: chainId, error: e.message };
    }
  }
  return json({ success: true, data: out, timestamp: new Date().toISOString() });
}

/* --------------------- DeFiLlama + Etherscan score ------------------------- */

async function getContractAgeDays(env, chainId, address) {
  try {
    // Get the very first tx from this contract. Etherscan returns oldest first when sort=asc, page=1, offset=1.
    const txs = await etherscanCall(env, chainId, {
      module: "account", action: "txlist", address, page: 1, offset: 1, sort: "asc",
      startblock: 0, endblock: 99999999,
    });
    if (!Array.isArray(txs) || !txs.length) return null;
    const first = Number(txs[0].timeStamp) * 1000;
    return Math.floor((Date.now() - first) / 86400000);
  } catch (e) {
    console.warn("contract age fetch failed:", e.message);
    return null;
  }
}

async function getSourceVerified(env, chainId, address) {
  try {
    const r = await etherscanCall(env, chainId, { module: "contract", action: "getsourcecode", address });
    if (!Array.isArray(r) || !r.length) return null;
    const item = r[0];
    return {
      verified: !!(item.SourceCode && item.SourceCode.length > 0),
      proxy: item.Proxy === "1",
      implementation: item.Implementation || null,
      contractName: item.ContractName || null,
    };
  } catch (e) {
    console.warn("source code fetch failed:", e.message);
    return null;
  }
}

function pickPrimaryContract(llamaProtocol) {
  // DeFiLlama returns either a top-level `address` ("ethereum:0x...") or per-chain addresses.
  if (llamaProtocol.address && typeof llamaProtocol.address === "string") {
    const [chain, addr] = llamaProtocol.address.split(":");
    if (chain && addr && /^0x[a-fA-F0-9]{40}$/.test(addr)) {
      const chainKey = chain.charAt(0).toUpperCase() + chain.slice(1).toLowerCase();
      const chainId = CHAIN_NAME_TO_ID[chainKey] || CHAIN_NAME_TO_ID[chain] || null;
      if (chainId) return { chainId, address: addr };
    }
  }
  return null;
}

function computeTrustScore({ ageDays, audits }) {
  // 0–100. Half from age, half from audits.
  const ageComponent = ageDays == null
    ? 0
    : Math.min(50, Math.round((Math.min(ageDays, 730) / 730) * 50)); // 2y caps
  const auditComponent = audits >= 2 ? 50 : audits === 1 ? 25 : 0;
  const value = ageComponent + auditComponent;
  return {
    value,
    breakdown: {
      age_days: ageDays,
      age_component: ageComponent,
      audit_count: audits,
      audit_component: auditComponent,
    },
  };
}

function computeLivenessScore({ tvl, mcap, tvlChange7d }) {
  // 0–100. 50 from tvl/mcap ratio (capped), 50 from 7d stability.
  let ratioComponent = 0;
  if (tvl && mcap && mcap > 0) {
    const ratio = tvl / mcap; // healthier protocols have higher locked-vs-cap
    ratioComponent = Math.min(50, Math.round(Math.min(ratio, 2) * 25));
  } else if (tvl && tvl > 0) {
    ratioComponent = 25; // partial credit when mcap unavailable
  }
  let stabilityComponent = 50;
  if (typeof tvlChange7d === "number") {
    if (tvlChange7d <= -20) stabilityComponent = 0;
    else if (tvlChange7d < 0) stabilityComponent = Math.round(50 + (tvlChange7d / 20) * 50);
    else stabilityComponent = 50;
  }
  const value = ratioComponent + stabilityComponent;
  return {
    value,
    breakdown: {
      tvl_usd: tvl,
      mcap_usd: mcap,
      tvl_mcap_ratio: tvl && mcap ? +(tvl / mcap).toFixed(3) : null,
      tvl_change_7d_pct: tvlChange7d,
      ratio_component: ratioComponent,
      stability_component: stabilityComponent,
    },
  };
}

function computeSecurityScore({ source }) {
  // 0–100. Real signals only: source verification + proxy detection.
  if (!source) {
    return { value: 0, breakdown: { detail: "Source code unavailable" }, real: false };
  }
  let value = 0;
  const parts = {};
  if (source.verified) { value += 60; parts.verified = 60; } else { parts.verified = 0; }
  // Non-proxy gets a stability bonus; proxies are upgradable -> moderate risk.
  if (!source.proxy) { value += 40; parts.non_proxy = 40; } else { parts.non_proxy = 0; }
  return {
    value,
    breakdown: { source_verified: source.verified, is_proxy: source.proxy, ...parts },
    real: true,
  };
}

function band(score) {
  if (score >= 80) return "green";
  if (score >= 50) return "yellow";
  return "red";
}

async function handleProtocolScore(slug, env) {
  if (!/^[a-z0-9-]+$/i.test(slug)) {
    return json({ success: false, error: "Invalid protocol slug" }, 400);
  }
  const cacheKey = "score:v1:" + slug.toLowerCase();
  if (env.DEFI_CACHE) {
    const hit = await env.DEFI_CACHE.get(cacheKey, "json");
    if (hit) return json({ ...hit, cached: true });
  }

  let llama;
  try {
    const res = await fetch(DEFILLAMA + "/protocol/" + encodeURIComponent(slug));
    if (!res.ok) {
      if (res.status === 404) return json({ success: false, error: "Protocol not found on DeFiLlama" }, 404);
      throw new Error("DeFiLlama HTTP " + res.status);
    }
    llama = await res.json();
  } catch (e) {
    return json({ success: false, error: "DeFiLlama fetch failed: " + e.message }, 502);
  }

  // TVL and 7d change
  const currentTvl = typeof llama.currentChainTvls === "object"
    ? Object.values(llama.currentChainTvls).reduce((a, b) => a + (typeof b === "number" ? b : 0), 0)
    : (typeof llama.tvl === "number" ? llama.tvl : null);
  let tvlChange7d = null;
  if (Array.isArray(llama.tvl) && llama.tvl.length >= 2) {
    const last = llama.tvl[llama.tvl.length - 1];
    const sevenAgo = llama.tvl[Math.max(0, llama.tvl.length - 8)];
    if (last && sevenAgo && sevenAgo.totalLiquidityUSD > 0) {
      tvlChange7d = +(((last.totalLiquidityUSD - sevenAgo.totalLiquidityUSD) / sevenAgo.totalLiquidityUSD) * 100).toFixed(2);
    }
  }
  const audits = Number(llama.audits || 0);
  const mcap = llama.mcap || null;

  // Resolve a primary contract for age + source-code checks.
  const primary = pickPrimaryContract(llama);
  let ageDays = null;
  let source = null;
  if (primary) {
    [ageDays, source] = await Promise.all([
      getContractAgeDays(env, primary.chainId, primary.address),
      getSourceVerified(env, primary.chainId, primary.address),
    ]);
  }

  const trust = computeTrustScore({ ageDays, audits });
  const liveness = computeLivenessScore({ tvl: currentTvl, mcap, tvlChange7d });
  const security = computeSecurityScore({ source });

  const composite = Math.round(0.4 * trust.value + 0.3 * liveness.value + 0.3 * security.value);

  const payload = {
    success: true,
    protocol: {
      slug,
      name: llama.name || slug,
      category: llama.category || null,
      url: llama.url || null,
      logo: llama.logo || null,
      contract: primary,
    },
    score: composite,
    band: band(composite),
    pillars: {
      trust:    { weight: 0.4, value: trust.value,    ...trust.breakdown },
      liveness: { weight: 0.3, value: liveness.value, ...liveness.breakdown },
      security: { weight: 0.3, value: security.value, real: security.real, ...security.breakdown },
    },
    methodology: "S = 0.4*Trust + 0.3*Liveness + 0.3*Security",
    sources: ["defillama", primary ? "etherscan" : null].filter(Boolean),
    cached: false,
    timestamp: new Date().toISOString(),
  };

  if (env.DEFI_CACHE) {
    const ttl = Number(env.SCORE_CACHE_TTL_SECONDS || "21600");
    await env.DEFI_CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: ttl });
  }
  return json(payload);
}

/* ------------------------- Wallet exposure scanner ------------------------- */

async function loadProtocolCatalog(env) {
  const url = env.PROTOCOL_CATALOG_URL;
  if (!url) throw new Error("PROTOCOL_CATALOG_URL not configured");
  const cacheKey = "catalog:v1:" + (await sha256(url));
  if (env.DEFI_CACHE) {
    const hit = await env.DEFI_CACHE.get(cacheKey, "json");
    if (hit) return hit;
  }
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("Catalog fetch HTTP " + res.status);
  const data = await res.json();
  if (!data || !Array.isArray(data.protocols)) throw new Error("Catalog malformed");
  if (env.DEFI_CACHE) {
    const ttl = Number(env.PROTOCOL_CATALOG_TTL_SECONDS || "3600");
    await env.DEFI_CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: ttl });
  }
  return data;
}

function buildContractIndex(catalog) {
  // chain_id -> Map(addressLower -> {slug, name, category, label, chain_id})
  const idx = {};
  catalog.protocols.forEach((p) => {
    (p.contracts || []).forEach((c) => {
      const cid = c.chain_id;
      const addr = (c.address || "").toLowerCase();
      if (!cid || !addr) return;
      if (!idx[cid]) idx[cid] = new Map();
      idx[cid].set(addr, { slug: p.slug, name: p.name, category: p.category, label: c.label, chain_id: cid });
    });
  });
  return idx;
}

async function getCachedScore(env, slug) {
  if (!env.DEFI_CACHE) return null;
  const hit = await env.DEFI_CACHE.get("score:v1:" + slug.toLowerCase(), "json");
  return hit && hit.success ? { score: hit.score, band: hit.band } : null;
}

async function fetchAndCacheScore(env, slug) {
  // Re-uses handleProtocolScore so the cached payload structure stays in sync.
  const res = await handleProtocolScore(slug, env);
  try {
    const body = await res.json();
    if (body.success) return { score: body.score, band: body.band };
  } catch {}
  return null;
}

async function handleExposure(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ success: false, error: "Invalid JSON" }, 400); }

  const wallet = body && body.wallet;
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return json({ success: false, error: "Valid wallet address required" }, 400);
  }
  const walletLower = wallet.toLowerCase();

  // Per-wallet exposure cache (10 min) so rescans don't re-hit Etherscan/DeFiLlama.
  const exposureKey = "exposure:v1:" + walletLower;
  if (env.DEFI_CACHE) {
    const hit = await env.DEFI_CACHE.get(exposureKey, "json");
    if (hit) return json({ ...hit, cached: true });
  }

  let catalog, index;
  try {
    catalog = await loadProtocolCatalog(env);
    index = buildContractIndex(catalog);
  } catch (e) {
    return json({ success: false, error: "Catalog unavailable: " + e.message }, 502);
  }

  // Pull last 100 native txs + 100 token txs per chain. Match `to` and `contractAddress`
  // against the catalog index.
  const interactions = new Map(); // key: chain_id|addr  -> { ...meta, lastSeen }
  const chainErrors = {};
  await Promise.all(Object.entries(CHAIN_IDS).map(async ([_, chainId]) => {
    try {
      const [txs, tokenTxs] = await Promise.all([
        etherscanCall(env, chainId, { module: "account", action: "txlist", address: wallet, page: 1, offset: 100, sort: "desc" }),
        etherscanCall(env, chainId, { module: "account", action: "tokentx", address: wallet, page: 1, offset: 100, sort: "desc" }),
      ]);
      const idx = index[chainId];
      if (!idx) return;
      const consider = (addr, tsSec) => {
        if (!addr) return;
        const lower = addr.toLowerCase();
        const meta = idx.get(lower);
        if (!meta) return;
        const key = chainId + "|" + lower;
        const ts = Number(tsSec) * 1000;
        const existing = interactions.get(key);
        if (!existing || ts > existing.lastSeen) {
          interactions.set(key, { ...meta, address: lower, lastSeen: ts || (existing && existing.lastSeen) || 0 });
        }
      };
      (Array.isArray(txs) ? txs : []).forEach((t) => consider(t.to, t.timeStamp));
      (Array.isArray(tokenTxs) ? tokenTxs : []).forEach((t) => consider(t.contractAddress, t.timeStamp));
    } catch (e) {
      chainErrors[chainId] = e.message;
    }
  }));

  // Group hits by protocol slug; one row per (slug, chain_id) pair.
  const grouped = new Map();
  interactions.forEach((meta) => {
    const key = meta.slug + "|" + meta.chain_id;
    const existing = grouped.get(key);
    if (!existing || meta.lastSeen > existing.lastSeen) grouped.set(key, meta);
  });

  // Resolve scores. Prefer KV cache; fall back to live scoring with a small
  // per-request concurrency cap so we don't fan out to DeFiLlama too hard.
  const slugs = Array.from(new Set(Array.from(grouped.values()).map((m) => m.slug)));
  const scoreBySlug = {};
  for (const slug of slugs) {
    let s = await getCachedScore(env, slug);
    if (!s) s = await fetchAndCacheScore(env, slug);
    if (s) scoreBySlug[slug] = s;
  }

  const exposures = Array.from(grouped.values()).map((m) => {
    const sc = scoreBySlug[m.slug] || {};
    return {
      slug: m.slug,
      name: m.name,
      category: m.category,
      chain_id: m.chain_id,
      contract: m.address,
      contract_label: m.label,
      last_interaction_at: m.lastSeen || null,
      score: typeof sc.score === "number" ? sc.score : null,
      band: sc.band || null,
      high_risk: typeof sc.score === "number" && sc.score < 60,
    };
  }).sort((a, b) => {
    // Highest risk first, then by recency
    const scoreA = a.score == null ? 100 : a.score;
    const scoreB = b.score == null ? 100 : b.score;
    if (scoreA !== scoreB) return scoreA - scoreB;
    return (b.last_interaction_at || 0) - (a.last_interaction_at || 0);
  });

  const summary = {
    total: exposures.length,
    high_risk: exposures.filter((e) => e.high_risk).length,
    unscored: exposures.filter((e) => e.score == null).length,
    catalog_size: catalog.protocols.length,
    chain_errors: Object.keys(chainErrors).length ? chainErrors : null,
  };

  const payload = {
    success: true,
    wallet: walletLower,
    exposures,
    summary,
    cached: false,
    timestamp: new Date().toISOString(),
  };

  if (env.DEFI_CACHE) {
    const ttl = Number(env.EXPOSURE_CACHE_TTL_SECONDS || "600");
    await env.DEFI_CACHE.put(exposureKey, JSON.stringify(payload), { expirationTtl: ttl });
  }
  return json(payload);
}

/* ----------------------------- AI Auditor ---------------------------------- */

async function fetchSource(env, chainId, address) {
  const r = await etherscanCall(env, chainId, { module: "contract", action: "getsourcecode", address });
  if (!Array.isArray(r) || !r.length) return null;
  const item = r[0];
  let raw = item.SourceCode || "";
  if (!raw) return null;
  // Etherscan wraps multi-file projects in {{...}} (double braces) JSON. Unwrap if present.
  let files = null;
  if (raw.startsWith("{{") && raw.endsWith("}}")) {
    try {
      const parsed = JSON.parse(raw.slice(1, -1));
      if (parsed && parsed.sources) {
        files = Object.entries(parsed.sources).map(([path, v]) => ({ path, content: v.content || "" }));
      }
    } catch {}
  } else if (raw.startsWith("{") && raw.endsWith("}")) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.sources) {
        files = Object.entries(parsed.sources).map(([path, v]) => ({ path, content: v.content || "" }));
      }
    } catch {}
  }
  if (!files) files = [{ path: (item.ContractName || "Contract") + ".sol", content: raw }];
  return {
    address,
    chainId,
    contractName: item.ContractName || null,
    compilerVersion: item.CompilerVersion || null,
    optimizationUsed: item.OptimizationUsed === "1",
    proxy: item.Proxy === "1",
    implementation: item.Implementation || null,
    licenseType: item.LicenseType || null,
    files,
    totalChars: files.reduce((s, f) => s + f.content.length, 0),
  };
}

const RISK_KEYWORDS = /(onlyOwner|onlyAdmin|onlyGovernance|onlyOperator|require\s*\(\s*msg\.sender\s*==|constructor\s*\(|setFee|setOwner|setAdmin|setGovernance|setOracle|pause\s*\(|unpause\s*\(|upgrade\s*\(|upgradeTo|withdraw\s*\(|mint\s*\(|burn\s*\(|transfer\s*\(|transferFrom|selfdestruct|delegatecall|getPrice|latestAnswer|oracle|timelock|_authorizeUpgrade)/i;

function prioritizeCode(files, maxChars) {
  // Strategy:
  //   1. Always include first N chars of every file (pragma/imports/contract decl).
  //   2. Then for each file, extract every function/modifier whose body matches RISK_KEYWORDS.
  //   3. Concatenate with delimiters until we hit maxChars. Append "// ...truncated..." marker.
  const out = [];
  const headerLines = 30;
  let used = 0;
  for (const f of files) {
    if (used >= maxChars) break;
    const lines = f.content.split("\n");
    const header = lines.slice(0, headerLines).join("\n");
    let chunk = "// === FILE: " + f.path + " ===\n" + header + "\n";
    // Extract risk-relevant blocks: simple brace-balanced scan.
    const text = f.content;
    let i = 0;
    const matches = [];
    while (i < text.length && matches.length < 25) {
      const m = text.slice(i).match(RISK_KEYWORDS);
      if (!m) break;
      const matchStart = i + m.index;
      // Walk backward to find the start of the function/modifier signature.
      let start = text.lastIndexOf("\n", matchStart);
      // Walk back further if previous non-empty line is a modifier list.
      const sigStart = Math.max(0, start - 200);
      const block = extractBlock(text, matchStart);
      if (block) {
        matches.push(text.slice(sigStart, block.end));
        i = block.end;
      } else {
        i = matchStart + m[0].length;
      }
    }
    if (matches.length) {
      chunk += "\n// --- risk-relevant excerpts ---\n" + matches.join("\n\n") + "\n";
    }
    if (used + chunk.length > maxChars) {
      out.push(chunk.slice(0, maxChars - used) + "\n// ...truncated...");
      used = maxChars;
      break;
    }
    out.push(chunk);
    used += chunk.length;
  }
  return out.join("\n\n");
}

function extractBlock(text, fromIdx) {
  // Find first '{' at or after fromIdx, then walk to its matching '}'.
  const open = text.indexOf("{", fromIdx);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return { start: open, end: i + 1 }; }
  }
  return null;
}

const AUDIT_SYSTEM_PROMPT =
  "You are a Senior Smart Contract Auditor. Analyze the provided Solidity source. " +
  "Identify (1) Admin Privileges — can the deployer or any role steal/lock funds, change fees, mint freely, or pause withdrawals? " +
  "(2) Upgradeability — is the contract a proxy, is upgrade gated by a timelock, who controls _authorizeUpgrade? " +
  "(3) Oracle reliance — flash-loan-manipulable spot prices, single-source feeds, missing staleness checks. " +
  "Output ONLY valid JSON, no markdown fences, in this exact shape:\n" +
  "{\n" +
  "  \"safetyScore\": 0-100,\n" +
  "  \"summary\": \"3-sentence plain-English summary of the BIGGEST risk\",\n" +
  "  \"tags\": [\"#Centralized\" | \"#Upgradable\" | \"#Timelock\" | \"#NoTimelock\" | \"#OracleRisk\" | \"#FlashLoanRisk\" | \"#MintAuthority\" | \"#Pausable\" | \"#Renounced\" | \"#NoAudit\" | \"#ComplexLogic\"],\n" +
  "  \"adminPrivileges\": { \"score\": 0-100, \"finding\": \"one sentence\" },\n" +
  "  \"upgradeability\": { \"score\": 0-100, \"finding\": \"one sentence\" },\n" +
  "  \"oracleReliance\": { \"score\": 0-100, \"finding\": \"one sentence\" }\n" +
  "}\n" +
  "Lower scores = higher risk. Be concise and specific (cite function names where possible).";

async function handleAudit(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ success: false, error: "Invalid JSON" }, 400); }

  const address = body && body.address;
  const chainId = Number(body && body.chain_id) || 1;
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return json({ success: false, error: "Valid contract address required" }, 400);
  }
  if (!CHAIN_IDS || !Object.values(CHAIN_IDS).includes(chainId)) {
    return json({ success: false, error: "Unsupported chain_id (use 1, 42161, or 137)" }, 400);
  }

  const cacheKey = "audit:v1:" + chainId + ":" + address.toLowerCase();
  if (env.DEFI_CACHE) {
    const hit = await env.DEFI_CACHE.get(cacheKey, "json");
    if (hit) return json({ ...hit, cached: true });
  }

  let primary;
  try { primary = await fetchSource(env, chainId, address); }
  catch (e) { return json({ success: false, error: "Source fetch failed: " + e.message }, 502); }
  if (!primary) {
    return json({ success: false, error: "Contract source not verified on Etherscan" }, 404);
  }

  // If proxy, also fetch the implementation source. Many real audits live there.
  let implementation = null;
  if (primary.proxy && primary.implementation && /^0x[a-fA-F0-9]{40}$/.test(primary.implementation)) {
    try { implementation = await fetchSource(env, chainId, primary.implementation); }
    catch (e) { console.warn("impl source fetch failed:", e.message); }
  }

  const maxChars = Number(env.AUDIT_MAX_SOURCE_CHARS || "28000");
  const sourceForLLM = implementation
    ? prioritizeCode([
        { path: "PROXY: " + (primary.contractName || "Proxy") + " @ " + primary.address, content: primary.files.map((f) => f.content).join("\n") },
        ...implementation.files.map((f) => ({ path: "IMPL: " + f.path, content: f.content })),
      ], maxChars)
    : prioritizeCode(primary.files, maxChars);

  let aiResponse;
  try {
    aiResponse = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
      messages: [
        { role: "system", content: AUDIT_SYSTEM_PROMPT },
        { role: "user", content:
            "Contract: " + (primary.contractName || "(unnamed)") +
            (primary.proxy ? " (proxy → " + primary.implementation + ")" : "") +
            "\nChain ID: " + chainId +
            "\nCompiler: " + (primary.compilerVersion || "?") +
            "\nLicense: " + (primary.licenseType || "?") +
            "\n\n--- SOURCE (prioritized excerpts) ---\n" + sourceForLLM,
        },
      ],
      max_tokens: 900,
      temperature: 0.3,
    });
  } catch (e) {
    return json({ success: false, error: "AI call failed: " + e.message }, 502);
  }

  const raw = (aiResponse && (aiResponse.response || aiResponse)) || "";
  let report;
  try {
    const cleaned = String(raw).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    report = JSON.parse(cleaned);
  } catch {
    report = { safetyScore: null, summary: "AI returned non-JSON output. Please retry.", tags: [], _raw: typeof raw === "string" ? raw.slice(0, 500) : null };
  }

  const payload = {
    success: true,
    contract: {
      address: primary.address.toLowerCase(),
      chain_id: chainId,
      name: primary.contractName,
      compiler: primary.compilerVersion,
      license: primary.licenseType,
      proxy: primary.proxy,
      implementation: primary.implementation || null,
      verified: true,
      source_total_chars: primary.totalChars + (implementation ? implementation.totalChars : 0),
      source_truncated: (primary.totalChars + (implementation ? implementation.totalChars : 0)) > maxChars,
    },
    audit: report,
    cached: false,
    timestamp: new Date().toISOString(),
  };

  if (env.DEFI_CACHE && report.safetyScore != null) {
    const ttl = Number(env.AUDIT_CACHE_TTL_SECONDS || "2592000");
    await env.DEFI_CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: ttl });
  }
  return json(payload);
}

/* ------------------------------ Health Score ------------------------------- */
//
// Hs = 0.4·Lr + 0.3·LPv + 0.2·Gp + 0.1·Ag         (each pillar 0..100)
// score = round(300 + (Hs/100) * 550)              -> 300..850 (FICO-style)
//
// Real signals only — no fabricated numbers. Each pillar carries `real: true`
// when its underlying data source returned, `real: false` (with neutral 50)
// when it didn't, so the frontend can be honest about coverage.

const AAVE_V3_POOL_ETH = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const UNIV3_POSITION_MANAGER = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
// getUserAccountData(address) selector
const SEL_GET_USER_ACCOUNT_DATA = "0xbf92857c";
// balanceOf(address) selector
const SEL_BALANCE_OF = "0x70a08231";

function padAddr(addr) {
  return "000000000000000000000000" + addr.toLowerCase().replace(/^0x/, "");
}

async function ethCall(env, to, data) {
  const url = env.ETH_RPC_URL || "https://ethereum-rpc.publicnode.com";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  if (!res.ok) throw new Error("RPC HTTP " + res.status);
  const j = await res.json();
  if (j.error) throw new Error("RPC: " + j.error.message);
  return j.result; // hex string
}

function hexSlice(hex, wordIndex) {
  // hex = "0x" + N*64 chars; pull the wordIndex-th 32-byte word
  const start = 2 + wordIndex * 64;
  return BigInt("0x" + hex.slice(start, start + 64));
}

async function fetchAaveHealth(env, wallet) {
  try {
    const data = SEL_GET_USER_ACCOUNT_DATA + padAddr(wallet);
    const r = await ethCall(env, AAVE_V3_POOL_ETH, data);
    if (!r || r === "0x") return { real: false };
    // Returns: totalCollateralBase, totalDebtBase, availableBorrowsBase,
    // currentLiquidationThreshold, ltv, healthFactor (all 8-decimals base / wei)
    const totalCollateralBase = hexSlice(r, 0);
    const totalDebtBase = hexSlice(r, 1);
    const healthFactorRaw = hexSlice(r, 5);
    // healthFactor is 1e18-scaled. Cap at 10 to avoid Infinity for zero-debt users.
    const healthFactor = totalDebtBase === 0n ? null : Number(healthFactorRaw) / 1e18;
    return {
      real: true,
      totalCollateralUsd: Number(totalCollateralBase) / 1e8,
      totalDebtUsd: Number(totalDebtBase) / 1e8,
      healthFactor,
      hasPosition: totalCollateralBase > 0n || totalDebtBase > 0n,
    };
  } catch (e) {
    return { real: false, error: e.message };
  }
}

async function fetchUniV3LpCount(env, wallet) {
  try {
    const r = await ethCall(env, UNIV3_POSITION_MANAGER, SEL_BALANCE_OF + padAddr(wallet));
    if (!r || r === "0x") return { real: false };
    return { real: true, count: Number(BigInt(r)) };
  } catch (e) {
    return { real: false, error: e.message };
  }
}

async function fetchSnapshotVotes(env, wallet) {
  const url = env.SNAPSHOT_API_URL || "https://hub.snapshot.org/graphql";
  const query = `query($voter: String!) { votes(first: 1000, where: { voter: $voter }) { id created space { id } } }`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { voter: wallet } }),
    });
    if (!res.ok) return { real: false };
    const j = await res.json();
    const votes = (j.data && j.data.votes) || [];
    const spaces = new Set(votes.map((v) => v.space && v.space.id).filter(Boolean));
    return {
      real: true,
      voteCount: votes.length,
      uniqueSpaces: spaces.size,
      lastVoteAt: votes.length ? Math.max(...votes.map((v) => v.created)) * 1000 : null,
    };
  } catch (e) {
    return { real: false, error: e.message };
  }
}

async function fetchAccountAge(env, wallet) {
  // Use Etherscan txlist (oldest first) to find the first-tx timestamp on Ethereum.
  try {
    const oldest = await etherscanCall(env, 1, {
      module: "account", action: "txlist", address: wallet, page: 1, offset: 1, sort: "asc",
    });
    if (!Array.isArray(oldest) || !oldest.length) return { real: true, firstTxAt: null, ageDays: 0 };
    const ts = Number(oldest[0].timeStamp) * 1000;
    return { real: true, firstTxAt: ts, ageDays: Math.max(0, (Date.now() - ts) / 86400000) };
  } catch (e) {
    return { real: false, error: e.message };
  }
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function pillarLoanReliability(aave) {
  if (!aave.real) return { value: 50, real: false, finding: "Aave V3 health data unavailable." };
  // No debt and no collateral → user has never used Aave V3. Neutral 60.
  if (!aave.hasPosition) return { value: 60, real: true, finding: "No Aave V3 position. Neutral baseline." };
  // No active debt but has supplied → very healthy lender behaviour.
  if (aave.totalDebtUsd === 0) return { value: 95, real: true, finding: "Active Aave supplier with zero debt." };
  // Has debt — score by health factor: HF≥2 → 90, HF=1.5 → 70, HF=1.2 → 40, HF≤1 → 5.
  const hf = aave.healthFactor || 0;
  let v;
  if (hf >= 2) v = 90;
  else if (hf >= 1.5) v = 60 + ((hf - 1.5) / 0.5) * 30;
  else if (hf >= 1.2) v = 40 + ((hf - 1.2) / 0.3) * 20;
  else if (hf >= 1.0) v = 10 + ((hf - 1.0) / 0.2) * 30;
  else v = 5;
  return {
    value: Math.round(v),
    real: true,
    finding: "Aave V3 debt $" + aave.totalDebtUsd.toFixed(0) + " against $" +
             aave.totalCollateralUsd.toFixed(0) + " collateral. Health factor " + hf.toFixed(2) + ".",
  };
}

function pillarLiquidityProvision(univ3) {
  if (!univ3.real) return { value: 50, real: false, finding: "Uniswap V3 LP data unavailable." };
  const n = univ3.count;
  // 0 → 30 (no LP), 1 → 60, 3 → 80, 5+ → 95.
  let v;
  if (n === 0) v = 30;
  else if (n === 1) v = 60;
  else if (n <= 2) v = 70;
  else if (n <= 4) v = 80;
  else v = 95;
  return {
    value: v,
    real: true,
    finding: n === 0 ? "No Uniswap V3 LP positions held." : n + " Uniswap V3 LP NFT position" + (n > 1 ? "s" : "") + " held.",
  };
}

function pillarGovernance(snap) {
  if (!snap.real) return { value: 50, real: false, finding: "Snapshot vote history unavailable." };
  // +50 baseline + 5 per vote up to 20 votes (cap at 100). Bonus +10 if ≥5 unique spaces.
  const v = clamp(50 + snap.voteCount * 5 + (snap.uniqueSpaces >= 5 ? 10 : 0), 0, 100);
  const finalV = snap.voteCount === 0 ? 30 : v;
  return {
    value: Math.round(finalV),
    real: true,
    finding: snap.voteCount === 0
      ? "No Snapshot governance votes recorded."
      : snap.voteCount + " Snapshot vote" + (snap.voteCount > 1 ? "s" : "") + " across " + snap.uniqueSpaces + " DAO" + (snap.uniqueSpaces > 1 ? "s" : "") + ".",
  };
}

function pillarAccountAge(age) {
  if (!age.real) return { value: 50, real: false, finding: "Etherscan first-tx unavailable." };
  if (age.firstTxAt == null) return { value: 10, real: true, finding: "No Ethereum mainnet activity ever." };
  const years = age.ageDays / 365;
  // <0.5y → 20, 1y → 50, 2y → 75, 3y → 90, 5y+ → 100.
  let v;
  if (years < 0.5) v = 20;
  else if (years < 1) v = 20 + ((years - 0.5) / 0.5) * 30;
  else if (years < 2) v = 50 + (years - 1) * 25;
  else if (years < 3) v = 75 + (years - 2) * 15;
  else if (years < 5) v = 90 + ((years - 3) / 2) * 10;
  else v = 100;
  return {
    value: Math.round(v),
    real: true,
    finding: "Wallet active " + years.toFixed(1) + " years on Ethereum (since " + new Date(age.firstTxAt).toISOString().slice(0, 10) + ").",
  };
}

function applyBonusRules(score, signals) {
  // Per the spec: +50 per 10 governance votes; +100 if no liquidations w/ healthy current state.
  let s = score;
  const adj = [];
  const votes = signals.governance && signals.governance.value != null ? (signals.snapshot.voteCount || 0) : 0;
  const govBonus = Math.floor(votes / 10) * 50;
  if (govBonus > 0) { s += govBonus; adj.push("+" + govBonus + " governance bonus (" + votes + " votes)"); }
  // "no liquidations in 12 months" approximated as: has Aave position + healthFactor > 1.5
  const aave = signals.aave;
  if (aave.real && aave.hasPosition && (aave.healthFactor == null || aave.healthFactor >= 1.5)) {
    s += 100; adj.push("+100 healthy Aave position");
  }
  // Active liquidation event proxy: HF currently below 1 → -150
  if (aave.real && aave.healthFactor != null && aave.healthFactor < 1) {
    s -= 150; adj.push("-150 Aave position currently liquidatable (HF " + aave.healthFactor.toFixed(2) + ")");
  }
  return { score: clamp(Math.round(s), 300, 850), adjustments: adj };
}

async function persistScore(env, wallet, payload) {
  if (!env.HEALTH_DB) return false;
  try {
    await env.HEALTH_DB.prepare(
      "INSERT INTO health_scores (wallet, score, loan_reliability, liquidity_provision, governance, account_age, raw_h_s, source_json, computed_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      wallet,
      payload.score,
      payload.pillars.loan_reliability.value,
      payload.pillars.liquidity_provision.value,
      payload.pillars.governance.value,
      payload.pillars.account_age.value,
      payload.raw_h_s,
      JSON.stringify(payload.signals),
      Date.now()
    ).run();
    return true;
  } catch (e) {
    console.warn("D1 persist failed:", e.message);
    return false;
  }
}

async function fetchHistory(env, wallet, limit) {
  if (!env.HEALTH_DB) return [];
  try {
    const r = await env.HEALTH_DB.prepare(
      "SELECT score, loan_reliability, liquidity_provision, governance, account_age, computed_at " +
      "FROM health_scores WHERE wallet = ? ORDER BY computed_at DESC LIMIT ?"
    ).bind(wallet.toLowerCase(), Math.max(1, Math.min(200, limit || 30))).all();
    return (r.results || []).reverse(); // oldest → newest for charting
  } catch (e) {
    return [];
  }
}

async function handleHealthScore(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ success: false, error: "Invalid JSON" }, 400); }

  const wallet = body && body.wallet;
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return json({ success: false, error: "Valid wallet address required" }, 400);
  }
  const walletLower = wallet.toLowerCase();

  // Short-lived cache so frantic re-clicks don't hammer 4 upstream APIs. D1
  // history is still always recorded once per fresh compute.
  const cacheKey = "health:v1:" + walletLower;
  if (env.DEFI_CACHE) {
    const hit = await env.DEFI_CACHE.get(cacheKey, "json");
    if (hit) {
      const history = await fetchHistory(env, walletLower, body.history_limit || 30);
      return json({ ...hit, history, cached: true });
    }
  }

  const [aave, univ3, snap, age] = await Promise.all([
    fetchAaveHealth(env, walletLower),
    fetchUniV3LpCount(env, walletLower),
    fetchSnapshotVotes(env, walletLower),
    fetchAccountAge(env, walletLower),
  ]);

  const Lr = pillarLoanReliability(aave);
  const LPv = pillarLiquidityProvision(univ3);
  const Gp = pillarGovernance(snap);
  const Ag = pillarAccountAge(age);

  const Hs = (0.4 * Lr.value) + (0.3 * LPv.value) + (0.2 * Gp.value) + (0.1 * Ag.value);
  const baseScore = Math.round(300 + (Hs / 100) * 550);
  const bonus = applyBonusRules(baseScore, {
    aave, snapshot: snap,
    governance: Gp,
  });

  const payload = {
    success: true,
    wallet: walletLower,
    score: bonus.score,
    score_band: bonus.score >= 720 ? "excellent" : bonus.score >= 660 ? "good" : bonus.score >= 580 ? "fair" : "poor",
    raw_h_s: Number(Hs.toFixed(2)),
    pillars: {
      loan_reliability:    { weight: 0.4, ...Lr },
      liquidity_provision: { weight: 0.3, ...LPv },
      governance:          { weight: 0.2, ...Gp },
      account_age:         { weight: 0.1, ...Ag },
    },
    adjustments: bonus.adjustments,
    signals: { aave, univ3, snapshot: snap, account: age },
    methodology: "Hs = 0.4*Lr + 0.3*LPv + 0.2*Gp + 0.1*Ag, mapped 300..850. Bonuses: +50/10 votes, +100 healthy Aave, -150 active liquidation.",
    timestamp: new Date().toISOString(),
    cached: false,
    persisted: false,
  };

  payload.persisted = await persistScore(env, walletLower, payload);
  payload.history = await fetchHistory(env, walletLower, body.history_limit || 30);

  if (env.DEFI_CACHE) {
    const ttl = Number(env.HEALTH_CACHE_TTL_SECONDS || "1800");
    // Cache without history (history fetched live each request)
    const { history, ...cacheable } = payload;
    await env.DEFI_CACHE.put(cacheKey, JSON.stringify(cacheable), { expirationTtl: ttl });
  }
  return json(payload);
}

async function handleHealthHistory(wallet, env, url) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return json({ success: false, error: "Invalid wallet address" }, 400);
  }
  const limit = Number(url.searchParams.get("limit")) || 30;
  const history = await fetchHistory(env, wallet.toLowerCase(), limit);
  return json({ success: true, wallet: wallet.toLowerCase(), history, count: history.length });
}

/* --------------------------------- Watchlists ------------------------------ */
/* Storage: D1 table `watchlists` (see migrations/0002_watchlists.sql).
 * Auth: address-keyed only — there is no signature challenge yet, so anyone
 * who knows a wallet address can read or replace its list. This matches the
 * "wallet = identity" model used everywhere else in the MVP. Documented in
 * replit.md so it can be hardened (SIWE) before any production launch. */

const WL_VALID_KIND = { protocol: 1, token: 1 };

function isValidWallet(w) { return /^0x[a-fA-F0-9]{40}$/.test(w || ""); }

async function handleWatchlistGet(wallet, env) {
  if (!isValidWallet(wallet)) return json({ success: false, error: "Invalid wallet address" }, 400);
  if (!env.HEALTH_DB) return json({ success: false, error: "D1 binding HEALTH_DB not configured" }, 503);
  try {
    const res = await env.HEALTH_DB.prepare(
      "SELECT item, kind, label, alert_threshold, added_at FROM watchlists WHERE wallet = ? ORDER BY added_at DESC"
    ).bind(wallet.toLowerCase()).all();
    return json({ success: true, wallet: wallet.toLowerCase(), items: res.results || [] });
  } catch (e) {
    return json({ success: false, error: "DB read failed: " + e.message }, 500);
  }
}

async function handleWatchlistPut(wallet, request, env) {
  if (!isValidWallet(wallet)) return json({ success: false, error: "Invalid wallet address" }, 400);
  if (!env.HEALTH_DB) return json({ success: false, error: "D1 binding HEALTH_DB not configured" }, 503);
  let body;
  try { body = await request.json(); }
  catch { return json({ success: false, error: "Invalid JSON" }, 400); }
  if (!body || !Array.isArray(body.items)) return json({ success: false, error: "Body must be { items: [...] }" }, 400);
  if (body.items.length > 100) return json({ success: false, error: "Max 100 items per wallet" }, 400);

  const now = Date.now();
  const w = wallet.toLowerCase();
  const cleaned = [];
  for (const it of body.items) {
    if (!it || typeof it.item !== "string" || !it.item.length || it.item.length > 200) {
      return json({ success: false, error: "Each item needs a non-empty `item` (≤200 chars)" }, 400);
    }
    if (!WL_VALID_KIND[it.kind]) {
      return json({ success: false, error: "Each item needs kind ∈ {protocol, token}" }, 400);
    }
    cleaned.push({
      item: it.item.slice(0, 200),
      kind: it.kind,
      label: typeof it.label === "string" ? it.label.slice(0, 120) : null,
      alert_threshold: typeof it.alert_threshold === "number" ? it.alert_threshold : null,
      added_at: typeof it.added_at === "number" ? it.added_at : now,
    });
  }

  try {
    const stmts = [env.HEALTH_DB.prepare("DELETE FROM watchlists WHERE wallet = ?").bind(w)];
    for (const it of cleaned) {
      stmts.push(env.HEALTH_DB.prepare(
        "INSERT INTO watchlists (wallet, item, kind, label, alert_threshold, added_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(w, it.item, it.kind, it.label, it.alert_threshold, it.added_at));
    }
    await env.HEALTH_DB.batch(stmts);
    return json({ success: true, wallet: w, count: cleaned.length });
  } catch (e) {
    return json({ success: false, error: "DB write failed: " + e.message }, 500);
  }
}

async function handleWatchlistDelete(wallet, env) {
  if (!isValidWallet(wallet)) return json({ success: false, error: "Invalid wallet address" }, 400);
  if (!env.HEALTH_DB) return json({ success: false, error: "D1 binding HEALTH_DB not configured" }, 503);
  try {
    await env.HEALTH_DB.prepare("DELETE FROM watchlists WHERE wallet = ?").bind(wallet.toLowerCase()).run();
    return json({ success: true });
  } catch (e) {
    return json({ success: false, error: "DB delete failed: " + e.message }, 500);
  }
}

/* ---------------------------------- Gas ------------------------------------- */
// GET /api/gas → live gwei prices for ethereum, arbitrum, polygon. KV-cached
// for 15 s so a steady ticker poll (every 20 s) stays effectively free.
//
// Each chain RPC URL is taken from env in this order:
//   ethereum: ETH_RPC_URL || public RPC
//   arbitrum: ARB_RPC_URL || public RPC
//   polygon : POLY_RPC_URL || public RPC
// The Cloudflare Web3 Gateway (if configured) is the recommended override.

const GAS_CHAINS = [
  { id: "ethereum", env: "ETH_RPC_URL",  fallback: "https://ethereum-rpc.publicnode.com" },
  { id: "arbitrum", env: "ARB_RPC_URL",  fallback: "https://arbitrum-one-rpc.publicnode.com" },
  { id: "polygon",  env: "POLY_RPC_URL", fallback: "https://polygon-bor-rpc.publicnode.com" },
];

async function fetchGasPriceGwei(rpcUrl) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  if (!data.result) throw new Error(data.error ? data.error.message : "no result");
  // hex wei → number gwei (rounded to 2 dp). Safe for any plausible price.
  const wei = BigInt(data.result);
  const gwei = Number(wei) / 1e9;
  return Math.round(gwei * 100) / 100;
}

async function handleGas(env) {
  const CACHE_KEY = "gas:current";
  if (env.CACHE) {
    const cached = await env.CACHE.get(CACHE_KEY, "json");
    if (cached) return json({ ...cached, cached: true });
  }
  const results = await Promise.all(GAS_CHAINS.map(async (c) => {
    const url = (env[c.env] && String(env[c.env])) || c.fallback;
    try {
      return { chain: c.id, gwei: await fetchGasPriceGwei(url), real: true };
    } catch (e) {
      return { chain: c.id, gwei: null, real: false, error: e.message };
    }
  }));
  const payload = { success: true, chains: results, timestamp: new Date().toISOString() };
  if (env.CACHE) {
    try { await env.CACHE.put(CACHE_KEY, JSON.stringify(payload), { expirationTtl: 15 }); }
    catch (_) { /* non-fatal */ }
  }
  return json(payload);
}

/* ------------------------------ Community votes ----------------------------- */
// Verified-by-DeFiScoring social-proof badge. Wallet-gated, one vote per
// (wallet, protocol). See migrations/0003_community_votes.sql.
//
// GET    /api/votes/:slug                 -> aggregate { up, down, total, score, verified }
// POST   /api/votes/:slug { wallet, vote, comment? } -> upsert (vote ∈ {1,-1})
// DELETE /api/votes/:slug?wallet=0x..     -> retract caller's vote
//
// "Verified" is computed from a quorum + ratio rule so a single +1 doesn't
// confer a badge:  total ≥ 25 AND up/total ≥ 0.70.

const VOTES_QUORUM = 25;
const VOTES_VERIFIED_RATIO = 0.7;

async function aggregateVotes(env, slug) {
  const r = await env.HEALTH_DB.prepare(
    "SELECT " +
    "  SUM(CASE WHEN vote =  1 THEN 1 ELSE 0 END) AS up, " +
    "  SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END) AS down, " +
    "  COUNT(*) AS total " +
    "FROM community_votes WHERE protocol_slug = ?"
  ).bind(slug).first();
  const up = Number((r && r.up) || 0);
  const down = Number((r && r.down) || 0);
  const total = Number((r && r.total) || 0);
  const score = total === 0 ? null : Math.round((up / total) * 100);
  const verified = total >= VOTES_QUORUM && (up / total) >= VOTES_VERIFIED_RATIO;
  return { up, down, total, score, verified, quorum: VOTES_QUORUM };
}

async function handleVotesGet(slug, env, url) {
  if (!slug || !/^[a-z0-9-]{1,64}$/.test(slug)) {
    return json({ success: false, error: "Invalid protocol slug" }, 400);
  }
  if (!env.HEALTH_DB) return json({ success: false, error: "D1 binding HEALTH_DB not configured" }, 503);
  try {
    const agg = await aggregateVotes(env, slug);
    let mine = null;
    const wallet = url.searchParams.get("wallet");
    if (wallet && isValidWallet(wallet)) {
      const r = await env.HEALTH_DB.prepare(
        "SELECT vote, comment, updated_at FROM community_votes WHERE wallet = ? AND protocol_slug = ?"
      ).bind(wallet.toLowerCase(), slug).first();
      mine = r ? { vote: Number(r.vote), comment: r.comment, updated_at: Number(r.updated_at) } : null;
    }
    return json({ success: true, slug, ...agg, mine, timestamp: new Date().toISOString() });
  } catch (e) {
    return json({ success: false, error: "DB read failed: " + e.message }, 500);
  }
}

async function handleVotesPost(slug, request, env) {
  if (!slug || !/^[a-z0-9-]{1,64}$/.test(slug)) {
    return json({ success: false, error: "Invalid protocol slug" }, 400);
  }
  if (!env.HEALTH_DB) return json({ success: false, error: "D1 binding HEALTH_DB not configured" }, 503);
  let body;
  try { body = await request.json(); }
  catch { return json({ success: false, error: "Invalid JSON" }, 400); }
  const wallet = body && body.wallet;
  const vote = body && Number(body.vote);
  const comment = body && typeof body.comment === "string" ? body.comment.trim().slice(0, 280) : null;
  if (!isValidWallet(wallet)) return json({ success: false, error: "Valid wallet address required" }, 400);
  if (vote !== 1 && vote !== -1) return json({ success: false, error: "vote must be 1 or -1" }, 400);
  const w = wallet.toLowerCase();
  const now = Date.now();
  try {
    await env.HEALTH_DB.prepare(
      "INSERT INTO community_votes (wallet, protocol_slug, vote, comment, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT (wallet, protocol_slug) DO UPDATE SET " +
      "  vote = excluded.vote, comment = excluded.comment, updated_at = excluded.updated_at"
    ).bind(w, slug, vote, comment, now, now).run();
    const agg = await aggregateVotes(env, slug);
    return json({ success: true, slug, ...agg, mine: { vote, comment, updated_at: now } });
  } catch (e) {
    return json({ success: false, error: "DB write failed: " + e.message }, 500);
  }
}

async function handleVotesDelete(slug, env, url) {
  if (!slug || !/^[a-z0-9-]{1,64}$/.test(slug)) {
    return json({ success: false, error: "Invalid protocol slug" }, 400);
  }
  if (!env.HEALTH_DB) return json({ success: false, error: "D1 binding HEALTH_DB not configured" }, 503);
  const wallet = url.searchParams.get("wallet");
  if (!isValidWallet(wallet)) return json({ success: false, error: "Valid wallet query param required" }, 400);
  try {
    await env.HEALTH_DB.prepare(
      "DELETE FROM community_votes WHERE wallet = ? AND protocol_slug = ?"
    ).bind(wallet.toLowerCase(), slug).run();
    const agg = await aggregateVotes(env, slug);
    return json({ success: true, slug, ...agg, mine: null });
  } catch (e) {
    return json({ success: false, error: "DB delete failed: " + e.message }, 500);
  }
}

/* --------------------------------- Router ---------------------------------- */

// ---------------------------------------------------------------------------
// POST /api/report-issue → create a GitHub issue from in-app feedback.
//
// Body: { title, body, labels?: string[], page?, wallet?, userAgent? }
//
// Required env:
//   env.GITHUB_TOKEN        – classic PAT with "repo" scope (CF Worker secret)
//   env.GITHUB_REPO_OWNER   – default repo owner (CF Worker var)
//   env.GITHUB_REPO_NAME    – default repo name  (CF Worker var)
//
// We deliberately accept `page`, `wallet`, and `userAgent` as separate fields
// (rather than letting the client splice them into `body`) so the server is
// always the one that formats the trailer. This stops a malicious client
// from spoofing a different reporter's wallet in the issue body.
// ---------------------------------------------------------------------------
async function handleReportIssue(request, env) {
  if (!env.GITHUB_TOKEN) {
    return json({ success: false, error: "Issue reporting is not configured. Set GITHUB_TOKEN on the Worker." }, 503);
  }
  const owner = env.GITHUB_REPO_OWNER;
  const repo  = env.GITHUB_REPO_NAME;
  if (!owner || !repo) {
    return json({ success: false, error: "GITHUB_REPO_OWNER / GITHUB_REPO_NAME not configured on the Worker." }, 503);
  }

  let data;
  try { data = await request.json(); }
  catch { return json({ success: false, error: "Invalid JSON" }, 400); }

  const title = (data.title || "").toString().trim();
  const userBody = (data.body || "").toString().trim();
  if (!title || !userBody) {
    return json({ success: false, error: "title and body are required" }, 400);
  }
  if (title.length > 200) {
    return json({ success: false, error: "title must be ≤ 200 characters" }, 400);
  }
  if (userBody.length > 8000) {
    return json({ success: false, error: "body must be ≤ 8000 characters" }, 400);
  }

  const labels = Array.isArray(data.labels) && data.labels.length
    ? data.labels.filter((l) => typeof l === "string").slice(0, 10)
    : ["user-report"];

  const trailer = [
    "",
    "---",
    "**Reported via DeFi Scoring in-app form**",
    "Page: " + (data.page ? "`" + String(data.page).slice(0, 500) + "`" : "(unknown)"),
    "Wallet: " + (data.wallet ? "`" + String(data.wallet).slice(0, 64) + "`" : "(not connected)"),
    "User-Agent: `" + String(data.userAgent || request.headers.get("user-agent") || "(unknown)").slice(0, 300) + "`",
    "Submitted: " + new Date().toISOString(),
  ].join("\n");

  const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
    method: "POST",
    headers: {
      "Authorization": "token " + env.GITHUB_TOKEN,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "DeFiScoring-Worker",
    },
    body: JSON.stringify({ title, body: userBody + "\n" + trailer, labels }),
  });

  if (!ghRes.ok) {
    const text = await ghRes.text();
    return json({ success: false, error: "GitHub API error", status: ghRes.status, detail: text.slice(0, 400) }, 502);
  }

  const issue = await ghRes.json();
  return json({ success: true, issueNumber: issue.number, issueUrl: issue.html_url });
}

// ---------------------------------------------------------------------------
// Market Intelligence (anonymized telemetry)
//
// Three endpoints:
//   POST /api/intel/event   – ingest one anonymized event (gated by client opt-in)
//   GET  /api/intel/summary – admin: rolling window aggregates (JSON)
//   GET  /api/intel/export  – admin: CSV export of daily aggregates
//
// Privacy
// -------
// The browser sends sha256(walletAddress) (already hashed). The Worker
// re-keys it with HMAC-SHA256 using INTEL_SALT before storage so that a
// stolen DB cannot be reversed by precomputing hashes of known wallets.
//
// Admin auth
// ----------
// `Authorization: Bearer <ADMIN_TOKEN>` against env.ADMIN_TOKEN. This is
// a shared-secret MVP gate; replace with Cloudflare Access before opening
// the dashboard URL externally.
// ---------------------------------------------------------------------------

const INTEL_EVENT_TYPES = new Set(["score_render", "profiler_run", "approvals_scan"]);
const INTEL_RISK_PROFILES = new Set(["Conservative", "Moderate", "Aggressive"]);

async function intelHashWallet(clientSha256Hex, salt) {
  // HMAC-SHA256(client_hash, salt) → hex
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(String(clientSha256Hex || "")));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function intelRequireAdmin(request, env) {
  if (!env.ADMIN_TOKEN) {
    return json({ success: false, error: "ADMIN_TOKEN not configured on the Worker." }, 503);
  }
  const auth = request.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const got = m ? m[1].trim() : "";
  // Constant-time-ish length-aware comparison.
  if (got.length !== env.ADMIN_TOKEN.length) {
    return json({ success: false, error: "Unauthorized" }, 401);
  }
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ env.ADMIN_TOKEN.charCodeAt(i);
  if (diff !== 0) return json({ success: false, error: "Unauthorized" }, 401);
  return null;
}

async function handleIntelEvent(request, env) {
  if (!env.HEALTH_DB) {
    return json({ success: false, error: "D1 binding HEALTH_DB unavailable" }, 503);
  }
  if (!env.INTEL_SALT) {
    return json({ success: false, error: "INTEL_SALT not configured" }, 503);
  }

  let payload;
  try { payload = await request.json(); }
  catch { return json({ success: false, error: "Invalid JSON" }, 400); }

  const eventType = String(payload.eventType || "").trim();
  if (!INTEL_EVENT_TYPES.has(eventType)) {
    return json({ success: false, error: "Unknown eventType" }, 400);
  }

  const clientHash = String(payload.hashedWallet || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clientHash)) {
    return json({ success: false, error: "hashedWallet must be a sha256 hex string" }, 400);
  }
  const hashed = await intelHashWallet(clientHash, env.INTEL_SALT);

  let score = null;
  if (payload.deFiScore != null) {
    const n = Math.round(Number(payload.deFiScore));
    if (Number.isFinite(n) && n >= 300 && n <= 850) score = n;
  }

  let riskProfile = null;
  if (payload.riskProfile && INTEL_RISK_PROFILES.has(String(payload.riskProfile))) {
    riskProfile = String(payload.riskProfile);
  }

  const chain = (payload.chain && typeof payload.chain === "string")
    ? payload.chain.toLowerCase().slice(0, 24)
    : "ethereum";

  // Sanitize metadata: must be a plain object, capped serialized length.
  let metaStr = null;
  if (payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)) {
    try {
      const s = JSON.stringify(payload.metadata);
      if (s.length <= 2000) metaStr = s;
    } catch { /* ignore */ }
  }

  const today = new Date().toISOString().slice(0, 10);
  const nowMs = Date.now();
  const id = crypto.randomUUID();

  const unlimitedDelta = (metaStr && payload.metadata.unlimitedApprovals)
    ? Math.max(0, Math.min(50, Number(payload.metadata.unlimitedApprovals) | 0))
    : 0;

  // Insert the event row.
  await env.HEALTH_DB.prepare(
    "INSERT INTO intel_events (id, hashed_wallet, event_type, defi_score, risk_profile, chain, metadata, created_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, hashed, eventType, score, riskProfile, chain, metaStr, nowMs).run();

  // Upsert the daily aggregate. We compute unique_wallets via a follow-up
  // query rather than incrementing here (cheaper than tracking a set in SQL).
  await env.HEALTH_DB.prepare(
    "INSERT INTO intel_daily_aggregates " +
    "(date, chain, total_events, unique_wallets, score_sum, score_count, " +
    " aggressive_count, conservative_count, moderate_count, unlimited_approvals_count) " +
    "VALUES (?, ?, 1, 0, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(date, chain) DO UPDATE SET " +
    "  total_events              = total_events + 1, " +
    "  score_sum                 = score_sum + COALESCE(excluded.score_sum, 0), " +
    "  score_count               = score_count + excluded.score_count, " +
    "  aggressive_count          = aggressive_count + excluded.aggressive_count, " +
    "  conservative_count        = conservative_count + excluded.conservative_count, " +
    "  moderate_count            = moderate_count + excluded.moderate_count, " +
    "  unlimited_approvals_count = unlimited_approvals_count + excluded.unlimited_approvals_count"
  ).bind(
    today, chain,
    score == null ? 0 : score,
    score == null ? 0 : 1,
    riskProfile === "Aggressive" ? 1 : 0,
    riskProfile === "Conservative" ? 1 : 0,
    riskProfile === "Moderate" ? 1 : 0,
    unlimitedDelta
  ).run();

  // Recompute unique_wallets for today/chain (cheap: indexed scan over today's rows).
  const startOfDay = Date.parse(today + "T00:00:00Z");
  const endOfDay   = startOfDay + 86400000;
  const uniq = await env.HEALTH_DB.prepare(
    "SELECT COUNT(DISTINCT hashed_wallet) AS n FROM intel_events " +
    "WHERE chain = ? AND created_at >= ? AND created_at < ?"
  ).bind(chain, startOfDay, endOfDay).first();
  await env.HEALTH_DB.prepare(
    "UPDATE intel_daily_aggregates SET unique_wallets = ? WHERE date = ? AND chain = ?"
  ).bind((uniq && uniq.n) || 0, today, chain).run();

  return json({ success: true });
}

async function handleIntelSummary(request, env, url) {
  const denied = intelRequireAdmin(request, env);
  if (denied) return denied;
  if (!env.HEALTH_DB) return json({ success: false, error: "D1 binding HEALTH_DB unavailable" }, 503);

  const days = Math.max(1, Math.min(365, parseInt(url.searchParams.get("days") || "30", 10) || 30));
  const cutoffMs = Date.now() - days * 86400000;
  const cutoffDate = new Date(cutoffMs).toISOString().slice(0, 10);

  const totalsRow = await env.HEALTH_DB.prepare(
    "SELECT " +
    "  COALESCE(SUM(total_events), 0)              AS total_events, " +
    "  COALESCE(SUM(score_sum), 0)                 AS score_sum, " +
    "  COALESCE(SUM(score_count), 0)               AS score_count, " +
    "  COALESCE(SUM(aggressive_count), 0)          AS aggressive_count, " +
    "  COALESCE(SUM(conservative_count), 0)        AS conservative_count, " +
    "  COALESCE(SUM(moderate_count), 0)            AS moderate_count, " +
    "  COALESCE(SUM(unlimited_approvals_count), 0) AS unlimited_approvals_count " +
    "FROM intel_daily_aggregates WHERE date >= ?"
  ).bind(cutoffDate).first();

  const uniqRow = await env.HEALTH_DB.prepare(
    "SELECT COUNT(DISTINCT hashed_wallet) AS n FROM intel_events WHERE created_at >= ?"
  ).bind(cutoffMs).first();

  const byTypeRows = await env.HEALTH_DB.prepare(
    "SELECT event_type, COUNT(*) AS n FROM intel_events WHERE created_at >= ? GROUP BY event_type"
  ).bind(cutoffMs).all();

  const dailyRows = await env.HEALTH_DB.prepare(
    "SELECT date, chain, total_events, unique_wallets, score_sum, score_count, " +
    "       aggressive_count, conservative_count, moderate_count, unlimited_approvals_count " +
    "FROM intel_daily_aggregates WHERE date >= ? ORDER BY date DESC, chain"
  ).bind(cutoffDate).all();

  const t = totalsRow || {};
  const denom = (t.score_count || 0);
  const avgScore = denom ? Math.round((t.score_sum || 0) / denom) : null;
  const profilesTotal = (t.aggressive_count || 0) + (t.conservative_count || 0) + (t.moderate_count || 0);
  const aggressivePct = profilesTotal ? +(100 * (t.aggressive_count || 0) / profilesTotal).toFixed(1) : null;

  return json({
    success: true,
    window_days: days,
    totals: {
      total_events: t.total_events || 0,
      unique_wallets: (uniqRow && uniqRow.n) || 0,
      avg_defi_score: avgScore,
      aggressive_percent: aggressivePct,
      unlimited_approvals: t.unlimited_approvals_count || 0,
      profile_counts: {
        Conservative: t.conservative_count || 0,
        Moderate: t.moderate_count || 0,
        Aggressive: t.aggressive_count || 0,
      },
    },
    by_event_type: (byTypeRows.results || []).reduce(function (acc, r) { acc[r.event_type] = r.n; return acc; }, {}),
    daily: dailyRows.results || [],
  });
}

async function handleIntelExport(request, env, url) {
  const denied = intelRequireAdmin(request, env);
  if (denied) return denied;
  if (!env.HEALTH_DB) return json({ success: false, error: "D1 binding HEALTH_DB unavailable" }, 503);

  const days = Math.max(1, Math.min(365, parseInt(url.searchParams.get("days") || "90", 10) || 90));
  const cutoffDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const rows = await env.HEALTH_DB.prepare(
    "SELECT date, chain, total_events, unique_wallets, score_sum, score_count, " +
    "       aggressive_count, conservative_count, moderate_count, unlimited_approvals_count " +
    "FROM intel_daily_aggregates WHERE date >= ? ORDER BY date DESC, chain"
  ).bind(cutoffDate).all();

  const header = [
    "date", "chain", "total_events", "unique_wallets",
    "avg_defi_score", "aggressive_count", "conservative_count", "moderate_count",
    "unlimited_approvals_count",
  ];
  const lines = [header.join(",")];
  for (const r of (rows.results || [])) {
    const avg = r.score_count ? Math.round((r.score_sum || 0) / r.score_count) : "";
    lines.push([
      r.date, r.chain, r.total_events, r.unique_wallets,
      avg, r.aggressive_count, r.conservative_count, r.moderate_count,
      r.unlimited_approvals_count,
    ].join(","));
  }

  return new Response(lines.join("\n") + "\n", {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="defiscoring-intel-' + cutoffDate + '.csv"',
      "Cache-Control": "no-store",
    },
  });
}

// ---------------------------------------------------------------------------
// Risk Profile Chatbot
//
//   POST /api/chatbot/consent  – record lead (email + opt-in) before chat
//   POST /api/chatbot/message  – multi-turn AI chat; returns finalReport
//                                when the model emits structured output.
//
// Storage
//   • Lead row             → D1 HEALTH_DB (chatbot_leads, email PK)
//   • Conversation history → KV DEFI_CACHE under "chatbot:{sessionId}", 1h TTL
//
// Privacy
//   The transcript is never persisted to D1; KV ages it out after 60 min.
//   Only the email + most recent risk profile are stored long-term.
// ---------------------------------------------------------------------------

const CHAT_HISTORY_TURNS_MAX = 16;     // user+assistant turns kept in context
const CHAT_USER_MSG_MAX_LEN  = 1500;
const CHAT_KV_TTL_SECONDS    = 3600;
const CHAT_VALID_PROFILES    = new Set(["Conservative", "Moderate", "Aggressive"]);

const CHAT_SYSTEM_PROMPT =
  "You are a concise, friendly DeFi Risk Advisor. Ask EXACTLY ONE question per turn. " +
  "Topics to cover, in order: investment goals, DeFi experience, loss tolerance, portfolio size band, " +
  "preferred chains, time horizon. Never ask for personally identifying information. " +
  "After 5–7 questions, OR as soon as the user types 'finish', 'report', or 'done', " +
  "you MUST stop chatting and respond with ONLY a single JSON object (no prose, no markdown fences) of the form:\n" +
  '{"riskProfile":"Conservative|Moderate|Aggressive",' +
  '"summary":"2-3 paragraph personalized summary, plain text, no markdown",' +
  '"recommendations":[{"project":"name","reason":"why","riskLevel":"Low|Medium|High"}],' +
  '"pdfTitle":"Your Personalized DeFi Risk Profile Report"}\n' +
  "Until then, be conversational and helpful but never output JSON.";

function chatIsEmail(s) {
  // Pragmatic email regex (RFC-ish, not perfect but rejects obvious garbage).
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 254;
}

function chatExtractFinalReport(text) {
  // The model is instructed to return raw JSON. Be lenient: also accept JSON
  // wrapped in ```json ... ``` fences, or with leading/trailing prose.
  if (typeof text !== "string" || text.indexOf("riskProfile") === -1) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf("{");
  const end   = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(candidate.slice(start, end + 1));
    if (!obj || typeof obj !== "object") return null;
    if (!CHAT_VALID_PROFILES.has(obj.riskProfile)) return null;
    if (typeof obj.summary !== "string" || obj.summary.length < 10) return null;
    if (!Array.isArray(obj.recommendations)) obj.recommendations = [];
    obj.recommendations = obj.recommendations.slice(0, 8).map(function (r) {
      return {
        project:   String((r && r.project)   || "").slice(0, 80),
        reason:    String((r && r.reason)    || "").slice(0, 400),
        riskLevel: ["Low", "Medium", "High"].indexOf(r && r.riskLevel) !== -1 ? r.riskLevel : "Medium",
      };
    });
    obj.pdfTitle = String(obj.pdfTitle || "Your Personalized DeFi Risk Profile Report").slice(0, 120);
    return obj;
  } catch (_) {
    return null;
  }
}

async function handleChatbotConsent(request, env) {
  if (!env.HEALTH_DB) return json({ success: false, error: "D1 binding HEALTH_DB unavailable" }, 503);

  let payload;
  try { payload = await request.json(); }
  catch { return json({ success: false, error: "Invalid JSON" }, 400); }

  const email = String((payload && payload.email) || "").trim().toLowerCase();
  if (!chatIsEmail(email)) return json({ success: false, error: "Please enter a valid email address." }, 400);
  if (payload.consent !== true) return json({ success: false, error: "Consent must be explicit." }, 400);

  const now = Date.now();
  await env.HEALTH_DB.prepare(
    "INSERT INTO chatbot_leads (email, source, consented_at, last_seen_at, sessions_count) " +
    "VALUES (?, 'chatbot', ?, ?, 1) " +
    "ON CONFLICT(email) DO UPDATE SET " +
    "  last_seen_at = excluded.last_seen_at, " +
    "  sessions_count = sessions_count + 1, " +
    "  marketing_opt_out = 0"
  ).bind(email, now, now).run();

  return json({ success: true, message: "Consent recorded. Chatbot unlocked." });
}

async function handleChatbotMessage(request, env) {
  if (!env.AI)         return json({ success: false, error: "Workers AI binding unavailable" }, 503);
  if (!env.DEFI_CACHE) return json({ success: false, error: "KV binding DEFI_CACHE unavailable" }, 503);

  let payload;
  try { payload = await request.json(); }
  catch { return json({ success: false, error: "Invalid JSON" }, 400); }

  const sessionId = String((payload && payload.sessionId) || "").trim();
  const message   = String((payload && payload.message)   || "").trim();
  const email     = String((payload && payload.email)     || "").trim().toLowerCase();

  if (!/^[A-Za-z0-9_-]{8,64}$/.test(sessionId)) {
    return json({ success: false, error: "sessionId required (8–64 chars, alphanumeric/_-)" }, 400);
  }
  if (!message)                                 return json({ success: false, error: "message required" }, 400);
  if (message.length > CHAT_USER_MSG_MAX_LEN)   return json({ success: false, error: "message too long" }, 413);

  const kvKey = "chatbot:" + sessionId;
  let history = [];
  try {
    const raw = await env.DEFI_CACHE.get(kvKey, { type: "json" });
    if (Array.isArray(raw)) history = raw;
  } catch (_) { history = []; }

  history.push({ role: "user", content: message });
  // Trim to most recent N turns so the prompt never blows past context.
  if (history.length > CHAT_HISTORY_TURNS_MAX) {
    history = history.slice(history.length - CHAT_HISTORY_TURNS_MAX);
  }

  let replyText = "";
  try {
    const aiResponse = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
      messages: [{ role: "system", content: CHAT_SYSTEM_PROMPT }].concat(history),
      max_tokens: 1200,
      temperature: 0.7,
    });
    replyText = (aiResponse && (aiResponse.response || aiResponse.result || aiResponse)) || "";
    if (typeof replyText !== "string") replyText = String(replyText || "");
    replyText = replyText.trim();
  } catch (e) {
    return json({ success: false, error: "AI call failed: " + (e.message || String(e)) }, 502);
  }

  if (!replyText) {
    return json({ success: false, error: "AI returned an empty response — please try again." }, 502);
  }

  history.push({ role: "assistant", content: replyText });
  try { await env.DEFI_CACHE.put(kvKey, JSON.stringify(history), { expirationTtl: CHAT_KV_TTL_SECONDS }); }
  catch (_) { /* non-fatal: chat continues without persistence */ }

  const finalReport = chatExtractFinalReport(replyText);

  // If we have both a finalReport AND a known email, persist the final risk
  // profile to the lead row so the admin view shows their last classification.
  if (finalReport && email && chatIsEmail(email) && env.HEALTH_DB) {
    try {
      await env.HEALTH_DB.prepare(
        "UPDATE chatbot_leads SET last_risk_profile = ?, last_seen_at = ? WHERE email = ?"
      ).bind(finalReport.riskProfile, Date.now(), email).run();
    } catch (_) { /* non-fatal */ }
  }

  // If we sent back a final report we also wipe the KV history so a follow-up
  // "start over" doesn't accidentally splice the old transcript in.
  if (finalReport) {
    try { await env.DEFI_CACHE.delete(kvKey); } catch (_) {}
  }

  return json({ success: true, reply: replyText, finalReport: finalReport });
}

export default {
  async fetch(request, env) {
    try {
      // Phase 4: fail-closed sanctions check before any handler runs.
      // We collect EVERY address that appears in the URL or anywhere in
      // the JSON body and block if ANY one matches the SDN list. The
      // error is intentionally generic ("Request blocked.") — never leak
      // why, never confirm a hit on the SDN list, never reveal which of
      // multiple addresses tripped the check.
      const peekedAddrs = await extractAddressesFromRequest(request);
      if (peekedAddrs.some(isSanctioned)) {
        return finalizeResponse(
          new Response(
            JSON.stringify({ success: false, error: "Request blocked." }),
            { status: 403, headers: { "Content-Type": "application/json" } }
          ),
          request,
          env
        );
      }
      const peekedAddr = peekedAddrs[0] || null;
      const response = await dispatch(request, env, peekedAddr);
      return finalizeResponse(response, request, env);
    } catch (e) {
      return finalizeResponse(
        new Response(
          JSON.stringify({ success: false, error: "Internal error: " + (e && e.message ? e.message : String(e)) }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        ),
        request,
        env
      );
    }
  },
  // Phase 4 — Cron Trigger handler. Configured in wrangler.jsonc as
  // `triggers.crons: ["17 3 * * *"]` (daily 03:17 UTC). Prunes raw event
  // rows older than DATA_RETENTION_DAYS (default 180); aggregated rollups
  // in `intel_daily_aggregates` are kept indefinitely per the data
  // retention policy.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runRetentionPrune(env));
  },
};

// Phase 4 — DSAR export. Returns a JSON dump of every row in our D1 that
// can be tied to the requested address. Read-only; no auth (the spec asks
// for a signed-link-via-email flow which lands with Phase 2 / mail
// integration). Anyone can call this for any address — but the response
// reveals nothing not already in the public chain or aggregated public APIs.
//
// `intel_events` is keyed by HMAC-SHA256(sha256(addr), INTEL_SALT), so we
// recompute that double hash here to find the rows the requesting address
// contributed.
async function handleAccountExport(request, env, url) {
  const addr = (url.searchParams.get("address") || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) {
    return json({ success: false, error: "address query param required (0x… 40 hex)" }, 400);
  }
  if (!env.HEALTH_DB) {
    return json({ success: false, error: "HEALTH_DB binding unavailable" }, 503);
  }
  const out = {
    success: true,
    address: addr,
    generated_at: new Date().toISOString(),
    notes: [
      "This is a Data Subject Access Request export covering every row in the",
      "DeFiScoring database that can be associated with this address.",
      "Aggregated, non-identifying rollups (intel_daily_aggregates) are kept",
      "indefinitely per the data retention policy (see /privacy/).",
    ],
    tables: {},
  };
  const safeAll = async (label, query, ...binds) => {
    try {
      const r = await env.HEALTH_DB.prepare(query).bind(...binds).all();
      out.tables[label] = (r && r.results) || [];
    } catch (e) {
      out.tables[label] = { error: e && e.message ? e.message : String(e) };
    }
  };
  await safeAll("health_scores",   "SELECT * FROM health_scores  WHERE wallet = ? ORDER BY computed_at DESC", addr);
  await safeAll("watchlists",      "SELECT * FROM watchlists     WHERE wallet = ? ORDER BY added_at   DESC", addr);
  await safeAll("community_votes", "SELECT * FROM community_votes WHERE wallet = ? ORDER BY updated_at DESC", addr);
  if (env.INTEL_SALT) {
    try {
      const inner = await sha256(addr);
      const keyBuf = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(env.INTEL_SALT),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
      const sig = await crypto.subtle.sign("HMAC", keyBuf, new TextEncoder().encode(inner));
      const hashed = Array.from(new Uint8Array(sig))
        .map((b) => b.toString(16).padStart(2, "0")).join("");
      await safeAll(
        "intel_events",
        "SELECT id, event_type, defi_score, risk_profile, chain, metadata, created_at " +
        "FROM intel_events WHERE hashed_wallet = ? ORDER BY created_at DESC",
        hashed
      );
    } catch (e) {
      out.tables.intel_events = { error: "hash failure: " + (e && e.message ? e.message : String(e)) };
    }
  } else {
    out.tables.intel_events = { error: "INTEL_SALT secret unset; cannot resolve hashed_wallet" };
  }
  return json({ ...out, disclaimer: DISCLAIMER_TEXT });
}

async function runRetentionPrune(env) {
  if (!env.HEALTH_DB) return { ok: false, reason: "no HEALTH_DB binding" };
  const days = parseInt(env.DATA_RETENTION_DAYS || "180", 10);
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const summary = { ok: true, cutoffMs, deleted: {} };
  // intel_events — raw telemetry. Aggregates are NOT touched.
  try {
    const r = await env.HEALTH_DB
      .prepare("DELETE FROM intel_events WHERE created_at < ?")
      .bind(cutoffMs)
      .run();
    summary.deleted.intel_events = (r && r.meta && r.meta.changes) || 0;
  } catch (e) {
    summary.ok = false;
    summary.intel_events_error = e && e.message ? e.message : String(e);
  }
  // health_scores — raw per-computation snapshots. Keep aggregates path open
  // for a future rollup table; for now, prune raw history past the window.
  try {
    const r = await env.HEALTH_DB
      .prepare("DELETE FROM health_scores WHERE computed_at < ?")
      .bind(cutoffMs)
      .run();
    summary.deleted.health_scores = (r && r.meta && r.meta.changes) || 0;
  } catch (e) {
    summary.ok = false;
    summary.health_scores_error = e && e.message ? e.message : String(e);
  }
  return summary;
}

async function dispatch(request, env, peekedAddr) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeadersFor(request, env) });
    }
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({
        ok: true,
        bindings: {
          AI: !!env.AI,
          PROFILE_CACHE: !!env.PROFILE_CACHE,
          DEFI_CACHE: !!env.DEFI_CACHE,
          ETHERSCAN_API_KEY: !!env.ETHERSCAN_API_KEY,
        },
      });
    }

    if (request.method === "GET" && url.pathname.startsWith("/onchain/")) {
      return handleOnchain(url.pathname.slice("/onchain/".length), env);
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/score/")) {
      return handleProtocolScore(url.pathname.slice("/api/score/".length), env);
    }

    // Rate limit the expensive AI/GitHub endpoints (KV-backed sliding window
    // by IP, plus a per-address cap on address-aware endpoints). Caps are
    // generous for legit users, tight enough to deter scripted abuse of the
    // Workers AI bill, and address-keyed so botnets that rotate IPs can't
    // amplify via a single wallet.
    if (request.method === "POST" && (
      url.pathname === "/" ||
      url.pathname === "/profile" ||
      url.pathname === "/api/profile" ||
      url.pathname === "/api/exposure" ||
      url.pathname === "/api/audit" ||
      url.pathname === "/api/health-score" ||
      url.pathname === "/api/chatbot/message" ||
      url.pathname === "/api/report-issue" ||
      url.pathname === "/api/intel/event"
    )) {
      const ipLimit =
        url.pathname === "/api/report-issue" ? 5 :
        url.pathname === "/api/intel/event"  ? 30 :
        20;
      const blocked = await rateLimit(request, env, url.pathname, ipLimit, 60);
      if (blocked) return blocked;
      if (peekedAddr) {
        const addrLimit =
          url.pathname === "/api/report-issue" ? 10 :   // 10/hr per address
          url.pathname === "/api/intel/event"  ? 60 :   // 60/min per address
          30;                                            // 30/min per address default
        const windowSec = url.pathname === "/api/report-issue" ? 3600 : 60;
        const addrBlocked = await rateLimitByAddress(
          request, env, peekedAddr, url.pathname, addrLimit, windowSec
        );
        if (addrBlocked) return addrBlocked;
      }
      // /api/intel/event payloads carry only a `hashedWallet` (sha256 of the
      // address) — extractAddressesFromRequest can't see it. Pull it out
      // here and key a separate per-identity bucket on the hash so botnets
      // rotating IPs but reusing one wallet still hit a cap.
      if (url.pathname === "/api/intel/event") {
        try {
          const b = await request.clone().json();
          const hw = String((b && b.hashedWallet) || "").trim().toLowerCase();
          if (/^[a-f0-9]{64}$/.test(hw)) {
            const blockedHw = await rateLimitByAddress(
              request, env, hw, "/api/intel/event:hw", 60, 60
            );
            if (blockedHw) return blockedHw;
          }
        } catch { /* not JSON, the handler will reject */ }
      }
    }

    if (request.method === "POST" && url.pathname === "/api/exposure") {
      return handleExposure(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/audit") {
      return handleAudit(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/health-score") {
      return handleHealthScore(request, env);
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/health-score/") && url.pathname.endsWith("/history")) {
      const wallet = url.pathname.slice("/api/health-score/".length, -"/history".length);
      return handleHealthHistory(wallet, env, url);
    }

    if (url.pathname === "/api/gas" && request.method === "GET") {
      return handleGas(env);
    }

    if (url.pathname.startsWith("/api/votes/")) {
      const slug = url.pathname.slice("/api/votes/".length).replace(/\/$/, "");
      if (request.method === "GET")    return handleVotesGet(slug, env, url);
      if (request.method === "POST")   return handleVotesPost(slug, request, env);
      if (request.method === "DELETE") return handleVotesDelete(slug, env, url);
    }

    if (url.pathname.startsWith("/api/watchlist/")) {
      const wallet = url.pathname.slice("/api/watchlist/".length).replace(/\/$/, "");
      if (request.method === "GET")    return handleWatchlistGet(wallet, env);
      if (request.method === "PUT")    return handleWatchlistPut(wallet, request, env);
      if (request.method === "DELETE") return handleWatchlistDelete(wallet, env);
    }

    if (request.method === "POST" && (url.pathname === "/" || url.pathname === "/profile" || url.pathname === "/api/profile")) {
      return handleProfile(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/report-issue") {
      return handleReportIssue(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/chatbot/consent") {
      return handleChatbotConsent(request, env);
    }
    if (request.method === "POST" && url.pathname === "/api/chatbot/message") {
      return handleChatbotMessage(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/intel/event") {
      return handleIntelEvent(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/intel/summary") {
      return handleIntelSummary(request, env, url);
    }
    if (request.method === "GET" && url.pathname === "/api/intel/export") {
      return handleIntelExport(request, env, url);
    }

    // -----------------------------------------------------------------------
    // Phase 4 — DSAR (Data Subject Access Request) endpoints.
    //
    //   GET  /api/account/export?address=0x…   → JSON dump of every row tied
    //                                            to that address (read-only).
    //   POST /api/account/delete                → fail-closed 503 until SIWE
    //                                            (Phase 2) ships, because we
    //                                            cannot prove ownership of
    //                                            the requested address yet.
    //   POST /api/account/retention/run         → admin-only on-demand prune,
    //                                            same logic as the cron.
    //
    // Export is intentionally NOT auth-gated: it returns nothing the
    // requester couldn't see by reading the chain + their own localStorage,
    // and it gives privacy regulators a working DSAR path on day one. The
    // signed-link-via-email variant from the spec is queued for Phase 2.
    // -----------------------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/account/export") {
      return handleAccountExport(request, env, url);
    }
    if (request.method === "POST" && url.pathname === "/api/account/delete") {
      return json({
        success: false,
        error: "DSAR delete requires signed-in proof of wallet ownership (SIWE), shipping in Phase 2. " +
               "For an immediate manual deletion, email privacy@defiscoring.com from a wallet you control.",
      }, 503);
    }
    if (request.method === "POST" && url.pathname === "/api/account/retention/run") {
      // Admin-only manual trigger. Gated by ADMIN_TOKEN (set via wrangler
      // secret), not by SIWE — this endpoint is for operations, not users.
      const tok = request.headers.get("X-Admin-Token") || "";
      if (!env.ADMIN_TOKEN || tok !== env.ADMIN_TOKEN) {
        return json({ success: false, error: "Forbidden." }, 403);
      }
      const summary = await runRetentionPrune(env);
      return json({ success: !!summary.ok, summary });
    }

    // Anything not handled above is a static asset request – delegate to the
    // attached Pages-style assets binding so the Jekyll site is served from
    // the same Worker.
    if (env.ASSETS) {
      try {
        const r = await env.ASSETS.fetch(request);
        // Layer security headers (HSTS, CSP, X-Frame-Options, Permissions-
        // Policy, COOP, CORP, Referrer-Policy, X-Content-Type-Options) on
        // every static response. Workers config (`wrangler.jsonc`) does NOT
        // pick up `cloudflare.toml` headers, so the Worker is the source of
        // truth here.
        return applySecurityHeaders(r);
      } catch (e) {
        return new Response("Asset error: " + (e && e.message ? e.message : String(e)), { status: 500 });
      }
    }
    return new Response("Not found", { status: 404, headers: corsHeadersFor(request, env) });
}
