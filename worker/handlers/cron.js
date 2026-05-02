/* DeFiScoring – Scheduled cron: alert scanner + retention prune dispatcher
 *
 * Wired from worker/index.js scheduled() handler. Runs on the cron
 * triggers configured in wrangler.jsonc.
 *
 *   • Every 5 minutes: scanAlertRules() — evaluate all active rules,
 *     dispatch deliveries via email/telegram, write audit rows.
 *   • Daily 03:17 UTC: handled by the existing runRetentionPrune() in
 *     worker/index.js (we leave that one alone).
 *
 * Per-cron isolation: a single failing rule must not block the rest. We
 * catch and log per-rule errors and continue.
 */

import { evaluateRule, formatAlertHtml, formatAlertText, formatAlertTelegram } from "../lib/alerts.js";
import { send as sendEmail, isConfigured as emailConfigured } from "../lib/email.js";
import { send as sendTelegram, isConfigured as telegramConfigured } from "../lib/telegram.js";
import { newId } from "../lib/auth.js";

const RULE_BATCH = 100;          // process up to 100 rules per scan
const MAX_RULES_PER_RUN = 1000;  // hard cap to bound CPU per cron tick

/**
 * Entry point for the 5-minute alerts cron.
 */
export async function scanAlertRules(env, ctx) {
  if (!env.HEALTH_DB) return { ok: false, error: "db_unavailable" };

  let processed = 0;
  let fired = 0;
  let cursor = 0;

  while (processed < MAX_RULES_PER_RUN) {
    const { results } = await env.HEALTH_DB.prepare(
      `SELECT id, user_id, wallet_address, kind, params_json, channels_json,
              cooldown_secs, last_fired_at, last_value
       FROM alert_rules WHERE is_active = 1 AND id > ?
       ORDER BY id ASC LIMIT ?`
    ).bind(String(cursor), RULE_BATCH).all();

    const rows = results || [];
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;

    // Group by wallet to amortize state-fetch cost
    const byWallet = new Map();
    for (const r of rows) {
      const list = byWallet.get(r.wallet_address) || [];
      list.push(r);
      byWallet.set(r.wallet_address, list);
    }

    for (const [wallet, walletRules] of byWallet) {
      let state;
      try {
        state = await fetchWalletState(env, wallet);
      } catch (e) {
        // can't fetch state — skip this wallet's rules this tick
        console.warn(`[cron] state fetch failed for ${wallet}:`, e.message);
        continue;
      }
      for (const row of walletRules) {
        processed++;
        try {
          const rule = {
            ...row,
            params:    safeJson(row.params_json) || {},
            channels:  safeJson(row.channels_json) || [],
            last_value: row.last_value,
          };
          const evalRes = evaluateRule(rule, state);
          // Always update last_value so next tick has reference
          await env.HEALTH_DB.prepare(
            "UPDATE alert_rules SET last_value = ?, updated_at = ? WHERE id = ?"
          ).bind(JSON.stringify(evalRes.snapshot || null), Date.now(), row.id).run().catch(() => {});

          if (!evalRes.fire) continue;

          // Cooldown
          const now = Date.now();
          if (row.last_fired_at && now - row.last_fired_at < (row.cooldown_secs || 3600) * 1000) {
            continue;
          }

          fired++;
          await dispatchRule(env, rule, evalRes);

          await env.HEALTH_DB.prepare(
            "UPDATE alert_rules SET last_fired_at = ? WHERE id = ?"
          ).bind(now, row.id).run().catch(() => {});
        } catch (e) {
          console.warn(`[cron] rule ${row.id} failed:`, e.message);
        }
      }
    }

    if (rows.length < RULE_BATCH) break;
  }

  return { ok: true, processed, fired };
}

/* ---------- per-rule dispatch ---------- */

