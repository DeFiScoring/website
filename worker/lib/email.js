/* DeFiScoring – Email delivery via Gmail API
 *
 * Cloudflare Workers cannot speak SMTP, so we use Gmail's REST API with a
 * service-account JWT (RS256). The flow:
 *   1. Sign a JWT claim with the service account's private key.
 *   2. POST it to https://oauth2.googleapis.com/token to get an access token.
 *   3. POST a base64url-encoded RFC 2822 MIME message to
 *      https://gmail.googleapis.com/gmail/v1/users/{sender}/messages/send.
 *
 * Required secrets (set via Replit Secrets):
 *   GOOGLE_SA_EMAIL        — service account email (..@..iam.gserviceaccount.com)
 *   GOOGLE_SA_PRIVATE_KEY  — PEM-encoded RSA private key (PKCS#8, BEGIN PRIVATE KEY)
 *                            Must have domain-wide delegation enabled with the
 *                            "https://www.googleapis.com/auth/gmail.send" scope
 *                            and be impersonating GMAIL_SENDER.
 *   GMAIL_SENDER           — the Workspace user to impersonate (e.g.
 *                            "alerts@defiscoring.com")
 *
 * If any of those is missing, send() returns { ok: false, error: "..." } so
 * callers can surface a clear "delivery not configured" message.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_SEND_URL = (sender) =>
  `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(sender)}/messages/send`;

/* ---------- low-level helpers ---------- */

function base64url(bytes) {
  let str;
  if (bytes instanceof Uint8Array) {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    str = btoa(bin);
  } else {
    str = btoa(bytes);
  }
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function utf8(s) { return new TextEncoder().encode(s); }

function pemToPkcs8(pem) {
  const cleaned = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(cleaned);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------- JWT (RS256) signing using SubtleCrypto ---------- */

async function signRs256Jwt(claim, privateKeyPem) {
  const header = { alg: "RS256", typ: "JWT" };
  const headerB64 = base64url(utf8(JSON.stringify(header)));
  const claimB64 = base64url(utf8(JSON.stringify(claim)));
  const signingInput = `${headerB64}.${claimB64}`;

  const keyData = pemToPkcs8(privateKeyPem);
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, utf8(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(sig))}`;
}

/* ---------- access token (cached in KV for ~50 min) ---------- */

async function getAccessToken(env) {
  const sa = env.GOOGLE_SA_EMAIL;
  const pk = env.GOOGLE_SA_PRIVATE_KEY;
  const sender = env.GMAIL_SENDER;
  if (!sa || !pk || !sender) {
    throw new Error("gmail_not_configured");
  }

  const cacheKey = "gmail:access_token:" + sender;
  if (env.DEFI_CACHE) {
    const cached = await env.DEFI_CACHE.get(cacheKey, { type: "json" });
    if (cached && cached.expires_at > Date.now() + 60_000) {
      return cached.access_token;
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa,
    sub: sender, // domain-wide delegation: impersonate this user
    scope: "https://www.googleapis.com/auth/gmail.send",
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };

  // Some users will paste the key with literal "\n" instead of newlines.
  const pkNormalized = pk.includes("\\n") ? pk.replace(/\\n/g, "\n") : pk;
  const jwt = await signRs256Jwt(claim, pkNormalized);

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`gmail_token_failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;

  if (env.DEFI_CACHE) {
    await env.DEFI_CACHE.put(
      cacheKey,
      JSON.stringify({ access_token: data.access_token, expires_at: expiresAt }),
      { expirationTtl: Math.max(300, (data.expires_in || 3600) - 120) },
    ).catch(() => {});
  }
  return data.access_token;
}

/* ---------- MIME message building ---------- */

function buildMime({ from, to, subject, html, text }) {
  const boundary = "ds_" + Math.random().toString(36).slice(2);
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeMimeWord(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    text || stripHtml(html || ""),
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    html || `<pre>${escapeHtml(text || "")}</pre>`,
    "",
    `--${boundary}--`,
    "",
  ];
  return lines.join("\r\n");
}

function encodeMimeWord(s) {
  // Encode non-ASCII subjects as RFC 2047 base64
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return `=?UTF-8?B?${base64url(utf8(s)).replace(/-/g, "+").replace(/_/g, "/")}?=`;
}
function stripHtml(s) { return s.replace(/<[^>]+>/g, ""); }
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ---------- public API ---------- */

/**
 * send({ to, subject, html, text }) — returns { ok: boolean, error?, id? }
 */
export async function send(env, { to, subject, html, text }) {
  if (!to || !subject || (!html && !text)) {
    return { ok: false, error: "missing_to_subject_or_body" };
  }
  let token;
  try {
    token = await getAccessToken(env);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  const mime = buildMime({ from: env.GMAIL_SENDER, to, subject, html, text });
  const raw = base64url(utf8(mime));

  const res = await fetch(GMAIL_SEND_URL(env.GMAIL_SENDER), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: `gmail_send_failed: ${res.status} ${text.slice(0, 200)}` };
  }
  const data = await res.json();
  return { ok: true, id: data.id };
}

export function isConfigured(env) {
  return Boolean(env.GOOGLE_SA_EMAIL && env.GOOGLE_SA_PRIVATE_KEY && env.GMAIL_SENDER);
}
