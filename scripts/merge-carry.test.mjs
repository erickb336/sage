// The merge check counts the clean cycles of an earlier head H1 for a new head H2 (T805, the owner's Q3 of T668) only when
// H2 is H1 plus clean merges of origin/main, the pull request's own diff has the same patch-id, and checks-pass is on H2.
// Each test makes a real git history in the project's own clone, records the verdicts with the built state tool as the
// chief does, and runs merge-check. origin/main is set by hand, as a fetch would set it.
import "./test-env.mjs"; // first: no variable of the developer's shell changes a result
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildBoardModel, landingRule, readBoardSources } from "../packages/sage-core/index.mjs";
import { keepReport } from "../plugins/sage/skills/sage/sage.mjs";
import { backed } from "./verdict-backing.mjs";

const TOOL = fileURLToPath(new URL("../plugins/sage/skills/sage/sage.mjs", import.meta.url));
const SPY = fileURLToPath(new URL("kill-spy.mjs", import.meta.url));

/**
 * A project whose clone has main (one commit, fetched as origin/main) and the branch sage/t1, and a logbook with one small
 * task T1 on PR 41 that is in review. git runs in the clone; work commits files on the current branch; main commits on main
 * and fetches it; merge merges main into sage/t1. reviewed records T1's clean cycle on a SHA.
 */
