// worker/lib/providers.js
// ----------------------------------------------------------------------------
// Unified read interface across Alchemy / Moralis / Etherscan v2 (+ public
// RPC). Each function takes (chain, env, ...) and returns normalized data, so
// handlers never branch on which provider answered.
//
// Tiering:
//   1. Alchemy   — preferred when ALCHEMY_KEY is set AND the chain has an
//                  Alchemy network (chain.alchemy). Best ERC-20 + NFT shape.
//   2. Moralis   — fallback when MORALIS_KEY is set. Useful for chains
//                  Alchemy doesn't cover (gnosis) and as a redundant backstop.
//   3. Etherscan v2 — last resort, available on every chain in the registry
//                  via a single ETHERSCAN_API_KEY. Slower (sequential
//                  balanceOf eth_call per token) but always works.
//
// This guarantees /api/portfolio works on day one with only the ETHERSCAN_API_KEY
// the project already has, and silently upgrades when richer keys are added.
// ----------------------------------------------------------------------------

const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api';
const ERC20_BALANCE_OF_SELECTOR = '0x70a08231';

function pad32Hex(addr) {
  return addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function hexToBigIntSafe(hex) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]*$/.test(hex)) return 0n;
  return hex === '0x' || hex === '0x0' ? 0n : BigInt(hex);
}

// Convert a BigInt token amount + decimals to a JS number. Anything beyond
// ~Number.MAX_SAFE_INTEGER is acceptable here because portfolio math is for
// display, not on-chain transfers — losing trailing precision on a position
// worth millions of an 18-decimal token has no user-visible impact.
function bigIntToAmount(raw, decimals) {
  const d = Math.max(0, Math.min(36, Number(decimals) || 18));
  if (raw === 0n) return 0;
  const denom = 10n ** BigInt(d);
  const whole = Number(raw / denom);
  const frac = Number(raw % denom) / Number(denom);
  return whole + frac;
}

// ----- Alchemy ---------------------------------------------------------------

async function alchemyRpc(chain, env, method, params) {
  if (!chain.alchemy || !env.ALCHEMY_KEY) throw new Error('alchemy unavailable');
  const url = `https://${chain.alchemy}.g.alchemy.com/v2/${env.ALCHEMY_KEY}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!r.ok) throw new Error(`alchemy http ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`alchemy:${method}:${j.error.message}`);
  return j.result;
}

// ----- Moralis ---------------------------------------------------------------

async function moralisGet(chain, env, path) {
  if (!chain.moralis || !env.MORALIS_KEY) throw new Error('moralis unavailable');
  const url = `https://deep-index.moralis.io/api/v2.2${path}${path.includes('?') ? '&' : '?'}chain=${chain.moralis}`;
  const r = await fetch(url, { headers: { 'X-API-Key': env.MORALIS_KEY, accept: 'application/json' } });
  if (!r.ok) throw new Error(`moralis http ${r.status}`);
  return r.json();
}

// ----- Etherscan v2 (single key, every chain via chainid param) -------------

async function etherscanCall(chain, env, params) {
  if (!env.ETHERSCAN_API_KEY) throw new Error('ETHERSCAN_API_KEY not configured');
  const url = new URL(ETHERSCAN_V2);
  url.searchParams.set('chainid', String(chain.chainId));
  url.searchParams.set('apikey', env.ETHERSCAN_API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`etherscan http ${res.status}`);
  const data = await res.json();
  if (data.status === '0' && data.message !== 'No transactions found') {
    throw new Error('etherscan: ' + (data.result || data.message));
  }
  return data.result;
}

// Generic eth_call wrapper. T4 (lib/defi.js) needs this to read Aave V3
// getUserAccountData, Compound V3 supply/borrow balances, and Uniswap V3
// LP NFT counts, without having to know which provider answered. Mirrors
// the tier order of the balance helpers above: Alchemy → Etherscan v2.
//
// Returns the hex string result (e.g. "0x000...abc"). Caller is responsible
// for ABI-decoding via hexWord() below. Returns null on any failure so the
// caller can degrade gracefully (a chain with no Aave deployment, or an RPC
// that times out, must never bubble up as a 500).
export async function ethCall(chain, env, to, data) {
  if (chain.alchemy && env.ALCHEMY_KEY) {
    try {
      return await alchemyRpc(chain, env, 'eth_call', [{ to, data }, 'latest']);
    } catch { /* fall through */ }
  }
  try {
    return await etherscanCall(chain, env, {
      module: 'proxy', action: 'eth_call', to, data, tag: 'latest',
    });
  } catch {
    return null;
  }
}

