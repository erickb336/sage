import "./test-env.mjs";
import { appendSyntheticHistory } from "./fixtures/codex-history-padding.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
const { stateKey } = await import(join(PLUGIN, "hooks/hook-state.mjs"));
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
  assert.equal(spawnSync(join(FAKES, "gh"), ["--version"], { encoding: "utf8", env: { PATH: FAKES, HOME: SCRATCH } }).stdout, "FAKE-gh T677\n");
  assert.equal(spawnSync(join(ARG0, "apply_patch"), ["--version"], { encoding: "utf8", env: { HOME: SCRATCH } }).stdout, "codex-cli 0.164.0\n");
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
function withMode(lines) {
  const template = lines.find((o) => o.payload.role === "user" && o.payload.content?.[0]?.text === "autopilot on");
  const first = lines.findIndex((o) => o.payload.type === "task_started");
  const turn = "mode-turn";
  const start = { ...lines[first], payload: { ...lines[first].payload, turn_id: turn, turn_attribution: { ...lines[first].payload.turn_attribution, turn_id: turn } } };
  const mode = { ...template, payload: { ...template.payload, content: [{ type: "input_text", text: "sage mode" }], internal_chat_message_metadata_passthrough: { ...template.payload.internal_chat_message_metadata_passthrough, turn_id: turn } } };
  return [...lines.slice(0, first), start, mode, ...lines.slice(first)];
}
let worlds = 0;
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
  const deps = { env, ppid: PPID, temporary: [], check: async (merge, cwd, checkEnv) => (checks.push({ ...merge, cwd }), paths.push(checkEnv.PATH), { ok: true }) };
  const input = (command = COMMAND, extra = {}) => ({ hook_event_name: "PreToolUse", session_id: SESSION, turn_id: TURN, transcript_path: transcript, cwd: project,
    model: "m", permission_mode: "default", tool_name: "Bash", tool_use_id: CALL, tool_input: { command }, ...extra });
  const ask = (command = COMMAND, extra = {}) => ({ hook_event_name: "PermissionRequest", session_id: SESSION, turn_id: TURN, transcript_path: transcript, cwd: project,
    model: "m", permission_mode: "default", tool_name: "Bash", tool_input: { command, description: "merge" }, ...extra });
  return { home, project, env, transcript, modeFile, checks, paths, deps, input, ask, run: (i, d = {}) => gate(i, { ...deps, ...d }) };
}
const denied = (out) => (out?.hookSpecificOutput?.permissionDecision === "deny" ? out.hookSpecificOutput.permissionDecisionReason : out);
const permits = () => (permitFolder && existsSync(permitFolder) ? readdirSync(permitFolder) : []);
const clearPermits = () => permitFolder && rmSync(permitFolder, { recursive: true, force: true });
const ALLOW = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
const READY = "Report the pull request as ready: the owner merges it in GitHub";
const OFF = 'sage: autopilot is off, so the owner merges. Report the pull request as ready. To turn autopilot on while sage mode is on, the owner sends "autopilot on" alone, as a new message while Codex is idle (press Esc first if Codex is busy)';

