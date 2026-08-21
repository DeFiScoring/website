// AI score explanations: narrator-not-scorer contract, persistence-backed
// prompts, caching, and honest failure modes. The AI binding is stubbed so
// assertions run against the exact facts we would have sent the model.
import { D1, KV } from "./d1.mjs";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { eip191Digest } from "../worker/lib/auth.js";
import { buildExplanationPrompt } from "../worker/handlers/explain.js";
import worker from "../worker/index.js";

const ORIGIN = "https://defiscoring.com";
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log((cond ? "PASS  " : "FAIL  ") + name + (cond ? "" : "  →  " + JSON.stringify(detail)));
}

function keyFor(n) { return new Uint8Array(32).fill(n); }
function addrFor(n) {
  const pub = secp256k1.getPublicKey(keyFor(n), false);
  return "0x" + Buffer.from(keccak_256(pub.slice(1))).toString("hex").slice(-40);
}
function personalSign(msg, n) {
  const sig = secp256k1.sign(eip191Digest(msg), keyFor(n));
  return "0x" + Buffer.from(sig.toCompactRawBytes()).toString("hex") +
    (27 + sig.recovery).toString(16).padStart(2, "0");
}
const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");
function siwe({ address, nonce }) {
  return [
    "defiscoring.com wants you to sign in with your Ethereum account:",
    address, "", "Sign in to DeFi Scoring.", "",
    "URI: https://defiscoring.com/",
    "Version: 1", "Chain ID: 1",
    "Nonce: " + nonce,
    "Issued At: " + iso(Date.now()),
  ].join("\n");
}

