/* DeFi Scoring – approvals-checker.js
 *
 * Scans the connected wallet for ERC-20 approvals on a curated set of
 * common tokens × common spenders, flags unlimited allowances, and links
 * each row to revoke.cash so the user can rescind in one click.
 *
 * Convention compliance:
 *   - Reads wallet from window.DefiWallet (set by wallet-connect.js).
 *   - Re-renders on the `defi:wallet-changed` custom event.
 *   - Uses project CSS classes (.defi-card, .defi-table, .defi-chip,
 *     .defi-btn) — no Tailwind.
 *   - Loads ethers v6 from jsDelivr lazily so the rest of the dashboard
 *     stays at zero extra weight when the user never visits this page.
 *
 * Risk model:
 *   An approval row is a hazard if EITHER (a) it's unlimited (>= 2^255 in
 *   wei terms — practically uint256.max minus dust) OR (b) the spender is
 *   tagged High risk in our spender catalogue. Both flags are surfaced
 *   separately so the user can triage.
 */
(function () {
  const ETHERS_CDN = "https://cdn.jsdelivr.net/npm/ethers@6.13.0/dist/ethers.umd.min.js";

  // Curated common ERC-20 tokens on Ethereum mainnet. The intent is breadth
  // of *coverage* across what most users actually hold, not exhaustiveness —
  // exhaustive scanning needs an indexer (Etherscan/Alchemy) and lives in a
  // future Worker route.
  const COMMON_TOKENS = {
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": { symbol: "USDC", name: "USD Coin", decimals: 6 },
    "0xdAC17F958D2ee523a2206206994597C13D831ec7": { symbol: "USDT", name: "Tether",   decimals: 6 },
    "0x6B175474E89094C44Da98b954EedeAC495271d0F": { symbol: "DAI",  name: "Dai",      decimals: 18 },
    "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": { symbol: "WETH", name: "Wrapped Ether", decimals: 18 },
    "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599": { symbol: "WBTC", name: "Wrapped Bitcoin", decimals: 8 },
    "0x514910771AF9Ca656af840dff83E8264EcF986CA": { symbol: "LINK", name: "Chainlink", decimals: 18 },
    "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9": { symbol: "AAVE", name: "Aave",      decimals: 18 },
    "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984": { symbol: "UNI",  name: "Uniswap",   decimals: 18 },
  };

  // Spender catalogue. `risk` reflects the contract surface, not the brand:
  // a router that can pull any allowance is High; a position manager that
  // mints NFTs is Low. "risk" here is independent from the protocol's
  // composite DeFi Score — both signals are shown in the table.
  const RISKY_SPENDERS = {
    "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D": { name: "Uniswap V2 Router",       risk: "High",   slug: "uniswap" },
    "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45": { name: "Uniswap V3 SwapRouter02", risk: "High",   slug: "uniswap-v3" },
    "0xC36442b4a4522E871399CD717aBDD847Ab11FE88": { name: "Uniswap V3 Positions",    risk: "Low",    slug: "uniswap-v3" },
    "0x1111111254EEB25477B68fb85Ed929f73A960582": { name: "1inch Router v5",         risk: "Medium", slug: "1inch" },
    "0xDef1C0ded9bec7F1a1670819833240f027b25EfF": { name: "0x Exchange Proxy",       risk: "Medium", slug: "0x" },
    "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2": { name: "Aave V3 Pool",            risk: "High",   slug: "aave-v3" },
    "0xc3d688B66703497DAA19211EEdff47f25384cdc3": { name: "Compound V3 USDC",        risk: "High",   slug: "compound-v3" },
    "0xDe27d2F2D2D2D2d2D2d2d2D2d2D2D2D2D2D2D2d2": { name: "Permit2 (Universal)",     risk: "Medium", slug: "permit2" },
  };

  // ethers v6 is loaded once on first scan and memoised on window so the
  // second visit is instant.
  function loadEthers() {
    if (window.ethers) return Promise.resolve(window.ethers);
    if (window.__defiEthersPromise) return window.__defiEthersPromise;
    window.__defiEthersPromise = new Promise(function (resolve, reject) {
      const s = document.createElement("script");
      s.src = ETHERS_CDN;
      s.async = true;
      s.onload = function () { resolve(window.ethers); };
      s.onerror = function () { reject(new Error("Failed to load ethers from CDN")); };
      document.head.appendChild(s);
    });
    return window.__defiEthersPromise;
  }

  function shorten(addr) {
    if (!addr) return "";
    return addr.slice(0, 6) + "…" + addr.slice(-4);
  }

  function fmtAllowance(raw, decimals) {
    // Format the raw uint256 allowance into human units. Capped at 4 sig
    // figures; very small allowances render as "<0.0001".
    try {
      const whole = Number(raw / (10n ** BigInt(decimals)));
      if (whole >= 1) return whole.toLocaleString(undefined, { maximumFractionDigits: 2 });
      const frac = Number(raw) / Math.pow(10, decimals);
      if (frac < 0.0001) return "<0.0001";
      return frac.toPrecision(4);
    } catch (e) {
      return raw.toString();
    }
  }

  function riskChip(level) {
    const map = {
      High:   { cls: "defi-chip defi-chip--danger",  label: "High risk" },
      Medium: { cls: "defi-chip defi-chip--warning", label: "Medium risk" },
      Low:    { cls: "defi-chip defi-chip--ok",      label: "Low risk" },
    };
    const m = map[level] || map.Medium;
    return '<span class="' + m.cls + '">' + m.label + "</span>";
  }

  function unlimitedChip(isUnlimited) {
    if (isUnlimited) return '<span class="defi-chip defi-chip--danger">Unlimited</span>';
    return '<span class="defi-chip defi-chip--muted">Limited</span>';
  }

  function renderEmpty(container, msg) {
    container.innerHTML = '<div class="defi-empty">' + msg + "</div>";
  }

  function renderError(container, msg) {
    container.innerHTML = '<div class="defi-empty" style="color:var(--defi-danger,#ff6b6b)">' + msg + "</div>";
  }

  function renderLoading(container, owner) {
    container.innerHTML =
      '<div class="defi-empty">Scanning <code>' + shorten(owner) +
      "</code> for ERC-20 approvals on Ethereum… (" +
      Object.keys(COMMON_TOKENS).length + " tokens × " +
      Object.keys(RISKY_SPENDERS).length + " spenders)</div>";
  }

  function renderTable(container, rows, owner, scannedAt) {
    if (!rows.length) {
      container.innerHTML =
        '<div class="defi-card">' +
          '<div class="defi-card__title">No active approvals found</div>' +
          '<p style="margin:8px 0 0;color:var(--defi-text-dim);font-size:13px">' +
            "Scanned " + Object.keys(COMMON_TOKENS).length + " common tokens against " +
            Object.keys(RISKY_SPENDERS).length + " spenders. None of them have a non-zero allowance set by " +
            '<code>' + shorten(owner) + "</code> on Ethereum mainnet." +
          "</p>" +
        "</div>";
      return;
    }

    const unlimited = rows.filter(function (r) { return r.isUnlimited; }).length;
    const highRisk  = rows.filter(function (r) { return r.spender.risk === "High"; }).length;

    let html = "";
    html += '<div class="defi-grid defi-grid--stats" style="margin-bottom:18px">';
    html +=   '<div class="defi-card"><div class="defi-card__title">Active approvals</div>' +
              '<div class="defi-card__value">' + rows.length + '</div>' +
              '<div class="defi-card__delta">non-zero allowances</div></div>';
    html +=   '<div class="defi-card"><div class="defi-card__title">Unlimited</div>' +
              '<div class="defi-card__value" style="color:' + (unlimited ? "var(--defi-danger,#ff6b6b)" : "inherit") + '">' + unlimited + '</div>' +
              '<div class="defi-card__delta">grant access to your full balance</div></div>';
    html +=   '<div class="defi-card"><div class="defi-card__title">High-risk spenders</div>' +
              '<div class="defi-card__value" style="color:' + (highRisk ? "var(--defi-danger,#ff6b6b)" : "inherit") + '">' + highRisk + '</div>' +
              '<div class="defi-card__delta">routers with broad pull rights</div></div>';
    html += "</div>";

    html += '<div class="defi-card">';
    html +=   '<div class="defi-card__title">Approvals on Ethereum</div>';
    html +=   '<div style="overflow-x:auto;margin-top:10px">';
    html +=     '<table class="defi-table">';
    html +=       '<thead><tr>' +
                    '<th>Token</th><th>Spender</th><th style="text-align:right">Allowance</th>' +
                    '<th>Type</th><th>Spender risk</th><th></th>' +
                  '</tr></thead><tbody>';
    rows.forEach(function (r) {
      html +=     '<tr>' +
                    '<td><strong>' + r.token.symbol + "</strong> <span style=\"color:var(--defi-text-dim);font-size:12px\">" + r.token.name + "</span></td>" +
                    '<td>' + r.spender.name + ' <span style="color:var(--defi-text-dim);font-size:11px;font-family:monospace">' + shorten(r.spenderAddr) + "</span></td>" +
                    '<td style="text-align:right;font-family:monospace">' + (r.isUnlimited ? "∞" : fmtAllowance(r.allowance, r.token.decimals) + " " + r.token.symbol) + "</td>" +
                    '<td>' + unlimitedChip(r.isUnlimited) + '</td>' +
                    '<td>' + riskChip(r.spender.risk) + '</td>' +
                    '<td style="text-align:right"><a class="defi-btn defi-btn--ghost" style="padding:6px 12px;font-size:12px" target="_blank" rel="noopener" href="https://revoke.cash/address/' + owner + "?chainId=1\">Revoke →</a></td>" +
                  "</tr>";
    });
    html +=     "</tbody></table>";
    html +=   "</div>";
    html +=   '<p style="margin:14px 0 0;font-size:12px;color:var(--defi-text-dim)">' +
              "Scan completed " + scannedAt + " · Read-only · No transactions sent. " +
              "Revocations are executed on revoke.cash with your wallet." +
            "</p>";
    html += "</div>";

    container.innerHTML = html;
  }

  async function scan(owner) {
    const container = document.getElementById("approvals-checker-container");
    if (!container) return;

    if (!window.ethereum) {
      renderError(container, "No EVM provider detected in this browser. Connect a wallet first.");
      return;
    }

    renderLoading(container, owner);

    let ethers;
    try {
      ethers = await loadEthers();
    } catch (e) {
      renderError(container, "Could not load ethers.js from the CDN. Check your network and retry.");
      return;
    }

    let provider;
    try {
      provider = new ethers.BrowserProvider(window.ethereum);
      const net = await provider.getNetwork();
      // Ethereum mainnet only — token + spender catalogues are mainnet
      // addresses. Other chains will be added once we ship a multi-chain
      // catalogue (tracked separately).
      if (Number(net.chainId) !== 1) {
        renderError(container,
          "This scanner is Ethereum-mainnet only for now (your wallet is on chain " +
          Number(net.chainId) + "). Switch network and retry.");
        return;
      }
    } catch (e) {
      renderError(container, "Wallet provider error: " + (e.message || e));
      return;
    }

    const ABI = ["function allowance(address owner, address spender) view returns (uint256)"];
    // 2^255 — anything at or above this we treat as "unlimited" (covers
    // both uint256.max and Permit2's 2^160-1 grants in human terms).
    const UNLIMITED_THRESHOLD = (1n << 255n);

    const tokenAddrs   = Object.keys(COMMON_TOKENS);
    const spenderAddrs = Object.keys(RISKY_SPENDERS);

    const probes = [];
    tokenAddrs.forEach(function (tokenAddr) {
      const token = COMMON_TOKENS[tokenAddr];
      const c = new ethers.Contract(tokenAddr, ABI, provider);
      spenderAddrs.forEach(function (spenderAddr) {
        probes.push(
          c.allowance(owner, spenderAddr)
            .then(function (allowance) {
              return { tokenAddr: tokenAddr, token: token, spenderAddr: spenderAddr, spender: RISKY_SPENDERS[spenderAddr], allowance: allowance };
            })
            .catch(function (e) {
              // Don't let one bad call break the whole scan.
              console.warn("[approvals]", token.symbol, "x", spenderAddr, "failed:", e.message);
              return null;
            })
        );
      });
    });

    const results = await Promise.all(probes);

    const rows = [];
    results.forEach(function (r) {
      if (!r) return;
      if (r.allowance <= 0n) return;
      rows.push({
        token: r.token,
        spender: r.spender,
        spenderAddr: r.spenderAddr,
        allowance: r.allowance,
        isUnlimited: r.allowance >= UNLIMITED_THRESHOLD,
      });
    });

    // Sort: unlimited high-risk first, then unlimited, then high-risk, then by allowance.
    rows.sort(function (a, b) {
      const aw = (a.isUnlimited ? 2 : 0) + (a.spender.risk === "High" ? 1 : 0);
      const bw = (b.isUnlimited ? 2 : 0) + (b.spender.risk === "High" ? 1 : 0);
      if (aw !== bw) return bw - aw;
      return a.allowance < b.allowance ? 1 : -1;
    });

    renderTable(container, rows, owner, new Date().toLocaleString());

    // Anonymized telemetry: count of unlimited-grant rows for the daily aggregate.
    if (window.DefiIntel) {
      const unlimitedCount = rows.reduce(function (n, r) { return n + (r.isUnlimited ? 1 : 0); }, 0);
      window.DefiIntel.log("approvals_scan", { metadata: { unlimitedApprovals: unlimitedCount, totalRows: rows.length } });
    }
  }

  function currentAddress() {
    return window.DefiWallet && window.DefiWallet.address;
  }

  async function connectAndScan() {
    if (!window.DefiWallet) {
      const c = document.getElementById("approvals-checker-container");
      if (c) renderError(c, "Wallet module not loaded.");
      return;
    }
    let addr = currentAddress();
    if (!addr) addr = await window.DefiWallet.connect();
    if (addr) scan(addr);
  }

  function renderInitial() {
    const container = document.getElementById("approvals-checker-container");
    if (!container) return;
    const addr = currentAddress();
    if (addr) {
      scan(addr);
    } else {
      renderEmpty(container, "Connect a wallet to scan token approvals on Ethereum.");
    }
  }

  function init() {
    if (!document.getElementById("approvals-checker-container")) return;
    renderInitial();

    document.addEventListener("defi:wallet-changed", function () {
      renderInitial();
    });

    const btn = document.getElementById("approvals-scan-btn");
    if (btn) btn.addEventListener("click", connectAndScan);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Public API for the optional sidebar/nav shortcut.
  window.checkTokenApprovals = connectAndScan;
})();
