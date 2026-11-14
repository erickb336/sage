import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { keepReport } from "../plugins/sage/skills/sage/sage.mjs";
import { reportFor } from "./verdict-backing.mjs";
import { REPORT_FIELDS } from "../packages/sage-core/report.mjs";
import { readReport } from "../packages/sage-core/report-reader.mjs";

const TOOL = fileURLToPath(new URL("../plugins/sage/skills/sage/sage.mjs", import.meta.url));
const PLUGIN = fileURLToPath(new URL("../plugins/sage", import.meta.url));
const SPY = fileURLToPath(new URL("kill-spy.mjs", import.meta.url));
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const OTHER = "0123456789abcdef0123456789abcdef01234567";
const FINDINGS = reportFor("findings");
const temps = [];
const temp = (prefix) => (temps.push(realpathSync(mkdtempSync(join(tmpdir(), prefix)))), temps.at(-1));
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function logbook() {
  const home = temp("sage-home-"), project = temp("sage-project-");
  const env = { ...process.env, SAGE_HOME: home, SAGE_TEST_PIDS: "{}", SAGE_TEST_KILLS: join(home, "kills"), NODE_OPTIONS: `--import=${JSON.stringify(SPY)}` };
  const cli = (args, { cwd = project, tool = TOOL } = {}) => spawnSync("node", [tool, ...args], { cwd, env, encoding: "utf8", timeout: 60_000 });
  const ok = (...args) => {
    const r = cli([...args, "--project", project]);
    assert.equal(r.status, 0, `sage ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  const no = (...args) => {
    const r = cli([...args, "--project", project]);
    assert.equal(r.status, 1, `sage ${args.join(" ")} should be refused, printed: ${r.stdout}`);
    return r.stderr.trim();
  };
  const dir = ok("init").replace(/^\S+ /, "");
  const reviewed = (task, role, text, sha = SHA) => {
    const run = ok("run", "add", task, "--role", role).split(" ")[0];
    if (text !== undefined) keepReport(project, { task, run, role, sha, text }, env);
    ok("run", "done", run, "--status", "done", "--tokens", "1");
    return run;
  };
  const ledger = () => readFileSync(join(dir, "ledger.tsv"), "utf8");
  const runs = () => readFileSync(join(dir, "runs.tsv"), "utf8");
  return { home, project, env, cli, ok, no, dir, reviewed, ledger, runs };
}

test("T483: a FINDINGS report never backs review-clean, in every form in which the state tool can be run", () => {
  const s = logbook();
  s.ok("task", "add", "--priority", "P2", "--title", "a", "--size", "small");
  const run = s.reviewed("T1", "code-reviewer", FINDINGS);
  const copy = join(temp("sage-copy-"), "plugin");
  cpSync(PLUGIN, copy, { recursive: true });
  renameSync(join(copy, "skills"), join(copy, "SKILLS"));
  renameSync(join(copy, "SKILLS/sage"), join(copy, "SKILLS/SAGE"));
  const words = ["verdict", "T1", "--kind", "review-clean", "--sha", SHA, "--cycle", "1", "--run", run];
  const forms = {
    "a plain command, also a glob or a variable after the shell": [[...words, "--project", s.project]],
    "--project=": [[...words, `--project=${s.project}`], { cwd: tmpdir() }],
    "--project .": [[...words, "--project", "."]],
    "a relative --project": [[...words, "--project", basename(s.project)], { cwd: dirname(s.project) }],
    "an upper-case path": [[...words, "--project", s.project], { tool: join(copy, "SKILLS/SAGE/sage.mjs") }],
  };
  const before = s.ledger();
  for (const [form, [args, at]] of Object.entries(forms)) {
    const r = s.cli(args, at);
    assert.equal(r.status, 1, `${form}: the state tool must refuse, printed: ${r.stdout}`);
    assert.match(r.stderr, new RegExp(`^sage: ${run}'s report has 1 medium or high finding \\(RESULT FINDINGS with medium findings\\), and T1 holds none of ${run}, but each one needs a row at its severity or above: so it backs findings\\. For review-clean, record each one first \\(sage finding add T1 --source code-reviewer --run ${run} --key ${run}-<its key> `), form);
    assert.equal(s.ledger(), before, `${form}: nothing is recorded`);
  }
});

