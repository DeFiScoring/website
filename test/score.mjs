// Exercise the wallet data path (/api/portfolio, /api/wallet-score) against a
// stubbed Etherscan v2 + CoinGecko so we can assert on shape, chain coverage,
// subrequest count, and persistence.
import { D1, KV } from "./d1.mjs";
import worker from "../worker/index.js";
import { BANDS, bandForScore } from "../worker/lib/score.js";

const ORIGIN = "https://defiscoring.com";
const WALLET = "0x00000000000000000000000000000000000000aa";
const EMPTY_WALLET = "0x00000000000000000000000000000000000000ee";
// Two years of history on Base and nothing on Ethereum — the case that used
// to read as a brand-new wallet because the pillar only queried chainid=1.
const BASE_WALLET = "0x00000000000000000000000000000000000000ba";
const BASE_CHAIN_ID = "8453";
const BASE_AGE_DAYS = 800;
// History on two chains at different ages — proves the OLDEST wins rather
// than whichever chain happens to answer first.
const MULTI_WALLET = "0x00000000000000000000000000000000000000bc";
const MULTI_ETH_AGE_DAYS = 300;
const MULTI_BASE_AGE_DAYS = 900;
// Every first-tx lookup errors — an outage must not read as a new wallet.
const FAIL_WALLET = "0x00000000000000000000000000000000000000fa";
// No history on the first scan, real history on the second — a "no history
// yet" answer must not be cached, or a freshly-used wallet stays age-zero
// until the TTL expires.
const FRESH_WALLET = "0x00000000000000000000000000000000000000fb";
const FRESH_AGE_DAYS = 45;
let freshScans = 0;

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

