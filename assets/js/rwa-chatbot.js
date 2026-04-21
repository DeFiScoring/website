/* DeFi Scoring – rwa-chatbot.js
 *
 * Module 10 — AI RWA Chatbot + Personalized PDF Report (flagship).
 *
 * Gated, consent-first conversational advisor that combines:
 *   • Live RWA portfolio context from Modules 1–8 (auto-injected)
 *   • The unified Worker chatbot endpoint (/api/chatbot/consent + /message)
 *   • A premium personalised PDF report (jsPDF + autotable) blending the
 *     AI's narrative with the real composite + per-module breakdown
 *
 * DOM contract (rendered by the dashboard section below):
 *   #rwa-chat-consent, #rwa-lead-email, #rwa-chat-start
 *   #rwa-chat-panel,   #rwa-chat-messages, #rwa-chat-input,
 *   #rwa-chat-send,    #rwa-chat-finish,   #rwa-chat-status
 *   #rwa-chat-report,  #rwa-chat-report-body,
 *   #rwa-chat-download,#rwa-chat-restart
 *
 * Public API:
 *   window.DefiRWAChatbot.render() / .reset()
 */
(function () {
  if (window.DefiRWAChatbot) return;

  const STATE = { sessionId: null, email: null, busy: false, finalReport: null, contextSent: false };

  function workerUrl(path) {
    const base = (window.DEFI_RISK_WORKER_URL || "").replace(/\/+$/, "");
    return (base || "") + path;
  }
  function newSessionId() {
    const buf = new Uint8Array(8);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    return "rwa-" + Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
  function fmtUsd(v) {
    if (!v && v !== 0) return "—";
    if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
    if (v >= 1e3) return "$" + (v / 1e3).toFixed(0) + "k";
    return "$" + Math.round(v);
  }
  function gradeFor(score) {
    return score >= 800 ? "A+" : score >= 750 ? "A" : score >= 700 ? "A-"
         : score >= 650 ? "B"  : score >= 600 ? "B-" : score >= 550 ? "C"
         : score >= 500 ? "C-" : "D";
  }
  function tierFor(score) {
    return score >= 750 ? "Low Risk" : score >= 650 ? "Moderate Risk"
         : score >= 550 ? "Elevated Risk" : "High Risk";
  }

  function setStatus(msg, kind) {
    const el = $("rwa-chat-status");
    if (!el) return;
    el.style.color = kind === "error" ? "#fc6464" : kind === "ok" ? "#2bd4a4" : "var(--defi-text-dim)";
    el.textContent = msg || "";
  }

  function appendMessage(role, text) {
    const wrap = $("rwa-chat-messages");
    if (!wrap) return;
    const isUser = role === "user";
    const row = document.createElement("div");
    row.style.cssText = "display:flex;justify-content:" + (isUser ? "flex-end" : "flex-start") + ";margin-bottom:12px";
    row.innerHTML = `
      <div style="max-width:78%;padding:10px 14px;border-radius:14px;font-size:14px;line-height:1.5;
                  background:${isUser ? "rgba(91,140,255,.18)" : "rgba(148,163,184,.10)"};
                  color:var(--defi-text);
                  border:1px solid ${isUser ? "rgba(91,140,255,.3)" : "rgba(148,163,184,.18)"};
                  white-space:pre-wrap">${esc(text)}</div>`;
    wrap.appendChild(row);
    wrap.scrollTop = wrap.scrollHeight;
  }

  // -------- Pull live context from Modules 1–8 ---------------------------
  function readScoreFromContainer(id) {
    const c = document.getElementById(id);
    if (!c) return null;
    const m = c.textContent && c.textContent.match(/\b([3-8]\d{2})\b/);
    return m ? parseInt(m[1], 10) : null;
  }
  function gatherPortfolioContext() {
    const wallet = (window.DefiWallet && window.DefiWallet.address) || window.userWallet || null;
    const issuer = (window.DefiRWAScore && window.DefiRWAScore.activeIssuer) || "n/a";
    const walletAssets = (window.DefiRWAScore && window.DefiRWAScore.walletAssets) || [];
    const moduleScores = {
      assetRisk:           readScoreFromContainer("rwa-score-container"),
      issuerDueDiligence:  readScoreFromContainer("issuer-diligence-container"),
      legalCompliance:     readScoreFromContainer("legal-compliance-container"),
      custodyPor:          readScoreFromContainer("custody-por-container"),
      oracleIntegrity:     readScoreFromContainer("oracle-integrity-container"),
      liquidityRedemption: readScoreFromContainer("liquidity-redemption-container"),
      yieldRiskAdjusted:   readScoreFromContainer("yield-risk-adjusted-container"),
      portfolioAggregate:  readScoreFromContainer("portfolio-rwa-exposure-container"),
    };
    const present = Object.values(moduleScores).filter((v) => typeof v === "number");
    const composite = present.length ? Math.floor(present.reduce((s, v) => s + v, 0) / present.length) : 0;
    const totalValue = walletAssets.reduce((s, h) => s + (h.value || 0), 0);
    return { wallet, issuer, walletAssets, moduleScores, composite, totalValue };
  }
  function buildContextMessage(ctx) {
    const lines = [];
    lines.push("PORTFOLIO CONTEXT (auto-injected):");
    lines.push("- Primary issuer: " + ctx.issuer);
    lines.push("- Wallet connected: " + (ctx.wallet ? "yes" : "no"));
    if (ctx.walletAssets.length) {
      lines.push("- Detected RWA holdings: " + ctx.walletAssets.map((a) => (a.symbol || a.name) + " (" + a.issuer + ")").join(", "));
    }
    lines.push("- Module scores so far:");
    Object.entries(ctx.moduleScores).forEach(([k, v]) => {
      if (v != null) lines.push("    • " + k + ": " + v + " (" + gradeFor(v) + ")");
    });
    if (ctx.composite) lines.push("- Composite score: " + ctx.composite + " (" + gradeFor(ctx.composite) + " · " + tierFor(ctx.composite) + ")");
    lines.push("");
    lines.push("Use this context to ask sharper, more targeted questions about my holdings, time horizon, and risk tolerance. Begin.");
    return lines.join("\n");
  }

  // -------- Worker calls -------------------------------------------------
  async function postConsent(email) {
    try {
      const res = await fetch(workerUrl("/api/chatbot/consent"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, consent: true, source: "rwa_chatbot" }),
      });
      return res.ok;
    } catch (_) { return false; }
  }
  async function postMessage(message) {
    const res = await fetch(workerUrl("/api/chatbot/message"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: STATE.sessionId, email: STATE.email, message }),
    });
    if (!res.ok) throw new Error("Chatbot HTTP " + res.status);
    return res.json();
  }

  // -------- Conversation flow --------------------------------------------
  async function start() {
    if (STATE.busy) return;
    const emailEl = $("rwa-lead-email");
    const email = emailEl ? emailEl.value.trim() : "";
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      setStatus("Please enter a valid email to unlock the RWA AI advisor.", "error");
      return;
    }
    STATE.busy = true;
    setStatus("Submitting consent…");
    STATE.email = email;
    STATE.sessionId = newSessionId();

    const consentOk = await postConsent(email);
    if (!consentOk) {
      setStatus("Could not record consent right now. You can still continue, but your lead may not be saved.", "error");
    } else {
      setStatus("Consent recorded. Starting your RWA advisor…", "ok");
    }

    $("rwa-chat-consent").style.display = "none";
    $("rwa-chat-panel").style.display   = "block";
    appendMessage("assistant",
      "Hi! I'm your dedicated RWA Risk Advisor. I'll ask 6–8 targeted questions about your tokenized-Treasury, " +
      "stablecoin, and private-credit holdings, your time horizon, and your risk tolerance — then build a full " +
      "institutional report combining the live module scores already on this page with your personal goals. " +
      "Ready when you are. Say anything to begin (or type 'report' at any time to finalise)."
    );
    STATE.busy = false;
  }

  async function send(message) {
    if (STATE.busy) return;
    if (!STATE.sessionId) { setStatus("Start the chatbot first.", "error"); return; }
    const text = (message || "").trim();
    if (!text) return;

    appendMessage("user", text);
    STATE.busy = true;
    setStatus("Thinking…");

    try {
      // First send: prepend RWA portfolio context so the AI is grounded.
      let payload = text;
      if (!STATE.contextSent) {
        STATE.contextSent = true;
        payload = buildContextMessage(gatherPortfolioContext()) + "\n\nUSER: " + text;
      }
      const data = await postMessage(payload);
      const reply = (data && data.reply) || "(no response)";
      appendMessage("assistant", reply);
      setStatus("");

      if (data && data.finalReport) {
        STATE.finalReport = data.finalReport;
        renderFinalReportPanel(STATE.finalReport);
      }
    } catch (err) {
      console.warn("[rwa-chatbot] send failed:", err);
      setStatus("Could not reach the advisor right now: " + (err && err.message || err), "error");
    } finally {
      STATE.busy = false;
    }
  }

  function renderFinalReportPanel(report) {
    const ctx = gatherPortfolioContext();
    const reportEl = $("rwa-chat-report");
    const body     = $("rwa-chat-report-body");
    if (!reportEl || !body) return;

    body.innerHTML = `
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">
        <span class="defi-chip" style="background:rgba(138,92,255,.15);color:#a78bfa;border-color:rgba(138,92,255,.35)">Profile · ${esc(report.riskProfile || "—")}</span>
        ${ctx.composite ? `<span class="defi-chip" style="background:rgba(43,212,164,.12);color:#2bd4a4;border-color:rgba(43,212,164,.3)">Composite ${ctx.composite} · ${gradeFor(ctx.composite)}</span>` : ""}
        ${report.overallPortfolioScore ? `<span class="defi-chip">AI score ${esc(String(report.overallPortfolioScore))}</span>` : ""}
      </div>
      <div style="font-size:13px;line-height:1.6;color:var(--defi-text)">${esc(report.summary || "")}</div>
      ${Array.isArray(report.recommendations) && report.recommendations.length ? `
        <div style="margin-top:12px;font-size:12px;color:var(--defi-text-dim);text-transform:uppercase;letter-spacing:.06em">Recommendations</div>
        <ul style="margin:6px 0 0;padding-left:20px;font-size:13px;line-height:1.6">
          ${report.recommendations.map((r) => `<li><strong>${esc(r.project || "")}</strong> — ${esc(r.reason || "")}</li>`).join("")}
        </ul>` : ""}
    `;
    reportEl.style.display = "block";
  }

  // -------- Personalised PDF (combines AI report + Modules 1–8) ----------
  function generatePdf() {
    if (!STATE.finalReport) { setStatus("No final report yet. Type 'report' to finalise the conversation.", "error"); return; }
    const ctor = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    if (!ctor) { setStatus("PDF library not loaded — please refresh and try again.", "error"); return; }

    const ctx = gatherPortfolioContext();
    const r = STATE.finalReport;
    const doc = new ctor({ unit: "pt", format: "a4" });
    const PAGE_W = doc.internal.pageSize.getWidth();
    const PAGE_H = doc.internal.pageSize.getHeight();
    const M = 48;

    // Cover banner
    doc.setFillColor(20, 18, 50);
    doc.rect(0, 0, PAGE_W, 130, "F");
    doc.setFillColor(138, 92, 255);
    doc.rect(0, 130, PAGE_W, 4, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(11);
    doc.setFont("helvetica", "normal");
    doc.text("DeFi Scoring · AI RWA Risk Advisor", M, 50);
    doc.setFontSize(22);
    doc.setFont("helvetica", "bold");
    doc.text(r.pdfTitle || "Your Personalised RWA Risk Report", M, 82);
    doc.setFontSize(11);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(200, 215, 255);
    doc.text("Risk profile: " + (r.riskProfile || "—") + "  ·  Generated " + new Date().toLocaleDateString(),
             M, 108);

    let y = 168;

    // Composite callout
    doc.setFillColor(245, 247, 252);
    doc.roundedRect(M, y, PAGE_W - M * 2, 80, 6, 6, "F");
    doc.setTextColor(100, 116, 139);
    doc.setFontSize(10);
    doc.text("LIVE COMPOSITE PORTFOLIO SCORE", M + 16, y + 22);
    doc.setFontSize(28);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(40, 40, 40);
    doc.text(String(ctx.composite || "—") + "  " + (ctx.composite ? gradeFor(ctx.composite) : ""), M + 16, y + 56);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.setTextColor(100, 116, 139);
    if (ctx.composite) doc.text(tierFor(ctx.composite), PAGE_W - M - 16, y + 56, { align: "right" });
    if (r.overallPortfolioScore) doc.text("AI score: " + r.overallPortfolioScore, PAGE_W - M - 16, y + 22, { align: "right" });
    y += 110;

    // AI Summary
    doc.setFontSize(13);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(40, 40, 40);
    doc.text("AI Risk Advisor Summary", M, y);
    y += 8;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.setTextColor(60, 60, 60);
    const summary = doc.splitTextToSize(r.summary || "(no summary returned)", PAGE_W - M * 2);
    doc.text(summary, M, y + 16);
    y += 16 + summary.length * 13 + 16;

    // Recommendations
    if (Array.isArray(r.recommendations) && r.recommendations.length) {
      if (y > PAGE_H - 180) { doc.addPage(); y = 60; }
      doc.setFontSize(13);
      doc.setFont("helvetica", "bold");
      doc.text("Personalised Recommendations", M, y);
      y += 8;
      const recRows = r.recommendations.map((rec) => [esc(rec.project || ""), esc(rec.reason || "")]);
      if (typeof doc.autoTable === "function") {
        doc.autoTable({
          startY: y + 4,
          head: [["Project / Asset", "Why it fits"]],
          body: recRows,
          theme: "striped",
          headStyles: { fillColor: [138, 92, 255], textColor: 255, fontSize: 10 },
          bodyStyles: { fontSize: 10 },
          margin: { left: M, right: M },
          columnStyles: { 0: { cellWidth: 140 } },
        });
        y = doc.lastAutoTable.finalY + 24;
      }
    }

    // Live module scores table
    if (y > PAGE_H - 180) { doc.addPage(); y = 60; }
    doc.setFontSize(13);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(40, 40, 40);
    doc.text("Live Module Scores", M, y);
    const moduleLabels = {
      assetRisk:           "Module 1 · Asset & Protocol Risk",
      issuerDueDiligence:  "Module 2 · Issuer & Protocol Due Diligence",
      legalCompliance:     "Module 3 · Legal & Regulatory Compliance",
      custodyPor:          "Module 4 · Custody & Proof-of-Reserves",
      oracleIntegrity:     "Module 5 · Oracle & Data Integrity",
      liquidityRedemption: "Module 6 · Liquidity & Redemption Risk",
      yieldRiskAdjusted:   "Module 7 · Yield & Risk-Adjusted Performance",
      portfolioAggregate:  "Module 8 · Portfolio Exposure Aggregator",
    };
    const moduleRows = Object.entries(moduleLabels).map(([k, label]) => {
      const sc = ctx.moduleScores[k];
      return [label, sc != null ? String(sc) : "—",
              sc != null ? gradeFor(sc) : "—",
              sc != null ? tierFor(sc)  : "—"];
    });
    if (typeof doc.autoTable === "function") {
      doc.autoTable({
        startY: y + 8,
        head: [["Module", "Score", "Grade", "Tier"]],
        body: moduleRows,
        theme: "grid",
        headStyles: { fillColor: [30, 41, 59], textColor: 255, fontSize: 10 },
        bodyStyles: { fontSize: 10 },
        margin: { left: M, right: M },
      });
      y = doc.lastAutoTable.finalY + 24;
    }

    // Holdings (if any)
    if (ctx.walletAssets.length) {
      if (y > PAGE_H - 160) { doc.addPage(); y = 60; }
      doc.setFontSize(13);
      doc.setFont("helvetica", "bold");
      doc.text("Detected RWA Holdings", M, y);
      const holdRows = ctx.walletAssets.map((a) => [
        a.symbol || a.name || "RWA",
        a.issuer || "—",
        fmtUsd(a.value || 0),
      ]);
      if (typeof doc.autoTable === "function") {
        doc.autoTable({
          startY: y + 8,
          head: [["Asset", "Issuer", "Value"]],
          body: holdRows,
          theme: "striped",
          headStyles: { fillColor: [91, 140, 255], textColor: 255, fontSize: 10 },
          bodyStyles: { fontSize: 10 },
          margin: { left: M, right: M },
        });
        y = doc.lastAutoTable.finalY + 24;
      }
    }

    // Methodology footer
    if (y > PAGE_H - 140) { doc.addPage(); y = 60; }
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.text("Methodology & Disclaimer", M, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(80, 80, 80);
    const methodology = doc.splitTextToSize(
      "This personalised report combines a generative AI risk-advisor conversation with the live, deterministic module " +
      "scores rendered on the DeFi Scoring dashboard at the time of generation. Composite score is the unweighted mean " +
      "of available modules (1, 3–8). Tiers: 750+ Low Risk · 650+ Moderate Risk · 550+ Elevated Risk · <550 High Risk. " +
      "AI recommendations are produced from a curated 10-issuer registry covering BlackRock/Securitize, Ondo, Circle, " +
      "Paxos, Tether, Franklin, WisdomTree, MakerDAO/Sky, Centrifuge, and Maple. " +
      "This report is for informational purposes only and is not investment, legal, or tax advice. " +
      "Full methodology at /methodology/.",
      PAGE_W - M * 2
    );
    doc.text(methodology, M, y + 16);

    // Page numbers
    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFontSize(8);
      doc.setTextColor(140, 140, 140);
      doc.text("DeFi Scoring · " + new Date().toLocaleDateString() + " · Page " + i + " / " + pageCount,
               PAGE_W / 2, PAGE_H - 20, { align: "center" });
    }

    doc.save("RWA-Personalised-Report-" + new Date().toISOString().slice(0, 10) + ".pdf");
    setStatus("✅ Personalised PDF downloaded.", "ok");
  }

  function reset() {
    STATE.sessionId = null;
    STATE.email = null;
    STATE.busy = false;
    STATE.finalReport = null;
    STATE.contextSent = false;
    const m = $("rwa-chat-messages"); if (m) m.innerHTML = "";
    const r = $("rwa-chat-report");   if (r) r.style.display = "none";
    const p = $("rwa-chat-panel");    if (p) p.style.display = "none";
    const c = $("rwa-chat-consent");  if (c) c.style.display = "block";
    setStatus("");
  }

  // -------- DOM render ---------------------------------------------------
  function render() {
    const container = document.getElementById("rwa-chatbot-container");
    if (!container) return;
    container.innerHTML = `
      <div class="defi-card" style="padding:0;overflow:hidden">
        <div style="padding:24px;background:linear-gradient(135deg,rgba(138,92,255,.18),rgba(91,140,255,.12));border-bottom:1px solid rgba(148,163,184,.12)">
          <div style="font-size:11px;letter-spacing:.12em;color:#a78bfa;text-transform:uppercase;margin-bottom:6px">🤖 Flagship Module 10</div>
          <h3 style="font-size:22px;font-weight:700;margin:0 0 6px">AI RWA Risk Advisor + Personalised PDF</h3>
          <p style="margin:0;color:var(--defi-text-dim);font-size:13px;line-height:1.6">
            Conversational, gated deep-dive that reads your live module scores and produces a premium personalised PDF
            blending AI analysis with the deterministic dashboard data above.
          </p>
        </div>

        <div id="rwa-chat-consent" style="padding:24px">
          <label style="display:block;font-size:12px;color:var(--defi-text-dim);margin-bottom:6px">Your email · gated for institutional insights</label>
          <input id="rwa-lead-email" type="email" placeholder="you@institution.com" autocomplete="email"
                 style="width:100%;padding:12px 14px;border-radius:10px;background:rgba(15,23,42,.6);
                        border:1px solid rgba(148,163,184,.2);color:var(--defi-text);font-size:14px;margin-bottom:12px" />
          <button id="rwa-chat-start" type="button" class="defi-btn defi-btn--primary"
                  style="width:100%;padding:14px;font-size:15px">Accept &amp; start the RWA AI advisor</button>
          <div style="margin-top:10px;font-size:11px;color:var(--defi-text-dim);line-height:1.5">
            By continuing you consent to receive RWA insights and to be added to our institutional mailing list.
            Conversations are stored anonymized for product analytics.
          </div>
        </div>

        <div id="rwa-chat-panel" style="display:none;padding:24px">
          <div id="rwa-chat-messages" style="height:340px;overflow-y:auto;padding:14px;border:1px solid rgba(148,163,184,.15);border-radius:12px;background:rgba(15,23,42,.4);margin-bottom:14px"></div>
          <div style="display:flex;gap:10px;align-items:stretch">
            <input id="rwa-chat-input" type="text" placeholder="Type your answer or 'report' to finalise…"
                   style="flex:1;padding:12px 14px;border-radius:10px;background:rgba(15,23,42,.6);
                          border:1px solid rgba(148,163,184,.2);color:var(--defi-text);font-size:14px" />
            <button id="rwa-chat-send"   type="button" class="defi-btn defi-btn--primary" style="padding:0 20px">Send</button>
            <button id="rwa-chat-finish" type="button" class="defi-btn defi-btn--ghost"   style="padding:0 16px">Finish &amp; report</button>
          </div>
          <div id="rwa-chat-status" style="margin-top:10px;font-size:12px;min-height:16px"></div>
        </div>

        <div id="rwa-chat-report" style="display:none;padding:24px;border-top:1px solid rgba(148,163,184,.12);background:rgba(138,92,255,.06)">
          <div style="font-size:11px;letter-spacing:.12em;color:#a78bfa;text-transform:uppercase;margin-bottom:8px">Final Report</div>
          <div id="rwa-chat-report-body"></div>
          <div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap">
            <button id="rwa-chat-download" type="button" class="defi-btn defi-btn--primary">📄 Download personalised PDF</button>
            <button id="rwa-chat-restart"  type="button" class="defi-btn defi-btn--ghost">Start a new conversation</button>
          </div>
        </div>
      </div>
    `;

    $("rwa-chat-start")   .addEventListener("click", start);
    $("rwa-chat-send")    .addEventListener("click", () => { const i = $("rwa-chat-input"); const v = i.value; i.value = ""; send(v); });
    $("rwa-chat-finish")  .addEventListener("click", () => send("report"));
    $("rwa-chat-input")   .addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("rwa-chat-send").click(); } });
    $("rwa-chat-download").addEventListener("click", generatePdf);
    $("rwa-chat-restart") .addEventListener("click", reset);
  }

  function init() { render(); }

  window.DefiRWAChatbot = { render, reset };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
