// Exercise the wallet data path (/api/portfolio, /api/wallet-score) against a
// stubbed Etherscan v2 + CoinGecko so we can assert on shape, chain coverage,
// subrequest count, and persistence.
import { D1, KV } from "./d1.mjs";
import worker from "../worker/index.js";

const ORIGIN = "https://defiscoring.com";
const WALLET = "0x00000000000000000000000000000000000000aa";
const EMPTY_WALLET = "0x00000000000000000000000000000000000000ee";

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log((cond ? "PASS  " : "FAIL  ") + name + (cond ? "" : "  →  " + JSON.stringify(detail)));
}

const env = {
  HEALTH_DB: new D1("./migrations"),
  DEFI_CACHE: new KV(),
  ETHERSCAN_API_KEY: "stub",
  ALLOWED_ORIGINS: ORIGIN,
  SESSION_HMAC_KEY: "k",
};

let calls = { etherscan: 0, coingecko: 0, snapshot: 0, other: [] };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const u = String(input?.url || input);
  const J = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });

  if (u.startsWith("https://api.etherscan.io/v2/api")) {
    calls.etherscan++;
    const q = new URL(u).searchParams;
    const action = q.get("action");
    // EMPTY_WALLET: a brand-new address with zero footprint everywhere.
    // For eth_call the wallet is ABI-encoded inside `data`, not in the
    // `address` query param — match both places.
    const target = (q.get("address") || "").toLowerCase();
    const callData = (q.get("data") || "").toLowerCase();
    const emptyInCalldata = callData.includes(EMPTY_WALLET.slice(2));
    if (target === EMPTY_WALLET || emptyInCalldata) {
      if (action === "balance") return J({ status: "1", message: "OK", result: "0" });
      if (action === "tokentx") return J({ status: "0", message: "No token transfers found", result: [] });
      if (action === "txlist")  return J({ status: "0", message: "No transactions found", result: [] });
      if (action === "eth_call") return J({ jsonrpc: "2.0", id: 1, result: "0x" + "0".repeat(64 * 6) });
    }
    if (action === "balance") return J({ status: "1", message: "OK", result: "1500000000000000000" });
    if (action === "tokentx") {
      return J({ status: "1", message: "OK", result: [{
        contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        tokenSymbol: "USDC", tokenName: "USD Coin", tokenDecimal: "6",
      }] });
    }
    if (action === "eth_call") {
      // balanceOf → 1000 USDC ; Aave getUserAccountData → all zeros
      const data = q.get("data") || "";
      if (data.startsWith("0x70a08231")) {
        return J({ jsonrpc: "2.0", id: 1, result: "0x" + (1000n * 10n ** 6n).toString(16).padStart(64, "0") });
      }
      return J({ jsonrpc: "2.0", id: 1, result: "0x" + "0".repeat(64 * 6) });
    }
    if (action === "txlist") {
      return J({ status: "1", message: "OK", result: [{ timeStamp: String(Math.floor(Date.now() / 1000) - 86400 * 900) }] });
    }
    return J({ status: "0", message: "NOTOK", result: "unsupported in stub" });
  }
  // CoinGecko is "down" (429-style empty) for the whole test — the portfolio
  // must still be priced via the DefiLlama fallback tier.
  if (u.includes("coingecko.com")) { calls.coingecko++; return J({}); }
  if (u.includes("llama.fi")) {
    const keys = decodeURIComponent(u.split("/current/")[1] || "").split(",");
    const coins = {};
    for (const k of keys) {
      if (k === "coingecko:ethereum") coins[k] = { price: 3000, symbol: "ETH" };
      else if (k.endsWith("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")) coins[k] = { price: 1, symbol: "USDC" };
    }
    return J({ coins });
  }
  if (u.includes("snapshot.org")) { calls.snapshot++; return J({ data: { votes: [] } }); }
  calls.other.push(u);
  return J({});
};

async function call(path) {
  const res = await worker.fetch(
    new Request(ORIGIN + path, { headers: { origin: ORIGIN } }), env, { waitUntil() {} });
  return { status: res.status, json: await res.json() };
}

