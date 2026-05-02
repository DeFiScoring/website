/* DeFiScoring – Authentication library
 *
 * Implements:
 *   • SIWE (EIP-4361) signature verification using @noble/curves (secp256k1)
 *   • Session cookies signed with HMAC-SHA256 (key: env.SESSION_HMAC_KEY)
 *   • requireSession() middleware that returns either {user, session} or a 401 Response
 *
 * No network I/O happens in this file beyond what the caller passes in
 * (we read/write the D1 `users`, `sessions`, `siwe_nonces`, and
 * `wallet_connections` tables via the env.HEALTH_DB binding).
 *
 * Dependency rationale: secp256k1 is not a curve supported by Workers'
 * built-in WebCrypto, so we pull in @noble/curves (small, audited, ESM).
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";
import { hmac } from "@noble/hashes/hmac";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const NONCE_TTL_MS   = 5 * 60 * 1000;            // 5 minutes
const COOKIE_NAME    = "ds_session";

/* ---------- low-level hex helpers ---------- */

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2) throw new Error("hex: odd length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}
function utf8(s) { return new TextEncoder().encode(s); }

/* ---------- ID generation (ULID-ish, time-ordered, URL-safe) ---------- */

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32, no I/L/O/U

export function newId() {
  // 48-bit timestamp + 80-bit randomness, encoded base32 = 26 chars
  const time = Date.now();
  const timeBytes = new Uint8Array(6);
  // Write the 48-bit ms timestamp big-endian. We use BigInt because JS
  // bitwise ops are 32-bit and `time >>> 0` would silently truncate for
  // any ms timestamp past Jan 19 2038 (the 32-bit signed-int rollover).
  let t = BigInt(time);
  for (let i = 5; i >= 0; i--) {
    timeBytes[i] = Number(t & 0xffn);
    t >>= 8n;
  }
  const rand = crypto.getRandomValues(new Uint8Array(10));

  const all = new Uint8Array(16);
  all.set(timeBytes, 0);
  all.set(rand, 6);

  // Encode 16 bytes (128 bits) as 26 base32 chars
  let bits = 0n;
  for (const b of all) bits = (bits << 8n) | BigInt(b);
  let out = "";
  for (let i = 25; i >= 0; i--) {
    out = ULID_ALPHABET[Number(bits & 0x1fn)] + out;
    bits >>= 5n;
  }
  return out;
}

/* ---------- SIWE message parsing (EIP-4361) ---------- */

/**
 * Parse a SIWE message into structured fields. Returns null if the message
 * doesn't conform; we treat that as a verification failure rather than
 * throwing so callers can return a clean 400.
 *
 * Spec: https://eips.ethereum.org/EIPS/eip-4361
 */
export function parseSiweMessage(raw) {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  const lines = raw.split("\n");
  // line 0: "<domain> wants you to sign in with your Ethereum account:"
  // line 1: "0x...."
  // line 2: ""
  // optional statement line(s)
  // empty line
  // key/value lines: "Key: value"
  if (lines.length < 6) return null;

  const m0 = /^([^\s]+) wants you to sign in with your Ethereum account:$/.exec(lines[0]);
  if (!m0) return null;
  const domain = m0[1];

  const address = lines[1].trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null;

  // Find the URI/Version/Chain ID/Nonce/Issued At block
  const fields = {};
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i];
    const idx = line.indexOf(": ");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 2).trim();
    if (key && value) fields[key] = value;
  }

  if (!fields.URI || !fields.Version || !fields["Chain ID"] || !fields.Nonce || !fields["Issued At"]) {
    return null;
  }
  if (fields.Version !== "1") return null;

  return {
    domain,
    address: address.toLowerCase(),
    statement: extractStatement(lines),
    uri: fields.URI,
    version: fields.Version,
    chainId: parseInt(fields["Chain ID"], 10),
    nonce: fields.Nonce,
    issuedAt: fields["Issued At"],
    expirationTime: fields["Expiration Time"] || null,
    notBefore: fields["Not Before"] || null,
    requestId: fields["Request ID"] || null,
    resources: extractResources(lines),
  };
}

function extractStatement(lines) {
  // Statement (if any) sits between blank lines after the address line.
  // Layout: address \n "" \n [statement \n ""]
  if (lines[2] === "" && lines[3] !== "" && lines[4] === "") {
    return lines[3];
  }
  return null;
}
function extractResources(lines) {
  const idx = lines.findIndex((l) => l === "Resources:");
  if (idx === -1) return [];
  const out = [];
  for (let i = idx + 1; i < lines.length; i++) {
    if (lines[i].startsWith("- ")) out.push(lines[i].slice(2));
    else break;
  }
  return out;
}

