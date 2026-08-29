// Pins public marketing claims to what the code actually does.
//
// A licensing customer tests the pricing page bullet by bullet. Every claim
// below is checked against the implementation, so a feature can never be sold
// on the site before it exists — and, just as important, a feature marked
// "Planned" gets un-marked when it ships (the reverse checks catch that too).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TIERS } from "../worker/lib/tiers.js";
import { CHAINS } from "../worker/lib/chains.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log((cond ? "PASS  " : "FAIL  ") + name + (cond ? "" : "  →  " + JSON.stringify(detail)));
}
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const pricing = read("pricing/index.html");
const landing = read("index.html");
const workerIndex = read("worker/index.js");
const adminLib = read("worker/lib/admin.js");

// --- claims that must stay marked "Planned" until the feature exists --------
// Each entry: [label on the page, predicate that says "it is implemented"].
const PLANNED = [
  ["SSO &amp; user roles", () => /\brole\b/.test(adminLib)],
  ["White-label embeds", () => /white[- ]?label/i.test(workerIndex)],
  ["Custom scoring weights", () => /custom_weights|customWeights/.test(workerIndex + read("worker/lib/score.js"))],
];
for (const [label, isImplemented] of PLANNED) {
  const idx = pricing.indexOf(label);
  check(`pricing lists "${label}"`, idx >= 0, label);
  if (idx < 0) continue;
  const line = pricing.slice(pricing.lastIndexOf("<li", idx), pricing.indexOf("</li>", idx));
  const marked = line.includes("is-soon") && line.includes("Planned");
  check(`"${label}" is marked Planned while unimplemented`, marked || isImplemented(),
    { marked, implemented: isImplemented() });
  // The reverse: once it IS implemented, the Planned marker must come off.
  check(`"${label}" is not marked Planned once implemented`, !(marked && isImplemented()), label);
}

// --- the ◷ glyph must always be explained ----------------------------------
check("comparison table explains the ◷ planned marker",
  !pricing.includes("◷") || /pr-table__legend/.test(pricing), null);

// --- no claim of a per-day scan cap that nothing enforces -------------------
check("pricing does not advertise a per-day scan cap",
  !/Scans\s*\/\s*day/i.test(pricing), "Scans / day row still present");
check("scan limiting is described as a rate limit, matching rateLimit() in the worker",
  !/<th>Scans<\/th>/.test(pricing) || /Fair-use rate limit/.test(pricing), null);

// Tier bullet lists must not contradict the comparison table beneath them.
check("no tier bullet advertises unlimited scans",
  !/<strong>Unlimited<\/strong>\s*scans/.test(pricing), "Unlimited scans bullet present");
check("RWA bullet matches the table's open-beta status",
  !/<li>RWA scoring suite<\/li>/.test(pricing), "RWA sold as a gated tier feature");

// --- tier numbers on the page must match tiers.js --------------------------
for (const [tier, expected] of [["free", 1], ["pro", 3], ["plus", 10]]) {
  check(`tiers.js ${tier} wallets.linked is ${expected} as advertised`,
    TIERS[tier].limits["wallets.linked"] === expected, TIERS[tier].limits["wallets.linked"]);
}
for (const [tier, expected] of [["free", 7], ["pro", 30], ["plus", 365]]) {
  check(`tiers.js ${tier} history.days is ${expected} as advertised`,
    TIERS[tier].limits["history.days"] === expected, TIERS[tier].limits["history.days"]);
}
check("pricing advertises the history windows tiers.js enforces",
  pricing.includes("7 days") && pricing.includes("30 days") && pricing.includes("365 days"), null);

// --- chain coverage claim must match the registry --------------------------
const tier1 = CHAINS.filter((c) => c.tier === 1).map((c) => c.name);
const total = CHAINS.length;
check(`landing states the real chain total (${total})`,
  landing.includes(`${total} chains supported`), { total });
for (const n of tier1) {
  const short = n.split(" ")[0]; // "Arbitrum One" -> "Arbitrum"
  check(`landing names default-scanned chain ${short}`, landing.includes(short), n);
}

// --- RWA suite is not sold as tier-gated while it is open to everyone ------
const rwaGated = /requireTier\([^)]*rwa|rwa[^)]*requireTier/i.test(workerIndex);
check("RWA suite gating claim matches enforcement",
  rwaGated || /open beta/.test(pricing), "table claims gating that nothing enforces");

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
