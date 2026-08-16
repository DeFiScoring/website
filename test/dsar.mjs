// DSAR erasure: prove wallet ownership via SIWE, then erase everything.
import { D1, KV } from "./d1.mjs";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { eip191Digest } from "../worker/lib/auth.js";
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
function sign(msg, n) {
  const s = secp256k1.sign(eip191Digest(msg), keyFor(n));
  return "0x" + Buffer.from(s.toCompactRawBytes()).toString("hex") + (27 + s.recovery).toString(16).padStart(2, "0");
}
const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");
function siwe(address, nonce) {
  return [
    "defiscoring.com wants you to sign in with your Ethereum account:", address, "",
    "Sign in.", "", "URI: https://defiscoring.com/", "Version: 1", "Chain ID: 1",
    "Nonce: " + nonce, "Issued At: " + iso(Date.now()),
  ].join("\n");
}

const env = {
  HEALTH_DB: new D1("./migrations"),
  DEFI_CACHE: new KV(),
  SESSION_HMAC_KEY: "k",
  ALLOWED_ORIGINS: ORIGIN,
};
let COOKIE = null;
async function call(method, path, body) {
  const h = { origin: ORIGIN };
  if (body) h["content-type"] = "application/json";
  if (COOKIE) h.cookie = COOKIE;
  const res = await worker.fetch(
    new Request(ORIGIN + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }),
    env, { waitUntil() {} });
  const sc = res.headers.get("set-cookie");
  if (sc) COOKIE = sc.split(";")[0];
  const t = await res.text();
  let j; try { j = JSON.parse(t); } catch { j = { __raw: t.slice(0, 120) }; }
  return { status: res.status, json: j, setCookie: sc };
}

(async () => {
  const A = addrFor(51);
  const n = await call("GET", "/api/auth/nonce?address=" + A);
  const m = siwe(n.json.address_checksum, n.json.nonce);
  await call("POST", "/api/auth/verify", { message: m, signature: sign(m, 51) });
  const uid = (await env.HEALTH_DB.prepare("SELECT id FROM users WHERE primary_wallet=?").bind(A).first()).id;

  await env.HEALTH_DB.prepare(
    "INSERT INTO alert_rules (id,user_id,wallet_address,kind,params_json,channels_json,is_active,cooldown_secs,created_at,updated_at)" +
    " VALUES ('r9',?,?,'price','{}','[\"email\"]',1,60,1,1)").bind(uid, A).run();
  await env.HEALTH_DB.prepare(
    "INSERT INTO health_scores (wallet,score,computed_at) VALUES (?,700,1)").bind(A).run();

  // Not signed in → 401, not 503.
  const saved = COOKIE; COOKIE = null;
  const anon = await call("POST", "/api/account/delete");
  check("anonymous DSAR delete is 401 (was an unconditional 503)", anon.status === 401, anon);
  COOKIE = saved;

  const del = await call("POST", "/api/account/delete");
  check("signed-in DSAR delete succeeds", del.status === 200 && del.json.success, del.json);
  check("DSAR delete reports what it erased",
    del.json.deleted?.users === 1 && del.json.deleted?.alert_rules === 1 &&
    del.json.deleted?.health_scores === 1, del.json.deleted);
  check("DSAR delete clears the session cookie", /Max-Age=0/.test(del.setCookie || ""), del.setCookie);

  for (const [t, sql] of [
    ["users", "SELECT COUNT(*) c FROM users"],
    ["sessions", "SELECT COUNT(*) c FROM sessions"],
    ["wallet_connections", "SELECT COUNT(*) c FROM wallet_connections"],
    ["alert_rules", "SELECT COUNT(*) c FROM alert_rules"],
    ["subscriptions", "SELECT COUNT(*) c FROM subscriptions"],
    ["health_scores", "SELECT COUNT(*) c FROM health_scores"],
  ]) {
    const r = await env.HEALTH_DB.prepare(sql).first();
    check(`${t} fully erased`, r.c === 0, r);
  }

  const after = await call("GET", "/api/auth/me");
  check("session no longer resolves after erasure", after.status === 401, after.json);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
})().catch((e) => { console.error("HARNESS ERROR", e); process.exitCode = 2; });
