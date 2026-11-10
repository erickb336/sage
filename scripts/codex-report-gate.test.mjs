// The Codex report gate and the role text script, run as Codex runs them: JSON on stdin, JSON on stdout.
// The input shape is a SubagentStop input that stock Codex 0.160.0 sent in run R1648 (paths replaced).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REPORT_FIELDS } from "../packages/sage-core/report.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GATE = join(ROOT, "plugins/sage-codex/hooks/report-gate.mjs");
const ROLE = join(ROOT, "plugins/sage-codex/skills/sage/role.mjs");
const TOOL = join(ROOT, "plugins/sage-codex/skills/sage/sage.mjs");
const BRIEF_HOOK = join(ROOT, "plugins/sage-codex/hooks/brief-hook.mjs");
const FULL = "STATUS done\nRESULT PASS\nEVIDENCE echo ok printed ok\nFINDINGS none\nQUESTIONS none\nNOT VERIFIED none\nBRANCH none";
const UNREAD = { systemMessage: "sage: the report check could not read this agent's stop, so it did not check its report." };
const BLOCK = { decision: "block", reason: 'sage: your report has no EVIDENCE, FINDINGS, QUESTIONS, NOT VERIFIED, BRANCH. End with the sage report: STATUS, RESULT, EVIDENCE, FINDINGS, QUESTIONS, NOT VERIFIED, BRANCH, each at the start of a line that is not in a list or a code block, with "none" where a field has nothing.' };

// The three edge cases of core's field reader that the report check uses, as the deleted native server's test had them (T732, T914).
test("missingFields reads a field as a table heading, and no prefixed word and no line indented with a no-break space (T461)", async () => {
  const { missingFields } = await import(pathToFileURL(join(ROOT, "plugins/sage-codex/core/index.mjs")).href);
  const all = ["STATUS", "RESULT", "EVIDENCE", "FINDINGS", "QUESTIONS", "NOT VERIFIED", "BRANCH"];
  assert.deepEqual(missingFields(REPORT_FIELDS, all.map((field) => `| **${field}** |`).join("\n")), []);
  assert.deepEqual(missingFields(REPORT_FIELDS, "prefix STATUS\nRESULTS"), all);
  assert.deepEqual(missingFields(REPORT_FIELDS, "\u00a0STATUS done\nRESULT PASS"), all.filter((field) => field !== "RESULT"));
});

const dir = mkdtempSync(join(tmpdir(), "sage-report-gate-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));
/** A child transcript as Codex writes it: a session_meta line with the agent path, then items. */
function transcript(agentPath) {
  const file = join(dir, `${agentPath.replaceAll("/", "_")}.jsonl`);
  writeFileSync(file, [{ timestamp: "2026-10-25T09:39:59.000Z", type: "session_meta", payload: { id: "01a1726e-61b6-7a01-a9bb-7a01f6164881", agent_path: agentPath, agent_nickname: "Lorentz", source: { subagent: { thread_spawn: { depth: 1, agent_path: agentPath, agent_role: null } } } } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "STATUS done" }] } }].map((row) => JSON.stringify(row)).join("\n") + "\n");
  return file;
}
const stop = (fields) => ({ session_id: "01a1726e-6149-7c53-b2c2-24302efa1ced", turn_id: "01a1726e-61d5-7183-8dd7-d4c0edc9fd41",
  transcript_path: join(dir, "root.jsonl"), agent_transcript_path: transcript("/root/sage_implementer_t1"), cwd: dir,
  hook_event_name: "SubagentStop", model: "gpt-6.1-sol", permission_mode: "bypassPermissions", stop_hook_active: false,
  agent_id: "01a1726e-61b6-7a01-a9bb-7a01f6164881", agent_type: "default", last_assistant_message: "STATUS done\nRESULT PASS", ...fields });
