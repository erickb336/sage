// A two-minute deadlock guard allows native startup on a busy machine. It is not a speed assertion.
export function waitNative(child, { deadlineMs = 120_000, onTimeout = () => {} } = {}) {
  return new Promise(resolve => {
    let settled = false;
    let timedOut = false;
    let timeoutCallbackFailed = false;
    let spawnFailed = false;
    let terminationFailed = false;
    let escalation;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(escalation);
      child.removeListener("close", closed);
      child.removeListener("error", failed);
      resolve(result);
    };
    const closed = (code, signal) => finish({ code: timedOut || spawnFailed ? null : code, signal,
      ...(timedOut || spawnFailed ? { exitCode: code } : {}),
      ...(spawnFailed ? { spawnFailed: true } : {}),
      ...(terminationFailed ? { terminationFailed: true } : {}),
      ...(timedOut ? { timedOut: true, reason: "native_deadline" } : {}),
      ...(timeoutCallbackFailed ? { timeoutCallbackFailed: true } : {}),
    });
    const failed = () => { if (timedOut) terminationFailed = true; else spawnFailed = true; };
    const terminate = signal => {
      if (settled || child.exitCode != null || child.signalCode != null) return;
      try { child.kill(signal); } catch { terminationFailed = true; }
      if (signal === "SIGTERM" && !settled) escalation = setTimeout(() => terminate("SIGKILL"), 30_000);
    };
    const timer = setTimeout(() => {
      // End our transport, but retain the child handle until closure proves it stopped.
      // A deadline is a failed probe, not proof of shutdown. Allow graceful closure before escalating.
      timedOut = true;
      child.stdin.end();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      try { onTimeout(); } catch { timeoutCallbackFailed = true; }
      if (!settled) escalation = setTimeout(() => terminate("SIGTERM"), 30_000);
    }, deadlineMs);
    child.once("close", closed);
    child.on("error", failed);
  });
}
