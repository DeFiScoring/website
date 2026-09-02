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

  // Three delivery kinds, three glyphs. Each of these sites used to be a
  // two-way `email ? ✉️ : ✈️`, so a webhook rendered as a Telegram plane.
  var CHANNEL_ICON = { email: "\u2709\uFE0F", telegram: "\u2708\uFE0F", webhook: "\u2693" };
  function channelIcon(kind) { return CHANNEL_ICON[kind] || "\u2022"; }

  function showChannelForm(show) {
    $("#channel-form").style.display = show ? "" : "none";
    $("#channel-new-btn").textContent = show ? "Cancel" : "+ Add channel";
    if (show) updateChannelForm();
  }
  // Field shape per channel kind. The worker validates all three server-side
  // (email regex, numeric chat id, and validateWebhookUrl's SSRF guard), so
  // this only has to get the user to a plausible value — it is not the check.
  var CHANNEL_FIELDS = {
    email:    { label: "Email address",     type: "email", placeholder: "you@example.com", hint: null },
    telegram: { label: "Telegram chat ID",  type: "text",  placeholder: "123456789",       hint: "#telegram-hint" },
    webhook:  { label: "Webhook URL",       type: "url",   placeholder: "https://hooks.example.com/defiscoring", hint: "#webhook-hint" },
  };

  function updateChannelForm() {
    var kind = $("#channel-kind").value;
    var spec = CHANNEL_FIELDS[kind] || CHANNEL_FIELDS.email;
    var input = $("#channel-destination");
    $("#channel-destination-label").textContent = spec.label;
    input.type = spec.type;
    input.placeholder = spec.placeholder;
    Object.keys(CHANNEL_FIELDS).forEach(function (k) {
      var sel = CHANNEL_FIELDS[k].hint;
      var el = sel && $(sel);
      if (el) el.style.display = (k === kind && spec.hint) ? "" : "none";
    });
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
      } else if (r.error === "upgrade_required") {
        // The worker gates webhook channels to Plus and answers 402 with the
        // tier it wanted. Say which plan, rather than echoing an error code.
        toast("Webhook delivery is a " + (r.required_tier || "Plus") + " feature — you're on " +
              (r.current_tier || "a lower tier") + ".", "warn");
      } else if (r.error === "invalid_webhook_url") {
        // `reason` distinguishes "not https" from "resolves to a private
        // address", which is the difference between a typo and a blocked host.
        toast("That webhook URL was rejected: " + (r.reason || "invalid URL") + ".", "bad");
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
    } else if (kind === "webhook") {
      // The signing secret is returned once and never again — the column
      // holds it but no endpoint reads it back. Show it in a panel the user
      // has to dismiss, not a toast that disappears on a timer.
      showWebhookSecret(r.secret, r.secret_notice);
    } else {
      // Telegram channels are auto-marked as verified once the bot receives
      // /start with the right chat id; we surface the verification token so
      // power users can verify manually if needed.
      toast("Telegram channel created. Send /start to the bot to verify.", "ok");
    }
    await renderChannels();
  }

  // A secret shown once needs somewhere it cannot be missed. Rendered inline
  // above the channel table and dismissed by hand, because a 4-second toast
  // is not a place to publish a credential the user cannot recover.
  function showWebhookSecret(secret, notice) {
    if (!secret) { toast("Webhook channel created.", "ok"); return; }
    var host = $("#webhook-secret");
    if (!host) { toast("Webhook created. Signing secret: " + secret, "ok"); return; }
    host.innerHTML =
      '<div class="defi-card__title" style="display:flex;justify-content:space-between;align-items:center;gap:12px">' +
        "<span>Webhook signing secret</span>" +
        '<button type="button" class="defi-btn defi-btn--ghost" data-webhook-secret-dismiss>Done</button>' +
      "</div>" +
      '<p style="margin:6px 0 10px;font-size:12.5px;color:var(--defi-text-dim);line-height:1.55">' +
        escapeHtml(notice || "Copy this now — it is shown once and cannot be retrieved later.") +
      "</p>" +
      '<code style="display:block;padding:10px 12px;border-radius:8px;background:var(--defi-bg-3);' +
      'border:1px solid var(--defi-border);font-family:var(--defi-font-mono);font-size:12.5px;' +
      'word-break:break-all;color:var(--defi-accent)">' + escapeHtml(secret) + "</code>";
    host.style.display = "";
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
      var icon = channelIcon(c.kind);
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
          (disabled ? 'var(--defi-text-muted)' : 'var(--defi-text)') + '">' +
            '<input type="checkbox" data-channel-kind="' + c.kind + '" ' +
              (i === 0 && !disabled ? "checked" : "") + (disabled ? " disabled" : "") + ">" +
            channelIcon(c.kind) + " " + escapeHtml(c.destination) +
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
    // Thresholds here use the evaluator's real semantics: HF and price rules
    // fire on crossing the threshold, liquidation_risk fires while HF sits
    // below it (default 1.1), score_change fires on a drop of >= delta.
    var hints = {
      health_factor:    { label: "HF threshold (alert if below)", placeholder: "1.5" },
      score_change:     { label: "Drop in points", placeholder: "30" },
      liquidation_risk: { label: "HF liquidation threshold", placeholder: "1.1" },
      price:            { label: "Token price USD (alert if below)", placeholder: "1800" },
      protocol_event:   { label: "Protocol slug", placeholder: "aave-v3" },
    }[kind];
    // approval_change has no threshold — any new risky approval alerts.
    var thGroup = $("#rule-threshold-group");
    if (!hints) {
      thGroup.style.display = "none";
      input.required = false;
    } else {
      thGroup.style.display = "";
      input.required = true;
      label.textContent = hints.label;
      input.placeholder = hints.placeholder;
    }
    var tokenGroup = $("#rule-token-group");
    if (tokenGroup) tokenGroup.style.display = kind === "price" ? "" : "none";
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

    // Build params using the names the evaluators actually read
    // (worker/lib/alerts.js PARAM_DEFAULTS). The previous names here — lt,
    // drop, gte, lt_usd — matched nothing, so every user-set threshold was
    // silently ignored and the evaluator defaults applied instead.
    var params = {};
    if (kind === "health_factor")     params = { threshold: parseFloat(threshold), direction: "below" };
    else if (kind === "score_change") params = { delta: parseInt(threshold, 10), direction: "down" };
    else if (kind === "liquidation_risk") params = { threshold: parseFloat(threshold) };
    else if (kind === "approval_change") params = {};
    else if (kind === "price") {
      var token = ($("#rule-token") && $("#rule-token").value.trim()) || "";
      if (!/^0x[0-9a-fA-F]{40}$/.test(token)) {
        toast("Price rules need the token's contract address (0x…).", "warn");
        return;
      }
      params = { token: token, chain: "ethereum", threshold: parseFloat(threshold), direction: "below" };
    }
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
    // Old rules may carry the pre-fix param names (lt/drop/gte) — render
    // both rather than showing "undefined" for rules created before the
    // rename. The evaluator itself falls back to its defaults for those.
    if (kind === "health_factor")     return "&lt; " + (params.threshold ?? params.lt ?? 1.5);
    if (kind === "score_change")      return "−" + (params.delta ?? params.drop ?? 50) + " pts";
    if (kind === "liquidation_risk")  return "HF &lt; " + (params.threshold ?? 1.1);
    if (kind === "approval_change")   return "any new risky approval";
    if (kind === "price")             return (params.direction === "above" ? "&gt;" : "&lt;") + " $" + params.threshold;
    if (kind === "protocol_event")    return escapeHtml(params.protocol || "");
    return JSON.stringify(params);
  }

  // What the evaluator last actually read, per kind, from `last_value`.
  //
  // The cron writes this on EVERY tick whether or not the rule fires
  // (cron.js: "Always update last_value so next tick has reference"), so it is
  // the rule's current reading, refreshed every five minutes — no extra
  // request, no subrequest, just a column on a row this page already fetches.
  //
  // Returns null when there is nothing honest to say. `snapshot` is legitimately
  // null for a rule that has never been evaluated and for protocol_event with no
  // open event, and "no reading" must not render as a zero.
  function describeReading(kind, snap) {
    if (!snap || typeof snap !== "object") return null;
    if (kind === "health_factor" || kind === "liquidation_risk") {
      return typeof snap.hf === "number" ? "HF " + snap.hf.toFixed(2) : null;
    }
    if (kind === "price") {
      return typeof snap.price === "number"
        ? "$" + snap.price.toLocaleString(undefined, { maximumFractionDigits: 2 }) : null;
    }
    if (kind === "score_change") {
      if (typeof snap.score !== "number") return null;
      var d = typeof snap.delta === "number" ? snap.delta : null;
      return "score " + snap.score + (d == null ? "" : " (" + (d > 0 ? "+" : "") + d + ")");
    }
    if (kind === "approval_change") {
      return Array.isArray(snap.approvals)
        ? snap.approvals.length + " approval" + (snap.approvals.length === 1 ? "" : "s") : null;
    }
    return null;
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
      var reading = describeReading(rl.kind, rl.last_value);
      // A rule can be active, matching, and still silent because it is inside
      // its cooldown window. That is the state people read as "broken", so it
      // gets said outright rather than left to look like a rule not firing.
      var cooling = rl.is_cooling_down
        ? '<div style="margin-top:4px;font-size:11px;color:var(--defi-warn)">Cooling down' +
          (rl.next_eligible_at ? " · next " + fmtDate(rl.next_eligible_at) : "") + "</div>"
        : "";
      return (
        "<tr>" +
          "<td><code>" + fmtAddr(rl.wallet_address) + "</code></td>" +
          "<td>" + escapeHtml(KIND_LABELS[rl.kind] || rl.kind) + "</td>" +
          "<td>" + describeParams(rl.kind, rl.params) + "</td>" +
          '<td style="font-family:var(--defi-font-mono);font-size:12px;color:' +
            (reading ? "var(--defi-good)" : "var(--defi-text-muted)") + '">' +
            (reading ? escapeHtml(reading) : "not evaluated yet") + "</td>" +
          "<td>" + (rl.channels || []).map(channelIcon).join(" ") + "</td>" +
          '<td><label class="defi-switch"><input type="checkbox" data-rule-toggle="' + rl.id + '" ' +
            (rl.is_active ? "checked" : "") + "></label>" + cooling + "</td>" +
          "<td style=\"color:var(--defi-text-dim);font-size:12px\">" + fmtDate(rl.last_fired_at) +
            // Separating "last fired" from "last checked" is the difference
            // between a rule that is quiet and a rule that is not running.
            '<div style="font-size:11px;color:var(--defi-text-muted);margin-top:3px">checked ' +
            fmtDate(rl.updated_at) + "</div></td>" +
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
      if (ev.target.closest("[data-webhook-secret-dismiss]")) {
        var host = $("#webhook-secret");
        // Clear the node as well as hiding it — the secret should not sit in
        // the DOM after the user says they have it.
        if (host) { host.innerHTML = ""; host.style.display = "none"; }
        return;
      }
    });
    document.addEventListener("change", function (ev) {
      var t = ev.target.closest("[data-rule-toggle]");
      if (t) toggleRule(t.dataset.ruleToggle, t.checked);
    });

    window.DefiAuth.subscribe(applyAuthState);
    window.DefiAuth.init().then(function () { applyAuthState(window.DefiAuth.snapshot()); });
  });
})();
