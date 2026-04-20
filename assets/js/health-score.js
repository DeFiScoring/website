/* DeFi Scoring – health-score.js
 *
 * Drives the #defi-health widget defined by _includes/health-score.html.
 * Computes the 300–850 score by POSTing the connected wallet to the Worker
 * /api/health-score endpoint, then renders gauge, pillar breakdown,
 * adjustments list, and a Chart.js trend line (D1-backed history).
 */
(function () {
  if (window.__defiHealthInit) return;
  window.__defiHealthInit = true;

  const STYLE_ID = "defi-health-style";
  const CSS = `
    .defi-health{border:1px solid var(--defi-border,rgba(148,163,184,.25));border-radius:14px;padding:22px;background:var(--defi-card-bg,rgba(15,23,42,.4));color:var(--defi-text,#e6ebff);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:920px;margin:24px auto}
    .defi-health__head{display:flex;justify-content:space-between;gap:18px;flex-wrap:wrap;align-items:flex-start;margin-bottom:18px}
    .defi-health__title{margin:0 0 6px;font-size:18px;font-weight:700}
    .defi-health__subtitle{margin:0;color:var(--defi-text-dim,#94a3b8);font-size:13px;line-height:1.5;max-width:560px}
    .defi-health__actions{display:flex;gap:8px;flex-wrap:wrap}
    .defi-health .defi-btn{padding:8px 14px;border-radius:8px;font:600 13px/1 inherit;border:1px solid transparent;cursor:pointer;transition:opacity .15s;text-decoration:none;display:inline-flex;align-items:center}
    .defi-health .defi-btn:disabled{opacity:.5;cursor:not-allowed}
    .defi-health .defi-btn--primary{background:#5b8cff;color:#fff;border-color:#5b8cff}
    .defi-health .defi-btn--primary:hover:not(:disabled){background:#4574e6}
    .defi-health .defi-btn--ghost{background:transparent;color:var(--defi-text,#e6ebff);border-color:var(--defi-border,rgba(148,163,184,.4))}
    .defi-health .defi-btn--ghost:hover{background:rgba(148,163,184,.08)}
    .defi-health__wallet{font:500 13px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--defi-text-dim,#94a3b8);background:rgba(148,163,184,.08);padding:8px 12px;border-radius:8px;margin-bottom:14px;word-break:break-all}
    .defi-health__notice{font-size:13px;line-height:1.5;padding:10px 14px;border-radius:8px;margin-bottom:14px;background:rgba(91,140,255,.08);color:#93c5fd;border:1px solid rgba(91,140,255,.3)}
    .defi-health__notice--err{background:rgba(239,68,68,.08);color:#fca5a5;border-color:rgba(239,68,68,.3)}
    .defi-health__gauge-wrap{position:relative;max-width:280px;margin:0 auto 22px}
    .defi-health__gauge{width:100%;display:block}
    .defi-health__gauge-track{stroke:rgba(148,163,184,.18)}
    .defi-health__gauge-fill{stroke-linecap:round;transition:stroke-dasharray .8s ease,stroke .4s ease}
    .defi-health__gauge-center{position:absolute;left:0;right:0;bottom:6px;text-align:center}
    .defi-health__score{font-size:42px;font-weight:800;line-height:1;font-variant-numeric:tabular-nums}
    .defi-health__band{font-size:11px;text-transform:uppercase;letter-spacing:.12em;font-weight:700;margin-top:4px;color:var(--defi-text-dim,#94a3b8)}
    .defi-health__band--excellent{color:#4ade80}
    .defi-health__band--good{color:#86efac}
    .defi-health__band--fair{color:#facc15}
    .defi-health__band--poor{color:#fca5a5}
    .defi-health__breakdown{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:16px}
    .defi-health__pillar{padding:12px 14px;border-radius:10px;background:rgba(148,163,184,.06);border:1px solid var(--defi-border,rgba(148,163,184,.18))}
    .defi-health__pillar-row{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px}
    .defi-health__pillar-name{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--defi-text-dim,#94a3b8);font-weight:700}
    .defi-health__pillar-weight{font-size:10px;color:var(--defi-text-dim,#94a3b8);font-weight:600}
    .defi-health__pillar-bar{height:6px;border-radius:3px;background:rgba(148,163,184,.15);overflow:hidden;margin:6px 0 8px}
    .defi-health__pillar-bar-fill{height:100%;border-radius:3px;transition:width .6s ease,background .3s ease}
    .defi-health__pillar-finding{font-size:12px;line-height:1.45;color:var(--defi-text-dim,#cbd5e1)}
    .defi-health__pillar-unreal{font-size:10px;color:#facc15;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-top:4px;display:block}
    .defi-health__adjustments{padding:10px 14px;border-radius:8px;background:rgba(91,140,255,.06);border:1px solid rgba(91,140,255,.25);margin-bottom:16px;font-size:12px;line-height:1.6;color:var(--defi-text,#e6ebff)}
    .defi-health__adjustments strong{display:block;margin-bottom:4px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--defi-text-dim,#93c5fd)}
    .defi-health__trend{margin-bottom:14px}
    .defi-health__trend-title{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--defi-text-dim,#94a3b8);font-weight:700;margin-bottom:8px}
    .defi-health__trend-empty{font-size:12px;color:var(--defi-text-dim,#94a3b8);font-style:italic;margin-top:8px}
    .defi-health__methodology{font-size:11px;color:var(--defi-text-dim,#94a3b8);margin:0;line-height:1.5;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  `;

  const PILLAR_META = {
    loan_reliability:    { label: "Loan reliability",    color: "#5b8cff" },
    liquidity_provision: { label: "Liquidity provision", color: "#a78bfa" },
    governance:          { label: "Governance",          color: "#22d3ee" },
    account_age:         { label: "Account age",         color: "#facc15" },
  };

  function $(id) { return document.getElementById(id); }
  function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID; s.textContent = CSS;
    document.head.appendChild(s);
  }

  function ensureChartJs() {
    if (window.Chart) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/chart.js@4";
      s.onload = resolve;
      s.onerror = () => reject(new Error("Chart.js failed to load"));
      document.head.appendChild(s);
    });
  }

  function setNotice(msg, isError) {
    const el = $("defi-health-notice");
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ""; return; }
    el.hidden = false;
    el.textContent = msg;
    el.className = "defi-health__notice" + (isError ? " defi-health__notice--err" : "");
  }

  function bandColor(score) {
    if (score >= 720) return "#4ade80";
    if (score >= 660) return "#86efac";
    if (score >= 580) return "#facc15";
    return "#fca5a5";
  }

  function renderGauge(score) {
    const arc = $("defi-health-arc");
    if (!arc) return;
    // SVG arc length ≈ π * r ; here r=80 → ~251.3. We use stroke-dasharray to fill.
    const arcLength = 251.3;
    const pct = Math.max(0, Math.min(1, (score - 300) / 550));
    arc.style.strokeDasharray = (arcLength * pct).toFixed(1) + " " + arcLength.toFixed(1);
    arc.style.stroke = bandColor(score);
    $("defi-health-score").textContent = score;
  }

  function renderBreakdown(pillars) {
    const wrap = $("defi-health-breakdown");
    wrap.innerHTML = "";
    Object.entries(pillars).forEach(([key, p]) => {
      const meta = PILLAR_META[key] || { label: key, color: "#94a3b8" };
      const div = document.createElement("div");
      div.className = "defi-health__pillar";
      div.innerHTML =
        '<div class="defi-health__pillar-row">' +
          '<span class="defi-health__pillar-name">' + escapeHtml(meta.label) + '</span>' +
          '<span class="defi-health__pillar-weight">' + Math.round(p.weight * 100) + '% · ' + Math.round(p.value) + '/100</span>' +
        '</div>' +
        '<div class="defi-health__pillar-bar"><div class="defi-health__pillar-bar-fill" style="width:' + Math.max(0, Math.min(100, p.value)) + '%;background:' + meta.color + '"></div></div>' +
        '<div class="defi-health__pillar-finding">' + escapeHtml(p.finding || "") + '</div>' +
        (p.real === false ? '<span class="defi-health__pillar-unreal">Data source unavailable — neutral baseline used</span>' : '');
      wrap.appendChild(div);
    });
  }

  function renderAdjustments(list) {
    const el = $("defi-health-adjustments");
    if (!list || !list.length) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = "<strong>Score adjustments</strong>" +
      list.map((a) => "<div>• " + escapeHtml(a) + "</div>").join("");
  }

  let chart = null;
  async function renderChart(history) {
    const empty = $("defi-health-trend-empty");
    if (!history || history.length < 2) {
      empty.hidden = false;
      if (chart) { chart.destroy(); chart = null; }
      return;
    }
    empty.hidden = true;
    await ensureChartJs();
    const canvas = $("defi-health-chart");
    if (chart) chart.destroy();
    chart = new window.Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        labels: history.map((h) => new Date(h.computed_at).toLocaleDateString()),
        datasets: [{
          label: "Health Score",
          data: history.map((h) => h.score),
          borderColor: "#5b8cff",
          backgroundColor: "rgba(91,140,255,.15)",
          borderWidth: 2,
          tension: 0.3,
          fill: true,
          pointRadius: 3,
          pointHoverRadius: 5,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { suggestedMin: 300, suggestedMax: 850, ticks: { color: "#94a3b8" }, grid: { color: "rgba(148,163,184,.1)" } },
          x: { ticks: { color: "#94a3b8" }, grid: { display: false } },
        },
      },
    });
  }

  function setShareLink(score, band, wallet) {
    const a = $("defi-health-share");
    if (!a) return;
    const txt = "My DeFi Health Score is " + score + " (" + band + "). Get yours:";
    const u = "https://twitter.com/intent/tweet?text=" + encodeURIComponent(txt) +
              "&url=" + encodeURIComponent(window.location.origin + "/health-score/");
    a.href = u;
    a.hidden = false;
  }

  async function loadScore(wallet) {
    const base = window.DEFI_RISK_WORKER_URL;
    if (!base) { setNotice("DEFI_RISK_WORKER_URL not set on this page.", true); return; }
    setNotice("Computing your DeFi Health Score across Aave, Uniswap V3, Snapshot, and Etherscan…");
    try {
      const res = await fetch(base.replace(/\/$/, "") + "/api/health-score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "compute failed");
      setNotice(null);
      $("defi-health-body").hidden = false;
      renderGauge(data.score);
      const band = data.score_band || "fair";
      const bandEl = $("defi-health-band");
      bandEl.textContent = band.toUpperCase();
      bandEl.className = "defi-health__band defi-health__band--" + band;
      renderBreakdown(data.pillars);
      renderAdjustments(data.adjustments);
      renderChart(data.history || []);
      $("defi-health-methodology").textContent = data.methodology || "";
      setShareLink(data.score, band, wallet);
      // Anonymized telemetry (no-op unless the user opted in via the consent banner).
      if (window.DefiIntel) window.DefiIntel.log("score_render", { defiScore: data.score, metadata: { band: band } });
      if (!data.persisted) {
        // Surface, but don't block: D1 might not be configured yet.
        const note = $("defi-health-notice");
        note.hidden = false;
        note.className = "defi-health__notice";
        note.textContent = "Note: score history isn't being persisted (D1 not configured on the Worker yet).";
      }
    } catch (e) {
      setNotice("Couldn't compute score: " + e.message, true);
    }
  }

  function setConnectedUI(addr) {
    $("defi-health-wallet").hidden = !addr;
    $("defi-health-wallet").textContent = addr ? "Connected: " + addr : "";
    $("defi-health-connect").hidden = !!addr;
    $("defi-health-refresh").hidden = !addr;
  }

  function init() {
    if (!$("defi-health")) return;
    injectStyle();

    $("defi-health-connect").addEventListener("click", async () => {
      if (!window.DefiWallet) { setNotice("Wallet module not loaded.", true); return; }
      const addr = await window.DefiWallet.connect();
      if (!addr) return;
      setConnectedUI(addr);
      loadScore(addr);
    });
    $("defi-health-refresh").addEventListener("click", () => {
      if (window.DefiWallet && window.DefiWallet.address) loadScore(window.DefiWallet.address);
    });

    if (window.DefiWallet && window.DefiWallet.address) {
      setConnectedUI(window.DefiWallet.address);
      loadScore(window.DefiWallet.address);
    }
    document.addEventListener("defi:wallet-changed", (e) => {
      const addr = e.detail && e.detail.wallet;
      setConnectedUI(addr);
      if (addr) loadScore(addr);
      else $("defi-health-body").hidden = true;
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
