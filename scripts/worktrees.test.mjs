// T927: sage worktrees lists the worktrees of the project's repository with the task of each, and worktrees prune --yes
// removes only the clean ones of a merged or abandoned task, or of a branch in origin/main. Every repository, logbook and
// home folder here is a scratch folder: SAGE_HOME and HOME never leave it.
import "./test-env.mjs"; // first: no variable of the developer's shell changes a result
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { worktrees } from "../packages/sage-core/worktrees.mjs";

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
  /** Sets one cell of a task's row, as a later state of the task would (a merge marks a task merged). */
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
  w.add("old", "old/done", first); // behind origin/main, with no commit of its own: a run may have just started on it (T937)
  w.add("detached", null);

  const main = git(project, "rev-parse", "origin/main");
  const head = `origin/main is ${main.slice(0, 7)} (${git(project, "log", "-1", "--format=%cs", main)}), the local copy: this command does not fetch.`;
  const rows = (text) => text.split("\n").slice(1, -1).sort();
  const listing = w.ok(["worktrees"], wt.T9);
  t.diagnostic(`sage worktrees\n${listing}`); // the listing, for a reader of the test's output
  assert.equal(listing.split("\n")[0], head);
  assert.deepEqual(rows(listing), [
    "<base>/project · main · - · - · unknown · primary checkout",
    "<base>/wt/detached · detached " + main.slice(0, 7) + " · - · - · unknown",
    "<base>/wt/old · old/done · - · - · unknown",
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
  assert.equal(listing.split("\n").at(-1), "14 worktrees: 7 merged, 0 concluded, 2 abandoned, 0 branch merged, 1 open, 4 unknown. 6 can go when clean, and 1 entries have no folder. To remove them: sage worktrees prune --yes. It removes each clean one, prints each path that it removes or keeps, and deletes no branch.");
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
    "kept <base>/wt/old · unknown: no task of the logbook names its branch, and the branch adds no commit to origin/main, so a run may have just started on it",
    "kept <base>/wt/t2 · 1 unpushed commit",
    "kept <base>/wt/t4 · open: T4 is building, so its work may still need this folder",
    "kept <base>/wt/t6 · uncommitted changes",
    "kept <base>/wt/t7 · untracked files",
    "kept <base>/wt/t8 · locked",
    "kept <base>/wt/t9 · the worktree that this command runs in",
    "kept <base>/wt/unknown · unknown: no task of the logbook names its branch, and the branch is not in origin/main",
    "pruned the entry of <base>/wt/t10 · its folder is gone",
    "removed <base>/wt/t1 · merged",
    "removed <base>/wt/t3 · abandoned",
    "removed <base>/wt/t5 · abandoned",
  ]);
  assert.equal(pruned.split("\n").at(-1), "Removed 3, kept 10, pruned 1 entries with no folder. No branch was deleted.");
  assert.deepEqual(["t1", "t3", "t5"].map((n) => existsSync(join(base, "wt", n))), [false, false, false]);
  assert.deepEqual(["old", "t2", "t4", "t6", "t7", "t8", "t9", "unknown", "detached"].map((n) => existsSync(join(base, "wt", n))), Array(9).fill(true));
  assert.equal(readFileSync(join(wt.T6, "README.md"), "utf8"), "changed");
  assert.equal(git(project, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 10);
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

test("T937: the prune removes a clean worktree of a concluded task and of a branch that a merge brought into origin/main; it keeps a fresh branch at the tip and a worktree with ignored files", (t) => {
  const w = world(t), { base, project } = w;
  writeFileSync(join(project, ".gitignore"), ".env\n*.log\nnode_modules/\n");
  git(project, "add", ".gitignore");
  git(project, "commit", "-q", "-m", "ignore");
  w.ok(["init"]);
  for (let k = 1; k <= 3; k++) w.ok(["task", "add", "--title", `task ${k}`, "--size", "small", "--priority", "P2"]);
  const wt = {};
  for (const [id, branch] of [["T1", "claude/t1-concluded"], ["T2", "claude/t2-env"], ["T3", "claude/t3-logs"]]) {
    wt[id] = w.add(id.toLowerCase(), branch);
    w.ok(["task", id, "set", "state=briefed", `branch=${branch}`]);
  }
  w.cell("T1", "state", "concluded");
  for (const id of ["T2", "T3"]) w.cell(id, "state", "merged");
  // T1 also has an ignored folder that a build makes again: it does not keep the worktree.
  mkdirSync(join(wt.T1, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(wt.T1, "node_modules", "pkg", "index.js"), "built");
  writeFileSync(join(wt.T2, ".env"), "TOKEN=local");
  for (const name of [".env", "a.log", "b.log", "c.log"]) writeFileSync(join(wt.T3, name), name);
  // A branch with its own commit, merged into main with a merge commit.
  const merged = w.add("merged", "feature/merged");
  w.commit(merged, "feature.txt");
  git(project, "merge", "-q", "--no-ff", "-m", "merge feature", "feature/merged");
  git(project, "push", "-q", "-u", "origin", "main");
  const fresh = w.add("fresh", "feature/fresh", "origin/main"); // a run that just started at the tip, before its first edit
  assert.equal(git(fresh, "rev-parse", "HEAD"), git(project, "rev-parse", "origin/main"));

  const listing = w.ok(["worktrees"]).split("\n");
  t.diagnostic(`sage worktrees\n${listing.join("\n")}`);
  assert.deepEqual(listing.slice(1, -1).sort(), [
    "<base>/project · main · - · - · unknown · primary checkout",
    "<base>/wt/fresh · feature/fresh · - · - · unknown",
    "<base>/wt/merged · feature/merged · - · - · branch merged",
    "<base>/wt/t1 · claude/t1-concluded · T1 · concluded · concluded",
    "<base>/wt/t2 · claude/t2-env · T2 · merged · merged",
    "<base>/wt/t3 · claude/t3-logs · T3 · merged · merged",
  ]);
  assert.match(listing.at(-1), /^6 worktrees: 2 merged, 1 concluded, 0 abandoned, 1 branch merged, 0 open, 2 unknown\. 4 can go when clean,/);

  const pruned = w.ok(["worktrees", "prune", "--yes"]);
  t.diagnostic(`sage worktrees prune --yes\n${pruned}`);
  assert.deepEqual(pruned.split("\n").slice(1).sort(), [
    "Removed 2, kept 4, pruned 0 entries with no folder. No branch was deleted.",
    "kept <base>/project · the primary checkout",
    "kept <base>/wt/fresh · unknown: no task of the logbook names its branch, and the branch adds no commit to origin/main, so a run may have just started on it",
    "kept <base>/wt/t2 · ignored files that the prune would delete: .env",
    "kept <base>/wt/t3 · ignored files that the prune would delete: .env, a.log, b.log and 1 more",
    "removed <base>/wt/merged · branch merged",
    "removed <base>/wt/t1 · concluded · also deleted ignored node_modules/",
  ]);
  assert.deepEqual(["t1", "merged"].map((n) => existsSync(join(base, "wt", n))), [false, false]);
  assert.equal(readFileSync(join(wt.T2, ".env"), "utf8"), "TOKEN=local");
  assert.ok(existsSync(fresh));
});

test("T937: a whole ignored folder keeps the worktree, by any pattern; only node_modules and dist, folders or links, go with it, and the removed line names them", (t) => {
  const w = world(t), { base, project } = w;
  writeFileSync(join(project, ".gitignore"), ".env\nsecrets/\nbuild\nout/**\nnode_modules\ndist\n");
  git(project, "add", ".gitignore");
  git(project, "commit", "-q", "-m", "ignore");
  git(project, "push", "-q", "-u", "origin", "main");
  w.ok(["init"]);
  const names = { T1: "secrets", T2: "build", T3: "out", T4: "rebuilt", T5: "link", T6: "file" }, wt = {};
  for (const [id, name] of Object.entries(names)) {
    w.ok(["task", "add", "--title", name, "--size", "small", "--priority", "P2"]);
    wt[id] = w.add(name, `claude/${id.toLowerCase()}-${name}`);
    w.ok(["task", id, "set", "state=briefed", `branch=claude/${id.toLowerCase()}-${name}`]);
    w.cell(id, "state", "merged");
  }
  const put = (file, text = file) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, text); };
  put(join(wt.T1, "secrets", ".env"), "TOKEN=local");
  put(join(wt.T1, ".env"), "PORT=1");
  put(join(wt.T2, "build", "app.bin"));
  put(join(wt.T3, "out", "a", "report.txt"));
  put(join(wt.T4, "node_modules", "pkg", "index.js"));
  put(join(wt.T4, "dist", "app.js"));
  put(join(wt.T4, "packages", "x", "dist", "x.js"));
  const shared = join(base, "shared-modules");
  put(join(shared, "pkg", "index.js"), "shared");
  symlinkSync(shared, join(wt.T5, "node_modules"));
  // A regular file with a rebuilt name is no folder that a build makes again: it keeps the worktree (F-T937-6).
  put(join(wt.T6, "lib", "dist"), "my notes");
  put(join(wt.T6, "sub", "node_modules"), "my notes");

  const pruned = w.ok(["worktrees", "prune", "--yes"]);
  t.diagnostic(`sage worktrees prune --yes\n${pruned}`);
  assert.deepEqual(pruned.split("\n").slice(1).sort(), [
    "Removed 2, kept 5, pruned 0 entries with no folder. No branch was deleted.",
    "kept <base>/project · the primary checkout",
    "kept <base>/wt/build · ignored files that the prune would delete: build/",
    "kept <base>/wt/file · ignored files that the prune would delete: lib/dist, sub/node_modules",
    "kept <base>/wt/out · ignored files that the prune would delete: out/a/",
    "kept <base>/wt/secrets · ignored files that the prune would delete: .env, secrets/",
    "removed <base>/wt/link · merged · also deleted ignored node_modules",
    "removed <base>/wt/rebuilt · merged · also deleted ignored dist/, node_modules/, packages/x/dist/",
  ]);
  assert.equal(readFileSync(join(wt.T1, "secrets", ".env"), "utf8"), "TOKEN=local");
  assert.deepEqual([wt.T2, wt.T3].map((p) => existsSync(p)), [true, true]);
  assert.equal(readFileSync(join(wt.T6, "lib", "dist"), "utf8"), "my notes");
  assert.deepEqual([wt.T4, wt.T5].map((p) => existsSync(p)), [false, false]);
  assert.equal(readFileSync(join(shared, "pkg", "index.js"), "utf8"), "shared", "the prune deletes the link, not the folder it points to");
  assert.ok(lstatSync(shared).isDirectory());
});

