// Popup: today's Anki progress at a glance, a power switch, and the way into
// settings. There is only one thing to earn here, so there is only one row.

// Keep-alive port, so the background knows when the popup closes and can re-lock.
try { chrome.runtime.connect({ name: "popup" }); } catch {}

// The add-on version this build expects. Older ones can't hold the camera window
// on top, and nobody can diagnose that alone.
//
// Read from the add-on that actually ships inside this extension rather than
// typed in here. It was a hardcoded string, which meant three copies of the
// version number (here, anki-addon/addon.json, and __init__.py) that could
// and did drift — the popup would nag you to install a version it wasn't
// shipping. The fallback covers the instant before the fetch lands.
let ANKI_ADDON_VERSION = "4.7";
try {
  fetch(chrome.runtime.getURL("anki-addon/addon.json"))
    .then(r => r.json())
    .then(m => {
      if (!m || !m.human_version) return;
      const was = ANKI_ADDON_VERSION;
      ANKI_ADDON_VERSION = String(m.human_version);
      // Repainted if the real number turned out to differ from the fallback. The first
      // render can happen before this lands, and it compares the installed add-on
      // against whatever this holds — so a stale fallback showed "update the add-on"
      // for the version the user already had, and nothing came back to correct it.
      if (was !== ANKI_ADDON_VERSION && document.getElementById("list")) renderDashboard();
    })
    .catch(() => {});
} catch {}

