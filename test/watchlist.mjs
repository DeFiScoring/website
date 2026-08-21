// Watched wallets: user-scoped CRUD, tier caps, cross-user isolation, and
// the tie into the scheduled re-score queue. Distinct from the legacy
// per-wallet protocol watchlist (worker/index.js /api/watchlist/{wallet}),
// which must keep working untouched alongside it.
import { D1, KV } from "./d1.mjs";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { eip191Digest } from "../worker/lib/auth.js";
import { runScheduledRescore } from "../worker/handlers/rescore.js";
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

function makeCall(env, jar) {
  return async function call(method, path, body) {
    const h = { origin: ORIGIN };
    if (body) h["content-type"] = "application/json";
    if (jar.cookie) h.cookie = jar.cookie;
    const res = await worker.fetch(
      new Request(ORIGIN + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }),
      env, { waitUntil() {} });
    const sc = res.headers.get("set-cookie");
    if (sc) jar.cookie = sc.split(";")[0];
    return { status: res.status, json: await res.json() };
  };
}

(async () => {
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
    return a;
  };

  // ---- auth gate
  const anon = await callA("GET", "/api/watched-wallets");
  check("list requires a session", anon.status === 401, anon.status);

  await signIn(callA, 61);
  await signIn(callB, 62);

  const TARGET = "0x00000000000000000000000000000000000000c5";

  // ---- add + validation + duplicate handling
  const bad = await callA("POST", "/api/watched-wallets", { wallet: "nope" });
  check("invalid address rejected", bad.status === 400 && bad.json.error === "invalid_wallet_address", bad.json);

  const add = await callA("POST", "/api/watched-wallets", { wallet: TARGET, label: "Treasury" });
  check("watching an arbitrary (unlinked) wallet works — that's the point",
    add.json.success === true && add.json.id, add.json);

  const dupe = await callA("POST", "/api/watched-wallets", { wallet: TARGET });
  check("watching the same wallet twice is a named conflict, not a 500",
    dupe.status === 409 && dupe.json.error === "already_watching", dupe.json);

  // ---- list enrichment: latest persisted score + band + coverage
  await env.HEALTH_DB.prepare(
    "INSERT INTO health_scores (wallet, score, source_json, computed_at) VALUES (?, ?, ?, ?)"
  ).bind(TARGET, 500, JSON.stringify({ score_band: "poor", coverage: 0.9 }), Date.now() - 5000).run();
  await env.HEALTH_DB.prepare(
    "INSERT INTO health_scores (wallet, score, source_json, computed_at) VALUES (?, ?, ?, ?)"
  ).bind(TARGET, 662, JSON.stringify({ score_band: "good", coverage: 0.65 }), Date.now()).run();

  const list = await callA("GET", "/api/watched-wallets");
  const entry = (list.json.entries || [])[0];
  check("list carries the LATEST score, band and coverage",
    entry && entry.score === 662 && entry.score_band === "good" && entry.coverage === 0.65, entry);
  check("label round-trips", entry?.label === "Treasury", entry?.label);

  // ---- cross-user isolation
  const listB = await callB("GET", "/api/watched-wallets");
  check("users see only their own entries", (listB.json.entries || []).length === 0, listB.json);
  const stealDel = await callB("DELETE", "/api/watched-wallets/" + add.json.id);
  check("another user's entry id deletes as not_found",
    stealDel.status === 404, stealDel.json);
  const stealPut = await callB("PUT", "/api/watched-wallets/" + add.json.id, { label: "mine now" });
  check("another user's entry id renames as not_found", stealPut.status === 404, stealPut.json);

  // ---- rename
  const ren = await callA("PUT", "/api/watched-wallets/" + add.json.id, { label: "Ops" });
  check("owner can rename", ren.json.success === true, ren.json);

  // ---- tier cap (free tier: watchlist.size = 5; one slot already used)
  for (let i = 0; i < 4; i++) {
    const r = await callA("POST", "/api/watched-wallets",
      { wallet: "0x00000000000000000000000000000000000000" + (60 + i) });
    check(`fill slot ${i + 2}/5`, r.json.success === true, r.json);
  }
  const over = await callA("POST", "/api/watched-wallets",
    { wallet: "0x00000000000000000000000000000000000000ff" });
  check("6th wallet on free tier hits the cap with an upgrade path",
    over.status === 402 && over.json.error === "watchlist_limit_reached" &&
    over.json.limit === 5 && over.json.upgrade_url === "/pricing/", over.json);

  // ---- quota endpoint reflects live cardinality
  const quota = await callA("GET", "/api/quota");
  const wl = quota.json?.limits?.["watchlist.size"] ?? quota.json?.quota?.["watchlist.size"];
  check("quota reports watchlist cardinality (no longer 'not shipped')",
    JSON.stringify(quota.json).includes('"watchlist.size"') &&
    JSON.stringify(quota.json).includes("5"), wl ?? quota.json);

  // ---- watched wallets join the re-score queue
  // TARGET has no alert rules — before this feature the rescorer could not
  // see it. Backdate its score so it is the stalest watched wallet.
  await env.HEALTH_DB.prepare(
    "UPDATE health_scores SET computed_at = ? WHERE wallet = ?"
  ).bind(Date.now() - 72 * 3600 * 1000, TARGET).run();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const u = String(input?.url || input);
    const J = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
    if (u.startsWith("https://api.etherscan.io/v2/api")) {
      const q = new URL(u).searchParams;
      const action = q.get("action");
      if (action === "balance") return J({ status: "1", message: "OK", result: "1000000000000000000" });
      if (action === "tokentx") return J({ status: "0", message: "No token transfers found", result: [] });
      if (action === "txlist") return J({ status: "1", message: "OK", result: [{ timeStamp: String(Math.floor(Date.now() / 1000) - 86400 * 400) }] });
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
  // The cap-filler wallets are watched too and never scored, so they rank
  // ahead of TARGET (NULL sorts first) — the first run must pick one of
  // them, which itself proves watchlist membership feeds the queue.
  const first = await runScheduledRescore(env, { waitUntil() {} });
  check("a never-scored watched wallet is picked before a stale one",
    first.ok && /^0x0{38}6[0-3]$/.test(first.wallet) && first.scored === true, first);
  // Give every filler a fresh score so TARGET becomes the stalest.
  for (let i = 0; i < 4; i++) {
    const w = "0x00000000000000000000000000000000000000" + (60 + i);
    await env.HEALTH_DB.prepare(
      "INSERT INTO health_scores (wallet, score, source_json, computed_at) VALUES (?, ?, ?, ?)"
    ).bind(w, 600, "{}", Date.now()).run();
  }
  const rescored = await runScheduledRescore(env, { waitUntil() {} });
  globalThis.fetch = realFetch;
  check("then the stalest watched wallet (no alert rules) is rescored",
    rescored.ok && rescored.wallet === TARGET && rescored.scored === true, rescored);

  // ---- the legacy protocol watchlist keeps working beside the new routes
  const legacy = await callA("GET", "/api/watchlist/" + TARGET);
  check("legacy /api/watchlist/{wallet} still answers",
    legacy.status === 200 && legacy.json.success !== false, legacy.json);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
})().catch((e) => { console.error("HARNESS ERROR", e); process.exitCode = 2; });
