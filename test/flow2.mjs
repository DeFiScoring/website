// Regression coverage for the wallet-backend fixes.
import { D1, KV } from "./d1.mjs";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { toChecksumAddress, eip191Digest } from "../worker/lib/auth.js";
import worker from "../worker/index.js";

const ORIGIN = "https://defiscoring.com";
const WORKER_HOST = "https://defiscoring.guillaumelauzier.workers.dev";

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
function signRaw(msg, n, { compact = false } = {}) {
  const sig = secp256k1.sign(eip191Digest(msg), keyFor(n));
  const hex = Buffer.from(sig.toCompactRawBytes()).toString("hex");
  if (compact) {
    // EIP-2098: fold the recovery bit into the top bit of s.
    const bytes = Buffer.from(hex, "hex");
    if (sig.recovery === 1) bytes[32] |= 0x80;
    return "0x" + bytes.toString("hex");
  }
  return "0x" + hex + (27 + sig.recovery).toString(16).padStart(2, "0");
}
const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");
function siwe({ address, nonce, statement, domain, extra = [] }) {
  const head = [
    (domain || "defiscoring.com") + " wants you to sign in with your Ethereum account:",
    address, "",
  ];
  if (statement !== null) head.push(statement || "Sign in to DeFi Scoring.");
  head.push("");
  return head.concat([
    "URI: https://defiscoring.com/",
    "Version: 1", "Chain ID: 1",
    "Nonce: " + nonce,
    "Issued At: " + iso(Date.now()),
  ], extra).join("\n");
}

function makeEnv(overrides = {}) {
  return {
    HEALTH_DB: new D1("./migrations"),
    DEFI_CACHE: new KV(),
    SESSION_HMAC_KEY: "test-hmac-key",
    ALLOWED_ORIGINS: "https://defiscoring.com,http://localhost:5000",
    ...overrides,
  };
}

function makeCall(env, base = ORIGIN) {
  let cookie = null;
  return {
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
    async call(method, path, body, headers = {}) {
      const h = { ...headers };
      if (body) h["content-type"] = "application/json";
      if (cookie) h.cookie = cookie;
      if (!("origin" in h) && h.origin !== null) h.origin = ORIGIN;
      if (h.origin === null) delete h.origin;
      const res = await worker.fetch(
        new Request(base + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }),
        env, { waitUntil() {} },
      );
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch { json = { __raw: text.slice(0, 120) }; }
      return { status: res.status, json, setCookie, headers: res.headers };
    },
  };
}

