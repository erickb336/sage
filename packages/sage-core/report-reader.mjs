// The one reader of a sage report (T483): the Claude hook's stop gate and lead rules, the Codex stop hook and the state
// tool's verdict check read a review's or QA's report with it, so that each of them reads the same RESULT and severities.
// Both stop gates ask for missing fields by its one field rule too (T461).
import { REPORT_FIELDS } from "./report.mjs";
import { agentCommandProblem, TEMP } from "./agent-rules.mjs";
import { commandWrites, inlineCode } from "./shell-write-policy.mjs";
import { programsRun } from "./command-reader.mjs";
import { programName } from "./command-policy.mjs";

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
/** The fields that a brief or a report does not give, by the one field rule. It does not read their values or accept a report. */
export function missingFields(names, text) {
  const given = new Set(fieldsOf(text, names).map((field) => field.name));
  return names.filter((name) => !given.has(name));
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
const RESULT_WORDS = ["CLEAN", "PASS", "FINDINGS", "FAIL"];
/** A word that is or starts with a severity word: "high", "Medium", "low-level", "HIGH:" (but not "lower" or "highest"). */
const SEVERE = /^(?:high|medium|low)(?![a-z])/i;
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
 *     "* K1 (High)", "1. K1 - low -", "- `K1` **medium**". Its severity is that word only; levelIn reads the rest.
 *   - other: any other line.
 */
function lineOf(text) {
  const item = /^(?:[-*+]|\d+[.)])[ \t]+/.exec(text);
  const [key, ...rest] = (item ? text.slice(item[0].length) : text).split(/[ \t]+/);
  const word = unmarked(rest.find((w) => !/^[-–—:|]+$/.test(w)));
  return item && /\d/.test(unmarked(key)) && !SEVERE.test(unmarked(key)) && /^(?:high|medium|low)$/i.test(word) ? { severity: word.toLowerCase(), key: unmarked(key) } : {};
}
/** The levels of the severities, and the words that the report reader looks for in all of FINDINGS: critical, severe and blocker are high. */
const LEVELS = ["none", "low", "medium", "high"];
const LEVEL = { low: 1, medium: 2, high: 3, critical: 3, severe: 3, blocker: 3 };
const LEVEL_WORD = /(?<![\p{L}\p{N}])(?:low|medium|high|critical|severe|blocker)(?![\p{L}\p{N}])/gu;
/** An ordinary word of a sentence: letters, with an inner apostrophe or hyphen, and not a severity word (T964). */
const ordinary = (word = "") => /^\p{L}+(?:['’-]\p{L}+)*$/u.test(word) && !Object.hasOwn(LEVEL, word.toLowerCase());
/**
 * The level of the highest severity that a line states, or 0 (F-T289-60, F-T289-62). It reads each severity word as a
 * whole word in any case, after NFKC and with no zero-width or other format character, also inside a word such as
 * "high-risk" or "(high)". A severity word in a sentence is text and states nothing (T964): a lower-case word that comes
 * after a, an or the, also with a comma, period or semicolon after it ("not a blocker.", "a high finding is refused"), or
 * with nothing after it between two ordinary words ("a real medium finding"). So "K2 high", "(raise to medium)",
 * "high:", "Severity: high", "is HIGH", "rated high" at the end of a line and a line that starts with a severity word
 * state it. A severity word in look-alike letters of another script is a limit of the reader (standing order 70).
 */
function levelIn(line) {
  const words = line.normalize("NFKC").replace(/\p{Cf}/gu, "").split(/\s+/);
  let level = 0;
  for (const [k, word] of words.entries()) {
    const [, bare, stop] = /^(\p{Ll}+)([,.;]?)$/u.exec(word) ?? [];
    const text = Object.hasOwn(LEVEL, bare ?? "") && (/^(?:a|an|the)$/i.test(words[k - 1] ?? "") || (!stop && ordinary(words[k - 1]) && ordinary(words[k + 1]?.replace(/[,.;]$/, ""))));
    if (!text) for (const [said] of word.toLowerCase().matchAll(LEVEL_WORD)) level = Math.max(level, LEVEL[said]);
  }
  return level;
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
 * one with no finding above it (F-T289-25), or an indented line in the shape of a finding (F-T289-33).
 * The severity rule (F-T289-60, F-T289-62, F-T289-63, F-T298-1, T964): a finding's severity is the word after its key,
 * and the rest of its line and its detail lines are text. It is unreadable too when a line of FINDINGS states a severity
 * (levelIn) above the severity of its own finding: a finding line and the lines under it compare with that finding. (A
 * line above the first finding is none or makes the report unreadable before this rule.) So "K2 high" or "(raise to
 * medium)" under a low finding counts also when a high finding is in the report, while a severity word in a sentence,
 * such as "a high row count" or a quoted test name "not ok 3 a high finding is refused", is detail. A lower word under a
 * higher finding is detail. At verdict acceptance, requireComplete also requires text in every REPORT_FIELDS field. Other callers can
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
  const severities = [], findings = [], owned = []; // owned: each line under a finding, with the level of that finding
  let none = false, long = false, odd;
  for (const line of f ? [f.rest, ...f.lines] : []) {
    if (line.length > LINE_MAX) { long = true; continue; }
    const text = line.trim(), indented = /^\s/.test(line), { severity, key } = lineOf(text);
    if (!text) continue;
    if (severity && !indented) severities.push(severity), findings.push({ key, severity });
    else if (NONE_LINE.test(text)) none = true;
    else if (!(indented && severities.length && !severity)) odd ??= text;
    else proofLine(findings.at(-1), text);
    if (severities.length) owned.push([text, LEVEL[severities.at(-1)]]);
  }
  const seen = owned.find(([text, own]) => levelIn(text) > own);
  const problem = twice ? `${twice} is given twice, the second time in the line ${JSON.stringify((of(twice)[1]?.line ?? another).trim().slice(0, 80))}` : incomplete ? `${incomplete} is missing or empty` : !r ? "it has no RESULT" : !f ? "it has no FINDINGS" :
    !RESULT_WORDS.includes(result) ? `RESULT starts with ${JSON.stringify((said ?? "").slice(0, 80))}, not with one of ${RESULT_WORDS.join(", ")}` :
    long ? `a line under FINDINGS is longer than ${LINE_MAX} characters` : odd !== undefined ? `a line under FINDINGS is not none alone and not a finding in the form ${FINDING_FORM}: ${JSON.stringify(odd.slice(0, 80))}` :
    none && severities.length ? "FINDINGS has none and findings" : !none && !severities.length ? "FINDINGS is empty" :
    none && ["FINDINGS", "FAIL"].includes(result) ? `RESULT is ${result}, but FINDINGS is none` :
    seen ? `the line ${JSON.stringify(seen[0].slice(0, 80))} under FINDINGS has a severity word above the severity of its finding (${LEVELS[seen[1]]}): write that finding as its own line ${FINDING_FORM}` : undefined;
  return { result, severities, findings, unreadable: Boolean(problem), ...(problem && { problem }) };
}

/**
 * The proof of a finding (T947): its first detail line of each name, "proof: <one command>", "saw: <the one output line>"
 * and, for a screenshot ("proof: screenshot <path>"), "steps: <the url and the actions>", also as a list item.
 */
function proofLine(finding, text) {
  const [, name, value] = /^(?:[-*+][ \t]+)?(proof|saw|steps):[ \t]*(\S.*)$/i.exec(text) ?? [];
  // One pair of Markdown backticks around the whole value is a mark, not part of the command (F-T947-5).
  if (name && !Object.hasOwn(finding, name.toLowerCase())) finding[name.toLowerCase()] = value.trim().replace(/^`([^`]+)`$/, "$1").trim();
}
/** The git subcommands that a proof may run: they only read (F-T947-2). */
const PROOF_GIT = ["status", "log", "show", "diff", "rev-parse", "ls-files", "grep", "cat-file", "blame"];
/**
 * Why a proof's git command is refused, or undefined (F-T947-2). A proof runs git only to read its own working copy: one of
 * PROOF_GIT, with no option before it but --no-pager (so no -C, -c, --git-dir or --work-tree), and no option that writes
 * a file or runs a program (--output, grep's -O). A line that the reader cannot read is commandWrites' to refuse.
 */
function gitProblem(proof, cwd) {
  let runs;
  try { runs = programsRun(proof, cwd); } catch { return undefined; }
  for (const { word, args } of runs) {
    if (programName(word) !== "git") continue;
    const at = args.findIndex((a) => !/^(?:--no-pager|-P)$/.test(a)), sub = args[at] ?? "";
    const bad = !PROOF_GIT.includes(sub) || args.slice(at + 1).some((a) => /^(?:--output|-O|--open-files-in-pager)/.test(a));
    if (bad) return `a proof runs git only to read its own working copy: git ${PROOF_GIT.join(", ")}, with no -C, -c, --git-dir, --work-tree or --output`;
  }
  return undefined;
}
/**
 * Why a review's or QA's report does not carry the proof of each medium or high finding, or undefined (T947). A finding
 * carries one command and the output line that shows the problem (proof: and saw:), or a screenshot and its steps (proof:
 * screenshot and steps:). The proof check reruns the command on a fresh copy of the head, so it is one that an agent may
 * run there: no stash or process program (agentCommandProblem), git only to read (gitProblem), no inline code, and no write
 * outside the scratch folders (commandWrites).
 * A low finding needs no proof, and an unreadable report gets the reader's own reason.
 */
function proofProblem(text, cwd, scratch = TEMP) {
  const { findings = [] } = readReport(text);
  for (const { key, severity, proof, saw, steps } of findings.filter((f) => f.severity !== "low")) {
    if (!proof) return `${key} is ${severity} and has no proof line`;
    const shot = /^screenshot[ \t]+\S/i.test(proof);
    if (shot ? !steps : !saw) return `${key}'s proof has no ${shot ? "steps" : "saw"} line`;
    const refused = !shot && (agentCommandProblem(proof, cwd) ?? gitProblem(proof, cwd) ??
      (inlineCode(proof) ? "it runs inline code (such as node -e or sh -c), which the gate cannot check: put the script in a file in your scratch folder, and run that file" :
        commandWrites(proof, cwd, scratch) ? "it writes outside the scratch folder" : undefined));
    if (refused) return `${key}'s proof ${JSON.stringify(proof.slice(0, 80))} is refused: ${refused}`;
  }
  return undefined;
}
/** The way to give a proof, for the stop gates of both providers (T947). */
const PROOF_RULE = "Under each medium or high finding, give its proof on indented lines: proof: <one command, run from the repository root of the head> and saw: <the one output line that shows the problem>, or proof: screenshot <path> and steps: <the url and the actions>. The command only reads, or writes only into your scratch folder in the temp folder; it runs no process program, no inline code and git only to read (status, log, show, diff, rev-parse, ls-files, grep, cat-file or blame). It runs from a fresh copy of the head after the project's dependency install (such as npm ci --ignore-scripts). Put long output in a scratch file, and name its path. A low finding needs no proof. A proof, saw or steps line states no severity above its finding's, as in K2 high; a severity word inside a sentence of quoted output is text. This stop gate stops you once.";
/** How to write a report that the one reader reads, for the stop gates of both providers (T964). */
const READ_RULE = `Give each field once, at the start of a line that is not in a list or a code block. Start RESULT with ${RESULT_WORDS.join(", ")}. Under FINDINGS write none alone, or one line for each finding in the form ${FINDING_FORM}, where the key has a digit (K1) and the severity is high, medium or low, with any detail on indented lines under it. A finding's severity is the word after its key. No line under FINDINGS states a severity above the severity of the finding that it is under, as in K2 high, (high), high: or a line that starts with a severity word; a lower-case severity word inside a sentence, such as "a high row count", is text. RESULT FINDINGS or FAIL needs a finding.`;
/**
 * Why a stop gate stops a review's or QA's report, or undefined (T964): the reader's problem (readReport) and, when proof
 * is on, the proof's problem (proofProblem), both in the one stop, so that the one fix chance covers each of them and a
 * fix of one cannot leave the other unchecked. who names the gate.
 */