/** Codex's homes in the test folder, so that no gate run reads or writes the real ~/.codex (order 42). */
const ENV = { ...process.env, HOME: join(dir, "home"), CODEX_HOME: join(dir, "codex-home") };
function gate(input) {
  const r = spawnSync("node", [GATE], { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", env: ENV });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("a sage agent's report with every field passes", () => {
  assert.deepEqual(gate(stop({ last_assistant_message: FULL })), {});
});

test("a sage agent's report without fields continues once, with the missing fields", () => {
  assert.deepEqual(gate(stop({})), BLOCK);
  assert.deepEqual(gate(stop({ last_assistant_message: null })), { ...BLOCK, reason: BLOCK.reason.replace("no EVIDENCE", "no STATUS, RESULT, EVIDENCE") });
});

test("a second miss stops the agent with one plain line", () => {
  assert.deepEqual(gate(stop({ stop_hook_active: true })), { systemMessage: "sage: the agent sage_implementer_t1 ended without a full report (no EVIDENCE, FINDINGS, QUESTIONS, NOT VERIFIED, BRANCH). The chief reads it as it is." });
});

test("a task name with a run, or a sage_ name in another letter case, gets the report check too (R1663-2, R1664-6)", () => {
  for (const path of ["/root/sage_code_reviewer_t12_r40", "/root/Sage_QA_T1", "/root/SAGE_implementer_t01"]) {
    assert.deepEqual(gate(stop({ agent_transcript_path: transcript(path) })), BLOCK, path);
  }
});

test("T483: the chief's review child keeps its report with the head that the gate saw, and only that report backs the run's verdict in the Codex state tool", () => {
  // A project with T1 on its branch: the gate reads the branch's head at the stop, as the Claude hook does (R1908-1).
  const project = realpathSync(mkdtempSync(join(dir, "project-")));
  const git = (...args) => spawnSync("git", ["-C", project, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).stdout.trim();
  git("init", "-q", "-b", "codex/t12-a");
  git("commit", "-q", "--allow-empty", "-m", "work");
  let head = git("rev-parse", "HEAD");
  const sage = (...args) => spawnSync("node", [TOOL, ...args, "--project", project], { encoding: "utf8", env: ENV });
  const ok = (...args) => { const r = sage(...args); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  ok("init");
  // T12 and runs from R40: ids of more than one digit, as real ones are (R1933-2).
  for (let k = 1; k <= 12; k++) ok("task", "add", "--priority", "P2", "--title", `t${k}`, "--size", "small");
  for (let k = 1; k < 40; k++) ok("run", "done", ok("run", "add", "T1", "--role", "pe").split(" ")[0], "--status", "failed"); // ended, so the agent cap has room (T952)
  ok("task", "T12", "set", "branch=codex/t12-a");
  const clean = "STATUS done\nRESULT CLEAN\nEVIDENCE npm test passed\nFINDINGS none\nQUESTIONS none\nNOT VERIFIED none\nBRANCH codex/t12-a";
  let threads = 0;
  // A child's start (the brief hook binds the run to the chief's direct child) and its stop (the gate keeps its report).
  const child = (path, thread = `01a1726e-0000-7000-8000-${String(++threads).padStart(12, "0")}`) => {
    const file = join(dir, `child-${threads}-${path.replaceAll("/", "_")}.jsonl`);
    writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: thread, agent_path: path } }) + "\n");
    return file;
  };
  const begin = (file) => assert.equal(spawnSync("node", [BRIEF_HOOK], { input: JSON.stringify({ hook_event_name: "SubagentStart", session_id: "s", transcript_path: file, cwd: project }), encoding: "utf8", env: ENV }).status, 0);
  const end = (file, message = clean) => gate(stop({ agent_transcript_path: file, cwd: project, last_assistant_message: message }));
  const verdict = (run, sha = head) => sage("verdict", "T12", "--kind", "review-clean", "--sha", sha, "--run", run);
  const run = () => ok("run", "add", "T12", "--role", "code-reviewer").split(" ")[0];
  // The bound child's report, with no SHA of its own, backs review-clean on the head that the gate saw.
  assert.equal(run(), "R40", "the runs have two-digit ids");
  ok("run", "done", "R40", "--status", "done", "--tokens", "1");
  const kept = run(), mine = child(`/root/sage_code_reviewer_t12_${kept.toLowerCase()}`);
  begin(mine);
  assert.deepEqual(end(mine), {});
  ok("run", "done", kept, "--status", "done", "--tokens", "1");
  assert.equal(verdict(kept).status, 0, "the kept CLEAN report backs review-clean on the head");
  for (const field of REPORT_FIELDS) {
    const id = run(), file = child(`/root/sage_code_reviewer_t12_${id.toLowerCase()}`);
    const message = clean.split("\n").filter(line => !line.startsWith(`${field} `)).join("\n");
    begin(file);
    assert.equal(end(file, message).decision, "block", `${field}: the first stop asks for correction`);
    const second = gate(stop({ agent_transcript_path: file, cwd: project, last_assistant_message: message, stop_hook_active: true }));
    assert.equal(second.decision, undefined, `${field}: the second stop still exits`);
    const book = ok("logbook"), saved = JSON.parse(readFileSync(join(book, "kept", `${id}.json`), "utf8"));
    assert.equal(saved.text, message, `${field}: the incomplete text stays available`);
    assert.equal(saved.sha, head, "the unchanged branch supplies its SHA");
    ok("run", "done", id, "--status", "done", "--tokens", "1");
    const before = readFileSync(join(book, "ledger.tsv"), "utf8"), refused = verdict(id);
    assert.equal(refused.status, 1, `${field}: the second stop cannot back a verdict`);
    assert.match(refused.stderr, /kept report cannot be read/);
    assert.equal(readFileSync(join(book, "ledger.tsv"), "utf8"), before);
  }
  // The branch moves during the review: the tip at the start is not the head at the stop, so the gate keeps no commit,
  // and a report whose BRANCH names no full SHA backs no verdict on the new head (R1933-1).
  const moved = run(), during = child(`/root/sage_code_reviewer_t12_${moved.toLowerCase()}`);
  begin(during);
  git("commit", "-q", "--allow-empty", "-m", "pushed during the review");
  const newer = git("rev-parse", "HEAD");
  assert.deepEqual(end(during), {});
  ok("run", "done", moved, "--status", "done", "--tokens", "1");
  assert.match(verdict(moved, newer).stderr, new RegExp(`^sage: ${moved}'s report names no full 40-character head SHA in BRANCH, and the hook saw none`), "the new head is not the reviewed commit");
  head = newer; // the reviews below start on the new head
  // A child of a child with the run's name binds nothing and keeps nothing; the real child's report stays its own (R1908-3).
  const nested = run(), sub = child(`/root/sage_qa_t12_r1/sage_code_reviewer_t12_${nested.toLowerCase()}`), real = child(`/root/sage_code_reviewer_t12_${nested.toLowerCase()}`);
  begin(sub);
  begin(real);
  assert.deepEqual(end(sub, clean.replace("CLEAN", "PASS")), {});
  assert.deepEqual(end(real, "STATUS done\nRESULT FINDINGS\nEVIDENCE x\nFINDINGS\n- K1 high a.js:1 data loss\nQUESTIONS none\nNOT VERIFIED none\nBRANCH codex/t12-a"), {});
  ok("run", "done", nested, "--status", "done", "--tokens", "1");
  assert.match(verdict(nested).stderr, /report has 1 medium or high finding/, "the canned PASS of the sub-child was not kept");
  // Another thread with the same task name: its report is not kept, and the gate says so to the chief.
  const twice = run(), first = child(`/root/sage_code_reviewer_t12_${twice.toLowerCase()}`), second = child(`/root/sage_code_reviewer_t12_${twice.toLowerCase()}`);
  begin(first);
  begin(second);
  assert.deepEqual(end(second), { systemMessage: `sage: ${twice}'s report is not kept: this agent is not the child that started for ${twice}.` });
  assert.deepEqual(end(first), {}, "the bound child's report is kept");
  assert.match(end(first, clean.replace("npm test passed", "a second stop")).systemMessage ?? "", /^sage: R\d+'s report is not kept: (?!this agent)/, "a second report of the bound child is refused, and said");
  // No start, no run in the task name, another role or task, or a first stop without the full report: nothing is kept.
  for (const [why, name, message, start = true] of [["no start", "sage_code_reviewer_t12_<R>", clean, false], ["no run in the task name", "sage_code_reviewer_t1", clean],
    ["another role in the task name", "sage_implementer_t12_<R>", clean], ["another task in the task name", "sage_code_reviewer_t2_<R>", clean],
    ["a first stop without the full report", "sage_code_reviewer_t12_<R>", "STATUS done\nRESULT CLEAN"]]) {
    const id = run(), file = child(`/root/${name.replace("<R>", id.toLowerCase())}`);
    if (start) begin(file);
    gate(stop({ agent_transcript_path: file, cwd: project, last_assistant_message: message }));
    ok("run", "done", id, "--status", "done", "--tokens", "1");
    assert.match(verdict(id).stderr, new RegExp(`^sage: ${id} has no kept report`), why);
  }
});

