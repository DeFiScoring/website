/* DeFi Scoring – data-aggregation.js
 *
 * Live market-data widget. Three independent, real-data sources, all CORS-
 * enabled and free (no API keys needed):
 *
 *   1. DeFiLlama /protocols        → top protocols by TVL
 *   2. CoinGecko /simple/price     → BTC / ETH / USDC spot
 *   3. DeFiLlama /protocol/aave-v3 → Aave V3 TVL by chain (replaces the
 *                                    decommissioned Graph hosted-service
 *                                    endpoint — same intent, real numbers)
 *
 * Each panel renders independently: if one source 5xx's, the others still
 * show. Auto-refreshes every 60s only while the tab is visible (avoids
 * hammering CoinGecko's free tier when the page is backgrounded).
 *
 * Style matches the site's defi-* CSS — no Tailwind dependency.
 */
(function () {
  if (window.__defiDataAggInit) return;
  window.__defiDataAggInit = true;

  const STYLE_ID = "defi-dataagg-style";
  const CSS = `
    .defi-dataagg{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}
    .defi-dataagg__card{border:1px solid var(--defi-border,rgba(148,163,184,.25));border-radius:14px;padding:18px;background:var(--defi-card-bg,rgba(15,23,42,.4));color:var(--defi-text,#e6ebff);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
    .defi-dataagg__head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px}
    .defi-dataagg__title{margin:0;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}
    .defi-dataagg__source{font-size:10px;color:var(--defi-text-dim,#94a3b8);font-weight:600}
    .defi-dataagg__list{margin:0;padding:0;list-style:none}
    .defi-dataagg__row{display:flex;justify-content:space-between;align-items:baseline;padding:8px 0;border-bottom:1px solid rgba(148,163,184,.1);font-size:13px}
    .defi-dataagg__row:last-child{border-bottom:none}
    .defi-dataagg__label{color:var(--defi-text,#e6ebff)}
    .defi-dataagg__sublabel{display:block;font-size:11px;color:var(--defi-text-dim,#94a3b8);margin-top:2px}
    .defi-dataagg__value{font-variant-numeric:tabular-nums;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
    .defi-dataagg__value--up{color:#4ade80}
    .defi-dataagg__value--down{color:#fca5a5}
    .defi-dataagg__delta{display:block;font-size:11px;font-weight:500;margin-top:2px}
    .defi-dataagg__loading{font-size:12px;color:var(--defi-text-dim,#94a3b8);font-style:italic}
    .defi-dataagg__error{font-size:12px;color:#fca5a5;line-height:1.5}
    .defi-dataagg__meta{font-size:10px;color:var(--defi-text-dim,#94a3b8);margin-top:12px;text-align:right}
  `;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID; s.textContent = CSS;
    document.head.appendChild(s);
  }

  function fmtUsd(n) {
    if (n == null || isNaN(n)) return "—";
    if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "k";
    if (n >= 1) return "$" + n.toFixed(2);
    return "$" + n.toFixed(4);
  }
  function fmtPrice(n) {
    if (n == null || isNaN(n)) return "—";
    return "$" + n.toLocaleString(undefined, { maximumFractionDigits: n >= 1 ? 2 : 4 });
  }
  function fmtPct(n) {
    if (n == null || isNaN(n)) return "";
    const sign = n >= 0 ? "+" : "";
    return sign + n.toFixed(2) + "%";
  }
  function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }

  function card(title, source, body) {
    return '<div class="defi-dataagg__card">' +
      '<div class="defi-dataagg__head">' +
        '<h3 class="defi-dataagg__title">' + escapeHtml(title) + '</h3>' +
        '<span class="defi-dataagg__source">' + escapeHtml(source) + '</span>' +
      '</div>' + body + '</div>';
  }

  // ── Source 1: DeFiLlama top protocols ──────────────────────────────────
  async function fetchTopProtocols() {
    const res = await fetch("https://api.llama.fi/protocols");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    return data
      .filter((p) => typeof p.tvl === "number" && p.tvl > 0)
      .sort((a, b) => b.tvl - a.tvl)
      .slice(0, 6)
      .map((p) => ({
        name: p.name,
        tvl: p.tvl,
        category: p.category || "DeFi",
        change1d: typeof p.change_1d === "number" ? p.change_1d : null,
      }));
  }
  function renderTopProtocols(list) {
    return card("Top TVL Protocols", "DeFiLlama",
      '<ul class="defi-dataagg__list">' + list.map((p) => {
        const dir = p.change1d == null ? "" : p.change1d >= 0 ? "defi-dataagg__value--up" : "defi-dataagg__value--down";
        return '<li class="defi-dataagg__row">' +
          '<span class="defi-dataagg__label">' + escapeHtml(p.name) +
            '<span class="defi-dataagg__sublabel">' + escapeHtml(p.category) + '</span></span>' +
          '<span class="defi-dataagg__value">' + fmtUsd(p.tvl) +
            (p.change1d != null ? '<span class="defi-dataagg__delta ' + dir + '">' + fmtPct(p.change1d) + ' 24h</span>' : '') +
          '</span>' +
        '</li>';
      }).join("") + '</ul>'
    );
  }

  // ── Source 2: CoinGecko spot prices ────────────────────────────────────
  async function fetchPrices() {
    const url = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,usd-coin&vs_currencies=usd&include_24hr_change=true";
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }
  function renderPrices(d) {
    const rows = [
      { sym: "BTC", name: "Bitcoin", id: "bitcoin" },
      { sym: "ETH", name: "Ethereum", id: "ethereum" },
      { sym: "USDC", name: "USD Coin", id: "usd-coin" },
    ];
    return card("Spot prices", "CoinGecko",
      '<ul class="defi-dataagg__list">' + rows.map((r) => {
        const item = d[r.id] || {};
        const ch = typeof item.usd_24h_change === "number" ? item.usd_24h_change : null;
        const dir = ch == null ? "" : ch >= 0 ? "defi-dataagg__value--up" : "defi-dataagg__value--down";
        return '<li class="defi-dataagg__row">' +
          '<span class="defi-dataagg__label">' + r.sym +
            '<span class="defi-dataagg__sublabel">' + r.name + '</span></span>' +
          '<span class="defi-dataagg__value">' + fmtPrice(item.usd) +
            (ch != null ? '<span class="defi-dataagg__delta ' + dir + '">' + fmtPct(ch) + ' 24h</span>' : '') +
          '</span>' +
        '</li>';
      }).join("") + '</ul>'
    );
  }

  // ── Source 3: DeFiLlama Aave V3 per-chain breakdown ────────────────────
  async function fetchAaveV3() {
    const res = await fetch("https://api.llama.fi/protocol/aave-v3");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const ctv = data.currentChainTvls || {};
    // Filter out borrowed/staking variants — keep base chain TVL keys (no dash).
    const rows = Object.entries(ctv)
      .filter(([k, v]) => !k.includes("-") && typeof v === "number" && v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([chain, tvl]) => ({ chain, tvl }));
    return { rows, totalTvl: typeof data.tvl === "number" ? data.tvl : (Array.isArray(data.tvl) ? null : null) };
  }
  function renderAaveV3(d) {
    const total = d.rows.reduce((s, r) => s + r.tvl, 0);
    return card("Aave V3 TVL by chain", "DeFiLlama",
      '<ul class="defi-dataagg__list">' + d.rows.map((r) => {
        const pct = total ? (r.tvl / total) * 100 : 0;
        return '<li class="defi-dataagg__row">' +
          '<span class="defi-dataagg__label">' + escapeHtml(r.chain) +
            '<span class="defi-dataagg__sublabel">' + pct.toFixed(1) + '% of protocol</span></span>' +
          '<span class="defi-dataagg__value">' + fmtUsd(r.tvl) + '</span>' +
        '</li>';
      }).join("") + '</ul>'
    );
  }

  function renderError(title, source, msg) {
    return card(title, source, '<div class="defi-dataagg__error">Couldn\'t load: ' + escapeHtml(msg) + '</div>');
  }
  function renderLoading(title, source) {
    return card(title, source, '<div class="defi-dataagg__loading">Loading…</div>');
  }

  async function fetchDeFiData() {
    const container = document.getElementById("data-aggregation-container");
    if (!container) return;
    injectStyle();

    container.innerHTML =
      '<div class="defi-dataagg">' +
        renderLoading("Top TVL Protocols", "DeFiLlama") +
        renderLoading("Spot prices", "CoinGecko") +
        renderLoading("Aave V3 TVL by chain", "DeFiLlama") +
      '</div>';

    const [top, prices, aave] = await Promise.allSettled([
      fetchTopProtocols(),
      fetchPrices(),
      fetchAaveV3(),
    ]);

    const html =
      '<div class="defi-dataagg">' +
        (top.status === "fulfilled"    ? renderTopProtocols(top.value) : renderError("Top TVL Protocols", "DeFiLlama", top.reason && top.reason.message || "fetch failed")) +
        (prices.status === "fulfilled" ? renderPrices(prices.value)    : renderError("Spot prices", "CoinGecko", prices.reason && prices.reason.message || "fetch failed")) +
        (aave.status === "fulfilled"   ? renderAaveV3(aave.value)      : renderError("Aave V3 TVL by chain", "DeFiLlama", aave.reason && aave.reason.message || "fetch failed")) +
      '</div>' +
      '<div class="defi-dataagg__meta">Updated ' + new Date().toLocaleTimeString() + ' · auto-refreshes every 60s while visible</div>';
    container.innerHTML = html;
  }

  // ── Auto-refresh, but only while tab visible ──────────────────────────
  let timer = null;
  function startAutoRefresh() {
    if (timer) return;
    timer = setInterval(() => {
      if (document.hidden) return;
      if (document.getElementById("data-aggregation-container")) fetchDeFiData();
    }, 60000);
  }

  window.fetchDeFiData = fetchDeFiData;
  window.addEventListener("visibilitychange", () => { if (!document.hidden) fetchDeFiData(); });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { if (document.getElementById("data-aggregation-container")) { fetchDeFiData(); startAutoRefresh(); } });
  } else {
    if (document.getElementById("data-aggregation-container")) { fetchDeFiData(); startAutoRefresh(); }
  }
})();
