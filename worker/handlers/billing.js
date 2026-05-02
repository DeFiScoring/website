/* DeFiScoring – Stripe billing endpoints
 *
 *   GET  /api/billing/config       → publishable key + price IDs (for client checkout)
 *   POST /api/billing/checkout     → create a Stripe Checkout session, return redirect URL
 *   POST /api/billing/portal       → open the Stripe Customer Portal
 *   POST /api/webhooks/stripe      → idempotent subscription sync from Stripe events
 *
 * The webhook is the source of truth for subscription state; checkout/portal
 * just kick off the user-facing flows. We never trust the client's claim of
 * what tier they're on — the tier is always read from D1.
 */

import { requireSession } from "../lib/auth.js";
import {
  isConfigured, createCheckoutSession, createPortalSession,
  verifyWebhook, tierForPriceId, getCustomer, getSubscription as stripeGetSubscription,
} from "../lib/stripe.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json" },
  });
}

export function handleBillingConfig(request, env) {
  return json({
    success: true,
    enabled: isConfigured(env),
    publishable_key: env.STRIPE_PUBLISHABLE_KEY || null,
    prices: {
      pro:  env.STRIPE_PRICE_ID_PRO  || null,
      plus: env.STRIPE_PRICE_ID_PLUS || null,
    },
  });
}

export async function handleBillingCheckout(request, env) {
  if (!isConfigured(env)) return json({ success: false, error: "stripe_not_configured" }, 503);

  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;

  let body;
  try { body = await request.json(); } catch { body = {}; }
  const tier = body.tier;
  const priceId = tier === "pro" ? env.STRIPE_PRICE_ID_PRO
                : tier === "plus" ? env.STRIPE_PRICE_ID_PLUS
                : null;
  if (!priceId) return json({ success: false, error: "invalid_or_unconfigured_tier", tier }, 400);

  const origin = request.headers.get("origin") || "https://defiscoring.com";
  const successUrl = `${origin}/dashboard/?billing=success&tier=${tier}`;
  const cancelUrl  = `${origin}/pricing/?billing=cancelled`;

  // Reuse stripe customer id if we already have one
  const sub = await env.HEALTH_DB.prepare(
    "SELECT stripe_customer_id FROM subscriptions WHERE user_id = ?"
  ).bind(auth.user.id).first();

  try {
    const session = await createCheckoutSession(env, {
      priceId,
      customerId: sub?.stripe_customer_id || null,
      customerEmail: auth.user.email || null,
      successUrl, cancelUrl,
      userId: auth.user.id,
      tier,
    });
    return json({ success: true, url: session.url, session_id: session.id });
  } catch (e) {
    return json({ success: false, error: "stripe_checkout_failed", detail: e.message }, 502);
  }
}

export async function handleBillingPortal(request, env) {
  if (!isConfigured(env)) return json({ success: false, error: "stripe_not_configured" }, 503);

  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;

  const sub = await env.HEALTH_DB.prepare(
    "SELECT stripe_customer_id FROM subscriptions WHERE user_id = ?"
  ).bind(auth.user.id).first();
  if (!sub?.stripe_customer_id) return json({ success: false, error: "no_stripe_customer" }, 400);

  const origin = request.headers.get("origin") || "https://defiscoring.com";
  try {
    const portal = await createPortalSession(env, {
      customerId: sub.stripe_customer_id,
      returnUrl: `${origin}/dashboard/?billing=managed`,
    });
    return json({ success: true, url: portal.url });
  } catch (e) {
    return json({ success: false, error: "stripe_portal_failed", detail: e.message }, 502);
  }
}

/* ---------- webhook ---------- */

