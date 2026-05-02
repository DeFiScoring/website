/* DeFiScoring – Tier + quota middleware
 *
 * Tier definitions and the requireTier() middleware. Subscriptions live in
 * the D1 `subscriptions` table; this module is the one place that knows
 * what each tier allows. Update TIERS to add/remove entitlements.
 *
 * Pricing (USD/month):
 *   free        — $0    — read-only, 1 wallet, 7-day history
 *   pro         — $15   — 3 wallets, 30-day history, alerts (email)
 *   plus        — $49   — 10 wallets, 1-year history, alerts (email + telegram), AI explainer, simulator
 *   enterprise  — custom — unlimited, bulk API, custody/POR widgets, SLA
 */

export const TIER_RANK = { free: 0, pro: 1, plus: 2, enterprise: 3 };

export const TIERS = {
  free: {
    label: "Free",
    price_usd_month: 0,
    limits: {
      "wallets.linked":           1,
      "history.days":             7,
      "alerts.rules":             0,    // free tier cannot create server-side alerts
      "alerts.channels":          0,
      "ai.explain.day":           0,
      "simulator.runs.day":       0,
      "bulk_api.requests.day":    0,
      "watchlist.size":           5,
    },
  },
  pro: {
    label: "Pro",
    price_usd_month: 15,
    limits: {
      "wallets.linked":           3,
      "history.days":             30,
      "alerts.rules":             10,
      "alerts.channels":          2,    // 1 email + 1 telegram
      "ai.explain.day":           20,
      "simulator.runs.day":       10,
      "bulk_api.requests.day":    0,
      "watchlist.size":           50,
    },
  },
  plus: {
    label: "Plus",
    price_usd_month: 49,
    limits: {
      "wallets.linked":           10,
      "history.days":             365,
      "alerts.rules":             100,
      "alerts.channels":          10,
      "ai.explain.day":           200,
      "simulator.runs.day":       100,
      "bulk_api.requests.day":    100,
      "watchlist.size":           500,
    },
  },
  enterprise: {
    label: "Enterprise",
    price_usd_month: null, // custom
    limits: {
      "wallets.linked":           100000,
      "history.days":             36500,
      "alerts.rules":             100000,
      "alerts.channels":          100000,
      "ai.explain.day":           100000,
      "simulator.runs.day":       100000,
      "bulk_api.requests.day":    1000000,
      "watchlist.size":           100000,
    },
  },
};

export function tierAllows(tier, limitKey, value) {
  const t = TIERS[tier] || TIERS.free;
  const cap = t.limits[limitKey];
  if (cap == null) return true;
  return value <= cap;
}

export function tierLimit(tier, limitKey) {
  const t = TIERS[tier] || TIERS.free;
  return t.limits[limitKey] ?? 0;
}

/* ---------- subscription lookup ---------- */

export async function getSubscription(env, userId) {
  if (!env.HEALTH_DB || !userId) return { tier: "free", status: "active" };
  const row = await env.HEALTH_DB
    .prepare("SELECT tier, status, current_period_end, cancel_at_period_end FROM subscriptions WHERE user_id = ?")
    .bind(userId).first();
  if (!row) return { tier: "free", status: "active" };

  // Downgrade past_due/canceled subscriptions to free for entitlement purposes
  // (we keep the row so Stripe webhook history stays consistent).
  if (row.status === "canceled") return { tier: "free", status: row.status };
  if (row.status === "past_due" && row.current_period_end && row.current_period_end < Date.now()) {
    return { tier: "free", status: row.status };
  }
  return row;
}

/**
 * requireTier(minTier) — returns a middleware function that enforces a
 * minimum subscription tier. Pairs with requireSession from auth.js:
 *
 *   const auth = await requireSession(request, env);
 *   if (auth instanceof Response) return auth;
 *   const sub = await requireTier(auth.user.id, "pro", env);
 *   if (sub instanceof Response) return sub;
 */
export async function requireTier(userId, minTier, env) {
  const sub = await getSubscription(env, userId);
  if ((TIER_RANK[sub.tier] ?? 0) < (TIER_RANK[minTier] ?? 0)) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "upgrade_required",
        current_tier: sub.tier,
        required_tier: minTier,
        upgrade_url: "/pricing/",
      }),
      { status: 402, headers: { "content-type": "application/json" } },
    );
  }
  return sub;
}

/* ---------- quota tracking ----------
 *
 * Quota windows are *rolling*, not calendar-aligned: a window starts the
 * first time a user consumes the quota in this period and ends exactly
 * windowMs later. Calendar alignment (UTC midnight, 1st-of-month) would
 * be friendlier in usage dashboards but would also let a user burst at
 * 23:59 and again at 00:01 for 2× their stated limit. We trade a small
 * UI quirk ("resets in 7h") for a hard, predictable cap.
 *
 * `month` is 30 days, not "calendar month", for the same reason — every
 * row in tier_quotas resets exactly windowMs after its own start.
 */

const WINDOW_MS = {
  day:   24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

function windowFor(quotaKey) {
  if (quotaKey.endsWith(".day")) return "day";
  if (quotaKey.endsWith(".month")) return "month";
  return "month";
}

/**
 * Atomically check-and-increment a per-user quota counter. Returns
 * { ok: true, used, limit } or { ok: false, used, limit, retry_at }.
 */
export async function consumeQuota(env, userId, tier, quotaKey, amount = 1) {
  const limit = tierLimit(tier, quotaKey);
  if (limit === 0) return { ok: false, used: 0, limit: 0, retry_at: null };

  const now = Date.now();
  const windowMs = WINDOW_MS[windowFor(quotaKey)];

  const row = await env.HEALTH_DB.prepare(
    "SELECT used, window_end FROM tier_quotas WHERE user_id = ? AND quota_key = ?"
  ).bind(userId, quotaKey).first();

  let used = 0;
  let windowEnd = now + windowMs;
  if (row) {
    if (row.window_end > now) {
      used = row.used;
      windowEnd = row.window_end;
    } // else: window expired, reset
  }

  if (used + amount > limit) {
    return { ok: false, used, limit, retry_at: windowEnd };
  }

  const newUsed = used + amount;
  await env.HEALTH_DB.prepare(
    `INSERT INTO tier_quotas (user_id, quota_key, used, window_start, window_end)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, quota_key) DO UPDATE SET
       used = excluded.used,
       window_start = CASE WHEN tier_quotas.window_end <= excluded.window_start
                            THEN excluded.window_start ELSE tier_quotas.window_start END,
       window_end   = CASE WHEN tier_quotas.window_end <= excluded.window_start
                            THEN excluded.window_end ELSE tier_quotas.window_end END`
  ).bind(userId, quotaKey, newUsed, now, windowEnd).run();

  return { ok: true, used: newUsed, limit, retry_at: windowEnd };
}

export function tiersPublicCatalog() {
  return Object.entries(TIERS).map(([key, t]) => ({
    key,
    label: t.label,
    price_usd_month: t.price_usd_month,
    limits: t.limits,
  }));
}
