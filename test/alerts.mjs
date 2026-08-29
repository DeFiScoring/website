// Alerts honesty: webhook delivery (signed, SSRF-guarded, audited) and refusal
// of rule kinds whose evaluators have no real inputs yet.
//
// Same D1-shim pattern as the other suites: the real worker, the real
// migrations, the real cron scanner — only outbound HTTP is stubbed, so the
// webhook assertions are made against the bytes we would actually have sent.
import { createHmac } from "node:crypto";
import { D1, KV } from "./d1.mjs";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { eip191Digest } from "../worker/lib/auth.js";
import { validateWebhookUrl, signPayload } from "../worker/lib/webhook.js";
import { scanAlertRules } from "../worker/handlers/cron.js";
import worker from "../worker/index.js";

const ORIGIN = "https://defiscoring.com";
const HOOK = "https://hooks.example.com/defiscoring";

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log((cond ? "PASS  " : "FAIL  ") + name + (cond ? "" : "  →  " + JSON.stringify(detail)));
}

/* ---------- SIWE helpers (mirrors test/flow2.mjs) ---------- */

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

function makeEnv() {
  return {
    HEALTH_DB: new D1("./migrations"),
    DEFI_CACHE: new KV(),
    SESSION_HMAC_KEY: "test-hmac-key",
    ALLOWED_ORIGINS: ORIGIN,
  };
}

function makeCall(env) {
  let cookie = null;
  return async function call(method, path, body) {
    const h = { origin: ORIGIN };
    if (body) h["content-type"] = "application/json";
    if (cookie) h.cookie = cookie;
    const res = await worker.fetch(
      new Request(ORIGIN + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }),
      env, { waitUntil() {} },
    );
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { __raw: text.slice(0, 160) }; }
    return { status: res.status, json };
  };
}

async function signIn(env, call, n) {
  const addr = addrFor(n);
  const nonce = await call("GET", "/api/auth/nonce?address=" + addr);
  const msg = siwe({ address: nonce.json.address_checksum, nonce: nonce.json.nonce });
  await call("POST", "/api/auth/verify", { message: msg, signature: personalSign(msg, n) });
  return addr;
}

const setTier = (env, addr, tier) => env.HEALTH_DB.prepare(
  "UPDATE subscriptions SET tier=? WHERE user_id=(SELECT id FROM users WHERE primary_wallet=?)"
).bind(tier, addr).run();