function world(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-carry-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = join(dir, "project");
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  const git = (...args) => execFileSync("git", ["-C", project, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const work = (files, message = "work") => {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(project, name), text);
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const fetch = () => git("update-ref", "refs/remotes/origin/main", "main");
  const main = (files) => {
    git("checkout", "-q", "main");
    const sha = work(files, "main");
    git("checkout", "-q", "sage/t1");
    fetch();
    return sha;
  };
  const merge = (what = "main") => (git("merge", "-q", "--no-ff", "--no-edit", what), git("rev-parse", "HEAD"));
  work({ "a.txt": "1\n2\n3\n4\n5\n6\n7\n8\n9\n" }, "base");
  fetch();
  git("checkout", "-q", "-b", "sage/t1");
  // Every command preloads the kill spy and asks SAGE_TEST_PIDS about a lock's holder, so no command signals or reads a real process.
  const env = { ...process.env, HOME: join(dir, "home"), SAGE_HOME: join(dir, "sage"), NODE_OPTIONS: `--import=${JSON.stringify(SPY)}`, SAGE_TEST_KILLS: join(dir, "kills"), SAGE_TEST_PIDS: "{}" };
  const run = (...args) => spawnSync(process.execPath, [TOOL, ...args, "--project", project], { encoding: "utf8", env, timeout: 60_000 });
  const cli = (...args) => {
    const r = run(...args);
    if (r.status) throw Error(`sage ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  const ok = (...args) => cli(...backed(args, { cli, keep: (fields) => keepReport(project, fields, env) }));
  cli("init");
  ok("task", "add", "--priority", "P2", "--title", "t", "--size", "small");
  ok("task", "T1", "set", "branch=sage/t1", "pr=41");
  for (const state of ["briefed", "building", "reviewing"]) ok("task", "T1", "set", `state=${state}`);
  const verdicts = (sha, ...kinds) => kinds.forEach((kind) => ok("verdict", "T1", "--sha", sha, "--kind", kind, "--cycle", "1", "--pr", "41"));
  return {
    git, work, main, merge, verdicts, fetch, ok, cli, env,
    reviewed: (sha) => verdicts(sha, "checks-pass", "review-clean", "qa-pass"),
    check: (sha) => cli("merge-check", "--sha", sha, "--pr", "41"),
    refused: (sha, ...more) => {
      const r = run("merge-check", "--sha", sha, "--pr", "41", ...more);
      assert.equal(r.status, 1, `merge-check should refuse ${sha}, printed: ${r.stdout}`);
      return r.stderr.trim();
    },
  };
}

const carried = (h1, h2) => `T1 may merge: 1 clean cycle, cycles from ${h1} carried to ${h2}: clean merge of main, same patch-id`;
/** The refusal of a head with checks-pass and no cycle of its own, whose earlier head's cycles do not carry, for why. */
const notCarried = (h1, why) => `sage: T1: 0 of 1 clean cycles on this SHA; never recorded: review-clean, qa-pass. Run the next cycle of its reviews on this SHA and record each verdict. The cycles of ${h1} do not carry to this SHA: ${why}.`;

test("a: the clean cycle of the reviewed head counts after a clean merge of main, and after a chain of them", (t) => {
  const w = world(t);
  const h1 = w.work({ "src.js": "x\n", "a.txt": "1p\n2\n3\n4\n5\n6\n7\n8\n9\n" });
  w.reviewed(h1);
  // main changes the same file, outside the pull request's hunk and its 3 lines of context: git merges it with no conflict
  w.main({ "other.js": "m\n", "a.txt": "1\n2\n3\n4\n5\n6\n7\n8\n9m\n" });
  const h2 = w.merge();
  w.verdicts(h2, "checks-pass");
  assert.equal(w.check(h2), carried(h1, h2));
  w.main({ "more.js": "n\n" });
  const h3 = w.merge();
  w.verdicts(h3, "checks-pass");
  assert.equal(w.check(h3), carried(h1, h3), "each step is a clean merge of main, so the cycles of h1 still count");
  // A review on the new head starts its own cycles: the head then judges on its own verdicts only, and the refusal says so.
  w.verdicts(h3, "review-clean");
  assert.equal(w.refused(h3), `sage: T1: 0 of 1 clean cycles on this SHA; never recorded: qa-pass. Run the next cycle of its reviews on this SHA and record each verdict. The cycles of ${h1} do not carry to this SHA: it has review or QA verdicts of its own, so only its own cycles count.`);
});

test("b: no carry when the pull request's own diff changed, also when every merge is clean", (t) => {
  const w = world(t);
  const h1 = w.work({ "src.js": "x\n", "a.txt": "1p\n2\n3\n4\n5\n6\n7\n8\n9\n" });
  w.reviewed(h1);
  w.main({ "a.txt": "1p\n2\n3\n4\n5\n6\n7\n8\n9\n" }); // main lands part of the change, so the pull request's own diff loses a.txt
  const h2 = w.merge();
  w.verdicts(h2, "checks-pass");
  assert.equal(w.refused(h2), notCarried(h1, "the pull request's own diff changed (its patch-id is not the same)"));
});

test("c: no carry with an edit in the merge, an extra commit, a merge of another branch, a rebase or a conflict resolution", (t) => {
  const w = world(t);
  const top = w.git("rev-parse", "--show-toplevel");
  const h1 = w.work({ "src.js": "x\n", "a.txt": "1\n2p\n3\n4\n5\n6\n7\n8\n9\n" });
  w.reviewed(h1);
  const clean = w.main({ "other.js": "m\n" });
  w.git("merge", "-q", "--no-ff", "--no-commit", "main");
  writeFileSync(join(top, "src.js"), "x\nevil\n");
  w.git("add", "src.js");
  w.git("commit", "-q", "--no-edit");
  const evil = w.git("rev-parse", "HEAD");
  w.verdicts(evil, "checks-pass");
  assert.equal(w.refused(evil), notCarried(h1, `${evil} is not the clean merge of its parents (it resolves a conflict or adds an edit)`));

  w.git("reset", "-q", "--hard", h1);
  w.merge();
  const extra = w.work({ "src.js": "x\ny\n" });
  w.verdicts(extra, "checks-pass");
  assert.equal(w.refused(extra), notCarried(h1, `${extra} is not a merge of two parents`));

  w.git("reset", "-q", "--hard", h1);
  w.git("checkout", "-q", "-b", "side", "main");
  const side = w.work({ "side.js": "unreviewed\n" });
  w.git("checkout", "-q", "sage/t1");
  const stray = w.merge("side");
  w.verdicts(stray, "checks-pass");
  assert.equal(w.refused(stray), notCarried(h1, `${stray} merges ${side}, which is not on origin/main (fetch origin if main moved)`));

  w.git("reset", "-q", "--hard", clean);
  w.git("cherry-pick", h1); // the reviewed change, rebased onto main: a new commit that no review saw
  const rebased = w.git("rev-parse", "HEAD");
  w.verdicts(rebased, "checks-pass");
  assert.equal(w.refused(rebased), notCarried(h1, `${h1} is not on the first-parent line of ${rebased} (a rebase or an amended commit)`));

  w.git("reset", "-q", "--hard", h1);
  const m = w.main({ "a.txt": "1\n2m\n3\n4\n5\n6\n7\n8\n9\n" });
  assert.throws(() => w.merge(), "the merge conflicts");
  writeFileSync(join(top, "a.txt"), "1\n2pm\n3\n4\n5\n6\n7\n8\n9\n");
  w.git("add", "a.txt");
  w.git("commit", "-q", "--no-edit");
  const resolved = w.git("rev-parse", "HEAD");
  w.verdicts(resolved, "checks-pass");
  assert.equal(w.refused(resolved), notCarried(h1, `${resolved} merges ${m} with a conflict`));
});

test("d: no carry without checks-pass on the new head, and a checks-fail there refuses", (t) => {
  const w = world(t);
  const h1 = w.work({ "src.js": "x\n" });
  w.reviewed(h1);
  w.main({ "other.js": "m\n" });
  const h2 = w.merge();
  assert.equal(w.refused(h2), `sage: no verdicts recorded for ${h2}. Record the reviews and QA with sage verdict first.`, "the checks-pass of h1 does not count for h2");
  w.verdicts(h2, "checks-fail");
  assert.equal(w.refused(h2), `sage: T1: cycle 1 found problems on this SHA (checks-fail). Repair, then review the new SHA. (cycles from ${h1} carried to ${h2}: clean merge of main, same patch-id)`, "CI failed on h2");
});

test("e: a git failure refuses: no origin/main, or an earlier head that the clone does not have", (t) => {
  const w = world(t);
  const h1 = w.work({ "src.js": "x\n" });
  w.reviewed(h1);
  w.main({ "other.js": "m\n" });
  const h2 = w.merge();
  w.verdicts(h2, "checks-pass");
  w.git("update-ref", "-d", "refs/remotes/origin/main");
  assert.equal(w.refused(h2), notCarried(h1, "git could not read it (exit 128)"));
  w.fetch();
  assert.equal(w.check(h2), carried(h1, h2), "the same history carries once origin/main is back");
  const gone = "0123456789abcdef0123456789abcdef01234567";
  w.reviewed(gone); // a later reviewed head that the clone does not have is the latest candidate
  assert.equal(w.refused(h2), notCarried(gone, "git could not read it (exit 128)"));
});

test("f: both boards agree with the merge check on a head whose cycles carry, and refuse on a git doubt (F-T805-1)", (t) => {
  const w = world(t);
  const h1 = w.work({ "src.js": "x\n" });
  w.reviewed(h1);
  for (const state of ["verifying", "verified"]) w.ok("task", "T1", "set", `state=${state}`);
  w.main({ "other.js": "m\n" });
  const h2 = w.merge();
  w.verdicts(h2, "checks-pass");
  assert.equal(w.check(h2), carried(h1, h2));
  const sources = [{ id: "current", path: w.env.SAGE_HOME }];
  const card = () => buildBoardModel(readBoardSources(sources), { landing: landingRule(sources) }).tasks.find((c) => c.id === "T1").mergeCheck;
  assert.deepEqual(card(), { ok: true, text: `The merge check passes on ${h2.slice(0, 7)}. The board does not check the PR's head branch.` }, "the rich board");
  assert.match(w.cli("board", "all"), /\n- T1 PR #41 waits for your merge \(autopilot may merge it tonight, as of the last fetch\): t\n/, "the chat board");
  // Fail closed: when git cannot read the history, the boards refuse as the merge check does.
  w.git("update-ref", "-d", "refs/remotes/origin/main");
  assert.equal(w.refused(h2), notCarried(h1, "git could not read it (exit 128)"));
  assert.deepEqual(card(), { ok: false, text: `The merge check refuses ${h2.slice(0, 7)}. T1: 0 of 1 clean cycles on this SHA; never recorded: review-clean, qa-pass.` });
  assert.match(w.cli("board", "all"), /\n- T1 PR #41 cannot merge yet \(T1\\: 0 of 1 clean cycles on this SHA; never recorded\\: review-clean, qa…\): t\n/);
});

test("g: a carried refusal says that a verdict on this SHA replaces the carried cycles, and the next refusal says why (F-T805-2)", (t) => {
  const w = world(t);
  const h1 = w.work({ "src.js": "x\n" });
  w.reviewed(h1);
  w.main({ "other.js": "m\n" });
  const h2 = w.merge();
  w.verdicts(h2, "checks-pass");
  assert.equal(w.refused(h2, "--cycles", "2"), `sage: T1: 1 of 2 clean cycles on this SHA. A review or QA verdict on this SHA replaces the carried cycles of ${h1}, so this SHA then needs all 2 clean cycles of its own: run them on this SHA, or run the missing cycles on ${h1}. (cycles from ${h1} carried to ${h2}: clean merge of main, same patch-id)`);
  // The owner's rule is all or nothing: a cycle on h2 does not add to the cycle of h1, and the refusal says why.
  w.verdicts(h2, "review-clean", "qa-pass");
  assert.equal(w.refused(h2, "--cycles", "2"), `sage: T1: 1 of 2 clean cycles on this SHA. Run the next cycle of its reviews on this SHA and record each verdict. The cycles of ${h1} do not carry to this SHA: it has review or QA verdicts of its own, so only its own cycles count.`);
});

test("h: a merge attribute of the pull request cannot make a conflict with main look clean (F-T805-4)", (t) => {
  const w = world(t);
  // The pull request adds a line after line 8 and asks for a union merge of a.txt in its own .gitattributes.
  const h1 = w.work({ ".gitattributes": "a.txt merge=union\n", "a.txt": "1\n2\n3\n4\n5\n6\n7\n8\nP\n9\n" });
  w.reviewed(h1);
  // main adds a blank line at the same place: a conflict, which the union merge in the pull request's checkout hides. The
  // pull request's own diff keeps its patch-id, because patch-id ignores whitespace, so only the merge's tree can tell.
  const m = w.main({ "a.txt": "1\n2\n3\n4\n5\n6\n7\n8\n\n9\n" });
  const h2 = w.merge();
  w.verdicts(h2, "checks-pass");
  assert.equal(w.refused(h2), notCarried(h1, `${h2} merges ${m} with a conflict`));
});
