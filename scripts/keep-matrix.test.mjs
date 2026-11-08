// The KEEP set of T815 in one table, through both hooks as processes: Claude's sage hook and Codex's gate. T815 cut the
// hooks' shell-text rules; this table shows that every merge form, push form, literal logbook write and the board, process
// and stash rules still refuse, and that the plain forms pass. No command of the table runs: a hook only judges it.
import "./test-env.mjs"; // first: no variable of the developer's shell changes a result
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as claude from "../plugins/sage/skills/sage/sage.mjs";
import { tool as codex } from "../plugins/sage-codex/skills/sage/sage.mjs";
import { stateKey } from "../plugins/sage-codex/hooks/principles-hook.mjs";

const at = (path) => fileURLToPath(new URL(path, import.meta.url));
const CLAUDE_HOOK = at("../plugins/sage/hooks/sage-hook.mjs"), CODEX_HOOK = at("../plugins/sage-codex/hooks/gate-hook.mjs");
const TOOL = at("../plugins/sage/skills/sage/sage.mjs"), PR_TOOL = at("../plugins/sage/skills/sage/sage-pr.mjs");
const SHA = "a".repeat(40);
const FORM = `gh pr merge 12 --squash --delete-branch --match-head-commit ${SHA}`;
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

// Every home is in a scratch folder. The fakes are outside /tmp and /private/tmp (standing order 57: the Codex gate drops
// the folders that its sandbox can write from PATH), in a folder of this checkout. Both folders go at exit.
const BASE = realpathSync(mkdtempSync(join(tmpdir(), "sage-keep-matrix-")));
const FAKES = realpathSync(mkdtempSync(join(at(".."), ".keep-matrix-fakes-")));
process.on("exit", () => { for (const dir of [BASE, FAKES]) rmSync(dir, { recursive: true, force: true }); });
// The fake gh logs each call and answers only what the hooks read: GitHub's default branch and a pull request's head.
const CALLS = join(FAKES, "gh-calls.log");
writeFileSync(join(FAKES, "package.json"), '{"type":"commonjs"}\n');
writeFileSync(join(FAKES, "gh"), `#!${process.execPath}
const fs = require("fs"), args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, args.join(" ") + "\\n");
if (args[0] === "--keep-matrix") process.stdout.write("fake gh\\n");
else if (args[0] === "api" && args.at(-1) === ".default_branch") process.stdout.write((process.env.KEEP_DEFAULT_BRANCH || "main") + "\\n");
else if (args[0] === "pr" && args[1] === "view") process.stdout.write(JSON.stringify({ headRefName: "sage/t1-a", isCrossRepository: false }));
else process.exit(1);
`, { mode: 0o755 });
// A folder that holds the real gh can hold git too (/usr/bin on Ubuntu), so git goes into the fakes before those folders
// go. /opt/homebrew/bin holds gh on a Mac: it goes too.
const SYSTEM = String(process.env.PATH).split(":").filter(Boolean);
symlinkSync(SYSTEM.map((dir) => join(dir, "git")).find((file) => existsSync(file)), join(FAKES, "git"));
const PATH = [FAKES, ...SYSTEM.filter((dir) => !existsSync(join(dir, "gh")) && !existsSync(join(dir, "gh.exe")) && !dir.startsWith("/opt/homebrew"))].join(":");
const env = { ...process.env, PATH, HOME: join(BASE, "home"), CLAUDE_CONFIG_DIR: join(BASE, "claude"), CODEX_HOME: join(BASE, "codex"),
  SAGE_SHARED_HOME: join(BASE, "shared"), SAGE_WORKTREES: join(BASE, "worktrees"), SAGE_HOOKS_STATE: join(BASE, "hooks"), SAGE_TEST_PIDS: "{}" };
delete env.SAGE_HOME;
mkdirSync(env.HOME);

