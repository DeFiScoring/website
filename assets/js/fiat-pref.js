// P5 — Fiat preference dropdown.
// Renders a small <select> into the topbar; persists choice in
// localStorage["defi.fiat"] (the same key dashboard.js + dashboard-home.js
// already read), and dispatches `defi:fiat-changed` so home/portfolio/risk
// renderers can re-fetch with the new currency.
//
// Worker side: handlers/portfolio.js already accepts `?fiat=<ISO4217>` and
// asks CoinGecko to quote in that currency directly, so no client-side FX
// is needed.
(function () {
  var KEY = "defi.fiat";
  var DEFAULT = "USD";
  // Currencies CoinGecko + Intl.NumberFormat both support; ordered by
  // expected usage frequency among DeFi users.
  var OPTIONS = [
    { code: "USD", label: "$ USD" },
    { code: "EUR", label: "€ EUR" },
    { code: "GBP", label: "£ GBP" },
    { code: "CHF", label: "Fr CHF" },
    { code: "JPY", label: "¥ JPY" },
    { code: "AUD", label: "A$ AUD" },
    { code: "CAD", label: "C$ CAD" },
  ];

  function read() {
    try {
      var v = (localStorage.getItem(KEY) || DEFAULT).toUpperCase();
      return /^[A-Z]{3}$/.test(v) ? v : DEFAULT;
    } catch (_e) { return DEFAULT; }
  }
  function write(v) {
    try { localStorage.setItem(KEY, v); } catch (_e) {}
  }

  function mount() {
    var slot = document.getElementById("defi-fiat-pref");
    if (!slot || slot.dataset.mounted === "1") return;
    slot.dataset.mounted = "1";

    var current = read();
    var sel = document.createElement("select");
    sel.id = "defi-fiat-pref-select";
    sel.className = "defi-fiat-pref__select";
    sel.setAttribute("aria-label", "Display currency");
    sel.style.cssText =
      "background:rgba(255,255,255,0.06);color:var(--defi-text,#e7e7ee);" +
      "border:1px solid rgba(255,255,255,0.12);border-radius:6px;" +
      "padding:4px 8px;font-size:12px;font-weight:600;cursor:pointer;" +
      "appearance:none;-webkit-appearance:none;outline:none";

    OPTIONS.forEach(function (o) {
      var opt = document.createElement("option");
      opt.value = o.code;
      opt.textContent = o.label;
      if (o.code === current) opt.selected = true;
      sel.appendChild(opt);
    });

    sel.addEventListener("change", function () {
      var v = (sel.value || DEFAULT).toUpperCase();
      if (!/^[A-Z]{3}$/.test(v)) v = DEFAULT;
      write(v);
      try {
        document.dispatchEvent(new CustomEvent("defi:fiat-changed", {
          detail: { fiat: v },
        }));
      } catch (_e) {}
    });

    slot.appendChild(sel);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }

  // Expose tiny helper so other modules can read/observe without
  // duplicating the localStorage key.
  window.DefiFiat = { get: read, set: function (v) {
    v = String(v || DEFAULT).toUpperCase();
    if (!/^[A-Z]{3}$/.test(v)) v = DEFAULT;
    write(v);
    var sel = document.getElementById("defi-fiat-pref-select");
    if (sel && sel.value !== v) sel.value = v;
    try {
      document.dispatchEvent(new CustomEvent("defi:fiat-changed", {
        detail: { fiat: v },
      }));
    } catch (_e) {}
  } };
})();