test("T585: an arena keeps the reports of its candidates and its judge, and a candidate's SHA comes from its own branch", async () => {
  const { tool } = await import(pathToFileURL(TOOL));
  const project = realpathSync(mkdtempSync(join(dir, "arena-")));
  const git = (...args) => spawnSync("git", ["-C", project, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).stdout.trim();
  const commit = (message) => { git("commit", "-q", "--allow-empty", "-m", message); return git("rev-parse", "HEAD"); };
  git("init", "-q", "-b", "codex/t1");
  const base = commit("task branch");
  git("checkout", "-q", "-b", "codex/t1-a");
  const headA = commit("candidate a");
  git("checkout", "-q", "-b", "codex/t1-b", "codex/t1");
  const sage = (...args) => spawnSync("node", [TOOL, ...args, "--project", project], { encoding: "utf8", env: ENV });
  const ok = (...args) => { const r = sage(...args); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  ok("init");
  ok("task", "add", "--priority", "P2", "--title", "arena", "--size", "small");
  ok("task", "T1", "set", "branch=codex/t1");
  const book = ok("logbook"), kept = (id) => JSON.parse(readFileSync(join(book, "kept", `${id}.json`), "utf8"));
  const report = (id) => `STATUS done\nRESULT PASS\nEVIDENCE npm test passed for ${id}\nFINDINGS none\nQUESTIONS none\nNOT VERIFIED none\nBRANCH none`;
  let threads = 0;
  const add = (role, ...args) => ok("run", "add", "T1", "--role", role, ...args).split(" ")[0];
  const spawned = (role, id) => {
    const file = join(dir, `arena-${++threads}.jsonl`);
    writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: `01a1726e-0000-7000-8000-${String(threads).padStart(12, "0")}`, agent_path: `/root/sage_${role}_t1_${id.toLowerCase()}` } }) + "\n");
    return file;
  };
  const start = (file) => assert.equal(spawnSync("node", [BRIEF_HOOK], { input: JSON.stringify({ hook_event_name: "SubagentStart", session_id: "s", transcript_path: file, cwd: project }), encoding: "utf8", env: ENV }).status, 0);
  const finish = (file, text) => gate(stop({ agent_transcript_path: file, cwd: project, last_assistant_message: text }));
  // A child runs from its start (the brief hook binds it) to its stop (the gate keeps its report); `during` runs between them.
  const play = (role, id, during = () => {}) => {
    const file = spawned(role, id);
    start(file);
    during();
    assert.deepEqual(finish(file, report(id)), {});
  };
  // A candidate on its own branch: its report is kept exactly, with the head of that branch, not of the task's branch.
  const a = add("implementer", "--branch", "codex/t1-a", "--candidate", "1");
  play("implementer", a);
  assert.deepEqual([kept(a).text, kept(a).sha, kept(a).role], [report(a), headA, "implementer"]);
  assert.notEqual(headA, base);
  // A candidate that commits during its run keeps the head of its branch at the stop.
  const b = add("implementer", "--branch", "codex/t1-b", "--candidate", "2");
  let headB;
  play("implementer", b, () => { headB = commit("candidate b moves"); });
  assert.deepEqual([kept(b).text, kept(b).sha], [report(b), headB]);
  // So does a judge on its own branch, and a designer.
  const judgeRun = add("arena-judge", "--branch", "codex/t1-judge");
  git("branch", "-q", "codex/t1-judge");
  let headJudge;
  play("arena_judge", judgeRun, () => { git("checkout", "-q", "codex/t1-judge"); headJudge = commit("the judge grafts"); });
  assert.deepEqual([kept(judgeRun).text, kept(judgeRun).sha, kept(judgeRun).role], [report(judgeRun), headJudge, "arena-judge"]);
  ok("run", "done", judgeRun, "--status", "done"); // closes the arena step, so the runs below need no number
  // A branch that the run creates keeps its head at the stop.
  const c = add("designer", "--branch", "codex/t1-c");
  let headC;
  play("designer", c, () => { git("checkout", "-q", "-b", "codex/t1-c"); headC = commit("the design"); });
  assert.deepEqual([kept(c).sha, kept(c).role], [headC, "designer"]);
  // A branch that is gone at the stop gives no SHA. The gate never reads the task's branch instead.
  git("branch", "-q", "codex/t1-d");
  const d = add("implementer", "--branch", "codex/t1-d", "--candidate", "3");
  play("implementer", d, () => git("branch", "-q", "-D", "codex/t1-d"));
  assert.equal(kept(d).sha, "");
  // A review or QA run with --branch of another branch reads the branch of its task, and the other branch does not matter.
  for (const role of ["code-reviewer", "qa"]) {
    const id = add(role, "--branch", "codex/t1-a");
    play(role.replaceAll("-", "_"), id, () => git("branch", "-q", "-f", "codex/t1-a", headB));
    assert.equal(kept(id).sha, base, role);
    git("branch", "-q", "-f", "codex/t1-a", headA);
    ok("run", "done", id, "--status", "failed"); // its report is kept: the run's end frees its place of the agent cap (T952)
  }
  // When the branch of its task moves during the run, it gets no SHA, as a run with no --branch.
  for (const role of ["code-reviewer", "qa"]) {
    const id = add(role, "--branch", "codex/t1-a"), before = git("rev-parse", "codex/t1");
    play(role.replaceAll("-", "_"), id, () => git("branch", "-q", "-f", "codex/t1", headB));
    assert.equal(kept(id).sha, "", role);
    git("branch", "-q", "-f", "codex/t1", before);
    ok("run", "done", id, "--status", "failed");
  }
  // The retained reports compare by digest, as the chief compares them with report_compare.
  // The comparison wants real paths, as the MCP server has them; the folder of the test may sit behind a link.
  const real = realpathSync(dir), here = { ...ENV, HOME: join(real, "home"), CODEX_HOME: join(real, "codex-home") };
  const digest = (text) => createHash("sha256").update(text, "utf8").digest("hex");
  for (const id of [a, b, judgeRun]) {
    assert.deepEqual(tool.compareRetainedReport({ project, task: "T1", run: id, sha256: digest(report(id)) }, here), { status: "match" }, id);
    assert.deepEqual(tool.compareRetainedReport({ project, task: "T1", run: id, sha256: digest(`${report(id)} `) }, here), { status: "mismatch" }, id);
  }
  // A candidate backs no verdict, so a report that is not kept says only what happened.
  const candidate = () => add("implementer", "--branch", `codex/t1-e${++threads}`);
  const other = candidate(), bound = spawned("implementer", other), stranger = spawned("implementer", other);
  start(bound);
  start(stranger);
  assert.deepEqual(finish(stranger, report(other)), { systemMessage: `sage: ${other}'s report is not kept: this agent is not the child that started for ${other}.` });
  const again = candidate(), twice = spawned("implementer", again);
  start(twice);
  assert.deepEqual(finish(twice, report(again)), {});
  assert.deepEqual(finish(twice, `${report(again)}\nAnother report`), { systemMessage: `sage: ${again}'s report is not kept: ${again} already has a kept report, and a report is kept once: this other report of ${again} is not kept.` });
  const late = candidate(), after = spawned("implementer", late);
  ok("run", "done", late, "--status", "blocked");
  start(after);
  assert.deepEqual(finish(after, report(late)), { systemMessage: `sage: ${late}'s report is not kept: no child started for ${late} while it ran.` });
  const ended = candidate(), stopped = spawned("implementer", ended);
  start(stopped);
  ok("run", "done", ended, "--status", "blocked");
  assert.deepEqual(finish(stopped, report(ended)), { systemMessage: `sage: ${ended}'s report is not kept: ${ended} ended as blocked before this stop, so no report is kept.` });
});

