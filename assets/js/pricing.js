/* ---------------------------------------------------------------------------
   Pricing page wiring.
   - Reads the user's current tier from /api/auth/me (best-effort) and shows
     a "You're on the X plan" pill at the top, plus a checkmark on the
     matching tier card.
   - "Upgrade to Pro/Plus" → POST /api/billing/checkout, redirect to the
     Stripe Checkout URL it returns.
   - Handles return states: /pricing/?billing=cancelled → toast.
   - Free tier "Get started" → /dashboard/.
--------------------------------------------------------------------------- */
(function () {
  "use strict";

  var WORKER = (window.DEFI_RISK_WORKER_URL || "").replace(/\/$/, "");
  if (!WORKER) {
    console.warn("[pricing] DEFI_RISK_WORKER_URL is not set");
  }

  /* ---------- helpers ---------- */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  function api(path, opts) {
    opts = opts || {};
    return fetch(WORKER + path, Object.assign({
      credentials: "include",
      headers: Object.assign(
        { "content-type": "application/json" },
        opts.headers || {}
      ),
    }, opts)).then(function (r) {
      return r.json().then(function (j) { j.__status = r.status; return j; }).catch(function () {
        return { success: false, error: "non_json_response", __status: r.status };
      });
    });
  }

  function toast(msg, kind) {
    var el = document.createElement("div");
    el.className = "pr-toast pr-toast--" + (kind || "ok");
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(function () { el.classList.add("is-show"); });
    setTimeout(function () {
      el.classList.remove("is-show");
      setTimeout(function () { el.remove(); }, 320);
    }, 4200);
  }

  /* ---------- current plan badge ---------- */

  function highlightCurrentTier(tier) {
    if (!tier) return;
    var card = document.querySelector('.pr-tier[data-tier="' + tier + '"]');
    if (card) {
      var btn = card.querySelector(".pr-cta");
      if (btn && btn.dataset.prAction === "checkout") {
        btn.textContent = "Current plan";
        btn.disabled = true;
        btn.classList.remove("pr-cta--primary");
        btn.classList.add("pr-cta--ghost");
      }
    }

    var pill = document.getElementById("pr-current-plan");
    if (pill) {
      var label = tier.charAt(0).toUpperCase() + tier.slice(1);
      pill.innerHTML = "You're on the <strong>" + label + "</strong> plan." +
        ' <a href="#" data-pr-portal>Manage subscription</a>';
      pill.hidden = false;
    }
  }

  function loadCurrentPlan() {
    return api("/api/auth/me").then(function (r) {
      if (r && r.success && r.subscription) {
        highlightCurrentTier(r.subscription.tier);
      }
      return r;
    }).catch(function () { /* silent — anonymous is fine */ });
  }

  /* ---------- checkout ---------- */

  function startCheckout(tier, btn) {
    var orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Redirecting…";
    return api("/api/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ tier: tier }),
    }).then(function (r) {
      if (r && r.success && r.url) {
        window.location.href = r.url;
        return;
      }
      // Not signed in → bounce them to dashboard to connect + sign in, then come back.
      if (r.__status === 401) {
        toast("Sign in to your wallet first, then come back to upgrade.", "warn");
        setTimeout(function () { window.location.href = "/dashboard/?intent=upgrade&tier=" + tier; }, 1500);
        return;
      }
      if (r.error === "stripe_not_configured") {
        toast("Billing is being configured — please email sales@defiscoring.com", "warn");
      } else {
        toast("Couldn't start checkout: " + (r.error || "unknown"), "bad");
      }
      btn.disabled = false;
      btn.textContent = orig;
    }).catch(function (e) {
      toast("Network error — please try again.", "bad");
      btn.disabled = false;
      btn.textContent = orig;
    });
  }

  function openPortal(linkEl) {
    linkEl.textContent = "Opening…";
    return api("/api/billing/portal", { method: "POST" }).then(function (r) {
      if (r && r.success && r.url) {
        window.location.href = r.url;
        return;
      }
      toast("Couldn't open billing portal: " + (r.error || "unknown"), "bad");
      linkEl.textContent = "Manage subscription";
    });
  }

  /* ---------- post-checkout return states ---------- */

  function handleReturnState() {
    var qs = new URLSearchParams(window.location.search);
    var status = qs.get("billing");
    if (!status) return;

    if (status === "cancelled") {
      toast("Checkout cancelled — no charge made.", "warn");
    } else if (status === "success") {
      // Stripe normally redirects to /dashboard/ on success; covered here too
      // in case we ever change the success URL to /pricing/.
      toast("Payment received! Your plan is updating…", "ok");
    }
    // Clean the URL so a refresh doesn't re-fire the toast.
    if (history.replaceState) {
      var clean = window.location.pathname + window.location.hash;
      history.replaceState(null, "", clean);
    }
  }

  /* ---------- wire up ---------- */

  document.addEventListener("click", function (ev) {
    var t = ev.target.closest("[data-pr-action]");
    if (!t) {
      var portal = ev.target.closest("[data-pr-portal]");
      if (portal) {
        ev.preventDefault();
        openPortal(portal);
      }
      return;
    }
    var action = t.dataset.prAction;
    if (action === "dashboard") {
      window.location.href = "/dashboard/";
    } else if (action === "checkout") {
      ev.preventDefault();
      var tier = t.dataset.prTier;
      if (tier === "pro" || tier === "plus") startCheckout(tier, t);
    }
  });

  handleReturnState();
  loadCurrentPlan();
})();
