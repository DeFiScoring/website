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

import { bandMeta, markSvg, UNKNOWN_BAND } from "../lib/bands.js";

// The thresholds used to be redeclared inline here, and drifted out of sync
// with the dashboard's own copy (750/670/580) — the same wallet could show a
// different band on its badge than on its dashboard. The colour map went the
// same way for the same reason. Both now come from worker/lib/bands.js, which
// layers presentation over worker/lib/score.js's BANDS; see the note there for
// why a second copy exists in the browser bundle and what pins it.

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => (
    { "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]
  ));
}

function svg({ score, meta, label, sublabel }) {
  const band = meta || UNKNOWN_BAND;
  const color = band.color;
  // Two-column "shields.io"-style badge: left = label (dark), right = score (band color).
  const labelText = escapeXml(label);
  const scoreText = escapeXml(score);
  const subText   = escapeXml(sublabel || band.label);

  // Pre-measure widths in CSS pixels (Inter ~7px/char @11px font, +padding).
  // MARK_W is the band mark's column in the right-hand cell: the cell is
  // already painted in the band colour, but a hue is not readable in
  // greyscale or under deuteranopia, so the shape carries the same claim.
  const MARK_W = 18;
  const labelW = Math.max(96, labelText.length * 7 + 18);
  const scoreW = Math.max(72, scoreText.length * 8 + subText.length * 5 + 22) + MARK_W;
  const totalW = labelW + scoreW;
  const textCx = labelW + MARK_W + (scoreW - MARK_W) / 2;

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
  ${markSvg(band, labelW + MARK_W / 2, 14, 11, "#0b1220")}
  <g fill="#fff" font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="11" font-weight="600">
    <text x="${labelW / 2}" y="18" text-anchor="middle">${labelText}</text>
    <text x="${textCx}" y="17" text-anchor="middle" fill="#0b1220" font-size="13" font-weight="800">${scoreText}</text>
    <text x="${textCx}" y="26" text-anchor="middle" fill="#0b1220" font-size="9" font-weight="700" opacity=".75">${subText}</text>
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
// Exported so the social share card reads the SAME persisted row the badge
// does. Two readers deriving a score independently is how a badge and a
// share card end up disagreeing about the same wallet.
export async function latestScoreFor(env, addr) {
  if (!env.HEALTH_DB) return null;
  const row = await env.HEALTH_DB
    .prepare("SELECT score, computed_at, source_json FROM health_scores WHERE wallet = ? ORDER BY computed_at DESC LIMIT 1")
    .bind(addr).first();
  if (!row) return null;
  // Coverage rode into source_json later than the score did, so old rows
  // have no key and the blob is free-form — both degrade to null rather
  // than breaking the badge. Same defensive shape as the history endpoint.
  //
  // The blob has two writers with two shapes: persistWalletScore (the current
  // one) stores model/coverage/score_band/adjustments/pillars, while the
  // legacy persistScore in worker/index.js stores the raw signals object with
  // none of those keys. So every field here is read independently and
  // independently optional — never "if the blob parses, trust it".
  let coverage = null;
  let model = null;
  try {
    const src = JSON.parse(row.source_json || "null");
    if (src && typeof src === "object") {
      if (typeof src.coverage === "number" && src.coverage >= 0 && src.coverage <= 1) {
        coverage = src.coverage;
      }
      // YYYY.MM, per SCORE_MODEL_VERSION. The shape check is not only about
      // XML safety — escapeXml covers that — it is about layout: this string
      // is measured to size a chip on a 1200px card, and an unbounded value
      // from a free-form blob would push it off the edge.
      //
      // Deliberately NOT defaulted to SCORE_MODEL_VERSION when absent.
      // Stamping today's model onto a row produced by an unknown older one is
      // a fabrication, and it defeats the reason the version is persisted at
      // all: so a trend line spanning a model change can say so.
      if (typeof src.model === "string" && /^\d{4}\.\d{2}$/.test(src.model)) {
        model = src.model;
      }
    }
  } catch { /* pre-coverage or malformed blob — everything stays null */ }
  return { score: row.score, computed_at: row.computed_at, coverage, model };
}

export async function handleScoreBadge(request, env, walletPath) {
  // walletPath is e.g. "0xabc….svg" — strip the extension.
  const m = /^(0x[0-9a-fA-F]{40})\.svg$/.exec(walletPath || "");
  if (!m) {
    return badgeResponse(
      svg({ score: "—", meta: UNKNOWN_BAND, label: "DeFi Score", sublabel: "invalid" }),
      { status: 400, cacheSecs: 60 },
    );
  }
  const addr = m[1].toLowerCase();

  const row = await latestScoreFor(env, addr).catch(() => null);
  if (!row || !Number.isFinite(row.score)) {
    return badgeResponse(
      svg({ score: "—", meta: UNKNOWN_BAND, label: "DeFi Score", sublabel: "no scan yet" }),
      { cacheSecs: 60 },
    );
  }

  const meta = bandMeta(row.score);
  // A score computed from partial data must not render identically to one
  // backed by every pillar — the badge is the one public surface, and a bare
  // number implies full confidence. Full coverage (or unknown, on rows that
  // predate the field) keeps the plain band label; anything partial appends
  // the observed-data share.
  const partial = row.coverage != null && row.coverage < 1;
  return badgeResponse(svg({
    score: String(row.score),
    meta,
    label: "DeFi Score",
    sublabel: partial ? `${meta.label} · ${Math.round(row.coverage * 100)}% data` : meta.label,
  }));
}