test("T483: a FINDINGS report backs a clean verdict after triage of each of its findings: dismissed, moved or closed", () => {
  const s = logbook();
  s.ok("task", "add", "--priority", "P2", "--title", "a", "--size", "small");
  const r1 = s.reviewed("T1", "code-reviewer", FINDINGS);
  s.ok("finding", "add", "T1", "--source", "code-reviewer", "--severity", "medium", "--summary", "a wrong claim", "--run", r1, "--class", "other");
  assert.match(s.no("verdict", "T1", "--kind", "review-clean", "--sha", SHA, "--run", r1), new RegExp(`^sage: ${r1}'s report has findings \\(RESULT FINDINGS with medium findings\\), and F-T1-1 \\(medium\\) is still open: so it backs findings, or review-clean after each one is dismissed with a reason, moved or closed\\. Nothing changed\\.$`));
  s.ok("finding", "triage", "T1", "F-T1-1", "dismiss", "--reason", "the code does check it");
  assert.match(s.ok("verdict", "T1", "--kind", "review-clean", "--sha", SHA, "--run", r1), /^T1 review-clean · a1b2c3d · cycle 1$/);
  const r2 = s.reviewed("T1", "qa", reportFor("qa-fail"));
  s.ok("finding", "add", "T1", "--source", "qa", "--severity", "medium", "--summary", "a slow page", "--run", r2, "--class", "speed");
  s.ok("finding", "move", "T1", "F-T1-2", "--to", "Make the page fast");
  assert.match(s.ok("verdict", "T1", "--kind", "qa-pass", "--sha", SHA, "--run", r2), /^T1 qa-pass · a1b2c3d · cycle 1$/);
  s.ok("task", "add", "--priority", "P2", "--title", "b", "--size", "small");
  const r4 = s.reviewed("T1", "qa", reportFor("qa-fail"));
  s.ok("finding", "add", "T1", "--source", "qa", "--severity", "medium", "--summary", "a lost filter", "--run", r4, "--class", "other");
  s.ok("finding", "move", "T1", "F-T1-3", "--into", "T2");
  assert.match(s.ok("verdict", "T1", "--kind", "qa-pass", "--sha", SHA, "--cycle", "3", "--run", r4), /^T1 qa-pass · a1b2c3d · cycle 3$/, "a finding moved into an open task backs the clean verdict too");
  const r3 = s.reviewed("T1", "code-reviewer", FINDINGS);
  s.ok("finding", "add", "T1", "--source", "sage", "--severity", "high", "--summary", "a lost row", "--key", `${r3}-1`);
  s.ok("finding", "triage", "T1", `${r3}-1`, "dismiss", "--reason", "the row is kept");
  assert.match(s.ok("verdict", "T1", "--kind", "review-clean", "--sha", SHA, "--cycle", "2", "--run", r3), /^T1 review-clean · a1b2c3d · cycle 2$/);
});

