import { join } from "node:path";
import { readAdmission, recordReportAdmission, parseReport } from "../core/index.mjs";
import { nativeToolContext } from "./native-tool.mjs";
import { readObservations } from "./events.mjs";
import { readNativeReport } from "./identity.mjs";

const refuse = () => { throw Error("Sage could not verify this child's report"); };

const inputFields = (input, keys) => {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== keys.length
    || keys.some(key => !Object.hasOwn(input, key)) || typeof input.name !== "string"
    || !/^(?!root$)[a-z0-9_]{1,256}$/.test(input.name)) refuse();
};

function verifiedReport(name, context, options) {
  const native = nativeToolContext(context);
  const state = readAdmission(options.directory);
  const candidates = state.reservations.filter(row => row.assignment.project === options.project
    && row.assignment.issuer === native.actor && row.dispatch.name === name
    && state.sessions.some(owner => owner.project === options.project && owner.session === row.assignment.session
      && owner.epoch === row.assignment.epoch));
  if (candidates.length !== 1) refuse();
  const assigned = candidates[0];
  const bound = state.bindings.find(row => row.assignment === assigned.assignment.id);
  const complete = state.completions?.find(row => row.assignment === assigned.assignment.id);
  if (!bound || !complete || JSON.stringify(bound) !== JSON.stringify(complete) || !assigned.dispatch.taskHash
    || !bound.session.startsWith("codex:")) refuse();
  const recorded = state.reports?.find(row => row.binding.assignment === bound.assignment);
  // The journal rechecks its hash, fields, binding, task, and run while replaying the receipt.
  if (recorded) return recorded;
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
  return { binding: bound, task: assigned.assignment.task, run: assigned.assignment.run,
    reportMessage: evidence.reportMessage, reportHash: evidence.reportHash, text: evidence.text };
}
const receipt = (saved, decision) => ({ decision, assignment: saved.binding.assignment, task: saved.task,
  run: saved.run, child: saved.binding.child, turn: saved.binding.turn, reportMessage: saved.reportMessage,
  reportHash: saved.reportHash, report: parseReport(saved.text) });

/** The parent reads its own named child's completed report. This does not accept a verdict or change task state. */
export function readChildReport(input, context, options) {
  inputFields(input, ["name"]);
  return receipt(verifiedReport(input.name, context, options), "report-ready");
}

/** Pin the previously read content hash. Replays preserve the original evidence and do not accept its claims. */
export function recordChildReport(input, context, options) {
  inputFields(input, ["name", "reportHash"]);
  if (typeof input.reportHash !== "string" || !/^[0-9a-f]{64}$/.test(input.reportHash)) refuse();
  const report = verifiedReport(input.name, context, options);
  if (report.reportHash !== input.reportHash) refuse();
  const recorded = recordReportAdmission(options.directory, report);
  return receipt(recorded.report, recorded.decision);
}