export async function handleStripeWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ success: false, error: "webhook_secret_unset" }, 503);

  const sig = request.headers.get("stripe-signature");
  const raw = await request.text();
  const event = await verifyWebhook(raw, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!event) return json({ success: false, error: "invalid_signature" }, 400);

  // Idempotency — Stripe may retry an event for up to ~3 days. We log every
  // event id once, namespaced "stripe_evt:" inside the siwe_nonces table
  // (which exists purely as a short-string ↔ TTL keystore in D1; nothing
  // prunes it indiscriminately, only `verifySiwe` deletes a row when it
  // consumes the matching SIWE nonce, so foreign keys here are safe).
  // Expiry is 90d — well beyond Stripe's retry window — so a delayed
  // retry can't slip through and cause double provisioning.
  const STRIPE_DEDUPE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
  const seen = await env.HEALTH_DB.prepare(
    "SELECT 1 FROM siwe_nonces WHERE nonce = ?"
  ).bind("stripe_evt:" + event.id).first().catch(() => null);
  if (seen) return json({ success: true, idempotent: true });
  await env.HEALTH_DB.prepare(
    "INSERT OR IGNORE INTO siwe_nonces (nonce, issued_at, expires_at) VALUES (?, ?, ?)"
  ).bind("stripe_evt:" + event.id, Date.now(), Date.now() + STRIPE_DEDUPE_TTL_MS).run().catch(() => {});

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await syncFromCheckoutSession(env, event.data.object);
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await syncFromSubscription(env, event.data.object);
        break;
      case "invoice.payment_failed":
        await markPastDue(env, event.data.object);
        break;
      // ignore everything else
    }
    return json({ success: true });
  } catch (e) {
    return json({ success: false, error: "webhook_processing_failed", detail: e.message }, 500);
  }
}

async function syncFromCheckoutSession(env, session) {
  const userId = session.metadata?.user_id;
  if (!userId) return;
  const customerId = session.customer;
  const subscriptionId = session.subscription;
  if (!subscriptionId) return; // one-time payment, ignore for now

  // Fetch the subscription to get the canonical state
  const sub = await stripeGetSubscription(env, subscriptionId);
  await upsertSubscriptionRow(env, { userId, customerId, stripeSub: sub });
}

async function syncFromSubscription(env, sub) {
  const userId = sub.metadata?.user_id;
  if (!userId) return;
  const customerId = sub.customer;
  await upsertSubscriptionRow(env, { userId, customerId, stripeSub: sub });
}

async function markPastDue(env, invoice) {
  if (!invoice.customer) return;
  await env.HEALTH_DB.prepare(
    "UPDATE subscriptions SET status = 'past_due', updated_at = ? WHERE stripe_customer_id = ?"
  ).bind(Date.now(), invoice.customer).run().catch(() => {});
}

async function upsertSubscriptionRow(env, { userId, customerId, stripeSub }) {
  const priceId = stripeSub.items?.data?.[0]?.price?.id;
  const tier = tierForPriceId(env, priceId) || "free";
  const status = stripeSub.status === "active" || stripeSub.status === "trialing"
    ? stripeSub.status
    : (stripeSub.status === "past_due" ? "past_due"
    : (stripeSub.status === "canceled" ? "canceled" : "incomplete"));
  const periodEnd = (stripeSub.current_period_end || 0) * 1000;
  const cancelAtEnd = stripeSub.cancel_at_period_end ? 1 : 0;
  const now = Date.now();

  await env.HEALTH_DB.prepare(
    `INSERT INTO subscriptions
       (user_id, tier, stripe_customer_id, stripe_subscription_id, status, current_period_end, cancel_at_period_end, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       tier = excluded.tier,
       stripe_customer_id = excluded.stripe_customer_id,
       stripe_subscription_id = excluded.stripe_subscription_id,
       status = excluded.status,
       current_period_end = excluded.current_period_end,
       cancel_at_period_end = excluded.cancel_at_period_end,
       metadata = excluded.metadata,
       updated_at = excluded.updated_at`
  ).bind(
    userId, tier, customerId, stripeSub.id, status, periodEnd, cancelAtEnd,
    JSON.stringify({ price_id: priceId, stripe_status: stripeSub.status }),
    now, now
  ).run();
}
