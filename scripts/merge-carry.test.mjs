// The merge check keeps a task's verdicts over a clean merge of main (T493): the new head merges main into the reviewed
// head, main's side is in the pull request's base commit, the pull request's diff is the same outside built files, and
// checks-pass is on the new head. Every fact comes from GitHub, never from the local clone. Each test makes a small git
// history in a repository that stands in for GitHub (fixtures/merge-history.mjs), and runs the built state tool with a
// fake gh that answers from it (fixtures/fake-github.mjs). The project's own clone is empty or forged.
import "./test-env.mjs"; // first: no variable of the developer's shell changes a result
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fakeGithub, prView } from "./fixtures/fake-github.mjs";
import { history } from "./fixtures/merge-history.mjs";

const TOOL = fileURLToPath(new URL("../plugins/sage/skills/sage/sage.mjs", import.meta.url));
const SPY = fileURLToPath(new URL("kill-spy.mjs", import.meta.url));
const FIXED = { "CHANGELOG.md": "- task\n- main\n- base\n" }; // what npm run build writes after a CHANGELOG.md conflict
const REPO = "acme/project";

/**
 * A project with an empty local clone, a logbook that records REPO, and one task T1 of the given size and flags. h
 * builds the history on "GitHub". check() and refused() run merge-check --pr 41; GitHub's base commit is the tip of main
 * there, or what base() sets ("fail" makes gh fail).
 */
