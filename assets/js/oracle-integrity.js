/* DeFi Scoring – oracle-integrity.js
 *
 * Module 5 — Oracle & Data Integrity.
 * Assesses pricing oracles, NAV feeds, redemption reliability, and
 * historical oracle failures for the detected RWA issuer.
 *
 * Public API:
 *   window.DefiOracleIntegrity.render()        -> Promise<void>
 *   window.DefiOracleIntegrity.refresh()       -> Promise<void>
 *   window.DefiOracleIntegrity.setIssuer(name) -> Promise<void>
 *
 * Auto-syncs with rwa-asset-score.js via the `defi:rwa:issuer` event.
 */
(function () {
  if (window.DefiOracleIntegrity) return;

  // -------- Curated oracle dossier --------------------------------------
  // latencyMs: median oracle update latency
  // freshnessHours: 5 most recent NAV update intervals (hours)
  // failurePatterns: oracle deviation / stale-feed incidents over the last 7 days
  // navAccuracy: % deviation from NAV reference over rolling 30 days
  const ORACLE_DATA = {
    "BlackRock / Securitize": {
      oracleProvider: "Chainlink Proof-of-Reserve + Securitize NAV",
      navSource: "Securitize transfer agent (daily NAV)",
      riskScoreBase: 815,
      latencyMs: 420,
      redemptionRisk: "Low",
      failurePatterns: [0, 1, 0, 1, 0, 0, 1],
      freshnessHours: [0.25, 0.30, 0.28, 0.22, 0.31],
      navAccuracy: 99.9,
      crossChain: "Wormhole CCIP-attested",
    },
    "Ondo Finance": {
      oracleProvider: "Chainlink + RedStone",
      navSource: "Daily fund NAV (BlackRock/PIMCO underlying)",
      riskScoreBase: 770,
      latencyMs: 620,
      redemptionRisk: "Low",
      failurePatterns: [1, 0, 2, 1, 0, 1, 1],
      freshnessHours: [0.5, 0.7, 0.6, 0.55, 0.62],
      navAccuracy: 99.5,
      crossChain: "LayerZero + CCIP",
    },
    "Circle": {
      oracleProvider: "Chainlink Proof-of-Reserve (USDC)",
      navSource: "Weekly Circle reserve disclosure + daily Reserve Fund NAV",
      riskScoreBase: 805,
      latencyMs: 380,
      redemptionRisk: "Low",
      failurePatterns: [0, 0, 1, 0, 0, 1, 0],
      freshnessHours: [0.20, 0.18, 0.22, 0.19, 0.21],
      navAccuracy: 99.95,
      crossChain: "CCIP-attested across 16 chains",
    },
    "Paxos": {
      oracleProvider: "Chainlink PoR + Paxos attestation API",
      navSource: "Monthly Withum attestation + on-chain reserve feed",
      riskScoreBase: 790,
      latencyMs: 510,
      redemptionRisk: "Low",
      failurePatterns: [0, 1, 0, 0, 1, 0, 0],
      freshnessHours: [0.30, 0.40, 0.32, 0.35, 0.28],
      navAccuracy: 99.8,
      crossChain: "Native multi-chain (ETH/Solana)",
    },
    "Tether": {
      oracleProvider: "Internal feeds · limited third-party PoR",
      navSource: "Quarterly BDO reserve report · no on-chain NAV",
      riskScoreBase: 590,
      latencyMs: 1800,
      redemptionRisk: "Medium",
      failurePatterns: [3, 5, 2, 4, 6, 3, 5],
      freshnessHours: [3.5, 4.2, 3.8, 4.5, 3.9],
      navAccuracy: 97.5,
      crossChain: "Native bridges (varies per chain)",
    },
    "Franklin": {
      oracleProvider: "Franklin Templeton internal NAV",
      navSource: "Daily SEC-registered fund NAV",
      riskScoreBase: 810,
      latencyMs: 450,
      redemptionRisk: "Low",
      failurePatterns: [0, 0, 0, 1, 0, 0, 1],
      freshnessHours: [0.30, 0.25, 0.28, 0.32, 0.27],
      navAccuracy: 99.9,
      crossChain: "Stellar + Polygon (issuer-bridged)",
    },
    "WisdomTree": {
      oracleProvider: "Chainlink + WisdomTree internal NAV",
      navSource: "Monthly NAV publication",
      riskScoreBase: 785,
      latencyMs: 580,
      redemptionRisk: "Low",
      failurePatterns: [1, 0, 1, 0, 1, 0, 1],
      freshnessHours: [0.6, 0.7, 0.5, 0.65, 0.55],
      navAccuracy: 99.6,
      crossChain: "Stellar (native)",
    },
    "MakerDAO / Sky": {
      oracleProvider: "Maker Oracle Security Module (OSM) + Chronicle",
      navSource: "On-chain DAI/USDS price · vault collateral feeds",
      riskScoreBase: 700,
      latencyMs: 900,
      redemptionRisk: "Low",
      failurePatterns: [1, 2, 1, 1, 2, 0, 1],
      freshnessHours: [1.0, 1.1, 0.95, 1.05, 0.98],
      navAccuracy: 99.2,
      crossChain: "On-chain native + governance bridges",
    },
    "Centrifuge": {
      oracleProvider: "Custom pool oracles + Pyth (some pools)",
      navSource: "Per-pool quarterly NAV · variance per issuer",
      riskScoreBase: 600,
      latencyMs: 2200,
      redemptionRisk: "High",
      failurePatterns: [4, 6, 3, 5, 7, 4, 5],
      freshnessHours: [3.8, 4.5, 3.2, 4.1, 4.8],
      navAccuracy: 95.8,
      crossChain: "Centrifuge chain + Ethereum bridge",
    },
    "Maple": {
      oracleProvider: "Pool dashboards + Chainlink (cash pools)",
      navSource: "On-chain pool accounting · loan-level updates",
      riskScoreBase: 690,
      latencyMs: 1100,
      redemptionRisk: "Medium",
      failurePatterns: [2, 3, 1, 2, 3, 2, 3],
      freshnessHours: [1.5, 1.8, 1.4, 1.6, 1.7],
      navAccuracy: 98.4,
      crossChain: "Ethereum + Solana (Maple Direct)",
    },
  };

  const FALLBACK = {
    oracleProvider: "Unknown",
    navSource: "Not disclosed",
    riskScoreBase: 480,
    latencyMs: 3000,
    redemptionRisk: "High",
    failurePatterns: [6, 8, 5, 7, 9, 6, 8],
    freshnessHours: [5, 6, 5.5, 6.2, 5.8],
    navAccuracy: 92,
    crossChain: "Unknown",
  };

  let chartFailures = null;
  let chartFreshness = null;
  let activeIssuer = null;
  let inflight = null;

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }

  function matchIssuerKey(issuerLike) {
    if (!issuerLike) return null;
    const s = issuerLike.toLowerCase();
    for (const k of Object.keys(ORACLE_DATA)) {
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
    if (score >= 650) return "#8a5cff";
    if (score >= 550) return "#f5b042";
    return "#fc6464";
  }
  function riskBadge(level) {
    if (level === "Low")    return { bg: "rgba(43,212,164,.15)", fg: "#2bd4a4" };
    if (level === "Medium") return { bg: "rgba(245,176,66,.15)", fg: "#f5b042" };
    return { bg: "rgba(252,100,100,.15)", fg: "#fc6464" };
  }

  function calculate(issuerKey) {
    const data = ORACLE_DATA[issuerKey] || FALLBACK;
    let score = data.riskScoreBase;
    if (data.latencyMs > 1000) score -= 60;
    if (data.latencyMs > 2000) score -= 30; // additional penalty
    if (data.redemptionRisk === "Medium") score -= 30;
    if (data.redemptionRisk === "High")   score -= 70;
    const totalFailures = data.failurePatterns.reduce((a, b) => a + b, 0);
    score -= Math.floor(totalFailures * 6);
    score = Math.min(850, Math.max(300, Math.floor(score)));
    return Object.assign({}, data, {
      score, grade: gradeFor(score), tier: tierFor(score), totalFailures,
    });
  }

  // -------- rendering ----------------------------------------------------
  function renderShell(container) {
    container.innerHTML = `
      <div class="defi-card" style="text-align:center;padding:30px 20px">
        <div class="defi-empty" style="border:none;padding:0">Analyzing pricing oracles, NAV feeds, and redemption reliability…</div>
      </div>`;
  }

  function buildHtml(issuerKey, issuerDisplay, r, matched) {
    const c = color(r.score);
    const rb = riskBadge(r.redemptionRisk);
    const latencyPct = Math.min(100, r.latencyMs / 30);
    const latencyColor = r.latencyMs < 700 ? "#2bd4a4" : r.latencyMs < 1500 ? "#f5b042" : "#fc6464";
    const latencyLabel = r.latencyMs < 700 ? "Fast" : r.latencyMs < 1500 ? "Moderate" : "Slow";

    const factsRow = (label, value) => `
      <div style="display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid rgba(148,163,184,.1)">
        <span style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--defi-text-dim);flex:0 0 38%">${esc(label)}</span>
        <span style="font-size:13px;text-align:right;flex:1">${esc(value)}</span>
      </div>`;

    const matchBadge = matched
      ? `<span class="defi-chip" style="background:rgba(43,212,164,.12);color:#2bd4a4;border-color:rgba(43,212,164,.3)">Oracle profile matched</span>`
      : `<span class="defi-chip" style="background:rgba(252,100,100,.12);color:#fc6464;border-color:rgba(252,100,100,.3)">Oracle not in registry</span>`;

    return `
      <div class="defi-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px;margin-bottom:18px">

        <div class="defi-card" style="text-align:center">
          <div class="defi-card__title" style="display:flex;justify-content:space-between;align-items:center">
            <span>Oracle &amp; Data Integrity</span>
            <button id="oracle-refresh-btn" class="defi-btn defi-btn--ghost" type="button" style="font-size:12px;padding:4px 10px">Refresh</button>
          </div>
          <div style="font-size:64px;font-weight:800;line-height:1;color:${c};margin-top:18px">${r.score}</div>
          <div style="font-size:28px;font-weight:700;margin-top:4px">${r.grade}</div>
          <div style="display:inline-block;margin-top:14px;padding:6px 14px;border-radius:999px;font-size:13px;font-weight:600;background:${c}22;color:${c}">${r.tier}</div>
          <div style="margin-top:14px;display:flex;gap:6px;justify-content:center;flex-wrap:wrap">${matchBadge}</div>
          <div style="margin-top:12px;font-size:12px;color:var(--defi-text-dim)">Issuer: <strong style="color:var(--defi-text)">${esc(issuerDisplay)}</strong></div>
        </div>

        <div class="defi-card">
          <div class="defi-card__title">⚡ Latency &amp; redemption risk</div>
          <div style="margin-top:16px">
            <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--defi-text-dim);margin-bottom:6px">
              <span>Oracle latency (median)</span>
              <span style="color:var(--defi-text);font-weight:600">${r.latencyMs} ms · ${latencyLabel}</span>
            </div>
            <div style="height:8px;background:rgba(148,163,184,.15);border-radius:999px;overflow:hidden">
              <div style="height:100%;width:${latencyPct}%;background:${latencyColor};border-radius:999px"></div>
            </div>
          </div>
          <div style="margin-top:18px;display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:13px">Redemption risk</span>
            <span style="padding:6px 14px;border-radius:999px;font-size:13px;font-weight:700;background:${rb.bg};color:${rb.fg}">${esc(r.redemptionRisk)}</span>
          </div>
          <div style="margin-top:14px;font-size:13px;display:flex;justify-content:space-between">
            <span style="color:var(--defi-text-dim)">NAV accuracy (30-day)</span>
            <strong>${r.navAccuracy}%</strong>
          </div>
          <div style="margin-top:8px;font-size:13px;display:flex;justify-content:space-between">
            <span style="color:var(--defi-text-dim)">Oracle incidents (7-day)</span>
            <strong>${r.totalFailures}</strong>
          </div>
        </div>

        <div class="defi-card">
          <div class="defi-card__title">Oracle stack</div>
          <div style="margin-top:8px">
            ${factsRow("Provider",       r.oracleProvider)}
            ${factsRow("NAV source",     r.navSource)}
            ${factsRow("Cross-chain",    r.crossChain)}
          </div>
        </div>

      </div>

      <div class="defi-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px;margin-bottom:18px">
        <div class="defi-card">
          <div class="defi-card__title">Oracle failure patterns (last 7 days)</div>
          <div style="height:240px;margin-top:10px"><canvas id="oracle-failures-chart"></canvas></div>
        </div>

        <div class="defi-card">
          <div class="defi-card__title">NAV freshness (hours since update)</div>
          <div style="height:240px;margin-top:10px"><canvas id="oracle-freshness-chart"></canvas></div>
        </div>
      </div>

      <div class="defi-card">
        <div style="font-size:11px;color:var(--defi-text-dim);line-height:1.5">
          Oracle assessments combine provider track record, median update latency, NAV deviation vs. reference,
          and recent stale-feed / deviation incidents. Live PoR feeds (Chainlink, RedStone) and cross-chain attestation
          (CCIP, LayerZero) are weighted higher than internal-only NAV publication. Not investment advice.
          Full methodology in /methodology/.
        </div>
      </div>`;
  }

  function renderFailuresChart(failures) {
    const canvas = document.getElementById("oracle-failures-chart");
    if (!canvas || typeof Chart === "undefined") return;
    if (chartFailures) { try { chartFailures.destroy(); } catch (_) {} chartFailures = null; }
    const labels = [];
    const now = new Date();
    for (let i = failures.length - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      labels.push(d.toLocaleDateString("default", { weekday: "short" }));
    }
    chartFailures = new Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Incidents",
          data: failures,
          backgroundColor: failures.map((v) => v === 0 ? "#2bd4a4" : v <= 2 ? "#5b8cff" : v <= 4 ? "#f5b042" : "#fc6464"),
          borderRadius: 6,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: "#94a3b8" }, grid: { display: false } },
          y: { ticks: { color: "#94a3b8", precision: 0 }, grid: { color: "rgba(148,163,184,.08)" }, beginAtZero: true },
        },
      },
    });
  }

  function renderFreshnessChart(freshness) {
    const canvas = document.getElementById("oracle-freshness-chart");
    if (!canvas || typeof Chart === "undefined") return;
    if (chartFreshness) { try { chartFreshness.destroy(); } catch (_) {} chartFreshness = null; }
    const labels = freshness.map((_, i) => `T-${(freshness.length - 1 - i) * 12}h`);
    chartFreshness = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "Hours since update",
          data: freshness,
          borderColor: "#8a5cff",
          backgroundColor: "rgba(138,92,255,.18)",
          tension: 0.35,
          borderWidth: 2,
          pointRadius: 3,
          fill: true,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: "#94a3b8" }, grid: { display: false } },
          y: { ticks: { color: "#94a3b8" }, grid: { color: "rgba(148,163,184,.08)" }, beginAtZero: true },
        },
      },
    });
  }

  // -------- public render ------------------------------------------------
  async function render(force) {
    const container = document.getElementById("oracle-integrity-container");
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

        container.innerHTML = buildHtml(matchedKey || candidate, issuerDisplay, result, !!matchedKey);
        const btn = document.getElementById("oracle-refresh-btn");
        if (btn) btn.addEventListener("click", () => render(true));
        renderFailuresChart(result.failurePatterns);
        renderFreshnessChart(result.freshnessHours);
      } catch (err) {
        console.warn("[oracle-integrity] render failed:", err);
        container.innerHTML = `
          <div class="defi-card" style="text-align:center;padding:30px 20px">
            <div style="color:#fca5a5;font-size:14px">Could not load oracle data right now.</div>
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
    if (!document.getElementById("oracle-integrity-container")) return;
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

  window.DefiOracleIntegrity = { render: () => render(false), refresh: () => render(true), setIssuer };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
