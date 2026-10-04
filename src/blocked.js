// The "earn it first" page. One thing stands between you and the site you asked
// for — today's Anki goal — so this page has one row on it, and it sends you back
// the moment that row is finished.

// Reloading or updating the extension leaves this page open with its link to the
// extension already gone, and then every poll throws "Extension context
// invalidated" into the console. Asked before anything is sent, so the page just
// goes quiet instead.
function extensionAlive() {
  try { return !!(chrome.runtime && chrome.runtime.id); } catch { return false; }
}
function fmt(s) { s = Math.max(0, num(s) | 0); const m = Math.floor(s / 60), x = s % 60; return `${m}m ${String(x).padStart(2, "0")}s`; }
// A finite number or the fallback — never NaN, never Infinity, never a string.
//
// This page reads storage directly, and storage can hold the wrong type: an older
// build, a half-finished write, a mangled profile. `Math.min(1800, "abc")` is NaN,
// and a NaN reaching the markup means `width:NaN%` — invalid CSS the browser drops
// without a word, so the bar just never moves and nothing explains why.
function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function esc(v) { return String(v == null ? "" : v).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

const QUOTES = [
  "Discipline is choosing between what you want now and what you want most.",
  "You don't rise to your goals, you fall to your systems.",
  "Small daily improvements compound into staggering results.",
  "Focus is saying no to a thousand good things.",
  "The pain of discipline weighs ounces; the pain of regret weighs tons.",
  "Repetition is the mother of retention."
];
// Null-checked like every other lookup on this page, and here it matters most: this is
// the first statement in the file, and a throw would abort the module before the storage
// listener and the recovery loop at the bottom are installed — leaving the one page whose
// job is to let you out with nothing running to let you out.
const quoteEl = document.getElementById("quote");
if (quoteEl) quoteEl.textContent = `"${QUOTES[Math.floor(Math.random() * QUOTES.length)]}"`;
const params = new URLSearchParams(location.search);
const fromUrl = params.get("from") || "";
// Why the video gate refused this, and what the video was called.
//
// Read off THIS page's address rather than asked of the worker, and that is not laziness. Every
// other verdict here can be re-derived by handing the URL back — "is reddit.com blocked" has the
// same answer a minute later. A video's is different: it was decided from the TITLE, and by the time
// this page is running the tab has already left the video, so the title is gone. The worker knew it
// at the moment it decided, so the worker writes it down. See blockedPageUrl.
const ytWhy = params.get("why") || "";
const ytTitle = params.get("vt") || "";
// The AI's score for this title, and the bar you set it. -1 for "there was no score" — the AI half is
// off, or it never got as far as answering. Read through parseInt with a range clamp because these
// arrive in an address bar, which anybody can type into.
const ytAiPct = (() => {
  const n = parseInt(params.get("ap"), 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : -1;
})();
const ytAiNeed = (() => {
  const n = parseInt(params.get("an"), 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : -1;
})();
// The model's own one-line reason, and the list of what it was actually shown.
//
// Here for the same reason the title and the score are: they existed only at the moment the verdict was
// made, and the tab has since left the video. Without them this page can announce a refusal but not
// explain it — "the AI scored it 20%" invites "20% of what?", and "it watched the video and it is a
// cricket highlights reel" is the answer.
//
// Both are TRUNCATED HERE as well as at the other end, because they arrive in an address bar and
// anybody can type into one. Nothing is ever put into the page as markup: see esc, used at every use
// site below.
const ytAiReason = (params.get("ar") || "").slice(0, 160);
const ytAiRead = (params.get("ad") || "").slice(0, 120)
  .split(",").map(s => s.trim()).filter(Boolean).slice(0, 6);
// Whether the word check was one of the rules that decided this. Only ever sent as "0" — the AI check
// on its own — so every address written before there were two rules, and every refusal made with the
// word check on, reads exactly the way it always did.
const ytWordsOn = params.get("wg") !== "0";
// What went wrong, when the AI tried to answer and could not. The worker's own sentence, which names the
// fix. Truncated here as well, because it arrives in an address bar.
const ytAiErr = (params.get("ae") || "").slice(0, 200);

// The score, broken down field by field: "t60,d0o,x5" — a letter for the field, its own percentage, and
// an optional letter for a row that has no number and a reason for not having one.
//
// Here for the same reason as everything above it: it existed only at the moment of the verdict. And it
// is what turns "20%" from an announcement into something you can argue with — a title that scored 60
// beside subtitles that scored 5 says exactly where the refusal came from, and that the title was the
// part doing the lying.
//
// Parsed defensively throughout. This arrives in an address bar; an unknown letter, a missing number and
// a hand-typed thousand are all simply dropped rather than trusted, and nothing from it is ever put into
// the page as markup.
const YT_AI_FIELD_NAMES = {
  t: "Title", c: "Channel", d: "Description", g: "Tags", x: "Subtitles", v: "The video itself"
};
const YT_AI_FIELD_STATES = {
  o: "off", a: "not on the page", n: "none on this video", u: "couldn't be read", p: "needs permission"
};
const ytAiFields = (params.get("af") || "").slice(0, 100)
  .split(",").map(s => s.trim()).filter(Boolean).slice(0, 6)
  .map(part => {
    const letter = part.slice(0, 1);
    if (!YT_AI_FIELD_NAMES[letter]) return null;
    const rest = part.slice(1);
    const num = parseInt(rest, 10);
    const stateLetter = rest.replace(/^-?\d*/, "").slice(0, 1);
    return {
      label: YT_AI_FIELD_NAMES[letter],
      score: Number.isFinite(num) ? Math.max(0, Math.min(100, num)) : null,
      // "off" is the only state that means "you turned this off"; the rest are all things the video or
      // YouTube did. Kept apart because only the first is something to change.
      off: stateLetter === "o",
      text: YT_AI_FIELD_STATES[stateLetter] || ""
    };
  })
  .filter(Boolean);

// The site you were trying to reach, said the way you'd say it out loud.
function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; }
}
const blockedHost = hostOf(fromUrl);

// The full address is only worth showing when it can't be shortened to a hostname —
// otherwise it's the headline again in smaller type, which is the one thing this
// page has too much of.
const fromEl = document.getElementById("from");
if (fromEl) fromEl.textContent = blockedHost ? "" : (fromUrl || "(unknown)");

// The site's own favicon, from the browser's cache — no network request of ours, and
// nothing leaves this machine. Needs the "favicon" permission in the manifest.
function faviconUrl(u, size = 64) {
  try {
    const url = new URL(chrome.runtime.getURL("/_favicon/"));
    url.searchParams.set("pageUrl", u);
    url.searchParams.set("size", String(size));
    return url.toString();
  } catch { return ""; }
}
// A first-letter tile, for the moment there's no icon to be had.
function letterTile(slot, host) {
  slot.innerHTML = `<span class="ltr">${esc((host || "?").charAt(0))}</span>`;
}
// Where the blocked site's icon comes from: the browser's own favicon cache, and
// nothing else.
//
// There used to be three more sources, and every one of them made a request that left
// the machine — Google's gstatic CDN for a handful of named Google apps, then the
// blocked site's own /favicon.ico and /apple-touch-icon.png. Two problems with that,
// and the second is the one that decided it.
//
//   It contradicted the promise. The comment above faviconUrl says "no network request
//   of ours, and nothing leaves this machine", and this extension's whole claim is that
//   it watches you locally and tells nobody. Three of the four sources told somebody:
//   gstatic learned that this browser was being shown a Gmail block, and the blocked
//   site itself got a request at the exact moment you were refused entry — from a page
//   whose only purpose is to record that you tried.
//
//   And it was requesting it from the one site you are being kept away from. A
//   distraction site that wants to know you are trying to reach it now finds out, on a
//   timer, every time.
//
// The cache covers any site you have actually visited in this profile, which is every
// site anybody puts on a block list. When it has nothing, the first-letter tile stays —
// which is the same thing that happened before whenever all four sources missed.
function siteIconSources() {
  const out = [];
  if (!fromUrl) return out;
  let u = null;
  try { u = new URL(fromUrl); } catch { return out; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return out;
  const cached = faviconUrl(fromUrl, 64);
  if (cached) out.push(cached);
  return out;
}
function paintSiteIcon() {
  const slot = document.getElementById("siteIcon");
  if (!slot) return;
  const queue = siteIconSources();
  // Shown straight away and left in place until an icon has actually decoded, so the
  // box is never empty and never flickers.
  letterTile(slot, blockedHost);
  if (!queue.length) return;

  const img = document.createElement("img");
  img.alt = "";
  img.decoding = "async";
  // The extension's own URL is nobody else's business.
  img.referrerPolicy = "no-referrer";
  const next = () => {
    const src = queue.shift();
    // Out of places to look. Said once, in the console, because "the letter showed
    // instead of the logo" is otherwise a silent failure with no way to tell whether
    // the site has no icon or the permission simply hasn't taken effect yet.
    if (!src) {
      try {
        console.debug("[blocked page] no icon found for", blockedHost,
          "— if the favicon permission was just added, reload the extension at chrome://extensions");
      } catch {}
      return;
    }
    img.src = src;
  };
  img.addEventListener("error", next);
  img.addEventListener("load", () => {
    // A 0x0 "success" is a broken image that didn't bother to say so.
    if (!img.naturalWidth) return next();
    slot.innerHTML = "";
    slot.appendChild(img);
  });
  next();
}
paintSiteIcon();

// The verdict, said once. Set here rather than in paint() because it can't change
// while the page is open, and paint() runs every few seconds.
const headEl = document.getElementById("head");
if (headEl) {
  headEl.innerHTML = blockedHost
    ? `${esc(blockedHost)} <span class="isblocked">is blocked</span>`
    : `This site <span class="isblocked">is blocked</span>`;
}

// Anki's actual logo, shipped with the extension as vector (icons/anki.svg, taken
// from Anki's own source tree). Two earlier goes at this were both wrong: a
// hand-drawn star that read as "some star" rather than "the app on your desktop",
// then Anki's 176px raster icon, which at 22px in a square box looked cropped —
// the artwork is a portrait card, and the padding around it pushed the card
// off-centre. Vector, cropped to the card, so it's sharp at any size and fills the
// space it's given. Local file: no network request, nothing to wait for.
const ANKI_LOGO = (() => {
  try { return `<img class="applogo" src="${chrome.runtime.getURL("icons/anki.svg")}" alt="" />`; }
  catch { return ""; }
})();

// barFill / barGlow come from bars.js, which this page loads first.

// The day / night button, top right.
const themeSlot = document.getElementById("themeSlot");
if (themeSlot && window.FGTheme) themeSlot.innerHTML = window.FGTheme.buttonHtml();

// Is Anki connected right now? `ankiConnected` is only ever as fresh as the last
// poll, so anything older than 25 seconds counts as "don't know".
function ankiLinkedNow(s) {
  if (!s || s.ankiEnabled === false || !s.ankiConnected) return false;
  return (Date.now() - num(s.ankiLastPollAt)) < 25000;
}
// Why the clock is or isn't running, in one short phrase.
function ankiStatusLine(s) {
  if (s.enabled === false) return "⏻ the extension is switched off";
  if (!ankiLinkedNow(s)) return "❌ Anki is not open";
  if (s.ankiStudying) return "⏱️ counting";
  switch (s.ankiReason) {
    case "paused": return "⏸️ paused by you";
    case "no_bridge": return "⏸️ paused — install the add-on in Anki";
    case "not_foreground": return "⏸️ paused — Anki isn't the window in front";
    case "not_fullwindow": return "⏸️ paused — make Anki fill the screen";
    case "in_browser": return "⏸️ paused — you're in the browser";
    case "no_reviewer": return "⏸️ paused — open a card";
    case "no_face": return "⏸️ paused — the camera can't see you";
    case "still": return "⏸️ paused — nothing has been touched in Anki";
    case "media_paused": return "⏸️ paused — press play on this card's video";
    case "media_buffering": return "⏳ paused — waiting for the video to load";
    case "wrong_deck": return "⏸️ paused — this deck doesn't count";
    case "spam": return "⚠️ answering too fast to count";
    case "same_card": return "⏸️ paused — move to the next card";
    case "idle": return "⏸️ paused — answer a card to start the clock";
    case "disconnected": return "❌ Anki is not open";
    default: return "⏸️ paused — answer a card";
  }
}
function infoTip(html) {
  return `<span class="tip" tabindex="0" role="button" aria-label="More information"><span class="tip-i" aria-hidden="true">?</span><span class="tip-box" role="tooltip">${html}</span></span>`;
}

// A one-line message, bottom middle. This page has no toast of its own and the
// Anki click needs to be able to explain itself.
function say(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { try { t.remove(); } catch {} }, 4200);
}

// Opening the Anki desktop app. Chrome cannot run a program, so the background
// picks between two routes: if Anki is running, the add-on inside it raises its
// own window; if it isn't, the add-on has registered a URL with Windows that
// starts Anki, and an extension page is allowed to open that one. Windows asks
// for permission the first time.
// The one scheme this extension registers. Checked, not trusted: the value arrives
// as JSON from whatever is answering on port 8766, and handing an arbitrary scheme to
// an <a href> means asking the browser to invoke an arbitrary registered handler.
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
function openAnkiApp() {
  try {
    chrome.runtime.sendMessage({ type: "ankiOpen" }, (r) => {
      void chrome.runtime.lastError;
      if (r && r.ok) return say("Opening Anki…");
      if (r && r.scheme && launchByScheme(r.scheme)) {
        say("Starting Anki…");
        // Opening the URL is all a page can do; the background watches for Anki
        // coming up and sends you to its download page if it never does.
        try { chrome.runtime.sendMessage({ type: "ankiLaunchWatch" }, () => void chrome.runtime.lastError); } catch {}
        return;
      }
      say("Could not start Anki — install it, or open it once and install the add-on from Settings");
    });
  } catch {}
}
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "ankiLaunchResult") return;
  if (msg.started) return say(msg.noAddon ? "Anki is open ✓ — install the add-on from Settings so it counts" : "Anki is open ✓");
  if (msg.openedDownload) say("Anki isn't installed on this computer — opened its download page.");
});

