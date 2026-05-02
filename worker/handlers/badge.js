/* DeFiScoring – Public score badge SVG
 *
 *   GET /badge/{0x…}.svg
 *
 * Renders a small "DeFi Score: 742 · Good" badge as inline SVG so it can
 * be embedded anywhere an <img src> works (forum signatures, GitHub
 * READMEs, Twitter bio link cards, Discord, Notion). Public, no auth.
 *
 * The badge is intentionally read-only and does NOT trigger a fresh
 * scan — it returns the latest persisted score, or a "no score yet"
 * placeholder. This keeps the endpoint cheap (one indexed D1 SELECT)
 * and makes it safe to put behind a 5-minute edge cache.
 */

const BAND_COLOR = {
  excellent: "#2bd4a4",
  good:      "#00f5ff",
  fair:      "#facc15",
  poor:      "#ff5d6c",
  unknown:   "#7c8a9b",
};

function bandFor(score) {
  if (!Number.isFinite(score)) return "unknown";
  if (score >= 720) return "excellent";
  if (score >= 660) return "good";
  if (score >= 580) return "fair";
  return "poor";
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => (
    { "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]
  ));
}

function svg({ score, band, label, sublabel }) {
  const color = BAND_COLOR[band] || BAND_COLOR.unknown;
  // Two-column "shields.io"-style badge: left = label (dark), right = score (band color).
  const labelText = escapeXml(label);
  const scoreText = escapeXml(score);
  const subText   = escapeXml(sublabel || band[0].toUpperCase() + band.slice(1));

  // Pre-measure widths in CSS pixels (Inter ~7px/char @11px font, +padding).
  const labelW = Math.max(96, labelText.length * 7 + 18);
  const scoreW = Math.max(72, scoreText.length * 8 + subText.length * 5 + 22);
  const totalW = labelW + scoreW;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="28" viewBox="0 0 ${totalW} 28" role="img" aria-label="${labelText} ${scoreText} ${subText}">
  <title>${labelText} ${scoreText} ${subText}</title>
  <defs>
    <linearGradient id="g" x2="0" y2="100%">
      <stop offset="0" stop-color="#fff" stop-opacity=".08"/>
      <stop offset="1" stop-color="#000" stop-opacity=".18"/>
    </linearGradient>
    <clipPath id="r"><rect width="${totalW}" height="28" rx="6" fill="#fff"/></clipPath>
  </defs>
  <g clip-path="url(#r)">
    <rect width="${labelW}" height="28" fill="#0f172a"/>
    <rect x="${labelW}" width="${scoreW}" height="28" fill="${color}"/>
    <rect width="${totalW}" height="28" fill="url(#g)"/>
  </g>
  <g fill="#fff" font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="11" font-weight="600">
    <text x="${labelW / 2}" y="18" text-anchor="middle">${labelText}</text>
    <text x="${labelW + scoreW / 2}" y="17" text-anchor="middle" fill="#0b1220" font-size="13" font-weight="800">${scoreText}</text>
    <text x="${labelW + scoreW / 2}" y="26" text-anchor="middle" fill="#0b1220" font-size="9" font-weight="700" opacity=".75">${subText}</text>
  </g>
</svg>`;
}

function badgeResponse(body, { cacheSecs = 300, status = 200 } = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": `public, max-age=${cacheSecs}, s-maxage=${cacheSecs}`,
      "access-control-allow-origin": "*",
      // Hint Discord/Slack/etc. to render via the unfurler without redirect chains
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * Read the latest persisted score for a wallet. We reuse the same
 * health_scores table the dashboard does so the badge always agrees
 * with the trend chart. No fallback to /api/wallet-score live compute
 * — that would make the endpoint expensive enough to require auth.
 */
async function latestScoreFor(env, addr) {
  if (!env.HEALTH_DB) return null;
  const row = await env.HEALTH_DB
    .prepare("SELECT score, computed_at FROM health_scores WHERE wallet = ? ORDER BY computed_at DESC LIMIT 1")
    .bind(addr).first();
  return row || null;
}

export async function handleScoreBadge(request, env, walletPath) {
  // walletPath is e.g. "0xabc….svg" — strip the extension.
  const m = /^(0x[0-9a-fA-F]{40})\.svg$/.exec(walletPath || "");
  if (!m) {
    return badgeResponse(
      svg({ score: "—", band: "unknown", label: "DeFi Score", sublabel: "invalid" }),
      { status: 400, cacheSecs: 60 },
    );
  }
  const addr = m[1].toLowerCase();

  const row = await latestScoreFor(env, addr).catch(() => null);
  if (!row || !Number.isFinite(row.score)) {
    return badgeResponse(
      svg({ score: "—", band: "unknown", label: "DeFi Score", sublabel: "no scan yet" }),
      { cacheSecs: 60 },
    );
  }

  const band = bandFor(row.score);
  return badgeResponse(svg({
    score: String(row.score),
    band,
    label: "DeFi Score",
    sublabel: band[0].toUpperCase() + band.slice(1),
  }));
}
