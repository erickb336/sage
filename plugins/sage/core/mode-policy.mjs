// The mode phrases, in classified prompt text. "sage mode" (also "sage mode on"), "sage mode off" and
// "autopilot on" count only at the start of the message, so that a mention or a quote switches nothing: "sage mode
// off" also drops the git rules. "sage mode" may stand alone, end at ".", ",", ":", ";", "!" or the end of its line, or
// go on with a space and more words ("sage mode continue on the sage project"), as long as its line has no question mark
// of any script and no off word comes soon after it: "sage mode?", "sage mode online: is it a thing?", "sage mode on
// off", "sage mode please stop" and "sage mode: off" switch nothing on, and the off word switches autopilot off (T194,
// T200, T210). The words may go on only on a plain line: a Markdown quote, a list item or a code line that starts with the phrase and more words is a paste, not a request. "autopilot on" stays
// strict: it must stand alone or end at that punctuation or its line, so "autopilot on?" and "autopilot on main" switch
// nothing. "sage mode off" must not run on into a longer word ("sage mode off-topic"), and its line must have no "?"
// ("sage mode off? what does it do?"). Because a missed off is the unsafe one, any line that starts with "sage mode off"
// or "autopilot off" switches autopilot off, even as a question or in a frame. The owner's own text also switches it
// off when it mentions autopilot and has an off word anywhere, in any letter form. A frame does not, because its
// boilerplate has off words ("NOT a message from the user"). Off wins over on. Only OFF_LINE has the m flag: with it,
// "^" also matches the start of each later line.
// A BOM (U+FEFF) is no space here, so a BOM before or after the phrase makes it no phrase (R737).
const START = String.raw`^(?:(?!\uFEFF)[\s"'“‘*_>-])*`;
const SP = String.raw`[^\S\r\n\u2028\u2029\uFEFF]`; // a space, a tab or an NBSP, never a line break
// A prefix that stays on its line. With the m flag, "^" matches after each line break, so a prefix that also matched
// line breaks would read each run of blank lines again from each of its lines: quadratic time on a long report (T34).
const LINE_START = String.raw`^(?:${SP}|["'“‘*_>-])*`;
const END = String.raw`(?=${SP}*(?:[.,:;!\r\n\u2028\u2029]|$))`;
const SAGE = String.raw`(?:enter${SP}+)?sage${SP}+mode(?:${SP}+on)?`;
const AND_AUTOPILOT = String.raw`(?:${SP}+autopilot|(?:${SP}*[.,:;!]${SP}*|${SP}+)autopilot${SP}+on)`; // "sage mode autopilot", "sage mode, autopilot on"
// Every question mark: ASCII, full-width, Arabic, double, with an exclamation mark, small, and the Greek one (U+037E).
const QUESTION = "[?？؟⁇⁈⁉﹖\u037E]";
// The off words in any form, anywhere in the owner's text ("no more", "turn off", "switch off" and "hold off" have one too).
const OFF_WORDS = String.raw`(?:(?:off|no|without|don['’]?t|do\s+not|end(?:s|ed|ing)?|quit(?:s|ting)?|exit(?:s|ed|ing)?)\b|(?:stop|disabl|paus|cancel|kill|halt|deactivat|abort|suspend))`;
// The off words soon after the phrase are whole words: "stopwatch", "end-to-end", "cancellation" and "killer" are other
// words (R733). "no" and "without" count only alone (before punctuation or the end of the line) or before "more" or
// "longer": "no rush" and "without asking" are requests, "no more" and "no." are off. "off" keeps its "\b", as in
// OFF_LINE, so "sage mode off-topic" turns nothing on.
const WORD_END = String.raw`(?![\p{L}\p{N}\p{M}'’-])`;
const OFF_NEAR = String.raw`(?:off\b|(?:quit(?:s|ting)?|exit(?:s|ed|ing)?|end(?:s|ed|ing)?|stop(?:s|ped|ping)?|disabl(?:e|es|ed|ing)|paus(?:e|es|ed|ing)|cancel(?:s|l?ed|l?ing)?|kill(?:s|ed|ing)?|halt(?:s|ed|ing)?|deactivat(?:e|es|ed|ing)|abort(?:s|ed|ing)?|suspend(?:s|ed|ing)?|don['’]?t|do${SP}+not|no${SP}+(?:more|longer))${WORD_END}|(?:no|without)(?=${SP}*(?:[\p{P}\p{S}\r\n\u2028\u2029]|$)))`;
// The small words that may come before an off word soon after the phrase: "please stop", "turn it all off", "can go off
// now" (T210). At most 5 of them, on the line of the first word. Any other word before the off word ends the window, so
// a request that mentions an off word later ("sage mode fix the login, then stop the old server") still turns it on.
const FILLER = String.raw`(?:please|pls|plz|now|just|ok|okay|so|and|then|hey|well|actually|really|i|i['’]?m|we|you|u|me|us|it|it['’]?s|its|all|the|this|that|everything|can|could|would|will|should|must|go|going|gonna|want|wanna|need|let|let['’]?s|to|be|is|are|for|on|right|time|sage|mode|switch|switching|turn|turning|set|put|get|hold|back|already)`;
const SEP = String.raw`(?:${SP}|[\p{P}\p{S}])`;
// Between the phrase and the first word: any run of spaces, punctuation, symbols and line breaks (T213).
const GAP = String.raw`[\s\p{P}\p{S}]*`;
// The on rule folds only the words after the phrase, never the phrase itself: a look-alike letter, a zero-width space or
// a combining mark in the phrase makes it no phrase (F-R725-1). In the tail, each word gets its compatibility form and
// loses its marks (NFKD: mathematical, circled and full-width letters become plain ones), then its invisible characters
// (a soft hyphen, a zero-width space, a Hangul filler, a Braille blank), then each look-alike in LOOK_ALIKES becomes its
// plain letter: the Cyrillic, Greek and Armenian look-alikes and the small capitals of each letter of the off words. The
// tail's punctuation keeps its form, so "sage mode！" stays a miss (F-T72-20); each question mark becomes "?". So "sage
// mode o<soft hyphen>ff", "sage mode оff" (a Cyrillic "о") and "sage mode ᴏꜰꜰ" have an off word after the phrase (T200).
// The phrase ends at its last letter: a letter, a mark, a digit or a format character next makes it no phrase (R733).
const HEAD = new RegExp(`${START}(?:enter${SP}+)?sage${SP}+mode(?![\\p{L}\\p{M}\\p{N}\\p{Cf}])`, "iu");
const LOOK_ALIKES = {
  a: "аАαΑɑᴀ", b: "ьЬвВƅΒʙ", c: "сСᴄ", d: "ԁᴅ", e: "еЕҽεΕᴇ", f: "ꬵϝϜғҒꜰ", g: "ɡցɢ", h: "һҺнНΗʜ", i: "іІıɩιΙӀɪ",
  j: "јЈᴊ", k: "кКκΚᴋ", l: "ӏǀʟ", m: "мМΜᴍ", n: "ոΝɴ", o: "оοօⲟОΟՕⲞᴏ", p: "рРρΡᴘ", q: "ԛԚ", r: "гᴦʀ", s: "ѕЅꜱ",
  t: "тТτΤᴛ", u: "υսᴜ", v: "νѵᴠ", w: "ԝԜѡᴡ", x: "хХχΧ", y: "уУүΥʏ", z: "Ζᴢ",
};
const PLAIN_OF = new Map(Object.entries(LOOK_ALIKES).flatMap(([plain, likes]) => [...likes].map((like) => [like, plain])));
const FOLD = [[/[^\s\p{P}]+/gu, (word) => word.normalize("NFKD")], [/[\p{M}\p{Cf}\p{DI}\u2800]/gu, ""], [new RegExp(QUESTION, "g"), "?"], [new RegExp(`[${[...PLAIN_OF.keys()].join("")}]`, "g"), (c) => PLAIN_OF.get(c)]];
const foldAll = (text) => FOLD.reduce((t, [pattern, plain]) => t.replace(pattern, plain), text);
const fold = (text) => {
  const head = HEAD.exec(text)?.[0];
  return head === undefined ? text : head + foldAll(text.slice(head.length));
};
// More words after the phrase only on a plain line: blank lines, then at most 3 spaces. A quote mark, a bullet, a tab or
// a 4-space indent before the phrase makes the line a paste (F-R710-1). The phrase alone keeps the wider START.
const PLAIN = String.raw`^(?:(?:(?!\uFEFF)\s)*[\r\n])? {0,3}`;
// The question guard comes before the space run, so that one space and two spaces give the same answer, and so that the
// run never backtracks into a re-scan of the line: a lookahead after a greedy run reads the line again at each step of
// the run, quadratic time on a long first line (T34, T194 cycle 1).
const SAGE_ON = new RegExp(`${START}${SAGE}${AND_AUTOPILOT}?${END}|${PLAIN}${SAGE}${AND_AUTOPILOT}?(?!.*\\?)${SP}+`, "i"); // "." stops at a line break
// An off word soon after the phrase: after any gap and at most 5 small words (T210, T213). It reads the whole text
// folded, the phrase too, so that a mark, a hidden character or a look-alike in or right after the phrase cannot hide the
// off word (T214); the on rule keeps the strict phrase. It blocks the on rule and switches autopilot off, because off is
// the safe direction. The group is the off word, for the note.
const OFF_AFTER = new RegExp(`${START}${SAGE}${GAP}(?:${FILLER}${SEP}+){0,5}(${OFF_NEAR})`, "iu");
const OFF_PHRASE = new RegExp(`${START}sage${SP}+mode${SP}+off`, "iu"); // the off phrase has its own rules
const OFF_LINE = new RegExp(`${LINE_START}(?:sage${SP}+mode|autopilot)${SP}+off\\b`, "im"); // in any text, at the start of any line
const SAGE_OFF = new RegExp(`${START}sage${SP}+mode${SP}+off(?![\\p{L}\\p{N}-])(?!.*\\?)`, "iu"); // "." stops at a line break
const AUTOPILOT_ON = new RegExp(`${START}(?:autopilot${SP}+on|${SAGE}${AND_AUTOPILOT})${END}`, "i");
// A message that starts with a mode word, but whose switch did not happen, gets a note (the caller), so that a miss is
// never silent. MODE_WORD reads the folded text, so that a mode word with a hidden character, a mark or a look-alike
// letter in it or joined to it still gets the note; RAW_WORD and the next character say that it was so (R737, R738).
const MODE_WORD = new RegExp(`${START}(?:(?:enter${SP}+)?sage${SP}+mode|autopilot)(?![\\p{L}\\p{N}])`, "iu");
const RAW_WORD = new RegExp(`${START}(?:(?:enter${SP}+)?sage${SP}+mode|autopilot)`, "i");
const AUTOPILOT_WORD = new RegExp(`${START}autopilot(?![\\p{L}\\p{N}])`, "iu");
// Autopilot asked for at the start: its on phrase, or the on phrase and then autopilot ("and autopilot", "autopilot
// please", "autopilot, stop when done"), but not autopilot with an off word as the next word ("sage mode autopilot
// off", R734). Autopilot alone at the start asks for it too when the owner's text has no off word (the caller).
const AUTOPILOT_ASKED = new RegExp(`${START}(?:autopilot${SP}+on|${SAGE}(?:${SP}*[.,:;!]${SP}*|${SP}+)(?:and${SP}+)?autopilot(?:${SP}+on|(?!${SP}+${OFF_NEAR})))(?![\\p{L}\\p{N}])`, "iu");
// Why an autopilot ask missed (R732): "and" before the autopilot word, or no "on" right after it where it needs one.
const AND_FIRST = new RegExp(`${START}${SAGE}(?:${SP}*[.,:;!]${SP}*|${SP}+)and${SP}+autopilot(?![\\p{L}\\p{N}])`, "iu");
const NO_ON = new RegExp(`${START}(?:${SAGE}${SP}*[.,:;!]${SP}*)?autopilot(?!${SP}+on(?![\\p{L}\\p{N}]))(?![\\p{L}\\p{N}])`, "iu");
// A quote mark, a bullet, a tab or a 4-space indent before the mode word: a paste.
const PLAIN_WORD = new RegExp(`${PLAIN}(?:(?:enter${SP}+)?sage${SP}+mode|autopilot)`, "i");
const QUESTION_MARK = new RegExp(QUESTION);
/** The first line with text: a string search, not a regex that could backtrack over a long line (T34). */
const firstLine = (text) => {
  const rest = text.trimStart();
  const end = rest.search(/[\r\n]/);
  return end < 0 ? rest : rest.slice(0, end);
};
// The word autopilot, and the off words.
const AUTOPILOT = /\bauto[-\s]?pilots?\b/i;
const OFF_WORD = new RegExp(String.raw`\b${OFF_WORDS}\w*|\bauto[-\s]?pilots?\s*=\s*false\b`, "i");
/** The off word of the broad off rule, or undefined: an off line, or autopilot and an off word anywhere. */
const broadOff = (text) => (OFF_LINE.test(text) ? "off" : AUTOPILOT.test(text) ? OFF_WORD.exec(text)?.[0] : undefined);
/** A mark, a format character or a character whose compatibility form starts with a space or a mark (U+037A, U+FE70). */
const hiddenNext = (c) => /[\p{M}\p{Cf}]/u.test(c) || (/\S/u.test(c) && /^[\s\p{M}]/u.test(c.normalize("NFKD")));