export function stopReason(text, cwd, { who, proof = true }) {
  const { problem } = readReport(text), unproved = proof ? proofProblem(text, cwd) : undefined;
  return [problem && `sage: ${who} cannot read your report: ${problem}. ${READ_RULE}`, unproved && `sage: ${unproved}. ${PROOF_RULE}`].filter(Boolean).join(" ") || undefined;
}
/**
 * The outcome of a proof check (T947) on one line of its EVIDENCE: a key with a digit, then reproduced, not reproduced or
 * could not run, and any note after it. Near forms count too (F-T947-1): an indent (a nested list), a list mark (-, *, +,
 * 1. or a table bar) or none, marks around the key (`F-T1-1`, **F-T1-1**, [F-T1-1]) or the outcome, and a colon, a dash
 * or a bar between them: "- F-T1-1: reproduced", "1. **F-T1-1** — not reproduced", "| F-T1-1 | could not run |".
 * No part of the pattern can backtrack far, so a long line costs time in proportion to its length.
 */
const PROOF_LINE = /^[ \t]*(?:(?:[-*+|]|\d+[.)])[ \t]+)?[`*_[(]*([^\s`*_[\]():|]+)[`*_\])]*:?[ \t]+(?:[-–—:|][ \t]+)?[`*_]*(not[ \t]+reproduced|reproduced|could[ \t]+not[ \t]+run)(?![\p{L}\p{N}])/iu;
/**
 * The results of a proof check's report: each finding key that EVIDENCE lists, on the field's own line or a line under
 * it, with its outcome (reproduced, not reproduced or could not run), in a Map. The first line of a key counts. An
 * empty Map for any other report. A report with any such line is a proof check, so it backs no verdict.
 */
export function proofResults(text) {
  const results = new Map();
  for (const line of fieldsOf(text, REPORT_FIELDS).filter((f) => f.name === "EVIDENCE").flatMap((f) => [f.rest, ...f.lines])) {
    const [, key, outcome] = PROOF_LINE.exec(line.slice(0, LINE_MAX)) ?? [];
    if (/\d/.test(key) && !results.has(key)) results.set(key, outcome.toLowerCase().replace(/[ \t]+/g, " "));
  }
  return results;
}
/**
 * Is a helper's report clean? RESULT CLEAN or PASS with no medium or high finding, or FINDINGS or FAIL with only low
 * ones (the clean rule: a cycle is clean when no medium or high finding is open). Anything else is not clean, also an
 * unreadable report or a stop with no report.
 */
export const cleanReport = ({ result, severities, unreadable } = {}) => !unreadable && Array.isArray(severities) && severities.every((v) => v === "low") &&
  (["CLEAN", "PASS"].includes(result) || (["FINDINGS", "FAIL"].includes(result) && severities.length > 0));
