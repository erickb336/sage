// T927: sage worktrees lists the worktrees of the project's repository with the task of each, and worktrees prune --yes
// removes only the clean ones of a merged or abandoned task, or of a branch in origin/main. Every repository, logbook and
// home folder here is a scratch folder: SAGE_HOME and HOME never leave it.
import "./test-env.mjs"; // first: no variable of the developer's shell changes a result
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const TOOL = fileURLToPath(new URL("../plugins/sage/skills/sage/sage.mjs", import.meta.url));
const SPY = fileURLToPath(new URL("kill-spy.mjs", import.meta.url));
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A scratch project with a bare origin, a logbook in a scratch SAGE_HOME, and the tool's commands on it. */
function world(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-worktrees-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const env = { ...process.env, SAGE_HOME: join(base, "sage"), HOME: join(base, "home"), NODE_OPTIONS: `--import=${JSON.stringify(SPY)}`, SAGE_TEST_KILLS: join(base, "kills"), SAGE_TEST_PIDS: "{}" };
  mkdirSync(env.HOME);
  const origin = join(base, "origin.git"), project = join(base, "project");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: gitEnv });
  execFileSync("git", ["init", "-q", "-b", "main", project], { env: gitEnv });
  git(project, "remote", "add", "origin", origin);
  const run = (args, cwd = project) => spawnSync("node", [TOOL, ...args, "--project", project], { cwd, env, encoding: "utf8", timeout: 60_000 });
  const ok = (args, cwd) => {
    const r = run(args, cwd);
    assert.equal(r.status, 0, `sage ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout.trim().replaceAll(base, "<base>");
  };
  const no = (args, cwd) => {
    const r = run(args, cwd);
    assert.equal(r.status, 1, `sage ${args.join(" ")} did not refuse: ${r.stdout}`);
    return r.stderr.trim().replaceAll(base, "<base>");
  };
  const commit = (cwd, file) => {
    writeFileSync(join(cwd, file), file);
    git(cwd, "add", file);
    git(cwd, "commit", "-q", "-m", file);
    return git(cwd, "rev-parse", "HEAD");
  };
  /** A worktree under <base>/wt, on a new branch from start, or detached at start. */
  const add = (name, branch, start = "main") => {
    const path = join(base, "wt", name);
    git(project, "worktree", "add", "-q", ...(branch ? ["-b", branch] : ["--detach"]), path, start);
    return path;
  };
  /** Sets one cell of a task's row, as a later state of the task would (the PR script marks a task merged). */
  const cell = (id, column, value) => {
    const file = join(ok(["logbook"]).replace("<base>", base), "tasks.tsv");
    const [head, ...lines] = readFileSync(file, "utf8").split("\n"), at = head.split("\t").indexOf(column);
    writeFileSync(file, [head, ...lines.map((l) => (l.startsWith(`${id}\t`) ? l.split("\t").with(at, value).join("\t") : l))].join("\n"));
  };
  return { base, project, git, ok, no, commit, add, cell };
}

test("T927: worktrees lists each worktree with its branch, task, state and reason, and prune removes only the clean ones that may go", (t) => {
  const w = world(t), { base, project } = w;
  const first = w.commit(project, "README.md");
  w.commit(project, "main.txt");
  git(project, "push", "-q", "-u", "origin", "main");
  w.ok(["init"]);
  for (let k = 1; k <= 10; k++) w.ok(["task", "add", "--title", `task ${k}`, "--size", "small", "--priority", "P2"]);
  const branches = { T1: "claude/t1-merged", T2: "claude/t2-unpushed", T3: "claude/t3-abandoned", T4: "claude/t4-open", T6: "claude/t6-changed", T7: "claude/t7-untracked", T8: "claude/t8-locked", T9: "claude/t9-here", T10: "claude/t10-gone" };
  const wt = {};
  for (const [id, branch] of Object.entries(branches)) {
    wt[id] = w.add(id.toLowerCase(), branch);
    w.ok(["task", id, "set", "state=briefed", `branch=${branch}`]);
  }
  // T5 names its branch only in a run, so the run's branch matches it.
  wt.T5 = w.add("t5", "claude/t5-run");
  w.ok(["task", "T5", "set", "state=briefed"]);
  w.ok(["task", "T5", "set", "state=building"]);
  w.ok(["run", "add", "T5", "--role", "implementer", "--branch", "claude/t5-run"]);
  // T1: squash-merged; its remote branch is gone, and only the ledger's verdict on its head covers its commit.
  const one = w.commit(wt.T1, "one.txt");
  git(wt.T1, "push", "-q", "origin", "claude/t1-merged");
  git(project, "push", "-q", "origin", "--delete", "claude/t1-merged");
  w.ok(["verdict", "T1", "--sha", one, "--kind", "checks-pass", "--pr", "1"]);
  // T2: a commit after its reviewed head was never pushed.
  w.ok(["verdict", "T2", "--sha", w.commit(wt.T2, "two.txt"), "--kind", "checks-pass", "--pr", "2"]);
  w.commit(wt.T2, "late.txt");
  // T3: abandoned; a remote-tracking ref holds its commit.
  w.commit(wt.T3, "three.txt");
  git(wt.T3, "push", "-q", "origin", "claude/t3-abandoned");
  w.ok(["task", "T4", "set", "state=building"]);
  writeFileSync(join(wt.T6, "README.md"), "changed");
  writeFileSync(join(wt.T7, "new.txt"), "new");
  git(project, "worktree", "lock", wt.T8);
  rmSync(wt.T10, { recursive: true });
  for (const id of ["T1", "T2", "T6", "T7", "T8", "T9", "T10"]) w.cell(id, "state", "merged");
  for (const id of ["T3", "T5"]) w.cell(id, "state", "abandoned");
  const unknown = w.add("unknown", "feature/x");
  w.commit(unknown, "x.txt");
  w.add("old", "old/done", first); // behind origin/main, with no commit of its own
  w.add("detached", null);

  const main = git(project, "rev-parse", "origin/main");
  const head = `origin/main is ${main.slice(0, 7)} (${git(project, "log", "-1", "--format=%cs", main)}), the local copy: this command does not fetch.`;
  const rows = (text) => text.split("\n").slice(1, -1).sort();
  const listing = w.ok(["worktrees"], wt.T9);
  t.diagnostic(`sage worktrees\n${listing}`); // the listing, for a reader of the test's output
  assert.equal(listing.split("\n")[0], head);
  assert.deepEqual(rows(listing), [
    "<base>/project · main · - · - · branch merged · primary checkout",
    "<base>/wt/detached · detached " + main.slice(0, 7) + " · - · - · unknown",
    "<base>/wt/old · old/done · - · - · branch merged",
    "<base>/wt/t1 · claude/t1-merged · T1 · merged · merged",
    "<base>/wt/t10 · claude/t10-gone · T10 · merged · merged · folder gone",
    "<base>/wt/t2 · claude/t2-unpushed · T2 · merged · merged",
    "<base>/wt/t3 · claude/t3-abandoned · T3 · abandoned · abandoned",
    "<base>/wt/t4 · claude/t4-open · T4 · building · open",
    "<base>/wt/t5 · claude/t5-run · T5 · abandoned · abandoned",
    "<base>/wt/t6 · claude/t6-changed · T6 · merged · merged",
    "<base>/wt/t7 · claude/t7-untracked · T7 · merged · merged",
    "<base>/wt/t8 · claude/t8-locked · T8 · merged · merged · locked",
    "<base>/wt/t9 · claude/t9-here · T9 · merged · merged · this worktree",
    "<base>/wt/unknown · feature/x · - · - · unknown",
  ]);
  assert.equal(listing.split("\n").at(-1), "14 worktrees: 7 merged, 2 abandoned, 2 branch merged, 1 open, 2 unknown. 7 can go when clean, and 1 entries have no folder. To remove them: sage worktrees prune --yes. It removes each clean one, prints each path that it removes or keeps, and deletes no branch.");
  assert.equal(w.ok(["worktrees"], wt.T9), listing, "the listing changes nothing");

  // The prune needs its flag, and takes no other words.
  assert.match(w.no(["worktrees", "prune"], wt.T9), /worktrees prune removes worktrees, so it needs --yes: run sage worktrees first/);
  assert.match(w.no(["worktrees", "--yes"], wt.T9), /^sage: worktrees takes no --yes\./);
  assert.match(w.no(["worktrees", "all"], wt.T9), /^sage: worktrees takes no words, or prune --yes/);
  assert.equal(w.ok(["worktrees"], wt.T9), listing, "a refused prune changes nothing");

  const pruned = w.ok(["worktrees", "prune", "--yes"], wt.T9);
  t.diagnostic(`sage worktrees prune --yes\n${pruned}`);
  assert.equal(pruned.split("\n")[0], head);
  assert.deepEqual(rows(pruned), [
    "kept <base>/project · the primary checkout",
    "kept <base>/wt/detached · unknown: it has no branch, so no task matches it",
    "kept <base>/wt/t2 · 1 unpushed commit",
    "kept <base>/wt/t4 · open: T4 is building",
    "kept <base>/wt/t6 · uncommitted changes",
    "kept <base>/wt/t7 · untracked files",
    "kept <base>/wt/t8 · locked",
    "kept <base>/wt/t9 · the worktree that this command runs in",
    "kept <base>/wt/unknown · unknown: no task of the logbook names its branch, and the branch is not in origin/main",
    "pruned the entry of <base>/wt/t10 · its folder is gone",
    "removed <base>/wt/old · branch merged",
    "removed <base>/wt/t1 · merged",
    "removed <base>/wt/t3 · abandoned",
    "removed <base>/wt/t5 · abandoned",
  ]);
  assert.equal(pruned.split("\n").at(-1), "Removed 4, kept 9, pruned 1 entries with no folder. No branch was deleted.");
  assert.deepEqual(["old", "t1", "t3", "t5"].map((n) => existsSync(join(base, "wt", n))), [false, false, false, false]);
  assert.deepEqual(["t2", "t4", "t6", "t7", "t8", "t9", "unknown", "detached"].map((n) => existsSync(join(base, "wt", n))), Array(8).fill(true));
  assert.equal(readFileSync(join(wt.T6, "README.md"), "utf8"), "changed");
  assert.equal(git(project, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 9);
  for (const branch of [...Object.values(branches), "claude/t5-run", "old/done", "feature/x"]) assert.equal(git(project, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).length, 40, `${branch} stays`);
  // A second prune from the primary checkout finds nothing more that may go, except the worktree that the first one ran in.
  const again = w.ok(["worktrees", "prune", "--yes"]);
  assert.deepEqual(again.split("\n").filter((l) => l.startsWith("removed")), ["removed <base>/wt/t9 · merged"]);
});

test("T927: worktrees refuses a project that is not a git repository", (t) => {
  const w = world(t);
  rmSync(join(w.project, ".git"), { recursive: true });
  w.ok(["init"]);
  assert.equal(w.no(["worktrees"]), "sage: <base>/project is not a git repository, so it has no worktrees. Nothing changed.");
});

test("T927: with no origin/main, no branch reads as merged, and an unknown branch stays", (t) => {
  const w = world(t);
  w.commit(w.project, "README.md");
  w.ok(["init"]);
  w.add("side", "side/x");
  const listing = w.ok(["worktrees"]).split("\n");
  assert.equal(listing[0], "This repository has no origin/main, so no branch reads as merged.");
  assert.deepEqual(listing.slice(1, -1), ["<base>/project · main · - · - · unknown · primary checkout", "<base>/wt/side · side/x · - · - · unknown"]);
  assert.deepEqual(w.ok(["worktrees", "prune", "--yes"]).split("\n").slice(1), [
    "kept <base>/project · the primary checkout",
    "kept <base>/wt/side · unknown: no task of the logbook names its branch, and the branch is not in origin/main",
    "Removed 0, kept 2, pruned 0 entries with no folder. No branch was deleted.",
  ]);
});

test("T927: the prune keeps a worktree that holds another worktree in an ignored folder, which git would delete with it", (t) => {
  const w = world(t);
  w.commit(w.project, "README.md");
  writeFileSync(join(w.project, ".gitignore"), ".nest/\n");
  git(w.project, "add", ".gitignore");
  git(w.project, "commit", "-q", "-m", "ignore");
  git(w.project, "push", "-q", "-u", "origin", "main");
  w.ok(["init"]);
  w.ok(["task", "add", "--title", "outer", "--size", "small", "--priority", "P2"]);
  w.ok(["task", "T1", "set", "state=briefed", "branch=claude/t1-outer"]);
  w.cell("T1", "state", "merged");
  const outer = w.add("outer", "claude/t1-outer"), inner = join(outer, ".nest", "inner");
  git(w.project, "worktree", "add", "-q", "--detach", inner, "main");
  writeFileSync(join(inner, "work.txt"), "not committed");
  assert.equal(git(outer, "status", "--porcelain", "--untracked-files=all"), "", "git sees the outer worktree as clean");
  assert.deepEqual(w.ok(["worktrees", "prune", "--yes"]).split("\n").slice(1).sort(), [
    "Removed 0, kept 3, pruned 0 entries with no folder. No branch was deleted.",
    "kept <base>/project · the primary checkout",
    "kept <base>/wt/outer · another worktree is inside it: <base>/wt/outer/.nest/inner",
    "kept <base>/wt/outer/.nest/inner · unknown: it has no branch, so no task matches it",
  ]);
  assert.equal(readFileSync(join(inner, "work.txt"), "utf8"), "not committed");
});