test("T483: each review or QA verdict that no kept report backs is refused, with what to do", () => {
  const s = logbook();
  s.ok("task", "add", "--priority", "P2", "--title", "a", "--size", "small");
  s.ok("task", "add", "--priority", "P2", "--title", "b", "--size", "small");
  const verdict = (kind, run, sha = SHA) => s.no("verdict", "T1", "--kind", kind, "--sha", sha, ...(run ? ["--run", run] : []));
  const before = s.ledger(), runs = s.runs();
  assert.equal(verdict("review-clean"), "sage: review-clean is a review or QA verdict, so it names the run whose kept report backs it: add --run with the code-reviewer run of T1 whose helper ended with its report. Nothing changed.");
  assert.equal(s.runs(), runs, "a refused verdict without --run adds no run (R1907-1)");
  assert.equal(s.ledger(), before);
  const qa = s.reviewed("T1", "qa", reportFor("qa-pass"));
  assert.equal(verdict("review-clean", qa), `sage: ${qa} is a qa run, so it backs no review-clean verdict: only a code-reviewer run does. Nothing changed.`);
  const lead = s.reviewed("T1", "lead");
  assert.equal(verdict("review-clean", lead), `sage: ${lead} is a lead run, so it backs no review-clean verdict: only a code-reviewer run does. Nothing changed.`);
  const running = s.ok("run", "add", "T1", "--role", "code-reviewer").split(" ")[0];
  assert.equal(verdict("review-clean", running), `sage: ${running} still runs: end it after its helper's report (sage run done ${running} --status done --tokens <n>), then record its verdict. Nothing changed.`);
  const other = s.reviewed("T2", "code-reviewer", reportFor("review-clean"));
  assert.equal(verdict("review-clean", other), `sage: ${other} is a run of T2, not of T1: name the code-reviewer run of T1 whose report backs this verdict. Nothing changed.`);
  const bare = s.reviewed("T1", "code-reviewer");
  assert.equal(verdict("review-clean", bare), `sage: ${bare} has no kept report: sage keeps a helper's report at its stop only when it knows the helper's run, by the first line of its brief, "Run ${bare} · task T1", or by its task name with the run (sage_<role>_t<n>_r<n>). Run the review again under a new run (sage run add T1 --role code-reviewer), whose helper's brief starts with "Run <R> · task T1" (or whose task name carries the run), and record its verdict with --run after it ends. Nothing changed.`);
  const short = s.reviewed("T1", "code-reviewer", reportFor("review-clean").replace("BRANCH none", "BRANCH sage/t1-a at a1b2c3d"), "");
  assert.match(verdict("review-clean", short), new RegExp(`^sage: ${short}'s report names no full 40-character head SHA in BRANCH, and the hook saw none, so it backs no verdict`));
  const both = (line) => s.reviewed("T1", "code-reviewer", reportFor("review-clean").replace("BRANCH none", `BRANCH ${line}`), "");
  const baseHead = both(`sage/t1-a, base ${OTHER}, head ${SHA}, PR 7`), seenOne = s.reviewed("T1", "code-reviewer", reportFor("review-clean").replace("BRANCH none", `BRANCH ${OTHER} ${SHA}`));
  assert.match(verdict("review-clean", both(`sage/t1-a, base ${SHA}, head ${OTHER}`)), /report is on 0123456, not on a1b2c3d/);
  assert.match(verdict("review-clean", both(`sage/t1-a ${OTHER} ${SHA}`)), /names 2 commits in BRANCH and none as its head/);
  const failed = s.ok("run", "add", "T1", "--role", "code-reviewer").split(" ")[0];
  s.ok("run", "done", failed, "--status", "failed");
  assert.match(verdict("review-clean", failed), new RegExp(`^sage: ${failed} ended as failed, so it backs no verdict\\. Run the review again under a new run`));
  const seen = s.reviewed("T1", "code-reviewer", reportFor("review-clean"), OTHER);
  assert.equal(verdict("review-clean", seen), `sage: ${seen}'s report is on 0123456, not on a1b2c3d: a verdict names the commit that its helper reviewed. Record it on ${OTHER}, or review a1b2c3d under a new run. Nothing changed.`);
  const named = s.reviewed("T1", "code-reviewer", reportFor("review-clean").replace("BRANCH none", `BRANCH sage/t1-a at ${OTHER.toUpperCase()}`), "");
  assert.match(verdict("review-clean", named), new RegExp(`^sage: ${named}'s report is on 0123456, not on a1b2c3d`));
  const split = s.reviewed("T1", "code-reviewer", reportFor("review-clean").replace("BRANCH none", `BRANCH sage/t1-a head ${OTHER}`), SHA);
  assert.match(verdict("review-clean", split), new RegExp(`^sage: ${split}'s report names 0123456 as its head, and the hook saw it review a1b2c3d: the report and the hook disagree, so it backs no verdict\\. Run the review again under a new run`));
  s.ok("finding", "add", "T1", "--source", "sage", "--severity", "medium", "--summary", "an open problem");
  assert.match(verdict("findings", qa), /only a code-reviewer, security-reviewer or ux-reviewer run does/);
  const clean =s.reviewed("T1", "code-reviewer", reportFor("review-clean"));
  assert.equal(verdict("findings", clean), `sage: ${clean}'s report is clean (RESULT CLEAN), so it backs only review-clean. Nothing changed.`);
  const odd = s.reviewed("T1", "code-reviewer", "STATUS done\nRESULT LGTM\nEVIDENCE x\nFINDINGS none\nQUESTIONS none\nNOT VERIFIED none\nBRANCH none");
  assert.match(verdict("review-clean", odd), new RegExp(`^sage: ${odd}'s kept report cannot be read \\(RESULT starts with "LGTM"`));
  assert.equal(s.ledger(), before, "no refused verdict is recorded");
  assert.match(s.ok("verdict", "T1", "--kind", "review-clean", "--sha", SHA, "--run", clean), /^T1 review-clean · a1b2c3d · cycle 1/);
  assert.match(s.no("verdict", "T1", "--kind", "review-clean", "--sha", SHA, "--cycle", "2", "--run", clean), new RegExp(`^sage: ${clean} already backs the review-clean verdict of T1 on a1b2c3d: one run backs one review or QA verdict\\. Run the review again under a new run\\.$`));
  s.ok("verdict", "T1", "--kind", "checks-pass", "--sha", SHA);
  const match = s.reviewed("T1", "qa", reportFor("qa-pass").replace("BRANCH none", `BRANCH sage/t1-a ${SHA}`));
  assert.match(s.ok("verdict", "T1", "--kind", "qa-pass", "--sha", SHA, "--run", match), /^T1 qa-pass · a1b2c3d · cycle 1$/);
  assert.match(s.ok("verdict", "T1", "--kind", "review-clean", "--sha", SHA, "--cycle", "3", "--run", baseHead), /^T1 review-clean · a1b2c3d · cycle 3/, "the SHA after head");
  assert.match(s.ok("verdict", "T1", "--kind", "review-clean", "--sha", SHA, "--cycle", "4", "--run", seenOne), /^T1 review-clean · a1b2c3d · cycle 4/, "the one of two that the hook saw");
});

