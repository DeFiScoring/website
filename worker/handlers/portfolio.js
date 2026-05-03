// worker/handlers/portfolio.js
// ----------------------------------------------------------------------------
// THE wallet fix.
//
// Scans every chain in the registry, returns native + ERC-20 holdings with
// fiat values. Designed to never return $0 just because one provider failed:
// each chain is independent, each token is independent, and any error is
// surfaced as { error } on the chain row instead of bubbling out.
//
// Response shape is intentionally dual:
//   - The new structured fields (address, fiat, portfolioFiat, activeChains,
//     totalTokens, chains[]) are what the upcoming SPA rewrite (T7) consumes.
//   - The legacy fields (wallet, total_value_usd, positions[]) keep the
//     existing dashboard.js / dashboard-portfolio.js working today without
//     any front-end edits.
//
// Once the SPA rewrite lands we delete the legacy fields. Until then, both
// surfaces are populated from the same scan so they can never disagree.
// ----------------------------------------------------------------------------

import { CHAINS, CHAINS_BY_ID, TIER1_IDS } from '../lib/chains.js';
import { getNativeBalance, getErc20Balances } from '../lib/providers.js';
import { priceTokens, priceMultipleNatives } from '../lib/prices.js';

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const isAddress = (a) => ADDR_RE.test(a || '');

async function scanChain(chain, env, address, fiat, nativePxMap) {
  // Capture per-source errors so we can surface "Polygon: rate limited" in
  // the UI instead of the user staring at $0 with no explanation.
  const errors = [];
  const [native, tokens] = await Promise.all([
    getNativeBalance(chain, env, address).catch((e) => {
      errors.push({ source: 'native', message: String(e.message || e) });
      return 0;
    }),
    getErc20Balances(chain, env, address).catch((e) => {
      errors.push({ source: 'erc20', message: String(e.message || e) });
      return [];
    }),
  ]);

  const tokenContracts = tokens.map((t) => t.contract).filter(Boolean);
  const tokenPxs = tokenContracts.length
    ? await priceTokens(chain, env, tokenContracts, fiat).catch(() => ({}))
    : {};

  const fiatLow = fiat.toLowerCase();
  const tokenRows = tokens.map((t) => {
    const px = tokenPxs[t.contract.toLowerCase()]?.[fiatLow] ?? 0;
    return {
      contract: t.contract,
      symbol: t.symbol,
      name: t.name,
      logo: t.logo,
      decimals: t.decimals,
      chain: chain.id,
      amount: t.amount,
      priceFiat: px,
      valueFiat: px * t.amount,
      source: t.source,
    };
  });

  const nativePx = nativePxMap[chain.nativeCoingeckoId]?.[fiatLow] ?? 0;
  const nativeRow = native > 0 ? [{
    contract: 'native',
    symbol: chain.nativeSymbol,
    name: `${chain.name} ${chain.nativeSymbol}`,
    logo: null,
    decimals: 18,
    chain: chain.id,
    amount: native,
    priceFiat: nativePx,
    valueFiat: nativePx * native,
    source: 'native',
  }] : [];

  const allTokens = [...nativeRow, ...tokenRows];
  // Pick the most informative source label for the chain: alchemy/moralis
  // beats etherscan beats native-only. Useful for the diag UI so the user
  // can see "Polygon scanned via etherscan" when their plan limits us.
  const sources = new Set(allTokens.map((t) => t.source).filter(Boolean));
  return {
    chain: chain.id,
    chainName: chain.name,
    chainId: chain.chainId,
    tier: chain.tier,
    tokens: allTokens.sort((a, b) => (b.valueFiat || 0) - (a.valueFiat || 0)),
    totalFiat: allTokens.reduce((s, t) => s + (t.valueFiat || 0), 0),
    sources: Array.from(sources),
    errors: errors.length ? errors : null,
  };
}

