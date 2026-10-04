// One place that decides whether today's Anki goal is finished.
//
// This used to live in four copies — background.js decided it for the blocking,
// options.js for the card, popup.js for its row and blocked.js for its sentence —
// and each copy spelled out "time is done AND (cards off OR cards done)" by hand.
// Two gates was already one copy too many; six is a guarantee that one of them
// will disagree with the others, and the one that decides whether sites open is
// the worst possible place for that.
//
// So every gate is described once, here, as data: a label, what you have, what you
// need, and whether it's satisfied. Callers render the list; nobody re-derives it.
//
// Pure functions over a plain state object. No chrome.* — the worker imports this
// with importScripts and the four pages load it as an ordinary script, so it must
// run in both.
//
// Everything hangs off one global, FGGates, rather than loose names: options.js
// already has its own fmtDur and num at top level, and a classic script that
// exported those names would quietly replace them.
(() => {
  "use strict";
  const G = (typeof self !== "undefined" ? self : globalThis);

  // Retention below this many REVIEW answers is noise, not a signal: two cards and
  // one lapse is "50% retention", which would lock the day over nothing. Under the
  // floor the gate stands aside entirely rather than blocking — see evaluate().
  const RETENTION_MIN_SAMPLE = 10;

  // A finite number or the fallback. Storage is JSON and the worker heals it, but
  // this file also runs on pages that read storage raw, and a stored "1e999" reads
  // as Infinity — which satisfies every `>=` in here and would open every site.
  function fin(v, d = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  }
  // Has the add-on inside Anki answered at all today?
  //
  // Deliberately not "is the answer recent". A stale answer is still an answer, and
  // the last known reading has to keep counting — otherwise finishing the time goal,
  // closing Anki and waiting would let the due and card gates lapse into "unknown"
  // and open every site with the queue still full. What has to be distinguished is
  // "measured, possibly a while ago" from "never measured today", and only the second
  // one is a reason for a gate to stand aside. The daily reset puts this back to 0.
  function measuredToday(s) {
    return fin(s && s.ankiGoalsAt) > 0;
  }
  function dur(sec) {
    const s = Math.max(0, Math.round(fin(sec)));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? h + "h " : "") + (m || h ? m + "m " : "") + x + "s";
  }
  function pctOf(have, need) {
    const n = fin(need);
    if (n <= 0) return 100;
    return Math.max(0, Math.min(100, (fin(have) / n) * 100));
  }
  function plural(n, one, many) {
    return fin(n) === 1 ? one : (many || one + "s");
  }

  // ---- decks ---------------------------------------------------------------
  function cleanDeck(v) {
    return typeof v === "string" ? v.trim() : "";
  }
  // The decks the "only these decks count" switch is limiting us to. Empty means
  // no restriction, which every caller reads as "the whole collection".
  function selectedDecks(s) {
    if (!s || !s.ankiDeckRestrictEnabled) return [];
    return (Array.isArray(s.ankiDecks) ? s.ankiDecks : []).map(cleanDeck).filter(Boolean);
  }
  // The decks the DUE gate looks at — its own list, not the one above.
  //
  // They are separate because the two questions are separate, and people set them
  // differently on purpose: "any deck's reviews earn me time, but the Backlog deck
  // has to reach zero before anything unlocks". One shared list cannot express that.
  // Empty means the whole collection, which is the same default the gate had before
  // it could be narrowed.
  function dueDecks(s) {
    if (!s) return [];
    const seen = new Set();
    return (Array.isArray(s.ankiDueDecks) ? s.ankiDueDecks : [])
      .map(cleanDeck).filter(Boolean)
      .filter(d => {
        const k = d.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
  }
  // Anki separates a subdeck from its parent with "::", so a rule about "Biology"
  // is a rule about "Biology::Chapter 1" too. Matched on the separator and not with
  // startsWith(deck) alone, or "Bio" would also claim a deck called "Biochem".
  function underDeck(name, deck) {
    return !!name && !!deck && (name === deck || name.startsWith(deck + "::"));
  }
  // The per-deck time quotas, cleaned up: no blanks, no zero-length quotas, and no
  // deck twice (two rows for one deck would each show their own progress against
  // the same seconds, which reads as a bug).
  function deckTimeRows(s) {
    if (!s || !Array.isArray(s.ankiDeckTimes)) return [];
    const out = [], seen = new Set();
    for (const r of s.ankiDeckTimes) {
      if (!r || typeof r !== "object") continue;
      const deck = cleanDeck(r.deck);
      const sec = Math.max(0, Math.round(fin(r.sec)));
      if (!deck || sec <= 0) continue;
      const k = deck.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ deck, sec });
    }
    return out;
  }
  // Seconds credited to a deck today, its subdecks included. The ledger is keyed by
  // the exact deck Anki reported the card from, so a quota on the parent has to add
  // its children up itself.
  function deckSpent(s, deck) {
    const m = s && s.ankiDeckSpent;
    if (!m || typeof m !== "object" || Array.isArray(m)) return 0;
    let total = 0;
    for (const k of Object.keys(m)) if (underDeck(k, deck)) total += Math.max(0, fin(m[k]));
    return total;
  }

  // ---- retention -----------------------------------------------------------
  // Only Anki's `type = 1` reviews are counted, which is what Anki's own "true
  // retention" means, and the distinction is the whole feature rather than a
  // detail: pressing Again on a card you are seeing for the FIRST time is what
  // learning looks like, not a failure. Counting learning steps would mean a day
  // spent on new cards scored about 50% and could never pass an 80% gate — the
  // gate would punish exactly the work it is supposed to encourage.
  function retention(s) {
    const pass = Math.max(0, fin(s && s.ankiRetPass));
    const again = Math.max(0, fin(s && s.ankiRetAgain));
    const total = pass + again;
    // Divided first, then scaled, and clamped after. `100 * pass` overflows to
    // Infinity on a large enough stored value, and Infinity / total stays Infinity —
    // which printed "Infinity%" on the blocked page and, worse, satisfied the
    // `>= need` test that decides whether the sites open. Found by fuzzing, not by
    // reading: the arithmetic looks unremarkable.
    const pct = total > 0 ? Math.max(0, Math.min(100, (pass / total) * 100)) : 0;
    return { pass, again, total, pct };
  }

  // ---- the two deadlines ---------------------------------------------------
  //
  // Everything above this point asks HOW MUCH you have done. These two ask WHEN you did it, and
  // they are the only things in the extension that can leave a finished goal locked.
  //
  //   THE WINDOW — a time of day. "Finish it between 06:00 and 09:00 or it unlocks nothing today."
  //   THE LIMIT  — a stopwatch. "From the first moment Anki was open today you have the goal plus
  //                your grace to finish it in."
  //
  // Both exist because they are different promises, and somebody wants one or the other rather than
  // a compromise between them. A window is a commitment to a time of day and only means anything if
  // you know when you will sit down; a limit is a commitment to not dawdling, and means the same
  // thing whenever you sit down. One stops you starting at eleven at night, the other stops an hour
  // of cards taking four. Both can be on, and then both have to be satisfied.
  //
  // WHAT THEY DO NOT DO is change what you EARN. Time still counts, cards still count, every bar
  // still fills, and the settings page still shows it — because a goal that silently refused to move
  // reads as broken rather than as strict. What a missed deadline withholds is the unlock.
  //
  // ---- how a whole day of punishment works without a timer ----
  //
  // There is no "locked until" timestamp anywhere and no alarm. The whole mechanism is one stamp:
  // `ankiMetAt`, the moment the goal was first reached today, written exactly once by the poll and
  // cleared only by the daily reset. Every question below is asked of THAT instant rather than of
  // the time the question happens to be asked, so:
  //
  //   finishing at 08:50 inside a 06:00–09:00 window keeps the unlock for the rest of the day, and
  //   finishing at 09:10 does not earn it at 09:11 or at any moment after.
  //
  // The stamp does not move and the deadline instants are fixed for the day, so once a deadline has
  // been missed the answer cannot change again until the day rolls over. That is the punishment, and
  // it is derived rather than stored — which means it cannot be got out of by restarting the
  // browser, and cannot get stuck on by a timer that failed to fire.
  //
  // FAIL OPEN, deliberately, in every direction: no stamp, a malformed time, a zero-length window,
  // a limit with no goal to be late for. Taking somebody's earned unlock away on the strength of a
  // missing field is the one outcome worth ruling out.

  // "HH:MM" as minutes since midnight, or -1 for anything that is not a time.
  function hhmmMin(v) {
    const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(typeof v === "string" ? v : "");
    if (!m) return -1;
    const h = fin(m[1]), mi = fin(m[2]);
    if (h > 23 || mi > 59) return -1;
    return h * 60 + mi;
  }

  // Is there a window at all? A window of zero length is treated as no window, because it could
  // never be satisfied — that is a locked door rather than a strict setting, and refusing to honour
  // it is kinder than silently making the day unearnable.
  function hasWindow(s) {
    if (!s || s.ankiWinEnabled !== true) return false;
    const a = hhmmMin(s.ankiWinStart), b = hhmmMin(s.ankiWinEnd);
    return a >= 0 && b >= 0 && a !== b;
  }
  // Is `atMs` inside it? Windows may wrap midnight — 22:00 to 02:00 is a real thing somebody would
  // ask for — so this is written as "start before end" and "start after end" rather than assuming
  // the first is the smaller.
  //
  // Half-open, like every other range: 06:00–09:00 contains 06:00 and does not contain 09:00, so
  // two windows laid end to end never both claim the same minute.
  function inWindow(s, atMs) {
    if (!hasWindow(s)) return true;
    const d = new Date(atMs == null ? Date.now() : atMs);
    const now = d.getHours() * 60 + d.getMinutes();
    const a = hhmmMin(s.ankiWinStart), b = hhmmMin(s.ankiWinEnd);
    return a < b ? (now >= a && now < b) : (now >= a || now < b);
  }
  // "15:00" said the way people say it: "3:00 pm". Storage stays 24-hour, which is the only form
  // with no midnight ambiguity; this is purely how it is shown, and it lives here because five
  // surfaces show a window and a clock that read 24-hour on one and 12-hour on the next would look
  // like two settings rather than one setting written twice.
  function clock12(v) {
    const t = hhmmMin(v);
    if (t < 0) return "";
    const h24 = Math.floor(t / 60), mi = t % 60;
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;      // midnight and noon are both 12, not 0
    return h12 + ":" + String(mi).padStart(2, "0") + " " + (h24 < 12 ? "am" : "pm");
  }
  function windowLabel(s) {
    if (!hasWindow(s)) return "";
    return clock12(s.ankiWinStart) + " – " + clock12(s.ankiWinEnd);
  }

  // Is there a stopwatch at all? `requiredSec > 0` is part of the question for the reason hasWindow
  // refuses a zero-length window: a day with nothing to do has nothing to be late for, and an
  // allowance measured against no work is either meaningless or a locked door depending on how you
  // read it. Refusing to honour it is the kinder of the two.
  function hasGrace(s) {
    if (!s || s.ankiGraceEnabled !== true) return false;
    const g = Number(s.ankiGraceSec);
    if (!Number.isFinite(g) || g < 0) return false;
    return Math.max(0, fin(s.ankiRequiredSec)) > 0;
  }
  // Has it actually started? Not until Anki has been seen today, which is the whole difference
  // between this and a window: a window is running whether or not you turned up.
  function graceStarted(s) {
    return hasGrace(s) && Math.max(0, fin(s && s.ankiGraceFrom)) > 0;
  }
  // The moment the chance runs out, or 0 when no stopwatch is running.
  //
  // `ankiRequiredSec` is read LIVE rather than remembered from when the stopwatch started, so the ＋
  // in the camera window extends the deadline along with the goal. That is the honest reading of
  // "the goal plus your slack": adding ten minutes of work and getting ten more minutes to do it in
  // leaves the promise the same shape, where a fixed deadline over a growing goal would turn ＋ into
  // a button that makes the day harder in two ways at once.
  function graceDeadline(s) {
    if (!graceStarted(s)) return 0;
    const allow = Math.max(0, fin(s.ankiRequiredSec)) + Math.max(0, fin(s.ankiGraceSec));
    return Math.max(0, fin(s.ankiGraceFrom)) + allow * 1000;
  }
  // How long is left, in whole seconds, floored at zero. Callers that need to tell "none left" from
  // "not running" ask graceStarted; a plain number is what every screen actually wants.
  function graceLeftSec(s) {
    const d = graceDeadline(s);
    if (!d) return 0;
    return Math.max(0, Math.round((d - Date.now()) / 1000));
  }
  // Was `atMs` inside the allowance? Fail-open when there is no stopwatch or it never started,
  // exactly as inWindow answers true for a day with no window.
  function graceInTime(s, atMs) {
    const d = graceDeadline(s);
    if (!d) return true;
    return (atMs == null ? Date.now() : atMs) <= d;
  }

  // When the goal was first reached today, as epoch ms, or 0 for "not yet".
  const metAt = (s) => Math.max(0, fin(s && s.ankiMetAt));

  // Were both deadlines honoured? The one question the unlock turns on.
  //
  // Written as a list of ways to FAIL rather than as nested "if it has one" branches, so a third
  // deadline would be one more line and could not accidentally short-circuit the second.
  //
  // `done` is passed in rather than worked out, because working it out here would be circular: the
  // stamp this reads is written by the poll at the moment the goal is complete, and the goal being
  // complete is decided by the gates above without reference to any of this.
  function deadlineOk(s, done) {
    if (!done) return false;
    const at = metAt(s);
    // No stamp, but done. Four ways to arrive here and all are answered the same way: a day
    // finished before this feature existed, a deadline switched on after the goal was already
    // finished today, a goal of zero seconds that was never "completed" by a poll at all, and the
    // single poll between finishing and the stamp landing. None is evidence that a deadline was
    // missed, so an absent stamp reads as "no violation recorded" rather than as a failure.
    if (!at) return true;
    if (hasWindow(s) && !inWindow(s, at)) return false;
    if (graceStarted(s) && !graceInTime(s, at)) return false;
    return true;
  }

  // ---- the four states worth explaining in words ----
  //
  // Two per deadline, and the pair is not one state with two descriptions. "Missed" requires the
  // goal to be DONE — a full bar that unlocked nothing. "Gone" is the commoner and sadder one: the
  // time ran out with work still to do, so the bar is half full and also unlocked nothing, and no
  // amount of further work can rescue it today. Both need saying out loud.
  function windowMissed(s, done) {
    return hasWindow(s) && !!done && !deadlineOk(s, done);
  }
  // A window that has closed on unfinished work.
  //
  // Windows that wrap midnight are deliberately never called gone. 22:00–02:00 sitting in the
  // middle of the afternoon has already had its morning half, but it opens again this evening, so
  // the chance is not lost — and telling somebody their day is over when it is not is the one error
  // worth avoiding here. Conservative in the direction of hope.
  function windowGone(s, done) {
    if (!hasWindow(s) || done) return false;
    const a = hhmmMin(s.ankiWinStart), b = hhmmMin(s.ankiWinEnd);
    if (a > b) return false;                          // wraps midnight: it comes round again today
    const d = new Date();
    return (d.getHours() * 60 + d.getMinutes()) >= b;
  }
  // Finished, but after the allowance ran out — the mirror of windowMissed.
  function graceMissed(s, done) {
    if (!graceStarted(s) || !done) return false;
    const at = metAt(s);
    if (!at) return false;                            // no stamp: no violation recorded
    return at > graceDeadline(s);
  }
  // The allowance ran out with work still to do. No midnight wrap to be careful about, unlike
  // windowGone, and that is not an omission — it is what makes this a stopwatch. A window that has
  // gone may come round again tonight; an allowance that has run out is spent for the day.
  function graceGone(s, done) {
    if (!graceStarted(s) || done) return false;
    return Date.now() > graceDeadline(s);
  }

  // ---- the gates -----------------------------------------------------------
  // Every gate the user has switched on, in the order they have to think about
  // them, each as: what it's called, how far along it is, and what's left to do.
  //
  // `blocked` is not the same as `!done`. A gate we cannot measure — the add-on is
  // too old, or Anki hasn't answered yet — is reported as not done AND not
  // blocking, and it says so in `warn`. Failing closed there would be a dead end:
  // the requirement could never be satisfied, so the sites could never open, and
  // no amount of studying would help. That is strictly worse than letting a check
  // stand aside and saying loudly that it has, which is the same call the media
  // gate makes for a video whose state can't be read.
  function evaluate(state) {
    const s = state || {};
    const req = Math.max(0, fin(s.ankiRequiredSec));
    const on = s.ankiEnabled !== false;
    // `done` stated rather than left undefined, so every caller can read one shape. goalDone reads
    // it, and `undefined && …` happens to be falsy — but a field that is only correct by accident is
    // the kind that stops being correct.
    if (!on) return { on: false, done: false, met: false, items: [], warns: [] };

    const items = [], warns = [];
    const add = (it) => { items.push(it); return it; };

    // 1. Time in Anki. Always present — it is the goal the rest hang off.
    const spent = Math.max(0, fin(s.ankiSpentSec));
    const isDone = spent >= req;
    add({
      key: "time", icon: "⏳", label: "Study time",
      have: dur(spent), need: dur(req), pct: pctOf(spent, req),
      done: isDone, blocked: !isDone,
      left: isDone ? "" : `${dur(req - spent)} of Anki to go`
    });

    // 2. A number of cards. Counted once per card when "count each card only once"
    //    is on, which is what stops one card answered Again forty times from
    //    filling a forty-card quota.
    if (s.ankiMinCardsEnabled) {
      const need = Math.max(0, fin(s.ankiMinCards));
      const uniq = !!s.ankiUniqueOnly;
      const have = Math.max(0, fin(uniq ? s.ankiUniqueToday : s.ankiReviewedToday));
      // Unique counting comes from the add-on. Without it the honest reading is
      // "unknown", and counting every review instead would silently hand back the
      // loophole the switch was turned on to close — so the gate stands aside and
      // says why.
      const measurable = !uniq || measuredToday(s);
      const done = measurable && have >= need;
      if (uniq && !measurable) warns.push("The add-on in Anki is too old to count each card only once — press ⬇ Add-on to update it. Until then the card count is not checked.");
      add({
        key: "cards", icon: "🔢", label: uniq ? "Different cards" : "Cards reviewed",
        have: measurable ? String(have) : "—", need: String(need),
        pct: measurable ? pctOf(have, need) : 0,
        done, blocked: measurable && !done,
        left: measurable ? `${Math.max(0, need - have)} more ${plural(need - have, "card")}`
                         : "card count can't be checked"
      });
    }

    // 3. Today's due queue, cleared. Measured by the add-on from Anki's own deck
    //    list, so it respects your daily limits — a 500-card backlog behind a
    //    100-a-day limit reads as done once the 100 are done, instead of being a
    //    goal that cannot be reached.
    if (s.ankiDueGateEnabled) {
      const allowed = Math.max(0, fin(s.ankiDueAllowed));
      const left = fin(s.ankiDueLeft, -1);
      const measurable = left >= 0;
      const done = measurable && left <= allowed;
      if (!measurable) warns.push("Anki isn't reporting how many cards are still due — open Anki and press ⬇ Add-on to update the add-on. Until then the due check is not enforced.");
      // Counted down, not up, so the bar fills as the queue empties. The start of
      // the day is whatever was waiting when the day began; without that the bar
      // would sit at 0% until the last card and then jump to full.
      const start = Math.max(left, fin(s.ankiDueAtDayStart, left));
      const cleared = Math.max(0, start - left);
      const target = Math.max(1, start - allowed);
      // Named, when the gate has been narrowed. "14 still due in Anki" is unhelpful
      // once the gate is only watching one deck — the number won't match the total on
      // Anki's deck list, and without the name that reads as a bug rather than as the
      // setting doing exactly what it was asked to.
      const picked = dueDecks(s);
      const where = picked.length === 0 ? "in Anki"
                  : picked.length === 1 ? `in ${picked[0]}`
                  : `in ${picked.length} decks`;
      add({
        key: "due", icon: "📥", label: picked.length === 1 ? `${picked[0]} cleared` : "Due cards cleared",
        have: measurable ? String(left) : "—", need: String(allowed),
        pct: measurable ? pctOf(cleared, target) : 0,
        done, blocked: measurable && !done,
        left: measurable ? `${Math.max(0, left - allowed)} still due ${where}`
                         : "due count can't be checked"
      });
    }

    // 4. Getting them right. Recoverable on purpose: the ratio is over today, so
    //    answering more cards correctly raises it. A gate you could fail
    //    irreversibly at 9am would lock the whole day on one bad session.
    if (s.ankiRetentionEnabled) {
      const need = Math.max(0, Math.min(100, fin(s.ankiMinRetention, 80)));
      const r = retention(s);
      const enough = r.total >= RETENTION_MIN_SAMPLE;
      const measurable = measuredToday(s);
      // Under the sample floor this stands aside rather than blocking. See the
      // constant: a handful of answers cannot say anything about how well you know
      // your deck, and treating it as a failure would lock the day over noise.
      const done = !measurable || !enough || r.pct >= need;
      if (!measurable) warns.push("Anki isn't reporting how many cards you got right — press ⬇ Add-on to update the add-on. Until then the retention check is not enforced.");
      add({
        key: "retention", icon: "🎯", label: "Answers right",
        have: measurable && enough ? Math.round(r.pct) + "%" : "—", need: need + "%",
        pct: measurable && enough ? pctOf(r.pct, need) : 0,
        done, blocked: measurable && enough && r.pct < need,
        left: !measurable ? "can't be checked"
              : !enough ? `needs ${RETENTION_MIN_SAMPLE} review ${plural(RETENTION_MIN_SAMPLE, "answer")} before it counts`
              : `get more right — ${Math.round(r.pct)}% of ${r.total} so far`
      });
    }

    // 5. A time quota per deck, so "an hour of Anki" can't all be the easy deck.
    if (s.ankiDeckTimeEnabled) {
      for (const row of deckTimeRows(s)) {
        const have = Math.min(row.sec, deckSpent(s, row.deck));
        const done = have >= row.sec;
        add({
          key: "deck:" + row.deck, icon: "📚", label: row.deck,
          have: dur(have), need: dur(row.sec), pct: pctOf(have, row.sec),
          done, blocked: !done,
          left: `${dur(row.sec - have)} more in ${row.deck}`
        });
      }
    }

    // Is the WORK done? Every gate above satisfied, and nothing to do with when.
    //
    // Its own answer, separate from `met` below, and this is the one distinction the whole deadline
    // feature rests on. `done` is about the clock and the cards: it is what the bars and the
    // percentages show, and it is what the poll stamps `ankiMetAt` from. `met` is `done` plus the
    // deadlines, and it is what the blocking, the phone and the collection lock ask.
    //
    // They have to be two questions rather than one. The stamp is written when the goal is complete,
    // and the deadline is checked against the stamp — so a single answer that already included the
    // deadline could never become true in the first place, and the goal would be unfinishable the
    // moment a window was switched on.
    const done = !items.some(i => i.blocked);
    const ok = deadlineOk(s, done);

    // A missed deadline is reported as an ORDINARY GATE rather than as a special case, because every
    // surface in the extension already knows how to draw one: the popup row, the settings card, the
    // blocked page and the camera window all render ev.items, so this sentence arrives on all four
    // for nothing. It is only added when there is a verdict to report — while a deadline is still
    // live there is nothing to say that the numbers do not already say.
    const wMissed = windowMissed(s, done), wGone = windowGone(s, done);
    const gMissed = graceMissed(s, done), gGone = graceGone(s, done);
    if (wMissed || wGone || gMissed || gGone) {
      const label = windowLabel(s);
      add({
        key: "deadline", icon: "⏰",
        label: (wMissed || wGone) ? "Deadline" : "Time limit",
        // No progress to show: this is a verdict rather than a quantity, and a bar would invite the
        // reading that more work moves it — which is the one thing that cannot happen today.
        //
        // have/need are still filled in, and filled in so they read as a PAIR, because the blocked
        // page prints every item as "label have/need" — "Deadline missed/in time" and "Time limit ran
        // out/in time" both survive that. The full sentence lives in `left`, which is what the popup
        // and the camera window use.
        have: (wGone || gGone) ? "ran out" : "missed", need: "in time",
        pct: 0, done: false, blocked: true,
        left: wMissed ? `finished after ${clock12(s.ankiWinEnd)} — it unlocks nothing today`
            : wGone ? `the ${label} window shut before it was finished — nothing opens today`
            : gMissed ? "finished after your time limit ran out — it unlocks nothing today"
            : "your time limit ran out — nothing opens today"
      });
    }

    return { on: true, done, met: done && ok, items, warns };
  }

  // Is today's goal finished? The single question that opens the locked list.
  function met(state) {
    const ev = evaluate(state);
    return ev.on && ev.met;
  }
  // Is the WORK finished, deadlines aside? What the poll stamps ankiMetAt from, and the only caller
  // that should ever ask this instead of met() — see the note in evaluate for why the two exist.
  function goalDone(state) {
    const ev = evaluate(state);
    return ev.on && ev.done;
  }
  // Is there anything to do today AT ALL?
  //
  // Not the same question as met(), and the difference is the reason to ask it. With a zero-second goal
  // and no other gate switched on, evaluate answers "met" in the empty sense — every gate that exists is
  // satisfied, because none does — and that is deliberately what the BLOCKING obeys: a locked site with
  // no condition left to satisfy would be a dead end with no way out.
  //
  // But it is not a day that has been done. The screens that said so — a full green bar, "0s goal
  // completed", "🎉 All done. Enjoy!", a trophy, +200 points and a streak day for doing nothing — were
  // describing a fresh install as an achievement. So the blocking keeps asking met(), and everything
  // that PAINTS or REWARDS completion asks this as well.
  //
  // A time goal above zero is a goal. So is any other gate switched on with the clock at zero: twenty
  // cards and no minimum time is a real day's work.
  function hasGoal(state) {
    const s = state || {};
    const ev = evaluate(s);
    if (!ev.on) return false;
    if (Math.max(0, fin(s.ankiRequiredSec)) > 0) return true;
    return ev.items.some(i => i.key !== "time");
  }

  // ---- apps on your phone -------------------------------------------------
  //
  // Should the apps on your phone be blocked right now? Three answers, not two:
  //
  //   true   today's Anki is unfinished, so the apps stay shut.
  //   false  nothing is being withheld any more — release them.
  //   null   the phone bridge is switched off, so this extension has no business touching the
  //          phone at all. Not the same as false: false is an instruction to unlock, null is
  //          silence.
  //
  // It lives here rather than in the worker because two surfaces show the answer — the worker
  // decides which webhook to fire, the popup draws a "📱 locked" pill — and a second copy of the
  // rule is exactly how the popup ends up claiming your phone is free while the worker is still
  // holding it shut. Same reasoning as met() above.
  //
  // The four reasons to unlock are the same four, in the same order, that getBlockReason uses to
  // decide a website is NOT blocked: switched off, a rest day, no goal set, goal met. That is the
  // whole contract of the feature — your phone opens exactly when your sites open, never later.
  //
  // Worth saying what this deliberately does not do, because it is the one real bug in the
  // version this was ported from. It never answers "leave the phone as it is" for a state the
  // user can get stuck in. There, an empty goal made the sync return early, so switching the
  // extension off while the phone was locked left it locked with nothing left running to ever
  // unlock it. A browser extension cannot reach a phone it has stopped talking to, so every way
  // of standing the gate down has to mean "unlock" here.
  function phoneLockWanted(s) {
    if (!s || s.macrodroidEnabled !== true) return null;
    if (s.enabled === false) return false;
    if (!dayIsOn(s)) return false;
    const ev = evaluate(s);
    if (!ev.on) return false;              // no goal set, so nothing can be unfinished
    return !ev.met;
  }
  // What's still standing between you and the unlock, shortest useful form. Only
  // the gates that are actually blocking, so a finished one stops taking up room.
  function remaining(state) {
    const ev = evaluate(state);
    return ev.items.filter(i => i.blocked).map(i => i.left);
  }
  // One line of it, for the places with a single line to spend.
  function remainingText(state) {
    const parts = remaining(state);
    if (!parts.length) return "";
    if (parts.length === 1) return parts[0];
    return parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
  }
  // "3 of 5 done", for a heading.
  function tally(state) {
    const ev = evaluate(state);
    return { done: ev.items.filter(i => i.done).length, total: ev.items.length };
  }

  // ---- strict mode --------------------------------------------------------
  //
  // Two independent reasons for the settings to be frozen. Either is enough.
  //
  //   1. A DAILY WINDOW — every day between two clock times. A schedule: it lifts each morning,
  //      and while it is lifted you can switch it off. Which is what you want on a quiet Tuesday,
  //      and what you will do at two in the afternoon on the day you least should.
  //
  //   2. A DEADLINE — one continuous stretch from now until a date and a time you pick. Not a
  //      schedule at all: it does not lift, so nothing can be loosened until it expires, including
  //      switching the daily window off or moving the deadline closer.
  //
  // The deadline used to be a sub-option of the window: a date that held that switch on. That made
  // it useless on its own — "on until the 30th" with no window set froze nothing — and it is the
  // simpler and more useful of the two, so it now stands by itself.
  //
  // All of this lives here rather than in a page because five surfaces read it: the worker, the
  // settings page, the popup, the blocked page and the study window. It was written out twice, in
  // options.js and popup.js, with different fallbacks for the times — and the one thing worse than
  // a guard that is too strict is two guards that disagree about whether one is running.
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  // The same twelve, written out, for the month picker on the settings page. Exported from here
  // rather than declared there so that the list you choose from and the label you are then shown are
  // one list: "8" in a box could be a month or a day depending on who is reading it, which is why
  // that box became a name — and a name that disagreed with the line underneath would be worse than
  // the number was.
  const MONTHS_LONG = ["January", "February", "March", "April", "May", "June",
                       "July", "August", "September", "October", "November", "December"];
  // The daily window's fallbacks. A real evening-to-morning stretch, never 00:00 → 00:00: a window
  // that starts and ends at the same minute has zero length, dailyStrict reads it as "never", and a
  // page that fell back to it displayed an armed strict mode that enforced nothing.
  const STRICT_FROM = "15:00", STRICT_TO = "08:00";
  // An "HH:MM" out of storage, or the fallback. A number, an object or a half-typed "7:" all read as
  // the fallback rather than as some best guess at what was meant.
  function hhmm(v, fallback) {
    const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(typeof v === "string" ? v : "");
    if (!m) return fallback;
    const h = fin(m[1]), mi = fin(m[2]);
    if (h > 23 || mi > 59) return fallback;
    return String(h).padStart(2, "0") + ":" + String(mi).padStart(2, "0");
  }
  const minsOf = (t) => {
    const [h, m] = t.split(":");
    return fin(h) * 60 + fin(m);
  };
  // Inside today's window? Handles the ordinary case of a window that crosses midnight.
  function dailyStrict(s, now) {
    if (!s || !s.strictModeEnabled) return false;
    const startM = minsOf(hhmm(s.strictStart, STRICT_FROM));
    const endM = minsOf(hhmm(s.strictEnd, STRICT_TO));
    if (startM === endM) return false;                 // zero length is "never", not "always"
    const d = (now && typeof now.getTime === "function") ? now : new Date();
    const nowM = d.getHours() * 60 + d.getMinutes();
    return startM < endM ? (nowM >= startM && nowM < endM)
                         : (nowM >= startM || nowM < endM);
  }

  // Which calendar day the extension is currently calling "today", as a Date.
  //
  // NOT simply `new Date()`. The day here is defined by dailyResetTime: with a 04:00 reset, 01:00 on
  // Tuesday still belongs to Monday, because that is the day whose progress is still on the clock and
  // whose streak is still unsettled. Every other "what day is it" in the extension already works this
  // way — the streak, the reset, the strict-mode deadline — and the weekday picker has to agree with
  // them or "keep Sunday off" would mean two different Sundays depending on which file was asked.
  //
  // Pulled out of dayStamp, which is where this arithmetic used to live alone. It has two readers
  // now (the sortable stamp below, and the weekday), and two copies of a boundary calculation is two
  // chances for one of them to be off by a day.
  function dayDate(s, now) {
    // Duck-typed, not `now instanceof Date`. This file is loaded into a service worker and into
    // four pages, and a Date handed across two realms fails an instanceof against the local
    // constructor — so the check would silently ignore the caller's clock and answer about right
    // now instead, which for a commitment date means answering about the wrong day.
    const d = (now && typeof now.getTime === "function") ? new Date(now.getTime()) : new Date();
    const m = /^(\d{1,2}):(\d{2})$/.exec(String((s && s.dailyResetTime) || "00:00").trim());
    const rh = m ? Math.min(23, fin(m[1])) : 0;
    const rm = m ? Math.min(59, fin(m[2])) : 0;
    if (d.getHours() * 60 + d.getMinutes() < rh * 60 + rm) d.setDate(d.getDate() - 1);
    return d;
  }

  // Today, as a SORTABLE "2026-08-20", with the daily reset boundary respected — before the
  // boundary you are still in yesterday, the same day the streak and the reset use.
  //
  // Deliberately not background's dayKeyAt, which builds "2026-8-20". That one is an identity key
  // and is only ever compared for equality; this one is asked "is it past yet", and that question
  // needs the padding. Two formats, on purpose, and neither should be fed to the other.
  function dayStamp(s, now) {
    const d = dayDate(s, now);
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  // ---- which days of the week this thing works on -------------------------
  //
  // Seven switches, one per weekday. Turn one off and that day is a day off: your listed sites stay
  // open and the camera window stays away. Everything else about the day is untouched — the reset
  // still happens, Anki time still counts if you study anyway, so a rest day cannot cost you a
  // streak you actually earned.
  //
  // INDEXED BY JavaScript's OWN getDay(): 0 is Sunday, 6 is Saturday. The settings page shows Monday
  // first because that is how a week reads, but it does the reordering itself and stores back into
  // these positions. Deliberately: the one line that decides whether today is on is
  // `activeDays(s)[dayDate(s).getDay()]`, with no arithmetic in it at all. A stored Monday-first
  // array would need a +1/−1 at every reader, and the reader that got it wrong would let you
  // through on the wrong day — silently, once a week.
  const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  // Monday first, as positions into the arrays above. The display order, in one place, so the picker
  // and any sentence describing it cannot disagree about where the week starts.
  const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

  // Seven booleans, whatever was actually stored.
  //
  // Missing, short, over-long or full of junk all read as "every day on". That is the direction this
  // has to fail in: an absent value is an old profile that never had this setting, and a fresh
  // profile is every day on — so anything unreadable must behave the way the extension behaved
  // before the setting existed, rather than switching blocking off for a day nobody chose.
  function activeDays(s) {
    const v = s && s.activeDays;
    if (!Array.isArray(v) || v.length !== 7) return [true, true, true, true, true, true, true];
    // `!== false` rather than Boolean(): a stored JSON null or a missing slot is "not switched off",
    // and only an explicit false turns a day into a day off.
    return v.map(x => x !== false);
  }
  // Is at least one day still on? Asked so the settings page can refuse the last one: seven days off
  // is the extension switched off, said in a way that leaves the power button looking on — and there
  // is already a power button for that, in the popup.
  function anyDayOn(s) {
    return activeDays(s).some(Boolean);
  }
  // THE question. One line, no arithmetic, five surfaces.
  function dayIsOn(s, now) {
    return activeDays(s)[dayDate(s, now).getDay()] !== false;
  }
  // The name of the day the extension is currently in, for a sentence on screen. Not
  // toLocaleDateString: this has to be the same word the picker is labelled with, and the picker is
  // labelled from DAY_NAMES.
  function dayName(s, now) {
    return DAY_NAMES[dayDate(s, now).getDay()];
  }
  // The days that are off, as short names in week order — "Sat, Sun". Empty when every day is on.
  function daysOffText(s) {
    const on = activeDays(s);
    return WEEK_ORDER.filter(i => !on[i]).map(i => DAY_SHORT[i]).join(", ");
  }
  // The stored date, or "" for no commitment. Anything that is not exactly YYYY-MM-DD reads as no
  // commitment rather than as some best guess: a half-parsed date here would either lock somebody
  // out for a decade or let them out today, and both are worse than the feature being off.
  function strictUntil(s) {
    const v = s && s.strictUntil;
    return (typeof v === "string" && DATE_RE.test(v.trim())) ? v.trim() : "";
  }
  // Is the commitment in force right now? The date is inclusive: set it to today and strict mode
  // is locked on for the rest of today, which is what picking today plainly means.
  // The end of the deadline, as a moment. Local time throughout — the date and the clock both came
  // from this machine, so there is no timezone arithmetic to get wrong.
  //
  // The default time is 23:59 rather than 00:00, so "until the 21st" means the whole of the 21st.
  // Midnight would make the 21st end before it began, and "until today" would already be over.
  function strictUntilTime(s) { return hhmm(s && s.strictUntilTime, "23:59"); }
  function strictDeadlineAt(s) {
    const d = strictUntil(s);
    if (!d) return 0;
    const [y, mo, da] = d.split("-").map(n => fin(n));
    const [h, mi] = strictUntilTime(s).split(":").map(n => fin(n));
    const at = new Date(y, mo - 1, da, h, mi, 0, 0).getTime();
    return Number.isFinite(at) ? at : 0;
  }
  // Is the deadline still running? Needs its own switch on and a date set — the switch exists so a
  // date can sit in storage unused, which is what lets the boxes remember what you last picked
  // instead of starting blank every time you open the row.
  function strictDeadlineActive(s, now) {
    if (!s || !s.strictUntilEnabled) return false;
    const at = strictDeadlineAt(s);
    if (!at) return false;
    const t = (now && typeof now.getTime === "function") ? now.getTime() : Date.now();
    return t < at;
  }
  // THE question: are the settings frozen right now, for either reason? Every guard on every page
  // asks this one and nothing else, so there is one answer.
  function strictNow(s, now) {
    return dailyStrict(s, now) || strictDeadlineActive(s, now);
  }
  // How much of the deadline is left, in words. Two units at most: "3 days 4 hours" is worth
  // reading, "3 days 4 hours 11 minutes 6 seconds" is a stopwatch nobody asked for.
  function strictLeftText(s, now) {
    const at = strictDeadlineAt(s);
    if (!at) return "";
    const t = (now && typeof now.getTime === "function") ? now.getTime() : Date.now();
    let left = Math.floor((at - t) / 1000);
    if (left <= 0) return "";
    const d = Math.floor(left / 86400); left -= d * 86400;
    const h = Math.floor(left / 3600); left -= h * 3600;
    const m = Math.floor(left / 60);
    if (d) return d + plural(d, " day") + (h ? " " + h + plural(h, " hour") : "");
    if (h) return h + plural(h, " hour") + (m ? " " + m + plural(m, " minute") : "");
    return Math.max(1, m) + plural(Math.max(1, m), " minute");
  }
  // "20 Aug 2026". Spelled out from a table rather than handed to toLocaleDateString, so the date
  // on screen cannot come back in a format that reads as a different day — 08/20 and 20/08 are
  // the same string to two different readers, and this one is a commitment.
  function strictUntilLabel(v) {
    const d = String(v || "").trim();
    if (!DATE_RE.test(d)) return "";
    const [y, m, day] = d.split("-").map(n => fin(n));
    if (m < 1 || m > 12) return "";
    return day + " " + MONTHS[m - 1] + " " + y;
  }

  G.FGGates = {
    RETENTION_MIN_SAMPLE,
    evaluate, met, goalDone, hasGoal, remaining, remainingText, tally, phoneLockWanted,
    dur, fin, pctOf, measuredToday,
    // The two deadlines. Exported in full rather than hidden behind met(), because four screens have
    // to describe them as well as obey them — "2m 30s left of your time limit" is a number only this
    // file can work out, and a second copy of a midnight-wrap comparison is a second chance to get
    // it wrong in one direction.
    hhmmMin, clock12, hasWindow, inWindow, windowLabel, windowMissed, windowGone,
    hasGrace, graceStarted, graceDeadline, graceLeftSec, graceInTime, graceMissed, graceGone,
    deadlineOk, metAt,
    selectedDecks, dueDecks, underDeck, deckTimeRows, deckSpent, retention,
    STRICT_FROM, STRICT_TO, hhmm,
    dayDate, dayStamp, strictUntil, strictUntilTime, strictUntilLabel, MONTHS_LONG,
    dailyStrict, strictDeadlineAt, strictDeadlineActive, strictNow, strictLeftText,
    DAY_NAMES, DAY_SHORT, WEEK_ORDER,
    activeDays, anyDayOn, dayIsOn, dayName, daysOffText
  };
})();
