// The one reader of a sage report (T483): the Claude hook's stop gate and lead rules, the Codex stop hook and the state
// tool's verdict check read a review's or QA's report with it, so that each of them reads the same RESULT and severities.
import { REPORT_FIELDS } from "./report.mjs";

const SP = String.raw`[^\S\r\n  ]`; // a space, a tab or an NBSP, never a line break
/** A line end, kept by a split: LF, CRLF, and each other break that a reader sees as one: CR, VT, FF, NEL, U+2028 and U+2029 (F-T289-26). */
const LINE_END = /(\r\n|[\n\r\v\f\u0085\u2028\u2029])/;
/**
 * The one field rule of a brief and a report (F-T289-24). A field starts at a line that is not indented and whose text,
 * after Markdown marks (*, _, #, |, >, -) and spaces, starts with the field's name: "STATUS done", "**STATUS**: done",
 * "| STATUS | done |". The field's text is the rest of that line, without the colon, bold marks or table bars around it,
 * and the lines up to the next field. An indented line, a list item ("- RESULT of npm test", F-T289-38) and a line in a
 * code block ("STATUS 200" of a test's output) never start a field. The fields of the text, in order, each with its line.
 * No pattern of the rule can backtrack far, so a padded line costs time in proportion to its length (F-T289-34).
 */
export function fieldsOf(text, names) {
  const out = [];
  for (const { line, fenced } of linesOf(text)) {
    const name = fenced || /^\s/.test(line) || LIST_ITEM.test(line) ? undefined : names.find((n) => new RegExp(`^(?:[*_#|>-]|${SP})*${n}\\b`).test(line));
    if (name) out.push({ name, line: line.slice(0, 80), rest: trimEnd(line.slice(line.indexOf(name) + name.length).replace(/^[\s*_|:]+/, "")), lines: [] });
    else out.at(-1)?.lines.push(line);
  }
  return out;
}
/**
 * The lines of a text, each with whether it is in a code block or is one of its fences. A fence counts as CommonMark
 * has it: three or more backticks or tildes, indented by at most three spaces; the block ends at a fence of the same
 * character, at least as long, with nothing after it. An indented fence line is text, so it cannot hide a field (F-T289-52).
 * A fence opens or closes only at a line that starts after LF, CR or CRLF, where Markdown starts a line too: after
 * U+2028 or another break that Markdown does not show, a fence would hide fields that its reader sees (F-T289-63).
 */
export function linesOf(text) {
  let fence;
  const parts = String(text ?? "").split(LINE_END);
  return parts.filter((_, k) => k % 2 === 0).map((line, k) => {
    const mark = (k === 0 || /^[\r\n]/.test(parts[2 * k - 1])) && /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const opens = !fence && mark && !(mark[1][0] === "`" && mark[2].includes("`"));
    const closes = fence && mark && mark[1][0] === fence[0] && mark[1].length >= fence.length && !mark[2].trim();
    const fenced = Boolean(fence || opens);
    if (opens) fence = mark[1];
    else if (closes) fence = undefined;
    return { line, fenced };
  });
}
/** The most characters of a line that the report reader reads of RESULT; a longer line under FINDINGS makes the report unreadable (F-T289-48). */
const LINE_MAX = 4096;
/** A Markdown list item: a bullet (-, * or +) or a number (1. or 1)), then a space. Bold (**) is no bullet. */
const LIST_ITEM = /^[-*+][ \t]|^\d+[.)][ \t]/;
/** The text without spaces, bold marks and table bars at its end, by a loop: a pattern such as /[\s*_|]+$/ takes time that grows with the square of a padded line (F-T289-34). */
function trimEnd(text) {
  let end = text.length;
  while (end > 0 && /[\s*_|]/.test(text[end - 1])) end--;
  return text.slice(0, end);
}
/** The form of a finding in a report's FINDINGS that the report skill gives: the severity right after the key (F-T289-11). */
export const FINDING_FORM = "- <key> <severity> <summary>";
/** The words of RESULT that the lead rules read (F-T289-39). */
export const RESULT_WORDS = ["CLEAN", "PASS", "FINDINGS", "FAIL"];
/** A word that is or starts with a severity word: "high", "Medium", "low-level", "HIGH:" (but not "lower" or "highest"). */
const SEVERE = /^(?:high|medium|low)(?![a-z])/i;
/** A severity word as a label, with a colon after it: "high:", "**HIGH**:", "(low):" (F-T289-54). */
const LABEL = /\b(?:high|medium|low)[*_)\]]*:/i;
/** A word without the marks around it: brackets, parentheses, bold, code and a colon or a trailing dash. A loop, so a word of many marks costs time in proportion to its length (F-T289-34). */
function unmarked(word = "") {
  let start = 0, end = word.length;
  while (start < end && "([*_`".includes(word[start])) start++;
  while (end > start && ")]*_`:,.-".includes(word[end - 1])) end--;
  return word.slice(start, end);
}
/**
 * One line under FINDINGS, without its indent, read by the narrow form of the report skill (F-T289-47, F-T289-58):
 *   - finding: a list item (-, *, + or 1. or 1)) whose first word is a key (with a digit: K1, F-T1-3, R966-1) and whose
 *     next word is the severity, high, medium or low in any case, with only marks around it: "- K1 medium:",
 *     "* K1 (High)", "1. K1 - low -", "- `K1` **medium**". Its summary has no severity label ("also high:").
 *   - severe: any other line whose first or second word is or starts with a severity word ("- High: low-privilege",
 *     "- high K1", "- K1 low-level", "- Confirmed medium load", "Severity: high"), or that has a severity label: a line
 *     that may hold a finding that the reader cannot read, so it is never detail and never clean.
 *   - other: any other line.
 */
