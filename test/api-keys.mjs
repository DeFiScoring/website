// API keys — the licensing primitive.
//
// What has to hold for this to be sellable: a key authenticates, it is metered
// against the payer's tier, revocation is immediate and visible, one customer
// can never see or spend another's, and the public endpoint keeps working
// without a key exactly as /pricing/ promises.
import { D1, KV } from "./d1.mjs";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { eip191Digest } from "../worker/lib/auth.js";
import { hashKey, readBearerKey, generateKey } from "../worker/lib/api-keys.js";
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
    "URI: https://defiscoring.com/", "Version: 1", "Chain ID: 1",
    "Nonce: " + nonce, "Issued At: " + iso(Date.now()),
  ].join("\n");
}
function makeCall(env, jar) {
  return async function call(method, path, body, extraHeaders) {
    const h = { origin: ORIGIN, ...(extraHeaders || {}) };
    if (body) h["content-type"] = "application/json";
    if (jar.cookie) h.cookie = jar.cookie;
    const res = await worker.fetch(
      new Request(ORIGIN + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }),
      env, { waitUntil() {} });
    const sc = res.headers.get("set-cookie");
    if (sc) jar.cookie = sc.split(";")[0];
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, json, headers: res.headers };
  };
}

(async () => {
  // --- pure helpers ---------------------------------------------------------
  const g = generateKey();
  check("generated key carries the dfs_live_ prefix", g.raw.startsWith("dfs_live_"), g.raw.slice(0, 12));
  check("generated key has full entropy length", g.raw.length === "dfs_live_".length + 40, g.raw.length);
  check("two keys never collide", generateKey().raw !== generateKey().raw, null);
  check("hash is stable and hex", /^[0-9a-f]{64}$/.test(await hashKey(g.raw)), null);
  check("different keys hash differently", (await hashKey(g.raw)) !== (await hashKey(generateKey().raw)), null);

  const bearer = (v) => readBearerKey(new Request(ORIGIN, { headers: { authorization: v } }));
  check("bearer parser accepts a well-formed key", bearer("Bearer " + g.raw) === g.raw, null);
  check("bearer parser is case-insensitive on the scheme", bearer("bearer " + g.raw) === g.raw, null);
  check("bearer parser rejects a foreign token shape", bearer("Bearer abc123") === null, null);
  check("bearer parser rejects a truncated key", bearer("Bearer " + g.raw.slice(0, -4)) === null, null);
  check("no header means no key (public path)", bearer("") === null, null);

  // --- wiring ---------------------------------------------------------------
  const env = {
    HEALTH_DB: new D1("./migrations"),
    DEFI_CACHE: new KV(),
    SESSION_HMAC_KEY: "k",
    ALLOWED_ORIGINS: ORIGIN,
    ETHERSCAN_API_KEY: "stub",
  };
  const jarA = {}, jarB = {};
  const callA = makeCall(env, jarA), callB = makeCall(env, jarB);
  const signIn = async (call, n) => {
    const a = addrFor(n);
    const nonce = await call("GET", "/api/auth/nonce?address=" + a);
    const msg = siwe({ address: nonce.json.address_checksum, nonce: nonce.json.nonce });
    await call("POST", "/api/auth/verify", { message: msg, signature: personalSign(msg, n) });
    const row = await env.HEALTH_DB.prepare("SELECT id FROM users WHERE primary_wallet = ?").bind(a).first();
    return row.id;
  };
  const setTier = async (userId, tier) => {
    const now = Date.now();
    await env.HEALTH_DB.prepare(
      `INSERT INTO subscriptions (user_id, tier, status, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET tier = excluded.tier, updated_at = excluded.updated_at`
    ).bind(userId, tier, now, now).run();
  };

  const anon = await callA("GET", "/api/keys");
  check("key management requires a session", anon.status === 401, anon.status);

  const userA = await signIn(callA, 71);
  const userB = await signIn(callB, 72);

  // --- tier gate at the point of decision -----------------------------------
  const freeAttempt = await callA("POST", "/api/keys", { name: "should-fail" });
  check("free tier cannot mint a key (bulk_api limit is 0)",
    freeAttempt.status === 402 && freeAttempt.json.error === "api_access_not_in_plan", freeAttempt.json);
  check("the refusal points at an upgrade path",
    freeAttempt.json.upgrade_url === "/pricing/", freeAttempt.json);

  const proAttempt = await (async () => { await setTier(userA, "pro"); return callA("POST", "/api/keys", {}); })();
  check("pro tier also has no API quota, so also cannot mint",
    proAttempt.status === 402, proAttempt.json);

  // --- issuance -------------------------------------------------------------
  await setTier(userA, "plus");
  const created = await callA("POST", "/api/keys", { name: "underwriting-prod" });
  check("plus tier can issue a key", created.status === 201 && created.json.success, created.json);
  const RAW = created.json.api_key;
  check("the raw key is returned exactly once, on creation", typeof RAW === "string" && RAW.startsWith("dfs_live_"), null);
  check("creation warns the key cannot be retrieved again",
    /cannot be shown again/i.test(created.json.warning || ""), created.json.warning);
  check("the name round-trips", created.json.name === "underwriting-prod", created.json.name);

  const stored = await env.HEALTH_DB.prepare("SELECT key_hash, prefix FROM api_keys WHERE id = ?")
    .bind(created.json.id).first();
  check("the database stores a hash, never the key itself",
    stored.key_hash === await hashKey(RAW) && !JSON.stringify(stored).includes(RAW), null);
  check("the stored prefix is a non-secret fragment of the key",
    RAW.startsWith(stored.prefix) && stored.prefix.length < RAW.length, stored.prefix);

  const listed = await callA("GET", "/api/keys");
  check("listing never returns the secret", !JSON.stringify(listed.json).includes(RAW), null);
  check("listing shows the prefix so a user can tell keys apart",
    listed.json.keys[0].prefix === stored.prefix, listed.json.keys[0]);
  check("listing reports the tier's daily quota",
    listed.json.quota.limit === 100 && listed.json.api_access === true, listed.json.quota);

  // --- authentication on the metered endpoint -------------------------------
  const WALLET = "0x00000000000000000000000000000000000000a7";
  const withKey = (k) => ({ authorization: "Bearer " + k });

  const badKey = await callA("GET", "/api/wallet-score?wallet=" + WALLET, null,
    withKey("dfs_live_" + "0".repeat(40)));
  check("an unknown key is rejected with 401, not silently downgraded",
    badKey.status === 401 && badKey.json.error === "invalid_api_key", badKey.json);

  // Public access must still work with no key at all — that is the promise on
  // the pricing page, and a regression here breaks every anonymous caller.
  const publicCall = await callA("GET", "/api/wallet-score?wallet=" + WALLET);
  check("the endpoint stays public when no key is presented",
    publicCall.status !== 401 && publicCall.status !== 402, publicCall.status);

  const usedBefore = await env.HEALTH_DB.prepare(
    "SELECT used FROM tier_quotas WHERE user_id = ? AND quota_key = 'bulk_api.requests.day'"
  ).bind(userA).first();
  check("an anonymous call spends nobody's quota", !usedBefore, usedBefore);

  const keyed = await callA("GET", "/api/wallet-score?wallet=" + WALLET, null, withKey(RAW));
  check("a valid key is accepted", keyed.status !== 401 && keyed.status !== 429, keyed.status);
  const usedAfter = await env.HEALTH_DB.prepare(
    "SELECT used FROM tier_quotas WHERE user_id = ? AND quota_key = 'bulk_api.requests.day'"
  ).bind(userA).first();
  check("a keyed call is metered against the payer's tier budget", usedAfter?.used === 1, usedAfter);

  const attributed = await env.HEALTH_DB.prepare(
    "SELECT requests FROM api_key_usage WHERE key_id = ?"
  ).bind(created.json.id).first();
  check("usage is attributed to the specific key", attributed?.requests === 1, attributed);

  const touched = await env.HEALTH_DB.prepare("SELECT last_used_at FROM api_keys WHERE id = ?")
    .bind(created.json.id).first();
  check("last_used_at is recorded so stale keys are identifiable", touched.last_used_at > 0, touched);

  // --- quota exhaustion -----------------------------------------------------
  await env.HEALTH_DB.prepare(
    "UPDATE tier_quotas SET used = 100 WHERE user_id = ? AND quota_key = 'bulk_api.requests.day'"
  ).bind(userA).run();
  const exhausted = await callA("GET", "/api/wallet-score?wallet=" + WALLET, null, withKey(RAW));
  check("exceeding the daily budget returns 429, not a silent success",
    exhausted.status === 429 && exhausted.json.error === "api_quota_exceeded", exhausted.json);
  check("the 429 tells the integrator when to retry",
    exhausted.json.retry_at > Date.now() && exhausted.headers.get("Retry-After"), exhausted.json);
  check("the 429 reports the limit that was hit", exhausted.json.limit === 100, exhausted.json);

  // Reset for the remaining checks.
  await env.HEALTH_DB.prepare(
    "UPDATE tier_quotas SET used = 0 WHERE user_id = ? AND quota_key = 'bulk_api.requests.day'"
  ).bind(userA).run();

  // --- revocation -----------------------------------------------------------
  const revoked = await callA("DELETE", "/api/keys/" + created.json.id);
  check("owner can revoke", revoked.status === 200 && revoked.json.revoked, revoked.json);

  const afterRevoke = await callA("GET", "/api/wallet-score?wallet=" + WALLET, null, withKey(RAW));
  check("a revoked key stops working immediately",
    afterRevoke.status === 401 && afterRevoke.json.error === "api_key_revoked", afterRevoke.json);

  const listAfter = await callA("GET", "/api/keys");
  check("a revoked key stays listed as an audit trail",
    listAfter.json.keys.some((k) => k.id === created.json.id && k.revoked === true), listAfter.json.keys);

  // --- cross-account isolation ---------------------------------------------
  await setTier(userB, "plus");
  const bKey = await callB("POST", "/api/keys", { name: "b-key" });
  const listB = await callB("GET", "/api/keys");
  check("a user sees only their own keys",
    listB.json.keys.length === 1 && listB.json.keys[0].id === bKey.json.id, listB.json.keys);

  const crossRevoke = await callA("DELETE", "/api/keys/" + bKey.json.id);
  check("one account cannot revoke another's key",
    crossRevoke.status === 404, crossRevoke.json);
  const bStillWorks = await callB("GET", "/api/wallet-score?wallet=" + WALLET, null, withKey(bKey.json.api_key));
  check("...and the victim's key still works", bStillWorks.status !== 401, bStillWorks.status);

  const bUsed = await env.HEALTH_DB.prepare(
    "SELECT used FROM tier_quotas WHERE user_id = ? AND quota_key = 'bulk_api.requests.day'"
  ).bind(userA).first();
  check("B's traffic never lands on A's budget", (bUsed?.used || 0) === 0, bUsed);

  // --- blast radius ---------------------------------------------------------
  for (let i = 0; i < 9; i++) await callB("POST", "/api/keys", { name: "k" + i });
  const overflow = await callB("POST", "/api/keys", { name: "one-too-many" });
  check("an account cannot mint unbounded keys",
    overflow.status === 409 && overflow.json.error === "too_many_keys", overflow.json);

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
