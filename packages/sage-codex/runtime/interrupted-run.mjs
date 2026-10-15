import { createStateTool, readAdmission, beginInterruptedRunFinish, endInterruptedRunFinish } from "sage-core";
import { nativeToolContext } from "./native-tool.mjs";
import { validateLogbookLocation } from "./run-report.mjs";

const refuse = () => { throw Error("Sage could not finish this interrupted run"); };
/** A current root chief selects a known run, never supplies terminal evidence or a child identity. */
export function finishNativeInterruptedRun(input, context, options) {
  const keys = ["outcome", "run", "status"];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== keys.length
    || keys.some(key => !Object.hasOwn(input, key)) || input.outcome !== "interrupted"
    || typeof input.run !== "string" || !/^R[1-9]\d*$/.test(input.run)
    || !["blocked", "question", "failed"].includes(input.status)) refuse();
  const native = nativeToolContext(context);
  validateLogbookLocation(options);
  const state = readAdmission(options.directory), session = `codex:${native.actor}`;
  const owner = state.sessions.find(row => row.project === options.project && row.session === session);
  if (!owner) refuse();
  const matches = state.reservations.filter(row => row.assignment.project === owner.project
    && row.assignment.session === owner.session && row.assignment.epoch === owner.epoch && row.assignment.run === input.run
    && !(state.failures ?? []).some(failure => failure.assignment === row.assignment.id));
  if (matches.length !== 1) refuse();
  const assigned = matches[0], binding = state.bindings.find(row => row.assignment === assigned.assignment.id);
  const preparation = state.preparations.find(row => row.id === assigned.preparation);
  const terminal = (state.completions ?? []).find(row => row.assignment === assigned.assignment.id);
  if (!binding || !preparation || !assigned.rolePlan?.role || terminal?.outcome !== "interrupted"
    || ["project", "session", "epoch", "task", "run", "issuer"].some(key => preparation[key] !== assigned.assignment[key])
    || preparation.rolePlan.role !== assigned.rolePlan.role || !preparation.runTarget
    || preparation.runTarget.task !== assigned.assignment.task || preparation.runTarget.run !== input.run
    || preparation.runTarget.role !== assigned.rolePlan.role
    || JSON.stringify(terminal) !== JSON.stringify({ ...binding, outcome: "interrupted", evidenceHash: terminal.evidenceHash })) refuse();
  const request = { binding, task: assigned.assignment.task, run: input.run, role: assigned.rolePlan.role,
    status: input.status, evidenceHash: terminal.evidenceHash, runTarget: preparation.runTarget };
  const tool = createStateTool({ defaultRoot: () => refuse() });
  return tool.finishInterruptedRun({ project: options.projectDirectory, ...request },
    { ...process.env, SAGE_HOME: options.logbookRoot }, {
      begin: value => beginInterruptedRunFinish(options.directory, value),
      end: (value, receiptHash) => endInterruptedRunFinish(options.directory, value, receiptHash),
    });
}