/* ---------- secp256k1 / Ethereum address recovery ---------- */

/**
 * Given an Ethereum personal_sign signature (r||s||v, 65 bytes hex) and the
 * raw message that was signed, recover the signer's address. Returns null
 * on any malformed input or recovery failure.
 *
 * personal_sign hashes "\x19Ethereum Signed Message:\n<len>" + msg with
 * keccak256 before signing.
 */
export function recoverPersonalSignAddress(message, signatureHex) {
  try {
    const sig = hexToBytes(signatureHex);
    if (sig.length !== 65) return null;

    // EIP-191 prefix: "\x19Ethereum Signed Message:\n" + ascii(byteLength)
    const msgBytes = typeof message === "string" ? utf8(message) : message;
    const prefix = utf8(`\x19Ethereum Signed Message:\n${msgBytes.length}`);
    const prefixed = new Uint8Array(prefix.length + msgBytes.length);
    prefixed.set(prefix, 0);
    prefixed.set(msgBytes, prefix.length);
    const digest = keccak_256(prefixed);

    const r = sig.slice(0, 32);
    const s = sig.slice(32, 64);
    let v = sig[64];
    // Normalize v: legacy wallets send 27/28; some EIP-155 wallets send 0/1.
    if (v >= 27) v -= 27;
    if (v !== 0 && v !== 1) return null;

    // EIP-2 / SIWE: reject the high-s half of the curve and normalize so
    // every signature has exactly one canonical encoding. Without this a
    // valid signature could be re-encoded with s' = n - s and a flipped v
    // and the malleated copy would also verify, defeating nonce-based
    // replay protection downstream.
    const sigObj = new secp256k1.Signature(
      bytesToBigInt(r),
      bytesToBigInt(s),
    ).normalizeS().addRecoveryBit(v);

    const pubKey = sigObj.recoverPublicKey(digest); // returns ProjectivePoint
    const uncompressed = pubKey.toRawBytes(false);  // 65 bytes (0x04 || X || Y)
    // Drop the 0x04 prefix, hash the 64-byte X||Y, take last 20 bytes
    const addrHash = keccak_256(uncompressed.slice(1));
    const addrBytes = addrHash.slice(-20);
    return "0x" + bytesToHex(addrBytes);
  } catch (e) {
    return null;
  }
}