test("T815: the fake gh answers first, and no real gh is on the hooks' PATH", () => {
  assert.equal(spawnSync(join(FAKES, "gh"), ["--keep-matrix"], { encoding: "utf8" }).stdout, "fake gh\n");
  assert.deepEqual(PATH.split(":").filter((dir) => existsSync(join(dir, "gh"))), [FAKES]);
  assert.equal(spawnSync("gh", ["--keep-matrix"], { env, encoding: "utf8" }).stdout, "fake gh\n");
  assert.equal(spawnSync("git", ["--version"], { env, encoding: "utf8" }).status, 0);
});

// The project: a GitHub remote, a worktree on sage/t1-a, and a shared logbook with a chief of each provider. T1 (on
// sage/t1-a) is the Claude chief's, T2 (on sage/t2-b) the Codex chief's.
const PROJECT = join(BASE, "project"), TREE = join(BASE, "tree"), OTHER = join(BASE, "other");
mkdirSync(PROJECT);
execFileSync("git", ["init", "-q", "-b", "main", PROJECT]);
execFileSync("git", ["-C", PROJECT, "commit", "-q", "--allow-empty", "-m", "first"], { env: gitEnv });
execFileSync("git", ["-C", PROJECT, "remote", "add", "origin", "https://github.com/acme/project.git"]);
execFileSync("git", ["-C", PROJECT, "worktree", "add", "-q", "-b", "sage/t1-a", TREE]);
for (const name of ["sage/t2-b", "sage/t9-free", "develop"]) execFileSync("git", ["-C", PROJECT, "branch", name]);
// A second checkout whose settings send a push to another name (remote.origin.push).
mkdirSync(OTHER);
execFileSync("git", ["init", "-q", "-b", "sage/t1-a", OTHER]);
execFileSync("git", ["-C", OTHER, "remote", "add", "origin", "https://github.com/acme/project.git"]);
execFileSync("git", ["-C", OTHER, "config", "remote.origin.push", "refs/heads/sage/t1-a:refs/heads/main"]);
const SESSION = { claude: "claude-session", codex: "codex-session" };
claude.sage(["link", "--separate", "--project", PROJECT], env);
const C1 = claude.chiefFor(PROJECT, SESSION.claude, env), C2 = codex.chiefFor(PROJECT, SESSION.codex, env);
for (const [tool, chief, title, branch] of [[claude, C1, "a", "sage/t1-a"], [codex, C2, "b", "sage/t2-b"]]) {
  tool.sage(["task", "add", "--title", title, "--size", "small", "--priority", "P2", "--project", PROJECT, "--chief", chief], env);
  tool.sage(["task", `T${title === "a" ? 1 : 2}`, "set", `branch=${branch}`, "--project", PROJECT, "--chief", chief], env);
}
const LOGBOOK = claude.storeDir(PROJECT, env);
const LINK = join(BASE, "link");
symlinkSync(LOGBOOK, LINK);

/** A hook's answer: the reason of its refusal, or undefined when it passes. */
function answer(r) {
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout ? JSON.parse(r.stdout) : undefined;
  return out?.hookSpecificOutput?.permissionDecision === "deny" ? out.hookSpecificOutput.permissionDecisionReason : undefined;
}
const run = (hook, event, extra = {}) => answer(spawnSync(process.execPath, [hook], { input: JSON.stringify(event), env: { ...env, ...extra }, encoding: "utf8", timeout: 60_000 }));
// Sage mode in each session: Claude's by its typed phrase, Codex's by its mode file.
run(CLAUDE_HOOK, { hook_event_name: "UserPromptSubmit", session_id: SESSION.claude, cwd: PROJECT, prompt: "sage mode" });
const modes = join(env.CODEX_HOME, "sage", ".hooks", "codex");
mkdirSync(modes, { recursive: true, mode: 0o700 });
writeFileSync(join(modes, `${stateKey({ session_id: SESSION.codex })}.json`), JSON.stringify({ sage: true, autopilot: false }), { mode: 0o600 });

