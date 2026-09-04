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

// --- API docs must describe the auth scheme that actually exists -----------
const apiDocs = read("api.md");
const apiKeysLib = read("worker/lib/api-keys.js");
check("API docs do not advertise a header the worker never reads",
  !/X-API-Key/i.test(apiDocs) || /x-api-key/i.test(read("worker/index.js")), "X-API-Key documented but unimplemented");
check("API docs document the Bearer scheme the worker implements",
  /Authorization:\s*Bearer/i.test(apiDocs) && /readBearerKey/.test(apiKeysLib), null);
check("API docs state the key is shown only once",
  /shown \*\*once\*\*|shown once/i.test(apiDocs), null);
check("API docs state the public endpoint needs no key",
  /No key is required/i.test(apiDocs), null);

// --- no tier may be sold a rate-limit advantage nothing grants -------------
// rateLimit() and rateLimitByAddress() in worker/index.js key on (path, IP)
// and (path, address). Neither reads a tier. Pro's card carried "Higher scan
// rate limits" for months: a Pro subscriber gets exactly the anonymous limit,
// and cannot buy out of it with a key either, because TIERS.pro's
// bulk_api.requests.day is 0 and chargeApiRequest answers 402. The compare
// table was honest ("Fair-use rate limit" in all four columns) while the
// bullet above it was not, which is why checking only the table missed it.
const tierAwareLimiter = /rateLimit\([^)]*\btier\b|\btier\b[^)]*rateLimit\(/.test(workerIndex);
// Match on tag-stripped text: the offending bullet was
// "<strong>Higher</strong> scan rate limits", so any pattern that treats "<"
// as a boundary walks straight past it.
const pricingText = pricing.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
check("no tier bullet claims a rate-limit advantage the limiter cannot give",
  tierAwareLimiter || !/(higher|increased|raised|priority)[^.]{0,40}rate limit/i.test(pricingText),
  "pricing sells a rate-limit tier the worker does not implement");

// --- API quota figures on the page must be the ones tiers.js enforces ------
const apiDay = (t) => TIERS[t].limits["bulk_api.requests.day"];
for (const tier of ["free", "pro"]) {
  check(`${tier} advertises no API/day figure while its budget is ${apiDay(tier)}`,
    apiDay(tier) > 0 || !new RegExp(`data-tier-label="${tier[0].toUpperCase()}${tier.slice(1)}"[^<]*>\\s*\\d+\\s*<`, "i")
      .test(pricing.slice(pricing.indexOf("API requests"), pricing.indexOf("API requests") + 400)),
    { tier, limit: apiDay(tier) });
}
// When the page does print a Plus figure, it must be the enforced one.
const plusApiClaim = pricing.match(/(\d+)\s*API requests\s*\/\s*day/i);
check("any advertised Plus API/day figure equals tiers.js",
  !plusApiClaim || Number(plusApiClaim[1]) === apiDay("plus"),
  { advertised: plusApiClaim && plusApiClaim[1], enforced: apiDay("plus") });

// "Dedicated" reads as per-customer provisioning. Enterprise is the same
// tier_quotas row and the same shared worker as Plus with a larger literal;
// changing one contract's budget means editing tiers.js and redeploying,
// which moves every Enterprise account at once.
check("Enterprise does not call its API budget dedicated while it is a shared code path",
  !/dedicated api quota/i.test(pricing), "Enterprise claims a dedicated quota");

// --- api.md may not invent a rate limit -----------------------------------
// api.md claimed "100 requests/minute on the free tier" and a matching 429
// row. No route in the worker uses 100/min. Every per-minute figure the docs
// print must appear as a literal in the limiter's call sites.
for (const m of apiDocs.matchAll(/(\d+)\s*(?:requests?|req)\s*\/\s*min/gi)) {
  check(`api.md's ${m[1]}/min limit exists in worker/index.js`,
    new RegExp(`rateLimit(?:ByAddress)?\\([^)]*,\\s*${m[1]},\\s*60\\s*\\)`).test(workerIndex), m[0]);
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

// --- the landing page may not sell a product we stopped being --------------
// index.html shipped for months claiming a "private beta" in which "every
// feature — including the public API — is free" with "no signups", while
// Pro at $15 and Plus at $49 were live through Stripe Checkout and SIWE
// sign-in gated history, alerts and linked wallets. One of those claims sat
// in the FAQ JSON-LD, which search engines republish as a rich result, so a
// stale sentence there is repeated by Google long after the page changes.
//
// The check is driven from the tier table rather than a word list: the day
// someone genuinely makes everything free again, price_usd_month goes to 0
// and this stops complaining on its own.
const paidTiers = ["pro", "plus"].filter((t) => TIERS[t].price_usd_month > 0);
const sellsPaidPlans = paidTiers.length > 0;
for (const [label, re] of [
  ["a private beta", /private beta/i],
  ["that there are no signups", /\bno signups\b|\bno signup,|>0<\/b>\s*signups/i],
  ["that every feature is free", /every feature[^.]*is free/i],
]) {
  check(`landing does not claim ${label} while ${paidTiers.join(" and ")} are sold`,
    !sellsPaidPlans || !re.test(landing), label);
}

// --- the API the landing page documents must be the one the worker serves --
// The FAQ answered "Does DeFiScore have a public API?" with an endpoint that
// does not exist (GET /api/score?wallet=…, which is the *protocol* score
// route) and a field the response has never carried ("LTV recommendation").
// A wrong path in JSON-LD is worse than no path: it is the copy a developer
// pastes into curl before deciding we are broken.
const landingApiPaths = [...landing.matchAll(/GET (\/api\/[a-z0-9/{}-]+)/gi)].map((m) => m[1]);
for (const p of landingApiPaths) {
  check(`landing documents "${p}", which worker/index.js routes`,
    workerIndex.includes(`"${p}"`) || workerIndex.includes(`"${p}/"`), p);
}
check("landing does not advertise an LTV recommendation the score never returns",
  !/LTV recommendation/i.test(landing) || /ltv_recommendation|ltvRecommendation/.test(workerIndex),
  "LTV recommendation claimed but never returned");

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

// --- freshness must be real, not stamped at response time -----------------
const protoHandler = read("worker/handlers/protocols.js");
const protoLib = read("worker/lib/protocols.js");
check("protocol catalog reports when TVL was actually fetched",
  /fetched_at/.test(protoHandler) && /fetched_at/.test(protoLib), null);
check("...and says whether the response came from cache",
  /cached/.test(protoHandler), null);
check("a cached payload written before fetched_at existed reports unknown, not now",
  /Array\.isArray\(cached\)/.test(protoLib) && /fetched_at: null/.test(protoLib), null);

// --- badge/share URLs use same-origin paths on the unified deployment -------
const badgePage = read("badge/index.html");
const config = read("_config.yml");
check("badge page does not reference the unprovisioned api.defiscoring.com host",
  !/api\.defiscoring\.com/.test(badgePage), null);
check("API docs do not reference the unprovisioned api.defiscoring.com host",
  !/api\.defiscoring\.com/.test(read("api.md")), null);
check("API docs state the apex as the base URL",
  /Base URL[\s\S]{0,40}https:\/\/defiscoring\.com/.test(read("api.md")), null);
check("badge page uses same-origin badge paths",
  badgePage.includes('var BADGE_BASE = "/badge/"'), null);
check("badge page uses same-origin share-card paths",
  badgePage.includes('shareImg.src = "/card/"') &&
  badgePage.includes('"https://defiscoring.com/share/"'), null);
check("how-it-works documents the apex badge URL",
  badgePage.includes("https://defiscoring.com/badge/"), null);
check("site.webmanifest exists for the link in _includes/head.html",
  fs.existsSync(path.join(root, "assets/favicon/site.webmanifest")), null);
check("_config.yml worker_url is empty for same-origin API calls",
  /worker_url:\s*""/.test(config), null);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