function getBlockInfo(url) {
  return new Promise((res) => {
    try {
      chrome.runtime.sendMessage({ type: "blockInfo", url }, (r) => {
        void chrome.runtime.lastError;
        res(r && r.info ? r.info : null);
      });
    } catch { res(null); }
  });
}

// Today's goal, or null when there isn't one.
//
// Every condition the user switched on comes from gates.js, so this page can name
// the one that is actually holding the site shut. It used to know about two of them,
// and would tell someone with a due gate on that they were "done" while this very
// page refused to go away.
function ankiRow(s) {
  const req = Math.max(0, num(s.ankiRequiredSec));
  if (s.ankiEnabled === false) return null;
  const spent = Math.min(req || Infinity, Math.max(0, num(s.ankiSpentSec)));
  const gates = FGGates.evaluate(s);
  // Not the clock: everything else, so the summary beside the name is the part this
  // page can't already show as a bar.
  const extra = gates.items.filter(i => i.key !== "time");
  return {
    req, spent,
    met: gates.met,
    // Every other gate, named, for the line under the bar. These used to hang off
    // the row's title as bare "3/20" fractions with nothing to say what they counted.
    extras: extra.map(i => `${i.label} ${i.have}/${i.need}`),
    // The logo sits beside this in the markup, so the name is the plain word.
    name: "Anki",
    note: ankiStatusLine(s),
    live: !!s.ankiStudying
  };
}

