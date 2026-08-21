(function () {
  function setNotice(id, text) {
    const el = document.getElementById(id);
    if (!el) return;
    if (!text) { el.style.display = "none"; el.textContent = ""; return; }
    el.style.display = ""; el.textContent = text;
  }

  function drawGauge(score, preliminary, coverage) {
    const el = document.getElementById("score-circle");
    const valueEl = document.getElementById("score-value");
    const bandEl = document.getElementById("score-band");
    if (score == null) {
      // Unscored — empty track, an em-dash, and an honest label. No number
      // exists for a wallet with no on-chain history, so none is drawn.
      el.innerHTML =
        '<svg width="220" height="220" viewBox="0 0 220 220">' +
          '<circle cx="110" cy="110" r="90" stroke="rgba(255,255,255,0.08)" stroke-width="14" fill="none"/>' +
        '</svg>' +
        '<div class="defi-score-circle__inner">' +
          '<div class="defi-score-circle__value">—</div>' +
          '<div class="defi-score-circle__label">unscored</div>' +
          '<span class="defi-score-band" style="color:var(--defi-text-dim,#8b8b99)">No on-chain history</span>' +
        '</div>';
      valueEl && (valueEl.textContent = "—");
      bandEl && (bandEl.textContent = "Unscored");
      return;
    }
    const min = 300, max = 850;
    const pct = Math.max(0, Math.min(1, (score - min) / (max - min)));
    const r = 90, c = 2 * Math.PI * r;
    const offset = c * (1 - pct);
    const band = window.DefiState.bandFor(score);
    const colorByBand = { Excellent: "#2bd4a4", Good: "#00f5ff", Fair: "#facc15", Poor: "#ff5d6c" }[band] || "#00f5ff";

    el.innerHTML =
      '<svg width="220" height="220" viewBox="0 0 220 220">' +
        '<circle cx="110" cy="110" r="' + r + '" stroke="rgba(255,255,255,0.08)" stroke-width="14" fill="none"/>' +
        '<circle cx="110" cy="110" r="' + r + '" stroke="' + colorByBand + '" stroke-width="14" fill="none"' +
        ' stroke-linecap="round" stroke-dasharray="' + c + '" stroke-dashoffset="' + offset + '"/>' +
      '</svg>' +
      '<div class="defi-score-circle__inner">' +
        '<div class="defi-score-circle__value">' + score + '</div>' +
        '<div class="defi-score-circle__label">out of 850' + (preliminary ? ' · preliminary' : '') + '</div>' +
        '<span class="defi-score-band defi-band--' + band + '">' + band + '</span>' +
        coverageMarkup(coverage) +
      '</div>';
    valueEl && (valueEl.textContent = score);
    if (bandEl) {
      const cov = window.DefiState.coverageLabel(coverage);
      bandEl.textContent = cov ? band + " · " + cov.text : band;
    }
  }

  // Rendered under the band inside the gauge — the page has no standalone
  // #score-band element, so this is where the band actually appears.
  function coverageMarkup(coverage) {
    const cov = window.DefiState.coverageLabel(coverage);
    if (!cov) return '';
    return '<div class="defi-score-coverage" style="margin-top:6px;font-size:10px;line-height:1.3;' +
      'white-space:nowrap;color:' + cov.color + '">' + escapeAttr(cov.text) + '</div>';
  }

  function escapeAttr(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function drawFactors(factors) {
    const wrap = document.getElementById("score-factors");
    // Each factor row gets data-factor-* attrs so score-breakdown.js can
    // pick it up via event delegation. The "›" affordance + hover state
    // are added via score-breakdown.css.
    //
    // Defensive: even though factor.name and factor.detail are produced
    // by our own worker today, they may eventually include user-controlled
    // strings (e.g. wallet labels). Escape on every text-node insertion.
    wrap.innerHTML = factors.map((f) => {
      const realTag = f.real === false ? ' <span style="color:#facc15">(data unavailable)</span>' : '';
      const valStr = f.value == null ? '—' : escapeAttr(f.value) + ' / 100';
      const detail = f.detail ? ' · ' + escapeAttr(f.detail) : '';
      const fillWidth = f.value == null ? 0 : Number(f.value) || 0;
      return '<div class="defi-factor"' +
        ' role="button" tabindex="0"' +
        ' data-factor-name="'   + escapeAttr(f.name)   + '"' +
        ' data-factor-value="'  + (f.value == null ? "" : escapeAttr(f.value)) + '"' +
        ' data-factor-weight="' + escapeAttr(f.weight) + '"' +
        ' data-factor-detail="' + escapeAttr(f.detail || "") + '"' +
        ' title="Click for breakdown">' +
        '<div class="defi-factor__row"><span>' + escapeAttr(f.name) + realTag + '</span>' +
          '<span>' + valStr + ' · weight ' + escapeAttr(f.weight) + '%' + detail + '</span></div>' +
        '<div class="defi-factor__bar"><div class="defi-factor__fill" style="width:' + fillWidth + '%"></div></div>' +
      '</div>';
    }).join("");

    // Keyboard accessibility for the new role=button rows.
    wrap.querySelectorAll('[data-factor-name]').forEach(function (row) {
      row.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); row.click(); }
      });
    });
  }

  async function refresh() {
    const wallet = window.DefiState.wallet;
    const empty = document.getElementById("score-empty");
    const main = document.getElementById("score-main");
    if (!wallet) { empty.style.display = ""; main.style.display = "none"; return; }
    empty.style.display = "none"; main.style.display = "";

    setNotice("score-notice", "Computing on-chain score…");
    try {
      const data = await window.DefiAPI.getScore(wallet);
      drawGauge(data.scored === false ? null : data.score, data.preliminary, data.coverage);
      drawFactors(data.factors);
      const updated = document.getElementById("score-updated");
      if (updated) updated.textContent = "Last updated " + new Date(data.updated_at).toLocaleString();
      setNotice("score-notice", data.notice || "");
      loadExplanation(wallet, data);
    } catch (e) {
      console.error(e);
      setNotice("score-notice", "Unable to compute score: " + e.message);
    }
  }

  // AI narrative under the gauge. Best-effort and clearly labelled: a
  // signed-out visitor, an unscored wallet, or an AI outage all just leave
  // the block hidden — the numbers above are the product, this is gloss.
  async function loadExplanation(wallet, data) {
    var host = document.getElementById("score-explanation");
    if (!host) {
      host = document.createElement("div");
      host.id = "score-explanation";
      host.style.cssText = "margin-top:14px;font-size:13px;line-height:1.6;color:var(--defi-text-dim,#8b8b99);max-width:560px;display:none";
      var anchor = document.getElementById("score-notice");
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
      if (!res.ok) return; // signed out, no score row, or AI down — stay hidden
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
