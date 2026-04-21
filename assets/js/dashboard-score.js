(function () {
  function setNotice(id, text) {
    const el = document.getElementById(id);
    if (!el) return;
    if (!text) { el.style.display = "none"; el.textContent = ""; return; }
    el.style.display = ""; el.textContent = text;
  }

  function drawGauge(score, preliminary) {
    const el = document.getElementById("score-circle");
    const valueEl = document.getElementById("score-value");
    const bandEl = document.getElementById("score-band");
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
      '</div>';
    valueEl && (valueEl.textContent = score);
    bandEl && (bandEl.textContent = band);
  }

  function drawFactors(factors) {
    const wrap = document.getElementById("score-factors");
    wrap.innerHTML = factors.map((f) => {
      const realTag = f.real === false ? ' <span style="color:#facc15">(data unavailable)</span>' : '';
      const valStr = f.value == null ? '—' : f.value + ' / 100';
      const detail = f.detail ? ' · ' + f.detail : '';
      const fillWidth = f.value == null ? 0 : f.value;
      return '<div class="defi-factor">' +
        '<div class="defi-factor__row"><span>' + f.name + realTag + '</span>' +
          '<span>' + valStr + ' · weight ' + f.weight + '%' + detail + '</span></div>' +
        '<div class="defi-factor__bar"><div class="defi-factor__fill" style="width:' + fillWidth + '%"></div></div>' +
      '</div>';
    }).join("");
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
      drawGauge(data.score, data.preliminary);
      drawFactors(data.factors);
      const updated = document.getElementById("score-updated");
      if (updated) updated.textContent = "Last updated " + new Date(data.updated_at).toLocaleString();
      setNotice("score-notice", data.notice || "");
    } catch (e) {
      console.error(e);
      setNotice("score-notice", "Unable to compute score: " + e.message);
    }
  }

  document.addEventListener("DOMContentLoaded", refresh);
  document.addEventListener("defi:wallet-changed", refresh);
  document.addEventListener("defi:scan", refresh);
})();
