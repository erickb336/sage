import { join } from "node:path";
import { readAdmission, parseReport } from "../core/index.mjs";
import { nativeToolContext } from "./native-tool.mjs";
import { readObservations } from "./events.mjs";
import { readNativeReport } from "./identity.mjs";

const refuse = () => { throw Error("Sage could not verify this child's report"); };

/** The parent reads its own named child's completed report. This does not accept a verdict or change task state. */
export function readChildReport(input, context, options) {
  const native = nativeToolContext(context);
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1
    || !Object.hasOwn(input, "name") || typeof input.name !== "string" || !/^(?!root$)[a-z0-9_]{1,256}$/.test(input.name)) refuse();
  const state = readAdmission(options.directory);
  const candidates = state.reservations.filter(row => row.assignment.project === options.project
    && row.assignment.issuer === native.actor && row.dispatch.name === input.name
    && state.sessions.some(owner => owner.project === options.project && owner.session === row.assignment.session
      && owner.epoch === row.assignment.epoch));
  if (candidates.length !== 1) refuse();
  const assigned = candidates[0];
  const bound = state.bindings.find(row => row.assignment === assigned.assignment.id);
  const complete = state.completions?.find(row => row.assignment === assigned.assignment.id);
  if (!bound || !complete || JSON.stringify(bound) !== JSON.stringify(complete) || !assigned.dispatch.taskHash
    || !bound.session.startsWith("codex:")) refuse();
  const session = bound.session.slice(6);
  const observations = readObservations(join(options.observationsRoot, session));
  const starts = observations.filter(row => row.kind === "child-start" && row.child === bound.child);
  const transcripts = observations.filter(row => row.kind === "child-transcript" && row.child === bound.child);
  if (starts.length !== 1 || transcripts.length !== 1 || starts[0].turn !== bound.turn
    || starts[0].parent !== native.actor || transcripts[0].turn !== bound.turn) refuse();
  const path = starts[0].path;
  const evidence = readNativeReport(transcripts[0].transcript, { sessionsDir: options.sessionsDir }, {
    session, child: bound.child, parent: bound.issuer, path, author: path.slice(0, path.lastIndexOf("/")),
    turn: bound.turn, taskHash: assigned.dispatch.taskHash,
  });
  return { decision: "report-ready", assignment: assigned.assignment.id, task: assigned.assignment.task,
    run: assigned.assignment.run, child: bound.child, turn: bound.turn, reportMessage: evidence.reportMessage,
    reportHash: evidence.reportHash, report: parseReport(evidence.text) };
}
