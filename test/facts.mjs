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
import {
  SCORE_MODEL_VERSION, BANDS, bandForScore, PILLAR_WEIGHTS, coverageOf,
} from "../worker/lib/score.js";
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

/* ---------- the low-contrast token never colours text ----------
 *
 * --defi-text-mute / --ds-text-mute is #5a5a6a, which is 2.93:1 on the page
 * ground — below the 4.5:1 AA floor for body text and below 3:1 even for large
 * text. Both design systems keep it for hairlines and dividers, where contrast
 * rules do not apply, and both define a --*-text-muted at 4.7:1 for any text
 * that wants a third, quieter step. Nothing enforced that split, so a `color:`
 * reaching for the wrong one passed unnoticed.
 */
for (const sheet of ["assets/css/dashboard.css", "assets/css/landing.css", "assets/css/pricing.css"]) {
  const css = read(sheet);
  const bad = [...css.matchAll(/color:\s*var\(--(?:defi|ds)-text-mute\)/g)].length;
  check(`${sheet} does not colour text with the sub-AA token`, bad === 0, { bad });
}

/* ---------- the contribution bars sum to the weighted pillar score ----------
 *
 * The dashboard home used to plot pillar WEIGHTS — 35/25/15/10/15, identical
 * for every wallet on the platform — so the chart could not say anything about
 * the reader's own score. It now plots weight × value, and the point of those
 * five numbers is that they add up to `raw_h_s`, which is the first row of the
 * ledger on /dashboard/score/ and the number that maps onto 300–850. If they
 * stop adding up, the two pages are telling different stories about one score.
 */
await import("../assets/js/score-credential.js");
const CRED = globalThis.DefiCredential;
check("score-credential.js loads headless", !!CRED && typeof CRED.contribution === "function", null);

// The pillar set and weights the worker actually publishes.
const FIXTURE = [
  { name: "Loan reliability",    weight: 35, value: 65, real: true },
  { name: "Portfolio health",    weight: 25, value: 90, real: true },
  { name: "Liquidity provision", weight: 15, value: 79, real: true },
  { name: "Governance",          weight: 10, value: 50, real: false },
  { name: "Account age",         weight: 15, value: 85, real: true },
];
const contribSum = FIXTURE.reduce((s2, f) => s2 + CRED.contribution(f), 0);
const hs = (0.35 * 65) + (0.25 * 90) + (0.15 * 79) + (0.10 * 50) + (0.15 * 85);
check("the contributions sum to the engine's weighted composite",
  Math.abs(contribSum - hs) < 1e-9, { contribSum, hs });
check("that composite maps to the ledger's opening row",
  Math.round(300 + (contribSum / 100) * 550) === Math.round(300 + (hs / 100) * 550), null);
check("a pillar with no value contributes nothing rather than NaN",
  CRED.contribution({ weight: 35, value: null }) === 0 && CRED.contribution(null) === 0, null);
// An estimated pillar still contributes — it is held at neutral 50, not zero —
// and saying otherwise would understate the score it actually produced.
check("an estimated pillar still contributes its neutral value",
  CRED.contribution({ weight: 10, value: 50, real: false }) === 5, null);

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
  // The shared gauge / coverage / contribution renderers.
  "score-credential.js",
];
/* Match SCRIPT TAGS, not prose. This used to substring-search the whole file
 * for "/landing.js", so an HTML comment naming the file — "the TARGET
 * constant in assets/js/landing.js" — registered as a load site at the top of
 * the page and failed the ordering against a tag 17KB below it. The thing
 * being asserted is tag order, so only src attributes count. */
/* The srcs are Liquid, not plain paths:
 *   src="{{ '/assets/js/landing.js' | relative_url }}?v={{ site.time | … }}"
 * so anything that stops at the first quote inside the attribute matches
 * nothing at all and the whole check passes vacuously. Stay inside the tag
 * with [^>] and take the last path segment ending in .js. */
const scriptSrcs = (html) =>
  [...html.matchAll(/<script\b[^>]*\ssrc=[^>]*?\/([A-Za-z0-9_-]+\.js)/g)]
    .map((m) => ({ file: m[1], at: m.index }));

for (const page of ["_layouts/dashboard.html", "_layouts/default.html", "index.html", "_includes/health-score.html"]) {
  const html = read(page);
  const tags = scriptSrcs(html);
  const used = CONSUMERS.filter((c) => tags.some((t) => t.file === c));
  if (!used.length) continue;
  const vocab = tags.find((t) => t.file === "score-bands.js");
  check(`${page} loads score-bands.js`, !!vocab, { used });
  for (const c of used) {
    const consumer = tags.find((t) => t.file === c);
    check(`${page} loads score-bands.js before ${c}`,
      vocab && consumer && vocab.at < consumer.at,
      { iVocab: vocab && vocab.at, consumer: consumer && consumer.at });
  }
}

