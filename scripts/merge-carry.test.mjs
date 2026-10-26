// The merge check keeps a task's verdicts over a clean merge of main (T493): the new head merges main into the reviewed
// head, main's side is in the pull request's base commit on GitHub, the pull request's diff is the same outside built
// files, and checks-pass is on the new head. Each test makes a small git history (fixtures/merge-history.mjs) and runs
// the built state tool on it, as the chief does, with a fake gh that gives the base commit.
import "./test-env.mjs"; // first: no variable of the developer's shell changes a result
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { history } from "./fixtures/merge-history.mjs";

const TOOL = fileURLToPath(new URL("../plugins/sage/skills/sage/sage.mjs", import.meta.url));
const SPY = fileURLToPath(new URL("kill-spy.mjs", import.meta.url));
const FIXED = { "CHANGELOG.md": "- task\n- main\n- base\n" }; // what npm run build writes after a CHANGELOG.md conflict

/**
 * A project repository with a logbook and one task T1 of the given size and flags. ok() and no() run the state tool.
 * check() and refused() run merge-check --pr 41 on a SHA. The fake gh first on PATH answers gh pr view with GitHub's
 * base commit: the tip of the main branch, or the SHA that base() sets; it fails when base("fail") is set.
 */
function world(t, ...task) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-carry-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const [project, bin] = [join(dir, "project"), join(dir, "bin")];
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${dir}/gh-calls.log"\n[ -f "${dir}/gh-fail" ] && exit 1\ncat "${dir}/gh.json"\n`, { mode: 0o755 });
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
  const h = history(project);
  let fixed;
  const base = (sha) => (fixed = sha);
  const answer = () => {
    rmSync(join(dir, "gh-fail"), { force: true });
    if (fixed === "fail") return writeFileSync(join(dir, "gh-fail"), "");
    writeFileSync(join(dir, "gh.json"), JSON.stringify({ headRefName: "sage/t1", isCrossRepository: false, baseRefOid: fixed ?? h.git("rev-parse", "main") }));
  };
  const verdicts = (sha, kinds, cycle = 1) => kinds.forEach((kind) => ok("verdict", "T1", "--sha", sha, "--kind", kind, "--cycle", String(cycle), "--pr", "41"));
  const carries = () => readFileSync(join(logbook, "decisions.tsv"), "utf8").split("\n").filter((line) => line.includes("\tverdicts "));
  const ghCalls = () => (existsSync(join(dir, "gh-calls.log")) ? readFileSync(join(dir, "gh-calls.log"), "utf8").split("\n").filter(Boolean) : []);
  return { h, ok, no, base, verdicts, carries, ghCalls, check: (sha) => (answer(), ok("merge-check", "--sha", sha, "--pr", "41")), refused: (sha) => (answer(), no("merge-check", "--sha", sha, "--pr", "41")) };
}

/** The reviewed head of a small task: one change to a source file, the change log and a built file, with its clean cycle. */
function reviewed(w) {
  w.h.start();
  const h0 = w.h.work({ "src.js": "a\nb\n", "CHANGELOG.md": "- task\n- base\n", "built/out.js": "a\nb\n" });
  w.verdicts(h0, ["checks-pass", "review-clean", "qa-pass"]);
  return h0;
}
const carried = (h0) => `T1 may merge: 1 clean cycle on this SHA, with verdicts carried over a clean merge of main from ${h0}`;
/** The reason of a refusal whose verdicts on the earlier head do not carry over, after the task's own line. */
const NOT_CARRIED = "sage: T1: 0 of 1 clean cycles on this SHA; never recorded: review-clean, qa-pass. Run the next cycle of its reviews on this SHA and record each verdict. Also, the verdicts on an earlier head do not carry over: ";

