// ONE VIDEO, ONE COVER — the arbiter three extensions share.
//
// ---------------------------------------------------------------------------
// The problem this exists to solve
//
// FocusGate, "Keyword Nutrition for YouTube" and "Block Sites Until I Complete ANKI" are three
// separate extensions that do the same thing to the same element. Each one, with its AI check on,
// appends a cover INSIDE #movie_player, pauses the <video>, and re-evaluates the page on a timer and
// on a MutationObserver. Installed together on one watch page that is four independent loops writing
// to one subtree, and the result is not three covers — it is a strobe:
//
//   1. A's cover is appended. That is a childList mutation inside the player.
//   2. B's observer (subtree of <body> / of <html>) sees it and runs a full pass.
//   3. B's pass tears its own cover down and rebuilds it, which is another mutation.
//   4. C's observer sees THAT and runs a pass. Which A's… and so on, at the floor of
//      whatever debounce each one uses.
//
// On top of the loop, each cover animates a fade-in when it is inserted, so every rebuild is a
// visible flash even in the frames where nothing was ever actually missing. And underneath all of it
// the three fight over playback: one of them calls play() when its own verdict comes back clean while
// the other two still have the video held, so `play` → `pause` → `playing`/`waiting` events feed yet
// more evaluation passes.
//
// ---------------------------------------------------------------------------
// The rule
//
// At most ONE extension draws a cover over a given player at a time, and only that one holds the
// video. The other two stand down: no cover, no pause, no resume. They keep their own verdicts and
// their own counters — nothing about the decision changes — they simply do not draw.
//
// Ownership is a lease, written to one attribute on <html> because that is the only thing three
// isolated worlds share. It is taken by:
//
//   SEVERITY first.  A settled refusal ("block") outranks a check in progress ("check"), so a video
//                    one extension has actually refused is never left showing another's "analysing…"
//                    panel. This is the half that keeps the outcome correct.
//   RANK second.     A fixed, arbitrary order breaks ties, so two extensions in the same state agree
//                    on which of them draws without needing to talk.
//
// The lease EXPIRES. The holder restamps it while it is still drawing; if that stops — the extension
// was switched off, the tab navigated, the worker was evicted mid-check — it goes stale in a couple
// of seconds and the next claimant takes over. That is what stops one crashed extension from leaving
// the player permanently un-coverable by the other two.
//
// ---------------------------------------------------------------------------
// The second half: marked UI
//
// Ownership alone does not stop the observer loop, because every extension has OTHER UI on the page
// that churns — a floating clock repainting every 250ms, a progress panel re-rendering as a check
// advances, a scan animation. So every element any of the three injects carries `data-vblock-ui`,
// and every observer ignores mutations that happened inside one. An extension's own UI is not page
// content and was never worth re-evaluating the page over — not its own, and certainly not a
// neighbour's.
//
// ---------------------------------------------------------------------------
// Notes on the implementation
//
//   * Three IDENTICAL copies of this file, one per extension, differing in the two lines marked
//     below. Not a shared module: they cannot share one. Content scripts run in a world per
//     extension, so `window.__VBlock` here is invisible to the other two — the DOM attribute is the
//     entire channel, which is also what makes this work when only one of the three is installed.
//   * Stateless. Everything it knows is read back out of the attribute, so a re-injection after an
//     extension reload cannot desynchronise it, and there is nothing to migrate.
//   * Never throws. Every DOM touch is guarded; a failure degrades to "I do not own the cover",
//     which is the safe answer — the caller draws nothing rather than drawing over somebody else.
(() => {
  "use strict";

  // ---- the only two lines that differ between the three copies -------------
  const ID = "ankigate";
  const RANK = 2;
  // -------------------------------------------------------------------------

  // Whoever holds the cover, as "id|rank|severity|stamp".
  const ATTR = "data-vblock";
  // On every element any of the three injects. Read by all three observers.
  const UI_ATTR = "data-vblock-ui";

  // How long a lease survives without being restamped.
  //
  // The holders restamp on their own evaluation cadence, which is between 500ms and 1s, so this is
  // two to five missed beats. Long enough that an ordinary slow pass never loses the cover
  // mid-check; short enough that an extension switched off from its popup does not hold the player
  // hostage for a noticeable time.
  const STALE_MS = 2600;
  // Restamping is an attribute write, and the holder asks on every pass. Nobody observes <html>'s
  // attributes, so this is cheap either way — but there is no reason to write four times a second
  // when the lease lasts 2.6 seconds.
  const REFRESH_MS = 600;

  const SEV = { none: 0, check: 1, block: 2 };

  let wroteAt = 0;

  function root() {
    try { return document.documentElement || null; } catch (e) { return null; }
  }

  // The live lease, or null for "nobody holds it". A lease past its expiry reads as null: that is the
  // whole mechanism by which a holder that stopped reporting lets go.
  function read() {
    const el = root();
    if (!el) return null;
    let raw = "";
    try { raw = el.getAttribute(ATTR) || ""; } catch (e) { return null; }
    if (!raw) return null;
    const p = raw.split("|");
    if (p.length < 4 || !p[0]) return null;
    const rank = Number(p[1]), sev = Number(p[2]), at = Number(p[3]);
    if (!Number.isFinite(rank) || !Number.isFinite(sev) || !Number.isFinite(at)) return null;
    if (Date.now() - at > STALE_MS) return null;
    return { id: p[0], rank: rank, sev: sev, at: at };
  }

  function write(sev) {
    const el = root();
    if (!el) return false;
    const now = Date.now();
    try {
      // Already ours, already this severity, and stamped recently enough. Nothing to say.
      const raw = el.getAttribute(ATTR) || "";
      if (raw.indexOf(ID + "|" + RANK + "|" + sev + "|") === 0 && now - wroteAt < REFRESH_MS) return true;
      el.setAttribute(ATTR, ID + "|" + RANK + "|" + sev + "|" + now);
      wroteAt = now;
      return true;
    } catch (e) { return false; }
  }

  // "I want to cover this player, at this severity." True means draw; false means stand down.
  //
  // `kind` is "block" for a settled refusal and "check" for a decision still being made. Anything
  // else is treated as "nothing to draw" and releases instead, so a caller cannot accidentally hold
  // the lease by passing a state it forgot to handle.
  function claim(kind) {
    const sev = SEV[kind] || 0;
    if (!sev) { release(); return false; }
    const held = read();
    if (!held) return write(sev);                          // free, or the last holder went quiet
    if (held.id === ID) return write(sev);                 // ours already — this is the restamp
    if (sev > held.sev) return write(sev);                 // a refusal takes over from a check
    if (sev === held.sev && RANK < held.rank) return write(sev);   // same state, fixed tie-break
    return false;
  }

  function owns() {
    const h = read();
    return !!h && h.id === ID;
  }

  // Is one of the OTHER extensions currently covering this player? The question playback has to ask
  // before it starts anything: a video another extension is deliberately holding must not be handed
  // back by us, whatever our own verdict turned out to be.
  function heldByOther() {
    const h = read();
    return !!h && h.id !== ID;
  }

  function release() {
    const el = root();
    if (!el) return;
    try {
      const raw = el.getAttribute(ATTR) || "";
      if (!raw) return;
      // Only ever our own lease — including an expired one still sitting in the attribute, which is
      // ours to tidy up. Another extension's live lease is left strictly alone.
      if (raw.indexOf(ID + "|") !== 0) return;
      el.removeAttribute(ATTR);
      wroteAt = 0;
    } catch (e) {}
  }

  // Declare an element ours. Call it on the ROOT of anything injected — covers, panels, badges,
  // floating cards, animations — so `closest()` finds it from any descendant.
  function mark(node) {
    try { if (node && node.setAttribute) node.setAttribute(UI_ATTR, ID); } catch (e) {}
  }

  // Did this mutation happen inside an extension's own UI? If so it is not a change to the PAGE, and
  // re-running a filter pass over it is the feedback loop this whole file exists to break.
  function isAnyUi(node) {
    try {
      const el = node && node.nodeType === 1 ? node : (node && node.parentElement);
      return !!(el && el.closest && el.closest("[" + UI_ATTR + "]"));
    } catch (e) { return false; }
  }
  function isForeignUi(node) {
    try {
      const el = node && node.nodeType === 1 ? node : (node && node.parentElement);
      if (!el || !el.closest) return false;
      const hit = el.closest("[" + UI_ATTR + "]");
      return !!hit && hit.getAttribute(UI_ATTR) !== ID;
    } catch (e) { return false; }
  }

  window.__VBlock = {
    ID: ID,
    claim: claim,
    owns: owns,
    heldByOther: heldByOther,
    release: release,
    mark: mark,
    isAnyUi: isAnyUi,
    isForeignUi: isForeignUi
  };
})();
