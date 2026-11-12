// T995: the rename of program to milestone, and the one-time migration of a logbook from before it. The fixture mirrors
// the shape of sage's own logbook on 2026-11-11 (SAMPLE DATA, every title made up): program PG1 "Sage feel" with the pilot
// T984 and 7 more tasks that wait for T978, which is concluded (so they wait for the pilot only), the floor row of
// milestones 1 to 4, the approved breakdown gate G140, and a plain answered gate G141. The tool runs as the chief runs it,
// in a new root for each test.
import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { TABLES } from "../packages/sage-core/logbook-fields.mjs";
import { RENAME_WHY } from "../packages/sage-core/milestone-rules.mjs";

const TOOL = fileURLToPath(new URL("../plugins/sage/skills/sage/sage.mjs", import.meta.url));
const SPY = fileURLToPath(new URL("kill-spy.mjs", import.meta.url));
const L = " ";
const AT = "2026-11-11T03:18:52Z";
const OLD_TASKS = TABLES.tasks.map((c) => (c === "milestone" ? "program" : c));
const QUESTION = [`Approve program PG1? No task builds before you approve.`, "Name: Sage feel", "Goal: Ship how sage works on each kind of task", "Pilot, runs first:",
  "  T984 [waits for T977]: Presentation skill", "Then, each after T984:", ...[985, 986, 987, 988, 989, 990, 991].map((n) => `  T${n} [waits for T978]: Playbook ${n}`)].join(L);
const FLOOR = { at: "2026-11-12T02:43:44Z", task: "M4", decision: "M4 is the last of milestones 1 to 4, which have no records in this logbook; the next milestone is M5.", why: "Id floor for the program to milestone migration" };
const MEMBERS = [985, 986, 987, 988, 989, 990, 991].map((n) => `T${n}`);
const LARGE = "design,pe,build,code-review,security-review,ux-review,qa", INVESTIGATE = "investigate,evidence-review";
const SHA = "b".repeat(40);

const text = (cols, rows) => [cols.join("\t"), ...rows.map((r) => cols.map((c) => r[c] ?? "").join("\t"))].join("\n") + "\n";
const rowsOf = (dir, table) => {
  const [head, ...lines] = readFileSync(join(dir, `${table}.tsv`), "utf8").split("\n").filter(Boolean);
  return lines.map((line) => Object.fromEntries(line.split("\t").map((v, i) => [head.split("\t")[i], v])));
};
const headOf = (dir, table) => readFileSync(join(dir, `${table}.tsv`), "utf8").split("\n")[0].split("\t");
/** Every file of the logbook folder and its text, so a test sees each change. */
const snapshot = (dir) => Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".tsv")).sort().map((f) => [f, readFileSync(join(dir, f), "utf8")]));

/**
 * A logbook from before the rename, in a new root. answer: G140's answer ("" for an open gate); floor: with the floor row;
 * stopped: the steps of the migration that a stop left done ("decisions", then "milestones"); pr: T985 has a pull request
 * whose checks passed, for the merge check.
 */
