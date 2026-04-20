/* DeFi Scoring – profiler.js
 *
 * Provides window.DefiProfiler.profile({ wallet, portfolio, target, target_profile_id })
 * which is what dashboard-risk.js calls when the user clicks "Run risk profile".
 *
 * Two modes:
 *   1. LOCAL  – always runs. Computes alignment score, concentration,
 *               limit-breach checks, and a deterministic textual summary
 *               from the actual portfolio + the chosen target profile.
 *   2. AI     – if window.DEFI_RISK_WORKER_URL is set (e.g. the deployed
 *               Cloudflare Worker URL), the local result is enriched with
 *               an AI-generated summary + 3-5 project recommendations.
 *               If the AI call fails or no URL is set, the local result
 *               is returned with source: "local".
 *
 * Result shape (consumed by dashboard-risk.js):
 *   {
 *     score: 0-100,                       // alignment to target
 *     summary: string,
 *     recommendations: string[],          // bulletable text recs
 *     limit_breaches: string[],
 *     concentration: { [protocolName]: pctOfPortfolio },
 *     class_actual: { [classKey]: pctOfPortfolio },
 *     source: "ai" | "local",
 *   }
 *
 * Configure the AI Worker URL once on the page (or in dashboard.js):
 *   window.DEFI_RISK_WORKER_URL = "https://defiscoring-risk-profiler.<sub>.workers.dev";
 */
(function () {
  function classOf(name) {
    const map = (window.DEFI_PROTOCOL_CLASSES) || {};
    return map[name] || "long_tail";
  }

  function classBreakdown(positions) {
    const total = positions.reduce((s, p) => s + (p.value_usd || 0), 0) || 1;
    const out = {};
    positions.forEach((p) => {
      const c = classOf(p.name);
      out[c] = (out[c] || 0) + (p.value_usd || 0) / total;
    });
    return { breakdown: out, total };
  }

  function concentrationByProtocol(positions) {
    const total = positions.reduce((s, p) => s + (p.value_usd || 0), 0) || 1;
    const out = {};
    positions.forEach((p) => {
      out[p.name] = (out[p.name] || 0) + ((p.value_usd || 0) / total) * 100;
    });
    return out;
  }

  function alignmentScore(actual, target) {
    // 100 - sum of absolute deltas (in pp), capped at 100. Lower drift = higher score.
    const keys = new Set([...Object.keys(actual), ...Object.keys(target)]);
    let drift = 0;
    keys.forEach((k) => { drift += Math.abs((actual[k] || 0) - (target[k] || 0)); });
    // drift is on 0..2 scale (sum of abs diffs of two prob distributions).
    const pct = Math.max(0, Math.min(100, 100 - (drift / 2) * 100));
    return Math.round(pct);
  }

  function checkLimits(actual, concentration, target, longTailPct) {
    const breaches = [];
    if (target.target) {
      const t = target.target;
      if (longTailPct > t.max_long_tail_pct) {
        breaches.push("Long-tail exposure " + longTailPct.toFixed(1) + "% exceeds target max " + t.max_long_tail_pct + "%");
      }
      Object.entries(concentration).forEach(([proto, pct]) => {
        if (pct > t.max_single_protocol_pct) {
          breaches.push(proto + " concentration " + pct.toFixed(1) + "% exceeds target max " + t.max_single_protocol_pct + "%");
        }
      });
    }
    return breaches;
  }

  function localSummary(target, score, breaches, longTailPct) {
    const name = target.name || "selected";
    if (score >= 85) return "Your portfolio is closely aligned with the " + name + " target. " + (breaches.length ? "Address the listed limit breaches to stay on profile." : "Maintain current allocations and monitor for drift.");
    if (score >= 65) return "Slight drift from the " + name + " target. Consider rebalancing the most over-weighted asset class to tighten alignment.";
    if (score >= 40) return "Meaningful drift from the " + name + " target. Several class weights are out of band; rebalancing is recommended.";
    return "Portfolio is significantly off the " + name + " target — large class-weight gaps and/or limit breaches. A structured rebalance is recommended.";
  }

  function localRecommendations(target, actual, breaches) {
    const recs = [];
    const t = target.weights || {};
    const sorted = Object.keys(t).map((k) => ({ k, delta: (actual[k] || 0) - (t[k] || 0) }))
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    sorted.slice(0, 3).forEach((d) => {
      const pp = Math.round(Math.abs(d.delta) * 100);
      if (pp < 2) return;
      if (d.delta > 0) recs.push("Reduce " + d.k.replace(/_/g, " ") + " exposure by ~" + pp + " percentage points to match target.");
      else recs.push("Increase " + d.k.replace(/_/g, " ") + " allocation by ~" + pp + " percentage points to match target.");
    });
    breaches.slice(0, 2).forEach((b) => recs.push("Resolve breach: " + b));
    if (!recs.length) recs.push("Allocations are within tolerance. Monitor weekly and re-run when positions change.");
    return recs;
  }

  async function tryAi({ wallet, score, target, summary, breaches }) {
    const url = window.DEFI_RISK_WORKER_URL;
    if (!url) return null;
    const recentActivity = "Target profile: " + (target.name || "n/a") +
      " · Alignment score: " + score + "/100" +
      " · Limit breaches: " + (breaches.length ? breaches.join("; ") : "none");
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet,
          deFiScore: score,
          recentActivity,
        }),
      });
      if (!res.ok) throw new Error("Worker " + res.status);
      const data = await res.json();
      if (!data.success || !data.profile) throw new Error("Worker returned no profile");
      const recs = (data.profile.recommendations || []).map((r) => {
        if (typeof r === "string") return r;
        return (r.project || "Recommendation") + " (" + (r.riskLevel || "?") + " risk): " + (r.reason || "");
      });
      return {
        summary: data.profile.summary || summary,
        recommendations: recs.length ? recs : null,
      };
    } catch (e) {
      console.warn("AI Worker call failed, using local recommendations:", e.message);
      return null;
    }
  }

  async function profile({ wallet, portfolio, target, target_profile_id }) {
    const positions = (portfolio && portfolio.positions) || [];
    const { breakdown: actual } = classBreakdown(positions);
    const concentration = concentrationByProtocol(positions);

    const total = positions.reduce((s, p) => s + (p.value_usd || 0), 0) || 1;
    const longTailUsd = positions.reduce((s, p) => s + (classOf(p.name) === "long_tail" ? (p.value_usd || 0) : 0), 0);
    const longTailPct = (longTailUsd / total) * 100;

    const score = alignmentScore(actual, target.weights || {});
    const breaches = checkLimits(actual, concentration, target, longTailPct);
    const baseSummary = localSummary(target, score, breaches, longTailPct);
    const baseRecs = localRecommendations(target, actual, breaches);

    const ai = await tryAi({ wallet, score, target, summary: baseSummary, breaches });

    return {
      wallet,
      target_profile_id,
      score,
      summary: ai ? ai.summary : baseSummary,
      recommendations: ai && ai.recommendations ? ai.recommendations : baseRecs,
      limit_breaches: breaches,
      concentration,
      class_actual: actual,
      source: ai ? "ai" : "local",
    };
  }

  window.DefiProfiler = { profile };
})();
