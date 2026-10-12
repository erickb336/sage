// A two-minute deadlock guard allows native startup on a busy machine. It is not a speed assertion.
export function waitNative(child, { deadlineMs = 120_000, onTimeout = () => {} } = {}) {
  return new Promise(resolve => {
    let settled = false;
    let timedOut = false;
    let timeoutCallbackFailed = false;
    let spawnFailed = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("close", closed);
      child.removeListener("error", failed);
      resolve(result);
    };
    const closed = (code, signal) => finish({ code: timedOut || spawnFailed ? null : code, signal,
      ...(timedOut || spawnFailed ? { exitCode: code } : {}),
      ...(spawnFailed ? { spawnFailed: true } : {}),
      ...(timedOut ? { timedOut: true, reason: "native_deadline" } : {}),
      ...(timeoutCallbackFailed ? { timeoutCallbackFailed: true } : {}),
    });
    const failed = () => { spawnFailed = true; };
    const timer = setTimeout(() => {
      // End our transport, but retain the child handle until closure proves it stopped.
      // A deadline is a failed probe, not proof of process shutdown. Never send a signal.
      timedOut = true;
      child.stdin.end();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      try { onTimeout(); } catch { timeoutCallbackFailed = true; }
    }, deadlineMs);
    child.once("close", closed);
    child.once("error", failed);
  });
}
