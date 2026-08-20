// Exercise the wallet data path (/api/portfolio, /api/wallet-score) against a
// stubbed Etherscan v2 + CoinGecko so we can assert on shape, chain coverage,
// subrequest count, and persistence.
import { D1, KV } from "./d1.mjs";
import worker from "../worker/index.js";
import { BANDS, bandForScore, coverageOf, PILLAR_WEIGHTS } from "../worker/lib/score.js";

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

  // ---- score coverage ----------------------------------------------------
  // WALLET resolves four of five pillars against the stub — portfolio_health
  // (.25), liquidity_provision (.15), governance (.10) and account_age (.15).
  // Only loan_reliability (.35) finds nothing, because the stubbed Aave
  // getUserAccountData returns all zeros. So coverage is 1 - .35 = .65.
  const pl = s.json.pillars || {};
  const expectedCoverage = Number(
    [["loan_reliability", 0.35], ["portfolio_health", 0.25], ["liquidity_provision", 0.15],
     ["governance", 0.10], ["account_age", 0.15]]
      .reduce((sum, [k, w]) => sum + (pl[k]?.real ? w : 0), 0).toFixed(4));
  check("scored payload reports coverage",
    typeof s.json.coverage === "number", s.json.coverage);
  check("coverage is the summed weight of pillars with real data",
    s.json.coverage === expectedCoverage,
    { got: s.json.coverage, expected: expectedCoverage,
      real: Object.fromEntries(Object.entries(pl).map(([k, v]) => [k, v.real])) });
  check("this wallet is the mixed real/estimated case, not all-or-nothing",
    s.json.coverage > 0 && s.json.coverage < 1, s.json.coverage);
  check("coverage stays within 0..1", s.json.coverage >= 0 && s.json.coverage <= 1, s.json.coverage);

  // Pin the exact value so a weight change has to be deliberate rather than
  // silently absorbed by the derived assertion above.
  check("mixed pillar set yields 0.65 coverage", s.json.coverage === 0.65,
    { coverage: s.json.coverage,
      real: Object.entries(pl).filter(([, v]) => v.real).map(([k]) => k) });
  check("the one estimated pillar is loan_reliability, worth .35",
    pl.loan_reliability?.real === false && pl.loan_reliability?.weight === 0.35,
    { real: pl.loan_reliability?.real, weight: pl.loan_reliability?.weight });

  // ---- coverageOf across every real/estimated combination ----------------
  // Exhaustive rather than sampled: with 5 pillars there are only 32 states,
  // and exactly one of them (loan_reliability + governance) is the float-drift
  // case the rounding guard exists for. A spot-check would likely miss it.
  const keys = Object.keys(PILLAR_WEIGHTS);
  const drifty = [];
  let allSubsetsClean = true;
  for (let mask = 0; mask < 32; mask++) {
    const pillars = {};
    let raw = 0;
    keys.forEach((k, i) => {
      const real = !!(mask & (1 << i));
      pillars[k] = { real };
      if (real) raw += PILLAR_WEIGHTS[k];
    });
    const got = coverageOf(pillars);
    // Must equal the mathematically correct value to 4dp, and must be free of
    // float noise — i.e. exactly representable as hundredths of a percent.
    if (Math.abs(got - raw) > 1e-9 || !Number.isInteger(Math.round(got * 10000)) ||
        got !== Number(got.toFixed(4))) allSubsetsClean = false;
    if (got !== raw) drifty.push({ mask, raw, got });
  }
  check("coverageOf is drift-free for all 32 pillar combinations", allSubsetsClean, drifty);
  check("the known float-drift combination is corrected",
    coverageOf({ loan_reliability: { real: true }, governance: { real: true } }) === 0.45,
    { got: coverageOf({ loan_reliability: { real: true }, governance: { real: true } }),
      unrounded: 0.35 + 0.10 });
  check("all pillars real is exactly 1",
    coverageOf(Object.fromEntries(keys.map((k) => [k, { real: true }]))) === 1);
  check("no pillars real is exactly 0",
    coverageOf(Object.fromEntries(keys.map((k) => [k, { real: false }]))) === 0);
  check("coverageOf tolerates a missing/degenerate pillar map",
    coverageOf({}) === 0 && coverageOf(null) === 0 && coverageOf(undefined) === 0);
  check("PILLAR_WEIGHTS sums to 1",
    Number(Object.values(PILLAR_WEIGHTS).reduce((a, b) => a + b, 0).toFixed(4)) === 1,
    Object.values(PILLAR_WEIGHTS));

  check("coverage weights match the weights published in the pillars",
    Object.entries(pl).reduce((sum, [, v]) => sum + (v.weight || 0), 0).toFixed(4) === "1.0000",
    Object.entries(pl).map(([k, v]) => [k, v.weight]));

  globalThis.fetch = realFetch;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
})().catch((e) => { console.error("HARNESS ERROR", e); process.exitCode = 2; });
