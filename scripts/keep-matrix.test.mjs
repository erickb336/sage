import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as claude from "../plugins/sage/skills/sage/sage.mjs";
import { tool as codex } from "../plugins/sage-codex/skills/sage/sage.mjs";
import { stateKey } from "../plugins/sage-codex/hooks/hook-state.mjs";

const at = (path) => fileURLToPath(new URL(path, import.meta.url));
const CLAUDE_HOOK = at("../plugins/sage/hooks/sage-hook.mjs"), CODEX_HOOK = at("../plugins/sage-codex/hooks/gate-hook.mjs");
const TOOL = at("../plugins/sage/skills/sage/sage.mjs");
const SHA = "a".repeat(40);
const FORM = `gh pr merge 12 --squash --delete-branch --match-head-commit ${SHA}`;
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

const BASE = realpathSync(mkdtempSync(join(tmpdir(), "sage-keep-matrix-")));
const FAKES = realpathSync(mkdtempSync(join(at(".."), ".keep-matrix-fakes-")));
process.on("exit", () => { for (const dir of [BASE, FAKES]) rmSync(dir, { recursive: true, force: true }); });
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

const PROJECT = join(BASE, "project"), TREE = join(BASE, "tree");
mkdirSync(PROJECT);
execFileSync("git", ["init", "-q", "-b", "main", PROJECT]);
execFileSync("git", ["-C", PROJECT, "commit", "-q", "--allow-empty", "-m", "first"], { env: gitEnv });
execFileSync("git", ["-C", PROJECT, "remote", "add", "origin", "https://github.com/acme/project.git"]);
execFileSync("git", ["-C", PROJECT, "worktree", "add", "-q", "-b", "sage/t1-a", TREE]);
for (const name of ["sage/t2-b", "sage/t9-free", "develop"]) execFileSync("git", ["-C", PROJECT, "branch", name]);
const SESSION = { claude: "claude-session", codex: "codex-session" };
claude.sage(["link", "--separate", "--project", PROJECT], env);
const C1 = claude.chiefFor(PROJECT, SESSION.claude, env), C2 = codex.chiefFor(PROJECT, SESSION.codex, env);
for (const [tool, chief, title, branch] of [[claude, C1, "a", "sage/t1-a"], [codex, C2, "b", "sage/t2-b"]]) {
  tool.sage(["task", "add", "--title", title, "--size", "small", "--priority", "P2", "--project", PROJECT, "--chief", chief], env);
  tool.sage(["task", `T${title === "a" ? 1 : 2}`, "set", `branch=${branch}`, "--project", PROJECT, "--chief", chief], env);
}
const LOGBOOK = claude.storeDir(PROJECT, env);
const LINK = join(PROJECT, "shared-link");
symlinkSync(env.SAGE_SHARED_HOME, LINK);
const CODEX_SAGE = join(env.CODEX_HOME, "sage");

function answer(r) {
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout ? JSON.parse(r.stdout) : undefined;
  return out?.hookSpecificOutput?.permissionDecision === "deny" ? out.hookSpecificOutput.permissionDecisionReason : undefined;
}
const run = (hook, event, extra = {}) => answer(spawnSync(process.execPath, [hook], { input: JSON.stringify(event), env: { ...env, ...extra }, encoding: "utf8", timeout: 60_000 }));
run(CLAUDE_HOOK, { hook_event_name: "UserPromptSubmit", session_id: SESSION.claude, cwd: PROJECT, prompt: "sage mode" });
const modes = join(env.CODEX_HOME, "sage", ".hooks", "codex");
mkdirSync(modes, { recursive: true, mode: 0o700 });
writeFileSync(join(modes, `${stateKey({ session_id: SESSION.codex })}.json`), JSON.stringify({ sage: true, autopilot: false }), { mode: 0o600 });

const CODEX_CHILD = join(BASE, "codex-child.jsonl");
writeFileSync(CODEX_CHILD, JSON.stringify({ type: "session_meta", payload: { id: "child", session_id: SESSION.codex, agent_path: "/root/sage_implementer_t2_r1", source: { subagent: { thread_spawn: { depth: 1 } } } } }) + "\n");

