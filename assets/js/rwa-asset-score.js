/* DeFi Scoring – rwa-asset-score.js
 *
 * RWA Asset Risk Score — the "FICO for tokenized real-world assets".
 * Pulls live RWA protocol data from DeFiLlama, scans the connected wallet
 * for known RWA tokens (BUIDL, OUSG, USDY, etc.), and produces a 300–850
 * score + letter grade + risk tier with a transparent factor breakdown.
 *
 * Public API:
 *   window.DefiRWAScore.render()  -> Promise<void>
 *   window.DefiRWAScore.refresh() -> Promise<void>  (alias, force re-fetch)
 *
 * Renders into #rwa-score-container. Auto-refreshes on wallet change.
 * No wallet required for the "market view" — without a wallet we still show
 * the top RWA assets and a market-wide composite score so the page is useful.
 */
(function () {
  if (window.DefiRWAScore) return;

  // -------- Known RWA tokens (lowercase address -> meta) ----------------
  // Multi-chain. Used for wallet scanning. Easy to extend.
  const RWA_TOKENS = {
    "0x7712c34205737192402172409a8f7ccef8aa2aec": { symbol: "BUIDL", name: "BlackRock USD Institutional Digital Liquidity", issuer: "BlackRock / Securitize", category: "Tokenized Treasury", chain: "ethereum" },
    "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c": { symbol: "EURC",  name: "Euro Coin",                                       issuer: "Circle",                category: "Stablecoin",         chain: "ethereum" },
    "0x83f20f44975d03b1b09e64809b757c47f942beea": { symbol: "sDAI",  name: "Savings DAI",                                     issuer: "MakerDAO / Sky",        category: "Tokenized Treasury", chain: "ethereum" },
    "0x96f6ef951840721adbf46ac996b59e0235cb985c": { symbol: "USDY",  name: "Ondo USDY",                                       issuer: "Ondo Finance",          category: "Tokenized Treasury", chain: "ethereum" },
    "0x6c3f90f043a72fa612cbac8115ee7e52bde6e490": { symbol: "OUSG",  name: "Ondo Short-Term US Treasuries",                   issuer: "Ondo Finance",          category: "Tokenized Treasury", chain: "ethereum" },
    "0x0000206329b97db379d5e1bf586bbdb969c63274": { symbol: "USDA",  name: "USD.ai",                                          issuer: "Angle Labs",            category: "Stablecoin",         chain: "ethereum" },
    "0xdb25f211ab05b1c97d595516f45794528a807ad8": { symbol: "EURS",  name: "STASIS EURO",                                     issuer: "STASIS",                category: "Stablecoin",         chain: "ethereum" },
    "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd": { symbol: "sUSDS", name: "Sky Savings USDS",                                issuer: "Sky",                   category: "Tokenized Treasury", chain: "ethereum" },
  };

  // Friendly category weights (transparent + auditable).
  const CATEGORY_BOOST = {
    "Tokenized Treasury": 60,
    "Bond & MMF Funds":   60,
    "Stablecoin":         30,
    "Real Estate":        20,
    "Private Credit":     10,
    "Commodities":        10,
  };

  // Known reputable issuers — keeps this transparent rather than hand-wavy.
  const TRUSTED_ISSUERS = [
    "BlackRock", "Securitize", "Ondo", "Circle", "Maker", "Sky",
    "Franklin", "WisdomTree", "Hashnote", "Superstate", "Backed",
  ];

  let cache = null;        // { fetchedAt, protocols, walletAssets }
  let chartInstance = null;
  const CACHE_MS = 5 * 60 * 1000;

  // ---------------- helpers ---------------------------------------------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function fmtUsd(n) {
    if (n == null || isNaN(n)) return "—";
    if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
    return "$" + n.toFixed(2);
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }

  // ---------------- scoring engine --------------------------------------
  function scoreAsset(meta, marketTvl) {
    // Returns { score, grade, tier, factors[] }
    let score = 480; // baseline low so even top assets must earn the A+
    const factors = [];

    // 1. TVL / market depth — log-ish curve so a $3B asset scores higher
    //    than a $1B asset, but not infinitely.
    let tvlPts = 0;
    if (marketTvl >= 5e9)       tvlPts = 130;
    else if (marketTvl >= 2e9)  tvlPts = 115;
    else if (marketTvl >= 1e9)  tvlPts = 95;
    else if (marketTvl >= 5e8)  tvlPts = 75;
    else if (marketTvl >= 1e8)  tvlPts = 50;
    else if (marketTvl >= 1e7)  tvlPts = 25;
    else                        tvlPts = 5;
    score += tvlPts;
    factors.push({ label: "TVL & Liquidity", value: tvlPts, max: 130 });

    // 2. Issuer reputation — distinguish tier-1 (regulated giants) from
    //    tier-2 trusted (DeFi-native but reputable) from unknowns.
    const issuerStr = (meta.issuer || "").toLowerCase();
    const tier1 = ["blackrock", "franklin", "wisdomtree", "circle", "paxos"];
    const tier2 = ["ondo", "securitize", "hashnote", "superstate", "backed", "tether", "maker", "sky"];
    let issuerPts = 25;
    if (tier1.some((i) => issuerStr.includes(i)))      issuerPts = 90;
    else if (tier2.some((i) => issuerStr.includes(i))) issuerPts = 65;
    else if (TRUSTED_ISSUERS.some((i) => issuerStr.includes(i.toLowerCase()))) issuerPts = 50;
    score += issuerPts;
    factors.push({ label: "Issuer Strength", value: issuerPts, max: 90 });

    // 3. Category / asset class
    const catPts = CATEGORY_BOOST[meta.category] || 15;
    score += catPts;
    factors.push({ label: "Asset Class", value: catPts, max: 60 });

    // 4. Redemption / liquidity profile (heuristic by category for now)
    const redempPts = meta.category === "Tokenized Treasury" ? 50
                    : meta.category === "Bond & MMF Funds"   ? 45
                    : meta.category === "Stablecoin"         ? 40
                    : meta.category === "Commodities"        ? 30
                    : meta.category === "Real Estate"        ? 20
                    : meta.category === "Private Credit"     ? 15
                    :                                          20;
    score += redempPts;
    factors.push({ label: "Redemption Path", value: redempPts, max: 50 });

    // 5. Oracle / attestation integrity (placeholder — module 3 will replace
    //    this with live attestation feeds + chainlink PoR checks).
    const oraclePts = issuerPts >= 90 ? 35 : issuerPts >= 65 ? 25 : 12;
    score += oraclePts;
    factors.push({ label: "Oracle Integrity", value: oraclePts, max: 35 });

    score = Math.min(850, Math.max(300, Math.floor(score)));
    const grade = score >= 800 ? "A+"
                : score >= 750 ? "A"
                : score >= 700 ? "A-"
                : score >= 650 ? "B"
                : score >= 600 ? "B-"
                : score >= 550 ? "C"
                : score >= 500 ? "C-"
                :                "D";
    const tier  = score >= 750 ? "Low Risk"
                : score >= 650 ? "Moderate Risk"
                : score >= 550 ? "Elevated Risk"
                :                "High Risk";
    return { score, grade, tier, factors };
  }

  function gradeColor(score) {
    if (score >= 750) return "#2bd4a4";
    if (score >= 650) return "#5b8cff";
    if (score >= 550) return "#f5b042";
    return "#fc6464";
  }

  // ---------------- data fetch ------------------------------------------
  async function fetchRwaProtocols() {
    if (cache && (Date.now() - cache.fetchedAt) < CACHE_MS) return cache.protocols;
    const res = await fetch("https://api.llama.fi/protocols");
    if (!res.ok) throw new Error("DeFiLlama returned " + res.status);
    const all = await res.json();
    const rwa = all
      .filter((p) => {
        const cat = (p.category || "").toLowerCase();
        const name = (p.name || "").toLowerCase();
        return cat.includes("rwa")
            || cat.includes("treasury")
            || cat.includes("bond")
            || /(buidl|ondo|usdy|ousg|backed|hashnote|superstate|franklin|wisdomtree|maple|centrifuge|goldfinch)/.test(name);
      })
      .sort((a, b) => (b.tvl || 0) - (a.tvl || 0))
      .slice(0, 20);
    cache = { fetchedAt: Date.now(), protocols: rwa, walletAssets: cache && cache.walletAssets };
    return rwa;
  }

  async function scanWalletForRwa(addr) {
    // Best-effort wallet scan via the existing connected EIP-1193 provider.
    // Reads ERC-20 balanceOf for each known RWA address. Silent fail = empty.
    if (!addr) return [];
    const provider = (window.DefiWallet && window.DefiWallet.provider) || window.ethereum;
    if (!provider || !provider.request) return [];

    const out = [];
    const SELECTOR = "0x70a08231"; // balanceOf(address)
    const padded = addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    const data = SELECTOR + padded;

    for (const [tokenAddr, meta] of Object.entries(RWA_TOKENS)) {
      try {
        const hex = await provider.request({
          method: "eth_call",
          params: [{ to: tokenAddr, data }, "latest"],
        });
        if (hex && hex !== "0x" && /^0x0+$/.test(hex) === false) {
          // Non-zero balance. Decimals assumed 18 for display rough estimate;
          // the score doesn't actually need the precise amount.
          out.push({ address: tokenAddr, ...meta, rawBalance: hex });
        }
      } catch (_) { /* token not on this chain or RPC rejected — skip */ }
    }
    return out;
  }

  // ---------------- rendering -------------------------------------------
  function renderShell(container) {
    container.innerHTML = `
      <div class="defi-card" style="text-align:center;padding:36px 20px">
        <div class="defi-empty" style="border:none;padding:0">Loading live RWA market data…</div>
      </div>`;
  }

  function renderEmpty(container) {
    container.innerHTML = `
      <div class="defi-card" style="text-align:center;padding:30px 20px">
        <div style="font-size:13px;color:var(--defi-text-dim)">
          Live RWA market data is shown below. Connect a wallet to also scan your
          holdings (BUIDL, OUSG, USDY, sDAI, etc.) for a personalized RWA score.
        </div>
      </div>`;
  }

  function buildHtml(payload) {
    const { wallet, scored, walletAssets, totalTvl } = payload;
    const color = gradeColor(scored.score);

    const factorsHtml = scored.factors.map((f) => {
      const pct = Math.round((f.value / f.max) * 100);
      return `
        <div style="margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--defi-text-dim);margin-bottom:4px">
            <span>${esc(f.label)}</span>
            <span>${f.value}/${f.max}</span>
          </div>
          <div style="height:6px;background:rgba(148,163,184,.15);border-radius:999px;overflow:hidden">
            <div style="height:100%;width:${pct}%;background:${color};border-radius:999px"></div>
          </div>
        </div>`;
    }).join("");

    const walletBadge = wallet
      ? `<span class="defi-chip" style="background:rgba(43,212,164,.12);color:#2bd4a4;border-color:rgba(43,212,164,.3)">Wallet scanned</span>`
      : `<span class="defi-chip">Market view (no wallet)</span>`;

    const walletAssetsHtml = walletAssets && walletAssets.length
      ? `<div style="margin-top:12px">
           <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--defi-text-dim);margin-bottom:8px">RWA tokens detected in your wallet</div>
           <div style="display:flex;flex-wrap:wrap;gap:6px">
             ${walletAssets.map((a) => `<span class="defi-chip">${esc(a.symbol)} · ${esc(a.issuer)}</span>`).join("")}
           </div>
         </div>`
      : (wallet
          ? `<div style="margin-top:12px;font-size:12px;color:var(--defi-text-dim)">No known RWA tokens detected in this wallet on Phase&nbsp;1 chains. Score is based on the market-leading asset.</div>`
          : "");

    return `
      <div class="defi-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px;margin-bottom:18px">
        <div class="defi-card" style="text-align:center">
          <div class="defi-card__title" style="display:flex;justify-content:space-between;align-items:center">
            <span>RWA Asset Risk Score</span>
            <button id="rwa-refresh-btn" class="defi-btn defi-btn--ghost" type="button" style="font-size:12px;padding:4px 10px">Refresh</button>
          </div>
          <div style="font-size:64px;font-weight:800;line-height:1;color:${color};margin-top:18px">${scored.score}</div>
          <div style="font-size:28px;font-weight:700;margin-top:4px">${scored.grade}</div>
          <div style="display:inline-block;margin-top:14px;padding:6px 14px;border-radius:999px;font-size:13px;font-weight:600;background:${color}22;color:${color}">${scored.tier}</div>
          <div style="margin-top:18px;display:flex;gap:6px;justify-content:center;flex-wrap:wrap">${walletBadge}</div>
          ${walletAssetsHtml}
        </div>

        <div class="defi-card">
          <div class="defi-card__title">Score breakdown</div>
          <div style="margin-top:14px">${factorsHtml}</div>
          <div style="margin-top:14px;font-size:11px;color:var(--defi-text-dim);line-height:1.5">
            Range 300–850. Factor weights derived from TVL, issuer reputation, asset class,
            redemption path, and oracle integrity. Full methodology in /methodology/.
          </div>
        </div>

        <div class="defi-card">
          <div class="defi-card__title">Top RWA market data</div>
          <div style="height:200px;margin-top:10px"><canvas id="rwa-market-chart"></canvas></div>
          <div style="margin-top:12px;font-size:12px;color:var(--defi-text-dim)">
            Total RWA TVL across tracked protocols: <strong style="color:var(--defi-text)">${fmtUsd(totalTvl)}</strong>
          </div>
        </div>
      </div>

      <div class="defi-card">
        <div class="defi-card__title">Top tokenized RWA protocols (live · DeFiLlama)</div>
        <div id="rwa-protocols-list" style="margin-top:12px"></div>
      </div>`;
  }

  function renderProtocolsList(host, protocols) {
    if (!protocols.length) { host.innerHTML = `<div class="defi-empty">No RWA protocols returned.</div>`; return; }
    host.innerHTML = `
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead>
            <tr style="text-align:left;color:var(--defi-text-dim);font-size:11px;text-transform:uppercase;letter-spacing:.06em">
              <th style="padding:8px 10px;border-bottom:1px solid rgba(148,163,184,.15)">Protocol</th>
              <th style="padding:8px 10px;border-bottom:1px solid rgba(148,163,184,.15)">Category</th>
              <th style="padding:8px 10px;border-bottom:1px solid rgba(148,163,184,.15);text-align:right">TVL</th>
              <th style="padding:8px 10px;border-bottom:1px solid rgba(148,163,184,.15);text-align:right">Risk Score</th>
            </tr>
          </thead>
          <tbody>
            ${protocols.slice(0, 10).map((p) => {
              const meta = {
                issuer: p.name,
                category: /treasury|bond|mmf/i.test(p.category || p.name) ? "Tokenized Treasury"
                        : /stable/i.test(p.category || p.name)            ? "Stablecoin"
                        : /credit/i.test(p.category || p.name)            ? "Private Credit"
                        : /real estate/i.test(p.category || p.name)       ? "Real Estate"
                        :                                                   "Tokenized Treasury",
              };
              const s = scoreAsset(meta, p.tvl || 0);
              const c = gradeColor(s.score);
              return `
                <tr>
                  <td style="padding:10px;border-bottom:1px solid rgba(148,163,184,.08);font-weight:600">${esc(p.name)}</td>
                  <td style="padding:10px;border-bottom:1px solid rgba(148,163,184,.08);color:var(--defi-text-dim)">${esc(p.category || meta.category)}</td>
                  <td style="padding:10px;border-bottom:1px solid rgba(148,163,184,.08);text-align:right">${fmtUsd(p.tvl || 0)}</td>
                  <td style="padding:10px;border-bottom:1px solid rgba(148,163,184,.08);text-align:right;color:${c};font-weight:700">${s.score} · ${s.grade}</td>
                </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>`;
  }

  function renderMarketChart(protocols) {
    const canvas = document.getElementById("rwa-market-chart");
    if (!canvas || typeof Chart === "undefined") return;
    if (chartInstance) { try { chartInstance.destroy(); } catch (_) {} chartInstance = null; }
    const top = protocols.slice(0, 6);
    chartInstance = new Chart(canvas, {
      type: "bar",
      data: {
        labels: top.map((p) => p.name),
        datasets: [{
          label: "TVL (USD)",
          data: top.map((p) => p.tvl || 0),
          backgroundColor: "#5b8cff",
          borderRadius: 6,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: "#94a3b8", font: { size: 10 }, maxRotation: 35, minRotation: 0 }, grid: { display: false } },
          y: { ticks: { color: "#94a3b8", font: { size: 10 }, callback: (v) => fmtUsd(v) }, grid: { color: "rgba(148,163,184,.08)" } },
        },
      },
    });
  }

  // ---------------- public render ---------------------------------------
  let inflight = null;

  async function render(force) {
    const container = document.getElementById("rwa-score-container");
    if (!container) return;

    if (inflight) return inflight;
    if (force) cache = null;

    renderShell(container);

    inflight = (async () => {
      try {
        const wallet = (window.DefiWallet && window.DefiWallet.address) || window.userWallet || null;
        const [protocols, walletAssets] = await Promise.all([
          fetchRwaProtocols(),
          scanWalletForRwa(wallet),
        ]);

        const totalTvl = protocols.reduce((s, p) => s + (p.tvl || 0), 0);

        // Pick the asset to score: user's largest detected RWA, else market leader.
        let primary;
        if (walletAssets.length) {
          const top = walletAssets[0];
          primary = { issuer: top.issuer, category: top.category, name: top.name };
        } else {
          const top = protocols[0] || { name: "BlackRock BUIDL", tvl: 3e9, category: "Tokenized Treasury" };
          primary = {
            issuer: /blackrock/i.test(top.name) ? "BlackRock / Securitize"
                  : /ondo/i.test(top.name)      ? "Ondo Finance"
                  : top.name,
            category: top.category && CATEGORY_BOOST[top.category] ? top.category : "Tokenized Treasury",
            name: top.name,
          };
        }
        const tvlForScore = walletAssets.length
          ? (protocols.find((p) => new RegExp(walletAssets[0].issuer.split(/[ /]/)[0], "i").test(p.name)) || {}).tvl || totalTvl
          : (protocols[0] && protocols[0].tvl) || 0;

        const scored = scoreAsset(primary, tvlForScore);

        container.innerHTML = buildHtml({ wallet, scored, walletAssets, totalTvl });
        const refreshBtn = document.getElementById("rwa-refresh-btn");
        if (refreshBtn) refreshBtn.addEventListener("click", () => render(true));
        renderMarketChart(protocols);
        const list = document.getElementById("rwa-protocols-list");
        if (list) renderProtocolsList(list, protocols);
      } catch (err) {
        console.warn("[rwa-asset-score] render failed:", err);
        container.innerHTML = `
          <div class="defi-card" style="text-align:center;padding:30px 20px">
            <div style="color:#fca5a5;font-size:14px">Could not load RWA data right now.</div>
            <div style="font-size:12px;color:var(--defi-text-dim);margin-top:8px">${esc(err && err.message || String(err))}</div>
            <button class="defi-btn defi-btn--ghost" type="button" style="margin-top:14px" onclick="window.DefiRWAScore.refresh()">Try again</button>
          </div>`;
      } finally {
        inflight = null;
      }
    })();

    return inflight;
  }

  // ---------------- bootstrap -------------------------------------------
  function init() {
    if (!document.getElementById("rwa-score-container")) return;
    render(false);
    // Re-render when the wallet changes.
    if (window.DefiWallet && typeof window.DefiWallet.on === "function") {
      window.DefiWallet.on("change", () => render(true));
    }
  }

  window.DefiRWAScore = { render: () => render(false), refresh: () => render(true) };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