test("T483 R1909-1: a CLEAN report that lists a medium finding backs findings, not review-clean (severity wins)", () => {
  const s = logbook();
  s.ok("task", "add", "--priority", "P2", "--title", "a", "--size", "small");
  const run = s.reviewed("T1", "code-reviewer", reportFor("review-clean", { findings: "\n- K1 medium src/a.js:1 an empty name saves a row" }));
  assert.match(s.no("verdict", "T1", "--kind", "review-clean", "--sha", SHA, "--run", run), new RegExp(`^sage: ${run}'s report has 1 medium or high finding \\(RESULT CLEAN with medium findings\\)`));
  s.ok("finding", "add", "T1", "--source", "code-reviewer", "--severity", "medium", "--summary", "an empty name saves a row", "--run", run, "--class", "state-edge");
  assert.match(s.ok("verdict", "T1", "--kind", "findings", "--sha", SHA, "--run", run), /^T1 findings · a1b2c3d · cycle 1/);
});

test("T483 full report: complete plain, Markdown and multiline fields still back clean verdicts", () => {
  const s = logbook();
  s.ok("task", "add", "--priority", "P2", "--title", "a", "--size", "small");
  const lines = reportFor("review-clean").split("\n");
  const forms = [lines, lines.map(line => `| ${line} |`), lines.map(line => {
    const field = REPORT_FIELDS.find(name => line.startsWith(`${name} `));
    return `**${field}**: ${line.slice(field.length).trim()}`;
  }), lines.map(line => {
    const field = REPORT_FIELDS.find(name => line.startsWith(`${name} `));
    return `## ${field}\n${line.slice(field.length).trim()}`;
  })];
  for (const [index, form] of forms.entries()) {
    const run = s.reviewed("T1", "code-reviewer", form.join("\n"));
    assert.equal(s.ok("verdict", "T1", "--kind", "review-clean", "--sha", SHA, "--run", run, "--cycle", String(index + 1)), `T1 review-clean · a1b2c3d · cycle ${index + 1}`);
  }
});

