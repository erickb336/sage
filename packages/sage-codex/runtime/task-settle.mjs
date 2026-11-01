import { acknowledgeTaskUpdate, endInterruptedRunFinish, readAdmission, releaseTaskUpdate, voidInterruptedRunFinish, voidTaskUpdate } from "sage-core";
import { logbookEnv, logbookTool } from "./logbook-env.mjs";
import { validateLogbookLocation } from "./run-report.mjs";

/**
 * The journal side of step 3. Any provider's writer may settle a saved change, so the journal catches up here, before
 * decide, prepare, assign and a child's terminal check. A receipt closes a row. No receipt and no saved change voids it.
 */
export function settleNativeWrites(options) {
  validateLogbookLocation(options);
  const tool = logbookTool(() => { throw Error("No ambient logbook"); });
  tool.settleWrites({ project: options.projectDirectory }, logbookEnv(options), receipts => {
    const state = readAdmission(options.directory);
    for (const { update, accepted, released, void: voided } of state.taskUpdates ?? []) {
      if (update.project !== options.project || voided || released) continue;
      const owner = JSON.stringify([update.project, update.session, update.epoch]);
      const receipt = receipts.update({ owner, request: update.request, digest: update.digest });
      if (!receipt) { voidTaskUpdate(options.directory, update); continue; }
      if (receipt.accepted !== accepted) throw Error("Task update receipt differs from its decision");
      if (!accepted) continue; // A rejected receipt of an earlier version stays as history.
      acknowledgeTaskUpdate(options.directory, update, receipt.receiptHash);
      releaseTaskUpdate(options.directory, update, receipt.receiptHash);
    }
    for (const { request, receiptHash, void: voided } of state.interruptedFinishes ?? []) {
      if (request.binding.project !== options.project || voided || receiptHash) continue;
      const receipt = receipts.finish(request);
      if (receipt) endInterruptedRunFinish(options.directory, request, receipt.receiptHash);
      else voidInterruptedRunFinish(options.directory, request);
    }
  });
}
