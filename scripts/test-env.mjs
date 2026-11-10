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
// reached the real ~/.sage. In a test, os.homedir() never gives the home that the test started with to sage code or a
// test: it throws, and the file fails at exit also when sage code caught the throw. A test that sets process.env.HOME
// to a fixture gets the fixture, and a package under node_modules (Playwright's browser cache) still gets the real home.
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
const homedir = os.homedir, startHome = homedir(), reached = [];
os.homedir = () => {
  const home = homedir(), caller = (new Error().stack.split("\n")[2] ?? "").trim();
  if (home !== startHome || caller.includes("/node_modules/")) return home;
  reached.push(caller);
  throw new Error(`a test reached the real home folder: os.homedir() ${caller}. Give that env a scratch HOME.`);
};
syncBuiltinESMExports();
process.on("exit", () => {
  if (!reached.length) return;
  console.error(`A test reached the real home folder through os.homedir() (T944). Give each env a scratch HOME:\n${reached.join("\n")}`);
  process.exitCode = 1;
});
