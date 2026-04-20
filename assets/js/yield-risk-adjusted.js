/* DeFi Scoring – yield-risk-adjusted.js
 *
 * Module 7 — Yield & Risk-Adjusted Performance.
 * Sharpe-like risk-adjusted yield scoring, projected drawdown, correlation
 * to crypto-beta, and stress-test scenarios for the detected RWA issuer.
 *
 * Public API:
 *   window.DefiYieldRiskAdjusted.render()        -> Promise<void>
 *   window.DefiYieldRiskAdjusted.refresh()       -> Promise<void>
 *   window.DefiYieldRiskAdjusted.setIssuer(name) -> Promise<void>
 *
 * Auto-syncs with rwa-asset-score.js via the `defi:rwa:issuer` event.
 */
(function () {
  if (window.DefiYieldRiskAdjusted) return;

  // -------- Curated yield dossier ---------------------------------------
  // annualYield: net APY after fees
  // sharpeRatio: trailing-12-month Sharpe vs. risk-free (3M T-bill)
  // projectedDrawdown: 95% VaR drawdown under stress
  // riskCorrelation: 90-day correlation to BTC (proxy for crypto beta)
  // stressTestResults: drawdown % under [Mild, Moderate, Severe, Extreme, Recovery] scenarios
  // yieldHistory / correlationHistory: trailing 5-month series
  const YIELD_DATA = {
    "BlackRock / Securitize": {
      yieldScoreBase: 815,
      annualYield: 4.85,
      sharpeRatio: 2.9,
      projectedDrawdown: 1.0,
      riskCorrelation: 0.12,
      stressTestResults: [0.6, 1.0, 2.2, 3.5, 1.2],
      yieldHistory:       [4.55, 4.65, 4.72, 4.80, 4.85],
      correlationHistory: [0.10, 0.11, 0.13, 0.12, 0.12],
    },
    "Ondo Finance": {
      yieldScoreBase: 770,
      annualYield: 5.20,
      sharpeRatio: 2.5,
      projectedDrawdown: 2.5,
      riskCorrelation: 0.30,
      stressTestResults: [1.2, 2.0, 3.8, 5.5, 2.4],
      yieldHistory:       [4.95, 5.05, 5.10, 5.18, 5.20],
      correlationHistory: [0.22, 0.25, 0.28, 0.30, 0.30],
    },
    "Circle": {
      yieldScoreBase: 760,
      annualYield: 0.00, // USDC pays no yield to holders
      sharpeRatio: 0.0,
      projectedDrawdown: 0.5,
      riskCorrelation: 0.05,
      stressTestResults: [0.2, 0.4, 1.5, 3.0, 0.5],
      yieldHistory:       [0.0, 0.0, 0.0, 0.0, 0.0],
      correlationHistory: [0.04, 0.05, 0.05, 0.05, 0.05],
    },
    "Paxos": {
      yieldScoreBase: 750,
      annualYield: 0.00,
      sharpeRatio: 0.0,
      projectedDrawdown: 0.5,
      riskCorrelation: 0.06,
      stressTestResults: [0.2, 0.5, 1.6, 3.2, 0.6],
      yieldHistory:       [0.0, 0.0, 0.0, 0.0, 0.0],
      correlationHistory: [0.05, 0.06, 0.06, 0.06, 0.06],
    },
    "Tether": {
      yieldScoreBase: 660,
      annualYield: 0.00,
      sharpeRatio: 0.0,
      projectedDrawdown: 4.0,
      riskCorrelation: 0.20,
      stressTestResults: [1.0, 2.5, 5.0, 9.0, 3.0],
      yieldHistory:       [0.0, 0.0, 0.0, 0.0, 0.0],
      correlationHistory: [0.18, 0.20, 0.22, 0.20, 0.20],
    },
    "Franklin": {
      yieldScoreBase: 810,
      annualYield: 4.95,
      sharpeRatio: 3.0,
      projectedDrawdown: 0.9,
      riskCorrelation: 0.08,
      stressTestResults: [0.5, 0.9, 2.0, 3.2, 1.0],
      yieldHistory:       [4.70, 4.78, 4.85, 4.92, 4.95],
      correlationHistory: [0.07, 0.08, 0.09, 0.08, 0.08],
    },
    "WisdomTree": {
      yieldScoreBase: 790,
      annualYield: 4.70,
      sharpeRatio: 2.7,
      projectedDrawdown: 1.4,
      riskCorrelation: 0.14,
      stressTestResults: [0.7, 1.2, 2.5, 4.0, 1.5],
      yieldHistory:       [4.45, 4.55, 4.62, 4.68, 4.70],
      correlationHistory: [0.12, 0.13, 0.14, 0.15, 0.14],
    },
    "MakerDAO / Sky": {
      yieldScoreBase: 720,
      annualYield: 6.50, // sUSDS savings rate
      sharpeRatio: 1.8,
      projectedDrawdown: 4.5,
      riskCorrelation: 0.42,
      stressTestResults: [2.0, 3.5, 6.5, 10.5, 4.0],
      yieldHistory:       [5.50, 5.80, 6.20, 6.40, 6.50],
      correlationHistory: [0.35, 0.38, 0.40, 0.42, 0.42],
    },
    "Centrifuge": {
      yieldScoreBase: 540,
      annualYield: 8.50,
      sharpeRatio: 1.0,
      projectedDrawdown: 14.0,
      riskCorrelation: 0.72,
      stressTestResults: [5.5, 10.5, 18.0, 27.0, 8.5],
      yieldHistory:       [7.80, 8.10, 8.30, 8.45, 8.50],
      correlationHistory: [0.68, 0.70, 0.71, 0.72, 0.72],
    },
    "Maple": {
      yieldScoreBase: 600,
      annualYield: 9.20,
      sharpeRatio: 1.4,
      projectedDrawdown: 9.5,
      riskCorrelation: 0.55,
      stressTestResults: [3.5, 6.5, 12.0, 18.5, 6.0],
      yieldHistory:       [8.50, 8.80, 9.00, 9.15, 9.20],
      correlationHistory: [0.50, 0.52, 0.54, 0.55, 0.55],
    },
  };

  const FALLBACK = {
    yieldScoreBase: 500,
    annualYield: 0.0,
    sharpeRatio: 0.0,
    projectedDrawdown: 12.0,
    riskCorrelation: 0.6,
    stressTestResults: [4, 8, 14, 22, 7],
    yieldHistory:       [0, 0, 0, 0, 0],
    correlationHistory: [0.55, 0.58, 0.60, 0.60, 0.60],
  };

  let chartStress = null;
  let chartYieldRisk = null;
  let activeIssuer = null;
  let inflight = null;

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }

  function matchIssuerKey(issuerLike) {
    if (!issuerLike) return null;
    const s = issuerLike.toLowerCase();
    for (const k of Object.keys(YIELD_DATA)) {
      const ks = k.toLowerCase();
      const tokens = ks.split(/[^a-z0-9]+/).filter(Boolean);
      if (tokens.some((t) => t.length > 3 && s.includes(t))) return k;
      if (s.split(/[^a-z0-9]+/).some((t) => t.length > 3 && ks.includes(t))) return k;
    }
    return null;
  }

  function gradeFor(score) {
    return score >= 800 ? "A+" : score >= 750 ? "A" : score >= 700 ? "A-"
         : score >= 650 ? "B"  : score >= 600 ? "B-" : score >= 550 ? "C"
         : score >= 500 ? "C-" : "D";
  }
  function tierFor(score) {
    return score >= 750 ? "Low Risk" : score >= 650 ? "Moderate Risk"
         : score >= 550 ? "Elevated Risk" : "High Risk";
  }
  function color(score) {
    if (score >= 750) return "#2bd4a4";
    if (score >= 650) return "#5b8cff";
    if (score >= 550) return "#f5b042";
    return "#fc6464";
  }
  function correlationLabel(c) {
    if (c <= 0.20) return "Decoupled";
    if (c <= 0.40) return "Low";
    if (c <= 0.60) return "Moderate";
    return "High";
  }

  function calculate(issuerKey) {
    const data = YIELD_DATA[issuerKey] || FALLBACK;
    let score = data.yieldScoreBase;
    score += Math.floor(data.sharpeRatio * 30);
    score -= Math.floor(data.projectedDrawdown * 4);
    if (data.riskCorrelation > 0.50) score -= 50;
    if (data.riskCorrelation > 0.70) score -= 30; // additional penalty
    score = Math.min(850, Math.max(300, Math.floor(score)));
    return Object.assign({}, data, {
      score, grade: gradeFor(score), tier: tierFor(score),
      correlationTier: correlationLabel(data.riskCorrelation),
    });
  }

  // -------- rendering ----------------------------------------------------
  function renderShell(container) {
    container.innerHTML = `
      <div class="defi-card" style="text-align:center;padding:30px 20px">
        <div class="defi-empty" style="border:none;padding:0">Calculating Sharpe-like risk-adjusted yield and running stress-test scenarios…</div>
      </div>`;
  }

  function buildHtml(issuerDisplay, r, matched) {
    const c = color(r.score);
    const yieldDisplay = r.annualYield > 0 ? r.annualYield.toFixed(2) + "%" : "n/a (non-yield-bearing)";

    const factsRow = (label, value, valueColor) => `
      <div style="display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid rgba(148,163,184,.1)">
        <span style="font-size:13px;color:var(--defi-text-dim)">${esc(label)}</span>
        <strong style="font-size:13px;${valueColor ? "color:" + valueColor : ""}">${esc(value)}</strong>
      </div>`;

    const matchBadge = matched
      ? `<span class="defi-chip" style="background:rgba(43,212,164,.12);color:#2bd4a4;border-color:rgba(43,212,164,.3)">Yield profile matched</span>`
      : `<span class="defi-chip" style="background:rgba(252,100,100,.12);color:#fc6464;border-color:rgba(252,100,100,.3)">Issuer not in registry</span>`;

    return `
      <div class="defi-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px;margin-bottom:18px">

        <div class="defi-card" style="text-align:center">
          <div class="defi-card__title" style="display:flex;justify-content:space-between;align-items:center">
            <span>Yield &amp; Risk-Adjusted</span>
            <button id="yield-refresh-btn" class="defi-btn defi-btn--ghost" type="button" style="font-size:12px;padding:4px 10px">Refresh</button>
          </div>
          <div style="font-size:64px;font-weight:800;line-height:1;color:${c};margin-top:18px">${r.score}</div>
          <div style="font-size:28px;font-weight:700;margin-top:4px">${r.grade}</div>
          <div style="display:inline-block;margin-top:14px;padding:6px 14px;border-radius:999px;font-size:13px;font-weight:600;background:${c}22;color:${c}">${r.tier}</div>
          <div style="margin-top:14px;display:flex;gap:6px;justify-content:center;flex-wrap:wrap">${matchBadge}</div>
          <div style="margin-top:12px;font-size:12px;color:var(--defi-text-dim)">Annual yield: <strong style="color:var(--defi-text)">${esc(yieldDisplay)}</strong></div>
        </div>

        <div class="defi-card">
          <div class="defi-card__title">📊 Risk-adjusted metrics</div>
          <div style="margin-top:8px">
            ${factsRow("Sharpe ratio (12M)", r.sharpeRatio.toFixed(2))}
            ${factsRow("Projected max drawdown", r.projectedDrawdown.toFixed(1) + "%", "#fc6464")}
            ${factsRow("BTC correlation (90d)", r.riskCorrelation.toFixed(2) + " · " + r.correlationTier)}
            ${factsRow("Net APY", yieldDisplay, r.annualYield > 0 ? "#2bd4a4" : "")}
          </div>
        </div>

        <div class="defi-card">
          <div class="defi-card__title">Stress-test scenarios</div>
          <div style="height:240px;margin-top:10px"><canvas id="yield-stress-chart"></canvas></div>
        </div>

      </div>

      <div class="defi-grid" style="display:grid;grid-template-columns:1fr;gap:18px;margin-bottom:18px">
        <div class="defi-card">
          <div class="defi-card__title">Yield vs. crypto correlation (5-month history)</div>
          <div style="height:280px;margin-top:10px"><canvas id="yield-risk-chart"></canvas></div>
        </div>
      </div>

      <div class="defi-card">
        <div style="font-size:11px;color:var(--defi-text-dim);line-height:1.5">
          Risk-adjusted scoring rewards Sharpe ratio (+30 / unit) and penalizes 95% VaR drawdown (−4 / pp) and
          BTC correlation above 0.5 (−50, with an additional −30 above 0.7). Stress scenarios show projected drawdown
          under Mild / Moderate / Severe / Extreme conditions plus a Recovery shock. Non-yield-bearing stablecoins
          (USDC, USDT, USDP) are scored on capital preservation rather than APY. Not investment advice.
          Full methodology in /methodology/.
        </div>
      </div>`;
  }

  function renderStressChart(values) {
    const canvas = document.getElementById("yield-stress-chart");
    if (!canvas || typeof Chart === "undefined") return;
    if (chartStress) { try { chartStress.destroy(); } catch (_) {} chartStress = null; }
    const labels = ["Mild", "Moderate", "Severe", "Extreme", "Recovery"];
    chartStress = new Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Drawdown %",
          data: values,
          backgroundColor: values.map((v) => v < 2 ? "#2bd4a4" : v < 5 ? "#5b8cff" : v < 10 ? "#f5b042" : "#fc6464"),
          borderRadius: 6,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: "#94a3b8" }, grid: { display: false } },
          y: { ticks: { color: "#94a3b8", callback: (v) => v + "%" }, grid: { color: "rgba(148,163,184,.08)" }, beginAtZero: true },
        },
      },
    });
  }

  function renderYieldRiskChart(yields, correlations) {
    const canvas = document.getElementById("yield-risk-chart");
    if (!canvas || typeof Chart === "undefined") return;
    if (chartYieldRisk) { try { chartYieldRisk.destroy(); } catch (_) {} chartYieldRisk = null; }
    const labels = [];
    const now = new Date();
    for (let i = yields.length - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      labels.push(d.toLocaleString("default", { month: "short" }));
    }
    chartYieldRisk = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Yield (%)",
            data: yields,
            borderColor: "#2bd4a4",
            backgroundColor: "rgba(43,212,164,.15)",
            tension: 0.35,
            borderWidth: 2,
            pointRadius: 3,
            yAxisID: "y",
            fill: false,
          },
          {
            label: "BTC correlation",
            data: correlations,
            borderColor: "#fc6464",
            backgroundColor: "rgba(252,100,100,.15)",
            tension: 0.35,
            borderWidth: 2,
            pointRadius: 3,
            yAxisID: "y1",
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: true, labels: { color: "#cbd5e1", boxWidth: 12 } },
        },
        scales: {
          x: { ticks: { color: "#94a3b8" }, grid: { display: false } },
          y:  { type: "linear", position: "left",  ticks: { color: "#2bd4a4", callback: (v) => v + "%" }, grid: { color: "rgba(148,163,184,.08)" }, beginAtZero: true },
          y1: { type: "linear", position: "right", ticks: { color: "#fc6464" }, grid: { drawOnChartArea: false }, min: 0, max: 1 },
        },
      },
    });
  }

  // -------- public render ------------------------------------------------
  async function render(force) {
    const container = document.getElementById("yield-risk-adjusted-container");
    if (!container) return;
    if (inflight && !force) return inflight;

    renderShell(container);

    inflight = (async () => {
      try {
        const candidate = activeIssuer
          || (window.DefiRWAScore && window.DefiRWAScore.activeIssuer)
          || "BlackRock / Securitize";
        const matchedKey = matchIssuerKey(candidate);
        const issuerDisplay = matchedKey || candidate;
        const result = calculate(matchedKey || "__fallback__");

        container.innerHTML = buildHtml(issuerDisplay, result, !!matchedKey);
        const btn = document.getElementById("yield-refresh-btn");
        if (btn) btn.addEventListener("click", () => render(true));
        renderStressChart(result.stressTestResults);
        renderYieldRiskChart(result.yieldHistory, result.correlationHistory);
      } catch (err) {
        console.warn("[yield-risk-adjusted] render failed:", err);
        container.innerHTML = `
          <div class="defi-card" style="text-align:center;padding:30px 20px">
            <div style="color:#fca5a5;font-size:14px">Could not load yield data right now.</div>
            <div style="font-size:12px;color:var(--defi-text-dim);margin-top:8px">${esc(err && err.message || String(err))}</div>
          </div>`;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function setIssuer(name) { activeIssuer = name || null; return render(true); }

  function init() {
    if (!document.getElementById("yield-risk-adjusted-container")) return;
    render(false);
    window.addEventListener("defi:rwa:issuer", (e) => {
      const newIssuer = e && e.detail && e.detail.issuer;
      if (newIssuer && newIssuer !== activeIssuer) {
        activeIssuer = newIssuer;
        render(true);
      }
    });
    if (window.DefiWallet && typeof window.DefiWallet.on === "function") {
      window.DefiWallet.on("change", () => render(true));
    }
  }

  window.DefiYieldRiskAdjusted = { render: () => render(false), refresh: () => render(true), setIssuer };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
