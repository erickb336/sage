import { decideTaskUpdate, acknowledgeTaskUpdate, releaseTaskUpdate, readAdmission } from "../core/index.mjs";
import { chiefLogbook } from "./logbook-owner.mjs";

/** Fixed authenticated ownership supplies coordination; model arguments contain only the requested change. */
export function updateNativeTask(input, context, options) {
  const fields = ["request", "task", "version", "changes"];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== fields.length
    || fields.some(key => !Object.hasOwn(input, key))) throw Error("Invalid task update");
  const { tool, project, owner, env } = chiefLogbook(context, options);
  const [journalProject, session, epoch] = JSON.parse(owner);
  const update = (digest, disruptive) => ({ project: journalProject, session, epoch, request: input.request,
    task: input.task, digest, disruptive });
  let current;
  const saved = digest => {
    if (current?.digest === digest) return current;
    // A historical retry uses its own saved decision, never the current task or a later fence.
    const row = readAdmission(options.directory).taskUpdates?.find(row => row.update.project === journalProject
      && row.update.session === session && row.update.epoch === epoch && row.update.request === input.request && row.update.digest === digest);
    if (!row) throw Error("Task update admission decision is missing");
    return row.update;
  };
  return tool.updateRequestedTask({ ...input, project, owner }, env, {
    decide(digest, proposal) {
      current = update(digest, proposal.disruptive);
      const result = decideTaskUpdate(options.directory, current);
      return { digest: result.update.digest, accepted: result.accepted, reason: result.reason };
    },
    acknowledge(digest, receiptHash) {
      const result = acknowledgeTaskUpdate(options.directory, saved(digest), receiptHash);
      return { digest: result.update.digest, receiptHash: result.receiptHash };
    },
    release(digest, receiptHash) {
      const result = releaseTaskUpdate(options.directory, saved(digest), receiptHash);
      if (!result.released) throw Error("Task update fence is unresolved");
      return { digest: result.update.digest, receiptHash: result.receiptHash };
    },
  });
}
