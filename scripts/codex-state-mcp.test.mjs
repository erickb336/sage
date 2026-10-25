import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { ROOT } from "./build.mjs";

const SHA = "1".repeat(40);

/** The built plugin's state server in a scratch folder, with a scratch CODEX_HOME and no SAGE_HOME. */
async function connect(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-state-mcp-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(ROOT, "plugins/sage-codex"), join(dir, "plugin"), { recursive: true });
  const project = join(dir, "project");
  mkdirSync(project);
  execFileSync("git", ["init", "-q", project]);
  const { SAGE_HOME, ...inherited } = process.env;
  const env = { ...inherited, HOME: join(dir, "home"), CODEX_HOME: join(dir, "codex-home"), SAGE_WORKTREES: join(dir, "worktrees") };
  const child = spawn(process.execPath, [join(dir, "plugin/mcp/state-server.mjs")], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "", id = 0;
  child.stderr.on("data", (data) => { stderr += data; });
  const closed = new Promise((resolve) => child.once("close", (code) => resolve(code)));
  const pending = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => { const reply = JSON.parse(line); pending.get(reply.id)(reply); });
  const rpc = (method, params) => new Promise((resolve) => {
    pending.set(++id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex", version: "0.160.0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  t.after(async () => { child.stdin.end(); assert.equal(await closed, 0); assert.equal(stderr, ""); });
  return {
    dir, project, env,
    tools: async () => (await rpc("tools/list", {})).result.tools,
    /** A tool's text, or { error } with the text of a refusal. */
    call: async (name, args = {}) => {
      const reply = await rpc("tools/call", { name, arguments: { project, ...args } });
      assert.equal(reply.error, undefined);
      const text = reply.result.content.map((part) => part.text).join("\n");
      return reply.result.isError ? { error: text } : text;
    },
  };
}

test("the state server lists one tool for each state-tool command, and marks only the reads read-only", async (t) => {
  const s = await connect(t);
  const tools = await s.tools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["finding_add", "finding_close", "finding_move", "finding_triage", "gate_add", "gate_answer",
    "init", "log", "merge_check", "pages", "round", "run_add", "run_done", "standing", "standing_add", "status", "task_add", "task_set", "verdict"]);
  assert.deepEqual(tools.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name).sort(), ["merge_check", "standing", "status"]);
  assert.ok(tools.every((tool) => tool.inputSchema.required.includes("project") && tool.inputSchema.additionalProperties === false));
});

