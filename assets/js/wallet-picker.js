/* ---------------------------------------------------------------------------
   Wallet bar / picker — drives the top-of-dashboard wallet UI.
   ---------------------------------------------------------------------------
   Reads/writes:
     - DefiAuth state (sign-in, link, unlink)
     - window.DefiState.wallet (legacy global used by every dashboard page)

   Markup expectations (rendered by _includes/dashboard/wallet-bar.html):
     #defi-wallet-status     — pill showing connection state
     #defi-connect-btn       — "Sign in" / "Connect" primary action
     #defi-scan-btn          — "Scan" button (handled by other JS)
     #defi-wallet-picker     — outer container of the dropdown
     #defi-wallet-picker-toggle — button that opens the dropdown
     #defi-wallet-picker-menu   — the dropdown itself
     #defi-wallet-picker-list   — <ul> populated with linked wallets
     #defi-wallet-picker-add    — "Add wallet" button inside the menu
     #defi-wallet-picker-signout — "Sign out" link inside the menu
     #defi-tier-pill            — chip showing Free/Pro/Plus
--------------------------------------------------------------------------- */
(function () {
  "use strict";

  function $(s, r) { return (r || document).querySelector(s); }
  function fmtAddr(a) { return a ? a.slice(0, 6) + "…" + a.slice(-4) : ""; }
  function tierLabel(t) { return t ? (t[0].toUpperCase() + t.slice(1)) : "Free"; }

  function toast(msg, kind) {
    var el = document.createElement("div");
    el.className = "defi-toast defi-toast--" + (kind || "ok");
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(function () { el.classList.add("is-show"); });
    setTimeout(function () {
      el.classList.remove("is-show");
      setTimeout(function () { el.remove(); }, 320);
    }, 4000);
  }

  function setLegacyWallet(addr) {
    if (!window.DefiState) return;
    var current = window.DefiState.wallet || "";
    var next = addr || "";
    if (current.toLowerCase() === next.toLowerCase()) return;
    if (typeof window.DefiState.setWallet === "function") {
      window.DefiState.setWallet(next || null);
    }
  }

  /* ---------- render ---------- */

  function render(s) {
    var status = $("#defi-wallet-status");
    var connect = $("#defi-connect-btn");
    var scan = $("#defi-scan-btn");
    var picker = $("#defi-wallet-picker");
    var toggle = $("#defi-wallet-picker-toggle");
    var list = $("#defi-wallet-picker-list");
    var tierPill = $("#defi-tier-pill");

    if (!s.isSignedIn) {
      if (status) {
        status.textContent = "Not signed in";
        status.className = "defi-wallet-status defi-wallet-status--disconnected";
      }
      if (connect) {
        connect.textContent = "Sign in";
        connect.disabled = false;
        connect.dataset.action = "signin";
      }
      if (scan) scan.disabled = true;
      if (picker) picker.style.display = "none";
      if (tierPill) tierPill.style.display = "none";
      setLegacyWallet("");
      return;
    }

    var primary = s.primaryWallet;
    var active = window.DefiState && window.DefiState.wallet ? window.DefiState.wallet.toLowerCase() : primary;
    if (!s.wallets.some(function (w) { return w.wallet_address === active; })) {
      active = primary;
    }
    setLegacyWallet(active);

    if (status) {
      status.textContent = fmtAddr(active);
      status.className = "defi-wallet-status defi-wallet-status--connected";
      status.title = active;
    }
    if (connect) {
      connect.textContent = "Switch";
      connect.disabled = false;
      connect.dataset.action = "toggle-picker";
    }
    if (scan) scan.disabled = false;

    if (tierPill) {
      tierPill.style.display = "inline-flex";
      tierPill.textContent = tierLabel(s.tier);
      tierPill.className = "defi-tier-pill defi-tier-pill--" + (s.tier || "free");
    }

    if (picker) picker.style.display = "";
    if (list) {
      list.innerHTML = s.wallets.map(function (w) {
        var isActive = w.wallet_address === active;
        var primaryFlag = w.is_primary ? '<span class="defi-wallet-flag">primary</span>' : "";
        var unlink = w.is_primary ? "" :
          '<button type="button" class="defi-wallet-item__unlink" data-unlink="' + w.wallet_address + '" title="Unlink">×</button>';
        return (
          '<li class="defi-wallet-item' + (isActive ? " is-active" : "") + '">' +
            '<button type="button" class="defi-wallet-item__pick" data-pick="' + w.wallet_address + '">' +
              '<span class="defi-wallet-item__addr">' + fmtAddr(w.wallet_address) + '</span>' +
              (w.label ? '<span class="defi-wallet-item__label">' + escapeHtml(w.label) + '</span>' : "") +
              primaryFlag +
            '</button>' +
            unlink +
          '</li>'
        );
      }).join("");
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }

  /* ---------- interactions ---------- */

  async function doSignIn() {
    var btn = $("#defi-connect-btn");
    if (!window.ethereum) {
      toast("Install MetaMask (or another EIP-1193 wallet) to sign in.", "warn");
      return;
    }
    btn.disabled = true; var orig = btn.textContent; btn.textContent = "Signing…";
    try {
      var addr = await window.DefiAuth.ensureMetamaskAccount();
      await window.DefiAuth.signIn(addr, window.DefiAuth.metamaskSign);
      toast("Signed in as " + fmtAddr(addr), "ok");
    } catch (e) {
      console.error(e);
      var msg = (e && e.message) || "Sign-in failed";
      toast("Sign-in failed: " + msg, "bad");
      btn.textContent = orig; btn.disabled = false;
    }
  }

  async function doAddWallet() {
    if (!window.ethereum) {
      toast("Open MetaMask, switch to the wallet you want to add, then click Add wallet again.", "warn");
      return;
    }
    var label = window.prompt("Optional label for this wallet (e.g. \"Cold storage\"):", "");
    try {
      var addr = await window.DefiAuth.ensureMetamaskAccount();
      var snap = window.DefiAuth.snapshot();
      if (snap.wallets.some(function (w) { return w.wallet_address === addr; })) {
        toast("That wallet is already linked.", "warn");
        return;
      }
      await window.DefiAuth.linkWallet(addr, window.DefiAuth.metamaskSign, label);
      toast("Linked " + fmtAddr(addr), "ok");
    } catch (e) {
      console.error(e);
      var detail = e && e.detail;
      if (detail && detail.error === "wallet_limit_reached") {
        toast("Wallet limit reached for the " + tierLabel(detail.current_tier) + " tier — upgrade for more.", "warn");
        setTimeout(function () { window.location.href = "/pricing/"; }, 1500);
        return;
      }
      toast("Couldn't link wallet: " + ((e && e.message) || "unknown"), "bad");
    }
  }

  async function doUnlink(addr) {
    if (!window.confirm("Unlink " + fmtAddr(addr) + "? You can re-link it later.")) return;
    try {
      await window.DefiAuth.unlinkWallet(addr);
      toast("Unlinked.", "ok");
    } catch (e) {
      toast("Couldn't unlink: " + ((e && e.message) || "unknown"), "bad");
    }
  }

  async function doSignOut() {
    try {
      await window.DefiAuth.signOut();
      toast("Signed out.", "ok");
    } catch (e) {
      toast("Sign-out failed: " + ((e && e.message) || "unknown"), "bad");
    }
  }

  function doPick(addr) {
    setLegacyWallet(addr);
    closePicker();
    render(window.DefiAuth.snapshot());
    // Trigger a full refresh of dependent widgets
    try { window.dispatchEvent(new CustomEvent("defi:wallet-picked", { detail: { wallet: addr } })); } catch (e) {}
  }

  function closePicker() {
    var menu = $("#defi-wallet-picker-menu");
    if (menu) menu.classList.remove("is-open");
    var toggle = $("#defi-wallet-picker-toggle");
    if (toggle) toggle.setAttribute("aria-expanded", "false");
  }
  function togglePicker() {
    var menu = $("#defi-wallet-picker-menu");
    if (!menu) return;
    var open = menu.classList.toggle("is-open");
    var toggle = $("#defi-wallet-picker-toggle");
    if (toggle) toggle.setAttribute("aria-expanded", open ? "true" : "false");
  }

  /* ---------- wire up ---------- */

  document.addEventListener("click", function (ev) {
    var t = ev.target;
    if (t.closest("#defi-connect-btn")) {
      var btn = t.closest("#defi-connect-btn");
      var action = btn.dataset.action || "signin";
      if (action === "signin") doSignIn();
      else if (action === "toggle-picker") togglePicker();
      return;
    }
    if (t.closest("#defi-wallet-picker-toggle")) { togglePicker(); return; }
    if (t.closest("#defi-wallet-picker-add")) { closePicker(); doAddWallet(); return; }
    if (t.closest("#defi-wallet-picker-signout")) { closePicker(); doSignOut(); return; }
    var pick = t.closest("[data-pick]");
    if (pick) { doPick(pick.dataset.pick); return; }
    var unlink = t.closest("[data-unlink]");
    if (unlink) { ev.preventDefault(); doUnlink(unlink.dataset.unlink); return; }
    // Click outside the picker closes it
    if (!t.closest("#defi-wallet-picker")) closePicker();
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closePicker();
  });

  if (window.DefiAuth) {
    window.DefiAuth.subscribe(render);
    window.DefiAuth.init().then(function () {
      render(window.DefiAuth.snapshot());
    });
  }
})();
