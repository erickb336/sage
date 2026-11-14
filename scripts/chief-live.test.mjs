import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as claude from "../plugins/sage/skills/sage/sage.mjs";
import { tool as codex } from "../plugins/sage-codex/skills/sage/sage.mjs";
import { boardChiefs, chiefBeat } from "../plugins/sage/core/chief-live.mjs";
import { chiefsWhole } from "../plugins/sage/core/chiefs.mjs";
import { readBoardSources } from "../plugins/sage/core/board-reader.mjs";
import { buildBoardModel } from "../plugins/sage/core/board-model.mjs";
import { boardOverview } from "../plugins/sage/core/board-overview.mjs";

const at = (path) => fileURLToPath(new URL(path, import.meta.url));
const CLAUDE_HOOK = at("../plugins/sage/hooks/sage-hook.mjs"), DISPATCH = pathToFileURL(at("../plugins/sage-codex/hooks/dispatch.mjs")).href;
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const MINUTE = 60_000;

function scratch(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-chief-live-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const fakes = join(base, "fakes");
  mkdirSync(fakes);
  writeFileSync(join(fakes, "gh"), "#!/bin/sh\necho fake-gh >&2\nexit 1\n");
  chmodSync(join(fakes, "gh"), 0o755);
  const env = { PATH: `${fakes}:/usr/bin:/bin`, HOME: join(base, "home"), CLAUDE_CONFIG_DIR: join(base, "claude"), CODEX_HOME: join(base, "codex"), SAGE_SHARED_HOME: join(base, "shared"),
    SAGE_HOOKS_STATE: join(base, "hook-state"), SAGE_WORKTREES: join(base, "worktrees"), SAGE_TEST_PIDS: "{}", SAGE_TEST_MACHINE_ID: "test-machine", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const project = join(base, "project");
  mkdirSync(project);
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  execFileSync("git", ["-C", project, "commit", "-q", "--allow-empty", "-m", "first"], { env: gitEnv });
  return { base, env, project };
}
function linked(t) {
  const w = scratch(t);
  claude.sage(["link", "--separate", "--project", w.project], w.env);
  const dir = claude.storeDir(w.project, w.env);
  return { ...w, dir, live: (id) => join(dir, "live", `${id}.json`), chiefs: () => readFileSync(join(dir, "chiefs.tsv"), "utf8") };
}
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
function table(w, name, rows) {
  const cols = [...new Set([...readFileSync(join(w.dir, `${name}.tsv`), "utf8").split("\n")[0].split("\t"), "chief"])];
  writeFileSync(join(w.dir, `${name}.tsv`), [cols, ...rows.map((row) => cols.map((c) => row[c] ?? ""))].map((line) => line.join("\t")).join("\n") + "\n");
}
const task = (id, chief) => ({ id, title: `task ${id}`, size: "small", route: "build", state: "building", round: "0", chief });
const run = (id, taskId, chief, started) => ({ id, task: taskId, role: "implementer", round: "0", status: "running", started, chief });
function boardOf(w, now) {
  const model = buildBoardModel(readBoardSources([{ id: "shared", path: w.env.SAGE_SHARED_HOME, label: "shared" }], { now }), { now: new Date(now).toISOString() });
  return { model, project: model.projects.find((p) => p.books.includes(`shared/${basename(w.dir)}`)) };
}

function claudeEvent(w, event) {
  const r = spawnSync(process.execPath, [CLAUDE_HOOK], { input: JSON.stringify({ session_id: "claude-1", cwd: w.project, ...event }), env: w.env, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : undefined;
}
const claudeSay = (w, prompt) => claudeEvent(w, { hook_event_name: "UserPromptSubmit", prompt });
const claudeTool = (w) => claudeEvent(w, { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: join(w.project, "x") }, tool_response: {} });

let turns = 0;
function codexEvent(w, event) {
  const transcript = join(w.base, "rollout.jsonl");
  if (!existsSync(transcript)) writeFileSync(transcript, `${JSON.stringify({ type: "session_meta", payload: { id: "codex-1", session_id: "codex-1", cli_version: "0.164.0", source: "cli" } })}\n`);
  const runner = `import { dispatch } from ${JSON.stringify(DISPATCH)}; import { readFileSync } from "node:fs"; const input = JSON.parse(readFileSync(0, "utf8")); const out = await dispatch(input.hook_event_name, input, {}); process.stdout.write(JSON.stringify(out ?? null));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", runner], { input: JSON.stringify({ session_id: "codex-1", transcript_path: transcript, cwd: w.project, model: "fixture", permission_mode: "default", ...event }), env: w.env, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const codexSay = (w, prompt) => codexEvent(w, { hook_event_name: "UserPromptSubmit", turn_id: `turn-${++turns}`, prompt });
const codexTool = (w) => codexEvent(w, { hook_event_name: "PostToolUse", tool_name: "read_file", tool_input: {}, tool_response: {} });

const providers = [
  ["Claude", "claude", claudeSay, claudeTool, "claude-1"],
  ["Codex", "codex", codexSay, codexTool, "codex-1"],
];

for (const [name, provider, say, tool, session] of providers) {
  test(`${name}: the sage mode phrase registers the chief before any write, and its hook writes live/C1.json at once`, (t) => {
    const w = linked(t);
    tool(w);
    assert.equal(existsSync(join(w.dir, "chiefs.tsv")), false, "a session with sage mode off is no chief");
    assert.equal(existsSync(w.live("C1")), false);
    say(w, "sage mode");
    const [head, ...rows] = w.chiefs().trim().split("\n");
    assert.equal(head, "id\tprovider\tnative\tat", "chiefs.tsv keeps its four columns");
    assert.deepEqual(rows.map((row) => row.split("\t").slice(0, 3)), [["C1", provider, session]]);
    const live = json(w.live("C1"));
    assert.deepEqual({ ...live, at: undefined }, { provider, checkout: realpathSync(w.project), sageMode: true, autopilot: false, at: undefined });
    assert.ok(Math.abs(Date.parse(live.at) - Date.now()) < MINUTE, live.at);
  });

  test(`${name}: the hook does not rewrite live/C1.json within a minute, but at once when autopilot or sage mode changes`, (t) => {
    const w = linked(t);
    say(w, "sage mode");
    const first = readFileSync(w.live("C1"), "utf8"), stamp = statSync(w.live("C1")).mtimeMs;
    tool(w);
    say(w, "show me the tasks");
    tool(w);
    assert.equal(readFileSync(w.live("C1"), "utf8"), first, "no write inside the minute");
    assert.equal(statSync(w.live("C1")).mtimeMs, stamp);
    say(w, "autopilot on");
    assert.deepEqual([json(w.live("C1")).sageMode, json(w.live("C1")).autopilot], [true, true], "autopilot on is written at once");
    say(w, "autopilot off");
    assert.deepEqual([json(w.live("C1")).sageMode, json(w.live("C1")).autopilot], [true, false], "autopilot off is written at once");
    say(w, "sage mode off");
    assert.deepEqual([json(w.live("C1")).sageMode, json(w.live("C1")).autopilot], [false, false], "sage mode off is written at once");
    assert.equal(w.chiefs().trim().split("\n").length, 2, "one chief row");
  });
}

test("Claude and Codex chiefs of one logbook each write their own live file", (t) => {
  const w = linked(t);
  claudeSay(w, "sage mode");
  codexSay(w, "sage mode");
  assert.deepEqual(w.chiefs().trim().split("\n").slice(1).map((row) => row.split("\t").slice(0, 2).join(" ")), ["C1 claude", "C2 codex"]);
  assert.deepEqual([json(w.live("C1")).provider, json(w.live("C2")).provider], ["claude", "codex"]);
});

test("a session in a project with no shared logbook writes no live file and makes no chief", (t) => {
  const w = scratch(t);
  claude.sage(["init", "--project", w.project], w.env);
  claudeSay(w, "sage mode");
  const dir = claude.storeDir(w.project, w.env);
  assert.equal(existsSync(join(dir, "chiefs.tsv")), false);
  assert.equal(existsSync(join(dir, "live")), false);
});

test("chiefBeat: a beat is due after a minute, or at once on a change, and never for a session that was never in sage mode", (t) => {
  const w = linked(t);
  const beat = (last, mode, now) => chiefBeat({ last, mode, now, project: w.project, native: "s", provider: "claude", tool: claude, env: w.env });
  const t0 = Date.parse("2026-11-13T10:00:00.000Z"), on = { sageMode: true, autopilot: false };
  assert.equal(beat(undefined, { sageMode: false, autopilot: false }, t0), undefined);
  assert.equal(existsSync(join(w.dir, "chiefs.tsv")), false);
  const first = beat(undefined, on, t0);
  assert.equal(json(w.live("C1")).at, "2026-11-13T10:00:00.000Z");
  assert.equal(beat(first, on, t0 + MINUTE - 1), first, "not due inside the minute");
  assert.equal(json(w.live("C1")).at, "2026-11-13T10:00:00.000Z");
  const second = beat(first, on, t0 + MINUTE);
  assert.equal(json(w.live("C1")).at, "2026-11-13T10:01:00.000Z", "due after a minute");
  beat(second, { sageMode: true, autopilot: true }, t0 + MINUTE + 1);
  assert.deepEqual([json(w.live("C1")).at, json(w.live("C1")).autopilot], ["2026-11-13T10:01:00.001Z", true], "due at once on a change");
});

const agentCall = (w) => claudeEvent(w, { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "Explore", description: "find", prompt: "find x" } });
function beatDue(w) {
  const file = join(w.env.SAGE_HOOKS_STATE, "claude-1.json"), state = json(file);
  writeFileSync(file, JSON.stringify({ ...state, live: { ...state.live, at: 0 } }));
}

test("a failed beat in a sage mode session never throws, and the hook still allows the call", (t) => {
  const w = linked(t);
  const writable = (mode) => chmodSync(join(w.dir, "live"), mode);
  claudeSay(w, "sage mode");
  const first = readFileSync(w.live("C1"), "utf8");
  assert.equal(agentCall(w), undefined, "a chief in sage mode may start an Explore agent");
  writable(0o500);
  try {
    const next = chiefBeat({ last: undefined, mode: { sageMode: true, autopilot: false }, now: Date.now(), project: w.project, native: "claude-1", provider: "claude", tool: claude, env: w.env });
    assert.equal(next.sageMode, true, "the beat is noted, so the hook retries after a minute and not on each event");
    beatDue(w);
    assert.equal(agentCall(w), undefined, "the beat was due and failed, and the hook still allows the call with no second answer");
  } finally { writable(0o700); }
  assert.equal(readFileSync(w.live("C1"), "utf8"), first, "the failed beat changed nothing");
  assert.ok(json(join(w.env.SAGE_HOOKS_STATE, "claude-1.json")).live.at > 0, "the hook noted the failed beat");
});

test("the Claude hook prints its answer before the beat, so a beat that never returns loses no deny", (t) => {
  const w = linked(t);
  claudeSay(w, "sage mode");
  beatDue(w);
  const preload = join(w.base, "beat-never-returns.mjs");
  writeFileSync(preload, [
    'import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";',
    "const write = fs.writeFileSync;",
    'fs.writeFileSync = function (path, ...rest) { if (String(path).includes("/live/C")) process.exit(0); return write.call(this, path, ...rest); };',
    "syncBuiltinESMExports();",
  ].join("\n"));
  const out = claudeEvent({ ...w, env: { ...w.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } }, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(w.project, "x"), old_string: "a", new_string: "b" } });
  assert.equal(out?.hookSpecificOutput?.permissionDecision, "deny", "a chief in sage mode changes no files, and the deny is out before the beat");
});

test("a live folder that is a link gets no write, and the hook still allows the call", (t) => {
  const w = linked(t);
  const elsewhere = join(w.base, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(w.dir, "live"));
  claudeSay(w, "sage mode");
  assert.equal(agentCall(w), undefined);
  assert.equal(w.chiefs().trim().split("\n").length, 2, "sage mode still registers the chief");
  assert.deepEqual(readdirSync(elsewhere), [], "the beat does not follow the link");
  const next = chiefBeat({ last: undefined, mode: { sageMode: true, autopilot: false }, now: Date.now(), project: w.project, native: "claude-1", provider: "claude", tool: claude, env: w.env });
  assert.equal(next.sageMode, true);
  assert.deepEqual(readdirSync(elsewhere), []);
  assert.ok(lstatSync(join(w.dir, "live")).isSymbolicLink(), "the link stays as it was");
});

test("boardChiefs: a chief stops when its heartbeat is over 30 minutes old: at 30 minutes exactly it has not", () => {
  const beat = Date.parse("2026-11-13T10:00:00.000Z");
  const stopped = (now) => boardChiefs({ rows: [{ id: "C1", provider: "claude", at: "2026-11-13T09:00:00.000Z" }], live: { C1: { checkout: null, sageMode: true, autopilot: false, at: beat } }, now })[0].stopped;
  assert.equal(stopped(beat + 30 * MINUTE), false);
  assert.equal(stopped(beat + 30 * MINUTE + 1), true);
});

test("boardChiefs, F-T1059-1, -2, -4, -7, -8: names stay apart, a silent chief that waits for the owner is not stopped, a long folder is cut, a stopped chief shows no mode, and agents is a count", () => {
  const now = Date.parse("2026-11-13T12:00:00.000Z"), at = "2026-11-13T08:30:00.000Z", old = now - 40 * MINUTE;
  const rows = [{ id: "C1", provider: "claude", at }, { id: "C2", provider: "claude", at }, { id: "C3", provider: "codex", at }, { id: "C4", provider: "codex", at }];
  const live = { C1: { checkout: "/w/app", sageMode: true, autopilot: true, at: old }, C2: { checkout: "/w/app", sageMode: true, autopilot: true, at: old }, C3: { checkout: `/w/${"long  folder ".repeat(6)}`, sageMode: true, autopilot: true, at: now }, C4: { checkout: "/w/app", sageMode: true, autopilot: false, at: old } };
  const chiefs = boardChiefs({ rows, live, names: { C4: "Claude · app · 2026-11-13 08:30 UTC" }, waits: ["C2"], runs: [{ chief: "C3", status: "running" }, { chief: "C3", status: "running" }], now });
  const [c1, c2, c3, c4] = chiefs;
  assert.deepEqual([c1.name, c2.name, c4.name], ["Claude · app · 2026-11-13 08:30 UTC · C1", "Claude · app · 2026-11-13 08:30 UTC · C2", "Claude · app · 2026-11-13 08:30 UTC · C4"], "F-T1059-1: equal names get their ids, also against a set name");
  assert.deepEqual([c1.stopped, c1.sageMode, c1.autopilot], [true, null, null], "F-T1059-7: a stopped chief shows no mode");
  assert.deepEqual([c2.stopped, c2.waitsForOwner, c2.autopilot], [false, true, true], "F-T1059-2: a silent chief with the owner's open question waits; it is not stopped");
  assert.equal(c3.name, "Codex · long folder long folder long… · 2026-11-13 08:30 UTC", "F-T1059-4: spaces fold, and a long folder is cut at 30 characters");
  assert.equal(c3.agents, 2, "F-T1059-8: agents counts the chief's running runs");
  assert.equal("running" in c3, false);
});

test("the board model: a run that the board shows as stale keeps no chief from stopped, and a fresh run does", (t) => {
  const w = linked(t);
  for (const session of ["a", "b", "c"]) claude.chiefFor(w.project, session, w.env);
  const now = Date.parse("2026-11-13T12:00:00.000Z"), iso = (ms) => new Date(ms).toISOString(), DAY = 24 * 60 * MINUTE;
  mkdirSync(join(w.dir, "live"));
  const live = (id, ago) => writeFileSync(w.live(id), JSON.stringify({ provider: "claude", checkout: w.project, sageMode: true, autopilot: false, at: iso(now - ago) }));
  live("C1", 10 * DAY);
  live("C2", 3 * DAY);
  live("C3", 3 * DAY);
  table(w, "tasks", [task("T1", "C1"), task("T2", "C2"), task("T3", "C3")]);
  table(w, "runs", [run("R1", "T1", "C1", iso(now - 10 * DAY)), run("R2", "T2", "C2", iso(now - 3 * DAY)), run("R3", "T3", "C3", iso(now - 10 * MINUTE))]);
  const { model, project } = boardOf(w, now);
  assert.deepEqual(project.chiefs.map(({ id, agents, stopped }) => ({ id, agents, stopped })), [
    { id: "C1", agents: 0, stopped: true },
    { id: "C2", agents: 0, stopped: true },
    { id: "C3", agents: 1, stopped: false },
  ]);
  const card = (id) => model.tasks.find((one) => one.id === id);
  assert.deepEqual(["T1", "T2", "T3"].map((id) => card(id).agents.map((agent) => agent.stale)), [[true], [true], [false]], "the board's own clock agrees");
  assert.ok(card("T1").reasons.some((reason) => reason.kind === "chief-unknown"), "the card says that C1 may have stopped, and the chief line agrees");
});

test("the board model: a live file more than 5 minutes in the future is not trusted: all its values are unknown, as with no live file", (t) => {
  const w = linked(t);
  for (const session of ["a", "b", "c"]) claude.chiefFor(w.project, session, w.env);
  const now = Date.parse("2026-11-13T12:00:00.000Z"), iso = (ms) => new Date(ms).toISOString();
  const rows = w.chiefs().trim().split("\n");
  writeFileSync(join(w.dir, "chiefs.tsv"), `${[rows[0], ...rows.slice(1).map((row) => row.split("\t").with(3, "2026-11-13T08:30:00.000Z").join("\t"))].join("\n")}\n`);
  mkdirSync(join(w.dir, "live"));
  const live = (id, at) => writeFileSync(w.live(id), JSON.stringify({ provider: "claude", checkout: w.project, sageMode: true, autopilot: true, at }));
  live("C1", "2099-01-01T00:00:00.000Z");
  live("C2", iso(now + 5 * MINUTE + 1));
  live("C3", iso(now + 5 * MINUTE));
  const folder = basename(realpathSync(w.project)), unknown = { checkout: null, sageMode: null, autopilot: null, heartbeat: null, stopped: null };
  assert.deepEqual(boardOf(w, now).project.chiefs.map(({ id, name, checkout, sageMode, autopilot, heartbeat, stopped }) => ({ id, name, checkout, sageMode, autopilot, heartbeat, stopped })), [
    { id: "C1", name: "Claude · 2026-11-13 08:30 UTC · C1", ...unknown },
    { id: "C2", name: "Claude · 2026-11-13 08:30 UTC · C2", ...unknown },
    { id: "C3", name: `Claude · ${folder} · 2026-11-13 08:30 UTC`, checkout: realpathSync(w.project), sageMode: true, autopilot: true, heartbeat: iso(now + 5 * MINUTE), stopped: false },
  ]);
});

test("F-T1059-3: a live checkout with control or direction characters never reaches the board model: the chief's checkout is unknown, and its default name has no folder", (t) => {
  const w = linked(t);
  claude.chiefFor(w.project, "a", w.env);
  const now = Date.parse("2026-11-13T12:00:00.000Z"), rows = w.chiefs().trim().split("\n");
  writeFileSync(join(w.dir, "chiefs.tsv"), `${rows[0]}\n${rows[1].split("\t").with(3, "2026-11-13T08:30:00.000Z").join("\t")}\n`);
  mkdirSync(join(w.dir, "live"));
  writeFileSync(w.live("C1"), JSON.stringify({ provider: "claude", checkout: "/work/app‮txt.exe\u001b[2Jdone​", sageMode: true, autopilot: false, at: new Date(now - MINUTE).toISOString() }));
  const [chief] = boardOf(w, now).project.chiefs;
  assert.deepEqual([chief.name, chief.checkout], ["Claude · 2026-11-13 08:30 UTC", null]);
});

test("chiefBeat: a beat time later than the clock (the clock moved back) makes a beat due at once", (t) => {
  const w = linked(t);
  const t0 = Date.parse("2026-11-13T10:00:00.000Z"), on = { sageMode: true, autopilot: false };
  const beat = (last, now) => chiefBeat({ last, mode: on, now, project: w.project, native: "s", provider: "claude", tool: claude, env: w.env });
  const ahead = beat(undefined, t0 + 10 * MINUTE);
  assert.equal(json(w.live("C1")).at, "2026-11-13T10:10:00.000Z");
  const back = beat(ahead, t0);
  assert.equal(json(w.live("C1")).at, "2026-11-13T10:00:00.000Z", "the beat after the clock moved back writes the true time");
  assert.equal(back.at, t0);
  assert.equal(beat(back, t0 + 1), back, "and then the minute counts again from the true time");
});

test("the Codex launcher prints the hook's answer before the beat, so a beat that never returns loses no answer", (t) => {
  const w = linked(t);
  const cache = join(w.env.CODEX_HOME, "plugins/cache/sage/sage/local"), launcher = join(w.env.CODEX_HOME, "sage-hooks/launch.mjs");
  cpSync(at("../plugins/sage-codex"), cache, { recursive: true });
  mkdirSync(dirname(launcher), { recursive: true });
  cpSync(at("../plugins/sage-codex/hooks/launch.mjs"), launcher);
  const preload = join(w.base, "beat-never-returns.mjs");
  writeFileSync(preload, [
    'import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";',
    "const write = fs.writeFileSync;",
    'fs.writeFileSync = function (path, ...rest) { if (String(path).includes("/live/C")) process.exit(0); return write.call(this, path, ...rest); };',
    "syncBuiltinESMExports();",
  ].join("\n"));
  const transcript = join(w.base, "rollout.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ type: "session_meta", payload: { id: "codex-1", session_id: "codex-1", cli_version: "0.164.0", source: "cli" } })}\n`);
  const input = { hook_event_name: "UserPromptSubmit", session_id: "codex-1", turn_id: "turn-1", transcript_path: transcript, cwd: w.project, model: "fixture", permission_mode: "default", prompt: "sage mode" };
  const r = spawnSync(process.execPath, [launcher, "UserPromptSubmit"], { input: JSON.stringify(input), env: { ...w.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` }, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(w.chiefs().trim().split("\n").length, 2, "the phrase registered the chief, so the beat was due");
  assert.equal(existsSync(w.live("C1")), false, "the beat never finished");
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /sage mode/i, "the answer is out before the beat");
});

test("the board model: one bad entry in chief-names.json hides only that name, with a warning for it", (t) => {
  const w = linked(t);
  for (const session of ["a", "b"]) claude.chiefFor(w.project, session, w.env);
  writeFileSync(join(w.dir, "chief-names.json"), JSON.stringify({ C1: "Main desk", C2: 5 }));
  const { model, project } = boardOf(w, Date.now());
  assert.deepEqual(project.chiefs.map(({ id, name, named }) => ({ id, named, name: named ? name : "default" })), [
    { id: "C1", named: true, name: "Main desk" },
    { id: "C2", named: false, name: "default" },
  ]);
  assert.deepEqual(model.warnings.map((one) => one.message), ["chief-names.json: the name of C2 is not valid"]);
  assert.throws(() => claude.sage(["chief", "name", "C1", "Front", "--project", w.project], w.env), /chief-names\.json is damaged \(the name of C2 is not valid\)/, "the command never drops the bad entry by itself");
});

test("chief name sets, changes and clears a name with no chief, and refuses a bad name, an unknown chief and a separate logbook", (t) => {
  const w = linked(t);
  claude.chiefFor(w.project, "a", w.env);
  codex.chiefFor(w.project, "b", w.env);
  const names = () => json(join(w.dir, "chief-names.json"));
  const run = (tool, ...args) => tool.sage(["chief", "name", ...args, "--project", w.project], w.env);
  assert.equal(run(claude, "C1", "Main"), 'C1 is named "Main" now.');
  assert.equal(run(codex, "C2", "Night", "shift"), 'C2 is named "Night shift" now.');
  assert.deepEqual(names(), { C1: "Main", C2: "Night shift" });
  run(claude, "C1", "Front desk");
  assert.deepEqual(names(), { C1: "Front desk", C2: "Night shift" });
  assert.equal(run(codex, "C1"), "C1 has no name now, so the board shows its default name.");
  assert.deepEqual(names(), { C2: "Night shift" });
  for (const bad of ["a\tb", "​x", "x".repeat(81)]) assert.throws(() => run(claude, "C2", bad), /the name ".*" has .*Nothing changed\./, JSON.stringify(bad));
  assert.throws(() => run(claude, "C9", "x"), /C9 is not a chief of this logbook/);
  assert.throws(() => run(claude, "R1", "x"), /chief takes: chief name C<n> <name>/);
  assert.deepEqual(names(), { C2: "Night shift" }, "a refusal changes nothing");
  const other = scratch(t);
  claude.sage(["init", "--project", other.project], other.env);
  assert.throws(() => claude.sage(["chief", "name", "C1", "x", "--project", other.project], other.env), /has no shared logbook/);
});

test("the board model lists each chief with provider, name, sage mode, autopilot, heartbeat and stopped; unknown values are null", (t) => {
  const w = linked(t);
  for (const [tool, session] of [[claude, "a"], [codex, "b"], [claude, "c"], [codex, "d"], [claude, "e"]]) tool.chiefFor(w.project, session, w.env);
  const now = Date.parse("2026-11-13T12:00:00.000Z"), iso = (ms) => new Date(ms).toISOString();
  const rows = w.chiefs().trim().split("\n");
  writeFileSync(join(w.dir, "chiefs.tsv"), `${[rows[0], ...rows.slice(1).map((row) => row.split("\t").with(3, "2026-11-13T08:30:00.000Z").join("\t"))].join("\n")}\n`);
  mkdirSync(join(w.dir, "live"));
  const live = (id, minutes, extra = {}) => writeFileSync(w.live(id), JSON.stringify({ provider: "x", checkout: w.project, sageMode: true, autopilot: false, at: iso(now - minutes * MINUTE), ...extra }));
  live("C1", 1, { autopilot: true });
  live("C2", 40);
  live("C3", 40);
  writeFileSync(w.live("C5"), "{ damaged");
  writeFileSync(join(w.dir, "chief-names.json"), JSON.stringify({ C1: "Main" }));
  table(w, "tasks", [task("T1", "C3")]);
  table(w, "runs", [run("R1", "T1", "C3", iso(now - 10 * MINUTE))]);
  const { model, project } = boardOf(w, now);
  const pick = ({ id, provider, name, named, sageMode, autopilot, heartbeat, stopped }) => ({ id, provider, name, named, sageMode, autopilot, heartbeat, stopped });
  const folder = basename(realpathSync(w.project));
  assert.deepEqual(project.chiefs.map(pick), [
    { id: "C1", provider: "claude", name: "Main", named: true, sageMode: true, autopilot: true, heartbeat: iso(now - MINUTE), stopped: false },
    { id: "C2", provider: "codex", name: `Codex · ${folder} · 2026-11-13 08:30 UTC`, named: false, sageMode: null, autopilot: null, heartbeat: iso(now - 40 * MINUTE), stopped: true },
    { id: "C3", provider: "claude", name: `Claude · ${folder} · 2026-11-13 08:30 UTC`, named: false, sageMode: true, autopilot: false, heartbeat: iso(now - 40 * MINUTE), stopped: false },
    { id: "C4", provider: "codex", name: "Codex · 2026-11-13 08:30 UTC", named: false, sageMode: null, autopilot: null, heartbeat: null, stopped: null },
    { id: "C5", provider: "claude", name: "Claude · 2026-11-13 08:30 UTC", named: false, sageMode: null, autopilot: null, heartbeat: null, stopped: null },
  ]);
  assert.deepEqual(model.diagnostics, [], "the new files never make the board stale");
  assert.deepEqual(model.warnings.map((w) => w.message), ["live/C5.json: invalid JSON"]);
  const overview = boardOverview(model);
  assert.deepEqual(overview.chiefs.map((c) => [c.id, c.project]), ["C1", "C2", "C3", "C4", "C5"].map((id) => [id, project.name]));
  assert.equal(overview.next, now - MINUTE + 30 * MINUTE + 1, "the overview wakes when the fresh chief would stop");
});

test("an older plugin still reads the logbook: chiefs.tsv keeps its exact columns beside the live files and the names file", (t) => {
  const w = linked(t);
  claudeSay(w, "sage mode");
  codexSay(w, "sage mode");
  claude.sage(["chief", "name", "C1", "Main", "--project", w.project], w.env);
  const [head, ...lines] = w.chiefs().trim().split("\n"), cols = head.split("\t");
  assert.ok(chiefsWhole(cols, lines, lines.map((line) => Object.fromEntries(cols.map((c, i) => [c, line.split("\t")[i]])))), "the column check of every plugin accepts chiefs.tsv");
  assert.match(claude.sage(["status", "--project", w.project], w.env), /./);
  assert.match(codex.sage(["status", "--project", w.project], w.env), /./);
});
