import { readAdmission } from "sage-core";
import { nativeToolContext } from "./native-tool.mjs";
import { hasReportRecovery } from "./report-recovery.mjs";

const refuse = () => { throw Error("Sage could not read this saved report."); };

/** The current root chief can inspect a durable team receipt without taking parent or verdict authority. */
export function readRecordedReport(input, context, options) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 2
    || !Object.hasOwn(input, "assignment") || !Object.hasOwn(input, "reportHash")
    || typeof input.assignment !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(input.assignment)
    || typeof input.reportHash !== "string" || !/^[0-9a-f]{64}$/.test(input.reportHash)) refuse();
  const native = nativeToolContext(context);
  const state = readAdmission(options.directory);
  const reports = (state.reports ?? []).filter(row => row.binding.assignment === input.assignment);
  if (reports.length !== 1) refuse();
  const saved = reports[0], session = `codex:${native.actor}`;
  if (saved.reportHash !== input.reportHash || saved.binding.project !== options.project || saved.binding.session !== session
    || !state.sessions.some(row => row.project === options.project && row.session === session && row.epoch === saved.binding.epoch)) refuse();
  const assigned = state.reservations.find(row => row.assignment.id === input.assignment);
  if (!assigned?.rolePlan?.role || !hasReportRecovery(saved, options)) refuse();
  const review = state.preparations.find(row => row.id === assigned.preparation)?.review;
  if (JSON.stringify(readAdmission(options.directory)) !== JSON.stringify(state)) refuse();
  return { decision: "recorded-report", assignment: input.assignment, task: saved.task, run: saved.run,
    role: assigned.rolePlan.role, issuer: saved.binding.issuer, child: saved.binding.child, turn: saved.binding.turn,
    reportHash: saved.reportHash, text: saved.text, ...(review ? { review } : {}) };
}
