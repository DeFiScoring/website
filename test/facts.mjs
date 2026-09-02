/* Facts the static site restates about the scoring engine.
 *
 * The engine's constants live in the worker. The site cannot import them —
 * Jekyll renders Liquid against `_config.yml` and Markdown — so a handful of
 * facts are necessarily duplicated as prose and YAML. Duplicated facts drift,
 * and these ones did: `methodology.md` claimed the model was `2026.09` while
 * `SCORE_MODEL_VERSION` had moved to `2026.11`, and three pages still said the
 * platform scored three chains months after five went live. A design set built
 * against the site rather than the code inherited every one of those errors.
 *
 * This suite is the pin. It fails the build whenever the copy and the
 * constants disagree, so bumping `SCORE_MODEL_VERSION` or promoting a chain to
 * Tier 1 forces the prose to move in the same commit.
 *
 * It deliberately reads the SOURCE files rather than the built `_site`: no
 * other suite runs Jekyll, and CI does not build the site on pull requests.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCORE_MODEL_VERSION } from "../worker/lib/score.js";
import { CHAINS } from "../worker/lib/chains.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log((cond ? "PASS  " : "FAIL  ") + name + (cond ? "" : "  →  " + JSON.stringify(detail)));
}

const config = read("_config.yml");
const methodology = read("methodology.md");

/* ---------- model version ---------- */

// `model_version: "2026.11"` under the `defi:` block.
const cfgVersion = (config.match(/^\s{2}model_version:\s*"([^"]+)"/m) || [])[1];

check("_config.yml declares defi.model_version", !!cfgVersion, { cfgVersion });
check(
  "_config.yml model_version equals SCORE_MODEL_VERSION",
  cfgVersion === SCORE_MODEL_VERSION,
  { cfgVersion, SCORE_MODEL_VERSION },
);

// methodology.md §1.9 states the current version in prose: "currently `2026.11`".
const proseVersion = (methodology.match(/currently\s+`([0-9]{4}\.[0-9]{2})`/) || [])[1];
check("methodology.md states a current model version", !!proseVersion, { proseVersion });
check(
  "methodology.md current version equals SCORE_MODEL_VERSION",
  proseVersion === SCORE_MODEL_VERSION,
  { proseVersion, SCORE_MODEL_VERSION },
);

// The version history in the same section must actually contain the current
// version — a bump that adds the constant but no history entry leaves readers
// unable to tell what changed between two scores they hold.
check(
  "methodology.md version history includes the current version",
  new RegExp("`" + SCORE_MODEL_VERSION.replace(".", "\\.") + "`").test(methodology),
  { SCORE_MODEL_VERSION },
);

/* ---------- scored chains ---------- */

const tier1 = CHAINS.filter((c) => c.tier === 1).map((c) => c.name);

// The `scored_chains:` YAML list under `defi:`, as authored.
const listBlock = (config.match(/^\s{2}scored_chains:\n((?:\s{4}-\s.+\n)+)/m) || [])[1] || "";
const cfgChains = listBlock
  .split("\n")
  .map((l) => l.replace(/^\s*-\s*/, "").trim())
  .filter(Boolean);

check("_config.yml declares defi.scored_chains", cfgChains.length > 0, { cfgChains });
check(
  "_config.yml scored_chains matches the Tier-1 chain set, in order",
  cfgChains.length === tier1.length && cfgChains.every((c, i) => c === tier1[i]),
  { cfgChains, tier1 },
);

/* ---------- no page still claims the old three-chain coverage ---------- */

// Every Tier-1 chain is scored by default, so any page that enumerates the
// scored set must name all of them. This catches the specific stale phrasing
// that survived three model versions, in whatever file it reappears in.
const PROSE_PAGES = [
  "_config.yml",
  "index.html",
  "methodology.md",
  "dashboard/score.html",
  "_includes/site-footer.html",
  "_data/footer.yml",
];

for (const page of PROSE_PAGES) {
  const text = read(page);
  // The exact stale construction: an Ethereum/Arbitrum/Polygon list with the
  // two other Tier-1 chains conspicuously absent from it.
  const stale = /Ethereum,\s*Arbitrum,?\s*and\s*Polygon/i.test(text);
  check(`${page} does not claim the stale three-chain coverage`, !stale, { page });
}

/* ---------- footer tagline: sentence in data, chains from config ---------- */

// The tagline is prose, so it lives with the rest of the footer's copy — but
// the chain list inside it is a fact, so it is substituted rather than typed.
// A typo in either half of that contract renders the literal `%CHAINS%` to
// every visitor, which no other check would catch.
const footerData = read("_data/footer.yml");
const footerInc = read("_includes/site-footer.html");
check("_data/footer.yml holds the brand tagline", /^tagline:\s*>/m.test(footerData), null);
check("the tagline defers its chain list to the %CHAINS% placeholder",
  footerData.includes("%CHAINS%"), null);
check("site-footer.html substitutes %CHAINS% from defi.scored_chains",
  footerInc.includes('replace: "%CHAINS%"') && footerInc.includes("site.defi.scored_chains"),
  null);

// The landing page's own headline count must equal the full registry, not the
// Tier-1 subset — the two numbers are different claims and both appear there.
const landing = read("index.html");
check(
  `index.html states the full registry size (${CHAINS.length} chains supported)`,
  landing.includes(`${CHAINS.length} chains supported`),
  { total: CHAINS.length },
);
for (const name of tier1) {
  check(`index.html names Tier-1 chain ${name}`, landing.includes(name.split(" ")[0]), { name });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
