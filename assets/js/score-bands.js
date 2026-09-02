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

  // Where a pillar's data came from, on the same three-way footing as a band:
  // observed, estimated, or nothing read at all. The last is not the same as a
  // zero — a pillar we could not read is not a pillar that scored badly.
  var SOURCES = {
    observed:  { key: "observed",  label: "observed",     glyph: "●", color: "#2bd4a4" },
    estimated: { key: "estimated", label: "estimated",    glyph: ESTIMATED_GLYPH, color: "#facc15" },
    absent:    { key: "absent",    label: "nothing read", glyph: "○", color: "#7c8a9b" },
  };

  /*
   * The 0–100 PILLAR scale — a different scale from the 300–850 band, and now
   * with different words for it.
   *
   * score-breakdown.js used to label a pillar value "Excellent / Good / Fair /
   * Needs work" at 80/60/40 with its own hard-coded hexes. Three of those words
   * also name 300–850 bands, at thresholds that have nothing to do with these,
   * so "Good" meant two things depending on which number it sat next to — and
   * the credential puts pillar values directly beside the band. Different
   * scale, different vocabulary, and a glyph so neither is carried by colour
   * alone.
   */
  /*
   * A constant-width three-slot meter rather than one symbol per tier. A single
   * hollow shape (▯, □) is a bad choice here even though it renders fine: it
   * looks exactly like a font's missing-glyph box, so a reader cannot tell
   * "Thin" from "your font failed". A filled/unfilled ramp is unmistakably
   * deliberate, ordinal at a glance, and survives greyscale.
   */
  var PILLAR_TIERS = [
    { key: "strong", label: "Strong", floor: 80, glyph: "▰▰▰", color: "#2bd4a4" },
    { key: "solid",  label: "Solid",  floor: 60, glyph: "▰▰▱", color: "#00f5ff" },
    { key: "thin",   label: "Thin",   floor: 40, glyph: "▰▱▱", color: "#facc15" },
    { key: "weak",   label: "Weak",   floor: 0,  glyph: "▱▱▱", color: "#ff5d6c" },
  ];

  var PILLAR_UNKNOWN = {
    key: "none", label: "no data", floor: null, glyph: "○", color: "#7c8a9b",
  };

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
    SOURCES: SOURCES,
    PILLAR_TIERS: PILLAR_TIERS,
    PILLAR_UNKNOWN: PILLAR_UNKNOWN,

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

    /** Where a pillar's number came from: observed, estimated, or nothing. */
    sourceFor: function (real, hasValue) {
      if (hasValue === false) return SOURCES.absent;
      return real ? SOURCES.observed : SOURCES.estimated;
    },

    /** A 0–100 pillar value's tier. NOT a band — see PILLAR_TIERS. */
    pillarTier: function (value) {
      var n = typeof value === "number" ? value : NaN;
      if (!isFinite(n)) return PILLAR_UNKNOWN;
      for (var i = 0; i < PILLAR_TIERS.length; i++) {
        if (n >= PILLAR_TIERS[i].floor) return PILLAR_TIERS[i];
      }
      return PILLAR_TIERS[PILLAR_TIERS.length - 1];
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
