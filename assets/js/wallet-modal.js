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

  // Curated wallets always shown to the user. Detected providers (via EIP-6963)
  // get matched by rdns and become directly clickable. Undetected ones link to
  // the wallet's official install page.
  const RECOMMENDED = [
    {
      rdns: "io.metamask",
      name: "MetaMask",
      install: "https://metamask.io/download/",
      icon: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="%23E17726" d="M28.6 3 17.5 11.3l2-4.9z"/><path fill="%23E27625" d="m3.4 3 11 8.4-1.9-5zM24.4 22.3l-3 4.6 6.4 1.8 1.8-6.3zm-22 0L4.2 28.7l6.4-1.8-3-4.6z"/><path fill="%23E27625" d="M10.3 14.6 8.6 17l6.3.3-.2-6.8zm11.4 0-4.5-4.2-.1 6.9 6.3-.3zM10.6 26.9l3.8-1.9-3.3-2.6zm6.9-1.9 3.8 1.9-.5-4.5z"/><path fill="%23D5BFB2" d="m21.3 26.9-3.8-1.9.3 2.5v1.1zm-10.7 0 3.5 1.7v-1.1l.3-2.5z"/><path fill="%23233447" d="m14.2 21.1-3.2-.9 2.3-1zm3.6 0 1-2 2.3 1z"/><path fill="%23CC6228" d="m10.6 26.9.6-4.6-3.6.1zm10.2-4.6.5 4.6 3-4.5zm3-7.4-6.3.3.6 3.3 1-2 2.3 1zM11 19.7l2.3-1 1 2 .6-3.3-6.3-.3z"/><path fill="%23E27525" d="m8.6 17 2.6 5.2-.1-2.5zm12.7 2.7-.1 2.5 2.6-5.2zm-6.4-2.4-.6 3.3.7 4 .2-5.2zm2.2 0-.4 2 .2 5.2.7-4z"/><path fill="%23F5841F" d="m17.8 21.1-.7 4 .5.4 3.3-2.6.1-2.5zm-6.8-.7.1 2.5 3.3 2.6.5-.4-.7-4z"/><path fill="%23C0AC9D" d="m17.9 28.6-.1-1.1-.3-.3h-3.1l-.3.3v1.1l-3.5-1.7 1.2 1 2.5 1.7h3.4l2.5-1.7 1.2-1z"/><path fill="%23161616" d="m17.5 25.1-.5-.4h-2l-.5.4-.3 2.5.3-.3h3.1l.3.3z"/><path fill="%23763E1A" d="M29.1 11.8 30 7.5 28.6 3l-11 8.1 4.2 3.6 6 1.8 1.4-1.5-.6-.4 1-.9-.7-.6 1-.7zM2 7.5l1 4.3-.6.5 1 .7-.7.6 1 .9-.6.4 1.4 1.5 6-1.8 4.2-3.6L4.4 3z"/><path fill="%23F5841F" d="m28.4 16.5-6-1.8 1.8 2.7-2.7 5.2 3.6-.1h5.4zm-17.4-1.8-6 1.8-2 6h5.4l3.6.1-2.7-5.2zM15 17.3l.4-6.6 1.7-4.7h-7.6l1.7 4.7.4 6.6.1 2.1v5.2h2v-5.2z"/></svg>'
    },
    {
      rdns: "com.coinbase.wallet",
      name: "Coinbase Wallet",
      install: "https://www.coinbase.com/wallet",
      icon: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="%230052FF"/><path fill="%23fff" d="M16 6.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19Zm-3 12.2a.6.6 0 0 1-.6-.6v-4.2c0-.3.3-.6.6-.6h6c.3 0 .6.3.6.6v4.2c0 .3-.3.6-.6.6h-6Z"/></svg>'
    },
    {
      rdns: "com.trustwallet.app",
      name: "Trust Wallet",
      install: "https://trustwallet.com/download",
      icon: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="%230500FF"/><path fill="%23fff" d="M16 6.5c-2 1.6-4.6 2.5-7.4 2.5v6.7c0 4.6 3 8.7 7.4 10.3 4.4-1.6 7.4-5.7 7.4-10.3V9c-2.8 0-5.4-.9-7.4-2.5Zm0 14.6V9.5c1.5 1 3.4 1.5 5.4 1.5v4.7c0 3.4-2 6.4-5.4 7.7v-2.3Z"/></svg>'
    },
    {
      rdns: "app.phantom",
      name: "Phantom",
      install: "https://phantom.app/download",
      icon: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="p" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="%23534BB1"/><stop offset="1" stop-color="%23551BF9"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(%23p)"/><path fill="%23fff" d="M27 16.4c0 6.1-5 11-11.1 11h-.6c-5.7-.3-10.2-5-10.4-10.6V16C5.2 10 10.1 5 16.2 5c6 0 10.8 4.9 10.8 10.9v.5Zm-7.2-2.7c-.6 0-1.1.5-1.1 1.2 0 .6.5 1.1 1.1 1.1.6 0 1.1-.5 1.1-1.1 0-.7-.5-1.2-1.1-1.2Zm-4.3 0c-.6 0-1.1.5-1.1 1.2 0 .6.5 1.1 1.1 1.1.6 0 1.1-.5 1.1-1.1 0-.7-.5-1.2-1.1-1.2Zm-5.4 7.1c1.6 2.4 4.5 4 7.7 4 1.7 0 3.3-.4 4.7-1.2-1.6.9-3.4 1.4-5.3 1.4-3 0-5.8-1.3-7.5-3.5l.4-.7Z"/></svg>'
    },
    {
      rdns: "com.exodus",
      name: "Exodus",
      install: "https://www.exodus.com/download/",
      icon: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="%231F2033"/><path fill="%23fff" d="m16 4 11 6.4v11.2L16 28 5 21.6V10.4L16 4Zm0 4.2-7.2 4.2v7.2l7.2 4.2 7.2-4.2v-7.2L16 8.2Zm-3.4 5.4 6.8 4-6.8 4v-8Z"/></svg>'
    }
  ];
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
    .defi-wm__pill{font-size:10px;font-weight:600;color:var(--defi-accent,#5b8cff);background:rgba(91,140,255,.12);padding:2px 8px;border-radius:999px;white-space:nowrap}
    .defi-wm__pill--ok{color:#2bd4a4;background:rgba(43,212,164,.12)}
    .defi-wm__pill--muted{color:#9aa5cf;background:rgba(154,165,207,.1)}
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

    // Build a map of detected providers by rdns for quick lookup.
    const detectedByRdns = {};
    providers.forEach((p) => {
      if (p.info && p.info.rdns) detectedByRdns[p.info.rdns] = p;
    });

    // Render the curated list. Detected wallets connect on click; others open
    // the install page in a new tab.
    const ordered = [...RECOMMENDED].sort((a, b) => {
      if (a.rdns === remembered) return -1;
      if (b.rdns === remembered) return 1;
      const aD = detectedByRdns[a.rdns] ? 0 : 1;
      const bD = detectedByRdns[b.rdns] ? 0 : 1;
      return aD - bD;
    });

    ordered.forEach((wallet) => {
      const detected = detectedByRdns[wallet.rdns];
      const isRemembered = wallet.rdns === remembered;
      const iconSrc = (detected && detected.info && detected.info.icon) || wallet.icon;
      const li = document.createElement("li");
      let pill = "";
      if (isRemembered) pill = '<span class="defi-wm__pill">Last used</span>';
      else if (detected) pill = '<span class="defi-wm__pill defi-wm__pill--ok">Detected</span>';
      else pill = '<span class="defi-wm__pill defi-wm__pill--muted">Install</span>';
      li.innerHTML = `
        <button class="defi-wm__btn" type="button">
          <img class="defi-wm__icon" src="${esc(iconSrc)}" alt="">
          <span class="defi-wm__name">${esc(wallet.name)}</span>
          ${pill}
        </button>`;
      li.querySelector("button").addEventListener("click", async () => {
        if (detected) {
          await connectAndClose(detected);
        } else {
          window.open(wallet.install, "_blank", "noopener");
        }
      });
      body.appendChild(li);
    });

    // Surface any other detected wallets (e.g. Rabby, Zerion) that aren't in
    // the curated list — keeps long-tail wallets connectable.
    providers
      .filter((p) => !RECOMMENDED.some((r) => r.rdns === (p.info && p.info.rdns)))
      .forEach((p) => {
        const li = document.createElement("li");
        const isRemembered = p.info.rdns === remembered;
        const iconHtml = p.info.icon
          ? `<img class="defi-wm__icon" src="${esc(p.info.icon)}" alt="">`
          : `<div class="defi-wm__icon" style="display:flex;align-items:center;justify-content:center">🌐</div>`;
        li.innerHTML = `
          <button class="defi-wm__btn" type="button">
            ${iconHtml}
            <span class="defi-wm__name">${esc(p.info.name || "Wallet")}</span>
            ${isRemembered ? '<span class="defi-wm__pill">Last used</span>' : '<span class="defi-wm__pill defi-wm__pill--ok">Detected</span>'}
          </button>`;
        li.querySelector("button").addEventListener("click", async () => {
          await connectAndClose(p);
        });
        body.appendChild(li);
      });

    // Legacy injected wallet that didn't announce via EIP-6963 and isn't one
    // of the curated rdns options.
    if (providers.length === 0 && window.ethereum) {
      const li = document.createElement("li");
      li.innerHTML = `
        <button class="defi-wm__btn" type="button">
          <div class="defi-wm__icon" style="display:flex;align-items:center;justify-content:center">🌐</div>
          <span class="defi-wm__name">Browser wallet</span>
          <span class="defi-wm__pill defi-wm__pill--ok">Detected</span>
        </button>`;
      li.querySelector("button").addEventListener("click", async () => {
        await connectAndClose(null);
      });
      body.appendChild(li);
    }
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