function oldLogbook({ answer = "approve", floor = true, stopped = [], pr = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "sage-rename-")), project = mkdtempSync(join(tmpdir(), "sage-rename-project-"));
  // Each command preloads the kill spy and asks SAGE_TEST_PIDS about a lock's holder, so none reads or signals a real process.
  const env = { ...process.env, HOME: home, SAGE_HOME: home, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${JSON.stringify(SPY)}`.trim(), SAGE_TEST_KILLS: join(home, "kills"), SAGE_TEST_PIDS: "{}" };
  const run = (...args) => spawnSync("node", [TOOL, ...args, "--project", project], { encoding: "utf8", env, timeout: 60_000 });
  const ok = (...args) => { const r = run(...args); assert.equal(r.status, 0, `sage ${args.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };
  const no = (...args) => { const r = run(...args); assert.equal(r.status, 1, `sage ${args.join(" ")} should be refused: ${r.stdout}`); return r.stderr.trim(); };
  const dir = ok("init").replace(/^\S+ /, "");
  ok("task", "add", "--title", "template", "--size", "small", "--priority", "P1");
  const route = rowsOf(dir, "tasks")[0].route;
  const task = (id, state, { waits = "", program = "", size = "small", path = route, ...rest } = {}) => ({ id, title: `Sample ${id}`, size, route: path, state, round: "0", priority: "P1", waits, program, ...rest });
  const tasks = [task("T977", "concluded", { size: "investigate", path: INVESTIGATE }), task("T978", "concluded", { size: "investigate", path: INVESTIGATE }),
    task("T984", "designing", { waits: "T977,T992,T995", program: "PG1", size: "large", path: LARGE }), ...MEMBERS.map((id) => task(id, "framed", { waits: "T978", program: "PG1", ...(pr && id === "T985" ? { pr: "600" } : {}) })),
    task("T992", "concluded", { size: "investigate", path: INVESTIGATE }), task("T993", "framed"), task("T995", "reviewing", { size: "large", path: LARGE, pr: "515" })];
  const gates = [{ id: "G140", task: "T984", question: QUESTION, options: "approve|change|drop", recommendation: "approve", default: "", answer, at: answer ? AT : "" },
    { id: "G141", task: "T995", question: "Do you approve the design?", options: "Yes|No", recommendation: "Yes", default: "", answer: "Yes", at: AT }];
  const decisions = [...MEMBERS.map((id) => ({ at: AT, task: id, decision: "program none → PG1", why: "program propose" })),
    { at: AT, task: "T984", decision: `PG1 proposed with gate G140, pilot T984, tasks ${MEMBERS.join(",")}, name: Sage feel`, why: "program propose" },
    ...(answer ? [{ at: AT, task: "T984", decision: `${QUESTION} → ${answer}`, why: "the user's answer" }] : []), ...(floor ? [FLOOR] : [])];
  const programs = [{ id: "PG1", name: "Sage feel", goal: "Ship how sage works on each kind of task", pilot: "T984", gate: "G140", at: AT }];
  writeFileSync(join(dir, "tasks.tsv"), text(OLD_TASKS, tasks));
  writeFileSync(join(dir, "gates.tsv"), text(TABLES.gates, gates));
  writeFileSync(join(dir, "decisions.tsv"), text(TABLES.decisions, [...decisions, ...(stopped.includes("decisions") ? [{ at: AT, task: "", decision: "M5 was PG1", why: RENAME_WHY }] : [])]));
  writeFileSync(join(dir, "programs.tsv"), text(TABLES.milestones, programs));
  if (stopped.includes("milestones")) writeFileSync(join(dir, "milestones.tsv"), text(TABLES.milestones, programs.map((p) => ({ ...p, id: "M5" }))));
  else rmSync(join(dir, "milestones.tsv"));
  if (pr) writeFileSync(join(dir, "ledger.tsv"), text(TABLES.ledger, [{ task: "T985", pr: "600", sha: SHA, kind: "checks-pass", cycle: "1", run: "", at: AT }]));
  return { dir, run, ok, no };
}

/** The status lines without the first, which names the logbook's folder. */
const statusOf = (s) => s.ok("status").split("\n").slice(1).join("\n");
const SAGE_FEEL = "milestone M5 · pilot T984: 0 of 8 merged · name: Sage feel";

test("T995: this logbook's shape reads as milestone M5 before any write; the first write migrates it, and status stays the same", () => {
  const s = oldLogbook(), before = snapshot(s.dir), status = statusOf(s);
  assert.ok(status.includes(SAGE_FEEL), status);
  for (const id of MEMBERS) assert.ok(status.includes(` · ${id} for T984 (designing, the pilot of M5)`), `${id} waits for the pilot T984 only: T978 is concluded`);
  assert.doesNotMatch(status, /breakdown waits for you|G140/, "G140 reads approved: no open gate and no breakdown wait");
  assert.doesNotMatch(status, /\bprograms?\b|\bPG\d/i, "no line says program or an old id");
  assert.deepEqual(snapshot(s.dir), before, "a read writes nothing");

  s.ok("log", "-", "a note", "--why", "the first write of this version");
  assert.equal(existsSync(join(s.dir, "programs.tsv")), false, "programs.tsv is gone");
  assert.deepEqual(rowsOf(s.dir, "milestones").map((m) => [m.id, m.name, m.pilot, m.gate]), [["M5", "Sage feel", "T984", "G140"]]);
  assert.deepEqual([headOf(s.dir, "tasks").includes("program"), headOf(s.dir, "tasks").includes("milestone")], [false, true]);
  assert.deepEqual(rowsOf(s.dir, "tasks").filter((t) => t.milestone).map((t) => t.id), ["T984", ...MEMBERS]);
  assert.ok(rowsOf(s.dir, "tasks").every((t) => !t.milestone || t.milestone === "M5"));
  assert.deepEqual(rowsOf(s.dir, "decisions").filter((d) => d.why === RENAME_WHY).map((d) => d.decision), ["M5 was PG1"], "one map row, after the floor");
  assert.equal(rowsOf(s.dir, "gates").find((g) => g.id === "G140").question, QUESTION, "an answered gate stays as it is");
  assert.equal(statusOf(s), status, "the same lines after the migration: G140 approved, the same waits");
  // The merge check's rule: a task of M5 takes no build work before its pilot is merged.
  assert.match(s.no("run", "add", "T985", "--role", "implementer"), /T984 \(designing, the pilot of M5\)/);
});

