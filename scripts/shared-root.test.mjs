import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { actorOptions, locate as claudeLocate, sage as claudeRun, sageRoot as claudeRootOf } from "../plugins/sage/skills/sage/sage.mjs";
import { tool } from "../plugins/sage-codex/skills/sage/sage.mjs";
import { createStateTool, sharedRoot } from "../packages/sage-core/index.mjs";

/** A write of a shared logbook names its chief (T604): each call here acts as one chief of its provider, as the hooks and the MCP server do. */
const acting = (run, options) => (argv, env) => run([...argv, ...options(argv[argv.indexOf("--project") + 1], argv, { native: "test-chief" }, env)], env);
const claudeSage = acting(claudeRun, actorOptions), codexSage = acting(tool.sage, tool.actorOptions);

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const FIRST = "1".repeat(40), OTHER = "2".repeat(40);
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** A scratch home with both provider roots and a shared root. No SAGE_HOME: each tool uses its own root, as in production. */
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
/** The text of the refusal that a call throws. */
const refusalOf = (call) => {
  try {
    call();
  } catch (e) {
    return e.message;
  }
  assert.fail("no refusal");
};
/** The warning of every link prompt (T633 design), before its choices. */
const NOTE = "Note: no sage command can change this answer later.";

test("one function picks the shared root: the fixed option, SAGE_SHARED_HOME, <SAGE_HOME>/shared, then ~/.sage", () => {
  const all = { HOME: "/h", SAGE_HOME: "/s", SAGE_SHARED_HOME: "/x" };
  assert.equal(sharedRoot(all, "/fixed"), "/fixed");
  assert.equal(sharedRoot(all), "/x");
  assert.equal(sharedRoot({ HOME: "/h", SAGE_HOME: "/s" }), "/s/shared");
  assert.equal(sharedRoot({ HOME: "/h" }), "/h/.sage");
});

/** Puts the process's own HOME in a scratch folder, so that os.homedir() returns it and nothing below can reach the real root. */
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
  // The order of the settings stays.
  assert.equal(claudeRootOf({ HOME: "/h", CLAUDE_CONFIG_DIR: "/c" }), "/c/sage");
  assert.equal(tool.sageRoot({ HOME: "/h", CODEX_HOME: "/c" }), "/c/sage");
  assert.equal(modeDirectory({ HOME: "/h", CODEX_HOME: "/c" }), "/c/sage/.hooks/codex");
  assert.equal(claudeRootOf({ HOME: "/h", CLAUDE_CONFIG_DIR: "/c", SAGE_HOME: "/s" }), "/s");
  assert.equal(tool.sageRoot({ HOME: "/h", CODEX_HOME: "/c", SAGE_HOME: "/s" }), "/s");
});