test("T483 R1933-2: a review child's task name gives its role, task and run, also for ids of many digits", async () => {
  const { reviewChild } = await import(pathToFileURL(GATE));
  const of = (name, path = `/root/${name}`) => reviewChild({ id: "thread-1", agent_path: path });
  assert.deepEqual(of("sage_code_reviewer_t483_r1932"), { role: "code-reviewer", task: "T483", run: "R1932", thread: "thread-1" });
  assert.deepEqual(of("sage_qa_t12_r40"), { role: "qa", task: "T12", run: "R40", thread: "thread-1" });
  assert.deepEqual(of("sage_security_reviewer_t1_r9"), { role: "security-reviewer", task: "T1", run: "R9", thread: "thread-1" });
  assert.deepEqual(of("sage_implementer_t12_r40"), { role: "implementer", task: "T12", run: "R40", thread: "thread-1" });
  assert.deepEqual(of("sage_arena_judge_t12_r41"), { role: "arena-judge", task: "T12", run: "R41", thread: "thread-1" });
  for (const name of ["sage_lead_t12_r40", "sage_qa_t12", "sage_qa_t012_r40", "sage_qa_t12_r40x", "sage_qa_tdd_rdd"]) assert.equal(of(name), undefined, name);
  assert.equal(of("sage_qa_t12_r40", "/root/sage_qa_t12_r1/sage_qa_t12_r40"), undefined, "a child of a child");
});

test("T552: a team child of its task's lead names its run; any other path under a sage or other name names none", async () => {
  const { reviewChild } = await import(pathToFileURL(GATE));
  const of = (path) => reviewChild({ id: "thread-1", agent_path: path });
  const qa = { role: "qa", task: "T12", run: "R40", thread: "thread-1" };
  assert.deepEqual(of("/root/sage_lead_t12_r1/sage_qa_t12_r40"), qa);
  assert.deepEqual(of("/root/sage_lead_t12/sage_qa_t12_r40"), qa, "a lead's name with no run");
  assert.deepEqual(of("/root/sage_lead_t12_r1/sage_implementer_t12_r41"), { role: "implementer", task: "T12", run: "R41", thread: "thread-1" });
  for (const path of ["/root/sage_lead_t13_r1/sage_qa_t12_r40", "/root/sage_lead_t1_r1/sage_qa_t12_r40", "/root/sage_lead_t123_r1/sage_qa_t12_r40", "/root/sage_pe_t12/sage_qa_t12_r40", "/root/worker/sage_qa_t12_r40",
    "/root/sage_lead_t12_r1/sage_pe_t12_r40", "/root/sage_lead_t12_r1/sage_designer_t12_r40", "/root/sage_lead_t12_r1/sage_lead_t12_r2/sage_qa_t12_r40", "/root/sage_pe_t12/sage_lead_t12_r1/sage_qa_t12_r40", "/other/sage_lead_t12_r1/sage_qa_t12_r40"]) {
    assert.equal(of(path), undefined, path);
  }
});

test("T552: a reviewer under a lead has its report bound and kept, so that it backs a verdict; its first unreadable report gets one fix chance", () => {
  const project = realpathSync(mkdtempSync(join(dir, "lead-project-")));
  const git = (...args) => spawnSync("git", ["-C", project, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).stdout.trim();
  git("init", "-q", "-b", "sage/t1-a");
  git("commit", "-q", "--allow-empty", "-m", "work");
  const head = git("rev-parse", "HEAD");
  const sage = (...args) => spawnSync("node", [TOOL, ...args, "--project", project], { encoding: "utf8", env: ENV });
  const ok = (...args) => { const r = sage(...args); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  ok("init");
  ok("task", "add", "--priority", "P2", "--title", "t", "--size", "small");
  ok("task", "T1", "set", "branch=sage/t1-a");
  assert.match(ok("run", "add", "T1", "--role", "lead"), /^R1 /);
  const clean = "STATUS done\nRESULT CLEAN\nEVIDENCE npm test passed\nFINDINGS none\nQUESTIONS none\nNOT VERIFIED none\nBRANCH sage/t1-a";
  const child = (path, thread) => {
    const file = join(dir, `lead-child-${thread}.jsonl`);
    writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: thread, agent_path: path } }) + "\n");
    return file;
  };
  const begin = (file) => assert.equal(spawnSync("node", [BRIEF_HOOK], { input: JSON.stringify({ hook_event_name: "SubagentStart", session_id: "s", transcript_path: file, cwd: project }), encoding: "utf8", env: ENV }).status, 0);
  const end = (file, message) => gate(stop({ agent_transcript_path: file, cwd: project, last_assistant_message: message }));
  const add = (role) => ok("run", "add", "T1", "--role", role).split(" ")[0];
  const verdict = (run) => sage("verdict", "T1", "--kind", "review-clean", "--sha", head, "--run", run);

  const bound = add("code-reviewer"), file = child(`/root/sage_lead_t1_r1/sage_code_reviewer_t1_${bound.toLowerCase()}`, "thread-a");
  begin(file);
  assert.equal(end(file, "STATUS done\nRESULT MAYBE\nEVIDENCE x\nFINDINGS none\nQUESTIONS none\nNOT VERIFIED none\nBRANCH none").decision, "block", "the one reader reads its report at the first stop");
  assert.deepEqual(end(file, clean), {});
  ok("run", "done", bound, "--status", "done", "--tokens", "1");
  assert.equal(verdict(bound).status, 0, "its kept report backs review-clean on the head that the gate saw");

  // The same rule as a flat child: another thread of that name keeps nothing, and a path under another task's lead binds nothing.
  const twice = add("code-reviewer"), first = child(`/root/sage_lead_t1_r1/sage_code_reviewer_t1_${twice.toLowerCase()}`, "thread-b"), second = child(`/root/sage_lead_t1_r1/sage_code_reviewer_t1_${twice.toLowerCase()}`, "thread-c");
  begin(first);
  begin(second);
  assert.deepEqual(end(second, clean), { systemMessage: `sage: ${twice}'s report is not kept: this agent is not the child that started for ${twice}.` });
  assert.deepEqual(end(first, clean), {});
  const other = add("code-reviewer"), under = child(`/root/sage_lead_t2_r9/sage_code_reviewer_t1_${other.toLowerCase()}`, "thread-d");
  begin(under);
  assert.deepEqual(end(under, clean), {});
  ok("run", "done", other, "--status", "done", "--tokens", "1");
  assert.match(verdict(other).stderr, new RegExp(`^sage: ${other} has no kept report`), "a child under another task's lead backs no verdict");
});