test("T937: the listing and the prune read one line of git for each branch, so a main line longer than git's output buffer works (F-T937-7)", (t) => {
  const w = world(t), { base, project } = w;
  // 300 commits on main through one git fast-import: their ids alone are about 12 KiB, three times the runner's buffer.
  const stream = Array.from({ length: 300 }, (_, k) => `commit refs/heads/main\ncommitter t <t@example.com> ${1700000000 + k} +0000\ndata ${String(k).length}\n${k}\n`).join("");
  execFileSync("git", ["-C", project, "fast-import", "--quiet"], { input: stream, env: gitEnv });
  const side = w.add("side", "feature/side");
  w.commit(side, "side.txt");
  const merged = w.add("merged", "feature/merged");
  w.commit(merged, "merged.txt");
  git(project, "merge", "-q", "--no-ff", "-m", "merge feature", "feature/merged");
  git(project, "update-ref", "refs/remotes/origin/main", "main");
  w.add("tip", "feature/tip", "origin/main");
  w.add("back", "feature/back", "origin/main~150"); // on the main line, 150 commits back: a run may have just started there
  // The state tool's runner, with a 4 KiB buffer in place of Node's 1 MiB: the reads must stay small for any history.
  const runner = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 4096, env: gitEnv, stdio: ["ignore", "pipe", "pipe"] });
  const call = (prune, run = runner) => worktrees({ git: run, root: project, tasks: [], runs: [], ledger: [], here: [project], prune }).replaceAll(base, "<base>").split("\n").slice(1);
  const fresh = "unknown: no task of the logbook names its branch, and the branch adds no commit to origin/main, so a run may have just started on it";

  assert.deepEqual(call(false).slice(0, -1).sort(), [
    "<base>/project · main · - · - · unknown · primary checkout",
    "<base>/wt/back · feature/back · - · - · unknown",
    "<base>/wt/merged · feature/merged · - · - · branch merged",
    "<base>/wt/side · feature/side · - · - · unknown",
    "<base>/wt/tip · feature/tip · - · - · unknown",
  ]);
  // A check that git cannot answer keeps the worktree and names git's reason.
  for (const step of [(args) => args.includes("--count") && !args.includes("--not"), (args) => args.some((a) => /~\d+\^\{commit\}$/.test(a))]) {
    const failing = (args) => { if (step(args)) throw Object.assign(new Error("git failed"), { stderr: "fatal: a test failure\n" }); return runner(args); };
    assert.deepEqual(call(true, failing).sort(), [
      "Removed 0, kept 5, pruned 0 entries with no folder. No branch was deleted.",
      "kept <base>/project · the primary checkout",
      "kept <base>/wt/back · unknown: no task of the logbook names its branch, and git could not check it against origin/main: fatal: a test failure",
      "kept <base>/wt/merged · unknown: no task of the logbook names its branch, and git could not check it against origin/main: fatal: a test failure",
      "kept <base>/wt/side · unknown: no task of the logbook names its branch, and the branch is not in origin/main",
      "kept <base>/wt/tip · unknown: no task of the logbook names its branch, and git could not check it against origin/main: fatal: a test failure",
    ]);
  }
  assert.deepEqual(call(true).sort(), [
    "Removed 1, kept 4, pruned 0 entries with no folder. No branch was deleted.",
    "kept <base>/project · the primary checkout",
    `kept <base>/wt/back · ${fresh}`,
    "kept <base>/wt/side · unknown: no task of the logbook names its branch, and the branch is not in origin/main",
    `kept <base>/wt/tip · ${fresh}`,
    "removed <base>/wt/merged · branch merged",
  ]);
  assert.deepEqual(["back", "side", "tip", "merged"].map((n) => existsSync(join(base, "wt", n))), [true, true, true, false]);
});
