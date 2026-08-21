/* DeFiScoring – Scheduled cron: alert scanner + retention prune dispatcher
 *
 * Wired from worker/index.js scheduled() handler. Runs on the cron
 * triggers configured in wrangler.jsonc.
 *
 *   • Every 5 minutes: scanAlertRules() — evaluate all active rules,
 *     dispatch deliveries via email/telegram/webhook, write audit rows.
 *   • Daily 03:17 UTC: handled by the existing runRetentionPrune() in
 *     worker/index.js (we leave that one alone).
 *
 * Per-cron isolation: a single failing rule must not block the rest. We
 * catch and log per-rule errors and continue.
 */

import {
  evaluateRule, formatAlertHtml, formatAlertText, formatAlertTelegram, formatAlertWebhook,
} from "../lib/alerts.js";
import { CHAINS, CHAINS_BY_ID } from "../lib/chains.js";
import { AAVE_V3_POOLS } from "../lib/defi-protocols.js";
import { ethCall, abiEncodeSingleAddr, abiHexWord, getLatestBlockNumber } from "../lib/providers.js";
import { getCompoundV3Positions } from "../lib/defi.js";
import { priceTokensWithFallback } from "../lib/prices.js";
import { scanApprovalLogs } from "../lib/approvals.js";
import { send as sendEmail, isConfigured as emailConfigured } from "../lib/email.js";
import { send as sendTelegram, isConfigured as telegramConfigured } from "../lib/telegram.js";
import { send as sendWebhook, validateWebhookUrl } from "../lib/webhook.js";
import { newId } from "../lib/auth.js";

const RULE_BATCH = 100;          // process up to 100 rules per scan
const MAX_RULES_PER_RUN = 1000;  // hard cap to bound CPU per cron tick

const TIER1 = CHAINS.filter((c) => c.tier === 1);
const SEL_GET_USER_ACCOUNT_DATA = "0xbf92857c"; // Aave V3 Pool: getUserAccountData(address)

// Where a wallet's lending positions were last seen, so per-tick reads touch
// only those chains instead of sweeping all five. Positions rarely appear on
// a new chain, so 6h between rediscoveries is generous; an empty result gets
// a shorter TTL so a wallet's FIRST borrow is picked up within the hour.
const HF_POS_TTL = 6 * 3600;
const HF_POS_EMPTY_TTL = 3600;

/**
 * Outbound-fetch budget for one cron tick. Workers cap subrequests per
 * invocation (50 on the free plan), and the tick also has to send emails,
 * Telegram messages and webhooks out of the same pool — so live reads get an
 * explicit allowance and everything beyond it degrades to the persisted
 * snapshot rather than starving deliveries. Numbers are estimates per fetch
 * we're about to make, not measurements.
 */
function makeBudget(env) {
  const n = Number(env.ALERT_LIVE_BUDGET);
  return {
    left: Number.isFinite(n) ? n : 30,
    take(cost) {
      if (this.left < cost) return false;
      this.left -= cost;
      return true;
    },
  };
}

/**
 * Entry point for the 5-minute alerts cron.
 */
