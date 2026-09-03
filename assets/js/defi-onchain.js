/* DeFi Scoring – defi-onchain.js
 * On-chain reads for the dashboard. No mocks, no fabrications.
 * Exposes window.DefiOnchain.
 *
 * These reads USED to go straight from the browser to public RPCs
 * (eth.llamarpc.com, polygon-rpc.com) and to CoinGecko. That was rate limited
 * per visitor IP and CORS-fragile, so a wallet loaded on a busy network simply
 * showed zeros — indistinguishable from an empty wallet. They now go through
 * the worker's tiered provider stack via /api/onchain/snapshot, which also
 * distinguishes "we could not read this chain" from "this chain is empty".
 */
(function () {
  function workerBase() {
    var b = (typeof window !== "undefined" && window.DEFI_RISK_WORKER_URL) || "";
    return String(b).replace(/\/$/, "");
  }

  // Kept so callers that iterate chains for labels still work. The worker is
  // the authority on which chains are actually read.
  const CHAINS = [
    { id: "ethereum", name: "Ethereum", symbol: "ETH",   explorer: "https://etherscan.io" },
    { id: "arbitrum", name: "Arbitrum", symbol: "ETH",   explorer: "https://arbiscan.io" },
    { id: "polygon",  name: "Polygon",  symbol: "MATIC", explorer: "https://polygonscan.com" },
  ];

  async function getSnapshotFromWorker(address) {
    const res = await fetch(
      workerBase() + "/api/onchain/snapshot?wallet=" + encodeURIComponent(address),
      { credentials: "omit" }
    );
    if (!res.ok) throw new Error("snapshot " + res.status);
    const j = await res.json();
    if (!j.success) throw new Error(j.error || "snapshot failed");
    return j;
  }

  async function getEtherscanHistory(address) {
    const base = workerBase();
    try {
      const res = await fetch(base + "/onchain/" + address);
      if (!res.ok) throw new Error("worker " + res.status);
      const j = await res.json();
      if (!j.success) throw new Error(j.error || "history fetch failed");
      return j.data; // { wallet, chains: { ethereum: {...}, arbitrum: {...}, polygon: {...} } }
    } catch (e) {
      console.warn("Etherscan history unavailable:", e.message);
      return null;
    }
  }

  async function getWalletSnapshot(address) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Invalid address");

    const [snap, history] = await Promise.all([
      getSnapshotFromWorker(address).catch((e) => {
        console.warn("snapshot unavailable:", e.message);
        return { snapshots: [], positions: [], partial: true };
      }),
      getEtherscanHistory(address),
    ]);

    const snapshots = snap.snapshots || [];
    if (history && history.chains) {
      snapshots.forEach((s) => {
        const h = history.chains[s.chain];
        if (h && !h.error) {
          s.uniqueContracts = h.unique_contracts;
          s.uniqueTokens = h.unique_tokens;
          s.walletAgeDays = h.wallet_age_days;
          s.firstTxAt = h.first_tx_at;
          s.lastTxAt = h.last_tx_at;
          s.tokens = Array.isArray(h.tokens) ? h.tokens : [];
        }
      });
    }

    // Native-coin positions, already priced server-side. We surface dust
    // balances too (any > 0) so users see "we did look here"; the heatmap
    // sorts by USD value so dust naturally sinks to the bottom.
    const nativePositions = snap.positions || [];
    // ERC-20 positions discovered server-side via Etherscan tokentx + eth_call.
    // Without these, multi-chain wallets that only hold ERC-20s (RENDER, GRT,
    // USDC, MATIC-as-ERC20, POL, etc.) appear empty in the dashboard.
    const tokenPositions = [];
    snapshots.forEach((s) => {
      (s.tokens || []).forEach((t) => {
        tokenPositions.push({
          name: (t.symbol || t.name || "Token"),
          chain: s.chainName,
          chainId: s.chain,
          amount: t.balance,
          symbol: t.symbol || "",
          price_usd: t.price_usd || 0,
          value_usd: t.value_usd || 0,
          contract: t.contract,
          source: "etherscan",
        });
      });
    });
    const positions = nativePositions.concat(tokenPositions);
    const totalUsd = positions.reduce((a, p) => a + p.value_usd, 0);
    const totalTx = snapshots.reduce((a, s) => a + (s.txCount || 0), 0);
    const totalUniqueContracts = snapshots.reduce((a, s) => a + (s.uniqueContracts || 0), 0);
    const totalUniqueTokens = snapshots.reduce((a, s) => a + (s.uniqueTokens || 0), 0);
    const oldestFirstTx = snapshots
      .map((s) => s.firstTxAt).filter(Boolean).sort((a, b) => a - b)[0] || null;
    const walletAgeDays = oldestFirstTx ? Math.floor((Date.now() - oldestFirstTx) / 86400000) : 0;
    return {
      wallet: address,
      fetched_at: new Date().toISOString(),
      chains: snapshots,
      positions,
      total_native_value_usd: totalUsd,
      total_tx_count: totalTx,
      total_unique_contracts: totalUniqueContracts,
      total_unique_tokens: totalUniqueTokens,
      wallet_age_days: walletAgeDays,
      has_history: !!(history && history.chains),
      prices,
    };
  }

  /* Score derived ONLY from real signals available without a paid data provider.
   * It is intentionally narrow and labeled as "preliminary" in the UI. */
  function preliminaryScore(snapshot) {
    const tx = snapshot.total_tx_count;
    const activeChains = snapshot.chains.filter((c) => c.txCount > 0).length;
    const hasBalance = snapshot.positions.length > 0;
    const hasHistory = !!snapshot.has_history;
    const ageDays = snapshot.wallet_age_days || 0;
    const uniqContracts = snapshot.total_unique_contracts || 0;
    const uniqTokens = snapshot.total_unique_tokens || 0;

    // A wallet with no transactions, no balances, and no token history has
    // no footprint to score. This function used to hand such a wallet
    // 322 · "Poor" — entirely from the `hasBalance ? 70 : 20` floor below,
    // which awards 20 liquidity points for HOLDING NOTHING. A thin file is
    // unscorable, not poor; say so instead of inventing a number.
    if (tx === 0 && !hasBalance && uniqContracts === 0 && uniqTokens === 0) {
      return {
        scored: false,
        score: null,
        band: "Unscored",
        preliminary: true,
        reason: "no_onchain_history",
        explanation: "This wallet has no on-chain activity yet — no transactions, " +
          "balances, or token history on the chains we scanned. There is nothing " +
          "to score until it's used.",
        factors: [
          { name: "On-chain activity",  weight: 0, value: null, real: true, detail: "0 transactions found" },
          { name: "Balances",           weight: 0, value: null, real: true, detail: "No native or token balances" },
          { name: "Wallet age",         weight: 0, value: null, real: hasHistory, detail: hasHistory ? "No first transaction found" : "History service unreachable" },
        ],
      };
    }

    // Component scores (0–100)
    const activity = Math.min(100, Math.round(Math.log10(Math.max(1, tx)) * 33));
    const diversity = Math.round((activeChains / 3) * 100);
    const liquidity = hasBalance ? 70 : 20;
    // Wallet age: 0d=0, 30d=30, 365d=70, 1095d+=100
    const ageScore = Math.min(100, Math.round((Math.log10(Math.max(1, ageDays + 1)) / Math.log10(1096)) * 100));
    // Contract diversity: log scale on unique contracts interacted with (caps at ~50)
    const contractScore = Math.min(100, Math.round(Math.log10(Math.max(1, uniqContracts + 1)) * 58));
    // Token diversity: log scale on unique ERC-20s touched
    const tokenScore = Math.min(100, Math.round(Math.log10(Math.max(1, uniqTokens + 1)) * 58));

    let composite, factors;
    if (hasHistory) {
      // Full model with history: 25/15/20/15/15/10
      composite = activity * 0.25 + diversity * 0.15 + liquidity * 0.20 + ageScore * 0.15 + contractScore * 0.15 + tokenScore * 0.10;
      factors = [
        { name: "On-chain activity (tx count, Phase 1 chains)", weight: 25, value: activity, real: true, detail: tx + " total transactions" },
        { name: "Multi-chain diversity",                         weight: 15, value: diversity, real: true, detail: activeChains + " of 3 chains used" },
        { name: "Native liquidity present",                      weight: 20, value: liquidity, real: true, detail: hasBalance ? "Yes" : "No" },
        { name: "Wallet age",                                    weight: 15, value: ageScore, real: true, detail: ageDays + " days since first tx" },
        { name: "Contract interaction diversity",                weight: 15, value: contractScore, real: true, detail: uniqContracts + " unique contracts" },
        { name: "Token diversity",                               weight: 10, value: tokenScore, real: true, detail: uniqTokens + " unique ERC-20 tokens" },
      ];
    } else {
      // Fallback when Etherscan worker unreachable
      composite = activity * 0.45 + diversity * 0.25 + liquidity * 0.30;
      factors = [
        { name: "On-chain activity (tx count, Phase 1 chains)", weight: 45, value: activity, real: true, detail: tx + " total transactions" },
        { name: "Multi-chain diversity",                         weight: 25, value: diversity, real: true, detail: activeChains + " of 3 chains used" },
        { name: "Native liquidity present",                      weight: 30, value: liquidity, real: true, detail: hasBalance ? "Yes" : "No" },
        { name: "Wallet age / contract & token diversity",       weight: 0, value: null, real: false, detail: "Etherscan worker unreachable" },
      ];
    }
    const score = Math.round(300 + (composite / 100) * 550);
    return {
      scored: true,
      score,
      // score-bands.js, not dashboard.js: this script must stand alone if a
      // page ever includes defi-onchain.js without the dashboard bundle, and
      // score-bands.js is a dependency-free constant table loaded ahead of
      // both. That is why the thresholds are no longer inlined here.
      band: window.DefiBands.labelFor(score),
      preliminary: !hasHistory,
      factors,
    };
  }

  window.DefiOnchain = {
    chains: CHAINS,
    getWalletSnapshot,
    preliminaryScore,
  };
})();
