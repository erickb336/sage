import { BRANCH } from "./branch.mjs";
import { REPORT_FIELDS } from "./report.mjs";

export const REVIEW_ROLES = Object.freeze(["code-reviewer", "security-reviewer", "ux-reviewer", "qa"]);

/** Immutable review scope, separate from the report's claims and any accepted verdict. */
export function parseReviewTarget(value) {
  const keys = ["branch", "sha", "round", "cycle"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key)) || typeof value.branch !== "string" || !BRANCH.test(value.branch)
    || typeof value.sha !== "string" || !/^[0-9a-f]{40}$/.test(value.sha)
    || !Number.isSafeInteger(value.round) || value.round < 0
    || !Number.isInteger(value.cycle) || value.cycle < 1 || value.cycle > 10) throw Error("Invalid review target");
  return { branch: value.branch, sha: value.sha, round: value.round, cycle: value.cycle };
}

const CLEAN_KINDS = { "code-reviewer": "review-clean", "security-reviewer": "security-clean", "ux-reviewer": "ux-clean", qa: "qa-pass" };
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const detail = value => typeof value === "string" && value.trim() && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);

/** Decode review claims only. The chief must still accept them against the current recorded assignment. */
export function parseReviewReport(report, role, target) {
  const fail = () => { throw Error("The review report does not match its target or findings"); };
  parseReviewTarget(target);
  if (!exactKeys(report, REPORT_FIELDS) || REPORT_FIELDS.some(key => typeof report[key] !== "string" || !report[key].trim())
    || REPORT_FIELDS.reduce((size, key) => size + Buffer.byteLength(report[key], "utf8"), 0) > 32 * 1024) fail();
  if (!REVIEW_ROLES.includes(role) || report.STATUS !== "done" || report.BRANCH !== target.branch
    || report.QUESTIONS.toLowerCase() !== "none") fail();
  let evidence, findings;
  try { evidence = JSON.parse(report.EVIDENCE); findings = JSON.parse(report.FINDINGS); } catch { fail(); }
  if (!exactKeys(evidence, ["commit", "round", "cycle", "summary"]) || evidence.commit !== target.sha
    || evidence.round !== target.round || evidence.cycle !== target.cycle || !detail(evidence.summary)
    || !Array.isArray(findings) || findings.some(f => !exactKeys(f, ["severity", "summary"])
      || !["low", "medium", "high"].includes(f.severity) || !detail(f.summary))) fail();
  const clean = role === "qa" ? "PASS" : "CLEAN";
  const bad = role === "qa" ? "FAIL" : "FINDINGS";
  const blocking = findings.some(f => f.severity !== "low");
  if ((report.RESULT !== clean && report.RESULT !== bad) || (report.RESULT === bad) !== blocking) fail();
  return { kind: report.RESULT === clean ? CLEAN_KINDS[role] : role === "qa" ? "qa-fail" : "findings", evidence, findings };
}