// The line under the headline. Empty while there's studying to do.
//
// It used to spell out the goal — "Study 60m 00s to unlock" — directly above a row
// that already read "60m 00s left · 0m 00s / 60m 00s". The headline says which site,
// the card below says what to do and how far along it is; this line is only for the
// two states that need words of their own.
function leadHtml(r) {
  const left = Math.max(0, r.req - r.spent);
  if ((left === 0 || r.req === 0) && r.met) return `You're done — this page will send you back in a moment.`;
  return "";
}

// The row's own status line: how far along, then every other gate, then why the
// clock is or isn't running. The single place the time is stated.
function metaText(r, done) {
  return [
    done ? "✅ done" : `${fmt(r.spent)} / ${fmt(r.req)}`,
    ...(done ? [] : r.extras),
    r.note
  ].filter(Boolean).join(" · ");
}

function rowHtml(r) {
  const pct = r.req ? Math.round(100 * Math.min(r.spent, r.req) / r.req) : (r.met ? 100 : 0);
  const left = Math.max(0, r.req - r.spent);
  const done = (left === 0 || r.req === 0) && r.met;
  const meta = esc(metaText(r, done));
  return `
    <div class="target${done ? " done" : ""}${r.live ? " live" : ""}">
      <div class="tbody">
        <div class="name">
          ${ANKI_LOGO}
          <a class="tlink" href="#" data-anki="1" title="Open the Anki desktop app"><span class="tname">${esc(r.name)}</span><span class="ext" aria-hidden="true">↗</span></a>
          ${r.live ? '<span class="nowtag">counting right now</span>' : ""}
        </div>
        <div class="meta">${meta}</div>
        <div class="progress"><div style="width:${pct}%;background:${barFill(pct)};box-shadow:${pct > 0 ? barGlow(pct) : "none"}"></div></div>
      </div>
      <a class="go" href="#" data-anki="1" title="Open the Anki desktop app" aria-label="Open the Anki desktop app">Open</a>
    </div>`;
}

