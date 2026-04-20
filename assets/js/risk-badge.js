/* DeFi Scoring – risk-badge.js
 *
 * Auto-attaches DeFi protocol risk badges to any element with a
 * `data-protocol` attribute (e.g. <span data-protocol="uniswap"></span>).
 * Fetches scores from the DeFi Scoring Worker and renders a colored pill:
 *   green (80+) · yellow (50–79) · red (<50)
 *
 * The Worker URL is read from window.DEFI_RISK_WORKER_URL.
 * Score responses are cached 6h server-side, so this script can be reloaded
 * freely without hammering DeFiLlama / Etherscan.
 */
(function () {
  const STYLE_ID = "defi-risk-badge-style";
  const CSS = `
    .defi-risk-badge{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;letter-spacing:.02em;border:1px solid transparent;vertical-align:middle}
    .defi-risk-badge__dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
    .defi-risk-badge__score{font-variant-numeric:tabular-nums}
    .defi-risk-badge--loading{color:#94a3b8;background:rgba(148,163,184,.12);border-color:rgba(148,163,184,.3)}
    .defi-risk-badge--green{color:#16a34a;background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.4)}
    .defi-risk-badge--yellow{color:#ca8a04;background:rgba(234,179,8,.12);border-color:rgba(234,179,8,.4)}
    .defi-risk-badge--red{color:#dc2626;background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.4)}
    .defi-risk-badge--error{color:#64748b;background:rgba(100,116,139,.1);border-color:rgba(100,116,139,.3)}
  `;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function setBadge(el, cls, label, score, title) {
    el.className = "defi-risk-badge defi-risk-badge--" + cls;
    el.innerHTML =
      '<span class="defi-risk-badge__dot"></span>' +
      '<span class="defi-risk-badge__label">' + label + '</span>' +
      (score != null ? '<span class="defi-risk-badge__score">' + score + '</span>' : "");
    if (title) el.title = title;
  }

  async function loadOne(el) {
    const slug = el.getAttribute("data-protocol");
    if (!slug) return;
    const base = window.DEFI_RISK_WORKER_URL;
    if (!base) {
      setBadge(el, "error", "n/a", null, "DEFI_RISK_WORKER_URL not set");
      return;
    }
    setBadge(el, "loading", "Scoring…", null, "Fetching " + slug + " score");
    try {
      const res = await fetch(base.replace(/\/$/, "") + "/api/score/" + encodeURIComponent(slug));
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "score unavailable");
      const cls = data.band || "yellow";
      const labelMap = { green: "Low risk", yellow: "Medium", red: "High risk" };
      const label = labelMap[cls] || "Score";
      const tooltip =
        (data.protocol && data.protocol.name ? data.protocol.name + " · " : "") +
        "Trust " + data.pillars.trust.value +
        " · Liveness " + data.pillars.liveness.value +
        " · Security " + data.pillars.security.value +
        (data.cached ? " (cached)" : "");
      setBadge(el, cls, label, data.score, tooltip);
    } catch (e) {
      setBadge(el, "error", "unavailable", null, slug + ": " + e.message);
    }
  }

  function loadAll(root) {
    const scope = root || document;
    const els = scope.querySelectorAll("[data-protocol]:not([data-protocol-loaded])");
    els.forEach((el) => {
      el.setAttribute("data-protocol-loaded", "1");
      loadOne(el);
    });
  }

  function init() {
    injectStyle();
    loadAll(document);
    // Re-scan when new content is injected (dashboard pages, etc.)
    if (window.MutationObserver) {
      const obs = new MutationObserver((muts) => {
        muts.forEach((m) => m.addedNodes && m.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return;
          if (n.hasAttribute && n.hasAttribute("data-protocol")) loadAll(n.parentNode);
          else if (n.querySelectorAll) loadAll(n);
        }));
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.DefiRiskBadge = { reload: loadAll };
})();
