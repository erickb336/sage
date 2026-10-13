import { createHash } from "node:crypto";
import { join } from "node:path";
import { readAdmission, parseReport } from "sage-core";
import { observation, publish, readObservations, RUNTIME_VERSION } from "./events.mjs";
import { readNativeReport } from "./identity.mjs";

const refuse = () => { throw Error("Sage could not verify saved report recovery."); };
const hash = value => createHash("sha256").update(value).digest("hex");

function reportContext(report, options) {
  const state = readAdmission(options.directory), bound = report.binding;
  const assigned = state.reservations.find(row => row.assignment.id === bound.assignment);
  const complete = state.completions?.find(row => row.assignment === bound.assignment);
  if (!assigned?.dispatch.taskHash || bound.project !== options.project
    || !bound.session.startsWith("codex:") || JSON.stringify(complete) !== JSON.stringify(bound)
    || report.task !== assigned.assignment.task || report.run !== assigned.assignment.run
    || hash(report.text) !== report.reportHash
    || !state.sessions.some(row => row.project === bound.project && row.session === bound.session && row.epoch === bound.epoch)) refuse();
  parseReport(report.text);
  const session = bound.session.slice(6), directory = join(options.observationsRoot, session);
  const proof = observation({ schema: 1, runtime: RUNTIME_VERSION, kind: "report-recovery-verified",
    session, assignment: bound.assignment, child: bound.child, turn: bound.turn,
    receiptHash: hash(JSON.stringify([bound.project, bound.session, bound.epoch, bound.assignment,
      bound.issuer, bound.child, bound.turn, report.task, report.run, assigned.dispatch.taskHash,
      report.reportMessage, report.reportHash])) });
  return { state, bound, assigned, session, directory, proof, observations: readObservations(directory) };
}

function savedProof(context) {
  const proofs = context.observations.filter(row => row.kind === "report-recovery-verified"
    && row.assignment === context.bound.assignment);
  if (!proofs.length) return false;
  if (proofs.length !== 1 || JSON.stringify(proofs[0]) !== JSON.stringify(context.proof)) refuse();
  return true;
}

/** A saved proof covers this exact receipt after its native transcript is gone. */
export function hasReportRecovery(report, options) {
  return savedProof(reportContext(report, options));
}

/** Publish recovery evidence before the receipt; a partial write grants no run authority. */
export function recordReportRecovery(report, options) {
  const context = reportContext(report, options);
  if (savedProof(context)) return;
  const { state, bound, assigned, session, observations } = context;
  const starts = observations.filter(row => row.kind === "child-start" && row.child === bound.child);
  const transcripts = observations.filter(row => row.kind === "child-transcript" && row.child === bound.child && row.turn === bound.turn);
  if (starts.length !== 1 || transcripts.length !== 1 || starts[0].parent !== bound.issuer
    || (starts[0].turn !== bound.turn)) refuse();
  const path = starts[0].path;
  const evidence = readNativeReport(transcripts[0].transcript, { sessionsDir: options.sessionsDir, requireRecovery: true }, {
    session, child: bound.child, parent: bound.issuer, path, author: path.slice(0, path.lastIndexOf("/")),
    turn: bound.turn, taskHash: assigned.dispatch.taskHash,
  });
  if (evidence.reportMessage !== report.reportMessage || evidence.reportHash !== report.reportHash || evidence.text !== report.text
    || JSON.stringify(readAdmission(options.directory)) !== JSON.stringify(state)) refuse();
  publish(context.directory, context.proof);
}
