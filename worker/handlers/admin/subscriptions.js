/* DeFiScoring – Admin: subscriptions
 *
 *   GET    /api/admin/subscriptions?tier=&status=&limit=&offset=
 *   POST   /api/admin/subscriptions/{userId}/cancel        { atPeriodEnd? }
 *   POST   /api/admin/subscriptions/{userId}/refund        { amountCents?, chargeId? }
 *   PATCH  /api/admin/subscriptions/{userId}               { tier }   (manual override)
 *
 * The Stripe webhook is still the long-term source of truth; manual tier
 * overrides set `metadata.manual_override` so we can tell them apart from
 * webhook-synced rows. Cancel + refund both call live Stripe.
 */

import { requireAdmin, auditLog } from "../../lib/admin.js";
import {
  isConfigured as stripeConfigured,
  cancelSubscription, createRefund, listInvoices,
} from "../../lib/stripe.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

const VALID_TIERS = new Set(["free", "pro", "plus", "enterprise"]);

export async function handleAdminSubsList(request, env, url) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  const tier   = url.searchParams.get("tier");
  const status = url.searchParams.get("status");
  const limit  = Math.max(1, Math.min(200, parseInt(url.searchParams.get("limit")  || "50", 10) || 50));
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);

  const where = [];
  const binds = [];
  if (tier && VALID_TIERS.has(tier)) { where.push("s.tier = ?"); binds.push(tier); }
  if (status) { where.push("s.status = ?"); binds.push(status); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  binds.push(limit, offset);
  const rows = await env.HEALTH_DB.prepare(
    `SELECT s.user_id, s.tier, s.status, s.stripe_customer_id, s.stripe_subscription_id,
            s.current_period_end, s.cancel_at_period_end, s.updated_at,
            u.primary_wallet, u.email
     FROM subscriptions s
     LEFT JOIN users u ON u.id = s.user_id
     ${whereSql}
     ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`
  ).bind(...binds).all();

  return json({ success: true, subscriptions: rows.results || [], limit, offset });
}

export async function handleAdminSubCancel(request, env, userId) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;
  if (!stripeConfigured(env)) return json({ success: false, error: "stripe_not_configured" }, 503);

  const sub = await env.HEALTH_DB.prepare(
    "SELECT stripe_subscription_id, tier, cancel_at_period_end FROM subscriptions WHERE user_id = ?"
  ).bind(userId).first();
  if (!sub) return json({ success: false, error: "subscription_not_found" }, 404);
  if (!sub.stripe_subscription_id) return json({ success: false, error: "no_stripe_subscription" }, 400);

  let body; try { body = await request.json(); } catch { body = {}; }
  const atPeriodEnd = body.atPeriodEnd !== false;

  let result;
  try {
    result = await cancelSubscription(env, sub.stripe_subscription_id, { atPeriodEnd });
  } catch (e) {
    return json({ success: false, error: "stripe_cancel_failed", detail: e.message }, 502);
  }

  // Reflect immediately in our row (the webhook will catch up too)
  await env.HEALTH_DB.prepare(
    "UPDATE subscriptions SET cancel_at_period_end = ?, status = ?, updated_at = ? WHERE user_id = ?"
  ).bind(atPeriodEnd ? 1 : 0, atPeriodEnd ? "active" : "canceled", Date.now(), userId).run();

  await auditLog(env, {
    actor: auth.user, action: "sub.cancel",
    targetType: "subscription", targetId: userId,
    before: { cancel_at_period_end: sub.cancel_at_period_end, tier: sub.tier },
    after:  { cancel_at_period_end: atPeriodEnd ? 1 : 0, mode: atPeriodEnd ? "at_period_end" : "immediate" },
    request,
  });

  return json({ success: true, stripe: { id: result.id, status: result.status } });
}

export async function handleAdminSubRefund(request, env, userId) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;
  if (!stripeConfigured(env)) return json({ success: false, error: "stripe_not_configured" }, 503);

  const sub = await env.HEALTH_DB.prepare(
    "SELECT stripe_customer_id, tier FROM subscriptions WHERE user_id = ?"
  ).bind(userId).first();
  if (!sub || !sub.stripe_customer_id) return json({ success: false, error: "no_stripe_customer" }, 400);

  let body; try { body = await request.json(); } catch { body = {}; }

  // If no chargeId provided, find the most recent successful charge.
  let chargeId = body.chargeId || null;
  if (!chargeId) {
    try {
      const invs = await listInvoices(env, sub.stripe_customer_id, 5);
      const paid = (invs.data || []).find((i) => i.status === "paid" && i.charge);
      if (paid) chargeId = paid.charge;
    } catch (e) {
      return json({ success: false, error: "stripe_invoice_lookup_failed", detail: e.message }, 502);
    }
  }
  if (!chargeId) return json({ success: false, error: "no_refundable_charge_found" }, 400);

  let amountCents = null;
  if (body.amountCents != null) {
    const n = Number(body.amountCents);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 100_000_00) {
      return json({ success: false, error: "invalid_amount_cents" }, 400);
    }
    amountCents = n;
  }

  let refund;
  try {
    refund = await createRefund(env, { chargeId, amountCents });
  } catch (e) {
    return json({ success: false, error: "stripe_refund_failed", detail: e.message }, 502);
  }

  await auditLog(env, {
    actor: auth.user, action: "sub.refund",
    targetType: "subscription", targetId: userId,
    before: null,
    after:  { chargeId, amountCents: amountCents || refund.amount, refund_id: refund.id },
    request,
  });

  return json({ success: true, refund: { id: refund.id, amount: refund.amount, status: refund.status } });
}

export async function handleAdminSubPatch(request, env, userId) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  let body; try { body = await request.json(); } catch { body = {}; }
  if (!VALID_TIERS.has(body.tier)) return json({ success: false, error: "invalid_tier" }, 400);

  const before = await env.HEALTH_DB.prepare(
    "SELECT tier, status, metadata FROM subscriptions WHERE user_id = ?"
  ).bind(userId).first();
  if (!before) return json({ success: false, error: "subscription_not_found" }, 404);

  const meta = (() => {
    try { return JSON.parse(before.metadata || "{}"); } catch { return {}; }
  })();
  meta.manual_override = { by: auth.user.id, at: Date.now(), prev_tier: before.tier };

  await env.HEALTH_DB.prepare(
    "UPDATE subscriptions SET tier = ?, metadata = ?, updated_at = ? WHERE user_id = ?"
  ).bind(body.tier, JSON.stringify(meta), Date.now(), userId).run();

  await auditLog(env, {
    actor: auth.user, action: "sub.tier_override",
    targetType: "subscription", targetId: userId,
    before: { tier: before.tier },
    after:  { tier: body.tier, manual_override: true },
    request,
  });

  return json({ success: true, tier: body.tier });
}
