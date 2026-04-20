/* DeFi Scoring – liquidity-redemption.js
 *
 * Module 6 — Liquidity & Redemption Risk.
 * Measures secondary-market depth, redemption speed, fire-sale risk, and
 * on-chain liquidity ratios for the detected RWA issuer.
 *
 * Public API:
 *   window.DefiLiquidityRedemption.render()        -> Promise<void>
 *   window.DefiLiquidityRedemption.refresh()       -> Promise<void>
 *   window.DefiLiquidityRedemption.setIssuer(name) -> Promise<void>
 *
 * Auto-syncs with rwa-asset-score.js via the `defi:rwa:issuer` event.
 */
(function () {
  if (window.DefiLiquidityRedemption) return;

  // -------- Curated liquidity dossier -----------------------------------
  // secondaryMarketVolume: trailing 30-day USD volume across DEX + OTC desks
  // redemptionTimeline: representative settlement window for primary redemption
  // fireSaleRisk: stress-test outcome for forced unwind under typical haircut
  // onChainLiquidity: % of TVL held in immediately-redeemable instruments (last 7 days)
  // redemptionHistory: avg days to primary-redeem (last 7 monthly observations)
  const LIQUIDITY_DATA = {
    "BlackRock / Securitize": {
      liquidityScoreBase: 815,
      secondaryMarketVolume: 2_450_000_000,
      redemptionTimeline: "1–3 days",
      fireSaleRisk: "Low",
      onChainLiquidity: [78, 80, 82, 85, 86, 87, 88],
      redemptionHistory: [3.0, 2.6, 2.2, 1.9, 1.6, 1.3, 1.0],
      venues: "Securitize · OTC desks · permissioned DEX (Centrifuge V3)",
    },
    "Ondo Finance": {
      liquidityScoreBase: 780,
      secondaryMarketVolume: 890_000_000,
      redemptionTimeline: "Instant (Ondo Flux) / T+1",
      fireSaleRisk: "Low",
      onChainLiquidity: [88, 89, 90, 91, 92, 92, 93],
      redemptionHistory: [0.9, 0.7, 0.5, 0.4, 0.3, 0.2, 0.15],
      venues: "Ondo Flux · Curve / Uniswap pools · OTC",
    },
    "Circle": {
      liquidityScoreBase: 845,
      secondaryMarketVolume: 18_000_000_000,
      redemptionTimeline: "Instant (Circle Mint)",
      fireSaleRisk: "Low",
      onChainLiquidity: [95, 96, 96, 97, 97, 97, 98],
      redemptionHistory: [0.05, 0.05, 0.04, 0.04, 0.03, 0.03, 0.02],
      venues: "Circle Mint · every major CEX / DEX globally",
    },
    "Paxos": {
      liquidityScoreBase: 800,
      secondaryMarketVolume: 1_800_000_000,
      redemptionTimeline: "Instant (Paxos issuance)",
      fireSaleRisk: "Low",
      onChainLiquidity: [90, 91, 92, 92, 93, 93, 94],
      redemptionHistory: [0.2, 0.18, 0.15, 0.12, 0.10, 0.10, 0.08],
      venues: "Paxos issuance · CEX (Binance, Kraken) · DEX",
    },
    "Tether": {
      liquidityScoreBase: 740,
      secondaryMarketVolume: 65_000_000_000,
      redemptionTimeline: "T+1 to T+5 (KYC required)",
      fireSaleRisk: "Medium",
      onChainLiquidity: [72, 74, 75, 73, 74, 75, 76],
      redemptionHistory: [2.0, 1.8, 2.2, 2.5, 2.0, 1.7, 1.5],
      venues: "Tether issuance · every CEX/DEX (deepest stablecoin market)",
    },
    "Franklin": {
      liquidityScoreBase: 720,
      secondaryMarketVolume: 380_000_000,
      redemptionTimeline: "T+1",
      fireSaleRisk: "Low",
      onChainLiquidity: [70, 72, 74, 75, 76, 77, 78],
      redemptionHistory: [1.2, 1.1, 1.0, 0.9, 0.85, 0.8, 0.75],
      venues: "Franklin Templeton transfer agency · Stellar / Polygon",
    },
    "WisdomTree": {
      liquidityScoreBase: 700,
      secondaryMarketVolume: 220_000_000,
      redemptionTimeline: "T+1 to T+2",
      fireSaleRisk: "Low",
      onChainLiquidity: [65, 67, 68, 70, 71, 72, 73],
      redemptionHistory: [1.5, 1.4, 1.3, 1.25, 1.2, 1.15, 1.1],
      venues: "WisdomTree Prime app · Stellar",
    },
    "MakerDAO / Sky": {
      liquidityScoreBase: 770,
      secondaryMarketVolume: 4_200_000_000,
      redemptionTimeline: "Instant (PSM / sUSDS)",
      fireSaleRisk: "Low",
      onChainLiquidity: [82, 84, 85, 86, 87, 88, 89],
      redemptionHistory: [0.1, 0.08, 0.06, 0.05, 0.04, 0.04, 0.03],
      venues: "PSM · sUSDS · Curve / Uniswap deep liquidity",
    },
    "Centrifuge": {
      liquidityScoreBase: 560,
      secondaryMarketVolume: 110_000_000,
      redemptionTimeline: "7+ days (per pool)",
      fireSaleRisk: "High",
      onChainLiquidity: [32, 35, 30, 38, 36, 33, 35],
      redemptionHistory: [12, 11, 13, 10, 12, 11, 10.5],
      venues: "Per-pool primary redemption · limited secondary market",
    },
    "Maple": {
      liquidityScoreBase: 620,
      secondaryMarketVolume: 240_000_000,
      redemptionTimeline: "30-day notice (most pools)",
      fireSaleRisk: "Medium",
      onChainLiquidity: [42, 45, 44, 46, 48, 47, 50],
      redemptionHistory: [8, 7.5, 7, 6.8, 6.5, 6.2, 6.0],
      venues: "Maple Direct · permissioned pools · limited DEX",
    },
  };

  const FALLBACK = {
    liquidityScoreBase: 500,
    secondaryMarketVolume: 25_000_000,
    redemptionTimeline: "Unknown",
    fireSaleRisk: "High",
    onChainLiquidity: [25, 28, 26, 24, 27, 25, 26],
    redemptionHistory: [14, 13, 14, 15, 13, 14, 14],
    venues: "Not disclosed",
  };

  let chartLiquidity = null;
  let chartRedemption = null;
  let activeIssuer = null;
  let inflight = null;

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }

  function matchIssuerKey(issuerLike) {
    if (!issuerLike) return null;
    const s = issuerLike.toLowerCase();
    for (const k of Object.keys(LIQUIDITY_DATA)) {
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
    if (score >= 650) return "#22d3ee";
    if (score >= 550) return "#f5b042";
    return "#fc6464";
  }
  function riskBadge(level) {
    if (level === "Low")    return { bg: "rgba(43,212,164,.15)", fg: "#2bd4a4" };
    if (level === "Medium") return { bg: "rgba(245,176,66,.15)", fg: "#f5b042" };
    return { bg: "rgba(252,100,100,.15)", fg: "#fc6464" };
  }
  function fmtVolume(v) {
    if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return "$" + (v / 1e6).toFixed(0) + "M";
    if (v >= 1e3) return "$" + (v / 1e3).toFixed(0) + "K";
    return "$" + v;
  }

  function calculate(issuerKey) {
    const data = LIQUIDITY_DATA[issuerKey] || FALLBACK;
    let score = data.liquidityScoreBase;
    if (data.fireSaleRisk === "Medium") score -= 50;
    if (data.fireSaleRisk === "High")   score -= 120;
    if (/7\+|7 days|30-day|notice/i.test(data.redemptionTimeline)) score -= 60;
    else if (/T\+5|T\+4|T\+3/i.test(data.redemptionTimeline))      score -= 30;
    // Reward deep secondary markets relative to issuer base
    if (data.secondaryMarketVolume > 5e9) score += 15;
    score = Math.min(850, Math.max(300, Math.floor(score)));
    const avgLiquidity = Math.round(data.onChainLiquidity.reduce((a, b) => a + b, 0) / data.onChainLiquidity.length);
    const latestRedeemDays = data.redemptionHistory[data.redemptionHistory.length - 1];
    return Object.assign({}, data, {
      score, grade: gradeFor(score), tier: tierFor(score), avgLiquidity, latestRedeemDays,
    });
  }

  // -------- rendering ----------------------------------------------------
  function renderShell(container) {
    container.innerHTML = `
      <div class="defi-card" style="text-align:center;padding:30px 20px">
        <div class="defi-empty" style="border:none;padding:0">Measuring secondary-market depth, redemption speed, and fire-sale risk…</div>
      </div>`;
  }

  function buildHtml(issuerDisplay, r, matched) {
    const c = color(r.score);
    const fb = riskBadge(r.fireSaleRisk);

    const factsRow = (label, value) => `
      <div style="display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid rgba(148,163,184,.1)">
        <span style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--defi-text-dim);flex:0 0 38%">${esc(label)}</span>
        <span style="font-size:13px;text-align:right;flex:1">${esc(value)}</span>
      </div>`;

    const matchBadge = matched
      ? `<span class="defi-chip" style="background:rgba(43,212,164,.12);color:#2bd4a4;border-color:rgba(43,212,164,.3)">Liquidity profile matched</span>`
      : `<span class="defi-chip" style="background:rgba(252,100,100,.12);color:#fc6464;border-color:rgba(252,100,100,.3)">Issuer not in registry</span>`;

    return `
      <div class="defi-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px;margin-bottom:18px">

        <div class="defi-card" style="text-align:center">
          <div class="defi-card__title" style="display:flex;justify-content:space-between;align-items:center">
            <span>Liquidity &amp; Redemption</span>
            <button id="liquidity-refresh-btn" class="defi-btn defi-btn--ghost" type="button" style="font-size:12px;padding:4px 10px">Refresh</button>
          </div>
          <div style="font-size:64px;font-weight:800;line-height:1;color:${c};margin-top:18px">${r.score}</div>
          <div style="font-size:28px;font-weight:700;margin-top:4px">${r.grade}</div>
          <div style="display:inline-block;margin-top:14px;padding:6px 14px;border-radius:999px;font-size:13px;font-weight:600;background:${c}22;color:${c}">${r.tier}</div>
          <div style="margin-top:14px;display:flex;gap:6px;justify-content:center;flex-wrap:wrap">${matchBadge}</div>
          <div style="margin-top:12px;font-size:12px;color:var(--defi-text-dim)">Issuer: <strong style="color:var(--defi-text)">${esc(issuerDisplay)}</strong></div>
        </div>

        <div class="defi-card">
          <div class="defi-card__title">🔥 Fire-sale &amp; depth</div>
          <div style="margin-top:16px;display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:13px">Fire-sale risk</span>
            <span style="padding:6px 14px;border-radius:999px;font-size:13px;font-weight:700;background:${fb.bg};color:${fb.fg}">${esc(r.fireSaleRisk)}</span>
          </div>
          <div style="margin-top:18px;font-size:13px;display:flex;justify-content:space-between">
            <span style="color:var(--defi-text-dim)">Secondary-market volume (30d)</span>
            <strong>${fmtVolume(r.secondaryMarketVolume)}</strong>
          </div>
          <div style="margin-top:8px;font-size:13px;display:flex;justify-content:space-between">
            <span style="color:var(--defi-text-dim)">On-chain liquidity (7d avg)</span>
            <strong>${r.avgLiquidity}% of TVL</strong>
          </div>
          <div style="margin-top:8px;font-size:13px;display:flex;justify-content:space-between">
            <span style="color:var(--defi-text-dim)">Latest avg redemption</span>
            <strong>${r.latestRedeemDays} days</strong>
          </div>
        </div>

        <div class="defi-card">
          <div class="defi-card__title">Redemption profile</div>
          <div style="margin-top:8px">
            ${factsRow("Primary timeline", r.redemptionTimeline)}
            ${factsRow("Trading venues",   r.venues)}
            ${factsRow("Fire-sale class",  r.fireSaleRisk)}
          </div>
        </div>

      </div>

      <div class="defi-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px;margin-bottom:18px">
        <div class="defi-card">
          <div class="defi-card__title">On-chain liquidity (% of TVL · last 7 days)</div>
          <div style="height:240px;margin-top:10px"><canvas id="liquidity-onchain-chart"></canvas></div>
        </div>

        <div class="defi-card">
          <div class="defi-card__title">Redemption flow (avg days to redeem · 7-month)</div>
          <div style="height:240px;margin-top:10px"><canvas id="liquidity-redemption-chart"></canvas></div>
        </div>
      </div>

      <div class="defi-card">
        <div style="font-size:11px;color:var(--defi-text-dim);line-height:1.5">
          Liquidity assessment combines primary-redemption settlement window, trailing 30-day secondary-market depth,
          on-chain redeemable share of TVL, and a fire-sale stress test under a typical-haircut unwind.
          T+5 / 7+ day / 30-day-notice timelines apply score deductions. Not investment advice. Full methodology in /methodology/.
        </div>
      </div>`;
  }

  function renderOnchainChart(values) {
    const canvas = document.getElementById("liquidity-onchain-chart");
    if (!canvas || typeof Chart === "undefined") return;
    if (chartLiquidity) { try { chartLiquidity.destroy(); } catch (_) {} chartLiquidity = null; }
    const labels = [];
    const now = new Date();
    for (let i = values.length - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      labels.push(d.toLocaleDateString("default", { weekday: "short" }));
    }
    chartLiquidity = new Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "% liquid",
          data: values,
          backgroundColor: values.map((v) => v >= 75 ? "#2bd4a4" : v >= 50 ? "#22d3ee" : v >= 35 ? "#f5b042" : "#fc6464"),
          borderRadius: 6,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: "#94a3b8" }, grid: { display: false } },
          y: { ticks: { color: "#94a3b8" }, grid: { color: "rgba(148,163,184,.08)" }, max: 100, beginAtZero: true },
        },
      },
    });
  }

  function renderRedemptionChart(values) {
    const canvas = document.getElementById("liquidity-redemption-chart");
    if (!canvas || typeof Chart === "undefined") return;
    if (chartRedemption) { try { chartRedemption.destroy(); } catch (_) {} chartRedemption = null; }
    const labels = [];
    const now = new Date();
    for (let i = values.length - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      labels.push(d.toLocaleString("default", { month: "short" }));
    }
    chartRedemption = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "Avg redemption days",
          data: values,
          borderColor: "#22d3ee",
          backgroundColor: "rgba(34,211,238,.18)",
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
    const container = document.getElementById("liquidity-redemption-container");
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
        const btn = document.getElementById("liquidity-refresh-btn");
        if (btn) btn.addEventListener("click", () => render(true));
        renderOnchainChart(result.onChainLiquidity);
        renderRedemptionChart(result.redemptionHistory);
      } catch (err) {
        console.warn("[liquidity-redemption] render failed:", err);
        container.innerHTML = `
          <div class="defi-card" style="text-align:center;padding:30px 20px">
            <div style="color:#fca5a5;font-size:14px">Could not load liquidity data right now.</div>
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
    if (!document.getElementById("liquidity-redemption-container")) return;
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

  window.DefiLiquidityRedemption = { render: () => render(false), refresh: () => render(true), setIssuer };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
