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
