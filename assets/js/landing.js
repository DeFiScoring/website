/* DeFiScore landing page — animated score gauge + mobile menu.
 * The gauge animates from 300 to a target score on load. Pure vanilla JS,
 * no build step, respects prefers-reduced-motion. */
(function () {
  "use strict";

  // --- Mobile menu toggle -------------------------------------------------
  const toggle = document.querySelector("[data-ds-menu-toggle]");
  const links = document.querySelector(".ds-nav__links");
  if (toggle && links) {
    toggle.addEventListener("click", () => {
      const open = links.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    links.querySelectorAll("a").forEach((a) =>
      a.addEventListener("click", () => {
        links.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      })
    );
  }

  // --- Score gauge --------------------------------------------------------
  const gauge = document.querySelector("[data-ds-gauge]");
  if (!gauge) return;

  const arc       = gauge.querySelector("[data-ds-gauge-arc]");
  const valueEl   = gauge.querySelector("[data-ds-gauge-value]");
  const gradeEl   = gauge.querySelector("[data-ds-gauge-grade]");
  if (!arc || !valueEl || !gradeEl) return;

  const MIN = 300;
  const MAX = 850;
  const TARGET = 782; // sample wallet score — tuned for an "excellent" look
  const CIRCUMFERENCE = 527.79; // 2πr for r=84

  // The band comes from score-bands.js; the letter is the landing page's own
  // flourish and exists nowhere else in the product. The thresholds used to be
  // inlined here as 740/670/580 — a different set than the scoring backend, so
  // the landing gauge disagreed with the product it was demonstrating.
  //
  // The rest of this gauge is deliberately unlike every other one: a brand
  // cyan→purple gradient rather than a band colour, a blur glow, a 2100ms
  // tween, and a legend whose Excellent swatch is purple. That is a marketing
  // treatment, not drift — leave it be.
  const LETTER = { excellent: "A", good: "B", fair: "C", poor: "D" };

  function grade(score) {
    const b = window.DefiBands.forScore(score);
    return b.label + " · " + LETTER[b.key];
  }

  function ease(t) { return 1 - Math.pow(1 - t, 3); } // easeOutCubic

  function render(score) {
    // CIRCUMFERENCE stays the hardcoded 527.79 that index.html's
    // stroke-dasharray also carries; computing 2π·84 would disagree with the
    // markup's pre-JS initial state in the fifth decimal for no gain.
    const pct = window.DefiBands.fraction(score);
    arc.setAttribute("stroke-dashoffset", String(CIRCUMFERENCE * (1 - pct)));
    valueEl.textContent = String(Math.round(score));
    gradeEl.textContent = grade(score);
  }

  // Respect reduced motion — snap to target.
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) { render(TARGET); return; }

  render(MIN);

  function animate() {
    const duration = 2100;
    const start = performance.now();
    function step(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = ease(t);
      render(MIN + (TARGET - MIN) * eased);
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // Animate when the gauge scrolls into view (works on slower connections too).
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { animate(); io.disconnect(); }
      });
    }, { threshold: 0.35 });
    io.observe(gauge);
  } else {
    animate();
  }
})();
