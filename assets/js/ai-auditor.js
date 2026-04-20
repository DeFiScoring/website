/* DeFi Scoring – ai-auditor.js
 *
 * Renders an "AI Insights" box for any Solidity contract address on the page.
 *
 * Usage – two ways:
 *   1. Explicit element (recommended):
 *        <div data-audit="0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"
 *             data-chain-id="1"></div>
 *   2. data-auto-audit on a container scans for 0x… addresses inside it:
 *        <div data-auto-audit data-chain-id="1">
 *          <p>Uniswap V3 SwapRouter02: 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45</p>
 *        </div>
 *
 * Worker URL is taken from window.DEFI_RISK_WORKER_URL (set in the layout).
 * Audits are cached server-side for 30 days, so re-renders are essentially free.
 */
(function () {
  if (window.__defiAuditorInit) return;
  window.__defiAuditorInit = true;

  const STYLE_ID = "defi-auditor-style";
  const CSS = `
    .defi-audit{border:1px solid var(--defi-border,rgba(148,163,184,.25));border-radius:12px;padding:18px;background:var(--defi-card-bg,rgba(15,23,42,.4));color:var(--defi-text,#e6ebff);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:14px 0}
    .defi-audit__head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:12px}
    .defi-audit__title{margin:0;font-size:14px;font-weight:700;letter-spacing:.02em;text-transform:uppercase;color:var(--defi-text-dim,#94a3b8)}
    .defi-audit__addr{font:500 12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--defi-text-dim,#94a3b8);word-break:break-all;margin-top:4px}
    .defi-audit__score{font-size:32px;font-weight:800;line-height:1;font-variant-numeric:tabular-nums}
    .defi-audit__score-band{font-size:11px;text-transform:uppercase;letter-spacing:.1em;display:block;margin-top:4px;font-weight:700}
    .defi-audit__score--green{color:#4ade80}
    .defi-audit__score--yellow{color:#facc15}
    .defi-audit__score--red{color:#fca5a5}
    .defi-audit__score--unknown{color:#94a3b8;font-size:14px;font-weight:600}
    .defi-audit__summary{font-size:14px;line-height:1.55;margin:0 0 12px;color:var(--defi-text,#e6ebff)}
    .defi-audit__tags{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}
    .defi-audit__tag{font:600 11px/1 inherit;padding:4px 10px;border-radius:999px;border:1px solid currentColor;background:rgba(148,163,184,.06)}
    .defi-audit__tag--bad{color:#fca5a5;background:rgba(239,68,68,.08)}
    .defi-audit__tag--good{color:#4ade80;background:rgba(34,197,94,.08)}
    .defi-audit__tag--neutral{color:#93c5fd;background:rgba(91,140,255,.08)}
    .defi-audit__pillars{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:12px}
    .defi-audit__pillar{padding:10px 12px;border-radius:8px;background:rgba(148,163,184,.06);border:1px solid var(--defi-border,rgba(148,163,184,.18))}
    .defi-audit__pillar-title{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--defi-text-dim,#94a3b8);font-weight:700;margin-bottom:4px}
    .defi-audit__pillar-score{font-size:18px;font-weight:800;font-variant-numeric:tabular-nums;margin-bottom:4px}
    .defi-audit__pillar-finding{font-size:12px;line-height:1.45;color:var(--defi-text-dim,#cbd5e1)}
    .defi-audit__why{margin-top:8px}
    .defi-audit__why summary{cursor:pointer;font-size:12px;color:var(--defi-text-dim,#94a3b8);font-weight:600;user-select:none}
    .defi-audit__why summary:hover{color:var(--defi-text,#e6ebff)}
    .defi-audit__why-content{margin-top:8px;font-size:12px;line-height:1.5;color:var(--defi-text-dim,#cbd5e1)}
    .defi-audit__meta{font-size:11px;color:var(--defi-text-dim,#94a3b8);margin-top:10px;display:flex;flex-wrap:wrap;gap:10px}
    .defi-audit--loading,.defi-audit--error{font-size:13px;color:var(--defi-text-dim,#94a3b8)}
    .defi-audit--error{color:#fca5a5}
  `;

  const BAD_TAGS = new Set(["#Centralized", "#NoTimelock", "#OracleRisk", "#FlashLoanRisk", "#MintAuthority", "#NoAudit"]);
  const GOOD_TAGS = new Set(["#Timelock", "#Renounced"]);

  const CHAIN_NAMES = { 1: "Ethereum", 42161: "Arbitrum", 137: "Polygon" };

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function bandFor(score) {
    if (typeof score !== "number") return "unknown";
    if (score >= 80) return "green";
    if (score >= 50) return "yellow";
    return "red";
  }

  function tagClass(tag) {
    if (BAD_TAGS.has(tag)) return "defi-audit__tag--bad";
    if (GOOD_TAGS.has(tag)) return "defi-audit__tag--good";
    return "defi-audit__tag--neutral";
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function setLoading(el, address) {
    el.className = "defi-audit defi-audit--loading";
    el.innerHTML = "Auditing " + escapeHtml(address.slice(0, 10) + "…") + " — fetching source and asking the AI…";
  }

  function setError(el, address, msg) {
    el.className = "defi-audit defi-audit--error";
    el.innerHTML = "AI audit unavailable for " + escapeHtml(address.slice(0, 10) + "…") + ": " + escapeHtml(msg);
  }

  function render(el, data) {
    const a = data.audit || {};
    const c = data.contract || {};
    const score = typeof a.safetyScore === "number" ? a.safetyScore : null;
    const band = bandFor(score);
    const bandLabel = band === "green" ? "Low risk" : band === "yellow" ? "Medium risk" : band === "red" ? "High risk" : "Unscored";
    const pillarsHtml = ["adminPrivileges", "upgradeability", "oracleReliance"].map((k) => {
      const p = a[k] || {};
      const ps = typeof p.score === "number" ? p.score : null;
      const pband = bandFor(ps);
      const titleMap = { adminPrivileges: "Admin privileges", upgradeability: "Upgradeability", oracleReliance: "Oracle reliance" };
      return '<div class="defi-audit__pillar">' +
        '<div class="defi-audit__pillar-title">' + titleMap[k] + '</div>' +
        '<div class="defi-audit__pillar-score defi-audit__score--' + pband + '">' + (ps == null ? "—" : ps) + '</div>' +
        '<div class="defi-audit__pillar-finding">' + escapeHtml(p.finding || "No finding returned.") + '</div>' +
      '</div>';
    }).join("");
    const tagsHtml = (a.tags || []).map((t) =>
      '<span class="defi-audit__tag ' + tagClass(t) + '">' + escapeHtml(t) + '</span>'
    ).join("");
    el.className = "defi-audit";
    el.innerHTML =
      '<div class="defi-audit__head">' +
        '<div>' +
          '<h4 class="defi-audit__title">AI Insights' + (c.name ? ' · ' + escapeHtml(c.name) : '') + '</h4>' +
          '<div class="defi-audit__addr">' + escapeHtml(c.address || "") + ' · ' + escapeHtml(CHAIN_NAMES[c.chain_id] || ("chain " + c.chain_id)) +
            (c.proxy ? ' · proxy → ' + escapeHtml((c.implementation || "").slice(0, 10) + "…") : '') + '</div>' +
        '</div>' +
        '<div style="text-align:right">' +
          '<div class="defi-audit__score defi-audit__score--' + band + '">' + (score == null ? "—" : score) + '</div>' +
          '<div class="defi-audit__score-band defi-audit__score--' + band + '">' + bandLabel + '</div>' +
        '</div>' +
      '</div>' +
      (tagsHtml ? '<div class="defi-audit__tags">' + tagsHtml + '</div>' : '') +
      '<p class="defi-audit__summary">' + escapeHtml(a.summary || "") + '</p>' +
      '<div class="defi-audit__pillars">' + pillarsHtml + '</div>' +
      '<details class="defi-audit__why">' +
        '<summary>Why this score?</summary>' +
        '<div class="defi-audit__why-content">' +
          'Score = inverse of admin/upgrade/oracle risk surfaces detected in the source. ' +
          'Pillar scores are LLM-derived from the prioritized code excerpts ' +
          (c.source_truncated ? '(<strong>source was truncated</strong> — ' + (c.source_total_chars || "?") + ' total chars).' : '(full source).') +
        '</div>' +
      '</details>' +
      '<div class="defi-audit__meta">' +
        '<span>Compiler ' + escapeHtml(c.compiler || "?") + '</span>' +
        '<span>License ' + escapeHtml(c.license || "?") + '</span>' +
        (data.cached ? '<span>Served from 30-day cache</span>' : '<span>Fresh audit</span>') +
      '</div>';
  }

  async function audit(el, address, chainId) {
    const base = window.DEFI_RISK_WORKER_URL;
    if (!base) { setError(el, address, "DEFI_RISK_WORKER_URL not set"); return; }
    setLoading(el, address);
    try {
      const res = await fetch(base.replace(/\/$/, "") + "/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, chain_id: chainId || 1 }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "audit failed");
      render(el, data);
    } catch (e) {
      setError(el, address, e.message);
    }
  }

  function processExplicit(el) {
    if (el.hasAttribute("data-audit-loaded")) return;
    el.setAttribute("data-audit-loaded", "1");
    const address = (el.getAttribute("data-audit") || "").trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return;
    const chainId = Number(el.getAttribute("data-chain-id")) || 1;
    audit(el, address, chainId);
  }

  function processAuto(container) {
    if (container.hasAttribute("data-auto-audit-loaded")) return;
    container.setAttribute("data-auto-audit-loaded", "1");
    const chainId = Number(container.getAttribute("data-chain-id")) || 1;
    const text = container.textContent || "";
    const addrs = Array.from(new Set((text.match(/0x[a-fA-F0-9]{40}/g) || [])));
    addrs.forEach((address) => {
      const box = document.createElement("div");
      box.setAttribute("data-audit", address);
      box.setAttribute("data-chain-id", String(chainId));
      box.setAttribute("data-audit-loaded", "1");
      container.appendChild(box);
      audit(box, address, chainId);
    });
  }

  function scan(root) {
    const scope = root || document;
    if (scope.querySelectorAll) {
      scope.querySelectorAll("[data-audit]:not([data-audit-loaded])").forEach(processExplicit);
      scope.querySelectorAll("[data-auto-audit]:not([data-auto-audit-loaded])").forEach(processAuto);
    }
  }

  function init() {
    injectStyle();
    scan(document);
    if (window.MutationObserver) {
      const obs = new MutationObserver((muts) => {
        muts.forEach((m) => m.addedNodes && m.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return;
          if (n.matches && (n.matches("[data-audit]") || n.matches("[data-auto-audit]"))) scan(n.parentNode);
          else scan(n);
        }));
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.DefiAuditor = { rescan: scan, audit };
})();
