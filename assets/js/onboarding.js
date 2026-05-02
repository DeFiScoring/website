/* ---------------------------------------------------------------------------
   First-time onboarding modal + soft upgrade nudge.
   ---------------------------------------------------------------------------
   Storage keys (all localStorage):
     defi_onboarding_state -> { status:"new"|"in_progress"|"complete"|"skipped",
                                step:1..4, started_at, finished_at }
     defi_scan_count       -> integer (wallet scans on this browser)
     defi_nudge_state      -> { dismissed_at:ms, last_shown_scan:int }

   Modal walks 4 steps:
     1. Welcome → Sign in via SIWE (DefiAuth)
     2. First scan → fetch /api/health-score (POST), show 300-850 number,
        confetti for >= 670.
     3. Stay protected → pre-fill HF<1.3 rule for largest borrow position;
        Pro+ users can one-click create, free users see upgrade CTA.
     4. Unlock more → soft upsell to /pricing/ + "Done"

   Soft nudge: after the user's 5th scan on the free tier we show a
   dismissible banner above dashboard content. Re-arms after 7 days.
--------------------------------------------------------------------------- */
(function () {
  "use strict";

  var WORKER = (window.DEFI_RISK_WORKER_URL || "").replace(/\/$/, "");
  var KEY_OB = "defi_onboarding_state";
  var KEY_SCAN = "defi_scan_count";
  var KEY_NUDGE = "defi_nudge_state";
  var NUDGE_AFTER_SCANS = 5;
  var NUDGE_REARM_MS = 7 * 24 * 60 * 60 * 1000;

  function readJson(k, fallback) {
    try { return JSON.parse(localStorage.getItem(k) || "null") || fallback; }
    catch { return fallback; }
  }
  function writeJson(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }

  function getOb() { return readJson(KEY_OB, { status: "new", step: 1 }); }
  function setOb(patch) {
    var s = Object.assign(getOb(), patch);
    writeJson(KEY_OB, s);
    return s;
  }

  function api(path, opts) {
    opts = opts || {};
    return fetch(WORKER + path, Object.assign({
      credentials: "include",
      headers: Object.assign({ "content-type": "application/json" }, opts.headers || {}),
    }, opts)).then(function (r) {
      return r.json().then(function (j) { j.__status = r.status; return j; })
        .catch(function () { return { success: false, error: "non_json", __status: r.status }; });
    });
  }

  /* ---------- Confetti ---------- */
  function confetti() {
    var canvas = document.createElement("canvas");
    canvas.className = "defi-ob-confetti";
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    document.body.appendChild(canvas);
    var ctx = canvas.getContext("2d");
    var colors = ["#00f5ff", "#a855f7", "#2bd4a4", "#facc15", "#ff5d6c"];
    var pieces = [];
    for (var i = 0; i < 140; i++) {
      pieces.push({
        x: Math.random() * canvas.width,
        y: -20 - Math.random() * canvas.height * 0.5,
        vx: (Math.random() - 0.5) * 4,
        vy: 3 + Math.random() * 5,
        rot: Math.random() * 360, vr: (Math.random() - 0.5) * 8,
        s: 6 + Math.random() * 6,
        c: colors[Math.floor(Math.random() * colors.length)],
      });
    }
    var start = performance.now();
    function frame(t) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      pieces.forEach(function (p) {
        p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        p.vy += 0.06;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot * Math.PI / 180);
        ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.45);
        ctx.restore();
      });
      if (t - start < 3500) requestAnimationFrame(frame);
      else canvas.remove();
    }
    requestAnimationFrame(frame);
  }

  /* ---------- Modal markup ---------- */
  function ensureModal() {
    if (document.getElementById("defi-ob")) return;
    var html =
      '<div id="defi-ob-backdrop" class="defi-ob-backdrop" role="presentation">' +
        '<div id="defi-ob" class="defi-ob" role="dialog" aria-modal="true" aria-labelledby="defi-ob-title">' +
          '<button type="button" class="defi-ob__close" id="defi-ob-close" aria-label="Close">×</button>' +
          '<div class="defi-ob__progress" id="defi-ob-progress">' +
            '<span class="defi-ob__dot"></span><span class="defi-ob__dot"></span>' +
            '<span class="defi-ob__dot"></span><span class="defi-ob__dot"></span>' +
          '</div>' +
          '<div id="defi-ob-body"></div>' +
        '</div>' +
      '</div>';
    var wrap = document.createElement("div");
    wrap.innerHTML = html;
    document.body.appendChild(wrap.firstChild);

    document.getElementById("defi-ob-close").addEventListener("click", function () {
      finishOnboarding("skipped");
    });
    document.getElementById("defi-ob-backdrop").addEventListener("click", function (e) {
      if (e.target.id === "defi-ob-backdrop") finishOnboarding("skipped");
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && document.getElementById("defi-ob-backdrop").classList.contains("is-open")) {
        finishOnboarding("skipped");
      }
    });
  }

  function setProgress(step) {
    var dots = document.querySelectorAll("#defi-ob-progress .defi-ob__dot");
    dots.forEach(function (d, i) {
      d.classList.toggle("is-done", i < step - 1);
      d.classList.toggle("is-current", i === step - 1);
    });
  }

  function openModal() {
    document.getElementById("defi-ob-backdrop").classList.add("is-open");
  }
  function closeModal() {
    var bd = document.getElementById("defi-ob-backdrop");
    if (bd) bd.classList.remove("is-open");
  }

  /* ---------- Steps ---------- */

  function renderStep(step) {
    setOb({ status: "in_progress", step: step });
    setProgress(step);
    var body = document.getElementById("defi-ob-body");
    if (step === 1) renderStep1(body);
    else if (step === 2) renderStep2(body);
    else if (step === 3) renderStep3(body);
    else renderStep4(body);
  }

  function renderStep1(body) {
    var signedIn = window.DefiAuth && window.DefiAuth.snapshot().isSignedIn;
    body.innerHTML =
      '<div class="defi-ob__step-tag">Step 1 of 4</div>' +
      '<h2 class="defi-ob__title" id="defi-ob-title">Welcome to DeFi Scoring</h2>' +
      '<p class="defi-ob__desc">' +
        'We turn your on-chain history into a 300–850 credit score, monitor your ' +
        'positions, and alert you before things go wrong. Sign in with your wallet to begin — ' +
        'we never see your private keys, just a one-time signature.' +
      '</p>' +
      '<div class="defi-ob__actions">' +
        '<button class="defi-ob__skip" id="ob-skip">Skip for now</button>' +
        '<button class="defi-btn defi-btn--primary" id="ob-signin">' +
          (signedIn ? "Continue →" : "Connect wallet →") +
        '</button>' +
      '</div>';

    document.getElementById("ob-skip").addEventListener("click", function () { finishOnboarding("skipped"); });
    document.getElementById("ob-signin").addEventListener("click", async function () {
      var btn = this;
      if (window.DefiAuth.snapshot().isSignedIn) { renderStep(2); return; }
      btn.disabled = true; btn.textContent = "Signing…";
      try {
        if (!window.ethereum) throw new Error("Install MetaMask or another EIP-1193 wallet first.");
        var addr = await window.DefiAuth.ensureMetamaskAccount();
        await window.DefiAuth.signIn(addr, window.DefiAuth.metamaskSign);
        renderStep(2);
      } catch (e) {
        btn.disabled = false; btn.textContent = "Connect wallet →";
        var msg = (e && e.message) || "Sign-in failed";
        alert("Couldn't sign in: " + msg);
      }
    });
  }

  function renderStep2(body) {
    body.innerHTML =
      '<div class="defi-ob__step-tag">Step 2 of 4</div>' +
      '<h2 class="defi-ob__title">Your free DeFi credit score</h2>' +
      '<p class="defi-ob__desc">Scoring your on-chain activity now — repayments, liquidations, age, diversification…</p>' +
      '<div id="ob-score-area" class="defi-ob__loading">Computing your score…</div>' +
      '<div class="defi-ob__actions">' +
        '<button class="defi-ob__skip" id="ob-skip2">Skip</button>' +
        '<button class="defi-btn defi-btn--primary" id="ob-next2" disabled>Next →</button>' +
      '</div>';

    document.getElementById("ob-skip2").addEventListener("click", function () { finishOnboarding("skipped"); });
    document.getElementById("ob-next2").addEventListener("click", function () { renderStep(3); });

    runFirstScan();
  }

  async function runFirstScan() {
    var snap = window.DefiAuth.snapshot();
    var wallet = snap.primaryWallet;
    if (!wallet) {
      document.getElementById("ob-score-area").textContent = "Sign in first.";
      return;
    }
    try {
      var r = await api("/api/health-score", {
        method: "POST",
        body: JSON.stringify({ wallet: wallet }),
      });
      // Some response shapes nest under .data; tolerate both.
      var score = (r && r.score) || (r && r.data && r.data.score);
      var band = (r && r.band) || (r && r.data && r.data.band) || "—";
      if (typeof score !== "number") {
        document.getElementById("ob-score-area").innerHTML =
          '<div style="color:var(--defi-warn);text-align:center">' +
          'We couldn\'t reach the scoring backend right now. You can still continue.' +
          '</div>';
        document.getElementById("ob-next2").disabled = false;
        bumpScanCount();
        return;
      }
      bumpScanCount();
      var area = document.getElementById("ob-score-area");
      area.classList.remove("defi-ob__loading");
      area.innerHTML =
        '<div class="defi-ob__score-display">' +
          '<div class="defi-ob__score-num">' + score + '</div>' +
          '<div class="defi-ob__score-band">' +
            '<strong>' + band + '</strong>' +
            (score >= 670 ? "Looking great — you're ahead of most wallets we score." : "We'll show you how to improve in a moment.") +
          '</div>' +
        '</div>';
      document.getElementById("ob-next2").disabled = false;
      if (score >= 670) confetti();
    } catch (e) {
      document.getElementById("ob-score-area").innerHTML =
        '<div style="color:var(--defi-warn);text-align:center">' +
        'Scoring failed: ' + (e.message || "unknown") + '</div>';
      document.getElementById("ob-next2").disabled = false;
    }
  }

  function renderStep3(body) {
    var snap = window.DefiAuth.snapshot();
    var isPaid = snap.tier && snap.tier !== "free";

    body.innerHTML =
      '<div class="defi-ob__step-tag">Step 3 of 4</div>' +
      '<h2 class="defi-ob__title">Stay protected</h2>' +
      '<p class="defi-ob__desc">' +
        'Borrowers get liquidated when their health factor drops below 1.0 — usually within minutes of a price move. ' +
        'We can email you the second yours hits 1.3, giving you time to top up collateral or repay.' +
      '</p>' +
      '<div class="defi-ob__alert-preview">' +
        '<strong>Suggested rule:</strong> Alert me when <code>health_factor &lt; 1.3</code>' +
        ' on <code>' + (snap.primaryWallet ? snap.primaryWallet.slice(0, 10) + "…" : "your wallet") + '</code>' +
        ' via email, with a 1-hour cooldown.' +
      '</div>' +
      (isPaid ?
        '<div id="ob-alert-result" style="margin-bottom:14px"></div>' : '') +
      (!isPaid ?
        '<div class="defi-ob__upsell">' +
          '<h4>Alerts unlock with Pro ($15/mo)</h4>' +
          '<ul><li>Real-time email + Telegram alerts</li>' +
              '<li>Up to 25 active rules</li>' +
              '<li>30-day score history</li></ul>' +
        '</div>' : '') +
      '<div class="defi-ob__actions">' +
        '<button class="defi-ob__skip" id="ob-skip3">Skip</button>' +
        (isPaid ?
          '<button class="defi-btn defi-btn--ghost" id="ob-skip-rule">Maybe later</button>' +
          '<button class="defi-btn defi-btn--primary" id="ob-create-rule">Create rule →</button>' :
          '<a class="defi-btn defi-btn--primary" href="/pricing/" id="ob-go-pricing" style="text-decoration:none">See plans →</a>'
        ) +
      '</div>';

    document.getElementById("ob-skip3").addEventListener("click", function () { finishOnboarding("skipped"); });

    if (isPaid) {
      document.getElementById("ob-skip-rule").addEventListener("click", function () { renderStep(4); });
      document.getElementById("ob-create-rule").addEventListener("click", createSuggestedRule);
    } else {
      document.getElementById("ob-go-pricing").addEventListener("click", function () {
        // We mark complete BEFORE the navigation so the modal doesn't pop again on return.
        finishOnboarding("complete");
      });
    }
  }

  async function createSuggestedRule() {
    var snap = window.DefiAuth.snapshot();
    var btn = document.getElementById("ob-create-rule");
    var resultEl = document.getElementById("ob-alert-result");
    btn.disabled = true; btn.textContent = "Creating…";

    // Best-effort: ensure the user has at least one email channel. If not,
    // we surface a hint pointing them to the alerts page rather than asking
    // for an email here (keeps the modal simple).
    var chans = await api("/api/alerts/channels");
    var emailChan = (chans && chans.channels || []).find(function (c) { return c.kind === "email"; });
    if (!emailChan) {
      resultEl.innerHTML =
        '<div style="color:var(--defi-warn);font-size:13px">' +
        'No email channel set up yet. We\'ll save the rule once you add one on the ' +
        '<a href="/dashboard/alerts/" style="color:var(--defi-accent)">Alerts page</a>.' +
        '</div>';
      btn.disabled = false; btn.textContent = "Create rule →";
      return;
    }

    var r = await api("/api/alerts/rules", {
      method: "POST",
      body: JSON.stringify({
        wallet_address: snap.primaryWallet,
        kind: "health_factor",
        params: { lt: 1.3 },
        channels: ["email"],
        cooldown_secs: 3600,
      }),
    });
    if (!r.success) {
      resultEl.innerHTML = '<div style="color:var(--defi-bad);font-size:13px">' +
        'Couldn\'t create rule: ' + r.error + '</div>';
      btn.disabled = false; btn.textContent = "Create rule →";
      return;
    }
    resultEl.innerHTML = '<div style="color:var(--defi-good);font-size:13px">✓ Rule active. We\'ll email you the moment HF drops below 1.3.</div>';
    setTimeout(function () { renderStep(4); }, 1100);
  }

  function renderStep4(body) {
    body.innerHTML =
      '<div class="defi-ob__step-tag">Step 4 of 4</div>' +
      '<h2 class="defi-ob__title">You\'re all set</h2>' +
      '<p class="defi-ob__desc">' +
        'Your dashboard is ready. From here you can scan more wallets, build deeper rules, ' +
        'or explore the AI risk profiler.' +
      '</p>' +
      '<div class="defi-ob__upsell">' +
        '<h4>Want longer history & more wallets?</h4>' +
        '<ul>' +
          '<li><strong>Pro $15/mo</strong> — 30-day history, 3 wallets, 25 alert rules</li>' +
          '<li><strong>Plus $49/mo</strong> — 1-year history, 10 wallets, Telegram + webhook</li>' +
        '</ul>' +
      '</div>' +
      '<div class="defi-ob__actions">' +
        '<a class="defi-btn defi-btn--ghost" href="/pricing/" style="text-decoration:none">See plans</a>' +
        '<button class="defi-btn defi-btn--primary" id="ob-finish">Open dashboard →</button>' +
      '</div>';
    document.getElementById("ob-finish").addEventListener("click", function () { finishOnboarding("complete"); });
  }

  function finishOnboarding(status) {
    setOb({ status: status, finished_at: Date.now() });
    closeModal();
  }

  /* ---------- Soft upgrade nudge ---------- */

  function bumpScanCount() {
    var n = parseInt(localStorage.getItem(KEY_SCAN) || "0", 10) + 1;
    localStorage.setItem(KEY_SCAN, String(n));
    return n;
  }

  function shouldShowNudge() {
    var snap = window.DefiAuth ? window.DefiAuth.snapshot() : { tier: "free" };
    if (snap.tier && snap.tier !== "free") return false;
    var n = parseInt(localStorage.getItem(KEY_SCAN) || "0", 10);
    if (n < NUDGE_AFTER_SCANS) return false;
    var st = readJson(KEY_NUDGE, {});
    if (st.dismissed_at && Date.now() - st.dismissed_at < NUDGE_REARM_MS) return false;
    return true;
  }

  function renderNudge() {
    if (document.getElementById("defi-nudge")) return;
    if (!shouldShowNudge()) return;
    var host = document.querySelector(".defi-main") || document.querySelector(".defi-content") || document.body;
    if (!host) return;
    // Target the inner content wrapper if present so the banner sits above
    // the topbar instead of beside the sidebar.
    var topbar = host.querySelector(".defi-topbar");
    var banner = document.createElement("div");
    banner.id = "defi-nudge";
    banner.className = "defi-nudge";
    banner.innerHTML =
      '<span class="defi-nudge__icon">⚡</span>' +
      '<div class="defi-nudge__body">' +
        '<div class="defi-nudge__title">You\'re an active user — unlock more with Pro</div>' +
        '<div class="defi-nudge__sub">Get 30-day history, 3 wallets, 25 alert rules, and Telegram delivery.</div>' +
      '</div>' +
      '<a href="/pricing/" class="defi-nudge__cta">Upgrade →</a>' +
      '<button type="button" class="defi-nudge__close" aria-label="Dismiss">×</button>';
    if (topbar && topbar.parentNode) topbar.parentNode.insertBefore(banner, topbar.nextSibling);
    else host.insertBefore(banner, host.firstChild);
    banner.querySelector(".defi-nudge__close").addEventListener("click", function () {
      writeJson(KEY_NUDGE, { dismissed_at: Date.now() });
      banner.remove();
    });
  }

  /* ---------- Boot ---------- */

  function maybeOpenModal() {
    var st = getOb();
    if (st.status === "complete" || st.status === "skipped") return;
    ensureModal();
    renderStep(st.step || 1);
    openModal();
  }

  document.addEventListener("DOMContentLoaded", function () {
    // Open modal once DefiAuth has resolved its initial state, so step 1's
    // "Continue" vs "Connect" button shows the right label.
    if (window.DefiAuth && window.DefiAuth.init) {
      window.DefiAuth.init().then(function () {
        maybeOpenModal();
        renderNudge();
      });
    } else {
      maybeOpenModal();
      renderNudge();
    }
  });

  // Existing dashboard fires `defi:scan` on every manual rescan; count it
  // and re-evaluate whether to surface the nudge.
  document.addEventListener("defi:scan", function () {
    bumpScanCount();
    setTimeout(renderNudge, 200);
  });

  // Re-show evaluator when auth state flips (e.g. just upgraded → hide nudge).
  if (window.DefiAuth) {
    window.DefiAuth.subscribe(function () {
      var n = document.getElementById("defi-nudge");
      var snap = window.DefiAuth.snapshot();
      if (snap.tier && snap.tier !== "free" && n) n.remove();
    });
  }

  // Public API for tests / "Reset onboarding" footer link if we add one later.
  window.DefiOnboarding = {
    open: function () {
      writeJson(KEY_OB, { status: "in_progress", step: 1 });
      ensureModal();
      renderStep(1);
      openModal();
    },
    reset: function () {
      localStorage.removeItem(KEY_OB);
      localStorage.removeItem(KEY_SCAN);
      localStorage.removeItem(KEY_NUDGE);
    },
    state: getOb,
  };
})();
