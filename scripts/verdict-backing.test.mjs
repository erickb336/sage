// T483: the state tool's verdict command records a review or QA verdict only when a report that a stop hook kept backs
// it. Each test runs the real state tool of the Claude plugin as a command, against a temporary logbook.
import "./test-env.mjs"; // first: no variable of the developer's shell changes a result
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { keepReport } from "../plugins/sage/skills/sage/sage.mjs";
import { reportFor } from "./verdict-backing.mjs";

const TOOL = fileURLToPath(new URL("../plugins/sage/skills/sage/sage.mjs", import.meta.url));
const PLUGIN = fileURLToPath(new URL("../plugins/sage", import.meta.url));
const SPY = fileURLToPath(new URL("kill-spy.mjs", import.meta.url));
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const OTHER = "0123456789abcdef0123456789abcdef01234567";
/** The FINDINGS report of a code review with one medium finding. */
const FINDINGS = reportFor("findings");

/**
 * A logbook for one made-up project. cli(args, { cwd, tool }) runs a command as given, with no --project added; ok() and
 * no() add --project and expect success or a refusal. Each command preloads the kill spy and asks SAGE_TEST_PIDS about a
 * lock's holder, so no command reads or signals a real process.
 */
function logbook() {
  // The project's physical path, as a process in its folder sees it (macOS gives /private/var for /var).
  const home = mkdtempSync(join(tmpdir(), "sage-home-")), project = realpathSync(mkdtempSync(join(tmpdir(), "sage-project-")));
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
  const dir = ok("init").replace(/^\S+ /, ""); // init prints "logbook <folder>"
  /** A review or QA run of a task that ended done, with its helper's report kept as a stop hook keeps it (or none). */
  const reviewed = (task, role, text, sha = SHA) => {
    const run = ok("run", "add", task, "--role", role).split(" ")[0];
    if (text !== undefined) keepReport(project, { task, run, role, sha, text }, env);
    ok("run", "done", run, "--status", "done", "--tokens", "1");
    return run;
  };
  const ledger = () => readFileSync(join(dir, "ledger.tsv"), "utf8");
  return { home, project, env, cli, ok, no, dir, reviewed, ledger };
}

test("T483: a FINDINGS report never backs review-clean, in every form in which the state tool can be run", () => {
  const s = logbook();
  s.ok("task", "add", "--priority", "P2", "--title", "a", "--size", "small");
  const run = s.reviewed("T1", "code-reviewer", FINDINGS);
  // A copy of the plugin whose state tool is at SKILLS/SAGE/sage.mjs: another letter case of the tool's path, which a
  // case-insensitive file system also gives the real file (R1847-2). Node runs no .MJS file, so the case is in the folders.
  // The copy's code is the same, so it refuses as the tool does.
  const copy = join(realpathSync(mkdtempSync(join(tmpdir(), "sage-copy-"))), "plugin");
  cpSync(PLUGIN, copy, { recursive: true });
  renameSync(join(copy, "skills"), join(copy, "SKILLS"));
  renameSync(join(copy, "SKILLS/sage"), join(copy, "SKILLS/SAGE"));
  const words = ["verdict", "T1", "--kind", "review-clean", "--sha", SHA, "--cycle", "1", "--run", run];
  // The process that each shell form starts. A glob (node /…/sage/*.mjs) and a variable (node $T) give node the tool's
  // plain path after the shell expands them (R1848-2, R1845-1); --project= and a relative --project name the logbook
  // as the state tool resolves it, from the command's folder (R1848-1).
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
    assert.match(r.stderr, new RegExp(`^sage: ${run}'s report has 1 medium or high finding \\(RESULT FINDINGS with medium findings\\), and T1 holds 0 of ${run} at that severity or above: so it backs findings\\. For review-clean, record each one first`), form);
    assert.equal(s.ledger(), before, `${form}: nothing is recorded`);
  }
});

