import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { releasesOf } from "../packages/sage-core/milestone-rules.mjs";
import { taskWord } from "../packages/sage-core/state-words.mjs";

const TOOL = fileURLToPath(new URL("../plugins/sage/skills/sage/sage.mjs", import.meta.url));
const SPY = fileURLToPath(new URL("kill-spy.mjs", import.meta.url));
const REPO = fileURLToPath(new URL("..", import.meta.url));
const OLDER = "b480ad53ff446aab03089f333aadcc8e55eb4cb9";

const rowsOf = (dir, table) => {
  const [head, ...lines] = readFileSync(join(dir, `${table}.tsv`), "utf8").split("\n").filter(Boolean);
  return lines.map((line) => Object.fromEntries(line.split("\t").map((v, i) => [head.split("\t")[i], v])));
};
const headOf = (dir, table) => readFileSync(join(dir, `${table}.tsv`), "utf8").split("\n")[0].split("\t");
const snapshot = (dir) => Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".tsv")).sort().map((f) => [f, readFileSync(join(dir, f), "utf8")]));
function setStates(dir, states) {
  const [head, ...lines] = readFileSync(join(dir, "tasks.tsv"), "utf8").split("\n").filter(Boolean), at = head.split("\t").indexOf("state");
  writeFileSync(join(dir, "tasks.tsv"), [head, ...lines.map((line) => { const v = line.split("\t"); if (states[v[0]]) v[at] = states[v[0]]; return v.join("\t"); })].join("\n") + "\n");
}

