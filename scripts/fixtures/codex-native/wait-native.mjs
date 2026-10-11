// A two-minute deadlock guard allows native startup on a busy machine. It is not a speed assertion.
export function waitNative(child, { deadlineMs = 120_000, onTimeout = () => {} } = {}) {
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("close", closed);
      child.removeListener("error", failed);
      resolve(result);
    };
    const closed = (code, signal) => finish({ code, signal });
    const failed = () => finish({ spawnFailed: true });
    const timer = setTimeout(() => {
      // End our transport and detach its handles. Do not signal or inspect a process.
      child.stdin.end();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      let timeoutCallbackFailed = false;
      try { onTimeout(); } catch { timeoutCallbackFailed = true; }
      finish({ timedOut: true, reason: "native_deadline", ...(timeoutCallbackFailed ? { timeoutCallbackFailed } : {}) });
    }, deadlineMs);
    child.once("close", closed);
    child.once("error", failed);
  });
}