async function dispatchRule(env, rule, evalRes) {
  // Load this user's verified channels matching the rule's channel kinds
  const placeholders = rule.channels.map(() => "?").join(",");
  const { results } = await env.HEALTH_DB.prepare(
    `SELECT id, kind, destination FROM alert_channels
     WHERE user_id = ? AND is_verified = 1 AND kind IN (${placeholders})`
  ).bind(rule.user_id, ...rule.channels).all();

  if (!results || !results.length) {
    // No verified channel — record a suppressed delivery for audit
    await logDelivery(env, rule, null, "suppressed", evalRes, "no_verified_channel");
    return;
  }

  const html  = formatAlertHtml(rule, evalRes);
  const text  = formatAlertText(rule, evalRes);
  const tgMsg = formatAlertTelegram(rule, evalRes);
  const subject = `[DeFi Scoring] ${rule.kind.replace(/_/g, " ")} for ${rule.wallet_address.slice(0, 8)}…`;

  for (const ch of results) {
    let delivery;
    let deliveryId = null;
    try {
      if (ch.kind === "email") {
        if (!emailConfigured(env)) {
          await logDelivery(env, rule, ch, "failed", evalRes, "email_not_configured");
          continue;
        }
        // Audit-first: write a 'pending' row BEFORE the network call so a
        // worker timeout / crash mid-send still leaves a recoverable trail.
        deliveryId = await startDelivery(env, rule, ch, evalRes);
        delivery = await sendEmail(env, { to: ch.destination, subject, html, text });
      } else if (ch.kind === "telegram") {
        if (!telegramConfigured(env)) {
          await logDelivery(env, rule, ch, "failed", evalRes, "telegram_not_configured");
          continue;
        }
        deliveryId = await startDelivery(env, rule, ch, evalRes);
        delivery = await sendTelegram(env, { chatId: ch.destination, text: tgMsg });
      } else {
        continue;
      }
      // Status determined by the actual delivery result. The crash-safe
      // path (see startDelivery) wrote a "pending" row first, so even an
      // exception below leaves an auditable trail.
      await finishDelivery(env, deliveryId, delivery.ok ? "sent" : "failed", delivery.error || null);
    } catch (e) {
      // Promote whatever pending row we have to "failed" with the error.
      if (deliveryId) await finishDelivery(env, deliveryId, "failed", e.message);
      else await logDeliveryDirect(env, rule, ch, "failed", evalRes, e.message);
    }
  }
}

/**
 * Pre-write a "pending" audit row BEFORE making the network call, so an
 * uncaught exception or worker timeout still leaves a record we can
 * reconcile or expose in the user-facing "recent triggers" view. Returns
 * the delivery row id (or null if D1 is unavailable; caller then degrades
 * to fire-and-log at the end).
 */
async function startDelivery(env, rule, channel, evalRes) {
  if (!env.HEALTH_DB) return null;
  const id = newId();
  const now = Date.now();
  try {
    await env.HEALTH_DB.prepare(
      `INSERT INTO alert_deliveries
         (id, rule_id, channel_id, user_id, fired_at, status, payload_json, error_message, delivered_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL)`
    ).bind(
      id, rule.id, channel?.id || "none", rule.user_id, now,
      JSON.stringify({ kind: rule.kind, reason: evalRes.reason, snapshot: evalRes.snapshot }),
    ).run();
    return id;
  } catch (e) {
    console.warn("[cron] startDelivery failed:", e.message);
    return null;
  }
}

async function finishDelivery(env, id, status, error) {
  if (!env.HEALTH_DB || !id) return;
  const now = Date.now();
  try {
    await env.HEALTH_DB.prepare(
      `UPDATE alert_deliveries SET status = ?, error_message = ?, delivered_at = ? WHERE id = ?`
    ).bind(status, error || null, status === "sent" ? now : null, id).run();
  } catch (e) {
    console.warn("[cron] finishDelivery failed:", e.message);
  }
}

// Last-resort write when we never managed to insert a pending row (e.g.
// D1 unavailable on the way in). Used only by the catch path.
async function logDeliveryDirect(env, rule, channel, status, evalRes, error) {
  const id = newId();
  const now = Date.now();
  try {
    await env.HEALTH_DB.prepare(
      `INSERT INTO alert_deliveries
         (id, rule_id, channel_id, user_id, fired_at, status, payload_json, error_message, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, rule.id, channel?.id || "none", rule.user_id, now, status,
      JSON.stringify({ kind: rule.kind, reason: evalRes.reason, snapshot: evalRes.snapshot }),
      error || null,
      status === "sent" ? now : null,
    ).run();
  } catch (e) {
    console.warn("[cron] logDeliveryDirect failed:", e.message);
  }
}

// Backwards-compat shim — older code paths in this file still call
// logDelivery() for non-send branches (e.g. "channel not configured").
async function logDelivery(env, rule, channel, status, evalRes, error) {
  return logDeliveryDirect(env, rule, channel, status, evalRes, error);
}

/* ---------- state assembly ----------
 *
 * Pulls the bits each evaluator might need. We keep this conservative for
 * now: HF + score from D1, and an empty stub for prices/approvals. T8 will
 * populate approvals; the price feed is straightforward to add when
 * price-rule users exist.
 */
async function fetchWalletState(env, wallet) {
  const state = { score: null, health: null, prices: {}, approvals: [], protocol_events: [] };

  // Last persisted health score row
  const row = await env.HEALTH_DB.prepare(
    `SELECT score, source_json FROM health_scores
     WHERE wallet = ? ORDER BY computed_at DESC LIMIT 1`
  ).bind(wallet.toLowerCase()).first();
  if (row) {
    state.score = { value: row.score };
    const src = safeJson(row.source_json) || {};
    if (src.health_factor != null) state.health = { healthFactor: Number(src.health_factor) };
    else if (src.healthFactor != null) state.health = { healthFactor: Number(src.healthFactor) };
  }
  return state;
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }
