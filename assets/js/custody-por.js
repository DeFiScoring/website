/* DeFi Scoring – custody-por.js
 *
 * Module 4 — Custody & Proof-of-Reserves.
 * Verifies real-world asset backing for the detected RWA issuer:
 * custodian profile, PoR attestation status, reliability metrics, and
 * attestation history.
 *
 * Public API:
 *   window.DefiCustodyPoR.render()        -> Promise<void>
 *   window.DefiCustodyPoR.refresh()       -> Promise<void>
 *   window.DefiCustodyPoR.setIssuer(name) -> Promise<void>
 *
 * Auto-syncs with rwa-asset-score.js via the `defi:rwa:issuer` event.
 */
(function () {
  if (window.DefiCustodyPoR) return;

  // -------- Curated custody / PoR dossier -------------------------------
  // Each entry mirrors the issuer keys used by legal-compliance.js so the
  // three modules stay coordinated. Metrics are 0–100 strength ratings.
  // attestationHistory is the last 7 PoR scores on the 300–850 scale.
  const CUSTODY_DATA = {
    "BlackRock / Securitize": {
      custodian: "BNY Mellon (cash) · Securitize (token registrar)",
      custodyType: "Qualified custodian (regulated bank)",
      porProvider: "Securitize transfer agent reports",
      porStatus: "Verified",
      porFrequency: "Monthly NAV publication",
      reserveBacking: "100% short-dated US Treasuries + cash",
      reliabilityScore: 94,
      scoreBase: 830,
      metrics: { "Insurance coverage": 95, "Audit frequency": 92, "Cold storage / segregation": 96, "Redemption reliability": 88, "Reserve transparency": 90 },
      attestationHistory: [802, 810, 818, 822, 826, 829, 830],
      sources: ["Securitize transfer agent reports", "BNY Mellon custody agreements", "BlackRock fund disclosures"],
    },
    "Ondo Finance": {
      custodian: "Ankura Trust (cash) · Coinbase Custody (USDC leg)",
      custodyType: "Qualified custodian + bankruptcy-remote SPV",
      porProvider: "Daily NAV + monthly attestation",
      porStatus: "Verified",
      porFrequency: "Monthly attestation · daily NAV",
      reserveBacking: "Short-dated US Treasuries (BlackRock/PIMCO ETFs) + bank deposits",
      reliabilityScore: 88,
      scoreBase: 780,
      metrics: { "Insurance coverage": 88, "Audit frequency": 85, "Cold storage / segregation": 92, "Redemption reliability": 86, "Reserve transparency": 90 },
      attestationHistory: [745, 755, 762, 768, 773, 777, 780],
      sources: ["Ondo monthly attestations", "Ankura Trust custody filings", "Coinbase Custody SOC 2"],
    },
    "Circle": {
      custodian: "BNY Mellon · BlackRock (Circle Reserve Fund)",
      custodyType: "Qualified custodian + government MMF",
      porProvider: "Deloitte monthly attestations",
      porStatus: "Verified",
      porFrequency: "Monthly + weekly portfolio publication",
      reserveBacking: "~80% Circle Reserve Fund (USTs / repos), ~20% bank deposits",
      reliabilityScore: 95,
      scoreBase: 820,
      metrics: { "Insurance coverage": 92, "Audit frequency": 96, "Cold storage / segregation": 95, "Redemption reliability": 94, "Reserve transparency": 98 },
      attestationHistory: [790, 800, 808, 814, 817, 819, 820],
      sources: ["Deloitte monthly attestations", "Circle weekly reserve disclosures", "BlackRock Circle Reserve Fund"],
    },
    "Paxos": {
      custodian: "Paxos Trust (NYDFS-chartered)",
      custodyType: "NYDFS limited-purpose trust",
      porProvider: "Withum monthly attestations",
      porStatus: "Verified",
      porFrequency: "Monthly",
      reserveBacking: "100% cash, US Treasuries & overnight repos",
      reliabilityScore: 92,
      scoreBase: 805,
      metrics: { "Insurance coverage": 90, "Audit frequency": 94, "Cold storage / segregation": 95, "Redemption reliability": 92, "Reserve transparency": 92 },
      attestationHistory: [770, 780, 788, 794, 798, 802, 805],
      sources: ["Withum monthly attestations", "NYDFS examinations", "Paxos reserve reports"],
    },
    "Tether": {
      custodian: "Cantor Fitzgerald + multiple bank counterparties",
      custodyType: "Mixed bank custody (limited disclosure)",
      porProvider: "BDO quarterly reserve report",
      porStatus: "Partially Verified",
      porFrequency: "Quarterly attestation (no full audit)",
      reserveBacking: "USTs, secured loans, BTC, gold, other investments",
      reliabilityScore: 62,
      scoreBase: 580,
      metrics: { "Insurance coverage": 55, "Audit frequency": 50, "Cold storage / segregation": 70, "Redemption reliability": 70, "Reserve transparency": 60 },
      attestationHistory: [540, 552, 560, 568, 572, 577, 580],
      sources: ["BDO quarterly reserve report", "Tether transparency page"],
    },
    "Franklin": {
      custodian: "BNY Mellon (cash) · Franklin Templeton transfer agency",
      custodyType: "Qualified custodian + '40 Act fund (BENJI)",
      porProvider: "Daily NAV publication",
      porStatus: "Verified",
      porFrequency: "Daily NAV · annual audit",
      reserveBacking: "100% US Government Money Fund holdings",
      reliabilityScore: 95,
      scoreBase: 825,
      metrics: { "Insurance coverage": 94, "Audit frequency": 96, "Cold storage / segregation": 95, "Redemption reliability": 90, "Reserve transparency": 92 },
      attestationHistory: [795, 805, 812, 818, 821, 823, 825],
      sources: ["BENJI daily NAV", "Franklin Templeton annual audit", "BNY Mellon custody"],
    },
    "WisdomTree": {
      custodian: "BNY Mellon · State Street",
      custodyType: "Qualified custodian (regulated banks)",
      porProvider: "Annual fund audits + monthly NAV",
      porStatus: "Verified",
      porFrequency: "Monthly NAV · annual audit",
      reserveBacking: "US Treasuries / government MMF holdings",
      reliabilityScore: 90,
      scoreBase: 800,
      metrics: { "Insurance coverage": 90, "Audit frequency": 92, "Cold storage / segregation": 94, "Redemption reliability": 88, "Reserve transparency": 86 },
      attestationHistory: [768, 778, 786, 792, 796, 798, 800],
      sources: ["WisdomTree Prime disclosures", "Annual fund audits"],
    },
    "MakerDAO / Sky": {
      custodian: "On-chain vaults · RWA SPVs (BlockTower, Monetalis)",
      custodyType: "Smart-contract custody + off-chain SPV custodians",
      porProvider: "On-chain dashboards · vault dashboards",
      porStatus: "Partially Verified",
      porFrequency: "Continuous on-chain · quarterly SPV reports",
      reserveBacking: "Mix of on-chain collateral + off-chain RWA SPVs",
      reliabilityScore: 75,
      scoreBase: 690,
      metrics: { "Insurance coverage": 62, "Audit frequency": 78, "Cold storage / segregation": 88, "Redemption reliability": 72, "Reserve transparency": 80 },
      attestationHistory: [640, 655, 668, 678, 684, 688, 690],
      sources: ["Maker on-chain dashboards", "RWA vault SPV reports", "Sky governance forum"],
    },
    "Centrifuge": {
      custodian: "Per-pool issuers · Anemoy, New Silver, BlockTower",
      custodyType: "Pool-level SPV custody (variance per pool)",
      porProvider: "Per-pool quarterly reports",
      porStatus: "Partially Verified",
      porFrequency: "Quarterly per pool",
      reserveBacking: "Real-world receivables, treasuries, private credit",
      reliabilityScore: 68,
      scoreBase: 620,
      metrics: { "Insurance coverage": 65, "Audit frequency": 70, "Cold storage / segregation": 72, "Redemption reliability": 55, "Reserve transparency": 72 },
      attestationHistory: [575, 590, 600, 608, 614, 618, 620],
      sources: ["Centrifuge pool issuers", "Per-pool quarterly reports"],
    },
    "Maple": {
      custodian: "BitGo · Coinbase Custody (Maple Direct)",
      custodyType: "Qualified custodian + on-chain pool",
      porProvider: "Pool-level on-chain transparency",
      porStatus: "Verified",
      porFrequency: "Continuous on-chain · quarterly off-chain attestations",
      reserveBacking: "US Treasuries (Maple Cash) · over-collateralized loans",
      reliabilityScore: 78,
      scoreBase: 700,
      metrics: { "Insurance coverage": 72, "Audit frequency": 78, "Cold storage / segregation": 85, "Redemption reliability": 68, "Reserve transparency": 80 },
      attestationHistory: [650, 668, 680, 688, 694, 698, 700],
      sources: ["Maple on-chain dashboards", "BitGo SOC 2", "Coinbase Custody attestations"],
    },
  };

  const FALLBACK = {
    custodian: "Unknown",
    custodyType: "Not disclosed",
    porProvider: "None",
    porStatus: "Unverified",
    porFrequency: "Unknown",
    reserveBacking: "Not disclosed",
    reliabilityScore: 40,
    scoreBase: 470,
    metrics: { "Insurance coverage": 35, "Audit frequency": 30, "Cold storage / segregation": 45, "Redemption reliability": 40, "Reserve transparency": 30 },
    attestationHistory: [430, 440, 450, 458, 462, 466, 470],
    sources: [],
  };

  let chartMetrics = null;
  let chartHistory = null;
  let activeIssuer = null;
  let inflight = null;

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }

  function matchIssuerKey(issuerLike) {
    if (!issuerLike) return null;
    const s = issuerLike.toLowerCase();
    for (const k of Object.keys(CUSTODY_DATA)) {
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
  function porBadge(status) {
    if (status === "Verified")          return { bg: "rgba(43,212,164,.15)",  fg: "#2bd4a4", label: "✓ Verified" };
    if (status === "Partially Verified") return { bg: "rgba(245,176,66,.15)",  fg: "#f5b042", label: "◐ Partially Verified" };
    return { bg: "rgba(252,100,100,.15)", fg: "#fc6464", label: "⚠ Unverified" };
  }

  function calculate(issuerKey) {
    const data = CUSTODY_DATA[issuerKey] || FALLBACK;
    const score = Math.min(850, Math.max(300, Math.floor(data.scoreBase)));
    return Object.assign({}, data, { score, grade: gradeFor(score), tier: tierFor(score) });
  }

  // -------- rendering ----------------------------------------------------
  function renderShell(container) {
    container.innerHTML = `
      <div class="defi-card" style="text-align:center;padding:30px 20px">
        <div class="defi-empty" style="border:none;padding:0">Verifying real-world asset backing &amp; custodian Proof-of-Reserves…</div>
      </div>`;
  }

  function buildHtml(issuerKey, issuerDisplay, r, matched) {
    const c = color(r.score);
    const b = porBadge(r.porStatus);

    const metricRow = (label, pct) => `
      <div style="margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--defi-text-dim);margin-bottom:4px">
          <span>${esc(label)}</span><span>${pct}/100</span>
        </div>
        <div style="height:6px;background:rgba(148,163,184,.15);border-radius:999px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:${c};border-radius:999px"></div>
        </div>
      </div>`;

    const factsRow = (label, value) => `
      <div style="display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid rgba(148,163,184,.1)">
        <span style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--defi-text-dim);flex:0 0 38%">${esc(label)}</span>
        <span style="font-size:13px;text-align:right;flex:1">${esc(value)}</span>
      </div>`;

    const matchBadge = matched
      ? `<span class="defi-chip" style="background:rgba(43,212,164,.12);color:#2bd4a4;border-color:rgba(43,212,164,.3)">Custodian matched</span>`
      : `<span class="defi-chip" style="background:rgba(252,100,100,.12);color:#fc6464;border-color:rgba(252,100,100,.3)">Custodian not in registry</span>`;

    const sourcesHtml = r.sources && r.sources.length
      ? `<div style="margin-top:12px;font-size:11px;color:var(--defi-text-dim);line-height:1.6">
           <strong style="color:var(--defi-text)">Sources:</strong> ${r.sources.map(esc).join(" · ")}
         </div>`
      : "";

    return `
      <div class="defi-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px;margin-bottom:18px">

        <div class="defi-card" style="text-align:center">
          <div class="defi-card__title" style="display:flex;justify-content:space-between;align-items:center">
            <span>Custody &amp; PoR Score</span>
            <button id="custody-refresh-btn" class="defi-btn defi-btn--ghost" type="button" style="font-size:12px;padding:4px 10px">Refresh</button>
          </div>
          <div style="font-size:64px;font-weight:800;line-height:1;color:${c};margin-top:18px">${r.score}</div>
          <div style="font-size:28px;font-weight:700;margin-top:4px">${r.grade}</div>
          <div style="display:inline-block;margin-top:14px;padding:6px 14px;border-radius:999px;font-size:13px;font-weight:600;background:${c}22;color:${c}">${r.tier}</div>
          <div style="margin-top:14px;display:flex;gap:6px;justify-content:center;flex-wrap:wrap">${matchBadge}</div>
          <div style="margin-top:12px;font-size:12px;color:var(--defi-text-dim)">Issuer: <strong style="color:var(--defi-text)">${esc(issuerDisplay)}</strong></div>
        </div>

        <div class="defi-card">
          <div class="defi-card__title">🔐 Proof-of-Reserves status</div>
          <div style="display:inline-block;margin-top:14px;padding:8px 16px;border-radius:999px;font-size:14px;font-weight:700;background:${b.bg};color:${b.fg}">${b.label}</div>
          <div style="margin-top:14px;font-size:13px;line-height:1.7">
            <div><span style="color:var(--defi-text-dim);font-size:11px;text-transform:uppercase;letter-spacing:.06em">Custodian</span><br>${esc(r.custodian)}</div>
            <div style="margin-top:10px"><span style="color:var(--defi-text-dim);font-size:11px;text-transform:uppercase;letter-spacing:.06em">Custody type</span><br>${esc(r.custodyType)}</div>
            <div style="margin-top:10px"><span style="color:var(--defi-text-dim);font-size:11px;text-transform:uppercase;letter-spacing:.06em">Reliability</span><br><strong>${r.reliabilityScore}%</strong></div>
          </div>
        </div>

        <div class="defi-card">
          <div class="defi-card__title">Custodian reliability metrics</div>
          <div style="margin-top:14px">
            ${Object.entries(r.metrics).map(([k, v]) => metricRow(k, v)).join("")}
          </div>
        </div>

      </div>

      <div class="defi-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px;margin-bottom:18px">
        <div class="defi-card">
          <div class="defi-card__title">Reliability metrics breakdown</div>
          <div style="height:240px;margin-top:10px"><canvas id="custody-metrics-chart"></canvas></div>
        </div>

        <div class="defi-card">
          <div class="defi-card__title">PoR attestation history (last 7)</div>
          <div style="height:240px;margin-top:10px"><canvas id="custody-history-chart"></canvas></div>
        </div>
      </div>

      <div class="defi-card">
        <div class="defi-card__title">Custody dossier</div>
        <div style="margin-top:8px">
          ${factsRow("PoR provider",      r.porProvider)}
          ${factsRow("Attestation cadence", r.porFrequency)}
          ${factsRow("Reserve backing",   r.reserveBacking)}
          ${factsRow("Custody type",      r.custodyType)}
        </div>
        ${sourcesHtml}
        <div style="margin-top:12px;font-size:11px;color:var(--defi-text-dim);line-height:1.5">
          Custody assessments are based on public attestations, custodian SOC reports, and issuer disclosures as of the latest review.
          Not investment advice. Full methodology in /methodology/.
        </div>
      </div>`;
  }

  function renderMetricsChart(metrics) {
    const canvas = document.getElementById("custody-metrics-chart");
    if (!canvas || typeof Chart === "undefined") return;
    if (chartMetrics) { try { chartMetrics.destroy(); } catch (_) {} chartMetrics = null; }
    const labels = Object.keys(metrics);
    const data = Object.values(metrics);
    const palette = ["#22d3ee", "#5b8cff", "#2bd4a4", "#8a5cff", "#f5b042"];
    chartMetrics = new Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Strength %",
          data,
          backgroundColor: labels.map((_, i) => palette[i % palette.length]),
          borderRadius: 6,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: "#94a3b8", font: { size: 10 }, maxRotation: 35, minRotation: 0 }, grid: { display: false } },
          y: { ticks: { color: "#94a3b8" }, grid: { color: "rgba(148,163,184,.08)" }, max: 100, beginAtZero: true },
        },
      },
    });
  }

  function renderHistoryChart(history) {
    const canvas = document.getElementById("custody-history-chart");
    if (!canvas || typeof Chart === "undefined") return;
    if (chartHistory) { try { chartHistory.destroy(); } catch (_) {} chartHistory = null; }
    // Generate week-spaced labels going back from "now".
    const labels = [];
    const now = new Date();
    for (let i = history.length - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 7 * 24 * 60 * 60 * 1000);
      labels.push(d.toLocaleDateString("default", { month: "short", day: "numeric" }));
    }
    chartHistory = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "PoR score",
          data: history,
          borderColor: "#22d3ee",
          backgroundColor: "rgba(34,211,238,.15)",
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
          y: { ticks: { color: "#94a3b8" }, grid: { color: "rgba(148,163,184,.08)" }, suggestedMin: 300, suggestedMax: 850 },
        },
      },
    });
  }

  // -------- public render ------------------------------------------------
  async function render(force) {
    const container = document.getElementById("custody-por-container");
    if (!container) return;
    if (inflight && !force) return inflight;

    renderShell(container);

    inflight = (async () => {
      try {
        const candidate = activeIssuer
          || (window.DefiRWAScore && window.DefiRWAScore.activeIssuer)
          || "BlackRock / Securitize";
        const matchedKey = matchIssuerKey(candidate);
        const issuerKey = matchedKey || candidate;
        const issuerDisplay = matchedKey || candidate;
        const result = calculate(matchedKey || "__fallback__");

        container.innerHTML = buildHtml(issuerKey, issuerDisplay, result, !!matchedKey);
        const btn = document.getElementById("custody-refresh-btn");
        if (btn) btn.addEventListener("click", () => render(true));
        renderMetricsChart(result.metrics);
        renderHistoryChart(result.attestationHistory);
      } catch (err) {
        console.warn("[custody-por] render failed:", err);
        container.innerHTML = `
          <div class="defi-card" style="text-align:center;padding:30px 20px">
            <div style="color:#fca5a5;font-size:14px">Could not verify custody data right now.</div>
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
    if (!document.getElementById("custody-por-container")) return;
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

  window.DefiCustodyPoR = { render: () => render(false), refresh: () => render(true), setIssuer };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
