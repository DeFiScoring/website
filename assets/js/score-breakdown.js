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
      what: "How responsibly you've borrowed against collateral on Aave, Compound, and other money markets across every chain we cover.",
      good: "No liquidations, healthy buffer (HF > 1.8), and consistent repayments.",
      bad:  "Recent liquidations, tight health factor (HF < 1.3), or unpaid bad debt.",
      inputs: [
        "Number of active loan positions",
        "Lowest health factor in the last 90 days",
        "Liquidation count (lifetime)",
        "Average debt utilization vs. collateral",
      ],
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
    },
    "Liquidity provision": {
      what: "Your contribution to DEX liquidity (Uniswap, Curve, Balancer LPs) — a signal of long-term DeFi engagement.",
      good: "Multiple active LP positions, fee accrual over time.",
      bad:  "No LP activity, or only short-term IL-prone positions.",
      inputs: [
        "Active LP positions (count)",
        "Total LP value (USD)",
        "Time-weighted LP duration",
      ],
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
    },
    "Account age": {
      what: "How long this wallet has been active on-chain. Older wallets with consistent activity score higher.",
      good: "First transaction ≥ 2 years ago with continuous monthly activity.",
      bad:  "Brand-new wallet (< 30 days) or large gaps in activity.",
      inputs: [
        "Date of first on-chain transaction",
        "Number of months with at least one transaction",
        "Total transaction count",
      ],
    },
  };

  // The worker also exposes these; keep them in sync if you rename a pillar.
  function templateFor(name) {
    return EXPLAIN_TEMPLATES[name] || {
      what: "This component contributes to the overall on-chain credit score.",
      good: "Higher is better; consistent positive on-chain activity raises this.",
      bad:  "Lower values indicate risk or limited history.",
      inputs: [],
    };
  }

  function badgeFor(value) {
    if (value == null) return { text: "no data", color: "#7c8a9b" };
    if (value >= 80)   return { text: "Excellent", color: "#2bd4a4" };
    if (value >= 60)   return { text: "Good",      color: "#00f5ff" };
    if (value >= 40)   return { text: "Fair",      color: "#facc15" };
    return { text: "Needs work", color: "#ff5d6c" };
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
            valueStr + ' · ' + badge.text +
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
    });
  });

  window.DefiScoreBreakdown = { open: open, close: close };
})();