// ---- the video gate's own words -----------------------------------------
// Four reasons a video can be refused, and they need four different sentences. Rolling them into
// one "this video isn't allowed" would leave the two most common cases — no card open, and a title
// that simply misses — looking identical, when the fix for one is "start reviewing" and for the
// other is "search for something else".
function ytHeading() {
  if (ytWhy === "ytshorts") return "Shorts stay shut ";
  if (ytWhy === "ytnocard") return "Open a card first ";
  if (ytWhy === "ytnotitle") return "Couldn't read this video ";
  if (ytWhy === "ytnoscript") return "Couldn't cover just the video ";
  // The AI check refusing without having judged the video. Not "not about this card": nobody found
  // that out, and a heading that claims it is a heading you argue with rather than act on.
  if (ytWhy === "ytainokey") return "The AI check isn't set up ";
  if (ytWhy === "ytaierror") return "The AI couldn't check this video ";
  return "Not about this card ";
}
// What the AI looked at and what it made of it — one clause, reused by the lead paragraph below and
// worth its own function because it has to say nothing at all when there was no score. Every other
// sentence on this page is about words; this is the only one about a judgement, so it never stands alone.
//
// The two figures themselves are not in it. The meter drawn right after it (ytAiMeterHtml, under the
// same condition) marks both — "▼ 50% needed", "▲ 20% got" — and says the gap, so "20% related, against
// the 50% you asked for" here would be every number on the page said twice.
function ytAiClause() {
  if (ytAiPct < 0 || ytAiNeed < 0) return "";
  // What it looked at, in the words the worker recorded. "the video itself" is the one entry that reads
  // as a whole phrase on its own, so it is used as written; everything else is a list of fields.
  const read = ytAiRead.length
    ? (ytAiRead.length === 1
        ? ytAiRead[0]
        : ytAiRead.slice(0, -1).join(", ") + " and " + ytAiRead[ytAiRead.length - 1])
    : "the title";
  const looked = read === "the video itself" ? "watched the video itself" : `read ${esc(read)}`;
  return ` The AI ${looked} and scored how closely it matches your card.` +
         (ytAiReason ? ` Its verdict: “${esc(ytAiReason)}”.` : "");
}
// The score on a line from 0 to 100 — the same meter the cover on YouTube draws (see aiMeterHtml in
// yt-mark.js): the bar you set, marked, with the passing stretch after it hatched; how far the video got,
// filled; and the gap in points underneath. Two numbers to compare, turned into one picture.
//
// Both numbers come from the address and were range-clamped where they were read (see ytAiPct), so the
// only thing that reaches a style attribute here is an integer from 0 to 100.
function ytAiMeterHtml() {
  if (ytAiPct < 0 || ytAiNeed < 0) return "";
  const p = ytAiPct, n = ytAiNeed;
  const pass = p >= n;
  const cls = pass ? "ok" : "bad";
  const gap = Math.abs(n - p);
  const pts = gap + (gap === 1 ? " point" : " points");
  const al = (x) => (x < 9 ? "l" : x > 91 ? "r" : "c");
  const say = pass
    ? (gap ? `<b>${pts} over</b> the ${n}% you set` : `exactly the ${n}% you set`)
    : `<b>${pts} short</b> of the ${n}% you set`;
  const label = `Scored ${p}% out of 100%. This card needs ${n}%. ` + (pass ? "It clears it." : `${pts} short.`);
  return `<div class="ytm" role="img" aria-label="${esc(label)}">` +
           `<div class="ytm-rail">` +
             `<span class="ytm-need ytm-al-${al(n)}" style="left:${n}%">▼ ${n}% needed</span>` +
             `<div class="ytm-track">` +
               (n < 100 ? `<span class="ytm-zone" style="left:${n}%;width:${100 - n}%"></span>` : "") +
               (p > 0 ? `<i class="ytm-fill ${cls}" style="width:${p}%"></i>` : "") +
               `<span class="ytm-tick" style="left:${n}%"></span>` +
               `<span class="ytm-knob ${cls}" style="left:${p}%"></span>` +
             `</div>` +
           `</div>` +
           `<div class="ytm-low">` +
             `<span class="ytm-end${p < 16 ? " ytm-hide" : ""}">0%</span>` +
             `<span class="ytm-got ${cls} ytm-al-${al(p)}" style="left:${p}%">▲ ${p}% got</span>` +
             `<span class="ytm-end ytm-hi${p > 84 ? " ytm-hide" : ""}">100%</span>` +
           `</div>` +
           `<div class="ytm-say ${cls}">${say}</div>` +
         `</div>`;
}
// The same score, field by field. Its own block rather than more clauses in the sentence above, because
// five numbers in prose is not something anybody reads — and the point of having them is that they are
// scannable: the row that disagrees with the others is the interesting one. Each row has the meter in
// miniature: its own score as a bar, your mark across it.
function ytAiFieldsHtml() {
  if (!ytAiFields.length || ytAiPct < 0) return "";
  const bar = ytAiNeed >= 0 ? ytAiNeed : 50;
  return `<div class="ytaif">` +
    `<div class="ytaif-h">Where that score came from</div>` +
    ytAiFields.map(f => {
      const has = typeof f.score === "number";
      // A dash, never a zero, for a row with no figure. A 0 against Subtitles would read as "it read them
      // and thought nothing of them" about a video that has none.
      const pct = has ? f.score + "%" : "—";
      const cls = has ? (f.score >= bar ? " ok" : " bad") : "";
      const meter = `<span class="ytaif-b" aria-hidden="true">` +
                    (has && f.score > 0 ? `<i class="${f.score >= bar ? "ok" : "bad"}" style="width:${f.score}%"></i>` : "") +
                    `<b style="left:${bar}%"></b></span>`;
      return `<div class="ytaif-r${f.off ? " off" : ""}">` +
             `<span class="ytaif-n">${esc(f.label)}</span>` +
             meter +
             `<span class="ytaif-s${cls}">${esc(pct)}</span>` +
             `<span class="ytaif-w">${esc(f.text)}</span>` +
             `</div>`;
    }).join("") +
    `</div>`;
}
function ytKeywordChips(s) {
  const kw = Array.isArray(s && s.ankiCardKeywords) ? s.ankiCardKeywords : [];
  if (!kw.length) return "";
  return kw.map(k => `<b class="ytkw">${esc(k)}</b>`).join(" ");
}
// The card you are on, as a box under the first sentence — the same one the cover over YouTube's
// player shows, so "not about the card you're on" comes with the card. Read from live state like the
// chips, so turning the card while this page is open moves it too. Made safe to show by
// FGKeywords.cardShown — every cloze answer hidden, cut to a reminder's length — and escaped here.
function ytCardBoxHtml(s) {
  const text = window.FGKeywords && FGKeywords.cardShown ? FGKeywords.cardShown(s && s.ankiCardFront) : "";
  if (!text) return "";
  return `<div class="ytcard"><b class="ytcard-l">Your card</b>${esc(text)}</div>`;
}
function ytLeadHtml(s) {
  const kw = Array.isArray(s && s.ankiCardKeywords) ? s.ankiCardKeywords : [];
  const chips = ytKeywordChips(s);
  const card = ytCardBoxHtml(s);
  if (ytWhy === "ytshorts") {
    return `<b>Shorts</b> is one endless feed rather than a video, so it stays shut while your goal is unfinished — one matching title would hand over all of it.<br/><br/>Search for the video you actually want instead.`;
  }
  if (ytWhy === "ytnocard") {
    return `You have <b>no card open in Anki</b>, so there is nothing this video could be relevant to.<br/><br/>Start reviewing, and videos about the card in front of you open by themselves.`;
  }
  if (ytWhy === "ytnotitle") {
    return `This page never told us what the video was called, so it couldn't be checked against your card${chips ? ` — which is about ${chips}` : ""}.<br/><br/>Try opening it again.`;
  }
  // The one refusal that is about this extension rather than the video. A video is refused inside its
  // own player, by the script this extension puts into YouTube — and in that tab the script could not
  // start even after the tab was reloaded for it, so there was no player cover to put up. Said as that,
  // with the fix: the worker's sweep sends the tab back to the video on its own, and a fresh page
  // normally does get the script.
  if (ytWhy === "ytnoscript") {
    return `AnkiGate couldn't start its script in that YouTube tab — even after reloading it — so it had no way to cover just the video player, and held the whole page instead.<br/><br/>The tab goes back to the video by itself in a minute or so. If this keeps happening, reload the extension in <b>chrome://extensions</b>, then the YouTube tab.`;
  }
  // The ordinary miss, and the useful one: name the video, then name what would have worked.
  const named = ytTitle ? `<b>${esc(ytTitle)}</b>` : "That video";
  const ai = ytAiClause();
  // The meter goes wherever the score is explained — in front of the rows, so the whole comes before
  // its parts.
  const rows = ytAiMeterHtml() + ytAiFieldsHtml();
  // The AI check had nothing to ask with. Nothing about the video was judged, so nothing is said about
  // it — only what is missing, and where to put it.
  if (ytWhy === "ytainokey") {
    return `The <b>AI check</b> is switched on, but it has no API key yet — so it can't tell whether this video is about your card, and until it can, videos stay shut.<br/><br/>Add a free key in <b>Settings → 🤖 AI detection</b>, or switch the AI check off there.`;
  }
  // It tried and could not answer. Said as a failure, in the worker's own words, because it is one: a
  // video held back by a quota error is not a video the AI judged unrelated.
  if (ytWhy === "ytaierror") {
    return `${named} couldn't be checked — ${esc(ytAiErr || "the AI didn't answer.")}<br/><br/>Until the AI can answer, videos stay shut: the AI check never opens a video it couldn't judge.`;
  }
  // Refused by the AI check. With the word check on as well, the title DID carry the card's words — it
  // had to, to be asked about at all — so the words are named as what passed, not as what failed.
  if (ytWhy === "ytainomatch") {
    return (ytWordsOn
      ? `${named} mentions your card, but the AI doesn't think it's about the same subject.`
      : `The AI compared ${ytTitle ? named : "that video"} with the front of the card you're on, and it isn't about the same subject.`) +
      `${card}${ai}${rows}<br/><br/>Move to another card and the question changes with it.`;
  }
  // Refused by the word check. The AI, if it is on, was never asked — a title the words refuse is not
  // sent — so all there is to say is what the title lacked, and what would have opened a video. Read
  // from the live state, like the chips, so the hint follows the settings as well as the card.
  const aiToo = !!(s && s.ytAiEnabled === true);
  if (!kw.length) {
    return `${named} was checked against the card you're on, and nothing matched.${card}${ai}${rows}<br/><br/>Open Anki and start reviewing to see which words would let a video through.`;
  }
  return `${named} doesn't mention what you're studying.${card}${ai}${rows}<br/><br/>Right now a video whose <b>title</b> contains ${chips} would open${aiToo ? " — if the AI agrees as well" : ""}. Move to another card and these change with it.`;
}
// The explanation behind the ?, about the rules rather than this one video. Two rules now, and either
// can be on without the other, so it says which are on — from the live state, the same as the lead —
// rather than describing both as though they always ran together.
function ytTipHtml(s) {
  const wordNow = s ? s.ytGateEnabled === true : ytWordsOn;
  const aiNow = s ? s.ytAiEnabled === true : ytAiPct >= 0;
  const rules = wordNow && aiNow
    ? "Two checks decide that, and both are on, so a video has to pass both: the <b>word check</b> — the card's words have to be in the video's <b>title</b> — and the <b>AI check</b>, where an AI compares the video with the front of your card."
    : aiNow
      ? "The <b>AI check</b> decides that: an AI compares the video — its title, and as much of the rest as you let it read — with the front of your card."
      : "The words are taken from the front of that card and matched against the video's <b>title</b>.";
  const depth = aiNow
    ? (ytAiRead.includes("the video itself")
        ? "<br/><br/>The AI is set to <b>watch the video</b>, so its verdict is about what is actually in it rather than about how it was named."
        : ytAiRead.includes("the subtitles")
          ? "<br/><br/>The AI is set to read <b>the details</b>, including the video's own subtitles — so its verdict is about what the video actually says rather than about how it was named."
          : "")
    : "";
  return "While today's <b>Anki</b> goal is unfinished, YouTube only opens videos about the card you are actually on. " + rules + depth +
    "<br/><br/><b>Search still works</b>, so you can go and find the right video. The home feed and <b>Shorts</b> do not.<br/><br/>Turn a card and the question changes with it. Finish your goal and all of this lifts.<br/><br/>You can switch these in <b>Settings → Study &amp; Unlock</b>, under <b>🔤 Word detection</b> and <b>🤖 AI detection</b>.";
}

