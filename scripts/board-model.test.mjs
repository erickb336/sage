import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { readBoardSources } from "../packages/sage-core/board-reader.mjs";
import { NOW as PROGRAMS_NOW, programsSource, programsTables } from "./fixtures/board-programs.mjs";
import { shownGraph, unmetWaits, waitGraph } from "../packages/sage-core/program-rules.mjs";
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
  // T280: verified and pr-ready (T11, T12) have no PR head, so the board cannot run the merge check: they stay in review.
  assert.deepEqual(model.columns.map(c => c.tasks.length), [1, 2, 5, 4, 0, 1]);
  assert.deepEqual(model.columns.find(c => c.key === "review").tasks.map(t => t.id).sort(), ["T11", "T12", "T10", "T9"].sort());
  assert.equal(model.tasks.find(t => t.id === "T15").column, null);
  assert.equal(model.tasks.find(t => t.id === "T14").visible, false);
});

test("same task IDs in different sources stay separate and owner counts count tasks once", () => {
  const tables = { gates: [{ id: "G1", task: "T1", question: "First", answer: "", recommendation: "Choose A" }, { id: "G2", task: "T1", question: "Second", answer: "" }] };
  const model = buildBoardModel([source("one", [task("T1", "held")], tables), source("two", [task("T1", "framed")])], { now });
  assert.equal(model.counts.tasks, 2);
  assert.equal(model.counts.needsOwner, 1);
  assert.notEqual(model.tasks[0].key, model.tasks[1].key);
  assert.equal(model.needsOwner[0].reasons.length, 2, "two open gates; a held task waits for the chief, not for you (R1077)");
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


test("task detail derives brief fields, and the step line shows only the route's steps (T305: no struck-through step)", () => {
  const input = source("one", [task("T1", "building")], {}, [observation("artifact", { type: "brief", label: "Brief" })]);
  input.projects[0].contents = { O1: { verified: true, text: "**GOAL:** Ship the board\nSCOPE: This task\n## ACCEPTANCE\nAll views agree\n- Keep sources separate\nVERIFY: Tests" } };
  const result = buildBoardModel([input], { now }).tasks[0];
  assert.equal(result.briefFields.goal, "Ship the board");
  assert.equal(result.briefFields.acceptance, "All views agree\n- Keep sources separate");
  assert.deepEqual(result.loop.steps.map(step => `${step.label}: ${step.status}`), ["Plan: done", "Build: idle", "Review 1 of 1: wait", "Merge: wait"], "no run: the build is the current step, and no agent is at work (R1077)");
  assert.deepEqual(result.loop.steps[0].parts, [["framed", "done"], ["briefed", "done"]], "no design and no PE check on this route");
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
  assert.deepEqual(result.loop.steps[0].parts, [["framed", "done"], ["design", "done"], ["PE check", "run"], ["briefed", "wait"]]);
  assert.equal(result.loop.now.text, "The PE is at work on the design.");
  input.projects[0].tables.runs = [];
  assert.deepEqual(buildBoardModel([input], { now }).tasks[0].loop.steps[0].parts, [["framed", "done"], ["design", "idle"], ["PE check", "wait"], ["briefed", "wait"]], "no run recorded: the design is current, and no agent is at work (R1077)");
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
    gates: [{ id: "G1", task: "T4", question: "Sample: go on?", answer: "" }],
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

// T218 repair round 2 (made-up data): one head rule for the ledger, and no failure while a task is repairing.
const sha = digit => digit.repeat(40);
test("T218 F-T218-17: a repairing task whose PR observation still names the old, failed head neither fails nor needs you", () => {
  const runs = [{ id: "R1", task: "T1", role: "qa", round: "0", status: "done" }];
  const ledger = [{ task: "T1", pr: "30", sha: sha("7"), kind: "checks-pass", cycle: "1", at: now }, { task: "T1", pr: "30", sha: sha("7"), kind: "qa-fail", cycle: "1", run: "R1", at: now }];
  const records = [observation("pr", { number: 30, head: sha("7"), state: "open" })];
  const model = (state, round) => buildBoardModel([source("one", [task("T1", state, { pr: "30", round })], { runs, ledger }, records)], { now });
  const before = model("reviewing", "0");
  assert.deepEqual(before.tasks[0].reasons.map(r => r.text), ["QA failed on the recorded PR head."]);
  assert.equal(before.counts.needsOwner, 1);
  const repairing = model("repairing", "1");
  assert.equal(repairing.tasks[0].currentHead, sha("7"));
  assert.deepEqual(repairing.tasks[0].reasons, []);
  assert.equal(repairing.counts.needsOwner, 0);
  assert.deepEqual(repairing.tasks[0].cycles[0].steps.map(s => `${s.role} ${s.status}`), ["checks pending", "code-review pending", "qa pending"]);
});

test("T218 F-T218-18: after a repair, run-less verdicts on a head newer than the failed one are the current head", () => {
  const old = sha("5"), fresh = sha("6");
  const ledger = [
    ...[["checks-pass", ""], ["review-clean", ""], ["qa-fail", "R1"]].map(([kind, run]) => ({ task: "T1", pr: "29", sha: old, kind, cycle: "1", run, at: now })),
    ...["checks-pass", "review-clean", "qa-pass"].map(kind => ({ task: "T1", pr: "29", sha: fresh, kind, cycle: "1", at: now })),
  ];
  const runs = [{ id: "R1", task: "T1", role: "qa", round: "0", status: "done" }, { id: "R2", task: "T1", role: "implementer", round: "1", status: "done" }];
  const board = rows => buildBoardModel([source("one", [task("T1", "reviewing", { pr: "29", round: "1" })], { runs, ledger: rows })], { now }).tasks[0];
  const card = board(ledger);
  assert.equal(card.currentHead, fresh);
  assert.equal(card.headBasis, "ledger");
  assert.deepEqual(card.cycles[0].steps.map(s => `${s.role} ${s.status}`), ["checks done", "code-review done", "qa done"]);
  assert.deepEqual(card.reasons, []);
  assert.equal(board(ledger.slice(0, 3)).currentHead, null, "before the new head's verdicts, the old head stays hidden");
});

test("T218 F-T218-20: a late run-less verdict on an old commit does not make the old head current again", () => {
  const A = sha("a"), B = sha("b");
  const runs = [{ id: "R2", task: "T1", role: "qa", round: "0", status: "done" }, { id: "R5", task: "T1", role: "code-reviewer", round: "1", status: "done" }];
  const ledger = [
    { task: "T1", pr: "12", sha: A, kind: "qa-fail", cycle: "1", run: "R2", at: now },
    { task: "T1", pr: "12", sha: B, kind: "review-clean", cycle: "1", run: "R5", at: now },
    { task: "T1", pr: "12", sha: A, kind: "checks-pass", cycle: "1", at: now },
  ];
  const model = buildBoardModel([source("one", [task("T1", "reviewing", { pr: "12", round: "1" })], { runs, ledger })], { now });
  assert.equal(model.tasks[0].currentHead, B);
  assert.deepEqual(model.tasks[0].reasons, []);
  assert.equal(model.counts.needsOwner, 0);
  const runless = ledger.map(row => ({ ...row, run: "" }));
  assert.equal(buildBoardModel([source("one", [task("T1", "reviewing", { pr: "12" })], { ledger: runless })], { now }).tasks[0].currentHead, B, "round 0: the newest commit by its first verdict");
});

/**
 * One sage root with a logbook per entry, each with the T314 columns and its own files: config (the logbook's config.json,
 * as text or an object) and git (the main checkout's .git/config). Returns the board model and the source's diagnostics.
 */
function logbooks(t, books) {
  const home = mkdtempSync(join(tmpdir(), "sage-board-t314-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, "sage");
  const header = `${HEADERS.tasks} hold extra priority kind`;
  for (const [i, { folder = "product-demos", tasks = [], config, git }] of books.entries()) {
    const book = join(root, `${folder}-${String(i).padStart(6, "0")}`), checkout = join(home, `work${i}`, folder);
    mkdirSync(book, { recursive: true }); mkdirSync(join(checkout, ".git"), { recursive: true });
    for (const [name, head] of Object.entries({ ...HEADERS, tasks: header })) writeFileSync(join(book, `${name}.tsv`), [head.replaceAll(" ", "\t"), ...(name === "tasks" ? tasks : []).map(row => head.split(" ").map(field => row[field] ?? "").join("\t"))].join("\n") + "\n");
    writeFileSync(join(book, "checkout.txt"), `${checkout}\n`);
    if (config !== undefined) writeFileSync(join(book, "config.json"), typeof config === "string" ? config : JSON.stringify(config));
    if (git) writeFileSync(join(checkout, ".git", "config"), git);
  }
  return buildBoardModel(readBoardSources([{ id: "claude", label: "claude", path: root }]), { now });
}
const remotes = (list) => list.map(([name, url]) => `[remote "${name}"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/${name}/*\n`).join("");
const named = model => model.tasks.map(card => card.projectName);

test("T314: a project's name is its display name, else its upstream repository, then its origin repository, then its main checkout's folder", t => {
  const both = remotes([["origin", "git@github.com:erickb336/seacc-fork.git"], ["upstream", "https://github.com/seattle-digital-commons/seacc.git"]]);
  const one = task("T1", "framed", { pr: "4" });
  const model = logbooks(t, [
    { tasks: [one], config: { name: "seacc (Council Record)" }, git: both },
    { tasks: [one], git: both },
    { tasks: [one], git: remotes([["origin", "https://github.com/erickb336/council"]]) },
    { tasks: [one], git: remotes([["upstream", "https://gitlab.example/x/y.git"]]) },
    { tasks: [one] },
  ]);
  assert.deepEqual(named(model), ["seacc (Council Record)", "seacc", "council", "product-demos", "product-demos"]);
  assert.equal(model.tasks[1].repository, "https://github.com/erickb336/seacc-fork", "the PR link keeps origin, where the PRs are");
  assert.deepEqual(model.diagnostics, []);
});

test("T314 R1042-2: the board checks a display name again: a bad one is not shown, the next name is, with a warning and no diagnostic", t => {
  const git = remotes([["upstream", "https://github.com/seattle-digital-commons/seacc"]]);
  const one = task("T1", "framed");
  const model = logbooks(t, [
    { tasks: [one], config: { name: "sea​cc" }, git },
    { tasks: [one], config: { name: "n".repeat(61) }, git },
    { tasks: [one], config: { name: " seacc" }, git },
    { tasks: [one], config: { name: 7 }, git },
    { tasks: [one], config: "{not json", git },
    { tasks: [one], config: { name: "n".repeat(60), archived: "yes" }, git },
  ]);
  assert.deepEqual(named(model), ["seacc", "seacc", "seacc", "seacc", "seacc", "n".repeat(60)]);
  assert.deepEqual(model.diagnostics, [], "a bad setting leaves every table whole: no diagnostic, so the board server stays live");
  assert.deepEqual(model.warnings.map(d => d.message), [
    "config: the name has a control, format or hidden character (such as a tab, a line break, a zero-width space or a right-to-left mark)",
    "config: the name has 61 characters: give 1 to 60",
    "config: the name has a space at its start or end, or two spaces together",
    "config: the name is not text",
    "config: invalid JSON",
    "config: archived is not true or false",
  ]);
  assert.equal(model.archived.length, 0, "only archived: true archives");
});

test("T314: an archived project's tasks leave the columns and the counts, and the archived group names it, with what needs you there", t => {
  const model = logbooks(t, [
    { folder: "live", tasks: [task("T1", "framed"), task("T2", "awaiting-you")] },
    { folder: "old", tasks: [task("T1", "framed"), task("T2", "awaiting-you"), task("T3", "building")], config: { name: "Old app", archived: true } },
  ]);
  assert.deepEqual(model.columns.flatMap(column => column.tasks.map(card => `${card.projectName} ${card.id}`)), ["live T1", "live T2"]);
  assert.deepEqual(model.counts, { tasks: 2, needsOwner: 1, recordedAgents: 0, inferredWork: 0, inReview: 0 });
  assert.deepEqual(model.archived, [{ key: "old-000001", name: "Old app", tasks: 3, needsOwner: 1 }]);
  assert.equal(model.tasks.filter(card => card.archived).length, 3, "its tasks stay in the model, for their task pages");
});

test("T314: a card has the task's priority and kind from their fixed lists; a column puts needs-you first, then P0 to P3, then no priority", t => {
  const model = logbooks(t, [{ tasks: [
    task("T1", "framed", { priority: "", kind: "docs" }),
    task("T2", "framed", { priority: "P2", kind: "bug-fix" }),
    task("T3", "framed", { priority: "P0", kind: "feature" }),
    task("T4", "framed", { priority: "urgent" }),
    task("T5", "framed", { priority: "P3" }),
  ] }]);
  assert.deepEqual(model.columns[0].tasks.map(card => [card.id, card.priority, card.kind]), [["T3", "P0", ""], ["T2", "P2", "bug-fix"], ["T5", "P3", ""], ["T1", "", "docs"], ["T4", "", ""]]);
});

test("T314 R1043-2: a task that needs you comes before a task of a higher priority", () => {
  const gates = [{ id: "G1", task: "T1", question: "Sample: which option?", answer: "" }];
  const model = buildBoardModel([source("one", [task("T1", "framed", { priority: "P3" }), task("T2", "framed", { priority: "P0" })], { gates })], { now });
  assert.deepEqual(model.columns[0].tasks.map(card => [card.id, card.reasons.length > 0]), [["T1", true], ["T2", false]]);
});

test("T314 R1040-4: Done stays newest first whatever the priority; the other columns sort by priority", () => {
  const decisions = [{ task: "T1", at: "2026-10-05T10:00:00Z", decision: "state merged", why: "task set" }, { task: "T2", at: "2026-10-07T10:00:00Z", decision: "state merged", why: "task set" }];
  const model = buildBoardModel([source("one", [task("T1", "merged", { priority: "P0" }), task("T2", "merged", { priority: "P3" }), task("T3", "framed", { priority: "P3" }), task("T4", "framed", { priority: "P0" })], { decisions })], { now });
  assert.deepEqual(model.columns.find(column => column.key === "done").tasks.map(card => card.id), ["T2", "T1"]);
  assert.deepEqual(model.columns.find(column => column.key === "backlog").tasks.map(card => card.id), ["T4", "T3"]);
});

test("T314 R1043-4: the board refuses a display name that is not in the composed form (NFC), and shows the next name", t => {
  const git = remotes([["upstream", "https://github.com/seattle-digital-commons/seacc"]]);
  const decomposed = `Cafe${String.fromCodePoint(0x301)}`;
  const model = logbooks(t, [{ tasks: [task("T1", "framed")], config: { name: decomposed }, git }, { tasks: [task("T1", "framed")], config: { name: decomposed.normalize("NFC") }, git }]);
  assert.deepEqual(named(model), ["seacc", "Café"]);
  assert.deepEqual(model.warnings.map(d => d.message), ["config: the name is not in the composed Unicode form (NFC)"]);
});

// T305: the step line (loop design 1), the merge of one repository's logbooks, and the picker's list. Sample data only.
const line = card => card.loop.steps.map(step => `${step.label}: ${step.status}`);
// A sample merge check that passes on every head (T280), unless a test gives its own.
const passes = () => ({ ok: true, reason: "" });
const oneTask = (row, tables = {}, records = [], config = {}, landing = passes) => buildBoardModel([{ ...source("one", [row], tables, records), config }], { now, landing }).tasks[0];

test("T305: the step line and the Now and Next lines follow the fixed rule of each state on a build route", () => {
  const running = role => ({ runs: [{ id: "R7", task: "T1", role, status: "running", started: "2026-10-08T19:20:00Z" }] });
  const framed = oneTask(task("T1", "framed"));
  assert.deepEqual([line(framed), framed.loop.now, framed.loop.next], [["Plan: wait", "Build: wait", "Review 1 of 1: wait", "Merge: wait"], { needs: false, stale: false, text: "In the backlog. No agent works on it." }, "The build."]);
  const building = oneTask(task("T1", "building"), running("implementer"));
  assert.deepEqual(line(building), ["Plan: done", "Build: run", "Review 1 of 1: wait", "Merge: wait"]);
  assert.equal(building.loop.steps[1].detail, "The implementer (run R7) is at work. It started 40 min ago.");
  assert.deepEqual([building.loop.now.text, building.loop.next], ["The implementer is at work on the build.", "Review cycle 1 of 1, when the PR opens."]);
  const clean = { ledger: ["checks-pass", "review-clean", "qa-pass"].map(kind => ({ task: "T1", pr: "41", sha: head, kind, cycle: "1", at: now })) };
  const verified = oneTask(task("T1", "verified", { pr: "41" }), clean, [observation("mode", { autopilot: false })]);
  assert.deepEqual(line(verified), ["Plan: done", "Build: done", "Review 1 of 1: done", "Merge: need"]);
  assert.deepEqual([verified.loop.now, verified.loop.next], [{ needs: true, text: "Autopilot is off, so review and merge PR 41." }, "Done after the merge."]);
  const unknown = oneTask(task("T1", "verified", { pr: "41" }), clean);
  assert.equal(unknown.loop.now.text, "The board cannot tell if autopilot is on, so review and merge PR 41.", "R1075-4: plain words, not 'Autopilot state is unknown'");
  const auto = oneTask(task("T1", "verified", { pr: "41" }), clean, [observation("mode", { autopilot: true })]);
  assert.deepEqual([line(auto).at(-1), auto.loop.now.text, auto.reasons], ["Merge: idle", "Verified. Autopilot merges PR 41.", []]);
  const merged = oneTask(task("T1", "merged", { pr: "41" }), clean);
  assert.deepEqual([line(merged), merged.loop.now.text, merged.loop.next], [["Plan: done", "Build: done", "Review 1 of 1: done", "Merge: done"], "Merged.", null]);
});

test("T280: a verified PR is ready to merge only when the merge check passes on its known head; else the board says why", () => {
  const clean = { ledger: ["checks-pass", "review-clean", "qa-pass"].map(kind => ({ task: "T1", pr: "41", sha: head, kind, cycle: "1", at: now })) };
  const mode = [observation("mode", { autopilot: false })];
  const calls = [], ready = oneTask(task("T1", "verified", { pr: "41" }), clean, mode, {}, (...args) => (calls.push(args), { ok: true, reason: "" }));
  assert.deepEqual(calls, [["one", head, "41"]], "the merge check gets the source, the full head and the PR");
  assert.deepEqual([ready.column, ready.mergeCheck.ok, ready.reasons.map(r => r.kind), ready.loop.steps.at(-1).detail],
    ["ready", true, ["merge"], "The merge check passes on aaaaaaa. The board does not check the PR's head branch. Autopilot is off, so the merge waits for you."]);
  const refuses = oneTask(task("T1", "pr-ready", { pr: "41" }), clean, mode, {}, () => ({ ok: false, reason: "T1 has open findings: F-T1-1. Fix them." }));
  assert.deepEqual([refuses.column, refuses.loop.now, refuses.loop.steps.at(-1).detail],
    ["review", { needs: true, text: "The merge check refuses aaaaaaa. T1 has open findings: F-T1-1." }, "The merge check refuses aaaaaaa. T1 has open findings: F-T1-1."]);
  const noHead = oneTask(task("T1", "verified", { pr: "41" }), {}, mode, {}, () => assert.fail("no head: the board does not run the merge check"));
  assert.deepEqual([noHead.column, noHead.loop.now.text], ["review", "The merge check is not checked, because the board does not know the last commit of PR 41."]);
  const noCheck = oneTask(task("T1", "verified", { pr: "41" }), clean, mode, {}, null);
  assert.deepEqual([noCheck.column, noCheck.loop.now.text], ["review", "The merge check is not checked on aaaaaaa, because this board cannot run it."]);
  const auto = oneTask(task("T1", "verified", { pr: "41" }), clean, [observation("mode", { autopilot: true })], {}, () => ({ ok: false, reason: "T1: 0 of 1 clean cycles on this SHA." }));
  assert.deepEqual([auto.column, auto.loop.now.text], ["review", "The merge check refuses aaaaaaa. T1: 0 of 1 clean cycles on this SHA."], "autopilot on: a refusal still shows");
});

test("R1075-1, R1071-1: a step runs now only while a run of the task runs; a gate makes it need you; a stale run shows its mark", () => {
  const idle = oneTask(task("T1", "building"));
  assert.deepEqual([line(idle)[1], idle.loop.now.text], ["Build: idle", "No agent works on the build now."], "no run: no step says running now");
  const gate = { gates: [{ id: "G3", task: "T1", question: "Sample: which layout?", recommendation: "the first", answer: "" }] };
  const designing = oneTask(task("T1", "designing", { route: "design,build,code-review,qa" }), { ...gate, runs: [{ id: "R7", task: "T1", role: "designer", status: "running", started: "2026-10-08T19:20:00Z" }] });
  assert.deepEqual([line(designing)[0], designing.loop.steps[0].parts[1], designing.loop.now.needs, designing.loop.next], ["Plan: need", ["design", "need"], true, "The design goes on after your answer."], "an open gate: the plan needs you, not 'running now'");
  const stale = oneTask(task("T1", "building"), { runs: [{ id: "R5", task: "T1", role: "implementer", status: "running", started: "2026-10-05T08:00:00Z" }] });
  assert.deepEqual(line(stale)[1], "Build: stale");
  assert.deepEqual(stale.loop.now, { needs: false, stale: true, text: "No news from the implementer since 5 Oct. The run may have stopped, so ask the chief to check it." });
  assert.equal(stale.loop.steps[1].detail, "No news from the implementer (run R5) since 5 Oct. The run may have stopped, so ask the chief to check it.");
  assert.deepEqual([stale.agents.map(agent => agent.stale), buildBoardModel([source("one", [task("T1", "building")], { runs: stale.runs })], { now }).counts.recordedAgents], [[true], 0], "a stale run is not an agent at work");
});

test("R1076-1: a reviewing task whose cycles are all clean says the reviews are done, and that the chief checks and merges next", () => {
  const ledger = [1, 2].flatMap(n => ["review-clean", "security-clean", "qa-pass"].map(kind => ({ task: "T1", pr: "12", sha: head, kind, cycle: String(n), at: now })));
  const card = oneTask(task("T1", "reviewing", { pr: "12", risk: "auth", route: "build,code-review,security-review,qa" }), { ledger: [{ task: "T1", pr: "12", sha: head, kind: "checks-pass", cycle: "1", at: now }, ...ledger] }, [observation("pr", { number: 12, head, state: "open" })]);
  assert.deepEqual(line(card), ["Plan: done", "Build: done", "Review 1 of 2: done", "Review 2 of 2: done", "Merge: idle"]);
  assert.deepEqual([card.loop.now.text, card.loop.next], ["The reviews are done, with 2 clean cycles on aaaaaaa.", "The chief checks the verdicts, then the merge."]);
});

test("T387: a task past its reviews shows only the cycles with a recorded clean verdict set, never the size's full count", () => {
  const cycle = n => ["checks-pass", "review-clean", "security-clean", "qa-pass"].map(kind => ({ task: "T1", pr: "12", sha: head, kind, cycle: String(n), at: now }));
  const card = (state, ledger) => oneTask(task("T1", state, { pr: "12", risk: "auth", route: "build,code-review,security-review,qa" }), { ledger }, [observation("pr", { number: 12, head, state: state === "merged" ? "merged" : "open" })]);
  assert.deepEqual(line(card("verified", cycle(1))), ["Plan: done", "Build: done", "Review 1 of 2: done", "Merge: need"], "1 of 2 cycles ran: the line shows 1");
  assert.deepEqual(line(card("verified", [...cycle(1), ...cycle(2)])), ["Plan: done", "Build: done", "Review 1 of 2: done", "Review 2 of 2: done", "Merge: need"], "both cycles ran: the line shows 2");
  assert.deepEqual(line(card("merged", cycle(1))), ["Plan: done", "Build: done", "Review 1 of 2: done", "Merge: done"], "an old task merged with fewer cycles than its size needs");
  assert.deepEqual(line(card("merged", [])), ["Plan: done", "Build: done", "Merge: done"], "no recorded cycle: no review step claims one");
  assert.deepEqual(line(card("reviewing", cycle(1))), ["Plan: done", "Build: done", "Review 1 of 2: done", "Review 2 of 2: idle", "Merge: wait"], "a task in review still shows every cycle of its size");
});

test("R1073-1, R1073-2, R1076-5: Next after a gate names the step that waits for it; held and replan wait for the chief unless a gate is open", () => {
  const gate = answer => ({ gates: [{ id: "G3", task: "T1", question: "Sample: keep it?", recommendation: "yes", answer }] });
  assert.equal(oneTask(task("T1", "framed"), gate("")).loop.next, "The plan starts after your answer.", "a framed task has no review yet");
  assert.equal(oneTask(task("T1", "briefed"), gate("")).loop.next, "The build starts after your answer.");
  const held = oneTask(task("T1", "held"), gate(""));
  assert.deepEqual([line(held), held.loop.steps[1].detail, held.loop.now, held.loop.next], [["Plan: done", "Build: need", "Review 1 of 1: wait", "Merge: wait"], "Held at gate G3 (the question above).", { needs: true, text: "Sample: keep it? I recommend: yes" }, "The build goes on after your answer."]);
  const investigation = { size: "investigate", route: "investigate,evidence-review" };
  assert.equal(oneTask(task("T1", "held", investigation), gate("")).loop.next, "The investigation goes on after your answer.", "an investigation has no build");
  assert.equal(oneTask(task("T1", "replan"), gate("")).loop.next, "The chief briefs it again after your answer.");
  const answered = oneTask(task("T1", "held"), gate("yes"));
  assert.deepEqual([answered.loop.now, answered.loop.next, answered.reasons], [{ needs: false, stale: false, text: "Held by the chief. You answered gate G3, so the chief moves it on." }, "The build goes on, or the chief briefs it again.", []]);
  const rounds = oneTask(task("T1", "held", { hold: "round", round: "3" }));
  assert.deepEqual([rounds.loop.now.text, rounds.loop.next, rounds.reasons], ["Held after 3 repair rounds that did not make it clean.", "The chief asks you how to go on.", []]);
  const replan = oneTask(task("T1", "replan", { round: "2" }));
  assert.deepEqual([replan.loop.now.needs, replan.loop.next], [false, "The chief briefs it again."]);
  const noHead = oneTask(task("T1", "reviewing", { pr: "12" }));
  assert.deepEqual([noHead.loop.now.text, noHead.loop.next], ["No agent works on review cycle 1 of 1 now. The board does not know the PR's last commit.", "The review cycles on the PR's last commit, then the merge."], "no known head: Next does not skip the reviews");
});

test("T305: in review, the current cycle runs and its roles have words; the next role, then the next cycle, is Next", () => {
  const records = [observation("pr", { number: 12, head, state: "open" }), observation("run", { run: "R1", provider: "Codex", head, cycle: 1 }, { id: "O2" })];
  const ledger = [{ task: "T1", pr: "12", sha: head, kind: "checks-pass", cycle: "1", at: now }, { task: "T1", pr: "12", sha: head, kind: "review-clean", cycle: "1", run: "R0", at: now }];
  const runs = [{ id: "R0", task: "T1", role: "code-reviewer", status: "done" }, { id: "R1", task: "T1", role: "security-reviewer", status: "running", started: "2026-10-08T19:35:00Z" }];
  const card = oneTask(task("T1", "reviewing", { pr: "12", risk: "auth", route: "build,code-review,security-review,qa" }), { ledger, runs }, records);
  assert.deepEqual(line(card), ["Plan: done", "Build: done", "Review 1 of 2: run", "Review 2 of 2: wait", "Merge: wait"]);
  assert.deepEqual(card.loop.steps[2].parts, [["checks", "done"], ["code review", "done"], ["security review", "run"], ["QA", "wait"]]);
  assert.equal(card.loop.steps[2].detail, "On the last commit (aaaaaaa). The security reviewer (Codex, run R1) is at work. It started 25 min ago.");
  assert.equal(card.loop.steps[3].detail, "A risk flag (auth) needs 2 clean cycles.");
  assert.deepEqual([card.loop.now.text, card.loop.next], ["The security reviewer is at work on review cycle 1 of 2.", "QA, then review cycle 2 of 2."]);
  const unknown = oneTask(task("T1", "reviewing", { pr: "12" }));
  assert.equal(unknown.loop.steps[2].detail, "The board does not know the PR's last commit, so it shows no verdicts yet.", "plain words, not 'PR head not recorded'");
  assert.deepEqual(unknown.loop.steps[2].parts.map(([, value]) => value), ["unknown", "unknown", "unknown"]);
});

test("T305: a repair is its own step, round n of m, then Review again; the round count comes from max_rounds", () => {
  const ledger = [{ task: "T1", pr: "52", sha: head, kind: "checks-pass", cycle: "1", at: now }, { task: "T1", pr: "52", sha: head, kind: "findings", cycle: "1", run: "R2", at: now }];
  const runs = [{ id: "R2", task: "T1", role: "code-reviewer", round: "0", status: "done" }, { id: "R3", task: "T1", role: "implementer", round: "1", status: "running", started: "2026-10-08T17:50:00Z" }];
  const card = oneTask(task("T1", "repairing", { pr: "52", round: "1" }), { ledger, runs }, [], { max_rounds: 4 });
  assert.deepEqual(line(card), ["Plan: done", "Build: done", "Review 1 of 1: fail", "Repair, round 1 of 4: run", "Review again: wait", "Merge: wait"]);
  assert.equal(card.loop.steps[2].detail, "The code review found problems on aaaaaaa.");
  assert.equal(card.loop.steps[3].detail, "The implementer (run R3) is at work. It started 2 h 10 min ago.", "R1075-4: whole sentences");
  assert.deepEqual([card.loop.now.text, card.loop.next], ["The implementer is at work on repair round 1 of 4.", "The reviews start again at cycle 1 on the new commit."]);
});

test("T305, R1071-2, R1076-3: an investigation shows Plan, Investigate, Evidence review and Conclude, and never a PR, a commit or a build", () => {
  const route = "investigate,evidence-review";
  const evidence = { ledger: [{ task: "T1", pr: "", sha: "", kind: "evidence-clean", cycle: "1", at: now }] };
  const verifying = oneTask(task("T1", "verifying", { size: "investigate", route }), evidence);
  assert.deepEqual(line(verifying), ["Plan: done", "Investigate: done", "Evidence review: done", "Conclude: idle"]);
  assert.deepEqual(verifying.loop.steps[2].parts, [["evidence review", "done"]], "a done step's parts are done, not 'not known yet'");
  assert.deepEqual([verifying.loop.now.text, verifying.loop.next], ["The chief checks the evidence review before the conclusion.", "The conclusion. The report comes to you."], "no doubled colon");
  const reviewing = oneTask(task("T1", "reviewing", { size: "investigate", route }), { runs: [{ id: "R19", task: "T1", role: "evidence-review", status: "running", started: now }] });
  assert.deepEqual([line(reviewing)[2], reviewing.loop.steps[2].detail, reviewing.loop.next], ["Evidence review: run", "The evidence review checks the report. The evidence reviewer (run R19) is at work. It started 0 min ago.", "The conclusion. The report comes to you."]);
  assert.deepEqual(line(oneTask(task("T1", "building", { size: "investigate", route }))), ["Plan: done", "Investigate: idle", "Evidence review: wait", "Conclude: wait"]);
  assert.deepEqual(line(oneTask(task("T1", "concluded", { size: "investigate", route }), evidence)), ["Plan: done", "Investigate: done", "Evidence review: done", "Conclude: done"]);
});

test("T305: a run's time is minutes or hours up to 24 h; after 24 h with no logbook change, the run may have stopped", async () => {
  const { runClock } = await import("../packages/sage-core/board-model.mjs");
  const at = Date.parse(now);
  assert.deepEqual(runClock("2026-10-08T19:20:00Z", at, null), { text: "40 min", stale: false });
  assert.deepEqual(runClock("2026-10-08T16:55:00Z", at, null), { text: "3 h 5 min", stale: false });
  assert.deepEqual(runClock("2026-10-05T08:00:00Z", at, "2026-10-05T08:00:00Z"), { text: "no news since 5 Oct. The run may have stopped, so ask the chief to check it", stale: true, since: "5 Oct" });
  assert.deepEqual(runClock("2026-10-05T08:00:00Z", at, "2026-10-08T12:00:00Z"), { text: "since 5 Oct", stale: false }, "a change in the last 24 h: not stale");
  const card = oneTask(task("T1", "building"), { runs: [{ id: "R5", task: "T1", role: "implementer", status: "running", started: "2026-10-05T08:00:00Z" }] });
  assert.equal(card.runClocks.R5.text, "no news since 5 Oct. The run may have stopped, so ask the chief to check it");
});

/** Two sources, each with projects given as { name, checkout, tasks, ...fields }: in memory, as the reader gives them. */
const twoSources = (claude, codex) => buildBoardModel([["claude", "Claude", claude], ["codex", "Codex", codex]].map(([id, provider, books]) => ({ id, label: id, provider, diagnostics: [], projects: books.map(({ name, tasks, ...rest }) => ({ key: `${id}/${name}`, name, diagnostics: [], warnings: [], tables: { tasks }, ...rest })) })), { now });

test("T305: one repository is one project: the logbooks of one key and one checkout merge; tasks keep source-qualified keys", () => {
  const book = (tasks, extra = {}) => ({ name: "sage-43265b", checkout: "/sample/work/sage", repository: "https://github.com/sample-owner/sage", tasks, ...extra });
  const model = twoSources([book([task("T9", "framed")])], [book([task("T9", "held")])]);
  assert.deepEqual(model.projects.map(project => [project.key, project.name, project.providers]), [["sage-43265b", "sage", ["Claude", "Codex"]]]);
  assert.deepEqual(model.tasks.map(card => [card.key, card.group, card.providerStandIn]), [["claude/sage-43265b/T9", "sage-43265b", "Claude"], ["codex/sage-43265b/T9", "sage-43265b", "Codex"]]);
  assert.deepEqual(model.notes, []);
  const missing = twoSources([book([task("T1", "framed")])], [book([task("T2", "framed")], { checkout: undefined })]);
  assert.deepEqual(missing.projects.map(project => project.key).sort(), ["claude/sage-43265b", "codex/sage-43265b"]);
  assert.deepEqual(missing.notes.map(note => note.message), ["Separate logbooks: claude/sage-43265b and codex/sage-43265b share a key, but their checkouts do not establish one project."]);
  const apart = twoSources([book([task("T1", "framed")])], [book([task("T2", "framed")], { checkout: "/sample/other/sage" })]);
  assert.deepEqual(apart.projects.map(project => project.key).sort(), ["claude/sage-43265b", "codex/sage-43265b"], "never merge on doubt");
  assert.deepEqual(apart.notes.map(note => note.message), ["Separate logbooks: claude/sage-43265b and codex/sage-43265b share a key, but their checkouts do not establish one project."]);
  const clones = twoSources([book([task("T1", "framed")]), book([task("T1", "framed")], { name: "sage-9a9a9a", checkout: "/sample/clone/sage" })], []);
  assert.deepEqual(clones.projects.map(project => [project.key, project.name]).sort(), [["sage-43265b", "sage"], ["sage-9a9a9a", "sage"]], "two clones at two paths stay two projects");
  assert.deepEqual(clones.projects.map(project => [project.key, project.pathSub]).sort(), [["sage-43265b", "…/work/sage · sample-owner/sage"], ["sage-9a9a9a", "…/clone/sage · sample-owner/sage"]], "F-T305-11, R1076-4: on the Mac's page, two clones in folders of one name show the end of their paths first, as far as they differ");
  assert.deepEqual(clones.projects.map(project => [project.key, project.sub]).sort(), [["sage-43265b", "clone 1 · sample-owner/sage"], ["sage-9a9a9a", "clone 2 · sample-owner/sage"]], "R1079-1: every other viewer sees clone 1 and clone 2, by the order of the logbook keys");
  const local = twoSources([book([task("T1", "framed")], { repository: null, checkout: "/sample/a/lab" }), book([task("T1", "framed")], { name: "lab-9a9a9a", repository: null, checkout: "/sample/b/lab" }), book([task("T1", "framed")], { name: "lab-copy-1b1b1b", repository: null, checkout: "/sample/b/lab-copy" })], []);
  assert.deepEqual(local.projects.map(project => project.sub).sort(), ["clone 1 · no GitHub remote", "clone 2 · no GitHub remote", "no GitHub remote · folder lab-copy"]);
  assert.deepEqual(local.projects.map(project => project.pathSub).sort(), [null, "…/a/lab · no GitHub remote", "…/b/lab · no GitHub remote"]);
  // F-T305-3: one unreadable logbook does not rename the project that the other logbook names.
  const broken = twoSources([book([task("T1", "framed")], { displayName: "Sage (sample)" })], [book([], { diagnostics: ["tasks: damaged table header"] })]);
  assert.deepEqual(broken.projects.map(project => [project.name, project.problem]), [["Sage (sample)", "tasks: damaged table header"]]);
  assert.deepEqual(broken.tasks.map(card => card.projectName), ["Sage (sample)"]);
  const unnamed = twoSources([book([task("T1", "framed")])], [book([], { diagnostics: ["tasks: damaged table header"] })]);
  assert.deepEqual(unnamed.projects.map(project => project.name), ["sage"], "the remote names it");
  const names = twoSources([book([task("T1", "framed")], { displayName: "Sage (sample)" })], [book([task("T2", "framed")], { displayName: "Other name", archived: true })]);
  assert.deepEqual([names.projects[0].name, names.projects[0].archived], ["Sage (sample)", false], "R1070-1: archived only when all its logbooks are");
  assert.deepEqual(names.notes.map(note => note.message), ['Two display names: the board shows "Sage (sample)" (the first source), not "Other name".', "Archived in codex/sage-43265b only: the board does not archive the project."]);
  const both = twoSources([book([task("T1", "framed")], { archived: true })], [book([task("T2", "framed")], { archived: true })]);
  assert.equal(both.projects[0].archived, true);
  // An unassigned logbook keeps its own name and archive state.
  const stray = twoSources([book([task("T1", "framed")], { displayName: "Sage (sample)" })], [book([task("T2", "framed")], { checkout: undefined, displayName: "Sample other name", archived: true })]);
  assert.deepEqual(stray.projects.map(project => [project.name, project.archived]).sort(), [["Sage (sample)", false], ["Sample other name", true]]);
  const first = twoSources([book([task("T1", "framed")], { checkout: undefined, displayName: "Sample other name", archived: true })], [book([task("T2", "framed")])]);
  assert.deepEqual(first.projects.map(project => [project.name, project.archived]).sort(), [["Sample other name", true], ["sage", false]], "also when it comes first");
  // R1075-6: an error code reads as a plain reason.
  const denied = twoSources([book([task("T1", "framed")])], [book([], { diagnostics: ["tasks: EACCES"] })]);
  assert.equal(denied.projects[0].problem, "its tasks file has no read permission");
});

test("T305: the picker's list puts needs you first, then active in the last 14 days, idle and archived, with every name a person may know", () => {
  const decision = (id, at) => [{ task: id, at, decision: "sample", why: "sample" }];
  // Activity: fresh had a decision 2 days ago, old 20 days ago.
  const withActivity = buildBoardModel([{ id: "claude", label: "claude", provider: "Claude", diagnostics: [], projects: [
    { key: "claude/product-demos-1c0254", name: "product-demos-1c0254", checkout: "/sample/work/sdc/product-demos", repository: "https://github.com/sample-owner/seacc", upstream: "https://github.com/sample-org/seacc", displayName: "seacc (Council Record)", diagnostics: [], tables: { tasks: [task("T41", "awaiting-you")] } },
    { key: "claude/fresh-aaaaaa", name: "fresh-aaaaaa", checkout: "/sample/work/fresh", diagnostics: [], tables: { tasks: [task("T1", "framed")], decisions: decision("T1", "2026-10-06T20:00:00Z") } },
    { key: "claude/old-bbbbbb", name: "old-bbbbbb", checkout: "/sample/work/old", repository: "https://github.com/sample-owner/old", diagnostics: [], tables: { tasks: [task("T1", "framed")], decisions: decision("T1", "2026-09-18T20:00:00Z") } },
    { key: "claude/gone-cccccc", name: "gone-cccccc", checkout: "/sample/work/gone", archived: true, diagnostics: [], tables: { tasks: [task("T1", "framed")] } },
    { key: "claude/broken-dddddd", name: "broken-dddddd", checkout: "/sample/work/broken", diagnostics: ["tasks: damaged table header"], tables: {} },
  ] }], { now });
  // R1307-2: a logbook that the board cannot read needs you: it is an item of Needs you, so its project is in the needs list.
  assert.deepEqual(withActivity.projects.map(project => [project.list, project.name, project.needsOwner]), [["needs", "broken-dddddd", 1], ["needs", "seacc (Council Record)", 1], ["active", "fresh", 0], ["idle", "old", 0], ["archived", "gone", 0]]);
  const sdc = withActivity.projects[1];
  assert.equal(sdc.sub, "sample-org/seacc · folder product-demos");
  assert.deepEqual(sdc.terms, ["seacc (Council Record)", "sample-org/seacc", "sample-owner/seacc", "product-demos", "product-demos-1c0254", "claude/product-demos-1c0254"]);
  assert.deepEqual(sdc.paths, ["/sample/work/sdc/product-demos"], "R1069-2: the paths are apart from the terms");
  assert.deepEqual(withActivity.projects.map(project => project.sub), ["no GitHub remote · folder broken", "sample-org/seacc · folder product-demos", "no GitHub remote · folder fresh", "sample-owner/old · folder old", "no GitHub remote · folder gone"], "F-T305-11: no GitHub remote comes first, so the line never cuts it off; R1071-6: owner/repo, not the owner alone");
  assert.equal(withActivity.projects[0].problem, "tasks: damaged table header", "an unreadable logbook is named by its folder, with the reason");
});

// T233: programs on the board. SAMPLE DATA from scripts/fixtures/board-programs.mjs.
const programsModel = (sources = [programsSource()]) => buildBoardModel(sources, { now: PROGRAMS_NOW });
const cardOf = (model, id) => model.tasks.find(item => item.id === id);
const programOf = (model, id) => model.programs.find(item => item.id === id);

test("T233: each wait on a card has its state, and the wait line names the unmet ones: a task, the pilot, the breakdown, never met, and odd text that it never shows", () => {
  const model = programsModel();
  const line = id => cardOf(model, id).waitLine;
  assert.deepEqual(line("T13"), { never: false, text: "Waits for T12 (in review)." }, "not met");
  assert.deepEqual(line("T11"), { never: true, text: "Waits for T10 (abandoned): it cannot start." }, "never met: abandoned; the met pilot wait is not named");
  assert.deepEqual(cardOf(model, "T11").waits, [{ id: "T10", state: "abandoned", word: "abandoned", pilot: false, met: false, never: true }, { id: "T1", state: "merged", word: "merged", pilot: true, met: true, never: false }]);
  assert.deepEqual(line("T22"), { never: true, text: "Waits for T21 (pilot, abandoned): it cannot start." }, "the pilot wait");
  assert.deepEqual(line("T41"), { never: false, text: "Waits for T40 (pilot, building). Design and PE may run." }, "a task in design may run its design and PE");
  assert.deepEqual(line("T32"), { never: false, text: "Waits for your approval of the PG3 breakdown (gate G12)." }, "the breakdown wait, alone, although T32 also waits for T31");
  assert.deepEqual(line("T90"), { never: false, text: "Waits for the new breakdown of PG9: you asked for changes (gate G9)." });
  assert.deepEqual(line("T60"), { never: true, text: "Waits for the PG6 breakdown, which you dropped (gate G20): it cannot start." });
  assert.deepEqual(line("T75"), { never: true, text: "Waits for the PG7 breakdown, whose gate G30 is not in the logbook: it cannot start." });
  assert.deepEqual(line("T83"), { never: true, text: "It cannot start. Its waits cell has text that is not a task id: the chief sets its waits again." });
  assert.ok(!JSON.stringify(cardOf(model, "T83")).includes("soon"), "the odd text is not in the model");
  for (const id of ["T1", "T10", "T12", "T40", "T70"]) assert.equal(line(id), null, `${id}: nothing waits, or the task ended`);
  assert.deepEqual(cardOf(model, "T30").program, { key: "claude/sage-ff5ee2/PG3", id: "PG3", name: "Board programs", pilot: true });
  assert.equal(cardOf(model, "T70").program, null);
});

test("T233: each program's state and progress (Q3), and what moves next (Q4: only a task with no unmet wait; the waiting tasks are a count)", () => {
  const model = programsModel();
  const view = id => { const p = programOf(model, id); return [p.state, p.progressText, p.next && `${p.next.id} ${p.next.word}${p.next.pilot ? " pilot" : ""}`, p.waiting, p.cannotStart]; };
  assert.deepEqual(view("PG1"), ["active", "3 of 7 merged · T10 abandoned", "T12 in review", 1, ["T11"]]);
  assert.deepEqual(view("PG2"), ["stuck", "0 of 3 merged · T21 abandoned", null, 0, ["T22", "T23"]]);
  assert.deepEqual(view("PG3"), ["proposed", "0 of 3 merged", null, 3, []]);
  assert.deepEqual(view("PG4"), ["active", "0 of 3 merged", "T40 building pilot", 2, []]);
  assert.deepEqual(view("PG5"), ["done", "2 of 3 merged · T52 abandoned", null, 0, []], "done: a concluded task counts as merged");
  assert.deepEqual(view("PG6"), ["dropped", "0 of 1 merged", null, 0, ["T60"]], "dropped by the decision row of the owner's answer, after its gate row was lost");
  assert.deepEqual(view("PG7"), ["lost", "0 of 1 merged", null, 0, ["T75"]]);
  assert.deepEqual(view("PG9"), ["changing", "0 of 1 merged", null, 1, []]);
  assert.equal(programOf(model, "PG1").key, "claude/sage-ff5ee2/PG1");
  assert.deepEqual(programOf(model, "PG1").tasks.map(key => key.split("/").at(-1)), ["T1", "T2", "T3", "T10", "T12", "T11", "T13"], "the pilot first, then each task after what it waits for, then by id");
});

test("T233 C5, T383: a loop of waits from a hand edit ends: the order marks each task once; each task of the loop cannot start, with a repair line", () => {
  const model = programsModel(), loop = programOf(model, "PG8");
  assert.deepEqual(loop.tasks.map(key => key.split("/").at(-1)), ["T80", "T82", "T83", "T81"]);
  assert.deepEqual([loop.next, loop.waiting, loop.cannotStart], [null, 0, ["T82", "T83", "T81"]]);
  assert.deepEqual(cardOf(model, "T81").waitLine, { never: true, text: "Waits for T82 (not started, in a loop): it cannot start. Its waits make a loop, which never ends: the chief sets its waits again." });
  assert.deepEqual(cardOf(model, "T81").waits[0], { id: "T82", state: "framed", word: "not started, in a loop", pilot: false, met: false, never: true, loop: true });
  // A wait on a task of no loop stays a plain wait: T13 waits for T12, which is in review.
  assert.deepEqual(cardOf(model, "T13").waitLine, { never: false, text: "Waits for T12 (in review)." });
});

test("T233 Q1, QA, QC, C8: only a breakdown gate by data gets the program mark (sample T70 gets none); a stuck program and a lost gate need you with no card, and count", () => {
  const model = programsModel();
  const [g12] = cardOf(model, "T30").reasons, [g15] = cardOf(model, "T70").reasons;
  assert.deepEqual(g12.breakdown, { key: "claude/sage-ff5ee2/PG3", id: "PG3", name: "Board programs" });
  assert.equal(g12.text.split(" ").length, 5, "its stored lines");
  assert.equal(g15.breakdown, null, "T70 copies the breakdown words and options, but no programs row names G15");
  assert.equal(g15.text, "Approve program PG9 Fast lane (pilot T70)? Goal: skip the reviews. Name: Fast lane", "one line");
  assert.deepEqual(model.programNeeds.map(need => [need.kind, need.title, need.text]), [
    ["stuck", "PG2 Lead build is stuck", "The pilot T21 was abandoned. Choose a new pilot, or drop the program."],
    ["lost", "The breakdown gate G30 of PG7 is not in the logbook", "Ask the chief to repair the logbook, or to propose PG7 again."],
  ]);
  assert.equal(model.needsOwner.length, 2, "two cards: T30 and T70");
  assert.equal(model.counts.needsOwner, 4, "the two cards and the two program items");
  assert.deepEqual(model.projects.map(project => [project.needsOwner, project.list]), [[4, "needs"]]);
  // A breakdown gate whose programs row names another gate is a plain gate too.
  const tables = programsTables();
  tables.programs[2].gate = "G99";
  const moved = programsModel([programsSource("claude", tables)]);
  assert.equal(cardOf(moved, "T30").reasons[0].breakdown, null);
  assert.equal(cardOf(moved, "T30").reasons[0].text.split(" ").length, 1);
  // A pilot that the logbook lost makes the program stuck, with its own words.
  const gone = programsTables();
  gone.tasks = gone.tasks.filter(item => item.id !== "T40");
  assert.equal(programsModel([programsSource("claude", gone)]).programNeeds.find(need => need.program === "PG4").text, "The pilot T40 is not in the logbook. Choose a new pilot, or drop the program.");
  // An archived project's program items leave the counts, as its cards do.
  const archived = programsSource();
  archived.projects[0].archived = true;
  const folded = programsModel([archived]);
  assert.deepEqual([folded.counts.needsOwner, folded.programNeeds.length], [0, 0]);
});

test("T233 C4: PG1 in the Claude and the Codex logbook of one project stays two programs, and a wait resolves only in its own logbook", () => {
  const codex = { tasks: [{ ...programsTables().tasks[0], id: "T2", state: "framed", program: "PG1", waits: "T1" }, { ...programsTables().tasks[0], id: "T5", state: "framed", program: "PG1" }],
    gates: [{ id: "G1", task: "T5", question: "Approve program PG1? No task builds before you approve.", options: "approve|change|drop", recommendation: "approve", default: "", answer: "approve", at: "" }],
    programs: [{ id: "PG1", name: "Codex own", goal: "g", pilot: "T5", gate: "G1", at: "" }], decisions: [] };
  const model = programsModel([programsSource("claude"), programsSource("codex", codex)]);
  assert.equal(model.projects.length, 1, "one project: one checkout");
  const both = model.programs.filter(item => item.id === "PG1");
  assert.deepEqual(both.map(item => [item.key, item.name, item.progressText]), [["claude/sage-ff5ee2/PG1", "Codex support", "3 of 7 merged · T10 abandoned"], ["codex/sage-ff5ee2/PG1", "Codex own", "0 of 2 merged"]]);
  assert.deepEqual(model.tasks.find(item => item.key === "codex/sage-ff5ee2/T2").waitLine, { never: true, text: "Waits for T1 (not in the logbook) and T5 (pilot, not started): it cannot start." }, "the Claude logbook's merged T1 meets no wait of the Codex logbook");
});

test("F-T233-5: a long chain of waits with no loop, in reverse order, gives its order with no stack overflow, and the loop guard still holds", () => {
  // 6000 tasks: T6000 waits for T5999, … T2 waits for T1, the pilot. The rows come last task first, so the walk starts at the deep end.
  const one = programsTables().tasks[0], N = 6000;
  const tasks = Array.from({ length: N }, (_, i) => ({ ...one, id: `T${N - i}`, state: "framed", program: "PG1", waits: N - i > 1 ? `T${N - i - 1}` : "" }));
  const tables = { tasks, gates: [{ id: "G1", task: "T1", question: "Approve program PG1? No task builds before you approve.", options: "approve|change|drop", recommendation: "approve", default: "", answer: "approve", at: "" }],
    programs: [{ id: "PG1", name: "Chain", goal: "g", pilot: "T1", gate: "G1", at: "" }], decisions: [] };
  const chain = programOf(programsModel([programsSource("claude", tables)]), "PG1");
  assert.equal(chain.tasks.length, N);
  assert.deepEqual([chain.tasks[0], chain.tasks[1], chain.tasks.at(-1)].map(key => key.split("/").at(-1)), ["T1", "T2", `T${N}`]);
  assert.ok(chain.tasks.every((key, i) => key.endsWith(`/T${i + 1}`)), "each task after the task that it waits for");
  assert.equal(chain.next.id, "T1");
  // The loop guard of C5 still holds with the walk: the sample loop T81 ↔ T82 keeps its order.
  assert.deepEqual(programOf(programsModel(), "PG8").tasks.map(key => key.split("/").at(-1)), ["T80", "T82", "T83", "T81"]);
});

test("F-T233-2, F-T233-3: the model counts a lost program whose gate is open on a card once, on that gate; with the gate row gone it is its own item", () => {
  const plain = programsTables();
  plain.gates.find(gate => gate.id === "G12").options = "yes|no";
  const model = programsModel([programsSource("claude", plain)]);
  assert.deepEqual([programOf(model, "PG3").state, programOf(model, "PG3").gateFound], ["lost", true]);
  assert.deepEqual(model.programNeeds.map(need => need.program), ["PG2", "PG7"], "no item of its own for PG3");
  assert.equal(cardOf(model, "T30").reasons[0].text.split("\u2028").at(-1), "The gate G12 of PG3 is not a breakdown gate on its pilot T30: ask the chief to repair the logbook, or to propose PG3 again.");
  assert.equal(model.counts.needsOwner, 4);
  // A hand edit of the question alone (F-T233-3): the state tool's state is proposed, but every printer reads lost.
  const edited = programsTables();
  edited.gates.find(gate => gate.id === "G12").question = "Ship it?";
  const shown = programsModel([programsSource("claude", edited)]);
  assert.equal(programOf(shown, "PG3").state, "lost");
  assert.deepEqual(cardOf(shown, "T32").waitLine, { never: true, text: "Waits for the PG3 breakdown, whose gate G12 names no program in its question: it cannot start." }, "T383 item 12: the reason names the question");
  // The gate answered: no card holds it, so the program is its own item, with the same words.
  const answered = programsTables();
  Object.assign(answered.gates.find(gate => gate.id === "G12"), { options: "yes|no", answer: "yes" });
  assert.deepEqual(programsModel([programsSource("claude", answered)]).programNeeds.find(need => need.program === "PG3").title, "The gate G12 of PG3 is not a breakdown gate on its pilot T30");
});

// T383: the board's data rules on damaged or hand-edited logbooks, and its cost on large ones. SAMPLE DATA from scripts/fixtures/board-programs.mjs.
const needsOf = model => model.programNeeds.map(need => [need.kind, need.title, need.text]);
const STUCK_PG2 = ["stuck", "PG2 Lead build is stuck", "The pilot T21 was abandoned. Choose a new pilot, or drop the program."];
const LOST_PG7 = ["lost", "The breakdown gate G30 of PG7 is not in the logbook", "Ask the chief to repair the logbook, or to propose PG7 again."];
const edited = edit => { const tables = programsTables(); edit(tables); return programsModel([programsSource("claude", tables)]); };

test("T383 item 2: a lost program whose gate is open on an abandoned task stays in Needs you, as no card in Needs you holds that gate", () => {
  const model = edited(tables => {
    tables.gates.find(gate => gate.id === "G12").options = "yes|no";
    tables.tasks.find(task => task.id === "T30").state = "abandoned";
  });
  assert.deepEqual(needsOf(model), [STUCK_PG2, ["lost", "The gate G12 of PG3 is not a breakdown gate on its pilot T30", "Ask the chief to repair the logbook, or to propose PG3 again."], LOST_PG7]);
  assert.equal(model.counts.needsOwner, 4, "T70 and the three items; T30 is abandoned, so it has no card in Needs you");
});

test("T383 items 4 and 13: a proposed or changing program whose pilot is abandoned or not in the logbook is stuck: a Needs you item, not a breakdown that waits for you", () => {
  const abandoned = edited(tables => { tables.tasks.find(task => task.id === "T30").state = "abandoned"; });
  assert.equal(programOf(abandoned, "PG3").state, "stuck");
  assert.deepEqual(needsOf(abandoned), [STUCK_PG2, ["stuck", "PG3 Board programs is stuck", "The pilot T30 was abandoned. Choose a new pilot, or drop the program."], LOST_PG7]);
  const missing = edited(tables => { tables.tasks = tables.tasks.filter(task => task.id !== "T30"); });
  assert.deepEqual(needsOf(missing)[1], ["stuck", "PG3 Board programs is stuck", "The pilot T30 is not in the logbook. Choose a new pilot, or drop the program."]);
  const changing = edited(tables => { tables.tasks.find(task => task.id === "T90").state = "abandoned"; });
  assert.equal(programOf(changing, "PG9").state, "stuck", "changing too");
  assert.equal(programOf(programsModel(), "PG3").state, "proposed", "a live pilot keeps its program proposed");
});

test("T383 item 7: when tasks.tsv and programs.tsv of one logbook both fail, or every table has one error code, one item says why", () => {
  const broken = diagnostics => { const source = programsSource(); Object.assign(source.projects[0], { tables: {}, diagnostics }); return buildBoardModel([source], { now: PROGRAMS_NOW }); };
  assert.deepEqual(needsOf(broken(["tasks: line 14 has 9 cells, and its header has 16", "programs: line 2: the pilot of PG1 is not a task id"])), [
    ["logbook", "The Claude logbook cannot be read", "tasks.tsv line 14 has 9 cells, and its header has 16. programs.tsv line 2: the pilot of PG1 is not a task id. The board shows no task of sage-ff5ee2. Ask the chief to repair the logbook."]]);
  const folder = broken(["tasks", "runs", "findings", "ledger", "gates", "decisions", "programs"].map(name => `${name}: EACCES`));
  assert.deepEqual(needsOf(folder), [["logbook", "The Claude logbook cannot be read", "Its folder has no read permission. The board shows no task of sage-ff5ee2. Ask the chief to repair the logbook."]]);
  assert.equal(folder.counts.needsOwner, 1);
  // With its tasks readable, the programs table keeps its own item.
  const source = programsSource(); source.projects[0].diagnostics = ["programs: line 2: the pilot of PG1 is not a task id"]; delete source.projects[0].tables.programs;
  assert.deepEqual(needsOf(buildBoardModel([source], { now: PROGRAMS_NOW })).map(([kind]) => kind), ["programs"]);
});

test("T383 item 9: a live task whose program row is missing, or whose program cell is not a program id, is a Needs you item; an ended one is not", () => {
  const model = edited(tables => {
    const one = tables.tasks[0];
    tables.tasks.push({ ...one, id: "T95", state: "framed", program: "PG20" }, { ...one, id: "T96", state: "building", program: "PG20" }, { ...one, id: "T97", state: "framed", program: "?" }, { ...one, id: "T98", state: "merged", program: "PG21" });
  });
  assert.deepEqual(needsOf(model).slice(2), [
    // R1391-4: T96 is building, so "cannot go on", not "cannot start".
    ["missing", "The program PG20 is not in the logbook", "T95 and T96 name PG20, so they cannot go on. Ask the chief to repair the logbook, or to take each task out of the program."],
    ["missing", "A program cell is not a program id", "The program cell of T97 is not a program id, so it cannot go on. Ask the chief to repair the logbook, or to take the task out of the program."]]);
  assert.equal(model.counts.needsOwner, 6);
});

test("T383 item 10: a provider root that cannot be read is a counted Needs you item; a root that does not exist is not", () => {
  const root = (diagnostics) => ({ id: "codex", label: "codex", provider: null, config: {}, diagnostics, projects: [], hooks: { present: false, slots: [], helpers: [], problem: null } });
  const model = buildBoardModel([programsSource(), root(["EACCES"])], { now: PROGRAMS_NOW });
  assert.deepEqual(needsOf(model).at(-1), ["source", "The Codex logbooks cannot be read", "Its folder has no read permission. The board shows no Codex logbook. Check that the board can read the folder."]);
  assert.equal(model.counts.needsOwner, 5, "T30, T70, two program items and the root");
  for (const quiet of [["ENOENT"], ["config: invalid JSON"]]) assert.equal(buildBoardModel([programsSource(), root(quiet)], { now: PROGRAMS_NOW }).counts.needsOwner, 4, quiet[0]);
});

test("T383 item 12: a gate on the pilot with the breakdown options, whose question names no program or another, is lost by its question, in those words", () => {
  const other = edited(tables => { tables.gates.find(gate => gate.id === "G12").question = "Approve program PG4? No task builds before you approve."; });
  assert.equal(cardOf(other, "T30").reasons[0].text.split("\u2028").at(-1), "The gate G12 of PG3 names PG4 in its question, not PG3: ask the chief to repair the logbook, or to propose PG3 again.");
  assert.deepEqual(cardOf(other, "T32").waitLine, { never: true, text: "Waits for the PG3 breakdown, whose gate G12 names PG4 in its question, not PG3: it cannot start." });
  const none = edited(tables => { Object.assign(tables.gates.find(gate => gate.id === "G12"), { question: "Ship it?", answer: "yes" }); });
  assert.deepEqual(none.programNeeds.find(need => need.program === "PG3").title, "The gate G12 of PG3 names no program in its question");
});

/**
 * Work units of fn, counted, not timed (T383 item 14): each element that an array method or an array, Map or Set
 * iterator visits while fn runs. The prototypes are restored after it.
 */
function work(fn) {
  let units = 0;
  const saved = [];
  const patch = (proto, name, make) => { saved.push([proto, name, proto[name]]); proto[name] = make(proto[name]); };
  for (const name of ["filter", "map", "find", "findIndex", "findLast", "findLastIndex", "some", "every", "forEach", "reduce", "flatMap", "includes", "indexOf", "slice", "sort"]) {
    patch(Array.prototype, name, original => function (...args) { units += this.length; return original.apply(this, args); });
  }
  for (const proto of [Array.prototype, Map.prototype, Set.prototype]) for (const name of ["values", "keys", "entries", Symbol.iterator]) {
    patch(proto, name, original => function () { const it = original.call(this); return { next: () => { units++; return it.next(); }, [Symbol.iterator]() { return this; } }; });
  }
  try { fn(); } finally { for (let i = saved.length - 1; i >= 0; i--) saved[i][0][saved[i][1]] = saved[i][2]; }
  return units;
}
/** A large SAMPLE logbook: n tasks in n/2 programs, half approved and half proposed (an odd task is the pilot), with a run, a verdict, a decision and a finding each. */
function large(n) {
  const one = programsTables().tasks[0], at = "2026-10-20T10:00:00Z", tasks = [], gates = [], programs = [], runs = [], ledger = [], decisions = [], findings = [];
  for (let i = 1; i <= n; i++) {
    const pg = `PG${Math.ceil(i / 2)}`, pilot = i % 2 === 1;
    tasks.push({ ...one, id: `T${i}`, state: pilot ? "merged" : "reviewing", pr: String(i), program: pg, waits: i > 2 && !pilot ? `T${i - 2}` : "" });
    if (pilot) {
      gates.push({ id: `G${i}`, task: `T${i}`, question: `Approve program ${pg}? No task builds before you approve.`, options: "approve|change|drop", recommendation: "approve", default: "", answer: i % 4 === 1 ? "approve" : "", at });
      programs.push({ id: pg, name: `Sample ${pg}`, goal: "g", pilot: `T${i}`, gate: `G${i}`, at });
    }
    runs.push({ id: `R${i}`, task: `T${i}`, role: "implementer", round: "0", candidate: "", branch: "", status: "done", tokens: "1000", report: "", started: at, ended: at });
    ledger.push({ task: `T${i}`, pr: String(i), sha: "a".repeat(40), kind: "checks-pass", cycle: "1", run: `R${i}`, at });
    decisions.push({ at, task: `T${i}`, decision: "state reviewing", why: "sample" });
    findings.push({ task: `T${i}`, key: "F-1", round: "1", source: "code-review", severity: "low", summary: "Sample", triage: "", reason: "", status: "open" });
  }
  return { tasks, gates, programs, runs, ledger, decisions, findings };
}

/** The large logbook as a source, with an observed PR for each task, so the records index is in the work too (R1390-2). */
function largeSource(n) {
  const source = programsSource("claude", large(n));
  source.projects[0].observations.records = source.projects[0].tables.tasks.map(row => observation("pr", { number: Number(row.pr), head, state: "open" }, { id: `O${row.pr}`, task: row.id }));
  return source;
}
// Four times the rows: linear work is about 4 times, a quadratic step about 16 times. A scan of the records or of the
// programs for each card (in place of the records and byGate indexes) passes 5 (R1390-2); 5 leaves room for fixed costs.
test("T383 item 14: the board model is linear in a large logbook: four times the rows is about four times the work", () => {
  const board = n => work(() => buildBoardModel([largeSource(n)], { now: PROGRAMS_NOW }));
  const [small, big] = [board(400), board(1600)];
  assert.ok(big / small < 5, `the board's work: ${small} units for 400 tasks, ${big} for 1600 (linear is about 4 times)`);
});

test("T383 item 14: the printers' wait graph (status and the task line) is linear in a large logbook", () => {
  // The status line and the task line read the waits with the same rules: the graph, and each task's unmet waits.
  const rules = n => { const t = large(n); return work(() => { const graph = shownGraph(waitGraph(t.tasks, t.programs, t.gates, t.decisions), t.gates); for (const task of t.tasks) unmetWaits(task, graph); }); };
  const [few, many] = [rules(400), rules(800)];
  assert.ok(many / few < 2.5, `the rules' work: ${few} units for 400 tasks, ${many} for 800`);
});
