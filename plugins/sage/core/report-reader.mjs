import { REPORT_FIELDS } from "./report.mjs";
import { agentCommandProblem, TEMP } from "./agent-rules.mjs";
import { commandWrites, inlineCode } from "./shell-write-policy.mjs";
import { programsRun } from "./command-reader.mjs";
import { programName } from "./command-policy.mjs";

const SP = String.raw`[^\S\r\n  ]`;
const LINE_END = /(\r\n|[\n\r\v\f\u0085\u2028\u2029])/;
export function fieldsOf(text, names) {
  const out = [];
  for (const { line, fenced } of linesOf(text)) {
    const name = fenced || /^\s/.test(line) || LIST_ITEM.test(line) ? undefined : names.find((n) => new RegExp(`^(?:[*_#|>-]|${SP})*${n}\\b`).test(line));
    if (name) out.push({ name, line: line.slice(0, 80), rest: trimEnd(line.slice(line.indexOf(name) + name.length).replace(/^[\s*_|:]+/, "")), lines: [] });
    else out.at(-1)?.lines.push(line);
  }
  return out;
}
export function missingFields(names, text) {
  const given = new Set(fieldsOf(text, names).map((field) => field.name));
  return names.filter((name) => !given.has(name));
}
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
const LINE_MAX = 4096;
const LIST_ITEM = /^[-*+][ \t]|^\d+[.)][ \t]/;
function trimEnd(text) {
  let end = text.length;
  while (end > 0 && /[\s*_|]/.test(text[end - 1])) end--;
  return text.slice(0, end);
}
export const FINDING_FORM = "- <key> <severity> <summary>";
const RESULT_WORDS = ["CLEAN", "PASS", "FINDINGS", "FAIL"];
const SEVERE = /^(?:high|medium|low)(?![a-z])/i;
const LABEL = /\b(?:high|medium|low)[*_)\]]*:/i;
function unmarked(word = "") {
  let start = 0, end = word.length;
  while (start < end && "([*_`".includes(word[start])) start++;
  while (end > start && ")]*_`:,.-".includes(word[end - 1])) end--;
  return word.slice(start, end);
}
function lineOf(text) {
  const item = /^(?:[-*+]|\d+[.)])[ \t]+/.exec(text);
  const [key, ...rest] = (item ? text.slice(item[0].length) : text).split(/[ \t]+/);
  const at = rest.findIndex((w) => !/^[-–—:|]+$/.test(w)), word = unmarked(rest[at]);
  const summary = rest.slice(at + 1).join(" ");
  if (item && /\d/.test(unmarked(key)) && !SEVERE.test(unmarked(key)) && /^(?:high|medium|low)$/i.test(word) && !LABEL.test(summary)) return { severity: word.toLowerCase(), key: unmarked(key), summary: summary.replace(/^[-–—:|]+[ \t]*/, "") };
  return { severe: SEVERE.test(unmarked(key)) || SEVERE.test(word) || LABEL.test(text) };
}
const LEVELS = ["none", "low", "medium", "high"];
const LEVEL = { low: 1, medium: 2, high: 3, critical: 3, severe: 3, blocker: 3 };
const QUOTED = /(?<![\p{L}\p{N}])(?:`[^`]*`|"[^"]*"|“[^”]*”)(?![\p{L}\p{N}])/gu;
const STATED = /(?<!(?<![\p{L}\p{N}])(?:not|no)\s+(?:an?\s+)?)(?<![\p{L}\p{N}])(?:low|medium|high|critical|severe|blocker)(?![\p{L}\p{N}])/gu;
function stated(line) {
  const text = line.normalize("NFKC").replace(/\p{Cf}/gu, "").toLowerCase()
    .replace(QUOTED, (span) => (Object.hasOwn(LEVEL, unmarked(span.slice(1, -1).trim())) ? span : " "));
  let top;
  for (const [word] of text.matchAll(STATED)) if (top === undefined || LEVEL[word] > LEVEL[top]) top = word;
  return top;
}
const NONE_LINE = /^(?:[-*+][ \t]+)?none\.?$/i;
const FINDINGS_AT = new RegExp(`^(?:[*_#|>]|${SP})*FINDINGS\\b`);
const findingsLine = (line) => FINDINGS_AT.test(line.trimStart().replace(/^(?:[-*+]|\d+[.)])[ \t]+/, ""));
export function readReport(text, { requireComplete = false } = {}) {
  const fields = fieldsOf(text, REPORT_FIELDS), of = (name) => fields.filter((f) => f.name === name);
  const incomplete = requireComplete && REPORT_FIELDS.find(name => !of(name).some(f => [f.rest, ...f.lines].some(line => line.trim())));
  const [r] = of("RESULT"), [f] = of("FINDINGS");
  const another = linesOf(text).filter(({ line, fenced }) => !fenced && findingsLine(line))[1]?.line;
  const twice = REPORT_FIELDS.find((name) => of(name).length > 1) ?? (another === undefined ? undefined : "FINDINGS");
  const said = r && [r.rest, ...r.lines].map((line) => line.trimStart().slice(0, LINE_MAX).trim()).find(Boolean);
  const result = (/^[^A-Za-z]*([A-Za-z]+)/.exec(said ?? "")?.[1] ?? "").toUpperCase();
  const severities = [], findings = [], owned = [];
  let none = false, long = false, odd;
  for (const line of f ? [f.rest, ...f.lines] : []) {
    if (line.length > LINE_MAX) { long = true; continue; }
    const text = line.trim(), indented = /^\s/.test(line), { severity, severe, key, summary } = lineOf(text);
    if (!text) continue;
    if (!severity && findings.length && !NONE_LINE.test(text)) findings.at(-1).details.push(text);
    if (severity) severities.push(severity), findings.push({ key, severity, summary, details: [] });
    else if (NONE_LINE.test(text)) none = true;
    else if (!(indented && severities.length && !severe)) odd ??= text;
    else proofLine(findings.at(-1), text);
    if (severities.length) owned.push([text, LEVEL[severities.at(-1)]]);
  }
  const seen = owned.map(([text, own]) => [text, own, stated(text)]).find(([, own, word]) => LEVEL[word] > own);
  const problem = twice ? `${twice} is given twice, the second time in the line ${JSON.stringify((of(twice)[1]?.line ?? another).trim().slice(0, 80))}` : incomplete ? `${incomplete} is missing or empty` : !r ? "it has no RESULT" : !f ? "it has no FINDINGS" :
    !RESULT_WORDS.includes(result) ? `RESULT starts with ${JSON.stringify((said ?? "").slice(0, 80))}, not with one of ${RESULT_WORDS.join(", ")}` :
    long ? `a line under FINDINGS is longer than ${LINE_MAX} characters` : odd !== undefined ? `a line under FINDINGS is not none alone and not a finding in the form ${FINDING_FORM}: ${JSON.stringify(odd.slice(0, 80))}` :
    none && severities.length ? "FINDINGS has none and findings" : !none && !severities.length ? "FINDINGS is empty" :
    none && ["FINDINGS", "FAIL"].includes(result) ? `RESULT is ${result}, but FINDINGS is none` :
    seen ? `the line ${JSON.stringify(seen[0].slice(0, 80))} under FINDINGS has the severity word ${JSON.stringify(seen[2])} above the severity of its finding (${LEVELS[seen[1]]}): write that finding as its own line ${FINDING_FORM}, or put quoted output in backticks` : undefined;
  return { result, severities, findings, unreadable: Boolean(problem), ...(problem && { problem }) };
}

function proofLine(finding, text) {
  const [, name, value] = /^(?:[-*+][ \t]+)?(proof|saw|steps):[ \t]*(\S.*)$/i.exec(text) ?? [];
  if (name && !Object.hasOwn(finding, name.toLowerCase())) finding[name.toLowerCase()] = value.trim().replace(/^`([^`]+)`$/, "$1").trim();
}
const PROOF_GIT = ["status", "log", "show", "diff", "rev-parse", "ls-files", "grep", "cat-file", "blame"];
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
const PROOF_RULE = "Under each medium or high finding, give its proof on indented lines: proof: <one command, run from the repository root of the head> and saw: <the one output line that shows the problem>, or proof: screenshot <path> and steps: <the url and the actions>. The command only reads, or writes only into your scratch folder in the temp folder; it runs no process program, no inline code and git only to read (status, log, show, diff, rev-parse, ls-files, grep, cat-file or blame). It runs from a fresh copy of the head after the project's dependency install (such as npm ci --ignore-scripts). Put long output in a scratch file, and name its path. A low finding needs no proof. A proof, saw or steps line has no severity word above its finding's outside backticks: put output such as a test name in backticks. This stop gate stops you once.";
const READ_RULE = `Give each field once, at the start of a line that is not in a list or a code block. Start RESULT with ${RESULT_WORDS.join(", ")}. Under FINDINGS write none alone, or one line for each finding in the form ${FINDING_FORM}, where the key has a digit (K1) and the severity is high, medium or low, with any detail on indented lines under it that do not start with a severity word. No line under FINDINGS has a severity word above the severity of the finding that it is under, also in a sentence: write that problem as its own finding line. Only a span in backticks or double quotes and a word after not or no are text. RESULT FINDINGS or FAIL needs a finding.`;
export function stopReason(text, cwd, { who, proof = true }) {
  const { problem } = readReport(text), unproved = proof ? proofProblem(text, cwd) : undefined;
  return [problem && `sage: ${who} cannot read your report: ${problem}. ${READ_RULE}`, unproved && `sage: ${unproved}. ${PROOF_RULE}`].filter(Boolean).join(" ") || undefined;
}
const PROOF_LINE = /^[ \t]*(?:(?:[-*+|]|\d+[.)])[ \t]+)?[`*_[(]*([^\s`*_[\]():|]+)[`*_\])]*:?[ \t]+(?:[-–—:|][ \t]+)?[`*_]*(not[ \t]+reproduced|reproduced|could[ \t]+not[ \t]+run)(?![\p{L}\p{N}])/iu;
export function proofResults(text) {
  const results = new Map();
  for (const line of fieldsOf(text, REPORT_FIELDS).filter((f) => f.name === "EVIDENCE").flatMap((f) => [f.rest, ...f.lines])) {
    const [, key, outcome] = PROOF_LINE.exec(line.slice(0, LINE_MAX)) ?? [];
    if (/\d/.test(key) && !results.has(key)) results.set(key, outcome.toLowerCase().replace(/[ \t]+/g, " "));
  }
  return results;
}
export const cleanReport = ({ result, severities, unreadable } = {}) => !unreadable && Array.isArray(severities) && severities.every((v) => v === "low") &&
  (["CLEAN", "PASS"].includes(result) || (["FINDINGS", "FAIL"].includes(result) && severities.length > 0));
