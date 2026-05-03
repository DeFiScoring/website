(function () {
  function fmtUsd(n) { return "$" + (Math.round((n || 0) * 100) / 100).toLocaleString(); }

  // P5 stub — single-source fiat formatter. Reads localStorage('defi.fiat')
  // when present so the future fiat-pref widget can change display without
  // touching every renderer. Falls back to USD which matches today's API
  // default. Currency-aware via Intl.NumberFormat (handles CHF, EUR, etc.).
  function fiatPref() {
    try {
      const v = (localStorage.getItem("defi.fiat") || "USD").toUpperCase();
      return /^[A-Z]{3}$/.test(v) ? v : "USD";
    } catch (_e) { return "USD"; }
  }
  function fmtFiat(n, currency) {
    const ccy = (currency || fiatPref()).toUpperCase();
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency", currency: ccy, maximumFractionDigits: 2,
      }).format(n || 0);
    } catch (_e) {
      return ccy + " " + (Math.round((n || 0) * 100) / 100).toLocaleString();
    }
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function fmtAmount(n) {
    if (!Number.isFinite(n) || n === 0) return "0";
    if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (n >= 1)    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
    return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }

  // Map worker chain IDs (slugs) to block-explorer URLs. Mirrors
  // worker/lib/chains.js; kept inline so the home dashboard can deep-link
  // to a token's tokentxns page without an extra round-trip.
  const EXPLORERS = {
    ethereum: "https://etherscan.io",
    optimism: "https://optimistic.etherscan.io",
    arbitrum: "https://arbiscan.io",
    base:     "https://basescan.org",
    polygon:  "https://polygonscan.com",
    bnb:      "https://bscscan.com",
    avalanche:"https://snowtrace.io",
    gnosis:   "https://gnosisscan.io",
    linea:    "https://lineascan.build",
    scroll:   "https://scrollscan.com",
    zksync:   "https://explorer.zksync.io",
  };

  // P2 — render the per-chain scan status table when the portfolio total
  // is $0, so users understand whether the scan ran and what it found
  // instead of staring at $0 with no context.
  function renderPortfolioStatus(portfolio) {
    const card = document.getElementById("defi-portfolio-status");
    const rowsEl = document.getElementById("defi-portfolio-status-rows");
    const sumEl = document.getElementById("defi-portfolio-status-summary");
    const hintEl = document.getElementById("defi-portfolio-status-hint");
    if (!card || !rowsEl) return;

    const chains = Array.isArray(portfolio.chains) ? portfolio.chains
                  : Array.isArray(portfolio.chainSummaries) ? portfolio.chainSummaries
                  : [];
    const total = Number(portfolio.total_value_usd || portfolio.portfolioFiat || 0);
    const totalTokens = Number(portfolio.totalTokens != null ? portfolio.totalTokens
                              : portfolio.positions ? portfolio.positions.length : 0);
    const activeChains = Number(portfolio.activeChains != null ? portfolio.activeChains
                              : chains.filter((c) => (c.totalFiat || c.total_value_usd || 0) > 0).length);

    if (!chains.length) { card.style.display = "none"; return; }

    // Show the card whenever we hit $0 OR there's an error on any chain —
    // otherwise the holdings card alone tells the story.
    const hasError = chains.some((c) => c.error || (c.errors && c.errors.length));
    if (total > 0 && !hasError) { card.style.display = "none"; return; }
    card.style.display = "";

    sumEl.textContent = activeChains + " of " + chains.length + " chains had balances · " + totalTokens + " tokens";

    rowsEl.innerHTML = chains.map((c) => {
      const name = escapeHtml(c.chainName || c.chain || "?");
      const v = Number(c.totalFiat || c.total_value_usd || 0);
      const tokenCount = Number(c.tokens ? c.tokens.length : c.token_count || 0);
      const err = c.error || (c.errors && c.errors[0] && (c.errors[0].source + ": " + c.errors[0].message)) || null;
      let dot, label;
      if (err) { dot = "#ff5d6c"; label = "Error"; }
      else if (v > 0 || tokenCount > 0) { dot = "#2bd4a4"; label = fmtFiat(v) + " · " + tokenCount + " tok"; }
      else { dot = "#8b8b99"; label = "Empty"; }
      return '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(255,255,255,0.03);border-radius:6px;font-size:12px"' +
        (err ? ' title="' + escapeHtml(err) + '"' : "") + '>' +
        '<span style="width:8px;height:8px;border-radius:50%;background:' + dot + '"></span>' +
        '<span style="font-weight:600;flex:0 0 auto">' + name + '</span>' +
        '<span style="color:var(--defi-text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
        escapeHtml(label) + '</span>' +
        '</div>';
    }).join("");

    const errorChains = chains.filter((c) => c.error || (c.errors && c.errors.length));
    const ph = portfolio.providerHealth || {};
    const providersUsed = Object.keys(ph).filter((k) => ph[k] > 0).join(", ") || "etherscan only";
    if (errorChains.length) {
      hintEl.innerHTML = '<strong style="color:#ff5d6c">' + errorChains.length + ' chain(s) failed to scan.</strong> ' +
        'Provider mix: ' + escapeHtml(providersUsed) + '. ' +
        (ph.alchemy ? '' : 'Configure ALCHEMY_KEY for full ERC-20 coverage.');
    } else if (total === 0) {
      hintEl.innerHTML = 'Scanned ' + chains.length + ' chains via <em>' + escapeHtml(providersUsed) + '</em>. ' +
        'No balances found. If your wallet does hold tokens on a listed chain, ' +
        (ph.alchemy ? 'try Refresh.' : 'an Alchemy/Moralis key is needed for ERC-20 discovery beyond the Etherscan-only fallback.');
    } else { hintEl.textContent = ""; }
  }

  // P3 — token-by-token holdings table.
  function renderHoldings(portfolio) {
    const card = document.getElementById("defi-holdings");
    const rowsEl = document.getElementById("defi-holdings-rows");
    const countEl = document.getElementById("defi-holdings-count");
    if (!card || !rowsEl) return;
    const positions = Array.isArray(portfolio.positions) ? portfolio.positions : [];
    if (!positions.length) { card.style.display = "none"; return; }
    card.style.display = "";
    countEl.textContent = positions.length + " token" + (positions.length === 1 ? "" : "s");

    // Group by chain (matches mobile-wallet UX). chain field can be the slug
    // (positions[].chainId in worker payload) or the display name — we
    // tolerate both since the legacy shape leaks the display name through.
    const groups = new Map();
    for (const p of positions) {
      const slug = (p.chainId || p.chain || "").toString().toLowerCase();
      if (!groups.has(slug)) groups.set(slug, { slug, name: p.chain || slug, items: [] });
      groups.get(slug).items.push(p);
    }
    // Sort groups by group fiat desc.
    const groupArr = Array.from(groups.values()).map((g) => ({
      ...g,
      fiat: g.items.reduce((s, p) => s + (p.value_usd || 0), 0),
    })).sort((a, b) => b.fiat - a.fiat);

    rowsEl.innerHTML = groupArr.map((g) => {
      const explorerBase = EXPLORERS[g.slug] || "";
      const items = g.items.slice().sort((a, b) => (b.value_usd || 0) - (a.value_usd || 0)).map((p) => {
        const sym = escapeHtml(p.symbol || p.name || "Token");
        const qty = fmtAmount(Number(p.amount || 0));
        const px = p.price_usd > 0 ? fmtFiat(p.price_usd) : "—";
        const val = p.value_usd > 0 ? fmtFiat(p.value_usd) : "—";
        const isNative = p.contract === "native" || /^Native\s/i.test(p.name || "");
        const explorerHref = explorerBase
          ? (isNative
              ? explorerBase + "/address/" + encodeURIComponent(window.DefiState.wallet || "")
              : explorerBase + "/token/" + encodeURIComponent(p.contract || "") + "?a=" + encodeURIComponent(window.DefiState.wallet || ""))
          : null;
        const symCell = explorerHref
          ? '<a href="' + escapeHtml(explorerHref) + '" target="_blank" rel="noopener" style="color:var(--defi-text);text-decoration:none">' + sym + ' ↗</a>'
          : sym;
        return '<div style="display:grid;grid-template-columns:minmax(0,1.4fr) 1fr 1fr 1fr;gap:10px;padding:8px 10px;background:rgba(255,255,255,0.02);border-radius:6px;font-size:13px;align-items:center">' +
          '<div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + symCell + '</div>' +
          '<div style="color:var(--defi-text-dim);text-align:right;font-variant-numeric:tabular-nums">' + escapeHtml(qty) + '</div>' +
          '<div style="color:var(--defi-text-dim);text-align:right;font-variant-numeric:tabular-nums">' + escapeHtml(px) + '</div>' +
          '<div style="font-weight:600;text-align:right;font-variant-numeric:tabular-nums">' + escapeHtml(val) + '</div>' +
        '</div>';
      }).join("");

      return '<div style="margin-bottom:14px">' +
        '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;font-size:12px;color:var(--defi-text-dim);text-transform:uppercase;letter-spacing:0.5px">' +
          '<span>' + escapeHtml(g.name) + '</span>' +
          '<span>' + (g.fiat > 0 ? fmtFiat(g.fiat) : "—") + '</span>' +
        '</div>' +
        '<div style="display:grid;gap:4px">' + items + '</div>' +
      '</div>';
    }).join("");
  }

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
    const color = ({ Excellent: "#2bd4a4", Good: "#00f5ff", Fair: "#facc15", Poor: "#ff5d6c" })[band] || "#00f5ff";
    el.innerHTML =
      '<svg width="96" height="96" viewBox="0 0 96 96">' +
        '<circle cx="48" cy="48" r="' + r + '" stroke="rgba(255,255,255,0.08)" stroke-width="8" fill="none"/>' +
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
    const colors = factors.map((f) => f.real === false ? "#3a3a45" : "#00f5ff");
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
          x: { beginAtZero: true, max: 50, ticks: { color: "#8b8b99" }, grid: { color: "rgba(255,255,255,0.08)" } },
          y: { ticks: { color: "#8b8b99", font: { size: 11 } }, grid: { display: false } },
        },
      },
    });
  }

  function renderTrend(history, meta) {
    const canvas = document.getElementById("score-trend");
    const note = document.getElementById("score-trend-note");
    if (!canvas) return;
    if (window._trendChart) { window._trendChart.destroy(); window._trendChart = null; }
    if (!history || history.length === 0) {
      canvas.style.display = "none";
      if (note) {
        note.style.display = "";
        note.textContent = "Historical score trend will appear here once the scoring backend has snapshotted this wallet over time.";
      }
      return;
    }
    canvas.style.display = "";
    if (note) {
      if (meta && meta.tier === "free" && meta.tier_cap_days && meta.tier_cap_days < 30) {
        note.style.display = "";
        note.innerHTML = 'Showing the last <strong>' + meta.days_applied + ' days</strong>. ' +
          '<a href="/pricing/" style="color:var(--defi-accent)">Upgrade to Pro</a> for full 30-day history.';
      } else {
        note.style.display = "none";
      }
    }
    // Build sensible date labels — the history endpoint returns `computed_at`
    // (ms epoch); legacy callers use `date` / `captured_at` / `month`.
    const labels = history.map((p) => {
      const raw = p.computed_at || p.date || p.captured_at;
      if (raw) {
        try { return new Date(raw).toLocaleDateString(undefined, { month: "short", day: "numeric" }); } catch (e) {}
      }
      return p.month || "";
    });
    const ctx = canvas.getContext("2d");
    window._trendChart = new Chart(ctx, {
      type: "line",
      data: {
        labels: labels,
        datasets: [{
          label: "Score", data: history.map((p) => p.score),
          borderColor: "#00f5ff", backgroundColor: "rgba(0,245,255,0.15)",
          fill: true, tension: 0.35, pointRadius: 3,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: "#8b8b99" }, grid: { color: "rgba(255,255,255,0.08)" } },
          y: { suggestedMin: 300, suggestedMax: 850, ticks: { color: "#8b8b99" }, grid: { color: "rgba(255,255,255,0.08)" } },
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

      // P2 — fiat-aware total + meta line driven by the API's structured
      // fields. Falls back to legacy fmtUsd when the new fields aren't
      // present (e.g. snapshot fallback in DefiAPI.getPortfolio).
      const total = Number(portfolio.portfolioFiat != null ? portfolio.portfolioFiat
                                                           : portfolio.total_value_usd || 0);
      const fiat = (portfolio.fiat || fiatPref() || "USD").toUpperCase();
      document.getElementById("stat-value").textContent = fmtFiat(total, fiat);
      const metaEl = document.getElementById("stat-value-meta");
      if (metaEl) {
        const activeChains = Number(portfolio.activeChains != null ? portfolio.activeChains
                                  : (portfolio.chainSummaries || []).filter((c) => (c.total_value_usd || 0) > 0).length);
        const totalTokens = Number(portfolio.totalTokens != null ? portfolio.totalTokens
                                  : (portfolio.positions || []).length);
        metaEl.textContent = "across " + activeChains + " chain" + (activeChains === 1 ? "" : "s") +
                              " · " + totalTokens + " token" + (totalTokens === 1 ? "" : "s");
      }
      document.getElementById("stat-positions").textContent = portfolio.positions.length;
      document.getElementById("stat-alerts").textContent = alerts.items.length;

      // P2/P3 — per-chain scan status + holdings table.
      renderPortfolioStatus(portfolio);
      renderHoldings(portfolio);

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

      // Tier-aware history: ask the worker for the longest window the user's
      // tier allows. Worker clamps to its own cap so we can safely request 365.
      try {
        const base = (window.DEFI_RISK_WORKER_URL || "").replace(/\/$/, "");
        const histResp = await fetch(base + "/api/health-score/" + encodeURIComponent(wallet) + "/history?days=365",
          { credentials: "include" });
        if (histResp.ok) {
          const j = await histResp.json();
          if (j && j.success) {
            renderTrend(j.history || [], { tier: j.tier, days_applied: j.days_applied, tier_cap_days: j.tier_cap_days });
          } else {
            renderTrend(score.history);
          }
        } else {
          renderTrend(score.history);
        }
      } catch (e) {
        renderTrend(score.history);
      }

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
    // P2 — explicit "rescan portfolio" button bypassing the 30s edge cache.
    const pBtn = document.getElementById("portfolio-refresh-btn");
    if (pBtn) pBtn.addEventListener("click", () => {
      if (!window.DefiState.wallet) return;
      pBtn.disabled = true; const orig = pBtn.textContent; pBtn.textContent = "…";
      refresh().finally(() => { pBtn.disabled = false; pBtn.textContent = orig; });
    });
    refresh();
  });
  document.addEventListener("defi:wallet-changed", refresh);
  document.addEventListener("defi:scan", refresh);
  // wallet-picker.js dispatches this when the user switches the active wallet
  // from the dropdown without changing the connected EIP-1193 account.
  window.addEventListener("defi:wallet-picked", refresh);
  // P5 — re-fetch the portfolio so prices/totals come back in the new
  // currency. fmtFiat already reads localStorage on each call, so any
  // values rendered locally update on next paint.
  document.addEventListener("defi:fiat-changed", refresh);
})();
