/* ---------------------------------------------------------------------------
   Tiny dashboard helper: when Stripe redirects back here with
   ?billing=success&tier=pro, show a confirmation toast and clean the URL.
   Lives standalone so the (already heavy) dashboard JS files don't have to
   pull it in. Safe to load on every dashboard page.
--------------------------------------------------------------------------- */
(function () {
  "use strict";

  var qs = new URLSearchParams(window.location.search);
  var status = qs.get("billing");
  if (!status) return;

  function toast(msg, kind) {
    var el = document.createElement("div");
    el.style.cssText = [
      "position:fixed", "top:20px", "left:50%",
      "transform:translate(-50%,-120%)", "z-index:9999",
      "background:rgba(15,15,20,0.95)", "color:#e8e8f0",
      "border:1px solid " + (kind === "ok" ? "rgba(43,212,164,0.5)"
                            : kind === "warn" ? "rgba(250,204,21,0.5)"
                            : "rgba(255,93,108,0.5)"),
      "backdrop-filter:blur(14px)", "-webkit-backdrop-filter:blur(14px)",
      "padding:14px 22px", "border-radius:12px",
      "font:600 14px/1.4 Inter,system-ui,sans-serif",
      "box-shadow:0 18px 50px rgba(0,0,0,0.5)",
      "transition:transform 280ms cubic-bezier(0.34,1.56,0.64,1)",
    ].join(";");
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(function () {
      el.style.transform = "translate(-50%,0)";
    });
    setTimeout(function () {
      el.style.transform = "translate(-50%,-120%)";
      setTimeout(function () { el.remove(); }, 320);
    }, 4500);
  }

  if (status === "success") {
    var tier = (qs.get("tier") || "").trim();
    var label = tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : "paid";
    toast("Welcome to " + label + "! Your new features are unlocking now.", "ok");
  } else if (status === "cancelled") {
    toast("Checkout cancelled — you weren't charged.", "warn");
  }

  if (history.replaceState) {
    qs.delete("billing");
    qs.delete("tier");
    var clean = window.location.pathname +
      (qs.toString() ? "?" + qs.toString() : "") +
      window.location.hash;
    history.replaceState(null, "", clean);
  }
})();
