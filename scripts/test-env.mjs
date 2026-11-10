// Imported first by every test file. It removes the variables of the developer's shell that change what sage, git, gh or
// the fakes do, so that a test gives the same result on every machine: in a sage session (SAGE_PROJECT, SAGE_HOOKS), in a
// git hook (GIT_DIR, GIT_WORK_TREE), with a GitHub token or host (GITHUB_TOKEN, GH_HOST), or with another Claude config.
// Two stay, SAGE_HOME and GH_CONFIG_DIR: a test that forgot its own must not fall back to the real ~/.claude or gh login.
const LEAKS = /^(?:SAGE_(?!HOME$)|GIT_|GH_(?!CONFIG_DIR$)|GITHUB_|CLAUDE_|AGENT_KIT_|FAKE_GH_)/;
for (const name of Object.keys(process.env)) if (LEAKS.test(name)) delete process.env[name];
// A test that sets only CODEX_HOME or CLAUDE_CONFIG_DIR must not reach the real ~/.sage: this process and its children get
// a shared root of their own, which goes at exit. A test of the root's order deletes the variable from its own env.
import { realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.SAGE_SHARED_HOME = join(realpathSync(tmpdir()), `sage-test-shared-${process.pid}`);
process.on("exit", () => rmSync(process.env.SAGE_SHARED_HOME, { recursive: true, force: true }));
// Git reads the developer's global config (~/.gitconfig or $XDG_CONFIG_HOME/git/config) and the system one: a
// commit.gpgsign or core.hooksPath there fails every commit a test makes (R679). /dev/null replaces both global files.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

// State-tool fixtures use a made-up stable identity; no test reads the real machine identity.
process.env.SAGE_TEST_MACHINE_ID = "test-machine";

// T944: every sage root falls back to os.homedir() when the env that it gets has no HOME, so a call such as config({})
// reached the real ~/.sage. In a test, os.homedir() never gives a real home to sage code or a test: the home that the test
// started with, or the account's home from the system (after a test deletes HOME, T969). It throws, and the file fails at
// exit also when sage code caught the throw. A test that sets process.env.HOME to a fixture gets the fixture, and a package
// under node_modules (Playwright's browser cache) still gets the real home.
import os from "node:os";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const homedir = os.homedir, reached = [];
const account = (() => { try { return os.userInfo().homedir; } catch { return undefined; } })();
const realHomes = new Set([homedir(), account].filter(Boolean));
const callerOf = (stack) => (stack.split("\n")[2] ?? "").trim(); // [0] is "Error", [1] the guard itself
const refuse = (what, caller) => {
  reached.push(caller);
  throw new Error(`a test reached the real home folder: ${what} ${caller}. Give that env a scratch HOME.`);
};
os.homedir = () => {
  const home = homedir(), caller = callerOf(new Error().stack);
  return realHomes.has(home) && !caller.includes("/node_modules/") ? refuse("os.homedir()", caller) : home;
};
// T969: a child whose env has no HOME gets the account's home (git's ~/.gitconfig, sage code's os.homedir()). Each
// child_process call of a test or of sage code whose env has no HOME throws in the same way.
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
