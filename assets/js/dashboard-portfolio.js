(function () {
  function colorForRisk(r) {
    if (r == null) return "hsl(220, 15%, 35%)";
    const t = Math.max(0, Math.min(1, r / 100));
    const hue = (1 - t) * 130;
    return "hsl(" + hue + ", 70%, 65%)";
  }
  function fmtUsd(n) { return "$" + (Math.round((n || 0) * 100) / 100).toLocaleString(); }
  function fmtAmt(n, sym) { return (Math.round(n * 10000) / 10000) + " " + sym; }

  function setNotice(id, text) {
    const el = document.getElementById(id);
    if (!el) return;
    if (!text) { el.style.display = "none"; el.textContent = ""; return; }
    el.style.display = ""; el.textContent = text;
  }

  async function refresh() {
    const wallet = window.DefiState.wallet;
    const empty = document.getElementById("port-empty");
    const main = document.getElementById("port-main");
    if (!wallet) { empty.style.display = ""; main.style.display = "none"; return; }
    empty.style.display = "none"; main.style.display = "";

    setNotice("port-notice", "Loading on-chain balances…");
    try {
      const data = await window.DefiAPI.getPortfolio(wallet);
      document.getElementById("port-total").textContent = fmtUsd(data.total_value_usd);
      document.getElementById("port-count").textContent = data.positions.length;

      const heat = document.getElementById("port-heatmap");
      if (data.positions.length === 0) {
        heat.innerHTML = '<div class="defi-empty">No native balances detected on Phase 1 chains.</div>';
      } else {
        heat.innerHTML = data.positions.map((p) =>
          '<div class="defi-heat-cell" style="background:' + colorForRisk(p.risk) + '">' +
            '<div class="defi-heat-cell__name">' + p.name + '</div>' +
            '<div class="defi-heat-cell__val">' + p.chain + ' · ' + fmtUsd(p.value_usd) + '</div>' +
            '<div class="defi-heat-cell__val">' + fmtAmt(p.amount, p.symbol) + '</div>' +
          '</div>'
        ).join("");
      }

      const tbody = document.getElementById("port-tbody");
      tbody.innerHTML = data.positions
        .slice().sort((a, b) => b.value_usd - a.value_usd)
        .map((p) =>
          '<tr>' +
            '<td>' + p.name + '</td>' +
            '<td>' + p.chain + '</td>' +
            '<td>' + fmtUsd(p.value_usd) + '</td>' +
            '<td>' + (p.risk != null ? p.risk + ' / 100' : '—') + '</td>' +
          '</tr>'
        ).join("");

      setNotice("port-notice", data.notice || "");
    } catch (e) {
      console.error(e);
      setNotice("port-notice", "Unable to load balances: " + e.message);
    }
  }

  document.addEventListener("DOMContentLoaded", refresh);
  document.addEventListener("defi:wallet-changed", refresh);
  document.addEventListener("defi:scan", refresh);
})();
