/* DeFi Scoring – watchlist.js
 *
 * Persistent watchlist widget. Two storage backends, picked at runtime:
 *
 *   1. Cloudflare Worker + D1   ← if window.DEFI_RISK_WORKER_URL is reachable
 *      and /api/watchlist/:wallet returns 2xx.  Read on mount, write on every
 *      mutation. Survives across browsers / devices.
 *
 *   2. localStorage             ← fallback when the Worker is unreachable
 *      (network down, Worker not deployed, D1 binding missing, etc.).
 *      A clear banner tells the user they're in offline mode so they don't
 *      assume their list is syncing when it isn't.
 *
 * Mount point: any element with id="defi-watchlist". The wallet is read from
 * window.DefiState.wallet and the widget re-renders on `defi:wallet-changed`.
 *
 * Item shape:
 *   { item: "aave-v3"|"ethereum:0xA0b8…",  kind: "protocol"|"token",
 *     label?: string,  alert_threshold?: number,  added_at: number }
 */
(function () {
  if (window.__defiWatchlistInit) return;
  window.__defiWatchlistInit = true;

  const STYLE_ID = "defi-watchlist-style";
  const LS_KEY = (w) => "defi.watchlist." + (w || "anon").toLowerCase();
  const CSS = `
    .defi-wl{display:flex;flex-direction:column;gap:12px}
    .defi-wl__banner{padding:8px 12px;border-radius:8px;font-size:12px;line-height:1.5}
    .defi-wl__banner--warn{background:rgba(250,204,21,.08);color:#fbbf24;border:1px solid rgba(250,204,21,.25)}
    .defi-wl__banner--err{background:rgba(252,165,165,.08);color:#fca5a5;border:1px solid rgba(252,165,165,.25)}
    .defi-wl__banner--ok{background:rgba(74,222,128,.08);color:#86efac;border:1px solid rgba(74,222,128,.25)}
    .defi-wl__add{display:flex;gap:8px;flex-wrap:wrap}
    .defi-wl__select,.defi-wl__input{flex:1;min-width:140px;background:rgba(15,23,42,.4);border:1px solid var(--defi-border,rgba(148,163,184,.25));border-radius:8px;padding:8px 12px;color:var(--defi-text,#e6ebff);font-size:13px;font-family:inherit}
    .defi-wl__select:focus,.defi-wl__input:focus{outline:none;border-color:var(--defi-accent,#5b8cff)}
    .defi-wl__items{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
    .defi-wl__item{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:rgba(148,163,184,.06);border:1px solid rgba(148,163,184,.15);border-radius:8px}
    .defi-wl__label{display:flex;flex-direction:column;gap:2px;min-width:0}
    .defi-wl__name{font-weight:600;font-size:13px;color:var(--defi-text,#e6ebff);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .defi-wl__meta{font-size:11px;color:var(--defi-text-dim,#94a3b8);display:flex;gap:8px;align-items:center}
    .defi-wl__kind{display:inline-block;padding:1px 8px;border-radius:999px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
    .defi-wl__kind--protocol{background:rgba(91,140,255,.15);color:#93b8ff}
    .defi-wl__kind--token{background:rgba(138,92,255,.15);color:#c4a8ff}
    .defi-wl__remove{background:none;border:none;color:var(--defi-text-dim,#94a3b8);font-size:18px;cursor:pointer;padding:4px 8px;border-radius:6px;line-height:1}
    .defi-wl__remove:hover{background:rgba(252,165,165,.12);color:#fca5a5}
    .defi-wl__empty{text-align:center;color:var(--defi-text-dim,#94a3b8);font-size:13px;padding:20px;font-style:italic}
    .defi-wl__hint{font-size:11px;color:var(--defi-text-dim,#94a3b8);line-height:1.5}
  `;

  const POPULAR_PROTOCOLS = [
    { slug: "aave-v3",       name: "Aave V3" },
    { slug: "uniswap-v3",    name: "Uniswap V3" },
    { slug: "compound-v3",   name: "Compound V3" },
    { slug: "curve-finance", name: "Curve Finance" },
    { slug: "lido",          name: "Lido" },
    { slug: "makerdao",      name: "MakerDAO" },
    { slug: "morpho-blue",   name: "Morpho Blue" },
    { slug: "spark",         name: "Spark" },
  ];

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style"); s.id = STYLE_ID; s.textContent = CSS;
    document.head.appendChild(s);
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
  function wallet() { return window.DefiState && window.DefiState.wallet; }
  function workerUrl() { return (window.DEFI_RISK_WORKER_URL || "").replace(/\/$/, ""); }

  // ── Storage ──────────────────────────────────────────────────────────────
  async function loadRemote(addr) {
    const url = workerUrl();
    if (!url) throw new Error("no worker configured");
    const res = await fetch(url + "/api/watchlist/" + addr);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    if (!j.success) throw new Error(j.error || "unknown error");
    return j.items || [];
  }
  async function saveRemote(addr, items) {
    const url = workerUrl();
    if (!url) throw new Error("no worker configured");
    const res = await fetch(url + "/api/watchlist/" + addr, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    if (!j.success) throw new Error(j.error || "unknown error");
    return true;
  }
  function loadLocal(addr) {
    try { return JSON.parse(localStorage.getItem(LS_KEY(addr)) || "[]"); }
    catch (_) { return []; }
  }
  function saveLocal(addr, items) {
    try { localStorage.setItem(LS_KEY(addr), JSON.stringify(items)); } catch (_) {}
  }

  // ── State ────────────────────────────────────────────────────────────────
  let mode = "unknown"; // "remote" | "local"
  let items = [];
  let mounted = false;

  async function loadFor(addr) {
    if (!addr) { items = []; mode = "unknown"; return; }
    try {
      items = await loadRemote(addr);
      mode = "remote";
    } catch (e) {
      console.info("[watchlist] using local storage:", e.message);
      items = loadLocal(addr);
      mode = "local";
    }
  }
  async function persist() {
    const addr = wallet();
    if (!addr) return;
    saveLocal(addr, items); // always cache locally
    if (mode === "remote") {
      try { await saveRemote(addr, items); }
      catch (e) {
        console.warn("[watchlist] remote save failed, demoting to local:", e.message);
        mode = "local";
        renderInto(document.getElementById("defi-watchlist"));
      }
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────
  function banner() {
    const addr = wallet();
    if (!addr) return '<div class="defi-wl__banner defi-wl__banner--warn">Connect a wallet to start a watchlist.</div>';
    if (mode === "remote") return '<div class="defi-wl__banner defi-wl__banner--ok">Synced to your account · ' + items.length + ' item' + (items.length === 1 ? '' : 's') + '</div>';
    if (mode === "local")  return '<div class="defi-wl__banner defi-wl__banner--warn">Syncing locally only — DeFi Scoring backend offline. Items live in this browser until the server is reachable again.</div>';
    return '';
  }

  function itemRow(it) {
    const kind = it.kind || (it.item && it.item.includes(":") ? "token" : "protocol");
    const label = it.label || it.item;
    return `<li class="defi-wl__item" data-item="${esc(it.item)}">
        <div class="defi-wl__label">
          <div class="defi-wl__name">${esc(label)}</div>
          <div class="defi-wl__meta">
            <span class="defi-wl__kind defi-wl__kind--${esc(kind)}">${esc(kind)}</span>
            <span>${esc(it.item)}</span>
          </div>
        </div>
        <button class="defi-wl__remove" type="button" aria-label="Remove" data-remove="${esc(it.item)}">×</button>
      </li>`;
  }

  function renderInto(host) {
    if (!host) return;
    injectStyle();
    const addr = wallet();
    const protocolOptions = POPULAR_PROTOCOLS.map((p) => `<option value="${esc(p.slug)}">${esc(p.name)}</option>`).join("");
    const itemsHtml = items.length
      ? '<ul class="defi-wl__items">' + items.map(itemRow).join("") + '</ul>'
      : '<div class="defi-wl__empty">No items yet — add a protocol or paste a token contract.</div>';
    host.innerHTML = `
      <div class="defi-wl">
        ${banner()}
        ${addr ? `
          <div class="defi-wl__add">
            <select class="defi-wl__select" id="defi-wl-protocol" aria-label="Protocol">
              <option value="">Add protocol…</option>
              ${protocolOptions}
            </select>
            <input class="defi-wl__input" id="defi-wl-token" type="text" placeholder="…or token: ethereum:0x…" autocomplete="off">
          </div>
          <div class="defi-wl__hint">Protocols use DeFiLlama slugs. Tokens use <code>chain:0xaddress</code> (e.g. <code>ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48</code> for USDC).</div>
        ` : ''}
        ${itemsHtml}
      </div>`;
    if (!addr) return;

    host.querySelector("#defi-wl-protocol").addEventListener("change", async (e) => {
      const slug = e.target.value;
      if (!slug) return;
      const meta = POPULAR_PROTOCOLS.find((p) => p.slug === slug);
      addItem({ item: slug, kind: "protocol", label: meta ? meta.name : slug, added_at: Date.now() });
      e.target.value = "";
    });
    host.querySelector("#defi-wl-token").addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const raw = e.target.value.trim();
      if (!raw) return;
      const m = /^([a-z0-9-]+):(0x[a-fA-F0-9]{40})$/.exec(raw);
      if (!m) {
        alert("Token format is chain:0xaddress, e.g. ethereum:0xa0b8…");
        return;
      }
      addItem({ item: m[1].toLowerCase() + ":" + m[2].toLowerCase(), kind: "token", label: raw, added_at: Date.now() });
      e.target.value = "";
    });
    host.querySelectorAll("[data-remove]").forEach((b) => {
      b.addEventListener("click", () => removeItem(b.dataset.remove));
    });
  }

  async function addItem(it) {
    if (items.find((x) => x.item === it.item)) return; // dedupe
    items.unshift(it);
    renderInto(document.getElementById("defi-watchlist"));
    await persist();
  }
  async function removeItem(key) {
    items = items.filter((x) => x.item !== key);
    renderInto(document.getElementById("defi-watchlist"));
    await persist();
  }

  async function refresh() {
    const host = document.getElementById("defi-watchlist");
    if (!host) return;
    mounted = true;
    await loadFor(wallet());
    renderInto(host);
  }

  document.addEventListener("DOMContentLoaded", refresh);
  document.addEventListener("defi:wallet-changed", refresh);

  window.DefiWatchlist = { refresh };
})();
