// Social share card.
//
// A shared card is the most context-free place the score ever appears —
// nobody following a link has seen the dashboard's caveats. So the checks that
// matter most are about what the card refuses to imply.
import { D1, KV } from "./d1.mjs";
import { cardSvg } from "../worker/handlers/share-card.js";
import worker from "../worker/index.js";

const ORIGIN = "https://defiscoring.com";
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log((cond ? "PASS  " : "FAIL  ") + name + (cond ? "" : "  →  " + JSON.stringify(detail)));
}

const WALLET = "0x00000000000000000000000000000000000000a1";
const UNSCORED = "0x00000000000000000000000000000000000000b2";

// --- the SVG, as a pure function -----------------------------------------
const full = cardSvg({ address: WALLET, score: 742, coverage: 1, computedAt: Date.UTC(2026, 7, 20) });
check("card is a 1200x630 open-graph SVG",
  full.startsWith("<svg") && full.includes('width="1200"') && full.includes('height="630"'), null);
check("the score is rendered", full.includes(">742<"), null);
check("the band label is rendered", /Excellent/.test(full), null);
check("the wallet is shortened, never printed in full",
  full.includes("0x0000…00a1") && !full.includes(WALLET), null);
check("the scale is stated so the number is interpretable",
  full.includes("300 — 850"), null);
check("the as-of date is on the card", full.includes("as of 2026-08-20"), null);

// The point of the whole exercise.
const partial = cardSvg({ address: WALLET, score: 742, coverage: 0.4, computedAt: Date.UTC(2026, 7, 20) });
check("a partially-covered score says so on the card",
  partial.includes("Scored on 40% live data"), null);
