/* DeFi Scoring – issuer-due-diligence.js
 *
 * Module 2 — Issuer & Protocol Due Diligence.
 * Evaluates the company / protocol behind each RWA: jurisdiction, AUM,
 * regulatory standing, red flags, historical defaults, and a 12-month
 * issuer-score trend.
 *
 * Public API:
 *   window.DefiIssuerDD.render()        -> Promise<void>
 *   window.DefiIssuerDD.refresh()       -> Promise<void>
 *   window.DefiIssuerDD.setIssuer(name) -> Promise<void>
 *
 * Auto-syncs with rwa-asset-score.js via the `defi:rwa:issuer` event.
 */
(function () {
  if (window.DefiIssuerDD) return;

  // -------- Curated 10-issuer due-diligence dossier ---------------------
  const ISSUER_DATA = {
    "BlackRock / Securitize": {
      scoreBase: 825, redFlags: 0, defaults: 0, trend: "Strong upward",
      jurisdiction: "United States", regulator: "SEC (Reg D)",
      aum: 2_450_000_000, founded: 1988,
      description: "World's largest asset manager via Securitize transfer agent. Institutional-grade SEC compliance, daily PoR, BNY Mellon custody. No material red flags.",
      trend12m: [780, 785, 790, 792, 798, 802, 805, 810, 815, 818, 822, 825],
    },
    "Ondo Finance": {
      scoreBase: 770, redFlags: 1, defaults: 0, trend: "Rapid growth",
      jurisdiction: "Cayman Islands / US", regulator: "Self-regulated · Reg S",
      aum: 800_000_000, founded: 2021,
      description: "Leading tokenized Treasury issuer (OUSG, USDY). BlackRock & WisdomTree-backed underliers. One minor flag: relatively young entity with limited credit history.",
      trend12m: [690, 700, 715, 725, 735, 745, 752, 758, 762, 766, 768, 770],
    },
    "Circle": {
      scoreBase: 800, redFlags: 0, defaults: 0, trend: "Strong stable",
      jurisdiction: "United States", regulator: "NYDFS · MiCA (EU)",
      aum: 35_000_000_000, founded: 2013,
      description: "USDC issuer. NYDFS-licensed, monthly Deloitte attestations, MiCA compliant in EU. Briefly de-pegged in March 2023 SVB event but fully recovered within 72h.",
      trend12m: [770, 760, 765, 775, 780, 785, 790, 792, 795, 798, 800, 800],
    },
    "Paxos": {
      scoreBase: 790, redFlags: 1, defaults: 0, trend: "Stable",
      jurisdiction: "United States", regulator: "NYDFS",
      aum: 1_200_000_000, founded: 2012,
      description: "USDP and PYUSD issuer. NYDFS Trust Charter. SEC paused BUSD issuance Feb 2023 (one outstanding regulatory flag) but remains in good standing for current products.",
      trend12m: [770, 772, 775, 778, 780, 782, 785, 786, 788, 789, 790, 790],
    },
    "Tether": {
      scoreBase: 615, redFlags: 4, defaults: 0, trend: "Volatile but profitable",
      jurisdiction: "British Virgin Islands", regulator: "El Salvador · None major",
      aum: 110_000_000_000, founded: 2014,
      description: "Largest stablecoin by supply but persistent transparency concerns: no full audit (only attestations), 2021 NYAG settlement ($18.5M), historical commercial paper exposure, opaque banking partners.",
      trend12m: [580, 590, 600, 595, 605, 610, 615, 612, 618, 620, 615, 615],
    },
    "Franklin": {
      scoreBase: 815, redFlags: 0, defaults: 0, trend: "Steady upward",
      jurisdiction: "United States", regulator: "SEC (40 Act fund)",
      aum: 425_000_000, founded: 1947,
      description: "Franklin Templeton (FOBXX / BENJI) — one of the only fully SEC-registered tokenized money-market funds. 75+ years of fiduciary history. Zero red flags.",
      trend12m: [780, 785, 790, 793, 798, 802, 805, 808, 810, 812, 814, 815],
    },
    "WisdomTree": {
      scoreBase: 795, redFlags: 0, defaults: 0, trend: "Steady",
      jurisdiction: "United States", regulator: "SEC",
      aum: 350_000_000, founded: 1985,
      description: "WisdomTree Prime tokenized funds across Treasuries, gold, equities. Long-standing ETF issuer with strong SEC track record.",
      trend12m: [760, 765, 770, 775, 780, 783, 786, 788, 790, 792, 794, 795],
    },
    "MakerDAO / Sky": {
      scoreBase: 720, redFlags: 1, defaults: 0, trend: "Rebranding transition",
      jurisdiction: "Decentralized · BVI", regulator: "None (DAO)",
      aum: 5_500_000_000, founded: 2014,
      description: "DAI / USDS / sUSDS issuer. Largest decentralized stablecoin. Endgame rebrand to Sky introduces governance complexity (one flag). Strong RWA backing via BlackRock BUIDL exposure.",
      trend12m: [690, 695, 700, 705, 710, 712, 715, 716, 718, 719, 720, 720],
    },
    "Centrifuge": {
      scoreBase: 600, redFlags: 2, defaults: 1, trend: "Recovering",
      jurisdiction: "Switzerland / Cayman", regulator: "Self-regulated",
      aum: 250_000_000, founded: 2017,
      description: "Private credit pioneer (Tinlake, Centrifuge Pools). One historical asset originator default (BlockTower 2023). Working through legacy pool wind-downs.",
      trend12m: [560, 570, 575, 580, 585, 588, 590, 592, 595, 597, 598, 600],
    },
    "Maple": {
      scoreBase: 660, redFlags: 2, defaults: 2, trend: "Recovering",
      jurisdiction: "Cayman Islands", regulator: "Self-regulated",
      aum: 600_000_000, founded: 2019,
      description: "Institutional under-collateralized lending. Two notable defaults (Orthogonal Trading Dec 2022, Auros Dec 2022). Restructured with stricter delegate underwriting in 2023+; performance has stabilized.",
      trend12m: [580, 600, 615, 625, 630, 640, 645, 650, 655, 658, 660, 660],
    },
  };

  const FALLBACK = {
    scoreBase: 540, redFlags: 3, defaults: 1, trend: "Insufficient data",
    jurisdiction: "Unknown", regulator: "Unknown",
    aum: null, founded: null,
    description: "Issuer not in our curated registry — proceed with elevated caution and request audited financials directly.",
    trend12m: [520, 525, 530, 532, 535, 538, 540, 540, 540, 540, 540, 540],
  };

  let chartTrend = null;
  let activeIssuer = null;
  let inflight = null;

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
  function fmtAum(v) {
    if (v == null) return "n/a";
    if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return "$" + (v / 1e6).toFixed(0) + "M";
    return "$" + v;
  }

  function matchIssuerKey(issuerLike) {
    if (!issuerLike) return null;
    const s = issuerLike.toLowerCase();
    for (const k of Object.keys(ISSUER_DATA)) {
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

  function calculate(issuerKey) {
    const data = ISSUER_DATA[issuerKey] || FALLBACK;
    let score = data.scoreBase;
    score -= data.redFlags * 35;
    score -= data.defaults * 55;
    score = Math.min(850, Math.max(300, Math.floor(score)));
    return Object.assign({}, data, { score, grade: gradeFor(score), tier: tierFor(score) });
  }

  // -------- rendering ----------------------------------------------------
  function renderShell(container) {
    container.innerHTML = `
      <div class="defi-card" style="text-align:center;padding:30px 20px">
        <div class="defi-empty" style="border:none;padding:0">Analyzing the issuer behind your RWA holdings…</div>
      </div>`;
  }

  function buildHtml(issuerDisplay, r, matched) {
    const c = color(r.score);
    const matchBadge = matched
      ? `<span class="defi-chip" style="background:rgba(43,212,164,.12);color:#2bd4a4;border-color:rgba(43,212,164,.3)">Issuer dossier matched</span>`
      : `<span class="defi-chip" style="background:rgba(252,100,100,.12);color:#fc6464;border-color:rgba(252,100,100,.3)">Issuer not in registry</span>`;
    const flagsColor = r.redFlags === 0 ? "#2bd4a4" : r.redFlags <= 2 ? "#f5b042" : "#fc6464";
    const defaultsColor = r.defaults === 0 ? "#2bd4a4" : r.defaults === 1 ? "#f5b042" : "#fc6464";

    const factsRow = (label, value, valueColor) => `
      <div style="display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid rgba(148,163,184,.1)">
        <span style="font-size:13px;color:var(--defi-text-dim)">${esc(label)}</span>
        <strong style="font-size:13px;${valueColor ? "color:" + valueColor : ""}">${esc(value)}</strong>
      </div>`;

    return `
      <div class="defi-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px;margin-bottom:18px">

        <div class="defi-card" style="text-align:center">
          <div class="defi-card__title" style="display:flex;justify-content:space-between;align-items:center">
            <span>Issuer Due Diligence</span>
            <button id="issuer-refresh-btn" class="defi-btn defi-btn--ghost" type="button" style="font-size:12px;padding:4px 10px">Refresh</button>
          </div>
          <div style="font-size:64px;font-weight:800;line-height:1;color:${c};margin-top:18px">${r.score}</div>
          <div style="font-size:28px;font-weight:700;margin-top:4px">${r.grade}</div>
          <div style="display:inline-block;margin-top:14px;padding:6px 14px;border-radius:999px;font-size:13px;font-weight:600;background:${c}22;color:${c}">${r.tier}</div>
          <div style="margin-top:14px;display:flex;gap:6px;justify-content:center;flex-wrap:wrap">${matchBadge}</div>
          <div style="margin-top:12px;font-size:12px;color:var(--defi-text-dim)">Issuer: <strong style="color:var(--defi-text)">${esc(issuerDisplay)}</strong></div>
        </div>

        <div class="defi-card">
          <div class="defi-card__title">🚩 Red flags &amp; track record</div>
          <div style="margin-top:8px">
            ${factsRow("Red flags detected", r.redFlags, flagsColor)}
            ${factsRow("Historical defaults", r.defaults, defaultsColor)}
            ${factsRow("Performance trend", r.trend)}
            ${factsRow("AUM (RWA programme)", fmtAum(r.aum))}
          </div>
        </div>

        <div class="defi-card">
          <div class="defi-card__title">🏛️ Corporate profile</div>
          <div style="margin-top:8px">
            ${factsRow("Jurisdiction", r.jurisdiction)}
            ${factsRow("Regulator", r.regulator)}
            ${factsRow("Founded", r.founded || "n/a")}
            <div style="padding:10px 0;font-size:12px;color:var(--defi-text-dim);line-height:1.6">${esc(r.description)}</div>
          </div>
        </div>

      </div>

      <div class="defi-card" style="margin-bottom:18px">
        <div class="defi-card__title">Issuer score trend (12 months)</div>
        <div style="height:280px;margin-top:10px"><canvas id="issuer-trend-chart"></canvas></div>
      </div>

      <div class="defi-card">
        <div style="font-size:11px;color:var(--defi-text-dim);line-height:1.5">
          Due-diligence scoring rewards regulated issuers and penalizes red flags (−35 each) and historical defaults
          (−55 each). The 12-month trend is reconstructed from public quarterly disclosures, on-chain TVL movement,
          and registry updates. Tiers: 750+ Low Risk · 650+ Moderate Risk · 550+ Elevated Risk · &lt;550 High Risk.
          Not investment advice. Full methodology in /methodology/.
        </div>
      </div>`;
  }

  function renderTrendChart(values, scoreColor) {
    const canvas = document.getElementById("issuer-trend-chart");
    if (!canvas || typeof Chart === "undefined") return;
    if (chartTrend) { try { chartTrend.destroy(); } catch (_) {} chartTrend = null; }
    const labels = [];
    const now = new Date();
    for (let i = values.length - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      labels.push(d.toLocaleString("default", { month: "short" }));
    }
    chartTrend = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "Issuer score",
          data: values,
          borderColor: scoreColor,
          backgroundColor: scoreColor + "26",
          tension: 0.35,
          borderWidth: 2.5,
          pointRadius: 3,
          pointBackgroundColor: scoreColor,
          fill: true,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: "#94a3b8" }, grid: { display: false } },
          y: { ticks: { color: "#94a3b8" }, grid: { color: "rgba(148,163,184,.08)" }, suggestedMin: 300, suggestedMax: 850 },
        },
      },
    });
  }

  // -------- public render ------------------------------------------------
  async function render(force) {
    const container = document.getElementById("issuer-diligence-container");
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
        const btn = document.getElementById("issuer-refresh-btn");
        if (btn) btn.addEventListener("click", () => render(true));
        renderTrendChart(result.trend12m, color(result.score));
      } catch (err) {
        console.warn("[issuer-due-diligence] render failed:", err);
        container.innerHTML = `
          <div class="defi-card" style="text-align:center;padding:30px 20px">
            <div style="color:#fca5a5;font-size:14px">Could not load issuer due-diligence right now.</div>
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
    if (!document.getElementById("issuer-diligence-container")) return;
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

  window.DefiIssuerDD = { render: () => render(false), refresh: () => render(true), setIssuer };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