/* ---------------------------------------------------------------------------
 * No first-party script in the dashboard layout may block the parser.
 *
 * Cloudflare Web Analytics measured LCP at P75 5,135ms and P90 9,916ms, with
 * 50% of loads Poor, and INP 100% Poor. The cause was twelve render-blocking
 * <script> tags per dashboard page: nine first-party files plus chart.js,
 * jspdf and jspdf-autotable, none of them deferred, all executing before the
 * page could paint. INP was the same wound: a main thread still busy running
 * those scripts cannot answer a click, which is why two unrelated elements
 * both measured ~1s.
 *
 * defer is what keeps this fixed AND what keeps the ordering check above
 * meaningful: deferred scripts execute in document order, so score-bands.js
 * still precedes its consumers. A single non-deferred tag reintroduced into
 * this layout would jump ahead of every deferred one, so this guard is about
 * correctness as much as speed.
 * ------------------------------------------------------------------------- */
{
  const layout = read("_layouts/dashboard.html");
  const tags = [...layout.matchAll(/<script\b[^>]*\ssrc=[^>]*?>/g)].map((m) => m[0]);
  const firstParty = tags.filter((t) => t.includes("/assets/js/"));
  check("the dashboard layout still loads first-party scripts", firstParty.length > 0,
    { found: firstParty.length });
  const blocking = firstParty
    .filter((t) => !/\sdefer\b/.test(t) && !/\sasync\b/.test(t))
    .map((t) => (t.match(/\/([A-Za-z0-9_-]+\.js)/) || [])[1]);
  check("no first-party dashboard script blocks the parser", blocking.length === 0,
    { blocking });
}

/* ---------------------------------------------------------------------------
 * The landing page's sample wallet must be arithmetic, not art direction.
 *
 * index.html's hero publishes five pillar values and a coverage figure, and
 * assets/js/landing.js animates the gauge to a TARGET score. Before this,
 * TARGET was 782 with the comment "tuned for an excellent look" and no
 * pillars were shown — a number chosen because it looked good, on a page
 * whose headline promise is that we never invent one.
 *
 * So recompute the whole thing from the engine's own constants: the weighted
 * composite, the 300–850 mapping, the band, and coverageOf()'s weight sum.
 * Change a pillar value in the markup and this tells you what it now adds up
 * to, which is the only way the two can be edited together.
 * ------------------------------------------------------------------------- */
{
  const landing = read("index.html");
  const NAME_TO_KEY = {
    "Loan reliability": "loan_reliability",
    "Portfolio health": "portfolio_health",
    "Liquidity provision": "liquidity_provision",
    "Account age": "account_age",
    "Governance": "governance",
  };

  const items = [...landing.matchAll(/<li class="ds-pillar([^"]*)">([\s\S]*?)<\/li>/g)];
  check("the hero publishes one row per weighted pillar",
    items.length === Object.keys(PILLAR_WEIGHTS).length,
    { rows: items.length, weights: Object.keys(PILLAR_WEIGHTS).length });

  const pillars = {};
  for (const [, cls, body] of items) {
    const name = (body.match(/<\/span>\s*([A-Za-z ]+?)\s*(?:<|$)/) || [])[1];
    const value = Number((body.match(/ds-pillar__value">(\d+)</) || [])[1]);
    const key = NAME_TO_KEY[name];
    check(`hero pillar "${name}" is one the engine weights`, !!key, { name, value });
    if (key) pillars[key] = { value, real: !/\bis-estimated\b/.test(cls) };
  }

  // Every weighted pillar must appear, or the composite below silently
  // under-counts and still looks plausible.
  for (const key of Object.keys(PILLAR_WEIGHTS)) {
    check(`hero shows the ${key} pillar`, pillars[key] !== undefined, Object.keys(pillars));
  }

  if (Object.keys(pillars).length === Object.keys(PILLAR_WEIGHTS).length) {
    let hs = 0;
    for (const [key, weight] of Object.entries(PILLAR_WEIGHTS)) hs += weight * pillars[key].value;
    const expected = Math.max(300, Math.min(850, Math.round(300 + (hs / 100) * 550)));

    const target = Number((read("assets/js/landing.js").match(/const TARGET = (\d+)/) || [])[1]);
    check("landing.js TARGET is the score the hero's own pillars produce",
      target === expected, { target, expected, hs: Number(hs.toFixed(2)) });

    // The band word beside the gauge is rendered by landing.js from
    // DefiBands, but the note copy states the band in prose too.
    const band = bandForScore(expected);
    check(`the sample scores ${expected}, which is band "${band}"`,
      BANDS.some((b) => b.key === band), band);

    // coverageOf sums WEIGHTS, not pillars: four real pillars out of five is
    // 90% here, not 80%. The note says so in words, so pin the number.
    const coverage = Math.round(coverageOf(pillars) * 100);
    const stated = Number((landing.match(/Coverage:\s*<b>(\d+)% live data<\/b>/) || [])[1]);
    check("the hero's stated coverage is the weight sum, not the pillar count",
      stated === coverage, { stated, coverage, naiveCount: 80 });

    // An estimated pillar is held at the engine's neutral value. If the
    // markup ever shows an estimated pillar at anything else, the page is
    // claiming we estimated a specific number.
    for (const [key, p] of Object.entries(pillars)) {
      if (p.real) continue;
      check(`estimated pillar ${key} sits at the neutral 50`, p.value === 50, p);
    }
  }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
