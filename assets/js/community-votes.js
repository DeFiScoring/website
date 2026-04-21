/* DeFi Scoring – community-votes.js
 *
 * Renders the "Verified by DeFi Scoring community" social-proof widget.
 * Auto-targets every <div data-defi-votes="<protocol-slug>"> element.
 *
 * Backend:
 *   GET    {WORKER_URL}/api/votes/:slug?wallet=0x..   -> aggregate + caller's vote
 *   POST   {WORKER_URL}/api/votes/:slug { wallet, vote, comment? }
 *   DELETE {WORKER_URL}/api/votes/:slug?wallet=0x..   -> retract
 *
 * Quorum / verified rule lives in the Worker (currently total ≥ 25 AND
 * up/total ≥ 0.70). The widget renders a "Verified" badge when the
 * Worker reports `verified: true`.
 */
(function () {
  if (window.__defiVotesInit) return;
  window.__defiVotesInit = true;

  const STYLE_ID = "defi-votes-style";
  const CSS = `
    .defi-votes{border:1px solid var(--defi-border,rgba(148,163,184,.25));border-radius:12px;padding:14px 16px;background:var(--defi-card-bg,rgba(15,23,42,.4));color:var(--defi-text,#e6ebff);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:13px;line-height:1.45;display:flex;flex-direction:column;gap:10px}
    .defi-votes__head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
    .defi-votes__title{font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--defi-text-dim,#94a3b8);margin:0}
    .defi-votes__name{font-weight:700;font-size:15px;color:var(--defi-text,#e6ebff);margin:0;line-height:1.2}
    .defi-votes__cat{font-size:11px;color:var(--defi-text-dim,#94a3b8);text-transform:uppercase;letter-spacing:.06em;margin-top:2px}
    .defi-votes__heading{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
    .defi-votes__badge{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.06em}
    .defi-votes__badge--verified{background:rgba(34,197,94,.12);color:#4ade80;border:1px solid rgba(34,197,94,.4)}
    .defi-votes__badge--unverified{background:rgba(148,163,184,.1);color:#94a3b8;border:1px solid rgba(148,163,184,.3)}
    .defi-votes__badge svg{width:12px;height:12px}
    .defi-votes__stats{display:flex;gap:14px;flex-wrap:wrap;color:var(--defi-text-dim,#cbd5e1);font-variant-numeric:tabular-nums}
    .defi-votes__stat strong{color:var(--defi-text,#e6ebff);font-weight:700;margin-right:4px}
    .defi-votes__bar{height:6px;background:rgba(148,163,184,.15);border-radius:3px;overflow:hidden}
    .defi-votes__bar-fill{height:100%;background:linear-gradient(90deg,#4ade80,#86efac);transition:width .4s ease}
    .defi-votes__actions{display:flex;gap:8px;flex-wrap:wrap}
    .defi-votes__btn{padding:6px 12px;border-radius:8px;font:600 12px/1 inherit;border:1px solid var(--defi-border,rgba(148,163,184,.4));background:transparent;color:var(--defi-text,#e6ebff);cursor:pointer;transition:all .15s;display:inline-flex;align-items:center;gap:6px}
    .defi-votes__btn:hover:not(:disabled){background:rgba(148,163,184,.08)}
    .defi-votes__btn:disabled{opacity:.5;cursor:not-allowed}
    .defi-votes__btn--up.is-active{background:rgba(34,197,94,.12);color:#4ade80;border-color:rgba(34,197,94,.5)}
    .defi-votes__btn--down.is-active{background:rgba(239,68,68,.12);color:#fca5a5;border-color:rgba(239,68,68,.5)}
    .defi-votes__notice{font-size:12px;color:var(--defi-text-dim,#94a3b8);font-style:italic}
    .defi-votes__notice--err{color:#fca5a5;font-style:normal}
  `;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID; s.textContent = CSS;
    document.head.appendChild(s);
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function shieldSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>';
  }

  function workerBase() {
    return (window.DEFI_RISK_WORKER_URL || "").replace(/\/$/, "");
  }

  function render(el, data, status) {
    const slug = el.dataset.defiVotes;
    const verified = data && data.verified;
    const total = (data && data.total) || 0;
    const up = (data && data.up) || 0;
    const down = (data && data.down) || 0;
    const score = data && data.score;
    const quorum = (data && data.quorum) || 25;
    const fillPct = total === 0 ? 0 : Math.round((up / total) * 100);
    const mineVote = data && data.mine && data.mine.vote;
    const wallet = window.DefiWallet && window.DefiWallet.address;
    const canVote = !!wallet;
    const badgeHtml = verified
      ? '<span class="defi-votes__badge defi-votes__badge--verified">' + shieldSvg() + 'Verified by community</span>'
      : '<span class="defi-votes__badge defi-votes__badge--unverified">' + shieldSvg() + 'Awaiting quorum (' + total + '/' + quorum + ')</span>';
    const noticeHtml = status
      ? '<div class="defi-votes__notice' + (status.error ? ' defi-votes__notice--err' : '') + '">' + escapeHtml(status.text) + '</div>'
      : (canVote ? '' : '<div class="defi-votes__notice">Connect a wallet to cast a vote.</div>');

    const label = el.dataset.defiVotesLabel || slug;
    const cat = el.dataset.defiVotesCat || "";
    el.innerHTML =
      '<div class="defi-votes__head">' +
        '<div class="defi-votes__heading">' +
          '<h4 class="defi-votes__name">' + escapeHtml(label) + '</h4>' +
          (cat ? '<div class="defi-votes__cat">' + escapeHtml(cat) + '</div>' : '') +
        '</div>' +
        badgeHtml +
      '</div>' +
      '<div class="defi-votes__stats">' +
        '<span class="defi-votes__stat"><strong>' + (score == null ? '—' : score + '%') + '</strong>safe rating</span>' +
        '<span class="defi-votes__stat"><strong>' + total + '</strong>vote' + (total === 1 ? '' : 's') + '</span>' +
        '<span class="defi-votes__stat"><strong>' + up + '</strong>safe</span>' +
        '<span class="defi-votes__stat"><strong>' + down + '</strong>unsafe</span>' +
      '</div>' +
      '<div class="defi-votes__bar"><div class="defi-votes__bar-fill" style="width:' + fillPct + '%"></div></div>' +
      '<div class="defi-votes__actions">' +
        '<button type="button" class="defi-votes__btn defi-votes__btn--up' + (mineVote === 1 ? ' is-active' : '') + '" data-vote="1"' + (canVote ? '' : ' disabled') + '>👍 Safe</button>' +
        '<button type="button" class="defi-votes__btn defi-votes__btn--down' + (mineVote === -1 ? ' is-active' : '') + '" data-vote="-1"' + (canVote ? '' : ' disabled') + '>👎 Unsafe</button>' +
        (mineVote ? '<button type="button" class="defi-votes__btn" data-vote="0"' + (canVote ? '' : ' disabled') + '>Retract</button>' : '') +
      '</div>' +
      noticeHtml;

    el.querySelectorAll("[data-vote]").forEach((btn) => {
      btn.addEventListener("click", () => onVote(el, slug, Number(btn.dataset.vote)));
    });
  }

  async function load(el) {
    const slug = el.dataset.defiVotes;
    const base = workerBase();
    if (!slug || !base) {
      render(el, null, { text: "Worker URL not set on this page.", error: true });
      return;
    }
    try {
      const wallet = window.DefiWallet && window.DefiWallet.address;
      const url = base + "/api/votes/" + encodeURIComponent(slug) +
        (wallet ? "?wallet=" + encodeURIComponent(wallet) : "");
      const res = await fetch(url, { headers: { "Accept": "application/json" } });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || ("HTTP " + res.status));
      render(el, data, null);
    } catch (e) {
      render(el, null, { text: "Couldn't load community votes: " + e.message, error: true });
    }
  }

  async function onVote(el, slug, vote) {
    const base = workerBase();
    const wallet = window.DefiWallet && window.DefiWallet.address;
    if (!base || !wallet) return;
    el.querySelectorAll("[data-vote]").forEach((b) => (b.disabled = true));
    try {
      let res;
      if (vote === 0) {
        res = await fetch(base + "/api/votes/" + encodeURIComponent(slug) + "?wallet=" + encodeURIComponent(wallet), {
          method: "DELETE",
        });
      } else {
        res = await fetch(base + "/api/votes/" + encodeURIComponent(slug), {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify({ wallet, vote }),
        });
      }
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || ("HTTP " + res.status));
      render(el, data, { text: vote === 0 ? "Vote retracted." : "Thanks — vote recorded.", error: false });
    } catch (e) {
      // Don't wipe the existing aggregate – just show the error inline and
      // re-fetch the canonical state from the Worker.
      const notice = document.createElement("div");
      notice.className = "defi-votes__notice defi-votes__notice--err";
      notice.textContent = "Vote failed: " + e.message;
      el.appendChild(notice);
      load(el);
    }
  }

  function init() {
    const targets = document.querySelectorAll("[data-defi-votes]");
    if (!targets.length) return;
    injectStyle();
    targets.forEach((el) => {
      el.classList.add("defi-votes");
      load(el);
    });
    // Re-render every widget when the wallet changes so vote buttons enable.
    document.addEventListener("defi:wallet-changed", () => {
      document.querySelectorAll("[data-defi-votes]").forEach(load);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
