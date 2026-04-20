/* DeFi Scoring – approvals-checker.js
 *
 * Scans the connected wallet for ERC-20 approvals on the wallet's CURRENT
 * network, flags unlimited allowances and high-risk spenders, and links
 * each row to revoke.cash for one-click revocation.
 *
 * Design:
 *   - Coverage comes from `eth_getLogs` over the wallet's recent history
 *     (Approval event topic), not from a hardcoded token × spender matrix.
 *     This means a wallet that approved a niche token on a SushiSwap fork
 *     still surfaces here.
 *   - Multi-chain: Ethereum mainnet (1), Polygon (137), Arbitrum One
 *     (42161). The wallet's chainId picks the catalogue and the revoke.cash
 *     deep link.
 *   - Token metadata (symbol, name, decimals) is fetched on-demand per
 *     unique token contract, in parallel.
 *   - Known spenders are tagged with a brand name + heuristic risk; unknown
 *     spenders show as "Unknown contract" with Medium-risk treatment so
 *     they're never silently buried.
 *
 * Conventions:
 *   - Reads wallet from window.DefiWallet, re-renders on
 *     `defi:wallet-changed`. Uses project CSS classes (no Tailwind).
 *   - ethers v6 is loaded lazily from jsDelivr.
 */
(function () {
  const ETHERS_CDN = "https://cdn.jsdelivr.net/npm/ethers@6.13.0/dist/ethers.umd.min.js";

  /* --------------------------------------------------------------------- */
  /* Per-chain configuration                                               */
  /* --------------------------------------------------------------------- */

  // Lookback windows are tuned per chain so each scan stays under the
  // typical public-RPC range cap (~10k blocks per call) while still covering
  // a few days of activity. Users can rescan to refresh.
  //
  //   ETH:      ~12s/block ·  90k blocks  ≈ 12 days
  //   Polygon:  ~2.2s/block · 200k blocks ≈ 5 days
  //   Arbitrum: ~0.25s/block · 500k blocks ≈ 35 hours
  //
  // chunkSize is the per-`eth_getLogs` block window. chunks * chunkSize is
  // the total lookback.
  const CHAIN_CONFIG = {
    1: {
      name: "Ethereum mainnet",
      revokeId: 1,
      chunkSize: 9000,
      chunks: 10,
    },
    137: {
      name: "Polygon",
      revokeId: 137,
      chunkSize: 9000,
      chunks: 22,
    },
    42161: {
      name: "Arbitrum One",
      revokeId: 42161,
      chunkSize: 9000,
      chunks: 56,
    },
  };

  // Known router / pool / aggregator addresses per chain. Anything not in
  // this catalogue still renders, just tagged "Unknown contract · Medium
  // risk". Addresses are checksummed lower-cased on lookup.
  const KNOWN_SPENDERS = {
    1: {
      "0x7a250d5630b4cf539739df2c5dacb4c659f2488d": { name: "Uniswap V2 Router",       risk: "High"   },
      "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45": { name: "Uniswap V3 SwapRouter02", risk: "High"   },
      "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad": { name: "Uniswap Universal Router", risk: "High" },
      "0xc36442b4a4522e871399cd717abdd847ab11fe88": { name: "Uniswap V3 Positions",    risk: "Low"    },
      "0x1111111254eeb25477b68fb85ed929f73a960582": { name: "1inch Router v5",         risk: "Medium" },
      "0xdef1c0ded9bec7f1a1670819833240f027b25eff": { name: "0x Exchange Proxy",       risk: "Medium" },
      "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2": { name: "Aave V3 Pool",            risk: "High"   },
      "0xc3d688b66703497daa19211eedff47f25384cdc3": { name: "Compound V3 USDC",        risk: "High"   },
      "0x000000000022d473030f116ddee9f6b43ac78ba3": { name: "Permit2",                 risk: "Medium" },
      "0x9008d19f58aabd9ed0d60971565aa8510560ab41": { name: "CowSwap GPv2 Settlement", risk: "Medium" },
      "0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f": { name: "SushiSwap Router",        risk: "High"   },
      "0xe592427a0aece92de3edee1f18e0157c05861564": { name: "Uniswap V3 SwapRouter",   risk: "High"   },
    },
    137: {
      "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45": { name: "Uniswap V3 SwapRouter02", risk: "High"   },
      "0xec7be89e9d109e7e3fec59c222cf297125fefda2": { name: "Uniswap Universal Router (Polygon)", risk: "High" },
      "0xc36442b4a4522e871399cd717abdd847ab11fe88": { name: "Uniswap V3 Positions",    risk: "Low"    },
      "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff": { name: "QuickSwap V2 Router",     risk: "High"   },
      "0x1111111254eeb25477b68fb85ed929f73a960582": { name: "1inch Router v5",         risk: "Medium" },
      "0xdef1c0ded9bec7f1a1670819833240f027b25eff": { name: "0x Exchange Proxy",       risk: "Medium" },
      "0x794a61358d6845594f94dc1db02a252b5b4814ad": { name: "Aave V3 Pool",            risk: "High"   },
      "0x000000000022d473030f116ddee9f6b43ac78ba3": { name: "Permit2",                 risk: "Medium" },
    },
    42161: {
      "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45": { name: "Uniswap V3 SwapRouter02", risk: "High"   },
      "0x5e325eda8064b456f4781070c0738d849c824258": { name: "Uniswap Universal Router (Arbitrum)", risk: "High" },
      "0xc36442b4a4522e871399cd717abdd847ab11fe88": { name: "Uniswap V3 Positions",    risk: "Low"    },
      "0x1111111254eeb25477b68fb85ed929f73a960582": { name: "1inch Router v5",         risk: "Medium" },
      "0x794a61358d6845594f94dc1db02a252b5b4814ad": { name: "Aave V3 Pool",            risk: "High"   },
      "0x000000000022d473030f116ddee9f6b43ac78ba3": { name: "Permit2",                 risk: "Medium" },
      "0xc873fecbd354f5a56e00e710b90ef4201db2448d": { name: "Camelot Router",          risk: "High"   },
      "0xabbc5f99639c9b6bcb58544ddf04efa6802f4064": { name: "GMX Router",              risk: "High"   },
    },
  };

  /* --------------------------------------------------------------------- */
  /* Lazy ethers loader                                                    */
  /* --------------------------------------------------------------------- */

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

  /* --------------------------------------------------------------------- */
  /* Formatters                                                            */
  /* --------------------------------------------------------------------- */

  function shorten(addr) {
    if (!addr) return "";
    return addr.slice(0, 6) + "…" + addr.slice(-4);
  }

  function fmtAllowance(raw, decimals) {
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

  /* --------------------------------------------------------------------- */
  /* Render helpers                                                        */
  /* --------------------------------------------------------------------- */

  function renderEmpty(container, msg) {
    container.innerHTML = '<div class="defi-empty">' + msg + "</div>";
  }
  function renderError(container, msg) {
    container.innerHTML = '<div class="defi-empty" style="color:var(--defi-danger,#ff6b6b)">' + msg + "</div>";
  }
  function renderProgress(container, owner, chainName, stage) {
    container.innerHTML =
      '<div class="defi-empty">Scanning <code>' + shorten(owner) +
      "</code> on <strong>" + chainName + "</strong> — " + stage + "…</div>";
  }

  function renderTable(container, rows, owner, ctx) {
    if (!rows.length) {
      container.innerHTML =
        '<div class="defi-card">' +
          '<div class="defi-card__title">No active approvals found</div>' +
          '<p style="margin:8px 0 0;color:var(--defi-text-dim);font-size:13px">' +
            "Indexed " + ctx.eventCount + " Approval event" + (ctx.eventCount === 1 ? "" : "s") +
            " for <code>" + shorten(owner) + "</code> on " + ctx.chainName +
            " over the last ~" + ctx.totalBlocks.toLocaleString() + " blocks. " +
            "All current allowances are zero — your wallet has no live approvals to revoke on this chain." +
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
              '<div class="defi-card__delta">non-zero allowances on ' + ctx.chainName + '</div></div>';
    html +=   '<div class="defi-card"><div class="defi-card__title">Unlimited</div>' +
              '<div class="defi-card__value" style="color:' + (unlimited ? "var(--defi-danger,#ff6b6b)" : "inherit") + '">' + unlimited + '</div>' +
              '<div class="defi-card__delta">grant access to your full balance</div></div>';
    html +=   '<div class="defi-card"><div class="defi-card__title">High-risk spenders</div>' +
              '<div class="defi-card__value" style="color:' + (highRisk ? "var(--defi-danger,#ff6b6b)" : "inherit") + '">' + highRisk + '</div>' +
              '<div class="defi-card__delta">routers with broad pull rights</div></div>';
    html += "</div>";

    html += '<div class="defi-card">';
    html +=   '<div class="defi-card__title">Approvals on ' + ctx.chainName + '</div>';
    html +=   '<div style="overflow-x:auto;margin-top:10px">';
    html +=     '<table class="defi-table">';
    html +=       '<thead><tr>' +
                    '<th>Token</th><th>Spender</th><th style="text-align:right">Allowance</th>' +
                    '<th>Type</th><th>Spender risk</th><th></th>' +
                  '</tr></thead><tbody>';
    rows.forEach(function (r) {
      html +=     '<tr>' +
                    '<td><strong>' + escapeHtml(r.token.symbol) + "</strong> " +
                      '<span style="color:var(--defi-text-dim);font-size:12px">' + escapeHtml(r.token.name) + "</span> " +
                      '<span style="display:block;color:var(--defi-text-dim);font-size:11px;font-family:monospace">' + shorten(r.tokenAddr) + "</span></td>" +
                    '<td>' + escapeHtml(r.spender.name) +
                      ' <span style="display:block;color:var(--defi-text-dim);font-size:11px;font-family:monospace">' + shorten(r.spenderAddr) + "</span></td>" +
                    '<td style="text-align:right;font-family:monospace">' +
                      (r.isUnlimited ? "∞" : fmtAllowance(r.allowance, r.token.decimals) + " " + escapeHtml(r.token.symbol)) +
                    "</td>" +
                    '<td>' + unlimitedChip(r.isUnlimited) + '</td>' +
                    '<td>' + riskChip(r.spender.risk) + '</td>' +
                    '<td style="text-align:right"><a class="defi-btn defi-btn--ghost" style="padding:6px 12px;font-size:12px" target="_blank" rel="noopener" href="https://revoke.cash/address/' + owner + "?chainId=" + ctx.revokeId + "\">Revoke →</a></td>" +
                  "</tr>";
    });
    html +=     "</tbody></table>";
    html +=   "</div>";
    html +=   '<p style="margin:14px 0 0;font-size:12px;color:var(--defi-text-dim)">' +
              "Scan completed " + ctx.scannedAt + " · Read-only · No transactions sent. " +
              "Indexed " + ctx.eventCount + " Approval events over ~" + ctx.totalBlocks.toLocaleString() +
              " blocks. Revocations execute on revoke.cash with your wallet." +
            "</p>";
    html += "</div>";

    container.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* --------------------------------------------------------------------- */
  /* Core scan                                                             */
  /* --------------------------------------------------------------------- */

  // Approval(address indexed owner, address indexed spender, uint256 value)
  const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
  const ERC20_ABI = [
    "function allowance(address owner, address spender) view returns (uint256)",
    "function symbol() view returns (string)",
    "function name() view returns (string)",
    "function decimals() view returns (uint8)",
  ];
  const UNLIMITED_THRESHOLD = (1n << 255n);

  // Pad 20-byte address into 32-byte topic (0x + 64 hex chars).
  function addrToTopic(addr) {
    return "0x" + "0".repeat(24) + addr.toLowerCase().replace(/^0x/, "");
  }
  function topicToAddr(topic) {
    return "0x" + topic.slice(-40).toLowerCase();
  }

  async function fetchApprovalLogs(provider, owner, fromBlock, toBlock, chunkSize) {
    // Walk forwards in `chunkSize` chunks. Failures on a single chunk are
    // logged but don't abort the whole scan — we surface what we got.
    const logs = [];
    let start = fromBlock;
    while (start <= toBlock) {
      const end = Math.min(start + chunkSize - 1, toBlock);
      try {
        const chunk = await provider.getLogs({
          fromBlock: start,
          toBlock: end,
          topics: [APPROVAL_TOPIC, addrToTopic(owner)],
        });
        logs.push.apply(logs, chunk);
      } catch (e) {
        console.warn("[approvals] getLogs", start, "->", end, "failed:", e && e.message);
      }
      start = end + 1;
    }
    return logs;
  }

  async function fetchTokenMetadata(ethers, provider, tokenAddrs) {
    // Resolve symbol/name/decimals in parallel. A token that fails any of
    // these calls falls back to address-based labels so it still shows up.
    const out = {};
    await Promise.all(tokenAddrs.map(async function (addr) {
      const c = new ethers.Contract(addr, ERC20_ABI, provider);
      const [sym, name, dec] = await Promise.all([
        c.symbol().catch(function () { return "?"; }),
        c.name().catch(function () { return "Unknown token"; }),
        c.decimals().catch(function () { return 18; }),
      ]);
      out[addr.toLowerCase()] = {
        symbol: String(sym).slice(0, 12),
        name:   String(name).slice(0, 60),
        decimals: Number(dec),
      };
    }));
    return out;
  }

  async function scan(owner) {
    const container = document.getElementById("approvals-checker-container");
    if (!container) return;

    if (!window.ethereum) {
      renderError(container, "No EVM provider detected in this browser. Connect a wallet first.");
      return;
    }

    let ethers;
    try { ethers = await loadEthers(); }
    catch (e) {
      renderError(container, "Could not load ethers.js from the CDN. Check your network and retry.");
      return;
    }

    let provider, chainId;
    try {
      provider = new ethers.BrowserProvider(window.ethereum);
      const net = await provider.getNetwork();
      chainId = Number(net.chainId);
    } catch (e) {
      renderError(container, "Wallet provider error: " + (e.message || e));
      return;
    }

    const cfg = CHAIN_CONFIG[chainId];
    if (!cfg) {
      renderError(container,
        "This chain (id " + chainId + ") isn't supported yet. " +
        "Switch to Ethereum, Polygon, or Arbitrum and retry.");
      return;
    }

    const totalBlocks = cfg.chunkSize * cfg.chunks;
    renderProgress(container, owner, cfg.name, "indexing the last " + totalBlocks.toLocaleString() + " blocks for Approval events");

    let latest;
    try { latest = await provider.getBlockNumber(); }
    catch (e) {
      renderError(container, "Could not fetch the latest block from your wallet's RPC: " + (e.message || e));
      return;
    }
    const fromBlock = Math.max(0, latest - totalBlocks + 1);

    const logs = await fetchApprovalLogs(provider, owner, fromBlock, latest, cfg.chunkSize);

    // Reduce logs into the LATEST (token, spender) pair seen. We want one
    // probe per pair — the actual current allowance is what matters, not
    // historical values.
    const pairMap = new Map();
    logs.forEach(function (log) {
      if (!log.topics || log.topics.length < 3) return;
      const tokenAddr   = log.address.toLowerCase();
      const spenderAddr = topicToAddr(log.topics[2]);
      const key = tokenAddr + "|" + spenderAddr;
      const blockNum = Number(log.blockNumber || 0);
      const prev = pairMap.get(key);
      if (!prev || blockNum > prev.blockNumber) {
        pairMap.set(key, { tokenAddr: tokenAddr, spenderAddr: spenderAddr, blockNumber: blockNum });
      }
    });

    if (pairMap.size === 0) {
      renderTable(container, [], owner, {
        chainName: cfg.name,
        revokeId: cfg.revokeId,
        scannedAt: new Date().toLocaleString(),
        eventCount: logs.length,
        totalBlocks: totalBlocks,
      });
      return;
    }

    renderProgress(container, owner, cfg.name,
      "fetching live allowances for " + pairMap.size + " token/spender pair" + (pairMap.size === 1 ? "" : "s"));

    // Fetch metadata for unique tokens, in parallel.
    const uniqueTokens = Array.from(new Set(Array.from(pairMap.values()).map(function (p) { return p.tokenAddr; })));
    const meta = await fetchTokenMetadata(ethers, provider, uniqueTokens);

    // Probe current allowance for each pair, in parallel.
    const probes = Array.from(pairMap.values()).map(function (p) {
      const c = new ethers.Contract(p.tokenAddr, ERC20_ABI, provider);
      return c.allowance(owner, p.spenderAddr)
        .then(function (allowance) { return Object.assign({}, p, { allowance: allowance }); })
        .catch(function (e) {
          console.warn("[approvals] allowance probe failed:", p.tokenAddr, p.spenderAddr, e && e.message);
          return null;
        });
    });
    const results = await Promise.all(probes);

    const knownSpenders = KNOWN_SPENDERS[chainId] || {};
    const rows = [];
    results.forEach(function (r) {
      if (!r) return;
      if (r.allowance <= 0n) return;
      const spenderInfo = knownSpenders[r.spenderAddr] || { name: "Unknown contract", risk: "Medium" };
      const tokenInfo = meta[r.tokenAddr] || { symbol: "?", name: "Unknown token", decimals: 18 };
      rows.push({
        tokenAddr: r.tokenAddr,
        token: tokenInfo,
        spenderAddr: r.spenderAddr,
        spender: spenderInfo,
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

    renderTable(container, rows, owner, {
      chainName: cfg.name,
      revokeId: cfg.revokeId,
      scannedAt: new Date().toLocaleString(),
      eventCount: logs.length,
      totalBlocks: totalBlocks,
    });

    // Anonymized telemetry: count of unlimited-grant rows for the daily aggregate.
    if (window.DefiIntel) {
      const unlimitedCount = rows.reduce(function (n, r) { return n + (r.isUnlimited ? 1 : 0); }, 0);
      window.DefiIntel.log("approvals_scan", {
        metadata: { chainId: chainId, unlimitedApprovals: unlimitedCount, totalRows: rows.length },
      });
    }
  }

  /* --------------------------------------------------------------------- */
  /* Wiring                                                                */
  /* --------------------------------------------------------------------- */

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
      renderEmpty(container, "Connect a wallet to scan token approvals on Ethereum, Polygon, or Arbitrum.");
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
