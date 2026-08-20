/* DeFiScoring – Webhook alert delivery
 *
 * POSTs an alert payload as JSON to a user-supplied URL, signed with the
 * per-channel secret so the receiver can prove the request came from us.
 *
 * Signature scheme (Stripe-style, timestamped to defeat replay):
 *
 *   X-DeFiScoring-Signature: t=<unix_ms>,v1=<hex hmac-sha256>
 *
 * where the MAC is computed over the exact bytes `${t}.${rawBody}` using the
 * channel secret. Receivers should recompute the MAC over the *raw* body
 * (not a re-serialized parse), compare in constant time, and reject
 * timestamps outside their tolerance window.
 *
 * ── SSRF posture ──────────────────────────────────────────────────────────
 * A webhook URL is attacker-controlled input that we then fetch server-side,
 * so it is a textbook SSRF sink. We reject, at both channel-creation time and
 * again at send time (defence in depth — a URL could in principle have been
 * written by an older build):
 *
 *   • any scheme other than https
 *   • embedded credentials (https://user:pass@host)
 *   • any port other than 443
 *   • IP literals — v4, v6, and the decimal/hex forms (https://2130706433/)
 *   • single-label and reserved-suffix hosts (localhost, *.internal, *.local,
 *     *.home.arpa, *.onion, …), which is what covers the cloud metadata
 *     endpoints and LAN service discovery
 *
 * and we send with `redirect: "manual"`, so a public host cannot 302 us into
 * a private one — a 3xx is a delivery failure, not a hop.
 *
 * Honest limitation: a Worker cannot resolve DNS itself, so a hostname that
 * *passes* these checks and then resolves to a private address (DNS rebinding,
 * or simply a public name with an RFC1918 A record) is not caught here. Fully
 * closing that requires egress filtering at the network layer. What we have
 * blocks the direct-address and redirect classes, which is the realistic
 * attack surface for a self-serve webhook field.
 */

const BLOCKED_SUFFIXES = [
  ".local", ".localhost", ".internal", ".intranet", ".lan",
  ".home.arpa", ".onion", ".test", ".example", ".invalid",
];

/** RFC1918 + loopback + link-local + CGNAT, for a clearer error message. */
function isPrivateIpv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const o = parts.map((p) => parseInt(p, 10));
  if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (o[0] === 10 || o[0] === 127 || o[0] === 0) return true;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  if (o[0] === 169 && o[1] === 254) return true;   // link-local (169.254.169.254)
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // CGNAT
  return false;
}

/**
 * Validate a webhook destination.
 * @returns {{ ok: true, url: string }} normalised URL, or
 *          {{ ok: false, error: string }} a stable machine-readable reason.
 */
export function validateWebhookUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, error: "missing_url" };
  if (raw.length > 500) return { ok: false, error: "url_too_long" };

  let u;
  try { u = new URL(raw.trim()); } catch { return { ok: false, error: "malformed_url" }; }

  if (u.protocol !== "https:") return { ok: false, error: "https_required" };
  if (u.username || u.password) return { ok: false, error: "credentials_not_allowed" };
  if (u.port && u.port !== "443") return { ok: false, error: "port_not_allowed" };

  const host = u.hostname.toLowerCase();
  if (!host) return { ok: false, error: "missing_host" };

  // IPv6 literals arrive bracketed from the URL parser.
  if (host.startsWith("[") || host.includes(":")) {
    return { ok: false, error: "ip_literal_not_allowed" };
  }
  // Dotted-quad and the integer/hex shorthands (https://2130706433/ == 127.0.0.1).
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return { ok: false, error: isPrivateIpv4(host) ? "private_ip_not_allowed" : "ip_literal_not_allowed" };
  }
  if (/^(\d+|0x[0-9a-f]+)$/.test(host)) return { ok: false, error: "ip_literal_not_allowed" };

  // A public endpoint always has a dot-separated registrable name. Rejecting
  // single-label hosts is what kills `localhost`, `metadata`, and every
  // short LAN name in one rule.
  if (!host.includes(".")) return { ok: false, error: "single_label_host_not_allowed" };
  if (BLOCKED_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s))) {
    return { ok: false, error: "reserved_host_not_allowed" };
  }

  return { ok: true, url: u.toString() };
}

/** Hex HMAC-SHA256 of `message` under `secret`. */
async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build the signature header value for a body. Exported so tests (and any
 * future replay tooling) sign exactly the way delivery does.
 */
export async function signPayload(secret, rawBody, timestamp) {
  const t = timestamp ?? Date.now();
  return `t=${t},v1=${await hmacHex(secret, `${t}.${rawBody}`)}`;
}

export function isConfigured() {
  // Unlike email/telegram there is no shared account to provision — a webhook
  // channel carries everything it needs (URL + secret) on its own row.
  return true;
}

/**
 * Deliver one alert payload. Never throws; returns { ok, error?, status? } so
 * the cron dispatcher can record the outcome uniformly with email/telegram.
 */
export async function send(env, { url, secret, payload, deliveryId, timeoutMs = 10000 }) {
  const guard = validateWebhookUrl(url);
  if (!guard.ok) return { ok: false, error: `unsafe_url:${guard.error}` };
  if (!secret) return { ok: false, error: "missing_secret" };

  const body = JSON.stringify(payload);
  const t = Date.now();
  let signature;
  try {
    signature = await signPayload(secret, body, t);
  } catch (e) {
    return { ok: false, error: `signing_failed:${e.message}` };
  }

  try {
    const res = await fetch(guard.url, {
      method: "POST",
      redirect: "manual",          // a 3xx must not become a hop to a private host
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "content-type": "application/json",
        "user-agent": "DeFiScoring-Webhook/1.0 (+https://defiscoring.com)",
        "x-defiscoring-event": "alert.fired",
        "x-defiscoring-delivery": deliveryId || "",
        "x-defiscoring-signature": signature,
      },
      body,
    });

    if (res.status >= 300 && res.status < 400) {
      return { ok: false, status: res.status, error: "redirect_not_followed" };
    }
    if (!res.ok) {
      // Surface a snippet of the receiver's response — it is usually the
      // fastest way for a user to debug their own endpoint.
      let detail = "";
      try { detail = (await res.text()).slice(0, 200); } catch { /* body unreadable */ }
      return { ok: false, status: res.status, error: `http_${res.status}${detail ? `:${detail}` : ""}` };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    const reason = e?.name === "TimeoutError" ? "timeout" : (e?.message || String(e));
    return { ok: false, error: reason };
  }
}
