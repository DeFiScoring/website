/* ---------------------------------------------------------------------------
   Score breakdown modal — explains *why* a subscore is what it is.

   Wired up by dashboard-score.js after it renders the factor list. Each
   `.defi-factor` element gets data-factor-name + data-factor-value +
   data-factor-detail attributes and a click handler that opens this modal.

   Templates per factor name come from EXPLAIN_TEMPLATES below. We
   substitute the factor's actual numbers + the free-text `detail`
   string the worker returns. If the factor name isn't recognised we
   fall back to the generic "What this measures" copy.
--------------------------------------------------------------------------- */
(function () {
  "use strict";

  // Static, human-readable explanations of each subscore. The agent that
  // writes the scoring engine owns the *math*; this file owns the *story*
  // we tell users about that math.
  var EXPLAIN_TEMPLATES = {
    "Loan reliability": {
      what: "How responsibly you've borrowed against collateral on Aave V3, Spark, Compound V3 and Morpho Blue. The riskiest position sets the band — Morpho is read on Ethereum only, and any chain we could not read is reported as not checked rather than as no position.",
      good: "No liquidations, healthy buffer (HF > 2.0), and consistent repayments.",
      bad:  "Recent liquidations, tight health factor (HF < 1.3), or unpaid bad debt.",
      inputs: [
        "Number of active loan positions",
        "Lowest health factor across every protocol and chain read",
        "Liquidation count (lifetime)",
        "Average debt utilization vs. collateral",
      ],
      // Forward-looking, unlike `good`/`bad` which describe what already
      // happened. Three variants because the same advice is not true in all
      // three states: telling someone to keep their health factor above 2.0
      // when we could not read their lending data at all is confidently wrong.
      improve: "Keep every health factor above 2.0 and repay on schedule. This is the heaviest pillar at 35%, and the riskiest single position sets the band.",
      improveEstimated: "Nothing on your side \u2014 the lending sources could not be read at scan time, so this is held at a neutral 50. It scores on real positions as soon as they answer.",
      improveAbsent: "Borrow against collateral on a supported money market and repay on schedule. At 35% this is the heaviest pillar, and the fastest one to move.",
    },
    "Portfolio health": {
      what: "How balanced your positions are right now: concentration, liquidity, and exposure to volatile assets.",
      good: "No single position > 50% of portfolio, ample stable-coin buffer.",
      bad:  "One position dominates (> 80%), or 100% in a single illiquid token.",
      inputs: [
        "Largest single-position share",
        "Stablecoin allocation",
        "Number of distinct chains active",
        "Number of distinct protocols active",
      ],
      improve: "Bring your largest position under 50% of portfolio value. Concentration is what this pillar penalises, not size.",
      improveEstimated: "Nothing on your side \u2014 balances could not be read at scan time, so this is held at a neutral 50 rather than counted as empty.",
      improveAbsent: "Hold assets in this wallet, spread across more than one position and more than one chain.",
    },
    "Liquidity provision": {
      what: "Your contribution to DEX liquidity, scored on the USD value of your live Uniswap V3 positions rather than how many you hold — twenty dust positions no longer outrank one large one.",
      good: "Meaningful capital in live, in-range positions.",
      bad:  "No LP activity, or only dust positions left open.",
      inputs: [
        "Live LP positions (count)",
        "Total LP value (USD)",
        "Number of chains with liquidity",
      ],
      improve: "Hold LP positions longer and larger \u2014 this is valued in USD, so one meaningful position outranks twenty dust ones.",
      improveEstimated: "Nothing on your side \u2014 Uniswap positions could not be read at scan time, so this is held at a neutral 50.",
      improveAbsent: "Provide liquidity on a DEX and leave it in place. Value counts, not the number of positions.",
    },
    "Governance": {
      what: "On-chain governance participation (Snapshot, Tally) — a proxy for engagement and reputation.",
      good: "Voted in 5+ governance proposals across DAOs.",
      bad:  "No on-chain votes recorded.",
      inputs: [
        "Snapshot votes (lifetime)",
        "Number of distinct DAOs",
        "Delegations made or received",
      ],
      improve: "Vote in more proposals, and across more than one DAO \u2014 breadth counts as well as count.",
      improveEstimated: "Nothing on your side \u2014 Snapshot was unreachable, so this is held at a neutral 50 and marked estimated rather than scored as zero votes.",
      improveAbsent: "Vote in a DAO proposal. Five votes takes this pillar from empty to strong.",
    },
    "Account age": {
      what: "How long this wallet has been active on-chain. The oldest first transaction across every scored chain wins, so a wallet that started on an L2 keeps that age instead of being reset to the date it bridged to Ethereum.",
      good: "First transaction ≥ 2 years ago with continuous monthly activity.",
      bad:  "Brand-new wallet (< 30 days) or large gaps in activity.",
      inputs: [
        "Date of the earliest first transaction found on any scored chain",
        "Which chain that transaction was on",
        "How many chains answered the lookup",
      ],
      improve: "Nothing to do \u2014 this rises on its own while the wallet stays active. It reads the oldest first transaction across every scored chain, so an L2 origin keeps its age.",
      improveEstimated: "Nothing on your side \u2014 the first-transaction lookup failed on every chain, so this is held at a neutral 50. A failed lookup is not an age of zero.",
      improveAbsent: "Make your first transaction. This pillar then grows on its own, and counts the oldest one found on any scored chain.",
    },
  };

  // Factor names arrive suffixed with their live sources — "Loan reliability
  // (Aave V3, Spark, Compound V3, Morpho Blue)" — while the templates above are
  // keyed on the bare pillar name. A direct lookup therefore missed on every
  // factor and every modal silently rendered the generic fallback copy below.
  // Key on the leading phrase; dashboard.js owns the suffix.
  function templateFor(name) {
    var key = String(name || "").split(" (")[0].trim();
    return EXPLAIN_TEMPLATES[key] || {
      what: "This component contributes to the overall on-chain credit score.",
      good: "Higher is better; consistent positive on-chain activity raises this.",
      bad:  "Lower values indicate risk or limited history.",
      inputs: [],
    };
  }

  // A pillar's 0–100 value is a different scale from the 300–850 band, and it
  // now has different words. This used to read "Excellent / Good / Fair /
  // Needs work" at 80/60/40 with its own hard-coded hexes — three of those
  // words also name bands, at unrelated thresholds, so "Good" beside a pillar
  // and "Good" beside the score meant two different things. score-bands.js
  // owns both vocabularies now, and keeps them provably distinct.
  function badgeFor(value) {
    var t = window.DefiBands.pillarTier(value);
    return { text: t.label, color: t.color, glyph: t.glyph };
  }

  /*
   * The forward-looking line for a pillar, in the state it is actually in.
   * Exported below so dashboard-score.js's credential and this modal read the
   * same sentence rather than authoring two.
   */
  function improveFor(name, real, hasValue) {
    var tpl = templateFor(name);
    if (hasValue === false) return tpl.improveAbsent || tpl.improve || "";
    if (real === false)     return tpl.improveEstimated || tpl.improve || "";
    return tpl.improve || "";
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }

  function buildModal() {
    var existing = document.getElementById("defi-breakdown-modal");
    if (existing) return existing;
    var el = document.createElement("div");
    el.id = "defi-breakdown-modal";
    el.className = "defi-breakdown-modal";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-hidden", "true");
    el.innerHTML = '' +
      '<div class="defi-breakdown-modal__backdrop" data-close></div>' +
      '<div class="defi-breakdown-modal__panel" role="document">' +
        '<button type="button" class="defi-breakdown-modal__close" data-close aria-label="Close">×</button>' +
        '<div class="defi-breakdown-modal__body" id="defi-breakdown-body"></div>' +
      '</div>';
    document.body.appendChild(el);
    el.addEventListener("click", function (ev) {
      if (ev.target.closest("[data-close]")) close();
    });
    return el;
  }

  function open(factor) {
    var modal = buildModal();
    var tpl = templateFor(factor.name);
    var badge = badgeFor(factor.value);
    var weight = factor.weight != null ? factor.weight + "%" : "—";
    var valueStr = factor.value == null ? "no data" : factor.value + " / 100";
    var detail = factor.detail ? '<p class="defi-breakdown-modal__detail">' + escapeHtml(factor.detail) + '</p>' : "";
    var improve = improveFor(factor.name, factor.real, factor.value != null);

    var inputsHtml = tpl.inputs.length
      ? '<ul class="defi-breakdown-modal__inputs">' +
          tpl.inputs.map(function (i) { return '<li>' + escapeHtml(i) + '</li>'; }).join("") +
        '</ul>'
      : "";

    document.getElementById("defi-breakdown-body").innerHTML = '' +
      '<div class="defi-breakdown-modal__head">' +
        '<div class="defi-breakdown-modal__title">' + escapeHtml(factor.name) + '</div>' +
        '<div class="defi-breakdown-modal__meta">' +
          '<span class="defi-breakdown-modal__weight">Weight ' + weight + '</span>' +
          '<span class="defi-breakdown-modal__badge" style="background:' + badge.color + '">' +
            valueStr + ' · ' + badge.glyph + ' ' + badge.text +
          '</span>' +
        '</div>' +
      '</div>' +
      '<p class="defi-breakdown-modal__what">' + escapeHtml(tpl.what) + '</p>' +
      detail +
      '<div class="defi-breakdown-modal__cols">' +
        '<div class="defi-breakdown-modal__col">' +
          '<div class="defi-breakdown-modal__col-label">What raises it</div>' +
          '<p>' + escapeHtml(tpl.good) + '</p>' +
        '</div>' +
        '<div class="defi-breakdown-modal__col">' +
          '<div class="defi-breakdown-modal__col-label">What lowers it</div>' +
          '<p>' + escapeHtml(tpl.bad) + '</p>' +
        '</div>' +
      '</div>' +
      (improve
        ? '<div class="defi-breakdown-modal__improve">' +
            '<div class="defi-breakdown-modal__col-label">What would move it</div>' +
            '<p>' + escapeHtml(improve) + '</p>' +
          '</div>'
        : "") +
      (inputsHtml
        ? '<div class="defi-breakdown-modal__inputs-wrap">' +
            '<div class="defi-breakdown-modal__col-label">Inputs we look at</div>' +
            inputsHtml +
          '</div>'
        : "");

    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.documentElement.style.overflow = "hidden";
  }

  function close() {
    var modal = document.getElementById("defi-breakdown-modal");
    if (!modal) return;
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    document.documentElement.style.overflow = "";
  }

  document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });

  // Delegate clicks on any factor row
  document.addEventListener("click", function (ev) {
    var row = ev.target.closest("[data-factor-name]");
    if (!row) return;
    open({
      name:   row.dataset.factorName,
      value:  row.dataset.factorValue === "" ? null : Number(row.dataset.factorValue),
      weight: row.dataset.factorWeight === "" ? null : Number(row.dataset.factorWeight),
      detail: row.dataset.factorDetail || "",
      // Fifth attribute, added with the credential. "false" is the only value
      // that means estimated; an absent attribute reads as observed, which is
      // what every caller before this one implied.
      real:   row.dataset.factorReal !== "false",
    });
  });

  window.DefiScoreBreakdown = { open: open, close: close, improveFor: improveFor };
})();
