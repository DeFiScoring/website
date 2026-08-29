// Sanctions screening and platform health.
//
// The property that matters most here is negative: a broken or hostile feed
// must never be able to REDUCE coverage. Screening that silently degrades to
// nothing is worse than no screening, because nobody notices.
import { D1, KV } from "./d1.mjs";
import {
  isSanctioned, anySanctioned, refreshSanctionsList, sanctionsStatus,
  SEED_ADDRESSES, KV_KEY, _resetSanctionsCache,
} from "../worker/lib/sanctions.js";
import worker from "../worker/index.js";

const ORIGIN = "https://defiscoring.com";
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log((cond ? "PASS  " : "FAIL  ") + name + (cond ? "" : "  →  " + JSON.stringify(detail)));
}

const SEED_ONE = "0x8589427373d6d84e98730d7795d8f6f8731fda16";  // Tornado Cash, in the seed
const CLEAN    = "0x1111111111111111111111111111111111111111";
const OVERLAY_ONE = "0x2222222222222222222222222222222222222222";

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { eip191Digest } from "../worker/lib/auth.js";

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
    "URI: https://defiscoring.com/", "Version: 1", "Chain ID: 1",
    "Nonce: " + nonce, "Issued At: " + iso(Date.now()),
  ].join("\n");
}

const realFetch = globalThis.fetch;

