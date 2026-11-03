/** The one line for a saved change that cannot finish, in Claude and in Codex. */
export const STUCK_WRITE = 'This command changed nothing. This project cannot save changes; other projects work. Tell the owner. There are two ways out. With a backup: the owner restores the folder that `sage logbook` prints; rows newer than the backup are lost. With no backup: after the owner accepts the loss of this saved change, the chief runs `sage logbook repair --accept-change-loss yes --project <the project>`, or the owner runs it in a terminal when the chief cannot; it keeps the file, and a half-published update keeps mixed tables. Do not remove review-pending.json by hand.';
// Public update guidance comes only from these codes, never an exception's private text. A guard's refusal is the one
// other source: its words are for a person, and every path gives the same ones.
const messages = {
  'stale-version': 'The task changed. Read it again with sage_read_task, review the current state, and submit a new request UUID.',
  'invalid-request': 'The update request is invalid. Check its task ID, version and supported changes before submitting a corrected request.',
  'invalid-change': 'This change is not allowed from the current task state. Read the task and choose a supported transition or value.',
  'owner-required': 'Only the current chief can update this task. Use its authenticated connection; do not substitute another owner.',
  'uncertain-outcome': 'The update outcome is uncertain. Retry the original request UUID and identical contents. Do not submit a replacement request.',
  'invalid-state': 'Saved state or update proof is invalid. Preserve it and inspect or repair the state before retrying the original request. Do not overwrite it.',
  'stuck-write': STUCK_WRITE,
  'readiness': 'The current commit needs the required clean checks and review cycles. Complete them before reading the task and submitting a new request.',
  'readiness-config': 'The review-cycle configuration is invalid. Correct it before reading the task and submitting a new request.',
  'readiness-branch': 'Readiness needs an existing task branch and its current commit. Check the branch before submitting a new request.',
  'readiness-checkout': "Readiness needs the checkout of the task branch's run, and that folder is gone. Start the run again from a live checkout before submitting a new request.",
  'readiness-pr':'PR-ready needs a valid pull request number. Read the task and include its PR in a new request.',
  'readiness-gates': 'Answer the pending gates before submitting a new readiness request.',
  'readiness-runs': 'Finish the running reviewers before submitting a new readiness request.',
  'readiness-findings': 'Resolve the blocking findings before submitting a new readiness request.',
  'arena-open': "This task's arena has no final version here: its arena step is open, or its branch is a candidate's, and a candidate's branch never merges. Finish an arena-judge run on its own branch and name a branch that can land on the task, then read the task and submit a new request. A task that needs no arena: abandon it, then frame it again on a new branch.",
};
export class TaskUpdateError extends Error {
  constructor(code, ids = [], guardWords) {
    if (guardWords === undefined && !Object.hasOwn(messages, code)) code = 'invalid-state';
    // Keep guidance to twelve short IDs; full finding text stays in the logbook.
    const safe = [...new Set(ids.filter(id => typeof id === 'string' && id.length <= 64 && /^(?:[TGR][1-9]\d*|F-T[1-9]\d*-(?:R[1-9]\d*-)?[1-9]\d*)$/.test(id)))].slice(0, 12);
    super(`${guardWords ?? messages[code]}${safe.length ? ` IDs: ${safe.join(', ')}.` : ''}`);
    this.code = code;
  }
}
export function taskUpdateErrorMessage(error) {
  return `Sage could not update this task. ${error instanceof TaskUpdateError ? `[${error.code}] ${error.message}`
    : `[uncertain-outcome] ${messages['uncertain-outcome']}`}`;
}