(async () => {
  // =========================================================================
  // 1. SSRF guard — pure-function coverage of the URL allowlist
  // =========================================================================
  const rejected = {
    "http scheme":        "http://hooks.example.com/x",
    "loopback literal":   "https://127.0.0.1/x",
    "RFC1918 literal":    "https://192.168.1.10/x",
    "link-local metadata": "https://169.254.169.254/latest/meta-data/",
    "IPv6 loopback":      "https://[::1]/x",
    "integer-form IP":    "https://2130706433/x",
    "embedded creds":     "https://user:pass@hooks.example.com/x",
    "non-443 port":       "https://hooks.example.com:8080/x",
    "single-label host":  "https://localhost/x",
    "reserved suffix":    "https://printer.local/x",
    "cloud .internal":    "https://metadata.google.internal/x",
    "not a url":          "notaurl",
  };
  for (const [label, url] of Object.entries(rejected)) {
    const r = validateWebhookUrl(url);
    check(`webhook URL rejected: ${label}`, r.ok === false, { url, r });
  }
  check("webhook URL accepted: plain https", validateWebhookUrl(HOOK).ok === true, validateWebhookUrl(HOOK));
  check("webhook URL accepted: explicit :443",
    validateWebhookUrl("https://hooks.example.com:443/x").ok === true, null);
  check("private-IP rejection is distinguishable from generic IP rejection",
    validateWebhookUrl("https://10.0.0.1/x").error === "private_ip_not_allowed",
    validateWebhookUrl("https://10.0.0.1/x"));

  // =========================================================================
  // 2. price and approval_change now have live evaluator inputs, so creation
  //    accepts them — but a price rule whose params the evaluator can't read
  //    would be the same silent limbo the old refusal prevented, so those
  //    are validated instead.
  // =========================================================================
  const env = makeEnv();
  const call = makeCall(env);
  const wallet = await signIn(env, call, 21);
  await setTier(env, wallet, "pro");
  const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

  const badPrice = await call("POST", "/api/alerts/rules", {
    wallet_address: wallet, kind: "price", params: {}, channels: ["email"],
  });
  check("price rule without params refused as invalid_price_params",
    badPrice.status === 400 && badPrice.json.error === "invalid_price_params", badPrice.json);
  check("price refusal names the params the evaluator reads",
    /params\.token/.test(badPrice.json.message || ""), badPrice.json.message);

  const badChain = await call("POST", "/api/alerts/rules", {
    wallet_address: wallet, kind: "price",
    params: { token: USDC, threshold: 1.1, chain: "notachain" }, channels: ["email"],
  });
  check("price rule on an unsupported chain refused",
    badChain.status === 400 && badChain.json.error === "invalid_price_params", badChain.json);

  // Created inactive so the delivery sections below stay single-rule.
  const goodPrice = await call("POST", "/api/alerts/rules", {
    wallet_address: wallet, kind: "price",
    params: { token: USDC, threshold: 1.1 }, channels: ["email"], is_active: false,
  });
  check("price rule with valid params is accepted", goodPrice.json.success === true, goodPrice.json);

  const goodAppr = await call("POST", "/api/alerts/rules", {
    wallet_address: wallet, kind: "approval_change", params: {}, channels: ["email"], is_active: false,
  });
  check("approval_change rule is accepted", goodAppr.json.success === true, goodAppr.json);

  const bogus = await call("POST", "/api/alerts/rules", {
    wallet_address: wallet, kind: "nonsense", params: {}, channels: ["email"],
  });
  check("an unknown kind is still invalid_kind",
    bogus.status === 400 && bogus.json.error === "invalid_kind", bogus.json);

  const ok = await call("POST", "/api/alerts/rules", {
    wallet_address: wallet, kind: "health_factor",
    params: { threshold: 1.5, direction: "below" }, channels: ["email"],
  });
  check("a supported kind still creates normally", ok.json.success === true, ok.json);

  // =========================================================================
  // 3. Webhook channels: tier-gated, URL-validated, secret shown once
  // =========================================================================
  const proAttempt = await call("POST", "/api/alerts/channels", { kind: "webhook", destination: HOOK });
  check("webhook channel needs Plus (Pro gets 402)",
    proAttempt.status === 402 && proAttempt.json.required_tier === "plus", proAttempt.json);

  await setTier(env, wallet, "plus");

  const badUrl = await call("POST", "/api/alerts/channels", {
    kind: "webhook", destination: "http://169.254.169.254/",
  });
  check("webhook channel rejects an SSRF-shaped URL at creation",
    badUrl.status === 400 && badUrl.json.error === "invalid_webhook_url", badUrl.json);

  const created = await call("POST", "/api/alerts/channels", { kind: "webhook", destination: HOOK, label: "ops" });
  check("Plus can create a webhook channel", created.json.success === true, created.json);
  const secret = created.json.secret;
  check("creation returns a signing secret", typeof secret === "string" && secret.startsWith("whsec_"), created.json);
  check("creation says the secret is shown once", /only once/i.test(created.json.secret_notice || ""),
    created.json.secret_notice);

  const list = await call("GET", "/api/alerts/channels");
  const listed = (list.json.channels || []).find((c) => c.id === created.json.id);
  check("channel list never echoes the secret back",
    !!listed && !("secret" in listed) && !JSON.stringify(list.json).includes(secret), listed);

  const ver = await call("POST", `/api/alerts/channels/${created.json.id}/verify`,
    { token: created.json.verification_token });
  check("webhook channel verifies", ver.json.success === true, ver.json);

  // =========================================================================
  // 4. End-to-end: the cron scanner actually POSTs, signs, and audits
  // =========================================================================
  const rule = await call("POST", "/api/alerts/rules", {
    wallet_address: wallet, kind: "health_factor",
    params: { threshold: 1.5, direction: "below" },
    channels: ["webhook"], cooldown_secs: 60,
  });
  check("webhook-delivered rule creates", rule.json.success === true, rule.json);

  // Give the scanner something to fire on: a persisted score whose snapshot
  // carries a health factor under the rule's threshold.
  await env.HEALTH_DB.prepare(
    "INSERT INTO health_scores (wallet, score, source_json, computed_at) VALUES (?, ?, ?, ?)"
  ).bind(wallet.toLowerCase(), 690, JSON.stringify({ health_factor: 1.05 }), Date.now()).run();

  const posts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    posts.push({
      url: String(input?.url || input),
      method: init?.method,
      redirect: init?.redirect,
      headers: init?.headers || {},
      body: init?.body,
    });
    return new Response("ok", { status: 200 });
  };

  const scan = await scanAlertRules(env, { waitUntil() {} });
  globalThis.fetch = realFetch;

  check("scan fired the rule", scan.ok && scan.fired >= 1, scan);
  check("exactly one webhook POST went out", posts.length === 1, posts.map((p) => p.url));

  const post = posts[0] || {};
  check("POSTed to the stored destination", post.url === HOOK + "" || post.url === HOOK, post.url);
  check("used POST", post.method === "POST", post.method);
  check("redirects are not followed", post.redirect === "manual", post.redirect);

  const sigHeader = post.headers?.["x-defiscoring-signature"] || "";
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sigHeader);
  check("signature header is well-formed", !!m, sigHeader);
  if (m) {
    const expected = createHmac("sha256", secret).update(`${m[1]}.${post.body}`).digest("hex");
    check("HMAC verifies against the secret shown at creation", expected === m[2],
      { expected: expected.slice(0, 16), got: m[2].slice(0, 16) });
    const wrong = createHmac("sha256", secret + "x").update(`${m[1]}.${post.body}`).digest("hex");
    check("HMAC does not verify under a different secret", wrong !== m[2], null);
    // The library helper and the delivery path must agree byte-for-byte, or
    // documented verification examples would be wrong.
    check("signPayload() reproduces the delivered signature",
      (await signPayload(secret, post.body, Number(m[1]))) === sigHeader, sigHeader);
  }

  let payload = {};
  try { payload = JSON.parse(post.body); } catch { /* asserted below */ }
  check("payload names the event and the rule",
    payload.event === "alert.fired" && payload.rule?.kind === "health_factor" &&
    payload.rule?.wallet_address === wallet.toLowerCase(), payload);
  check("payload carries the triggering snapshot", payload.snapshot?.hf === 1.05, payload.snapshot);
  check("delivery id header matches a real row", !!post.headers?.["x-defiscoring-delivery"],
    post.headers?.["x-defiscoring-delivery"]);

  // ---- audit trail. This also pins the regression where startDelivery wrote
  // status='pending', which the alert_deliveries CHECK constraint rejects —
  // the INSERT threw, was swallowed, and no row was ever recorded for a
  // successful send.
  // Look the row up by the id we put in the header — the same scan also
  // writes a suppressed row for the email rule from section 2, so "newest
  // row" would be ambiguous.
  const del = await env.HEALTH_DB.prepare(
    "SELECT id, channel_id, status, error_message, delivered_at FROM alert_deliveries WHERE id = ?"
  ).bind(post.headers?.["x-defiscoring-delivery"] || "").first();
  check("the delivery named in the header exists in alert_deliveries", !!del, del);
  check("delivery recorded as sent", del?.status === "sent" && !del?.error_message, del);
  check("delivery stamped with a delivered_at", !!del?.delivered_at, del);
  check("delivery attributed to the webhook channel", del?.channel_id === created.json.id,
    { row: del?.channel_id, channel: created.json.id });

  const audit = await call("GET", "/api/alerts/deliveries");
  check("delivery surfaces in the user-facing audit log",
    audit.json.success && (audit.json.deliveries || []).some((d) => d.status === "sent"),
    audit.json.deliveries);

  // =========================================================================
  // 5. A receiver that fails is recorded as failed, not silently dropped
  // =========================================================================
  await env.HEALTH_DB.prepare("UPDATE alert_rules SET last_fired_at = NULL, last_value = NULL WHERE id = ?")
    .bind(rule.json.id).run();
  globalThis.fetch = async () => new Response("nope", { status: 500 });
  await scanAlertRules(env, { waitUntil() {} });
  globalThis.fetch = realFetch;

  const failed = await env.HEALTH_DB.prepare(
    "SELECT status, error_message FROM alert_deliveries WHERE status = 'failed' ORDER BY fired_at DESC LIMIT 1"
  ).first();
  check("a 500 from the receiver is logged as failed with the status code",
    failed?.status === "failed" && /http_500/.test(failed?.error_message || ""), failed);

  // =========================================================================
  // 6. "Fired, but you had no verified channel" is recorded, not swallowed
  // =========================================================================
  // The email rule from section 2 has no verified email channel. Its
  // suppression row used to bind channel_id='none', which the FK rejected —
  // the rule fired, nothing was delivered, and nothing said so.
  const suppressed = await env.HEALTH_DB.prepare(
    "SELECT channel_id, status, error_message FROM alert_deliveries WHERE status = 'suppressed' LIMIT 1"
  ).first();
  check("a rule with no verified channel records a suppressed delivery", !!suppressed, suppressed);
  check("suppressed row carries a NULL channel_id, not a sentinel",
    suppressed?.channel_id === null, suppressed);
  check("suppressed row says why", suppressed?.error_message === "no_verified_channel", suppressed);

  // Deleting a channel must not erase the deliveries made through it.
  const before = (await env.HEALTH_DB.prepare("SELECT COUNT(*) c FROM alert_deliveries").first()).c;
  await call("DELETE", "/api/alerts/channels/" + created.json.id);
  const after = (await env.HEALTH_DB.prepare("SELECT COUNT(*) c FROM alert_deliveries").first()).c;
  check("deleting a channel preserves its delivery history", after === before, { before, after });

  // =========================================================================
  // 7. Live health factors beat stale snapshots
  // =========================================================================
  // The old cron read HF from the last persisted scan — nothing ever wrote
  // it there, and even if it had, a decaying position between manual scans
  // was invisible. Here the snapshot says SAFE (2.5) and the chain says
  // LIQUIDATABLE-adjacent (0.95): the alert must fire.
  {
    const env7 = makeEnv();
    env7.ETHERSCAN_API_KEY = "stub";
    const call7 = makeCall(env7);
    const w = await signIn(env7, call7, 31);
    await setTier(env7, w, "pro");
    await env7.HEALTH_DB.prepare(
      "INSERT INTO health_scores (wallet, score, source_json, computed_at) VALUES (?, ?, ?, ?)"
    ).bind(w.toLowerCase(), 700, JSON.stringify({ health_factor: 2.5 }), Date.now()).run();
    const rule7 = await call7("POST", "/api/alerts/rules", {
      wallet_address: w, kind: "health_factor",
      params: { threshold: 1.5, direction: "below" }, channels: ["email"],
    });
    check("live-HF test rule created", rule7.json.success === true, rule7.json);

    const word = (v) => BigInt(v).toString(16).padStart(64, "0");
    let ethCalls = 0;
    const realFetch7 = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const u = String(input?.url || input);
      const J = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
      if (u.startsWith("https://api.etherscan.io/v2/api")) {
        const q = new URL(u).searchParams;
        if (q.get("action") === "eth_call") {
          ethCalls++;
          const data = (q.get("data") || "").toLowerCase();
          // Aave position with HF 0.95 on Ethereum only; every other read
          // (other chains, Comet) answers cleanly with zeros.
          if (data.startsWith("0xbf92857c") && q.get("chainid") === "1") {
            const words = [
              1000000n * 10n ** 8n,        // collateral
              400000n * 10n ** 8n,         // debt
              0n, 8000n, 7500n,
              950000000000000000n,          // healthFactor 0.95e18
            ];
            return J({ jsonrpc: "2.0", id: 1, result: "0x" + words.map(word).join("") });
          }
          return J({ jsonrpc: "2.0", id: 1, result: "0x" + word(0n) });
        }
        return J({ status: "0", message: "No records found", result: [] });
      }
      return J({});
    };

    const scan1 = await scanAlertRules(env7, { waitUntil() {} });
    check("fires on live HF 0.95 despite a persisted snapshot saying 2.5",
      scan1.ok && scan1.fired === 1, scan1);

    const pos = await env7.DEFI_CACHE.get("hfpos:v1:" + w.toLowerCase(), "json");
    check("discovery sweep cached where the position lives",
      Array.isArray(pos?.positions) && pos.positions.length === 1 &&
      pos.positions[0].chain === "ethereum" && pos.positions[0].protocol === "aave-v3", pos);

    const callsAfterSweep = ethCalls;
    const scan2 = await scanAlertRules(env7, { waitUntil() {} });
    check("second tick does not re-fire while still on the wrong side",
      scan2.ok && scan2.fired === 0, scan2);
    check("second tick reads only the cached position (1 eth_call, not a 15-call sweep)",
      ethCalls - callsAfterSweep === 1, { sweep: callsAfterSweep, tick2: ethCalls - callsAfterSweep });
    globalThis.fetch = realFetch7;
  }

  // =========================================================================
  // 8. Price alerts: real feed, edge-triggered
  // =========================================================================
  {
    const env8 = makeEnv();
    const call8 = makeCall(env8);
    const w = await signIn(env8, call8, 32);
    await setTier(env8, w, "pro");
    const TOKEN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    const rule8 = await call8("POST", "/api/alerts/rules", {
      wallet_address: w, kind: "price",
      params: { token: TOKEN, threshold: 1.10, direction: "below" }, channels: ["email"],
    });
    check("price rule created", rule8.json.success === true, rule8.json);

    let price = 1.05;
    const realFetch8 = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const u = String(input?.url || input);
      const J = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
      if (u.includes("llama.fi")) {
        const keys = decodeURIComponent(u.split("/current/")[1] || "").split(",");
        const coins = {};
        for (const k of keys) if (k.endsWith(TOKEN)) coins[k] = { price };
        return J({ coins });
      }
      return J({});
    };
    const resetFired = () => env8.HEALTH_DB.prepare(
      "UPDATE alert_rules SET last_fired_at = NULL WHERE id = ?").bind(rule8.json.id).run();

    const s1 = await scanAlertRules(env8, { waitUntil() {} });
    check("price below threshold fires", s1.ok && s1.fired === 1, s1);

    await resetFired();
    const s2 = await scanAlertRules(env8, { waitUntil() {} });
    check("same price does not re-fire (edge-trigger, not level-trigger)",
      s2.fired === 0, s2);

    price = 1.20;
    await resetFired();
    const s3 = await scanAlertRules(env8, { waitUntil() {} });
    check("price back above threshold does not fire", s3.fired === 0, s3);

    price = 1.05;
    await resetFired();
    const s4 = await scanAlertRules(env8, { waitUntil() {} });
    check("crossing back below fires again", s4.fired === 1, s4);
    globalThis.fetch = realFetch8;
  }

  // =========================================================================
  // 9. Approval alerts: bootstrap silently, then fire on new risky grants
  // =========================================================================
  {
    const env9 = makeEnv();
    env9.ETHERSCAN_API_KEY = "stub";
    const call9 = makeCall(env9);
    const w = await signIn(env9, call9, 33);
    await setTier(env9, w, "pro");
    const rule9 = await call9("POST", "/api/alerts/rules", {
      wallet_address: w, kind: "approval_change", params: {}, channels: ["email"],
    });
    check("approval rule created", rule9.json.success === true, rule9.json);

    const TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
    const pad = (a) => "0x" + "0".repeat(24) + a.toLowerCase().slice(2);
    const TOKEN9 = "0x" + "aa".repeat(20);
    const SPENDER = "0x" + "bb".repeat(20);
    let tip = 0x100000;
    let logs = [];
    let logsFail = false;
    const realFetch9 = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const u = String(input?.url || input);
      const J = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
      if (u.startsWith("https://api.etherscan.io/v2/api")) {
        const q = new URL(u).searchParams;
        if (q.get("action") === "eth_blockNumber") {
          return J({ jsonrpc: "2.0", id: 1, result: "0x" + tip.toString(16) });
        }
        if (q.get("module") === "logs") {
          if (logsFail) return J({ status: "0", message: "NOTOK", result: "Max rate limit reached" });
          // The position lives on Ethereum only — a chain-agnostic stub here
          // would (correctly) produce five grants, one per scanned chain.
          const chainLogs = q.get("chainid") === "1" ? logs : [];
          return J({ status: "1", message: "OK", result: chainLogs });
        }
        if (q.get("action") === "eth_call") {
          return J({ jsonrpc: "2.0", id: 1, result: "0x" + "0".repeat(64) });
        }
        return J({ status: "0", message: "No records found", result: [] });
      }
      return J({});
    };

    const t1 = await scanAlertRules(env9, { waitUntil() {} });
    check("first tick bootstraps without firing on approval history",
      t1.ok && t1.fired === 0, t1);
    const cur = await env9.DEFI_CACHE.get("apprcur:v1:ethereum:" + w.toLowerCase());
    check("bootstrap recorded the chain tip as the cursor", cur === String(tip), cur);

    tip += 16;
    logs = [
      { address: TOKEN9, topics: [TOPIC, pad(w), pad(SPENDER)], data: "0x" + "f".repeat(64), blockNumber: "0x100005" },
      // A revocation in the same range must not alert — it is good news.
      { address: TOKEN9, topics: [TOPIC, pad(w), pad(SPENDER)], data: "0x" + "0".repeat(64), blockNumber: "0x100006" },
    ];
    const t2 = await scanAlertRules(env9, { waitUntil() {} });
    check("new unlimited approval fires", t2.fired === 1, t2);
    const lv = await env9.HEALTH_DB.prepare(
      "SELECT last_value FROM alert_rules WHERE id = ?").bind(rule9.json.id).first();
    const snap = JSON.parse(lv?.last_value || "{}");
    check("snapshot carries exactly the one risky grant (revocation filtered)",
      Array.isArray(snap?.new) && snap.new.length === 1 && snap.new[0].risk === "high", snap);

    tip += 16;
    logs = [];
    await env9.HEALTH_DB.prepare(
      "UPDATE alert_rules SET last_fired_at = NULL WHERE id = ?").bind(rule9.json.id).run();
    const t3 = await scanAlertRules(env9, { waitUntil() {} });
    check("a quiet range does not re-fire", t3.fired === 0, t3);

    // A failed scan must keep its cursor so the range is retried — advancing
    // past a range we never read would silently drop the events in it.
    const curBefore = await env9.DEFI_CACHE.get("apprcur:v1:ethereum:" + w.toLowerCase());
    tip += 16;
    logs = [
      { address: TOKEN9, topics: [TOPIC, pad(w), pad("0x" + "cc".repeat(20))],
        data: "0x" + "f".repeat(64), blockNumber: "0x" + (tip - 4).toString(16) },
    ];
    logsFail = true;
    const t4 = await scanAlertRules(env9, { waitUntil() {} });
    check("a failed log scan does not fire", t4.fired === 0, t4);
    const curAfterFail = await env9.DEFI_CACHE.get("apprcur:v1:ethereum:" + w.toLowerCase());
    check("a failed log scan keeps its cursor for retry", curAfterFail === curBefore,
      { before: curBefore, after: curAfterFail });

    logsFail = false;
    const t5 = await scanAlertRules(env9, { waitUntil() {} });
    check("the retried range delivers the grant the failure straddled",
      t5.fired === 1, t5);
    globalThis.fetch = realFetch9;
  }

  // =========================================================================
  // 10. Budget exhaustion degrades to the snapshot, never to a false alert
  // =========================================================================
  {
    const env10 = makeEnv();
    env10.ETHERSCAN_API_KEY = "stub";
    env10.ALERT_LIVE_BUDGET = "0";
    const call10 = makeCall(env10);
    const w = await signIn(env10, call10, 34);
    await setTier(env10, w, "pro");
    await env10.HEALTH_DB.prepare(
      "INSERT INTO health_scores (wallet, score, source_json, computed_at) VALUES (?, ?, ?, ?)"
    ).bind(w.toLowerCase(), 700, JSON.stringify({ health_factor: 2.5 }), Date.now()).run();
    await call10("POST", "/api/alerts/rules", {
      wallet_address: w, kind: "health_factor",
      params: { threshold: 1.5, direction: "below" }, channels: ["email"],
    });
    let fetches = 0;
    const realFetch10 = globalThis.fetch;
    globalThis.fetch = async () => { fetches++; return new Response("{}", { status: 200 }); };
    const s10 = await scanAlertRules(env10, { waitUntil() {} });
    globalThis.fetch = realFetch10;
    check("budget 0: scan completes on the snapshot without firing",
      s10.ok && s10.fired === 0, s10);
    check("budget 0: no live fetches attempted", fetches === 0, fetches);
  }

  const summary = results.filter((r) => !r.ok);
  console.log(`\n${results.length - summary.length}/${results.length} passed`);
  if (summary.length) process.exitCode = 1;
})().catch((e) => { console.error("HARNESS ERROR", e); process.exitCode = 2; });
