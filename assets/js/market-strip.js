/* DeFi Scoring – market-strip.js
 *
 * Powers the collapsible bottom "Live Market" strip. Polls public DeFiLlama +
 * CoinGecko endpoints every 60s for BTC/ETH spot prices, total DeFi TVL,
 * and total RWA TVL. State persists in localStorage.
 */
(function () {
  if (window.__defiMarketStripInit) return;
  window.__defiMarketStripInit = true;

  const POLL_MS = 60000;
  const STATE_KEY = "defi.market-strip.collapsed";

  function fmtUsd(v) {
    if (v == null || isNaN(v)) return "—";
    if (v >= 1e12) return "$" + (v / 1e12).toFixed(2) + "T";
    if (v >= 1e9)  return "$" + (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6)  return "$" + (v / 1e6).toFixed(1) + "M";
    if (v >= 1000) return "$" + Math.round(v).toLocaleString();
    if (v >= 1)    return "$" + v.toFixed(2);
    return "$" + v.toFixed(4);
  }

  function setValue(strip, key, text) {
    const el = strip.querySelector('[data-defi-market-key="' + key + '"] .defi-market-strip__value');
    if (el) el.textContent = text;
  }

  async function fetchJSON(url) {
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  async function refresh(strip) {
    try {
      const [prices, defiTvl, rwaTvl] = await Promise.allSettled([
        fetchJSON("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd"),
        fetchJSON("https://api.llama.fi/v2/historicalChainTvl").then((arr) => Array.isArray(arr) && arr.length ? arr[arr.length - 1].tvl : null),
        fetchJSON("https://api.llama.fi/overview/protocols/RWA").then((d) => d && d.totalDataChart && d.totalDataChart.length ? d.totalDataChart[d.totalDataChart.length - 1][1] : null),
      ]);

      if (prices.status === "fulfilled" && prices.value) {
        setValue(strip, "btc", fmtUsd(prices.value.bitcoin && prices.value.bitcoin.usd));
        setValue(strip, "eth", fmtUsd(prices.value.ethereum && prices.value.ethereum.usd));
      }
      if (defiTvl.status === "fulfilled") setValue(strip, "defi-tvl", fmtUsd(defiTvl.value));
      if (rwaTvl.status === "fulfilled")  setValue(strip, "rwa-tvl",  fmtUsd(rwaTvl.value));

      const upd = strip.querySelector("[data-defi-market-updated]");
      if (upd) upd.textContent = "Updated " + new Date().toLocaleTimeString();
    } catch (e) {
      const upd = strip.querySelector("[data-defi-market-updated]");
      if (upd) upd.textContent = "Live data unavailable";
    }
  }

  function initToggle(strip) {
    const btn = strip.querySelector("[data-defi-market-toggle]");
    if (!btn) return;
    let collapsed = true;
    try { collapsed = localStorage.getItem(STATE_KEY) !== "0"; } catch (_) {}
    apply(collapsed);

    btn.addEventListener("click", () => {
      collapsed = !collapsed;
      apply(collapsed);
      try { localStorage.setItem(STATE_KEY, collapsed ? "1" : "0"); } catch (_) {}
    });

    function apply(c) {
      strip.dataset.collapsed = c ? "true" : "false";
      btn.setAttribute("aria-expanded", c ? "false" : "true");
      document.body.classList.toggle("defi-market-open", !c);
    }
  }

  function init() {
    const strip = document.getElementById("defi-market-strip");
    if (!strip) return;
    initToggle(strip);
    refresh(strip);
    setInterval(() => refresh(strip), POLL_MS);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
