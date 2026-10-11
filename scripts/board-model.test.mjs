import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { readBoardSources } from "../packages/sage-core/board-reader.mjs";
const now = "2026-10-08T20:00:00.000Z";
const head = "a".repeat(40), old = "b".repeat(40);
const task = (id, state, extra = {}) => ({ id, title: "Sample", size: "small", risk: "", route: "build,code-review,qa", state, branch: "", pr: "", round: "0", keys: "", ...extra });
const source = (id, tasks, tables = {}, records = []) => ({ id, label: id, diagnostics: [], projects: [{ key: `${id}/sample-abcdef`, name: "sample-abcdef", diagnostics: [], tables: { tasks, ...tables }, observations: { version: 1, records } }] });
const observation = (kind, data, extra = {}) => ({ id: "O1", task: "T1", kind, source: "sample recorder", basis: "observed", observedAt: now, recordedAt: now, data, ...extra });

test("board columns use every required state and completion dates, not latest activity", () => {
  const states = ["framed", "designing", "awaiting-you", "briefed", "building", "repairing", "held", "replan", "reviewing", "verifying", "verified", "pr-ready", "merged", "concluded", "abandoned"];
  const tasks = states.map((state, i) => task(`T${i + 1}`, state));
  const records = [observation("completion", { state: "merged", at: "2026-10-01T20:00:00Z" }, { task: "T13" }), observation("completion", { state: "concluded", at: "2026-10-01T19:59:59Z" }, { task: "T14" })];
  const model = buildBoardModel([source("one", tasks, { decisions: [{ task: "T14", at: now, decision: "sample recent activity" }] }, records)], { now });
  assert.deepEqual(model.columns.map(c => c.tasks.length), [1, 2, 5, 2, 2, 1]);
  assert.equal(model.tasks.find(t => t.id === "T15").column, null);
  assert.equal(model.tasks.find(t => t.id === "T14").visible, false);
});

test("same task IDs in different sources stay separate and owner counts count tasks once", () => {
  const tables = { gates: [{ id: "G1", task: "T1", question: "First", answer: "", recommendation: "Choose A" }, { id: "G2", task: "T1", question: "Second", answer: "" }] };
  const model = buildBoardModel([source("one", [task("T1", "held")], tables), source("two", [task("T1", "framed")])], { now });
  assert.equal(model.counts.tasks, 2);
  assert.equal(model.counts.needsOwner, 1);
  assert.notEqual(model.tasks[0].key, model.tasks[1].key);
  assert.equal(model.needsOwner[0].reasons.length, 3);
});

test("review steps use the recorded current head and run role, with inferred work counted separately", () => {
  const tables = { runs: [{ id: "R1", task: "T1", role: "security-reviewer", status: "running" }], ledger: [{ task: "T1", pr: "12", sha: old, kind: "qa-pass", cycle: "1", at: now }, { task: "T1", pr: "12", sha: head, kind: "findings", cycle: "1", run: "R1", at: now }] };
  const records = [observation("pr", { number: 12, head, state: "open" }), observation("run", { run: "R1", provider: "sample-provider", head, cycle: 1 })];
  const model = buildBoardModel([source("one", [task("T1", "reviewing", { pr: "12", risk: "auth", route: "build,code-review,security-review,qa" })], tables, records)], { now });
  const steps = model.tasks[0].cycles[0].steps;
  assert.equal(steps.find(s => s.role === "qa").status, "pending");
  assert.equal(steps.find(s => s.role === "code-review").status, "pending");
  assert.equal(steps.find(s => s.role === "security-review").status, "failed");
  assert.equal(model.counts.recordedAgents, 1);
  assert.equal(model.counts.inferredWork, 0);
  const inferred = buildBoardModel([source("two", [task("T1", "framed", { pr: "12", branch: "codex/t1-sample" })], {}, records.filter(r => r.kind === "pr"))], { now });
  assert.equal(inferred.counts.inferredWork, 1);
  assert.equal(inferred.counts.recordedAgents, 0);
  assert.equal(inferred.tasks[0].pr, "12");
});


