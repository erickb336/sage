/** Immutable task fields captured from the logbook before a provider dispatches work. */
export function parseRunTarget(input) {
  const keys = ["task", "run", "role", "round", "taskBranch", "runBranch", "candidate"];
  const deny = () => { throw Error("Invalid run target"); };
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== keys.length
    || keys.some(key => !Object.hasOwn(input, key)) || !Number.isSafeInteger(input.round) || input.round < 0) deny();
  for (const key of keys.filter(key => key !== "round")) {
    if (typeof input[key] !== "string" || input[key].length > 4096 || /\p{Cc}/u.test(input[key])) deny();
  }
  if (!/^T[1-9]\d*$/.test(input.task) || !/^R[1-9]\d*$/.test(input.run) || !/^[a-z][a-z-]{0,63}$/.test(input.role)) deny();
  return Object.fromEntries(keys.map(key => [key, input[key]]));
}
