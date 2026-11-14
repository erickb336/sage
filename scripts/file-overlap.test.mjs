import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";

const TOOL = fileURLToPath(new URL("../plugins/sage/skills/sage/sage.mjs", import.meta.url));
const CLAUDE_HOOK = fileURLToPath(new URL("../plugins/sage/hooks/sage-hook.mjs", import.meta.url));
const CODEX_DISPATCH = new URL("../plugins/sage-codex/hooks/dispatch.mjs", import.meta.url).href;
const HOSTILE = ["a b.txt", "q\"uote's.txt", "new\nline.txt", "-dash.txt", "--option.txt"];

function fixture(t) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "sage-file-overlap-")));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const project = join(temp, "project"), home = join(temp, "home");
  mkdirSync(project);
  mkdirSync(home);
  const env = { ...process.env, HOME: home, SAGE_HOME: join(temp, "sage"), SAGE_HOOKS_STATE: join(temp, "hooks"), CLAUDE_CONFIG_DIR: join(temp, "claude"), CODEX_HOME: join(temp, "codex"), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const git = (...args) => execFileSync("git", ["-C", project, ...args], { env, encoding: "utf8" }).trim();
  const commit = (files) => {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(project, name), text);
    git("add", "-A");
    git("commit", "-q", "-m", "change");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  commit({ "README.md": "start\n" });
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  const run = (...args) => spawnSync(process.execPath, [TOOL, ...args, "--project", project], { env, encoding: "utf8", timeout: 60_000 });
  const ok = (...args) => { const out = run(...args); assert.equal(out.status, 0, out.stderr); return out.stdout.trim(); };
  const dir = ok("init").replace(/^logbook /, "");
  ok("task", "add", "--priority", "P2", "--title", "Sample task", "--size", "small");
  const records = () => JSON.parse(readFileSync(join(dir, "observations.json"), "utf8")).records;
  const hook = (command) => spawnSync(process.execPath, [CLAUDE_HOOK], { env, input: JSON.stringify({ hook_event_name: "PostToolUse", session_id: "s1", cwd: project, tool_name: "Bash", tool_input: { command }, tool_response: { stdout: "" } }), encoding: "utf8", timeout: 60_000 });
  const runner = join(temp, "codex-post.mjs");
  writeFileSync(runner, `import { readFileSync } from "node:fs"; const { dispatch } = await import(${JSON.stringify(CODEX_DISPATCH)}); const out = await dispatch("PostToolUse", JSON.parse(readFileSync(0, "utf8")), {}); process.stdout.write(JSON.stringify(out ?? null));`);
  const codex = (command) => spawnSync(process.execPath, [runner], { env, input: JSON.stringify({ hook_event_name: "PostToolUse", session_id: "s2", turn_id: "t1", cwd: project, tool_name: "Bash", tool_use_id: "c1", tool_input: { command }, tool_response: "" }), encoding: "utf8", timeout: 60_000 });
  return { env, project, dir, git, commit, run, ok, records, hook, codex };
}

test("observe <T> files records the branch's changed paths against origin/main, hostile names as data, and a newer record replaces the older", (t) => {
  const f = fixture(t);
  const none = f.run("observe", "T1", "files");
  assert.equal(none.status, 1);
  assert.match(none.stderr, /T1 has no task branch/);
  f.git("checkout", "-q", "-b", "sage/t1-files");
  const first = f.commit({ ...Object.fromEntries(HOSTILE.map((name) => [name, "x\n"])), "README.md": "changed\n" });
  f.ok("task", "T1", "set", "branch=sage/t1-files");
  assert.equal(f.ok("observe", "T1", "files"), "O1 observed files for T1");
  const [record] = f.records();
  assert.deepEqual({ kind: record.kind, task: record.task, basis: record.basis, head: record.data.head, truncated: record.data.truncated }, { kind: "files", task: "T1", basis: "observed", head: first, truncated: false });
  assert.deepEqual([...record.data.paths].sort(), [...HOSTILE, "README.md"].sort());

  f.ok("observe", "T1", "--kind", "pr", "--source", "sample-api", "--basis", "observed", "--observed-at", "2026-01-01T00:00:00Z", "--data-hex", Buffer.from(JSON.stringify({ repository: "https://github.com/sample/project", number: 3, state: "open", head: first })).toString("hex"));
  const second = f.commit({ "later.txt": "y\n" });
  assert.equal(f.ok("observe", "T1", "files"), "O1 observed files for T1");
  const after = f.records();
  assert.deepEqual(after.map((r) => [r.id, r.kind]), [["O1", "files"], ["O2", "pr"]], "one files record for each task; other records stay");
  assert.equal(after[0].data.head, second);
  assert.ok(after[0].data.paths.includes("later.txt"));
});

test("observe <T> files keeps at most 500 paths and marks the record truncated", (t) => {
  const f = fixture(t);
  f.git("checkout", "-q", "-b", "sage/t1-many");
  f.commit(Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`file-${i}.txt`, "x\n"])));
  f.ok("task", "T1", "set", "branch=sage/t1-many");
  f.ok("observe", "T1", "files");
  const [record] = f.records();
  assert.equal(record.data.paths.length, 500);
  assert.equal(record.data.truncated, true);
});