async function sha256(str) {
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

const $ = (sel) => document.querySelector(sel);
const root = document.getElementById("root");

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// One info bubble, in the top bar. Everything else explains itself through
// plain-language rows, with the detail on hover (title attributes).
function tip(html) {
  return `<span class="tip" tabindex="0" role="button" aria-label="More information">
    <span class="tip-i" aria-hidden="true">?</span>
    <span class="tip-box" role="tooltip">${html}</span>
  </span>`;
}
// Tap-to-open for the bubbles lives in tip.js, which this page loads.

function fmt(sec) {
  sec = Math.max(0, num(sec) | 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

// A finite number or the fallback — never NaN, never Infinity, never a string.
//
// The worker heals bad types in storage on its next poll, but this popup reads
// storage directly and paints what it finds, so it does its own coercion. Without
// it one wrong value printed "NaN%" as the big number on screen: `Math.min(1800,
// "abc")` is NaN and NaN then survives every step after it, in silence.
function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
// An "HH:MM" out of storage. A number or an object here used to throw on .split()
// and leave the popup completely blank.
function hhmm(v, fallback = "00:00") {
  return typeof v === "string" && /^\d{1,2}:\d{2}$/.test(v.trim()) ? v.trim() : fallback;
}
// A list of sites out of storage. A string here has a .length too, which is how a
// corrupt value could claim "3 sites locked".
function list(v) { return Array.isArray(v) ? v : []; }

// paintBar / barStyle come from bars.js, which this page loads first.

async function getState() { return await chrome.storage.local.get(null); }
async function setState(p) { return await chrome.storage.local.set(p); }

// Strict mode freezes the escape hatches, including the power switch.
//
// From gates.js, not worked out here. This was the second copy of the rule, and its fallback for a
// missing time differed from the settings page's — so the two could disagree about whether strict
// mode was running, and the copy that decides whether the power switch works is the worst place for
// that. It also now covers the deadline, which this page would otherwise have known nothing about:
// the power switch would have been available during a stretch that exists to make it unavailable.
function inStrictWindow(s) {
  return FGGates.strictNow(s);
}

// Opening the Anki desktop app. Chrome cannot run a program, so the background
// picks between two routes: if Anki is running, the add-on inside it raises its
// own window; if it isn't, the add-on has registered a URL with Windows that
// starts Anki, and an extension page is allowed to open that. Windows asks for
// permission the first time.
// The schemes this extension's add-on registers. Checked, not trusted: the value arrives
// as JSON from whatever is answering on port 8766, and handing an arbitrary scheme to an
// <a href> means asking the browser to invoke an arbitrary registered handler.
// The legacy spelling is accepted too: an add-on installed before the rename
// registered that scheme with Windows and reports it, and the add-on is updated by
// hand. See ANKI_LAUNCH_SCHEME in background.js, which is where it is validated.
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
function openAnkiApp() {
  try {
    chrome.runtime.sendMessage({ type: "ankiOpen" }, (r) => {
      void chrome.runtime.lastError;
      if (r && r.ok) { window.close(); return; }
      if (r && r.scheme && launchByScheme(r.scheme)) {
        // The background watches for Anki coming up and, if it never does, opens
        // its download page — the popup won't be here to see either outcome.
        try { chrome.runtime.sendMessage({ type: "ankiLaunchWatch" }, () => void chrome.runtime.lastError); } catch {}
        setTimeout(() => window.close(), 500);   // let Windows take the URL first
        return;
      }
      // Otherwise stay open — the row under the name already says why.
    });
  } catch {}
}

// Is Anki connected right now? The stored flag is only as fresh as the last poll,
// and nothing polls while the gate is off — which is how a green "connected" could
// survive an Anki that had been closed for hours.
function ankiLinkedNow(s) {
  if (!s || s.ankiEnabled === false || !s.ankiConnected) return false;
  return (Date.now() - num(s.ankiLastPollAt)) < 25000;
}

// ---------------- password ----------------
// The popup itself is just a read-out, so it opens straight away. The password is
// asked for at the two doors that actually let you undo your own rules: opening
// the settings page, and switching the extension off.
async function needsPassword(s) {
  if (s.passwordProtectionEnabled === false) return false;
  if (!s.passwordHash) return false;      // nothing to check against yet
  return !s.sessionUnlocked;
}

function askPassword(why) {
  return new Promise(resolve => {
    modalOpen++;
    const back = document.createElement("div");
    back.className = "pwask";
    back.innerHTML = `
      <div class="pwcard" role="dialog" aria-modal="true" aria-label="Password needed">
        <div class="glyph" aria-hidden="true">🔒</div>
        <h2>Password needed</h2>
        <p>${esc(why || "")}</p>
        <input id="pwAsk" type="password" placeholder="Password" />
        <div class="err" id="pwAskErr"></div>
        <div class="pwrow">
          <button class="btn" id="pwAskNo">Cancel</button>
          <button class="btn primary" id="pwAskGo">Unlock</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    const box = back.querySelector("#pwAsk"), err = back.querySelector("#pwAskErr");
    const close = (ok) => { modalOpen = Math.max(0, modalOpen - 1); back.remove(); resolve(ok); };
    const submit = async () => {
      const pw = box.value || "";
      if (!pw) { err.textContent = "Password required"; return; }
      const s = await getState();
      if ((await sha256(pw)) !== s.passwordHash) { err.textContent = "Wrong password"; box.select(); return; }
      await setState({ sessionUnlocked: true });
      close(true);
    };
    back.querySelector("#pwAskGo").addEventListener("click", submit);
    back.querySelector("#pwAskNo").addEventListener("click", () => close(false));
    back.addEventListener("click", (e) => { if (e.target === back) close(false); });
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
      else if (e.key === "Escape") close(false);
    });
    setTimeout(() => box.focus(), 20);
  });
}
// True when you may go ahead: no password set up, already unlocked this session,
// or you just typed it correctly.
async function unlockedFor(why) {
  const s = await getState();
  if (!(await needsPassword(s))) return true;
  return await askPassword(why);
}

// Switching the extension back ON, agreed to out loud.
//
// It still costs no password, and it never should: the point of the power switch is that turning
// your own rules back on is the easy direction and turning them off is the hard one. But free is
// not the same as accidental. This is one tap in a small popup that also holds a break button and
// a settings link, and what that tap actually does is hand the day back to the rules — every
// locked site locks again at once, the camera window comes back, and if the phone bridge is set up
// your phone is told to lock too. All of that happening with no acknowledgement is the kind of
// surprise that teaches people not to trust the toolbar icon.
//
// A plain yes/no, deliberately: no typing, no countdown, no repeated presses. confirmReset's
// shapes are for destruction and for commitments you cannot walk back — this is the thing you
// were trying to do, and friction in front of it would be pointed the wrong way.
//
// ---------------- the phone, and the one thing it needs ----------------
//
// The webhook bridge is the only part of this extension that depends on something outside this
// computer: a call goes out to MacroDroid on your phone, and a phone with no connection never hears
// it. That failure is silent, and it looks exactly like the extension being broken — you switch
// blocking off, your phone stays locked, and nothing anywhere says why.
//
// So it is said out loud at the two moments it can bite: switching blocking ON, which is the call
// that locks the phone, and switching it OFF, which is the call that releases it. Of the two, off is
// the one that strands you.
//
// Only when the bridge is actually switched on. On a profile that has never touched the phone
// feature this sentence is noise about something that does not exist, which is the whole reason it
// is gated rather than always shown.
const PHONE_NET_LINE = "Make sure your phone has <b>mobile data or Wi-Fi on</b> so MacroDroid receives the webhook. " +
                       "If it was offline, AnkiGate tries again about once a minute.";
// The bridge counts as live only with somewhere to call. A switch turned on above two empty boxes
// sends nothing, so a warning about connectivity would be about a call that is never made.
function phoneBridgeLive(s) {
  return !!(s && s.macrodroidEnabled === true && (s.macrodroidLockUrl || s.macrodroidUnlockUrl));
}

// How many dialogs are up right now. The live repainter reads it and leaves the power switch alone
// while one is: a `change` event has ALREADY flipped the box, so writing the stored value over it
// every second would drag the knob back under the very question that is asking about it.
let modalOpen = 0;

// Why a send to the phone failed, in words that name the fix. The same causes the settings page tells
// apart after ▶ Test — a mistyped address and a phone with no signal need opposite fixes, and "could
// not reach your phone" is the wrong sentence for the first.
function phoneFailText(r) {
  const e = String((r && r.error) || "unreachable");
  if (e === "empty" || e === "bad_url") {
    return "📱 The webhook address in Settings → <b>Apps on my phone</b> looks wrong, so nothing was sent.";
  }
  if (e === "no_permission") {
    return "📱 Chrome hasn't been allowed to call that webhook yet — press <b>▶ Test</b> in Settings → Apps on my phone.";
  }
  if (e.slice(0, 5) === "http_") {
    return `📱 MacroDroid answered ${esc(e.slice(5))} — check you copied the whole webhook address into Settings.`;
  }
  return "📱 <b>Couldn't reach MacroDroid.</b> Check this computer's internet, and that your phone has " +
         "<b>mobile data or Wi-Fi on</b>. AnkiGate tries again about once a minute.";
}

// Tell the phone NOW, and say what happened.
//
// Forced, so it goes out even when the worker believes the phone already has this state — that belief
// is a record of the last send that succeeded, and the one moment it must not be trusted is the moment
// somebody has just switched the rules on or off by hand. The worker merges it with the send its own
// storage listener starts for the same switch, so one press is one webhook.
//
// The first line goes up before the answer, because the answer can take a few seconds and the reminder
// is the part worth reading: a phone with no connection never hears the call.
function tellPhoneNow(want) {
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  popToast(offline
    ? "📱 This computer looks <b>offline</b>, so MacroDroid can't be told yet. " + PHONE_NET_LINE
    : (want ? "📱 Locking your phone's apps again… " : "📱 Releasing your phone's apps… ") + PHONE_NET_LINE,
    offline ? "phone warn" : "phone", offline ? 9000 : 12000);
  try {
    chrome.runtime.sendMessage({ type: "macrodroidSync" }, (r) => {
      void chrome.runtime.lastError;
      // No answer means the worker was being restarted. Its storage listener sends the same state on
      // the way back up, so the reminder already on screen is still the right thing to be showing.
      if (!r) return;
      if (r.ok) {
        popToast(r.locked
          ? "📱 Lock sent to MacroDroid ✓ — your apps close as soon as your phone gets it. Keep its mobile data or Wi-Fi on."
          : "📱 Unlock sent to MacroDroid ✓ — your apps open as soon as your phone gets it. Keep its mobile data or Wi-Fi on.",
          "phone", 6500);
      } else if (r.error !== "off") {
        popToast(phoneFailText(r), "phone warn", 9000);
      }
    });
  } catch {}
}

// A line along the bottom of the popup. Takes HTML, because the thing it says wants a word in bold —
// anything variable must be run through esc() by the caller.
//
// Fixed to the bottom rather than flowing into the list, because it must not move the control your
// cursor has just pressed. It never takes clicks either, for the same reason.
let popToastTimer = 0;
function popToast(html, cls, ms) {
  // One at a time. Two of these stacked in a popup this narrow would cover the thing they are about.
  document.querySelectorAll(".pop-toast").forEach(n => n.remove());
  const el = document.createElement("div");
  el.className = "pop-toast" + (cls ? " " + cls : "");
  el.setAttribute("role", "status");
  el.innerHTML = html;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  clearTimeout(popToastTimer);
  popToastTimer = setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => { try { el.remove(); } catch {} }, 250);
  }, Math.max(1200, ms || 5200));
}

// It borrows askPassword's card wholesale rather than bringing a stylesheet of its own. Same box,
// same buttons, same scrim, so it reads as the same kind of moment.
function confirmPowerOn(s) {
  const required = Math.max(0, num(s && s.ankiRequiredSec));
  const spent = Math.max(0, num(s && s.ankiSpentSec));
  const left = Math.max(0, required - spent);
  // What is actually outstanding, said in the same words the dashboard uses. With no goal set
  // there is nothing to finish, so the sentence would be a promise the extension cannot keep —
  // hence two wordings rather than one with a zero in it.
  // No goal at all (see hasGoal in gates.js) is its own sentence: there is nothing to lock a site behind,
  // so the worker leaves them open, and saying they lock "straight away" would be untrue.
  const line = !FGGates.hasGoal(s || {})
    ? `Blocking comes back on — but no study goal is set yet, so nothing is locked until you set one in Settings.`
    : required <= 0
    ? `Your sites lock again straight away, until the checks you set in Settings are done.`
    : left <= 0
      ? `Your sites lock again straight away — but today's goal is already done, so they will open again on the next check.`
      : `Your sites lock again straight away, and stay locked until you have done ${esc(fmt(left))} more Anki today.`;
  return new Promise(resolve => {
    modalOpen++;
    const back = document.createElement("div");
    back.className = "pwask";
    back.innerHTML = `
      <div class="pwcard" role="alertdialog" aria-modal="true" aria-labelledby="poTitle" aria-describedby="poBody">
        <div class="glyph" aria-hidden="true">🛡️</div>
        <h2 id="poTitle">Switch blocking back on?</h2>
        <p id="poBody">${line}</p>
        ${phoneBridgeLive(s) ? `<p class="powarn">📱 Your phone's apps get locked again too. ${PHONE_NET_LINE}</p>` : ""}
        <div class="pwrow">
          <button class="btn" id="poNo">Not yet</button>
          <button class="btn primary" id="poGo">Switch it on</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    const yes = back.querySelector("#poGo"), no = back.querySelector("#poNo");
    function close(v) {
      document.removeEventListener("keydown", onKey, true);
      modalOpen = Math.max(0, modalOpen - 1);
      back.remove();
      resolve(v);
    }
    // Capturing, and Enter only while the confirm button has the focus. Escape anywhere means no,
    // which is the same bargain every other dialog in this extension strikes.
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); close(false); }
      else if (e.key === "Enter" && document.activeElement === yes) { e.preventDefault(); close(true); }
    }
    document.addEventListener("keydown", onKey, true);
    back.addEventListener("click", (e) => { if (e.target === back) close(false); });
    no.addEventListener("click", () => close(false));
    yes.addEventListener("click", () => close(true));
    // The confirm button takes the focus, unlike the password card's Cancel. Nothing here is
    // destructive, so the default action is the safe one and Enter should reach it.
    setTimeout(() => yes.focus(), 20);
  });
}

// Switching the extension OFF, agreed to out loud — on a profile with no password.
//
// With a password set, the password IS the confirmation and this is skipped: two dialogs stacked over
// one click is the kind of friction people learn to click through without reading. Without one, the
// switch used to act the instant it was touched, and a checkbox is the easiest thing in a popup to hit
// by accident.
//
// It is also the only moment the phone reminder can still change the decision. "Off" on a locked phone
// with no signal is a phone that STAYS locked, and that is worth knowing before pressing it, not after.
//
// The same card as confirmPowerOn, but the focus lands on "Keep it on": this is the direction that
// stands every rule down, so the answer under Enter and Space is the safe one.
function confirmPowerOff(s) {
  return new Promise(resolve => {
    modalOpen++;
    const back = document.createElement("div");
    back.className = "pwask";
    back.innerHTML = `
      <div class="pwcard" role="alertdialog" aria-modal="true" aria-labelledby="pfTitle" aria-describedby="pfBody">
        <div class="glyph" aria-hidden="true">⚠️</div>
        <h2 id="pfTitle">Switch blocking off?</h2>
        <p id="pfBody">Nothing is blocked and nothing is counted until you switch it back on. Today's progress is kept.</p>
        ${phoneBridgeLive(s) ? `<p class="powarn">📱 Your phone's apps are released too. ${PHONE_NET_LINE}</p>` : ""}
        <div class="pwrow">
          <button class="btn" id="pfNo">Keep it on</button>
          <button class="btn danger" id="pfGo">Switch it off</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    const yes = back.querySelector("#pfGo"), no = back.querySelector("#pfNo");
    function close(v) {
      document.removeEventListener("keydown", onKey, true);
      modalOpen = Math.max(0, modalOpen - 1);
      back.remove();
      resolve(v);
    }
    // Enter only acts on the button that has the focus, and the focus starts on "Keep it on".
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); close(false); }
      else if (e.key === "Enter" && document.activeElement === yes) { e.preventDefault(); close(true); }
    }
    document.addEventListener("keydown", onKey, true);
    back.addEventListener("click", (e) => { if (e.target === back) close(false); });
    no.addEventListener("click", () => close(false));
    yes.addEventListener("click", () => close(true));
    setTimeout(() => no.focus(), 20);
  });
}