// ---------- the search gate's own reason ----------
//
// Read off this page's address for the same reason the video's title is: the query only ever
// existed in the URL the tab has just left, so a page that had to ask for it again would have
// nothing to ask about.
//
// Separate parameter names from the video gate's. `why` being present is what switches this page
// into its video wording, so a search refusal arriving under that name would be explained in terms
// of a video nobody watched. See blockedPageUrl.
//
// Everything here arrives in an address bar, which anybody can type into: each is clamped on the
// way in and passed through `esc` at every use site below, exactly like the video gate's.
const searchWhy = params.get("sw") || "";
const searchQueryText = (params.get("sq") || "").slice(0, 160);
const searchEngine = (params.get("se") || "").slice(0, 40);
const searchKind = (params.get("st") || "").slice(0, 10);
const searchNeed = (() => {
  const n = parseInt(params.get("sn"), 10);
  return Number.isFinite(n) ? Math.max(1, Math.min(5, n)) : 1;
})();

// "Google video search", "Bing search" — what you were actually doing, in the words you would use.
// Worth naming because the same refusal on the Videos tab and on the web tab feel like different
// events, and because an engine nobody recognises being named back to them is how they find out the
// gate covers it.
function searchNamed() {
  const kind = searchKind === "videos" ? "video search"
    : searchKind === "images" ? "image search"
    : searchKind === "news" ? "news search"
    : "search";
  return (searchEngine ? esc(searchEngine) + " " : "") + kind;
}
// Two reasons a search can be refused, and they need two sentences: for one the answer is "start
// reviewing" and for the other it is "use a word from the card".
function searchHeading() {
  if (searchWhy === "searchnocard") return "Open a card first ";
  return "Not about this card ";
}
function searchLeadHtml(s) {
  const kw = Array.isArray(s && s.ankiCardKeywords) ? s.ankiCardKeywords : [];
  const chips = ytKeywordChips(s);
  if (searchWhy === "searchnocard") {
    return `You have <b>no card open in Anki</b>, so there is nothing this search could be relevant to.<br/><br/>Start reviewing, and searches about the card in front of you go straight through.`;
  }
  const named = searchQueryText
    ? `Your ${searchNamed()} for “<b>${esc(searchQueryText)}</b>”`
    : `That ${searchNamed()}`;
  if (!kw.length) {
    return `${named} was checked against the card you're on, and nothing matched.<br/><br/>Open Anki and start reviewing to see which words would let a search through.`;
  }
  // The useful half: not "that was refused" but "here is what would work". The chips come from live
  // state, so they follow the card while this page is open.
  const howMany = searchNeed > 1
    ? `at least <b>${searchNeed}</b> of ${chips}`
    : chips;
  return `${named} doesn't mention what you're studying.<br/><br/>Right now a search containing ${howMany} would go through. Move to another card and these change with it.`;
}
function searchTipHtml() {
  return "While today's <b>Anki</b> goal is unfinished, a search only goes through if it mentions the card you are actually on — the words are taken from the front of that card and matched against what you typed." +
    "<br/><br/>This one is <b>words only</b>. Nothing you type into a search box is sent anywhere, and unlike the video gate there is no AI second opinion on it — which has one honest cost: a genuine synonym the card never used will be refused. On a card about <i>aliasing</i>, searching for <i>nyquist rate</i> shares no word with it and does not go through. Use a word the card actually uses." +
    "<br/><br/>A search engine's <b>front page</b> is not a search, so it is never refused by this — only a query is." +
    "<br/><br/>Turn a card and the words change with it. Finish your goal and all of this lifts.<br/><br/>You can switch it off in <b>Settings → Study &amp; Unlock → 🔍 Searches about your card</b>.";
}

