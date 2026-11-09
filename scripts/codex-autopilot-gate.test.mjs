import "./test-env.mjs"; // first: no variable of the developer's shell changes a result
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The gate's admission of the Codex merge command (T677), with the gate of a copy of the built plugin installed as Codex
// installs it, so that its merge permits live in that Codex home. The record is a real Codex 0.164.0 record of the T662
// proof with the owner's mode phrase added; the call is its own function call. The fakes: gh (it logs each call and
// names the repository), and the running Codex, found as Codex shows it to a hook: a codex-arg0 folder on PATH whose
// apply_patch link names the Codex binary, here a script that prints a version. No real gh or Codex runs: PATH holds
// only the fake folders, and each fake is proven first by its absolute path.
const BUILT = fileURLToPath(new URL("../plugins/sage-codex", import.meta.url));
const RECORDS = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/codex-owner-records.json", import.meta.url)), "utf8"));
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), "sage-autopilot-gate-")));
process.on("exit", () => rmSync(SCRATCH, { recursive: true, force: true }));
process.env.HOME = SCRATCH;
process.env.SAGE_HOME = join(SCRATCH, "sage");
delete process.env.CODEX_HOME;
const INSTALL_HOME = join(SCRATCH, "install-codex-home");
const PLUGIN = join(INSTALL_HOME, "plugins/cache/sage/sage/0.0.0");
cpSync(BUILT, PLUGIN, { recursive: true });
const { gate } = await import(join(PLUGIN, "hooks/gate-hook.mjs"));
const { answer } = await import(join(PLUGIN, "hooks/sage-codex-hook.mjs"));
const { mergeCommand, permitFolder } = await import(join(PLUGIN, "skills/sage/merge.mjs"));
const { stateKey } = await import(join(PLUGIN, "hooks/principles-hook.mjs"));
const MERGE = join(PLUGIN, "skills/sage/merge.mjs");

