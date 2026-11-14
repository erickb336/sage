import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { actorOptions, locate as claudeLocate, sage as claudeRun, sageRoot as claudeRootOf } from "../plugins/sage/skills/sage/sage.mjs";
import { tool } from "../plugins/sage-codex/skills/sage/sage.mjs";
import { buildBoardModel, createStateTool, readBoardSources, renderBoardHtml, renderBoardText, renderTaskText, sharedRoot } from "../packages/sage-core/index.mjs";
import { githubRemote } from "../packages/sage-core/shared-root.mjs";

const acting = (run, options) => (argv, env) => run([...argv, ...options(argv[argv.indexOf("--project") + 1], argv, { native: "test-chief" }, env)], env);
const claudeSage = acting(claudeRun, actorOptions), codexSage = acting(tool.sage, tool.actorOptions);

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const FIRST = "1".repeat(40), OTHER = "2".repeat(40);
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

function world(t, { commit = true } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-shared-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const env = { ...process.env, HOME: join(base, "home"), CLAUDE_CONFIG_DIR: join(base, "claude"), CODEX_HOME: join(base, "codex"), SAGE_SHARED_HOME: join(base, "shared"), SAGE_TEST_PIDS: "{}" };
  delete env.SAGE_HOME;
  const claudeRoot = join(env.CLAUDE_CONFIG_DIR, "sage"), codexRoot = join(env.CODEX_HOME, "sage"), shared = env.SAGE_SHARED_HOME;
  const repo = (name, made = commit) => {
    const project = join(base, name);
    mkdirSync(project, { recursive: true });
    git(project, "init", "-q", "-b", "main");
    if (made) git(project, "commit", "-q", "--allow-empty", "-m", `first of ${name}`);
    return project;
  };
  const project = repo("project");
  const claude = (...args) => claudeSage([...args, "--project", project], env);
  const codex = (...args) => codexSage([...args, "--project", project], env);
  const name = () => basename(tool.storeDir(project, env));
  const table = (file) => readFileSync(join(shared, file), "utf8");
  const rows = () => table("bindings.tsv").trim().split("\n").slice(1).map((line) => line.split("\t"));
  const bind = (...lines) => {
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, "bindings.tsv"), ["root\tfolder\tcommits\tat", ...lines].join("\n") + "\n");
  };
  return { base, env, claudeRoot, codexRoot, shared, repo, project, claude, codex, name, table, rows, bind };
}
const commitOf = (project) => git(project, "rev-list", "--max-parents=0", "HEAD");
const refusalOf = (call) => {
  try {
    call();
  } catch (e) {
    return e.message;
  }
  assert.fail("no refusal");
};
const NOTE = "Note: no sage command can change this answer later.";

test("one function picks the shared root: the fixed option, SAGE_SHARED_HOME, <SAGE_HOME>/shared, then ~/.sage", () => {
  const all = { HOME: "/h", SAGE_HOME: "/s", SAGE_SHARED_HOME: "/x" };
  assert.equal(sharedRoot(all, "/fixed"), "/fixed");
  assert.equal(sharedRoot(all), "/x");
  assert.equal(sharedRoot({ HOME: "/h", SAGE_HOME: "/s" }), "/s/shared");
  assert.equal(sharedRoot({ HOME: "/h" }), "/h/.sage");
});

function processHome(t, home) {
  const saved = { HOME: process.env.HOME, SAGE_HOME: process.env.SAGE_HOME };
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  process.env.HOME = home;
  delete process.env.SAGE_HOME;
}

test("each default root reads the HOME of the env that the caller gives, and the process's home only when that env has none", async (t) => {
  processHome(t, "/process-home");
  const { modeDirectory } = await import("../plugins/sage-codex/hooks/sage-codex-hook.mjs");
  assert.equal(claudeRootOf({ HOME: "/h" }), "/h/.claude/sage");
  assert.equal(tool.sageRoot({ HOME: "/h" }), "/h/.codex/sage");
  assert.equal(modeDirectory({ HOME: "/h" }), "/h/.codex/sage/.hooks/codex");
  assert.equal(claudeRootOf({}), "/process-home/.claude/sage");
  assert.equal(tool.sageRoot({}), "/process-home/.codex/sage");
  assert.equal(modeDirectory({}), "/process-home/.codex/sage/.hooks/codex");
  assert.equal(claudeRootOf({ HOME: "/h", CLAUDE_CONFIG_DIR: "/c" }), "/c/sage");
  assert.equal(tool.sageRoot({ HOME: "/h", CODEX_HOME: "/c" }), "/c/sage");
  assert.equal(modeDirectory({ HOME: "/h", CODEX_HOME: "/c" }), "/c/sage/.hooks/codex");
  assert.equal(claudeRootOf({ HOME: "/h", CLAUDE_CONFIG_DIR: "/c", SAGE_HOME: "/s" }), "/s");
  assert.equal(tool.sageRoot({ HOME: "/h", CODEX_HOME: "/c", SAGE_HOME: "/s" }), "/s");
});

test("T944: in a test, sage code that falls back to the home folder of the test's start throws, and the file fails also when sage code catches it", (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "sage-guard-home-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const href = (path) => JSON.stringify(pathToFileURL(join(REPO, path)).href);
  const run = (env) => spawnSync(process.execPath, ["--input-type=module", "-e", `import ${href("scripts/test-env.mjs")};
import { sharedRoot } from ${href("packages/sage-core/shared-root.mjs")};
try { console.log(sharedRoot(${env})); } catch (e) { console.log(e.message); }`], { encoding: "utf8", env: { ...process.env, HOME: home } });
  const old = run("{}");
  assert.equal(old.status, 1);
  assert.match(old.stdout, /^a test reached the real home folder: os\.homedir\(\) at sharedRoot \(file:.*shared-root\.mjs:\d+:\d+\)\. Give that env a scratch HOME\.\n$/);
  assert.match(old.stderr, /^A test reached the real home folder \(T944, T969\)\. Give each env a scratch HOME:\nat sharedRoot /);
  const fixed = run('{ HOME: "/scratch/home" }');
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.equal(fixed.stdout, "/scratch/home/.sage\n");
});

test("T969: the guard also refuses the account's home after a test deletes HOME, and a child process whose env has no HOME", (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "sage-guard-home-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const href = (path) => JSON.stringify(pathToFileURL(join(REPO, path)).href);
  const run = (body) => spawnSync(process.execPath, ["--input-type=module", "-e", `import ${href("scripts/test-env.mjs")};
import { spawnSync } from "node:child_process";
import { sharedRoot } from ${href("packages/sage-core/shared-root.mjs")};
try { ${body} } catch (e) { console.log(e.message); }`], { encoding: "utf8", env: { ...process.env, HOME: home } });
  const deleted = run("delete process.env.HOME; console.log(sharedRoot({}));");
  assert.equal(deleted.status, 1, deleted.stdout);
  assert.match(deleted.stdout, /^a test reached the real home folder: os\.homedir\(\) at sharedRoot \(file:.*shared-root\.mjs:\d+:\d+\)\. Give that env a scratch HOME\.\n$/);
  const child = run(`spawnSync(process.execPath, ["-e", ""], { env: { PATH: process.env.PATH } });`);
  assert.equal(child.status, 1, child.stdout);
  assert.match(child.stdout, /^a test reached the real home folder: spawnSync\(\) with an env that has no HOME at file:.*\[eval1\]:\d+:\d+\. Give that env a scratch HOME\.\n$/);
  assert.match(child.stderr, /^A test reached the real home folder \(T944, T969\)\. Give each env a scratch HOME:\nat file:.*\[eval1\]/);
  const ok = run(`for (const options of [{ env: { PATH: process.env.PATH, HOME: "/scratch/home" } }, {}]) console.log(spawnSync(process.execPath, ["-e", "console.log(require('node:os').homedir())"], { encoding: "utf8", ...options }).stdout.trim());`);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, `/scratch/home\n${home}\n`);
});

