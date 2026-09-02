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
import { SCORE_MODEL_VERSION, BANDS, bandForScore } from "../worker/lib/score.js";
import { CHAINS } from "../worker/lib/chains.js";
import { BAND_META, UNKNOWN_BAND, MARK_PATHS, fractionOf } from "../worker/lib/bands.js";

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

/* ---------- the score band vocabulary, both halves ----------
 *
 * worker/lib/bands.js and assets/js/score-bands.js are the same table written
 * twice, because the browser and the Worker are two bundles that cannot import
 * each other: wrangler's entry is worker/index.js, `_site` is a static asset
 * directory rather than part of that module graph, and assets/js/* are plain
 * IIFEs with no exports. The duplication is structural and permanent.
 *
 * This is the pin. It is executable rather than a regex over source text —
 * score-bands.js assigns to globalThis and touches no DOM, so Node can load it
 * and the two implementations can be compared by behaviour, not by shape.
 * That distinction matters: a structural deep-equal written after both copies
 * have already drifted passes happily. Comparing every score does not.
 */

const noWindow = typeof globalThis.window === "undefined";
check("the browser band table loads without a DOM", noWindow, { window: typeof globalThis.window });
await import("../assets/js/score-bands.js");
const B = globalThis.DefiBands;
check("score-bands.js defines globalThis.DefiBands", !!B, null);

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 1. Numeric/semantic axis, against worker/lib/score.js — the model authority.
check(
  "browser BANDS match worker BANDS on key, label and floor, in order",
  eq(B.BANDS.map((b) => [b.key, b.label, b.floor]), BANDS.map((b) => [b.key, b.label, b.floor])),
  { browser: B.BANDS.map((b) => [b.key, b.label, b.floor]), worker: BANDS.map((b) => [b.key, b.label, b.floor]) },
);

// 2. Presentation axis, against worker/lib/bands.js.
check(
  "browser BANDS match worker BAND_META on ceil, colour, glyph and mark",
  eq(B.BANDS.map((b) => [b.key, b.ceil, b.color, b.glyph, b.mark]),
     BAND_META.map((b) => [b.key, b.ceil, b.color, b.glyph, b.mark])),
  { browser: B.BANDS.map((b) => [b.key, b.ceil, b.color, b.glyph, b.mark]),
    worker: BAND_META.map((b) => [b.key, b.ceil, b.color, b.glyph, b.mark]) },
);
check(
  "the unscored state agrees across both halves",
  eq([B.UNKNOWN.key, B.UNKNOWN.label, B.UNKNOWN.color, B.UNKNOWN.glyph, B.UNKNOWN.mark],
     [UNKNOWN_BAND.key, UNKNOWN_BAND.label, UNKNOWN_BAND.color, UNKNOWN_BAND.glyph, UNKNOWN_BAND.mark]),
  { browser: B.UNKNOWN, worker: UNKNOWN_BAND },
);

// 3. Behavioural axis. This is the assertion that would actually have caught
//    the historical 750/670/580 drift: it compares outputs, not declarations,
//    so a copied-but-subtly-wrong comparison (`>` where the other has `>=`)
//    fails here even though every structural check above still passes.
let bandMismatch = null;
let fracMismatch = null;
for (let s = 300; s <= 850; s++) {
  if (!bandMismatch && B.keyFor(s) !== bandForScore(s)) {
    bandMismatch = { score: s, browser: B.keyFor(s), worker: bandForScore(s) };
  }
  // Strict === on the double, not toFixed: the two gauges must land on the
  // same pixel, and a difference in the fifth decimal is still a difference.
  if (!fracMismatch && B.fraction(s) !== fractionOf(s)) {
    fracMismatch = { score: s, browser: B.fraction(s), worker: fractionOf(s) };
  }
}
check("both halves agree on the band of every score from 300 to 850", !bandMismatch, bandMismatch);
check("both halves agree on the scale fraction of every score", !fracMismatch, fracMismatch);

const ODD = [299, 851, 0, -1, NaN, Infinity, -Infinity, null, undefined, "700", {}];
const oddBad = ODD.filter((v) => {
  const finite = typeof v === "number" && Number.isFinite(v);
  if (finite) return false; // 299/851/0/-1 clamp rather than degrade; covered below
  return B.keyFor(v) !== "unknown" || B.fraction(v) !== 0;
});
check("non-numeric and non-finite inputs read as unknown with fraction 0", oddBad.length === 0, oddBad);
check("out-of-range scores clamp rather than escape the scale",
  B.fraction(299) === 0 && B.fraction(851) === 1 && fractionOf(299) === 0 && fractionOf(851) === 1,
  { lo: B.fraction(299), hi: B.fraction(851) });