test("same-second later clean verdict clears the owner failure; later failure restores it", () => {
  const records = [observation("pr", { number: 12, head, state: "open" })];
  const failed = { task: "T1", pr: "12", sha: head, kind: "qa-fail", cycle: "1", at: now };
  const clean = { ...failed, kind: "qa-pass" };
  const make = ledger => buildBoardModel([source("one", [task("T1", "reviewing", { pr: "12" })], { ledger }, records)], { now }).tasks[0];
  assert.equal(make([failed, clean]).reasons.some(reason => reason.kind === "qa-fail"), false);
  assert.equal(make([clean, failed]).reasons.some(reason => reason.kind === "qa-fail"), true);
});


test("task detail derives brief fields and skipped loop stages from recorded route", () => {
  const input = source("one", [task("T1", "building")], {}, [observation("artifact", { type: "brief", label: "Brief" })]);
  input.projects[0].contents = { O1: { verified: true, text: "**GOAL:** Ship the board\nSCOPE: This task\n## ACCEPTANCE\nAll views agree\n- Keep sources separate\nVERIFY: Tests" } };
  const result = buildBoardModel([input], { now }).tasks[0];
  assert.equal(result.briefFields.goal, "Ship the board");
  assert.equal(result.briefFields.acceptance, "All views agree\n- Keep sources separate");
  assert.equal(result.loop.steps.find(step => step.label === "design").status, "skipped");
  assert.equal(result.loop.steps.find(step => step.label === "build").status, "current");
  assert.equal(result.loop.steps.find(step => step.label === "framed").status, "done");
});


test("Done accepts the recorded completion transition, never unrelated later decisions", () => {
  const input = source("one", [task("T1", "merged")], { decisions: [{ task: "T1", at: now, decision: "state merged", why: "task set" }] });
  assert.equal(buildBoardModel([input], { now }).columns.find(column => column.key === "done").tasks.length, 1);
  input.projects[0].tables.decisions = [{ task: "T1", at: now, decision: "changed title", why: "sample" }];
  assert.equal(buildBoardModel([input], { now }).columns.find(column => column.key === "done").tasks.length, 0);
});


test("review cycle requirements take the largest applicable size and risk count", () => {
  const input = source("one", [task("T1", "reviewing", { size: "large", risk: "auth" }), task("T2", "reviewing", { size: "investigate", route: "investigate,evidence-review" })]);
  input.config = { "cycles.small": 3, "cycles.large": 2, "cycles.risk": 2 };
  assert.equal(buildBoardModel([input], { now }).tasks[0].requiredCycles, 3);
  input.config = {};
  assert.equal(buildBoardModel([input], { now }).tasks[1].requiredCycles, 1);
});


test("recorded running PE work selects the PE stage during design", () => {
  const input = source("one", [task("T1", "designing", { size: "large", route: "design,pe,build,code-review,qa" })], { runs: [{ id: "R1", task: "T1", role: "pe", status: "running" }] });
  const result = buildBoardModel([input], { now }).tasks[0];
  assert.equal(result.loop.steps.find(step => step.label === "PE check").status, "current");
  assert.equal(result.loop.steps.find(step => step.label === "design").status, "done");
});