function logbook(tasks = 5) {
  const home = mkdtempSync(join(tmpdir(), "sage-release-")), project = mkdtempSync(join(tmpdir(), "sage-release-project-"));
  const env = { ...process.env, HOME: home, SAGE_HOME: home, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${JSON.stringify(SPY)}`.trim(), SAGE_TEST_KILLS: join(home, "kills"), SAGE_TEST_PIDS: "{}" };
  const run = (tool, args) => spawnSync(process.execPath, [tool, ...args, "--project", project], { encoding: "utf8", env, timeout: 60_000 });
  const ok = (...args) => { const r = run(TOOL, args); assert.equal(r.status, 0, `sage ${args.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };
  const no = (...args) => { const r = run(TOOL, args); assert.equal(r.status, 1, `sage ${args.join(" ")} should be refused: ${r.stdout}`); return r.stderr.trim(); };
  const dir = ok("init").replace(/^\S+ /, "");
  for (let n = 1; n <= tasks; n++) ok("task", "add", "--title", `Sample task ${n}`, "--size", "small", "--priority", "P2");
  const levels = () => ok("status").split("\n").filter((l) => /^(release|milestone) /.test(l));
  return { home, dir, run, ok, no, levels };
}

test("T1003: a logbook without releases reads and writes as before: no release line, no release column, and no releases table until the first release", () => {
  const s = logbook(2);
  rmSync(join(s.dir, "releases.tsv"));
  s.ok("milestone", "propose", "--name", "Sage feel", "--goal", "A sample goal", "--pilot", "T1", "--tasks", "T2");
  s.ok("task", "add", "--title", "Sample task 3", "--size", "tiny", "--priority", "P3");
  assert.deepEqual(s.levels(), ["milestone M1 · needs you · pilot T1: 0 of 2 merged · breakdown waits for you (G1) · name: Sage feel"]);
  assert.match(s.ok("task", "T3"), /^T3 framed · tiny · round 0 · route build · P3$/);
  assert.equal(headOf(s.dir, "tasks").includes("release"), false);
  assert.equal(headOf(s.dir, "milestones").includes("release"), false);
  assert.equal(existsSync(join(s.dir, "releases.tsv")), false, "only a release adds the table");
  s.ok("release", "add", "--name", "1.0");
  assert.deepEqual(rowsOf(s.dir, "releases").map((r) => [r.name, r.goal]), [["1.0", ""]]);
  assert.equal(headOf(s.dir, "tasks").includes("release"), false, "a release with no milestone and no task adds no column");
});

test("T1003: release add refuses a name in an id form, none, a separator, or a name that a release has (case and width do not count), and changes nothing", () => {
  const s = logbook(0);
  assert.equal(s.ok("release", "add", "--name", "1.0", "--goal", "Ship the first version"), "release 1.0 added · goal: Ship the first version. Put a milestone in it with sage milestone <M> set release=<name>, and a task outside a milestone with sage task <T> set release=<name>.");
  s.ok("release", "add", "--name", "Beta");
  const before = snapshot(s.dir);
  for (const name of ["１.０", "BETA"]) assert.match(s.no("release", "add", "--name", name), /^sage: the release's name is the name of the release (1\.0|Beta) already \(case and width do not count\): give each release its own name\. Nothing changed\.$/, name);
  for (const name of ["T12", "m5", "Ｍ5", "PG1", "g3", "R7", "C2"]) assert.match(s.no("release", "add", "--name", name), /the release's name has the form of a sage id/, name);
  assert.match(s.no("release", "add", "--name", "None"), /the release's name is none, which takes a milestone or a single task out of its release: give it a name such as 1\.0 or Beta/);
  for (const name of ["1.0, final", "1.0 · done"]) assert.match(s.no("release", "add", "--name", name), /has a comma or a middle dot/, name);
  assert.match(s.no("release", "add", "--name", " 2.0"), /the release's name has a space at its start or end/);
  assert.match(s.no("release", "add", "--name", "2.0", "--goal", ""), /the release's goal has 0 characters/);
  assert.match(s.no("release", "add"), /--name/);
  assert.match(s.no("release", "list"), /^sage: release takes: add --name "<name>" \[--goal "<goal>"\]\./);
  assert.deepEqual(snapshot(s.dir), before, "each refusal changes nothing");
  assert.deepEqual(rowsOf(s.dir, "releases").map((r) => [r.name, r.goal]), [["1.0", "Ship the first version"], ["Beta", ""]], "the rows keep their order");
});

test("T1003: a milestone goes into one release, moves to another one with a decision row, and leaves with release=none", () => {
  const s = logbook(2);
  s.ok("release", "add", "--name", "1.0");
  s.ok("release", "add", "--name", "1.1");
  s.ok("milestone", "propose", "--name", "Sage feel", "--goal", "A sample goal", "--pilot", "T1", "--tasks", "T2");
  assert.equal(s.ok("milestone", "M1", "set", "release=1.0"), "M1 · release 1.0 · name: Sage feel");
  assert.equal(rowsOf(s.dir, "milestones")[0].release, "1.0");
  const before = snapshot(s.dir);
  assert.match(s.no("milestone", "M1", "set", "release=1.0,1.1"), /^sage: M1 is in at most one release: name one release, not 1\.0,1\.1\. Nothing changed\.$/);
  assert.match(s.no("milestone", "M1", "set", "release=1.0", "release=1.1"), /^sage: M1 is in at most one release: give release= once\. Nothing changed\.$/);
  assert.match(s.no("milestone", "M1", "set", "release=2.0"), /^sage: no release 2\.0\. The releases: 1\.0, 1\.1\. To add a release: sage release add --name "<name>"\. Nothing changed\.$/);
  assert.match(s.no("milestone", "M1", "set", "name=x"), /milestone <M> set takes release=<name>/);
  assert.match(s.no("milestone", "M9", "set", "release=1.0"), /no milestone M9\. The latest: M1\./);
  assert.deepEqual(snapshot(s.dir), before, "each refusal changes nothing");
  assert.equal(s.ok("milestone", "M1", "set", "release=1.1"), "M1 · release 1.1 · name: Sage feel");
  assert.equal(s.ok("milestone", "M1", "set", "release=none"), "M1 · release none · name: Sage feel");
  assert.equal(s.ok("milestone", "M1", "set", "release=1.1"), "M1 · release 1.1 · name: Sage feel");
  assert.deepEqual(rowsOf(s.dir, "decisions").filter((d) => d.decision !== "task added").filter((d) => d.why === "milestone set").map((d) => d.decision), ["M1 release none → 1.0", "M1 release 1.0 → 1.1", "M1 release 1.1 → none", "M1 release none → 1.1"]);
  const decisions = rowsOf(s.dir, "decisions").filter((d) => d.decision !== "task added").length;
  s.ok("milestone", "M1", "set", "release=1.1");
  assert.equal(rowsOf(s.dir, "decisions").filter((d) => d.decision !== "task added").length, decisions, "a set to the same release writes no row");
});

test("T1003: a milestone that is proposed again keeps its release, with no release row: after the owner's change, with a new pilot after approval, and at the end of a stopped proposal", () => {
  const s = logbook(3);
  s.ok("release", "add", "--name", "1.0");
  s.ok("milestone", "propose", "--name", "Sage feel", "--goal", "A sample goal", "--pilot", "T1", "--tasks", "T2");
  s.ok("milestone", "M1", "set", "release=1.0");
  const kept = (path) => {
    assert.equal(rowsOf(s.dir, "milestones")[0].release, "1.0", path);
    assert.deepEqual(rowsOf(s.dir, "decisions").filter((d) => d.decision !== "task added").filter((d) => /release/.test(d.decision)).map((d) => d.decision), ["M1 release none → 1.0"], `${path}: no release row`);
    assert.equal(s.levels()[0], "release 1.0 · in progress · 0 of 2 tasks done · milestones M1", path);
  };
  s.ok("gate", "answer", "G1", "--option", "2");
  s.ok("milestone", "propose", "M1", "--goal", "A new sample goal");
  kept("round 2 after change");
  s.ok("gate", "answer", "G2", "--option", "1");
  s.ok("milestone", "propose", "M1", "--pilot", "T2", "--tasks", "T1");
  kept("a new pilot of an approved milestone");
  writeFileSync(join(s.dir, "gates.tsv"), readFileSync(join(s.dir, "gates.tsv"), "utf8").split("\n").filter((l) => !l.startsWith("G3\t")).join("\n"));
  s.ok("milestone", "propose", "--name", "Sage feel");
  kept("the end of a stopped proposal");
});

test("T1003: a release name in the form of a finding move does not move the id floor of the next task", () => {
  const s = logbook(1);
  const name = "moved to T999999 as x:";
  s.ok("release", "add", "--name", name);
  s.ok("task", "T1", "set", `release=${name}`);
  s.ok("task", "T1", "set", "release=none");
  assert.deepEqual(rowsOf(s.dir, "decisions").filter((d) => d.decision !== "task added").filter((d) => d.task === "T1").map((d) => d.decision).slice(-2), [`release none → ${name}`, `release ${name} → none`]);
  assert.match(s.ok("task", "add", "--title", "Sample task 2", "--size", "tiny", "--priority", "P3"), /^T2 framed /);
});

test("T1003: a single task goes into a release; a task of a milestone is refused with the way out; a task that joins a milestone leaves its own release, with a decision row", () => {
  const s = logbook(4);
  s.ok("release", "add", "--name", "1.0");
  s.ok("release", "add", "--name", "Beta");
  s.ok("milestone", "propose", "--name", "Sage feel", "--goal", "A sample goal", "--pilot", "T1", "--tasks", "T2");
  assert.match(s.ok("task", "T3", "set", "release=beta"), /^T3 framed · small · round 0 · route build,code-review,qa · P2 · release Beta$/, "the release's own name, whatever the case");
  assert.deepEqual(rowsOf(s.dir, "decisions").filter((d) => d.decision !== "task added").filter((d) => d.task === "T3").map((d) => [d.decision, d.why]), [["release none → Beta", "task set"]]);
  const before = snapshot(s.dir);
  assert.match(s.no("task", "T2", "set", "release=1.0"), /^sage: T2 is in M1, and a task of a milestone is in its milestone's release\. Set the release of M1 \(sage milestone M1 set release=<name>\), or take T2 out of M1 first \(sage task T2 set milestone=none\)\. Nothing changed\.$/);
  assert.match(s.no("task", "T3", "set", "release=1.0,Beta"), /^sage: T3 is in at most one release/);
  assert.match(s.no("task", "T3", "set", "release=2.0"), /^sage: no release 2\.0\./);
  assert.deepEqual(snapshot(s.dir), before);
  s.ok("gate", "answer", "G1", "--option", "1");
  s.ok("milestone", "M1", "set", "release=1.0");
  assert.match(s.ok("task", "T3", "set", "milestone=M1"), / · leaves the release Beta: a task of M1 is in the release of M1/);
  assert.equal(rowsOf(s.dir, "tasks").find((t) => t.id === "T3").release, "");
  assert.deepEqual(rowsOf(s.dir, "decisions").filter((d) => d.decision !== "task added").filter((d) => d.task === "T3").map((d) => d.decision).slice(-2), ["milestone none → M1", "release Beta → none"]);
  s.ok("task", "T4", "set", "release=Beta");
  s.ok("milestone", "propose", "--name", "Next steps", "--goal", "A sample goal", "--pilot", "T4", "--tasks", "none");
  assert.equal(rowsOf(s.dir, "tasks").find((t) => t.id === "T4").release, "");
  assert.ok(rowsOf(s.dir, "decisions").filter((d) => d.decision !== "task added").some((d) => d.task === "T4" && d.decision === "release Beta → none" && /T4 joins M2/.test(d.why)));
  assert.deepEqual(s.levels().filter((l) => l.startsWith("release")), ["release 1.0 · not started · 0 of 3 tasks done · milestones M1", "release Beta · not started · 0 of 0 tasks done"]);
});

test("T1003: status shows each release in row order, with its state, the count of its tasks, its milestones and single tasks, and its goal last", () => {
  const s = logbook(5);
  s.ok("release", "add", "--name", "1.0", "--goal", "Ship the first version");
  s.ok("release", "add", "--name", "Beta");
  s.ok("release", "add", "--name", "Alpha");
  s.ok("milestone", "propose", "--name", "Sage feel", "--goal", "A sample goal", "--pilot", "T1", "--tasks", "T2");
  s.ok("milestone", "M1", "set", "release=1.0");
  for (const id of ["T3", "T4"]) s.ok("task", id, "set", "release=1.0");
  s.ok("task", "T5", "set", "release=Beta");
  const releaseLines = () => s.levels().filter((l) => l.startsWith("release"));
  assert.deepEqual(s.levels(), [
    "release 1.0 · in progress · 0 of 4 tasks done · milestones M1 · single tasks T3, T4 · goal: Ship the first version",
    "release Beta · not started · 0 of 1 task done · single tasks T5",
    "release Alpha · not started · 0 of 0 tasks done",
    "milestone M1 · release 1.0 · needs you · pilot T1: 0 of 2 merged · breakdown waits for you (G1) · name: Sage feel",
  ]);
  setStates(s.dir, { T3: "merged", T4: "abandoned", T5: "abandoned" });
  assert.deepEqual(releaseLines().slice(0, 2), ["release 1.0 · in progress · 1 of 4 tasks done · 1 stopped · milestones M1 · single tasks T3, T4 · goal: Ship the first version",
    "release Beta · stopped · 0 of 1 task done · 1 stopped · single tasks T5"]);
  s.ok("gate", "answer", "G1", "--option", "1");
  setStates(s.dir, { T1: "merged", T2: "concluded" });
  assert.equal(releaseLines()[0], "release 1.0 · done · 3 of 4 tasks done · 1 stopped · milestones M1 · single tasks T3, T4 · goal: Ship the first version");
  writeFileSync(join(s.dir, "releases.tsv"), readFileSync(join(s.dir, "releases.tsv"), "utf8").split("\n").filter((l) => !l.startsWith("Beta\t")).join("\n"));
  assert.equal(releaseLines().at(-1), "release Beta · not in the logbook: add it with release add, or set the release of each milestone and single task again · 0 of 1 task done · 1 stopped · single tasks T5");
});

test("T1003: the state rule of a release (the state words of T1002): empty or nothing started is not started, all stopped is stopped, done needs a done item, a dropped milestone is stopped", () => {
  const graph = (tasks, milestones = []) => {
    const byMilestone = new Map();
    for (const t of tasks) if (t.milestone) byMilestone.set(t.milestone, [...(byMilestone.get(t.milestone) ?? []), t]);
    return { byId: new Map(tasks.map((t) => [t.id, t])), milestones: new Map(milestones.map((m) => [m.id, m])), byMilestone };
  };
  const wordOf = (t) => taskWord({ state: t.state }).word;
  const stateOf = (tasks, milestones) => releasesOf([{ name: "1.0", goal: "", at: "" }], graph(tasks, milestones), wordOf)[0].state;
  const single = (state, id = "T1") => ({ id, state, release: "1.0" });
  assert.equal(stateOf([]), "not started", "an empty release");
  assert.equal(stateOf([single("framed"), single("framed", "T2")]), "not started", "nothing started");
  assert.equal(stateOf([single("framed"), single("abandoned", "T2")]), "in progress", "a stopped item is not a not-started one");
  assert.equal(stateOf([single("abandoned"), single("abandoned", "T2")]), "stopped");
  assert.equal(stateOf([single("merged"), single("abandoned", "T2")]), "done");
  assert.equal(stateOf([single("concluded")]), "done");
  assert.equal(stateOf([single("merged"), single("framed", "T2")]), "in progress");
  assert.equal(stateOf([single("briefed")]), "in progress");
  const m = (state) => ({ id: "M1", state, release: "1.0", pilot: "T1" });
  const members = [{ id: "T1", state: "framed", milestone: "M1" }, { id: "T2", state: "building", milestone: "M1" }];
  assert.equal(stateOf(members, [m("dropped")]), "stopped", "a dropped milestone is stopped, also with open tasks");
  assert.equal(stateOf(members, [m("active")]), "in progress");
  assert.equal(stateOf([{ ...members[0] }], [m("proposed")]), "in progress", "a milestone whose breakdown waits for the owner needs you, so it has started");
  assert.equal(stateOf([{ ...members[0], release: "2.0" }], [m("active")]), "not started", "a task of a milestone counts in its milestone's release, never in its own cell's");
  assert.equal(stateOf([members[1]], [m("active")]), "in progress", "a milestone whose pilot the logbook lost is stuck: it needs the owner, so it has started");
  assert.equal(stateOf([{ ...members[1], state: "framed" }], [m("active")]), "in progress", "also when nothing else in it has started");
  assert.deepEqual(releasesOf([{ name: "1.0" }], graph([{ id: "T1", state: "merged", release: "１.０" }]), wordOf)[0].singles.map((t) => t.id), ["T1"], "a cell names a release without case or width");
});

test("T1003: a missing releases table reads as empty while no cell names a release; once one does, a write refuses and names the repair", () => {
  const s = logbook(1);
  s.ok("release", "add", "--name", "1.0");
  s.ok("task", "T1", "set", "release=1.0");
  rmSync(join(s.dir, "releases.tsv"));
  const before = snapshot(s.dir);
  assert.match(s.no("task", "add", "--title", "x", "--size", "tiny", "--priority", "P3"), /releases\.tsv is missing or is a link to nothing, but every table of a logbook has at least its header line, so its rows are lost\.[\s\S]*sage logbook repair --accept-loss releases/);
  assert.deepEqual(snapshot(s.dir), before);
  s.ok("logbook", "repair", "--accept-loss", "releases");
  assert.deepEqual(rowsOf(s.dir, "releases"), []);
  assert.match(s.levels()[0], /^release 1\.0 · not in the logbook/, "the cell keeps T1 in a count");
});

test("T1003: two rows of one release name (a hand edit) refuse every write, and name the file", () => {
  const s = logbook(0);
  s.ok("release", "add", "--name", "Beta");
  writeFileSync(join(s.dir, "releases.tsv"), `${readFileSync(join(s.dir, "releases.tsv"), "utf8")}beta\t\t2026-11-11T00:00:00Z\n`);
  assert.match(s.no("release", "add", "--name", "1.0"), /releases\.tsv has two rows for the release beta \(case and width do not count\), but a release's name is on one row\./);
});

test("T1003: the sage of T995 in an open session reads a logbook with releases, and refuses to write it once a milestone or a task has a release, with nothing lost", (t) => {
  const old = realpathSync(mkdtempSync(join(tmpdir(), "sage-older-")));
  t.after(() => rmSync(old, { recursive: true, force: true }));
  execFileSync("tar", ["-x", "-C", old], { input: execFileSync("git", ["-C", REPO, "archive", OLDER, "plugins/sage/core", "plugins/sage/skills/sage"], { maxBuffer: 64 * 1024 * 1024 }) });
  const s = logbook(2), olderTool = join(old, "plugins/sage/skills/sage/sage.mjs");
  const older = (...args) => s.run(olderTool, args);
  s.ok("release", "add", "--name", "1.0", "--goal", "Ship the first version");
  s.ok("milestone", "propose", "--name", "Sage feel", "--goal", "A sample goal", "--pilot", "T1", "--tasks", "none");
  const releases = readFileSync(join(s.dir, "releases.tsv"), "utf8");
  assert.match(older("status").stdout, /^milestone M1 · pilot T1/m);
  assert.match(older("task", "add", "--title", "Sample task 3", "--size", "tiny", "--priority", "P3").stdout, /^T3 framed · tiny/);
  assert.equal(readFileSync(join(s.dir, "releases.tsv"), "utf8"), releases);
  s.ok("milestone", "M1", "set", "release=1.0");
  let before = snapshot(s.dir);
  for (const args of [["task", "add", "--title", "x", "--size", "tiny", "--priority", "P3"], ["task", "T2", "set", "milestone=M1"], ["log", "T1", "a note", "--why", "w"]]) {
    const r = older(...args);
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.stderr, /milestones\.tsv has columns that this version of sage does not know \(release\): a newer sage wrote this logbook, and a write of this version would lose them\. Update the sage plugin/, args.join(" "));
  }
  assert.deepEqual(snapshot(s.dir), before, "nothing changed");
  assert.match(older("status").stdout, /^milestone M1 · pilot T1/m);
  s.ok("task", "T3", "set", "release=1.0");
  before = snapshot(s.dir);
  const r = older("task", "T3", "set", "title=x");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tasks\.tsv has columns that this version of sage does not know \(release\): a newer sage wrote this logbook/);
  assert.deepEqual(snapshot(s.dir), before, "nothing changed");
  const read = older("task", "T3");
  assert.equal(read.status, 0, read.stderr);
  assert.match(read.stdout, /^T3 framed /);
  assert.match(s.ok("status"), /^release 1\.0 · in progress · 0 of 2 tasks done · milestones M1 · single tasks T3 · goal: Ship the first version$/m);
  s.ok("task", "T3", "set", "release=none");
  s.ok("milestone", "M1", "set", "release=none");
  assert.ok(headOf(s.dir, "tasks").includes("release") && headOf(s.dir, "milestones").includes("release"));
  const still = older("task", "add", "--title", "x", "--size", "tiny", "--priority", "P3");
  assert.equal(still.status, 1);
  assert.match(still.stderr, /has columns that this version of sage does not know \(release\)/);
});

const releaseRows = (dir) => rowsOf(dir, "decisions").filter((d) => /^release /.test(d.decision)).map((d) => [d.task, d.decision, d.why]);
const releaseOf = (dir, id) => rowsOf(dir, "tasks").find((t) => t.id === id).release ?? "";
const kept = (id, m, release) => [id, `release none → ${release}`, `${id} left milestone ${m}, and keeps its release`];

test("T1007: a task that leaves a milestone with milestone=none keeps the milestone's release, with a decision row", () => {
  const s = logbook(3);
  s.ok("release", "add", "--name", "1.0");
  s.ok("milestone", "propose", "--name", "Sage feel", "--goal", "A sample goal", "--pilot", "T1", "--tasks", "T2,T3");
  s.ok("milestone", "M1", "set", "release=1.0");
  s.ok("gate", "answer", "G1", "--option", "1");
  assert.match(s.ok("task", "T2", "set", "milestone=none"), / · keeps the release 1\.0 of M1/);
  assert.equal(releaseOf(s.dir, "T2"), "1.0");
  assert.deepEqual(releaseRows(s.dir), [kept("T2", "M1", "1.0")]);
  assert.equal(s.levels()[0], "release 1.0 · not started · 0 of 3 tasks done · milestones M1 · single tasks T2");
  assert.equal(releaseOf(s.dir, "T3"), "");
});

test("T1007: a task that a new milestone propose leaves out of --tasks, or an old pilot, keeps the milestone's release, with a decision row", () => {
  const s = logbook(3);
  s.ok("release", "add", "--name", "1.0");
  s.ok("milestone", "propose", "--name", "Sage feel", "--goal", "A sample goal", "--pilot", "T1", "--tasks", "T2,T3");
  s.ok("milestone", "M1", "set", "release=1.0");
  s.ok("gate", "answer", "G1", "--option", "2");
  s.ok("milestone", "propose", "M1", "--tasks", "T2");
  assert.equal(releaseOf(s.dir, "T3"), "1.0");
  assert.deepEqual(releaseRows(s.dir), [kept("T3", "M1", "1.0")]);
  s.ok("gate", "answer", "G2", "--option", "1");
  s.ok("milestone", "propose", "M1", "--pilot", "T2", "--tasks", "none");
  assert.equal(releaseOf(s.dir, "T1"), "1.0");
  assert.deepEqual(releaseRows(s.dir), [kept("T3", "M1", "1.0"), kept("T1", "M1", "1.0")]);
  assert.equal(s.levels()[0], "release 1.0 · in progress · 0 of 3 tasks done · milestones M1 · single tasks T1, T3");
});

test("T1007: a task that leaves a milestone with no release gets no release and no release row, by milestone=none and by milestone propose", () => {
  const s = logbook(3);
  s.ok("release", "add", "--name", "1.0");
  s.ok("task", "T3", "set", "release=1.0");
  s.ok("task", "T3", "set", "release=none");
  s.ok("milestone", "propose", "--name", "Sage feel", "--goal", "A sample goal", "--pilot", "T1", "--tasks", "T2,T3");
  s.ok("gate", "answer", "G1", "--option", "1");
  assert.doesNotMatch(s.ok("task", "T2", "set", "milestone=none"), /keeps the release/);
  s.ok("milestone", "propose", "M1", "--tasks", "none");
  for (const id of ["T2", "T3"]) assert.equal(rowsOf(s.dir, "tasks").find((t) => t.id === id).milestone, "", id);
  for (const id of ["T2", "T3"]) assert.equal(releaseOf(s.dir, id), "", id);
  assert.deepEqual(releaseRows(s.dir).filter(([, , why]) => /left milestone/.test(why)), []);
});

test("T1007: an ended task (merged, concluded, abandoned) stays in its milestone's count, so its release does not change", () => {
  const s = logbook(5);
  s.ok("release", "add", "--name", "1.0");
  s.ok("milestone", "propose", "--name", "Sage feel", "--goal", "A sample goal", "--pilot", "T1", "--tasks", "T2,T3,T4,T5");
  s.ok("milestone", "M1", "set", "release=1.0");
  s.ok("gate", "answer", "G1", "--option", "1");
  setStates(s.dir, { T3: "merged", T4: "concluded", T5: "abandoned" });
  const before = snapshot(s.dir);
  for (const id of ["T3", "T4", "T5"]) assert.match(s.no("task", id, "set", "milestone=none"), /an ended task joins no milestone and leaves none/, id);
  assert.deepEqual(snapshot(s.dir), before, "each refusal changes nothing");
  s.ok("milestone", "propose", "M1", "--tasks", "T2");
  for (const id of ["T3", "T4", "T5"]) {
    assert.equal(rowsOf(s.dir, "tasks").find((t) => t.id === id).milestone, "M1", id);
    assert.equal(releaseOf(s.dir, id), "", id);
  }
  assert.deepEqual(releaseRows(s.dir), []);
});

test("T1007: the tasks of a dropped milestone, taken out one by one, each keep its release, with its row", () => {
  const s = logbook(3);
  s.ok("release", "add", "--name", "1.0");
  s.ok("milestone", "propose", "--name", "Sage feel", "--goal", "A sample goal", "--pilot", "T1", "--tasks", "T2,T3");
  s.ok("milestone", "M1", "set", "release=1.0");
  s.ok("gate", "answer", "G1", "--option", "3");
  for (const id of ["T2", "T1", "T3"]) assert.match(s.ok("task", id, "set", "milestone=none"), / · keeps the release 1\.0 of M1/, id);
  for (const id of ["T1", "T2", "T3"]) assert.equal(releaseOf(s.dir, id), "1.0", id);
  assert.deepEqual(releaseRows(s.dir), [kept("T2", "M1", "1.0"), kept("T1", "M1", "1.0"), kept("T3", "M1", "1.0")]);
  assert.equal(s.levels()[0], "release 1.0 · in progress · 0 of 3 tasks done · milestones M1 · single tasks T1, T2, T3");
});
