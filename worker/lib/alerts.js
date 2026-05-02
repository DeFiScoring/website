/* DeFiScoring – Alerts evaluation engine
 *
 * Pure functions that decide whether a given rule should fire given the
 * current on-chain state for the watched wallet. Side-effecting work
 * (fetching state, sending notifications, writing to D1) lives in the
 * cron handler — keeping this file pure makes it trivially testable.
 *
 * Rule shape (from D1 alert_rules):
 *   {
 *     id, user_id, wallet_address,
 *     kind: 'health_factor' | 'price' | 'score_change' | 'approval_change' | 'liquidation_risk' | 'protocol_event',
 *     params: { ... kind-specific ... },   // parsed from params_json
 *     channels: ['email', 'telegram'],
 *     cooldown_secs, last_fired_at, last_value
 *   }
 *
 * State shape (built by cron handler from existing handlers):
 *   {
 *     score: { value, breakdown },              // from /api/wallet-score
 *     health: { healthFactor, ... },            // from existing /api/health-score
 *     prices: { 'ethereum:0xa0b8...': 1.001 },  // from price oracle
 *     approvals: [{ token, spender, amount }],  // from approval scanner (T8, may be empty)
 *   }
 */

const PARAM_DEFAULTS = {
  health_factor:    { threshold: 1.5,  direction: "below" },
  price:            { token: null, chain: "ethereum", threshold: null, direction: "below" },
  score_change:     { delta: 50, direction: "either" },
  approval_change:  { ignore_known_safe: true },
  liquidation_risk: { threshold: 1.1 },
  protocol_event:   { protocol: null, severity: "high" },
};

/**
 * Evaluate a single rule. Returns:
 *   { fire: boolean, reason: string, snapshot: any }
 *
 * `snapshot` is a small JSON object describing what triggered the rule;
 * it's stored as `last_value` and embedded in delivery payloads.
 */
export function evaluateRule(rule, state) {
  const params = { ...(PARAM_DEFAULTS[rule.kind] || {}), ...(rule.params || {}) };
  const previous = safeParseJson(rule.last_value) || {};

  switch (rule.kind) {
    case "health_factor":     return evalHealthFactor(params, state, previous);
    case "price":             return evalPrice(params, state, previous);
    case "score_change":      return evalScoreChange(params, state, previous);
    case "approval_change":   return evalApprovalChange(params, state, previous);
    case "liquidation_risk":  return evalLiquidationRisk(params, state);
    case "protocol_event":    return evalProtocolEvent(params, state);
    default:                  return { fire: false, reason: "unknown_rule_kind", snapshot: null };
  }
}

/* ---------- per-kind evaluators ---------- */

function evalHealthFactor(params, state, previous) {
  const hf = state?.health?.healthFactor;
  if (hf == null || !Number.isFinite(hf)) return notReady("missing_health_factor");

  const crossed = params.direction === "above"
    ? hf > params.threshold
    : hf < params.threshold;

  // Edge-trigger: only fire when we cross the threshold, not while we sit on
  // the wrong side of it.
  if (!crossed) return { fire: false, reason: "below_or_above_threshold_no_cross", snapshot: { hf } };

  const previousHf = previous?.hf;
  if (previousHf != null) {
    const wasCrossed = params.direction === "above"
      ? previousHf > params.threshold
      : previousHf < params.threshold;
    if (wasCrossed) return { fire: false, reason: "still_on_wrong_side", snapshot: { hf } };
  }

  return {
    fire: true,
    reason: `health_factor_${params.direction}_${params.threshold}`,
    snapshot: { hf, threshold: params.threshold, direction: params.direction },
  };
}

function evalPrice(params, state, previous) {
  const key = `${params.chain}:${(params.token || "").toLowerCase()}`;
  const price = state?.prices?.[key];
  if (price == null) return notReady("missing_price");

  const crossed = params.direction === "above"
    ? price > params.threshold
    : price < params.threshold;
  if (!crossed) return { fire: false, reason: "no_cross", snapshot: { price } };

  const previousPrice = previous?.price;
  if (previousPrice != null) {
    const wasCrossed = params.direction === "above"
      ? previousPrice > params.threshold
      : previousPrice < params.threshold;
    if (wasCrossed) return { fire: false, reason: "still_on_wrong_side", snapshot: { price } };
  }

  return {
    fire: true,
    reason: `price_${params.direction}_${params.threshold}`,
    snapshot: { price, threshold: params.threshold, direction: params.direction, token: params.token },
  };
}

function evalScoreChange(params, state, previous) {
  const score = state?.score?.value;
  if (score == null) return notReady("missing_score");
  const previousScore = previous?.score;
  if (previousScore == null) {
    // Bootstrap — record current value but don't fire.
    return { fire: false, reason: "bootstrap", snapshot: { score } };
  }
  const delta = score - previousScore;
  if (Math.abs(delta) < params.delta) return { fire: false, reason: "below_delta", snapshot: { score, delta } };
  if (params.direction === "down" && delta >= 0) return { fire: false, reason: "wrong_direction", snapshot: { score, delta } };
  if (params.direction === "up"   && delta <= 0) return { fire: false, reason: "wrong_direction", snapshot: { score, delta } };
  return {
    fire: true,
    reason: `score_changed_by_${delta}`,
    snapshot: { score, previous: previousScore, delta },
  };
}

