/* DeFi Scoring – tabs.js
 *
 * Lightweight tab strip auto-binder. Any element with [data-defi-tabs] containing
 * <button data-defi-tab-target="panel-id"> children + sibling <div id="panel-id"
 * data-defi-tab-panel> blocks will get tab switching for free.
 *
 *   <div data-defi-tabs="my-module">
 *     <button class="defi-tab" data-defi-tab-target="overview">Overview</button>
 *     <button class="defi-tab" data-defi-tab-target="details">Details</button>
 *   </div>
 *   <div id="overview" data-defi-tab-panel>...</div>
 *   <div id="details"  data-defi-tab-panel hidden>...</div>
 */
(function () {
  if (window.__defiTabsInit) return;
  window.__defiTabsInit = true;

  function activate(strip, targetId) {
    const buttons = strip.querySelectorAll("[data-defi-tab-target]");
    buttons.forEach((b) => {
      const active = b.dataset.defiTabTarget === targetId;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-selected", active ? "true" : "false");
    });
    // Panels are siblings or anywhere in document with matching id.
    buttons.forEach((b) => {
      const id = b.dataset.defiTabTarget;
      const panel = document.getElementById(id);
      if (!panel) return;
      const show = id === targetId;
      panel.hidden = !show;
      panel.classList.toggle("is-active", show);
    });
  }

  function bind(strip) {
    const buttons = strip.querySelectorAll("[data-defi-tab-target]");
    if (!buttons.length) return;
    buttons.forEach((b) => {
      b.setAttribute("role", "tab");
      b.addEventListener("click", () => activate(strip, b.dataset.defiTabTarget));
    });
    const initial = strip.querySelector('[data-defi-tab-target].is-active') || buttons[0];
    if (initial) activate(strip, initial.dataset.defiTabTarget);
  }

  function init() {
    document.querySelectorAll("[data-defi-tabs]").forEach(bind);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
