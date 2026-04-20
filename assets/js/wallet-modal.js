/* DeFi Scoring – wallet-modal.js
 *
 * Vanilla-JS wallet picker modal with the same UX as RainbowKit / Privy:
 *   • Lists every EIP-6963 wallet currently injected, with name + icon.
 *   • Highlights the most-recently-used one.
 *   • Falls back to legacy window.ethereum when no EIP-6963 wallets exist.
 *   • Shows an "install MetaMask" CTA when no wallets are detected.
 *
 * Public API:
 *   DefiWalletModal.open()  -> Promise<address|null>
 *   DefiWalletModal.close() -> void
 *
 * Depends on window.DefiWallet (wallet-connect.js) for discovery + connect.
 */
(function () {
  if (window.DefiWalletModal) return;

  const STYLE_ID = "defi-walletmodal-style";
  const PROVIDER_KEY = "defi.wallet.providerRdns";
  const CSS = `
    .defi-wm__overlay{position:fixed;inset:0;background:rgba(7,11,28,.72);backdrop-filter:blur(4px);z-index:9998;display:none;align-items:center;justify-content:center;padding:20px;animation:defi-wm-fade .15s ease-out}
    .defi-wm__overlay--open{display:flex}
    .defi-wm__panel{background:var(--defi-card-bg,#0f172aee);border:1px solid var(--defi-border,rgba(148,163,184,.25));border-radius:16px;width:100%;max-width:420px;max-height:85vh;overflow:auto;color:var(--defi-text,#e6ebff);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.5)}
    .defi-wm__head{display:flex;justify-content:space-between;align-items:center;padding:18px 20px;border-bottom:1px solid rgba(148,163,184,.15)}
    .defi-wm__title{margin:0;font-size:16px;font-weight:700}
    .defi-wm__close{background:none;border:none;color:var(--defi-text-dim,#94a3b8);font-size:22px;line-height:1;cursor:pointer;padding:4px 8px;border-radius:6px}
    .defi-wm__close:hover{background:rgba(148,163,184,.12);color:#fff}
    .defi-wm__body{padding:14px 16px 18px}
    .defi-wm__list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
    .defi-wm__btn{display:flex;align-items:center;gap:12px;width:100%;padding:12px 14px;background:rgba(148,163,184,.06);border:1px solid rgba(148,163,184,.18);border-radius:10px;color:var(--defi-text,#e6ebff);font-size:14px;font-weight:600;cursor:pointer;text-align:left;transition:background .12s,border-color .12s}
    .defi-wm__btn:hover{background:rgba(91,140,255,.12);border-color:var(--defi-accent,#5b8cff)}
    .defi-wm__btn:disabled{opacity:.5;cursor:wait}
    .defi-wm__icon{width:32px;height:32px;border-radius:8px;flex-shrink:0;background:rgba(148,163,184,.15);object-fit:contain}
    .defi-wm__name{flex:1}
    .defi-wm__pill{font-size:10px;font-weight:600;color:var(--defi-accent,#5b8cff);background:rgba(91,140,255,.12);padding:2px 8px;border-radius:999px}
    .defi-wm__empty{padding:24px 8px;text-align:center;color:var(--defi-text-dim,#94a3b8);font-size:13px;line-height:1.6}
    .defi-wm__empty a{color:var(--defi-accent,#5b8cff);text-decoration:none;font-weight:600}
    .defi-wm__empty a:hover{text-decoration:underline}
    .defi-wm__footer{margin-top:12px;font-size:11px;color:var(--defi-text-dim,#94a3b8);text-align:center;line-height:1.5}
    .defi-wm__error{margin-top:10px;font-size:12px;color:#fca5a5;text-align:center}
    @keyframes defi-wm-fade{from{opacity:0}to{opacity:1}}
  `;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style"); s.id = STYLE_ID; s.textContent = CSS;
    document.head.appendChild(s);
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }

  let overlay, body, errSlot, resolveOpen;

  function ensureDom() {
    if (overlay) return;
    injectStyle();
    overlay = document.createElement("div");
    overlay.className = "defi-wm__overlay";
    overlay.innerHTML = `
      <div class="defi-wm__panel" role="dialog" aria-modal="true" aria-label="Connect a wallet">
        <div class="defi-wm__head">
          <h3 class="defi-wm__title">Connect a wallet</h3>
          <button class="defi-wm__close" type="button" aria-label="Close">×</button>
        </div>
        <div class="defi-wm__body">
          <ul class="defi-wm__list" id="defi-wm-list"></ul>
          <div class="defi-wm__error" id="defi-wm-err"></div>
          <div class="defi-wm__footer">By connecting, you confirm that you have read and agree to the project terms. Your address never leaves your browser unless you explicitly run a scan.</div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    body = overlay.querySelector("#defi-wm-list");
    errSlot = overlay.querySelector("#defi-wm-err");
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
    overlay.querySelector(".defi-wm__close").addEventListener("click", () => close(null));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && overlay.classList.contains("defi-wm__overlay--open")) close(null);
    });
  }

  function renderList() {
    const W = window.DefiWallet;
    const providers = (W && W.providers) ? W.providers : [];
    const remembered = localStorage.getItem(PROVIDER_KEY);
    body.innerHTML = "";
    errSlot.textContent = "";

    if (providers.length === 0 && !window.ethereum) {
      body.innerHTML = `
        <div class="defi-wm__empty">
          <div style="font-size:36px;margin-bottom:8px">🦊</div>
          <div>No EVM wallet detected in this browser.</div>
          <div style="margin-top:10px">Install one to continue:</div>
          <div style="margin-top:8px">
            <a href="https://metamask.io/download/" target="_blank" rel="noopener">MetaMask</a> ·
            <a href="https://rabby.io/" target="_blank" rel="noopener">Rabby</a> ·
            <a href="https://www.coinbase.com/wallet" target="_blank" rel="noopener">Coinbase Wallet</a>
          </div>
        </div>`;
      return;
    }

    const priority = ["io.metamask", "io.rabby", "com.coinbase.wallet", "app.phantom", "io.zerion.wallet"];
    const sorted = [...providers].sort((a, b) => {
      if (a.info.rdns === remembered) return -1;
      if (b.info.rdns === remembered) return 1;
      const ai = priority.indexOf(a.info.rdns);
      const bi = priority.indexOf(b.info.rdns);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    if (sorted.length === 0 && window.ethereum) {
      // Legacy injected wallet that didn't announce via EIP-6963
      const li = document.createElement("li");
      li.innerHTML = `
        <button class="defi-wm__btn" type="button">
          <div class="defi-wm__icon" style="display:flex;align-items:center;justify-content:center">🌐</div>
          <span class="defi-wm__name">Browser wallet</span>
        </button>`;
      li.querySelector("button").addEventListener("click", async () => {
        await connectAndClose(null);
      });
      body.appendChild(li);
      return;
    }

    sorted.forEach((p) => {
      const li = document.createElement("li");
      const isRemembered = p.info.rdns === remembered;
      const iconHtml = p.info.icon
        ? `<img class="defi-wm__icon" src="${esc(p.info.icon)}" alt="">`
        : `<div class="defi-wm__icon" style="display:flex;align-items:center;justify-content:center">🌐</div>`;
      li.innerHTML = `
        <button class="defi-wm__btn" type="button">
          ${iconHtml}
          <span class="defi-wm__name">${esc(p.info.name || "Wallet")}</span>
          ${isRemembered ? '<span class="defi-wm__pill">Last used</span>' : ''}
        </button>`;
      li.querySelector("button").addEventListener("click", async () => {
        await connectAndClose(p);
      });
      body.appendChild(li);
    });
  }

  async function connectAndClose(picked) {
    const buttons = body.querySelectorAll("button");
    buttons.forEach((b) => { b.disabled = true; });
    errSlot.textContent = "";
    try {
      let addr;
      if (picked) {
        localStorage.setItem(PROVIDER_KEY, picked.info.rdns);
        addr = await window.DefiWallet.connectWith(picked.provider);
      } else {
        addr = await window.DefiWallet.connectWith(window.ethereum);
      }
      if (!addr) {
        errSlot.textContent = "Connection cancelled or rejected.";
        buttons.forEach((b) => { b.disabled = false; });
        return;
      }
      close(addr);
    } catch (e) {
      console.warn("[wallet-modal] connect failed:", e);
      errSlot.textContent = "Connect failed: " + (e && e.message ? e.message : String(e));
      buttons.forEach((b) => { b.disabled = false; });
    }
  }

  function open() {
    ensureDom();
    // Re-poll EIP-6963 in case wallets injected after page load.
    try { window.dispatchEvent(new Event("eip6963:requestProvider")); } catch (_) {}
    return new Promise((resolve) => {
      resolveOpen = resolve;
      setTimeout(() => {
        renderList();
        overlay.classList.add("defi-wm__overlay--open");
      }, 60); // give late providers a moment to announce
    });
  }

  function close(addr) {
    if (!overlay) return;
    overlay.classList.remove("defi-wm__overlay--open");
    if (resolveOpen) { const r = resolveOpen; resolveOpen = null; r(addr); }
  }

  window.DefiWalletModal = { open, close };
})();