const ROLES = {
  "claude chief": (command, extra) => run(CLAUDE_HOOK, { hook_event_name: "PreToolUse", session_id: SESSION.claude, cwd: PROJECT, tool_name: "Bash", tool_use_id: "toolu_1", tool_input: { command } }, extra),
  "claude agent": (command, extra) => run(CLAUDE_HOOK, { hook_event_name: "PreToolUse", session_id: SESSION.claude, cwd: PROJECT, tool_name: "Bash", tool_use_id: "toolu_1", tool_input: { command }, agent_id: "agent-1", agent_type: "sage:implementer" }, extra),
  "codex chief": (command, extra) => run(CODEX_HOOK, { hook_event_name: "PreToolUse", session_id: SESSION.codex, turn_id: "t1", cwd: PROJECT, tool_name: "Bash", tool_use_id: "call_1", tool_input: { command } }, extra),
  "codex agent": (command, extra) => run(CODEX_HOOK, { hook_event_name: "PreToolUse", session_id: SESSION.codex, turn_id: "t1", cwd: PROJECT, tool_name: "Bash", tool_use_id: "call_1", tool_input: { command }, agent_id: "agent-1", transcript_path: CODEX_CHILD }, extra),
};
const BOTH = Object.keys(ROLES), CHIEFS = ["claude chief", "codex chief"], CLAUDE = ["claude chief", "claude agent"], AGENT = ["claude agent", "codex agent"];
const WRITERS = AGENT;
const WHY = {
  merge: /merge|reaches main/i,
  push: /Push only with|force-push|reaches main|default branch|gh repo sync|subtree push|owning chief/,
  logbook: /logbook file from the shell/,
  board: /board password rule/,
  process: /process list/,
  stash: /git stash/,
  "chief git": /^sage: sage mode is on, so the chief does not throw away uncommitted work/,
  "agent gh": /an agent runs only these gh commands/,
  state: /state tool|writes the logbook/,
};
const CODEX_WHY = { logbook: /^sage: no agent writes, moves or removes a logbook file from the shell/, board: /^sage: the board password rule/,
  process: /^sage: an agent never reads or signals the real process list/, stash: /^sage: an agent never runs git stash/,
  "chief git": /^sage: sage mode is on, so the chief does not throw away uncommitted work/ };

