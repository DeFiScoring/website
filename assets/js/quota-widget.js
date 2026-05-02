/* ---------------------------------------------------------------------------
   Dashboard quota widget — small bar in the topbar showing the user's
   most-relevant rate-limited quota for their tier (e.g. "AI explain:
   12/20 today · resets in 6h").

   Mounts into #defi-quota-widget if present. Re-renders on:
     - DOMContentLoaded (initial)
     - DefiAuth state changes (sign-in/out, tier change)
     - any 'defi:quota-changed' custom event your handler can dispatch
       after a quota-consuming action (AI explain, simulator run, etc.)
--------------------------------------------------------------------------- */
(function () {
  "use strict";

  // The single most-interesting key per tier — what the user's most likely
  // to bump into. Free tier doesn't have any rolling quotas to show.
  var FEATURED_KEY_BY_TIER = {
    free:       null,
    pro:        "ai.explain.day",
    plus:       "ai.explain.day",
    enterprise: null, // limits are effectively unbounded
  };

  function mount() { return document.getElementById("defi-quota-widget"); }

  function fmtResetIn(ms) {
    if (!ms || ms <= 0) return "";
    var h = Math.floor(ms / 3600000);
    if (h >= 24) return Math.floor(h / 24) + "d";
    if (h >= 1)  return h + "h";
    var m = Math.max(1, Math.floor(ms / 60000));
    return m + "m";
  }

  function labelFor(key) {
    return ({
      "ai.explain.day":        "AI",
      "simulator.runs.day":    "Sim",
      "bulk_api.requests.day": "Bulk API",
    })[key] || key;
  }

  function render(snapshot) {
    var el = mount();
    if (!el) return;
    if (!snapshot) { el.style.display = "none"; el.innerHTML = ""; return; }

    var key = FEATURED_KEY_BY_TIER[snapshot.tier];
    if (!key || !snapshot.quotas[key]) {
      el.style.display = "none"; el.innerHTML = ""; return;
    }
    var q = snapshot.quotas[key];
    if (!q.limit) { el.style.display = "none"; el.innerHTML = ""; return; }

    var pct = Math.min(100, Math.round((q.used / q.limit) * 100));
    var color = pct >= 90 ? "#ff5d6c" : pct >= 70 ? "#facc15" : "#2bd4a4";
    var resetIn = q.reset_at ? fmtResetIn(q.reset_at - Date.now()) : "";

    el.style.display = "";
    el.innerHTML = '' +
      '<div class="defi-quota-widget__head">' +
        '<span class="defi-quota-widget__label">' + labelFor(key) + '</span>' +
        '<span class="defi-quota-widget__nums">' + q.used + '/' + q.limit +
          (resetIn ? ' · ' + resetIn : '') + '</span>' +
      '</div>' +
      '<div class="defi-quota-widget__bar">' +
        '<div class="defi-quota-widget__fill" style="width:' + pct + '%;background:' + color + '"></div>' +
      '</div>';
    el.title = labelFor(key) + ": " + q.used + " of " + q.limit + " used" +
      (resetIn ? " · resets in " + resetIn : "");
  }

  // In-flight de-dupe so rapid signed-in events don't fan out to multiple fetches.
  var inflight = null;
  async function refresh() {
    if (!window.DefiAuth) return;
    var snap = window.DefiAuth.snapshot();
    if (!snap.isSignedIn) { render(null); return; }
    if (inflight) return inflight;
    inflight = (async function () {
      try {
        var res = await fetch("/api/quota", { credentials: "include" });
        if (!res.ok) { render(null); return; }
        var data = await res.json();
        if (data && data.success) render(data);
        else render(null);
      } catch {
        render(null);
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  document.addEventListener("DOMContentLoaded", refresh);
  document.addEventListener("defi:quota-changed", refresh);
  if (window.DefiAuth) {
    window.DefiAuth.subscribe(function () { refresh(); });
  }
})();
