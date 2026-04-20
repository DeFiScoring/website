/* DeFi Scoring – market-data-logger.js
 *
 * Anonymized, opt-in telemetry to the unified Worker.
 *
 * Public API (set on window):
 *   window.DefiIntel.log(eventType, payload?)
 *     - eventType: 'score_render' | 'profiler_run' | 'approvals_scan'
 *     - payload (optional): { defiScore?, riskProfile?, chain?, metadata? }
 *
 *   window.DefiIntel.getConsent()  →  'on' | 'off' | null
 *   window.DefiIntel.setConsent(value)  → 'on' | 'off'
 *
 * Behaviour:
 *   - Never logs unless consent is 'on'.
 *   - Never sends the raw wallet address — sha256-hashes it client-side.
 *     The Worker further re-keys with HMAC-SHA256 using a server salt.
 *   - Silent failure: any network or hashing error is swallowed so the
 *     UX is never disrupted by telemetry being down.
 *   - Coalesces duplicate events of the same type for the same wallet
 *     within a 60s window, so navigating around the dashboard doesn't
 *     spam the backend.
 */
(function () {
  const CONSENT_KEY = "defi:intel:consent";    // 'on' | 'off'
  const COALESCE_MS = 60 * 1000;
  const lastSent = Object.create(null);        // key → ts

  function workerUrl(path) {
    const base = (window.DEFI_RISK_WORKER_URL || "").replace(/\/+$/, "");
    return (base || "") + path;
  }

  function getConsent() {
    try { return localStorage.getItem(CONSENT_KEY); }
    catch { return null; }
  }
  function setConsent(value) {
    const v = value === "on" ? "on" : "off";
    try { localStorage.setItem(CONSENT_KEY, v); } catch (_) {}
    return v;
  }

  async function sha256Hex(str) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(str || "")));
    return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }

  async function log(eventType, payload) {
    try {
      if (getConsent() !== "on") return;
      const wallet = (window.DefiWallet && window.DefiWallet.address) || null;
      if (!wallet) return;

      const key = eventType + ":" + wallet.toLowerCase();
      const now = Date.now();
      if (lastSent[key] && (now - lastSent[key]) < COALESCE_MS) return;
      lastSent[key] = now;

      const hashed = await sha256Hex(wallet.toLowerCase());
      const body = {
        eventType: eventType,
        hashedWallet: hashed,
        chain: (payload && payload.chain) || "ethereum",
      };
      if (payload && payload.defiScore   != null) body.deFiScore   = payload.defiScore;
      if (payload && payload.riskProfile != null) body.riskProfile = payload.riskProfile;
      if (payload && payload.metadata    != null) body.metadata    = payload.metadata;

      // fire-and-forget; never block the caller
      fetch(workerUrl("/api/intel/event"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(function () {});
    } catch (_) { /* swallow */ }
  }

  window.DefiIntel = { log: log, getConsent: getConsent, setConsent: setConsent };
})();
