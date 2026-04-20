(function () {
  function fmtUsd(n) { return "$" + (Math.round((n || 0) * 100) / 100).toLocaleString(); }

  function setNotice(id, text) {
    const el = document.getElementById(id);
    if (!el) return;
    if (!text) { el.style.display = "none"; el.textContent = ""; return; }
    el.style.display = "";
    el.textContent = text;
  }

  function renderMiniGauge(score) {
    const el = document.getElementById("score-mini-circle");
    if (!el) return;
    const min = 300, max = 850;
    const pct = Math.max(0, Math.min(1, (score - min) / (max - min)));
    const r = 38, c = 2 * Math.PI * r;
    const offset = c * (1 - pct);
    const band = window.DefiState.bandFor(score);
    const color = ({ Excellent: "#2bd4a4", Good: "#5b8cff", Fair: "#ffb547", Poor: "#ff5d6c" })[band] || "#5b8cff";
    el.innerHTML =
      '<svg width="96" height="96" viewBox="0 0 96 96">' +
        '<circle cx="48" cy="48" r="' + r + '" stroke="#233063" stroke-width="8" fill="none"/>' +
        '<circle cx="48" cy="48" r="' + r + '" stroke="' + color + '" stroke-width="8" fill="none"' +
        ' stroke-linecap="round" stroke-dasharray="' + c + '" stroke-dashoffset="' + offset + '"' +
        ' transform="rotate(-90 48 48)"/>' +
      '</svg>';
  }

  function renderBreakdown(factors) {
    const canvas = document.getElementById("breakdown-chart");
    if (!canvas || !factors) return;
    if (window._breakdownChart) { window._breakdownChart.destroy(); window._breakdownChart = null; }
    const labels = factors.map((f) => f.name.split(" (")[0]);
    const weights = factors.map((f) => f.weight || 0);
    const colors = factors.map((f) => f.real === false ? "#3a4470" : "#5b8cff");
    window._breakdownChart = new Chart(canvas.getContext("2d"), {
      type: "bar",
      data: { labels, datasets: [{ label: "Weight %", data: weights, backgroundColor: colors, borderRadius: 6 }] },
      options: {
        indexAxis: "y", responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: {
          label: (ctx) => {
            const f = factors[ctx.dataIndex];
            const detail = f.detail ? " · " + f.detail : "";
            const tag = f.real === false ? " (data unavailable)" : "";
            return f.weight + "% weight" + tag + detail;
          },
        } } },
        scales: {
          x: { beginAtZero: true, max: 50, ticks: { color: "#9aa5cf" }, grid: { color: "#233063" } },
          y: { ticks: { color: "#9aa5cf", font: { size: 11 } }, grid: { display: false } },
        },
      },
    });
  }

  function renderTrend(history) {
    const canvas = document.getElementById("score-trend");
    const note = document.getElementById("score-trend-note");
    if (!canvas) return;
    if (window._trendChart) { window._trendChart.destroy(); window._trendChart = null; }
    if (!history || history.length === 0) {
      canvas.style.display = "none";
      if (note) { note.style.display = ""; note.textContent = "Historical score trend will appear here once the scoring backend has snapshotted this wallet over time."; }
      return;
    }
    canvas.style.display = "";
    if (note) note.style.display = "none";
    const ctx = canvas.getContext("2d");
    window._trendChart = new Chart(ctx, {
      type: "line",
      data: {
        labels: history.map((p) => p.month),
        datasets: [{
          label: "Score", data: history.map((p) => p.score),
          borderColor: "#5b8cff", backgroundColor: "rgba(91,140,255,0.15)",
          fill: true, tension: 0.35, pointRadius: 3,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: "#9aa5cf" }, grid: { color: "#233063" } },
          y: { suggestedMin: 300, suggestedMax: 850, ticks: { color: "#9aa5cf" }, grid: { color: "#233063" } },
        },
      },
    });
  }

  async function refresh() {
    const wallet = window.DefiState.wallet;
    const empty = document.getElementById("defi-home-empty");
    const grid = document.getElementById("defi-home-grid");
    if (!wallet) { empty.style.display = ""; grid.style.display = "none"; return; }
    empty.style.display = "none";
    grid.style.display = "";

    setNotice("home-status", "Loading on-chain data…");
    try {
      const [score, portfolio, alerts] = await Promise.all([
        window.DefiAPI.getScore(wallet),
        window.DefiAPI.getPortfolio(wallet),
        window.DefiAPI.getAlerts(wallet),
      ]);

      document.getElementById("stat-score").textContent = score.score;
      const bandEl = document.getElementById("stat-band");
      bandEl.textContent = score.band + (score.preliminary ? " (preliminary)" : "");
      bandEl.className = "defi-card__delta defi-band--" + score.band;

      document.getElementById("stat-value").textContent = fmtUsd(portfolio.total_value_usd);
      document.getElementById("stat-positions").textContent = portfolio.positions.length;
      document.getElementById("stat-alerts").textContent = alerts.items.length;

      const miniVal = document.getElementById("score-mini-value");
      const miniBand = document.getElementById("score-mini-band");
      const miniMeta = document.getElementById("score-mini-meta");
      if (miniVal) miniVal.textContent = score.score;
      if (miniBand) {
        miniBand.textContent = score.band + (score.preliminary ? " · preliminary" : "");
        miniBand.className = "defi-card__delta defi-band--" + score.band;
      }
      if (miniMeta) miniMeta.textContent = "Updated " + new Date(score.updated_at).toLocaleTimeString();
      renderMiniGauge(score.score);
      renderBreakdown(score.factors);

      renderTrend(score.history);

      const notices = [score.notice, portfolio.notice, alerts.notice].filter(Boolean);
      setNotice("home-status", notices.join("  •  "));
    } catch (e) {
      console.error(e);
      setNotice("home-status", "Unable to load on-chain data: " + e.message);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("score-refresh-btn");
    if (btn) btn.addEventListener("click", () => {
      if (!window.DefiState.wallet) return;
      document.dispatchEvent(new CustomEvent("defi:scan", { detail: { wallet: window.DefiState.wallet } }));
    });
    refresh();
  });
  document.addEventListener("defi:wallet-changed", refresh);
  document.addEventListener("defi:scan", refresh);
})();
