// AnkiGate Anki Study tab.
// Runs local webcam face detection (pico.js) and reports face presence to the
// background, which only credits Anki study time while a live face is seen and
// the user is actively grading cards. Also displays live Anki progress.
(function () {
  const v = document.getElementById("v");
  const camwrap = document.getElementById("camwrap");
  const camstatus = document.getElementById("camstatus");
  const $ = (id) => document.getElementById(id);

  // ---------------- getting the picture up quickly ----------------
  // Opening a webcam is, by a wide margin, the slowest thing this page does: the driver
  // has to wake the device, agree a mode and deliver a first frame, which is hundreds of
  // milliseconds of hardware nobody can argue with. Until it lands, the window shows a
  // black rectangle.
  //
  // What CAN be argued with is everything that used to happen before we even asked. The
  // request was the last statement in this file — after the theme, the settings reads, a
  // page of listener wiring and every DOM lookup — so the black rectangle also covered all
  // of that. So it is asked for here, first, and picked up by startCameraOnce below when
  // it gets there. Nothing above needs the camera and the camera needs nothing from above.
  //
  // 320x240 because that is what the detector reads. A bigger frame is a bigger buffer to
  // scan for no more accuracy.
  const CAM_WANT = { video: { width: 320, height: 240, facingMode: "user" }, audio: false };

  // Which window this is, read before anything else happens.
  //
  //   ?mini=1        the small always-on-top window the extension opens over Anki
  //   &cam=0         that window with no camera in it: the clock, and nothing else
  //
  // It has to come from the URL rather than from storage, and this is why: the camera request
  // below is deliberately the first statement in the file, and storage cannot be read
  // synchronously. Asking the device and then discovering we did not want it would light the
  // webcam up for a moment on a setup that has the camera switched off — which is the one thing
  // that must never happen. The worker knows the answer when it opens the window, so it says so
  // in the address.
  const Q = new URLSearchParams(location.search);
  const MINI = Q.get("mini") === "1";
  // Only ever the little window. The full tab is where the camera is set up and aimed, so it
  // always asks.
  const TIMER_ONLY = MINI && Q.get("cam") === "0";

  let earlyCam = null;
  if (!TIMER_ONLY) {
    try {
      earlyCam = navigator.mediaDevices.getUserMedia(CAM_WANT);
      // Parked, not swallowed. Nothing is awaiting it yet, and a refused permission with no
      // handler attached is an unhandled rejection in the console. `earlyCam` itself still
      // rejects, so whoever awaits it still gets to say "allow camera".
      earlyCam.catch(() => {});
    } catch (e) { earlyCam = null; }
  }

  // The face model, loaded alongside the camera instead of after it. It is 234KB on disk
  // and has to be unpacked before the first look can happen, and it used to sit squarely in
  // the critical path — read off disk only once frames were already arriving. It depends on
  // nothing the camera produces, so there was never a reason for it to wait.
  // Not fetched at all in the timer-only window: 234KB read off disk and unpacked to look for
  // faces in a window that has no camera in it.
  const cascadeReady = TIMER_ONLY ? Promise.resolve(null) : (async () => {
    if (typeof pico === "undefined") return null;
    try {
      const resp = await fetch(chrome.runtime.getURL("lib/facefinder"));
      const buf = await resp.arrayBuffer();
      return pico.unpack_cascade(new Int8Array(buf)) || null;
    } catch (e) { return null; }
  })();

  // MINI and TIMER_ONLY are read at the top of this file, before the camera is asked for.
  //
  // The title is how the Anki add-on finds this window to pin it above other apps, so don't
  // change it — and note it is the same in both modes on purpose. A clock that Anki covers up
  // the moment you click into Anki is no clock at all.
  if (MINI) {
    document.documentElement.classList.add("mini");
    if (TIMER_ONLY) document.documentElement.classList.add("timeronly");
    // The add-on inside Anki finds this window by its title in order to pin it above
    // every other application, and the worker's orphan sweep clears up by it. Three
    // places have to agree: CAM_TITLE in background.js and in the add-on.
    document.title = "AnkiGate Cam";
  }

  // Day / night button, top right of the full tab. Not in the little floating
  // window: theme.css keeps that one dark whatever you pick, because a white
  // video chrome hovering over full-screen Anki looks broken.
  const themeSlot = document.getElementById("themeSlot");
  if (themeSlot && !MINI && window.FGTheme) themeSlot.innerHTML = window.FGTheme.buttonHtml();

  // Every other page in this extension had an escape helper; this one didn't, and
  // it builds innerHTML out of two values it does not control: the deck name (from
  // AnkiConnect, i.e. from whatever shared deck you downloaded) and the add-on
  // version string (from whatever is answering on port 8766). A deck called
  // `<img src=https://tracker.example/p>` was enough to get a remote image beacon
  // into an extension page. Inline scripts can't run here — Manifest V3's default
  // policy blocks them — but that is not a reason to interpolate raw text.
  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function fmt(sec) {
    sec = Math.max(0, sec | 0);
    const m = Math.floor(sec / 60), s = sec % 60;
    const h = Math.floor(m / 60);
    if (h) return `${h}h ${m % 60}m`;
    return `${m}m ${String(s).padStart(2, "0")}s`;
  }
  // In the little window the camera bar is a single mark, with the words kept in
  // the tooltip. In the full tab it stays wordy.
  // "idle" is the fourth state and the newest: the camera is on and nothing is being judged, which
  // happens once the day's goal is finished. A dash rather than a tick, because a tick is a verdict
  // and there is no verdict here — see the note in pauseDetection.
  const CAM_MARK = { ok: "✓", bad: "✕", wait: "…", idle: "–" };
  // The camera's own state, kept so the red line can say what's actually wrong
  // instead of a generic "show your face".
  let camReason = "", camCls = "";
  function setCam(text, cls) {
    camReason = text || "";
    camCls = cls || "";
    const glyph = /head/.test(camReason) ? "↔" : (CAM_MARK[cls] || "…");
    camstatus.textContent = MINI ? glyph : text;
    camstatus.title = text;
    camwrap.className = "camwrap " + (cls || "");
  }

  // ---------------- live clock ----------------
  // Anki is polled every couple of seconds, so painting only on those replies made
  // the countdown jump 2 seconds at a time. Keep the last reading plus the moment
  // it arrived, and paint four times a second between polls.
  // `at` is when the credited total last MOVED (the countdown is extrapolated from it), and
  // `seen` is when a reading last arrived at all. Two fields, because they answer two
  // different questions and sharing one got the second one wrong — see paintClock.
  // `buffering` is not a third kind of stop — it sits alongside `reason` rather than inside it,
  // because a stalled video may or may not be stopping the clock and the window has to say something
  // in both cases. When the media gate is on it IS the reason and arrives as one; when the gate is
  // off the clock keeps running and this is the only thing that knows a stall is happening.
  const clock = { spent: 0, req: 0, counting: false, at: Date.now(), seen: Date.now(), reason: "",
                  // `resume` is what auto-resume is doing, in words, straight from the worker. Shown so
                  // that "the video did not come back" is answerable by looking rather than by guessing
                  // — see mediaResumeState in background.js.
                  buffering: false, resume: "",
                  // WHEN the clock stopped, straight from the worker, or 0 while it runs. The page turns
                  // it into "how long" itself, so the figure ticks between polls instead of stepping
                  // once every three seconds. See ankiStoppedAt in background.js.
                  stoppedAt: 0 };
  // If replies stop arriving we must NOT keep counting down — that would show
  // time being earned that the background never credited. Freeze after this long
  // and say so instead.
  const STALE_MS = 6000;
  // What is actually on screen, and it only ever moves one way.
  //
  // The worker credits whole seconds and reports a total that lags real time by up to a
  // poll, while this paints four times a second and fills the gap by extrapolating. So the
  // value arriving from a poll is routinely a fraction BEHIND what has already been drawn,
  // and writing it straight to the screen stepped the countdown BACKWARDS by a second. That
  // is the one thing a clock must never do — it reads as time being taken away from you.
  //
  // Held instead: if the credited total is a little behind the display, the display waits
  // for it rather than rewinding. It catches up within the second, because both advance at
  // the same rate. A real change — starting the day over, winding the bar back, a new goal —
  // moves it by much more than that, so anything past RESYNC_SEC is taken as meant.
  let shownSpent = null;
  const RESYNC_SEC = 2;
  // Whether the face check is on, as far as this window knows. Cached so the instant path
  // below can apply the same "don't show counting while a check is failing" rule as the
  // two-second one, without a storage read per event.
  let faceRequiredNow = false;
  // The last two facts the red line is worked out from, remembered for the same reason.
  let connectedNow = true, reasonNow = "";

  // Why the clock is stopped, in two or three words.
  //
  // A function rather than an expression inside the refresh, because the refresh is not the
  // only thing that learns the answer and it is the slower of the two. The worker writes the
  // reason to storage the instant it decides it — leaving Anki reaches this window in
  // milliseconds — while this page's own poll is two seconds wide. So the number stopped
  // immediately and the words explaining why did not arrive for up to two seconds, during
  // which the window said nothing at all: no line, no red ring, just a clock that had quietly
  // given up. Both paths call this now.
  function shortReason(faceBlock) {
    // Finishing is not a fault, and this function only ever describes faults.
    //
    // Once the goal is met the detector is stopped on purpose (setDoneMode), which sets faceNow
    // false — so the face branch below fired and reported camReason, which at that moment is the
    // word pauseDetection put there: "finished". The window then painted its own success as a
    // problem: the reason band in pink, and the red ring round the whole window that comes with
    // any non-empty reason. Nothing was wrong; the day was done.
    //
    // It went unnoticed while the green "Done!" panel was underneath it saying the opposite. With
    // that panel gone from this window, this line IS the message, so it has to be right.
    //
    // Declared far below this function and read at call time, which is safe: nothing calls this
    // before the module has finished evaluating — paintClock's interval cannot fire until then.
    if (doneMode) return "";
    return !connectedNow ? "open Anki"
      : reasonNow === "no_bridge" ? "install add-on"
      : reasonNow === "not_foreground" ? "switch to Anki"
      : reasonNow === "not_fullwindow" ? "full screen Anki"
      // The camera knows exactly why it isn't happy — say that, not "show your face".
      : (faceBlock || reasonNow === "no_face") ? (camReason || "show your face")
      : reasonNow === "still" ? "move the mouse"
      : reasonNow === "no_reviewer" ? "open a card"
      : reasonNow === "media_paused" ? "press play"
      : reasonNow === "media_buffering" ? "video loading"
      : reasonNow === "wrong_deck" ? "wrong deck"
      : reasonNow === "same_card" ? "answer the card"
      : reasonNow === "spam" ? "too fast"
      : reasonNow === "idle" ? "answer a card"
      : "paused";
  }
  // Seeded from storage, so the storage path is never the first to arrive with nothing to go
  // on. Without it, an event landing in the moment before the first refresh answers would
  // fall through to the bare "paused" — which is the one wording here that says nothing.
  try {
    chrome.storage.local.get(["ankiReason", "ankiConnected", "ankiMediaWaiting", "ankiResumeState",
                             "ankiStoppedAt"], (r) => {
      if (!r) return;
      if (typeof r.ankiReason === "string") reasonNow = r.ankiReason;
      if (typeof r.ankiResumeState === "string") clock.resume = r.ankiResumeState;
      if (r.ankiStoppedAt !== undefined) clock.stoppedAt = Number(r.ankiStoppedAt) || 0;
      if (r.ankiConnected !== undefined) connectedNow = r.ankiConnected !== false;
      // Seeded too, so a window opened DURING a stall says so on its first paint rather than looking
      // fine until the next poll contradicts it.
      if (r.ankiMediaWaiting !== undefined) clock.buffering = r.ankiMediaWaiting === true;
    });
  } catch (e) {}

  // One way in for a new reading of the clock, used by both paths that get one: the
  // two-second refresh, and the storage event the worker's own write raises.
  //
  // `at` is "when this credited total was measured", and the paint adds the time since. So
  // it only moves when the total itself moves, or when counting starts or stops. It used to
  // be set to now on every reading, including the ones that said the same number as
  // before — and most of them do, because the worker credits whole seconds a poll at a
  // time. Each of those threw away the fraction accrued since the last one, so the display
  // stalled between credits and then jumped to catch up.
  function setClockFrom(spent, req, counting) {
    const nextReq = Math.max(0, Number(req) || 0);
    const nextSpent = Math.min(nextReq, Math.max(0, Number(spent) || 0));
    if (nextSpent !== clock.spent || !!counting !== clock.counting) clock.at = Date.now();
    clock.seen = Date.now();
    clock.spent = nextSpent;
    clock.req = nextReq;
    clock.counting = !!counting;
    paintClock();
  }
  function paintClock() {
    const age = Date.now() - clock.at;
    // "Have the replies stopped?", measured from the last reading — NOT from the last time the
    // number in it changed. Those are the same thing while the clock is running, and opposites
    // the moment it stops: a stopped clock reports the same total for as long as it is stopped,
    // so six seconds after you switched out of Anki this decided the worker had gone quiet and
    // covered the reason with "reconnecting". The reason was already worked out and correct —
    // "switch to Anki" — and it was replaced by a line that was both wrong and useless, on
    // every stop, every time, for as long as the stop lasted.
    const stale = (Date.now() - clock.seen) >= STALE_MS;
    const extra = clock.counting ? Math.min(age, STALE_MS) / 1000 : 0;
    const target = Math.min(clock.req, clock.spent + extra);
    if (shownSpent === null || target > shownSpent || (shownSpent - target) > RESYNC_SEC) {
      shownSpent = target;
    }
    const spent = Math.min(clock.req, shownSpent);
    const remaining = Math.max(0, clock.req - spent);
    const pct = clock.req ? Math.min(100, 100 * spent / clock.req) : 0;
    const a = $("spent"), b = $("required"), bar = $("bar");
    if (a) a.textContent = MINI ? fmtClock(remaining) : fmt(spent);
    if (b) b.textContent = MINI ? fmtClock(clock.req) : fmt(clock.req);
    if (bar) bar.style.width = pct.toFixed(1) + "%";

    // Red, unmissable, and short: the reason the clock isn't moving.
    const running = clock.counting && !stale;
    const warn = stale ? "reconnecting" : (running ? "" : clock.reason);
    // And a stalled video, which is worth saying even when it is stopping nothing.
    //
    // That is the ordinary case rather than the odd one. The media gate ships OFF, so on a default
    // profile a buffering video costs you no time — and until this line existed it also said nothing,
    // because the message only ever existed as a reason the clock had STOPPED. With the gate off the
    // clock had not stopped, so there was no reason, so there was no message. "Why does it never say
    // buffering" had that one answer.
    //
    // Second to `warn`, never instead of it: if something is actually holding the clock up, that is
    // the more important sentence and a notice must not push it off the only line this window has.
    const loading = !warn && running && !!clock.buffering;
    // And what auto-resume is doing, when it has something to do and nothing more important is being
    // said. Shown because this feature failed four times running and every failure looked the same from
    // here — "I came back and the video did not start" is the symptom of a dozen causes, so it has to
    // be able to name its own. "sent" or "stuck" with a video still paused means the extension did its
    // part and the add-on found nothing to play; anything else names the condition holding it.
    const resume = (!warn && !loading && clock.resume) ? ("resume: " + clock.resume.replace(/^wait:/, "")) : "";
    // How long it has been stopped, appended to whatever the reason is.
    //
    // The reason on its own says what is wrong and nothing about how bad it has got: "switch to Anki"
    // reads identically whether you glanced away four seconds ago or left the desk twenty minutes ago,
    // and the second one is the fact worth having. Computed here from the worker's stamp rather than sent
    // as a number, so it ticks every paint instead of stepping once per poll.
    //
    // Only past a few seconds. Every ordinary pause — clicking into another window and back, a blink the
    // detector missed — would otherwise put a stopwatch on screen for the moment it takes to correct
    // itself, and a counter that appears and vanishes constantly is noise rather than information.
    const stoppedFor = (warn && clock.stoppedAt > 0)
      ? Math.floor((Date.now() - clock.stoppedAt) / 1000)
      : 0;
    const warnLine = (warn && stoppedFor >= 5) ? (warn + " · " + fmtClock(stoppedFor)) : warn;
    const line = warnLine || (loading ? "video loading" : resume);
    if (MINI) {
      const st = $("state");
      // In the timer-only window this line keeps its place whether it has anything to say or
      // not. That window is three lines tall and the height is fitted to its contents, so a line
      // that comes and goes resizes the whole window every time you click into Anki and back.
      // In the camera window it is absolutely positioned and out of the flow, so hiding it costs
      // nothing and a permanent empty band under the clock would be the worse trade.
      if (st) { st.textContent = line; st.style.display = (line || TIMER_ONLY) ? "block" : "none"; }
      // `warn`, not `line`. A notice is not a stop: the red ring and the red clock are how this window
      // says the clock has stopped, and raising them over a clock that is still counting would turn a
      // piece of information into an apparent fault.
      document.documentElement.classList.toggle("paused", !!warn);
      // Amber, not red, whenever the clock has stopped but there is nothing broken and nothing being
      // asked of you: the camera waiting on you (move for the liveness check, allow the camera, still
      // starting up), and a stalled video.
      //
      // The video half is new and it settles an inconsistency rather than adding a preference. The
      // full study tab has always drawn this fact with an amber dot, and the note beside it says why —
      // the clock has stopped but there is nothing for you to put right. This window was painting the
      // same fact red, which reads as "you have done something wrong" at a spinner.
      document.documentElement.classList.toggle("nudge",
        !!warn && (camCls === "wait" || reasonNow === "media_buffering"));
      // And the still-counting stall gets a state of its own: the caption in amber, no ring, and the
      // clock left exactly as it was. Its own class because it must not borrow `nudge`, which recolours
      // the clock — and a clock that is running should never be wearing the colour of one that is not.
      document.documentElement.classList.toggle("loading", loading);
    }
  }
  function fmtClock(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600);
    const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
    const ss = String(sec % 60).padStart(2, "0");
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }
  setInterval(paintClock, 250);

  // ---------------- face detection ----------------
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let ready = false, detecting = false, classify = null, updateMemory = null;
  let faceNow = false; // latest detection result

  // passedAt is persisted, not just held here. It used to start at "now" in every
  // new document, and the little camera window is created and destroyed every time
  // you switch away from Anki and back — so closing and reopening it every couple
  // of minutes restarted the countdown each time and the head-movement check never
  // fired at all. That is the one check a photo held up to the camera cannot pass,
  // so losing it quietly mattered.
  // The movement check, as an idle timeout rather than a quiz.
  //
  // It used to work in rounds: wait N seconds, then demand a movement and park the clock
  // until it got one. So it interrupted you on a schedule whether or not you had been
  // moving the whole time, which is backwards — someone fidgeting normally was being asked
  // to prove something they had just spent three minutes proving.
  //
  // Now the deadline simply slides forward every time you move. Move at any point and you
  // have another N seconds; go the full N seconds without moving and the clock waits until
  // you do. Set to 5s: move at 3s and the next deadline is 8s; move again at 7s and it's
  // 12s. A photograph never moves, so it hits the deadline once and stays there, which is
  // the whole point of the check.
  // Watcher-shaped on purpose — intervalMs / lastAt / idleSince — so the movement check runs on
  // the same makeWatch helpers as the eye and blink checks instead of keeping its own copy of
  // the rule. The extra fields below are only the movement measurement itself.
  let liveness = { enabled: true, intervalMs: 10000, lastAt: Date.now(), seeded: false,
                   needFrac: 0.042, idleSince: 0, moved: 0, lastNoteAt: 0,
                   minCol: 0, maxCol: 0, minRow: 0, maxRow: 0, minSize: 0, maxSize: 0,
                   lastCol: 0, lastRow: 0, lastSize: 0 };
  // Sliding the deadline is watchBeat, the same call the eye and blink checks make. Nothing
  // is written to storage: the stamp used to be persisted so a reopened window could carry on
  // an old countdown, which is the behaviour removed above.
  //
  // How much movement counts as movement, by the sensitivity dial. 1 wants a real shift in
  // your seat, 5 takes almost anything.
  //
  // The check used to demand a lean one way and then the other, which was the worst thing
  // in the extension to be on the receiving end of: it said "lean head ← then →", you
  // leaned, nothing happened, and the clock stayed parked. Two reasons it couldn't be
  // satisfied — turning your head far enough to move your face across the frame usually
  // stops it being detected as a face at all, so the act of obeying broke the measurement;
  // and needing both directions meant one missed frame at either extreme started you over.
  const MOVE_BY_SENS = { 1: 0.075, 2: 0.056, 3: 0.042, 4: 0.030, 5: 0.020 };
  function moveFracFor(sens) {
    const n = Math.max(1, Math.min(5, parseInt(sens, 10) || 3));
    return MOVE_BY_SENS[n];
  }
  // However much the bar eases, it stops here — about five pixels on a 320-wide frame.
  //
  // Easing without a floor is how a photograph got through: slide the dial to its most
  // forgiving, wait twenty seconds, and the bar came down to roughly two pixels, which the
  // detector's own wobble covers on its own. Nothing below this floor can distinguish a person
  // from a still image, so there is no honest reason to go there.
  const MOVE_NEED_FLOOR = 0.016;
  function moveNeeded() {
    // Easier the longer you have been waiting, so a badly aimed camera or an unusually
    // still sitter can always get out of it. The dial sets the starting point; this only
    // ever lowers it, and never past the floor above.
    const waiting = liveness.idleSince ? Date.now() - liveness.idleSince : 0;
    const ease = waiting > 20000 ? 0.45 : waiting > 8000 ? 0.7 : 1;
    return Math.max(MOVE_NEED_FLOOR, liveness.needFrac * ease);
  }
  // Anything smaller than this, frame to frame, is the detector's own wobble rather than
  // you. Pico reports a box on a coarse grid — its search step is a tenth of the window
  // size it's testing — so a genuinely still face gives the same numbers over and over and
  // scores zero here, while a person who is merely sitting quietly crosses grid steps all
  // the time. That difference is the whole basis of the check.
  const MOVE_JITTER = 0.004;
  // Travelled distance fades, halving every second and a half.
  //
  // Without this it was a total that only ever grew, and given long enough ANY trickle
  // reaches the bar: a photograph sitting perfectly still still produces the odd frame where
  // the detector's box lands a pixel out, and over two minutes those crumbs added up to a
  // pass. Fading answers the question that actually matters — "have you moved recently" —
  // instead of "have you ever moved". Noise settles at a tiny steady value and stays there;
  // a person's movement outruns the fade in a fraction of a second.
  const MOVE_HALF_LIFE = 1.5;
  // Start measuring afresh from where the face is now.
  function seedMovement(col, row, size) {
    liveness.seeded = true;
    liveness.minCol = liveness.maxCol = liveness.lastCol = col;
    liveness.minRow = liveness.maxRow = liveness.lastRow = row;
    liveness.minSize = liveness.maxSize = liveness.lastSize = size;
    liveness.moved = 0;
    liveness.lastNoteAt = 0;
  }
  function noteMovement(col, row, size, w, h, now) {
    liveness.minCol = Math.min(liveness.minCol, col);
    liveness.maxCol = Math.max(liveness.maxCol, col);
    liveness.minRow = Math.min(liveness.minRow, row);
    liveness.maxRow = Math.max(liveness.maxRow, row);
    liveness.minSize = Math.min(liveness.minSize, size);
    liveness.maxSize = Math.max(liveness.maxSize, size);
    // How far the face has travelled in total, added up frame by frame.
    //
    // This is the part that was missing, and it is why the clock kept stopping on someone
    // who was plainly there. The only test was how far the face had got from where it
    // started — so reading a card, where your head drifts a few pixels one way and back
    // again, never reached the bar no matter how long you did it for. Distance from a
    // starting point stays near zero; distance TRAVELLED does not.
    const dt = liveness.lastNoteAt ? Math.max(0, (now - liveness.lastNoteAt) / 1000) : 0;
    liveness.lastNoteAt = now;
    if (dt > 0) liveness.moved *= Math.pow(0.5, dt / MOVE_HALF_LIFE);
    const dx = (col - liveness.lastCol) / Math.max(1, w);
    const dy = (row - liveness.lastRow) / Math.max(1, h);
    const dz = (size - liveness.lastSize) / Math.max(1, liveness.lastSize);
    const step = Math.hypot(dx, dy) + Math.abs(dz) / 2.5;
    if (step > MOVE_JITTER) liveness.moved += step;
    liveness.lastCol = col;
    liveness.lastRow = row;
    liveness.lastSize = size;
  }
  // The biggest movement seen since the challenge began — sideways, up and down, or
  // towards and away from the camera, whichever is largest.
  //
  // Ranges rather than distance from a starting point, because the starting point can
  // itself be caught mid-movement: leaning back to a rest position then counted as no
  // movement at all. Any wobble in any direction accumulates into this.
  //
  // Sideways and vertical are combined as a diagonal rather than taken one at a time: a
  // slouch that moves you ten pixels across and ten down is plainly movement, and judging
  // the axes separately rejected it for being short on both.
  //
  // Size is divided down because moving closer or further changes it proportionally much
  // faster than a shift across the frame — without that, breathing would pass the check.
  // Travelled distance is only believed if the face has also actually gone somewhere — this
  // much of the dial's own setting, before any easing.
  //
  // Sensor noise on a photograph racks up travel without ever leaving the spot: the box
  // jitters a fraction of a pixel each way and the total creeps up, and because the bar eases
  // down the longer you wait, given a minute or two the two met in the middle and a
  // photograph passed. Noise cancels out over distance; a person who has been moving has
  // both a total AND somewhere they got to.
  // There is also a floor under it that the dial cannot lower. At the forgiving end the
  // proportional gate shrinks to about two pixels, which is inside the noise — so sliding the
  // dial right handed a photograph a pass. This floor is roughly six pixels on a 320-wide
  // frame: nothing for a person, out of reach for a still image.
  const MOVE_RANGE_SHARE = 0.35;
  const MOVE_RANGE_FLOOR = 0.018;
  function movedBy(w, h) {
    const dx = (liveness.maxCol - liveness.minCol) / Math.max(1, w);
    const dy = (liveness.maxRow - liveness.minRow) / Math.max(1, h);
    const dz = (liveness.maxSize - liveness.minSize) / Math.max(1, liveness.minSize);
    const range = Math.max(Math.hypot(dx, dy), dz / 2.5);
    const gate = Math.max(MOVE_RANGE_FLOOR, liveness.needFrac * MOVE_RANGE_SHARE);
    const travelled = range >= gate ? liveness.moved : 0;
    // Whichever says most: one clear shift of position or distance from the camera, or a lot
    // of small movement added up while genuinely wandering. Either is a person.
    return Math.max(range, travelled);
  }

  // How hard to look for a face: 1 = strict, 5 = forgiving. Set by the Face
  // sensitivity dial in Settings and picked up live through storage.onChanged.
  const QUAL_BY_SENS = { 1: 72, 2: 60, 3: 50, 4: 38, 5: 26 };
  let sensitivity = 3;
  function qualBar() { return QUAL_BY_SENS[sensitivity] || QUAL_BY_SENS[3]; }
  // How many frames of detections pico's memory folds together. The bar above is calibrated
  // against this sum — cluster_detections adds the scores of every overlapping window it merges
  // — so this number cannot be changed on its own without making every sensitivity setting mean
  // something different.
  //
  // It lives up here, beside the bar rather than beside the detection loop that uses it, because
  // it is half of a calibration pair and the two kept being read separately. Two constants
  // further down are shares of it and would sit in its temporal dead zone anywhere lower:
  // RAW_SEEN_SHARE and TILT_BAR_SHARE. The second of those was a bare 0.7 for exactly as long as
  // this number was out of sight of it.
  const MEM_FRAMES = 5;

  // What counts as "you are still here" when the cascade can't find a face — and it often
  // can't, for reasons that have nothing to do with you leaving. pico was trained on
  // upright, forward-facing faces. Lean towards a shoulder and the score collapses while
  // you still look perfectly normal to a person. Bend over a notebook and there is no face
  // in the picture at all, only a scalp. Both used to stop the clock.
  //
  // So the dial is a ladder of evidence, each rung accepting one weaker kind:
  //
  //   1 strict  upright and facing the camera. Nothing else. As it always was.
  //   2 firm    a tilted head counts.
  //   3 normal  and a head down over the desk, as long as the picture keeps changing.
  //   4 kind    and simply being in the chair, however you're sitting, even dead still.
  //   5 easy    the same, with far more patience before it decides the room is empty.
  //
  //   rolls  — extra angles to re-check the frame at, in degrees, tried both ways.
  //            Empty means the upright pass is the whole story.
  //   down   — with no face findable at any angle, how long the picture may go unchanged
  //            before we accept you have gone. This is the head-down rung: writing at the
  //            desk keeps the frame moving, an empty chair does not. 0 turns it off.
  //   anchor — the ceiling on ALL of the faceless rungs, measured from the last face actually
  //            seen at any angle. It is the longest the clock will run on a guess before it
  //            wants to see you again, and one glance at the screen resets it. Never 0 now:
  //            an unbounded rung is how an empty chair gets credited with an evening of study.
  //   body   — for the rung that needs no movement at all: how long a completely
  //            frozen picture is tolerated when we can't tell whether the chair is full.
  //            When the empty-room reference below IS available it decides instead, and
  //            this number stops mattering. 0 turns the rung off.
  //
  // The anchors used to be 10 minutes at normal and nothing at all at kind and easy. Both were
  // wrong in the same direction, and the second was only survivable while something else was
  // expected to overrule it — the empty-room comparison, which turned out never to be learned
  // because of the lastFaceAt bug further down this file.
  //
  // They are a BACKSTOP now, not the main defence. Walking away is caught within a frame or two
  // by gone() further down, which compares the picture against the last frame your face was in;
  // these numbers only matter when that test has nothing to say — no face has been seen yet this
  // session, or you sit far enough from the camera that leaving barely changes the picture. So
  // they are sized as "how long may I go without showing my face at all", and they are short,
  // because a glance at the screen costs nothing and starts them over.
  // Each roll is tried both ways, so a list ending at 60 reaches about 75 degrees of tilt once
  // the cascade's own tolerance of roughly 15 either side of upright is counted. That stopped
  // short of a head laid right over on a shoulder, which is a thing people do while reading, so
  // the top two settings go to 75 and reach a fully sideways head.
  const LOOSE_BY_SENS = {
    1: { rolls: [],                    down: 0,      anchor: 0,      body: 0      },  // strict
    2: { rolls: [15, 30],              down: 0,      anchor: 0,      body: 0      },  // firm
    3: { rolls: [15, 30, 45],          down: 20000,  anchor: 60000,  body: 0      },  // normal
    4: { rolls: [15, 30, 45, 60, 75],  down: 60000,  anchor: 150000, body: 120000 },  // kind
    5: { rolls: [15, 30, 45, 60, 75],  down: 300000, anchor: 420000, body: 900000 }   // easy
  };
  function looseCfg() { return LOOSE_BY_SENS[sensitivity] || LOOSE_BY_SENS[3]; }

  // Strict eye check: not just a face in frame, but eyes open and on the screen.
  // One slider moves these numbers: how open an eye must read, and how far a pupil may
  // drift before it counts as looking away.
  // wide/flat describe the shape that means "eyelid shut": the dark thing in the
  // socket stretches right across it but is only a thin line. A pupil is a compact
  // blob instead. Stricter settings call a shut eye shut sooner.
  //
  // Each row used to carry a `grace` as well — how long a glance away was forgiven. That is a
  // setting of its own now (eyeAwaySec), on the same sliding deadline as the movement and blink
  // checks, so the dial no longer decides it and the numbers are gone rather than left lying
  // here implying they still mean something.
  const EYE_BY_SENS = {
    1: { open: 0.42, off: 0.42, wide: 0.55, flat: 0.55 },  // strict
    2: { open: 0.38, off: 0.52, wide: 0.62, flat: 0.50 },
    3: { open: 0.34, off: 0.62, wide: 0.70, flat: 0.45 },  // normal
    4: { open: 0.29, off: 0.72, wide: 0.78, flat: 0.38 },
    5: { open: 0.24, off: 0.82, wide: 0.88, flat: 0.30 }   // easy
  };
  let eyeRequired = false, eyeSens = 3;
  function eyeCfg() { return EYE_BY_SENS[eyeSens] || EYE_BY_SENS[3]; }

  // ---------------- the sliding-deadline checks ----------------
  // Three of them — head movement, eyes on the screen, and blinking — and they all work the
  // same way, so they share one small machine rather than each growing its own rule.
  //
  // Do the thing at any point and you have the whole interval again. Go the entire interval
  // without doing it and the clock waits until you do. Nothing is ever asked of you on a
  // schedule: these only ever notice an absence.
  //
  //   interval 10s, blink at 4s  → next deadline 14s
  //   blink again at 12s         → next deadline 22s
  //   nothing by 22s             → clock waits, and resumes the moment you blink
  function makeWatch(seconds) {
    return { on: false, intervalMs: Math.max(0, seconds) * 1000, lastAt: Date.now(), idleSince: 0 };
  }
  // The thing happened: deadline slides forward from here.
  function watchBeat(w, now) { w.lastAt = now; w.idleSince = 0; }
  // A full interval with nothing. The stamp is taken once, so anything that eases off with
  // waiting measures from when the waiting began rather than from every frame of it.
  function watchOverdue(w, now) {
    if (now - w.lastAt <= w.intervalMs) return false;
    if (!w.idleSince) w.idleSince = now;
    return true;
  }
  function watchSeconds(w, seconds) {
    w.intervalMs = Math.max(0, Number(seconds) || 0) * 1000;
  }
  // Switched on, or the face came back after being lost: a full interval in hand, never a
  // debt inherited from before.
  function watchFresh(w) { w.lastAt = Date.now(); w.idleSince = 0; }

  const eyeWatch = makeWatch(10);
  const blinkWatch = makeWatch(10);

  // ---------------- blinks ----------------
  // A blink is eyes closing and opening again. Closing alone is not enough — that is also what
  // falling asleep looks like, and a photograph of someone mid-blink would pass for ever — so
  // it only counts once they open again, and only if the closure was short enough to have been
  // a blink rather than a rest.
  //
  // This is the strongest liveness signal the camera has. A photo cannot blink at all, a video
  // loop blinks on a schedule, and head movement can be faked by nudging a photo; nothing
  // short of a real face does this on demand.
  // Its own dial, and its own idea of "closed".
  //
  // It first borrowed the eye check's threshold and missed most blinks. Two reasons. That
  // threshold answers "are you attentively looking at the screen", which a half-closed eyelid
  // mid-blink can still satisfy — and it is an absolute number, when pupil contrast depends
  // entirely on your face, your glasses and the lamp behind you. The value that catches a blink
  // on one setup never fires on another.
  //
  // So closure is measured as a DIP from your own open-eye reading, learned as you sit there.
  // `dip` is how much of a drop counts: 1 wants an unmistakable blink, 5 takes a flicker.
  // The window widens with it too, because a slower sampling rate sees a blink as one long
  // frame rather than several short ones.
  const BLINK_BY_SENS = {
    1: { dip: 0.55, minMs: 60, maxMs: 500 },   // clear
    2: { dip: 0.45, minMs: 50, maxMs: 600 },
    3: { dip: 0.35, minMs: 40, maxMs: 700 },   // normal
    4: { dip: 0.27, minMs: 20, maxMs: 900 },
    5: { dip: 0.20, minMs: 0, maxMs: 1200 }    // faint
  };
  let blinkRequired = false, blinkSens = 3, eyeWasOpen = true, eyeClosedAt = 0;
  // What your eyes look like open, in this light. Learned rather than assumed.
  let blinkBase = 0;
  function blinkCfg() { return BLINK_BY_SENS[blinkSens] || BLINK_BY_SENS[3]; }
  function noteBlink(read, now) {
    const cfg = blinkCfg();
    const score = Math.max(0, read.score || 0);
    // No usable reading — the eye patches fell outside the frame, or the face is too small to
    // find them in. analyseEyes reports that as a score of 0, which is indistinguishable from
    // pitch black, so it must not be read as a closure: a run of unreadable frames followed by
    // a good one would otherwise look exactly like a blink and hand out a free pass.
    if (score <= 0) return;
    if (blinkBase <= 0) blinkBase = score;
    // Shape as well as contrast: two flat lash lines are a closed pair of eyes whatever the
    // numbers say.
    const closed = read.lidShut === true || score <= blinkBase * (1 - cfg.dip);

    // eyeClosedAt doubles as "a blink might be happening": set while a closure could still
    // turn out to be one, cleared the moment it can't.
    if (closed) {
      if (eyeWasOpen) {
        eyeClosedAt = now;
      } else if (eyeClosedAt && now - eyeClosedAt > cfg.maxMs) {
        // Shut for longer than a blink lasts, so it isn't one. Two things look like this: eyes
        // resting, and the light changing — someone turns a lamp off and every reading drops
        // below a baseline learned in a brighter room. Give up on it as a blink either way, and
        // let the baseline learn its way to whatever this is now, because otherwise the reading
        // stays "closed" for ever and the check stalls with no way back.
        eyeClosedAt = 0;
      }
    } else {
      // A blink is closing AND opening again, soon enough to have been a blink. Eyes closed and
      // left closed is what falling asleep looks like, and a photograph caught mid-blink would
      // otherwise pass for ever.
      if (!eyeWasOpen && eyeClosedAt) {
        const shut = now - eyeClosedAt;
        if (shut >= cfg.minMs && shut <= cfg.maxMs) watchBeat(blinkWatch, now);
      }
      eyeClosedAt = 0;
    }
    // Teach the baseline slowly, and never from a frame that might be part of a blink —
    // otherwise a blink drags the baseline down to meet itself and the next one has nothing to
    // dip below. Frames whose closure has been given up on above do teach it, which is what
    // lets a darkened room be relearned. Coming back out of that costs nothing and grants
    // nothing: the eyes reopening is a rise, not a dip, so no blink is credited for it.
    if (!eyeClosedAt) blinkBase = blinkBase * 0.97 + score * 0.03;
    eyeWasOpen = !closed;
  }

  // ---------------- beeps ----------------
  // Low double beep when the camera loses you, brighter one when it finds you, so
  // you don't have to watch the window to know the clock stopped.
  let soundOn = true, audioCtx = null, prevSeen = null;
  // One stamp per direction, not one shared by both.
  //
  // This was a single `lastBeepAt` and a 600ms window, and the window was spent by whichever beep
  // came first — so the "found you" beep was swallowed by the "lost you" beep that had just played.
  // Which is every time you come back within 600ms of leaving, i.e. every time you lean out of shot
  // and straight back in. Reported as "the off sound plays but the on sound never does", and that is
  // exactly what it was: a guard against one sound repeating, silencing the other sound entirely.
  //
  // Kept per direction because the two are different events. Two of the same in quick succession is
  // flicker worth damping; one of each is a real thing happening and both halves have to be audible,
  // or the pair stops being a pair and starts being a warning with no all-clear.
  //
  // Shorter than it was, too. 600ms was sized to swallow a blink, but a blink cannot reach here in
  // the first place — the detector needs two consecutive empty frames before it will say you are
  // gone (RAW_MISS_LIMIT). This only has to stop the same sound stuttering.
  const BEEP_GAP_MS = 400;
  const lastBeepAt = { found: 0, lost: 0 };
  function beep(found) {
    if (!soundOn) return;
    const key = found ? "found" : "lost";
    const now = Date.now();
    if (now - lastBeepAt[key] < BEEP_GAP_MS) return;
    lastBeepAt[key] = now;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = audioCtx || new AC();
      const notes = found ? [[988, 0, 0.13], [1319, 0.1, 0.16]]   // up: found you
                          : [[520, 0, 0.13], [392, 0.13, 0.18]];  // down: lost you
      // Scheduled AFTER the resume has actually happened, not before it.
      //
      // resume() is asynchronous. The old code fired it and read currentTime on the next line — a
      // clock that has not started yet and reads 0 — so every note was scheduled in the past by the
      // time the context woke up, and a note whose whole envelope is in the past is a note you never
      // hear. A suspended context is the normal state for a page that has had no click in it, which
      // this window often has not.
      if (audioCtx.state === "suspended") audioCtx.resume().then(() => play(notes), () => {});
      else play(notes);
    } catch (e) {}
  }
  function play(notes) {
    if (!audioCtx) return;
    // A hair in the future, not exactly now. Scheduling on the sample the context is playing this
    // instant clips the attack, which on a 12ms ramp is most of it — the beep arrives as a click or
    // not at all. Ten milliseconds is inaudible as a delay and is the difference between "instant"
    // and "sometimes silent".
    const t0 = audioCtx.currentTime + 0.01;
    for (const [freq, at, len] of notes) {
      const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t0 + at);
      gain.gain.linearRampToValueAtTime(0.2, t0 + at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + at + len);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + len + 0.02);
    }
  }
  // Woken by the first press anywhere in this window, so the first beep is not the one that has to
  // start the clock.
  //
  // A browser leaves an AudioContext suspended until the page has been interacted with, and this
  // window can go a long time without being touched — you are supposed to be looking at Anki. The
  // resume inside beep() covers that case, but it costs the first beep its timing: waking the
  // context takes a few tens of milliseconds and the sound lands late. Doing it here means the very
  // first press — the menu, pause, anything — has the audio ready, and every beep after that is
  // immediate.
  //
  // Not `once`: a resume can be refused, and the next press is another chance. On an already-running
  // context both calls are no-ops, so nothing is spent on repeating it.
  function primeAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = audioCtx || new AC();
      if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    } catch (e) {}
  }
  ["pointerdown", "keydown"].forEach(t => {
    try { document.addEventListener(t, primeAudio, { capture: true, passive: true }); }
    catch (e) { document.addEventListener(t, primeAudio, true); }
  });

  // Called after every detection with the final verdict.
  function noteSeen(seen) {
    if (prevSeen === null) { prevSeen = seen; return; }   // first reading is not a change
    if (seen === prevSeen) return;
    prevSeen = seen;
    beep(seen);
  }
  // The beep switch lives on the camera window itself, next to the markers switch —
  // that's where you are when the beep matters, and it keeps the settings card short.
  const sndBtn = document.getElementById("sndtog");
  function setSoundUI() {
    if (sndBtn) sndBtn.setAttribute("aria-pressed", soundOn ? "true" : "false");
  }
  if (sndBtn) {
    sndBtn.addEventListener("click", () => {
      soundOn = !soundOn;
      setSoundUI();
      // Written to storage, so the choice survives a reload and the full study tab
      // and the little floating window agree about it.
      try { chrome.storage.local.set({ soundEffectsEnabled: soundOn }); } catch (e) {}
    });
  }
  setSoundUI();

  // The glow on Anki's own window: green sweep when time starts counting, amber edge while it
  // counts at the slow rate because your head is out of the focus box, red edge while
  // something is stopping it. Switched from here because this window is where you find out
  // whether the camera can see you, and the glow is the same news said on Anki instead.
  //
  // Only the extension is told. It stops sending a colour, and the add-on's frame goes out
  // by itself when it stops hearing one — so nothing in Anki needs to know this switch
  // exists.
  const glowBtn = document.getElementById("glowtog");
  let glowOn = true;
  function setGlowUI() {
    if (glowBtn) glowBtn.setAttribute("aria-pressed", glowOn ? "true" : "false");
  }
  if (glowBtn) {
    glowBtn.addEventListener("click", () => {
      glowOn = !glowOn;
      setGlowUI();
      try { chrome.storage.local.set({ ankiGlowEnabled: glowOn }); } catch (e) {}
    });
  }
  setGlowUI();

  // ---------------- pause the card's video when the clock stops ----------------
  // The fourth switch in the folded menu, and it belongs here for the same reason as the other
  // three: this is where you are when it matters. The clock stopping and the video not stopping is
  // something you notice in Anki, not on a settings page you last opened a week ago.
  //
  // Only the switch is here. How far the video is wound back is a number, and a number needs a box
  // and a label, neither of which fits in a row of 20-pixel discs — that stays on the settings page,
  // where this switch also lives.
  const mpBtn = document.getElementById("mptog");
  let mediaPauseOn = true;
  function setMediaPauseUI() {
    if (mpBtn) mpBtn.setAttribute("aria-pressed", mediaPauseOn ? "true" : "false");
  }
  if (mpBtn) {
    mpBtn.addEventListener("click", () => {
      mediaPauseOn = !mediaPauseOn;
      setMediaPauseUI();
      try { chrome.storage.local.set({ ankiMediaPauseEnabled: mediaPauseOn }); } catch (e) {}
    });
  }
  setMediaPauseUI();

  // ---------------- and start it again when the clock does ----------------
  // The other half of the switch above, and it belongs beside it for a reason that is less about
  // this window than about the pair: a menu that offers the stop without the start reads as an
  // oversight rather than a choice. The pause has been switchable from here since it was added and
  // its other half was only ever on the settings page, so the one place you could turn the pausing
  // on was also the one place you could not turn the resuming on with it.
  //
  // No cross-check against mediaPauseOn, deliberately. It does nothing while the pause is off — the
  // worker's own guard sees to that, and the settings page says the same thing by nesting one row
  // inside the other — but expressing that here would mean a third colour state in a row of six
  // 20-pixel discs, to describe a switch that is merely inert rather than wrong.
  const mrBtn = document.getElementById("mrtog");
  let mediaResumeOn = true;
  function setMediaResumeUI() {
    if (mrBtn) mrBtn.setAttribute("aria-pressed", mediaResumeOn ? "true" : "false");
  }
  if (mrBtn) {
    mrBtn.addEventListener("click", () => {
      mediaResumeOn = !mediaResumeOn;
      setMediaResumeUI();
      try { chrome.storage.local.set({ ankiMediaResumeEnabled: mediaResumeOn }); } catch (e) {}
    });
  }
  setMediaResumeUI();
  // Whether the clock speeds up while your head fills the focus box — see focusRect. Read here rather
  // than asked for per frame, and there is no button for it in this window: it changes how fast your
  // goal is credited, which is not a thing to put one tap away from a picture of your own face.
  //
  // It also decides whether the marker canvas is on screen at all, because the box is drawn on it.
  // See overlayLive.
  let paceOn = false;

  // ---------------- the switches, folded away ----------------
  // One button opens the three. Collapsed every time the window opens, on purpose: the whole
  // reason it exists is that the window should be a picture rather than a control panel, and
  // remembering it open would quietly undo that for anyone who looked inside once.
  //
  // Not stored anywhere either. It is the state of one panel in one window, not a setting —
  // storing it would also wake every other page's storage listener to announce it.
  const camTools = document.getElementById("camtools");
  const camToolsBtn = document.getElementById("camtoolsBtn");
  function setToolsOpen(open) {
    if (!camTools || !camToolsBtn) return;
    camTools.classList.toggle("open", !!open);
    camToolsBtn.setAttribute("aria-expanded", open ? "true" : "false");
    camToolsBtn.setAttribute("title", open ? "Hide camera options" : "Camera options");
  }
  if (camToolsBtn) {
    camToolsBtn.addEventListener("click", () => setToolsOpen(!camTools.classList.contains("open")));
  }
  // ---------------- the fifth disc: open the settings page ----------------
  // Not a switch, so there is no mirrored `let`, no setXUI and nothing written to storage — it is the
  // one member of this row that does something instead of remembering something.
  //
  // Routed through the worker rather than calling chrome.runtime.openOptionsPage here, and the reason
  // is this window: it is a popup with no tab strip, so the options tab opens in some normal browser
  // window that is very probably behind Anki. Only the worker can then bring that window to the
  // front. See the openOptions handler in background.js.
  //
  // stopPropagation for the drag. The picture is the window's drag handle in mini mode, and although
  // that listener already bows out for anything inside a `button`, this is the only control in the row
  // whose press moves focus to another window entirely — a drag left half-started here would have
  // nothing to finish it. Cheap, and it makes the button's behaviour independent of a guard written
  // somewhere else.
  document.getElementById("optbtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    // Folded away first. The menu is not remembered between openings of this window on purpose, and
    // leaving it hanging open behind a settings page that has just taken the focus would be the one
    // case where it outlives the moment you opened it for.
    setToolsOpen(false);
    try {
      chrome.runtime.sendMessage({ type: "openOptions" }, () => void chrome.runtime.lastError);
    } catch (err) {}
  });
  // Escape closes it, like anything else that opens over something else.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && camTools && camTools.classList.contains("open")) setToolsOpen(false);
  });
  setToolsOpen(false);

  try {
    chrome.storage.local.get(["ankiLivenessEnabled", "livenessIntervalSec", "ankiEyeRequired",
                              "soundEffectsEnabled", "faceSensitivity", "eyeSensitivity",
                              "camOverlayEnabled", "ankiGlowEnabled",
                              "ankiMediaPauseEnabled", "ankiMediaResumeEnabled", "ankiPaceEnabled",
                              "ankiPaceFast", "ankiPaceSlow", "ankiPaceBoxPct",
                              "moveSensitivity", "ankiBlinkRequired", "blinkIntervalSec",
                              "eyeAwaySec", "blinkSensitivity"], (r) => {
      if (!r) return;
      if (typeof r.ankiLivenessEnabled === "boolean") liveness.enabled = r.ankiLivenessEnabled;
      // Typed, not truthy. Zero is a real setting — "ask constantly" — and a truthiness
      // check silently threw it away and left the default of three minutes standing, so
      // the box said 0 and the camera window behaved as though it said 180.
      if (typeof r.livenessIntervalSec === "number" && isFinite(r.livenessIntervalSec)) {
        watchSeconds(liveness, r.livenessIntervalSec);
      }
      // A full interval in hand when this window opens, deliberately NOT carried over from
      // the last one.
      //
      // It used to inherit the previous session's stamp, so a window opened five minutes
      // later started already past its deadline: the clock was waiting on you before you had
      // any chance to do anything, and since this window is opened and closed every time you
      // switch to Anki and back, that was most of "it pauses the moment I stop moving".
      //
      // What it costs: someone with a photograph could close and reopen this window instead
      // of moving. That is far more work than nodding, every few seconds, forever — and
      // reopening it is what the extension does for you anyway, so the old stamp was never
      // much of a lock.
      watchFresh(liveness);
      if (r.moveSensitivity) liveness.needFrac = moveFracFor(r.moveSensitivity);
      if (typeof r.ankiEyeRequired === "boolean") eyeRequired = r.ankiEyeRequired;
      if (typeof r.ankiBlinkRequired === "boolean") blinkRequired = r.ankiBlinkRequired;
      if (r.blinkSensitivity) blinkSens = Math.max(1, Math.min(5, r.blinkSensitivity | 0));
      // Typed, not truthy, so a setting of 0 — "the moment you stop" — survives the trip.
      if (typeof r.eyeAwaySec === "number") watchSeconds(eyeWatch, r.eyeAwaySec);
      if (typeof r.blinkIntervalSec === "number") watchSeconds(blinkWatch, r.blinkIntervalSec);
      watchFresh(eyeWatch);
      watchFresh(blinkWatch);
      if (typeof r.soundEffectsEnabled === "boolean") soundOn = r.soundEffectsEnabled;
      setSoundUI();
      if (r.faceSensitivity) sensitivity = r.faceSensitivity;
      if (r.eyeSensitivity) eyeSens = r.eyeSensitivity;
      if (typeof r.camOverlayEnabled === "boolean") overlayOn = r.camOverlayEnabled;
      if (typeof r.ankiGlowEnabled === "boolean") glowOn = r.ankiGlowEnabled;
      // Both read truthily, which is the right default for each: media-pause ships ON, and pace
      // ships OFF — `=== true` for the second so an absent or garbled value cannot start handing out
      // time faster than the clock.
      mediaPauseOn = r.ankiMediaPauseEnabled !== false;
      setMediaPauseUI();
      // Read the same way as the pause it belongs to, because it ships the same way: ON. A
      // `=== true` here would show the disc as off on a fresh profile while the worker went on
      // resuming videos, which is the switch and the behaviour disagreeing.
      mediaResumeOn = r.ankiMediaResumeEnabled !== false;
      setMediaResumeUI();
      paceOn = r.ankiPaceEnabled === true;
      paceFast = paceClamp(r.ankiPaceFast, paceFast);
      paceSlow = paceClamp(r.ankiPaceSlow, paceSlow);
      // Stored as whole percent and used as a fraction — focusClamp does that conversion, so the
      // division lives in one place rather than at every reader.
      focusSize = focusClamp(r.ankiPaceBoxPct, focusSize);
      paintPaceTag();
      // After paceOn, not before it, and the order is load-bearing: the marker canvas is now shown
      // for either of two reasons — the markers themselves or the pace feature's focus box — so
      // setOverlayUI cannot decide anything until both are known. It used to sit beside the
      // camOverlayEnabled read a few lines up, which meant the box was judged against the paceOn
      // this window started with rather than the one on disk.
      setOverlayUI();
      setGlowUI();
    });
    // This window stays open for a whole study session, so it has to follow the
    // settings live — changing them used to need a reload of the cam window.
    chrome.storage.onChanged.addListener((c, area) => {
      if (area !== "local") return;
      // Any of these changing gives you a full interval in hand, so flipping a switch or moving
      // a dial never lands you already past a deadline.
      if (c.ankiEyeRequired) { eyeRequired = !!c.ankiEyeRequired.newValue; watchFresh(eyeWatch); }
      if (c.eyeSensitivity) { eyeSens = c.eyeSensitivity.newValue || 3; watchFresh(eyeWatch); }
      if (c.ankiBlinkRequired) { blinkRequired = !!c.ankiBlinkRequired.newValue; watchFresh(blinkWatch); }
      if (c.blinkSensitivity) {
        blinkSens = Math.max(1, Math.min(5, (c.blinkSensitivity.newValue | 0) || 3));
        // Relearn: the dial changes what counts as a dip, so the old baseline is measured
        // against a different rule.
        blinkBase = 0;
        watchFresh(blinkWatch);
      }
      if (c.eyeAwaySec) { watchSeconds(eyeWatch, c.eyeAwaySec.newValue); watchFresh(eyeWatch); }
      if (c.blinkIntervalSec) { watchSeconds(blinkWatch, c.blinkIntervalSec.newValue); watchFresh(blinkWatch); }
      if (c.soundEffectsEnabled) { soundOn = c.soundEffectsEnabled.newValue !== false; setSoundUI(); }
      if (c.ankiLivenessEnabled) {
        liveness.enabled = c.ankiLivenessEnabled.newValue !== false;
        // Switched back on mid-session, you start with a full interval in hand rather than
        // owing whatever time passed while it was off.
        watchFresh(liveness);
        liveness.seeded = false;
      }
      if (c.moveSensitivity) {
        liveness.needFrac = moveFracFor(c.moveSensitivity.newValue);
        // A dial change should be felt now, not after the current wait plays out.
        liveness.seeded = false;
      }
      if (c.livenessIntervalSec) {
        // `|| 180` was here, which turned a setting of 0 into three minutes.
        const secs = c.livenessIntervalSec.newValue;
        watchSeconds(liveness, typeof secs === "number" && isFinite(secs) ? secs : 10);
        watchFresh(liveness);
      }
      if (c.faceSensitivity) sensitivity = c.faceSensitivity.newValue || 3;
      if (c.camOverlayEnabled) { overlayOn = !!c.camOverlayEnabled.newValue; setOverlayUI(); }
      if (c.ankiGlowEnabled) { glowOn = c.ankiGlowEnabled.newValue !== false; setGlowUI(); }
      if (c.ankiMediaPauseEnabled) {
        mediaPauseOn = c.ankiMediaPauseEnabled.newValue !== false;
        setMediaPauseUI();
      }
      // Its own entry rather than a line inside the one above, because the two keys move
      // independently: the settings page can write either alone, and so can a second copy of this
      // window. Following the pause would leave this disc showing whatever the pause was set to.
      if (c.ankiMediaResumeEnabled) {
        mediaResumeOn = c.ankiMediaResumeEnabled.newValue !== false;
        setMediaResumeUI();
      }
      if (c.ankiPaceEnabled) {
        paceOn = c.ankiPaceEnabled.newValue === true;
        // Reset first: the box is about to appear or disappear, and a multiplier carried over from the
        // last time the feature was on is a claim about a reading nobody has taken yet.
        resetPace();
        // Brings the focus box up — or takes it away and leaves the markers alone if they are on.
        setOverlayUI();
      }
      // Moving a slider has to change what this window says at once, not at the next storage read.
      if (c.ankiPaceFast) { paceFast = paceClamp(c.ankiPaceFast.newValue, paceFast); paintPaceTag(); }
      if (c.ankiPaceSlow) { paceSlow = paceClamp(c.ankiPaceSlow.newValue, paceSlow); paintPaceTag(); }
      if (c.ankiPaceBoxPct) {
        focusSize = focusClamp(c.ankiPaceBoxPct.newValue, focusSize);
        // Repainted at once rather than at the next frame. Dragging this slider with the camera window
        // open is the only way anybody will pick a size, so the box has to follow the slider live —
        // and with no face in the picture no frame is drawn, which is exactly when you would be
        // setting it up.
        clearOverlay();
      }
      // Paused from anywhere — the popup's break button, the settings page, this window's own
      // button in another copy of it. All of them write the same key.
      if (c.userPaused) { pausedNow = !!c.userPaused.newValue; paintPause(); }

      // ---- the clock, the moment the worker moves it ----
      // Switch into Anki and the glow on Anki's own window goes green immediately, because
      // the add-on decides that colour itself, live. The number in here did not: it waited
      // for this window's own two-second refresh to ask the worker for a status. So the
      // glow said "counting" and the clock sat still, which reads as the time not having
      // started at all.
      //
      // The worker writes the verdict to storage at the end of every poll, and storage
      // events reach an extension page at once and are never throttled. So the very write
      // that turned the glow green moves the clock here, milliseconds later.
      //
      // Deliberately NOT a refresh() call: refresh() asks the worker to poll, a poll writes
      // these keys, and that is a loop with nothing to stop it.
      // The reason, on the same footing as the clock and for the same reason.
      //
      // Switching away from Anki is noticed by the add-on in about ten milliseconds and lands
      // in storage as soon as the poll it triggers finishes — but the words under the clock
      // were left to this page's own two-second refresh, so the number stopped at once and
      // nothing said why for up to two seconds. Worked out here instead, from the reason the
      // worker has just written.
      //
      // Before the clock block below, because setClockFrom paints and the paint is what puts
      // this line on screen.
      // ankiMediaWaiting joins the three keys above, and it needs this path rather than being left to
      // the two-second refresh for a sharper reason than the others. A stall that stops the clock
      // announces itself through ankiReason, which is already here. A stall that does NOT stop the
      // clock — the default profile, media gate off — has no reason to ride, so without this it would
      // wait for the refresh: a three-second hitch would be announced after it had cleared and then
      // withdrawn two seconds later, which is a message that only ever appears when it is wrong.
      if (c.ankiReason || c.ankiConnected || c.ankiStudying || c.ankiMediaWaiting || c.ankiResumeState) {
        if (c.ankiConnected) connectedNow = c.ankiConnected.newValue !== false;
        if (c.ankiReason) reasonNow = String(c.ankiReason.newValue || "");
        if (c.ankiMediaWaiting) clock.buffering = c.ankiMediaWaiting.newValue === true;
        if (c.ankiResumeState) clock.resume = String(c.ankiResumeState.newValue || "");
        if (c.ankiStoppedAt) clock.stoppedAt = Number(c.ankiStoppedAt.newValue) || 0;
        const studying = c.ankiStudying ? c.ankiStudying.newValue === true : clock.counting;
        const faceBlock = faceRequiredNow && !facePresent();
        clock.reason = (studying && !faceBlock) ? "" : shortReason(faceBlock);
        paintClock();
      }
      if (c.ankiStudying || c.ankiSpentSec || c.ankiRequiredSec) {
        const studying = c.ankiStudying ? c.ankiStudying.newValue === true : clock.counting;
        // The same local veto the two-second path applies. This window sees your face leave
        // before the worker's next poll does, so it must not announce counting on the
        // strength of a verdict taken a moment before that.
        const counting = studying && !(faceRequiredNow && !facePresent());
        if (counting) clock.reason = "";
        setClockFrom(c.ankiSpentSec ? c.ankiSpentSec.newValue : clock.spent,
                     c.ankiRequiredSec ? c.ankiRequiredSec.newValue : clock.req,
                     counting);
      }
      // Cached for the veto above, so turning the face check on takes effect here at once
      // rather than at the next refresh.
      if (c.ankiFaceRequired) faceRequiredNow = c.ankiFaceRequired.newValue === true;

      // Let go of the camera when it is no longer wanted.
      //
      // The worker has three "release the camera at once" paths — the power switch,
      // the break button, and the camera switch — and all three work by closing the
      // little camera window. But they deliberately leave a full study TAB alone
      // ("a full study tab is yours to keep"), and this page was watching none of
      // these keys. So in a full tab the stream and the recording light carried on
      // after the user had switched the extension off or asked for a break, which
      // is exactly what those controls promise not to do.
      const releasing =
        (c.enabled && c.enabled.newValue === false) ||
        (c.userPaused && c.userPaused.newValue) ||
        (c.ankiEnabled && c.ankiEnabled.newValue === false) ||
        (c.ankiFaceRequired && c.ankiFaceRequired.newValue === false) ||
        (c.ankiAutoCam && c.ankiAutoCam.newValue === false);
      if (releasing) {
        try { stopCamera(); } catch (e) {}
        // Say which of the two black rectangles this is. The window stays open through a
        // break now, so "the picture is gone" needs a reason next to it or it reads as the
        // camera having failed.
        if (c.userPaused && c.userPaused.newValue) setCam("paused", "wait");
      }
      // And pick it back up when it is wanted again, so pressing play doesn't need a
      // reload. startCamera guards against overlapping starts itself.
      const resuming =
        (c.enabled && c.enabled.newValue !== false) ||
        (c.userPaused && !c.userPaused.newValue) ||
        (c.ankiFaceRequired && c.ankiFaceRequired.newValue === true);
      // previewOnly means the finished panel is up and the picture is deliberately still
      // running with the detector off. `!ready` is true in that state, so without this check
      // any of these keys being written would drag the whole detector back to life on a day
      // that is already over.
      //
      // `!releasing` and `!pausedNow` are the other two halves, and both were missing.
      // `resuming` is satisfied by ANY write of `enabled` that isn't false — including one
      // batched alongside `userPaused: true`, which made releasing and resuming both true and
      // stopped then restarted the camera in the same tick. And on its own, any such write
      // during a break reached for the camera again, which is precisely what a break must not
      // do. pausedNow is already up to date here: it is assigned from this same change set
      // further up in this handler.
      if (resuming && !releasing && !pausedNow && !ready && !previewOnly) {
        // A stream we still hold only needs the detector switched back on. startCamera would
        // work — it stops the old stream before asking — but asking means waking the device
        // again and half a second of black for nothing.
        if (!resumeDetection()) { try { startCamera(); } catch (e) {} }
      }
    });
  } catch (e) {}

  // ---------------- eyes on the screen ----------------
  // Given the grayscale frame and the detected face box, look at where the eyes
  // are and decide whether they're open and pointed at the screen.
  //
  // How: an open eye pointed forward puts a dark pupil near the middle of its
  // socket. So in each eye patch we measure how much darker the darkest spot is
  // than the patch average (closed eyelids flatten that out) and where that spot
  // sits horizontally (looking off to one side pushes it to an edge).
  //
  // This is a heuristic on a 320x240 webcam frame, not medical gaze tracking —
  // it reliably catches "eyes shut" and "staring away from the screen", which is
  // what matters for study time.
  function analyseEyes(gray, w, h, faceRow, faceCol, faceSize) {
    const out = { ok: false, open: false, centred: false, score: 0, eyes: [] };
    if (!gray || !w || !h || !faceSize) return out;

    // Eye band: a bit above the middle of the face, one patch either side.
    const eyeY = faceRow - faceSize * 0.14;
    const dx = faceSize * 0.23;              // distance from centre to each eye
    const pw = Math.round(faceSize * 0.26);  // patch width
    const ph = Math.round(faceSize * 0.16);  // patch height
    if (pw < 6 || ph < 4) return out;

    const patch = (cx) => {
      const x0 = Math.max(0, Math.round(cx - pw / 2));
      const x1 = Math.min(w - 1, x0 + pw - 1);
      const yTop = Math.max(0, Math.round(eyeY - ph / 2));
      const y1 = Math.min(h - 1, yTop + ph - 1);
      // Skip the top slice of the patch: it is mostly eyebrow. A dark brow was
      // being taken for a pupil, which is why closed eyes still read as open.
      const y0 = Math.min(y1 - 1, yTop + Math.floor((y1 - yTop + 1) * 0.28));
      if (x1 <= x0 || y1 <= y0) return null;
      let sum = 0, n = 0, min = 255;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const v = gray[y * w + x];
          sum += v; n++;
          if (v < min) min = v;
        }
      }
      if (!n) return null;
      const mean = sum / n;
      // Everything close to the darkest reading is "the dark thing in this socket".
      // Its SHAPE tells the two cases apart: a pupil is a compact blob, a closed lid
      // is a lash line stretching right across the socket. A single darkest pixel
      // could never tell them apart — a lash is exactly as dark as a pupil.
      const cut = mean - 0.45 * (mean - min);
      let dn = 0, sx = 0, sy = 0, xa = x1, xb = x0, ya = y1, yb = y0;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (gray[y * w + x] <= cut) {
            dn++; sx += x; sy += y;
            if (x < xa) xa = x;
            if (x > xb) xb = x;
            if (y < ya) ya = y;
            if (y > yb) yb = y;
          }
        }
      }
      const spanX = Math.max(1, x1 - x0), spanY = Math.max(1, y1 - y0);
      const cxp = dn ? sx / dn : (x0 + x1) / 2;
      const cyp = dn ? sy / dn : (y0 + y1) / 2;
      return {
        // How pronounced the dark thing is, 0..1. Open eye ≈ 0.4+, flat lid ≈ 0.15.
        contrast: mean > 0 ? (mean - min) / mean : 0,
        // How far it stretches, as a share of the socket.
        spreadX: dn ? (xb - xa) / spanX : 0,
        spreadY: dn ? (yb - ya) / spanY : 0,
        // Centre of the dark mass, -1 (left) .. +1 (right). Steadier than one
        // darkest pixel, so the marker stops twitching.
        offset: ((cxp - x0) / spanX) * 2 - 1,
        // Where to draw: the socket we looked in, and the pupil we found in it.
        box: { x0, y0, x1, y1 }, px: cxp, py: cyp
      };
    };

    const L = patch(faceCol - dx), R = patch(faceCol + dx);
    if (!L || !R) return out;

    const cfg = eyeCfg();       // every number comes from the sensitivity slider
    const lidShut = e => e.spreadX >= cfg.wide && e.spreadY <= cfg.flat;
    const isOpen = e => e.contrast >= cfg.open && !lidShut(e);
    const isCentred = e => Math.abs(e.offset) <= cfg.off;
    out.open = isOpen(L) && isOpen(R);
    out.centred = isCentred(L) && isCentred(R);
    out.score = Math.min(L.contrast, R.contrast);
    // Both lids reading as a lash line rather than a pupil. Handed out for the blink check,
    // which needs the shape evidence as well as the contrast: `&&` because one eye in shadow
    // must not read as a blink, and a blink closes both.
    out.lidShut = lidShut(L) && lidShut(R);
    out.ok = out.open && out.centred;
    // Per eye, so a marker can be green on the eye that passes and red on the one
    // that doesn't, instead of one verdict covering both.
    out.eyes = [L, R].map(e => ({
      box: e.box, px: e.px, py: e.py,
      open: isOpen(e), centred: isCentred(e)
    }));
    return out;
  }

  // ---------------- the focus box ----------------
  // A rectangle drawn on the picture. Your face filling it, the clock runs at the fast speed you set;
  // your face outside it, the slow one; no face in the picture at all and the clock stops, which is
  // the ordinary presence rule and none of this feature's business.
  //
  // This replaced a pose reading taken from the two pupils — roll from one eye sitting higher than
  // the other, yaw from both drifting off the centre of the face box. That arithmetic worked, and it
  // was the wrong shape for the job: nothing on screen said where "square to the camera" WAS, so the
  // multiplier moved for reasons you could not see and, worse, could not aim at. A box you can see
  // and put your face into is the same reward made checkable, which is what a reward has to be.
  //
  // Shares of the frame rather than pixels, so the same box means the same thing on a 320x240 webcam
  // and on a 1280x720 one.
  //
  // A SQUARE, sized as a share of the frame's shorter side, dead centre.
  //
  // Square because the detector's face box is square, and comparing a square with a square is one
  // number rather than two that can disagree. A share of the shorter side so that "55%" means the same
  // framing on a 4:3 webcam and on a 16:9 one — off the width it would shrink to a slit on a wide
  // camera. Centred because the box is a target you aim at, and a target that is not in the middle of
  // the picture is a target you may not be able to reach with the camera you have.
  //
  // The size is yours to set — see ankiPaceBoxPct in Settings. Held as a fraction here and clamped on
  // the way in, so a garbled stored value cannot produce a box larger than the picture.
  const FOCUS_MIN = 0.3, FOCUS_MAX = 0.85;
  let focusSize = 0.55;
  const focusClamp = (v, fb) => {
    const n = Number(v) / 100;
    return Number.isFinite(n) ? Math.max(FOCUS_MIN, Math.min(FOCUS_MAX, n)) : fb;
  };
  // Two tests, and it took a wrong version to see why one was not enough.
  //
  // The first rule here was coverage: how much of the box is face. It let a face sitting well back
  // through, and the reason is arithmetic rather than tuning. Coverage is a product of two things —
  // how big your head is and how well it lines up — so a head at two-thirds the size of the box,
  // squarely centred, scores about the same as a head the right size sitting off to one side. Reported
  // as "I am far away but centred and it still speeds up", and that is exactly what it did.
  //
  // So the size question and the position question are asked separately, and both have to pass:
  //
  //   fit  your head's span divided by the box's span. 1 means your head exactly spans the box; more
  //        than 1 means you are closer than that, which is fine — the box is a minimum, not a frame to
  //        stay inside. This is the test the far-away case fails, and no amount of centring can pay
  //        for it.
  //   off  how far your head's centre sits from the box's centre, as a share of the way to its edge.
  //        1 means dead on the edge.
  //
  // 0.85 rather than 1: pico's box is drawn around the face rather than around the head, so a head
  // that visually fills the box measures a little smaller than it. Measured against the two framings
  // this was reported with — a head filling the window reads about 0.63 of the frame's height, a head
  // across the room about 0.38 — which at the default box size are fit 1.15 and fit 0.69. The bar sits
  // between them with room on both sides.
  const FOCUS_FIT = 0.85;
  const FOCUS_OFF = 0.45;
  // Slack once you are in, applied to both bars from one number. Without it a head parked on either
  // bar flips the speed several times a second, and the smoothing below would blur that into a number
  // hovering in the middle — the one reading that means nothing at all.
  const FOCUS_SLACK = 0.12;
  let focusIn = false;
  // The words currently on the picture. Blank means "nothing to say": you are in the box, or there is
  // nobody there to advise. Declared up here with focusIn rather than beside the code that writes it,
  // because the drawing reads it and the drawing is defined further down.
  let focusSay = "";
  // Where the box is, in this frame's own pixels. One function, used by the test AND by the drawing,
  // because the square you are judged against and the square you can see must be the same square.
  // Two copies of this is how the feature would come to lie.
  function focusRect(w, h) {
    const side = Math.min(w, h) * focusSize;
    return { x: (w - side) / 2, y: (h - side) / 2, w: side, h: side };
  }
  // The two readings above, or null when there is no face to take them from.
  //
  // nx and ny are the offset per axis, signed, scaled so that 1 is dead on the box's edge. Signed
  // because the on-screen hint has to say WHICH way to move, and taken from here rather than worked
  // out again next to the words: two copies of this arithmetic could disagree, and then the box would
  // be amber while the arrow pointed the wrong way.
  function focusFit(w, h, face) {
    if (!face || !(face.size > 0) || !(w > 0) || !(h > 0)) return null;
    const b = focusRect(w, h);
    if (!(b.w > 0) || !(b.h > 0)) return null;
    const nx = (face.col - (b.x + b.w / 2)) / (b.w / 2);
    const ny = (face.row - (b.y + b.h / 2)) / (b.h / 2);
    return { fit: face.size / b.w, nx, ny, off: Math.max(Math.abs(nx), Math.abs(ny)) };
  }
  // What to tell you while the box is amber, in the words of somebody sitting in front of it.
  //
  // Distance first, and always first: being off to one side cannot be fixed while you are too far away
  // to fill the box at all, so "move left" to somebody across the room is advice that leads nowhere.
  // Once the size is right, the worse of the two axes is the one worth naming — fixing the bigger error
  // is what moves you towards green, and one instruction at a time is what a 176-pixel window has room
  // for anyway.
  //
  // LEFT and RIGHT are the reader's own, and the sign looks inverted because of the mirror. The picture
  // carries scaleX(-1) so that it behaves like a mirror; the raw frame does not. In the raw frame your
  // right side is at LOW x — the camera sees you the way a person facing you would — so a head at a low
  // x is a head displaced to its owner's RIGHT, and the way back to the middle is to move left. On
  // screen it will travel leftwards as you do, which is what a mirror does, so the words match both the
  // body and the picture.
  //
  // Up and down need none of that: nothing flips vertically.
  function focusHint(m) {
    if (!m) return "FACE THE CAMERA";
    if (m.fit < FOCUS_FIT) return "COME CLOSER";
    if (Math.abs(m.nx) > Math.abs(m.ny)) return m.nx < 0 ? "MOVE LEFT" : "MOVE RIGHT";
    return m.ny < 0 ? "MOVE DOWN" : "MOVE UP";
  }
  // Smoothed, and that is not cosmetic. The face box moves by a few pixels frame to frame, so an
  // unsmoothed multiplier would step between the two speeds repeatedly on the boundary — the clock
  // would visibly stutter, and the number the worker credits by would depend on which frame its poll
  // happened to land on. The hysteresis above stops the DECISION flapping; this stops the number
  // jumping when the decision genuinely changes.
  let paceNow = 1;
  const PACE_SMOOTH = 0.15;
  // face is { row, col, size } in frame pixels, or null for "there is something there, but it is not
  // a face squarely in front of the lens" — a head on its side, a scalp over a notebook, a shape in
  // the chair. All of those are the slow speed by definition: the reward is for facing the camera,
  // and a tilted head is the exact posture the slow end was written for.
  function notePace(w, h, face) {
    const m = focusFit(w, h, face);
    // The slack is spent only on staying in, never on getting in, which is what makes it hysteresis
    // rather than a looser bar.
    const slack = focusIn ? FOCUS_SLACK : 0;
    focusIn = !!m && m.fit >= (FOCUS_FIT - slack) && m.off <= (FOCUS_OFF + slack);
    // Worked out here, where the measurements already are, and stored for the drawing to pick up. The
    // drawing runs from several places — the clean frame, each of the loose rungs, and the idle repaint
    // — and none of them should have to know how the verdict was reached.
    focusSay = focusIn ? "" : focusHint(m);
    const want = focusIn ? paceFast : paceSlow;
    paceNow = paceNow + (want - paceNow) * PACE_SMOOTH;
    paintPaceTag();
  }
  // Back to neutral when there is nobody there.
  //
  // Not tidiness: the smoothing means the first frames after you sit back down are credited at
  // whatever the number was when you left, so a fast reading left over from before would pay you
  // double for the moment of arriving. 1 is the honest value for "we do not know yet".
  function resetPace() {
    paceNow = 1;
    focusIn = false;
    // No advice with nobody in the picture. The badge already says "no face", and "come closer" over an
    // empty chair is the window talking to itself.
    focusSay = "";
    paintPaceTag();
  }
  // The two ends of the range, as set by the sliders in Settings. Seeded with the same defaults the
  // worker holds, so a storage read that has not landed yet cannot report something the worker would
  // refuse. Both are clamped to the hard bounds here as well as there — this page decides what to
  // report and the worker decides what to believe, and neither may depend on the other having got it
  // right.
  const PACE_HARD_MIN = 0.1, PACE_HARD_MAX = 4;
  let paceFast = 1.5, paceSlow = 0.5;
  const paceClamp = (v, fb) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(PACE_HARD_MIN, Math.min(PACE_HARD_MAX, n)) : fb;
  };
  // What it is doing, on screen, in the window you are looking at.
  //
  // Without this the feature is invisible: the goal simply arrives sooner or later than the wall
  // clock says and there is nothing to connect that to how you were sitting. A number that moves
  // while you straighten up is the whole difference between a reward and a bug.
  //
  // Only while the feature is on, and only while the clock is actually being credited — a multiplier
  // shown next to a stopped clock is a promise about nothing.
  const paceTag = document.getElementById("pacetag");
  function paintPaceTag() {
    if (!paceTag) return;
    const show = paceOn && facePresent();
    paceTag.hidden = !show;
    if (!show) return;
    // One decimal. Two would jitter on the last digit with every frame, and the smoothing exists
    // precisely so this reads as a number rather than as noise.
    paceTag.textContent = paceNow.toFixed(1) + "×";
    // Green when you are being paid more than a second a second, amber when less. The colours are
    // the ones this window already uses for "counting" and "waiting on you", so nothing new has to
    // be learned.
    paceTag.className = "pacetag " + (paceNow >= 1.02 ? "up" : (paceNow <= 0.98 ? "down" : ""));
  }

  // ---------------- live markers ----------------
  // Shows what the detector is looking at: the face box, both eye sockets, and a
  // dot on each pupil — green while that eye passes, red while it doesn't. Only a
  // view of state already computed, so turning it off changes no decision.
  const ovc = document.getElementById("camov");
  const octx = ovc ? ovc.getContext("2d") : null;
  const ovBtn = document.getElementById("camtog");
  // Off until storage says otherwise, matching the shipped default. It used to start true, so
  // the markers were drawn for the first second of every window even on a profile that has them
  // switched off — the read below is asynchronous and the camera is not.
  let overlayOn = false;
  const MK_GREEN = "#22c55e", MK_RED = "#ef4444", MK_AMBER = "#f59e0b";
  // Is there any reason to have this canvas on screen? Two independent ones now: the marker toggle,
  // and the pace feature, which draws its focus box on the same canvas.
  //
  // The same canvas rather than a positioned <div> with a border, and that is a geometry decision
  // rather than a stylistic one. The video is shown with object-fit:contain and object-position:top,
  // so the picture does not fill its container — it is letterboxed, by an amount that depends on the
  // window's shape. This canvas is sized to the frame's own pixel dimensions and carries the identical
  // contain/top/mirror rules (see .camov in study.html), so a rectangle drawn at frame coordinates
  // lands exactly where you see it. A div would have to recompute that letterboxing itself, and a box
  // drawn a few percent away from the box being measured is the whole feature made untrustworthy.
  function overlayLive() { return overlayOn || paceOn; }
  function setOverlayUI() {
    if (ovBtn) ovBtn.setAttribute("aria-pressed", overlayOn ? "true" : "false");
    if (ovc) { ovc.hidden = !overlayLive(); clearOverlay(); }
  }
  // The frame size the canvas is currently set up for. The video is asked first because the box has
  // to be drawable before any face has ever been found — switch the feature on with an empty chair
  // and the guide is exactly what you need — and drawMarkers, which is what normally sizes the
  // canvas, has not run in that case.
  let ovW = 0, ovH = 0;
  function ovFrame() {
    const w = (v && v.videoWidth) || ovW, h = (v && v.videoHeight) || ovH;
    return (w > 0 && h > 0) ? { w, h } : null;
  }
  function clearOverlay() {
    if (!octx || !ovc) return;
    octx.clearRect(0, 0, ovc.width, ovc.height);
    // The box is a guide, not a readout, so it stays up when there is nothing to judge — which is the
    // moment it earns its keep, because "where do I put my face" is the question being asked then.
    // Not over a dead picture though. Once the stream is released there is nothing behind the canvas
    // to aim at, and a target floating on black is a prompt to do something that cannot be done.
    if (!paceOn || ovc.hidden || !v || !v.srcObject) return;
    const f = ovFrame();
    if (!f) return;
    if (ovc.width !== f.w || ovc.height !== f.h) { ovc.width = f.w; ovc.height = f.h; }
    ovW = f.w; ovH = f.h;
    drawFocusBox(f.w, f.h);
  }
  // Dashed, so it reads as a target rather than as something that was found — every solid rectangle in
  // this overlay means "detected". Green once you are in it, amber while you are not: the same pair
  // the multiplier badge beside the clock uses, so there is nothing new to learn.
  // ONE rectangle, and only this one. A thin square around the face used to be drawn beside it so you
  // could see how much of the box you were covering, and with the coverage rule gone it has no job
  // left: the rule is now "put your head in the box", the box says green or amber, and a second
  // rectangle next to it is just something else to read. The marker toggle still draws a face box —
  // that is the markers' business, not this feature's.
  function drawFocusBox(w, h) {
    if (!paceOn || !octx) return;
    const b = focusRect(w, h);
    octx.save();
    octx.setLineDash([Math.max(4, w / 40), Math.max(3, w / 60)]);
    octx.lineWidth = Math.max(1, Math.round(w / 200));
    octx.strokeStyle = focusIn ? MK_GREEN : MK_AMBER;
    octx.strokeRect(b.x, b.y, b.w, b.h);
    octx.restore();
    drawHint(w, h, b, focusSay);
  }
  // The way out of amber, written on the picture under the box.
  //
  // On the picture and not in the status band, because in the little window that band is a 20-pixel
  // round badge with room for one glyph — see `html.mini .camstatus` — so a sentence has nowhere else to
  // go. Under the box is where it belongs anyway: the instruction and the thing it is about are then
  // read in one glance.
  //
  // Two things have to be undone before it is legible, and both were found by thinking about what this
  // canvas actually is rather than by looking at it.
  //
  //   THE MIRROR. This canvas carries transform:scaleX(-1) so it lines up with the video, which means
  //   glyphs drawn the ordinary way come out backwards. Scaling the text by -1 about the frame's own
  //   centre line puts it back the right way round without moving it, because the text is centred there
  //   and so is the box.
  //
  //   THE SCALE. The canvas is sized in FRAME pixels — 640 across on a typical webcam — and shown inside
  //   a window that may be 176 across, so a font asked for in frame pixels arrives on screen at about a
  //   third of the size. The displayed scale is worked out from the element and divided out, so the text
  //   is the size it should be whatever the window has been dragged to.
  function drawHint(w, h, b, text) {
    if (!text || !octx || !ovc) return;
    const ew = ovc.clientWidth || 0, eh = ovc.clientHeight || 0;
    if (!(ew > 0) || !(eh > 0)) return;
    // object-fit:contain, so the picture is drawn at the SMALLER of the two ratios.
    const scale = Math.min(ew / w, eh / h);
    if (!(scale > 0)) return;
    // How big it should look, in screen pixels: it tracks the window a little, with a floor so it stays
    // readable at passport size and a ceiling so it does not become a banner in the full tab.
    const want = Math.max(9, Math.min(16, ew * 0.075));
    const size = Math.max(1, Math.round(want / scale));
    // Under the box, unless the box is near the bottom — then above it. Never off the picture.
    const gap = size * 0.85;
    let y = b.y + b.h + gap;
    if (y + size * 0.6 > h) y = Math.max(size, b.y - gap * 0.5);
    octx.save();
    octx.translate(w / 2, y);
    octx.scale(-1, 1);
    octx.font = "800 " + size + "px system-ui, -apple-system, Segoe UI, sans-serif";
    octx.textAlign = "center";
    octx.textBaseline = "middle";
    // Outlined first, filled second. This lands on whatever happens to be behind your head — a bright
    // window, a pale wall — and amber on either of those is unreadable without something dark under it.
    octx.lineWidth = Math.max(2, size * 0.2);
    octx.strokeStyle = "rgba(15,23,42,.9)";
    octx.lineJoin = "round";
    octx.strokeText(text, 0, 0);
    octx.fillStyle = MK_AMBER;
    octx.fillText(text, 0, 0);
    octx.restore();
  }
  function drawMarkers(w, h, face, eyes, verdict) {
    if (!overlayLive() || !octx || !ovc) return;
    if (ovc.width !== w || ovc.height !== h) { ovc.width = w; ovc.height = h; }
    ovW = w; ovH = h;
    octx.clearRect(0, 0, w, h);
    // Underneath the markers, and drawn whether or not they are on: the pace feature owns this box
    // and the marker toggle has no say over it.
    drawFocusBox(w, h);
    if (!overlayOn) return;
    const colour = verdict === "ok" ? MK_GREEN : verdict === "wait" ? MK_AMBER : MK_RED;
    if (face) {
      const half = face.size / 2;
      octx.strokeStyle = colour;
      octx.lineWidth = Math.max(1, Math.round(w / 220));
      octx.strokeRect(face.col - half, face.row - half, face.size, face.size);
    }
    (eyes || []).forEach(e => {
      const c = (e.open && e.centred) ? MK_GREEN : MK_RED;
      octx.strokeStyle = c;
      octx.lineWidth = Math.max(1, Math.round(w / 300));
      octx.strokeRect(e.box.x0, e.box.y0, e.box.x1 - e.box.x0, e.box.y1 - e.box.y0);
      // The pupil itself: a filled dot, so you can watch it move as you look around.
      octx.beginPath();
      octx.arc(e.px, e.py, Math.max(2, w / 90), 0, Math.PI * 2);
      octx.fillStyle = c;
      octx.fill();
      if (!e.open) {   // eyelid down: a line through the socket reads as "shut"
        octx.beginPath();
        octx.moveTo(e.box.x0, (e.box.y0 + e.box.y1) / 2);
        octx.lineTo(e.box.x1, (e.box.y0 + e.box.y1) / 2);
        octx.strokeStyle = MK_RED;
        octx.stroke();
      }
    });
  }
  if (ovBtn) {
    ovBtn.addEventListener("click", () => {
      overlayOn = !overlayOn;
      setOverlayUI();
      // Saved, so the setting survives a reload and matches the Settings page.
      try { chrome.storage.local.set({ camOverlayEnabled: overlayOn }); } catch (e) {}
    });
  }


  function rgbaToGrayscale(rgba, nrows, ncols) {
    const gray = new Uint8Array(nrows * ncols);
    for (let r = 0; r < nrows; r++) {
      for (let c = 0; c < ncols; c++) {
        const i = r * 4 * ncols + 4 * c;
        gray[r * ncols + c] = (2 * rgba[i] + 7 * rgba[i + 1] + 1 * rgba[i + 2]) / 10;
      }
    }
    return gray;
  }

  // Held so the camera can actually be released. Nothing stopped the tracks
  // before, so the webcam light stayed on after the page was done with it — which
  // flatly contradicts the promise this page makes about the camera.
  let camStream = null;
  // Declared up here, not next to the detection loop that uses them: stopCamera()
  // clears them and runs from a pagehide listener, and `let` on a lower line would
  // be in its temporal dead zone if that ever fired mid-load.
  let detectTimer = 0;
  // Same reason for these, which belong with the faceless-presence passes further down and
  // are declared here only because stopCamera resets them: the last time a face was found
  // at any angle, the last time the picture changed, and whether the grids hold anything
  // worth comparing against.
  // faceSceneAt: when the picture was last photographed WITH you visibly in it. It is what the
  // "have you left" test measures against, and it lives here for the same reason as the rest.
  let lastFaceAt = 0, lastMotionAt = 0, moHave = false, bgAt = 0, faceSceneAt = 0;
  // The camera is running but nothing is being judged: the finished panel is up, so the picture
  // is a mirror rather than evidence. Declared here with the rest of the camera state because
  // stopCamera clears it — releasing the stream ends the preview along with everything else.
  let previewOnly = false;
  // Whether requestVideoFrameCallback is driving, and when a frame last arrived.
  // The watchdog uses these to decide whether to take over — and to hand back.
  let frameDriver = false, frameSeenAt = 0;
  // The handle for the pending requestVideoFrameCallback, so it can be cancelled.
  // Without it, a recovery attached a SECOND callback chain to the same element and
  // both ran once frames returned.
  let frameCbId = 0;
  // Pending retry after the camera was taken away mid-session.
  let camRetry = 0;
  // True while startCamera is part-way through. getUserMedia, the cascade fetch and
  // the play() await are all suspension points, and two overlapping starts leave two
  // MediaStreams attached to one video element — one of which nothing can stop.
  let camStarting = false;
  // Bumped by stopCamera. A start reads it once and checks it after every await: if it moved
  // while we were waiting, the camera was released meanwhile and the stream that has just
  // arrived belongs to nobody. Without this, pausing during those few hundred milliseconds
  // set camStream to null and then the start assigned the new stream over the top of it —
  // camera light on, nothing reading from it, and no reference left to stop it with. It only
  // became reachable now that a break keeps this window open instead of closing it.
  let camGen = 0;

  function stopCamera() {
    camGen++;
    ready = false;
    faceNow = false;
    frameSeenAt = 0;
    // There is no picture to preview once the stream is gone, so this must not be left set —
    // it is what tells the resume path further up not to reach for the camera, and a stale
    // `true` here would leave a black window with no way to bring the picture back.
    previewOnly = false;
    // The faceless rungs extend a real sighting, and a sighting from before a break is not
    // one. Left standing, coming back from a break would arrive with the grace already paid
    // for and the clock could run before a face had been seen at all. The grids go with it:
    // the first frame after a restart has nothing honest to compare against, and a camera
    // that comes back at a different exposure or resolution would read its own change as a
    // body arriving.
    lastFaceAt = 0;
    lastMotionAt = 0;
    moHave = false;
    bgAt = 0;
    faceSceneAt = 0;
    // The face's own texture reading goes with the rest of the reference. A camera that comes back
    // at a different exposure would leave the old number standing as the thing "flat" is measured
    // against, and it would be measuring a different room.
    faceCells = null;
    faceSd = 0;
    if (detectTimer) { clearInterval(detectTimer); detectTimer = 0; }
    // Cancel the pending frame callback and the pending retry. Neither was cleared,
    // so releasing the camera could still be followed by startCamera() firing three
    // seconds later and taking it again — on a page that had already said goodbye.
    if (frameCbId) { try { v.cancelVideoFrameCallback(frameCbId); } catch (e) {} frameCbId = 0; }
    frameDriver = false;
    if (camRetry) { clearTimeout(camRetry); camRetry = 0; }
    // The head-start request from the top of this file, if nothing has claimed it yet. It
    // would otherwise land a second or two after this and leave the camera light on with
    // no page reading from it — which is the one thing "released the camera" must not mean.
    if (earlyCam) {
      const pending = earlyCam;
      earlyCam = null;
      pending.then(s => s.getTracks().forEach(t => t.stop())).catch(() => {});
    }
    try { (camStream ? camStream.getTracks() : []).forEach(t => t.stop()); } catch (e) {}
    camStream = null;
    try { v.srcObject = null; } catch (e) {}
    clearOverlay();
    // Tell the background before going quiet. Without this the last "face present"
    // stayed fresh for up to five seconds with no page left to ask for a fresh
    // reading, so one more poll slice could be credited to an empty chair.
    sendFace();
  }
  // Closing the tab or window releases the camera immediately rather than waiting
  // for the browser to get around to tearing the page down.
  window.addEventListener("pagehide", stopCamera);

  async function startCamera() {
    if (camStarting) return;
    camStarting = true;
    try { await startCameraOnce(); } finally { camStarting = false; }
  }
  async function startCameraOnce() {
    setCam("starting…", "wait");
    // Any previous stream and any pending frame callback go first, so a retry
    // replaces the camera rather than stacking on top of it.
    if (frameCbId) { try { v.cancelVideoFrameCallback(frameCbId); } catch (e) {} frameCbId = 0; }
    frameDriver = false;
    try { (camStream ? camStream.getTracks() : []).forEach(t => t.stop()); } catch (e) {}
    camStream = null;
    // This attempt's ticket. Anything that releases the camera from here on bumps camGen,
    // and every await below checks the ticket is still the current one.
    const gen = camGen;
    const cancelled = () => gen !== camGen;
    let stream;
    try {
      // The head-start request from the top of the file, on the first start. It is taken
      // rather than borrowed: a retry, or a start after the camera was released, has to ask
      // the device again, and handing out the same settled promise twice would attach a
      // stream that has already been stopped.
      const early = earlyCam;
      earlyCam = null;
      stream = await (early || navigator.mediaDevices.getUserMedia(CAM_WANT));
    } catch (e) { if (!cancelled()) setCam("allow camera", "bad"); return; }
    // Released while the device was opening — a break, the switch turned off, the window
    // going away. Hand it straight back rather than leaving it running for nobody.
    if (cancelled()) { try { stream.getTracks().forEach(t => t.stop()); } catch (e) {} return; }
    camStream = stream;
    // The camera can be taken away from under us — unplugged, disabled, or the
    // permission revoked. Say so instead of sitting on the last good reading.
    stream.getTracks().forEach(t => t.addEventListener("ended", () => {
      ready = false;
      faceNow = false;
      setCam("camera lost", "bad");
      sendFace();
      // One retry, because a USB webcam glitching for a second used to end
      // detection for the rest of the session in a full study tab. The little
      // camera window recovers by itself (the worker recreates it); a tab does not.
      if (camRetry) return;
      camRetry = setTimeout(() => { camRetry = 0; startCamera(); }, 3000);
    }));
    v.srcObject = stream;
    try { await v.play(); } catch (e) {}
    await new Promise(res => { if (v.readyState >= 2) return res(); v.onloadeddata = () => res(); setTimeout(res, 1500); });
    if (cancelled()) return;                 // stopCamera already stopped this stream

    // The camera goes back before we give up, and that is the whole point of these two
    // lines. Both of these used to return with the stream still held: the recording light
    // stayed on, `ready` was false so nothing read a frame, and nothing recovered —
    // resumeDetection refuses without a classifier. A camera nobody is looking through is
    // the one state this page must never leave behind.
    if (typeof pico === "undefined") { stopCamera(); setCam("lib error", "bad"); return; }
    // Already in flight since the page opened, so on the first start this is normally
    // settled before the camera has delivered a frame and there is nothing to wait for.
    setCam("loading…", "wait");
    classify = await cascadeReady;
    if (cancelled()) return;
    if (!classify) { stopCamera(); setCam("model error", "bad"); return; }

    updateMemory = pico.instantiate_detection_memory(MEM_FRAMES);
    ready = true;
    setCam("looking…", "wait");
    // The stream's real shape is only knowable now. It may not be the 4:3 that was asked
    // for — a request is a preference, not an instruction — so the window is fitted to what
    // actually arrived rather than to what we wanted.
    reportShapeSoon();
    scheduleDetection();
  }

  const detectParams = { shiftfactor: 0.1, minsize: 80, maxsize: 1000, scalefactor: 1.1 };
  let lastDetectAt = 0;

  // ---------------- is anything in the picture moving? ----------------
  // Deliberately not a face question. It exists for the case where there is no face to
  // ask about — head down over a notebook — and the only thing left to tell "working at
  // the desk" from "empty chair" is whether the picture is still changing.
  //
  // A coarse grid of cell averages, compared with the previous frame. Averaging is the
  // point: sensor noise is per-pixel and cancels, a moving arm does not. Two readings off
  // the same grid, because they fail in different directions — the mean catches a general
  // shuffle, the hot-cell count catches a small hand moving in an otherwise still frame.
  const MO_COLS = 24, MO_ROWS = 18;
  const MO_MEAN = 1.2;      // average grey-level change across the whole grid
  const MO_CELL = 10;       // a cell that changed by this much is "something happened here"
  const MO_HOT = 5;         // and this many of them is a thing moving, not a flicker
  // ---------------- and is the chair full? ----------------
  // A different question from movement, and the one the kind and easy settings rest on:
  // someone sitting perfectly still is invisible to a frame-to-frame comparison, but they
  // are still blocking most of the picture.
  //
  // Answering it needs to know what the room looks like WITHOUT you, and the only honest
  // way to learn that is to wait until you have demonstrably gone: no face found for a
  // good while AND the picture completely unchanging. Both, deliberately. Stillness alone
  // would learn you dozing at the desk as the wall behind you, and from then on it would
  // say the chair was empty every time you sat in it.
  //
  // It re-learns whenever those conditions hold again, so an afternoon of drifting daylight
  // is tracked rather than slowly turning into a false body.
  // Worth knowing while reading these two: until the lastFaceAt fix further down, neither
  // condition could ever be met. The faceless rungs stamped lastFaceAt on every frame they
  // passed, so "no face for 45 seconds" was permanently false and this reference was never
  // learned even once — which is why the check below it, the one meant to overrule every guess
  // in the ladder, sat there answering "don't know" for the whole session.
  const BG_FACE_MS = 45000;   // no face for this long: you are probably not in the room
  const BG_STILL_MS = 15000;  // and nothing has moved for this long: probably nobody is
  // And the quick route's version of "nothing is moving": once the departure test has said you
  // went, this is only waiting for the picture to stop swinging about as the door closes behind
  // you. It does not have to carry any of the weight the fifteen seconds above carry, because
  // the departure test has already established that what is in frame is not you.
  const BG_SETTLE_MS = 4000;
  const BG_CELL = 12;         // grey levels away from the empty room = this cell is blocked
  const BG_FRAC = 0.12;       // and this share of the picture blocked is a person, not a shadow
  let bgGrid = null;
  // moHave, lastMotionAt, lastFaceAt and bgAt are declared with the camera state above, because
  // stopCamera resets them and would hit their dead zone from here. lastFaceAt is what the
  // faceless rungs are anchored on: they extend a real sighting, they never invent one.
  let moNow = null, moPrev = null, moStartAt = 0;
  function noteMotion(gray, w, h, now) {
    const cells = MO_COLS * MO_ROWS;
    if (!moNow) { moNow = new Float32Array(cells); moPrev = new Float32Array(cells); }
    const cw = w / MO_COLS, ch = h / MO_ROWS;
    // Four samples across a cell, not every pixel in it. This runs on every frame beside
    // the cascade and the answer is one bit; reading the whole frame again to get it would
    // cost more than the bit is worth.
    const sx = Math.max(1, Math.floor(cw / 4)), sy = Math.max(1, Math.floor(ch / 4));
    for (let cy = 0; cy < MO_ROWS; cy++) {
      const y0 = Math.floor(cy * ch), y1 = Math.min(h, Math.floor((cy + 1) * ch));
      for (let cx = 0; cx < MO_COLS; cx++) {
        const x0 = Math.floor(cx * cw), x1 = Math.min(w, Math.floor((cx + 1) * cw));
        let sum = 0, n = 0;
        for (let y = y0; y < y1; y += sy) {
          const row = y * w;
          for (let x = x0; x < x1; x += sx) { sum += gray[row + x]; n++; }
        }
        moNow[cy * MO_COLS + cx] = n ? sum / n : 0;
      }
    }
    if (moHave) {
      // Compared against the average change, not against zero. A webcam's automatic gain
      // steps the brightness of the WHOLE picture at once, and often several levels at a
      // time — read literally that is every cell changing, which is indistinguishable from
      // the room being redecorated. Real movement is local: some cells change a lot while
      // the rest don't, so it survives having the frame-wide part taken out, and a gain step
      // doesn't.
      let mean = 0;
      for (let i = 0; i < cells; i++) mean += moNow[i] - moPrev[i];
      mean /= cells;
      let total = 0, hot = 0;
      for (let i = 0; i < cells; i++) {
        const d = Math.abs(moNow[i] - moPrev[i] - mean);
        total += d;
        if (d > MO_CELL) hot++;
      }
      if (total / cells >= MO_MEAN || hot >= MO_HOT) lastMotionAt = now;
    } else {
      moStartAt = now;   // stillness has to be measured from somewhere on the first frame
    }
    moPrev.set(moNow);
    moHave = true;

    // Learn the empty room, if this looks like one.
    //
    // Route 1, the quick one: the departure test says the scene no longer holds you, and it has
    // since settled. This is much faster than route 2 and safer, not less safe — the thing route
    // 2 has to guard against is memorising someone who has gone quiet at the desk, and a person
    // dozing there does not change the scene at all, so this route cannot fire for them. It is
    // also the only route that runs at all early in a session.
    //
    // Route 2, the patient one: no face for a long time and nothing moving for a while. Kept for
    // the case where there is no reference to compare against — the camera came up with nobody
    // in front of it, so route 1 has nothing to say and never will until a face turns up once.
    const settled = stillFor(now) >= BG_SETTLE_MS;
    const learn = (faceSceneAt && settled && sceneChangedSinceFace() >= GONE_FRAC) ||
                  (lastFaceAt && now - lastFaceAt >= BG_FACE_MS && stillFor(now) >= BG_STILL_MS);
    if (learn) {
      if (!bgGrid) bgGrid = new Float32Array(cells);
      bgGrid.set(moNow);
      bgAt = now;
    }
  }
  // How long the picture has been unchanged. Before anything has ever moved there is no
  // lastMotionAt to measure from, so the first frame stands in for it.
  function stillFor(now) { return now - Math.max(lastMotionAt, moStartAt); }
  function movingRecently(now, withinMs) {
    return lastMotionAt > 0 && (now - lastMotionAt) <= withinMs;
  }
  // ---------------- have you left? ----------------
  // The one question the ladder was missing, and the only presence test here that can answer
  // the moment it happens.
  //
  // Everything else in this file is either "is there a face" (which a head over a notebook
  // fails) or "is anything moving" (which a curtain passes) or "does this match the empty room"
  // (which needs to have seen the room empty first, and so is no use for the first hour of a
  // session). Between them, the honest answer to "he stood up and walked off just now" was a
  // grace period — the clock kept running for as long as the dial said, because nothing on the
  // page could tell that anything had changed.
  //
  // Something obvious HAD changed, though: the picture. So keep the picture as it was the last
  // time a face was actually in it, and compare against that instead of against an empty room
  // nobody has seen yet.
  //
  //   head down over a notebook — your head moves a foot; your shoulders, arms and the whole
  //   lower half of the frame stay exactly where they were. A small part of the picture differs.
  //
  //   out of the chair — head, shoulders, arms and torso all leave at once and the wall, the
  //   bed, the door behind you arrive in their place. A large part of the picture differs.
  //
  // That gap is what separates the posture the dial is meant to forgive from the absence it is
  // never meant to forgive, and it is available on the very first frame after you go.
  const GONE_FRAC = 0.22;     // this share of the picture different from "you, there" = you left
  // Two frames, not one. A hand swept across the lens, a door opening behind you, the camera's
  // own exposure lurching — any of those can spike one frame's difference, and stopping the
  // clock for a blink and starting it again is its own kind of broken. Two consecutive looks is
  // still under a tenth of a second at the rate this runs.
  const GONE_HITS = 2;
  let faceGrid = null, goneHits = 0;
  // Which cells your face filled when it was last seen, and how much detail was in them.
  //
  // This is the answer to "something is being held over my face and the clock keeps running". A face
  // is the most structured thing in the picture — brows, eye sockets, nostrils, a mouth — so the
  // cells it covers vary a lot. A lamp shade, a sheet of card, a palm, a book cover: all of them are
  // large and nearly featureless. Cover your face with one and the cells that held all that
  // structure go flat.
  //
  // Compared against the face's OWN reading rather than against a fixed number, because "flat" is
  // relative to the camera and the light: a dim webcam's face may vary less than a bright one's
  // desk. A share of what was there is scale-free; an absolute threshold would be tuned to one room.
  let faceCells = null, faceSd = 0;
  // Under this share of the detail your face had, the thing in front of the lens is not your face
  // and is not your posture either.
  //
  // Note what this deliberately does NOT try to distinguish: an object over your face, and you
  // having left with a blank wall behind you. Both read the same here and both should stop the
  // clock, so there is nothing to separate. The one case it can cost is a head bent over a plain
  // pale desk, which reads flat too — and stopping there is the direction to be wrong in, given the
  // rung it is guarding is a guess about a face nobody can see.
  //
  // On the number itself, honestly: it was set at 0.45 and the case that prompted this — a lamp held
  // up — measured 0.47 on a synthetic frame with the object exactly face-sized, so it slipped
  // through by two hundredths. A real object overhangs the face and reads far lower, but "it works
  // when the cheat is careless" is not a threshold. 0.55 catches the exact-size case as well, and a
  // textured desk measured 0.65 in the same test, so the head-down rung keeps a tenth of margin.
  //
  // Both of those numbers come from synthetic grids, which is weak evidence and is why they are
  // written down here rather than only in a deleted test. If head-down starts pausing on a plain
  // pale desk, this number is the one to move.
  const BLANK_SHARE = 0.55;
  // Fewer cells than this and a spread means nothing — a face far from the camera covers a handful.
  const BLANK_MIN_CELLS = 6;
  // Standard deviation of the grid over a rectangle of cells. Two passes' worth of arithmetic in
  // one, which matters only because this runs beside the cascade.
  function cellSd(r) {
    if (!r || !moHave || !moNow) return -1;
    let n = 0, sum = 0, sum2 = 0;
    for (let y = r.r0; y <= r.r1; y++) {
      for (let x = r.c0; x <= r.c1; x++) {
        const v = moNow[y * MO_COLS + x];
        sum += v; sum2 += v * v; n++;
      }
    }
    if (n < BLANK_MIN_CELLS) return -1;
    const mean = sum / n;
    return Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  }
  // The face box, in grid cells. Clamped to the grid rather than refused when it runs off the edge:
  // a face at the edge of frame is still a face, and the part of it that IS in shot is what we can
  // measure.
  function boxCells(w, h, box) {
    if (!box || !(w > 0) || !(h > 0) || !(box.size > 0)) return null;
    const half = box.size / 2;
    const c0 = Math.max(0, Math.min(MO_COLS - 1, Math.floor((box.col - half) / w * MO_COLS)));
    const c1 = Math.max(0, Math.min(MO_COLS - 1, Math.floor((box.col + half) / w * MO_COLS)));
    const r0 = Math.max(0, Math.min(MO_ROWS - 1, Math.floor((box.row - half) / h * MO_ROWS)));
    const r1 = Math.max(0, Math.min(MO_ROWS - 1, Math.floor((box.row + half) / h * MO_ROWS)));
    if (c1 < c0 || r1 < r0) return null;
    return { c0, c1, r0, r1 };
  }
  // Is the place your face was now featureless?
  function blankOverFace() {
    if (!faceCells || !(faceSd > 0)) return false;   // nothing measured to compare against
    const sd = cellSd(faceCells);
    if (sd < 0) return false;                        // not measurable, so no claim
    return sd < faceSd * BLANK_SHARE;
  }
  // Photographed at the moment a real face was in frame. Not on every frame: the point of the
  // reference is that it holds the scene WITH you in it, and refreshing it from faceless frames
  // would let it drift, one frame at a time, into a picture of the room without you — which is
  // the exact mistake the lastFaceAt bug made one layer up.
  function noteFaceScene(w, h, box) {
    if (!moHave || !moNow) return;
    const cells = moNow.length;
    if (!faceGrid) faceGrid = new Float32Array(cells);
    faceGrid.set(moNow);
    faceSceneAt = 1;   // a flag, not a time: nothing here cares HOW old the reference is
    goneHits = 0;
    // And where the face was, with how much detail was in it — for blankOverFace. Taken here rather
    // than measured later because "how structured is a face" can only be answered while one is
    // actually in front of the camera.
    const r = boxCells(w, h, box);
    if (r) {
      const sd = cellSd(r);
      // Only kept if it is measurable AND actually structured. A reading of nearly zero would make
      // the comparison below meaningless — everything is under half of nothing.
      if (sd > 2) { faceCells = r; faceSd = sd; }
    }
  }
  // How much of the picture no longer looks like it did when your face was last in it, 0..1.
  // Mean-subtracted, for the same reason as everywhere else in this file: a webcam that lifts
  // its gain when you leave its brightest object behind changes every cell at once, and read
  // literally that is a whole new room rather than the same room a little brighter.
  function sceneChangedSinceFace() {
    if (!faceSceneAt || !faceGrid || !moHave) return 0;
    const cells = faceGrid.length;
    let mean = 0;
    for (let i = 0; i < cells; i++) mean += moNow[i] - faceGrid[i];
    mean /= cells;
    let n = 0;
    for (let i = 0; i < cells; i++) if (Math.abs(moNow[i] - faceGrid[i] - mean) > BG_CELL) n++;
    return n / cells;
  }
  // true = the picture says you are not where you were. Kept as a counter rather than a single
  // reading so GONE_HITS can mean what it says.
  function gone(now) {
    if (!faceSceneAt) return false;
    if (sceneChangedSinceFace() >= GONE_FRAC) goneHits++;
    else goneHits = 0;
    return goneHits >= GONE_HITS;
  }

  // true = something substantial is in front of the camera, false = it looks like the empty
  // room, null = we have never seen the room empty and genuinely do not know. The three
  // answers are kept apart on purpose: "don't know" must not be read as "empty".
  function occupied() {
    if (!bgAt || !bgGrid || !moHave) return null;
    const cells = bgGrid.length;
    // Same reasoning as the movement check, and it matters more here. A camera that lifts
    // its gain after you walk out of shot would otherwise read as a whole new scene — which
    // is to say as a body — and at the bottom of the dial that would hold the clock open on
    // an empty chair. Taking the frame-wide part out leaves only the shape of what's blocking
    // the view, and a person blocks part of the picture rather than all of it evenly.
    let mean = 0;
    for (let i = 0; i < cells; i++) mean += moNow[i] - bgGrid[i];
    mean /= cells;
    let n = 0;
    for (let i = 0; i < cells; i++) if (Math.abs(moNow[i] - bgGrid[i] - mean) > BG_CELL) n++;
    return n / cells >= BG_FRAC;
  }

  // ---------------- is that candidate actually a face? ----------------
  // A verifier in front of the detector, which is how every serious face pipeline is built: a cheap
  // detector proposes boxes, and something else confirms them. pico is only the proposer here, and
  // on its own it is not a high enough bar — it is a decision tree over pairs of pixel brightnesses,
  // trained on faces, and a large smooth object can walk a path through it by accident.
  //
  // The case that forced this: a lamp shade held up. Reported three times, and each fix was aimed at
  // the wrong layer. The presence ladder was made stricter, then a texture test was added AFTER the
  // detectors — and a detection still came back saying "face", refreshed the last-seen time, and
  // overwrote the very reference that test compares against. A veto downstream of a detector that
  // says yes cannot help; the detector has to stop saying yes.
  //
  // Two measurements, both inside the box, both cheap:
  //
  //   contrast  A face is the most structured thing in a normal frame — brows, eye sockets, nostrils,
  //             lips, all within a few dozen pixels. Its internal spread of brightness is large. A
  //             lamp shade, a sheet of card, a palm, a cushion: one tone and a gentle gradient. This
  //             is the test that does the work, and the two are not close: a face here measures
  //             thirty to sixty grey levels, a flat object under ten.
  //
  //   eye band  For a face the right way up, the band across the eyes and brows is darker than the
  //             band across the cheeks and mouth. Sockets are in shadow and lashes and brows are
  //             dark; cheeks catch the light. It is a weaker signal than contrast and it depends on
  //             the lighting, so it is asked only of the ROTATED pass — see findTilted for why that
  //             one needs a second opinion.
  //
  // The central portion is sampled, not the whole box. pico's box is generous and includes hair,
  // ears and background at the corners, and background is exactly what must not be allowed to supply
  // the contrast that makes a flat object look structured.
  const FACE_SD_MIN = 12;        // grey levels of internal spread. A face has far more; see above.
  const FACE_EYE_DROP = 1.5;     // and the eye band this much darker, for a rotated find
  const FACE_MIN_SAMPLES = 24;   // fewer than this and a spread means nothing
  function faceCheck(gray, w, h, row, col, size) {
    const none = { ok: false, sd: 0, eyeDrop: 0 };
    if (!gray || !(size > 0)) return none;
    // 0.34, so the sampled square is about two thirds of the box's width — the part that is
    // reliably face rather than whatever is behind the head.
    const half = size * 0.34;
    const x0 = Math.max(0, Math.round(col - half)), x1 = Math.min(w - 1, Math.round(col + half));
    const y0 = Math.max(0, Math.round(row - half)), y1 = Math.min(h - 1, Math.round(row + half));
    if (x1 - x0 < 6 || y1 - y0 < 6) return none;
    // Subsampled to about 16 across. This runs on every accepted candidate, several times a second,
    // beside the cascade itself — and a spread does not need every pixel to be measured.
    const step = Math.max(1, Math.floor((x1 - x0) / 16));
    // The split between the two bands. 0.42 rather than a third: pico centres its box on the whole
    // face, so the eyes sit a little above the middle of it.
    const mid = y0 + (y1 - y0) * 0.42;
    let n = 0, sum = 0, sum2 = 0, nU = 0, sU = 0, nL = 0, sL = 0;
    for (let y = y0; y <= y1; y += step) {
      const off = y * w;
      for (let x = x0; x <= x1; x += step) {
        const v = gray[off + x];
        sum += v; sum2 += v * v; n++;
        if (y < mid) { sU += v; nU++; } else { sL += v; nL++; }
      }
    }
    if (n < FACE_MIN_SAMPLES) return none;
    const mean = sum / n;
    const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
    // Positive when the upper band is the darker one, which is the way round a face is.
    const eyeDrop = (nU > 0 && nL > 0) ? (sL / nL) - (sU / nU) : 0;
    return { sd, eyeDrop, ok: sd >= FACE_SD_MIN };
  }

  // ---------------- the tilted-head pass ----------------
  // Its own canvas, at its own size. Square, because a rotated rectangle needs the diagonal
  // to keep its corners, and a corner is exactly where a leaning head ends up.
  const rcanvas = document.createElement("canvas");
  const rctx = rcanvas.getContext("2d", { willReadFrequently: true });
  // Each angle costs a fresh getImageData and a fresh cascade run, so the copy is shrunk
  // first. Eight angles at full resolution would be eight times the most expensive thing on
  // the page; at this width they come to roughly one upright pass between them.
  //
  // The shrink does not make the smallest findable face any bigger: minsize below is scaled
  // by the same factor, so a tilted face has to be the same number of real pixels across as
  // an upright one. The floor is there only for cameras small enough that the arithmetic
  // would otherwise ask the cascade for a window narrower than it can score.
  const TILT_SIDE_MAX = 256;
  // What a rotated find has to score, as a share of the sensitivity bar — and the number that
  // was wrong. This was 0.7, which sounded like a discount and was in fact an impossible demand.
  //
  // QUAL_BY_SENS is calibrated against pico's FIVE-FRAME memory: cluster_detections adds up the
  // scores of every window it merges, so the bar is a sum over five frames, and one frame from a
  // face that only just clears your setting contributes about a fifth of it. The file says so
  // itself, next to RAW_SEEN_SHARE, which is derived from MEM_FRAMES for exactly this reason.
  //
  // The rotated pass has no memory. It gets one frame. So 0.7 of a five-frame bar was asking a
  // single rotated frame for around three and a half times what a single upright frame produces.
  // At easy that meant a score over 18 where a real face gives five or ten — so the pass ran
  // several cascades a second, all session, and essentially never returned anything. Reported as
  // "I tilt my head right over and even on easy it doesn't see me", and the setting had nothing
  // to do with it: no angle at any setting could have cleared that.
  //
  // Written as a share of MEM_FRAMES so it cannot drift away from the thing it is measured
  // against again. Slightly above one frame's honest share (1.0/MEM_FRAMES), because a rotated
  // hit has no memory behind it to corroborate it and each extra angle is another chance for a
  // pattern in the room to score once — but in the same order of magnitude, which 0.7 was not.
  const TILT_BAR_SHARE = 1.2 / MEM_FRAMES;
  // Keep re-checking the angles for this long after the last face even in a still frame,
  // or the motion gate below would drop a tilted head that then sits perfectly still. A
  // successful tilted find refreshes it, so a leaning head goes on being found.
  const TILT_RECENT_MS = 20000;
  // And how fresh movement has to be to bother looking at all. This is what keeps an empty
  // room cheap: nothing moving, nobody seen lately, no rotated passes.
  const TILT_MOVE_MS = 4000;
  // The upright pass runs as often as the machine allows, but this one must not: it is
  // several cascade runs, and it happens on exactly the frames where nothing else found a
  // face, which is a whole second of them if you are simply reading with your head over.
  // So it is searched a few times a second and the answer stands between searches — a hold
  // just long enough to bridge the gap, not long enough to outlive a head that left.
  const TILT_EVERY_MS = 200;
  const TILT_HOLD_MS = 600;
  let tiltTryAt = 0, tiltAt = 0, tiltBox = null;

  // Searches the frame already sitting in `canvas` at each configured angle, nearest
  // upright first, stopping at the first believable hit. Returns the box in ordinary
  // full-frame coordinates, so nothing downstream has to know a rotation happened.
  function findTilted(w, h, bar) {
    const rolls = looseCfg().rolls;
    if (!rolls.length || !classify) return null;
    const scale = Math.min(1, TILT_SIDE_MAX / Math.max(w, h));
    const rw = Math.max(48, Math.round(w * scale)), rh = Math.max(48, Math.round(h * scale));
    const side = Math.ceil(Math.hypot(rw, rh));
    if (rcanvas.width !== side || rcanvas.height !== side) { rcanvas.width = side; rcanvas.height = side; }
    const inv = w / rw;                     // rotated-canvas pixels back to frame pixels
    const params = {
      shiftfactor: detectParams.shiftfactor,
      minsize: Math.max(32, Math.round(detectParams.minsize / inv)),
      maxsize: side,
      scalefactor: detectParams.scalefactor
    };
    for (let i = 0; i < rolls.length; i++) {
      for (let dir = -1; dir <= 1; dir += 2) {
        const rad = rolls[i] * dir * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        rctx.setTransform(1, 0, 0, 1, 0, 0);
        // Painted black rather than cleared: transparent corners come back as zero alpha,
        // and the grey conversion would hand the cascade a hard edge to chew on.
        rctx.fillStyle = "#000";
        rctx.fillRect(0, 0, side, side);
        rctx.translate(side / 2, side / 2);
        rctx.rotate(-rad);
        rctx.drawImage(canvas, -rw / 2, -rh / 2, rw, rh);
        rctx.setTransform(1, 0, 0, 1, 0, 0);
        const gray = rgbaToGrayscale(rctx.getImageData(0, 0, side, side).data, side, side);
        const dets = pico.cluster_detections(
          pico.run_cascade({ pixels: gray, nrows: side, ncols: side, ldim: side }, classify, params), 0.2);
        let best = 0, br = 0, bc = 0, bs = 0;
        for (let k = 0; k < dets.length; k++) {
          if (dets[k][3] > best) { best = dets[k][3]; br = dets[k][0]; bc = dets[k][1]; bs = dets[k][2]; }
        }
        if (best <= bar * TILT_BAR_SHARE) continue;
        // Scored well enough — now prove it is a face.
        //
        // This pass is where a false positive is most likely, by construction: ten rotations of the
        // frame, several times a second, each one an independent chance for something to walk a path
        // through the tree, and one frame's score behind it with no memory to corroborate. The
        // upright pass gets five frames of agreement; this gets one.
        //
        // So it is asked for both measurements, not just contrast. The frame in front of the cascade
        // here has been turned so that a leaning head is upright in it — which means the eye band is
        // horizontal in these coordinates and the band test is asked in the one place it is valid.
        const q = faceCheck(gray, side, side, br, bc, bs);
        if (!q.ok || q.eyeDrop < FACE_EYE_DROP) continue;
        // Undo the rotation for the centre point: the draw turned the frame by -rad about
        // the canvas centre, so turning this offset by +rad puts it back on the frame.
        const ux = bc - side / 2, uy = br - side / 2;
        const col = (ux * cos - uy * sin + rw / 2) * inv;
        const row = (ux * sin + uy * cos + rh / 2) * inv;
        // A hit whose centre lands outside the picture is the cascade finding a face in the
        // black padding, which is not a face.
        if (col < 0 || col > w || row < 0 || row > h) continue;
        return { row, col, size: bs * inv, score: best, roll: rolls[i] * dir };
      }
    }
    return null;
  }

  // No upright face. Walk down the rungs the dial has unlocked, strongest evidence first,
  // and return the first that holds. At strict it unlocks nothing and this returns null on
  // the first line, which is the old behaviour exactly.
  function looseSeen(w, h, bar, now) {
    const cfg = looseCfg();

    // Rung 1: a tilted head. Still a real face, found by looking at the frame sideways.
    if (cfg.rolls.length &&
        (movingRecently(now, TILT_MOVE_MS) || (lastFaceAt && now - lastFaceAt <= TILT_RECENT_MS))) {
      if (now - tiltTryAt >= TILT_EVERY_MS) {
        tiltTryAt = now;
        // A failed search clears the hold at once. Only a hit is allowed to stand, and only
        // until the next search comes round.
        tiltBox = findTilted(w, h, bar);
        tiltAt = tiltBox ? now : 0;
      }
      if (tiltAt && now - tiltAt <= TILT_HOLD_MS) return { kind: "tilt", box: tiltBox };
    }

    // Everything below is presence without a face, so it can only ever extend a sighting
    // that actually happened. Nothing here can start the clock on its own.
    if (!lastFaceAt) return null;
    // And if we know what the room looks like empty, and this is it, then it is. That beats
    // every rung below — a draught moving a curtain is not somebody working.
    if (occupied() === false) return null;
    // The picture no longer holds what it held when your face was last in it. Whatever posture
    // the dial has been told to forgive, this is not a posture — it is an absence, and it is
    // checked at every setting including easy for that reason. The dial decides how much
    // evidence of you is enough; it does not get to decide that no evidence is enough.
    //
    // This is what makes leaving the chair register at once instead of being served out as a
    // grace period. Before it, every rung below was reasoning from "something is moving" or
    // "nothing is moving", and an empty room can do either.
    if (gone(now)) return null;
    // And whatever is where your face was, it has no detail in it — so it is not your face, and it
    // is not a posture either. A lamp shade held up, a sheet of card, a palm over the lens: all of
    // them are large, flat and bright, and to every rung below this they looked like "no face, but
    // the picture is changing", which is the head-down rung's entire evidence. See blankOverFace.
    if (blankOverFace()) return null;
    // One ceiling, checked once, covering every rung below.
    //
    // It was written into rung 2 alone, so rung 3 — the one that asks for no movement at all —
    // had no limit of any kind at kind and easy, and neither rung had one at those settings
    // anyway because the table set anchor to 0 there. "No ceiling" reads as generous and is
    // actually the worst failure this feature has: a guess that nobody ever revisits. Leave the
    // desk at kind, and the clock counted a whole evening of an empty chair as study.
    //
    // So no faceless rung is unbounded now, at any setting. What the dial changes is how long
    // you may go without showing your face — from two minutes at normal to half an hour at easy
    // — not whether you ever have to. Every rung here is inference; a ceiling is what keeps an
    // inference from becoming a permanent claim. And it is cheap to satisfy: a single glance up
    // at the screen is a real face, and the ceiling starts again.
    if (cfg.anchor && now - lastFaceAt > cfg.anchor) return null;

    // Rung 2: head down over the desk. No face at any angle, so the evidence is a picture
    // that is still changing — writing, turning a page, shifting in the chair.
    if (cfg.down && movingRecently(now, cfg.down)) {
      return { kind: "down", box: null };
    }

    // Rung 3: just being there, in any posture, moving or not. Carried by the empty-room
    // comparison where we have one; where we don't, by patience — a picture that has not
    // changed in this long is a room, not a person.
    if (cfg.body && (occupied() === true || stillFor(now) <= cfg.body)) {
      return { kind: "body", box: null };
    }
    return null;
  }
  // Movement this fresh stands in for the head-movement check while no face angle is
  // readable. It is the same question that check asks — person or photograph — answered
  // from the whole picture instead of from a box we haven't got.
  const LOOSE_MOVE_MS = 2500;

  // How often we're willing to look, decided from how long a look actually costs here.
  //
  // A fixed gap is either too slow or too greedy, because the cost depends on the camera's
  // resolution and the machine: the same 70ms was leaving a fast laptop idle between
  // frames while being most of the budget on a slow one. The real floor is the camera —
  // a frame every 33ms at 30fps, and nothing can know your face has gone before a frame
  // shows it gone — so the aim is to get down to that floor wherever the machine allows
  // it, and to back off on its own where it doesn't.
  //
  // Held at about a third of one core: look no more often than three times what a look
  // costs. The camera window runs beside Anki, and a face check that makes typing stutter
  // has cost more than it gained.
  const DETECT_GAP_MIN_MS = 25;       // ~40 looks a second: past the camera, no point going lower
  const DETECT_GAP_MAX_MS = 120;      // a slow machine still gets a usable answer
  const DETECT_DUTY = 3;
  let detectCostMs = 20;              // seeded pessimistically; the first real look corrects it
  let detectGapMs = 70;
  function noteDetectCost(ms) {
    // Smoothed, so one slow frame — a garbage-collection pause, a busy moment — doesn't
    // halve the rate for the rest of the session.
    detectCostMs = detectCostMs * 0.8 + ms * 0.2;
    detectGapMs = Math.max(DETECT_GAP_MIN_MS,
                           Math.min(DETECT_GAP_MAX_MS, Math.round(detectCostMs * DETECT_DUTY)));
  }

  // MEM_FRAMES is declared up beside QUAL_BY_SENS, which is the number it calibrates.
  // What a single frame must show to count as "still something there". A fraction of the
  // average contribution, not the average itself: a face that only just clears your
  // sensitivity setting contributes about a fifth of the bar per frame, and demanding
  // exactly that would keep dropping people who are only just over the line. An empty
  // frame scores exactly 0 — run_cascade only keeps windows it scored above zero — so
  // what this really separates is "something is there" from "nothing at all".
  const RAW_SEEN_SHARE = 0.5 / MEM_FRAMES;
  // Consecutive empty frames before we say you've gone. One is a dropped frame: a blink,
  // a head turn, a bad exposure. Two is you.
  const RAW_MISS_LIMIT = 2;
  let rawMisses = RAW_MISS_LIMIT;      // "gone" until a frame says otherwise

  // Separate from lastDetectAt: this one only says "we TRIED", and it drives the
  // throttle. lastDetectAt means "we SUCCEEDED", and only that counts as the
  // detector being alive.
  let lastTryAt = 0;

  function detectOnce() {
    const now = Date.now();
    if (!ready || detecting || now - lastTryAt < detectGapMs) return;
    lastTryAt = now;
    detecting = true;
    // Only a look that reached the cascade counts towards the cost. The early returns
    // below are free, and letting them into the average would drive the gap to its floor
    // and then spin there doing nothing.
    let classified = 0;
    try {
      // A paused or stalled video still draws — drawImage happily hands back the
      // last frame it had. The cascade then succeeds on that frozen picture, the
      // freshness stamp refreshes, and presence stays true off a still image. So
      // the video has to actually be playing before any of this means anything.
      // (Moving the element into the floating window is one way it can end up
      // paused, and the fallback timer would then classify a photograph of you.)
      if (v.paused || v.ended || v.readyState < 2) {
        try { v.play(); } catch (e) {}
        return;
      }
      const w = v.videoWidth || 320, h = v.videoHeight || 240;
      if (!w || !h) return;
      canvas.width = w; canvas.height = h;
      ctx.drawImage(v, 0, 0, w, h);
      const rgba = ctx.getImageData(0, 0, w, h).data;
      const image = { pixels: rgbaToGrayscale(rgba, h, w), nrows: h, ncols: w, ldim: w };
      // Every frame, whether or not a face turns up in it. The moment a face IS lost is the
      // moment "was anything moving just now" has to already be answered — working it out
      // only once needed would compare the first faceless frame against nothing.
      noteMotion(image.pixels, w, h, now);
      classified = performance.now();
      const raw = pico.run_cascade(image, classify, detectParams);
      // This frame on its own, before the five-frame memory is folded in. Clustered on a
      // copy, because cluster_detections sorts what it is given and the memory is holding
      // that same array.
      let rawBest = 0;
      const solo = pico.cluster_detections(raw.slice(), 0.2);
      for (let i = 0; i < solo.length; i++) if (solo[i][3] > rawBest) rawBest = solo[i][3];

      let dets = pico.cluster_detections(updateMemory(raw), 0.2);
      let best = 0, bestCol = w / 2, bestRow = h / 2, bestSize = 0;
      for (let i = 0; i < dets.length; i++) {
        if (dets[i][3] > best) { best = dets[i][3]; bestRow = dets[i][0]; bestCol = dets[i][1]; bestSize = dets[i][2]; }
      }
      // Past this point a frame really has been read and classified, so the
      // detector is provably alive. Anything above here can still have failed.
      //
      // frameSeenAt is deliberately NOT touched here — only the real frame
      // callback sets it. Setting it from a timer-driven detection made the
      // watchdog mistake its own timer for a live frame driver and shut the timer
      // off, so detection ran for two seconds, stopped for two to four, and
      // limped along like that.
      lastDetectAt = now;
      const bar = qualBar();
      rawMisses = rawBest > bar * RAW_SEEN_SHARE ? 0 : rawMisses + 1;

      // Two questions, deliberately answered differently.
      //
      // Are you there? Still the calibrated five-frame score, so nothing is easier to
      // fool than it was — plus a shortcut for a frame that clears the whole bar on its
      // own, which is MORE evidence than the smoothed test asks for and so can be
      // believed at once. That shortcut is most of the delay on the way back gone.
      //
      // Have you gone? The current frame, not the memory. pico's memory holds up to four
      // frames of you after you have actually left, and waiting for that to drain was
      // most of the second it took for the clock to stop and the red edge to appear.
      // And whatever score it came back with, the box has to look like a face.
      //
      // Contrast only, for this one. The band test is a lighting assumption and this path already has
      // five frames of agreement behind it, so the cheap certain half is enough here and the fussy
      // half is left to the rotated pass, which has neither. A false negative here stops your clock
      // while you are sitting in front of it, which is the expensive way to be wrong.
      const upright = faceCheck(image.pixels, w, h, bestRow, bestCol, bestSize);
      const seen = (best > bar || rawBest > bar) && rawMisses < RAW_MISS_LIMIT && upright.ok;
      // Only asked when the upright answer is no, so on a normal frame this costs nothing,
      // and at sensitivity 1–3 it is not asked at all.
      const loose = seen ? null : looseSeen(w, h, bar, now);
      // A real face, so this frame is what "you, in your chair" looks like. Photographed here so
      // the faceless rungs below have something honest to be measured against — see gone() — along
      // with where the face was and how much detail was in it, for blankOverFace().
      if (seen) { lastFaceAt = now; noteFaceScene(w, h, { row: bestRow, col: bestCol, size: bestSize }); }
      if (!seen && !loose) {
        // Measure afresh when you come back. The jump between where your face was and
        // wherever it reappears is not movement you made — and crediting it would hand out
        // a free pass for covering the lens and uncovering it, which is the one thing a
        // photograph can also do.
        liveness.seeded = false;
        // Nothing can be judged about eyes or blinks with no face to read them from, so those
        // two deadlines start again from when you come back rather than counting your absence
        // against you. The clock is already stopped by the missing face.
        watchFresh(eyeWatch);
        watchFresh(blinkWatch);
        eyeWasOpen = true;
        eyeClosedAt = 0;
        // Learned for the face that just left. Whoever comes back — or the same person under a
        // different lamp — gets measured afresh rather than against someone else's eyes.
        blinkBase = 0;
        // faceNow before resetPace, because resetPace repaints the badge and the badge asks
        // facePresent() whether to show itself at all. Repainting it while faceNow still said true
        // would flash "1.0×" for a frame on a clock that has just stopped.
        faceNow = false;
        resetPace();
        clearOverlay();
        setCam("no face", "bad"); return;
      }
      if (loose) {
        // You are here, but not at an angle anything below this line can read. The eye and
        // blink checks need pupils in a known place and get neither from a head on its side
        // nor from a scalp, so they are held fresh rather than failed — failing them would
        // stop the clock for exactly the posture this branch exists to allow.
        rawMisses = 0;
        // ONLY a tilted find refreshes this, and the distinction is the whole reason the faceless
        // rungs are safe. A tilt is a real face: the cascade scored it, just with the frame turned.
        // "Head down" and "you're there" are not faces at all — they are guesses that lean on a
        // face having been seen recently.
        //
        // This line used to refresh it for all three, and that quietly disabled every limit built
        // on top of it. The rungs are ceilinged at `now - lastFaceAt` (see looseSeen) and the
        // empty-room reference is only learned after a stretch with no face (see noteMotion) — so
        // stamping it here meant the head-down rung renewed its own ceiling on every frame it
        // passed, and the reference that was supposed to overrule it could never be learned,
        // because the code was being told a face had just been seen. An empty room with anything
        // moving in it — a curtain, a fan, a webcam's own grain in low light — held the clock open
        // indefinitely. Reported as "there is nobody in the picture and the timer will not stop",
        // and that is exactly what it was.
        if (loose.kind === "tilt") { lastFaceAt = now; noteFaceScene(w, h, loose.box); }
        // The slow speed, for all three rungs, and null rather than loose.box even when there is one.
        // Deliberate: this branch is reached precisely because you are NOT squarely in front of the
        // lens — a head on its side, a scalp over a notebook, a shape in the chair — and those are the
        // postures the slow end of the slider was written for. Handing a tilted head's box to the
        // coverage test would let a big enough tilted face earn the fast speed, which is the opposite
        // of what the feature promises. Done here, above every exit from this branch, so no rung can
        // leave the multiplier standing at whatever it was before you leaned away.
        if (paceOn) notePace(w, h, null);
        watchFresh(eyeWatch);
        watchFresh(blinkWatch);
        eyeWasOpen = true;
        eyeClosedAt = 0;
        // The box, when there is one, comes off a shrunk and rotated copy, so its numbers
        // aren't comparable with the upright ones the movement check has been collecting.
        // Measure afresh from the next upright frame instead of reading a rotation as travel.
        liveness.seeded = false;
        if (liveness.enabled) {
          // Same question, different evidence: a photograph can't make the picture move.
          //
          // The bottom rung is exempt, and has to be. It exists because the dial was set to
          // "however you're sitting, even dead still" — asking for a movement there would
          // take back the one thing that rung grants.
          if (loose.kind === "body" || movingRecently(now, LOOSE_MOVE_MS)) watchBeat(liveness, now);
          else if (watchOverdue(liveness, now)) {
            faceNow = false;
            if (loose.box) drawMarkers(w, h, loose.box, [], "wait"); else clearOverlay();
            setCam("move your head", "wait");
            return;
          }
        }
        if (loose.box) drawMarkers(w, h, loose.box, [], "ok"); else clearOverlay();
        // Worded so it's clear the clock is running and why it looks like it shouldn't be.
        // None of the three says "head" — setCam reads that word as the move-your-head
        // prompt and would swap the tick for an arrow in the small window.
        faceNow = true;
        setCam(loose.kind === "tilt" ? "face ✓ tilted"
             : loose.kind === "down" ? "face ✓ looking down"
             : "you're there ✓", "ok");
        return;
      }
      // Measured once per frame and reused, so the markers can never disagree with
      // the verdict underneath them.
      const faceBox = { row: bestRow, col: bestCol, size: bestSize };
      // Also read when the blink check is on: a blink is measured from the same open/closed
      // signal the eye check uses, so there is nothing extra to compute for it.
      //
      // `paceOn` used to be in this list, because the pace reading was taken from the pupils this
      // finds. The focus box is measured from the face square instead, which this frame already has,
      // so the most expensive optional thing in the loop is no longer run for the pace feature at all.
      const eyeRead = (overlayOn || eyeRequired || blinkRequired)
        ? analyseEyes(image.pixels, w, h, bestRow, bestCol, bestSize)
        : { ok: true, open: true, centred: true, eyes: [] };
      if (blinkRequired || eyeRequired) noteBlink(eyeRead, now);
      // Before the checks below, all of which can return early. The multiplier has to reflect this
      // frame whatever else this frame decides — and the drawing further down reads focusIn for the
      // box's colour, so it has to be settled first.
      if (paceOn) notePace(w, h, faceBox);

      // Liveness: are you a person, or a photograph propped in front of the lens? Watched
      // continuously rather than asked about — see the note on `liveness`.
      if (liveness.enabled) {
        if (!liveness.seeded) seedMovement(bestCol, bestRow, bestSize);
        noteMovement(bestCol, bestRow, bestSize, w, h, now);
        if (movedBy(w, h) >= moveNeeded()) {
          // Moved. The deadline slides forward and measurement restarts from here, so the
          // same movement can't be counted twice.
          watchBeat(liveness, now);
          seedMovement(bestCol, bestRow, bestSize);
        } else if (watchOverdue(liveness, now)) {
          faceNow = false;
          drawMarkers(w, h, faceBox, eyeRead.eyes, "wait");
          setCam("move your head", "wait");
          return;
        }
      }
      // Eyes open and pointed at the screen — on the same sliding deadline as the rest. Every
      // frame where they are counts, so a glance away, a blink, or a look down at your keyboard
      // costs nothing; only a whole interval of not looking at the screen stops the clock.
      //
      // This replaced a fixed grace of a few seconds tied to the sensitivity dial. The rule is
      // now the same one the other two checks use, and the time is yours to set.
      if (eyeRequired) {
        if (eyeRead.ok) watchBeat(eyeWatch, now);
        if (watchOverdue(eyeWatch, now)) {
          faceNow = false;
          drawMarkers(w, h, faceBox, eyeRead.eyes, "bad");
          setCam(eyeRead.open ? "look at the screen" : "eyes closed", "bad");
          return;
        }
      }

      // Blink at least once an interval.
      if (blinkRequired && watchOverdue(blinkWatch, now)) {
        faceNow = false;
        drawMarkers(w, h, faceBox, eyeRead.eyes, "wait");
        setCam("blink", "wait");
        return;
      }

      drawMarkers(w, h, faceBox, eyeRead.eyes, "ok");
      faceNow = true; setCam("face ✓", "ok");
    } catch (e) {
      // A throw must never leave a stale "face present" standing. The timestamp
      // used to be stamped before the work, so anything that threw every frame —
      // a bad frame through the cascade, a failed getImageData — kept refreshing
      // the freshness stamp while faceNow held its last value, and presence went
      // on being reported as true indefinitely. The last hole of that kind.
      faceNow = false;
      setCam("camera trouble", "bad");
    } finally {
      detecting = false;
      if (classified) noteDetectCost(performance.now() - classified);
      // One place for the beep, so every way out of the detector above (no face,
      // eyes away, liveness prompt, all clear) is covered.
      if (ready) noteSeen(facePresent());
      // And one place for the badge, for the same reason. notePace repaints it too, but it runs BEFORE
      // faceNow is settled for this frame — and the badge hides itself when no face is present — so on
      // the frame you are first seen again it would paint itself hidden and stay that way until the
      // next frame. Repainting here, after every branch has had its say, costs one guarded call.
      paintPaceTag();
      // Report from inside the loop as well. While you're in Anki this tab is in
      // the background and Chrome slows its timers right down; the camera's own
      // frame callbacks keep coming, so the face heartbeat and the floating
      // window's clock stay alive.
      maybeSendFace();
      maybeRefresh();
    }
  }

  // Driven by real video frames where available (immune to background-tab timer
  // throttling), with a timer as the fallback.
  //
  // The fallback used to start unconditionally, so on every normal browser BOTH
  // drivers ran and detectOnce was called at roughly twice the intended rate —
  // double the camera work, for nothing. Now the timer only starts if the frame
  // callback isn't there or stops working.
  function startDetectTimer() {
    if (detectTimer) return;
    // Ticks at the fastest rate the gap could ever allow; detectOnce turns away anything
    // that arrives sooner than the gap it has settled on, so the timer inherits the same
    // self-tuning instead of needing its own.
    detectTimer = setInterval(detectOnce, DETECT_GAP_MIN_MS);
  }
  function stopDetectTimer() {
    if (!detectTimer) return;
    clearInterval(detectTimer);
    detectTimer = 0;
  }
  function scheduleDetection() {
    if (typeof v.requestVideoFrameCallback === "function") {
      const onFrame = () => {
        frameCbId = 0;
        frameSeenAt = Date.now();
        detectOnce();
        try { frameCbId = v.requestVideoFrameCallback(onFrame); } catch (e) { startDetectTimer(); }
      };
      try { frameCbId = v.requestVideoFrameCallback(onFrame); frameDriver = true; return; }
      catch (e) { /* fall through to the timer */ }
    }
    startDetectTimer();
  }

  // ---------------- heartbeats + UI ----------------
  //
  // faceNow on its own is NOT safe to report. It is only ever written inside
  // detectOnce(), so if the detector stops running it keeps its last value — and
  // the heartbeat below would go on insisting "face present" once a second
  // forever, while the background stamps a fresh timestamp on every one of those
  // messages and therefore never sees the reading go stale.
  //
  // That was an open door: start studying until the camera says face ✓, then
  // unplug the webcam (or disable it, or revoke the permission). The track ends,
  // frames stop, detectOnce is never called again, and the clock keeps being
  // credited with nobody in the chair.
  //
  // So presence is only ever reported as true if a detection actually ran just
  // now. If the detector has gone quiet the answer is false, whatever the last
  // frame happened to see.
  const DETECT_STALE_MS = 2500;
  function detectorLive() {
    return ready && lastDetectAt > 0 && (Date.now() - lastDetectAt) <= DETECT_STALE_MS;
  }
  function facePresent() { return !!faceNow && detectorLive(); }

  let lastFaceSentAt = 0, lastFaceSentVal = null, lastBoxSentVal = null;
  function sendFace() {
    const present = facePresent();
    lastFaceSentAt = Date.now();
    lastFaceSentVal = present;
    lastBoxSentVal = focusIn;
    // `at` is when the camera actually LOOKED, not when this message was sent. The
    // background allows a face reading to be 5 seconds old; measuring that from the
    // message meant a detection that was already 2.5s stale (the limit above) bought
    // another 5 — up to 7.5 seconds of "someone is sitting there" after the last
    // frame that contained a face. Same machine, so the two clocks agree.
    try {
      // `pace` rides along with the presence reading rather than being written to storage on its
      // own, so it lands under the same freshness stamp the worker already judges presence by. A
      // reading of its own with its own stamp would be a second thing that can go stale
      // independently, and the worker would have to decide which one to trust.
      //
      // 1 while the switch is off, so nothing downstream has to know whether the feature exists.
      //
      // `boxed` rides along for the same reason, and it is deliberately NOT derivable from `pace`.
      // With the slow slider set to 1× the two speeds are the same number, so the multiplier alone
      // cannot say whether you are in the box — and the amber glow on Anki's window is decided from
      // this. `null` while the feature is off, which is a third answer the glow needs: "no opinion"
      // must not be read as "outside".
      // The callback reads lastError and does nothing else, which is not a formality.
      //
      // This is the busiest message in the extension — four a second for as long as the camera is
      // up — so it is the one most likely to be in flight at a bad moment: the worker restarting,
      // this window closing itself, the extension being reloaded. Every one of those is normal and
      // none of them is worth a word. But an empty `() => {}` does not COUNT as having looked, so
      // Chrome logged each one as "Unchecked runtime.lastError: … the message channel closed before
      // a response was received" against this page. Touching lastError is how you say "I know this
      // can fail and there is nothing to do about it".
      chrome.runtime.sendMessage(
        { type: "ankiFace", present, at: lastDetectAt, pace: paceOn ? paceNow : 1,
          boxed: paceOn ? focusIn : null }, () => void chrome.runtime.lastError);
    } catch (e) {}
  }
  function maybeSendFace() {
    // Losing (or regaining) your face goes out immediately — the throttle is only
    // there to stop identical readings chattering once a quarter second. Waiting up
    // to a second to report it meant the clock could be credited for time after
    // you had already left.
    if (lastFaceSentVal !== facePresent()) return sendFace();
    // Leaving or entering the box is news too, for the same reason: the glow on Anki's window is
    // drawn from it, and a warning that arrives a second after you have drifted out is a warning
    // about a moment that has passed. Only while the feature is on — with it off, focusIn never
    // changes and this costs nothing.
    if (paceOn && lastBoxSentVal !== focusIn) return sendFace();
    if (Date.now() - lastFaceSentAt >= 1000) sendFace();
  }

  // The frame-callback driver can stop without throwing — the video element gets
  // moved into the floating window, the track ends, the tab is discarded. Nothing
  // would then restart it, because the timer fallback is only armed when
  // requestVideoFrameCallback raises. This watchdog notices the silence and starts
  // the timer, so detection recovers by itself.
  //
  // And it hands back afterwards. The first version only ever started the timer, so
  // any 2.5-second gap — a laptop sleeping, the little window being covered — left
  // both drivers running together for the rest of the session, which is the exact
  // double-driving that was fixed earlier. Now the timer is stopped again as soon
  // as real frames come back.
  setInterval(() => {
    if (!ready) return;
    const framesFlowing = frameSeenAt > 0 && (Date.now() - frameSeenAt) <= DETECT_STALE_MS;
    if (framesFlowing && frameDriver) { stopDetectTimer(); return; }
    if (detectorLive()) return;
    startDetectTimer();
    detectOnce();
  }, 2000);

  // The background asks for a fresh reading whenever our heartbeat looks stale
  // (this tab sits in the background while you're in Anki). Messages aren't
  // throttled, so we take a look right now and answer.
  try {
    chrome.runtime.onMessage.addListener((msg, sender, respond) => {
      if (!msg) return;
      // "Are you still alive?" — a page left behind by an extension reload has no
      // script running, so silence is the answer and the window gets cleared.
      if (msg.type === "ping") { respond({ ok: true, mini: MINI }); return true; }
      if (msg.type !== "faceProbe") return;
      lastTryAt = 0;             // bypass the small throttle
      try { detectOnce(); } catch (e) {}
      // facePresent(), not faceNow: if that detectOnce didn't actually manage to
      // look (no frames, no camera) the honest answer is "not present".
      respond({ present: facePresent(), ready: !!ready, at: lastDetectAt });
      return true;
    });
  } catch (e) {}
  // ---------------- finished, but still on screen ----------------
  // Detection stops while the finished panel is up and starts again if you add more time.
  // Idempotent, because renderStatus calls it on every poll.
  //
  // Finishing stops the WORK, not the picture.
  //
  // This used to release the camera outright, and the reasoning went: a webcam still running
  // on a window that is no longer watching you is a worse bargain than the one this extension
  // offers. Sound as far as it goes — but what it actually left on screen was a black
  // rectangle where your face had been, at the exact moment the window is asking whether you
  // want another ten minutes. A dead camera window reads as a broken one, and it is the last
  // thing you see at the end of a session.
  //
  // So the stream stays and the cascade stops. Nothing is being credited now, so there is
  // nothing left for it to decide: no face check, no eye or blink check, no rotated passes, no
  // heartbeat, no CPU. The window becomes a mirror, which costs a video element and nothing
  // else. And the stream is still released the moment the window closes or you dismiss the
  // panel — which is what the original concern was really about.
  function pauseDetection(reason) {
    if (!camStream) return;        // nothing to keep showing; leave the black rectangle alone
    previewOnly = true;
    ready = false;                 // stops detectOnce, the watchdog, and every reading it feeds
    stopDetectTimer();
    if (frameCbId) { try { v.cancelVideoFrameCallback(frameCbId); } catch (e) {} frameCbId = 0; }
    // The one-shot retry armed by a track ending, for the same reason stopCamera clears it.
    // It survived a pause, so a webcam glitch a moment before the goal was met left a timer
    // that called startCamera() three seconds later — restarting the detector on a day that
    // was already finished, with previewOnly still set.
    if (camRetry) { clearTimeout(camRetry); camRetry = 0; }
    frameDriver = false;
    frameSeenAt = 0;
    faceNow = false;
    clearOverlay();
    // The faceless-presence rungs extend a real sighting, and a sighting from before the pause
    // is not one. Same resets as stopCamera, for the same reason.
    lastFaceAt = 0;
    lastMotionAt = 0;
    moHave = false;
    bgAt = 0;
    faceSceneAt = 0;
    faceCells = null;
    faceSd = 0;
    // "idle", not "ok". This is the state where nothing is being judged at all — the picture is a
    // mirror and the detector is stopped — and "ok" wears the same green ✓ as a real sighting.
    //
    // That was read exactly as it looks. Hold anything in front of the camera once the goal is
    // finished and the badge still says ✓, so it appears to be calling a lamp a face. It is not
    // looking at the lamp; it is not looking at anything. One glyph making two different claims is
    // the bug, and the claim it is making here is the one nobody asked it for.
    setCam(reason || "finished", "idle");
    // Say so, rather than leaving the last "yes" standing for the background to keep stamping.
    sendFace();
  }
  // Back to work without asking for the camera again — the stream never went away, so there is
  // no permission prompt, no hardware wake-up and no second of black while it spins up.
  function resumeDetection() {
    if (!camStream || !classify) return false;   // nothing to resume; the caller starts fresh
    try { updateMemory = pico.instantiate_detection_memory(MEM_FRAMES); }
    catch (e) { return false; }
    previewOnly = false;
    // Judged from here on. A five-frame memory carried over the pause would weigh frames from
    // before it, and the three deadlines would arrive already overdue — you were not being
    // asked to blink while the detector was switched off.
    rawMisses = RAW_MISS_LIMIT;
    lastDetectAt = 0;
    liveness.seeded = false;
    watchFresh(liveness);
    watchFresh(eyeWatch);
    watchFresh(blinkWatch);
    ready = true;
    setCam("looking…", "wait");
    scheduleDetection();
    detectOnce();
    return true;
  }
  let doneMode = false;
  function setDoneMode(on) {
    if (on === doneMode) return;
    doneMode = on;
    try {
      if (on) pauseDetection("finished");
      // Resume in place where we can. The fallback is for the case where the stream really is
      // gone — a break released it, the camera was unplugged — and then it has to be asked
      // for properly.
      else if (!resumeDetection() && !ready) startCamera();
    } catch (e) {}
  }
  function addStudyTime(secs) {
    try {
      chrome.runtime.sendMessage({ type: "ankiAddTime", secs }, () => {
        void chrome.runtime.lastError;
        // Straight back to work: the panel goes, the camera comes back, and the clock has a
        // new target. Asked for rather than waited for, so the window doesn't sit there
        // looking finished for another two seconds.
        setDoneMode(false);
        refresh();
      });
    } catch (e) {}
  }
  // The finished controls only exist once you've finished. They live in the finished panel,
  // which is inside the clock strip and therefore on the picture in the floating window — so
  // "in the panel" costs no scrolling here, and it buys them a line of their own.
  // camClose is the little window's own ✕, in the clock strip rather than in this panel — the panel
  // is not drawn in that window at all, so its doneClose is the full tab's and only the full tab's.
  // Both are listed here because both answer to the same moment, and that moment is the whole reason
  // the button is safe to offer: see the note beside it in study.html.
  function showDoneControls(on) {
    for (const id of ["addTime", "doneClose", "camClose"]) {
      const el = $(id);
      if (el) el.hidden = !on;
    }
    if (!on) closeAsk();
  }

  // ---- how much longer, in total ----
  // ＋ asks rather than acts.
  //
  // It used to add five minutes on the spot. Two things were wrong with that. A press that
  // silently rewrites today's goal has no way back — this is the one control in the window that
  // changes the rules you set for yourself, and it sat one mis-click away from the pause button.
  // And five was a guess: it took four presses to mean twenty, and each press had to survive the
  // goal going unmet in between, which needed a grace window that existed for no other reason.
  // Both problems have the same answer. Ask for the number, and there is one press, one decision,
  // and a visible chance to change your mind.
  //
  // The number is the TOTAL for today, not the amount to add, and it is floored at where you
  // already are. That is the whole rule: this field can raise today's target and can never lower
  // it. Editing a total is also the question you have an opinion about — you know you want forty
  // minutes today; you do not know that forty is thirteen more than the clock in front of you.
  const ADD_STEP = 5;       // what the field is pre-filled with, above the floor
  const ASK_MAX = 1440;     // a day. The worker caps at the same figure — see ankiAddTime.
  // Today's goal in seconds, as of the last paint. The floor is computed from this, so it has to
  // be the number the clock beside the button is actually showing rather than anything remembered:
  // a stale value here would let the field "raise" the goal to below itself.
  let lastReqSec = 0;
  let askOpen = false;
  // The lowest total the field will accept: one whole minute above the current goal. Rounded DOWN
  // before adding the minute, so a goal of 20m05s floors at 21 rather than at 21 and a bit — and
  // never at 20, which would be a confirmation that adds nothing.
  function askFloorMin() { return Math.floor(Math.max(0, lastReqSec) / 60) + 1; }
  function paintAsk() {
    const box = $("addAskMin"), ok = $("addAskOk");
    if (!box) return;
    const floor = askFloorMin();
    box.min = String(floor);
    box.max = String(ASK_MAX);
    const v = Math.round(Number(box.value));
    // Disabled rather than clamping as you type: snapping the field under someone's fingers while
    // they are half-way through typing "120" — which passes through "1" and "12" — is the classic
    // way a number input becomes unusable. It is clamped once, on confirm.
    if (ok) ok.disabled = !(Number.isFinite(v) && v >= floor && v <= ASK_MAX);
  }
  // Said on the button, not just in the panel: a control that opens something has to report
  // whether the something is open, or a screen reader gets a press with no consequence.
  function paintAskExpanded() {
    $("addTime")?.setAttribute("aria-expanded", askOpen ? "true" : "false");
  }
  function openAsk() {
    const box = $("addAskMin"), panel = $("addAsk");
    if (!box || !panel) return;
    askOpen = true;
    paintAskExpanded();
    const floor = askFloorMin();
    box.value = String(Math.min(ASK_MAX, Math.max(floor, Math.round(lastReqSec / 60) + ADD_STEP)));
    panel.hidden = false;
    paintAsk();
    // Selected, not just focused, so the first digit you type replaces the suggestion instead of
    // landing in front of it and turning 25 into 325.
    try { box.focus(); box.select(); } catch (e) {}
  }
  function closeAsk() {
    const panel = $("addAsk");
    askOpen = false;
    paintAskExpanded();
    if (panel) panel.hidden = true;
  }
  function commitAsk() {
    const box = $("addAskMin");
    if (!box) return;
    const floor = askFloorMin();
    const want = Math.round(Number(box.value));
    // Refused, not clamped, at BOTH ends. Someone who typed 10 into a field floored at 21 meant
    // something, and quietly giving them 21 is a different answer to the one they asked for.
    //
    // The ceiling was the half of this that was wrong: it clamped with Math.min instead of
    // refusing, so the tick was disabled for a total over the day-long limit while pressing Enter
    // in the same field accepted it and set the goal to the limit. Two paths through one control,
    // giving different answers to the same typed number — and the keyboard one silently rewrote it.
    // The test for "sends nothing past the ceiling" is what found that.
    //
    // Exactly the same condition as paintAsk's, deliberately: the tick being disabled and this
    // returning early have to mean the same thing, or the disabled state is decoration.
    if (!Number.isFinite(want) || want < floor || want > ASK_MAX) {
      paintAsk();
      try { box.focus(); box.select(); } catch (e) {}
      return;
    }
    const secs = want * 60 - Math.max(0, lastReqSec);
    closeAsk();
    if (secs > 0) addStudyTime(secs);
  }

  // ---- the captions under the clock strip ----
  // One band, shared by every control in the strip that has something to say, with the sentence
  // copied out of the hovered button's data-tip. See .barhint in study.html for why it is a band
  // across the strip rather than a bubble hanging off a button, and why it is not a title=.
  function bindTips() {
    const hint = $("sizeHint");
    if (!hint) return;
    const show = (el) => {
      hint.textContent = el.getAttribute("data-tip") || "";
      hint.classList.add("on");
    };
    const hide = () => hint.classList.remove("on");
    for (const el of document.querySelectorAll("#clockbar [data-tip]")) {
      el.addEventListener("mouseenter", () => show(el));
      el.addEventListener("mouseleave", hide);
      // Keyboard focus counts, but only the kind that draws a ring. A plain click also focuses,
      // and leaving the caption up after the button had done its job would have it describing
      // something that already happened.
      el.addEventListener("focus", () => { try { if (el.matches(":focus-visible")) show(el); } catch (e) {} });
      el.addEventListener("blur", hide);
      // A press is an answer, so the caption has served its purpose — and for ＋ the strip is
      // about to say something more interesting than a hint.
      el.addEventListener("click", hide);
    }
  }
  bindTips();

  // ---- pause, from where the clock is ----
  // The same switch the popup's break button uses, so the two can't disagree about whether
  // you're on a break.
  let pausedNow = false;
  function paintPause() {
    const btn = $("pauseBtn");
    if (!btn) return;
    // aria-pressed alone. The glyph is two drawn SVGs inside the button and CSS shows whichever
    // one this state calls for — writing textContent here, which is what it used to do with the
    // ⏸ / ▶ characters, would delete them both on the first paint.
    btn.title = pausedNow ? "Resume the session" : "Pause the session";
    btn.setAttribute("aria-label", btn.title);
    btn.setAttribute("aria-pressed", pausedNow ? "true" : "false");
  }
  $("pauseBtn")?.addEventListener("click", () => {
    const want = !pausedNow;
    pausedNow = want;                     // answers the click now; storage confirms it
    paintPause();
    try { chrome.storage.local.set({ userPaused: want }); } catch (e) {}
  });
  try {
    chrome.storage.local.get(["userPaused"], (r) => {
      pausedNow = !!(r && r.userPaused);
      paintPause();
    });
  } catch (e) {}
  paintPause();

  // ＋ opens the question; a second press closes it again, so the button that put it there can
  // also take it away.
  $("addTime")?.addEventListener("click", () => { if (askOpen) closeAsk(); else openAsk(); });
  $("addAskOk")?.addEventListener("click", commitAsk);
  $("addAskNo")?.addEventListener("click", closeAsk);
  $("addAskMin")?.addEventListener("input", paintAsk);
  $("addAskMin")?.addEventListener("keydown", (e) => {
    // Only from inside the field. Enter anywhere else in this window belongs to whatever has
    // focus, and a confirmation that can be triggered from across the page is the accident this
    // whole change exists to prevent.
    if (e.key === "Enter") { e.preventDefault(); commitAsk(); }
    else if (e.key === "Escape") { e.preventDefault(); closeAsk(); }
  });
  // Escape from anywhere, because a panel you cannot see the ✕ of — the window can be shrunk very
  // small — still has to be closable.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && askOpen) closeAsk();
  });
  // Both ✕s, one handler. doneClose is the finished panel's, which only the full study tab draws;
  // camClose is the little window's, in the clock strip. They mean the same thing and must not be
  // able to mean two things, so neither gets its own copy of this.
  const askDoneClose = () => {
    // The worker closes the window, because it owns it — and it also has to write down that
    // you asked, or its next poll would open a new one three seconds later. In the full
    // study tab there is no window to close, so the panel simply stays as it is.
    try { chrome.runtime.sendMessage({ type: "camDoneClose" }, () => void chrome.runtime.lastError); } catch (e) {}
    if (!MINI) { try { stopCamera(); } catch (e) {} }
  };
  $("doneClose")?.addEventListener("click", askDoneClose);
  $("camClose")?.addEventListener("click", askDoneClose);

  let lastRefreshAt = 0;
  function maybeRefresh() {
    if (Date.now() - lastRefreshAt >= 2000) refresh();
  }
  function refresh() {
    lastRefreshAt = Date.now();
    try {
      chrome.runtime.sendMessage({ type: "ankiPoll" }, (r) => {
        // Same reason as the face heartbeat above: a poll can be in flight when the worker sleeps or
        // this window closes, and a callback that never touches lastError turns that into a console
        // error. renderStatus already bails on a missing status, so there is nothing else to do.
        void chrome.runtime.lastError;
        const st = r && r.status;
        chrome.storage.local.get(["ankiFaceRequired"], (cfg) => {
          renderStatus(st, cfg && cfg.ankiFaceRequired);
        });
      });
    } catch (e) {}
  }
  function renderStatus(st, faceRequired) {
    if (!st) return;
    const spent = Math.min(st.required || 0, st.spent || 0);
    const req = st.required || 0;
    // The floor under the "how long in total?" field, kept in step with the clock rather than
    // remembered from when the panel opened. It is the difference between "you can only go up" and
    // "you can only go up from wherever the number happened to be a minute ago".
    lastReqSec = req;
    if (askOpen) paintAsk();
    const pct = req ? Math.round(100 * spent / req) : 0;
    // Remembered for the instant path, which has no status object to read it from.
    faceRequiredNow = !!faceRequired;
    // The clock itself is handed over further down, once `counting` is known — see
    // setClockFrom. It used to be set here as well, with a `counting` that the line below
    // the face check then overwrote.
    const minCards = st.minCards || 0;
    $("cards").textContent = minCards
      ? `${st.reviewedToday != null ? st.reviewedToday : 0} / ${minCards}`
      : (st.reviewedToday != null ? st.reviewedToday : "—");

    const conn = $("conn");
    if (st.connected) { conn.textContent = "connected"; conn.className = "pill green"; }
    else { conn.textContent = "not detected"; conn.className = "pill red"; }

    // Always-on-top trouble: one small ⚠ icon, the details in its tooltip, and
    // the 📌 button as the manual way out.
    let warn = "";
    if (st.bridgeOk === false) warn = "Anki add-on not found — install it in Anki";
    else if (st.pinSupported === false) warn = "Always-on-top needs Windows";
    // No version number in this sentence on purpose: it used to say "needs v1.4"
    // while the shipped add-on was already v1.8, so the advice read as nonsense.
    // The real fix is always the same — install the add-on this build ships with.
    else if (st.camPinned === false && st.camFound === false) warn =
      `Add-on v${esc(st.bridgeVersion || "?")} can't see this window — press ⬇ Add-on in Settings to update it`;
    else if (st.camPinned === false) warn = st.pinError === 5
      ? "Windows blocked it — run Anki and Chrome both as normal user, or both as admin"
      : `Couldn't hold it on top (error ${st.pinError || 0}) — press 📌`;

    const wEl = $("mbWarn");
    if (wEl) { wEl.style.display = warn ? "inline" : "none"; wEl.title = warn; }
    // The add-on version sits next to the ⚠, because "which version am I running"
    // is the answer nine times out of ten.
    const wV = $("mbWarnV");
    if (wV) wV.textContent = warn && st.bridgeOk ? (st.bridgeVersion || "?") : "";
    const popWarn = $("popWarn");
    if (popWarn && warn) {
      popWarn.innerHTML = `
        <div class="mp-row"><b>Always-on-top</b></div>
        <div class="mp-row"><span class="mp-dot ${st.bridgeOk ? "g" : "r"}"></span>Add-on ${st.bridgeOk ? "v" + esc(st.bridgeVersion || "?") : "not found"}</div>
        <div class="mp-row"><span class="mp-dot ${st.camPinned ? "g" : "r"}"></span>${st.camPinned ? "Pinned" : "Not pinned"}</div>
        <!-- WHICH of the two mechanisms is keeping this window shut, not whether closing works —
             closing is refused either way. The add-on takes the title bar's buttons off where
             Windows owns the frame; where Chrome draws its own caption it cannot, and the
             extension's put-it-straight-back is what enforces the same rule instead.
             Worded as "removed / reopens" rather than "on / off" on purpose: all the add-on can
             verify is that the style bit changed, which is not proof that Chrome stopped painting
             the buttons. Claiming "no close button" on the strength of that would be a status
             line contradicted by the thing sitting six pixels above it.
             Shown here and nowhere else for the same reason the pin state is: it reads false
             whenever no camera window exists and whenever you are not in Anki, so anywhere you
             could study it at leisure it would describe a fault that isn't one. This popover
             opens on the window itself while you are in Anki — the one place it means what it says.
             Neutral dot, never red: the fallback is not a failure, it is the other route. -->
        <div class="mp-row"><span class="mp-dot ${st.camCloseBlocked ? "g" : ""}"></span>${st.camCloseBlocked ? "Close button removed" : "Close reopens the window"}</div>
        <div class="mp-row" style="white-space:normal;max-width:180px">${esc(warn)}</div>`;
    }
    const fixBtn = $("pinfix");
    if (fixBtn) fixBtn.style.display = (warn && pipSupported() && !(pipWin && !pipWin.closed)) ? "block" : "none";
    const pin = $("pinwarn");
    if (pin && !MINI) { pin.style.display = warn ? "block" : "none"; pin.textContent = warn ? "⚠️ " + warn : ""; }

    const face = $("face");
    // facePresent(), not faceNow. faceNow is only ever written inside detectOnce, so
    // if the detector dies it keeps its last value forever — and the pill went on
    // saying "face ✓" while the background was (correctly) crediting nothing. Being
    // told the camera is fine when it isn't sends people off to debug Anki.
    const faceOk = facePresent();
    if (!faceRequired) { face.textContent = "off"; face.className = "pill amber"; }
    else if (faceOk) { face.textContent = "face ✓"; face.className = "pill green"; }
    else { face.textContent = ready ? "no face" : "camera off"; face.className = "pill red"; }

    // Whether today is finished, and one phrase for what is left — both worked out by
    // the worker over every gate that is switched on. This window used to decide it
    // from the time and the card count, the only two figures it is sent, so with a
    // due, retention or per-deck gate open it announced "Goal complete" while the
    // sites stayed shut.
    const allMet = st.met === true;
    const cardsOk = !minCards || (st.reviewedToday || 0) >= minCards;
    const done = $("done");
    const stateEl = $("state");
    // Local instant gate: never display "counting" if a required check is failing
    // right now, even before the next background poll lands.
    const faceBlock = faceRequired && !faceOk;
    if (req > 0 && spent >= req && allMet) {
      // The green "Done! Your sites are unlocked" panel is for the full study tab only.
      //
      // In the floating window it was a banner announcing something the window had already said
      // three other ways — the clock reads 00:00, the ✓ badge is green, and the ＋ disc only
      // exists at this moment — and it said it in the most expensive place possible. That window
      // is fitted to its contents (see reportShape), so the panel did not overlay the picture,
      // it made the whole window taller: the moment you finished, the thing grew a green block
      // and pushed itself up the screen. A sentence is not worth a resize.
      //
      // Its ✕ goes with it, which costs nothing here: this window has a real title bar with a
      // real close button, and closing it that way is already recorded as a dismissal — see
      // chrome.windows.onRemoved in the worker. The full tab has no title bar of its own, which
      // is exactly why the button stays there.
      done.style.display = MINI ? "none" : "block";
      stateEl.textContent = "Goal complete";
      // Finished, so stop watching — but stay on screen, and stay a camera. The window used
      // to be closed for you at this moment; then it waited here with the picture switched
      // off, which looked like it had failed. Now the detector stops and the view carries on:
      // nothing is being judged, and the last thing you see is still you rather than a black
      // rectangle. See setDoneMode.
      setDoneMode(true);
      showDoneControls(true);
    } else if (faceBlock) {
      done.style.display = "none";
      setDoneMode(false);
      showDoneControls(false);
      stateEl.textContent = "⏸️ Paused — face not visible";
    } else {
      done.style.display = "none";
      setDoneMode(false);
      showDoneControls(false);
      stateEl.textContent =
        !st.connected ? "❌ Open your Anki app"
        : st.studying ? "⏱️ Counting — keep going!"
        : st.reason === "no_bridge" ? "⚠️ Install the AnkiGate add-on in Anki"
        : st.reason === "not_foreground" ? "⏸️ Paused — click into Anki"
        : st.reason === "not_fullwindow" ? "⏸️ Paused — make Anki full screen"
        : st.reason === "no_reviewer" ? "⏸️ Paused — start reviewing in Anki"
        : st.reason === "in_browser" ? "⏸️ Paused — go back to Anki"
        : st.reason === "no_face" ? "⏸️ Paused — face not visible"
        : st.reason === "still" ? "🖱️ Paused — move the mouse or type in Anki"
        : st.reason === "media_paused" ? "▶️ Paused — press play on this card's video"
        : st.reason === "media_buffering" ? "⏳ Paused — waiting for the video to load"
        : st.reason === "wrong_deck" ? "⏸️ Paused — wrong deck"
        : st.reason === "same_card" ? "⏸️ Paused — answer this card"
        : st.reason === "spam" ? "⚠️ Too fast — slow down"
        // The clock is full but something else is holding the day open. `left` is the
        // worker's own phrasing, so a gate this window has never heard of still gets
        // named instead of falling through to "answer a card".
        : (spent >= req && st.left) ? st.left
        : "⏸️ Paused — answer a card";
    }

    // ---- icon row (the little window) ----
    // The clock already shows the time and the dot on the picture already shows
    // your face, so those icons are gone. What's left: the cards count, a pause
    // icon only while something is stopping the clock, and ⚠ only on trouble.
    const counting = st.studying === true && !faceBlock;
    // A couple of words, in red, saying what to do about it. Set before the clock, because
    // setClockFrom paints and the paint shows this line.
    //
    // The two facts it needs are remembered, so the storage path can work the same line out
    // for itself the moment the worker writes a new reason — see the note on shortReason.
    connectedNow = st.connected !== false;
    reasonNow = String(st.reason || "");
    clock.reason = counting ? "" : shortReason(faceBlock);
    // Straight from the worker's own reading rather than inferred from the reason, because with the
    // media gate off there IS no reason to infer it from — the clock is still running. See the note
    // on clock.buffering.
    clock.buffering = st.mediaWaiting === true;
    // Only when the worker actually sent it — an older reply that lacks the field must not blank a
    // state the storage path has already delivered.
    if (typeof st.resumeState === "string") clock.resume = st.resumeState;
    if (st.stoppedAt !== undefined) clock.stoppedAt = Number(st.stoppedAt) || 0;
    setClockFrom(spent, req, counting);

    const pause = $("mbState");
    if (pause) {
      pause.style.display = counting ? "none" : "inline";
      pause.title = stateEl.textContent;
    }
    const popState = $("popState");
    if (popState) {
      const rows = [];
      if (!st.connected) rows.push(`<span class="mp-dot r"></span>Anki not found`);
      else if (st.foreground === false) rows.push(`<span class="mp-dot r"></span>Anki not in front`);
      else if (st.fullWindow === false) rows.push(`<span class="mp-dot r"></span>Anki not full screen`);
      else if (faceBlock || st.reason === "no_face") rows.push(`<span class="mp-dot r"></span>${eyeRequired ? "Eyes off screen" : "Face not visible"}`);
      else if (st.reason === "still") rows.push(`<span class="mp-dot r"></span>Nothing touched — move the mouse or type`);
      else if (st.reason === "no_reviewer") rows.push(
        `<span class="mp-dot r"></span>No card open — switch off “Only count while I'm answering cards” in settings to count any time in Anki`);
      else if (st.reason === "media_paused") rows.push(`<span class="mp-dot r"></span>Press play on this card's video`);
      else if (st.reason === "media_buffering") rows.push(`<span class="mp-dot y"></span>Waiting for the video to load`);
      else if (st.reason === "wrong_deck") rows.push(`<span class="mp-dot r"></span>Deck doesn't count`);
      else if (st.reason === "same_card") rows.push(`<span class="mp-dot y"></span>Answer this card`);
      else if (st.reason === "spam") rows.push(`<span class="mp-dot y"></span>Answers too fast`);
      else rows.push(`<span class="mp-dot y"></span>Paused`);
      // Said whether the clock is running or not: this card carries media whose
      // player wouldn't report its state, so the media gate is standing aside on it.
      // Better to admit that than to let someone believe a check is being enforced
      // when it isn't.
      if (st.mediaUnreadable) {
        rows.push(`<span class="mp-dot y"></span>Couldn't check this card's media — time is counting anyway`);
      }
      popState.innerHTML = `<div class="mp-row"><b>Paused</b></div>` +
        rows.map(r => `<div class="mp-row">${r}</div>`).join("") +
        `<div class="mp-row" style="color:#64748b">${fmt(spent)} of ${fmt(req)}</div>`;
    }

    const cardsEl = $("mbCardsN");
    if (cardsEl) {
      const reviewed = st.reviewedToday != null ? st.reviewedToday : 0;
      cardsEl.textContent = minCards ? `${reviewed}/${minCards}` : String(reviewed);
    }
    const cardsIcon = $("mbCards");
    if (cardsIcon) {
      cardsIcon.className = "mb " + (minCards ? (cardsOk ? "ok" : "bad") : "ok");
      cardsIcon.title = minCards ? `${st.reviewedToday || 0} of ${minCards} cards` : `${st.reviewedToday || 0} cards today`;
    }
    const popCards = $("popCards");
    if (popCards) {
      const reviewed = st.reviewedToday != null ? st.reviewedToday : 0;
      // The media line only appears when this card actually has media, so a normal
      // collection never sees it. Shown while the clock is RUNNING too, because
      // "the video is playing and that is why time is counting" is the feedback
      // that makes this feature legible — otherwise you can only ever see it
      // complain, never see it agree.
      const mediaRow = !st.mediaPresent ? "" : (
        st.mediaUnreadable
          ? `<div class="mp-row"><span class="mp-dot y"></span>Video here, can't check it — counting anyway</div>`
          : st.mediaPlaying
            ? `<div class="mp-row"><span class="mp-dot g"></span>Video playing</div>`
            // Buffering gets its own line, and an amber dot rather than a red one: the clock
            // has stopped, but there is nothing for you to put right.
            : st.mediaWaiting
              ? `<div class="mp-row"><span class="mp-dot y"></span>Video buffering — not counting</div>`
              : `<div class="mp-row"><span class="mp-dot r"></span>Video paused — press play</div>`);
      popCards.innerHTML = `
        <div class="mp-row"><b>${reviewed | 0}</b> cards today</div>
        ${minCards ? `<div class="mp-row"><span class="mp-dot ${cardsOk ? "g" : "r"}"></span>Need ${minCards | 0}</div>` : ""}
        ${mediaRow}
        ${st.currentDeck ? `<div class="mp-row" style="color:#64748b">${esc(st.currentDeck)}</div>` : ""}
        <div class="mp-row" style="color:#64748b">${esc(fmt(spent))} of ${esc(fmt(req))}</div>`;
    }

    // Mirror everything into the floating window when it's open.
    if (pipEls) {
      const remaining = Math.max(0, req - spent);
      pipEls.time.textContent = req ? fmt(remaining) : "--";
      pipEls.state.textContent = stateEl.textContent;
      pipEls.meta.textContent = `${fmt(spent)} / ${fmt(req)}` +
        (minCards ? ` · ${st.reviewedToday || 0}/${minCards} cards` : "");
      pipEls.bar.style.width = pct + "%";
      pipEls.box.classList.toggle("done", req > 0 && spent >= req && allMet);
    }
  }

  // ---------------- float over Anki (always-on-top window) ----------------
  // Document Picture-in-Picture gives us a real OS window that sits above every
  // other app, including Anki. The live camera element is moved into it (same
  // stream, no restart) together with a compact clock, so while you review in
  // Anki you can see your face and your time without switching back to Chrome.
  const popBtn = $("popout"), camHome = $("camhome"), camAway = $("camaway"),
        floatHint = $("floathint"), gate = $("gate");
  let pipWin = null, pipEls = null;

  // Deliberately literal colours rather than theme tokens. This is the window
  // that floats on top of Anki, and it is dark in both themes for the same reason
  // html.mini is (see theme.css): a white panel hovering over a full-screen app
  // is glare, not a theme. It also cannot inherit the parent page's stylesheet —
  // a picture-in-picture window is its own document — so the CSS is injected.
  const PIP_CSS = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; background: #0b1020; color: #e2e8f0;
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .fbox { height: 100%; display: flex; flex-direction: column; }
    .fcam { position: relative; background: #000; }
    .camwrap { position: relative; overflow: hidden; background: #000; aspect-ratio: 4/3; }
    /* contain + top, matching study.html. This box is 4:3 so it changes nothing here — it is
       kept identical because the marker canvas below has to agree with the video, and two
       copies of a rule that must agree are two chances to drift apart. */
    video { width: 100%; height: 100%; object-fit: contain; object-position: top center;
      transform: scaleX(-1); display: block; background: #000; }
    .camstatus { position: absolute; left: 0; right: 0; bottom: 0; padding: 4px 6px; font-size: 10px;
      font-weight: 800; letter-spacing: .5px; text-transform: uppercase; text-align: center;
      color: #fff; background: rgba(15,23,42,.85); }
    .ok .camstatus { background: rgba(22,163,74,.92); }
    .bad .camstatus { background: rgba(220,38,38,.92); }
    .wait .camstatus { background: rgba(202,138,4,.92); }
    /* Restated here like everything else in this block: camwrap travels into the picture-in-picture
       window but study.html's rules cannot follow it. */
    .idle .camstatus { background: rgba(71,85,105,.92); }
    /* The marker canvas and the two little buttons travel INSIDE camwrap when it
       moves into this window, but their rules live in study.html's inline <style>
       and can't follow. Without these they became ordinary flow content stacked
       after a full-height video inside an overflow:hidden box — so while floating,
       which is the mode this whole feature exists for, the face and eye markers
       disappeared and the beep and marker buttons could not be clicked. */
    .camov { position: absolute; inset: 0; width: 100%; height: 100%;
      object-fit: contain; object-position: top center;
      transform: scaleX(-1); pointer-events: none; }
    .camov[hidden] { display: none; }
    /* The switches fold away behind one opener, so the container is what is positioned and
       the buttons are ordinary flex children — the same arrangement as study.html, restated
       here for the same reason as everything else in this block. */
    .camtools { position: absolute; left: 5%; top: 5%; z-index: 3;
      display: flex; flex-direction: row; align-items: center;
      gap: clamp(3px, 2.2vw, 5px); }
    .camtoglist { display: flex; flex-direction: row; align-items: center;
      gap: clamp(3px, 2.2vw, 5px); }
    /* Opens sideways, animated, exactly as in study.html — restated here for the same reason as
       everything else in this block: camwrap travels into this window but the rules cannot follow
       it. If one of the two is ever changed alone, this is the copy that goes stale. */
    .camtoglist { visibility: visible; transition: visibility 0s; }
    .camtools:not(.open) .camtoglist { visibility: hidden; pointer-events: none;
      transition: visibility 0s linear .2s; }
    .camtoglist .camtog { transition: transform .18s cubic-bezier(.2,.8,.3,1), opacity .15s ease; }
    .camtools:not(.open) .camtoglist .camtog { transform: translateX(-12px) scale(.8); opacity: 0; }
    .camtools.open .camtoglist .camtog:nth-child(2) { transition-delay: .04s; }
    .camtools.open .camtoglist .camtog:nth-child(3) { transition-delay: .08s; }
    .camtools.open .camtoglist .camtog:nth-child(4) { transition-delay: .12s; }
    .camtools.open .camtoglist .camtog:nth-child(5) { transition-delay: .16s; }
    @media (prefers-reduced-motion: reduce) {
      .camtoglist .camtog { transition: none; }
      .camtools:not(.open) .camtoglist .camtog { transform: none; }
    }
    .camtog { position: relative; padding: 0;
      width: clamp(16px, 11vw, 24px); height: clamp(16px, 11vw, 24px);
      display: grid; place-items: center; border-radius: 999px; cursor: pointer;
      color: #fde68a; background: rgba(2,6,23,.82); border: 1px solid rgba(253,230,138,.55);
      box-shadow: 0 1px 6px rgba(0,0,0,.55); opacity: .9; }
    .camtog svg { width: 62%; height: 62%; display: block; fill: none; stroke: currentColor;
      stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }

    .camtog[aria-pressed="false"] { color: #94a3b8; border-color: rgba(148,163,184,.4); }
    .camtog[aria-pressed="false"] .wave { display: none; }
    .camtoggle { color: #e2e8f0; border-color: rgba(226,232,240,.42); }
    .camtools.open .camtoggle { color: #fde68a; border-color: rgba(253,230,138,.55); }
    /* The settings gear is a link, not a switch, so it stays neutral in both states. Restated here
       like everything else in this block: it travels into the picture-in-picture window inside
       camwrap, and study.html's rules cannot follow it. */
    .camlink { color: #e2e8f0; border-color: rgba(226,232,240,.42); }
    .fbody { flex: 1; display: flex; flex-direction: column; justify-content: center;
      gap: 3px; padding: 8px 10px; text-align: center; }
    .ftime { font-size: 26px; font-weight: 800; letter-spacing: -.5px; line-height: 1.1; }
    .fstate { font-size: 11px; color: #cbd5e1; }
    .fmeta { font-size: 10px; color: #64748b; }
    .fbar { height: 5px; background: #1e293b; border-radius: 999px; overflow: hidden; margin-top: 4px; }
    .fbar > div { height: 100%; width: 0%; background: linear-gradient(90deg,#f97316,#eab308); transition: width .4s; }
    .done .ftime { color: #86efac; }`;

  function pipSupported() {
    return typeof window.documentPictureInPicture !== "undefined" &&
           typeof window.documentPictureInPicture.requestWindow === "function";
  }

  function floatFailed(msg) {
    if (floatHint) floatHint.textContent = msg;
    const err = $("gateerr");
    if (err && gate && !gate.classList.contains("hidden")) err.textContent = msg;
  }

  // One at a time. reopenOnGesture is a CAPTURE-phase window click listener, so it
  // runs before the gate's own handler — clicking the gate therefore called this
  // twice. The first call consumed the user activation, the second was refused a
  // picture-in-picture window and fell through to the plain-popup path, leaving two
  // windows: a PiP with an empty camera slot and a popup holding the real one, each
  // with its own pagehide handler and its own 1-second watcher.
  let floatOpening = false;
  // The "has the float window closed?" poller. One at a time — see openFloatOnce.
  let floatWatch = 0;

  async function openFloat() {
    if (floatOpening) return;
    if (pipWin && !pipWin.closed) return;
    floatOpening = true;
    try { await openFloatOnce(); } finally { floatOpening = false; }
  }

  async function openFloatOnce() {
    let w;
    if (pipSupported()) {
      try {
        // Must be the first thing after the click: it needs the user gesture.
        w = await window.documentPictureInPicture.requestWindow({ width: 250, height: 300 });
      } catch (e) {
        w = null;
      }
    }
    let fallback = false;
    if (!w) {
      // No Document Picture-in-Picture (Chrome older than 116, or it refused).
      // A plain small window still lets you park the camera beside Anki — it just
      // won't stay on top by itself, so keep Anki un-maximised next to it.
      w = window.open("", "ankigate_float", "popup=yes,width=250,height=320");
      if (!w) {
        floatFailed("Chrome blocked the window. Allow pop-ups for this page, then try again.");
        return;
      }
      fallback = true;
    }
    pipWin = w;
    const d = w.document;
    // window.open with a name returns an EXISTING window of that name. restoreFloat
    // lets go of pipWin without closing anything, so that window can still be out
    // there — and decorating it again gave it two stylesheets, two clocks and two
    // camera slots. Start from empty instead.
    if (fallback) {
      try { d.head.replaceChildren(); d.body.replaceChildren(); } catch (e) {}
    }
    d.title = "Anki Gate";
    const style = d.createElement("style");
    style.textContent = PIP_CSS;
    d.head.appendChild(style);
    const box = d.createElement("div");
    box.className = "fbox";
    box.innerHTML = `
      <div class="fcam" id="fcam"></div>
      <div class="fbody">
        <div class="ftime" id="ftime">--</div>
        <div class="fstate" id="fstate">…</div>
        <div class="fmeta" id="fmeta"></div>
        <div class="fbar"><div id="fbar"></div></div>
      </div>`;
    d.body.appendChild(box);
    // Move the live preview across — same element, same camera stream.
    d.getElementById("fcam").appendChild(camwrap);
    pipEls = {
      box, time: d.getElementById("ftime"), state: d.getElementById("fstate"),
      meta: d.getElementById("fmeta"), bar: d.getElementById("fbar")
    };
    if (camAway) camAway.style.display = "grid";
    if (popBtn) { popBtn.textContent = "⤢ Bring it back"; popBtn.classList.add("sec"); }
    if (floatHint) {
      floatHint.textContent = fallback
        ? "Opened as a normal window — this Chrome can't keep it on top, so put Anki beside it instead of maximised."
        : "Drag it over Anki. Closing it brings the camera back here.";
    }
    hideGate();
    // Once per window, not once per float. window.open with a name hands back an EXISTING
    // window (see above), and replaceChildren clears its contents but not its listeners — so
    // every float → unfloat → float cycle stacked another restoreFloat on the same window.
    // A marker on the window itself covers both cases: a fresh picture-in-picture window
    // never has it, and the reused pop-up only gets wired the first time.
    if (!w.__agFloatWired) {
      w.__agFloatWired = 1;
      w.addEventListener("pagehide", restoreFloat);
    }
    // A plain pop-up window doesn't fire pagehide reliably; watch for it closing.
    //
    // The handle is kept in a module variable and cleared by restoreFloat. When the
    // watcher only cleared itself, floating again inside the same second left the old
    // one running — it saw a live pipWin and carried on — so each fast reopen cycle
    // leaked an interval that would call restoreFloat on some later close.
    if (floatWatch) { clearInterval(floatWatch); floatWatch = 0; }
    floatWatch = setInterval(() => {
      if (!pipWin || pipWin.closed) restoreFloat();
    }, 1000);
    refresh();
  }

  function restoreFloat() {
    if (floatWatch) { clearInterval(floatWatch); floatWatch = 0; }
    if (camHome && camwrap && camwrap.parentNode !== camHome) {
      try { camHome.appendChild(camwrap); } catch (e) {}
    }
    pipWin = null; pipEls = null;
    if (camAway) camAway.style.display = "none";
    if (popBtn) { popBtn.textContent = "🪟 Float over Anki"; popBtn.classList.remove("sec"); }
    if (floatHint) floatHint.textContent = "Stays on top of every app, so you can watch your face and the clock while you review.";
    // If you'd chosen to keep it floating, put the one-click prompt back up so a
    // single click anywhere returns it. Chrome will not let a page open this kind
    // of window without a click, so it can't come back entirely on its own.
    if (!MINI && wantsFloat() && gate) { gate.classList.remove("hidden"); const e = $("gateerr"); if (e) e.textContent = ""; }
  }

  // Fallback inside the little window: one click turns it into a real
  // picture-in-picture window, which the browser itself keeps above everything.
  $("pinfix")?.addEventListener("click", (e) => {
    e.stopPropagation();
    openFloat();
  });

  if (popBtn) {
    popBtn.addEventListener("click", () => {
      if (pipWin && !pipWin.closed) {
        rememberFloat(false);                       // you asked for it back in the tab
        try { pipWin.close(); } catch (e) {}
        restoreFloat();
        return;
      }
      rememberFloat(true);
      openFloat();
    });
  }

  // The floating window can only be created from a real click, so instead of
  // hiding that click behind a small button we ask for it up front — and any
  // click or key press on this tab counts, not just the button.
  function hideGate() { if (gate) gate.classList.add("hidden"); }
  // It's declared role="dialog" aria-modal="true" in study.html, so it has to behave
  // like one: focus goes into it, and Escape dismisses it. Without the focus move,
  // Tab walked past its buttons into the content behind the scrim — announced to a
  // screen reader while being neither visible nor clickable.
  if (gate && !MINI) {
    setTimeout(() => { try { $("gateBtn")?.focus(); } catch (e) {} }, 50);
    gate.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();          // don't let reopenOnGesture re-open it
      hideGate();
    });
  }
  // "1" = float it, "0" = you said no thanks, null = never asked. All three are
  // different: only the explicit "0" should stop the prompt appearing.
  //
  // The old key is still read when the new one is absent, so an answer you already
  // gave is not asked again by the rename. Nothing writes the old key any more, so it
  // ages out on its own the first time you change your mind.
  const FLOAT_KEY = "ankigate_float", FLOAT_KEY_LEGACY = "focusgate_float";
  function floatPref() {
    try {
      const v = localStorage.getItem(FLOAT_KEY);
      return v === null ? localStorage.getItem(FLOAT_KEY_LEGACY) : v;
    } catch (e) { return null; }
  }
  function wantsFloat() { return floatPref() === "1"; }
  function rememberFloat(on) {
    try { localStorage.setItem(FLOAT_KEY, on ? "1" : "0"); } catch (e) {}
  }

  if (gate && !MINI) {
    if (floatPref() === "0") hideGate();
    gate.addEventListener("click", (e) => {
      if (e.target && e.target.id === "gateLater") {
        e.preventDefault();
        rememberFloat(false);
        hideGate();
        return;
      }
      rememberFloat(true);
      openFloat();
    });
  }

  // Any interaction brings the floating window back — but only in the full study
  // tab. In the little camera window nothing happens unless you press 📌, so a
  // stray click can't move your camera out from under you.
  function reopenOnGesture() {
    if (MINI) return;
    if (pipWin && !pipWin.closed) return;
    if (!wantsFloat()) return;
    openFloat();
  }
  window.addEventListener("click", reopenOnGesture, true);
  window.addEventListener("keydown", reopenOnGesture, true);
  window.addEventListener("focus", () => {
    // Coming back to this tab: if the window should be floating but isn't, show
    // the prompt again so one click restores it.
    if (!MINI && wantsFloat() && !(pipWin && !pipWin.closed) && gate) gate.classList.remove("hidden");
  });

  // Tap an icon in the minibar to show its detail popover; tap again or outside
  // to close. Only the mini camera window uses this; the full study tab has it
  // all laid out already.
  const minibar = $("minibar");
  if (minibar && MINI) {
    minibar.addEventListener("click", (e) => {
      const mb = e.target.closest(".mb");
      const pop = mb ? mb.querySelector(".minipop") : null;
      minibar.querySelectorAll(".minipop").forEach(p => { if (p !== pop) p.style.display = "none"; });
      if (pop) pop.style.display = pop.style.display === "block" ? "none" : "block";
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".minibar")) {
        minibar.querySelectorAll(".minipop").forEach(p => p.style.display = "none");
      }
    });
  }

  // ---------------- the window keeps the camera's shape ----------------
  // A window of any other shape has to give you one of two bad things: a crop, which hides
  // the framing this window exists to show you, or a black band, which is just wasted screen.
  // Neither is fixable in CSS, because the shape is the problem.
  //
  // So the SIZE is yours — drag any edge — and the shape follows. Drag the width and the
  // height comes with it; drag the height and the width does. The picture then fills the
  // window exactly, with only the clock strip under it, at every size.
  //
  // The measuring has to happen here: only this page knows the camera's real aspect (the stream
  // may be 4:3 or 16:9, the request is only a preference) and how tall the clock strip came out.
  // The resizing has to happen in the worker, which owns the window.
  //
  // ---- why this REPORTS rather than ASKS, which is the whole of the growth fix ----
  //
  // This used to send a DELTA: "make the height 7 more than it is". Two of those in flight, or one
  // applied to a window that had moved on, and the window ended up 7 bigger than it should be —
  // and the correction for that was another delta. Worse, it had to guess WHICH edge you had
  // dragged, and when it guessed "the height", it changed the WIDTH to match. So the width was
  // derived from the height while the height was derived from the width: a loop with gain, which
  // is exactly what "it grows a little on every drag" is. Every fix on top of that was another
  // guard on a feedback path that should not have existed.
  //
  // So nothing is asked for here any more. This reports four measurements — the content size, the
  // strip height, the camera's aspect — and the worker computes the whole window size from them
  // and its OWN remembered width, absolutely. The result is a pure function of the inputs, so
  // sending it twice does nothing the second time, and a drag can no more change the size than
  // reading a tape measure can change a plank. The width is never derived from the height.
  const CAM_ASPECT = 4 / 3;               // until the stream says otherwise
  let shapeTimer = 0;
  // True while the picture is being dragged. Shared with the drag below, because a move must
  // never be mistaken for a resize.
  let winDragging = false;
  // And true while the corner grip is being dragged. Its own flag rather than a share of the one
  // above, because the two gestures are opposites in the only way that matters here: a move must
  // leave the size alone, a resize is nothing but a change of size. One flag covering both would
  // leave every reader of it asking which had happened.
  let winSizing = false;
  function camAspect() {
    const w = v && v.videoWidth, h = v && v.videoHeight;
    return (w > 0 && h > 0) ? (w / h) : CAM_ASPECT;
  }
  // What this window currently IS, for the worker to work out what it should be.
  //
  // Four facts, no opinion. `iw`/`ih` are the content box, which the worker subtracts from the
  // window's own bounds to learn how much of it is title bar and border — a figure neither side can
  // assume, since it differs by platform, theme and display scaling. `strip` is how tall the clock
  // row came out. `aspect` is what the camera is actually delivering, which only this page can see.
  //
  // No guard on whether anything "really" changed, and none is needed: a report that says the same
  // thing as the last one produces the same answer, and the worker does nothing when the answer is
  // the size the window already is. That is what replaced FIT_MIN_MOVE and the retry counter.
  function reportShape() {
    if (!MINI) return;                    // a full tab's window is the user's, not ours
    if (winDragging) return;              // you are moving it, not resizing it
    // Nor while the grip is in flight. Not because a report would do harm — the worker holds the width
    // during a resize, so one cannot move the window sideways — but because it would describe a step
    // the pointer has already gone past, and the message costs a windows.get to answer. The report
    // that matters is the single one sent when the drag ENDS, which is what settles the height against
    // the strip's real height at the size you actually stopped on. See sizeStop below.
    if (winSizing) return;
    const iw = window.innerWidth, ih = window.innerHeight;
    if (!iw || !ih) return;
    const bar = $("clockbar");
    const strip = bar ? Math.round(bar.offsetHeight) : 0;
    try {
      chrome.runtime.sendMessage({
        type: "camShape",
        iw, ih, strip,
        aspect: camAspect(),
        // With no picture there is no shape to hold: the strip IS the window, so the worker must
        // not divide anything by an aspect ratio it has no business believing in.
        timerOnly: !!TIMER_ONLY
      }, () => void chrome.runtime.lastError);
    } catch (e) {}
  }
  // Debounced, so it settles once you let go of the edge rather than fighting the drag.
  function reportShapeSoon() {
    if (!MINI) return;
    clearTimeout(shapeTimer);
    shapeTimer = setTimeout(reportShape, 220);
  }
  window.addEventListener("resize", reportShapeSoon);
  // And dropped on the way out, so a report a fifth of a second before the window closes doesn't
  // reach a worker that no longer has a window to apply it to.
  window.addEventListener("pagehide", () => { clearTimeout(shapeTimer); shapeTimer = 0; });
  // The aspect is unknown until the stream arrives, and the whole height depends on it — so the
  // first honest report is the one after the camera says how big its picture is.
  if (v) {
    v.addEventListener("loadedmetadata", reportShapeSoon);
    v.addEventListener("resize", reportShapeSoon);
  }

  // The strip changing height is not a resize of the window, but it does change what the right
  // window height IS — so the window has to follow it.
  //
  // This was written for the reason line, which used to be in the flow: the strip grew by a line
  // whenever the clock stopped, and the window was only ever re-fitted when an EDGE moved, so
  // the extra line had nowhere to go but off the end of the window. That line is out of the flow
  // now (see #state in study.html) — because a window that resizes itself every time it says
  // "no face" is worse than the problem it solved — so this no longer fires for it.
  //
  // It is still needed. The finished panel appears in the strip, and the strip's own scale is a
  // function of the window's WIDTH, so anything that changes the width changes its height too.
  //
  // Nothing has to be forced or forgotten here any more — it is the same report as every other,
  // and the worker will work out the same height it always would for this strip and this width.
  if (MINI && typeof ResizeObserver !== "undefined") {
    const bar = $("clockbar");
    if (bar) {
      let seenStrip = 0;
      // Safe from feeding itself twice over: the strip's size comes from the window's WIDTH (every
      // size in it is em off a vw base) and the worker only ever changes the height from this — and
      // even if it did change the width, the answer is a pure function of the inputs, so the second
      // pass round would compute the same size and stop.
      try {
        new ResizeObserver(() => {
          const h = Math.round(bar.offsetHeight);
          if (!h || h === seenStrip) return;
          seenStrip = h;
          reportShapeSoon();
        }).observe(bar);
      } catch (e) {}
    }
  }

  // Back to the default size. Only the worker can resize the window, and only the WIDTH is a
  // decision — the height follows from it on the report that the resize provokes.
  $("sizeReset")?.addEventListener("click", () => {
    try { chrome.runtime.sendMessage({ type: "camResetSize" }, () => void chrome.runtime.lastError); } catch (e) {}
  });

  // ---------------- resize the window by its corner grip ----------------
  // The window has real borders and dragging them still works. This is here because those borders are
  // about four pixels of a window that is mostly picture, so hitting one is a game of patience — and
  // because a border drag can only ever be read backwards. Chrome reports the new bounds after the
  // fact and the worker has to work out from them which edge you meant, which is the machinery that
  // made resizing feel like an argument: the width would move, the height would catch up a frame
  // later, and pulling the bottom edge up did nothing for a long time.
  //
  // The grip states the width outright, so there is nothing to deduce. ONE number travels. The height
  // is always the picture at the camera's real aspect plus the clock strip, so the worker derives it
  // from that width and applies both in a single windows.update — which is what makes this scale in
  // proportion instead of stretching one way and then correcting. See camSetWidth in background.js.
  if (MINI) {
    const grip = $("sizeGrip");
    // The range, mirrored from CAM_SIZE in background.js. NOT a second opinion about the limits: the
    // worker clamps, the worker answers with what it actually did, and that answer is what gets
    // displayed — so if these ever disagree the worker wins and nothing breaks. They are here to keep
    // the slider role's aria-valuemin/max honest and to avoid sending a number nobody could want.
    // The same two figures are in the aria attributes in study.html; all three move together.
    const SIZE_MIN = 120, SIZE_MAX = 700;
    // How far an arrow key moves it, and how far with Shift held. The same pair FocusGate's own grip
    // uses, so the two windows answer the same keys the same way.
    const SIZE_STEP = 2, SIZE_STEP_BIG = 16;
    // The same throttle as the move drag, for the same reason: one message a frame is plenty, and the
    // worker does a windows.get to answer each one.
    const SIZE_EVERY_MS = 25;
    let sizeOn = false, sizePtr = 0, sizeFromX = 0, sizeFromY = 0, sizeFromW = 0, sizeSentAt = 0;
    // The last width the worker confirmed. Used as the starting point for a key press, so a run of
    // presses accumulates against what the window IS rather than re-reading a figure the window
    // manager may have rounded.
    let sizeLast = 0;
    const clampW = (px) => Math.max(SIZE_MIN, Math.min(SIZE_MAX, Math.round(px)));
    const outerNow = () => Math.round(window.outerWidth || window.innerWidth || 0);

    // Say what the size is, for anyone who cannot watch it happen. A role="slider" that never updates
    // aria-valuenow is a slider a screen reader has to guess at.
    function showSize(w, h) {
      if (!grip || !w) return;
      sizeLast = w;
      try {
        grip.setAttribute("aria-valuenow", String(w));
        // Both numbers, because the shape is the thing being controlled and the width alone does not
        // say it. "176 by 195 pixels" is also what the Settings slider reads out, so the two agree.
        grip.setAttribute("aria-valuetext", h ? (w + " by " + h + " pixels") : (w + " pixels wide"));
      } catch (e) {}
    }

    // Pointer travel, read as a change in WIDTH.
    //
    // Sideways is a width already. Downwards is a height, so it is converted through the camera's
    // aspect — pull down by 3 on a 4:3 picture and you have asked for 4 more width. That conversion is
    // what makes a diagonal pull scale the window rather than skew it.
    //
    // Which axis counts: whichever moved further, once both are expressed as widths. Not the sum and
    // not the average — either of those halves the response to a straight sideways pull, which is the
    // most common drag there is and the one that should feel one-to-one. This is the same "follow the
    // edge that moved further" rule camShapeTarget uses for border drags, applied to a pointer instead
    // of to bounds, and compared like-for-like for the same reason.
    //
    // Timer-only has no picture and therefore no aspect worth believing in: the strip is the whole
    // window and its height is not ours to choose. Sideways only there.
    function gripDelta(e) {
      const byX = e.screenX - sizeFromX;
      if (TIMER_ONLY) return byX;
      const byY = (e.screenY - sizeFromY) * camAspect();
      return Math.abs(byX) >= Math.abs(byY) ? byX : byY;
    }

    // Ask for a width. The measurements ride along because this page is INSIDE the window being
    // resized, so it can see the two things the Settings slider cannot: how tall the strip came out,
    // and what shape the camera is actually delivering.
    function askWidth(px) {
      const want = clampW(px);
      const bar = $("clockbar");
      try {
        chrome.runtime.sendMessage({
          type: "camSetWidth",
          width: want,
          iw: window.innerWidth, ih: window.innerHeight,
          strip: bar ? Math.round(bar.offsetHeight) : 0,
          aspect: camAspect(),
          timerOnly: !!TIMER_ONLY
        }, (r) => {
          void chrome.runtime.lastError;
          // What came back, not what was asked for. They differ at both ends of the range, and a
          // readout that repeats the request would claim the window had reached a size it had not.
          if (r && r.ok) showSize(r.width || want, r.height || 0);
        });
      } catch (e) {}
    }

    function sizeStop() {
      if (!sizeOn) return;
      sizeOn = false;
      winSizing = false;
      try { grip.releasePointerCapture(sizePtr); } catch (e) {}
      try { grip.classList.remove("on"); } catch (e) {}
      document.documentElement.classList.remove("sizing");
      // One report now the pointer has stopped. The worker holds the width through a resize, so this
      // cannot move the window sideways — the only thing it changes is the height, recomputed against
      // the strip as it actually came out at the size you stopped on rather than at the size it was
      // one step earlier. For the slider in Settings that correction is the difference between a
      // fitted window and a visible band of letterbox; here it is a pixel or two. See the holdSize
      // note in background.js for why a report during a resize is kept rather than refused.
      reportShapeSoon();
    }

    if (grip) {
      // Start from what the window IS, read once, here, and never again for the rest of the drag.
      // Every step is pointer travel added to this one figure, so there is nothing for rounding to
      // accumulate into — which is the whole lesson of the growth bug this window spent three rounds
      // on. Read off the window rather than from anything remembered because a border drag may have
      // changed it since, and this is the ground truth at the moment you take hold.
      grip.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        sizeOn = true;
        winSizing = true;
        // A pending report belongs to before this drag, and describes a window about to stop being
        // that size.
        clearTimeout(shapeTimer);
        sizePtr = e.pointerId;
        sizeFromX = e.screenX;
        sizeFromY = e.screenY;
        sizeFromW = outerNow();
        sizeSentAt = 0;
        // Captured, so the drag survives the pointer leaving the disc — which happens on the first
        // few pixels, since the window is resizing out from under it.
        try { grip.setPointerCapture(sizePtr); } catch (e2) {}
        grip.classList.add("on");
        document.documentElement.classList.add("sizing");
        e.preventDefault();
      });
      grip.addEventListener("pointermove", (e) => {
        if (!sizeOn || e.pointerId !== sizePtr) return;
        const now = Date.now();
        if (now - sizeSentAt < SIZE_EVERY_MS) return;
        sizeSentAt = now;
        askWidth(sizeFromW + gripDelta(e));
      });
      // The final move is usually the one the throttle ate, so the width is stated once more —
      // unthrottled — at the moment you let go. Without this the window settles a few pixels short of
      // where the pointer actually stopped, which reads as the drag not quite taking.
      grip.addEventListener("pointerup", (e) => {
        if (sizeOn && e.pointerId === sizePtr) askWidth(sizeFromW + gripDelta(e));
        sizeStop();
      });
      grip.addEventListener("pointercancel", sizeStop);
      // A drag that ends while the window is not focused never gets a pointerup here.
      window.addEventListener("blur", sizeStop);

      // Arrow keys. A slider that can only be dragged is not operable without a pointer, and the only
      // other route to a size in this window is a four-pixel border, which is worse in that respect
      // rather than better. Right/Down grow, Left/Up shrink — Down grows because down-and-right is the
      // direction the grip itself points, and that is the axis pairing every window corner uses.
      // Home goes back to the default, and it does it by sending the same message the reset-size disc
      // sends, so "default" cannot come to mean two different sizes.
      grip.addEventListener("keydown", (e) => {
        const step = e.shiftKey ? SIZE_STEP_BIG : SIZE_STEP;
        const from = sizeLast || outerNow();
        if (e.key === "ArrowRight" || e.key === "ArrowDown") askWidth(from + step);
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") askWidth(from - step);
        else if (e.key === "Home") {
          try { chrome.runtime.sendMessage({ type: "camResetSize" }, () => void chrome.runtime.lastError); } catch (e2) {}
        } else return;
        e.preventDefault();
      });

      // And the aria value starts out true rather than starting out at whatever the markup guessed.
      showSize(outerNow(), Math.round(window.outerHeight || 0));
    }
  }

  // ---------------- drag the window by its picture ----------------
  // The title bar can move this window, but at passport size the title bar is a sliver, and
  // the picture is the biggest and most obvious thing to take hold of.
  //
  // A page cannot move its own window, so the worker does it. What travels is the pointer's
  // movement SINCE the drag began, and the worker adds that to where the window was when it
  // began. Two reasons it is a delta and not a position: `window.screenX` is the content's
  // left edge while chrome.windows.update takes the frame's, which differ by the border and
  // would put a jump in the first movement — and the window moves out from under the pointer
  // as we go, so anything measured against the window itself feeds back into itself.
  if (MINI) {
    const DRAG_EVERY_MS = 25;
    let dragOn = false, dragPtr = 0, dragFromX = 0, dragFromY = 0, dragSentAt = 0;
    // The picture is the handle — unless there is no picture, in which case the strip is, because
    // it is the only thing in the window. .camwrap is display:none in that mode, and listeners on
    // a hidden element receive nothing, so the window would have had no way to be moved at all.
    const wrap = TIMER_ONLY ? ($("clockbar") || document.body) : $("camwrap");
    function dragStop() {
      if (!dragOn) return;
      dragOn = false;
      winDragging = false;
      try { wrap.releasePointerCapture(dragPtr); } catch (e) {}
      document.documentElement.classList.remove("dragging");
      // No re-fit once you let go, and that absence is the fix rather than an omission.
      //
      // This used to forget the agreed size here and ask for a fit, on the reasoning that a
      // window manager nudges the bounds while a window is being moved and those nudges add up.
      // The reasoning was sound and the remedy was the thing doing the damage: with the agreed
      // size zeroed, the "did anything really move" guard could not apply — there was nothing left
      // to compare against — so every single drag ended in a resize request, and any rounding in the
      // height it asked for was a window a pixel or two taller than the one you started dragging.
      // Over an evening that is the passport photo quietly becoming a portrait. The request itself
      // is gone now; the page reports and the worker decides. See reportShape.
      //
      // Nothing needs correcting, and nothing needs remembering. The worker restates its own
      // remembered size on every step of the move and once more on camDragEnd, so by the time you
      // let go the window is already exactly the size it was when you took hold of it — and a shape
      // report cannot change a size anyway, since the worker derives it from a width a move never
      // touches. Any pending report is dropped only so it does not land during the handover.
      clearTimeout(shapeTimer);
      try { chrome.runtime.sendMessage({ type: "camDragEnd" }, () => void chrome.runtime.lastError); } catch (e) {}
    }
    if (wrap) {
      wrap.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        // Anything you can press is not a handle, and neither is the clock strip. The strip
        // is a solid panel of readouts laid over the bottom of the picture; taking hold of it
        // moved the window, which is an affordance nothing about it advertises — and it now
        // shows the ordinary arrow rather than a grab cursor, so this is what makes the
        // pointer's promise true. The picture above it is still the handle.
        //
        // The strip is exempt from that second rule when it is the handle. With no picture in the
        // window there is nothing else left to take hold of.
        // `input` and #addAsk are named as well as `button`, and they have to be. In timer-only
        // mode the strip IS the drag handle, so without this a press on the "how long in total?"
        // field started dragging the window instead of putting a caret in the box — a field you
        // cannot click into at all. A button was the only interactive thing in here when this
        // guard was written.
        // #sizeGrip is named alongside them, and it has to be. It is the one control in the strip
        // that is not a <button>, so `button` does not cover it — and in timer-only mode, where the
        // strip IS the drag handle, that omission meant taking hold of the resize grip moved the
        // window instead of resizing it. The grip is unreachable in that mode without this line.
        if (e.target && e.target.closest
            && (e.target.closest("button, input, #addAsk, #sizeGrip")
                || (!TIMER_ONLY && e.target.closest("#clockbar")))) return;
        dragOn = true;
        winDragging = true;
        // A pending shape report belongs to before this drag. It could do no harm now — the worker
        // works the size out from a width a move never changes — but it would arrive describing a
        // window that has since moved, and there is nothing to be gained by that.
        clearTimeout(shapeTimer);
        dragPtr = e.pointerId;
        dragFromX = e.screenX;
        dragFromY = e.screenY;
        dragSentAt = 0;
        // Captured, so the drag survives the pointer leaving the window — which it will, as
        // soon as the window starts following it.
        try { wrap.setPointerCapture(dragPtr); } catch (e2) {}
        document.documentElement.classList.add("dragging");
        try { chrome.runtime.sendMessage({ type: "camDragStart" }, () => void chrome.runtime.lastError); } catch (e2) {}
        e.preventDefault();
      });
      wrap.addEventListener("pointermove", (e) => {
        if (!dragOn || e.pointerId !== dragPtr) return;
        const now = Date.now();
        if (now - dragSentAt < DRAG_EVERY_MS) return;
        dragSentAt = now;
        try {
          chrome.runtime.sendMessage({
            type: "camMove",
            dx: Math.round(e.screenX - dragFromX),
            dy: Math.round(e.screenY - dragFromY)
          }, () => void chrome.runtime.lastError);
        } catch (e2) {}
      });
      wrap.addEventListener("pointerup", dragStop);
      wrap.addEventListener("pointercancel", dragStop);
      // A drag that ends while the window is not focused never gets a pointerup here.
      window.addEventListener("blur", dragStop);
    }
  }

  // No camera while a break is on. This page can now be opened straight into a paused
  // session, which it never could before — a break used to close the window outright.
  //
  // Gated on the stored value rather than started and then stopped: releasing a start that
  // is still waiting on the device is the awkward case (see camGen), and there is nothing to
  // gain by walking into it. It costs nothing either, because the request itself went out at
  // the top of this file; this only decides whether to keep what comes back.
  if (TIMER_ONLY) {
    // Nothing to start. The clock is driven by the worker's polls and this window's own
    // paintClock, neither of which has ever needed the camera.
    setCam("timer", "");
  } else {
    try {
      chrome.storage.local.get(["userPaused"], (r) => {
        if (r && r.userPaused) { stopCamera(); setCam("paused", "wait"); return; }
        startCamera();
      });
    } catch (e) { startCamera(); }
  }
  // The throttled forms, not the raw ones. These two are the backstop for a page whose frame
  // callbacks have stopped arriving — the detector loop already calls maybeSendFace and
  // maybeRefresh on every frame — and calling sendFace/refresh directly ignored the very
  // throttles those exist to enforce. With the detector running, both fired twice: two face
  // reports a second, and two ankiPoll messages every two seconds, each of which makes the
  // worker talk to AnkiConnect and to the bridge.
  setInterval(maybeSendFace, 1000);
  setInterval(maybeRefresh, 2000);
  sendFace(); refresh();
})();
