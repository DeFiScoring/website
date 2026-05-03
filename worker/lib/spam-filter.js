// worker/lib/spam-filter.js
// ----------------------------------------------------------------------------
// Heuristic airdrop-spam filter. Most active wallets accumulate dozens of
// scam ERC-20 tokens whose `name`/`symbol` fields are themselves an attack:
// they embed a phishing URL, an emoji, or a "$ visit ... to claim" lure.
// Showing these in the dashboard is worse than hiding them — they waste
// the price-API budget AND give phishers a UI surface inside our product.
//
// We are deliberately conservative: legitimate tokens never have URLs,
// emojis, "visit", "claim", or whitespace in their name/symbol. The handful
// of edge cases (e.g. an exchange listing a token with a long descriptive
// name) is covered by the LEGIT_OVERRIDES allow-list.
//
// Returned tokens are unchanged in shape; callers just lose the spam ones.
// ----------------------------------------------------------------------------

// Tokens we never want to filter even if their metadata looks suspicious.
// Lowercased contract addresses keyed by chain id.
const LEGIT_OVERRIDES = new Set([
  // (Empty for now — add `${chainId}:${contract.toLowerCase()}` here if any
  // false-positive is reported.)
]);

// Tickers that scammers love to clone because users will see them and assume
// they're the real coin (XRP, SOL, BTC etc. don't have legitimate ERC-20
// deployments — they're native chains). Any ERC-20 with one of these symbols
// is a clone airdropped to phish via "approve to claim" flows.
//
// We do NOT include WBTC/WETH/STETH (those ARE legitimate ERC-20s).
const NATIVE_CHAIN_CLONES = new Set([
  'XRP', 'BTC', 'SOL', 'ADA', 'XMR', 'TRX', 'XLM', 'DOGE',
  'DOT', 'ATOM', 'NEAR', 'ALGO', 'EGLD', 'TON', 'SUI', 'APT',
  'HBAR', 'KAS', 'XEC',
]);

// Cheap regexes that catch ~99% of spam metadata in practice.
const URL_RE      = /(https?:\/\/|t\.me\/|www\.|\.(com|io|xyz|net|org|app|finance|fi|click|link|gift|claim|live|fun|world|cash|cloud|store|site|online|info|ru|cn))\b/i;
const EMOJI_RE    = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2700}-\u{27BF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F1FF}\u{1F200}-\u{1F2FF}\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2300}-\u{23FF}\u{25A0}-\u{27BF}]/u;
const LURE_RE     = /\b(visit|claim|reward|airdrop|bonus|free\s*\$|gift|giveaway|winner|congrat|access\s+code|voucher)\b/i;
const PROMO_CHARS = /[$#@!➡→✅✓✨🎁🎉]/;
const SUSPICIOUS  = /(\.com|\.io|\.xyz|t\.me|http|www\.)/i;

export function isLikelySpamToken(t, chainId) {
  if (!t) return true;
  const key = `${chainId}:${(t.contract || '').toLowerCase()}`;
  if (LEGIT_OVERRIDES.has(key)) return false;

  const name = String(t.name || '');
  const symbol = String(t.symbol || '');
  const blob = `${name} ${symbol}`;

  // decimals=0 ERC-20s are almost always NFT-shaped airdrop spam. Real
  // ERC-20s use 6 (USDC), 8 (WBTC), or 18 (everything else).
  if (Number(t.decimals) === 0) return true;

  // URL / domain in metadata — never legit.
  if (URL_RE.test(blob) || SUSPICIOUS.test(blob)) return true;

  // Emoji in metadata.
  if (EMOJI_RE.test(blob)) return true;

  // Phishing lures.
  if (LURE_RE.test(blob)) return true;

  // Promo chars in symbol specifically (legit symbols are alphanumeric).
  if (PROMO_CHARS.test(symbol)) return true;

  // Symbols with whitespace are spam ("CLAIM AIRDROP", etc.). Real
  // symbols are 1–12 chars, no spaces.
  if (/\s/.test(symbol) || symbol.length > 12) return true;

  // Names longer than ~64 chars are essentially always sentences-as-names.
  if (name.length > 64) return true;

  // Clones of native-chain tickers (XRP, BTC, SOL…) on EVM are 100% scam.
  if (NATIVE_CHAIN_CLONES.has(symbol.toUpperCase())) return true;

  return false;
}

// Convenience for use after a balance scan.
export function dropSpamTokens(tokens, chainId) {
  if (!Array.isArray(tokens)) return [];
  return tokens.filter((t) => !isLikelySpamToken(t, chainId));
}