test("T483: a FINDINGS report backs a clean verdict after triage of each of its findings: dismissed, moved or closed", () => {
  const s = logbook();
  s.ok("task", "add", "--priority", "P2", "--title", "a", "--size", "small");
  // Dismissed: the finding is recorded for the run, then dismissed with a reason.
  const r1 = s.reviewed("T1", "code-reviewer", FINDINGS);
  s.ok("finding", "add", "T1", "--source", "code-reviewer", "--severity", "medium", "--summary", "a wrong claim", "--run", r1, "--class", "other");
  assert.match(s.no("verdict", "T1", "--kind", "review-clean", "--sha", SHA, "--run", r1), new RegExp(`^sage: ${r1}'s report has findings \\(RESULT FINDINGS with medium findings\\), and F-T1-1 \\(medium\\) is still open: so it backs findings, or review-clean after each one is dismissed with a reason, moved or closed\\. Nothing changed\\.$`));
  s.ok("finding", "triage", "T1", "F-T1-1", "dismiss", "--reason", "the code does check it");
  assert.match(s.ok("verdict", "T1", "--kind", "review-clean", "--sha", SHA, "--run", r1), /^T1 review-clean · a1b2c3d · cycle 1$/);
  // Moved: the finding goes to a follow-up task, and the move's decision keeps its run.
  const r2 = s.reviewed("T1", "qa", reportFor("qa-fail"));
  s.ok("finding", "add", "T1", "--source", "qa", "--severity", "medium", "--summary", "a slow page", "--run", r2, "--class", "speed");
  s.ok("finding", "move", "T1", "F-T1-2", "--to", "Make the page fast");
  assert.match(s.ok("verdict", "T1", "--kind", "qa-pass", "--sha", SHA, "--run", r2), /^T1 qa-pass · a1b2c3d · cycle 1$/);
  // By its key: a finding whose key starts with the run's id is that run's finding.
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
  const before = s.ledger();
  assert.equal(verdict("review-clean"), "sage: review-clean is a review or QA verdict, so it names the run whose kept report backs it: add --run with the code-reviewer run of T1 whose helper ended with its report. Nothing changed.");
  const qa = s.reviewed("T1", "qa", reportFor("qa-pass"));
  assert.equal(verdict("review-clean", qa), `sage: ${qa} is a qa run, so it backs no review-clean verdict: only a code-reviewer run does. Nothing changed.`);
  const running = s.ok("run", "add", "T1", "--role", "code-reviewer").split(" ")[0];
  assert.equal(verdict("review-clean", running), `sage: ${running} still runs: end it after its helper's report (sage run done ${running} --status done --tokens <n>), then record its verdict. Nothing changed.`);
  const other = s.reviewed("T2", "code-reviewer", reportFor("review-clean"));
  assert.equal(verdict("review-clean", other), `sage: ${other} is a run of T2, not of T1: name the code-reviewer run of T1 whose report backs this verdict. Nothing changed.`);
  const bare = s.reviewed("T1", "code-reviewer");
  assert.equal(verdict("review-clean", bare), `sage: ${bare} has no kept report: sage keeps a helper's report at its stop, and only for a helper whose name is its run's id. Run the review again under a new run (sage run add T1 --role code-reviewer), whose helper has the run's id as its name, and record its verdict with --run after it ends. Nothing changed.`);
  const failed = s.ok("run", "add", "T1", "--role", "code-reviewer").split(" ")[0];
  s.ok("run", "done", failed, "--status", "failed");
  assert.match(verdict("review-clean", failed), new RegExp(`^sage: ${failed} ended as failed, so it backs no verdict\\. Run the review again under a new run`));
  // The hook saw the helper review another commit, or the report's BRANCH names another one.
  const seen = s.reviewed("T1", "code-reviewer", reportFor("review-clean"), OTHER);
  assert.equal(verdict("review-clean", seen), `sage: ${seen}'s report is on 0123456, not on a1b2c3d: a verdict names the commit that its helper reviewed. Record it on ${OTHER}, or review a1b2c3d under a new run. Nothing changed.`);
  const named = s.reviewed("T1", "code-reviewer", reportFor("review-clean").replace("BRANCH none", `BRANCH sage/t1-a at ${OTHER.toUpperCase()}`), "");
  assert.match(verdict("review-clean", named), new RegExp(`^sage: ${named}'s report is on 0123456, not on a1b2c3d`));
  // A clean report backs no problem verdict, and a report that the reader cannot read backs none.
  s.ok("finding", "add", "T1", "--source", "sage", "--severity", "medium", "--summary", "an open problem");
  assert.match(verdict("findings", qa), /only a code-reviewer, security-reviewer or ux-reviewer run does/);
  const clean =s.reviewed("T1", "code-reviewer", reportFor("review-clean"));
  assert.equal(verdict("findings", clean), `sage: ${clean}'s report is clean (RESULT CLEAN), so it backs only review-clean. Nothing changed.`);
  const odd = s.reviewed("T1", "code-reviewer", "STATUS done\nRESULT LGTM\nEVIDENCE x\nFINDINGS none\nQUESTIONS none\nNOT VERIFIED none\nBRANCH none");
  assert.match(verdict("review-clean", odd), new RegExp(`^sage: ${odd}'s kept report cannot be read \\(RESULT starts with "LGTM"`));
  assert.equal(s.ledger(), before, "no refused verdict is recorded");
  // One run backs one verdict.
  assert.match(s.ok("verdict", "T1", "--kind", "review-clean", "--sha", SHA, "--run", clean), /^T1 review-clean · a1b2c3d · cycle 1/);
  assert.match(s.no("verdict", "T1", "--kind", "review-clean", "--sha", SHA, "--cycle", "2", "--run", clean), new RegExp(`^sage: ${clean} already backs the review-clean verdict of T1 on a1b2c3d: one run backs one review or QA verdict\\. Run the review again under a new run\\.$`));
  // A check verdict needs no run, and the report that the hook saw on the verdict's commit backs it.
  s.ok("verdict", "T1", "--kind", "checks-pass", "--sha", SHA);
  const match = s.reviewed("T1", "qa", reportFor("qa-pass").replace("BRANCH none", `BRANCH sage/t1-a ${SHA}`));
  assert.match(s.ok("verdict", "T1", "--kind", "qa-pass", "--sha", SHA, "--run", match), /^T1 qa-pass · a1b2c3d · cycle 1$/);
});

test("T483: a kept report stays as it was first kept, and only a run of its task and role keeps one", () => {
  const s = logbook();
  s.ok("task", "add", "--priority", "P2", "--title", "a", "--size", "small");
  const run = s.ok("run", "add", "T1", "--role", "code-reviewer").split(" ")[0];
  assert.throws(() => keepReport(s.project, { task: "T1", run, role: "qa", sha: "", text: FINDINGS }, s.env), /is not a qa run of T1, so no report is kept/);
  assert.throws(() => keepReport(s.project, { task: "T1", run, role: "code-reviewer", sha: "abc", text: FINDINGS }, s.env), /the full SHA of its commit or none/);
  const file = keepReport(s.project, { task: "T1", run, role: "code-reviewer", sha: SHA, text: FINDINGS }, s.env);
  keepReport(s.project, { task: "T1", run, role: "code-reviewer", sha: SHA, text: reportFor("review-clean") }, s.env);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).text, FINDINGS, "a later stop never replaces the first report");
  s.ok("run", "done", run, "--status", "done", "--tokens", "1");
  assert.match(s.no("verdict", "T1", "--kind", "review-clean", "--sha", SHA, "--run", run), /report has 1 medium or high finding/);
});
