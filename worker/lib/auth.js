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

import { CHAINS_BY_CHAINID } from "./chains.js";
import { ethCall } from "./providers.js";

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
  // Wallets that round-trip the message through a textarea (and some mobile
  // deep-link bridges) normalise LF to CRLF. The signature is over the exact
  // bytes we were handed, so we only normalise for *parsing* — never for
  // hashing, which always uses `raw`.
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  // EIP-4361 ABNF, in order:
  //   0  "<domain> wants you to sign in with your Ethereum account:"
  //   1  "0x…"                       (address)
  //   2  ""                          (mandatory blank)
  //   3  [statement]                 (optional, single line)
  //   4  ""                          (mandatory blank)
  //   5+ "URI: …" then the rest of the key/value block, optional "Resources:"
  //
  // When the statement is omitted lines 3 and 4 collapse into a single blank
  // line, so the field block can start at index 3 or 4. We locate it by the
  // mandatory "URI: " line rather than by counting, and we parse key/value
  // pairs ONLY from that block. Scanning the whole message (as an earlier
  // revision did) let a "Nonce: …"-shaped statement inject fields — the
  // statement is the one part of the message a third-party dapp fully
  // controls, so it must never be able to shadow a real field.
  if (lines.length < 5) return null;

  const m0 = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?([^\s/]+) wants you to sign in with your Ethereum account:$/
    .exec(lines[0]);
  if (!m0) return null;
  const domain = m0[1];

  const address = lines[1].trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  if (lines[2] !== "") return null;

  const uriIdx = lines.findIndex((l, i) => i >= 3 && l.startsWith("URI: "));
  if (uriIdx === -1) return null;
  // The field block is always preceded by a blank line.
  if (lines[uriIdx - 1] !== "") return null;

  // Everything between the address block and that blank line is the statement.
  const statementLines = lines.slice(3, uriIdx - 1);
  const statement = statementLines.length ? statementLines.join("\n") : null;

  // Fields run from the URI line to "Resources:" (exclusive) or end of message.
  const resourcesIdx = lines.findIndex((l, i) => i >= uriIdx && l === "Resources:");
  const fieldEnd = resourcesIdx === -1 ? lines.length : resourcesIdx;
  const fields = {};
  for (let i = uriIdx; i < fieldEnd; i++) {
    const line = lines[i];
    const idx = line.indexOf(": ");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 2).trim();
    // First occurrence wins — a duplicated key is a malformed message, not a
    // licence to overwrite an already-parsed field.
    if (key && value && !(key in fields)) fields[key] = value;
  }

  if (!fields.URI || !fields.Version || !fields["Chain ID"] || !fields.Nonce || !fields["Issued At"]) {
    return null;
  }
  if (fields.Version !== "1") return null;
  const chainId = parseInt(fields["Chain ID"], 10);
  if (!Number.isFinite(chainId) || chainId <= 0) return null;

  return {
    domain,
    address: address.toLowerCase(),
    statement,
    uri: fields.URI,
    version: fields.Version,
    chainId,
    nonce: fields.Nonce,
    issuedAt: fields["Issued At"],
    expirationTime: fields["Expiration Time"] || null,
    notBefore: fields["Not Before"] || null,
    requestId: fields["Request ID"] || null,
    resources: extractResources(lines, resourcesIdx),
  };
}