// ---------------- dashboard ----------------
const ANKI_REASONS = {
  no_bridge: `install the Anki add-on`,
  not_foreground: `Anki isn't the window in front`,
  not_fullwindow: `make Anki full screen`,
  no_reviewer: `open a card in Anki`,
  in_browser: `you're in the browser, not Anki`,
  no_face: `your face isn't visible`,
  still: `move the mouse or type in Anki`,
  media_paused: `press play on this card's video`,
  media_buffering: `the video is still loading`,
  wrong_deck: `this deck doesn't count`,
  same_card: `answer the card you're on`,
  spam: `answers too fast to count`,
  idle: `answer a card to start the clock`
};

// `stillNeeded` is what the gates say is outstanding once the clock is full — an
// empty string when the clock itself is the thing that's short. It replaced a
// boolean that could only ever mean "review more cards": with due, retention and
// per-deck quotas in the picture, a popup that knew only about the card count would
// say "Paused — answer a card to resume" while the real answer was "14 still due".
function ankiNote(s, met, stillNeeded) {
  if (!ankiLinkedNow(s)) return { text: "Anki not detected — click to open it", warn: true };
  if (s.ankiBridgeOk && s.ankiBridgeVersion && s.ankiBridgeVersion !== ANKI_ADDON_VERSION) {
    return { text: `Add-on is v${s.ankiBridgeVersion} — install v${ANKI_ADDON_VERSION} from Settings`, warn: true };
  }
  if (met) return { text: "Done", warn: false };
  if (s.ankiStudying) return { text: "Counting now", warn: false };
  // Indexed with a stored value, so it is a string before it touches the table —
  // otherwise an object key reads as "[object Object]" and, worse, "constructor"
  // or "toString" would come back as a function and be printed as source code.
  const why = ANKI_REASONS[String(s.ankiReason || "")];
  if (typeof why === "string") return { text: "Paused — " + why, warn: true };
  if (stillNeeded) return { text: "Time done — " + stillNeeded, warn: true };
  return { text: "Paused — answer a card to resume", warn: true };
}

