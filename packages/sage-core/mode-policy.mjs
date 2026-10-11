// The mode phrases, in classified prompt text. "sage mode" (also "sage mode on"), "sage mode off" and
// "autopilot on" count only at the start of the message, so that a mention or a quote switches nothing: "sage mode
// off" also drops the git rules. "sage mode" may stand alone, end at ".", ",", ":", ";", "!" or the end of its line, or
// go on with a space and more words ("sage mode continue on the sage project"), as long as its line has no question mark
// of any script and the next word does not mean off: "sage mode?", "sage mode online: is it a thing?", "sage mode on
// off" and "sage mode stop" switch nothing (T194, T200). The words may go on only on a plain line: a Markdown quote, a
// list item or a code line that starts with the phrase and more words is a paste, not a request. "autopilot on" stays
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
// The on rule reads the text with each question mark as "?", without invisible format characters (a soft hyphen, a
// zero-width space) or combining marks, and with the letters that look like "o" or "f" as those letters: "sage mode
// o<soft hyphen>ff" and "sage mode оff" (a Cyrillic "о") have an off word after the phrase, not more words (T200).
const FOLD = [[new RegExp(QUESTION, "g"), "?"], [/[\p{M}\p{Cf}]/gu, ""], [/[оοօᴏⲟОΟՕⲞｏＯ]/g, "o"], [/[ꬵϝϜғҒｆＦ]/g, "f"]];
const fold = (text) => FOLD.reduce((t, [pattern, letter]) => t.replace(pattern, letter), text);
// More words after the phrase only on a plain line: blank lines, then at most 3 spaces. A quote mark, a bullet, a tab or
// a 4-space indent before the phrase makes the line a paste (F-R710-1). The phrase alone keeps the wider START.
const PLAIN = String.raw`^(?:\s*[\r\n])? {0,3}`;
// The guards come before the space run, so that one space and two spaces give the same answer, and so that the run never
// backtracks into a re-scan of the line: a lookahead after a greedy run reads the line again at each step of the run,
// quadratic time on a long first line (T34, T194 cycle 1). The off guard blocks an off word, also after "on" (F-R706-1),
// and "switch it off" or "turn off" (F-R710-2): "sage mode offline" and "sage mode office hours" turn the mode on, as any
// other word after the phrase does; "sage mode off-topic" is an off word with a hyphen, so OFF_LINE reads it as an
// autopilot off and SAGE_ON does not turn the mode on.
const OFF_NEXT = String.raw`(?!(?:${SP}+on)?${SP}*(?:${OFF_WORDS}|(?:switch|turn)${SP}+(?:\S+${SP}+)?off\b))`;
const SAGE_ON = new RegExp(`${START}${SAGE}${AND_AUTOPILOT}?${END}|${PLAIN}${SAGE}${AND_AUTOPILOT}?${OFF_NEXT}(?!.*\\?)${SP}+`, "i"); // "." stops at a line break
const OFF_LINE = new RegExp(`${LINE_START}(?:sage${SP}+mode|autopilot)${SP}+off\\b`, "im"); // in any text, at the start of any line
const SAGE_OFF = new RegExp(`${START}sage${SP}+mode${SP}+off(?![\\p{L}\\p{N}-])(?!.*\\?)`, "iu"); // "." stops at a line break
const AUTOPILOT_ON = new RegExp(`${START}(?:autopilot${SP}+on|${SAGE}${AND_AUTOPILOT})${END}`, "i");
// A message that starts with a mode word, but whose switch did not happen, gets a note (the caller), so that a miss is
// never silent. These read what the start asks for: a mode word, the autopilot word, autopilot with its on word.
const MODE_WORD = new RegExp(`${START}(?:sage${SP}+mode|autopilot)(?![\\p{L}\\p{N}])`, "iu");
const AUTOPILOT_WORD = new RegExp(`${START}autopilot(?![\\p{L}\\p{N}])`, "iu");
const AUTOPILOT_ASKED = new RegExp(`${START}(?:autopilot${SP}+on|${SAGE}${AND_AUTOPILOT})(?![\\p{L}\\p{N}])`, "iu");
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
  return {
    sageOff: owner && SAGE_OFF.test(text),
    sageOn: owner && SAGE_ON.test(fold(text)),
    autopilotOff: OFF_LINE.test(all) || broadOff(owner ? outside : all),
    autopilotOn: owner && AUTOPILOT_ON.test(text),
    modeWord: owner && MODE_WORD.test(text),
    autopilotWord: owner && AUTOPILOT_WORD.test(text),
    autopilotAsked: owner && AUTOPILOT_ASKED.test(text),
    question: owner && QUESTION_MARK.test(firstLine(text)),
  };
}
