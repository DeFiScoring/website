// Exercise the wallet data path (/api/portfolio, /api/wallet-score) against a
// stubbed Etherscan v2 + CoinGecko so we can assert on shape, chain coverage,
// subrequest count, and persistence.
import { D1, KV } from "./d1.mjs";
import worker from "../worker/index.js";
import { BANDS, bandForScore, coverageOf, PILLAR_WEIGHTS, pillarLoanReliability } from "../worker/lib/score.js";
import { COMPOUND_V3_MARKETS } from "../worker/lib/defi-protocols.js";

const ORIGIN = "https://defiscoring.com";
const WALLET = "0x00000000000000000000000000000000000000aa";
const EMPTY_WALLET = "0x00000000000000000000000000000000000000ee";
// Borrows on Compound V3 with collateral behind it — the case that used to
// score as "no lending history" because the pillar only matched aave-v3.
const BORROWER = "0x00000000000000000000000000000000000000bb";

// Comet stub fixtures. Chosen so the derived health factor is exact:
//   5 WETH x $3,000       = $15,000 collateral
//   x 0.85 liquidation CF = $12,750 risk-adjusted
//   / $5,000 borrowed     = HF 2.55 -> the 2.0-3.0 band -> value 85
const CWETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const CFEED = "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419";
const COMET_ADDRS = new Set(
  Object.values(COMPOUND_V3_MARKETS).flat().map((m) => m.address.toLowerCase()));
const COMET_ETH_MARKET = COMPOUND_V3_MARKETS.ethereum[0].address.toLowerCase();
const COMET_BORROW_USD = 5000;
const COMET_WETH_AMOUNT = 5;
const COMET_WETH_PRICE = 3000;
const COMET_LIQ_CF = 0.85;
const EXPECTED_HF = (COMET_WETH_AMOUNT * COMET_WETH_PRICE * COMET_LIQ_CF) / COMET_BORROW_USD;

const w = (v) => BigInt(v).toString(16).padStart(64, "0");
const addrW = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const cfW = (f) => w(BigInt(Math.round(f * 1e18)));
// AssetInfo: (uint8 offset, address asset, address priceFeed, uint64 scale,
//             uint64 borrowCF, uint64 liquidateCF, uint128 supplyCap)
const assetInfo = (asset, feed, scale, liqCf) =>
  "0x" + w(0) + addrW(asset) + addrW(feed) + w(BigInt(scale)) +
  cfW(liqCf - 0.05) + cfW(liqCf) + w(0);

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

