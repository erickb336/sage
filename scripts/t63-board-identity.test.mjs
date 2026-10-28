import "./test-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { readBoardSources } from "../packages/sage-core/board-reader.mjs";
import { createBoardConfig } from "../packages/sage-board/cli.mjs";
import { createStateTool } from "../packages/sage-core/index.mjs";

const HEADERS = {
  tasks: "id title size risk route state branch pr round keys",
  runs: "id task role round candidate branch status tokens report started ended",
  findings: "task key round source severity summary triage reason status",
  ledger: "task pr sha kind cycle run at",
  gates: "id task question options recommendation default answer at",
  decisions: "at task decision why",
};
function store(root, key, title, checkout) {
  const book = join(root, key);
  mkdirSync(book, { recursive: true });
  for (const [table, header] of Object.entries(HEADERS)) {
    const row = table === "tasks" ? `T1\t${title}\tsmall\t\tbuild,qa\tframed\t\t\t0\t\n` : "";
    writeFileSync(join(book, `${table}.tsv`), `${header.replaceAll(" ", "\t")}\n${row}`);
  }
  if (checkout) writeFileSync(join(book, "checkout.txt"), `${checkout}\n`);
  writeFileSync(join(root, "projects.made"), "");
}
function snapshot(path) {
  return Object.fromEntries(readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const file = join(path, entry.name);
    return entry.isDirectory() ? Object.entries(snapshot(file)).map(([name, value]) => [`${entry.name}/${name}`, value]) : [[entry.name, readFileSync(file).toString("hex")]];
  }));
}
function fixture(t) {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "sage-t63-sample-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const project = join(base, "current", "same"), foreign = join(base, "foreign", "same");
  mkdirSync(project, { recursive: true }); mkdirSync(foreign, { recursive: true });
  for (const path of [project, foreign]) execFileSync("git", ["init", "-q", path]);
  const root = join(base, "one"), second = join(base, "two");
  const key = path => `${basename(path)}-${createHash("sha1").update(path).digest("hex").slice(0, 6)}`;
  const tool = createStateTool({ defaultRoot: () => root });
  return { project, foreign, root, second, key, tool };
}

test("T63 GROUP: a project rich view does not expand to a same-key foreign checkout", t => {
  const f = fixture(t), key = f.key(f.project);
  store(f.root, key, "Sample assigned legacy task", null);
  store(f.second, key, "Sample foreign checkout task", f.foreign);
  const before = [snapshot(f.root), snapshot(f.second)];
  const env = { ...process.env, SAGE_HOME: f.root, SAGE_BOARD_ROOTS: JSON.stringify([{ id: "first", path: f.root }, { id: "second", path: f.second }]) };
  const global = f.tool.sage(["board", "all", "--view", "chat", "--project", f.project], env);
  const output = f.tool.sage(["board", "this", "--view", "chat", "--project", f.project], env);
  assert.deepEqual([snapshot(f.root), snapshot(f.second)], before);
  assert.match(global, /Sample foreign checkout task/);
  assert.doesNotMatch(output, /Sample foreign checkout task/);
});

test("T63 LEGACY: a same-named foreign legacy book is not the current project", t => {
  const f = fixture(t);
  store(f.root, f.key(f.foreign), "Sample foreign legacy task", null);
  const before = snapshot(f.root);
  const env = { ...process.env, SAGE_HOME: f.root };
  const global = f.tool.sage(["board", "all", "--remember", "no", "--project", f.project], env);
  const output = f.tool.sage(["board", "this", "--remember", "no", "--project", f.project], env);
  assert.deepEqual(snapshot(f.root), before);
  assert.match(global, /Sample foreign legacy task/);
  assert.doesNotMatch(output, /Sample foreign legacy task/);
});

test("T63 COLLISION: a foreign legacy book can have the current project's assigned folder", t => {
  const f = fixture(t), base = join(f.project, "..");
  const hashes = new Map();
  let current, foreign, key;
  for (let i = 0; i < 100000; i++) {
    const path = join(base, `clone-${i}`, "same"), candidate = f.key(path);
    if (hashes.has(candidate)) { current = hashes.get(candidate); foreign = path; key = candidate; break; }
    hashes.set(candidate, path);
  }
  assert.ok(current && foreign, "the sample must contain two paths with one short hash");
  mkdirSync(current, { recursive: true }); mkdirSync(foreign, { recursive: true });
  for (const path of [current, foreign]) execFileSync("git", ["init", "-q", path]);
  store(f.root, key, "Sample foreign collision task", null);
  const before = snapshot(f.root), env = { ...process.env, SAGE_HOME: f.root };
  const global = f.tool.sage(["board", "all", "--remember", "no", "--project", current], env);
  const output = f.tool.sage(["board", "this", "--remember", "no", "--project", current], env);
  assert.deepEqual(snapshot(f.root), before);
  assert.match(global, /Sample foreign collision task/);
  assert.doesNotMatch(output, /Sample foreign collision task/);
});

