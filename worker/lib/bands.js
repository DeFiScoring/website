/* Score band presentation — colour, glyph, mark and range.
 *
 * `worker/lib/score.js` owns the MODEL: which score falls in which band, and
 * what that band is called. This file owns how a band is DRAWN, and nothing
 * else. The split is deliberate — score.js is 600 lines of pillar arithmetic
 * and hex codes have no business in it, and keeping the two apart lets
 * test/facts.mjs pin the numeric axis and the presentation axis separately.
 *
 * There is a second copy of this table at assets/js/score-bands.js, because
 * the browser and the Worker are two bundles that cannot import each other:
 * wrangler's entry point is worker/index.js, `_site` is a static asset
 * directory rather than part of the module graph, and the files under
 * assets/js are plain IIFEs with no exports. The duplication is therefore
 * structural and permanent. What is NOT permitted is drift, so test/facts.mjs
 * loads both and asserts they agree — on the table, and on the behaviour of
 * every integer from 300 to 850.
 *
 * Change a colour or a glyph here and you must change it there in the same
 * commit. The test will tell you if you forget.
 */

import { BANDS, bandForScore } from './score.js';

export const SCORE_MIN = 300;
export const SCORE_MAX = 850;

// Presentation, keyed by the band keys score.js already defines. Order matches
// BANDS: highest floor first.
const PRESENTATION = {
  excellent: { color: '#2bd4a4', glyph: '★', mark: 'star' },
  good:      { color: '#00f5ff', glyph: '▲', mark: 'triangle-up' },
  fair:      { color: '#facc15', glyph: '◆', mark: 'diamond' },
  poor:      { color: '#ff5d6c', glyph: '▼', mark: 'triangle-down' },
};

/**
 * BANDS with a ceiling and a look. The ceiling is DERIVED from the next band's
 * floor, never typed: the ranges are published in three places (the share
 * card's Band chip, index.html's legend, methodology.md's table) and a typed
 * `ceil: 719` sitting beside `floor: 660` is exactly the drift this module
 * exists to prevent.
 */
export const BAND_META = BANDS.map((b, i) => ({
  ...b,
  ceil: i === 0 ? SCORE_MAX : BANDS[i - 1].floor - 1,
  ...PRESENTATION[b.key],
}));

/**
 * The absence of a score is a state with a name, not a blank. It used to have
 * two greys (#7c8a9b here and in methodology.md, #8b8b99 on the dashboard) and
 * three labels ("Not scored" on the card, "Unscored" on the dashboard,
 * "Unknown" from the badge's capitalise-the-key path) for one condition.
 */
export const UNKNOWN_BAND = {
  key: 'unknown',
  label: 'Not scored',
  floor: null,
  ceil: null,
  color: '#7c8a9b',
  glyph: '○',
  mark: 'ring',
};

/**
 * Band marks as geometry rather than characters, for anything rasterised
 * outside our control.
 *
 * The card and badge are rendered by Slack, Discord, Telegram, LinkedIn and
 * iMessage with whatever fonts those have — `font-family="Inter,…"` resolves
 * to none of them. U+2605 (★), U+25C6 (◆) and U+25D4 (◔) are outside WGL4, so
 * a text glyph there is a coin flip between the mark and a tofu box, and a
 * tofu box where the colourblind-safe affordance should be is worse than
 * nothing. A <path> has no font dependency at all.
 *
 * Drawn in a unit box from -1 to 1 so one `translate(x y) scale(s)` serves any
 * size. The browser keeps the character glyphs — HTML font fallback is
 * generous and we control that page.
 */
export const MARK_PATHS = {
  star: 'M0 -1 L0.2245 -0.309 L0.9511 -0.309 L0.3633 0.118 L0.5878 0.809 ' +
        'L0 0.382 L-0.5878 0.809 L-0.3633 0.118 L-0.9511 -0.309 L-0.2245 -0.309 Z',
  'triangle-up': 'M0 -1 L0.9 0.6 L-0.9 0.6 Z',
  diamond: 'M0 -1 L1 0 L0 1 L-1 0 Z',
  'triangle-down': 'M0 1 L0.9 -0.6 L-0.9 -0.6 Z',
};

/** The band a score belongs to, or UNKNOWN_BAND when there is no score. */
export function bandMeta(score) {
  if (!Number.isFinite(score)) return UNKNOWN_BAND;
  const key = bandForScore(score);
  return BAND_META.find((b) => b.key === key) || UNKNOWN_BAND;
}

/** "720–850". En dash, matching index.html's legend and methodology.md. */
export function rangeLabel(meta) {
  if (!meta || meta.floor == null) return null;
  return `${meta.floor}–${meta.ceil}`;
}

/**
 * Where a score sits on the 300–850 scale, 0..1. Every gauge in the product
 * computes this, and every one of them writes it slightly differently
 * ((score-min)/(max-min), (score-300)/550). Same value; one place now.
 */
export function fractionOf(score) {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(1, (score - SCORE_MIN) / (SCORE_MAX - SCORE_MIN)));
}

/**
 * A band mark as an SVG fragment, centred on (x, y) and `size` px across.
 * Returns "" for a band with no mark rather than throwing — a card is not
 * worth failing over an unrecognised key.
 */
export function markSvg(meta, x, y, size, fill) {
  if (!meta) return '';
  const s = size / 2;
  // The badge paints its whole right-hand cell in the band colour, so the mark
  // there needs the cell's ink rather than the band's. Everywhere else the
  // band colour is the right answer and this stays defaulted.
  const paint = fill || meta.color;
  if (meta.mark === 'ring') {
    return `<g transform="translate(${x} ${y}) scale(${s})" aria-hidden="true">` +
      `<circle cx="0" cy="0" r="1" fill="none" stroke="${paint}" stroke-width="0.2"/></g>`;
  }
  const d = MARK_PATHS[meta.mark];
  if (!d) return '';
  return `<g transform="translate(${x} ${y}) scale(${s})" aria-hidden="true">` +
    `<path d="${d}" fill="${paint}"/></g>`;
}
