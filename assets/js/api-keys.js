/* DeFiScoring – api-keys.js
 *
 * The API-key panel on /dashboard/settings/. Issues, lists and revokes the
 * keys that authenticate the metered API, and shows the account's daily budget
 * so a customer can see what they are paying for.
 *
 * The raw key exists in this page exactly once, right after creation. We show
 * it in a copy-once block and never re-fetch it, because the worker only ever
 * stored its hash.
 */
(function () {
  if (window.DefiApiKeys) return;

  var ROOT_ID = "ds-api-keys";
  var state = { loading: true, data: null, error: null, freshKey: null };

  function api(path, opts) {
    return fetch((window.DEFI_WORKER_URL || "") + path, Object.assign({
      credentials: "include",
      headers: { "content-type": "application/json" },
    }, opts || {})).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, json: j }; });
    });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtDate(ms) {
    if (!ms) return "—";
    try { return new Date(ms).toLocaleDateString(); } catch (e) { return "—"; }
  }

  function render() {
    var root = document.getElementById(ROOT_ID);
    if (!root) return;

    if (state.loading) { root.innerHTML = '<p class="ds-keys__muted">Loading API keys…</p>'; return; }
    if (state.error)   { root.innerHTML = '<p class="ds-keys__muted">' + esc(state.error) + "</p>"; return; }

    var d = state.data;
    var html = "";

    if (!d.api_access) {
      html += '<div class="ds-keys__locked">' +
        "<p>Programmatic API access is included with <strong>Plus</strong> and " +
        "<strong>Enterprise</strong>. Your plan is <strong>" + esc(d.tier) + "</strong>.</p>" +
        '<a class="ds-settings__action ds-settings__action--primary" href="/pricing/">See plans</a>' +
        "</div>";
      root.innerHTML = html;
      return;
    }

    var pct = d.quota.limit ? Math.min(100, Math.round((d.quota.used / d.quota.limit) * 100)) : 0;
    html += '<div class="ds-keys__quota">' +
      '<div class="ds-keys__quota-head"><span>Daily API requests</span>' +
      '<span class="ds-keys__quota-num">' + d.quota.used + " / " + d.quota.limit + "</span></div>" +
      '<div class="ds-keys__bar"><span style="width:' + pct + '%"></span></div>' +
      (d.quota.resets_at
        ? '<p class="ds-keys__muted">Resets ' + esc(new Date(d.quota.resets_at).toUTCString()) + "</p>"
        : '<p class="ds-keys__muted">The window starts on your first request of the day.</p>') +
      "</div>";

    if (state.freshKey) {
      html += '<div class="ds-keys__fresh">' +
        "<p><strong>Copy this key now.</strong> It is hashed on save and cannot be shown again.</p>" +
        '<code class="ds-keys__secret" id="ds-key-secret">' + esc(state.freshKey) + "</code>" +
        '<button type="button" class="ds-settings__action" data-copy-key>Copy</button>' +
        "</div>";
    }

    var active = d.keys.filter(function (k) { return !k.revoked; });
    html += '<div class="ds-keys__list">';
    if (!d.keys.length) {
      html += '<p class="ds-keys__muted">No keys yet. Create one to call the API from your own systems.</p>';
    } else {
      html += '<table class="ds-keys__table"><thead><tr>' +
        "<th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th>Today</th><th></th>" +
        "</tr></thead><tbody>";
      d.keys.forEach(function (k) {
        html += '<tr class="' + (k.revoked ? "is-revoked" : "") + '">' +
          "<td>" + esc(k.name || "Untitled") + (k.revoked ? ' <span class="ds-keys__tag">revoked</span>' : "") + "</td>" +
          "<td><code>" + esc(k.prefix) + "…</code></td>" +
          "<td>" + esc(fmtDate(k.created_at)) + "</td>" +
          "<td>" + esc(fmtDate(k.last_used_at)) + "</td>" +
          "<td>" + (k.requests_today || 0) + "</td>" +
          "<td>" + (k.revoked ? "" :
            '<button type="button" class="ds-keys__revoke" data-revoke="' + esc(k.id) + '">Revoke</button>') +
          "</td></tr>";
      });
      html += "</tbody></table>";
    }
    html += "</div>";

    var atCap = active.length >= d.max_active_keys;
    html += '<div class="ds-keys__create">' +
      '<input type="text" id="ds-key-name" maxlength="60" placeholder="Key name (e.g. underwriting-prod)"' +
        (atCap ? " disabled" : "") + ">" +
      '<button type="button" class="ds-settings__action ds-settings__action--primary" id="ds-key-create"' +
        (atCap ? " disabled" : "") + ">Create key</button>" +
      "</div>";
    if (atCap) {
      html += '<p class="ds-keys__muted">You have ' + active.length + " active keys (the maximum). " +
        "Revoke one to create another.</p>";
    }

    root.innerHTML = html;
  }

  function load() {
    state.loading = true; render();
    return api("/api/keys").then(function (r) {
      state.loading = false;
      if (r.status === 401) { state.error = "Sign in to manage API keys."; }
      else if (!r.json || r.json.success !== true) { state.error = "Could not load API keys."; }
      else { state.data = r.json; state.error = null; }
      render();
    }).catch(function () {
      state.loading = false; state.error = "Could not load API keys."; render();
    });
  }

  /* A blocking window.confirm()/prompt() holds the main thread for the user's
     entire reading time. These are reached from a click handler, and INP runs
     from the click to the next paint after its handlers finish, so opening one
     inside that task charges the whole dwell to the interaction. Yield a frame
     first: the interaction finishes and paints, and the dialog opens in a later
     task where its duration belongs to nobody. */
  function yieldToPaint() {
    return new Promise(function (r) { requestAnimationFrame(function () { setTimeout(r, 0); }); });
  }

  function onClick(e) {
    var revoke = e.target.closest("[data-revoke]");
    if (revoke) {
      yieldToPaint().then(function () {
        if (!window.confirm("Revoke this key? Any system using it will start receiving 401s immediately.")) return;
        revoke.disabled = true;
        api("/api/keys/" + revoke.getAttribute("data-revoke"), { method: "DELETE" })
          .then(function () { state.freshKey = null; return load(); });
      });
      return;
    }
    if (e.target.closest("[data-copy-key]")) {
      var el = document.getElementById("ds-key-secret");
      if (el && navigator.clipboard) navigator.clipboard.writeText(el.textContent || "");
      return;
    }
    if (e.target.id === "ds-key-create") {
      var nameEl = document.getElementById("ds-key-name");
      e.target.disabled = true;
      api("/api/keys", {
        method: "POST",
        body: JSON.stringify({ name: (nameEl && nameEl.value) || "" }),
      }).then(function (r) {
        if (r.status === 201 && r.json.api_key) state.freshKey = r.json.api_key;
        else if (r.json && r.json.message) window.alert(r.json.message);
        return load();
      });
    }
  }

  function init() {
    var root = document.getElementById(ROOT_ID);
    if (!root) return;
    root.addEventListener("click", onClick);
    load();
  }

  window.DefiApiKeys = { load: load };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
