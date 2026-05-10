/* DeFiScoring – Admin SPA (vanilla JS, no build step)
 *
 * Reads SIWE session via the existing /api/auth/me cookie flow. If the
 * caller's user.is_admin !== 1 we render a lockout card and stop. Every
 * mutation goes through the /api/admin/* endpoints; this file is purely
 * a thin presentation layer over them.
 */
(function () {
  "use strict";

  // -- minimal helpers -----------------------------------------------------
  const $  = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function fmtTs(ms) {
    if (!ms) return "—";
    const d = new Date(Number(ms));
    if (isNaN(d.getTime())) return "—";
    return d.toISOString().replace("T", " ").slice(0, 16) + "Z";
  }

  function shortAddr(addr) {
    if (!addr) return "—";
    const s = String(addr);
    return s.length > 14 ? s.slice(0, 6) + "…" + s.slice(-4) : s;
  }

  function pill(klass, label) {
    return `<span class="pill pill--${escapeHtml(klass)}">${escapeHtml(label)}</span>`;
  }

  function toast(message, isError) {
    const el = $("#admin-toast");
    el.textContent = message;
    el.classList.toggle("is-error", !!isError);
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 3500);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      credentials: "include",
      headers: opts.body ? { "content-type": "application/json" } : {},
      ...opts,
    });
    let body;
    try { body = await res.json(); } catch { body = { success: false, error: "bad_response" }; }
    if (!res.ok || body.success === false) {
      const msg = (body && (body.error || body.detail)) || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  // -- session bootstrap ---------------------------------------------------
  async function bootstrap() {
    let me;
    try { me = await api("/api/auth/me"); }
    catch (e) {
      showGate("Sign in required",
        "Open the dashboard, connect your wallet, then come back here.",
        "Go to dashboard to sign in", "/dashboard/");
      return;
    }
    if (!me.user || me.user.is_admin !== 1) {
      showGate("Admin access only",
        "This area is restricted to operators of DeFi Scoring. " +
        "If you believe this is a mistake, contact support.",
        "Back to dashboard", "/dashboard/");
      return;
    }
    renderMe(me.user);
    wireTabs();
    wireFilters();
    // Initial load: users tab
    loadUsers();
  }

  function showGate(title, msg, ctaText, ctaHref) {
    $$(".ds-admin__panel").forEach((p) => p.classList.remove("is-active"));
    $("#admin-tabs").style.visibility = "hidden";
    $("#admin-me").innerHTML = `<span class="ds-admin__me-label">Not signed in</span>`;
    const gate = $("#admin-gate");
    $("#admin-gate-title").textContent = title;
    $("#admin-gate-msg").textContent   = msg;
    const cta = $("#admin-gate-cta");
    cta.textContent = ctaText;
    cta.href = ctaHref;
    gate.hidden = false;
  }

  function renderMe(user) {
    $("#admin-me").innerHTML =
      `<strong>${escapeHtml(shortAddr(user.primary_wallet))}</strong>` +
      `<span>admin · ${escapeHtml(user.email || "no email")}</span>`;
  }

  // -- tab switching -------------------------------------------------------
  function wireTabs() {
    $("#admin-tabs").addEventListener("click", (e) => {
      const btn = e.target.closest(".ds-admin__tab");
      if (!btn) return;
      const tab = btn.dataset.tab;
      $$(".ds-admin__tab").forEach((b) => b.classList.toggle("is-active", b === btn));
      $$(".ds-admin__panel").forEach((p) =>
        p.classList.toggle("is-active", p.dataset.panel === tab));
      const loader = TAB_LOADERS[tab];
      if (loader) loader();
    });
  }

  function wireFilters() {
    $("#users-refresh").addEventListener("click", loadUsers);
    $("#users-q").addEventListener("input", debounce(loadUsers, 300));
    $("#subs-refresh").addEventListener("click", loadSubs);
    $("#subs-tier").addEventListener("change", loadSubs);
    $("#subs-status").addEventListener("change", loadSubs);
    $("#alerts-refresh").addEventListener("click", loadAlerts);
    $("#alerts-status").addEventListener("change", loadAlerts);
    $("#leads-refresh").addEventListener("click", loadLeads);
    $("#leads-q").addEventListener("input", debounce(loadLeads, 300));
    $("#leads-opted").addEventListener("change", loadLeads);
    $("#audit-refresh").addEventListener("click", loadAudit);
    $("#audit-action").addEventListener("input", debounce(loadAudit, 300));
    $("#audit-target").addEventListener("input", debounce(loadAudit, 300));
    $("#retention-run").addEventListener("click", runRetention);
    // Modal close
    $("#admin-modal").addEventListener("click", (e) => {
      if (e.target.matches("[data-close]")) closeModal();
    });
  }

  function debounce(fn, ms) {
    let t;
    return function () {
      const args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(ctx, args), ms);
    };
  }

  // -- panel: users --------------------------------------------------------
  async function loadUsers() {
    const q = $("#users-q").value.trim();
    const tbody = $("#users-table tbody");
    tbody.innerHTML = `<tr><td colspan="9" style="color:var(--ds-muted)">Loading…</td></tr>`;
    let body;
    try { body = await api(`/api/admin/users?limit=100${q ? `&q=${encodeURIComponent(q)}` : ""}`); }
    catch (e) { tbody.innerHTML = `<tr><td colspan="9" style="color:var(--ds-red)">${escapeHtml(e.message)}</td></tr>`; return; }
    const rows = body.users || [];
    if (!rows.length) { tbody.innerHTML = `<tr><td colspan="9" style="color:var(--ds-muted)">No users.</td></tr>`; return; }
    tbody.innerHTML = rows.map((u) => `
      <tr data-user-id="${escapeHtml(u.id)}">
        <td class="mono" title="${escapeHtml(u.primary_wallet)}">${escapeHtml(shortAddr(u.primary_wallet))}</td>
        <td>${escapeHtml(u.email || "—")}</td>
        <td>${pill(u.tier || "free", u.tier || "free")}</td>
        <td>${pill(u.sub_status || "—", u.sub_status || "—")}</td>
        <td>${escapeHtml(fmtTs(u.last_login_at))}</td>
        <td>${escapeHtml(fmtTs(u.created_at))}</td>
        <td>${u.is_admin ? "✓" : ""}</td>
        <td>${u.suspended_at ? `<span style="color:var(--ds-red)">suspended</span>` : ""}</td>
        <td><button class="ds-admin__btn" data-act="user-detail">Open</button></td>
      </tr>
    `).join("");
    tbody.addEventListener("click", onUserRowClick, { once: true });
  }

  async function onUserRowClick(e) {
    const tbody = $("#users-table tbody");
    // Re-attach delegated handler since we used { once: true } to refresh
    tbody.addEventListener("click", onUserRowClick, { once: true });
    const btn = e.target.closest("[data-act='user-detail']");
    if (!btn) return;
    const tr = e.target.closest("tr[data-user-id]");
    if (!tr) return;
    const userId = tr.dataset.userId;
    let detail;
    try { detail = await api(`/api/admin/users/${encodeURIComponent(userId)}`); }
    catch (err) { return toast(err.message, true); }
    showUserDetail(detail);
  }

  function showUserDetail(detail) {
    const u = detail.user, sub = detail.subscription;
    const wallets = (detail.wallets || []).map((w) =>
      `<li><code>${escapeHtml(w.wallet_address)}</code>${w.is_primary ? " (primary)" : ""}${w.label ? " · " + escapeHtml(w.label) : ""}</li>`
    ).join("");
    const notes = (detail.notes || []).map((n) =>
      `<div style="margin-bottom:10px;border-left:2px solid var(--ds-border);padding-left:10px">
        <div style="color:var(--ds-muted);font-size:11px">${escapeHtml(fmtTs(n.created_at))} · by ${escapeHtml(shortAddr(n.author_id))}</div>
        <div>${escapeHtml(n.body)}</div>
       </div>`
    ).join("") || `<div style="color:var(--ds-muted)">No notes yet.</div>`;
    openModal(`User · ${shortAddr(u.primary_wallet)}`, `
      <dl>
        <dt>User id</dt><dd class="mono">${escapeHtml(u.id)}</dd>
        <dt>Wallet</dt><dd class="mono">${escapeHtml(u.primary_wallet)}</dd>
        <dt>Email</dt><dd>${escapeHtml(u.email || "—")}</dd>
        <dt>Tier</dt><dd>${pill(sub?.tier || "free", sub?.tier || "free")}</dd>
        <dt>Status</dt><dd>${pill(sub?.status || "—", sub?.status || "—")}</dd>
        <dt>Created</dt><dd>${escapeHtml(fmtTs(u.created_at))}</dd>
        <dt>Last login</dt><dd>${escapeHtml(fmtTs(u.last_login_at))}</dd>
        <dt>Active sessions</dt><dd>${escapeHtml(String(detail.active_sessions || 0))}</dd>
        <dt>Suspended</dt><dd>${u.suspended_at ? "Yes (" + escapeHtml(fmtTs(u.suspended_at)) + ")" : "No"}</dd>
        <dt>Admin</dt><dd>${u.is_admin ? "Yes" : "No"}</dd>
      </dl>
      <h4 style="margin:18px 0 8px">Wallets</h4>
      <ul style="font-size:12px;padding-left:18px;margin:0 0 14px">${wallets || "<li>—</li>"}</ul>
      <h4 style="margin:18px 0 8px">Add note</h4>
      <textarea id="user-note" placeholder="Internal note (max 4000 chars)…"></textarea>
      <h4 style="margin:0 0 8px">Notes</h4>
      ${notes}
      <div class="row">
        <button class="ds-admin__btn" data-close>Close</button>
        ${u.suspended_at
          ? `<button class="ds-admin__btn" id="user-unsuspend">Unsuspend</button>`
          : `<button class="ds-admin__btn ds-admin__btn--danger" id="user-suspend">Suspend</button>`}
        ${u.is_admin
          ? `<button class="ds-admin__btn" id="user-demote">Revoke admin</button>`
          : `<button class="ds-admin__btn" id="user-promote">Promote to admin</button>`}
        <button class="ds-admin__btn ds-admin__btn--primary" id="user-save">Save note</button>
      </div>
    `);
    const wrap = $("#admin-modal");
    const noteEl = wrap.querySelector("#user-note");

    async function patch(updates, label) {
      try {
        const note = (noteEl.value || "").trim();
        await api(`/api/admin/users/${encodeURIComponent(u.id)}`, {
          method: "PATCH",
          body: JSON.stringify(note ? { ...updates, note } : updates),
        });
        toast(label + " saved");
        closeModal();
        loadUsers();
      } catch (err) { toast(err.message, true); }
    }
    wrap.querySelector("#user-suspend")?.addEventListener("click", () => patch({ suspended: true }, "Suspension"));
    wrap.querySelector("#user-unsuspend")?.addEventListener("click", () => patch({ suspended: false }, "Reactivation"));
    wrap.querySelector("#user-promote")?.addEventListener("click", () => patch({ is_admin: true }, "Admin grant"));
    wrap.querySelector("#user-demote")?.addEventListener("click", () => patch({ is_admin: false }, "Admin revoke"));
    wrap.querySelector("#user-save")?.addEventListener("click", () => {
      const note = (noteEl.value || "").trim();
      if (!note) return toast("Enter a note first", true);
      patch({}, "Note");
    });
  }

  // -- panel: subscriptions ------------------------------------------------
  async function loadSubs() {
    const tier   = $("#subs-tier").value;
    const status = $("#subs-status").value;
    const tbody  = $("#subs-table tbody");
    tbody.innerHTML = `<tr><td colspan="8" style="color:var(--ds-muted)">Loading…</td></tr>`;
    const qs = new URLSearchParams({ limit: "100" });
    if (tier)   qs.set("tier", tier);
    if (status) qs.set("status", status);
    let body;
    try { body = await api(`/api/admin/subscriptions?${qs.toString()}`); }
    catch (e) { tbody.innerHTML = `<tr><td colspan="8" style="color:var(--ds-red)">${escapeHtml(e.message)}</td></tr>`; return; }
    const rows = body.subscriptions || [];
    if (!rows.length) { tbody.innerHTML = `<tr><td colspan="8" style="color:var(--ds-muted)">No subscriptions match.</td></tr>`; return; }
    tbody.innerHTML = rows.map((s) => `
      <tr data-user-id="${escapeHtml(s.user_id)}">
        <td class="mono" title="${escapeHtml(s.primary_wallet || "")}">${escapeHtml(shortAddr(s.primary_wallet))}</td>
        <td>${escapeHtml(s.email || "—")}</td>
        <td>${pill(s.tier || "free", s.tier || "free")}</td>
        <td>${pill(s.status || "—", s.status || "—")}</td>
        <td>${escapeHtml(fmtTs(s.current_period_end))}</td>
        <td>${s.cancel_at_period_end ? "yes" : "no"}</td>
        <td class="mono">${escapeHtml(s.stripe_subscription_id || "—")}</td>
        <td><button class="ds-admin__btn" data-act="sub-actions">Manage</button></td>
      </tr>
    `).join("");
    tbody.addEventListener("click", onSubRowClick, { once: true });
  }

  function onSubRowClick(e) {
    $("#subs-table tbody").addEventListener("click", onSubRowClick, { once: true });
    const btn = e.target.closest("[data-act='sub-actions']");
    if (!btn) return;
    const tr = e.target.closest("tr[data-user-id]");
    if (!tr) return;
    const userId = tr.dataset.userId;
    openModal("Subscription actions", `
      <dl>
        <dt>User id</dt><dd class="mono">${escapeHtml(userId)}</dd>
      </dl>
      <label>Override tier (manual)</label>
      <select id="sub-tier">
        <option value="">— no change —</option>
        <option value="free">free</option>
        <option value="pro">pro</option>
        <option value="plus">plus</option>
        <option value="enterprise">enterprise</option>
      </select>
      <label>Refund amount (in cents, leave blank for full)</label>
      <input id="sub-refund-amount" type="number" min="1" placeholder="e.g. 1500">
      <div class="row">
        <button class="ds-admin__btn" data-close>Cancel</button>
        <button class="ds-admin__btn" id="sub-cancel-end">Cancel @ period end</button>
        <button class="ds-admin__btn ds-admin__btn--danger" id="sub-cancel-now">Cancel immediately</button>
        <button class="ds-admin__btn" id="sub-refund">Refund last charge</button>
        <button class="ds-admin__btn ds-admin__btn--primary" id="sub-tier-save">Apply tier override</button>
      </div>
    `);
    const wrap = $("#admin-modal");
    async function call(method, path, body, label) {
      try {
        await api(path, { method, body: body ? JSON.stringify(body) : undefined });
        toast(label + " applied");
        closeModal();
        loadSubs();
      } catch (err) { toast(err.message, true); }
    }
    wrap.querySelector("#sub-cancel-end").addEventListener("click", () =>
      call("POST", `/api/admin/subscriptions/${encodeURIComponent(userId)}/cancel`, { atPeriodEnd: true }, "Period-end cancel"));
    wrap.querySelector("#sub-cancel-now").addEventListener("click", () => {
      if (!confirm("Cancel this subscription IMMEDIATELY (no refund)?")) return;
      call("POST", `/api/admin/subscriptions/${encodeURIComponent(userId)}/cancel`, { atPeriodEnd: false }, "Immediate cancel");
    });
    wrap.querySelector("#sub-refund").addEventListener("click", () => {
      const v = wrap.querySelector("#sub-refund-amount").value.trim();
      const amountCents = v ? parseInt(v, 10) : null;
      if (!confirm(amountCents ? `Refund ${amountCents}¢?` : "Refund the most recent charge in FULL?")) return;
      call("POST", `/api/admin/subscriptions/${encodeURIComponent(userId)}/refund`,
        amountCents ? { amountCents } : {}, "Refund");
    });
    wrap.querySelector("#sub-tier-save").addEventListener("click", () => {
      const t = wrap.querySelector("#sub-tier").value;
      if (!t) return toast("Pick a tier first", true);
      call("PATCH", `/api/admin/subscriptions/${encodeURIComponent(userId)}`, { tier: t }, "Tier override");
    });
  }

  // -- panel: alerts -------------------------------------------------------
  async function loadAlerts() {
    const status = $("#alerts-status").value;
    const tbody  = $("#alerts-table tbody");
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--ds-muted)">Loading…</td></tr>`;
    const qs = new URLSearchParams({ limit: "100" });
    if (status) qs.set("status", status);
    let body;
    try { body = await api(`/api/admin/alerts/deliveries?${qs.toString()}`); }
    catch (e) { tbody.innerHTML = `<tr><td colspan="7" style="color:var(--ds-red)">${escapeHtml(e.message)}</td></tr>`; return; }
    const rows = body.deliveries || [];
    if (!rows.length) { tbody.innerHTML = `<tr><td colspan="7" style="color:var(--ds-muted)">No deliveries yet.</td></tr>`; return; }
    tbody.innerHTML = rows.map((d) => `
      <tr data-id="${escapeHtml(d.id)}">
        <td>${escapeHtml(fmtTs(d.fired_at))}</td>
        <td class="mono">${escapeHtml(shortAddr(d.primary_wallet))}</td>
        <td>${escapeHtml(d.channel_kind || "—")}</td>
        <td>${escapeHtml(d.destination || "—")}</td>
        <td>${pill(d.status, d.status)}</td>
        <td style="color:var(--ds-muted);font-size:12px">${escapeHtml(d.error_message || "")}</td>
        <td><button class="ds-admin__btn" data-act="replay">Replay</button></td>
      </tr>
    `).join("");
    tbody.addEventListener("click", onAlertRowClick, { once: true });
  }

  async function onAlertRowClick(e) {
    $("#alerts-table tbody").addEventListener("click", onAlertRowClick, { once: true });
    const btn = e.target.closest("[data-act='replay']");
    if (!btn) return;
    const tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    if (!confirm("Re-send this delivery now?")) return;
    btn.disabled = true; btn.textContent = "Sending…";
    try {
      const r = await api(`/api/admin/alerts/deliveries/${encodeURIComponent(tr.dataset.id)}/replay`,
        { method: "POST" });
      toast(r.success ? "Replayed (sent)" : "Replay attempted: " + (r.error || "failed"), !r.success);
      loadAlerts();
    } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = "Replay"; }
  }

  // -- panel: leads --------------------------------------------------------
  async function loadLeads() {
    const q = $("#leads-q").value.trim();
    const opted = $("#leads-opted").value;
    const tbody = $("#leads-table tbody");
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--ds-muted)">Loading…</td></tr>`;
    const qs = new URLSearchParams({ limit: "100" });
    if (q) qs.set("q", q);
    if (opted) qs.set("optedOut", opted);
    let body;
    try { body = await api(`/api/admin/leads?${qs.toString()}`); }
    catch (e) { tbody.innerHTML = `<tr><td colspan="7" style="color:var(--ds-red)">${escapeHtml(e.message)}</td></tr>`; return; }
    const rows = body.leads || [];
    if (!rows.length) { tbody.innerHTML = `<tr><td colspan="7" style="color:var(--ds-muted)">No leads match.</td></tr>`; return; }
    tbody.innerHTML = rows.map((l) => `
      <tr data-email="${escapeHtml(l.email)}">
        <td>${escapeHtml(l.email)}</td>
        <td>${escapeHtml(l.source || "")}</td>
        <td>${escapeHtml(fmtTs(l.last_seen_at))}</td>
        <td>${escapeHtml(String(l.sessions_count || 0))}</td>
        <td>${escapeHtml(l.last_risk_profile || "—")}</td>
        <td>${l.marketing_opt_out ? pill("canceled", "opted out") : pill("active", "subscribed")}</td>
        <td>
          <button class="ds-admin__btn" data-act="${l.marketing_opt_out ? "lead-resubscribe" : "lead-optout"}">
            ${l.marketing_opt_out ? "Re-subscribe" : "Opt out"}
          </button>
          <button class="ds-admin__btn ds-admin__btn--danger" data-act="lead-delete">Delete</button>
        </td>
      </tr>
    `).join("");
    tbody.addEventListener("click", onLeadRowClick, { once: true });
  }

  async function onLeadRowClick(e) {
    $("#leads-table tbody").addEventListener("click", onLeadRowClick, { once: true });
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const tr = e.target.closest("tr[data-email]");
    if (!tr) return;
    const email = tr.dataset.email;
    const act = btn.dataset.act;
    try {
      if (act === "lead-delete") {
        if (!confirm(`Permanently delete lead ${email}? This is a DSAR-style erase.`)) return;
        await api(`/api/admin/leads/${encodeURIComponent(email)}`, { method: "DELETE" });
        toast("Lead deleted");
      } else {
        const optOut = act === "lead-optout";
        await api(`/api/admin/leads/${encodeURIComponent(email)}`, {
          method: "PATCH", body: JSON.stringify({ optOut }),
        });
        toast(optOut ? "Opted out" : "Re-subscribed");
      }
      loadLeads();
    } catch (err) { toast(err.message, true); }
  }

  // -- panel: retention ----------------------------------------------------
  async function runRetention() {
    if (!confirm("Run retention prune now? Deletes intel_events + health_scores beyond the retention window.")) return;
    const btn = $("#retention-run");
    const out = $("#retention-output");
    btn.disabled = true; btn.textContent = "Running…";
    try {
      const r = await api("/api/admin/retention/run", { method: "POST" });
      out.hidden = false;
      out.textContent = JSON.stringify(r.summary, null, 2);
      toast(r.success ? "Prune complete" : "Prune reported errors (see output)", !r.success);
    } catch (err) {
      out.hidden = false;
      out.textContent = "Error: " + err.message;
      toast(err.message, true);
    } finally {
      btn.disabled = false; btn.textContent = "Run prune now";
    }
  }

  // -- panel: audit --------------------------------------------------------
  async function loadAudit() {
    const action = $("#audit-action").value.trim();
    const target = $("#audit-target").value.trim();
    const tbody  = $("#audit-table tbody");
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--ds-muted)">Loading…</td></tr>`;
    const qs = new URLSearchParams({ limit: "100" });
    if (action) qs.set("action", action);
    if (target) qs.set("target", target);
    let body;
    try { body = await api(`/api/admin/audit?${qs.toString()}`); }
    catch (e) { tbody.innerHTML = `<tr><td colspan="6" style="color:var(--ds-red)">${escapeHtml(e.message)}</td></tr>`; return; }
    const rows = body.entries || [];
    if (!rows.length) { tbody.innerHTML = `<tr><td colspan="6" style="color:var(--ds-muted)">No audit entries match.</td></tr>`; return; }
    tbody.innerHTML = rows.map((r) => `
      <tr>
        <td>${escapeHtml(fmtTs(r.created_at))}</td>
        <td class="mono" title="${escapeHtml(r.actor_id)}">${escapeHtml(shortAddr(r.actor_wallet))}</td>
        <td>${escapeHtml(r.action)}</td>
        <td class="mono">${escapeHtml(r.target_type || "")}<br><small>${escapeHtml(r.target_id || "")}</small></td>
        <td><pre style="margin:0;font-size:11px;max-width:280px;white-space:pre-wrap;color:var(--ds-muted)">${escapeHtml(r.before_json || "")}</pre></td>
        <td><pre style="margin:0;font-size:11px;max-width:280px;white-space:pre-wrap">${escapeHtml(r.after_json || "")}</pre></td>
      </tr>
    `).join("");
  }

  // -- modal helpers -------------------------------------------------------
  function openModal(title, html) {
    $("#modal-title").textContent = title;
    $("#modal-body").innerHTML = html;
    $("#admin-modal").hidden = false;
  }
  function closeModal() {
    $("#admin-modal").hidden = true;
    $("#modal-body").innerHTML = "";
  }

  const TAB_LOADERS = {
    users: loadUsers,
    subscriptions: loadSubs,
    alerts: loadAlerts,
    leads: loadLeads,
    retention: () => {},
    audit: loadAudit,
  };

  // -- go ------------------------------------------------------------------
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();