test("T995: the merge check, which only reads, sees the same waits before and after the migration (F-T995-3)", () => {
  const s = oldLogbook({ pr: true });
  const check = () => { const r = s.run("merge-check", "--sha", SHA); return `${r.status} ${r.stdout}${r.stderr}`.trim(); };
  const before = check();
  assert.match(before, /^1 [\s\S]*T985 waits for T984 \(designing, the pilot of M5\)/, before);
  assert.doesNotMatch(before, /T978|\bPG\d|\bprograms?\b/i, "T978 is concluded, and no line names an old id");
  assert.equal(existsSync(join(s.dir, "programs.tsv")), true, "the merge check does not migrate");
  s.ok("log", "-", "a note", "--why", "the first write of this version");
  assert.equal(check(), before);
});

test("T995: without the floor row, PG1 becomes M1", () => {
  const s = oldLogbook({ floor: false });
  assert.match(statusOf(s), /^milestone M1 · pilot T984: 0 of 8 merged · name: Sage feel$/m);
  s.ok("log", "-", "a note", "--why", "w");
  assert.deepEqual(rowsOf(s.dir, "milestones").map((m) => m.id), ["M1"]);
  assert.deepEqual(rowsOf(s.dir, "decisions").filter((d) => d.why === RENAME_WHY).map((d) => d.decision), ["M1 was PG1"]);
});

test("T995: a migration that stopped after the decisions or the milestones reads the same, and the next write finishes it with the same ids; a second run changes nothing", () => {
  const whole = oldLogbook();
  whole.ok("log", "-", "a note", "--why", "w");
  const done = statusOf(whole);
  for (const stopped of [["decisions"], ["decisions", "milestones"]]) {
    const s = oldLogbook({ stopped });
    assert.equal(statusOf(s), done, `${stopped.at(-1)}: a read before the next write gives the same lines`);
    s.ok("log", "-", "a note", "--why", "w");
    assert.equal(existsSync(join(s.dir, "programs.tsv")), false, stopped.at(-1));
    assert.deepEqual(rowsOf(s.dir, "milestones").map((m) => m.id), ["M5"], stopped.at(-1));
    assert.equal(rowsOf(s.dir, "decisions").filter((d) => d.decision === "M5 was PG1").length, 1, `${stopped.at(-1)}: the map row is not written twice`);
    assert.equal(statusOf(s), done, stopped.at(-1));
    const tables = snapshot(s.dir);
    s.ok("log", "-", "another note", "--why", "w");
    const after = snapshot(s.dir);
    for (const table of ["tasks.tsv", "milestones.tsv", "gates.tsv"]) assert.equal(after[table], tables[table], `${table}: a second run changes nothing`);
    assert.equal(after["decisions.tsv"], `${tables["decisions.tsv"]}${after["decisions.tsv"].slice(tables["decisions.tsv"].length)}`);
    assert.deepEqual(rowsOf(s.dir, "decisions").slice(-1).map((d) => d.decision), ["another note"], "the decisions grow by the note alone");
  }
});

test("T995: an open old breakdown gate gets the new first line at the migration, and still takes one answer", () => {
  const s = oldLogbook({ answer: "" });
  const status = statusOf(s);
  assert.match(status, /G140 Approve milestone M5\? No task builds before you approve\. \(breakdown, 8 tasks\)/, "the gates line before the write");
  assert.ok(status.includes("milestone M5 · pilot T984: 0 of 8 merged · breakdown waits for you (G140) · name: Sage feel"), status);
  s.ok("log", "-", "a note", "--why", "w");
  const question = rowsOf(s.dir, "gates").find((g) => g.id === "G140").question;
  assert.equal(question, QUESTION.replace("Approve program PG1?", "Approve milestone M5?"), "only the first words change");
  assert.match(s.ok("gate", "answer", "G140", "--option", "1"), /^G140 answered · approve/);
  assert.ok(statusOf(s).includes(SAGE_FEEL), "approved");
  assert.match(s.no("gate", "answer", "G140", "--option", "3"), /a breakdown gate answers once/);
});

