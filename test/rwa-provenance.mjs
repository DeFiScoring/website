// Guards the honesty contract on the RWA research modules.
//
// Those pages render hand-compiled dossiers, not live feeds. The banner that
// says so is the only thing standing between a curated number and a reader who
// assumes it was verified today, so these checks treat a missing or malformed
// disclosure as a build failure — including for RWA pages added later, which
// is the case a human reviewer is most likely to miss.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log((cond ? "PASS  " : "FAIL  ") + name + (cond ? "" : "  →  " + JSON.stringify(detail)));
}

const MANIFEST = path.join(root, "assets/data/rwa-provenance.json");
const raw = fs.readFileSync(MANIFEST, "utf8");
let manifest = null;
try { manifest = JSON.parse(raw); } catch (e) { /* reported below */ }

check("provenance manifest is valid JSON", manifest !== null, raw.slice(0, 120));
check("manifest carries a dataset version", typeof manifest?.dataset_version === "string" && manifest.dataset_version.length > 0,
  manifest?.dataset_version);

// Every entry must carry the three things a reader needs to judge the figures:
// what kind of data it is, when it was last looked at, and where it came from.
const ISO = /^\d{4}-\d{2}-\d{2}$/;
for (const [key, e] of Object.entries(manifest?.modules || {})) {
  check(`${key}: has a summary`, typeof e.summary === "string" && e.summary.length > 10, e.summary);
  check(`${key}: has a detail paragraph`, typeof e.detail === "string" && e.detail.length > 40, e.detail);
  check(`${key}: reviewed_at is an ISO date`, ISO.test(e.reviewed_at || ""), e.reviewed_at);
  check(`${key}: reviewed_at is a real, non-future date`, (() => {
    if (!ISO.test(e.reviewed_at || "")) return false;
    const d = new Date(e.reviewed_at + "T00:00:00Z");
    return !isNaN(d.getTime()) && d.getTime() <= Date.now();
  })(), e.reviewed_at);
  check(`${key}: lists at least one source`, Array.isArray(e.sources) && e.sources.length > 0, e.sources);
  check(`${key}: says it is not a live feed`, /not a live|not independently|research summary|curated|inherits/i.test(
    `${e.summary} ${e.detail}`), e.summary);
}

// --- page wiring ------------------------------------------------------------
// An RWA page is any dashboard page that loads one of the curated-dossier
// modules. Discovering them from disk (rather than a hardcoded list) is what
// makes this catch a NEW page that forgets the banner.
const CURATED_MODULE_JS = [
  "rwa-asset-score.js", "issuer-due-diligence.js", "custody-por.js",
  "oracle-integrity.js", "liquidity-redemption.js", "legal-compliance.js",
  "portfolio-rwa-exposure.js", "yield-risk-adjusted.js", "rwa-audit-toolkit.js",
];
const dashDir = path.join(root, "dashboard");
const pages = fs.readdirSync(dashDir).filter((f) => f.endsWith(".html"));
const rwaPages = pages.filter((f) => {
  const s = fs.readFileSync(path.join(dashDir, f), "utf8");
  return CURATED_MODULE_JS.some((m) => s.includes(m));
});

check("found the RWA pages to guard", rwaPages.length >= 9, rwaPages);

for (const f of rwaPages) {
  const s = fs.readFileSync(path.join(dashDir, f), "utf8");
  const m = s.match(/data-rwa-provenance="([a-z0-9-]+)"/);
  check(`${f}: mounts a provenance banner`, !!m, f);
  check(`${f}: loads rwa-provenance.js`, s.includes("rwa-provenance.js"), f);
  if (m) {
    check(`${f}: banner key '${m[1]}' exists in the manifest`,
      !!manifest?.modules?.[m[1]], Object.keys(manifest?.modules || {}));
  }
}

// --- no page may claim it verified something it only transcribed ------------
for (const f of rwaPages) {
  const s = fs.readFileSync(path.join(dashDir, f), "utf8");
  const subtitle = (s.match(/dashboard_subtitle:\s*(.*)/) || [])[1] || "";
  check(`${f}: subtitle does not claim first-hand verification`,
    !/\bverifies\b|\bwe verify\b|\bverified by us\b/i.test(subtitle), subtitle.slice(0, 90));
}

const porBadge = fs.readFileSync(path.join(root, "assets/js/custody-por.js"), "utf8");
check("custody PoR badge is labelled as issuer-attested, not platform-verified",
  porBadge.includes("Issuer-attested") && !/label:\s*"✓ Verified"/.test(porBadge), null);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