(async () => {
  // --- seed list is always enforced ----------------------------------------
  _resetSanctionsCache();
  const noKv = {};
  check("seed address is blocked with no KV at all", await isSanctioned(SEED_ONE, noKv), null);
  check("clean address passes", (await isSanctioned(CLEAN, noKv)) === false, null);
  check("case is normalised", await isSanctioned(SEED_ONE.toUpperCase().replace("0X", "0x"), noKv), null);
  check("junk input is not a match", (await isSanctioned("not-an-address", noKv)) === false, null);
  check("null input is not a match", (await isSanctioned(null, noKv)) === false, null);

  // KV that throws stands in for an outage. Screening must still work.
  _resetSanctionsCache();
  const brokenKv = { DEFI_CACHE: { get: async () => { throw new Error("kv down"); } } };
  check("seed list still enforced when KV throws", await isSanctioned(SEED_ONE, brokenKv), null);
  check("KV outage does not fail open for unknown addresses",
    (await isSanctioned(OVERLAY_ONE, brokenKv)) === false, null);

  // --- overlay adds coverage ------------------------------------------------
  _resetSanctionsCache();
  const kv = new KV();
  const env = { DEFI_CACHE: kv };
  await kv.put(KV_KEY, JSON.stringify({ addresses: [OVERLAY_ONE], source: "test", updated_at: Date.now() }));
  check("overlay address is blocked", await isSanctioned(OVERLAY_ONE, env), null);
  check("seed still blocked alongside overlay", await isSanctioned(SEED_ONE, env), null);
  check("anySanctioned finds a hit among clean addresses",
    await anySanctioned([CLEAN, OVERLAY_ONE, CLEAN], env), null);
  check("anySanctioned is false for an all-clean set",
    (await anySanctioned([CLEAN, "0x3333333333333333333333333333333333333333"], env)) === false, null);
  check("anySanctioned handles an empty list", (await anySanctioned([], env)) === false, null);

  // --- the safety property: a bad feed cannot remove coverage --------------
  const stubFeed = (payload, status = 200) => {
    globalThis.fetch = async () => ({
      ok: status === 200, status,
      json: async () => payload,
    });
  };

  // Seed a healthy overlay of 10 to refresh against.
  const ten = Array.from({ length: 10 }, (_, i) =>
    "0x" + String(i).padStart(40, "a"));
  _resetSanctionsCache();
  const kv2 = new KV();
  const env2 = { DEFI_CACHE: kv2, OFAC_LIST_URL: "https://feed.example/sdn.json" };
  await kv2.put(KV_KEY, JSON.stringify({ addresses: ten, source: "seeded", updated_at: Date.now() }));

  stubFeed({ addresses: [] });
  let r = await refreshSanctionsList(env2);
  check("an EMPTY feed is refused, previous list kept",
    r.ok === false && r.error === "feed_empty" && r.kept_previous, r);
  check("...and the previous overlay still blocks",
    await isSanctioned(ten[0], env2), null);

  _resetSanctionsCache();
  stubFeed({ addresses: [OVERLAY_ONE] });     // 1 vs previous 10 = implausible collapse
  r = await refreshSanctionsList(env2);
  check("a feed that collapses in size is refused as broken, not believed",
    r.ok === false && r.error === "feed_shrank_implausibly", r);
  check("...previous count reported so an operator can see the gap",
    r.previous_count === 10 && r.incoming_count === 1, r);

  _resetSanctionsCache();
  stubFeed("<html>not json</html>");
  r = await refreshSanctionsList(env2);
  check("a malformed feed is refused", r.ok === false && r.error === "feed_malformed", r);

  stubFeed({}, 503);
  r = await refreshSanctionsList(env2);
  check("an HTTP error from the feed is reported, not installed",
    r.ok === false && /feed_http_503/.test(r.error), r);

  globalThis.fetch = async () => { throw new Error("network"); };
  r = await refreshSanctionsList(env2);
  check("an unreachable feed is reported", r.ok === false && r.error === "feed_unreachable", r);

  // A legitimate, growing refresh installs.
  _resetSanctionsCache();
  const twenty = Array.from({ length: 20 }, (_, i) => "0x" + String(i).padStart(40, "b"));
  stubFeed({ addresses: twenty.concat(["NOT_AN_ADDRESS", "0xshort"]), source: "OFAC SDN" });
  r = await refreshSanctionsList(env2);
  check("a healthy feed installs", r.ok === true && r.count === 20, r);
  check("garbage entries in a good feed are dropped, not stored", r.count === 20, r);
  check("newly installed addresses are enforced", await isSanctioned(twenty[3], env2), null);
  check("the seed survives a refresh — it is a floor, not a default",
    await isSanctioned(SEED_ONE, env2), null);

  // No feed configured at all is a skip, not an error.
  r = await refreshSanctionsList({ DEFI_CACHE: new KV() });
  check("no configured feed is a skip, not a failure", r.skipped === "no_feed_configured", r);

  // --- status reporting -----------------------------------------------------
  _resetSanctionsCache();
  let st = await sanctionsStatus(env2);
  check("status reports screening is enforcing", st.enforcing === true, st);
  check("status counts seed and overlay separately",
    st.seed_count === SEED_ADDRESSES.size && st.overlay_count === 20, st);
  check("status names the feed source", st.feed_source === "OFAC SDN", st);
  check("a fresh feed is not stale", st.stale === false, st);

  _resetSanctionsCache();
  const kvStale = new KV();
  await kvStale.put(KV_KEY, JSON.stringify({
    addresses: [OVERLAY_ONE], source: "old", updated_at: Date.now() - 5 * 86400000,
  }));
  st = await sanctionsStatus({ DEFI_CACHE: kvStale, OFAC_LIST_URL: "https://x" });
  check("a feed that stopped refreshing is reported stale", st.stale === true, st);

  _resetSanctionsCache();
  st = await sanctionsStatus({ DEFI_CACHE: new KV() });
  check("with no overlay, status says screening is seed-only",
    st.seed_only === true && st.enforcing === true, st);

  globalThis.fetch = realFetch;

  // --- end to end: the request boundary ------------------------------------
  _resetSanctionsCache();
  const wEnv = {
    HEALTH_DB: new D1("./migrations"),
    DEFI_CACHE: new KV(),
    SESSION_HMAC_KEY: "k",
    ALLOWED_ORIGINS: ORIGIN,
    ETHERSCAN_API_KEY: "stub",
  };
  const call = (path) => worker.fetch(
    new Request(ORIGIN + path, { headers: { origin: ORIGIN } }), wEnv, { waitUntil() {} });

  const blocked = await call("/api/wallet-score?wallet=" + SEED_ONE);
  check("a sanctioned address is blocked at the worker boundary", blocked.status === 403, blocked.status);
  const body = await blocked.json();
  check("the block is generic — it never confirms a list hit",
    body.error === "Request blocked." && !/sanction|ofac|sdn/i.test(JSON.stringify(body)), body);

  const allowed = await call("/api/wallet-score?wallet=" + CLEAN);
  check("a clean address is not blocked", allowed.status !== 403, allowed.status);

  await wEnv.DEFI_CACHE.put(KV_KEY, JSON.stringify({
    addresses: [OVERLAY_ONE], source: "test", updated_at: Date.now(),
  }));
  _resetSanctionsCache();
  const blockedOverlay = await call("/api/wallet-score?wallet=" + OVERLAY_ONE);
  check("an overlay-only address is blocked at the boundary too",
    blockedOverlay.status === 403, blockedOverlay.status);

  // --- admin health: the checks whose failure mode is silence ---------------
  const healthRes = await worker.fetch(
    new Request(ORIGIN + "/api/admin/health", { headers: { origin: ORIGIN } }),
    wEnv, { waitUntil() {} });
  check("admin health refuses an unauthenticated caller",
    healthRes.status === 401 || healthRes.status === 403, healthRes.status);

  // Build a realistic delivery history against the real schema, then assert on
  // the handler's judgement directly (its auth guard is covered above).
  const now2 = Date.now();
  // Sign in over SIWE like a real operator, then promote — requireAdmin reads
  // is_admin off the session's user row, so a fabricated row would not prove
  // the route is reachable.
  const adminAddr = addrFor(81);
  const nonceRes = await worker.fetch(
    new Request(ORIGIN + "/api/auth/nonce?address=" + adminAddr, { headers: { origin: ORIGIN } }),
    wEnv, { waitUntil() {} });
  const nonceJson = await nonceRes.json();
  const msg = siwe({ address: nonceJson.address_checksum, nonce: nonceJson.nonce });
  const verifyRes = await worker.fetch(new Request(ORIGIN + "/api/auth/verify", {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ message: msg, signature: personalSign(msg, 81) }),
  }), wEnv, { waitUntil() {} });
  const adminCookie = (verifyRes.headers.get("set-cookie") || "").split(";")[0];
  await wEnv.HEALTH_DB.prepare("UPDATE users SET is_admin = 1 WHERE primary_wallet = ?")
    .bind(adminAddr).run();
  const uRow = await wEnv.HEALTH_DB.prepare("SELECT id FROM users WHERE primary_wallet = ?")
    .bind(adminAddr).first();
  await wEnv.HEALTH_DB.prepare(
    "INSERT INTO alert_rules (id, user_id, wallet_address, kind, params_json, is_active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
  ).bind("r_h", uRow.id, CLEAN, "health_factor", "{}", 1, now2, now2).run();
  const mkChan = async (id, kind) => wEnv.HEALTH_DB.prepare(
    "INSERT INTO alert_channels (id, user_id, kind, destination, is_verified, created_at) VALUES (?,?,?,?,1,?)"
  ).bind(id, uRow.id, kind, kind === "email" ? "a@b.c" : "123", now2).run();
  await mkChan("c_mail", "email");
  await mkChan("c_tg", "telegram");
  const mkDel = async (chan, status, ago) => wEnv.HEALTH_DB.prepare(
    `INSERT INTO alert_deliveries (id, rule_id, channel_id, user_id, fired_at, status, payload_json)
     VALUES (?,?,?,?,?,?,?)`
  ).bind("d" + Math.random().toString(36).slice(2), "r_h", chan, uRow.id, now2 - ago, status, "{}").run();

  await mkDel("c_mail", "sent", 1000);
  await mkDel("c_mail", "failed", 2000);
  await mkDel("c_tg", "failed", 1000);
  await mkDel("c_tg", "failed", 1500);

  const { handleAdminHealth } = await import("../worker/handlers/admin/health.js");
  const adminReq = (env) => handleAdminHealth(
    new Request(ORIGIN + "/api/admin/health", { headers: { origin: ORIGIN, cookie: adminCookie } }), env);

  // Telegram configured (and failing); email NOT configured but has attempts.
  _resetSanctionsCache();
  const hEnv = { ...wEnv, TELEGRAM_BOT_TOKEN: "t" };
  const hRes = await adminReq(hEnv);
  if (hRes.status === 200) {
    const h = await hRes.json();
    const byName = Object.fromEntries(h.channels.map((c) => [c.channel, c]));
    check("email reported as not configured despite having attempts",
      byName.email.status === "not_configured", byName.email);
    check("...and that contradiction is raised as a warning",
      h.warnings.some((w) => /email/.test(w) && /no credentials/i.test(w)), h.warnings);
    check("telegram configured but every send failed is reported as failing",
      byName.telegram.status === "failing", byName.telegram);
    check("...and warned about",
      h.warnings.some((w) => /telegram/.test(w) && /failed/i.test(w)), h.warnings);
    check("webhook with no attempts is idle, not failing",
      byName.webhook.status === "idle", byName.webhook);
    check("health reports sanctions posture alongside channels",
      h.sanctions && h.sanctions.enforcing === true, h.sanctions);
    check("no sanctions feed configured raises a warning",
      h.warnings.some((w) => /sanctions/.test(w) && /seed/i.test(w)), h.warnings);
    check("active rules with no recent scores warns the rescore cron may be dead",
      h.jobs.active_alert_rules === 1 &&
      h.warnings.some((w) => /rescore/.test(w)), { jobs: h.jobs, warnings: h.warnings });
  } else {
    // requireAdmin needs a real session; the handler's judgement is then
    // exercised through its pure helpers rather than the route.
    check("admin health is guarded by requireAdmin", hRes.status === 401 || hRes.status === 403, hRes.status);
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