// 4. Palette sanity. A table that silently collapses two bands onto one hex
//    breaks the colour claim without breaking any equality above — and the
//    glyph is the fallback for exactly the readers colour already fails.
const allMeta = B.BANDS.concat([B.UNKNOWN]);
check("every band colour is a 6-digit hex",
  allMeta.every((b) => /^#[0-9a-f]{6}$/.test(b.color)), allMeta.map((b) => b.color));
check("no two bands share a colour",
  new Set(allMeta.map((b) => b.color)).size === allMeta.length, allMeta.map((b) => b.color));
check("no two bands share a glyph",
  new Set(allMeta.map((b) => b.glyph)).size === allMeta.length, allMeta.map((b) => b.glyph));
check("every glyph is a single code point",
  allMeta.every((b) => [...b.glyph].length === 1), allMeta.map((b) => b.glyph));
check("the estimated glyph is not a band glyph",
  !allMeta.some((b) => b.glyph === B.ESTIMATED_GLYPH), B.ESTIMATED_GLYPH);

/* The 0–100 pillar scale is a DIFFERENT scale from the 300–850 band, and the
 * credential puts the two side by side. score-breakdown.js used to label a
 * pillar "Excellent / Good / Fair" at 80/60/40 — the same three words the band
 * table uses at 720/660/580 — so one word meant two things depending on which
 * number it sat next to. Keep them provably apart. */
const pillarMeta = B.PILLAR_TIERS.concat([B.PILLAR_UNKNOWN]);
const bandWords = allMeta.map((b) => b.label.toLowerCase());
const pillarWords = pillarMeta.map((t) => t.label.toLowerCase());
check("no pillar tier borrows a band's word",
  !pillarWords.some((w) => bandWords.includes(w)),
  pillarWords.filter((w) => bandWords.includes(w)));
check("no pillar tier borrows a band's glyph",
  !pillarMeta.some((t) => allMeta.some((b) => b.glyph === t.glyph && t.key !== "none")),
  pillarMeta.map((t) => t.glyph));
// Ordinal at a glance: each step down fills one fewer slot, and every tier is
// the same width so they line up in a column.
check("pillar tier glyphs are a constant-width ramp",
  B.PILLAR_TIERS.every((t, i) => [...t.glyph].length === 3 &&
    [...t.glyph].filter((c) => c === "▰").length === B.PILLAR_TIERS.length - 1 - i),
  B.PILLAR_TIERS.map((t) => t.glyph));
check("pillar tiers are ordered by descending floor and cover 0",
  pillarMeta.slice(0, -1).every((t, i, a) => i === 0 || a[i - 1].floor > t.floor) &&
  B.PILLAR_TIERS[B.PILLAR_TIERS.length - 1].floor === 0,
  B.PILLAR_TIERS.map((t) => t.floor));
check("a pillar value with no data is not a pillar value of zero",
  B.pillarTier(null).key === "none" && B.pillarTier(0).key !== "none",
  { none: B.pillarTier(null).key, zero: B.pillarTier(0).key });
// The three pillar SOURCES are the honest-disclosure axis: observed, estimated,
// nothing read. "Nothing read" must never be able to render as "observed".
check("pillar sources are three distinct glyphs",
  new Set(Object.keys(B.SOURCES).map((k) => B.SOURCES[k].glyph)).size === 3,
  Object.keys(B.SOURCES).map((k) => B.SOURCES[k].glyph));
check("an estimated pillar reports as estimated, not observed",
  B.sourceFor(false, true).key === "estimated" && B.sourceFor(true, true).key === "observed" &&
  B.sourceFor(true, false).key === "absent",
  null);
check("every band has a mark path the card can draw",
  B.BANDS.every((b) => typeof MARK_PATHS[b.mark] === "string") && B.UNKNOWN.mark === "ring",
  B.BANDS.map((b) => b.mark));

// 5. Copy axis: the published ranges are the table's, not hand-typed.
for (const b of BAND_META) {
  const range = `${b.floor}–${b.ceil}`;
  check(`index.html's legend states ${b.label} as ${range}`, landing.includes(`<em>${range}</em>`), { range });
}

/* ---------- the vocabulary is loaded before anything that reads it ----------
 *
 * DefiState.bandFor resolves window.DefiBands at call time, so a page missing
 * the tag renders fine until someone opens a score — a silent-until-clicked
 * failure. Pin the ordering instead.
 */
const CONSUMERS = [
  "landing.js", "dashboard.js", "dashboard-score.js", "dashboard-home.js",
  "dashboard-watchlist.js", "defi-onchain.js", "health-score.js",
  // Reads DefiBands.pillarTier for the factor modal's badge.
  "score-breakdown.js",
];
for (const page of ["_layouts/dashboard.html", "_layouts/default.html", "index.html", "_includes/health-score.html"]) {
  const html = read(page);
  const used = CONSUMERS.filter((c) => html.includes("/" + c));
  if (!used.length) continue;
  const iVocab = html.indexOf("score-bands.js");
  check(`${page} loads score-bands.js`, iVocab !== -1, { used });
  for (const c of used) {
    check(`${page} loads score-bands.js before ${c}`,
      iVocab !== -1 && iVocab < html.indexOf("/" + c), { iVocab, consumer: html.indexOf("/" + c) });
  }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
