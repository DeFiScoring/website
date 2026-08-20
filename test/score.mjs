// Exercise the wallet data path (/api/portfolio, /api/wallet-score) against a
// stubbed Etherscan v2 + CoinGecko so we can assert on shape, chain coverage,
// subrequest count, and persistence.
import { D1, KV } from "./d1.mjs";
import worker from "../worker/index.js";
import { BANDS, bandForScore, pillarLoanReliability, pillarLiquidityProvision } from "../worker/lib/score.js";
import { getUniV3LpCount } from "../worker/lib/defi.js";
import { COMPOUND_V3_MARKETS } from "../worker/lib/defi-protocols.js";

const ORIGIN = "https://defiscoring.com";
const WALLET = "0x00000000000000000000000000000000000000aa";
const EMPTY_WALLET = "0x00000000000000000000000000000000000000ee";
// Holds 3 Uniswap V3 position NFTs; only tokenId 1001 still has liquidity.
// The other two are closed positions the wallet never burned.
const LP_WALLET = "0x00000000000000000000000000000000000000c9";
const LP_NFT_COUNT = 3;
const LP_LIVE_TOKEN_ID = 1001;
const ALCHEMY_CHAIN = { id: "ethereum", name: "Ethereum", chainId: 1, alchemy: "eth-mainnet" };
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