function extractResources(lines, resourcesIdx) {
  if (resourcesIdx === undefined) resourcesIdx = lines.indexOf("Resources:");
  if (resourcesIdx === -1) return [];
  const out = [];
  for (let i = resourcesIdx + 1; i < lines.length; i++) {
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
export function eip191Bytes(message) {
  // EIP-191 prefix: "\x19Ethereum Signed Message:\n" + ascii(byteLength)
  const msgBytes = typeof message === "string" ? utf8(message) : message;
  const prefix = utf8(`\x19Ethereum Signed Message:\n${msgBytes.length}`);
  const prefixed = new Uint8Array(prefix.length + msgBytes.length);
  prefixed.set(prefix, 0);
  prefixed.set(msgBytes, prefix.length);
  return prefixed;
}

export function eip191Digest(message) {
  return keccak_256(eip191Bytes(message));
}

export function recoverPersonalSignAddress(message, signatureHex) {
  try {
    const sig = hexToBytes(signatureHex);
    const digest = eip191Digest(message);

    let r, s, v;
    if (sig.length === 65) {
      r = sig.slice(0, 32);
      s = sig.slice(32, 64);
      v = sig[64];
      // Normalize v: legacy wallets send 27/28; some EIP-155 wallets send 0/1.
      if (v >= 27) v -= 27;
    } else if (sig.length === 64) {
      // EIP-2098 compact representation: the recovery bit rides in the top
      // bit of `s`, which is always 0 for a canonical (low-s) signature.
      // viem's `signMessage` and several hardware-wallet bridges emit this
      // form, and a 64-byte signature used to be rejected outright.
      r = sig.slice(0, 32);
      s = sig.slice(32, 64).slice();
      v = (s[0] & 0x80) >> 7;
      s[0] &= 0x7f;
    } else {
      return null;
    }
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

/* ---------- EIP-1271: smart-contract wallet signatures ----------
 *
 * Safe, Argent, Coinbase Smart Wallet, Ambire and every ERC-4337 account
 * are contracts, not EOAs: there is no private key to recover an address
 * from, so `recoverPersonalSignAddress` can never validate them. Instead
 * the contract itself is the authority — we call `isValidSignature` on it
 * and check for the ERC-1271 magic return value.
 *
 * Two ABIs exist in the wild:
 *   • EIP-1271 final:  isValidSignature(bytes32 hash, bytes sig)
 *                      → returns 0x1626ba7e
 *   • Pre-final draft: isValidSignature(bytes data, bytes sig)
 *                      → returns 0x20c13b0b   (older Safe / Argent deploys)
 * We try the modern one first and fall back, so both generations work.
 */

const SEL_IS_VALID_SIGNATURE_HASH  = "0x1626ba7e"; // isValidSignature(bytes32,bytes)
const SEL_IS_VALID_SIGNATURE_BYTES = "0x20c13b0b"; // isValidSignature(bytes,bytes)

function abiWordHex(bytes32OrBigInt) {
  if (typeof bytes32OrBigInt === "bigint") {
    return bytes32OrBigInt.toString(16).padStart(64, "0");
  }
  return bytesToHex(bytes32OrBigInt).padStart(64, "0");
}

// ABI-encode a dynamic `bytes` payload: 32-byte length + right-padded data.
function abiEncodeBytes(bytes) {
  const len = abiWordHex(BigInt(bytes.length));
  const body = bytesToHex(bytes);
  const padded = body.padEnd(Math.ceil(body.length / 64) * 64, "0");
  return len + padded;
}

function abiEncodedByteLength(bytes) {
  // one length word + the padded body, in bytes
  return 32 + Math.ceil(bytes.length / 32) * 32;
}

/**
 * Ask the contract at `address` whether `signature` is a valid signature of
 * `message` (EIP-191 personal_sign framing) on chain `chainId`.
 * Returns true only on an explicit magic-value match — any RPC failure,
 * revert, or non-contract address returns false.
 */
export async function verifyErc1271Signature(env, { address, message, signature, chainId }) {
  const chain = CHAINS_BY_CHAINID[chainId] || CHAINS_BY_CHAINID[1];
  if (!chain) return false;

  let sigBytes;
  try { sigBytes = hexToBytes(signature); } catch { return false; }
  if (!sigBytes.length) return false;

  const digest = eip191Digest(message);
  const prefixed = eip191Bytes(message);

  // --- modern: isValidSignature(bytes32 hash, bytes signature) -------------
  const modernData =
    SEL_IS_VALID_SIGNATURE_HASH +
    abiWordHex(digest) +                       // arg0: hash
    abiWordHex(BigInt(64)) +                   // arg1: offset to `signature`
    abiEncodeBytes(sigBytes);
  const modern = await ethCall(chain, env, address, modernData);
  if (typeof modern === "string" && modern.slice(2, 10).toLowerCase() === "1626ba7e") {
    return true;
  }

  // --- legacy draft: isValidSignature(bytes data, bytes signature) ---------
  const dataOffset = 64;
  const sigOffset = dataOffset + abiEncodedByteLength(prefixed);
  const legacyData =
    SEL_IS_VALID_SIGNATURE_BYTES +
    abiWordHex(BigInt(dataOffset)) +
    abiWordHex(BigInt(sigOffset)) +
    abiEncodeBytes(prefixed) +
    abiEncodeBytes(sigBytes);
  const legacy = await ethCall(chain, env, address, legacyData);
  if (typeof legacy === "string" && legacy.slice(2, 10).toLowerCase() === "20c13b0b") {
    return true;
  }

  return false;
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
  if (typeof signature !== "string" || !/^(0x)?[0-9a-fA-F]+$/.test(signature)) {
    return { ok: false, error: "malformed_signature" };
  }

  const parsed = parseSiweMessage(message);
  if (!parsed) return { ok: false, error: "malformed_siwe_message" };

  // Domain check — accept any of the configured allowlisted domains. Both
  // sides are normalised to a bare host so "https://defiscoring.com" (some
  // wallet SDKs put the full origin in the domain slot) matches the
  // "defiscoring.com" we derive from ALLOWED_ORIGINS.
  const allowed = (expectedDomains || []).map(normalizeDomain).filter(Boolean);
  if (allowed.length && !allowed.includes(normalizeDomain(parsed.domain))) {
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

  // Nonce claim. This is a single DELETE guarded on expiry, so exactly one
  // caller can ever win it: the row is the lock. The previous SELECT-then-
  // verify-then-DELETE sequence left a window where two concurrent
  // /api/auth/verify calls carrying the same nonce both passed the SELECT
  // and both minted a session — which is precisely the replay the nonce
  // exists to prevent.
  //
  // Consuming *before* signature verification means a bad signature burns
  // the nonce and the client has to fetch a fresh one. That is the intended
  // trade: it also removes any ability to grind signatures against a single
  // live nonce.
  if (!env.HEALTH_DB) return { ok: false, error: "db_unavailable" };
  let claimed;
  try {
    const res = await env.HEALTH_DB
      .prepare("DELETE FROM siwe_nonces WHERE nonce = ? AND expires_at > ?")
      .bind(parsed.nonce, now).run();
    claimed = (res?.meta?.changes || 0) === 1;
  } catch (e) {
    return { ok: false, error: "nonce_lookup_failed" };
  }
  if (!claimed) return { ok: false, error: "unknown_or_expired_nonce" };

  // Recover address from signature (EOA path).
  const recovered = recoverPersonalSignAddress(message, signature);
  let method = "eoa";
  if (!recovered || recovered.toLowerCase() !== parsed.address.toLowerCase()) {
    // Not a matching EOA signature. Before rejecting, ask the address
    // itself — smart-contract wallets (Safe, Argent, Coinbase Smart Wallet,
    // every ERC-4337 account) sign via EIP-1271 and have no recoverable
    // key. Without this branch those wallets can never sign in at all.
    const okContract = await verifyErc1271Signature(env, {
      address: parsed.address,
      message,
      signature,
      chainId: parsed.chainId,
    }).catch(() => false);
    if (!okContract) return { ok: false, error: "signature_address_mismatch" };
    method = "eip1271";
  }

  const messageHash = "0x" + bytesToHex(keccak_256(utf8(message)));
  return { ok: true, address: parsed.address.toLowerCase(), parsed, messageHash, method };
}

/** Reduce "https://host:port/path" | "host:port" | "HOST" to a bare lowercase host[:port]. */
function normalizeDomain(d) {
  if (typeof d !== "string") return null;
  let s = d.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");  // strip scheme
  s = s.split("/")[0];                            // strip path
  return s || null;
}

/* ---------- EIP-55 checksum address ----------
 *
 * Coinbase Wallet (and other strict-per-spec wallets) reject SIWE messages
 * whose address line isn't EIP-55 checksummed, even though `eth_requestAccounts`
 * itself returns lowercase. The frontend has no keccak handy, so we expose
 * checksum encoding through the nonce endpoint and have the client paste it
 * into the SIWE message line 2.
 */
export function toChecksumAddress(addr) {
  if (typeof addr !== "string") return null;
  const clean = addr.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(clean)) return null;
  const hashHex = bytesToHex(keccak_256(utf8(clean)));
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    const c = clean[i];
    if (/[0-9]/.test(c)) { out += c; continue; }
    // Hex digit of the hash at position i; ≥8 → uppercase letter.
    out += parseInt(hashHex[i], 16) >= 8 ? c.toUpperCase() : c;
  }
  return out;
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

/* ---------- cookie attributes ----------
 *
 * The dashboard is served from defiscoring.com while the API answers on the
 * worker's own hostname (see site.defi.worker_url). Those are different
 * registrable domains, which makes every `fetch(..., {credentials:"include"})`
 * a cross-site request — and a `SameSite=Lax` cookie is NEVER sent on one.
 * The practical effect was that /api/auth/verify set a cookie the browser
 * then refused to send back, so /api/auth/me returned 401 immediately after
 * a successful signature and no wallet could stay signed in.
 *
 * So the SameSite value has to follow the request: `None` (plus `Partitioned`
 * for CHIPS, since Chrome's third-party cookie deprecation would otherwise
 * drop it) when the caller is cross-site, and `Lax` when the site and API
 * share an origin — which is the stronger default and the deployment we get
 * when the worker serves the static assets itself.
 *
 * `SameSite=None` removes SameSite's incidental CSRF protection; the Origin
 * check enforced on every state-changing /api/ route (worker/index.js) is
 * what replaces it, and is required for this to be safe.
 */
export function isCrossSiteRequest(request) {
  try {
    const origin = request?.headers?.get?.("origin");
    if (!origin) return false;                 // same-origin or non-browser
    const originHost = new URL(origin).host.toLowerCase();
    const selfHost = new URL(request.url).host.toLowerCase();
    if (originHost === selfHost) return false;
    // Treat "www.example.com" vs "example.com" as same-site.
    return registrableish(originHost) !== registrableish(selfHost);
  } catch {
    return true; // unparseable Origin — assume the strictest case
  }
}

function registrableish(host) {
  const bare = host.split(":")[0];
  return bare.replace(/^www\./, "");
}

function cookieAttrs(crossSite) {
  return crossSite
    ? ["Secure", "SameSite=None", "Partitioned"]
    : ["Secure", "SameSite=Lax"];
}

export function buildSessionCookie(token, opts = {}) {
  const maxAge = Math.floor((opts.maxAgeMs || SESSION_TTL_MS) / 1000);
  return [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    ...cookieAttrs(!!opts.crossSite),
    `Max-Age=${maxAge}`,
  ].join("; ");
}

// The delete cookie must carry the SAME attributes as the one it replaces or
// the browser treats it as a different cookie and the session cookie survives
// logout.
export function buildLogoutCookie(opts = {}) {
  return [
    `${COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    ...cookieAttrs(!!opts.crossSite),
    "Max-Age=0",
  ].join("; ");
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
