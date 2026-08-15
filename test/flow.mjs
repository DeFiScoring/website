// End-to-end exercise of the wallet/auth backend against a real SQLite DB.
import { D1, KV } from "./d1.mjs";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { toChecksumAddress } from "../worker/lib/auth.js";
import worker from "../worker/index.js";

const env = {
  HEALTH_DB: new D1("./migrations"),
  DEFI_CACHE: new KV(),
  PROFILE_CACHE: new KV(),
  SESSION_HMAC_KEY: "test-hmac-key-0123456789",
  ALLOWED_ORIGINS: "https://defiscoring.com,http://localhost:5000",
  ADMIN_BOOTSTRAP_ADDRESS: "0x1003EAAf88a7Ab1af230029FA9531584e3f217b0",
};

const ORIGIN = "https://defiscoring.com";
function keyFor(n) { const k = new Uint8Array(32).fill(n); return k; }
function addrFor(n) {
  const pub = secp256k1.getPublicKey(keyFor(n), false);
  return "0x" + Buffer.from(keccak_256(pub.slice(1))).toString("hex").slice(-40);
}
function personalSign(msg, n) {
  const enc = new TextEncoder();
  const mb = enc.encode(msg);
  const prefix = enc.encode(`\x19Ethereum Signed Message:\n${mb.length}`);
  const all = new Uint8Array(prefix.length + mb.length);
  all.set(prefix); all.set(mb, prefix.length);
  const sig = secp256k1.sign(keccak_256(all), keyFor(n));
  return "0x" + Buffer.from(sig.toCompactRawBytes()).toString("hex") +
    (27 + sig.recovery).toString(16).padStart(2, "0");
}
function siwe({ address, nonce, statement }) {
  const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");
  return [
    "defiscoring.com wants you to sign in with your Ethereum account:",
    address, "",
    statement || "Sign in to DeFi Scoring to access your dashboard, alerts, and saved wallets.",
    "",
    "URI: https://defiscoring.com/",
    "Version: 1",
    "Chain ID: 1",
    "Nonce: " + nonce,
    "Issued At: " + iso(Date.now()),
    "Expiration Time: " + iso(Date.now() + 300000),
  ].join("\n");
}

let COOKIE = null;
async function call(method, path, body) {
  const headers = { origin: ORIGIN, "user-agent": "test-agent" };
  if (body) headers["content-type"] = "application/json";
  if (COOKIE) headers.cookie = COOKIE;
  const req = new Request(ORIGIN + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const res = await worker.fetch(req, env, { waitUntil() {} });
  const sc = res.headers.get("set-cookie");
  if (sc) COOKIE = sc.split(";")[0];
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { __raw: text.slice(0, 200) }; }
  return { status: res.status, json, headers: res.headers };
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log((cond ? "PASS  " : "FAIL  ") + name + (cond ? "" : "  →  " + JSON.stringify(detail)));
}

async function login(n) {
  const addr = addrFor(n);
  const nr = await call("GET", "/api/auth/nonce?address=" + addr);
  if (!nr.json.success) return { fail: nr };
  const msg = siwe({ address: nr.json.address_checksum || addr, nonce: nr.json.nonce });
  const sig = personalSign(msg, n);
  const vr = await call("POST", "/api/auth/verify", { message: msg, signature: sig });
  return { addr, nonceRes: nr, verifyRes: vr };
}