let calls = { etherscan: 0, coingecko: 0, snapshot: 0, cometPrice: 0, alchemyHttp: 0, alchemyCalls: 0, other: [] };
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

    // LP wallet via the non-Alchemy path: balanceOf on the position manager
    // returns the NFT count, and there is no batch endpoint to refine it.
    if (action === "eth_call" && callData.includes(LP_WALLET.slice(2))) {
      return J({ jsonrpc: "2.0", id: 1, result: "0x" + w(LP_NFT_COUNT) });
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
  // ---- Alchemy JSON-RPC (single + batch) ---------------------------------
  if (u.includes(".g.alchemy.com")) {
    const body = JSON.parse((init && init.body) || "{}");
    const batched = Array.isArray(body);
    const reqs = batched ? body : [body];
    calls.alchemyHttp += 1;
    calls.alchemyCalls += reqs.length;
    const answer = (req) => {
      const pr = (req.params && req.params[0]) || {};
      const d = String(pr.data || "").toLowerCase();
      const sel = d.slice(0, 10);
      if (sel === "0x70a08231") {                       // balanceOf -> NFT count
        return { jsonrpc: "2.0", id: req.id, result: "0x" + w(LP_NFT_COUNT) };
      }
      if (sel === "0x2f745c59") {                       // tokenOfOwnerByIndex
        const idx = Number(BigInt("0x" + d.slice(74, 138)));
        return { jsonrpc: "2.0", id: req.id, result: "0x" + w(1000 + idx) };
      }
      if (sel === "0x99fbab88") {                       // positions(tokenId)
        const tokenId = Number(BigInt("0x" + d.slice(10, 74)));
        // 12 words; liquidity is word 7.
        const words = Array.from({ length: 12 }, () => w(0));
        if (tokenId === LP_LIVE_TOKEN_ID) words[7] = w(123456789n);
        return { jsonrpc: "2.0", id: req.id, result: "0x" + words.join("") };
      }
      return { jsonrpc: "2.0", id: req.id, result: "0x" };
    };
    const out = reqs.map(answer);
    return J(batched ? out : out[0]);
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
  calls = { etherscan: 0, coingecko: 0, snapshot: 0, cometPrice: 0, alchemyHttp: 0, alchemyCalls: 0, other: [] };
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
  calls = { etherscan: 0, coingecko: 0, snapshot: 0, cometPrice: 0, alchemyHttp: 0, alchemyCalls: 0, other: [] };
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
  calls = { etherscan: 0, coingecko: 0, snapshot: 0, cometPrice: 0, alchemyHttp: 0, alchemyCalls: 0, other: [] };
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
  calls = { etherscan: 0, coingecko: 0, snapshot: 0, cometPrice: 0, alchemyHttp: 0, alchemyCalls: 0, other: [] };
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

  // ---- Uniswap V3: live positions, not NFT count -------------------------
  // Regression: getUniV3LpCount was a balanceOf on the position manager, so
  // a wallet holding three closed positions scored as a three-position LP.
  calls = { etherscan: 0, coingecko: 0, snapshot: 0, cometPrice: 0, alchemyHttp: 0, alchemyCalls: 0, other: [] };
  const lp = await getUniV3LpCount(ALCHEMY_CHAIN, { ALCHEMY_KEY: "stub" }, LP_WALLET);
  check("holds 3 position NFTs", lp.lpCount === LP_NFT_COUNT, lp);
  check("only the position with liquidity counts as active",
    lp.activeLpCount === 1, { activeLpCount: lp.activeLpCount, lpCount: lp.lpCount });
  check("all 3 positions were actually read", lp.positionsRead === 3, lp.positionsRead);
  check("hasPosition follows the live count, not the NFT count",
    lp.hasPosition === true, lp);
  check("not flagged truncated below the 20-position cap",
    lp.lpCountTruncated === false, lp.lpCountTruncated);
  // 1 balanceOf + 3 tokenOfOwnerByIndex + 3 positions = 7 RPC calls, but only
  // 3 HTTP requests — the two sweeps ride in one batch each.
  check("enumeration costs 3 HTTP subrequests regardless of position count",
    calls.alchemyHttp === 3, { http: calls.alchemyHttp, rpcCalls: calls.alchemyCalls });
  check("the per-position reads are batched, not serial",
    calls.alchemyCalls === 1 + LP_NFT_COUNT * 2 && calls.alchemyHttp === 3,
    { http: calls.alchemyHttp, rpcCalls: calls.alchemyCalls });

  // Without an Alchemy key there is no batch endpoint, so the raw count
  // stands — but the pillar must say so rather than implying it is live.
  calls = { etherscan: 0, coingecko: 0, snapshot: 0, cometPrice: 0, alchemyHttp: 0, alchemyCalls: 0, other: [] };
  const lpNoKey = await getUniV3LpCount(ALCHEMY_CHAIN, { ETHERSCAN_API_KEY: "stub" }, LP_WALLET);
  check("without Alchemy the raw NFT count still comes back",
    lpNoKey.lpCount === LP_NFT_COUNT, lpNoKey);
  check("without Alchemy the active count is null, not a guessed zero",
    lpNoKey.activeLpCount === null, lpNoKey);
  check("without Alchemy no batch calls are made", calls.alchemyHttp === 0, calls.alchemyHttp);

  // ---- pillar prefers activeLpCount --------------------------------------
  const chainRow = (row) => [{ protocols: [{ protocol: "uniswap-v3-lp", ...row }] }];

  const live1of3 = pillarLiquidityProvision(chainRow(
    { lpCount: 3, activeLpCount: 1, positionsRead: 3, lpCountTruncated: false }));
  check("pillar scores the live count, not the NFT count",
    live1of3.lpCount === 1 && live1of3.value === 50,
    { lpCount: live1of3.lpCount, value: live1of3.value });
  check("pillar says how many NFTs were discounted",
    /2 further position NFT\(s\) hold no liquidity/.test(live1of3.rationale), live1of3.rationale);
  check("the same wallet scored on raw NFT count would have ranked higher",
    pillarLiquidityProvision(chainRow({ lpCount: 3 })).value > live1of3.value,
    { byNftCount: pillarLiquidityProvision(chainRow({ lpCount: 3 })).value, byLive: live1of3.value });

  const allClosed = pillarLiquidityProvision(chainRow(
    { lpCount: 4, activeLpCount: 0, positionsRead: 4, lpCountTruncated: false }));
  check("a wallet whose positions are all closed is not an LP",
    allClosed.real === false && allClosed.value === 50, allClosed);
  check("all-closed is reported as observed, not as 'never provided liquidity'",
    /none currently hold liquidity/.test(allClosed.rationale), allClosed.rationale);

  const unresolved = pillarLiquidityProvision(chainRow({ lpCount: 3, activeLpCount: null }));
  check("unresolved counts still score, using the raw count",
    unresolved.real === true && unresolved.lpCount === 3, unresolved);
  check("unresolved counts are labelled as possibly including closed positions",
    /may include closed positions/.test(unresolved.rationale), unresolved.rationale);
  check("unresolved pillar does not claim a verified active count",
    unresolved.activeLpCount === null, unresolved.activeLpCount);

  const truncatedPillar = pillarLiquidityProvision(chainRow(
    { lpCount: 40, activeLpCount: 20, positionsRead: 20, lpCountTruncated: true }));
  check("a truncated enumeration is reported as a floor",
    /floor/.test(truncatedPillar.rationale), truncatedPillar.rationale);

  globalThis.fetch = realFetch;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
})().catch((e) => { console.error("HARNESS ERROR", e); process.exitCode = 2; });
