// The merge check keeps a task's verdicts over a clean merge of main (T493): the new head merges main into the reviewed
// head, the pull request's diff is the same outside built files, and checks-pass is on the new head. Each test makes a
// small git history (fixtures/merge-history.mjs) and runs the built state tool on it, as the chief does.
import "./test-env.mjs"; // first: no variable of the developer's shell changes a result
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { history } from "./fixtures/merge-history.mjs";

const TOOL = fileURLToPath(new URL("../plugins/sage/skills/sage/sage.mjs", import.meta.url));
const SPY = fileURLToPath(new URL("kill-spy.mjs", import.meta.url));
const FIXED = { "CHANGELOG.md": "- task\n- main\n- base\n" }; // what npm run build writes after a CHANGELOG.md conflict

/** A project repository with a logbook and one task T1 of the given size and flags; ok() and no() run the state tool. */
function world(t, ...task) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-carry-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = join(dir, "project");
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  // Every command preloads the kill spy and asks SAGE_TEST_PIDS about a lock's holder, so no command signals or reads a real process.
  const env = { ...process.env, HOME: join(dir, "home"), SAGE_HOME: join(dir, "sage"), NODE_OPTIONS: `--import=${JSON.stringify(SPY)}`, SAGE_TEST_KILLS: join(dir, "kills"), SAGE_TEST_PIDS: "{}" };
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
  const verdicts = (sha, kinds, cycle = 1) => kinds.forEach((kind) => ok("verdict", "T1", "--sha", sha, "--kind", kind, "--cycle", String(cycle), "--pr", "41"));
  const carries = () => readFileSync(join(logbook, "decisions.tsv"), "utf8").split("\n").filter((line) => line.includes("\tverdicts "));
  return { h: history(project), ok, no, verdicts, carries };
}

/** The reviewed head of a small task: one change to a source file, the change log and a built file, with its clean cycle. */
function reviewed(w) {
  w.h.start();
  const h0 = w.h.work({ "src.js": "a\nb\n", "CHANGELOG.md": "- task\n- base\n", "built/out.js": "a\nb\n" });
  w.verdicts(h0, ["checks-pass", "review-clean", "qa-pass"]);
  return h0;
}

test("a clean merge of main keeps the verdicts of the reviewed head, and the decision trail records it once", (t) => {
  const w = world(t, "--size", "small");
  const h0 = reviewed(w);
  const h1 = w.h.merge(w.h.main({ "other.js": "m\n" }));
  assert.match(w.no("merge-check", "--sha", h1), /^sage: no verdicts recorded for /, "the new head needs its own checks-pass");
  w.verdicts(h1, ["checks-pass"]);
  assert.equal(w.ok("merge-check", "--sha", h1), `T1 may merge: 1 clean cycle on this SHA, with verdicts carried over a clean merge of main from ${h0}`);
  assert.equal(w.ok("merge-check", "--sha", h1, "--pr", "41", "--head", "sage/t1"), `T1 may merge: 1 clean cycle on this SHA, with verdicts carried over a clean merge of main from ${h0}`);
  const main = w.h.git("rev-parse", "main");
  assert.deepEqual(w.carries().map((line) => line.split("\t").slice(1)), [["T1", `verdicts ${h0} → ${h1}`, `merge-check: a clean merge of main ${main}, with the same diff outside built files and checks-pass on ${h1}`]], "one row, also after a second check");
});

test("a merge whose only conflict is in a built file, fixed by the build, keeps the verdicts; a chain of such merges keeps them too", (t) => {
  const w = world(t, "--size", "small");
  const h0 = reviewed(w);
  const h1 = w.h.merge(w.h.main({ "other.js": "m\n", "CHANGELOG.md": "- main\n- base\n", "built/out.js": "a\nm\n" }), { ...FIXED, "built/out.js": "a\nb\nm\n" });
  w.verdicts(h1, ["checks-pass"]);
  assert.match(w.ok("merge-check", "--sha", h1), new RegExp(`carried over a clean merge of main from ${h0}$`));
  const h2 = w.h.merge(w.h.main({ "more.js": "n\n" }));
  w.verdicts(h2, ["checks-pass"]);
  assert.equal(w.ok("merge-check", "--sha", h2), `T1 may merge: 1 clean cycle on this SHA, with verdicts carried over clean merges of main from ${h0}, then ${h1}`);
  assert.equal(w.carries().length, 2, "each step of the chain is in the decision trail");
});

