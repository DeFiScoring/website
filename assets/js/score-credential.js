/* DeFiScoring — the shared pieces of the score credential.
 *
 * The gauge and the coverage meter appear on two pages that load different
 * scripts (/dashboard/ and /dashboard/score/), and they are genuinely the SAME
 * drawing: same 240° arc, same band ring, same ticks, same readout. That is
 * worth sharing — unlike the four gauges score-bands.js deliberately left
 * alone, which differ on rotation, radius, paint and fill mechanism and only
 * looked alike.
 *
 * Assigns to globalThis (not window) so Node can load it, which is what lets
 * test/facts.mjs check the geometry rather than trusting a screenshot. Nothing
 * here touches the DOM — every function returns a markup string.
 */
(function () {
  "use strict";

  var B = (typeof globalThis !== "undefined" ? globalThis : this).DefiBands;

  // 240° of arc opening at the bottom, so the low end and the high end are
  // both visible and the number sits in the gap.
  var CX = 110, CY = 110, R = 90, SW = 14;
  var START = 150, SWEEP = 240;
  var RING = 2 * Math.PI * R;
  var ARC = RING * (SWEEP / 360);

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }

  function polar(v, radius) {
    var a = (START + SWEEP * B.fraction(v)) * Math.PI / 180;
    return { x: CX + radius * Math.cos(a), y: CY + radius * Math.sin(a) };
  }

  // Each band gets a slice of the ring proportional to its width in points, so
  // the ring is a legend as well as a track — you can see how wide "Excellent"
  // is without reading a number.
  function bandRing(dimmed) {
    var out = "", cum = 0;
    // A <circle>'s dash pattern starts at 3 o'clock and runs clockwise, while
    // the arc starts at START. Without this head start the ring sits 150° away
    // from the ticks labelling it — plausible-looking and meaningless.
    var origin = RING * (START / 360);
    var ordered = B.BANDS.slice().reverse();
    for (var i = 0; i < ordered.length; i++) {
      var b = ordered[i];
      var span = ((b.ceil - b.floor + 1) / (B.MAX - B.MIN)) * ARC;
      var len = Math.max(0, span - 2);
      out += '<circle cx="' + CX + '" cy="' + CY + '" r="' + R + '" fill="none"' +
        ' stroke="' + (dimmed ? "rgba(255,255,255,0.09)" : b.color) + '"' +
        ' stroke-opacity="' + (dimmed ? 1 : 0.3) + '" stroke-width="' + SW + '"' +
        ' stroke-dasharray="' + len.toFixed(2) + " " + (RING - len).toFixed(2) + '"' +
        ' stroke-dashoffset="' + (-(origin + cum)).toFixed(2) + '"></circle>';
      cum += span;
    }
    return out;
  }

  function tickMarks() {
    var marks = [B.MIN]
      .concat(B.BANDS.slice().reverse().map(function (b) { return b.floor; }).slice(1))
      .concat([B.MAX]);
    return marks.map(function (v) {
      var a = polar(v, R - SW / 2 - 4), b2 = polar(v, R + SW / 2 + 3), lab = polar(v, R + SW / 2 + 13);
      return '<line x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) +
        '" x2="' + b2.x.toFixed(1) + '" y2="' + b2.y.toFixed(1) +
        '" stroke="rgba(255,255,255,0.22)" stroke-width="1"></line>' +
        '<text x="' + lab.x.toFixed(1) + '" y="' + lab.y.toFixed(1) +
        '" text-anchor="middle" dominant-baseline="middle" class="defi-cred__tick">' + v + '</text>';
    }).join("");
  }

  /** The gauge: band ring, value arc, ticks, and the number in the middle. */
  function gaugeHtml(score) {
    var scored = score != null;
    var meta = scored ? B.forScore(score) : B.UNKNOWN;
    var frac = scored ? B.fraction(score) : 0;
    var start = polar(B.MIN, R), end = polar(scored ? score : B.MIN, R);
    var value = scored && frac > 0
      ? '<path d="M ' + start.x.toFixed(1) + " " + start.y.toFixed(1) +
        " A " + R + " " + R + " 0 " + (SWEEP * frac > 180 ? 1 : 0) + " 1 " +
        end.x.toFixed(1) + " " + end.y.toFixed(1) + '" fill="none" stroke="' + meta.color +
        '" stroke-width="' + SW + '" stroke-linecap="round"></path>'
      : "";
    return '<svg viewBox="0 0 220 234" width="240" height="255" role="img" aria-label="' +
        esc(scored ? "Score " + score + " out of 850, " + meta.label : "Not scored") + '">' +
        bandRing(!scored) + value + tickMarks() +
      '</svg>' +
      '<div class="defi-cred__readout">' +
        '<div class="defi-cred__score"' + (scored ? "" : ' style="color:' + B.UNKNOWN.color + '"') + '>' +
          (scored ? score : "—") + '</div>' +
        '<div class="defi-cred__scale">' + (scored ? "out of 850" : "not scored") + '</div>' +
      '</div>';
  }

  /**
   * Coverage as a weighted meter: one segment per pillar, sized by its weight,
   * hatched when estimated. "72% live data" never told anyone WHICH part of
   * their score was a guess; this does, and names it underneath.
   */
  function coverageHtml(factors, coverage, scored) {
    var segs = factors.map(function (f) {
      var src = B.sourceFor(f.real, f.value != null);
      return '<span class="defi-cov__seg' + (src.key === "observed" ? " is-live" : "") +
        '" style="flex:' + (f.weight || 1) + ' 0 0" title="' +
        esc((f.short || f.name) + " · " + src.label) + '"></span>';
    }).join("");
    var live = factors.filter(function (f) { return f.real && f.value != null; });
    var est = factors.filter(function (f) { return !f.real && f.value != null; });
    var pct = typeof coverage === "number" ? Math.round(coverage * 100) : null;
    var legend = !scored
      ? "0 of " + factors.length + " pillars read — nothing to measure yet"
      : live.length + " of " + factors.length + " pillars on live data" +
        (est.length
          ? " · " + est.map(function (f) { return f.short || f.name; }).join(" and ") + " estimated"
          : " · no estimates");
    return '<div class="defi-cov__head">' +
        '<span class="defi-cov__pct" style="color:' +
          (!scored ? B.UNKNOWN.color : pct >= 80 ? "#2bd4a4" : pct >= 60 ? "#00f5ff" : "#facc15") + '">' +
          (pct == null ? "—" : pct + "%") + '</span>' +
        '<span class="defi-cov__cap">live data</span>' +
      '</div>' +
      '<div class="defi-cov__bar">' + segs + '</div>' +
      '<div class="defi-cov__legend">' + esc(legend) + '</div>';
  }

  /**
   * What each pillar actually contributed, in points: weight × value / 100.
   *
   * This is the number that has never been on the dashboard. The home page's
   * chart plotted the WEIGHTS — a constant 35/25/15/10/15 identical for every
   * wallet — so it told a reader nothing about their own score. These five
   * contributions sum to the weighted pillar score, which is the first row of
   * the ledger on /dashboard/score/ and the number that maps onto 300–850.
   */
  function contribution(f) {
    if (!f || f.value == null) return 0;
    return (f.weight || 0) * f.value / 100;
  }

  function contributionHtml(factors) {
    var max = factors.reduce(function (m, f) { return Math.max(m, f.weight || 0); }, 1);
    var total = factors.reduce(function (s, f) { return s + contribution(f); }, 0);
    var rows = factors.map(function (f) {
      var src = B.sourceFor(f.real, f.value != null);
      var pts = contribution(f);
      // The track is as wide as the pillar's weight allows, so a full 10%
      // governance bar cannot look like a bigger contribution than a
      // half-filled 35% loan-reliability one.
      return '<div class="defi-contrib' + (src.key === "observed" ? "" : " is-" + src.key) + '"' +
        ' data-factor-name="'   + esc(f.name) + '"' +
        ' data-factor-value="'  + (f.value == null ? "" : esc(f.value)) + '"' +
        ' data-factor-weight="' + esc(f.weight) + '"' +
        ' data-factor-detail="' + esc(f.detail || "") + '"' +
        ' data-factor-real="'   + (f.real ? "true" : "false") + '"' +
        ' role="button" tabindex="0" title="Click for breakdown">' +
        '<div class="defi-contrib__row">' +
          '<span class="defi-contrib__name">' +
            '<span style="color:' + src.color + '" title="' + esc(src.label) + '">' + src.glyph + '</span> ' +
            esc((f.name || "").split(" (")[0]) +
            '<span class="defi-contrib__weight">' + esc(f.weight) + '%</span>' +
          '</span>' +
          '<span class="defi-contrib__pts"><b>' + (Math.round(pts * 100) / 100) + '</b> pts</span>' +
        '</div>' +
        '<div class="defi-contrib__track" style="width:' + ((f.weight || 0) / max * 100).toFixed(1) + '%">' +
          '<div class="defi-contrib__fill" style="width:' + (f.value == null ? 0 : f.value) + '%"></div>' +
        '</div>' +
        (f.detail ? '<div class="defi-contrib__why">' + esc(f.detail) + '</div>' : "") +
      '</div>';
    }).join("");
    return rows +
      '<div class="defi-contrib__total">' +
        '<span>Weighted pillar score</span>' +
        '<span><b>' + (Math.round(total * 100) / 100) + '</b> / 100</span>' +
      '</div>';
  }

  var g = typeof globalThis !== "undefined" ? globalThis : this;
  g.DefiCredential = {
    CX: CX, CY: CY, R: R, SW: SW, START: START, SWEEP: SWEEP,
    polar: polar, gaugeHtml: gaugeHtml, coverageHtml: coverageHtml,
    contribution: contribution, contributionHtml: contributionHtml,
  };
})();