// ABI helpers — pulled out of lib/defi.js so any handler can decode return
// data without re-implementing them.

// Pad a 20-byte address into a 32-byte word for ABI-encoded calldata.
export function abiPadAddr(addr) {
  return '000000000000000000000000' + addr.toLowerCase().replace(/^0x/, '');
}

// Pull the Nth 32-byte word out of a hex result. Returns BigInt(0) for
// missing/malformed results so callers can do math without null-checking.
export function abiHexWord(hex, wordIndex) {
  if (typeof hex !== 'string' || !hex.startsWith('0x')) return 0n;
  const start = 2 + wordIndex * 64;
  const slice = hex.slice(start, start + 64);
  if (slice.length !== 64) return 0n;
  try { return BigInt('0x' + slice); } catch { return 0n; }
}

// Encode a single function selector + address argument (the most common
// shape: balanceOf, getUserAccountData, etc.). Selector should already
// include the leading "0x".
export function abiEncodeSingleAddr(selector, addr) {
  return selector + abiPadAddr(addr);
}

// ============================================================================
// Public API — every handler should consume only these.
// ============================================================================

export async function getNativeBalance(chain, env, address) {
  // Tier 1 — Alchemy
  if (chain.alchemy && env.ALCHEMY_KEY) {
    try {
      const hex = await alchemyRpc(chain, env, 'eth_getBalance', [address, 'latest']);
      return Number(hexToBigIntSafe(hex)) / 1e18;
    } catch { /* fall through */ }
  }
  // Tier 2 — Moralis
  if (chain.moralis && env.MORALIS_KEY) {
    try {
      const j = await moralisGet(chain, env, `/${address}/balance`);
      return Number(j.balance || 0) / 1e18;
    } catch { /* fall through */ }
  }
  // Tier 3 — Etherscan v2
  try {
    const r = await etherscanCall(chain, env, {
      module: 'account', action: 'balance', address, tag: 'latest',
    });
    return Number(BigInt(r)) / 1e18;
  } catch {
    return 0;
  }
}

export async function getErc20Balances(chain, env, address) {
  // Tier 1 — Alchemy: returns balances + metadata in 1+N calls
  if (chain.alchemy && env.ALCHEMY_KEY) {
    try {
      const res = await alchemyRpc(chain, env, 'alchemy_getTokenBalances', [address, 'erc20']);
      const filtered = (res.tokenBalances || [])
        .filter((t) => t.tokenBalance && t.tokenBalance !== '0x0' && t.tokenBalance !== '0x');
      // Cap at 100 tokens per chain so we don't blow past CPU/time on dust farms.
      const capped = filtered.slice(0, 100);
      const enriched = await Promise.all(capped.map(async (t) => {
        const meta = await alchemyRpc(chain, env, 'alchemy_getTokenMetadata', [t.contractAddress])
          .catch(() => ({}));
        const decimals = meta.decimals ?? 18;
        const raw = hexToBigIntSafe(t.tokenBalance);
        const amount = bigIntToAmount(raw, decimals);
        return {
          contract: t.contractAddress.toLowerCase(),
          symbol: meta.symbol || 'UNKNOWN',
          name: meta.name || 'Unknown',
          logo: meta.logo || null,
          decimals,
          amount,
          source: 'alchemy',
        };
      }));
      return enriched.filter((t) => t.amount > 0);
    } catch { /* fall through */ }
  }
  // Tier 2 — Moralis
  if (chain.moralis && env.MORALIS_KEY) {
    try {
      const j = await moralisGet(chain, env, `/${address}/erc20`);
      const mapped = (Array.isArray(j) ? j : []).map((t) => {
        const decimals = Number(t.decimals || 18);
        const raw = BigInt(t.balance || '0');
        return {
          contract: (t.token_address || '').toLowerCase(),
          symbol: t.symbol || 'UNKNOWN',
          name: t.name || 'Unknown',
          logo: t.logo || t.thumbnail || null,
          decimals,
          amount: bigIntToAmount(raw, decimals),
          source: 'moralis',
        };
      }).filter((t) => t.contract && t.amount > 0);
      // Same 100/chain cap as the Alchemy branch — bounds CPU + downstream
      // CoinGecko URL length on dust-airdropped wallets, and prevents Moralis
      // pagination edge cases from blowing past the worker's CPU budget.
      // Sort by raw amount as a coarse priority; we don't have prices yet, so
      // this can't be value-sorted, but it does push known-zero/spam to the tail.
      return mapped
        .sort((a, b) => (b.amount || 0) - (a.amount || 0))
        .slice(0, 100);
    } catch { /* fall through */ }
  }
  // Tier 3 — Etherscan v2: derive token list from tokentx history, then
  // balanceOf via proxy eth_call. Sequential (free-tier 5 rps cap) — slow
  // but works on every chain with just the existing ETHERSCAN_API_KEY.
  return etherscanErc20Balances(chain, env, address);
}

