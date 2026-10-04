// AnkiGate — what is this card ABOUT, and does this video's title say the same thing?
//
// One job, in two halves that must agree with each other:
//
//   1. Turn the card you are looking at into a handful of keywords.
//   2. Decide whether a YouTube video's title carries any of them.
//
// Both halves live here because they share a normaliser, and that sharing is the whole
// correctness argument: "signals" on the card and "Signal" in a title are the same word, and
// the only way they can be reliably treated as the same word is for one function to be the
// only thing that ever answers "what is the root of this token". Two copies of that rule —
// one on the card side, one on the title side — is a gate that silently lets the wrong videos
// through and blocks the right ones, in a way nobody would ever find by reading it.
//
// ---------------------------------------------------------------------------
// Why this is not a call to an AI model
//
// The obvious reading of "use AI to pull the keywords out" is an API call to a language
// model. It is the wrong tool here, for four reasons that all matter more than the
// sophistication would:
//
//   • WHERE THE CARD TEXT WOULD GO. The Anki add-on's own header promises "it reports window
//     state only. No card content, no personal data." Posting the front of every card you
//     review to somebody else's server is the exact opposite of that promise, and it is the
//     first thing a Chrome Web Store reviewer would stop on.
//   • WHEN THE ANSWER IS NEEDED. The gate has to decide as a page navigates. A network round
//     trip to a model is hundreds of milliseconds at best, so the video would be playing
//     before the verdict landed — and the verdict is the feature.
//   • WHAT HAPPENS WHEN IT FAILS. Offline, rate-limited, key expired, model deprecated: an
//     anti-cheat that stops working when a third party has an outage is not one.
//   • WHAT IT WOULD BUY. On the sentence this was built for — "Explain the concept of
//     aliasing in the context of signal processing and its significance in sampling of
//     signals" — the answer is aliasing, signal processing, sampling, signal. The work is
//     removing the exam-question scaffolding, and that scaffolding is a closed list of about
//     three hundred words. A model is not needed to know that "explain the concept of" is
//     not what the card is about.
//
// So the extraction is local, instant, offline and private. It is deliberately written as a
// pipeline of named stages rather than one clever function, so a model CAN be dropped in
// later as an extra stage — see `extract`, where an externally supplied keyword list is
// merged rather than replaced, precisely so an AI's answer could be added without this
// becoming the thing that has to work.
//
// ---------------------------------------------------------------------------
// A model WAS added, and none of the four objections above were waived
//
// There is now an optional AI second opinion on the video gate — ytAiEnabled in DEFAULTS, and
// the ytAi* block in background.js. It does not touch this file, and that is the point: it was
// added as a SECOND PATH TO THE SAME VERDICT rather than as a replacement for this one, so each
// of the four objections is answered by where it sits rather than by having been argued away.
//
//   • WHERE THE CARD TEXT GOES. Off by default, and the settings page says outright that turning
//     it on sends the card front to Google. So the promise this file makes is still kept for
//     anybody who has not deliberately given it up. The add-on's own promise is untouched: it
//     reports the card front to this extension, as it always did, and nothing further.
//   • WHEN THE ANSWER IS NEEDED. It is only ever asked about a title THIS FILE HAS ALREADY
//     REFUSED, and the refusal stands while the answer travels. So the round trip costs nothing
//     that was not already being withheld — it can only ever end in a shield lifting.
//   • WHAT HAPPENS WHEN IT FAILS. Offline, rate-limited, key expired, model retired: the verdict
//     stays as this file left it. The anti-cheat is this file, and it never stops working.
//   • WHAT IT BUYS. The one thing a closed list of three hundred stop words cannot do: recognise
//     that "the Nyquist rate" and a card about aliasing are the same subject, or that a lecture
//     in Hindi teaches an English card. Different words, same topic. No amount of stemming
//     reaches that, which is why it took a model and not a longer list.
(function (root) {
  "use strict";

  // ---- the stop lists ------------------------------------------------------
  //
  // THREE lists, not one, and the split is the load-bearing idea in this file.
  //
  // It was one list to begin with, and that version could not produce "signal processing" —
  // the phrase this whole feature exists to recognise. "Processing" has to be excluded as a
  // keyword on its own, or every video with "processing" in the title matches; and it has to
  // be INCLUDED as half of "signal processing", or the one phrase that really identifies the
  // subject never forms. A single list cannot say both, and whichever way you set it you lose
  // one of the two.
  //
  // So words are separated by what they do to a phrase:
  //
  //   FUNC  function words. Never a keyword, never inside a phrase. "of", "the", "in".
  //   VERB  the verbs a question is BUILT from, plus the linking verbs that join a subject to
  //         its definition. Never a keyword, never inside a phrase, because a phrase led by
  //         one is the question's grammar and not its subject: "explain aliasing" is not a
  //         topic, and "aliasing occurs" is not one either.
  //   NOUN  framing nouns — "concept", "context", "significance", "process", "method",
  //         "type" — plus every word that is genuinely BOTH scaffolding and subject depending
  //         on the sentence: "state" (steady state), "list" (linked list), "form" (canonical
  //         form), "value", "process". These are refused as keywords on their own and allowed
  //         inside a phrase. That is the whole reason the ambiguous words have a home: alone
  //         they are noise, paired they are precise, and this list lets them be both.
  //
  // A phrase of two NOUNs is still scaffolding ("the following types"), so that case is
  // refused too — see `extract`.
  //
  // Written as readable words and stemmed once at load, so adding "define" here needs no
  // knowledge of what the stemmer does to it.
  const FUNC_WORDS = (
    "a an the this that these those there here it its it's is am are was were be been being " +
    "do does did doing done have has had having will would shall should can could may might " +
    "must and or but nor for so yet if then than as at by in into on onto of off out over " +
    "under from to too with within without about above below between among through during " +
    "before after while since until upon per via not no nor only just also very much many " +
    "more most less least own same other others another such each every any all both few " +
    "several who whom whose which what when where why how whether i me my mine we us our " +
    "ours you your yours he him his she her hers they them their theirs one two three ones " +
    "yes ok also thus hence therefore however whereas"
  ).split(/\s+/).filter(Boolean);

  // Never the subject of technical material, in any grammatical position.
  const VERB_WORDS = (
    "explain explains explained describe describes described define defines defined " +
    "discuss discusses discussed derive derives derived prove proves proved proven " +
    "illustrate illustrates illustrated mention mentions mentioned calculate calculates " +
    "calculated determine determines determined consider considers considered " +
    "identify identifies identified evaluate evaluates evaluated justify justifies " +
    "summarise summarize elaborate elaborates enumerate enumerates classify classifies " +
    "distinguish distinguishes differentiate differentiates demonstrate demonstrates " +
    "obtain obtains solve solves sketch sketches tabulate recall compare compares compared " +
    "contrast contrasts briefly respectively regarding " +
    // Linking verbs. These join a subject to its definition, so a phrase built on one is the
    // sentence's grammar: "aliasing occurs", "sampling is called". The subject either side is
    // still picked up on its own by the unigram pass.
    "occur occurs occurred happen happens happened refer refers referred call called " +
    "know known knows say says said tell tells become becomes exist exists"
  ).split(/\s+/).filter(Boolean);

  // Refused alone, allowed as half of a phrase.
  const NOUN_WORDS = (
    "concept concepts context contexts significance importance meaning means role purpose " +
    "difference differences similarity similarities advantage advantages disadvantage " +
    "disadvantages feature features characteristic characteristics property properties " +
    "example examples instance instances application applications use uses usage " +
    "type types kind kinds form forms sort sorts class classes category categories " +
    "term terms terminology definition definitions detail details point points " +
    "reason reasons cause causes effect effects result results conclusion conclusions " +
    "question questions problem problems solution solutions exercise " +
    "note notes short brief long detailed general basic basics fundamental " +
    "following follows given respect regard " +
    "various different main major minor primary secondary important key " +
    "way ways method methods approach approaches technique techniques procedure " +
    "process processes processing processed " +
    "step steps stage stages part parts aspect aspects factor factors " +
    "true false correct incorrect right wrong blank blanks fill " +
    "help helps using used usable able unable need needs required require " +
    "value values number numbers amount amounts total sum " +
    // Genuinely ambiguous: scaffolding in a question, subject in a technical term.
    "state states stated name names named show shows shown label labels " +
    "draw draws express expresses expression expressions list lists listed outline outlines " +
    "write writes written find finds found answer answers ask asks give gives " +
    "study studies studied work works working " +
    // Anki and HTML furniture. "video" and "audio" are in here rather than in FUNC because
    // "video compression" and "audio codec" are real subjects.
    "front back extra source hint hints tag tags cloze deck decks card cards " +
    "img image images png jpg jpeg gif svg mp3 mp4 wav ogg webm sound audio video " +
    "br div span nbsp amp quot apos lt gt"
  ).split(/\s+/).filter(Boolean);

  // ---- normalising ---------------------------------------------------------

  // HTML, cloze markers, sound tags and entities out; one plain sentence in.
  //
  // The card text arrives as the rendered HTML of the question side, so it carries the
  // template's own markup, whatever the note's fields contain, and — because this extension
  // puts it there — the media probe's <script>. Anything inside <script> or <style> is
  // program text, not material, and a script's identifiers are exactly the kind of long
  // alphabetic tokens that would survive every other filter in this file.
  function plainText(html) {
    let s = String(html == null ? "" : html);
    // Script and style bodies, whole. Before tag stripping, or their contents fall out as text.
    s = s.replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
         .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ");
    // Anki's own furniture. `[sound:...]` is a file path, and a path is not material —
    // "recording_04_final.mp3" would otherwise contribute three tokens.
    s = s.replace(/\[sound:[^\]]*\]/gi, " ")
         .replace(/\[anki:[^\]]*\]/gi, " ");
    // Cloze: keep what is INSIDE, drop the machinery. `{{c1::aliasing::the hint}}` is a card
    // whose entire subject is the deleted word, so throwing the braces away and keeping
    // "aliasing" is the whole point. The hint after the second :: goes, being a prompt about
    // the answer rather than the material.
    s = s.replace(/\{\{c(\d+)::([^:}]*)(?:::[^}]*)?\}\}/gi, " $2 ");
    // Any other mustache — {{Front}}, {{type:Back}}, {{#tag}} — is a template instruction that
    // did not get substituted, so it is furniture whatever it says.
    s = s.replace(/\{\{[^}]*\}\}/g, " ");
    // A tag becomes a SPACE, not nothing. "signal<br>processing" is two words, and deleting
    // the tag would weld them into one that matches neither.
    s = s.replace(/<[^>]*>/g, " ");
    // The handful of entities that carry text. Numeric ones too, since a card pasted from a
    // PDF is full of them.
    s = s.replace(/&nbsp;/gi, " ")
         .replace(/&amp;/gi, " and ")
         .replace(/&(?:lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, " ");
    return s.replace(/\s+/g, " ").trim();
  }

  // The card, as a person reads it — for SHOWING, where plainText above is for matching.
  //
  // The two cannot be one function, because they disagree about the one thing that matters on a
  // card: plainText keeps what a cloze hides, since "aliasing" inside {{c1::aliasing}} is the card's
  // whole subject. That is exactly wrong for text that goes up on a cover while the same card is
  // being asked in Anki — a cover that prints the deleted word answers the card for you. So every
  // deletion is hidden the way Anki's own front hides it: "[...]", or "[hint]" when it carries one.
  // All of them, not just the one being asked, because which one that is cannot be known from the
  // field — hiding one too many is a blank, showing one too many is an answer.
  //
  // Innermost first, so a nested cloze cannot leave half its braces behind. Entities are decoded
  // rather than blanked (this is shown as text, never as markup), and a long front is cut at a word
  // with an ellipsis: this is a reminder of the card, not a copy of it.
  const CARD_SHOWN_MAX = 300;
  const CLOZE_INNER = /\{\{c\d+::((?:(?!\{\{c\d+::)[\s\S])*?)\}\}/gi;
  function cardShown(text) {
    let s = String(text == null ? "" : text);
    s = s.replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
         .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ");
    s = s.replace(/\[sound:[^\]]*\]/gi, " ")
         .replace(/\[anki:[^\]]*\]/gi, " ");
    for (let i = 0; i < 8; i++) {
      const before = s;
      s = s.replace(CLOZE_INNER, (m, body) => {
        const cut = body.indexOf("::");
        const hint = cut >= 0 ? body.slice(cut + 2).trim() : "";
        return hint ? " [" + hint + "] " : " [...] ";
      });
      if (s === before) break;
    }
    // Any other mustache is a template instruction that was never substituted.
    s = s.replace(/\{\{[^}]*\}\}/g, " ");
    s = s.replace(/<[^>]*>/g, " ");
    s = s.replace(/&nbsp;/gi, " ")
         .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
         .replace(/&quot;/gi, "\"").replace(/&(?:apos|#39);/gi, "'")
         .replace(/&#(\d+);/g, (m, n) => { const c = Number(n); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : " "; })
         .replace(/&#x([0-9a-f]+);/gi, (m, n) => { const c = parseInt(n, 16); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : " "; })
         .replace(/&amp;/gi, "&");
    s = s.replace(/\s+/g, " ").trim();
    if (s.length > CARD_SHOWN_MAX) {
      const cut = s.slice(0, CARD_SHOWN_MAX);
      const at = cut.lastIndexOf(" ");
      s = (at > CARD_SHOWN_MAX * 0.6 ? cut.slice(0, at) : cut).replace(/[\s.,;:!?-]+$/, "") + "…";
    }
    return s;
  }

  // The root of a word, for comparison ONLY. Never shown to anybody.
  //
  // Crude on purpose. A real stemmer (Porter, Snowball) is a few hundred lines and its extra
  // accuracy is spent on distinctions that do not change this decision — what has to work is
  // that "signals" reaches "signal", "aliasing" reaches "alias" and "processing" reaches
  // "process", so a title written in a different number or tense still matches the card.
  //
  // It over-stems in places ("analysis" loses its s). That direction is the safe one: an
  // over-stemmed keyword matches slightly more titles, and the failure of a study gate that
  // matters is the one that refuses the video you actually needed.
  function stem(w) {
    let s = String(w || "").toLowerCase();
    if (s.length <= 3) return s;
    if (/ies$/.test(s) && s.length > 4) return s.slice(0, -3) + "y";
    if (/sses$/.test(s)) return s.slice(0, -2);
    if (/(ss|us|is)$/.test(s)) return s;              // class, status, basis keep their tails
    if (/s$/.test(s) && s.length > 3) s = s.slice(0, -1);
    if (/ing$/.test(s) && s.length > 5) s = undouble(s.slice(0, -3));
    else if (/ed$/.test(s) && s.length > 4) s = undouble(s.slice(0, -2));
    return s;
  }
  // "stopping" → "stopp" → "stop". Only for a doubled consonant, so "process" is left alone.
  function undouble(s) {
    return (/([bdfglmnprt])\1$/.test(s)) ? s.slice(0, -1) : s;
  }

  // Each list twice over: the words as written, and their stems. Both, because stemming is
  // lossy in a way that cuts both directions — "processing" reaches "process" so the stem set
  // catches it, while "its" stems to "it" and would slip past a stem-only check of the raw
  // form. Two Sets per list is a few hundred short strings; being sure is worth more.
  function lookup(words) {
    const raw = new Set(words), stems = new Set(words.map(stem));
    return (t) => {
      const s = String(t || "").toLowerCase();
      return raw.has(s) || stems.has(stem(s));
    };
  }
  const isFunc = lookup(FUNC_WORDS);
  const isVerb = lookup(VERB_WORDS);
  const isNoun = lookup(NOUN_WORDS);
  // "Is this word unusable on its own?" — all three lists at once, which is the unigram rule.
  function isStop(t) { return isFunc(t) || isVerb(t) || isNoun(t); }
  // "May this word be part of a phrase?" — only the first two lists refuse. This is the
  // distinction the three lists exist for; see the note above them.
  function blocksPhrase(t) { return isFunc(t) || isVerb(t); }

  // Words into tokens. Letters, digits and the two joiners that appear inside real technical
  // terms — the hyphen in "low-pass" and the plus in "c++" — and nothing else.
  //
  // Digits survive, which is deliberate and slightly risky: "802.11" and "op-amp 741" are the
  // subject of their cards, while "2024" in a video title is noise. A bare number is dropped
  // below for that reason; a number attached to letters is kept.
  function tokens(text) {
    return plainText(text)
      .toLowerCase()
      .replace(/[\u2018\u2019\u201c\u201d]/g, " ")
      .split(/[^a-z0-9+#\-']+/)
      .map(t => t.replace(/^[-'+#]+|[-'+#]+$/g, ""))
      .filter(Boolean);
  }

  // Is this token worth considering at all, before the stop list is consulted?
  function usable(t) {
    if (t.length < 2) return false;
    if (t.length > 40) return false;          // a base64 blob or a path that survived
    if (/^\d+$/.test(t)) return false;        // a bare number says nothing about a subject
    return /[a-z]/.test(t);                   // must contain a letter somewhere
  }
  // ---- pulling the keywords out -------------------------------------------

  const MAX_KEYWORDS = 12;

  // What is this card about?
  //
  // Returns plain lower-case strings, phrases included, ordered most-specific first. Strings
  // rather than objects because they are stored, shown on the settings page and compared —
  // three consumers, and a shape with scores in it would have all three carrying a field only
  // this function understands.
  //
  // `opts.extra` is the hook mentioned at the top of the file: a list from somewhere else — a
  // language model, a hand-written list per deck — is MERGED in front of what was found here,
  // never instead of it. So an AI can improve the answer without becoming the thing that has
  // to work for the gate to work at all.
  function extract(text, opts) {
    const o = opts || {};
    const raw = tokens(text);
    // Position is kept, because adjacency is what makes a phrase. Filtering to a bare list of
    // content words first would put "signal" next to "sampling" — words from opposite ends of
    // the sentence — and invent "signal sampling" as a phrase the card never contained.
    const kept = [];
    for (let i = 0; i < raw.length; i++) {
      if (usable(raw[i])) kept.push({ w: raw[i], i });
    }

    // 1. PHRASES: two words that were genuinely side by side on the card.
    //
    // Three refusals, one per stop list, and each is a different mistake being avoided:
    //
    //   a function word either side  → not a phrase at all, just two words with grammar
    //                                  between them ("signal of", "the aliasing")
    //   a verb either side           → the question's grammar rather than its subject
    //                                  ("explain aliasing", "aliasing occurs")
    //   framing nouns on BOTH sides  → pure scaffolding ("the following types")
    //
    // What survives is the case this feature was built for: one real word plus one framing
    // noun — "signal processing" — and two real words: "fourier transform", "sampling rate".
    const phrases = [];
    const seenPhrase = new Set();
    for (let n = 0; n < kept.length - 1; n++) {
      const a = kept[n], b = kept[n + 1];
      if (b.i !== a.i + 1) continue;                       // something was dropped between them
      if (blocksPhrase(a.w) || blocksPhrase(b.w)) continue;
      if (isNoun(a.w) && isNoun(b.w)) continue;
      const p = a.w + " " + b.w;
      const key = stemPhrase(p);
      if (seenPhrase.has(key)) continue;
      seenPhrase.add(key);
      phrases.push(p);
    }

    // 2. SINGLE WORDS, by how often the card says them and then by length.
    //
    // Frequency first because a card that mentions aliasing three times is a card about
    // aliasing. Length second as the tie-break, on the observation that in technical material
    // the longer of two words is almost always the more specific one.
    const counts = new Map();
    for (const { w } of kept) {
      if (isStop(w)) continue;
      const k = stem(w);
      const cur = counts.get(k);
      // The shortest surface form seen for this root is the one shown, because it is the one a
      // person would recognise: "signal", not "signals".
      if (!cur) counts.set(k, { word: w, n: 1 });
      else { cur.n++; if (w.length < cur.word.length) cur.word = w; }
    }
    const singles = [...counts.values()]
      .sort((a, b) => (b.n - a.n) || (b.word.length - a.word.length) || a.word.localeCompare(b.word))
      .map(v => v.word);

    // Phrases first: they are the strictest thing here, so a title that carries one is far more
    // likely to be the video you meant than one that happens to share a single word.
    const out = [];
    const seen = new Set();
    const push = (k) => {
      const s = String(k || "").toLowerCase().trim().replace(/\s+/g, " ");
      if (!s) return;
      const key = stemPhrase(s);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(s);
    };
    (Array.isArray(o.extra) ? o.extra : []).forEach(push);
    phrases.forEach(push);
    singles.forEach(push);
    return out.slice(0, Math.max(1, o.max || MAX_KEYWORDS));
  }

  // A phrase's identity: every word stemmed, joined. Used for de-duplication on both sides, so
  // "signal processing" and "Signals Processed" are one keyword and not two.
  function stemPhrase(p) {
    return String(p || "").toLowerCase().split(/\s+/).filter(Boolean).map(stem).join(" ");
  }

  // ---- does this title match? ---------------------------------------------

  // YouTube's tab title is "Video Name - YouTube", and for the first moment of a navigation it
  // is just "YouTube" — or the bare URL, or empty. Telling those apart from a real title is the
  // difference between a fair verdict and blocking every video for a tenth of a second.
  const NO_TITLE_YET = /^\s*(youtube|youtube\.com|www\.youtube\.com|m\.youtube\.com|youtu\.be|\(\d+\)\s*youtube)\s*$/i;
  function titleKnown(title) {
    const t = String(title || "").trim();
    if (!t) return false;
    // Chrome prefixes an unread count on some pages: "(3) Video Name - YouTube".
    return !NO_TITLE_YET.test(t.replace(/^\(\d+\)\s*/, ""));
  }
  // The part of the tab title that is the video's own name.
  function cleanTitle(title) {
    return String(title || "")
      .replace(/^\(\d+\)\s*/, "")            // Chrome's unread-count prefix
      .replace(/\s*[-–|]\s*YouTube\s*$/i, "")
      .trim();
  }

  // Which of the card's keywords this title carries, as the keywords themselves so the blocked
  // page and the settings row can say WHICH — "matched: aliasing" is a very different message
  // from "matched".
  function hits(title, keywords) {
    const list = Array.isArray(keywords) ? keywords : [];
    if (!list.length) return [];
    const tt = tokens(cleanTitle(title)).map(stem);
    if (!tt.length) return [];
    const set = new Set(tt);
    const joined = " " + tt.join(" ") + " ";
    const found = [];
    for (const k of list) {
      const parts = stemPhrase(k).split(" ").filter(Boolean);
      if (!parts.length) continue;
      if (parts.length === 1) {
        if (set.has(parts[0])) found.push(k);
      } else if (joined.indexOf(" " + parts.join(" ") + " ") >= 0) {
        // Consecutive and in order. A title with both words far apart is not the phrase.
        found.push(k);
      }
    }
    return found;
  }
  function titleMatches(title, keywords, minHits) {
    const need = Math.max(1, Math.min(5, parseInt(minHits, 10) || 1));
    return hits(title, keywords).length >= need;
  }

  // WHERE in the title the matches are, as character ranges into the string you passed in.
  //
  // `hits` above answers "which of the card's keywords are in here", which is what the gate needs.
  // This answers the other half — "which words of the TITLE are the reason" — and they are not the
  // same question: the keyword is "aliasing" and the word on screen is "Aliasing", or "signals"
  // against "signal". Highlighting needs the text as written, so this works in the original string's
  // own coordinates and never rewrites it.
  //
  // Ranges come back sorted and non-overlapping, so a caller can walk them once and splice.
  function titleWordHits(title, keywords) {
    const text = String(title == null ? "" : title);
    const list = Array.isArray(keywords) ? keywords : [];
    if (!text || !list.length) return [];
    // Words with their positions. Same character class as `tokens`, so what counts as a word here
    // and what counted as a word when the verdict was made cannot disagree.
    const words = [];
    const re = /[a-z0-9+#'-]+/gi;
    let m;
    while ((m = re.exec(text))) {
      const w = m[0].replace(/^[-'+#]+|[-'+#]+$/g, "");
      if (!w) continue;
      const start = m.index + m[0].indexOf(w);
      words.push({ w: w.toLowerCase(), s: stem(w), start, end: start + w.length });
    }
    if (!words.length) return [];
    const found = [];
    for (const k of list) {
      const parts = stemPhrase(k).split(" ").filter(Boolean);
      if (!parts.length) continue;
      for (let i = 0; i + parts.length <= words.length; i++) {
        let all = true;
        for (let j = 0; j < parts.length; j++) {
          if (words[i + j].s !== parts[j]) { all = false; break; }
        }
        if (!all) continue;
        // The whole phrase as ONE range, punctuation and spacing included, so "signal processing"
        // is highlighted as a phrase rather than as two words that happen to be adjacent.
        found.push({ start: words[i].start, end: words[i + parts.length - 1].end, keyword: k });
      }
    }
    if (!found.length) return [];
    // Longest first at the same start, so a phrase wins over the single word inside it. Then drop
    // anything that overlaps something already kept — two <mark>s cannot share a character.
    found.sort((a, b) => (a.start - b.start) || (b.end - a.end));
    const out = [];
    for (const r of found) {
      if (out.length && r.start < out[out.length - 1].end) continue;
      out.push(r);
    }
    return out;
  }

  // ---- which YouTube page is this? ----------------------------------------
  //
  // Classified here rather than at the caller, because the gate's behaviour is different for
  // each kind and "is this a video page" is a question about YouTube's URL shapes, not about
  // blocking. Anything not on YouTube returns "" and this file has no opinion about it.
  function youtubeKind(url) {
    let u;
    try { u = new URL(String(url || "")); } catch (e) { return ""; }
    if (!/^https?:$/i.test(u.protocol)) return "";
    const host = u.hostname.toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");
    const path = u.pathname || "/";
    if (host === "youtu.be") return path.length > 1 ? "video" : "site";
    if (host !== "youtube.com" && host !== "m.youtube.com" && host !== "music.youtube.com" &&
        !host.endsWith(".youtube.com")) return "";
    // Shorts get their own answer rather than counting as videos. They are the endless-scroll
    // surface, their titles are hashtag soup, and one matching title would hand over the whole
    // feed — you cannot watch "one" short. So they are refused outright; see the gate.
    if (/^\/shorts(\/|$)/i.test(path)) return "shorts";
    if (/^\/(watch|embed|v|live)(\/|$)/i.test(path)) return "video";
    if (/^\/results(\/|$)/i.test(path)) return "search";
    if (/^\/(playlist|feed|channel|c|user|@|gaming|trending|hashtag)(\/|$)/i.test(path)) return "site";
    if (path === "/" || path === "") return "site";
    return "site";
  }
  const isVideoUrl = (url) => youtubeKind(url) === "video";

  // ---- is this a search, and what was searched for? ------------------------
  //
  // The same question as `youtubeKind` — a fact about URL shapes — so it lives beside it rather
  // than at the caller.
  //
  // What makes a search gate cheap enough to be worth having is that the query is IN THE URL.
  // The video gate has to wait for a tab title to arrive, which is why it carries `titleKnown`,
  // a pending state, a per-tab deadline and a content-script shield. None of that is needed
  // here: the moment the address exists, the thing being judged exists with it. So this gate
  // decides once, synchronously, before the results have rendered — and a verdict that lands
  // that early is the only kind worth anything on a page you can read in a glance.
  //
  // A closed table of engines rather than a guess like "any URL with a q= parameter". That guess
  // is wrong in both directions and both are bad: it would treat every site with `?q=` — a
  // documentation search, a filter on your bank's transaction list — as a distraction to police,
  // and it would still miss Yahoo, which calls it `p`. The table says exactly what is covered,
  // which is also what lets the settings page name them.
  const QUERY_MAX = 200;
  const SEARCH_ENGINES = [
    // Google's country domains are the reason this is a pattern and not a string: one person's
    // searches are on google.com, another's on google.co.in, and they are the same engine. One
    // or two labels after the name, each two or three letters, covers .com, .co.uk and .com.au
    // without matching docs.google.com or any other subdomain — the host must BEGIN with google.
    { id: "google", label: "Google", host: /^google(\.[a-z]{2,3}){1,2}$/, path: /^\/search$/, params: ["q"] },
    { id: "bing", label: "Bing", host: /^bing\.com$/, path: /^\/(search|videos\/search|images\/search|news\/search)$/, params: ["q"] },
    // DuckDuckGo searches from the site root — `duckduckgo.com/?q=…` — so the path pattern has
    // to accept "/" itself. `html/` and `lite/` are its no-JavaScript surfaces.
    { id: "ddg", label: "DuckDuckGo", host: /^(html\.|lite\.)?duckduckgo\.com$/, path: /^\/(html|lite)?\/?$/, params: ["q"] },
    // Yahoo is the reason `params` is a list and not a string.
    { id: "yahoo", label: "Yahoo", host: /^([a-z0-9-]+\.)*search\.yahoo\.com$/, path: /^\/search(\/.*)?$/, params: ["p", "q"] },
    { id: "brave", label: "Brave", host: /^search\.brave\.com$/, path: /^\/(search|videos|images)$/, params: ["q"] },
    { id: "ecosia", label: "Ecosia", host: /^(www\.)?ecosia\.org$/, path: /^\/(search|videos|images)$/, params: ["q"] },
    { id: "qwant", label: "Qwant", host: /^(www\.)?qwant\.com$/, path: /^\/?$|^\/(search)?$/, params: ["q"] },
    { id: "startpage", label: "Startpage", host: /^(www\.)?startpage\.com$/, path: /^\/(sp|do)\/search\/?$/, params: ["query", "q"] },
    { id: "yandex", label: "Yandex", host: /^(www\.)?yandex\.(com|ru|com\.tr)$/, path: /^\/search\/?$/, params: ["text", "q"] },
    { id: "mojeek", label: "Mojeek", host: /^(www\.)?mojeek\.com$/, path: /^\/search$/, params: ["q"] },
    { id: "perplexity", label: "Perplexity", host: /^(www\.)?perplexity\.ai$/, path: /^\/search(\/.*)?$/, params: ["q"] }
  ];

  // Which tab of the engine you are on. Only ever used to NAME the refusal on the blocked page —
  // "this video search" reads better than "this search" — so an engine whose scheme we do not
  // recognise falls back to "web" rather than to nothing.
  //
  // Google has had two schemes for this in living memory: the old `tbm=vid` and the newer
  // `udm=7`. Both are still in circulation depending on how you arrived at the page, so both are
  // read. Everyone else puts it in the path.
  function searchTab(u) {
    const p = (u.pathname || "").toLowerCase();
    if (/video/.test(p)) return "videos";
    if (/image/.test(p)) return "images";
    if (/news/.test(p)) return "news";
    const tbm = (u.searchParams.get("tbm") || "").toLowerCase();
    if (tbm === "vid") return "videos";
    if (tbm === "isch") return "images";
    if (tbm === "nws") return "news";
    const udm = (u.searchParams.get("udm") || "").trim();
    if (udm === "7") return "videos";
    if (udm === "2") return "images";
    // DuckDuckGo and Brave name the tab in a parameter of their own.
    const ia = (u.searchParams.get("iax") || u.searchParams.get("ia") || "").toLowerCase();
    if (ia === "videos") return "videos";
    if (ia === "images") return "images";
    return "web";
  }

  // `{ id, label, query, tab }` for a search, null for everything else — and "everything else"
  // includes the engine's own home page, which is the case worth being careful about. Landing on
  // google.com having searched for nothing is not a search: there is no subject, so there is
  // nothing a gate could fairly judge, and answering "null" here is what keeps the front page
  // reachable. Typing into the box then produces an address this function does recognise.
  function searchOf(url) {
    let u;
    try { u = new URL(String(url || "")); } catch (e) { return null; }
    if (!/^https?:$/i.test(u.protocol)) return null;
    const host = u.hostname.toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");
    const path = u.pathname || "/";
    for (const e of SEARCH_ENGINES) {
      // The www. prefix is stripped above, so patterns that mention it are being tolerant rather
      // than strict — harmless, and it keeps each row readable on its own.
      if (!e.host.test(host)) continue;
      if (!e.path.test(path)) continue;
      let raw = "";
      for (const name of e.params) {
        const v = u.searchParams.get(name);
        if (v != null && String(v).trim()) { raw = String(v); break; }
      }
      // A capped, whitespace-collapsed copy. URLSearchParams has already turned `+` back into a
      // space and undone the percent-encoding, so what comes out here is what you typed. The cap
      // is for a pasted paragraph: nothing below needs more than the first few words, and an
      // unbounded string ends up in a keyword loop and on a page.
      const query = raw.replace(/\s+/g, " ").trim().slice(0, QUERY_MAX);
      if (!query) return null;
      return { id: e.id, label: e.label, query, tab: searchTab(u) };
    }
    return null;
  }

  root.FGKeywords = {
    MAX_KEYWORDS, QUERY_MAX,
    plainText, stem, stemPhrase, tokens, extract, cardShown, CARD_SHOWN_MAX,
    titleKnown, cleanTitle, hits, titleMatches, titleWordHits,
    youtubeKind, isVideoUrl,
    // The engine table is exported so the settings page can list what is covered from the one
    // place that defines it, rather than from a second list that would drift out of step.
    SEARCH_ENGINES, searchOf,
    // Exported for the tests, which check that the stop list actually removes the exam
    // scaffolding rather than that it merely exists.
    isStop
  };
})(typeof self !== "undefined" ? self : this);
