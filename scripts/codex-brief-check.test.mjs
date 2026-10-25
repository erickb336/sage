import "./test-env.mjs"; // first: no variable of the developer's shell changes a result
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The brief check of the Codex plugin (T462, form A of T463), through Codex 0.160.0's hook input and output shapes. The
// inputs are the SubagentStart and PostToolUse inputs that stock Codex 0.160.0 sent in run R1657 (paths replaced). The
// built hook runs as Codex runs it: JSON on stdin, JSON on stdout, with a scratch CODEX_HOME and logbook.
const HOOK = fileURLToPath(new URL("../plugins/sage-codex/hooks/brief-hook.mjs", import.meta.url));
const TOOL = fileURLToPath(new URL("../plugins/sage-codex/skills/sage/sage.mjs", import.meta.url));
const { recordBrief, readBrief } = await import(HOOK);
const { missingBriefFields, briefSections } = await import(new URL("../plugins/sage-codex/core/index.mjs", import.meta.url));

const FIELDS = ["GOAL", "SCOPE", "CONTEXT", "DECISIONS", "ACCEPTANCE", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"];
const brief = (skip = []) => FIELDS.filter((f) => !skip.includes(f)).map((f) => (f === "FORBIDDEN" ? "FORBIDDEN: never push to main.\nNever run real ps." : `${f}: the ${f.toLowerCase()} of T1.`)).join("\n");
const NO_BRIEF = "sage: no checked brief for this task.";

/** A git project with a Codex logbook (init through the state tool), and the hook run with that CODEX_HOME. */
function world(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-codex-brief-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = join(dir, "project");
  spawnSync("git", ["init", "-q", "-b", "sage/t1", project]);
  const { SAGE_HOME, ...inherited } = process.env;
  const env = { ...inherited, HOME: join(dir, "home"), CODEX_HOME: join(dir, "codex-home"), SAGE_WORKTREES: join(dir, "worktrees") };
  const sage = (...args) => spawnSync(process.execPath, [TOOL, ...args, "--project", project], { encoding: "utf8", env });
  /** A child's transcript as Codex writes it: the session_meta line with the agent path first. */
  const child = (name) => {
    const file = join(dir, `rollout-${name}.jsonl`);
    writeFileSync(file, JSON.stringify({ timestamp: "2026-10-25T04:16:57.000Z", type: "session_meta", payload: { id: "01a172c7-2925-7dc2-b8f3-9e601eab16f1", agent_path: `/root/${name}`, source: { subagent: { thread_spawn: { depth: 1, agent_path: `/root/${name}`, agent_role: null } } } } }) + "\n");
    return file;
  };
  const common = { session_id: "01a172c7-2843-7653-b62d-eba16eeff35d", cwd: project, model: "gpt-6.1-sol", permission_mode: "bypassPermissions" };
  const start = (name) => ({ ...common, turn_id: "01a172c7-294a-7b50-8504-8a134c07d15e", transcript_path: child(name), hook_event_name: "SubagentStart", agent_id: "01a172c7-2925-7dc2-b8f3-9e601eab16f1", agent_type: "default" });
  const spawned = (task_name) => ({ ...common, turn_id: "01a172c7-287b-7bb2-b962-3d0f44aa69b2", transcript_path: join(dir, "rollout-root.jsonl"), hook_event_name: "PostToolUse",
    tool_name: "collaborationspawn_agent", tool_input: { task_name, message: "# Implementer\n\nGOAL echo ok, then report.\n", fork_turns: "none" }, tool_response: JSON.stringify({ task_name: `/root/${task_name}` }), tool_use_id: "call_1" });
  const send = (input) => {
    const r = spawnSync(process.execPath, [HOOK], { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", env, timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    return JSON.parse(r.stdout);
  };
  const context = (out) => out?.hookSpecificOutput?.additionalContext;
  return { dir, project, env, sage, start, spawned, send, context };
}

test("core reads a brief's fields at the start of a line, as the report check does, and names each missing or empty one", () => {
  assert.deepEqual(missingBriefFields(brief()), []);
  assert.deepEqual(missingBriefFields(brief(["VERIFY", "STANDING"])), ["VERIFY", "STANDING"]);
  assert.deepEqual(missingBriefFields("**GOAL:** x\n- SCOPE y\nCONTEXT\n\nDECISIONS:\nACCEPTANCE z"), ["CONTEXT", "DECISIONS", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"], "CONTEXT and DECISIONS have no text");
  assert.deepEqual(missingBriefFields("the goal is GOAL x\ngoal: y\nGOALS z"), FIELDS, "a field name inside a line, in lower case or as part of a word is no field");
  assert.equal(briefSections(brief()).FORBIDDEN, "never push to main.\nNever run real ps.");
});

test("the start note of a sage child: the standing orders, the FORBIDDEN field and the checked brief", (t) => {
  const w = world(t);
  assert.equal(w.sage("init").status, 0);
  assert.deepEqual(recordBrief(w.project, "sage_implementer_t1", brief(), w.env), []);
  const note = w.context(w.send(w.start("sage_implementer_t1")));
  assert.equal(w.send(w.start("sage_implementer_t1")).hookSpecificOutput.hookEventName, "SubagentStart");
  const [orders, forbidden, recorded] = note.split(/\n\n(?=FORBIDDEN, from|Your checked brief)/);
  assert.match(orders, /^sage: the standing orders of this project, from its logbook\. Follow each one\.\n\n# Standing orders\n/);
  assert.equal(forbidden, "FORBIDDEN, from your checked brief. Never do these:\nnever push to main.\nNever run real ps.");
  assert.equal(recorded, `Your checked brief (sage_implementer_t1), as the chief recorded it:\n\n${brief()}`);
  assert.doesNotMatch(note, /no checked brief/);
});

test("a second run of a role on the same task has its own task name, sage_<role>_t<n>_r<k>, and its own checked brief (R1663-2)", (t) => {
  const w = world(t);
  assert.equal(w.sage("init").status, 0);
  assert.deepEqual(recordBrief(w.project, "sage_code_reviewer_t1_r7", brief(), w.env), []);
  assert.match(w.context(w.send(w.start("sage_code_reviewer_t1_r7"))), /\n\nYour checked brief \(sage_code_reviewer_t1_r7\), as the chief recorded it:\n\nGOAL: /);
  assert.ok(w.context(w.send(w.start("sage_code_reviewer_t1_r8"))).endsWith(`\n\n${NO_BRIEF}`), "the next run has no brief yet");
  assert.deepEqual(w.send(w.spawned("sage_code_reviewer_t1_r7")), {}, "no warning for the checked run");
  for (const bad of ["sage_code_reviewer_t1_r0", "sage_code_reviewer_t1_r", "sage_code_reviewer_r7_t1"]) assert.throws(() => recordBrief(w.project, bad, brief(), w.env), /is not a sage task name: sage_, the role with _ for -, the task, and the run/, bad);
});

test("the start note says that no checked brief is on record: for no brief, and for a brief with a missing field", (t) => {
  const w = world(t);
  assert.equal(w.sage("init").status, 0);
  const none = w.context(w.send(w.start("sage_code_reviewer_t1")));
  assert.match(none, /^sage: the standing orders of this project, from its logbook\./);
  assert.ok(none.endsWith(`\n\n${NO_BRIEF}`), none);
  assert.deepEqual(recordBrief(w.project, "sage_qa_t1", brief(["VERIFY"]), w.env), ["VERIFY"]);
  assert.ok(w.context(w.send(w.start("sage_qa_t1"))).endsWith(`\n\n${NO_BRIEF}`));
  assert.doesNotMatch(w.context(w.send(w.start("sage_qa_t1"))), /the verify of T1/, "an unchecked brief is not given as the brief");
  assert.deepEqual(w.send(w.start("worker_1")), {}, "a child that is not a sage role agent gets no note");
  rmSync(join(w.env.CODEX_HOME, "sage"), { recursive: true, force: true });
  assert.equal(w.context(w.send(w.start("sage_implementer_t1"))), NO_BRIEF, "with no logbook, the one line alone");
});

test("after a spawn with no checked brief, the chief gets a warning that names the missing fields; a checked brief gives none", (t) => {
  const w = world(t);
  assert.equal(w.sage("init").status, 0);
  const none = w.send(w.spawned("sage_implementer_t1"));
  assert.deepEqual(none, { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "sage: sage_implementer_t1 started with no checked brief: no brief is on record, so GOAL, SCOPE, CONTEXT, DECISIONS, ACCEPTANCE, VERIFY, BUDGET, FORBIDDEN, REPORT, STANDING are not checked. Run the brief check: the sage tool `brief` with this task name and the whole brief, fix each missing field, then send the agent the fixed brief with `send_message`." } });
  recordBrief(w.project, "sage_implementer_t1", brief(["BUDGET", "REPORT"]), w.env);
  assert.match(w.context(w.send(w.spawned("sage_implementer_t1"))), /^sage: sage_implementer_t1 started with no checked brief: the recorded brief has no BUDGET, REPORT\. Run the brief check/);
  recordBrief(w.project, "sage_implementer_t1", brief(), w.env);
  assert.deepEqual(w.send(w.spawned("sage_implementer_t1")), {}, "a checked brief");
  assert.deepEqual(w.send(w.spawned("worker_1")), {}, "not a sage role agent");
  assert.deepEqual(w.send({ ...w.spawned("sage_qa_t1"), tool_name: "Bash" }), {}, "another tool");
});

test("an input that the hook cannot read gives one plain line and no note", (t) => {
  const w = world(t);
  const UNREAD = { systemMessage: "sage: the brief check could not read what Codex sent it, so this agent starts without its brief note. If this comes again, update the sage plugin, and keep Codex in the tested range (0.160 to 0.164)." };
  for (const input of ["not json", "null", { hook_event_name: "Stop" }, { ...w.start("sage_qa_t1"), transcript_path: join(w.dir, "none.jsonl") }, { ...w.start("sage_qa_t1"), cwd: 7 }]) {
    assert.deepEqual(w.send(input), UNREAD, JSON.stringify(input));
  }
  assert.equal(readBrief(w.project, "../sage_qa_t1", w.env), null, "a task name that is not a sage task name reads nothing");
  assert.throws(() => recordBrief(w.project, "sage_qa_t1", brief(), w.env), /^Error: no logbook for the project .*project\. Run init first\.$/);
  mkdirSync(join(w.dir, "x"));
  assert.throws(() => recordBrief(w.project, "../x", brief(), w.env), /is not a sage task name/);
});
