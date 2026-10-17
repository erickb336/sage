import { AdmissionError, readAdmission, TaskUpdateError } from "../core/index.mjs";

/** Read an exact durable outcome. This callback never creates a decision or releases a fence. */
export const taskUpdateHistory = options => (digest, proposal, reference) => {
  const invalid = () => { throw new TaskUpdateError("invalid-state"); };
  let owner;
  try { owner = JSON.parse(reference.owner); } catch { invalid(); }
  if (!Array.isArray(owner) || owner.length !== 3 || owner.some(value => typeof value !== "string")
    || owner[0] !== options.project) invalid();
  const [project, session, epoch] = owner;
  const expected = { project, session, epoch, request: reference.request, task: reference.task,
    digest, disruptive: proposal.disruptive };
  let state;
  try { state = readAdmission(options.directory); }
  catch (error) { if (error instanceof AdmissionError) invalid(); throw error; }
  const rows = state.taskUpdates?.filter(row => Object.entries(expected).every(([key, value]) => row.update[key] === value)) ?? [];
  if (rows.length !== 1) invalid();
  const row = rows[0];
  return { digest: row.update.digest, accepted: row.accepted, reason: row.reason, receiptHash: row.receiptHash ?? null };
};