for (const field of REPORT_FIELDS) for (const empty of [false, true]) {
  test(`T483 full report: ${empty ? "empty" : "missing"} ${field} backs no verdict`, () => {
    const s = logbook();
    s.ok("task", "add", "--priority", "P2", "--title", "a", "--size", "small");
    const text = reportFor("review-clean").split("\n").flatMap(line => line.startsWith(`${field} `) ? (empty ? [field] : []) : [line]).join("\n");
    const run = s.reviewed("T1", "code-reviewer", text);
    s.ok("finding", "add", "T1", "--source", "code-reviewer", "--severity", "medium", "--summary", "a recorded problem", "--run", run, "--class", "other");
    const before = s.ledger();
    for (const kind of ["review-clean", "findings"]) {
      assert.match(s.no("verdict", "T1", "--kind", kind, "--sha", SHA, "--run", run), /kept report cannot be read/);
      assert.equal(s.ledger(), before, "an incomplete report adds no ledger row");
    }
  });
}

test("T483: a kept report stays as it was first kept, and only a run of its task and role keeps one", () => {
  const s = logbook();
  s.ok("task", "add", "--priority", "P2", "--title", "a", "--size", "small");
  const run = s.ok("run", "add", "T1", "--role", "code-reviewer").split(" ")[0];
  assert.throws(() => keepReport(s.project, { task: "T1", run, role: "qa", sha: "", text: FINDINGS }, s.env), /is not a qa run of T1, so no report is kept/);
  assert.throws(() => keepReport(s.project, { task: "T1", run, role: "code-reviewer", sha: "abc", text: FINDINGS }, s.env), /the full SHA of its commit or none/);
  const file = keepReport(s.project, { task: "T1", run, role: "code-reviewer", sha: SHA, text: FINDINGS }, s.env);
  assert.equal(keepReport(s.project, { task: "T1", run, role: "code-reviewer", sha: SHA, text: FINDINGS }, s.env), file, "the same report again is the same");
  assert.throws(() => keepReport(s.project, { task: "T1", run, role: "code-reviewer", sha: SHA, text: reportFor("review-clean") }, s.env), new RegExp(`^Error: ${run} already has a kept report, and a report is kept once`), "another report is refused, so its hook can say so (R1908-3)");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).text, FINDINGS, "a later stop never replaces the first report");
  s.ok("run", "done", run, "--status", "done", "--tokens", "1");
  const late = s.ok("run", "add", "T1", "--role", "qa").split(" ")[0];
  s.ok("run", "done", late, "--status", "done", "--tokens", "1");
  assert.throws(() => keepReport(s.project, { task: "T1", run: late, role: "qa", sha: SHA, text: reportFor("qa-pass") }, s.env), new RegExp(`${late} ended as done before this stop, so no report is kept`));
  assert.match(s.no("verdict", "T1", "--kind", "review-clean", "--sha", SHA, "--run", run), /report has 1 medium or high finding/);
});

const proven = (...lines) => reportFor("findings", { findings: lines.map((line) => `\n- ${line}\n  proof: npm test\n  saw: not ok 1`).join("") });
const proofCheck = (lines, sha = SHA) => ["STATUS done", "RESULT PASS", "EVIDENCE", ...lines, "FINDINGS none", "QUESTIONS none", "NOT VERIFIED none", `BRANCH b · head ${sha}`].join("\n");
const found = (s, run, severity, summary) => s.ok("finding", "add", "T1", "--source", "code-reviewer", "--severity", severity, "--summary", summary, "--run", run, "--class", "other").split(" ")[0];

