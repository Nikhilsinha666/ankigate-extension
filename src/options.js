// Settings page for "Block Sites Until I Complete ANKI".
//
// There is exactly one thing to earn here — time in your Anki desktop app — and
// one thing it unlocks: the sites you listed. So the page is two steps, in that
// order, and everything else (the password, the day boundary, strict mode) sits
// behind the Setup tab.

// Keep-alive port, so the background knows when this page closes and can re-lock.
try { chrome.runtime.connect({ name: "options" }); } catch {}

async function sha256(str) {
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const $ = (s, root = document) => root.querySelector(s);
const app = document.getElementById("app");

// Which add-on version this extension ships, read from the copy inside the package
// rather than typed here twice. The literal is only the value for the instant before
// the fetch lands — and it is checked against anki-addon/addon.json by tools/smoke.mjs,
// because a stale fallback would nag people to install the version they already have.
//
// addon.json, not manifest.json: the Web Store rejects any package with a second
// manifest.json in it. See buildAddonBlob, which renames it on the way into the file
// Anki actually receives.
let ANKI_ADDON_VERSION = "4.7";
// The one host the AI second opinion talks to, as a match pattern.
//
// Kept as a literal here as well as in background.js rather than shared, because the two uses are
// different: this page ASKS for the permission, the worker CHECKS it, and the request has to name the
// origin exactly. It is spelt out rather than derived so that a typo cannot turn a narrow request into
// a broad one. See askAiOrigin.
const AI_ORIGIN_PATTERN = "https://generativelanguage.googleapis.com/*";
// The second service's one host, for when Groq is picked under Model. Spelt out for the same reason.
const GROQ_ORIGIN_PATTERN = "https://api.groq.com/*";
// Which of the two a service needs.
function aiOriginPatternOf(provider) {
  return provider === "groq" ? GROQ_ORIGIN_PATTERN : AI_ORIGIN_PATTERN;
}
// (There is no youtube.com origin here any more. The deep mode's subtitles used to be fetched by the
// worker behind an optional youtube.com permission; the YouTube tab reads them itself now, which needs
// none — see videoRecord in yt-mark.js.)
// Whether that number has actually been read, as opposed to being the fallback above.
//
// The mismatch warning waits for this. The first render can happen before the fetch
// lands, and a warning built on a fallback that had drifted would tell people to install
// the version they already have — the exact failure reading the file was meant to end.
// Silence for one repaint cycle is the safe direction: the dot simply says "connected"
// until the real number arrives, and the page repaints about once a second anyway.
let ankiAddonVersionKnown = false;
try {
  fetch(chrome.runtime.getURL("anki-addon/addon.json"))
    .then(r => r.json())
    .then(m => {
      if (m && m.human_version) ANKI_ADDON_VERSION = String(m.human_version);
      ankiAddonVersionKnown = true;
    })
    .catch(() => {});
} catch {}

async function getState() { return await chrome.storage.local.get(null); }
// The write with no gate on it. Two callers only: the password screens themselves, which have
// just checked the password by hand and must not be asked for it a second time, and the unlock.
// Everything else goes through setStateP, which is where the password is asked for.
async function setStateRaw(p) { return await chrome.storage.local.set(p); }
// Thrown when a write is refused because the page is locked and the password wasn't given.
// Its whole job is to stop the caller: nearly every handler here is `await setStateP(...)`
// followed by a re-render and a "Saved", and none of those may happen. A named class rather
// than a bare throw so the rejection handler at the bottom of this file can tell it apart from
// a real fault and keep it out of the console.
class EditLocked extends Error {
  constructor() { super("locked"); this.name = "EditLocked"; }
}
// "Make this stricter?" confirmation dialog when settings are locked.
// FocusGate-style dialog warning the user that tightening requires no password now,
// but undoing it will require the password.
function confirmTighten(what) {
  return new Promise(resolve => {
    const back = document.createElement("div");
    back.className = "sheetback";
    back.innerHTML = `
      <div class="sheet" role="alertdialog" aria-modal="true" aria-labelledby="stTitle" aria-describedby="stBody" style="max-width:440px;border-color:rgba(249,115,22,0.35)">
        <div class="sheettop" style="margin-bottom:12px">
          <span class="sheetic" aria-hidden="true" style="font-size:22px">⚠️</span>
          <h3 id="stTitle" style="font-size:16px;font-weight:700;color:var(--hi,#fde68a)">Make this stricter?</h3>
        </div>
        <p id="stBody" style="font-size:13px;line-height:1.55;color:var(--ink);margin-bottom:12px">
          You are about to tighten <b>${escHtml(what)}</b>.
        </p>
        <p style="font-size:12.5px;line-height:1.55;color:var(--ink2);margin-bottom:12px">
          This needs no password — going in this direction never does.<br/>
          <b>Undoing it will.</b> Settings are locked right now, so putting this back means typing your password.
        </p>
        <p style="font-size:12px;line-height:1.5;color:var(--muted);margin-bottom:16px">
          That is the point of it, not a snag. Say yes when you mean to be held to it.
        </p>
        <div class="sheetrow" style="justify-content:flex-end;gap:10px">
          <button class="btn sec" id="stNo" style="padding:7px 16px">Leave it alone</button>
          <button class="btn" id="stYes" style="background:#f97316;border-color:#ea580c;color:#fff;font-weight:600;padding:7px 18px">Yes, tighten it</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    const yes = back.querySelector("#stYes"), no = back.querySelector("#stNo");
    function close(v) {
      document.removeEventListener("keydown", onKey, true);
      back.remove();
      resolve(v);
    }
    function onKey(e) {
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(false); }
      else if (e.key === "Enter" && document.activeElement === yes) { e.stopPropagation(); e.preventDefault(); close(true); }
    }
    document.addEventListener("keydown", onKey, true);
    back.addEventListener("click", e => { if (e.target === back) close(false); });
    no.addEventListener("click", () => close(false));
    yes.addEventListener("click", () => close(true));
    setTimeout(() => no.focus(), 30);
  });
}

// The gated write, and the one place that decides whether the password is needed.
//
// It used to be needed for every write. That is one rule and easy to trust, but it is friction
// pointed at the wrong direction: switching a check ON, raising today's goal, blocking another site
// — those are the things the password exists to protect, and asking you to prove who you are before
// you make your own rules harder taught you to leave the page unlocked.
//
// So the question is not "are you editing" any more, it is "are you letting yourself off". Answered
// by FGSettings.loosens against what is actually stored, which is the same table strict mode uses —
// one place that knows which way is stricter for every key, rather than a judgement at each of the
// thirty call sites that reach this function.
//
// Making things stricter while locked prompts a FocusGate-style confirmation dialog ("Make this stricter?"),
// warning that undoing it will require password.
// `opts.confirmTighten` forces the "Make this stricter?" dialogue for a patch that would
// otherwise pass in silence. See the note on the condition below for when that is the right thing
// to ask for.
async function setStateP(p, opts) {
  const patch = p || {};
  const before = await getState();
  if (FGSettings.loosens(patch, before) && !(await requireUnlock())) {
    toast("Password needed to ease a rule off 🔒");
    // The control that was just moved is showing a value nothing saved, so put the page back
    // to what is actually stored rather than leaving the two disagreeing.
    renderRoot().catch(() => {});
    throw new EditLocked();
  }
  // Tightening asks for a confirmation in two cases.
  //
  // The first is the original one: settings are LOCKED, so undoing this will cost a password. That
  // is worth saying before the fact rather than after, and it is the whole reason the dialogue
  // exists — it is a warning about the way back, not about the change.
  //
  // The second is a caller that asks for it outright, and it exists because the first case is
  // silent for anybody with no password set. Then `editLocked` is false forever, and a switch whose
  // consequences reach outside this browser goes on with no acknowledgement at all — which is
  // exactly what happened to phone app blocking. A caller that knows its switch is that kind of
  // switch says so; nothing else changes, so no existing control gains a dialogue it did not have.
  if ((editLocked || (opts && opts.confirmTighten === true)) && FGSettings.tightens(patch, before)) {
    const label = FGSettings.tightenedLabel(patch, before);
    const ok = await confirmTighten(label);
    if (!ok) {
      renderRoot().catch(() => {});
      throw new EditLocked();
    }
  }
  return await setStateRaw(patch);
}
// Say something to the worker and don't wait for an answer.
//
// The callback is NOT optional even when the reply is unwanted, and that is the trap this exists to
// close. `chrome.runtime.sendMessage(msg)` with no callback returns a PROMISE — so a worker that is
// asleep, restarting, or gone rejects it, and nobody is holding the promise: an unhandled rejection
// in the console for a message nothing was waiting on. Passing a callback that reads lastError is how
// you tell Chrome "I know this can fail and there is nothing to do about it".
//
// The try/catch is the other half. sendMessage itself throws synchronously once the extension context
// is invalidated, which is exactly what reloading the extension does to a settings page somebody left
// open — and that page then throws on its next save rather than simply not being heard.
function tellWorker(msg) {
  try { chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError); } catch (e) {}
}
// `opts` is optional and only two callers use it: `cls` adds a class ("wide" for a sentence rather
// than a result, "phone" for the amber edge the phone reminders wear) and `ms` holds it up for longer
// than the default 2.5s — a sentence you are meant to read needs more time than a tick you glance at.
function toast(msg, opts) {
  const o = opts || {};
  const t = document.createElement("div");
  t.className = "toast" + (o.cls ? " " + o.cls : "");
  t.setAttribute("role", "status");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), Math.max(1200, Number(o.ms) || 2500));
}
function escHtml(v) {
  return String(v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---- handing a file to the browser ---------------------------------------
// Two buttons save a file now — the Anki add-on and the settings backup — so the
// five-line anchor dance lives here once.
//
// A plain <a download>, deliberately, and not chrome.downloads. An anchor in an
// extension page needs no permission at all, which keeps the manifest down to
// storage/tabs/alarms; "download a file and then ask the OS to open it" is exactly the
// shape a Chrome Web Store reviewer stops on. The cost is that the file lands in
// Downloads and the user opens it themselves, which the toast spells out.
//
// Blob URLs pin their blob in memory for the life of the page, and Chrome needs the URL
// until the download has actually been read — hence a delayed revoke rather than an
// immediate one. Not revoking at all leaked another copy on every press.
function releaseSoon(url) {
  setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 60000);
}
function saveBlob(blob, filename) {
  let url = "";
  try {
    url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
  } catch (e) {
    if (url) releaseSoon(url);
    return false;
  }
  releaseSoon(url);
  return true;
}

// ---- Hard confirm ---------------------------------------------------------
// Wiping today's progress is one stray click away from ruining a day's work, so
// it gets a real speed bump: type the words, and the button stays dead for a few
// seconds either way. Escape or a click outside walks away.
const RESET_PHRASE = "yes i want to reset";
// `phrase: ""` turns the typing off and leaves a plain warning: a title, what will happen, and two
// buttons. Both kinds are needed and they are not interchangeable. Typing words is for wiping
// something you cannot get back. A warning is for a switch whose consequences you should read
// before you flip it — and asking someone to type a sentence to switch a self-discipline feature ON
// is friction pointed at the thing they are trying to do.
//
// `keep` labels the way out, because "Keep it" is the right word for a reset and the wrong one for
// anything else.
//
// `taps: n` is the third kind, and it replaces the typing wherever it is used. Press the confirm
// button n times and it goes; the count is on the button, so what is being asked is visible from the
// button itself rather than from a label above a text field.
//
// It exists because typing a sentence is the wrong shape of friction for switching something ON.
// Typed words are for destruction — you are about to lose today's work, so spell out that you mean
// it. Strict mode is the opposite: it is the thing you are trying to do, and a sentence in the way
// of it teaches you to dread your own commitment. Repeated presses are still deliberate — nothing
// reaches five by accident, and each press shows one fewer to go — without asking you to prove
// sincerity in writing.
//
// A countdown alongside taps would be two speed bumps for one decision, so the caller that uses
// taps passes wait: 0. The taps are the wait.
function confirmReset({ title, body, phrase = RESET_PHRASE, wait = 5, go = "Reset", keep = "Keep it", taps = 0 }) {
  return new Promise(resolve => {
    const tapsWanted = Math.max(0, taps | 0);
    // Taps win over a phrase. Both would mean typing a sentence AND pressing five times, which is
    // not a stricter dialogue, it is an unusable one.
    const asks = !!phrase && !tapsWanted;
    const back = document.createElement("div");
    back.className = "sheetback";
    back.innerHTML = `
      <div class="sheet" role="alertdialog" aria-modal="true" aria-labelledby="cfTitle" aria-describedby="cfBody">
        <div class="sheettop"><span class="sheetic" aria-hidden="true">⚠️</span>
          <h3 id="cfTitle">${escHtml(title)}</h3></div>
        <p id="cfBody">${escHtml(body)}</p>
        ${asks ? `<label class="sheetlbl" for="cfType">Type <b>${escHtml(phrase)}</b> below to allow it</label>
        <input class="input" id="cfType" autocomplete="off" spellcheck="false" placeholder="${escHtml(phrase)}"/>` : ""}
        <div class="sheetrow">
          <span class="sheethint" id="cfHint" role="status"></span>
          <button class="btn sec" id="cfNo">${escHtml(keep)}</button>
          <button class="btn danger" id="cfYes" disabled>${escHtml(go)}</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    const yes = back.querySelector("#cfYes"), no = back.querySelector("#cfNo");
    const box = back.querySelector("#cfType"), hint = back.querySelector("#cfHint");
    // With no phrase to type there is nothing left to satisfy, so this starts already satisfied and
    // only the countdown (if there is one) holds the button.
    let left = Math.max(0, wait | 0), typed = !asks, timer = 0;
    let tapsLeft = tapsWanted;
    function paint() {
      yes.disabled = left > 0 || !typed;
      hint.textContent =
        left > 0 ? `Wait ${left}s…`
        : tapsWanted ? `Press it ${tapsLeft} more time${tapsLeft === 1 ? "" : "s"}`
        : (typed ? "" : "Type the words to switch this on");
      yes.textContent =
        left > 0 ? `${go} (${left})`
        // "×5", not "(5)", which is the shape the countdown uses — two different meanings wearing the
        // same brackets on the same button would be read as the same thing.
        : tapsWanted ? `${go} ×${tapsLeft}`
        : go;
    }
    paint();
    if (left > 0) {
      timer = setInterval(() => {
        left--;
        if (left <= 0) { left = 0; clearInterval(timer); timer = 0; }
        paint();
      }, 1000);
    }
    if (box) {
      box.addEventListener("input", () => {
        typed = box.value.trim().replace(/\s+/g, " ").toLowerCase() === phrase;
        paint();
      });
    }
    function close(v) {
      if (timer) clearInterval(timer);
      document.removeEventListener("keydown", onKey, true);
      back.remove();
      resolve(v);
    }
    function onKey(e) {
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(false); }
      // Enter agrees only where agreeing was already deliberate: you typed the phrase. On a plain
      // warning it is swallowed, because Enter is what people press to make a dialog go away and
      // this sheet's whole job is to be read. Escape and Cancel are the quick ways out; there is no
      // quick way in.
      else if (e.key === "Enter" && asks && !yes.disabled) { e.stopPropagation(); e.preventDefault(); close(true); }
      // In taps mode Enter counts as one press, but only with the confirm button actually focused —
      // which you can only be by having tabbed onto it. Without this the dialogue had no keyboard
      // path at all: the branch below swallows Enter, which also swallows the browser's own "Enter
      // presses the focused button". One press per keystroke, never five.
      else if (e.key === "Enter" && tapsWanted && document.activeElement === yes && !yes.disabled) {
        e.stopPropagation(); e.preventDefault(); yes.click();
      }
      else if (e.key === "Enter") { e.stopPropagation(); e.preventDefault(); }
    }
    document.addEventListener("keydown", onKey, true);
    back.addEventListener("click", e => { if (e.target === back) close(false); });
    no.addEventListener("click", () => close(false));
    yes.addEventListener("click", () => {
      if (yes.disabled) return;
      // Every press but the last one only counts down. Repainting rather than closing is the whole
      // mechanism, and the label going 5 → 4 → 3 is what tells you the press registered.
      if (tapsWanted && --tapsLeft > 0) { paint(); return; }
      close(true);
    });
    // The box when there is one, otherwise the way OUT. Focus lands on Cancel rather than Confirm on
    // purpose: a warning that arms Enter on its own confirm button is a warning you can dismiss into
    // agreeing with, which is the opposite of the job.
    setTimeout(() => (box || no).focus(), 30);
  });
}

// ---- Info bubble ----------------------------------------------------------
// All the wordy explanations live inside these, so the page itself stays a short
// list of switches. Tap-to-open and Escape-to-close live in tip.js.
function tip(html, cls) {
  return `<span class="tip ${cls || ""}" tabindex="0" role="button" aria-label="More information">
    <span class="tip-i" aria-hidden="true">?</span>
    <span class="tip-box" role="tooltip">${html}</span>
  </span>`;
}

// Pressing Enter in a field should do the obvious thing — the same as clicking the
// button next to it. One delegated listener, so it survives every re-render.
const ENTER_TARGET = {
  newBlocked: "addBlocked", newAllowed: "addAllowed",
  ankiDeckInput: "ankiDeckAdd",
  ankiDueDeckInput: "ankiDueDeckAdd",
  ankiDtInput: "ankiDtAdd", ankiDtH: "ankiDtAdd", ankiDtM: "ankiDtAdd", ankiDtS: "ankiDtAdd",
  // strictStart / strictEnd are not here any more: they had no Save button to aim Enter at, and they
  // store themselves on `change` — which is exactly what pressing Enter in a time input fires.
  resetTime: "saveTime",
  pw: "go", pw2: "go",
  oldPw: "changePw", newPw: "changePw",
  disablePw: "disableProt", newProtPw: "enableProt"
};
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing || e.shiftKey) return;
  const el = e.target;
  if (!el || !el.id) return;
  const btn = document.getElementById(ENTER_TARGET[el.id] || "");
  if (!btn || btn.disabled) return;
  e.preventDefault();
  btn.click();
});

// Numbers are written back in their plainest form: an empty box means the smallest
// value it allows, and a leading zero goes ("01" means 1 and only takes up room).
// Decimals are left exactly as typed — "0.5" is not "5".
function tidyNumberValue(v, min) {
  const s = String(v == null ? "" : v).trim();
  if (s === "") return String(Number.isFinite(min) ? min : 0);
  if (!/^\d+$/.test(s)) return s;
  return String(parseInt(s, 10));
}
function tidyNumberInput(el) {
  if (!el || el.tagName !== "INPUT" || el.type !== "number") return false;
  const next = tidyNumberValue(el.value, parseFloat(el.getAttribute("min")));
  if (next === String(el.value)) return false;
  el.value = next;
  return true;
}
// Capture, because each box's own handlers are what actually save: tidying the
// value and then re-firing input/change lets them do their normal job.
document.addEventListener("focusout", (e) => {
  if (!tidyNumberInput(e.target)) return;
  e.target.dispatchEvent(new Event("input", { bubbles: true }));
  e.target.dispatchEvent(new Event("change", { bubbles: true }));
}, true);

// ---- time helpers --------------------------------------------------------
function splitHMS(sec) {
  sec = Math.max(0, sec | 0);
  return { h: Math.floor(sec / 3600), m: Math.floor((sec % 3600) / 60), s: sec % 60 };
}
function fmtDur(sec) {
  sec = Math.max(0, sec | 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + "h " : "") + (m || h ? m + "m " : "") + s + "s";
}
// Write a duration back into its three boxes the way we'd have rendered it: no
// leading zeros, and anything that overflowed carried up, so 90 typed into minutes
// settles as 1h 30m. Boxes that already agree are left alone, so the caret never
// jumps while you're still in one.
function writeHMS(sec, hEl, mEl, sEl) {
  const t = splitHMS(Math.max(0, sec | 0));
  const put = (el, v) => { if (el && String(el.value) !== String(v)) el.value = String(v); };
  put(hEl, t.h); put(mEl, t.m); put(sEl, t.s);
}

// Run something once focus has genuinely LEFT `root` — the "I have finished editing this
// control" event that the DOM does not otherwise provide.
//
// `focusout` is the only event that can answer it, because it is the only one carrying
// `relatedTarget`: the element about to take focus. Null, or anything outside `root`, means the
// edit is over; anything inside means it is still going on. That distinction is the whole point
// here. The goal time is THREE boxes holding ONE number, so moving from hours to minutes must not
// count as finishing — and `change` and `blur` both think it does.
//
// Deferred by a task, for two separate reasons:
//
//   `focusout` fires BEFORE focus lands, so a click travelling from one box of a control to
//   another is still in flight and relatedTarget is not the whole answer. The second check,
//   against activeElement once the dust has settled, is what closes that gap.
//
//   Committing redraws parts of the card. Doing that synchronously inside focusout would pull
//   the DOM out from under the very click that caused it.
//
// A single input works as its own root: nothing is inside it, so any focusout is a real one.
function commitWhenLeft(root, run) {
  if (!root) return;
  root.addEventListener("focusout", (e) => {
    const to = e.relatedTarget;
    if (to && root.contains(to)) return;          // still inside: the edit continues
    setTimeout(() => {
      if (root.contains(document.activeElement)) return;   // focus came back before we ran
      run();
    }, 0);
  });
}

// ---- the round clock -----------------------------------------------------
//
// A dial you drag, for the times when typing two numbers is not what you want. Resolves to "HH:MM",
// or null if it was dismissed without a choice.
//
// It speaks the SAME string the control it serves does. `<input type="time">` holds "HH:MM" in 24-hour
// and so does storage, so the dial takes one and returns one and there is no third format anywhere in
// the middle. Twelve hours on the ring with am/pm beside the readout is a presentation decision made
// inside this function and it never leaves it.
//
// Geometry lives in one place and the SVG is drawn from it, so moving a radius moves the numbers, the
// hand and the hit test together. Three separate answers to "where is 7 o'clock" is three chances for
// them to disagree.
const DIAL = { size: 240, c: 120, rOut: 96, numR: 15 };
function dialPos(i, steps, r) {
  const a = (i / steps) * Math.PI * 2 - Math.PI / 2;      // 0 at the top, going clockwise
  return { x: DIAL.c + Math.cos(a) * r, y: DIAL.c + Math.sin(a) * r };
}
// Through FGGates.hhmm, so "what is a valid time" is answered in the one place the rest of the page
// already asks. The clamps after it are belt and braces: this value can arrive from storage a hand
// has been in, and an hour of 99 would put the hand somewhere off the face.
function dialParse(v) {
  const s = FGGates.hhmm(v, "00:00");
  return {
    h: Math.max(0, Math.min(23, parseInt(s.slice(0, 2), 10) || 0)),
    m: Math.max(0, Math.min(59, parseInt(s.slice(3, 5), 10) || 0))
  };
}
const dialPad = (n) => String(Math.max(0, n | 0)).padStart(2, "0");

// ---- nudging a time box by one step ----------------------------------------
//
// Five minutes, because that is the size of a decision about a study window. Nobody means 04:47, and
// a one-minute arrow would need sixty presses to cross an hour.
//
// It steps MINUTES rather than "whichever half the cursor is in", and that is forced rather than
// chosen: this is a native `<input type="time">`, whose segments live in the shadow DOM, so which one
// the caret is in is not a question the page can ask. The keyboard already has the better answer —
// the arrow KEYS step whichever segment is focused, natively — so these buttons are for the mouse,
// and the dial beside them is for going somewhere far away.
const WIN_STEP_MIN = 5;
function stepTimeBox(el, dir, fallback) {
  const t = dialParse(FGGates.hhmm(el && el.value, fallback));
  const cur = t.h * 60 + t.m;
  // Snapped to the grid rather than added to blindly. A box holding 04:47 stepped up should land on
  // 04:50 — the mark you would have picked — and not on 04:52, which would leave every step after it
  // off the grid for as long as the box lived.
  const marks = dir > 0 ? Math.floor(cur / WIN_STEP_MIN) + 1 : Math.ceil(cur / WIN_STEP_MIN) - 1;
  // Wrapped, both ways. A window is allowed to cross midnight — see winStateRow, which says so in
  // words — so 23:59 stepping up to 00:00 is a real answer and not an overflow to clamp away.
  const next = ((marks * WIN_STEP_MIN) % 1440 + 1440) % 1440;
  el.value = dialPad(Math.floor(next / 60)) + ":" + dialPad(next % 60);
  return el.value;
}

function openTimeDial({ title, value }) {
  return new Promise(resolve => {
    const start = dialParse(value);
    // 12-hour on the face, 24-hour on the way in and out. `% 12 || 12` is what keeps midnight and
    // noon readable: hour 0 and hour 12 both sit at the top of the ring and both show as "12", and
    // the am/pm beside them is the only thing that tells them apart — which is how a clock works.
    let h12 = start.h % 12 || 12;
    let ap = start.h < 12 ? "am" : "pm";
    let m = start.m;
    let mode = "h";                                       // which half of the readout the face edits
    const out = () => dialPad((h12 % 12) + (ap === "pm" ? 12 : 0)) + ":" + dialPad(m);

    const back = document.createElement("div");
    back.className = "sheetback";
    back.innerHTML = `
      <div class="dialbox" role="dialog" aria-modal="true" aria-label="${escHtml(title)}">
        <div class="dialhead">
          <span class="dialttl">${escHtml(title)}</span>
          <div class="dialread">
            <button class="dialseg" type="button" data-dseg="h" aria-label="Set the hour">00</button>
            <b>:</b>
            <button class="dialseg" type="button" data-dseg="m" aria-label="Set the minute">00</button>
            <span class="dialap">
              <button class="dialapb" type="button" data-dap="am" aria-label="Morning">am</button>
              <button class="dialapb" type="button" data-dap="pm" aria-label="Afternoon or evening">pm</button>
            </span>
          </div>
        </div>
        <svg class="dialface" viewBox="0 0 ${DIAL.size} ${DIAL.size}" role="application"
             aria-label="Clock face — drag the hand, or tap a number">
          <circle class="dialbg" cx="${DIAL.c}" cy="${DIAL.c}" r="${DIAL.c - 4}"/>
          <line class="dialhand" x1="${DIAL.c}" y1="${DIAL.c}" x2="${DIAL.c}" y2="${DIAL.c - DIAL.rOut}"/>
          <circle class="dialknob" cx="${DIAL.c}" cy="${DIAL.c - DIAL.rOut}" r="${DIAL.numR}"/>
          <circle class="dialhub" cx="${DIAL.c}" cy="${DIAL.c}" r="3.5"/>
          <g class="dialnums"></g>
        </svg>
        <div class="dialfoot">
          <span class="dialhint">Drag the hand, or tap a number.</span>
          <button class="btn sec" type="button" data-dial="no">Cancel</button>
          <button class="btn" type="button" data-dial="ok">Set</button>
        </div>
      </div>`;
    document.body.appendChild(back);

    const svg = back.querySelector(".dialface");
    const nums = back.querySelector(".dialnums");
    const hand = back.querySelector(".dialhand");
    const knob = back.querySelector(".dialknob");
    const segH = back.querySelector('[data-dseg="h"]');
    const segM = back.querySelector('[data-dseg="m"]');
    const apBtns = Array.from(back.querySelectorAll("[data-dap]"));

    function paint() {
      segH.textContent = dialPad(h12);
      segM.textContent = dialPad(m);
      segH.classList.toggle("on", mode === "h");
      segM.classList.toggle("on", mode === "m");
      apBtns.forEach(b => b.classList.toggle("on", b.getAttribute("data-dap") === ap));
      // `h12 % 12` because 12 o'clock sits at index 0, the top of the ring. It is the one hour whose
      // label and its position do not share a number.
      const p = mode === "m" ? dialPos(m, 60, DIAL.rOut) : dialPos(h12 % 12, 12, DIAL.rOut);
      hand.setAttribute("x2", p.x.toFixed(2));
      hand.setAttribute("y2", p.y.toFixed(2));
      knob.setAttribute("cx", p.x.toFixed(2));
      knob.setAttribute("cy", p.y.toFixed(2));
      // Minutes are labelled every five but land on any single one, so dragging to 07 has to show
      // something — and a full-size disc sitting over blank space reads as a mistake, so it shrinks
      // to a dot. Written as an attribute rather than through a class: `r` as a CSS property is SVG2,
      // well supported here but not universally, and the attribute is what every version honours.
      knob.setAttribute("r", String(mode === "m" && m % 5 !== 0 ? 5 : DIAL.numR));
      const put = (label, pos, sel) =>
        `<text class="dialnum${sel ? " sel" : ""}" x="${pos.x.toFixed(2)}" y="${pos.y.toFixed(2)}"
               text-anchor="middle" dominant-baseline="central">${label}</text>`;
      let html = "";
      if (mode === "h") {
        for (let i = 0; i < 12; i++) {
          const label = i === 0 ? 12 : i;
          html += put(String(label), dialPos(i, 12, DIAL.rOut), h12 === label);
        }
      } else {
        for (let i = 0; i < 60; i += 5) html += put(dialPad(i), dialPos(i, 60, DIAL.rOut), m === i);
      }
      nums.innerHTML = html;
    }

    // Where the pointer is, in the FACE's own coordinates, so the arithmetic does not care what size
    // the SVG ended up on screen.
    function at(ev) {
      const r = svg.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      const x = ((ev.clientX - r.left) / r.width) * DIAL.size - DIAL.c;
      const y = ((ev.clientY - r.top) / r.height) * DIAL.size - DIAL.c;
      let ang = (Math.atan2(y, x) * 180) / Math.PI + 90;
      if (ang < 0) ang += 360;
      return { ang, dist: Math.hypot(x, y) };
    }
    // Distance is deliberately ignored: anywhere on the face sets the angle. Requiring the pointer to
    // be near the ring would mean a drag that cuts across the middle silently stops following you.
    function grab(ev) {
      const q = at(ev);
      if (!q) return;
      if (mode === "h") {
        const i = Math.round(q.ang / 30) % 12;
        h12 = i === 0 ? 12 : i;                           // the top of the ring is 12, not 0
      } else {
        m = Math.round(q.ang / 6) % 60;
      }
      paint();
    }

    let down = false;
    svg.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      down = true;
      try { svg.setPointerCapture(e.pointerId); } catch {}
      grab(e);
    });
    svg.addEventListener("pointermove", (e) => { if (down) grab(e); });
    svg.addEventListener("pointerup", (e) => {
      if (!down) return;
      down = false;
      try { svg.releasePointerCapture(e.pointerId); } catch {}
      // Letting go of an hour moves you on to the minutes by itself, which is most of why a dial is
      // quicker than two boxes. Safe to do automatically here in a way it would not be in the field
      // itself: this writes nothing until Set, and tapping the hour again undoes the step.
      if (mode === "h") { mode = "m"; paint(); }
    });
    svg.addEventListener("pointercancel", () => { down = false; });

    segH.addEventListener("click", () => { mode = "h"; paint(); });
    segM.addEventListener("click", () => { mode = "m"; paint(); });
    apBtns.forEach(b => b.addEventListener("click", () => { ap = b.getAttribute("data-dap"); paint(); }));

    function close(v) {
      document.removeEventListener("keydown", onKey, true);
      back.remove();
      resolve(v);
    }
    function onKey(e) {
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); return close(null); }
      if (e.key === "Enter") { e.stopPropagation(); e.preventDefault(); return close(out()); }
      // Usable without a mouse. Up and down move whichever segment is live, left and right swap which
      // one that is — a dial you can only drag is a dial half the people here cannot use.
      const step = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;
      if (step) {
        e.stopPropagation(); e.preventDefault();
        if (mode === "h") {
          // Stepped on the 24-HOUR value, so 11 am carries up into 12 pm. Stepping the 1–12 number
          // instead would wrap 11 round to 12 and leave am/pm where it was, putting half the day out
          // of reach of the keyboard.
          const next = ((h12 % 12) + (ap === "pm" ? 12 : 0) + step + 24) % 24;
          h12 = next % 12 || 12;
          ap = next < 12 ? "am" : "pm";
        } else {
          m = (m + step + 60) % 60;
        }
        return paint();
      }
      // "a" and "p" for the two halves of the day, since the face itself has no other way to say it.
      if (/^[apAP]$/.test(e.key)) {
        e.stopPropagation(); e.preventDefault();
        ap = (e.key === "a" || e.key === "A") ? "am" : "pm";
        return paint();
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.stopPropagation(); e.preventDefault();
        mode = mode === "h" ? "m" : "h";
        return paint();
      }
    }
    document.addEventListener("keydown", onKey, true);
    // Only the backdrop itself — a click that started inside the box and happened to end here must
    // not count as dismissing it.
    back.addEventListener("click", (e) => { if (e.target === back) close(null); });
    back.querySelector('[data-dial="no"]').addEventListener("click", () => close(null));
    back.querySelector('[data-dial="ok"]').addEventListener("click", () => close(out()));

    paint();
    setTimeout(() => back.querySelector('[data-dial="ok"]').focus(), 30);
  });
}
// One hours : minutes : seconds control. `attrs(unit)` supplies whatever
// identifies each box, so callers keep their own handlers.
// Deliberately never disabled. Strict mode is allowed to be raised, so the boxes
// stay usable and commitAnki() is what refuses a value lower than the stored one.
function hmsWells(sec, attrs, o = {}) {
  const t = splitHMS(sec || 0);
  const cell = (unit, val, max, name) =>
    `<label class="tfld"><input class="input" type="number" min="0" max="${max}" value="${val}" title="${name}" aria-label="${name}" ${attrs(unit)}/><i>${unit}</i></label>`;
  return `<span class="timeset${o.plain ? " plain" : ""}"${o.id ? ` id="${o.id}"` : ""}>
      ${o.icon === false ? "" : `<span class="gicon" aria-hidden="true">⏳</span>`}
      ${cell("h", t.h, 99, "hours")}${cell("m", t.m, 59, "minutes")}${cell("s", t.s, 59, "seconds")}
    </span>`;
}

// The handle on every foldable heading: a drawn chevron in a round blue chip. CSS
// rotates it 90° when the section is open.
const CARET = `<span class="car" aria-hidden="true"><svg viewBox="0 0 24 24" width="11" height="11" focusable="false"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;

// ---------------------------------------------------------------------------
// Two marks, and the difference matters.
//
// BRAND_MARK is the extension's own logo: Anki's blue star locked inside a
// padlock. "Anki" plus "gate", which is the whole idea in one glyph. It is the
// same drawing as the toolbar icons — both come out of tools/make-icons.mjs, so
// they can't drift — and it belongs at the top of the page.
//
// ANKI_MARK is Anki's OWN mark, the grey card with the stars. It stays on the
// on/off tile in step 1, because that tile means "Anki counts as work". Putting
// the extension's logo there would say the wrong thing.
//
// Both are inline SVG: no image file to load, sharp at any size, and they follow
// the surrounding font size.
// ---------------------------------------------------------------------------
// The gradient ids are prefixed "bg" because ANKI_MARK below uses "ag" and both
// marks are on this page at the same time — duplicate ids in one document mean
// whichever came first wins and one of the two marks renders in the wrong colours.
const BRAND_MARK = `<svg class="amark" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="bgCard" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#929292"/><stop offset="1" stop-color="#666666"/>
    </linearGradient>
    <linearGradient id="bgGloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#a4a4a4"/><stop offset="1" stop-color="#8c8c8c"/>
    </linearGradient>
    <linearGradient id="bgStar" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0b84f3"/><stop offset="1" stop-color="#c9e8ff"/>
    </linearGradient>
    <linearGradient id="bgBadge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#e04a43"/><stop offset="1" stop-color="#a82b25"/>
    </linearGradient>
    <clipPath id="bgClip">
      <rect x="4.32" y="1.12" width="23.68" height="28.48" rx="3.68"/>
    </clipPath>
  </defs>
  <rect x="4.32" y="1.12" width="23.68" height="28.48" rx="3.68" fill="url(#bgCard)"/>
  <path d="M4.32 10.23 Q19 10.23 28 19.06 L28 1.12 L4.32 1.12 Z" fill="url(#bgGloss)" clip-path="url(#bgClip)"/>
  <path fill="url(#bgStar)" stroke="#ffffff" stroke-width="1.76" stroke-linejoin="round" paint-order="stroke" d="M13.13 13.8 L15.52 18.23 L20.55 18.09 L17.08 21.73 L18.77 26.48 L14.23 24.3 L10.24 27.37 L10.91 22.38 L6.75 19.54 L11.7 18.63 Z"/>
  <path fill="url(#bgStar)" stroke="#ffffff" stroke-width="1.47" stroke-linejoin="round" paint-order="stroke" d="M22.21 4.85 L22.62 7.55 L25.21 8.43 L22.77 9.65 L22.73 12.38 L20.81 10.44 L18.21 11.25 L19.46 8.83 L17.88 6.6 L20.58 7.04 Z"/>
  <circle cx="26.5" cy="26.62" r="4.96" fill="#ffffff"/>
  <circle cx="26.5" cy="26.62" r="4" fill="url(#bgBadge)"/>
  <path fill="#ffffff" d="M25.06 26.27 V25.98 A1.44 1.44 0 0 1 27.94 25.98 V26.27 H27.18 V25.98 A0.68 0.68 0 0 0 25.82 25.98 V26.27 Z"/>
  <rect x="24.3" y="26.14" width="4.4" height="2.8" rx="0.72" fill="#ffffff"/>
</svg>`;

const ANKI_MARK = `<svg class="amark" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="agCard" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#8d8d8d"/><stop offset="1" stop-color="#6a6a6a"/>
    </linearGradient>
    <linearGradient id="agStar" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0b84f3"/><stop offset="1" stop-color="#c9e8ff"/>
    </linearGradient>
  </defs>
  <path fill="url(#agCard)" d="M7.2 1.5h9.6A3.2 3.2 0 0 1 20 4.7v14.6a3.2 3.2 0 0 1-3.2 3.2H7.2A3.2 3.2 0 0 1 4 19.3V4.7a3.2 3.2 0 0 1 3.2-3.2Z"/>
  <path fill="#9d9d9d" d="M4 8.2c5.2 1.5 11 3.5 16 5.4V4.7A3.2 3.2 0 0 0 16.8 1.5H7.2A3.2 3.2 0 0 0 4 4.7Z"/>
  <path fill="url(#agStar)" stroke="#fff" stroke-width="1.5" stroke-linejoin="round" paint-order="stroke"
        d="M11 9.1 12.88 12.71 16.9 13.38 14.04 16.29 14.64 20.32 11 18.5 7.36 20.32 7.96 16.29 5.1 13.38 9.12 12.71Z"/>
  <path fill="url(#agStar)" stroke="#fff" stroke-width="1.2" stroke-linejoin="round" paint-order="stroke"
        d="M15.9 3 16.93 4.98 19.13 5.35 17.56 6.94 17.9 9.15 15.9 8.15 13.9 9.15 14.24 6.94 12.67 5.35 14.87 4.98Z"/>
</svg>`;

// A toggle switch. `label` is required for a reason: the visible wording sits in a
// separate sibling span, and the switch itself is two empty decorative spans — so
// without an aria-label a screen reader announced every anti-cheat setting in this
// page as a bare, unidentifiable "checkbox". Eleven of them, in a row.
// `disabled` means "strict mode has hold of this", and for a SWITCH that is narrower than it reads.
// Strict mode refuses the loosening direction, and for a switch the loosening direction is off — so
// a switch that is currently off has nothing strict mode could object to. Turning a check on
// mid-session only ever asks more of you.
//
// This was `disabled` outright, which froze the whole set in both directions. That was defended as
// "one rule instead of ten", and it was one rule that refused you the direction strict mode exists
// to encourage: you could not turn a check on, tighten a dial or raise a quota until the window
// ended. The handlers judge every change by direction now (see FGSettings.loosensKey), so the only
// thing left for this to do is stop you reaching for a move that would be refused anyway.
//
// Done here rather than at the twenty-odd call sites, because "&& on" repeated twenty times is
// twenty chances to leave one out, and a switch that is wrongly still frozen is invisible until
// someone tries it mid-window. Every caller passes strict mode's own flag, so every caller means
// this. The one that passes `deadline` instead means it too: a running deadline holds its own switch
// on, and on is exactly the state this leaves frozen.
function sw(id, on, disabled, label) {
  disabled = !!disabled && !!on;
  const name = label ? ` aria-label="${escHtml(label)}"` : "";
  return `<label class="sw"><input type="checkbox" id="${id}"${name} ${on ? "checked" : ""} ${disabled ? "disabled" : ""}/><span class="track"></span></label>`;
}

// ---- addresses -----------------------------------------------------------
// What a typed address is stored as. The rule itself lives in settings.js now, shared with the worker —
// the right-click menu adds to the same two lists, and one site must never be stored under two names.
// See normSite there.
function normSite(v) { return FGSettings.normSite(v); }
// The chip is clickable, so a pattern has to become an address you can actually open.
// The "*." prefix is a matching instruction, not part of any host name: "https://*.google.com" is not
// a URL a browser will load, and left in it turned the chip into a dead link. Dropping it opens the
// site the rule is named after, which is the one page a user clicking "*.google.com" would expect.
function siteOpenUrl(url) {
  const u = String(url || "").trim().replace(/^\*\./, "");
  if (!u) return "";
  return /^https?:\/\//i.test(u) ? u : "https://" + u;
}
// One box, many sites. Split on commas — and on newlines, semicolons and stray
// double spaces too, because that's what a pasted list actually looks like.
function splitSites(v) {
  const seen = new Set();
  return String(v || "")
    .split(/[,;\n\r\t]+|\s{2,}/)
    .map(x => x.trim())
    .filter(Boolean)
    .filter(x => {
      const k = x.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}
function nSites(n) { return n + (n === 1 ? " site" : " sites"); }
function addedToast(added, dupes) {
  if (!added) return dupes ? (dupes === 1 ? "Already there" : "All " + nSites(dupes) + " were already there") : "Nothing to add";
  const head = added === 1 ? "Added" : "Added " + nSites(added);
  return dupes ? head + " · " + nSites(dupes) + " already there" : head;
}

// ---- Anki state questions ------------------------------------------------
// Has the goal been reached today? Every condition that is switched on, decided in
// gates.js — see the note at the top of that file for why this page must not work it
// out for itself.
//
// Only a day with something IN it can be done. With the goal at 0s and no other gate switched on,
// gates.js answers "met" in the empty sense — which is right for the blocking, and wrong for this
// page: it painted a fresh install as a full green bar, "0s goal completed" and "🎉 All done.
// Enjoy!". Every caller here is about what to SHOW, so a day with nothing to do reads as "no goal
// yet" instead. See hasGoal in gates.js.
function ankiGoalMet(s) {
  return FGGates.met(s) && FGGates.hasGoal(s);
}
// Is Anki connected *right now*? `ankiConnected` is only ever as fresh as the last
// poll, and nothing polls while the gate is switched off — which is how a dot could
// stay green next to an Anki that had been closed for hours. Anything older than
// 25 seconds counts as "don't know", which shows as not connected.
function ankiLinkedNow(s) {
  if (!s || s.ankiEnabled === false || !s.ankiConnected) return false;
  return (Date.now() - (s.ankiLastPollAt || 0)) < 25000;
}
// How much time today's goal asks for, and how much is left.
// A finite number or the fallback — never NaN, never Infinity, never a string.
//
// Storage is meant to hold numbers here and the worker now heals anything that
// isn't, but this page reads storage directly and paints the result, so it does
// its own coercion. Without it a single bad value printed "NaN% done" on the page
// and "NaN" in the popup's big number: `Math.min(1800, "abc")` is NaN, and NaN
// propagates through every calculation after it in silence.
function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Everything "start today over" puts back to zero.
//
// One list, in one place, because two buttons do this — the ↺ on the Anki card and
// "Reset the day" in Setup — and they were two copies of the same object literal.
// The per-deck clocks are today's progress as much as the main one is, and a copy
// that forgot them would leave every deck quota satisfied while the main bar sat at
// zero, which reads as "it didn't reset".
//
// Due, retention and the unique-card count are deliberately NOT in here. Those are
// readings of your collection rather than tallies we keep, so writing 0 over them
// would last until the next poll three seconds later — and in the meantime a "no
// cards due" that nothing ever measured would count as a satisfied gate.
function todayResetPatch() {
  return {
    ankiSpentSec: 0, ankiReviewedToday: 0,
    ankiLastReviewAt: 0, ankiCreditedSinceAnswer: 0,
    allDoneCelebratedOn: "",
    // Today is unfinished again, so "I've seen the finished panel, take it away" no longer
    // applies to anything. The background clears this on its own once the goal stops being
    // met; doing it here as well means the camera window is back the moment you press this
    // rather than on the next poll.
    ankiCamDoneDismissedOn: "",
    // When today's goal was reached. A day being started over has not been finished, so it has no
    // finishing time — and leaving yesterday's, or this morning's, would have the deadline judged
    // against an instant that no longer describes anything. The background clears this itself once
    // the goal stops being met; doing it here too means the wind-back is honest the moment it lands
    // rather than on the next poll.
    //
    // ankiGraceFrom is deliberately NOT in here. Starting the day's progress over does not un-open
    // Anki, and a stopwatch that began when you first sat down is a fact about when you sat down. A
    // ↺ that handed back a fresh allowance would be the way round every time limit — press it at the
    // deadline and start again — which is the one thing this button must not be.
    ankiMetAt: 0,
    ankiDeckSpent: {}
  };
}

function todayTotals(s) {
  const req = Math.max(0, num(s.ankiRequiredSec));
  const on = s.ankiEnabled !== false;
  const spent = on ? Math.max(0, num(s.ankiSpentSec)) : 0;
  return { req, spent, left: Math.max(0, req - spent), count: on ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// Opening the Anki desktop app from a browser. Chrome cannot run a program, so
// there are two routes and the background picks between them:
//   • Anki running  → the add-on inside it raises its own window.
//   • Anki closed   → the add-on has registered a URL with Windows that starts
//     Anki, and an extension page is allowed to open that URL. Windows asks for
//     permission the first time; tick its "always allow" box and it stops asking.
// ---------------------------------------------------------------------------
// The one scheme this extension registers. Checked, not trusted: the value arrives as
// JSON from whatever is answering on port 8766, and handing an arbitrary scheme to an
// <a href> means asking the browser to invoke an arbitrary registered handler.
// The legacy spelling is accepted too: an add-on installed before the rename registered
// that scheme with Windows and reports it, and the add-on is updated by hand.
const ANKI_LAUNCH_SCHEMES = ["ankigate-anki", "focusgate-anki"];
function launchByScheme(scheme) {
  if (!ANKI_LAUNCH_SCHEMES.includes(scheme)) return false;
  try {
    const a = document.createElement("a");
    a.href = scheme + "://open";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { try { a.remove(); } catch {} }, 200);
    return true;
  } catch { return false; }
}
function openAnkiApp(say) {
  const tell = typeof say === "function" ? say : () => {};
  try {
    chrome.runtime.sendMessage({ type: "ankiOpen" }, (r) => {
      void chrome.runtime.lastError;
      if (r && r.ok) return tell("Opening Anki…");
      if (r && r.scheme && launchByScheme(r.scheme)) {
        tell("Starting Anki…");
        // We can open the URL but we can't see what came of it. The background
        // listens for Anki coming up, and sends you to the download page if it
        // never does.
        try { chrome.runtime.sendMessage({ type: "ankiLaunchWatch" }, () => void chrome.runtime.lastError); } catch {}
        return;
      }
      tell("Could not start Anki — install it, or open it once with the ⬇ Add-on");
    });
  } catch {}
}
// Point at the ⬇ Add-on button, for the moments when installing the add-on is the
// answer. It used to have to unfold the card and open the "Anki window" folder
// first; the button lives out in the open now, so scrolling to it and giving it a
// nudge is the whole job.
function revealAddonButton() {
  const btn = document.getElementById("ankiAddon");
  if (!btn) return;
  btn.scrollIntoView({ block: "center", behavior: "smooth" });
  btn.classList.add("nudge");
  setTimeout(() => btn.classList.remove("nudge"), 2600);
}
// How the attempt ended, once the background knows.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "ankiLaunchResult") return;
  if (msg.started) {
    toast(msg.noAddon ? "Anki is open ✓ — press ⬇ Add-on so it can count as work" : "Anki is open ✓");
    if (msg.noAddon) revealAddonButton();
    return;
  }
  if (msg.openedDownload) {
    // Either Anki isn't on this computer, or it is but nothing has registered the
    // launcher yet. Both are covered: the download page is already open, and this
    // points at the one button that fixes the second case.
    toast("Couldn't start Anki. If you already have it, press ⬇ Add-on and install that file in Anki — it's what lets this button work.");
    revealAddonButton();
  }
});

// The ✕ on a chip is a plain inline element, so a click listener alone made it
// mouse-only. This gives it the button role, a tab stop, and Enter/Space — the
// three things a screen reader and a keyboard need before it counts as a control.
//
// Written without naming the tag in this comment on purpose: tools/audit.mjs counts
// opening against closing tags textually, and an angle-bracketed tag name in a
// comment reads to it as one more unclosed element.
function onActivate(el, fn) {
  if (!el) return;
  el.setAttribute("role", "button");
  if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "0");
  el.addEventListener("click", fn);
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    fn(e);
  });
}

// ---- page state ----------------------------------------------------------
let activeTab = "study";
// Set when the tab strip was moved with the keyboard, so the redraw can hand focus
// back to the new tab. Cleared as soon as it's used.
let tabFocusWanted = false;
// An address the right-click menu was asked to ALLOW while the settings were locked (see
// siteMenuClicked in background.js). The worker cannot ask for the password, so it opens this page with
// the address in ?allow= and this page adds it the way its own ➕ button does: strict mode refuses it,
// and the password is asked for. Read once and taken straight out of the address bar, so a reload can
// never add it a second time. Nothing is allowed by the address alone — only by the password after it.
let menuAllow = (() => {
  try {
    const u = new URL(location.href);
    const v = u.searchParams.get("allow");
    if (v == null) return "";
    u.searchParams.delete("allow");
    history.replaceState(null, "", u.pathname + u.search + u.hash);
    return String(v).slice(0, 4000);
  } catch (e) { return ""; }
})();
// The allow list's own add, handed out by renderBlocked so the address above goes through exactly the
// same steps as one typed into the box. Null until that card is on the page.
let menuAllowRun = null;
// True while the make-a-password screen is what's on screen. Nothing may repaint over it — the
// page behind it does not exist yet. It is no longer set for a merely LOCKED session: that now
// shows the whole settings page and gates the writes instead. See renderRoot at the bottom of
// this file, and requireUnlock for where the password is actually asked for.
let lockedNow = false;
// The pending debounced save of the Anki card. Module-scoped on purpose: it has to
// outlive the binder that armed it so a re-render can cancel it. See commitAnki().
let pendingCommit = 0;
// Collapsed by default so the page looks simple; remembered per session.
let ankiOpen = false;
// The phone folder inside step 2. Shut to begin with, because most people never wire a phone up,
// and remembered while the page is open so it doesn't slam shut on every re-render.
let phoneOpen = false;
// The pending debounced save of the two phone addresses. Module-scoped for the same reason
// pendingCommit above is: every render of that card makes a NEW binder, so a local timer armed by
// the previous render could never be cleared by the next one and would fire against dead DOM.
let pendingMdSave = 0;
// Set by bindAnkiHandlers so the live repainter can refresh the row without
// re-rendering the tab. Null until the row is on screen.
let ankiRepaint = null;
// Each group inside the card is a little folder you can fold shut.
const ankiSectOpen = { win: false, cam: false, cards: false, goals: false, when: false,
                       words: false, ai: false, where: false, watch: false };
// Which switches live in which folder — used for the "2/4 on" badge.
//
// "goals" is its own folder rather than more rows in "cards" because the two answer
// different questions. Everything under "cards" is a check on whether the time you
// are being paid for is real; everything under "goals" is another thing you have to
// FINISH before the sites open. Mixing them made "also need this many cards" read as
// an anti-cheat measure, which is not what it is.
const ANKI_SECT_SW = {
  win: ["ankiFg", "ankiTimerWin"],
  cam: ["ankiAutoCam", "ankiEyeReq", "ankiBlink", "ankiLive", "ankiOverlay", "ankiPace"],
  cards: ["ankiActive", "ankiStill", "ankiMedia", "ankiMediaPause", "ankiMediaResume",
          "ankiSpam", "ankiMinCardsEn", "ankiUniqueOnly"],
  goals: ["ankiDueEn", "ankiRetEn", "ankiDeckTimeEn"],
  // A fourth folder, for the only two settings in the extension that are about WHEN rather than what
  // or how much. Its own rather than more rows in "goals" because nothing in it is another thing to
  // finish: both take the goal exactly as it is and put a clock on it, and both can leave a finished
  // goal locked — which is a kind of rule nothing else here has.
  when: ["ankiWinEn", "ankiGraceEn"],
  // The last three folders, and none of them is something you have to FINISH. They are all about what
  // you may do WHILE the goal is unfinished: which searches and videos go through, whether your cards
  // may be changed, and whether the add-on enforcing all of it may be switched off.
  //
  // Word detection and AI detection are two folders rather than one, because they are two independent
  // rules about videos: either can be on alone, and with both on a video has to pass both. In one
  // folder the AI read as a sub-option of the words, which it is not.
  words: ["searchGate", "ytGate"],
  ai: ["ytAi"],
  // Where those two rules run: YouTube itself, and the player Google keeps inside its own results.
  where: ["vidYouTube", "vidGoogle"],
  // What serves both rules. Watch time counts for a video either of them let through, and the two
  // locks close the holes the rules leave: both read the card, so the card is a key; a key you can
  // retype is not a key, so the card lock refuses the edit; and a lock enforced by an add-on you can
  // disable in two clicks is not a lock, so the add-on lock refuses that.
  watch: ["ytWatch", "ankiLockColl", "ankiLockNew", "ankiLockAdd"]
};

// Which rows belong to which switch. A sub-option is only shown once its own check is
// on, so a folder you have switched nothing on in is one row per check and no more.
//
// This is the only place the parent-child relationship is written down. Every row
// listed here ships `hidden` in the markup and is revealed by syncKidRows, which means
// the markup can't drift out of step with the toggling — the bug you get from stating
// the same relationship twice.
//
// A dial and a deck list are both sub-options in the same sense: they only mean
// something while the check above them is running. So they are all in one table
// rather than dials being treated as a special case.
// The eye beside the API key box, drawn rather than typed. The 👁 emoji renders at a different size and
// baseline on every platform, and this one has to sit dead centre in a small square button next to a
// text box.
//
// The icon shows the CURRENT state rather than the action — an open eye means "this is hidden, press to
// see it", which is the convention every password box uses — and the tooltip says the action outright so
// the picture never has to carry it alone.
const EYE_SHOW = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_HIDE = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/></svg>`;

// ---- which model answers ----
//
// A picker, and the labels lead on the DAILY ALLOWANCE rather than on the model name, because that is
// the number that decides. Both free tiers are metered per day, and a label that says "about 500" is a
// label somebody can plan a study session around.
//
// Two choices, and only two: Google's Gemini Flash Lite 3.5, and GPT-OSS 120B on Groq. There used to be a
// list of Gemini models plus a box to type any name into, and it was the wrong shape: the full Flash
// models had allowances small enough to run out mid-session, and a typed name was one more way to end up
// with a switch that is on and a gate that never answers. Two services that are each known to work beat
// seven that might.
//
// Two COMPANIES rather than two models from one, on purpose. Each has its own free key and its own daily
// allowance, so when one runs out — or has a bad afternoon — the other is still there, one click away.
//
// The worker holds the actual model names; this list only says which SERVICE answers. That is why the
// stored Gemini model name is always the default: the picker has no way left to choose another one, and
// a value the page cannot show is a value nobody can see is in force.
const AI_MODEL_DEFAULT_NAME = "gemini-3.5-flash-lite";
const AI_MODELS = [
  { id: "gemini-3.5-flash-lite", provider: "gemini",
    label: "Gemini Flash Lite 3.5 — about 500 checks a day",
    note: "Google's Gemini, with a free key from aistudio.google.com/apikey. Quick, a large daily allowance, and it can open a YouTube link — so \"Watch the video\" works on it." },
  { id: "groq", provider: "groq",
    label: "Groq · GPT-OSS 120B — about 1,000 checks a day",
    note: "Groq, with a free key from console.groq.com/keys. Very fast and a separate allowance from Google's. It only reads text, so \"Watch the video\" is not available with it; reading the subtitles uses more of its per-minute allowance, so long videos are read at half the length." }
];
function aiModelSpec(id) {
  const name = String(id || "").trim();
  return AI_MODELS.find(m => m.id === name) || null;
}
// The picker's value for what is stored — "groq" when Groq answers, the Gemini model otherwise.
function aiPickOf(s) {
  return (s && s.ytAiProvider === "groq") ? "groq" : AI_MODEL_DEFAULT_NAME;
}
function aiProviderOfState(s) {
  return (s && s.ytAiProvider === "groq") ? "groq" : "gemini";
}

// The three depths the AI half can look at a video with, in the order they appear on screen and in
// the order they cost more. One table, so the buttons, the tooltips, the status line under the switch
// and the toast after ▶ Test can never describe the same setting differently.
const AI_MODE_LABELS = {
  title: {
    label: "Just the title",
    hint: "The video's title and nothing else — fastest, and the weakest evidence there is",
    said: "the title only"
  },
  details: {
    label: "The details",
    hint: "The title, channel, description, tags and the video's own subtitles",
    said: "the details"
  },
  video: {
    label: "Watch the video",
    hint: "Hand the link to Gemini and let it watch the video itself — slowest, strongest",
    said: "watching the video"
  }
};

const ANKI_KIDS = {
  ankiAutoCam:    ["faceSensRow"],
  ankiEyeReq:     ["eyeSensRow"],
  ankiLive:       ["moveSensRow"],
  ankiBlink:      ["blinkSensRow"],
  // The two speeds mean nothing with the switch off, and two sliders on screen that do nothing is
  // how a card stops being readable.
  ankiPace:       ["paceFastRow", "paceSlowRow", "paceBoxRow"],
  // Media playback tracker owns the pause option, which in turn owns the resume option.
  ankiMedia:      ["mediaPauseRow"],
  ankiMediaPause: ["mediaResumeRow"],
  // "Count each card only once" changes how the row above it counts, so it means
  // nothing on its own.
  ankiMinCardsEn: ["uniqRow"],
  // The deck lists: a box to add one, and the chips already added. Both narrow a check
  // that isn't running, and the chips row is only in the DOM when there are chips.
  //
  // The "only these decks count" pair is not here any more. That control moved to What counts at
  // the top of the Anki card, and its rows are rendered or not rendered by the choice itself
  // rather than being present-but-hidden — there is no switch left for syncKidRows to read.
  ankiDueEn:      ["dueDeckRow", "dueDeckChipRow"],
  ankiDeckTimeEn: ["dtAddRow", "dtChipRow"],
  // The window's two times, and the limit's grace box plus the line that reports on it. Both parents
  // ship OFF, so neither set is ever on screen explaining a rule that is not running — and the times
  // in particular have to follow the SWITCH rather than the deadline being valid, or a pair that
  // somehow arrived unset would hide the only controls that could set them.
  ankiWinEn:      ["winTimesRow", "winStateRow"],
  ankiGraceEn:    ["graceMinRow", "graceStateRow"],
  // How many keywords a title needs, and the keywords themselves. The list is the important one:
  // it is the only place you can SEE what the word check is currently letting through, and with it
  // off it would be a row of words explaining a rule that is not running.
  //
  // The AI row is NOT here any more. It is a rule of its own, in its own folder, and it means something
  // with the word check off. The watch-time row is not here either: it belongs to either rule, so
  // syncKidRows shows it while at least one of them is on.
  ytGate:         ["ytHitsRow", "ytKwRow"],
  // The search gate's one kid. Only the word count: the keyword list itself is already on screen
  // under the video gate, and two copies of the same words would suggest the two gates could be
  // looking at different ones.
  searchGate:     ["searchHitsRow"],
  // And the AI's own three, which mean nothing until it is on. The key box especially: a box asking
  // for a credential, for a feature nobody switched on, is the kind of thing people paste into and
  // then wonder why nothing happened.
  //
  // The depth rows are here too. ytAiModeRow always belongs to the AI switch; the three field rows
  // belong to it AND to the depth being "the details", which is one condition more than this table can
  // express — so they are listed here (which gets them hidden with the switch) and narrowed further by
  // syncKidRows, exactly like the media pause/resume pair.
  // ytAiOutRow is in here so it disappears with the switch like everything else, and narrowed further
  // by syncKidRows so it does not appear as an empty panel before anything has been tested.
  ytAi:           ["ytAiKeyRow", "ytAiPctRow", "ytAiModeRow",
                   "ytAiSDescRow", "ytAiSTagsRow", "ytAiSTextRow", "ytAiModelRow", "ytAiOutRow"]
};

// How far ahead the deadline's year box goes. A ceiling because this is a promise you cannot take
// back, not a life sentence, and a spinner with no end is one you can get lost in. Shared by the
// markup and by the guard that clamps a typed year, so the limit is one number in one place.
const YEARS_AHEAD = 20;
// The window this card OFFERS when storage holds no times yet, and the parser that reads them.
//
// Both come from gates.js now. They used to be written out here AND in popup.js with different
// fallbacks, and the comment that stood in this spot described what that cost: the card displayed
// 15:00 → 08:00 while the guard fell back to 00:00 → 00:00, which is a zero-length window and
// therefore "never" — so strict mode read as armed on screen while the goal could be lowered, sites
// unblocked and the camera switched off at will. One definition, in the file that exists for
// exactly this, is the fix that cannot come apart again.
const STRICT_FROM = FGGates.STRICT_FROM;
const STRICT_TO = FGGates.STRICT_TO;
const strictTime = (v, fallback) => FGGates.hhmm(v, fallback);

// Are the settings frozen right now? Every guard on this page asks this and nothing else, and there
// are around thirty of them — so it has to mean one thing.
//
// It now covers BOTH reasons: inside the daily window, or inside a running deadline. The deadline
// used to be a separate condition each guard would have had to remember to ask about as well, which
// is thirty chances to forget. Kept as a local name because those thirty call sites read better for
// it, but the answer comes from gates.js.
function inStrictWindow(s) {
  return FGGates.strictNow(s);
}

// Switched off from the popup, this page would otherwise look exactly as usual —
// bars, times, locked list — while none of it is doing anything. So it says so, at
// the top, with the way back.
function offBanner(s) {
  if (s.enabled !== false) return "";
  return `<div class="card offbanner">
    <span class="offic" aria-hidden="true">⏻</span>
    <div class="offtxt">
      <div class="offttl">This extension is switched off</div>
      <div class="offsub">Nothing is blocked, no Anki time is being counted, and the camera stays off — everything below is only what <i>would</i> happen. Your settings and today's progress are kept.</div>
    </div>
    <button class="btn" id="turnOnFg">Turn it on</button>
  </div>`;
}
// Today is one of the days you switched off in Setup.
//
// Its own banner rather than a line buried in the Setup tab, and for the same reason offBanner
// exists: without it this page is a wall of goals, bars and locked sites while none of it is doing
// anything today, and the obvious conclusion is that the extension is broken. Said at the top, with
// the reason and where the switch is.
//
// Quieter than offBanner — no button. That one reports a state you probably did not mean to be in;
// this one reports a decision you made on purpose, and a "turn today on" button beside it would be
// a one-click way out of the rest day you set up in advance. The way back is the chip in Setup,
// which asks for your password.
function dayOffBanner(s) {
  // Never both. With the extension switched off altogether, which weekday it is changes nothing —
  // two banners saying "nothing is blocked" would just be one of them repeating the other.
  if (s.enabled === false) return "";
  if (FGGates.dayIsOn(s)) return "";
  return `<div class="card offbanner">
    <span class="offic" aria-hidden="true">📅</span>
    <div class="offtxt">
      <div class="offttl">${escHtml(FGGates.dayName(s))} is a day off</div>
      <div class="offsub">Nothing is blocked today and the camera window stays away — everything below is only what <i>would</i> happen on a working day. Anki time still counts if you study anyway. Change this under <b>⚙️ Setup → 📅 Days it works on</b>.</div>
    </div>
  </div>`;
}
function strictBanner(s) {
  if (!inStrictWindow(s)) return "";
  // Says WHICH of the two has you, because the banner is what you read when you are looking for the
  // way out and the two answers are completely different: "until 8 AM" is when tonight's window
  // lifts, "3 days 4 hours" is a stretch that does not lift at all. Both, when both are on.
  const deadline = FGGates.strictDeadlineActive(s);
  const daily = FGGates.dailyStrict(s);
  const left = FGGates.strictLeftText(s);
  const why = [];
  if (deadline) {
    why.push(`Held on until <b>${escHtml(FGGates.strictUntilLabel(FGGates.strictUntil(s)))}, ` +
             `${escHtml(FGGates.strictUntilTime(s))}</b>${left ? " — " + escHtml(left) + " left" : ""}.`);
  }
  if (daily) {
    why.push(`Today's window runs to <b>${escHtml(strictTime(s.strictEnd, STRICT_TO))}</b>.`);
  }
  return `<div class="card" style="background:var(--bad-l);border-color:rgba(var(--bad-rgb),.45)">
    <div style="display:flex;align-items:center;gap:10px">
      <div style="font-size:22px">🛑</div>
      <div>
        <div style="font-weight:700;font-size:13px">Strict mode is active</div>
        <div style="font-size:12px;color:var(--ink2);margin-top:2px">${why.join(" ")} Nothing can be loosened: you can raise today's goal, block more sites and allow fewer, but not the reverse.</div>
      </div>
    </div>
  </div>`;
}

// ---- the password, asked at the moment it matters ------------------------
// This used to be a full-page door: open Settings with the session locked and the entire page
// was one password box. That is the wrong shape for what the password is for. It exists so you
// cannot casually undo your own rules — which is about CHANGING things. Locking the reading
// too meant you could not check what your goal was, whether Anki was connected, or how much of
// today is left, without first proving who you are, and none of those is a rule you could
// weaken by looking at it.
//
// So the page opens. Every write asks. There is one place to ask from because there is one
// place that writes — setStateP — plus the handful of messages that change something in the
// worker instead of in storage, which call this themselves.
//
// Making a password for the first time is still a full-page step: see renderRoot.
let editLocked = false;
// True from the moment this page unlocks itself until its own storage event has been seen and
// ignored. See the listener at the bottom of the file for why that redraw has to be skipped.
let selfUnlock = false;
async function requireUnlock() {
  if (!editLocked) return true;
  const s = await getState();
  // Turned off, or unlocked in another tab, while this page sat open. Nothing to ask.
  if (s.passwordProtectionEnabled === false || !s.passwordHash || s.sessionUnlocked) {
    editLocked = false;
    return true;
  }
  if (!(await askPassword(s.passwordHash))) return false;
  // Raw, or this would come straight back through the gate it has just satisfied.
  selfUnlock = true;
  await setStateRaw({ sessionUnlocked: true });
  editLocked = false;
  return true;
}

// A small bar at the bottom of the window, and deliberately not a modal.
//
// It was a centred sheet behind a dark scrim, and that was three sizes too big for what it
// does. It has one question, the answer is one short word, and it interrupts an edit you have
// already decided on — so it dims nothing and covers nothing. The scrim was the worst of it:
// it hid the setting being asked about, and a page that goes dark is the language this file
// uses for "are you sure you want to wipe the day", not for "type your password".
//
// The hash is checked in here rather than by the caller so a wrong password can be answered
// where it was typed, without the bar closing and losing the edit that opened it.
//
// One bar at a time, and every waiting write shares it. Nothing is blocking the page now, so a
// second edit can easily arrive while this is open — two bars would then be two prompts for one
// password, and the first to be answered would leave the other stranded.
let pwAsk = null;
function askPassword(hash) {
  if (pwAsk) return pwAsk;
  pwAsk = new Promise(resolve => {
    const bar = document.createElement("div");
    bar.className = "pwbar";
    bar.setAttribute("role", "dialog");
    bar.setAttribute("aria-label", "Password needed to change a setting");
    bar.innerHTML = `
      <div class="pwrow">
        <span class="pwic" aria-hidden="true">🔒</span>
        <input class="input" id="pgPw" type="password" autocomplete="current-password"
               placeholder="Your password" aria-label="Your password"/>
        <button class="btn" id="pgYes" type="button">Unlock</button>
        <button class="btn sec" id="pgNo" type="button">Cancel</button>
      </div>
      <div class="pwerr" id="pgHint" role="status"></div>`;
    document.body.appendChild(bar);
    const box = bar.querySelector("#pgPw"), hint = bar.querySelector("#pgHint");
    const yes = bar.querySelector("#pgYes"), no = bar.querySelector("#pgNo");
    function close(v) {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onAway, true);
      bar.remove();
      pwAsk = null;
      resolve(v);
    }
    async function submit() {
      const pw = box.value;
      if (!pw) { hint.textContent = "Type your password"; return; }
      if ((await sha256(pw)) !== hash) {
        hint.textContent = "Wrong password";
        box.select();
        return;
      }
      close(true);
    }
    function onKey(e) {
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(false); }
      else if (e.key === "Enter" && bar.contains(document.activeElement)) {
        e.stopPropagation(); e.preventDefault(); submit();
      }
    }
    // A press anywhere else on the page is a cancel, the same as Escape.
    //
    // There is no scrim to click on — the bar deliberately dims and covers nothing — so until now
    // the only ways out were the Cancel button and a key. Clicking off it, which is what everyone
    // tries first with a small thing at the edge of the screen, did nothing at all, and a prompt
    // that will not go away is worse than one that asks too often.
    //
    // pointerdown rather than click, so the bar is gone by the time whatever you pressed on reacts.
    // On `click` the bar was still standing while the control underneath ran its own handler — and
    // if that handler is one that needs the password, it would open a second bar, which this one's
    // own close would then remove.
    function onAway(e) {
      // Inside the bar is not away. composedPath, not `contains`, because the target of a press on
      // the bar's own input can be inside a shadow tree the bar does not literally contain.
      const path = typeof e.composedPath === "function" ? e.composedPath() : [e.target];
      if (path.includes(bar)) return;
      close(false);
    }
    // Escape works from anywhere; Enter only from inside the bar, because without a scrim the
    // rest of the page still has the keyboard and Enter means something in its own boxes.
    document.addEventListener("keydown", onKey, true);
    // Registered on the next task, not now. This bar is opened from an edit that a press just
    // started, and on some of those paths the press is still being dispatched — registering during
    // it would have the bar close itself on the very press that asked for it.
    // `bar.isConnected`, not `pwAsk`: by the time this runs THIS bar may already have been closed
    // and a different one opened, which leaves pwAsk truthy and pointing at someone else. Attaching
    // then would give the new bar a listener whose close() belongs to the old one.
    setTimeout(() => {
      if (bar.isConnected) document.addEventListener("pointerdown", onAway, true);
    }, 0);
    no.addEventListener("click", () => close(false));
    yes.addEventListener("click", submit);
    setTimeout(() => box.focus(), 30);
  });
  return pwAsk;
}

// Says out loud what state the page is in, so a prompt appearing on the first edit is expected
// rather than a surprise. Only ever on screen while the lock is actually up.
function lockBanner() {
  if (!editLocked) return "";
  return `<div class="card lockbar">
    <span class="lockbaric" aria-hidden="true">🔒</span>
    <div class="grow">
      <div class="lockbarttl">Settings are locked</div>
      <!-- The rule this describes changed, so the sentence had to. It used to be "changing something
           will ask", because every write asked. Now only the direction the password is for asks —
           see setStateP. Saying "changing something" when half of it no longer prompts would train
           you to distrust the banner. -->
      <div class="lockbarsub">Read anything, and make any rule <b>stricter</b> freely. Easing one off asks for your password.</div>
    </div>
    <button class="btn sec lockbarbtn" id="unlockNow" type="button">Unlock</button>
  </div>`;
}

// ---- making a password, the one thing still worth a whole page ------------
// This used to be two screens in one function: "make a password" and "enter password". The
// second one is gone — a locked session lets you read the page and asks on the first edit
// instead, see requireUnlock — so what is left is only the first run, where there is no hash
// to check anything against and so nothing that "read-only" could protect.
// It also used to be a WALL: the only thing on it was "Save & continue", so a password was
// compulsory before you could reach your own settings for the first time. That is the wrong default
// for something nobody had asked for yet. Plenty of people want the blocking and not the ceremony,
// and a required password at the door has two costs — it turns a first run into a chore, and the
// password most likely to be invented under that kind of pressure is the one most likely to be
// forgotten, at which point the recovery story is uninstalling the extension.
//
// So there is a way past it now, and it is a real choice rather than a hidden one: skipping writes
// passwordProtectionEnabled: false, which is the same state the Password tab's own off switch
// produces. Nothing is half-configured, and the Password tab can turn it on whenever you like.
async function renderSetupPassword() {
  const s = await getState();
  // Almost impossible, and cheap to be right about. Reaching this screen means no password exists,
  // and strict mode with no password is a state you can only get into by importing a backup that had
  // it on. If somebody manages it, skipping would be switching protection off mid-commitment — which
  // is exactly what strict mode is for refusing — so the way out is simply not offered.
  const canSkip = !inStrictWindow(s);
  app.innerHTML = `
    <div class="wrap">
      <div class="brand">
        <div class="logo">${BRAND_MARK}</div>
        <h1>Block Sites Until I Complete ANKI</h1>
        <span class="grow"></span>
        ${window.FGTheme ? window.FGTheme.buttonHtml() : ""}
      </div>
      <div class="card lockcard">
        <h2>🔑 Set a password? ${tip("<b>Optional.</b> The blocking works either way.<br/><br/>What it buys you: you can't quietly undo your own rules in a weak moment. Lowering a goal, unblocking a site or switching the extension off asks for the password first.<br/><br/>What it costs: nothing you can read. Opening Settings and looking at anything is always free, and making a rule <b>stricter</b> is too. Only easing one off asks.<br/><br/>At least 4 characters, and write it down somewhere safe — there is no reset link.<br/><br/>Skipping is not a dead end: <b>🔑 Password</b> in Settings turns it on whenever you want.")}</h2>
        <p class="hint" style="margin:8px 0 12px">A password stops you undoing your own rules later. It's optional — you can add one any time from Settings.</p>
        <input class="input" id="pw" type="password" placeholder="Password" autocomplete="new-password" style="width:100%"/>
        <input class="input" id="pw2" type="password" placeholder="Confirm password" autocomplete="new-password" style="width:100%;margin-top:8px"/>
        <div class="err" id="err"></div>
        <button class="btn" id="go" style="width:100%;margin-top:6px">Save &amp; continue</button>
        ${canSkip ? `<button class="btn sec" id="skip" style="width:100%;margin-top:8px">No thanks — skip for now</button>
        <p class="hint" style="margin-top:10px;text-align:center">Skipping leaves your settings unprotected. Blocking still works exactly the same.</p>`
        : `<p class="hint" style="margin-top:10px">Strict mode is on, so this step can't be skipped.</p>`}
      </div>
    </div>`;
  $("#go").addEventListener("click", async () => {
    const pw = $("#pw").value, pw2 = $("#pw2").value;
    const err = $("#err");
    if (!pw) { err.textContent = "Password required"; return; }
    if (pw.length < 4) { err.textContent = "Password too short"; return; }
    if (pw !== pw2) { err.textContent = "Passwords do not match"; return; }
    // Raw: this IS the password being set, so it must not be sent through the gate that asks
    // for a password that does not exist yet.
    await setStateRaw({ passwordHash: await sha256(pw), sessionUnlocked: true });
    renderRoot();
  });
  // No hash is written, so nothing is left half-made: renderRoot's first line sends anyone with
  // protection off straight to the settings page, and the Password tab's own "Turn on" form is the
  // one that appears when there is no hash yet. One way in, whichever door you came to it by.
  //
  // Raw, for two reasons that both apply: there is no password to ask for, and this write LOOSENS
  // passwordProtectionEnabled, so setStateP would refuse it and then ask for a password that does
  // not exist. sessionUnlocked goes with it so nothing on the next screen is in a locked state that
  // has nothing to unlock.
  $("#skip")?.addEventListener("click", async () => {
    if (inStrictWindow(await getState())) { renderRoot(); return; }
    await setStateRaw({ passwordProtectionEnabled: false, sessionUnlocked: true });
    editLocked = false;
    renderRoot();
    toast("Skipped — add a password any time from 🔑 Password");
  });
}

// ---- full-page lock: nothing visible until the password is entered --------
// When fullPageLockEnabled is on AND the session is locked, the entire settings
// page is replaced by a single password prompt. Unlike the old read-only mode
// (which shows everything and asks on loosening edits), this shows NOTHING —
// not the goal, not the blocklist, not the streak. The idea is that someone who
// can see their own rules can plan around them; someone who cannot, cannot.
async function renderFullPageLock() {
  const s = await getState();
  app.innerHTML = `
    <div class="wrap">
      <div class="brand">
        <div class="logo">${BRAND_MARK}</div>
        <h1>Block Sites Until I Complete ANKI</h1>
        <span class="grow"></span>
        ${window.FGTheme ? window.FGTheme.buttonHtml() : ""}
      </div>
      <div class="card lockcard">
        <h2>🔒 Settings are locked ${tip("<b>Full-page lock</b> is on. Nothing on the settings page is visible until you enter your password.<br/><br/>You can turn this off from the <b>🔑 Password</b> tab once you are inside.")}</h2>
        <p class="hint" style="margin:8px 0 12px">Enter your password to view and edit settings.</p>
        <input class="input" id="fpPw" type="password" placeholder="Password" autocomplete="current-password" style="width:100%"/>
        <div class="err" id="fpErr"></div>
        <button class="btn" id="fpGo" style="width:100%;margin-top:6px">Unlock</button>
      </div>
    </div>`;
  const box = $("#fpPw"), err = $("#fpErr"), btn = $("#fpGo");
  async function submit() {
    const pw = box.value;
    if (!pw) { err.textContent = "Enter your password"; return; }
    if ((await sha256(pw)) !== s.passwordHash) { err.textContent = "Wrong password"; box.select(); return; }
    selfUnlock = true;
    await setStateRaw({ sessionUnlocked: true });
    editLocked = false;
    lockedNow = false;
    renderRoot();
  }
  btn.addEventListener("click", submit);
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
  });
  setTimeout(() => box.focus(), 30);
}

// ---- the page ------------------------------------------------------------
async function renderApp() {
  // Anything typed but not yet saved is about to lose its input elements, so drop
  // the pending save rather than let it fire against a form that no longer exists.
  clearTimeout(pendingCommit);
  const s = await getState();
  app.innerHTML = `
    <div class="wrap">
      <div class="brand">
        <div class="logo">${BRAND_MARK}</div>
        <h1>Block Sites Until I Complete ANKI</h1>
        <span class="grow"></span>
        ${window.FGTheme ? window.FGTheme.buttonHtml() : ""}
      </div>
      <div class="tag">Do your Anki reps first. Then the fun sites open. ${tip("<b>How it works</b><ol><li>In step <b>1</b>, set how long you must study in your <b>Anki desktop app</b> today.</li><li>In step <b>2</b>, list the sites to keep blocked (games, social media…).</li><li>Step 2 stays blocked until step 1 is finished.</li><li>Everything resets each day at the time you choose in <b>Setup</b>.</li></ol>")}</div>

      ${offBanner(s)}
      ${dayOffBanner(s)}
      ${scoreStrip(s)}

      <div class="tabs" role="tablist" aria-label="Settings sections">
        ${[["study", "Study Anki, unlock your sites", "🧠 Study &amp; Unlock"],
           ["setup", "Day, strict mode, auto-lock", "⚙️ Setup"],
           ["security", "Password", "🔑 Password"]].map(([id, hint, label]) => {
          // role/tabindex/aria-selected, not a bare clickable div. These were three
          // divs with a click listener, so the whole tab strip was unreachable by
          // keyboard — you could not get to Setup or Password without a mouse.
          const on = activeTab === id;
          return `<div class="tab ${on ? "active" : ""}" data-tab="${id}" role="tab"
                       tabindex="${on ? "0" : "-1"}" aria-selected="${on}" title="${hint}">${label}</div>`;
        }).join("")}
      </div>

      ${strictBanner(s)}
      ${lockBanner()}
      <div id="tabContent"></div>
    </div>`;
  // The banner's own way in, for anyone who would rather unlock once up front than be asked
  // on the first thing they touch.
  $("#unlockNow")?.addEventListener("click", async () => {
    if (await requireUnlock()) { toast("Unlocked ✓"); renderApp(); }
  });
  const tabEls = [...document.querySelectorAll(".tab")];
  const goTab = (id, byKey) => { activeTab = id; tabFocusWanted = !!byKey; renderApp(); };
  tabEls.forEach((t, i) => {
    t.addEventListener("click", () => goTab(t.dataset.tab, false));
    // Enter/Space to pick, arrows to move along the strip — what a tablist is
    // expected to do, and the only way to reach these without a mouse.
    t.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); return goTab(t.dataset.tab, true); }
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      goTab(tabEls[(i + step + tabEls.length) % tabEls.length].dataset.tab, true);
    });
  });
  // renderApp() rebuilt the strip from scratch, so a keyboard user's focus died
  // with the old element. Put it back on the tab that is now current — but only
  // after a key press, so opening the page doesn't grab focus from nothing.
  if (tabFocusWanted) {
    tabFocusWanted = false;
    tabEls.find(t => t.dataset.tab === activeTab)?.focus({ preventScroll: true });
  }
  // Turning it back on is free — it's the direction that can only help you. (The
  // popup asks for the password to switch it off, not on.)
  $("#turnOnFg")?.addEventListener("click", async () => {
    await setStateP({ enabled: true });
    tellWorker({ type: "refreshBlockedTabs" });
    renderApp();
    toast("Switched on ✓");
  });

  ankiRepaint = null;
  if (activeTab === "study") renderStudyUnlock(s);
  else if (activeTab === "setup") renderSetup(s);
  else renderSecurity(s);

  // An address the right-click menu handed over — see menuAllow. Once, and only once the lists are on
  // the page, so the allow list's own add can take it from here. Said first, because the password bar
  // that follows asks for a password without saying what for.
  if (menuAllow && activeTab === "study" && menuAllowRun) {
    const raw = menuAllow;
    menuAllow = "";
    const sites = FGSettings.sitesInText(raw);
    if (sites.length) {
      const run = menuAllowRun;
      toast("Allowing " + sites.join(", ") + " from the right-click menu" +
            (editLocked ? " — type your password to confirm" : ""), { cls: "wide", ms: 5000 });
      setTimeout(() => { run(sites.join(", ")).catch(() => {}); }, 60);
    }
  }

  // Ask Anki whether it's really there, rather than trusting what was stored the
  // last time anything looked.
  if (s.ankiEnabled !== false) {
    try { chrome.runtime.sendMessage({ type: "ankiPoll" }, () => void chrome.runtime.lastError); } catch {}
  }
}

// Points, streak and today's total: never something you *do*, only something you
// glance at, so it lives in one strip above the tabs.
function scoreStrip(s) {
  const xp = s.xp || 0, level = s.level || 1;
  const inLevel = xp % 500;
  const pct = Math.round((inLevel / 500) * 100);
  const on = s.ankiEnabled !== false;
  const done = on && ankiGoalMet(s) ? 1 : 0;
  const total = on ? 1 : 0;
  const mins = Math.floor((s.ankiEnabled !== false ? (s.ankiSpentSec || 0) : 0) / 60);
  const allDone = total > 0 && done >= total;
  return `
      <div class="score">
        <span class="s1" title="Level ${level} — ${inLevel} of 500 points to level ${level + 1}">
          <b data-k="level">Lv ${level}</b>
          <span class="xpbar"><span style="width:${pct}%"></span></span>
        </span>
        <span class="s1" title="Days in a row where you finished your Anki goal">🔥 <b data-k="streak">${s.streakCount || 0}</b></span>
        <span class="s1${allDone ? " ok" : ""}" title="Goal done today">${allDone ? "✅" : "☑️"} <b data-k="done">${done}/${total}</b></span>
        <span class="s1" title="Anki time you put in today">⏱️ <b data-k="mins">${mins}m</b></span>
        <span class="grow"></span>
        ${tip("<b>+200 points</b> when you finish your Anki goal for the day<br/><b>500 points = 1 level up</b><br/><br/><b>🔥 Streak</b> grows by 1 each day you finish before the day resets. Miss a day and it goes back to zero.")}
      </div>`;
}

// A news-ticker line: the message scrolls past instead of being cut off, so a long
// sentence fits under a heading without wrapping the card.
function tickerHtml(text, testid) {
  const safe = escHtml(text);
  return `<div class="ticker" data-t="${testid}" role="status" aria-label="${safe}">
            <span><i>${safe}</i><i aria-hidden="true">${safe}</i></span>
          </div>`;
}
function lockedStayPhrase(s) {
  if ((s.blockMode || "blacklist") === "whitelist") return "everything else stays blocked";
  const n = (s.blockedSites || []).length;
  if (!n) return "the sites in the locked list stay blocked";
  return n === 1 ? "the site in the locked list stays blocked" : "the sites in the locked list stay blocked";
}
function earnTickerText(s) {
  const t = todayTotals(s);
  const stay = lockedStayPhrase(s);
  // No goal yet is its own sentence, and it comes before "done": a 0s goal is "met" in the empty sense,
  // which is how this line used to greet a fresh install with "All done".
  if (!t.count || !FGGates.hasGoal(s)) return `Set how long you must study in Anki today. Until you do that time, ${stay}.`;
  // "Done" is every gate, not just the clock. This used to be `t.left > 0`, which is
  // the time goal alone — so with a due or retention gate still holding the sites
  // shut, the moment the clock filled the crawl announced "All done. The locked sites
  // are open now" while they were locked. The most confusing thing it could say.
  if (FGGates.met(s)) return `All done. The locked sites are open now.`;
  const goal = fmtDur(t.req);
  const extra = FGGates.evaluate(s).items
    .filter(i => i.blocked && i.key !== "time")
    .map(i => i.left);
  const also = extra.length ? ` — also ${extra.join(", ")}` : "";
  return `Study ${goal} in your Anki app today${also}. If you don't finish it, ${stay}.`;
}
function lockTickerText(s) {
  const t = todayTotals(s);
  // A time only when there is one. "Until you study 0s in Anki" was this line's reading of an empty
  // goal; with no time set, the no-goal wordings below say the true thing instead.
  const goal = t.count && t.req > 0 ? fmtDur(t.req) : "";
  // Same correction as earnTickerText: finished means every gate, not just the clock — and a day with
  // nothing in it is not finished. See ankiGoalMet.
  const done = ankiGoalMet(s);
  const blocked = s.blockedSites || [], allowed = s.allowedSites || [];
  if ((s.blockMode || "blacklist") === "whitelist") {
    if (!allowed.length) {
      return goal ? `Nothing is open. Study ${goal} in Anki to open it.`
                  : "Only the sites you add here will open. First set an Anki goal in step 1.";
    }
    const only = allowed.length === 1 ? "Only this site is open" : `Only these ${allowed.length} sites are open`;
    return goal ? `${only}. Everything else stays blocked until you study ${goal} in Anki.`
                : `${only}. First set an Anki goal in step 1.`;
  }
  if (!blocked.length) {
    return goal ? `Add a site here which will stay blocked until you study ${goal} in Anki.`
                : `Add a site here which will stay blocked until your Anki goal is done.`;
  }
  const one = blocked.length === 1;
  const subj = one ? "This site" : `These ${blocked.length} sites`;
  if (!goal) return `${subj} ${one ? "opens" : "open"} when your Anki goal is done. First set the goal in step 1.`;
  if (done) return `Anki done. ${subj} ${one ? "is" : "are"} open until tomorrow.`;
  const togo = FGGates.remainingText(s);
  return `${subj} ${one ? "stays" : "stay"} blocked until you study ${goal} in Anki. ${togo} to go.`;
}
// Rewrite both crawls from current state, so the sentence follows the number you
// just typed without re-rendering the tab (which would steal focus).
async function refreshTickers() {
  const s = await getState();
  [["earn", earnTickerText(s)], ["lock", lockTickerText(s)]].forEach(([tid, text]) => {
    const el = document.querySelector(`.ticker[data-t="${tid}"]`);
    if (!el) return;
    const safe = escHtml(text);
    el.setAttribute("aria-label", text);
    el.innerHTML = `<span><i>${safe}</i><i aria-hidden="true">${safe}</i></span>`;
  });
}

// ---- step 1 + step 2 in one tab -----------------------------------------
// The flow card's figures, worked out once for the first render and the live repaint so the two can
// never disagree about whether today is done.
//
// No goal is its own state, and the bar is not drawn at all for it: there is nothing to measure, and
// a full green bar over a zero-second goal was the page announcing a finished day on a fresh install.
function flowFigures(s) {
  const t = todayTotals(s);
  const done = ankiGoalMet(s);
  const noGoal = !FGGates.hasGoal(s);
  const pct = t.req > 0 ? Math.min(100, Math.round(100 * t.spent / t.req)) : (done ? 100 : 0);
  const nothing = noGoal || (!done && !t.count);
  const spentLine = t.req > 0 ? `${fmtDur(t.spent)} of ${fmtDur(t.req)} done today`
    : noGoal ? "No goal set yet"
    : done ? "Goal completed" : "No time goal — the checks below decide";
  return { t, done, pct, nothing, spentLine };
}

function renderStudyUnlock(s) {
  const tc = document.getElementById("tabContent");
  const { done, pct, nothing, spentLine } = flowFigures(s);
  const lockedCount = (s.blockMode === "whitelist") ? (s.allowedSites || []).length : (s.blockedSites || []).length;

  tc.innerHTML = `
    <div class="flowbar ${done ? "done" : ""}" id="flowBar">
      <div class="flowstep">
        <div class="fnum">1</div>
        <div>
          <div class="ftitle">🧠 Study your Anki</div>
          <div class="fsub" id="flowSpent">${escHtml(spentLine)}</div>
        </div>
      </div>
      <div class="flowarrow">➜</div>
      <div class="flowstep">
        <div class="fnum">2</div>
        <div>
          <div class="ftitle" id="flowTitle2">${done ? "🔓 These are open now" : "🔒 To open these"}</div>
          <div class="fsub">${lockedCount ? lockedCount + " site" + (lockedCount === 1 ? "" : "s") : "No sites picked yet"}</div>
        </div>
      </div>
    </div>
    <div class="flowprog" id="flowProg"${nothing ? " hidden" : ""}><div style="width:${pct}%"></div></div>
    <div class="flowpct${done ? " done" : ""}" id="flowPct"${nothing ? " hidden" : ""}>${done ? "🎉 All done. Enjoy!" : pct + "% done"}</div>
  `;
  renderAnkiStep(s);
  renderBlocked(s);
}

// paintBar / barStyle come from bars.js, which this page loads first.

// ---- step 1: the Anki card ----------------------------------------------
// Every group inside the card is a little folder, so the card stays a short list
// of headings until you actually want to change something.
function ankiSect(key, icon, title, onCount, rows) {
  const open = !!ankiSectOpen[key];
  const total = ANKI_SECT_SW[key].length;
  return `
      <div class="sect">
        <button class="secthead" type="button" data-sect="${key}" aria-expanded="${open ? "true" : "false"}" aria-controls="ankiSect_${key}">
          ${CARET}
          <span class="ic" aria-hidden="true">${icon}</span>
          <span class="ttl">${title}</span>
          <span class="cnt" id="ankiSectN_${key}" title="checks switched on in here">${onCount}/${total} on</span>
        </button>
        <div class="sectbody" id="ankiSect_${key}" ${open ? "" : "hidden"}>${rows}</div>
      </div>`;
}

// The per-deck time quotas you've set, each with how far along today is.
//
// Rows of chips rather than the bare name chips the deck list above uses, because
// each one has to carry "3m 20s of 25m" as well as the name — a quota with no
// progress beside it is a setting you have to go and check somewhere else.
//
// The ✕ is dropped entirely during a strict window. Deleting a quota is loosening,
// which is the one direction strict mode exists to refuse, and a button that only
// answers with a "you can't do that" toast is worse than no button.
function deckTimeListHtml(s, strict) {
  const rows = FGGates.deckTimeRows(s);
  if (!rows.length) return "";
  // hidden, and revealed by syncKidRows when the per-deck time check is on — see ANKI_KIDS.
  return `<div class="srow sub kid deckrow" id="dtChipRow" hidden>${rows.map(r => {
    const have = Math.min(r.sec, FGGates.deckSpent(s, r.deck));
    const done = have >= r.sec;
    return `<span class="chip${done ? " ok" : ""}" title="${escHtml(r.deck)} — ${escHtml(fmtDur(have))} of ${escHtml(fmtDur(r.sec))} done today">
      ${done ? "✓ " : ""}${escHtml(r.deck)} <i class="dtq" data-dtq="${escHtml(r.deck)}">${escHtml(fmtDur(have))} / ${escHtml(fmtDur(r.sec))}</i>
      ${strict ? "" : `<span class="x" data-dt-del="${escHtml(r.deck)}" title="Remove" aria-label="Remove the ${escHtml(r.deck)} time quota">✕</span>`}
    </span>`;
  }).join("")}</div>`;
}

// Why the clock isn't running, in plain words. The background stores a short
// code; this is the only place that turns it into something readable.
// Two codes are deliberately absent: "disconnected" is already said by the dot
// beside the name, and "not_foreground" / "in_browser" both mean "you're not in
// Anki right now" — always true while you're reading this page, so they'd be
// permanent noise rather than news.
const ANKI_REASON_TEXT = {
  no_bridge: "install the add-on",
  not_fullwindow: "make Anki fill the whole screen",
  no_reviewer: "open a card",
  no_face: "show your face to the camera",
  still: "move the mouse or type",
  media_paused: "press play on this card's video",
  media_buffering: "waiting for the video to load",
  wrong_deck: "this deck doesn't count",
  spam: "answering too fast",
  idle: "answer a card to start",
  same_card: "move to the next card",
  paused: "paused by you"
};
// ---------------------------------------------------------------------------
// "Can the extension see Anki, and can it see the add-on inside Anki?" — as one
// short coloured word.
//
// These were two separate readouts: a word beside the Anki name for AnkiConnect,
// and a whole second line underneath for the bridge add-on. They are genuinely
// different things, but the states overlap — with Anki closed the card said
// "Anki not found" and "Add-on not found — install it in Anki" one under the
// other, which reads as the same sentence twice.
//
// So they are folded into one line that names whichever thing is actually missing,
// worst first, with the detail in the hover text. Nothing is lost: every state the
// second line used to spell out still has its own word and its own explanation.
// ---------------------------------------------------------------------------
function connState(s) {
  // Nothing polls while the extension or the Anki gate is switched off, so the
  // connection isn't unknown — it isn't being asked. Saying "Anki not found" there
  // blames Anki for the extension being off, and clicking the dot then produced
  // "open Anki desktop" advice for a poll that never touched Anki.
  if (s.enabled === false) {
    return { cls: "busy", word: "not checking",
             title: "The extension is switched off, so Anki isn't being checked. Turn it on from the toolbar icon." };
  }
  // No "the Anki gate is off" state any more: Anki always counts, and there is no
  // switch to have left off. What used to be checked here — and pointed at an icon
  // that is no longer a button — is now covered by the goal time itself: with no time
  // set there is nothing to finish, which ankiSubLine says in its own words.
  if (!ankiLinkedNow(s)) {
    return { cls: "off", word: "Anki not found",
             title: "Anki isn't answering. Open Anki — and install AnkiConnect if you haven't yet. Click to check again." };
  }
  if (!s.ankiBridgeOk) {
    return { cls: "warn", word: "Add-on missing",
             title: "Anki is open, but the AnkiGate Bridge add-on isn't installed — press ⬇ Add-on. Until it is, Anki time stays paused." };
  }
  // Plain text, not pre-escaped. Everything this function returns is consumed twice, by
  // two paths that escape differently: the markup at the connection row runs it through
  // escHtml, so a pre-escaped "&" arrived as "&amp;amp;", and the repaint path writes it
  // with setAttribute/textContent, which escape nothing and so showed the entities
  // literally. One owner for the escaping, and it is the consumer.
  const v = String(s.ankiBridgeVersion || "?");
  // An add-on that is present but older than the one we ship. It used to read "Anki
  // connected" and say nothing, which was fine while every feature worked with every
  // version — it isn't now: the due, retention and unique-card gates need v2.2, and
  // an out-of-date add-on makes them stand aside. The popup has warned about this for
  // a while; the settings page, which is where you'd go to fix it, did not.
  if (ankiAddonVersionKnown && s.ankiBridgeVersion && s.ankiBridgeVersion !== ANKI_ADDON_VERSION) {
    // Both numbers, with an arrow between them. It used to read "Add-on v2.6 — update it",
    // where v2.6 was what you HAVE — and everyone read it as the version being asked for,
    // then went looking for why the extension wanted an older add-on than it ships.
    return { cls: "warn", word: `Add-on v${v} → update to v${ANKI_ADDON_VERSION}`,
             title: `Anki is running add-on v${v}. This extension ships v${ANKI_ADDON_VERSION}, so press ⬇ Add-on, install it in Anki, and restart Anki. Time still counts meanwhile, but anything newer than v${v} — the due, retention and count-each-card-once checks, and the glow on Anki's window — can't run until you do.` };
  }
  if (s.ankiAutoCam === true && s.ankiPinSupported === false) {
    return { cls: "on", word: "Anki connected",
             title: `Add-on v${v} connected. Always-on-top is Windows only, so the camera window can't sit above Anki on this system.` };
  }
  // Deliberately NO "camera not pinned" state here. The add-on reports pinning as
  // false whenever no camera window exists — and none does while you're reading
  // this page, because it only opens once Anki is in front. So that warning fired
  // for every correctly set-up user and told them to reinstall a working add-on.
  // Pin trouble belongs on the study page, where the camera window actually is,
  // and it is reported there.
  return { cls: "on", word: "Anki connected",
           title: `Add-on v${v} connected. Click to check again.` };
}

// The small line under the title: progress, then either "counting now" or the
// reason it's paused, then today's card count if you asked for one.
function ankiSubLine(s) {
  const req = num(s.ankiRequiredSec);
  const met = ankiGoalMet(s);
  const spent = Math.max(0, num(s.ankiSpentSec));
  if (met) {
    return [`<b>${fmtDur(spent)}</b> of ${fmtDur(req)}`, `<span class="go">all done</span>`].join(" · ");
  }
  if (!(req > 0)) return `<span class="why">set a time to start counting</span>`;
  const parts = [`<b>${fmtDur(Math.min(req, spent))}</b> of ${fmtDur(req)}`];
  if (s.ankiStudying) parts.push(`<span class="go">counting now</span>`);
  // ankiReason is only ever one of our own short codes, so a lookup miss is the
  // normal case, not an error — but it is indexed with a stored value, so it must
  // be a string before it touches the table.
  else if (ANKI_REASON_TEXT[String(s.ankiReason || "")]) {
    parts.push(`<span class="why">${ANKI_REASON_TEXT[String(s.ankiReason)]}</span>`);
  }
  // Everything else that is still holding the unlock, in its own words. Only the
  // gates that are actually blocking — a finished one saying "0 more cards" would be
  // taking up room to report nothing. The time gate is left out because the figures
  // at the front of this line already are the time gate.
  const ev = FGGates.evaluate(s);
  const rest = ev.items.filter(i => i.blocked && i.key !== "time").map(i => escHtml(i.left));
  if (rest.length) parts.push(rest.join(" · "));
  else if (ev.met) parts.push(`<span class="go">all done</span>`);
  // A gate that is switched on but cannot be measured has to be said HERE, on the
  // always-visible line, and not only in the folder that explains it. The folders are
  // collapsed by default, so a warning that lives solely inside one is a warning
  // nobody reads — and this particular one means a check the user believes is running
  // isn't. Clicking it goes to the button that fixes it; see the listener below.
  if (ev.warns.length) {
    parts.push(`<span class="why gnag" title="${escHtml(ev.warns.join(" "))}">⚠️ update the Anki add-on</span>`);
  }
  return parts.join(" · ");
}

// The nag in the line above, and the warning box inside the 🎯 folder, both point at
// the same fix: press ⬇ Add-on. Delegated from the document because that line is
// rewritten every couple of seconds by the live repaint, so anything bound to the
// element itself would be thrown away and rebound continuously.
document.addEventListener("click", (e) => {
  if (e.target.closest && e.target.closest(".gnag")) revealAddonButton();
});

// Step 1 of the page: the one thing there is to earn.
function renderAnkiStep(s) {
  const tc = document.getElementById("tabContent");
  const strict = inStrictWindow(s);
  tc.insertAdjacentHTML("beforeend", `
    <div class="card">
      <div class="chead">
        <span class="ctile step" aria-hidden="true">1</span>
        <div class="ctitle">
          <div class="crow">
            <h2>Study your Anki ${tip(`Set how long you must study in your <b>Anki desktop app</b> today. Until that time is done, the sites in step 2 stay blocked.<br/><br/>Type the goal in the <b>h / m / s</b> boxes on the right — it saves itself, there's no button to press, and the boxes flash green when it lands.<br/><br/>Then just study. If the camera check is on, its little window comes up by itself the moment Anki does.<br/><br/>The dot beside <b>Anki app</b> and the word next to it say whether Anki is connected — green yes, red no. Click the dot to check again, or the words to open Anki itself.${strict ? "<br/><br/><b style='color:var(--bad)'>Strict mode is on: you can raise this goal, but not lower it.</b>" : ""}`)}</h2>
          </div>
          ${tickerHtml(earnTickerText(s), "earn")}
        </div>
      </div>
      ${ankiCardHtml(s, strict)}
    </div>`);
  bindAnkiHandlers();
}

// ---- the deck tree ----
// Anki keeps decks as one flat list of names with "::" between the levels: "cleared::6th sem::VLSI"
// is a single name, not a path. Offered raw in a datalist, that is what you saw — thirty lines
// with the same prefix retyped on every one of them, in whatever order the collection happened to
// hand them over, and no way to tell a deck from a folder of decks.
//
// So the "::" is put back to work. Split into a tree, sorted the way Anki sorts it, and shown one
// level at a time with a count of what is inside each folder.
let deckNames = null;        // full names as Anki reported them; null = never fetched
let deckLoadTried = false;   // so the automatic fetch happens once, not once per render
let deckFilter = "";
const deckOpen = new Set();  // which folders are expanded, kept across repaints

function deckTree(names) {
  const root = { name: "", path: "", kids: new Map() };
  for (const full of names || []) {
    const parts = String(full || "").split("::").map(p => p.trim()).filter(Boolean);
    let node = root, path = "";
    for (const part of parts) {
      path = path ? path + "::" + part : part;
      if (!node.kids.has(part)) node.kids.set(part, { name: part, path, kids: new Map() });
      node = node.kids.get(part);
    }
  }
  return root;
}
// Alphabetical and case-insensitive within each level, which is how Anki's own deck list is
// ordered. Deliberately NOT numeric-aware: Anki puts "10th sem" before "2nd sem", and matching
// what you already know matters more than the order I would have picked.
const byDeckName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
// How many decks are inside this one, at any depth. The number on a folder row.
function deckKidCount(node) {
  let n = 0;
  for (const k of node.kids.values()) n += 1 + deckKidCount(k);
  return n;
}
function deckMatches(node, needle) {
  if (!needle) return true;
  if (node.path.toLowerCase().includes(needle)) return true;
  for (const k of node.kids.values()) if (deckMatches(k, needle)) return true;
  return false;
}

// `picked` is what is in ankiDecks. A deck counts if it or any ancestor is on that list — the
// same prefix rule the worker applies — so a child of a chosen deck is shown as already included
// rather than as something else to tick.
function deckTreeHtml(picked, strict) {
  if (!deckNames) {
    return `<div class="dtnote">Reading your decks from Anki…</div>`;
  }
  if (!deckNames.length) {
    return `<div class="dtnote">No decks came back. Is Anki open, with the add-on installed? Press ⬇ Load to try again — or type a deck name above and press ➕.</div>`;
  }
  const pickedSet = new Set(picked || []);
  const coveredBy = (path) => {
    const parts = path.split("::");
    // Ancestors only: the caller has already established this deck itself is not picked.
    for (let i = 1; i < parts.length; i++) {
      const p = parts.slice(0, i).join("::");
      if (pickedSet.has(p)) return p;
    }
    return "";
  };
  const needle = deckFilter.trim().toLowerCase();
  const rows = [];
  const walk = (node, depth) => {
    for (const kid of [...node.kids.values()].sort(byDeckName)) {
      if (!deckMatches(kid, needle)) continue;
      const subs = deckKidCount(kid);
      const own = pickedSet.has(kid.path);
      const via = own ? "" : coveredBy(kid.path);
      // While you are filtering, everything on the way to a match is open — otherwise the thing
      // you searched for is behind a caret you would have to hunt for.
      const open = needle ? true : deckOpen.has(kid.path);
      rows.push(`<div class="dtrow${own ? " on" : ""}${via ? " via" : ""}" style="--d:${depth}">
        ${subs
          ? `<button type="button" class="dtcaret${open ? " open" : ""}" data-deck-open="${escHtml(kid.path)}"
                     aria-expanded="${open ? "true" : "false"}"
                     aria-label="${open ? "Collapse" : "Expand"} ${escHtml(kid.name)}"></button>`
          : `<span class="dtcaret flat" aria-hidden="true"></span>`}
        <button type="button" class="dtpick" data-deck-pick="${escHtml(kid.path)}"
                aria-pressed="${own ? "true" : "false"}" ${strict || via ? "disabled" : ""}
                title="${via ? "Already counted, because " + escHtml(via) + " is picked" : escHtml(kid.path)}">
          <span class="dtbox" aria-hidden="true"></span>
          <span class="dtname">${escHtml(kid.name)}</span>
          ${subs ? `<span class="dtsubs" title="${subs} deck${subs === 1 ? "" : "s"} inside">${subs}</span>` : ""}
          ${via ? `<span class="dtvia">with ${escHtml(via)}</span>` : ""}
        </button>
      </div>`);
      if (open) walk(kid, depth + 1);
    }
  };
  walk(deckTree(deckNames), 0);
  if (!rows.length) return `<div class="dtnote">No deck matches that.</div>`;
  return rows.join("");
}
function ankiCardHtml(s, strict) {
  const req = Math.max(0, s.ankiRequiredSec || 0);
  const met = ankiGoalMet(s);
  const pct = req > 0 ? Math.max(0, Math.min(100, Math.round(((s.ankiSpentSec || 0) / req) * 100))) : (met ? 100 : 0);
  const conn = connState(s);
  const sensWord = ["", "strict", "firm", "normal", "kind", "easy"];
  const eyeWord = ["", "fussy", "firm", "normal", "kind", "easy"];
  const faceSens = Math.min(5, Math.max(1, s.faceSensitivity || 3));
  // The two pace multipliers, held to the ranges their sliders advertise. Read once here rather than
  // inline in the markup, because each is used twice — the slider's value and the label beside it —
  // and two readings of the same thing are two chances to disagree.
  const paceFast = Math.min(4, Math.max(1, Number(s.ankiPaceFast) || 1.5));
  const paceSlow = Math.min(1, Math.max(0.1, Number(s.ankiPaceSlow) || 0.5));
  // Whole percent, and the bounds are the ones settings.js accepts and study.js clamps to.
  const paceBox = Math.min(85, Math.max(30, Math.round(Number(s.ankiPaceBoxPct) || 55)));
  // How wide the camera window is, which is the whole of how big it is: the height is always the
  // picture at the camera's real aspect plus the clock strip, so it follows from this and is not a
  // separate choice.
  //
  // Read out of the remembered bounds rather than out of a setting of its own, because it has no
  // setting of its own and should not get one. The window is the store — the worker writes its bounds
  // down whenever they change — and a key here would be a second place the same number lived. Every
  // resize bug this window has had was two things disagreeing about one figure.
  //
  // The range mirrors CAM_SIZE in background.js, where the worker clamps for real.
  const camW = Math.min(700, Math.max(120,
    Math.round(Number(s.ankiCamBounds && s.ankiCamBounds.width) || 176)));
  const eyeSens = Math.min(5, Math.max(1, s.eyeSensitivity || 3));
  const moveWord = ["", "big move", "firm", "normal", "small", "tiny"];
  const moveSens = Math.min(5, Math.max(1, s.moveSensitivity || 3));
  const blinkWord = ["", "clear", "firm", "normal", "slight", "faint"];
  const blinkSens = Math.min(5, Math.max(1, s.blinkSensitivity || 3));
  // `=== true`: absent means off. The camera is opt-in, so the switch must never
  // render as on before the user has actually turned it on.
  const camOn = s.ankiAutoCam === true;
  // What the goal is measured over: the whole collection, or a chosen list of decks.
  //
  // The LIST is what actually restricts anything — an empty one restricts nothing, and the
  // worker reads it that way too (see deckReq in pollAnkiOnce). So the choice below can say
  // "only these decks" while nothing is picked, and the block has to admit that rather than
  // imply a rule that isn't running.
  const deckScope = !!s.ankiDeckRestrictEnabled;
  const pickedDecks = Array.isArray(s.ankiDecks) ? s.ankiDecks : [];
  return `
    <div class="ankirow${s.ankiEnabled === false ? " off" : ""}${met ? " done" : ""}">
      <div class="chead">
        <!-- Anki's own mark, and nothing more. It used to be an on/off switch for the
             whole gate, which was a second control for something the goal time
             already says: a time of zero means nothing to finish, so there was never
             a reason to have a goal set AND a switch turning it off. Removing it also
             removes the state where the card looks configured but is doing nothing. -->
        <span class="ctile anki" aria-hidden="true">${ANKI_MARK}</span>
        <div class="ctitle">
          <div class="crow">
            <h2><button type="button" class="nmlink" id="ankiOpenApp"
                        title="Open the Anki desktop app" aria-label="Open the Anki desktop app">Anki app<span class="openmark" aria-hidden="true">↗</span></button> ${tip(`Click these words to open Anki. If it's already running its window comes to the front; if it isn't, it starts.<br/><br/><b>It needs setting up once.</b> Chrome is not allowed to run a program, so the <b>⬇ Add-on</b> button on this row teaches <i>Windows</i> a link that starts Anki — after that this just opens that link. Press it, say <b>Install</b> when Anki asks, restart Anki, and it's done. Windows may ask for permission the first time; tick its <i>always allow</i> box.<br/><br/>Don't have Anki at all? The link takes you to its download page.<br/><br/><b>The rest of the one-time setup:</b><ol><li>In Anki: <span class='kbd'>Tools → Add-ons → Get Add-ons</span>, paste <span class='kbd'>2055492159</span>, restart Anki.</li><li>Press <b>⬇ Add-on</b> and install the file it hands you.</li><li>Keep Anki open while you study.</li></ol>`)}</h2>
            <!-- The dot is the button (click to re-check); the word beside it is
                 what you actually read. A coloured dot alone made people guess. -->
            <button class="conndot ${conn.cls}" id="ankiRefresh" title="${escHtml(conn.title)}"></button>
            <span class="connword ${conn.cls}" id="ankiConnText" role="status" aria-live="polite" title="${escHtml(conn.title)}">${escHtml(conn.word)}</span>
            <span class="grow"></span>
            <!-- The one-time install step, in the empty space on the title row
                 rather than in a folder below: until the add-on is in, Anki time
                 stays paused, so it should be the thing you notice. -->
            <button class="btn sec addonbtn" id="ankiAddon" title="Save the Anki add-on to your Downloads folder. Then in Anki: Tools → Add-ons → Install Add-on from File… Needed once.">⬇ Add-on</button>
          </div>
          <div class="csub" id="ankiStatus">${ankiSubLine(s)}</div>
          <div class="progline">
            <div class="progressMini" id="ankiProg" ${strict ? "" : `data-scrub="anki" role="button" tabindex="0"`}
                 aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"
                 title="${strict ? "" : "Click along the bar to wind today's Anki time back to that point"}"
                 aria-label="Anki time done today${strict ? "" : " — click along the bar to wind it back"}"><div class="${s.ankiEnabled !== false && pct > 0 ? "" : "zero"}" style="${barStyle(pct, s.ankiEnabled !== false)}"></div></div>
            <button class="iconbtn mini" id="ankiReset" title="Start today over — put this bar back to zero"
                    aria-label="Start today over"
                    ${strict ? "disabled style='opacity:.35;cursor:not-allowed'" : ""}>↺</button>
          </div>
        </div>
        ${hmsWells(s.ankiRequiredSec, u => `id="anki${u.toUpperCase()}"`, { id: "ankiTime", strict, plain: true, icon: false })}
        <span class="sr-only" id="ankiSaved" role="status" aria-live="polite"></span>
      </div>

      <!-- What the goal is measured over.
           Deliberately NOT inside a folder. After "how long" this is the next thing anyone asks
           about a study goal, and it used to be a switch buried in Cards and decks labelled
           "Only these decks count" — which is the answer to the question phrased as an option,
           so nobody looking for the question found it.
           The shared deck datalist lives here too, and has to. Three deck boxes across two
           folders use it, and a datalist under a hidden ancestor is not reliably offered as
           suggestions — this block is the only part of the card that is always in the layout. -->
      <div class="scopebox">
        <div class="srow sub">
          <span class="ic">📚</span>
          <span class="lbl grow">What counts ${tip("Whether today's goal is measured over your <b>whole collection</b> or only over decks you choose.<br/><br/><b>All of Anki</b> — every review counts, wherever it is. This is how it starts.<br/><br/><b>Only these decks</b> — reviews anywhere else earn you nothing, so an easy throwaway deck can't be used to farm the time. Subdecks come with the parent: <span class='kbd'>Japanese</span> covers <span class='kbd'>Japanese::Verbs</span>.<br/><br/>It scopes the card count as well, because that counts the same reviews.<br/><br/>Choose this and pick nothing, and everything still counts — an empty list restricts nothing, and the row below says so.<br/><br/>Not the same as <b>Also needed to unlock → Only these decks' due</b>. That one decides whose backlog has to reach zero; this one decides which reviews earn you time.")}</span>
          <span class="seg" role="group" aria-label="What counts towards today's goal">
            <button type="button" class="segbtn${deckScope ? "" : " on"}" data-scope="all"
                    aria-pressed="${deckScope ? "false" : "true"}" ${strict ? "disabled" : ""}>All of Anki</button>
            <button type="button" class="segbtn${deckScope ? " on" : ""}" data-scope="decks"
                    aria-pressed="${deckScope ? "true" : "false"}" ${strict ? "disabled" : ""}>Only these decks</button>
          </span>
        </div>
        <datalist id="ankiDeckList"></datalist>
        ${deckScope ? `
        <!-- The box does two jobs, and both are worth having. It filters the tree below as you
             type, which is the fast way through a big collection — and ➕ still adds whatever is
             in it verbatim, which is the only way to name a deck while Anki is closed and the
             tree has nothing to show. -->
        <div class="srow sub kid deckrow">
          <input class="input grow" id="ankiDeckInput" placeholder="Find a deck, or type a name" style="min-width:150px" ${strict ? "disabled" : ""}/>
          <button class="btn sec" id="ankiDeckLoad" title="Read your deck list from Anki again">⬇ Load</button>
          <button class="btn" id="ankiDeckAdd" ${strict ? "disabled" : ""} title="Add the name typed on the left">➕</button>
        </div>
        <div class="decktree" id="deckTreeWrap">${deckTreeHtml(pickedDecks, strict)}</div>
        <!-- What you have picked, in the order you put them in. Draggable — this is your list,
             unlike the tree above it, which is Anki's and is shown in Anki's order.
             Be clear about what the order does: nothing, to the rule. Decks are matched by
             prefix, so which one is first changes no decision. It is for reading — your main
             deck first — and it is real state, kept in ankiDecks and remembered. -->
        ${pickedDecks.length
          ? `<div class="srow sub kid deckrow chiprow" id="deckChips">${pickedDecks.map(d => `<span class="chip drag" draggable="true" tabindex="0" data-deck-chip="${escHtml(d)}" title="Drag to reorder, or hold Alt and press ← →"><span class="grip" aria-hidden="true"></span>${escHtml(d)}<span class="x" data-deck-del="${escHtml(d)}" title="Remove" aria-label="Remove ${escHtml(d)}">✕</span></span>`).join("")}</div>`
          : `<div class="srow sub kid"><span class="lbl hint">Nothing picked yet, so every deck still counts. Tick one above.</span></div>`}` : ""}
      </div>

      <!-- No ✕ here. It set ankiEnabled to false and kept your goal time — which
           is exactly what clicking the Anki icon on the left already does, so it
           was a second control for one action, sitting in the corner where a ✕
           usually means "delete this permanently". -->
      <div class="cbody ${s.ankiEnabled === false ? "locked" : ""}" id="ankiBody" ${ankiOpen ? "" : "hidden"}>

      <!-- 1. Is Anki actually the app in front? -->
      ${ankiSect("win", "🖥️", "Anki window", [s.ankiRequireForeground !== false, s.ankiTimerWindow !== false].filter(Boolean).length, `
        <div class="srow sub">
          <span class="ic">🖥️</span>
          <span class="lbl grow">Full screen forcer ${tip(`The strictest check there is: time counts <b>only while the Anki window is the one you're clicked into and it fills the whole screen</b>. Switch to Explorer, a game, your browser, anything — the clock stops instantly.<br/><br/><b>Full screen means full screen.</b> Maximise Anki (or press <span class='kbd'>F11</span>). Even a thin strip of desktop or another window showing beside it pauses the clock.<br/><br/>Windows never tells a browser extension which app is in front, so Anki has to say so itself — that's what the <b>⬇ Add-on</b> button above this folder installs. Until it's in, Anki time stays paused with a reminder.<br/><br/>The add-on only ever reports window state: focused, full screen, on the review screen. No card content, and nothing leaves your computer.`)}</span>
          ${sw("ankiFg", s.ankiRequireForeground !== false, strict, "Full screen forcer")}
        </div>
        <div class="srow sub">
          <span class="ic">⏱️</span>
          <span class="lbl grow">Floating timer over Anki ${tip("A small window that sits <b>on top of Anki</b> and shows the clock: time done, time left, and why it has stopped when it has.<br/><br/>Anki runs full screen, so without this there is nothing on screen while you study telling you whether your time is actually counting.<br/><br/><b>Separate from the camera.</b> With the camera on, the same window shows your face as well. With it off, you get just the clock — this used to disappear along with the camera, which is why you saw nothing.<br/><br/>Drag it anywhere; the strip is the handle.<br/><br/><b>You can't close it while you're in Anki.</b> The add-on takes the <b>✕</b>, <b>−</b> and <b>□</b> off its title bar for as long as Anki is the app in front — there's no button to press, so there's nothing to decide. Alt+F4 goes with them.<br/><br/><b>Switch to any other app and it steps aside</b> — it doesn't sit on top of your browser telling you to switch to Anki. It comes back, in the same place, the moment Anki is in front again, even if you're on a break.<br/><br/>Needs the add-on, <b>v" + escHtml(ANKI_ADDON_VERSION) + "</b>, and Windows. Without it the extension falls back to putting a fresh window straight back up when you press ✕ — same rule, but you see it blink.<br/><br/>Need it gone while you're still in Anki? Take a break with ⏸ in the toolbar popup, then close it — or switch this off.")}</span>
          ${sw("ankiTimerWin", s.ankiTimerWindow !== false, strict, "Floating timer over Anki")}
        </div>`)}

      <!-- 2. Is it really you sitting there? -->
      ${ankiSect("cam", "📷", "Camera", [camOn, !!s.ankiEyeRequired, !!s.ankiBlinkRequired, s.ankiLivenessEnabled !== false, !!s.camOverlayEnabled, s.ankiPaceEnabled === true].filter(Boolean).length, `
        <div class="srow sub">
          <span class="ic">🪟</span>
          <span class="lbl grow">Camera on while I study Anki ${tip("One switch for the whole camera side of this:<br/><br/>• the little camera window opens by itself the moment Anki comes to the front, and the add-on pins it above Anki<br/>• time only counts while the camera can <b>see your face</b><br/><br/>Close the window whenever you like — it comes back next time you switch away from Anki and back. Your video never leaves this computer.")}</span>
          ${sw("ankiAutoCam", camOn, strict, "Camera on while I study Anki")}
        </div>
        <!-- Every sub-option row ships hidden and is revealed by syncKidRows off the switch
             above it. See ANKI_KIDS: one table, so the markup can't disagree with it. -->
        <div class="srow sub kid" id="faceSensRow" hidden>
          <span class="ic">🎚️</span>
          <span class="lbl grow">Face sensitivity ${tip("<b>What counts as you being there.</b> Each step accepts one weaker kind of evidence, so slide right if the timer keeps stopping while you <b>are</b> sitting and working.<br/><br/><b>strict</b> — upright and facing the camera, nothing else.<br/><b>firm</b> — a <b>tilted head</b> counts too.<br/><b>normal</b> — and your <b>head down</b> over a notebook, for as long as the picture keeps changing.<br/><b>kind</b> — and simply <b>being in the chair</b>, in any position, even completely still.<br/><b>easy</b> — the same, far more patient before it decides you've gone.<br/><br/>The bottom two work by learning what your room looks like <b>empty</b> — which it can only do once you've left it — and treating a picture that no longer matches as somebody sitting there. Until it has seen the room empty it falls back on waiting instead.<br/><br/><b>Leaving the chair stops the clock at every setting, including easy.</b> The camera keeps the picture as it was the last time your face was in it, and getting up changes most of that picture at once — your head, shoulders and arms all go, and the wall behind you arrives. Your head bent over a notebook changes only a small part of it. That difference is what separates a posture from an absence, and it is noticed within a fraction of a second, not waited out.<br/><br/>There is also a limit on how long any of these will carry you with <b>no face visible at all</b>, as a backstop for when that comparison has nothing to work with: about <b>1 minute</b> on normal, <b>2½</b> on kind, <b>7</b> on easy. One glance up at the screen starts it over.<br/><br/>Whenever one of these is carrying you rather than a real face, the <b>eye and blink checks pause</b>: there are no pupils to read from a scalp. On <b>kind</b> and <b>easy</b> the movement check pauses too, since sitting still is the whole point of them. Stay on <b>firm</b> or <b>normal</b> if you want those to keep applying.")}</span>
          <span class="sens">
            <span class="sensend" aria-hidden="true">strict</span>
            <input type="range" id="faceSens" min="1" max="5" step="1" value="${faceSens}"
                   aria-label="Face detection sensitivity, 1 strict to 5 forgiving"/>
            <span class="sensend" aria-hidden="true">easy</span>
            <b class="sensval" id="faceSensVal">${sensWord[faceSens]}</b>
          </span>
        </div>
        <div class="srow sub">
          <span class="ic">👁️</span>
          <span class="lbl grow">Eye detection ${tip("Stricter than seeing your face: your <b>eyes must be open and pointed at the screen</b>.<br/><br/><b>How long you may look away</b> is the number beside it. Look back at any point and you have the full time again; spend the whole time not looking at the screen and the clock waits until you do. So a blink, a glance at your keyboard or a look out of the window costs nothing.<br/><br/>It works on the picture the camera already has: in each eye it measures how dark the pupil is against the eyelid, and where that dark spot sits. Shut eyelids flatten the difference; looking away pushes the spot to an edge.<br/><br/>Needs the camera switch above. It's a webcam heuristic, not lab gaze tracking — it catches shut eyes and looking away, not a glance at the corner of the screen.")}</span>
          <span class="timeset plain">
            <span class="gicon" aria-hidden="true">⏳</span>
            <label class="tfld">
              <input class="input" id="eyeAway" type="number" min="0" max="600" value="${num(s.eyeAwaySec, 10)}"
                     title="How long you may look away, in seconds (0 to 600)"
                     aria-label="How long you may look away, in seconds"/>
              <i>s</i>
            </label>
          </span>
          ${sw("ankiEyeReq", !!s.ankiEyeRequired, strict, "Eye detection")}
        </div>
        <div class="srow sub kid" id="eyeSensRow" hidden>
          <span class="ic">🎯</span>
          <span class="lbl grow">Eye sensitivity ${tip("<b>How fussy the eye check is.</b> Slide <b>left</b> to catch even a small glance away — barely leaving the middle of the screen is enough to count as looking off it.<br/><br/>Slide <b>right</b> if it stops while you <i>are</i> reading a card: glasses, dim light or a low camera angle all make pupils harder to see. Then only obvious looking away counts.<br/><br/>This is about <b>what</b> counts as looking away. <b>How long</b> you may look away for is the seconds box on the row above.")}</span>
          <span class="sens">
            <span class="sensend" aria-hidden="true">fussy</span>
            <input type="range" id="eyeSens" min="1" max="5" step="1" value="${eyeSens}"
                   aria-label="Eye detection sensitivity, 1 fussy to 5 easy"/>
            <span class="sensend" aria-hidden="true">easy</span>
            <b class="sensval" id="eyeSensVal">${eyeWord[eyeSens]}</b>
          </span>
        </div>
        <div class="srow sub">
          <span class="ic">🙂</span>
          <span class="lbl grow">Head movement check ${tip("<b>How long you may sit perfectly still.</b> Go this long without moving and the clock waits until you do. A photo propped in front of the lens never moves, so this blocks the photo trick.<br/><br/>The deadline slides forward every time you move, so if you're working normally you will never see it. At <b>5s</b>: move at 3s and you have until 8s; move again at 7s and you have until 12s.<br/><br/><b>Any</b> movement counts — a nod, a shift in your seat, leaning nearer or further. Nothing is ever demanded of you on a schedule; this only notices stillness.<br/><br/>Anything from <b>0</b> to <b>1800</b> seconds. <b>0</b> means the clock only counts while you are actually moving. It saves itself as you type.")}</span>
          <span class="timeset plain">
            <span class="gicon" aria-hidden="true">⏳</span>
            <label class="tfld">
              <input class="input" id="liveInterval" type="number" min="0" max="1800" value="${num(s.livenessIntervalSec, 10)}"
                     title="How often it asks, in seconds (0 to 1800; 0 asks constantly)"
                     aria-label="How often it asks, in seconds, from 0 to 1800"/>
              <i>s</i>
            </label>
          </span>
          ${sw("ankiLive", s.ankiLivenessEnabled !== false, strict, "Head-movement check")}
        </div>
        <!-- Directly under the check it belongs to. It was below the blink row for a moment,
             which made it read as the blink check's dial — these sensitivity rows are indented
             children of the switch above them, so the order IS the labelling. -->
        <div class="srow sub kid" id="moveSensRow" hidden>
          <span class="ic">🎚️</span>
          <span class="lbl grow">Movement sensitivity ${tip("<b>How much counts as moving.</b> Slide right if the clock keeps waiting on you while you're sitting there working normally — small shifts and a nod will then be enough.<br/><br/>Slide left to demand a real change of position. Stricter is harder for a photograph being jiggled by hand to fake, but it also asks more of you.")}</span>
          <span class="sens">
            <span class="sensend" aria-hidden="true">strict</span>
            <input type="range" id="moveSens" min="1" max="5" step="1" value="${moveSens}"
                   aria-label="Movement sensitivity, 1 strict to 5 forgiving"/>
            <span class="sensend" aria-hidden="true">easy</span>
            <b class="sensval" id="moveSensVal">${moveWord[moveSens]}</b>
          </span>
        </div>
        <div class="srow sub">
          <span class="ic">😉</span>
          <span class="lbl grow">Blink check ${tip("<b>How long you may go without blinking.</b> Blink at any point and you have the full time again; go the whole time without one and the clock waits until you do.<br/><br/>This is the strongest proof the camera can get that a real person is sitting there. A photo can't blink at all, and a looping video blinks on a schedule — head movement can be faked by nudging a photo, but nothing short of a real face does this.<br/><br/>It only counts a proper blink: eyes closing <b>and opening again</b> soon after. Closing them and leaving them closed is what falling asleep looks like, so that doesn't count.<br/><br/>Needs the camera switch above. If your blinks aren't being caught, the <b>Blink sensitivity</b> dial below tunes it.")}</span>
          <span class="timeset plain">
            <span class="gicon" aria-hidden="true">⏳</span>
            <label class="tfld">
              <input class="input" id="blinkEvery" type="number" min="0" max="600" value="${num(s.blinkIntervalSec, 10)}"
                     title="Blink at least this often, in seconds (0 to 600)"
                     aria-label="Blink at least this often, in seconds"/>
              <i>s</i>
            </label>
          </span>
          ${sw("ankiBlink", !!s.ankiBlinkRequired, strict, "Blink check")}
        </div>
        <div class="srow sub kid" id="blinkSensRow" hidden>
          <span class="ic">🎚️</span>
          <span class="lbl grow">Blink sensitivity ${tip("<b>How much of a dip counts as an eyelid.</b> Slide right if your blinks aren't being noticed — glasses, dim light, deep-set eyes or a camera looking up at you all flatten the difference between an open eye and a closed one.<br/><br/>Slide left if something other than a blink is satisfying it.<br/><br/>It doesn't use a fixed brightness: it learns what <b>your</b> eyes look like open, in the light you're actually in, and watches for a drop from that. So it adapts to your setup rather than needing you to match a number.")}</span>
          <span class="sens">
            <span class="sensend" aria-hidden="true">clear</span>
            <input type="range" id="blinkSens" min="1" max="5" step="1" value="${blinkSens}"
                   aria-label="Blink sensitivity, 1 needs a clear blink to 5 catches a flicker"/>
            <span class="sensend" aria-hidden="true">faint</span>
            <b class="sensval" id="blinkSensVal">${blinkWord[blinkSens]}</b>
          </span>
        </div>
        <div class="srow sub">
          <span class="ic">🖍️</span>
          <span class="lbl grow">Draw what it can see ${tip("Draws a box round the face it found and a dot on each eye, live on the camera picture.<br/><br/>Useful while you're aiming the camera or working out why the clock keeps stopping. Turn it off once it's set up and the preview stays clean.")}</span>
          <!-- Read truthily, never as "not equal to false": this ships OFF, so an absent key has
               to mean off here too, or the switch would draw itself on for a profile where the
               camera window, reading the same absence, draws nothing. -->
          ${sw("ankiOverlay", !!s.camOverlayEnabled, strict, "Draw what the camera can see")}
        </div>
        <!-- How big the camera window is. A slider rather than a pair of number boxes because the
             window has ONE degree of freedom — the width — and because this is a feeling rather than a
             figure: you find the size you want by moving something and watching the window move.
             Not a child row of anything, so it carries no "kid" class and no entry in ANKI_KIDS. It
             applies whenever the camera window exists, which includes the timer-only window that has
             no camera in it at all, so there is no parent switch for it to hide behind.
             (And no backticks in this comment, however much the word wants them: the whole block is
             inside a template literal, so one would end the string. It cost a syntax error to learn.)
             No strict-mode gate and no password on this one, unlike most of the page: the size of a
             window is not a rule about anything. A small camera is no easier to fool than a big one —
             the picture it judges is the same picture at the same resolution either way — so there is
             no stricter direction here to protect. -->
        <div class="srow sub">
          <span class="ic">📐</span>
          <span class="lbl grow">Camera window size ${tip("How wide the little always-on-top camera window is, in pixels. <b>Drag this and the window follows you live</b> — if it isn't open, it opens so you can see what you're choosing.<br/><br/>Only the width is yours to set. The height is always <b>the picture plus the clock strip</b>, worked out from the width and whatever shape your camera actually delivers, which is what keeps your face from being stretched at any size.<br/><br/>The same size can be set from the window itself: <b>drag the grip in its bottom-right corner</b>, or focus it and use the arrow keys. The <b>↺</b> button beside it goes back to the default.<br/><br/><b>120 px</b> is as small as it goes. Everything in the window scales with it, so at the low end the clock is small but still readable; below that it stops being worth looking at. Your computer may also refuse to make a window quite that narrow, in which case it simply stops where it stops.")}</span>
          <span class="sens">
            <span class="sensend" aria-hidden="true">small</span>
            <input type="range" id="camSize" min="120" max="700" step="2" value="${camW}"
                   aria-label="Camera window width in pixels, 120 to 700"/>
            <span class="sensend" aria-hidden="true">big</span>
            <b class="sensval" id="camSizeVal">${camW} px</b>
          </span>
        </div>
        <!-- The one switch in this whole page that can make the goal EASIER, so it says so out loud
             and it is classified as a loosening — see STRICTER in settings.js, where it is the only
             entry pointing the other way. -->
        <div class="srow sub">
          <span class="ic">⚡</span>
          <span class="lbl grow">Speed up the timer when I face the camera ${tip("<b>Optional, off by default.</b> Turn this on and a <b>dashed box appears in the middle of the camera picture</b>. Get your head into that box and the clock runs at the fast speed below; leave it and the clock runs at the slow one. The box is <b>green</b> while it counts and <b>amber</b> while it does not, so you never have to guess.<br/><br/>Your head has to be <b>as big as the box</b>, not merely somewhere inside it — so sitting back counts as out even if you are perfectly centred. That makes it a distance rule as much as a posture one, and the box's size is the setting that decides the distance: third row below.<br/><br/>The camera window also shows the multiplier beside the clock while this is running, and tells you which way to move — <b>come closer</b>, <b>move left</b> — whenever the box is amber.<br/><br/>And <b>Anki's own window glows amber</b> at the same time, so you don't have to be looking at the camera window to notice. That's the glow you already know: green when time starts counting, <b>red when it isn't counting at all</b>, amber for this — counting, but at the slow rate. Needs the add-on, <b>v3.7 or newer</b>, and the glow switch in the camera window's ⚙ menu.<br/><br/><b>This is the only setting here that can make your goal easier</b>, which is why it needs your password to turn on when the page is locked, and why strict mode will not let you switch it on mid-window. Everything else here only ever asks more of you.<br/><br/>It needs the camera on and a face it can find. With no face in frame the clock is stopped anyway, so there is nothing to speed up or slow down.<br/><br/>Three things stay on real seconds whatever this says: the per-card cap, the idle grace, and the extension's own clock. Only your goal's progress moves faster.")}</span>
          ${sw("ankiPace", s.ankiPaceEnabled === true, strict, "Speed up the timer when I face the camera")}
        </div>
        <!-- The two speeds. Children of the switch above, so they are only on screen when it is —
             syncKidRows does that off ANKI_KIDS. Sliders rather than boxes because these are a
             feeling rather than a figure: "worth it" is what you are choosing, and you find it by
             moving something and watching the number. -->
        <div class="srow sub kid" id="paceFastRow" hidden>
          <span class="ic">🚀</span>
          <span class="lbl grow">Head fills the box ${tip("How fast the clock runs while your head fills the dashed box on the camera picture. The box turns <b>green</b> the moment it counts.<br/><br/><b>2×</b> means a minute of sitting up straight is worth two minutes of your goal. <b>1×</b> means no reward at all, which is the same as leaving this feature off.<br/><br/>The camera window shows what it is doing right now, beside the clock.")}</span>
          <span class="sens">
            <span class="sensend" aria-hidden="true">1×</span>
            <input type="range" id="paceFast" min="1" max="4" step="0.1" value="${paceFast}"
                   aria-label="How fast the clock runs while your face is inside the focus box"/>
            <span class="sensend" aria-hidden="true">4×</span>
          </span>
          <span class="gval" id="paceFastVal" role="status">${paceFast.toFixed(1)}×</span>
        </div>
        <div class="srow sub kid" id="paceSlowRow" hidden>
          <span class="ic">🐢</span>
          <span class="lbl grow">Head outside the box ${tip("How slowly the clock runs while your head is not filling the box — sitting too far back, off to one side, head tilted, or bent over the desk. The box stays <b>amber</b> while this is what is happening.<br/><br/><b>0.5×</b> means two minutes of slouching are worth one minute of your goal. <b>1×</b> means no penalty at all — only the reward above applies.<br/><br/>This never stops the clock. Losing your face entirely does that, and it is a separate thing.")}</span>
          <span class="sens">
            <span class="sensend" aria-hidden="true">0.1×</span>
            <input type="range" id="paceSlow" min="0.1" max="1" step="0.1" value="${paceSlow}"
                   aria-label="How slowly the clock runs while your face is outside the focus box"/>
            <span class="sensend" aria-hidden="true">1×</span>
          </span>
          <span class="gval" id="paceSlowVal" role="status">${paceSlow.toFixed(1)}×</span>
        </div>
        <!-- How big the box is. Third of the three children, because it is the one you set once during
             setup and then leave, where the two speeds are the thing you come back and adjust. -->
        <div class="srow sub kid" id="paceBoxRow" hidden>
          <span class="ic">🔲</span>
          <span class="lbl grow">Focus box size ${tip("How big the dashed box on the camera picture is, as a share of the picture's shorter side.<br/><br/>This is really a <b>distance</b> setting. Your head has to span the box, so a <b>bigger</b> box means sitting <b>closer</b> to earn the fast speed, and a smaller one lets you sit further back. Open the camera window while you drag this — the box follows the slider live, so you can pick the size at the distance you actually sit.<br/><br/>Because a bigger box asks more of you, <b>making it smaller</b> is the change that needs your password when the page is locked, and strict mode will not allow it mid-window.")}</span>
          <span class="sens">
            <span class="sensend" aria-hidden="true">small</span>
            <input type="range" id="paceBox" min="30" max="85" step="5" value="${paceBox}"
                   aria-label="How big the focus box is, as a percent of the camera picture"/>
            <span class="sensend" aria-hidden="true">big</span>
          </span>
          <span class="gval" id="paceBoxVal" role="status">${paceBox}%</span>
        </div>`)}

      <!-- 3. Is the studying itself real? -->
      ${ankiSect("cards", "🃏", "Cards &amp; decks", [!!s.ankiActiveGrading, s.ankiInactivityPauseEnabled === true, !!s.ankiMediaRequired, !!s.ankiMediaRequired && s.ankiMediaPauseEnabled !== false, !!s.ankiMediaRequired && s.ankiMediaPauseEnabled !== false && s.ankiMediaResumeEnabled !== false, !!s.ankiAntiSpamEnabled, !!s.ankiMinCardsEnabled, !!s.ankiMinCardsEnabled && !!s.ankiUniqueOnly].filter(Boolean).length, `
        <div class="srow sub">
          <span class="ic">⏱️</span>
          <span class="lbl grow">Only count while I'm answering cards ${tip("<b>Optional.</b> Off by default: with the add-on watching the Anki window and the camera watching you, any time in Anki counts — deck list, stats, a finished deck, anything.<br/><br/>Switch it on if only reviewing should count: then a card must be open on the review screen and answers must keep arriving.<br/><br/><b>Max/card</b> = the most seconds one single card can be worth (stops you parking on one card).<br/><b>Pause after</b> = seconds with no answer before it pauses. Without the add-on this is also the most that can slip through when you switch to another app, so keep it small — 15 to 30.")}</span>
          <!-- Not disabled during a strict window any more, here or on the three boxes below it.
               Both of these have a stricter direction — a smaller max/card and a shorter pause both
               ask more of you — and commitAnki now judges each box by direction rather than dropping
               the whole group. Disabling them refused the tightening direction too, which is the one
               strict mode is for. -->
          <label class="numfld"><input class="input mini" id="ankiCap" type="number" min="5" max="600" value="${s.ankiPerCardCapSec || 60}" title="Max seconds one card can be worth"/><i>max/card</i></label>
          <label class="numfld"><input class="input mini" id="ankiGrace" type="number" min="5" max="60" value="${Math.min(60, s.ankiIdleGraceSec || 30)}" title="Pause after this many seconds with no answer"/><i>pause after</i></label>
          ${sw("ankiActive", !!s.ankiActiveGrading, strict, "Only count with a card open")}
        </div>
        <div class="srow sub">
          <span class="ic">🖱️</span>
          <span class="lbl grow">Mouse cursor inactivity tracker ${tip("<b>Optional, off by default.</b> If you don't touch the mouse or the keyboard for a while, <b>the clock stops.</b> Touch anything and it starts again — there is nothing to dismiss.<br/><br/>This is the \"leave Anki open on a card and walk away\" trick, and it is the one the check above cannot catch: <b>Only count while I'm answering cards</b> waits for an <i>answer</i>, so it has to be patient with a long card you are genuinely still reading. This one waits for a <i>hand</i>, so reading with your finger on the mouse is not stillness at all and it can afford to be strict.<br/><br/>The number is how many seconds of complete stillness before it pauses. <b>30</b> is long enough that thinking about a card is never punished and short enough that a cup of tea is.<br/><br/><b>One exception.</b> While the card's own video is playing <i>and</i> the camera check is on <i>and</i> the camera can see you, sitting still is watching, so this stands aside. Both halves are needed: a video playing on its own is something you could start and then walk away from.<br/><br/>Needs the Anki add-on, <b>v" + escHtml(ANKI_ADDON_VERSION) + "</b>, and <b>Windows</b>. The reading comes from the operating system — Chrome cannot watch a desktop app — so on any other platform the add-on reports \"can't tell\" and this check stands aside rather than stopping your clock on a measurement nobody took.")}</span>
          <!-- Not disabled during a strict window, for the same reason as the two boxes above:
               a SMALLER number here is the stricter direction, and commitAnki judges this box by
               direction. Freezing it would refuse the tightening as well as the loosening. -->
          <label class="numfld"><input class="input mini" id="ankiStillSec" type="number" min="5" max="600" value="${Math.max(5, Math.min(600, num(s.ankiInactivityTimeoutSec, 30)))}" title="Seconds of stillness before the clock pauses"/><i>still for</i></label>
          ${sw("ankiStill", s.ankiInactivityPauseEnabled === true, strict, "Mouse cursor inactivity tracker")}
        </div>
        <div class="srow sub">
          <span class="ic">🎬</span>
          <span class="lbl grow">Media playback tracker ${tip("<b>Optional, off by default.</b> On a card that carries a video, the clock only runs <b>while that video is actually playing</b> — staring at a paused first frame earns nothing. Press play and it counts; pause it and it stops.<br/><br/>Cards with <b>no</b> video behave exactly as before, so a normal collection is unaffected. Move to a card without video and the clock starts again straight away.<br/><br/>Needs the Anki add-on, <b>version 2.1 or newer</b> — press ⬇ Add-on above if the version beside “Anki app” is older.<br/><br/><b>What it can and can't see.</b> A <code>video</code> or <code>audio</code> in your field: read directly, reliable. A <b>YouTube embed</b>: read by asking the player, which usually works. <b>Any other video site</b> (Vimeo, Drive, Twitch, and the rest): it can tell there's a video but not whether it's playing.<br/><br/>When it can't tell, it <b>lets the time count</b> rather than stopping it. Otherwise one unreadable embed would freeze your clock on that card for ever and today's goal could never be finished. The camera window says <i>“couldn't check this card's media”</i> when that happens, so you're never guessing.<br/><br/><code>[sound:...]</code> audio isn't gated — Anki plays those itself, usually automatically, so there's no “didn't press play” to catch.")}</span>
          ${sw("ankiMedia", !!s.ankiMediaRequired, strict, "Media playback tracker")}
        </div>
        <!-- Sub-options of Media playback tracker: only shown when ankiMedia is on.
             mediaResumeRow is a child of mediaPauseRow and also requires ankiMediaPause to be on. -->
        <div class="srow sub kid" id="mediaPauseRow" hidden>
          <span class="ic">⏸️</span>
          <label class="numfld"><input class="input mini" id="ankiMediaBack" type="number" min="0" max="120" value="${num(s.ankiMediaRewindSec, 5)}" title="Seconds to wind the video back when it pauses"/><i>sec back</i></label>
          <span class="lbl grow">Pause the video when the clock stops ${tip("<b>On by default.</b> Whenever your time stops counting — your face left the camera, Anki stopped being the window in front, you took a break, the wrong deck is open — whatever is playing on the card is <b>paused too</b>.<br/><br/>Without this, getting up from the desk left the clock correctly frozen and the lecture running on to an empty chair. You come back to a video twenty minutes further along and a timer that hasn't moved. The minutes you can earn back; the part of the video that went past, you can't.<br/><br/>It's <b>not a fight.</b> It asks a few times and then stops, so if you press play again on purpose it leaves you alone. And with the row below on, you don't have to: once everything's in order again the video carries on by itself.<br/><br/>Reaches a <code>video</code> or <code>audio</code> in your field, and <b>YouTube embeds</b>. Other video sites (Vimeo, Drive, Twitch) can't be controlled from outside, the same limitation the check above has.<br/><br/>Nothing happens once today's goal is finished — the gate has been satisfied and your media is your business.<br/><br/><b>sec back</b> = how far the video is wound back as it pauses. The last few seconds before you looked away were played, not taken in, so resuming exactly where it stopped means resuming into a gap. <b>5</b> is about one sentence of a lecture. Set it to <b>0</b> to pause where it is and not move.<br/><br/>You can flip this switch from the camera window too — it's the fourth disc in the ⚙ menu, which is where you are when it matters. Needs the Anki add-on: <b>v3.6 or newer</b> for the winding back, which only worked once per video before that.")}</span>
          ${sw("ankiMediaPause", s.ankiMediaPauseEnabled !== false, strict, "Pause the video when the clock stops")}
        </div>
        <div class="srow sub kid" id="mediaResumeRow" hidden>
          <span class="ic">▶️</span>
          <span class="lbl grow">Auto resume ${tip("<b>On by default.</b> The other half of the switch above. Sit back down — face in frame, Anki in front, break over — and the video <b>carries on by itself</b>, from the few seconds back it was wound to.<br/><br/>Only ever restarts what this extension paused. A video you paused yourself, or one on the card you never started, is left alone. And the moment you press play on something, it stops being ours — so pausing it again afterwards sticks.<br/><br/>It waits for <b>every</b> condition, not just the one that stopped you. If your face is back but you're on the wrong deck, nothing plays: a video running while the clock is stopped is the exact thing the pause exists to prevent.<br/><br/>Turning this off is not a shortcut and turning it on is not a loophole — the clock would already be running at the moment it fires, so all it saves you is the click. That's why it doesn't ask for your password either way.<br/><br/>Your browser can refuse to start a video that has had no click since it paused. If that happens the video simply stays paused and you press play, as before. Needs the Anki add-on, <b>v3.6 or newer</b>.")}</span>
          ${sw("ankiMediaResume", s.ankiMediaResumeEnabled !== false, strict, "Auto resume")}
        </div>
        <div class="srow sub">
          <span class="ic">🚫</span>
          <span class="lbl grow">Ignore super-fast answers ${tip("If you hold down the answer key or use a macro to blast through cards, those cards <b>don't count</b>.<br/><br/>The number is the fewest seconds a real answer should take.")}</span>
          <label class="numfld"><input class="input mini" id="ankiMinSec" type="number" min="0.2" max="30" step="0.1" value="${s.ankiMinSecPerCard || 1}" title="Fewest seconds a real answer takes"/><i>min secs</i></label>
          <!-- Read truthily, like the overlay switch above and for the same reason: it ships off,
               and the worker's own anti-spam check in pollAnkiOnce reads it truthily too, so
               anything looser here would be the switch and the rule disagreeing. -->
          ${sw("ankiSpam", !!s.ankiAntiSpamEnabled, strict, "Ignore answers that arrive too fast")}
        </div>
        <div class="srow sub">
          <span class="ic">🔢</span>
          <span class="lbl grow">Also need this many cards ${tip("On top of the time, you must review at least this many cards today.<br/><br/>Stops you sitting on one card to run the clock. The sites in step 2 stay locked until <b>both</b> the time and the card count are done.")}</span>
          <label class="numfld"><input class="input mini" id="ankiMinCards" type="number" min="1" max="9999" value="${s.ankiMinCards || 20}" title="Cards needed today"/><i>cards</i></label>
          ${sw("ankiMinCardsEn", !!s.ankiMinCardsEnabled, strict, "Also require a number of cards")}
        </div>
        <div class="srow sub kid" id="uniqRow" hidden>
          <span class="ic">🔁</span>
          <span class="lbl grow">Count each card only once ${tip("Without this, the count above counts <b>answers</b> — so pressing <b>Again</b> on one card twenty times fills a twenty-card quota. It is the easiest way there is to fake that number.<br/><br/>Switch it on and a card counts once however often you see it today: twenty cards means twenty <b>different</b> cards.<br/><br/>Needs the Anki add-on, <b>v${escHtml(ANKI_ADDON_VERSION)}</b> — the version this extension ships. Only Anki knows which cards those answers belonged to. Press <b>⬇ Add-on</b> above if the version beside “Anki app” is older. Until it's in, the card count isn't checked at all, and this card says so rather than quietly counting answers again.")}</span>
          <span class="gval" id="ankiUniqVal" role="status"></span>
          ${sw("ankiUniqueOnly", !!s.ankiUniqueOnly, strict, "Count each card only once")}
        </div>
        <!-- "Only these decks count" used to be here, as a switch plus a deck picker. It is the
             What counts choice at the top of this card now — one control, one set of ids, in the
             place people go looking for it. Nothing is duplicated: both wrote
             ankiDeckRestrictEnabled, and two controls for one key is two things to keep in
             agreement for no gain. -->`)}

      <!-- 4. More things that have to be FINISHED, not more checks on the clock. -->
      ${ankiSect("goals", "🎯", "Also needed to unlock", [!!s.ankiDueGateEnabled, !!s.ankiRetentionEnabled, !!s.ankiDeckTimeEnabled].filter(Boolean).length, `
        <!-- Filled by paintGateVals when a gate is switched on but cannot be
             measured. It has to be said out loud: an unmeasurable gate stands aside
             rather than blocking, so silence here would mean a check the user
             believes is running while it isn't. -->
        <div class="srow sub gwarn" id="ankiGateWarn" hidden></div>
        <div class="srow sub">
          <span class="ic">📥</span>
          <span class="lbl grow">Clear today's due cards ${tip("The sites stay locked until Anki has <b>nothing left waiting</b> for you today — not just until the clock runs out.<br/><br/><b>Your daily limits are respected.</b> The number comes from Anki's own deck list, the same one you see when you open it. So a 500-card backlog behind a 100-a-day limit counts as done once those 100 are done. It is never a goal you cannot reach.<br/><br/><b>New cards don't count.</b> Starting new material is a choice, not a debt — this is about the cards Anki is asking you to come back to.<br/><br/><b>may wait</b> is how many are allowed to still be there. Leave it at 0 for a clean slate. Raise it to 2 or 3 if you don't want to sit and wait out a card on a ten-minute learning step.<br/><br/>Only the decks in <b>Cards &amp; decks → Only these decks' due</b> below. Needs the add-on, <b>v${escHtml(ANKI_ADDON_VERSION)}</b>.")}</span>
          <span class="gval" id="ankiDueVal" role="status"></span>
          <label class="numfld"><input class="input mini" id="ankiDueAllow" type="number" min="0" max="999" value="${num(s.ankiDueAllowed)}" title="How many cards may still be waiting"/><i>may wait</i></label>
          ${sw("ankiDueEn", !!s.ankiDueGateEnabled, strict, "Clear today's due cards")}
        </div>
        <div class="srow sub kid" id="dueDeckRow" hidden>
          <span class="ic">🎯</span>
          <span class="lbl grow">Only these decks' due ${tip("Leave this empty and the gate watches your <b>whole collection</b> — the same total Anki shows at the bottom of its deck list.<br/><br/>Add a deck and it watches <b>only that deck</b>. This is the setting for “I only care about clearing my <b>Backlog</b> deck; the rest can wait.”<br/><br/><b>This is its own list, on purpose.</b> It is not the same as <b>Cards &amp; decks → Only these decks count</b>. That one decides which reviews <i>earn you time</i>; this one decides <i>whose backlog must reach zero</i>. So you can earn your time anywhere in your collection and still be held until one particular deck is clear — which is the whole reason they are separate.<br/><br/>Subdecks are included: <span class='kbd'>Backlog</span> covers <span class='kbd'>Backlog::Week 1</span>.<br/><br/>Press <b>⬇ Load</b> to fetch your deck names, then type and press <b>➕</b>.")}</span>
          <input class="input grow" id="ankiDueDeckInput" list="ankiDeckList" placeholder="All decks" style="min-width:120px" ${strict ? "disabled" : ""}/>
          <button class="btn sec" id="ankiDueDeckLoad" title="Load deck names from Anki">⬇ Load</button>
          <button class="btn" id="ankiDueDeckAdd" ${strict ? "disabled" : ""} title="Add deck">➕</button>
        </div>
        ${FGGates.dueDecks(s).length ? `<div class="srow sub kid deckrow" id="dueDeckChipRow" hidden>${FGGates.dueDecks(s).map(d => `<span class="chip">${escHtml(d)}<span class="x" data-duedeck-del="${escHtml(d)}" title="Remove" aria-label="Remove ${escHtml(d)}">✕</span></span>`).join("")}</div>` : ""}
        <div class="srow sub">
          <span class="ic">🎯</span>
          <span class="lbl grow">Get this much right ${tip("Answering isn't the same as knowing. This holds the sites shut until you're getting at least this share of your <b>review</b> cards right today.<br/><br/><b>It closes the Again-spam hole.</b> Pressing Again to rack up a card count now costs you the percentage, so blasting through cards can't finish the day any more.<br/><br/><b>New and learning cards are not counted.</b> Getting a card wrong the first time you ever see it is what learning <i>is</i> — counting those would mean a day of new material scored about 50% and could never pass. This is Anki's own “true retention”: review cards only.<br/><br/><b>You can always recover.</b> The share is over today, so answering more cards correctly pulls it back up. A bad session in the morning never locks the whole day.<br/><br/>It waits for ${FGGates.RETENTION_MIN_SAMPLE} review answers before it counts for anything — two cards and one slip is not a signal. Needs the add-on, <b>v${escHtml(ANKI_ADDON_VERSION)}</b>.")}</span>
          <span class="gval" id="ankiRetVal" role="status"></span>
          <label class="numfld"><input class="input mini" id="ankiRetPct" type="number" min="1" max="100" value="${Math.max(1, Math.min(100, num(s.ankiMinRetention, 80)))}" title="Lowest share of review cards you must get right"/><i>% right</i></label>
          ${sw("ankiRetEn", !!s.ankiRetentionEnabled, strict, "Require a minimum share right")}
        </div>
        <div class="srow sub">
          <span class="ic">⏳</span>
          <span class="lbl grow">Time needed in each deck ${tip("A separate slice of time per deck, all of which must be done before the sites open.<br/><br/>The point: “an hour of Anki” can be an hour of the one deck you enjoy. Ask for <b>25m in Pharmacology</b> and <b>25m in Anatomy</b> and it can't be.<br/><br/>Time is filed under the deck the card you're answering came from, and a parent deck collects its subdecks — 10 minutes in <span class='kbd'>Bio::Ch1</span> counts towards a quota on <span class='kbd'>Bio</span>.<br/><br/>These are <b>on top of</b> the main goal above, not carved out of it, so keep them smaller than it or the total is what the quotas add up to.<br/><br/>This one needs no add-on update — it's the extension's own clock, so every check you've switched on already applies to it.")}</span>
          ${sw("ankiDeckTimeEn", !!s.ankiDeckTimeEnabled, strict, "Time needed in each deck")}
        </div>
        <div class="srow sub kid deckrow" id="dtAddRow" hidden>
          <input class="input grow" id="ankiDtInput" list="ankiDeckList" placeholder="Deck name" style="min-width:120px" ${strict ? "disabled" : ""}/>
          ${hmsWells(0, u => `id="ankiDt${u.toUpperCase()}"`, { plain: true, icon: false })}
          <button class="btn sec" id="ankiDtLoad" title="Load deck names from Anki">⬇ Load</button>
          <button class="btn" id="ankiDtAdd" ${strict ? "disabled" : ""} title="Add this deck quota">➕</button>
        </div>
        ${deckTimeListHtml(s, strict)}`)}

      <!-- 4b. WHEN it has to be finished. The only two settings here that can leave a finished goal
               locked, which is why they are their own folder and not more rows above. -->
      ${ankiSect("when", "⏰", "Finish it in time", [s.ankiWinEnabled === true, s.ankiGraceEnabled === true].filter(Boolean).length, `
        <div class="srow sub">
          <span class="ic">⏰</span>
          <span class="lbl grow">Finish between two times ${tip("A <b>deadline</b> for today's goal. Switch it on and finishing only unlocks your sites if the goal was reached <b>between these two times</b>.<br/><br/>Finish at 9:10 am on a window that shut at 9:00 am and your sites stay shut for the rest of the day. The day resets at your usual hour and you start again.<br/><br/><b>Time still counts outside the window.</b> The clock runs whenever you study and the bar fills as normal — what the window decides is whether that work <i>buys</i> anything, not whether it is recorded. A goal that refused to move outside its hours would read as broken rather than as strict.<br/><br/>Windows may cross midnight: <span class='kbd'>10:00 pm</span> to <span class='kbd'>2:00 am</span> is read as the late evening and the two hours after it. Start and end must differ — a window of zero length could never be satisfied, so it is ignored rather than treated as a locked door.<br/><br/><b>The YouTube video check only runs inside the window.</b> <b>🔤 Word detection</b> and <b>🤖 AI detection</b>, further down — the video checks and the search check — look at what you open only between these two times. Outside them YouTube and the search engines follow your lists like any other site: listed means shut, unlisted means open.<br/><br/>These boxes are <b>24-hour</b>. The line underneath says them back in am/pm so there is nothing to second-guess.<br/><br/>Switching this <b>on</b> adds a way to fail a day, so it goes through during a strict window. Switching it <b>off</b> is a loosening and asks for your password.")}</span>
          <span class="gval" id="ankiWinVal" role="status"></span>
          ${sw("ankiWinEn", s.ankiWinEnabled === true, strict, "Finish today's goal between two times")}
        </div>
        <div class="srow sub kid" id="winTimesRow" hidden>
          <span class="ic">🕒</span>
          <span class="lbl grow">Window</span>
          <!-- The clock button replaces the browser's own picker rather than sitting next to it: the
               native indicator is hidden in CSS for these two boxes, so there is one clock icon in the
               place you were already reaching for. The BOX is untouched — still type="time", so typing,
               the arrow keys and am/pm all work exactly as they did. The dial is another way in, not a
               replacement for the field. -->
          <!-- The arrows are tabindex="-1" on purpose. Tab should run box → clock → next box, not
               through four nudge buttons on the way — and a keyboard user does not need them at all,
               because a native time box already steps whichever segment is focused with the arrow
               KEYS, which is finer than these can be. So they are left out of the tab order rather
               than duplicating something better. -->
          <span class="wintime">
            <input class="input" id="ankiWinStart" type="time" value="${escHtml(FGGates.hhmm(s.ankiWinStart, "06:00"))}" style="width:110px" ${strict ? "disabled" : ""} aria-label="Window opens at"/>
            <span class="wspin">
              <button class="wstep" type="button" id="ankiWinStartUp" tabindex="-1" ${strict ? "disabled" : ""}
                      aria-label="Window opens ${WIN_STEP_MIN} minutes later"
                      title="${WIN_STEP_MIN} minutes later — hold to keep going">▲</button>
              <button class="wstep" type="button" id="ankiWinStartDown" tabindex="-1" ${strict ? "disabled" : ""}
                      aria-label="Window opens ${WIN_STEP_MIN} minutes earlier"
                      title="${WIN_STEP_MIN} minutes earlier — hold to keep going">▼</button>
            </span>
            <button class="wclock" type="button" id="ankiWinStartDial" ${strict ? "disabled" : ""}
                    aria-label="Window opens at — pick it on a clock face"
                    title="Pick it on a round clock instead">🕐</button>
          </span>
          <span class="lbl" style="flex:0 0 auto">to</span>
          <span class="wintime">
            <input class="input" id="ankiWinEnd" type="time" value="${escHtml(FGGates.hhmm(s.ankiWinEnd, "09:00"))}" style="width:110px" ${strict ? "disabled" : ""} aria-label="Window closes at"/>
            <span class="wspin">
              <button class="wstep" type="button" id="ankiWinEndUp" tabindex="-1" ${strict ? "disabled" : ""}
                      aria-label="Window closes ${WIN_STEP_MIN} minutes later"
                      title="${WIN_STEP_MIN} minutes later — hold to keep going">▲</button>
              <button class="wstep" type="button" id="ankiWinEndDown" tabindex="-1" ${strict ? "disabled" : ""}
                      aria-label="Window closes ${WIN_STEP_MIN} minutes earlier"
                      title="${WIN_STEP_MIN} minutes earlier — hold to keep going">▼</button>
            </span>
            <button class="wclock" type="button" id="ankiWinEndDial" ${strict ? "disabled" : ""}
                    aria-label="Window closes at — pick it on a clock face"
                    title="Pick it on a round clock instead">🕐</button>
          </span>
        </div>
        <!-- Said in words as well as shown in two boxes, because "23:30 to 00:15" is forty-five
             minutes and does not look like it — and because a 24-hour box is the one control on this
             page whose value can be read as a different time by somebody in a hurry. -->
        <div class="srow sub kid gwarn" id="winStateRow" hidden></div>
        <div class="srow sub">
          <span class="ic">⏳</span>
          <span class="lbl grow">Finish within a time limit ${tip("A <b>stopwatch</b>, started the first time Anki is open today. You get <b>the goal plus the grace time</b> to finish the goal in.<br/><br/>An hour of cards with ten minutes of grace means: from the moment Anki first opened today, seventy minutes to put sixty in. Miss it and today's goal unlocks nothing for the rest of the day, exactly like a missed window.<br/><br/><b>It starts when Anki opens, not when the clock starts running.</b> That is on purpose: an allowance that waited for the camera to find you, or for the first card to be graded, would be an allowance you could postpone by looking away.<br/><br/><b>Time still counts after it runs out.</b> The clock keeps going and the bar keeps filling. What the limit decides is whether finishing buys anything.<br/><br/>Raising the goal raises the limit with it — the limit <i>is</i> the goal plus your grace — so the <b>＋</b> in the camera window does not hand you a deadline you cannot meet.<br/><br/>It resets at your daily reset and <b>only</b> then. Pressing <b>↺ start today over</b> does not hand you a fresh allowance, because ↺ does not un-open Anki.<br/><br/>Switching this <b>on</b> adds a way to fail a day, so it goes through during a strict window. Switching it <b>off</b>, or adding grace, is a loosening and asks for your password.")}</span>
          <span class="gval" id="ankiGraceVal" role="status"></span>
          ${sw("ankiGraceEn", s.ankiGraceEnabled === true, strict, "Finish today's goal within a time limit")}
        </div>
        <div class="srow sub kid" id="graceMinRow" hidden>
          <span class="ic">⏱️</span>
          <!-- Minutes, not seconds. Seconds of grace is not a quantity anybody means, and a box that
               accepted them would invite a value nobody could read back off the row. -->
          <span class="lbl grow">Grace on top of the goal</span>
          <label class="numfld"><input class="input mini" id="ankiGraceMin" type="number" min="0" max="720" value="${Math.round(Math.max(0, Math.min(43200, num(s.ankiGraceSec, 600))) / 60)}" title="Minutes of slack on top of today's goal. 0 means exactly the goal and not a second more."/><i>min</i></label>
        </div>
        <div class="srow sub kid gwarn" id="graceStateRow" hidden></div>`)}

      <!-- 5. What you may do WHILE the goal is unfinished. Not another thing to finish.
           Three folders rather than one, because the two rules about videos are independent: the WORD
           check and the AI check can each be on without the other, and a video has to pass every one
           that is on. So each gets its own folder, and the rows that serve both — watch time and the
           two locks — get a third, rather than living inside either rule. -->
      ${ankiSect("words", "🔤", "Word detection", [s.searchGateEnabled === true, s.ytGateEnabled === true].filter(Boolean).length, `
        <div class="srow sub">
          <span class="ic">🔍</span>
          <span class="lbl grow">Searches about your card ${tip("<b>Look things up, but only about the card you are on.</b><br/><br/>The same idea as the word check on videos below, one surface over: the words are pulled out of the card in front of you, and a search goes through only if what you typed carries one of them. On a card reading <i>“Explain the concept of aliasing in the context of signal processing…”</i> the words are <b>aliasing</b>, <b>signal processing</b>, <b>sampling</b>, <b>signal</b> — so searching <i>“sampling theorem”</i> works, and <i>“ipl final highlights”</i> does not.<br/><br/><b>Covered engines:</b> Google, Bing, DuckDuckGo, Yahoo, Brave, Ecosia, Qwant, Startpage, Yandex, Mojeek and Perplexity — including their <b>Videos</b>, <b>Images</b> and <b>News</b> tabs. Any other site with a search box of its own is left alone.<br/><br/><b>A search engine's front page is never refused.</b> It carries no query, so there is nothing to judge — only what you actually type is checked.<br/><br/><b>This lets searches THROUGH — it does not block Google.</b> Like the video checks, it is asked <i>before</i> your lists, so a search about your card works even with <span class='kbd'>google.com</span> on your blocked list. One thing to know if you use <b>Allowlist</b> mode: the front page still needs to be on your allow list for you to open it and use its box. Searching from the <b>address bar</b> goes straight to the results and works either way.<br/><br/><b>No card open in Anki means no search at all.</b> If you are not on a card, nothing is being studied, so nothing is justified.<br/><br/><b>With a finish-by window set</b> (⏰ <i>Finish it in time</i>, above), this only runs inside that window, together with the video checks.<br/><br/><b>This one is words only — the AI check is for videos, not searches.</b> Nothing you type into a search box is ever sent anywhere. That has an honest cost: a real synonym your card never used gets refused — <i>“nyquist rate”</i> on a card about <i>aliasing</i> shares no word with it. Search using a word the card actually uses, or leave this off.<br/><br/>Needs the add-on, <b>v${escHtml(ANKI_ADDON_VERSION)}</b>, since the words come from the card Anki is showing.")}</span>
          ${sw("searchGate", s.searchGateEnabled === true, strict, "Only allow searches about the card you are on")}
        </div>
        <div class="srow sub kid" id="searchHitsRow" hidden>
          <span class="ic">🎯</span>
          <span class="lbl grow">Words a search must carry ${tip("How many of the card's words have to appear in what you type.<br/><br/><b>1</b> is almost always right, and more so here than for video titles: a search is three or four words, so asking for <b>2</b> would refuse <i>“aliasing explained”</i> — a query that is entirely on topic.<br/><br/>Raise it only for a deck of very general cards where one common word would let anything through.")}</span>
          <label class="numfld"><input class="input mini" id="searchHits" type="number" min="1" max="5" value="${Math.max(1, Math.min(5, num(s.searchGateMinHits, 1)))}" title="How many of the card's words the search must carry"/><i>words</i></label>
        </div>
        <div class="srow sub">
          <span class="ic">📺</span>
          <span class="lbl grow">Only videos whose title has this card's words ${tip("<b>YouTube, but only the video you are actually looking for.</b><br/><br/>The words that matter are pulled out of the card in front of you, and a video plays only if its <b>title</b> carries one of them. Move to the next card and the words change with it, so what you are allowed to watch follows what you are studying.<br/><br/>On a card reading <i>“Explain the concept of aliasing in the context of signal processing…”</i> the words are <b>aliasing</b>, <b>signal processing</b>, <b>sampling</b>, <b>signal</b> — so <i>“Interesting example of Aliasing”</i> opens, and a music video does not.<br/><br/><b>This lets videos THROUGH — it does not block YouTube.</b> Putting <span class='kbd'>youtube.com</span> on your blocked list below does <b>not</b> stop you watching study videos. This check is asked <i>first</i>, so a video about your card opens even though the site is blocked. The list only shuts the parts this check has no opinion about.<br/><br/>With <span class='kbd'>youtube.com</span> on your blocked list and this on, here is exactly what happens:<ul><li>A video whose title matches your card — <b>opens</b></li><li>Any other video — <b>blocked</b></li><li>YouTube <b>search</b> — <b>open</b>, so you can go and find the video</li><li>The <b>home feed</b>, <b>subscriptions</b> and <b>channel pages</b> — <b>blocked</b></li><li><b>Shorts</b> — <b>blocked</b>, always. It is one endless feed rather than a video, so a single matching title would hand over the lot.</li></ul>Leave <span class='kbd'>youtube.com</span> off your list and everything above still holds <i>except</i> the home feed and subscriptions, which stay open — which is the scrolling this is meant to save you from. That is the only reason to list it.<br/><br/><b>Switching this on allows <span class='kbd'>youtube.com</span> for you.</b> In <b>Allowlist</b> mode a site nobody listed is shut, and a rule about which videos you may watch is no use on a YouTube you can't open — search works, but the page with the search box on it is youtube.com. So the bare domain is added to your allowlist below, in either mode, so it's already right if you ever switch. Only the bare domain: <span class='kbd'>music.youtube.com</span> stays blocked. Remove the chip if you'd rather it wasn't there.<br/><br/><b>Every video card is covered, not just the player.</b> On the home feed, in search results, in the sidebar and the playlist panel, a video whose title doesn't match your card has its <b>thumbnail</b> replaced by a <b>BLOCKED</b> panel and won't open when clicked. Nothing else about the card changes — its <i>title, channel and view count stay exactly as YouTube drew them</i>. That's deliberate: the thumbnail is the part picked to make you click, the title is the part that tells you what the thing is, so you can still read the page without being sold it. The ones you can watch keep their picture and show the matching word highlighted. With <b>🤖 AI detection</b> on as well they still open normally when clicked — the AI never judges a thumbnail, so it checks the video once it's open.<br/><br/>Each covered thumbnail has a small <b>👁 eye</b> in its corner. Press it to look at the picture anyway, press it again to put the panel back. It only uncovers the image — the video still won't open, so it's for checking what something is, not for changing your mind.<br/><br/><b>Shorts are always covered</b>, whatever their titles say, since they can't be opened while this is on anyway.<br/><br/><b>No card open in Anki means no video at all.</b> If you are not on a card, nothing is being studied, so nothing is justified.<br/><br/><b>With a finish-by window set</b> (⏰ <i>Finish it in time</i>, above), this check only runs <b>inside that window</b>. Outside it, YouTube follows your lists like any other site.<br/><br/><b>On its own, or with the AI check.</b> This is one of two separate rules about videos; the other is <b>🤖 AI detection</b>, in its own folder below. Either can be on without the other. With both on, a video has to pass <b>both</b> — its title has to carry one of these words <i>and</i> the AI has to agree it's about your card — and only titles that pass this check are ever sent to the AI.<br/><br/>The <b>mini player</b> is covered too: a video playing in YouTube's small corner player is judged exactly like one on its own page, and held paused behind the same panel if it isn't about your card.<br/><br/>The words are worked out <b>on your own computer</b> — no card of yours is sent anywhere. The one exception is <b>🤖 AI detection</b> below, which is off unless you turn it on and says so plainly. Needs the add-on, <b>v${escHtml(ANKI_ADDON_VERSION)}</b>.")}</span>
          ${sw("ytGate", s.ytGateEnabled === true, strict, "Only allow videos whose title has the card's words")}
        </div>
        <div class="srow sub kid" id="ytHitsRow" hidden>
          <span class="ic">🎯</span>
          <span class="lbl grow">Words a title must carry ${tip("How many of the card's words have to appear in the video's title.<br/><br/><b>1</b> is right for almost everyone: a title is short, and one specific word like <i>aliasing</i> is already strong evidence.<br/><br/>Raise it to <b>2</b> for a deck of very general cards, where a single common word would match half of YouTube.")}</span>
          <label class="numfld"><input class="input mini" id="ytHits" type="number" min="1" max="5" value="${Math.max(1, Math.min(5, num(s.ytGateMinHits, 1)))}" title="How many of the card's words the title must carry"/><i>words</i></label>
        </div>
        <!-- The keywords themselves, live. This row is the difference between a rule you trust and
             one you argue with: when a video is refused, the first question is "what did it want?",
             and the answer is right here rather than being something to infer. Repainted by
             paintWatchRows on every storage change, so it follows the card you are on. In this folder
             because these words are the word check's and nothing else's — the AI check reads the whole
             front of the card, not this list. -->
        <div class="srow sub kid deckrow" id="ytKwRow" hidden>
          <span class="ic">🔑</span>
          <span class="lbl grow" style="flex:0 0 auto">This card's words</span>
          <span class="grow" id="ytKwChips" role="status" aria-live="polite"></span>
        </div>`)}

      ${ankiSect("ai", "🤖", "AI detection", [s.ytAiEnabled === true].filter(Boolean).length, `
        <!-- ---- the AI check ----
             A rule of its own, not a kid of the word check: with it on, a video plays only if the AI says
             it is about the card, whether or not the word check is on too — and with both on, a video has
             to pass both. Its rows below it — key, bar, depth, model — because a switch you have turned
             on with no key in the box holds every video back, and the box has to be right there. -->
        <div class="srow sub" id="ytAiRow">
          <span class="ic">🤖</span>
          <span class="lbl grow">Only videos the AI says are about this card ${tip("<b>An AI decides which videos are about your card.</b><br/><br/>Instead of looking for your card's words in a title, the AI reads the <b>whole front of the card</b> and compares it with what the video is actually about — its title, channel, description, tags and its own <b>subtitles</b>, as <b>How deeply to analyse</b> below says. A lecture called <i>“The Nyquist–Shannon sampling theorem”</i> opens on a card about <b>aliasing</b>; a music video with “aliasing” in its title does not. A Hindi lecture on an English card is judged on what it teaches, not on the language it is in.<br/><br/><b>What happens when you open a video:</b><ul><li>The video stays paused, and the <b>top-left corner of the player</b> shows the check as it happens: the <b>title</b>, then the <b>description</b>, the <b>tags</b> and the <b>subtitles</b> tick over one by one with a line of what was read, then the AI compares it all with your card. About a second for a title, a few seconds with the subtitles.</li><li>Its score reaches the bar you set below — it plays, and the corner says so for a moment.</li><li>It doesn't — the corner shows the AI's score against each of those parts for a moment, then the full cover goes up and says what the AI thought and why.</li></ul><b>Only the video you open — never a thumbnail.</b> On the home feed, in search results, in the sidebar and the playlist panel, the AI is <b>never asked</b> about a video you haven't opened: sixty questions just to scroll past a page would use up a day's allowance in minutes. So on its own this check <b>covers no thumbnail at all</b>: every card looks and opens exactly as YouTube made it, and the decision is made only once the video is open. The one thing held back is YouTube's <b>hover preview</b>, the video that starts playing when you rest the pointer on a thumbnail — that would be watching a video the AI hasn't checked, without ever opening it. A video opened in a <b>background tab</b> isn't checked either until you switch to it. <b>Shorts</b> still stay shut when you open one.<br/><br/><b>On its own, or with Word detection.</b> This is one of two separate rules about videos; the other is <b>🔤 Word detection</b> above. On its own, the AI decides every video you open. With both on, a video has to pass <b>both</b> — its title has to carry your card's words <i>and</i> the AI has to agree — and only titles that pass the words are ever sent to the AI. The thumbnails the words refuse are covered as usual; the rest open, and the AI checks each one once it's open.<br/><br/><b>You need your own free API key</b> for the service you pick under <b>Model</b> below: Gemini's from <span class='kbd'>aistudio.google.com/apikey</span>, Groq's from <span class='kbd'>console.groq.com/keys</span>. Paste it in the box below. It's stored on this computer, it is never put in a settings backup, and it is <b>never given to the YouTube page</b> — the request is made by the extension itself.<br/><br/><b>Read this before switching it on.</b> With this on, the front of the card you're reviewing is sent to that service — Google or Groq — every time you open a video it has to judge. That's a real change: with this off, and with everything else in this extension, <b>nothing about your cards ever leaves this machine</b>. Only the front of the card — up to about 2,000 characters, a long card's worth — only for a video you opened yourself, and only while your goal is unfinished. But it does leave. If that isn't a trade you want, leave this off and use Word detection, which never sends anything.<br/><br/><b>If anything goes wrong, the video stays covered.</b> No key, no internet, quota used up, the service having a bad day: until the AI can answer, it lets nothing through. It fails shut, never open.<br/><br/><b>No card open in Anki means no video at all</b>, and with a finish-by window set (⏰ <i>Finish it in time</i>, above) this only runs inside it. Like Word detection, switching it on adds <span class='kbd'>youtube.com</span> to your allowlist, so allowlist mode can't shut YouTube out from under it.<br/><br/>One question per video per card, cached, so re-opening the same video costs nothing.<br/><br/>Switching it <b>on</b> is free — it can only take videos away. Switching it <b>off</b> asks for your password and is refused during a strict window.")}</span>
          <span class="gval" id="ytAiVal" role="status" aria-live="polite"></span>
          ${sw("ytAi", s.ytAiEnabled === true, strict, "Only allow videos an AI judges to be about this card")}
        </div>
        <!-- One box, for whichever service is picked under Model. Each service keeps its OWN stored key
             — data-keyfor says which one this box is showing and which one saveAiKey writes — so moving
             from Gemini to Groq and back never loses the key you pasted for the other. Swapping the
             picker repaints the page, which is what swaps the box. -->
        <div class="srow sub kid" id="ytAiKeyRow" hidden>
          <span class="ic">🔑</span>
          ${aiProviderOfState(s) === "groq"
            ? `<input class="input grow" id="ytAiKey" data-keyfor="groq" type="password" spellcheck="false" autocomplete="off"
                 placeholder="Groq API key — free from console.groq.com/keys"
                 aria-label="Groq API key"
                 value="${escHtml(s.ytAiGroqKey || "")}"
                 ${editLocked ? "readonly style='cursor:pointer;'" : ""}/>`
            : `<input class="input grow" id="ytAiKey" data-keyfor="gemini" type="password" spellcheck="false" autocomplete="off"
                 placeholder="Gemini API key — free from aistudio.google.com/apikey"
                 aria-label="Gemini API key"
                 value="${escHtml(s.ytAiKey || "")}"
                 ${editLocked ? "readonly style='cursor:pointer;'" : ""}/>`}
          <!-- Show the key. A password field is right by default — this box sits on a page somebody may
               have open while sharing a screen — but a key you cannot read is a key you cannot check
               against the one in AI Studio, and "did I paste it wrong" is the first question anybody asks
               when ▶ Test fails. So it reveals on demand, never by default, and nothing about the revealed
               state is stored: a reload puts it back. When the page is locked this asks for the password
               first, exactly as the box itself does — a locked page that will still show you the
               credential is not locked. -->
          <button class="iconbtn eye" id="ytAiKeyEye" type="button" aria-pressed="false"
                  title="${editLocked ? "Password needed to show the key" : "Show the key"}"
                  aria-label="Show the API key">${EYE_SHOW}</button>
          <button class="btn sec" id="ytAiTest" type="button"
                  title="${editLocked ? "Password needed to test the key" : `Ask ${aiProviderOfState(s) === "groq" ? "Groq" : "Gemini"} one question right now and show what came back`}"
                  ${editLocked ? "style='opacity:.5;cursor:pointer;'" : ""}>▶ Test</button>
        </div>
        <div class="srow sub kid" id="ytAiPctRow" hidden>
          <span class="ic">📊</span>
          <span class="lbl grow">How related it has to be ${tip("The score a video must reach for the AI to let it through, out of 100.<br/><br/><b>50</b> is the default and the right place to start: half a match plays, less than half does not.<br/><br/>The model is told what the numbers mean, so they behave consistently:<ul><li><b>0</b> — nothing to do with each other. Music, gaming, another subject entirely.</li><li><b>25</b> — same broad field, different topic.</li><li><b>50</b> — clearly useful for this card without being its topic.</li><li><b>75</b> — covers this card's topic among other things.</li><li><b>100</b> — squarely about it. The title names what the card asks about.</li></ul>Raise it to demand a closer match; lower it to let more through. Lowering is the loosening, so it asks for your password.")}</span>
          <label class="numfld"><input class="input mini" id="ytAiPct" type="number" min="0" max="100" step="5" value="${Math.max(0, Math.min(100, num(s.ytAiMinPct, 50)))}" title="The score out of 100 a video must reach"/><i>% related</i></label>
        </div>
        <!-- ---- how deeply it looks ----
             The row this whole feature was asked for. The AI half started out reading the TITLE, and a
             title is the one part of a video written to be clicked rather than to be accurate — so a
             vlog with a study-shaped name passed and an honest lecture called "Lec 14" did not. Three
             depths, each a straight trade of seconds and requests for evidence. -->
        <div class="srow sub kid" id="ytAiModeRow" hidden>
          <span class="ic">🔎</span>
          <span class="lbl grow">How deeply to analyse ${tip("<b>How much of the video the AI is allowed to look at before it decides.</b><br/><br/>A title is the weakest evidence there is. It was written to make you click, so it is the one part of a video that can be dressed up — and plenty of honest lectures are called <i>“Lec 14”</i> and say nothing at all. These three answers cost different amounts of time and give very different quality of judgement.<br/><br/><b>Just the title</b><ul><li>The title alone, exactly as this feature originally worked.</li><li>Fastest — about a second — and the least of your business that leaves this machine.</li><li>Wrong in both directions: it passes a vlog named like a lecture, and it refuses a real lecture with a useless name.</li></ul><b>The details</b> <i>(recommended)</i><ul><li>The title, the <b>channel</b>, the <b>description</b>, the <b>tags</b> and the video's own <b>subtitles</b>.</li><li>The subtitles are the important one: they are the video, transcribed by YouTube, so they are what it <i>actually says</i> rather than what it was named. No title can lie its way past them.</li><li>A few seconds, right after you open the video and before it plays. Everything is read from <b>YouTube's own record of that video</b> — the whole description, the tags and the subtitles — by the YouTube tab itself, so no extra permission is needed.</li><li>Which of the four are read is up to you, in the rows below.</li></ul><b>Watch the video</b><ul><li>Nothing on the page is read at all. The <b>link</b> is handed to Gemini and the model opens the video itself.</li><li>The strongest reading available — it sees the actual content, so a video with no title, no description and no subtitles is still judged properly.</li><li><b>Slow and expensive.</b> Up to a minute or two on a long video, and one video-understanding request is worth many text ones against a free daily allowance. The player stays covered while it thinks, and the shield says so.</li><li><b>Gemini only.</b> It needs a model that can open a YouTube link, and Groq's reads text alone — so with Groq picked under <b>Model</b> this button is greyed out and <b>The details</b> is used instead. Move back to Gemini and it is there again.</li></ul><b>None of these change the bar.</b> The score still has to reach the percentage below. What changes is how well informed that score is — which is why more evidence can both rescue a video the title refused and sink one the title would have let through.<br/><br/>Because it changes how the rule is <i>measured</i> rather than what it demands, this is free to change at any time — strict mode does not freeze it, and it does not ask for your password.")}</span>
          ${(() => {
            // Normalised once, here, rather than compared three times in the markup. An install that
            // predates this key, or one whose value somebody edited by hand, lands on the default
            // rather than on a group of three buttons where none is pressed — which looks like the
            // control is broken and, worse, gives no clue what is actually in force.
            //
            // Groq cannot open a YouTube link, so with Groq picked "Watch the video" is drawn disabled and a
            // stored "video" is SHOWN as "the details" — which is exactly what the worker runs in its place
            // (see ytAiModeOf). Showing the stored word instead would press a button that is greyed out,
            // and describe a depth nothing is running.
            const groq = aiProviderOfState(s) === "groq";
            let cur = AI_MODE_LABELS[s.ytAiMode] ? s.ytAiMode : "details";
            if (groq && cur === "video") cur = "details";
            return `<span class="seg" role="group" aria-label="How deeply the AI analyses a video">` +
              Object.keys(AI_MODE_LABELS).map(k => {
                const spec = AI_MODE_LABELS[k];
                const on = k === cur;
                const off = groq && k === "video";
                const hint = off ? "Gemini only — Groq can't open a YouTube link. Pick Gemini under Model to use this." : spec.hint;
                return `<button type="button" class="segbtn${on ? " on" : ""}" data-aimode="${k}"` +
                       ` title="${escHtml(hint)}" aria-pressed="${on ? "true" : "false"}"${off ? " disabled" : ""}>${escHtml(spec.label)}</button>`;
              }).join("") + `</span>`;
          })()}
        </div>
        <!-- The three fields "The details" may read. Own rows rather than one row of checkboxes because
             they are worth genuinely different things — the subtitles are what a video actually says,
             the tags are the weakest evidence there is — and each deserves its own tooltip. All three
             come from YouTube's own record of the video, which the YouTube tab reads itself, with no
             permission (see videoRecord in yt-mark.js). Shown only in that mode; see syncKidRows. -->
        <div class="srow sub kid" id="ytAiSDescRow" hidden>
          <span class="ic">📝</span>
          <span class="lbl grow">Read the description ${tip("The text under the video — the whole of it, from YouTube's own record of the video, even the part hidden behind <i>…more</i> — of which the top ~1200 characters are sent.<br/><br/><b>Worth reading:</b> it is where a lecture says which chapter, class or syllabus it covers — often the only place the actual topic is written down.<br/><br/><b>Worth knowing:</b> it is also where channels put their Telegram links, their timestamps and four paragraphs of boilerplate, so only the top of it is sent — that is where the subject lives.<br/><br/>Costs nothing extra: it comes in the same answer as the tags and the subtitles.")}</span>
          ${sw("ytAiSDesc", (s.ytAiScope || {}).description !== false, false, "Let the AI read the video description")}
        </div>
        <div class="srow sub kid" id="ytAiSTagsRow" hidden>
          <span class="ic">🏷️</span>
          <span class="lbl grow">Read the tags ${tip("The uploader's own keyword list, hidden from viewers and used by YouTube's search.<br/><br/><b>The weakest of the four</b>, and the one to turn off first if a video you expected to be refused keeps getting through. Tags are frequently keyword spam — a hundred subjects listed in the hope of matching any search — and keyword spam is exactly the kind of evidence that makes a model more confident and less right.<br/><br/>Most modern uploads have none at all, in which case this reads nothing and changes nothing — the breakdown says <i>none on this video</i>.<br/><br/>They are read from YouTube's own record of the video you opened, because the page no longer shows them anywhere. Costs nothing extra: it comes in the same answer as the description and the subtitles.")}</span>
          ${sw("ytAiSTags", (s.ytAiScope || {}).tags !== false, false, "Let the AI read the video tags")}
        </div>
        <div class="srow sub kid" id="ytAiSTextRow" hidden>
          <span class="ic">💬</span>
          <span class="lbl grow">Read the subtitles ${tip("<b>What is actually said in the video.</b> This is the one that makes the difference.<br/><br/>YouTube has already transcribed nearly every lecture on the site, automatically where the uploader did not. Those subtitles are the video in text — so a title, a description and a tag list can all be dressed up to look like study material and the subtitles cannot. The AI is told outright that where they disagree, it should believe the subtitles.<br/><br/>Up to about <b>fifteen minutes' worth</b> is sent, and on a longer video it is <b>sampled across the whole thing</b> — some from the start, some from the middle, some from the end. Not the first fifteen minutes: the opening of a lecture is <i>“hello everyone, welcome back”</i>, which is the part that says least about the subject.<br/><br/><b>No permission needed.</b> The YouTube tab you opened the video in reads them itself, straight from YouTube, the moment the AI is about to judge that video — the same subtitles YouTube's own apps get. Nothing but the video's id goes out with the request, and none of your cookies.<br/><br/><b>If a video has no subtitles</b> — not even automatic ones — there is nothing to read, and the shield says so rather than pretending it looked. For those videos, <b>Watch the video</b> above is the answer — on Gemini, since Groq can't open a video.<br/><br/><b>On Groq</b> about half as much is sent, because its free tier caps how much it can read per minute.<br/><br/>Costs a second or two per video, and only for videos the AI is actually asked about — the ones you open, and with Word detection on as well, only those whose title already carries your card's words.")}</span>
          <span class="gval" id="ytAiTextVal" role="status" aria-live="polite"></span>
          ${sw("ytAiSText", (s.ytAiScope || {}).transcript !== false, false, "Let the AI read the video's subtitles")}
        </div>
        <div class="srow sub kid" id="ytAiModelRow" hidden>
          <span class="ic">⚙️</span>
          <span class="lbl" style="flex:0 0 auto">Model ${tip("<b>Which AI answers, and how many videos a day it will answer about.</b> Two choices, from two different companies, each with its own free key and its own daily allowance.<ul><li><b>Gemini Flash Lite 3.5</b> (Google) — about <b>500</b> checks a day. Key from <span class='kbd'>aistudio.google.com/apikey</span>. The only one that can <b>Watch the video</b>, because it can open a YouTube link.</li><li><b>Groq · GPT-OSS 120B</b> — about <b>1,000</b> checks a day, and very quick. Key from <span class='kbd'>console.groq.com/keys</span>. It reads text only, so <b>Watch the video</b> is greyed out while it is picked and <b>The details</b> is used instead. Its free tier also caps how much it can read <i>per minute</i>, so the subtitles of a long video are sent at half the length Gemini gets.</li></ul><b>Each keeps its own key.</b> The box above shows the key for the one picked here, and switching back and forth never loses the other.<br/><br/><b>Why two companies rather than two models.</b> A free allowance runs out, and a service can have a bad afternoon. With the other one a click away, a quota error under the switch is a thing you fix in a second rather than the end of the AI half for the day.<br/><br/><b>A few hundred is plenty here.</b> The AI is only ever asked about a video you actually <i>open</i> and have in front of you — never the thumbnails on a feed, never a tab in the background — and, with Word detection on as well, only about titles that already carry your card's words. Re-opening the same video costs nothing. What does cost one: moving to the <b>next card in Anki</b> while a video is on screen, because the question is always about the card you are on.<br/><br/>Switching to Groq asks Chrome for permission to reach <span class='kbd'>api.groq.com</span>, the same way switching the AI on asked for Google's.<br/><br/>Which one answers is not a loosening, so <b>strict mode does not freeze it</b> — if Gemini's allowance runs out in the middle of a strict window, you can still move to Groq. Groq's key is guarded exactly like the Gemini one.")}</span>
          ${(() => {
            // Two options and nothing else. The stored provider decides which is selected; see aiPickOf,
            // which reads anything that is not exactly "groq" as Gemini — every install from before
            // there was a choice included.
            const cur = aiPickOf(s);
            const opts = AI_MODELS.map(m =>
              `<option value="${escHtml(m.id)}"${m.id === cur ? " selected" : ""} title="${escHtml(m.note)}">${escHtml(m.label)}</option>`
            ).join("");
            // NOT `disabled` when the page is locked, deliberately. A disabled select swallows its own
            // click, so there would be nothing to hang "ask for the password" off — and a control that
            // does nothing and says nothing is a dead end. It stays live and the mousedown handler below
            // asks first, exactly as the key box does.
            return `<select class="input grow" id="ytAiModelSel" aria-label="Which AI answers"
                            ${editLocked ? "style='cursor:pointer;'" : ""}>
                      ${opts}
                    </select>`;
          })()}
        </div>
        <!-- ---- what the last answer actually was ----
             The row ▶ Test used to leave to a toast. A toast says "Working — 62%", which proves the key
             works and answers nothing about the judgement: 62% of what, resting on which part of the
             video, and what exactly was sent to the AI to get it. All three are here instead, and the
             last is the one that matters most — it is somebody's flashcard leaving their machine, and
             "trust me, I sent something sensible" is not an answer anybody should have to accept about
             that. Hidden until a test has been run; see the ▶ Test handler. -->
        <div class="srow sub kid aiout" id="ytAiOutRow" hidden>
          <span class="ic">🧪</span>
          <div class="grow" id="ytAiOut" role="status" aria-live="polite"></div>
        </div>`)}

      <!-- Where the two video rules above run. Its own folder rather than rows inside either rule,
           because it is about both: a site switched off here is left alone by the word check AND the AI
           check. With both rules off, neither switch decides anything, and the count says so. -->
      ${ankiSect("where", "📍", "Where videos are checked", (s.ytGateEnabled === true || s.ytAiEnabled === true) ? [s.videoOnYouTube !== false, s.videoOnGoogle !== false].filter(Boolean).length : 0, `
        <div class="srow sub">
          <span class="ic">▶️</span>
          <span class="lbl grow">YouTube ${tip("<b>Videos on youtube.com</b> — the video page, the mini player, Shorts, and the thumbnails on the feed and in search results.<br/><br/>This is where <b>🔤 Word detection</b> and <b>🤖 AI detection</b> have always worked. Switch it off and YouTube is left to your site lists like any other site: listed means shut, unlisted means open, and nothing on it is checked against your card.<br/><br/>Switching it <b>off</b> hands YouTube's videos back, so it asks for your password and is refused while strict mode is on.")}</span>
          ${sw("vidYouTube", s.videoOnYouTube !== false, strict, "Check videos on YouTube")}
        </div>
        <div class="srow sub">
          <span class="ic">🔎</span>
          <span class="lbl grow">Google ${tip("<b>Videos Google plays inside its own results.</b> Click a video under Google's <b>Videos</b> tab, or in a video box on the results page, and Google often doesn't send you to YouTube — it plays the video in its own player, right there on google.com. Without this, that player was a way round every check above.<br/><br/>With this on, that player gets exactly what YouTube gets: the video's <b>title</b> is checked for your card's words, the <b>AI</b> judges it with the depth you picked, and a video that isn't about your card is covered and held paused — only the player, the results stay where they are. An allowed one counts towards your goal like it would on YouTube, if you have that switched on.<br/><br/><b>Opened on YouTube instead</b> (the video's own link, or Google's YouTube button), a video is checked by the switch above.<br/><br/><b>What this does not cover:</b> the little silent previews Google plays when you hover over a result, and videos from other sites, which open on those sites.<br/><br/>A Google tab that was already open before this extension started is reloaded once, the first time you open a video in it, so its player can be checked.<br/><br/>Switching it <b>off</b> hands those videos back, so it asks for your password and is refused while strict mode is on.")}</span>
          ${sw("vidGoogle", s.videoOnGoogle !== false, strict, "Check videos Google plays in its own results")}
        </div>`)}

      ${ankiSect("watch", "📺", "Study videos &amp; your cards", [s.ytWatchCounts === true, s.ankiLockCollection === true, s.ankiLockNewCards === true, s.ankiLockAddons === true].filter(Boolean).length, `
        <!-- Shown while either video rule is on: a video either of them let through is an allowed
             video, and "watching counts" is about allowed videos rather than about which rule allowed
             them. See syncKidRows. -->
        <div class="srow sub kid" id="ytWatchRow" hidden>
          <span class="ic">⏱️</span>
          <span class="lbl grow">Watching counts as studying ${tip("While an <b>allowed</b> video is playing in front of you, your Anki clock keeps running.<br/><br/>Watching a lecture that explains the card you're stuck on <i>is</i> studying, so this stops the clock punishing you for it.<br/><br/><b>It only counts while all four are true:</b><ul><li>the video passed every video check you have on — its title carries your card's words, the AI judged it to be about your card, or both</li><li>the video is actually playing — not paused, not buffering, not an ad</li><li>its tab is the one you're looking at</li><li>you have allowance left today</li></ul><b>You can watch it count.</b> While a video is counting, the countdown on this extension's toolbar icon turns <b>red</b> and goes down every second. Hover over the icon for the video's name and how much of today's allowance is used. It stops the moment you pause.<br/><br/><b>Capped on purpose.</b> Without a ceiling an hour's goal could be an hour of video and not one card answered, which is the opposite of what this extension is for. The box beside this sets how much of today's goal may come from watching.<br/><br/>This is the only switch here that makes your goal <b>easier</b> to reach, so turning it on asks for your password and is refused while strict mode is on.")}</span>
          <span class="gval" id="ytWatchVal" role="status"></span>
          <label class="numfld"><input class="input mini" id="ytWatchCap" type="number" min="0" max="7200" step="60" value="${Math.max(0, Math.min(7200, num(s.ytWatchCapSec, 900)))}" title="Most seconds of today's goal that may come from watching (0 = no cap)"/><i>s max</i></label>
          ${sw("ytWatch", s.ytWatchCounts === true, strict, "Watching an allowed video counts towards the goal")}
        </div>
        <div class="srow sub">
          <span class="ic">🔒</span>
          <span class="lbl grow">Lock my cards until I'm done ${tip("While today's goal is unfinished, Anki will not let you <b>edit</b>, <b>add</b> or <b>delete</b> a card, and the <b>card browser</b> will not open. Reviewing is completely unaffected — you answer cards exactly as normal.<br/><br/><b>Why this exists.</b> Both video checks above read the front of your card — its words, or its whole text for the AI — which makes the card a key. A key you can retype is not a key: put “music” into the card you are on and every music video becomes study material, and nothing in the matcher could ever tell that card from an honest one. So the answer is not to detect the edit — it is to refuse it.<br/><br/>Worth switching on for its own sake too: it stops you \"fixing\" a card you got wrong instead of learning it.<br/><br/><b>Three ways out, on purpose:</b> finish the goal; turn this switch off; or close the browser — Anki unlocks itself within twenty seconds of this extension going quiet, so uninstalling it can never leave your collection stuck.<br/><br/>Enforced inside Anki, so it needs the add-on, <b>v${escHtml(ANKI_ADDON_VERSION)}</b>. It does not cover AnkiConnect, which can still write to your collection over HTTP — for <b>new</b> cards, the switch below covers that too.")}</span>
          <span class="gval" id="ankiLockVal" role="status"></span>
          ${sw("ankiLockColl", s.ankiLockCollection === true, strict, "Lock my cards until today's goal is done")}
        </div>
        <div class="srow sub">
          <span class="ic">🚫</span>
          <span class="lbl grow">No new cards until I'm done ${tip("While today's goal is unfinished, <b>no new card can be added</b> — not from Anki's <b>Add</b> window, and not from other tools that add cards through <b>AnkiConnect</b>, such as a browser extension that makes cards from YouTube videos. The tool gets a refusal that says why, and Anki shows it too. Importing a deck is refused as well. Reviewing is completely unaffected.<br/><br/><b>Why this exists.</b> Adding cards is the enjoyable half of Anki; reviewing them is the half that makes them stick. This keeps today's reviews first — the new card waits until the goal is done.<br/><br/><b>Three ways out, on purpose:</b> finish the goal; turn this switch off; or close the browser — Anki lifts it within twenty seconds of this extension going quiet, so uninstalling it can never leave you unable to add cards.<br/><br/>Enforced inside Anki, on the collection itself, so it needs the add-on, <b>v${escHtml(ANKI_ADDON_VERSION)}</b>. It does not cover cards added on your phone and brought over by a sync.")}</span>
          <span class="gval" id="ankiLockNewVal" role="status"></span>
          ${sw("ankiLockNew", s.ankiLockNewCards === true, strict, "Refuse new cards until today's goal is done")}
        </div>
        <div class="srow sub">
          <span class="ic">🧩</span>
          <span class="lbl grow">Lock Anki's add-ons until I'm done ${tip("While today's goal is unfinished, <b>Tools → Add-ons</b> will not open, and add-ons cannot be enabled, disabled or deleted.<br/><br/><b>Why this exists.</b> Everything on this page is enforced by the bridge add-on inside Anki: your review count, this card's words, the window checks, the card lock above. Two clicks in Tools → Add-ons switches that add-on off and the whole session ends — the counting stops, and the card lock lets itself go twenty seconds later. Locking your cards and leaving that switch reachable is guarding the window and leaving the door open.<br/><br/><b>The add-on window may already be open</b> when your session starts, so the buttons inside it are refused too, not just the menu item.<br/><br/><b>Three ways out, on purpose:</b> finish the goal; turn this switch off; or close the browser — Anki unlocks itself within twenty seconds of this extension going quiet, so uninstalling it can never leave you unable to manage your own add-ons.<br/><br/>Reviewing, syncing and every other part of Anki are untouched. Needs the add-on, <b>v${escHtml(ANKI_ADDON_VERSION)}</b>. It does not cover Anki's debug console, which can undo anything in one line.")}</span>
          <span class="gval" id="ankiLockAddVal" role="status"></span>
          ${sw("ankiLockAdd", s.ankiLockAddons === true, strict, "Lock Anki's add-on manager until today's goal is done")}
        </div>`)}

      </div>
    </div>
    <button class="expand-bar" id="ankiToggle" aria-expanded="${ankiOpen ? "true" : "false"}" aria-controls="ankiBody" aria-label="${ankiOpen ? "Hide the Anki options" : "Show more Anki options"}" title="${ankiOpen ? "Hide these options" : "Show more options"}"><svg class="chev" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false"><path d="M5 9l7 7 7-7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
`;
}

// ---- turning a video check on has to leave YouTube reachable -----------------------------------
//
// Called by both video rules' switches — the word check's and the AI check's — because either one on
// its own is a rule about which videos open, and either one is useless on a YouTube you cannot reach.
//
// The gate decides WHICH videos open. It has no opinion on whether youtube.com itself is reachable —
// that is the block list's job, and in allowlist mode a site nobody listed is shut. So switching the
// gate on in allowlist mode produced the one state that makes no sense: a careful rule about which
// YouTube videos you may watch, on a YouTube you cannot open at all.
//
// Not obvious from the outside, either, because it half worked. The gate answers for /results
// directly, so search was open — but you could not reach a search box, because the page with the
// search box on it is youtube.com, and that is the one surface the gate hands back to the lists.
//
// So the switch adds youtube.com to the allowlist itself.
//
// WHAT IT ADDS: "youtube.com", not "*.youtube.com". The allowlist is narrow by design — see
// hostMatches in background.js — so this opens youtube.com and www.youtube.com and nothing else.
// music.youtube.com stays shut, which is the point of not using the wildcard: YouTube Music is not a
// study surface, and one character would have handed it over.
//
// WHY IN BOTH MODES, even though the allowlist does nothing while you are in blocklist mode:
// otherwise what this switch does depends on the order you happened to flip two unrelated controls,
// and somebody who moves to allowlist mode next month walks into the same wall again with no way to
// connect it to a switch they turned on weeks earlier. Written once, when the gate goes on, and it
// stays true. In blocklist mode the entry is inert, so the cost of being early is nothing.
//
// WHY IT IS A SEPARATE WRITE from the switch itself, and this is the part worth not undoing later:
// growing the allowlist is a LOOSENING (allowedSites is "short" in the strictness table) while
// turning the gate on is a TIGHTENING. One patch carrying both would be a loosening as a whole, so
// the password gate in setStateP would hold up a change that only ever asks more of you — and worse,
// a refusal would drop the whole patch, so the gate would fail to switch on because of a convenience
// bolted onto it. Two writes means the restriction always lands, and the convenience is free to be
// refused on its own terms.
async function ensureYouTubeAllowed(st) {
  const cur = Array.isArray(st.allowedSites) ? st.allowedSites : [];
  // Any spelling the matcher would already honour counts as present. The wildcard is included
  // because it is WIDER than what this would add, and quietly narrowing somebody's own entry is the
  // opposite of helping.
  if (cur.some(e => /^(\*\.|www\.)?youtube\.com$/i.test(String((e && e.url) || "").trim()))) return;
  if (inStrictWindow(st)) {
    return toast("Video check on. Strict mode won't let youtube.com be added to your allowlist now.");
  }
  try {
    await setStateP({ allowedSites: [...cur, { url: "youtube.com" }] });
  } catch (e) {
    // Password refused. The gate itself is already on — that write landed before this one — so what
    // is missing is the convenience, not the rule. setStateP has said so and redrawn the page.
    return;
  }
  tellWorker({ type: "refreshBlockedTabs" });
  renderApp();
  toast(st.blockMode === "whitelist"
    ? "Video check on · youtube.com allowed, so you can reach it"
    : "Video check on · youtube.com added to your allowlist for if you switch to it");
}

// Everything the Anki card does. Split out from the markup so the card can be
// re-rendered without duplicating a page of listeners.
function bindAnkiHandlers() {
  // ---- folding ----
  function setAnkiOpen(open) {
    const bar = $("#ankiToggle");
    const card = bar ? bar.closest(".card") : document.querySelector(".card");
    const cardTop = card ? card.getBoundingClientRect().top : 0;
    const scrollBefore = window.scrollY;

    ankiOpen = open;
    const body = $("#ankiBody");
    if (body) body.hidden = !open;
    if (bar) {
      // The chevron itself flips in CSS off aria-expanded; only the words a
      // screen reader hears change here.
      bar.setAttribute("aria-expanded", open ? "true" : "false");
      bar.setAttribute("aria-label", open ? "Hide the Anki options" : "Show more Anki options");
      bar.setAttribute("title", open ? "Hide these options" : "Show more options");
    }

    if (open) {
      // Keep card anchored at the top: options expand downward, never jumping up
      if (cardTop >= 0) {
        window.scrollTo({ top: scrollBefore, behavior: "instant" });
        requestAnimationFrame(() => {
          window.scrollTo({ top: scrollBefore, behavior: "instant" });
        });
      }
    } else {
      // When collapsing, if the top of the card was scrolled off-screen, bring it back into view
      if (card && card.getBoundingClientRect().top < 0) {
        card.scrollIntoView({ block: "start", behavior: "smooth" });
      } else {
        window.scrollTo({ top: scrollBefore, behavior: "instant" });
      }
    }
  }
  $("#ankiToggle")?.addEventListener("click", () => setAnkiOpen(!ankiOpen));
  document.querySelectorAll(".secthead[data-sect]").forEach(head => {
    head.addEventListener("click", () => {
      const key = head.getAttribute("data-sect");
      const open = !ankiSectOpen[key];
      ankiSectOpen[key] = open;
      head.setAttribute("aria-expanded", open ? "true" : "false");
      const body = document.getElementById("ankiSect_" + key);
      if (body) body.hidden = !open;
    });
  });

  // The grace box, as whole minutes inside the range it allows.
  //
  // Its own function because the commit patch and the change handler both need exactly this number
  // and must not disagree about it — and because the falsy shortcut every other numeric field on this
  // card uses is wrong here: 0 is a real answer ("the goal and not a second more"), so `|| 10` would
  // quietly turn a deliberate zero into ten minutes.
  function graceMinFromBox() {
    const raw = parseInt($("#ankiGraceMin")?.value, 10);
    if (!Number.isFinite(raw)) return 10;                 // empty box, or the row is not rendered
    return Math.max(0, Math.min(720, raw));
  }

  // ---- reading the form ----
  // Which controls on this card the user has actually touched since the last save.
  //
  // Without this, commitAnki wrote ALL sixteen anti-cheat keys, read out of THIS
  // tab's form, every time any one of them changed. The settings page can be open in
  // two tabs at once, and nothing refreshes these switches from storage — so:
  //
  //   tab A turns the camera on  →  stored ankiAutoCam = true
  //   tab B (opened earlier, still showing it off) flicks any other switch
  //   tab B writes its whole form back  →  ankiAutoCam = false again
  //
  // The camera window closes, the face check is gone, and tab A still shows it on.
  // The same path with a stale goal box wrote ankiRequiredSec: 0, which means "no
  // goal", which releases every blocked tab for the rest of the day.
  //
  // Diffing against stored values does NOT fix this — a stale control genuinely
  // differs from storage, so it would still be written. The only sound answer is to
  // write what the user touched and nothing else.
  const dirty = new Set();
  function markDirty(...keys) { keys.forEach(k => dirty.add(k)); }

  function readAntiCheat() {
    return {
      ankiActiveGrading: $("#ankiActive") ? $("#ankiActive").checked : false,
      ankiRequireForeground: $("#ankiFg") ? $("#ankiFg").checked : true,
      // Fallback true, matching the shipped default: if this switch isn't on screen, saving
      // anything else on this card must not take the timer window away.
      ankiTimerWindow: $("#ankiTimerWin") ? $("#ankiTimerWin").checked : true,
      // Fallback is false, not true. If the switch isn't in the DOM we must not
      // save "camera on" — that was the path that turned the webcam on for anyone
      // who saved any other setting in this card.
      ankiAutoCam: $("#ankiAutoCam") ? $("#ankiAutoCam").checked : false,
      // The camera switch drives the face rule too — one setting, not two.
      ankiFaceRequired: $("#ankiAutoCam") ? $("#ankiAutoCam").checked : false,
      ankiEyeRequired: $("#ankiEyeReq") ? $("#ankiEyeReq").checked : false,
      ankiPerCardCapSec: Math.max(5, Math.min(600, parseInt($("#ankiCap")?.value, 10) || 60)),
      ankiIdleGraceSec: Math.max(5, Math.min(60, parseInt($("#ankiGrace")?.value, 10) || 30)),
      // Falls back to OFF when the row is absent, like its neighbours that ship off: saving
      // anything else on this card must never be able to switch on a check that can stop your
      // clock.
      ankiInactivityPauseEnabled: !!($("#ankiStill") && $("#ankiStill").checked),
      ankiInactivityTimeoutSec: Math.max(5, Math.min(600, parseInt($("#ankiStillSec")?.value, 10) || 30)),
      // The fallback is what to write when the control isn't on screen, so it has to match the
      // shipped default — `true` here would have switched this on for anyone whose settings were
      // saved from a tab where the Cards section had never been opened.
      ankiAntiSpamEnabled: $("#ankiSpam") ? $("#ankiSpam").checked : false,
      ankiMinSecPerCard: Math.max(0.2, Math.min(30, parseFloat($("#ankiMinSec")?.value) || 1)),
      ankiLivenessEnabled: $("#ankiLive") ? $("#ankiLive").checked : true,
      ankiBlinkRequired: !!($("#ankiBlink") && $("#ankiBlink").checked),
      camOverlayEnabled: $("#ankiOverlay") ? $("#ankiOverlay").checked : false,
      // Falls back to OFF when the row is absent, which is the safe direction for the one switch
      // here that makes the goal easier: a missing control must never be able to turn it on.
      ankiPaceEnabled: !!($("#ankiPace") && $("#ankiPace").checked),
      ankiMediaRequired: !!($("#ankiMedia") && $("#ankiMedia").checked),
      // Defaults to ON when the control isn't in the DOM, unlike its neighbours. Every other
      // switch here ships off, so `!!missing === false` happens to be right for them; this one
      // ships on, and falling back to false would have quietly turned it off for anyone who saved
      // this card while the row was absent.
      ankiMediaPauseEnabled: $("#ankiMediaPause") ? $("#ankiMediaPause").checked : true,
      // Same reading as its parent, for the same reason: it ships ON, so an absent row must not be
      // taken as a decision to turn it off.
      ankiMediaResumeEnabled: $("#ankiMediaResume") ? $("#ankiMediaResume").checked : true,
      ankiMinCardsEnabled: !!($("#ankiMinCardsEn") && $("#ankiMinCardsEn").checked),
      ankiMinCards: Math.max(1, Math.min(9999, parseInt($("#ankiMinCards")?.value, 10) || 20)),
      // ankiDeckRestrictEnabled is deliberately NOT in this patch. It is the What counts choice
      // at the top of the card now, and that writes it directly. Left here it would read a
      // control that no longer exists, resolve to false, and quietly widen your goal back to
      // the whole collection every time anything else on this card was saved.
      ankiUniqueOnly: !!($("#ankiUniqueOnly") && $("#ankiUniqueOnly").checked),
      ankiDueGateEnabled: !!($("#ankiDueEn") && $("#ankiDueEn").checked),
      ankiRetentionEnabled: !!($("#ankiRetEn") && $("#ankiRetEn").checked),
      ankiDeckTimeEnabled: !!($("#ankiDeckTimeEn") && $("#ankiDeckTimeEn").checked),
      // The two deadlines. Both ship OFF, so `!!missing === false` is the right fallback for the same
      // reason it is right for their neighbours above: saving anything else on this card must never be
      // able to switch on a rule that can leave a finished goal locked.
      //
      // The two window TIMES are not in here. They are only in the DOM while the switch is on, so a
      // patch that read them would write "06:00"/"09:00" over whatever you had chosen every time the
      // fold was shut — which is the bug ankiDeckRestrictEnabled left a note about two screens up.
      // They have their own `change` handler, like strictStart and strictEnd.
      ankiWinEnabled: !!($("#ankiWinEn") && $("#ankiWinEn").checked),
      ankiGraceEnabled: !!($("#ankiGraceEn") && $("#ankiGraceEn").checked),
      // Minutes on the page, seconds in storage. Clamped to the 0–720 the box allows, which is inside
      // the 0–43200 the import validator allows — a value cannot be accepted here and then quietly
      // clamped somewhere else.
      //
      // Number.isFinite rather than `|| 10`, because 0 is a real answer here: "the goal and not a
      // second more". `||` would silently turn a deliberate zero into ten minutes, which is the one
      // value in this patch where the falsy shortcut is wrong.
      ankiGraceSec: graceMinFromBox() * 60,
      // Both ship OFF, so `!!missing === false` is the right fallback for the same reason it is
      // right for their neighbours: saving anything else on this card must never be able to switch
      // on a rule about which videos you may watch, or one that freezes your collection.
      ytGateEnabled: !!($("#ytGate") && $("#ytGate").checked),
      ytGateMinHits: Math.max(1, Math.min(5, parseInt($("#ytHits")?.value, 10) || 1)),
      // The search gate. OFF when its row is missing, like every switch on this card that takes
      // something away — a control this function cannot find must never be read as "switched on".
      searchGateEnabled: !!($("#searchGate") && $("#searchGate").checked),
      searchGateMinHits: Math.max(1, Math.min(5, parseInt($("#searchHits")?.value, 10) || 1)),
      // The AI check. OFF when the row is missing — it is only ever written when its own switch was
      // touched (see `dirty`), and this one sends card text off the machine, so a missing control
      // turning it on would be the worst version of that mistake.
      //
      // ytAiKey and ytAiGroqKey are deliberately NOT in here. Each is a credential with its own debounced
      // writer and its own password guard (see saveAiKey), and putting one in a patch that gets rewritten every time
      // anything else on this card is touched would mean re-writing a secret on every save — and,
      // because STRICTER marks it "url", asking for the password on every save too.
      ytAiEnabled: !!($("#ytAi") && $("#ytAi").checked),
      // `?? 50` rather than `|| 50`, because 0 is a real value here — "let anything the AI does not
      // actively reject through" — and `|| 50` would silently turn it into 50.
      ytAiMinPct: (() => {
        const n = parseInt($("#ytAiPct")?.value, 10);
        return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 50;
      })(),
      // Which service answers, read off the Model picker: "groq" only when that is what it shows, Gemini
      // otherwise. Only ever written when the picker itself was changed (see its handler), so this
      // fallback is not a way for saving some other control to move you between services.
      //
      // ytAiModel is no longer in here. The picker has no way left to choose a Gemini model, the worker
      // names the model for each service, and a key nothing can change has no business being rewritten.
      ytAiProvider: ($("#ytAiModelSel") && $("#ytAiModelSel").value === "groq") ? "groq" : "gemini",
      // How deeply it looks, and at what. Read from the controls like everything else here, and
      // defaulted to "the details" rather than to "the title" when a control is missing — the opposite
      // of how the switches above fall back, and deliberately so. Those decide whether a rule RUNS, so
      // a missing control must never switch one on. This decides how well informed an answer is, and
      // the careless direction there is the one that judges a video on its headline.
      ytAiMode: aiModeNow(),
      ytAiScope: {
        description: !($("#ytAiSDesc") && $("#ytAiSDesc").checked === false),
        tags: !($("#ytAiSTags") && $("#ytAiSTags").checked === false),
        transcript: !($("#ytAiSText") && $("#ytAiSText").checked === false)
      },
      // Falls back to OFF when the row is absent, like ankiPaceEnabled and for the same reason: it is
      // one of the two switches here that make the goal easier, so a missing control must never be
      // able to turn it on.
      ytWatchCounts: !!($("#ytWatch") && $("#ytWatch").checked),
      ytWatchCapSec: Math.max(0, Math.min(7200, parseInt($("#ytWatchCap")?.value, 10) || 0)),
      // Where the video rules run. The other way round from the rules above: here ON is the strict
      // side, so a control this function cannot find reads as ON — a missing row must never hand a
      // site's videos back.
      videoOnYouTube: $("#vidYouTube") ? $("#vidYouTube").checked : true,
      videoOnGoogle: $("#vidGoogle") ? $("#vidGoogle").checked : true,
      ankiLockCollection: !!($("#ankiLockColl") && $("#ankiLockColl").checked),
      ankiLockNewCards: !!($("#ankiLockNew") && $("#ankiLockNew").checked),
      ankiLockAddons: !!($("#ankiLockAdd") && $("#ankiLockAdd").checked)
    };
  }
  function readAnkiTime() {
    const h = Math.max(0, Math.min(99, parseInt($("#ankiH")?.value, 10) || 0));
    const m = Math.max(0, Math.min(59, parseInt($("#ankiM")?.value, 10) || 0));
    const sec = Math.max(0, Math.min(59, parseInt($("#ankiS")?.value, 10) || 0));
    return h * 3600 + m * 60 + sec;
  }
  // Keep each folder's "2/4 on" badge honest, so flicking a switch updates it
  // without re-rendering the card — a folded folder still says what's running.
  const isOn = id => !!($("#" + id) && $("#" + id).checked);
  const isOnEffective = id => {
    if (!isOn(id)) return false;
    if ((id === "ankiMediaPause" || id === "ankiMediaResume") && !isOn("ankiMedia")) return false;
    if (id === "ankiMediaResume" && !isOn("ankiMediaPause")) return false;
    if (id === "ankiUniqueOnly" && !isOn("ankiMinCardsEn")) return false;
    // Watch time only counts for a video one of the two rules let through, so with both off it decides
    // nothing — and a folded folder claiming "on" for it would be claiming a rule that is not running.
    // (The AI check used to be the special case here, counted only with the word check on. It is a
    // rule of its own now and counts whenever it is on.)
    if (id === "ytWatch" && !isOn("ytGate") && !isOn("ytAi")) return false;
    // The "where" switches only say where the two rules run, so with both rules off they decide nothing
    // either — the same reasoning as watch time just above.
    if ((id === "vidYouTube" || id === "vidGoogle") && !isOn("ytGate") && !isOn("ytAi")) return false;
    return true;
  };
  function refreshCheatCount() {
    Object.keys(ANKI_SECT_SW).forEach(key => {
      const b = $("#ankiSectN_" + key);
      if (b) b.textContent = ANKI_SECT_SW[key].filter(isOnEffective).length + "/" + ANKI_SECT_SW[key].length + " on";
    });
  }
  // A sub-option only exists once its check is on. Nothing to read, nothing to wonder
  // about, and the section is as short as what you've actually switched on.
  //
  // These used to be greyed out at 45% opacity instead. That still left a wall of rows
  // — a dial, a deck box, an Add button — that looked like settings but did nothing,
  // and the difference between "off" and "greyed out" is not obvious at a glance.
  //
  // Every row starts `hidden` in the markup and is revealed from here, so ANKI_KIDS
  // below is the only place that knows which switch owns which rows. This runs in the
  // same pass as the render, before the browser paints, so nothing flashes into view.
  // The last ▶ Test answer, kept so a repaint can put it back. Declared ABOVE syncKidRows rather than
  // beside the rest of the AI code, and it has to be: `let` is hoisted but not initialised, so a
  // syncKidRows that ran before this line was reached would throw on the reference rather than read
  // undefined. Nothing calls it that early today; this is what stops the next thing that does.
  let lastAiTest = null;
  function syncKidRows() {
    Object.keys(ANKI_KIDS).forEach(swId => {
      const on = isOn(swId);
      ANKI_KIDS[swId].forEach(rowId => {
        const row = $("#" + rowId);
        if (row) row.hidden = !on;
      });
    });
    // mediaPauseRow and mediaResumeRow only appear when Media playback tracker (ankiMedia) is ON
    const mediaOn = isOn("ankiMedia");
    const pauseRow = $("#mediaPauseRow");
    if (pauseRow) pauseRow.hidden = !mediaOn;
    const resumeRow = $("#mediaResumeRow");
    if (resumeRow) resumeRow.hidden = !mediaOn || !isOn("ankiMediaPause");
    // Watch time belongs to either video rule, which is one condition more than the table above can
    // say: shown while the word check OR the AI check is on, because a video either of them let through
    // is an allowed video.
    const watchRow = $("#ytWatchRow");
    if (watchRow) watchRow.hidden = !(isOn("ytGate") || isOn("ytAi"));
    // The AI check's own rows follow its own switch and nothing else. It used to be a kid of the word
    // check — two levels down, so this line also asked for the word check — and that is exactly the
    // mixing that went: the AI check is a rule by itself, and its key box, bar and depth are needed
    // whenever it is on.
    const aiUsable = isOn("ytAi");
    ANKI_KIDS.ytAi.forEach(rowId => {
      const row = $("#" + rowId);
      if (row) row.hidden = !aiUsable;
    });
    // …and the three field rows are narrower still: they say which parts of the page "The details" may
    // read, so under either of the other two depths they describe nothing. In "Just the title" there is
    // nothing extra to read; in "Watch the video" the page is deliberately not read at all, and leaving
    // three switches about scraping it on screen would flatly contradict what that mode promises.
    const deep = aiUsable && aiModeNow() === "details";
    ["ytAiSDescRow", "ytAiSTagsRow", "ytAiSTextRow"].forEach(rowId => {
      const row = $("#" + rowId);
      if (row) row.hidden = !deep;
    });
    // The result panel is narrower still: it exists only once ▶ Test has actually been pressed. Painted
    // from the kept result rather than left in the DOM, because renderApp rebuilds this whole card and a
    // panel that survived only until the next repaint would look like a bug in the test.
    // Dropped rather than merely hidden when the feature goes off, so switching it back on later does not
    // bring back a score from a key and a model that may both have changed since.
    if (!aiUsable) lastAiTest = null;
    const out = $("#ytAiOutRow");
    if (out) out.hidden = !aiUsable || !lastAiTest;
    if (aiUsable && lastAiTest) paintAiTestOut();
  }
  // Which depth the buttons are currently showing. Read off the DOM rather than out of storage, for the
  // same reason every other control on this card is: the switches save asynchronously, and syncKidRows
  // runs in the same tick as the click that moved one. Storage is a moment behind; the button is now.
  function aiModeNow() {
    const on = document.querySelector("[data-aimode].on");
    const v = on ? on.getAttribute("data-aimode") : "";
    return AI_MODE_LABELS[v] ? v : "details";
  }

  // ---- auto-save ----
  // There is no Save button. Switches write at once; typed numbers wait half a
  // second so storage isn't hit on every keystroke. Feedback with no extra
  // widget: the time box flashes green, and a hidden live region says the same
  // thing for a screen reader.
  let savedTagTimer = 0;
  function flashSaved(text) {
    const say = $("#ankiSaved");
    if (say) say.textContent = text || "Saved";
    const box = $("#ankiTime");
    if (!box) return;
    box.classList.remove("saved");
    void box.offsetWidth;            // restart the animation on back-to-back saves
    box.classList.add("saved");
    clearTimeout(savedTagTimer);
    savedTagTimer = setTimeout(() => box.classList.remove("saved"), 1400);
  }
  // One writer for the whole card. Returns false if strict mode blocked it.
  //
  // Strict mode used to refuse every change here, while the tooltip and the strict
  // banner both told you that raising the goal was still allowed — the one change
  // that can only ever cost you more study time. Now it refuses exactly the
  // loosening direction: a smaller goal is rejected and the boxes snap back, a
  // bigger one goes through. The anti-cheat switches are left out of the write
  // during a strict window, so nothing else can ride along with the new time.
  async function commitAnki() {
    // Read the form FIRST, and refuse to write at all if it isn't on screen.
    //
    // This was the worst bug in the file. Typing in the goal box arms a 500ms
    // timer; clicking another tab inside that window re-renders the page and
    // destroys the inputs; the timer then fired and read a form that no longer
    // existed. readAnkiTime() returned 0 and readAntiCheat() returned pure
    // defaults, so the whole card was overwritten: today's goal wiped to zero and
    // every anti-cheat setting reset. And because a zero goal means "nothing to
    // finish", the sweep that follows sends every blocked tab back to its site.
    // Two ordinary clicks silently unlocked everything.
    if (!$("#ankiH") || !$("#ankiM") || !$("#ankiS")) return false;
    const requiredSec = readAnkiTime();
    const antiCheat = readAntiCheat();

    const st = await getState();
    const strictNow = inStrictWindow(st);
    // Only the keys the user touched. See `dirty` above for why this matters.
    const patch = {};
    // The goal is judged one key at a time now, like every other refusal below, and it is
    // only judged at all when it was actually touched. Three things were wrong with doing
    // it as an early return:
    //
    //   It ran whether or not the goal was dirty, so a refusal could be decided on a value
    //   that was never going to be written.
    //   It returned before the anti-cheat loop, so an ALLOWED change batched into the same
    //   commit — turning a check on, raising the card count, both tightenings — was
    //   silently dropped along with the refused goal.
    //   It cleared neither `dirty` nor the screen, so the refused control stayed on show
    //   with nothing behind it and the stale key rode into the next commit.
    // Counted apart from the anti-cheat refusals below, because the two have different
    // things to say and one toast per cause is the most anybody wants: the goal has its own
    // sentence about raising versus lowering, and the group has one about the direction of a
    // switch. Both feed the shared `refused` total, which is what decides the redraw.
    let refusedGoal = 0, refusedKeys = 0;
    if (dirty.has("ankiRequiredSec")) {
      if (strictNow && requiredSec < (st.ankiRequiredSec || 0)) {
        // The boxes are only snapped back once you've left them, because rewriting a box
        // that still has the caret in it turns a half-typed number into a stored goal
        // nobody asked for. That used to be reachable the ordinary way: a save armed half
        // a second after every keystroke meant typing "1" then "2" to mean 12h fired on
        // the "1", strict mode refused it, the box snapped back to the stored "5", and the
        // next keystroke made it "52" — which strict mode then refused to bring back down
        // for the rest of the window.
        //
        // Nothing commits mid-edit any more — one write per control, when focus leaves it,
        // see commitWhenLeft — so the caret is normally long gone by the time this runs.
        // The one path that still arrives with it in the box is Enter, which commits and
        // then steps out, so the check stays.
        const focused = document.activeElement;
        const inGoal = focused === $("#ankiH") || focused === $("#ankiM") || focused === $("#ankiS");
        if (!inGoal) writeHMS(st.ankiRequiredSec || 0, $("#ankiH"), $("#ankiM"), $("#ankiS"));
        toast("Strict mode is on. You can raise today's goal, but not lower it.");
        refusedGoal++;
      } else {
        patch.ankiRequiredSec = requiredSec;
      }
    }
    // Judged one key at a time, by direction, instead of dropped as a block.
    //
    // The whole anti-cheat group used to be left out of the write during a strict window, on the
    // reasoning that freezing all ten is one rule rather than ten. It is one rule, and it was the
    // wrong one: it refused you the tightening direction as well, so mid-window you could not turn
    // a check ON, raise the cards needed, or shorten the idle grace — every one of which only ever
    // asks more of you. Strict mode exists to stop you letting yourself off, not to stop you trying
    // harder.
    //
    // FGSettings.loosensKey is the same table the password gate reads, so "which way is stricter"
    // is answered in one place for both. Refused keys are dropped rather than the whole write, and
    // the toast names how many, because silently saving four of five changes is worse than saying so.
    for (const [k, v] of Object.entries(antiCheat)) {
      if (!dirty.has(k)) continue;
      if (strictNow && FGSettings.loosensKey(k, v, st[k])) { refusedKeys++; continue; }
      patch[k] = v;
    }
    if (refusedKeys) toast("Strict mode is on. You can make these stricter, but not ease them off.");
    const refused = refusedGoal + refusedKeys;
    if (refused) {
      // Put the refused controls back to what is stored. Everything that was allowed through is in
      // the patch and about to be written, so a re-render after it lands is the honest picture.
      dirty.clear();
      if (!Object.keys(patch).length) { renderApp(); return false; }
    }
    if (!Object.keys(patch).length) return false;      // nothing was actually changed
    await setStateP(patch);
    dirty.clear();
    // A refused control is still showing the value that was refused, and the partial-refresh calls
    // below do not touch switches. Redrawn from storage, which is the only picture that is true.
    if (refused) { renderApp(); return true; }
    // Same tidy-up the boxes get anywhere else: no leading zeros, overflow
    // carried up, so 90 typed into minutes settles as 1h 30m.
    writeHMS(requiredSec, $("#ankiH"), $("#ankiM"), $("#ankiS"));
    refreshCheatCount();
    syncKidRows();
    // Anything still missing (no time set, the switch off) is said by the status
    // line under the title, so the flash only has to mean "saved".
    refreshHeadLine();
    refreshTickers();
    tellWorker({ type: "refreshBlockedTabs" });
    flashSaved();
    return true;
  }
  // pendingCommit is module-scoped (see the top of the file), not a local: every
  // render of this card makes a NEW binder, so a local timer armed by the previous
  // render could never be cleared by the next one and would fire against dead DOM.
  function commitSoon() {
    clearTimeout(pendingCommit);
    pendingCommit = setTimeout(commitAnki, 500);
  }

  // The dot and the word beside it are one control: green "Anki connected", red
  // "Anki not found", amber while it's asking. Both are set here so they can
  // never disagree.
  const CONN_CLASSES = ["on", "off", "warn", "busy"];
  function setConn(cls, label, title) {
    for (const el of [$("#ankiRefresh"), $("#ankiConnText")]) {
      if (!el) continue;
      el.classList.remove(...CONN_CLASSES);
      el.classList.add(cls);
      el.setAttribute("title", title || label);
    }
    const txt = $("#ankiConnText");
    if (txt) txt.textContent = label;
  }
  // The stored-state version, so the markup and every repaint go through one place.
  function paintConn(st) {
    const c = connState(st);
    setConn(c.cls, c.word, c.title);
  }
  // The live numbers beside the unlock gates, and the warning when one of them
  // cannot be measured. Painted from stored state rather than re-rendering the card,
  // so the figures follow Anki while you're still typing in a box next to them.
  function paintGateVals(st) {
    const ev = FGGates.evaluate(st);
    const by = (k) => ev.items.find(i => i.key === k);
    const put = (id, item) => {
      const el = $("#" + id);
      if (!el) return;
      if (!item) { el.textContent = ""; el.className = "gval"; el.removeAttribute("title"); return; }
      el.textContent = `${item.have} / ${item.need}`;
      // Three states, not two. A gate standing aside — too old an add-on, or not
      // enough answers yet to judge retention — counts as `done` so that it doesn't
      // block, and painting that green would tell the user a check had passed when
      // nothing was measured. It stays neutral, and the hover text says why.
      el.className = "gval " + (item.have === "—" ? "" : item.done ? "ok" : "bad");
      el.setAttribute("title", item.left);
    };
    // The card row's figure belongs to this switch only while it is the switch doing
    // the counting; with it off the number beside it would be describing the row above.
    put("ankiUniqVal", isOn("ankiUniqueOnly") ? by("cards") : null);
    put("ankiDueVal", by("due"));
    put("ankiRetVal", by("retention"));
    // The per-deck chips carry a running figure too, so they have to move with the
    // clock rather than waiting for the next full render of the card.
    document.querySelectorAll("[data-dtq]").forEach(el => {
      const item = by("deck:" + el.getAttribute("data-dtq"));
      if (!item) return;
      el.textContent = `${item.have} / ${item.need}`;
      el.closest(".chip")?.classList.toggle("ok", item.done);
    });
    const warn = $("#ankiGateWarn");
    if (warn) {
      warn.hidden = !ev.warns.length;
      warn.innerHTML = ev.warns.length
        ? `<span class="ic">⚠️</span><span class="lbl grow">${ev.warns.map(escHtml).join("<br/>")}</span>`
        : "";
    }
    paintDeadlineRows(st, ev);
    paintWatchRows(st);
  }

  // ---- what the two deadlines are doing right now ----
  //
  // Painted rather than rendered, like the gate figures above, and for a sharper reason: the time
  // limit counts DOWN. "8m 20s left" has to move on its own, and a full redraw of the card every few
  // seconds would take the caret out of whichever box was being typed in.
  //
  // Each deadline gets a short state word beside its switch and a sentence underneath. The sentence is
  // the important half: a missed deadline is the one state in the extension where the numbers on the
  // card disagree with what is happening — the bar reads 100%, the goal says done, and nothing is
  // unlocked — so it has to be said in words rather than shown as a colour.
  function paintDeadlineRows(st, ev) {
    const done = !!(ev && ev.done);
    const put = (id, text, bad) => {
      const el = $("#" + id);
      if (!el) return;
      el.textContent = text;
      el.className = "gval" + (text ? (bad ? " bad" : " ok") : "");
    };
    const say = (id, html) => {
      const el = $("#" + id);
      if (!el) return;
      // The row keeps its `kid` hiding — syncKidRows owns that — so this only empties the contents.
      // Setting hidden here would fight it and leave the row shut once the switch went back on.
      el.innerHTML = html
        ? `<span class="ic">${html.icon}</span><span class="lbl grow">${html.text}</span>`
        : "";
    };

    // ---- the window ----
    if (st.ankiWinEnabled !== true) {
      put("ankiWinVal", "", false);
      say("winStateRow", null);
    } else {
      const label = FGGates.windowLabel(st);
      const missed = FGGates.windowMissed(st, done);
      const gone = FGGates.windowGone(st, done);
      const openNow = FGGates.hasWindow(st) && FGGates.inWindow(st);
      put("ankiWinVal",
          !FGGates.hasWindow(st) ? "not set"
          : missed ? "missed" : gone ? "shut" : openNow ? "open now" : "shut",
          missed || gone);
      // What the window means for the YouTube and search checks, said where the window is set — they
      // only run inside it (see cardGateLive in background.js), and a video check that quietly stops at
      // 9:00 am reads as broken unless something on this page said it would. Only when one of the two
      // is actually switched on, and only in the states where it is still deciding anything: once the
      // goal is done the checks have stood down for the day anyway.
      const gates = st.ytGateEnabled === true || st.searchGateEnabled === true;
      const gateNote = !gates || done || !FGGates.hasWindow(st) ? ""
        : openNow ? " The YouTube video check is running — it only works inside this window."
        : " The YouTube video check is resting until the window opens — outside it, YouTube follows your lists.";
      say("winStateRow",
        !FGGates.hasWindow(st)
          ? { icon: "⚠️", text: "The two times have to differ — this is not holding you to anything yet." }
          : missed
            ? { icon: "⚠️", text: `Finished after ${escHtml(FGGates.clock12(st.ankiWinEnd))}, so it unlocked nothing today. The time still counted.` }
            : gone
              ? { icon: "⚠️", text: `The ${escHtml(label)} window shut before today's goal was finished. Nothing it unlocks will open today.` +
                                    (gates ? " The YouTube video check has stopped for today too — YouTube follows your lists." : "") }
              // Not for a day with nothing in it: a zero-second goal is "done" before anything happens,
              // and "Finished inside 6:00 am – 9:00 am" is not something that happened.
              : done && FGGates.hasGoal(st)
                ? { icon: "✅", text: `Finished inside ${escHtml(label)} — your sites are open.` }
                : openNow
                  ? { icon: "⏱️", text: `Open now. Finish by ${escHtml(FGGates.clock12(st.ankiWinEnd))} or it unlocks nothing today.` + gateNote }
                  : { icon: "🕒", text: `Shut — it opens at ${escHtml(FGGates.clock12(st.ankiWinStart))}. Finishing outside ${escHtml(label)} unlocks nothing.` + gateNote });
    }

    // ---- the limit ----
    if (st.ankiGraceEnabled !== true) {
      put("ankiGraceVal", "", false);
      say("graceStateRow", null);
    } else {
      const on = FGGates.hasGrace(st);
      const running = FGGates.graceStarted(st);
      const missed = FGGates.graceMissed(st, done);
      const ran = FGGates.graceGone(st, done);
      const left = running ? FGGates.graceLeftSec(st) : 0;
      const total = Math.max(0, num(st.ankiRequiredSec)) + Math.max(0, num(st.ankiGraceSec, 600));
      put("ankiGraceVal",
          !on ? "no goal" : missed ? "missed" : ran ? "ran out"
          : running ? fmtDur(left) + " left" : "not started",
          missed || ran);
      say("graceStateRow",
        !on
          ? { icon: "⚠️", text: "Nothing to be late for — set a goal above 0 and this starts working." }
          : missed
            ? { icon: "⚠️", text: "Finished after the limit ran out, so it unlocked nothing today. The time still counted." }
            : ran
              ? { icon: "⚠️", text: "The limit ran out with work still to do. Nothing it unlocks will open today." }
              : !running
                ? { icon: "⏱️", text: `Not started — the ${escHtml(fmtDur(total))} begins the first time Anki is open today.` }
                : done
                  ? { icon: "✅", text: "Finished inside the limit — your sites are open." }
                  : { icon: "⏱️", text: `<b>${escHtml(fmtDur(left))}</b> left of the ${escHtml(fmtDur(total))} you get — today's goal plus ${escHtml(fmtDur(Math.max(0, num(st.ankiGraceSec, 600))))} of grace.` });
    }
  }

  // Is the AI half actually working? Asked of the worker rather than worked out here, because two of
  // the four answers are things only the worker can see — whether the permission is granted, and what
  // the picked service said the last time it was asked.
  //
  // The row is a status line and not a warning banner, on purpose: a feature that is off is not a
  // problem, so it says nothing at all until it is on. Once on, it is emphatic about the states where
  // it is on and doing nothing, because that is the only failure a user cannot diagnose themselves.
  // The breakdown, as rows. One function, used by the ▶ Test panel here — and mirrored, deliberately
  // rather than shared, by the shield on the player and by the blocked page, which cannot import from
  // this file. The words themselves come from the worker (see AI_FIELD_STATES), so the three surfaces
  // cannot describe the same situation differently even though they draw it separately.
  function aiFieldsHtml(fields, need) {
    const list = Array.isArray(fields) ? fields : [];
    if (!list.length) return "";
    const bar = Math.max(0, Math.min(100, num(need, 50)));
    return `<div class="aifields">` + list.map(f => {
      const has = typeof f.score === "number" && isFinite(f.score);
      // A field with no figure shows a dash, never a zero. The model is asked not to score something it
      // was not given, and printing 0 there would read as "it looked at your subtitles and thought
      // nothing of them" about a video that has none.
      const pct = has ? f.score + "%" : "—";
      const cls = has ? (f.score >= bar ? "ok" : "bad") : "";
      return `<div class="aifield${f.on ? "" : " off"}">` +
             `<span class="afn">${escHtml(f.label || f.key || "")}</span>` +
             `<span class="afs ${cls}">${escHtml(pct)}</span>` +
             `<span class="afw">${escHtml(f.text || "")}</span>` +
             `</div>`;
    }).join("") + `</div>`;
  }

  // What ▶ Test came back with, drawn out in full rather than announced in a toast.
  //
  // Repainted from `lastAiTest` rather than left in the DOM, because renderApp rebuilds this card
  // whenever anything on it is saved — and a result that vanished on the next keystroke would read as the
  // test having failed.
  function paintAiTestOut() {
    const box = $("#ytAiOut");
    if (!box) return;
    const r = lastAiTest;
    if (!r) { box.innerHTML = ""; return; }
    if (!r.ok) {
      box.innerHTML = `<div class="aihead"><span class="pill bad">didn't work</span></div>` +
                      `<div class="lbl hint">${escHtml(r.error || "That didn't work")}</div>`;
      return;
    }
    const need = Math.max(0, Math.min(100, num(r.need, 50)));
    const pct = Math.max(0, Math.min(100, num(r.pct, 0)));
    const pass = pct >= need;
    const said = (AI_MODE_LABELS[r.mode] || AI_MODE_LABELS.details).said;
    box.innerHTML =
      `<div class="aihead">` +
        `<span class="pill ${pass ? "ok" : "bad"}">${pct}% match</span>` +
        `<span class="lbl hint">needs ${need}% · ${pass ? "would play" : "would stay blocked"}</span>` +
      `</div>` +
      // Said out loud, because the test deliberately asks the cheap question whatever the depth is set
      // to. Somebody who reads "62%" here and has "Watch the video" selected would otherwise believe the
      // expensive path had just been exercised.
      `<div class="lbl hint">${escHtml(r.usedCard
        ? "Scored against the card you're on, from the title of a sample video."
        : "Scored against a sample card — open a card in Anki to test with your own.")}` +
        (r.mode && r.mode !== "title"
          ? ` Your setting is <b>${escHtml(said)}</b>; the test asks the title-only question, which is what proves the key, the model name and the reply shape.`
          : "") +
      `</div>` +
      (r.reason ? `<div class="airsn">It said: “${escHtml(r.reason)}”</div>` : "") +
      aiFieldsHtml(r.fields, need) +
      `<div class="lbl hint">Model: <span class="kbd">${escHtml(r.model || "")}</span></div>` +
      (r.hasSent
        // aria-live="off" on the box, and it matters: the row above is a polite live region, and without
        // this a screen reader would read out fifteen thousand characters of subtitles the moment the
        // prompt loaded. tabindex="0" so it can be scrolled from the keyboard, which a plain <pre> cannot.
        ? `<button type="button" class="aisee" id="ytAiSeeSent" aria-expanded="false" aria-controls="ytAiSentBox">See exactly what was sent →</button>` +
          `<pre class="aisent" id="ytAiSentBox" tabindex="0" aria-live="off" aria-label="The prompt that was sent" hidden></pre>`
        : "");
    // Re-attached on every paint, because the markup above replaced the node the last one was on.
    const see = $("#ytAiSeeSent");
    const pre = $("#ytAiSentBox");
    if (see && pre) {
      see.addEventListener("click", async () => {
        if (!pre.hidden) {
          pre.hidden = true;
          see.setAttribute("aria-expanded", "false");
          see.textContent = "See exactly what was sent →";
          return;
        }
        pre.hidden = false;
        see.setAttribute("aria-expanded", "true");
        see.textContent = "Hide what was sent";
        pre.textContent = "loading…";
        const got = await new Promise(res => {
          try {
            chrome.runtime.sendMessage({ type: "ytAiPrompt", test: true }, (x) => {
              void chrome.runtime.lastError;
              res(x || null);
            });
          } catch (e) { res(null); }
        });
        // textContent, never innerHTML. This is a string the model was handed and it contains a video
        // description written by a stranger — putting it into the page as markup would be the one place
        // this whole feature could be turned into an injection.
        pre.textContent = (got && got.ok)
          ? got.prompt + "\n\n— " + (got.chars || got.prompt.length) + " characters, model " + (got.model || "?")
          : ((got && got.error) || "The extension didn't answer.");
      });
    }
  }

  async function paintAiStatus(stIn) {
    const el = $("#ytAiVal");
    if (!el) return;
    const st = stIn || await getState();
    const set = (text, cls, title) => {
      el.textContent = text;
      el.className = "gval" + (cls ? " " + cls : "");
      if (title) el.setAttribute("title", title); else el.removeAttribute("title");
    };
    if (st.ytAiEnabled !== true) { set("", "", ""); paintTranscriptStatus(null).catch(() => {}); return; }
    const r = await new Promise(res => {
      try {
        chrome.runtime.sendMessage({ type: "ytAiStatus" }, (x) => {
          void chrome.runtime.lastError;
          res(x || null);
        });
      } catch (e) { res(null); }
    });
    // Painted from the same reply and BEFORE the early returns below, because the two lines answer
    // different questions: the subtitles can be unreachable while everything else is fine, and they are
    // equally worth saying while the main line is reporting a bad key.
    paintTranscriptStatus(r).catch(() => {});
    if (!r || !r.ok) { set("", "", ""); return; }
    if (!r.hasKey) {
      set("no key", "bad", `Switched on, but there is no ${r.provider === "groq" ? "Groq" : "Gemini"} API key in the box below — so nothing can be asked, and every video this check has to judge stays covered.`);
      return;
    }
    if (!r.hasOrigin) {
      // Named for the service that is picked, because that is the permission missing — somebody on Groq
      // who is told about Google's API goes looking for the wrong one in chrome://extensions.
      // ▶ Test rather than "switch it off and on": the switch going OFF is the loosening that asks for
      // the password now, while ▶ Test asks Chrome for the permission itself, for free.
      set("no permission", "bad", `Switched on, but permission to reach ${r.provider === "groq" ? "Groq's API (api.groq.com)" : "Google's API"} was not granted, so every video this check has to judge stays covered. Press ▶ Test below to be asked for it.`);
      return;
    }
    // A failure is the loudest thing this row says, and it outranks "no card" — a bad key is a thing
    // to fix, while no card open is a thing that fixes itself the moment you start reviewing.
    if (r.lastError) {
      set("error", "bad", r.lastError.text);
      return;
    }
    if (!r.hasCard) {
      set("waiting for a card", "", "Ready. Nothing to compare against until Anki is open on a card — start reviewing and it begins answering.");
      return;
    }
    // No escaping on the model name: this goes through setAttribute, which takes text and not markup,
    // so escaping it would put a literal "&amp;" in the tooltip rather than keeping anything out.
    const said = (AI_MODE_LABELS[r.mode] || AI_MODE_LABELS.details).said;
    set(`ready · ${r.need}%`, "ok",
        `Working. A video the words miss is judged on ${said} by ${r.model}, and plays if it reaches ${r.need}%.`);
  }

  // The subtitles row's own status.
  //
  // It used to have a failure of its own to report: the subtitles were fetched by the worker behind an
  // optional youtube.com permission, and a row whose permission had never been granted said "no
  // permission". The YouTube tab reads them itself now, which needs none — see videoRecord in yt-mark.js
  // — so while the switch is on and "The details" is the depth, this simply says it is on.
  async function paintTranscriptStatus(r) {
    const el = $("#ytAiTextVal");
    if (!el) return;
    const set = (text, cls, title) => {
      el.textContent = text;
      el.className = "gval" + (cls ? " " + cls : "");
      if (title) el.setAttribute("title", title); else el.removeAttribute("title");
    };
    if (!r || !r.ok || r.mode !== "details" || !r.scope || r.scope.transcript !== true) { set("", "", ""); return; }
    set("on", "ok", "Each video you open has its own subtitles read, straight from YouTube, and sent with the rest. This is the evidence a title cannot fake.");
  }

  // The words the video gate is using right now, and whether Anki is really refusing edits.
  //
  // Painted from stored state on every repaint rather than rendered once, because both follow
  // ANKI rather than this page: the keywords change when you turn a card, and the lock only
  // becomes real once the add-on confirms it. A row rendered at page load would be describing
  // whatever card you happened to be on when you opened Settings.
  function paintWatchRows(st) {
    const chips = $("#ytKwChips");
    if (chips) {
      const kw = Array.isArray(st.ankiCardKeywords) ? st.ankiCardKeywords : [];
      chips.innerHTML = kw.length
        ? kw.map(k => `<span class="chip">${escHtml(k)}</span>`).join("")
        : `<span class="lbl hint">${noKeywordsWhy(st)}</span>`;
    }
    // Whether the AI half is actually working, which is a different question from whether it is
    // switched on — and the gap between the two is where every support question about this feature
    // will live. Four ways to be on and not working: no key, no permission, a key the service refuses,
    // and no card open. Each says which.
    //
    // Not awaited — this function is called from the render path and must not become async — and
    // caught, because an unawaited promise that rejects is a console error nobody can trace back here.
    paintAiStatus(st).catch(() => {});
    // How much of today's video allowance is gone. A running figure rather than just the cap, because
    // the cap on its own is a rule and this is the only place you can see whether you are near it.
    const wv = $("#ytWatchVal");
    if (wv) {
      const cap = Math.max(0, num(st.ytWatchCapSec, 900));
      const used = Math.max(0, num(st.ytWatchedSec, 0));
      if (st.ytWatchCounts !== true) { wv.textContent = ""; wv.className = "gval"; wv.removeAttribute("title"); }
      else if (cap === 0) {
        wv.textContent = fmtDur(used) + " watched";
        wv.className = "gval";
        wv.setAttribute("title", "No cap set, so any amount of today's goal can come from watching.");
      } else {
        wv.textContent = fmtDur(used) + " / " + fmtDur(cap);
        wv.className = "gval " + (used >= cap ? "bad" : "ok");
        wv.setAttribute("title", used >= cap
          ? "Today's watching allowance is used up. Video time stops counting until tomorrow."
          : fmtDur(Math.max(0, cap - used)) + " of watching left today.");
      }
    }
    // "Asked for" and "in force" are different facts and the gap between them is always worth
    // showing: with Anki shut, or an add-on too old for the /lock route, the switch is on and
    // nothing is actually being refused. Saying "Locked" then would be a lie the user only finds
    // out about by successfully editing a card.
    //
    // One helper for both locks, reading the add-on's own answer per lock rather than one shared
    // "the bridge is up" flag — an add-on new enough for /lock but too old for the addons parameter
    // would otherwise report the second lock as in force while it does nothing.
    paintLockVal("#ankiLockVal", st.ankiLockCollection === true, st.ankiLockActive === true,
                 "Anki is refusing edits, adds, deletes and the card browser right now.");
    paintLockVal("#ankiLockAddVal", st.ankiLockAddons === true, st.ankiLockAddonsActive === true,
                 "Anki is refusing to open the add-on manager, and refusing to enable, disable or delete an add-on.");
    paintLockVal("#ankiLockNewVal", st.ankiLockNewCards === true, st.ankiLockNewActive === true,
                 "Anki is refusing new cards right now — from its Add window, from AnkiConnect, and from imports.");
  }

  function paintLockVal(sel, want, real, okTitle) {
    const el = $(sel);
    if (!el) return;
    el.textContent = !want ? "" : real ? "locked" : "waiting for Anki";
    el.className = "gval " + (!want ? "" : real ? "ok" : "");
    el.setAttribute("title", !want ? ""
      : real ? okTitle
             : "The switch is on, but Anki hasn't confirmed it — open Anki, and make sure the add-on is up to date.");
  }

  // Repaint the header from stored state, so changing the goal updates "of 30m"
  // and the bar without a full re-render (which would steal the caret).
  async function refreshHeadLine(state) {
    const st = state || await getState();
    const sub = $("#ankiStatus");
    if (sub) sub.innerHTML = ankiSubLine(st);
    paintGateVals(st);
    const rowEl = document.querySelector(".ankirow");
    if (rowEl) {
      rowEl.classList.toggle("done", ankiGoalMet(st));
      rowEl.classList.toggle("off", st.ankiEnabled === false);
    }
    // Driven by the last poll, so closing Anki turns it red by itself.
    paintConn(st);
    const bar = $("#ankiProg");
    if (bar) {
      const met = ankiGoalMet(st);
      const req = Math.max(0, st.ankiRequiredSec || 0);
      const pct = req > 0 ? Math.max(0, Math.min(100, Math.round(((st.ankiSpentSec || 0) / req) * 100))) : (met ? 100 : 0);
      bar.setAttribute("aria-valuenow", String(pct));
      // Empty means empty: no colour, no glow, no minimum width at 0.
      paintBar(bar.querySelector("div"), pct, st.ankiEnabled !== false);
    }
  }
  // The live repainter reaches Anki through this, so it has to escape the binder.
  ankiRepaint = refreshHeadLine;

  // Switches save the moment they move. (ankiAutoCam has its own handler below
  // because it also clears the last-seen-face stamp.)
  // Each switch says which stored key it owns, so commitAnki writes that one and
  // leaves the other fifteen alone — see `dirty`.
  Object.entries({
    ankiActive: ["ankiActiveGrading"],
    ankiStill: ["ankiInactivityPauseEnabled"],
    ankiFg: ["ankiRequireForeground"],
    ankiTimerWin: ["ankiTimerWindow"],
    ankiEyeReq: ["ankiEyeRequired"],
    ankiMedia: ["ankiMediaRequired"],
    ankiMediaPause: ["ankiMediaPauseEnabled"],
    ankiMediaResume: ["ankiMediaResumeEnabled"],
    ankiPace: ["ankiPaceEnabled"],
    ankiSpam: ["ankiAntiSpamEnabled"],
    ankiLive: ["ankiLivenessEnabled"],
    ankiBlink: ["ankiBlinkRequired"],
    ankiOverlay: ["camOverlayEnabled"],
    ankiMinCardsEn: ["ankiMinCardsEnabled"],
    ankiUniqueOnly: ["ankiUniqueOnly"],
    ankiDueEn: ["ankiDueGateEnabled"],
    ankiRetEn: ["ankiRetentionEnabled"],
    ankiDeckTimeEn: ["ankiDeckTimeEnabled"],
    ankiWinEn: ["ankiWinEnabled"],
    ankiGraceEn: ["ankiGraceEnabled"],
    ytWatch: ["ytWatchCounts"],
    // Where the video rules run. Nothing to do on the way on or off beyond the write itself: the worker
    // and the pages follow the stored value, and switching one off goes through the password like any
    // other loosening.
    vidYouTube: ["videoOnYouTube"],
    vidGoogle: ["videoOnGoogle"],
    // In the table rather than a handler of its own, unlike ytGate: switching this on has no second
    // half. It does not need a domain added to your allow list, because it is consulted before the
    // lists and a relevant search goes through whatever they say.
    searchGate: ["searchGateEnabled"],
    ankiLockColl: ["ankiLockCollection"],
    ankiLockNew: ["ankiLockNewCards"],
    ankiLockAdd: ["ankiLockAddons"]
  }).forEach(([id, keys]) => {
    $("#" + id)?.addEventListener("change", () => {
      markDirty(...keys);
      // Its sub-options appear or go on the same tick as the switch, not after the write
      // comes back. commitAnki calls this again, harmlessly, for the paths that reach it
      // some other way.
      syncKidRows();
      commitAnki();
    });
  });
  // The video gate has its own handler rather than a row in the table above, because turning it on
  // has a second half — see ensureYouTubeAllowed. Everything before that is what the table does.
  $("#ytGate")?.addEventListener("change", async () => {
    markDirty("ytGateEnabled");
    syncKidRows();
    // commitAnki goes through setStateP, which throws EditLocked when a password is refused. The
    // table above leaves that as an unhandled rejection; here it has to be caught, or the allowlist
    // half would run after a switch that never saved.
    try { await commitAnki(); } catch (e) { return; }
    // Read what was actually STORED rather than trusting the checkbox or commitAnki's return value.
    // A strict window refuses individual keys and puts the control back, so the switch and storage
    // can legitimately disagree for a moment — and the allowlist must follow the gate that really
    // went on, not the one that was clicked.
    const st = await getState();
    if (st.ytGateEnabled !== true) return;
    await ensureYouTubeAllowed(st);
  });

  // ---- the AI check -----------------------------------------------------------
  //
  // Its own handler for the same reason the word check above has one: switching it on has a second half
  // that the generic table cannot do. Here that half is a PERMISSION — the extension ships with no
  // access to Google's API or to Groq's, and asks for the one that is picked at the moment somebody
  // says they want the feature.

  // Which service is picked on screen right now: the Model picker's own value, because a handler that
  // runs in the same tick as a change must not read storage that is a moment behind. The rendered key
  // box says the same thing when the picker is somehow missing, and Gemini is the last resort — it is
  // what every install from before there was a choice has been using.
  function aiProviderOnScreen() {
    const sel = $("#ytAiModelSel");
    if (sel) return sel.value === "groq" ? "groq" : "gemini";
    return $("#ytAiKey")?.getAttribute("data-keyfor") === "groq" ? "groq" : "gemini";
  }
  // "Groq's API" or "Google's API", for the sentences that say what permission is missing.
  function aiApiName(provider) {
    return provider === "groq" ? "Groq's API" : "Google's API";
  }

  // Ask for the one origin, from inside the click that turned the switch on.
  //
  // It HAS to be here rather than in the worker: chrome.permissions.request needs a user gesture, and
  // a service worker never has one. So the settings page asks, and the worker checks.
  //
  // Requested rather than declared in the manifest on purpose. A required host permission would show
  // up as an install-time warning for every user of this extension, including the great majority who
  // will never turn this on — and adding one to an extension already installed disables it until the
  // user re-approves. An optional one is asked for by the person who wants it, and can be taken back
  // in chrome://extensions without touching anything else.
  //
  // One origin per service, and only the one that is picked. Somebody on Gemini is never asked about
  // Groq's address, and moving to Groq asks for Groq's alone — see the Model picker's handler.
  async function askAiOrigin(provider) {
    const pattern = aiOriginPatternOf(provider || aiProviderOnScreen());
    try {
      if (await chrome.permissions.contains({ origins: [pattern] })) return true;
      return await chrome.permissions.request({ origins: [pattern] });
    } catch (e) {
      return false;
    }
  }

  $("#ytAi")?.addEventListener("change", async () => {
    const wantOn = isOn("ytAi");
    // The permission FIRST, and only on the way on. Two reasons, and the second is the binding one:
    //
    //   A refused prompt then costs nothing — the switch goes back and nothing was stored, rather
    //   than the setting being saved as on and the feature silently never working.
    //
    //   chrome.permissions.request needs a live user gesture, and commitAnki can put a DIALOG on
    //   screen — "make this stricter?" when the page is locked, since switching a rule on is a
    //   tightening (see STRICTER). Awaiting that dialogue first would spend the gesture and the
    //   permission request would then be refused by the browser without ever being shown. So the
    //   browser's prompt has to come before ours.
    //
    // The cost of that order is that somebody who grants the permission and then declines the dialogue
    // has granted an origin the extension will not use. Harmless — nothing is sent without the switch
    // and the key — and revocable from chrome://extensions.
    const provider = aiProviderOnScreen();
    if (wantOn && !(await askAiOrigin(provider))) {
      const el = $("#ytAi");
      if (el) el.checked = false;
      syncKidRows();
      toast("Not switched on — it needs permission to reach " + aiApiName(provider));
      return;
    }
    markDirty("ytAiEnabled");
    syncKidRows();
    try { await commitAnki(); } catch (e) { return; }
    paintAiStatus();
    // A rule about which videos play is no use on a YouTube that allowlist mode shuts, so switching it
    // on leaves youtube.com reachable, exactly as the word check's switch does — and for the same
    // reasons, as its own write after the rule has landed. See ensureYouTubeAllowed. Read back from
    // storage rather than trusted from the switch, because a strict window or a refused dialogue can
    // put the switch back between the click and here.
    if (!wantOn) return;
    const st = await getState();
    if (st.ytAiEnabled !== true) return;
    await ensureYouTubeAllowed(st);
  });

  // ---- how deeply it looks -----------------------------------------------------
  //
  // (No youtube.com permission is asked for anywhere on this card any more. The subtitles used to need
  // one, because the worker fetched them; the YouTube tab reads them itself now — see videoRecord in
  // yt-mark.js — and a request from a page to its own site needs no permission.)

  // The three depth buttons. Its own handler rather than a row in the switch table because it is a
  // segmented control and not a switch.
  document.querySelectorAll("[data-aimode]").forEach(btn => btn.addEventListener("click", async () => {
    const want = btn.getAttribute("data-aimode") || "details";
    if (!AI_MODE_LABELS[want]) return;
    if (want === aiModeNow()) return;
    // Painted before the write, not after. Every other control on this card does the same and it is what
    // makes the card feel like it is responding to you rather than to storage — and aiModeNow() reads the
    // DOM, so the patch commitAnki is about to build needs this to have happened already.
    document.querySelectorAll("[data-aimode]").forEach(b => {
      const on = b === btn;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    markDirty("ytAiMode");
    syncKidRows();
    try { await commitAnki(); } catch (e) { return; }
    paintAiStatus();
  }));

  // The description, the tags and the subtitles: nothing to ask for — the YouTube tab reads all three
  // from YouTube's own record of the video. Plain switches, so they go through the same path as the
  // rest of the card.
  ["ytAiSDesc", "ytAiSTags"].forEach(id => {
    $("#" + id)?.addEventListener("change", () => {
      markDirty("ytAiScope");
      commitAnki();
      paintAiStatus();
    });
  });

  // The subtitles. Kept as its own handler, awaiting the write, so the status line under it is painted
  // from what was saved rather than from the click.
  $("#ytAiSText")?.addEventListener("change", async () => {
    markDirty("ytAiScope");
    try { await commitAnki(); } catch (e) { return; }
    paintAiStatus();
  });

  // The key box. Its own writer rather than a line in commitAnki, because it is a credential: it must
  // not be re-written every time something else on this card is saved, and STRICTER marks it "url" so
  // every write asks for the password.
  //
  // Which key it writes is the box's own data-keyfor — the service it was DRAWN for — and never the
  // picker's current value. The two can differ for a moment: pick Groq with a half-pasted Gemini key in
  // the box and the blur fires before the page is redrawn. Reading the picker there would file a
  // Gemini key under Groq.
  let pendingAiKey = 0;
  async function saveAiKey() {
    const box = $("#ytAiKey");
    if (!box) return;
    const field = box.getAttribute("data-keyfor") === "groq" ? "ytAiGroqKey" : "ytAiKey";
    const next = (box.value || "").trim();
    const st = await getState();
    if (next === String(st[field] || "")) return;       // nothing changed; do not ask for a password
    try {
      await setStateP({ [field]: next });
    } catch (e) {
      // Refused — a strict window, or the password was not given. setStateP has already put the page
      // back to what is stored, so there is nothing to undo here.
      return;
    }
    flashSaved(next ? "Key saved" : "Key cleared");
    paintAiStatus();
  }
  const aiKeyBox = $("#ytAiKey");
  if (aiKeyBox) {
    aiKeyBox.addEventListener("input", () => {
      clearTimeout(pendingAiKey);
      // Longer than the number boxes' half second. A key is forty characters of pasted gibberish, and
      // a writer that fired mid-paste would ask for the password about a half-typed credential.
      pendingAiKey = setTimeout(() => saveAiKey().catch(() => {}), 1200);
    });
    aiKeyBox.addEventListener("blur", () => { clearTimeout(pendingAiKey); saveAiKey().catch(() => {}); });
    aiKeyBox.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      clearTimeout(pendingAiKey);
      saveAiKey().catch(() => {});
      aiKeyBox.blur();
    });
    // The same door the webhook boxes use: a locked page must not let you type into a credential and
    // only find out it was refused when the debounce fires.
    aiKeyBox.addEventListener("pointerdown", async (e) => {
      if (!editLocked) return;
      e.preventDefault();
      if (await requireUnlock()) { renderApp(); }
    });
    aiKeyBox.addEventListener("focus", async () => {
      if (!editLocked) return;
      aiKeyBox.blur();
      if (await requireUnlock()) { renderApp(); }
    });
  }

  // Show the key.
  //
  // Purely local: it changes one attribute on one input and stores nothing, so the revealed state does
  // not survive a repaint or a reload. That is deliberate rather than lazy — a "keep it visible"
  // preference would mean a credential sitting in plain text on a page somebody leaves open, and the
  // reason to look at it at all (checking a paste against AI Studio) is over in seconds.
  $("#ytAiKeyEye")?.addEventListener("click", async () => {
    // A locked page that will still show you the credential is not locked, so this goes through the same
    // door the box itself does.
    if (editLocked) {
      if (!(await requireUnlock())) { toast("Password needed to show the key 🔒"); return; }
      renderApp();
      return;
    }
    const box = $("#ytAiKey"), btn = $("#ytAiKeyEye");
    if (!box || !btn) return;
    const showing = box.type === "text";
    box.type = showing ? "password" : "text";
    btn.innerHTML = showing ? EYE_SHOW : EYE_HIDE;
    btn.setAttribute("aria-pressed", showing ? "false" : "true");
    btn.title = showing ? "Show the key" : "Hide the key";
    btn.setAttribute("aria-label", showing ? "Show the API key" : "Hide the API key");
    // Focus back to the box, so revealing a key to read it does not also mean clicking back into it to
    // fix it.
    try { box.focus({ preventScroll: true }); } catch (e) {}
  });

  // The model: which of the two services answers.
  //
  // Written through commitAnki like every other control on this card (as ytAiProvider), and followed by
  // a full repaint rather than a partial one, because the choice reaches three other rows: the key box
  // shows the other service's key, "Watch the video" greys out or comes back, and the status line under
  // the switch is about a different service. Patching each in place would be three more places to
  // forget.
  const aiModelSel = $("#ytAiModelSel");
  if (aiModelSel) {
    // The same door every other control on a locked page uses: ask before the dropdown opens, rather than
    // letting somebody pick a model and discover on the way out that it was refused.
    const askFirst = async (e) => {
      if (!editLocked) return;
      e.preventDefault();
      if (await requireUnlock()) renderApp();
    };
    aiModelSel.addEventListener("mousedown", askFirst);
    aiModelSel.addEventListener("keydown", (e) => {
      if (!editLocked) return;
      // Enter and the arrow keys are how a select is opened and moved from the keyboard. Tab is not, so it
      // is left alone — a locked page must still be traversable.
      if (e.key === "Tab") return;
      askFirst(e);
    });
    aiModelSel.addEventListener("change", async () => {
      // Belt and braces: a change that arrives anyway — a script, an assistive technology, a path not
      // thought of — must not write through a lock. The page is put back to what is stored.
      if (editLocked) { renderApp(); return; }
      const want = aiModelSel.value === "groq" ? "groq" : "gemini";
      const was = want === "groq" ? "gemini" : "groq";
      const spec = aiModelSpec(aiModelSel.value);
      // The new service's permission FIRST, and inside the gesture, for the reason spelt out on the ytAi
      // switch above: commitAnki can put a dialog on screen, and awaiting that would spend the gesture
      // so the browser refused its own prompt without ever showing it.
      //
      // Refused means nothing moves. The picker goes back, and the service that was answering still is
      // — rather than storing a choice that could never send a single request.
      if (!(await askAiOrigin(want))) {
        aiModelSel.value = aiPickOf({ ytAiProvider: was });
        toast("Not switched — it needs permission to reach " + aiApiName(want));
        return;
      }
      // "Watch the video" is Gemini's alone. Moving to Groq with it selected moves the depth to "The
      // details" too — which is what the worker would run in its place anyway (ytAiModeOf) — so what is
      // stored is what is on screen, and a backup never carries a depth nothing can run.
      //
      // Painted before the write, like the depth buttons' own handler, because aiModeNow() reads the DOM
      // and the patch commitAnki is about to build needs to see it.
      let movedDepth = false;
      if (want === "groq" && aiModeNow() === "video") {
        document.querySelectorAll("[data-aimode]").forEach(b => {
          const on = b.getAttribute("data-aimode") === "details";
          b.classList.toggle("on", on);
          b.setAttribute("aria-pressed", on ? "true" : "false");
        });
        markDirty("ytAiMode");
        movedDepth = true;
      }
      markDirty("ytAiProvider");
      clearTimeout(pendingCommit);
      // A ▶ Test answer is about the service that gave it. Left on screen it would put the other one's
      // score and model name under a picker that no longer says either.
      lastAiTest = null;
      try { await commitAnki(); } catch (e) { return; }
      await renderApp();
      // The redraw took the picker with it. Focus goes back to the new one, which is where it sits after
      // any ordinary pick from a dropdown — a keyboard user must not be dropped at the top of the page.
      try { $("#ytAiModelSel")?.focus({ preventScroll: true }); } catch (e) {}
      paintAiStatus();
      // One toast, saying everything that changed: which service answers now, the depth if that had to
      // move, and the key if this service has none yet — the one thing still standing between the pick
      // and a working gate.
      const st = await getState();
      const hasKey = !!String((want === "groq" ? st.ytAiGroqKey : st.ytAiKey) || "").trim();
      const bits = ["Model: " + (spec ? spec.label : (want === "groq" ? "Groq" : "Gemini"))];
      if (movedDepth) bits.push("“Watch the video” is Gemini only, so it reads the details instead");
      if (!hasKey) {
        bits.push(want === "groq"
          ? "paste a Groq key in the box above — free from console.groq.com/keys"
          : "paste a Gemini key in the box above — free from aistudio.google.com/apikey");
      }
      toast(bits.join(" · "), bits.length > 1 ? { cls: "wide", ms: 6000 } : undefined);
    });
  }

  // ▶ Test. One real request, right now, bypassing the cache — the whole point of pressing it is to
  // find out whether the key works at this moment, and an answer from the cache would prove nothing.
  $("#ytAiTest")?.addEventListener("click", async () => {
    if (editLocked) {
      if (!(await requireUnlock())) { toast("Password needed to test the key 🔒"); return; }
      renderApp();
      return;
    }
    // Whatever is in the box, not whatever was last stored. Somebody who has just pasted a key and
    // pressed ▶ within the debounce window means "test this".
    clearTimeout(pendingAiKey);
    await saveAiKey().catch(() => {});
    // The service on screen, which is the one whose key saveAiKey just wrote and the one the worker is
    // about to ask.
    const provider = aiProviderOnScreen();
    if (!(($("#ytAiKey")?.value || "").trim())) {
      return toast(`Paste your ${provider === "groq" ? "Groq" : "Gemini"} API key in first`);
    }
    if (!(await askAiOrigin(provider))) return toast("It needs permission to reach " + aiApiName(provider));
    const btn = $("#ytAiTest");
    if (btn) { btn.disabled = true; btn.textContent = "⏳ Asking…"; }
    const r = await new Promise(res => {
      try {
        chrome.runtime.sendMessage({ type: "ytAiTest" }, (x) => {
          void chrome.runtime.lastError;
          res(x || { ok: false, error: "The extension didn't answer." });
        });
      } catch (e) { res({ ok: false, error: "The extension didn't answer." }); }
    });
    if (btn) { btn.disabled = false; btn.textContent = "▶ Test"; }
    // Kept and drawn out in full under the row, whichever way it went. The toast stays as well, because
    // it is the thing that catches the eye — but a toast is gone in three seconds and "62%" on its own
    // answers none of the questions it raises, so the panel is where the answer actually lives.
    //
    // A locked page is not a result: it is the page refusing to run the test at all, so nothing is kept.
    if (!r.ok && r.error === "locked") {
      toast("Password needed to test the key 🔒");
      lastAiTest = null;
      const row = $("#ytAiOutRow");
      if (row) row.hidden = true;
      paintAiTestOut();
      paintAiStatus();
      return;
    }
    lastAiTest = r;
    const outRow = $("#ytAiOutRow");
    if (outRow) outRow.hidden = false;
    paintAiTestOut();
    if (!r.ok) {
      toast(r.error || "That didn't work");
    } else {
      // Says which question was asked, because the button deliberately does not ask the deep one.
      //
      // ▶ exists to prove the key is accepted, the model exists and it answers in the shape this code
      // parses — every failure somebody can fix from this screen. Spending a video-understanding request
      // (a minute of waiting and a large slice of a free daily allowance) to re-prove the same four
      // things would be a worse test, but a toast that did not mention it would leave somebody believing
      // their "Watch the video" setting had just been exercised.
      const deep = r.mode && r.mode !== "title";
      const tail = deep ? " · the title check works, so the deeper one will too" : "";
      toast(r.usedCard
        ? `Working — it scored the sample title ${r.pct}% against the card you're on${tail}`
        : `Working — ${r.pct}% on a sample card. Open a card in Anki to test with your own${tail}`);
    }
    paintAiStatus();
  });

  // Typed numbers, the goal time included. One edit, one write: nothing is stored while you are
  // still inside the control, and the save happens when focus leaves it — or on Enter, for a
  // keyboard way out. See commitWhenLeft for how "leaving" is decided, and the two listeners
  // below for what each event is and is not allowed to do.
  const NUM_KEYS = {
    ankiH: "ankiRequiredSec", ankiM: "ankiRequiredSec", ankiS: "ankiRequiredSec",
    ankiCap: "ankiPerCardCapSec", ankiGrace: "ankiIdleGraceSec",
    ankiStillSec: "ankiInactivityTimeoutSec",
    ankiMinSec: "ankiMinSecPerCard", ankiMinCards: "ankiMinCards",
    ytHits: "ytGateMinHits", ytWatchCap: "ytWatchCapSec",
    searchHits: "searchGateMinHits",
    ytAiPct: "ytAiMinPct",
    // The grace box rides the same debounce as every other typed number here. Adding grace is the
    // LOOSENING direction, so setStateP may put a password sheet in front of it — which is the reason
    // it commits on change and blur rather than on every keystroke: a save per keystroke would raise
    // that sheet on the "1" of "10" and take the box away mid-edit.
    ankiGraceMin: "ankiGraceSec"
  };
  // Which CONTROL each box belongs to — the thing focus has to leave before anything is written.
  //
  // The goal's three boxes share one `.timeset` wrapper, so they are one control: hours, minutes
  // and seconds are three views of a single number and finishing with the hours box is not
  // finishing with the goal. Every other box here is a control on its own, and is its own root.
  const groups = new Map();
  Object.keys(NUM_KEYS).forEach(id => {
    const el = $("#" + id);
    if (!el) return;
    const touch = () => markDirty(NUM_KEYS[id]);
    // Both of these only MARK the box as edited. Neither writes.
    //
    // `input` used to arm a save half a second after every keystroke, and on the goal that was
    // actively harmful rather than merely eager: typing "1" then "2" to mean twelve hours let the
    // timer fire on the "1", so a one-hour goal was stored on the way past — and under strict
    // mode that same half-finished number was refused for being lower than what was stored, the
    // box snapped back, and the next keystroke landed on the snapped-back value. See the note in
    // commitAnki, which had to work around exactly this.
    //
    // `change` is no better on its own. On a number box it fires on the way out AND on every
    // spinner click, so it is a save per nudge; on a time box whose value is already complete it
    // fires the instant a segment changes, because 02:04 → 03:04 is a perfectly valid time.
    el.addEventListener("input", touch);
    el.addEventListener("change", touch);
    // Enter is the explicit "I'm done", so there is a keyboard way to save that doesn't mean
    // going to find another control to click. It commits and then steps out.
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault(); touch(); clearTimeout(pendingCommit); commitAnki(); el.blur();
    });
    const root = el.closest(".timeset") || el;
    if (!groups.has(root)) groups.set(root, true);
  });
  // One write per control, when you leave it. Nothing to mark dirty here: focus passing through a
  // box is not an edit, and marking it would let an untouched box write itself back. With `dirty`
  // empty commitAnki builds an empty patch and returns without writing, redrawing or toasting —
  // so tabbing across the whole card costs nothing.
  groups.forEach((_v, root) => {
    commitWhenLeft(root, () => { clearTimeout(pendingCommit); commitAnki(); });
  });

  // ---- the deadline window's two times ----
  //
  // Their own handler rather than a row in the patch above, for the reason written there: they are
  // only in the DOM while the switch is on, so a patch that read them would overwrite whatever you
  // had chosen with the shipped pair every time the fold was shut. Same arrangement as strictStart
  // and strictEnd, which are not in any patch either.
  //
  // On leaving the ROW, not on `change`.
  //
  // `change` was wrong here for a reason that is easy to miss: a time input fires it the moment a
  // segment produces a valid value, and a box that ALREADY holds one always does. Clicking into
  // 02:04 and typing the hour makes 03:04 — complete, valid, and nothing to do with the window you
  // were half way through entering. So the old handler saved, judged, toasted and redrew on the
  // hours alone, before the minutes had been touched.
  //
  // The zero-length check below is what made that genuinely bad rather than just noisy. Editing
  // 02:50 towards 02:04 passes through a moment where start and end agree, and on that moment the
  // old code threw up a toast and called renderApp — taking the boxes away mid-edit and putting
  // the stored pair back. Reading the pair ONCE, when you have finished with both, is the fix: the
  // row is judged on what you meant rather than on what it looked like on the way there.
  //
  // The row is the control, so moving between the two boxes is not leaving it. See commitWhenLeft.
  // The row's ONE writer. Named rather than left inline, because two different things ask for it
  // now: focus leaving the row, and the dial's Set button. "Same validation, same single patch" is
  // only true while there is one of it.
  async function commitWindow() {
    const start = FGGates.hhmm($("#ankiWinStart")?.value, "06:00");
    const end = FGGates.hhmm($("#ankiWinEnd")?.value, "09:00");
    const st = await getState();
    // Focus can leave this row without anything having been typed — tabbing past it, or a click
    // that lands and moves on. Comparing against what is stored is what makes that free: no
    // write, no toast, no redraw. It covers the other harmless case too, an edit that ends up
    // back where it started.
    if (start === FGGates.hhmm(st.ankiWinStart, "06:00") &&
        end === FGGates.hhmm(st.ankiWinEnd, "09:00")) return;
    // A window of zero length can never be satisfied, so it is refused on the way in rather than
    // stored and then ignored. Ignoring it silently would be worse than refusing it: the switch
    // would read as on, the row would show two times, and nothing whatsoever would be enforced.
    if (start === end) {
      renderApp();
      return void toast("A window has to have two different times — the start and the end can't both be " + FGGates.clock12(start));
    }
    try {
      await setStateP({ ankiWinStart: start, ankiWinEnd: end });
    } catch (e) {
      renderApp();                        // refused: put the boxes back to what is stored
      return;
    }
    // The hours decide whether a finished goal counts, so changing them can open or shut the sites
    // this second — a window widened to include the moment you finished releases them now, not on
    // the next minute tick.
    tellWorker({ type: "refreshBlockedTabs" });
    renderApp();
    toast("⏰ Finish between " + FGGates.clock12(start) + " and " + FGGates.clock12(end));
  }

  let winDialOpen = false;
  commitWhenLeft($("#winTimesRow"), () => {
    // The dial is a sheet in front of the page, so opening it necessarily takes focus out of the
    // row — and without this that reads as "the edit is over". It would commit, call renderApp, and
    // rebuild the two boxes underneath the open dial, leaving it pointing at elements that no
    // longer exist and about to write into them. The flag is set synchronously when the button is
    // clicked, which is before focus can move anywhere, so it is always already true by the time
    // this runs.
    if (winDialOpen) return;
    commitWindow();
  });

  // ---- the round clock on each box ----
  //
  // The button is inside the row, so moving focus to it is not leaving the control and nothing is
  // written on the way in. What happens next is entirely the dial's: it writes nothing until Set.
  [["ankiWinStart", "Window opens at", "06:00"],
   ["ankiWinEnd", "Window closes at", "09:00"]].forEach(([id, title, fallback]) => {
    const el = $("#" + id), btn = $("#" + id + "Dial");
    if (!el) return;

    // ---- the up/down arrows ----
    //
    // Nothing here writes. The arrows change what the box SAYS and leave storing it to the row's one
    // writer, exactly as typing does — which is the whole reason the focus handling below matters
    // rather than being a tidiness point.
    const bindStep = (stepBtn, dir) => {
      if (!stepBtn) return;
      // The button must not take the focus. preventDefault stops it doing so and el.focus() puts the
      // focus in the BOX instead, which keeps it inside the row — and the row's "focus left, so save"
      // rule is the only thing that ever writes. An arrow that quietly left focus outside the row
      // would change the time on screen and then never store it.
      stepBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        if (!el.disabled) { try { el.focus(); } catch {} }
      });
      const bump = () => {
        // isConnected, because a repeat timer could in principle outlive a redraw, and writing into a
        // detached box would be a change nobody could see and nothing would save.
        if (el.disabled || stepBtn.disabled || !el.isConnected) return false;
        stepTimeBox(el, dir, fallback);
        return true;
      };
      // Hold to keep going, so crossing an hour is one press rather than twelve. The first step comes
      // from the click below, so this only ever starts the SECOND one onwards.
      let hold = 0, rep = 0, repeated = false;
      const stop = () => { clearTimeout(hold); clearInterval(rep); hold = 0; rep = 0; };
      stepBtn.addEventListener("pointerdown", () => {
        stop();
        repeated = false;
        hold = setTimeout(() => {
          rep = setInterval(() => { repeated = true; if (!bump()) stop(); }, 90);
        }, 400);
      });
      // Every way a press can end, including the pointer sliding off the button. A repeat left running
      // would spin the time on by itself, so this is deliberately over-covered.
      ["pointerup", "pointercancel", "pointerleave", "blur"].forEach(t => stepBtn.addEventListener(t, stop));
      stepBtn.addEventListener("click", () => {
        stop();
        // A hold has already moved it, and the click that ends the hold would add one more on top.
        if (repeated) { repeated = false; return; }
        bump();
      });
    };
    bindStep($("#" + id + "Up"), 1);
    bindStep($("#" + id + "Down"), -1);

    if (!btn) return;
    btn.addEventListener("click", async () => {
      // Strict mode disables the boxes, and a picker that still opened would offer an edit that
      // could not be saved. The attribute is on the button too; this is the belt to that braces.
      if (el.disabled || btn.disabled) return;
      winDialOpen = true;
      let picked = null;
      try {
        // Through hhmm, so a box somebody has emptied opens on the shipped time rather than on
        // midnight — and so the dial is handed the same normalised string storage holds.
        picked = await openTimeDial({ title, value: FGGates.hhmm(el.value, fallback) });
      } finally {
        // In a `finally`, because a throw anywhere in there must not leave the row permanently
        // unable to save itself.
        winDialOpen = false;
      }
      // Dismissed. Nothing changed, so nothing is written and the focus goes back where it was —
      // before any redraw, which is the only moment this button still exists.
      if (!picked) { btn.focus(); return; }
      el.value = picked;
      // "Set" means set, so this does not wait for you to click away afterwards. Straight to the
      // row's own writer, which stays the only thing that writes.
      await commitWindow();
    });
  });

  // No handler for the Anki tile any more — it is just the logo now. Anki always
  // counts; the goal time is what decides whether anything is gated, and a time of
  // zero already means "nothing to finish". The old switch let the card look fully
  // configured while quietly enforcing nothing, which is the one state a blocker
  // should not have.

  // ↺ start today over.
  $("#ankiReset")?.addEventListener("click", async () => {
    const st = await getState();
    if (inStrictWindow(st)) return toast("Strict mode is on. You cannot start over now.");
    if (!await confirmReset({
      title: "Start today over?",
      body: `${fmtDur(Math.min(st.ankiSpentSec || 0, st.ankiRequiredSec || 0))} of Anki time and ${st.ankiReviewedToday || 0} cards go back to zero, and your locked sites lock again. This cannot be undone.`
    })) return;
    const fresh = await getState();
    if (inStrictWindow(fresh)) return toast("Strict mode is on. You cannot start over now.");
    await setStateP(todayResetPatch());
    tellWorker({ type: "refreshBlockedTabs" });
    renderApp();
    toast("Today starts over");
  });
  // The bar winds time BACK, never forward. Handing yourself time you never
  // spent is the one thing this extension exists to prevent, so it's refused out
  // loud, and the same speed bump as ↺ guards it because it destroys the same
  // thing.
  async function scrubTo(frac) {
    const st = await getState();
    if (inStrictWindow(st)) return toast("Strict mode is on. You cannot change today's time now.");
    const req = st.ankiRequiredSec || 0;
    if (req <= 0) return;
    const cur = Math.min(req, st.ankiSpentSec || 0);
    if (cur <= 0) return;
    const want = Math.max(0, Math.min(req, Math.round(Math.max(0, Math.min(1, frac)) * req)));
    if (want >= cur) return toast("The bar only winds back — it can't give you time you haven't spent");
    if (!await confirmReset({
      title: want === 0 ? "Start today over?" : "Wind today's time back?",
      body: want === 0
        ? `${fmtDur(cur)} of Anki time goes back to zero. This cannot be undone.`
        : `Anki goes from ${fmtDur(cur)} back to ${fmtDur(want)}. The ${fmtDur(cur - want)} in between is gone for good.`,
      go: want === 0 ? "Reset" : "Wind back"
    })) return;
    // Re-read: the dialog was open for a while and the clock kept running.
    const fresh = await getState();
    if (inStrictWindow(fresh)) return toast("Strict mode is on. You cannot change today's time now.");
    await setStateP({ ankiSpentSec: want, ankiCreditedSinceAnswer: 0, allDoneCelebratedOn: "" });
    tellWorker({ type: "refreshBlockedTabs" });
    renderApp();
    toast(want === 0 ? "Started over" : "Wound back to " + fmtDur(want));
  }
  const scrubBar = document.querySelector("#ankiProg[data-scrub]");
  if (scrubBar) {
    scrubBar.addEventListener("click", (e) => {
      const box = scrubBar.getBoundingClientRect();
      if (!box.width) return;
      scrubTo((e.clientX - box.left) / box.width);
    });
    // From the keyboard there's no "where", so Enter means all the way back.
    scrubBar.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      scrubTo(0);
    });
  }

  // The name is a link. If Anki is running its add-on brings the window forward;
  // if it isn't, the launcher URL the add-on registered with Windows starts it.
  $("#ankiOpenApp")?.addEventListener("click", () => openAnkiApp(toast));

  // The dot is also the "check now" button: it shows the state and re-tests it.
  //
  // Bound to the WORD beside it as well. Every tooltip connState writes ends with "Click
  // to check again", and that tooltip is put on both elements — but only the dot had a
  // handler, and the dot is eleven pixels wide. So the obvious thing to click was the one
  // thing that did nothing.
  const recheckAnki = () => {
    const sub = $("#ankiStatus");
    setConn("busy", "checking…", "Asking Anki…");
    if (sub) sub.textContent = "asking Anki…";
    chrome.runtime.sendMessage({ type: "ankiPoll" }, async (r) => {
      void chrome.runtime.lastError;
      const st = r && r.status;
      // The poll has already written what it found to storage, so repainting from
      // storage keeps one source of truth instead of a second copy of the rules
      // built out of the reply.
      await refreshHeadLine();
      if (!st || !st.connected) {
        if (sub) sub.textContent = (st && st.error) || "open Anki desktop, then tap again";
        return toast("Could not reach Anki");
      }
      toast("Anki connected ✓");
    });
  };
  $("#ankiRefresh")?.addEventListener("click", recheckAnki);
  // Click only, and deliberately no role or tabindex of its own. The word carries
  // role="status" aria-live="polite", which is what announces a change of connection
  // state; overwriting that with role="button" would trade a working announcement for a
  // second way to reach an action the keyboard already has — the dot beside it is a real
  // <button>. So this widens the mouse target and changes nothing else.
  $("#ankiConnText")?.addEventListener("click", recheckAnki);

  // One switch runs the whole camera side: the window that opens by itself AND
  // the "must see your face" rule. They were two toggles that only ever made
  // sense together.
  $("#ankiAutoCam")?.addEventListener("change", async () => {
    const st = await getState();
    if (inStrictWindow(st)) { renderApp(); return toast("Strict mode is on. You cannot change Anki now."); }
    const on = $("#ankiAutoCam").checked;
    await setStateP({ ankiAutoCam: on, ankiFaceRequired: on, ankiFacePresent: false, ankiFaceAt: 0 });
    refreshCheatCount();
    syncKidRows();
    flashSaved();
    toast(on ? "Camera on — it pops up when you open Anki" : "Camera off");
  });

  // The two dials save themselves as you let go. The camera window picks the new
  // value up through storage.onChanged, so there's nothing to press or reload.
  const SENS_WORD = ["", "strict", "firm", "normal", "kind", "easy"];
  const EYE_WORD = ["", "fussy", "firm", "normal", "kind", "easy"];
  // On both dials 1 is the strictest and 5 the most forgiving, so a LOWER number
  // is the tightening direction. That matters during a strict window: these two
  // sliders were the widest hole in it. Nothing checked them at all, so mid-window
  // you could slide face sensitivity to "easy" — which drops the detector's
  // confidence bar far enough to accept a photograph — and the camera window
  // picked the new value up live through storage.onChanged.
  function bindSens(id, outId, key, words, say) {
    const el = $("#" + id);
    if (!el) return;
    const read = () => Math.max(1, Math.min(5, parseInt(el.value, 10) || 3));
    const paint = (v) => {
      const out = $("#" + outId);
      if (out) out.textContent = words[v];
      // How far along the track the coloured part reaches. The track is drawn by us now
      // (see .sens in options.css, which shows a dot per level) and a custom track has no
      // idea what the value is, so it's handed over as a number from 0 to 1.
      const lo = Number(el.min) || 1, hi = Number(el.max) || 5;
      const at = hi > lo ? (v - lo) / (hi - lo) : 0;
      el.style.setProperty("--sens-fill", String(at));
    };
    paint(read());                    // so the fill is right before it's ever touched
    el.addEventListener("input", () => paint(read()));
    el.addEventListener("change", async () => {
      const v = read();
      const st = await getState();
      const cur = Math.max(1, Math.min(5, st[key] || 3));
      if (v > cur && inStrictWindow(st)) {
        el.value = String(cur);
        paint(cur);                   // snaps the fill back with the thumb
        return toast("Strict mode is on. You can make this stricter, but not easier.");
      }
      await setStateP({ [key]: v });
      toast(say(v));
    });
  }
  const FACE_SAY = {
    1: "Only an upright face facing the camera counts now",
    2: "A tilted head counts now",
    3: "A tilted head and a head down over the desk count now",
    4: "Any position counts now, as long as you're in the chair",
    // 5 says "as relaxed as it gets", not "never stops" — see the ceiling in study.js.
    5: "Camera is as relaxed as it gets now"
  };
  bindSens("faceSens", "faceSensVal", "faceSensitivity", SENS_WORD, v => FACE_SAY[v] || FACE_SAY[3]);
  bindSens("eyeSens", "eyeSensVal", "eyeSensitivity", EYE_WORD,
           v => v <= 2 ? "Eye check is fussier now" : v >= 4 ? "Eye check is easier now" : "Eye check set to normal");
  const MOVE_WORD = ["", "big move", "firm", "normal", "small", "tiny"];
  bindSens("moveSens", "moveSensVal", "moveSensitivity", MOVE_WORD,
           v => v >= 4 ? "A smaller movement will do now" : v <= 2 ? "A bigger movement is needed now" : "Movement set to normal");
  const BLINK_WORD = ["", "clear", "firm", "normal", "slight", "faint"];
  bindSens("blinkSens", "blinkSensVal", "blinkSensitivity", BLINK_WORD,
           v => v >= 4 ? "Fainter blinks will count now" : v <= 2 ? "A clearer blink is needed now" : "Blink set to normal");
  // All the way down to 0, which means "never stop asking": the check re-arms the moment
  // it is satisfied, so the clock only counts while you are visibly moving. That is a
  // coherent setting and someone may want it, but it is strict enough that the tooltip
  // says so outright.
  //
  // The old floor of 30 came from the check being hard to satisfy — asking twice a minute
  // for a lean you couldn't perform would have been unusable. Any movement clears it now.
  autoNum("liveInterval", "livenessIntervalSec", 0, 1800, 10, "down");
  // The other two sliding deadlines. Same shape, same direction: a smaller number asks more of
  // you, so lowering it is the tightening strict mode allows.
  autoNum("eyeAway", "eyeAwaySec", 0, 600, 10, "down");
  autoNum("blinkEvery", "blinkIntervalSec", 0, 600, 10, "down");

  // ---- the two pace multipliers ----
  // Not bindSens: that one is built for the five-step dials — whole numbers 1 to 5, a word per step —
  // and these are tenths with a number to show. Same shape otherwise, including the same strict-mode
  // guard, because they are sliders on the same card and behaving differently would be a surprise.
  //
  // The refusal is direction-aware and the direction is the SAME for both, which is not obvious: a
  // bigger number on either slider means the goal arrives sooner. Faster when facing the camera is
  // plainly a reward; sliding the slow end up towards 1 removes the cost of slouching, which is the
  // same thing said the other way round. FGSettings has both as "down" for exactly this reason, and
  // this asks it rather than deciding for itself.
  // `dp` and `unit` because the third slider on this card is whole percent with a % after it, not
  // tenths with a × after it. Passed in rather than branched on inside: the strict-mode guard, the
  // direction question and the write are identical for all three, and those are the parts worth
  // having in one place.
  // Bring the camera window up so the slider you are moving can be seen doing something.
  //
  // On `input` rather than on `change`, because the point is to be WATCHING the box while you drag it
  // — waiting for you to let go would show you the result of a decision you had already made. The
  // worker keeps the window alive for ninety seconds and refreshes that on every message, so it
  // follows you through a session of adjusting and goes away when you stop.
  //
  // Throttled, because `input` fires for every pixel of a drag and this is a message plus a
  // storage read plus possibly a windows.create on the other end.
  let camPreviewAt = 0;
  function previewCam() {
    const now = Date.now();
    if (now - camPreviewAt < 4000) return;
    camPreviewAt = now;
    try {
      chrome.runtime.sendMessage({ type: "camPreview" }, () => void chrome.runtime.lastError);
    } catch {}
  }

  function bindPace(id, outId, key, lo, hi, fallback, dp, unit) {
    const el = $("#" + id);
    if (!el) return;
    const places = dp == null ? 1 : dp, tail = unit == null ? "×" : unit;
    const P = Math.pow(10, places);
    const snap = (v) => Math.max(lo, Math.min(hi, Math.round((Number(v) || fallback) * P) / P));
    const read = () => snap(el.value);
    const say = (v) => v.toFixed(places) + tail;
    const paint = (v) => {
      const out = $("#" + outId);
      if (out) out.textContent = say(v);
      const at = hi > lo ? (v - lo) / (hi - lo) : 0;
      el.style.setProperty("--sens-fill", String(at));
    };
    paint(read());
    el.addEventListener("input", () => { paint(read()); previewCam(); });
    el.addEventListener("change", async () => {
      previewCam();
      const v = read();
      const st = await getState();
      const cur = snap(st[key]);
      if (FGSettings.loosensKey(key, v, cur) && inStrictWindow(st)) {
        el.value = String(cur);
        paint(cur);
        return toast("Strict mode is on. You can make this stricter, but not easier.");
      }
      await setStateP({ [key]: v });
      toast(say(v) + " set");
    });
  }
  bindPace("paceFast", "paceFastVal", "ankiPaceFast", 1, 4, 1.5);
  bindPace("paceSlow", "paceSlowVal", "ankiPaceSlow", 0.1, 1, 0.5);
  bindPace("paceBox", "paceBoxVal", "ankiPaceBoxPct", 30, 85, 55, 0, "%");

  // ---- how big the camera window is ----
  // The one slider on this page that writes no setting. The camera window's size does not live in a
  // setting: the window is the store, and what persists is the bounds the worker writes down whenever
  // they change. So this states a width, the worker applies it and derives the height, and the
  // ordinary bounds machinery remembers it. Adding a key would put the same number in two places,
  // which is the shape of every resize bug this window has had.
  //
  // Live while you drag, and that is a departure from the pace sliders beside it — they only nudge the
  // preview every four seconds, because what they change is visible in a window that is already open.
  // This one changes the window ITSELF, and the whole complaint it answers is that choosing a size was
  // guesswork. A size you cannot see being chosen is guesswork however good the readout is.
  (function bindCamSize() {
    const el = $("#camSize");
    if (!el) return;
    const out = $("#camSizeVal");
    // Mirrors CAM_SIZE in background.js, and mirrors it loosely on purpose: the worker clamps for real
    // and answers with what it actually did, so these two only have to keep the slider's own track
    // sensible. If they ever drift, the worker wins and the readout tells the truth anyway.
    const LO = 120, HI = 700;
    // One message a frame at most. `input` fires for every pixel of a drag and each message costs the
    // worker a windows.get plus a windows.update.
    const EVERY_MS = 60;
    let sentAt = 0, pendingW = 0, timer = 0;
    const snap = (v) => Math.max(LO, Math.min(HI, Math.round(Number(v) || 176)));
    const fill = (v) => el.style.setProperty("--sens-fill", String(HI > LO ? (v - LO) / (HI - LO) : 0));
    // The width alone while you drag, both figures once the worker has told us what the height came
    // out as. Written that way round to stop the readout flickering between one form and the other on
    // every pixel of a drag — the pair is the more informative label, so it is the one that lands when
    // you stop moving.
    const say = (w, h) => { if (out) out.textContent = h ? (w + " × " + h) : (w + " px"); };
    function push(w, showPair) {
      try {
        chrome.runtime.sendMessage({ type: "camSetWidth", width: w }, (r) => {
          void chrome.runtime.lastError;
          if (r && r.ok) { if (showPair) say(r.width || w, r.height || 0); return; }
          // Nothing to resize. Open one rather than doing nothing: a size control that silently has no
          // effect is exactly the thing being fixed here. previewCam keeps it alive for ninety seconds
          // and refreshes that on every message, so it follows a session of adjusting and then goes.
          if (r && r.noWindow) previewCam();
        });
      } catch (e) {}
    }
    // Throttled with a TRAILING send, not a leading one only: without the timer the last few pixels of
    // a drag are swallowed and the window settles somewhere you did not choose.
    function send(w) {
      const now = Date.now();
      clearTimeout(timer);
      if (now - sentAt >= EVERY_MS) { sentAt = now; push(w, false); return; }
      pendingW = w;
      timer = setTimeout(() => { sentAt = Date.now(); push(pendingW, false); }, EVERY_MS);
    }
    fill(snap(el.value));
    el.addEventListener("input", () => {
      const w = snap(el.value);
      fill(w); say(w, 0); send(w);
    });
    el.addEventListener("change", () => {
      const w = snap(el.value);
      clearTimeout(timer);
      sentAt = Date.now();
      fill(w);
      push(w, true);
      toast("Camera window: " + w + " px wide");
    });
  })();

  // ---- the Anki add-on file ----
  // Packs the add-on that ships with this extension into a .ankiaddon, which is
  // just a ZIP. Written by hand (stored, no compression) so there's no library.
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function zipStore(entries) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    const DOS_DATE = 22561, DOS_TIME = 0;   // 2024-01-01 00:00, a valid stamp
    let offset = 0;
    for (const e of entries) {
      const name = enc.encode(e.name), data = e.data, crc = crc32(data);
      const lh = new Uint8Array(30 + name.length);
      const dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0, true);
      dv.setUint16(8, 0, true); dv.setUint16(10, DOS_TIME, true); dv.setUint16(12, DOS_DATE, true);
      dv.setUint32(14, crc, true); dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true);
      dv.setUint16(26, name.length, true); dv.setUint16(28, 0, true);
      lh.set(name, 30);
      parts.push(lh, data);

      const cd = new Uint8Array(46 + name.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true); cv.setUint16(10, 0, true);
      cv.setUint16(12, DOS_TIME, true); cv.setUint16(14, DOS_DATE, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true); cv.setUint16(36, 0, true); cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      cd.set(name, 46);
      central.push(cd);
      offset += lh.length + data.length;
    }
    const cdSize = central.reduce((a, b) => a + b.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
    ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true); ev.setUint16(20, 0, true);
    return new Blob([...parts, ...central, end], { type: "application/octet-stream" });
  }
  // ---- handing you the add-on file ----
  //
  // Worth knowing why it's built here rather than downloaded from a website: the
  // add-on ships INSIDE this extension, and the file you get is packed from those
  // exact bytes. So it always matches the version the extension expects, it works
  // with no internet, and nothing is ever fetched and run from a server — which
  // is also what keeps it clear of the Chrome Web Store's remotely-hosted-code
  // rule. A hosted download could go stale against the extension; this can't.
  // The download's filename only. Anki takes the add-on's identity from the manifest
  // inside the zip, not from what the file is called, so this is free to read as the
  // product does.
  const ADDON_NAME = "ankigate_bridge.ankiaddon";
  const MANUAL_STEPS = "Saved to Downloads. In Anki: Tools → Add-ons → Install Add-on from File…";

  // What the add-on's manifest is called inside THIS package, and what it has to be
  // called inside the .ankiaddon we hand to Anki.
  //
  // They differ, and they have to. Anki requires the file to be `manifest.json` inside
  // the add-on. The Chrome Web Store refuses a package containing more than one
  // `manifest.json` anywhere in it — "More than one manifest found in package" — and
  // the upload is rejected before review even starts. So the source file ships under a
  // different name and is renamed on its way into the zip. The bytes are identical
  // either way, which is the property that matters: the file the user installs is
  // still built from the copy inside this extension and can never be a version behind.
  const ADDON_MANIFEST_SRC = "addon.json";
  async function buildAddonBlob() {
    const entries = [];
    for (const [src, nameInZip] of [["__init__.py", "__init__.py"],
                                    [ADDON_MANIFEST_SRC, "manifest.json"]]) {
      const res = await fetch(chrome.runtime.getURL("anki-addon/" + src));
      entries.push({ name: nameInZip, data: new Uint8Array(await res.arrayBuffer()) });
    }
    return zipStore(entries);
  }

  // Saving it is saveBlob at the top of this file — a plain anchor click.
  //
  // This used to use chrome.downloads + chrome.downloads.open, so that one press
  // saved the file AND handed it straight to Anki. Two reasons it doesn't any
  // more. It never actually worked: downloads.open() requires the user gesture to
  // still be live, and it was called from a downloads.onChanged listener that
  // fires long after the click, so the open silently failed and the page showed
  // two contradictory messages. And it cost two permissions — "downloads" and
  // "downloads.open" — for a convenience, where "download a file and then ask the
  // OS to execute it" is exactly the shape a Chrome Web Store reviewer stops on.
  //
  // The cost is one manual step in Anki, which the toast spells out.
  $("#ankiAddon")?.addEventListener("click", async () => {
    let blob;
    try { blob = await buildAddonBlob(); } catch { return toast("Could not make the file"); }
    if (!saveBlob(blob, ADDON_NAME)) return toast("Could not save the file");
    toast(MANUAL_STEPS);
  });

  // ---- what counts: the whole collection, or a list of decks ----
  // Two buttons rather than a switch, because the two answers are both real choices and one of
  // them is the default. A switch labelled "only these decks count" made the other answer
  // something you had to infer from it being off.
  document.querySelectorAll("[data-scope]").forEach(b => b.addEventListener("click", async () => {
    const st = await getState();
    if (inStrictWindow(st)) return toast("Strict mode is on. You cannot change Anki now.");
    const want = b.dataset.scope === "decks";
    if (want === !!st.ankiDeckRestrictEnabled) return;      // already the answer
    await setStateP({ ankiDeckRestrictEnabled: want });
    // What is blocked right now follows from what counts, so don't wait for the next poll.
    tellWorker({ type: "refreshBlockedTabs" });
    renderApp();
    // Honest about the empty-list case rather than promising a restriction that isn't running.
    toast(!want ? "Every deck counts now"
          : (st.ankiDecks || []).length ? "Only the decks below count now"
          : "Pick a deck below — until you do, every deck still counts");
  }));

  // ---- decks ----
  // One fetch feeds three things: the tree in What counts, and the datalist behind the two
  // remaining plain deck boxes (the due gate's list and the per-deck time quotas).
  function loadDeckNames(quiet) {
    // No address in the message: the worker owns the one AnkiConnect URL there is.
    chrome.runtime.sendMessage({ type: "ankiDeckNames" }, (r) => {
      void chrome.runtime.lastError;
      if (!r || !r.ok) {
        deckNames = [];             // asked and got nothing, which the tree says out loud
        paintDeckTree();
        if (!quiet) toast("No decks found. Is Anki open?");
        return;
      }
      deckNames = (r.decks || []).map(d => String(d || "")).filter(Boolean);
      const dl = $("#ankiDeckList");
      if (dl) dl.innerHTML = deckNames.map(d => `<option value="${escHtml(d)}">`).join("");
      paintDeckTree();
      if (!quiet) toast(`Found ${deckNames.length} decks.`);
    });
  }
  // Only the tree is redrawn, not the page. A caret is not a settings change, and rebuilding the
  // whole card for one would throw away the caret you just pressed along with wherever you were
  // scrolled to.
  function paintDeckTree() {
    const wrap = $("#deckTreeWrap");
    if (!wrap) return;
    getState().then(st => {
      const el = $("#deckTreeWrap");
      if (!el) return;                       // re-rendered out from under us while we waited
      el.innerHTML = deckTreeHtml(st.ankiDecks || [], inStrictWindow(st));
      bindDeckTree();
    }).catch(() => {});
  }
  function bindDeckTree() {
    document.querySelectorAll("[data-deck-open]").forEach(b => b.addEventListener("click", () => {
      const p = b.getAttribute("data-deck-open");
      if (deckOpen.has(p)) deckOpen.delete(p); else deckOpen.add(p);
      paintDeckTree();
    }));
    document.querySelectorAll("[data-deck-pick]").forEach(b => b.addEventListener("click", async () => {
      const st = await getState();
      if (inStrictWindow(st)) return toast("Strict mode is on. You cannot change Anki now.");
      const p = b.getAttribute("data-deck-pick");
      const cur = st.ankiDecks || [];
      const next = cur.includes(p)
        ? cur.filter(d => d !== p)
        // Picking a folder covers everything under it, so any subdeck already on the list is
        // dropped. Leaving them would be the same rule written twice and a chip row of noise.
        : [...cur.filter(d => d !== p && !d.startsWith(p + "::")), p];
      await setStateP({ ankiDecks: next, ankiDeckRestrictEnabled: true });
      tellWorker({ type: "refreshBlockedTabs" });
      renderApp();
    }));
  }
  bindDeckTree();
  // Fetched without being asked, the first time the tree is on screen. It is a read, it costs one
  // localhost round trip, and a tree that starts empty behind a button labelled Load is a puzzle
  // rather than a picker. `quiet`, so a closed Anki doesn't fire a toast nobody asked for.
  if ($("#deckTreeWrap") && deckNames === null && !deckLoadTried) {
    deckLoadTried = true;
    loadDeckNames(true);
  }
  $("#ankiDeckLoad")?.addEventListener("click", () => loadDeckNames(false));
  $("#ankiDtLoad")?.addEventListener("click", () => loadDeckNames(false));
  $("#ankiDueDeckLoad")?.addEventListener("click", () => loadDeckNames(false));
  // Filters the tree as you type. Not debounced: it is a substring test over a list of deck
  // names, which is nothing, and a delay on a filter box is felt immediately.
  const deckBox = $("#ankiDeckInput");
  if (deckBox) {
    deckBox.value = deckFilter;
    deckBox.addEventListener("input", () => {
      deckFilter = deckBox.value;
      paintDeckTree();
    });
  }
  $("#ankiDeckAdd")?.addEventListener("click", async () => {
    const st = await getState();
    if (inStrictWindow(st)) return toast("Strict mode is on. You cannot change Anki now.");
    const v = ($("#ankiDeckInput")?.value || "").trim();
    if (!v) return;
    const cur = st.ankiDecks || [];
    if (cur.includes(v)) return toast("Already added");
    deckFilter = "";                          // the box was the name, not a filter to keep
    await setStateP({ ankiDecks: [...cur, v], ankiDeckRestrictEnabled: true });
    tellWorker({ type: "refreshBlockedTabs" });
    renderApp();
  });
  document.querySelectorAll("[data-deck-del]").forEach(x => onActivate(x, async () => {
    const st = await getState();
    if (inStrictWindow(st)) return toast("Strict mode is on. You cannot change Anki now.");
    const d = x.getAttribute("data-deck-del");
    await setStateP({ ankiDecks: (st.ankiDecks || []).filter(z => z !== d) });
    renderApp();
  }));

  // ---- putting your picked decks in your own order ----
  // Only this row. The tree above it is Anki's collection and is shown in Anki's order; dragging
  // a deck there would look like it moved the deck and move nothing, because nothing here can
  // reorder a collection — Anki sorts decks alphabetically and has no custom order to write to.
  //
  // The order changes no decision either. Decks are matched by prefix, so which is first is
  // never asked. It is for reading, and it is saved, because a list you arranged and that
  // rearranges itself on reload is worse than one you cannot arrange at all.
  bindDeckChipDrag();
  function bindDeckChipDrag() {
    const row = $("#deckChips");
    if (!row) return;
    let dragEl = null;
    // Where the dragged chip should land. Chips wrap onto several lines, so this reads the row
    // the way text reads — anything on a line below the pointer, or on the pointer's own line
    // and to the right of it, comes after. A purely horizontal test drops the chip on the wrong
    // line the moment the list wraps, which it does at four or five decks.
    const landBefore = (x, y) => {
      for (const c of row.querySelectorAll("[data-deck-chip]:not(.dragging)")) {
        const r = c.getBoundingClientRect();
        if (y < r.top || (y <= r.bottom && x < r.left + r.width / 2)) return c;
      }
      return null;                        // past everything, so it goes on the end
    };
    // Read back from the DOM rather than tracked in a variable: the DOM is what the user can
    // see, so it is the only version of the order that cannot be wrong.
    const commitOrder = async () => {
      const order = [...row.querySelectorAll("[data-deck-chip]")]
        .map(c => c.getAttribute("data-deck-chip"));
      const st = await getState();
      const cur = st.ankiDecks || [];
      if (order.length !== cur.length || order.every((d, i) => d === cur[i])) return;
      if (inStrictWindow(st)) { renderApp(); return toast("Strict mode is on. You cannot change Anki now."); }
      await setStateP({ ankiDecks: order });
    };
    row.querySelectorAll("[data-deck-chip]").forEach(chip => {
      chip.addEventListener("dragstart", (e) => {
        dragEl = chip;
        chip.classList.add("dragging");
        try {
          e.dataTransfer.effectAllowed = "move";
          // Firefox refuses to start a drag with nothing on the clipboard.
          e.dataTransfer.setData("text/plain", chip.getAttribute("data-deck-chip") || "");
        } catch (err) {}
      });
      chip.addEventListener("dragend", () => {
        chip.classList.remove("dragging");
        dragEl = null;
        commitOrder();
      });
      // The same move without a mouse. Alt, not bare arrows: a chip is focusable and the arrows
      // belong to whatever the browser would do with them.
      chip.addEventListener("keydown", (e) => {
        if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
        e.preventDefault();
        const sib = e.key === "ArrowLeft" ? chip.previousElementSibling : chip.nextElementSibling;
        if (!sib) return;
        if (e.key === "ArrowLeft") row.insertBefore(chip, sib);
        else row.insertBefore(sib, chip);
        chip.focus();                     // insertBefore moves the node, and focus goes with it
        commitOrder();
      });
    });
    row.addEventListener("dragover", (e) => {
      if (!dragEl) return;
      e.preventDefault();                 // without this the drop is refused
      const before = landBefore(e.clientX, e.clientY);
      if (before === dragEl) return;
      row.insertBefore(dragEl, before);
    });
    row.addEventListener("drop", (e) => e.preventDefault());
  }

  // ---- which decks the due gate watches ----
  // ankiDueAtDayStart goes back to -1 on every change here. It records what was
  // waiting when the day began, and it is what the progress bar counts down from — so
  // a figure measured for "the whole collection" would have the bar showing 117 of 129
  // cleared the instant you narrowed the gate to one deck with 12 in it. -1 means
  // "adopt the next reading as the new start line".
  $("#ankiDueDeckAdd")?.addEventListener("click", async () => {
    const st = await getState();
    if (inStrictWindow(st)) return toast("Strict mode is on. You cannot change Anki now.");
    const v = ($("#ankiDueDeckInput")?.value || "").trim();
    if (!v) return toast("Type a deck name, or leave it empty to watch every deck");
    const cur = FGGates.dueDecks(st);
    if (cur.some(d => d.toLowerCase() === v.toLowerCase())) return toast("Already added");
    await setStateP({
      ankiDueDecks: [...cur, v], ankiDueGateEnabled: true,
      ankiDueLeft: -1, ankiDueAtDayStart: -1
    });
    tellWorker({ type: "refreshBlockedTabs" });
    renderApp();
    toast(`Only ${v} counts towards the due goal now`);
  });
  document.querySelectorAll("[data-duedeck-del]").forEach(x => onActivate(x, async () => {
    const st = await getState();
    if (inStrictWindow(st)) return toast("Strict mode is on. You cannot change Anki now.");
    const d = x.getAttribute("data-duedeck-del");
    const next = FGGates.dueDecks(st).filter(z => z !== d);
    await setStateP({ ankiDueDecks: next, ankiDueLeft: -1, ankiDueAtDayStart: -1 });
    tellWorker({ type: "refreshBlockedTabs" });
    renderApp();
    toast(next.length ? `${d} removed` : "The due goal watches every deck again");
  }));

  // ---- per-deck time quotas ----
  $("#ankiDtAdd")?.addEventListener("click", async () => {
    const st = await getState();
    if (inStrictWindow(st)) return toast("Strict mode is on. You cannot change Anki now.");
    const deck = ($("#ankiDtInput")?.value || "").trim();
    const h = Math.max(0, Math.min(99, parseInt($("#ankiDtH")?.value, 10) || 0));
    const m = Math.max(0, Math.min(59, parseInt($("#ankiDtM")?.value, 10) || 0));
    const sec = Math.max(0, Math.min(59, parseInt($("#ankiDtS")?.value, 10) || 0));
    const total = h * 3600 + m * 60 + sec;
    if (!deck) return toast("Type a deck name first");
    // A zero-length quota is not a quota, and gates.js drops it — so storing one
    // would put a row on screen that does nothing and can't be satisfied or failed.
    if (total <= 0) return toast("Set a time for this deck as well");
    const cur = FGGates.deckTimeRows(st);
    const clash = cur.find(r => r.deck.toLowerCase() === deck.toLowerCase());
    // Replacing rather than refusing: typing a deck that's already listed obviously
    // means "make it this much instead", and the alternative is remove-then-re-add.
    // Raising is always allowed; lowering during a strict window is not.
    if (clash && inStrictWindow(st) && total < clash.sec) {
      return toast("Strict mode is on. You can raise a deck's time, but not lower it.");
    }
    const next = cur.filter(r => r.deck.toLowerCase() !== deck.toLowerCase());
    next.push({ deck, sec: total });
    await setStateP({ ankiDeckTimes: next, ankiDeckTimeEnabled: true });
    tellWorker({ type: "refreshBlockedTabs" });
    renderApp();
    toast(clash ? `${deck} is now ${fmtDur(total)}` : `${deck}: ${fmtDur(total)} needed`);
  });
  document.querySelectorAll("[data-dt-del]").forEach(x => onActivate(x, async () => {
    const st = await getState();
    if (inStrictWindow(st)) return toast("Strict mode is on. You cannot change Anki now.");
    const d = x.getAttribute("data-dt-del");
    await setStateP({
      ankiDeckTimes: FGGates.deckTimeRows(st).filter(r => r.deck !== d)
    });
    tellWorker({ type: "refreshBlockedTabs" });
    renderApp();
  }));

  // The two gate numbers save themselves like every other number on this page.
  // Their strict directions are opposites, which is the whole reason autoNum takes
  // one: fewer cards allowed to still be due is stricter, and a HIGHER percentage
  // right is stricter.
  // "up", because winding further back costs you more of the video — the same direction the shared
  // STRICTER table gives this key, and it has to be: two answers to "which way is stricter" for one
  // setting is the drift that table exists to end.
  autoNum("ankiMediaBack", "ankiMediaRewindSec", 0, 120, 5, "up");
  autoNum("ankiDueAllow", "ankiDueAllowed", 0, 999, 0, "down");
  autoNum("ankiRetPct", "ankiMinRetention", 1, 100, 80, "up");

  // Last thing in the same pass as the render, so the rows whose check is on are visible
  // before the browser paints and the rest were never seen at all.
  syncKidRows();
  // And the two rows whose contents come from Anki rather than from this form. Read rather than
  // taken from a parameter, because this binder deliberately has no state argument — and needed at
  // all because the keyword chips would otherwise sit empty until the first storage change, which
  // on a quiet page is up to three seconds of the row looking broken.
  getState().then(paintWatchRows).catch(() => {});
}

// A number box that saves itself: quietly half a second after you stop typing,
// and at once when you leave it or press Enter. No Save buttons anywhere.
//
// `strictDir` says which way strict mode may move this number, and it is per-box
// because the boxes genuinely disagree about which way is stricter:
//
//   "down"  smaller is stricter. A shorter liveness interval asks more often, a
//           shorter auto-lock delay re-locks sooner, and fewer cards allowed to be
//           still due is a harder gate. Only decreases go through.
//   "up"    larger is stricter. A higher "% right" is harder to reach. Only
//           increases go through.
//
// None of these were guarded at all before, which let the liveness check be pushed
// out to half an hour mid-session.
function autoNum(id, key, lo, hi, fallback, strictDir) {
  const box = $("#" + id);
  if (!box) return;
  const clamp = () => {
    const raw = parseInt(box.value, 10);
    return Math.max(lo, Math.min(hi, Number.isFinite(raw) ? raw : fallback));
  };
  // Still the box that's on screen? Every render builds a new binder over new
  // elements, and a debounced save armed by the previous one would otherwise fire
  // half a second later, read the DETACHED input, and write that value over
  // whatever the user has since chosen. Typing 600 into the custom auto-lock box
  // and immediately clicking "Immediate" left the page saying Immediate and the
  // storage saying ten minutes. commitAnki has guarded this since an earlier round;
  // the same guard was never applied here.
  const stale = () => document.getElementById(id) !== box;
  const save = async (quiet) => {
    if (stale()) return;
    const v = clamp();
    const st = await getState();
    const cur = st[key] == null ? fallback : st[key];
    if (cur === v) return;                                     // nothing changed, nothing to say
    const loosening = (strictDir === "down" && v > cur) || (strictDir === "up" && v < cur);
    if (loosening && inStrictWindow(st)) {
      // Refuse it, but only put the box back once they have left it. Rewriting a box
      // someone is still typing in turns a refused intermediate into their new starting
      // point: with 80 stored and the whole box selected, typing 1-0-0 to mean 100 had the
      // "1" refused and the box reset to "80", so the next two digits made "8000".
      //
      // The in-range test on the mid-typing timer does not cover this — "1" is a perfectly
      // legal value, it is just not the number being typed yet. And no toast either: it
      // would fire every half second while someone is mid-number, for something that isn't
      // their answer yet.
      if (document.activeElement === box) return;
      box.value = String(cur);
      return toast("Strict mode is on. You can only make this stricter now.");
    }
    await setStateP({ [key]: v });
    if (!quiet) toast("Saved");
  };
  // What was stored is what the box should read — but only on the way out, never
  // mid-keystroke: snapping "3" up to "5" while you're still typing "30" would be
  // maddening.
  const settle = () => {
    const v = clamp();
    if (String(box.value) !== String(v)) box.value = String(v);
  };
  // The quiet mid-typing save only runs when what's in the box ALREADY sits inside
  // the allowed range. Clamping a half-typed number first turned an intermediate
  // keystroke into a legitimate value and stored it: with the liveness interval
  // (min 30) sitting at 180, typing "600" saved 30 on the first digit — which strict
  // mode read as a tightening and accepted — and then refused 60 and everything
  // after it as a loosening. The dial was pinned at 30 for the rest of the window
  // with no way back. Clamping belongs to settle(), on change and blur.
  const timerKey = "fgAutoNumTimer";
  const arm = () => {
    clearTimeout(box[timerKey]);
    box[timerKey] = setTimeout(() => {
      const raw = parseInt(box.value, 10);
      if (!Number.isFinite(raw) || raw < lo || raw > hi) return;   // still being typed
      save(true);
    }, 500);
  };
  box.addEventListener("input", arm);
  box.addEventListener("change", () => { clearTimeout(box[timerKey]); settle(); save(false); });
  box.addEventListener("blur", () => { clearTimeout(box[timerKey]); settle(); save(true); });
  box.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    e.preventDefault(); clearTimeout(box[timerKey]); settle(); save(false); box.blur();
  });
}

// ---- step 2: what stays locked until step 1 is done ----------------------
// ---- the sites on a list, as one scrollable field ------------------------------------------------
//
// A hundred sites used to be a hundred chips laid end to end, and the card grew with them until the
// blocking-mode radios, the phone fold and everything else on the page were somewhere below the fold.
// The list you were trying to read pushed the rest of the page off the screen.
//
// So the chips go in a box with a height cap and a scrollbar — see `.chips` in options.css, where the
// cap actually lives — with a small toolbar above it saying how many there are and offering the two
// things you cannot do one chip at a time: remove several, and remove the lot.
//
// PICKING IS A MODE rather than a permanent row of checkboxes, because a chip already has something to
// click: its name is a link that opens the site. A checkbox beside every one would either fight that
// link or shrink it. While picking, the link and the ✕ are both gone from the markup and the whole
// chip is the checkbox, so there is never a chip with two things to click.
//
// One key rather than a flag per list, because BOTH lists are in the DOM at once — one of them merely
// `hidden` — and only one of them can be picking. That is also what keeps the data-chippick handles
// unambiguous when the handlers are bound across the whole document.
//
// Module-level rather than stored, deliberately: this page re-renders whole sections through innerHTML
// and rebinds every handler, so anything transient has to live outside the DOM to survive. It is about
// this minute, not about setup, so it has no business in storage.
let chipSelKey = null;                 // "blockedSites" | "allowedSites" | null
const chipSel = new Set();             // which urls are ticked; only meaningful for chipSelKey
function chipBoxHtml(list, key) {
  if (!list.length) return "";
  const picking = chipSelKey === key;
  const delAttr = key === "blockedSites" ? "data-delb" : "data-dela";
  const n = list.length;
  const chips = list.map(b => {
    const u = String(b.url || "");
    if (!picking) {
      return `<span class="chip"><a class="chiplink" href="${escHtml(siteOpenUrl(u))}" target="_blank" rel="noopener noreferrer" data-open-pattern="${escHtml(u)}" title="Go to ${escHtml(u)}">${escHtml(u)}</a><span class="x" ${delAttr}="${escHtml(u)}" title="Remove" aria-label="Remove ${escHtml(u)}">✕</span></span>`;
    }
    const on = chipSel.has(u);
    return `<span class="chip pick${on ? " on" : ""}" role="checkbox" tabindex="0"
                  aria-checked="${on ? "true" : "false"}" data-chippick="${escHtml(u)}"
                  aria-label="${escHtml(u)}"
            ><span class="tick" aria-hidden="true">${on ? "✓" : ""}</span>${escHtml(u)}</span>`;
  }).join("");
  const head = picking
    ? `<span class="chipcount" data-chipn="${key}">${chipSel.size} of ${n} picked</span>
       <span class="grow"></span>
       <button class="chipbtn" type="button" data-chipall="${key}">All</button>
       <button class="chipbtn" type="button" data-chipnone="${key}">None</button>
       <button class="chipbtn danger" type="button" data-chipdel="${key}"
               ${chipSel.size ? "" : "disabled"}>Remove${chipSel.size ? " " + chipSel.size : ""}</button>
       <button class="chipbtn" type="button" data-chipcancel="${key}">Done</button>`
    : `<span class="chipcount">${n} site${n === 1 ? "" : "s"} on this list</span>
       <span class="grow"></span>
       <button class="chipbtn" type="button" data-chipsel="${key}"
               title="Tick several, then remove them in one go">Pick several</button>
       <button class="chipbtn danger" type="button" data-chipclear="${key}"
               title="Take every site off this list">Clear all</button>`;
  return `<div class="chipbox">
        <div class="chiphead">${head}</div>
        <div class="chips">${chips}</div>
      </div>`;
}

// ---- adding a whole category at once -------------------------------------------------------------
//
// Twenty ready-made groups of sites, so a blocklist does not have to be built one address at a time
// from memory. Pressing one writes its sites onto the list as ORDINARY ENTRIES — see SITE_CATEGORIES
// in settings.js for why it is data and nothing more — so they turn up as chips you can remove
// individually, nothing new is stored, and the background worker never learns categories exist.
//
// Which also decides what a second press does: with the whole set already on the list, it takes the
// whole set back off. A one-way chip would leave fifteen entries to remove by hand, which is the
// problem it exists to solve, pointing the other way.
//
// Folded away by default, and that is not a space saving: a wall of twenty chips above the one box
// most people type into would be the wrong first impression of a list you are supposed to fill
// yourself.
let catOpenFor = null;                 // "blockedSites" | "allowedSites" | null — which fold is open
// `state` is threaded in rather than read from a module-level cache, because this page has no such
// cache. The AI half below needs the stored settings, and reaching for a `lastState` that does not exist
// here is exactly what made this whole fold render empty: a ReferenceError inside a template literal
// takes the entire surrounding string with it, so one undefined name blanked the card rather than the
// line that used it.
function catPickerHtml(key, current, state) {
  const cats = (FGSettings.SITE_CATEGORIES || []);
  if (!cats.length) return "";
  const have = new Set((current || []).map(b => String(b.url || "").toLowerCase()));
  // Normalised through the same function the box uses, or the count would disagree with what pressing
  // it actually adds.
  const normed = (c) => c.sites.map(normSite).filter(Boolean);
  const open = catOpenFor === key;
  const allow = key === "allowedSites";
  const chips = cats.map(c => {
    const list = normed(c);
    const inList = list.filter(u => have.has(u.toLowerCase())).length;
    const full = list.length > 0 && inList === list.length;
    const some = inList > 0 && !full;
    return `<button type="button" class="catchip${full ? " full" : some ? " some" : ""}"
            data-cat="${key}|${c.id}" aria-pressed="${full ? "true" : "false"}"
            title="${full
              ? `All ${list.length} ${escHtml(c.name)} sites are on this list. Press to take them all off.`
              : some
                ? `${inList} of ${list.length} ${escHtml(c.name)} sites are on this list. Press to add the other ${list.length - inList}.`
                : `Add all ${list.length} ${escHtml(c.name)} sites to this list.`}">
            <span class="cic" aria-hidden="true">${c.icon}</span>
            <span class="cnm">${escHtml(c.name)}</span>
            <span class="ccount">${full ? "✓" : some ? `${inList}/${list.length}` : `+${list.length}`}</span>
          </button>`;
  }).join("");
  // How many groups are wholly on the list, so the badge reports STATE rather than counting the
  // inventory. "20 groups exist" is not something the page is holding you to, so it is drawn quiet.
  const onCount = cats.filter(c => {
    const list = normed(c);
    return list.length > 0 && list.every(u => have.has(u.toLowerCase()));
  }).length;
  // Body only when open, and that is not a space saving either: BOTH lists render this picker — the
  // blocklist card and the allowlist card are both in the DOM, one of them merely hidden — so
  // rendering both bodies would put every one of these buttons in the page twice. catOpenFor holds one
  // key, so only one body can exist.
  return `
    <div class="sect">
      <button class="secthead" type="button" data-catfold="${key}" aria-expanded="${open ? "true" : "false"}">
        ${CARET}
        <span class="ic" aria-hidden="true">🗂️</span>
        <span class="ttl">Add by category</span>
        <span class="cnt${onCount ? "" : " quiet"}">${onCount ? `${onCount} on` : `${cats.length} groups`}</span>
      </button>
      ${open ? `
      <div class="sectbody">
        <div class="catbody">
          <div class="cathint">${allow
            ? "Each press opens that whole group. On the allow list an entry opens <b>that exact site only</b> — write <span class='kbd'>*.example.com</span> in the box above for its subdomains too."
            : "Each press locks that whole group, subdomains included. Press again to unlock it. Anything a group misses goes in the box above."
          }<br/><br/><b>A group is never complete.</b> Fifteen social networks is not <i>social media</i>; it is fifteen doors shut in a corridor with no walls, and the one reached for at 1am is the sixteenth. Use the box above for whatever these miss.</div>
          <div class="catchips">${chips}</div>
          ${aiCatHtml(key, state)}
        </div>
      </div>` : ""}
    </div>`;
}

// ---- the AI half of the category picker ----
//
// The chips above add a list of well-known addresses: exact, instant, free, permanent, and only ever the
// addresses somebody thought of. This covers the corridor rather than the doors — every site you open is
// read by the model and sorted into categories — at the cost of a request per domain and a judgement that
// can be wrong.
//
// Deliberately inside the SAME fold as the chips rather than in a card of its own. They are two answers to
// one question, and separating them would leave somebody picking categories in two places without ever
// being told the difference.
function aiCatHtml(key, state) {
  const s = state || {};
  const cats = (FGSettings.SITE_CATEGORIES || []);
  const allow = key === "allowedSites";
  const on = s.aiCatEnabled === true;
  const picked = new Set(Array.isArray(allow ? s.aiCatAllow : s.aiCatBlock)
    ? (allow ? s.aiCatAllow : s.aiCatBlock) : []);
  // The other list's picks, so a category can never be on both — which would be a rule that contradicts
  // itself and whose outcome depended on the order the blocker happened to test them in.
  const other = new Set(Array.isArray(allow ? s.aiCatBlock : s.aiCatAllow)
    ? (allow ? s.aiCatBlock : s.aiCatAllow) : []);
  // The key of whichever service the video gate's Model row has picked — the classifier asks that same
  // service, so a Gemini key is no use to it while Groq is picked, and the other way round.
  const groq = aiProviderOfState(s) === "groq";
  const who = groq ? "Groq" : "Gemini";
  const hasKey = !!String((groq ? s.ytAiGroqKey : s.ytAiKey) || "").trim();
  const chips = cats.map(c => {
    const mine = picked.has(c.id), theirs = other.has(c.id);
    return `<button type="button" class="catchip ai${mine ? " full" : ""}${theirs ? " taken" : ""}"
            data-aicat="${key}|${c.id}" aria-pressed="${mine ? "true" : "false"}"
            ${theirs ? "disabled" : ""}
            title="${theirs
              ? `${escHtml(c.name)} is already on the other AI list, so it can't be on this one too.`
              : mine
                ? `On — any site the AI reads as ${escHtml(c.name)} is ${allow ? "allowed" : "locked"}, whether or not you listed it.`
                : `Off — press to ${allow ? "allow" : "lock"} every site the AI reads as ${escHtml(c.name)}.`}">
            <span class="cic" aria-hidden="true">${c.icon}</span>
            <span class="cnm">${escHtml(c.name)}</span>
            <span class="ccount">${mine ? "✓" : theirs ? "—" : "AI"}</span>
          </button>`;
  }).join("");
  return `
    <div class="aicat${on ? " on" : ""}">
      <div class="srow" style="padding:10px 0 4px">
        <span class="ic">🤖</span>
        <span class="lbl grow">AI category ${allow ? "allowing" : "locking"} ${tip(`<b>Every site you open is read by an AI and sorted into categories.</b> Pick the categories below and any site that belongs to one is ${allow ? "allowed" : "locked until today's Anki goal is done"} — including the thousands you would never think to type.<br/><br/><b>Why this sits beside the buttons above.</b> Those add a list of well-known addresses, which is exact, instant, free and permanent. It is also only ever the addresses somebody thought of: fifteen social networks is not "social media", it is fifteen doors shut in a corridor with no walls.<br/><br/><b>What it costs.</b> One question per <b>domain</b>, not per page — "youtube.com is a video site" is true of every address on it, so each site is asked about once and remembered for two months. It asks the same AI as the <b>video gate</b> — whichever of Gemini or Groq is picked under its <b>Model</b> row, right now <b>${who}</b> — with the same free key and the same daily allowance.<br/><br/><b>What it does when it cannot decide.</b> Nothing. A site not yet classified, a site the model does not recognise, no key, no internet, quota spent — every one of those leaves the site exactly as it would be without this feature. It never locks on a guess.<br/><br/><b>It can be wrong.</b> It is a language model reading a domain name. An explicit address in the box above always wins over it, so the fix for a misjudged site is to leave the category on and deal with that one site by hand.<br/><br/>A category can be on the locked list or the allowed list, never both.${allow ? "<br/><br/><b>On the allowed list this only does anything in allow-list mode</b>, where it plays the part an allowed address plays." : ""}`)}</span>
        <span class="cnt${on ? "" : " quiet"}">${!on ? "off" : !hasKey ? "no key" : picked.size ? picked.size + " on" : "none picked"}</span>
        <label class="sw">
          <input type="checkbox" id="aiCatSw" ${on ? "checked" : ""}
                 aria-label="AI category ${allow ? "allowing" : "locking"}"/>
          <span class="track"></span>
        </label>
      </div>
      ${on ? `
        ${hasKey ? "" : `<div class="cathint" style="color:var(--bad)">This needs the same AI key as the <b>video gate</b> — ${who} is picked there, so a ${who} API key. Add it in <b>Settings → Step 1</b> — until then nothing is classified and every site behaves as normal.</div>`}
        <div class="catchips">${chips}</div>` : ""}
    </div>`;
}

function renderBlocked(s) {
  const tc = document.getElementById("tabContent");
  const blocked = s.blockedSites || [];
  const allowed = s.allowedSites || [];
  const mode = s.blockMode || "blacklist";
  // Appended, so it can share the tab with step 1.
  tc.insertAdjacentHTML("beforeend", `
    <div class="card">
      <div class="chead">
        <span class="ctile step" aria-hidden="true">2</span>
        <div class="ctitle">
          <div class="crow">
            <h2>Blocked until Anki is done ${tip("These stay blocked until today's Anki goal in step 1 is finished — the time, and the card count if you asked for one.<br/><br/>Type an address like <span class='kbd'>instagram.com</span> and press <b>➕</b>. Press <b>✕</b> on a chip to remove it. Paste a whole list at once and commas or new lines will do as separators.<br/><br/><b>🔒 Blocklist:</b> only the sites you list get blocked. Everything else stays open. Best for most people.<br/><br/><b>✅ Allowlist:</b> the whole internet gets blocked <i>except</i> the sites you list. Very strict. Leave it <b>empty</b> and nothing at all is allowed.<br/><br/><b>How wide is one entry?</b> Blocking <span class='kbd'>youtube.com</span> also blocks <span class='kbd'>m.youtube.com</span>. Allowing <span class='kbd'>google.com</span> allows only Google — not <span class='kbd'>gemini.google.com</span>. Add <span class='kbd'>*.</span> in front to include subdomains either way.<br/><br/>Either way, your own files and the browser's own pages always stay open.")}</h2>
          </div>
          ${tickerHtml(lockTickerText(s), "lock")}
        </div>
        <span class="seg" role="group" aria-label="Blocking mode">
          <input type="radio" name="mode" id="mode-bl" value="blacklist" ${mode === "blacklist" ? "checked" : ""}/>
          <label for="mode-bl" title="Only the sites you add here are blocked. Everything else stays open."><span aria-hidden="true">🔒</span>Blocklist</label>
          <input type="radio" name="mode" id="mode-wl" value="whitelist" ${mode === "whitelist" ? "checked" : ""}/>
          <label for="mode-wl" title="Everything is blocked except the sites you add here."><span aria-hidden="true">✅</span>Allowlist</label>
        </span>
      </div>

      <div id="blacklistCard" ${mode === "whitelist" && !blocked.length ? "hidden" : ""}>
        ${mode !== "whitelist" ? "" : `<div class="emptyhint">🔒 <b>Still blocked in allowlist mode.</b> A blocked site beats an allowed one, so anything left here stays blocked even after you add it to the allowlist below. This card used to be hidden in allowlist mode, which made these rules invisible and impossible to remove — while they went on doing the blocking.</div>`}
        <div class="addrow">
          <span class="gicon" aria-hidden="true">🔒</span>
          <input class="input grow" id="newBlocked" placeholder="instagram.com, youtube.com, reddit.com" title="Add several at once by putting commas between them"/>
          <button class="btn round" id="addBlocked" title="Lock this site" aria-label="Lock this site">➕</button>
        </div>
        <!-- What is on the list sits directly under the field that fills it, so the two read as one
             thing. The category fold comes AFTER them: it is a full-width section like the phone fold
             below it, and putting it between the field and its own contents would split that pair. -->
        ${chipBoxHtml(blocked, "blockedSites")}
        ${catPickerHtml("blockedSites", blocked, s)}
      </div>

      <div id="whitelistCard" ${mode === "blacklist" ? "hidden" : ""}>
        <div class="addrow">
          <span class="gicon" aria-hidden="true">✅</span>
          <input class="input grow" id="newAllowed" placeholder="docs.google.com, wikipedia.org" title="Add several at once by putting commas between them"/>
          <button class="btn round" id="addAllowed" title="Allow this site" aria-label="Allow this site">➕</button>
        </div>
        <!-- Said where the typing happens, not only in a tooltip on the heading. The rule is not
             obvious and getting it wrong is expensive: it is the difference between opening one site
             and opening a whole company's worth of them. -->
        <div class="emptyhint">✅ <b>Exactly the site you name.</b> <span class="kbd">google.com</span> opens Google and nothing else — not <span class="kbd">gemini.google.com</span>, not <span class="kbd">keep.google.com</span>. Write <span class="kbd">*.google.com</span> if you really do want every subdomain. (The blocklist is the other way round on purpose: blocking a site covers its subdomains too.)</div>
        ${!allowed.length ? `<div class="emptyhint">Nothing is allowed yet, so every site is blocked until Anki is done.</div>` : chipBoxHtml(allowed, "allowedSites")}
        ${catPickerHtml("allowedSites", allowed, s)}
      </div>

      <!-- Apps on your phone are one more thing being locked until Anki is done, so they belong in
           this card rather than in one of their own down in Setup. Folded away, because most
           people never wire a phone up. -->
      ${phoneSectionHtml(s)}
    </div>`);

  document.querySelectorAll('input[name="mode"]').forEach(r => r.addEventListener("change", async () => {
    const st = await getState();
    if (inStrictWindow(st)) { renderApp(); return toast("Strict mode is on. You cannot swap the list now."); }
    await setStateP({ blockMode: r.value });
    renderApp();
    // Say what actually happened. An empty allow list means every open tab gets
    // locked at once, and the count proves it rather than leaving you guessing.
    const toAllow = r.value === "whitelist";
    const emptyAllow = !(st.allowedSites || []).length;
    chrome.runtime.sendMessage({ type: "refreshBlockedTabs" }, (res) => {
      void chrome.runtime.lastError;
      const n = (res && res.locked) || 0;
      const tabs = n === 1 ? "1 tab" : n + " tabs";
      if (st.enabled === false) {
        return toast("This extension is switched off, so nothing is blocked. Turn it on from its toolbar icon.");
      }
      if (toAllow && emptyAllow) {
        return toast(n
          ? "Allowlist on · nothing is allowed yet, so " + tabs + " locked"
          : "Allowlist on · nothing is allowed yet, so every site is blocked");
      }
      toast(n ? "Saved · " + tabs + " locked" : "Saved");
    });
  }));

  // Both lists take one site or a whole pasted list in one go.
  // `loosens` says whether this list growing makes the gate weaker. Adding to the
  // blocklist blocks more; adding to the allowlist opens more.
  // `rawText`, when given, is used instead of the box: an address the right-click menu sent (see
  // menuAllow). Everything after that is the same, the strict-mode refusal and the password included.
  async function addToList(key, boxId, refuseMsg, loosens, rawText) {
    const st = await getState();
    if (loosens && inStrictWindow(st)) return toast(refuseMsg);
    const raws = splitSites(rawText != null ? rawText : $("#" + boxId).value);
    if (!raws.length) return;
    const cur = st[key] || [];
    const seen = new Set(cur.map(b => String(b.url || "").toLowerCase()));
    const add = [];
    let dupes = 0;
    raws.forEach(raw => {
      const v = normSite(raw);
      if (!v) return;
      const k = v.toLowerCase();
      if (seen.has(k)) { dupes++; return; }
      seen.add(k);
      add.push({ url: v });
    });
    if (!add.length) return toast(addedToast(0, dupes));
    await setStateP({ [key]: [...cur, ...add] });
    tellWorker({ type: "refreshBlockedTabs" });
    renderApp();
    // An allowed site that is also on the blocklist will not open — a blocked entry
    // beats an allowed one, by design. Saying "Added ✓" and leaving the site blocked
    // with no explanation is the part that was wrong.
    if (key === "allowedSites") {
      const blockedNow = new Set((st.blockedSites || []).map(b => String(b.url || "").toLowerCase()));
      const shadowed = add.map(a => a.url).filter(u => blockedNow.has(u.toLowerCase()));
      if (shadowed.length) {
        return toast(shadowed[0] + " is on the blocked list too, so it stays blocked. Remove it from 🔒 above to open it.");
      }
      // Sent from the right-click menu in blocklist mode, where the allowed list is not even on screen:
      // said where it went and when it counts, or it would look as though nothing had happened.
      if (rawText != null && (st.blockMode || "blacklist") !== "whitelist") {
        return toast(addedToast(add.length, dupes) + " to your allowed sites · this list is what ✅ Allowlist mode opens — in 🔒 Blocklist mode only blocked sites count",
                     { cls: "wide", ms: 6000 });
      }
    }
    toast(addedToast(add.length, dupes));
  }
  $("#addBlocked")?.addEventListener("click", () =>
    addToList("blockedSites", "newBlocked", "", false));
  $("#addAllowed")?.addEventListener("click", () =>
    addToList("allowedSites", "newAllowed", "Strict mode is on. You cannot allow another site now.", true));
  // For the right-click menu's hand-over — see menuAllow.
  menuAllowRun = (raw) =>
    addToList("allowedSites", "newAllowed", "Strict mode is on. You cannot allow another site now.", true, raw);

  // ---- which direction strict mode allows -------------------------------
  // Strict mode exists to stop you weakening your own rules mid-session, so the
  // only test that matters is "does this make things stricter or looser".
  //
  // This was backwards. Taking a site OFF the blocklist unblocks it — that is the
  // loosening move, and it was completely unguarded: one click during a strict
  // window and the site opened, with the tab sent straight back to it. Meanwhile
  // ADDING to the blocklist, which only ever tightens, was refused. The comment
  // that used to sit here asserted the opposite of what the code did, which is
  // presumably how it survived.
  //
  //   blocklist  + add    → fewer sites reachable  → tighten → allowed
  //   blocklist  − remove → a site becomes open    → loosen  → refused
  //   allowlist  + add    → a site becomes open    → loosen  → refused
  //   allowlist  − remove → fewer sites reachable  → tighten → allowed
  document.querySelectorAll("[data-delb]").forEach(b => onActivate(b, async () => {
    const st = await getState();
    if (inStrictWindow(st)) return toast("Strict mode is on. You cannot unblock a site now.");
    const url = b.getAttribute("data-delb");
    await setStateP({ blockedSites: (st.blockedSites || []).filter(x => x.url !== url) });
    tellWorker({ type: "refreshBlockedTabs" });
    renderApp();
  }));
  // onActivate, not a bare click listener. Its two siblings ([data-delb] above and
  // [data-deck-del]) both use it, and this one was missed — so it had no role, no
  // tabindex and no Enter/Space, which meant removing a site from the allowlist was
  // impossible without a mouse. Its aria-label was being dropped too: an element
  // with no role is `generic`, and a generic element cannot carry a name.
  document.querySelectorAll("[data-dela]").forEach(b => onActivate(b, async () => {
    // Shortening the allowlist only ever closes things off, so this one stands
    // during a strict window.
    const url = b.getAttribute("data-dela");
    const cur = (await getState()).allowedSites || [];
    await setStateP({ allowedSites: cur.filter(x => x.url !== url) });
    tellWorker({ type: "refreshBlockedTabs" });
    renderApp();
  }));

  // ---- removing several sites at once -----------------------------------
  //
  // One writer for both lists, because they are the same act at two sizes and both have to be judged
  // the same way: taking sites OFF the blocklist is a loosening and is refused during a strict window,
  // and shortening the allowlist is a tightening and always stands. Exactly the asymmetry the two
  // single-chip handlers above document, applied to a set instead of one entry.
  async function chipRemove(key, gone) {
    if (!gone.size) return;
    const st = await getState();
    if (key === "blockedSites" && inStrictWindow(st)) {
      return toast("Strict mode is on. You cannot unblock sites now.");
    }
    const cur = st[key] || [];
    const next = cur.filter(x => !gone.has(String(x.url || "")));
    if (next.length === cur.length) { renderApp(); return; }   // nothing matched; put the view straight
    try {
      await setStateP({ [key]: next });
    } catch (e) {
      renderApp();                                             // refused: setStateP has said why
      return;
    }
    chipSelKey = null;
    chipSel.clear();
    // Off the blocklist means open NOW, and off the allowlist means shut now. Neither should wait for
    // the next minute tick.
    tellWorker({ type: "refreshBlockedTabs" });
    renderApp();
    const n = cur.length - next.length;
    toast(`Removed ${n} site${n === 1 ? "" : "s"}`);
  }
  // The toolbar's count and its Remove button, patched in place rather than through renderApp.
  //
  // That is the point rather than an optimisation: a box of two hundred chips redrawn on every tick is
  // a box that feels stuck, and nothing else on the page is derived from which chips are ticked — so
  // there is nothing else to keep in step.
  function paintChipHead() {
    const key = chipSelKey;
    if (!key) return;
    const lab = document.querySelector(`[data-chipn="${key}"]`);
    const total = document.querySelectorAll("[data-chippick]").length;
    if (lab) lab.textContent = `${chipSel.size} of ${total} picked`;
    const del = document.querySelector(`[data-chipdel="${key}"]`);
    if (del) {
      del.disabled = chipSel.size === 0;
      del.textContent = "Remove" + (chipSel.size ? " " + chipSel.size : "");
    }
  }
  document.querySelectorAll("[data-chipsel]").forEach(b => b.addEventListener("click", () => {
    chipSelKey = b.getAttribute("data-chipsel");
    chipSel.clear();
    renderApp();
  }));
  document.querySelectorAll("[data-chipcancel]").forEach(b => b.addEventListener("click", () => {
    chipSelKey = null;
    chipSel.clear();
    renderApp();
  }));
  document.querySelectorAll("[data-chipall]").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll("[data-chippick]").forEach(el => chipSel.add(el.getAttribute("data-chippick")));
    renderApp();
  }));
  document.querySelectorAll("[data-chipnone]").forEach(b => b.addEventListener("click", () => {
    chipSel.clear();
    renderApp();
  }));
  document.querySelectorAll("[data-chippick]").forEach(el => {
    const pick = (e) => {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      const url = el.getAttribute("data-chippick");
      if (chipSel.has(url)) chipSel.delete(url); else chipSel.add(url);
      const on = chipSel.has(url);
      el.classList.toggle("on", on);
      el.setAttribute("aria-checked", on ? "true" : "false");
      const t = el.querySelector(".tick");
      if (t) t.textContent = on ? "✓" : "";
      paintChipHead();
    };
    el.addEventListener("click", pick);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") pick(e); });
  });
  // No confirmation on this one, on purpose: ticking each chip WAS the confirmation, and a dialog on
  // top of a decision somebody has just made by hand is one question asked twice.
  document.querySelectorAll("[data-chipdel]").forEach(b => b.addEventListener("click", async () => {
    await chipRemove(b.getAttribute("data-chipdel"), new Set(chipSel));
  }));
  // This one does ask, because a single press stands for every entry and nothing on screen says which.
  document.querySelectorAll("[data-chipclear]").forEach(b => b.addEventListener("click", async () => {
    const key = b.getAttribute("data-chipclear");
    const cur = (await getState())[key] || [];
    if (!cur.length) return;
    const allow = key === "allowedSites";
    // A short countdown and an explicit press, but no typed phrase. The friction should be
    // proportional: this destroys a list that could have taken a while to build, so it is worth a
    // speed bump — but nothing measured is being lost, and demanding a sentence for something you can
    // rebuild by pressing two category chips would be the wrong shape of friction. See confirmReset,
    // where the three kinds and what each is for are written out.
    if (!await confirmReset({
      title: `Clear all ${cur.length} sites?`,
      body: allow
        ? "Every site comes off your allowlist. With the allowlist empty and that mode on, nothing at all is allowed until you add something back."
        : "Every site comes off your blocked list, so all of them open again straight away.",
      phrase: "", wait: 2, go: "Clear all", keep: "Keep them"
    })) return;
    await chipRemove(key, new Set(cur.map(x => String(x.url || ""))));
  }));

  // ---- whole categories --------------------------------------------------
  document.querySelectorAll("[data-catfold]").forEach(b => b.addEventListener("click", () => {
    const key = b.getAttribute("data-catfold");
    catOpenFor = catOpenFor === key ? null : key;
    renderApp();
  }));
  document.querySelectorAll("[data-cat]").forEach(b => b.addEventListener("click", async () => {
    const [key, catId] = String(b.getAttribute("data-cat") || "").split("|");
    const cat = (FGSettings.SITE_CATEGORIES || []).find(c => c.id === catId);
    if (!cat || (key !== "blockedSites" && key !== "allowedSites")) return;
    // Through the same normaliser the box uses, so what a chip adds and what its count claimed it
    // would add are the same strings.
    const want = cat.sites.map(normSite).filter(Boolean);
    const st = await getState();
    const cur = st[key] || [];
    const have = new Set(cur.map(x => String(x.url || "").toLowerCase()));
    const missing = want.filter(u => !have.has(u.toLowerCase()));
    // A chip is a toggle: with the whole set already in, press it to take the whole set back out.
    const removing = missing.length === 0;
    // Which direction this is, and it is OPPOSITE for the two lists — which is why it is decided here
    // rather than assumed. Adding to the BLOCKED list shuts more doors and is a tightening; adding to
    // the ALLOWED list opens them and is a loosening. Removing is each of those backwards.
    const loosening = removing ? (key === "blockedSites") : (key === "allowedSites");
    if (loosening && inStrictWindow(st)) {
      return toast(key === "blockedSites"
        ? "Strict mode is on. You cannot unblock sites now."
        : "Strict mode is on. You cannot allow more sites now.");
    }
    let next;
    if (removing) {
      const drop = new Set(want.map(u => u.toLowerCase()));
      next = cur.filter(x => !drop.has(String(x.url || "").toLowerCase()));
    } else {
      next = [...cur, ...missing.map(url => ({ url }))];
    }
    try {
      await setStateP({ [key]: next });
    } catch (e) {
      return;                                    // refused: nothing written, nothing to put back
    }
    // Sites arriving on or leaving either list changes what should be locked, so the tabs already open
    // are re-checked now rather than at the next minute tick.
    tellWorker({ type: "refreshBlockedTabs" });
    renderApp();
    const nm = cat.name.toLowerCase();
    if (removing) {
      return toast(key === "blockedSites"
        ? `${cat.icon} ${cat.name} unlocked — ${want.length} sites off the list`
        : `${cat.icon} ${cat.name} taken off the allowlist`);
    }
    const added = missing.length;
    toast(key === "allowedSites"
      ? `${cat.icon} ${added} ${nm} site${added === 1 ? "" : "s"} allowed`
      : `${cat.icon} ${added} ${nm} site${added === 1 ? "" : "s"} locked`);
  }));

  // ---- the AI half of the same picker ----
  //
  // The master switch needs the picked service's origin, and it has to be asked for BEFORE the write:
  // setStateP can raise a password dialog, and awaiting that first spends the user gesture
  // chrome.permissions.request needs. The same order the video gate's own switch uses, for the same
  // reason.
  $("#aiCatSw")?.addEventListener("change", async () => {
    const box = $("#aiCatSw");
    const want = !!(box && box.checked);
    // Asked for inline rather than through askAiOrigin, which is a nested function belonging to another
    // handler and not in scope here. Two lines, and a reference that cannot be broken by somebody moving
    // that function — a wrong guess about scope in a permission check fails at the worst possible moment,
    // which is the first time anybody switches the feature on.
    //
    // Which origin is the video gate's Model row's decision: the classifier asks the same service, so it
    // needs the same one address and no other. Read from storage, which is only a quick local read and
    // leaves the gesture intact — this page has no picker of its own to read instead.
    const provider = aiProviderOfState(await getState());
    const pattern = aiOriginPatternOf(provider);
    let gotOrigin = true;
    if (want) {
      try {
        gotOrigin = await chrome.permissions.contains({ origins: [pattern] }) ||
                    await chrome.permissions.request({ origins: [pattern] });
      } catch (e) { gotOrigin = false; }
    }
    if (want && !gotOrigin) {
      if (box) box.checked = false;
      return toast("Not switched on — it needs permission to reach " + (provider === "groq" ? "Groq's API" : "Google's API"));
    }
    try { await setStateP({ aiCatEnabled: want }); } catch (e) { renderApp(); return; }
    // Switching it on can lock sites that are open right now, and switching it off has to release them.
    // Neither should wait for the next sweep.
    tellWorker({ type: "refreshBlockedTabs" });
    renderApp();
    if (!want) return toast("AI category locking off — only the addresses you listed are used");
    const st = await getState();
    const groq = aiProviderOfState(st) === "groq";
    if (!String((groq ? st.ytAiGroqKey : st.ytAiKey) || "").trim()) {
      return toast(`On, but there's no ${groq ? "Groq" : "Gemini"} API key yet — add one in Settings → Step 1`, { ms: 6000 });
    }
    toast("On — now pick the categories below", { ms: 4000 });
  });
  document.querySelectorAll("[data-aicat]").forEach(b => b.addEventListener("click", async () => {
    const [key, catId] = String(b.getAttribute("data-aicat") || "").split("|");
    const cat = (FGSettings.SITE_CATEGORIES || []).find(c => c.id === catId);
    if (!cat || (key !== "blockedSites" && key !== "allowedSites")) return;
    const listKey = key === "allowedSites" ? "aiCatAllow" : "aiCatBlock";
    const otherKey = listKey === "aiCatAllow" ? "aiCatBlock" : "aiCatAllow";
    const st = await getState();
    const cur = Array.isArray(st[listKey]) ? st[listKey] : [];
    const other = Array.isArray(st[otherKey]) ? st[otherKey] : [];
    // Refused rather than silently moved. A category on both lists is a rule that contradicts itself, and
    // quietly taking it off the other one would undo a decision made elsewhere on this page.
    if (other.includes(catId)) {
      return toast(`${cat.icon} ${cat.name} is on the other AI list — take it off there first`, { ms: 4500 });
    }
    const had = cur.includes(catId);
    // Same direction rule as the chips above, and opposite for the two lists: adding to the LOCKED list
    // shuts more of the web, adding to the ALLOWED list opens it.
    const loosening = had ? (listKey === "aiCatBlock") : (listKey === "aiCatAllow");
    if (loosening && inStrictWindow(st)) {
      return toast(listKey === "aiCatBlock"
        ? "Strict mode is on. You cannot unlock a category now."
        : "Strict mode is on. You cannot allow more now.");
    }
    const next = had ? cur.filter(x => x !== catId) : [...cur, catId];
    try { await setStateP({ [listKey]: next }); } catch (e) { return; }
    tellWorker({ type: "refreshBlockedTabs" });
    renderApp();
    const verb = listKey === "aiCatAllow" ? "allowed" : "locked";
    toast(had
      ? `${cat.icon} ${cat.name} no longer ${verb} by AI`
      : `${cat.icon} Every site the AI reads as ${cat.name.toLowerCase()} is now ${verb}`, { ms: 4500 });
  }));

  bindPhoneSection();
}

// ---- apps on your phone, blocked through MacroDroid ----------------------
//
// Three controls and two addresses. Everything about WHY it is shaped this way — no list of apps
// on this side, two separate webhooks, what leaves the computer — is in the MacroDroid section of
// background.js, which is where the sending actually happens.
//
// The long "?" on the heading is the setup instructions, and it has to be: this is the only feature
// in the extension that needs something installed somewhere else, so a user who cannot follow it
// from this page cannot follow it at all.

// What the phone is actually doing, as opposed to what you asked for. The only line on this page
// that reports a fact rather than a setting, which is why it is worth the room: with a webhook you
// cannot see, "did that work?" is otherwise unanswerable.
function phoneStateText(s) {
  if (s.macrodroidEnabled !== true) return "Off. Nothing is sent to your phone.";
  // Named separately, because they fail in opposite directions and the second one is the dangerous
  // one: a missing lock address is a feature quietly doing nothing, a missing unlock address is
  // apps that get blocked and never released.
  if (!String(s.macrodroidLockUrl || "").trim()) {
    return "⚠️ No lock address, so nothing on your phone is ever blocked.";
  }
  if (!String(s.macrodroidUnlockUrl || "").trim()) {
    return "⚠️ No unlock address — your apps would be blocked with nothing to release them.";
  }
  const want = FGGates.phoneLockWanted(s);
  // `!==` catches "nothing pushed yet" (null) as well as a genuine mismatch, and both mean the same
  // thing to the reader: what you are looking at has not reached the phone.
  if (s.mobileLockSent !== want) {
    return (want ? "Apps should be blocked" : "Apps should be open") +
           " — not delivered yet. Tried again every minute.";
  }
  return (want ? "🔒 Apps blocked on your phone." : "🔓 Apps open on your phone.") +
         phoneSentAgo(s.mobileLockAt);
}
function phoneSentAgo(at) {
  const ms = Date.now() - (Number(at) || 0);
  if (!at || ms < 0) return "";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return " Sent just now.";
  if (mins < 60) return ` Sent ${mins} minute${mins === 1 ? "" : "s"} ago.`;
  const hrs = Math.floor(mins / 60);
  return ` Sent ${hrs} hour${hrs === 1 ? "" : "s"} ago.`;
}
// Repainted in place rather than by re-rendering the card. The worker writes mobileLockSent from a
// background fetch, which can land at any moment — including while you are half way through typing
// an address — and a redraw would take the caret out of the box.
async function paintPhoneState(state) {
  const el = $("#mdState");
  if (!el) return;
  const s = state || await getState();
  el.textContent = phoneStateText(s);
}

// Why a send failed, in words that name the fix. "Could not reach your phone" is the wrong sentence
// for a mistyped address, and it is the sentence somebody spends an evening on.
function phoneSendError(r) {
  const e = (r && r.error) || "unreachable";
  if (e === "locked") return "Settings are locked — password needed to test 🔒";
  if (e === "empty") return "Put the address in first";
  if (e === "bad_url") return "That isn't a web address — it should start with https://";
  if (e === "no_permission") return "Chrome hasn't been given permission to call that address";
  if (e === "off") return "Switch phone blocking on first";
  if (e.slice(0, 5) === "http_") {
    return "That address answered " + e.slice(5) + " — check you copied the whole webhook from MacroDroid";
  }
  return "Could not reach your phone. Is it online, with MacroDroid running?";
}
// sendMessage with an answer, as a promise. The rest of this page uses the callback form, but the
// phone flow is three steps deep — ask, maybe request a permission, ask again — and callbacks
// nested that far are where mistakes hide.
function askWorker(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; resolve(r || null); });
    } catch { resolve(null); }
  });
}
// Ask Chrome for access to one host, at the moment the user pressed the button that needs it.
//
// trigger.macrodroid.com is granted in the manifest, so the ordinary setup never gets here. This is
// for the other legitimate shapes — a self-hosted relay, or MacroDroid's own LAN "HTTP Server
// Request" trigger — which are in optional_host_permissions instead. permissions.request needs a
// real user gesture, and a click on ▶ or 🔄 is one; asking up front for every address on the
// internet, to cover a case most people will never use, is the alternative and it is worse.
function askHostPermission(origin) {
  return new Promise((resolve) => {
    try {
      chrome.permissions.request({ origins: [origin] }, (ok) => {
        void chrome.runtime.lastError;
        resolve(!!ok);
      });
    } catch { resolve(false); }
  });
}
// Send, and if the only thing stopping it was a permission, ask for that and send again. One
// retry, never a loop: if the user says no, the answer is no.
async function phoneSend(msg) {
  let r = await askWorker(msg);
  if (r && r.error === "no_permission" && r.origin) {
    if (!(await askHostPermission(r.origin))) return r;
    r = await askWorker(msg);
  }
  return r;
}

function phoneSectionHtml(s) {
  const strict = inStrictWindow(s);
  const on = s.macrodroidEnabled === true;
  return `
      <div class="sect">
        <div class="sechead">
          <button class="secthead" type="button" id="phoneHead" aria-expanded="${phoneOpen ? "true" : "false"}" aria-controls="phoneBody">
            ${CARET}
            <span class="ic" aria-hidden="true">📱</span>
            <span class="ttl">Apps on my phone</span>
            <span class="cnt" id="phoneCnt">${on ? "on" : "off"}</span>
          </button>
          ${tip(`<b>What this does</b><br/>Blocks the apps you choose on your <b>Android phone</b> while today's Anki is unfinished — the same rule that blocks the sites above, on the same schedule. Finish your goal and your phone releases itself.<br/><br/>
<b>Why it needs an app on the phone</b><br/>Nothing in a browser can block anything on a phone. So the phone does its own blocking: a free app called <b>MacroDroid</b> listens for a web address being called, and does the blocking itself. No account, no cable, no root, and this extension never learns which apps you picked.<br/><br/>
<b>Set it up once — three macros</b><br/>Two of them only flip a switch; the third does the blocking. Splitting it that way means you can add or drop apps later without ever touching the addresses again. In MacroDroid's trigger and action pickers there is a <b>search box</b> — the names in <span class='kbd'>this style</span> below are what to search for.<ol>
<li>Install <b>MacroDroid</b> from the Play Store.</li>
<li><b>Macro 1, "lock".</b> Trigger <span class='kbd'>Webhook (URL)</span>, identifier <span class='kbd'>lock</span> — letters and numbers only, anything fancier can misbehave. First action <span class='kbd'>Set Variable</span>: create a <b>global boolean</b> variable named <span class='kbd'>studying</span> and set it <b>true</b>. It has to be <b>global</b>, not local — three macros share this one value, and a local one is invisible to the other two. Copy the webhook address it shows you.</li>
<li><b>Still macro 1 — get thrown out of the app you are already in.</b> Do not skip this. Macro 3 below only fires when an app is <i>launched</i>, so an app that was already open when the lock arrived would just carry on playing; this is the step that closes that hole. Add a second action <span class='kbd'>If</span>, comparing the magic text <span class='kbd'>{fg_app_package}</span> — <b>contains</b> <span class='kbd'>instagram</span>, plus an <b>OR</b> line for each other app you are blocking. Inside the If put <span class='kbd'>Launch Home Screen</span>, then <span class='kbd'>End If</span>. The If is what stops every lock booting you out of whatever you happened to be doing — at the daily reset that would be your alarm clock.</li>
<li><b>Macro 2, "unlock".</b> The same again with identifier <span class='kbd'>unlock</span>, but pick the <span class='kbd'>studying</span> variable you just made — don't create a second one — and set it <b>false</b>. Copy that address too.</li>
<li><b>Macro 3, the blocker.</b> Trigger <span class='kbd'>Application Launched</span> — tick every app you want shut. Action <span class='kbd'>Launch Home Screen</span>, so opening one bounces you straight back out (put a <span class='kbd'>Display Toast</span> before it if you want a reason on screen). Then add a <b>constraint</b>: variable <span class='kbd'>studying</span> is <b>true</b>. That constraint is the whole point — it is what makes the blocking stop by itself when Anki is done.</li>
<li>Paste the two addresses into the boxes here — 🔒 takes <b>lock</b>, 🔓 takes <b>unlock</b> — then turn the switch on.</li>
<li>Press <b>▶ Test</b> beside each box, then try opening one of those apps on your phone to check macro 3 does what you meant.</li></ol>
<b>What MacroDroid needs from Android</b><br/>Accessibility access, so it can notice an app opening, and battery optimisation turned <b>off</b> for MacroDroid, so Android doesn't kill it while you study. It asks for both when a macro first needs them.<br/><br/>
<b>What happens then</b><br/>While Anki is unfinished this calls your <b>lock</b> address; the moment every condition in step 1 is met it calls <b>unlock</b>. It repeats about once a minute, so a phone that was offline or asleep catches up by itself.<br/><br/>
<b>Your apps are also released</b> if you switch this extension off, on a day you marked as a rest day, or if you clear today's goal. Your phone opens exactly when your sites open — never later. It has to work that way: a browser extension cannot reach a phone it has stopped talking to.<br/><br/>
<b>What leaves this computer</b><br/>Only a call to the address you pasted in, carrying the word <span class='kbd'>locked</span> or <span class='kbd'>unlocked</span>. No cards, no decks, no browsing, nothing that identifies you. It is the only request this extension makes that isn't to your own machine.<br/><br/>
<b>If it arrives a second or two late</b><br/>That is MacroDroid's cloud, not this end — its webhooks travel by Firebase, and a dozing phone takes a moment to wake. Turning battery optimisation off for MacroDroid is what fixes most of it. If you want it genuinely instant and your phone is on the same wifi as this computer, use MacroDroid's <span class='kbd'>HTTP Server Request</span> trigger instead of <span class='kbd'>Webhook (URL)</span>: its address looks like <span class='kbd'>http://your-phone-ip:8080/lock</span> and skips the cloud altogether. Both boxes accept one. Chrome will ask permission the first time you press <b>▶ Test</b> on an address like that — and reserve the phone's IP in your router, or it will change under you.<br/><br/>
<b>Both boxes save themselves</b> as you type — there is no Save button. <b>🔄 Sync</b> sends today's real state again if your phone missed one.${strict ? "<br/><br/><b style='color:var(--bad)'>Strict mode is on, so you can set this up or make it stricter, but not switch it off.</b>" : ""}`)}
        </div>
        <div class="sectbody" id="phoneBody" ${phoneOpen ? "" : "hidden"}>
          <div class="srow sub">
            <span class="ic">📱</span>
            <span class="lbl grow">Block apps on my phone too ${tip("Turn this on once the two addresses below are filled in. The full walkthrough is in the <b>?</b> beside this section's title.<br/><br/>Switching it <b>off</b> asks for your password and is refused while strict mode is on — it is one less thing being locked.<br/><br/>Switching it <b>on</b> needs no password, but it does ask you to confirm. Every other switch on this page changes what this browser does, and you are looking at the browser; this one reaches your phone, where the next thing that happens is an app refusing to open in another room with nothing on screen here to explain it.")}</span>
            ${sw("mdEnabled", on, strict, "Block apps on my phone too")}
          </div>
          <div class="srow sub">
            <span class="ic">🔒</span>
            <input class="input grow" id="mdLockUrl" type="url" inputmode="url" spellcheck="false"
                   placeholder="Lock address — blocks the apps"
                   aria-label="MacroDroid lock address"
                   title="${editLocked ? "Password needed to edit lock address 🔒" : "The webhook address of the MacroDroid macro that blocks your apps"}"
                   value="${escHtml(s.macrodroidLockUrl || "")}"
                   ${editLocked ? "readonly style='cursor:pointer;'" : ""}/>
            <button class="btn sec" id="mdTestLock"
                    title="${editLocked ? "Password needed to test 🔒" : "Call the lock address now and watch your phone"}"
                    ${editLocked ? "style='opacity:.5;cursor:pointer;'" : ""}>▶ Test</button>
          </div>
          <div class="srow sub">
            <span class="ic">🔓</span>
            <input class="input grow" id="mdUnlockUrl" type="url" inputmode="url" spellcheck="false"
                   placeholder="Unlock address — stops blocking"
                   aria-label="MacroDroid unlock address"
                   title="${editLocked ? "Password needed to edit unlock address 🔒" : "The webhook address of the MacroDroid macro that stops blocking"}"
                   value="${escHtml(s.macrodroidUnlockUrl || "")}"
                   ${editLocked ? "readonly style='cursor:pointer;'" : ""}/>
            <button class="btn sec" id="mdTestUnlock"
                    title="${editLocked ? "Password needed to test 🔒" : "Call the unlock address now and watch your phone"}"
                    ${editLocked ? "style='opacity:.5;cursor:pointer;'" : ""}>▶ Test</button>
          </div>
          <div class="srow sub">
            <span class="ic"></span>
            <span class="lbl hint grow" id="mdState" role="status">${escHtml(phoneStateText(s))}</span>
            <button class="btn sec" id="mdSync"
                    title="${editLocked ? "Password needed to sync 🔒" : "Send today's state to your phone right now"}"
                    ${editLocked ? "style='opacity:.5;cursor:pointer;'" : ""}>🔄 Sync</button>
          </div>
        </div>
      </div>`;
}

function bindPhoneSection() {
  $("#phoneHead")?.addEventListener("click", () => {
    phoneOpen = !phoneOpen;
    $("#phoneHead").setAttribute("aria-expanded", phoneOpen ? "true" : "false");
    const body = $("#phoneBody");
    if (body) body.hidden = !phoneOpen;
  });

  // No Save button, like the rest of this page: the switch writes at once, the two addresses write
  // half a second after you stop typing.
  async function saveMobile() {
    // The card can have left the screen while the timer was armed — another tab, a re-render. The
    // same trap commitAnki guards against, and with the same consequence if it isn't: reading a
    // form that no longer exists would write two empty addresses over two good ones.
    if (!$("#mdEnabled") || !$("#mdLockUrl") || !$("#mdUnlockUrl")) return;
    const st = await getState();
    const want = {
      macrodroidEnabled: !!$("#mdEnabled").checked,
      macrodroidLockUrl: ($("#mdLockUrl").value || "").trim(),
      macrodroidUnlockUrl: ($("#mdUnlockUrl").value || "").trim()
    };
    // Already stored? Then there is nothing to do, and saying so early is not merely an economy.
    // These events overlap by design — Enter saves and then blurs, and a blur fires `change`, which
    // would save the same thing again — and a second write of a LOOSENING patch means a second
    // password prompt for one edit. It also stops every stray `change` re-sending to the phone.
    if (want.macrodroidEnabled === (st.macrodroidEnabled === true) &&
        want.macrodroidLockUrl === String(st.macrodroidLockUrl || "") &&
        want.macrodroidUnlockUrl === String(st.macrodroidUnlockUrl || "")) return;

    // Judged one key at a time by direction, the way commitAnki does it, rather than refusing the
    // save as a block. Switching this on, or filling the lock address in for the first time, both
    // make MORE of your day unavailable, so both go through during a strict window. Switching it
    // off, or clearing the lock address — which stops the blocking while leaving the switch looking
    // on — are the loosenings, and only those are refused. A blanket check here would freeze all
    // three and refuse you the one direction strict mode exists to encourage.
    const strict = inStrictWindow(st);
    const patch = {};
    const refused = [];
    for (const [k, v] of Object.entries(want)) {
      if (strict && FGSettings.loosensKey(k, v, st[k])) refused.push(k);
      else patch[k] = v;
    }
    if (Object.keys(patch).length) {
      // Cleared on every save, so the next sync definitely re-sends. Without it, correcting a typo
      // in an address is followed by silence: the worker still believes it has already pushed this
      // state, so it would skip the very send that would prove the fix worked.
      patch.mobileLockSent = null;
      // Switching phone app blocking ON always asks, whether or not settings are locked.
      //
      // Every other switch on this page changes what this browser does, and you are looking at the
      // browser — flip one by accident and you see the result. This one reaches a different device:
      // the next thing that happens is apps on your phone refusing to open, in another room, with
      // nothing on screen here to connect the two. Somebody who did not mean to press it has no
      // reason to suspect the extension at all, and the way out is a settings page they are no
      // longer holding.
      //
      // So the tightening dialogue is asked for outright rather than left to `editLocked`, which is
      // false for everyone who has not set a password — see setStateP. Only the ON direction, and
      // only because it is a tightening: switching it off is a loosening and already goes through
      // the password, and strict mode refuses it above.
      const wantsConfirm = patch.macrodroidEnabled === true && st.macrodroidEnabled !== true;
      // setStateP asks for the password if anything in here eases a rule off (including changing webhook URLs),
      // and throws EditLocked if it isn't given — having already put the page back to what is stored, so there
      // is nothing to tidy up here. It throws the same way when the confirmation below is declined, which is
      // why that needs no separate handling. Caught rather than left to the global handler because the lines
      // below must not run: they would report a save that did not happen.
      try { await setStateP(patch, { confirmTighten: wantsConfirm }); } catch (e) { return; }
    }
    if (refused.length) {
      renderApp();
      return toast(refused.includes("macrodroidEnabled")
        ? "Strict mode is on. You cannot switch phone blocking off now."
        : "Strict mode is on. You cannot change webhook addresses now.");
    }
    // Patched in place, never re-rendered: a redraw would take the caret out of the box being typed
    // in, which is exactly where it is when this runs.
    const cnt = $("#phoneCnt");
    if (cnt) cnt.textContent = want.macrodroidEnabled ? "on" : "off";
    paintPhoneState().catch(() => {});
    // Pushed at once rather than waiting up to a minute for the worker's own tick — you have just
    // changed the thing that decides what your phone does, so the answer should follow now.
    tellWorker({ type: "macrodroidSync" });
    // The switch itself just went ON — not an address being typed, which saves through here too.
    //
    // This is the one feature in the extension that depends on something outside this computer, and
    // the way it fails is silent: a phone with no connection never hears the webhook, so nothing
    // blocks and nothing anywhere says why. Said at the moment the feature is asked for, because that
    // is the only point where it is still advice rather than a post-mortem. Longer than the default
    // toast, because it is a sentence to read rather than a result to glance at.
    if (patch.macrodroidEnabled === true && st.macrodroidEnabled !== true) {
      toast("📱 Phone blocking is on. Make sure your phone has mobile data or Wi-Fi on — MacroDroid has to be " +
            "online to receive AnkiGate's webhook. If it's offline, AnkiGate tries again about once a minute.",
            { cls: "wide phone", ms: 7000 });
    }
  }

  $("#mdEnabled")?.addEventListener("change", () => { clearTimeout(pendingMdSave); saveMobile(); });
  ["mdLockUrl", "mdUnlockUrl"].forEach(id => {
    const el = $("#" + id);
    if (!el) return;
    el.addEventListener("pointerdown", async (e) => {
      if (editLocked) {
        e.preventDefault();
        if (await requireUnlock()) {
          renderApp();
          $("#" + id)?.focus();
        } else {
          toast("Password needed to edit webhook URL 🔒");
        }
        return;
      }
    });
    el.addEventListener("focus", async () => {
      if (editLocked) {
        el.blur();
        if (await requireUnlock()) {
          renderApp();
          $("#" + id)?.focus();
        } else {
          toast("Password needed to edit webhook URL 🔒");
        }
        return;
      }
    });
    el.addEventListener("input", () => {
      clearTimeout(pendingMdSave);
      pendingMdSave = setTimeout(saveMobile, 500);
    });
    // `change`, and no separate `blur`. A text input fires `change` on the way out whenever its
    // value was edited, so blur would only ever be the same save a second time — and the debounced
    // timer above is already cancelled here, so nothing can be left unsaved.
    el.addEventListener("change", () => { clearTimeout(pendingMdSave); saveMobile(); });
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      clearTimeout(pendingMdSave);
      saveMobile();
      el.blur();
    });
  });

  // ▶ Test: call one address right now, whatever the switch and the goal say. It is a test of a
  // webhook, not of the rule, and it deliberately leaves the worker's record of what it has pushed
  // alone — see the macrodroidTest handler.
  async function testOne(boxId, locked, what) {
    if (editLocked) {
      if (!(await requireUnlock())) {
        toast("Password needed to test webhook 🔒");
        return;
      }
      renderApp();
    }
    const url = ($("#" + boxId)?.value || "").trim();
    if (!url) return toast("Put the " + what + " address in first");
    const r = await phoneSend({ type: "macrodroidTest", url, locked });
    toast(r && r.ok
      ? (locked ? "Lock sent — your apps should be blocked now" : "Unlock sent — your apps should be open now")
      : phoneSendError(r));
  }
  $("#mdTestLock")?.addEventListener("click", () => testOne("mdLockUrl", true, "lock"));
  $("#mdTestUnlock")?.addEventListener("click", () => testOne("mdUnlockUrl", false, "unlock"));

  $("#mdSync")?.addEventListener("click", async () => {
    if (editLocked) {
      if (!(await requireUnlock())) {
        toast("Password needed to sync webhook 🔒");
        return;
      }
      renderApp();
    }
    const r = await phoneSend({ type: "macrodroidSync" });
    if (r && r.ok) {
      const s = await getState();
      await paintPhoneState(s);
      return toast(FGGates.phoneLockWanted(s) ? "Told your phone to block" : "Told your phone to open");
    }
    toast(phoneSendError(r));
  });
}

// Why there are no keywords, said precisely.
//
// This started as one sentence — "no card open" — and that sentence was actively harmful, because it
// is the message you get for FIVE different causes and only one of them is "no card open". Somebody
// sitting in Anki looking at a card, reading "no card open", has been told the one thing they can
// see is false; and the real cause (in that case, a service worker still running the previous build)
// is the one thing they would never guess.
//
// So each cause gets its own sentence, and each sentence says what to DO. The order matters: it goes
// from the cause furthest from the user's control to the nearest, so the first one that matches is
// the one worth acting on.
function noKeywordsWhy(s) {
  // 1. The extension itself is running old code.
  //
  // Detected, not guessed. `ankiCardKeywords` is a key the worker writes into storage for every
  // profile the moment it starts — onInstalled writes the whole of DEFAULTS. So the key being ABSENT
  // (not empty — absent) can only mean no worker carrying this feature has ever run here, which
  // after an update means Chrome is still serving the previous service worker. Reloading the
  // extension is the only thing that fixes it, and nothing else on this row will be true until it
  // is done.
  //
  // `in`, not a truthiness or Array.isArray check: an empty array is the ordinary "no card" state
  // and must not be confused with the key never having been written.
  if (!("ankiCardKeywords" in s)) {
    return `⚠️ <b>This extension needs reloading.</b> Open <span class="kbd">chrome://extensions</span>, find this extension and press <b>⟳ Reload</b>. Until then the video gate is not running at all — videos will not be blocked.`;
  }
  // 2. Anki is not answering.
  if (s.ankiBridgeOk === false || s.ankiConnected === false) {
    return `Open <b>Anki</b> to see the words for the card you are on.`;
  }
  // 3. Anki is answering, but with a different add-on from the one this extension ships. The version
  //    nag beside "Anki app" says the same thing, but somebody looking at this row is looking at this
  //    row. Said as a mismatch rather than as "it can't report your card": every add-on since the video
  //    gate CAN, and the version moves for other reasons too, so that claim would be false most times
  //    it was shown.
  if (ankiAddonVersionKnown && s.ankiBridgeVersion && s.ankiBridgeVersion !== ANKI_ADDON_VERSION) {
    return `⚠️ Anki is running add-on <b>v${escHtml(s.ankiBridgeVersion)}</b>, not the <b>v${escHtml(ANKI_ADDON_VERSION)}</b> this extension ships. Press <b>⬇ Add-on</b> above, install it in Anki, and <b>restart Anki</b>.`;
  }
  // 4. Everything is connected and current, and Anki still says no card. Two possibilities and they
  //    need saying together, because from here they are indistinguishable: you really are off the
  //    review screen, or Anki has not been restarted since the add-on was updated and is running the
  //    old code while reporting the new version number.
  if (!(s.ankiCardId > 0)) {
    return `No card open. <b>While that's true, no video is allowed.</b> Start reviewing and the words appear here — if you <i>are</i> on a card, <b>restart Anki</b> so the updated add-on loads.`;
  }
  // 5. A card is open and it produced nothing. Rare, and honest about it: a card whose front is a
  //    bare image, a formula, or nothing but words on the stop list.
  return `The card you're on has no words specific enough to match a video — it may be an image, or all very common words. <b>No video is allowed</b> while that's the case.`;
}

// One line under the weekday chips, saying what the row you are looking at actually adds up to.
//
// It exists because seven chips are a picture, not a sentence: five lit and two not tells you the
// shape of your week but not whether the shape applies right now, and "why is nothing blocked today"
// is exactly the question a rest day invites. So the line names the days that are off AND says which
// side of the rule today falls on.
function weekHintText(s) {
  const off = FGGates.daysOffText(s);
  const today = FGGates.dayName(s);
  if (!off) return `Every day is on. Switch one off to give yourself a rest day — nothing gets blocked that day.`;
  return `Off on ${off}. Today is ${today} — ` + (FGGates.dayIsOn(s)
    ? `a working day, so your locked sites stay locked until the goal is done.`
    : `a day off, so nothing is blocked and the camera window stays away.`);
}

// ---- the Setup tab -------------------------------------------------------
// Everything you set once and forget: when the day rolls over, when the settings
// freeze, how soon the password comes back, and the Windows uninstall lock.
function renderSetup(s) {
  const tc = document.getElementById("tabContent");
  const strict = inStrictWindow(s);
  // Two different questions, and they must not be confused. `strict` is "frozen right now, for
  // either reason" — that is what greys the times and the daily switch. `deadline` is specifically
  // "a continuous stretch is running", which is what locks the deadline's OWN switch on.
  // Is a deadline running? Its own question, separate from `strict` above — which is "frozen right
  // now, for either reason". A running deadline makes `strict` true as well, so the times below are
  // frozen by it; what this one adds is that the deadline's OWN switch is locked on.
  const deadline = FGGates.strictDeadlineActive(s);
  const timesFrozen = strict;
  // The date boxes stay live even while a deadline runs: pushing it further out is always allowed,
  // and you cannot type a later date into a disabled box. What refuses an earlier one is Save.
  const untilTime = FGGates.strictUntilTime(s);
  const leftText = FGGates.strictLeftText(s);
  const untilNow = FGGates.strictUntil(s);
  // The three boxes open on the commitment if there is one, otherwise on today. Either way the row
  // shows a real date you can read straight away, and an arrow press moves from somewhere sensible
  // rather than from an empty box.
  const today = FGGates.dayStamp(s);
  // A commitment that has already run out seeds today, not the day it ended. Opening on a date in
  // the past would mean the row greeting you with a complaint about a number you never typed.
  const seed = ((untilNow && untilNow >= today) ? untilNow : today).split("-").map(n => num(n));
  const thisYear = num(today.slice(0, 4));
  // Day, then month, then year — the order the date is spoken in. The year ceiling is shared with
  // the handlers below, because a limit the arrows respect and a typed digit does not is no limit.
  const untilBox = (id, label, value, min, max, off) => `
    <span class="dpart${off ? " off" : ""}">
      <button class="dspin" type="button" data-dstep="${id}:1" aria-label="${label} up" ${off ? "disabled" : ""}>▲</button>
      <input class="input mini dnum" id="until${id}" type="number"
             min="${min}" max="${max}" step="1" value="${value}"
             inputmode="numeric" aria-label="${label}" ${off ? "disabled" : ""}/>
      <button class="dspin" type="button" data-dstep="${id}:-1" aria-label="${label} down" ${off ? "disabled" : ""}>▼</button>
      <i>${label}</i>
    </span>`;
  // The month, by name, in a list you can drop open.
  //
  // It was a number box like the other two, and a number is the one part of a date that cannot be
  // read without knowing which convention it was written in. 8 is August here, and in half the
  // world's date formats it is the day — on the control that sets how long you cannot let yourself
  // off, which is the last place for a value that can be misread. The names come from the same list
  // gates.js labels the date with, so this box and the line under it cannot disagree.
  //
  // A select rather than a name in a box, because arrows are a poor way to travel from January to
  // November and this is a value people know outright. The arrows still work either way: a select's
  // value is read and written exactly like a number input's, which is why nothing below changed.
  const untilMonthBox = (value, off) => `
    <span class="dpart wide-m${off ? " off" : ""}">
      <button class="dspin" type="button" data-dstep="M:1" aria-label="month up" ${off ? "disabled" : ""}>▲</button>
      <select class="input mini dsel" id="untilM" aria-label="month" ${off ? "disabled" : ""}>
        ${FGGates.MONTHS_LONG.map((nm, i) =>
          // The name AND the number. The name is what makes the date unambiguous; the number is what
          // the two boxes either side of it are, and what every other date in the world writes. With
          // only the name, this box was the one part of the row you could not check against a date
          // written down anywhere else.
          `<option value="${i + 1}"${(i + 1) === value ? " selected" : ""}>${escHtml(nm)} · ${i + 1}</option>`).join("")}
      </select>
      <button class="dspin" type="button" data-dstep="M:-1" aria-label="month down" ${off ? "disabled" : ""}>▼</button>
      <i>month</i>
    </span>`;
  const autoLockPresets = [
    { label: "Immediate", sec: 0 },
    { label: "30 sec", sec: 30 },
    { label: "1 min", sec: 60 },
    { label: "5 min", sec: 300 }
  ];
  // ---- the seven weekday chips ----
  // Monday first, because that is how a week reads. The order is FGGates.WEEK_ORDER and lives beside
  // the array it reorders, so the row of chips, the "Off on Sat, Sun" line underneath and the one
  // check in the worker cannot disagree about where the week starts — or about which slot Sunday is.
  //
  // The value written back is indexed by getDay(), never by position in this row. That is the whole
  // reason data-day carries the real index instead of the loop counter.
  const dayOn = FGGates.activeDays(s);
  const todayIdx = FGGates.dayDate(s).getDay();
  const weekHtml = FGGates.WEEK_ORDER.map(i => {
    const on = dayOn[i] !== false;
    const name = FGGates.DAY_NAMES[i];
    const isToday = i === todayIdx;
    // The full day name is the accessible name, not the three-letter chip: "Mon" read aloud on its
    // own is not a sentence, and the state comes from the checkbox rather than from the wording.
    const label = name + (isToday ? " (today)" : "");
    return `<input type="checkbox" data-day="${i}" id="wday${i}" ${on ? "checked" : ""}
                   aria-label="${escHtml(label)}" ${strict && on ? "disabled" : ""}/>
            <label for="wday${i}" title="${escHtml(on ? label + " — on" : label + " — a day off")}">${escHtml(FGGates.DAY_SHORT[i])}${isToday ? "<span aria-hidden=\"true\"> ·</span>" : ""}</label>`;
  }).join("");
  const curDelay = Math.max(0, s.autoLockDelaySec || 0);
  // Read from the state this render was handed, not from the live DOM attribute.
  // theme.js applies the stored preference from an async storage callback, so
  // asking the document could catch it a beat before that lands and show the
  // wrong radio ticked for a moment.
  const theme = s.theme === "light" ? "light" : "dark";
  tc.innerHTML = `
    <div class="card">
      <h2><span class="ic">🎨</span> Appearance ${tip("Dark or light, for the whole extension — this page, the popup, the blocked page and the study tab all follow it at once, with no reload.<br/><br/><b>Dark is the default</b>, because this is on screen while you study and often late at night.<br/><br/>The small always-on-top camera window stays dark either way: a white panel floating over full-screen Anki is glare, not a theme.")}</h2>
      <div class="srow">
        <span class="ic">${theme === "dark" ? "🌙" : "☀️"}</span>
        <span class="lbl grow">Theme</span>
        <span class="seg" role="group" aria-label="Theme">
          <input type="radio" name="theme" id="theme-dark" value="dark" ${theme === "dark" ? "checked" : ""}/>
          <label for="theme-dark" title="Dark mode (default)"><span aria-hidden="true">🌙</span>Dark</label>
          <input type="radio" name="theme" id="theme-light" value="light" ${theme === "light" ? "checked" : ""}/>
          <label for="theme-light" title="Light mode"><span aria-hidden="true">☀️</span>Light</label>
        </span>
      </div>
    </div>

    <div class="card">
      <h2><span class="ic">🔄</span> New day starts at ${tip("Every day your Anki time goes back to zero and your sites get locked again. This is the clock time when that happens.<br/><br/><span class='kbd'>00:00</span> means midnight.<br/><br/><b>Reset now</b> wipes today's progress straight away.")}</h2>
      <div class="srow">
        <span class="ic">🕛</span>
        <input class="input" id="resetTime" type="time" value="${escHtml(s.dailyResetTime || "00:00")}" style="width:130px" ${strict ? "disabled" : ""}/>
        <button class="btn sec" id="saveTime" ${strict ? "disabled style='opacity:.4;cursor:not-allowed'" : ""}>💾 Save</button>
        <button class="btn sec" id="resetNow" ${strict ? "disabled style='opacity:.4;cursor:not-allowed'" : ""}>↺ Reset now</button>
      </div>
    </div>

    <div class="card">
      <h2><span class="ic">📅</span> Days it works on ${tip("<b>Seven switches, one per weekday.</b> A day that is lit is a day this extension works. Switch one off and that day is a rest day: your listed sites stay open all day and the small camera window does not appear.<br/><br/>What a day off does <b>not</b> do: it doesn't stop Anki time counting. Study on your rest day anyway and it still counts, so a day off never costs you a streak you actually earned.<br/><br/>Which day it is follows <b>New day starts at</b> above, not midnight. With a <span class='kbd'>04:00</span> reset, 1 AM on Tuesday still belongs to Monday — the same day your progress and your streak are still on.<br/><br/>Switching a day <b>off</b> asks for your password and is refused while strict mode is on, because a day with nothing blocked is the biggest loosening there is. Switching one back on is free.<br/><br/>At least one day has to stay on. If you want it off completely, use the switch in the toolbar popup.")}</h2>
      <div class="srow" style="border-bottom:none;padding-bottom:2px">
        <span class="week" role="group" aria-label="Days of the week this extension works on">
          ${weekHtml}
        </span>
      </div>
      <div class="srow" style="padding-top:0">
        <span class="lbl hint" id="weekHint" role="status">${escHtml(weekHintText(s))}</span>
      </div>
    </div>

    <div class="card">
      <h2><span class="ic">🛑</span> Strict mode ${strict ? '<span class="st off">ON NOW</span>' : ""} ${tip("<b>Two switches, and they are independent.</b> Either one being active freezes your settings; you can use one, the other, or both.<br/><br/><b>Freeze settings every day</b> is a schedule: settings lock between two clock times and lift again each morning. For an evening routine.<br/><br/><b>Keep strict mode on until</b> is a stretch: on continuously, day and night, until a date and time you pick. It does not lift, so nothing — including this switch and the one above — can be loosened before it expires. For the week before an exam.<br/><br/>While either is active the rule is simple: <b>nothing can be loosened.</b><br/><br/>You <b>can</b> raise today's goal, add sites to the blocklist, take sites off the allowlist, shorten the auto-lock delay, and make the two camera dials fussier.<br/><br/>You <b>cannot</b> lower the goal, unblock a site, allow a new one, swap blocklist/allowlist, switch Anki off, wind today's time back, ease the camera dials off, change the password settings, import a backup, or change the times.<br/><br/>The individual anti-cheat checks follow the same rule as everything else: you can switch one <b>on</b> mid-session, raise the cards needed, shorten the idle grace and make the dials fussier — but you cannot switch one off, lower a quota or ease a dial until the window ends. They used to be frozen both ways, which refused you the one direction strict mode is for.")}</h2>
      <!-- Part one: the daily freeze. Its own switch, because it is one of two separate things this
           card does and a single Turn on / Turn off button at the bottom could only ever mean one
           of them. Frozen shut while committed — that is what the date is for. -->
      <div class="srow">
        <span class="ic">🕒</span>
        <span class="lbl grow">Freeze settings every day ${tip("The window of the day when your settings are locked, so you can't ease your own rules mid-session.<br/><br/>Example: <span class='kbd'>15:00</span> → <span class='kbd'>08:00</span> is 3 PM tonight until 8 AM tomorrow.<br/><br/>Switching this off is what the date below can prevent.")}</span>
        ${sw("strictEn", !!s.strictModeEnabled, strict, "Freeze settings every day")}
      </div>
      <div class="srow" style="padding-top:0">
        <span class="ic"></span>
        <span class="lbl">From</span>
        <input class="input" id="strictStart" type="time" value="${escHtml(strictTime(s.strictStart, STRICT_FROM))}" style="width:120px" ${timesFrozen ? "disabled" : ""}/>
        <span class="lbl">to</span>
        <input class="input" id="strictEnd" type="time" value="${escHtml(strictTime(s.strictEnd, STRICT_TO))}" style="width:120px" ${timesFrozen ? "disabled" : ""}/>
      </div>
      <!-- Part two: a deadline. Not a schedule and not a sub-option of the one above — a single
           continuous stretch from now until a moment you pick, during which nothing can be loosened.
           It stands on its own: it used to require the daily freeze, which made it useless by itself
           ("on until the 30th" with no window set froze nothing) when it is the simpler and more
           useful of the two. Its own switch, its own Save, and once it is running the switch is
           locked ON, which is the entire feature. -->
      <div class="srow">
        <span class="ic">⏳</span>
        <span class="lbl grow">Keep strict mode on until ${tip("<b>A stretch you cannot talk yourself out of.</b> Strict mode stays on continuously — day and night, not just inside a window — from now until the date and time you set.<br/><br/>Set the moment in the boxes, then <b>flip the switch</b>. There is no Save button: the switch is what starts it, and it asks you to confirm first.<br/><br/>Until it expires nothing can be loosened: today's goal cannot be lowered, sites cannot be unblocked, the camera checks cannot be eased off, the extension cannot be switched off, and this cannot be turned off. Making things stricter is always allowed.<br/><br/>While it runs the boxes are locked, showing what you committed to — a commitment you can keep editing is not one.<br/><br/>This works <b>on its own</b> — it does not need the daily freeze above. Use that one for an evening routine, and this one for the week before an exam.<br/><br/>The boxes start on <b>today</b>, so each arrow press is one day, one month or one year further out. The time defaults to <b>23:59</b>, so leaving the date on today means the rest of today.<br/><br/>There is no undo, so pick a moment you actually want.")}</span>
        ${sw("strictUntilEn", !!s.strictUntilEnabled, deadline, "Keep strict mode on until a date and time")}
      </div>
      <!-- No Save button. The switch is the action: set the moment, flip it on, agree to the
           warning, and it is running. While it IS running the boxes are dead and show what you
           committed to — a commitment you can keep editing is not one. -->
      <div class="srow dateset" style="padding-top:0">
        <span class="ic"></span>
        <span class="dstep">
          ${untilBox("D", "day", seed[2], 1, 31, deadline)}
          ${untilMonthBox(seed[1], deadline)}
          ${untilBox("Y", "year", seed[0], thisYear, thisYear + YEARS_AHEAD, deadline)}
        </span>
        <!-- The clock time on that date. A plain time input, not a fourth spinner: hours and minutes
             together are one value, and the browser's own control already knows how to type one. -->
        <span class="dpart wide${deadline ? " off" : ""}">
          <input class="input" id="untilT" type="time" value="${escHtml(untilTime)}"
                 style="width:118px" aria-label="Time on that date" ${deadline ? "disabled" : ""}/>
          <i>time</i>
        </span>
      </div>
      <!-- Three numbers are harder to read than one date, so the date is spelled out. It also has
           to be: the day is clamped to the month you land on, so 31 + one month is the 28th or the
           30th and the boxes alone would not tell you which. -->
      <div class="srow dpreview" style="padding-top:0">
        <span class="ic"></span>
        <span class="lbl hint" id="untilPreview" role="status" aria-live="polite"></span>
      </div>
      ${deadline ? `<div class="srow" style="padding-top:0">
        <span class="ic">🔒</span>
        <span class="lbl hint">Strict mode is held on until <b>${escHtml(FGGates.strictUntilLabel(untilNow))}, ${escHtml(untilTime)}</b>${leftText ? " — " + escHtml(leftText) + " left" : ""}. Nothing can be loosened until then.</span>
      </div>` : ""}
    </div>

    <div class="card">
      <h2><span class="ic">💾</span> Backup &amp; restore ${tip("Saves everything you have set up to a small <b>.json</b> file: your blocked and allowed sites, today's goal, every check you switched on, all the dials, strict mode, the day boundary and the theme.<br/><br/>Use it to move your setup to another computer, or to keep a copy before you change a lot at once.<br/><br/><b>What is deliberately not in it:</b><ul><li>Your <b>password</b>. A hash in a backup file is your door in a backup file. Restore onto a fresh profile and it asks you to make a new one.</li><li><b>Today's progress</b> — minutes studied, cards counted, per-deck time. A backup would otherwise be a way to hand yourself an afternoon you didn't spend.</li><li>Your <b>streak, XP and level</b>. Earned, not configured.</li><li>Anything about <b>this machine</b>: the camera window's position, where Anki is installed.</li></ul>Every value is re-checked on the way back in and put back inside the range its control allows, so a hand-edited file can't loosen a check past what the page itself would let you set.<br/><br/><b>Importing is frozen during a strict window</b>, because replacing all your settings at once is the loosest thing anyone could do.")}</h2>
      <div class="srow">
        <span class="ic">⬇️</span>
        <span class="lbl grow">Save your settings to a file</span>
        <button class="btn sec" id="expSettings">⬇ Export</button>
      </div>
      <div class="srow">
        <span class="ic">⬆️</span>
        <span class="lbl grow">Read a backup file back in${strict ? " <b>— frozen while strict mode is on</b>" : ""}</span>
        <button class="btn sec" id="impSettings" ${strict ? "disabled style='opacity:.4;cursor:not-allowed'" : ""}>⬆ Import</button>
      </div>
      <!-- Hidden and driven by the button above, because a bare file input cannot be
           styled to match anything and reads as debris on a settings page. -->
      <input type="file" id="impFile" accept="application/json,.json" hidden/>
    </div>

    <!-- Its own card, not a third row in Backup & restore above. It is the same mental model as
         Import — replace everything at once — but it is the only control on this page that throws
         work away with nothing to read it back from, and putting it under a heading about saving
         files would make the one irreversible button on the tab look like part of the safety net. -->
    <div class="card">
      <h2><span class="ic">↩️</span> Start over ${tip("Puts every <b>setting</b> back to exactly what a fresh install has: no blocked or allowed sites, no goal, every check off, every dial back to the middle, strict mode off, all seven days on, the day boundary back to <span class='kbd'>00:00</span> and the theme back to dark.<br/><br/><b>Kept, on purpose:</b><ul><li>Your <b>password</b>, and whether it is being asked for. The password guards this page, so a button on this page must not be the way round it.</li><li>Your <b>streak, points and level</b>. Earned, not configured.</li><li><b>Today's Anki time.</b> The ↺ <b>Reset now</b> button further up is the one for that, and doing both from one press would make one of the two buttons a lie.</li></ul>Want a copy first? <b>⬇ Export</b> above saves everything this is about to clear.<br/><br/>You type a phrase to confirm, and it asks for your password. <b>Frozen while strict mode is on</b> — wiping every rule you set is the loosest thing anyone could do.")}</h2>
      <div class="srow">
        <span class="ic">🧹</span>
        <span class="lbl grow">Put every setting back to default${strict ? " <b>— frozen while strict mode is on</b>" : ""}</span>
        <button class="btn danger" id="resetAll" ${strict ? "disabled style='opacity:.4;cursor:not-allowed'" : ""}>↩ Reset to default</button>
      </div>
    </div>

    <div class="card">
      <h2><span class="ic">🔐</span> Auto-lock ${tip("When you close this page or the little popup, this locks itself again and asks for your password next time.<br/><br/>Pick how soon that happens. <b>Immediate</b> is the safest. There's no manual lock button — it's automatic.")}</h2>
      <div class="toolbar">
        ${autoLockPresets.map(p => `<button class="btn ${curDelay === p.sec ? "" : "sec"}" data-lock="${p.sec}">${p.label}</button>`).join("")}
        <span class="timeset plain">
          <span class="gicon" aria-hidden="true">⏳</span>
          <label class="tfld"><input class="input" id="customLock" type="number" min="0" max="3600" value="${curDelay}" title="Or type your own number of seconds — it saves itself" aria-label="Or type your own number of seconds"/><i>s</i></label>
        </span>
      </div>
    </div>`;

  // Theme. No password and no strict-mode check anywhere near this: how the page
  // looks can't be used to weaken your own rules, so guarding it would only be in
  // the way. The redraw is left to the storage listener at the bottom of this
  // file, which is also what keeps this tab right when you use the ☀️ button in
  // the title bar instead — one path, so the two controls can't disagree.
  document.querySelectorAll('input[name="theme"]').forEach(r => r.addEventListener("change", () => {
    if (r.checked && window.FGTheme) window.FGTheme.set(r.value);
  }));

  // A shorter delay re-locks sooner, so shorter is stricter and longer is refused
  // while a strict window is open.
  document.querySelectorAll("[data-lock]").forEach(b => b.addEventListener("click", async () => {
    const want = parseInt(b.dataset.lock, 10) || 0;
    const st = await getState();
    if (want > (st.autoLockDelaySec || 0) && inStrictWindow(st)) {
      return toast("Strict mode is on. You can only lock sooner, not later.");
    }
    await setStateP({ autoLockDelaySec: want });
    toast("Saved");
    renderApp();
  }));
  // (the custom seconds box saves itself)
  autoNum("customLock", "autoLockDelaySec", 0, 3600, 0, "down");

  // Routed through the background rather than written here: moving the boundary
  // also has to move lastResetAt and the day keys with it, or the next poll either
  // wipes the day or hands out a second trophy. The worker owns that arithmetic.
  $("#saveTime")?.addEventListener("click", async () => {
    const st = await getState();
    if (inStrictWindow(st)) return toast("Strict mode: cannot change the reset time");
    // Asked for by hand, because this one change goes to the worker instead of through setStateP
    // and so does not pass the gate that lives there.
    //
    // And asked for unconditionally, unlike everything else now. Moving the day boundary has no
    // stricter direction to compare against — it is not more or less of anything, it decides WHEN
    // today's progress goes back to zero, so either direction can hand you a fresh day or take one
    // away depending on what time it is when you do it. A guess about which way that is would be
    // wrong half the time, and this is the one setting where being wrong quietly rewrites what you
    // have already done. So it asks, and says why.
    if (!(await requireUnlock())) return toast("Password needed to move the day boundary 🔒");
    const want = $("#resetTime").value || "00:00";
    chrome.runtime.sendMessage({ type: "setResetTime", value: want }, () => {
      void chrome.runtime.lastError;
      toast("Saved");
    });
  });
  $("#resetNow")?.addEventListener("click", async () => {
    const st = await getState();
    if (inStrictWindow(st)) return toast("Strict mode is on. You cannot start over now.");
    const t = todayTotals(st);
    if (!await confirmReset({
      title: "Start the whole day over?",
      body: `${fmtDur(t.spent)} of Anki time done today goes back to zero, and your locked sites lock again. This cannot be undone.`,
      go: "Reset the day"
    })) return;
    const fresh = await getState();
    if (inStrictWindow(fresh)) return toast("Strict mode is on. You cannot start over now.");
    await setStateP(todayResetPatch());
    tellWorker({ type: "refreshBlockedTabs" });
    renderApp();
    toast("The day started over");
  });

  // ---- the seven weekday chips ----
  // A checkbox each, so the row is operable from the keyboard and each chip is announced with its
  // day name. One listener per box rather than one delegated to the container: the container also
  // holds the <label>s, and a click on a label raises a click on the container too — so a delegated
  // handler would run twice for every press and write the day back to the value it started at.
  document.querySelectorAll('.week input[data-day]').forEach(box => box.addEventListener("change", async () => {
    const i = parseInt(box.dataset.day, 10);
    const st = await getState();
    const next = FGGates.activeDays(st).slice();
    next[i] = box.checked;
    // Both refusals put the page back rather than just the one chip. The chip is already showing the
    // value nothing saved, and re-rendering is how every other refusal on this page resolves that —
    // it also fixes the hint line underneath, which would otherwise describe a week you do not have.
    if (!next.some(Boolean)) {
      renderApp();
      return toast("At least one day has to stay on — use the switch in the toolbar popup to turn it off completely");
    }
    // Turning a day OFF is the loosening; turning one on is free and is deliberately not checked
    // here. The chips are also disabled in that direction while strict mode runs, so this is the
    // half of the rule that cannot be got round by a keyboard or a stale page.
    if (!box.checked && inStrictWindow(st)) {
      renderApp();
      return toast("Strict mode is on. You cannot take a day off right now.");
    }
    // setStateP asks for the password, because FGSettings marks activeDays "days" and a day turned
    // off registers as a loosening. A refusal throws EditLocked and has already redrawn the page.
    try { await setStateP({ activeDays: next }); } catch { return; }
    // The sites have to be re-judged either way: switching today off frees whatever is sitting on
    // the blocked page, and switching it back on locks them again.
    chrome.runtime.sendMessage({ type: "refreshBlockedTabs" }, () => void chrome.runtime.lastError);
    renderApp();
    toast(box.checked ? `${FGGates.DAY_NAMES[i]} is on` : `${FGGates.DAY_NAMES[i]} is a day off`);
  }));

  // ---- back to a fresh install ----
  $("#resetAll")?.addEventListener("click", async () => {
    const st = await getState();
    if (inStrictWindow(st)) return toast("Strict mode is on. You cannot reset your settings now.");
    // The typed phrase, not the tap counter: this is the shape reserved for throwing away something
    // there is no copy of. Every rule on every tab goes at once.
    if (!await confirmReset({
      title: "Put every setting back to default?",
      body: "Your blocked and allowed sites, today's goal, every check you switched on, all the dials, "
          + "strict mode, the days of the week, the day boundary and the theme all go back to how they "
          + "were on a fresh install. Your password, your streak, your points and today's Anki time are "
          + "kept. There is no undo.",
      go: "Reset everything"
    })) return;
    // Asked for by hand, like the day boundary above and for the same reason: this change is made by
    // the worker rather than through setStateP, so it does not pass the gate that lives there. And it
    // is the loosest single action on the page — every rule you set, gone in one press.
    if (!(await requireUnlock())) return toast("Password needed to reset your settings 🔒");
    // Re-read after the dialogue and the password. Both take real time, and a strict window that
    // opened while the sheet was up must not be beaten by a confirmation that predates it.
    if (inStrictWindow(await getState())) return toast("Strict mode is on. You cannot reset your settings now.");
    chrome.runtime.sendMessage({ type: "resetSettings" }, (r) => {
      void chrome.runtime.lastError;
      if (r && r.ok) {
        toast("Everything is back to default ✓");
        // renderRoot, not renderApp, exactly as the import handler does it: the whole of storage just
        // changed underneath this page, and deciding which screen that adds up to is renderRoot's job.
        renderRoot().catch(() => {});
      } else {
        toast(r && r.error === "strict"
          ? "Strict mode is on. You cannot reset your settings now."
          : "Could not reset your settings — try again");
      }
    });
  });

  // The times shown in the two boxes, ready to store. A zero-length window is
  // refused rather than saved, because "from 3pm to 3pm" reads as a whole day and
  // means the opposite — inStrictWindow treats start === end as "never".
  function strictBoxes() {
    const from = strictTime($("#strictStart")?.value, STRICT_FROM);
    const to = strictTime($("#strictEnd")?.value, STRICT_TO);
    return from === to ? null : { strictStart: from, strictEnd: to };
  }
  // The two times save themselves, which is what every other number on this page does — see the note
  // on autoNum: "No Save buttons anywhere". A Save button beside a pair of time inputs was the odd
  // one out, and it was redundant twice over, because flipping the switch on stores whatever the
  // boxes are showing anyway.
  //
  // `change`, not `input`: a time input fires input on every digit, and a half-typed "1" is not a
  // time worth storing.
  ["strictStart", "strictEnd"].forEach(id => {
    $("#" + id)?.addEventListener("change", async () => {
      const st = await getState();
      // Moving the window while frozen is the way round the whole thing: shift it to a minute a day
      // and the rule is kept to the letter and gone in substance. inStrictWindow covers both reasons
      // — inside tonight's window, or inside a running deadline.
      if (inStrictWindow(st)) { renderApp(); return toast("Strict mode is on. Change these times later."); }
      const times = strictBoxes();
      if (!times) return toast("Pick two different times — a window that starts and ends together never opens.");
      await setStateP(times);
      // Only worth saying while the window is armed. With the freeze off these boxes are just the
      // value the switch will read, and announcing a save of something inert is noise.
      if (st.strictModeEnabled) toast("Window is now " + times.strictStart + " to " + times.strictEnd);
    });
  });

  // ---- the commitment date ----
  // Three boxes and six arrows rather than a native date input, so the date reads in the order it
  // is spoken and one press is one day.
  const dPad = (n) => String(n).padStart(2, "0");
  // How long the month the boxes are pointing at actually is. Day 0 of the next month is the last
  // day of this one, which is also how the settings-file validator checks a date — same trick, so
  // the two cannot disagree about February.
  const dLastDay = (y, m) => new Date(y, m, 0).getDate();
  // What the boxes currently say, as a date that exists. The day is clamped rather than refused: if
  // you are on the 31st and step the month to February, the honest answer is the 28th, not an error
  // about a day you never typed.
  function readUntilBoxes() {
    // The year is held to the same range the box advertises. A max attribute is a hint a spinner
    // honours and a typed digit ignores, so without this you could type 9999 and the box would
    // keep it — a twenty-year ceiling that only applies to the arrows is not a ceiling.
    const y = Math.max(thisYearNow(), Math.min(thisYearNow() + YEARS_AHEAD,
                                               num($("#untilY")?.value) || thisYearNow()));
    const m = Math.max(1, Math.min(12, num($("#untilM")?.value) || 1));
    const d = Math.max(1, Math.min(dLastDay(y, m), num($("#untilD")?.value) || 1));
    return { y, m, d, iso: y + "-" + dPad(m) + "-" + dPad(d) };
  }
  function thisYearNow() { return new Date().getFullYear(); }
  // The clock time on that date, through the same parser storage is read with — so a browser that
  // hands back "" for a half-cleared time box lands on the same default the guard would use.
  function readUntilTime() { return FGGates.hhmm($("#untilT")?.value, FGGates.strictUntilTime(null)); }
  // Written back after every change, so the boxes always show the date that would be saved. Without
  // this the day box could sit on 31 while the date being committed to was the 28th.
  function paintUntilBoxes(v) {
    if ($("#untilY")) $("#untilY").value = String(v.y);
    if ($("#untilM")) $("#untilM").value = String(v.m);
    if ($("#untilD")) $("#untilD").value = String(v.d);
  }
  async function paintUntilPreview() {
    const el = $("#untilPreview");
    if (!el) return;
    const v = readUntilBoxes();
    const st = await getState();
    const cur = FGGates.strictUntil(st);
    const running = FGGates.strictDeadlineActive(st);
    const label = FGGates.strictUntilLabel(v.iso);
    // Already running: the boxes are showing the committed moment and are dead, so this reports the
    // stretch rather than previewing a change to it.
    // Three short forms, and nothing else. This line used to end "Flip the switch to lock it in",
    // which is an instruction about a switch sitting two inches to the right of it — and it followed
    // an arrow, a date, a dash and a duration, so the one thing the line is for, the date, was the
    // least visible thing in it. What is left is the date, and how far away it is.
    // How long it is for, in red. It is the number that matters here and the only one with a
    // consequence attached — the date is just where that number lands. Left in the same grey as the
    // date, "68 days" read as a footnote to a date picker rather than as the length of a commitment
    // you cannot take back.
    //
    // innerHTML rather than textContent, because a colour needs an element to hang off. Both parts
    // are escaped even though they come from gates.js and are built from digits and month names:
    // this line is written on every keystroke in the boxes above, and "the source is trusted" is a
    // property that stops being true the first time someone adds a field to it.
    const red = (s2) => `<span class="dred">${escHtml(s2)}</span>`;
    if (running) {
      const left = FGGates.strictLeftText(st);
      el.innerHTML = escHtml("On until " + FGGates.strictUntilLabel(cur) + ", " +
                             FGGates.strictUntilTime(st)) +
                     (left ? " · " + red(left + " left") : "");
      return;
    }
    // Measured as a moment, not a day, because that is what is being set. The same helper the lock
    // itself uses, so the words here and the words in the hint below cannot disagree.
    const probe = { ...st, strictUntil: v.iso, strictUntilTime: readUntilTime() };
    const at = FGGates.strictDeadlineAt(probe);
    const when = label + ", " + readUntilTime();
    if (!at || at <= Date.now()) { el.innerHTML = escHtml(when) + " · " + red("already gone"); return; }
    const leftNew = FGGates.strictLeftText(probe);
    el.innerHTML = escHtml(when) + (leftNew ? " · " + red(leftNew) : "");
  }
  document.querySelectorAll("[data-dstep]").forEach(b => b.addEventListener("click", () => {
    const [id, stepRaw] = String(b.getAttribute("data-dstep") || "").split(":");
    const step = num(stepRaw);
    const v = readUntilBoxes();
    if (id === "D") {
      // Clamped, not wrapped. The 31st stepping up to the 1st would move the commitment a month
      // BACKWARDS, which is the one direction this control must never take.
      v.d = Math.max(1, Math.min(dLastDay(v.y, v.m), v.d + step));
    } else if (id === "M") {
      v.m = Math.max(1, Math.min(12, v.m + step));
      v.d = Math.min(v.d, dLastDay(v.y, v.m));
    } else {
      v.y = Math.max(thisYearNow(), Math.min(thisYearNow() + YEARS_AHEAD, v.y + step));
      v.d = Math.min(v.d, dLastDay(v.y, v.m));           // 29 Feb only exists some years
    }
    paintUntilBoxes(v);
    paintUntilPreview();
  }));
  ["untilD", "untilM", "untilY"].forEach(id => {
    const el = $("#" + id);
    if (!el) return;
    el.addEventListener("input", paintUntilPreview);
    // Tidied when you leave the box, not while typing: clamping mid-keystroke turns "1" on its way
    // to "12" into "1" and then the next digit makes it "11".
    el.addEventListener("change", () => { paintUntilBoxes(readUntilBoxes()); paintUntilPreview(); });
  });
  $("#untilT")?.addEventListener("input", paintUntilPreview);
  $("#untilT")?.addEventListener("change", paintUntilPreview);
  paintUntilPreview();

  // ---- one warning, for both halves of strict mode ----
  // These two switches used to warn differently. The daily freeze got a plain notice and a "Freeze
  // settings" button; the deadline got a typed phrase and a five-second wait. The reasoning was
  // proportionality — one lifts each morning, the other does not lift at all — and in use it was
  // wrong. Two dialogues for two switches on one card, met one after the other, read as two
  // unrelated features rather than as one setting with two shapes, and the lighter one taught you to
  // click through the heavier one without reading it.
  //
  // So they share this. Same phrase, same wait, same buttons, same list of what you are giving up.
  // The only thing that differs is the sentence saying WHEN it applies, which is the only real
  // difference between them.
  //
  // Unified upwards, not downwards. Making the deadline's confirmation lighter would take a guard
  // off the one action on this card that genuinely cannot be undone, and where the two directions
  // are not equally safe this file picks the safe one.
  //
  // The list is shared because the restrictions are: both switches feed one answer, FGGates.strictNow
  // via inStrictWindow, and every guard in the extension asks that one question. So there was never
  // a per-switch list to write — the daily one was simply missing two of the items, including the
  // power switch, which its own wording had never mentioned.
  const STRICT_LOSSES =
    "today's goal cannot be lowered, sites cannot be unblocked, the camera checks cannot be eased "
    + "off, the extension cannot be switched off, and neither of these two switches can be turned off";
  //
  // Five presses rather than a typed phrase, and no countdown alongside them — see the note on
  // confirmReset for why typing was the wrong shape of friction for a switch you are trying to turn
  // ON, and why the taps stand in for the wait rather than being added to it.
  function confirmStrictOn({ title, when, tail }) {
    return confirmReset({
      title,
      body: when + " " + STRICT_LOSSES + ". " + tail,
      phrase: "",
      taps: 5,
      wait: 0,
      go: "Lock it",
      keep: "Cancel"
    });
  }

  // Flipping the switch on is what starts the stretch. There is no Save button: the boxes are the
  // value, the switch is the action, and the warning in between is what makes it deliberate.
  async function startDeadline() {
    const st = await getState();
    // Validated by the same rules the file import uses, so nothing can be stored through these
    // boxes that a backup would have been refused for.
    const dPlan = FGSettings.checkOne("strictUntil", readUntilBoxes().iso);
    const tPlan = FGSettings.checkOne("strictUntilTime", readUntilTime());
    if (!dPlan.ok || !tPlan.ok) { toast("That isn't a real date and time."); return false; }
    const want = dPlan.value, wantT = tPlan.value;

    const at = FGGates.strictDeadlineAt({ strictUntil: want, strictUntilTime: wantT });
    if (!at || at <= Date.now()) { toast("That moment has already gone. Pick a later one."); return false; }

    if (!await confirmStrictOn({
      title: "Keep strict mode on until " + FGGates.strictUntilLabel(want) + ", " + wantT + "?",
      when: "From now until then, continuously:",
      // The one thing this switch has to say that the other does not: it does not lift by itself,
      // and it cannot be moved.
      tail: (FGGates.strictLeftText({ strictUntil: want, strictUntilTime: wantT }) || "") + " from now. "
          + "It cannot be extended or shortened afterwards, and there is no undo."
    })) return false;
    // The switch and the moment are written together. One without the other would look like a lock
    // and hold nothing — strictDeadlineActive needs both.
    await setStateP({ strictUntil: want, strictUntilTime: wantT, strictUntilEnabled: true });
    renderApp();
    toast("Strict mode is on until " + FGGates.strictUntilLabel(want) + ", " + wantT);
    return true;
  }

  // ---- the daily freeze's own switch ----
  // Was a Turn on / Turn off button at the foot of the card. A button was fine while the card did
  // one thing; now it does two, and one button could only ever have meant one of them.
  $("#strictEn")?.addEventListener("change", async () => {
    const st = await getState();
    const want = !!$("#strictEn")?.checked;
    if (!want) {
      // One refusal covers both reasons now, because inStrictWindow covers both: inside the daily
      // window, or inside a running deadline. The message names which, since "it cannot be switched
      // off" without a reason is the kind of thing people assume is a bug.
      if (inStrictWindow(st)) {
        renderApp();
        if (FGGates.strictDeadlineActive(st)) {
          const left = FGGates.strictLeftText(st);
          return toast("Strict mode is held until " + FGGates.strictUntilLabel(FGGates.strictUntil(st)) +
                       ", " + FGGates.strictUntilTime(st) + (left ? " — " + left + " left." : "."));
        }
        return toast("Strict mode is active right now — it cannot be switched off until the window ends");
      }
      await setStateP({ strictModeEnabled: false });
      renderApp();
      return toast("Daily freeze off");
    }
    // Turning it ON stores the times the card is displaying, not just the flag. Storing only the
    // flag left the times absent, the guard fell back to a zero-length window, and strict mode was
    // armed in the UI and inert in fact.
    const times = strictBoxes();
    if (!times) { renderApp(); return toast("Pick two different times first — a window that starts and ends together never opens."); }
    // Read before you flip it. This switch is one click wide and what it does is refuse you things
    // for hours at a time, including the use of this switch — so what is about to happen is said
    // plainly first, in the same words and the same shape as its neighbour. See confirmStrictOn.
    if (!await confirmStrictOn({
      title: "Freeze settings from " + times.strictStart + " to " + times.strictEnd + " every day?",
      when: "Between those two times, every day:",
      // The one thing this switch has to say that the other does not: it does end on its own.
      tail: "The window lifts by itself when it reaches " + times.strictEnd + ", and comes back the "
          + "next day. Making things stricter stays possible at any time."
    })) { renderApp(); return; }
    await setStateP(Object.assign(times, { strictModeEnabled: true }));
    renderApp();
    toast("Settings will freeze from " + times.strictStart + " to " + times.strictEnd);
  });

  // ---- the deadline's own switch ----
  // The only control this row has. On reads the boxes, warns, and starts the stretch; off ends it,
  // and is refused while it is running, which is the whole point of it.
  //
  // It no longer asks whether the daily freeze is on. The deadline freezes everything by itself; it
  // used to be a date that merely held that switch in place, which made it useless alone.
  $("#strictUntilEn")?.addEventListener("change", async () => {
    const st = await getState();
    const want = !!$("#strictUntilEn")?.checked;
    if (!want) {
      if (FGGates.strictDeadlineActive(st)) {
        const left = FGGates.strictLeftText(st);
        renderApp();
        return toast("Held until " + FGGates.strictUntilLabel(FGGates.strictUntil(st)) + ", " +
                     FGGates.strictUntilTime(st) + (left ? " — " + left + " left." : ".") +
                     " This cannot be switched off until then.");
      }
      await setStateP({ strictUntilEnabled: false });
      renderApp();
      return toast("No end time set");
    }
    // On. The switch IS the commit now, so the warning and the write happen here rather than behind a
    // Save button — and if the warning is declined the switch goes back where it was.
    if (!await startDeadline()) renderApp();
  });

  // ---- backup & restore ----
  // Which keys travel, and what each value has to look like, is settings.js — shared
  // with the worker so the two cannot drift. Nothing about the classification is
  // decided here; this is the file dialog and the speed bump.
  const STRICT_NO_IMPORT = "Strict mode is on. You cannot import settings now.";
  $("#expSettings")?.addEventListener("click", async () => {
    if (!window.FGSettings) return toast("Could not read the settings");
    const st = await getState();
    let file;
    try { file = window.FGSettings.fileFor(st, chrome.runtime.getManifest().version); }
    catch (e) {
      // The toast is for you; the console line is for whoever has to find out why. Swallowed without
      // one, this hid a checker in settings.js that threw on every export.
      try { console.warn("[AnkiGate] export failed:", e); } catch (e2) {}
      return toast("Could not read the settings");
    }
    const n = Object.keys(file.settings).length;
    // Indented, not minified. Someone will open this in a text editor to check what
    // they are carrying between machines, and that is a use worth two extra kilobytes.
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
    const day = new Date();
    const stamp = [day.getFullYear(),
                   String(day.getMonth() + 1).padStart(2, "0"),
                   String(day.getDate()).padStart(2, "0")].join("-");
    if (!saveBlob(blob, `block-sites-anki-settings-${stamp}.json`)) {
      return toast("Could not save the file");
    }
    toast(`${n} settings saved to Downloads`);
  });

  // The visible button does the checking; the input is only the file dialog. Checked
  // here as well as being disabled in the markup, because a disabled attribute is a
  // hint and this is a rule.
  $("#impSettings")?.addEventListener("click", async () => {
    const st = await getState();
    if (inStrictWindow(st)) return toast(STRICT_NO_IMPORT);
    $("#impFile")?.click();
  });
  $("#impFile")?.addEventListener("change", async (e) => {
    const input = e.target;
    const file = input.files && input.files[0];
    // Cleared at once. Picking the same file twice fires no `change` at all otherwise,
    // which reads as the button having stopped working.
    input.value = "";
    if (!file) return;
    // A settings backup is a few kilobytes. Anything remotely large is not one, and
    // reading it into a string first would be the wrong way to find that out.
    if (file.size > 2 * 1024 * 1024) return toast("That file is too big to be a settings backup.");
    if (!window.FGSettings) return toast("Could not read that file");
    let parsed;
    try { parsed = JSON.parse(await file.text()); }
    catch { return toast("That file isn't readable JSON."); }
    const plan = window.FGSettings.read(parsed);
    if (!plan.ok) return toast(plan.error);

    // Strict mode, three times over: before the dialog, after it, and after the
    // confirm sheet. Each of those steps hands control back to the user for as long as
    // they like, and the window can open while any of them is on screen. This is the
    // same double-check the "start the day over" button does, for the same reason.
    if (inStrictWindow(await getState())) return toast(STRICT_NO_IMPORT);

    const bits = [`${plan.count} setting${plan.count === 1 ? "" : "s"} will be replaced by what is in the file.`];
    if (plan.unknown.length) {
      // Not escaped here: confirmReset escapes the whole body before it goes near the
      // DOM. Escaping twice would show a hand-edited key called `a<b` as `a&lt;b`.
      bits.push(`${plan.unknown.length} entr${plan.unknown.length === 1 ? "y" : "ies"} in it ` +
                `(${plan.unknown.slice(0, 3).join(", ")}${plan.unknown.length > 3 ? "…" : ""}) ` +
                `aren't settings and will be ignored.`);
    }
    bits.push("Today's progress, your streak and your password are not touched.");
    if (!await confirmReset({
      title: "Replace your settings with this file?",
      body: bits.join(" "),
      phrase: "yes i want to import",
      go: "Import"
    })) return;
    const before = await getState();
    if (inStrictWindow(before)) return toast(STRICT_NO_IMPORT);

    // A running deadline survives a restore. Otherwise the way out is: export today, import
    // tomorrow — the file would carry strictUntilEnabled:false, or an earlier moment, and either one
    // ends the stretch early. Those keys are held back and the rest of the file goes in as normal,
    // so a backup is still a backup.
    //
    // Reachable at all only because a deadline that has NOT started yet leaves inStrictWindow false,
    // so the import above is allowed. While one is running the import is refused outright.
    if (FGGates.strictDeadlineActive(before)) {
      const heldAt = FGGates.strictDeadlineAt(before);
      const wantAt = FGGates.strictDeadlineAt(plan.patch);
      delete plan.patch.strictUntilEnabled;
      // Unless the file goes FURTHER than you already are, which is the one direction always allowed.
      if (!(wantAt && wantAt > heldAt)) {
        delete plan.patch.strictUntil;
        delete plan.patch.strictUntilTime;
      }
      toast("Imported. Strict mode stays held until " +
            FGGates.strictUntilLabel(FGGates.strictUntil(before)) + ", " +
            FGGates.strictUntilTime(before) + ".");
    }
    await setStateP(plan.patch);
    tellWorker({ type: "refreshBlockedTabs" });
    // The goal, the checks and the deck lists may all have moved, and what is blocked
    // right now follows from them. Ask for a fresh reading rather than waiting up to
    // three seconds for the next poll to notice.
    try { chrome.runtime.sendMessage({ type: "ankiPoll" }, () => void chrome.runtime.lastError); } catch {}
    // renderRoot, never renderApp: the file may have switched the password door back on,
    // and the door is renderRoot's job.
    await renderRoot();
    toast(`${plan.count} settings imported ✓`);
  });

  // What keeps you honest is the password on both doors, auto-lock, and strict
  // mode. Nothing here touches Chrome's own control over this extension: it can
  // be disabled or removed from chrome://extensions at any time, like any other.
}

// ---- the Password tab ----------------------------------------------------
function renderSecurity(s) {
  const tc = document.getElementById("tabContent");
  const strict = inStrictWindow(s);
  const pwOn = s.passwordProtectionEnabled !== false;
  const lockDelay = Math.max(0, s.autoLockDelaySec || 0);
  const dis = strict ? "disabled" : "";
  tc.innerHTML = `
    <div class="card">
      <div class="chead">
        <span class="ctile" aria-hidden="true">🔑</span>
        <div class="ctitle">
          <div class="crow">
            <h2>Password ${tip(`When this is <b>on</b>, your password is needed to open the popup and this settings page — so you can't quickly undo your own rules in a weak moment.<br/><br/>Turning it off asks for the password first.<br/><br/>It locks itself again when you close it; how soon is set in the ⚙️ Setup tab.${strict ? "<br/><br/><b style='color:var(--bad)'>Strict mode: you can't change any of this right now.</b>" : ""}`)}</h2>
          </div>
          <div class="csub">${pwOn ? "On" : `<span class="why">Off</span>`} · ${lockDelay === 0 ? "locks when you close this page" : `locks ${lockDelay}s after you close this page`}</div>
        </div>
        ${sw("pwOn", pwOn, strict, "Ask for my password")}
      </div>

      ${pwOn ? `
      <!-- Nothing but this button until you ask for something. -->
      <div class="pwacts">
        <button class="btn sec" id="pwChangeOpen" type="button" ${dis}>Change password</button>
      </div>
      <form class="pwform" id="pwChangeForm" hidden>
        <div>
          <label for="oldPw">Current password</label>
          <input class="input" id="oldPw" type="password" autocomplete="current-password" ${dis}/>
        </div>
        <div>
          <label for="newPw">New password (4 characters or more)</label>
          <input class="input" id="newPw" type="password" autocomplete="new-password" ${dis}/>
        </div>
        <div class="btns">
          <button class="btn" id="changePw" type="submit" ${dis}>Save</button>
          <button class="btn sec" id="pwChangeCancel" type="button">Cancel</button>
        </div>
      </form>
      <!-- Turning it off needs the current password, so the switch springs back and
           this opens instead. -->
      <form class="pwform" id="pwOffForm" hidden>
        <div>
          <label for="disablePw">Your password, to turn this off</label>
          <input class="input" id="disablePw" type="password" autocomplete="current-password" ${dis}/>
        </div>
        <div class="btns">
          <button class="btn danger" id="disableProt" type="submit" ${dis}>Turn off</button>
          <button class="btn sec" id="pwOffCancel" type="button">Cancel</button>
        </div>
      </form>` : (s.passwordHash ? "" : `
      <!-- No password exists yet, so this is the only thing to do here and it stays
           open. -->
      <form class="pwform" id="pwOnForm">
        <div>
          <label for="newProtPw">Choose a password (4 characters or more)</label>
          <input class="input" id="newProtPw" type="password" autocomplete="new-password"/>
        </div>
        <div class="btns">
          <button class="btn" id="enableProt" type="submit">Turn on</button>
        </div>
      </form>`)}
      <div class="err" id="pwErr"></div>
    </div>

    ${pwOn ? `<div class="card">
      <div class="chead">
        <span class="ctile" aria-hidden="true">🔒</span>
        <div class="ctitle">
          <div class="crow">
            <h2>Lock full settings page ${tip(`When this is <b>on</b>, opening the settings page shows <b>only a password prompt</b> — nothing is visible until you enter your password. Not the goal, not the blocklist, not the streak.<br/><br/>When <b>off</b> (the default), the settings page opens normally and only asks for your password when you try to ease a rule off.<br/><br/>While this is on and the page is locked, the webhook URLs cannot be edited either.${strict ? "<br/><br/><b style='color:var(--bad)'>Strict mode: you can't change this right now.</b>" : ""}`)}</h2>
          </div>
          <div class="csub">${s.fullPageLockEnabled ? "On — page is hidden until unlocked" : `<span class="why">Off</span> — page is read-only when locked`}</div>
        </div>
        ${sw("fpLockOn", !!s.fullPageLockEnabled, strict, "Lock full settings page")}
      </div>
    </div>` : ""}`;

  // Only one form is ever open, and opening one clears whatever the last attempt
  // complained about.
  const err = () => $("#pwErr");
  const showForm = (id) => {
    ["#pwChangeForm", "#pwOffForm"].forEach(sel => {
      const f = $(sel);
      if (!f) return;
      f.hidden = sel !== id;
      if (f.hidden) f.querySelectorAll("input").forEach(i => { i.value = ""; });
    });
    const open = id ? $(id) : null;
    if (err()) err().textContent = "";
    open?.querySelector("input")?.focus();
  };

  $("#pwChangeOpen")?.addEventListener("click", () => showForm("#pwChangeForm"));
  $("#pwChangeCancel")?.addEventListener("click", () => showForm(null));
  $("#pwOffCancel")?.addEventListener("click", () => showForm(null));

  // The switch is the only on/off control. Turning it ON is free when a password
  // already exists; turning it OFF has to be confirmed.
  $("#pwOn")?.addEventListener("change", async () => {
    const st = await getState();
    if (inStrictWindow(st)) { renderApp(); return toast("Strict mode: cannot change password settings"); }
    const wantOn = $("#pwOn").checked;
    if (!wantOn) {
      $("#pwOn").checked = true;                 // stays on until confirmed
      showForm("#pwOffForm");
      return;
    }
    if (st.passwordHash) {
      // Raw: putting the lock back on is the stricter direction, and asking for the password
      // in order to switch the password on reads as a riddle.
      await setStateRaw({ passwordProtectionEnabled: true });
      toast("Password needed again 🔒");
      renderApp();
    } else {
      $("#pwOn").checked = false;                // nothing to protect with yet
      renderApp();
      toast("Choose a password first");
    }
  });
  // Submit rather than click, so Enter in either box does what the button does —
  // which is what anyone typing a password expects. preventDefault because a form
  // left to itself would try to navigate this page away.
  $("#pwChangeForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const st = await getState();
    if (inStrictWindow(st)) return toast("Strict mode: cannot change the password");
    const oldP = $("#oldPw").value, newP = $("#newPw").value;
    if (!oldP || !newP) { err().textContent = "Fill in both boxes"; return; }
    if ((await sha256(oldP)) !== st.passwordHash) { err().textContent = "That isn't your current password"; return; }
    if (newP.length < 4) { err().textContent = "The new password needs 4 characters or more"; return; }
    // Raw: the old password was just checked two lines up. The gate would ask for it again.
    await setStateRaw({ passwordHash: await sha256(newP) });
    showForm(null);
    toast("Password changed ✓");
  });
  $("#pwOffForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const st = await getState();
    if (inStrictWindow(st)) return toast("Strict mode: cannot turn the password off");
    const pw = $("#disablePw").value || "";
    if (!pw) { err().textContent = "Enter your password"; return; }
    if ((await sha256(pw)) !== st.passwordHash) { err().textContent = "Wrong password"; return; }
    // Raw: this form IS the password check.
    await setStateRaw({ passwordProtectionEnabled: false, sessionUnlocked: true });
    editLocked = false;
    toast("Password turned off");
    renderApp();
  });
  $("#pwOnForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const st = await getState();
    if (!st.passwordHash) {
      const np = $("#newProtPw")?.value || "";
      if (np.length < 4) { err().textContent = "Pick a password of 4 characters or more"; return; }
      await setStateRaw({ passwordHash: await sha256(np) });
    }
    // Raw, both of them: switching protection on is the stricter direction, and there may be
    // no password to ask for yet — the line above may have only just made one.
    await setStateRaw({ passwordProtectionEnabled: true, sessionUnlocked: true });
    editLocked = false;
    toast("Password turned on 🔒");
    renderApp();
  });

  // ---- full-page lock toggle ----
  // Turning it ON is the stricter direction: it hides the whole page instead of just gating edits.
  // Turning it OFF is a loosening and goes through setStateP, which asks for the password.
  $("#fpLockOn")?.addEventListener("change", async () => {
    const st = await getState();
    if (inStrictWindow(st)) { renderApp(); return toast("Strict mode: cannot change this right now"); }
    const wantOn = $("#fpLockOn").checked;
    if (wantOn) {
      // Stricter direction — free.
      await setStateRaw({ fullPageLockEnabled: true });
      toast("Full-page lock on 🔒");
    } else {
      // Loosening — password gate handles it.
      try {
        await setStateP({ fullPageLockEnabled: false });
        toast("Full-page lock off");
      } catch (e) { return; }
    }
    renderApp();
  });
}

// ---------------------------------------------------------------------------
// Live progress. The background credits a second at a time, and this page used
// to only find out when you reloaded it. Re-rendering the tab every second isn't
// an option — it would take the focus out of whatever box you're typing in — so
// only the numbers, the bars and the row colours are repainted.
// ---------------------------------------------------------------------------
function paintScore(s) {
  const strip = document.querySelector(".score");
  if (!strip) return;
  const xp = s.xp || 0, level = s.level || 1;
  const pct = Math.round(((xp % 500) / 500) * 100);
  const on = s.ankiEnabled !== false;
  const total = on ? 1 : 0;
  const done = on && ankiGoalMet(s) ? 1 : 0;
  const mins = Math.floor((s.ankiEnabled !== false ? (s.ankiSpentSec || 0) : 0) / 60);
  const set = (k, text) => { const el = strip.querySelector(`[data-k="${k}"]`); if (el) el.textContent = text; };
  set("level", "Lv " + level);
  set("streak", String(s.streakCount || 0));
  set("done", `${done}/${total}`);
  set("mins", mins + "m");
  const bar = strip.querySelector(".xpbar > span");
  if (bar) bar.style.width = pct + "%";
  const doneChip = strip.querySelector('[data-k="done"]')?.parentElement;
  if (doneChip) {
    const all = total > 0 && done >= total;
    doneChip.classList.toggle("ok", all);
    doneChip.innerHTML = doneChip.innerHTML.replace(/^\s*(✅|☑️)/, all ? "✅" : "☑️");
  }
}
function paintFlow(s) {
  const bar = document.getElementById("flowBar");
  if (!bar) return;
  const f = flowFigures(s);
  const { done, pct, nothing } = f;
  bar.classList.toggle("done", done);
  const spentLine = document.getElementById("flowSpent");
  if (spentLine && spentLine.textContent !== f.spentLine) spentLine.textContent = f.spentLine;
  const t2 = document.getElementById("flowTitle2");
  if (t2) t2.textContent = done ? "🔓 These are open now" : "🔒 To open these";
  const track = document.getElementById("flowProg");
  if (track) track.hidden = nothing;
  paintBar(document.querySelector("#flowProg > div"), pct);
  const pctLine = document.getElementById("flowPct");
  if (pctLine) {
    pctLine.hidden = nothing;
    pctLine.classList.toggle("done", done);
    pctLine.textContent = done ? "🎉 All done. Enjoy!" : pct + "% done";
  }
}
async function paintLive(state) {
  const s = state || await getState();
  paintScore(s);
  paintFlow(s);
  // The camera window has its own button for the overlay markers and writes the same
  // key. This switch has to follow it, because commitAnki persists a snapshot of the
  // whole anti-cheat card — so a stale checkbox here would put the overlay back on
  // the next time the goal was nudged by a second.
  const ov = document.getElementById("ankiOverlay");
  if (ov) {
    const want = !!s.camOverlayEnabled;
    if (ov.checked !== want) ov.checked = want;
  }
  if (ankiRepaint) { try { await ankiRepaint(s); } catch {} }
}

// Clicking a chip in step 2 goes to the tab you already have open on it, and only
// opens a new one when there isn't one. Ctrl / middle click keep the browser's own
// behaviour, so power users aren't fought.
document.addEventListener("click", (e) => {
  const a = e.target.closest && e.target.closest("a.nmlink, a.chiplink");
  if (!a) return;
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return;
  e.preventDefault();
  try {
    chrome.runtime.sendMessage({
      type: "openTarget",
      pattern: a.getAttribute("data-open-pattern") || "",
      url: a.getAttribute("href") || ""
    }, () => void chrome.runtime.lastError);
  } catch {}
});

// Anki opening or closing should show on the dot straight away. While this page is
// in front we ask about once a second, which also keeps the background awake — so
// the dot reflects Anki now, not whatever was last written to storage.
let ankiWatchTimer = 0;
function watchAnki() {
  clearInterval(ankiWatchTimer);
  ankiWatchTimer = setInterval(async () => {
    if (document.hidden) return;
    if (!document.getElementById("ankiRefresh")) return;   // the Anki card isn't on screen
    const s = await getState();
    // `=== false`, like every other read of the power switch in this file. An absent key
    // means "on" everywhere else, and reading it as "off" here would stop the connection
    // dot refreshing for a profile where `enabled` had never been written.
    if (s.enabled === false || s.ankiEnabled === false) return;
    try { chrome.runtime.sendMessage({ type: "ankiPoll" }, () => void chrome.runtime.lastError); } catch {}
  }, 1200);
}
watchAnki();

// Keys that change while you're just sitting there studying. The ticker sentences
// are deliberately left alone: rewriting them restarts their scroll.
const LIVE_KEYS = ["ankiSpentSec", "ankiReviewedToday", "ankiStudying", "ankiReason",
                   "ankiConnected", "ankiLastPollAt", "ankiBridgeOk", "ankiBridgeVersion",
                   "ankiPinSupported", "ankiEnabled", "ankiRequiredSec",
                   // The unlock gates the add-on measures, and the per-deck clocks.
                   // All of these move while you sit and study, so they belong here
                   // and not in STRUCTURAL_KEYS — a redraw every three seconds would
                   // fight the caret in whichever box you were typing in.
                   "ankiGoalsAt", "ankiUniqueToday", "ankiDueLeft", "ankiDueAtDayStart",
                   "ankiRetPass", "ankiRetAgain", "ankiDeckSpent",
                   // The two deadline stamps. Live rather than structural for the same reason: they are
                   // written by the poll while you sit there, and the countdown beside the time limit
                   // has to move — see paintDeadlineRows, which repaints them in place.
                   "ankiMetAt", "ankiGraceFrom",
                   // Written by the camera window's own overlay button — see paintLive.
                   "camOverlayEnabled",
                   // What the add-on says each of the three Anki locks is doing. They normally arrive
                   // in the same poll as ankiLastPollAt above, but "locked" versus "waiting for Anki"
                   // should not depend on riding along with something else.
                   "ankiLockActive", "ankiLockAddonsActive", "ankiLockNewActive",
                   "xp", "level", "streakCount"];
// Changes that alter what the page IS, not just what its numbers say — so a second
// settings tab has to redraw rather than repaint. See the listener below.
const STRUCTURAL_KEYS = ["blockMode", "blockedSites", "allowedSites",
                         "strictModeEnabled", "strictStart", "strictEnd",
                         "strictUntil", "strictUntilTime", "strictUntilEnabled",
                         "ankiRequireForeground", "ankiTimerWindow",
                         "ankiAutoCam", "ankiFaceRequired",
                         "ankiEyeRequired", "ankiBlinkRequired", "ankiLivenessEnabled",
                         "ankiActiveGrading", "ankiInactivityPauseEnabled",
                         "ankiMediaRequired", "ankiMediaPauseEnabled", "ankiMediaResumeEnabled",
                         "ankiPaceEnabled",
                         "ankiPaceFast", "ankiPaceSlow", "ankiPaceBoxPct", "ankiAntiSpamEnabled",
                         "ankiMinCardsEnabled", "ankiUniqueOnly",
                         "ankiDeckRestrictEnabled", "ankiDecks",
                         "ankiDueGateEnabled", "ankiDueDecks", "ankiRetentionEnabled",
                         "ankiDeckTimeEnabled", "ankiDeckTimes",
                         // The two deadlines' own settings, as opposed to the stamps they are measured
                         // against, which are in LIVE_KEYS above. Switching one on or moving the hours
                         // changes which controls the card shows, so a second settings tab has to
                         // redraw rather than repaint.
                         "ankiWinEnabled", "ankiWinStart", "ankiWinEnd",
                         "ankiGraceEnabled", "ankiGraceSec",
                         // The phone bridge. Here so a second settings tab follows along, the way
                         // it has to for the blocklist — mobileLockSent and mobileLockAt are
                         // deliberately NOT here: they move on their own, from a background fetch,
                         // and are repainted in place instead. See the listener below.
                         "macrodroidEnabled", "macrodroidLockUrl", "macrodroidUnlockUrl",
                         "dailyResetTime", "autoLockDelaySec",
                         "fullPageLockEnabled",
                         // Which AI answers. It decides which key the key box shows and writes, and
                         // whether "Watch the video" can be pressed — so a second settings tab left on
                         // the other service would keep offering the key box and depths of a service
                         // that is no longer the one being asked.
                         "ytAiProvider"];
let livePaintTimer = 0;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  // The power switch changes what the whole page means, banner included, and it's
  // a deliberate one-off act — so that one gets a full redraw, not a repaint.
  // The session locking from outside (the auto-lock delay running out while this page sits
  // open) re-arms the edit gate and puts the banner back.
  if (changes.sessionUnlocked || changes.passwordProtectionEnabled) {
    // Unless this page is the one that just unlocked. The edit that asked for the password is
    // still in flight, and rebuilding the DOM under it would take away the controls it is about
    // to write from and tidy up. editLocked is already right, so there is nothing stale.
    if (selfUnlock) { selfUnlock = false; return; }
    renderRoot().catch(() => {});
    return;
  }
  // Nothing repaints over the password screen. renderRoot, never renderApp: this
  // used to be the way past the door — see renderRoot().
  if (lockedNow) return;
  // The phone's status line, repainted in place. The worker writes these two from a fetch that can
  // land at any moment — including while you are half way through typing an address — so this must
  // never be a redraw. And not a `return`: one storage burst can carry these alongside live keys.
  if (changes.mobileLockSent || changes.mobileLockAt) paintPhoneState().catch(() => {});
  if (changes.enabled) { renderRoot().catch(() => {}); return; }
  // theme.js recolours the page by itself, so a repaint isn't needed for that —
  // but the Setup tab shows the theme as a pair of radio buttons, and those have
  // to follow if you flip it from the ☀️ button in the title bar instead.
  if (changes.theme && activeTab === "setup") { renderRoot().catch(() => {}); return; }
  // Structural changes made in ANOTHER settings tab.
  //
  // The page can be open twice, and only the live keys were followed — so tab A
  // switching to Allowlist left tab B still showing Blocklist ticked. Clicking the
  // already-ticked radio fires no `change` event at all, so that tab could never
  // switch back without a manual reload. Same for strict mode: no banner, and
  // controls still live that the other tab had just frozen.
  //
  // Only when nothing is focused, so a redraw never yanks the form out from under
  // someone mid-edit — they'd lose the keystroke and the caret.
  if (STRUCTURAL_KEYS.some(k => k in changes)) {
    const el = document.activeElement;
    const busy = el && el !== document.body &&
                 /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || "");
    if (!busy) { renderRoot().catch(() => {}); return; }
  }
  if (!LIVE_KEYS.some(k => k in changes)) return;
  clearTimeout(livePaintTimer);
  livePaintTimer = setTimeout(() => { paintLive().catch(() => {}); }, 120);
});

// ---------------------------------------------------------------------------
// The finish line. When today's Anki goal is done the background tells every open
// page, and this draws the trophy card and the confetti.
// ---------------------------------------------------------------------------
function partyConfetti(count) {
  const colors = ["#f97316", "#eab308", "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#06b6d4"];
  const box = document.createElement("div");
  box.className = "fgparty";
  for (let i = 0; i < count; i++) {
    const p = document.createElement("i");
    p.style.left = (Math.random() * 100) + "%";
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = (Math.random() * 0.6).toFixed(2) + "s";
    p.style.animationDuration = (2.2 + Math.random() * 2).toFixed(2) + "s";
    p.style.setProperty("--rot", Math.floor(Math.random() * 720 - 360) + "deg");
    box.appendChild(p);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 5600);
}
function partySound() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((freq, i) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = freq;
      const at = ctx.currentTime + i * 0.12;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.25, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.4);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at); osc.stop(at + 0.45);
    });
  } catch {}
}
let partyUp = false;
function celebrateAllDone(payload) {
  if (partyUp) return;
  partyUp = true;
  const p = payload || {};
  const back = document.createElement("div");
  back.className = "fgwin";
  back.innerHTML = `
    <div class="fgwincard" role="alertdialog" aria-live="assertive">
      <div class="fgtrophy" aria-hidden="true">🏆</div>
      <h2>${escHtml(p.title || "Anki done for today! 🏆")}</h2>
      <p>${escHtml(p.subtitle || "Today's Anki goal is finished. Your locked sites are open.")}</p>
      ${p.xp ? `<div class="fgxp">+${p.xp} XP</div>` : ""}
      <button class="btn" id="fgwinClose">Nice 🎉</button>
    </div>`;
  document.body.appendChild(back);
  const close = () => { partyUp = false; back.remove(); };
  back.querySelector("#fgwinClose").addEventListener("click", close);
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  requestAnimationFrame(() => back.classList.add("show"));
  partyConfetti(120);
  partySound();
  // The page behind it should already show everything as finished.
  paintLive().catch(() => {});
  setTimeout(() => { if (partyUp) close(); }, 12000);
}
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "celebrateAll") celebrateAllDone(msg.payload);
});

// ---- number boxes: click and type ----------------------------------------
// Click into any number box and what's in it comes up selected, so the first digit you
// type replaces it instead of joining it.
//
// Every number on this page — seconds, minutes, card counts, percentages — is a small
// value you replace wholesale. None of them is a string you edit one digit of. But a
// click put the caret wherever you happened to click, so typing 5 into a box reading 10
// gave you 105, 150 or 510 depending on the pixel, and you had to select or backspace
// first every single time.
//
// Delegated on the document, once, and never bound per box. This page throws its whole
// DOM away and rebuilds it on every save (see renderApp), so a listener on an element
// would be discarded within seconds and every freshly rendered box would arrive without
// it. Delegation also means a number box added anywhere later gets this for free.
//
// Two events, because one isn't enough:
//   focusin  — Tab, or focus moved by code.
//   pointerup — a click fires focusin too, but the browser then places the caret under
//               the pointer, which collapses the selection just made. So it has to be
//               made again afterwards.
// Dragging across the digits is left alone: if the pointer moved, the selection on
// screen is the one the user drew, and overriding it would make part-editing impossible.
function selectNumberBoxesOnFocus() {
  const isNumBox = (el) =>
    el instanceof HTMLInputElement && el.type === "number" && !el.disabled && !el.readOnly;
  // select() is only specified for inputs that "support selection", which `number` is not.
  // Chrome implements it anyway; what it does NOT allow is reading selectionStart on one —
  // that throws. So: call select, guard it, and never ask the element what is selected.
  const selectAll = (el) => { try { el.select(); } catch (e) {} };

  let downOn = null, downX = 0, downY = 0;
  document.addEventListener("focusin", (e) => {
    if (isNumBox(e.target)) selectAll(e.target);
  });
  // Capture, so this still runs if something nearer the box stops the event.
  document.addEventListener("pointerdown", (e) => {
    downOn = isNumBox(e.target) ? e.target : null;
    downX = e.clientX; downY = e.clientY;
  }, true);
  document.addEventListener("pointerup", (e) => {
    const el = downOn;
    downOn = null;
    if (!el || e.target !== el) return;
    // A drag, not a click: they drew their own selection, so leave it be.
    if (Math.abs(e.clientX - downX) > 3 || Math.abs(e.clientY - downY) > 3) return;
    selectAll(el);
  }, true);
}
selectNumberBoxesOnFocus();

// ---- the door ------------------------------------------------------------
// Every route to drawing this page goes through here, not just the first one.
//
// The door used to be inline in init(), which ran exactly once — so anything else
// that called renderApp() painted the unlocked settings page with no password check
// at all. The storage listener was one such caller, and the way in was short:
// unlock Settings, switch the extension off from the popup, let the session lock,
// open options.html (password screen), then flip the power back on from the popup
// (which only asks for a password in the OFF direction). The `enabled` change fired,
// renderApp() ran, and the password prompt was replaced by the full settings page.
//
// What is behind the door changed. A locked session used to mean the page WAS the password box;
// now it means the page is read-only and every write asks — see requireUnlock. The hole the
// note above describes is closed either way, because it was about renderApp() being reachable
// without a check, and the check has moved to the writes themselves rather than to the paint.
//
// Making a password for the first time is the one case still worth a whole page: there is no
// hash to check anything against, so "read-only until you prove who you are" has nothing to
// mean, and the page has a question of its own to ask before it can be a settings page at all.
async function renderRoot() {
  const s = await getState();
  if (s.passwordProtectionEnabled === false) { lockedNow = false; editLocked = false; return renderApp(); }
  if (!s.passwordHash) { lockedNow = true; editLocked = false; return renderSetupPassword(); }
  // Full-page lock: when on AND the session is not unlocked, nothing is shown at all.
  // The user must enter the password before even seeing the settings page.
  if (s.fullPageLockEnabled && !s.sessionUnlocked) {
    lockedNow = true;
    editLocked = true;
    return renderFullPageLock();
  }
  lockedNow = false;
  editLocked = !s.sessionUnlocked;
  return renderApp();
}
// A refused write is not a fault, and it has already said so on screen. Kept out of the
// console so the one that matters is still worth reading.
window.addEventListener("unhandledrejection", (e) => {
  if (e && e.reason && e.reason.name === "EditLocked") e.preventDefault();
});
// Every page load — including a refresh — starts locked. The password you entered in
// the previous load does not carry over: you prove who you are once per visit, not
// once until the auto-lock expires. selfUnlock silences the storage listener for the
// write we are about to do, the same way it does when this page unlocks itself later.
selfUnlock = true;
chrome.storage.local.set({ sessionUnlocked: false, autoLockDueAt: 0 })
  .then(() => renderRoot())
  .catch(() => renderRoot());
