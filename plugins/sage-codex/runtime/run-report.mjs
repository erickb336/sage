import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readAdmission, sharedRoot } from "../core/index.mjs";
import { logbookEnv, logbookTool } from "./logbook-env.mjs";
import { nativeToolContext } from "./native-tool.mjs";
import { finishNativeInterruptedRun } from "./interrupted-run.mjs";
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
  validateSharedRoot(options, [...paths, sessions]);
}

/** A path as the system sees it, also when its last parts do not exist yet. A dangling link has no answer. */
function realTarget(path) {
  try { return realpathSync(path); } catch (error) {
    if (error.code !== "ENOENT" || lstatSync(path, { throwIfNoEntry: false })) refuse();
    return join(realTarget(dirname(path)), basename(path));
  }
}

/**
 * The launcher's root, or SAGE_SHARED_HOME: an absolute path outside every other location, also through a link. A root
 * in the project would give agents with workspace write the tables. The hooks read the environment, not this file, so a
 * fixed root must be the root that the environment gives, or they would not protect it.
 */
function validateSharedRoot(options, paths) {
  const shared = options.sharedRoot ?? (process.env.SAGE_SHARED_HOME || undefined);
  if (shared === undefined) return;
  if (typeof shared !== "string" || shared.length > 4096 || /\p{Cc}/u.test(shared) || !isAbsolute(shared) || resolve(shared) !== shared
    || shared !== sharedRoot(process.env)) refuse();
  const real = realTarget(shared);
  if (paths.some(path => contains(real, path) || contains(path, real))) refuse();
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
  const tool = logbookTool(() => { refuse(); });
  return { tool, state, assigned, native: native.actor, work: { project: options.projectDirectory, task: saved.task, run: saved.run,
    role: assigned.rolePlan.role, assignment: input.assignment, reportHash: saved.reportHash, text: saved.text },
    env: logbookEnv(options) };
}


export function finishRecordedRun(input, context, options) {
  if (Object.hasOwn(input ?? {}, "outcome")) return finishNativeInterruptedRun(input, context, options);
  const { tool, work, env } = recordedRun(input, context, options);
  return tool.finishReportedRun(work, env);
}

/** Accept only the review target saved before this completed child was dispatched. */
export function acceptRecordedReview(input, context, options) {
  const { tool, state, assigned, native, work, env } = recordedRun(input, context, options);
  const review = state.preparations.find(row => row.id === assigned.preparation)?.review;
  if (!review) refuse();
  return tool.acceptReportedReview({ ...work, review }, env, native);
}