/** The roles that each row runs as: Claude's chief and its implementer agent, and Codex's chief (the root thread). */
const ROLES = {
  "claude chief": (command, extra) => run(CLAUDE_HOOK, { hook_event_name: "PreToolUse", session_id: SESSION.claude, cwd: PROJECT, tool_name: "Bash", tool_use_id: "toolu_1", tool_input: { command } }, extra),
  "claude agent": (command, extra) => run(CLAUDE_HOOK, { hook_event_name: "PreToolUse", session_id: SESSION.claude, cwd: PROJECT, tool_name: "Bash", tool_use_id: "toolu_1", tool_input: { command }, agent_id: "agent-1", agent_type: "sage:implementer" }, extra),
  "codex chief": (command, extra) => run(CODEX_HOOK, { hook_event_name: "PreToolUse", session_id: SESSION.codex, turn_id: "t1", cwd: PROJECT, tool_name: "Bash", tool_use_id: "call_1", tool_input: { command } }, extra),
};
const BOTH = Object.keys(ROLES), CLAUDE = ["claude chief", "claude agent"], AGENT = ["claude agent"];
/** The words of each family's refusal in the Claude hook, so that no row passes for another rule's reason. */
const WHY = {
  merge: /merge|reaches main/i, // a mergeBranch into main meets the push rule first, which runs before the merge rule
  push: /Push only with|force-push|reaches main|default branch|gh repo sync|git command that the hook knows|subtree push|owning chief|core\.hooksPath/,
  gh: /before or between its command words/,
  logbook: /logbook file from the shell/,
  board: /board password rule/,
  process: /process list/,
  stash: /git stash/,
  "agent gh": /an agent runs only these gh commands/,
  state: /state tool|PR script|writes the logbook/,
};

/**
 * The table: [family, command, roles, extra env]. A command is a string for every role, or { claude, codex } when the two
 * providers need another command for one case (the other chief's branch).
 */