const FAKES = join(SCRATCH, "fakes");
const GH_LOG = join(SCRATCH, "gh.log");
const VERSION = join(SCRATCH, "codex-version.txt");
mkdirSync(FAKES);
writeFileSync(join(FAKES, "gh"), `#!${process.execPath}
require("node:fs").appendFileSync(${JSON.stringify(GH_LOG)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "repo") console.log("example-owner/example.repo"); else console.log("FAKE-gh T677");
`, { mode: 0o755 });
const CODEX_BIN = join(SCRATCH, "codex-bin");
mkdirSync(CODEX_BIN);
writeFileSync(join(CODEX_BIN, "codex"), `#!${process.execPath}
console.log("codex-cli " + require("node:fs").readFileSync(${JSON.stringify(VERSION)}, "utf8").trim());
`, { mode: 0o755 });
const ARG0 = join(SCRATCH, "codex-home-tmp", "arg0", "codex-arg0TEST");
mkdirSync(ARG0, { recursive: true });
symlinkSync(join(CODEX_BIN, "codex"), join(ARG0, "apply_patch"));
writeFileSync(VERSION, "0.164.0\n");
const ghCalls = () => (existsSync(GH_LOG) ? readFileSync(GH_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);

test("the fakes are the ones that run: gh by its absolute path, and the Codex of the arg0 link", () => {
  assert.equal(spawnSync(join(FAKES, "gh"), ["--version"], { encoding: "utf8", env: { PATH: FAKES } }).stdout, "FAKE-gh T677\n");
  assert.equal(spawnSync(join(ARG0, "apply_patch"), ["--version"], { encoding: "utf8", env: {} }).stdout, "codex-cli 0.164.0\n");
  rmSync(GH_LOG);
  console.log("fakes proven: FAKE-gh T677, codex-cli 0.164.0");
});

const META = RECORDS["exec-on"][0];
const SESSION = META.payload.id;
const CALL = RECORDS["exec-on"].find((o) => o.payload.type === "function_call").payload.call_id;
const TURN = RECORDS["exec-on"].find((o) => o.payload.type === "task_started").payload.turn_id;
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const COMMAND = mergeCommand("41", SHA);
const PPID = 4242;
/** The record with the owner's mode phrase (sage mode on) in a turn of its own, before the turn of the on phrase and the call. */
function withMode(lines) {
  const template = lines.find((o) => o.payload.role === "user" && o.payload.content?.[0]?.text === "autopilot on");
  const first = lines.findIndex((o) => o.payload.type === "task_started");
  const turn = "mode-turn";
  const start = { ...lines[first], payload: { ...lines[first].payload, turn_id: turn, turn_attribution: { ...lines[first].payload.turn_attribution, turn_id: turn } } };
  const mode = { ...template, payload: { ...template.payload, content: [{ type: "input_text", text: "sage mode" }], internal_chat_message_metadata_passthrough: { ...template.payload.internal_chat_message_metadata_passthrough, turn_id: turn } } };
  return [...lines.slice(0, first), start, mode, ...lines.slice(first)];
}
let worlds = 0;
/**
 * A scratch world: the hook's environment, the record, the mode file with sage mode and autopilot on (from the on of
 * the turn TURN, as the mode hook saves it), and the start mark.
 */
function world({ lines = withMode(RECORDS["exec-on"]), mode = { sage: true, autopilot: true, given: true, onTurn: TURN }, mark = { lines: 0, pid: PPID } } = {}) {
  const home = join(SCRATCH, `world-${++worlds}`);
  const project = join(home, "project");
  mkdirSync(project, { recursive: true });
  const env = { PATH: `${ARG0}:${FAKES}`, HOME: home, SAGE_HOME: join(home, "sage"), SAGE_SHARED_HOME: process.env.SAGE_SHARED_HOME, TMPDIR: join(home, "tmp") };
  const transcript = join(home, `rollout-2026-11-07T09-00-00-${SESSION}.jsonl`);
  writeFileSync(transcript, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const dir = join(env.SAGE_HOME, ".hooks", "codex");
  mkdirSync(join(dir, "marks"), { recursive: true, mode: 0o700 });
  const modeFile = join(dir, `${stateKey({ session_id: SESSION })}.json`);
  if (mode) writeFileSync(modeFile, typeof mode === "string" ? mode : JSON.stringify(mode), { mode: 0o600 });
  if (mark) writeFileSync(join(dir, "marks", `${stateKey({ session_id: SESSION })}.json`), JSON.stringify({ session: SESSION, source: "startup", ...mark }), { mode: 0o600 });
  const checks = [], paths = [];
  // The fakes are under the test's temporary folder (/tmp on Linux), which the gate counts as writable by the sandbox:
  // so the tests give the gate no fixed temporary folder, and the R2611 test gives it this one.
  const deps = { env, ppid: PPID, temporary: [], check: async (merge, cwd, checkEnv) => (checks.push({ ...merge, cwd }), paths.push(checkEnv.PATH), { ok: true }) };
  const input = (command = COMMAND, extra = {}) => ({ hook_event_name: "PreToolUse", session_id: SESSION, turn_id: TURN, transcript_path: transcript, cwd: project,
    model: "m", permission_mode: "default", tool_name: "Bash", tool_use_id: CALL, tool_input: { command }, ...extra });
  const ask = (command = COMMAND, extra = {}) => ({ hook_event_name: "PermissionRequest", session_id: SESSION, turn_id: TURN, transcript_path: transcript, cwd: project,
    model: "m", permission_mode: "default", tool_name: "Bash", tool_input: { command, description: "merge" }, ...extra });
  return { home, project, env, transcript, modeFile, checks, paths, deps, input, ask, run: (i, d = {}) => gate(i, { ...deps, ...d }) };
}
const denied = (out) => (out?.hookSpecificOutput?.permissionDecision === "deny" ? out.hookSpecificOutput.permissionDecisionReason : out);
// A plugin with no permit folder (the PR 1 base) has no permits: each test then fails on what the gate does.
const permits = () => (permitFolder && existsSync(permitFolder) ? readdirSync(permitFolder) : []);
const clearPermits = () => permitFolder && rmSync(permitFolder, { recursive: true, force: true });
const ALLOW = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
const READY = "Report the pull request as ready: the owner merges it in GitHub";
/** The gate's refusal when the mode file has autopilot off. */
const OFF = 'sage: autopilot is off, so the owner merges. Report the pull request as ready. To turn autopilot on while sage mode is on, the owner sends "autopilot on" alone, as a new message while Codex is idle (press Esc first if Codex is busy)';

test("admission: with the mode file on, the owner's on, the call in the record and a passing merge check, the gate saves one permit, the escalation is allowed, and the merge command merges", async () => {
  clearPermits();
  const w = world();
  assert.equal(await w.run(w.input()), undefined, "the gate admits the call");
  assert.deepEqual(w.checks, [{ pr: "41", sha: SHA, cwd: w.project }], "checkMerge ran once, unchanged, for this pull request and head");
  assert.equal(permits().length, 1);
  const permit = JSON.parse(readFileSync(join(permitFolder, permits()[0]), "utf8"));
  assert.deepEqual({ ...permit, time: typeof permit.time }, { session: SESSION, repo: "example-owner/example.repo", pr: "41", sha: SHA, command: COMMAND, cwd: w.project, turn: TURN,
    transcript: w.transcript, mark: { session: SESSION, source: "startup", lines: 0, pid: PPID }, mode: w.modeFile, gh: join(FAKES, "gh"), path: `${ARG0}:${FAKES}`, time: "number" });
  assert.deepEqual(ghCalls(), [["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]], "the gate sets the repository from gh in the call's folder");
  rmSync(GH_LOG);
  // R2611: the escalation is allowed only for the same session, turn, exact command and working folder, from the root thread.
  assert.deepEqual(await w.run(w.ask()), ALLOW);
  for (const [name, request] of [["another folder", w.ask(COMMAND, { cwd: w.home })], ["another command", w.ask(mergeCommand("42", SHA))], ["another turn", w.ask(COMMAND, { turn_id: "turn-2" })],
    ["another session", w.ask(COMMAND, { session_id: "019a0000-0000-7000-8000-000000000bad" })], ["a child", w.ask(COMMAND, { agent_id: "agent-1" })], ["more words", w.ask(`${COMMAND} && echo done`)]]) {
    assert.equal(await w.run(request), undefined, name);
  }
  const r = spawnSync(process.execPath, [MERGE, "41", SHA], { cwd: w.project, encoding: "utf8",
    env: { PATH: FAKES, HOME: w.home, CODEX_SESSION_ID: SESSION, CODEX_THREAD_ID: SESSION, CODEX_TOOL_CALL_ID: CALL } });
  assert.deepEqual({ status: r.status, stdout: r.stdout, stderr: r.stderr }, { status: 0, stdout: "FAKE-gh T677\n", stderr: "" });
  assert.deepEqual(ghCalls(), [["pr", "merge", "41", "--repo", "example-owner/example.repo", "--squash", "--delete-branch", "--match-head-commit", SHA]]);
  rmSync(GH_LOG);
  assert.deepEqual(permits(), [], "the permit is used up");
  assert.equal(await w.run(w.ask()), undefined, "a used permit allows no escalation");
});

test("R2611: the gate requires sage mode and autopilot on in the session's mode file", async () => {
  for (const [name, mode] of [["autopilot off", { sage: true, autopilot: false }], ["sage mode off", { sage: false, autopilot: true }], ["a damaged mode file", "{not json"], ["no mode file", null]]) {
    clearPermits();
    const w = world({ mode });
    assert.equal(denied(await w.run(w.input())), OFF, name);
    assert.deepEqual([w.checks, permits()], [[], []], `${name}: no merge check and no permit`);
  }
});

test("F-T663-21: the gate treats every run of merge.mjs as a merge: only the exact form, from the root thread", async () => {
  clearPermits();
  const w = world();
  const FORM = `sage: run sage's merge command in its one form, alone: ${mergeCommand("<pr>", "<head sha>")}`;
  const script = MERGE;
  for (const command of [`SAGE_HOME=${w.home} ${COMMAND}`, `node "${script}" 41 ${SHA}`, `"${process.execPath}" "${script}" 41 ${SHA} --admin`, `${COMMAND} && echo done`,
    `cd ${w.project} && ${COMMAND}`, `bash -c '${COMMAND}'`, `"${process.execPath}" "${script}" 041 ${SHA}`, `"${process.execPath}" ./merge.mjs 41 ${SHA}`,
    `"${process.execPath}" "${join(SCRATCH, "copy", "skills", "sage", "merge.mjs")}" 41 ${SHA}`]) {
    assert.equal(denied(await w.run(w.input(command))), FORM, command);
  }
  assert.equal(denied(await w.run(w.input(COMMAND, { agent_id: "agent-1" }))), "sage: only the chief merges, not an agent. Report the pull request as ready", "a child");
  assert.deepEqual([w.checks, permits()], [[], []]);
  assert.equal(denied(await w.run(w.input(`cat "${script}"`))), undefined, "a read of the file is no merge");
  assert.equal(denied(await w.run(w.input(`gh pr merge 41 --squash --delete-branch --match-head-commit ${SHA}`))),
    "sage: in Codex, only sage's merge command merges, on autopilot, as the chief's instructions say. Without autopilot, the owner merges the pull request in GitHub", "gh pr merge never runs");
});

test("F-T663-1: the gate checks the version of the Codex that runs, also when the record is from an older Codex (a resume by a newer one)", async () => {
  // R2690's proof: Codex 0.166.0-alpha.6 resumed a record of 0.164.0 and wrote no session_meta and no version into it.
  // F-T677-16: 0.167 reads; any later version, which sage has not checked, refuses.
  try {
    for (const version of ["0.168.0", "0.168.0-alpha.1", "0.170.2", "1.0.0"]) {
      clearPermits();
      writeFileSync(VERSION, `${version}\n`);
      const w = world();
      // F-T677-26: the refusal says that merges wait until sage adds that version.
      assert.equal(denied(await w.run(w.input())), `sage: this session runs Codex ${version}, and autopilot merges only in Codex 0.164 to 0.167: a newer Codex waits until sage adds it. ${READY}`, version);
      assert.deepEqual(permits(), []);
    }
    for (const version of ["0.166.0-alpha.6", "0.167.0"]) {
      writeFileSync(VERSION, `${version}\n`);
      clearPermits();
      const desktop = world();
      assert.equal(await desktop.run(desktop.input()), undefined, version);
      rmSync(GH_LOG);
    }
    // The desktop app's Codex today, with its own record (R2721, scrubbed): the on phrase starts a turn, then the call.
    writeFileSync(VERSION, "0.167.0-alpha.3.2\n");
    clearPermits();
    const app = RECORDS["app-steer"];
    const offTurn = app.findLast((o) => o.payload.type === "task_started"); // the last turn: the off phrase joins it
    const call = RECORDS["exec-on"].find((o) => o.payload.type === "function_call");
    const onTurn = app.slice(0, app.indexOf(offTurn)).findLast((o) => o.payload.role === "user" && o.payload.content?.[0]?.text === "autopilot on").payload.internal_chat_message_metadata_passthrough.turn_id;
    const desktop = world({ lines: [{ ...app[0], payload: { ...app[0].payload, id: SESSION } }, ...app.slice(1, app.indexOf(offTurn)), call], mode: { sage: true, autopilot: true, given: true, onTurn } });
    assert.equal(app[0].payload.cli_version, "0.167.0-alpha.3.2");
    assert.equal(await desktop.run(desktop.input()), undefined, "the desktop app's Codex 0.167.0-alpha.3.2");
    rmSync(GH_LOG);
  } finally {
    writeFileSync(VERSION, "0.164.0\n");
  }
});

test("F-T677-17, F-T677-27: when the hook's PATH has no codex-arg0 folder, the refusal names the cause in plain words, and the fix", async () => {
  clearPermits();
  const none = world();
  const said = denied(await none.run(none.input(), { env: { ...none.env, PATH: FAKES } }));
  assert.equal(said, `sage: sage cannot tell which Codex runs this session, because Codex's own folder is not on the hook's PATH. A login profile, such as ~/.zprofile, that sets PATH without its earlier value drops it: keep the earlier value there (export PATH="<folder>:$PATH"), then ask for the merge again. ${READY}`, "no codex-arg0 folder");
  assert.doesNotMatch(said, /arg0/, "no internal name");
  assert.deepEqual(permits(), []);
});

test("F-T663-9, F-T663-22: a start mark of another Codex process refuses; a missing mark refuses", async () => {
  clearPermits();
  const w = world({ mark: { lines: 0, pid: PPID + 1 } });
  assert.equal(denied(await w.run(w.input())), `sage: sage's note of this session start is from another Codex process, so autopilot merges nothing in this session for now. ${READY}, or resume the session and send "autopilot on" again`);
  const noPid = world({ mark: { lines: 0 } });
  assert.match(denied(await noPid.run(noPid.input())), /from another Codex process/, "a mark with no pid");
  const none = world({ mark: null });
  assert.match(denied(await none.run(none.input())), /^sage: sage saved no note when this session started/);
  assert.deepEqual(permits(), []);
});

test("the call must be in Codex's record after the start mark, and the owner's on must be after it too", async () => {
  clearPermits();
  const w = world();
  assert.equal(denied(await w.run(w.input(COMMAND, { tool_use_id: "call_not_in_record" }))), "sage: this merge call is not in Codex's record of this session, so sage refuses it. Ask for the merge again");
  const lines = withMode(RECORDS["exec-on"]);
  const late = world({ mark: { lines: lines.length, pid: PPID } });
  assert.match(denied(await late.run(late.input())), /^sage: the owner has not turned autopilot on, with sage mode on, since this session started, so the owner merges/);
  const [meta, ...rest] = withMode(RECORDS["tui-on-then-off"]);
  const off = world({ lines: [{ ...meta, payload: { ...meta.payload, id: SESSION } }, ...rest] });
  assert.match(denied(await off.run(off.input(COMMAND, { tool_use_id: "x" }))), /^sage: the owner's latest autopilot switch is off, so the owner merges/);
  assert.deepEqual(permits(), []);
});

test("R2611: node and gh never come from a folder that Codex's sandbox can write", async () => {
  clearPermits();
  // gh only in the project folder, or only in the temporary folder: refused.
  for (const where of ["project", "tmp"]) {
    const w = world();
    const dir = where === "project" ? join(w.project, "bin") : w.env.TMPDIR;
    mkdirSync(dir, { recursive: true });
    cpSync(join(FAKES, "gh"), join(dir, "gh"));
    chmodSync(join(dir, "gh"), 0o755);
    assert.equal(denied(await w.run(w.input(), { env: { ...w.env, PATH: `${ARG0}:${dir}` } })), `sage: sage found no gh outside the folders that Codex's sandbox can write, so autopilot merges nothing. ${READY}`, where);
  }
  // A gh in the project folder first on PATH is skipped, and the one outside it is the one that the permit names.
  const first = world();
  mkdirSync(join(first.project, "bin"));
  writeFileSync(join(first.project, "bin", "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.equal(await first.run(first.input(), { env: { ...first.env, PATH: `${ARG0}:${join(first.project, "bin")}:relative/bin:${FAKES}` } }), undefined);
  assert.equal(JSON.parse(readFileSync(join(permitFolder, permits()[0]), "utf8")).gh, join(FAKES, "gh"));
  assert.deepEqual(first.paths, [`${ARG0}:${FAKES}`], "the merge check runs with the trusted PATH too");
  clearPermits();
  rmSync(GH_LOG);
  // A fixed temporary folder of the sandbox (here the folder that holds the fakes): gh and the Codex binary there do not count.
  const temporary = world();
  assert.equal(denied(await temporary.run(temporary.input(), { temporary: [SCRATCH] })), `sage: sage cannot tell which Codex runs this session, and autopilot merges only in Codex 0.164 to 0.167. ${READY}`);
  assert.deepEqual(permits(), []);
  // node: the gate's own node, which must be outside those folders too (here the temporary folder names node's folder).
  const node = world();
  assert.match(denied(await node.run(node.input(), { env: { ...node.env, TMPDIR: dirname(process.execPath) } })) ?? "", /^sage: node runs from a folder that Codex's sandbox can write/);
  assert.deepEqual(permits(), []);
});

test("F-T677-2: a gh link in a folder outside the sandbox's folders, whose real file is inside them, is not gh", async () => {
  clearPermits();
  const w = world();
  mkdirSync(join(w.project, "bin"));
  cpSync(join(FAKES, "gh"), join(w.project, "bin", "gh"));
  chmodSync(join(w.project, "bin", "gh"), 0o755);
  const outside = join(w.home, "outside-bin");
  mkdirSync(outside);
  symlinkSync(join(w.project, "bin", "gh"), join(outside, "gh"));
  assert.equal(denied(await w.run(w.input(), { env: { ...w.env, PATH: `${ARG0}:${outside}` } })), `sage: sage found no gh outside the folders that Codex's sandbox can write, so autopilot merges nothing. ${READY}`);
  assert.deepEqual([w.checks, permits(), ghCalls()], [[], [], []], "no merge check, no permit, and no gh ran");
});

/**
 * A logging gh for the PATH and launcher tests: it logs its called name (argv0), its arguments and its PATH, and names
 * the repository. kind "script" is a node script; kind "launcher" is node itself linked as gh, with a preload that acts
 * as a shared launcher (snap, mise): it runs gh only when it is called by the name gh, and else refuses.
 */
function loggingGh(kind) {
  const dir = join(SCRATCH, `${kind}-gh-${++worlds}`);
  const log = join(dir, "calls.log");
  mkdirSync(dir);
  const body = `const { basename } = require("node:path");
const args = ${kind === "launcher" ? "[basename(process.argv[1] ?? \"\"), ...process.argv.slice(2)]" : "process.argv.slice(2)"};
if (["repo", "pr"].includes(args[0])) {
  if (basename(process.argv0) !== "gh" && ${kind === "launcher"}) { console.error("launcher: no tool named " + basename(process.argv0)); process.exit(1); }
  require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, PATH: process.env.PATH }) + "\\n");
  console.log(args[0] === "repo" ? "example-owner/example.repo" : "FAKE-gh T677 " + ${JSON.stringify(kind)});
  process.exit(0);
}
`;
  const env = {};
  if (kind === "launcher") {
    symlinkSync(process.execPath, join(dir, "gh"));
    writeFileSync(join(dir, "launcher.cjs"), body);
    env.NODE_OPTIONS = `--require=${join(dir, "launcher.cjs")}`;
  } else writeFileSync(join(dir, "gh"), `#!${process.execPath}\n${body}`, { mode: 0o755 });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
  return { dir, env, calls };
}
/** Run the merge command of the world's admitted call, with this environment. */
const runMerge = (w, env) => spawnSync(process.execPath, [MERGE, "41", SHA], { cwd: w.project, encoding: "utf8", env: { HOME: w.home, CODEX_SESSION_ID: SESSION, CODEX_THREAD_ID: SESSION, CODEX_TOOL_CALL_ID: CALL, ...env } });

test("F-T677-1: gh runs with the name gh, so a shared launcher that picks its tool by name (snap, mise) runs gh", async () => {
  clearPermits();
  const w = world();
  const gh = loggingGh("launcher");
  assert.equal(spawnSync(join(gh.dir, "gh"), ["pr", "x"], { encoding: "utf8", env: { ...gh.env, PATH: gh.dir } }).stdout, "FAKE-gh T677 launcher\n", "the launcher runs gh by the link's name");
  assert.match(spawnSync(realpathSync(join(gh.dir, "gh")), ["pr", "x"], { encoding: "utf8", env: gh.env }).stderr, /^launcher: no tool named node/, "by its real file's name it refuses");
  rmSync(join(gh.dir, "calls.log"));
  const env = { ...w.env, ...gh.env, PATH: `${ARG0}:${gh.dir}` };
  assert.equal(denied(await w.run(w.input(), { env })), undefined, "the gate admits the call");
  assert.equal(JSON.parse(readFileSync(join(permitFolder, permits()[0]), "utf8")).gh, realpathSync(process.execPath), "the permit names the real file, which no link change can swap");
  const r = runMerge(w, { ...gh.env, PATH: gh.dir });
  assert.deepEqual({ status: r.status, stdout: r.stdout, stderr: r.stderr }, { status: 0, stdout: "FAKE-gh T677 launcher\n", stderr: "" });
  assert.deepEqual(gh.calls().map((call) => call.args), [["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], ["pr", "merge", "41", "--repo", "example-owner/example.repo", "--squash", "--delete-branch", "--match-head-commit", SHA]]);
  assert.deepEqual(ghCalls(), []);
});

test("F-T677-4: the trusted PATH drops missing folders, and every gh child (repo view, the merge) gets the trusted PATH", async () => {
  clearPermits();
  const w = world();
  const gh = loggingGh("script");
  // TMPDIR given in a form that is not its real form (here a link, as /var is on macOS), and a PATH folder under it
  // that does not exist yet: the sandbox could make it later. A missing folder elsewhere goes too.
  mkdirSync(join(w.home, "tmp-real"));
  symlinkSync(join(w.home, "tmp-real"), join(w.home, "tmp-link"));
  mkdirSync(join(w.project, "bin"));
  writeFileSync(join(w.project, "bin", "git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = { ...w.env, TMPDIR: join(w.home, "tmp-link"), PATH: [ARG0, join(w.home, "tmp-link", "later"), join(w.home, "missing-bin"), join(w.project, "bin"), gh.dir].join(":") };
  assert.equal(denied(await w.run(w.input(), { env })), undefined);
  const trusted = `${ARG0}:${gh.dir}`;
  assert.deepEqual(w.paths, [trusted], "the merge check's PATH");
  assert.equal(JSON.parse(readFileSync(join(permitFolder, permits()[0]), "utf8")).path, trusted, "the permit's PATH");
  const r = runMerge(w, { PATH: `${join(w.project, "bin")}:${gh.dir}` });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(gh.calls().map((call) => [call.args[0], call.PATH]), [["repo", trusted], ["pr", trusted]], "gh and the git that it starts never come from the project's folder");
  assert.deepEqual(ghCalls(), []);
});

test("F-T677-3, F-T677-34: the gate allows no network approval of the admitted call, also for GitHub's API: Codex asks the owner", async () => {
  // When gh asks for the network, the merge command has already used the permit, so an allow there could never apply
  // (F-T677-34). The gate allows only the escalation, while the permit is unused.
  clearPermits();
  const w = world();
  assert.equal(await w.run(w.input()), undefined);
  rmSync(GH_LOG);
  const ask = (description) => w.ask(COMMAND, { tool_input: description === undefined ? { command: COMMAND } : { command: COMMAND, description } });
  // Codex 0.164 gives a network approval as Bash with the call's command and "network-access <protocol>://<host>:<port>".
  for (const description of ["network-access https://api.github.com:443", "network-access https://example.com:443", "network-access http://api.github.com:80", "network-access https://api.github.com.example.com:443",
    "network-access socks5-tcp://api.github.com:443", "network-access https://api.github.com:443 ", 7, null]) {
    assert.equal(await w.run(ask(description)), undefined, String(description));
  }
  // The escalation itself: no description, or the model's own reason.
  assert.deepEqual(await w.run(ask(undefined)), ALLOW, "no description");
  assert.deepEqual(await w.run(ask("merge the verified pull request")), ALLOW, "a reason of the model");
});

test("a failing merge check refuses with its own reason, and saves no permit", async () => {
  clearPermits();
  const w = world();
  const reason = "sage: the merge check refuses: no verdicts recorded";
  assert.equal(denied(await w.run(w.input(), { check: async () => ({ ok: false, reason }) })), reason);
  assert.deepEqual(permits(), []);
  rmSync(GH_LOG, { force: true });
});

test("the off path never blocks and is never missed: an off after the admission stops the merge command, also when the mode hook cannot save it", async () => {
  for (const kind of ["typed", "image", "saved"]) {
    clearPermits();
    const w = world();
    assert.equal(await w.run(w.input()), undefined);
    rmSync(GH_LOG);
    if (kind === "saved") {
      // The mode hook saves the off: it answers with no block, and the merge command reads the mode file.
      const out = answer({ hook_event_name: "UserPromptSubmit", session_id: SESSION, turn_id: "t-off", transcript_path: w.transcript, cwd: w.project, prompt: "autopilot off" }, w.env);
      assert.equal(out?.decision, undefined, "the off is never blocked");
      assert.deepEqual(JSON.parse(readFileSync(w.modeFile, "utf8")).autopilot, false);
    } else {
      // The off reaches Codex's record even when its hook fails (T662 proof 3b): here only the record has it.
      const image = RECORDS["image-off"].filter((o) => o.payload.role === "user").at(-1);
      const off = kind === "image" ? image : { ...image, payload: { ...image.payload, content: [{ type: "input_text", text: "autopilot off" }], internal_chat_message_metadata_passthrough: { ...image.payload.internal_chat_message_metadata_passthrough, content_item_metadata: [{ provenance: { type: "user" } }] } } };
      writeFileSync(w.transcript, `${readFileSync(w.transcript, "utf8")}${JSON.stringify(off)}\n`);
    }
    const r = spawnSync(process.execPath, [MERGE, "41", SHA], { cwd: w.project, encoding: "utf8", env: { PATH: FAKES, HOME: w.home, CODEX_SESSION_ID: SESSION, CODEX_THREAD_ID: SESSION, CODEX_TOOL_CALL_ID: CALL } });
    assert.equal(r.status, 1, kind);
    assert.match(r.stderr, kind === "saved" ? /autopilot is off in sage's mode file of this session/ : /the owner's latest autopilot switch is off/, kind);
    assert.deepEqual(ghCalls(), [], `${kind}: no gh`);
  }
  // A mode folder that cannot change: the mode hook gives one line and blocks nothing; the record's off still stops merges.
  clearPermits();
  const w = world();
  assert.equal(await w.run(w.input()), undefined);
  rmSync(GH_LOG);
  chmodSync(dirname(w.modeFile), 0o500);
  chmodSync(w.modeFile, 0o400);
  try {
    const out = answer({ hook_event_name: "UserPromptSubmit", session_id: SESSION, turn_id: "t-off", transcript_path: w.transcript, cwd: w.project, prompt: "autopilot off" }, w.env);
    assert.equal(out?.decision, undefined);
    assert.match(out.systemMessage ?? "", /could not read or save the sage mode of this session/);
  } finally { chmodSync(dirname(w.modeFile), 0o700); chmodSync(w.modeFile, 0o600); }
  const off = { ...RECORDS["image-off"].filter((o) => o.payload.role === "user").at(-1) };
  writeFileSync(w.transcript, `${readFileSync(w.transcript, "utf8")}${JSON.stringify(off)}\n`);
  const r = spawnSync(process.execPath, [MERGE, "41", SHA], { cwd: w.project, encoding: "utf8", env: { PATH: FAKES, HOME: w.home, CODEX_SESSION_ID: SESSION, CODEX_THREAD_ID: SESSION, CODEX_TOOL_CALL_ID: CALL } });
  assert.match(r.stderr, /the owner's latest autopilot switch is off/);
  assert.deepEqual(ghCalls(), []);
});

test("F-T677-24, F-T677-29: an off from a subagent's thread, a fork, a fork of a fork, a fork's subagent or a side conversation stops the main session's merges; an on from there counts for nothing", async () => {
  // The threads, as Codex 0.164.0 gives them to the hook: a subagent's prompt has its root thread's session id and an
  // agent_id; a fork has its own session id and a record that names the thread it came from (forked_from_id), which
  // can be a fork too; a subagent of a fork has the fork's session id; a side conversation (/side) is a fork with no
  // record.
  const FORK = "019a0000-0000-7000-8000-00000000f0f1", FORK2 = "019a0000-0000-7000-8000-00000000f0f2", CHILD = "019a0000-0000-7000-8000-0000000000c1";
  const child = (root) => ({ session: root, agent: CHILD, meta: { id: CHILD, session_id: root, source: { subagent: { thread_spawn: { parent_thread_id: root, depth: 1, agent_path: "/root/sage_lead_t1" } } } } });
  const THREADS = {
    "subagent": child(SESSION),
    "fork": { session: FORK, meta: { id: FORK, session_id: FORK, forked_from_id: SESSION, source: "cli" } },
    "fork of a fork": { session: FORK2, meta: { id: FORK2, session_id: FORK2, forked_from_id: FORK, source: "cli" } },
    "fork's subagent": child(FORK),
    "side": { session: "019a0000-0000-7000-8000-00000000051d" },
  };
  const prompt = (w, prompt, thread) => {
    const { session, agent, meta } = THREADS[thread];
    let transcript = null;
    if (meta) {
      transcript = join(w.home, `rollout-2026-11-07T09-10-00-${meta.id}.jsonl`);
      writeFileSync(transcript, `${JSON.stringify({ type: "session_meta", payload: { ...meta, cli_version: "0.164.0" } })}\n`);
    }
    return answer({ hook_event_name: "UserPromptSubmit", turn_id: "t-other", cwd: w.project, model: "m", permission_mode: "default", prompt, session_id: session, transcript_path: transcript, ...(agent ? { agent_id: agent, agent_type: "default" } : {}) }, w.env);
  };
  const merge = (w) => spawnSync(process.execPath, [MERGE, "41", SHA], { cwd: w.project, encoding: "utf8", env: { PATH: FAKES, HOME: w.home, CODEX_SESSION_ID: SESSION, CODEX_THREAD_ID: SESSION, CODEX_TOOL_CALL_ID: CALL } });
  const AGAIN = 'To turn it on again, send "autopilot on" alone in the main thread of a session, as a new message while Codex is idle (press Esc first if Codex is busy).';
  const line = (thread, mode = "") => thread ? `sage: you sent the off phrase in ${thread}, so autopilot is now off in every Codex session${mode}. ${AGAIN}`
    : `sage: sage cannot read Codex's record of this thread, so it does not know if this is a main thread or a side conversation. So it turned autopilot off in every Codex session. ${AGAIN}`;
  const cases = [
    ["subagent", "autopilot off", line("a subagent's thread")],
    ["subagent", "sage mode off", line("a subagent's thread", ", and sage mode is off in this thread's session")],
    ["fork", "autopilot off", line("a fork")],
    ["fork of a fork", "autopilot off", line("a fork")],
    ["fork's subagent", "autopilot off", line("a subagent's thread")],
    ["fork's subagent", "sage mode off", line("a subagent's thread", ", and sage mode is off in this thread's session")],
    ["side", "autopilot off", line()],
  ];
  const lines = [];
  for (const [thread, phrase] of cases) {
    const name = `${phrase} from a ${thread}`;
    clearPermits();
    const w = world();
    assert.equal(await w.run(w.input()), undefined, `${name}: the gate admits the merge before the off`);
    rmSync(GH_LOG);
    lines.push(prompt(w, phrase, thread)?.systemMessage);
    const r = merge(w);
    assert.deepEqual({ status: r.status, gh: ghCalls() }, { status: 1, gh: [] }, `${name}: the admitted merge stops, with no gh`);
    assert.match(r.stderr, /autopilot is off in sage's mode file of this session/, name);
    assert.equal(denied(await w.run(w.input())), OFF, `${name}: the gate refuses the next merge`);
  }
  assert.deepEqual(lines, cases.map(([, , said]) => said), "one line in the thread where the owner sent it");
  // An on from a subagent's thread, a fork's subagent or a side conversation changes nothing in the main session.
  clearPermits();
  const w = world({ mode: { sage: true, autopilot: false, given: true } });
  for (const thread of ["subagent", "fork's subagent", "side"]) for (const phrase of ["sage mode", "autopilot on"]) assert.equal(prompt(w, phrase, thread)?.systemMessage, undefined, `${phrase} from a ${thread}`);
  assert.deepEqual(JSON.parse(readFileSync(w.modeFile, "utf8")), { sage: true, autopilot: false, given: true });
  assert.equal(denied(await w.run(w.input())), OFF);
  assert.deepEqual([w.checks, permits(), ghCalls().filter((call) => call.includes("merge"))], [[], [], []]);
  rmSync(GH_LOG, { force: true }); // the side's own on asks gh for the branch protection (protectionNote)
});

test("F-T677-33, F-T677-18: after an off from a fork, an on that joins the main thread's running turn merges nothing; only a new on that starts its own turn turns merges on again", async () => {
  // Owner decision 2026-11-08 (option A). The main thread's record keeps the owner's on of the turn TURN, and the off
  // from the fork reaches only the mode files. The real lines of exec-on give the shapes of the new lines.
  const exec = RECORDS["exec-on"];
  const startOf = (turn) => { const s = exec.find((o) => o.payload.type === "task_started"); return { ...s, payload: { ...s.payload, turn_id: turn, turn_attribution: { ...s.payload.turn_attribution, turn_id: turn } } }; };
  const message = (turn, text) => { const m = exec.find((o) => o.payload.role === "user" && o.payload.content?.[0]?.text === "autopilot on"); return { ...m, payload: { ...m.payload, content: [{ type: "input_text", text }], internal_chat_message_metadata_passthrough: { ...m.payload.internal_chat_message_metadata_passthrough, turn_id: turn } } }; };
  const callOf = (id) => { const c = exec.find((o) => o.payload.type === "function_call"); return { ...c, payload: { ...c.payload, call_id: id } }; };
  const FORK = "019a0000-0000-7000-8000-00000000f0f3";
  const prompt = (w, session, turn, text, transcript) => answer({ hook_event_name: "UserPromptSubmit", session_id: session, turn_id: turn, transcript_path: transcript, cwd: w.project, model: "m", permission_mode: "default", prompt: text }, w.env);
  const offFromFork = (w) => {
    const record = join(w.home, `rollout-2026-11-07T09-20-00-${FORK}.jsonl`);
    writeFileSync(record, `${JSON.stringify({ type: "session_meta", payload: { id: FORK, session_id: FORK, forked_from_id: SESSION, cli_version: "0.164.0", source: "cli" } })}\n`);
    prompt(w, FORK, "t-fork", "autopilot off", record);
    assert.equal(JSON.parse(readFileSync(w.modeFile, "utf8")).autopilot, false, "the off from the fork reaches the main thread's mode file");
  };
  const append = (w, lines) => writeFileSync(w.transcript, `${readFileSync(w.transcript, "utf8")}${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  const JOINED = 'sage: this "autopilot on" did not count, because it did not start a new turn: it came while Codex worked, or from a queue. Autopilot is still off. Tell the user in one line of your reply that the on did not count, and to send "autopilot on" alone, as a new message while Codex is idle (press Esc first if Codex is busy).';
  const DID = `sage: the owner's latest "autopilot on" did not count, because only an on that is the whole message and starts a new turn counts, so the owner merges. ${READY}. To turn autopilot on, the owner sends "autopilot on" alone, as a new message while Codex is idle (press Esc first if Codex is busy)`;
  for (const [name, early, said, refusal] of [
    ["the hook sees the turn that WAIT started", false, JOINED, OFF],
    ["the hook runs before Codex writes the turn's first message", true, undefined, DID],
  ]) {
    clearPermits();
    const w = world();
    assert.equal(await w.run(w.input()), undefined, `${name}: the gate admits a merge before the off`);
    clearPermits();
    rmSync(GH_LOG);
    offFromFork(w);
    // Turn X: "WAIT" starts it, and the owner's on joins it (Enter while Codex works). Then the chief asks for a merge.
    if (!early) append(w, [startOf("X"), message("X", "WAIT")]);
    const out = prompt(w, SESSION, "X", "autopilot on", w.transcript);
    if (early) append(w, [startOf("X"), message("X", "WAIT")]);
    append(w, [message("X", "autopilot on"), callOf("call-x")]);
    assert.equal(denied(await w.run(w.input(COMMAND, { tool_use_id: "call-x", turn_id: "X" }))), refusal, `${name}: the gate refuses the merge`);
    assert.deepEqual([w.checks.length, permits()], [1, []], `${name}: no merge check after the off, and no permit`);
    assert.equal(out?.hookSpecificOutput?.additionalContext.startsWith('sage: this "autopilot on" did not count') ? out.hookSpecificOutput.additionalContext : undefined, said, `${name}: the chief's note`);
    // Turn Y: the owner's on starts it, as a new message while Codex is idle. Merges run again.
    append(w, [startOf("Y")]);
    // (In the second case the mode file is already on, from the on of turn X, so the hook only saves the new turn.)
    const again = prompt(w, SESSION, "Y", "autopilot on", w.transcript)?.hookSpecificOutput?.additionalContext;
    if (!early) assert.match(again ?? "", /^sage: autopilot is on\./, `${name}: the new on switches`);
    assert.deepEqual(JSON.parse(readFileSync(w.modeFile, "utf8")), { sage: true, autopilot: true, given: true, onTurn: "Y" }, `${name}: the mode file saves the new on's turn`);
    append(w, [message("Y", "autopilot on"), callOf("call-y")]);
    assert.equal(await w.run(w.input(COMMAND, { tool_use_id: "call-y", turn_id: "Y" })), undefined, `${name}: the gate admits the next merge`);
    rmSync(GH_LOG, { force: true });
  }
});

test("PermissionRequest: an old permit, or a permit of another call, allows nothing", async () => {
  clearPermits();
  const w = world();
  assert.equal(await w.run(w.ask()), undefined, "no permit");
  assert.equal(await w.run(w.input()), undefined);
  rmSync(GH_LOG);
  const [name] = permits();
  const file = join(permitFolder, name);
  const permit = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...permit, time: Date.now() - 301_000 }));
  assert.equal(await w.run(w.ask()), undefined, "older than 300 s");
  writeFileSync(file, "{not json");
  assert.equal(await w.run(w.ask()), undefined, "a damaged permit");
  // A new admission removes permits older than 300 s.
  const old = Date.now() / 1000 - 400;
  utimesSync(file, old, old);
  const next = world();
  assert.equal(await next.run(next.input(COMMAND, { tool_use_id: CALL })), undefined);
  rmSync(GH_LOG);
  assert.equal(existsSync(file), true, "the same call id names the same file: the gate saved a new permit there");
  assert.deepEqual(permits().length, 1);
});