test("F-T551-7: after a spawn with no checked brief, a lead gets the steps that it can take: no message, a fresh agent on a new run", () => {
  const project = realpathSync(mkdtempSync(join(dir, "warn-project-")));
  spawnSync("git", ["init", "-q", project]);
  assert.equal(spawnSync("node", [TOOL, "init", "--project", project], { encoding: "utf8", env: ENV }).status, 0);
  const warn = (extra) => {
    const r = spawnSync("node", [BRIEF_HOOK], { input: JSON.stringify({ hook_event_name: "PostToolUse", session_id: "s", cwd: project, tool_name: "collaborationspawn_agent", tool_input: { task_name: "sage_qa_t1_r7" }, ...extra }), encoding: "utf8", env: ENV });
    return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  };
  const lead = warn({ agent_id: "agent-1" });
  assert.match(lead, /^sage: sage_qa_t1_r7 started with no checked brief: no brief is on record/);
  assert.match(lead, /A lead sends no message, so this agent stays without the note\. Stop it with `interrupt_agent`, end its run as failed with the sage tool `run_done`, add a new run with `run_add`, run the sage tool `brief` with the new run's task name/);
  assert.doesNotMatch(lead, /with `send_message`/);
  assert.match(warn({}), /then send the agent the fixed brief with `send_message`\.$/, "the chief's steps stay");
});

test("T560: a review child's unreadable report gets one fix chance at its first stop, as in the Claude stop gate", () => {
  const unreadable = FULL.replace("RESULT PASS", "RESULT FINDINGS"), message = gate(stop({ agent_transcript_path: transcript("/root/sage_qa_t12_r40"), last_assistant_message: unreadable }));
  assert.equal(message.decision, "block");
  assert.match(message.reason, /^sage: the report check cannot read your report: RESULT is FINDINGS, but FINDINGS is none\. Give each field once/);
  assert.equal(gate(stop({ agent_transcript_path: transcript("/root/sage_qa_t12_r40"), last_assistant_message: unreadable, stop_hook_active: true })).decision, undefined, "the second stop goes through");
  assert.equal(gate(stop({ agent_transcript_path: transcript("/root/sage_qa_t12_r40"), last_assistant_message: FULL })).decision, undefined, "a readable report is not blocked");
  assert.deepEqual(gate(stop({ agent_transcript_path: transcript("/root/sage_lead_t12_r40"), last_assistant_message: unreadable })), {}, "a role that backs no verdict is not read");
  for (const role of ["implementer", "arena_judge"]) assert.equal(gate(stop({ agent_transcript_path: transcript(`/root/sage_${role}_t12_r40`), last_assistant_message: unreadable })).decision, undefined, `${role} backs no verdict, so it is not read`);
});

test("T461: a report that the Claude stop gate refuses cannot pass in Codex: the name of a review child does not matter, and a field obeys the one field rule", () => {
  const stopOf = (path, message, again = false) => gate(stop({ agent_transcript_path: transcript(path), last_assistant_message: message, stop_hook_active: again }));
  // A high finding with no list mark: the reader cannot read it. Each name is a review child that the gate cannot bind to a run.
  const hidden = "STATUS done\nRESULT PASS\nEVIDENCE x\nFINDINGS\nK1 high a.js:1 data loss\nQUESTIONS none\nNOT VERIFIED none\nBRANCH none";
  for (const path of ["/root/sage_qa_t12", "/root/sage_code_reviewer_t12", "/root/sage_security_reviewer_t12", "/root/sage_ux_reviewer_t12", "/root/Sage_QA_T12_R40", "/root/SAGE_CODE_REVIEWER_T12", "/root/sage_pe_t12/sage_qa_t12_r40", "/root/sage_qa"]) {
    const message = stopOf(path, hidden);
    assert.equal(message.decision, "block", path);
    assert.match(message.reason, /^sage: the report check cannot read your report: a line under FINDINGS is not none alone and not a finding in the form - <key> <severity> <summary>: "K1 high a\.js:1 data loss"\./, path);
    assert.equal(stopOf(path, hidden, true).decision, undefined, `${path}: the second stop goes through`);
    assert.deepEqual(stopOf(path, FULL), {}, `${path}: a report that the reader can read passes`);
  }
  for (const path of ["/root/sage_implementer_t12", "/root/sage_pe_t12", "/root/sage_lead_t12", "/root/sage_quality_t12", "/root/explorer"]) assert.deepEqual(stopOf(path, hidden), {}, `${path} backs no verdict, so its FINDINGS are not read`);
  // A field in a list item, on an indented line or in a code block is not a field, for each sage role.
  const noStatus = (form) => FULL.replace("STATUS done", form);
  for (const path of ["/root/sage_implementer_t12", "/root/sage_qa_t12_r40"]) {
    for (const [why, message] of [["a list item", noStatus("- STATUS done")], ["an indented line", noStatus("  STATUS done")], ["a numbered list item", noStatus("1. STATUS done")], ["a code block", noStatus("```\nSTATUS done\n```")]]) {
      assert.equal(stopOf(path, message).reason, BLOCK.reason.replace("no EVIDENCE, FINDINGS, QUESTIONS, NOT VERIFIED, BRANCH", "no STATUS"), `${path}: ${why}`);
    }
  }
});

test("an agent without the sage_ task name passes, with or without a report", () => {
  assert.deepEqual(gate(stop({ agent_transcript_path: transcript("/root/explorer") })), {});
  assert.deepEqual(gate(stop({ agent_transcript_path: transcript("/root/explorer_sage_t1"), last_assistant_message: null })), {});
});

test("an input that the gate cannot read stops nothing and gives one plain line", () => {
  const notMeta = join(dir, "not-meta.jsonl");
  writeFileSync(notMeta, '{"type":"response_item","payload":{}}\n');
  for (const input of ["not json", "null", { ...stop({}), hook_event_name: "Stop" }, stop({ stop_hook_active: "no" }),
    stop({ last_assistant_message: 7 }), stop({ agent_transcript_path: null }), stop({ agent_transcript_path: join(dir, "missing.jsonl") }),
    stop({ agent_transcript_path: notMeta })]) assert.deepEqual(gate(input), UNREAD, JSON.stringify(input));
});

// The tools that the chief and role texts may name. STOCK: the tool lists of stock Codex 0.160.0 in run R1648
// (gpt-6.1-sol: functions, clock and collaboration namespaces; fake-model: the multi_agent_v1 list), with the
// spawn_agent parameters. MCP: the tools of the plugin's sage MCP server (T454, PR 327), read from the server itself.
// V2: the gpt-6.1-sol part of that list, with the tools of multi-agent v2, the only place where a lead runs.
// timeout_ms: the one parameter of wait_agent (run R2221, Q6).
const V2 = ["exec", "wait", "request_user_input", "request_user_input_async", "sleep", "followup_task", "interrupt_agent",
  "list_agents", "send_message", "spawn_agent", "wait_agent", "task_name", "fork_turns", "reasoning_effort", "exec_command",
  "write_stdin", "view_image", "timeout_ms"];
const STOCK = [...V2, "close_agent", "resume_agent", "send_input", "fork_context", "get_goal", "create_goal", "update_goal", "web_search"];
const MCP = Object.keys((await import(pathToFileURL(join(ROOT, "plugins/sage-codex/mcp/state-server.mjs")))).TOOLS);
/** Each tool-like name (snake case in a code span) that a binding text names, except an example sage task name. */
const named = (text) => [...text.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map((m) => m[1]).filter((name) => !/^sage_[a-z_]+_t\d+(?:_r\d+)?$/.test(name));

test("every tool that a Codex chief or role binding names is a stock Codex tool or a sage MCP tool", () => {
  const texts = [JSON.parse(readFileSync(join(ROOT, "plugins/sage-codex/chief-bindings.json"), "utf8")),
    ...Object.values(JSON.parse(readFileSync(join(ROOT, "plugins/sage-codex/role-bindings.json"), "utf8")))]
    .flatMap((bindings) => Object.values(bindings)).join("\n");
  assert.deepEqual(named(texts).filter((name) => !STOCK.includes(name) && !MCP.includes(name)), []);
  assert.doesNotMatch(texts, /admission|preparation|approved worktree tool/i);
  assert.deepEqual(named("use `sage_prepare_task`, then `spawn_agent` as `sage_qa_t3`"), ["sage_prepare_task", "spawn_agent"], "the reader finds a fork-only tool");
});

test("role.mjs prints the role text and the sage report, and refuses an unknown role", () => {
  const r = spawnSync("node", [ROLE, "implementer"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^# Implementer\n\nYou build one task for the chief of staff\./);
  assert.match(r.stdout, /\n# The sage report\n[\s\S]*\nSTATUS {8}done, blocked or question\n/);
  // T586: the arena judge is a Codex child too, with the report and no slot left open.
  const judge = spawnSync("node", [ROLE, "arena-judge"], { encoding: "utf8" });
  assert.equal(judge.status, 0, judge.stderr);
  assert.match(judge.stdout, /^# Arena judge\n[\s\S]*End with the report format included below\.[\s\S]*\n# The sage report\n/);
  assert.doesNotMatch(judge.stdout, /\{\{/);
  // T586: a judge's spawn message holds only this text, so the text itself leaves the pull request to the chief.
  assert.match(judge.stdout, /\n {3}- For a build: leave the pull request to the chief\. Report your branch and head SHA: the chief pushes the branch and opens the pull request\. Do not push, and never run `gh`\.\n/);
  assert.doesNotMatch(judge.stdout, /push your branch|open a draft pull request|as an implementer does|, the pull request\./);
  const bad = spawnSync("node", [ROLE, "chief"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, "");
  assert.equal(bad.stderr, "sage: Unknown child role. Give one role from references/roles.md.\n");
});

test("T925, T946: role.mjs gives each role, and the mode hook gives the chief, the principles of core's role map, and no other principle", async () => {
  const { ROLE_PRINCIPLES } = await import(pathToFileURL(join(ROOT, "plugins/sage-codex/core/index.mjs")).href);
  const { chiefText } = await import(pathToFileURL(join(ROOT, "plugins/sage-codex/hooks/sage-codex-hook.mjs")).href);
  const title = (name) => /^name: (.+)$/m.exec(readFileSync(join(ROOT, "principles", `${name}.md`), "utf8"))[1];
  const role = (name) => {
    const r = spawnSync("node", [ROLE, name], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  // One role in full: its three principles, in the map's order, between the role text and the approvals line.
  const qa = role("qa");
  const part = qa.slice(qa.indexOf("\n# The principles of your role\n"), qa.indexOf("\n# The sage report\n"));
  assert.deepEqual([...part.matchAll(/^## (.+)$/gm)].map(([, t]) => t), ["Prove it works", "Test behaviour, not implementation", "Explain the number"]);
  assert.match(part, /^\n# The principles of your role\n\n## Prove it works\n\nVerify the result by checking the real thing directly\./);
  const all = [...new Set(Object.values(ROLE_PRINCIPLES).flat())];
  for (const [name, principles] of Object.entries(ROLE_PRINCIPLES)) {
    // The Codex chief's text comes from the mode hook, not from role.mjs. The chief and the lead get the path of each one.
    const text = name === "chief-of-staff" ? chiefText() : role(name);
    for (const p of all) {
      const has = ["chief-of-staff", "lead"].includes(name) ? text.includes(`/skills/principle-${p}/SKILL.md\``) : text.includes(`\n## ${title(p)}\n`);
      assert.equal(has, principles.includes(p), `${name} ${p}`);
    }
  }
  // The chief and the lead read their principles from the plugin's own skills: each path is a file.
  const paths = (text) => [...text.matchAll(/`(\/[^`]+\/principle-[a-z-]+\/SKILL\.md)`/g)].map(([, path]) => path);
  assert.equal(paths(chiefText()).length, 4, "the chief's four principles");
  assert.match(chiefText(), /\n\nThe principles of your role: read `\/[^`]+\/skills\/principle-never-block-on-the-human\/SKILL\.md` and `/);
  for (const path of [...paths(chiefText()), ...paths(role("lead"))]) assert.ok(existsSync(path), path);
});

test("T553: role.mjs lead adds the Codex steps to the lead's text, and no other role gets them", () => {
  const r = spawnSync("node", [ROLE, "lead"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^# Lead\n\nYou coordinate one task[\s\S]*\n## Your steps in Codex\n[\s\S]*\n# The sage report\n/);
  // How a lead starts each helper: the name form, the role text from a command that it can run, and the brief.
  assert.match(r.stdout, /`task_name`: `sage_<role>_t<n>_r<k>`, with `_` for `-` in the role, for example `sage_code_reviewer_t12_r41`/);
  assert.match(r.stdout, /`message`: the whole output of step 2, a blank line, then the brief\./);
  const [, node, script] = /Run `(\S+) (\S+) <role>`/.exec(r.stdout) ?? [];
  assert.equal(node, process.execPath, "the command uses this Node executable");
  assert.equal(script, join(ROOT, "plugins/sage-codex/skills/sage/role.mjs"), "the real path of the script");
  assert.match(spawnSync(node, [script, "qa"], { encoding: "utf8" }).stdout, /^# QA\n/, "the command that the lead runs prints a helper's role text");
  // How it waits, reads and records, and that its messages are refused.
  assert.match(r.stdout, /Call `wait_agent` again until that helper's report comes\./);
  assert.match(r.stdout, /Save the whole report verbatim with `pages`/);
  for (const tool of ["run_add", "run_done", "brief", "finding_add", "finding_triage", "finding_close", "round", "verdict", "task_set"]) assert.ok(r.stdout.includes(`\`${tool}\``), tool);
  assert.match(r.stdout, /The gate refuses `send_message`, `followup_task` and `send_input` from a lead/);
  assert.match(r.stdout, /The `checks-pass` and `checks-fail` verdicts are the chief's/);
  // The carried limits, each with what to do.
  assert.match(r.stdout, /record every finding of the report, before you end its run/);
  assert.match(r.stdout, /Nothing refuses a lead that leaves one out: Claude's hook checks the count of medium and high findings \(its gap rule\), and the Codex gate does not/);
  assert.match(r.stdout, /`collab spawn failed: agent thread limit reached` means that no thread is free/);
  assert.doesNotMatch(r.stdout, /\{\{|<role\.mjs>/);
  // Each tool that the steps give a lead exists on v2. The two v1 names are there only as refusals (F-T553-1).
  assert.deepEqual(named(r.stdout).filter((name) => !V2.includes(name) && !MCP.includes(name)), ["send_input", "resume_agent"], "each tool that the steps name exists on v2");
  assert.match(r.stdout, /stop it with `interrupt_agent`, end its run as failed/);
  assert.match(r.stdout, /wait for a helper that runs, then call `spawn_agent` again/);
  // The tools' real inputs (F-T553-2, F-T553-3, F-T553-8).
  assert.match(r.stdout, /For an implementer, also give `branch`, the task's branch\./);
  assert.match(r.stdout, /`\{"task": "T12", "fields": \{"state": "reviewing"\}\}`/);
  assert.match(r.stdout, /`finding_triage`: give `task`, `key` and `decision`: `fix`/);
  assert.match(r.stdout, /`gh pr create --head <branch> --title <title> --body <body>`/);
  for (const role of ["implementer", "qa", "pe"]) assert.doesNotMatch(spawnSync("node", [ROLE, role], { encoding: "utf8" }).stdout, /Your steps in Codex/, role);
});

test("T603: the lead's text holds the pilot's rules, each role that writes git or reaches the network gets the approval line, and each other role gets the short line", () => {
  const text = (role) => spawnSync("node", [ROLE, role], { encoding: "utf8" }).stdout;
  const lead = text("lead");
  assert.match(lead, /\*\*No spawn tools\.\*\* sage on Codex needs a multi-agent v2 model for the chief and each child\. When your tools have no `spawn_agent` in the `collaboration` namespace, start nothing, and report STATUS blocked at once with the reason that you have no spawn tools\./);
  assert.match(lead, /Do not end your turn while a helper runs: a helper's report starts no turn/);
  assert.match(lead, /Call `wait_agent`\. It takes only `timeout_ms` \(at most 3600000, one hour\), and it has no target\. It wakes on any message or at the time-out, and it returns no report\./);
  assert.match(lead, /Codex allows 4 threads by default: the chief, you and 2 helpers, so a third helper at the same time fails\./);
  assert.match(lead, /A finished or interrupted helper frees its thread\./);
  assert.match(lead, /with the sage tools\. They ask for no approval\./);
  assert.doesNotMatch(lead, /AgentLimitReached|the chief does the lead's work|Multi-agent v1|wait_agent` for the helper/);
  const line = /\n\*\*Approvals in Codex\.\*\* Read the active sandbox and approval policy\.[\s\S]*With approval policy `never`, never request escalated permissions\.[\s\S]*Continue independent allowed work\.[\s\S]*# The sage report\n/;
  for (const role of ["lead", "implementer", "designer", "arena-judge"]) assert.match(text(role), line, role);
  // A role that does not build gets the short line: a sandbox refusal never reads as a failed check or a finding.
  const short = /\n\*\*Sandbox refusals in Codex\.\*\* Follow the active approval policy\.[\s\S]*A refusal is not a failed check or a finding\.[\s\S]*Continue independent allowed work\.[\s\S]*# The sage report\n/;
  for (const role of ["pe", "code-reviewer", "security-reviewer", "ux-reviewer", "qa", "investigate", "evidence-review"]) {
    assert.match(text(role), short, role);
    assert.doesNotMatch(text(role), /Approvals in Codex/, role);
  }
  for (const role of ["lead", "implementer", "designer", "arena-judge"]) assert.doesNotMatch(text(role), /Sandbox refusals in Codex/, role);
});

test("T553: a lead's steps record a report's findings and verdict first, and triage fix after (F-T552-22)", () => {
  const text = spawnSync("node", [ROLE, "lead"], { encoding: "utf8" }).stdout;
  const section = text.slice(text.indexOf("**A report with findings.**"), text.indexOf("**The pull request.**"));
  const steps = ["1. `finding_add`", "2. `run_done`", "3. `verdict`: for a medium or high finding, give `findings`", "4. `finding_triage`", "5. `round`"].map((step) => section.indexOf(step));
  assert.ok(steps.every((at) => at > 0), String(steps));
  assert.deepEqual(steps, [...steps].sort((a, b) => a - b), "the order of the steps");
  assert.match(text, /`finding_move` stays the chief's tool/);
});

test("T553: the helper name of a lead's steps is one that keeps the helper's report, and the same name with no run keeps none (F-T552-25)", async () => {
  const { reviewChild } = await import(pathToFileURL(GATE));
  const text = spawnSync("node", [ROLE, "lead"], { encoding: "utf8" }).stdout;
  const [, name] = /`task_name`: `sage_<role>_t<n>_r<k>`.*?for example `(sage_[a-z_]+_t\d+_r\d+)`/.exec(text) ?? [];
  assert.equal(name, "sage_code_reviewer_t12_r41");
  const under = (child) => reviewChild({ id: "thread-1", agent_path: `/root/sage_lead_t12_r40/${child}` });
  assert.deepEqual(under(name), { role: "code-reviewer", task: "T12", run: "R41", thread: "thread-1" });
  assert.equal(under(name.replace(/_r\d+$/, "")), undefined, "the warning in the steps: no run, no kept report");
  assert.match(text, /A name with no run still starts, but sage keeps no report for that run, and no verdict can use it/);
});

// T83: run the public renderer from the generated package, as the chief does.
for (const [role, heading] of [["investigate", "# Investigate"], ["evidence-review", "# Evidence review"]]) {
  test(`T83 public role renderer supplies ${role} and the report contract`, () => {
    const result = spawnSync(process.execPath, [ROLE, role], { encoding: "utf8", env: ENV });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.startsWith(`${heading}\n`), result.stdout);
    assert.match(result.stdout, /read-only/);
    assert.match(result.stdout, /# The sage report/);
    for (const field of REPORT_FIELDS) assert.match(result.stdout, new RegExp(`^${field} +`, "m"));
  });
}

test("T83 public role allowlist rejects aliases and file paths without reading them", () => {
  for (const role of ["investigator", "evidence_reviewer", "evidence_review", "Investigate", "../references/investigate", "toString", "__proto__"]) {
    const result = spawnSync(process.execPath, [ROLE, role], { encoding: "utf8", env: ENV });
    assert.equal(result.status, 1, role);
    assert.equal(result.stdout, "", role);
    assert.match(result.stderr, /Unknown child role/, role);
  }
});

for (const role of ["investigate", "evidence-review", "pe", "designer"]) {
  const taskNumber = ["pe", "designer"].includes(role) ? "T85" : "T83";
  test(`${taskNumber} ${role}: exact hook retention without SHA, identity refusals and honest outcomes`, t => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), "sage-investigation-")));
    t.after(() => rmSync(project, { recursive: true, force: true }));
    const fixtureEnv = { ...ENV, SAGE_HOME: join(project, "sample-logbook") };
    assert.equal(spawnSync("git", ["init", "-q", project]).status, 0);
    const sage = (...args) => spawnSync(process.execPath, [TOOL, ...args, "--project", project], { encoding: "utf8", env: fixtureEnv });
    const ok = (...args) => { const r = sage(...args); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
    ok("init");
    ok("task", "add", "--priority", "P2", "--title", "SAMPLE: role report", "--size", taskNumber === "T85" ? "small" : "investigate");
    const book = ok("logbook"), ledger = () => readFileSync(join(book, "ledger.tsv"), "utf8"), before = ledger();
    let threads = 0;
    let writers = 0;
    const run = () => ok("run", "add", "T1", "--role", role, ...(role === "designer" ? ["--branch", `codex/t1-sample-${++writers}`] : [])).split(" ")[0];
    // Synthetic hook metadata in a disposable fixture, never native execution receipts.
    const child = (id, { path = `/root/sage_${role.replaceAll("-", "_")}_t1_${id.toLowerCase()}`, thread = `sample-${++threads}` } = {}) => {
      const file = join(project, `sample-${++threads}.jsonl`);
      writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: thread, agent_path: path } }) + "\n");
      return file;
    };
    const begin = file => {
      const r = spawnSync(process.execPath, [BRIEF_HOOK], { input: JSON.stringify({ hook_event_name: "SubagentStart", session_id: "sample-root", transcript_path: file, cwd: project }), encoding: "utf8", env: fixtureEnv });
      assert.equal(r.status, 0, r.stderr);
    };
    const end = (file, text, again = false) => {
      const r = spawnSync(process.execPath, [GATE], { input: JSON.stringify({ hook_event_name: "SubagentStop", agent_transcript_path: file, cwd: project, last_assistant_message: text, stop_hook_active: again }), encoding: "utf8", env: fixtureEnv });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    const saved = id => join(book, "kept", `${id}.json`);
    for (const status of ["done", "blocked", "question"]) {
      const id = run(), file = child(id);
      const text = `STATUS ${status}\nRESULT ${status === "done" ? "CLEAN" : status}\nEVIDENCE Sample T1 ${id} ${role}: no build or SHA\nFINDINGS none\nQUESTIONS ${status === "question" ? "Sample product decision remains open" : "none"}\nNOT VERIFIED installed execution\nBRANCH none\n`;
      begin(file);
      assert.deepEqual(end(file, text), {});
      const kept = JSON.parse(readFileSync(saved(id), "utf8"));
      assert.deepEqual([kept.task, kept.run, kept.role, kept.sha, kept.text], ["T1", id, role, "", text]);
      assert.deepEqual(end(file, text), {}, "an exact retry keeps the first report");
      assert.match(end(file, text + "Different report").systemMessage, /already has a kept report/);
      assert.equal(readFileSync(saved(id), "utf8"), JSON.stringify(kept));
      // One token is a sample fixture value, not measured agent usage.
      ok("run", "done", id, "--status", status, "--tokens", "1");
      if (taskNumber === "T85") {
        const refused = sage("verdict", "T1", "--kind", "review-clean", "--sha", "1".repeat(40), "--run", id);
        assert.equal(refused.status, 1);
        assert.match(refused.stderr, /backs no review-clean verdict/);
      }
      assert.equal(ledger(), before, `${status}: retention and run_done grant no verdict`);
    }
    for (const issue of ["no start", "no run", "no thread", "wrong task", "wrong role", "nested", "ended", "ended after start"]) {
      const id = run(), name = `sage_${role.replaceAll("-", "_")}_t1_${id.toLowerCase()}`;
      const path = issue === "no run" ? `/root/sage_${role.replaceAll("-", "_")}_t1`
        : issue === "wrong task" ? `/root/${name.replace("_t1_", "_t2_")}`
        : issue === "wrong role" ? `/root/sage_qa_t1_${id.toLowerCase()}`
        : issue === "nested" ? `/root/worker/${name}` : `/root/${name}`;
      const file = child(id, { path, ...(issue === "no thread" ? { thread: "" } : {}) });
      if (issue === "ended") ok("run", "done", id, "--status", "blocked");
      if (issue !== "no start") begin(file);
      if (issue === "ended after start") ok("run", "done", id, "--status", "blocked");
      end(file, FULL);
      assert.equal(existsSync(saved(id)), false, issue);
    }
    const id = run(), first = child(id), conflicting = child(id);
    begin(first); begin(conflicting);
    assert.match(end(conflicting, FULL).systemMessage, /not the child that started/);
    assert.equal(existsSync(saved(id)), false);
    const incomplete = "STATUS blocked\nRESULT missing evidence";
    assert.equal(end(first, incomplete).decision, "block");
    assert.equal(existsSync(saved(id)), false);
    assert.match(end(first, incomplete, true).systemMessage, /ended without a full report/);
    assert.equal(JSON.parse(readFileSync(saved(id), "utf8")).text, incomplete);
    assert.equal(ledger(), before, "identity failures and incomplete reports grant no verdict");
  });
}
