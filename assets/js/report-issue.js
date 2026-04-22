/* DeFi Scoring – report-issue.js
 *
 * In-app feedback form. POSTs to the unified Worker's /api/report-issue
 * endpoint, which proxies to the GitHub Issues API using a server-side
 * PAT. The browser never sees the token.
 *
 * Form contract (rendered by dashboard/report.html):
 *   #report-issue-form
 *   #issue-title       (input)
 *   #issue-description (textarea)
 *   #issue-type        (select: bug | feature | feedback)
 *   #report-button     (submit)
 *   #report-result     (status panel)
 *
 * Server URL is taken from window.DEFI_RISK_WORKER_URL — the same
 * unified Worker that already serves /api/profile, /api/votes, etc.
 */
(function () {
  function workerUrl() {
    const base = (window.DEFI_RISK_WORKER_URL || "").replace(/\/+$/, "");
    return base ? base + "/api/report-issue" : "/api/report-issue";
  }

  function panel(html, kind) {
    // kind: "ok" | "error" | "info"
    const colors = {
      ok:    { bg: "rgba(43,212,164,0.10)", border: "rgba(43,212,164,0.40)", color: "var(--defi-ok,#2bd4a4)" },
      error: { bg: "rgba(255,93,108,0.10)", border: "rgba(255,93,108,0.40)", color: "var(--defi-danger,#ff5d6c)" },
      info:  { bg: "rgba(91,140,255,0.08)", border: "rgba(91,140,255,0.40)", color: "var(--defi-text)" },
    }[kind] || { bg: "transparent", border: "var(--defi-border)", color: "var(--defi-text)" };
    return (
      '<div style="margin-top:14px;padding:14px 16px;border-radius:10px;font-size:13px;line-height:1.5;' +
      'background:' + colors.bg + ';border:1px solid ' + colors.border + ';color:' + colors.color + '">' +
      html + "</div>"
    );
  }

  async function submit(ev) {
    if (ev) ev.preventDefault();

    const form    = document.getElementById("report-issue-form");
    const titleEl = document.getElementById("issue-title");
    const descEl  = document.getElementById("issue-description");
    const typeEl  = document.getElementById("issue-type");
    const button  = document.getElementById("report-button");
    const result  = document.getElementById("report-result");
    if (!form || !titleEl || !descEl || !button || !result) return;

    const title = (titleEl.value || "").trim();
    const description = (descEl.value || "").trim();
    const type = typeEl ? (typeEl.value || "bug") : "bug";

    if (!title || !description) {
      result.innerHTML = panel("Please fill in both a title and a description.", "error");
      return;
    }
    if (title.length > 200) {
      result.innerHTML = panel("Title must be 200 characters or fewer.", "error");
      return;
    }

    const wallet = (window.DefiWallet && window.DefiWallet.address) || null;
    const labels = ["user-report"];
    if (type === "bug")      labels.push("bug");
    if (type === "feature")  labels.push("enhancement");
    if (type === "feedback") labels.push("feedback");

    button.disabled = true;
    const originalLabel = button.textContent;
    button.textContent = "Submitting…";
    result.innerHTML = panel("Creating GitHub issue…", "info");

    try {
      const res = await fetch(workerUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title,
          body: description,
          labels: labels,
          page: window.location.href,
          wallet: wallet,
          userAgent: navigator.userAgent,
        }),
      });
      let data = null;
      try { data = await res.json(); } catch (_) { /* non-JSON */ }

      if (res.ok && data && data.success) {
        result.innerHTML = panel(
          '<strong>Issue #' + data.issueNumber + " created.</strong> " +
          'Thanks for the report — you can <a href="' + data.issueUrl +
          '" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline">view it on GitHub</a>.',
          "ok"
        );
        form.reset();
      } else if (res.status === 503) {
        result.innerHTML = panel(
          "Issue reporting is not configured on the server yet. " +
          "An administrator needs to set <code>GITHUB_TOKEN</code> on the Worker.",
          "error"
        );
      } else {
        const msg = (data && data.error) ? data.error : ("HTTP " + res.status);
        result.innerHTML = panel("Could not create the issue: " + msg, "error");
      }
    } catch (e) {
      result.innerHTML = panel(
        "Network error reaching the Worker: " + (e.message || e) + ". Please retry.",
        "error"
      );
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }

  function init() {
    const form = document.getElementById("report-issue-form");
    if (!form) return;
    form.addEventListener("submit", submit);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Public alias for any inline onclick or footer link that wants to scroll
  // to + focus the form.
  window.openReportIssue = function () {
    const t = document.getElementById("issue-title");
    if (t) { t.focus(); t.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
    window.location.href = "/dashboard/report-issue/";
  };
})();