function lineOf(text) {
  const item = /^(?:[-*+]|\d+[.)])[ \t]+/.exec(text);
  const [key, ...rest] = (item ? text.slice(item[0].length) : text).split(/[ \t]+/);
  const at = rest.findIndex((w) => !/^[-–—:|]+$/.test(w)), word = unmarked(rest[at]);
  if (item && /\d/.test(unmarked(key)) && !SEVERE.test(unmarked(key)) && /^(?:high|medium|low)$/i.test(word) && !LABEL.test(rest.slice(at + 1).join(" "))) return { severity: word.toLowerCase() };
  return { severe: SEVERE.test(unmarked(key)) || SEVERE.test(word) || LABEL.test(text) };
}
/** The levels of the severities, and the words that the report reader looks for in all of FINDINGS: critical, severe and blocker are high. */
const LEVELS = ["none", "low", "medium", "high"];
const LEVEL = { low: 1, medium: 2, high: 3, critical: 3, severe: 3, blocker: 3 };
const LEVEL_WORD = /(?<![\p{L}\p{N}])(?:low|medium|high|critical|severe|blocker)(?![\p{L}\p{N}])/gu;
/** Cyrillic and Greek letters that look like the Latin letters of LEVEL's words, in lower case, as the Latin letter. */
const LOOK_ALIKE = { а: "a", в: "b", с: "c", ԁ: "d", е: "e", ԍ: "g", һ: "h", н: "h", і: "i", ӏ: "l", к: "k", м: "m", о: "o", р: "p", ѕ: "s", т: "t", у: "y", ԝ: "w", х: "x", α: "a", β: "b", ε: "e", η: "h", ι: "i", κ: "k", μ: "m", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", ω: "w", χ: "x" };
/**
 * The level of the highest severity word in a line, as a whole word in any case, after NFKC, look-alike Cyrillic and
 * Greek letters as Latin ones, and no zero-width or other format character: "a Hіgh risk" with a Cyrillic і is high
 * (F-T289-60, F-T289-62, F-T289-63). 0 when it has none.
 */
function levelIn(line) {
  const text = line.normalize("NFKC").toLowerCase().replace(/[^\0-\x7f]/g, (c) => LOOK_ALIKE[c] ?? c).replace(/\p{Cf}/gu, "");
  return Math.max(0, ...[...text.matchAll(LEVEL_WORD)].map(([word]) => LEVEL[word]));
}
/** None alone, in any case, also as a list item or with a period: the one clean form of FINDINGS (F-T289-48, F-T289-51). */
const NONE_LINE = /^(?:[-*+][ \t]+)?none\.?$/i;
/** A line that starts a FINDINGS field in any form, also indented or as a list item ("- FINDINGS", F-T289-52). */
const FINDINGS_AT = new RegExp(`^(?:[*_#|>]|${SP})*FINDINGS\\b`);
const findingsLine = (line) => FINDINGS_AT.test(line.trimStart().replace(/^(?:[-*+]|\d+[.)])[ \t]+/, ""));
/**
 * The one reader of a report, for the stop gate and the lead rules, by the one field rule (fieldsOf). It never lowers a
 * severity and never reads a finding as none: a line that it cannot read makes the report unreadable, and the sage
 * reads it (F-T289-47).
 *   - result: the first word of RESULT, in upper case; when RESULT has no text on its line, the first word of the next
 *     line with text ("## RESULT", then "PASS") (F-T289-39);
 *   - severities: the severity of each finding line under FINDINGS (lineOf), each with any detail on indented lines
 *     under it (F-T289-29). FINDINGS is either none alone (NONE_LINE) or finding lines.
 * The report is unreadable (problem) when a field is given twice (F-T289-20), also FINDINGS as an indented line or a list
 * item outside a code block (F-T289-52); when RESULT or FINDINGS is missing; when RESULT does not start with one of
 * RESULT_WORDS; when FINDINGS is empty, has none and findings, or none with RESULT FINDINGS or FAIL (F-T289-48); or when
 * a line under FINDINGS is longer than LINE_MAX, or is not none, a finding or detail: an unindented line, an indented
 * one with no finding above it (F-T289-25), or an indented line that is severe (F-T289-46, F-T289-54).
 * The severity rule (F-T289-60, F-T289-62, F-T289-63, F-T298-1): it is unreadable too when a line of FINDINGS has a
 * severity word (levelIn) above the severity of its own finding: a finding line and the lines under it compare with
 * that finding. (A line above the first finding is none or makes the report unreadable before this rule.) So a raised
 * word under a low finding counts also when a high finding is in the report, and an honest detail line such as "a high
 * row count" under a low finding blocks once, and the helper writes it again. A lower word under a higher finding is
 * detail. At verdict acceptance, requireComplete also requires text in every REPORT_FIELDS field. Other callers can
 * read a partial stop to give correction feedback; retaining that stop does not make it eligible to back a verdict.
 */
