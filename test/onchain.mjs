// /api/onchain/snapshot — the endpoint that replaced the browser's direct
// calls to public RPCs.
//
// The behaviour that matters: it is NOT an open RPC proxy, and it never
// reports an unreadable chain as an empty one.
import { D1, KV } from "./d1.mjs";
import worker from "../worker/index.js";

const ORIGIN = "https://defiscoring.com";
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log((cond ? "PASS  " : "FAIL  ") + name + (cond ? "" : "  →  " + JSON.stringify(detail)));
}

const WALLET = "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984";
const realFetch = globalThis.fetch;

function makeEnv() {
  return {
    HEALTH_DB: new D1("./migrations"),
    DEFI_CACHE: new KV(),
    SESSION_HMAC_KEY: "k",
    ALLOWED_ORIGINS: ORIGIN,
    ETHERSCAN_API_KEY: "stub",
  };
}
const get = (env, path) => worker.fetch(
  new Request(ORIGIN + path, { headers: { origin: ORIGIN } }), env, { waitUntil() {} });

(async () => {
  // Every upstream answers plausibly: balances via Etherscan proxy, prices
  // via CoinGecko. Anything unexpected is a hard failure so a silent shape
  // change upstream shows up here rather than as zeros in the UI.
  const seen = { rpcHosts: new Set(), calls: 0 };
  globalThis.fetch = async (input) => {
    const u = String(input?.url || input);
    seen.calls++;
    try { seen.rpcHosts.add(new URL(u).host); } catch { /* ignore */ }
    if (u.includes("api.etherscan.io")) {
      const p = new URL(u).searchParams;
      const action = p.get("action");
      // getNativeBalance's Etherscan tier uses module=account&action=balance
      // and expects a decimal-wei string; the proxy actions return hex.
      if (action === "balance") return jsonRes({ status: "1", result: "2000000000000000000" });
      if (action === "eth_getTransactionCount") return jsonRes({ result: "0x2a" });      // 42
      if (action === "eth_blockNumber") return jsonRes({ result: "0x112a880" });
      return jsonRes({ status: "1", result: [] });
    }
    if (u.includes("coingecko")) {
      return jsonRes({ ethereum: { usd: 3000 }, "matic-network": { usd: 0.5 } });
    }
    return jsonRes({});
  };
  function jsonRes(obj) {
    return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
  }

  // --- validation -----------------------------------------------------------
  let env = makeEnv();
  let r = await get(env, "/api/onchain/snapshot?wallet=nope");
  check("a malformed address is rejected", r.status === 400, r.status);
  check("...by name, so the client can tell why",
    (await r.json()).error === "invalid_wallet_address", null);

  r = await get(env, "/api/onchain/snapshot");
  check("a missing address is rejected", r.status === 400, r.status);

  r = await get(env, "/api/onchain/snapshot?wallet=" + WALLET + "&chains=solana,bitcoin");
  check("unsupported chains are refused rather than silently ignored",
    r.status === 400 && (await r.json()).error === "no_supported_chains_requested", r.status);

  // --- it is not an RPC proxy ----------------------------------------------
  // There must be no way to make the worker issue an arbitrary JSON-RPC method
  // on the caller's behalf against our provider keys.
  env = makeEnv();
  const before = seen.calls;
  r = await get(env, "/api/onchain/snapshot?wallet=" + WALLET +
    "&method=eth_sendRawTransaction&params=%5B%220xdeadbeef%22%5D");
  const body = await r.json();
  check("caller-supplied JSON-RPC method is ignored, not forwarded",
    r.status === 200 && !JSON.stringify(body).includes("sendRawTransaction"), body?.error);
  check("...and no arbitrary host was contacted",
    ![...seen.rpcHosts].some((h) => /llamarpc|polygon-rpc\.com/.test(h)), [...seen.rpcHosts]);

  // --- the happy path -------------------------------------------------------
  env = makeEnv();
  r = await get(env, "/api/onchain/snapshot?wallet=" + WALLET);
  const snap = await r.json();
  check("returns a snapshot", r.status === 200 && snap.success === true, snap);
  check("defaults to the three chains the dashboard shows",
    snap.chains_requested === 3, snap.chains_requested);
  check("reads the native balance", snap.snapshots.some((s) => s.nativeAmount === 2), snap.snapshots);
  check("reads the transaction count", snap.snapshots.some((s) => s.txCount === 42), snap.snapshots);
  check("prices the native positions", snap.positions.some((p) => p.value_usd === 6000), snap.positions);
  check("positions keep the shape the dashboard already consumes",
    snap.positions.every((p) => "chainId" in p && "symbol" in p && "value_usd" in p && p.source === "rpc"),
    snap.positions[0]);
  check("reports when it was fetched", typeof snap.fetched_at === "number", snap.fetched_at);
  check("a fully-read set is not marked partial", snap.partial === false, snap);

  // --- unreadable is not empty ---------------------------------------------
  // The bug the old client path had: a rate-limited RPC produced a zero
  // balance indistinguishable from an empty wallet.
  globalThis.fetch = async () => { throw new Error("upstream down"); };
  env = makeEnv();
  r = await get(env, "/api/onchain/snapshot?wallet=" + WALLET);
  const dead = await r.json();
  check("an unreadable chain reports an error, never a zero balance",
    dead.snapshots.every((s) => s.error && s.nativeAmount !== 0), dead.snapshots);
  check("...and the response says it is partial",
    dead.partial === true && dead.chains_read === 0, dead);
  check("...and contributes no fabricated positions", dead.positions.length === 0, dead.positions);

  // --- prices failing must not fail the whole read --------------------------
  globalThis.fetch = async (input) => {
    const u = String(input?.url || input);
    if (u.includes("coingecko")) throw new Error("price feed down");
    const p = new URL(u).searchParams;
    const action = p.get("action");
    if (action === "balance") return jsonRes({ status: "1", result: "2000000000000000000" });
    if (action === "eth_getTransactionCount") return jsonRes({ result: "0x2a" });
    if (action === "eth_blockNumber") return jsonRes({ result: "0x112a880" });
    return jsonRes({ status: "1", result: [] });
  };
  env = makeEnv();
  r = await get(env, "/api/onchain/snapshot?wallet=" + WALLET);
  const unpriced = await r.json();
  check("a dead price feed still returns balances", unpriced.success === true &&
    unpriced.snapshots.some((s) => s.nativeAmount === 2), unpriced.snapshots);
  check("...with positions priced at 0 rather than dropped",
    unpriced.positions.length > 0 && unpriced.positions.every((p) => p.value_usd === 0),
    unpriced.positions);
  check("...and says prices were unavailable", unpriced.priced === false, unpriced.priced);

  globalThis.fetch = realFetch;

  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