let calls = { etherscan: 0, coingecko: 0, snapshot: 0, txlistChains: [], other: [] };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const u = String(input?.url || input);
  const J = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });

  if (u.startsWith("https://api.etherscan.io/v2/api")) {
    calls.etherscan++;
    const q = new URL(u).searchParams;
    const action = q.get("action");
    const chainid = q.get("chainid");

    // ---- Base-native wallet ------------------------------------------------
    // History on Base only. Every other read is empty so the wallet's age is
    // the only real signal it has.
    const dataParam = (q.get("data") || "").toLowerCase();
    if ((q.get("address") || "").toLowerCase() === BASE_WALLET ||
        dataParam.includes(BASE_WALLET.slice(2))) {
      if (action === "txlist") {
        calls.txlistChains.push(chainid);
        if (chainid === BASE_CHAIN_ID) {
          return J({ status: "1", message: "OK", result: [{
            timeStamp: String(Math.floor(Date.now() / 1000) - 86400 * BASE_AGE_DAYS) }] });
        }
        return J({ status: "0", message: "No transactions found", result: [] });
      }
      if (action === "balance") return J({ status: "1", message: "OK", result: "0" });
      if (action === "tokentx") return J({ status: "0", message: "No token transfers found", result: [] });
      if (action === "eth_call") return J({ jsonrpc: "2.0", id: 1, result: "0x" + "0".repeat(64 * 6) });
    }
    // ---- two-chain wallet: older history on Base than on Ethereum ---------
    if ((q.get("address") || "").toLowerCase() === MULTI_WALLET ||
        dataParam.includes(MULTI_WALLET.slice(2))) {
      if (action === "txlist") {
        calls.txlistChains.push(chainid);
        const days = chainid === "1" ? MULTI_ETH_AGE_DAYS
                   : chainid === BASE_CHAIN_ID ? MULTI_BASE_AGE_DAYS : null;
        if (days == null) return J({ status: "0", message: "No transactions found", result: [] });
        return J({ status: "1", message: "OK", result: [{
          timeStamp: String(Math.floor(Date.now() / 1000) - 86400 * days) }] });
      }
      if (action === "balance") return J({ status: "1", message: "OK", result: "0" });
      if (action === "tokentx") return J({ status: "0", message: "No token transfers found", result: [] });
      if (action === "eth_call") return J({ jsonrpc: "2.0", id: 1, result: "0x" + "0".repeat(64 * 6) });
    }

    // ---- wallet whose first-tx lookups all fail ---------------------------
    // status 0 with a non-"No ... found" message is a real error, so
    // etherscanCall throws and getFirstTxTimestamp reports ok:false.
    if ((q.get("address") || "").toLowerCase() === FAIL_WALLET ||
        dataParam.includes(FAIL_WALLET.slice(2))) {
      if (action === "txlist") {
        calls.txlistChains.push(chainid);
        return J({ status: "0", message: "NOTOK", result: "Max rate limit reached" });
      }
      if (action === "balance") return J({ status: "1", message: "OK", result: "0" });
      if (action === "tokentx") return J({ status: "0", message: "No token transfers found", result: [] });
      if (action === "eth_call") return J({ jsonrpc: "2.0", id: 1, result: "0x" + "0".repeat(64 * 6) });
    }

    // ---- wallet that gains history between scans --------------------------
    if ((q.get("address") || "").toLowerCase() === FRESH_WALLET ||
        dataParam.includes(FRESH_WALLET.slice(2))) {
      if (action === "txlist") {
        calls.txlistChains.push(chainid);
        if (freshScans === 0 || chainid !== "1") {
          return J({ status: "0", message: "No transactions found", result: [] });
        }
        return J({ status: "1", message: "OK", result: [{
          timeStamp: String(Math.floor(Date.now() / 1000) - 86400 * FRESH_AGE_DAYS) }] });
      }
      if (action === "balance") return J({ status: "1", message: "OK", result: "0" });
      if (action === "tokentx") return J({ status: "0", message: "No token transfers found", result: [] });
      if (action === "eth_call") return J({ jsonrpc: "2.0", id: 1, result: "0x" + "0".repeat(64 * 6) });
    }

    if (action === "txlist") calls.txlistChains.push(chainid);
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
  calls = { etherscan: 0, coingecko: 0, snapshot: 0, txlistChains: [], other: [] };
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
  calls = { etherscan: 0, coingecko: 0, snapshot: 0, txlistChains: [], other: [] };
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

  // ---- band-threshold boundary: badge must agree with the score payload
  //
  // Regression test for the drift documented in worker/lib/score.js's BANDS
  // comment: the badge and the score payload used to redeclare 720/660/580
  // independently, and the dashboard had its own copy at 750/670/580 — the
  // same wallet could show a different band on its badge than on its score.
  // 720 is the exact floor of "excellent"; one point below it (719) must
  // fall to "good", proving the boundary itself — not just the interior of
  // a band — is shared correctly.
  check("BANDS floor for 'excellent' is exactly 720 (canonical value)",
    BANDS.find((b) => b.key === "excellent")?.floor === 720, BANDS);
  check("bandForScore(720) === 'excellent'", bandForScore(720) === "excellent", bandForScore(720));
  check("bandForScore(719) === 'good' (one point under the floor)",
    bandForScore(719) === "good", bandForScore(719));

  const BOUNDARY_WALLET = "0x00000000000000000000000000000000000000bb";
  await env.HEALTH_DB.prepare(
    "INSERT INTO health_scores (wallet, score, computed_at) VALUES (?, 720, ?)"
  ).bind(BOUNDARY_WALLET, Date.now()).run();
  const boundaryBadge = await worker.fetch(
    new Request(ORIGIN + "/badge/" + BOUNDARY_WALLET + ".svg"), env, { waitUntil() {} });
  const boundarySvg = await boundaryBadge.text();
  // computeWalletScore uses the same bandForScore the badge does, so at the
  // exact floor both must land on the same label ("Excellent"), not one
  // rounding down to "Good" while the other reads the boundary inclusively.
  const expectedLabel = bandForScore(720)[0].toUpperCase() + bandForScore(720).slice(1);
  check("badge band at score=720 matches computeWalletScore's score_band ('excellent')",
    boundaryBadge.status === 200 && boundarySvg.includes(">" + expectedLabel + "<"),
    { expectedLabel, svg: boundarySvg.slice(0, 200) });

  // ---- all-chain opt-in
  calls = { etherscan: 0, coingecko: 0, snapshot: 0, txlistChains: [], other: [] };
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

  // ---- multichain account age -------------------------------------------
  // Regression: pillarAccountAge hardcoded chainid=1, so this wallet's two
  // years of Base history were invisible and it scored 25/100 as "brand new"
  // on a pillar carrying 15% of the composite.
  calls = { etherscan: 0, coingecko: 0, snapshot: 0, txlistChains: [], other: [] };
  const bw = await call("/api/wallet-score?wallet=" + BASE_WALLET);
  const ag = bw.json.pillars?.account_age;
  check("Base-only history is found, not read as a new wallet",
    ag?.real === true && ag?.firstTxAt != null, ag);
  check("age comes from the Base first tx",
    Math.abs((ag?.ageDays ?? 0) - BASE_AGE_DAYS) <= 1, ag?.ageDays);
  check("a two-year-old Base wallet scores the 1-3 year band, not the <30d band",
    ag?.value === 85, { value: ag?.value, ageDays: ag?.ageDays });
  check("the rationale names the chain the age came from",
    /Base/.test(ag?.rationale || ""), ag?.rationale);
  check("firstTxChain is reported", ag?.firstTxChain === "Base", ag?.firstTxChain);

  // Exactly one first-tx lookup per Tier-1 chain, no more.
  const tier1Ids = ["1", "10", "42161", "8453", "137"];
  const uniqueTxlistChains = [...new Set(calls.txlistChains)].sort();
  check("queries every Tier-1 chain for first-tx",
    tier1Ids.slice().sort().every((c) => uniqueTxlistChains.includes(c)),
    uniqueTxlistChains);
  check("first-tx costs exactly 5 subrequests, one per Tier-1 chain",
    calls.txlistChains.length === 5, calls.txlistChains);
  check("Base wallet stays inside the subrequest budget", calls.etherscan < 50, calls.etherscan);

  // The wallet has no balances anywhere, so age is what keeps it scorable —
  // it must not fall through the honest-score gate as "no on-chain history".
  check("a Base-native wallet with age but no balances is still scored",
    bw.json.scored === true && typeof bw.json.score === "number", 
    { scored: bw.json.scored, score: bw.json.score, reason: bw.json.reason });

  // Second call: the cached timestamp means no repeat first-tx lookups.
  calls = { etherscan: 0, coingecko: 0, snapshot: 0, txlistChains: [], other: [] };
  const bw2 = await call("/api/wallet-score?wallet=" + BASE_WALLET);
  const ag2 = bw2.json.pillars?.account_age;
  check("cached first-tx costs zero further lookups",
    calls.txlistChains.length === 0, calls.txlistChains);
  check("cached age matches the uncached age", ag2?.ageDays === ag?.ageDays,
    { cached: ag2?.ageDays, fresh: ag?.ageDays });
  check("cache hit is flagged and keeps the chain name",
    ag2?.cached === true && ag2?.firstTxChain === "Base", ag2);

  // Oldest across chains wins, not first-to-answer or most-recent.
  const mw = await call("/api/wallet-score?wallet=" + MULTI_WALLET);
  const mag = mw.json.pillars?.account_age;
  check("with history on two chains the OLDEST first-tx wins",
    Math.abs((mag?.ageDays ?? 0) - MULTI_BASE_AGE_DAYS) <= 1,
    { ageDays: mag?.ageDays, base: MULTI_BASE_AGE_DAYS, ethereum: MULTI_ETH_AGE_DAYS });
  check("the oldest chain is the one named",
    mag?.firstTxChain === "Base", { firstTxChain: mag?.firstTxChain, rationale: mag?.rationale });
  check("bridging to Ethereum later does not reset the wallet's age",
    (mag?.ageDays ?? 0) > MULTI_ETH_AGE_DAYS, mag?.ageDays);

  // A total lookup failure grades our infrastructure, not the wallet — it
  // must stay neutral rather than scoring as a brand-new address.
  calls = { etherscan: 0, coingecko: 0, snapshot: 0, txlistChains: [], other: [] };
  const fw = await call("/api/wallet-score?wallet=" + FAIL_WALLET);
  const fag = fw.json.pillars?.account_age;
  check("first-tx lookups all failing yields neutral 50, not an age of zero",
    fag?.real === false && fag?.value === 50, fag);
  check("the failed-lookup rationale says the lookup failed",
    /failed/i.test(fag?.rationale || ""), fag?.rationale);
  check("a failed lookup is not cached as a result",
    calls.txlistChains.length === 5, calls.txlistChains);

  // "No history yet" must not be cached: it is the one answer that can change
  // to something else within the TTL.
  const f1 = await call("/api/wallet-score?wallet=" + FRESH_WALLET);
  check("a wallet with no history reads as observed-empty",
    f1.json.pillars?.account_age?.real === true &&
    f1.json.pillars?.account_age?.firstTxAt === null,
    f1.json.pillars?.account_age);
  freshScans = 1;  // the wallet now has an Ethereum transaction
  calls = { etherscan: 0, coingecko: 0, snapshot: 0, txlistChains: [], other: [] };
  const f2 = await call("/api/wallet-score?wallet=" + FRESH_WALLET);
  check("a later scan re-queries instead of serving a cached 'no history'",
    calls.txlistChains.length === 5, calls.txlistChains);
  check("newly-acquired history is picked up, not frozen at age zero",
    Math.abs((f2.json.pillars?.account_age?.ageDays ?? -1) - FRESH_AGE_DAYS) <= 1,
    f2.json.pillars?.account_age);

  // Distinguishing "no history" from "lookup failed" — the pillar must not
  // score an outage as a brand-new wallet.
  const NOHIST = "0x00000000000000000000000000000000000000ee";
  const nh = await call("/api/wallet-score?wallet=" + NOHIST);
  check("a wallet with no history on any chain is observed, not neutral",
    nh.json.pillars?.account_age?.real === true &&
    nh.json.pillars?.account_age?.value === 20,
    nh.json.pillars?.account_age);

  globalThis.fetch = realFetch;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
})().catch((e) => { console.error("HARNESS ERROR", e); process.exitCode = 2; });