let INFO = null;
// Set once the first paint has happened. The storage listener is registered
// straight away (see the bottom of this file) rather than after the two awaits
// that boot the page, because the change that opens the gate can easily land in
// that gap — and then you'd sit on this screen until the 4-second backstop
// noticed. The flag just stops it painting before there's anything to paint.
let booted = false;

function paint(s) {
  const tgt = document.getElementById("targets");
  if (!tgt) return;
  const lead = document.getElementById("lead");
  const title = document.getElementById("unlockTitle");
  // The headline is set once at boot — it can't change while this page is open — so it
  // is not looked up here at all.

  const r = ankiRow(s);

  // No goal set: the site is on the locked list but nothing can release it, so say
  // so rather than leaving a dead end. (The background refuses to block at all in
  // this state, so this is only ever seen for a moment.)
  if (!r) {
    if (lead) lead.innerHTML = `This site is on your locked list, but no Anki goal is set for today — so there's nothing to finish and nothing to open it.`;
    if (title) {
      title.innerHTML = "⚠️ Nothing to finish yet " + infoTip("This site is locked until today's <b>Anki</b> goal is done — but you haven't set one, so there's nothing to finish.<br/><br/>Open <b>Settings → Study &amp; Unlock</b>, switch Anki on and give it a time.");
      // The "written once" latch has to be released along with the heading it guards.
      // Without this, the order goal-set → goal-cleared → goal-set-again left the warning
      // on screen for the life of the tab, above a card showing a live counting goal:
      // the latch was still stamped from the first pass, so the real heading never came
      // back. paint() runs on every storage write, so one trip through Settings did it.
      delete title.dataset.set;
    }
    tgt.innerHTML = `<div class="nogoal">${ANKI_LOGO} Set today's goal in <b>Settings → Study &amp; Unlock</b>.</div>`;
    return;
  }

  if (title && !title.dataset.set) {
    // The search gate is asked FIRST, and the two can never both be set — a refusal carries one
    // gate, and blockedPageUrl writes one set of parameters for it — so the order is about
    // readability rather than precedence.
    const why = searchWhy ? searchTipHtml()
      : ytWhy ? ytTipHtml(s)
      : INFO && INFO.gate === "whitelist"
      ? "You're in <b>allowlist</b> mode, so everything except your allowed sites is blocked until today's <b>Anki</b> goal is done.<br/><br/>Do the reps and this page sends you back on its own — no need to refresh."
      : "This site is locked until today's <b>Anki</b> goal is done — the time, and the card count if you set one.<br/><br/>Do the reps and this page sends you back on its own — no need to refresh.";
    title.innerHTML = (searchWhy ? searchHeading() : ytWhy ? ytHeading() : "Spend your time here to unlock ") + infoTip(why);
    title.dataset.set = "1";
  }
  // The video gate's own sentence replaces the lead, because the ordinary one — "spend your time
  // here" — is answering a question nobody asked: you were not trying to browse a blocked site, you
  // were trying to watch one specific video, and what you need to know is which words would have
  // let it through. Repainted every pass rather than latched, so the keywords follow the card you
  // move to while this page is still open.
  // The search gate's sentence replaces the lead for the same reason the video gate's does: you were
  // not trying to browse a blocked site, you were trying to look something up, and what you need to
  // know is which words would have let it through.
  if (lead) lead.innerHTML = searchWhy ? searchLeadHtml(s) : ytWhy ? ytLeadHtml(s) : leadHtml(r);

  // Built once, then updated in place.
  //
  // This used to be `tgt.innerHTML = rowHtml(r)` on every heartbeat and every storage
  // write — up to twelve times a minute — which destroyed and recreated the "Open
  // Anki" link each time. Two consequences: anyone navigating by keyboard had focus
  // thrown back to the top of the document every few seconds, so the page's only
  // action was almost impossible to reach; and the progress bar could never animate,
  // because a brand-new element has nothing to transition from.
  if (tgt.dataset.built !== "1") {
    tgt.innerHTML = rowHtml(r);
    tgt.dataset.built = "1";
  }
  const row = tgt.querySelector(".target");
  if (!row) { tgt.innerHTML = rowHtml(r); return; }
  const left = Math.max(0, r.req - r.spent);
  const done = (left === 0 || r.req === 0) && r.met;
  row.classList.toggle("done", done);
  row.classList.toggle("live", !!r.live);
  const nm = row.querySelector(".tname");
  if (nm && nm.textContent !== r.name) nm.textContent = r.name;
  const meta = row.querySelector(".meta");
  if (meta) {
    const text = metaText(r, done);
    if (meta.textContent !== text) meta.textContent = text;
  }
  const nowtag = row.querySelector(".nowtag");
  if (r.live && !nowtag) {
    const t = document.createElement("span");
    t.className = "nowtag";
    t.textContent = "counting right now";
    row.querySelector(".name")?.appendChild(t);
  } else if (!r.live && nowtag) {
    nowtag.remove();
  }
  const fill = row.querySelector(".progress > div");
  if (fill) paintBar(fill, r.req ? Math.round(100 * Math.min(r.spent, r.req) / r.req) : 0);
}

