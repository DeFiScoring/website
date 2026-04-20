/* DeFi Scoring – shared dashboard JS
 * Wallet connect (EIP-1193) + DefiAPI client backed by REAL on-chain reads
 * via window.DefiOnchain. No fabricated values.
 *
 * Optional remote backend: set window.DEFI_API_BASE to a URL that serves
 * /api/score, /api/portfolio, /api/alerts and it will be used in preference
 * to the on-chain fallback. Otherwise on-chain reads are used directly.
 */
(function () {
  const DEFAULT_API_BASE = "";
  const API_BASE = (window.DEFI_API_BASE || DEFAULT_API_BASE).replace(/\/$/, "");
  const STORAGE_KEY = "defi.wallet";

  const state = { wallet: localStorage.getItem(STORAGE_KEY) || null };
  let snapshotCache = { wallet: null, data: null, ts: 0 };

  function shorten(addr) { return !addr ? "" : addr.slice(0, 6) + "…" + addr.slice(-4); }

  function setWallet(addr) {
    state.wallet = addr;
    if (addr) localStorage.setItem(STORAGE_KEY, addr);
    else localStorage.removeItem(STORAGE_KEY);
    snapshotCache = { wallet: null, data: null, ts: 0 };
    window.userWallet = addr;
    renderWalletUI();
    document.dispatchEvent(new CustomEvent("defi:wallet-changed", { detail: { wallet: addr } }));
  }

  function renderWalletUI() {
    const status = document.getElementById("defi-wallet-status");
    const connectBtn = document.getElementById("defi-connect-btn");
    const scanBtn = document.getElementById("defi-scan-btn");
    if (!status || !connectBtn) return;
    if (state.wallet) {
      status.textContent = shorten(state.wallet);
      status.classList.remove("defi-wallet-status--disconnected");
      status.classList.add("defi-wallet-status--connected");
      connectBtn.textContent = "Disconnect";
      if (scanBtn) scanBtn.disabled = false;
    } else {
      status.textContent = "Not connected";
      status.classList.add("defi-wallet-status--disconnected");
      status.classList.remove("defi-wallet-status--connected");
      connectBtn.textContent = "Connect Wallet";
      if (scanBtn) scanBtn.disabled = true;
    }
  }

  async function connect() {
    // Prefer the EIP-6963 picker modal (RainbowKit-style multi-wallet UX).
    if (window.DefiWalletModal && window.DefiWallet) {
      const addr = await window.DefiWalletModal.open();
      if (addr) setWallet(addr);
      return;
    }
    // Fallback: legacy single-wallet path.
    if (!window.ethereum) {
      alert("No EVM wallet detected. Install MetaMask, Rabby, or another EIP-1193 wallet.");
      return;
    }
    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      if (accounts && accounts[0]) setWallet(accounts[0]);
    } catch (err) { console.warn("Wallet connect rejected", err); }
  }
  function disconnect() { setWallet(null); }

  function bind() {
    const connectBtn = document.getElementById("defi-connect-btn");
    const scanBtn = document.getElementById("defi-scan-btn");
    if (connectBtn) connectBtn.addEventListener("click", () => state.wallet ? disconnect() : connect());
    if (scanBtn) scanBtn.addEventListener("click", () => {
      if (!state.wallet) return;
      snapshotCache = { wallet: null, data: null, ts: 0 };
      document.dispatchEvent(new CustomEvent("defi:scan", { detail: { wallet: state.wallet } }));
    });
    if (window.ethereum && window.ethereum.on) {
      window.ethereum.on("accountsChanged", (accs) => setWallet(accs && accs[0] ? accs[0] : null));
    }
  }

  /* ---------- API client ---------- */
  async function apiGet(path) {
    if (!API_BASE) return null;
    const res = await fetch(API_BASE + path, { headers: { "Accept": "application/json" } });
    if (!res.ok) throw new Error("API " + res.status);
    return res.json();
  }

  async function getSnapshot(wallet) {
    const fresh = snapshotCache.wallet === wallet && Date.now() - snapshotCache.ts < 60_000;
    if (fresh) return snapshotCache.data;
    if (!window.DefiOnchain) throw new Error("DefiOnchain not loaded");
    const data = await window.DefiOnchain.getWalletSnapshot(wallet);
    snapshotCache = { wallet, data, ts: Date.now() };
    return data;
  }

  function bandFor(score) {
    if (score == null) return "Unknown";
    if (score >= 750) return "Excellent";
    if (score >= 670) return "Good";
    if (score >= 580) return "Fair";
    return "Poor";
  }

  window.DefiAPI = {
    apiBase: API_BASE,
    isMock: false,

    async getScore(wallet) {
      // Primary path: Cloudflare Worker /api/health-score (Aave V3 + Uniswap V3 +
      // Snapshot + Etherscan). All four pillars use real on-chain / API data.
      if (API_BASE) {
        try {
          const res = await fetch(API_BASE + "/api/health-score", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify({ wallet }),
          });
          if (res.ok) {
            const data = await res.json();
            if (data && data.success) {
              const p = data.pillars || {};
              const clampPillar = (pl) => pl && pl.value != null ? Math.max(0, Math.min(100, Math.round(pl.value))) : null;
              const factors = [
                {
                  name: "Loan reliability (Aave V3 health factor)",
                  value: clampPillar(p.loan_reliability),
                  weight: 40,
                  real: p.loan_reliability ? p.loan_reliability.real !== false : false,
                  detail: p.loan_reliability && p.loan_reliability.finding,
                },
                {
                  name: "Liquidity provision (Uniswap V3 LP)",
                  value: clampPillar(p.liquidity_provision),
                  weight: 30,
                  real: p.liquidity_provision ? p.liquidity_provision.real !== false : false,
                  detail: p.liquidity_provision && p.liquidity_provision.finding,
                },
                {
                  name: "Governance participation (Snapshot votes)",
                  value: clampPillar(p.governance),
                  weight: 20,
                  real: p.governance ? p.governance.real !== false : false,
                  detail: p.governance && p.governance.finding,
                },
                {
                  name: "Account age (Ethereum mainnet)",
                  value: clampPillar(p.account_age),
                  weight: 10,
                  real: p.account_age ? p.account_age.real !== false : false,
                  detail: p.account_age && p.account_age.finding,
                },
              ];
              const history = (data.history || []).map((h) => ({
                month: new Date(h.computed_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
                score: h.score,
              }));
              const notes = [];
              if (Array.isArray(data.adjustments) && data.adjustments.length) {
                notes.push("Adjustments: " + data.adjustments.join("; "));
              }
              if (data.persisted === false) notes.push("Score history isn't being persisted yet.");
              return {
                wallet,
                score: data.score,
                band: bandFor(data.score),
                preliminary: false,
                updated_at: data.timestamp || new Date().toISOString(),
                factors,
                history,
                notice: notes.join(" • "),
              };
            }
          } else {
            console.warn("health-score HTTP " + res.status);
          }
        } catch (e) {
          console.warn("health-score call failed, falling back to on-chain preliminary:", e.message);
        }
      }
      // Fallback: client-side preliminary from public RPCs only.
      const snap = await getSnapshot(wallet);
      const s = window.DefiOnchain.preliminaryScore(snap);
      return {
        wallet,
        score: s.score,
        band: s.band,
        preliminary: true,
        updated_at: snap.fetched_at,
        factors: s.factors,
        history: [],
        notice: "Preliminary score derived from public RPC reads only. The full health-score backend was unreachable.",
      };
    },

    async getPortfolio(wallet) {
      try {
        const real = await apiGet("/api/portfolio?wallet=" + encodeURIComponent(wallet));
        if (real) return real;
      } catch (e) { console.warn("remote portfolio unavailable, using on-chain native balances:", e.message); }
      const snap = await getSnapshot(wallet);
      return {
        wallet,
        total_value_usd: snap.total_native_value_usd,
        positions: snap.positions, // native balances only — real numbers
        chains: snap.chains,
        notice: snap.positions.length === 0
          ? "No native ETH/MATIC balance found on Ethereum, Arbitrum, or Polygon."
          : "Showing native-token balances only. ERC-20 tokens and DeFi protocol positions require a data-provider integration.",
      };
    },

    async getAlerts(wallet) {
      try {
        const real = await apiGet("/api/alerts?wallet=" + encodeURIComponent(wallet));
        if (real) return real;
      } catch (e) { console.warn("remote alerts unavailable:", e.message); }
      return {
        wallet,
        items: [],
        notice: "Alert history requires the alerts backend (not yet connected). Configure rules below to be notified once it is live.",
      };
    },
  };

  window.DefiState = {
    get wallet() { return state.wallet; },
    shorten,
    bandFor,
  };
  window.userWallet = state.wallet;

  document.addEventListener("DOMContentLoaded", () => { bind(); renderWalletUI(); });
})();