// How long the clock has been stopped for, right now. 0 when it isn't.
//
// ankiStoppedAt is a stamp, not a clock: the worker writes the instant the count stopped and then
// leaves it alone for the whole stretch, so the length has to be worked out here against the local
// clock. That is what lets the figure keep moving between polls, and it is also why the reason
// changing underneath a pause doesn't restart it — see ankiStoppedAt in background.js.
// Floor, not round. A duration should never claim more time than has actually passed — rounding
// would put "for 5s" on screen at four and a half — and the camera window's caption floors the same
// subtraction, so flooring here is what makes the two agree to the second instead of to the nearest
// one. Math.max guards the other end: a stamp in the future can only be clock skew, and a negative
// second count would come out of fmt as a nonsense duration rather than as nothing.
function pausedForSec(s) {
  const since = num(s.ankiStoppedAt);
  if (!since) return 0;
  return Math.max(0, Math.floor((Date.now() - since) / 1000));
}

// "Why isn't my timer moving?" — one line under the big number.
function liveLine(s, ankiOn, met) {
  // The reason on its own was never the whole answer: "your face isn't visible" reads identically
  // after four seconds and after forty minutes, and only one of those is worth getting up for.
  //
  // Shown only past five seconds. Under that it changes faster than it can be read, and ordinary
  // reviewing stops the clock for a second here and there constantly — a number flickering on every
  // one of those would make the popup look frantic about nothing. Same threshold as the camera
  // window's caption, which is deliberate: the two are describing one stretch and disagreeing about
  // whether it has begun would be worse than either rule on its own.
  const held = pausedForSec(s);
  const held_ = held >= 5 ? " for " + fmt(held) : "";
  // A break you asked for outranks every other explanation.
  if (s.userPaused) return { text: "On a break — nothing is counting", cls: "warn" };
  if (met) return { text: "All done for today ✓", cls: "on" };
  if (!ankiOn) return { text: "Set an Anki goal to start earning", cls: "" };
  // Counting, but not from Anki — an allowed study video is playing. Said separately because the two
  // look identical here and are not the same thing: one of them is spending a capped daily allowance,
  // and somebody watching the number go up while looking at YouTube should be told which.
  //
  // With how much of today's video allowance is gone, because that is the other number moving while you
  // watch — and the one that decides when this stops counting.
  if (s.ankiStudying && s.ankiReason === "watching") {
    const used = Math.max(0, num(s.ytWatchedSec));
    const cap = Math.max(0, num(s.ytWatchCapSec, 900));
    return {
      text: "📺 Counting — study video · " + (cap > 0 ? `${fmt(used)} of ${fmt(cap)} today` : `${fmt(used)} today`),
      cls: "on"
    };
  }
  if (s.ankiStudying) return { text: "Counting now", cls: "on" };
  // Anki being shut is its own kind of stopped, and how long it has been shut is the same question
  // as how long anything else has been wrong — so it carries the figure too.
  if (!ankiLinkedNow(s)) return { text: "Open Anki to start counting" + held_, cls: "warn" };
  const why = ANKI_REASONS[String(s.ankiReason || "")];
  if (typeof why === "string") return { text: "Paused" + held_ + " — " + why, cls: "warn" };
  return { text: "Paused" + held_ + " — answer a card to resume", cls: "warn" };
}

// How the locked list reads in one line, so the popup says what's at stake without
// listing every site.
function lockedLine(s) {
  // A day off answers this line's question outright: nothing is locked, so counting the list would be
  // reporting on a rule that is not running today. First, before the mode is even looked at, because
  // it is true in both modes — including allowlist mode, whose sentence is otherwise the alarming one
  // ("every site is blocked") and would be flatly wrong.
  if (s.enabled !== false && !FGGates.dayIsOn(s)) {
    return `<b>${FGGates.dayName(s)}</b> is a day off — nothing is blocked today.`;
  }
  if ((s.blockMode || "blacklist") === "whitelist") {
    const n = list(s.allowedSites).length;
    if (!n) return `Allowlist mode · nothing is allowed yet, so <b>every site</b> is blocked.`;
    return `Allowlist mode · only <b>${n}</b> site${n === 1 ? "" : "s"} stay open.`;
  }
  const n = list(s.blockedSites).length;
  if (!n) return `No sites locked yet — add some in Settings.`;
  return `<b>${n}</b> site${n === 1 ? "" : "s"} locked until this is done.`;
}

