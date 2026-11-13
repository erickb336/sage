const LEAKS = /^(?:SAGE_(?!HOME$)|GIT_|GH_(?!CONFIG_DIR$)|GITHUB_|CLAUDE_|AGENT_KIT_|FAKE_GH_)/;
for (const name of Object.keys(process.env)) if (LEAKS.test(name)) delete process.env[name];
import { realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.SAGE_SHARED_HOME = join(realpathSync(tmpdir()), `sage-test-shared-${process.pid}`);
process.on("exit", () => rmSync(process.env.SAGE_SHARED_HOME, { recursive: true, force: true }));
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

process.env.SAGE_TEST_MACHINE_ID = "test-machine";

import os from "node:os";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const homedir = os.homedir, reached = [];
const account = (() => { try { return os.userInfo().homedir; } catch { return undefined; } })();
const realHomes = new Set([homedir(), account].filter(Boolean));
const callerOf = (stack) => (stack.split("\n")[2] ?? "").trim();
const refuse = (what, caller) => {
  reached.push(caller);
  throw new Error(`a test reached the real home folder: ${what} ${caller}. Give that env a scratch HOME.`);
};
os.homedir = () => {
  const home = homedir(), caller = callerOf(new Error().stack);
  return realHomes.has(home) && !caller.includes("/node_modules/") ? refuse("os.homedir()", caller) : home;
};
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
  const call = childProcess[name];
  childProcess[name] = function (...args) {
    const options = args.find((arg) => arg && typeof arg === "object" && !Array.isArray(arg)), caller = callerOf(new Error().stack);
    if (options?.env && !options.env.HOME && !caller.includes("/node_modules/")) refuse(`${name}() with an env that has no HOME`, caller);
    return call.apply(this, args);
  };
}
syncBuiltinESMExports();
process.on("exit", () => {
  if (!reached.length) return;
  console.error(`A test reached the real home folder (T944, T969). Give each env a scratch HOME:\n${reached.join("\n")}`);
  process.exitCode = 1;
});
