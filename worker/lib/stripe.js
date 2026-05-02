/* DeFiScoring – Stripe REST client (no SDK dep)
 *
 * Cloudflare Workers don't ship the Node Stripe SDK; we use the REST API
 * directly with form-encoded bodies. This file covers exactly what we need
 * for T6.5: checkout sessions, customer portal sessions, and webhook
 * signature verification.
 *
 * Required secrets:
 *   STRIPE_SECRET_KEY        — sk_live_* or sk_test_*
 *   STRIPE_WEBHOOK_SECRET    — whsec_* (Stripe Dashboard → Webhooks)
 *   STRIPE_PRICE_ID_PRO      — price_* for Pro $15/mo
 *   STRIPE_PRICE_ID_PLUS     — price_* for Plus $49/mo
 *   STRIPE_PUBLISHABLE_KEY   — pk_* (used client-side; injected via /api/billing/config)
 *
 * All endpoints no-op gracefully if STRIPE_SECRET_KEY is missing so the
 * worker stays bootable without billing configured.
 */

import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";

const STRIPE_API = "https://api.stripe.com/v1";

function utf8(s) { return new TextEncoder().encode(s); }

export function isConfigured(env) {
  return Boolean(env.STRIPE_SECRET_KEY);
}

/* ---------- form-encoded body helpers ----------
 * Stripe accepts nested params via bracket notation, e.g.
 *   line_items[0][price]=price_xxx&line_items[0][quantity]=1
 */

function encodeForm(obj, prefix = "") {
  const parts = [];
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v == null) continue;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item && typeof item === "object") {
          parts.push(encodeForm(item, `${key}[${i}]`));
        } else {
          parts.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`);
        }
      });
    } else if (typeof v === "object") {
      parts.push(encodeForm(v, key));
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
    }
  }
  return parts.filter(Boolean).join("&");
}

async function stripeRequest(env, path, params, opts = {}) {
  if (!env.STRIPE_SECRET_KEY) throw new Error("stripe_not_configured");
  const headers = {
    authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    "content-type": "application/x-www-form-urlencoded",
  };
  if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;

  const res = await fetch(`${STRIPE_API}${path}`, {
    method: opts.method || "POST",
    headers,
    body: params ? encodeForm(params) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.error?.message || `stripe_${res.status}`;
    const err = new Error(msg);
    err.stripeStatus = res.status;
    err.stripeError = data?.error;
    throw err;
  }
  return data;
}

/* ---------- checkout / portal sessions ---------- */

export async function createCheckoutSession(env, { priceId, customerId, customerEmail, successUrl, cancelUrl, userId, tier }) {
  const params = {
    mode: "subscription",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": 1,
    success_url: successUrl,
    cancel_url: cancelUrl,
    allow_promotion_codes: "true",
    "metadata[user_id]": userId,
    "metadata[tier]": tier,
    "subscription_data[metadata][user_id]": userId,
    "subscription_data[metadata][tier]": tier,
  };
  if (customerId) params.customer = customerId;
  else if (customerEmail) params.customer_email = customerEmail;

  // Use a flat (already-bracketed) form body since we already wrote brackets
  const headers = {
    authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    "content-type": "application/x-www-form-urlencoded",
  };
  const body = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const res = await fetch(`${STRIPE_API}/checkout/sessions`, { method: "POST", headers, body });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data?.error?.message || `stripe_${res.status}`);
  return data;
}

export async function createPortalSession(env, { customerId, returnUrl }) {
  return stripeRequest(env, "/billing_portal/sessions", {
    customer: customerId,
    return_url: returnUrl,
  });
}

export async function getCustomer(env, customerId) {
  return stripeRequest(env, `/customers/${customerId}`, null, { method: "GET" });
}

export async function getSubscription(env, subscriptionId) {
  return stripeRequest(env, `/subscriptions/${subscriptionId}`, null, { method: "GET" });
}

/* ---------- webhook signature verification ---------- */

/**
 * Stripe-Signature header format:
 *   t=1492774577,v1=5257a869e7ec...
 * We HMAC-SHA256 `${t}.${rawBody}` with the webhook secret and compare
 * against the v1 entries in constant time.
 *
 * Returns the parsed event JSON on success, or null on any failure.
 */
export async function verifyWebhook(rawBody, signatureHeader, webhookSecret, toleranceSecs = 300) {
  if (!signatureHeader || !webhookSecret) return null;
  const items = signatureHeader.split(",").map((p) => p.trim());
  let timestamp = null;
  const signatures = [];
  for (const it of items) {
    const eq = it.indexOf("=");
    if (eq === -1) continue;
    const k = it.slice(0, eq);
    const v = it.slice(eq + 1);
    if (k === "t") timestamp = parseInt(v, 10);
    else if (k === "v1") signatures.push(v);
  }
  if (!timestamp || !signatures.length) return null;

  // Reject very old timestamps to thwart replay
  const skew = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (skew > toleranceSecs) return null;

  const signedPayload = `${timestamp}.${rawBody}`;
  const sig = hmac(sha256, utf8(webhookSecret), utf8(signedPayload));
  const expected = Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join("");

  let match = false;
  for (const got of signatures) {
    if (got.length === expected.length) {
      let diff = 0;
      for (let i = 0; i < expected.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
      if (diff === 0) { match = true; break; }
    }
  }
  if (!match) return null;

  try { return JSON.parse(rawBody); } catch { return null; }
}

/* ---------- price-id ↔ tier map ---------- */

export function tierForPriceId(env, priceId) {
  if (!priceId) return null;
  if (priceId === env.STRIPE_PRICE_ID_PRO)  return "pro";
  if (priceId === env.STRIPE_PRICE_ID_PLUS) return "plus";
  return null;
}
export function priceIdForTier(env, tier) {
  if (tier === "pro")  return env.STRIPE_PRICE_ID_PRO  || null;
  if (tier === "plus") return env.STRIPE_PRICE_ID_PLUS || null;
  return null;
}
