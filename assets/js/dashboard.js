/* DeFi Scoring – shared dashboard JS
 * Wallet connect (EIP-1193) + DefiAPI client backed by REAL on-chain reads
 * via window.DefiOnchain. No fabricated values.
 *
 * API base: the Worker serves this site AND its /api/* routes from one origin
 * (wrangler.jsonc — assets.directory + run_worker_first), so the default ""
 * is the SAME ORIGIN, not "no backend". A relative /api/... reaches the
 * worker; dashboard-watchlist.js and quota-widget.js have always relied on
 * that. Setting window.DEFI_API_BASE points the client at a different origin
 * instead (local wrangler dev, a preview deployment).
 *
 * This distinction is load-bearing. Guards of the form `if (API_BASE)` read
 * the default "" as "no backend configured" and silently routed every score,
 * portfolio and alert read to the client-side fallback — so the dashboard
 * rendered DefiOnchain.preliminaryScore()'s six-factor approximation instead
 * of the worker's five-pillar model, and coverage, per-pillar rationales and
 * the adjustments ledger never reached the UI at all. Do not reintroduce a
 * truthiness check on API_BASE.
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

  // The 300–850 → label mapping lives in assets/js/score-bands.js, the browser
  // mirror of worker/lib/score.js's BANDS. It used to be copied inline here
  // and drifted: this bandFor read 750/670/580 while the backend and the badge
  // read 720/660/580, so one wallet could show "Excellent" here and "Good" on
  // its own badge. There is still no bundler to import across the
  // server/browser boundary, so the copy is structural — what is new is that
  // test/facts.mjs loads both halves and fails the build if they disagree
  // about any score from 300 to 850.
  //
  // Kept as a named function, and still exported on DefiState below, because
  // several dashboard-*.js files call DefiState.bandFor and none of them
  // should have to care where the table moved to.
  function bandFor(score) {
    return window.DefiBands.labelFor(score);
  }

  // Map the /api/wallet-score payload (5 pillars, weights 35/25/15/10/15)
  // into the factor shape every dashboard renderer consumes. Carries the
  // `scored:false` state through untouched so the UI can render an honest
  // "no history yet" instead of a number.
  function mapWalletScore(wallet, data) {
    const p = data.pillars || {};
    const pct = (pl) => (pl && pl.value != null) ? Math.max(0, Math.min(100, Math.round(pl.value))) : null;
    const mk = (pl, name, short) => ({
      name,
      short: short || name,
      value: pct(pl),
      weight: pl && pl.weight != null ? Math.round(pl.weight * 100) : 0,
      real: pl ? pl.real !== false : false,
      detail: pl && (pl.rationale || pl.finding) || "",
    });
    // The parenthetical names the pillar's live sources, so it has to track
    // what the worker actually reads: loan reliability gained Spark and Morpho
    // Blue, account age went multichain in 2026.09, and liquidity provision
    // moved from counting positions to valuing them in 2026.10.
    //
    // The leading phrase before " (" is also the lookup key into
    // score-breakdown.js's EXPLAIN_TEMPLATES — keep it exactly equal to a
    // template key or the factor modal falls back to generic copy.
    const factors = [
      mk(p.loan_reliability,    "Loan reliability (Aave V3, Spark, Compound V3, Morpho Blue)", "loan reliability"),
      mk(p.portfolio_health,    "Portfolio health (size + diversification)",                   "portfolio health"),
      mk(p.liquidity_provision, "Liquidity provision (Uniswap V3 LP, valued in USD)",          "liquidity provision"),
      mk(p.governance,          "Governance (Snapshot)",                                       "governance"),
      mk(p.account_age,         "Account age (oldest first tx across scored chains)",          "account age"),
    ];
    // How much of the score rests on observed data. The worker sends this,
    // but derive it from the factor weights when it's absent so an older
    // worker (or the legacy endpoint) still gets an honest badge instead of
    // silently claiming full coverage.
    const coverage = typeof data.coverage === "number"
      ? data.coverage
      : factors.reduce(function (sum, f) { return sum + (f.real ? f.weight : 0); }, 0) / 100;
    const estimated = factors.filter(function (f) { return !f.real; });
    // Keep the adjustments as structured {name, delta, reason} rows. They used
    // to be flattened into the notice string here, which meant the ledger — the
    // step from the weighted pillar score to the final number, including the
    // −150 liquidation penalty — could never be rendered as anything but prose.
    const adjustments = (Array.isArray(data.adjustments) ? data.adjustments : [])
      .map(function (a) {
        if (typeof a === "string") return { name: a, delta: null, reason: a };
        return { name: a.name || "", delta: typeof a.delta === "number" ? a.delta : null, reason: a.reason || "" };
      });
    const notes = [];
    if (adjustments.length) {
      notes.push("Adjustments: " + adjustments.map(function (a) {
        return (a.delta == null ? "" : (a.delta > 0 ? "+" : "") + a.delta + " ") + (a.reason || a.name);
      }).join("; "));
    }
    if (data.scored === false && data.explanation) notes.push(data.explanation);
    // Name what was estimated rather than only showing a percentage — "72%
    // live data" doesn't tell anyone which part of their score is a guess.
    if (data.scored !== false && estimated.length) {
      notes.push(
        "Estimated (no data found): " +
        estimated.map(function (f) { return f.short; }).join(", ") +
        ". These fall back to a neutral score and are not counted as live data.");
    }
    return {
      wallet,
      scored: data.scored !== false,
      score: data.score,
      band: data.scored === false ? window.DefiBands.UNKNOWN.label : bandFor(data.score),
      coverage: coverage,
      reason: data.reason || null,
      explanation: data.explanation || null,
      preliminary: false,
      // A score is only comparable to another from the same model version, so
      // the version travels with the score rather than being dropped here.
      model: data.model || null,
      raw_h_s: typeof data.raw_h_s === "number" ? data.raw_h_s : null,
      adjustments,
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
      // Fallback #2: legacy Ethereum-only health-score endpoint.
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

  // Shared so the home and score dashboards phrase and colour coverage the
  // same way. Returns null when there is nothing honest to say — an unknown
  // coverage must not render as "0% live data".
  function coverageLabel(coverage) {
    if (typeof coverage !== "number" || !isFinite(coverage)) return null;
    const pct = Math.round(Math.max(0, Math.min(1, coverage)) * 100);
    return {
      pct: pct,
      text: "Score based on " + pct + "% live data",
      // Amber is a warning, so it is reserved for genuinely thin coverage;
      // anything above the threshold is informational and stays dimmed.
      color: pct < 60 ? "#facc15" : "var(--defi-text-dim, #8b8b99)",
      low: pct < 60,
    };
  }

  window.DefiState = {
    get wallet() { return state.wallet; },
    setWallet,           // exposed so wallet-picker.js can switch the active wallet
    shorten,
    bandFor,
    coverageLabel,
  };
  window.userWallet = state.wallet;

  document.addEventListener("DOMContentLoaded", () => { bind(); renderWalletUI(); });
})();