test("T995: an answered old gate stays as it is, and a drop in it still counts through the id map", () => {
  const s = oldLogbook({ answer: "drop" });
  s.ok("log", "-", "a note", "--why", "w");
  assert.equal(rowsOf(s.dir, "gates").find((g) => g.id === "G140").question, QUESTION);
  assert.ok(statusOf(s).includes("milestone M5 · dropped: 8 tasks still in it, take each out with milestone=none · name: Sage feel"), statusOf(s));
  assert.match(s.no("milestone", "propose", "M5", "--pilot", "T993"), /the owner dropped M5/);
  assert.match(s.no("gate", "answer", "G140", "--option", "1"), /a breakdown gate answers once/);
});

test("T995: the old words program, --program and program= still work for one version, each with a note", () => {
  const s = oldLogbook();
  const note = (word) => new RegExp(`\\nnote: ${word}\\. The old words work for one more version\\.$`);
  assert.match(s.ok("task", "add", "--title", "joins", "--size", "small", "--priority", "P2", "--program", "M5"), note("--program is --milestone now"));
  assert.equal(rowsOf(s.dir, "tasks").at(-1).milestone, "M5");
  assert.match(s.ok("task", "T993", "set", "program=M5"), note("program= is milestone= now"));
  assert.equal(rowsOf(s.dir, "tasks").find((t) => t.id === "T993").milestone, "M5");
  assert.match(s.ok("task", "T993", "set", "milestone=none"), /^T993 /);
  assert.match(s.ok("program", "propose", "--name", "Next steps", "--goal", "g", "--pilot", "T993", "--tasks", "none"), /^M6 proposed [\s\S]*\nnote: program is milestone now\. The old words work for one more version\.$/, "the next id after M5");
});

test("F-T995-24: a word that a plain object has, such as constructor, is no old word: it is an unknown command, by its own name", () => {
  const s = oldLogbook();
  for (const word of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    const why = s.no(word);
    assert.match(why, new RegExp(`unknown command "${word}"\\. Commands: `), word);
    assert.doesNotMatch(why, /function|\[native code\]|note:/, word);
  }
});

// A task page lists the task's last decision rows as they are written: the old rows of PG1 stay as history there. The
// milestone page reads them through the id map, in its own short lines.
test("T995: the chat board and the browser board of an old logbook say milestone, before and after the migration", () => {
  const s = oldLogbook();
  for (const when of ["before", "after"]) {
    if (when === "after") s.ok("log", "-", "a note", "--why", "w");
    const chat = s.ok("board"), html = s.ok("board", "--view", "html");
    assert.match(chat, /Sage feel/, when);
    assert.match(html, />Milestones</, `${when}: the tab`);
    for (const line of ["M5 proposed: Sage feel, pilot T984, gate G140", "G140 answered: approve"]) assert.ok(html.includes(line), `${when}: the milestone page says ${line}`);
    for (const page of [chat, html.replace(/<ol class="log">[\s\S]*?<\/ol>/g, "")]) assert.doesNotMatch(page, /\bprograms?\b|\bPG\d/i, `${when}: no program word and no old id`);
  }
});

// F-T995-1: an old logbook that lost a table at the update gets the repair that its refusal names. The program column is
// the old name of the milestone column, never a column of a newer sage, and a lost table does not stop the others' reads.
test("F-T995-1: an old logbook with programs.tsv that lost decisions.tsv, or tasks.tsv, takes the repair that the refusal names, and the next write migrates it", () => {
  for (const table of ["decisions", "tasks"]) {
    const s = oldLogbook();
    rmSync(join(s.dir, `${table}.tsv`));
    // Without tasks.tsv the folder is no logbook to a command, as before the rename; the repair still runs.
    if (table === "decisions") assert.ok(s.no("log", "-", "a note", "--why", "w").includes("sage logbook repair --accept-loss decisions --project"));
    assert.match(s.ok("logbook", "repair", "--accept-loss", table), new RegExp(`^${table}\\.tsv started again without rows`), table);
    s.ok("log", "-", "a note", "--why", "the first write after the repair");
    assert.equal(existsSync(join(s.dir, "programs.tsv")), false, table);
    // The lost floor row went with decisions.tsv, so PG1 takes the first free id then.
    assert.deepEqual(rowsOf(s.dir, "milestones").map((m) => [m.id, m.name]), [[table === "decisions" ? "M1" : "M5", "Sage feel"]], table);
  }
});