test("T63 GROUPING: an unknown checkout never joins a verified checkout", t => {
  const f = fixture(t), key = f.key(f.project);
  store(f.root, key, "Sample current task", f.project);
  store(f.second, key, "Sample unassigned task", null);
  const sources = [{ id: "claude", path: f.root }, { id: "codex", path: f.second }];
  const before = [snapshot(f.root), snapshot(f.second)];
  const model = buildBoardModel(readBoardSources(sources));
  assert.equal(model.projects.length, 2);
  assert.notEqual(model.tasks[0].group, model.tasks[1].group);
  assert.deepEqual([snapshot(f.root), snapshot(f.second)], before);
});

test("T63 SOURCES: verified books stay together and a same-key foreign checkout stays apart", t => {
  const f = fixture(t), key = f.key(f.project), third = join(f.root, "..", "three"), fourth = join(f.root, "..", "four");
  store(f.root, key, "Sample first task", f.project);
  store(f.second, key, "Sample second task", f.project);
  store(third, key, "Sample foreign task", f.foreign);
  store(fourth, key, "Sample unassigned task", null);
  const roots = [f.root, f.second, third, fourth];
  const sources = roots.map((path, i) => ({ id: `source${i}`, path }));
  const before = roots.map(snapshot), env = { ...process.env, SAGE_HOME: f.root, SAGE_BOARD_ROOTS: JSON.stringify(sources) };
  const global = f.tool.sage(["board", "all", "--view", "chat", "--project", f.project], env);
  const current = f.tool.sage(["board", "this", "--view", "chat", "--project", f.project], env);
  assert.match(current, /Sample first task/); assert.match(current, /Sample second task/);
  assert.doesNotMatch(current, /Sample (foreign|unassigned) task/);
  assert.match(global, /Sample foreign task/); assert.match(global, /Sample unassigned task/);
  const model = buildBoardModel(readBoardSources(sources));
  assert.equal(model.projects.length, 3);
  assert.deepEqual(model.projects.find(project => project.books.includes(`source0/${key}`)).books, [`source0/${key}`, `source1/${key}`]);
  assert.deepEqual(roots.map(snapshot), before);
});

