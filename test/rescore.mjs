// Scheduled re-scoring: stalest-watched-wallet selection, freshness gating,
// the same compute/persist path as a manual scan, and the closed loop where
// a rescored wallet's score_change alert can finally fire.
import { D1, KV } from "./d1.mjs";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { eip191Digest } from "../worker/lib/auth.js";
import { runScheduledRescore } from "../worker/handlers/rescore.js";
import { scanAlertRules } from "../worker/handlers/cron.js";
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
  const env = {
    HEALTH_DB: new D1("./migrations"),
    DEFI_CACHE: new KV(),
    SESSION_HMAC_KEY: "k",
    ALLOWED_ORIGINS: ORIGIN,
    ETHERSCAN_API_KEY: "stub",
  };
  let cookie = null;
  const call = async (method, path, body) => {
    const h = { origin: ORIGIN };
    if (body) h["content-type"] = "application/json";
    if (cookie) h.cookie = cookie;
    const res = await worker.fetch(
      new Request(ORIGIN + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }),
      env, { waitUntil() {} });
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return { status: res.status, json: await res.json() };
  };

  // Sign in and link two wallets via SIWE (rules require linked wallets).
  const signIn = async (n) => {
    const a = addrFor(n);
    const nonce = await call("GET", "/api/auth/nonce?address=" + a);
    const msg = siwe({ address: nonce.json.address_checksum, nonce: nonce.json.nonce });
    await call("POST", "/api/auth/verify", { message: msg, signature: personalSign(msg, n) });
    return a;
  };
  const W1 = await signIn(51);
  await env.HEALTH_DB.prepare(
    "UPDATE subscriptions SET tier='pro' WHERE user_id=(SELECT id FROM users WHERE primary_wallet=?)"
  ).bind(W1).run();

  // Generic scan stub: modest ETH balance, one first-tx 900 days old, no
  // DeFi positions, CoinGecko down, DefiLlama pricing ETH. Enough for a
  // real score through the honest gate.
  let fetches = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    fetches++;
    const u = String(input?.url || input);
    const J = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
    if (u.startsWith("https://api.etherscan.io/v2/api")) {
      const q = new URL(u).searchParams;
      const action = q.get("action");
      if (action === "balance") return J({ status: "1", message: "OK", result: "2000000000000000000" });
      if (action === "tokentx") return J({ status: "0", message: "No token transfers found", result: [] });
      if (action === "txlist") {
        return J({ status: "1", message: "OK", result: [{ timeStamp: String(Math.floor(Date.now() / 1000) - 86400 * 900) }] });
      }
      if (action === "eth_call") return J({ jsonrpc: "2.0", id: 1, result: "0x" + "0".repeat(64 * 6) });
      return J({ status: "0", message: "NOTOK", result: "unsupported" });
    }
    if (u.includes("llama.fi")) {
      const keys = decodeURIComponent(u.split("/current/")[1] || "").split(",");
      const coins = {};
      for (const k of keys) if (k === "coingecko:ethereum") coins[k] = { price: 3000, symbol: "ETH" };
      return J({ coins });
    }
    if (u.includes("snapshot.org")) return J({ data: { votes: [] } });
    return J({});
  };

  // ---- no watched wallets: nothing to do, nothing spent
  const idle = await runScheduledRescore(env, { waitUntil() {} });
  check("no watched wallets: skipped without scanning",
    idle.ok && idle.skipped === "no_watched_wallets" && fetches === 0, idle);

  // ---- a wallet with an active rule and no score history gets scored
  const rule = await call("POST", "/api/alerts/rules", {
    wallet_address: W1, kind: "score_change",
    params: { delta: 30, direction: "either" }, channels: ["email"],
  });
  check("score_change rule created", rule.json.success === true, rule.json);

  const r1 = await runScheduledRescore(env, { waitUntil() {} });
  check("never-scored watched wallet is picked and scored",
    r1.ok && r1.wallet === W1.toLowerCase() && r1.scored === true &&
    r1.score >= 300 && r1.score <= 850, r1);
  const persisted = await env.HEALTH_DB.prepare(
    "SELECT score, source_json FROM health_scores WHERE wallet = ? ORDER BY computed_at DESC LIMIT 1"
  ).bind(W1.toLowerCase()).first();
  check("rescore persisted through the normal path (model + pillars in blob)",
    persisted?.score === r1.score &&
    JSON.parse(persisted.source_json).model != null, persisted?.score);

  // ---- freshness gate: an immediate second run must not rescan
  const fBefore = fetches;
  const r2 = await runScheduledRescore(env, { waitUntil() {} });
  check("fresh wallet is skipped, not rescanned",
    r2.ok && r2.skipped === "all_fresh" && fetches === fBefore, r2);

  // ---- stalest-first: a second watched wallet with an OLDER scan wins
  const W2 = await signIn(52);
  await env.HEALTH_DB.prepare(
    "UPDATE subscriptions SET tier='pro' WHERE user_id=(SELECT id FROM users WHERE primary_wallet=?)"
  ).bind(W2).run();
  await call("POST", "/api/alerts/rules", {
    wallet_address: W2, kind: "score_change",
    params: { delta: 30, direction: "either" }, channels: ["email"],
  });
  const OLD = Date.now() - 48 * 3600 * 1000;
  await env.HEALTH_DB.prepare(
    "INSERT INTO health_scores (wallet, score, source_json, computed_at) VALUES (?, ?, ?, ?)"
  ).bind(W2.toLowerCase(), 500, JSON.stringify({ score_band: "poor" }), OLD).run();

  const r3 = await runScheduledRescore(env, { waitUntil() {} });
  check("the stalest watched wallet is rescored first",
    r3.ok && r3.wallet === W2.toLowerCase() && r3.scored === true, r3);

  // ---- the closed loop: a rescored score lets score_change finally fire
  // Seed the rule's previous snapshot far from the fresh score, then run the
  // ordinary 5-minute alert scan: state.score now comes from the rescore.
  const fresh = await env.HEALTH_DB.prepare(
    "SELECT score FROM health_scores WHERE wallet = ? ORDER BY computed_at DESC LIMIT 1"
  ).bind(W2.toLowerCase()).first();
  await env.HEALTH_DB.prepare(
    "UPDATE alert_rules SET last_value = ? WHERE wallet_address = ?"
  ).bind(JSON.stringify({ score: fresh.score - 100 }), W2.toLowerCase()).run();
  const scan = await scanAlertRules(env, { waitUntil() {} });
  check("score_change fires off the scheduled rescore (the loop is closed)",
    scan.ok && scan.fired >= 1, scan);

  // ---- unwatched and deactivated wallets are never rescored
  const stray = "0x00000000000000000000000000000000000000e1";
  await env.HEALTH_DB.prepare(
    "INSERT INTO health_scores (wallet, score, source_json, computed_at) VALUES (?, ?, ?, ?)"
  ).bind(stray, 400, "{}", Date.now() - 90 * 24 * 3600 * 1000).run();

  // A wallet whose only rule is DEACTIVATED, with the stalest score of all —
  // it must lose to active wallets and never be picked. This is the fixture
  // that pins the is_active filter: drop it and this wallet wins every run.
  const W3 = await signIn(53);
  await env.HEALTH_DB.prepare(
    "UPDATE subscriptions SET tier='pro' WHERE user_id=(SELECT id FROM users WHERE primary_wallet=?)"
  ).bind(W3).run();
  const inactiveRule = await call("POST", "/api/alerts/rules", {
    wallet_address: W3, kind: "score_change",
    params: { delta: 30, direction: "either" }, channels: ["email"], is_active: false,
  });
  check("inactive rule created for the fixture", inactiveRule.json.success === true, inactiveRule.json);
  await env.HEALTH_DB.prepare(
    "INSERT INTO health_scores (wallet, score, source_json, computed_at) VALUES (?, ?, ?, ?)"
  ).bind(W3.toLowerCase(), 450, "{}", Date.now() - 365 * 24 * 3600 * 1000).run();

  const r4 = await runScheduledRescore(env, { waitUntil() {} });
  check("wallets without active rules are never picked",
    r4.wallet !== stray && r4.wallet !== W3.toLowerCase(), r4);

  // ---- the cron dispatch actually routes */15 to the rescorer
  await env.HEALTH_DB.prepare(
    "UPDATE health_scores SET computed_at = ? WHERE wallet = ?"
  ).bind(Date.now() - 30 * 3600 * 1000, W1.toLowerCase()).run();
  const countBefore = (await env.HEALTH_DB.prepare(
    "SELECT COUNT(*) c FROM health_scores WHERE wallet = ?").bind(W1.toLowerCase()).first()).c;
  let settled = Promise.resolve();
  await worker.scheduled({ cron: "*/15 * * * *" }, env, { waitUntil(p) { settled = p; } });
  await settled;
  const countAfter = (await env.HEALTH_DB.prepare(
    "SELECT COUNT(*) c FROM health_scores WHERE wallet = ?").bind(W1.toLowerCase()).first()).c;
  check("the */15 cron trigger dispatches a rescore",
    countAfter === countBefore + 1, { countBefore, countAfter });

  globalThis.fetch = realFetch;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
})().catch((e) => { console.error("HARNESS ERROR", e); process.exitCode = 2; });