export async function scanAlertRules(env, ctx) {
  if (!env.HEALTH_DB) return { ok: false, error: "db_unavailable" };

  let processed = 0;
  let fired = 0;
  let cursor = 0;

  // Shared across every wallet in this tick: one fetch budget, one price map
  // (prices are global, not per-wallet), one block-tip cache per chain.
  const shared = { budget: makeBudget(env), prices: {}, blockNums: new Map() };

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

    await prefetchPrices(env, rows, shared);

    // Group by wallet to amortize state-fetch cost
    const byWallet = new Map();
    for (const r of rows) {
      const list = byWallet.get(r.wallet_address) || [];
      list.push(r);
      byWallet.set(r.wallet_address, list);
    }

    for (const [wallet, walletRules] of byWallet) {
      const kinds = new Set(walletRules.map((r) => r.kind));
      let state;
      try {
        state = await fetchWalletState(env, wallet, kinds, shared);
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
    `SELECT id, kind, destination, secret FROM alert_channels
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
      } else if (ch.kind === "webhook") {
        // Re-validate at send time: the row could predate the creation-time
        // guard, and a stored URL is still attacker-supplied input.
        const guard = validateWebhookUrl(ch.destination);
        if (!guard.ok) {
          await logDelivery(env, rule, ch, "failed", evalRes, `unsafe_webhook_url:${guard.error}`);
          continue;
        }
        if (!ch.secret) {
          await logDelivery(env, rule, ch, "failed", evalRes, "webhook_secret_missing");
          continue;
        }
        deliveryId = await startDelivery(env, rule, ch, evalRes);
        delivery = await sendWebhook(env, {
          url: guard.url,
          secret: ch.secret,
          deliveryId,
          payload: formatAlertWebhook(rule, evalRes),
        });
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
 * Pre-write a "queued" audit row BEFORE making the network call, so an
 * uncaught exception or worker timeout still leaves a record we can
 * reconcile or expose in the user-facing "recent triggers" view. Returns
 * the delivery row id (or null if D1 is unavailable; caller then degrades
 * to fire-and-log at the end).
 *
 * The status MUST be one of the four the alert_deliveries CHECK constraint
 * allows ('queued','sent','failed','suppressed'). This previously inserted
 * 'pending', which the constraint rejected — the INSERT threw, was swallowed
 * by the catch below, and every successful send therefore left no audit row
 * at all. 'queued' is the constraint's name for exactly this state.
 */
async function startDelivery(env, rule, channel, evalRes) {
  if (!env.HEALTH_DB) return null;
  const id = newId();
  const now = Date.now();
  try {
    await env.HEALTH_DB.prepare(
      `INSERT INTO alert_deliveries
         (id, rule_id, channel_id, user_id, fired_at, status, payload_json, error_message, delivered_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, NULL, NULL)`
    ).bind(
      // NULL, not a 'none' sentinel — the FK would reject a fabricated id and
      // the row (a suppression, usually) would be lost. See 0011.
      id, rule.id, channel?.id ?? null, rule.user_id, now,
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
      id, rule.id, channel?.id ?? null, rule.user_id, now, status,
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
 * Live-first, snapshot-fallback. The old version read the health factor out
 * of the last persisted health_scores row — but nothing ever wrote a health
 * factor into that row's source_json, so state.health was always null and
 * the health_factor / liquidation_risk kinds could never fire at all. Even
 * had the field existed, a 5-minute cron re-reading the user's last manual
 * scan is not monitoring; positions decay between scans.
 *
 * Now each tick reads the chain directly for the data a wallet's rules
 * actually need, under an explicit fetch budget (see makeBudget). When live
 * data can't be had — budget exhausted, RPC unreachable — the evaluator gets
 * the persisted snapshot if one exists, or nothing, and `not_ready` keeps
 * false alerts from firing. Prices are fetched once per tick and shared;
 * approvals are incremental log scans behind a per-wallet block cursor.
 */

/**
 * Tri-state Aave read: 'position' (with hf, or null hf when no debt),
 * 'none' (chain answered: no position), 'unknown' (couldn't ask). The
 * distinction matters because "no position anywhere" is an observation that
 * should override a stale snapshot, while "couldn't ask" must fall back to
 * it. lib/defi.js's reader collapses the last two, which is fine for
 * scoring (coverage flags carry the doubt) but not for deciding whether a
 * liquidation alert should stay quiet.
 */
async function readAaveHealth(chain, env, wallet) {
  const pool = AAVE_V3_POOLS[chain.id];
  if (!pool) return { status: "none" };
  const r = await ethCall(chain, env, pool, abiEncodeSingleAddr(SEL_GET_USER_ACCOUNT_DATA, wallet));
  if (!r || r === "0x") return { status: "unknown" };
  const collateral = abiHexWord(r, 0);
  const debt = abiHexWord(r, 1);
  if (collateral === 0n && debt === 0n) return { status: "none" };
  if (debt === 0n) return { status: "position", hf: null }; // supplying, nothing at risk
  return { status: "position", hf: Number(abiHexWord(r, 5)) / 1e18 };
}

/**
 * Live lowest health factor across Aave V3 and Compound V3 on the Tier-1
 * chains. Returns { source, healthFactor }:
 *   'live'             — the chain answered; healthFactor may be null
 *                        (positions exist but carry no debt, or none exist)
 *   'unknown'          — nothing answered; caller should use the snapshot
 *   'budget_exhausted' — tick ran out of fetch allowance; ditto
 */
async function liveLendingHealth(env, wallet, budget) {
  const kv = env.DEFI_CACHE;
  const key = `hfpos:v1:${wallet.toLowerCase()}`;
  let cached = null;
  if (kv) {
    const hit = await kv.get(key, "json").catch(() => null);
    if (hit && Array.isArray(hit.positions)) cached = hit.positions;
  }

  const targets = cached
    ? cached
        .map((p) => ({ chain: CHAINS_BY_ID[p.chain], protocol: p.protocol }))
        .filter((t) => t.chain)
    : TIER1.flatMap((chain) => [
        { chain, protocol: "aave-v3" },
        { chain, protocol: "compound-v3" },
      ]);

  // Aave: one eth_call. Comet: supply+borrow, plus collateral reads when
  // borrowing (asset metadata is KV-cached by lib/defi.js).
  const cost = targets.reduce((n, t) => n + (t.protocol === "aave-v3" ? 1 : 4), 0);
  if (!budget.take(cost)) return { source: "budget_exhausted" };

  let lowest = null;
  let sawUnknown = false;
  const found = [];
  for (const t of targets) {
    if (t.protocol === "aave-v3") {
      const a = await readAaveHealth(t.chain, env, wallet);
      if (a.status === "unknown") sawUnknown = true;
      else if (a.status === "position") {
        found.push({ chain: t.chain.id, protocol: "aave-v3" });
        if (a.hf != null) lowest = lowest == null ? a.hf : Math.min(lowest, a.hf);
      }
    } else {
      try {
        const rows = await getCompoundV3Positions(t.chain, env, wallet);
        for (const c of rows) {
          if (!c.hasPosition) continue;
          found.push({ chain: t.chain.id, protocol: "compound-v3" });
          if (typeof c.healthFactor === "number" && Number.isFinite(c.healthFactor)) {
            lowest = lowest == null ? c.healthFactor : Math.min(lowest, c.healthFactor);
          }
        }
      } catch {
        sawUnknown = true;
      }
    }
  }

  // Found nothing AND at least one read failed: we cannot distinguish "no
  // positions" from "couldn't look", so report unknown and cache nothing.
  if (!found.length && sawUnknown) return { source: "unknown" };

  if (!cached && kv) {
    await kv
      .put(key, JSON.stringify({ positions: found }), {
        expirationTtl: found.length ? HF_POS_TTL : HF_POS_EMPTY_TTL,
      })
      .catch(() => {});
  }
  return { source: "live", healthFactor: lowest };
}

/**
 * Resolve prices once per rule batch for every (chain, token) named by a
 * price rule. Global by nature — two wallets watching the same token share
 * one lookup — and the price lib's own 60s KV cache absorbs the 5-minute
 * cron cadence.
 */
async function prefetchPrices(env, rows, shared) {
  const byChain = new Map();
  for (const r of rows) {
    if (r.kind !== "price") continue;
    const p = safeJson(r.params_json) || {};
    const chainId = p.chain || "ethereum";
    const token = String(p.token || "").toLowerCase();
    if (!token || !CHAINS_BY_ID[chainId]) continue;
    if (shared.prices[`${chainId}:${token}`] !== undefined) continue;
    const set = byChain.get(chainId) || new Set();
    set.add(token);
    byChain.set(chainId, set);
  }
  for (const [chainId, tokens] of byChain) {
    if (!shared.budget.take(2)) break;
    const chain = CHAINS_BY_ID[chainId];
    const priced = await priceTokensWithFallback(
      chain, env, [...tokens].map((t) => ({ contract: t })), "USD",
    ).catch(() => ({}));
    for (const t of tokens) {
      const v = priced[t] && Number(priced[t].usd);
      if (Number.isFinite(v) && v > 0) shared.prices[`${chainId}:${t}`] = v;
    }
  }
}

/**
 * Approvals granted since the wallet's last scanned block, per Tier-1 chain.
 *
 * The first tick a wallet is seen, the cursor is set to the chain tip and
 * nothing is reported — alerting on the wallet's entire approval history the
 * moment a rule is created would be noise, not news. After that, each tick
 * scans (cursor, tip] and advances the cursor only when the scan succeeded,
 * so a failed scan retries the same range instead of skipping it.
 */
async function fetchNewApprovals(env, wallet, shared) {
  const out = [];
  for (const chain of TIER1) {
    let tip = shared.blockNums.get(chain.id);
    if (tip === undefined) {
      tip = shared.budget.take(1) ? await getLatestBlockNumber(chain, env) : null;
      shared.blockNums.set(chain.id, tip);
    }
    if (!tip) continue;

    const curKey = `apprcur:v1:${chain.id}:${wallet.toLowerCase()}`;
    const cur = env.DEFI_CACHE ? Number(await env.DEFI_CACHE.get(curKey).catch(() => null)) : NaN;
    if (!Number.isFinite(cur) || cur <= 0) {
      if (env.DEFI_CACHE) await env.DEFI_CACHE.put(curKey, String(tip)).catch(() => {});
      continue;
    }
    if (tip <= cur) continue;
    if (!shared.budget.take(1)) continue;

    const res = await scanApprovalLogs(chain, env, wallet, cur + 1, tip);
    if (!res.ok) continue; // keep the cursor; retry this range next tick
    out.push(...res.approvals);
    if (env.DEFI_CACHE) await env.DEFI_CACHE.put(curKey, String(tip)).catch(() => {});
  }
  return out;
}

async function fetchWalletState(env, wallet, kinds, shared) {
  const state = {
    score: null, health: null,
    prices: shared.prices, approvals: [], protocol_events: [],
  };

  // Last persisted score row — score_change compares persisted scans by
  // design, and the row doubles as the health-factor fallback.
  const row = await env.HEALTH_DB.prepare(
    `SELECT score, source_json FROM health_scores
     WHERE wallet = ? ORDER BY computed_at DESC LIMIT 1`
  ).bind(wallet.toLowerCase()).first();
  const src = row ? safeJson(row.source_json) || {} : {};
  if (row) state.score = { value: row.score };

  if (kinds.has("health_factor") || kinds.has("liquidation_risk")) {
    const live = await liveLendingHealth(env, wallet, shared.budget);
    if (live.source === "live") {
      state.health = live.healthFactor != null
        ? { healthFactor: live.healthFactor, source: "live" }
        : null; // no leveraged positions — nothing to alert on, honestly
    } else {
      const snap = src.health_factor ?? src.healthFactor;
      if (snap != null) state.health = { healthFactor: Number(snap), source: "snapshot" };
      console.warn(`[cron] live HF unavailable for ${wallet} (${live.source}); ` +
        (snap != null ? "using persisted snapshot" : "no snapshot either — rules stay quiet"));
    }
  }

  if (kinds.has("approval_change")) {
    state.approvals = await fetchNewApprovals(env, wallet, shared);
  }

  return state;
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }
