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
// The off rules keep main's start and space, where a BOM is a space: off is the safe direction, so an off rule is never
// narrower than on main (F-R741).
const OFF_START = String.raw`^[\s"'“‘*_>-]*`;
const OFF_SP = String.raw`[^\S\r\n\u2028\u2029]`;
// A prefix that stays on its line. With the m flag, "^" matches after each line break, so a prefix that also matched
// line breaks would read each run of blank lines again from each of its lines: quadratic time on a long report (T34).
const LINE_START = String.raw`^(?:${OFF_SP}|["'“‘*_>-])*`;
const END = String.raw`(?=${SP}*(?:[.,:;!\r\n\u2028\u2029]|$))`;
const SAGE = String.raw`(?:enter${SP}+)?sage${SP}+mode(?:${SP}+on)?`;
const AND_AUTOPILOT = String.raw`(?:${SP}+autopilot|(?:${SP}*[.,:;!]${SP}*|${SP}+)autopilot${SP}+on)`; // "sage mode autopilot", "sage mode, autopilot on"
// Every question mark: ASCII, full-width, Arabic, double, with an exclamation mark, small, and the Greek one (U+037E).
const QUESTION = "[?？؟⁇⁈⁉﹖\u037E]";
// The off words in any form, anywhere in the owner's text ("no more", "turn off", "switch off" and "hold off" have one too).
const OFF_WORDS = String.raw`(?:(?:off|no|without|don['’]?t|do\s+not|end(?:s|ed|ing)?|quit(?:s|ting)?|exit(?:s|ed|ing)?)\b|(?:stop|disabl|paus|cancel|kill|halt|deactivat|abort|suspend))`;
// The off words soon after the phrase: the off words as on main, also at the start of a longer word ("stopwatch",
// "kill-switch", "no rush"), and "switch" or "turn", at most one word, then "off" ("turn yourself off"). The off rule
// must never be narrower than on main (F-R741-1 to F-R741-3): such a message gets the note, which names the off word.
const OFF_NEAR = String.raw`(?:${OFF_WORDS}|(?:switch|turn)${OFF_SP}+(?:\S+${OFF_SP}+)?off\b)`;
// The small words that may come before an off word soon after the phrase: "please stop", "turn it all off", "can go off
// now" (T210). At most 5 of them, on the line of the first word. Any other word before the off word ends the window, so
// a request that mentions an off word later ("sage mode fix the login, then stop the old server") still turns it on.
const FILLER = String.raw`(?:please|pls|plz|now|just|ok|okay|so|and|then|hey|well|actually|really|i|i['’]?m|we|you|u|me|us|it|it['’]?s|its|all|the|this|that|everything|can|could|would|will|should|must|go|going|gonna|want|wanna|need|let|let['’]?s|to|be|is|are|for|on|right|time|sage|mode|switch|switching|turn|turning|set|put|get|hold|back|already)`;
const SEP = String.raw`(?:${OFF_SP}|[\p{P}\p{S}\p{Cc}])`;
// Between the phrase and the first word: any run of spaces, punctuation, symbols, control characters and line breaks
// (T213, F-R740-1).
const GAP = String.raw`[\s\p{P}\p{S}\p{Cc}]*`;
// The on rule folds only the words after the phrase, never the phrase itself: a look-alike letter, a zero-width space or
// a combining mark in the phrase makes it no phrase (F-R725-1). In the tail, each word gets its compatibility form and
// loses its marks (NFKD: mathematical, circled and full-width letters become plain ones), then its invisible characters
// (a soft hyphen, a zero-width space, a Hangul filler, a Braille blank), then each look-alike in LOOK_ALIKES becomes its
// plain letter: the Cyrillic, Greek and Armenian look-alikes and the small capitals of each letter of the off words. The
// tail's punctuation keeps its form, so "sage mode！" stays a miss (F-T72-20); each question mark becomes "?". So "sage
// mode o<soft hyphen>ff", "sage mode оff" (a Cyrillic "о") and "sage mode ᴏꜰꜰ" have an off word after the phrase (T200).
// The phrase ends at its last letter: a letter or a digit next makes it no phrase, and so does a hidden character
// (hiddenNext: a mark, a format or control character, or anything else that the fold removes or changes into a space,
// a mark or a letter), so that the fold never joins the phrase to the next word (R733, F-R740-1).
const HEAD = new RegExp(`${START}(?:enter${SP}+)?sage${SP}+mode(?![\\p{L}\\p{N}])`, "iu");
const LOOK_ALIKES = {
  a: "аАαΑɑᴀ", b: "ьЬвВƅΒʙ", c: "сСᴄ", d: "ԁᴅ", e: "еЕҽεΕᴇ", f: "ꬵϝϜғҒꜰ", g: "ɡցɢ", h: "һҺнНΗʜ", i: "іІıɩιΙӀɪ",
  j: "јЈᴊ", k: "кКκΚᴋ", l: "ӏǀʟ", m: "мМΜᴍ", n: "ոΝɴ", o: "оοօⲟОΟՕⲞᴏ", p: "рРρΡᴘ", q: "ԛԚ", r: "гᴦʀ", s: "ѕЅꜱ",
  t: "тТτΤᴛ", u: "υսᴜ", v: "νѵᴠ", w: "ԝԜѡᴡ", x: "хХχΧ", y: "уУүΥʏ", z: "Ζᴢ",
};
const PLAIN_OF = new Map(Object.entries(LOOK_ALIKES).flatMap(([plain, likes]) => [...likes].map((like) => [like, plain])));
const HIDDEN = String.raw`[\p{M}\p{Cf}\p{DI}\u2800]`; // what the fold removes
const FOLD = [[/[^\s\p{P}]+/gu, (word) => word.normalize("NFKD")], [new RegExp(HIDDEN, "gu"), ""], [new RegExp(QUESTION, "g"), "?"], [new RegExp(`[${[...PLAIN_OF.keys()].join("")}]`, "g"), (c) => PLAIN_OF.get(c)]];
const foldAll = (text) => FOLD.reduce((t, [pattern, plain]) => t.replace(pattern, plain), text);
/**
 * A character that the owner may not see, or that is not what it shows: one that the fold removes, a control character,
 * or one whose compatibility form starts with a space or a mark (U+037A, U+FE70), or, for a character that is no letter
 * or digit, has a letter or a digit (U+2116, U+2100, a circled or parenthesized letter). Joined to the phrase, it makes
 * the phrase no phrase, and the note says so.
 */
