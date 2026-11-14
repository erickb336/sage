import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { actorOptions, sage as claudeRun, logbookView, markStart, queueOf, storeDir } from "../plugins/sage/skills/sage/sage.mjs";
import { tool } from "../plugins/sage-codex/skills/sage/sage.mjs";
import { gate } from "../plugins/sage-codex/hooks/gate-hook.mjs";
import { briefHook, recordBrief } from "../plugins/sage-codex/hooks/brief-hook.mjs";
import { handle as codexMode } from "../plugins/sage-codex/hooks/sage-codex-hook.mjs";
import { buildBoardModel, readBoardSources } from "../packages/sage-core/index.mjs";
import { TABLES } from "../packages/sage-core/logbook-fields.mjs";

const CLAUDE_TOOL = fileURLToPath(new URL("../plugins/sage/skills/sage/sage.mjs", import.meta.url));
const CODEX_TOOL = fileURLToPath(new URL("../plugins/sage-codex/skills/sage/sage.mjs", import.meta.url));
const LAUNCHER = [fileURLToPath(new URL("../plugins/sage/hooks/launcher.mjs", import.meta.url)), "sage-hook.mjs"];
const WAIT = fileURLToPath(new URL("../plugins/sage/hooks/wait.mjs", import.meta.url));
const BRIEF = ["GOAL", "SCOPE", "CONTEXT", "DECISIONS", "ACCEPTANCE", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"].map((f) => `${f}: the ${f.toLowerCase()}.`).join("\n");
const CLAUDE = "claude-chief-session", CODEX = "019a0000-0000-7000-8000-0000000000c2";
const timeout = 60_000;

function world(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-queue-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const env = { ...process.env, HOME: join(base, "home"), CLAUDE_CONFIG_DIR: join(base, "claude"), CODEX_HOME: join(base, "codex"), SAGE_SHARED_HOME: join(base, "shared"), SAGE_HOOKS_STATE: join(base, "hooks"), SAGE_TEST_PIDS: "{}" };
  delete env.SAGE_HOME;
  const project = join(base, "project");
  mkdirSync(project);
  const git = (...args) => execFileSync("git", args, { cwd: project, env: { ...env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" }, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "first");
  const claude = (...args) => claudeRun([...args, "--project", project, ...actorOptions(project, args, { native: CLAUDE }, env)], env);
  const codex = (...args) => tool.sage([...args, "--project", project, ...tool.actorOptions(project, args, { native: CODEX }, env)], env);
  const runs = () => {
    const [head, ...lines] = readFileSync(join(storeDir(project, env), "runs.tsv"), "utf8").replace(/\n+$/, "").split("\n"), cols = head.split("\t");
    return { cols, rows: lines.map((line) => Object.fromEntries(line.split("\t").map((cell, i) => [cols[i], cell]))) };
  };
  const hook = (event) => {
    const r = spawnSync("node", LAUNCHER, { input: JSON.stringify({ session_id: CLAUDE, cwd: project, ...event }), encoding: "utf8", env, timeout });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : undefined;
  };
  const spawnCodex = (task_name) => gate({ hook_event_name: "PreToolUse", session_id: CODEX, turn_id: "t1", cwd: project, model: "m", permission_mode: "default",
    tool_name: "collaborationspawn_agent", tool_use_id: `call_${task_name}`, transcript_path: null, tool_input: { task_name, message: "go", fork_turns: "none" } }, { mode: () => ({ sage: true }), env });
  return { base, env, project, claude, codex, runs, hook, spawnCodex };
}
const denied = (out) => (out?.hookSpecificOutput?.permissionDecision === "deny" ? out.hookSpecificOutput.permissionDecisionReason : undefined);
const context = (out) => out?.hookSpecificOutput?.additionalContext ?? "";
const claudeSpawn = (run, task) => ({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: `tu-${run}`, tool_input: { subagent_type: "sage:qa", description: "check", prompt: `Run ${run} · task ${task}\n${BRIEF}` } });
const status = (w, id) => w.runs().rows.find((r) => r.id === id)?.status;
const shared = (w) => {
  w.claude("link", "--separate");
  w.claude("config", "max_agents=3");
  w.claude("task", "add", "--title", "claude task", "--size", "tiny", "--priority", "P2");
  w.codex("task", "add", "--title", "codex task", "--size", "tiny", "--priority", "P2");
};

test("T1057: a Claude chief and a Codex chief at the project's limit queue their runs, each spawn is refused with its place, and a run that ends admits the oldest", async (t) => {
  const w = world(t);
  shared(w);
  assert.match(w.claude("run", "add", "T1", "--role", "qa"), /^R1 running · qa on T1/);
  assert.match(w.codex("run", "add", "T2", "--role", "qa"), /^R2 running · qa on T2/);
  assert.match(w.claude("run", "add", "T1", "--role", "qa"), /^R3 running · qa on T1/);
  assert.match(w.codex("run", "add", "T2", "--role", "qa"), /^R4 is queued, place 1 · qa on T2 · reasoning_effort medium · the project runs 3 of its 3 agents\. Start its agent only after its admission.* Codex has no wait for a place: after a run ends, call spawn_agent again with the same task name\. The gate names the run's place again, or lets it start\.$/, "the Codex line says how to wait");
  assert.match(w.claude("run", "add", "T1", "--role", "qa"), /^R5 is queued, place 2 · qa on T1 · model sonnet · the project runs 3 of its 3 agents\..* To wait, run node \S+\/hooks\/wait\.mjs --slot R5 as a Bash command of its own \(a chief in the background, a lead with the timeout 600000\)\. It ends when R5 is admitted\.$/, "the Claude line names the wait");
  assert.deepEqual(w.runs().rows.map((r) => [r.id, r.status, r.chief]), [["R1", "running", "C1"], ["R2", "running", "C2"], ["R3", "running", "C1"], ["R4", "queued", "C2"], ["R5", "queued", "C1"]]);

  assert.equal(denied(await w.spawnCodex("sage_qa_t2_r4")), "sage: R4 is queued, place 1 of 2: the project runs 3 of its 3 agents, so its agent does not start yet. A run that ends admits the oldest queued run. Codex has no wake for a waiting thread: after a run ends, call spawn_agent again with the same task name. The gate names the run's place again, or lets it start. A chief's hook names the admission at the chief's next turn", "Codex's deny drops the last full stop");
  w.hook({ hook_event_name: "UserPromptSubmit", prompt: "sage mode" });
  assert.match(denied(w.hook(claudeSpawn("R5", "T1"))) ?? "", /^sage: R5 is queued, place 2 of 2: the project runs 3 of its 3 agents, so its agent does not start yet\. A run that ends admits the oldest queued run\. The hook tells you when it is admitted\. To wait, run node \S+\/hooks\/wait\.mjs --slot R5 in the project's folder, as a Bash command of its own in the background \(run_in_background true\)\. It ends when R5 is admitted\.$/);

  assert.equal(w.claude("run", "done", "R1", "--status", "failed"), "R1 failed\nR4 admitted · qa on T2 · chief C2: start its agent within 10 minutes, or the run ends as failed", "the oldest queued run takes the place, also when it is the other chief's");
  assert.deepEqual([status(w, "R4"), status(w, "R5")], ["running", "queued"]);
  assert.equal(context(w.hook({ hook_event_name: "UserPromptSubmit", prompt: "what is next?" })), "", "the Claude chief gets no notice of the Codex chief's run");

  const codexState = { sage: true, given: true };
  const turn = () => context(codexMode({ hook_event_name: "UserPromptSubmit", session_id: CODEX, turn_id: "t2", cwd: w.project, prompt: "go on" }, codexState, w.env));
  assert.match(turn(), /^sage: R4 \(qa on T2\) is admitted from the queue: spawn its agent now, by \d\d:\d\d UTC, or the run ends as failed and loses its place\. Codex wakes no idle chief, so this note comes at your next turn\.$/);
  assert.equal(turn(), "", "the notice comes once");
  recordBrief(w.project, "sage_qa_t2_r4", BRIEF, w.env, CODEX);
  assert.equal(await w.spawnCodex("sage_qa_t2_r4"), undefined, "an admitted run starts normally");
  briefHook({ hook_event_name: "PostToolUse", session_id: CODEX, cwd: w.project, tool_name: "collaborationspawn_agent", tool_input: { task_name: "sage_qa_t2_r4" } }, w.env);
  assert.deepEqual(queueOf(w.project, w.env).admitted, [], "the spawn marks the agent's start, so the lease no longer holds R4");

  assert.match(w.codex("run", "done", "R2", "--status", "failed"), /\nR5 admitted · qa on T1 · chief C1: start its agent within 10 minutes/);
  assert.match(context(w.hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "git status" }, tool_response: { stdout: "" } })),
    /^sage: R5 \(qa on T1\) is admitted from the queue: start its agent now, by \d\d:\d\d UTC, or the run ends as failed and loses its place\.$/, "the Claude chief hears at its next hook event");
  assert.equal(context(w.hook({ hook_event_name: "UserPromptSubmit", prompt: "and now?" })), "", "once");
  assert.equal(denied(w.hook(claudeSpawn("R5", "T1"))), undefined, "the admitted run starts");
  assert.deepEqual(queueOf(w.project, w.env).admitted, [], "the Claude spawn marks the start at its allow");
  assert.equal(turn(), "", "the Codex chief gets no notice of the Claude chief's run");
});

test("T1057: a queued Claude chief is told once at its stop to wait in the background, and the wait returns at the admission", async (t) => {
  const w = world(t);
  shared(w);
  for (const task of ["T1", "T1", "T1"]) w.claude("run", "add", task, "--role", "qa");
  w.hook({ hook_event_name: "UserPromptSubmit", prompt: "sage mode" });
  const queued = w.claude("run", "add", "T1", "--role", "qa");
  w.hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: `node ${CLAUDE_TOOL} run add T1 --role qa --project ${w.project}` }, tool_response: { stdout: queued } });
  const stop = w.hook({ hook_event_name: "Stop", last_assistant_message: "R4 waits." });
  assert.equal(stop?.decision, "block");
  assert.match(stop.reason, /^sage: R4 is queued \(place 1\)\. Before you stop, run node \S+\/hooks\/wait\.mjs --slot R4 in the project's folder, as a Bash command of its own in the background \(run_in_background true\)\. It ends when it is admitted, and its end wakes you to start the agent\.$/);
  assert.equal(w.hook({ hook_event_name: "Stop", last_assistant_message: "R4 waits.", stop_hook_active: true }), undefined, "the stop is blocked once");
  const wait = new Promise((done) => execFile("node", [WAIT, "--slot", "R4"], { cwd: w.project, env: { ...w.env, SAGE_WAIT_MS: "30000" }, timeout }, (error, stdout) => done({ error, stdout })));
  await new Promise((done) => setTimeout(done, 300));
  w.claude("run", "done", "R2", "--status", "failed");
  const { error, stdout } = await wait;
  assert.equal(error, null);
  assert.match(stdout, /^R4 is admitted: start its agent now, by \d\d:\d\d UTC, or the run ends as failed\.\n$/);
  assert.match(w.hook({ hook_event_name: "Stop", last_assistant_message: "R4 starts." })?.reason ?? "", /^sage: R4 \(qa on T1\) is admitted from the queue: start its agent now/, "an untold admission blocks the stop, so the chief starts the agent");
});

test("T1057: an admitted run whose agent does not start within 10 minutes ends as failed, and the next queued run takes its place", (t) => {
  const w = world(t);
  shared(w);
  for (const task of ["T1", "T1", "T1"]) w.claude("run", "add", task, "--role", "qa");
  w.codex("run", "add", "T2", "--role", "qa");
  w.codex("run", "add", "T2", "--role", "qa");
  assert.match(w.claude("run", "done", "R1", "--status", "failed"), /\nR4 admitted · qa on T2 · chief C2: /);
  const file = join(storeDir(w.project, w.env), "runs.tsv"), old = new Date(Date.now() - 11 * 60_000).toISOString().slice(0, 19) + "Z";
  const { cols } = w.runs(), at = cols.indexOf("admitted");
  writeFileSync(file, readFileSync(file, "utf8").split("\n").map((line) => line.startsWith("R4\t") ? line.split("\t").map((cell, i) => (i === at ? old : cell)).join("\t") : line).join("\n"));
  assert.deepEqual(queueOf(w.project, w.env).admitted, [], "a lapsed admission sends no notice");
  assert.equal(w.claude("run", "done", "R2", "--status", "failed"), `R2 failed\nR4 failed: admitted at ${old.slice(11, 16)} UTC, its agent did not start within 10 minutes\nR5 admitted · qa on T2 · chief C2: start its agent within 10 minutes, or the run ends as failed`);
  assert.deepEqual(w.runs().rows.map((r) => [r.id, r.status]), [["R1", "failed"], ["R2", "failed"], ["R3", "running"], ["R4", "failed"], ["R5", "running"]]);
  assert.match(readFileSync(join(storeDir(w.project, w.env), "decisions.tsv"), "utf8"), /\tT2\tR4 failed: no agent started within 10 minutes of its admission\t/);
  return w.spawnCodex("sage_qa_t2_r4").then((out) => assert.equal(denied(out), `sage: R4 was admitted at ${old.slice(11, 16)} UTC, and no agent started within 10 minutes, so it ended as failed and lost its place. Add a new run for this agent`));
});

test("T1057: run add and run done racing in separate processes, from both providers, never hold more running runs than the limit", async (t) => {
  const w = world(t);
  shared(w);
  w.claude("config", "max_agents=4");
  for (let i = 0; i < 4; i++) w.claude("run", "add", "T1", "--role", "qa");
  w.codex("status");
  const cli = (path, chief, ...args) => new Promise((done) => execFile("node", [path, ...args, "--project", w.project, "--chief", chief], { env: w.env, timeout }, (error, stdout, stderr) => done({ code: error ? error.code : 0, stdout, stderr })));
  const file = join(storeDir(w.project, w.env), "runs.tsv");
  let most = 0, reads = 0;
  const watch = setInterval(() => {
    const text = readFileSync(file, "utf8");
    most = Math.max(most, text.split("\n").filter((line) => line.split("\t").includes("running")).length);
    reads++;
  }, 2);
  try {
    for (let round = 0; round < 3; round++) {
      const live = w.runs().rows.filter((r) => r.status === "running").map((r) => r.id);
      const out = await Promise.all([
        ...Array.from({ length: 4 }, () => cli(CLAUDE_TOOL, "C1", "run", "add", "T1", "--role", "qa")),
        ...Array.from({ length: 4 }, () => cli(CODEX_TOOL, "C2", "run", "add", "T2", "--role", "qa")),
        ...live.slice(0, 3).map((id) => w.runs().rows.find((r) => r.id === id).chief).map((chief, i) => cli(chief === "C1" ? CLAUDE_TOOL : CODEX_TOOL, chief, "run", "done", live[i], "--status", "failed")),
      ]);
      for (const r of out) assert.equal(r.code, 0, r.stderr);
      const { rows } = w.runs(), running = rows.filter((r) => r.status === "running"), queued = rows.filter((r) => r.status === "queued");
      assert.equal(running.length, 4, `round ${round}: the limit is full, and no more`);
      const num = (r) => Number(r.id.slice(1));
      assert.ok(queued.every((q) => running.filter((r) => r.admitted).every((r) => num(r) < num(q))), `round ${round}: each admitted run is older than each run that still waits`);
    }
  } finally {
    clearInterval(watch);
  }
  assert.ok(reads > 10, `the watch read the table ${reads} times`);
  assert.equal(most, 4, "no read during the race saw more than 4 running runs");
});

test("T1057: an older runs.tsv without the admitted column still reads and takes writes, the first queued run adds the column, and it holds a value only for an admitted run", (t) => {
  const w = world(t);
  shared(w);
  const file = join(storeDir(w.project, w.env), "runs.tsv"), cols = [...TABLES.runs, "chief"];
  const row = { id: "R1", task: "T1", role: "qa", round: "0", status: "running", started: "2026-11-13T09:00:00Z", chief: "C1" };
  writeFileSync(file, [cols, cols.map((c) => row[c] ?? "")].map((cells) => cells.join("\t")).join("\n") + "\n");
  assert.match(w.codex("status"), /^agents  1 runs · 1 running · /m, "an older file reads");
  w.claude("run", "add", "T1", "--role", "qa");
  w.claude("run", "add", "T1", "--role", "qa");
  assert.equal(w.runs().cols.includes("admitted"), false, "no run was queued, so the file keeps its older columns");
  w.codex("run", "add", "T2", "--role", "qa");
  assert.ok(w.runs().cols.includes("admitted"), "the first queued run writes the column, so that an older sage stops writing (F-T1057-2)");
  assert.equal(w.runs().rows.find((r) => r.id === "R4").admitted, "", "a queued run is not admitted yet");
  w.claude("run", "done", "R2", "--status", "failed");
  const { cols: after, rows } = w.runs();
  assert.ok(after.includes("admitted"));
  assert.deepEqual(rows.map((r) => [r.id, r.admitted === "" ? "" : "time"]), [["R1", ""], ["R2", ""], ["R3", ""], ["R4", "time"]], "sparse: only the run that came from the queue has a value");
});

test("T1057: a sage without the admitted column refuses to write runs.tsv from the first queued run, and says to update; its reads go on", async (t) => {
  const w = world(t);
  shared(w);
  const plugin = join(w.base, "older");
  cpSync(fileURLToPath(new URL("../plugins/sage-codex", import.meta.url)), plugin, { recursive: true });
  const state = join(plugin, "core/state.mjs"), source = readFileSync(state, "utf8");
  const older = source.replace("runs: [CHIEF_COLUMN, CHECKOUT_COLUMN, ADMITTED_COLUMN],", "runs: [CHIEF_COLUMN, CHECKOUT_COLUMN],");
  assert.notEqual(older, source, "the fixture removes the column");
  writeFileSync(state, older);
  const { tool: old } = await import(pathToFileURL(join(plugin, "skills/sage/sage.mjs")).href);
  const run = (...args) => old.sage([...args, "--project", w.project, ...old.actorOptions(w.project, args, { native: CODEX }, w.env)], w.env);
  assert.match(run("run", "add", "T2", "--role", "qa"), /^R1 running /, "before any queued run, the older sage writes as before");
  for (let i = 0; i < 3; i++) w.claude("run", "add", "T1", "--role", "qa");
  assert.equal(status(w, "R4"), "queued");
  const before = readFileSync(join(storeDir(w.project, w.env), "runs.tsv"), "utf8");
  assert.throws(() => run("run", "add", "T2", "--role", "qa"), /runs\.tsv has columns that this version of sage does not know \(admitted\).*Update the sage plugin/);
  assert.equal(readFileSync(join(storeDir(w.project, w.env), "runs.tsv"), "utf8"), before, "nothing changed");
  assert.throws(() => run("run", "done", "R1", "--status", "failed"), /Update the sage plugin/, "an older run done would admit no one, so it is refused too");
  assert.equal(readFileSync(join(storeDir(w.project, w.env), "runs.tsv"), "utf8"), before, "nothing changed");
  assert.match(old.sage(["status", "--project", w.project], w.env), /^agents  4 runs · 3 running · /m);
});

test("T1057: the board model shows each project's running count against its limit, and each queued run with its chief and place", (t) => {
  const w = world(t);
  shared(w);
  for (const task of ["T1", "T1", "T1"]) w.claude("run", "add", task, "--role", "qa");
  w.codex("run", "add", "T2", "--role", "qa");
  w.claude("run", "add", "T1", "--role", "qa");
  const roots = [{ id: "shared", path: w.env.SAGE_SHARED_HOME }, { id: "claude", path: join(w.env.CLAUDE_CONFIG_DIR, "sage"), provider: "claude" }, { id: "codex", path: join(w.env.CODEX_HOME, "sage"), provider: "codex" }];
  const { queues } = buildBoardModel(readBoardSources(roots)).agents;
  assert.equal(queues.length, 1);
  assert.deepEqual({ ...queues[0], key: undefined, group: undefined, queued: queues[0].queued.map(({ since, ...q }) => q) }, {
    key: undefined, group: undefined, running: 3, limit: 3, text: "3 of 3 agents · 2 queued",
    queued: [{ run: "R4", task: "T2", role: "qa", chief: "C2", chiefProvider: "codex", place: 1 }, { run: "R5", task: "T1", role: "qa", chief: "C1", chiefProvider: "claude", place: 2 }],
  });
});

const backdate = (w, id, ms) => {
  const file = join(storeDir(w.project, w.env), "runs.tsv"), at = new Date(Date.now() - ms).toISOString().slice(0, 19) + "Z", col = w.runs().cols.indexOf("admitted");
  writeFileSync(file, readFileSync(file, "utf8").split("\n").map((line) => line.startsWith(`${id}\t`) ? line.split("\t").map((cell, i) => (i === col ? at : cell)).join("\t") : line).join("\n"));
  return at;
};
const waitSlot = (w, ...runs) => new Promise((done) => execFile("node", [WAIT, "--slot", ...runs], { cwd: w.project, env: { ...w.env, SAGE_WAIT_MS: "5000" }, timeout }, (error, stdout) => done({ error, stdout })));
const fullWithAdmission = (w) => {
  shared(w);
  for (const task of ["T1", "T1", "T1"]) w.claude("run", "add", task, "--role", "qa");
  w.codex("run", "add", "T2", "--role", "qa");
  w.claude("run", "add", "T1", "--role", "qa");
  assert.match(w.claude("run", "done", "R1", "--status", "failed"), /\nR4 admitted · qa on T2 · chief C2: /);
};

test("T1057 F-T1057-1: with no write after a lapse, wait --slot fails the lapsed admission and admits the waiting run; a wait on the lapsed run names the next step", async (t) => {
  const w = world(t);
  fullWithAdmission(w);
  const old = backdate(w, "R4", 12 * 60_000);
  const { error, stdout } = await waitSlot(w, "R5");
  assert.equal(error, null);
  assert.match(stdout, /^R5 is admitted: start its agent now, by \d\d:\d\d UTC, or the run ends as failed\.\n$/, "the wait itself sweeps the lapsed admission: no other write came");
  assert.deepEqual([status(w, "R4"), status(w, "R5")], ["failed", "running"]);
  assert.match(readFileSync(join(storeDir(w.project, w.env), "decisions.tsv"), "utf8"), /\tT2\tR4 failed: no agent started within 10 minutes of its admission\t/);
  assert.equal((await waitSlot(w, "R4")).stdout, `R4 was admitted at ${old.slice(11, 16)} UTC, and no agent started within 10 minutes, so it ended as failed and lost its place. Add a new run for this agent.\n`, "the same words as the hook's refusal (F-T1057-14)");
});

test("T1057 F-T1057-7: a helper started in the foreground keeps its run past the lease, because the spawn's allow marks its start; another chief's run add neither fails it nor admits past the limit", (t) => {
  const w = world(t);
  shared(w);
  for (const task of ["T1", "T1", "T1"]) w.claude("run", "add", task, "--role", "qa");
  w.claude("run", "add", "T1", "--role", "qa");
  w.hook({ hook_event_name: "UserPromptSubmit", prompt: "sage mode" });
  assert.match(w.claude("run", "done", "R1", "--status", "failed"), /\nR4 admitted · qa on T1 · chief C1: /);
  const spawn = claudeSpawn("R4", "T1");
  assert.equal(spawn.tool_input.run_in_background, undefined, "a foreground spawn: its PostToolUse comes only when the helper ends");
  assert.equal(denied(w.hook(spawn)), undefined);
  backdate(w, "R4", 11 * 60_000);
  assert.match(w.codex("run", "add", "T2", "--role", "qa"), /^R5 is queued, place 1 · qa on T2 · .*the project runs 3 of its 3 agents\./);
  assert.deepEqual(w.runs().rows.map((r) => [r.id, r.status]), [["R1", "failed"], ["R2", "running"], ["R3", "running"], ["R4", "running"], ["R5", "queued"]]);
  assert.match(w.claude("run", "done", "R4", "--status", "done", "--tokens", "1000"), /^R4 done\nR5 admitted · qa on T2 · chief C2: /, "the working run ends normally");
});

test("T1057 F-T1057-4: from the lease's end the hooks refuse the spawn, but the sweep fails the run only a minute later, so a start mark written just after an allow still holds", async (t) => {
  const w = world(t);
  fullWithAdmission(w);
  const old = backdate(w, "R4", 10.5 * 60_000);
  assert.equal(denied(await w.spawnCodex("sage_qa_t2_r4")), `sage: R4 was admitted at ${old.slice(11, 16)} UTC, and no agent started within 10 minutes, so it lost its place and ends as failed. Add a new run for this agent`);
  assert.match(w.claude("run", "add", "T1", "--role", "qa"), /^R6 is queued, place 2 /);
  assert.equal(status(w, "R4"), "running", "within the minute after the lease, the sweep leaves the run");
  assert.equal(markStart(w.project, "R4", w.env), true, "a hook that allowed the spawn just before the lease's end marks it now");
  backdate(w, "R4", 12 * 60_000);
  assert.match(w.claude("run", "done", "R2", "--status", "failed"), /^R2 failed\nR5 admitted · qa on T1 · chief C1: [^\n]*$/);
  assert.equal(status(w, "R4"), "running", "the sweep reads the mark and keeps the run");
});

test("T1057 F-T1057-5: a queued lead run is not an ended lead run", (t) => {
  const w = world(t);
  shared(w);
  for (const task of ["T1", "T1", "T1"]) w.claude("run", "add", task, "--role", "qa");
  assert.match(w.claude("run", "add", "T1", "--role", "lead"), /^R4 is queued, place 1 · lead on T1/);
  assert.deepEqual(logbookView(w.project, w.env).endedLeadRuns().map((r) => r.id), []);
  w.claude("run", "done", "R4", "--status", "failed");
  assert.deepEqual(logbookView(w.project, w.env).endedLeadRuns().map((r) => r.id), ["R4"]);
});

test("T1057 F-T1057-6: the board takes a project's limit as the state tool does, also before its logbook holds the limits: the largest cap.<project> or max_agents of the provider roots", (t) => {
  const w = world(t);
  shared(w);
  w.claude("run", "add", "T1", "--role", "qa");
  const json = (file, change) => {
    let held = {};
    try { held = JSON.parse(readFileSync(file, "utf8")); } catch {}
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(change(held)));
  };
  json(join(storeDir(w.project, w.env), "config.json"), ({ max_agents, max_leads, ...rest }) => rest);
  json(join(w.env.CLAUDE_CONFIG_DIR, "sage", "config.json"), (held) => ({ ...held, "cap.project": 2, max_agents: 9 }));
  json(join(w.env.CODEX_HOME, "sage", "config.json"), (held) => ({ ...held, max_agents: 4 }));
  assert.equal(queueOf(w.project, w.env).limit, 4, "the state tool: Claude's cap.project (2) is the project's own value there, below Codex's max_agents (4)");
  const roots = [{ id: "shared", path: w.env.SAGE_SHARED_HOME }, { id: "claude", path: join(w.env.CLAUDE_CONFIG_DIR, "sage"), provider: "claude" }, { id: "codex", path: join(w.env.CODEX_HOME, "sage"), provider: "codex" }];
  const [queue] = buildBoardModel(readBoardSources(roots)).agents.queues;
  assert.deepEqual([queue.limit, queue.text], [4, "1 of 4 agents"], "the board shows the same limit");
});
