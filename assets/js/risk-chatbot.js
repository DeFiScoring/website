/* DeFi Scoring – risk-chatbot.js
 *
 * Gated, consent-first AI chatbot that builds a personalised DeFi risk
 * profile and offers a downloadable PDF report. Talks to the unified
 * Worker:
 *
 *   POST /api/chatbot/consent  { email, consent: true }
 *   POST /api/chatbot/message  { sessionId, email, message }
 *
 * jsPDF is lazy-loaded the first time we render a report so the page
 * stays light if the user never finishes the flow.
 *
 * DOM contract (rendered by dashboard/risk-chatbot.html):
 *   #chat-consent       – panel with #chat-email + #chat-start
 *   #chat-panel         – main chat panel (hidden initially)
 *   #chat-messages      – scrollable transcript
 *   #chat-input + #chat-send + #chat-finish
 *   #chat-status        – status / error line
 *   #chat-report        – panel shown when a final report arrives
 *   #chat-report-body / #chat-report-download / #chat-report-restart
 */
(function () {
  const STATE = {
    sessionId: null,
    email: null,
    busy: false,
    finalReport: null,
  };

  function workerUrl(path) {
    const base = (window.DEFI_RISK_WORKER_URL || "").replace(/\/+$/, "");
    return (base || "") + path;
  }

  function newSessionId() {
    // 16 random hex chars — passes the Worker's regex.
    const buf = new Uint8Array(8);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function $(id) { return document.getElementById(id); }

  function setStatus(msg, kind) {
    const el = $("chat-status");
    if (!el) return;
    el.style.color = kind === "error" ? "var(--defi-danger,#ff5d6c)"
                   : kind === "ok"    ? "var(--defi-ok,#2bd4a4)"
                   : "var(--defi-text-dim)";
    el.textContent = msg || "";
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }

  function appendMessage(role, text) {
    const wrap = $("chat-messages");
    if (!wrap) return;
    const row = document.createElement("div");
    row.className = "chat-row chat-row--" + role;
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble chat-bubble--" + role;
    bubble.innerHTML = escapeHtml(text).replace(/\n/g, "<br>");
    row.appendChild(bubble);
    wrap.appendChild(row);
    wrap.scrollTop = wrap.scrollHeight;
  }

  async function startChatbot() {
    const emailEl = $("chat-email");
    const consentEl = $("chat-consent-checkbox");
    const email = (emailEl.value || "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      setStatus("Please enter a valid email address.", "error");
      emailEl.focus();
      return;
    }
    if (!consentEl.checked) {
      setStatus("Please tick the consent box to continue.", "error");
      return;
    }

    setStatus("Recording your consent…");
    try {
      const res = await fetch(workerUrl("/api/chatbot/consent"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email, consent: true }),
      });
      const data = await res.json().catch(function () { return null; });
      if (!res.ok || !data || !data.success) {
        setStatus((data && data.error) || ("Consent failed: HTTP " + res.status), "error");
        return;
      }
    } catch (e) {
      setStatus("Network error: " + (e.message || e), "error");
      return;
    }

    STATE.email = email;
    STATE.sessionId = newSessionId();
    $("chat-consent").hidden = true;
    $("chat-panel").hidden = false;
    setStatus("");
    appendMessage("assistant",
      "Hi! I'm your DeFi Risk Advisor. I'll ask 5–7 quick questions about your goals, " +
      "experience and risk tolerance, then generate a personalised report. Ready when you are.");
    appendMessage("assistant", "First — what's your main investment goal for DeFi right now?");
    $("chat-input").focus();
  }

  async function sendMessage(forced) {
    if (STATE.busy) return;
    const inputEl = $("chat-input");
    const msg = forced || (inputEl.value || "").trim();
    if (!msg) return;

    appendMessage("user", msg);
    inputEl.value = "";
    inputEl.focus();
    STATE.busy = true;
    $("chat-send").disabled = true;
    $("chat-finish").disabled = true;
    setStatus("Thinking…");

    try {
      const res = await fetch(workerUrl("/api/chatbot/message"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: STATE.sessionId,
          email: STATE.email,
          message: msg,
        }),
      });
      const data = await res.json().catch(function () { return null; });
      if (!res.ok || !data || !data.success) {
        const err = (data && data.error) || ("HTTP " + res.status);
        appendMessage("assistant", "(error) " + err);
        setStatus(err, "error");
        return;
      }

      if (data.finalReport) {
        // Don't echo the raw JSON into the chat — render the report panel.
        STATE.finalReport = data.finalReport;
        renderReport(data.finalReport);
        setStatus("Report ready.", "ok");
      } else {
        appendMessage("assistant", data.reply);
        setStatus("");
      }
    } catch (e) {
      appendMessage("assistant", "(network error) " + (e.message || e));
      setStatus("Network error: " + (e.message || e), "error");
    } finally {
      STATE.busy = false;
      $("chat-send").disabled = false;
      $("chat-finish").disabled = false;
    }
  }

  function renderReport(report) {
    const panel = $("chat-report");
    const body  = $("chat-report-body");
    if (!panel || !body) return;
    panel.hidden = false;

    const recHtml = (report.recommendations || []).map(function (r) {
      const cls = r.riskLevel === "Low" ? "ok" : r.riskLevel === "High" ? "danger" : "warning";
      return '<li><strong>' + escapeHtml(r.project) + '</strong> ' +
             '<span class="defi-chip defi-chip--' + cls + '">' + escapeHtml(r.riskLevel) + ' risk</span><br>' +
             '<span style="color:var(--defi-text-dim)">' + escapeHtml(r.reason) + '</span></li>';
    }).join("");

    body.innerHTML =
      '<h3 style="margin:0 0 6px">' + escapeHtml(report.pdfTitle || "Your DeFi Risk Profile") + '</h3>' +
      '<p style="margin:0 0 14px"><strong>Risk profile:</strong> ' +
      '<span class="defi-chip defi-chip--ok">' + escapeHtml(report.riskProfile) + '</span></p>' +
      '<p style="white-space:pre-wrap;line-height:1.55;color:var(--defi-text)">' + escapeHtml(report.summary) + '</p>' +
      (recHtml ? '<h4 style="margin:18px 0 8px">Recommendations</h4><ul style="padding-left:20px;display:flex;flex-direction:column;gap:10px">' + recHtml + '</ul>' : "");
  }

  // Lazy-load jsPDF only when the user clicks "Download PDF".
  function loadJsPdf() {
    return new Promise(function (resolve, reject) {
      if (window.jspdf && window.jspdf.jsPDF) return resolve(window.jspdf);
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js";
      s.onload  = function () { resolve(window.jspdf); };
      s.onerror = function () { reject(new Error("Failed to load jsPDF from CDN")); };
      document.head.appendChild(s);
    });
  }

  async function downloadPdf() {
    if (!STATE.finalReport) return;
    setStatus("Generating PDF…");
    try {
      const ns = await loadJsPdf();
      const doc = new ns.jsPDF({ unit: "pt", format: "a4" });
      const r = STATE.finalReport;

      const margin = 48;
      const width  = 595 - margin * 2;
      let y = margin + 8;

      doc.setFont("helvetica", "bold");
      doc.setFontSize(20);
      doc.text(r.pdfTitle || "Your DeFi Risk Profile Report", margin, y);
      y += 26;

      doc.setFont("helvetica", "normal");
      doc.setFontSize(11);
      doc.setTextColor(100);
      doc.text("Generated " + new Date().toLocaleString() + "  •  defiscoring.com", margin, y);
      y += 24;

      doc.setDrawColor(220);
      doc.line(margin, y, margin + width, y);
      y += 22;

      doc.setTextColor(20);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(13);
      doc.text("Risk profile", margin, y); y += 16;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(12);
      doc.text(r.riskProfile, margin, y); y += 22;

      doc.setFont("helvetica", "bold");
      doc.setFontSize(13);
      doc.text("Summary", margin, y); y += 16;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(11);
      const summaryLines = doc.splitTextToSize(r.summary || "", width);
      doc.text(summaryLines, margin, y);
      y += summaryLines.length * 14 + 14;

      if ((r.recommendations || []).length) {
        doc.setFont("helvetica", "bold");
        doc.setFontSize(13);
        doc.text("Recommendations", margin, y); y += 16;
        doc.setFont("helvetica", "normal");
        doc.setFontSize(11);
        r.recommendations.forEach(function (rec) {
          if (y > 780) { doc.addPage(); y = margin; }
          doc.setFont("helvetica", "bold");
          doc.text(rec.project + "  [" + rec.riskLevel + " risk]", margin, y); y += 14;
          doc.setFont("helvetica", "normal");
          const reasonLines = doc.splitTextToSize(rec.reason, width);
          doc.text(reasonLines, margin, y);
          y += reasonLines.length * 13 + 8;
        });
      }

      doc.setFontSize(9); doc.setTextColor(150);
      doc.text("This report is informational only and is not financial advice.", margin, 820);

      doc.save("DeFi-Risk-Report-" + new Date().toISOString().slice(0, 10) + ".pdf");
      setStatus("PDF downloaded.", "ok");
    } catch (e) {
      setStatus("PDF generation failed: " + (e.message || e), "error");
    }
  }

  function restart() {
    STATE.sessionId = null;
    STATE.finalReport = null;
    $("chat-messages").innerHTML = "";
    $("chat-report").hidden = true;
    $("chat-panel").hidden = true;
    $("chat-consent").hidden = false;
    setStatus("");
  }

  function init() {
    if (!$("chat-consent")) return;
    $("chat-start").addEventListener("click", startChatbot);
    $("chat-send").addEventListener("click", function () { sendMessage(); });
    $("chat-finish").addEventListener("click", function () { sendMessage("finish"); });
    $("chat-input").addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); sendMessage(); }
    });
    $("chat-report-download").addEventListener("click", downloadPdf);
    $("chat-report-restart").addEventListener("click", restart);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
