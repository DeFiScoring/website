/* DeFiScoring — /dashboard/score/
 *
 * The score page as a credential: not just a number, but where the number came
 * from and what would move it.
 *
 * The thing that changed here is the LEDGER. worker/lib/score.js computes
 *
 *     base  = round(300 + Hs/100 * 550)      // Hs is the weighted pillar score
 *     total = base + Σ adjustment deltas
 *     score = clamp(total, 300, 850)
 *
 * and every one of those terms has been on the client object since the API was
 * wired up — `raw_h_s`, `adjustments[]`, `score`. mapWalletScore's comment says
 * it kept them structured precisely so this could be drawn. Until now the only
 * place any of it surfaced was flattened into a sentence, which meant the −150
 * liquidation penalty was something the score had rather than something the
 * page could show.
 *
 * The clamp is a real row, not a footnote. Reachable `base` is [395, 840] and
 * the deltas span −200..+80, so the pre-clamp total reaches [195, 920] — and
 * the ceiling is the easy end: any wallet at Hs ≥ 94.55 with both bonuses tops
 * out at 850. Without the row, someone at 850 who loses the multichain bonus
 * sees no change while the ledger claims they should have dropped 30.
 */
(function () {
  "use strict";

  var B = window.DefiBands;

  function el(id) { return document.getElementById(id); }

  function setNotice(id, text) {
    var node = el(id);
    if (!node) return;
    if (!text) { node.style.display = "none"; node.textContent = ""; return; }
    node.style.display = ""; node.textContent = text;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }

  var C = window.DefiCredential;

  /* ---------------- gauge + coverage (shared with /dashboard/) ------------ */

  function drawGauge(score) {
    var host = el("score-circle");
    if (!host) return B.UNKNOWN;
    var scored = score != null;
    var meta = scored ? B.forScore(score) : B.UNKNOWN;
    host.innerHTML = C.gaugeHtml(scored ? score : null);

    var pill = el("score-band-pill");
    if (pill) {
      pill.className = "defi-cred__band " + (scored ? B.className(score) : "");
      pill.style.color = scored ? "" : B.UNKNOWN.color;
      pill.textContent = meta.glyph + " " + meta.label + (scored ? " · " + B.rangeFor(meta.key) : "");
    }
    return meta;
  }

  function drawCoverage(factors, coverage, scored) {
    var host = el("score-coverage");
    if (host) host.innerHTML = C.coverageHtml(factors, coverage, scored);
  }

  /* ---------------- pillar cards ---------------- */

  function drawFactors(factors) {
    var wrap = el("score-factors");
    if (!wrap) return;
    // Every row keeps the four data-factor-* attributes score-breakdown.js
    // delegates on, plus data-factor-real so the modal can tell an estimated
    // pillar from an observed one. The attribute is always emitted — an absent
    // one becomes NaN through Number() and renders "NaN / 100".
    wrap.innerHTML = factors.map(function (f) {
      var src = B.sourceFor(f.real, f.value != null);
      var tier = B.pillarTier(f.value);
      var improve = window.DefiScoreBreakdown
        ? window.DefiScoreBreakdown.improveFor(f.name, f.real, f.value != null)
        : "";
      var fill = f.value == null ? 0 : Math.max(0, Math.min(100, Number(f.value) || 0));
      return '<div class="defi-factor' + (src.key === "observed" ? "" : " is-" + src.key) + '"' +
        ' role="button" tabindex="0"' +
        ' data-factor-name="'   + esc(f.name) + '"' +
        ' data-factor-value="'  + (f.value == null ? "" : esc(f.value)) + '"' +
        ' data-factor-weight="' + esc(f.weight) + '"' +
        ' data-factor-detail="' + esc(f.detail || "") + '"' +
        ' data-factor-real="'   + (f.real ? "true" : "false") + '"' +
        ' title="Click for breakdown">' +
          '<div class="defi-factor__row">' +
            '<span class="defi-factor__name">' +
              '<span class="defi-factor__src" style="color:' + src.color + '" title="' + esc(src.label) + '">' +
                src.glyph + '</span> ' + esc(f.name) +
            '</span>' +
            '<span class="defi-factor__num">' +
              '<b style="color:' + tier.color + '">' + (f.value == null ? "—" : esc(f.value)) + '</b>' +
              '<span class="defi-factor__of"> / 100</span>' +
              '<span class="defi-factor__weight">' + esc(f.weight) + '% weight</span>' +
            '</span>' +
          '</div>' +
          '<div class="defi-factor__bar"><div class="defi-factor__fill" style="width:' + fill + '%"></div></div>' +
          (f.detail ? '<div class="defi-factor__detail">' + esc(f.detail) + '</div>' : "") +
          (improve ? '<div class="defi-factor__improve"><span>Next</span> ' + esc(improve) + '</div>' : "") +
        '</div>';
    }).join("");

    wrap.querySelectorAll("[data-factor-name]").forEach(function (row) {
      row.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); row.click(); }
      });
    });
  }

  /* ---------------- the ledger ---------------- */

  function ledgerRow(cls, label, detail, amount) {
    return '<div class="defi-ledger__row ' + cls + '">' +
      '<div class="defi-ledger__label">' + esc(label) +
        (detail ? '<span class="defi-ledger__detail">' + esc(detail) + '</span>' : "") +
      '</div>' +
      '<div class="defi-ledger__amt">' + esc(amount) + '</div>' +
    '</div>';
  }

  // The engine's own names, not the payload's. `aave_safe_lender` and
  // `liquidation_risk` are NOT Aave-specific — lowestHealthFactor is the
  // minimum across Aave V3, Spark, Compound V3 and Morpho Blue — so labelling
  // the row "Aave" would attribute the adjustment to a protocol the wallet may
  // never have touched.
  var ADJ_LABEL = {
    aave_safe_lender:  "Safe lender",
    multichain_user:   "Active across chains",
    liquidation_risk:  "Liquidation risk",
    over_concentrated: "Over-concentrated",
  };
  var ADJ_NOTE = {
    // Disclosed rather than hidden: the same signal already lifts the
    // portfolio-health pillar by 10, so this is not an independent +30.
    multichain_user: "Chain spread also counts inside portfolio health",
  };

  // Returns true when the ledger actually rendered, so refresh() can drop the
  // prose restatement of the same adjustments from the notice line.
  function drawLedger(data) {
    var card = el("score-ledger-card");
    var host = el("score-ledger");
    var note = el("score-ledger-note");
    if (!card || !host) return false;

    var adjustments = data.adjustments || [];
    if (!data.scored || data.score == null || typeof data.raw_h_s !== "number") {
      card.style.display = "none";
      return false;
    }
    card.style.display = "";

    var base = Math.round(300 + (data.raw_h_s / 100) * 550);
    // A legacy payload carries adjustments as bare strings, normalised to a
    // null delta. Nothing can be summed then, so the rows are listed without
    // the running arithmetic rather than quietly totalling a subset.
    var summable = adjustments.every(function (a) { return typeof a.delta === "number"; });

    var rows = ledgerRow("is-base", "Weighted pillar score",
      data.raw_h_s.toFixed(2) + " / 100 mapped onto 300–850", String(base));

    adjustments.forEach(function (a) {
      var amount = typeof a.delta === "number" ? (a.delta > 0 ? "+" : "−") + Math.abs(a.delta) : "—";
      rows += ledgerRow(typeof a.delta === "number" && a.delta < 0 ? "is-down" : "is-up",
        ADJ_LABEL[a.name] || a.name,
        [a.reason, ADJ_NOTE[a.name]].filter(Boolean).join(" · "),
        amount);
    });

    if (summable) {
      var total = adjustments.reduce(function (s, a) { return s + a.delta; }, base);
      // The clamp is a term in the arithmetic, so it gets a row whenever it
      // moves the number. Silently absorbing it makes the column not add up.
      if (total !== data.score) {
        var d = data.score - total;
        rows += ledgerRow("is-clamp",
          d < 0 ? "Capped at " + B.MAX : "Floor applied at " + B.MIN,
          d < 0 ? "The scale ends at " + B.MAX : "The scale starts at " + B.MIN,
          (d > 0 ? "+" : "−") + Math.abs(d));
      }
      rows += ledgerRow("is-total", "Final score", B.forScore(data.score).label, String(data.score));
    }

    host.innerHTML = rows;
    if (note) {
      note.textContent = summable
        ? "Every row above is applied by the scoring engine in this order. Bonuses and penalties are absolute point values, not percentages."
        : "This score came from the legacy endpoint, which reports its adjustments as text without point values — so they are listed but not totalled.";
    }
    return true;
  }

  /* ---------------- trend ---------------- */

  // Its own fetch: getScore() hard-codes history: [], and the history endpoint
  // is the only thing that carries the model version per point.
  //
  // Drawn even when today's scan produced no score. A wallet can come back
  // unscored because a source was unreachable, not because it has no past —
  // and the scores it already earned remain facts. Hiding them would discard
  // information we hold; the credential above already says "Not scored" without
  // ambiguity. When there genuinely is no history the card stays hidden.
  async function drawTrend(wallet) {
    var card = el("score-trend-card");
    var host = el("score-trend");
    var note = el("score-trend-note");
    if (!card || !host) return;
    card.style.display = "none";
    try {
      var base = (window.DefiAPI && window.DefiAPI.apiBase) || "";
      var res = await fetch(base + "/api/health-score/" + encodeURIComponent(wallet) + "/history?days=365",
        { credentials: "include" });
      if (!res.ok) return;
      var j = await res.json();
      var history = (j && j.history) || [];
      if (history.length < 2) return;

      var vals = history.map(function (h) { return h.score; }).filter(function (v) { return typeof v === "number"; });
      if (vals.length < 2) return;
      var lo = Math.min.apply(null, vals) - 20, hi = Math.max.apply(null, vals) + 20;
      var W = 100, H = 40;
      var x = function (i) { return (i / (history.length - 1)) * W; };
      var y = function (v) { return H - ((v - lo) / (hi - lo)) * H; };
      var pts = history.map(function (h, i) { return x(i).toFixed(2) + "," + y(h.score).toFixed(2); });

      // Only a change BETWEEN two known versions is a change. null → "2026.08"
      // is a row written before versioning, not a model that moved.
      var marks = [];
      for (var i = 1; i < history.length; i++) {
        if (history[i - 1].model && history[i].model && history[i - 1].model !== history[i].model) {
          marks.push({ x: x(i), label: history[i].model });
        }
      }

      var guides = B.BANDS.map(function (b) {
        if (b.floor <= lo || b.floor >= hi) return "";
        return '<line x1="0" y1="' + y(b.floor).toFixed(2) + '" x2="100" y2="' + y(b.floor).toFixed(2) +
          '" stroke="' + b.color + '" stroke-opacity="0.22" stroke-width="0.4" stroke-dasharray="2 2"></line>';
      }).join("");

      host.innerHTML =
        '<svg viewBox="0 0 100 40" preserveAspectRatio="none" class="defi-trend__svg">' +
          guides +
          marks.map(function (m) {
            return '<line x1="' + m.x.toFixed(2) + '" y1="0" x2="' + m.x.toFixed(2) + '" y2="40"' +
              ' stroke="#a855f7" stroke-opacity="0.55" stroke-width="0.5" stroke-dasharray="1.5 1.5"></line>';
          }).join("") +
          '<polyline points="' + pts.join(" ") + '" fill="none" stroke="#00f5ff" stroke-width="1"' +
          ' stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"></polyline>' +
        '</svg>' +
        marks.map(function (m) {
          return '<span class="defi-trend__mark" style="left:' + m.x.toFixed(2) + '%">model ' + esc(m.label) + '</span>';
        }).join("");

      card.style.display = "";
      if (note) {
        note.textContent = history.length + " snapshots" +
          (marks.length ? " · dashed purple marks where the scoring model changed" : "") +
          (j.tier_cap_days ? " · " + j.days_applied + " days shown on your plan" : "");
      }
    } catch (e) { /* cosmetic — never break the score page over the trend */ }
  }

  /* ---------------- share ---------------- */

  function drawShare(wallet, scored) {
    var btn = el("score-share-btn");
    var note = el("score-share-note");
    if (!btn) return;
    if (!scored) {
      btn.disabled = true;
      btn.textContent = "Share unavailable";
      if (note) note.textContent = "There is no number to share yet.";
      return;
    }
    btn.disabled = false;
    btn.textContent = "Share score card";
    if (note) note.textContent = "A 1200×630 image. Truncated address only — no balances, no full address.";
    btn.onclick = function () {
      var base = (window.DefiAPI && window.DefiAPI.apiBase) || "";
      window.open(base + "/share/" + encodeURIComponent(wallet), "_blank", "noopener");
    };
  }

  /* ---------------- headline ---------------- */

  function drawSummary(data, meta) {
    var head = el("score-headline");
    var stamp = el("score-stamp");
    if (head) {
      if (!data.scored || data.score == null) {
        head.textContent = "No score yet — nothing has been read on-chain for this wallet.";
      } else if (meta.key === "excellent") {
        head.textContent = (data.score - meta.floor) + " points clear of the Excellent threshold.";
      } else {
        head.textContent = (720 - data.score) + " points from Excellent (720).";
      }
    }
    if (stamp) {
      var bits = [];
      if (data.updated_at) bits.push("Computed " + new Date(data.updated_at).toLocaleString());
      if (data.model) bits.push("model " + data.model);
      stamp.textContent = bits.join(" · ");
    }
  }

  /* ---------------- orchestration ---------------- */

  async function refresh() {
    var wallet = window.DefiState.wallet;
    var empty = el("score-empty");
    var main = el("score-main");
    if (!wallet) { empty.style.display = ""; main.style.display = "none"; return; }
    empty.style.display = "none"; main.style.display = "";

    setNotice("score-notice", "Computing on-chain score…");
    try {
      var data = await window.DefiAPI.getScore(wallet);
      var scored = data.scored !== false && data.score != null;
      var meta = drawGauge(scored ? data.score : null);
      drawCoverage(data.factors, data.coverage, scored);
      drawFactors(data.factors);
      var ledgerShown = drawLedger(data);
      drawSummary(data, meta);
      drawShare(wallet, scored);
      var updated = el("score-updated");
      if (updated) updated.textContent = data.updated_at ? "Last updated " + new Date(data.updated_at).toLocaleString() : "";
      // mapWalletScore pre-joins its notes with " • ", and one of them is a
      // prose flattening of the adjustments — which is exactly what the ledger
      // above renders, with the arithmetic and the clamp. Drop that clause here
      // rather than telling the same story twice, worse the second time. Every
      // other note (estimated pillars, unscored explanation) still shows.
      var notes = String(data.notice || "").split(" • ")
        .filter(function (n) { return ledgerShown ? !/^Adjustments:/.test(n) : true; });
      setNotice("score-notice", notes.join(" • "));
      loadExplanation(wallet, data);
      drawTrend(wallet);
    } catch (e) {
      console.error(e);
      setNotice("score-notice", "Unable to compute score: " + e.message);
    }
  }

  // AI narrative under the credential. Best-effort and clearly labelled: a
  // signed-out visitor, an unscored wallet, or an AI outage all just leave the
  // block hidden — the numbers above are the product, this is gloss.
  async function loadExplanation(wallet, data) {
    var host = el("score-explanation");
    if (!host) {
      host = document.createElement("div");
      host.id = "score-explanation";
      host.style.cssText = "margin-top:14px;font-size:13px;line-height:1.6;color:var(--defi-text-dim,#8b8b99);max-width:560px;display:none";
      var anchor = el("score-notice");
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(host, anchor.nextSibling);
      else return;
    }
    host.style.display = "none";
    if (!wallet || data.scored === false) return;
    try {
      var base = (window.DefiAPI && window.DefiAPI.apiBase) || "";
      var res = await fetch(base + "/api/score-explanation?wallet=" + encodeURIComponent(wallet), {
        credentials: "include",
      });
      if (!res.ok) return;
      var j = await res.json();
      if (!j.success || !j.explanation) return;
      host.textContent = "";
      var tag = document.createElement("span");
      tag.textContent = "AI-generated summary";
      tag.style.cssText = "display:inline-block;font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--defi-accent-2,#a855f7);margin-bottom:4px";
      var body = document.createElement("div");
      body.textContent = j.explanation;
      host.appendChild(tag);
      host.appendChild(body);
      host.style.display = "";
    } catch (e) { /* cosmetic — never break the score page over it */ }
  }

  document.addEventListener("DOMContentLoaded", refresh);
  document.addEventListener("defi:wallet-changed", refresh);
  document.addEventListener("defi:scan", refresh);
})();
