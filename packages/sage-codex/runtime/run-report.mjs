import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createStateTool, readAdmission } from "sage-core";
import { nativeToolContext } from "./native-tool.mjs";
import { hasReportRecovery } from "./report-recovery.mjs";

const refuse = () => { throw Error("Sage could not finish this recorded run"); };
const contains = (parent, child) => {
  const part = relative(parent, child);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
};
/** The launcher supplies this location. A tool request cannot select a logbook or project directory. */
export function validateLogbookLocation(options) {
  const paths = [options.logbookRoot, options.projectDirectory, options.directory, options.observationsRoot];
  for (const path of paths) {
    if (typeof path !== "string" || path.length > 4096 || /\p{Cc}/u.test(path) || !isAbsolute(path)
      || resolve(path) !== path || realpathSync(path) !== path || !statSync(path).isDirectory()) refuse();
  }
  const sessions = options.sessionsDir;
  if (typeof sessions !== "string" || sessions.length > 4096 || /\p{Cc}/u.test(sessions)
    || !isAbsolute(sessions) || resolve(sessions) !== sessions) refuse();
  if ([...paths.slice(1), sessions].some(path => contains(paths[0], path) || contains(path, paths[0]))) refuse();
}

/** Only the current root chief can finish a run from a receipt already saved by its verified parent. */
function recordedRun(input, context, options) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 2
    || !Object.hasOwn(input, "assignment") || !Object.hasOwn(input, "reportHash")
    || typeof input.assignment !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(input.assignment)
    || typeof input.reportHash !== "string" || !/^[0-9a-f]{64}$/.test(input.reportHash)) refuse();
  const native = nativeToolContext(context);
  validateLogbookLocation(options);
  const state = readAdmission(options.directory);
  const reports = (state.reports ?? []).filter(row => row.binding.assignment === input.assignment);
  if (reports.length !== 1) refuse();
  const saved = reports[0];
  const session = `codex:${native.actor}`;
  if (saved.reportHash !== input.reportHash || saved.binding.project !== options.project || saved.binding.session !== session
    || !state.sessions.some(row => row.project === options.project && row.session === session && row.epoch === saved.binding.epoch)) refuse();
  const assigned = state.reservations.find(row => row.assignment.id === input.assignment);
  if (!assigned?.rolePlan?.role || !hasReportRecovery(saved, options)) refuse();
  const tool = createStateTool({ defaultRoot: () => { refuse(); } });
  return { tool, state, assigned, work: { project: options.projectDirectory, task: saved.task, run: saved.run,
    role: assigned.rolePlan.role, assignment: input.assignment, reportHash: saved.reportHash, text: saved.text },
    env: { ...process.env, SAGE_HOME: options.logbookRoot } };
}


export function finishRecordedRun(input, context, options) {
  const { tool, work, env } = recordedRun(input, context, options);
  return tool.finishReportedRun(work, env);
}

/** Only the chief accepts a completed review; the saved preparation supplies its immutable target. */
export function acceptRecordedReview(input, context, options) {
  const { tool, state, assigned, work, env } = recordedRun(input, context, options);
  const review = state.preparations.find(row => row.id === assigned.preparation)?.review;
  if (!review) refuse();
  return tool.acceptReportedReview({ ...work, review }, env);
}


/** The chief inspects a saved report, including a lead's child, without accepting any claim. */
export function readRecordedReport(input, context, options) {
  const { state, assigned, work } = recordedRun(input, context, options);
  const saved = state.reports.find(row => row.binding.assignment === input.assignment);
  const review = state.preparations.find(row => row.id === assigned.preparation)?.review;
  return { decision: "recorded-report", assignment: input.assignment, task: work.task, run: work.run,
    role: work.role, issuer: saved.binding.issuer, child: saved.binding.child, turn: saved.binding.turn,
    reportHash: work.reportHash, text: work.text, ...(review ? { review } : {}) };
}
