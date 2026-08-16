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
    if (score == null) return "Unscored";
    if (score >= 750) return "Excellent";
    if (score >= 670) return "Good";
    if (score >= 580) return "Fair";
    return "Poor";
  }

  // Map the /api/wallet-score payload (5 pillars, weights 35/25/15/10/15)
  // into the factor shape every dashboard renderer consumes. Carries the
  // `scored:false` state through untouched so the UI can render an honest
  // "no history yet" instead of a number.
  function mapWalletScore(wallet, data) {
    const p = data.pillars || {};
    const pct = (pl) => (pl && pl.value != null) ? Math.max(0, Math.min(100, Math.round(pl.value))) : null;
    const mk = (pl, name) => ({
      name,
      value: pct(pl),
      weight: pl && pl.weight != null ? Math.round(pl.weight * 100) : 0,
      real: pl ? pl.real !== false : false,
      detail: pl && (pl.rationale || pl.finding) || "",
    });
    const factors = [
      mk(p.loan_reliability,    "Loan reliability (Aave V3, all chains)"),
      mk(p.portfolio_health,    "Portfolio health (size + diversification)"),
      mk(p.liquidity_provision, "Liquidity provision (Uniswap V3 LP)"),
      mk(p.governance,          "Governance participation (Snapshot)"),
      mk(p.account_age,         "Account age (Ethereum first tx)"),
    ];
    const notes = [];
    if (Array.isArray(data.adjustments) && data.adjustments.length) {
      notes.push("Adjustments: " + data.adjustments.map(function (a) {
        return typeof a === "string" ? a : ((a.delta > 0 ? "+" : "") + a.delta + " " + (a.reason || a.name));
      }).join("; "));
    }
    if (data.scored === false && data.explanation) notes.push(data.explanation);
    return {
      wallet,
      scored: data.scored !== false,
      score: data.score,
      band: data.scored === false ? "Unscored" : bandFor(data.score),
      reason: data.reason || null,
      explanation: data.explanation || null,
      preliminary: false,
      updated_at: data.timestamp || new Date().toISOString(),
      factors,
      history: [],
      notice: notes.join(" • "),
    };
  }

  window.DefiAPI = {
    apiBase: API_BASE,
    isMock: false,

    async getScore(wallet) {
      // Primary path: the multi-chain 5-pillar engine. GET /api/wallet-score
      // composes the T3 portfolio scan + T4 DeFi positions (Aave V3, Compound
      // V3, Uni V3 across every Tier-1 chain) + Snapshot governance +
      // Ethereum first-tx age — the full service surface, not the Eth-only
      // legacy model. It is also the only endpoint honest enough to say
      // "unscored" for a wallet with no on-chain footprint instead of
      // inventing a number.
      if (API_BASE) {
        try {
          const res = await fetch(API_BASE + "/api/wallet-score?wallet=" + encodeURIComponent(wallet),
            { headers: { "Accept": "application/json" } });
          if (res.ok) {
            const data = await res.json();
            if (data && data.success) return mapWalletScore(wallet, data);
          } else {
            console.warn("wallet-score HTTP " + res.status);
          }
        } catch (e) {
          console.warn("wallet-score call failed, trying legacy health-score:", e.message);
        }
      }
      // Fallback #2: legacy Ethereum-only health-score endpoint.
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
        scored: s.scored !== false,
        score: s.score,
        band: s.band,
        reason: s.reason,
        explanation: s.explanation,
        preliminary: true,
        updated_at: snap.fetched_at,
        factors: s.factors,
        history: [],
        notice: s.scored === false
          ? (s.explanation || "This wallet has no on-chain history yet — nothing to score.")
          : "Preliminary score derived from public RPC reads only. The full score backend was unreachable.",
      };
    },

    async getPortfolio(wallet) {
      try {
        // P5 — pass the user's fiat preference so CoinGecko quotes in the
        // requested currency directly (no client-side FX conversion). The
        // worker accepts any 3-letter ISO code CoinGecko supports.
        let fiat = "USD";
        try { fiat = (localStorage.getItem("defi.fiat") || "USD").toUpperCase(); } catch (_e) {}
        if (!/^[A-Z]{3}$/.test(fiat)) fiat = "USD";
        // Cache-buster on the click of the rescan button — simplest way to
        // bypass the 30s `cache-control: max-age=30` edge cache without
        // touching the worker.
        const cb = "&_t=" + Date.now();
        const real = await apiGet("/api/portfolio?wallet=" + encodeURIComponent(wallet) +
                                  "&fiat=" + encodeURIComponent(fiat) + cb);
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
    setWallet,           // exposed so wallet-picker.js can switch the active wallet
    shorten,
    bandFor,
  };
  window.userWallet = state.wallet;

  document.addEventListener("DOMContentLoaded", () => { bind(); renderWalletUI(); });
})();
