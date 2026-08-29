/* DeFiScoring – on-chain snapshot for the browser
 *
 *   GET /api/onchain/snapshot?wallet=0x…[&chains=ethereum,arbitrum]
 *
 * Replaces the direct browser→public-RPC calls that assets/js/defi-onchain.js
 * used to make against eth.llamarpc.com, polygon-rpc.com and CoinGecko.
 *
 * WHY A NARROW ENDPOINT RATHER THAN AN RPC PROXY: forwarding arbitrary
 * JSON-RPC on behalf of anonymous callers would make this an open relay
 * against our own provider keys — anyone could point a bot at it and burn the
 * Alchemy quota, or use us to reach hosts we would rather not be seen calling.
 * So the browser gets exactly the three reads it actually needs, per chain,
 * and nothing else is reachable.
 *
 * It also fixes what the old client path got wrong: those public RPCs are rate
 * limited per client IP and CORS-fragile, so a wallet on a busy network simply
 * saw zeros. Here the reads go through the same tiered provider stack (Alchemy
 * → Moralis → Etherscan) the rest of the worker uses, and a chain that could
 * not be read reports an error instead of a zero balance — "we could not look"
 * and "there is nothing here" are different answers.
 */

import { CHAINS } from "../lib/chains.js";
import { getNativeBalance, getTransactionCount, getLatestBlockNumber } from "../lib/providers.js";
import { priceMultipleNatives } from "../lib/prices.js";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

// The browser dashboard only ever showed these three. Keeping the default
// narrow keeps the subrequest cost of an anonymous call bounded.
const DEFAULT_CHAIN_IDS = ["ethereum", "arbitrum", "polygon"];
const MAX_CHAINS = 5;

export async function handleOnchainSnapshot(request, env, corsHeaders = {}) {
  const url = new URL(request.url);
  const wallet = (url.searchParams.get("wallet") || url.searchParams.get("address") || "").trim();
  if (!ADDR_RE.test(wallet)) {
    return json({ success: false, error: "invalid_wallet_address" }, 400, corsHeaders);
  }

  const requested = (url.searchParams.get("chains") || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const wanted = (requested.length ? requested : DEFAULT_CHAIN_IDS).slice(0, MAX_CHAINS);

  const chains = wanted
    .map((id) => CHAINS.find((c) => c.id === id))
    .filter(Boolean);
  if (!chains.length) {
    return json({ success: false, error: "no_supported_chains_requested" }, 400, corsHeaders);
  }

  const snapshots = await Promise.all(chains.map(async (chain) => {
    const base = {
      chain: chain.id,
      chainName: chain.name,
      symbol: chain.nativeSymbol || chain.symbol || "ETH",
      explorer: chain.explorer || null,
    };
    try {
      // Balance is the only read we treat as load-bearing. A failed nonce or
      // block number degrades a detail; a failed balance means we do not know
      // the answer and must not imply zero.
      const nativeAmount = await getNativeBalance(chain, env, wallet);
      const [txCount, latestBlock] = await Promise.all([
        getTransactionCount(chain, env, wallet).catch(() => null),
        getLatestBlockNumber(chain, env).catch(() => null),
      ]);
      return { ...base, nativeAmount, txCount, latestBlock };
    } catch (e) {
      return { ...base, error: String(e?.message || e).slice(0, 160), nativeAmount: null };
    }
  }));

  // One priced call for every distinct native asset across the set.
  const ids = [...new Set(chains.map((c) => c.nativeCoingeckoId).filter(Boolean))];
  let prices = {};
  try {
    prices = await priceMultipleNatives(env, url.searchParams.get("fiat") || "USD", ids);
  } catch { /* priced positions degrade to unpriced, never to an error */ }

  const fiat = (url.searchParams.get("fiat") || "USD").toLowerCase();
  const positions = [];
  for (let i = 0; i < chains.length; i++) {
    const s = snapshots[i];
    if (s.error || !s.nativeAmount) continue;
    const id = chains[i].nativeCoingeckoId;
    const price = (id && prices[id] && prices[id][fiat]) || 0;
    positions.push({
      name: "Native " + s.symbol,
      chain: s.chainName,
      chainId: s.chain,
      amount: s.nativeAmount,
      symbol: s.symbol,
      price_usd: price,
      value_usd: s.nativeAmount * price,
      source: "rpc",
    });
  }

  const readable = snapshots.filter((s) => !s.error).length;
  return json({
    success: true,
    wallet: wallet.toLowerCase(),
    // Say plainly how much of the requested set we actually read, so the UI
    // can distinguish an empty wallet from an unreadable one.
    chains_requested: chains.length,
    chains_read: readable,
    partial: readable < chains.length,
    snapshots,
    positions,
    priced: Object.keys(prices).length > 0,
    fetched_at: Date.now(),
  }, 200, corsHeaders);
}
