/* ---------------------------------------------------------------------------
   Dashboard / Alerts — full CRUD against worker /api/alerts/*
   ---------------------------------------------------------------------------
   Replaces the old localStorage-only skeleton.  Subscribes to DefiAuth so it
   re-renders on sign-in/out and on plan changes.
--------------------------------------------------------------------------- */
(function () {
  "use strict";

  var WORKER = (window.DEFI_RISK_WORKER_URL || "").replace(/\/$/, "");
  var KIND_LABELS = {
    health_factor:    "Health factor",
    score_change:     "Score drop",
    liquidation_risk: "Liquidation risk",
    approval_change:  "Approval change",
    price:            "Price drop",
    protocol_event:   "Protocol event",
  };

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.from((r || document).querySelectorAll(s)); }
  function fmtAddr(a) { return a ? a.slice(0, 6) + "…" + a.slice(-4) : ""; }
  function fmtDate(ms) { return ms ? new Date(ms).toLocaleString() : "—"; }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function toast(msg, kind) {
    var el = document.createElement("div");
    el.className = "defi-toast defi-toast--" + (kind || "ok");
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(function () { el.classList.add("is-show"); });
    setTimeout(function () {
      el.classList.remove("is-show");
      setTimeout(function () { el.remove(); }, 320);
    }, 4200);
  }

  function api(path, opts) {
    opts = opts || {};
    return fetch(WORKER + path, Object.assign({
      credentials: "include",
      headers: Object.assign({ "content-type": "application/json" }, opts.headers || {}),
    }, opts)).then(function (r) {
      return r.json().then(function (j) { j.__status = r.status; return j; }).catch(function () {
        return { success: false, error: "non_json_response", __status: r.status };
      });
    });
  }

  /* ---------- channel form ---------- */

  function showChannelForm(show) {
    $("#channel-form").style.display = show ? "" : "none";
    $("#channel-new-btn").textContent = show ? "Cancel" : "+ Add channel";
    if (show) updateChannelForm();
  }
  function updateChannelForm() {
    var kind = $("#channel-kind").value;
    var label = $("#channel-destination-label");
    var input = $("#channel-destination");
    var hint = $("#telegram-hint");
    if (kind === "email") {
      label.textContent = "Email address";
      input.type = "email";
      input.placeholder = "you@example.com";
      hint.style.display = "none";
    } else {
      label.textContent = "Telegram chat ID";
      input.type = "text";
      input.placeholder = "123456789";
      hint.style.display = "";
    }
  }

  async function submitChannel(ev) {
    ev.preventDefault();
    var kind = $("#channel-kind").value;
    var destination = $("#channel-destination").value.trim();
    var label = $("#channel-label").value.trim();
    var btn = $("#channel-form button[type=submit]");
    btn.disabled = true;
    var r = await api("/api/alerts/channels", {
      method: "POST",
      body: JSON.stringify({ kind: kind, destination: destination, label: label || null }),
    });
    btn.disabled = false;
    if (!r.success) {
      if (r.error === "channel_limit_reached") {
        toast("Channel limit reached for your tier — upgrade for more.", "warn");
      } else {
        toast("Couldn't add channel: " + r.error, "bad");
      }
      return;
    }
    $("#channel-destination").value = "";
    $("#channel-label").value = "";
    showChannelForm(false);
    if (kind === "email") {
      toast("Verification email sent — check your inbox.", "ok");
    } else {
      // Telegram channels are auto-marked as verified once the bot receives
      // /start with the right chat id; we surface the verification token so
      // power users can verify manually if needed.
      toast("Telegram channel created. Send /start to the bot to verify.", "ok");
    }
    await renderChannels();
  }

  async function renderChannels() {
    var r = await api("/api/alerts/channels");
    var rows = (r && r.success) ? r.channels : [];
    var tbody = $("#channels-tbody");
    if (!rows.length) {
      $("#channels-empty").style.display = "";
      $("#channels-table").style.display = "none";
      tbody.innerHTML = "";
      return rows;
    }
    $("#channels-empty").style.display = "none";
    $("#channels-table").style.display = "";
    tbody.innerHTML = rows.map(function (c) {
      var status = c.is_verified
        ? '<span style="color:var(--defi-good)">✓ Verified</span>'
        : '<span style="color:var(--defi-warn)">Pending</span>';
      var icon = c.kind === "email" ? "✉️" : "✈️";
      return (
        "<tr>" +
          "<td>" + icon + " " + escapeHtml(c.kind) + "</td>" +
          "<td><code>" + escapeHtml(c.destination) + "</code>" +
          (c.label ? ' <span style="color:var(--defi-text-dim);font-size:12px">· ' + escapeHtml(c.label) + "</span>" : "") + "</td>" +
          "<td>" + status + "</td>" +
          "<td style=\"color:var(--defi-text-dim);font-size:12px\">" + fmtDate(c.created_at) + "</td>" +
          '<td><button class="defi-btn defi-btn--ghost" data-channel-del="' + c.id + '">Remove</button></td>' +
        "</tr>"
      );
    }).join("");
    return rows;
  }

  async function deleteChannel(id) {
    if (!window.confirm("Remove this channel? Rules using it will fall back to your other channels.")) return;
    var r = await api("/api/alerts/channels/" + encodeURIComponent(id), { method: "DELETE" });
    if (!r.success) { toast("Couldn't remove: " + r.error, "bad"); return; }
    toast("Channel removed.", "ok");
    await renderChannels();
  }

  /* ---------- rule form ---------- */

  function showRuleForm(show) {
    $("#rule-form").style.display = show ? "" : "none";
    $("#rule-new-btn").textContent = show ? "Cancel" : "+ Add rule";
    if (show) refreshRuleFormOptions();
  }

  async function refreshRuleFormOptions() {
    // Wallets dropdown
    var snap = window.DefiAuth.snapshot();
    var sel = $("#rule-wallet");
    sel.innerHTML = snap.wallets.map(function (w) {
      return '<option value="' + w.wallet_address + '">' + fmtAddr(w.wallet_address) +
        (w.label ? " — " + escapeHtml(w.label) : "") + "</option>";
    }).join("");
    if (!snap.wallets.length) {
      sel.innerHTML = '<option value="">No linked wallets — add one in the wallet picker</option>';
    }

    // Channel checkboxes — fetch fresh so newly-added channels appear
    var rChans = await api("/api/alerts/channels");
    var chans = (rChans && rChans.success) ? rChans.channels : [];
    var box = $("#rule-channels");
    if (!chans.length) {
      box.innerHTML = '<span style="color:var(--defi-text-dim);font-size:12px">Add a delivery channel above first.</span>';
    } else {
      box.innerHTML = chans.map(function (c, i) {
        var disabled = !c.is_verified;
        return (
          '<label style="display:inline-flex;align-items:center;gap:6px;font-size:13px;color:' +
          (disabled ? 'var(--defi-text-mute)' : 'var(--defi-text)') + '">' +
            '<input type="checkbox" data-channel-kind="' + c.kind + '" ' +
              (i === 0 && !disabled ? "checked" : "") + (disabled ? " disabled" : "") + ">" +
            (c.kind === "email" ? "✉️ " : "✈️ ") + escapeHtml(c.destination) +
            (disabled ? ' <span style="font-size:10px;color:var(--defi-warn)">(unverified)</span>' : "") +
          '</label>'
        );
      }).join("");
    }
    updateRuleThresholdHint();
  }

  function updateRuleThresholdHint() {
    var kind = $("#rule-kind").value;
    var label = $("#rule-threshold-label");
    var input = $("#rule-threshold");
    var hints = {
      health_factor:    { label: "HF threshold (alert if below)", placeholder: "1.5" },
      score_change:     { label: "Drop in points", placeholder: "30" },
      liquidation_risk: { label: "Risk score (0-100)", placeholder: "70" },
      approval_change:  { label: "Min USD exposure", placeholder: "1000" },
      price:            { label: "Token price USD (alert if below)", placeholder: "1800" },
      protocol_event:   { label: "Protocol slug", placeholder: "aave-v3" },
    }[kind] || { label: "Threshold", placeholder: "" };
    label.textContent = hints.label;
    input.placeholder = hints.placeholder;
  }

  async function submitRule(ev) {
    ev.preventDefault();
    var wallet = $("#rule-wallet").value;
    if (!wallet) { toast("Link a wallet first.", "warn"); return; }
    var kind = $("#rule-kind").value;
    var threshold = $("#rule-threshold").value.trim();
    var cooldown = parseInt($("#rule-cooldown").value, 10) || 60;
    var channels = $$("#rule-channels input[type=checkbox]:checked").map(function (c) {
      return c.dataset.channelKind;
    });
    if (!channels.length) { toast("Pick at least one delivery channel.", "warn"); return; }

    // Build params payload per kind
    var params = {};
    if (kind === "health_factor")     params = { lt: parseFloat(threshold) };
    else if (kind === "score_change") params = { drop: parseInt(threshold, 10) };
    else if (kind === "liquidation_risk") params = { gte: parseFloat(threshold) };
    else if (kind === "approval_change") params = { min_usd: parseFloat(threshold) };
    else if (kind === "price")        params = { lt_usd: parseFloat(threshold) };
    else if (kind === "protocol_event") params = { protocol: threshold };

    var btn = $("#rule-form button[type=submit]");
    btn.disabled = true;
    var r = await api("/api/alerts/rules", {
      method: "POST",
      body: JSON.stringify({
        wallet_address: wallet, kind: kind, params: params,
        channels: channels, cooldown_secs: cooldown * 60,
      }),
    });
    btn.disabled = false;
    if (!r.success) {
      if (r.error === "alert_limit_reached") {
        toast("Rule limit reached on your tier — upgrade to add more.", "warn");
      } else {
        toast("Couldn't add rule: " + r.error, "bad");
      }
      return;
    }
    showRuleForm(false);
    toast("Rule created.", "ok");
    await renderRules();
  }

  function describeParams(kind, params) {
    if (!params) return "";
    if (kind === "health_factor")     return "&lt; " + params.lt;
    if (kind === "score_change")      return "−" + params.drop + " pts";
    if (kind === "liquidation_risk")  return "≥ " + params.gte;
    if (kind === "approval_change")   return "≥ $" + (params.min_usd || 0);
    if (kind === "price")             return "&lt; $" + params.lt_usd;
    if (kind === "protocol_event")    return escapeHtml(params.protocol || "");
    return JSON.stringify(params);
  }

  async function renderRules() {
    var r = await api("/api/alerts/rules");
    var rows = (r && r.success) ? r.rules : [];
    var tbody = $("#rules-tbody");
    if (!rows.length) {
      $("#rules-empty").style.display = "";
      $("#rules-table").style.display = "none";
      tbody.innerHTML = "";
      return;
    }
    $("#rules-empty").style.display = "none";
    $("#rules-table").style.display = "";
    tbody.innerHTML = rows.map(function (rl) {
      return (
        "<tr>" +
          "<td><code>" + fmtAddr(rl.wallet_address) + "</code></td>" +
          "<td>" + escapeHtml(KIND_LABELS[rl.kind] || rl.kind) + "</td>" +
          "<td>" + describeParams(rl.kind, rl.params) + "</td>" +
          "<td>" + (rl.channels || []).map(function (c) { return c === "email" ? "✉️" : "✈️"; }).join(" ") + "</td>" +
          '<td><label class="defi-switch"><input type="checkbox" data-rule-toggle="' + rl.id + '" ' +
            (rl.is_active ? "checked" : "") + "></label></td>" +
          "<td style=\"color:var(--defi-text-dim);font-size:12px\">" + fmtDate(rl.last_fired_at) + "</td>" +
          '<td><button class="defi-btn defi-btn--ghost" data-rule-del="' + rl.id + '">Remove</button></td>' +
        "</tr>"
      );
    }).join("");
  }

  async function toggleRule(id, isActive) {
    var r = await api("/api/alerts/rules/" + encodeURIComponent(id), {
      method: "PUT", body: JSON.stringify({ is_active: !!isActive }),
    });
    if (!r.success) toast("Couldn't update: " + r.error, "bad");
  }

  async function deleteRule(id) {
    if (!window.confirm("Delete this rule?")) return;
    var r = await api("/api/alerts/rules/" + encodeURIComponent(id), { method: "DELETE" });
    if (!r.success) { toast("Couldn't delete: " + r.error, "bad"); return; }
    toast("Rule deleted.", "ok");
    await renderRules();
  }

  /* ---------- deliveries ---------- */

  async function renderDeliveries() {
    var r = await api("/api/alerts/deliveries?limit=25");
    var rows = (r && r.success) ? r.deliveries : [];
    var list = $("#deliveries-list");
    if (!rows.length) { $("#deliveries-empty").style.display = ""; list.innerHTML = ""; return; }
    $("#deliveries-empty").style.display = "none";
    list.innerHTML = rows.map(function (d) {
      var dotColor =
        d.status === "delivered" ? "var(--defi-good)" :
        d.status === "failed"    ? "var(--defi-bad)"  :
        "var(--defi-warn)";
      var msg = d.payload && d.payload.summary ? d.payload.summary : (d.error_message || d.status);
      return (
        '<div class="defi-alert-item">' +
          '<span class="defi-alert-item__dot" style="background:' + dotColor + '"></span>' +
          '<div class="defi-alert-item__body">' +
            '<div class="defi-alert-item__title">' + escapeHtml(msg) + "</div>" +
            '<div class="defi-alert-item__meta">' +
              fmtDate(d.fired_at) + " · " + escapeHtml(d.status) +
            "</div>" +
          "</div>" +
        "</div>"
      );
    }).join("");
  }

  /* ---------- top-level: react to auth state ---------- */

  function applyAuthState(s) {
    var signinReq = $("#alerts-signin-required");
    var paywall = $("#alerts-paywall");
    var app = $("#alerts-app");
    if (!s.isSignedIn) {
      signinReq.style.display = "";
      paywall.style.display = "none";
      app.style.display = "none";
      return;
    }
    signinReq.style.display = "none";
    if (s.tier === "free") {
      paywall.style.display = "";
      app.style.display = "none";
      return;
    }
    paywall.style.display = "none";
    app.style.display = "";
    // Hydrate everything
    renderChannels().then(renderRules).then(renderDeliveries);
  }

  /* ---------- wire up ---------- */

  document.addEventListener("DOMContentLoaded", function () {
    if (!window.DefiAuth) return;

    // Channel form
    $("#channel-new-btn").addEventListener("click", function () {
      showChannelForm($("#channel-form").style.display === "none");
    });
    $("#channel-cancel").addEventListener("click", function () { showChannelForm(false); });
    $("#channel-kind").addEventListener("change", updateChannelForm);
    $("#channel-form").addEventListener("submit", submitChannel);

    // Rule form
    $("#rule-new-btn").addEventListener("click", function () {
      showRuleForm($("#rule-form").style.display === "none");
    });
    $("#rule-cancel").addEventListener("click", function () { showRuleForm(false); });
    $("#rule-kind").addEventListener("change", updateRuleThresholdHint);
    $("#rule-form").addEventListener("submit", submitRule);

    // Delegated row actions
    document.addEventListener("click", function (ev) {
      var del = ev.target.closest("[data-channel-del]");
      if (del) { deleteChannel(del.dataset.channelDel); return; }
      var rdel = ev.target.closest("[data-rule-del]");
      if (rdel) { deleteRule(rdel.dataset.ruleDel); return; }
    });
    document.addEventListener("change", function (ev) {
      var t = ev.target.closest("[data-rule-toggle]");
      if (t) toggleRule(t.dataset.ruleToggle, t.checked);
    });

    window.DefiAuth.subscribe(applyAuthState);
    window.DefiAuth.init().then(function () { applyAuthState(window.DefiAuth.snapshot()); });
  });
})();
