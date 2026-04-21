/* DeFi Scoring – chain-selector.js
 *
 * Wires the sidebar chain pills (ETH/ARB/POL). Clicking sets the active chain,
 * persists to localStorage, and dispatches a `defi:chain-changed` CustomEvent
 * so other modules can react.
 */
(function () {
  if (window.__defiChainSelectorInit) return;
  window.__defiChainSelectorInit = true;

  const KEY = "defi.active-chain";
  const VALID = { ethereum: 1, arbitrum: 1, polygon: 1 };

  function getActive() {
    let v = "ethereum";
    try { const s = localStorage.getItem(KEY); if (s && VALID[s]) v = s; } catch (_) {}
    return v;
  }

  function apply(chain) {
    document.querySelectorAll("[data-defi-chain]").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.defiChain === chain);
      b.setAttribute("aria-pressed", b.dataset.defiChain === chain ? "true" : "false");
    });
    window.DefiActiveChain = chain;
    try { localStorage.setItem(KEY, chain); } catch (_) {}
    document.dispatchEvent(new CustomEvent("defi:chain-changed", { detail: { chain } }));
  }

  function init() {
    const buttons = document.querySelectorAll("[data-defi-chain]");
    if (!buttons.length) return;
    buttons.forEach((b) => {
      b.addEventListener("click", () => apply(b.dataset.defiChain));
    });
    apply(getActive());
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
