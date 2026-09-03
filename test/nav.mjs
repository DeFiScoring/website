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

// The caption is the same claim the grouping makes, said out loud. It must
// exist, and — because `.defi-sidebar__group-title` is `display: contents` —
// it must render inside `.defi-sidebar__group-items` rather than in the summary
// row, where it would become a third flex child between label and chevron.
check("RWA group carries the curated-dossier caption",
  /^\s*caption:\s*Curated dossiers · not live feeds\s*$/m.test(rwaGroup), null);

const sidebar = fs.readFileSync(path.join(root, "_includes/dashboard/sidebar.html"), "utf8");
const iCaption = sidebar.indexOf("defi-sidebar__group-caption");
check("sidebar renders group.caption", iCaption !== -1, null);
check("caption renders inside .defi-sidebar__group-items, not the summary row",
  iCaption > sidebar.indexOf('class="defi-sidebar__group-items"') &&
  iCaption > sidebar.indexOf("</summary>"), { iCaption });

// The chain selector shows three buttons; the score reads every Tier-1 chain.
// Both the count and the tooltip come from _config.yml, never typed here.
check("sidebar footer states the scored-chain count from site.defi.scored_chains",
  /defi-sidebar__scope/.test(sidebar) &&
  /site\.defi\.scored_chains \| size/.test(sidebar) &&
  !/Scores read \d+ chain/.test(sidebar), null);

// Report an Issue is a support affordance, not a daily destination.
const accountGroup = nav.slice(nav.indexOf("id: account\n    label: Account"));
check("Report an Issue sits in the Account group, last",
  accountGroup.includes("/dashboard/report-issue/") &&
  accountGroup.trimEnd().endsWith("match: report }"), null);

// Content pages that share layout: default must inherit the dark theme.
// Without class="ds-body" they render light text on a white browser default.
const defaultLayout = fs.readFileSync(path.join(root, "_layouts/default.html"), "utf8");
check("default layout applies ds-body (dark theme + Inter)",
  /<body\s+class="ds-body">/.test(defaultLayout), null);
check("default layout loads Inter + JetBrains Mono",
  /fonts\.googleapis\.com\/css2\?family=Inter/.test(defaultLayout), null);
check("default layout does not double-include the site footer in itself only once",
  (defaultLayout.match(/include site-footer\.html/g) || []).length === 1, null);

const footerPages = [
  "privacy.md", "terms.md", "disclaimer.md", "api.md", "methodology.md",
];
for (const f of footerPages) {
  const s = fs.readFileSync(path.join(root, f), "utf8");
  check(`${f} does not double-include the site footer`,
    !/\{\%\s*include site-footer\.html\s*\%\}/.test(s), f);
  check(`${f} uses the shared legal-page wrapper`,
    /class="legal-page"/.test(s), f);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