// Everything the dashboard shows, worked out once. Both the full render and the
// live repaint read this, so they can never disagree.
function computeView(s) {
  const on = s.enabled !== false;
  const strict = inStrictWindow(s);
  // A weekday switched off in Settings → Setup. Nothing is blocked today, so the popup must not go on
  // saying "Locked": that is the one word in here people act on, and being wrong about it means
  // either sitting on a rest day you thought was enforced, or hunting for a bug that is a setting.
  //
  // Kept separate from `on` rather than folded into it. They are different facts and the popup has to
  // be able to tell them apart — the power switch has to keep showing that the extension itself is on,
  // or the obvious next move on a rest day is to flip a switch that is already where you want it.
  const dayOff = on && !FGGates.dayIsOn(s);

  const required = Math.max(0, num(s.ankiRequiredSec));
  const ankiOn = s.ankiEnabled !== false;
  const req = ankiOn ? required : 0;
  const spent = ankiOn ? Math.max(0, num(s.ankiSpentSec)) : 0;
  // Every condition the user switched on, decided in gates.js. This used to be
  // "time is done and the card count is met", spelled out here — one of four copies
  // of that rule, and the copy that told you whether you were finished.
  const gates = FGGates.evaluate(s);
  // Nothing to do today: a 0s goal and no other gate. gates.js calls that "met" in the empty sense,
  // which is right for the blocking — there is nothing to lock a site behind — and wrong for this
  // popup, which read it as "Unlocked · Anki done — enjoy" with a green dot on a fresh install. So it
  // is its own state here, like a day off. See hasGoal in gates.js.
  const noGoal = on && !dayOff && !FGGates.hasGoal(s);
  const met = gates.on && gates.met && !noGoal;
  const pct = req > 0 ? Math.round(100 * Math.min(req, spent) / req) : (met ? 100 : 0);
  // Everything except the clock, since the clock is the bar right above this line.
  const beyondTime = gates.items.filter(i => i.blocked && i.key !== "time");

  const rows = [];
  if (ankiOn) {
    const note = noGoal
      ? { text: "No goal yet — set a time in Settings", warn: false }
      : ankiNote(s, met, beyondTime.map(i => i.left).join(" · "));
    // The running figures for the other gates, so the row says where you are and not
    // only what is missing.
    // The due gate is the one that counts DOWN, so it gets its own words rather than
    // being forced into have/need like the others. `have` is how many are still due and
    // `need` is how many are allowed to remain, so "14/0 due" read as no progress at all
    // and a satisfied gate read as "0/0 due". gates.js already writes the sentence.
    const extra = gates.items
      .filter(i => i.key !== "time")
      .map(i => i.key === "due"
        ? ` · ${i.left}`
        : ` · ${i.have}/${i.need} ${i.key === "retention" ? "right" : i.key === "cards" ? "cards" : i.label}`)
      .join("");
    rows.push({
      key: "anki", name: "Anki",
      spent, required: req, met, noGoal,
      note: note.text + extra, noteWarn: note.warn,
      title: "Click to open the Anki desktop app"
    });
  }

  // The phone, when the bridge is in use at all. null leaves the pill out entirely rather than
  // reporting a state for a feature nobody switched on.
  //
  // It shows what the worker last managed to PUSH, falling back to what should be true when it has
  // pushed nothing yet. Those are two different facts and this reports the first on purpose: a
  // phone still holding its apps shut is exactly what you open this popup to find out about, and
  // "open" printed a second before the unlock actually lands is the one answer here that would send
  // somebody hunting for a bug in MacroDroid.
  const phoneWant = FGGates.phoneLockWanted(s);
  const phone = phoneWant === null ? null
    : (s.mobileLockSent === true || s.mobileLockSent === false ? s.mobileLockSent : phoneWant);

  return {
    on, strict, dayOff, noGoal, dayName: FGGates.dayName(s), rows, totalReq: req, totalSpent: spent, pct,
    allDone: met, phone,
    paused: !!s.userPaused,
    live: noGoal && !s.userPaused
      ? { text: "Set an Anki goal in Settings to start earning", cls: "" }
      : liveLine(s, ankiOn, met),
    locked: noGoal ? "No goal set yet, so nothing is locked. Set one in Settings." : lockedLine(s),
    xp: Math.max(0, Math.round(num(s.xp))),
    level: Math.max(1, Math.round(num(s.level, 1))),
    streak: Math.max(0, Math.round(num(s.streakCount))),
    resetAt: hhmm(s.dailyResetTime)
  };
}

// The pill on the right of the row. "no goal" rather than "0s left" when there is nothing to do: a
// countdown from zero reads as a day that has just been finished.
function rowTimeText(r, done, left) {
  if (done) return "done";
  if (r.noGoal) return "no goal";
  return fmt(left) + " left";
}

function rowHtml(r) {
  const pct = r.required ? Math.min(100, Math.round(100 * r.spent / r.required)) : 0;
  const left = Math.max(0, r.required - r.spent);
  // "done" is every gate, not a full bar. The bar is the clock, and with a due or
  // retention gate still open the clock filling up is not the end of the day — this
  // pill used to say "done" while the sites were still locked.
  const done = r.required > 0 && left === 0 && r.met !== false;
  return `
    <div class="item" data-row="${esc(r.key)}">
      <div class="top">
        <button class="nm link" data-anki="1" title="${esc(r.title || "")}"><span class="lbl">${esc(r.name)}</span><span class="ext" aria-hidden="true">↗</span></button>
        <span class="rt ${done ? "done" : ""}">${rowTimeText(r, done, left)}</span>
      </div>
      <div class="bar-track"><i class="${done ? "full" : ""}" style="${barStyle(pct)}"></i></div>
      <div class="note ${r.noteWarn ? "warn" : ""}"${r.note ? "" : " hidden"}>${esc(r.note || "")}</div>
    </div>`;
}