test("T947: a triage with --proof needs a done proof check of the task, on the head of the finding's report, that lists the finding with an outcome that fits", () => {
  const s = logbook();
  s.ok("task", "add", "--priority", "P2", "--title", "a", "--size", "small");
  s.ok("task", "add", "--priority", "P2", "--title", "b", "--size", "small");
  const review = s.reviewed("T1", "code-reviewer", proven("K1 medium a", "K2 medium b", "K3 high c", "K4 medium d"));
  const [gone, real, high, skipped] = [found(s, review, "medium", "a"), found(s, review, "medium", "b"), found(s, review, "high", "c"), found(s, review, "medium", "d")];
  const lines = [`- ${gone} not reproduced`, "  npm test", "  ok 1", `- ${real} reproduced`, `- ${high} could not run`];
  const other = s.reviewed("T2", "qa", proofCheck(lines));
  const running = s.ok("run", "add", "T1", "--role", "qa").split(" ")[0];
  keepReport(s.project, { task: "T1", run: running, role: "qa", sha: SHA, text: proofCheck(lines) }, s.env);
  const moved = s.reviewed("T1", "qa", proofCheck(lines, OTHER), OTHER);
  const check = s.reviewed("T1", "qa", proofCheck(lines));
  const before = readFileSync(join(s.dir, "findings.tsv"), "utf8");
  assert.match(s.no("finding", "triage", "T1", gone, "dismiss", "--proof", other), new RegExp(`^sage: ${other} is a run of T2, not of T1\\. A proof check is the done qa run`));
  assert.match(s.no("finding", "triage", "T1", gone, "dismiss", "--proof", running), new RegExp(`^sage: ${running} still runs, and only a done proof check backs a triage`));
  assert.match(s.no("finding", "triage", "T1", gone, "dismiss", "--proof", review), new RegExp(`^sage: ${review} is a code-reviewer run, not a qa run`));
  assert.match(s.no("finding", "triage", "T1", gone, "dismiss", "--proof", moved), new RegExp(`^sage: ${moved} checked 0123456, and ${gone}'s report \\(${review}\\) is on a1b2c3d: a proof check reruns the proof on that head`));
  assert.match(s.no("finding", "triage", "T1", skipped, "fix", "--proof", check), new RegExp(`^sage: ${check}'s kept report does not list ${skipped}`));
  assert.match(s.no("finding", "triage", "T1", real, "dismiss", "--proof", check), new RegExp(`^sage: ${check} says ${real} reproduced, so it is not dismissed: triage it fix`));
  assert.match(s.no("finding", "triage", "T1", high, "dismiss", "--proof", check), new RegExp(`^sage: ${check} says ${high} could not run, so it is not dismissed`), "could not run keeps the finding");
  assert.match(s.no("finding", "triage", "T1", gone, "fix", "--proof", check), new RegExp(`^sage: ${check} says ${gone} not reproduced, so triage it dismiss`));
  assert.match(s.no("finding", "triage", "T1", gone, "ask", "--proof", check), /--proof goes with fix or dismiss, not with ask/);
  assert.equal(readFileSync(join(s.dir, "findings.tsv"), "utf8"), before, "a refused triage changes no finding");
  assert.equal(s.ok("finding", "triage", "T1", gone, "dismiss", "--proof", check), `${gone} dismissed · dismiss`);
  assert.equal(s.ok("finding", "triage", "T1", real, "fix", "--proof", check), `${real} open · fix`);
  assert.equal(s.ok("finding", "triage", "T1", high, "fix", "--proof", check), `${high} open · fix`);
  const rows = readFileSync(join(s.dir, "findings.tsv"), "utf8"), decisions = readFileSync(join(s.dir, "decisions.tsv"), "utf8");
  assert.match(rows, new RegExp(`\\t${gone}\\t.*\\tnot reproduced in ${check}(?:\\t|$)`, "m"), "the dismissal's reason names the proof check");
  assert.match(decisions, new RegExp(`\\t${gone} dismiss --proof ${check}\\t${check} not reproduced on ${SHA}`), "the decision trail keeps the proof check, its outcome and the head");
  assert.match(decisions, new RegExp(`\\t${high} fix --proof ${check}\\t${check} could not run on ${SHA}`));
});