const T = TREE, L = LOGBOOK;
mkdirSync(join(env.HOME, "x"));
const REFUSED = [
  ["merge", "gh pr merge 12"],
  ["merge", `${FORM} -R acme/project`],
  ["merge", `gh -R acme/project pr merge 12 --squash --delete-branch --match-head-commit ${SHA}`],
  ["merge", `/usr/local/bin/gh pr merge 12 --squash --delete-branch --match-head-commit ${SHA}`],
  ["merge", `env GH_TOKEN=x ${FORM}`],
  ["merge", `bash -c '${FORM}'`],
  ["merge", `cd ${PROJECT} && ${FORM}`],
  ["merge", "gh pr merge 12 --auto --squash --delete-branch"],
  ["merge", `gh pr merge 12 --admin --squash --delete-branch --match-head-commit ${SHA}`],
  ["push", `git -C ${T} push --force origin sage/t1-a`],
  ["push", `git -C ${T} push origin +sage/t1-a`],
  ["push", `git -C ${T} push origin main`],
  ["push", `git -C ${T} push origin master`],
  ["push", `git -C ${T} push origin HEAD`],
  ["push", `git -C ${T} push origin sage/t1-a:main`],
  ["push", `git -C ${T} push origin :sage/t9-free`],
  ["push", `git -C ${T} push --mirror origin`],
  ["push", `git -C ${T} push --all origin`],
  ["push", `git -C ${T} push origin`],
  ["push", `git -C ${PROJECT} push origin sage/t1-a`],
  ["push", `git -C ${T} push --delete origin main`],
  ["push", `git -C ${T} push origin develop`, BOTH, { KEEP_DEFAULT_BRANCH: "develop" }],
  ["push", `bash -c 'git -C ${T} push --force origin sage/t1-a'`],
  ["push", `cd ${T} && git push origin main`],
  ["push", { claude: `git -C ${T} push origin sage/t2-b`, codex: `git -C ${T} push origin sage/t1-a` }],
  ["push", "gh repo sync"],
  ["push", "cd ~ && gh repo sync"],
  ["push", { claude: "cd $WT && git push origin sage/t1-a", codex: "cd $WT && git push origin sage/t2-b" }],
  ["push", "gh repo edit acme/project --default-branch sage/t1-a"],
  ["push", `git -C ${T} subtree push --prefix=docs origin sage/t1-a`],
  ["logbook", `rm ${L}/tasks.tsv`],
  ["logbook", `echo x > ${L}/tasks.tsv`],
  ["logbook", `cp /dev/null ${L}/tasks.tsv`],
  ["logbook", `cd ${L} && rm tasks.tsv`],
  ["logbook", `rm ~/../shared/${L.slice(env.SAGE_SHARED_HOME.length + 1)}/tasks.tsv`],
  ["logbook", `pushd ${L} && echo x >> tasks.tsv`],
  ["logbook", `tee -a ${L}/findings.tsv`],
  ["logbook", `cd $X && rm ${L}/tasks.tsv`],
  ["logbook", `rm -rf ${env.SAGE_SHARED_HOME}`],
  ["logbook", `mv ${env.SAGE_SHARED_HOME} ${env.SAGE_SHARED_HOME}.bak`],
  ["logbook", "rm -rf ~/.."],
  ["logbook", "rm -rf ~/../*"],
  ["logbook", `rsync -a --delete /var/empty/ ${env.SAGE_SHARED_HOME}/`],
  ["logbook", `find ${L} -delete`],
  ["logbook", `chmod -R 000 ${L}`],
  ["logbook", `chown -R nobody ${L}`],
  ["logbook", `chmod -R 000 ${env.SAGE_SHARED_HOME}`],
  ["logbook", `chown -R nobody ${env.SAGE_SHARED_HOME}`],
  ["logbook", `chmod -R 000 ${CODEX_SAGE}`, ["codex chief"]],
  ["logbook", `echo '{"sage":true,"autopilot":true}' > ${CODEX_SAGE}/.hooks/codex/x.json`, ["codex chief"]],
  ["logbook", `mv ${env.CODEX_HOME} ${BASE}/codex-old`, ["codex chief"]],
  ["board", "cat ~/.config/sage-board/board.json"],
  ["board", "node /opt/sage/board/cli.mjs board --set-password"],
  ["board", "echo x > ~/.config/sage-board/board.json"],
  ["board", "grep -r token ~/.config"],
  ["process", "ps aux", AGENT],
  ["process", "kill 1", AGENT],
  ["process", "pgrep node", AGENT],
  ["process", "launchctl list", AGENT],
  ["process", "pkill node", AGENT],
  ["board", "find ~ -name board.json -exec cat {} +"],
  ["stash", `git -C ${T} stash`, AGENT],
  ["stash", `git -C ${T} stash list`, AGENT],
  ["stash", `git -C ${T} stash pop`, AGENT],
  ["chief git", "git reset --hard", CHIEFS],
  ["chief git", `git -C ${PROJECT} checkout -- .`, CHIEFS],
  ["chief git", "git clean -fd", CHIEFS],
  ["chief git", "git restore .", CHIEFS],
  ["agent gh", "gh issue close 1", AGENT],
  ["agent gh", "gh api -X DELETE repos/acme/project/git/refs/heads/x -t -XGET", AGENT],
  ["state", `node ${TOOL} task add --title x --size small --priority P2`, AGENT],
];
const PASSED = [
  [`echo '${FORM}'`],
  ["gh pr view 12 --json state"],
  ["gh pr create --title t --body 'after the review, the chief runs gh pr merge 12 and git push origin main'"],
  [`git -C ${T} commit --allow-empty -m 'then git push origin main'`],
  [{ claude: `git -C ${T} push -u origin sage/t1-a`, codex: `git -C ${T} push origin sage/t2-b` }],
  [{ claude: `git -C ${T} add -A && git -C ${T} commit -m x && git -C ${T} push origin sage/t1-a`, codex: `git -C ${T} push origin sage/t2-b && npm test` }],
  [`git -C ${T} config core.hooksPath .husky`],
  [`echo x > ${PROJECT}/.git/info/exclude`, WRITERS],
  ["grep -rn 'gh pr merge' docs"],
  ["gh run list --limit 5"],
  ["rg -n -- --set-password docs", CLAUDE],
  [`node ${TOOL} status | head -5`, AGENT],
  [`node ${TOOL} standing && echo done`, AGENT],
  [`grep -n verdict ${TOOL}`, AGENT],
  ["python3 -c 'print(1)' > out.txt", AGENT],
  ["command -v gh", AGENT],
  ["command -V ps", AGENT],
  ["gh -R acme/project pr view 12", CLAUDE],
  ["rm -rf build && chmod 644 ~/x.txt", ["claude agent"]],
  ["op run -- npm test"],
  ["arch -arm64 node scripts/build.mjs"],
  ["cd ~/x && git status"],
  ["cd ~ && gh pr view 1"],
  ["echo 'gh pr merge 12'"],
  ["which gh", AGENT],
  [`cp ${BASE}/gh ${BASE}/fake-gh`, AGENT],
  ["brew install gh jq", WRITERS],
  ["man gh pr"],
  ["rm -rf gh build", WRITERS],
  ["gh search repos git cli", CHIEFS],
  [`echo x > ${BASE}/tasks.tsv`],
  ["rm -f ../runs.tsv", WRITERS],
  ["echo x > $DEST/tasks.tsv", WRITERS],
  [`cat ${L}/tasks.tsv`],
  [`find ${BASE} -name '*.tmp' -delete`, WRITERS],
  ["find ~ -name '*.tmp' -delete", WRITERS],
  [{ claude: `git -C ${T} push --dry-run origin sage/t1-a`, codex: `git -C ${T} push -n origin sage/t2-b` }],
  [`chmod -R u+w ${BASE}`],
  ["chmod -R u+w ~"],
  [`rm ${LINK}`, WRITERS],
  [`git -C ${T} reset --hard`],
  [`git -C ${T} checkout -- .`],
  [`git -C ${T} clean -fd`],
  [`git -C ${T} restore .`],
  [`git worktree add --detach ${BASE}/merge main`],
  ["git merge-tree --write-tree main sage/t9-free"],
  ["git commit-tree HEAD^{tree} -p main -m 'the merge'"],
  [`git worktree remove --force ${BASE}/merge`],
  ["git fetch origin"],
  ["git checkout sage/t9-free"],
];