test("a merge that changes a source file beyond main's refuses, also when it marks that file built in .gitattributes", (t) => {
  const w = world(t, "--size", "small");
  const h0 = reviewed(w);
  const main = w.h.main({ "other.js": "m\n" });
  const evil = w.h.merge(main, { "src.js": "a\nb\nevil\n" });
  w.verdicts(evil, ["checks-pass"]);
  assert.match(w.no("merge-check", "--sha", evil), /T1: 0 of 1 clean cycles on this SHA; never recorded: review-clean, qa-pass\. .* Also, the verdicts on an earlier head do not carry over: the merge changes "src\.js" otherwise than [0-9a-f]{7} did, outside built files\.$/);
  w.h.git("reset", "-q", "--hard", h0);
  const marked = w.h.merge(w.h.main({ "third.js": "x\n" }), { ".gitattributes": "CHANGELOG.md sage-built\nbuilt/** sage-built\nsrc.js sage-built\n", "src.js": "a\nb\nevil\n" });
  w.verdicts(marked, ["checks-pass"]);
  assert.match(w.no("merge-check", "--sha", marked), /do not carry over: the merge changes "(?:\.gitattributes|src\.js)" otherwise than/, "the built files come from main's side of the merge");
});

test("a merge without checks-pass on the new head, a non-merge commit, another branch than main and a missing object refuse", (t) => {
  const w = world(t, "--size", "small");
  const h0 = reviewed(w);
  const h1 = w.h.merge(w.h.main({ "other.js": "m\n" }));
  w.verdicts(h1, ["checks-fail"]);
  assert.match(w.no("merge-check", "--sha", h1), /^sage: T1: cycle 1 found problems on this SHA \(checks-fail\)/, "CI failed on the new head");
  // A new commit on top of the reviewed head, not a merge.
  const next = w.h.work({ "src.js": "a\nb\nc\n" });
  w.verdicts(next, ["checks-pass"]);
  assert.match(w.no("merge-check", "--sha", next), /Also, the verdicts on an earlier head do not carry over: [0-9a-f]{7} is not a merge of two commits\.$/);
  // A merge of a branch that is not on origin/main.
  w.h.git("checkout", "-q", "-b", "side", h0);
  const side = w.h.work({ "side.js": "s\n" });
  w.h.git("checkout", "-q", "sage/t1");
  w.h.git("reset", "-q", "--hard", h0);
  const stray = w.h.merge(side);
  w.verdicts(stray, ["checks-pass"]);
  assert.match(w.no("merge-check", "--sha", stray), /do not carry over: its other parent [0-9a-f]{7} is not a commit of origin\/main\.$/);
  // A head that the repository does not have.
  const gone = "0123456789abcdef0123456789abcdef01234567";
  w.verdicts(gone, ["checks-pass"]);
  assert.match(w.no("merge-check", "--sha", gone), /^sage: T1: 0 of 1 clean cycles on this SHA; never recorded: review-clean, qa-pass\. Run the next cycle of its reviews on this SHA and record each verdict\.$/);
  assert.deepEqual(w.carries(), [], "no refusal records a carry-over");
});

test("a carry-over needs every clean cycle that the task's size and risk need on the reviewed head", (t) => {
  const w = world(t, "--size", "small", "--risk", "auth");
  w.h.start();
  const h0 = w.h.work({ "src.js": "a\nb\n" });
  w.verdicts(h0, ["checks-pass", "review-clean", "security-clean", "qa-pass"]);
  const h1 = w.h.merge(w.h.main({ "other.js": "m\n" }));
  w.verdicts(h1, ["checks-pass"]);
  assert.match(w.no("merge-check", "--sha", h1), new RegExp(`Also, the verdicts of ${h0} do not carry over, because it does not pass: T1: 1 of 2 clean cycles on this SHA\\. Run the next cycle`));
  w.verdicts(h0, ["review-clean", "security-clean", "qa-pass"], 2);
  assert.match(w.ok("merge-check", "--sha", h1), /^T1 may merge: 2 clean cycles on this SHA, with verdicts carried over/);
  // A fresh review on the new head is its own cycle: the new head then judges on its own verdicts only.
  w.verdicts(h1, ["review-clean"]);
  assert.match(w.no("merge-check", "--sha", h1), /^sage: T1: 0 of 2 clean cycles on this SHA; never recorded: security-clean, qa-pass\. Run the next cycle/);
});