const hiddenNext = (c) => {
  const plain = c.normalize("NFKD");
  return new RegExp(HIDDEN, "u").test(c) || (/\S/u.test(c) && (/\p{Cc}/u.test(c) || /^[\s\p{M}]/u.test(plain) || (/[^\p{L}\p{N}]/u.test(c) && /[\p{L}\p{N}]/u.test(plain))));
};
const fold = (text) => {
  const head = HEAD.exec(text)?.[0];
  return head === undefined || hiddenNext(String.fromCodePoint(text.codePointAt(head.length) ?? 32)) ? text : head + foldAll(text.slice(head.length));
};
// More words after the phrase only on a plain line: blank lines, then at most 3 spaces. A quote mark, a bullet, a tab or
// a 4-space indent before the phrase makes the line a paste (F-R710-1). The phrase alone keeps the wider START.
const PLAIN = String.raw`^(?:(?:(?!\uFEFF)\s)*[\r\n])? {0,3}`;
// The question guard comes before the space run, so that one space and two spaces give the same answer, and so that the
// run never backtracks into a re-scan of the line: a lookahead after a greedy run reads the line again at each step of
// the run, quadratic time on a long first line (T34, T194 cycle 1).
const SAGE_ON = new RegExp(`${START}${SAGE}${AND_AUTOPILOT}?${END}|${PLAIN}${SAGE}${AND_AUTOPILOT}?(?!.*\\?)${SP}+`, "i"); // "." stops at a line break
// An off word soon after the phrase: after any gap and at most 5 small words (T210, T213). It blocks the on rule and
// switches autopilot off, because off is the safe direction. The group is the off word, for the note. The caller runs it
// on the text with the phrase as it is and the rest folded, as main does, and on the whole text folded, so that a mark,
// a hidden character or a look-alike in or right after the phrase cannot hide the off word (T214).
const OFF_PHRASE_START = String.raw`${OFF_START}(?:enter${OFF_SP}+)?sage${OFF_SP}+mode`;
const OFF_AFTER = new RegExp(`${OFF_PHRASE_START}(?:${OFF_SP}+on)?${GAP}(?:${FILLER}${SEP}+){0,5}(${OFF_NEAR})`, "iu");
const OFF_HEAD = new RegExp(OFF_PHRASE_START, "iu");
const OFF_PHRASE = new RegExp(`${OFF_START}sage${OFF_SP}+mode${OFF_SP}+off`, "iu"); // the off phrase has its own rules
const OFF_LINE = new RegExp(`${LINE_START}(?:sage${OFF_SP}+mode|autopilot)${OFF_SP}+off\\b`, "im"); // in any text, at the start of any line
const SAGE_OFF = new RegExp(`${OFF_START}sage${OFF_SP}+mode${OFF_SP}+off(?![\\p{L}\\p{N}-])(?!.*\\?)`, "iu"); // "." stops at a line break
const AUTOPILOT_ON = new RegExp(`${START}(?:autopilot${SP}+on|${SAGE}${AND_AUTOPILOT})${END}`, "i");
// A message that starts with a mode word, but whose switch did not happen, gets a note (the caller), so that a miss is
// never silent. MODE_WORD reads the folded text, so that a mode word with a hidden character, a mark or a look-alike
// letter in it or joined to it still gets the note; RAW_WORD and the next character say that it was so (R737, R738).
const MODE_WORD = new RegExp(`${OFF_START}(?:(?:enter${OFF_SP}+)?sage${OFF_SP}+mode|autopilot)(?![\\p{L}\\p{N}])`, "iu");
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
const OFF_WORD = new RegExp(String.raw`\b${OFF_WORDS}|\bauto[-\s]?pilots?\s*=\s*false\b`, "i");
/** The broad off rule: an off line, or autopilot and an off word anywhere. */
const broadOff = (text) => OFF_LINE.test(text) || (AUTOPILOT.test(text) && OFF_WORD.test(text));
// The names that the note may give an off word, by the start of the match: fixed words, never the owner's spelling and
// never text that an agent can write, such as a queued message (F-R741-4).
const OFF_NAMES = [["off"], ["no"], ["without"], ["dont", "don't"], ["do not"], ["end"], ["quit"], ["exit"], ["stop"], ["disabl", "disable"], ["paus", "pause"], ["cancel"], ["kill"], ["halt"], ["deactivat", "deactivate"], ["abort"], ["suspend"], ["switch", "off"], ["turn", "off"]];
const offName = (match = "") => {
  const word = match.toLowerCase().replace(/['’]/g, "").replace(/\s+/g, " ");
  const name = OFF_NAMES.find(([start]) => word.startsWith(start));
  return name ? name.at(-1) : "";
};

/** Origin is supplied by the provider; this function does not authenticate text. */
export function modeSignals({ owner, text, outside, all }) {
  if (typeof owner !== "boolean" || [text, outside, all].some(value => typeof value !== "string")) {
    throw Error("Invalid mode prompt");
  }
  const nextOf = (start) => String.fromCodePoint(text.codePointAt(start.length) ?? 32);
  const head = RAW_WORD.exec(text)?.[0];
  const hidden = head !== undefined && hiddenNext(nextOf(head));
  // The off rule reads the owner's text in up to three forms: the phrase as it is and the rest folded, as on main; the
  // same with a space for a hidden character joined to the phrase, so that a symbol that folds into letters (U+2116,
  // U+2100, a circled letter) cannot hide the off word after it (F-R740-1); and the whole text folded, so that a mark or
  // a look-alike in the phrase cannot either (T214). The mode word reads them too.
  const loose = owner ? foldAll(text) : "";
  const offHead = owner ? OFF_HEAD.exec(text)?.[0] : undefined;
  const c = offHead === undefined ? "" : nextOf(offHead);
  const forms = offHead === undefined ? [loose] : [...(hiddenNext(c) ? [`${offHead} ${foldAll(text.slice(offHead.length + c.length))}`] : []), offHead + foldAll(text.slice(offHead.length)), loose];
  const near = forms.map((form) => OFF_AFTER.exec(form)?.[1]).find((word) => word !== undefined);
  const offNext = near !== undefined;
  // The phrase and an off word soon after it, other than the off phrase, which has its own rules (T200).
  const offAfter = offNext && !OFF_PHRASE.test(text);
  // An off in the owner's own text, in any letter form. Only this off may make an autopilot on a planned miss: an off
  // line in an agent's frame turns autopilot off too, but the owner still gets the note (F-R724-L2).
  // The rule reads the text as it is too, so that the fold can never hide an off that main's rule read (F-R741).
  const ownOff = owner && (offAfter || broadOff(outside) || broadOff(foldAll(outside)));
  const autopilotWord = owner && AUTOPILOT_WORD.test(text);
  const modeWord = owner && (offNext || [text, ...forms].some((form) => MODE_WORD.test(form))); // "sage modeoff" too
  return {
    sageOff: owner && SAGE_OFF.test(text),
    sageOn: owner && !offNext && SAGE_ON.test(fold(text)),
    autopilotOff: OFF_LINE.test(all) || ownOff || (!owner && broadOff(all)),
    autopilotOn: owner && AUTOPILOT_ON.test(text),
    modeWord,
    autopilotWord,
    autopilotAsked: owner && (AUTOPILOT_ASKED.test(text) || (autopilotWord && !ownOff)),
    // Why an ask missed, for the note: "and" before autopilot, or no "on" right after it (R732).
    autopilotGap: !owner ? "" : AND_FIRST.test(text) ? "and" : NO_ON.test(text) ? "on" : "",
    ownOff,
    offAfter,
    // The off word that won, as the note names it (R738): a fixed name of an off word in the owner's own text, or "".
    offWord: ownOff ? offName(offAfter ? near : OFF_WORD.exec(loose)?.[0]) : "",
    // A hidden character, a mark or a look-alike letter in the mode word or joined to its end (R737, R738).
    joined: modeWord && (head === undefined || hidden),
    pasted: modeWord && !PLAIN_WORD.test(text),
    question: owner && QUESTION_MARK.test(firstLine(text)),
  };
}

