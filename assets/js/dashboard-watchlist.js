/* DeFiScoring – Watched Wallets page
 * CRUD against /api/watched-wallets. Score chips reuse the canonical band
 * thresholds via DefiState.bandFor and the shared coverage phrasing via
 * DefiState.coverageLabel, so a watched wallet renders exactly like the
 * owner's own score elsewhere.
 */
(function () {
  function $(s) { return document.querySelector(s); }
  var API = (window.DefiAPI && window.DefiAPI.apiBase) || "";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function toast(msg, kind) {
    if (window.DefiToast) window.DefiToast(msg, kind);
    else console.log("[watchlist]", kind, msg);
  }
  async function api(path, opts) {
    var res = await fetch(API + path, Object.assign({ credentials: "include" }, opts || {}));
    var j; try { j = await res.json(); } catch (e) { j = { success: false, error: "bad_response" }; }
    j.__status = res.status;
    return j;
  }

  function chip(entry) {
    if (entry.score == null) {
      return '<span style="color:var(--defi-text-mute)">no scan yet</span>';
    }
    var band = entry.score_band
      ? entry.score_band[0].toUpperCase() + entry.score_band.slice(1)
      : window.DefiState.bandFor(entry.score);
    var cov = window.DefiState.coverageLabel && window.DefiState.coverageLabel(entry.coverage);
    var covHtml = cov && entry.coverage != null && entry.coverage < 1
      ? ' <span style="color:' + cov.color + ';font-size:11px">· ' + cov.pct + "% data</span>"
      : "";
    return '<span style="font-family:var(--defi-font-mono);font-weight:700">' + entry.score + "</span> " +
      '<span class="defi-band--' + esc(band) + '">' + esc(band) + "</span>" + covHtml;
  }

  async function render() {
    var list = await api("/api/watched-wallets");
    if (list.__status === 401) {
      $("#wl-signin-required").style.display = "";
      $("#wl-main").style.display = "none";
      return;
    }
    $("#wl-signin-required").style.display = "none";
    $("#wl-main").style.display = "";
    var entries = list.entries || [];
    $("#wl-empty").style.display = entries.length ? "none" : "";
    var rows = entries.map(function (e) {
      var short = e.wallet.slice(0, 6) + "…" + e.wallet.slice(-4);
      var scored = e.scored_at ? new Date(e.scored_at).toLocaleDateString() : "—";
      return "<tr>" +
        '<td><a href="/dashboard/score/?wallet=' + esc(e.wallet) + '" style="font-family:var(--defi-font-mono)">' + esc(short) + "</a></td>" +
        "<td>" + esc(e.label || "") + "</td>" +
        "<td>" + chip(e) + "</td>" +
        '<td style="color:var(--defi-text-dim)">' + scored + "</td>" +
        '<td><button type="button" class="defi-btn defi-btn--ghost" data-wl-remove="' + esc(e.id) + '">Remove</button></td>' +
        "</tr>";
    }).join("");
    $("#wl-table").innerHTML = entries.length
      ? '<table class="defi-table"><thead><tr><th>Wallet</th><th>Label</th><th>Latest score</th><th>Last scored</th><th></th></tr></thead><tbody>' + rows + "</tbody></table>"
      : "";
  }

  async function onAdd(ev) {
    ev.preventDefault();
    var wallet = $("#wl-address").value.trim();
    var label = $("#wl-label").value.trim();
    var r = await api("/api/watched-wallets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: wallet, label: label || null }),
    });
    if (!r.success) {
      if (r.error === "watchlist_limit_reached") {
        toast("Watchlist full on your tier (" + r.current + "/" + r.limit + ") — upgrade to watch more.", "warn");
      } else if (r.error === "already_watching") {
        toast("You're already watching that wallet.", "warn");
      } else {
        toast("Couldn't add: " + r.error, "bad");
      }
      return;
    }
    $("#wl-address").value = ""; $("#wl-label").value = "";
    toast("Watching " + wallet.slice(0, 8) + "… — first automatic scan lands within the day.", "ok");
    render();
  }

  document.addEventListener("click", async function (ev) {
    var btn = ev.target.closest("[data-wl-remove]");
    if (!btn) return;
    var r = await api("/api/watched-wallets/" + btn.getAttribute("data-wl-remove"), { method: "DELETE" });
    if (r.success) { toast("Removed.", "ok"); render(); }
    else toast("Couldn't remove: " + r.error, "bad");
  });

  document.addEventListener("DOMContentLoaded", function () {
    var form = $("#wl-add-form");
    if (form) form.addEventListener("submit", onAdd);
    render();
  });
})();