/** Origin is supplied by the provider; this function does not authenticate text. */
export function modeSignals({ owner, text, outside, all }) {
  if (typeof owner !== "boolean" || [text, outside, all].some(value => typeof value !== "string")) {
    throw Error("Invalid mode prompt");
  }
  const loose = owner ? foldAll(text) : "";
  const near = OFF_AFTER.exec(loose)?.[1];
  const offNext = near !== undefined;
  // The phrase and an off word soon after it, other than the off phrase, which has its own rules (T200).
  const offAfter = offNext && !OFF_PHRASE.test(text);
  // An off in the owner's own text, in any letter form. Only this off may make an autopilot on a planned miss: an off
  // line in an agent's frame turns autopilot off too, but the owner still gets the note (F-R724-L2).
  const broad = owner ? broadOff(foldAll(outside)) : undefined;
  const ownOff = owner && (broad !== undefined || offAfter);
  const autopilotWord = owner && AUTOPILOT_WORD.test(text);
  const modeWord = owner && (offNext || MODE_WORD.test(loose)); // "sage modeoff" too
  const head = RAW_WORD.exec(text)?.[0];
  const next = head === undefined ? "" : String.fromCodePoint(text.codePointAt(head.length) ?? 32);
  return {
    sageOff: owner && SAGE_OFF.test(text),
    sageOn: owner && !offNext && SAGE_ON.test(fold(text)),
    autopilotOff: OFF_LINE.test(all) || ownOff || (!owner && broadOff(all) !== undefined),
    autopilotOn: owner && AUTOPILOT_ON.test(text),
    modeWord,
    autopilotWord,
    autopilotAsked: owner && (AUTOPILOT_ASKED.test(text) || (autopilotWord && !ownOff)),
    // Why an ask missed, for the note: "and" before autopilot, or no "on" right after it (R732).
    autopilotGap: !owner ? "" : AND_FIRST.test(text) ? "and" : NO_ON.test(text) ? "on" : "",
    ownOff,
    offAfter,
    // The off word that won, as the note names it (R738).
    offWord: ownOff ? (offAfter ? near : broad).replace(/\s+/g, " ") : "",
    // A hidden character, a mark or a look-alike letter in the mode word or joined to its end (R737, R738).
    joined: modeWord && (head === undefined || hiddenNext(next)),
    pasted: modeWord && !PLAIN_WORD.test(text),
    question: owner && QUESTION_MARK.test(firstLine(text)),
  };
}

