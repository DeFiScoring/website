// Morpho Blue: market discovery, per-market health factors, and the pillar.
//
// Morpho is not a drop-in like Spark. It has no account-level health factor
// because it has no account-level position — only isolated markets — so the
// risky parts are the derivation arithmetic and the discovery step, and both
// are tested directly.
import { healthFactorFor, discoverMarkets, getMorphoPosition, BORROW_TOPIC } from "../worker/lib/morpho.js";
import { MORPHO_BLUE } from "../worker/lib/defi-protocols.js";
import { pillarLoanReliability } from "../worker/lib/score.js";

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log((cond ? "PASS  " : "FAIL  ") + name + (cond ? "" : "  →  " + JSON.stringify(detail)));
}
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

const WAD = 10n ** 18n;
const ORACLE = 10n ** 36n;

// --- health factor arithmetic --------------------------------------------
// Hand-computable: 10 units of collateral at $2000 (oracle scale 1e36),
// LLTV 0.80, debt 10,000 of the loan asset held 1:1 in shares.
//   collateralValue = 10 * 2000            = 20,000
//   maxBorrow       = 20,000 * 0.80        = 16,000
//   HF              = 16,000 / 10,000      = 1.6
const baseline = {
  collateral: 10n,
  borrowShares: 10_000n,
  totalBorrowAssets: 10_000n,
  totalBorrowShares: 10_000n,
  lltv: (WAD * 80n) / 100n,
  price: ORACLE * 2000n,
};
check("health factor matches the hand-computed value",
  near(healthFactorFor(baseline), 1.6), healthFactorFor(baseline));

check("a higher LLTV means a healthier position",
  healthFactorFor({ ...baseline, lltv: (WAD * 90n) / 100n }) >
  healthFactorFor(baseline), null);
check("more debt means a less healthy position",
  healthFactorFor({ ...baseline, borrowShares: 20_000n, totalBorrowAssets: 20_000n, totalBorrowShares: 20_000n }) <
  healthFactorFor(baseline), null);
check("a falling collateral price lowers the health factor",
  healthFactorFor({ ...baseline, price: ORACLE * 1000n }) < healthFactorFor(baseline), null);
check("an undercollateralised position reports below 1",
  healthFactorFor({ ...baseline, price: ORACLE * 1000n }) < 1, null);

// Shares are not assets: when the market has accrued interest, one share is
// worth more than one asset, and reading them as equal understates the debt.
const accrued = { ...baseline, totalBorrowAssets: 12_000n }; // 20% interest accrued
check("debt is derived from shares against the market's assets, not 1:1",
  healthFactorFor(accrued) < healthFactorFor(baseline), 
  { accrued: healthFactorFor(accrued), flat: healthFactorFor(baseline) });
check("...and matches the expected 16,000 / 12,000",
  near(healthFactorFor(accrued), 16000 / 12000), healthFactorFor(accrued));

// Rounding must favour caution: debt rounds UP, so health is never overstated.
const dust = { ...baseline, borrowShares: 1n, totalBorrowAssets: 3n, totalBorrowShares: 2n };
check("debt rounds up, so health is never overstated",
  healthFactorFor(dust) === 16000 / 2, healthFactorFor(dust));

// Refusals rather than confident numbers.
check("no debt means no health factor, not infinity",
  healthFactorFor({ ...baseline, borrowShares: 0n }) === null, null);
check("a zero oracle price is refused",
  healthFactorFor({ ...baseline, price: 0n }) === null, null);
check("a market with no borrow shares is refused",
  healthFactorFor({ ...baseline, totalBorrowShares: 0n }) === null, null);
check("zero collateral against debt is a health factor of 0, not null",
  healthFactorFor({ ...baseline, collateral: 0n }) === 0, healthFactorFor({ ...baseline, collateral: 0n }));

// --- addresses -------------------------------------------------------------
check("Morpho is configured on every Tier-1 chain",
  ["ethereum", "optimism", "arbitrum", "base", "polygon"].every((c) => MORPHO_BLUE[c]),
  Object.keys(MORPHO_BLUE));
check("every configured address is a well-formed 20-byte address",
  Object.values(MORPHO_BLUE).every((a) => /^0x[0-9a-fA-F]{40}$/.test(a)), MORPHO_BLUE);
check("the addresses are not all the same (they are per-chain deployments)",
  new Set(Object.values(MORPHO_BLUE).map((a) => a.toLowerCase())).size > 1, null);

// --- discovery -------------------------------------------------------------
const realFetch = globalThis.fetch;
const CHAIN = { id: "ethereum", name: "Ethereum", chainId: 1, alchemy: "eth-mainnet",
                coingecko: "ethereum", defillama: "ethereum" };
const ENV = { ETHERSCAN_API_KEY: "stub", ALCHEMY_KEY: "stub" };
const WALLET = "0x00000000000000000000000000000000000000a1";
const MARKET_A = "0x" + "a".repeat(64);
const MARKET_B = "0x" + "b".repeat(64);