// T218: the model fields the board page needs, read from a sample logbook in a scratch HOME (made-up data).
const HEADERS = { tasks: "id title size risk route state branch pr round keys", runs: "id task role round candidate branch status tokens report started ended", findings: "task key round source severity summary triage reason status", ledger: "task pr sha kind cycle run at", gates: "id task question options recommendation default answer at", decisions: "at task decision why" };
function logbook(t, tables, { remote = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), "sage-board-model-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, ".claude", "sage"), book = join(root, "sample-abcdef"), checkout = join(home, "work", "sample");
  mkdirSync(book, { recursive: true }); mkdirSync(join(checkout, ".git"), { recursive: true });
  for (const [name, header] of Object.entries(HEADERS)) writeFileSync(join(book, `${name}.tsv`), [header.replaceAll(" ", "\t"), ...(tables[name] ?? []).map(row => header.split(" ").map(field => row[field] ?? "").join("\t"))].join("\n") + "\n");
  writeFileSync(join(book, "checkout.txt"), `${checkout}\n`);
  if (remote) writeFileSync(join(checkout, ".git", "config"), `[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/other/fork.git\n[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  const before = Object.keys(HEADERS).map(name => readFileSync(join(book, `${name}.tsv`), "utf8"));
  const model = buildBoardModel(readBoardSources([{ id: "claude", label: "claude", path: root }]), { now });
  assert.deepEqual(Object.keys(HEADERS).map(name => readFileSync(join(book, `${name}.tsv`), "utf8")), before, "the board writes no logbook file");
  return model;
}
const at = minutes => new Date(Date.parse(now) - minutes * 60000).toISOString();

test("T218 N2: with no PR observation, the newest ledger head for the task's PR gives done, failed and running steps", t => {
  const model = logbook(t, {
    tasks: [task("T1", "reviewing", { pr: "12", route: "build,code-review,security-review,qa", risk: "auth" }), task("T2", "reviewing", { pr: "13" })],
    runs: [{ id: "R1", task: "T1", role: "security-reviewer", status: "running", started: at(5) }, { id: "R2", task: "T1", role: "code-reviewer", status: "done", started: at(30), ended: at(20) }],
    ledger: [
      { task: "T1", pr: "12", sha: old, kind: "qa-pass", cycle: "1", at: at(90) },
      { task: "T1", pr: "12", sha: head, kind: "checks-pass", cycle: "1", at: at(40) },
      { task: "T1", pr: "12", sha: head, kind: "review-clean", cycle: "1", run: "R2", at: at(20) },
      { task: "T1", pr: "12", sha: head, kind: "qa-fail", cycle: "1", run: "R3", at: at(10) },
      { task: "T1", pr: "99", sha: "d".repeat(40), kind: "qa-pass", cycle: "1", at: at(1) },
    ],
  });
  const t1 = model.tasks.find(x => x.id === "T1");
  assert.equal(t1.currentHead, head);
  assert.equal(t1.headBasis, "ledger");
  assert.deepEqual(t1.cycles.map(c => c.steps.map(s => `${s.role} ${s.status}`)), [
    ["checks done", "code-review done", "security-review running", "qa failed"],
    ["checks done", "code-review pending", "security-review pending", "qa pending"],
  ]);
  assert.ok(t1.reasons.some(r => r.text === "QA failed on the recorded PR head."));
  const t2 = model.tasks.find(x => x.id === "T2");
  assert.equal(t2.currentHead, null);
  assert.deepEqual(t2.cycles[0].steps.map(s => s.status), ["unknown", "unknown", "unknown"]);
});

test("T218 N7: the last activity is the newest run, verdict or decision, and a column lists needs-you first, then the newest", t => {
  const model = logbook(t, {
    tasks: [task("T1", "framed"), task("T2", "framed"), task("T3", "framed"), task("T4", "held"), task("T5", "building")],
    runs: [{ id: "R1", task: "T1", role: "pe", status: "done", started: at(50), ended: at(45) }, { id: "R2", task: "T5", role: "implementer", status: "running", started: at(2) }],
    ledger: [{ task: "T2", pr: "4", sha: head, kind: "checks-pass", cycle: "1", at: at(30) }],
    decisions: [{ at: at(60), task: "T2", decision: "task framed", why: "sample" }, { at: at(200), task: "T4", decision: "task held", why: "sample" }],
  });
  const last = id => model.tasks.find(x => x.id === id).lastActivity;
  assert.equal(last("T1"), at(45)); assert.equal(last("T2"), at(30)); assert.equal(last("T3"), null);
  assert.deepEqual(model.columns.find(c => c.key === "backlog").tasks.map(x => x.id), ["T2", "T1", "T3"]);
  assert.deepEqual(model.columns.find(c => c.key === "building").tasks.map(x => x.id), ["T4", "T5"]);
});

test("T218 N8: a moved finding shows on its old task as moved to the new task, and on the new task as from the old one", t => {
  const model = logbook(t, {
    tasks: [task("T1", "repairing"), task("T2", "framed")],
    findings: [{ task: "T2", key: "F-T2-1", round: "0", source: "code-review", severity: "medium", summary: "Sample: cap the list", triage: "", reason: "", status: "open" }],
    decisions: [{ at: at(10), task: "T1", decision: "F-T1-3 moved to T2 as F-T2-1: Sample: cap the list", why: "the follow-up task: Sample" }],
  });
  const [t1, t2] = ["T1", "T2"].map(id => model.tasks.find(x => x.id === id));
  assert.deepEqual(t1.findings.map(f => [f.key, f.severity, f.summary, f.status, f.movedTo]), [["F-T1-3", "medium", "Sample: cap the list", "moved", "T2"]]);
  assert.deepEqual(t2.findings.map(f => [f.key, f.status, f.movedFrom]), [["F-T2-1", "open", "T1"]]);
});

test("T218 N1 and N4: the provider stand-in is the logbook's source, and the PR link base is the checkout's GitHub origin", t => {
  const tables = { tasks: [task("T1", "reviewing", { pr: "7" })], runs: [{ id: "R1", task: "T1", role: "qa", status: "running", started: at(3) }] };
  const linked = logbook(t, tables, { remote: "git@github.com:acme/sage.git" }).tasks[0];
  assert.equal(linked.agents[0].provider, null);
  assert.equal(linked.providerStandIn, "claude");
  assert.equal(linked.repository, "https://github.com/acme/sage");
  assert.equal(logbook(t, tables, { remote: "https://gitlab.example/acme/sage.git" }).tasks[0].repository, null);
  assert.equal(logbook(t, tables, { remote: "https://github.com/../evil" }).tasks[0].repository, null);
  assert.equal(logbook(t, tables).tasks[0].repository, null);
});

test("T218 F-T218-3: after a repair pushes a new head, the old head's verdicts from an earlier round neither show nor need you", t => {
  const tables = round => ({
    tasks: [task("T1", "reviewing", { pr: "12", round })],
    runs: [{ id: "R1", task: "T1", role: "code-reviewer", round: "0", status: "done", started: at(50), ended: at(40) }, { id: "R2", task: "T1", role: "qa", round: "0", status: "done", started: at(40), ended: at(30) }],
    ledger: [
      { task: "T1", pr: "12", sha: head, kind: "checks-pass", cycle: "1", at: at(45) },
      { task: "T1", pr: "12", sha: head, kind: "review-clean", cycle: "1", run: "R1", at: at(40) },
      { task: "T1", pr: "12", sha: head, kind: "qa-fail", cycle: "1", run: "R2", at: at(30) },
    ],
  });
  const repaired = logbook(t, tables("1")).tasks[0];
  assert.equal(repaired.currentHead, null);
  assert.equal(repaired.headBasis, null);
  assert.deepEqual(repaired.reasons, []);
  assert.deepEqual(repaired.cycles[0].steps.map(s => s.status), ["unknown", "unknown", "unknown"]);
  const repairing = tables("0");
  repairing.tasks[0].state = "repairing";
  assert.equal(logbook(t, repairing).tasks[0].currentHead, null);
  const same = logbook(t, tables("0")).tasks[0];
  assert.equal(same.currentHead, head);
  assert.deepEqual(same.reasons.map(r => r.text), ["QA failed on the recorded PR head."]);
});
