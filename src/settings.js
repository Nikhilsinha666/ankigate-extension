// AnkiGate — what counts as a SETTING, and how to check one coming back in.
//
// Backup and restore of the settings, in one place. Pure functions over plain objects,
// no chrome.* anywhere: the worker pulls this in with importScripts and the settings
// page loads it as an ordinary script, exactly like gates.js.
//
// ---------------------------------------------------------------------------
// Why one table drives BOTH directions
//
// Storage holds two very different kinds of thing side by side: choices you made
// (blocklist, goal, which checks are on, the dials) and bookkeeping the extension
// keeps (today's seconds, streaks, poll stamps, the password hash, whether your face
// is in front of the camera right now). A backup has to carry the first kind and must
// never carry the second.
//
// So there is exactly one table, SPEC, and it is the allowlist for export AND for
// import. Nothing outside it can leave, and nothing outside it can come in.
//
// The failure mode of an allowlist is the safe one. Forget to add a NEW setting and it
// is missing from a backup — annoying, obvious, harmless. With a denylist, forget to
// add a new piece of bookkeeping and a hand-edited file could write today's spent
// seconds, your streak, or a fabricated "no cards due" reading straight into storage.
// One of those mistakes costs you a line in a backup; the other hands out the day.
//
// NOT_SETTINGS exists so the two lists together account for every key in DEFAULTS, and
// the worker says so out loud at startup if they don't (see checkSettingsSpec in
// background.js). That is what stops this file quietly going stale: a key added to
// DEFAULTS and to neither list is a warning in the console, not a silent gap.
//
// ---------------------------------------------------------------------------
// Why every value is re-checked on the way in
//
// The file is a text file the user can edit, and some of these numbers decide how hard
// it is to cheat. `faceSensitivity: 99` is not a setting, it is an off switch for the
// camera check with a number's clothes on. So each key carries the same range its
// control on the settings page enforces, and anything outside it is clamped rather
// than trusted. A ruined file cannot become a ruined set of rules.
(function (root) {
  "use strict";

  // ---- the little checkers ----
  // Each returns { ok } with a cleaned value, or { ok: false } to drop the key. Dropping
  // rather than defaulting is deliberate: a key we cannot make sense of leaves whatever
  // you already had in place, which is never worse than what was in the file.
  const bad = { ok: false };
  const bool = () => (v) => typeof v === "boolean" ? { ok: true, value: v } : bad;
  // Whole numbers, clamped. NaN, Infinity and "1e999" (which parses to Infinity, and
  // would sail past any `>=` comparison) are refused outright rather than clamped.
  const int = (lo, hi) => (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return bad;
    return { ok: true, value: Math.max(lo, Math.min(hi, Math.round(n))) };
  };
  // One key needs fractions: the fewest seconds a real answer takes.
  const dec = (lo, hi, places) => (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return bad;
    const p = Math.pow(10, places);
    return { ok: true, value: Math.max(lo, Math.min(hi, Math.round(n * p) / p)) };
  };
  const oneOf = (...allowed) => (v) => allowed.includes(v) ? { ok: true, value: v } : bad;
  // "HH:MM". Rebuilt from the parsed numbers rather than passed through, so "7:5"
  // becomes "07:05" and nothing downstream has to cope with both shapes.
  const time = () => (v) => {
    if (typeof v !== "string") return bad;
    const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(v);
    if (!m) return bad;
    const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
    if (h > 23 || mi > 59) return bad;
    return { ok: true, value: String(h).padStart(2, "0") + ":" + String(mi).padStart(2, "0") };
  };
  // "YYYY-MM-DD", or empty for "not set". Rebuilt from the parsed parts like time() above, so a
  // hand-written "2026-8-5" arrives padded and the one place that compares these strings can go
  // on comparing them as text.
  //
  // The day is checked against the month's real length, leap years included. It is not fussiness:
  // this date decides how long you cannot let yourself off, and "2026-02-31" silently becoming
  // the 3rd of March is a commitment quietly moved.
  const date = () => (v) => {
    if (typeof v !== "string") return bad;
    const s = v.trim();
    if (!s) return { ok: true, value: "" };
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    if (!m) return bad;
    const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
    if (y < 1970 || y > 9999 || mo < 1 || mo > 12 || d < 1) return bad;
    if (d > new Date(y, mo, 0).getDate()) return bad;      // day 0 of the next month = this one's last
    const p = (n) => String(n).padStart(2, "0");
    return { ok: true, value: y + "-" + p(mo) + "-" + p(d) };
  };
  // A cap on every list, so a file with a hundred thousand entries can't be imported
  // into something that has to be walked on every single navigation.
  const MAX_LIST = 2000;
  const trimmed = (s) => typeof s === "string" ? s.trim() : "";
  // The blocked / allowed lists: [{ url }]. Bare strings are accepted too, because that
  // is the obvious thing for a human editing the file by hand to write.
  const sites = () => (v) => {
    if (!Array.isArray(v)) return bad;
    const seen = new Set(), out = [];
    for (const item of v.slice(0, MAX_LIST)) {
      const url = trimmed(typeof item === "string" ? item : (item && item.url));
      if (!url || url.length > 300 || seen.has(url)) continue;
      seen.add(url);
      out.push({ url });
    }
    return { ok: true, value: out };
  };
  // ---- one address, the way both lists store it ----
  //
  // Here rather than on the settings page, where it lived until the right-click menu needed it too (see
  // siteMenuClicked in background.js). Two copies of the rule for what a typed address becomes would be
  // two ways for one site to be stored under two names — and the chip list, the duplicate check and the
  // matcher all compare the stored string.
  //
  // Drop the protocol, "www." and any #hash; keep the path AND the query, because
  // "site.com/quiz?id=7" is only exact if its query survives. Case is kept, since
  // ids in paths and queries are case sensitive when you open them again.
  //
  // "www." goes because it is not a different site: google.com redirects to www.google.com, and the
  // matcher treats the two as one for the same reason. What it must NOT do is confuse that with a
  // subdomain — see hostMatches in background.js.
  //
  // A leading "*." survives. It is how you ask for every subdomain, which the allow list does not give
  // you by default any more, and stripping it here would silently turn a deliberate "all of google.com"
  // back into one site.
  function normSite(v) {
    let head = (v || "").trim().replace(/^https?:\/\//i, "");
    // Taken off the front and put back at the end, so every check between here and the return sees an
    // ordinary host name. The validation below rejects a "*" on sight — deliberately, because a
    // wildcard anywhere else in a pattern matches nothing and used to be stored as a chip that looked
    // like a rule and was not one.
    let wide = false;
    if (/^\*\./.test(head)) { wide = true; head = head.slice(2); }
    const raw = head
      .replace(/^www\./i, "")
      .split("#")[0];
    const q = raw.indexOf("?");
    const beforeQuery = q < 0 ? raw : raw.slice(0, q);
    const query = q < 0 ? "" : raw.slice(q + 1).replace(/[?&]+$/, "");
    const [hostRaw, ...rest] = beforeQuery.split("/");
    // A trailing dot is the same host to DNS, so it must not survive into a stored
    // pattern either — otherwise the list holds two spellings of one site.
    const host = hostRaw.replace(/\.+$/, "");
    if (!host) return "";
    // Reject anything that can't be a host name. Without this, pasting a stray line
    // of text was accepted as a "site": it matched nothing ever, sat in the list
    // looking like a rule, and the only feedback was a cheerful "Added".
    if (/[\s<>"'`\\]/.test(host)) return "";
    // A host name and nothing else. The matcher compares against a URL's `hostname`,
    // which never contains a wildcard, credentials or a port — so `*.reddit.com`,
    // `me@example.com` and `reddit.com:443` were all stored happily, shown as chips
    // that look like rules, and matched nothing, ever. A bare `:port` is dropped
    // rather than refused, since typing one is a reasonable mistake and the rule means
    // the same site either way. Bracketed IPv6 keeps its colons.
    const bracketed = /^\[.*\]$/.test(host);
    const bare = bracketed ? host : host.replace(/:\d+$/, "");
    if (!bare) return "";
    if (!bracketed && !/^[a-z0-9.-]+$/i.test(bare)) return "";
    const looksLikeHost = bare.includes(".") || bare === "localhost" || bracketed;
    if (!looksLikeHost) return "";
    // The path is resolved the way a browser resolves it, because that is what the
    // matcher will be comparing against: the background canonicalises through
    // `new URL()`, so a stored `/../..` or `/a/../b` could never match anything. Empty
    // and "." segments go, ".." pops the one before it.
    const segs = [];
    for (const seg of rest.join("/").split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") { segs.pop(); continue; }
      segs.push(seg);
    }
    const path = segs.join("/");
    return (wide ? "*." : "") + bare + (path ? "/" + path : "") + (query ? "?" + query : "");
  }

  // Every address in a stretch of text you selected on a page, for the right-click menu: one site, or
  // a whole selected list of them, each stored exactly as typing it into the box would store it, in the
  // order they appear and each once.
  //
  // A selection is prose, not a box you typed an address into, so a word has to LOOK like a site before
  // it becomes one: a name with a dot and a real-looking last label, an IP address, or localhost. Without
  // that, "e.g." and "3.5" from the sentence around a link would each have become a rule. Punctuation
  // hugging a word goes first — the quotes and brackets around an address, the full stop after it —
  // except a closing bracket the address opened itself, as in a Wikipedia link.
  //
  // Twenty at most from one selection. A whole page selected by accident is not a list of rules.
  const SITES_IN_TEXT_MAX = 20;
  function plausibleSite(v) {
    const host = String(v || "").replace(/^\*\./, "").split(/[/?]/)[0].toLowerCase();
    if (host === "localhost" || /^\[[0-9a-f:.]+\]$/.test(host)) return true;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host.split(".").every(n => Number(n) <= 255);
    return /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:[a-z]{2,24}|xn--[a-z0-9-]{2,59})$/.test(host);
  }
  function unwrapWord(w) {
    let s = String(w || "").replace(/^[("'“‘\[<{«]+/, "");
    const count = (c) => s.split(c).length - 1;
    for (;;) {
      const last = s.slice(-1);
      if (!last) break;
      // A closing bracket stays while the address has an opening one of its own to match it.
      if (last === ")" && count("(") >= count(")")) break;
      if (last === "]" && count("[") >= count("]")) break;
      if (!/[)"'”’\]>}».,;:!?]/.test(last)) break;
      s = s.slice(0, -1);
    }
    return s;
  }
  function sitesInText(text) {
    const out = [], seen = new Set();
    for (const word of String(text || "").slice(0, 20000).split(/[\s,;|]+/)) {
      const v = normSite(unwrapWord(word));
      if (!v || !plausibleSite(v)) continue;
      const k = v.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(v);
      if (out.length >= SITES_IN_TEXT_MAX) break;
    }
    return out;
  }

  const names = () => (v) => {
    if (!Array.isArray(v)) return bad;
    const seen = new Set(), out = [];
    for (const item of v.slice(0, MAX_LIST)) {
      const name = trimmed(item);
      if (!name || name.length > 300 || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
    return { ok: true, value: out };
  };
  // A web address, for the phone bridge. Empty is fine and means "not set up" — the switch can be
  // on with a box still blank, and the worker simply has nothing to send.
  //
  // Only the shape is checked, never the host. The address is a webhook MacroDroid generated on the
  // user's own phone (trigger.macrodroid.com/<device-id>/<name>), and a self-hosted relay or
  // MacroDroid's own LAN "HTTP Server Request" trigger are both legitimate — so pinning it to one
  // host here would refuse setups that work. What actually stops this becoming "fetch anything the
  // file says" is the manifest: only trigger.macrodroid.com is granted outright, and anything else
  // has to be allowed by the user at the moment they paste it. See fireMacrodroid in background.js.
  //
  // Capped at 500 characters, and http as well as https, for the LAN case — a phone on your own
  // network has no certificate.
  const httpUrl = () => (v) => {
    const s = trimmed(v);
    if (!s) return { ok: true, value: "" };
    if (s.length > 500) return bad;
    if (!/^https?:\/\/[^\s]+$/i.test(s)) return bad;
    return { ok: true, value: s };
  };
  // A Gemini model name: "gemini-flash-latest", "gemini-2.5-flash", "models/gemini-2.5-pro".
  //
  // Checked for SHAPE, not for membership of a list. Model names are Google's to add and retire, and
  // a fixed allow-list in here would be a list that goes stale — refusing the newer model somebody
  // has every right to type, in a build nobody can update for them. A name that does not exist comes
  // back from the API as a 404, which the settings page shows you verbatim, and that is a far better
  // error than "this file is invalid".
  //
  // The character class is the point of it: this string is spliced into a URL path, so anything that
  // could end the path or start a query — a slash beyond the optional "models/" prefix, "?", "#", a
  // space, "." — would be a way to aim the request at another endpoint on the same host. Letters,
  // digits, dashes and dots only, with dots allowed because versions carry them.
  // Empty is accepted and means "use the default"; the caller substitutes it.
  const modelName = () => (v) => {
    const s = trimmed(v);
    if (!s) return { ok: true, value: "" };
    if (s.length > 80) return bad;
    if (!/^(models\/)?[a-z0-9][a-z0-9.\-]*$/i.test(s)) return bad;
    return { ok: true, value: s };
  };
  // The seven weekday switches, indexed by getDay() — 0 Sunday … 6 Saturday. See gates.js for why
  // the storage order is getDay()'s and not the Monday-first order the picker shows.
  //
  // Exactly seven entries or the key is dropped, and dropping leaves whatever you already had. A
  // short or long array cannot be repaired here without guessing which end the missing days belong
  // to, and a guess would silently hand somebody a day off they never asked for — or take one away.
  // Every entry is read `!== false`, matching FGGates.activeDays, so a JSON null reads as "on".
  //
  // All seven false is refused outright rather than clamped. Seven days off is the extension switched
  // off, and there is a power button for that; accepting it out of a file would leave the popup
  // showing "Locked" with nothing on earth being blocked.
  const days = () => (v) => {
    if (!Array.isArray(v) || v.length !== 7) return bad;
    const out = v.map(x => x !== false);
    if (!out.some(Boolean)) return bad;
    return { ok: true, value: out };
  };
  // [{ deck, sec }]. A quota of zero seconds is a quota that is always already met, so
  // those are dropped rather than kept as a gate that does nothing.
  const deckTimes = () => (v) => {
    if (!Array.isArray(v)) return bad;
    const seen = new Set(), out = [];
    for (const item of v.slice(0, MAX_LIST)) {
      if (!item || typeof item !== "object") continue;
      const deck = trimmed(item.deck);
      const sec = Number(item.sec);
      if (!deck || deck.length > 300 || seen.has(deck)) continue;
      if (!Number.isFinite(sec) || sec <= 0) continue;
      seen.add(deck);
      out.push({ deck, sec: Math.min(359999, Math.round(sec)) });
    }
    return { ok: true, value: out };
  };
  // What the AI half is allowed to read, as three named booleans and nothing else.
  //
  // Rebuilt key by key rather than passed through, and that is the whole reason it is a checker rather
  // than a wave-through. The worker spreads this object into a prompt-building path, so a file that
  // added a fourth key would be a file adding a field to something it does not own — and every value
  // is read `!== false` there, so an unexpected key with a truthy value would read as "on".
  //
  // Missing means on, matching ytAiScopeOf in background.js. The two must agree: one of them decides
  // what happens and the other decides what a backup can say happens.
  const aiScope = () => (v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return bad;
    return {
      ok: true,
      value: {
        description: v.description !== false,
        tags: v.tags !== false,
        transcript: v.transcript !== false
      }
    };
  };

  // A set of category ids, for the two AI category lists.
  //
  // Checked against SITE_CATEGORIES rather than merely cleaned, and that is the point: an id nothing
  // recognises would sit in the list looking like a rule while matching nothing, for ever — the worst
  // shape a blocklist entry can have. A file naming a category this build has dropped loses that one
  // entry and keeps the rest, which is the right trade for a backup.
  //
  // A closure over SITE_CATEGORIES, which is defined much further down. That is fine: nothing calls it
  // until something validates a key, and by then the whole module has evaluated.
  const catIdList = () => (v) => {
    if (!Array.isArray(v)) return bad;
    const known = new Set(SITE_CATEGORIES.map(c => c.id));
    const out = [], seen = new Set();
    for (const raw of v.slice(0, 200)) {
      const id = String(raw == null ? "" : raw).trim();
      if (!id || !known.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    // Spelt out like every other checker in this file. It used to call an `ok()` helper that was never
    // defined, so the first array this met threw a ReferenceError — and since the worker writes both
    // lists into storage as [] on install, that was every export, and every import that carried them.
    return { ok: true, value: out };
  };

  // The longest a goal can be: 99h 59m 59s, which is what the three boxes on the
  // settings page can hold between them.
  const MAX_GOAL = 99 * 3600 + 59 * 60 + 59;

  // ---- the table ----
  // Ranges match the min/max on each control in options.js. Where they would ever
  // disagree, the tighter one wins, because this side is the one reading a file.
  const SPEC = {
    // look and feel
    theme: oneOf("dark", "light"),
    camOverlayEnabled: bool(),
    soundEffectsEnabled: bool(),
    ankiGlowEnabled: bool(),

    // the day, the door, the master switch
    enabled: bool(),
    // Which weekdays it works on. A setting you chose, so it travels in a backup.
    activeDays: days(),
    dailyResetTime: time(),
    // Whether the password door is used at all. The hash itself is never in a backup —
    // see NOT_SETTINGS. So restoring `true` onto a fresh profile asks you to make a new
    // password rather than letting you in with the old one.
    passwordProtectionEnabled: bool(),
    autoLockDelaySec: int(0, 3600),
    fullPageLockEnabled: bool(),

    // strict mode
    strictModeEnabled: bool(),
    // The date strict mode is committed until. In a backup on purpose — it is a setting you chose,
    // and a restore that dropped it would be a way to end a commitment early by exporting before
    // and importing after. The import side refuses to move it closer; see options.js.
    strictUntil: date(),
    strictUntilTime: time(),
    strictUntilEnabled: bool(),
    strictStart: time(),
    strictEnd: time(),

    // what gets blocked
    blockMode: oneOf("blacklist", "whitelist"),
    blockedSites: sites(),
    allowedSites: sites(),

    // the goal
    ankiRequiredSec: int(0, MAX_GOAL),

    // WHEN the goal has to be finished. Both deadlines travel in a backup: they are rules you set
    // for yourself, exactly like the goal above. What does NOT travel is the two stamps they are
    // measured against — ankiMetAt and ankiGraceFrom — which are measurements of today and sit in
    // NOT_SETTINGS with ankiSpentSec. A file that could set those would be a file that hands you a
    // deadline already satisfied, or one already blown.
    ankiWinEnabled: bool(),
    ankiWinStart: time(),
    ankiWinEnd: time(),
    ankiGraceEnabled: bool(),
    // 0 to 12 hours. Zero is legal and means "the goal and not a second more"; the ceiling is well
    // past any real answer and is there to refuse nonsense rather than to express a preference. The
    // options page clamps to the same pair, deliberately — a value that got past this check must not
    // then be quietly clamped somewhere else, or the two limits drift and the page shows a number
    // the gate is not using.
    ankiGraceSec: int(0, 12 * 3600),

    // is Anki really in front of you
    ankiRequireForeground: bool(),

    // the camera, and the four things it checks
    // The floating window, whether or not the camera is in it. Its own key, because the clock
    // being on screen and the camera watching you are two separate decisions.
    ankiTimerWindow: bool(),
    ankiAutoCam: bool(),
    ankiFaceRequired: bool(),
    faceSensitivity: int(1, 5),
    ankiEyeRequired: bool(),
    eyeSensitivity: int(1, 5),
    eyeAwaySec: int(0, 600),
    ankiLivenessEnabled: bool(),
    livenessIntervalSec: int(0, 1800),
    moveSensitivity: int(1, 5),
    ankiBlinkRequired: bool(),
    blinkIntervalSec: int(0, 600),
    blinkSensitivity: int(1, 5),

    // is the studying itself real
    ankiActiveGrading: bool(),
    ankiPerCardCapSec: int(5, 600),
    ankiIdleGraceSec: int(5, 60),
    // The mouse inactivity tracker. Its own pair of keys rather than a mode of
    // ankiIdleGraceSec just above, because the two wait for different things: that one waits
    // for an ANSWERED CARD, this one waits for a hand. A long card you are still reading is
    // exactly the case where the first should be patient and the second should not, so
    // folding them together would mean choosing which of the two to get wrong.
    //
    // 5 to 600, matching the range FocusGate uses for the same setting. The floor is 5 rather
    // than 0 on purpose: "the instant you stop" is not a usable value for a check that samples
    // twice a second, and 0 here would be an off switch wearing a number's clothes.
    ankiInactivityPauseEnabled: bool(),
    ankiInactivityTimeoutSec: int(5, 600),
    ankiMediaRequired: bool(),
    // Not a gate — it does not decide whether time counts. It travels with the gate anyway
    // because it is the same preference about the same thing, and a backup that restored one
    // without the other would be restoring half an opinion.
    ankiMediaPauseEnabled: bool(),
    ankiMediaResumeEnabled: bool(),
    // How far back the video is wound when it is paused. 0 means "pause where it is".
    ankiMediaRewindSec: int(0, 120),
    // Credit time faster while your face fills the focus box on the camera picture and slower while
    // it does not, and the two multipliers that says. Tenths, because they are set with a slider and
    // "2.35×" is not a thing anyone means.
    ankiPaceEnabled: bool(),
    ankiPaceFast: dec(1, 4, 1),
    ankiPaceSlow: dec(0.1, 1, 1),
    // The focus box's size, as a percent of the camera picture's shorter side. The same bounds
    // study.js clamps to — FOCUS_MIN and FOCUS_MAX there — because a value this file accepts out of a
    // backup and a value that page would then quietly change is a backup that does not restore.
    ankiPaceBoxPct: int(30, 85),
    ankiAntiSpamEnabled: bool(),
    ankiMinSecPerCard: dec(0.2, 30, 1),
    ankiMinCardsEnabled: bool(),
    ankiMinCards: int(1, 9999),
    ankiUniqueOnly: bool(),
    ankiDeckRestrictEnabled: bool(),
    ankiDecks: names(),

    // only watch videos about the card you are on — by its words here, by the AI check further down —
    // and freeze the collection so the card cannot be rewritten into a key for something else
    ytGateEnabled: bool(),
    // Whether watching an allowed video counts towards the goal, and how much of the goal it may
    // account for. The cap tops out at two hours, which is already past the point where this stops
    // being "a lecture helped me with a card" — the range exists to stop a hand-edited file setting
    // something absurd, not to be used.
    ytWatchCounts: bool(),
    ytWatchCapSec: int(0, 7200),
    // How many of the card's keywords a video title must carry. 1 to 5 — the same range the
    // settings page offers, and a ceiling at all because a card rarely yields more than a
    // handful of keywords and "needs 9" would be a gate nothing can pass.
    ytGateMinHits: int(1, 5),
    // Where the two video rules run: YouTube itself, and the videos Google plays inside its own
    // results page. See videoOnYouTube in DEFAULTS.
    videoOnYouTube: bool(),
    videoOnGoogle: bool(),
    // The same pair for searches. Same range as the video gate's, for the same reason and with
    // the same ceiling — see searchGateMinHits in DEFAULTS for why the top of the range is there
    // to match its neighbour rather than because anybody should use it.
    searchGateEnabled: bool(),
    searchGateMinHits: int(1, 5),
    // The AI check, a rule of its own beside the word check above. The switch and the threshold
    // travel in a backup; the KEY does not — see NOT_SETTINGS, where it sits with the password hash.
    //
    // Restoring `ytAiEnabled: true` onto a machine with no key stored is deliberately fine, and it is
    // the strict direction: the rule is on and has nothing to ask with, so every video it judges stays
    // covered and the cover says a key is missing. Nothing is let through by a restore. Same shape as
    // passwordProtectionEnabled restoring without its hash.
    ytAiEnabled: bool(),
    ytAiMinPct: int(0, 100),
    // The model name. Still accepted, and still checked for shape, so that a backup made by an older
    // build — which let you type any Gemini model — restores without an error. It no longer decides
    // anything: the Model row offers exactly two services, the worker names the model for each (see
    // ytAiModelOf), and a leftover name here is ignored rather than put in charge of the gate.
    ytAiModel: modelName(),
    // WHO answers: Google's Gemini, or Groq. oneOf rather than a string check, because this value picks
    // the address the card front is sent to — a value arriving out of a file has to be one of exactly
    // these two words. Groq's own key is not in here; like the Gemini key it is in NOT_SETTINGS.
    ytAiProvider: oneOf("gemini", "groq"),

    // ---- whole categories of site, decided by asking ----
    //
    // The AI half of the category picker. The chips beside it write ordinary domains into the two lists;
    // these hold CATEGORY IDS, and every site you open is classified against them.
    aiCatEnabled: bool(),
    aiCatBlock: catIdList(),
    aiCatAllow: catIdList(),
    // How deeply the AI looks, and at what. Both travel in a backup, and both are safe to: neither
    // decides whether a video is allowed, they decide what the model is shown before it decides.
    //
    // oneOf rather than a string check, because this value selects a code path. "video" hands a link to
    // Google for it to fetch, so a value arriving out of a file has to be one of exactly three words
    // and not merely a plausible-looking one.
    ytAiMode: oneOf("title", "details", "video"),
    ytAiScope: aiScope(),
    ankiLockCollection: bool(),
    ankiLockAddons: bool(),
    ankiLockNewCards: bool(),

    // the other things that have to be finished
    ankiDueGateEnabled: bool(),
    ankiDueAllowed: int(0, 999),
    ankiDueDecks: names(),
    ankiRetentionEnabled: bool(),
    ankiMinRetention: int(1, 100),
    ankiDeckTimeEnabled: bool(),
    ankiDeckTimes: deckTimes(),

    // apps on your phone, blocked through MacroDroid until today's Anki is done
    //
    // In a backup, all three, because they are exactly the kind of thing a backup is for: two
    // addresses you copied off your phone once and would otherwise have to go and find again.
    // Which APPS get blocked is not in here and cannot be — that list lives inside the macro on
    // the phone, and this side only ever says "lock" or "unlock".
    macrodroidEnabled: bool(),
    macrodroidLockUrl: httpUrl(),
    macrodroidUnlockUrl: httpUrl()
  };

  // ---- everything else in DEFAULTS, and why it is not in a backup ----
  // Kept as a list rather than left implicit so the worker can prove the two together
  // cover every key, and so the reason is written down next to the key it belongs to.
  const NOT_SETTINGS = {
    // Secrets and the live state of the door. A hash in a backup file is the door in a
    // backup file.
    passwordHash: "secret",
    sessionUnlocked: "live",
    autoLockDueAt: "live",
    // Your Gemini API key. A credential, so the same rule as the password hash: a key in a backup
    // file is a key in a backup file, and this one can be spent. It is also not portable in any
    // useful sense — it belongs to a Google account, not to a configuration — so carrying it would
    // be all of the risk for none of the convenience.
    ytAiKey: "secret",
    // Your Groq API key, when Groq is the one answering. A credential for the same reasons as the
    // Gemini key above, and kept out of a backup the same way.
    ytAiGroqKey: "secret",
    // The one-time marker for the AI check becoming a rule of its own (see onInstalled in
    // background.js). A fact about this install's history, not a choice — and restoring it from a file
    // would either replay that change or skip it on a profile that still needs it.
    ytAiSplitDone: "bookkeeping",

    // What the classifier decided about each site. A CACHE, not a setting — and carrying it would be
    // worse than useless: it is a set of answers about the web at one moment, so a year-old backup would
    // restore a year-old opinion of every site in it and suppress the re-ask that would correct it. The
    // categories you picked do travel; the answers are re-earned.
    aiCatSeen: "reading",

    // Today. Restoring any of these is handing yourself time you did not spend.
    lastResetAt: "bookkeeping",
    ankiSpentSec: "today",
    ankiReviewedToday: "today",
    ankiRawToday: "today",
    ankiUniqueToday: "today",
    ankiRetPass: "today",
    ankiRetAgain: "today",
    ankiDeckSpent: "today",
    allDoneCelebratedOn: "today",
    ankiCamDoneDismissedOn: "today",
    // The two instants the deadlines are measured against. Measured, not configured, and the reason
    // they must never come out of a file is sharper than for the rest of this group: ankiMetAt is
    // "when today's goal was reached", so a backup carrying one would either hand over an unlock
    // nobody earned or withhold one they did — and ankiGraceFrom is "when Anki was first opened
    // today", so a restored one would be an allowance that had already run out.
    ankiMetAt: "today",
    ankiGraceFrom: "today",
    userPaused: "live",

    // Progress. Earned, not configured.
    xp: "progress",
    level: "progress",
    streakCount: "progress",
    lastStreakDate: "progress",

    // Readings of your collection, and when they were taken. ankiGoalsAt of 0 means
    // "nothing measured today", which is what makes an unmeasurable gate stand aside —
    // so a fabricated timestamp here would enforce gates on numbers nobody measured.
    ankiGoalsAt: "reading",
    // Which card you are on and what it is about. Derived from whatever Anki is showing this
    // second, so it is a reading in the strictest sense — and one that MUST NOT travel in a
    // backup, because a file carrying a keyword list would be a file that decides which videos
    // are allowed. That is the whole cheat the collection lock exists to prevent, arriving by
    // the back door.
    ankiCardId: "reading",
    ankiCardKeywords: "reading",
    // The card front itself, kept for the AI matcher to read. A reading in the same strict sense as
    // the keywords above, and excluded for a stronger version of the same reason: a backup file
    // carrying a card front would be a file that both decides which videos are allowed AND contains
    // somebody's study material. Neither belongs in a settings export.
    ankiCardFront: "reading",
    // Today's video time. Restoring it would be handing yourself minutes you did not watch, which
    // is the same reason ankiSpentSec is in here.
    ytWatchedSec: "today",
    // Whether Anki is actually refusing edits right now, as reported by the add-on.
    ankiLockActive: "live",
    // And whether it is refusing to open the add-on manager. Same reasoning: a reading taken from
    // the add-on, describing this moment on this machine, so it must not travel in a backup.
    ankiLockAddonsActive: "live",
    // And whether it is refusing new cards. The same kind of reading again.
    ankiLockNewActive: "live",
    ankiReviewBaseline: "reading",
    ankiDueLeft: "reading",
    ankiDueAtDayStart: "reading",
    ankiLastDeck: "reading",

    // Live plumbing, rewritten by the next poll a few seconds later.
    ankiConnected: "live",
    ankiStudying: "live",
    ankiReason: "live",
    // When the clock stopped. About this moment, like the two above, and meaningless in a backup.
    ankiStoppedAt: "live",
    // Whether a video is stalling. Rewritten by the next poll like the two above, and meaningless
    // in a backup for the same reason: it describes the network a moment ago.
    ankiMediaWaiting: "live",
    // And what auto-resume is doing about it. Same kind of thing: a sentence about this instant.
    ankiResumeState: "live",
    ankiLastPollAt: "live",
    ankiLastReviewAt: "live",
    ankiCreditedSinceAnswer: "live",
    ankiFacePresent: "live",
    ankiFaceAt: "live",
    // Whether your head is in the focus box right now. A reading taken four times a second by the
    // camera window, not a choice — restoring it from a backup would restore a posture.
    ankiFaceBoxed: "live",
    // Whether your face is in the focus box right now, expressed as a multiplier. A reading, not a
    // choice — carrying it in a backup would restore a posture.
    ankiFacePace: "live",
    ankiBridgeOk: "live",
    ankiBridgeVersion: "live",
    // Whether a video we stopped is still waiting to be put back, and when we stopped it. A record
    // of one thing having happened on this machine a moment ago, not a choice — and it must not
    // travel, because a restored file asserting a debt would have the extension press play on
    // whatever happened to be on the card at the time.
    ankiMediaResumeOwedAt: "live",

    // What was last pushed to the phone, and when. A record of one message having been
    // delivered, not a choice — and it must not travel, for a reason worth spelling out: it is
    // the dedupe that stops the same webhook being fired every three seconds, so a file could
    // otherwise assert "already unlocked" and the phone would never be told to lock. The worker
    // rebuilds both within a minute of a restore anyway.
    mobileLockSent: "live",
    mobileLockAt: "live",

    // This machine, not this configuration. A window position and a local URL scheme
    // mean nothing on the computer you restore onto.
    ankiCamBounds: "machine",
    // Window ids. Meaningless on another computer and meaningless after a browser restart on this
    // one, which is exactly why they must never travel in a backup: this list decides what gets
    // closed.
    ankiCamWinIds: "machine",
    ankiLaunchScheme: "machine",
    ankiPinSupported: "machine",
    // Whether the camera window's close button is off right now. A reading taken from the add-on
    // twice a second, not a choice — and it describes a window on this machine, so it would mean
    // nothing on the one you restore onto.
    ankiCamCloseBlocked: "live",

    // Forced to true on every read (see sanitizeState), so carrying it would be
    // theatre: whatever the file said, the value would be true a moment later.
    ankiEnabled: "healed"
  };

  const FORMAT = "block-sites-until-i-complete-anki/settings";
  const VERSION = 1;

  // Everything in SPEC that this state actually has, ready to be written to a file.
  // Cleaned on the way out as well as in, so a value that got into storage before a
  // range existed cannot be handed on to the next profile.
  function collect(state) {
    const out = {};
    for (const [key, check] of Object.entries(SPEC)) {
      if (!state || !(key in state)) continue;
      const r = check(state[key]);
      if (r.ok) out[key] = r.value;
    }
    return out;
  }

  function fileFor(state, appVersion) {
    return {
      format: FORMAT,
      version: VERSION,
      app: String(appVersion || ""),
      exportedAt: new Date().toISOString(),
      settings: collect(state)
    };
  }

  // Read a parsed file. Returns what to write, and an account of what happened —
  // the settings page shows the counts before asking whether to go ahead, because
  // "42 settings restored, 3 ignored" is the difference between a restore you trust
  // and one you have to go and check by hand.
  //
  // A bare settings object is accepted as well as a wrapped file. Someone will paste
  // one, and refusing it would be pedantry rather than safety: every value is checked
  // either way, so the wrapper is a courtesy, not a guard.
  function read(parsed) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "That file isn't a settings backup." };
    }
    const wrapped = parsed.settings && typeof parsed.settings === "object" && !Array.isArray(parsed.settings);
    if (parsed.format && parsed.format !== FORMAT) {
      return { ok: false, error: "That backup is from a different extension." };
    }
    if (Number(parsed.version) > VERSION) {
      return { ok: false, error: "That backup was made by a newer version of this extension." };
    }
    const body = wrapped ? parsed.settings : parsed;
    const patch = {}, skipped = [], unknown = [];
    for (const [key, value] of Object.entries(body)) {
      const check = SPEC[key];
      // Not a setting, or not a setting we know: left out without comment for the
      // bookkeeping keys, since a file made by an older version legitimately has none
      // of them, and named otherwise so a typo in a hand-edited file is visible.
      if (!check) { (key in NOT_SETTINGS ? skipped : unknown).push(key); continue; }
      const r = check(value);
      if (r.ok) patch[key] = r.value; else skipped.push(key);
    }
    if (!Object.keys(patch).length) {
      return { ok: false, error: "Nothing in that file could be read as a setting." };
    }
    return { ok: true, patch, count: Object.keys(patch).length, skipped, unknown };
  }

  // Which DEFAULTS keys this file has an opinion about, and which it has forgotten.
  // Used by the worker at startup — see checkSettingsSpec in background.js.
  // One value, checked by the same rule the file import uses. For a control that has to validate
  // what was typed into it before writing: the settings page should never be able to store a value
  // that this file would have rejected coming out of a backup, or the file becomes the stricter of
  // the two ways in and the page the loose one.
  // ---------------------------------------------------------------------------
  // Which way is stricter
  //
  // Two separate features in this extension need to ask the same question about a change, and until
  // now they each answered it in their own scattered way:
  //
  //   strict mode  — refuses a loosening outright while it is on.
  //   the password — asks for the password before a loosening, and lets a tightening straight
  //                  through. Turning a check ON is the direction you are trying to go in; making
  //                  someone prove who they are to do it is friction pointed the wrong way.
  //
  // Both are the same question, so it is answered once, here, beside the table that already knows
  // what every key is. Before this, the direction lived at each call site — a `strictDir` argument
  // on some number boxes, a hand-written comparison in a few handlers, and nothing at all on the
  // rest. "Nothing at all" is the reason for this table: a setting nobody remembered to guard is a
  // setting you can quietly ease off mid-session, and there is no way to notice one by reading the
  // page.
  //
  //   "up"    a bigger number is stricter. Raising is a tightening.
  //   "down"  a smaller number is stricter. Lowering is a tightening.
  //   "on"    true is stricter. Switching on is a tightening.
  //   "off"   false is stricter — the rare inverse. A switch that makes the goal EASIER to reach is
  //           one you are letting yourself off with, so turning it on is the loosening.
  //   "list"  a longer list is stricter — the blocklist. Adding tightens, removing loosens.
  //   "short" a shorter list is stricter — the allowlist. Removing tightens, adding loosens.
  //   "filled" having a value is stricter than not having one. Emptying the box is the loosening;
  //           swapping one non-empty value for another is neither direction.
  //   "free"  neither direction is stricter than the other, so neither gate has an opinion.
  //
  // A key that is not in here at all is treated as "free": it is a preference, not a rule. That is
  // the safe default for the password gate (it does not nag about the theme) and the honest one for
  // strict mode, which has its own explicit refusals for the things it freezes outright.
  const STRICTER = {
    // ---- the goal, and what counts towards it ----
    ankiRequiredSec: "up",          // more Anki is more Anki
    // ---- WHEN it has to be finished ----
    // Switching either deadline on adds a way to fail the day, so it goes through unasked; switching
    // one off hands back a way of failing, so it is the loosening and wants the password.
    ankiWinEnabled: "on",
    ankiGraceEnabled: "on",
    // Less grace is less rope, so DOWN is the tightening: raising it is what asks.
    ankiGraceSec: "down",
    // The two window times are "free", and that is a judgement rather than an oversight. Which
    // direction is stricter depends entirely on the pair: moving the end EARLIER shortens the window
    // and is a tightening, moving the START earlier lengthens it and is a loosening, and moving
    // either across the other turns a four-hour window into a twenty-hour one. A single direction per
    // key would be wrong about half of those, and a rule that is wrong half the time is worse than no
    // rule. What actually protects them is the switch above: with a deadline running, strict mode
    // freezes the settings page outright, so the hours cannot be edited at all while it is in force.
    ankiWinStart: "free",
    ankiWinEnd: "free",
    // ankiEnabled is deliberately NOT here. It is a "healed" key — sanitizeState forces it true on
    // every read — so it can never be false to begin with, and a direction for a value that cannot
    // move is a rule nobody will ever meet and everybody will believe in. Every key in this table is
    // checked against SPEC by a test for exactly this reason.
    ankiMinCardsEnabled: "on",
    ankiMinCards: "up",
    ankiUniqueOnly: "on",           // counting each card once throws answers away
    ankiDueGateEnabled: "on",
    ankiDueAllowed: "down",         // fewer cards allowed to still be due
    ankiRetentionEnabled: "on",
    ankiMinRetention: "up",         // a higher share right
    ankiDeckTimeEnabled: "on",
    ankiDeckTimes: "list",          // one more deck quota is one more thing to finish
    ankiDeckRestrictEnabled: "on",  // narrowing what counts is narrowing

    // ---- anti-cheat ----
    ankiRequireForeground: "on",
    ankiActiveGrading: "on",
    ankiPerCardCapSec: "down",      // one card is worth less
    ankiIdleGraceSec: "down",       // less grace before the clock waits
    ankiInactivityPauseEnabled: "on",
    ankiInactivityTimeoutSec: "down",   // the clock stops after less stillness
    ankiMediaRequired: "on",
    ankiMediaPauseEnabled: "on",
    // Deliberately absent from this table, which reads as "free" — a preference, not a rule.
    //
    // ankiMediaResumeEnabled looks at first like the loose direction of the switch above: the pause
    // costs you video you did not watch, and this puts some of it back. It does not, and the reason is
    // when it fires. The resume is only ever sent at a moment when the clock would already be running
    // if the video were playing — your face in frame, Anki in front, the right deck, no break — so it
    // cannot buy a second of credit that was not already yours. The only thing it removes is a click.
    // Classifying it as a loosening would put the password in front of a convenience, which is how a
    // gate stops being taken seriously.
    ankiMediaRewindSec: "up",       // winding further back costs you more of the video
    // The one inverse in the table. Every other switch here asks MORE of you when it is on; this one
    // hands out time faster than the clock, so switching it on is the thing you would want a
    // password for and switching it off is free.
    ankiPaceEnabled: "off",
    // Both "down", and for the same reason as the switch: a bigger number on either slider means the
    // goal arrives sooner. A faster reward is obvious; a milder penalty is the same thing said the
    // other way round, since sliding "slow" up towards 1 removes the cost of slouching.
    ankiPaceFast: "down",
    ankiPaceSlow: "down",
    // "up", and this one is the other way round from its two neighbours. The box is a size your head
    // has to SPAN, so a bigger box means sitting closer to earn the fast speed — harder, not easier.
    // Shrinking it is the loosening, because a small box can be filled from across the room.
    ankiPaceBoxPct: "up",
    ankiAntiSpamEnabled: "on",
    ankiMinSecPerCard: "up",        // more answers thrown away as too fast

    // ---- the camera ----
    ankiAutoCam: "on",
    ankiFaceRequired: "on",
    ankiEyeRequired: "on",
    ankiBlinkRequired: "on",
    ankiLivenessEnabled: "on",
    // The three dials all read 1 = fussiest, 5 = most forgiving, so a LOWER number asks more of you.
    faceSensitivity: "down",
    eyeSensitivity: "down",
    moveSensitivity: "down",
    // Three sliding deadlines. A smaller one comes round sooner and asks more often; 0 turns the
    // check off, which is why 0 has to be reachable only as a loosening — and it is, being smaller
    // is "down" and these are "down"… so 0 is a TIGHTENING by this table. It is not.
    //
    // That is a real hole and it is closed at the value, not here: the three boxes floor at 1 in the
    // page's own ranges when their check is on, so "0" is not a value the box can produce. The table
    // stays simple and the range does the work — the alternative is a direction that means one thing
    // above zero and the opposite at it.
    livenessIntervalSec: "down",
    eyeAwaySec: "down",
    blinkIntervalSec: "down",

    // ---- the card as a key ----
    ytGateEnabled: "on",
    // Where the video rules run. Each one on is one more place a video has to be about your card, so
    // switching either OFF is the loosening — it hands that site's videos back — and asks for the
    // password like switching a rule off does.
    videoOnYouTube: "on",
    videoOnGoogle: "on",
    // "off", like ankiPaceEnabled and for the same reason: this is one of only two switches in the
    // whole table that make the goal EASIER to reach, so switching it ON is the loosening.
    ytWatchCounts: "off",
    // A smaller cap means less of the goal can come from video, so smaller is stricter.
    ytWatchCapSec: "down",
    // Needing MORE of the card's keywords in a title is the stricter direction: fewer videos
    // qualify. So raising it tightens and lowering it is the loosening that gets asked about.
    ytGateMinHits: "up",
    // The search gate reads exactly like the video gate above it: switching it on takes searches
    // away, and needing more of the card's words in a query lets fewer through. So "on" and "up"
    // are both the tightening direction.
    searchGateEnabled: "on",
    searchGateMinHits: "up",
    // The AI check, and it reads exactly like the word check above it now: "on" is the tightening.
    //
    // It used to be "off", and that was right for what it was then — a second opinion that could only
    // PASS a video the words had refused, so switching it on could only widen what played. It is a
    // rule of its own now. With it on, a video plays only if the AI says it is about your card, and
    // with the word check on as well, a video has to pass both. Either way, switching it on can only
    // take videos away, and switching it off can only hand them back.
    //
    // So turning it ON is free (with the "make this stricter?" check when the page is locked), and
    // turning it OFF asks for your password and is refused during a strict window — the same as every
    // other rule in this table.
    ytAiEnabled: "on",
    // A higher bar means the AI has to be more certain, so fewer videos get through: up is stricter,
    // and lowering it is the loosening. Exactly like ytGateMinHits beside it.
    ytAiMinPct: "up",
    // The key gets the same treatment as a webhook address, and it needs it for a reason the switch
    // alone does not cover.
    //
    // With ytAiEnabled on and the key box empty, the AI check has nothing to ask with, so every video
    // it judges stays covered. Pasting a key into that box is therefore the moment videos start getting
    // through — and swapping one key for another is a way to point the check at an account set up to
    // answer however you like. "url" means any change at all is treated as a loosening, which is right
    // here for the same reason it is right there: there is no change to a credential that can be
    // trusted to only ever tighten.
    //
    // It is in NOT_SETTINGS rather than SPEC — it never travels in a backup — and that is no obstacle:
    // this table is consulted on its own, so a key can be guarded without being exportable.
    ytAiKey: "url",
    // Groq's key, for the same reason: pasting one is the moment an inert AI half starts answering.
    ytAiGroqKey: "url",

    // The AI category lists, and the two point in OPPOSITE directions for the same reason the two typed
    // lists do: a longer block list shuts more of the web, and a longer allow list opens more of it.
    // Switching the feature on can only ever take sites away, so "on" is the tightening.
    aiCatEnabled: "on",
    aiCatBlock: "list",
    aiCatAllow: "short",
    // Which model answers is neither stricter nor looser — it is not a rule, it is who you asked.
    // Left out of this table entirely, which means "free"; named here only so the next person does
    // not read the omission as an oversight.
    // ytAiModel: free
    //
    // The same goes for WHICH SERVICE answers — Gemini or Groq. Each has its own key, and each key is
    // guarded above ("url"), as is the switch; so the only thing switching services can do is point
    // the same approved switch at a key that was itself approved. Free, so somebody whose Gemini quota
    // runs out mid-way through a strict window can still move to Groq.
    // ytAiProvider: free
    //
    // How DEEPLY it looks, and at WHICH of the video's fields, are free for the same reason and it is
    // worth spelling out because the first instinct is to call "title only" the loose one.
    //
    // It isn't. These change what the model is SHOWN, not what it has to conclude — the bar it must
    // clear is ytAiMinPct above, and that is guarded. More evidence moves a score in whichever
    // direction the truth lies: reading the subtitles rescues an honest lecture called "Lec 14" and it
    // also sinks a vlog with a study-shaped title. Neither is a direction, so neither can be one here.
    //
    // The consequence is deliberate: somebody in a strict window can still switch from watching the
    // whole video to reading the subtitles when a check is taking too long, which is a change to how
    // the rule is measured and not a way out of it.
    // ytAiMode:  free
    // ytAiScope: free
    ankiLockCollection: "on",
    // Switching it on takes the master switch away from you mid-session, which is as strict as
    // anything in this table gets.
    ankiLockAddons: "on",
    // No new cards until the goal is done. On is the stricter side: turning it off mid-session is
    // exactly the "just this one card" it exists to refuse.
    ankiLockNewCards: "on",

    // ---- the week ----
    // Its own direction, because none of the six above describe it. It is a fixed-length array of
    // seven switches, so "list"/"short" (which compare lengths) would call every change to it
    // neither-way — and turning Friday off is the plainest loosening in the extension: a whole day
    // on which nothing is blocked.
    activeDays: "days",

    // ---- the lists ----
    blockedSites: "list",
    allowedSites: "short",
    // Swapping the mode is not a direction. An empty allowlist is the strictest thing in the
    // extension and a full one is the loosest, so which way this moves depends entirely on what is
    // in the lists — and a guess either way would be wrong half the time. Strict mode refuses the
    // swap outright instead, which is a rule that cannot be wrong.
    blockMode: "free",

    // ---- the phone ----
    macrodroidEnabled: "on",        // one more surface locked until Anki is done
    // "url": any change to a webhook URL is sensitive and requires password authentication.
    macrodroidLockUrl: "url",
    macrodroidUnlockUrl: "url",

    // ---- the doors ----
    autoLockDelaySec: "down",       // locking sooner
    strictModeEnabled: "on",
    strictUntilEnabled: "on",
    passwordProtectionEnabled: "on",
    fullPageLockEnabled: "on"
  };

  // Does this patch loosen anything, measured against what is stored now?
  //
  // Any one key loosening makes the whole patch a loosening. Patches here are small and deliberate,
  // and a patch that tightens one thing while easing another is exactly the shape a gate must not
  // wave through on the strength of its better half.
  //
  // A value equal to what is already stored is not a change in either direction. This matters more
  // than it looks: the settings page rewrites whole groups of keys at once, so most keys in a patch
  // are usually identical to what is there — and treating "same" as "loosening" would ask for the
  // password on every save.
  function loosens(patch, current) {
    for (const key of Object.keys(patch || {})) {
      if (loosensKey(key, patch[key], (current || {})[key])) return true;
    }
    return false;
  }

  // One key. Exported too, because the callers that guard a single control want to say which one.
  function loosensKey(key, next, cur) {
    const dir = STRICTER[key];
    if (!dir || dir === "free") return false;
    if (dir === "on") {
      // `next === false` rather than `!next`: a patch that does not mention this key arrives here as
      // undefined, and "not mentioned" is not "switched off".
      //
      // `cur !== false` rather than `cur === true` is the deliberate half. An absent current value
      // means we do not know what it was, and this is a self-discipline guard — so not knowing is
      // answered the strict way, by asking. In practice it never comes up: the worker writes every
      // DEFAULTS key on install, so there is always a current value to compare against.
      return next === false && cur !== false;
    }
    if (dir === "off") {
      // The mirror of the above, and the same care about "not mentioned": undefined is not `true`.
      return next === true && cur !== true;
    }
    if (dir === "url") {
      // Editing, adding or clearing a webhook address requires password confirmation.
      if (next === undefined) return false;
      const curStr = typeof cur === "string" ? cur.trim() : "";
      const nextStr = typeof next === "string" ? next.trim() : "";
      return nextStr !== curStr;
    }
    // An address that stops being an address. Only the empty/non-empty distinction is judged:
    // swapping one webhook for another is a repair, not a direction, and treating it as a
    // loosening would ask for the password every time somebody corrected a typo.
    //
    // A patch that does not mention the key arrives as undefined, which is "not mentioned" and not
    // "cleared" — so the emptiness test is explicit rather than `!next`.
    if (dir === "filled") {
      const had = typeof cur === "string" && cur.trim() !== "";
      const has = typeof next === "string" && next.trim() !== "";
      return next !== undefined && had && !has;
    }
    // Seven switches judged one at a time: any day that was on and is now off is a loosening, and
    // turning days on is always free. Position matters, so this cannot be a length comparison —
    // swapping Saturday off for Sunday on leaves the length alone and is still a day of nothing being
    // blocked that was not there before.
    if (dir === "days") {
      if (!Array.isArray(next) || next.length !== 7) return false;   // junk is the validator's problem
      // No current value to compare against means we cannot say a day was taken away. The worker
      // writes every DEFAULTS key on install, so in practice there always is one.
      if (!Array.isArray(cur) || cur.length !== 7) return false;
      for (let i = 0; i < 7; i++) if (cur[i] !== false && next[i] === false) return true;
      return false;
    }
    if (dir === "list" || dir === "short") {
      const a = Array.isArray(cur) ? cur.length : null;
      const b = Array.isArray(next) ? next.length : null;
      // Not comparable — one of them is not a list — so no claim either way. A junk value is the
      // validator's problem, not this function's.
      if (a === null || b === null) return false;
      return dir === "list" ? b < a : b > a;
    }
    const x = Number(cur), y = Number(next);
    // An unreadable number is not evidence of a direction. It cannot be stored either: every one of
    // these keys goes through SPEC on the way in.
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    return dir === "up" ? y < x : y > x;
  }

  // The mirror of loosensKey: does this patch make rules harder / tighter?
  function tightensKey(key, next, cur) {
    if (key === "blockMode") {
      return next === "whitelist" && cur !== "whitelist";
    }
    const dir = STRICTER[key];
    if (!dir || dir === "free" || dir === "url") return false;
    if (dir === "on") {
      return next === true && cur === false;
    }
    if (dir === "off") {
      return next === false && cur === true;
    }
    if (dir === "filled") {
      const had = typeof cur === "string" && cur.trim() !== "";
      const has = typeof next === "string" && next.trim() !== "";
      return next !== undefined && !had && has;
    }
    if (dir === "days") {
      if (!Array.isArray(next) || next.length !== 7) return false;
      if (!Array.isArray(cur) || cur.length !== 7) return false;
      for (let i = 0; i < 7; i++) if (cur[i] === false && next[i] !== false) return true;
      return false;
    }
    if (dir === "list" || dir === "short") {
      const a = Array.isArray(cur) ? cur.length : null;
      const b = Array.isArray(next) ? next.length : null;
      if (a === null || b === null) return false;
      return dir === "list" ? b > a : b < a;
    }
    const x = Number(cur), y = Number(next);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    return dir === "up" ? y > x : y < x;
  }

  function tightens(patch, current) {
    for (const key of Object.keys(patch || {})) {
      if (tightensKey(key, patch[key], (current || {})[key])) return true;
    }
    return false;
  }

  const TIGHTEN_LABELS = {
    blockMode: "allowlist mode (blocking all other sites)",
    blockedSites: "the blocked sites list",
    allowedSites: "the allowlist",
    macrodroidEnabled: "phone app blocking",
    ankiRequiredSec: "your study time goal",
    ankiWinEnabled: "the finish-by-time deadline",
    ankiGraceEnabled: "the time limit on finishing",
    ankiGraceSec: "the grace time on your limit",
    ankiMinCardsEnabled: "minimum card review count",
    ankiMinCards: "minimum cards quota",
    ankiUniqueOnly: "unique cards requirement",
    ankiDueGateEnabled: "due cards gate",
    ankiDueAllowed: "due cards tolerance",
    ankiRetentionEnabled: "retention accuracy requirement",
    ankiMinRetention: "retention target percentage",
    ankiDeckTimeEnabled: "deck time quota",
    ankiDeckTimes: "deck-specific time quotas",
    ankiDeckRestrictEnabled: "deck restrictions",
    ankiRequireForeground: "Anki foreground requirement",
    ankiActiveGrading: "active grading requirement",
    ankiPerCardCapSec: "per-card credit cap",
    ankiIdleGraceSec: "idle grace window",
    ankiInactivityPauseEnabled: "the mouse inactivity tracker",
    ankiInactivityTimeoutSec: "how long you can sit still",
    ankiMediaRequired: "media requirement",
    ankiMediaPauseEnabled: "media auto-pause",
    ankiMediaRewindSec: "media rewind duration",
    ankiPaceEnabled: "slouch penalty",
    ankiPaceFast: "fast pace threshold",
    ankiPaceSlow: "slouch threshold",
    ankiPaceBoxPct: "head position requirement",
    ankiAntiSpamEnabled: "anti-spam filter",
    ankiMinSecPerCard: "minimum time per card",
    ankiAutoCam: "automatic webcam window",
    ankiFaceRequired: "face detection check",
    ankiEyeRequired: "eye gaze requirement",
    ankiBlinkRequired: "blink detection",
    ankiLivenessEnabled: "liveness challenge",
    faceSensitivity: "face sensitivity",
    eyeSensitivity: "eye gaze sensitivity",
    moveSensitivity: "movement sensitivity",
    livenessIntervalSec: "liveness challenge frequency",
    eyeAwaySec: "look-away tolerance",
    blinkIntervalSec: "blink window duration",
    ytGateEnabled: "YouTube word check",
    // The AI check, now that switching it on is a tightening and can reach the "make this stricter?"
    // dialog. Named in the same words as its row in Settings.
    ytAiEnabled: "YouTube AI check",
    ytAiMinPct: "AI relevance bar",
    videoOnYouTube: "video checks on YouTube",
    videoOnGoogle: "video checks on Google",
    ytWatchCounts: "video counting restrictions",
    ytWatchCapSec: "video watch time cap",
    ytGateMinHits: "keyword match requirement",
    searchGateEnabled: "search relevance gate",
    searchGateMinHits: "search word requirement",
    ankiLockCollection: "Anki collection lock",
    ankiLockAddons: "Anki add-on protection",
    ankiLockNewCards: "no new Anki cards",
    activeDays: "active study days",
    autoLockDelaySec: "auto-lock timer",
    strictModeEnabled: "scheduled strict mode",
    strictUntilEnabled: "strict commitment deadline",
    fullPageLockEnabled: "full-page password lock"
  };

  // ---- whole categories of site --------------------------------------------
  //
  // Ready-made groups for filling the blocked and allowed lists, so nobody has to remember every
  // address themselves.
  //
  // DATA ONLY, and that is the design rather than a limitation. Pressing a category writes ORDINARY
  // DOMAINS into blockedSites or allowedSites — the same entries typing them by hand would produce —
  // so nothing new is stored, no new key has to be validated or backed up, the chips can be removed
  // one at a time afterwards, and the background worker never learns that categories exist. Which
  // also decides what a second press does: with the whole set already on the list, it takes the whole
  // set back off, because a one-way button would leave fifteen entries to remove by hand.
  //
  // It lives in this file because both the settings page and the tests need it and neither should own
  // a second copy — a list of domains that disagreed with the list somebody pressed would be a rule
  // nobody could see.
  //
  // BARE HOSTS, no "*." prefixes. Blocking a host already covers its subdomains (see hostMatches in
  // background.js), and on the allow list a bare host deliberately does not — which is the right
  // default there too, since opening one site should not open everything hanging off it.
  //
  // Not exhaustive and not trying to be. It is the well-known handful per category, the ones somebody
  // would actually reach for; the box beside it takes anything this misses. A group of fifteen social
  // networks is not "social media" — it is fifteen doors shut in a corridor with no walls — and the
  // honest thing is to say so in the tooltip rather than to pretend the list is complete.
  const SITE_CATEGORIES = [
    { id: "social", icon: "💬", name: "Social media", sites: [
      "facebook.com", "instagram.com", "threads.net", "twitter.com", "x.com", "tiktok.com",
      "snapchat.com", "linkedin.com", "tumblr.com", "vk.com", "weibo.com", "mastodon.social",
      "bsky.app", "pinterest.com", "quora.com" ] },
    { id: "chat", icon: "✉️", name: "Chats & messaging", sites: [
      "web.whatsapp.com", "web.telegram.org", "discord.com", "messenger.com", "slack.com",
      "teams.microsoft.com", "signal.org", "wechat.com", "line.me", "viber.com" ] },
    { id: "video", icon: "📺", name: "Video & streaming", sites: [
      "youtube.com", "netflix.com", "primevideo.com", "hotstar.com", "disneyplus.com", "hulu.com",
      "twitch.tv", "dailymotion.com", "vimeo.com", "hbomax.com", "max.com", "peacocktv.com",
      "zee5.com", "sonyliv.com", "jiocinema.com", "mxplayer.in", "crunchyroll.com" ] },
    { id: "shorts", icon: "📱", name: "Short video & reels", sites: [
      "tiktok.com", "kwai.com", "triller.co", "josh.in", "moj.tv", "snackvideo.com" ] },
    { id: "games", icon: "🎮", name: "Games", sites: [
      "roblox.com", "store.steampowered.com", "steamcommunity.com", "epicgames.com", "miniclip.com",
      "poki.com", "crazygames.com", "y8.com", "friv.com", "addictinggames.com", "chess.com",
      "lichess.org", "coolmathgames.com", "itch.io", "kongregate.com", "agar.io", "slither.io",
      "krunker.io", "ea.com", "battle.net", "xbox.com", "playstation.com" ] },
    { id: "news", icon: "📰", name: "News", sites: [
      "news.google.com", "bbc.com", "cnn.com", "nytimes.com", "theguardian.com", "foxnews.com",
      "ndtv.com", "timesofindia.indiatimes.com", "hindustantimes.com", "indianexpress.com",
      "aljazeera.com", "reuters.com", "apnews.com", "news.ycombinator.com", "washingtonpost.com",
      "dailymail.co.uk", "buzzfeed.com" ] },
    { id: "shopping", icon: "🛒", name: "Shopping", sites: [
      "amazon.com", "amazon.in", "flipkart.com", "ebay.com", "aliexpress.com", "myntra.com",
      "ajio.com", "meesho.com", "walmart.com", "target.com", "etsy.com", "shein.com", "temu.com",
      "nykaa.com", "snapdeal.com", "alibaba.com" ] },
    { id: "forums", icon: "🗣️", name: "Forums & aggregators", sites: [
      "reddit.com", "9gag.com", "4chan.org", "imgur.com", "digg.com", "somethingawful.com",
      "quora.com", "stackexchange.com" ] },
    { id: "music", icon: "🎧", name: "Music & podcasts", sites: [
      "spotify.com", "soundcloud.com", "music.apple.com", "music.youtube.com", "deezer.com",
      "pandora.com", "gaana.com", "jiosaavn.com", "wynk.in", "audiomack.com", "bandcamp.com",
      "last.fm", "tidal.com" ] },
    { id: "ai", icon: "🤖", name: "AI chatbots", sites: [
      "chatgpt.com", "chat.openai.com", "gemini.google.com", "claude.ai", "perplexity.ai",
      "copilot.microsoft.com", "character.ai", "poe.com", "deepseek.com", "grok.com", "you.com" ] },
    { id: "sports", icon: "⚽", name: "Sports", sites: [
      "espn.com", "cricbuzz.com", "espncricinfo.com", "nba.com", "nfl.com", "fifa.com",
      "goal.com", "skysports.com", "bleacherreport.com", "sports.yahoo.com", "livescore.com",
      "formula1.com", "wwe.com" ] },
    { id: "mail", icon: "📧", name: "Email & webmail", sites: [
      "mail.google.com", "outlook.com", "outlook.live.com", "mail.yahoo.com", "mail.proton.me",
      "mail.com", "aol.com", "rediff.com" ] },
    { id: "anime", icon: "🌸", name: "Anime & manga", sites: [
      "crunchyroll.com", "myanimelist.net", "9anime.to", "gogoanime.tv", "animeflv.net",
      "mangadex.org", "manganato.com", "webtoons.com", "anilist.co" ] },
    { id: "memes", icon: "😂", name: "Memes & humour", sites: [
      "9gag.com", "imgur.com", "knowyourmeme.com", "theonion.com", "cheezburger.com",
      "boredpanda.com", "funnyjunk.com" ] },
    { id: "dating", icon: "💘", name: "Dating", sites: [
      "tinder.com", "bumble.com", "hinge.co", "okcupid.com", "match.com", "badoo.com",
      "grindr.com", "pof.com", "happn.com" ] },
    { id: "gambling", icon: "🎲", name: "Gambling & betting", sites: [
      "bet365.com", "draftkings.com", "fanduel.com", "pokerstars.com", "888casino.com",
      "williamhill.com", "betway.com", "stake.com", "dream11.com", "my11circle.com",
      "rummycircle.com" ] },
    { id: "crypto", icon: "📈", name: "Crypto & trading", sites: [
      "binance.com", "coinbase.com", "coinmarketcap.com", "coingecko.com", "kraken.com",
      "tradingview.com", "robinhood.com", "wazirx.com", "zerodha.com", "groww.in", "etoro.com",
      "bybit.com", "kucoin.com" ] },
    { id: "torrent", icon: "🏴", name: "Torrents & piracy", sites: [
      "thepiratebay.org", "1337x.to", "rarbg.to", "torrentgalaxy.to", "yts.mx", "nyaa.si",
      "limetorrents.lol", "fitgirl-repacks.site", "libgen.is" ] },
    { id: "adult", icon: "🔞", name: "Adult", sites: [
      "pornhub.com", "xvideos.com", "xnxx.com", "xhamster.com", "redtube.com", "youporn.com",
      "onlyfans.com", "chaturbate.com", "stripchat.com", "brazzers.com", "spankbang.com",
      "eporner.com", "rule34.xxx", "nhentai.net" ] },
    { id: "images", icon: "🖼️", name: "Image boards & galleries", sites: [
      "deviantart.com", "artstation.com", "pixiv.net", "flickr.com", "500px.com",
      "unsplash.com", "behance.net" ] }
  ];

  function tightenedLabel(patch, current) {
    for (const key of Object.keys(patch || {})) {
      if (tightensKey(key, patch[key], (current || {})[key])) {
        return TIGHTEN_LABELS[key] || key;
      }
    }
    return "these settings";
  }

  function checkOne(key, value) {
    const rule = SPEC[key];
    if (typeof rule !== "function") return { ok: false };
    return rule(value);
  }
  function unaccounted(defaultKeys) {
    return (defaultKeys || []).filter(k => !(k in SPEC) && !(k in NOT_SETTINGS));
  }
  function phantom(defaultKeys) {
    const known = new Set(defaultKeys || []);
    return [...Object.keys(SPEC), ...Object.keys(NOT_SETTINGS)].filter(k => !known.has(k));
  }

  root.FGSettings = {
    FORMAT, VERSION, SPEC, NOT_SETTINGS, STRICTER,
    collect, fileFor, read, checkOne, unaccounted, phantom,
    loosens, loosensKey,
    tightens, tightensKey, tightenedLabel,
    // How an address is stored, for both lists and every place that adds to them. See normSite.
    normSite, sitesInText, MAX_LIST,
    // Whole categories of site, for filling the two lists. DATA ONLY — nothing stores a category.
    SITE_CATEGORIES
  };
})(typeof self !== "undefined" ? self : this);
