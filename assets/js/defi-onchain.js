/* DeFi Scoring – defi-onchain.js
 * Real on-chain reads via public JSON-RPC. No mocks, no fabrications.
 * Exposes window.DefiOnchain.
 */
(function () {
  // RPC endpoints. Defaults are public free-tier RPCs; for production set
  // window.DEFI_RPC = { ethereum: "https://<your>.web3.cloudflare.com/...", ... }
  // in a layout <script> tag to point at your Cloudflare Web3 Gateway URLs
  // (Cloudflare dashboard → Web3 → Create Gateway → Ethereum / Polygon).
  // Strip empty strings so Liquid templates that emit "" don't override
  // the public defaults below.
  const RPC_OVERRIDES = {};
  if (typeof window !== "undefined" && window.DEFI_RPC) {
    Object.keys(window.DEFI_RPC).forEach((k) => {
      const v = window.DEFI_RPC[k];
      if (typeof v === "string" && v.trim()) RPC_OVERRIDES[k] = v.trim();
    });
  }
  const CHAINS = [
    { id: "ethereum", name: "Ethereum", symbol: "ETH",   coingeckoId: "ethereum",       rpc: RPC_OVERRIDES.ethereum || "https://eth.llamarpc.com",     explorer: "https://etherscan.io" },
    { id: "arbitrum", name: "Arbitrum", symbol: "ETH",   coingeckoId: "ethereum",       rpc: RPC_OVERRIDES.arbitrum || "https://arb1.arbitrum.io/rpc", explorer: "https://arbiscan.io" },
    { id: "polygon",  name: "Polygon",  symbol: "MATIC", coingeckoId: "matic-network",  rpc: RPC_OVERRIDES.polygon  || "https://polygon-rpc.com",      explorer: "https://polygonscan.com" },
  ];

  async function rpc(url, method, params) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) throw new Error(method + " " + res.status);
    const j = await res.json();
    if (j.error) throw new Error(j.error.message || method + " error");
    return j.result;
  }

  function hexToBigInt(hex) { return BigInt(hex || "0x0"); }
  function weiToEth(wei) { return Number(wei) / 1e18; }

  async function getPrices() {
    const ids = Array.from(new Set(CHAINS.map((c) => c.coingeckoId))).join(",");
    try {
      const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=" + ids + "&vs_currencies=usd");
      if (!res.ok) throw new Error("price " + res.status);
      return await res.json();
    } catch (e) {
      console.warn("price fetch failed:", e.message);
      return {};
    }
  }

  async function getChainSnapshot(chain, address) {
    const [balanceHex, nonceHex, blockHex] = await Promise.all([
      rpc(chain.rpc, "eth_getBalance", [address, "latest"]),
      rpc(chain.rpc, "eth_getTransactionCount", [address, "latest"]),
      rpc(chain.rpc, "eth_blockNumber", []),
    ]);
    return {
      chain: chain.id,
      chainName: chain.name,
      symbol: chain.symbol,
      explorer: chain.explorer,
      nativeWei: hexToBigInt(balanceHex).toString(),
      nativeAmount: weiToEth(hexToBigInt(balanceHex)),
      txCount: Number(hexToBigInt(nonceHex)),
      latestBlock: Number(hexToBigInt(blockHex)),
    };
  }

  async function getEtherscanHistory(address) {
    const base = window.DEFI_RISK_WORKER_URL;
    if (!base) return null;
    try {
      const res = await fetch(base.replace(/\/$/, "") + "/onchain/" + address);
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
    const [snapshots, prices, history] = await Promise.all([
      Promise.all(CHAINS.map(async (c) => {
        try { return await getChainSnapshot(c, address); }
        catch (e) { console.warn(c.id + " snapshot failed:", e.message); return { chain: c.id, chainName: c.name, symbol: c.symbol, explorer: c.explorer, error: e.message, nativeAmount: 0, txCount: 0 }; }
      })),
      getPrices(),
      getEtherscanHistory(address),
    ]);
    if (history && history.chains) {
      snapshots.forEach((s) => {
        const h = history.chains[s.chain];
        if (h && !h.error) {
          s.uniqueContracts = h.unique_contracts;
          s.uniqueTokens = h.unique_tokens;
          s.walletAgeDays = h.wallet_age_days;
          s.firstTxAt = h.first_tx_at;
          s.lastTxAt = h.last_tx_at;
        }
      });
    }
    const positions = snapshots
      .filter((s) => !s.error && s.nativeAmount > 0)
      .map((s) => {
        const cfg = CHAINS.find((c) => c.id === s.chain);
        const price = (prices[cfg.coingeckoId] && prices[cfg.coingeckoId].usd) || 0;
        const valueUsd = s.nativeAmount * price;
        return {
          name: "Native " + s.symbol,
          chain: s.chainName,
          chainId: s.chain,
          amount: s.nativeAmount,
          symbol: s.symbol,
          price_usd: price,
          value_usd: valueUsd,
          source: "rpc",
        };
      });
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
      score,
      band: score >= 750 ? "Excellent" : score >= 670 ? "Good" : score >= 580 ? "Fair" : "Poor",
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