// What's on screen right now, so the repainter knows when a full redraw is due.
let shownKeys = "";
// What the popup's LAYOUT depends on, as one string — so the repainter can tell "a number moved"
// from "something appeared or went away".
//
// The rows, and whether the phone pill is there at all. That second part matters because a pill
// which has just been switched on cannot be repainted into existence: paintLive only writes into
// elements that already exist, so without this the pill would stay missing until the popup was
// opened again.
function viewShape(v) {
  return v.rows.map(r => r.key).join("|") + "#" + (v.phone === null ? "-" : "p");
}

// Ask the background for a fresh Anki reading, but never in front of a paint.
// Talking to the Anki desktop can take a moment (and the service worker may have
// to wake up first), so awaiting it before the first render is what used to make
// the popup appear as an empty sliver for seconds. The answer lands in storage and
// the live repainter picks it up.
function refreshAnkiSoon() {
  try { chrome.runtime.sendMessage({ type: "ankiPoll" }, () => void chrome.runtime.lastError); } catch {}
}

// The three things at the top of the popup that describe the whole state: the word, the line under it,
// and the colour the window wears.
//
// Pulled out of the two functions below, which each had their own copy of all three written inline.
// They were identical, which is exactly why they had to be moved: the copies are what a new state gets
// added to one of, and the one that gets forgotten is the live repainter — so the popup would have
// told the truth when it opened and quietly gone back to "Locked" a second later.
function stateWord(v) {
  if (!v.on) return "Off";
  if (v.dayOff) return "Day off";
  if (v.noGoal) return "No goal";
  return v.allDone ? "Unlocked" : "Locked";
}
function stateSubText(v) {
  if (!v.on) return "nothing is blocked or counted";
  // Names the day rather than saying "today". You open this popup to find out why a site opened, and
  // "Sunday is off in Settings" is the answer; "today is off" leaves you wondering which switch.
  if (v.dayOff) return `${v.dayName} is off — nothing is blocked`;
  if (v.noGoal) return "set one in Settings — nothing is blocked yet";
  return v.allDone ? "Anki done — enjoy" : `resets at ${v.resetAt}`;
}
// A rest day borrows the "off" palette: the dot goes grey and the word loses its colour, which is the
// honest picture — nothing is being enforced. The power switch beside it still reads as on, because it
// is, and that pairing is the whole message. No goal yet is the same picture for the same reason, and
// it must NOT wear the green "done" one: nothing has been finished.
function bodyClass(v) {
  if (!v.on || v.dayOff || v.noGoal) return "off";
  return v.allDone ? "done" : "";
}

