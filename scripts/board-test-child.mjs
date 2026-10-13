// Test-only board process supervisor. Keep every descendant owned until it exits.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const runner = fileURLToPath(import.meta.url);
const spawn = childProcess.spawn;
const children = new Set();
let serving = false, finished = false, closing = false;
const send = message => { if (process.connected) process.send(message, error => { if (error) route({ kind: "close-tree" }); }); };
function release() {
  if (finished && !serving && children.size === 0 && process.connected) process.disconnect();
}
function closeOwn() {
  if (!finished || !serving) return;
  serving = false;
  // Invoke the CLI's real shutdown handler locally; send no operating-system signal.
  process.emit("SIGTERM");
  // Disconnect IPC after descendants exit. The CLI's async close keeps the event loop alive.
  release();
}
function route(message) {
  if (message.kind === "close-tree") {
    closing = true;
    for (const child of children) if (child.connected) child.send(message, () => {});
    void closeOwn();
  } else if (message.kind === "close-pid") {
    if (message.pid === process.pid) { closing = true; void closeOwn(); }
    else for (const child of children) if (child.connected) child.send(message, () => {});
  }
}
process.on("message", route);
process.on("disconnect", () => route({ kind: "close-tree" }));
process.kill = (pid, signal) => {
  if (signal !== "SIGTERM") throw new Error("Unexpected test signal");
  send({ kind: "stop-request", pid });
};
childProcess.spawn = (command, args, options) => {
  if (command !== process.execPath || args[1] !== "board") throw new Error("Unexpected test child");
  const child = spawn(command, [runner, ...args], { ...options, stdio: [...options.stdio, "ipc"] });
  children.add(child);
  // Production detaches the server. Tests retain the handle until the server exits.
  child.unref = () => child;
  child.kill = () => { throw new Error("Real child signals are forbidden in board tests"); };
  child.on("message", message => { if (message.kind === "stop-request") send(message); });
  child.once("close", () => { children.delete(child); release(); });
  if (closing) child.once("spawn", () => child.send({ kind: "close-tree" }, () => {}));
  return child;
};
syncBuiltinESMExports();
const [cli, ...args] = process.argv.slice(2);
let stdout = "", stderr = "";
for (const [stream, capture] of [[process.stdout, text => { stdout += text; }], [process.stderr, text => { stderr += text; }]]) {
  const write = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => { capture(String(chunk)); return write(chunk, ...rest); };
}
// Keep the executable guard true: this runs the exact CLI entry point, not only its exported function.
process.argv = [process.execPath, cli, ...args];
await import(pathToFileURL(cli));
serving = process.listenerCount("SIGTERM") > 0;
finished = true;
send({ kind: "result", status: process.exitCode ?? 0, stdout, stderr });
if (closing) closeOwn();
release();
