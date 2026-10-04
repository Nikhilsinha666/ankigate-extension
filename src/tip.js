// Shared "?" tooltip placement, used by every page that renders a .tip bubble
// (options, popup, blocked, study).
//
// Why this exists: the bubble used to be absolutely positioned inside the "?"
// span, so any ancestor with `overflow: hidden` clipped it — the folder rows in
// the options page cut their tooltips in half. Raising z-index cannot fix that;
// overflow clipping happens regardless of stacking order.
//
// So the bubble is `position: fixed` (see the .tip-box rules in each
// stylesheet) and this script parks it next to its "?" in viewport
// coordinates. Fixed elements are laid out against the viewport, so no
// ancestor can clip them, and nothing on the page can cover them.
(() => {
  "use strict";
  const GAP = 8;      // space between the "?" and the bubble
  const EDGE = 10;    // keep this far from the window edges
  let openTip = null; // the .tip whose bubble is currently placed

  // `position: fixed` normally means "relative to the window" — but a `filter`,
  // `transform`, `backdrop-filter`, `perspective`, `will-change` or `contain`
  // on any ancestor makes THAT element the reference box instead. Two places
  // here do exactly that: the greyed-out card body when a gate is off, and the
  // frosted cards on the blocked page. So find such an ancestor, if any, and
  // measure from it rather than from the window.
  function fixedHost(el) {
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.transform !== "none" || cs.perspective !== "none" ||
          (cs.filter && cs.filter !== "none") ||
          (cs.backdropFilter && cs.backdropFilter !== "none") ||
          (cs.webkitBackdropFilter && cs.webkitBackdropFilter !== "none") ||
          /transform|filter|perspective/.test(cs.willChange || "") ||
          /paint|layout|strict|content/.test(cs.contain || "")) return p;
    }
    return null;
  }

  // Make the bubble's text reachable by a screen reader, and the "?" operable by
  // keyboard the way its role promises.
  //
  // The markup is `<span class="tip" role="button" aria-label="More information">`
  // wrapping both the "?" and the bubble. An accessible NAME overrides an element's
  // contents, so that aria-label was all a screen reader ever announced — the
  // explanation inside was masked by the very attribute meant to describe it. Every
  // tooltip in the extension was unreachable, and tooltips are where this extension
  // keeps most of its explaining.
  //
  // aria-describedby is additive rather than overriding, so the bubble is announced
  // after the name. Wired here, lazily, because the pages rebuild their markup
  // constantly and any id stamped in at render time would be duplicated or lost.
  let tipSeq = 0;
  function describe(tip) {
    const box = tip.querySelector(".tip-box");
    if (!box) return;
    if (!box.id) box.id = "fgtip" + (++tipSeq);
    if (tip.getAttribute("aria-describedby") !== box.id) {
      tip.setAttribute("aria-describedby", box.id);
    }
    // role="button" promises Enter and Space work. Announce the pinned state too, so
    // it isn't a button whose effect is invisible.
    tip.setAttribute("aria-expanded", tip.classList.contains("open") ? "true" : "false");
  }

  function place(tip) {
    const box = tip.querySelector(".tip-box");
    if (!box) return;
    describe(tip);
    openTip = tip;

    // Measuring needs the height cap off for a moment, and an uncapped bubble
    // cannot scroll — so the browser throws away how far you had read. Remember it
    // and put it back once the cap is on again.
    const keepScroll = box.scrollTop;

    // Measure at natural size, ignoring any placement from last time.
    box.style.left = "0px";
    box.style.top = "0px";
    box.style.right = "auto";
    box.style.bottom = "auto";
    box.style.maxHeight = "";

    const anchor = (tip.querySelector(".tip-i") || tip).getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let w = box.offsetWidth, h = box.offsetHeight;

    // A very tall bubble (the long setup explanations) gets a scrollbar rather
    // than running off the screen.
    const maxH = vh - EDGE * 2;
    if (h > maxH) {
      box.style.maxHeight = maxH + "px";
      box.style.overflowY = "auto";
      h = maxH;
    } else {
      box.style.overflowY = "";
    }

    // Prefer left-aligned with the "?", then pull back inside the window.
    let left = anchor.left;
    if (left + w > vw - EDGE) left = vw - EDGE - w;
    if (left < EDGE) left = EDGE;

    // Prefer below the "?"; flip above when there isn't room, and if neither
    // side fits, take whichever is roomier.
    const below = vh - anchor.bottom - GAP - EDGE;
    const above = anchor.top - GAP - EDGE;
    let top = anchor.bottom + GAP;
    if (h > below && above > below) top = anchor.top - GAP - h;
    if (top < EDGE) top = EDGE;
    if (top + h > vh - EDGE) top = Math.max(EDGE, vh - EDGE - h);

    // Convert to the reference box actually in play (see fixedHost).
    let ox = 0, oy = 0;
    const host = fixedHost(box);
    if (host) {
      const hr = host.getBoundingClientRect(), hs = getComputedStyle(host);
      // The containing block is the host's padding box, so skip its border.
      ox = hr.left + (parseFloat(hs.borderLeftWidth) || 0);
      oy = hr.top + (parseFloat(hs.borderTopWidth) || 0);
    }

    box.style.left = Math.round(left - ox) + "px";
    box.style.top = Math.round(top - oy) + "px";
    if (keepScroll) box.scrollTop = keepScroll;
  }

  // Hover and keyboard focus reveal the bubble through CSS; we only have to put
  // it in the right spot the moment that happens.
  // Placed on every hover, including hovering the same "?" twice.
  //
  // There used to be a `tip !== openTip` guard here, which looked like a sensible
  // "don't redo work" check but wasn't: openTip is only ever reassigned by place(),
  // so the LAST bubble you touched was permanently exempt. Hover it, move away,
  // scroll the page, hover it again — placement was skipped and the bubble
  // reappeared at its old viewport coordinates, adrift from its "?" by however far
  // you had scrolled, often off-screen entirely on the long explanations.
  document.addEventListener("pointerover", (e) => {
    const tip = e.target.closest && e.target.closest(".tip");
    if (tip) place(tip);
  }, true);
  document.addEventListener("focusin", (e) => {
    const tip = e.target.closest && e.target.closest(".tip");
    if (tip) place(tip);
  }, true);
  // Tap / click pins the bubble open. Hovering is mouse-only, so without this a
  // touch screen could never read a tooltip. This used to be a small inline script
  // repeated in each page, which an extension page's content policy forbids
  // outright ("Executing inline script violates ... script-src 'self'") — so the
  // bubbles simply didn't open on the blocked and study pages. It belongs here
  // anyway: one copy, for every page that loads this file.
  document.addEventListener("click", (e) => {
    const tip = e.target.closest && e.target.closest(".tip");
    // Clicking anywhere else closes whatever was pinned.
    document.querySelectorAll(".tip.open").forEach(x => {
      if (x !== tip) { x.classList.remove("open"); x.setAttribute("aria-expanded", "false"); }
    });
    if (!tip) return;
    tip.classList.toggle("open");
    e.preventDefault();
    describe(tip);
    if (tip.classList.contains("open")) place(tip);
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      document.querySelectorAll(".tip.open").forEach(x => {
        x.classList.remove("open");
        x.setAttribute("aria-expanded", "false");
      });
      return;
    }
    // Enter and Space pin the bubble. The "?" carries role="button", which tells
    // assistive technology those keys will work — and they didn't, because only a
    // click was handled. A keyboard user could reveal a bubble by tabbing to it (CSS
    // :focus does that) but could not pin it, so it vanished the moment they moved
    // on, and Space scrolled the page out from under them instead.
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    const tip = e.target.closest && e.target.closest(".tip");
    if (!tip) return;
    e.preventDefault();
    document.querySelectorAll(".tip.open").forEach(x => {
      if (x !== tip) { x.classList.remove("open"); x.setAttribute("aria-expanded", "false"); }
    });
    tip.classList.toggle("open");
    describe(tip);
    if (tip.classList.contains("open")) place(tip);
  });

  // Keep a pinned bubble glued to its "?" while the page moves under it.
  const reflow = () => {
    if (!openTip) return;
    if (!openTip.isConnected) { openTip = null; return; }
    if (openTip.classList.contains("open") || openTip.matches(":hover") || openTip.contains(document.activeElement)) place(openTip);
  };
  // Scrolling the PAGE should keep the bubble glued to its "?". Scrolling INSIDE
  // the bubble must be left alone: re-placing it re-measures at full height, which
  // is what made a long explanation snap back to the top on every wheel tick.
  window.addEventListener("scroll", (e) => {
    const t = e.target;
    if (t && t.nodeType === 1 && t.closest && t.closest(".tip-box")) return;
    reflow();
  }, true);
  window.addEventListener("resize", reflow);
})();