// Both the name and the Open button open the desktop app.
document.addEventListener("click", (e) => {
  const a = e.target.closest && e.target.closest("a.tlink, a.go");
  if (!a) return;
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return;
  e.preventDefault();
  if (a.hasAttribute("data-anki")) openAnkiApp();
});

// Go back the moment this page has no reason to exist any more — the extension
// switched off, the goal cleared, the day finished. The background sends tabs
// back too; this is the same question asked from this side, so whichever notices
// first wins and there's no wait either way.
let left = false;
// Declared with the other handles rather than three hundred lines below, beside the
// listener that arms it. `let` has no hoisted initialiser, so stopLive() — which clears
// it — throws a ReferenceError if it ever runs before that declaration is evaluated.
// Today it cannot, because every caller is reached from a timer; that is a property of
// the current call graph and not of anything written down, which is the wrong thing to
// depend on in the one function whose job is to shut everything down safely.
let recoverTimer = 0;
let beat = 0, recheck = 0, paintTimer = 0;

// Nothing left to ask once the extension has been reloaded under us: the timers
// stop instead of throwing into the console every few seconds. Reloading this
// page brings it back.
function stopLive() {
  if (beat) { clearInterval(beat); beat = 0; }
  if (recheck) { clearInterval(recheck); recheck = 0; }
  // The debounced repaint too, or one last paint fires after we've gone quiet and
  // throws "Extension context invalidated" into the console — the exact noise this
  // function exists to stop.
  if (paintTimer) { clearTimeout(paintTimer); paintTimer = 0; }
  if (recoverTimer) { clearTimeout(recoverTimer); recoverTimer = 0; }
}

