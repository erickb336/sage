import "../../test-env.mjs"; // first: no variable of the developer's shell changes a result
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
const BUILT = fileURLToPath(new URL("../../../plugins/sage-codex", import.meta.url));
const RECORDS = JSON.parse(readFileSync(fileURLToPath(new URL("./owner-records.json", import.meta.url)), "utf8"));
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
/** The record with the owner's mode phrase (sage mode on) in its first turn, before the on phrase and the call. */
function withMode(lines) {
  const template = lines.find((o) => o.payload.role === "user" && o.payload.content?.[0]?.text === "autopilot on");
  const first = lines.findIndex((o) => o.payload.type === "task_started");
  const mode = { ...template, payload: { ...template.payload, content: [{ type: "input_text", text: "sage mode" }] } };
  return [...lines.slice(0, first + 1), mode, ...lines.slice(first + 1)];
}
let worlds = 0;
/** A scratch world: the hook's environment, the record, the mode file with sage mode and autopilot on, and the start mark. */
function world({ lines = withMode(RECORDS["exec-on"]), mode = { sage: true, autopilot: true, given: true }, mark = { lines: 0, pid: PPID } } = {}) {
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

test("admission: with the mode file on, the owner's on, the call in the record and a passing merge check, the gate saves one permit, the escalation is allowed, and the merge command merges", async () => {
  clearPermits();
  const w = world();
  assert.equal(await w.run(w.input()), undefined, "the gate admits the call");
  assert.deepEqual(w.checks, [{ pr: "41", sha: SHA, cwd: w.project }], "checkMerge ran once, unchanged, for this pull request and head");
  assert.equal(permits().length, 1);
  const permit = JSON.parse(readFileSync(join(permitFolder, permits()[0]), "utf8"));
  assert.deepEqual({ ...permit, time: typeof permit.time }, { session: SESSION, repo: "example-owner/example.repo", pr: "41", sha: SHA, command: COMMAND, cwd: w.project, turn: TURN,
    transcript: w.transcript, mark: { session: SESSION, source: "startup", lines: 0, pid: PPID }, mode: w.modeFile, gh: join(FAKES, "gh"), time: "number" });
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
  const OFF = 'sage: autopilot is off, so the owner merges. Report the pull request as ready. The owner turns autopilot on with the message "autopilot on", alone, while sage mode is on';
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
    `cd ${w.project} && ${COMMAND}`, `bash -c '${COMMAND}'`, `"${process.execPath}" "${script}" 041 ${SHA}`, `"${process.execPath}" ./merge.mjs 41 ${SHA}`, `node $SCRIPT 41 ${SHA} # merge.mjs`,
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
  for (const [version, reason] of [["0.167.0", "sage: this session runs Codex 0.167.0"], ["0.170.2", "sage: this session runs Codex 0.170.2"], ["1.0.0", "sage: this session runs Codex 1.0.0"]]) {
    clearPermits();
    writeFileSync(VERSION, `${version}\n`);
    const w = world();
    assert.equal(denied(await w.run(w.input())), `${reason}, and autopilot merges only in Codex 0.164 to 0.166. ${READY}`, version);
    assert.deepEqual(permits(), []);
  }
  writeFileSync(VERSION, "0.166.0-alpha.6\n");
  clearPermits();
  const desktop = world();
  assert.equal(await desktop.run(desktop.input()), undefined, "the desktop app's Codex");
  rmSync(GH_LOG);
  writeFileSync(VERSION, "0.164.0\n");
  clearPermits();
  const none = world();
  assert.equal(denied(await none.run(none.input(), { env: { ...none.env, PATH: FAKES } })), `sage: sage cannot tell which Codex runs this session, and autopilot merges only in Codex 0.164 to 0.166. ${READY}`, "no codex-arg0 folder");
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
  assert.equal(denied(await temporary.run(temporary.input(), { temporary: [SCRATCH] })), `sage: sage cannot tell which Codex runs this session, and autopilot merges only in Codex 0.164 to 0.166. ${READY}`);
  assert.deepEqual(permits(), []);
  // node: the gate's own node, which must be outside those folders too (here the temporary folder names node's folder).
  const node = world();
  assert.match(denied(await node.run(node.input(), { env: { ...node.env, TMPDIR: dirname(process.execPath) } })) ?? "", /^sage: node runs from a folder that Codex's sandbox can write/);
  assert.deepEqual(permits(), []);
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