for (const provider of ["sage", "sage-codex"]) {
  for (const location of ["checkout", "subdirectory", "worktree", "plain folder"]) {
    test(`T63 ${provider}: ${location} shows only verified current records`, t => {
      const f = fixture(t), key = f.key(f.project), same = join(f.project, "child"), linked = join(f.project, "..", "linked");
      mkdirSync(same);
      execFileSync("git", ["-C", f.project, "-c", "user.name=Sample", "-c", "user.email=sample@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "sample"]);
      execFileSync("git", ["-C", f.project, "worktree", "add", "-q", "-b", "sample", linked]);
      const project = location === "plain folder" ? join(f.project, "..", "plain") : f.project;
      if (location === "plain folder") mkdirSync(project);
      const at = location === "subdirectory" ? same : location === "worktree" ? linked : project;
      const assigned = f.key(project);
      store(f.root, assigned, "Sample current task", project);
      store(f.second, assigned, "Sample unassigned task", null);
      store(f.second, key === assigned ? f.key(f.foreign) : key, "Sample foreign task", f.foreign);
      const before = [snapshot(f.root), snapshot(f.second)];
      const cli = fileURLToPath(new URL(`../plugins/${provider}/skills/sage/sage.mjs`, import.meta.url));
      const env = { ...process.env, SAGE_HOME: f.root, SAGE_BOARD_ROOTS: JSON.stringify([{ id: "claude", path: f.root }, { id: "codex", path: f.second }]) };
      const run = (...args) => execFileSync(process.execPath, [cli, "board", ...args, "--project", at], { encoding: "utf8", env });
      const rich = run("this", "--view", "chat"), global = run("all", "--view", "chat");
      assert.match(rich, /Sample current task/);
      assert.doesNotMatch(rich, /Sample (unassigned|foreign) task/);
      assert.match(global, /Sample (unassigned|foreign) task/);
      assert.match(global, /Sample unassigned task/); assert.match(global, /Sample foreign task/);
      const ordinaryEnv = { ...env }; delete ordinaryEnv.SAGE_BOARD_ROOTS;
      const ordinary = execFileSync(process.execPath, [cli, "board", "this", "--remember", "no", "--project", at], { encoding: "utf8", env: ordinaryEnv });
      assert.match(ordinary, /Sample current task/);
      assert.deepEqual([snapshot(f.root), snapshot(f.second)], before);
    });
  }
}

test("T63 MISSING: project views do not fall back to the global board", t => {
  const f = fixture(t), key = f.key(f.foreign);
  store(f.root, key, "Sample foreign task", f.foreign);
  store(f.second, f.key(f.project), "Sample unassigned task", null);
  const before = [snapshot(f.root), snapshot(f.second)];
  const env = { ...process.env, SAGE_HOME: f.root, SAGE_BOARD_ROOTS: JSON.stringify([{ id: "first", path: f.root }, { id: "second", path: f.second }]) };
  const rich = f.tool.sage(["board", "this", "--view", "chat", "--project", f.project], env);
  assert.doesNotMatch(rich, /Sample (foreign|unassigned) task/);
  const normal = f.tool.sage(["board", "this", "--remember", "no", "--project", f.project], env);
  assert.doesNotMatch(normal, /Sample (foreign|unassigned) task/);
  assert.deepEqual([snapshot(f.root), snapshot(f.second)], before);
});

test("T63 NAMED: a name, short key or exact source key cannot assign an unknown checkout", t => {
  const f = fixture(t), legacy = f.key(f.foreign);
  store(f.root, legacy, "Sample unassigned task", null);
  const env = { ...process.env, SAGE_HOME: f.root, SAGE_BOARD_ROOTS: JSON.stringify([{ id: "first", path: f.root }]) };
  const before = snapshot(f.root);
  assert.match(f.tool.sage(["board", "all", "--view", "chat", "--project", f.project], env), /Sample unassigned task/);
  assert.equal(f.tool.sage(["board", "same", "--remember", "no", "--project", f.project], env), 'No project named "same". Known projects: none.');
  for (const scope of ["same", legacy, `first/${legacy}`]) {
    assert.throws(() => f.tool.sage(["board", scope, "--view", "chat", "--project", f.project], env), /No recorded project matches/);
    assert.doesNotMatch(f.tool.sage(["board", scope, "--remember", "no", "--project", f.project], env), /Sample unassigned task/);
  }
  assert.deepEqual(snapshot(f.root), before);
});

test("T63 TASK: an assigned folder cannot prove a legacy task's checkout", t => {
  const f = fixture(t), key = f.key(f.project);
  store(f.root, key, "Sample unassigned task", null);
  const env = { ...process.env, SAGE_HOME: f.root }, before = snapshot(f.root);
  assert.match(f.tool.sage(["board", "all", "--view", "chat", "--project", f.project], env), /Sample unassigned task/);
  assert.throws(() => f.tool.sage(["board", "T1", "--view", "task", "--project", f.project], env), /No recorded logbook matches/);
  assert.deepEqual(snapshot(f.root), before);
});

test("T63 STANDALONE: a subdirectory and worktree select their verified project", t => {
  const f = fixture(t), child = join(f.project, "child"), linked = join(f.project, "..", "linked"), key = f.key(f.project);
  mkdirSync(child);
  execFileSync("git", ["-C", f.project, "-c", "user.name=Sample", "-c", "user.email=sample@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "sample"]);
  execFileSync("git", ["-C", f.project, "worktree", "add", "-q", "-b", "sample", linked]);
  store(f.root, key, "Sample current task", f.project);
  store(f.second, key, "Sample unassigned task", null);
  const config = join(f.project, "..", "board.json");
  createBoardConfig(config, { sources: [{ id: "first", path: f.root }, { id: "second", path: f.second }] });
  const before = [snapshot(f.root), snapshot(f.second)], cli = fileURLToPath(new URL("../packages/sage-board/cli.mjs", import.meta.url));
  for (const location of [child, linked]) {
    const out = execFileSync(process.execPath, [cli, "board", "this", "--project", location, "--config", config], { encoding: "utf8", env: process.env });
    assert.match(out, /Sample current task/);
    assert.doesNotMatch(out, /Sample unassigned task/);
  }
  assert.deepEqual([snapshot(f.root), snapshot(f.second)], before);
});

for (const invalid of ["relative", "missing", "file"]) {
  test(`T63 CHECKOUT: ${invalid} checkout metadata is not project identity`, t => {
    const f = fixture(t), key = f.key(f.project), file = join(f.project, "sample-file");
    writeFileSync(file, "sample");
    const value = invalid === "relative" ? "same" : invalid === "missing" ? join(f.project, "missing") : file;
    store(f.root, key, `Sample ${invalid} task`, value);
    const env = { ...process.env, SAGE_HOME: f.root }, before = snapshot(f.root);
    const global = f.tool.sage(["board", "all", "--view", "chat", "--project", f.project], env);
    const current = f.tool.sage(["board", "this", "--view", "chat", "--project", f.project], env);
    assert.match(global, new RegExp(`Sample ${invalid} task`));
    assert.doesNotMatch(current, new RegExp(`Sample ${invalid} task`));
    assert.doesNotMatch(f.tool.sage(["board", "this", "--remember", "no", "--project", f.project], env), new RegExp(`Sample ${invalid} task`));
    assert.deepEqual(snapshot(f.root), before);
  });
}
