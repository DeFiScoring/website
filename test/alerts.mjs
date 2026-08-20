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
  // 2. Rule kinds with stubbed evaluator inputs are refused at creation
  // =========================================================================
  const env = makeEnv();
  const call = makeCall(env);
  const wallet = await signIn(env, call, 21);
  await setTier(env, wallet, "pro");

  for (const kind of ["price", "approval_change"]) {
    const r = await call("POST", "/api/alerts/rules", {
      wallet_address: wallet, kind, params: {}, channels: ["email"],
    });
    check(`rule kind '${kind}' refused as kind_not_yet_supported`,
      r.status === 400 && r.json.error === "kind_not_yet_supported", r);
    check(`refusal for '${kind}' explains why in prose`,
      typeof r.json.message === "string" && r.json.message.length > 40, r.json.message);
    check(`refusal for '${kind}' lists the kinds that do work`,
      Array.isArray(r.json.supported_kinds) &&
      r.json.supported_kinds.includes("health_factor") &&
      !r.json.supported_kinds.includes(kind), r.json.supported_kinds);
  }
  const bogus = await call("POST", "/api/alerts/rules", {
    wallet_address: wallet, kind: "nonsense", params: {}, channels: ["email"],
  });
  check("an unknown kind is still invalid_kind, not kind_not_yet_supported",
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

  const summary = results.filter((r) => !r.ok);
  console.log(`\n${results.length - summary.length}/${results.length} passed`);
  if (summary.length) process.exitCode = 1;
})().catch((e) => { console.error("HARNESS ERROR", e); process.exitCode = 2; });