async function etherscanErc20Balances(chain, env, address) {
  let tokTxs;
  try {
    tokTxs = await etherscanCall(chain, env, {
      module: 'account', action: 'tokentx', address,
      page: 1, offset: 1000, sort: 'desc',
    });
  } catch {
    return [];
  }
  const tokArr = Array.isArray(tokTxs) ? tokTxs : [];
  const catalog = new Map();
  for (const t of tokArr) {
    const c = (t.contractAddress || '').toLowerCase();
    if (!c || catalog.has(c)) continue;
    catalog.set(c, {
      contract: c,
      symbol: t.tokenSymbol || 'UNKNOWN',
      name: t.tokenName || 'Unknown',
      decimals: Number(t.tokenDecimal) || 18,
    });
  }
  // Cap discovered tokens to 50/chain — anything beyond is almost always
  // airdrop spam, and we don't want to do 500 eth_calls on a single wallet.
  const candidates = Array.from(catalog.values()).slice(0, 50);
  const data = ERC20_BALANCE_OF_SELECTOR + pad32Hex(address);
  const out = [];
  for (const t of candidates) {
    try {
      const hex = await etherscanCall(chain, env, {
        module: 'proxy', action: 'eth_call',
        to: t.contract, data, tag: 'latest',
      });
      const raw = hexToBigIntSafe(hex);
      if (raw === 0n) continue;
      const amount = bigIntToAmount(raw, t.decimals);
      if (!Number.isFinite(amount) || amount === 0) continue;
      out.push({
        ...t,
        logo: null,
        amount,
        source: 'etherscan',
      });
    } catch { /* skip unreadable token */ }
  }
  return out;
}

// First-tx timestamp (ms). Used for the wallet-age scoring factor. Etherscan
// v2 multichain — call with `chain` for the chain we want, but Ethereum is
// usually the right answer for a wallet's "true age".
export async function getFirstTxTimestamp(chain, env, address) {
  try {
    const r = await etherscanCall(chain, env, {
      module: 'account', action: 'txlist', address,
      startblock: 0, endblock: 99999999,
      page: 1, offset: 1, sort: 'asc',
    });
    if (!Array.isArray(r) || !r.length) return null;
    return Number(r[0].timeStamp) * 1000;
  } catch {
    return null;
  }
}

// Tx count (for activity-factor scoring). Cheap — single eth_getTransactionCount.
export async function getTransactionCount(chain, env, address) {
  if (chain.alchemy && env.ALCHEMY_KEY) {
    try {
      const hex = await alchemyRpc(chain, env, 'eth_getTransactionCount', [address, 'latest']);
      return Number(hexToBigIntSafe(hex));
    } catch { /* fall through */ }
  }
  try {
    const hex = await etherscanCall(chain, env, {
      module: 'proxy', action: 'eth_getTransactionCount',
      address, tag: 'latest',
    });
    return Number(hexToBigIntSafe(hex));
  } catch {
    return 0;
  }
}