function bytesToBigInt(bytes) {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

/* ---------- SIWE end-to-end verification ---------- */

/**
 * Verify a SIWE login request. Returns one of:
 *   { ok: true,  address, parsed, messageHash }
 *   { ok: false, error: "..." }
 *
 * Side effect on success: deletes the consumed nonce from siwe_nonces.
 *
 * The caller (handler) is responsible for upserting the user + session.
 */
export async function verifySiwe(env, { message, signature, expectedDomains }) {
  if (!message || !signature) return { ok: false, error: "missing_message_or_signature" };

  const parsed = parseSiweMessage(message);
  if (!parsed) return { ok: false, error: "malformed_siwe_message" };

  // Domain check — accept any of the configured allowlisted domains.
  const allowed = (expectedDomains || []).map((d) => d.toLowerCase());
  if (allowed.length && !allowed.includes(parsed.domain.toLowerCase())) {
    return { ok: false, error: "domain_mismatch" };
  }

  // Time bounds
  const now = Date.now();
  if (parsed.expirationTime) {
    const exp = Date.parse(parsed.expirationTime);
    if (Number.isFinite(exp) && exp <= now) return { ok: false, error: "message_expired" };
  }
  if (parsed.notBefore) {
    const nbf = Date.parse(parsed.notBefore);
    if (Number.isFinite(nbf) && nbf > now) return { ok: false, error: "not_yet_valid" };
  }
  // issuedAt should be recent (within nonce TTL, with 60s clock skew)
  const iat = Date.parse(parsed.issuedAt);
  if (!Number.isFinite(iat) || iat < now - NONCE_TTL_MS - 60_000 || iat > now + 60_000) {
    return { ok: false, error: "stale_or_future_issued_at" };
  }

  // Nonce check + atomic consume
  if (!env.HEALTH_DB) return { ok: false, error: "db_unavailable" };
  const row = await env.HEALTH_DB
    .prepare("SELECT expires_at FROM siwe_nonces WHERE nonce = ?")
    .bind(parsed.nonce).first();
  if (!row) return { ok: false, error: "unknown_or_consumed_nonce" };
  if (row.expires_at < now) {
    await env.HEALTH_DB.prepare("DELETE FROM siwe_nonces WHERE nonce = ?")
      .bind(parsed.nonce).run().catch(() => {});
    return { ok: false, error: "nonce_expired" };
  }

  // Recover address from signature
  const recovered = recoverPersonalSignAddress(message, signature);
  if (!recovered || recovered.toLowerCase() !== parsed.address.toLowerCase()) {
    return { ok: false, error: "signature_address_mismatch" };
  }

  // Atomic-ish consume (D1 has no transactions across statements, but
  // DELETE WHERE nonce = ? is a single statement and idempotent).
  await env.HEALTH_DB.prepare("DELETE FROM siwe_nonces WHERE nonce = ?")
    .bind(parsed.nonce).run().catch(() => {});

  const messageHash = "0x" + bytesToHex(keccak_256(utf8(message)));
  return { ok: true, address: recovered.toLowerCase(), parsed, messageHash };
}

/* ---------- nonce minting ---------- */

export async function mintNonce(env) {
  if (!env.HEALTH_DB) throw new Error("HEALTH_DB binding required");
  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const now = Date.now();
  await env.HEALTH_DB
    .prepare("INSERT INTO siwe_nonces (nonce, issued_at, expires_at) VALUES (?, ?, ?)")
    .bind(nonce, now, now + NONCE_TTL_MS)
    .run();
  return { nonce, expiresAt: now + NONCE_TTL_MS };
}

/* ---------- session cookies (HMAC-SHA256 signed) ---------- */

export function signSessionToken(sessionId, hmacKey) {
  const sig = hmac(sha256, utf8(hmacKey), utf8(sessionId));
  return `${sessionId}.${bytesToHex(sig)}`;
}

export function verifySessionToken(token, hmacKey) {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const sessionId = token.slice(0, dot);
  const sigHex = token.slice(dot + 1);
  const expected = bytesToHex(hmac(sha256, utf8(hmacKey), utf8(sessionId)));
  // Constant-time compare
  if (sigHex.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= sigHex.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? sessionId : null;
}

export function buildSessionCookie(token, opts = {}) {
  const maxAge = Math.floor((opts.maxAgeMs || SESSION_TTL_MS) / 1000);
  const flags = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  return flags.join("; ");
}

export function buildLogoutCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readCookie(request, name = COOKIE_NAME) {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(name + "=")) return trimmed.slice(name.length + 1);
  }
  return null;
}

/* ---------- session lifecycle ---------- */

export async function createSession(env, { userId, walletAddress, request }) {
  // SESSION_HMAC_KEY is the trust anchor for both the session cookie and
  // the user-agent fingerprint stored alongside it. If the operator hasn't
  // provisioned it we MUST refuse — falling back to "" would let an
  // attacker forge cookies with a known key.
  if (!env.SESSION_HMAC_KEY) {
    throw new Error("SESSION_HMAC_KEY is not configured");
  }
  const id = newId();
  const now = Date.now();
  const ua = request?.headers?.get("user-agent") || "";
  const uaHash = ua
    ? bytesToHex(hmac(sha256, utf8(env.SESSION_HMAC_KEY), utf8(ua)))
    : null;
  await env.HEALTH_DB.prepare(
    "INSERT INTO sessions (id, user_id, wallet_address, created_at, expires_at, last_seen_at, user_agent_hash) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, userId, walletAddress.toLowerCase(), now, now + SESSION_TTL_MS, now, uaHash).run();
  return { id, expiresAt: now + SESSION_TTL_MS };
}

export async function loadSession(env, sessionId) {
  if (!sessionId || !env.HEALTH_DB) return null;
  const row = await env.HEALTH_DB.prepare(
    "SELECT id, user_id, wallet_address, created_at, expires_at, last_seen_at FROM sessions WHERE id = ?"
  ).bind(sessionId).first();
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await env.HEALTH_DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run().catch(() => {});
    return null;
  }
  // Touch last_seen_at, but cheaply (only every ~10min) to avoid DB churn.
  if (Date.now() - row.last_seen_at > 10 * 60 * 1000) {
    env.HEALTH_DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?")
      .bind(Date.now(), sessionId).run().catch(() => {});
  }
  return row;
}

