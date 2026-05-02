/* ---------------------------------------------------------------------------
   DeFiScoring auth singleton — `window.DefiAuth`
   ---------------------------------------------------------------------------
   Wraps the worker's SIWE flow so any dashboard page can:
     await DefiAuth.init();         // hydrate from /api/auth/me
     DefiAuth.subscribe(cb);        // observer pattern; cb(state)
     await DefiAuth.signIn(addr, signFn);   // primary login
     await DefiAuth.linkWallet(addr, signFn, label);  // attach extra wallet
     await DefiAuth.signOut();
     await DefiAuth.unlinkWallet(addr);
     await DefiAuth.listWallets();  // -> array

   `signFn(message, address)` returns a personal_sign signature.
   For MetaMask: window.ethereum.request({ method:"personal_sign", params:[msg, addr] })

   Truth lives in the ds_session cookie + the cached `/api/auth/me` response.
   We never put auth tokens in localStorage.
--------------------------------------------------------------------------- */
(function (global) {
  "use strict";

  var WORKER = (global.DEFI_RISK_WORKER_URL || "").replace(/\/$/, "");

  var state = {
    ready: false,
    user: null,           // { id, primary_wallet, email, display_name, is_admin } or null
    subscription: null,   // { tier, status, ... } or null
    wallets: [],          // [{ wallet_address, label, is_primary, ... }]
    error: null,
  };

  var subscribers = [];
  var initPromise = null;

  function notify() {
    subscribers.forEach(function (cb) {
      try { cb(snapshot()); } catch (e) { console.error("[DefiAuth] subscriber error", e); }
    });
  }
  function snapshot() {
    return {
      ready: state.ready,
      isSignedIn: !!state.user,
      user: state.user,
      subscription: state.subscription,
      tier: state.subscription ? state.subscription.tier : "free",
      wallets: state.wallets.slice(),
      primaryWallet: state.user ? state.user.primary_wallet : null,
      error: state.error,
    };
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

  /* ---------- SIWE message builder (EIP-4361) ----------
     Worker accepts ANY domain in ALLOWED_ORIGINS env var, plus the canonical
     defiscoring.com. For dev preview hosts you must add that host to
     ALLOWED_ORIGINS in worker secrets, otherwise the worker returns
     "domain_mismatch". */
  function nowIso() { return new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); }
  function expIso(seconds) {
    return new Date(Date.now() + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  function buildSiweMessage(opts) {
    // opts: { address, nonce, statement, domain, uri, chainId }
    var domain = opts.domain || global.location.host;
    var uri = opts.uri || (global.location.origin + "/");
    var chainId = opts.chainId || 1;
    var statement = opts.statement || "Sign in to DeFi Scoring to access your dashboard, alerts, and saved wallets.";
    var lines = [
      domain + " wants you to sign in with your Ethereum account:",
      opts.address,
      "",
      statement,
      "",
      "URI: " + uri,
      "Version: 1",
      "Chain ID: " + chainId,
      "Nonce: " + opts.nonce,
      "Issued At: " + nowIso(),
      "Expiration Time: " + expIso(300),
    ];
    return lines.join("\n");
  }

  /* ---------- core flows ---------- */

  async function fetchMe() {
    var r = await api("/api/auth/me");
    if (r && r.success) {
      state.user = r.user;
      state.subscription = r.subscription;
      state.error = null;
    } else {
      state.user = null;
      state.subscription = null;
    }
  }

  async function fetchWallets() {
    if (!state.user) { state.wallets = []; return; }
    var r = await api("/api/wallets");
    state.wallets = (r && r.success) ? (r.wallets || []) : [];
  }

  async function init() {
    if (initPromise) return initPromise;
    initPromise = (async function () {
      try {
        await fetchMe();
        if (state.user) await fetchWallets();
      } catch (e) {
        state.error = e.message || String(e);
      } finally {
        state.ready = true;
        notify();
      }
      return snapshot();
    })();
    return initPromise;
  }

  async function refresh() {
    await fetchMe();
    if (state.user) await fetchWallets(); else state.wallets = [];
    notify();
    return snapshot();
  }

  async function signIn(address, signFn, opts) {
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("invalid_address");
    if (typeof signFn !== "function") throw new Error("missing_sign_fn");

    var nonceResp = await api("/api/auth/nonce");
    if (!nonceResp.success) throw new Error("nonce_failed:" + nonceResp.error);

    var message = buildSiweMessage({
      address: address,
      nonce: nonceResp.nonce,
      domain: (opts && opts.domain) || global.location.host,
      uri: (opts && opts.uri) || (global.location.origin + "/"),
      chainId: (opts && opts.chainId) || 1,
    });

    var signature = await signFn(message, address);
    if (!signature) throw new Error("user_rejected_signature");

    var verify = await api("/api/auth/verify", {
      method: "POST", body: JSON.stringify({ message: message, signature: signature }),
    });
    if (!verify.success) throw new Error("verify_failed:" + verify.error);

    await refresh();
    return snapshot();
  }

  async function signOut() {
    await api("/api/auth/logout", { method: "POST" });
    state.user = null;
    state.subscription = null;
    state.wallets = [];
    notify();
    return snapshot();
  }

  async function linkWallet(address, signFn, label) {
    if (!state.user) throw new Error("not_signed_in");
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("invalid_address");
    if (typeof signFn !== "function") throw new Error("missing_sign_fn");

    var nonceResp = await api("/api/auth/nonce");
    if (!nonceResp.success) throw new Error("nonce_failed:" + nonceResp.error);

    var message = buildSiweMessage({
      address: address, nonce: nonceResp.nonce,
      statement: "Link this wallet to your DeFi Scoring account.",
    });

    var signature = await signFn(message, address);
    if (!signature) throw new Error("user_rejected_signature");

    var r = await api("/api/wallets/link", {
      method: "POST",
      body: JSON.stringify({ message: message, signature: signature, label: label || null }),
    });
    if (!r.success) {
      var err = new Error("link_failed:" + r.error);
      err.detail = r;
      throw err;
    }
    await fetchWallets();
    notify();
    return r;
  }

  async function unlinkWallet(address) {
    if (!state.user) throw new Error("not_signed_in");
    var r = await api("/api/wallets/" + encodeURIComponent(address), { method: "DELETE" });
    if (!r.success) throw new Error("unlink_failed:" + r.error);
    await fetchWallets();
    notify();
    return r;
  }

  async function listWallets() {
    if (!state.user) return [];
    await fetchWallets();
    notify();
    return state.wallets.slice();
  }

  function subscribe(cb) {
    if (typeof cb !== "function") return function () {};
    subscribers.push(cb);
    if (state.ready) { try { cb(snapshot()); } catch (e) {} }
    return function unsubscribe() {
      var i = subscribers.indexOf(cb);
      if (i >= 0) subscribers.splice(i, 1);
    };
  }

  /* ---------- helper: MetaMask sign-fn ---------- */

  async function metamaskSign(message, address) {
    var eth = global.ethereum;
    if (!eth) throw new Error("no_wallet_extension");
    return eth.request({ method: "personal_sign", params: [message, address] });
  }

  async function ensureMetamaskAccount() {
    var eth = global.ethereum;
    if (!eth) throw new Error("no_wallet_extension");
    var accounts = await eth.request({ method: "eth_requestAccounts" });
    if (!accounts || !accounts.length) throw new Error("no_account_returned");
    return accounts[0].toLowerCase();
  }

  /* ---------- public API ---------- */

  global.DefiAuth = {
    init: init,
    refresh: refresh,
    snapshot: snapshot,
    subscribe: subscribe,
    signIn: signIn,
    signOut: signOut,
    linkWallet: linkWallet,
    unlinkWallet: unlinkWallet,
    listWallets: listWallets,
    metamaskSign: metamaskSign,
    ensureMetamaskAccount: ensureMetamaskAccount,
    isReady: function () { return state.ready; },
  };

  // Auto-init so other scripts can subscribe without racing.
  init();
})(window);
