/* DeFiScoring – AI score explanation
 *
 *   GET /api/score-explanation?wallet=0x…   (signed-in users)
 *
 * Turns the latest persisted score into 3–4 plain-English sentences using
 * the Workers AI binding. The model is a *narrator, not a scorer*: it is
 * fed only the real persisted numbers and pillar rationales, instructed to
 * restate rather than extrapolate, and its output is cached per (wallet,
 * scan, model version) so a scan costs at most one inference no matter how
 * often the page is opened.
 *
 * Reads the persisted row rather than recomputing: an explanation that
 * silently triggered a full multi-chain rescan would make the score page
 * an order of magnitude more expensive to open. No row -> no_score_yet,
 * never an explanation of a score that doesn't exist.
 */

import { requireSession } from "../lib/auth.js";

const AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const CACHE_TTL = 7 * 24 * 3600;
const MAX_EXPLANATION_CHARS = 900;

const PILLAR_LABELS = {
  loan_reliability:    "Loan reliability (35%)",
  portfolio_health:    "Portfolio health (25%)",
  liquidity_provision: "Liquidity provision (15%)",
  governance:          "Governance participation (10%)",
  account_age:         "Account age (15%)",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json" },
  });
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

/**
 * Deterministic prompt from persisted data only. Rows written before pillar
 * summaries were persisted fall back to the numeric pillar columns — a
 * thinner narrative, but still one made entirely of real numbers.
 */
export function buildExplanationPrompt(row, src) {
  const lines = [];
  lines.push(`Score: ${row.score} out of 850 (band: ${src?.score_band || "unknown"}).`);
  if (typeof src?.coverage === "number") {
    lines.push(`Data coverage: ${Math.round(src.coverage * 100)}% of the score's weight is backed by observed on-chain data; the rest fell back to neutral defaults.`);
  }
  const pillars = src?.pillars || null;
  for (const [key, label] of Object.entries(PILLAR_LABELS)) {
    const p = pillars?.[key];
    if (p) {
      const flag = p.real ? "" : " [no data found — neutral default]";
      lines.push(`${label}: ${p.value}/100${flag}${p.rationale ? ` — ${p.rationale}` : ""}`);
    } else if (row[key] != null) {
      lines.push(`${label}: ${row[key]}/100`);
    }
  }
  for (const a of src?.adjustments || []) {
    if (a && typeof a === "object") lines.push(`Adjustment: ${a.delta > 0 ? "+" : ""}${a.delta} (${a.reason || a.name}).`);
  }
  return lines.join("\n");
}

export async function handleScoreExplanation(request, env) {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;

  if (!env.AI) return json({ success: false, error: "ai_unavailable" }, 503);
  if (!env.HEALTH_DB) return json({ success: false, error: "db_unavailable" }, 503);

  const url = new URL(request.url);
  const wallet = (url.searchParams.get("wallet") || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) {
    return json({ success: false, error: "invalid_wallet_address" }, 400);
  }

  const row = await env.HEALTH_DB.prepare(
    `SELECT score, loan_reliability, liquidity_provision, governance, account_age,
            source_json, computed_at
     FROM health_scores WHERE wallet = ? ORDER BY computed_at DESC LIMIT 1`
  ).bind(wallet).first();
  if (!row || !Number.isFinite(row.score)) {
    return json({ success: false, error: "no_score_yet" }, 404);
  }

  const src = safeJson(row.source_json) || {};
  const cacheKey = `explain:v1:${wallet}:${row.computed_at}:${src.model || "unversioned"}`;
  if (env.DEFI_CACHE) {
    const hit = await env.DEFI_CACHE.get(cacheKey).catch(() => null);
    if (hit) {
      return json({
        success: true, explanation: hit, cached: true,
        based_on: { score: row.score, computed_at: row.computed_at, model: src.model || null, coverage: src.coverage ?? null },
      });
    }
  }

  const facts = buildExplanationPrompt(row, src);
  let aiResponse;
  try {
    aiResponse = await env.AI.run(AI_MODEL, {
      messages: [
        {
          role: "system",
          content:
            "You explain a DeFi wallet credit score to its owner in plain English. " +
            "Write 3-4 short sentences. Use ONLY the facts provided — never invent, " +
            "estimate, or extrapolate numbers, and repeat at most two of the given " +
            "numbers. Where a pillar says 'no data found — neutral default', say the " +
            "score does not reflect that activity rather than implying the wallet " +
            "performed badly at it. No greetings, no advice, no disclaimers.",
        },
        { role: "user", content: facts },
      ],
      max_tokens: 256,
    });
  } catch (e) {
    return json({ success: false, error: "ai_failed", detail: String((e && e.message) || e) }, 502);
  }

  const explanation = String(aiResponse?.response || "").trim().slice(0, MAX_EXPLANATION_CHARS);
  if (!explanation) return json({ success: false, error: "ai_failed", detail: "empty response" }, 502);

  if (env.DEFI_CACHE) {
    await env.DEFI_CACHE.put(cacheKey, explanation, { expirationTtl: CACHE_TTL }).catch(() => {});
  }
  return json({
    success: true, explanation, cached: false,
    based_on: { score: row.score, computed_at: row.computed_at, model: src.model || null, coverage: src.coverage ?? null },
  });
}
