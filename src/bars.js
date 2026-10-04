// One colour ramp for every progress bar in the extension: red at the start,
// through orange and yellow, to green when it's full — so the colour says where
// you are before you've read a number.
//
// This used to be three copies of the same four functions in options.js, popup.js
// and blocked.js, each with a comment asking the next person to keep them
// identical. Extension pages can't import modules from one another, but they can
// all load the same classic script, so this is that one copy. Loaded before each
// page's own script.
(() => {
  "use strict";

  function barHue(pct) {
    // Coerced before clamping. Math.min(100, undefined) is NaN, NaN survives
    // every step after it, and the bar ends up with `hsl(NaN ...)` — invalid CSS,
    // so the browser drops the declaration and you get a colourless bar with no
    // error anywhere. paintBar and barStyle happened to clamp first, but barFill
    // is called directly too, so the guard belongs here.
    const n = Number(pct);
    const p = Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0)) / 100;
    // Eased, so orange arrives around a quarter and yellow around half, instead
    // of the whole first half looking red.
    return Math.round(120 * Math.pow(p, 0.85));
  }
  function barFill(pct) {
    const h = barHue(pct);
    const from = Math.max(0, h - 40);
    const sat = h >= 100 ? 68 : 92;
    const lit = h >= 100 ? 46 : 52;
    return `linear-gradient(90deg, hsl(${from} ${sat}% ${Math.min(58, lit + 4)}%), hsl(${h} ${sat}% ${lit}%))`;
  }
  function barGlow(pct) {
    return `0 0 6px hsla(${barHue(pct)}, 90%, 50%, .45)`;
  }
  // Paint one bar's fill: width, colour and glow in one place. `shown: false`
  // means "empty means empty" — no colour, no glow, no minimum width.
  function paintBar(fill, pct, shown) {
    if (!fill) return;
    const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
    const w = shown === false ? 0 : p;
    fill.style.width = w + "%";
    fill.style.background = barFill(p);
    fill.style.boxShadow = w > 0 ? barGlow(p) : "none";
    fill.classList.toggle("zero", w <= 0);
  }
  // The same thing as an inline style, for freshly rendered markup.
  function barStyle(pct, shown) {
    const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
    const w = shown === false ? 0 : p;
    return `width:${w}%;background:${barFill(p)};box-shadow:${w > 0 ? barGlow(p) : "none"}`;
  }

  Object.assign(window, { barHue, barFill, barGlow, paintBar, barStyle });
})();
