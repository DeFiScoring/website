/* DeFi Scoring – gas-tracker.js
 *
 * Renders a tiny live gas ticker into every <div data-defi-gas></div> node.
 * Polls {WORKER_URL}/api/gas every 20s (Worker KV-caches for 15s so this is
 * essentially free per chain). Hides itself if the Worker URL isn't configured.
 */
(function () {
  if (window.__defiGasInit) return;
  window.__defiGasInit = true;

  const POLL_MS = 20000;
  const STYLE_ID = "defi-gas-style";
  const CSS = `
    .defi-gas{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--defi-border,rgba(148,163,184,.25));border-radius:999px;background:var(--defi-card-bg,rgba(15,23,42,.4));font:600 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--defi-text-dim,#94a3b8);white-space:nowrap}
    .defi-gas__dot{width:6px;height:6px;border-radius:50%;background:#4ade80;box-shadow:0 0 6px rgba(74,222,128,.8);animation:defi-gas-pulse 2s ease-in-out infinite}
    @keyframes defi-gas-pulse{0%,100%{opacity:1}50%{opacity:.4}}
    .defi-gas__chain{display:inline-flex;align-items:center;gap:4px;color:var(--defi-text,#e6ebff)}
    .defi-gas__chain b{font-weight:700;font-variant-numeric:tabular-nums}
    .defi-gas__chain span{color:var(--defi-text-dim,#94a3b8);font-weight:500}
    .defi-gas__sep{color:var(--defi-text-dim,#475569)}
    .defi-gas--err .defi-gas__dot{background:#fca5a5;box-shadow:0 0 6px rgba(252,165,165,.8);animation:none}
  `;

  const SHORT = { ethereum: "ETH", arbitrum: "ARB", polygon: "POL" };

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID; s.textContent = CSS;
    document.head.appendChild(s);
  }

  function fmt(g) {
    if (g == null) return "—";
    if (g >= 100) return Math.round(g).toString();
    if (g >= 10) return g.toFixed(1);
    return g.toFixed(2);
  }

  function render(el, data, error) {
    if (error) {
      el.classList.add("defi-gas--err");
      el.innerHTML = '<span class="defi-gas__dot"></span><span>Gas unavailable</span>';
      return;
    }
    el.classList.remove("defi-gas--err");
    const parts = (data.chains || [])
      .map((c) => '<span class="defi-gas__chain"><span>' + (SHORT[c.chain] || c.chain) + '</span><b>' + fmt(c.gwei) + '</b></span>')
      .join('<span class="defi-gas__sep">·</span>');
    el.innerHTML = '<span class="defi-gas__dot" title="Live gas (gwei)"></span>' + parts +
      '<span class="defi-gas__chain"><span>gwei</span></span>';
    el.title = "Last update: " + (data.timestamp || "") + (data.cached ? " (cached)" : "");
  }

  async function tick(els, base) {
    try {
      const res = await fetch(base + "/api/gas", { headers: { "Accept": "application/json" } });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || ("HTTP " + res.status));
      els.forEach((el) => render(el, data, null));
    } catch (e) {
      els.forEach((el) => render(el, null, e));
    }
  }

  function init() {
    const els = document.querySelectorAll("[data-defi-gas]");
    if (!els.length) return;
    const base = (window.DEFI_RISK_WORKER_URL || "").replace(/\/$/, "");
    if (!base) {
      els.forEach((el) => (el.style.display = "none"));
      return;
    }
    injectStyle();
    els.forEach((el) => el.classList.add("defi-gas"));
    tick(els, base);
    setInterval(() => tick(els, base), POLL_MS);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
