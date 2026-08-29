/* DeFiScoring – social share card
 *
 *   GET /card/{0x…}.svg     the 1200×630 open-graph card
 *   GET /share/{0x…}        an HTML page whose og:/twitter: tags point at it
 *
 * Same discipline as the badge, at poster size: it reads the latest PERSISTED
 * score and never triggers a scan, so it stays one indexed D1 SELECT and is
 * safe behind an edge cache.
 *
 * WHAT IT REFUSES TO DO
 *
 * The card shows coverage whenever the score was computed on partial data.
 * A shared card is the most context-free place this number ever appears —
 * nobody sees the dashboard's caveats — so dropping the caveat here would be
 * the one place it matters most. A 720 at 40% coverage and a 720 at 100% are
 * not the same claim.
 *
 * FORMAT
 *
 * SVG, not PNG. A Worker cannot rasterise text without shipping a font
 * rasteriser, and inventing a PNG encoder to avoid that would be a lot of code
 * for a picture. Slack, Discord, Telegram, LinkedIn and iMessage all render an
 * SVG og:image; X/Twitter does not, and will show the page without a preview.
 * Making X work needs a rasteriser (a Browser Rendering binding, or an image
 * service) — `cardSvg()` is a pure function precisely so that swapping in one
 * later is a rendering change, not a rewrite.
 */

import { bandForScore } from "../lib/score.js";
import { latestScoreFor } from "./badge.js";

const W = 1200;
const H = 630;

const BAND = {
  excellent: { color: "#2bd4a4", label: "Excellent" },
  good:      { color: "#00f5ff", label: "Good" },
  fair:      { color: "#facc15", label: "Fair" },
  poor:      { color: "#ff5d6c", label: "Poor" },
  unknown:   { color: "#7c8a9b", label: "Not scored" },
};

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => (
    { "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]
  ));
}