function evalApprovalChange(params, state, previous) {
  const current = state?.approvals || [];
  if (!Array.isArray(current)) return notReady("missing_approvals");

  const fingerprint = (a) => `${a.chain || "ethereum"}:${(a.token || "").toLowerCase()}:${(a.spender || "").toLowerCase()}`;
  const currentSet = new Set(current.map(fingerprint));
  const previousSet = new Set((previous?.approvals || []).map(fingerprint));

  const added = current.filter((a) => !previousSet.has(fingerprint(a)));
  if (!added.length) {
    return { fire: false, reason: "no_new_approvals", snapshot: { approvals: current.map(fingerprint) } };
  }
  // Filter unlimited / risky-spender additions. The scanner (T8) tags these
  // with `risk: 'high' | 'medium' | 'low'`; we surface high+medium by default.
  const noteworthy = added.filter((a) => !params.ignore_known_safe || a.risk !== "low");
  if (!noteworthy.length) {
    return { fire: false, reason: "all_added_are_safe", snapshot: { approvals: current.map(fingerprint) } };
  }
  return {
    fire: true,
    reason: `${noteworthy.length}_new_approval(s)`,
    snapshot: { approvals: current.map(fingerprint), new: noteworthy },
  };
}

function evalLiquidationRisk(params, state) {
  const hf = state?.health?.healthFactor;
  if (hf == null) return notReady("missing_health_factor");
  if (hf >= params.threshold) return { fire: false, reason: "safe", snapshot: { hf } };
  return {
    fire: true,
    reason: `liquidation_risk_hf_${hf.toFixed(3)}`,
    snapshot: { hf, threshold: params.threshold },
  };
}

function evalProtocolEvent(params, state) {
  const events = state?.protocol_events || [];
  const matching = events.filter((e) =>
    (!params.protocol || e.protocol === params.protocol) &&
    (severityRank(e.severity || "low") >= severityRank(params.severity)),
  );
  if (!matching.length) return { fire: false, reason: "no_event", snapshot: null };
  return {
    fire: true,
    reason: `protocol_event_${matching[0].kind || "unknown"}`,
    snapshot: { events: matching.slice(0, 5) },
  };
}

function severityRank(s) {
  return { low: 1, medium: 2, high: 3, critical: 4 }[s] || 0;
}
function notReady(reason) {
  return { fire: false, reason: `not_ready:${reason}`, snapshot: null };
}
function safeParseJson(s) { try { return JSON.parse(s); } catch { return null; } }

/* ---------- delivery payload formatters ---------- */

export function formatAlertHtml(rule, evaluation) {
  const wallet = rule.wallet_address;
  const short = `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
  const title = titleFor(rule.kind);
  const lines = [];
  lines.push(`<h2 style="margin:0 0 8px;color:#0a0a0a;font-family:Inter,sans-serif">${title}</h2>`);
  lines.push(`<p style="margin:0 0 16px;color:#444;font-family:Inter,sans-serif">Wallet <code>${short}</code> just triggered an alert.</p>`);
  lines.push(`<pre style="background:#0a0a0a;color:#00f5ff;padding:12px;border-radius:6px;font-family:JetBrains Mono,monospace;font-size:12px;overflow:auto">${escapeHtml(JSON.stringify(evaluation.snapshot, null, 2))}</pre>`);
  lines.push(`<p style="margin:16px 0 0;font-family:Inter,sans-serif"><a href="https://defiscoring.com/dashboard/?wallet=${wallet}" style="color:#a855f7">Open dashboard →</a></p>`);
  return lines.join("\n");
}

export function formatAlertText(rule, evaluation) {
  const wallet = rule.wallet_address;
  const short = `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
  return [
    titleFor(rule.kind),
    `Wallet ${short} just triggered an alert.`,
    "",
    JSON.stringify(evaluation.snapshot, null, 2),
    "",
    `https://defiscoring.com/dashboard/?wallet=${wallet}`,
  ].join("\n");
}

export function formatAlertTelegram(rule, evaluation) {
  const wallet = rule.wallet_address;
  const short = `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
  return [
    `<b>${escapeHtml(titleFor(rule.kind))}</b>`,
    `Wallet <code>${escapeHtml(short)}</code> triggered an alert.`,
    `<pre>${escapeHtml(JSON.stringify(evaluation.snapshot, null, 2))}</pre>`,
    `<a href="https://defiscoring.com/dashboard/?wallet=${wallet}">Open dashboard</a>`,
  ].join("\n");
}

function titleFor(kind) {
  return {
    health_factor:    "Health Factor alert",
    price:            "Price alert",
    score_change:     "Score change alert",
    approval_change:  "New token approval",
    liquidation_risk: "⚠ Liquidation risk",
    protocol_event:   "Protocol event",
  }[kind] || "DeFi Scoring alert";
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