test("F-T995-1: an old logbook with the program column and no programs.tsv that lost gates.tsv takes the repair that the refusal names", () => {
  const s = oldLogbook();
  // A logbook that never had a program: no programs.tsv and no program cell.
  writeFileSync(join(s.dir, "tasks.tsv"), text(OLD_TASKS, rowsOf(s.dir, "tasks").map((t) => ({ ...t, program: "" }))));
  writeFileSync(join(s.dir, "decisions.tsv"), text(TABLES.decisions, []));
  rmSync(join(s.dir, "programs.tsv"));
  rmSync(join(s.dir, "gates.tsv"));
  const refused = s.no("log", "-", "a note", "--why", "w");
  assert.ok(refused.includes("gates.tsv is missing") && refused.includes("sage logbook repair --accept-loss gates --project"), refused);
  assert.doesNotMatch(refused, /a newer sage/);
  assert.match(s.ok("logbook", "repair", "--accept-loss", "gates"), /^gates\.tsv started again without rows/);
  s.ok("log", "-", "a note", "--why", "the first write after the repair");
  assert.deepEqual([headOf(s.dir, "tasks").includes("program"), headOf(s.dir, "tasks").includes("milestone")], [false, true]);
});

// F-T995-2, F-T995-9: programs.tsv has every check of a table, before the first write, and it goes only when milestones.tsv
// holds its rows. A damaged one refuses with the restore line; a restored copy is then read.
test("F-T995-2, F-T995-9: a programs.tsv of 0 bytes, with a damaged header or with no header, refuses before the first write; a restored copy migrates", () => {
  const good = "id\tname\tgoal\tpilot\tgate\tat\nPG1\tSage feel\tShip how sage works on each kind of task\tT984\tG140\t2026-11-11T03:18:52Z\n";
  for (const [damage, words] of [["", "is empty (0 bytes)"], [good.replace("\tgate\t", "\tgaet\t"), "the header of"], [good.split("\n").slice(1).join("\n"), "the header of"]]) {
    const s = oldLogbook();
    writeFileSync(join(s.dir, "programs.tsv"), damage);
    const before = snapshot(s.dir);
    for (const refused of [s.no("log", "-", "a note", "--why", "w"), s.no("status")]) {
      assert.ok(refused.includes(join(s.dir, "programs.tsv")) && refused.includes(words), refused);
      assert.match(refused, words === "the header of" ? /column names id, name, goal, pilot, gate, at/ : /Ask the user to restore it from a copy\. If the user accepts the loss, run: sage logbook repair --accept-loss programs --project/);
    }
    assert.deepEqual(snapshot(s.dir), before, "nothing changed: programs.tsv stays, and no table is migrated");
    writeFileSync(join(s.dir, "programs.tsv"), good); // the owner restores it from a copy
    s.ok("log", "-", "a note", "--why", "the first write after the restore");
    assert.deepEqual(rowsOf(s.dir, "milestones").map((m) => [m.id, m.gate]), [["M5", "G140"]]);
    assert.ok(statusOf(s).includes(SAGE_FEEL));
  }
});

test("F-T995-2: when the owner accepts the loss of programs.tsv, the repair keeps the old file aside and the next write migrates", () => {
  const s = oldLogbook();
  writeFileSync(join(s.dir, "programs.tsv"), "");
  assert.match(s.ok("logbook", "repair", "--accept-loss", "programs"), /^programs\.tsv started again without rows; its old file is .*programs\.tsv\.lost-1\./);
  assert.equal(existsSync(join(s.dir, "programs.tsv.lost-1")), true);
  s.ok("log", "-", "a note", "--why", "the first write after the repair");
  assert.equal(existsSync(join(s.dir, "programs.tsv")), false);
  assert.deepEqual(rowsOf(s.dir, "milestones"), [], "the lost rows stay lost");
  assert.ok(statusOf(s).includes("T985 for the breakdown of M5 (the milestone is not in the logbook)"), statusOf(s));
});

