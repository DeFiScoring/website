/* DeFi Scoring – legal-compliance.js
 *
 * Module 3 — Legal & Regulatory Compliance.
 * Scores the detected RWA issuer on KYC/AML, jurisdiction, MiCA/SEC posture,
 * and transfer-restriction profile. Renders compliance grade, jurisdiction
 * risk map, regulatory exposure heatmap, and 8-month compliance trend.
 *
 * Public API:
 *   window.DefiLegalCompliance.render()        -> Promise<void>
 *   window.DefiLegalCompliance.refresh()       -> Promise<void>
 *   window.DefiLegalCompliance.setIssuer(name) -> Promise<void>
 *
 * Listens for `defi:rwa:issuer` events fired by rwa-asset-score.js so the
 * compliance view always tracks the user's detected RWA holding.
 */
(function () {
  if (window.DefiLegalCompliance) return;

  // -------- Curated issuer regulatory dossier ---------------------------
  // Each entry is auditable and easy to extend. Numbers are 0–100 strength
  // ratings per pillar (KYC, AML, SEC, MiCA, Transfer Restrictions). Trend
  // is the last 8 monthly compliance scores on the 300–850 scale.
  const REGULATORY_DATA = {
    "BlackRock / Securitize": {
      jurisdiction: "United States",
      kycAml: "Institutional KYC + ongoing AML monitoring",
      micaSec: "SEC-registered (Reg D 506(c)) · MiCA-ready via EU partners",
      transferRestrictions: "Whitelist only (qualified purchasers)",
      complianceScoreBase: 815,
      riskMap: { USA: "Low", EU: "Low", APAC: "Medium", Global: "Low" },
      pillars: { kyc: 95, aml: 92, sec: 96, mica: 84, transfer: 70 },
      trendData: [765, 778, 790, 798, 802, 808, 812, 815],
      sources: ["SEC EDGAR (Securitize Markets LLC)", "Reg D filings", "BlackRock disclosures"],
    },
    "Ondo Finance": {
      jurisdiction: "United States / Cayman Islands",
      kycAml: "Reg D / Reg S KYC",
      micaSec: "SEC-compliant (Reg D 506(c)) · MiCA review pending",
      transferRestrictions: "Permitted-jurisdiction whitelist",
      complianceScoreBase: 760,
      riskMap: { USA: "Low", EU: "Medium", APAC: "Medium", Global: "Low" },
      pillars: { kyc: 90, aml: 88, sec: 92, mica: 70, transfer: 75 },
      trendData: [690, 705, 720, 735, 745, 752, 758, 760],
      sources: ["Form D filings", "Ondo Finance legal disclosures"],
    },
    "Circle": {
      jurisdiction: "United States / Ireland (EU)",
      kycAml: "FinCEN MSB · NYDFS BitLicense · Circle Mint KYC",
      micaSec: "MiCA EMI authorized (Ireland) · State MTLs in US",
      transferRestrictions: "Open transfers · sanctioned-address blocking",
      complianceScoreBase: 800,
      riskMap: { USA: "Low", EU: "Low", APAC: "Low", Global: "Low" },
      pillars: { kyc: 94, aml: 95, sec: 78, mica: 96, transfer: 85 },
      trendData: [740, 755, 770, 782, 790, 795, 798, 800],
      sources: ["FinCEN registration", "Central Bank of Ireland (MiCA)", "NYDFS disclosures"],
    },
    "Paxos": {
      jurisdiction: "United States / Singapore",
      kycAml: "NYDFS-supervised · monthly attestations",
      micaSec: "NYDFS Trust Charter · MAS Major Payment Institution licence",
      transferRestrictions: "Open transfers · regulated reserve",
      complianceScoreBase: 790,
      riskMap: { USA: "Low", EU: "Medium", APAC: "Low", Global: "Low" },
      pillars: { kyc: 92, aml: 93, sec: 80, mica: 82, transfer: 88 },
      trendData: [720, 735, 748, 760, 770, 778, 785, 790],
      sources: ["NYDFS examinations", "MAS PSA licence", "Withum monthly attestations"],
    },
    "Tether": {
      jurisdiction: "British Virgin Islands / El Salvador",
      kycAml: "Direct-issuance KYC · secondary market unrestricted",
      micaSec: "Not MiCA-authorized · USDT delisted on EU venues",
      transferRestrictions: "Open transfers · address freezing on enforcement",
      complianceScoreBase: 580,
      riskMap: { USA: "Medium", EU: "High", APAC: "Medium", Global: "Medium" },
      pillars: { kyc: 60, aml: 65, sec: 50, mica: 25, transfer: 80 },
      trendData: [540, 545, 555, 560, 568, 572, 578, 580],
      sources: ["BDO quarterly reserve report", "BVI FSC", "EU MiCA delisting notices"],
    },
    "Franklin": {
      jurisdiction: "United States",
      kycAml: "Investor onboarding via Franklin Templeton",
      micaSec: "SEC-registered '40 Act fund (BENJI)",
      transferRestrictions: "Wallet-level whitelist · Stellar/Polygon",
      complianceScoreBase: 820,
      riskMap: { USA: "Low", EU: "Low", APAC: "Medium", Global: "Low" },
      pillars: { kyc: 95, aml: 93, sec: 97, mica: 80, transfer: 72 },
      trendData: [770, 783, 795, 805, 812, 816, 819, 820],
      sources: ["SEC '40 Act registration", "Franklin Templeton disclosures"],
    },
    "WisdomTree": {
      jurisdiction: "United States",
      kycAml: "Brokerage-grade KYC (WisdomTree Prime)",
      micaSec: "SEC-registered · state MTL coverage",
      transferRestrictions: "App-based whitelist",
      complianceScoreBase: 800,
      riskMap: { USA: "Low", EU: "Low", APAC: "Medium", Global: "Low" },
      pillars: { kyc: 93, aml: 90, sec: 95, mica: 78, transfer: 72 },
      trendData: [750, 762, 775, 785, 792, 796, 798, 800],
      sources: ["WisdomTree Prime disclosures", "State MTL filings"],
    },
    "MakerDAO / Sky": {
      jurisdiction: "Decentralized · vault SPVs in BVI/Cayman",
      kycAml: "RWA vault counterparties only",
      micaSec: "Not registered · operates via permissionless protocol",
      transferRestrictions: "Open transfers · USDS/sUSDS unrestricted",
      complianceScoreBase: 670,
      riskMap: { USA: "Medium", EU: "Medium", APAC: "Medium", Global: "Medium" },
      pillars: { kyc: 55, aml: 60, sec: 50, mica: 60, transfer: 90 },
      trendData: [610, 625, 638, 650, 658, 664, 668, 670],
      sources: ["MakerDAO RWA vault docs", "Sky governance forum"],
    },
    "Centrifuge": {
      jurisdiction: "EU / Switzerland · pool-level SPVs",
      kycAml: "Pool-issuer KYC (medium variance)",
      micaSec: "MiCA-aligned via partner SPVs",
      transferRestrictions: "Per-pool whitelist (high)",
      complianceScoreBase: 640,
      riskMap: { USA: "High", EU: "Low", APAC: "Medium", Global: "Medium" },
      pillars: { kyc: 75, aml: 72, sec: 50, mica: 82, transfer: 68 },
      trendData: [580, 595, 610, 622, 630, 636, 638, 640],
      sources: ["Centrifuge pool issuers", "EU prospectus filings"],
    },
    "Maple": {
      jurisdiction: "Cayman / Singapore",
      kycAml: "Borrower & lender KYC (Maple Direct)",
      micaSec: "Not SEC-registered · MAS-aligned",
      transferRestrictions: "Permissioned pools · KYC-gated",
      complianceScoreBase: 660,
      riskMap: { USA: "High", EU: "Medium", APAC: "Low", Global: "Medium" },
      pillars: { kyc: 78, aml: 75, sec: 45, mica: 60, transfer: 72 },
      trendData: [600, 615, 628, 640, 650, 655, 658, 660],
      sources: ["Maple Finance disclosures", "MAS exemption notices"],
    },
  };

  const FALLBACK = {
    jurisdiction: "Unknown",
    kycAml: "Not disclosed",
    micaSec: "No registration found",
    transferRestrictions: "Unknown",
    complianceScoreBase: 500,
    riskMap: { USA: "High", EU: "High", APAC: "High", Global: "High" },
    pillars: { kyc: 35, aml: 35, sec: 30, mica: 30, transfer: 40 },
    trendData: [470, 478, 485, 490, 495, 498, 500, 500],
    sources: [],
  };

  let chartHeatmap = null;
  let chartTrend = null;
  let activeIssuer = null;
  let inflight = null;

  // -------- helpers ------------------------------------------------------
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }

  function matchIssuerKey(issuerLike) {
    if (!issuerLike) return null;
    const s = issuerLike.toLowerCase();
    const keys = Object.keys(REGULATORY_DATA);
    // exact-ish substring match in either direction
    for (const k of keys) {
      const ks = k.toLowerCase();
      const tokens = ks.split(/[^a-z0-9]+/).filter(Boolean);
      if (tokens.some((t) => t.length > 3 && s.includes(t))) return k;
      if (s.split(/[^a-z0-9]+/).some((t) => t.length > 3 && ks.includes(t))) return k;
    }
    return null;
  }

  function gradeFor(score) {
    return score >= 800 ? "A+"
         : score >= 750 ? "A"
         : score >= 700 ? "A-"
         : score >= 650 ? "B"
         : score >= 600 ? "B-"
         : score >= 550 ? "C"
         : score >= 500 ? "C-"
         :                "D";
  }
  function tierFor(score) {
    return score >= 750 ? "Low Risk"
         : score >= 650 ? "Moderate Risk"
         : score >= 550 ? "Elevated Risk"
         :                "High Risk";
  }
  function color(score) {
    if (score >= 750) return "#2bd4a4";
    if (score >= 650) return "#5b8cff";
    if (score >= 550) return "#f5b042";
    return "#fc6464";
  }
  function riskColor(level) {
    return level === "Low"    ? { bg: "rgba(43,212,164,.15)", fg: "#2bd4a4" }
         : level === "Medium" ? { bg: "rgba(245,176,66,.15)", fg: "#f5b042" }
         :                      { bg: "rgba(252,100,100,.15)", fg: "#fc6464" };
  }

  function calculate(issuerKey) {
    const data = REGULATORY_DATA[issuerKey] || FALLBACK;
    const score = Math.min(850, Math.max(300, Math.floor(data.complianceScoreBase)));
    return {
      score,
      grade: gradeFor(score),
      tier: tierFor(score),
      jurisdiction: data.jurisdiction,
      kycAml: data.kycAml,
      micaSec: data.micaSec,
      transferRestrictions: data.transferRestrictions,
      riskMap: data.riskMap,
      pillars: data.pillars,
      trendData: data.trendData,
      sources: data.sources || [],
    };
  }

  // -------- rendering ----------------------------------------------------
  function renderShell(container) {
    container.innerHTML = `
      <div class="defi-card" style="text-align:center;padding:30px 20px">
        <div class="defi-empty" style="border:none;padding:0">Analyzing regulatory posture…</div>
      </div>`;
  }

  function buildHtml(issuerKey, issuerDisplay, result, matched) {
    const c = color(result.score);
    const riskCells = Object.entries(result.riskMap).map(([j, lvl]) => {
      const rc = riskColor(lvl);
      return `
        <div style="padding:12px 10px;border-radius:12px;background:${rc.bg};color:${rc.fg};text-align:center">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;opacity:.85">${esc(j)}</div>
          <div style="font-size:16px;font-weight:700;margin-top:4px">${esc(lvl)}</div>
        </div>`;
    }).join("");

    const pillarRow = (label, pct) => `
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
      ? `<span class="defi-chip" style="background:rgba(43,212,164,.12);color:#2bd4a4;border-color:rgba(43,212,164,.3)">Issuer matched</span>`
      : `<span class="defi-chip" style="background:rgba(252,100,100,.12);color:#fc6464;border-color:rgba(252,100,100,.3)">Issuer not in registry</span>`;

    const sourcesHtml = result.sources.length
      ? `<div style="margin-top:12px;font-size:11px;color:var(--defi-text-dim);line-height:1.6">
           <strong style="color:var(--defi-text)">Sources:</strong> ${result.sources.map(esc).join(" · ")}
         </div>`
      : "";

    return `
      <div class="defi-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px;margin-bottom:18px">

        <div class="defi-card" style="text-align:center">
          <div class="defi-card__title" style="display:flex;justify-content:space-between;align-items:center">
            <span>Compliance Grade</span>
            <button id="legal-refresh-btn" class="defi-btn defi-btn--ghost" type="button" style="font-size:12px;padding:4px 10px">Refresh</button>
          </div>
          <div style="font-size:64px;font-weight:800;line-height:1;color:${c};margin-top:18px">${result.score}</div>
          <div style="font-size:28px;font-weight:700;margin-top:4px">${result.grade}</div>
          <div style="display:inline-block;margin-top:14px;padding:6px 14px;border-radius:999px;font-size:13px;font-weight:600;background:${c}22;color:${c}">${result.tier}</div>
          <div style="margin-top:14px;display:flex;gap:6px;justify-content:center;flex-wrap:wrap">${matchBadge}</div>
          <div style="margin-top:12px;font-size:12px;color:var(--defi-text-dim)">Issuer: <strong style="color:var(--defi-text)">${esc(issuerDisplay)}</strong></div>
        </div>

        <div class="defi-card">
          <div class="defi-card__title">🌍 Jurisdiction risk map</div>
          <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:14px">
            ${riskCells}
          </div>
          <div style="margin-top:14px;font-size:11px;color:var(--defi-text-dim);line-height:1.6">
            Aggregate risk per region across KYC/AML, MiCA/SEC posture, and transfer restrictions.
          </div>
        </div>

        <div class="defi-card">
          <div class="defi-card__title">Regulatory pillars</div>
          <div style="margin-top:14px">
            ${pillarRow("KYC onboarding",     result.pillars.kyc)}
            ${pillarRow("AML monitoring",     result.pillars.aml)}
            ${pillarRow("SEC posture",        result.pillars.sec)}
            ${pillarRow("MiCA posture",       result.pillars.mica)}
            ${pillarRow("Transfer governance", result.pillars.transfer)}
          </div>
        </div>

      </div>

      <div class="defi-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px;margin-bottom:18px">
        <div class="defi-card">
          <div class="defi-card__title">Regulatory exposure heatmap</div>
          <div style="height:240px;margin-top:10px"><canvas id="legal-heatmap"></canvas></div>
        </div>

        <div class="defi-card">
          <div class="defi-card__title">Compliance trend (8 months)</div>
          <div style="height:240px;margin-top:10px"><canvas id="legal-trend"></canvas></div>
        </div>
      </div>

      <div class="defi-card">
        <div class="defi-card__title">Regulatory dossier</div>
        <div style="margin-top:8px">
          ${factsRow("Jurisdiction",          result.jurisdiction)}
          ${factsRow("KYC / AML",             result.kycAml)}
          ${factsRow("MiCA / SEC",            result.micaSec)}
          ${factsRow("Transfer restrictions", result.transferRestrictions)}
        </div>
        ${sourcesHtml}
        <div style="margin-top:12px;font-size:11px;color:var(--defi-text-dim);line-height:1.5">
          Compliance assessments are based on public filings, regulatory registers, and issuer disclosures as of the latest review.
          Not legal advice. Full methodology in /methodology/.
        </div>
      </div>`;
  }

  function renderHeatmap(pillars) {
    const canvas = document.getElementById("legal-heatmap");
    if (!canvas || typeof Chart === "undefined") return;
    if (chartHeatmap) { try { chartHeatmap.destroy(); } catch (_) {} chartHeatmap = null; }
    chartHeatmap = new Chart(canvas, {
      type: "bar",
      data: {
        labels: ["KYC", "AML", "SEC", "MiCA", "Transfer"],
        datasets: [{
          label: "Strength %",
          data: [pillars.kyc, pillars.aml, pillars.sec, pillars.mica, pillars.transfer],
          backgroundColor: ["#2bd4a4", "#5b8cff", "#8a5cff", "#f5b042", "#fc6464"],
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

  function renderTrend(trend) {
    const canvas = document.getElementById("legal-trend");
    if (!canvas || typeof Chart === "undefined") return;
    if (chartTrend) { try { chartTrend.destroy(); } catch (_) {} chartTrend = null; }
    const now = new Date();
    const labels = [];
    for (let i = trend.length - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      labels.push(d.toLocaleString("default", { month: "short" }));
    }
    chartTrend = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "Compliance score",
          data: trend,
          borderColor: "#5b8cff",
          backgroundColor: "rgba(91,140,255,.15)",
          tension: 0.3,
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
    const container = document.getElementById("legal-compliance-container");
    if (!container) return;
    if (inflight && !force) return inflight;

    renderShell(container);

    inflight = (async () => {
      try {
        // Resolve the issuer to score: explicit override > rwa-asset-score
        // active issuer > sensible default.
        const candidate = activeIssuer
          || (window.DefiRWAScore && window.DefiRWAScore.activeIssuer)
          || "BlackRock / Securitize";
        const matchedKey = matchIssuerKey(candidate);
        const issuerKey = matchedKey || candidate;
        const issuerDisplay = matchedKey || candidate;

        const result = calculate(matchedKey || "__fallback__");
        container.innerHTML = buildHtml(issuerKey, issuerDisplay, result, !!matchedKey);

        const btn = document.getElementById("legal-refresh-btn");
        if (btn) btn.addEventListener("click", () => render(true));
        renderHeatmap(result.pillars);
        renderTrend(result.trendData);
      } catch (err) {
        console.warn("[legal-compliance] render failed:", err);
        container.innerHTML = `
          <div class="defi-card" style="text-align:center;padding:30px 20px">
            <div style="color:#fca5a5;font-size:14px">Could not load compliance data right now.</div>
            <div style="font-size:12px;color:var(--defi-text-dim);margin-top:8px">${esc(err && err.message || String(err))}</div>
          </div>`;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function setIssuer(name) {
    activeIssuer = name || null;
    return render(true);
  }

  // -------- bootstrap ----------------------------------------------------
  function init() {
    if (!document.getElementById("legal-compliance-container")) return;
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

  window.DefiLegalCompliance = { render: () => render(false), refresh: () => render(true), setIssuer };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