(async () => {
  const aiCalls = [];
  const env = {
    HEALTH_DB: new D1("./migrations"),
    DEFI_CACHE: new KV(),
    SESSION_HMAC_KEY: "k",
    ALLOWED_ORIGINS: ORIGIN,
    AI: {
      run: async (model, opts) => {
        aiCalls.push({ model, opts });
        return { response: "Narrated: " + opts.messages[1].content.slice(0, 60) };
      },
    },
  };
  let cookie = null;
  const call = async (path) => {
    const h = { origin: ORIGIN };
    if (cookie) h.cookie = cookie;
    const res = await worker.fetch(new Request(ORIGIN + path, { headers: h }), env, { waitUntil() {} });
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return { status: res.status, json: await res.json() };
  };
  const post = async (path, body) => {
    const h = { origin: ORIGIN, "content-type": "application/json" };
    if (cookie) h.cookie = cookie;
    const res = await worker.fetch(
      new Request(ORIGIN + path, { method: "POST", headers: h, body: JSON.stringify(body) }),
      env, { waitUntil() {} });
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return { status: res.status, json: await res.json() };
  };

  const W = "0x00000000000000000000000000000000000000ab";

  // ---- auth gate: inference costs money, so it needs a session
  const anon = await call("/api/score-explanation?wallet=" + W);
  check("unauthenticated request is refused", anon.status === 401, anon);

  const addr = addrFor(41);
  const nonce = await call("/api/auth/nonce?address=" + addr);
  const msg = siwe({ address: nonce.json.address_checksum, nonce: nonce.json.nonce });
  await post("/api/auth/verify", { message: msg, signature: personalSign(msg, 41) });

  // ---- no persisted score: 404, never an explanation of nothing
  const none = await call("/api/score-explanation?wallet=" + W);
  check("no persisted score yields no_score_yet",
    none.status === 404 && none.json.error === "no_score_yet", none.json);
  check("no AI call was spent on a missing score", aiCalls.length === 0, aiCalls.length);

  // ---- persisted row with pillar summaries (post-#17 shape)
  await env.HEALTH_DB.prepare(
    `INSERT INTO health_scores (wallet, score, loan_reliability, liquidity_provision,
       governance, account_age, raw_h_s, source_json, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(W, 671, 50, 65, 30, 85, 58.2, JSON.stringify({
    source: "wallet-score", model: "2026.09", coverage: 0.65, score_band: "good",
    adjustments: [{ name: "multichain_user", delta: 30, reason: "Active on 3 chains" }],
    pillars: {
      loan_reliability: { value: 50, weight: 0.35, real: false, rationale: "No Aave V3, Spark or Compound V3 positions found across any chain — neutral score." },
      portfolio_health: { value: 78, weight: 0.25, real: true, rationale: "$12,400 across 3 chain(s); top position 41% of portfolio." },
      liquidity_provision: { value: 65, weight: 0.15, real: true, rationale: "2 live Uniswap V3 position(s) across 1 chain(s)." },
      governance: { value: 30, weight: 0.10, real: true, rationale: "0 Snapshot votes across 0 DAOs." },
      account_age: { value: 85, weight: 0.15, real: true, rationale: "812 days since first transaction (oldest on Base)." },
    },
  }), Date.now()).run();

  const ok = await call("/api/score-explanation?wallet=" + W);
  check("explanation returned for a persisted score",
    ok.status === 200 && ok.json.success && typeof ok.json.explanation === "string", ok.json);
  check("based_on reports the real score, model and coverage",
    ok.json.based_on?.score === 671 && ok.json.based_on?.model === "2026.09" &&
    ok.json.based_on?.coverage === 0.65, ok.json.based_on);

  // The narrator contract: the model was fed only persisted facts.
  const sent = aiCalls[0]?.opts?.messages || [];
  const sys = sent[0]?.content || "";
  const facts = sent[1]?.content || "";
  check("system prompt forbids inventing numbers",
    /never invent/i.test(sys) && /ONLY the facts/i.test(sys), sys.slice(0, 120));
  check("facts carry the score and band", /671/.test(facts) && /good/.test(facts), facts.split("\n")[0]);
  check("facts carry the pillar rationales verbatim",
    facts.includes("oldest on Base") && facts.includes("41% of portfolio"), null);
  check("estimated pillar is flagged as neutral default, not poor performance",
    /loan reliability/i.test(facts) && facts.includes("[no data found — neutral default]"),
    facts.split("\n").find((l) => /Loan/i.test(l)));
  check("coverage is narrated as a fact line", /65% of the score's weight/.test(facts), null);
  check("adjustment included with its reason", /\+30 \(Active on 3 chains\)/.test(facts), null);

  // ---- caching: one inference per scan, no matter how often the page opens
  const again = await call("/api/score-explanation?wallet=" + W);
  check("second request is served from cache", again.json.cached === true, again.json);
  check("cache means exactly one AI inference", aiCalls.length === 1, aiCalls.length);

  // ---- a new scan invalidates the cache (key includes computed_at)
  await env.HEALTH_DB.prepare(
    `INSERT INTO health_scores (wallet, score, source_json, computed_at) VALUES (?, ?, ?, ?)`
  ).bind(W, 690, JSON.stringify({ model: "2026.09", score_band: "good", coverage: 0.8 }), Date.now() + 1000).run();
  const fresh = await call("/api/score-explanation?wallet=" + W);
  check("a newer scan re-narrates instead of serving the stale cache",
    fresh.json.cached === false && aiCalls.length === 2 && /690/.test(aiCalls[1].opts.messages[1].content),
    { cached: fresh.json.cached, calls: aiCalls.length });

  // ---- pre-pillar rows still narrate from the numeric columns
  const OLD = "0x00000000000000000000000000000000000000ac";
  await env.HEALTH_DB.prepare(
    `INSERT INTO health_scores (wallet, score, loan_reliability, liquidity_provision,
       governance, account_age, source_json, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(OLD, 610, 40, 50, 30, 70, JSON.stringify({ score_band: "fair" }), Date.now()).run();
  const old = await call("/api/score-explanation?wallet=" + OLD);
  check("legacy row (no pillar blob) still explains from the columns",
    old.status === 200 && /40\/100/.test(aiCalls[2]?.opts?.messages?.[1]?.content || ""), old.json);

  // ---- honest failures
  const badWallet = await call("/api/score-explanation?wallet=nope");
  check("invalid wallet rejected", badWallet.status === 400, badWallet.json);

  env.AI.run = async () => { throw new Error("model overloaded"); };
  await env.DEFI_CACHE.delete("explain:v1:" + OLD + ":" + (await env.HEALTH_DB.prepare(
    "SELECT computed_at FROM health_scores WHERE wallet = ?").bind(OLD).first()).computed_at + ":unversioned");
  const down = await call("/api/score-explanation?wallet=" + OLD);
  check("AI failure returns ai_failed, cached rows unaffected",
    down.status === 502 && down.json.error === "ai_failed", down.json);

  const noAi = { ...env, AI: undefined };
  const resNoAi = await worker.fetch(
    new Request(ORIGIN + "/api/score-explanation?wallet=" + W, { headers: { origin: ORIGIN, cookie } }),
    noAi, { waitUntil() {} });
  check("missing AI binding reports ai_unavailable, not a crash",
    resNoAi.status === 503, resNoAi.status);

  // buildExplanationPrompt is pure — degenerate blobs must not throw.
  const p1 = buildExplanationPrompt({ score: 700 }, null);
  check("prompt builder tolerates a null blob", /700/.test(p1), p1);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
})().catch((e) => { console.error("HARNESS ERROR", e); process.exitCode = 2; });
