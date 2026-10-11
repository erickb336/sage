// The mode phrases, in classified prompt text. "sage mode" (also "sage mode on"), "sage mode off" and
// "autopilot on" count only at the start of the message, so that a mention or a quote switches nothing: "sage mode
// off" also drops the git rules. "sage mode" may stand alone, end at ".", ",", ":", ";", "!" or the end of its line, or
// go on with a space and more words ("sage mode continue on the sage project"), as long as its line has no question mark
// of any script and the next word does not mean off: "sage mode?", "sage mode online: is it a thing?", "sage mode on
// off", "sage mode stop" and "sage mode: off" switch nothing on, and the off word next switches autopilot off (T194,
// T200). The words may go on only on a plain line: a Markdown quote, a list item or a code line that starts with the phrase and more words is a paste, not a request. "autopilot on" stays
// strict: it must stand alone or end at that punctuation or its line, so "autopilot on?" and "autopilot on main" switch
// nothing. "sage mode off" must not run on into a longer word ("sage mode off-topic"), and its line must have no "?"
// ("sage mode off? what does it do?"). Because a missed off is the unsafe one, any line that starts with "sage mode off"
// or "autopilot off" switches autopilot off, even as a question or in a frame. The owner's own text also switches it
// off when it mentions autopilot and has an off word anywhere. A frame does not, because its boilerplate has off words
// ("NOT a message from the user"). Off wins over on. Only OFF_LINE has the m flag: with it, "^" also matches the start
// of each later line.
const START = String.raw`^[\s"'“‘*_>-]*`;
const SP = String.raw`[^\S\r\n  ]`; // a space, a tab or an NBSP, never a line break
// A prefix that stays on its line. With the m flag, "^" matches after each line break, so a prefix that also matched
// line breaks would read each run of blank lines again from each of its lines: quadratic time on a long report (T34).
const LINE_START = String.raw`^(?:${SP}|["'“‘*_>-])*`;
const END = String.raw`(?=${SP}*(?:[.,:;!\r\n  ]|$))`;
const SAGE = String.raw`(?:enter${SP}+)?sage${SP}+mode(?:${SP}+on)?`;
const AND_AUTOPILOT = String.raw`(?:${SP}+autopilot|(?:${SP}*[.,:;!]${SP}*|${SP}+)autopilot${SP}+on)`; // "sage mode autopilot", "sage mode, autopilot on"
// Every question mark: ASCII, full-width, Arabic, double, with an exclamation mark, small, and the Greek one (U+037E).
const QUESTION = "[?？؟⁇⁈⁉﹖;]";
// The off words in any form ("no more", "turn off", "switch off" and "hold off" have one too).
const OFF_WORDS = String.raw`(?:(?:off|no|without|don['’]?t|do\s+not|end(?:s|ed|ing)?|quit(?:s|ting)?|exit(?:s|ed|ing)?)\b|(?:stop|disabl|paus|cancel|kill|halt|deactivat|abort|suspend))`;
// The on rule folds only the words after the phrase, never the phrase itself: a look-alike letter, a zero-width space or
// a combining mark in the phrase makes it no phrase (F-R725-1). In the tail, each word gets its compatibility form and
// loses its marks (NFKD: mathematical, circled and full-width letters become plain ones), then its invisible format
// characters (a soft hyphen, a zero-width space), then the letters in LIKE become the plain letters in PLAIN_LETTERS:
// Cyrillic and Greek look-alikes of "o" and "f", and the small capitals. The tail's punctuation keeps its form, so
// "sage mode！" stays a miss (F-T72-20); each question mark becomes "?". So "sage mode o<soft hyphen>ff", "sage mode
// оff" (a Cyrillic "о") and "sage mode ᴏꜰꜰ" have an off word after the phrase, not more words (T200).
// The phrase ends at its last letter: a letter, a mark, a digit or a format character next makes it no phrase (R733).
const HEAD = new RegExp(`${START}(?:enter${SP}+)?sage${SP}+mode(?![\\p{L}\\p{M}\\p{N}\\p{Cf}])`, "iu");
const LIKE = "оοօⲟОΟՕⲞꬵϝϜғҒᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘʀꜱᴛᴜᴠᴡʏᴢ";
const PLAIN_LETTERS = "oooooooofffffabcdefghijklmnoprstuvwyz";
const FOLD = [[/[^\s\p{P}]+/gu, (word) => word.normalize("NFKD")], [/[\p{M}\p{Cf}]/gu, ""], [new RegExp(QUESTION, "g"), "?"], [new RegExp(`[${LIKE}]`, "g"), (c) => PLAIN_LETTERS[LIKE.indexOf(c)]]];
const fold = (text) => {
  const head = HEAD.exec(text)?.[0];
  return head === undefined ? text : head + FOLD.reduce((t, [pattern, plain]) => t.replace(pattern, plain), text.slice(head.length));
};
// More words after the phrase only on a plain line: blank lines, then at most 3 spaces. A quote mark, a bullet, a tab or
// a 4-space indent before the phrase makes the line a paste (F-R710-1). The phrase alone keeps the wider START.
const PLAIN = String.raw`^(?:\s*[\r\n])? {0,3}`;
// The question guard comes before the space run, so that one space and two spaces give the same answer, and so that the
// run never backtracks into a re-scan of the line: a lookahead after a greedy run reads the line again at each step of
// the run, quadratic time on a long first line (T34, T194 cycle 1).
const SAGE_ON = new RegExp(`${START}${SAGE}${AND_AUTOPILOT}?${END}|${PLAIN}${SAGE}${AND_AUTOPILOT}?(?!.*\\?)${SP}+`, "i"); // "." stops at a line break
// An off word next: the off words, also after "on" (F-R706-1) or after a comma, a colon, a semicolon or a dash
// (F-R725-2), and "switch it off" or "turn off" (F-R710-2). "sage mode offline" and "sage mode office hours" are more
// words. After the phrase, it blocks the on rule and switches autopilot off, because off is the safe direction.
const OFF_SOON = String.raw`${SP}*(?:[,:;–—-]${SP}*)?(?:${OFF_WORDS}|(?:switch|turn)${SP}+(?:\S+${SP}+)?off\b)`;
const OFF_AFTER = new RegExp(`${START}${SAGE}${OFF_SOON}`, "i");
const OFF_PHRASE = new RegExp(`${START}sage${SP}+mode${SP}+off`, "i"); // the off phrase has its own rules
const OFF_LINE = new RegExp(`${LINE_START}(?:sage${SP}+mode|autopilot)${SP}+off\\b`, "im"); // in any text, at the start of any line
const SAGE_OFF = new RegExp(`${START}sage${SP}+mode${SP}+off(?![\\p{L}\\p{N}-])(?!.*\\?)`, "iu"); // "." stops at a line break
const AUTOPILOT_ON = new RegExp(`${START}(?:autopilot${SP}+on|${SAGE}${AND_AUTOPILOT})${END}`, "i");
// A message that starts with a mode word, but whose switch did not happen, gets a note (the caller), so that a miss is
// never silent. These read what the start asks for: a mode word, the autopilot word, autopilot with its on word.
const MODE_WORD = new RegExp(`${START}(?:(?:enter${SP}+)?sage${SP}+mode|autopilot)(?![\\p{L}\\p{N}])`, "iu");
const AUTOPILOT_WORD = new RegExp(`${START}autopilot(?![\\p{L}\\p{N}])`, "iu");
// Autopilot asked for at the start: its on phrase, or the on phrase and then autopilot ("and autopilot", "autopilot
// please"), but not autopilot with an off word next ("sage mode autopilot off"). Autopilot alone at the start asks for it
// too when the owner's text has no off word (the caller).
const AUTOPILOT_ASKED = new RegExp(`${START}(?:autopilot${SP}+on|${SAGE}(?:${SP}*[.,:;!]${SP}*|${SP}+)(?:and${SP}+)?autopilot(?:${SP}+on|(?!${OFF_SOON})))(?![\\p{L}\\p{N}])`, "iu");
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
const broadOff = (text) => OFF_LINE.test(text) || (AUTOPILOT.test(text) && OFF_WORD.test(text));