export function readReport(text, { requireComplete = false } = {}) {
  const fields = fieldsOf(text, REPORT_FIELDS), of = (name) => fields.filter((f) => f.name === name);
  const incomplete = requireComplete && REPORT_FIELDS.find(name => !of(name).some(f => [f.rest, ...f.lines].some(line => line.trim())));
  const [r] = of("RESULT"), [f] = of("FINDINGS");
  const another = linesOf(text).filter(({ line, fenced }) => !fenced && findingsLine(line))[1]?.line;
  const twice = REPORT_FIELDS.find((name) => of(name).length > 1) ?? (another === undefined ? undefined : "FINDINGS");
  const said = r && [r.rest, ...r.lines].map((line) => line.trimStart().slice(0, LINE_MAX).trim()).find(Boolean);
  const result = (/^[^A-Za-z]*([A-Za-z]+)/.exec(said ?? "")?.[1] ?? "").toUpperCase();
  const severities = [], owned = []; // owned: each line under a finding, with the level of that finding
  let none = false, long = false, odd;
  for (const line of f ? [f.rest, ...f.lines] : []) {
    if (line.length > LINE_MAX) { long = true; continue; }
    const text = line.trim(), indented = /^\s/.test(line), { severity, severe } = lineOf(text);
    if (!text) continue;
    if (severity && !indented) severities.push(severity);
    else if (NONE_LINE.test(text)) none = true;
    else if (!(indented && severities.length && !severity && !severe)) odd ??= text;
    if (severities.length) owned.push([text, LEVEL[severities.at(-1)]]);
  }
  const seen = owned.find(([text, own]) => levelIn(text) > own);
  const problem = twice ? `${twice} is given twice, the second time in the line ${JSON.stringify((of(twice)[1]?.line ?? another).trim().slice(0, 80))}` : incomplete ? `${incomplete} is missing or empty` : !r ? "it has no RESULT" : !f ? "it has no FINDINGS" :
    !RESULT_WORDS.includes(result) ? `RESULT starts with ${JSON.stringify((said ?? "").slice(0, 80))}, not with one of ${RESULT_WORDS.join(", ")}` :
    long ? `a line under FINDINGS is longer than ${LINE_MAX} characters` : odd !== undefined ? `a line under FINDINGS is not none alone and not a finding in the form ${FINDING_FORM}: ${JSON.stringify(odd.slice(0, 80))}` :
    none && severities.length ? "FINDINGS has none and findings" : !none && !severities.length ? "FINDINGS is empty" :
    none && ["FINDINGS", "FAIL"].includes(result) ? `RESULT is ${result}, but FINDINGS is none` :
    seen ? `the line ${JSON.stringify(seen[0].slice(0, 80))} under FINDINGS has a severity word above the severity of its finding (${LEVELS[seen[1]]}): write that finding as its own line ${FINDING_FORM}` : undefined;
  return { result, severities, unreadable: Boolean(problem), ...(problem && { problem }) };
}
/**
 * Is a helper's report clean? RESULT CLEAN or PASS with no medium or high finding, or FINDINGS or FAIL with only low
 * ones (the clean rule: a cycle is clean when no medium or high finding is open). Anything else is not clean, also an
 * unreadable report or a stop with no report.
 */
export const cleanReport = ({ result, severities, unreadable } = {}) => !unreadable && Array.isArray(severities) && severities.every((v) => v === "low") &&
  (["CLEAN", "PASS"].includes(result) || (["FINDINGS", "FAIL"].includes(result) && severities.length > 0));
