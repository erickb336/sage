import "../../test-env.mjs"; // first: no variable of the developer's shell changes a result
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The Codex merge command of autopilot (T663), run as Codex runs a shell command: one node process with Codex's
// CODEX_SESSION_ID, CODEX_THREAD_ID and CODEX_TOOL_CALL_ID. gh is a fake: PATH holds only the fakes folder, and node
// runs by its absolute path, so no real gh can run. The fake is proven first, by its absolute path and by its name.
const PLUGIN = fileURLToPath(new URL("../../../plugins/sage-codex", import.meta.url));
const MERGE = join(PLUGIN, "skills/sage/merge.mjs");
const RECORDS = JSON.parse(readFileSync(fileURLToPath(new URL("./owner-records.json", import.meta.url)), "utf8"));
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), "sage-autopilot-merge-")));
process.on("exit", () => rmSync(SCRATCH, { recursive: true, force: true }));
// The gate's import and calls read the home and the sage root: both are scratch for this whole file.
process.env.HOME = SCRATCH;
process.env.SAGE_HOME = join(SCRATCH, "sage");
delete process.env.CODEX_HOME;

const FAKES = join(SCRATCH, "fakes");
const GH = join(FAKES, "gh");
const GH_LOG = join(SCRATCH, "gh.log");
const MARKER = "FAKE-gh T663";
mkdirSync(FAKES);
writeFileSync(GH, `#!${process.execPath}
const { appendFileSync } = require("node:fs");
appendFileSync(${JSON.stringify(GH_LOG)}, JSON.stringify({ args: process.argv.slice(2), GH_HOST: process.env.GH_HOST ?? null, GH_REPO: process.env.GH_REPO ?? null, cwd: process.cwd() }) + "\\n");
console.log(${JSON.stringify(MARKER)});
`, { mode: 0o755 });
const ghCalls = () => (existsSync(GH_LOG) ? readFileSync(GH_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);

test("the fake gh is the one that runs: by its absolute path, and by name with PATH set to the fakes folder only", () => {
  const direct = spawnSync(GH, ["--version"], { encoding: "utf8", env: { PATH: FAKES } });
  assert.equal(direct.stdout, `${MARKER}\n`);
  const byName = spawnSync(process.execPath, ["-e", 'require("node:child_process").execFileSync("gh", ["--version"], { stdio: "inherit" })'], { encoding: "utf8", env: { PATH: FAKES } });
  assert.equal(byName.stdout, `${MARKER}\n`);
  assert.deepEqual(ghCalls().map((call) => call.args), [["--version"], ["--version"]]);
  rmSync(GH_LOG);
  console.log(`fake gh proven: ${MARKER}`);
});

const { mergeCommand, permitFile } = await import(MERGE);
const { gate } = await import(join(PLUGIN, "hooks/gate-hook.mjs"));
const SESSION = "019a0000-0000-7000-8000-00000000beef";
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
let homes = 0;
/** A scratch home, the session's record (one of the proof records) and the environment that Codex gives the command. */
function session(recordName = "exec-on") {
  const home = join(SCRATCH, `home-${++homes}`);
  const project = join(home, "project");
  mkdirSync(project, { recursive: true });
  const transcript = join(home, "record.jsonl");
  writeFileSync(transcript, RECORDS[recordName].map((line) => JSON.stringify(line)).join("\n") + "\n");
  const env = { PATH: FAKES, HOME: home, CODEX_HOME: join(home, "codex"), SAGE_HOME: join(home, "sage"), SAGE_SHARED_HOME: process.env.SAGE_SHARED_HOME,
    CODEX_SESSION_ID: SESSION, CODEX_THREAD_ID: SESSION, CODEX_TOOL_CALL_ID: `call_${homes}`, GH_HOST: "other.example", GH_REPO: "other/repository" };
  const turn = RECORDS[recordName].find((line) => line.payload.type === "task_started").payload.turn_id;
  return { env, project, transcript, turn };
}
/** Save a merge permit for the call, as the gate will (T677). No hook of this pull request saves one. */
function permit(s, fields = {}) {
  const file = permitFile(s.env, s.env.CODEX_TOOL_CALL_ID);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const saved = { session: SESSION, pr: "41", sha: SHA, command: mergeCommand("41", SHA), turn: s.turn, transcript: s.transcript, from: 0, time: Date.now(), ...fields };
  writeFileSync(file, typeof fields === "string" ? fields : JSON.stringify(saved), { mode: 0o600 });
  return file;
}
function merge(s, args = ["41", SHA], env = {}) {
  const r = spawnSync(process.execPath, [MERGE, ...args], { cwd: s.project, encoding: "utf8", env: { ...s.env, ...env } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const refused = (reason) => ({ status: 1, stdout: "", stderr: `sage: the merge command refuses: ${reason}.\n` });
/** Each refusal runs no gh. */
function assertRefused(result, reason, label) {
  assert.deepEqual(result, refused(reason), label);
  assert.deepEqual(ghCalls(), [], `${label}: no gh call`);
}

test("with a valid merge permit and the owner's on switch, it runs gh pr merge once, for the reviewed head only", () => {
  const s = session();
  const file = permit(s);
  assert.deepEqual(merge(s), { status: 0, stdout: `${MARKER}\n`, stderr: "" });
  assert.deepEqual(ghCalls(), [{ args: ["pr", "merge", "41", "--squash", "--delete-branch", "--match-head-commit", SHA], GH_HOST: null, GH_REPO: null, cwd: s.project }]);
  assert.equal(existsSync(file), false, "the permit is used up");
  rmSync(GH_LOG);
  assertRefused(merge(s), "this tool call has no merge permit, or its permit was used", "the same call again");
});

test("the arguments are exactly a pull request number and a 40-character head SHA", () => {
  const s = session();
  permit(s);
  for (const args of [[], ["41"], ["41", SHA, "--admin"], ["041", SHA], ["0", SHA], ["abc", SHA], ["41", SHA.slice(1)], ["41", SHA.toUpperCase()], ["41", `${SHA} `], [SHA, "41"], ["--", "41", SHA]]) {
    assertRefused(merge(s, args), "give exactly two arguments: the pull request number and its 40-character head SHA", JSON.stringify(args));
  }
});

test("only the root thread merges, and only with Codex's tool call id; a refused child leaves the permit", () => {
  const s = session();
  const file = permit(s);
  for (const env of [{ CODEX_THREAD_ID: "019a0000-0000-7000-8000-0000000c41d0" }, { CODEX_THREAD_ID: "" }, { CODEX_SESSION_ID: "", CODEX_THREAD_ID: "" }]) {
    assertRefused(merge(s, undefined, env), "only the root thread of the session (the chief) merges", JSON.stringify(env));
  }
  const { CODEX_THREAD_ID, CODEX_SESSION_ID, ...noIds } = s.env;
  assertRefused(merge({ ...s, env: noIds }), "only the root thread of the session (the chief) merges", "no ids");
  assertRefused(merge(s, undefined, { CODEX_TOOL_CALL_ID: "" }), "Codex gave this command no tool call id", "no call id");
  assertRefused(merge(s, undefined, { CODEX_TOOL_CALL_ID: "call_other" }), "this tool call has no merge permit, or its permit was used", "another call's id");
  assert.equal(existsSync(file), true);
  assert.equal(merge(s).status, 0, "the root thread's own call still merges");
  rmSync(GH_LOG);
});

test("a merge permit that is damaged, old, or for another session, pull request, SHA or command refuses", () => {
  const cases = [
    [{ time: Date.now() - 301_000 }, "the merge permit is not from the last 300 s"],
    [{ time: Date.now() + 60_000 }, "the merge permit is not from the last 300 s"],
    [{ session: "019a0000-0000-7000-8000-000000000bad" }, "the merge permit is for another session"],
    [{ pr: "42" }, "the merge permit is for another pull request"],
    [{ sha: "b".repeat(40) }, "the merge permit is for another head SHA"],
    [{ command: `gh pr merge 41 --squash --delete-branch --match-head-commit ${SHA}` }, "the merge permit is for another command"],
    [{ command: `${mergeCommand("41", SHA)} && echo` }, "the merge permit is for another command"],
    ["{", "the merge permit is damaged"],
    ["null", "the merge permit is damaged"],
    [{ pr: 41 }, "the merge permit is damaged"],
    [{ turn: undefined }, "the merge permit is damaged"],
    [{ from: "0" }, "the merge permit is damaged"],
    [{ time: "now" }, "the merge permit is damaged"],
  ];
  for (const [fields, reason] of cases) {
    const s = session();
    const file = permit(s, fields);
    assertRefused(merge(s), reason, JSON.stringify(fields));
    assert.equal(existsSync(file), false, "a refused permit is used up too");
  }
  const s = session();
  const target = join(s.env.HOME, "elsewhere.json");
  writeFileSync(target, "{}");
  const file = permitFile(s.env, s.env.CODEX_TOOL_CALL_ID);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  symlinkSync(target, file);
  assertRefused(merge(s), "the merge permit is damaged", "a link in place of the permit");
});

test("in Codex's sandbox the permit cannot be taken: it asks to run it escalated", () => {
  const s = session();
  const file = permit(s);
  chmodSync(dirname(file), 0o500);
  try {
    assertRefused(merge(s), "the sandbox does not let it take its merge permit (EACCES): run it escalated", "read-only permits folder");
  } finally { chmodSync(dirname(file), 0o700); }
  assert.equal(existsSync(file), true, "the permit stays for the escalated run");
});

test("right before gh it reads the record again: the owner's latest switch must be on, and the turn not stopped with Esc", () => {
  const off = session("tui-on-then-off");
  permit(off);
  assertRefused(merge(off), "the owner's latest autopilot switch is off", "on, then off");
  for (const name of ["queue-on", "hook-text-on", "goal-on", "fork"]) {
    const s = session(name);
    permit(s);
    assertRefused(merge(s), "the owner has not turned autopilot on since this session started", name);
  }
  const resumed = session("exec-on-then-resume");
  permit(resumed, { from: RECORDS["exec-on-then-resume"].findIndex((line) => line.payload.type === "task_complete") + 1, transcript: resumed.transcript });
  assert.equal(merge(resumed).status, 0, "the owner's on after the resume");
  rmSync(GH_LOG);
  const marked = session();
  permit(marked, { from: RECORDS["exec-on"].length });
  assertRefused(merge(marked), "the owner has not turned autopilot on since this session started", "a boundary after the on");
  const outside = session();
  permit(outside, { from: RECORDS["exec-on"].length + 1 });
  assertRefused(merge(outside), "the start mark does not fit the record", "a boundary past the record");
  const missing = session();
  permit(missing, { transcript: join(SCRATCH, "no-record.jsonl") });
  assertRefused(merge(missing), "the record cannot be read (ENOENT)", "no record");
  const version = session();
  writeFileSync(version.transcript, readFileSync(version.transcript, "utf8").replace('"cli_version":"0.164.0"', '"cli_version":"0.167.0"'));
  permit(version);
  assertRefused(merge(version), "the record is from Codex 0.167.0, and sage reads only the records of Codex 0.164 to 0.166", "a newer Codex");
  const esc = session("tui-on-then-esc");
  permit(esc);
  assertRefused(merge(esc), "the owner stopped the turn of this merge (Esc)", "turn_aborted for the permit's turn");
  const other = session("tui-on-then-esc");
  permit(other, { turn: "019a0000-0000-7000-8000-0000000a0a0a" });
  assert.equal(merge(other).status, 0, "turn_aborted of another turn stops nothing");
  rmSync(GH_LOG);
});

test("a failed gh gives its status, and the permit is still used up", () => {
  const s = session();
  const file = permit(s);
  const failing = join(SCRATCH, "failing");
  mkdirSync(failing);
  writeFileSync(join(failing, "gh"), `#!${process.execPath}\nprocess.exit(4);\n`, { mode: 0o755 });
  assert.deepEqual(merge(s, undefined, { PATH: failing }), { status: 4, stdout: "", stderr: "sage: gh pr merge failed (4).\n" });
  assert.equal(existsSync(file), false);
});

test("on this head no path merges: the gate refuses every gh merge, and the merge command finds no merge permit", async () => {
  const s = session();
  const pre = (command) => ({ hook_event_name: "PreToolUse", session_id: SESSION, turn_id: s.turn, transcript_path: s.transcript, cwd: s.project, model: "m", permission_mode: "default", tool_name: "Bash", tool_use_id: s.env.CODEX_TOOL_CALL_ID, tool_input: { command } });
  // The mode reader and the merge check say yes, as they will when autopilot is on and the pull request is ready.
  const deps = { mode: () => ({ sage: true, autopilot: true }), check: async () => ({ ok: true }), env: s.env };
  for (const command of [`gh pr merge 41 --squash --delete-branch --match-head-commit ${SHA}`, "gh pr merge 41 --squash", `cd ${s.project} && gh pr merge 41 --squash`]) {
    const out = await gate(pre(command), deps);
    assert.equal(out?.hookSpecificOutput?.permissionDecision, "deny", command);
    assert.equal(out.hookSpecificOutput.permissionDecisionReason, "sage: automatic merging is unavailable in Codex. Sage prepares the checks; the owner merges directly in GitHub", command);
    assert.equal(await gate({ ...pre(command), hook_event_name: "PermissionRequest", tool_input: { command, description: "merge" } }, deps), undefined, `${command}: no automatic approval`);
  }
  assertRefused(merge(s), "this tool call has no merge permit, or its permit was used", "the merge command without a permit");
});