export async function destroySession(env, sessionId) {
  if (!sessionId || !env.HEALTH_DB) return;
  await env.HEALTH_DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run().catch(() => {});
}

/* ---------- middleware: requireSession ----------
 *
 * Usage in a handler:
 *   const auth = await requireSession(request, env);
 *   if (auth instanceof Response) return auth; // 401
 *   const { user, session } = auth;
 */

export async function requireSession(request, env) {
  if (!env.SESSION_HMAC_KEY) return unauthorized("session_hmac_key_unset");
  const cookie = readCookie(request);
  if (!cookie) return unauthorized("no_session_cookie");
  const sessionId = verifySessionToken(cookie, env.SESSION_HMAC_KEY);
  if (!sessionId) return unauthorized("invalid_session_signature");

  const session = await loadSession(env, sessionId);
  if (!session) return unauthorized("session_not_found_or_expired");

  const user = await env.HEALTH_DB.prepare(
    "SELECT id, primary_wallet, email, display_name, is_admin, created_at, last_login_at FROM users WHERE id = ?"
  ).bind(session.user_id).first();
  if (!user) return unauthorized("user_not_found");

  return { user, session };
}

function unauthorized(reason) {
  return new Response(
    JSON.stringify({ success: false, error: "unauthorized", reason }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}

/* ---------- middleware: optionalSession ----------
 *
 * Like requireSession, but never throws / never returns a Response. Returns
 * { user, session } when a valid session cookie is present, otherwise null.
 * Use this on endpoints that work for both anonymous and signed-in callers
 * (e.g. /api/health-score/.../history clamps row count by tier when signed
 * in, but still serves a free-tier window when anonymous).
 */
export async function optionalSession(request, env) {
  if (!env.SESSION_HMAC_KEY) return null;
  const cookie = readCookie(request);
  if (!cookie) return null;
  const sessionId = verifySessionToken(cookie, env.SESSION_HMAC_KEY);
  if (!sessionId) return null;
  const session = await loadSession(env, sessionId);
  if (!session) return null;
  const user = await env.HEALTH_DB.prepare(
    "SELECT id, primary_wallet, email, display_name, is_admin, created_at, last_login_at FROM users WHERE id = ?"
  ).bind(session.user_id).first().catch(() => null);
  if (!user) return null;
  return { user, session };
}

/* ---------- user lookup / upsert ---------- */

export async function findOrCreateUser(env, walletAddress) {
  const lower = walletAddress.toLowerCase();
  const now = Date.now();

  const existing = await env.HEALTH_DB
    .prepare("SELECT id, primary_wallet, email, display_name, is_admin, created_at FROM users WHERE primary_wallet = ?")
    .bind(lower).first();

  if (existing) {
    await env.HEALTH_DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?")
      .bind(now, existing.id).run().catch(() => {});
    return { ...existing, last_login_at: now, isNew: false };
  }

  // Also check if this wallet is a non-primary linked wallet for someone else
  const linked = await env.HEALTH_DB
    .prepare("SELECT user_id FROM wallet_connections WHERE wallet_address = ? LIMIT 1")
    .bind(lower).first();
  if (linked) {
    const u = await env.HEALTH_DB.prepare(
      "SELECT id, primary_wallet, email, display_name, is_admin, created_at FROM users WHERE id = ?"
    ).bind(linked.user_id).first();
    if (u) {
      await env.HEALTH_DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?")
        .bind(now, u.id).run().catch(() => {});
      return { ...u, last_login_at: now, isNew: false };
    }
  }

  // Create new user
  const id = newId();
  const isAdmin = (env.ADMIN_BOOTSTRAP_ADDRESS || "").toLowerCase() === lower ? 1 : 0;
  await env.HEALTH_DB.batch([
    env.HEALTH_DB.prepare(
      "INSERT INTO users (id, primary_wallet, is_admin, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(id, lower, isAdmin, now, now),
    env.HEALTH_DB.prepare(
      "INSERT INTO wallet_connections (user_id, wallet_address, signature, message_hash, is_primary, connected_at, last_seen_at) VALUES (?, ?, '', '', 1, ?, ?)"
    ).bind(id, lower, now, now),
    env.HEALTH_DB.prepare(
      "INSERT INTO subscriptions (user_id, tier, status, created_at, updated_at) VALUES (?, 'free', 'active', ?, ?)"
    ).bind(id, now, now),
  ]);
  return { id, primary_wallet: lower, email: null, display_name: null, is_admin: isAdmin, created_at: now, last_login_at: now, isNew: true };
}