export async function handlePortfolio(request, env, baseHeaders = {}) {
  const url = new URL(request.url);
  // Accept both `wallet` (legacy front-end) and `address` (new SPA + plan).
  const address = (url.searchParams.get('address') || url.searchParams.get('wallet') || '').toLowerCase();
  const fiat = (url.searchParams.get('fiat') || 'USD').toUpperCase();
  const chainFilter = url.searchParams.get('chains'); // optional CSV
  const tier1Only = url.searchParams.get('tier') === '1';

  if (!isAddress(address)) {
    return jsonRes({ success: false, error: 'invalid wallet address' }, 400, baseHeaders);
  }

  let chainsToScan = CHAINS;
  if (chainFilter) {
    const wanted = new Set(chainFilter.split(',').map((s) => s.trim()).filter(Boolean));
    chainsToScan = CHAINS.filter((c) => wanted.has(c.id));
  } else if (tier1Only) {
    chainsToScan = CHAINS.filter((c) => c.tier === 1);
  }

  // Batch every native price into one CoinGecko call. The per-chain scan reads
  // out of this map so we never fan out 11 separate /simple/price requests.
  const nativeIds = Array.from(new Set(chainsToScan.map((c) => c.nativeCoingeckoId)));
  const nativePxMap = await priceMultipleNatives(env, fiat, nativeIds).catch(() => ({}));

  const perChain = await Promise.all(chainsToScan.map((c) =>
    scanChain(c, env, address, fiat, nativePxMap).catch((err) => ({
      chain: c.id, chainName: c.name, chainId: c.chainId, tier: c.tier,
      tokens: [], totalFiat: 0, sources: [],
      errors: [{ source: 'scan', message: String(err.message || err) }],
    }))
  ));

  // Diagnostic header: which providers answered, and which chains had
  // partial failures. Lets the front-end show a banner like
  //   "5 of 11 chains scanned · 2 rate-limited · upgrade for full coverage"
  // without it having to inspect every chain row.
  const providerHealth = {};
  for (const row of perChain) {
    for (const src of (row.sources || [])) {
      providerHealth[src] = (providerHealth[src] || 0) + 1;
    }
  }

  const portfolioFiat = perChain.reduce((s, c) => s + (c.totalFiat || 0), 0);
  const activeChains = perChain.filter((c) => (c.totalFiat || 0) > 0).length;
  const totalTokens = perChain.reduce((s, c) => s + (c.tokens?.length || 0), 0);

  // ----- Legacy shape (for current dashboard.js) ---------------------------
  const positions = [];
  const legacyChains = [];
  for (const row of perChain) {
    // Surface the first error message in the legacy `error` field so the
    // current dashboard renders a useful tooltip; full structured errors
    // are on the new `chains[]` rows.
    const firstErr = row.errors && row.errors[0];
    legacyChains.push({
      chain: row.chain,
      chainName: row.chainName,
      chainId: row.chainId,
      tier: row.tier,
      total_value_usd: row.totalFiat,
      token_count: row.tokens.length,
      error: firstErr ? `${firstErr.source}: ${firstErr.message}` : null,
    });
    for (const t of row.tokens) {
      positions.push({
        name: t.contract === 'native' ? `Native ${t.symbol}` : (t.symbol || t.name || 'Token'),
        chain: row.chainName,
        chainId: row.chain,
        amount: t.amount,
        symbol: t.symbol,
        price_usd: t.priceFiat,        // legacy field name is `_usd` regardless of fiat
        value_usd: t.valueFiat,
        contract: t.contract,
        source: t.source,
      });
    }
  }
  positions.sort((a, b) => (b.value_usd || 0) - (a.value_usd || 0));

  return jsonRes({
    success: true,

    // New structured fields (T5 score engine + T7 SPA consume these):
    address,
    fiat,
    portfolioFiat,
    activeChains,
    totalTokens,
    chains: perChain,
    providerHealth, // { alchemy: 5, etherscan: 6, native: 1, ... }

    // Legacy fields (kept until T7 SPA rewrite lands):
    wallet: address,
    total_value_usd: portfolioFiat,
    positions,
    chainSummaries: legacyChains,

    updatedAt: new Date().toISOString(),
  }, 200, baseHeaders);
}

function jsonRes(data, status, baseHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=30',
      ...baseHeaders,
    },
  });
}