(async () => {
  // =========================================================================
  // 0. www → apex redirect
  // =========================================================================
  {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://www.defiscoring.com/dashboard/", { method: "GET", headers: { origin: ORIGIN } }),
      env, { waitUntil() {} },
    );
    check("www host redirects to apex", res.status === 301 && res.headers.get("location") === "https://defiscoring.com/dashboard/", {
      status: res.status, location: res.headers.get("location"),
    });
  }

  // =========================================================================
  // 1. Cross-site cookie attributes
  // =========================================================================
  {
    const env = makeEnv();
    const c = makeCall(env, WORKER_HOST);           // API on workers.dev…
    const a = addrFor(11);
    const n = await c.call("GET", "/api/auth/nonce?address=" + a);
    const m = siwe({ address: n.json.address_checksum, nonce: n.json.nonce });
    const v = await c.call("POST", "/api/auth/verify", { message: m, signature: signRaw(m, 11) });
    check("cross-site login sets SameSite=None; Secure; Partitioned",
      /SameSite=None/i.test(v.setCookie || "") && /Partitioned/i.test(v.setCookie || "") &&
      /Secure/i.test(v.setCookie || ""), v.setCookie);
    const lo = await c.call("POST", "/api/auth/logout");
    check("logout cookie mirrors cross-site attributes",
      /SameSite=None/i.test(lo.setCookie || "") && /Partitioned/i.test(lo.setCookie || "") &&
      /Max-Age=0/i.test(lo.setCookie || ""), lo.setCookie);
  }
  {
    const env = makeEnv();
    const c = makeCall(env, ORIGIN);                 // …vs API on the site origin
    const a = addrFor(12);
    const n = await c.call("GET", "/api/auth/nonce?address=" + a);
    const m = siwe({ address: n.json.address_checksum, nonce: n.json.nonce });
    const v = await c.call("POST", "/api/auth/verify", { message: m, signature: signRaw(m, 12) });
    check("same-origin login keeps SameSite=Lax",
      /SameSite=Lax/i.test(v.setCookie || "") && !/Partitioned/i.test(v.setCookie || ""), v.setCookie);
  }

  // =========================================================================
  // 2. CSRF origin guard
  // =========================================================================
  {
    const env = makeEnv();
    const c = makeCall(env);
    const a = addrFor(13);
    const n = await c.call("GET", "/api/auth/nonce?address=" + a);
    const m = siwe({ address: n.json.address_checksum, nonce: n.json.nonce });
    await c.call("POST", "/api/auth/verify", { message: m, signature: signRaw(m, 13) });

    const evil = await c.call("DELETE", "/api/wallets/" + addrFor(14), null, { origin: "https://evil.example" });
    check("mutating request from unknown origin is refused",
      evil.status === 403 && evil.json.error === "forbidden", evil);

    const same = await c.call("GET", "/api/wallets");
    check("allowlisted origin still works after guard", same.json.success, same.json);

    const noOrigin = await c.call("POST", "/api/auth/logout", null, { origin: null });
    check("origin-less (curl / server-to-server) request is allowed", noOrigin.status === 200, noOrigin);

    const secFetch = await c.call("POST", "/api/auth/logout", null,
      { origin: null, "sec-fetch-site": "cross-site" });
    check("Sec-Fetch-Site: cross-site without Origin is refused", secFetch.status === 403, secFetch);
  }

  // =========================================================================
  // 3. Signature encodings
  // =========================================================================
  {
    const env = makeEnv();
    const c = makeCall(env);
    const a = addrFor(15);
    const n = await c.call("GET", "/api/auth/nonce?address=" + a);
    const m = siwe({ address: n.json.address_checksum, nonce: n.json.nonce });
    const v = await c.call("POST", "/api/auth/verify",
      { message: m, signature: signRaw(m, 15, { compact: true }) });
    check("EIP-2098 64-byte compact signature accepted", v.json.success, v.json);
  }

  // =========================================================================
  // 4. SIWE parsing edge cases the old parser got wrong
  // =========================================================================
  {
    const env = makeEnv();
    const c = makeCall(env);
    const a = addrFor(16);

    // statement omitted entirely (wagmi/rainbowkit default)
    let n = await c.call("GET", "/api/auth/nonce?address=" + a);
    let m = siwe({ address: n.json.address_checksum, nonce: n.json.nonce, statement: null });
    let v = await c.call("POST", "/api/auth/verify", { message: m, signature: signRaw(m, 16) });
    check("SIWE message with no statement accepted", v.json.success, v.json);

    // Resources block
    n = await c.call("GET", "/api/auth/nonce?address=" + a);
    m = siwe({ address: n.json.address_checksum, nonce: n.json.nonce,
               extra: ["Resources:", "- https://defiscoring.com/terms"] });
    v = await c.call("POST", "/api/auth/verify", { message: m, signature: signRaw(m, 16) });
    check("SIWE message with Resources block accepted", v.json.success, v.json);

    // full-origin domain (some wallet SDKs)
    n = await c.call("GET", "/api/auth/nonce?address=" + a);
    m = siwe({ address: n.json.address_checksum, nonce: n.json.nonce, domain: "https://defiscoring.com" });
    v = await c.call("POST", "/api/auth/verify", { message: m, signature: signRaw(m, 16) });
    check("scheme-prefixed domain matches the allowlist", v.json.success, v.json);

    // statement that tries to inject fields
    n = await c.call("GET", "/api/auth/nonce?address=" + a);
    const realNonce = n.json.nonce;
    m = siwe({ address: n.json.address_checksum, nonce: realNonce,
               statement: "Not Before: 2999-01-01T00:00:00Z" });
    v = await c.call("POST", "/api/auth/verify", { message: m, signature: signRaw(m, 16) });
    check("field-shaped statement cannot inject SIWE fields", v.json.success, v.json);

    // domain not on the allowlist
    n = await c.call("GET", "/api/auth/nonce?address=" + a);
    m = siwe({ address: n.json.address_checksum, nonce: n.json.nonce, domain: "phish.example" });
    v = await c.call("POST", "/api/auth/verify", { message: m, signature: signRaw(m, 16) });
    check("off-allowlist domain rejected", !v.json.success && v.json.error === "domain_mismatch", v.json);
  }

  // =========================================================================
  // 5. EIP-1271 smart-contract wallet (Safe-style)
  // =========================================================================
  {
    const SAFE = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
    const ownerKey = 21;
    let rpcCalls = 0;
    // Stand in for the chain: a contract that returns the ERC-1271 magic value
    // when the inner signature recovers to its owner.
    const env = makeEnv({
      ETH_RPC_URL: "https://rpc.test.invalid",
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const u = String(input?.url || input);
      if (u.startsWith("https://rpc.test.invalid")) {
        rpcCalls++;
        const body = JSON.parse(init.body);
        const data = body.params[0].data;
        const to = body.params[0].to;
        if (to.toLowerCase() === SAFE && data.startsWith("0x1626ba7e")) {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id,
            result: "0x1626ba7e" + "0".repeat(56) }), { headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { message: "revert" } }),
          { headers: { "content-type": "application/json" } });
      }
      return realFetch(input, init);
    };

    const c = makeCall(env);
    const n = await c.call("GET", "/api/auth/nonce?address=" + SAFE);
    const m = siwe({ address: n.json.address_checksum, nonce: n.json.nonce });
    const v = await c.call("POST", "/api/auth/verify",
      { message: m, signature: signRaw(m, ownerKey) }); // signed by owner, not the Safe
    check("EIP-1271 contract wallet can sign in",
      v.json.success && v.json.auth_method === "eip1271" &&
      v.json.user?.primary_wallet === SAFE, { v: v.json, rpcCalls });

    // A contract that rejects must not get in.
    const BAD = "0x1111111111111111111111111111111111111111";
    const n2 = await c.call("GET", "/api/auth/nonce?address=" + BAD);
    const m2 = siwe({ address: n2.json.address_checksum, nonce: n2.json.nonce });
    const v2 = await c.call("POST", "/api/auth/verify",
      { message: m2, signature: signRaw(m2, ownerKey) });
    check("EIP-1271 rejection still denies sign-in",
      !v2.json.success && v2.json.error === "signature_address_mismatch", v2.json);

    globalThis.fetch = realFetch;
  }

  // =========================================================================
  // 6. Unlink deactivates that wallet's alert rules
  // =========================================================================
  {
    const env = makeEnv();
    const c = makeCall(env);
    const a = addrFor(31);
    const n = await c.call("GET", "/api/auth/nonce?address=" + a);
    const m = siwe({ address: n.json.address_checksum, nonce: n.json.nonce });
    await c.call("POST", "/api/auth/verify", { message: m, signature: signRaw(m, 31) });
    const uid = (await env.HEALTH_DB.prepare("SELECT id FROM users WHERE primary_wallet=?").bind(a).first()).id;
    await env.HEALTH_DB.prepare("UPDATE subscriptions SET tier='pro' WHERE user_id=?").bind(uid).run();

    const b = addrFor(32);
    const n2 = await c.call("GET", "/api/auth/nonce?address=" + b);
    const m2 = siwe({ address: n2.json.address_checksum, nonce: n2.json.nonce });
    const link = await c.call("POST", "/api/wallets/link", { message: m2, signature: signRaw(m2, 32) });
    check("second wallet links on pro tier", link.json.success, link.json);

    const dup = await c.call("GET", "/api/auth/nonce?address=" + b);
    const mdup = siwe({ address: dup.json.address_checksum, nonce: dup.json.nonce });
    const relink = await c.call("POST", "/api/wallets/link", { message: mdup, signature: signRaw(mdup, 32) });
    check("re-linking the same wallet is idempotent",
      relink.json.success && relink.json.already_linked === true, relink.json);

    await env.HEALTH_DB.prepare(
      "INSERT INTO alert_rules (id,user_id,wallet_address,kind,params_json,channels_json,is_active,cooldown_secs,created_at,updated_at)" +
      " VALUES ('r1',?,?,'health_factor','{}','[\"email\"]',1,3600,1,1)"
    ).bind(uid, b).run();

    const un = await c.call("DELETE", "/api/wallets/" + b);
    check("unlink deactivates the wallet's alert rules",
      un.json.success && un.json.deactivated_alert_rules === 1, un.json);
    const rule = await env.HEALTH_DB.prepare("SELECT is_active FROM alert_rules WHERE id='r1'").first();
    check("alert rule row is now inactive", rule.is_active === 0, rule);
  }

  // =========================================================================
  // 7. Retention prune reaps expired sessions + nonces
  // =========================================================================
  {
    const env = makeEnv();
    const c = makeCall(env);
    const a = addrFor(41);
    const n = await c.call("GET", "/api/auth/nonce?address=" + a);   // left unconsumed
    const m = siwe({ address: n.json.address_checksum, nonce: n.json.nonce });
    await c.call("POST", "/api/auth/verify", { message: m, signature: signRaw(m, 41) });
    await env.HEALTH_DB.prepare("INSERT INTO siwe_nonces (nonce,issued_at,expires_at) VALUES ('stale',1,2)").run();
    await env.HEALTH_DB.prepare("UPDATE sessions SET expires_at = 5").run();

    await worker.scheduled({ cron: "17 3 * * *" }, env, { waitUntil: (p) => p });
    await new Promise((r) => setTimeout(r, 50));
    const nonces = await env.HEALTH_DB.prepare("SELECT COUNT(*) c FROM siwe_nonces").first();
    const sessions = await env.HEALTH_DB.prepare("SELECT COUNT(*) c FROM sessions").first();
    check("retention prune clears expired nonces", nonces.c === 0, nonces);
    check("retention prune clears expired sessions", sessions.c === 0, sessions);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
})().catch((e) => { console.error("HARNESS ERROR", e); process.exitCode = 2; });