const T = TREE, L = LOGBOOK;
/** Wrapper programs that the command reader does not know: each runs the program in its words. No row runs them. */
const WRAPPERS = ["arch -arm64", "script -q /dev/null", "op run --", "direnv exec .", "unbuffer", `flock ${BASE}/lock`, "mise exec --"];
mkdirSync(join(env.HOME, "x")); // cd ~/x: a folder of the scratch home
const REFUSED = [
  // Every merge form: by gh's own words, after gh's options, at any depth that the reader sees, and through the API.
  ["merge", "gh pr merge 12"],
  ["merge", `${FORM} -R acme/project`],
  ["merge", `gh -R acme/project pr merge 12 --squash --delete-branch --match-head-commit ${SHA}`],
  ["merge", `/usr/local/bin/gh pr merge 12 --squash --delete-branch --match-head-commit ${SHA}`],
  ["merge", `env GH_TOKEN=x ${FORM}`],
  ["merge", `command ${FORM}`],
  ["merge", `bash -c '${FORM}'`],
  ["merge", `sh -c "${FORM}"`],
  ["merge", `eval ${FORM}`],
  ["merge", `echo $(${FORM})`],
  ["merge", "echo 12 | xargs gh pr merge --squash --delete-branch"],
  ["merge", `find . -name x -exec ${FORM} \\;`],
  ["merge", `cd ${PROJECT} && ${FORM}`],
  ["merge", "gh pr merge 12 --auto --squash --delete-branch"],
  ["merge", `gh pr merge 12 --admin --squash --delete-branch --match-head-commit ${SHA}`],
  ["merge", "gh api -X PUT repos/acme/project/pulls/12/merge"],
  ["merge", "gh api --method=PUT repos/acme/project/pulls/12/merge"],
  ["merge", "gh api -XPUT repos/acme/project/pulls/12/merge"],
  ["merge", "gh api -X PUT https://api.github.com/repos/acme/project/pulls/12/merge"],
  ["merge", `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "P1"}) { clientMutationId } }'`],
  ["merge", `gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: "P1"}) { clientMutationId } }'`],
  ["merge", `gh api graphql -f query='mutation { mergeBranch(input: {repositoryId: "R1", base: "main", head: "sage/t1-a"}) { clientMutationId } }'`],
  ["merge", "curl -X PUT -H 'Authorization: token x' https://api.github.com/repos/acme/project/pulls/12/merge"],
  ["merge", "wget --method=PUT https://api.github.com/repos/acme/project/pulls/12/merge"],
  // The REST merges endpoint merges a branch into a base (F-T815-7).
  ["merge", "gh api -X POST repos/acme/project/merges -f base=sage/t9-free -f head=sage/t1-a"],
  ["merge", `curl -X POST -d '{"base":"sage/t9-free","head":"sage/t1-a"}' https://api.github.com/repos/acme/project/merges`],
  // GitHub reads a doubled slash as one (F-T815-33).
  ["merge", "gh api -X PUT repos/acme/project/pulls/12//merge"],
  ["merge", "curl -X POST https://api.github.com/repos//acme/project//merges -d x"],
  // A wrapper that the reader does not know runs the program in its words (F-T815-30).
  ...WRAPPERS.flatMap((wrapper) => [`${wrapper} gh pr merge 12 --squash`, `${wrapper} gh api -X PUT repos/acme/project/pulls/12/merge`,
    `${wrapper} curl -X PUT -H 'Authorization: token x' https://api.github.com/repos/acme/project/pulls/12/merge`].map((command) => ["merge", command])),
  // An option before or between gh's command words can take the next word as its value: gh pr -b view merge 12 runs
  // gh pr merge (F-T815-5).
  ["gh", "gh pr -b view merge 12 --squash"],
  ["gh", "gh pr -c view close 12"],
  ["gh", `gh --color always pr merge 12 --squash --delete-branch --match-head-commit ${SHA}`],
  // Every push form that is not the one push form.
  ["push", `git -C ${T} push --force origin sage/t1-a`],
  ["push", `git -C ${T} push origin +sage/t1-a`],
  ["push", `git -C ${T} push origin main`],
  ["push", `git -C ${T} push origin master`],
  ["push", `git -C ${T} push origin HEAD`],
  ["push", `git -C ${T} push origin sage/t1-a:main`],
  ["push", `git -C ${T} push origin :sage/t9-free`],
  ["push", `git -C ${T} push --mirror origin`],
  ["push", `git -C ${T} push --all origin`],
  ["push", `git -C ${T} push origin develop`, BOTH, { KEEP_DEFAULT_BRANCH: "develop" }],
  ["push", `git -C ${OTHER} push origin sage/t1-a`],
  ["push", `git -c push.default=upstream -C ${T} push origin sage/t1-a`],
  ["push", `git -C ${T} -c core.hooksPath=/x commit -m x`],
  ["push", `bash -c 'git -C ${T} push origin sage/t1-a'`],
  ["push", `eval git -C ${T} push origin sage/t1-a`],
  ["push", `echo $(git -C ${T} push origin sage/t1-a)`],
  ["push", `env git -C ${T} push origin sage/t1-a`],
  ["push", { claude: `git -C ${T} push origin sage/t2-b`, codex: `git -C ${T} push origin sage/t1-a` }],
  ["push", "gh repo sync"],
  ["push", "gh repo edit acme/project --default-branch sage/t1-a"],
  ["push", `gh api -X PATCH repos/acme/project/git/refs/heads/main -f sha=${SHA}`],
  // A value option of gh api takes the next word as its value, so -XGET there is no method: gh sends PATCH (F-T815-27).
  ["push", `gh api -X PATCH repos/acme/project/git/refs/heads/main -t -XGET -f sha=${SHA}`],
  ["push", `gh api -X PATCH repos/acme/project/git/refs/heads/main -p -XGET -f sha=${SHA}`],
  ["push", `gh api -X PATCH repos/acme/project/git/refs/heads/main -H --method=GET -f sha=${SHA}`],
  ["push", `git -C ${T} subtree push --prefix=docs origin sage/t1-a`],
  ["push", `git -C ${T} frobnicate origin`],
  // The reader resolves a literal cd ~ and cd ~/<path>; on a line that it cannot read (cd -, an unknown wrapper option),
  // the words still show a GitHub write of main, a branch move or an unknown git subcommand (F-T815-31).
  ["push", `cd ~ && gh api -X PATCH repos/acme/project/git/refs/heads/main -f sha=${SHA}`],
  ["push", "cd ~/x && gh api -X PUT repos/acme/project/contents/README.md -f message=m -f content=eA== -f branch=main"],
  ["push", "cd ~ && gh repo sync"],
  ["push", "cd ~ && gh repo edit acme/project --default-branch sage/t1-a"],
  ["push", `cd ~ && git -C ${T} frobnicate origin`],
  ["push", `cd - && gh api -X PATCH repos/acme/project/git/refs/heads/main -f sha=${SHA}`],
  ["push", "cd - && gh repo sync"],
  ["push", "cd - && gh repo edit acme/project --default-branch sage/t1-a"],
  ["push", `cd - && git -C ${T} frobnicate origin`],
  ["push", `timeout --foo 60 gh api -X PATCH repos/acme/project/git/refs/heads/main -f sha=${SHA}`],
  ["push", "timeout --foo 60 gh api -X PUT repos/acme/project/contents/README.md -f message=m -f content=eA== -f branch=main"],
  // Logbook writes by a literal path: as written, through a link, after a cd and from ~.
  ["logbook", `rm ${L}/tasks.tsv`],
  ["logbook", `echo x > ${L}/tasks.tsv`],
  ["logbook", `cp /dev/null ${LINK}/tasks.tsv`],
  ["logbook", `cd ${L} && rm tasks.tsv`],
  ["logbook", `rm ~/../shared/${L.slice(env.SAGE_SHARED_HOME.length + 1)}/tasks.tsv`],
  // After a literal pushd, also through a link to the logbook (F-T815-16).
  ["logbook", `pushd ${L} && echo x >> tasks.tsv`],
  ["logbook", `pushd ${LINK} && rm tasks.tsv`],
  ["logbook", `pushd ${env.SAGE_SHARED_HOME} && echo x > a.json`],
  ["logbook", `pushd /usr && popd && pushd ${L} && rm -rf runs.tsv`],
  // A remove or a move of a folder that holds a root (F-T815-4): the home folder, a folder above it, a pattern in it.
  ["logbook", `rm -rf ${env.SAGE_SHARED_HOME}`],
  ["logbook", `mv ${env.SAGE_SHARED_HOME} ${env.SAGE_SHARED_HOME}.bak`],
  // The Codex gate refuses a write to its roots only, and takes these up in T903.
  ["logbook", "rm -rf ~/..", CLAUDE],
  ["logbook", "rm -rf ~/../*", CLAUDE],
  ["logbook", `find ${BASE} -delete`, CLAUDE],
  ["logbook", `chmod -R 000 ${env.SAGE_SHARED_HOME}`],
  // The board, process and stash rules: the Claude hook's (the Codex gate has none of them yet, T903).
  ["board", "cat ~/.config/sage-board/board.json", CLAUDE],
  ["board", "node /opt/sage/board/cli.mjs board --set-password", CLAUDE],
  ["board", "grep -r token ~/.config", CLAUDE],
  ["process", "ps aux", AGENT],
  ["process", "kill 1", AGENT],
  ["process", "pgrep node", AGENT],
  ["stash", `git -C ${T} stash`, AGENT],
  // An agent's gh api runs only with GET: -XGET after -t is the template, so gh sends DELETE (F-T815-27).
  ["agent gh", "gh api -X DELETE repos/acme/project/git/refs/heads/x -t -XGET", AGENT],
  ["agent gh", "op run -- gh pr close 1", AGENT],
  ["agent gh", "arch -arm64 gh issue close 1", AGENT],
  // The state tool and the PR script: an agent runs only the tool's read commands.
  ["state", `node ${TOOL} task add --title x --size small --priority P2`, AGENT],
  ["state", `node ${PR_TOOL} create T1`, AGENT],
  ["state", `node -e 'import("${TOOL}")'`, AGENT],
  ["state", `arch -arm64 node ${TOOL} task add --title x --size small --priority P2`, AGENT],
  ["state", `op run -- node ${PR_TOOL} create T1`, AGENT],
];
const PASSED = [
  [`echo '${FORM}'`],
  ["gh pr view 12 --json state"],
  ["gh pr create --title t --body 'after the review, the chief runs gh pr merge 12 and git push origin main'"],
  [`git -C ${T} commit --allow-empty -m 'then git push origin main'`],
  [{ claude: `git -C ${T} push -u origin sage/t1-a`, codex: `git -C ${T} push origin sage/t2-b` }],
  ["grep -rn 'gh pr merge' docs"],
  ["gh run list --limit 5"],
  [`cat ${L}/tasks.tsv`, CLAUDE],
  ["rg -n -- --set-password docs", CLAUDE],
  [`node ${TOOL} status | head -5`, AGENT],
  [`node ${TOOL} standing && echo done`, AGENT],
  [`grep -n verdict ${TOOL}`, AGENT],
  ["python3 -c 'print(1)' > out.txt", AGENT],
  // command -v and -V only look a name up (F-T815-17): the fake-proof step of standing order 57.
  ["command -v gh", AGENT],
  ["command -V ps", AGENT],
  ["gh -R acme/project pr view 12", CLAUDE],
  ["rm -rf build && chmod 644 ~/x.txt", CLAUDE],
  // A wrapper's own work, a cd to the home folder and merge text pass (F-T815-30, F-T815-31).
  ["op run -- npm test"],
  ["arch -arm64 node scripts/build.mjs"],
  ["cd ~/x && git status"],
  ["cd ~ && gh pr view 1"],
  ["echo 'gh pr merge 12'"],
  ["which gh", AGENT],
  ["ls -la /opt/homebrew/bin/gh", AGENT],
  [`cp ${BASE}/gh ${BASE}/fake-gh`, AGENT],
  [`arch -arm64 node ${TOOL} status`, AGENT],
];

