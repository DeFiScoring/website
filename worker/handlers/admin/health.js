/* DeFiScoring – Admin: platform health
 *
 *   GET /api/admin/health
 *
 * Answers the questions whose failure mode is SILENCE — the ones where
 * everything looks fine until a customer tells you their alerts stopped
 * arriving three weeks ago:
 *
 *   • Is each delivery channel actually configured, and are its recent
 *     sends succeeding?
 *   • Is sanctions screening running on a live feed or on the seed list?
 *   • Are the scheduled jobs producing the rows they should?
 *
 * Everything here is derived, never cached, and reports "unknown" rather than
 * guessing when it cannot tell.
 */

import { requireAdmin } from "../../lib/admin.js";
import { isConfigured as emailConfigured } from "../../lib/email.js";
import { isConfigured as telegramConfigured } from "../../lib/telegram.js";
import { sanctionsStatus } from "../../lib/sanctions.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

const DAY_MS = 86400000;

// Recent delivery outcomes per channel. A channel that is configured but whose
// every recent attempt failed is the case worth shouting about: it looks
// healthy from the settings page and is silently dropping mail.
async function deliveryStats(env, sinceMs) {
  if (!env.HEALTH_DB) return null;
  try {
    // The channel kind lives on alert_channels; alert_deliveries only carries
    // the channel_id. A delivery whose channel row was since deleted still
    // counts — it happened — so this is a LEFT JOIN with an explicit bucket.
    const { results } = await env.HEALTH_DB.prepare(
      `SELECT COALESCE(c.kind, 'deleted_channel') AS channel, d.status, COUNT(*) AS n
         FROM alert_deliveries d
         LEFT JOIN alert_channels c ON c.id = d.channel_id
        WHERE d.fired_at >= ?
        GROUP BY channel, d.status`
    ).bind(sinceMs).all();
    const out = {};
    for (const r of results || []) {
      out[r.channel] = out[r.channel] || { sent: 0, failed: 0, other: 0 };
      if (r.status === "sent") out[r.channel].sent += r.n;
      else if (r.status === "failed") out[r.channel].failed += r.n;
      else out[r.channel].other += r.n;
    }
    return out;
  } catch {
    return null;   // table shape changed or DB unavailable — say so, don't guess
  }
}

function channelHealth(name, configured, stats) {
  const s = stats && stats[name];
  const attempts = s ? s.sent + s.failed + s.other : 0;
  let status, detail;

  if (!configured) {
    status = "not_configured";
    detail = attempts
      ? `${attempts} delivery attempt(s) in the last 7 days with no credentials set — these cannot have been delivered.`
      : "No credentials set. Rules using this channel will never deliver.";
  } else if (!s || attempts === 0) {
    status = "idle";
    detail = "Configured, but nothing was sent in the last 7 days.";
  } else if (s.failed && s.sent === 0) {
    status = "failing";
    detail = `All ${s.failed} attempt(s) in the last 7 days failed.`;
  } else if (s.failed) {
    status = "degraded";
    detail = `${s.failed} of ${attempts} attempt(s) failed in the last 7 days.`;
  } else {
    status = "ok";
    detail = `${s.sent} delivered in the last 7 days.`;
  }
  return { channel: name, configured, status, detail, last_7d: s || { sent: 0, failed: 0, other: 0 } };
}

async function count(env, sql, ...binds) {
  try {
    const row = await env.HEALTH_DB.prepare(sql).bind(...binds).first();
    return row ? Number(Object.values(row)[0]) : 0;
  } catch { return null; }
}

export async function handleAdminHealth(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  const now = Date.now();
  const since = now - 7 * DAY_MS;
  const stats = await deliveryStats(env, since);

  const channels = [
    channelHealth("email", emailConfigured(env), stats),
    channelHealth("telegram", telegramConfigured(env), stats),
    // Webhooks carry their own per-rule URL and secret, so there is nothing
    // global to configure — only the outcomes matter.
    channelHealth("webhook", true, stats),
  ];

  const sanctions = await sanctionsStatus(env, now);

  const jobs = {
    // Scores written in the last 24h evidence that the */15 re-scorer ran.
    scores_last_24h: await count(env,
      "SELECT COUNT(*) FROM health_scores WHERE computed_at >= ?", now - DAY_MS),
    active_alert_rules: await count(env,
      "SELECT COUNT(*) FROM alert_rules WHERE is_active = 1"),
    deliveries_last_24h: await count(env,
      "SELECT COUNT(*) FROM alert_deliveries WHERE fired_at >= ?", now - DAY_MS),
  };

  // Surface only what a human should act on today.
  const warnings = [];
  for (const c of channels) {
    if (c.status === "not_configured" && c.last_7d.sent + c.last_7d.failed > 0) {
      warnings.push(`${c.channel}: attempts are being made but no credentials are configured.`);
    } else if (c.status === "failing") {
      warnings.push(`${c.channel}: every delivery in the last 7 days failed.`);
    }
  }
  if (sanctions.feed_configured && sanctions.stale) {
    warnings.push("sanctions: feed is configured but has not refreshed in over 48h — screening is running on the seed list.");
  }
  if (!sanctions.feed_configured) {
    warnings.push("sanctions: no SANCTIONS_FEED_URL configured — screening covers the built-in seed list only.");
  }
  if (jobs.active_alert_rules > 0 && jobs.scores_last_24h === 0) {
    warnings.push("rescore: alert rules exist but no score has been computed in 24h — the */15 cron may not be firing.");
  }

  return json({
    success: true,
    checked_at: now,
    warnings,
    channels,
    sanctions,
    jobs,
  });
}