let calls = { etherscan: 0, coingecko: 0, snapshot: 0, cometPrice: 0, other: [] };
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
    // ---- Compound V3 Comet ------------------------------------------------
    // Intercepted by contract address so Comet's balanceOf (supply) is not
    // answered by the generic ERC-20 balanceOf branch below. Every wallet
    // reads zero here except BORROWER.
    const to = (q.get("to") || "").toLowerCase();
    if (action === "eth_call" && COMET_ADDRS.has(to)) {
      const d = callData;
      const sel = d.slice(0, 10);
      const arg = (n) => "0x" + d.slice(10 + n * 64 + 24, 10 + (n + 1) * 64);
      const Z = J({ jsonrpc: "2.0", id: 1, result: "0x" + w(0) });
      // Only the Ethereum market carries the position, so the multi-chain
      // scan also proves the pillar does not double-count across chains.
      if (to !== COMET_ETH_MARKET) return Z;
      // numAssets/getAssetInfo/getPrice describe the market, not the wallet —
      // their calldata carries no address, so only gate the per-wallet reads.
      const WALLET_SCOPED = new Set(["0x70a08231", "0x374c49b4", "0x2b92a07d", "0x042e02cf"]);
      if (WALLET_SCOPED.has(sel) && !d.includes(BORROWER.slice(2))) return Z;
      switch (sel) {
        case "0x70a08231": return Z;                                    // balanceOf -> no supply
        case "0x374c49b4":                                              // borrowBalanceOf
          return J({ jsonrpc: "2.0", id: 1, result: "0x" + w(BigInt(COMET_BORROW_USD) * 10n ** 6n) });
        case "0xa46fe83b": return J({ jsonrpc: "2.0", id: 1, result: "0x" + w(2) });  // numAssets
        case "0xc8c7fe6b": {                                            // getAssetInfo(i)
          const i = Number(BigInt("0x" + d.slice(10, 74)));
          if (i === 0) return J({ jsonrpc: "2.0", id: 1, result: assetInfo(CWETH, CFEED, 10n ** 18n, COMET_LIQ_CF) });
          // A second configured asset the wallet holds none of — it must be
          // skipped without costing a getPrice call.
          return J({ jsonrpc: "2.0", id: 1,
            result: assetInfo("0x" + "22".repeat(20), "0x" + "33".repeat(20), 10n ** 8n, 0.7) });
        }
        case "0x2b92a07d":                                              // userCollateral(user, asset)
          return arg(1) === CWETH
            ? J({ jsonrpc: "2.0", id: 1, result: "0x" + w(BigInt(COMET_WETH_AMOUNT) * 10n ** 18n) + w(0) })
            : J({ jsonrpc: "2.0", id: 1, result: "0x" + w(0) + w(0) });
        case "0x41976e09":                                              // getPrice(feed)
          calls.cometPrice++;
          return arg(0) === CFEED
            ? J({ jsonrpc: "2.0", id: 1, result: "0x" + w(BigInt(COMET_WETH_PRICE) * 10n ** 8n) })
            : Z;
        case "0x042e02cf": return Z;                                    // isLiquidatable -> false
        default: return Z;
      }
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
  calls = { etherscan: 0, coingecko: 0, snapshot: 0, cometPrice: 0, other: [] };
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
  calls = { etherscan: 0, coingecko: 0, snapshot: 0, cometPrice: 0, other: [] };
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
  calls = { etherscan: 0, coingecko: 0, snapshot: 0, cometPrice: 0, other: [] };
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

  // ---- Compound V3 folded into loan reliability -------------------------
  // Regression: pillarLoanReliability only matched protocol === 'aave-v3',
  // so a wallet managing a Compound borrow scored as if it had never
  // borrowed at all (real:false, neutral 50).
  calls = { etherscan: 0, coingecko: 0, snapshot: 0, cometPrice: 0, other: [] };
  const b = await call("/api/wallet-score?wallet=" + BORROWER);
  const lr = b.json.pillars?.loan_reliability;
  check("Compound-only borrower is scored, not treated as no lending history",
    b.json.success && lr?.real === true, lr);
  check("Compound borrow yields an Aave-comparable health factor",
    Math.abs((lr?.lowestHealthFactor ?? 0) - EXPECTED_HF) < 1e-9,
    { got: lr?.lowestHealthFactor, expected: EXPECTED_HF });
  check("derived health factor lands in the same band as an Aave HF of 2.55",
    lr?.value === 85, lr?.value);
  check("Compound collateral is valued from Comet's own price feed",
    lr?.totalCollateralUsd === COMET_WETH_AMOUNT * COMET_WETH_PRICE, lr?.totalCollateralUsd);
  check("Compound borrow counts toward total debt",
    lr?.totalDebtUsd === COMET_BORROW_USD, lr?.totalDebtUsd);
  check("rationale names the protocol the risk came from",
    /Compound V3/.test(lr?.rationale || ""), lr?.rationale);
  check("pillar reports which protocols it saw",
    Array.isArray(lr?.protocols) && lr.protocols.includes("Compound V3"), lr?.protocols);
  check("collateral is not double-counted across chains",
    lr?.totalCollateralUsd === COMET_WETH_AMOUNT * COMET_WETH_PRICE,
    { chains: 5, got: lr?.totalCollateralUsd });
  check("only held collateral assets cost a price lookup",
    calls.cometPrice === 1, calls.cometPrice);
  check("borrower stays inside the subrequest budget", calls.etherscan < 50, calls.etherscan);

  // ---- pillar-level banding, both protocols on one scale -----------------
  const aaveRow = (hf, coll = 10000, debt = 5000) => ({ protocols: [{
    protocol: "aave-v3", hasPosition: true, healthFactor: hf, collateralUsd: coll, debtUsd: debt }] });
  const compRow = (hf, borrow = 5000, coll = 15000) => ({ protocols: [{
    protocol: "compound-v3", hasPosition: true, borrowUsd: borrow, supplyUsd: 0,
    collateralUsd: coll, healthFactor: hf }] });

  check("identical health factors score identically across protocols",
    pillarLoanReliability([aaveRow(1.4)]).value === pillarLoanReliability([compRow(1.4)]).value,
    { aave: pillarLoanReliability([aaveRow(1.4)]).value, compound: pillarLoanReliability([compRow(1.4)]).value });
  check("the riskier of the two protocols sets the score",
    pillarLoanReliability([aaveRow(3.5), compRow(1.1)]).value === 20,
    pillarLoanReliability([aaveRow(3.5), compRow(1.1)]));
  check("a liquidatable Compound position scores zero",
    pillarLoanReliability([compRow(0.9)]).value === 0, pillarLoanReliability([compRow(0.9)]).value);

  const saver = pillarLoanReliability([{ protocols: [{
    protocol: "compound-v3", hasPosition: true, supplyUsd: 2500, borrowUsd: 0 }] }]);
  check("Compound supply with no debt is the saver case", saver.real === true && saver.value === 80, saver);
  check("saver rationale names Compound", /Compound V3/.test(saver.rationale), saver.rationale);

  const both = pillarLoanReliability([aaveRow(2.5, 10000, 0), { protocols: [{
    protocol: "compound-v3", hasPosition: true, supplyUsd: 2500, borrowUsd: 0 }] }]);
  check("saver rationale names both protocols when both are present",
    /Aave V3/.test(both.rationale) && /Compound V3/.test(both.rationale), both.rationale);

  // Debt we can see but cannot assess must not be scored as if it were safe.
  const blind = pillarLoanReliability([{ protocols: [{
    protocol: "compound-v3", hasPosition: true, supplyUsd: 0, borrowUsd: 8000,
    collateralUsd: null, healthFactor: null }] }]);
  check("unreadable Compound collateral is neutral, not a guess",
    blind.real === true && blind.value === 50 && blind.unassessableDebtUsd === 8000, blind);
  check("unreadable collateral is stated in the rationale",
    /could not be read/.test(blind.rationale), blind.rationale);

  const none = pillarLoanReliability([]);
  check("no lending anywhere still reads real:false and names both protocols",
    none.real === false && /Aave V3 or Compound V3/.test(none.rationale), none);
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
