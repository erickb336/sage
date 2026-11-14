import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as claude from "../plugins/sage/skills/sage/sage.mjs";
import { tool as codex } from "../plugins/sage-codex/skills/sage/sage.mjs";
import { chiefBeat } from "../plugins/sage/core/chief-live.mjs";
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

test("chiefBeat: a failed write never throws, and the hook still answers", (t) => {
  const w = linked(t);
  writeFileSync(join(w.dir, "live"), "a file where the folder should be");
  const next = chiefBeat({ last: undefined, mode: { sageMode: true, autopilot: false }, now: Date.now(), project: w.project, native: "s", provider: "claude", tool: claude, env: w.env });
  assert.equal(next.sageMode, true, "the beat is noted, so the hook retries after a minute and not on each event");
  const out = claudeEvent(w, { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: join(w.project, "x") } });
  assert.notEqual(out?.hookSpecificOutput?.permissionDecision, "deny", JSON.stringify(out));
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
  const cols = [...new Set([...readFileSync(join(w.dir, "runs.tsv"), "utf8").split("\n")[0].split("\t"), "chief"])];
  writeFileSync(join(w.dir, "runs.tsv"), `${cols.join("\t")}\n${cols.map((c) => ({ id: "R1", task: "T1", role: "qa", round: "0", status: "running", chief: "C3" })[c] ?? "").join("\t")}\n`);
  const read = readBoardSources([{ id: "shared", path: w.env.SAGE_SHARED_HOME, label: "shared" }], { now });
  const model = buildBoardModel(read, { now: iso(now) }), project = model.projects.find((p) => p.books.includes(`shared/${basename(w.dir)}`));
  const pick = ({ id, provider, name, named, sageMode, autopilot, heartbeat, stopped }) => ({ id, provider, name, named, sageMode, autopilot, heartbeat, stopped });
  const folder = basename(realpathSync(w.project));
  assert.deepEqual(project.chiefs.map(pick), [
    { id: "C1", provider: "claude", name: "Main", named: true, sageMode: true, autopilot: true, heartbeat: iso(now - MINUTE), stopped: false },
    { id: "C2", provider: "codex", name: `Codex · ${folder} · 2026-11-13 08:30 UTC`, named: false, sageMode: true, autopilot: false, heartbeat: iso(now - 40 * MINUTE), stopped: true },
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
