/* DeFi Scoring – dashboard-risk.js
 *
 * Page controller for /dashboard/risk-profiler/.
 * Wires the profile picker, calls DefiAPI.getPortfolio + DefiProfiler.profile,
 * and renders the cards / charts / heatmap.
 */
(function () {
  let selectedId = "balanced";
  let lastPortfolio = null;
  let lastResult = null;
  let running = false;

  function $ (id) { return document.getElementById(id); }
  function profilesById() {
    const map = {};
    (window.DEFI_RISK_PROFILES || []).forEach((p) => { map[p.id] = p; });
    return map;
  }

  function bandFor(score) {
    if (score >= 85) return { label: "On target", cls: "defi-band--Excellent" };
    if (score >= 65) return { label: "Slight drift", cls: "defi-band--Good" };
    if (score >= 40) return { label: "Drifting", cls: "defi-band--Fair" };
    return { label: "Off target", cls: "defi-band--Poor" };
  }

  function setStatus(msg, kind) {
    const el = $("risk-source");
    if (!el) return;
    el.textContent = msg || "";
    el.style.color = kind === "error" ? "#fca5a5"
      : kind === "ok" ? "var(--defi-text-dim)"
      : "var(--defi-text-dim)";
  }

  function setRunning(on) {
    running = on;
    const btn = $("risk-run-btn");
    if (!btn) return;
    btn.disabled = on;
    btn.textContent = on ? "Running…" : "Run risk profile";
    btn.style.opacity = on ? "0.7" : "";
    btn.style.cursor = on ? "wait" : "";
  }

  function renderPicker() {
    const wrap = $("risk-profile-picker");
    if (!wrap) return;
    wrap.innerHTML = "";
    (window.DEFI_RISK_PROFILES || []).forEach((p) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "defi-btn defi-btn--ghost";
      card.style.cssText = "text-align:left;padding:14px;display:flex;flex-direction:column;gap:6px;align-items:flex-start;height:auto;border-color:" + (selectedId === p.id ? p.color : "var(--defi-border)");
      card.innerHTML = `
        <span style="display:flex;align-items:center;gap:8px;font-weight:700">
          <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${p.color}"></span>
          ${p.name}
        </span>
        <span style="font-size:12px;color:var(--defi-text-dim);line-height:1.4">${p.summary}</span>
        <span style="font-size:11px;color:var(--defi-text-dim)">Max LTV ${Math.round(p.target.max_ltv*100)}% · Min HF ${p.target.min_health_factor}</span>
      `;
      card.addEventListener("click", () => { selectedId = p.id; renderPicker(); });
      wrap.appendChild(card);
    });
  }

  async function loadPortfolio(force) {
    const wallet = window.DefiState && window.DefiState.wallet;
    if (!wallet) throw new Error("No wallet connected");
    if (!window.DefiAPI || !window.DefiAPI.getPortfolio) {
      throw new Error("Wallet/portfolio client not loaded (dashboard.js missing)");
    }
    if (force || !lastPortfolio || lastPortfolio.wallet !== wallet) {
      lastPortfolio = await window.DefiAPI.getPortfolio(wallet);
    }
    if (!lastPortfolio || typeof lastPortfolio !== "object") {
      throw new Error("Portfolio fetch returned no data");
    }
    if (!Array.isArray(lastPortfolio.positions)) lastPortfolio.positions = [];
    return lastPortfolio;
  }

  async function run(opts) {
    if (running) return;
    const wallet = window.DefiState && window.DefiState.wallet;
    if (!wallet) {
      setStatus("Connect a wallet first.", "error");
      return;
    }
    const target = profilesById()[selectedId];
    if (!target) {
      setStatus("Selected profile not found.", "error");
      return;
    }

    setRunning(true);
    setStatus("Loading on-chain portfolio…");

    try {
      await loadPortfolio(opts && opts.force);

      setStatus("Computing alignment…");
      const result = await window.DefiProfiler.profile({
        wallet,
        portfolio: lastPortfolio,
        target_profile_id: selectedId,
        target,
      });
      lastResult = result;
      render(result, target);
      // Anonymized telemetry — risk profile name comes from the selected target.
      if (window.DefiIntel) {
        window.DefiIntel.log("profiler_run", {
          riskProfile: (target && target.label) || (target && target.name) || null,
          metadata: { alignment: result.score, source: result.source },
        });
      }

      const empty = !lastPortfolio.positions.length;
      const srcMsg = result.source === "ai"
        ? "Source: AI Worker"
        : "Source: local computation (AI Worker unreachable)";
      const emptyNote = empty
        ? " · No native ETH/MATIC detected on Ethereum, Arbitrum, or Polygon — alignment computed against an empty portfolio. ERC-20 / protocol positions need a data-provider integration."
        : "";
      setStatus(srcMsg + emptyNote, "ok");
    } catch (e) {
      console.error("[risk-profiler] run failed:", e);
      setStatus("Run failed: " + (e && e.message ? e.message : String(e)), "error");
    } finally {
      setRunning(false);
    }
  }

  function render(result, target) {
    const band = bandFor(result.score);
    $("risk-score").textContent = result.score + "/100";
    const bandEl = $("risk-band");
    bandEl.textContent = band.label;
    bandEl.className = "defi-card__delta " + band.cls;
    $("risk-breaches").textContent = result.limit_breaches.length;

    const concEntries = Object.entries(result.concentration || {}).sort((a, b) => b[1] - a[1]);
    const topProto = concEntries[0] || ["—", 0];
    $("risk-top-proto").textContent = topProto[0];
    $("risk-top-pct").textContent = (topProto[1] || 0).toFixed(1) + "% of portfolio";

    const positions = (lastPortfolio && lastPortfolio.positions) || [];
    const total = positions.reduce((s, p) => s + (p.value_usd || 0), 0) || 1;
    const ltUsd = positions.reduce((s, p) => {
      const cls = (window.DEFI_PROTOCOL_CLASSES || {})[p.name] || "long_tail";
      return s + (cls === "long_tail" ? (p.value_usd || 0) : 0);
    }, 0);
    $("risk-longtail").textContent = ((ltUsd / total) * 100).toFixed(1) + "%";

    $("risk-summary").textContent = result.summary || "";
    const recs = $("risk-recs");
    recs.innerHTML = "";
    (result.recommendations || []).forEach((r) => {
      const li = document.createElement("li");
      li.textContent = r;
      recs.appendChild(li);
    });

    if (window.DefiCharts) {
      try {
        window.DefiCharts.allocationDoughnut($("risk-target-chart"), target.weights);
        const actual = {};
        Object.keys(target.weights || {}).forEach((k) => { actual[k] = 0; });
        positions.forEach((p) => {
          const cls = (window.DEFI_PROTOCOL_CLASSES || {})[p.name] || "long_tail";
          actual[cls] = (actual[cls] || 0) + (p.value_usd || 0) / total;
        });
        window.DefiCharts.targetVsActualBars($("risk-bars-chart"), target.weights, actual);
        window.DefiCharts.heatmap($("risk-heatmap"), positions);
      } catch (e) {
        console.warn("[risk-profiler] chart render failed:", e);
      }
    }
  }

  function show(connected) {
    const empty = $("defi-risk-empty");
    const grid = $("defi-risk-grid");
    if (empty) empty.style.display = connected ? "none" : "";
    if (grid) grid.style.display = connected ? "" : "none";
  }

  function init() {
    renderPicker();
    const btn = $("risk-run-btn");
    if (btn) {
      // Defensive: clear any pre-existing handlers and bind once.
      btn.replaceWith(btn.cloneNode(true));
      const fresh = $("risk-run-btn");
      fresh.addEventListener("click", (ev) => { ev.preventDefault(); run({ force: true }); });
    }
    const connected = !!(window.DefiState && window.DefiState.wallet);
    show(connected);
    if (connected) run();   // auto-run once on first visit
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
  document.addEventListener("defi:wallet-changed", () => {
    lastPortfolio = null;
    const connected = !!(window.DefiState && window.DefiState.wallet);
    show(connected);
    if (connected) run({ force: true });
  });
  document.addEventListener("defi:scan", () => { lastPortfolio = null; run({ force: true }); });
})();