/** Runs a table's rows as each of their roles; returns the rows whose answer is not the expected one, and the counts. */
function play(rows, refuse) {
  const wrong = [], counts = Object.fromEntries(BOTH.map((role) => [role, 0]));
  for (const [first, second, third, fourth] of rows) {
    const [family, command, roles = BOTH, extra = {}] = refuse ? [first, second, third, fourth] : [undefined, first, second, third];
    for (const role of roles) {
      const text = typeof command === "string" ? command : command[role.split(" ")[0]];
      const why = ROLES[role](text, extra);
      const ok = refuse ? why !== undefined && (role === "codex chief" || WHY[family].test(why)) : why === undefined;
      if (ok) counts[role]++;
      else wrong.push(`${role} · ${refuse ? `${family} ` : ""}${text} → ${why ?? "passed"}`);
    }
  }
  return { wrong, counts };
}

test("T815: every row of the KEEP table refuses in both hooks, for its own rule", (t) => {
  const { wrong, counts } = play(REFUSED, true);
  t.diagnostic(`refused rows by role: ${JSON.stringify(counts)} of ${REFUSED.length} rows`);
  assert.deepEqual(wrong, []);
  assert.deepEqual(counts, { "claude chief": REFUSED.filter(([, , roles = BOTH]) => roles.includes("claude chief")).length,
    "claude agent": REFUSED.filter(([, , roles = BOTH]) => roles.includes("claude agent")).length,
    "codex chief": REFUSED.filter(([, , roles = BOTH]) => roles.includes("codex chief")).length });
});

test("T815: the plain forms pass in both hooks: text that only names a merge or a push, reads and the push form", (t) => {
  const { wrong, counts } = play(PASSED, false);
  t.diagnostic(`passed rows by role: ${JSON.stringify(counts)} of ${PASSED.length} rows`);
  assert.deepEqual(wrong, []);
});

test("T815: the one merge form passes the merge rule, and the role and autopilot rules then decide", () => {
  assert.match(ROLES["claude chief"](FORM) ?? "passed", /^sage: autopilot is off/);
  assert.match(ROLES["claude agent"](FORM) ?? "passed", /^sage: an agent never merges/);
  assert.match(ROLES["codex chief"](FORM) ?? "passed", /^sage: in Codex, only sage's merge command merges/);
  // The fake gh answered the push rule's reads of GitHub's default branch; no other gh call ran.
  assert.match(readFileSync(CALLS, "utf8"), /^api --hostname github\.com repos\/acme\/project --jq \.default_branch$/m);
  assert.doesNotMatch(readFileSync(CALLS, "utf8"), /^(?:pr merge|repo sync|api -X)/m);
});
