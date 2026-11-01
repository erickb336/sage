import { taskUpdateHistory } from "./task-update-history.mjs";
import { decideTaskUpdate, acknowledgeTaskUpdate, releaseTaskUpdate, voidTaskUpdate, TaskUpdateError, AdmissionError } from "../core/index.mjs";
import { chiefLogbook } from "./logbook-owner.mjs";
import { settleNativeWrites } from "./task-settle.mjs";

/** Fixed authenticated ownership supplies coordination; model arguments contain only the requested change. */
export function updateNativeTask(input, context, options) {
  const fields = ["request", "task", "version", "changes"];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== fields.length
    || fields.some(key => !Object.hasOwn(input, key))) throw new TaskUpdateError("invalid-request");
  let fixed;
  try { fixed = chiefLogbook(context, options); }
  catch (error) {
    if (error instanceof AdmissionError) throw new TaskUpdateError("invalid-state");
    if (error.code) throw error;
    throw new TaskUpdateError("owner-required");
  }
  const { tool, project, owner, env } = fixed;
  const [journalProject, session, epoch] = JSON.parse(owner);
  const update = (digest, disruptive) => ({ project: journalProject, session, epoch, request: input.request,
    task: input.task, digest, disruptive });
  let current;
  settleBeforeDecide(options);
  return tool.updateRequestedTask({ ...input, project, owner }, env, {
    history(digest, proposal, reference) {
      if (reference.owner !== owner || reference.request !== input.request || reference.task !== input.task)
        throw new TaskUpdateError("invalid-state");
      return taskUpdateHistory(options)(digest, proposal, reference);
    },
    decide(digest, proposal) {
      current = update(digest, proposal.disruptive);
      const result = decideTaskUpdate(options.directory, current);
      return { digest: result.update.digest, accepted: result.accepted, reason: result.reason };
    },
    acknowledge(digest, receiptHash) {
      const result = acknowledgeTaskUpdate(options.directory, current, receiptHash);
      return { digest: result.update.digest, receiptHash: result.receiptHash };
    },
    release(digest, receiptHash) {
      const result = releaseTaskUpdate(options.directory, current, receiptHash);
      if (!result.released) throw Error("Task update fence is unresolved");
      return { digest: result.update.digest, receiptHash: result.receiptHash };
    },
    void() { voidTaskUpdate(options.directory, current); },
  });
}

/** A damaged journal or saved change reads as saved state, never as an unknown outcome. */
function settleBeforeDecide(options) {
  try { settleNativeWrites(options); }
  catch (error) {
    if (error instanceof TaskUpdateError || error.code) throw error;
    throw new TaskUpdateError("invalid-state");
  }
}