test("a clean merge of main keeps the verdicts of the reviewed head, and the decision trail records it once", (t) => {
  const w = world(t, "--size", "small");
  const h0 = reviewed(w);
  const h1 = w.h.merge(w.h.main({ "other.js": "m\n" }));
  assert.equal(w.refused(h1), `sage: no verdicts recorded for ${h1}. It is a clean merge of main into ${h0}, so the review and QA verdicts of T1 there carry over when they pass: record only checks-pass (CI on this SHA) for T1 with sage verdict, then check again.`, "the new head needs its own checks-pass, and only that");
  w.verdicts(h1, ["checks-pass"]);
  assert.equal(w.check(h1), carried(h0));
  assert.equal(w.ok("merge-check", "--sha", h1, "--pr", "41", "--head", "sage/t1"), carried(h0));
  const main = w.h.git("rev-parse", "main");
  assert.deepEqual(w.carries().map((line) => line.split("\t").slice(1)), [["T1", `verdicts ${h0} → ${h1}`, `merge-check: a clean merge of main ${main}, with the same diff outside built files and checks-pass on ${h1}`]], "one row, also after a second check");
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
  const otherwise = (path, from) => `the merge changes "${path}" otherwise than the earlier head ${from.slice(0, 7)} did, outside built files, so ${evil.slice(0, 7)} needs a fresh review and QA cycle. A file that both main and the pull request changed counts, also when git merges it with no conflict.`;
  assert.equal(w.refused(evil), `${NOT_CARRIED}${otherwise("src.js", h0)}`);
  // The merge marks src.js sage-built: the built files come from main's side, so .gitattributes itself differs.
  w.h.git("reset", "-q", "--hard", h0);
  const marked = w.h.merge(w.h.main({ "third.js": "x\n" }), { ".gitattributes": "CHANGELOG.md sage-built\nbuilt/** sage-built\nsrc.js sage-built\n", "src.js": "a\nb\nevil\n" });
  w.verdicts(marked, ["checks-pass"]);
  assert.match(w.refused(marked), /do not carry over: the merge changes "\.gitattributes" otherwise than the earlier head/);
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

test("the base comes from GitHub: a planted origin/HEAD, a moved origin/main, no --pr, a failing gh and a base that the clone lacks refuse", (t) => {
  const w = world(t, "--size", "small");
  const h0 = reviewed(w);
  // An unreviewed commit off main, which the local refs then name as main.
  w.h.git("checkout", "-q", "-b", "side", w.h.git("rev-parse", "main"));
  const side = w.h.work({ "other.js": "unreviewed\n" });
  w.h.git("checkout", "-q", "sage/t1");
  w.h.main({ "real.js": "r\n" }); // main moves on GitHub, so the side commit is neither in it nor ahead of it
  w.h.git("update-ref", "refs/remotes/origin/side", side);
  w.h.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/side");
  w.h.git("update-ref", "refs/remotes/origin/main", side);
  const stray = w.h.merge(side);
  w.verdicts(stray, ["checks-pass"]);
  const main = w.h.git("rev-parse", "main");
  assert.equal(w.refused(stray), `${NOT_CARRIED}its other parent ${side.slice(0, 7)} is not a commit of the pull request's base branch, which is at ${main.slice(0, 7)} on GitHub.`);
  w.base(side); // GitHub's base is the side commit: the same merge now carries
  assert.equal(w.check(stray), carried(h0));
  w.base(undefined);
  assert.match(w.no("merge-check", "--sha", stray), /do not carry over: the merge check has no base commit of the pull request from GitHub \(gh pr view, with --pr\)\.$/, "no --pr");
  w.base("fail");
  assert.match(w.refused(stray), /do not carry over: the merge check has no base commit of the pull request from GitHub/, "gh fails");
  // GitHub's base is older than the main that the merge took: the refusal says to update the pull request.
  w.base(main);
  const newer = w.h.main({ "fresh.js": "f\n" });
  w.h.git("reset", "-q", "--hard", h0);
  const ahead = w.h.merge(newer);
  w.verdicts(ahead, ["checks-pass"]);
  assert.equal(w.refused(ahead), `${NOT_CARRIED}its other parent ${newer.slice(0, 7)} is newer than the pull request's base commit ${main.slice(0, 7)} that GitHub gives. Update the pull request on GitHub (push the branch again, or wait until GitHub shows the new base), run git fetch, then check again.`);
  w.base("0123456789abcdef0123456789abcdef01234567");
  assert.match(w.refused(stray), /do not carry over: the pull request's base commit 0123456 on GitHub is not in this clone: run git fetch, then check again\.$/);
});

test("replace refs and grafts do not change what the merge check reads", (t) => {
  const w = world(t, "--size", "small");
  const h0 = reviewed(w);
  const main = w.h.main({ "other.js": "m\n" });
  const honest = w.h.merge(main);
  w.h.git("reset", "-q", "--hard", h0);
  const evil = w.h.merge(main, { "src.js": "a\nb\nevil\n" });
  w.verdicts(evil, ["checks-pass"]);
  w.h.git("replace", evil, honest); // git now shows the honest merge for the evil SHA, unless replace refs are off
  assert.match(w.refused(evil), /do not carry over: the merge changes "src\.js" otherwise than/);
  w.h.git("replace", "-d", evil);
  // A graft that shows a plain commit on the reviewed head as a merge of main.
  w.h.git("reset", "-q", "--hard", h0);
  const plain = w.h.work({ "other.js": "m\n" });
  w.verdicts(plain, ["checks-pass"]);
  writeFileSync(join(w.h.git("rev-parse", "--path-format=absolute", "--git-common-dir"), "info", "grafts"), `${plain} ${h0} ${main}\n`);
  assert.match(w.refused(plain), /do not carry over: the clone has info\/grafts, which changes the parents of commits\.$/);
});

test("a submodule link that the merge adds refuses, also in a built folder", (t) => {
  const w = world(t, "--size", "small");
  reviewed(w);
  const main = w.h.main({ "other.js": "m\n" });
  w.h.git("merge", "-q", "--no-ff", "--no-commit", main);
  w.h.git("update-index", "--add", "--cacheinfo", `160000,${main},built/sub`);
  w.h.git("commit", "-q", "--no-edit");
  const linked = w.h.git("rev-parse", "HEAD");
  w.verdicts(linked, ["checks-pass"]);
  assert.match(w.refused(linked), /do not carry over: the merge adds or changes the submodule link "built\/sub"\.$/);
});

test("a merge without checks-pass on the new head, a non-merge commit and a missing object refuse; gh is asked only when a parent has verdicts", (t) => {
  const w = world(t, "--size", "small");
  reviewed(w);
  const h1 = w.h.merge(w.h.main({ "other.js": "m\n" }));
  w.verdicts(h1, ["checks-fail"]);
  assert.match(w.refused(h1), /^sage: T1: cycle 1 found problems on this SHA \(checks-fail\)/, "CI failed on the new head");
  const next = w.h.work({ "src.js": "a\nb\nc\n" });
  w.verdicts(next, ["checks-pass"]);
  assert.match(w.refused(next), /do not carry over: [0-9a-f]{7} is not a merge of two commits\.$/);
  const calls = w.ghCalls().length;
  const gone = "0123456789abcdef0123456789abcdef01234567";
  w.verdicts(gone, ["checks-pass"]);
  assert.equal(w.refused(gone), "sage: T1: 0 of 1 clean cycles on this SHA; never recorded: review-clean, qa-pass. Run the next cycle of its reviews on this SHA and record each verdict.");
  assert.equal(w.ghCalls().length, calls, "a SHA with no parents to carry from asks GitHub nothing");
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
