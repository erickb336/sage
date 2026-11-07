import { acknowledgeTaskUpdate, endInterruptedRunFinish, readAdmission, releaseTaskUpdate, voidInterruptedRunFinish, voidTaskUpdate } from "sage-core";
import { logbookEnv, logbookTool } from "./logbook-env.mjs";
import { validateLogbookLocation } from "./run-report.mjs";

/**
 * The journal side of step 3. Any provider's writer may settle a saved change, so the journal catches up here, before
 * decide, prepare, assign and a child's terminal check. A receipt closes a row. No receipt and no saved change voids it.
 * After a move the project's logbook is the new shared one, and the receipts stay in the old logbook: the core's readers
 * also read the old logbooks (T680), so a change saved before the move closes as done. Only when an old logbook is gone,
 * or the core cannot read it (T687), does a row find no receipt: the journal never voids a row with a receipt's hash, so
 * its own acknowledgement releases it (T658). Neither step writes a logbook.
 */
export function settleNativeWrites(options) {
  validateLogbookLocation(options);
  const tool = logbookTool(() => { throw Error("No ambient logbook"); });
  tool.settleWrites({ project: options.projectDirectory }, logbookEnv(options), receipts => {
    const state = readAdmission(options.directory);
    for (const { update, accepted, released, receiptHash, void: voided } of state.taskUpdates ?? []) {
      if (update.project !== options.project || voided || released) continue;
      const owner = JSON.stringify([update.project, update.session, update.epoch]);
      const receipt = receipts.update({ owner, request: update.request, digest: update.digest });
      if (!receipt) {
        if (receiptHash) releaseTaskUpdate(options.directory, update, receiptHash);
        else voidTaskUpdate(options.directory, update);
        continue;
      }
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