// F-T995-6, F-T995-10: after a migration that stopped after milestones.tsv, an older sage still writes programs.tsv. Its new
// program and its changed rows count: programs.tsv holds the newest rows until the migration removes it.
test("F-T995-6: a program that an older sage proposed after a stopped migration becomes the next milestone, with its row", () => {
  const s = oldLogbook({ stopped: ["decisions", "milestones"] });
  const at = "2026-11-12T04:00:00Z", question = ["Approve program PG2? No task builds before you approve.", "Name: Next steps", "Goal: A sample goal", "Pilot, runs first:", "  T993: Sample T993"].join(L);
  writeFileSync(join(s.dir, "programs.tsv"), `${readFileSync(join(s.dir, "programs.tsv"), "utf8").replace("\tShip how sage works on each kind of task\t", "\tA goal that the older sage changed\t")}PG2\tNext steps\tA sample goal\tT993\tG150\t${at}\n`);
  writeFileSync(join(s.dir, "tasks.tsv"), text(OLD_TASKS, rowsOf(s.dir, "tasks").map((t) => (t.id === "T993" ? { ...t, program: "PG2" } : t))));
  writeFileSync(join(s.dir, "gates.tsv"), `${readFileSync(join(s.dir, "gates.tsv"), "utf8")}G150\tT993\t${question}\tapprove|change|drop\tapprove\t\t\t\n`);
  writeFileSync(join(s.dir, "decisions.tsv"), `${readFileSync(join(s.dir, "decisions.tsv"), "utf8")}${at}\tT993\tPG2 proposed with gate G150, pilot T993, tasks none, name: Next steps\tprogram propose\n`);
  const status = statusOf(s);
  assert.ok(status.includes("milestone M6 · pilot T993: 0 of 1 merged · breakdown waits for you (G150) · name: Next steps"), status);
  s.ok("log", "-", "a note", "--why", "w");
  assert.equal(existsSync(join(s.dir, "programs.tsv")), false);
  assert.deepEqual(rowsOf(s.dir, "milestones").map((m) => [m.id, m.goal, m.gate]), [["M5", "A goal that the older sage changed", "G140"], ["M6", "A sample goal", "G150"]]);
  assert.deepEqual(rowsOf(s.dir, "decisions").filter((d) => d.why === RENAME_WHY).map((d) => d.decision), ["M5 was PG1", "M6 was PG2"]);
  assert.equal(rowsOf(s.dir, "tasks").find((t) => t.id === "T993").milestone, "M6");
  assert.equal(rowsOf(s.dir, "gates").find((g) => g.id === "G150").question.split(L)[0], "Approve milestone M6? No task builds before you approve.");
  assert.equal(statusOf(s), status);
});

// F-T995-11: an answered gate from before the rename is a breakdown gate by its own first line, also without the id map
// (decisions.tsv started again, or a move to a shared logbook, which does not copy the map rows).
test("F-T995-11: an answered old breakdown gate answers once, also when the logbook lost its id map", () => {
  const s = oldLogbook();
  s.ok("log", "-", "a note", "--why", "the first write of this version");
  writeFileSync(join(s.dir, "decisions.tsv"), text(TABLES.decisions, rowsOf(s.dir, "decisions").filter((d) => d.why !== RENAME_WHY)));
  assert.match(s.no("gate", "answer", "G140", "--option", "3"), /G140 is a breakdown gate, and the owner answered it already \(approve\): a breakdown gate answers once/);
  assert.equal(rowsOf(s.dir, "gates").find((g) => g.id === "G140").answer, "approve");
});

// F-T995-16: an old program id names its milestone through the id map, in the old words and the new ones.
test("F-T995-16: after the migration, program=PG1, --program PG1 and milestone propose PG1 work on M5, and the line names M5", () => {
  const s = oldLogbook({ answer: "change" });
  s.ok("log", "-", "a note", "--why", "the first write of this version");
  assert.match(s.ok("task", "T993", "set", "program=PG1"), /^T993 framed · [^\n]* · milestone M5\b[\s\S]*\nnote: program= is milestone= now\./);
  assert.match(s.ok("task", "add", "--title", "joins", "--size", "small", "--priority", "P2", "--program", "PG1"), /^T996 framed · [^\n]* · milestone M5\b[\s\S]*\nnote: --program is --milestone now\./);
  assert.deepEqual(rowsOf(s.dir, "tasks").filter((t) => ["T993", "T996"].includes(t.id)).map((t) => t.milestone), ["M5", "M5"]);
  assert.match(s.ok("milestone", "propose", "PG1"), /^M5 /);
  assert.equal(rowsOf(s.dir, "gates").at(-1).question.split(L)[0], "Approve milestone M5 (round 2)? No task builds before you approve.");
});
