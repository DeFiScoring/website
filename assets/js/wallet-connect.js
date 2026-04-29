/* DeFi Scoring – wallet-connect.js
 *
 * EIP-6963 + EIP-1193 wallet connector. Discovers all injected wallets
 * (MetaMask, Rabby, Coinbase Wallet, Frame, Trust, etc.) using the modern
 * EIP-6963 announce/request handshake and falls back to legacy
 * window.ethereum when no wallet announces itself.
 *
 * Public API (unchanged for backwards compat):
 *   DefiWallet.connect()            -> Promise<address|null>
 *   DefiWallet.disconnect()         -> void
 *   DefiWallet.address              -> string|null
 *   DefiWallet.shorten(addr)        -> "0x1234…abcd"
 *   DefiWallet.on(evt, cb)          -> evt: "change"
 *   DefiWallet.providers            -> [{info, provider}]   (EIP-6963 list)
 *   DefiWallet.connectWith(provider)-> Promise<address|null>
 */
(function () {
  const STORAGE_KEY = "defi.wallet";
  const PROVIDER_KEY = "defi.wallet.providerRdns";
  const listeners = { change: [] };

  const state = {
    address: localStorage.getItem(STORAGE_KEY) || null,
    selectedProvider: null,
    providers: [],
  };

  function shorten(addr) { return addr ? addr.slice(0, 6) + "…" + addr.slice(-4) : ""; }

  function emit(evt, payload) {
    (listeners[evt] || []).forEach((fn) => {
      try { fn(payload); } catch (e) { console.warn(evt + " handler failed", e); }
    });
  }

  function setAddress(addr) {
    state.address = addr || null;
    if (state.address) localStorage.setItem(STORAGE_KEY, state.address);
    else localStorage.removeItem(STORAGE_KEY);
    emit("change", state.address);
    document.dispatchEvent(new CustomEvent("defi:wallet-changed", { detail: { wallet: state.address } }));
  }

  // ── EIP-6963 discovery ────────────────────────────────────────────────
  window.addEventListener("eip6963:announceProvider", (event) => {
    const detail = event.detail;
    if (!detail || !detail.info || !detail.provider) return;
    if (state.providers.find((p) => p.info.uuid === detail.info.uuid)) return;
    state.providers.push({ info: detail.info, provider: detail.provider });
  });
  // Trigger re-announcement of any previously-loaded wallets.
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  function pickProvider() {
    // Prefer last-used wallet by rdns if remembered.
    const rememberedRdns = localStorage.getItem(PROVIDER_KEY);
    if (rememberedRdns) {
      const found = state.providers.find((p) => p.info.rdns === rememberedRdns);
      if (found) return found.provider;
    }
    if (state.providers.length === 1) return state.providers[0].provider;
    if (state.providers.length > 1) {
      // Multiple wallets and no modal available — pick by priority instead of
      // popping a window.prompt (which is hostile UX and can be silently
      // blocked by some browsers). MetaMask wins, then Rabby, Coinbase, etc.
      const priority = ["io.metamask", "io.rabby", "com.coinbase.wallet", "com.trustwallet.app", "app.phantom", "com.exodus"];
      const sorted = [...state.providers].sort((a, b) => {
        const ai = priority.indexOf(a.info.rdns);
        const bi = priority.indexOf(b.info.rdns);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });
      const picked = sorted[0];
      if (picked) {
        localStorage.setItem(PROVIDER_KEY, picked.info.rdns);
        return picked.provider;
      }
    }
    // Fallback: legacy window.ethereum (single injected wallet not using EIP-6963).
    return window.ethereum || null;
  }

  function bindProviderEvents(provider) {
    if (!provider || typeof provider.on !== "function") return;
    if (state.selectedProvider === provider) return;
    state.selectedProvider = provider;
    provider.on("accountsChanged", (accs) => setAddress(accs && accs[0] ? accs[0] : null));
    provider.on("chainChanged", () => { /* leave address; pages re-derive */ });
    provider.on("disconnect", () => setAddress(null));
  }

  async function connectWith(provider) {
    if (!provider) {
      alert("No browser wallet detected.\n\nInstall MetaMask, Coinbase Wallet, Trust, Rabby, Phantom, or Exodus, then refresh this page.");
      return null;
    }
    try {
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const addr = accounts && accounts[0] ? accounts[0] : null;
      bindProviderEvents(provider);
      setAddress(addr);
      return addr;
    } catch (err) {
      console.warn("Wallet connect rejected", err);
      return null;
    }
  }

  async function connect() {
    // Allow late-arriving wallets a moment to announce themselves on first call.
    if (!state.providers.length) {
      window.dispatchEvent(new Event("eip6963:requestProvider"));
      await new Promise((r) => setTimeout(r, 80));
    }
    // Prefer the modal if it's loaded — gives the user the auto-detect button
    // plus the curated wallet picker rather than a silent or prompt-based
    // selection. Falls through to direct connect if the modal isn't on the
    // page (e.g. embedded contexts that only load wallet-connect.js).
    if (window.DefiWalletModal && typeof window.DefiWalletModal.open === "function") {
      try {
        const addr = await window.DefiWalletModal.open();
        return addr || null;
      } catch (e) {
        console.warn("[wallet-connect] modal failed, falling back:", e);
      }
    }
    return connectWith(pickProvider());
  }

  function disconnect() {
    setAddress(null);
    localStorage.removeItem(PROVIDER_KEY);
  }

  // Bind events on legacy provider too, so accountsChanged still fires when
  // the user connected via injected window.ethereum.
  if (window.ethereum && typeof window.ethereum.on === "function") {
    bindProviderEvents(window.ethereum);
  }

  window.DefiWallet = {
    connect,
    connectWith,
    disconnect,
    shorten,
    get address() { return state.address; },
    get providers() { return state.providers.slice(); },
    on(evt, cb) {
      if (!listeners[evt]) listeners[evt] = [];
      listeners[evt].push(cb);
    },
  };

  // Convenience globals (matches the public API expected by Risk Profiler etc.)
  window.connectWallet = connect;
  window.disconnectWallet = disconnect;
  window.userWallet = state.address;
  listeners.change.push((addr) => { window.userWallet = addr; });
})();