function world(t, ...task) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-carry-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const [project, github] = [join(dir, "project"), join(dir, "github")];
  for (const repo of [project, github]) execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const bin = fakeGithub(dir, github, REPO);
  // Every command preloads the kill spy and asks SAGE_TEST_PIDS about a lock's holder, so no command signals or reads a real process.
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: join(dir, "home"), SAGE_HOME: join(dir, "sage"), NODE_OPTIONS: `--import=${JSON.stringify(SPY)}`, SAGE_TEST_KILLS: join(dir, "kills"), SAGE_TEST_PIDS: "{}" };
  const run = (...args) => spawnSync(process.execPath, [TOOL, ...args, "--project", project], { encoding: "utf8", env, timeout: 60_000 });
  const ok = (...args) => {
    const r = run(...args);
    assert.equal(r.status, 0, `sage ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  const no = (...args) => {
    const r = run(...args);
    assert.equal(r.status, 1, `sage ${args.join(" ")} should be refused, printed: ${r.stdout}`);
    return r.stderr.trim();
  };
  const logbook = ok("init").replace(/^\S+ /, "");
  ok("task", "add", "--priority", "P2", "--title", "t", ...task);
  ok("config", `repo=${REPO}`);
  const h = history(github);
  let fixed;
  const answer = () => {
    rmSync(join(dir, "gh-fail"), { force: true });
    if (fixed === "fail") writeFileSync(join(dir, "gh-fail"), "");
    else writeFileSync(join(dir, "pr.json"), prView(REPO, fixed ?? h.git("rev-parse", "main")));
  };
  const calls = () => (existsSync(join(dir, "gh-calls.log")) ? readFileSync(join(dir, "gh-calls.log"), "utf8").split("\n").filter(Boolean) : []);
  return {
    h, ok, no, dir, project, calls,
    base: (sha) => (fixed = sha),
    verdicts: (sha, kinds, cycle = 1) => kinds.forEach((kind) => ok("verdict", "T1", "--sha", sha, "--kind", kind, "--cycle", String(cycle), "--pr", "41")),
    carries: () => readFileSync(join(logbook, "decisions.tsv"), "utf8").split("\n").filter((line) => line.includes("\tverdicts ")),
    check: (sha) => (answer(), ok("merge-check", "--sha", sha, "--pr", "41")),
    refused: (sha) => (answer(), no("merge-check", "--sha", sha, "--pr", "41")),
  };
}

/** The reviewed head of a small task: one change to a source file, the change log and a built file, with its clean cycle. */
function reviewed(w) {
  w.h.start();
  const h0 = w.h.work({ "src.js": "a\nb\n", "CHANGELOG.md": "- task\n- base\n", "built/out.js": "a\nb\n" });
  w.verdicts(h0, ["checks-pass", "review-clean", "qa-pass"]);
  return h0;
}
const carried = (h0) => `T1 may merge: 1 clean cycle on this SHA, with verdicts carried over a clean merge of main from ${h0}`;
/** The start of a refusal whose verdicts on an earlier head do not carry over, after the task's own line. */
const NOT_CARRIED = "sage: T1: 0 of 1 clean cycles on this SHA; never recorded: review-clean, qa-pass. Run the next cycle of its reviews on this SHA and record each verdict. Also, the verdicts on an earlier head do not carry over: ";

test("a clean merge of main keeps the verdicts of the reviewed head, from GitHub alone: the local clone is empty", (t) => {
  const w = world(t, "--size", "small");
  const h0 = reviewed(w);
  const h1 = w.h.merge(w.h.main({ "other.js": "m\n" }));
  assert.equal(w.refused(h1), `sage: no verdicts recorded for ${h1}. It is a clean merge of main into ${h0}, so the review and QA verdicts of T1 there carry over when they pass: record only checks-pass (CI on this SHA) for T1 with sage verdict, then check again.`, "the new head needs its own checks-pass, and only that");
  w.verdicts(h1, ["checks-pass"]);
  assert.equal(w.check(h1), carried(h0));
  assert.equal(w.ok("merge-check", "--sha", h1, "--pr", "41", "--head", "sage/t1"), carried(h0));
  const main = w.h.git("rev-parse", "main");
  assert.deepEqual(w.carries().map((line) => line.split("\t").slice(1)), [["T1", `verdicts ${h0} → ${h1}`, `merge-check: a clean merge of main ${main}, with the same diff outside built files and checks-pass on ${h1}`]], "one row, also after a second check");
  assert.ok(w.calls().every((c) => c.startsWith(`pr view 41 --repo ${REPO} `) || c.startsWith(`api --hostname github.com repos/${REPO}/`)), "every gh call names the recorded repository");
  assert.equal(execFileSync("git", ["-C", w.project, "count-objects"], { encoding: "utf8" }).trim(), "0 objects, 0 kilobytes", "the local clone has no object");
});

test("a merge whose only conflict is in a built file, fixed by the build, keeps the verdicts; a chain of such merges keeps them too", (t) => {
  const w = world(t, "--size", "small");
  const h0 = reviewed(w);
  const h1 = w.h.merge(w.h.main({ "other.js": "m\n", "CHANGELOG.md": "- main\n- base\n", "built/out.js": "a\nm\n" }), { ...FIXED, "built/out.js": "a\nb\nm\n" });
  w.verdicts(h1, ["checks-pass"]);
  assert.equal(w.check(h1), carried(h0));
  const h2 = w.h.merge(w.h.main({ "more.js": "n\n" }));
  w.verdicts(h2, ["checks-pass"]);
  assert.equal(w.check(h2), `T1 may merge: 1 clean cycle on this SHA, with verdicts carried over clean merges of main from ${h0}, then ${h1}`);
  assert.equal(w.carries().length, 2, "each step of the chain is in the decision trail");
});

test("a merge that changes a source file beyond main's refuses, also when the merge or the reviewed head marks that file built", (t) => {
  const w = world(t, "--size", "small");
  const h0 = reviewed(w);
  const evil = w.h.merge(w.h.main({ "other.js": "m\n" }), { "src.js": "a\nb\nevil\n" });
  w.verdicts(evil, ["checks-pass"]);
  assert.equal(w.refused(evil), `${NOT_CARRIED}the merge changes "src.js" otherwise than the earlier head ${h0.slice(0, 7)} did, outside built files, so ${evil.slice(0, 7)} needs a fresh review and QA cycle. A file that both main and the pull request changed counts, also when git merges it with no conflict.`);
  w.h.git("reset", "-q", "--hard", h0);
  const marked = w.h.merge(w.h.main({ "third.js": "x\n" }), { ".gitattributes": "CHANGELOG.md sage-built\nbuilt/** sage-built\nsrc.js sage-built\n", "src.js": "a\nb\nevil\n" });
  w.verdicts(marked, ["checks-pass"]);
  assert.match(w.refused(marked), /do not carry over: the merge changes "\.gitattributes" otherwise than the earlier head/, "the built files come from main's side");
});

test("a reviewed head that marks its own source file built does not widen the list: a later change to that file refuses", (t) => {
  const w = world(t, "--size", "small");
  w.h.start();
  const h0 = w.h.work({ ".gitattributes": "CHANGELOG.md sage-built\nbuilt/** sage-built\nsrc.js sage-built\n", "src.js": "a\nb\n" });
  w.verdicts(h0, ["checks-pass", "review-clean", "qa-pass"]);
  const h1 = w.h.merge(w.h.main({ "other.js": "m\n" }), { "src.js": "a\nb\nevil\n" });
  w.verdicts(h1, ["checks-pass"]);
  assert.match(w.refused(h1), /do not carry over: the merge changes "src\.js" otherwise than the earlier head/, "the list is main's, not the reviewed head's");
});

test("main's side must be in GitHub's base commit: another commit, a newer main, no --pr and a failing gh refuse", (t) => {
  const w = world(t, "--size", "small");
  const h0 = reviewed(w);
  // A commit off main that GitHub's main does not have.
  w.h.git("checkout", "-q", "-b", "side", w.h.git("rev-parse", "main"));
  const side = w.h.work({ "other.js": "unreviewed\n" });
  w.h.git("checkout", "-q", "sage/t1");
  w.h.main({ "real.js": "r\n" });
  const stray = w.h.merge(side);
  w.verdicts(stray, ["checks-pass"]);
  const main = w.h.git("rev-parse", "main");
  assert.equal(w.refused(stray), `${NOT_CARRIED}its other parent ${side.slice(0, 7)} is not a commit of the pull request's base branch, which is at ${main.slice(0, 7)} on GitHub.`);
  w.base(side); // GitHub's base is the side commit: the same merge now carries
  assert.equal(w.check(stray), carried(h0));
  // GitHub's base is older than the main that the merge took.
  w.base(main);
  const newer = w.h.main({ "fresh.js": "f\n" });
  w.h.git("reset", "-q", "--hard", h0);
  const ahead = w.h.merge(newer);
  w.verdicts(ahead, ["checks-pass"]);
  assert.equal(w.refused(ahead), `${NOT_CARRIED}its other parent ${newer.slice(0, 7)} is newer than the pull request's base commit ${main.slice(0, 7)} that GitHub gives. Update the pull request on GitHub (push the branch again, or wait until GitHub shows the new base), then check again.`);
  assert.match(w.no("merge-check", "--sha", ahead), /Also, if [0-9a-f]{7} merges main into a reviewed head, that head's verdicts may carry over: run sage merge-check --sha [0-9a-f]{40} --pr <n>, which checks it on GitHub\.$/, "no --pr: no GitHub reads");
  w.base("fail");
  assert.match(w.refused(ahead), /^sage: T1: 0 of 1 clean cycles on this SHA; never recorded: review-clean, qa-pass\. Run the next cycle of its reviews on this SHA and record each verdict\.$/, "gh fails: GitHub gives no parents, so nothing carries");
});

test("the logbook's repository record decides where the merge check reads GitHub: none or another one carries nothing", (t) => {
  const w = world(t, "--size", "small");
  reviewed(w);
  const h1 = w.h.merge(w.h.main({ "other.js": "m\n" }));
  w.verdicts(h1, ["checks-pass"]);
  w.ok("config", "repo=acme/elsewhere");
  assert.match(w.refused(h1), /^sage: T1: 0 of 1 clean cycles on this SHA; never recorded: review-clean, qa-pass\. Run the next cycle of its reviews on this SHA and record each verdict\.$/, "GitHub knows no such commit in the other repository");
  assert.ok(w.calls().some((c) => c.startsWith("api --hostname github.com repos/acme/elsewhere/commits/")));
  w.ok("config", "repo=");
  const before = w.calls().length;
  assert.match(w.refused(h1), /^sage: T1: 0 of 1 clean cycles on this SHA; never recorded: review-clean, qa-pass\. Run the next cycle of its reviews on this SHA and record each verdict\.$/);
  assert.equal(w.calls().length, before, "no record: the merge check asks GitHub nothing");
  assert.match(w.no("config", "repo=../x"), /repo is the GitHub repository as <owner>\/<name>/);
});

test("a local clone that lies changes nothing: its replace refs and grafts show an evil merge as clean, GitHub does not", (t) => {
  const w = world(t, "--size", "small");
  const h0 = reviewed(w);
  const main = w.h.main({ "other.js": "m\n" });
  const honest = w.h.merge(main);
  w.h.git("tag", "honest", honest);
  w.h.git("reset", "-q", "--hard", h0);
  const evil = w.h.merge(main, { "src.js": "a\nb\nevil\n" });
  w.verdicts(evil, ["checks-pass"]);
  execFileSync("git", ["-C", w.project, "fetch", "-q", join(w.dir, "github"), "+refs/heads/*:refs/remotes/origin/*", "+refs/tags/*:refs/tags/*"]);
  execFileSync("git", ["-C", w.project, "replace", evil, honest]);
  writeFileSync(join(w.project, ".git", "info", "grafts"), `${evil} ${h0} ${main}\n`);
  assert.match(w.refused(evil), /do not carry over: the merge changes "src\.js" otherwise than/);
});

test("a submodule link that the merge adds refuses, also in a built folder; a cut tree list refuses", (t) => {
  const w = world(t, "--size", "small");
  reviewed(w);
  const main = w.h.main({ "other.js": "m\n" });
  const clean = w.h.merge(main);
  w.h.git("reset", "-q", "--hard", "HEAD^");
  w.h.git("merge", "-q", "--no-ff", "--no-commit", main);
  w.h.git("update-index", "--add", "--cacheinfo", `160000,${main},built/sub`);
  w.h.git("commit", "-q", "--no-edit");
  const linked = w.h.git("rev-parse", "HEAD");
  w.verdicts(linked, ["checks-pass"]);
  assert.match(w.refused(linked), /do not carry over: the merge adds or changes the submodule link "built\/sub"\.$/);
  w.verdicts(clean, ["checks-pass"]);
  writeFileSync(join(w.dir, "truncate"), "");
  assert.match(w.refused(clean), /do not carry over: GitHub did not give the commits, trees and comparisons of [0-9a-f]{7} whole and in time\.$/);
});

test("a merge without checks-pass on the new head, a non-merge commit and a commit that GitHub lacks refuse", (t) => {
  const w = world(t, "--size", "small");
  reviewed(w);
  const h1 = w.h.merge(w.h.main({ "other.js": "m\n" }));
  w.verdicts(h1, ["checks-fail"]);
  assert.match(w.refused(h1), /^sage: T1: cycle 1 found problems on this SHA \(checks-fail\)/, "CI failed on the new head");
  const next = w.h.work({ "src.js": "a\nb\nc\n" });
  w.verdicts(next, ["checks-pass"]);
  assert.match(w.refused(next), /do not carry over: [0-9a-f]{7} is not a merge of two commits on GitHub\.$/);
  const gone = "0123456789abcdef0123456789abcdef01234567";
  w.verdicts(gone, ["checks-pass"]);
  assert.equal(w.refused(gone), "sage: T1: 0 of 1 clean cycles on this SHA; never recorded: review-clean, qa-pass. Run the next cycle of its reviews on this SHA and record each verdict.");
  assert.deepEqual(w.carries(), [], "no refusal records a carry-over");
});

test("a carry-over needs every clean cycle that the task's size and risk need on the reviewed head", (t) => {
  const w = world(t, "--size", "small", "--risk", "auth");
  w.h.start();
  const h0 = w.h.work({ "src.js": "a\nb\n" });
  w.verdicts(h0, ["checks-pass", "review-clean", "security-clean", "qa-pass"]);
  const h1 = w.h.merge(w.h.main({ "other.js": "m\n" }));
  w.verdicts(h1, ["checks-pass"]);
  assert.match(w.refused(h1), new RegExp(`Also, the verdicts of ${h0} do not carry over, because it does not pass: T1: 1 of 2 clean cycles on this SHA\\. Run the next cycle`));
  w.verdicts(h0, ["review-clean", "security-clean", "qa-pass"], 2);
  assert.match(w.check(h1), /^T1 may merge: 2 clean cycles on this SHA, with verdicts carried over/);
  // A fresh review on the new head is its own cycle: the new head then judges on its own verdicts only.
  w.verdicts(h1, ["review-clean"]);
  assert.match(w.refused(h1), /^sage: T1: 0 of 2 clean cycles on this SHA; never recorded: security-clean, qa-pass\. Run the next cycle/);
});
