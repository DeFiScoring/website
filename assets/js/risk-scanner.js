/* DeFi Scoring – risk-scanner.js
 *
 * Drives the #defi-scanner widget defined by _includes/wallet-check.html.
 * Flow:
 *   1. Connect via DefiWallet (EIP-6963 if available, falls back to EIP-1193).
 *   2. POST { wallet } to <WORKER_URL>/api/exposure.
 *   3. Render exposures: protocol, chain, score, band. Highlight any score < 60.
 *
 * Worker URL is taken from window.DEFI_RISK_WORKER_URL (set in the layout).
 */
(function () {
  if (window.__defiScannerInit) return;
  window.__defiScannerInit = true;

  const STYLE_ID = "defi-scanner-style";
  const CSS = `
    .defi-scanner{border:1px solid var(--defi-border,rgba(148,163,184,.25));border-radius:14px;padding:20px;background:var(--defi-card-bg,rgba(15,23,42,.4));color:var(--defi-text,#e6ebff);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:880px;margin:24px auto}
    .defi-scanner__header{display:flex;justify-content:space-between;gap:18px;flex-wrap:wrap;align-items:flex-start;margin-bottom:14px}
    .defi-scanner__title{margin:0 0 6px;font-size:18px;font-weight:700}
    .defi-scanner__subtitle{margin:0;color:var(--defi-text-dim,#94a3b8);font-size:13px;line-height:1.5;max-width:560px}
    .defi-scanner__actions{display:flex;gap:8px;flex-wrap:wrap}
    .defi-scanner .defi-btn{padding:8px 14px;border-radius:8px;font:600 13px/1 inherit;border:1px solid transparent;cursor:pointer;transition:opacity .15s}
    .defi-scanner .defi-btn:disabled{opacity:.5;cursor:not-allowed}
    .defi-scanner .defi-btn--primary{background:#5b8cff;color:#fff;border-color:#5b8cff}
    .defi-scanner .defi-btn--primary:hover:not(:disabled){background:#4574e6}
    .defi-scanner .defi-btn--ghost{background:transparent;color:var(--defi-text,#e6ebff);border-color:var(--defi-border,rgba(148,163,184,.4))}
    .defi-scanner .defi-btn--ghost:hover:not(:disabled){background:rgba(148,163,184,.08)}
    .defi-scanner__wallet{font:500 13px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--defi-text-dim,#94a3b8);background:rgba(148,163,184,.08);padding:8px 12px;border-radius:8px;margin-bottom:12px;word-break:break-all}
    .defi-scanner__notice{font-size:13px;line-height:1.5;padding:10px 14px;border-radius:8px;background:rgba(234,179,8,.08);color:#facc15;border:1px solid rgba(234,179,8,.3);margin-bottom:12px}
    .defi-scanner__notice--err{background:rgba(239,68,68,.08);color:#fca5a5;border-color:rgba(239,68,68,.3)}
    .defi-scanner__verdict{padding:14px 16px;border-radius:10px;margin-bottom:14px;font-size:14px;font-weight:600;display:flex;align-items:center;gap:10px}
    .defi-scanner__verdict--safe{background:rgba(34,197,94,.1);color:#4ade80;border:1px solid rgba(34,197,94,.4)}
    .defi-scanner__verdict--warn{background:rgba(239,68,68,.1);color:#fca5a5;border:1px solid rgba(239,68,68,.4)}
    .defi-scanner__verdict--info{background:rgba(91,140,255,.08);color:#93c5fd;border:1px solid rgba(91,140,255,.3)}
    .defi-scanner__verdict-dot{width:10px;height:10px;border-radius:50%;background:currentColor}
    .defi-scanner__results-header,.defi-scanner__row{display:grid;grid-template-columns:2fr 1fr 1fr 1.5fr;gap:12px;padding:10px 12px;font-size:13px}
    .defi-scanner__results-header{font-weight:700;text-transform:uppercase;font-size:11px;letter-spacing:.06em;color:var(--defi-text-dim,#94a3b8);border-bottom:1px solid var(--defi-border,rgba(148,163,184,.2))}
    .defi-scanner__row{border-bottom:1px solid var(--defi-border,rgba(148,163,184,.12));align-items:center}
    .defi-scanner__row:last-child{border-bottom:none}
    .defi-scanner__row--high{background:rgba(239,68,68,.05)}
    .defi-scanner__proto{font-weight:600}
    .defi-scanner__proto-cat{font-size:11px;color:var(--defi-text-dim,#94a3b8);font-weight:400;display:block;margin-top:2px}
    .defi-scanner__chain{font-size:12px;color:var(--defi-text-dim,#94a3b8)}
    .defi-scanner__score{font-variant-numeric:tabular-nums;font-weight:700}
    .defi-scanner__status{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;width:fit-content}
    .defi-scanner__status--green{background:rgba(34,197,94,.12);color:#4ade80;border:1px solid rgba(34,197,94,.4)}
    .defi-scanner__status--yellow{background:rgba(234,179,8,.12);color:#facc15;border:1px solid rgba(234,179,8,.4)}
    .defi-scanner__status--red{background:rgba(239,68,68,.12);color:#fca5a5;border:1px solid rgba(239,68,68,.4)}
    .defi-scanner__status--unknown{background:rgba(148,163,184,.1);color:#94a3b8;border:1px solid rgba(148,163,184,.3)}
  `;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  const CHAIN_NAMES = { 1: "Ethereum", 42161: "Arbitrum", 137: "Polygon" };

  function $(id) { return document.getElementById(id); }

  function setNotice(msg, isError) {
    const el = $("defi-scanner-notice");
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ""; return; }
    el.hidden = false;
    el.textContent = msg;
    el.className = "defi-scanner__notice" + (isError ? " defi-scanner__notice--err" : "");
  }

  function setVerdict(kind, text) {
    const el = $("defi-scanner-verdict");
    if (!el) return;
    if (!kind) { el.hidden = true; el.innerHTML = ""; return; }
    el.hidden = false;
    el.className = "defi-scanner__verdict defi-scanner__verdict--" + kind;
    el.innerHTML = '<span class="defi-scanner__verdict-dot"></span><span>' + text + '</span>';
  }

  function renderRows(exposures) {
    const wrap = $("defi-scanner-rows");
    if (!wrap) return;
    wrap.innerHTML = "";
    exposures.forEach((e) => {
      const row = document.createElement("div");
      row.className = "defi-scanner__row" + (typeof e.score === "number" && e.score < 60 ? " defi-scanner__row--high" : "");
      const band = e.band || (typeof e.score !== "number" ? "unknown" : e.score >= 80 ? "green" : e.score >= 50 ? "yellow" : "red");
      const statusLabel = band === "green" ? "Healthy" : band === "yellow" ? "Watch" : band === "red" ? "High risk" : "No score";
      row.innerHTML =
        '<div class="defi-scanner__proto">' + escapeHtml(e.name || e.slug) +
          '<span class="defi-scanner__proto-cat">' + escapeHtml(e.category || "uncategorized") + '</span></div>' +
        '<div class="defi-scanner__chain">' + escapeHtml(CHAIN_NAMES[e.chain_id] || ("chain " + e.chain_id)) + '</div>' +
        '<div class="defi-scanner__score">' + (typeof e.score === "number" ? e.score : "—") + '</div>' +
        '<div><span class="defi-scanner__status defi-scanner__status--' + band + '">' + statusLabel + '</span></div>';
      wrap.appendChild(row);
    });
    $("defi-scanner-results").hidden = !exposures.length;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  async function scan(wallet) {
    const base = window.DEFI_RISK_WORKER_URL;
    if (!base) { setNotice("DEFI_RISK_WORKER_URL not set on this page.", true); return; }
    setNotice("Scanning your wallet across Ethereum, Arbitrum, and Polygon…");
    setVerdict(null);
    $("defi-scanner-results").hidden = true;
    try {
      const res = await fetch(base.replace(/\/$/, "") + "/api/exposure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "scan failed");
      setNotice(null);
      const exposures = data.exposures || [];
      const high = exposures.filter((e) => typeof e.score === "number" && e.score < 60);
      if (!exposures.length) {
        setVerdict("info", "No interactions with catalogued protocols detected on Ethereum / Arbitrum / Polygon. " +
          "If you use protocols not in our catalog, they won't appear here yet.");
      } else if (high.length) {
        setVerdict("warn", high.length + " of " + exposures.length + " catalogued protocols are below the 60 risk threshold. Review the table below.");
      } else {
        setVerdict("safe", "Safety verified — all " + exposures.length + " catalogued protocols you've touched score 60 or above.");
      }
      renderRows(exposures);
    } catch (e) {
      setNotice("Scan failed: " + e.message, true);
    }
  }

  function setConnectedUI(addr) {
    $("defi-scanner-wallet").hidden = !addr;
    $("defi-scanner-wallet").textContent = addr ? "Connected: " + addr : "";
    $("defi-scanner-connect").hidden = !!addr;
    $("defi-scanner-rescan").hidden = !addr;
    $("defi-scanner-disconnect").hidden = !addr;
  }

  function init() {
    if (!$("defi-scanner")) return; // widget not on this page
    injectStyle();

    const tryConnect = async () => {
      if (!window.DefiWallet) { setNotice("Wallet module not loaded.", true); return; }
      const addr = await window.DefiWallet.connect();
      if (!addr) return;
      setConnectedUI(addr);
      scan(addr);
    };

    $("defi-scanner-connect").addEventListener("click", tryConnect);
    $("defi-scanner-rescan").addEventListener("click", () => {
      if (window.DefiWallet && window.DefiWallet.address) scan(window.DefiWallet.address);
    });
    $("defi-scanner-disconnect").addEventListener("click", () => {
      if (window.DefiWallet) window.DefiWallet.disconnect();
      setConnectedUI(null);
      setVerdict(null);
      setNotice(null);
      $("defi-scanner-results").hidden = true;
    });

    // If wallet was previously connected, restore UI but don't auto-scan.
    if (window.DefiWallet && window.DefiWallet.address) {
      setConnectedUI(window.DefiWallet.address);
    }

    document.addEventListener("defi:wallet-changed", (e) => {
      const addr = e.detail && e.detail.wallet;
      setConnectedUI(addr);
      if (addr) scan(addr);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
