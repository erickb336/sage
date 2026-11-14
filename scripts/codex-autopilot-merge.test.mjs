import "./test-env.mjs";
import { appendSyntheticHistory } from "./fixtures/codex-history-padding.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const BUILT = fileURLToPath(new URL("../plugins/sage-codex", import.meta.url));
const RECORDS = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/codex-owner-records.json", import.meta.url)), "utf8"));
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), "sage-autopilot-merge-")));
process.on("exit", () => rmSync(SCRATCH, { recursive: true, force: true }));
const INSTALL_HOME = join(SCRATCH, "install-codex-home");
const PLUGIN = join(INSTALL_HOME, "plugins/cache/sage/sage/0.0.0");
cpSync(BUILT, PLUGIN, { recursive: true });
const MERGE = join(PLUGIN, "skills/sage/merge.mjs");
process.env.HOME = SCRATCH;
process.env.SAGE_HOME = join(SCRATCH, "sage");
delete process.env.CODEX_HOME;

const FAKES = join(SCRATCH, "fakes");
const GH = join(FAKES, "gh");
const GH_LOG = join(SCRATCH, "gh.log");
const MARKER = "FAKE-gh T663";
mkdirSync(FAKES);
const GH_VARIABLES = ["GH_HOST", "GH_REPO", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_CONFIG_DIR", "PATH"];
const TRUSTED_PATH = `${FAKES}:/fixture-trusted/bin`;
writeFileSync(GH, `#!${process.execPath}
const { appendFileSync, readdirSync } = require("node:fs");
const env = Object.fromEntries(${JSON.stringify(GH_VARIABLES)}.map((name) => [name, process.env[name] ?? null]));
appendFileSync(${JSON.stringify(GH_LOG)}, JSON.stringify({ args: process.argv.slice(2), env, cwd: process.cwd(), files: readdirSync(".") }) + "\\n");
console.log(${JSON.stringify(MARKER)});
`, { mode: 0o755 });
const ghCalls = () => (existsSync(GH_LOG) ? readFileSync(GH_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);

test("the fake gh is the one that runs: by its absolute path, and by name with PATH set to the fakes folder only", () => {
  const direct = spawnSync(GH, ["--version"], { encoding: "utf8", env: { PATH: FAKES, HOME: SCRATCH } });
  assert.equal(direct.stdout, `${MARKER}\n`);
  const byName = spawnSync(process.execPath, ["-e", 'require("node:child_process").execFileSync("gh", ["--version"], { stdio: "inherit" })'], { encoding: "utf8", env: { PATH: FAKES, HOME: SCRATCH } });
  assert.equal(byName.stdout, `${MARKER}\n`);
  assert.deepEqual(ghCalls().map((call) => call.args), [["--version"], ["--version"]]);
  rmSync(GH_LOG);
  console.log(`fake gh proven: ${MARKER}`);
});

const { ghFolder, mergeCommand, permitFile } = await import(MERGE);
const SESSION = "019a0000-0000-7000-8000-00000000beef";
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const REPO = "example-owner/example.repo";
function withMode(lines) {
  const template = RECORDS["exec-on"].find((o) => o.payload.role === "user" && o.payload.content?.[0]?.text === "autopilot on");
  const first = lines.findIndex((o) => o.payload.type === "task_started");
  const p = template.payload;
  const turn = "mode-turn";
  const start = { ...lines[first], payload: { ...lines[first].payload, turn_id: turn, turn_attribution: { ...lines[first].payload.turn_attribution, turn_id: turn } } };
  const mode = { ...template, payload: { ...p, content: [{ type: "input_text", text: "sage mode" }],
    internal_chat_message_metadata_passthrough: { ...p.internal_chat_message_metadata_passthrough, turn_id: turn } } };
  return [...lines.slice(0, first), start, mode, ...lines.slice(first)];
}
let homes = 0;
function session(recordName = "exec-on", { mode = true } = {}) {
  const home = join(SCRATCH, `home-${++homes}`);
  const project = join(home, "project");
  mkdirSync(project, { recursive: true });
  const transcript = join(home, "record.jsonl");
  const lines = mode ? withMode(RECORDS[recordName]) : RECORDS[recordName];
  writeFileSync(transcript, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const env = { PATH: FAKES, HOME: home, CODEX_HOME: join(home, "codex"), SAGE_HOME: join(home, "sage"), SAGE_SHARED_HOME: process.env.SAGE_SHARED_HOME,
    CODEX_SESSION_ID: SESSION, CODEX_THREAD_ID: SESSION, CODEX_TOOL_CALL_ID: `call_${homes}`, GH_HOST: "other.example", GH_REPO: "other/repository",
    GH_ENTERPRISE_TOKEN: "fake-enterprise-1", GITHUB_ENTERPRISE_TOKEN: "fake-enterprise-2", GH_CONFIG_DIR: join(home, "gh-config") };
  const turn = RECORDS[recordName].find((line) => line.payload.type === "task_started").payload.turn_id;
  const onTurn = lines.findLast((line) => line.payload.role === "user" && line.payload.content?.at(-1)?.text === "autopilot on")?.payload.internal_chat_message_metadata_passthrough.turn_id;
  const modeFile = join(home, "mode.json");
  writeFileSync(modeFile, JSON.stringify({ sage: true, autopilot: true, given: true, onTurn }), { mode: 0o600 });
  return { env, project, transcript, turn, lines, mode: modeFile };
}
function permit(s, fields = {}) {
  const file = permitFile(s.env.CODEX_TOOL_CALL_ID);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const saved = { session: SESSION, repo: REPO, pr: "41", sha: SHA, command: mergeCommand("41", SHA), cwd: s.project, turn: s.turn, transcript: s.transcript,
    mark: { session: SESSION, source: "startup", lines: 0, pid: 1 }, mode: s.mode, gh: GH, path: TRUSTED_PATH, time: Date.now(), ...fields };
  writeFileSync(file, typeof fields === "string" ? fields : JSON.stringify(saved), { mode: 0o600 });
  return file;
}
function merge(s, args = ["41", SHA], env = {}) {
  const r = spawnSync(process.execPath, [MERGE, ...args], { cwd: s.project, encoding: "utf8", env: { ...s.env, ...env } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const refused = (reason) => ({ status: 1, stdout: "", stderr: `sage: the merge command refuses: ${reason}.\n` });
const AGAIN = "Ask for the merge again";
const SWITCH_ON = 'To merge on autopilot, the owner sends "autopilot on" alone while sage mode is on, then asks for the merge again. Or the owner merges the pull request in GitHub';
function assertRefused(result, reason, label) {
  assert.deepEqual(result, refused(reason), label);
  assert.deepEqual(ghCalls(), [], `${label}: no gh call`);
}

test("with a valid merge permit and the owner's on switch, it runs gh pr merge once, for the permit's repository and the reviewed head only", () => {
  const s = session();
  appendSyntheticHistory(s.transcript);
  const file = permit(s);
  assert.deepEqual(merge(s), { status: 0, stdout: `${MARKER}\n`, stderr: "" });
  const folder = ghFolder();
  assert.equal(folder, join(INSTALL_HOME, "sage", ".hooks", "codex", "merge-folder"));
  assert.deepEqual(ghCalls(), [{ args: ["pr", "merge", "41", "--repo", REPO, "--squash", "--delete-branch", "--match-head-commit", SHA],
    env: { GH_HOST: null, GH_REPO: null, GH_ENTERPRISE_TOKEN: null, GITHUB_ENTERPRISE_TOKEN: null, GH_CONFIG_DIR: s.env.GH_CONFIG_DIR, PATH: TRUSTED_PATH }, cwd: folder, files: [] }]);
  assert.equal(statSync(folder).mode & 0o777, 0o700, "the folder is private");
  assert.equal(existsSync(file), false, "the permit is used up");
  assert.equal(existsSync(file.replace(/\.json$/, ".used.json")), false, "and no used permit stays");
  rmSync(GH_LOG);
  assertRefused(merge(s), `this command has no merge permit, or its merge permit was used. ${AGAIN}`, "the same call again");
});

test("F-T663-21: a permit that the caller writes in a folder of its own SAGE_HOME, CODEX_HOME or HOME is not taken", () => {
  const s = session();
  const forged = join(SCRATCH, `forged-${s.env.CODEX_TOOL_CALL_ID}`);
  const name = `${createHash("sha256").update(s.env.CODEX_TOOL_CALL_ID).digest("hex")}.json`;
  const fields = { session: SESSION, repo: REPO, pr: "41", sha: SHA, command: mergeCommand("41", SHA), cwd: s.project, turn: s.turn, transcript: s.transcript,
    mark: { session: SESSION, source: "startup", lines: 0, pid: 1 }, mode: s.mode, gh: GH, time: Date.now() };
  const { SAGE_HOME, CODEX_HOME, ...rest } = s.env;
  for (const [variable, folder] of [["SAGE_HOME", forged], ["CODEX_HOME", join(forged, "sage")], ["HOME", join(forged, ".codex", "sage")]]) {
    const permits = join(folder, ".hooks", "codex", "permits");
    mkdirSync(permits, { recursive: true, mode: 0o700 });
    writeFileSync(join(permits, name), JSON.stringify(fields), { mode: 0o600 });
    assertRefused(merge({ ...s, env: { ...rest, [variable]: forged } }), `this command has no merge permit, or its merge permit was used. ${AGAIN}`, variable);
    rmSync(forged, { recursive: true, force: true });
  }
});

test("a copy of the plugin that is not installed as a Codex plugin has no permits, so it merges nothing", () => {
  const s = session();
  const r = spawnSync(process.execPath, [join(BUILT, "skills/sage/merge.mjs"), "41", SHA], { cwd: s.project, encoding: "utf8", env: s.env });
  assertRefused({ status: r.status, stdout: r.stdout, stderr: r.stderr }, "this copy of sage is not installed as a Codex plugin, so it has no merge permits. The owner merges the pull request in GitHub", "the repository's build");
});

test("F-T663-24: right before gh, sage mode and autopilot must still be on in the session's mode file", () => {
  for (const [name, content] of [["autopilot off", { sage: true, autopilot: false }], ["sage mode off", { sage: false, autopilot: false, off: "owner" }], ["a damaged mode file", "{not json"], ["no mode file", null]]) {
    const s = session();
    if (content === null) rmSync(s.mode);
    else writeFileSync(s.mode, typeof content === "string" ? content : JSON.stringify(content));
    permit(s);
    assertRefused(merge(s), `autopilot is off in sage's mode file of this session. ${SWITCH_ON}`, name);
  }
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
  const chief = "only the chief merges, not a subagent. Ask the chief to run the merge";
  for (const env of [{ CODEX_THREAD_ID: "019a0000-0000-7000-8000-0000000c41d0" }, { CODEX_THREAD_ID: "" }, { CODEX_SESSION_ID: "", CODEX_THREAD_ID: "" }]) {
    assertRefused(merge(s, undefined, env), chief, JSON.stringify(env));
  }
  const { CODEX_THREAD_ID, CODEX_SESSION_ID, ...noIds } = s.env;
  assertRefused(merge({ ...s, env: noIds }), chief, "no ids");
  assertRefused(merge(s, undefined, { CODEX_TOOL_CALL_ID: "" }), `Codex gave this command no tool call id. ${AGAIN}`, "no call id");
  assertRefused(merge(s, undefined, { CODEX_TOOL_CALL_ID: "call_other" }), `this command has no merge permit, or its merge permit was used. ${AGAIN}`, "another call's id");
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
    [{ time: "now" }, "the merge permit is damaged"],
    [{ mark: undefined }, "the merge permit is damaged"],
    [{ mark: 0 }, "the merge permit is damaged"],
    [{ mark: null }, "the merge permit is damaged"],
    [{ cwd: undefined }, "the merge permit is damaged"],
    [{ mode: undefined }, "the merge permit is damaged"],
    ...[undefined, "gh", "bin/gh", ""].map((gh) => [{ gh }, "the merge permit is damaged"]),
    ...[undefined, "", "bin", `${FAKES}:bin`, `${FAKES}::/usr/bin`, ["/usr/bin"]].map((path) => [{ path }, "the merge permit is damaged"]),
    ...[undefined, "", "example-owner", "github.com/example-owner/example.repo", "--admin/x", "example-owner/-x", "a/b/c", "a b/c", "../x", "x/..", "x/.", "-x/y"].map((repo) => [{ repo }, "the merge permit is damaged"]),
  ];
  for (const [fields, reason] of cases) {
    const s = session();
    const file = permit(s, fields);
    assertRefused(merge(s), `${reason}. ${AGAIN}`, JSON.stringify(fields));
    assert.equal(existsSync(file), false, "a refused permit is used up too");
  }
  const s = session();
  const target = join(s.env.HOME, "elsewhere.json");
  writeFileSync(target, "{}");
  const file = permitFile(s.env.CODEX_TOOL_CALL_ID);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  symlinkSync(target, file);
  assertRefused(merge(s), `the merge permit is damaged. ${AGAIN}`, "a link in place of the permit");
});

test("in Codex's sandbox the permit cannot be taken: it asks the owner to approve the command outside the sandbox", () => {
  const s = session();
  const file = permit(s);
  chmodSync(dirname(file), 0o500);
  try {
    assertRefused(merge(s), "Codex's sandbox does not let it use its merge permit (EACCES). Approve the command to run outside the sandbox", "read-only permits folder");
  } finally { chmodSync(dirname(file), 0o700); }
  assert.equal(existsSync(file), true, "the permit stays for the escalated run");
});

test("right before gh it reads the record again: the owner's switch must be on, and the turn not stopped with Esc", () => {
  const NONE = `the owner has not turned autopilot on, with sage mode on, since this session started. ${SWITCH_ON}`;
  const off = session("tui-on-then-off");
  permit(off);
  assertRefused(merge(off), `the owner's latest autopilot switch is off. ${SWITCH_ON}`, "on, then off");
  const picture = session();
  const on = picture.lines.find((line) => line.payload.role === "user" && line.payload.content?.[0]?.text === "autopilot on");
  const p = on.payload;
  const offWithImage = { ...on, payload: { ...p, content: [{ type: "input_text", text: "autopilot off" }, { type: "input_image", image_url: "data:" }],
    internal_chat_message_metadata_passthrough: { ...p.internal_chat_message_metadata_passthrough, content_item_metadata: [{ provenance: { type: "user" } }, { provenance: { type: "user" } }] } } };
  writeFileSync(picture.transcript, `${readFileSync(picture.transcript, "utf8")}${JSON.stringify(offWithImage)}\n`);
  permit(picture);
  assertRefused(merge(picture), `the owner's latest autopilot switch is off. ${SWITCH_ON}`, "on, then off with an image");
  const real = session("image-off", { mode: false });
  permit(real);
  assertRefused(merge(real), `the owner's latest autopilot switch is off. ${SWITCH_ON}`, "a real record: the off with a local image");
  for (const name of ["queue-on", "hook-text-on", "goal-on", "fork"]) {
    const s = session(name);
    permit(s);
    assertRefused(merge(s), NONE, name);
  }
  const modeOff = session("exec-on", { mode: false });
  permit(modeOff);
  assertRefused(merge(modeOff), NONE, "the on without the mode phrase");
  const resumed = session("exec-on-then-resume");
  permit(resumed, { mark: { session: SESSION, source: "resume", lines: resumed.lines.findIndex((line) => line.payload.type === "task_complete") + 1, pid: 1 } });
  assert.equal(merge(resumed).status, 0, "the owner's on after the resume");
  rmSync(GH_LOG);
  const marked = session();
  permit(marked, { mark: { lines: marked.lines.length } });
  assertRefused(merge(marked), NONE, "a mark after the on");
  const outside = session();
  permit(outside, { mark: { lines: outside.lines.length + 1 } });
  assertRefused(merge(outside), "sage's note of this session start does not match Codex's record of this session. Resume the session, then the owner turns autopilot on again. Or the owner merges the pull request in GitHub", "a mark past the record");
  const missing = session();
  permit(missing, { transcript: join(SCRATCH, "no-record.jsonl") });
  assertRefused(merge(missing), "sage cannot read Codex's record of this session. Ask for the merge again. If it refuses again, the owner merges the pull request in GitHub (ENOENT)", "no record");
  for (const cli of ["0.168.0", "0.169.0-alpha.8", "1.0.0"]) {
    const newer = session();
    const text = readFileSync(newer.transcript, "utf8");
    writeFileSync(newer.transcript, text.replace('"cli_version":"0.164.0"', `"cli_version":"${cli}"`));
    assert.notEqual(readFileSync(newer.transcript, "utf8"), text, cli);
    permit(newer);
    assert.deepEqual(merge(newer), { status: 0, stdout: `${MARKER}\n`, stderr: "" }, cli);
    assert.equal(ghCalls().length, 1, cli);
    rmSync(GH_LOG);
  }
  const version = session();
  writeFileSync(version.transcript, readFileSync(version.transcript, "utf8").replace('"cli_version":"0.164.0"', '"cli_version":"0.163.0"'));
  permit(version);
  assertRefused(merge(version), "this session runs Codex 0.163.0, and sage reads the records of Codex 0.164 and later only. Start a new session with Codex 0.164 or later, or the owner merges the pull request in GitHub", "an older Codex");
  const form = session();
  writeFileSync(form.transcript, `${readFileSync(form.transcript, "utf8")}{not json\n`);
  permit(form);
  assertRefused(merge(form), `sage does not know the form of Codex's record of this session. The owner merges the pull request in GitHub (line ${form.lines.length + 1} is not JSON)`, "a record of an unknown form");
  const esc = session("tui-on-then-esc");
  permit(esc);
  assertRefused(merge(esc), "the owner stopped the turn of this merge with Esc. Ask for the merge again only if the owner wants it", "turn_aborted for the permit's turn");
  const other = session("tui-on-then-esc");
  permit(other, { turn: "019a0000-0000-7000-8000-0000000a0a0a" });
  assert.equal(merge(other).status, 0, "turn_aborted of another turn stops nothing");
  rmSync(GH_LOG);
});

test("F-T677-13, F-T677-15: right before gh, an on that joins a running turn counts for nothing; one that starts its turn counts", () => {
  const joined = session();
  const at = joined.lines.findIndex((o) => o.payload.role === "user" && o.payload.content?.[0]?.text === "autopilot on");
  const first = { ...joined.lines[at], payload: { ...joined.lines[at].payload, content: [{ type: "input_text", text: "merge pull request 41" }] } };
  writeFileSync(joined.transcript, [...joined.lines.slice(0, at), first, ...joined.lines.slice(at)].map((line) => JSON.stringify(line)).join("\n") + "\n");
  permit(joined);
  assertRefused(merge(joined), `the owner has not turned autopilot on, with sage mode on, since this session started. ${SWITCH_ON}`, "an on that joins a running turn");
  const started = session();
  permit(started);
  assert.deepEqual(merge(started), { status: 0, stdout: `${MARKER}\n`, stderr: "" }, "the same on, starting its turn");
  rmSync(GH_LOG);
});

test("F-T677-33: right before gh, the record's latest on must be the on whose turn the mode file saved", () => {
  const s = session();
  writeFileSync(s.mode, JSON.stringify({ sage: true, autopilot: true, given: true, onTurn: "019a0000-0000-7000-8000-00000000a0a1" }));
  permit(s);
  assertRefused(merge(s), `the owner's latest "autopilot on" did not count, because only an on that is the whole message and starts a new turn counts. ${SWITCH_ON}`, "the mode file's on is another turn's");
  const old = session();
  writeFileSync(old.mode, JSON.stringify({ sage: true, autopilot: true, given: true }));
  permit(old);
  assert.equal(merge(old).status, 1, "a mode file with no on turn (saved before this rule)");
  assert.deepEqual(ghCalls(), []);
});

test("a failed gh gives its cause and a next step, and the permit is still used up", () => {
  const s = session();
  const file = permit(s);
  const failing = join(SCRATCH, "failing");
  mkdirSync(failing);
  writeFileSync(join(failing, "gh"), `#!${process.execPath}\nprocess.exit(4);\n`, { mode: 0o755 });
  rmSync(file);
  permit(s, { gh: join(failing, "gh") });
  assert.deepEqual(merge(s), { status: 4, stdout: "",
    stderr: "sage: gh pr merge failed (exit status 4): the head may have moved, the pull request may not be ready to merge, or gh may not be logged in. Check the pull request in GitHub, then ask for the merge again.\n" });
  assert.equal(existsSync(file), false);
  const none = session();
  const missing = join(SCRATCH, "no-gh", "gh");
  permit(none, { gh: missing });
  assert.deepEqual(merge(none), { status: 1, stdout: "",
    stderr: `sage: gh pr merge could not start (ENOENT): gh may not be installed at ${missing}, or sage cannot use its folder ${ghFolder()}. Check the pull request in GitHub, then ask for the merge again.\n` });
  assert.deepEqual(ghCalls(), [], "the gh on PATH never runs: only the permit's gh file");
});
