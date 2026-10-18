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


test("task detail derives brief fields, and the step line shows only the route's steps (T305: no struck-through step)", () => {
  const input = source("one", [task("T1", "building")], {}, [observation("artifact", { type: "brief", label: "Brief" })]);
  input.projects[0].contents = { O1: { verified: true, text: "**GOAL:** Ship the board\nSCOPE: This task\n## ACCEPTANCE\nAll views agree\n- Keep sources separate\nVERIFY: Tests" } };
  const result = buildBoardModel([input], { now }).tasks[0];
  assert.equal(result.briefFields.goal, "Ship the board");
  assert.equal(result.briefFields.acceptance, "All views agree\n- Keep sources separate");
  assert.deepEqual(result.loop.steps.map(step => `${step.label}: ${step.status}`), ["Plan: done", "Build: run", "Review 1 of 1: wait", "Merge: wait"]);
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
  assert.equal(result.loop.now.text, "The PE check runs");
  input.projects[0].tables.runs = [];
  assert.deepEqual(buildBoardModel([input], { now }).tasks[0].loop.steps[0].parts, [["framed", "done"], ["design", "run"], ["PE check", "wait"], ["briefed", "wait"]], "no PE run recorded: the design runs");
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
    { folder: "live", tasks: [task("T1", "framed"), task("T2", "held")] },
    { folder: "old", tasks: [task("T1", "framed"), task("T2", "held"), task("T3", "building")], config: { name: "Old app", archived: true } },
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
const oneTask = (row, tables = {}, records = [], config = {}) => buildBoardModel([{ ...source("one", [row], tables, records), config }], { now }).tasks[0];

test("T305: the step line and the Now and Next lines follow the fixed rule of each state on a build route", () => {
  const running = role => ({ runs: [{ id: "R7", task: "T1", role, status: "running", started: "2026-10-08T19:20:00Z" }] });
  assert.deepEqual([line(oneTask(task("T1", "framed"))), oneTask(task("T1", "framed")).loop.now, oneTask(task("T1", "framed")).loop.next], [["Plan: wait", "Build: wait", "Review 1 of 1: wait", "Merge: wait"], { needs: false, text: "In the backlog. No agent works on it." }, "The build"]);
  const building = oneTask(task("T1", "building"), running("implementer"));
  assert.deepEqual(line(building), ["Plan: done", "Build: run", "Review 1 of 1: wait", "Merge: wait"]);
  assert.equal(building.loop.steps[1].detail, "The implementer (run R7) is at work, 40 min.");
  assert.deepEqual([building.loop.now.text, building.loop.next], ["The implementer builds it", "Review cycle 1 of 1 starts when the PR opens"]);
  const held = oneTask(task("T1", "held"), { gates: [{ id: "G3", task: "T1", question: "Sample: refuse the copy?", recommendation: "yes", answer: "" }] });
  assert.deepEqual(line(held), ["Plan: done", "Build: need", "Review 1 of 1: wait", "Merge: wait"]);
  assert.equal(held.loop.steps[1].detail, "Held at gate G3 (the question above).");
  assert.deepEqual([held.loop.now, held.loop.next], [{ needs: true, text: "Sample: refuse the copy? I recommend: yes" }, "The build continues after your answer"]);
  const verified = oneTask(task("T1", "verified", { pr: "41" }), { ledger: [{ task: "T1", pr: "41", sha: head, kind: "checks-pass", cycle: "1", at: now }, { task: "T1", pr: "41", sha: head, kind: "review-clean", cycle: "1", at: now }, { task: "T1", pr: "41", sha: head, kind: "qa-pass", cycle: "1", at: now }] }, [observation("mode", { autopilot: false })]);
  assert.deepEqual(line(verified), ["Plan: done", "Build: done", "Review 1 of 1: done", "Merge: need"]);
  assert.deepEqual([verified.loop.now, verified.loop.next], [{ needs: true, text: "Autopilot is off: review and merge PR 41." }, "Done after the merge"]);
  const auto = oneTask(task("T1", "verified", { pr: "41" }), {}, [observation("mode", { autopilot: true })]);
  assert.deepEqual([line(auto).at(-1), auto.loop.now.text], ["Merge: run", "Verified: autopilot merges PR 41"]);
  const merged = oneTask(task("T1", "merged", { pr: "41" }));
  assert.deepEqual([line(merged), merged.loop.next], [["Plan: done", "Build: done", "Review 1 of 1: done", "Merge: done"], null]);
});

test("T305: in review, the current cycle runs and its roles have words; the next role, then the next cycle, is Next", () => {
  const records = [observation("pr", { number: 12, head, state: "open" }), observation("run", { run: "R1", provider: "Codex", head, cycle: 1 }, { id: "O2" })];
  const ledger = [{ task: "T1", pr: "12", sha: head, kind: "checks-pass", cycle: "1", at: now }, { task: "T1", pr: "12", sha: head, kind: "review-clean", cycle: "1", run: "R0", at: now }];
  const runs = [{ id: "R0", task: "T1", role: "code-reviewer", status: "done" }, { id: "R1", task: "T1", role: "security-reviewer", status: "running", started: "2026-10-08T19:35:00Z" }];
  const card = oneTask(task("T1", "reviewing", { pr: "12", risk: "auth", route: "build,code-review,security-review,qa" }), { ledger, runs }, records);
  assert.deepEqual(line(card), ["Plan: done", "Build: done", "Review 1 of 2: run", "Review 2 of 2: wait", "Merge: wait"]);
  assert.deepEqual(card.loop.steps[2].parts, [["checks", "done"], ["code review", "done"], ["security review", "run"], ["QA", "wait"]]);
  assert.equal(card.loop.steps[2].detail, "On the last commit (aaaaaaa). The security review (run R1) started 25 min ago.");
  assert.equal(card.loop.steps[3].detail, "A risk flag (auth) needs 2 clean cycles.");
  assert.deepEqual([card.loop.now.text, card.loop.next], ["security review runs (cycle 1 of 2)", "QA, then review cycle 2 of 2"]);
  const unknown = oneTask(task("T1", "reviewing", { pr: "12" }));
  assert.equal(unknown.loop.steps[2].detail, "No verdict is recorded on the PR's last commit yet.", "plain words, not 'PR head not recorded'");
  assert.deepEqual(unknown.loop.steps[2].parts.map(([, value]) => value), ["unknown", "unknown", "unknown"]);
});

test("T305: a repair is its own step, round n of m, then Review again; the round count comes from max_rounds", () => {
  const ledger = [{ task: "T1", pr: "52", sha: head, kind: "checks-pass", cycle: "1", at: now }, { task: "T1", pr: "52", sha: head, kind: "findings", cycle: "1", run: "R2", at: now }];
  const runs = [{ id: "R2", task: "T1", role: "code-reviewer", round: "0", status: "done" }, { id: "R3", task: "T1", role: "implementer", round: "1", status: "running", started: "2026-10-08T17:50:00Z" }];
  const card = oneTask(task("T1", "repairing", { pr: "52", round: "1" }), { ledger, runs }, [], { max_rounds: 4 });
  assert.deepEqual(line(card), ["Plan: done", "Build: done", "Review 1 of 1: fail", "Repair, round 1 of 4: run", "Review again: wait", "Merge: wait"]);
  assert.equal(card.loop.steps[2].detail, "The code review found problems on aaaaaaa.");
  assert.equal(card.loop.steps[3].detail, "The implementer (run R3) fixes the findings on the same branch, 2 h 10 min.");
  assert.deepEqual([card.loop.now.text, card.loop.next], ["Repair, round 1 of 4: fix the open findings", "The reviews start again at cycle 1 on the new commit"]);
});

test("T305: an investigation shows Plan, Investigate, Evidence review and Conclude, with no Build and no Merge", () => {
  const route = "investigate,evidence-review";
  const verifying = oneTask(task("T1", "verifying", { size: "investigate", route }), { runs: [{ id: "R19", task: "T1", role: "evidence-review", status: "running", started: now }] });
  assert.deepEqual(line(verifying), ["Plan: done", "Investigate: done", "Evidence review: run", "Conclude: wait"]);
  assert.deepEqual([verifying.loop.now.text, verifying.loop.next], ["The evidence review checks the report", "Concluded: the report comes to you, with no PR"]);
  assert.deepEqual(line(oneTask(task("T1", "building", { size: "investigate", route }))), ["Plan: done", "Investigate: run", "Evidence review: wait", "Conclude: wait"]);
  assert.deepEqual(line(oneTask(task("T1", "concluded", { size: "investigate", route }))), ["Plan: done", "Investigate: done", "Evidence review: done", "Conclude: done"]);
});

test("T305: a run's time is minutes or hours up to 24 h; after 24 h with no logbook change, the run may have stopped", async () => {
  const { runClock } = await import("../packages/sage-core/board-model.mjs");
  const at = Date.parse(now);
  assert.deepEqual(runClock("2026-10-08T19:20:00Z", at, null), { text: "40 min", stale: false });
  assert.deepEqual(runClock("2026-10-08T16:55:00Z", at, null), { text: "3 h 5 min", stale: false });
  assert.deepEqual(runClock("2026-10-05T08:00:00Z", at, "2026-10-05T08:00:00Z"), { text: "no news since 5 Oct: the run may have stopped; ask the sage to check it", stale: true });
  assert.deepEqual(runClock("2026-10-05T08:00:00Z", at, "2026-10-08T12:00:00Z"), { text: "since 5 Oct", stale: false }, "a change in the last 24 h: not stale");
  const card = oneTask(task("T1", "building"), { runs: [{ id: "R5", task: "T1", role: "implementer", status: "running", started: "2026-10-05T08:00:00Z" }] });
  assert.equal(card.runClocks.R5.text, "no news since 5 Oct: the run may have stopped; ask the sage to check it");
  assert.equal(card.loop.steps[1].detail, "The implementer (run R5) is at work, no news since 5 Oct: the run may have stopped; ask the sage to check it.");
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
  assert.equal(missing.projects.length, 1);
  assert.deepEqual(missing.notes.map(note => note.message), ["One project: the checkout of codex/sage-43265b is not known, and the logbook key is the same."]);
  const apart = twoSources([book([task("T1", "framed")])], [book([task("T2", "framed")], { checkout: "/sample/other/sage" })]);
  assert.deepEqual(apart.projects.map(project => project.key).sort(), ["claude/sage-43265b", "codex/sage-43265b"], "never merge on doubt");
  assert.deepEqual(apart.notes.map(note => note.message), ["Two projects: claude/sage-43265b and codex/sage-43265b have one logbook key but name different checkouts, so the board keeps them apart."]);
  const clones = twoSources([book([task("T1", "framed")]), book([task("T1", "framed")], { name: "sage-9a9a9a", checkout: "/sample/clone/sage" })], []);
  assert.deepEqual(clones.projects.map(project => [project.key, project.name]).sort(), [["sage-43265b", "sage"], ["sage-9a9a9a", "sage"]], "two clones at two paths stay two projects");
  assert.deepEqual(clones.projects.map(project => [project.key, project.sub]).sort(), [["sage-43265b", "sample-owner · /sample/work/sage"], ["sage-9a9a9a", "sample-owner · /sample/clone/sage"]], "F-T305-11: two clones in folders of one name show their paths");
  const local = twoSources([book([task("T1", "framed")], { repository: null, checkout: "/sample/a/lab" }), book([task("T1", "framed")], { name: "lab-9a9a9a", repository: null, checkout: "/sample/b/lab" }), book([task("T1", "framed")], { name: "lab-copy-1b1b1b", repository: null, checkout: "/sample/b/lab-copy" })], []);
  assert.deepEqual(local.projects.map(project => project.sub).sort(), ["no GitHub remote · /sample/a/lab", "no GitHub remote · /sample/b/lab", "no GitHub remote · folder lab-copy"]);
  // F-T305-3: one unreadable logbook does not rename the project that the other logbook names.
  const broken = twoSources([book([task("T1", "framed")], { displayName: "Sage (sample)" })], [book([], { diagnostics: ["tasks: damaged table header"] })]);
  assert.deepEqual(broken.projects.map(project => [project.name, project.problem]), [["Sage (sample)", "tasks: damaged table header"]]);
  assert.deepEqual(broken.tasks.map(card => card.projectName), ["Sage (sample)"]);
  const unnamed = twoSources([book([task("T1", "framed")])], [book([], { diagnostics: ["tasks: damaged table header"] })]);
  assert.deepEqual(unnamed.projects.map(project => project.name), ["sage"], "the remote names it");
  const names = twoSources([book([task("T1", "framed")], { displayName: "Sage (sample)" })], [book([task("T2", "framed")], { displayName: "Other name", archived: true })]);
  assert.deepEqual([names.projects[0].name, names.projects[0].archived], ["Sage (sample)", true]);
  assert.deepEqual(names.notes.map(note => note.message), ['Two display names: the board shows "Sage (sample)" (the first source), not "Other name".', "Archived in codex/sage-43265b only: the board archives the project."]);
});

test("T305: the picker's list puts needs you first, then active in the last 14 days, idle and archived, with every name a person may know", () => {
  const decision = (id, at) => [{ task: id, at, decision: "sample", why: "sample" }];
  // Activity: fresh had a decision 2 days ago, old 20 days ago.
  const withActivity = buildBoardModel([{ id: "claude", label: "claude", provider: "Claude", diagnostics: [], projects: [
    { key: "claude/product-demos-1c0254", name: "product-demos-1c0254", checkout: "/sample/work/sdc/product-demos", repository: "https://github.com/sample-owner/seacc", upstream: "https://github.com/sample-org/seacc", displayName: "seacc (Council Record)", diagnostics: [], tables: { tasks: [task("T41", "held")] } },
    { key: "claude/fresh-aaaaaa", name: "fresh-aaaaaa", checkout: "/sample/work/fresh", diagnostics: [], tables: { tasks: [task("T1", "framed")], decisions: decision("T1", "2026-10-06T20:00:00Z") } },
    { key: "claude/old-bbbbbb", name: "old-bbbbbb", checkout: "/sample/work/old", repository: "https://github.com/sample-owner/old", diagnostics: [], tables: { tasks: [task("T1", "framed")], decisions: decision("T1", "2026-09-18T20:00:00Z") } },
    { key: "claude/gone-cccccc", name: "gone-cccccc", checkout: "/sample/work/gone", archived: true, diagnostics: [], tables: { tasks: [task("T1", "framed")] } },
    { key: "claude/broken-dddddd", name: "broken-dddddd", checkout: "/sample/work/broken", diagnostics: ["tasks: damaged table header"], tables: {} },
  ] }], { now });
  assert.deepEqual(withActivity.projects.map(project => [project.list, project.name, project.needsOwner]), [["needs", "seacc (Council Record)", 1], ["active", "fresh", 0], ["idle", "old", 0], ["idle", "broken-dddddd", 0], ["archived", "gone", 0]]);
  const sdc = withActivity.projects[0];
  assert.equal(sdc.sub, "sample-org/seacc · folder product-demos");
  assert.deepEqual(sdc.terms, ["seacc (Council Record)", "sample-org/seacc", "sample-owner/seacc", "product-demos", "/sample/work/sdc/product-demos", "product-demos-1c0254", "claude/product-demos-1c0254"]);
  assert.deepEqual(withActivity.projects.map(project => project.sub), ["sample-org/seacc · folder product-demos", "no GitHub remote · folder fresh", "sample-owner · folder old", "no GitHub remote · folder broken", "no GitHub remote · folder gone"], "F-T305-11: no GitHub remote comes first, so the line never cuts it off");
  assert.equal(withActivity.projects[3].problem, "tasks: damaged table header", "an unreadable logbook is named by its folder, with the reason");
});
