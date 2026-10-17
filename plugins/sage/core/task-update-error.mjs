// Public update guidance comes only from these codes, never an exception's private text.
const messages = {
  'stale-version': 'The task changed. Read it again with sage_read_task, review the current state, and submit a new request UUID.',
  'invalid-request': 'The update request is invalid. Check its task ID, version and supported changes before submitting a corrected request.',
  'invalid-change': 'This change is not allowed from the current task state. Read the task and choose a supported transition or value.',
  'owner-required': 'Only the current chief can update this task. Use its authenticated connection; do not substitute another owner.',
  'old-owner': 'An unresolved update belongs to another owner. Preserve it and recover through the original owner connection. Automatic takeover is unavailable.',
  'pending-request': 'An update is unresolved. Retry its original request UUID and identical contents before submitting another change.',
  'uncertain-outcome': 'The update outcome is uncertain. Retry the original request UUID and identical contents. Do not submit a replacement request.',
  'invalid-state': 'Saved state or update proof is invalid. Preserve it and inspect or repair the state before retrying the original request. Do not overwrite it.',
  'readiness': 'The current commit needs the required clean checks and review cycles. Complete them before reading the task and submitting a new request.',
  'readiness-config': 'The review-cycle configuration is invalid. Correct it before reading the task and submitting a new request.',
  'readiness-branch': 'Readiness needs an existing task branch and its current commit. Check the branch before submitting a new request.',
  'readiness-pr': 'PR-ready needs a valid pull request number. Read the task and include its PR in a new request.',
  'readiness-gates': 'Answer the pending gates before submitting a new readiness request.',
  'readiness-runs': 'Finish the running reviewers before submitting a new readiness request.',
  'readiness-findings': 'Resolve the blocking findings before submitting a new readiness request.',
};
export class TaskUpdateError extends Error {
  constructor(code, ids = []) {
    if (!Object.hasOwn(messages, code)) code = 'invalid-state';
    // Keep guidance to twelve short IDs; full finding text stays in the logbook.
    const safe = [...new Set(ids.filter(id => typeof id === 'string' && id.length <= 64 && /^(?:[TGR][1-9]\d*|F-T[1-9]\d*-(?:R[1-9]\d*-)?[1-9]\d*)$/.test(id)))].slice(0, 12);
    super(`${messages[code]}${safe.length ? ` IDs: ${safe.join(', ')}.` : ''}`);
    this.code = code;
  }
}
export function taskUpdateErrorMessage(error) {
  return `Sage could not update this task. ${error instanceof TaskUpdateError ? `[${error.code}] ${error.message}`
    : `[uncertain-outcome] ${messages['uncertain-outcome']}`}`;
}