function tryRecover() {
  if (left || !fromUrl) return;
  if (!extensionAlive()) { stopLive(); return; }
  try {
    chrome.runtime.sendMessage({ type: "checkBlocked", url: fromUrl }, (res) => {
      void chrome.runtime.lastError;
      if (!res || !res.ok || res.blocked !== false) return;
      left = true;
      // Nothing more to watch: this tab is on its way back to the site. `left` alone only
      // stopped tryRecover from asking again — the five-second heartbeat carried on reading
      // the whole of storage and repainting a page that was leaving.
      stopLive();
      // The browser takes the tab back to the site, rather than this page
      // replacing itself. A document that replaces itself hands its own
      // Content-Security-Policy to whatever loads next, and an extension page's
      // rules landing on a website block every script that site owns — it would
      // open visibly broken. Replacing ourselves stays as the fallback.
      try {
        chrome.runtime.sendMessage({ type: "navigate", url: fromUrl }, (nav) => {
          if (chrome.runtime.lastError || !nav || !nav.ok) location.replace(fromUrl);
        });
      } catch { location.replace(fromUrl); }
    });
  } catch {}
}

// Live: the bar moves as you study, without a refresh. The background rewrites
// these keys about every three seconds while Anki is open.
// ankiLastPollAt is deliberately NOT here. It is rewritten on every poll — up to
// once a second while a popup or the settings page is open — and it says nothing
// about whether the gate has opened. Every blocked tab was waking on it, each asking
// the worker "am I still blocked?" and each reading the ENTIRE storage back to
// repaint. With a dozen blocked tabs open that was a dozen messages and a dozen
// full-state reads per second, all computing the same answer.
// Every gate's inputs are in both lists, and deliberately so. A due count reaching
// zero or a retention percentage crossing its threshold is exactly the moment this
// page should stop existing — leaving them out would mean sitting on the blocked
// screen with the goal finished until something else happened to change.
const GATE_INPUTS = ["ankiSpentSec", "ankiReviewedToday", "ankiEnabled", "ankiRequiredSec",
                     "ankiMinCards", "ankiMinCardsEnabled",
                     "ankiUniqueOnly", "ankiUniqueToday", "ankiGoalsAt",
                     "ankiDueGateEnabled", "ankiDueAllowed", "ankiDueLeft", "ankiDueDecks",
                     "ankiRetentionEnabled", "ankiMinRetention", "ankiRetPass", "ankiRetAgain",
                     "ankiDeckTimeEnabled", "ankiDeckTimes", "ankiDeckSpent",
                     "blockMode", "blockedSites", "allowedSites", "enabled"];
const LIVE_KEYS = [...GATE_INPUTS, "ankiStudying", "ankiReason",
                   "ankiConnected", "ankiDueAtDayStart"];
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!LIVE_KEYS.some(k => k in changes)) return;
  // Anything that moves the bar can also be the thing that opens the gate, so
  // ask straight away — not on the next four-second poll. Debounced, because a
  // single poll writes several of these keys at once and each one used to fire its
  // own round trip.
  // GATE_INPUTS is exactly "the keys that can actually open the gate"; the rest of
  // LIVE_KEYS only move the bar. There was a `GATE_KEYS = GATE_INPUTS` alias here for
  // one reader, which is two names for one list.
  if (GATE_INPUTS.some(k => k in changes)) {
    clearTimeout(recoverTimer);
    recoverTimer = setTimeout(tryRecover, 60);
  }
  if (!booted) return;
  clearTimeout(paintTimer);
  paintTimer = setTimeout(async () => {
    try { paint(await chrome.storage.local.get(null)); } catch {}
  }, 150);
});

(async () => {
  let s = {};
  // A failure here used to `return`, which left this page permanently half-drawn: an
  // empty sentence, an empty card, no heartbeat, no recovery check and no explanation
  // — a dead end on the one screen whose entire job is telling you the way out. Now
  // it says so, and carries on with an empty state so the recovery loop still runs.
  try { s = await chrome.storage.local.get(null); }
  catch {
    const lead = document.getElementById("lead");
    if (lead) lead.textContent = "Couldn't read your settings just now. Reload this page, or open the extension's Settings.";
  }
  INFO = await getBlockInfo(fromUrl);
  paint(s);
  booted = true;
  tryRecover();

  // "counting right now" has to fade by itself when you stop, and that isn't a
  // storage change — so give it a slow heartbeat too.
  beat = setInterval(async () => {
    if (!extensionAlive()) { stopLive(); return; }
    try { paint(await chrome.storage.local.get(null)); } catch {}
  }, 5000);

  // A slow backstop, for anything that changes without touching storage.
  if (fromUrl) recheck = setInterval(tryRecover, 4000);
})();