test("each tool writes the Codex logbook in CODEX_HOME/sage, and returns each refusal as a tool error with its reason", async (t) => {
  const s = await connect(t);
  const call = s.call;
  assert.match((await call("status")).error, /^sage: no logbook for the project .*project\. Run: sage init --project /);
  const logbook = (await call("init")).replace(/^logbook /, "");
  assert.match(logbook, new RegExp(`^${s.env.CODEX_HOME}/sage/project-[0-9a-f]{6}$`));
  assert.match(await call("status"), /^sage · project · \d\d:\d\d UTC\ntasks {3}0\n/);
  assert.match((await call("init", { project: "relative/path" })).error, /^Input validation error: .*project: an absolute path/);

  // A value that starts with -- stays a value: it is not read as an option of the command.
  assert.equal(await call("task_add", { title: "--why=x first", size: "small" }), "T1 framed · small · route build,code-review,qa");
  assert.match(readFileSync(join(logbook, "tasks.tsv"), "utf8"), /\nT1\t--why=x first\t/);
  assert.equal((await call("task_add", { title: "bad", size: "small", risk: "bogus" })).error,
    "sage: unknown: bogus. Risks: auth, data, schema, money, secrets, input. Blocks: design, arena, pe, build, code-review, security-review, ux-review, qa, investigate, evidence-review");
  assert.match((await call("task_add", { title: "bad", size: "huge" })).error, /^Input validation error: .*size/);
  assert.match((await call("task_add", { title: "bad", size: "small", colour: "red" })).error, /^Input validation error: .*colour/);

  assert.equal((await call("task_set", { task: "T1", fields: { state: "merged" } })).error, "sage: T1 cannot go from framed to merged. Next: designing, briefed");
  assert.equal(await call("task_set", { task: "T1", fields: { state: "briefed", branch: "codex/t1-a" } }), "T1 briefed · small · round 0 · route build,code-review,qa · codex/t1-a");

  assert.match((await call("run_add", { task: "T1", role: "boss" })).error, /^sage: "boss" is not a role of a run\./);
  assert.equal(await call("run_add", { task: "T1", role: "lead", branch: "codex/t1-a" }), "R1 running · lead on T1 · codex/t1-a");
  assert.equal(await call("run_done", { run: "R1", status: "done" }), "R1 done");
  assert.match((await call("run_done", { run: "R1", status: "failed" })).error, /^sage: R1 already ended as done: a run ends once\./);
  assert.match(readFileSync(join(logbook, "runs.tsv"), "utf8"), /\nR1\tT1\tlead\t/);

  await call("task_set", { task: "T1", fields: { state: "building" } });
  await call("task_set", { task: "T1", fields: { state: "reviewing" } });
  assert.equal((await call("finding_add", { task: "T9", source: "code-reviewer", severity: "medium", summary: "x" })).error, "sage: no task T9. The latest: T1.");
  assert.equal(await call("finding_add", { task: "T1", source: "code-reviewer", severity: "medium", summary: "a.js:1 bad" }), "F-T1-1 open · medium · T1");
  assert.equal((await call("finding_triage", { task: "T1", key: "F-T1-1", decision: "dismiss" })).error, "sage: missing --reason for a dismissal");
  assert.equal(await call("finding_triage", { task: "T1", key: "F-T1-1", decision: "fix" }), "F-T1-1 open · fix");
  assert.equal(await call("round", { task: "T1" }), "T1 repairing · round 1 of 3 · fix F-T1-1 · re-run code-reviewer on the repair's diff");
  assert.match((await call("round", { task: "T9" })).error, /^sage: no task T9/);
  assert.equal((await call("finding_close", { task: "T1", key: "F-T1-9" })).error, "sage: no finding F-T1-9 on T1. The latest: F-T1-1.");
  assert.equal(await call("finding_close", { task: "T1", key: "F-T1-1" }), "F-T1-1 closed · fix");
  await call("finding_add", { task: "T1", source: "qa", severity: "high", summary: "b.js:2 crash" });
  assert.match((await call("finding_move", { task: "T1", key: "F-T1-2", to: "Follow up" })).error, /^sage: F-T1-2 is high, so it blocks T1 until it is fixed/);
  await call("finding_add", { task: "T1", source: "qa", severity: "low", summary: "c.js:3 slow" });
  assert.equal(await call("finding_move", { task: "T1", key: "F-T1-3", to: "Follow up" }), "F-T1-3 moved to T2 as F-T2-1 · T2 framed · small · route build,code-review,qa");

  assert.match((await call("verdict", { task: "T1", kind: "checks-pass", sha: "abc" })).error, /^sage: "abc" is not a full commit SHA/);
  assert.equal(await call("verdict", { task: "T1", kind: "checks-pass", sha: SHA }), "T1 checks-pass · 1111111 · cycle 1");
  assert.match(readFileSync(join(logbook, "ledger.tsv"), "utf8"), new RegExp(`\\nT1\\t\\t${SHA}\\tchecks-pass\\t1\\t`));
  assert.equal((await call("merge_check", { sha: SHA })).error, "sage: T1 has open findings: F-T1-2. Triage and close them first.");

  assert.equal(await call("log", { task: "T1", decision: "T1 kept", why: "a test" }), "logged");
  assert.match((await call("log", { task: "T1", decision: "--why=x", why: "y" })).error, /^Input validation error: .*does not start with --/);
  assert.match(await call("standing"), /^# Standing orders\n/);
  assert.equal(await call("standing_add", { order: "Run the checks." }), "standing order 5 added");
  assert.match(readFileSync(join(logbook, "standing.md"), "utf8"), /\n5\. Run the checks\.\n$/);
  assert.equal((await call("standing_add", { order: "" })).error, "sage: missing the order's text");

  const pages = await call("pages", { task: "T1" });
  assert.match(pages, new RegExp(`^${s.env.SAGE_WORKTREES}/project-[0-9a-f]{6}/pages/T1$`));
  writeFileSync(join(pages, "plan.md"), "# Plan\n");
  assert.match(await call("pages", { task: "T1", record: join(pages, "plan.md") }), /plan\.md/);
  assert.match((await call("pages", { task: "T1", record: join(s.dir, "elsewhere.md") })).error, /^sage: .*elsewhere\.md is not a file in .*pages\/T1\. Save the page there first\./);

  assert.match((await call("gate_add", { task: "T1", question: "Ship it?", options: "yes|no", recommend: "maybe" })).error, /^sage: --recommend is one of the options/);
  assert.equal(await call("gate_add", { task: "T1", question: "Ship it?", options: "yes|no", recommend: "yes" }), "G1 open · Ship it?");
  assert.match((await call("gate_answer", { gate: "G1", option: 9 })).error, /^sage: gate answer G1 takes --option <n>/);
  assert.equal(await call("gate_answer", { gate: "G1", option: 1 }), "G1 answered · yes");
});

test("merge_check passes for a head with its clean cycle", async (t) => {
  const { call } = await connect(t);
  await call("init");
  await call("task_add", { title: "one", size: "tiny" });
  await call("task_set", { task: "T1", fields: { state: "briefed", branch: "codex/t1-a" } });
  assert.equal((await call("merge_check", { sha: SHA })).error, `sage: no verdicts recorded for ${SHA}. Record the reviews and QA with sage verdict first.`);
  await call("verdict", { task: "T1", kind: "checks-pass", sha: SHA });
  assert.equal(await call("merge_check", { sha: SHA }), "T1 may merge: 1 clean cycle on this SHA");
});
