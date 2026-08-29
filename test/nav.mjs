// Sidebar integrity.
//
// The nav is the map of the product. Two things must hold: every item points
// at a page that exists, and the RWA group contains exactly the curated-dossier
// pages — because that grouping is what tells a reader, before they click,
// which figures are live and which are research.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log((cond ? "PASS  " : "FAIL  ") + name + (cond ? "" : "  →  " + JSON.stringify(detail)));
}

const nav = fs.readFileSync(path.join(root, "_data/nav.yml"), "utf8");

// Minimal parse: every `{ id: …, path: …, match: … }` item line.
const items = [...nav.matchAll(/\{\s*id:\s*([\w-]+).*?path:\s*(\S+?),.*?match:\s*([\w-]+)\s*\}/g)]
  .map((m) => ({ id: m[1], path: m[2], match: m[3] }));
check("nav parses into items", items.length >= 20, items.length);

// Build the set of permalinks the site actually serves.
const dashDir = path.join(root, "dashboard");
const permalinks = new Set();
for (const f of fs.readdirSync(dashDir)) {
  if (!f.endsWith(".html") && !f.endsWith(".md")) continue;
  const s = fs.readFileSync(path.join(dashDir, f), "utf8");
  const m = s.match(/^permalink:\s*(\S+)/m);
  if (m) permalinks.add(m[1]);
}
permalinks.add("/dashboard/");           // dashboard/index.html
["/pricing/", "/account/", "/account/privacy/"].forEach((p) => permalinks.add(p));

for (const it of items) {
  check(`nav item '${it.id}' points at a page that exists`, permalinks.has(it.path), it);
}

// Section tags must line up, or the active item never highlights.
const sections = new Map();
for (const f of fs.readdirSync(dashDir)) {
  if (!f.endsWith(".html")) continue;
  const s = fs.readFileSync(path.join(dashDir, f), "utf8");
  const perma = (s.match(/^permalink:\s*(\S+)/m) || [])[1];
  const sec = (s.match(/^dashboard_section:\s*(\S+)/m) || [])[1];
  if (perma && sec) sections.set(perma, sec);
}
for (const it of items) {
  if (!sections.has(it.path)) continue;
  check(`nav '${it.id}' match tag agrees with the page's dashboard_section`,
    sections.get(it.path) === it.match, { nav: it.match, page: sections.get(it.path) });
}

// The RWA group must hold exactly the curated pages. A curated page filed
// elsewhere would read as live data.
const rwaGroup = nav.slice(nav.indexOf("id: rwa\n"), nav.indexOf("id: reference"));
const CURATED_JS = [
  "rwa-asset-score.js", "issuer-due-diligence.js", "custody-por.js",
  "oracle-integrity.js", "liquidity-redemption.js", "legal-compliance.js",
  "portfolio-rwa-exposure.js", "yield-risk-adjusted.js", "rwa-audit-toolkit.js",
];
for (const f of fs.readdirSync(dashDir)) {
  if (!f.endsWith(".html")) continue;
  const s = fs.readFileSync(path.join(dashDir, f), "utf8");
  const perma = (s.match(/^permalink:\s*(\S+)/m) || [])[1];
  if (!perma) continue;
  const curated = CURATED_JS.some((m) => s.includes(m));
  if (curated) {
    check(`curated page ${f} is filed under RWA Research`, rwaGroup.includes(perma), perma);
  }
}

// Report an Issue is a support affordance, not a daily destination.
const accountGroup = nav.slice(nav.indexOf("id: account\n    label: Account"));
check("Report an Issue sits in the Account group, last",
  accountGroup.includes("/dashboard/report-issue/") &&
  accountGroup.trimEnd().endsWith("match: report }"), null);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
