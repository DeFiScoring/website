(function () {
  const RULES_KEY = "defi.alert.rules";

  function loadRules() {
    try { return JSON.parse(localStorage.getItem(RULES_KEY) || "[]"); }
    catch { return []; }
  }
  function saveRules(rules) { localStorage.setItem(RULES_KEY, JSON.stringify(rules)); }

  function renderRules() {
    const rules = loadRules();
    const tbody = document.getElementById("rules-tbody");
    if (!rules.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="color:#9aa5cf">No rules yet. Add one above.</td></tr>';
      return;
    }
    tbody.innerHTML = rules.map((r, i) =>
      '<tr>' +
        '<td>' + r.type + '</td>' +
        '<td>' + r.threshold + '</td>' +
        '<td>' + (r.email || "—") + '</td>' +
        '<td><button class="defi-btn defi-btn--ghost" data-idx="' + i + '">Remove</button></td>' +
      '</tr>'
    ).join("");
    tbody.querySelectorAll("button[data-idx]").forEach((b) =>
      b.addEventListener("click", () => {
        const arr = loadRules();
        arr.splice(Number(b.dataset.idx), 1);
        saveRules(arr); renderRules();
      })
    );
  }

  async function renderHistory() {
    const wallet = window.DefiState.wallet;
    const empty = document.getElementById("alerts-empty");
    const list = document.getElementById("alerts-list");
    if (!wallet) { empty.style.display = ""; list.innerHTML = ""; return; }
    empty.style.display = "none";
    const data = await window.DefiAPI.getAlerts(wallet);
    const noticeEl = document.getElementById("alerts-notice");
    if (noticeEl) {
      if (data.notice) { noticeEl.style.display = ""; noticeEl.textContent = data.notice; }
      else { noticeEl.style.display = "none"; noticeEl.textContent = ""; }
    }
    if (!data.items.length) {
      list.innerHTML = '<div class="defi-empty">No alerts triggered yet.</div>';
      return;
    }
    list.innerHTML = data.items.map((a) =>
      '<div class="defi-alert-item">' +
        '<span class="defi-alert-item__dot defi-dot--' + a.severity + '"></span>' +
        '<div class="defi-alert-item__body">' +
          '<div class="defi-alert-item__title">' + a.type + '</div>' +
          '<div class="defi-alert-item__meta">' + new Date(a.when).toLocaleString() + ' · ' + a.message + '</div>' +
        '</div>' +
      '</div>'
    ).join("");
  }

  function bindForm() {
    const form = document.getElementById("rule-form");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const rule = {
        type: fd.get("type"),
        threshold: fd.get("threshold"),
        email: fd.get("email"),
      };
      const rules = loadRules();
      rules.push(rule);
      saveRules(rules);
      form.reset();
      renderRules();
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    bindForm();
    renderRules();
    renderHistory();
  });
  document.addEventListener("defi:wallet-changed", renderHistory);
  document.addEventListener("defi:scan", renderHistory);
})();