(async () => {
  // ---- portfolio
  calls = { etherscan: 0, coingecko: 0, snapshot: 0, other: [] };
  const p = await call("/api/portfolio?wallet=" + WALLET);
  check("GET /api/portfolio succeeds", p.json.success, p.json);
  check("portfolio defaults to the 5 Tier-1 chains", (p.json.chains || []).length === 5,
    (p.json.chains || []).map((c) => c.chain));
  check("native balance decoded", (p.json.positions || []).some((x) => x.symbol === "ETH" && x.amount === 1.5),
    (p.json.positions || []).slice(0, 3));
  check("ERC-20 balance decoded via balanceOf",
    (p.json.positions || []).some((x) => x.symbol === "USDC" && x.amount === 1000),
    (p.json.positions || []).slice(0, 3));
  check("no chain reported an error", (p.json.chains || []).every((c) => !c.errors),
    (p.json.chains || []).map((c) => c.errors).filter(Boolean));
  const portfolioSubrequests = calls.etherscan;

  // ---- wallet score
  calls = { etherscan: 0, coingecko: 0, snapshot: 0, other: [] };
  const s = await call("/api/wallet-score?wallet=" + WALLET);
  check("GET /api/wallet-score succeeds", s.json.success, s.json);
  check("score is in the FICO band", s.json.score >= 300 && s.json.score <= 850, s.json.score);
  check("all five pillars present", Object.keys(s.json.pillars || {}).length === 5, Object.keys(s.json.pillars || {}));
  check("portfolio pillar sees real data", s.json.pillars?.portfolio_health?.real === true,
    s.json.pillars?.portfolio_health);
  check("account_age pillar sees real data", s.json.pillars?.account_age?.real === true,
    s.json.pillars?.account_age);

  // Chain coverage must match the portfolio half of the same score.
  check("wallet-score stays inside the Tier-1 subrequest budget",
    calls.etherscan < 50, { etherscan: calls.etherscan, portfolioAlone: portfolioSubrequests });

  // ---- persistence + badge
  const row = await env.HEALTH_DB
    .prepare("SELECT wallet, score FROM health_scores ORDER BY computed_at DESC LIMIT 1").first();
  check("wallet-score persists a health_scores row", row && row.wallet === WALLET && row.score === s.json.score, row);

  const badge = await worker.fetch(new Request(ORIGIN + "/badge/" + WALLET + ".svg"), env, { waitUntil() {} });
  const svg = await badge.text();
  check("badge renders the persisted score", badge.status === 200 && svg.includes(String(s.json.score)),
    svg.slice(0, 160));

  // ---- all-chain opt-in
  calls = { etherscan: 0, coingecko: 0, snapshot: 0, other: [] };
  const all = await call("/api/wallet-score?wallet=" + WALLET + "&tier=all");
  check("?tier=all is honoured end to end", all.json.success, all.json.error);

  const bad = await call("/api/wallet-score?wallet=0xnope");
  check("invalid address rejected", bad.status === 400, bad.json);

  // ---- honest unscored state for a wallet with no footprint
  const rowsBefore = (await env.HEALTH_DB
    .prepare("SELECT COUNT(*) c FROM health_scores").first()).c;
  const es = await call("/api/wallet-score?wallet=" + EMPTY_WALLET);
  check("empty wallet returns scored:false (not a fabricated number)",
    es.json.success && es.json.scored === false && es.json.score === null &&
    es.json.reason === "no_onchain_history", es.json);
  check("unscored payload still explains what was checked",
    !!es.json.explanation && Object.keys(es.json.pillars || {}).length === 5,
    { explanation: es.json.explanation });
  const rowsAfter = (await env.HEALTH_DB
    .prepare("SELECT COUNT(*) c FROM health_scores").first()).c;
  check("unscored result is not persisted to health_scores",
    rowsAfter === rowsBefore, { rowsBefore, rowsAfter });

  globalThis.fetch = realFetch;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
})().catch((e) => { console.error("HARNESS ERROR", e); process.exitCode = 2; });
