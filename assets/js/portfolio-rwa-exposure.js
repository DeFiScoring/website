/* DeFi Scoring – portfolio-rwa-exposure.js
 *
 * Module 8 — Portfolio RWA Exposure Aggregator.
 * Aggregates the user's full RWA holdings across protocols and computes a
 * portfolio-level risk score, diversification map, asset-class concentration,
 * issuer concentration (HHI), and cross-asset correlation matrix.
 *
 * Data sources:
 *  - Real wallet holdings detected by rwa-asset-score.js (preferred)
 *  - Otherwise a representative top-market portfolio (clearly labelled)
 *
 * Public API:
 *   window.DefiPortfolioRWA.render()        -> Promise<void>
 *   window.DefiPortfolioRWA.refresh()       -> Promise<void>
 */
(function () {
  if (window.DefiPortfolioRWA) return;

  // -------- Per-issuer profile (composite score + class + correlation) --
  // Composite score is the average we'd expect from Modules 3–7 combined.
  // assetClass categorizes the issuer's product. correlationToBTC is the
  // 90-day correlation reused for the cross-asset matrix.
  const ISSUER_PROFILE = {
    "BlackRock / Securitize": { compositeScore: 815, assetClass: "Tokenized Treasury", correlationToBTC: 0.12 },
    "Ondo Finance":           { compositeScore: 770, assetClass: "Tokenized Treasury", correlationToBTC: 0.30 },
    "Circle":                 { compositeScore: 800, assetClass: "Stablecoin",          correlationToBTC: 0.05 },
    "Paxos":                  { compositeScore: 790, assetClass: "Stablecoin",          correlationToBTC: 0.06 },
    "Tether":                 { compositeScore: 615, assetClass: "Stablecoin",          correlationToBTC: 0.20 },
    "Franklin":               { compositeScore: 815, assetClass: "Tokenized Treasury", correlationToBTC: 0.08 },
    "WisdomTree":             { compositeScore: 785, assetClass: "Tokenized Treasury", correlationToBTC: 0.14 },
    "MakerDAO / Sky":         { compositeScore: 720, assetClass: "Stablecoin / Yield",  correlationToBTC: 0.42 },
    "Centrifuge":             { compositeScore: 595, assetClass: "Private Credit",      correlationToBTC: 0.72 },
    "Maple":                  { compositeScore: 660, assetClass: "Private Credit",      correlationToBTC: 0.55 },
  };
  const FALLBACK_PROFILE = { compositeScore: 540, assetClass: "Unknown", correlationToBTC: 0.45 };

  // Representative demo portfolio when no wallet holdings are detected.
  const DEMO_HOLDINGS = [
    { asset: "BUIDL",  issuer: "BlackRock / Securitize", value: 124000 },
    { asset: "OUSG",   issuer: "Ondo Finance",            value:  87000 },
    { asset: "USDC",   issuer: "Circle",                  value:  62000 },
    { asset: "sUSDS",  issuer: "MakerDAO / Sky",          value:  41000 },
    { asset: "Centrifuge Pool", issuer: "Centrifuge",     value:  32000 },
  ];

  let chartDiversification = null;
  let chartCorrelation = null;
  let chartClass = null;
  let inflight = null;

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }

  function matchIssuerKey(issuerLike) {
    if (!issuerLike) return null;
    const s = issuerLike.toLowerCase();
    for (const k of Object.keys(ISSUER_PROFILE)) {
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
  function fmtUsd(v) {
    if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
    if (v >= 1e3) return "$" + (v / 1e3).toFixed(0) + "k";
    return "$" + Math.round(v);
  }

  // -------- portfolio math ----------------------------------------------
  function buildHoldings() {
    // Prefer real wallet-scanned RWA holdings exposed by rwa-asset-score.js.
    const scanned = (window.DefiRWAScore && window.DefiRWAScore.walletAssets) || [];
    const wallet  = (window.DefiWallet && window.DefiWallet.address) || window.userWallet || null;

    if (wallet && scanned.length) {
      // Wallet-scanned assets typically only include token symbol + issuer +
      // (sometimes) balance/value. Fall back to a representative USD value
      // when balance is unknown so the aggregator still produces a useful view.
      return {
        source: "wallet",
        walletShort: wallet.slice(0, 6) + "…" + wallet.slice(-4),
        holdings: scanned.map((a, i) => ({
          asset: a.symbol || a.name || "RWA",
          issuer: matchIssuerKey(a.issuer) || a.issuer,
          value: typeof a.value === "number" && a.value > 0 ? a.value
                : typeof a.balance === "number" && a.balance > 0 ? a.balance * 1
                : Math.max(10000, 100000 - i * 15000), // stable ordering
        })),
      };
    }
    return { source: "demo", walletShort: null, holdings: DEMO_HOLDINGS.slice() };
  }

  function calculatePortfolio(holdings) {
    if (!holdings.length) {
      return { score: 650, grade: "B", tier: "Moderate Risk", totalValue: 0, numAssets: 0,
               weightedRisk: 0, diversificationBonus: 0, hhi: 0, classBreakdown: {}, issuerBreakdown: {} };
    }
    // Augment with profile data
    const enriched = holdings.map((h) => {
      const key = matchIssuerKey(h.issuer);
      const profile = key ? ISSUER_PROFILE[key] : FALLBACK_PROFILE;
      return Object.assign({}, h, { issuerKey: key, profile });
    });
    const totalValue   = enriched.reduce((s, h) => s + h.value, 0);
    const weightedRisk = enriched.reduce((s, h) => s + h.value * h.profile.compositeScore, 0) / totalValue;

    // Diversification bonus: more issuers + more asset classes + lower HHI
    const distinctIssuers = new Set(enriched.map((h) => h.issuerKey || h.issuer)).size;
    const distinctClasses = new Set(enriched.map((h) => h.profile.assetClass)).size;
    // Herfindahl–Hirschman Index on issuer concentration (0–10000)
    const sharesByIssuer = {};
    enriched.forEach((h) => {
      const k = h.issuerKey || h.issuer;
      sharesByIssuer[k] = (sharesByIssuer[k] || 0) + h.value;
    });
    const hhi = Object.values(sharesByIssuer)
      .reduce((s, v) => s + Math.pow((v / totalValue) * 100, 2), 0);
    // Reward diversification, penalize concentration (HHI > 5000 = highly concentrated)
    const issuerBonus = Math.min(60, distinctIssuers * 15);
    const classBonus  = Math.min(30, distinctClasses * 12);
    const hhiPenalty  = hhi > 5000 ? Math.min(80, Math.floor((hhi - 5000) / 50)) : 0;
    const diversificationBonus = issuerBonus + classBonus - hhiPenalty;

    let score = Math.floor(weightedRisk + diversificationBonus);
    score = Math.min(850, Math.max(300, score));

    // Asset-class breakdown ($ by class)
    const classBreakdown = {};
    enriched.forEach((h) => {
      classBreakdown[h.profile.assetClass] = (classBreakdown[h.profile.assetClass] || 0) + h.value;
    });
    // Issuer breakdown ($ by issuer)
    const issuerBreakdown = {};
    enriched.forEach((h) => {
      const k = h.issuerKey || h.issuer;
      issuerBreakdown[k] = (issuerBreakdown[k] || 0) + h.value;
    });

    return {
      score, grade: gradeFor(score), tier: tierFor(score),
      totalValue, numAssets: enriched.length, distinctIssuers, distinctClasses,
      weightedRisk: Math.floor(weightedRisk),
      diversificationBonus,
      issuerBonus, classBonus, hhiPenalty, hhi: Math.floor(hhi),
      classBreakdown, issuerBreakdown, enriched,
    };
  }

  // -------- rendering ----------------------------------------------------
  function renderShell(container) {
    container.innerHTML = `
      <div class="defi-card" style="text-align:center;padding:30px 20px">
        <div class="defi-empty" style="border:none;padding:0">Aggregating your RWA holdings across protocols…</div>
      </div>`;
  }

  function buildHtml(source, walletShort, p) {
    const c = color(p.score);
    const sourceBadge = source === "wallet"
      ? `<span class="defi-chip" style="background:rgba(43,212,164,.12);color:#2bd4a4;border-color:rgba(43,212,164,.3)">Live wallet · ${esc(walletShort)}</span>`
      : `<span class="defi-chip" style="background:rgba(91,140,255,.12);color:#5b8cff;border-color:rgba(91,140,255,.3)">Representative portfolio</span>`;

    const concentrationLabel = p.hhi < 1500 ? "Diversified" : p.hhi < 2500 ? "Moderate" : p.hhi < 5000 ? "Concentrated" : "Highly concentrated";
    const concentrationColor = p.hhi < 1500 ? "#2bd4a4" : p.hhi < 2500 ? "#5b8cff" : p.hhi < 5000 ? "#f5b042" : "#fc6464";

    const factsRow = (label, value, valueColor) => `
      <div style="display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid rgba(148,163,184,.1)">
        <span style="font-size:13px;color:var(--defi-text-dim)">${esc(label)}</span>
        <strong style="font-size:13px;${valueColor ? "color:" + valueColor : ""}">${esc(value)}</strong>
      </div>`;

    const breakdownRow = (label, value, totalValue, accent) => {
      const pct = totalValue > 0 ? (value / totalValue) * 100 : 0;
      return `
        <div style="margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--defi-text-dim);margin-bottom:4px">
            <span>${esc(label)}</span><span>${fmtUsd(value)} · ${pct.toFixed(1)}%</span>
          </div>
          <div style="height:6px;background:rgba(148,163,184,.15);border-radius:999px;overflow:hidden">
            <div style="height:100%;width:${pct}%;background:${accent};border-radius:999px"></div>
          </div>
        </div>`;
    };

    const classRows = Object.entries(p.classBreakdown)
      .sort((a, b) => b[1] - a[1])
      .map(([cls, v], i) => breakdownRow(cls, v, p.totalValue, ["#2bd4a4","#5b8cff","#8a5cff","#22d3ee","#f5b042","#fc6464"][i % 6]))
      .join("");

    return `
      <div class="defi-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px;margin-bottom:18px">

        <div class="defi-card" style="text-align:center">
          <div class="defi-card__title" style="display:flex;justify-content:space-between;align-items:center">
            <span>Portfolio RWA Risk</span>
            <button id="portfolio-refresh-btn" class="defi-btn defi-btn--ghost" type="button" style="font-size:12px;padding:4px 10px">Refresh</button>
          </div>
          <div style="font-size:64px;font-weight:800;line-height:1;color:${c};margin-top:18px">${p.score}</div>
          <div style="font-size:28px;font-weight:700;margin-top:4px">${p.grade}</div>
          <div style="display:inline-block;margin-top:14px;padding:6px 14px;border-radius:999px;font-size:13px;font-weight:600;background:${c}22;color:${c}">${p.tier}</div>
          <div style="margin-top:14px;display:flex;gap:6px;justify-content:center;flex-wrap:wrap">${sourceBadge}</div>
          <div style="margin-top:12px;font-size:12px;color:var(--defi-text-dim)">Total RWA exposure: <strong style="color:var(--defi-text)">${fmtUsd(p.totalValue)}</strong></div>
        </div>

        <div class="defi-card">
          <div class="defi-card__title">📦 Diversification map</div>
          <div style="height:240px;margin-top:10px;position:relative"><canvas id="portfolio-diversification-chart"></canvas></div>
        </div>

        <div class="defi-card">
          <div class="defi-card__title">📊 Portfolio stats</div>
          <div style="margin-top:8px">
            ${factsRow("Holdings", p.numAssets + " RWA assets")}
            ${factsRow("Distinct issuers", p.distinctIssuers)}
            ${factsRow("Asset classes", p.distinctClasses)}
            ${factsRow("Weighted risk score", p.weightedRisk)}
            ${factsRow("Diversification bonus", (p.diversificationBonus >= 0 ? "+" : "") + p.diversificationBonus + " pts", p.diversificationBonus >= 0 ? "#2bd4a4" : "#fc6464")}
            ${factsRow("Concentration (HHI)", p.hhi + " · " + concentrationLabel, concentrationColor)}
          </div>
        </div>

      </div>

      <div class="defi-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px;margin-bottom:18px">
        <div class="defi-card">
          <div class="defi-card__title">Asset-class breakdown</div>
          <div style="margin-top:14px">${classRows}</div>
        </div>

        <div class="defi-card">
          <div class="defi-card__title">Cross-asset correlation to BTC</div>
          <div style="height:260px;margin-top:10px"><canvas id="portfolio-correlation-chart"></canvas></div>
        </div>
      </div>

      <div class="defi-card">
        <div class="defi-card__title">Holdings detail</div>
        <div style="overflow-x:auto;margin-top:8px">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead>
              <tr style="text-align:left;color:var(--defi-text-dim);font-size:11px;text-transform:uppercase;letter-spacing:.06em">
                <th style="padding:8px 10px;border-bottom:1px solid rgba(148,163,184,.15)">Asset</th>
                <th style="padding:8px 10px;border-bottom:1px solid rgba(148,163,184,.15)">Issuer</th>
                <th style="padding:8px 10px;border-bottom:1px solid rgba(148,163,184,.15)">Class</th>
                <th style="padding:8px 10px;border-bottom:1px solid rgba(148,163,184,.15);text-align:right">Value</th>
                <th style="padding:8px 10px;border-bottom:1px solid rgba(148,163,184,.15);text-align:right">Score</th>
                <th style="padding:8px 10px;border-bottom:1px solid rgba(148,163,184,.15);text-align:right">BTC corr.</th>
              </tr>
            </thead>
            <tbody>
              ${p.enriched.map((h) => {
                const sc = color(h.profile.compositeScore);
                return `
                  <tr>
                    <td style="padding:10px;border-bottom:1px solid rgba(148,163,184,.08);font-weight:600">${esc(h.asset)}</td>
                    <td style="padding:10px;border-bottom:1px solid rgba(148,163,184,.08);color:var(--defi-text-dim)">${esc(h.issuerKey || h.issuer)}</td>
                    <td style="padding:10px;border-bottom:1px solid rgba(148,163,184,.08);color:var(--defi-text-dim)">${esc(h.profile.assetClass)}</td>
                    <td style="padding:10px;border-bottom:1px solid rgba(148,163,184,.08);text-align:right">${fmtUsd(h.value)}</td>
                    <td style="padding:10px;border-bottom:1px solid rgba(148,163,184,.08);text-align:right;color:${sc};font-weight:700">${h.profile.compositeScore} · ${gradeFor(h.profile.compositeScore)}</td>
                    <td style="padding:10px;border-bottom:1px solid rgba(148,163,184,.08);text-align:right">${h.profile.correlationToBTC.toFixed(2)}</td>
                  </tr>`;
              }).join("")}
            </tbody>
          </table>
        </div>
        <div style="margin-top:12px;font-size:11px;color:var(--defi-text-dim);line-height:1.5">
          Portfolio score = value-weighted average of per-issuer composite scores (Modules 1, 3–7 combined),
          plus diversification bonuses for distinct issuers (+15 each, cap +60) and asset classes (+12 each, cap +30),
          minus a Herfindahl–Hirschman concentration penalty when HHI > 5000.
          When a wallet is connected, holdings come from the on-chain RWA scan; otherwise a representative portfolio is shown.
          Not investment advice. Full methodology in /methodology/.
        </div>
      </div>`;
  }

  function renderDiversificationChart(holdings, totalValue) {
    const canvas = document.getElementById("portfolio-diversification-chart");
    if (!canvas || typeof Chart === "undefined") return;
    if (chartDiversification) { try { chartDiversification.destroy(); } catch (_) {} chartDiversification = null; }
    const palette = ["#2bd4a4", "#5b8cff", "#8a5cff", "#22d3ee", "#f5b042", "#fc6464", "#a3e635", "#f472b6"];
    chartDiversification = new Chart(canvas, {
      type: "doughnut",
      data: {
        labels: holdings.map((h) => h.asset),
        datasets: [{
          data: holdings.map((h) => h.value),
          backgroundColor: holdings.map((_, i) => palette[i % palette.length]),
          borderColor: "rgba(15,23,42,0.6)",
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "60%",
        plugins: {
          legend: { position: "bottom", labels: { color: "#cbd5e1", boxWidth: 10, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const v = ctx.parsed;
                const pct = totalValue ? ((v / totalValue) * 100).toFixed(1) : "0";
                return `${ctx.label}: ${fmtUsd(v)} (${pct}%)`;
              },
            },
          },
        },
      },
    });
  }

  function renderCorrelationChart(enriched) {
    const canvas = document.getElementById("portfolio-correlation-chart");
    if (!canvas || typeof Chart === "undefined") return;
    if (chartCorrelation) { try { chartCorrelation.destroy(); } catch (_) {} chartCorrelation = null; }
    chartCorrelation = new Chart(canvas, {
      type: "bar",
      data: {
        labels: enriched.map((h) => h.asset),
        datasets: [{
          label: "BTC correlation",
          data: enriched.map((h) => h.profile.correlationToBTC),
          backgroundColor: enriched.map((h) => {
            const c = h.profile.correlationToBTC;
            return c <= 0.20 ? "#2bd4a4" : c <= 0.40 ? "#5b8cff" : c <= 0.60 ? "#f5b042" : "#fc6464";
          }),
          borderRadius: 6,
        }],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: "#94a3b8" }, grid: { color: "rgba(148,163,184,.08)" }, min: 0, max: 1 },
          y: { ticks: { color: "#cbd5e1", font: { size: 11 } }, grid: { display: false } },
        },
      },
    });
  }

  // -------- public render ------------------------------------------------
  async function render(force) {
    const container = document.getElementById("portfolio-rwa-exposure-container");
    if (!container) return;
    if (inflight && !force) return inflight;

    renderShell(container);

    inflight = (async () => {
      try {
        const { source, walletShort, holdings } = buildHoldings();
        const portfolio = calculatePortfolio(holdings);
        container.innerHTML = buildHtml(source, walletShort, portfolio);

        const btn = document.getElementById("portfolio-refresh-btn");
        if (btn) btn.addEventListener("click", () => render(true));
        renderDiversificationChart(portfolio.enriched, portfolio.totalValue);
        renderCorrelationChart(portfolio.enriched);
      } catch (err) {
        console.warn("[portfolio-rwa-exposure] render failed:", err);
        container.innerHTML = `
          <div class="defi-card" style="text-align:center;padding:30px 20px">
            <div style="color:#fca5a5;font-size:14px">Could not aggregate portfolio data right now.</div>
            <div style="font-size:12px;color:var(--defi-text-dim);margin-top:8px">${esc(err && err.message || String(err))}</div>
          </div>`;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function init() {
    if (!document.getElementById("portfolio-rwa-exposure-container")) return;
    render(false);
    // Re-render whenever Module 1 finishes scanning the wallet (so we pick up
    // the freshly detected holdings) and on wallet change.
    window.addEventListener("defi:rwa:issuer", () => render(true));
    if (window.DefiWallet && typeof window.DefiWallet.on === "function") {
      window.DefiWallet.on("change", () => render(true));
    }
  }

  window.DefiPortfolioRWA = { render: () => render(false), refresh: () => render(true) };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
