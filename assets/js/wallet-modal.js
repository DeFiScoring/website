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
  // Some wallets — MetaMask, Coinbase, Trust, Phantom, Exodus in certain
  // browsers — inject a provider but don't announce it via EIP-6963. Each
  // RECOMMENDED entry can opt-in a `legacy()` detector that returns the
  // injected provider instance (or null) so we can still surface a "Detected"
  // pill and connect on click instead of showing only "Install".
  function findInProviders(predicate) {
    const eth = window.ethereum;
    if (!eth) return null;
    if (Array.isArray(eth.providers)) {
      const hit = eth.providers.find(predicate);
      if (hit) return hit;
    }
    return predicate(eth) ? eth : null;
  }

  const RECOMMENDED = [
    {
      rdns: "io.metamask",
      name: "MetaMask",
      install: "https://metamask.io/download/",
      mobile: function (host, path) { return "https://metamask.app.link/dapp/" + host + path; },
      legacy: function () {
        return findInProviders((p) =>
          p && p.isMetaMask && !p.isBraveWallet && !p.isCoinbaseWallet && !p.isTrust && !p.isPhantom && !p.isRabby
        );
      },
      icon: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 318.6 318.6"><polygon fill="%23E2761B" stroke="%23E2761B" stroke-linecap="round" stroke-linejoin="round" points="274.1,35.5 174.6,109.4 193,65.8"/><polygon fill="%23E4761B" stroke="%23E4761B" stroke-linecap="round" stroke-linejoin="round" points="44.4,35.5 143.1,110.1 125.6,65.8"/><polygon fill="%23E4761B" stroke="%23E4761B" stroke-linecap="round" stroke-linejoin="round" points="238.3,206.8 211.8,247.4 268.5,263 284.8,207.7"/><polygon fill="%23E4761B" stroke="%23E4761B" stroke-linecap="round" stroke-linejoin="round" points="33.9,207.7 50.1,263 106.8,247.4 80.3,206.8"/><polygon fill="%23E4761B" stroke="%23E4761B" stroke-linecap="round" stroke-linejoin="round" points="103.6,138.2 87.8,162.1 144.1,164.6 142.1,104.1"/><polygon fill="%23E4761B" stroke="%23E4761B" stroke-linecap="round" stroke-linejoin="round" points="214.9,138.2 175.9,103.4 174.6,164.6 230.8,162.1"/><polygon fill="%23E4761B" stroke="%23E4761B" stroke-linecap="round" stroke-linejoin="round" points="106.8,247.4 140.6,230.9 111.4,208.1"/><polygon fill="%23E4761B" stroke="%23E4761B" stroke-linecap="round" stroke-linejoin="round" points="177.9,230.9 211.8,247.4 207.1,208.1"/><polygon fill="%23D7C1B3" stroke="%23D7C1B3" stroke-linecap="round" stroke-linejoin="round" points="211.8,247.4 177.9,230.9 180.6,253 180.3,262.3"/><polygon fill="%23D7C1B3" stroke="%23D7C1B3" stroke-linecap="round" stroke-linejoin="round" points="106.8,247.4 138.3,262.3 138.1,253 140.6,230.9"/><polygon fill="%23233447" stroke="%23233447" stroke-linecap="round" stroke-linejoin="round" points="138.8,193.5 110.6,185.2 130.5,176.1"/><polygon fill="%23233447" stroke="%23233447" stroke-linecap="round" stroke-linejoin="round" points="179.7,193.5 188,176.1 208,185.2"/><polygon fill="%23CD6116" stroke="%23CD6116" stroke-linecap="round" stroke-linejoin="round" points="106.8,247.4 111.6,206.8 80.3,207.7"/><polygon fill="%23CD6116" stroke="%23CD6116" stroke-linecap="round" stroke-linejoin="round" points="207,206.8 211.8,247.4 238.3,207.7"/><polygon fill="%23CD6116" stroke="%23CD6116" stroke-linecap="round" stroke-linejoin="round" points="230.8,162.1 174.6,164.6 179.8,193.5 188.1,176.1 208.1,185.2"/><polygon fill="%23CD6116" stroke="%23CD6116" stroke-linecap="round" stroke-linejoin="round" points="110.6,185.2 130.6,176.1 138.8,193.5 144.1,164.6 87.8,162.1"/><polygon fill="%23E4751F" stroke="%23E4751F" stroke-linecap="round" stroke-linejoin="round" points="87.8,162.1 111.4,208.1 110.6,185.2"/><polygon fill="%23E4751F" stroke="%23E4751F" stroke-linecap="round" stroke-linejoin="round" points="208.1,185.2 207.1,208.1 230.8,162.1"/><polygon fill="%23E4751F" stroke="%23E4751F" stroke-linecap="round" stroke-linejoin="round" points="144.1,164.6 138.8,193.5 145.4,227.6 146.9,182.7"/><polygon fill="%23E4751F" stroke="%23E4751F" stroke-linecap="round" stroke-linejoin="round" points="174.6,164.6 171.9,182.6 173.1,227.6 179.8,193.5"/><polygon fill="%23F6851B" stroke="%23F6851B" stroke-linecap="round" stroke-linejoin="round" points="179.8,193.5 173.1,227.6 177.9,230.9 207.1,208.1 208.1,185.2"/><polygon fill="%23F6851B" stroke="%23F6851B" stroke-linecap="round" stroke-linejoin="round" points="110.6,185.2 111.4,208.1 140.6,230.9 145.4,227.6 138.8,193.5"/><polygon fill="%23C0AD9E" stroke="%23C0AD9E" stroke-linecap="round" stroke-linejoin="round" points="180.3,262.3 180.6,253 178.1,250.8 140.4,250.8 138.1,253 138.3,262.3 106.8,247.4 117.8,256.4 140.1,271.9 178.4,271.9 200.8,256.4 211.8,247.4"/><polygon fill="%23161616" stroke="%23161616" stroke-linecap="round" stroke-linejoin="round" points="177.9,230.9 173.1,227.6 145.4,227.6 140.6,230.9 138.1,253 140.4,250.8 178.1,250.8 180.6,253"/><polygon fill="%23763D16" stroke="%23763D16" stroke-linecap="round" stroke-linejoin="round" points="278.3,114.2 286.8,73.4 274.1,35.5 177.9,106.9 214.9,138.2 267.2,153.5 278.8,140 273.8,136.4 281.8,129.1 275.6,124.3 283.6,118.2"/><polygon fill="%23763D16" stroke="%23763D16" stroke-linecap="round" stroke-linejoin="round" points="31.8,73.4 40.3,114.2 34.9,118.2 42.9,124.3 36.8,129.1 44.8,136.4 39.8,140 51.3,153.5 103.6,138.2 140.6,106.9 44.4,35.5"/><polygon fill="%23F6851B" stroke="%23F6851B" stroke-linecap="round" stroke-linejoin="round" points="267.2,153.5 214.9,138.2 230.8,162.1 207.1,208.1 238.3,207.7 284.8,207.7"/><polygon fill="%23F6851B" stroke="%23F6851B" stroke-linecap="round" stroke-linejoin="round" points="103.6,138.2 51.3,153.5 33.9,207.7 80.3,207.7 111.4,208.1 87.8,162.1"/><polygon fill="%23F6851B" stroke="%23F6851B" stroke-linecap="round" stroke-linejoin="round" points="174.6,164.6 177.9,106.9 193.1,65.8 125.6,65.8 140.6,106.9 144.1,164.6 145.3,182.8 145.4,227.6 173.1,227.6 173.3,182.8"/></svg>'
    },
    {
      rdns: "com.coinbase.wallet",
      name: "Coinbase Wallet",
      install: "https://www.coinbase.com/wallet",
      mobile: function (host, path) { return "https://go.cb-w.com/dapp?cb_url=" + encodeURIComponent("https://" + host + path); },
      legacy: function () {
        if (window.coinbaseWalletExtension) return window.coinbaseWalletExtension;
        return findInProviders((p) => p && (p.isCoinbaseWallet || p.isCoinbaseBrowser));
      },
      icon: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="%230052FF"/><path fill="%23fff" d="M16 6.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19Zm-3 12.2a.6.6 0 0 1-.6-.6v-4.2c0-.3.3-.6.6-.6h6c.3 0 .6.3.6.6v4.2c0 .3-.3.6-.6.6h-6Z"/></svg>'
    },
    {
      rdns: "com.trustwallet.app",
      name: "Trust Wallet",
      install: "https://trustwallet.com/download",
      mobile: function (host, path) { return "https://link.trustwallet.com/open_url?coin_id=60&url=" + encodeURIComponent("https://" + host + path); },
      legacy: function () {
        if (window.trustwallet && window.trustwallet.ethereum) return window.trustwallet.ethereum;
        return findInProviders((p) => p && p.isTrust);
      },
      icon: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="%230500FF"/><path fill="%23fff" d="M16 6.5c-2 1.6-4.6 2.5-7.4 2.5v6.7c0 4.6 3 8.7 7.4 10.3 4.4-1.6 7.4-5.7 7.4-10.3V9c-2.8 0-5.4-.9-7.4-2.5Zm0 14.6V9.5c1.5 1 3.4 1.5 5.4 1.5v4.7c0 3.4-2 6.4-5.4 7.7v-2.3Z"/></svg>'
    },
    {
      rdns: "app.phantom",
      name: "Phantom",
      install: "https://phantom.app/download",
      mobile: function (host, path) { return "https://phantom.app/ul/browse/" + encodeURIComponent("https://" + host + path) + "?ref=" + encodeURIComponent("https://" + host); },
      legacy: function () {
        if (window.phantom && window.phantom.ethereum) return window.phantom.ethereum;
        return findInProviders((p) => p && p.isPhantom);
      },
      icon: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="p" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="%23534BB1"/><stop offset="1" stop-color="%23551BF9"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(%23p)"/><path fill="%23fff" d="M27 16.4c0 6.1-5 11-11.1 11h-.6c-5.7-.3-10.2-5-10.4-10.6V16C5.2 10 10.1 5 16.2 5c6 0 10.8 4.9 10.8 10.9v.5Zm-7.2-2.7c-.6 0-1.1.5-1.1 1.2 0 .6.5 1.1 1.1 1.1.6 0 1.1-.5 1.1-1.1 0-.7-.5-1.2-1.1-1.2Zm-4.3 0c-.6 0-1.1.5-1.1 1.2 0 .6.5 1.1 1.1 1.1.6 0 1.1-.5 1.1-1.1 0-.7-.5-1.2-1.1-1.2Zm-5.4 7.1c1.6 2.4 4.5 4 7.7 4 1.7 0 3.3-.4 4.7-1.2-1.6.9-3.4 1.4-5.3 1.4-3 0-5.8-1.3-7.5-3.5l.4-.7Z"/></svg>'
    },
    {
      rdns: "com.exodus",
      name: "Exodus",
      install: "https://www.exodus.com/download/",
      legacy: function () {
        if (window.exodus && window.exodus.ethereum) return window.exodus.ethereum;
        return findInProviders((p) => p && p.isExodus);
      },
      icon: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="%231F2033"/><path fill="%23fff" d="m16 4 11 6.4v11.2L16 28 5 21.6V10.4L16 4Zm0 4.2-7.2 4.2v7.2l7.2 4.2 7.2-4.2v-7.2L16 8.2Zm-3.4 5.4 6.8 4-6.8 4v-8Z"/></svg>'
    }
  ];

  // True for iOS / Android browsers where injected providers usually aren't
  // available. We use this to deeplink into the wallet's in-app dApp browser
  // instead of sending the user to a desktop install page.
  const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "");

  function dappTarget() {
    return { host: location.host, path: location.pathname + location.search };
  }
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

  // Pick the highest-priority provider that's actually available right now.
  // EIP-6963 announcements win first (most reliable), then last-used, then
  // legacy detectors for curated wallets, then bare window.ethereum. Returns
  // { provider, rdns, name } or null.
  function pickAutoProvider() {
    const W = window.DefiWallet;
    const providers = (W && W.providers) ? W.providers : [];
    const remembered = localStorage.getItem(PROVIDER_KEY);
    const priority = ["io.metamask", "io.rabby", "com.coinbase.wallet", "com.trustwallet.app", "app.phantom", "com.exodus"];

    // 1. Prefer last-used wallet if its provider is currently detected.
    if (remembered) {
      const m = providers.find((p) => p.info && p.info.rdns === remembered);
      if (m) return { provider: m.provider, rdns: m.info.rdns, name: m.info.name };
      const cur = RECOMMENDED.find((w) => w.rdns === remembered);
      if (cur && typeof cur.legacy === "function") {
        const lp = cur.legacy();
        if (lp) return { provider: lp, rdns: cur.rdns, name: cur.name };
      }
    }
    // 2. Highest-priority EIP-6963 provider.
    const sortedAnnounced = [...providers].sort((a, b) => {
      const ai = priority.indexOf(a.info && a.info.rdns);
      const bi = priority.indexOf(b.info && b.info.rdns);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
    if (sortedAnnounced.length) {
      const p = sortedAnnounced[0];
      return { provider: p.provider, rdns: p.info.rdns, name: p.info.name };
    }
    // 3. Legacy detectors for curated wallets, in priority order.
    for (const rdns of priority) {
      const cur = RECOMMENDED.find((w) => w.rdns === rdns);
      if (cur && typeof cur.legacy === "function") {
        const lp = cur.legacy();
        if (lp) return { provider: lp, rdns: cur.rdns, name: cur.name };
      }
    }
    // 4. Bare window.ethereum (single legacy injected wallet).
    if (window.ethereum) return { provider: window.ethereum, rdns: null, name: "Browser wallet" };
    return null;
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

    // ── Auto-detect entry ────────────────────────────────────────────────
    // Always-present "just connect what's installed" option so new users
    // never see a wall of Install pills.
    const auto = pickAutoProvider();
    const autoLi = document.createElement("li");
    const autoLabel = auto && auto.name
      ? "Auto-detect — " + auto.name
      : "Auto-detect wallet";
    const autoPill = auto
      ? '<span class="defi-wm__pill defi-wm__pill--ok">Ready</span>'
      : '<span class="defi-wm__pill defi-wm__pill--muted">None found</span>';
    autoLi.innerHTML = `
      <button class="defi-wm__btn" type="button">
        <div class="defi-wm__icon" style="display:flex;align-items:center;justify-content:center">⚡</div>
        <span class="defi-wm__name">${esc(autoLabel)}</span>
        ${autoPill}
      </button>`;
    autoLi.querySelector("button").addEventListener("click", async () => {
      if (!auto) {
        errSlot.textContent = "No browser wallet found. Pick one from the list to install it.";
        return;
      }
      if (auto.rdns) localStorage.setItem(PROVIDER_KEY, auto.rdns);
      await connectAndCloseRaw(auto.provider);
    });
    body.appendChild(autoLi);

    // Render the curated list. Detected wallets (announced or legacy)
    // connect on click; undetected ones open the install page in a new tab.
    const legacyByRdns = {};
    RECOMMENDED.forEach((w) => {
      if (typeof w.legacy === "function" && !detectedByRdns[w.rdns]) {
        try { const lp = w.legacy(); if (lp) legacyByRdns[w.rdns] = lp; } catch (_) {}
      }
    });
    const isLive = (rdns) => !!detectedByRdns[rdns] || !!legacyByRdns[rdns];

    const ordered = [...RECOMMENDED].sort((a, b) => {
      if (a.rdns === remembered) return -1;
      if (b.rdns === remembered) return 1;
      const aD = isLive(a.rdns) ? 0 : 1;
      const bD = isLive(b.rdns) ? 0 : 1;
      return aD - bD;
    });

    ordered.forEach((wallet) => {
      const detected = detectedByRdns[wallet.rdns];
      const legacyProvider = legacyByRdns[wallet.rdns];
      const live = !!(detected || legacyProvider);
      const isRemembered = wallet.rdns === remembered;
      const canDeeplink = IS_MOBILE && typeof wallet.mobile === "function";
      const iconSrc = (detected && detected.info && detected.info.icon) || wallet.icon;
      const li = document.createElement("li");
      let pill = "";
      if (isRemembered && live) pill = '<span class="defi-wm__pill">Last used</span>';
      else if (live) pill = '<span class="defi-wm__pill defi-wm__pill--ok">Detected</span>';
      else if (canDeeplink) pill = '<span class="defi-wm__pill">Open in app</span>';
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
        } else if (legacyProvider) {
          // Legacy-injected wallet (no EIP-6963 announce) — connect directly
          // to the matched provider so we don't fall back to a different one
          // when multiple wallets share window.ethereum.
          localStorage.setItem(PROVIDER_KEY, wallet.rdns);
          await connectAndCloseRaw(legacyProvider);
        } else if (canDeeplink) {
          // On mobile, open the wallet's in-app dApp browser pointed at this
          // page. The wallet then injects window.ethereum and the user can
          // hit Connect again from inside the in-app browser.
          const t = dappTarget();
          window.location.href = wallet.mobile(t.host, t.path);
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
    // of the curated rdns options. Suppressed if any curated wallet was
    // already resolved via legacy detection (otherwise the same provider
    // would appear twice — once as e.g. "MetaMask Detected" and once as
    // "Browser wallet Detected").
    const anyLegacyResolved = Object.keys(legacyByRdns).length > 0;
    if (providers.length === 0 && !anyLegacyResolved && window.ethereum) {
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

  // Variant of connectAndClose that connects to a specific provider object
  // rather than an EIP-6963 entry. Used by the auto-detect button and by
  // legacy-detected curated wallets.
  async function connectAndCloseRaw(rawProvider) {
    const buttons = body.querySelectorAll("button");
    buttons.forEach((b) => { b.disabled = true; });
    errSlot.textContent = "";
    try {
      const addr = await window.DefiWallet.connectWith(rawProvider);
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