/** Origin is supplied by the provider; this function does not authenticate text. */
export function modeSignals({ owner, text, outside, all }) {
  if (typeof owner !== "boolean" || [text, outside, all].some(value => typeof value !== "string")) {
    throw Error("Invalid mode prompt");
  }
  const folded = owner ? fold(text) : "";
  const offNext = OFF_AFTER.test(folded);
  // The phrase and an off word next, other than the off phrase, which has its own rules (T200).
  const offAfter = offNext && !OFF_PHRASE.test(text);
  // An off in the owner's own text. Only this off may make an autopilot on a planned miss: an off line in an agent's
  // frame turns autopilot off too, but the owner still gets the note (F-R724-L2).
  const ownOff = owner && (broadOff(outside) || offAfter);
  const autopilotWord = owner && AUTOPILOT_WORD.test(text);
  const modeWord = owner && MODE_WORD.test(text);
  return {
    sageOff: owner && SAGE_OFF.test(text),
    sageOn: owner && !offNext && SAGE_ON.test(folded),
    autopilotOff: OFF_LINE.test(all) || ownOff || (!owner && broadOff(all)),
    autopilotOn: owner && AUTOPILOT_ON.test(text),
    modeWord,
    autopilotWord,
    autopilotAsked: owner && (AUTOPILOT_ASKED.test(text) || (autopilotWord && !ownOff)),
    ownOff,
    offAfter,
    pasted: modeWord && !PLAIN_WORD.test(text),
    question: owner && QUESTION_MARK.test(firstLine(text)),
  };
}