test("a run with SAGE_HOME removed and HOME in scratch writes under that HOME, and the old fault lands in a scratch decoy, never the real root", (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-env-home-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const decoy = join(base, "decoy"), home = join(base, "home");
  mkdirSync(decoy);
  processHome(t, decoy); // Before any sage call: os.homedir() now returns the decoy, in place of the real home folder.
  const env = { ...process.env, HOME: home, SAGE_TEST_PIDS: "{}" };
  for (const name of ["SAGE_SHARED_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "SAGE_WORKTREES"]) delete env[name];
  for (const [name, run, root] of [["claude", claudeSage, ".claude"], ["codex", tool.sage, ".codex"]]) {
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

test("a production-shaped Codex env keeps the shared root out of the Codex root, and the launcher's option wins", async (t) => {
  const { logbookEnv } = await import("../plugins/sage-codex/runtime/logbook-env.mjs");
  const saved = { HOME: process.env.HOME, SAGE_SHARED_HOME: process.env.SAGE_SHARED_HOME, SAGE_HOME: process.env.SAGE_HOME };
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  delete process.env.SAGE_SHARED_HOME; delete process.env.SAGE_HOME;
  process.env.HOME = "/h";
  const logbookRoot = "/h/.codex/sage";
  const env = logbookEnv({ logbookRoot });
  assert.equal(env.SAGE_HOME, logbookRoot);
  assert.equal(sharedRoot(env), "/h/.sage");
  assert.equal(sharedRoot(logbookEnv({ logbookRoot, sharedRoot: "/fixed" })), "/fixed");
});

test("each Codex place that sets the logbook gets its env from the one helper", () => {
  const folder = join(REPO, "packages/sage-codex/runtime");
  const named = readdirSync(folder).filter((file) => file.endsWith(".mjs") && !file.endsWith(".test.mjs") && file !== "logbook-env.mjs" && /SAGE_HOME:\s*options\.logbookRoot/.test(readFileSync(join(folder, file), "utf8")));
  assert.deepEqual(named, []);
  const users = readdirSync(folder).filter((file) => file.endsWith(".mjs") && /logbookEnv\(options\)/.test(readFileSync(join(folder, file), "utf8"))).sort();
  assert.deepEqual(users, ["interrupted-run.mjs", "logbook-owner.mjs", "preparation.mjs", "run-assignment.mjs", "run-report.mjs", "task-authority.mjs", "task-settle.mjs"]);
});

test("the launcher's shared root sits outside every location, also through a link, and it is the root that the hooks read from the environment", async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-shared-config-")));
  const saved = process.env.SAGE_SHARED_HOME;
  t.after(() => { process.env.SAGE_SHARED_HOME = saved; rmSync(base, { recursive: true, force: true }); });
  const { validateLogbookLocation } = await import("../plugins/sage-codex/runtime/run-report.mjs");
  const [logbookRoot, projectDirectory, directory, observationsRoot] = ["logbook", "project", "journal", "observations"].map((name) => join(base, name));
  for (const path of [logbookRoot, projectDirectory, directory, observationsRoot]) mkdirSync(path);
  const options = { logbookRoot, projectDirectory, directory, observationsRoot, sessionsDir: join(base, "sessions") };
  const check = (root) => { process.env.SAGE_SHARED_HOME = root; validateLogbookLocation({ ...options, sharedRoot: root }); };
  assert.doesNotThrow(() => check(join(base, "shared")));
  for (const inside of [join(logbookRoot, "shared"), base, join(projectDirectory, "shared"), join(directory, "shared"), join(observationsRoot, "shared"), join(base, "sessions", "shared")]) {
    assert.throws(() => check(inside), /Sage could not finish/, inside);
  }
  // The value from the environment passes the same check, with no launcher option.
  process.env.SAGE_SHARED_HOME = join(projectDirectory, "shared");
  assert.throws(() => validateLogbookLocation(options), /Sage could not finish/);
  process.env.SAGE_SHARED_HOME = "relative/shared";
  assert.throws(() => validateLogbookLocation(options), /Sage could not finish/);
  // A link compares by its target, also a folder that does not exist yet behind it.
  symlinkSync(logbookRoot, join(base, "alias"));
  assert.throws(() => check(join(base, "alias")), /Sage could not finish/);
  assert.throws(() => check(join(base, "alias", "shared")), /Sage could not finish/);
  symlinkSync(join(base, "nowhere"), join(base, "dangling"));
  assert.throws(() => check(join(base, "dangling")), /Sage could not finish/);
  // A fixed root that the environment does not give is a root that no hook protects.
  process.env.SAGE_SHARED_HOME = join(base, "shared");
  assert.throws(() => validateLogbookLocation({ ...options, sharedRoot: join(base, "other") }), /Sage could not finish/);
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
    // Neither folder has a GitHub remote (a moved folder's old path is gone, and a local clone's origin is a path), so the link is recommended.
    const next = new RegExp(`: \\*\\*This folder has no logbook yet:\\*\\* ${there}\\n\\nIt has the same first commit as the project project \\(logbook ${folder}, used by ${w.project}\\)\\. sage cannot compare GitHub remotes: [^\\n]*\\n\\nNote: no sage command can change this answer later\\.\\n\\nChoose one:\\n1\\. \\*\\*Link to project\\*\\* \\(recommended\\)\\.[\\s\\S]*After the reply, run one command in ${there}: for 1, sage link --to ${folder}; for 2, sage link --separate\\.$`);
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

/** sample-owner/lantern with a shared logbook, and a clone of it, lantern-b, with no row: the link prompt's world (T633 design 4a to 4d). */
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
  const link = `Choose one:\n1. **Link to lantern** (recommended). This folder uses the lantern logbook. Its tasks show in the one lantern project on the board, and its runs show "checkout lantern-b". No record is copied.\n2. **Start separate.** This folder gets a new, empty logbook, and the board shows it as another project. Choose this for a fork that is now its own project.\n\nReply 1 or 2.\n\nAfter the reply, run one command in ${clone}: for 1, sage link --to ${folder}; for 2, sage link --separate.`;
  git(clone, "remote", "set-url", "origin", "git@github.com:sample-owner/lantern.git");
  const same = `${facts} Its GitHub remote is also sample-owner/lantern. So it is most likely a second clone of lantern. sage does not guess, and nothing has changed.\n\n${NOTE}\n\n${link}`;
  assert.deepEqual(prompts(), [same, same], "the same remote: link (both providers)");
  git(clone, "remote", "set-url", "origin", "https://github.com/other-owner/lantern-x");
  const fork = `${facts} But its GitHub remote is other-owner/lantern-x, not sample-owner/lantern. So it is most likely a fork. sage does not guess, and nothing has changed.\n\n${NOTE}\n\nChoose one:\n1. **Start separate** (recommended). This folder gets a new, empty logbook, and the board shows it as another project.\n2. **Link to lantern.** This folder uses the lantern logbook, and its tasks show in the lantern project. Choose this only if the fork and lantern are one project to you.\n\nReply 1 or 2.\n\nAfter the reply, run one command in ${clone}: for 1, sage link --separate; for 2, sage link --to ${folder}.`;
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
  const missing = `**This folder's logbook is missing:** ${lantern}\n\nIts row links it to the logbook ${folder}, but that folder is not in the shared root (${w.shared}) now. Nothing has changed.\n\nNote: a new link or a new logbook does not bring back the old tasks.\n\nChoose one:\n1. **Restore the folder** (recommended if it was removed by mistake). Put ${folder} back from a copy, for example Time Machine. Then ask me again.\n2. **Start separate.** This folder gets a new, empty logbook.\n3. **Link to another project.** Tell me its name.\n\nReply 1, 2 or 3.\n\nAfter the reply, run one command in ${lantern}: for 1, no command: the user puts ${folder} back in ${w.shared}; for 2, sage link --separate; for 3, sage link --to <the folder of the project that the user names>.`;
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
  const ask = (choices, runs) => `**This folder has no logbook yet:** ${third}\n\nTwo shared logbooks have its first commit. sage does not guess, and nothing has changed.${choices[0]}\n\n${NOTE}\n\nChoose one:\n${choices.slice(1).join("\n")}\n\nReply 1, 2 or 3.\n\nAfter the reply, run one command in ${third}: ${runs}.`;
  git(third, "remote", "set-url", "origin", "https://github.com/sample-owner/lantern");
  const same = ask(["", `1. **Link to lantern** (recommended: the same GitHub remote, sample-owner/lantern). Logbook ${folder}, used by ${lantern}.`, `2. **Link to lantern-x.** Logbook ${forkFolder}, used by ${fork}.`, "3. **Start separate.** A new, empty logbook."], `for 1, sage link --to ${folder}; for 2, sage link --to ${forkFolder}; for 3, sage link --separate`);
  assert.deepEqual(prompts(third), [same, same]);
  git(third, "remote", "set-url", "origin", "https://github.com/third-owner/lantern-c");
  assert.equal(prompts(third)[0], ask(["", `1. **Link to lantern.** Logbook ${folder}, used by ${lantern}.`, `2. **Link to lantern-x.** Logbook ${forkFolder}, used by ${fork}.`, "3. **Start separate** (recommended: no logbook has its GitHub remote, third-owner/lantern-c). A new, empty logbook."], `for 1, sage link --to ${folder}; for 2, sage link --to ${forkFolder}; for 3, sage link --separate`), "a remote that no logbook has: separate");
  git(third, "remote", "remove", "origin");
  assert.equal(prompts(third)[0], ask([" sage cannot recommend one: a folder has no GitHub remote that sage can read.", `1. **Link to lantern.** Logbook ${folder}, used by ${lantern}.`, `2. **Link to lantern-x.** Logbook ${forkFolder}, used by ${fork}.`, "3. **Start separate.** A new, empty logbook."], `for 1, sage link --to ${folder}; for 2, sage link --to ${forkFolder}; for 3, sage link --separate`), "no remote: no recommendation");
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
  assert.throws(() => w.claude("link", "--to", otherFolder), new RegExp(`already linked to ${folder}, and a checkout has one logbook\\. Nothing changed\\. Keep using ${folder}\\. Only the move can take a checkout to another logbook, and no command does the move today: a later sage adds it\\.$`));
  assert.equal(w.rows().find(([root]) => root === w.project)[1], folder);
  assert.ok(w.table("bindings.tsv").startsWith(before));
});

test("link refuses a project with a legacy logbook in either root, and names the next step: only the move takes its tasks over", (t) => {
  const w = world(t);
  w.codex("init");
  assert.throws(() => w.claude("link", "--separate"), /has a logbook at .*Keep using that logbook, and ask the user to wait for the move/i);
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
  w.claude("init"); // a legacy logbook that a fall-through would use
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
  inForeign("link", "--to", folder); // no commits yet, so no compare
  git(foreign, "commit", "-q", "--allow-empty", "-m", "own first");
  const conflict = `**This folder's link is wrong:** ${foreign}\n\nIts row links it to the logbook ${folder}, but that logbook belongs to another project (${w.project}): the two folders have no first commit in common. So sage does not use that logbook here, and nothing has changed. The project tasks are safe.\n\nIf this folder is a shallow clone, its first commit is its newest one. Then run \`git fetch --unshallow\` in it, and ask me again.\n\n${NOTE}\n\nChoose one:\n1. **Start separate** (recommended). This folder gets a new, empty logbook in place of the wrong link.\n2. **Link to another project.** Tell me its name. The link stops if that project does not have this folder's first commit.\n\nReply 1, or 2 and the name.\n\nAfter the reply, run one command in ${foreign}: for 1, sage link --separate; for 2, sage link --to <the folder of the project that the user names>.`;
  for (const run of [claudeSage, codexSage]) assert.equal(refusalOf(() => run([...ADD, "--project", foreign], w.env)), conflict);
  // The owner reads, writes and merges as before, and a link there is a retry.
  assert.match(w.claude("status"), /T1/);
  assert.match(w.claude(...ADD), /T2/);
  const sha = "a".repeat(40);
  w.claude("verdict", "T1", "--sha", sha, "--kind", "checks-pass");
  assert.match(w.claude("merge-check", "--sha", sha), /T1 may merge/);
  assert.equal(w.claude("link", "--to", folder), `already linked: ${join(w.shared, folder)}. Nothing changed.`);
  assert.equal(w.claude("link", "--separate"), `already linked: ${join(w.shared, folder)}. Nothing changed.`);
  // The foreign checkout repairs itself with the command that the refusal names.
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
  // While a gone row is back on the disk, it owns the logbook again: gone means gone now, and no row is rewritten.
  mkdirSync(gone);
  assert.throws(() => w.claude("status"), /belongs to another project/);
  rmSync(gone, { recursive: true });
  // A newcomer meets the live owner, also while an older gone row shares its first commit.
  w.bind(`${gone}\t${folder}\t${commits}\t2020-01-01T00:00:00Z`, `${root}\t${folder}\t${OTHER}\t${at}`);
  const stranger = w.repo("stranger");
  assert.throws(() => claudeSage(["link", "--to", folder, "--project", stranger], w.env), new RegExp(`belongs to another project \\(${root}\\)`));
  // With no live row, the oldest gone row still keeps a stranger out.
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
  w.claude(...ADD); // fills the older row, which then owns the logbook
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

// T610 (F-T599-3): the two conditions of the new-logbook guard that had no test.
test("M6: a clone with a legacy logbook in the other provider's root gets no link offer: this provider keeps today's refusal", (t) => {
  const w = world(t);
  const clone = join(w.base, "clone");
  git(w.base, "clone", "-q", w.project, clone);
  codexSage(["init", "--project", clone], w.env); // before any row: a legacy Codex logbook
  w.claude("link", "--separate");
  assert.deepEqual([claudeLocate(clone, w.env).shared, claudeLocate(clone, w.env).legacy], [false, true]);
  assert.throws(() => claudeSage(["status", "--project", clone], w.env), (e) => /no logbook for the project/.test(e.message) && !/sage link/.test(e.message));
  assert.match(codexSage(["status", "--project", clone], w.env), /^tasks +0$/m, "the Codex logbook works as before");
  assert.throws(() => claudeSage(["link", "--to", w.name(), "--project", clone], w.env), /this project has a logbook at .*codex/);
});

test("M7: a clone whose first commit cannot be read, or a shallow one, gets past the guard: init makes a legacy logbook, and link then refuses", (t) => {
  const w = world(t);
  git(w.project, "commit", "-q", "--allow-empty", "-m", "second");
  w.claude("link", "--separate");
  const broken = join(w.base, "broken"), shallow = join(w.base, "shallow");
  git(w.base, "clone", "-q", w.project, broken);
  const config = join(broken, ".git", "config"), good = readFileSync(config, "utf8");
  writeFileSync(config, "[core\n"); // Git cannot read it, so the guard has no first commit to compare
  git(w.base, "clone", "-q", "--depth", "1", `file://${w.project}`, shallow); // its first commit is its newest one
  for (const clone of [broken, shallow]) assert.match(claudeSage(["init", "--project", clone], w.env), new RegExp(`^logbook ${w.claudeRoot}/`), basename(clone));
  assert.throws(() => claudeSage(["link", "--to", w.name(), "--project", broken], w.env), /git cannot read the repository at .*broken/);
  writeFileSync(config, good); // the repair: now the legacy logbook stops the link
  for (const clone of [broken, shallow]) assert.throws(() => claudeSage(["link", "--to", w.name(), "--project", clone], w.env), /this project has a logbook at .*A link would hide its tasks/, basename(clone));
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
  // The owner's way out: the table back from a copy.
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
  // The same repository at the next write of a row that has no commits yet: no program, and the row stays empty.
  const empty = w.repo("empty", false);
  claudeSage(["link", "--separate", "--project", empty], w.env);
  git(empty, "commit", "-q", "--allow-empty", "-m", "first");
  plant(empty);
  claudeSage([...ADD, "--project", empty], w.env);
  assert.equal(existsSync(marker), false);
  assert.equal(w.rows()[0][2], "");
  // A replace ref that cuts a commit's parents would show that commit as a first commit.
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
  w.claude("link", "--to", folder); // no commits yet, so no compare
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

/** Each way that Git cannot read a repository with commits. Each returns the folder to link. */
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

/** A branch ref that blocks each reader of HEAD: the hardened Git call uses a fixed binary, so a fake on PATH cannot stand in for it. */
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
  // A write goes to the shared root only, and a provider root's own value no longer counts for this project.
  w.claude("config", "cycles.large=7");
  assert.equal(counts(w.shared)["cycles.large"], 7);
  assert.equal(counts(w.claudeRoot)["cycles.large"], 3);
  assert.equal(counts(w.codexRoot)["cycles.large"], 5);
  assert.match(w.codex("config"), /cycles\.large=7/);
  // The keys of a provider stay there, also in one command with a shared key.
  w.claude("config", "cycles.small=2", "arena=4", "max_agents=7", "cap_total=9");
  assert.equal(counts(w.shared)["cycles.small"], 2);
  assert.deepEqual(Object.keys(counts(w.shared)).sort(), ["cycles.large", "cycles.risk", "cycles.small", "max_rounds"]);
  assert.deepEqual([counts(w.claudeRoot).arena, counts(w.claudeRoot).max_agents, counts(w.claudeRoot).cap_total, counts(w.claudeRoot)["cycles.small"]], [4, 7, 9, undefined]);
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

test("the merge check of a shared project reads its verdicts from the shared root, its list and its counts", (t) => {
  const w = world(t);
  w.claude("link", "--separate");
  const sha = "a".repeat(40), folder = w.name();
  w.claude("task", "add", "--title", "x", "--size", "tiny", "--priority", "P2");
  w.claude("verdict", "T1", "--sha", sha, "--kind", "checks-pass");
  assert.match(w.claude("merge-check", "--sha", sha), /T1 may merge/);
  assert.match(w.codex("merge-check", "--sha", sha), /T1 may merge/, "from either provider");
  // A folder of the shared root with verdicts on the SHA, that link never listed, refuses.
  const planted = join(w.shared, "planted-123456");
  mkdirSync(planted);
  for (const file of readdirSync(join(w.shared, folder)).filter((name) => name.endsWith(".tsv"))) writeFileSync(join(planted, file), readFileSync(join(w.shared, folder, file)));
  assert.throws(() => w.claude("merge-check", "--sha", sha), new RegExp(`not in the known project list \\(${join(w.shared, "projects.tsv")}\\)`));
  rmSync(planted, { recursive: true });
  // An invalid shared count refuses, and names the shared config.
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

test("the PR script takes a shared logbook, which has no checkout.txt", async (t) => {
  const w = world(t);
  w.claude("link", "--separate");
  w.claude("task", "add", "--title", "x", "--size", "tiny", "--priority", "P2");
  w.claude("task", "T1", "set", "branch=sage/t1");
  git(w.project, "remote", "add", "origin", "https://github.com/example/project.git");
  const { record, remember } = await import("../plugins/sage/skills/sage/sage-pr.mjs");
  const saved = record("T1", "view", { ...w.env, SAGE_PROJECT: w.project });
  assert.deepEqual([saved.dir, saved.branch], [join(w.shared, w.name()), "sage/t1"]);
  // create records the PR number as the task's own chief (T604): the script has no session, and only a chief runs it.
  remember({ project: w.project, t: tool.read(saved.dir, "tasks")[0] }, { out: "opened", number: "5" }, w.env);
  assert.match(w.claude("task", "T1"), /· PR 5 /);
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

test("a chief with another logbook root finds a receipt of a shared project, so the Codex settle step cannot void a live row", (t) => {
  const w = world(t);
  const envA = { ...w.env, SAGE_HOME: join(w.base, "root-a") }, envB = { ...w.env, SAGE_HOME: join(w.base, "root-b") };
  mkdirSync(envA.SAGE_HOME); mkdirSync(envB.SAGE_HOME);
  codexSage(["link", "--separate", "--project", w.project], envA);
  codexSage(["task", "add", "--title", "x", "--size", "tiny", "--priority", "P2", "--project", w.project], envA);
  const owner = "chief", request = "00000000-0000-4000-8000-000000000594";
  let digest;
  const { version } = tool.readTaskSnapshot({ project: w.project, task: "T1" }, envA);
  tool.updateRequestedTask({ project: w.project, owner, request, task: "T1", version, changes: { title: "y" } }, envA, {
    native: "test-chief",
    decide: (value) => { digest = value; return { digest: value, accepted: true, reason: "" }; },
    acknowledge: (value, receiptHash) => ({ digest: value, receiptHash }), release: (value, receiptHash) => ({ digest: value, receiptHash }),
    void() {}, history() { throw Error("No history here"); } });
  const seen = (env) => tool.settleWrites({ project: w.project }, env, (receipts) => !!receipts.update({ owner, request, digest }));
  assert.equal(seen(envA), true);
  assert.equal(seen(envB), true, "the row of the shared project gives both chiefs one folder and one lock");
});

/**
 * Two provider roots that the test names (T641): a Claude tool and a Codex tool from the core, each with its own root and
 * the legacyRoots that the test gives, so that HOME, SAGE_HOME and the shared root all stay in scratch. named: false gives
 * bare paths, as an adapter that does not name its roots yet.
 */
function twoRoots(t, { named = true } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-two-roots-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const claudeRoot = join(base, "claude-root"), codexRoot = join(base, "codex-root"), shared = join(base, "shared");
  // Each provider sets SAGE_HOME to its own root, as the Codex runtime does in production.
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
/** Replaces a file's text with an edit of it. */
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

test("a writer that found the old logbook and waited on its lock during the move refuses, and its next run writes the shared logbook (T641)", async (t) => {
  const w = twoRoots(t);
  w.claude("init");
  w.claude("task", "add", "--title", "before the move", "--size", "tiny", "--priority", "P2");
  const dir = join(w.claudeRoot, w.folder());
  // The writer runs in its own process with the same roots. It finds the old logbook, then waits on the lock that the move holds.
  const runner = join(w.base, "writer.mjs");
  writeFileSync(runner, `import { createStateTool } from ${JSON.stringify(join(REPO, "packages/sage-core/index.mjs"))};\ncreateStateTool({ provider: "claude", defaultRoot: () => ${JSON.stringify(w.claudeRoot)}, legacyRoots: () => [{ provider: "claude", path: ${JSON.stringify(w.claudeRoot)} }, { provider: "codex", path: ${JSON.stringify(w.codexRoot)} }] }).runCli();\n`);
  const saved = process.env.SAGE_TEST_PIDS;
  process.env.SAGE_TEST_PIDS = "{}"; // the lock's probe in this process is the fake one too: no real process is asked
  t.after(() => { if (saved === undefined) delete process.env.SAGE_TEST_PIDS; else process.env.SAGE_TEST_PIDS = saved; });
  const writer = spawn(process.execPath, [runner, "task", "add", "--title", "late", "--size", "tiny", "--priority", "P2", "--project", w.project], { env: { ...w.env, NODE_TEST_CONTEXT: "child" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  writer.stdout.on("data", (b) => { out += b; });
  writer.stderr.on("data", (b) => { out += b; });
  const ended = new Promise((done) => writer.on("close", done));
  const before = readFileSync(join(dir, "tasks.tsv"), "utf8");
  w.claudeTool.withLock(dir, () => {
    // The writer's temporary lock folder shows that it found this logbook and waits. The bound only ends a broken run.
    for (let i = 0; !readdirSync(dir).some((name) => name.startsWith(".lock.")); i++) {
      if (i > 4000) assert.fail("the writer never waited on the lock");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    writeFileSync(join(dir, "moved.json"), JSON.stringify({ folder: w.folder(), at: "2026-11-03T00:00:00Z" }) + "\n");
  });
  assert.equal(await ended, 1, out);
  assert.match(out, /this logbook moved to the shared root \(.*moved\.json\), so sage writes no more to it\. Nothing changed\. Run the command again: it then finds the shared logbook\./);
  assert.equal(readFileSync(join(dir, "tasks.tsv"), "utf8"), before, "the old logbook keeps its rows");
  // The end of the move: the shared logbook and its row. The same command now writes there.
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
  // The shape of the real Claude logbook: tasks to T644, runs to R2469, gates to G103.
  const renumber = (root, map) => {
    for (const name of readdirSync(join(root, w.folder())).filter((n) => n.endsWith(".tsv"))) rewrite(join(root, w.folder(), name), (text) => text.replace(/(?<![A-Za-z0-9])(T|R|G)1(?![0-9])/g, (_, p) => map[p]));
  };
  renumber(w.claudeRoot, { T: "T644", R: "R2469", G: "G103" });
  w.codex("init");
  w.codex("task", "add", "--title", "old codex task", "--size", "tiny", "--priority", "P2");
  w.codex("gate", "add", "T1", "--question", "Go?", "--options", "yes|no", "--recommend", "yes");
  w.codex("log", "-", "PG4 was planned", "--why", "a program id in a decision counts");
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
    ["", "PG4 is the program floor of the move from claude and codex"],
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
  // These rows are the text that writeIdFloors writes. nextId has read a decision's first word since T46, so an older
  // plugin that writes this logbook still gives the next number above the floor.
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
  const bare = twoRoots(t, { named: false });
  mkdirSync(bare.shared, { recursive: true });
  writeFileSync(join(bare.shared, "plugins.tsv"), "provider\tcontract\tat\nclaude\t2\tx\ncodex\t2\tx\n");
  assert.deepEqual(bare.claudeTool.waitingPlugins(bare.env), [{ provider: null, contract: null, path: bare.codexRoot }], "a root with no provider name cannot be checked");
  writeFileSync(join(w.shared, "plugins.tsv"), "provider\tcontract\nclaude\t2\n");
  assert.throws(() => waiting(), /plugins\.tsv does not start with the column names provider, contract, at/);
});