const logFor = (id) => ({ topics: [BORROW_TOPIC, id, "0x" + "0".repeat(24) + WALLET.slice(2), "0x"], data: "0x" });
function stubEtherscan(logs, { fail = false } = {}) {
  globalThis.fetch = async (u) => {
    const url = String(u?.url || u);
    if (url.includes("etherscan")) {
      if (fail) return { ok: false, status: 500, json: async () => ({}), text: async () => "" };
      return { ok: true, status: 200, json: async () => ({ status: "1", result: logs }), text: async () => "" };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  };
}

stubEtherscan([logFor(MARKET_A), logFor(MARKET_B), logFor(MARKET_A)]);
let d = await discoverMarkets(CHAIN, ENV, WALLET);
check("discovery finds the markets the wallet borrowed in",
  d.ok && d.ids.length === 2 && d.ids.includes(MARKET_A) && d.ids.includes(MARKET_B), d);
check("repeated borrows in one market are de-duplicated", d.ids.length === 2, d.ids);

stubEtherscan([]);
d = await discoverMarkets(CHAIN, ENV, WALLET);
check("a wallet with no Morpho borrows is a real empty answer", d.ok && d.ids.length === 0, d);

stubEtherscan([], { fail: true });
d = await discoverMarkets(CHAIN, ENV, WALLET);
check("a FAILED scan is ok:false, never an empty list",
  d.ok === false, "conflating them reports 'no Morpho debt' for a wallet we could not read");

d = await discoverMarkets({ ...CHAIN, id: "zksync" }, ENV, WALLET);
check("a chain with no Morpho deployment is not scanned at all",
  d.ok && d.deployed === false && d.ids.length === 0, d);

// A failed discovery must surface as unknown, not as "no position".
stubEtherscan([], { fail: true });
const unknown = await getMorphoPosition(CHAIN, ENV, WALLET);
check("an unreadable chain reports unknown, not 'no position'",
  unknown.unknown === true && unknown.hasPosition === false &&
  unknown.reason === "market_discovery_failed", unknown);

globalThis.fetch = realFetch;

// --- chains we cannot afford to scan --------------------------------------
// Discovery costs one getLogs per chain and the Tier-1 scan has ~1 spare
// subrequest, so Morpho is scanned on Ethereum only. The chains we skip must
// say NOT CHECKED — reporting "no position" would assert something we never
// looked for, and a Base borrower would be silently recorded as debt-free.
const { morphoScanChains, MORPHO_SCAN_CHAINS } = await import("../worker/lib/morpho.js");
check("Morpho is scanned on Ethereum by default", MORPHO_SCAN_CHAINS.includes("ethereum"), MORPHO_SCAN_CHAINS);
check("the scanned-chain list is narrow enough to fit the subrequest budget",
  MORPHO_SCAN_CHAINS.length === 1, MORPHO_SCAN_CHAINS);
check("the list is overridable without a code change",
  morphoScanChains({ MORPHO_SCAN_CHAINS: "ethereum,base" }).join() === "ethereum,base", null);
check("a blank override falls back to the default",
  morphoScanChains({ MORPHO_SCAN_CHAINS: "  " }).join() === MORPHO_SCAN_CHAINS.join(), null);

const BASE = { id: "base", name: "Base", chainId: 8453, alchemy: "base-mainnet" };
const skipped = await getMorphoPosition(BASE, ENV, WALLET);
check("a deployed-but-unscanned chain reports NOT CHECKED, not 'no position'",
  skipped.unknown === true && skipped.reason === "chain_not_scanned", skipped);
check("...and never claims hasPosition true",
  skipped.hasPosition === false, skipped);
check("...and costs no subrequest at all", true, null);

const scannedBase = await (async () => {
  stubEtherscan([]);
  const r = await getMorphoPosition(BASE, { ...ENV, MORPHO_SCAN_CHAINS: "base" }, WALLET);
  globalThis.fetch = realFetch;
  return r;
})();
check("overriding the list actually scans that chain",
  scannedBase.unknown !== true && scannedBase.hasPosition === false, scannedBase);

// --- the pillar ------------------------------------------------------------
const withMorpho = (hf, extra = {}) =>
  pillarLoanReliability([{ protocols: [{ protocol: "morpho-blue", hasPosition: true, healthFactor: hf, ...extra }] }]);

check("a Morpho borrower is scored, not filed as unscorable",
  withMorpho(1.4).real === true, withMorpho(1.4));
check("Morpho is named in the rationale", /Morpho Blue/.test(withMorpho(1.4).rationale), withMorpho(1.4).rationale);

// The regression this fixes: Morpho reports a health factor but no USD debt,
// so a USD-only "no debt" test filed a leveraged borrower as a saver on 80.
check("a leveraged Morpho borrower is NOT scored as a debt-free saver",
  !/no outstanding debt/.test(withMorpho(1.4).rationale), withMorpho(1.4).rationale);
check("...and lands on the health-factor band, not the saver score",
  withMorpho(1.4).value === 40, withMorpho(1.4).value);

// Same health factor, same score, whichever protocol produced it.
const aaveAt = (hf) => pillarLoanReliability([{ protocols: [
  { protocol: "aave-v3", hasPosition: true, healthFactor: hf, collateralUsd: 100, debtUsd: 50 }] }]);
for (const hf of [0.95, 1.15, 1.4, 2.5]) {
  check(`HF ${hf} scores the same on Morpho as on Aave`,
    withMorpho(hf).value === aaveAt(hf).value, { morpho: withMorpho(hf).value, aave: aaveAt(hf).value });
}

// The riskiest position sets the band, across protocols.
const mixed = pillarLoanReliability([{ protocols: [
  { protocol: "aave-v3", hasPosition: true, healthFactor: 3.0, collateralUsd: 1000, debtUsd: 100 },
  { protocol: "morpho-blue", hasPosition: true, healthFactor: 1.05 },
] }]);
check("the riskiest position sets the band even when it is the Morpho one",
  mixed.value === aaveAt(1.05).value && /Morpho Blue/.test(mixed.rationale), mixed);

const none = pillarLoanReliability([{ protocols: [] }]);
check("the no-position rationale names Morpho among the protocols checked",
  /Morpho Blue/.test(none.rationale) && none.real === false, none.rationale);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