test("T947: a proof check's report backs no verdict, and a run whose medium findings were all dropped by it backs review-clean", () => {
  const s = logbook();
  s.ok("task", "add", "--priority", "P2", "--title", "a", "--size", "small");
  const review = s.reviewed("T1", "code-reviewer", proven("K1 medium a", "K2 medium b"));
  const keys = [found(s, review, "medium", "a"), found(s, review, "medium", "b")];
  const check = s.reviewed("T1", "qa", proofCheck(keys.map((key) => `- ${key} not reproduced`)));
  const before = s.ledger();
  assert.match(s.no("verdict", "T1", "--kind", "qa-pass", "--sha", SHA, "--run", check), new RegExp(`^sage: ${check}'s report is a proof check \\(its EVIDENCE lists findings as reproduced or not\\), so it backs no verdict`));
  assert.match(s.no("verdict", "T1", "--kind", "review-clean", "--sha", SHA, "--run", review), /still open/, "while a medium finding of the run is open, the run backs no clean verdict");
  s.ok("finding", "triage", "T1", keys[0], "dismiss", "--proof", check);
  assert.match(s.no("verdict", "T1", "--kind", "review-clean", "--sha", SHA, "--run", review), new RegExp(`${keys[1]} \\(medium\\) is still open`));
  s.ok("finding", "triage", "T1", keys[1], "dismiss", "--proof", check);
  assert.equal(s.ledger(), before, "the refusals add no ledger row");
  assert.equal(s.ok("verdict", "T1", "--kind", "review-clean", "--sha", SHA, "--run", review), "T1 review-clean · a1b2c3d · cycle 1");
});

test("F-T947-1: a proof check that gives its first outcome on the EVIDENCE line, or a near form, is read: it backs its --proof triage and no verdict", () => {
  const s = logbook();
  s.ok("task", "add", "--priority", "P2", "--title", "a", "--size", "small");
  const review = s.reviewed("T1", "code-reviewer", proven("K1 medium a", "K2 medium b"));
  const [gone, real] = [found(s, review, "medium", "a"), found(s, review, "medium", "b")];
  const check = s.reviewed("T1", "qa", proofCheck([]).replace("EVIDENCE", `EVIDENCE      - ${gone} not reproduced\n1. **${real}**: reproduced (saw not ok 1)`));
  assert.match(s.no("verdict", "T1", "--kind", "qa-pass", "--sha", SHA, "--run", check), new RegExp(`^sage: ${check}'s report is a proof check`));
  assert.equal(s.ok("finding", "triage", "T1", gone, "dismiss", "--proof", check), `${gone} dismissed · dismiss`);
  assert.equal(s.ok("finding", "triage", "T1", real, "fix", "--proof", check), `${real} open · fix`);
  for (const line of [`- ${gone}: not reproduced`, `- \`${gone}\` — could not run`, `- a\n  - ${gone} reproduced (saw not ok 1)`, `| ${gone} | not reproduced |`]) {
    const near = s.reviewed("T1", "qa", proofCheck([line]));
    assert.match(s.no("verdict", "T1", "--kind", "qa-pass", "--sha", SHA, "--run", near), new RegExp(`^sage: ${near}'s report is a proof check`), line);
  }
});

test("F-T947-5: one pair of backticks around a proof or saw value is a Markdown mark, so the proof check runs the command itself", () => {
  const text = reportFor("findings", { findings: "\n- K1 medium a\n  proof: `npm test`\n  saw: `not ok 1 a`\n- K2 medium b\n  proof: `a` and `b`\n  saw: x" });
  assert.deepEqual(readReport(text).findings.map(({ key, severity, proof, saw }) => ({ key, severity, proof, saw })), [{ key: "K1", severity: "medium", proof: "npm test", saw: "not ok 1 a" }, { key: "K2", severity: "medium", proof: "`a` and `b`", saw: "x" }]);
});