async function renderDashboard() {
  const s = await getState();
  const v = computeView(s);
  shownKeys = viewShape(v);

  document.body.className = bodyClass(v);

  const stateTxt = stateWord(v);
  const stateSub = stateSubText(v);

  root.innerHTML = `
    <div class="bar">
      <div class="state">
        <span class="dot"></span>
        <span class="col">
          <div class="txt"><span id="stateTxt">${stateTxt}</span>${tip(`<b>Locked</b> means your listed sites stay blocked until today's Anki goal is done.<br/><br/>The switch turns this extension <b>off completely</b> — no blocking, no counting, no camera. Turn it back on any time.<br/><br/>Switching it off asks for your password, so a weak moment costs more than one click.${v.strict ? "<br/><br/><b style='color:var(--bad)'>Strict mode is on: the switch is frozen.</b>" : ""}`)}</div>
          <div class="sub" id="stateSub">${esc(stateSub)}</div>
        </span>
      </div>
      <label class="pw" title="${v.on ? "Turn it off" : "Turn it on"}">
        <!-- aria-label goes on the INPUT, not the label. The label's only children
             are two decorative spans with no text, and a title on the label never
             becomes the checkbox's name — so the control that switches the whole
             extension off was announced as a bare "checkbox". -->
        <input type="checkbox" id="power" aria-label="${v.on ? "Turn the extension off" : "Turn the extension on"}"
               ${v.on ? "checked" : ""} ${v.strict ? "disabled" : ""}/>
        <span class="track"></span>
        <span class="knob"></span>
      </label>
    </div>

    <div class="hero">
      <div class="n" id="heroPct">${v.totalReq ? v.pct + "%" : "—"}</div>
      <div class="of" id="heroOf">${v.totalReq ? `${fmt(v.totalSpent)} of ${fmt(v.totalReq)} today` : "No Anki goal set yet"}</div>
      <div class="live ${v.live.cls}" id="heroLive"${v.on ? "" : " hidden"}>${esc(v.live.text)}</div>
    </div>

    <div class="list" id="list">${
      v.rows.length ? v.rows.map(rowHtml).join("")
        : `<div class="empty">No Anki goal yet — open Settings to set one.</div>`
    }<div class="locked" id="lockedLine">${v.locked}</div></div>

    <div class="stats">
      <span>⭐ <b id="statXp">${v.xp}</b> · <span id="statLvl">Lv ${v.level}</span></span>
      <span>🔥 <b id="statStreak">${v.streak}</b> <span id="statDays">day${v.streak === 1 ? "" : "s"}</span></span>
      ${v.phone === null ? "" : `<span title="Apps on your phone, blocked through MacroDroid until Anki is done. Set it up in Settings → step 2.">📱 <b id="statPhone">${v.phone ? "blocked" : "open"}</b></span>`}
    </div>

    <div class="foot">
      <button class="btn primary" id="openOptions">Settings</button>
      <button class="btn icon ${v.paused ? "onbreak" : ""}" id="brk"
              title="${v.paused ? "Back to work — start counting again" : "Take a break — stop the clock and the camera"}">${v.paused ? "▶" : "⏸"}</button>
      ${window.FGTheme ? window.FGTheme.buttonHtml("btn icon") : ""}
      <button class="btn icon" id="help" title="Email feedback to sinhanikhil549@gmail.com">✉</button>
    </div>`;

  bindDashboard();
  // Now that you can see something, go and check on Anki.
  if (v.on && s.ankiEnabled !== false) refreshAnkiSoon();
}

// Repaint the numbers without rebuilding the popup, so time earned while it's open
// shows up here as it happens.
function paintLive(s) {
  const v = computeView(s);
  const keys = viewShape(v);
  if (keys !== shownKeys) return renderDashboard();   // a row or the phone pill appeared or went

  document.body.className = bodyClass(v);
  const set = (id, text) => { const el = document.getElementById(id); if (el && el.textContent !== text) el.textContent = text; };
  set("stateTxt", stateWord(v));
  set("stateSub", stateSubText(v));
  set("heroPct", v.totalReq ? v.pct + "%" : "—");
  set("heroOf", v.totalReq ? `${fmt(v.totalSpent)} of ${fmt(v.totalReq)} today` : "No Anki goal set yet");
  const live = document.getElementById("heroLive");
  if (live) {
    live.hidden = !v.on;
    live.textContent = v.live.text;
    live.className = "live " + v.live.cls;
  }
  const locked = document.getElementById("lockedLine");
  if (locked) locked.innerHTML = v.locked;
  set("statXp", String(v.xp));
  set("statLvl", "Lv " + v.level);
  set("statStreak", String(v.streak));
  set("statDays", "day" + (v.streak === 1 ? "" : "s"));
  // Only when the pill is on screen. The switch being flipped while the popup is open is what would
  // make it appear or vanish, and that needs the full render — set() on a missing element is a
  // no-op, so this is safe either way rather than depending on which came first.
  if (v.phone !== null) set("statPhone", v.phone ? "blocked" : "open");

  const power = document.getElementById("power");
  // Left alone while a dialog is up — see modalOpen. The answer puts the switch where it belongs.
  if (power && !modalOpen) { power.checked = v.on; power.disabled = v.strict; }

  for (const r of v.rows) {
    const el = document.querySelector(`.item[data-row="${CSS.escape(String(r.key))}"]`);
    if (!el) continue;
    const pct = r.required ? Math.min(100, Math.round(100 * r.spent / r.required)) : 0;
    const left = Math.max(0, r.required - r.spent);
    // Every gate, not a full bar — the same rule rowHtml applies, and this copy was
    // missing it. The bar is the clock, so with a due, retention or per-deck gate still
    // open a full clock is not the end of the day. This runs on every storage burst and
    // once a second, so it overwrote the correct first render within moments: the pill
    // read "done" and the bar went green while the sites stayed locked.
    const done = r.required > 0 && left === 0 && r.met !== false;
    const rt = el.querySelector(".rt");
    if (rt) { rt.textContent = rowTimeText(r, done, left); rt.classList.toggle("done", done); }
    const fill = el.querySelector(".bar-track > i");
    if (fill) { paintBar(fill, pct); fill.classList.toggle("full", done); }
    const note = el.querySelector(".note");
    if (note) {
      note.hidden = !r.note;
      note.textContent = r.note || "";
      note.classList.toggle("warn", !!r.noteWarn);
    }
  }
}

function bindDashboard() {
  // Every query here is optional-chained. A dialog can be up, or a render can be
  // interrupted, and one missing element used to throw and leave the rest of the
  // popup's buttons unbound.
  //
  // Switching it off is the escape hatch, so it costs a password. Switching it
  // back on is free — that direction only ever helps you.
  $("#power")?.addEventListener("change", async (e) => {
    const st = await getState();
    if (inStrictWindow(st)) { renderDashboard(); return; }
    const want = e.target.checked;
    // Whether this press reaches for the phone as well as the browser. Read once, from the state this
    // handler already has, because the question below and the reminder after it must be about the same
    // answer — and the second of those runs after several awaits.
    const phone = phoneBridgeLive(st);
    if (!want) {
      // Off asks either for the password or, with none set, for a plain yes — never both. See
      // confirmPowerOff. Every refusal puts the box back, because a `change` event means it has ALREADY
      // flipped and nothing has been written.
      if (!(await needsPassword(st)) && !(await confirmPowerOff(st))) {
        e.target.checked = true;
        return;
      }
      if (!(await unlockedFor("Enter your password to switch this off."))) {
        e.target.checked = true;               // stays on until you prove it's you
        return;
      }
    } else if (!(await confirmPowerOn(st))) {
      // And the other direction asks too — not for a password, just for a yes. See confirmPowerOn.
      e.target.checked = false;
      return;
    }
    await setState({ enabled: want });
    // Turning it on should lock the tabs that should be locked, right away.
    // The callback matters even though the answer does not: without one, sendMessage returns a
    // promise, and a sleeping worker rejects it into an unhandled rejection.
    try { chrome.runtime.sendMessage({ type: "refreshBlockedTabs" }, () => void chrome.runtime.lastError); } catch {}
    renderDashboard();
    // The phone, on BOTH directions and on every path — including the one where a password was asked
    // instead of a question, which is precisely the path that had nothing to say about it.
    //
    // Off is the direction that can strand you: an unlock that never arrives means your apps stay shut
    // with nothing left running to release them. On is the one that locks them, and "why won't
    // Instagram open" in another room is not a question anybody traces back to this switch. Both are
    // a webhook that only works if the phone is online, so both say so — and then say whether it went.
    //
    // After the render, which rebuilds the popup and would otherwise be free to run over it.
    //
    // Worded from what the phone is actually about to be told rather than from the switch: switching
    // on with today's goal already finished sends "unlocked", and announcing a lock there would be
    // the one sentence in this popup that is simply untrue.
    if (phone) tellPhoneNow(FGGates.phoneLockWanted(Object.assign({}, st, { enabled: want })) === true);
  });

  // A break: the clock and the camera stop until you press play. No password
  // needed — pausing can only ever cost you time, never earn it.
  $("#brk")?.addEventListener("click", async () => {
    const st = await getState();
    await setState({ userPaused: !st.userPaused });
    renderDashboard();
  });

  // Straight through, no password. Settings is where the rules live, and it used to ask here —
  // but the page itself now asks at the moment something is actually being CHANGED, which is
  // what the password is for. Asking to merely look at your own goal, or to check whether Anki
  // is connected, was a toll on reading. And asking twice, here and again on the first edit,
  // would be worse than either.
  $("#openOptions")?.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  // The name opens the Anki desktop app.
  $("#list")?.addEventListener("click", (e) => {
    if (!e.target.closest("[data-anki]")) return;
    e.preventDefault();
    openAnkiApp();
  });

  // A mailto: link needs a mail app registered with Windows, and inside an
  // extension popup it usually does nothing at all. Open Gmail's compose window
  // instead — already addressed, subject filled in.
  $("#help")?.addEventListener("click", () => {
    const url = "https://mail.google.com/mail/?view=cm&fs=1" +
      "&to=" + encodeURIComponent("sinhanikhil549@gmail.com") +
      "&su=" + encodeURIComponent("Block Sites Until I Complete ANKI — feedback") +
      "&body=" + encodeURIComponent("\n\n---\nv" +
        (chrome.runtime.getManifest ? chrome.runtime.getManifest().version : ""));
    try {
      if (chrome.tabs && chrome.tabs.create) chrome.tabs.create({ url });
      else window.open(url, "_blank");
    } catch { window.open(url, "_blank"); }
    window.close();
  });
}

// ---------------- live updates ----------------
const LIVE_KEYS = ["ankiSpentSec", "ankiReviewedToday", "ankiStudying", "ankiReason",
                   // When the count stopped. Worth watching even though the figure beside it is
                   // worked out locally: this key moves exactly twice per stretch, at the start and
                   // at the end, and both of those are transitions the line should show at once
                   // rather than up to a second later.
                   "ankiStoppedAt",
                   "ankiConnected", "ankiLastPollAt", "ankiBridgeOk", "ankiBridgeVersion",
                   "ankiEnabled", "ankiRequiredSec", "ankiMinCards", "ankiMinCardsEnabled",
                   // The other unlock gates. Without these the popup could sit there
                   // saying "Time done — 14 still due" after the last card had been
                   // cleared, because nothing it watched had changed.
                   "ankiUniqueOnly", "ankiUniqueToday", "ankiGoalsAt",
                   "ankiDueGateEnabled", "ankiDueAllowed", "ankiDueLeft", "ankiDueDecks",
                   "ankiRetentionEnabled", "ankiMinRetention", "ankiRetPass", "ankiRetAgain",
                   "ankiDeckTimeEnabled", "ankiDeckTimes", "ankiDeckSpent",
                   "blockMode", "blockedSites", "allowedSites",
                   // The phone pill. mobileLockSent is what the worker last managed to push, so it
                   // is the one that actually moves the word — the switch and the addresses are in
                   // here too, since changing either can turn a pill that said "blocked" into one
                   // that should not be there at all.
                   "mobileLockSent", "macrodroidEnabled", "macrodroidLockUrl", "macrodroidUnlockUrl",
                   "xp", "level", "streakCount", "enabled", "userPaused",
                   // The video allowance on the live line while a study video counts.
                   "ytWatchedSec", "ytWatchCapSec", "ytWatchCounts"];
// Anki opening or closing while the popup is up should show immediately, so keep
// asking gently for as long as it's on screen. Each answer arrives through the
// storage listener below, never in front of a paint.
setInterval(async () => {
  const s = await getState();
  if (s.enabled !== false && s.ankiEnabled !== false) refreshAnkiSoon();
}, 1500);

let liveTimer = 0;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!LIVE_KEYS.some(k => k in changes)) return;
  clearTimeout(liveTimer);
  liveTimer = setTimeout(async () => {
    if (!document.getElementById("list")) return;   // a dialog is up
    try { paintLive(await getState()); } catch {}
  }, 150);
});

// A beat of its own, once a second, for the one figure that moves while storage stands still: how
// long this pause has been running.
//
// The storage listener above cannot carry it. ankiStoppedAt is written once when the count stops and
// then deliberately left alone, so repainting only on change would show a single frozen number for
// the whole stretch — "Paused for 5s" an hour into an empty room. The 1500ms poll above doesn't
// either: it asks the worker to talk to Anki, and a poll that finds nothing changed writes nothing.
//
// Only while the popup is actually up, which is the whole life of this script: a popup is torn down
// the moment it closes, and the interval goes with it.
setInterval(async () => {
  if (!document.getElementById("list")) return;     // a dialog is up
  try { paintLive(await getState()); } catch {}
}, 1000);

// ---------------- the finish line ----------------
function partyConfetti(count) {
  const colors = ["#f97316", "#eab308", "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#06b6d4"];
  const box = document.createElement("div");
  box.className = "fgparty";
  for (let i = 0; i < count; i++) {
    const p = document.createElement("i");
    p.style.left = (Math.random() * 100) + "%";
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = (Math.random() * 0.5).toFixed(2) + "s";
    p.style.animationDuration = (2 + Math.random() * 1.8).toFixed(2) + "s";
    p.style.setProperty("--rot", Math.floor(Math.random() * 720 - 360) + "deg");
    box.appendChild(p);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 5200);
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
      <h2>${esc(p.title || "Anki done for today! 🏆")}</h2>
      <p>${esc(p.subtitle || "Today's Anki goal is finished.")}</p>
      ${p.xp ? `<div class="fgxp">+${p.xp} XP</div>` : ""}
      <button class="btn primary" id="fgwinClose">Nice 🎉</button>
    </div>`;
  document.body.appendChild(back);
  // The auto-close is cancelled when you close it yourself, not left to check a flag.
  //
  // `close` captures THIS dialog. Dismiss it, finish again inside the remaining ten
  // seconds, and the first timer fired against a second dialog: partyUp was true again,
  // so it removed the already-detached first node, cleared the flag, and left the
  // dialog actually on screen with no auto-close and the guard reporting no party up.
  let autoClose = 0;
  const close = () => {
    if (autoClose) { clearTimeout(autoClose); autoClose = 0; }
    partyUp = false;
    back.remove();
    renderDashboard();
  };
  back.querySelector("#fgwinClose").addEventListener("click", close);
  requestAnimationFrame(() => back.classList.add("show"));
  partyConfetti(90);
  autoClose = setTimeout(close, 10000);
}
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "celebrateAll") celebrateAllDone(msg.payload);
});

// The popup is only ever a read-out, so it never asks for a password to open.
renderDashboard();