(async () => {
  // ---- 1. nonce
  const a1 = addrFor(1);
  const n1 = await call("GET", "/api/auth/nonce?address=" + a1);
  check("GET /api/auth/nonce returns nonce", n1.json.success && n1.json.nonce, n1);
  check("nonce returns EIP-55 checksum", n1.json.address_checksum === toChecksumAddress(a1), n1.json);

  // ---- 2. sign in
  const l1 = await login(1);
  check("POST /api/auth/verify succeeds", l1.verifyRes?.json?.success, l1.verifyRes);
  check("verify sets ds_session cookie", !!COOKIE, COOKIE);

  // ---- 3. me
  const me = await call("GET", "/api/auth/me");
  check("GET /api/auth/me authenticated", me.json.success && me.json.user?.primary_wallet === a1, me.json);

  // ---- 4. wallets list
  const wl = await call("GET", "/api/wallets");
  check("GET /api/wallets lists primary wallet",
    wl.json.success && wl.json.wallets?.length === 1 && wl.json.wallets[0].is_primary === 1, wl.json);

  // ---- 5. link second wallet (free tier cap = 1 → expect 402)
  const a2 = addrFor(2);
  const n2 = await call("GET", "/api/auth/nonce?address=" + a2);
  const m2 = siwe({ address: n2.json.address_checksum, nonce: n2.json.nonce, statement: "Link this wallet to your DeFi Scoring account." });
  const link1 = await call("POST", "/api/wallets/link", { message: m2, signature: personalSign(m2, 2), label: "Cold" });
  check("free tier link hits wallet cap (402)", link1.status === 402 && link1.json.error === "wallet_limit_reached", link1);

  // upgrade to pro then retry
  await env.HEALTH_DB.prepare("UPDATE subscriptions SET tier='pro' WHERE user_id=(SELECT id FROM users WHERE primary_wallet=?)").bind(a1).run();
  const n2b = await call("GET", "/api/auth/nonce?address=" + a2);
  const m2b = siwe({ address: n2b.json.address_checksum, nonce: n2b.json.nonce, statement: "Link this wallet to your DeFi Scoring account." });
  const link2 = await call("POST", "/api/wallets/link", { message: m2b, signature: personalSign(m2b, 2), label: "Cold" });
  check("pro tier link succeeds", link2.json.success, link2);

  const wl2 = await call("GET", "/api/wallets");
  check("linked wallet appears in list", wl2.json.wallets?.length === 2, wl2.json);

  // ---- 6. PATCH label/tags
  const pt = await call("PATCH", "/api/wallets/" + a2, { label: "Ledger", tags: ["cold", "treasury"] });
  check("PATCH /api/wallets/{addr} updates", pt.json.success, pt);
  const wl3 = await call("GET", "/api/wallets");
  const w2 = (wl3.json.wallets || []).find((w) => w.wallet_address === a2);
  check("PATCH persisted label+tags", w2?.label === "Ledger" && Array.isArray(w2?.tags) && w2.tags.length === 2, w2);

  // ---- 7. unlink
  const un = await call("DELETE", "/api/wallets/" + a2);
  check("DELETE /api/wallets/{addr} unlinks", un.json.success && un.json.removed === 1, un);
  const unp = await call("DELETE", "/api/wallets/" + a1);
  check("cannot unlink primary wallet", unp.status === 400 && unp.json.error === "cannot_unlink_primary_wallet", unp);

  // ---- 8. nonce replay
  const nr = await call("GET", "/api/auth/nonce?address=" + a1);
  const rm = siwe({ address: nr.json.address_checksum, nonce: nr.json.nonce });
  const rs = personalSign(rm, 1);
  const v1 = await call("POST", "/api/auth/verify", { message: rm, signature: rs });
  const v2 = await call("POST", "/api/auth/verify", { message: rm, signature: rs });
  check("nonce is single-use (replay rejected)", v1.json.success && !v2.json.success, { v1: v1.json, v2: v2.json });

  // ---- 9. wrong signer
  const nw = await call("GET", "/api/auth/nonce?address=" + a1);
  const mw = siwe({ address: nw.json.address_checksum, nonce: nw.json.nonce });
  const vw = await call("POST", "/api/auth/verify", { message: mw, signature: personalSign(mw, 3) });
  check("signature/address mismatch rejected", !vw.json.success && vw.status === 401, vw.json);

  // ---- 10. CORS + credentials
  const opt = await call("OPTIONS", "/api/auth/verify");
  check("OPTIONS preflight allows credentials",
    opt.headers.get("access-control-allow-credentials") === "true" &&
    opt.headers.get("access-control-allow-origin") === ORIGIN, {
      o: opt.headers.get("access-control-allow-origin"),
      c: opt.headers.get("access-control-allow-credentials"),
      m: opt.headers.get("access-control-allow-methods"),
    });

  // ---- 11. logout
  const lo = await call("POST", "/api/auth/logout");
  check("logout succeeds", lo.json.success, lo.json);
  const me2 = await call("GET", "/api/auth/me");
  check("session invalid after logout", me2.status === 401, me2.json);

  // ---- 12. admin bootstrap
  COOKIE = null;
  const adminIdx = 9;
  console.log("\n(admin bootstrap address in env is a fixed constant; skipping key-derived check)\n");

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
})().catch((e) => { console.error("HARNESS ERROR", e); process.exitCode = 2; });