check("...prominently, in the warning colour",
  /#facc15/.test(partial), null);
check("a fully-covered score does not shout about coverage",
  !full.includes("live data"),
  "printing '100% data' on every card trains people to ignore the line");

const unscored = cardSvg({ address: UNSCORED, score: null });
check("an unscored wallet shows a dash, not a zero",
  unscored.includes(">—<") && !unscored.includes(">0<"), null);
check("...and is labelled as not scored", unscored.includes("Not scored"), null);
check("an unscored card draws no gauge arc",
  (unscored.match(/stroke-width="24"/g) || []).length === 1, null);
// An "as of" date on a card with no score implies a score was computed then.
const unscoredDated = cardSvg({ address: UNSCORED, score: null, computedAt: Date.UTC(2026, 7, 20) });
check("an unscored card carries no as-of date, even if one is passed",
  !unscoredDated.includes("as of"),
  "a date implies a score was computed; there is none");

// Escaping: the address is interpolated into XML.
const nasty = cardSvg({ address: '0x"><script>alert(1)</script>', score: 500 });
check("interpolated text is XML-escaped",
  !nasty.includes("<script>") && nasty.includes("&lt;"), null);

// Band boundaries must agree with the canonical scorer, not a local copy.
const { bandForScore } = await import("../worker/lib/score.js");
for (const s of [300, 579, 580, 659, 660, 719, 720, 850]) {
  const svgOut = cardSvg({ address: WALLET, score: s });
  const expected = { excellent: "Excellent", good: "Good", fair: "Fair", poor: "Poor" }[bandForScore(s)];
  check(`score ${s} shows the band bandForScore gives (${expected})`,
    svgOut.includes(`>${expected}<`), { expected, band: bandForScore(s) });
}

// --- the spec strip -------------------------------------------------------
// Coverage/Band/Model exist for the two cases the card used to render as
// nothing at all: full coverage, and coverage we never recorded. Those look
// identical without them, so a reader cannot tell "we saw everything" from
// "we don't know what we saw".
const { BAND_META, MARK_PATHS, UNKNOWN_BAND } = await import("../worker/lib/bands.js");

const chipped = cardSvg({ address: WALLET, score: 742, coverage: 1, computedAt: Date.UTC(2026, 7, 20), model: "2026.11" });
check("full coverage states itself rather than staying silent", chipped.includes("Coverage 100%"), null);
check("the band chip carries the range, built from BAND_META", chipped.includes("Band 720–850"), null);
check("the model chip carries the persisted version", chipped.includes("Model 2026.11"), null);
// The pre-existing pin: on a fully covered card the phrase must not appear at
// all, which is why the chip reads "Coverage 100%" and not "100% live data".
check("a full-coverage card still says nothing about live data", !chipped.includes("live data"), null);

check("the band chip range tracks the band",
  cardSvg({ address: WALLET, score: 400, model: "2026.11" }).includes(`Band ${BAND_META[3].floor}–${BAND_META[3].ceil}`),
  null);
check("coverage we never recorded is n/a, never 0%",
  cardSvg({ address: WALLET, score: 742, model: "2026.11" }).includes("Coverage n/a"), null);

// A row from the legacy writer has no model. No chip beats a wrong one — and
// beats an invented one, which is what a SCORE_MODEL_VERSION default would be.
const noModel = cardSvg({ address: WALLET, score: 742, coverage: 1 });
check("no model, no model chip", !noModel.includes("Model"), null);
for (const bad of ["banana", "x".repeat(5000), "26.1", 12345]) {
  const out = cardSvg({ address: WALLET, score: 742, coverage: 1, model: bad });
  const widest = Math.max(...[...out.matchAll(/x="(\d+(?:\.\d+)?)"/g)].map((m) => Number(m[1])));
  check(`a malformed model (${String(bad).slice(0, 12)}) cannot push the card off its own canvas`,
    widest <= 1200, { widest });
}

// The unscored card stays as minimal as it is: three chips reporting what we
// don't know make an un-scanned address look like a failure.
const bare = cardSvg({ address: UNSCORED, score: null });
check("an unscored card carries no spec strip",
  !bare.includes("Coverage") && !bare.includes("Band ") && !bare.includes("Model"), null);

// --- the band mark --------------------------------------------------------
// Geometry, not a text glyph: this image is rasterised by Slack, Discord and
// LinkedIn with fonts we do not ship, and U+2605 is outside WGL4.
check("the excellent card draws the star as a path", chipped.includes(MARK_PATHS.star), null);
check("a fair card draws the diamond",
  cardSvg({ address: WALLET, score: 600 }).includes(MARK_PATHS.diamond), null);
check("the unscored card draws the grey ring",
  bare.includes(`stroke="${UNKNOWN_BAND.color}"`) && bare.includes('r="1"'), null);
check("no mark is a text node", !/>[★▲◆▼○]</.test(chipped + bare), null);
// The mark must not have been achieved by touching the pinned label node.
check("the band label is still a bare text node beside the mark",
  chipped.includes(">Excellent<") && bare.includes(">Not scored<"), null);
check("adding the strip did not add a second gauge stroke",
  (bare.match(/stroke-width="24"/g) || []).length === 1, null);

// --- routes ----------------------------------------------------------------
const env = {
  HEALTH_DB: new D1("./migrations"),
  DEFI_CACHE: new KV(),
  SESSION_HMAC_KEY: "k",
  ALLOWED_ORIGINS: ORIGIN,
};
const get = (p) => worker.fetch(new Request(ORIGIN + p, { headers: { origin: ORIGIN } }), env, { waitUntil() {} });

await env.HEALTH_DB.prepare(
  "INSERT INTO health_scores (wallet, score, source_json, computed_at) VALUES (?,?,?,?)"
).bind(WALLET, 742, JSON.stringify({ score_band: "excellent", coverage: 0.4 }), Date.UTC(2026, 7, 20)).run();

let r = await get(`/card/${WALLET}.svg`);
check("card route serves image/svg+xml",
  r.status === 200 && /image\/svg\+xml/.test(r.headers.get("content-type")), r.status);
const body = await r.text();
check("card reads the persisted score", body.includes(">742<"), null);
check("card carries the persisted coverage caveat",
  body.includes("Scored on 40% live data"), null);
check("card is edge-cacheable", /max-age=\d+/.test(r.headers.get("cache-control") || ""), null);
check("card cannot host script", /default-src 'none'/.test(r.headers.get("content-security-policy") || ""), null);
check("card sets nosniff", r.headers.get("x-content-type-options") === "nosniff", null);

r = await get("/card/not-an-address.svg");
check("a malformed address gets a placeholder card, not a 500",
  r.status === 400 && /image\/svg\+xml/.test(r.headers.get("content-type")), r.status);

r = await get(`/card/${UNSCORED}.svg`);
check("an unscored wallet still renders a card", r.status === 200, r.status);
check("...showing no score rather than inventing one",
  (await r.text()).includes("Not scored"), null);

// --- rows the current writer did not write ---------------------------------
// source_json has two writers: persistWalletScore stores model/coverage/…,
// while the legacy persistScore in worker/index.js stores the raw signals
// object with none of those keys. Every chip must therefore be conditional on
// its own field, not on the blob parsing.
const LEGACY  = "0x00000000000000000000000000000000000000c3";
const CORRUPT = "0x00000000000000000000000000000000000000d4";
await env.HEALTH_DB.prepare(
  "INSERT INTO health_scores (wallet, score, source_json, computed_at) VALUES (?,?,?,?)"
).bind(LEGACY, 700, JSON.stringify({ aave: {}, uniswap: {}, snapshot: {} }), Date.UTC(2026, 7, 21)).run();
await env.HEALTH_DB.prepare(
  "INSERT INTO health_scores (wallet, score, source_json, computed_at) VALUES (?,?,?,?)"
).bind(CORRUPT, 640, "{not json", Date.UTC(2026, 7, 21)).run();

const { SCORE_MODEL_VERSION } = await import("../worker/lib/score.js");
for (const [addr, score, kind] of [[LEGACY, 700, "legacy"], [CORRUPT, 640, "corrupt"]]) {
  const res = await get(`/card/${addr}.svg`);
  const svgBody = await res.text();
  check(`a ${kind} source_json still renders a card`,
    res.status === 200 && svgBody.includes(`>${score}<`), res.status);
  check(`...with coverage reported as unknown, not as zero`,
    svgBody.includes("Coverage n/a") && !svgBody.includes(">0<"), null);
  check(`...with the band still derived from the score`,
    svgBody.includes("Band "), null);
  // The pin that stops someone "fixing" the missing chip with a one-line
  // default: stamping today's model onto a row produced by an unknown one
  // would be a fabrication, and it is the tempting change.
  check(`...and no model invented for it`,
    !svgBody.includes("Model") && !svgBody.includes(SCORE_MODEL_VERSION), null);
}

// --- the share page --------------------------------------------------------
r = await get(`/share/${WALLET}`);
check("share page is HTML", r.status === 200 && /text\/html/.test(r.headers.get("content-type")), r.status);
const page = await r.text();
check("og:image points at the card", page.includes(`/card/${WALLET}.svg`), null);
check("og:image dimensions are declared so crawlers lay it out",
  page.includes('og:image:width" content="1200"'), null);
check("twitter card is summary_large_image", page.includes("summary_large_image"), null);
check("the title carries the score", /742/.test(page), null);
check("the DESCRIPTION also carries the coverage caveat",
  /40% live on-chain data/.test(page),
  "some clients show the description and not the image");
check("a human is sent on to the dashboard",
  page.includes(`/dashboard/?wallet=${WALLET}`), null);
check("the canonical URL is the dashboard, not the share shim",
  /rel="canonical" href="[^"]*\/dashboard\//.test(page), null);

r = await get("/share/nope");
check("a malformed share URL 404s", r.status === 404, r.status);

const unscoredPage = await (await get(`/share/${UNSCORED}`)).text();
check("an unscored wallet's page does not claim a score",
  /has not been scored yet/.test(unscoredPage) && !/\/850/.test(unscoredPage), null);

const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
