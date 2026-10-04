// Dark / light for every page in the extension.
//
// theme.css holds the two palettes; this file only decides which one is on and
// keeps every open page in step. It is loaded before each page's own script so
// the attribute is set as early as possible.
//
// Dark is the default, and it is also what plain CSS gives you (theme.css puts
// the dark values on `:root` and light behind `[data-theme="light"]`). That
// ordering is the whole trick: there is no flash of the wrong colours while the
// stored preference is read, because the default IS the pre-script state.
(() => {
  "use strict";

  const KEY = "theme";
  const DEFAULT = "dark";
  const VALID = ["dark", "light"];
  const root = document.documentElement;

  function clean(v) { return VALID.includes(v) ? v : DEFAULT; }

  function apply(name) {
    const t = clean(name);
    root.setAttribute("data-theme", t);
    // Buttons rendered before the preference arrived get their label fixed here.
    paintButtons(t);
    return t;
  }

  function current() { return clean(root.getAttribute("data-theme")); }

  // Written to storage, which is what makes every other open page follow: they
  // are all listening for this key below.
  async function set(name) {
    const t = clean(name);
    apply(t);
    try { await chrome.storage.local.set({ [KEY]: t }); } catch {}
    return t;
  }
  function toggle() { return set(current() === "dark" ? "light" : "dark"); }

  // ---- the button -------------------------------------------------------
  // Shows where you're going, not where you are: in dark mode it offers the sun.
  function glyph(t) { return t === "dark" ? "☀️" : "🌙"; }
  function label(t) { return t === "dark" ? "Switch to light mode" : "Switch to dark mode"; }

  function buttonHtml(extraClass) {
    const t = current();
    return `<button type="button" class="themebtn ${extraClass || ""}" data-theme-toggle
      title="${label(t)}" aria-label="${label(t)}"><span aria-hidden="true">${glyph(t)}</span></button>`;
  }
  function paintButtons(t) {
    document.querySelectorAll("[data-theme-toggle]").forEach(b => {
      b.setAttribute("title", label(t));
      b.setAttribute("aria-label", label(t));
      const g = b.querySelector("span") || b;
      g.textContent = glyph(t);
    });
  }
  // One delegated listener, so buttons survive every re-render of a page.
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("[data-theme-toggle]");
    if (!b) return;
    e.preventDefault();
    toggle();
  });

  // ---- boot + stay in step ---------------------------------------------
  try {
    chrome.storage.local.get([KEY], (r) => {
      void chrome.runtime.lastError;
      apply(r && r[KEY]);
    });
    chrome.storage.onChanged.addListener((c, area) => {
      if (area !== "local" || !c[KEY]) return;
      apply(c[KEY].newValue);
    });
  } catch {
    apply(DEFAULT);
  }

  window.FGTheme = { current, apply, set, toggle, buttonHtml, glyph, label, KEY, DEFAULT };
})();
