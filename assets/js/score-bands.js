/* DeFiScoring — the score band vocabulary, browser half.
 *
 * One table for what a band is called, what colour it is, and which glyph
 * carries it when colour cannot: under deuteranopia, in greyscale, on a
 * printed page. That last part is why the glyph exists at all — a band
 * encoded only as a hue is a band that a tenth of readers cannot read.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE IS ONE OF TWO COPIES. The other is worker/lib/bands.js.
 *
 * They cannot import each other: wrangler bundles worker/index.js, `_site` is
 * a static asset directory rather than part of that module graph, and the
 * files in assets/js are plain IIFEs served as <script> tags with no build
 * step. So the duplication is structural. Drift is not: test/facts.mjs loads
 * this file and the worker's and asserts they agree — on every field, and on
 * the band and fraction of every integer from 300 to 850.
 *
 * Edit one, edit the other, in the same commit.
 * ---------------------------------------------------------------------------
 *
 * Assigns to globalThis rather than window on purpose: that is what lets Node
 * import it, which is what makes the drift test an executable comparison
 * instead of a regex over source text. Nothing here touches the DOM.
 */
(function () {
  "use strict";

  var MIN = 300;
  var MAX = 850;

  // key/label/floor mirror worker/lib/score.js BANDS; color/glyph/mark mirror
  // worker/lib/bands.js. Highest floor first — order is asserted.
  var TABLE = [
    { key: "excellent", label: "Excellent", floor: 720, color: "#2bd4a4", glyph: "★", mark: "star" },
    { key: "good",      label: "Good",      floor: 660, color: "#00f5ff", glyph: "▲", mark: "triangle-up" },
    { key: "fair",      label: "Fair",      floor: 580, color: "#facc15", glyph: "◆", mark: "diamond" },
    { key: "poor",      label: "Poor",      floor: 300, color: "#ff5d6c", glyph: "▼", mark: "triangle-down" },
  ];

  // Derived, never typed — see the note in worker/lib/bands.js. The ranges are
  // published on the share card, index.html's legend and methodology.md, and a
  // hand-typed ceiling next to a floor is how those three disagree.
  var BANDS = TABLE.map(function (b, i) {
    return Object.assign({}, b, { ceil: i === 0 ? MAX : TABLE[i - 1].floor - 1 });
  });

  var UNKNOWN = {
    key: "unknown", label: "Not scored", floor: null, ceil: null,
    color: "#7c8a9b", glyph: "○", mark: "ring",
  };

  // A PILLAR state, not a band: `pillars[k].real === false` means that pillar
  // was a neutral placeholder rather than something we observed. Kept out of
  // the band table so nobody renders it in a band slot — an estimated pillar
  // does not make the wallet's band estimated.
  var ESTIMATED_GLYPH = "◔";

  function forScore(score) {
    var n = typeof score === "number" ? score : NaN;
    if (!isFinite(n)) return UNKNOWN;
    for (var i = 0; i < BANDS.length; i++) {
      if (n >= BANDS[i].floor) return BANDS[i];
    }
    return BANDS[BANDS.length - 1];
  }

  var api = {
    MIN: MIN,
    MAX: MAX,
    BANDS: BANDS,
    UNKNOWN: UNKNOWN,
    ESTIMATED_GLYPH: ESTIMATED_GLYPH,

    forScore: forScore,
    keyFor:   function (score) { return forScore(score).key; },
    labelFor: function (score) { return forScore(score).label; },
    colorFor: function (score) { return forScore(score).color; },
    glyphFor: function (score) { return forScore(score).glyph; },

    /** "720–850", or null for the unscored state. */
    rangeFor: function (key) {
      for (var i = 0; i < BANDS.length; i++) {
        if (BANDS[i].key === key) return BANDS[i].floor + "–" + BANDS[i].ceil;
      }
      return null;
    },

    /*
     * The existing CSS classes are Title-case (.defi-band--Excellent), built
     * by string concatenation at several call sites. They stay that way:
     * dashboard-risk.js deliberately borrows them for a different 0–100 scale,
     * so renaming drags that file into scope, and adding lowercase duplicates
     * alongside would be more duplication rather than less. This function is
     * the single authority for the mapping; the legacy shape is cosmetic debt.
     */
    className: function (score) {
      var b = typeof score === "string" ? null : forScore(score);
      var label = b ? b.label : null;
      if (!label) {
        for (var i = 0; i < BANDS.length; i++) {
          if (BANDS[i].key === score) label = BANDS[i].label;
        }
      }
      return label ? "defi-band--" + label : "";
    },

    /** Position on the 300–850 scale, 0..1. Every gauge needs this. */
    fraction: function (score) {
      var n = typeof score === "number" ? score : NaN;
      if (!isFinite(n)) return 0;
      return Math.max(0, Math.min(1, (n - MIN) / (MAX - MIN)));
    },
  };

  var g = typeof globalThis !== "undefined" ? globalThis : this;
  g.DefiBands = api;
})();