test("T1069: long-history admission keeps the final reread for a later off or cancellation", async () => {
  for (const stopped of ["off", "cancel"]) {
    clearPermits();
    const w = world();
    appendSyntheticHistory(w.transcript);
    assert.equal(await w.run(w.input()), undefined);
    assert.equal(w.checks.length, 1);
    rmSync(GH_LOG, { force: true });
    const entry = stopped === "cancel" ? { type: "event_msg", payload: { type: "turn_aborted", turn_id: TURN } }
      : { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "autopilot off" }] } };
    appendFileSync(w.transcript, JSON.stringify(entry) + "\n");
    const result = spawnSync(process.execPath, [MERGE, "41", SHA], { cwd: w.project, encoding: "utf8", env: { ...w.env, CODEX_SESSION_ID: SESSION, CODEX_THREAD_ID: SESSION, CODEX_TOOL_CALL_ID: CALL } });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, stopped === "off" ? /latest autopilot switch is off/ : /stopped the turn/);
    assert.deepEqual(ghCalls(), []);
  }
});

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
  try {
    for (const version of ["0.163.0", "0.163.9-alpha.1", "0.99.0"]) {
      clearPermits();
      writeFileSync(VERSION, `${version}\n`);
      const w = world();
      assert.equal(denied(await w.run(w.input())), `sage: this session runs Codex ${version}, and autopilot merges only in Codex 0.164 and later. ${READY}`, version);
      assert.deepEqual(permits(), []);
    }
    for (const version of ["0.166.0-alpha.6", "0.167.0", "0.168.0", "0.168.0-alpha.1", "0.169.0", "0.169.0-alpha.8", "0.170.2", "1.0.0"]) {
      writeFileSync(VERSION, `${version}\n`);
      clearPermits();
      const resumed = world();
      assert.equal(await resumed.run(resumed.input()), undefined, version);
      assert.equal(permits().length, 1, version);
      rmSync(GH_LOG);
    }
    for (const version of ["0.168.0", "0.169.0", "1.0.0"]) {
      writeFileSync(VERSION, `${version}\n`);
      clearPermits();
      const [meta, ...rest] = withMode(RECORDS["exec-on"]);
      const fresh = world({ lines: [{ ...meta, payload: { ...meta.payload, cli_version: version } }, ...rest] });
      assert.equal(await fresh.run(fresh.input()), undefined, `a new session of ${version}`);
      assert.equal(permits().length, 1, version);
      rmSync(GH_LOG);
    }
    writeFileSync(VERSION, "0.167.0-alpha.3.2\n");
    clearPermits();
    const app = RECORDS["app-steer"];
    const offTurn = app.findLast((o) => o.payload.type === "task_started");
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
  for (const where of ["project", "tmp"]) {
    const w = world();
    const dir = where === "project" ? join(w.project, "bin") : w.env.TMPDIR;
    mkdirSync(dir, { recursive: true });
    cpSync(join(FAKES, "gh"), join(dir, "gh"));
    chmodSync(join(dir, "gh"), 0o755);
    assert.equal(denied(await w.run(w.input(), { env: { ...w.env, PATH: `${ARG0}:${dir}` } })), `sage: sage found no gh outside the folders that Codex's sandbox can write, so autopilot merges nothing. ${READY}`, where);
  }
  const first = world();
  mkdirSync(join(first.project, "bin"));
  writeFileSync(join(first.project, "bin", "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.equal(await first.run(first.input(), { env: { ...first.env, PATH: `${ARG0}:${join(first.project, "bin")}:relative/bin:${FAKES}` } }), undefined);
  assert.equal(JSON.parse(readFileSync(join(permitFolder, permits()[0]), "utf8")).gh, join(FAKES, "gh"));
  assert.deepEqual(first.paths, [`${ARG0}:${FAKES}`], "the merge check runs with the trusted PATH too");
  clearPermits();
  rmSync(GH_LOG);
  const temporary = world();
  assert.equal(denied(await temporary.run(temporary.input(), { temporary: [SCRATCH] })), `sage: sage cannot tell which Codex runs this session, and autopilot merges only in Codex 0.164 and later. ${READY}`);
  assert.deepEqual(permits(), []);
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
const runMerge = (w, env) => spawnSync(process.execPath, [MERGE, "41", SHA], { cwd: w.project, encoding: "utf8", env: { HOME: w.home, CODEX_SESSION_ID: SESSION, CODEX_THREAD_ID: SESSION, CODEX_TOOL_CALL_ID: CALL, ...env } });

test("F-T677-1: gh runs with the name gh, so a shared launcher that picks its tool by name (snap, mise) runs gh", async () => {
  clearPermits();
  const w = world();
  const gh = loggingGh("launcher");
  assert.equal(spawnSync(join(gh.dir, "gh"), ["pr", "x"], { encoding: "utf8", env: { ...gh.env, PATH: gh.dir, HOME: SCRATCH } }).stdout, "FAKE-gh T677 launcher\n", "the launcher runs gh by the link's name");
  assert.match(spawnSync(realpathSync(join(gh.dir, "gh")), ["pr", "x"], { encoding: "utf8", env: { ...gh.env, HOME: SCRATCH } }).stderr, /^launcher: no tool named node/, "by its real file's name it refuses");
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
  clearPermits();
  const w = world();
  assert.equal(await w.run(w.input()), undefined);
  rmSync(GH_LOG);
  const ask = (description) => w.ask(COMMAND, { tool_input: description === undefined ? { command: COMMAND } : { command: COMMAND, description } });
  for (const description of ["network-access https://api.github.com:443", "network-access https://example.com:443", "network-access http://api.github.com:80", "network-access https://api.github.com.example.com:443",
    "network-access socks5-tcp://api.github.com:443", "network-access https://api.github.com:443 ", 7, null]) {
    assert.equal(await w.run(ask(description)), undefined, String(description));
  }
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
      const out = answer({ hook_event_name: "UserPromptSubmit", session_id: SESSION, turn_id: "t-off", transcript_path: w.transcript, cwd: w.project, prompt: "autopilot off" }, w.env);
      assert.equal(out?.decision, undefined, "the off is never blocked");
      assert.deepEqual(JSON.parse(readFileSync(w.modeFile, "utf8")).autopilot, false);
    } else {
      const image = RECORDS["image-off"].filter((o) => o.payload.role === "user").at(-1);
      const off = kind === "image" ? image : { ...image, payload: { ...image.payload, content: [{ type: "input_text", text: "autopilot off" }], internal_chat_message_metadata_passthrough: { ...image.payload.internal_chat_message_metadata_passthrough, content_item_metadata: [{ provenance: { type: "user" } }] } } };
      writeFileSync(w.transcript, `${readFileSync(w.transcript, "utf8")}${JSON.stringify(off)}\n`);
    }
    const r = spawnSync(process.execPath, [MERGE, "41", SHA], { cwd: w.project, encoding: "utf8", env: { PATH: FAKES, HOME: w.home, CODEX_SESSION_ID: SESSION, CODEX_THREAD_ID: SESSION, CODEX_TOOL_CALL_ID: CALL } });
    assert.equal(r.status, 1, kind);
    assert.match(r.stderr, kind === "saved" ? /autopilot is off in sage's mode file of this session/ : /the owner's latest autopilot switch is off/, kind);
    assert.deepEqual(ghCalls(), [], `${kind}: no gh`);
  }
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
  clearPermits();
  const w = world({ mode: { sage: true, autopilot: false, given: true } });
  for (const thread of ["subagent", "fork's subagent", "side"]) for (const phrase of ["sage mode", "autopilot on"]) assert.equal(prompt(w, phrase, thread)?.systemMessage, undefined, `${phrase} from a ${thread}`);
  assert.deepEqual(JSON.parse(readFileSync(w.modeFile, "utf8")), { sage: true, autopilot: false, given: true });
  assert.equal(denied(await w.run(w.input())), OFF);
  assert.deepEqual([w.checks, permits(), ghCalls().filter((call) => call.includes("merge"))], [[], [], []]);
  rmSync(GH_LOG, { force: true });
});

test("F-T677-33, F-T677-18: after an off from a fork, an on that joins the main thread's running turn merges nothing; only a new on that starts its own turn turns merges on again", async () => {
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
    if (!early) append(w, [startOf("X"), message("X", "WAIT")]);
    const out = prompt(w, SESSION, "X", "autopilot on", w.transcript);
    if (early) append(w, [startOf("X"), message("X", "WAIT")]);
    append(w, [message("X", "autopilot on"), callOf("call-x")]);
    assert.equal(denied(await w.run(w.input(COMMAND, { tool_use_id: "call-x", turn_id: "X" }))), refusal, `${name}: the gate refuses the merge`);
    assert.deepEqual([w.checks.length, permits()], [1, []], `${name}: no merge check after the off, and no permit`);
    assert.equal(out?.hookSpecificOutput?.additionalContext.startsWith('sage: this "autopilot on" did not count') ? out.hookSpecificOutput.additionalContext : undefined, said, `${name}: the chief's note`);
    append(w, [startOf("Y")]);
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
  const old = Date.now() / 1000 - 400;
  utimesSync(file, old, old);
  const next = world();
  assert.equal(await next.run(next.input(COMMAND, { tool_use_id: CALL })), undefined);
  rmSync(GH_LOG);
  assert.equal(existsSync(file), true, "the same call id names the same file: the gate saved a new permit there");
  assert.deepEqual(permits().length, 1);
});