test("a push of a task branch records its files in Claude and in Codex; a failure or a hostile branch never refuses the push event", (t) => {
  const f = fixture(t);
  f.git("checkout", "-q", "-b", "sage/t1-push");
  const first = f.commit({ "one.txt": "x\n" });
  f.ok("task", "T1", "set", "branch=sage/t1-push");
  const claude = f.hook(`git -C '${f.project}' push origin sage/t1-push`);
  assert.deepEqual([claude.status, claude.stdout], [0, ""]);
  assert.deepEqual(f.records().map((r) => [r.id, r.kind, r.data.head, r.data.paths]), [["O1", "files", first, ["one.txt"]]]);

  const second = f.commit({ "two.txt": "x\n" });
  const codex = f.codex(`git -C '${f.project}' push -u origin sage/t1-push`);
  assert.deepEqual([codex.status, codex.stdout, codex.stderr], [0, "null", ""]);
  assert.deepEqual(f.records().map((r) => [r.id, r.data.head, r.data.paths.sort()]), [["O1", second, ["one.txt", "two.txt"]]]);

  const before = readFileSync(join(f.dir, "observations.json"), "utf8");
  for (const branch of ["'-x'", "'a b'", `'q"b'`, "$'a\\nb'", "HEAD", "'--delete'"]) {
    const command = `git -C '${f.project}' push origin ${branch}`;
    assert.deepEqual([f.hook(command).status, f.hook(command).stdout], [0, ""], branch);
    assert.deepEqual([f.codex(command).status, f.codex(command).stdout], [0, "null"], branch);
  }
  f.git("update-ref", "-d", "refs/remotes/origin/main");
  f.commit({ "three.txt": "x\n" });
  assert.deepEqual([f.hook(`git -C '${f.project}' push origin sage/t1-push`).stdout, f.codex(`git -C '${f.project}' push origin sage/t1-push`).stdout], ["", "null"], "no origin/main: the observation fails, and the push event goes on");
  assert.equal(readFileSync(join(f.dir, "observations.json"), "utf8"), before);
});

test("a push from a linked worktree of the task's branch records its files", (t) => {
  const f = fixture(t);
  const tree = join(f.project, "..", "tree with space");
  f.git("worktree", "add", "-q", "-b", "sage/t1-tree", tree);
  writeFileSync(join(tree, "tree.txt"), "x\n");
  execFileSync("git", ["-C", tree, "add", "-A"], { env: f.env });
  execFileSync("git", ["-C", tree, "commit", "-q", "-m", "tree"], { env: f.env });
  f.ok("task", "T1", "set", "branch=sage/t1-tree");
  assert.equal(f.hook(`git -C '${tree}' push -u origin sage/t1-tree`).status, 0);
  assert.deepEqual(f.records().map((r) => [r.kind, r.data.paths]), [["files", ["tree.txt"]]]);
});

const NOW = "2026-11-13T12:00:00.000Z";
const files = (task, paths, at = NOW) => ({ id: "O1", task, kind: "files", source: "git diff origin/main", basis: "observed", observedAt: at, recordedAt: at, data: { head: "a".repeat(40), paths, truncated: false } });
const card = (id, chief, state = "building") => ({ id, title: "Sample", size: "small", risk: "", route: "build,code-review,qa", state, branch: `sage/${id.toLowerCase()}`, pr: "", round: "0", keys: "", chief });
const project = (key, tasks, records) => ({ key, name: key.split("/")[1], shared: true, chiefs: [{ id: "C1", provider: "claude" }, { id: "C2", provider: "codex" }], diagnostics: [], tables: { tasks }, observations: { version: 1, records } });

test("the board model flags may conflict for open tasks of different chiefs that share a path, and not for the same chief or for ended tasks", () => {
  const tasks = [card("T1", "C1"), card("T2", "C2", "reviewing"), card("T3", "C1"), card("T4", "C2", "merged"), card("T5", "C2"), card("T6", "C2")];
  const records = [files("T1", ["src/a.mjs", "docs/b c.md", "-x"]), files("T2", ["docs/b c.md", "z"]), files("T3", ["src/a.mjs"]), files("T4", ["src/a.mjs"]), files("T6", ["src/a.mjs", "old.txt"], "2026-11-13T10:00:00.000Z"), files("T6", ["z2"])];
  const other = project("one/other-abcdef", [card("T7", "C2")], [files("T7", ["src/a.mjs"])]);
  const model = buildBoardModel([{ id: "one", label: "one", diagnostics: [], projects: [project("one/sample-abcdef", tasks, records), other] }], { now: NOW });
  const flags = Object.fromEntries(model.tasks.map((task) => [`${task.project}/${task.id}`, task.mayConflict.map(({ id, chief, paths }) => [id, chief, paths])]));
  assert.deepEqual(flags, {
    "one/sample-abcdef/T1": [["T2", "Codex · C2", ["docs/b c.md"]]],
    "one/sample-abcdef/T2": [["T1", "Claude · C1", ["docs/b c.md"]]],
    "one/sample-abcdef/T3": [],
    "one/sample-abcdef/T4": [],
    "one/sample-abcdef/T5": [],
    "one/sample-abcdef/T6": [],
    "one/other-abcdef/T7": [],
  });
  assert.deepEqual(model.tasks.find((task) => task.id === "T6").changedFiles.paths, ["z2"], "the newer files record counts");
  assert.equal(model.tasks.find((task) => task.id === "T5").changedFiles, null);
});