test("a run with SAGE_HOME removed and HOME in scratch writes under that HOME, and the old fault lands in a scratch decoy, never the real root", (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-env-home-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const decoy = join(base, "decoy");
  mkdirSync(decoy);
  processHome(t, decoy);
  const all = { ...process.env, SAGE_TEST_PIDS: "{}" };
  for (const name of ["SAGE_SHARED_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "SAGE_WORKTREES"]) delete all[name];
  for (const [name, run, root] of [["claude", claudeSage, ".claude"], ["codex", tool.sage, ".codex"]]) {
    const home = join(base, "home", name), env = { ...all, HOME: home };
    const project = join(base, name);
    mkdirSync(project);
    git(project, "init", "-q", "-b", "main");
    git(project, "commit", "-q", "--allow-empty", "-m", "first");
    run(["init", "--project", project], env);
    run(["task", "add", "--priority", "P2", "--title", "Task in scratch", "--size", "tiny", "--project", project], env);
    assert.equal(dirname(run(["logbook", "--project", project], env)), join(home, root, "sage"));
    assert.deepEqual(readdirSync(decoy), []);
  }
});

test("a relative SAGE_SHARED_HOME refuses: another folder would find another root, no row and the legacy logbook", (t) => {
  const w = world(t);
  w.claude("link", "--separate");
  const env = { ...w.env, SAGE_SHARED_HOME: "shared" };
  assert.throws(() => claudeSage(["status", "--project", w.project], env), /SAGE_SHARED_HOME is "shared", but it must be an absolute path/);
  assert.throws(() => codexSage(["link", "--separate", "--project", w.project], env), /must be an absolute path/);
  assert.equal(tool.mergeCheck("a".repeat(40), env, { project: w.project }).ok, false);
  assert.equal(existsSync(join(process.cwd(), "shared")), false, "no root appears under the folder of the command");
});

test("no row: an existing project works as before, and no row or table appears from a read", (t) => {
  const w = world(t);
  assert.equal(w.claude("init"), `logbook ${join(w.claudeRoot, w.name())}`);
  assert.equal(readFileSync(join(w.claudeRoot, w.name(), "checkout.txt"), "utf8"), `${w.project}\n`);
  assert.equal(w.claude("logbook"), join(w.claudeRoot, w.name()));
  assert.equal(existsSync(join(w.shared, "bindings.tsv")), false);
  assert.equal(claudeLocate(w.project, w.env).shared, false);
});

test("no row and neither legacy logbook: today's refusal for a command, and a new legacy logbook for init (rule 3 stays off)", (t) => {
  const w = world(t);
  assert.throws(() => w.claude("status"), /no logbook for the project/);
  assert.deepEqual([claudeLocate(w.project, w.env).shared, claudeLocate(w.project, w.env).legacy], [false, false]);
  assert.match(w.codex("init"), new RegExp(`^logbook ${w.codexRoot}/`));
  assert.equal(existsSync(join(w.shared, "bindings.tsv")), false);
});

test("a legacy logbook in the other provider's root counts as legacy, and this provider keeps today's refusal", (t) => {
  const w = world(t);
  w.codex("init");
  assert.deepEqual([claudeLocate(w.project, w.env).shared, claudeLocate(w.project, w.env).legacy], [false, true]);
  assert.throws(() => w.claude("status"), /no logbook for the project/);
});

test("a moved marker in either provider root refuses, reads too, and says to run the move again", (t) => {
  const w = world(t);
  w.claude("init");
  mkdirSync(join(w.codexRoot, w.name()), { recursive: true });
  writeFileSync(join(w.codexRoot, w.name(), "moved.json"), "{}\n");
  for (const command of [["status"], ["task", "add", "--title", "x", "--size", "tiny", "--priority", "P2"], ["init"]]) {
    assert.throws(() => w.claude(...command), /the move did not finish .*Run the move again/);
  }
  assert.equal(tool.mergeCheck("a".repeat(40), w.env, { project: w.project }).ok, false);
  assert.match(tool.mergeCheck("a".repeat(40), w.env, { project: w.project }).reason, /Run the move again/);
});

test("--separate makes a shared logbook that both providers use, with one row, and every command finds it again", (t) => {
  const w = world(t);
  const folder = basename(tool.storeDir(w.project, w.env));
  assert.equal(w.claude("link", "--separate"), `${w.project} now uses the shared logbook ${join(w.shared, folder)}`);
  assert.equal(w.codex("logbook"), join(w.shared, folder));
  assert.equal(w.claude("logbook"), join(w.shared, folder));
  const [[root, saved, commits]] = w.rows();
  assert.deepEqual([root, saved, commits], [w.project, folder, commitOf(w.project)]);
  w.claude("task", "add", "--title", "From Claude", "--size", "tiny", "--priority", "P2");
  w.codex("task", "add", "--title", "From Codex", "--size", "tiny", "--priority", "P2");
  assert.deepEqual(tool.read(join(w.shared, folder), "tasks").map((row) => [row.id, row.title]), [["T1", "From Claude"], ["T2", "From Codex"]]);
  assert.equal(existsSync(join(w.shared, folder, "checkout.txt")), false, "bindings.tsv replaces it for a shared logbook");
  assert.match(w.table("projects.tsv"), new RegExp(`^${folder}\\t`, "m"));
  assert.equal(existsSync(join(w.claudeRoot, folder)), false, "no legacy logbook");
});

test("the folder name stays the one saved in the row after the checkout moves on disk: link --to joins it, and a read never computes it again", (t) => {
  const w = world(t);
  w.claude("link", "--separate");
  const folder = w.name(), moved = join(w.base, "moved");
  execFileSync("mv", [w.project, moved]);
  const run = (...args) => claudeSage([...args, "--project", moved], w.env);
  assert.throws(() => run("status"), /: \*\*This folder has no logbook yet:\*\* /, "no row for the new path: the link prompt");
  assert.equal(run("link", "--to", folder), `${moved} now uses the shared logbook ${join(w.shared, folder)}`);
  assert.equal(run("logbook"), join(w.shared, folder));
  assert.deepEqual(w.rows().map(([root, saved]) => [root, saved]), [[w.project, folder], [moved, folder]], "a row whose path is gone stays");
});

for (const [name, leave] of [
  ["moved", (w, there) => execFileSync("mv", [w.project, there])],
  ["cloned again", (w, there) => { git(w.base, "clone", "-q", w.project, there); rmSync(w.project, { recursive: true }); }],
]) test(`a checkout that was ${name} is told to link, and following each refusal reaches its tasks with no legacy logbook`, (t) => {
  const w = world(t);
  w.claude("link", "--separate");
  w.claude(...ADD);
  const folder = w.name(), there = join(w.base, "there");
  leave(w, there);
  for (const run of [claudeSage, tool.sage]) {
    const next = new RegExp(`: \\*\\*This folder has no logbook yet:\\*\\* ${there}\\n\\nIt has the same first commit as the project project \\(logbook ${folder}, used by ${w.project}\\)\\. sage cannot compare GitHub remotes: [^\\n]*\\n\\nNote: no sage command can change this answer later\\.\\n\\nChoose one:\\n1\\. \\*\\*Link to project\\*\\* \\(recommended\\)\\.[\\s\\S]*For the chief: after the reply, run one command in ${there}: for 1, sage link --to ${folder}; for 2, sage link --separate\\.$`);
    assert.throws(() => run(["status", "--project", there], w.env), next, "a command names the link");
    assert.throws(() => run(["init", "--project", there], w.env), next, "init never makes the logbook that traps the link");
  }
  assert.deepEqual([w.claudeRoot, w.codexRoot].filter(existsSync).flatMap((root) => readdirSync(root).filter((entry) => /-[0-9a-f]{6}$/.test(entry))), [], "no legacy logbook");
  assert.equal(claudeSage(["link", "--to", folder, "--project", there], w.env), `${there} now uses the shared logbook ${join(w.shared, folder)}`);
  assert.match(claudeSage(["status", "--project", there], w.env), /T1/);
  assert.match(codexSage([...ADD, "--project", there], w.env), /T2/);
});

test("a fork that the same refusal stops starts its own logbook with --separate", (t) => {
  const w = world(t);
  w.claude("link", "--separate");
  const fork = join(w.base, "fork");
  git(w.base, "clone", "-q", w.project, fork);
  assert.throws(() => claudeSage(["init", "--project", fork], w.env), /for 2, sage link --separate\.$/);
  assert.match(claudeSage(["link", "--separate", "--project", fork], w.env), /now uses the shared logbook/);
  assert.notEqual(claudeSage(["logbook", "--project", fork], w.env), join(w.shared, w.name()));
});

test("a checkout with other first commits still starts a legacy logbook while shared rows exist", (t) => {
  const w = world(t);
  w.claude("link", "--separate");
  const other = w.repo("other"), plain = join(w.base, "plain");
  mkdirSync(plain);
  assert.equal(claudeSage(["init", "--project", other], w.env), `logbook ${tool.storeDir(other, { ...w.env, SAGE_HOME: w.claudeRoot })}`);
  assert.match(claudeSage(["init", "--project", plain], w.env), /^logbook /);
});

function lanternWorld(t) {
  const w = world(t), lantern = w.repo("lantern"), clone = join(w.base, "lantern-b");
  git(lantern, "remote", "add", "origin", "https://github.com/sample-owner/lantern.git");
  claudeSage(["link", "--separate", "--project", lantern], w.env);
  git(w.base, "clone", "-q", lantern, clone);
  const folder = basename(claudeSage(["logbook", "--project", lantern], w.env));
  const prompts = (project = clone) => [claudeSage, codexSage].map((run) => refusalOf(() => run(["status", "--project", project], w.env)));
  return { w, lantern, clone, folder, prompts };
}
test("the link prompt of a new clone recommends by its GitHub remote: the same one links, another one (a fork) starts separate, none links", (t) => {
  const { w, lantern, clone, folder, prompts } = lanternWorld(t);
  const facts = `**This folder has no logbook yet:** ${clone}\n\nIt has the same first commit as the project lantern (logbook ${folder}, used by ${lantern}).`;
  const link = `Choose one:\n1. **Link to lantern** (recommended). This folder uses the lantern logbook. Its tasks show in the one lantern project on the board, and its runs show "checkout lantern-b". No record is copied.\n2. **Start separate.** This folder gets a new, empty logbook, and the board shows it as another project. Choose this for a fork that is now its own project.\n\nReply 1 or 2.\n\nFor the chief: after the reply, run one command in ${clone}: for 1, sage link --to ${folder}; for 2, sage link --separate.`;
  git(clone, "remote", "set-url", "origin", "git@github.com:sample-owner/lantern.git");
  const same = `${facts} Its GitHub remote is also sample-owner/lantern. So it is most likely a second clone of lantern. sage does not guess, and nothing has changed.\n\n${NOTE}\n\n${link}`;
  assert.deepEqual(prompts(), [same, same], "the same remote: link (both providers)");
  git(clone, "remote", "set-url", "origin", "https://github.com/other-owner/lantern-x");
  const fork = `${facts} But its GitHub remote is other-owner/lantern-x, not sample-owner/lantern. So it is most likely a fork. sage does not guess, and nothing has changed.\n\n${NOTE}\n\nChoose one:\n1. **Start separate** (recommended). This folder gets a new, empty logbook, and the board shows it as another project.\n2. **Link to lantern.** This folder uses the lantern logbook, and its tasks show in the lantern project. Choose this only if the fork and lantern are one project to you.\n\nReply 1 or 2.\n\nFor the chief: after the reply, run one command in ${clone}: for 1, sage link --separate; for 2, sage link --to ${folder}.`;
  assert.deepEqual(prompts(), [fork, fork], "another remote, a fork: separate");
  git(clone, "remote", "remove", "origin");
  const none = `${facts} sage cannot compare GitHub remotes: this folder has none that sage can read. So it is most likely a second clone of lantern, or this folder moved. sage does not guess, and nothing has changed.\n\n${NOTE}\n\n${link}`;
  assert.deepEqual(prompts(), [none, none], "no remote here: link");
  git(clone, "remote", "add", "origin", "https://github.com/sample-owner/lantern");
  git(lantern, "remote", "remove", "origin");
  assert.equal(prompts()[0], none.replace("this folder has none", `${lantern} has none`), "no remote at the logbook's checkout: link");
  assert.match(claudeSage(["link", "--to", folder, "--project", clone], w.env), /now uses the shared logbook/, "choice 1's command works");
});

test("a row whose logbook is missing: the prompt offers the restore first, then separate or another project", (t) => {
  const { w, lantern, folder, prompts } = lanternWorld(t);
  rmSync(join(w.shared, folder), { recursive: true });
  const missing = `**This folder's logbook is missing:** ${lantern}\n\nIts row links it to the logbook ${folder}, but that folder is not in the shared root (${w.shared}) now. Nothing has changed.\n\nNote: a new link or a new logbook does not bring back the old tasks.\n\nChoose one:\n1. **Restore the folder** (recommended if it was removed by mistake). Put ${folder} back from a copy, for example Time Machine. Then ask me again.\n2. **Start separate.** This folder gets a new, empty logbook.\n3. **Link to another project.** Tell me its name.\n\nReply 1, 2 or 3.\n\nFor the chief: after the reply, run one command in ${lantern}: for 1, no command: the user puts ${folder} back in ${w.shared}; for 2, sage link --separate; for 3, sage link --to <the folder of the project that the user names>.`;
  assert.deepEqual(prompts(lantern), [missing, missing]);
});

test("two shared logbooks with one first commit: the prompt names both, and recommends the one with the same GitHub remote", (t) => {
  const { w, lantern, folder, prompts } = lanternWorld(t);
  const fork = join(w.base, "lantern-x"), third = join(w.base, "lantern-c");
  git(w.base, "clone", "-q", lantern, fork);
  git(fork, "remote", "set-url", "origin", "https://github.com/other-owner/lantern-x");
  claudeSage(["link", "--separate", "--project", fork], w.env);
  const forkFolder = basename(claudeSage(["logbook", "--project", fork], w.env));
  git(w.base, "clone", "-q", lantern, third);
  const ask = (choices, runs) => `**This folder has no logbook yet:** ${third}\n\nTwo shared logbooks have its first commit. sage does not guess, and nothing has changed.${choices[0]}\n\n${NOTE}\n\nChoose one:\n${choices.slice(1).join("\n")}\n\nReply 1, 2 or 3.\n\nFor the chief: after the reply, run one command in ${third}: ${runs}.`;
  git(third, "remote", "set-url", "origin", "https://github.com/sample-owner/lantern");
  const same = ask(["", `1. **Link to lantern** (recommended: the same GitHub remote, sample-owner/lantern). Logbook ${folder}, used by ${lantern}.`, `2. **Link to lantern-x.** Logbook ${forkFolder}, used by ${fork}.`, "3. **Start separate.** A new, empty logbook."], `for 1, sage link --to ${folder}; for 2, sage link --to ${forkFolder}; for 3, sage link --separate`);
  assert.deepEqual(prompts(third), [same, same]);
  git(third, "remote", "set-url", "origin", "https://github.com/third-owner/lantern-c");
  assert.equal(prompts(third)[0], ask(["", `1. **Link to lantern.** Logbook ${folder}, used by ${lantern}.`, `2. **Link to lantern-x.** Logbook ${forkFolder}, used by ${fork}.`, "3. **Start separate** (recommended: no logbook has its GitHub remote, third-owner/lantern-c). A new, empty logbook."], `for 1, sage link --to ${folder}; for 2, sage link --to ${forkFolder}; for 3, sage link --separate`), "a remote that no logbook has: separate");
  git(third, "remote", "remove", "origin");
  assert.equal(prompts(third)[0], ask([" sage cannot recommend one: this folder has no GitHub remote that sage can read.", `1. **Link to lantern.** Logbook ${folder}, used by ${lantern}.`, `2. **Link to lantern-x.** Logbook ${forkFolder}, used by ${fork}.`, "3. **Start separate.** A new, empty logbook."], `for 1, sage link --to ${folder}; for 2, sage link --to ${forkFolder}; for 3, sage link --separate`), "no remote: no recommendation");
  git(third, "remote", "add", "origin", "https://github.com/sample-owner/lantern");
  git(fork, "remote", "remove", "origin");
  assert.match(prompts(third)[0], new RegExp(`\\(recommended: the same GitHub remote, sample-owner/lantern\\)`), "the same remote still links");
  git(third, "remote", "set-url", "origin", "https://github.com/third-owner/lantern-c");
  assert.ok(prompts(third)[0].includes(` sage cannot recommend one: ${fork} has no GitHub remote that sage can read.\n`), "the fork's folder has none");
});

test("F-T633-4: a remote with a user or a token in its URL reads as its repository, and the prompt never prints the token", (t) => {
  assert.equal(githubRemote("https://x-access-token:SECRET123@github.com/sample-owner/lantern.git"), "sample-owner/lantern");
  assert.equal(githubRemote("https://someone@github.com/sample-owner/lantern"), "sample-owner/lantern");
  assert.equal(githubRemote("https://evil.example/@github.com/sample-owner/lantern"), null, "a path is no user");
  const { clone, prompts } = lanternWorld(t);
  git(clone, "remote", "set-url", "origin", "https://x-access-token:SECRET123@github.com/sample-owner/lantern.git");
  const [text] = prompts();
  assert.match(text, /Its GitHub remote is also sample-owner\/lantern\. So it is most likely a second clone of lantern\./);
  assert.ok(!text.includes("SECRET123") && !text.includes("x-access-token"));
});

test("F-T633-7: with the first checkout gone, a live clone keeps the logbook; a foreign row linked before it does not take it", (t) => {
  const w = world(t);
  w.claude("link", "--separate");
  const folder = w.name(), [[root, , commits, at]] = w.rows(), stranger = w.repo("stranger");
  w.bind(`${join(w.base, "gone")}\t${folder}\t${commits}\t2020-01-01T00:00:00Z`, `${stranger}\t${folder}\t${commitOf(stranger)}\t2020-02-01T00:00:00Z`, `${root}\t${folder}\t${commits}\t${at}`);
  assert.equal(w.claude("logbook"), join(w.shared, folder));
  assert.match(w.claude(...ADD), /T1/);
  assert.throws(() => claudeSage(["status", "--project", stranger], w.env), new RegExp(`belongs to another project \\(${root}\\)`));
});

test("F-T633-8 and F-T638-1: a clone with the folder name of a linked checkout is told its board label, and the link says it", (t) => {
  const { w, lantern, folder } = lanternWorld(t);
  const clone = join(w.base, "clones", "lantern");
  mkdirSync(dirname(clone));
  git(w.base, "clone", "-q", lantern, clone);
  git(clone, "remote", "set-url", "origin", "https://github.com/sample-owner/lantern.git");
  assert.ok(refusalOf(() => claudeSage(["status", "--project", clone], w.env)).includes(`its runs show "checkout lantern #2"`));
  assert.equal(claudeSage(["link", "--to", folder, "--project", clone], w.env), `${clone} now uses the shared logbook ${join(w.shared, folder)}. The board shows this folder as lantern #2`);
  assert.equal(claudeSage(["link", "--to", folder, "--project", join(w.base, "lantern-b")], w.env), `${join(w.base, "lantern-b")} now uses the shared logbook ${join(w.shared, folder)}`, "a unique name gets no number");
});

test("F-T633-9: a shallow clone of a project with a shared logbook gets a prompt, not a legacy logbook", (t) => {
  const w = world(t);
  git(w.project, "commit", "-q", "--allow-empty", "-m", "second");
  w.claude("link", "--separate");
  const shallow = join(w.base, "shallow");
  git(w.base, "clone", "-q", "--depth", "1", `file://${w.project}`, shallow);
  const text = `**This folder has no logbook yet:** ${shallow}\n\nIt is a shallow clone, so its first commit is its newest one, and sage cannot tell whether it is a clone of a project that has a shared logbook. sage does not guess, and nothing has changed.\n\n${NOTE}\n\nChoose one:\n1. **Fetch its full history** (recommended). Run \`git fetch --unshallow\` in this folder, then ask me again.\n2. **Start separate.** This folder gets a new, empty logbook, and the board shows it as another project.\n\nReply 1 or 2.\n\nFor the chief: after the reply, run one command in ${shallow}: for 1, no command: the user runs git fetch --unshallow in it; for 2, sage link --separate.`;
  for (const run of [claudeSage, codexSage]) assert.equal(refusalOf(() => run(["init", "--project", shallow], w.env)), text);
  assert.ok(!existsSync(join(w.claudeRoot)) || !readdirSync(w.claudeRoot).some((name) => name.startsWith("shallow-")), "no legacy logbook");
  git(shallow, "fetch", "-q", "--unshallow");
  assert.match(refusalOf(() => claudeSage(["init", "--project", shallow], w.env)), /It has the same first commit as the project project/, "after the fetch, the link prompt");
});

test("F-T639-1: the link prompt prints a line or paragraph separator in a path as an escape, so the path stays on its line", (t) => {
  const { w, lantern } = lanternWorld(t);
  const clone = join(w.base, "lan\u2028tern\u2029x");
  git(w.base, "clone", "-q", lantern, clone);
  const text = refusalOf(() => claudeSage(["status", "--project", clone], w.env));
  assert.ok(!/[\u2028\u2029]/.test(text), "no raw separator");
  assert.ok(text.includes(`**This folder has no logbook yet:** ${join(w.base, "lan\\u{2028}tern\\u{2029}x")}\n`));
});

test("a matching row whose logbook is missing offers nothing: no link can reach it, so init starts as before", (t) => {
  const w = world(t);
  w.claude("link", "--separate");
  const clone = join(w.base, "clone");
  git(w.base, "clone", "-q", w.project, clone);
  rmSync(join(w.shared, w.name()), { recursive: true });
  assert.match(claudeSage(["init", "--project", clone], w.env), /^logbook /);
});

test("the current folder that is gone gets a next step, not a raw error", (t) => {
  const w = world(t);
  const cwd = process.cwd;
  t.after(() => { process.cwd = cwd; });
  process.cwd = () => { throw Object.assign(new Error("ENOENT: process.cwd failed"), { code: "ENOENT" }); };
  const { SAGE_PROJECT: _unused, ...env } = w.env;
  for (const run of [claudeRun, tool.sage]) {
    for (const command of [["config"], ["projects", "rebuild", "--accept-listing", "yes"], ["board", "--view", "html"], ["status"]]) {
      assert.throws(() => run(command, env), (e) => {
        assert.equal(e.constructor.name, "Refusal");
        assert.equal(e.message, "the current folder is gone: it was moved or removed. Nothing changed. Go to the project's folder, or give --project with its path.");
        return true;
      }, command.join(" "));
    }
  }
  assert.match(claudeSage(["init", "--project", w.project], env), /^logbook /, "a command that names its project needs no current folder");
});

test("a linked worktree uses its main checkout's row and needs no row of its own", (t) => {
  const w = world(t);
  w.claude("link", "--separate");
  const worktree = join(w.base, "tree");
  git(w.project, "worktree", "add", "-q", "-b", "feature", worktree);
  assert.equal(claudeSage(["logbook", "--project", worktree], w.env), join(w.shared, w.name()));
  assert.equal(w.rows().length, 1);
});

test("a retry of link is safe, and a checkout never holds two logbooks", (t) => {
  const w = world(t);
  w.claude("link", "--separate");
  const before = w.table("bindings.tsv"), folder = w.name();
  assert.equal(w.codex("link", "--separate"), `already linked: ${join(w.shared, folder)}. Nothing changed.`);
  assert.equal(w.codex("link", "--to", folder), `already linked: ${join(w.shared, folder)}. Nothing changed.`);
  const other = w.repo("other");
  assert.match(claudeSage(["link", "--separate", "--project", other], w.env), /now uses the shared logbook/);
  const otherFolder = basename(tool.storeDir(other, w.env));
  assert.throws(() => w.claude("link", "--to", otherFolder), new RegExp(`already linked to ${folder}, and a checkout has one logbook\\. Nothing changed\\. Keep using ${folder}: no command takes a linked checkout to another logbook\\.$`));
  assert.equal(w.rows().find(([root]) => root === w.project)[1], folder);
  assert.ok(w.table("bindings.tsv").startsWith(before));
});

test("link refuses a project with a legacy logbook in either root, and names the next step: only the move takes its tasks over", (t) => {
  const w = world(t);
  w.codex("init");
  assert.throws(() => w.claude("link", "--separate"), /has a logbook at .*Keep using that logbook, or ask the user for the move \(sage move --preview\)/i);
  assert.equal(existsSync(join(w.shared, "bindings.tsv")), false);
});

test("link takes exactly one form, and --to names a real logbook of the shared root", (t) => {
  const w = world(t);
  const form = /link takes exactly one of --to <folder> or --separate; --separate takes no value\. Nothing changed\.$/;
  const notALogbook = /is not a logbook of the shared root\. Nothing changed\. Run sage link --separate to start a new logbook\.$/;
  assert.throws(() => w.claude("link"), form);
  assert.throws(() => w.claude("link", "--separate", "--to", "a-123456"), form);
  assert.throws(() => w.claude("link", "--separate=no"), form);
  assert.throws(() => w.claude("link", "--to", "../escape-123456"), /not a logbook folder/);
  assert.throws(() => w.claude("link", "--to", "absent-123456"), notALogbook);
  assert.throws(() => claudeSage(["link", "--separate", "--project", join(w.base, "absent")], w.env), /is not a folder/);
  mkdirSync(join(w.shared, "planted-123456"), { recursive: true });
  writeFileSync(join(w.shared, "planted-123456", "tasks.tsv"), "");
  assert.throws(() => w.claude("link", "--to", "planted-123456"), notALogbook, "a folder that link did not make is not listed");
  assert.equal(existsSync(join(w.shared, "bindings.tsv")), false);
});

test("a --to that names no logbook lists the logbooks in the refusal, so that no agent reads projects.tsv, and the named folder works", (t) => {
  const w = world(t);
  const other = w.repo("other"), clone = join(w.base, "clone");
  claudeSage(["link", "--separate", "--project", other], w.env);
  const folder = basename(tool.storeDir(other, w.env));
  git(w.base, "clone", "-q", other, clone);
  for (const run of [claudeSage, tool.sage]) assert.throws(() => run(["link", "--to", "typo-123456", "--project", clone], w.env), new RegExp(`is not a logbook of the shared root\\. Nothing changed\\. Its logbooks are ${folder}\\. Run sage link --to <folder> with one of them, or run sage link --separate to start a new logbook\\.$`));
  assert.match(claudeSage(["link", "--to", folder, "--project", clone], w.env), /now uses the shared logbook/);
});

test("link --to refuses a logbook of another project, and --separate refuses a folder name in use", (t) => {
  const w = world(t);
  const other = w.repo("other");
  claudeSage(["link", "--separate", "--project", other], w.env);
  const folder = basename(tool.storeDir(other, w.env));
  assert.throws(() => w.claude("link", "--to", folder), /belongs to another project .*no first commit in common/);
  mkdirSync(join(w.shared, w.name()));
  assert.throws(() => w.claude("link", "--separate"), /already in use/);
  assert.equal(w.rows().length, 1);
});

test("a clone joins with an explicit link; without one it is a project of its own, and a fork's --separate names its twin", (t) => {
  const w = world(t);
  w.claude("link", "--separate");
  const clone = join(w.base, "clone"), fork = join(w.base, "fork");
  git(w.base, "clone", "-q", w.project, clone);
  git(w.base, "clone", "-q", w.project, fork);
  assert.throws(() => claudeSage(["status", "--project", clone], w.env), /: \*\*This folder has no logbook yet:\*\* /, "a matching first commit never joins a logbook");
  assert.match(codexSage(["link", "--to", w.name(), "--project", clone], w.env), /now uses the shared logbook/);
  assert.equal(claudeSage(["logbook", "--project", clone], w.env), join(w.shared, w.name()));
  assert.match(claudeSage(["link", "--separate", "--project", fork], w.env), new RegExp(`apart from ${w.name()}, which has the same first commit`));
});

for (const [name, lines, expected] of [
  ["a folder that is missing", (w) => [`${w.project}\tgone-123456\t${FIRST}\t2026-11-01T00:00:00Z`], /: \*\*This folder's logbook is missing:\*\* .*\n\nIts row links it to the logbook gone-123456, but that folder is not in the shared root [\s\S]*for 2, sage link --separate; for 3, sage link --to <the folder of the project that the user names>\.$/],
  ["a folder of another project", (w) => [`${w.project}\tshared-123456\t${FIRST}\t2026-11-01T00:00:01Z`, `${w.base}\tshared-123456\t${OTHER}\t2026-11-01T00:00:00Z`], /: \*\*This folder's link is wrong:\*\* [\s\S]*belongs to another project \(.*sage-shared-.*\)[\s\S]*shallow clone[\s\S]*for 1, sage link --separate; for 2, sage link --to <the folder of the project that the user names>\.$/],
  ["two rows for one path", (w) => [`${w.project}\tshared-123456\t\t2026-11-01T00:00:00Z`, `${w.project}\tshared-123456\t\t2026-11-01T00:00:01Z`], /has two rows for/],
  ["a row with a bad folder", (w) => [`${w.project}\t../shared-123456\t\t2026-11-01T00:00:00Z`], /has a damaged row/],
  ["a row of three cells", (w) => [`${w.project}\tshared-123456\t2026-11-01T00:00:00Z`], /has a damaged row/],
]) test(`a binding row with ${name} refuses reads and writes, and never falls through to the legacy logbook`, (t) => {
  const w = world(t);
  w.claude("init");
  const tasks = join(w.claudeRoot, w.name(), "tasks.tsv"), before = readFileSync(tasks, "utf8");
  mkdirSync(join(w.shared, "shared-123456"), { recursive: true });
  writeFileSync(join(w.shared, "shared-123456", "tasks.tsv"), "");
  w.bind(...lines(w));
  for (const run of [w.claude, w.codex]) {
    assert.throws(() => run("status"), expected);
    assert.throws(() => run("task", "add", "--title", "x", "--size", "tiny", "--priority", "P2"), expected);
    assert.throws(() => run("config"), expected);
  }
  assert.equal(tool.mergeCheck("a".repeat(40), w.env, { project: w.project }).ok, false);
  assert.equal(readFileSync(tasks, "utf8"), before);
});

const ADD = ["task", "add", "--title", "x", "--size", "tiny", "--priority", "P2"];

test("a foreign row refuses only in the foreign checkout: the owner keeps working, and the commands that the refusal names work", (t) => {
  const w = world(t);
  w.claude("link", "--separate");
  w.claude(...ADD);
  const folder = w.name(), foreign = w.repo("foreign", false);
  const inForeign = (...args) => claudeSage([...args, "--project", foreign], w.env);
  inForeign("link", "--to", folder);
  git(foreign, "commit", "-q", "--allow-empty", "-m", "own first");
  const conflict = `**This folder's link is wrong:** ${foreign}\n\nIts row links it to the logbook ${folder}, but that logbook belongs to another project (${w.project}): the two folders have no first commit in common. So sage does not use that logbook here, and nothing has changed. The project tasks are safe.\n\nIf this folder is a shallow clone, its first commit is its newest one. Then run \`git fetch --unshallow\` in it, and ask me again.\n\n${NOTE}\n\nChoose one:\n1. **Start separate** (recommended). This folder gets a new, empty logbook in place of the wrong link.\n2. **Link to another project.** Tell me its name. The link stops if that project does not have this folder's first commit.\n\nReply 1, or 2 and the name.\n\nFor the chief: after the reply, run one command in ${foreign}: for 1, sage link --separate; for 2, sage link --to <the folder of the project that the user names>.`;
  for (const run of [claudeSage, codexSage]) assert.equal(refusalOf(() => run([...ADD, "--project", foreign], w.env)), conflict);
  assert.match(w.claude("status"), /T1/);
  assert.match(w.claude(...ADD), /T2/);
  const sha = "a".repeat(40);
  w.claude("verdict", "T1", "--sha", sha, "--kind", "checks-pass");
  assert.match(w.claude("merge-check", "--sha", sha), /T1 may merge/);
  assert.equal(w.claude("link", "--to", folder), `already linked: ${join(w.shared, folder)}. Nothing changed.`);
  assert.equal(w.claude("link", "--separate"), `already linked: ${join(w.shared, folder)}. Nothing changed.`);
  assert.match(inForeign("link", "--separate"), /now uses the shared logbook/);
  assert.notEqual(inForeign("logbook"), join(w.shared, folder));
});

test("a later row with other commits and a gone path does no harm: the owner works, and a clone of the owner still joins", (t) => {
  const w = world(t);
  w.claude("link", "--separate");
  const folder = w.name(), [[root, , commits, at]] = w.rows();
  w.bind(`${root}\t${folder}\t${commits}\t${at}`, `${join(w.base, "gone")}\t${folder}\t${OTHER}\t2099-01-01T00:00:00Z`);
  assert.equal(w.claude("logbook"), join(w.shared, folder));
  w.claude(...ADD);
  const clone = join(w.base, "clone");
  git(w.base, "clone", "-q", w.project, clone);
  assert.match(codexSage(["link", "--to", folder, "--project", clone], w.env), /now uses the shared logbook/);
});

test("a gone older row never refuses the only live checkout, and a checkout with other commits still cannot join through it", (t) => {
  const w = world(t);
  w.claude("link", "--separate");
  w.claude(...ADD);
  const folder = w.name(), [[root, , commits, at]] = w.rows(), gone = join(w.base, "gone");
  const older = `${gone}\t${folder}\t${OTHER}\t2020-01-01T00:00:00Z`, mine = `${root}\t${folder}\t${commits}\t${at}`;
  w.bind(older, mine);
  assert.equal(w.claude("logbook"), join(w.shared, folder));
  assert.match(w.claude("status"), /T1/);
  assert.match(w.claude(...ADD), /T2/);
  assert.match(w.codex(...ADD), /T3/);
  mkdirSync(gone);
  assert.throws(() => w.claude("status"), /belongs to another project/);
  rmSync(gone, { recursive: true });
  w.bind(`${gone}\t${folder}\t${commits}\t2020-01-01T00:00:00Z`, `${root}\t${folder}\t${OTHER}\t${at}`);
  const stranger = w.repo("stranger");
  assert.throws(() => claudeSage(["link", "--to", folder, "--project", stranger], w.env), new RegExp(`belongs to another project \\(${root}\\)`));
  w.bind(`${gone}\t${folder}\t${OTHER}\t2020-01-01T00:00:00Z`);
  assert.throws(() => claudeSage(["link", "--to", folder, "--project", stranger], w.env), new RegExp(`belongs to another project \\(${gone}\\)`));
});

test("the older row owns a logbook whichever row filled its commits first", (t) => {
  const w = world(t, { commit: false });
  w.claude("link", "--separate");
  const folder = w.name(), later = w.repo("later", true);
  const inLater = (...args) => claudeSage([...args, "--project", later], w.env);
  inLater("link", "--to", folder);
  git(w.project, "commit", "-q", "--allow-empty", "-m", "own first");
  w.claude(...ADD);
  assert.equal(w.claude("logbook"), join(w.shared, folder));
  assert.throws(() => inLater("status"), /belongs to another project/);
});

test("a shallow clone's refusal says to fetch its full history", (t) => {
  const w = world(t);
  git(w.project, "commit", "-q", "--allow-empty", "-m", "second");
  w.claude("link", "--separate");
  const shallow = join(w.base, "shallow");
  git(w.base, "clone", "-q", "--depth", "1", `file://${w.project}`, shallow);
  assert.throws(() => claudeSage(["link", "--to", w.name(), "--project", shallow], w.env), /belongs to another project .*A shallow clone needs its full history here: run git fetch --unshallow/);
});

test("M6: a clone with a legacy logbook in the other provider's root gets no link offer: this provider keeps today's refusal", (t) => {
  const w = world(t);
  const clone = join(w.base, "clone");
  git(w.base, "clone", "-q", w.project, clone);
  codexSage(["init", "--project", clone], w.env);
  w.claude("link", "--separate");
  assert.deepEqual([claudeLocate(clone, w.env).shared, claudeLocate(clone, w.env).legacy], [false, true]);
  assert.throws(() => claudeSage(["status", "--project", clone], w.env), (e) => /no logbook for the project/.test(e.message) && !/sage link/.test(e.message));
  assert.match(codexSage(["status", "--project", clone], w.env), /^tasks +0$/m, "the Codex logbook works as before");
  assert.throws(() => claudeSage(["link", "--to", w.name(), "--project", clone], w.env), /this project has a logbook at .*codex/);
});

test("M7: a clone whose first commit cannot be read gets past the guard: init makes a legacy logbook, and link then refuses", (t) => {
  const w = world(t);
  git(w.project, "commit", "-q", "--allow-empty", "-m", "second");
  w.claude("link", "--separate");
  const broken = join(w.base, "broken"), shallow = join(w.base, "shallow");
  git(w.base, "clone", "-q", w.project, broken);
  const config = join(broken, ".git", "config"), good = readFileSync(config, "utf8");
  writeFileSync(config, "[core\n");
  assert.match(claudeSage(["init", "--project", broken], w.env), new RegExp(`^logbook ${w.claudeRoot}/`));
  assert.throws(() => claudeSage(["link", "--to", w.name(), "--project", broken], w.env), /git cannot read the repository at .*broken/);
  writeFileSync(config, good);
  assert.throws(() => claudeSage(["link", "--to", w.name(), "--project", broken], w.env), /this project has a logbook at .*A link would hide its tasks/);
  git(w.base, "clone", "-q", "--depth", "1", `file://${w.project}`, shallow);
  assert.throws(() => claudeSage(["init", "--project", shallow], w.env), /It is a shallow clone/);
});

test("a shared logbook that lost tasks.tsv reaches the repair, as a legacy logbook does, and link leaves its row", (t) => {
  const w = world(t);
  w.claude("link", "--separate");
  w.claude(...ADD);
  w.claude("log", "T1", "a decision", "--why", "a row in another table");
  rmSync(join(w.shared, w.name(), "tasks.tsv"));
  assert.throws(() => w.claude("init"), /--accept-loss tasks/);
  assert.equal(w.claude("link", "--separate"), `already linked: ${join(w.shared, w.name())}. Nothing changed.`);
  assert.match(w.claude("logbook", "repair", "--accept-loss", "tasks"), /tasks\.tsv started again without rows/);
  assert.match(w.claude(...ADD), /framed/);
});

for (const [name, damage, expected] of [
  ["a folder in its place", (w) => mkdirSync(join(w.shared, "bindings.tsv"), { recursive: true }), /cannot be read/],
  ["a link in its place", (w) => { mkdirSync(w.shared, { recursive: true }); symlinkSync(join(w.base, "nowhere"), join(w.shared, "bindings.tsv")); }, /cannot be read/],
  ["no header", (w) => { mkdirSync(w.shared, { recursive: true }); writeFileSync(join(w.shared, "bindings.tsv"), `${w.project}\tx-123456\t\tnow\n`); }, /does not start with the column names root, folder, commits, at/],
  ["a shared root that is a file", (w) => writeFileSync(w.shared, ""), /cannot be read/],
]) test(`a binding table with ${name} refuses every project and never falls through`, (t) => {
  const w = world(t);
  const made = claudeSage(["init", "--project", w.project], { ...w.env, SAGE_SHARED_HOME: join(w.base, "before") });
  assert.match(made, /^logbook /);
  damage(w);
  assert.throws(() => w.claude("status"), expected);
  assert.throws(() => w.claude("init"), expected);
  assert.throws(() => w.codex("task", "add", "--title", "x", "--size", "tiny", "--priority", "P2"), expected);
  assert.match(tool.mergeCheck("a".repeat(40), w.env, { project: w.project }).reason, expected);
});

test("a lost bindings.tsv refuses every project and never falls through; a root that never had one reads as no rows", (t) => {
  const w = world(t);
  w.claude("link", "--separate");
  w.claude(...ADD);
  const folder = w.name(), other = w.repo("other");
  const inOther = (...args) => claudeSage([...args, "--project", other], w.env);
  rmSync(join(w.shared, "bindings.tsv"));
  const lost = /bindings\.tsv is missing, but sage made it before .*bindings\.made/;
  for (const run of [w.claude, w.codex, inOther]) {
    assert.throws(() => run("status"), lost);
    assert.throws(() => run("init"), lost);
    assert.throws(() => run("link", "--separate"), lost);
  }
  assert.equal(existsSync(join(w.claudeRoot, folder)), false, "no new legacy logbook hides the open tasks");
  assert.match(tool.mergeCheck("a".repeat(40), w.env, { project: w.project }).reason, lost);
  w.bind(`${w.project}\t${folder}\t\t2026-11-01T00:00:00Z`);
  assert.match(w.claude("status"), /T1/);
  const fresh = world(t);
  assert.match(fresh.claude("init"), /^logbook /);
  assert.equal(existsSync(join(fresh.shared, "bindings.made")), false);
});

test("a folder planted in a new shared root stays out of its known project list", (t) => {
  const w = world(t);
  const planted = join(w.shared, "planted-123456");
  mkdirSync(planted, { recursive: true });
  writeFileSync(join(planted, "tasks.tsv"), "id\n");
  w.claude("link", "--separate");
  assert.doesNotMatch(w.table("projects.tsv"), /planted-123456/);
  assert.match(w.table("projects.tsv"), new RegExp(`^${w.name()}\\t`, "m"));
  const other = w.repo("other");
  assert.throws(() => claudeSage(["link", "--to", "planted-123456", "--project", other], w.env), /is not a logbook of the shared root/);
});

test("a planted repository runs no program at link or at a fill, and a replace ref forges no first commit", (t) => {
  const w = world(t);
  const repo = w.repo("planted"), marker = join(w.base, "ran"), program = join(w.base, "upload.sh");
  writeFileSync(program, `#!/bin/sh\ntouch ${marker}\nexit 1\n`, { mode: 0o755 });
  const plant = (project) => {
    for (const [key, value] of [["core.repositoryformatversion", "1"], ["extensions.partialClone", "origin"], ["remote.origin.url", `file://${join(w.base, "nowhere")}`], ["remote.origin.promisor", "true"], ["remote.origin.uploadpack", program]]) git(project, "config", key, value);
    writeFileSync(join(project, ".git", "refs", "heads", "main"), `${"a".repeat(40)}\n`);
  };
  plant(repo);
  assert.throws(() => claudeSage(["link", "--separate", "--project", repo], w.env), /git cannot read the history of .*which has a HEAD commit.*made no row/);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(join(w.shared, "bindings.tsv")), false);
  const empty = w.repo("empty", false);
  claudeSage(["link", "--separate", "--project", empty], w.env);
  git(empty, "commit", "-q", "--allow-empty", "-m", "first");
  plant(empty);
  claudeSage([...ADD, "--project", empty], w.env);
  assert.equal(existsSync(marker), false);
  assert.equal(w.rows()[0][2], "");
  const forged = w.repo("forged"), first = commitOf(forged);
  git(forged, "commit", "-q", "--allow-empty", "-m", "second");
  git(forged, "replace", "--graft", "HEAD");
  claudeSage(["link", "--separate", "--project", forged], w.env);
  assert.equal(w.rows().find(([root]) => root === forged)[2], first);
});

test("a repository with no commits: the row has empty commits, a read leaves them, and the next write fills them", (t) => {
  const w = world(t, { commit: false });
  w.claude("link", "--separate");
  assert.equal(w.rows()[0][2], "");
  git(w.project, "commit", "-q", "--allow-empty", "-m", "first");
  w.claude("status");
  assert.equal(w.rows()[0][2], "", "a read runs no first-commit call");
  w.claude("task", "add", "--title", "x", "--size", "tiny", "--priority", "P2");
  assert.equal(w.rows()[0][2], commitOf(w.project));
});

test("a filled row that shows a folder of another project refuses at that write", (t) => {
  const w = world(t, { commit: false });
  const other = w.repo("other", true);
  claudeSage(["link", "--separate", "--project", other], w.env);
  const folder = basename(tool.storeDir(other, w.env));
  w.claude("link", "--to", folder);
  git(w.project, "commit", "-q", "--allow-empty", "-m", "own first");
  assert.throws(() => w.claude("task", "add", "--title", "x", "--size", "tiny", "--priority", "P2"), /belongs to another project/);
});

test("a folder that is not a Git repository links with no commits: no first commit, so no guard", (t) => {
  const w = world(t);
  const plain = join(w.base, "plain");
  mkdirSync(plain);
  assert.match(claudeSage(["link", "--separate", "--project", plain], w.env), /now uses the shared logbook/);
  assert.equal(w.rows()[0][2], "");
});

const UNREADABLE = {
  "an unknown repository extension": (w, repo) => {
    git(repo, "config", "core.repositoryformatversion", "1");
    git(repo, "config", "extensions.nosuchextension", "true");
    return repo;
  },
  "a broken config": (w, repo) => {
    writeFileSync(join(repo, ".git", "config"), "[core\n");
    return repo;
  },
  "a garbage HEAD": (w, repo) => {
    writeFileSync(join(repo, ".git", "HEAD"), "garbage\n");
    return repo;
  },
  "a garbage branch ref": (w, repo) => {
    writeFileSync(join(repo, ".git", "refs", "heads", "main"), "garbage\n");
    return repo;
  },
  "a garbage packed-refs file": (w, repo) => {
    git(repo, "pack-refs", "--all");
    writeFileSync(join(repo, ".git", "packed-refs"), "garbage\n");
    return repo;
  },
  "a linked worktree whose target is gone": (w, repo) => {
    const linked = join(w.base, "linked");
    git(repo, "worktree", "add", "-q", linked, "-b", "linked");
    rmSync(join(repo, ".git", "worktrees", "linked"), { recursive: true });
    return linked;
  },
  "a folder inside a repository with a garbage HEAD": (w, repo) => {
    writeFileSync(join(repo, ".git", "HEAD"), "garbage\n");
    mkdirSync(join(repo, "sub"));
    return join(repo, "sub");
  },
};

for (const [name, damage] of Object.entries(UNREADABLE)) {
  test(`a repository with commits and ${name}: a link refuses, says what to do, and makes no row`, (t) => {
    const w = world(t);
    w.claude("link", "--separate");
    const before = w.table("bindings.tsv"), folder = w.name();
    const project = damage(w, w.repo("broken"));
    for (const how of [["--to", folder], ["--separate"]]) {
      const refusal = /git cannot read the repository at .*made no row\. Ask the user to repair the repository, then run the link again\. Only a \.git file that points to a removed worktree is safe to delete\. Never delete a \.git folder: it holds the history and any unpushed work\.$/;
      assert.throws(() => claudeSage(["link", ...how, "--project", project], w.env), refusal);
      assert.throws(() => codexSage(["link", ...how, "--project", project], w.env), refusal);
    }
    assert.equal(w.table("bindings.tsv"), before);
    assert.deepEqual(readdirSync(w.shared).filter((entry) => /-[0-9a-f]{6}$/.test(entry)), [folder]);
  });
}

test("the refusal for a real repository that Git cannot read never tells the owner to remove its .git folder", (t) => {
  const w = world(t);
  const repo = w.repo("broken");
  writeFileSync(join(repo, ".git", "config"), "[core\n");
  assert.equal(statSync(join(repo, ".git")).isDirectory(), true);
  let said;
  try {
    claudeSage(["link", "--separate", "--project", repo], w.env);
  } catch (e) {
    said = e.message;
  }
  const advice = said.slice(said.indexOf("sage made no row.")).split(/(?<=\.) /).filter((sentence) => /\b(?:delete|remove)\b/i.test(sentence));
  assert.deepEqual(advice, [
    "Only a .git file that points to a removed worktree is safe to delete.",
    "Never delete a .git folder: it holds the history and any unpushed work.",
  ]);
  assert.equal(existsSync(join(repo, ".git", "HEAD")), true);
});

test("a row with no commits stays empty while Git cannot read the repository, its writes go on, and a repair fills it", (t) => {
  const w = world(t, { commit: false });
  w.claude("link", "--separate");
  git(w.project, "commit", "-q", "--allow-empty", "-m", "first");
  const commit = commitOf(w.project), head = join(w.project, ".git", "HEAD"), good = readFileSync(head, "utf8");
  writeFileSync(head, "garbage\n");
  assert.match(w.claude(...ADD), /T1/);
  assert.equal(w.rows()[0][2], "");
  writeFileSync(head, good);
  assert.match(w.claude(...ADD), /T2/);
  assert.equal(w.rows()[0][2], commit);
});

test("no commit is not a failed read: a real empty repository and a folder with no .git entry link to a logbook with commits", (t) => {
  const w = world(t);
  w.claude("link", "--separate");
  const folder = w.name(), empty = w.repo("empty", false), plain = join(w.base, "plain");
  mkdirSync(plain);
  for (const project of [empty, plain]) {
    assert.match(claudeSage(["link", "--to", folder, "--project", project], w.env), /now uses the shared logbook/);
    assert.equal(w.rows().find(([root]) => root === project)[2], "");
  }
});

function hangHead(project) {
  const ref = join(project, ".git", "refs", "heads", "main");
  rmSync(ref);
  execFileSync("mkfifo", [ref]);
}

test("the first-commit call runs only at the write that makes a row: a read or a later write does not wait for Git", (t) => {
  const w = world(t);
  w.claude("link", "--separate");
  hangHead(w.project);
  w.claude("status");
  assert.equal(w.claude("logbook"), join(w.shared, w.name()));
  assert.match(w.claude(...ADD), /T1/);
});

test("a first-commit call that passes the timeout refuses and makes no row", (t) => {
  const w = world(t);
  hangHead(w.project);
  assert.throws(() => w.claude("link", "--separate"), /git took more than 5 s .*made no row/);
  assert.equal(existsSync(join(w.shared, "bindings.tsv")), false);
  assert.equal(existsSync(join(w.shared, w.name())), false);
});

test("an unreadable provider root stops no project with no row, and a link there refuses: it cannot see a logbook there", (t) => {
  const w = world(t);
  w.claude("init");
  w.claude(...ADD);
  const sha = "a".repeat(40);
  w.claude("verdict", "T1", "--sha", sha, "--kind", "checks-pass");
  mkdirSync(w.env.CODEX_HOME, { recursive: true });
  chmodSync(w.env.CODEX_HOME, 0);
  try {
    assert.match(w.claude("status"), /T1/);
    assert.match(w.claude(...ADD), /T2/);
    assert.match(w.claude("merge-check", "--sha", sha), /T1 may merge/);
    const other = w.repo("other");
    assert.throws(() => claudeSage(["link", "--separate", "--project", other], w.env), /sage cannot use .*codex.*\(EACCES\), so it made no row/);
    assert.equal(existsSync(join(w.shared, "bindings.tsv")), false);
  } finally {
    chmodSync(w.env.CODEX_HOME, 0o700);
  }
});

test("a row in the shared root does not depend on a provider root: it reads with the other root unreadable", (t) => {
  const w = world(t);
  w.claude("link", "--separate");
  w.claude(...ADD);
  mkdirSync(w.env.CODEX_HOME, { recursive: true });
  chmodSync(w.env.CODEX_HOME, 0);
  try {
    assert.match(w.claude("status"), /T1/);
  } finally {
    chmodSync(w.env.CODEX_HOME, 0o700);
  }
});

for (const [name, block, path] of [
  ["a file at the shared root's path", (w) => writeFileSync(w.shared, ""), /EEXIST/],
  ["a shared root with no write right", (w) => { mkdirSync(w.shared); chmodSync(w.shared, 0o500); }, /EACCES/],
]) test(`link on ${name} refuses with the path and the next step, and makes no row`, (t) => {
  const w = world(t);
  block(w);
  try {
    assert.throws(() => w.claude("link", "--separate"), (e) => {
      assert.equal(e.constructor.name, "Refusal");
      assert.match(e.message, path);
      assert.ok(e.message.includes(`sage cannot use ${w.shared} (`) && e.message.endsWith("Ask the user to fix that path or its rights, then run the link again."), e.message);
      return true;
    });
  } finally {
    if (statSync(w.shared).isDirectory()) chmodSync(w.shared, 0o700);
  }
  assert.equal(existsSync(join(w.shared, "bindings.tsv")), false);
});

test("plugins.tsv gets each provider's row at its first locking command, never at a read, and only once", (t) => {
  const w = world(t);
  w.claude("init");
  assert.equal(existsSync(join(w.shared, "plugins.tsv")), true, "the first command that takes the lock");
  const lines = () => w.table("plugins.tsv").trim().split("\n").map((line) => line.split("\t").slice(0, 2).join(" "));
  assert.deepEqual(lines(), ["provider contract", "claude 2"]);
  const first = w.table("plugins.tsv");
  w.claude("task", "add", "--title", "x", "--size", "tiny", "--priority", "P2");
  assert.equal(w.table("plugins.tsv"), first);
  const w2 = world(t);
  assert.throws(() => w2.claude("status"), /no logbook/);
  assert.equal(existsSync(join(w2.shared, "plugins.tsv")), false, "a read writes no row");
  w.codex("init");
  assert.deepEqual(lines(), ["provider contract", "claude 2", "codex 2"]);
});

test("a shared root that cannot be written stops no legacy command: plugins.tsv only tells a later move what ran", (t) => {
  const w = world(t);
  mkdirSync(w.shared);
  chmodSync(w.shared, 0o500);
  try {
    assert.match(w.claude("init"), /^logbook /);
    assert.match(w.claude("task", "add", "--title", "x", "--size", "tiny", "--priority", "P2"), /T1/);
    assert.equal(existsSync(join(w.shared, "plugins.tsv")), false);
  } finally {
    chmodSync(w.shared, 0o700);
  }
});

const counts = (root) => JSON.parse(readFileSync(join(root, "config.json"), "utf8"));

test("a legacy project reads and writes cycle counts in the provider root, and no shared config appears", (t) => {
  const w = world(t);
  w.claude("init");
  w.claude("config", "cycles.large=4", "max_rounds=5");
  assert.deepEqual(counts(w.claudeRoot), { "cycles.large": 4, max_rounds: 5 });
  assert.equal(existsSync(join(w.shared, "config.json")), false);
  assert.match(w.claude("config"), /cycles\.large=4/);
});

test("the first shared write takes the larger of the provider values, and a shared project reads and writes them in one home", (t) => {
  const w = world(t);
  claudeSage(["config", "cycles.large=3", "max_rounds=2", "--project", w.base], w.env);
  codexSage(["config", "cycles.large=5", "max_rounds=4", "cycles.risk=3", "--project", w.base], w.env);
  w.claude("link", "--separate");
  assert.deepEqual(counts(w.shared), { "cycles.small": 1, "cycles.large": 5, "cycles.risk": 3, max_rounds: 4 });
  assert.match(w.claude("config"), /cycles\.large=5/);
  assert.match(w.codex("config"), /cycles\.large=5/);
  w.claude("config", "cycles.large=7");
  assert.equal(counts(w.shared)["cycles.large"], 7);
  assert.equal(counts(w.claudeRoot)["cycles.large"], 3);
  assert.equal(counts(w.codexRoot)["cycles.large"], 5);
  assert.match(w.codex("config"), /cycles\.large=7/);
  w.claude("config", "cycles.small=2", "arena=4", "max_agents=7", "cap_total=9");
  assert.equal(counts(w.shared)["cycles.small"], 2);
  assert.deepEqual(Object.keys(counts(w.shared)).sort(), ["cycles.large", "cycles.risk", "cycles.small", "max_rounds"]);
  assert.deepEqual([counts(w.claudeRoot).arena, counts(w.claudeRoot).max_agents, counts(w.claudeRoot).cap_total, counts(w.claudeRoot)["cycles.small"]], [4, undefined, 9, undefined]);
  assert.equal(counts(join(w.shared, w.name())).max_agents, 7, "the agent limit is the logbook's own");
  assert.equal(counts(w.codexRoot).arena, undefined);
});

test("only the first shared write takes the provider counts: a later link leaves the owner's shared count", (t) => {
  const w = world(t);
  claudeSage(["config", "cycles.large=4", "--project", w.base], w.env);
  w.claude("link", "--separate");
  assert.equal(counts(w.shared)["cycles.large"], 4);
  w.claude("config", "cycles.large=2");
  claudeSage(["config", "cycles.large=6", "--project", w.base], w.env);
  const other = w.repo("other");
  claudeSage(["link", "--separate", "--project", other], w.env);
  assert.equal(counts(w.shared)["cycles.large"], 2);
  assert.match(w.claude("config"), /cycles\.large=2/);
});

test("an invalid provider count refuses the first shared write with no row and no logbook", (t) => {
  const w = world(t);
  mkdirSync(w.codexRoot, { recursive: true });
  writeFileSync(join(w.codexRoot, "config.json"), JSON.stringify({ "cycles.large": "lots" }));
  assert.throws(() => w.claude("link", "--separate"), /cycles\.large in .*config\.json is not a number/);
  assert.equal(existsSync(join(w.shared, "bindings.tsv")), false);
  assert.equal(existsSync(join(w.shared, w.name())), false, "a refusal here leaves no half-made logbook behind");
});

const limitRows = (w) => readFileSync(join(w.shared, w.name(), "decisions.tsv"), "utf8").split("\n").filter((line) => line.includes("\tlimits "));
const limitsOf = (out) => [/(?:^| )max_agents=(\d+)/.exec(out)?.[1], /(?:^| )max_leads=(\d+)/.exec(out)?.[1]].map(Number);

test("T1056: a shared project keeps one agent limit and one lead limit in its logbook; the first write moves the largest value of the provider roots, once, with a decision row", (t) => {
  const w = world(t);
  claudeSage(["config", "max_agents=4", "cap.project=15", "max_leads=3", "--project", w.base], w.env);
  codexSage(["config", "max_agents=12", "max_leads=6", "cap.other=40", "--project", w.base], w.env);
  w.claude("link", "--separate");
  const logbook = () => counts(join(w.shared, w.name()));
  assert.deepEqual([logbook().max_agents, logbook().max_leads], [15, 6], "the larger of 15 (Claude's cap.project) and 12, and of 3 and 6; another project's cap counts for nothing");
  assert.equal(limitRows(w).length, 0, "a new logbook takes the values with no decision row");
  writeFileSync(join(w.shared, w.name(), "config.json"), JSON.stringify({ name: "Older" }));
  assert.deepEqual(limitsOf(w.codex("config")), [15, 6], "a logbook of an older version reads the same pair before its move");
  w.claude("task", "add", "--title", "x", "--size", "tiny", "--priority", "P2");
  assert.deepEqual([logbook().max_agents, logbook().max_leads, logbook().name], [15, 6, "Older"], "the first write moves the pair and keeps the other keys");
  assert.equal(limitRows(w).length, 1);
  assert.match(limitRows(w)[0], /\tlimits max_agents=15 max_leads=6\t/);
  assert.deepEqual(limitsOf(w.claude("config")), [15, 6]);
  assert.deepEqual(limitsOf(w.codex("config")), [15, 6], "the Codex chief reads the same pair");
  codexSage(["config", "max_agents=30", "--project", w.base], w.env);
  w.claude("task", "add", "--title", "y", "--size", "tiny", "--priority", "P2");
  w.codex("config", "name=Shared");
  assert.deepEqual([logbook().max_agents, logbook().name, limitRows(w).length], [15, "Shared", 1], "a later write moves nothing and writes no second row");
  w.codex("config", "max_leads=2");
  w.claude("config", "cap.project=7");
  assert.deepEqual([logbook().max_agents, logbook().max_leads, logbook().name], [7, 2, "Shared"], "config writes the limits into the logbook and keeps its other keys");
  assert.deepEqual([counts(w.claudeRoot).max_agents, counts(w.claudeRoot)["cap.project"], counts(w.codexRoot).max_leads], [4, 15, 6], "the provider roots keep their values");
  assert.deepEqual(limitsOf(w.claude("config")), [7, 2]);
  assert.deepEqual(limitsOf(w.codex("config")), [7, 2]);
  assert.equal(limitRows(w).length, 1);
});

test("T1056: a config write of a limit before any other write moves the provider values first, then sets the key", (t) => {
  const w = world(t);
  w.claude("link", "--separate");
  const file = join(w.shared, w.name(), "config.json");
  writeFileSync(file, "{}\n");
  codexSage(["config", "max_leads=7", "--project", w.base], w.env);
  claudeSage(["config", "max_agents=11", "--project", w.base], w.env);
  assert.deepEqual(limitsOf(w.codex("config")), [11, 7], "before the move, a read takes the largest value of the provider roots");
  assert.equal(limitRows(w).length, 0, "a new logbook takes the values with no decision row");
  w.codex("config", "max_agents=9");
  assert.deepEqual([counts(join(w.shared, w.name())).max_agents, counts(join(w.shared, w.name())).max_leads], [9, 7]);
  assert.equal(limitRows(w).length, 1, "the move of the emptied config wrote one row");
});

test("T1056: the move counts only the provider roots that set a limit, and the default only when no root sets one", (t) => {
  const moved = (claude, codex) => {
    const w = world(t);
    if (claude.length) claudeSage(["config", ...claude, "--project", w.base], w.env);
    if (codex.length) codexSage(["config", ...codex, "--project", w.base], w.env);
    w.claude("link", "--separate");
    const logbook = counts(join(w.shared, w.name()));
    return [logbook.max_agents, logbook.max_leads];
  };
  assert.deepEqual(moved(["cap.project=3", "max_leads=2"], []), [3, 2], "a limit lowered in one root stays low when the other root has no value");
  assert.deepEqual(moved([], ["max_agents=4"]), [4, 5], "the Codex value alone, and the default lead limit");
  assert.deepEqual(moved([], []), [10, 5], "no root sets a limit: the defaults of 10 agents and 5 leads");
  assert.deepEqual(moved(["max_agents=15", "cap.project=15", "max_leads=5"], []), [15, 5], "the values of the sage project");
});

for (const bad of ["{bad", "[]"]) test(`T1056: a damaged logbook config.json (${bad}) stops no ordinary write and leaves no write half done; a config write of a limit refuses and names the file`, (t) => {
  const w = world(t);
  w.claude("link", "--separate");
  const file = join(w.shared, w.name(), "config.json");
  writeFileSync(file, bad);
  claudeSage(["config", "max_agents=12", "--project", w.base], w.env);
  codexSage(["config", "max_agents=8", "max_leads=4", "--project", w.base], w.env);
  const rowsOf = (table) => readFileSync(join(w.shared, w.name(), `${table}.tsv`), "utf8").trim().split("\n").slice(1);
  w.claude("task", "add", "--title", "x", "--size", "tiny", "--priority", "P2");
  assert.equal(rowsOf("tasks").length, 1);
  assert.match(w.claude("run", "add", "T1", "--role", "qa"), /^R1 /);
  assert.equal(rowsOf("runs").length, 1, "one run, so a retry adds no second one");
  w.claude("run", "done", "R1", "--status", "failed");
  assert.deepEqual(rowsOf("runs").map((row) => row.includes("\tfailed\t")), [true], "a running run still ends");
  assert.deepEqual([readFileSync(file, "utf8"), limitRows(w).length], [bad, 0], "nothing moves into a damaged file");
  assert.deepEqual(limitsOf(w.claude("config")), [12, 4], "the limits stay the larger values of the provider roots");
  assert.deepEqual(limitsOf(w.codex("config")), [12, 4]);
  const refusal = refusalOf(() => w.claude("config", "cycles.small=3", "max_agents=5"));
  assert.ok(refusal.includes(file), refusal);
  assert.equal(readFileSync(file, "utf8"), bad);
  assert.notEqual(existsSync(join(w.shared, "config.json")) ? counts(w.shared)["cycles.small"] : undefined, 3, "the refused config write sets no other key either");
});

test("T1056, T1057: a Claude chief and a Codex chief of one project fill one agent limit and one lead limit; the next lead is refused, and the next run of either waits in the queue", (t) => {
  const w = world(t);
  w.claude("link", "--separate");
  w.claude("config", "max_agents=3", "max_leads=1");
  w.claude("task", "add", "--title", "claude task", "--size", "tiny", "--priority", "P2");
  w.codex("task", "add", "--title", "codex task", "--size", "tiny", "--priority", "P2");
  assert.match(w.claude("run", "add", "T1", "--role", "lead"), /^R1 /);
  assert.match(refusalOf(() => w.codex("run", "add", "T2", "--role", "lead")), /^the project has 1 running lead runs, the most it holds: R1 on T1\./, "the Claude lead fills the lead limit for the Codex chief");
  assert.match(w.codex("run", "add", "T2", "--role", "qa"), /^R2 /);
  assert.match(w.claude("run", "add", "T1", "--role", "qa"), /^R3 /);
  assert.match(w.codex("run", "add", "T2", "--role", "qa"), /^R4 is queued, place 1 · qa on T2 · .* the project runs 3 of its 3 agents\./);
  assert.match(w.claude("run", "add", "T1", "--role", "qa"), /^R5 is queued, place 2 · qa on T1 · /);
  assert.match(w.codex("run", "done", "R2", "--status", "failed"), /^R2 failed\nR4 admitted · qa on T2 · chief C2: /, "a run that ended admits the oldest queued run");
  assert.match(w.claude("run", "done", "R3", "--status", "failed"), /^R3 failed\nR5 admitted · qa on T1 · chief C1: /, "the next end admits the other chief's run");
});

test("the merge check of a shared project reads its verdicts from the shared root, its list and its counts", (t) => {
  const w = world(t);
  w.claude("link", "--separate");
  const sha = "a".repeat(40), folder = w.name();
  w.claude("task", "add", "--title", "x", "--size", "tiny", "--priority", "P2");
  w.claude("verdict", "T1", "--sha", sha, "--kind", "checks-pass");
  assert.match(w.claude("merge-check", "--sha", sha), /T1 may merge/);
  assert.match(tool.sage(["merge-check", "--sha", sha, "--project", w.project], w.env), /T1 may merge/, "from either provider");
  assert.throws(() => w.codex("merge-check", "--sha", sha), /^Error: T1 belongs to chief C1 \(claude\), not to C2\./, "T656: a Codex chief's check judges for its chief");
  const planted = join(w.shared, "planted-123456");
  mkdirSync(planted);
  for (const file of readdirSync(join(w.shared, folder)).filter((name) => name.endsWith(".tsv"))) writeFileSync(join(planted, file), readFileSync(join(w.shared, folder, file)));
  assert.throws(() => w.claude("merge-check", "--sha", sha), new RegExp(`not in the known project list \\(${join(w.shared, "projects.tsv")}\\)`));
  rmSync(planted, { recursive: true });
  writeFileSync(join(w.shared, "config.json"), JSON.stringify({ "cycles.small": "lots" }));
  assert.throws(() => w.claude("merge-check", "--sha", sha), new RegExp(`cycles\\.small in ${join(w.shared, "config.json")} is not a number`));
});

test("projects rebuild lists the root of this project's logbook", (t) => {
  const w = world(t);
  w.claude("link", "--separate");
  rmSync(join(w.shared, "projects.tsv"));
  assert.throws(() => w.claude("merge-check", "--sha", "a".repeat(40)), /known project list, is missing/);
  assert.match(w.claude("projects", "rebuild", "--accept-listing", "yes"), new RegExp(`${join(w.shared, "projects.tsv")}, the known project list, now names the 1 logbook folder`));
});

test("the worktree root follows the HOME of its env, SAGE_WORKTREES comes first, and it is never relative; a path only, so no folder is made", (t) => {
  processHome(t, "/process-home");
  assert.equal(tool.worktreeRoot({ HOME: "/scratch/home" }), "/scratch/home/sage-worktrees");
  assert.equal(tool.worktreeRoot({ HOME: "/scratch/home", SAGE_WORKTREES: "/scratch/trees" }), "/scratch/trees");
  assert.equal(tool.worktreeRoot({ HOME: "/scratch/home", SAGE_WORKTREES: "" }), "/scratch/home/sage-worktrees");
  assert.equal(tool.worktreeRoot({ HOME: "" }), "/process-home/sage-worktrees");
  assert.equal(tool.worktreeRoot({}), "/process-home/sage-worktrees");
  assert.equal(tool.worktreeRoot({ HOME: "relative-home" }), resolve("relative-home/sage-worktrees"));
  assert.equal(tool.worktreeRoot({ SAGE_WORKTREES: "relative-trees" }), resolve("relative-trees"));
});


function twoRoots(t, { named = true } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-two-roots-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const claudeRoot = join(base, "claude-root"), codexRoot = join(base, "codex-root"), shared = join(base, "shared");
  const env = { ...process.env, HOME: join(base, "home"), SAGE_HOME: claudeRoot, SAGE_SHARED_HOME: shared, SAGE_TEST_PIDS: "{}" }, codexEnv = { ...env, SAGE_HOME: codexRoot };
  const roots = () => (named ? [{ provider: "claude", path: claudeRoot }, { provider: "codex", path: codexRoot }] : [claudeRoot, codexRoot]);
  const claudeTool = createStateTool({ provider: "claude", defaultRoot: () => claudeRoot, legacyRoots: roots });
  const codexTool = createStateTool({ provider: "codex", defaultRoot: () => codexRoot, legacyRoots: roots });
  const repo = (name) => {
    const project = join(base, name);
    mkdirSync(project);
    git(project, "init", "-q", "-b", "main");
    git(project, "commit", "-q", "--allow-empty", "-m", `first of ${name}`);
    return project;
  };
  const project = repo("project");
  const runner = (tool, toolEnv) => (...args) => {
    const at = args.indexOf("--project"), where = at < 0 ? project : args[at + 1];
    const { code, text } = tool.command(at < 0 ? [...args, "--project", project] : args, toolEnv, { project: where, native: "test-chief" });
    if (code) throw new Error(text);
    return text;
  };
  const name = basename(claudeTool.storeDir(project, env)), folder = () => name;
  return { base, env, codexEnv, claudeRoot, codexRoot, shared, repo, project, claudeTool, codexTool, claude: runner(claudeTool, env), codex: runner(codexTool, codexEnv), folder };
}
const rewrite = (file, edit) => writeFileSync(file, edit(readFileSync(file, "utf8")));

test("the core names the provider of each old logbook of a project, and a bare path from an adapter still works with no name (T641)", (t) => {
  const w = twoRoots(t);
  w.claude("init");
  w.codex("init");
  const claudeDir = join(w.claudeRoot, w.folder()), codexDir = join(w.codexRoot, w.folder());
  assert.deepEqual(w.claudeTool.locate(w.project, w.env).old, [{ provider: "claude", dir: claudeDir }, { provider: "codex", dir: codexDir }]);
  assert.deepEqual(w.codexTool.locate(w.project, w.codexEnv).old, [{ provider: "codex", dir: codexDir }, { provider: "claude", dir: claudeDir }], "a tool's own root comes first");
  const bare = twoRoots(t, { named: false });
  bare.claude("init");
  bare.codex("init");
  assert.deepEqual(bare.claudeTool.locate(bare.project, bare.env).old, [{ provider: "claude", dir: join(bare.claudeRoot, bare.folder()) }, { provider: null, dir: join(bare.codexRoot, bare.folder()) }]);
  assert.match(bare.claude("task", "add", "--title", "x", "--size", "tiny", "--priority", "P2"), /^T1 /);
  const fresh = bare.repo("fresh");
  assert.deepEqual(bare.claudeTool.locate(fresh, bare.env).old, [], "a project with no logbook has no old logbook");
});

test("the Claude adapter names the Claude and the Codex root (T641)", (t) => {
  const w = world(t);
  w.claude("init");
  w.codex("init");
  const folder = basename(claudeLocate(w.project, w.env).dir);
  assert.deepEqual(claudeLocate(w.project, w.env).old, [{ provider: "claude", dir: join(w.claudeRoot, folder) }, { provider: "codex", dir: join(w.codexRoot, folder) }]);
});

test("the Codex adapter names the Claude and the Codex root, so its waitingPlugins empties when both are at contract 2 (T641)", (t) => {
  const w = world(t);
  const plugins = (...rows) => {
    mkdirSync(w.shared, { recursive: true });
    writeFileSync(join(w.shared, "plugins.tsv"), ["provider\tcontract\tat", ...rows.map((r) => `${r}\t2026-11-03T00:00:00Z`)].join("\n") + "\n");
  };
  plugins("claude\t2", "codex\t2");
  assert.deepEqual(tool.waitingPlugins(w.env), [], "both providers are at the move's contract");
  plugins("claude\t1", "codex\t2");
  assert.deepEqual(tool.waitingPlugins(w.env), [{ provider: "claude", contract: "1" }], "the Claude root has its name, so its row counts");
});

test("an adapter root with no path refuses with a message that names the entry (T641)", (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-bad-root-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const env = { ...process.env, HOME: join(base, "home"), SAGE_HOME: join(base, "root"), SAGE_SHARED_HOME: join(base, "shared"), SAGE_TEST_PIDS: "{}" };
  for (const [entry, shown] of [[null, "null"], [{ provider: "codex" }, '{"provider":"codex"}'], [undefined, "undefined"]]) {
    const bad = createStateTool({ provider: "claude", defaultRoot: () => join(base, "root"), legacyRoots: () => [entry] });
    const message = refusalOf(() => bad.waitingPlugins(env));
    assert.equal(message, `The plugin's legacyRoots gave ${shown}, but each root must be a path or { provider, path } with a path. Nothing changed. Update the sage plugin.`);
  }
});

test("a writer that found the old logbook and waited on its lock during the move refuses, and its next run writes the shared logbook (T641)", async (t) => {
  const w = twoRoots(t);
  w.claude("init");
  w.claude("task", "add", "--title", "before the move", "--size", "tiny", "--priority", "P2");
  const dir = join(w.claudeRoot, w.folder());
  const runner = join(w.base, "writer.mjs");
  writeFileSync(runner, `import { createStateTool } from ${JSON.stringify(join(REPO, "packages/sage-core/index.mjs"))};\ncreateStateTool({ provider: "claude", defaultRoot: () => ${JSON.stringify(w.claudeRoot)}, legacyRoots: () => [{ provider: "claude", path: ${JSON.stringify(w.claudeRoot)} }, { provider: "codex", path: ${JSON.stringify(w.codexRoot)} }] }).runCli();\n`);
  const saved = process.env.SAGE_TEST_PIDS;
  process.env.SAGE_TEST_PIDS = "{}";
  t.after(() => { if (saved === undefined) delete process.env.SAGE_TEST_PIDS; else process.env.SAGE_TEST_PIDS = saved; });
  const writer = spawn(process.execPath, [runner, "task", "add", "--title", "late", "--size", "tiny", "--priority", "P2", "--project", w.project], { env: { ...w.env, NODE_TEST_CONTEXT: "child" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  writer.stdout.on("data", (b) => { out += b; });
  writer.stderr.on("data", (b) => { out += b; });
  const ended = new Promise((done) => writer.on("close", done));
  const before = readFileSync(join(dir, "tasks.tsv"), "utf8");
  w.claudeTool.withLock(dir, () => {
    for (let i = 0; !readdirSync(dir).some((name) => name.startsWith(".lock.")); i++) {
      if (i > 4000) assert.fail("the writer never waited on the lock");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    writeFileSync(join(dir, "moved.json"), JSON.stringify({ folder: w.folder(), at: "2026-11-03T00:00:00Z" }) + "\n");
  });
  assert.equal(await ended, 1, out);
  assert.match(out, /this logbook moved to the shared root \(.*moved\.json\), so sage writes no more to it\. Nothing changed\. Run the command again: it then finds the shared logbook\./);
  assert.equal(readFileSync(join(dir, "tasks.tsv"), "utf8"), before, "the old logbook keeps its rows");
  mkdirSync(w.shared, { recursive: true });
  cpSync(dir, join(w.shared, w.folder()), { recursive: true, filter: (from) => basename(from) !== "moved.json" });
  writeFileSync(join(w.shared, "bindings.tsv"), `root\tfolder\tcommits\tat\n${realpathSync(w.project)}\t${w.folder()}\t${commitOf(w.project)}\t2026-11-03T00:00:00Z\n`);
  assert.match(w.claude("task", "add", "--title", "late", "--size", "tiny", "--priority", "P2"), /^T2 /);
  assert.equal(w.claudeTool.storeDir(w.project, w.env), join(w.shared, w.folder()));
  assert.equal(readFileSync(join(dir, "tasks.tsv"), "utf8"), before);
  assert.match(w.claude("status"), /T1/, "a read still works");
});

test("the id floors of the move make nextId give the next number above both old logbooks, for each prefix (T641)", (t) => {
  const w = twoRoots(t);
  w.claude("init");
  w.claude("task", "add", "--title", "old claude task", "--size", "tiny", "--priority", "P2");
  w.claude("run", "add", "T1", "--role", "qa");
  w.claude("gate", "add", "T1", "--question", "Go?", "--options", "yes|no", "--recommend", "yes");
  const renumber = (root, map) => {
    for (const name of readdirSync(join(root, w.folder())).filter((n) => n.endsWith(".tsv"))) rewrite(join(root, w.folder(), name), (text) => text.replace(/(?<![A-Za-z0-9])(T|R|G)1(?![0-9])/g, (_, p) => map[p]));
  };
  renumber(w.claudeRoot, { T: "T644", R: "R2469", G: "G103" });
  w.codex("init");
  w.codex("task", "add", "--title", "old codex task", "--size", "tiny", "--priority", "P2");
  w.codex("gate", "add", "T1", "--question", "Go?", "--options", "yes|no", "--recommend", "yes");
  w.codex("log", "-", "M4 was planned", "--why", "a milestone id in a decision counts");
  renumber(w.codexRoot, { T: "T95", R: "R1", G: "G200" });
  const fresh = w.repo("fresh");
  w.claude("init", "--project", fresh);
  const dir = w.claudeTool.storeDir(fresh, w.env);
  assert.deepEqual(w.claudeTool.read(dir, "decisions"), [], "a fresh logbook with no rows");
  const floors = w.claudeTool.writeIdFloors(dir, w.claudeTool.locate(w.project, w.env).old);
  assert.deepEqual(w.claudeTool.read(dir, "decisions").map((r) => [r.task, r.decision]), [
    ["", "T644 is the task floor of the move from claude and codex"],
    ["", "R2469 is the run floor of the move from claude and codex"],
    ["", "G200 is the gate floor of the move from claude and codex"],
    ["", "M4 is the milestone floor of the move from claude and codex"],
  ]);
  assert.equal(floors.length, 4);
  assert.match(w.claude("task", "add", "--title", "new", "--size", "tiny", "--priority", "P2", "--project", fresh), /^T645 /);
  assert.match(w.claude("run", "add", "T645", "--role", "qa", "--project", fresh), /^R2470 /);
  assert.match(w.claude("gate", "add", "T645", "--question", "Go?", "--options", "yes|no", "--recommend", "yes", "--project", fresh), /^G201 /);
  const none = w.repo("none");
  w.claude("init", "--project", none);
  const empty = w.claudeTool.storeDir(none, w.env);
  assert.deepEqual(w.claudeTool.writeIdFloors(empty, [{ provider: "claude", dir: empty }]), [], "a logbook with no id gives no floor");
  assert.deepEqual(w.claudeTool.read(empty, "decisions"), []);
});

test("an older sage reads the floor rows as they are written: plain decision rows whose first word is the id (T641)", (t) => {
  const w = twoRoots(t);
  w.claude("init");
  const dir = w.claudeTool.storeDir(w.project, w.env);
  writeFileSync(join(dir, "decisions.tsv"), ["at\ttask\tdecision\twhy",
    ...["T644 is the task floor", "R2469 is the run floor", "G103 is the gate floor"].map((d) => `2026-11-03T00:00:00Z\t\t${d} of the move from claude\tthe move keeps every new id above the ids of the old logbooks`)].join("\n") + "\n");
  assert.match(w.claude("task", "add", "--title", "new", "--size", "tiny", "--priority", "P2"), /^T645 /);
  assert.match(w.claude("run", "add", "T645", "--role", "qa"), /^R2470 /);
  assert.match(w.claude("gate", "add", "T645", "--question", "Go?", "--options", "yes|no", "--recommend", "yes"), /^G104 /);
});

test("waitingPlugins names each provider that is not at the move's contract, and an unused provider does not wait (T641)", (t) => {
  const w = twoRoots(t);
  const plugins = (...rows) => {
    mkdirSync(w.shared, { recursive: true });
    writeFileSync(join(w.shared, "plugins.tsv"), ["provider\tcontract\tat", ...rows.map((r) => `${r}\t2026-11-03T00:00:00Z`)].join("\n") + "\n");
  };
  const waiting = () => w.claudeTool.waitingPlugins(w.env);
  assert.deepEqual(waiting(), [{ provider: "claude", contract: null }, { provider: "codex", contract: null }], "no plugins.tsv: no provider is known to be ready");
  w.claude("init");
  assert.deepEqual(waiting(), [{ provider: "codex", contract: null }], "this tool's first lock writes its row at contract 2");
  plugins("claude\t2", "codex\t1");
  assert.deepEqual(waiting(), [{ provider: "codex", contract: "1" }], "a provider at contract 1 waits");
  plugins("claude\t2", "codex\tunused");
  assert.deepEqual(waiting(), [], "the owner's unused answer");
  plugins("claude\t2", "codex\t3");
  assert.deepEqual(waiting(), [], "a newer contract knows the move too");
  plugins("claude\t2", "codex\t2", "other\t1");
  assert.deepEqual(waiting(), [{ provider: "other", contract: "1" }], "a provider of plugins.tsv that no root names");
  plugins("claude\t2", "codex\tsoon");
  assert.deepEqual(waiting(), [{ provider: "codex", contract: "soon" }], "a contract that is no number and not unused");
  for (const rows of [["claude\t2", "codex\t2", "codex\t1"], ["claude\t2", "codex\t1", "codex\t2"]]) {
    plugins(...rows);
    assert.throws(() => waiting(), /plugins\.tsv has two rows for the provider "codex", so sage cannot tell which plugin contract it runs\. Nothing changed\./, "two rows for one provider, in either order");
  }
  const bare = twoRoots(t, { named: false });
  mkdirSync(bare.shared, { recursive: true });
  writeFileSync(join(bare.shared, "plugins.tsv"), "provider\tcontract\tat\nclaude\t2\tx\ncodex\t2\tx\n");
  assert.deepEqual(bare.claudeTool.waitingPlugins(bare.env), [{ provider: null, contract: null, path: bare.codexRoot }], "a root with no provider name cannot be checked");
  writeFileSync(join(w.shared, "plugins.tsv"), "provider\tcontract\nclaude\t2\n");
  assert.throws(() => waiting(), /plugins\.tsv does not start with the column names provider, contract, at/);
});

function setStates(dir, states) {
  rewrite(join(dir, "tasks.tsv"), (text) => {
    const [head, ...lines] = text.split("\n").filter(Boolean), cols = head.split("\t"), at = cols.indexOf("state");
    return [head, ...lines.map((line) => { const v = line.split("\t"); if (states[v[0]]) v[at] = states[v[0]]; return v.join("\t"); })].join("\n") + "\n";
  });
}
function moveWorld(t) {
  const w = twoRoots(t);
  const claudeDir = join(w.claudeRoot, w.folder()), codexDir = join(w.codexRoot, w.folder());
  w.claude("init");
  w.claude("task", "add", "--title", "claude done", "--size", "tiny", "--priority", "P2");
  w.claude("task", "add", "--title", "claude open", "--size", "small", "--priority", "P1", "--waits", "T1");
  w.claude("task", "add", "--title", "claude verified", "--size", "tiny", "--priority", "P2");
  w.claude("finding", "add", "T2", "--source", "sage", "--severity", "medium", "--summary", "a loose end");
  w.claude("gate", "add", "T2", "--question", "Ship it?", "--options", "yes|no", "--recommend", "yes");
  w.claude("standing", "add", "Claude order five.");
  setStates(claudeDir, { T1: "merged", T3: "verified" });
  w.codex("init");
  w.codex("task", "add", "--title", "codex open", "--size", "tiny", "--priority", "P2");
  w.codex("task", "add", "--title", "codex done", "--size", "tiny", "--priority", "P2");
  w.codex("standing", "add", "Codex order five.");
  setStates(codexDir, { T2: "merged" });
  const planOf = (preview) => /plan ([0-9a-f]{8})\n/.exec(preview)[1];
  const ask = (option = "1") => {
    const plan = planOf(w.claude("move", "--preview"));
    const gate = w.claude("move", "--plan", plan), id = /^(G\d+) /.exec(gate)[1];
    w.claude("gate", "answer", id, "--option", option);
    return { plan, gate, id };
  };
  return { ...w, claudeDir, codexDir, planOf, ask };
}

const rowsIn = (file) => {
  const [head, ...lines] = readFileSync(file, "utf8").split("\n").filter(Boolean), cols = head.split("\t");
  return lines.map((line) => Object.fromEntries(cols.map((c, i) => [c, line.split("\t")[i] ?? ""])));
};
const RECONCILED = (rows) => ["Reconciliation · every count matches the plan", "                 Claude         Codex", "table            plan  found    plan  found", ...rows, "stay, read-only: finished tasks 1 + 1; runs, verdicts, reports"].join("\n");
const MOVED_COUNTS = RECONCILED([
  "tasks (open)        2     2        1     1   match",
  "findings (open)     1     1        0     0   match",
  "gates (open)        1     1        0     0   match",
  "milestones          0     0        0     0   match",
  "standing orders     5     5        5     5   match",
  "wait links          0     0        0     0   match",
  "old rows marked     2     2        1     1   match",
]);

test("T1003: the move takes the releases by name, each name once with the first logbook's row first, and each moved task keeps its release", (t) => {
  const w = moveWorld(t);
  w.claude("release", "add", "--name", "1.0", "--goal", "The Claude goal");
  w.claude("task", "T2", "set", "release=1.0");
  w.codex("release", "add", "--name", "1.0", "--goal", "The Codex goal");
  w.codex("release", "add", "--name", "Beta");
  w.codex("task", "T1", "set", "release=Beta");
  w.claude("move", "--gate", w.ask().id);
  const dir = join(w.shared, w.folder());
  assert.deepEqual(rowsIn(join(dir, "releases.tsv")).map((r) => [r.name, r.goal]), [["1.0", "The Claude goal"], ["Beta", ""]]);
  assert.deepEqual(rowsIn(join(dir, "tasks.tsv")).filter((r) => r.release).map((r) => [r.id, r.title, r.release]), [["T4", "claude open", "1.0"], ["T6", "codex open", "Beta"]]);
  assert.deepEqual(w.claude("status").split("\n").filter((l) => l.startsWith("release ")), ["release 1.0 · in progress · 0 of 1 task done · single tasks T4 · goal: The Claude goal", "release Beta · not started · 0 of 1 task done · single tasks T6"]);
});

test("the move takes the open tasks of both old logbooks into one shared logbook, after the preview and one gate, and the board reads one project (T640)", (t) => {
  const w = moveWorld(t), folder = w.folder(), dir = join(w.shared, folder);
  const before = { claude: readFileSync(join(w.claudeDir, "tasks.tsv"), "utf8"), codex: readFileSync(join(w.codexDir, "tasks.tsv"), "utf8") };
  const preview = w.claude("move", "--preview"), plan = w.planOf(preview);
  assert.equal(preview, [
    `Move preview · project project         plan ${plan}`,
    "Read only. Nothing changed.",
    "",
    "What moves           Claude           Codex",
    "open tasks          2  T4–T5          1  T6",
    "open findings       1  new keys       0  new keys",
    "open gates          1  G3             0  none",
    "milestones          0  none           0  none",
    "standing orders     5  keep 1–5       5  become 6–10",
    "",
    `What stays (read-only, "Old" on the board)`,
    "finished tasks      1                 1",
    "runs, verdicts and kept reports never move",
    "next numbers      T7 · R1 · G4 · M1",
    "",
    "Checks",
    "ok    no running runs",
    "ok    no saved change in either logbook",
    "ok    every wait resolves (1 wait on a finished task counts as met)",
    "ok    3 folders can be written: Claude, Codex, shared",
    "ok    Claude plugin: contract 2",
    "ok    Codex plugin: contract 2",
    "note  1 task in verified goes back to reviewing",
  ].join("\n"));
  assert.equal(existsSync(dir), false, "the preview changes nothing");
  assert.equal(existsSync(join(w.shared, "moves")), false);
  assert.equal(w.claude("move", "--plan", plan), [
    `G2 · move · plan ${plan}`,
    "Move the project project into one shared logbook?",
    "3 open tasks move with new numbers. 2 finished tasks stay, read-only.",
    "Hard to undo. No command undoes the move. Each old logbook keeps a backup copy of its task table, and I give you the steps to restore by hand.",
    "Start no work in Claude or Codex until I report the end.",
    "Before you answer, check that every Claude and Codex session of this project restarted after the update.",
    "1 · move RECOMMENDED",
    "Moves the project now, exactly as in the preview.",
    "2 · keep",
    "Nothing changes. Both logbooks keep working. Ask again any time.",
    "Default: keep. Recommendation: move, because both plugins are ready and no run is running.",
    `What is "plan ${plan}"? A fingerprint of the preview above. You do not need to read it. The move runs only if both logbooks still match it, so your answer covers exactly what you saw. If anything changed, nothing moves and you get a new preview.`,
  ].join("\n"));
  assert.throws(() => w.claude("move", "--gate", "G2"), /^Error: sage: refused: G2 has no answer yet, so nothing moves\. Nothing changed\./);
  w.claude("gate", "answer", "G2", "--option", "1");
  const out = w.claude("move", "--gate", "G2");
  assert.equal(out, [
    `ok  plan ${plan} matches both logbooks`,
    "ok  locks: shared root, Claude logbook, Codex logbook",
    "1/6 plan saved",
    `2/6 new logbook built: ${folder}`,
    "3/6 old logbooks marked moved (backup copies kept)",
    "4/6 checkouts linked: 1 (this one)",
    "5/6 plan removed",
    "6/6 new logbook read again and counted",
    "",
    MOVED_COUNTS,
    "",
    `map:     ${join(dir, "move-map.html")}`,
    `backups: ${join(w.claudeDir, "tasks.before-move.tsv")}`,
    `         ${join(w.codexDir, "tasks.before-move.tsv")}`,
    "",
    "To restore by hand (no command does this). Warning: work recorded after the move stays only in the new logbook, and these steps do not bring it back.",
    "1. Stop every session of this project in Claude and in Codex.",
    "2. In each old logbook folder, replace tasks.tsv with tasks.before-move.tsv.",
    "3. In each old logbook folder, delete moved.json.",
    `4. In ${join(w.shared, "bindings.tsv")}, delete the rows that name ${folder}.`,
    `5. In ${join(w.shared, "projects.tsv")}, delete the row of ${folder}.`,
    `6. Rename the folder ${join(w.shared, folder)} to ${join(w.shared, `.${folder}.restored-${plan}`)}: the board reads no folder whose name starts with a dot. Keep it until you are sure.`,
    `7. If the plan ${join(w.shared, "moves", `${folder}.json`)} is there (an end check that did not match keeps it), rename it to ${folder}.json.aside: while it is there, every command of this project refuses.`,
  ].join("\n"));
  assert.equal(w.claudeTool.storeDir(w.project, w.env), dir);
  assert.equal(w.codexTool.storeDir(w.project, w.codexEnv), dir);
  const tasks = rowsIn(join(dir, "tasks.tsv"));
  assert.deepEqual(tasks.map((r) => [r.id, r.title, r.state, r.waits, JSON.parse(r.adoption).provider, JSON.parse(r.adoption).task]), [
    ["T4", "claude open", "framed", "", "claude", "T2"], ["T5", "claude verified", "reviewing", "", "claude", "T3"], ["T6", "codex open", "framed", "", "codex", "T1"]]);
  assert.equal(Object.hasOwn(tasks[0], "chief"), false, "each moved task starts unclaimed");
  assert.deepEqual(rowsIn(join(dir, "findings.tsv")).map((f) => [f.task, f.key, f.summary, f.run]), [["T4", "F-T4-1", "a loose end (was Claude F-T2-1)", ""]]);
  assert.deepEqual(rowsIn(join(dir, "gates.tsv")).map((g) => [g.id, g.task, g.question, g.answer]), [["G3", "T4", "Ship it?", ""]]);
  const decisions = rowsIn(join(dir, "decisions.tsv")).map((d) => [d.task, d.decision]);
  assert.deepEqual(decisions, [
    ["T4", "T4 was Claude T2"], ["T5", "T5 was Claude T3"], ["T6", "T6 was Codex T1"],
    ["", "T3 is the task floor of the move from claude and codex"], ["", "G2 is the gate floor of the move from claude and codex"]]);
  assert.equal(rowsIn(join(dir, "decisions.tsv"))[0].why, `the move from the Claude logbook ${folder}; its pages stay in ${folder}/pages/T2 of the worktree root; waits met before the move: T1 (merged)`);
  assert.match(readFileSync(join(dir, "standing.md"), "utf8"), /\n5\. Claude order five\.\n\n## From the Codex logbook \(moved \d+ [A-Z][a-z]{2}; the old Codex number in brackets\)\n\n6\. Work only in your own worktree and branch\. Never merge, never force-push, never push to main\. \(Codex 1\)\n(?:.*\n){3}10\. Codex order five\. \(Codex 5\)\n$/);
  assert.deepEqual(rowsIn(join(dir, "sources.tsv")).map((r) => [r.provider, r.path]), [["claude", w.claudeDir], ["codex", w.codexDir]]);
  assert.equal(readFileSync(join(w.claudeDir, "tasks.before-move.tsv"), "utf8"), before.claude);
  assert.equal(readFileSync(join(w.codexDir, "tasks.before-move.tsv"), "utf8"), before.codex);
  assert.deepEqual(rowsIn(join(w.claudeDir, "tasks.tsv")).map((r) => [r.id, r.moved]), [["T1", ""], ["T2", "T4"], ["T3", "T5"]]);
  assert.deepEqual(rowsIn(join(w.codexDir, "tasks.tsv")).map((r) => [r.id, r.moved]), [["T1", "T6"], ["T2", ""]]);
  assert.equal(JSON.parse(readFileSync(join(w.codexDir, "moved.json"), "utf8")).folder, folder);
  assert.deepEqual(rowsIn(join(w.shared, "bindings.tsv")).map((r) => [r.root, r.folder, r.commits]), [[realpathSync(w.project), folder, commitOf(w.project)]]);
  assert.match(readFileSync(join(w.shared, "projects.tsv"), "utf8"), new RegExp(`\n${folder}\t\\S+\tinit\n`), "the shared root knows the new logbook");
  assert.deepEqual(readdirSync(join(w.shared, "moves")), [], "the plan and the asked plan are gone");
  assert.match(w.codex("task", "add", "--title", "after", "--size", "tiny", "--priority", "P2"), /^T7 /);
  assert.match(w.claude("gate", "add", "--question", "Go?", "--options", "yes|no", "--recommend", "yes"), /^G4 /);
  assert.match(w.claude("status"), /T4/);
  const results = readBoardSources([{ id: "shared", path: w.shared }, { id: "claude", path: w.claudeRoot, provider: "claude" }, { id: "codex", path: w.codexRoot, provider: "codex" }]);
  const shared = results.find((r) => r.id === "shared");
  assert.deepEqual(shared.projects.map((p) => [p.key, p.old?.provider ?? null, (p.tables.tasks ?? []).map((task) => task.id).join(",")]), [
    [`shared/${folder}`, null, "T4,T5,T6,T7"], [`claude/${folder}`, "claude", "T1"], [`codex/${folder}`, "codex", "T2"]]);
  assert.deepEqual(shared.projects[0].notes, []);
  assert.deepEqual(results.filter((r) => r.id !== "shared").map((r) => r.projects.length), [0, 0], "an old logbook shows once, in its shared project");
  const model = buildBoardModel(results), card = (key) => model.tasks.find((task) => task.key === key);
  assert.deepEqual([card(`shared/${folder}/T4`).was, card(`shared/${folder}/T6`).was, card(`shared/${folder}/T7`).was, card(`claude/${folder}/T1`).was], ["was Claude T2", "was Codex T1", undefined, undefined]);
  assert.equal(card(`claude/${folder}/T1`).old.label, "Old · Claude · read-only");
  assert.equal(model.projects.length, 1, "one project");
  assert.match(renderBoardHtml(model), /<span class="id">T4<\/span>.*?<\/div><div class="nextline was">was Claude T2<\/div><div class="title" title="claude open">/);
  assert.match(renderTaskText(card(`shared/${folder}/T6`)), /^\*\*T6 codex open\*\* · was Codex T1\n/);
});

test("the task page of a moved task names its old logbook's folder, never a path of the Mac (F-T640-13)", (t) => {
  const w = moveWorld(t), folder = w.folder();
  w.claude("move", "--gate", w.ask().id);
  const page = renderTaskText(boardOf(w).tasks.find((task) => task.key === `shared/${folder}/T4`)).replaceAll("\\", "");
  assert.ok(page.includes(` · T4 was Claude T2 · the move from the Claude logbook ${folder}; its pages stay in ${folder}/pages/T2 of the worktree root; waits met before the move: T1 (merged)`), page);
  assert.equal(page.includes(w.base), false, "no path of the Mac");
});

test("the map page of a move lists each old and new number, the backups and the restore steps (T640)", (t) => {
  const w = moveWorld(t), { id } = w.ask();
  w.claude("move", "--gate", id);
  const page = readFileSync(join(w.shared, w.folder(), "move-map.html"), "utf8");
  for (const row of ["<td>Claude T2</td><td><b>T4</b></td><td>claude open</td>", "<td>Codex T1</td><td><b>T6</b></td><td>codex open</td>", "<td>Claude G1</td><td><b>G3</b></td><td>open gate</td>", "<td>Claude T2 F-T2-1</td><td><b>F-T4-1</b></td><td>open finding</td>"]) assert.ok(page.includes(row), row);
  assert.ok(page.includes(`<li><code>${join(w.claudeDir, "tasks.before-move.tsv")}</code></li>`));
  assert.ok(page.includes("<li>In each old logbook folder, delete moved.json.</li>"));
});

test("a move that stops after any step: every command of the project refuses and names the command, and the same command finishes it (T640)", (t) => {
  const done = ["plan saved,\n  new logbook not built yet", "new logbook built,\n  old logbooks not marked yet", "old logbooks marked,\n  checkouts not linked yet", "checkouts linked,\n  plan not removed yet"];
  for (const step of [1, 2, 3, 4]) {
    const w = moveWorld(t), { plan, id } = w.ask(), folder = w.folder();
    const stop = w.claudeTool.command(["move", "--gate", id, "--project", w.project], { ...w.env, SAGE_TEST_MOVE_STOP: String(step) });
    assert.match(stop.text, new RegExp(`test stop after step ${step}`), `the stop after step ${step}`);
    const stopped = new RegExp(`^Error: sage: refused: the move of project project did not finish\\n  stopped after step ${step} of 6 at \\d\\d:\\d\\d UTC(?:[+-]\\d\\d:\\d\\d)? \\(${done[step - 1].replace(/[()]/g, "\\$&")}\\)\\n  The plan is saved\\. Nothing is lost\\.\\n  To finish: sage move --gate ${id} \\(the same command\\)$`);
    assert.throws(() => w.claude("status"), stopped, `a read of Claude after step ${step}`);
    assert.throws(() => w.codex("task", "add", "--title", "late", "--size", "tiny", "--priority", "P2"), stopped, `a write of Codex after step ${step}`);
    assert.throws(() => w.claude("move", "--preview"), stopped);
    assert.throws(() => w.claudeTool.keepReport(w.project, { task: "T2", run: "R1", role: "qa", text: "x" }, w.env), /did not finish/, "no report is kept during the move (F-T641-15)");
    const out = w.claude("move", "--gate", id);
    assert.equal(out.split("\n")[0], `ok  saved plan found: plan ${plan}, from step ${step + 1}`);
    assert.ok(out.includes(`\n${MOVED_COUNTS}\n`), out);
    assert.deepEqual(rowsIn(join(w.shared, folder, "tasks.tsv")).map((r) => r.id), ["T4", "T5", "T6"], `the same logbook after a stop at step ${step}`);
    assert.deepEqual(rowsIn(join(w.shared, folder, "decisions.tsv")).filter((d) => / floor /.test(d.decision)).length, 2, "the floors once (F-T641-3)");
    assert.equal(readFileSync(join(w.claudeDir, "tasks.before-move.tsv"), "utf8").includes("\tmoved\n"), false, "the backup is the table before the mark");
    assert.match(w.claude("task", "add", "--title", "after", "--size", "tiny", "--priority", "P2"), /^T7 /);
  }
});

test("a move gate whose plan no longer matches the logbooks moves nothing and says what changed; a move gate answers once (T640)", (t) => {
  const w = moveWorld(t), { plan, id } = w.ask();
  w.codex("task", "add", "--title", "added after the preview", "--size", "tiny", "--priority", "P2");
  assert.throws(() => w.claude("move", "--gate", id), new RegExp(`^Error: sage: refused: the logbooks changed after plan ${plan}\\n  Codex: 1 more open task \\(T3\\)\\nNothing changed\\. G2 is closed: its answer covers plan ${plan} only, and a move gate answers once\\. Show the owner a new preview \\(sage move --preview\\), then open a new gate \\(sage move --plan <plan>\\)\\.$`));
  assert.equal(existsSync(join(w.shared, w.folder())), false);
  assert.equal(existsSync(join(w.claudeDir, "moved.json")) || existsSync(join(w.codexDir, "moved.json")), false);
  assert.equal(existsSync(join(w.shared, "moves", `${w.folder()}.json`)), false, "no plan is saved");
  assert.throws(() => w.claude("gate", "answer", id, "--option", "2"), /G2 has the answer "move" already, from the chat at \S+: the first answer wins, so this answer is not recorded\. To move later, run the preview again: sage move --preview\. Nothing changed\./);
  assert.throws(() => w.claude("gate", "add", "--question", "move · plan 1234abcd", "--options", "a|b", "--recommend", "a"), /a question that starts with "move · plan" is a move gate, and only sage move --plan opens one/);
  assert.throws(() => w.claude("move", "--plan", plan), new RegExp(`refused: plan ${plan} is not the plan of the logbooks now: the preview now gives plan [0-9a-f]{8}\\n  If plan ${plan} was typed by hand, check its 8 hex\\. If not, a logbook changed after the preview\\.\\nNothing changed\\. Show the owner the preview again`), "a gate opens only for the plan that the owner saw");
  const again = w.ask();
  assert.notEqual(again.plan, plan);
  assert.match(w.claude("move", "--gate", again.id), /\n4\/6 checkouts linked: 1 \(this one\)\n/);
  assert.deepEqual(rowsIn(join(w.shared, w.folder(), "tasks.tsv")).map((r) => r.title), ["claude open", "claude verified", "codex open", "added after the preview"]);
});

test("the owner's keep answer moves nothing, and a stale plan of a stopped move goes aside before anything is marked (T640)", (t) => {
  const kept = moveWorld(t), { id } = kept.ask("2");
  assert.throws(() => kept.claude("move", "--gate", id), /^Error: sage: refused: the owner answered G2 with "keep", so nothing moves\. Nothing changed\. To move later, run the preview again\.$/);
  assert.match(kept.claude("task", "add", "--title", "still legacy", "--size", "tiny", "--priority", "P2"), /^T4 /);
  const w = moveWorld(t), ask = w.ask();
  w.claudeTool.command(["move", "--gate", ask.id, "--project", w.project], { ...w.env, SAGE_TEST_MOVE_STOP: "2" });
  rewrite(join(w.codexDir, "tasks.tsv"), (text) => text.replace("codex open", "codex open, renamed by hand"));
  assert.throws(() => w.claude("move", "--gate", ask.id), new RegExp(`^Error: sage: refused: the logbooks changed after plan ${ask.plan}, and the move had not marked them yet\\n  Codex logbook ${w.codexDir}\\nNothing moved: the plan is removed, and the logbook it built is set aside in ${w.shared}/\\.${w.folder()}\\.stale-\\d+\\. Run the preview again\\.$`));
  assert.equal(existsSync(join(w.shared, w.folder())), false);
  assert.match(w.claude("status"), /T2/, "the old logbooks work again");
});

function zone(t, tz) {
  const saved = process.env.TZ;
  process.env.TZ = tz;
  t.after(() => { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; });
}

test("the move refuses with nothing changed: running runs, an old plugin, a folder that it cannot write (T640)", (t) => {
  zone(t, "UTC");
  const w = moveWorld(t);
  w.claude("run", "add", "T2", "--role", "qa");
  const started = rowsIn(join(w.claudeDir, "runs.tsv"))[0].started.slice(11, 16);
  assert.throws(() => w.claude("move", "--preview"), new RegExp(`^Error: sage: refused: 1 run is running in this project\\n  Claude  R1     T2    qa         started ${started} UTC\\nThe move needs zero running runs\\. Nothing changed\\.$`));
  const old = moveWorld(t);
  writeFileSync(join(old.shared, "plugins.tsv"), "provider\tcontract\tat\nclaude\t2\t2026-11-03T09:12:00Z\ncodex\t1\t2026-10-30T18:40:00Z\n");
  assert.throws(() => old.claude("move", "--preview"), /^Error: sage: refused: the Codex plugin is at contract 1; the move needs 2\n  Claude  contract 2   written 2026-11-03 09:12 UTC\n  Codex   contract 1   written 2026-10-30 18:40 UTC\nNothing changed\.$/);
  const shut = moveWorld(t);
  chmodSync(shut.claudeDir, 0o555);
  try {
    assert.throws(() => shut.codex("move", "--preview"), new RegExp(`^Error: sage: refused: cannot write the Claude logbook folder\\n  ${shut.claudeDir}  test write refused \\(no write permission\\)\\n  ${shut.codexDir}  ok\\n  ${shut.shared}  ok\\nNothing changed\\. Ask the other provider's chief to move the project\\.$`));
  } finally {
    chmodSync(shut.claudeDir, 0o755);
  }
  for (const x of [w, old, shut]) assert.equal(existsSync(join(x.shared, "moves")), false);
});

test("a provider with no plugin row: the gate offers to record it as unused and recommends keep while it has a logbook here (T640)", (t) => {
  const w = moveWorld(t);
  writeFileSync(join(w.shared, "plugins.tsv"), "provider\tcontract\tat\nclaude\t2\t2026-11-03T09:12:00Z\n");
  const preview = w.claude("move", "--preview");
  assert.match(preview, /\nok    Claude plugin: contract 2\nwarn  Codex plugin: no row in plugins\.tsv, so the gate asks whether you use Codex here\n/);
  const gate = w.claude("move", "--plan", w.planOf(preview));
  assert.match(gate, / restarted after the update\.\n1 · move, and record Codex as unused\nOnly if you do not use Codex on this project\. Sage writes "Codex: unused" and does not wait for the Codex plugin\. This answer counts for every project of this shared root: a later move or a new project does not wait for the Codex plugin either\.\n2 · keep RECOMMENDED\nNothing changes\. Both logbooks keep working\. Ask again any time\.\nDefault: keep\. Recommendation: keep\. This repository has Codex checkouts, so you likely use Codex here: update sage in Codex first, then ask again\. Choose 1 only if you never use Codex on this project\.\n/);
  assert.equal(rowsIn(join(w.claudeDir, "gates.tsv")).at(-1).options, "move, and record Codex as unused|keep");
  w.claude("gate", "answer", "G2", "--option", "1");
  assert.match(w.claude("move", "--gate", "G2"), /\nReconciliation · every count matches the plan\n/);
  assert.match(readFileSync(join(w.shared, "plugins.tsv"), "utf8"), /\ncodex\tunused\t/);
});

test("an adopted task moves with the task that adopted it: its old row gets that new number, and the branch and PR stay through adoption version 2 (T640)", (t) => {
  const w = moveWorld(t);
  const v1 = { version: 1, provider: "codex", task: "T1", logbook: realpathSync(w.codexDir), project: realpathSync(w.project), pr: "7", branch: "sage/t1-shared", round: 1, digest: "a".repeat(64), at: "2026-11-01T00:00:00Z" };
  rewrite(join(w.claudeDir, "tasks.tsv"), (text) => text.replace(/^(T2\t.*)$/m, (line) => { const v = line.split("\t"); v[6] = "sage/t1-shared"; v[7] = "7"; v[16] = JSON.stringify(v1); return v.join("\t"); }));
  const preview = w.claude("move", "--preview");
  assert.match(preview, /\nopen tasks          2  T4–T5          0  none\n/);
  assert.match(preview, /\nnote  Codex T1 is adopted by Claude T2, so it moves with it$/);
  w.claude("move", "--gate", w.ask().id);
  assert.deepEqual(rowsIn(join(w.codexDir, "tasks.tsv")).map((r) => [r.id, r.moved]), [["T1", "T4"], ["T2", ""]], "the adopted row names the task that adopted it (F7)");
  const moved = rowsIn(join(w.shared, w.folder(), "tasks.tsv"))[0], record = JSON.parse(moved.adoption);
  assert.deepEqual([moved.id, moved.branch, moved.pr, record.version, record.provider, record.task, record.pr, record.branch, record.from], ["T4", "sage/t1-shared", "7", 2, "claude", "T2", "7", "sage/t1-shared", v1]);
  const version = /--version ([0-9a-f]{64})/.exec(refusalOf(() => w.claude("run", "add", "T4", "--role", "implementer", "--branch", "sage/t1-shared")))[1];
  w.claude("claim", "T4", "--version", version);
  assert.match(w.claude("run", "add", "T4", "--role", "implementer", "--branch", "sage/t1-shared"), /^R1 /, "the branch of from is the moved task's own");
  assert.throws(() => w.claude("task", "T4", "set", "pr=8"), /T4's adoption keeps PR 7/);
});

test("a milestone moves with its tasks: new number, pilot and breakdown gate, and its approval holds (T640)", (t) => {
  const w = moveWorld(t);
  w.claude("milestone", "propose", "--name", "Two steps", "--goal", "Both land.", "--pilot", "T2");
  w.claude("gate", "answer", "G2", "--option", "1");
  const { id } = w.ask();
  assert.equal(id, "G3");
  w.claude("move", "--gate", id);
  const dir = join(w.shared, w.folder());
  assert.deepEqual(rowsIn(join(dir, "milestones.tsv")).map((p) => [p.id, p.name, p.pilot, p.gate]), [["M2", "Two steps", "T4", "G5"]]);
  assert.deepEqual(rowsIn(join(dir, "tasks.tsv")).map((r) => [r.id, r.milestone]), [["T4", "M2"], ["T5", ""], ["T6", ""]]);
  const breakdown = rowsIn(join(dir, "gates.tsv")).find((g) => g.id === "G5");
  assert.deepEqual([breakdown.task, /^Approve milestone M2[ ?]/.test(breakdown.question), breakdown.answer], ["T4", true, "approve"]);
  assert.match(w.claude("status"), /\nmilestone M2 · in progress · pilot T4: 0 of 1 merged · name: Two steps\n/, "approved, as before the move");
});

test("an older plugin stops at the moved logbook's milestone column, and a repair of the decisions keeps the move's floors (F-T641-4, F-T641-8, T995)", (t) => {
  const w = moveWorld(t);
  for (let i = 0; i < 3; i++) w.claude("run", "add", "T2", "--role", "qa");
  rewrite(join(w.claudeDir, "runs.tsv"), (text) => text.replaceAll("\trunning\t", "\tdone\t"));
  w.claude("move", "--gate", w.ask().id);
  const dir = join(w.shared, w.folder());
  assert.ok(rowsIn(join(dir, "decisions.tsv")).some((d) => d.decision === "R3 is the run floor of the move from claude and codex"));
  const old = join(w.base, "old-plugin");
  mkdirSync(old);
  execFileSync("tar", ["-x", "-C", old], { input: execFileSync("git", ["-C", REPO, "archive", "0e13a3ff", "plugins/sage/core", "plugins/sage/skills/sage"], { maxBuffer: 64 * 1024 * 1024 }) });
  w.claude("task", "add", "--title", "a chief's first write", "--size", "tiny", "--priority", "P2");
  const chief = rowsIn(join(dir, "chiefs.tsv"))[0].id;
  const older = (...args) => spawnSync(process.execPath, [join(old, "plugins/sage/skills/sage/sage.mjs"), ...args, "--chief", chief, "--project", w.project], { env: { ...w.env, NODE_TEST_CONTEXT: "child" }, encoding: "utf8" });
  const refused = older("task", "add", "--title", "older", "--size", "tiny", "--priority", "P2");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /tasks\.tsv has columns that this version of sage does not know \(milestone\): a newer sage wrote this logbook/);
  assert.equal(older("status").status, 0);
  writeFileSync(join(dir, "decisions.tsv"), "");
  assert.match(w.claude("logbook", "repair", "--accept-loss", "decisions"), /The move's id floors are in it again, from the old logbooks\./);
  assert.deepEqual(rowsIn(join(dir, "decisions.tsv")).map((d) => d.decision).filter((d) => / floor /.test(d)), [
    "T6 is the task floor of the move from claude and codex", "R3 is the run floor of the move from claude and codex", "G3 is the gate floor of the move from claude and codex"]);
});

test("a writer that found an old logbook before the move and waited on its lock never writes it after the move (T640)", async (t) => {
  const w = moveWorld(t), { id } = w.ask();
  const script = (name, args) => {
    const file = join(w.base, `${name}.mjs`);
    writeFileSync(file, `import { createStateTool } from ${JSON.stringify(join(REPO, "packages/sage-core/index.mjs"))};\nconst roots = () => [{ provider: "claude", path: ${JSON.stringify(w.claudeRoot)} }, { provider: "codex", path: ${JSON.stringify(w.codexRoot)} }];\nconst { code, text } = createStateTool({ provider: "claude", defaultRoot: () => ${JSON.stringify(w.claudeRoot)}, legacyRoots: roots }).command(${JSON.stringify([...args, "--project", w.project])}, process.env, { project: ${JSON.stringify(w.project)}, native: "test-chief" });\nconsole.log(text);\nprocess.exit(code);\n`);
    return file;
  };
  const saved = process.env.SAGE_TEST_PIDS;
  process.env.SAGE_TEST_PIDS = "{}";
  t.after(() => { if (saved === undefined) delete process.env.SAGE_TEST_PIDS; else process.env.SAGE_TEST_PIDS = saved; });
  const start = (file) => {
    const child = spawn(process.execPath, [file], { env: { ...w.env, NODE_TEST_CONTEXT: "child" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (b) => { out += b; });
    child.stderr.on("data", (b) => { out += b; });
    return new Promise((done) => child.on("close", (code) => done({ code, out })));
  };
  const waiting = (n) => readdirSync(w.claudeDir).filter((name) => name.startsWith(".lock.")).length >= n;
  let writer, mover;
  w.claudeTool.withLock(w.claudeDir, () => {
    writer = start(script("writer", ["task", "add", "--title", "late", "--size", "tiny", "--priority", "P2"]));
    for (let i = 0; !waiting(1); i++) { if (i > 4000) assert.fail("the writer never waited"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); }
    mover = start(script("mover", ["move", "--gate", id]));
    for (let i = 0; !waiting(2); i++) { if (i > 4000) assert.fail("the move never waited"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); }
  });
  const [wrote, moved] = await Promise.all([writer, mover]);
  const old = rowsIn(join(w.claudeDir, "tasks.tsv"));
  if (moved.code === 0) {
    assert.equal(wrote.code, 1, wrote.out);
    assert.match(wrote.out, /this logbook moved to the shared root/);
    assert.equal(old.some((r) => r.title === "late"), false);
  } else {
    assert.equal(wrote.code, 0, wrote.out);
    assert.match(moved.out, /refused: the logbooks changed after plan/);
    assert.equal(existsSync(join(w.shared, w.folder())), false);
    assert.equal(old.some((r) => r.title === "late"), true);
  }
});

test("the move leaves a legacy project and a shared project as they were (T640)", (t) => {
  const w = moveWorld(t), other = w.repo("other");
  const ready = readFileSync(join(w.shared, "plugins.tsv"), "utf8");
  writeFileSync(join(w.shared, "plugins.tsv"), ready.replace(/\ncodex\t2\t/, "\ncodex\t1\t"));
  w.claude("init", "--project", other);
  writeFileSync(join(w.shared, "plugins.tsv"), ready);
  w.claudeTool.command(["move", "--gate", w.ask().id, "--project", w.project], { ...w.env, SAGE_TEST_MOVE_STOP: "2" });
  assert.match(w.claude("task", "add", "--title", "legacy", "--size", "tiny", "--priority", "P2", "--project", other), /^T1 /, "another project works while a move stops");
  assert.equal(dirname(w.claudeTool.storeDir(other, w.env)), w.claudeRoot, "and keeps its legacy logbook");
  const linked = w.repo("linked");
  w.claude("link", "--separate", "--project", linked);
  assert.throws(() => w.claude("move", "--preview", "--project", linked), /^Error: sage: refused: this project already uses the shared logbook linked-[0-9a-f]{6}, so nothing moves\. Nothing changed\.$/);
  assert.match(w.claude("task", "add", "--title", "shared", "--size", "tiny", "--priority", "P2", "--project", linked), /^T1 /);
  assert.throws(() => w.claude("move", "--preview", "--project", w.repo("none")), /refused: this project has no logbook in the Claude or the Codex root, so nothing moves/);
});

function setCells(dir, id, cells) {
  rewrite(join(dir, "tasks.tsv"), (text) => {
    const [head, ...lines] = text.split("\n").filter(Boolean), cols = head.split("\t");
    return [head, ...lines.map((line) => { const v = line.split("\t"); if (v[0] === id) for (const [k, x] of Object.entries(cells)) v[cols.indexOf(k)] = x; return v.join("\t"); })].join("\n") + "\n";
  });
}
const adoptionV1 = (codexDir, project, task) => ({ version: 1, provider: "codex", task, logbook: realpathSync(codexDir), project: realpathSync(project), pr: "7", branch: `sage/${task.toLowerCase()}-shared`, round: 0, digest: "a".repeat(64), at: "2026-11-01T00:00:00Z" });
const askPlain = (w) => {
  const plan = /plan ([0-9a-f]{8})\n/.exec(w.claude("move", "--preview"))[1];
  const id = /^(G\d+) /.exec(w.claude("move", "--plan", plan))[1];
  w.claude("gate", "answer", id, "--option", "1");
  return id;
};
const stopAt = (w, id, step, project = w.project) => w.claudeTool.command(["move", "--gate", id, "--project", project], { ...w.env, SAGE_TEST_MOVE_STOP: String(step) });
const planFileOf = (w) => join(w.shared, "moves", `${w.folder()}.json`);
const boardOf = (w, options) => buildBoardModel(readBoardSources([{ id: "shared", path: w.shared }, { id: "claude", path: w.claudeRoot, provider: "claude" }, { id: "codex", path: w.codexRoot, provider: "codex" }]), options);

test("an adopted task's open gate and finding move with the task that adopted it, and the plan and the end check count them (F-T640-18)", (t) => {
  const w = moveWorld(t);
  w.codex("finding", "add", "T1", "--source", "sage", "--severity", "low", "--summary", "codex loose end");
  w.codex("gate", "add", "T1", "--question", "Codex T1 ready?", "--options", "yes|no", "--recommend", "yes");
  setCells(w.claudeDir, "T2", { branch: "sage/t1-shared", pr: "7", adoption: JSON.stringify(adoptionV1(w.codexDir, w.project, "T1")) });
  const preview = w.claude("move", "--preview");
  assert.match(preview, /\nopen findings       1  new keys       1  new keys\nopen gates          1  G3             1  G4\n/);
  const out = w.claude("move", "--gate", w.ask().id);
  assert.match(out, /\nReconciliation · every count matches the plan\n(?:.*\n){2}tasks \(open\)        2     2        0     0   match\nfindings \(open\)     1     1        1     1   match\ngates \(open\)        1     1        1     1   match\n/);
  const dir = join(w.shared, w.folder());
  assert.deepEqual(rowsIn(join(dir, "findings.tsv")).map((f) => [f.task, f.key, f.summary]), [["T4", "F-T4-1", "a loose end (was Claude F-T2-1)"], ["T4", "F-T4-2", "codex loose end (was Codex F-T1-1)"]]);
  assert.deepEqual(rowsIn(join(dir, "gates.tsv")).map((g) => [g.id, g.task, g.question]), [["G3", "T4", "Ship it?"], ["G4", "T4", "Codex T4 ready?"]], "the task id in its question is the new one too (F-T640-3)");
  const card = boardOf(w).tasks.find((task) => task.key === `shared/${w.folder()}/T4`);
  assert.deepEqual([card.findings.filter((f) => f.status === "open").length, card.gates.filter((g) => !g.answer).length], [2, 2]);
});

test("a milestone whose pilot a task of the other logbook adopted moves whole: its pilot, its breakdown gate and its members (F-T640-1)", (t) => {
  const w = twoRoots(t), claudeDir = join(w.claudeRoot, w.folder()), codexDir = join(w.codexRoot, w.folder());
  w.claude("init");
  w.claude("task", "add", "--title", "claude adopter", "--size", "small", "--priority", "P2");
  w.codex("init");
  w.codex("task", "add", "--title", "codex pilot", "--size", "small", "--priority", "P2");
  w.codex("task", "add", "--title", "codex member", "--size", "small", "--priority", "P2");
  w.codex("milestone", "propose", "--name", "Two", "--goal", "Both.", "--pilot", "T1", "--tasks", "T2");
  w.codex("gate", "answer", rowsIn(join(codexDir, "gates.tsv")).at(-1).id, "--option", "1");
  setCells(codexDir, "T1", { branch: "sage/t1-shared", pr: "7" });
  setCells(claudeDir, "T1", { branch: "sage/t1-shared", pr: "7", adoption: JSON.stringify(adoptionV1(codexDir, w.project, "T1")) });
  const out = w.claude("move", "--gate", askPlain(w));
  assert.match(out, /\nReconciliation · every count matches the plan\n/);
  assert.match(out, /\nmilestones          0     0        1     1   match\n/, "the milestone counts under the logbook that it came from");
  assert.deepEqual(readdirSync(join(w.shared, "moves")), [], "the plan is gone: the move finished");
  const dir = join(w.shared, w.folder());
  const [milestone] = rowsIn(join(dir, "milestones.tsv")), gates = rowsIn(join(dir, "gates.tsv"));
  assert.deepEqual(rowsIn(join(dir, "tasks.tsv")).map((r) => [r.id, r.title, r.milestone]), [["T3", "claude adopter", milestone.id], ["T4", "codex member", milestone.id]], "the adopter takes the milestone of the task that it adopted");
  assert.equal(milestone.pilot, "T3");
  const breakdown = gates.find((g) => g.id === milestone.gate);
  assert.deepEqual([breakdown?.task, breakdown?.answer, breakdown?.question.startsWith(`Approve milestone ${milestone.id}`)], ["T3", "approve", true], "the milestone's gate cell names its moved breakdown gate");
  assert.match(w.claude("status"), new RegExp(`\\nmilestone ${milestone.id} · not started · pilot T3: 0 of 2 merged · name: Two\\n`), "approved, as before the move");
});

test("a moved repair approval gate names the new task, so the owner's approve answer still resumes it (F-T640-3)", (t) => {
  const w = twoRoots(t), claudeDir = join(w.claudeRoot, w.folder());
  w.claude("init");
  w.claude("task", "add", "--title", "done one", "--size", "small", "--priority", "P2");
  w.claude("task", "add", "--title", "held one", "--size", "small", "--priority", "P2");
  w.codex("init");
  setStates(claudeDir, { T1: "merged" });
  setCells(claudeDir, "T2", { state: "held", hold: "round", round: "3" });
  w.claude("gate", "add", "T2", "--question", "Approve one more repair round for T2 after 3 spent rounds and limit 3?", "--options", "approve|decline", "--recommend", "approve");
  w.claude("move", "--gate", askPlain(w));
  const dir = join(w.shared, w.folder()), moved = rowsIn(join(dir, "gates.tsv")).find((g) => g.options === "approve|decline");
  assert.deepEqual([moved.id, moved.task, moved.question], ["G3", "T3", "Approve one more repair round for T3 after 3 spent rounds and limit 3?"]);
  w.claude("gate", "answer", "G3", "--option", "1");
  const version = /--version ([0-9a-f]{64})/.exec(refusalOf(() => w.claude("task", "T3", "set", "state=building", "approval=G3")))[1];
  w.claude("claim", "T3", "--version", version);
  w.claude("task", "T3", "set", "state=building", "approval=G3");
  assert.equal(rowsIn(join(dir, "tasks.tsv"))[0].state, "building");
});

test("a move from a linked clone makes the same plan, a stopped move finishes from either checkout, and the gate names each other checkout (F-T640-2, F-T640-6)", (t) => {
  for (const from of ["clone", "main"]) {
    const w = moveWorld(t), clone = join(w.base, "clone");
    git(w.base, "clone", "-q", w.project, clone);
    w.claude("init", "--project", clone);
    w.claude("task", "add", "--title", "clone open", "--size", "tiny", "--priority", "P2", "--project", clone);
    const preview = w.claude("move", "--preview");
    const plan = w.planOf(preview), gate = w.claude("move", "--plan", plan), id = /^(G\d+) /.exec(gate)[1];
    w.claude("gate", "answer", id, "--option", "1");
    if (from === "clone") {
      assert.match(w.claude("move", "--gate", id, "--project", clone), new RegExp(`^ok  plan ${plan} matches the 3 logbooks\n`));
    } else {
      assert.match(stopAt(w, id, 2).text, /test stop after step 2/);
      assert.match(refusalOf(() => w.claude("status", "--project", clone)), new RegExp(`To finish: sage move --gate ${id} \\(the same command\\)$`));
      assert.match(w.claude("move", "--gate", id, "--project", clone), new RegExp(`^ok  saved plan found: plan ${plan}, from step 3\n`), "the clone finishes the move that the main checkout started");
    }
    assert.deepEqual(readdirSync(join(w.shared, "moves")), []);
    assert.deepEqual(rowsIn(join(w.shared, w.folder(), "tasks.tsv")).map((r) => r.title), ["claude open", "claude verified", "clone open", "codex open"]);
    assert.equal(w.claudeTool.storeDir(clone, w.env), join(w.shared, w.folder()), "the clone uses the new logbook");
    assert.ok(preview.includes(`\nwarn  1 other Claude checkout of this repository:\n      the move links it to the new logbook:\n      ${clone}\n`), preview);
    assert.ok(gate.includes(`\nThe move also links 1 other checkout of this repository to the new logbook: Claude ${clone}. If one of them is a separate project, answer keep.\n`), gate);
  }
});

test("a resumed move refuses a plan whose folder, old logbooks or checkouts are not this repository's, and writes nothing there (F-T640-7)", (t) => {
  const w = moveWorld(t), { id } = w.ask(), file = planFileOf(w);
  stopAt(w, id, 2);
  const saved = readFileSync(file, "utf8"), plan = JSON.parse(saved);
  const decoy = join(w.base, "decoy-root", "decoy-abcdef");
  cpSync(w.codexDir, decoy, { recursive: true });
  writeFileSync(file, JSON.stringify({ ...plan, sources: plan.sources.map((s) => (s.provider === "codex" ? { ...s, dir: decoy } : s)) }));
  assert.equal(refusalOf(() => w.claude("move", "--gate", id)), `sage: refused: the plan ${file} names ${decoy}, which is not a logbook or a checkout of this repository now. Nothing changed. Ask the owner to check that file: sage never guesses a move.`);
  assert.equal(existsSync(join(decoy, "moved.json")), false, "the decoy gets no mark");
  writeFileSync(file, JSON.stringify({ ...plan, folder: "../outside-abcdef" }));
  assert.match(refusalOf(() => w.claude("move", "--gate", id)), /names \.\.\/outside-abcdef, which is not the folder of its file name\. Nothing changed\./);
  writeFileSync(file, JSON.stringify({ ...plan, checkouts: [...plan.checkouts, { root: join(w.base, "elsewhere"), commits: "" }] }));
  assert.match(refusalOf(() => w.claude("move", "--gate", id)), /elsewhere, which is not a logbook or a checkout of this repository now/);
  assert.equal(existsSync(join(w.claudeDir, "moved.json")), false, "a refused plan marks nothing");
  writeFileSync(file, saved);
  assert.match(w.claude("move", "--gate", id), /\nReconciliation · every count matches the plan\n/, "the true plan still finishes");
});

test("link refuses while a stopped move of the project, or of the logbook that it names, waits to finish (F-T640-9)", (t) => {
  const w = moveWorld(t), { id } = w.ask();
  stopAt(w, id, 2);
  const stopped = new RegExp(`^sage: refused: the move of project project did not finish\\n(?:.*\\n){3}  To finish: sage move --gate ${id} \\(the same command\\)$`);
  assert.match(refusalOf(() => w.claude("link", "--separate")), stopped);
  const other = w.repo("other");
  assert.match(refusalOf(() => w.claude("link", "--to", w.folder(), "--project", other)), stopped, "no checkout joins a half-built logbook");
  assert.equal(existsSync(join(w.shared, "bindings.tsv")), false, "no row");
});

test("the move's refusals show logbook text through visible(): a run's cells and a gone checkout's path (F-T640-10)", (t) => {
  const w = moveWorld(t);
  w.claude("run", "add", "T2", "--role", "qa");
  rewrite(join(w.claudeDir, "runs.tsv"), (text) => text.replace("\tqa\t", "\tqa\u001b[2J\t"));
  const running = refusalOf(() => w.claudeTool.sage(["move", "--preview", "--project", w.project], w.env));
  assert.match(running, /\n  Claude  R1     T2    qa\\x1b\[2J/);
  assert.equal(running.includes("\u001b"), false);
  const gone = moveWorld(t);
  writeFileSync(join(gone.claudeDir, "checkout.txt"), "/gone\u001b[2J/clone\n");
  const preview = gone.claudeTool.sage(["move", "--preview", "--project", gone.project], gone.env);
  assert.match(preview, /\nnote  \/gone\\x1b\[2J\/clone is gone or has no first commit in common, so it gets no link/);
  assert.equal(preview.includes("\u001b"), false);
});

test("an end check that does not match names the missing record and no command, and every command says so until the user sets the plan aside (F-T640-11)", (t) => {
  const w = moveWorld(t), { id } = w.ask(), file = planFileOf(w), dir = join(w.shared, w.folder());
  stopAt(w, id, 2);
  rewrite(join(dir, "findings.tsv"), (text) => text.split("\n")[0] + "\n");
  const out = refusalOf(() => w.claude("move", "--gate", id));
  assert.match(out, /\nfindings \(open\)     1     0        0     0   MISMATCH\n/);
  assert.ok(out.startsWith("sage: refused: the end check of the move of project project does not match the plan\nok  saved plan found: plan "), out);
  assert.equal(out.split("missing in the new logbook: F-T4-1 (was Claude F-T2-1)").length, 2, out);
  assert.ok(out.endsWith([
    "",
    "  The move ran, but the new logbook does not hold every record of the plan. Nothing was deleted: each old logbook still holds its records.",
    `  Start no work in this project: every command of it refuses while the plan is at ${file}.`,
    "  Running the move again does not change this. To set the plan aside, the owner:",
    `  1. compares the new logbook ${dir} with the old logbooks and the map ${dir}/move-map.html;`,
    `  2. renames ${file} to ${file}.aside. The commands of this project then use the new logbook as it is.`,
    "  To use the old logbooks again instead, the owner follows the restore steps at the end of the map.",
  ].join("\n")), out);
  assert.equal(out.includes("Nothing is lost"), false);
  const status = refusalOf(() => w.claude("status"));
  assert.match(status, /^sage: refused: the end check of the move of project project does not match the plan\n  missing in the new logbook: F-T4-1 \(was Claude F-T2-1\)\n/);
  assert.equal(/To finish|the same command/.test(status), false, "no command that only prints the mismatch again");
  renameSync(file, `${file}.aside`);
  assert.match(w.claude("status"), /T4/, "the step that the text gives sets the plan aside");
});

test("the move prints the Mac's own time with its zone, which the board's UTC times agree with: a stopped move, a running run and the map page (F-T640-15, F-T640-26)", (t) => {
  zone(t, "Asia/Tokyo");
  const w = moveWorld(t), { id } = w.ask();
  stopAt(w, id, 2);
  const tokyo = (iso) => new Date(Date.parse(iso) + 9 * 3600000).toISOString().slice(11, 16);
  const plan = JSON.parse(readFileSync(planFileOf(w), "utf8"));
  assert.match(refusalOf(() => w.claude("status")), new RegExp(`\\n  stopped after step 2 of 6 at ${tokyo(plan.at)} UTC\\+09:00 \\(`));
  const local = new Date(Date.parse(plan.saved) + 9 * 3600000).toISOString(), utc = plan.saved;
  assert.ok(readFileSync(join(w.shared, w.folder(), "move-map.html"), "utf8").includes(` on ${local.slice(0, 10)} at ${local.slice(11, 16)} UTC+09:00 (${utc.slice(0, 10)} ${utc.slice(11, 16)} UTC on the board). `), "the map page names the zone too");
  const r = moveWorld(t);
  r.claude("run", "add", "T2", "--role", "qa");
  assert.match(refusalOf(() => r.claude("move", "--preview")), new RegExp(`qa         started ${tokyo(rowsIn(join(r.claudeDir, "runs.tsv"))[0].started)} UTC\\+09:00\\n`));
});

test("a zone behind UTC with half an hour prints its offset with a minus sign (F-T640-26)", (t) => {
  zone(t, "America/St_Johns");
  const n = moveWorld(t);
  n.claude("run", "add", "T2", "--role", "qa");
  assert.match(refusalOf(() => n.claude("move", "--preview")), /qa         started \d\d:\d\d UTC-0[23]:30\n/);
});

test("after the printed restore steps the board shows each task once, and a later move and a second restore work (F-T640-19, F-T640-29)", (t) => {
  const w = moveWorld(t), folder = w.folder();
  const moveAndRestore = () => {
    const { plan, id } = w.ask(), out = w.claude("move", "--gate", id);
    const name = new RegExp(`\\n6\\. Rename the folder \\S+/${folder} to \\S+/(\\.${folder}\\.restored[^:\\s]*): the board reads no folder whose name starts with a dot\\. Keep it until you are sure\\.\\n7\\. `).exec(out)?.[1];
    assert.ok(name, out);
    for (const d of [w.claudeDir, w.codexDir]) { renameSync(join(d, "tasks.before-move.tsv"), join(d, "tasks.tsv")); rmSync(join(d, "moved.json")); }
    const drop = (file, column) => { const [head, ...lines] = readFileSync(file, "utf8").split("\n").filter(Boolean); writeFileSync(file, [head, ...lines.filter((l) => l.split("\t")[column] !== folder)].join("\n") + "\n"); };
    drop(join(w.shared, "bindings.tsv"), 1);
    drop(join(w.shared, "projects.tsv"), 0);
    renameSync(join(w.shared, folder), join(w.shared, name));
    return { name, plan };
  };
  const first = moveAndRestore();
  assert.deepEqual(boardOf(w).tasks.map((task) => task.title).sort(), ["claude done", "claude open", "claude verified", "codex done", "codex open"], "each task once, from its old logbook");
  assert.match(w.claude("status"), /T2/, "the old logbooks work again");
  const second = moveAndRestore();
  for (const { name, plan } of [first, second]) assert.equal(name, `.${folder}.restored-${plan}`, "the dot name holds the move's plan");
  assert.notEqual(second.name, first.name, "the second restore has a free name");
  assert.deepEqual(readdirSync(w.shared).filter((n) => n.includes(folder)).sort(), [first.name, second.name].sort(), "both restored folders stay, and no new logbook");
  assert.deepEqual(boardOf(w).tasks.map((task) => task.title).sort(), ["claude done", "claude open", "claude verified", "codex done", "codex open"]);
  assert.match(w.claude("move", "--gate", w.ask().id), /\nReconciliation · every count matches the plan\n/, "a later move works");
});

test("a later logbook's standing lines with no number stay under their order or heading, and the end check counts them (F-T640-21)", (t) => {
  const w = moveWorld(t);
  writeFileSync(join(w.codexDir, "standing.md"), "# Standing orders\n\nEvery brief carries these lines word for word. Add a line when you notice that you repeat an instruction.\n\nA note before the list.\n\n1. Codex order one,\n   and its second line that matters.\n2. Codex order two.\n\nA hand note under the list.\n");
  const out = w.claude("move", "--gate", w.ask().id);
  assert.match(out, /\nstanding orders     5     5        2     2   match\nstanding notes      0     0        3     3   match\n/);
  assert.match(readFileSync(join(w.shared, w.folder(), "standing.md"), "utf8"), /\n## From the Codex logbook \(moved [^)]*\)\n\nA note before the list\.\n\n6\. Codex order one, \(Codex 1\)\n   and its second line that matters\.\n7\. Codex order two\. \(Codex 2\)\n\nA hand note under the list\.\n$/);
});

test("a move plan that cannot be read names its file, and does not call it this project's (F-T640-22)", (t) => {
  const w = moveWorld(t), file = join(w.shared, "moves", "elsewhere-abcdef.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "{ not json");
  assert.equal(refusalOf(() => w.claude("status")), `sage: refused: a move plan in the shared root cannot be read: ${file}. Sage cannot tell which project it moves, so every project of this shared root refuses. Nothing changed. Ask the owner to check that file: sage never guesses a move.`);
});

test("a moved gate's question names the same finding after the move: a finding key maps whole, and one that does not move stays (F-T640-23)", (t) => {
  const w = moveWorld(t);
  w.claude("finding", "add", "T2", "--source", "sage", "--severity", "medium", "--summary", "two");
  w.claude("finding", "add", "T2", "--source", "sage", "--severity", "medium", "--summary", "three");
  w.claude("finding", "triage", "T2", "F-T2-1", "dismiss", "--reason", "not real");
  w.claude("gate", "add", "T2", "--question", "Move F-T2-2 to a follow-up task? F-T2-1 is dismissed, and T2 keeps F-T2-3.", "--options", "move|keep", "--recommend", "move");
  const asked = rowsIn(join(w.claudeDir, "gates.tsv")).at(-1).id;
  w.claude("gate", "answer", asked, "--option", "1");
  w.claude("move", "--gate", w.ask().id);
  const dir = join(w.shared, w.folder());
  assert.deepEqual(rowsIn(join(dir, "findings.tsv")).map((f) => [f.key, f.summary]), [["F-T4-1", "two (was Claude F-T2-2)"], ["F-T4-2", "three (was Claude F-T2-3)"]]);
  const moved = rowsIn(join(dir, "gates.tsv")).find((g) => g.options === "move|keep" && g.answer === "move");
  assert.equal(moved.question, "Move F-T4-1 to a follow-up task? F-T2-1 is dismissed, and T4 keeps F-T4-2.", "the approval names the finding \"two\", as before the move");
});

test("a resumed plan must name the old logbook of this repository that holds its answered move gate: a plan with no old logbook writes nothing (F-T640-7, F-T640-25)", (t) => {
  const w = moveWorld(t), { id } = w.ask(), file = join(w.shared, "moves", "other-abcdef.json");
  mkdirSync(join(w.shared, "other-abcdef"), { recursive: true });
  writeFileSync(join(w.shared, "other-abcdef", "tasks.tsv"), `${readFileSync(join(w.claudeDir, "tasks.tsv"), "utf8").split("\n")[0]}\n`);
  const planted = { version: 1, folder: "other-abcdef", checkout: realpathSync(w.project), sources: [], checkouts: [{ root: realpathSync(w.project), commits: "" }], gate: { id, dir: w.claudeDir }, step: 3, saved: "2026-11-03T00:00:00Z", at: "2026-11-03T00:00:00Z", digest: "0".repeat(64), raw: {}, marks: [], map: { tasks: [], findings: [], gates: [], milestones: [], standing: [], waits: {}, finished: {} } };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(planted));
  const check = "Nothing changed. Ask the owner to check that file: sage never guesses a move.";
  let out;
  try { out = w.claude("move", "--gate", id); } catch (e) { out = e.message; }
  assert.equal(existsSync(join(w.shared, "bindings.tsv")), false, `no row links the checkout to the planted folder (the move printed: ${out.split("\n")[0]})`);
  assert.equal(out, `sage: refused: the plan ${file} names no old logbook of this repository that holds its answered move gate ${id}. ${check}`);
  writeFileSync(file, JSON.stringify({ ...planted, sources: [{ provider: "claude", dir: w.claudeDir, checkout: realpathSync(w.project) }] }));
  assert.match(refusalOf(() => w.claude("move", "--gate", id)), /names no old logbook of this repository that holds its answered move gate/);
  assert.equal(existsSync(join(w.claudeDir, "moved.json")), false, "a refused plan marks nothing");
  rmSync(file);
  assert.match(w.claude("move", "--gate", id), /\nReconciliation · every count matches the plan\n/, "the true move still runs");
});

test("the end check prints a missing record's old id through visible() (F-T640-24)", (t) => {
  const w = moveWorld(t), dir = join(w.shared, w.folder());
  rewrite(join(w.claudeDir, "findings.tsv"), (text) => text.replace("\tF-T2-1\t", "\tF-T2-1\u001b[2J\t"));
  const { id } = w.ask();
  stopAt(w, id, 2);
  rewrite(join(dir, "findings.tsv"), (text) => text.split("\n")[0] + "\n");
  const out = refusalOf(() => w.claudeTool.sage(["move", "--gate", id, "--project", w.project], w.env));
  assert.ok(out.includes("\nmissing in the new logbook: F-T4-1 (was Claude F-T2-1\\x1b[2J)\n"), out);
  assert.equal(out.includes("\u001b"), false);
});

test("an open gate of a finished task refuses the preview, because no one could answer it after the move (F-T640-27)", (t) => {
  const w = moveWorld(t);
  const row = { id: "G9", task: "T1", question: "Still want the docs?", options: "yes|no", recommendation: "yes", default: "no", answer: "", at: "2026-11-03T00:00:00Z" };
  rewrite(join(w.claudeDir, "gates.tsv"), (text) => `${text.trimEnd()}\n${text.split("\n")[0].split("\t").map((c) => row[c] ?? "").join("\t")}\n`);
  assert.equal(refusalOf(() => w.claude("move", "--preview")), [
    "sage: refused: 1 open gate is of a finished task, and a finished task does not move, so no one could answer it after the move",
    "  Claude  G9     T1    merged     Still want the docs? (options: 1 yes, 2 no)",
    "Nothing changed. Ask the owner to answer it first. The chief of the gate's provider records the answer (sage gate answer <G> --option <n>): the Claude chief for a Claude gate. Then run the preview again.",
  ].join("\n"));
  w.claude("gate", "answer", "G9", "--option", "2");
  assert.match(w.claude("move", "--preview"), /^Move preview · /, "an answered gate of a finished task stays, and the move goes on");
});

test("the refusal lists every open gate of a finished task, each with its task, state and question (F-T640-34)", (t) => {
  const w = moveWorld(t);
  const gateRow = (dir, row) => rewrite(join(dir, "gates.tsv"), (text) => `${text.trimEnd()}\n${text.split("\n")[0].split("\t").map((c) => row[c] ?? "").join("\t")}\n`);
  gateRow(w.claudeDir, { id: "G9", task: "T1", question: "Still want the docs?", options: "yes|no", recommendation: "yes", default: "no", answer: "", at: "2026-11-03T00:00:00Z" });
  gateRow(w.codexDir, { id: "G4", task: "T2", question: "Keep the\u001b[2Jold flag?", options: "yes|no", recommendation: "yes", default: "no", answer: "", at: "2026-11-03T00:00:00Z" });
  assert.equal(refusalOf(() => w.claude("move", "--preview")), [
    "sage: refused: 2 open gates are of a finished task, and a finished task does not move, so no one could answer them after the move",
    "  Claude  G9     T1    merged     Still want the docs? (options: 1 yes, 2 no)",
    "  Codex   G4     T2    merged     Keep the\\x1b[2Jold flag? (options: 1 yes, 2 no)",
    "Nothing changed. Ask the owner to answer each one first. The chief of the gate's provider records the answer (sage gate answer <G> --option <n>): the Claude chief for a Claude gate, the Codex chief for a Codex gate. Then run the preview again.",
  ].join("\n"));
});

test("two tasks with the same finding key keep their own findings: round keys map by task, and a gate's key through its own task (F-T640-32)", (t) => {
  const w = moveWorld(t);
  w.claude("finding", "add", "T2", "--source", "sage", "--severity", "medium", "--summary", "T2 own F1", "--key", "F1");
  w.claude("finding", "add", "T3", "--source", "sage", "--severity", "medium", "--summary", "T3 own F1", "--key", "F1");
  rewrite(join(w.claudeDir, "tasks.tsv"), (text) => {
    const [head, ...lines] = text.trimEnd().split("\n"), col = head.split("\t").indexOf("keys");
    return [head, ...lines.map((l) => { const c = l.split("\t"); if (c[0] === "T2" || c[0] === "T3") c[col] = "F1"; return c.join("\t"); })].join("\n") + "\n";
  });
  w.claude("gate", "add", "T2", "--question", "Move F1 to a follow-up task?", "--options", "move|keep", "--recommend", "move");
  w.claude("gate", "add", "T3", "--question", "Fix F1 in T3 now?", "--options", "fix|wait", "--recommend", "fix");
  const row = { id: "G9", task: "", question: "F-T2-1 first, or F1?", options: "first|F1", recommendation: "first", default: "first", answer: "", at: "2026-11-03T00:00:00Z" };
  rewrite(join(w.claudeDir, "gates.tsv"), (text) => `${text.trimEnd()}\n${text.split("\n")[0].split("\t").map((c) => row[c] ?? "").join("\t")}\n`);
  w.claude("move", "--gate", w.ask().id);
  const dir = join(w.shared, w.folder()), tasks = rowsIn(join(dir, "tasks.tsv")), gates = rowsIn(join(dir, "gates.tsv"));
  assert.deepEqual(rowsIn(join(dir, "findings.tsv")).map((f) => [f.task, f.key, f.summary]), [["T4", "F-T4-1", "a loose end (was Claude F-T2-1)"], ["T4", "F-T4-2", "T2 own F1 (was Claude F1)"], ["T5", "F-T5-1", "T3 own F1 (was Claude F1)"]]);
  assert.deepEqual(tasks.filter((x) => x.keys).map((x) => [x.id, x.keys]), [["T4", "F-T4-2"], ["T5", "F-T5-1"]], "each task's round keys name its own finding");
  assert.equal(gates.find((g) => g.options === "move|keep").question, "Move F-T4-2 to a follow-up task?", "T2's gate names T2's finding");
  assert.equal(gates.find((g) => g.options === "fix|wait").question, "Fix F-T5-1 in T5 now?", "T3's gate names T3's finding");
  assert.equal(gates.find((g) => g.options === "first|F1").question, "F-T4-1 first, or F1?");
});

test("a later logbook's own heading before its first order stays, and the end check counts it (F-T640-31)", (t) => {
  const w = moveWorld(t);
  writeFileSync(join(w.codexDir, "standing.md"), "# Standing orders\n\nEvery agent reads these orders before it starts; a brief points to them. Add a line when you notice that you repeat an instruction.\n\n# My own title line\n\n1. Codex order one.\n");
  const out = w.claude("move", "--gate", w.ask().id);
  assert.match(out, /\nstanding orders     5     5        1     1   match\nstanding notes      0     0        1     1   match\n/);
  assert.match(readFileSync(join(w.shared, w.folder(), "standing.md"), "utf8"), /\n## From the Codex logbook \(moved [^)]*\)\n\n# My own title line\n\n6\. Codex order one\. \(Codex 1\)\n$/);
});

test("the board shows a banner for 7 days after a move, with the map page by name only (F-T640-4)", (t) => {
  const w = moveWorld(t), folder = w.folder();
  w.claude("move", "--gate", w.ask().id);
  const at = rowsIn(join(w.shared, folder, "sources.tsv"))[0].at, after = (days) => boardOf(w, { now: new Date(Date.parse(at) + days * 86400000).toISOString() });
  const text = `3 open tasks have new numbers, and each card shows its old number. Finished tasks stay in Done as Old and read-only. The old-to-new map is move-map.html in the logbook folder ${folder}, on this Mac.`;
  const html = renderBoardHtml(after(1));
  assert.ok(html.includes(`<div class="banner info moved" role="status"><div><b>project moved to one shared logbook on ${at.slice(0, 10)} ${at.slice(11, 16)} UTC.</b> ${text}</div></div>`));
  assert.equal(html.includes(w.base), false, "no path of the Mac on the board");
  assert.ok(renderBoardText(after(1)).replaceAll("\\", "").includes(`⇢ project moved to one shared logbook on ${at.slice(0, 10)} ${at.slice(11, 16)} UTC. ${text}`));
  assert.equal(renderBoardHtml(after(8)).includes("moved to one shared logbook"), false, "gone after 7 days, as Done is");
});

function restoreByHand(w, plan) {
  const folder = w.folder();
  for (const d of [join(w.claudeRoot, folder), join(w.codexRoot, folder)]) { renameSync(join(d, "tasks.before-move.tsv"), join(d, "tasks.tsv")); rmSync(join(d, "moved.json")); }
  const drop = (file, column) => { const [head, ...lines] = readFileSync(file, "utf8").split("\n").filter(Boolean); writeFileSync(file, [head, ...lines.filter((l) => l.split("\t")[column] !== folder)].join("\n") + "\n"); };
  drop(join(w.shared, "bindings.tsv"), 1);
  drop(join(w.shared, "projects.tsv"), 0);
  renameSync(join(w.shared, folder), join(w.shared, `.${folder}.restored-${plan}`));
  if (existsSync(planFileOf(w))) renameSync(planFileOf(w), `${planFileOf(w)}.aside`);
}

test("a move gate moves once: after a restore by hand its answer moves nothing, and a new gate moves the project (F-T647-1)", (t) => {
  const w = moveWorld(t), folder = w.folder(), { id, plan } = w.ask();
  w.claude("move", "--gate", id);
  restoreByHand(w, plan);
  const used = `sage: refused: ${id} moved this project once already, and a move gate moves once: after a restore by hand, the owner answers a new gate. Nothing changed. Run sage move --preview, then open a new gate with sage move --plan <plan>.`;
  assert.equal(refusalOf(() => w.claude("move", "--gate", id)), used);
  assert.equal(existsSync(join(w.shared, folder)), false, "the old answer built no new logbook");
  assert.equal(existsSync(join(w.claudeDir, "moved.json")), false, "and marked nothing");
  assert.ok(rowsIn(join(w.claudeDir, "decisions.tsv")).some((d) => d.decision === `${id} moved this project to the shared logbook ${folder} with plan ${plan}`), "the logbook of the gate keeps that the gate moved");
  rewrite(join(w.claudeDir, "decisions.tsv"), (text) => text.split("\n").filter((l) => !l.includes(" moved this project to the shared logbook ")).join("\n"));
  assert.equal(refusalOf(() => w.claude("move", "--gate", id)), used);
  assert.match(w.claude("move", "--gate", w.ask().id), /\nReconciliation · every count matches the plan\n/, "the owner's new answer moves it");
});

test("after an end check that does not match, the restore steps name the plan file last, and they free the project in both providers (F-T640-45)", (t) => {
  const w = moveWorld(t), { id, plan } = w.ask(), file = planFileOf(w), folder = w.folder(), dir = join(w.shared, folder);
  stopAt(w, id, 2);
  rewrite(join(dir, "findings.tsv"), (text) => text.split("\n")[0] + "\n");
  assert.match(refusalOf(() => w.claude("move", "--gate", id)), /does not match the plan/);
  const steps = [...readFileSync(join(dir, "move-map.html"), "utf8").matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]);
  assert.deepEqual(steps.slice(-2), [
    `Rename the folder ${dir} to ${join(w.shared, `.${folder}.restored-${plan}`)}: the board reads no folder whose name starts with a dot. Keep it until you are sure.`,
    `If the plan ${file} is there (an end check that did not match keeps it), rename it to ${folder}.json.aside: while it is there, every command of this project refuses.`,
  ]);
  restoreByHand(w, plan);
  assert.match(w.claude("status"), /T2/, "Claude works on its old logbook again");
  assert.match(w.codex("task", "add", "--title", "after the restore", "--size", "tiny", "--priority", "P2"), /^T\d+ /, "and Codex on its own");
  assert.match(w.claude("move", "--gate", w.ask().id), /\nReconciliation · every count matches the plan\n/, "a later move works");
});

test("an owner's own heading that starts with \"## From the \" stays in its part, and the end check matches (F-T640-48)", (t) => {
  const w = moveWorld(t);
  rewrite(join(w.codexDir, "standing.md"), (text) => text.replace(/\n1\. /, "\n## From the design review\n\n1. "));
  rewrite(join(w.claudeDir, "standing.md"), (text) => `${text}\n## From the retro\n\nKeep the retro notes short.\n`);
  const out = w.claude("move", "--gate", w.ask().id);
  assert.match(out, /\nReconciliation · every count matches the plan\n/, out);
  assert.match(out, /\nstanding orders     5     5        5     5   match\nstanding notes      0     0        1     1   match\n/);
});

test("a milestone whose pilot merged moves whole: the pilot as a merged task, its breakdown approval and its done count (F-T640-59)", (t) => {
  const w = moveWorld(t), dir = join(w.shared, w.folder());
  w.claude("task", "add", "--title", "pilot", "--size", "small", "--priority", "P1");
  w.claude("task", "add", "--title", "member", "--size", "small", "--priority", "P1");
  w.claude("milestone", "propose", "--name", "Two", "--goal", "Both land.", "--pilot", "T4", "--tasks", "T5");
  w.claude("gate", "answer", "G2", "--option", "1");
  setStates(w.claudeDir, { T4: "merged" });
  assert.match(w.claude("status"), /\nmilestone M1 · in progress · pilot T4: 1 of 2 merged · name: Two\n/);
  const preview = w.claude("move", "--preview");
  assert.match(preview, /\nopen tasks          3  T6–T7, T9      1  T10\n/);
  assert.match(preview, /\nfinished tasks      1                 1\n/);
  assert.match(preview, /\nnote  1 finished task moves with its milestone, as it is: Claude T4 \(merged\)$/);
  const out = w.claude("move", "--gate", w.ask().id);
  assert.match(out, /\nReconciliation · every count matches the plan\n/, out);
  assert.deepEqual(rowsIn(join(dir, "milestones.tsv")).map((p) => [p.id, p.pilot, p.gate]), [["M2", "T8", "G5"]]);
  assert.deepEqual(rowsIn(join(dir, "tasks.tsv")).map((r) => [r.id, r.title, r.state, r.milestone]), [
    ["T6", "claude open", "framed", ""], ["T7", "claude verified", "reviewing", ""], ["T8", "pilot", "merged", "M2"], ["T9", "member", "framed", "M2"], ["T10", "codex open", "framed", ""]]);
  assert.equal(rowsIn(join(dir, "gates.tsv")).find((g) => g.id === "G5").answer, "approve", "the breakdown approval holds");
  assert.match(w.claude("status"), /\nmilestone M2 · in progress · pilot T8: 1 of 2 merged · name: Two\n/, "the same done count as before the move");
  assert.deepEqual(rowsIn(join(w.claudeDir, "tasks.tsv")).map((r) => [r.id, r.moved]), [["T1", ""], ["T2", "T6"], ["T3", "T7"], ["T4", "T8"], ["T5", "T9"]]);
  assert.equal(boardOf(w).tasks.filter((task) => task.title === "pilot").length, 1, "the pilot shows once, in the shared logbook");
});

test("a task moved after a key of its repair round closed keeps that key, so its next round is round 2, not a replan (F-T640-61)", (t) => {
  const w = moveWorld(t), dir = join(w.shared, w.folder());
  w.claude("finding", "add", "T2", "--source", "sage", "--severity", "medium", "--summary", "second");
  for (const key of ["F-T2-1", "F-T2-2"]) w.claude("finding", "triage", "T2", key, "fix");
  setStates(w.claudeDir, { T2: "reviewing" });
  assert.match(w.claude("round", "T2"), /^T2 repairing · round 1 of \d+ · fix F-T2-1,F-T2-2 /);
  w.claude("finding", "close", "T2", "F-T2-1");
  setStates(w.claudeDir, { T2: "reviewing" });
  w.claude("move", "--gate", w.ask().id);
  const moved = rowsIn(join(dir, "tasks.tsv")).find((r) => r.id === "T4");
  const version = /--version ([0-9a-f]{64})/.exec(refusalOf(() => w.claude("round", "T4")))?.[1];
  if (version) w.claude("claim", "T4", "--version", version);
  assert.deepEqual([moved.round, moved.keys], ["1", "F-T4-2,F-T4-1"], "the closed key F-T2-1 is F-T4-2, and the open F-T2-2 is F-T4-1");
  assert.match(w.claude("round", "T4"), /^T4 repairing · round 2 of \d+ · fix F-T4-1 /, "as before the move: F-T2-1 closed, so the round fixed one key");
  assert.equal(rowsIn(join(dir, "tasks.tsv")).find((r) => r.id === "T4").keys, "F-T4-1", "round 2 holds only the open key");
  assert.match(w.claude("finding", "add", "T4", "--source", "sage", "--severity", "low", "--summary", "new"), /^F-T4-3 /, "a new finding never takes the carried key F-T4-2");
  assert.deepEqual(rowsIn(join(dir, "decisions.tsv")).filter((d) => d.task === "T4").map((d) => d.decision).slice(0, 2), ["T4 was Claude T2", "F-T4-2 was the round key F-T2-1 of Claude T2, whose finding closed before the move"]);
});

test("a repair of the decisions keeps a carried round key taken, so a finding after the next round takes a fresh key (F-T648-5)", (t) => {
  const w = moveWorld(t), dir = join(w.shared, w.folder());
  w.claude("finding", "add", "T2", "--source", "sage", "--severity", "medium", "--summary", "second");
  for (const key of ["F-T2-1", "F-T2-2"]) w.claude("finding", "triage", "T2", key, "fix");
  setStates(w.claudeDir, { T2: "reviewing" });
  w.claude("round", "T2");
  w.claude("finding", "close", "T2", "F-T2-1");
  setStates(w.claudeDir, { T2: "reviewing" });
  w.claude("move", "--gate", w.ask().id);
  writeFileSync(join(dir, "decisions.tsv"), "");
  w.claude("logbook", "repair", "--accept-loss", "decisions");
  assert.ok(rowsIn(join(dir, "decisions.tsv")).some((d) => d.task === "T4" && d.decision === "F-T4-2 is a round key of T4 with no finding"));
  const version = /--version ([0-9a-f]{64})/.exec(refusalOf(() => w.claude("round", "T4")))?.[1];
  if (version) w.claude("claim", "T4", "--version", version);
  assert.match(w.claude("round", "T4"), /^T4 repairing · round 2 of \d+ · fix F-T4-1 /);
  assert.match(w.claude("finding", "add", "T4", "--source", "sage", "--severity", "low", "--summary", "new"), /^F-T4-3 /, "a new finding never takes the carried key F-T4-2");
});

test("after a restore by hand, a new task or gate takes a number above the move's map (F-T640-47)", (t) => {
  const w = moveWorld(t), { id, plan } = w.ask();
  w.claude("move", "--gate", id);
  restoreByHand(w, plan);
  assert.match(w.claude("task", "add", "--title", "after the restore", "--size", "tiny", "--priority", "P2"), /^T7 /);
  assert.match(w.codex("task", "add", "--title", "after the restore", "--size", "tiny", "--priority", "P2"), /^T7 /);
  assert.match(w.claude("gate", "add", "--question", "Go?", "--options", "yes|no", "--recommend", "yes"), /^G4 /);
  assert.deepEqual(rowsIn(join(w.codexDir, "decisions.tsv")).map((d) => d.decision).filter((d) => d !== "task added"), [`T6 is the task floor of the move to the shared logbook ${w.folder()}`, `G3 is the gate floor of the move to the shared logbook ${w.folder()}`]);
});

test("a chain of adoptions gives every old row the number of the task that moves, and the end check matches (F-T640-49)", (t) => {
  const w = moveWorld(t), dir = join(w.shared, w.folder());
  w.codex("task", "add", "--title", "codex adopter", "--size", "tiny", "--priority", "P2");
  const v1 = (provider, task, logbook, branch, pr) => JSON.stringify({ version: 1, provider, task, logbook: realpathSync(logbook), project: realpathSync(w.project), pr, branch, round: 1, digest: "a".repeat(64), at: "2026-11-01T00:00:00Z" });
  setCells(w.claudeDir, "T2", { branch: "sage/t1-a", pr: "7", adoption: v1("codex", "T1", w.codexDir, "sage/t1-a", "7") });
  setCells(w.codexDir, "T3", { branch: "sage/t2-b", pr: "8", adoption: v1("claude", "T2", w.claudeDir, "sage/t2-b", "8") });
  const out = w.claude("move", "--gate", w.ask().id);
  assert.match(out, /\nReconciliation · every count matches the plan\n/, out);
  assert.deepEqual(rowsIn(join(w.claudeDir, "tasks.tsv")).map((r) => [r.id, r.moved]), [["T1", ""], ["T2", "T5"], ["T3", "T4"]]);
  assert.deepEqual(rowsIn(join(w.codexDir, "tasks.tsv")).map((r) => [r.id, r.moved]), [["T1", "T5"], ["T2", ""], ["T3", "T5"]]);
  assert.deepEqual(rowsIn(join(dir, "tasks.tsv")).map((r) => [r.id, r.title]), [["T4", "claude verified"], ["T5", "codex adopter"]]);
  assert.deepEqual(rowsIn(join(dir, "findings.tsv")).map((f) => [f.task, f.key]), [["T5", "F-T5-1"]], "the finding of Claude T2 moves with the task that adopted it");
});

const STOPPED = /^sage: refused: the move of project project did not finish\n  stopped after step 2 of 6 .*\n.*\n.*\n  To finish: sage move --gate G2 \(the same command\)\n$/;
async function waitingWriter(t, root = (w) => w.codexRoot, { aside, said = STOPPED, finish = !aside } = {}) {
  const w = moveWorld(t), { id } = w.ask(), file = planFileOf(w), codexRoot = root(w);
  stopAt(w, id, 2);
  let plan = readFileSync(file, "utf8");
  if (aside) plan = JSON.stringify({ ...JSON.parse(plan), sources: JSON.parse(plan).sources.map((s) => (s.dir === w.codexDir ? { ...s, dir: aside(w) } : s)) });
  rmSync(file);
  const runner = join(w.base, "codex-writer.mjs");
  writeFileSync(runner, `import { createStateTool } from ${JSON.stringify(join(REPO, "packages/sage-core/index.mjs"))};\nconst roots = () => [{ provider: "claude", path: ${JSON.stringify(w.claudeRoot)} }, { provider: "codex", path: ${JSON.stringify(codexRoot)} }];\nconst { code, text } = createStateTool({ provider: "codex", defaultRoot: () => ${JSON.stringify(codexRoot)}, legacyRoots: roots }).command(${JSON.stringify(["task", "add", "--title", "late", "--size", "tiny", "--priority", "P2", "--project", w.project])}, process.env, { project: ${JSON.stringify(w.project)}, native: "test-chief" });\nconsole.log(text);\nprocess.exit(code);\n`);
  const saved = process.env.SAGE_TEST_PIDS;
  process.env.SAGE_TEST_PIDS = "{}";
  t.after(() => { if (saved === undefined) delete process.env.SAGE_TEST_PIDS; else process.env.SAGE_TEST_PIDS = saved; });
  const before = readFileSync(join(w.codexDir, "tasks.tsv"), "utf8");
  let writer;
  w.codexTool.withLock(w.codexDir, () => {
    const child = spawn(process.execPath, [runner], { env: { ...w.codexEnv, SAGE_HOME: codexRoot, NODE_TEST_CONTEXT: "child" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (b) => { out += b; });
    child.stderr.on("data", (b) => { out += b; });
    writer = new Promise((done) => child.on("close", (code) => done({ code, out })));
    for (let i = 0; !readdirSync(w.codexDir).some((name) => name.startsWith(".lock.")); i++) {
      if (i > 4000) assert.fail("the writer never waited on the lock");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    writeFileSync(file, plan);
    writeFileSync(join(w.claudeDir, "tasks.before-move.tsv"), readFileSync(join(w.claudeDir, "tasks.tsv"), "utf8"));
    writeFileSync(join(w.claudeDir, "moved.json"), `${JSON.stringify({ folder: w.folder(), shared: w.shared, gate: id, at: JSON.parse(plan).saved })}\n`);
  });
  const wrote = await writer;
  assert.equal(wrote.code, 1, wrote.out);
  assert.match(wrote.out, said);
  assert.equal(readFileSync(join(w.codexDir, "tasks.tsv"), "utf8"), before, "the unmarked logbook keeps its rows");
  if (finish) assert.match(w.claude("move", "--gate", id), /\nReconciliation · every count matches the plan\n/, "the same command finishes the move");
}
test("a writer that waited on an old logbook's lock refuses while a move plan names that logbook, so a stop inside step 3 still finishes (T647)", (t) => waitingWriter(t));
test("a waiting writer whose root is a link to the old root refuses too (F-T648-1)", (t) => waitingWriter(t, (w) => {
  const link = join(w.base, "codex-link");
  symlinkSync(w.codexRoot, link);
  return link;
}));
test("a waiting writer whose root differs in letter case refuses too, on a volume that ignores case (F-T648-1)", (t) => {
  const probe = realpathSync(mkdtempSync(join(tmpdir(), "sage-case-")));
  t.after(() => rmSync(probe, { recursive: true, force: true }));
  if (!existsSync(probe.toUpperCase())) return t.skip("this volume tells letter case apart, so the other case is another folder");
  return waitingWriter(t, (w) => join(w.base, "CODEX-ROOT"));
});

function finishFromAlias(t, alias) {
  const w = moveWorld(t), { id } = w.ask();
  stopAt(w, id, 2);
  const claudeRoot = alias(w, w.claudeRoot, "claude"), codexRoot = alias(w, w.codexRoot, "codex");
  const codexTool = createStateTool({ provider: "codex", defaultRoot: () => codexRoot, legacyRoots: () => [{ provider: "claude", path: claudeRoot }, { provider: "codex", path: codexRoot }] });
  const { code, text } = codexTool.command(["move", "--gate", id, "--project", w.project], { ...w.codexEnv, SAGE_HOME: codexRoot }, { project: w.project, native: "test-chief" });
  assert.equal(code, 0, text);
  assert.match(text, /\nReconciliation · every count matches the plan\n/);
  assert.deepEqual(readdirSync(join(w.shared, "moves")), [], "the plan is gone: the move finished");
  assert.deepEqual(rowsIn(join(w.shared, w.folder(), "tasks.tsv")).map((r) => r.title), ["claude open", "claude verified", "codex open"]);
}
test("a stopped move finishes from the other provider when its roots are links to the mover's roots (F-T648-4)", (t) => finishFromAlias(t, (w, root, name) => {
  const link = join(w.base, `${name}-link`);
  symlinkSync(root, link);
  return link;
}));
test("a stopped move finishes from the other provider when its roots differ in letter case, on a volume that ignores case (F-T648-4)", (t) => {
  const probe = realpathSync(mkdtempSync(join(tmpdir(), "sage-case-")));
  t.after(() => rmSync(probe, { recursive: true, force: true }));
  if (!existsSync(probe.toUpperCase())) return t.skip("this volume tells letter case apart, so the other case is another folder");
  return finishFromAlias(t, (w, root) => join(w.base, basename(root).toUpperCase()));
});

function aliasPlan(w) {
  const link = join(w.base, "claude-link");
  symlinkSync(w.claudeRoot, link);
  const file = join(w.shared, "moves", "elsewhere-abcdef.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ folder: "elsewhere-abcdef", gate: { id: "G9" }, step: 2, sources: [{ provider: "claude", dir: join(link, w.folder()) }], checkouts: [] }));
}
test("a read of the project refuses while a plan names its logbook by another path (F-T648-2)", (t) => {
  const w = moveWorld(t);
  aliasPlan(w);
  assert.match(refusalOf(() => w.claude("status")), /^sage: refused: the move of project elsewhere did not finish\n/);
});
test("a move preview refuses while a plan names an old logbook of the project by another path (F-T648-2)", (t) => {
  const w = moveWorld(t);
  aliasPlan(w);
  assert.match(refusalOf(() => w.claude("move", "--preview")), /^sage: refused: the move of project elsewhere did not finish\n/);
  assert.equal(existsSync(join(w.shared, w.folder())), false, "no new logbook");
});

for (const [what, dir] of [["a dir with a NUL byte", "/tmp/sage-\u0000-nul"], ["a dir with a name too long", `/tmp/${"x".repeat(300)}/${"y".repeat(5000)}`], ["a missing dir", "/sage-t648-missing/project-abcdef"], ["a dir under a file", "/dev/null/project-abcdef"]]) {
  test(`a writer writes when another project's plan names ${what} (F-T648-3)`, (t) => {
    const w = moveWorld(t), file = join(w.shared, "moves", "elsewhere-abcdef.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ folder: "elsewhere-abcdef", gate: { id: "G9" }, step: 2, sources: [{ provider: "claude", dir }], checkouts: [] }));
    assert.match(w.claude("task", "add", "--title", "after", "--size", "tiny", "--priority", "P2"), /^T4 /);
    assert.equal(rowsIn(join(w.claudeDir, "tasks.tsv")).at(-1).title, "after");
  });
}

const UNREAD = (code) => new RegExp(`^sage: refused: sage cannot read .* \\(${code}\\), so it cannot tell whether a move plan names this logbook through it\\. Nothing changed\\.`);
const asRoot = () => process.getuid?.() === 0;
const shut = (w, root = w.claudeRoot) => {
  const locked = join(w.base, "locked");
  mkdirSync(locked, { recursive: true });
  symlinkSync(root, join(locked, "root"));
  chmodSync(locked, 0);
  return { locked, dir: join(locked, "root", w.folder()) };
};
for (const [what, code, aside] of [
  ["behind a folder that sage cannot search", "EACCES", (w) => shut(w).dir],
  ["through a link loop", "ELOOP", (w) => {
    const loop = join(w.base, "loop");
    symlinkSync(loop, loop);
    return join(loop, w.folder());
  }],
]) {
  test(`a writer refuses while a plan names a logbook ${what}, and changes nothing (F-T648-6)`, (t) => {
    if (code === "EACCES" && asRoot()) return t.skip("root searches a folder of mode 000, so the folder does not shut the path");
    const w = moveWorld(t), file = join(w.shared, "moves", "elsewhere-abcdef.json");
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ folder: "elsewhere-abcdef", gate: { id: "G9" }, step: 2, sources: [{ provider: "claude", dir: aside(w) }], checkouts: [] }));
      const before = readFileSync(join(w.claudeDir, "tasks.tsv"), "utf8");
      assert.match(refusalOf(() => w.claude("task", "add", "--title", "after", "--size", "tiny", "--priority", "P2")), UNREAD(code));
      assert.equal(readFileSync(join(w.claudeDir, "tasks.tsv"), "utf8"), before, "no task is added");
    } finally {
      if (existsSync(join(w.base, "locked"))) chmodSync(join(w.base, "locked"), 0o700);
    }
  });
}
test("a writer that waited on an old logbook's lock refuses while the plan names that logbook behind a folder that sage cannot search (F-T648-6)", async (t) => {
  if (asRoot()) return t.skip("root searches a folder of mode 000, so the folder does not shut the path");
  let locked;
  try {
    await waitingWriter(t, undefined, {
      aside: (w) => { const it = shut(w, w.codexRoot); locked = it.locked; return it.dir; },
      said: UNREAD("EACCES"),
    });
  } finally {
    if (locked) chmodSync(locked, 0o700);
  }
});
test("a stopped move refuses to finish while its plan names an old logbook behind a folder that sage cannot search, and changes nothing (F-T648-6)", (t) => {
  if (asRoot()) return t.skip("root searches a folder of mode 000, so the folder does not shut the path");
  const w = moveWorld(t), { id } = w.ask(), file = planFileOf(w);
  stopAt(w, id, 2);
  let locked;
  try {
    const plan = JSON.parse(readFileSync(file, "utf8")), it = shut(w, w.codexRoot);
    locked = it.locked;
    writeFileSync(file, JSON.stringify({ ...plan, sources: plan.sources.map((s) => (s.dir === w.codexDir ? { ...s, dir: it.dir } : s)) }));
    const saved = readFileSync(file, "utf8"), before = readFileSync(join(w.codexDir, "tasks.tsv"), "utf8");
    assert.match(refusalOf(() => w.claude("move", "--gate", id)), UNREAD("EACCES"));
    assert.equal(readFileSync(file, "utf8"), saved, "the plan stays");
    assert.equal(readFileSync(join(w.codexDir, "tasks.tsv"), "utf8"), before, "the unmarked logbook keeps its rows");
  } finally {
    if (locked) chmodSync(locked, 0o700);
  }
});

function ruleThree(t, rows, options) {
  const w = twoRoots(t, options);
  const plugins = (...lines) => {
    mkdirSync(w.shared, { recursive: true });
    writeFileSync(join(w.shared, "plugins.tsv"), ["provider\tcontract\tat", ...lines.map((r) => `${r}\t2026-11-03T00:00:00Z`)].join("\n") + "\n");
  };
  plugins(...rows);
  const bound = () => (existsSync(join(w.shared, "bindings.tsv")) ? rowsIn(join(w.shared, "bindings.tsv")) : []);
  return { ...w, plugins, bound };
}
const SHARED_INIT = (checkout, dir) => `${checkout} now uses the shared logbook ${dir}. Every plugin is ready, so the project starts there.`;

test("rule 3: a new project starts in the shared root when both plugins are at contract 2, or the other is unused (T642)", (t) => {
  for (const codex of ["2", "unused"]) {
    const w = ruleThree(t, ["claude\t2", `codex\t${codex}`]), dir = join(w.shared, w.folder());
    assert.equal(w.claude("init"), SHARED_INIT(w.project, dir), `codex ${codex}`);
    assert.deepEqual(w.bound().map((r) => [r.root, r.folder, r.commits]), [[w.project, w.folder(), commitOf(w.project)]]);
    assert.equal(existsSync(join(w.claudeRoot, w.folder())), false, "no legacy logbook");
    assert.equal(existsSync(join(w.codexRoot, w.folder())), false);
    assert.equal(w.claude("init"), `logbook ${dir}`, "a second init checks the shared logbook");
    assert.match(w.codex("task", "add", "--title", "from codex", "--size", "tiny", "--priority", "P2"), /^T1 /, "the other provider writes the same logbook");
    assert.equal(rowsIn(join(dir, "tasks.tsv"))[0].title, "from codex");
  }
});

test("rule 3: a new project starts legacy, as before, while a plugin is below contract 2, has no row, or has a root with no name (T642)", (t) => {
  for (const [by, rows, options] of [["claude", ["claude\t2", "codex\t1"]], ["claude", ["claude\t2"]], ["codex", ["claude\t1", "codex\t2"]], ["claude", ["claude\t2", "codex\t2"], { named: false }]]) {
    const w = ruleThree(t, rows, options);
    assert.equal(w[by]("init"), `logbook ${join(by === "claude" ? w.claudeRoot : w.codexRoot, w.folder())}`, rows.join(" "));
    assert.deepEqual(w.bound(), []);
    assert.equal(existsSync(join(w.shared, w.folder())), false);
    if (options) continue;
    w.plugins("claude\t2", "codex\t2");
    assert.match(w[by]("init", "--project", w.repo("after")), / now uses the shared logbook /, "after the update, the next new project starts shared");
  }
});

test("rule 3: a legacy logbook of the repository in either root wins, also a clone's, so the project starts legacy (T642)", (t) => {
  for (const [first, second] of [["claude", "codex"], ["codex", "claude"]]) {
    const w = ruleThree(t, ["claude\t1", "codex\t1"]), root = (p) => (p === "claude" ? w.claudeRoot : w.codexRoot);
    w[first]("init");
    w.plugins("claude\t2", "codex\t2");
    assert.equal(w[second]("init"), `logbook ${join(root(second), w.folder())}`, `a ${first} logbook, then ${second} init`);
    const clone = join(w.base, "clone");
    git(w.base, "clone", "-q", w.project, clone);
    assert.match(w[second]("init", "--project", clone), new RegExp(`^logbook ${root(second)}/clone-[0-9a-f]{6}$`), "a clone of a legacy project");
    assert.deepEqual(w.bound(), []);
    const fresh = w.repo("fresh");
    assert.match(w[second]("init", "--project", fresh), / now uses the shared logbook /, "another repository in the same roots starts shared");
    assert.deepEqual(w.bound().map((r) => r.root), [fresh]);
  }
});

test("rule 3: a checkout with the first commit of a shared logbook gets the link prompt from init, not a new logbook (T642)", (t) => {
  const w = ruleThree(t, ["claude\t2", "codex\t2"]);
  w.claude("init");
  const clone = join(w.base, "clone");
  git(w.base, "clone", "-q", w.project, clone);
  const said = refusalOf(() => w.claude("init", "--project", clone));
  assert.match(said, new RegExp(`\\*\\*This folder has no logbook yet:\\*\\* ${clone}\\n`));
  assert.match(said, new RegExp(`for 1, sage link --to ${w.folder()}; for 2, sage link --separate\\.$`));
  assert.deepEqual(w.bound().map((r) => r.root), [w.project], "no row for the clone");
  assert.deepEqual(readdirSync(w.shared).filter((name) => name.startsWith("clone-")), []);
});

test("rule 3: a repository with no commit yet starts shared, and its row gets the first commit at a later write (T642)", (t) => {
  const w = ruleThree(t, ["claude\t2", "codex\t2"]), empty = join(w.base, "empty");
  mkdirSync(empty);
  git(empty, "init", "-q", "-b", "main");
  const said = w.claude("init", "--project", empty), [row] = w.bound();
  assert.equal(said, SHARED_INIT(empty, join(w.shared, row.folder)));
  assert.deepEqual([row.root, row.commits], [empty, ""]);
  git(empty, "commit", "-q", "--allow-empty", "-m", "first");
  w.claude("task", "add", "--title", "after the first commit", "--size", "tiny", "--priority", "P2", "--project", empty);
  assert.equal(w.bound()[0].commits, commitOf(empty));
});

function milestoneWorld(t) {
  const w = moveWorld(t);
  w.claude("task", "add", "--title", "pilot", "--size", "small", "--priority", "P1");
  w.claude("task", "add", "--title", "member", "--size", "small", "--priority", "P1");
  w.claude("milestone", "propose", "--name", "Two", "--goal", "Both land.", "--pilot", "T4", "--tasks", "T5");
  w.claude("gate", "answer", "G2", "--option", "1");
  setStates(w.claudeDir, { T4: "merged" });
  return w;
}

test("the same --plan again shows the open gate and opens no second one, and an older move gate names the newer one (F-T640-43)", (t) => {
  const w = moveWorld(t), plan = w.planOf(w.claude("move", "--preview"));
  const first = w.claude("move", "--plan", plan);
  assert.equal(w.claude("move", "--plan", plan), first, "the same gate text again");
  assert.equal(rowsIn(join(w.claudeDir, "gates.tsv")).filter((g) => g.question.startsWith("move · plan")).length, 1, "no second gate");
  const newer = w.planOf(w.claude("move", "--preview"));
  assert.match(w.claude("move", "--plan", newer), /^G3 · move · plan /);
  w.claude("gate", "answer", "G2", "--option", "1");
  assert.equal(refusalOf(() => w.claude("move", "--gate", "G2")), `sage: refused: G2 is an older move gate: G3 asks about plan ${newer}, of a later preview. Nothing changed. Ask the owner to answer G3, then run sage move --gate G3.`);
  w.claude("gate", "answer", "G3", "--option", "1");
  assert.match(w.claude("move", "--gate", "G3"), /\nReconciliation · every count matches the plan\n/);
});

test("a move gate takes an id above the gates of every old logbook, so two chiefs' gates never share an id (F-T640-64, F-T640-65)", (t) => {
  const w = moveWorld(t);
  w.codex("gate", "add", "--question", "Codex first?", "--options", "yes|no", "--recommend", "yes");
  const claudeGate = /^(G\d+) /.exec(w.claude("move", "--plan", w.planOf(w.claude("move", "--preview"))))[1];
  const codexGate = /^(G\d+) /.exec(w.codex("move", "--plan", w.planOf(w.codex("move", "--preview"))))[1];
  assert.deepEqual([claudeGate, codexGate], ["G2", "G3"], "the Codex gate is above the Claude move gate G2");
  w.codex("gate", "answer", codexGate, "--option", "1");
  assert.match(w.codex("move", "--gate", codexGate), /\nReconciliation · every count matches the plan\n/);
});

test("a move gate whose plan no longer matches leaves no asked plan in the moves folder (F-T640-66)", (t) => {
  const w = moveWorld(t), { id } = w.ask();
  assert.deepEqual(readdirSync(join(w.shared, "moves")), [`${w.folder()}.${id}.asked.json`]);
  w.codex("task", "add", "--title", "added after the preview", "--size", "tiny", "--priority", "P2");
  assert.match(refusalOf(() => w.claude("move", "--gate", id)), /^sage: refused: the logbooks changed after plan /);
  assert.deepEqual(readdirSync(join(w.shared, "moves")), []);
});

test("a stopped move whose saved plan rows changed by hand does not match its fingerprint and writes nothing (F-T640-50)", (t) => {
  const w = moveWorld(t), { id } = w.ask(), file = planFileOf(w);
  stopAt(w, id, 1);
  const plan = JSON.parse(readFileSync(file, "utf8"));
  plan.rows.tasks[0].title = "changed by hand";
  writeFileSync(file, JSON.stringify(plan));
  assert.equal(refusalOf(() => w.claude("move", "--gate", id)), `sage: refused: the plan ${file} does not match its own fingerprint, so its rows are not the rows that the owner's answer covers. Nothing changed. Ask the owner to check that file: sage never guesses a move.`);
  assert.equal(existsSync(join(w.shared, w.folder())), false, "no new logbook");
  assert.equal(existsSync(join(w.claudeDir, "moved.json")), false);
});

test("a damaged adoption cell, of an open task or of a finished task of a milestone, refuses the preview and names its file and row (F-T647-2)", (t) => {
  for (const id of ["T2", "T4"]) {
    const w = milestoneWorld(t);
    setCells(w.claudeDir, id, { adoption: "{not json" });
    assert.equal(refusalOf(() => w.claude("move", "--preview")), `sage: refused: ${join(w.claudeDir, "tasks.tsv")} has a damaged adoption cell in the row of ${id}, so the move cannot keep the task's record. Nothing changed. Ask the owner to fix that row.`, id);
  }
});

test("a milestone whose breakdown gate its logbook lost moves with a gate number that names no gate, and the board reads its milestones (F-T640-38)", (t) => {
  const w = milestoneWorld(t), dir = join(w.shared, w.folder());
  rewrite(join(w.claudeDir, "gates.tsv"), (text) => text.split("\n").filter((line) => !line.startsWith("G2\t")).join("\n"));
  w.claude("move", "--gate", w.ask().id);
  const [milestone] = rowsIn(join(dir, "milestones.tsv"));
  assert.match(milestone.gate, /^G\d+$/, "never an empty gate cell");
  assert.equal(rowsIn(join(dir, "gates.tsv")).some((g) => g.id === milestone.gate), false, "it names no gate, as before the move");
  const shared = readBoardSources([{ id: "shared", path: w.shared }, { id: "claude", path: w.claudeRoot, provider: "claude" }, { id: "codex", path: w.codexRoot, provider: "codex" }]).find((r) => r.id === "shared");
  assert.deepEqual(shared.projects[0].diagnostics.filter((d) => d.startsWith("milestones")), [], "the board reads milestones.tsv");
  assert.deepEqual(shared.projects[0].tables.milestones.map((p) => p.id), [milestone.id]);
});

function carriedWorld(t) {
  const w = moveWorld(t);
  w.claude("finding", "add", "T2", "--source", "sage", "--severity", "medium", "--summary", "second");
  for (const key of ["F-T2-1", "F-T2-2"]) w.claude("finding", "triage", "T2", key, "fix");
  setStates(w.claudeDir, { T2: "reviewing" });
  w.claude("round", "T2");
  w.claude("finding", "close", "T2", "F-T2-1");
  setStates(w.claudeDir, { T2: "reviewing" });
  w.claude("move", "--gate", w.ask().id);
  return { ...w, dir: join(w.shared, w.folder()) };
}

test("a repair of the decisions after round 2 started keeps the carried round key taken, from the task's adoption record (F-T648-7)", (t) => {
  const w = carriedWorld(t);
  const version = /--version ([0-9a-f]{64})/.exec(refusalOf(() => w.claude("round", "T4")))?.[1];
  if (version) w.claude("claim", "T4", "--version", version);
  assert.match(w.claude("round", "T4"), /^T4 repairing · round 2 of \d+ · fix F-T4-1 /);
  assert.equal(rowsIn(join(w.dir, "tasks.tsv")).find((r) => r.id === "T4").keys, "F-T4-1", "the carried key left the keys cell");
  writeFileSync(join(w.dir, "decisions.tsv"), "");
  w.claude("logbook", "repair", "--accept-loss", "decisions");
  assert.match(w.claude("finding", "add", "T4", "--source", "sage", "--severity", "low", "--summary", "new"), /^F-T4-3 /, "a new finding never takes the carried key F-T4-2");
});

test("after a repair of the decisions, the line about the move's id floors prints only when those floors came back (F-T648-8)", (t) => {
  const w = carriedWorld(t);
  rmSync(join(w.dir, "sources.tsv"));
  writeFileSync(join(w.dir, "decisions.tsv"), "");
  const out = w.claude("logbook", "repair", "--accept-loss", "decisions");
  assert.equal(out.includes("id floors"), false, out);
  assert.ok(rowsIn(join(w.dir, "decisions.tsv")).some((d) => d.decision === "F-T4-2 is a round key of T4 with no finding"));
});

test("the status line shows a move gate by its plan and its question, not its whole text (F-T640-55)", (t) => {
  const w = moveWorld(t), plan = w.planOf(w.claude("move", "--preview"));
  w.claude("move", "--plan", plan);
  const line = w.claude("status").split("\n").find((l) => l.startsWith("gates "));
  assert.ok(line.endsWith(` · G2 move · plan ${plan} · Move the project project into one shared logbook? (default: keep)`), line);
});

test("the preview's checks name each folder that it can write, also two logbooks of one provider (F-T640-40)", (t) => {
  const w = moveWorld(t), clone = join(w.base, "clone");
  git(w.base, "clone", "-q", w.project, clone);
  w.claude("init", "--project", clone);
  const own = basename(w.claudeTool.storeDir(clone, w.env));
  assert.ok(w.claude("move", "--preview").includes(`\nok    4 folders can be written: Claude (${w.folder()}), Claude (${own}), Codex, shared\n`));
});

test("a waits refusal names the chief of the logbook's provider that runs the command (F-T640-60)", (t) => {
  const w = moveWorld(t);
  w.codex("task", "add", "--title", "dropped", "--size", "tiny", "--priority", "P2");
  w.codex("task", "add", "--title", "waits", "--size", "tiny", "--priority", "P2", "--waits", "T3");
  setStates(w.codexDir, { T3: "abandoned" });
  assert.match(refusalOf(() => w.claude("move", "--preview")), /Change its waits first \(sage task T4 set waits=<task ids>; the Codex chief runs it\), then run the preview again\.$/);
});

test("an open move gate shows under Needs you on the board, and no longer after its answer (F-T640-41)", (t) => {
  const w = moveWorld(t), plan = w.planOf(w.claude("move", "--preview"));
  w.claude("move", "--plan", plan);
  const need = boardOf(w).milestoneNeeds.find((n) => n.kind === "move");
  assert.deepEqual([need?.title, need?.text], ["The move gate G2 waits for your answer", "Move the project project into one shared logbook? Answer the gate in the chat: the chief puts it to you word for word, with its options and its recommendation."]);
  assert.match(renderBoardText(boardOf(w)), /The move gate G2 waits for your answer/);
  w.claude("gate", "answer", "G2", "--option", "2");
  assert.equal(boardOf(w).milestoneNeeds.some((n) => n.kind === "move"), false);
});

test("the move banner says that the finished tasks of a moved milestone have new numbers too (F-T647-5)", (t) => {
  const w = milestoneWorld(t);
  w.claude("move", "--gate", w.ask().id);
  const model = boardOf(w);
  assert.deepEqual(model.moved.map((m) => [m.tasks, m.finished]), [[4, 1]]);
  assert.match(renderBoardHtml(model), /Finished tasks stay in Done as Old and read-only, except 1 finished task of a milestone, which moved with its milestone and has a new number too\./);
});

test("the map page lists a finished task of a moved milestone and says that it moved with its milestone (F-T645-9)", (t) => {
  const w = milestoneWorld(t);
  w.claude("move", "--gate", w.ask().id);
  const page = readFileSync(join(w.shared, w.folder(), "move-map.html"), "utf8");
  assert.match(page, /<td>Claude T4<\/td><td><b>T\d+<\/b><\/td><td>pilot<\/td>/, "the merged pilot has a row");
  const finished = "A finished task stays on the board under its old number, unless its milestone moved: then it moved with its milestone, and this page lists it.";
  assert.ok(page.includes(` Each moved row has a new number. ${finished}</p>`), "the intro");
  assert.ok(page.includes(`>No row has this number. ${finished}</p>`), "the line of a search with no row");
  assert.equal(page.includes("A finished task did not move"), false);
});

test("the board shows no move banner while a stopped move's plan waits to finish (F-T647-8)", (t) => {
  const w = moveWorld(t), { id } = w.ask();
  stopAt(w, id, 3);
  assert.deepEqual(boardOf(w).moved, [], "the old logbooks are marked, but the move did not finish");
  w.claude("move", "--gate", id);
  assert.equal(boardOf(w).moved.length, 1);
});

test("the map page has a tab for each kind of row, and its search box fits a phone (F-T640-14)", (t) => {
  const w = moveWorld(t), { id } = w.ask();
  w.claude("move", "--gate", id);
  const page = readFileSync(join(w.shared, w.folder(), "move-map.html"), "utf8");
  assert.ok(page.includes(`<div class="tabs" role="group" aria-label="Kind of row"><button type="button" data-tab="tasks" aria-pressed="true">Tasks 3</button><button type="button" data-tab="gates" aria-pressed="false">Gates 1</button><button type="button" data-tab="findings" aria-pressed="false">Findings 1</button></div>`), page);
  assert.ok(page.includes(`<tr data-kind="gates" data-k="claude g1 g3" hidden><td>Claude G1</td>`), "a row of another tab starts hidden");
  assert.match(page, /input\{[^}]*box-sizing:border-box/);
});

const origin = (checkout, url) => { try { git(checkout, "remote", "remove", "origin"); } catch {} git(checkout, "remote", "add", "origin", url); };

test("the move leaves out a fork with another GitHub remote, and the fork keeps its own logbook working (T646)", (t) => {
  const w = moveWorld(t), fork = join(w.base, "fork");
  git(w.base, "clone", "-q", w.project, fork);
  origin(w.project, "https://github.com/owner/sage.git");
  origin(fork, "git@github.com:someone/sage.git");
  w.claude("init", "--project", fork);
  w.claude("task", "add", "--title", "fork open", "--size", "tiny", "--priority", "P2", "--project", fork);
  const forkDir = w.claudeTool.storeDir(fork, w.env), before = readFileSync(join(forkDir, "tasks.tsv"), "utf8");
  const preview = w.claude("move", "--preview");
  assert.ok(preview.includes(`\nnote  ${fork} is a fork: its GitHub remote is someone/sage, not owner/sage.\n      It keeps its own logbook, and the move leaves it out.`), preview);
  assert.match(preview, /\nopen tasks          2  T4–T5          1  T6\n/, "no task of the fork moves");
  const plan = w.planOf(preview), gate = w.claude("move", "--plan", plan), id = /^(G\d+) /.exec(gate)[1];
  assert.ok(gate.includes(`\nThe move leaves out 1 fork of this repository with another GitHub remote: ${fork}. It keeps its own logbook.\n`), gate);
  assert.equal(gate.includes("The move also links"), false);
  w.claude("gate", "answer", id, "--option", "1");
  assert.match(w.claude("move", "--gate", id), /\n4\/6 checkouts linked: 1 \(this one\)\n/);
  assert.equal(readFileSync(join(forkDir, "tasks.tsv"), "utf8"), before);
  assert.equal(existsSync(join(forkDir, "moved.json")), false);
  assert.equal(w.claudeTool.storeDir(fork, w.env), forkDir);
  assert.match(w.claude("task", "add", "--title", "fork after", "--size", "tiny", "--priority", "P2", "--project", fork), /^T2 /);
  assert.deepEqual(rowsIn(join(w.shared, "bindings.tsv")).map((r) => r.root), [realpathSync(w.project)]);
});

test("a GitHub remote that Git cannot read refuses the move preview, never takes the checkout as a clone (T646, F-T645-2)", (t) => {
  const w = moveWorld(t), clone = join(w.base, "clone");
  git(w.base, "clone", "-q", w.project, clone);
  origin(w.project, "https://github.com/owner/sage.git");
  w.claude("init", "--project", clone);
  git(clone, "remote", "remove", "origin");
  writeFileSync(join(clone, ".git", "config"), `[remote "origin"]\n\turl = https://github.com/someone/${"s".repeat(32 * 1024 * 1024)}\n`, { flag: "a" });
  assert.equal(refusalOf(() => w.claude("move", "--preview")), `sage: refused: sage cannot read the GitHub remote of ${clone} (ENOBUFS), so it cannot tell a clone of this repository from a fork. Nothing changed. Ask the owner to check that checkout's Git config.`);
});

test("rule 3: a fork's logbook, the only logbook of the repository, makes init start a legacy logbook, as before (T646, F-T645-3)", (t) => {
  const w = ruleThree(t, ["claude\t1", "codex\t1"]), fork = join(w.base, "fork");
  git(w.base, "clone", "-q", w.project, fork);
  origin(w.project, "https://github.com/owner/sage.git");
  origin(fork, "https://github.com/someone/sage.git");
  const forkDir = w.codex("init", "--project", fork).replace(/^logbook /, "");
  assert.equal(dirname(forkDir), w.codexRoot);
  w.plugins("claude\t2", "codex\t2");
  assert.equal(w.claude("init"), `logbook ${join(w.claudeRoot, w.folder())}`);
  assert.deepEqual(w.bound(), []);
});

test("a clone with the same GitHub remote, or one with no GitHub remote, still moves and is named in the gate (T646)", (t) => {
  for (const url of ["https://github.com/Owner/Sage", null]) {
    const w = moveWorld(t), clone = join(w.base, "clone");
    git(w.base, "clone", "-q", w.project, clone);
    origin(w.project, "https://github.com/owner/sage.git");
    if (url) origin(clone, url); else git(clone, "remote", "remove", "origin");
    w.claude("init", "--project", clone);
    const gate = w.claude("move", "--plan", w.planOf(w.claude("move", "--preview")));
    assert.ok(gate.includes(`The move also links 1 other checkout of this repository to the new logbook: Claude ${clone}.`), `${url}: ${gate}`);
    assert.equal(gate.includes("leaves out"), false);
  }
});

test("rule 3: a shared root that init cannot write starts a legacy logbook, as before (F-T649-1)", (t) => {
  const w = ruleThree(t, ["claude\t2", "codex\t2"]);
  chmodSync(w.shared, 0o555);
  try {
    assert.equal(w.claude("init"), `logbook ${join(w.claudeRoot, w.folder())}`);
  } finally {
    chmodSync(w.shared, 0o755);
  }
  assert.deepEqual(w.bound(), []);
});

test("rule 3: a damaged plugins.tsv starts a legacy logbook, as before (F-T642-2)", (t) => {
  const w = ruleThree(t, ["claude\t2", "codex\t2"]);
  writeFileSync(join(w.shared, "plugins.tsv"), "provider\tcontract\nclaude\t2\n");
  assert.equal(w.claude("init"), `logbook ${join(w.claudeRoot, w.folder())}`);
  assert.deepEqual(w.bound(), []);
});

test("rule 3: a shallow clone starts a legacy logbook when the shared root has no logbook, and gets the shallow prompt when it has one (F-T642-3, F-T645-1)", (t) => {
  const w = ruleThree(t, ["claude\t2", "codex\t2"]), shallow = join(w.base, "shallow"), later = join(w.base, "later");
  git(w.project, "commit", "-q", "--allow-empty", "-m", "second");
  git(w.base, "clone", "-q", "--depth", "1", `file://${w.project}`, shallow);
  assert.match(w.claude("init", "--project", shallow), new RegExp(`^logbook ${w.claudeRoot}/shallow-[0-9a-f]{6}$`));
  assert.deepEqual(w.bound(), []);
  assert.equal(w.claude("init"), SHARED_INIT(w.project, join(w.shared, w.folder())));
  git(w.base, "clone", "-q", "--depth", "1", `file://${w.project}`, later);
  assert.match(refusalOf(() => w.claude("init", "--project", later)), /It is a shallow clone, so its first commit is its newest one/);
  assert.deepEqual(w.bound().map((r) => r.root), [w.project]);
});

test("rule 3: a logbook folder that sage cannot search starts a legacy logbook with no stack, and the move preview refuses with a clear line (F-T642-4)", (t) => {
  const w = ruleThree(t, ["claude\t2", "codex\t2"]), locked = join(w.codexRoot, "other-abcdef");
  mkdirSync(locked, { recursive: true });
  chmodSync(locked, 0o000);
  try {
    assert.equal(w.claude("init"), `logbook ${join(w.claudeRoot, w.folder())}`);
    assert.equal(refusalOf(() => w.claude("move", "--preview")), `sage: refused: cannot read the logbook folder ${locked} (EACCES), so sage cannot tell whether it holds a logbook of this project. Nothing changed. Ask the owner to fix its rights.`);
  } finally {
    chmodSync(locked, 0o755);
  }
});

test("init refuses with a clear line, never a stack, when a folder of its own provider root cannot be searched (F-T645-8)", (t) => {
  const w = ruleThree(t, ["claude\t2", "codex\t2"]), locked = join(w.claudeRoot, "other-abcdef");
  mkdirSync(locked, { recursive: true });
  chmodSync(locked, 0o000);
  try {
    assert.equal(refusalOf(() => w.claude("init")), `sage: refused: cannot read the logbook folder ${locked} (EACCES), so sage cannot tell whether it holds a logbook of this project. Nothing changed. Ask the owner to fix its rights.`);
  } finally {
    chmodSync(locked, 0o755);
  }
  assert.equal(existsSync(join(w.claudeRoot, w.folder())), false, "no logbook");
  assert.deepEqual(w.bound(), []);
});

test("rule 3: a linked logbook of the project in the other provider's root starts a legacy logbook, not a refusal (F-T642-5)", (t) => {
  const w = ruleThree(t, ["claude\t1", "codex\t1"]), real = join(w.base, "real-codex");
  w.codex("init");
  renameSync(join(w.codexRoot, w.folder()), real);
  symlinkSync(real, join(w.codexRoot, w.folder()));
  w.plugins("claude\t2", "codex\t2");
  assert.equal(w.claude("init"), `logbook ${join(w.claudeRoot, w.folder())}`);
  assert.deepEqual(w.bound(), []);
});

test("rule 3: a folder that is not a Git repository starts a legacy logbook, so no row waits for a first commit (F-T642-6)", (t) => {
  const w = ruleThree(t, ["claude\t2", "codex\t2"]), plain = join(w.base, "plain");
  mkdirSync(plain);
  assert.match(w.claude("init", "--project", plain), new RegExp(`^logbook ${w.claudeRoot}/plain-[0-9a-f]{6}$`));
  assert.deepEqual(w.bound(), []);
});
