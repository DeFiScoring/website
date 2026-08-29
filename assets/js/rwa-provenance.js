/* DeFiScoring – rwa-provenance.js
 *
 * Every RWA research module renders numbers that were hand-compiled, not read
 * from a live feed. This module states that on the page, so a reader can never
 * mistake a curated dossier for a live verification.
 *
 * Usage — one line in the page, no change to the module's own JS:
 *   <div data-rwa-provenance="custody-por"></div>
 *
 * Provenance text lives in assets/data/rwa-provenance.json so updating a review
 * date is a data change, not a code change.
 *
 * FAIL-CLOSED: if the manifest cannot be fetched we still render a banner, and
 * the fallback wording is the most cautious of the set. A disclosure that
 * disappears when a fetch fails is worse than no disclosure at all, because the
 * page then looks authoritative precisely when we know least.
 */
(function () {
  if (window.DefiRwaProvenance) return;

  var MANIFEST_URL = "/assets/data/rwa-provenance.json";

  // Used when the manifest is unreachable or a module key is missing from it.
  var FAILSAFE = {
    summary: "Curated research dossier — not a live feed.",
    detail: "Figures on this page are hand-compiled from published issuer and " +
            "custodian disclosures. They are not read live from an oracle, " +
            "attestation endpoint or chain, and they can go stale. The review " +
            "date for this dossier could not be loaded — treat the figures as " +
            "indicative and confirm against the issuer before relying on them.",
    reviewed_at: null,
    sources: [],
  };

  var manifestPromise = null;

  function loadManifest() {
    if (manifestPromise) return manifestPromise;
    manifestPromise = fetch(MANIFEST_URL, { credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
    return manifestPromise;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // "2026-08-01" -> "1 August 2026". Returns null for anything unparseable so
  // the caller falls back to the unknown-date wording rather than printing junk.
  function formatDate(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
    var d = new Date(iso + "T00:00:00Z");
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString("en-GB", {
      day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
    });
  }

  function entryFor(manifest, key) {
    if (!manifest || !manifest.modules || !manifest.modules[key]) return null;
    var base = manifest.default || {};
    var mod = manifest.modules[key];
    return {
      summary: mod.summary || base.summary || FAILSAFE.summary,
      detail: mod.detail || base.detail || FAILSAFE.detail,
      reviewed_at: mod.reviewed_at || base.reviewed_at || null,
      sources: mod.sources && mod.sources.length ? mod.sources : (base.sources || []),
      dataset_version: manifest.dataset_version || null,
    };
  }

  function bannerHtml(e) {
    var when = formatDate(e.reviewed_at);
    var meta = when
      ? "Last reviewed " + esc(when)
      : "Review date unavailable";
    if (e.dataset_version) meta += " · dataset " + esc(e.dataset_version);

    var sources = e.sources && e.sources.length
      ? '<div class="defi-provenance__sources"><span>Sources:</span> ' +
        e.sources.map(function (s) { return esc(s); }).join(" · ") + "</div>"
      : "";

    return (
      '<aside class="defi-provenance" role="note" aria-label="Data provenance">' +
        '<i class="defi-provenance__icon" data-lucide="book-open" aria-hidden="true"></i>' +
        '<div class="defi-provenance__body">' +
          '<p class="defi-provenance__summary">' + esc(e.summary) + "</p>" +
          '<p class="defi-provenance__detail">' + esc(e.detail) + "</p>" +
          sources +
        "</div>" +
        '<span class="defi-provenance__meta">' + meta + "</span>" +
      "</aside>"
    );
  }

  function mountAll() {
    var nodes = document.querySelectorAll("[data-rwa-provenance]");
    if (!nodes.length) return Promise.resolve();
    return loadManifest().then(function (manifest) {
      Array.prototype.forEach.call(nodes, function (node) {
        var key = node.getAttribute("data-rwa-provenance");
        var entry = entryFor(manifest, key) || FAILSAFE;
        node.innerHTML = bannerHtml(entry);
      });
      if (window.lucide && typeof window.lucide.createIcons === "function") {
        window.lucide.createIcons();
      }
    });
  }

  window.DefiRwaProvenance = { mountAll: mountAll, _entryFor: entryFor, _bannerHtml: bannerHtml };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountAll);
  } else {
    mountAll();
  }
})();