function shortAddr(a) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function asOf(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * The card, as a pure function of the data. No env, no I/O — so it is testable
 * without a database and swappable for a raster renderer later.
 */
export function cardSvg({ address, score, coverage, computedAt }) {
  const has = Number.isFinite(score);
  const bandKey = has ? bandForScore(score) : "unknown";
  const band = BAND[bandKey] || BAND.unknown;
  const pct = typeof coverage === "number" ? Math.round(coverage * 100) : null;
  // Only meaningful alongside a score: an "as of" line on a card showing no
  // score implies one was computed at that moment.
  const date = has ? asOf(computedAt) : null;

  // Coverage is only worth saying when it is not the whole picture. Printing
  // "100% data" on every card would train people to ignore the line that
  // matters when it reads 40%.
  const partial = pct != null && pct < 100;

  // Arc geometry for the gauge: 300° sweep, 300 at the low end, 850 at the top.
  const cx = 300, cy = 330, r = 150;
  const frac = has ? Math.max(0, Math.min(1, (score - 300) / 550)) : 0;
  const START = -240, SWEEP = 300;
  const pol = (deg) => {
    const rad = (deg * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  };
  const [x0, y0] = pol(START);
  const [x1, y1] = pol(START + SWEEP);
  const [xv, yv] = pol(START + SWEEP * frac);
  const trackPath = `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 1 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  const valuePath = `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 ${SWEEP * frac > 180 ? 1 : 0} 1 ${xv.toFixed(1)} ${yv.toFixed(1)}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="DeFi Scoring credit score card">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0a0a0a"/>
      <stop offset="100%" stop-color="#121218"/>
    </linearGradient>
    <linearGradient id="brand" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#00f5ff"/>
      <stop offset="100%" stop-color="#a855f7"/>
    </linearGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect x="0" y="0" width="${W}" height="6" fill="url(#brand)"/>

  <text x="72" y="86" font-family="Inter,Helvetica,Arial,sans-serif" font-size="26" font-weight="700" fill="#e5e7eb">DeFi<tspan fill="#00f5ff">Scoring</tspan></text>
  <text x="72" y="120" font-family="JetBrains Mono,ui-monospace,monospace" font-size="20" fill="#9ca3af">${escapeXml(shortAddr(address))}</text>

  <path d="${trackPath}" fill="none" stroke="#2a2a35" stroke-width="24" stroke-linecap="round"/>
  ${has ? `<path d="${valuePath}" fill="none" stroke="${band.color}" stroke-width="24" stroke-linecap="round"/>` : ""}
  <text x="${cx}" y="${cy + 22}" text-anchor="middle" font-family="Inter,Helvetica,Arial,sans-serif" font-size="110" font-weight="800" fill="${has ? band.color : "#7c8a9b"}">${has ? score : "—"}</text>
  <text x="${cx}" y="${cy + 66}" text-anchor="middle" font-family="Inter,Helvetica,Arial,sans-serif" font-size="26" font-weight="600" fill="#9ca3af">${escapeXml(band.label)}</text>
  <text x="${cx}" y="${cy + 150}" text-anchor="middle" font-family="JetBrains Mono,ui-monospace,monospace" font-size="18" fill="#5a5a6a">300 — 850</text>

  <text x="620" y="250" font-family="Inter,Helvetica,Arial,sans-serif" font-size="40" font-weight="700" fill="#e5e7eb">On-chain credit score</text>
  <text x="620" y="300" font-family="Inter,Helvetica,Arial,sans-serif" font-size="24" fill="#9ca3af">Loan reliability · Portfolio health</text>
  <text x="620" y="336" font-family="Inter,Helvetica,Arial,sans-serif" font-size="24" fill="#9ca3af">Liquidity · Account age · Governance</text>

  ${partial ? (() => {
    const label = `Scored on ${pct}% live data`;
    // Sized from the label rather than a guess: at 20px semibold the average
    // advance is ~0.56em, plus 20px padding each side. A pill narrower than
    // its text is the kind of thing that only shows up once it is on someone
    // else's timeline.
    const w = Math.ceil(label.length * 11.2) + 40;
    return `<rect x="620" y="380" width="${w}" height="46" rx="10" fill="rgba(250,204,21,.12)" stroke="rgba(250,204,21,.4)"/>
  <text x="640" y="410" font-family="Inter,Helvetica,Arial,sans-serif" font-size="20" font-weight="600" fill="#facc15">${escapeXml(label)}</text>`;
  })() : ""}

  ${date ? `<text x="620" y="${partial ? 470 : 400}" font-family="JetBrains Mono,ui-monospace,monospace" font-size="17" fill="#5a5a6a">as of ${escapeXml(date)}</text>` : ""}

  <text x="72" y="${H - 44}" font-family="Inter,Helvetica,Arial,sans-serif" font-size="20" fill="#5a5a6a">defiscoring.com</text>
</svg>`;
}

function svgResponse(body, { status = 200, cacheSecs = 300 } = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": `public, max-age=${cacheSecs}, s-maxage=${cacheSecs}`,
      // The card is a picture, never a script host.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "x-content-type-options": "nosniff",
    },
  });
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export async function handleShareCard(request, env, walletPath) {
  const m = /^(0x[0-9a-fA-F]{40})\.svg$/.exec(walletPath || "");
  if (!m) {
    return svgResponse(
      cardSvg({ address: "0x0000000000000000000000000000000000000000", score: null }),
      { status: 400, cacheSecs: 60 },
    );
  }
  const addr = m[1].toLowerCase();
  const row = await latestScoreFor(env, addr).catch(() => null);
  return svgResponse(cardSvg({
    address: addr,
    score: row && Number.isFinite(row.score) ? row.score : null,
    coverage: row ? row.coverage : null,
    computedAt: row ? row.computed_at : null,
  }));
}

/**
 * The page a shared link actually points at. Social crawlers read its meta
 * tags; a human following the link gets sent to the dashboard for that wallet.
 */
export async function handleSharePage(request, env, wallet) {
  const addr = String(wallet || "").toLowerCase();
  if (!ADDR_RE.test(addr)) {
    return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
  }
  const row = await latestScoreFor(env, addr).catch(() => null);
  const has = row && Number.isFinite(row.score);
  const band = has ? (BAND[bandForScore(row.score)] || BAND.unknown).label : null;
  const pct = row && typeof row.coverage === "number" ? Math.round(row.coverage * 100) : null;

  const origin = new URL(request.url).origin;
  const cardUrl = `${origin}/card/${addr}.svg`;
  const dashUrl = `${origin}/dashboard/?wallet=${addr}`;

  const title = has
    ? `DeFi credit score ${row.score} · ${band} — ${shortAddr(addr)}`
    : `DeFi credit score — ${shortAddr(addr)}`;
  // The description carries the coverage caveat too: some clients show the
  // description and not the image.
  const desc = has
    ? (pct != null && pct < 100
        ? `Scored ${row.score}/850 on ${pct}% live on-chain data. Five pillars, published methodology.`
        : `Scored ${row.score}/850 from live on-chain data. Five pillars, published methodology.`)
    : "This wallet has not been scored yet. Run a scan on DeFi Scoring.";

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeXml(title)}</title>
<meta name="description" content="${escapeXml(desc)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeXml(title)}">
<meta property="og:description" content="${escapeXml(desc)}">
<meta property="og:image" content="${escapeXml(cardUrl)}">
<meta property="og:image:width" content="${W}">
<meta property="og:image:height" content="${H}">
<meta property="og:url" content="${escapeXml(`${origin}/share/${addr}`)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeXml(title)}">
<meta name="twitter:description" content="${escapeXml(desc)}">
<meta name="twitter:image" content="${escapeXml(cardUrl)}">
<link rel="canonical" href="${escapeXml(dashUrl)}">
<meta http-equiv="refresh" content="0; url=${escapeXml(dashUrl)}">
</head><body style="margin:0;background:#0a0a0a;color:#e5e7eb;font-family:Inter,Helvetica,Arial,sans-serif">
<div style="max-width:760px;margin:0 auto;padding:48px 24px">
  <img src="${escapeXml(cardUrl)}" alt="${escapeXml(title)}" style="width:100%;height:auto;border-radius:14px">
  <p style="margin:24px 0 0"><a href="${escapeXml(dashUrl)}" style="color:#00f5ff">Open this wallet on DeFi Scoring →</a></p>
</div>
</body></html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300, s-maxage=300",
      "x-content-type-options": "nosniff",
    },
  });
}
