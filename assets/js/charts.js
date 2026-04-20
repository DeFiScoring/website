/* DeFi Scoring – charts.js
 *
 * Chart.js helpers and the canvas-based risk heatmap renderer used on
 * the Portfolio and Risk Profiler pages. All functions are pure: they
 * take data + a target element and return the created instance.
 *
 * Requires: Chart.js v4 (loaded globally as `Chart` from CDN).
 *
 * Public API:
 *   DefiCharts.scoreTrend(canvas, history)
 *   DefiCharts.allocationDoughnut(canvas, weights, opts)
 *   DefiCharts.targetVsActualBars(canvas, target, actual)
 *   DefiCharts.heatmap(container, positions, opts)
 */
(function () {
  const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  const COLOR_TEXT = "#e6ebff";
  const COLOR_DIM = "#9aa5cf";
  const COLOR_GRID = "rgba(35, 48, 99, 0.6)";

  function ensureChart() {
    if (typeof window.Chart === "undefined") {
      console.error("Chart.js is not loaded. Include the CDN script before charts.js.");
      return false;
    }
    return true;
  }

  function destroyExisting(canvas) {
    if (canvas && canvas._defiChart) {
      try { canvas._defiChart.destroy(); } catch (e) { /* ignore */ }
      canvas._defiChart = null;
    }
  }

  function scoreTrend(canvas, history) {
    if (!ensureChart() || !canvas) return null;
    destroyExisting(canvas);
    const labels = history.map((h) => h.month);
    const data = history.map((h) => h.score);
    const ctx = canvas.getContext("2d");
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.clientHeight || 280);
    grad.addColorStop(0, "rgba(91, 140, 255, 0.45)");
    grad.addColorStop(1, "rgba(91, 140, 255, 0.02)");
    const chart = new Chart(ctx, {
      type: "line",
      data: { labels, datasets: [{
        label: "Score", data,
        borderColor: "#5b8cff", backgroundColor: grad,
        tension: 0.35, fill: true, pointRadius: 3, pointHoverRadius: 5,
      }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: COLOR_GRID }, ticks: { color: COLOR_DIM, font: { family: FONT } } },
          y: { suggestedMin: 300, suggestedMax: 850, grid: { color: COLOR_GRID }, ticks: { color: COLOR_DIM, font: { family: FONT } } },
        },
      },
    });
    canvas._defiChart = chart;
    return chart;
  }

  function allocationDoughnut(canvas, weights, opts) {
    if (!ensureChart() || !canvas) return null;
    destroyExisting(canvas);
    opts = opts || {};
    const labels = Object.keys(weights);
    const data = labels.map((k) => Math.round(weights[k] * 100));
    const palette = opts.palette || ["#5b8cff", "#8a5cff", "#2bd4a4", "#ffb547", "#ff5d6c", "#33b5ff"];
    const chart = new Chart(canvas, {
      type: "doughnut",
      data: { labels, datasets: [{ data, backgroundColor: labels.map((_, i) => palette[i % palette.length]), borderColor: "#0b1020", borderWidth: 2 }] },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: "62%",
        plugins: {
          legend: { position: "bottom", labels: { color: COLOR_TEXT, font: { family: FONT, size: 11 }, boxWidth: 10, padding: 10 } },
          tooltip: { callbacks: { label: (c) => `${c.label}: ${c.parsed}%` } },
        },
      },
    });
    canvas._defiChart = chart;
    return chart;
  }

  function targetVsActualBars(canvas, target, actual) {
    if (!ensureChart() || !canvas) return null;
    destroyExisting(canvas);
    const labels = Object.keys(target);
    const t = labels.map((k) => Math.round((target[k] || 0) * 100));
    const a = labels.map((k) => Math.round((actual[k] || 0) * 100));
    const chart = new Chart(canvas, {
      type: "bar",
      data: { labels, datasets: [
        { label: "Target", data: t, backgroundColor: "rgba(91,140,255,0.55)", borderRadius: 4 },
        { label: "Actual", data: a, backgroundColor: "rgba(138,92,255,0.85)", borderRadius: 4 },
      ] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: COLOR_TEXT, font: { family: FONT } } } },
        scales: {
          x: { grid: { display: false }, ticks: { color: COLOR_DIM, font: { family: FONT } } },
          y: { suggestedMax: 100, grid: { color: COLOR_GRID }, ticks: { color: COLOR_DIM, callback: (v) => v + "%", font: { family: FONT } } },
        },
      },
    });
    canvas._defiChart = chart;
    return chart;
  }

  /* ---------- Heatmap (DOM-based, no canvas) ---------- */
  function riskColor(risk) {
    // 0 -> green, 50 -> amber, 100 -> red
    const r = Math.max(0, Math.min(100, risk));
    let h, l = 55;
    if (r < 50) { h = 140 - (r / 50) * 100; }       // 140 (green) -> 40 (amber)
    else        { h = 40  - ((r - 50) / 50) * 40; } // 40 -> 0 (red)
    return `hsl(${Math.round(h)}, 70%, ${l}%)`;
  }

  function heatmap(container, positions, opts) {
    if (!container) return null;
    opts = opts || {};
    container.innerHTML = "";
    container.classList.add("defi-heatmap");
    positions.forEach((p) => {
      const cell = document.createElement("div");
      cell.className = "defi-heat-cell";
      cell.style.background = riskColor(p.risk);
      cell.title = `${p.name} (${p.chain}) – risk ${p.risk}/100, $${(p.value_usd || 0).toLocaleString()}`;
      cell.innerHTML = `
        <div class="defi-heat-cell__name">${p.name}</div>
        <div class="defi-heat-cell__val">${p.chain} · $${(p.value_usd || 0).toLocaleString()}</div>
        <div class="defi-heat-cell__val">risk ${p.risk}/100</div>
      `;
      container.appendChild(cell);
    });
    return container;
  }

  window.DefiCharts = {
    scoreTrend,
    allocationDoughnut,
    targetVsActualBars,
    heatmap,
    riskColor,
  };
})();