function play(rows, refuse) {
  const wrong = [], counts = Object.fromEntries(BOTH.map((role) => [role, 0]));
  for (const [first, second, third, fourth] of rows) {
    const [family, command, roles = BOTH, extra = {}] = refuse ? [first, second, third, fourth] : [undefined, first, second, third];
    for (const role of roles) {
      const text = typeof command === "string" ? command : command[role.split(" ")[0]];
      const why = ROLES[role](text, extra);
      const ok = refuse ? why !== undefined && (role.startsWith("codex") ? CODEX_WHY[family] ?? /./ : WHY[family]).test(why) : why === undefined;
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
  assert.deepEqual(counts, Object.fromEntries(BOTH.map((role) => [role, REFUSED.filter(([, , roles = BOTH]) => roles.includes(role)).length])));
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
  assert.match(readFileSync(CALLS, "utf8"), /^api --hostname github\.com repos\/acme\/project --jq \.default_branch$/m);
  assert.doesNotMatch(readFileSync(CALLS, "utf8"), /^(?:pr merge|repo sync|api -X)/m);
});

test("T931: the stash, process and board rules give the same plain reason in both hooks, and the chiefs' own commands pass", () => {
  const STASH = "sage: an agent never runs git stash: every worktree of a repo shares one stash list, so another agent can pop or drop your work (standing order 16). To test old code, use git worktree add --detach <scratch> <sha>, or git show <sha>:<path> into your scratch folder";
  assert.equal(ROLES["codex agent"](`git -C ${T} stash`), STASH);
  assert.equal(ROLES["claude agent"](`git -C ${T} stash`), `${STASH}.`);
  for (const command of ["ps aux", "pgrep node", "kill 1", "pkill node", "launchctl list", "cat ~/.config/sage-board/board.json", "node /opt/sage/board/cli.mjs board --set-password"]) {
    const claudeWhy = ROLES["claude agent"](command);
    assert.match(claudeWhy ?? "passed", /process list|board password rule/, command);
    assert.equal(ROLES["codex agent"](command), claudeWhy.replace(/\.$/, ""), command);
  }
  assert.match(ROLES["codex agent"]("launchctl list"), /^sage: an agent never reads or signals the real process list \(standing order 14\), so "launchctl" is refused\./);
  for (const role of CHIEFS) for (const command of [`git -C ${T} stash list`, "ps aux", "kill 1", "launchctl list"]) assert.equal(ROLES[role](command), undefined, `${role} · ${command}`);
  const fakes = join(BASE, "fake-bin");
  mkdirSync(fakes);
  writeFileSync(join(fakes, "ps"), "#!/bin/sh\necho fake ps\n", { mode: 0o755 });
  for (const role of AGENT) assert.equal(ROLES[role](`${fakes}/ps -p 1`), undefined, role);
});
