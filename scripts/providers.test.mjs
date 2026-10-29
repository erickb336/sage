import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { ROOT, filesUnder, outputs } from "./build.mjs";
import { createStateTool, applyPrinciples } from "../packages/sage-core/index.mjs";
import { handle, patchPaths, stateKey } from "../plugins/sage-codex/hooks/principles-hook.mjs";

const context = (output) => output?.hookSpecificOutput?.additionalContext ?? "";
const state = () => ({ given: [], failures: {} });
const source = (path) => readFileSync(join(ROOT, path), "utf8");
const json = (path) => JSON.parse(source(path));

// T91 fixtures contain only synthetic reports and disposable logbooks.
const reportDigest = text => createHash("sha256").update(text, "utf8").digest("hex");
function comparisonFixture(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "sage-report-compare-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const project = join(home, "project"); mkdirSync(project);
  const env = { ...process.env, SAGE_HOME: join(home, "store"), SAGE_TEST_PIDS: "{}" };
  const tool = createStateTool({ defaultRoot: () => env.SAGE_HOME });
  const command = (...args) => tool.command([...args, "--project", project], env);
  assert.equal(command("init").code, 0);
  assert.equal(command("task", "add", "--title", "Synthetic comparison", "--size", "large", "--priority", "P2").code, 0);
  assert.equal(command("run", "add", "T1", "--role", "pe").code, 0);
  const dir = tool.storeDir(project, env), file = join(dir, "kept/R1.json");
  const input = { project, task: "T1", run: "R1", sha256: reportDigest("STATUS blocked\nRESULT café 🙂\r\n ") };
  const compare = (change = {}) => tool.compareRetainedReport({ ...input, ...change }, env);
  const retain = (text = "STATUS blocked\nRESULT café 🙂\r\n ") => tool.keepReport(project, { task: "T1", run: "R1", role: "pe", text }, env);
  const snapshot = (path = home) => Object.fromEntries(readdirSync(path).sort().map(name => {
    const child = join(path, name), st = lstatSync(child);
    return [name, { mode: st.mode, mtime: st.mtimeMs, ino: st.ino,
      content: st.isDirectory() ? snapshot(child) : st.isFile() ? readFileSync(child).toString("hex") : "link" }];
  }));
  return { home, project, env, tool, command, dir, file, input, compare, retain, snapshot };
}

test("T91: comparison returns only missing, match, mismatch and damaged without mutations", t => {
  const f = comparisonFixture(t);
  for (const [prepare, expected] of [
    [() => {}, "missing"], [() => f.retain(), "match"],
    [() => {}, "mismatch"], [() => writeFileSync(f.file, "{"), "damaged"],
  ]) {
    prepare(); const before = f.snapshot();
    assert.deepEqual(f.compare(expected === "mismatch" ? { sha256: reportDigest("another report") } : {}), { status: expected });
    assert.deepEqual(f.snapshot(), before);
  }
});

test("T91: comparison preserves exact UTF-8, newline and whitespace bytes after an ended run", t => {
  const f = comparisonFixture(t), text = "STATUS question\nRESULT café 🙂\r\n ";
  f.retain(text);
  assert.equal(f.command("run", "done", "R1", "--status", "question").code, 0);
  const before = f.snapshot();
  for (const candidate of [text, text.normalize("NFD"), text.replaceAll("\r\n", "\n"), text.trimEnd(), text + "\n", text.replace(" ", "  ")])
    assert.deepEqual(f.compare({ sha256: reportDigest(candidate) }), { status: candidate === text ? "match" : "mismatch" });
  assert.deepEqual(f.snapshot(), before);
});

test("T91: comparison validates stored identities, integrity and legacy records honestly", t => {
  const f = comparisonFixture(t); f.retain();
  const original = JSON.parse(readFileSync(f.file, "utf8"));
  // Existing six-field records have no digest. Recompute it; do not invent a native authenticity claim.
  assert.deepEqual(f.compare(), { status: "match" });
  for (const changed of [{ task: "T2" }, { run: "R2" }, { role: "designer" }, { sha: "bad" }, { at: "yesterday" },
    { text: 1 }, { text: "x".repeat((1 << 20) + 1) }, { reportHash: "0".repeat(64) }]) {
    writeFileSync(f.file, JSON.stringify({ ...original, ...changed }));
    const before = f.snapshot();
    assert.deepEqual(f.compare(), { status: "damaged" }, JSON.stringify(Object.keys(changed)));
    assert.deepEqual(f.snapshot(), before);
  }
  for (const value of [null, [], { text: original.text }, { ...original, at: undefined }, { ...original, text: "\ud800" }]) {
    writeFileSync(f.file, JSON.stringify(value));
    assert.deepEqual(f.compare(), { status: "damaged" });
  }
  writeFileSync(f.file, Buffer.from([0xff]));
  assert.deepEqual(f.compare(), { status: "damaged" });
});

test("T91: invalid input, unknown associations and wrong project remain errors without writes", t => {
  const f = comparisonFixture(t); f.retain();
  assert.equal(f.command("task", "add", "--title", "Other", "--size", "tiny", "--priority", "P2").code, 0);
  const before = f.snapshot();
  for (const change of [{ task: "T2" }, { task: "T99" }, { run: "R99" }, { run: "../R1" },
    { sha256: "bad" }, { sha256: "A".repeat(64) }, { project: "relative" }, { project: join(f.home, "absent") }, { extra: "no" }])
    assert.throws(() => f.compare(change), /retained report|comparison/i);
  assert.deepEqual(f.snapshot(), before);
  writeFileSync(join(f.dir, "checkout.txt"), `${join(f.home, "foreign")}\n`);
  assert.throws(() => f.compare(), /retained report|comparison/i);
});

test("T91: comparison rejects links, non-files and unreadable retained files without exposing paths", t => {
  const f = comparisonFixture(t); f.retain();
  const original = readFileSync(f.file);
  rmSync(f.file); symlinkSync(join(f.home, "absent"), f.file);
  assert.deepEqual(f.compare(), { status: "damaged" });
  rmSync(f.file); mkdirSync(f.file);
  assert.deepEqual(f.compare(), { status: "damaged" });
  rmSync(f.file, { recursive: true }); writeFileSync(f.file, original, { mode: 0o000 });
  try { assert.throws(() => f.compare(), error => /comparison.*(permission|read)/i.test(error.message) && !error.message.includes(f.home)); }
  finally { chmodSync(f.file, 0o600); }
});

test("T91: comparison leaves first-report retention and verdict decisions unchanged", t => {
  const f = comparisonFixture(t); f.retain("STATUS blocked\n");
  assert.deepEqual(f.compare({ sha256: reportDigest("STATUS blocked\n") }), { status: "match" });
  assert.throws(() => f.retain("STATUS done\nRESULT CLEAN\n"), /kept once/);
  assert.equal(f.command("run", "done", "R1", "--status", "blocked").code, 0);
  const before = f.snapshot();
  assert.deepEqual(f.compare({ sha256: reportDigest("STATUS blocked\n") }), { status: "match" });
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.command("verdict", "T1", "--kind", "review-clean", "--sha", "1".repeat(40), "--run", "R1").text,
    "sage: R1 is a pe run, so it backs no review-clean verdict: only a code-reviewer run does. Nothing changed.");
});

test("T91: a manual report page and legacy project listing never create retention during comparison", t => {
  const f = comparisonFixture(t);
  assert.equal(f.command("pages", "T1", "record", "--run", "R1", "--text", "STATUS done\n").code, 0);
  for (const name of ["projects.tsv", "projects.made"]) rmSync(join(f.env.SAGE_HOME, name), { force: true });
  const before = f.snapshot();
  assert.deepEqual(f.compare(), { status: "missing" });
  assert.deepEqual(f.snapshot(), before);
});

test("T91: bundled provider cores compare the same synthetic retained report", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = comparisonFixture(t), { plugin } = isolated(t, provider);
    const { createStateTool: bundled } = await import(pathToFileURL(join(plugin, "core/index.mjs")));
    f.retain();
    const before = f.snapshot();
    assert.deepEqual(bundled({ defaultRoot: () => f.env.SAGE_HOME }).compareRetainedReport(f.input, f.env), { status: "match" });
    assert.deepEqual(f.snapshot(), before);
  }
});
/**
 * A fake readGit for the push policy (T536): the checkout's branch (a name, or a function of the folder), git's settings
 * with one remote named origin, and origin's default branch (main unless given; undefined when git cannot read it).
 */
const fakeGit = (branch, { head = "main", settings = "remote.origin.url\nhttps://github.com/acme/project.git\0" } = {}) => (dir, args) =>
  args[1] === "--symbolic-full-name" ? `refs/heads/${args[2].replace(/^(?:refs\/)?(?:heads\/)?/, "")}\n`
    : args[0] === "rev-parse" ? (typeof branch === "function" ? branch(dir) : branch)
      : args[0] === "config" ? settings
        : head === undefined ? undefined : `refs/remotes/origin/${head}\n`;
/** A fake readGh (T536): GitHub names main as the default branch of every repository. */
const fakeGh = (args) => (args.at(-1) === ".default_branch" ? "main\n" : undefined);

test("T51: external command operands retain executable identity and expansion refusals", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    const bin = join(f.dir, "bin"); mkdirSync(bin);
    const external = join(bin, "command"); writeFileSync(external, "#!/bin/sh\nexit 0\n"); chmodSync(external, 0o755);
    const sample = "env X=1 command g{i..i}t push origin HEAD:main";
    const runs = api.programsRun(sample, f.dir, bin);
    assert.deepEqual(runs.map(({ word, file, args }) => ({ word, file, args })), [
      { word: "command", file: external, args: ["g{i..i}t", "push", "origin", "HEAD:main"] },
    ], "prospective operands must not become executable evidence");
    const policy = api.createCommandPolicy();
    for (const command of [sample, "env command -p command -- git pu{s..s}h origin topic", "env command -- gh pr m?rg* 1"])
      assert.match(policy.expansionProblem(command, f.dir), /shell expansion can hide the command/, command);
    for (const command of ["env command printf '%s' 'g{i..i}t push origin HEAD:main'", "env command git log --format='{x}'",
      "env command gh api 'repos/{owner}/{repo}/pulls?state=open'", "env command eval 'g{i..i}t push origin HEAD:main'", "env command -v 'g*'",
      "command() { printf '%s' \"$@\"; }; command 'g{i..i}t' push origin HEAD:main"])
      assert.equal(policy.expansionProblem(command, f.dir), undefined, command);
  }
});

test("T51: external command operands keep protected API refusals without judging data or reads", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    const request = "/usr/local/bin/gh api -X POST repos/acme/blank/git/refs -f ref=refs/heads/main -f sha=1111111111111111111111111111111111111111";
    const sample = `A=1 env B=2 command ${request}`;
    assert.deepEqual(api.programsRun(sample, f.dir, "").map(run => run.word), ["command"]);
    const policy = api.createPushPolicy({ readGh: fakeGh, readGit: fakeGit("topic") });
    for (const command of [sample, `env command -p command -- ${request}`])
      assert.match(policy.pushProblem(command, f.dir), /work reaches main only through a pull request/, command);
    for (const command of [sample.replace("heads/main", "heads/topic"), sample.replace("-X POST", "-X GET"),
      `env command printf '%s' '${request}'`, `env command eval '${request}'`, `env command -v gh`,
      `command() { printf '%s' "$@"; }; command ${request}`])
      assert.equal(policy.pushProblem(command, f.dir), undefined, command);
  }
});

test("T51: builtin chains retain shell lookup while native wrappers retain argv identity", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    const chains = ["command command git stash", "command builtin eval 'git stash'", "builtin command git stash", "command exec git stash", "time command builtin eval 'git stash'"];
    for (const command of chains)
      assert.ok(api.programsRun(command, f.dir, "").some(run => run.word === "git" && run.args[0] === "stash"), command);
    for (const command of ["env command git stash", "exec command git stash", "env builtin eval 'git stash'", "command env eval 'git stash'"])
      assert.ok(!api.programsRun(command, f.dir, "").some(run => run.word === "git"), command);
    assert.ok(api.programsRun("command time git stash", f.dir, "", { contextEvidence: true }).programs.some(({ run, wrapper }) => run.word === "time" && wrapper), "time after command is an external wrapper");
    if (provider === "claude") {
      const hook = await import(pathToFileURL(join(f.plugin, "hooks/sage-hook.mjs")));
      for (const command of chains) assert.match(hook.agentProblem(command, f.dir, "") ?? "", /never runs git stash/, command);
      assert.equal(hook.agentProblem("command command git status", f.dir, ""), undefined);
      assert.equal(hook.agentProblem("command builtin printf '%s' 'git stash'", f.dir, ""), undefined);
    }
  }
});

test("T51: Bash builtin spellings do not hide external executable identity", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    const bin = join(f.dir, "bin"); mkdirSync(bin);
    const gh = join(bin, "gh"); writeFileSync(gh, "#!/bin/sh\nexit 0\n"); chmodSync(gh, 0o755);
    for (const name of ["COMMAND", "BUILTIN", "EXEC", "TIME", "NOGLOB", "NOcorrect", "command.exe"]) {
      linkSync(gh, join(bin, name));
      const evidence = api.programsRun(`${name} pr create`, f.dir, bin, { executableEvidence: true });
      assert.ok(evidence.some(run => run.word === name && run.file === join(bin, name)), name);
    }
    for (const name of ["EVAL", "eval.exe", "/tools/eval"])
      assert.deepEqual(api.programsRun(`${name} 'git stash'`, f.dir, bin).map(run => run.word), [name], name);
    assert.deepEqual(api.programsRun("command git status", f.dir, bin).map(run => run.word), ["git"]);
    assert.ok(api.programsRun("eval 'git stash'", f.dir, bin).some(run => run.word === "git"));
    if (provider === "claude") {
      const hook = await import(pathToFileURL(join(f.plugin, "hooks/sage-hook.mjs")));
      assert.match(hook.agentProblem("COMMAND pr create", f.dir, bin) ?? "", /plain gh/, "the gh identity of an external alias stays visible");
    }
  }
});

test("T51: built hook normalizes agent stash, process, reader and writer executable names", async t => {
  const f = isolated(t, "claude"), logbook = join(f.dir, "logbook"); mkdirSync(logbook);
  // The hook resolves each name on PATH and allows a temporary fake by design. An empty PATH folder keeps the result the
  // same with or without the caller's fake ps first on PATH: on a case-insensitive file system, "PS" finds that fake (T469).
  const saved = { SAGE_HOME: process.env.SAGE_HOME, PATH: process.env.PATH }, bin = join(f.dir, "bin"); mkdirSync(bin);
  Object.assign(process.env, { SAGE_HOME: logbook, PATH: bin });
  t.after(() => { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  const hook = await import(pathToFileURL(join(f.plugin, "hooks/sage-hook.mjs")));
  const decide = command => hook.handle({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: f.dir,
    agent_id: "fixture", agent_type: "sage:implementer", tool_input: { command } }, { sage: true }, { touch() {} });
  for (const executable of ["GIT", "Git.exe", "/opt/homebrew/bin/GIT", "'/tools/Git.EXE'"]) {
    assert.match(decide(`${executable} stash`)?.hookSpecificOutput?.permissionDecisionReason ?? "", /never runs git stash/, executable);
    assert.notEqual(decide(`${executable} status`)?.hookSpecificOutput?.permissionDecision, "deny", executable);
  }
  for (const name of ["PS", "PGREP.exe", "KiLlAll.EXE", "/tools/GET-PROCESS.exe"])
    assert.match(decide(`${name} sample`)?.hookSpecificOutput?.permissionDecisionReason ?? "", /process list/, name);
  const fake = join(f.dir, "PS.EXE"); writeFileSync(fake, "#!/bin/sh\nexit 0\n"); chmodSync(fake, 0o755);
  assert.notEqual(decide(`'${fake}' sample`)?.hookSpecificOutput?.permissionDecision, "deny", "a real temporary fake remains allowed");
  for (const command of [`CP.exe source '${logbook}/tasks.tsv'`, `RG.exe --pre cat '${logbook}/tasks.tsv'`, `FILE.exe -C '${logbook}/tasks.tsv'`])
    assert.equal(decide(command)?.hookSpecificOutput?.permissionDecision, "deny", command);
  for (const command of [`CAT.exe '${logbook}/tasks.tsv'`, `PRINTF.exe '%s' 'GIT stash'`, `CAT.exe '${f.plugin}/skills/sage/sage.mjs'`])
    assert.notEqual(decide(command)?.hookSpecificOutput?.permissionDecision, "deny", command);
});

test("T51: PowerShell launcher evidence preserves literal arguments and reaches push and stash guards", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    const options = { powerShell: true };
    const forms = [
      `Start-Process git -ArgumentList 'push','origin','main'`,
      `start -ArgumentList 'push origin main' -FilePath Git.exe`,
      `START-PROCESS -FilePath '/tools/GIT.exe' -Wait -ArgumentList "push", "origin", "main"`,
      `Start-Process git 'push', 'origin', 'main'`,
      `Start-Process -ArgumentList 'push','--force','origin','topic' -FilePath git`,
    ];
    const policy = api.createPushPolicy({ readGh: fakeGh, readGit: fakeGit("topic") });
    for (const command of forms) {
      const runs = api.programsRun(command, f.dir, "", options);
      assert.equal(runs.length, 1, command);
      assert.equal(runs[0].args[0], "push", "the launcher exposes the real child subcommand");
      assert.equal(api.programName(runs[0].word), "git");
      assert.ok(policy.pushProblem(command, f.dir, options), command);
    }
    for (const command of [
      `Start-Process env -ArgumentList 'git push origin main'`,
      `Start-Process pwsh -ArgumentList '-Command "git push origin main"'`,
      `Start-Process bash -ArgumentList '-c "git push origin main"'`,
    ]) {
      assert.ok(api.programsRun(command, f.dir, "", options).some(run => run.word === "git" && run.powerShellLaunch === true), command);
      assert.ok(policy.pushProblem(command, f.dir, options), command);
    }
    const comma = api.programsRun(`Start-Process -FilePath echo -ArgumentList 'literal,comma','"two words"'`, f.dir, "", options);
    assert.deepEqual(comma[0].args, ["literal,comma", "two words"]);
    assert.deepEqual(api.programsRun(`Start-Process start -ArgumentList 'literal'`, f.dir, "", options).map(({ word, args }) => ({ word, args })), [{ word: "start", args: ["literal"] }], "a native child is not interpreted again as a PowerShell alias");
    assert.equal(api.programsRun(`start git -ArgumentList 'stash'`, f.dir, "")[0].word, "start", "Bash start remains an ordinary executable");
    // R1935-1 item 2: a push found only through a launcher gets the same check of the commands beside it.
    assert.equal(policy.pushProblem("Start-Process git -ArgumentList 'push','origin','topic'", f.dir, options), undefined, "the launched push form passes");
    assert.match(policy.pushProblem("git config remote.origin.push refs/heads/topic:refs/heads/main; Start-Process git -ArgumentList 'push','origin','topic'", f.dir, options) ?? "",
      /"git config remote\.origin\.push refs\/heads\/topic:refs\/heads\/main" runs in the same command line as the push/);
    const nested = `pwsh -Command "Start-Process git -ArgumentList 'stash'"`;
    const nestedPush = `PowerShell.exe -Command "start -ArgumentList 'push','origin','main' -FilePath git"`;
    assert.ok(policy.pushProblem(nestedPush, f.dir), "nested launcher push reaches the policy");
    assert.ok(api.programsRun(nested, f.dir, "").some(run => api.programName(run.word) === "git" && run.args[0] === "stash"));
    if (provider !== "claude") continue;
    const hook = await import(pathToFileURL(join(f.plugin, "hooks/sage-hook.mjs")));
    const decide = (command, actor = {}, tool_name = "PowerShell") => hook.handle({ hook_event_name: "PreToolUse", tool_name,
      cwd: f.dir, tool_input: { command }, ...actor }, { sage: true }, { touch() {} });
    for (const actor of [{}, { agent_id: "fixture", agent_type: "sage:implementer" }]) {
      for (const command of [...forms, nestedPush, "Git push origin main", "git.exe push --force origin topic"])
        assert.equal(decide(command, actor)?.hookSpecificOutput?.permissionDecision, "deny", command);
      for (const command of [`Start-Process git -ArgumentList 'status'`, `start -ArgumentList 'status' -FilePath git -Wait`, `git status`])
        assert.notEqual(decide(command, actor)?.hookSpecificOutput?.permissionDecision, "deny", command);
    }
    for (const command of [`Start-Process git -ArgumentList 'stash'`, `start -ArgumentList 'stash' -FilePath git`, nested])
      assert.equal(decide(command, { agent_id: "fixture", agent_type: "sage:implementer" }, command === nested ? "Bash" : "PowerShell")?.hookSpecificOutput?.permissionDecision, "deny", command);
    assert.equal(decide(`Start-Process GH.exe -ArgumentList 'repo delete example'`, { agent_id: "fixture", agent_type: "sage:implementer" })?.hookSpecificOutput?.permissionDecision, "deny", "launcher child reaches the agent gh policy");
    for (const command of [`Start-Process -FilePath $program -ArgumentList 'status'`, `Start-Process git -Mystery ignored -ArgumentList status`])
      assert.equal(decide(command)?.hookSpecificOutput?.permissionDecision, "deny", command);
  }
});

test("T51: PowerShell quote ambiguity cannot hide a protected push or merge", async t => {
  const f = isolated(t, "claude");
  const hook = await import(pathToFileURL(join(f.plugin, "hooks/sage-hook.mjs")));
  const wrap = command => `echo "\\"; ${command}; echo "\\"`;
  for (const actor of [{}, { agent_id: "fixture", agent_type: "sage:implementer" }]) {
    for (const protectedCommand of ["git push origin main", "Gh.exe pr merge 1 --admin"]) {
      const command = wrap(protectedCommand);
      const result = hook.handle({ hook_event_name: "PreToolUse", tool_name: "PowerShell", cwd: f.dir,
        tool_input: { command }, ...actor }, { sage: true }, { touch() {} });
      assert.equal(result?.hookSpecificOutput?.permissionDecision, "deny", command);
    }
    const result = hook.handle({ hook_event_name: "PreToolUse", tool_name: "PowerShell", cwd: f.dir,
      tool_input: { command: `echo 'ordinary text'` }, ...actor }, { sage: true }, { touch() {} });
    assert.notEqual(result?.hookSpecificOutput?.permissionDecision, "deny");
    const bash = hook.handle({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: f.dir,
      tool_input: { command: wrap("git push origin main") }, ...actor }, { sage: true }, { touch() {} });
    assert.notEqual(bash?.hookSpecificOutput?.permissionDecision, "deny", "Bash quote semantics remain unchanged");
  }
});

test("T49: built Claude hook protects the logbook from output writers while preserving reads and scratch output", async t => {
  const f = isolated(t, "claude"), logbook = join(f.dir, "logbook"); mkdirSync(logbook);
  const previous = process.env.SAGE_HOME; process.env.SAGE_HOME = logbook;
  t.after(() => { if (previous === undefined) delete process.env.SAGE_HOME; else process.env.SAGE_HOME = previous; });
  const hook = await import(pathToFileURL(join(f.plugin, "hooks/sage-hook.mjs")));
  const forms = [
    path => `curl -o ${path} https://example.invalid`,
    path => `CURL.exe --output=${path} https://example.invalid`,
    path => `env X=1 curl -sSo${path} https://example.invalid`,
    path => `git diff --output=${path}`, path => `git show --output ${path}`,
    path => `Git.exe log --output=${path}`,
    path => `ditto source.txt ${path}`, path => `scp source.txt ${path}`,
    path => `wget -O ${path} https://example.invalid`,
    path => `openssl dgst -sha256 -out ${path} source.txt`,
    path => `openssl dgst --out ${path} source.txt`,
    path => `sqlite3 scratch.db '.output ${path}'`,
    path => `tar -xf archive.tar -C ${path}`, path => `unzip archive.zip -d ${path}`,
    path => `rsync source.txt ${path}`, path => `install source.txt ${path}`, path => `dd if=source.txt of=${path}`,
  ];
  for (const actor of [{}, { agent_id: "fixture-child", agent_type: "sage:implementer" }]) {
    for (const form of forms) {
      const command = form(`${logbook}/tasks.tsv`);
      const result = hook.handle({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: f.dir,
        tool_input: { command }, ...actor }, { sage: true }, { touch() {} });
      assert.equal(result?.hookSpecificOutput?.permissionDecision, "deny", `${actor.agent_id ?? "chief"}: ${command}`);
      assert.match(result.hookSpecificOutput.permissionDecisionReason, /logbook/);
    }
  }
  assert.deepEqual(readdirSync(logbook), [], "sample commands are parsed, never executed");
  const commands = [
    "curl -o scratch.txt https://example.invalid", "CURL.exe --output=scratch.txt https://example.invalid",
    "git diff --output=scratch.txt", "git show --output scratch.txt", "git log --output=scratch.txt",
    "ditto source.txt scratch.txt", "scp source.txt scratch.txt", "wget -O scratch.txt https://example.invalid",
    "openssl dgst -out scratch.txt source.txt", "sqlite3 scratch.db '.output scratch.txt'",
    "tar -xf archive.tar -C scratch", "unzip archive.zip -d scratch", "rsync source.txt scratch.txt",
    "install source.txt scratch.txt", "dd if=source.txt of=scratch.txt",
    `cat ${logbook}/tasks.tsv`, `printf '%s' 'curl -o ${logbook}/tasks.tsv'`,
    `git show --format='--output=${logbook}/tasks.tsv'`,
    `curl --header '--output=${logbook}/tasks.tsv' https://example.invalid`,
  ];
  for (const actor of [{}, { agent_id: "fixture-child", agent_type: "sage:implementer" }]) {
    for (const command of commands) {
      const result = hook.handle({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: f.dir,
        tool_input: { command }, ...actor }, { sage: true }, { touch() {} });
      assert.notEqual(result?.hookSpecificOutput?.permissionDecision, "deny", `${actor.agent_id ?? "chief"}: ${command}: ${JSON.stringify(result)}`);
    }
  }
  const get = hook.handle({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: f.dir,
    tool_input: { command: "gh api -X GET repos/o/r/contents/file -f ref=main" } }, { sage: true }, { touch() {} });
  assert.notEqual(get?.hookSpecificOutput?.permissionDecision, "deny");
  for (const broken of [false, true]) {
    const f = isolated(t, "claude"), logbook = join(f.dir, "logbook"); mkdirSync(logbook);
    const previous = process.env.SAGE_HOME; process.env.SAGE_HOME = logbook;
    try {
      if (broken) writeFileSync(join(f.plugin, "core/shell-write-policy.mjs"), 'throw new Error("fixture broken writer");\n');
      const hook = await import(pathToFileURL(join(f.plugin, "hooks/sage-hook.mjs")));
      for (const actor of [{}, { agent_id: "fixture-child", agent_type: "sage:implementer" }]) {
        const command = broken ? `curl -o ${logbook}/tasks.tsv https://example.invalid` : `curl -o ${logbook}/tasks.tsv 'open`;
        const result = hook.handle({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: f.dir,
          tool_input: { command }, ...actor }, { sage: true }, { touch() {} });
        assert.equal(result?.hookSpecificOutput?.permissionDecision, "deny", `${broken}: ${JSON.stringify(result)}`);
      }
    } finally { if (previous === undefined) delete process.env.SAGE_HOME; else process.env.SAGE_HOME = previous; }
  }
});

test("T45: executable spellings preserve shared writer and reader-option checks", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const { commandWrites } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    for (const command of ["CP.exe source.txt target.txt", "/tools/Cp.ExE source.txt target.txt",
      "RG.exe --pre cat sample", "/tools/RG.ExE -z sample", "FILE.exe -C", "DIFF.exe -l left right",
      "SED.exe -i 's/a/b/' sample", "SORT.exe -o result.txt sample", "FIND.exe . -delete"])
      assert.equal(commandWrites(command, f.dir), true, command);
    for (const command of ["cat.exe cp", "PRINTF.exe '%s' 'cp target.txt'", "RG.exe -C 2 sample",
      "RG.exe --regexp=--pre sample", "RG.exe -- --pre", "FILE.exe -c magic.txt", "DIFF.exe --label=-l left right"])
      assert.equal(commandWrites(command, f.dir), false, command);
  }
});

test("T45: executable suffixes cannot bypass the protected logbook path check", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider), root = join(f.dir, "logbook"); mkdirSync(root);
    const { shellWriteOutsideRoots } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    assert.equal(shellWriteOutsideRoots({ command: `CP.exe source.txt ${root}/ledger.tsv`, cwd: f.dir, roots: [root] }), false);
    assert.equal(shellWriteOutsideRoots({ command: "CP.exe source.txt scratch.txt", cwd: f.dir, roots: [root] }), true);
    assert.equal(shellWriteOutsideRoots({ command: `CAT.exe ${root}/ledger.tsv`, cwd: f.dir, roots: [root] }), true);
  }
});

test("T45: normalized reader arguments stay data while redirection targets stay protected", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider), root = join(f.dir, "logbook"); mkdirSync(root);
    const { shellWriteOutsideRoots } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    for (const name of ["printf", "PRINTF.exe", "/tools/PrInTf.ExE"])
      assert.equal(shellWriteOutsideRoots({ command: `${name} '%s' '${root}/ledger.tsv' > scratch.txt`, cwd: f.dir, roots: [root] }), true, name);
    assert.equal(shellWriteOutsideRoots({ command: `PRINTF.exe '%s' data > ${root}/ledger.tsv`, cwd: f.dir, roots: [root] }), false);
  }
});

test("T44: output-file dispatches count as writes in both packaged cores", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const { commandWrites } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    for (const command of [
      "curl -o result.txt https://example.invalid", "curl -fsSLoresult.txt https://example.invalid",
      "CURL.exe --output=result.txt https://example.invalid", "env X=1 curl -D headers.txt https://example.invalid",
      "curl --cookie-jar jar.txt https://example.invalid", "curl -O https://example.invalid/file",
      "curl --trace trace.txt https://example.invalid", "curl --config settings.txt",
      "git diff --output=result.txt", "git -C . show --output result.txt", "Git.exe log --output=result.txt",
      "ditto source.txt target.txt", "scp source.txt target.txt", "wget -O result.txt https://example.invalid",
      "openssl dgst -sha256 -out result.txt source.txt", "sqlite3 data.db '.output result.txt'",
    ]) assert.equal(commandWrites(command, f.dir), true, command);
  }
});

test("T44: reader operands and ordinary output-free commands remain data", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const { commandWrites } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    assert.equal(commandWrites("curl -H '-o' -o result.txt https://example.invalid", f.dir), true);
    assert.equal(commandWrites("git log --grep '--output=search' --output=result.txt", f.dir), true);
    for (const command of [
      "curl -fsSL https://example.invalid", "curl -H '-o' https://example.invalid",
      "curl --header '--output=file' https://example.invalid", "curl --data '-o' https://example.invalid",
      "curl -- https://example.invalid/-o", "git diff -- --output=file", "git show --format=--output=file",
      "git log --grep '--output=result.txt'", "git show --format '--output=result.txt'",
      "echo curl -o result.txt", "printf '%s' 'git diff --output=result.txt'", "openssl dgst -sha256 source.txt",
    ]) assert.equal(commandWrites(command, f.dir), false, command);
  }
});

test("T44: known output programs cannot write protected paths but can write scratch files", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider), root = join(f.dir, "logbook"); mkdirSync(root);
    const { shellWriteOutsideRoots } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    for (const form of [
      path => `curl -o ${path} https://example.invalid`, path => `curl -sSo${path} https://example.invalid`,
      path => `git diff --output=${path}`, path => `git show --output ${path}`,
      path => `ditto source.txt ${path}`, path => `scp source.txt ${path}`,
      path => `wget -O ${path} https://example.invalid`, path => `openssl dgst -out ${path} source.txt`,
      path => `sqlite3 ${path} 'select 1'`,
    ]) {
      assert.equal(shellWriteOutsideRoots({ command: form(`${root}/ledger.tsv`), cwd: f.dir, roots: [root] }), false);
      assert.equal(shellWriteOutsideRoots({ command: form("scratch.txt"), cwd: f.dir, roots: [root] }), true);
    }
  }
});

test("T44: value-taking options and alternate output spellings preserve the write boundary", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider), root = join(f.dir, "logbook"); mkdirSync(root);
    const { commandWrites, shellWriteOutsideRoots } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    for (const command of [
      `openssl dgst --out ${root}/ledger.tsv source.txt`,
      `openssl dgst -hmac -out --out ${root}/ledger.tsv source.txt`,
      `git diff --no-index --src-prefix '--' --output=${root}/ledger.tsv left.txt right.txt`,
      `git show --out=${root}/ledger.tsv`,
    ]) {
      assert.equal(commandWrites(command, f.dir), true, command);
      assert.equal(shellWriteOutsideRoots({ command, cwd: f.dir, roots: [root] }), false, command);
    }
    for (const command of ["openssl dgst -hmac -out source.txt", "openssl dgst -- --out", "openssl dgst out",
      "openssl dgst -hmac -x -- -out", "openssl dgst source.txt -out other.txt",
      "git diff --src-prefix -x -- --output=file",
      "git diff --src-prefix --output=file", "git diff --stat -- --output=file"])
      assert.equal(commandWrites(command, f.dir), false, command);
  }
});

function isolated(t, provider) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-provider-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plugin = join(dir, "plugin");
  cpSync(join(ROOT, provider === "claude" ? "plugins/sage" : "plugins/sage-codex"), plugin, { recursive: true });
  return { dir, plugin };
}

test("provider packages are complete outside the checkout, with no opposite adapter", async (t) => {
  for (const provider of ["claude", "codex"]) {
    const { dir, plugin } = isolated(t, provider);
    const paths = filesUnder(plugin);
    assert.ok(paths.some((p) => p.endsWith("core/index.mjs")));
    assert.ok(existsSync(join(plugin, "LICENSE-pstack")));
    assert.equal(existsSync(join(plugin, ".claude-plugin")), provider === "claude");
    assert.equal(existsSync(join(plugin, "agents")), provider === "claude");
    assert.equal(existsSync(join(plugin, "hooks/sage-hook.mjs")), provider === "claude");
    assert.equal(existsSync(join(plugin, "skills/sage/sage-pr.mjs")), provider === "claude");
    for (const file of paths.filter((p) => p.endsWith(".mjs"))) {
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, /from "sage-core"/);
      for (const [, specifier] of text.matchAll(/(?:from\s+|import\()"(\.[^"]+)"/g)) {
        const target = resolve(dirname(file), specifier);
        assert.ok(target.startsWith(`${plugin}/`), `${file}: ${specifier} escapes plugin`);
        assert.ok(existsSync(target), `${file}: missing ${specifier}`);
      }
    }
    const env = { ...process.env, SAGE_HOME: join(dir, "logbooks") };
    const run = (...args) => spawnSync(process.execPath, [join(plugin, "skills/sage/sage.mjs"), ...args, "--project", dir], { encoding: "utf8", env });
    assert.equal(run("init").status, 0);
    const task = run("task", "add", "--priority", "P2", "--title", "Shared behavior", "--size", "small");
    assert.equal(task.status, 0, task.stderr);
    assert.match(run("status").stdout, /tasks\s+1 · framed 1/);
    const board = run("board", "this");
    assert.equal(board.status, 0, board.stderr);
    assert.match(board.stdout, /Shared behavior/);
    const mod = await import(pathToFileURL(join(plugin, "skills/sage/sage.mjs")).href);
    const tool = provider === "codex" ? mod.tool : mod;
    assert.match(tool.sageRoot({}), new RegExp(`\\.${provider}/sage$`));
    const config = run("config");
    assert.equal(config.status, 0, config.stderr);
    assert.match(config.stdout, provider === "codex" ? /inherit,inherit,inherit/ : /opus,sonnet,sonnet/);
  }
});

test("T216: each plugin's board is a cross-provider reader: it imports only Node built-ins and the bundled core, and installs from the plugin", async (t) => {
  for (const provider of ["claude", "codex"]) {
    const { dir, plugin } = isolated(t, provider);
    const files = filesUnder(join(plugin, "board"));
    assert.deepEqual(files.map((file) => relative(join(plugin, "board"), file)).sort(), ["cli.mjs", "install.mjs", "server.mjs"]);
    const { parse } = await import("es-module-lexer/minimal");
    for (const file of files) {
      const [imports] = parse(readFileSync(file, "utf8"));
      for (const { n: name } of imports.filter((item) => item.d !== -2)) { // -2 is import.meta, not an import
        const allowed = name?.startsWith("node:") || name === "../core/index.mjs" || /^\.\/(?:cli|install|server)\.mjs$/.test(name ?? "");
        assert.ok(allowed, `${provider} ${relative(plugin, file)} imports ${name}`);
      }
    }
    // The install copies the plugin's board and core, so the stable copy runs without the checkout or the plugin.
    const env = { ...process.env, HOME: join(dir, "home") };
    delete env.SAGE_HOME; delete env.CODEX_HOME;
    const config = join(dir, "board.json"), installDir = join(dir, "stable");
    const run = (cli, ...args) => spawnSync(process.execPath, [cli, "board", ...args, "--config", config], { encoding: "utf8", env });
    assert.equal(run(join(plugin, "board/cli.mjs"), "--setup").status, 0);
    const installed = run(join(plugin, "board/cli.mjs"), "--install", "--install-dir", installDir);
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(installed.stdout, `Installed board command: ${join(installDir, "packages", "board", "cli.mjs")}\n`);
    rmSync(plugin, { recursive: true, force: true });
    const status = run(join(installDir, "packages", "board", "cli.mjs"), "all", "--status");
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /^Tasks: none recorded/);
  }
});

test("core instances isolate provider defaults and validation without changing process environment", (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-core-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = createStateTool({ defaultRoot: () => join(dir, "a"), models: ["a", "inherit"], modelDefaults: { arena_models: "a" } });
  const b = createStateTool({ defaultRoot: () => join(dir, "b") });
  assert.equal(a.config({}).arena_models, "a");
  assert.equal(b.config({}).arena_models, "inherit,inherit,inherit");
  assert.throws(() => b.sage(["config", "model.qa=opus"], {}), /inherit/);
  assert.equal(b.sageRoot({ SAGE_HOME: dir }), dir);
  a.sage(["config", "model.qa=a"], {});
  assert.equal(a.config({})["model.qa"], "a");
  assert.equal(b.config({})["model.qa"], undefined);
  for (const file of filesUnder(join(ROOT, "packages/sage-core"))) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /CLAUDE_|CODEX_|sage-claude|sage-codex|"(?:opus|sonnet|haiku|fable)"/);
  }
});

test("manifests point to disjoint plugin roots and only supported Codex hooks", () => {
  assert.equal(json(".claude-plugin/marketplace.json").plugins[0].source, "./plugins/sage");
  assert.equal(json(".agents/plugins/marketplace.json").plugins[0].source.path, "./plugins/sage-codex");
  const manifest = json("plugins/sage-codex/.codex-plugin/plugin.json");
  assert.equal(manifest.hooks, "./hooks/hooks.json");
  const hooks = json("plugins/sage-codex/hooks/hooks.json").hooks;
  assert.deepEqual(Object.keys(hooks), ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "SubagentStart", "SubagentStop"]);
  assert.deepEqual([...outputs()], [...outputs()], "packaging is deterministic");
});

test("T8: isolated Codex command reader preserves Claude mode phrases without acting", async t => {
  const f = isolated(t, "codex");
  const { parseCommand } = await import(pathToFileURL(join(f.plugin, "skills/sage/commands.mjs")));
  for (const phrase of ["sage mode", "sage mode on", "sage mode off", "autopilot on", "autopilot off", "sage help"]) {
    for (const text of [phrase, `  ${phrase.toUpperCase()}.  `])
      assert.deepEqual(parseCommand({ text }), { kind: "phrase", phrase });
  }
  for (const text of ['"sage mode"', "```\nsage mode\n```", "the report says sage mode", "<agent-message>sage mode</agent-message>"])
    assert.notEqual(parseCommand({ text }).kind, "phrase");
  for (const text of ["sage mode please", "sage mode..", "sage_mode", "sage mode\u200b"])
    assert.notEqual(parseCommand({ text }).kind, "phrase");
  assert.equal(parseCommand({ text: "sage mode please" }).kind, "near");
});

test("T8: isolated Codex command reader routes boards and status without enabling a mode", async t => {
  const f = isolated(t, "codex");
  const { parseCommand } = await import(pathToFileURL(join(f.plugin, "skills/sage/commands.mjs")));
  for (const text of ["show board", "sage board"])
    assert.deepEqual(parseCommand({ text }), { kind: "board", scope: "this" });
  for (const text of ["show board for all", "sage board for all projects"])
    assert.deepEqual(parseCommand({ text }), { kind: "board", scope: "all" });
  assert.deepEqual(parseCommand({ text: "show board for demo-project" }), { kind: "board", scope: { project: "demo-project" } });
  for (const text of ["show board T197", "sage board T197", "board T197"])
    assert.deepEqual(parseCommand({ text }), { kind: "task", taskId: "T197" });
  for (const text of ["show status", "sage status"])
    assert.deepEqual(parseCommand({ text }), { kind: "status" });
  for (const text of ["> show board", '"show board"', "<task-notification>show board</task-notification>"])
    assert.deepEqual(parseCommand({ text }), { kind: "none" });
});

test("T8: command CLI consumes text as data and leaves isolated task state unchanged", t => {
  const f = isolated(t, "codex");
  const script = join(f.plugin, "skills/sage/commands.mjs");
  const env = { ...process.env, SAGE_HOME: join(f.dir, "logbooks") };
  const cli = (...args) => execFileSync(process.execPath, [join(f.plugin, "skills/sage/sage.mjs"), ...args, "--project", f.dir], { env, encoding: "utf8" });
  cli("init");
  cli("task", "add", "--priority", "P2", "--title", "Preserve this task", "--size", "small");
  const snapshot = () => filesUnder(env.SAGE_HOME).map(path => [path, readFileSync(path, "utf8")]);
  const before = snapshot();
  const invoke = text => execFileSync(process.execPath, [script], { cwd: f.dir, env, input: JSON.stringify({ text }), encoding: "utf8" });
  assert.deepEqual(JSON.parse(invoke("sage mode")), { kind: "phrase", phrase: "sage mode" });
  assert.deepEqual(JSON.parse(invoke("$(touch SHOULD_NOT_EXIST); show board")), { kind: "none" });
  assert.equal(existsSync(join(f.dir, "SHOULD_NOT_EXIST")), false);
  assert.deepEqual(snapshot(), before);
});

test("T10: installed command CLI works through a filesystem alias", t => {
  const f = isolated(t, "codex");
  const alias = join(f.dir, "plugin-alias");
  symlinkSync(f.plugin, alias, "dir");
  const script = join(alias, "skills/sage/commands.mjs");
  const valid = spawnSync(process.execPath, [script], {
    input: JSON.stringify({ text: "sage mode" }), encoding: "utf8",
  });
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.stdout.trim(), '{"kind":"phrase","phrase":"sage mode"}');
  const invalid = spawnSync(process.execPath, [script], { input: "{", encoding: "utf8" });
  assert.notEqual(invalid.status, 0, "invalid input must not silently succeed through an alias");
  assert.equal(invalid.stdout, "");
});

test("T10: installed logbook CLI reads and writes through a filesystem alias", t => {
  const f = isolated(t, "codex");
  const alias = join(f.dir, "plugin-alias");
  symlinkSync(f.plugin, alias, "dir");
  const env = { ...process.env, SAGE_HOME: join(f.dir, "logbooks") };
  const script = join(alias, "skills/sage/sage.mjs");
  const cli = (...args) => execFileSync(process.execPath, [script, ...args, "--project", f.dir], { env, encoding: "utf8" });
  cli("init");
  assert.match(cli("task", "add", "--priority", "P2", "--title", "Alias task", "--size", "small"), /T1 framed/);
  assert.match(cli("board", "T1", "--view", "task"), /Alias task/);
  const url = pathToFileURL(join(f.plugin, "skills/sage/sage.mjs")).href;
  const imported = spawnSync(process.execPath, ["--input-type=module", "-"], {
    input: `import { tool } from ${JSON.stringify(url)}; console.log(typeof tool.runCli);`, env, encoding: "utf8",
  });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout.trim(), "function");
});

test("T10: command reader can be imported from a stdin program", t => {
  const f = isolated(t, "codex");
  const url = pathToFileURL(join(f.plugin, "skills/sage/commands.mjs")).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
    input: `import { parseCommand } from ${JSON.stringify(url)}; console.log(JSON.stringify(parseCommand({ text: "show status" })));`,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '{"kind":"status"}');
});

test("T8: command reader rejects malformed input rather than inventing a request", async t => {
  const f = isolated(t, "codex");
  const script = join(f.plugin, "skills/sage/commands.mjs");
  const { parseCommand } = await import(pathToFileURL(script));
  for (const input of [null, [], {}, { text: 1 }, { text: "sage mode", trusted: true }])
    assert.throws(() => parseCommand(input));
  for (const input of ["{", JSON.stringify({ text: 1 }), JSON.stringify({ text: "sage mode", trusted: true })]) {
    const result = spawnSync(process.execPath, [script], { input, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
  }
});

test("Codex patches give advice for every path and both ends of a move", () => {
  const patch = "*** Begin Patch\n*** Update File: src/a.js\n@@\n-a\n+b\n*** Update File: tests/b.test.js\n*** Move to: README.md\n@@\n-a\n+b\n*** Add File: docs/help.md\n+*** Delete File: fake.js\n*** End Patch";
  assert.deepEqual(patchPaths(patch), ["src/a.js", "tests/b.test.js", "README.md", "docs/help.md"]);
  const s = state();
  const event = { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: patch } };
  const advice = context(handle(event, s));
  assert.match(advice, /Test behaviour/);
  assert.match(advice, /reader/i);
  assert.match(advice, /README/);
  assert.equal(handle(event, s), undefined, "advice is given once per session");
  assert.deepEqual(patchPaths("not a patch"), []);
});

test("Codex process hooks isolate roots, children and providers; unknown input cannot block", (t) => {
  const { dir, plugin } = isolated(t, "codex");
  const env = { ...process.env, AGENT_KIT_HOOKS_STATE: dir };
  const send = (event, extra = {}) => spawnSync(process.execPath, [join(plugin, "hooks/principles-hook.mjs")], { env: { ...env, ...extra }, input: typeof event === "string" ? event : JSON.stringify(event), encoding: "utf8" });
  const prompt = { session_id: "session", hook_event_name: "UserPromptSubmit", prompt: "Design a schema" };
  const first = send(prompt);
  assert.equal(first.status, 0, first.stderr);
  assert.match(context(JSON.parse(first.stdout)), /Exhaust the design space/);
  assert.equal(send(prompt).stdout, "");
  assert.ok(send({ ...prompt, agent_id: "child" }).stdout);
  assert.notEqual(stateKey(prompt), stateKey({ ...prompt, agent_id: "child" }));
  assert.notEqual(stateKey({ session_id: "a/b" }), stateKey({ session_id: "a_b" }));
  assert.equal(send({ ...prompt, session_id: "off" }, { AGENT_KIT_HOOKS: "off" }).stdout, "");
  for (const input of ["not json", "null", {}, { ...prompt, session_id: undefined }, { ...prompt, hook_event_name: "Stop" }, { ...prompt, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: "Exit code: 0" }]) {
    const result = send(input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  }
  assert.equal(existsSync(join(dir, "session.json")), false, "Claude state is not written");
});

test("unknown check outcomes cannot erase recorded failures in shared policy", (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-outcome-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", dir]);
  writeFileSync(join(dir, "code.js"), "one");
  const s = state();
  const input = { kind: "after-tool", cwd: dir, command: "npm test", outcome: "failure" };
  applyPrinciples(input, s, (name) => name);
  assert.ok(s.failures["npm test"]);
  applyPrinciples({ ...input, outcome: "unknown" }, s, (name) => name);
  assert.ok(s.failures["npm test"]);
  applyPrinciples({ ...input, outcome: "success" }, s, (name) => name);
  assert.equal(s.failures["npm test"], undefined);
});

test("check rejects a foreign file and build removes it from an assembled plugin", (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-build-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(ROOT, dir, { recursive: true, filter: (path) => ![".git", "node_modules"].includes(relative(ROOT, path)) });
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  const foreign = join(dir, "plugins/sage/hooks/codex-only.mjs");
  writeFileSync(foreign, "throw new Error('foreign adapter');\n");
  const run = (name) => spawnSync(process.execPath, [join(dir, "scripts", `${name}.mjs`)], { encoding: "utf8" });
  const rejected = run("check");
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /codex-only.mjs: not in the package/);
  const built = run("build");
  assert.equal(built.status, 0, built.stderr);
  assert.equal(existsSync(foreign), false);
  const checked = run("check");
  assert.equal(checked.status, 0, checked.stderr);
});

test("a mismatched core pin fails the build before replacing plugin files", (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-pin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(ROOT, dir, { recursive: true, filter: (path) => ![".git", "node_modules"].includes(relative(ROOT, path)) });
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  const manifest = join(dir, "packages/sage-codex/package.json");
  const meta = JSON.parse(readFileSync(manifest, "utf8"));
  meta.dependencies["sage-core"] = "999.0.0";
  writeFileSync(manifest, JSON.stringify(meta));
  const output = join(dir, "plugins/sage-codex/core/index.mjs");
  const before = readFileSync(output, "utf8");
  const result = spawnSync(process.execPath, [join(dir, "scripts/build.mjs")], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /sage-codex must pin sage-core 0.1.0/);
  assert.equal(readFileSync(output, "utf8"), before);
});

test("check rejects a hook change made only in the generated Claude plugin", (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-stale-hook-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(ROOT, dir, { recursive: true, filter: (path) => ![".git", "node_modules"].includes(relative(ROOT, path)) });
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  const hook = join(dir, "plugins/sage/hooks/sage-hook.mjs");
  writeFileSync(hook, `${readFileSync(hook, "utf8")}\n// A change in the old source path.\n`);
  const checked = spawnSync(process.execPath, [join(dir, "scripts/check.mjs")], { encoding: "utf8" });
  assert.equal(checked.status, 1);
  assert.match(checked.stderr, /plugins\/sage\/hooks\/sage-hook\.mjs: out of date/);
  const built = spawnSync(process.execPath, [join(dir, "scripts/build.mjs")], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  const current = spawnSync(process.execPath, [join(dir, "scripts/check.mjs")], { encoding: "utf8" });
  assert.equal(current.status, 0, current.stderr);
});

test("shared command extraction parses executable text in both isolated bundles", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    assert.equal(typeof api.shellCommands, "function");
    assert.equal(typeof api.programsRun, "function");
    const command = "echo fixture | sh";
    const parsed = api.shellCommands(command);
    assert.deepEqual(parsed.map(c => c.words), [["echo", "fixture"], ["sh"]]);
    assert.equal(parsed[0].pipeTo, parsed[1]);
    const runs = api.programsRun(command, f.dir, "");
    assert.deepEqual(runs.map(({ word, stdin, piped }) => ({ word, stdin, piped })), [
      { word: "echo", stdin: [], piped: false }, { word: "sh", stdin: ["echo fixture"], piped: true },
    ]);
    assert.throws(() => api.shellCommands("echo 'open"), /open quote/);
    if (provider === "claude") {
      const hook = await import(pathToFileURL(join(f.plugin, "hooks/sage-hook.mjs")));
      assert.deepEqual(hook.shellCommands(command), parsed);
      assert.deepEqual(hook.programsRun(command, f.dir, ""), runs);
    }
  }
});

test("shared command extraction preserves T199 and harmless arguments in both isolated bundles", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    assert.equal(typeof api.createCommandPolicy, "function");
    const tool = join(f.plugin, "skills/sage/sage.mjs");
    const policy = api.createCommandPolicy({ stateToolPath: tool });
    for (const command of ["g{h,h} pr view 1", "git pu{s,s}h origin topic", "gh pr {m,m}erge 1",
      "printf 'gh pr {m,m}erge 1' | cat | sh"]) {
      assert.match(policy.expansionProblem(command, f.dir), /shell expansion can hide the command/);
    }
    for (const command of ["echo '{sample}'", "git add '*.mjs'", "gh pr view 1", "[ -f '*.txt' ]", "[[ -f '*.txt' ]]"]) {
      assert.equal(policy.expansionProblem(command, f.dir), undefined, command);
    }
    const rows = policy.runnable(api.shellCommands(`node '${tool}' log --why 'gh pr merge'; git push origin topic`));
    assert.deepEqual(rows.map(r => r.words), [["node", tool], ["git", "push", "origin", "topic"]]);
  }
});

test("shared merge and push extraction classifies merges in both isolated bundles", async t => {
  const sha = "a".repeat(40);
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    const tool = join(f.plugin, "skills/sage/sage.mjs");
    const policy = api.createCommandPolicy({ stateToolPath: tool });
    const candidate = `gh pr merge 12 --squash --delete-branch --match-head-commit ${sha}`;
    assert.deepEqual(policy.mergeIn(candidate), { pr: "12", sha });
    for (const text of [candidate.replace(" 12 ", " 012 "), candidate.replace(sha, "abc"), `${candidate} --admin`,
      `sh -c '${candidate}'`, `echo '${candidate}' | sh`, `echo '${candidate}' > run; sh run`,
      "gh api repos/o/r/pulls/12/merge", "gh pr 'merge", "$(echo gh) pr merge 12"]) {
      assert.equal(typeof policy.mergeIn(text)?.problem, "string", text);
    }
    for (const text of ["git status", "git merge topic", `echo '${candidate}'`, `echo '${candidate}' | head -1`,
      `node '${tool}' log --why '${candidate}'`]) assert.equal(policy.mergeIn(text), undefined, text);
    assert.match(policy.mergeIn(`node '/other/sage.mjs' log --why '${candidate}'`).problem, /cannot prove/);
    assert.equal(api.mentionsMerge("gh api graphql -f query=mergePullRequest"), true);
    assert.equal(api.mentionsMerge("git merge topic"), false);
    assert.equal(api.PR.test("12"), true);
    assert.equal(api.PR.test("012"), false);
    if (provider === "claude") {
      const adapter = await import(pathToFileURL(join(f.plugin, "hooks/command-policy.mjs")));
      assert.deepEqual(adapter.createCommandPolicy({ stateToolPath: tool }).mergeIn(candidate), { pr: "12", sha });
      const hook = await import(pathToFileURL(join(f.plugin, "hooks/sage-hook.mjs")));
      assert.deepEqual(hook.mergeIn(candidate), { pr: "12", sha });
    }
  }
});

test("shared merge and push extraction applies push rules and injected branch evidence in both isolated bundles", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    const tool = join(f.plugin, "skills/sage/sage.mjs");
    const policy = api.createPushPolicy({ stateToolPath: tool, readGh: fakeGh, readGit: fakeGit(dir => dir === join(f.dir, "project/nested") ? "main" : "topic") });
    for (const text of ["git push origin topic", "git push -u --follow-tags origin topic", "git push --delete origin topic",
      "echo 'git push origin main'", "git status", `node '${tool}' log --why 'git push origin main'`]) {
      assert.equal(policy.pushProblem(text, f.dir), undefined, text);
    }
    for (const text of ["git push origin main", "git push origin refs/heads/master", "git push origin topic:main",
      "git push -f origin topic", "git push --force-with-lease origin topic", "git push --forc origin topic",
      "git push --mirror origin", "git push origin HEAD", "git push origin", "git push upstream topic",
      "git push origin '$BRANCH'", "sudo git push origin topic", "sh -c 'git push origin topic'",
      "echo 'git push origin main' | sh", "git push 'origin", "gh api repos/o/r/git/refs -f ref=refs/heads/main",
      "node /other/sage.mjs log --why 'git push origin main'"]) {
      assert.equal(typeof policy.pushProblem(text, f.dir), "string", text);
    }
    assert.match(policy.pushProblem("cd project; git -C nested push origin topic", f.dir), /checkout is on main/);
    assert.equal(policy.pushProblem("cd project; git -C nested push --delete origin topic", f.dir), undefined);
    assert.match(api.createPushPolicy({ readGh: fakeGh, readGit: fakeGit("topic"), mainReason: "Use a reviewed pull request." }).pushProblem("git push origin main", f.dir), /^Use a reviewed pull request\./);
    assert.equal(api.createPushPolicy({ readGh: fakeGh, readGit: fakeGit(undefined) }).pushProblem("git push origin topic", f.dir), undefined);
    if (provider === "claude") {
      const adapter = await import(pathToFileURL(join(f.plugin, "hooks/command-policy.mjs")));
      assert.match(adapter.createPushPolicy({ readGh: fakeGh, readGit: fakeGit("main") }).pushProblem("git push origin topic", f.dir), /checkout is on main/);
    }
  }
});

test("T42: shared push policy recognizes executable spelling in both bundles", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    const policy = api.createPushPolicy({ readGh: fakeGh, readGit: fakeGit("Topic") });
    for (const executable of ["GIT", "Git", "git.exe", "GIT.EXE", "/usr/bin/Git", "'C:\\Tools\\Git.EXE'"]) {
      assert.match(policy.pushProblem(`${executable} push origin main`, f.dir), /work reaches main only through a pull request/, executable);
      assert.match(policy.pushProblem(`${executable} push --force origin Topic`, f.dir), /never force-pushes/, executable);
      assert.equal(policy.pushProblem(`${executable} push origin Topic`, f.dir), undefined, executable);
      assert.equal(policy.pushProblem(`${executable} status`, f.dir), undefined, executable);
    }
    assert.equal(policy.pushProblem("echo 'GIT push origin main'", f.dir), undefined);
    assert.match(api.createPushPolicy({ readGh: fakeGh, readGit: fakeGit("main") }).pushProblem("GIT -C nested push origin Topic", f.dir), /checkout is on main/);
    for (const executable of ["GH", "Gh.exe", "/usr/bin/GH", "'C:\\Tools\\GH.EXE'"]) {
      assert.match(policy.pushProblem(`${executable} api repos/o/r/git/refs/heads/main -X PATCH -f sha=abc`, f.dir), /work reaches main only through a pull request/);
      assert.equal(policy.pushProblem(`${executable} api repos/o/r/git/refs/heads/main`, f.dir), undefined);
    }
    if (provider === "claude") {
      const hook = await import(pathToFileURL(join(f.plugin, "hooks/sage-hook.mjs")));
      for (const command of ["GIT push origin main", "Git.exe push --force origin Topic"]) {
        const result = hook.handle({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: f.dir,
          tool_input: { command } }, { sage: true }, { touch() {} });
        assert.equal(result?.hookSpecificOutput?.permissionDecision, "deny", command);
      }
    }
  }
});

test("T42: shared expansion rules recognize executable spelling without changing arguments or merge form", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    const policy = api.createCommandPolicy();
    for (const executable of ["GIT", "Git.exe", "/usr/bin/GIT", "'C:\\Tools\\Git.EXE'"]) {
      assert.match(policy.expansionProblem(`${executable} p* origin main`, f.dir), /shell expansion can hide the command/, executable);
      assert.equal(policy.expansionProblem(`${executable} status 'Topic*'`, f.dir), undefined, executable);
    }
    for (const executable of ["GH", "Gh.exe", "/usr/bin/GH", "'C:\\Tools\\GH.EXE'"]) {
      assert.match(policy.expansionProblem(`${executable} pr m*`, f.dir), /shell expansion can hide the command/, executable);
      assert.match(policy.expansionProblem(`${executable} p? merge`, f.dir), /shell expansion can hide the command/, executable);
      assert.equal(policy.expansionProblem(`${executable} pr view 'Topic*'`, f.dir), undefined, executable);
      assert.equal(policy.expansionProblem(`${executable} api 'repos/{owner}/{repo}/issues'`, f.dir), undefined, executable);
      assert.match(policy.mergeIn(`${executable} pr merge 12 --squash --delete-branch --match-head-commit ${"a".repeat(40)}`)?.problem, /cannot prove/, executable);
    }
    assert.deepEqual(policy.mergeIn(`gh pr merge 12 --squash --delete-branch --match-head-commit ${"a".repeat(40)}`), { pr: "12", sha: "a".repeat(40) });
  }
});

test("T41: shared push policy refuses GitHub API writes to protected branches in both bundles", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    const policy = api.createPushPolicy({ readGh: fakeGh, readGit: fakeGit("topic") });
    for (const command of [
      "gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc -F force=true",
      "gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc\nprintf 'unfinished",
      "GH_REPO=o/contents gh api 'repos/victim/repo/{repo}/file' -X PUT -f content=abc",
      "GH_REPO=o/merges gh api 'repos/victim/repo/:repo' -f base=main -f head=topic",
      `gh api 'graphql#fragment' -f 'query=mutation { updateRef(input: {refId: "id", oid: "abc"}) { clientMutationId } }'`,
      "gh api 'repos/o/r/merge-upstream#fragment' -f branch=main",
      "gh api 'repos/o/r/branches/main/rename#fragment' -f new_name=topic",
      "gh api 'repos/o/r/{branch}' -X PATCH -f sha=abc",
      "gh api 'repos/o/r/:branch' -X PATCH -f sha=abc",
      "gh api repos/o/r/{git/refs/heads/main,issues} -X PATCH -f sha=abc",
      `gh api graphql -F 'query=mutation { createCommitOnBranch(input: {branch: {branchName: ":branch"}}) { clientMutationId } }'`,
      "gh api -iX PATCH repos/o/r/git/refs/heads/main -f sha=abc",
      "gh api repos/o/r/contents/file -ifbranch=main -f content=abc",
      "env -u UNUSED gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc",
      "command -- gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc",
      "gh -X PATCH api repos/o/r/git/refs/heads/main -f sha=abc",
      "gh api -X PATCH https://enterprise.example/api/v3/repos/o/r/git/refs/heads/main -f sha=abc",
      "gh api -X PATCH repositories/123/git/refs/heads/main -f sha=abc",
      "gh api repos/o/r/merge-upstream -f branch=main",
      "gh api repos/o/r/merges -f 'base[=main' -f head=topic",
      `gh api graphql -f 'query[=mutation { updateRef(input:{refId:"id",oid:"abc"}){clientMutationId}}'`,
      "gh api repos/o/r/pulls/1/update-branch -X PUT",
      "gh api graphql -f 'query=mutation { updatePullRequestBranch(input: {pullRequestId: \"opaque-id\"}) { clientMutationId } }'",
      "gh api graphql -f 'query=mutation { createLinkedBranch(input: {issueId: \"opaque-id\", name: \"main\"}) { clientMutationId } }'",
      "gh api https://enterprise.example/api/graphql -f 'query=mutation { updateRef(input: {refId: \"id\", oid: \"abc\"}) { clientMutationId } }'",
      "gh api graphql -F 'query=mutation { createCommitOnBranch(input: {branch: {branchName: \"{branch}\"}}) { clientMutationId } }'",
      "gh api repos/o/r/git/refs/heads/master --method=PATCH -f sha=abc",
      "gh api -XPUT repos/o/r/contents/file -f branch=main -f content=abc",
      "gh api repos/o/r/contents/file --method PUT --raw-field=branch=master",
      "gh api repos/o/r/git/refs -f ref=refs/heads/main -f sha=abc",
      "gh api graphql -f 'query=mutation { updateRefs(input: {repositoryId: \"id\", refUpdates: []}) { clientMutationId } }'",
      "gh api graphql -f 'query=mutation { updateRef(input: {refId: \"id\", oid: \"abc\"}) { clientMutationId } }'",
      "gh api graphql -f 'query=mutation { updateRef # comment\n (input: {refId: \"id\", oid: \"abc\"}) { clientMutationId } }'",
      "gh api graphql -f 'query=mutation { updateRef,(input: {refId: \"id\", oid: \"abc\"}) { clientMutationId } }'",
      "gh api graphql -f 'query=mutation { createCommitOnBranch # comment\n (input: {branch: {branchName: \"main\"}}) { clientMutationId } }'",
      "gh api graphql -f 'query=mutation { createCommitOnBranch(input: {branch: {branchName: \"main\"}}) { clientMutationId } }'",
      "gh api graphql -f 'query=mutation { createCommitOnBranch(input: {branch: {id: \"opaque-ref-id\"}}) { clientMutationId } }'",
      "gh api repos/o/r/contents/file --input body.json",
      "gh api repos/o/r/contents/file -f content=abc",
      "gh api repos/o/r/contents/file -F branch=@branch.txt -f content=abc",
      "gh api graphql --input body.json",
      "gh api graphql -F query=@query.graphql",
      'gh api graphql -f "query=$QUERY"',
      'gh api "https://$DEST" -X PATCH -f sha=abc',
      'gh api "https://{branch}" -X PATCH -f sha=abc',
      'gh api "https://{branch}@github.com" -X PUT -f content=abc',
      "gh api 'https://api.github.com/{branch}/../repos/o/r/issues' -X PATCH -f sha=abc",
      'gh api "$ENDPOINT" -X PATCH -f sha=abc',
      'gh api "repos/o/r/$RESOURCE/heads/main" -X PATCH -f sha=abc',
      "gh api --method DELETE repos/o/r/git/refs/heads/main",
      "gh api -X PATCH https://api.github.com/repos/o/r/git/refs/heads/%6dain -f sha=abc",
      'gh api repos/o/r/contents/file -X PUT -f branch="$BRANCH"',
      'gh api -X PATCH repos/o/r/git/refs/heads/$BRANCH -f sha=abc',
      "gh api -X PATCH repos/o/r/git/refs/heads/ma?n -f sha=abc",
      "gh api -X DELETE repos/o/r/git/refs/heads/maste?",
      "gh api -X PUT 'repos/o/r/contents/file?branch=main' -f branch=topic",
      String.raw`gh api graphql -f 'query=mutation { createCommitOnBranch(input: {branch: {branchName: "\u006dain"}}) { clientMutationId } }'`,
    ]) assert.match(policy.pushProblem(command, f.dir), /work reaches main only through a pull request|the hook cannot prove that this command is only the merge command|the hook cannot establish the GitHub API command's destination/, `${provider}: ${command}`);
    for (const command of [
      "gh api 'https://api.github.com/repos/{owner}/{repo}/git/refs/heads/topic' -X PATCH -f sha=abc",
      "gh api 'repos/{owner}/{repo}/git/refs/heads/topic' -X PATCH -f sha=abc",
      "gh api 'repos/:owner/:repo/git/refs/heads/topic' -X PATCH -f sha=abc",
      "gh api 'repos/o/r/{branch}' -X GET",
      `gh api graphql -f 'query=mutation { createCommitOnBranch(input: {branch: {repositoryNameWithOwner: "o/r", branchName: ":branch"}}) { clientMutationId } }'`,
      "gh api repos/o/r/git/refs/heads/main",
      "gh api repos/o/r/contents/file -X GET -f ref=main",
      "gh api --method=GET repos/o/r/contents/file -f ref=master",
      "gh api -XGET repos/o/r/git/refs -f ref=refs/heads/main",
      "gh api -iX GET repos/o/r/git/refs/heads/main",
      "gh api repos/o/r/contents/file -X PUT -f branch=topic",
      "gh api graphql -f 'query=query { repository(owner: \"o\", name: \"r\") { ref(qualifiedName: \"refs/heads/main\") { id } } }'",
      "gh api repos/o/r/issues -f title=main",
      "gh api repos/o/r/pulls -f base=main -f head=topic -f title=change",
      "gh api repos/o/r/pulls/1 -X PATCH -f base=main",
      "env -u UNUSED gh api repos/o/r/contents/file -X GET -f ref=main",
      "gh -X GET api repos/o/r/git/refs/heads/main",
      "gh api -X PATCH repositories/123/git/refs/heads/topic -f sha=abc",
      "gh api graphql -f 'query=mutation { createIssue(input: {title: \"main\", body: \"updateRef(\"}) { clientMutationId } }'",
      "gh api graphql -f 'query=mutation { createCommitOnBranch(input: {branch: {repositoryNameWithOwner: \"o/r\", branchName: \"topic\"}}) { clientMutationId } }'",
      "gh api repos/o/r/issues --input body.json",
      "gh api repos/o/r/git/refs/heads/topic -X PATCH -f sha=abc --template main",
      "gh api repos/o/r/contents/main -X PUT -f branch=topic -f content=abc",
      "gh api 'repos/o/r/contents/file?ref=main'",
    ]) assert.equal(policy.pushProblem(command, f.dir), undefined, `${provider}: ${command}`);
    if (provider === "claude") {
      const hook = await import(pathToFileURL(join(f.plugin, "hooks/sage-hook.mjs")));
      for (const actor of [{}, { agent_id: "fixture-child", agent_type: "sage:implementer" }]) {
        for (const command of [
          "gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc -F force=true",
          "gh api -X PUT repos/o/r/contents/file -f branch=main -f content=abc",
          "gh api graphql -f 'query=mutation { updateRefs(input: {repositoryId: \"id\", refUpdates: []}) { clientMutationId } }'",
        ]) {
          const result = hook.handle({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: f.dir,
            tool_input: { command }, ...actor }, { sage: true }, { touch() {} });
          assert.equal(result?.hookSpecificOutput?.permissionDecision, "deny", command);
          if (!actor.agent_id) assert.match(result.hookSpecificOutput.permissionDecisionReason, /work reaches main only through a pull request/);
        }
      }
    }
  }
});

test("T536 R2003-1, R2002-1: the push rule follows only a plain cd, binds createCommitOnBranch to its repository, reads routes with extra slashes, and reads commit and search text as text", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    // The checkout "bad" sends topic to main by its settings; f.dir is a clean checkout. other/repo's default branch is trunk.
    const bad = join(f.dir, "bad");
    const clean = fakeGit("topic");
    const readGit = (dir, args) => args[0] === "config" && dir === bad ? `${clean(dir, args)}remote.origin.push\nrefs/heads/topic:refs/heads/main\0` : clean(dir, args);
    const readGh = (args) => (args.at(-1) === ".default_branch" ? (args[3] === "repos/other/repo" ? "trunk\n" : "main\n") : undefined);
    const policy = api.createPushPolicy({ readGh, readGit });
    const says = (command, cwd = f.dir) => policy.pushProblem(command, cwd) ?? "allowed";
    // 1a: a cd that the hook cannot follow beside a push, in the checkout where the push really runs.
    for (const [command, cwd] of [[`cd -P ${bad} && git push origin topic`], [`cd -L ${bad} && git push origin topic`], [`cd -- ${bad} && git push origin topic`],
      ["cd && git push origin topic"], [`(cd ${f.dir}) && git push origin topic`, bad], [`true || cd ${f.dir}; git push origin topic`, bad],
      [`cd ${f.dir} & git push origin topic`, bad]]) {
      // Refused for the cd beside the push, or for the settings of the checkout where the push really runs.
      assert.match(says(command, cwd), /runs in the same command line as the push|git's setting remote\.origin\.push/, `${provider}: ${command}`);
    }
    assert.match(says(`cd ${bad} && git push origin topic`), /git's setting remote\.origin\.push can send the branch/, "a plain cd moves the read");
    assert.equal(says(`cd ${f.dir} && git push origin topic`, bad), "allowed", "a plain cd to a clean checkout passes");
    // 1b: createCommitOnBranch is checked against the default branch of the repository it names, not the checkout's.
    const commit = (repo, branch) => `gh api graphql -f 'query=mutation { createCommitOnBranch(input: {branch: {repositoryNameWithOwner: "${repo}", branchName: "${branch}"}, expectedHeadOid: "abc", message: {headline: "x"}}) { clientMutationId } }'`;
    for (const command of [commit("other/repo", "trunk"), commit("other/repo", "main"), commit("../x", "topic"),
      `gh api graphql -f 'query=mutation { createCommitOnBranch(input: {branch: {branchName: "topic"}}) { clientMutationId } }'`]) {
      assert.match(says(command), /work reaches main only through a pull request/, `${provider}: ${command}`);
    }
    assert.equal(says(commit("other/repo", "topic")), "allowed");
    // 1c: a doubled or trailing slash does not skip the route checks.
    for (const command of ["gh api -X PUT repos/o/r//contents/file -f content=abc", "gh api -X PATCH repos/o/r/ -f default_branch=topic",
      "gh api -X PATCH repos/o/r//git/refs/heads/main -f sha=abc", "gh api -X PATCH https://api.github.com/repos/o/r//git//refs/heads/main -f sha=abc",
      `gh api graphql/ -f 'query=mutation { updateRef(input: {refId: "id", oid: "abc"}) { clientMutationId } }'`]) {
      assert.match(says(command), /work reaches main only through a pull request/, `${provider}: ${command}`);
    }
    assert.equal(says("gh api repos/o/r//issues -f title=x"), "allowed");
    // 2: a commit message or a search pattern is text, also after git -C; a setting that runs still refuses.
    for (const command of [`git -C ${f.dir} commit -m "refuse git config core.hooksPath /tmp/h"`, `git grep -n "git config core.hooksPath /tmp/h"`,
      `rg "git config core.fsmonitor /tmp/h" docs`, `git -C ${f.dir} commit -m "explain the git push rule"`]) {
      assert.equal(says(command), "allowed", `${provider}: ${command}`);
    }
    for (const command of [`git -C ${f.dir} -c core.hooksPath=/tmp/h commit -m x`, `git grep -O"sh -c 'git config core.hooksPath /tmp/h'" x`,
      `rg --pre "sh -c 'git config core.hooksPath /tmp/h'" x`, `sh -c "git config core.hooksPath /tmp/h"`]) {
      assert.match(says(command), /sets core\.hooksPath or core\.fsmonitor/, `${provider}: ${command}`);
    }
  }
});

test("shared merge and push extraction keeps transitive module failures closed and broken-state merge diagnostics", async t => {
  for (const missing of ["core/push-policy.mjs", "core/pull-request.mjs"]) {
    const f = isolated(t, "claude");
    rmSync(join(f.plugin, missing), { force: true });
    const hook = await import(pathToFileURL(join(f.plugin, "hooks/sage-hook.mjs")));
    for (const sage of [false, true]) for (const tool_name of ["Bash", "Monitor", "PowerShell", "mcp__terminal__run"]) {
      for (const actor of [{}, { agent_id: "fixture-child" }]) {
        const output = hook.handle({ hook_event_name: "PreToolUse", tool_name,
          tool_input: { command: "gh api repos/o/r/git/refs -f ref=refs/heads/main" }, ...actor }, { sage }, {});
        assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny", `${missing}: ${tool_name}`);
        assert.match(output.hookSpecificOutput.permissionDecisionReason, /command modules could not load/);
      }
    }
  }
  const f = isolated(t, "claude");
  writeFileSync(join(f.plugin, "skills/sage/sage.mjs"), 'throw new Error("fixture broken state tool");\n');
  const hook = await import(pathToFileURL(join(f.plugin, "hooks/sage-hook.mjs")));
  const sha = "a".repeat(40);
  const candidate = `gh pr merge 012 --squash --delete-branch --match-head-commit ${sha}`;
  assert.deepEqual(hook.mergeIn(candidate), { pr: "012", sha }, "a broken state tool preserves the old diagnostic order");
  const output = hook.handle({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: candidate } }, { sage: true, autopilot: true }, {});
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /the merge check refuses: it could not run \(fixture broken state tool\)/);
});

test("shared file and mode extraction applies the chief edit rule in both isolated bundles", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    assert.equal(api.chiefEditDenied({ sage: true, chief: true }), true);
    for (const context of [{ sage: true, chief: false }, { sage: false, chief: true }, { sage: false, chief: false }]) {
      assert.equal(api.chiefEditDenied(context), false);
    }
    for (const context of [{}, { sage: true }, { sage: "on", chief: true }]) assert.throws(() => api.chiefEditDenied(context), /Invalid edit policy context/);
    if (provider === "claude") {
      const adapter = await import(pathToFileURL(join(f.plugin, "hooks/file-policy.mjs")));
      assert.equal(adapter.chiefEditDenied({ sage: true, chief: true }), true);
      assert.equal(adapter.chiefEditDenied({ sage: true, chief: false }), false);
      const hooks = join(f.dir, "hook-state");
      mkdirSync(hooks);
      for (const sage of [true, 1, "on", false, 0, ""]) for (const tool_name of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
        writeFileSync(join(hooks, "fixture.json"), JSON.stringify({ sage }));
        const result = spawnSync(process.execPath, [join(f.plugin, "hooks/sage-hook.mjs")], {
          input: JSON.stringify({ session_id: "fixture", hook_event_name: "PreToolUse", tool_name, cwd: f.dir,
            tool_input: { file_path: join(f.dir, "sample.txt"), notebook_path: join(f.dir, "sample.ipynb") } }),
          encoding: "utf8", env: { ...process.env, SAGE_HOOKS_STATE: hooks, SAGE_HOME: join(f.dir, "logbooks") },
        });
        assert.equal(result.status, 0, result.stderr);
        const output = JSON.parse(result.stdout || "{}");
        assert.equal(output.hookSpecificOutput?.permissionDecision, sage ? "deny" : undefined, `${tool_name}: persisted sage=${JSON.stringify(sage)}`);
      }
    }
  }
});

test("shared mode phrases match only a whole message, the same in both isolated bundles (T240)", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    const cases = [
      // [the message, the exact phrase or null, the phrases that a near miss asks for]
      ["sage mode", "sage mode", []],
      [" Sage Mode On. ", "sage mode on", []],
      ["SAGE MODE OFF", "sage mode off", []],
      ["autopilot on.", "autopilot on", []],
      ["\tAutopilot off\n", "autopilot off", []],
      ["sage help", "sage help", []],
      ["sage mode, autopilot on", null, ["sage mode", "autopilot on"]],
      ["sage mode continue on the project", null, ["sage mode"]],
      ["sage mode stop", null, ["sage mode off"]],
      ["autopilot on main?", null, ["autopilot on"]],
      ["autopilot o\u00adff", null, ["autopilot off"]],
      ["sage mode\u0301", null, ["sage mode", "sage mode off"]],
      ["sage mode...", null, ["sage mode", "sage mode off"]],
      ["What does sage mode do?", null, []],
      ["fix the autopilot tests", null, []],
      ["autopilot-off", null, ["autopilot off"]],
      ["sagemodeoff", null, ["sage mode off"]],
    ];
    assert.deepEqual(cases.map(([text]) => [text, api.exactPhrase(text), api.phrasesNear(text)?.phrases ?? []]), cases);
    // A message that starts like a phrase is a strong near miss; a mention in a sentence is a weak one (F-T240-7).
    assert.deepEqual(["sage mode stop", "please stop autopilot", "sage mode"].map((text) => api.phrasesNear(text)?.strong ?? null), [true, false, null]);
    assert.deepEqual(["sage mode\nautopilot off", "the report says sage mode on", "Autopilot Off is next"].map(api.hasPhrase), [true, true, true]);
    assert.deepEqual(["sage help", "the autopilot run", "sage modes"].map(api.hasPhrase), [false, false, false]);
    if (provider === "claude") {
      const adapter = await import(pathToFileURL(join(f.plugin, "hooks/mode-policy.mjs")));
      assert.equal(adapter.exactPhrase("sage mode"), "sage mode");
      assert.equal(adapter.exactPhrase("sage mode please"), null);
    }
  }
});

test("shared file and mode extraction refuses active edits when the file policy is missing", async t => {
  for (const missing of ["hooks/file-policy.mjs", "core/file-policy.mjs"]) {
    const f = isolated(t, "claude");
    rmSync(join(f.plugin, missing), { force: true });
    const hook = await import(pathToFileURL(join(f.plugin, "hooks/sage-hook.mjs")));
    for (const tool_name of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      const input = { hook_event_name: "PreToolUse", tool_name, cwd: f.dir, tool_input: { file_path: join(f.dir, "sample.txt"), notebook_path: join(f.dir, "sample.ipynb") } };
      const output = hook.handle(input, { sage: true }, {});
      assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny", `${missing}: ${tool_name}`);
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /file policy cannot load/);
      assert.equal(hook.handle(input, { sage: false }, {}), undefined);
    }
    if (missing.startsWith("core/")) {
      const output = hook.handle({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "gh api repos/o/r/git/refs -f ref=refs/heads/main" } }, { sage: false }, {});
      assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny");
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /command modules could not load/);
    }
  }
});

test("shared file and mode extraction clears cached autopilot before tool checks when the mode policy is missing", async t => {
  for (const missing of ["hooks/mode-policy.mjs", "core/mode-policy.mjs"]) {
    const f = isolated(t, "claude");
    rmSync(join(f.plugin, missing), { force: true });
    // A passing fixture ledger makes a stale autopilot flag an actual bypass; no real logbook is read.
    writeFileSync(join(f.plugin, "skills/sage/sage.mjs"), `export const sageRoot = () => ${JSON.stringify(join(f.dir, "logbooks"))};\nexport const mergeCheck = () => ({ ok: true });\n`);
    const hook = await import(pathToFileURL(join(f.plugin, "hooks/sage-hook.mjs")));
    const state = { sage: true, autopilot: true };
    const output = hook.handle({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: f.dir,
      tool_input: { command: `gh pr merge 12 --squash --delete-branch --match-head-commit ${"a".repeat(40)}` } }, state, {});
    assert.equal(state.autopilot, false, missing);
    assert.equal(state.sage, true, "the existing Sage restrictions stay active");
    assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny");
    assert.match(output.hookSpecificOutput.permissionDecisionReason, missing.startsWith("core/") ? /command modules could not load/ : /autopilot is off/);
    for (const sage of [false, true]) {
      const state = { sage, given: true, autopilot: true };
      const output = hook.handle({ hook_event_name: "UserPromptSubmit", prompt: "sage mode", cwd: f.dir }, state, {});
      assert.equal(state.sage, sage, "missing policy cannot start Sage mode");
      assert.equal(state.autopilot, false);
      assert.match(context(output), /mode policy cannot load/);
    }
  }
});

const assignmentScope = { project: "project-a", session: "root-session", epoch: "11111111-1111-4111-8111-111111111111" };
const assignmentDispatch = { task: "T1", run: "R1", issuer: "root-session", call: "spawn-1" };
const assignmentId = "22222222-2222-4222-8222-222222222222";
const assignmentCase = () => ({
  scope: { ...assignmentScope },
  assignment: { ...assignmentScope, id: assignmentId, ...assignmentDispatch },
  binding: { ...assignmentScope, assignment: assignmentId, issuer: "root-session", call: "spawn-1", child: "child-a" },
  native: { session: "root-session", child: "child-a", turn: "turn-a" },
  reference: { assignment: assignmentId, task: "T1", run: "R1" },
});
const assignmentApi = () => import("../packages/sage-core/index.mjs");

test("assignment intents use fresh IDs and retain project, epoch and dispatch identity", async () => {
  const { createAssignment } = await assignmentApi();
  const first = createAssignment(assignmentScope, assignmentDispatch);
  const second = createAssignment(assignmentScope, assignmentDispatch);
  assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  assert.notEqual(first.id, second.id);
  assert.deepEqual({ ...first, id: assignmentId }, { ...assignmentScope, id: assignmentId, ...assignmentDispatch });
  assert.deepEqual(assignmentScope, { project: "project-a", session: "root-session", epoch: "11111111-1111-4111-8111-111111111111" });
});

test("report correlation returns only an exact nonterminal identity receipt", async () => {
  const { correlateReport } = await assignmentApi();
  const input = assignmentCase();
  const expected = { schema: 1, kind: "report-submission", ...assignmentScope, assignment: assignmentId,
    task: "T1", run: "R1", issuer: "root-session", call: "spawn-1", child: "child-a", turn: "turn-a" };
  assert.deepEqual(correlateReport(input), expected);
  assert.deepEqual(correlateReport(structuredClone(input)), expected);
  assert.deepEqual(input, assignmentCase());
});

test("equal task and run IDs cannot cross a project, session or restart epoch", async () => {
  const { correlateReport } = await assignmentApi();
  for (const [key, value] of Object.entries({ project: "project-b", session: "other-root", epoch: "33333333-3333-4333-8333-333333333333" })) {
    for (const part of ["scope", "binding"]) {
      const input = assignmentCase(); input[part][key] = value;
      assert.throws(() => correlateReport(input), /current scope/);
    }
  }
});

test("a report cannot substitute the dispatch issuer, call or native child identity", async () => {
  const { correlateReport } = await assignmentApi();
  for (const [part, key, value] of [
    ["binding", "assignment", "33333333-3333-4333-8333-333333333333"], ["binding", "issuer", "another-lead"], ["binding", "call", "spawn-2"], ["binding", "session", "another-root"],
    ["native", "session", "another-root"], ["native", "child", "another-child"],
  ]) {
    const input = assignmentCase(); input[part][key] = value;
    assert.throws(() => correlateReport(input), /binding|another child or session/);
  }
  const self = assignmentCase(); self.binding.child = self.native.child = self.binding.issuer;
  assert.throws(() => correlateReport(self), /own child/);
});

test("stale assignment, task and run references cannot claim a newer assignment", async () => {
  const { correlateReport } = await assignmentApi();
  for (const [key, value] of Object.entries({ assignment: "44444444-4444-4444-8444-444444444444", task: "T2", run: "R2" })) {
    const input = assignmentCase(); input.reference[key] = value;
    assert.throws(() => correlateReport(input), /another assignment|another task or run/);
  }
});

test("assignment boundaries reject missing, malformed and extra identity fields", async () => {
  const { createAssignment, correlateReport } = await assignmentApi();
  assert.throws(() => createAssignment({ ...assignmentScope, project: "" }, assignmentDispatch), /project/);
  assert.throws(() => createAssignment(assignmentScope, { ...assignmentDispatch, task: "T0" }), /task/);
  for (const part of ["scope", "assignment", "binding", "native", "reference"]) {
    for (const bad of [null, [], {}, { ...assignmentCase()[part], message: "private report text" }]) {
      const input = assignmentCase(); input[part] = bad;
      assert.throws(() => correlateReport(input), /Assignment:/);
    }
  }
  for (const turn of ["", "x".repeat(257), "line\nbreak", "turn\n"]) {
    const input = assignmentCase(); input.native.turn = turn;
    assert.throws(() => correlateReport(input), /turn/);
  }
});

const admissionApi = () => import("../packages/sage-core/index.mjs");
const admissionConfig = { total: 3, projects: [{ project: "one", limit: 2 }, { project: "two", limit: 2 }] };
const admissionOwner = { project: "one", session: "session-one", activation: "11111111-1111-4111-8111-111111111111" };
const admissionDispatch = { tool: "native-spawn", turn: "parent-turn", name: "worker", argumentsHash: "a".repeat(64) };
const admissionRuns = new Map();
const admissionRequest = (call) => {
  if (!admissionRuns.has(call)) admissionRuns.set(call, `R${admissionRuns.size + 1}`);
  return { task: "T1", run: admissionRuns.get(call), issuer: "session-one", call };
};
const admissionScope = (owner) => ({ project: owner.project, session: owner.session, epoch: owner.epoch });
function admissionTemp(t) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-admission-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function admissionFixture(t) {
  const api = await admissionApi(), dir = admissionTemp(t);
  api.configureAdmission(dir, admissionConfig);
  const owner = api.activateAdmission(dir, admissionOwner);
  return { api, dir, owner, scope: admissionScope(owner) };
}

async function interruptedFinishFixture(t, role = "qa", interrupted = true) {
  const api = await admissionApi(), dir = admissionTemp(t);
  api.configureAdmission(dir, { total: 20, projects: [{ project: "one", limit: 20 }] });
  const owner = api.activateAdmission(dir, admissionOwner), scope = admissionScope(owner);
  const prepare = (n, options = {}) => {
    const { issuer = owner.session, issuerRole = "chief-of-staff", task = "T1", previous,
      role: nextRole = role } = options;
    const runTarget = { task, run: `R${n}`, role: nextRole, round: 1,
      taskBranch: "codex/fixture", runBranch: "codex/fixture", candidate: "fixture-candidate" };
    return api.prepareAdmission(dir, scope, { task, run: runTarget.run, issuer, name: `work-${n}` },
      { issuerRole, role: nextRole }, completeBrief("Finish the fixed task."),
      { runTarget, ...(previous ? { continuation: previous } : {}) }).preparation;
  };
  const reserve = prepared => {
    const request = { preparation: prepared.id, issuer: prepared.issuer, call: `call-${prepared.name}` };
    const dispatch = { tool: prepared.continuation ? "followup" : "spawn", turn: "parent-turn",
      name: prepared.name, argumentsHash: "a".repeat(64), taskHash: "b".repeat(64) };
    return prepared.continuation
      ? api.reservePreparedContinuation(dir, scope, { ...request, previous: prepared.continuation }, dispatch, prepared.rolePlan.issuerRole)
      : api.reservePreparedAdmission(dir, scope, request, dispatch, prepared.rolePlan.issuerRole);
  };
  const prepared = prepare(1), first = reserve(prepared), binding = bindingFor(first.assignment, "worker", "turn-1");
  api.bindAdmission(dir, binding);
  const requestFor = (saved, bound, evidenceHash = "c".repeat(64)) => ({ binding: bound, task: saved.task,
    run: saved.run, role: saved.rolePlan.role, status: "blocked", evidenceHash, runTarget: saved.runTarget });
  const request = requestFor(prepared, binding);
  if (interrupted) api.interruptAdmission(dir, binding, request.evidenceHash);
  return { api, dir, owner, scope, prepared, first, binding, request, prepare, reserve, requestFor };
}

test("T63 admission finish requires exact interruption and saved run target evidence", async t => {
  const f = await interruptedFinishFixture(t), { api, dir, request } = f;
  assert.equal(typeof api.beginInterruptedRunFinish, "function");
  const before = api.readAdmission(dir);
  const inherited = Object.create(request);
  const missing = { ...request }; delete missing.runTarget;
  for (const input of [null, [], inherited, missing, { ...request, extra: true },
    { ...request, task: ["T1"] }, { ...request, run: 1 }, { ...request, status: "done" },
    { ...request, status: ["failed"] }, { ...request, evidenceHash: "short" },
    { ...request, evidenceHash: "d".repeat(64) }, { ...request, run: "R2" },
    { ...request, role: "lead" }, { ...request, binding: { ...request.binding, child: "foreign" } },
    { ...request, binding: { ...request.binding, issuer: "foreign" } },
    { ...request, binding: { ...request.binding, epoch: "33333333-3333-4333-8333-333333333333" } },
    { ...request, runTarget: { ...request.runTarget, task: "T2" } },
    { ...request, runTarget: { ...request.runTarget, candidate: "changed" } },
    { ...request, runTarget: { ...request.runTarget, round: "1" } }]) {
    assert.throws(() => api.beginInterruptedRunFinish(dir, input));
    assert.deepEqual(api.readAdmission(dir), before);
  }
  assert.throws(() => api.endInterruptedRunFinish(dir, request, "e".repeat(64)), /no pending finish/);
  assert.deepEqual(api.beginInterruptedRunFinish(dir, request), { request });
  for (const outcome of ["running", "completed"]) {
    const other = await interruptedFinishFixture(t, "qa", false);
    if (outcome === "completed") other.api.completeAdmission(other.dir, other.binding);
    assert.throws(() => other.api.beginInterruptedRunFinish(other.dir, other.request), /matching evidence/);
    assert.equal(other.api.readAdmission(other.dir).interruptedFinishes, undefined);
  }
});

test("T63 admission finish keeps off-mode retries durable and permits reuse only after acknowledgement", async t => {
  const f = await interruptedFinishFixture(t), { api, dir, request } = f;
  assert.equal(typeof api.beginInterruptedRunFinish, "function");
  const next = f.prepare(2, { previous: f.first.assignment.id });
  const off = "22222222-2222-4222-8222-222222222222", on = "33333333-3333-4333-8333-333333333333";
  api.changeAdmissionMode(dir, { ...f.scope, after: f.owner.activation, turn: off, sage: false });
  const pending = api.beginInterruptedRunFinish(dir, request), beforeRetry = readdirSync(dir);
  assert.deepEqual(pending, { request });
  pending.request.runTarget.candidate = "caller mutation";
  assert.deepEqual(api.beginInterruptedRunFinish(dir, request), { request });
  assert.deepEqual(readdirSync(dir), beforeRetry, "an exact retry must not append a journal transition");
  api.changeAdmissionMode(dir, { ...f.scope, after: off, turn: on, sage: true });
  assert.throws(() => f.reserve(next), /publication still owns/);
  assert.throws(() => f.prepare(3, { previous: f.first.assignment.id }), /publication still owns/);
  assert.equal(f.reserve(f.prepared).decision, "already-reserved", "an old reservation grants no second dispatch");
  const unrelated = f.prepare(4, { task: "T2" });
  assert.equal(f.reserve(unrelated).decision, "permit-once", "the chief can admit an unrelated child while publication is pending");
  for (const changed of [{ ...request, status: "failed" }, { ...request, evidenceHash: "d".repeat(64) }]) {
    assert.throws(() => api.beginInterruptedRunFinish(dir, changed), /different finish request/);
    assert.throws(() => api.endInterruptedRunFinish(dir, changed, "e".repeat(64)), /different finish request/);
  }
  const finished = { request, receiptHash: "e".repeat(64) };
  assert.deepEqual(api.endInterruptedRunFinish(dir, request, finished.receiptHash), finished);
  const saved = f.reserve(next), nextBinding = bindingFor(saved.assignment, f.binding.child, "turn-2");
  api.bindContinuationAdmission(dir, nextBinding);
  const active = api.readAdmission(dir), files = readdirSync(dir);
  assert.deepEqual(api.beginInterruptedRunFinish(dir, request), finished, "historical begin cannot reopen a finished fence");
  assert.deepEqual(api.endInterruptedRunFinish(dir, request, finished.receiptHash), finished);
  assert.throws(() => api.endInterruptedRunFinish(dir, request, "f".repeat(64)), /receipt differs/);
  assert.deepEqual(api.readAdmission(dir), active);
  assert.deepEqual(readdirSync(dir), files);
  api.interruptAdmission(dir, nextBinding, "d".repeat(64));
  const nextRequest = f.requestFor(next, nextBinding, "d".repeat(64));
  api.beginInterruptedRunFinish(dir, nextRequest);
  assert.deepEqual(api.endInterruptedRunFinish(dir, request, finished.receiptHash), finished);
  assert.throws(() => f.prepare(5, { previous: saved.assignment.id }), /publication still owns/,
    "an old acknowledgement cannot clear the later fence");
  assert.deepEqual(api.readAdmission(dir).interruptedFinishes, [finished, { request: nextRequest }]);
});

test("T63 admission finish waits for bound and unbound work in the historical child team", async t => {
  const f = await interruptedFinishFixture(t, "lead", false), { api, dir } = f;
  assert.equal(typeof api.beginInterruptedRunFinish, "function");
  const child = f.prepare(2, { issuer: f.binding.child, issuerRole: "lead", role: "qa" });
  const childRun = f.reserve(child), childBinding = bindingFor(childRun.assignment, "reviewer", "review-turn");
  api.bindAdmission(dir, childBinding);
  const unbound = f.reserve(f.prepare(3, { issuer: f.binding.child, issuerRole: "lead", role: "qa" }));
  api.interruptAdmission(dir, f.binding, f.request.evidenceHash);
  let before = api.readAdmission(dir);
  assert.throws(() => api.beginInterruptedRunFinish(dir, f.request), /team still has active work/);
  assert.deepEqual(api.readAdmission(dir), before);
  api.completeAdmission(dir, childBinding);
  before = api.readAdmission(dir);
  assert.throws(() => api.beginInterruptedRunFinish(dir, f.request), /team still has active work/);
  assert.deepEqual(api.readAdmission(dir), before, "an unbound reservation still owns its slot");
  const { project, session, epoch, id: assignment, issuer, call } = unbound.assignment;
  api.failAdmission(dir, { project, session, epoch, assignment, issuer, call, evidenceHash: "d".repeat(64) });
  assert.deepEqual(api.beginInterruptedRunFinish(dir, f.request), { request: f.request });
  const settled = api.readAdmission(dir);
  assert.equal(settled.bindings.length, 2);
  assert.equal(settled.completions.length, 2);
  assert.equal(settled.failures.length, 1);
  assert.equal(settled.reservations.length, 3);
});

test("T63 admission finish and continuation resolve both CAS publication orders", async t => {
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  for (const winner of ["finish", "continuation"]) {
    const f = await interruptedFinishFixture(t), { api, dir, request } = f;
    assert.equal(typeof api.beginInterruptedRunFinish, "function");
    const next = f.prepare(2, { previous: f.first.assignment.id });
    const original = fs.linkSync;
    let raced = false, won;
    // Publish the competing complete journal record after the outer operation reads
    // its snapshot, but before its compare-and-swap. No clock controls this order.
    fs.linkSync = (...args) => {
      if (!raced) {
        raced = true;
        won = winner === "finish" ? api.beginInterruptedRunFinish(dir, request) : f.reserve(next);
      }
      return original(...args);
    };
    syncBuiltinESMExports();
    try {
      if (winner === "finish") assert.throws(() => f.reserve(next), /publication still owns/);
      else assert.throws(() => api.beginInterruptedRunFinish(dir, request), /team still has active work/);
    } finally { fs.linkSync = original; syncBuiltinESMExports(); }
    assert.equal(raced, true);
    const state = api.readAdmission(dir);
    assert.equal(readdirSync(dir).some(name => name.startsWith(".pending-")), false);
    if (winner === "finish") {
      assert.deepEqual(won, { request });
      assert.equal(state.reservations.length, 1);
      assert.deepEqual(state.interruptedFinishes, [{ request }]);
    } else {
      assert.equal(won.decision, "permit-once");
      assert.equal(state.reservations.length, 2);
      assert.equal(state.interruptedFinishes, undefined);
      const nextBinding = bindingFor(won.assignment, f.binding.child, "turn-2");
      api.bindContinuationAdmission(dir, nextBinding);
      assert.throws(() => api.beginInterruptedRunFinish(dir, request), /team still has active work/);
      api.completeAdmission(dir, nextBinding);
      assert.deepEqual(api.beginInterruptedRunFinish(dir, request), { request });
    }
  }
});

test("T63 admission finish recovers a published barrier after a durability error", async t => {
  const f = await interruptedFinishFixture(t), { api, dir, request } = f;
  assert.equal(typeof api.beginInterruptedRunFinish, "function");
  const next = f.prepare(2, { previous: f.first.assignment.id });
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const link = fs.linkSync, sync = fs.fsyncSync;
  let published = false, failed = false;
  fs.linkSync = (...args) => { const result = link(...args); published = true; return result; };
  fs.fsyncSync = fd => {
    if (published && !failed) { failed = true; throw Error("fixed finish durability failure"); }
    return sync(fd);
  };
  syncBuiltinESMExports();
  try { assert.throws(() => api.beginInterruptedRunFinish(dir, request), /fixed finish durability failure/); }
  finally { fs.linkSync = link; fs.fsyncSync = sync; syncBuiltinESMExports(); }
  assert.equal(failed, true);
  assert.deepEqual(api.readAdmission(dir).interruptedFinishes, [{ request }]);
  assert.throws(() => f.reserve(next), /publication still owns/);
  assert.deepEqual(api.beginInterruptedRunFinish(dir, request), { request });
  const finished = { request, receiptHash: "e".repeat(64) };
  assert.deepEqual(api.endInterruptedRunFinish(dir, request, finished.receiptHash), finished);
  assert.equal(f.reserve(next).decision, "permit-once");
  assert.deepEqual(api.readAdmission(dir).interruptedFinishes, [finished]);
  assert.equal(readdirSync(dir).some(name => name.startsWith(".pending-")), false);
});

test("T63 admission finish rejects altered evidence and duplicate transitions during journal replay", async t => {
  const { createHash } = await import("node:crypto");
  for (const damage of ["target", "duplicate-begin", "orphan-end", "duplicate-end", "changed-end"]) {
    const f = await interruptedFinishFixture(t), { api, dir, request } = f;
    assert.equal(typeof api.beginInterruptedRunFinish, "function");
    api.beginInterruptedRunFinish(dir, request);
    if (damage.endsWith("end") && damage !== "orphan-end")
      api.endInterruptedRunFinish(dir, request, "e".repeat(64));
    assert.equal(api.readAdmission(dir).interruptedFinishes.length, 1);
    const last = readdirSync(dir).sort().at(-1), record = JSON.parse(readFileSync(join(dir, last), "utf8"));
    const data = structuredClone(record.data);
    if (damage === "target") data.request.runTarget.candidate = "changed";
    if (damage === "orphan-end") { data.kind = "end-interrupted-finish"; data.receiptHash = "e".repeat(64); }
    if (damage === "changed-end") data.receiptHash = "f".repeat(64);
    const append = damage.startsWith("duplicate-") || damage === "changed-end";
    const body = { schema: 1, revision: record.revision + (append ? 1 : 0),
      previous: append ? record.hash : record.previous, data };
    const changed = { ...body, hash: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
    writeFileSync(join(dir, `${String(body.revision).padStart(8, "0")}.json`), JSON.stringify(changed) + "\n");
    assert.throws(() => api.readAdmission(dir), /matching evidence|duplicate transition|no pending finish|receipt differs/, damage);
    assert.throws(() => api.beginInterruptedRunFinish(dir, request), /matching evidence|duplicate transition|no pending finish|receipt differs/, damage);
  }
});

test("admission initializes one immutable configuration and idempotent session ownership", async (t) => {
  const { api, dir, owner } = await admissionFixture(t);
  assert.deepEqual(api.configureAdmission(dir, { ...admissionConfig, projects: [...admissionConfig.projects].reverse() }), admissionConfig);
  const ordered = api.configureAdmission(admissionTemp(t), { total: 2, projects: [{ project: "a", limit: 1 }, { project: "B", limit: 1 }] });
  assert.deepEqual(ordered.projects.map(row => row.project), ["B", "a"]);
  assert.deepEqual(api.activateAdmission(dir, admissionOwner), owner);
  assert.match(owner.epoch, /^[0-9a-f-]{36}$/);
  assert.deepEqual(api.readAdmission(dir), { config: admissionConfig, sessions: [owner], reservations: [], bindings: [], preparations: [], modes: [{ ...admissionScope(owner), after: null, turn: owner.activation, sage: true }] });
  assert.throws(() => api.configureAdmission(dir, { ...admissionConfig, total: 4 }), /configuration differs/);
  assert.throws(() => api.activateAdmission(dir, { ...admissionOwner, activation: "22222222-2222-4222-8222-222222222222" }), /already has an owner/);
});

test("admission permits dispatch once and holds the reservation across a fresh reader", async (t) => {
  const { api, dir, scope } = await admissionFixture(t);
  const first = api.reserveAdmission(dir, scope, admissionRequest("call-1"), admissionDispatch);
  assert.equal(first.decision, "permit-once");
  assert.deepEqual(api.reserveAdmission(dir, scope, admissionRequest("call-1"), admissionDispatch), { decision: "already-reserved", assignment: first.assignment });
  assert.deepEqual(api.readAdmission(dir).reservations, [{ assignment: first.assignment, dispatch: admissionDispatch }]);
  const reader = spawnSync(process.execPath, ["--input-type=module", "-e", `import {readAdmission} from ${JSON.stringify(pathToFileURL(join(ROOT, "packages/sage-core/index.mjs")).href)}; process.stdout.write(JSON.stringify(readAdmission(process.argv[1])));`, dir], { encoding: "utf8", env: process.env });
  assert.equal(reader.status, 0, reader.stderr);
  assert.deepEqual(JSON.parse(reader.stdout).reservations, [{ assignment: first.assignment, dispatch: admissionDispatch }]);
});

test("admission refuses changed duplicate task, run, tool, turn, name or argument identity", async (t) => {
  const { api, dir, scope } = await admissionFixture(t);
  api.reserveAdmission(dir, scope, admissionRequest("call-1"), admissionDispatch);
  for (const change of [{ task: "T2" }, { run: "R2" }]) assert.throws(() => api.reserveAdmission(dir, scope, { ...admissionRequest("call-1"), ...change }, admissionDispatch), /different work/);
  for (const change of [{ tool: "other-tool" }, { turn: "other-turn" }, { name: "other-name" }, { argumentsHash: "b".repeat(64) }]) assert.throws(() => api.reserveAdmission(dir, scope, admissionRequest("call-1"), { ...admissionDispatch, ...change }), /different work/);
  assert.equal(api.readAdmission(dir).reservations.length, 1);
});

test("admission enforces both project and participating-store capacity", async (t) => {
  const { api, dir, scope } = await admissionFixture(t);
  api.reserveAdmission(dir, scope, admissionRequest("call-1"), admissionDispatch);
  api.reserveAdmission(dir, scope, admissionRequest("call-2"), admissionDispatch);
  assert.throws(() => api.reserveAdmission(dir, scope, admissionRequest("call-3"), admissionDispatch), /project capacity/);
  const other = api.activateAdmission(dir, { ...admissionOwner, project: "two", session: "session-two" });
  api.reserveAdmission(dir, admissionScope(other), { ...admissionRequest("call-3"), issuer: "session-two" }, admissionDispatch);
  assert.throws(() => api.reserveAdmission(dir, admissionScope(other), { ...admissionRequest("call-4"), issuer: "session-two" }, admissionDispatch), /total capacity/);
  assert.equal(api.readAdmission(dir).reservations.length, 3);
});

test("admission rejects absent owners, stale epochs, unknown projects and invalid limits", async (t) => {
  const { api, dir, scope } = await admissionFixture(t);
  for (const change of [{ session: "unowned" }, { epoch: "33333333-3333-4333-8333-333333333333" }, { project: "unknown" }]) assert.throws(() => api.reserveAdmission(dir, { ...scope, ...change }, admissionRequest("call-1"), admissionDispatch), /owner|project/);
  for (const total of [0, 51, 1.5, "3"]) assert.throws(() => api.configureAdmission(admissionTemp(t), { ...admissionConfig, total }), /capacity/);
  assert.throws(() => api.configureAdmission(admissionTemp(t), { total: 3, projects: [{ project: "one", limit: 1 }, { project: "one", limit: 2 }] }), /duplicate project/);
  const sparse = admissionTemp(t);
  assert.throws(() => api.configureAdmission(sparse, { total: 2, projects: new Array(1) }), /record fields/);
  const { readdirSync } = await import("node:fs");
  assert.deepEqual(readdirSync(sparse), []);
  assert.equal(api.readAdmission(dir).reservations.length, 0);
});

test("admission rejects a corrupt tail, missing revision, symbolic link and malformed record", async (t) => {
  const { symlinkSync, unlinkSync } = await import("node:fs");
  for (const damage of ["corrupt", "gap", "link", "shape"]) {
    const { api, dir, scope } = await admissionFixture(t);
    const target = join(dir, "00000001.json"), bytes = readFileSync(target, "utf8");
    if (damage === "gap") unlinkSync(join(dir, "00000000.json"));
    else if (damage === "link") { writeFileSync(join(dir, ".pending-11111111-1111-4111-8111-111111111111"), bytes); unlinkSync(target); symlinkSync(join(dir, ".pending-11111111-1111-4111-8111-111111111111"), target); }
    else writeFileSync(target, damage === "corrupt" ? bytes.replace("session-one", "session-two") : "{}\n");
    assert.throws(() => api.reserveAdmission(dir, scope, admissionRequest("call-1"), admissionDispatch));
  }
});

test("admission refuses malformed UTF-8 even when decoding would preserve the canonical record", async t => {
  const { api, dir, scope } = await admissionFixture(t);
  api.reserveBriefAdmission(dir, scope, admissionRequest("call-1"), admissionDispatch,
    { issuerRole: "chief-of-staff", role: "lead" }, completeBrief("Keep the replacement character: \ufffd."));
  assert.equal(api.readAdmission(dir).reservations[0].brief.GOAL, "Keep the replacement character: \ufffd.");
  const path = join(dir, "00000002.json"), valid = readFileSync(path);
  const offset = valid.indexOf(Buffer.from("\ufffd", "utf8"));
  assert.notEqual(offset, -1);
  const malformed = Buffer.concat([valid.subarray(0, offset), Buffer.from([0xff]), valid.subarray(offset + 3)]);
  assert.equal(malformed.toString("utf8"), valid.toString("utf8"), "lossy decoding would conceal the corrupt bytes");
  writeFileSync(path, malformed);
  assert.throws(() => api.readAdmission(dir), /invalid journal UTF-8/);
  assert.throws(() => api.reserveAdmission(dir, scope, admissionRequest("next-call"), admissionDispatch), /invalid journal UTF-8/);
});

test("admission ignores unpublished pending bytes but never turns them into capacity", async (t) => {
  const { api, dir, scope } = await admissionFixture(t);
  writeFileSync(join(dir, ".pending-11111111-1111-4111-8111-111111111111"), "incomplete temporary record");
  const result = api.reserveAdmission(dir, scope, admissionRequest("call-1"), admissionDispatch);
  assert.equal(result.decision, "permit-once");
  assert.equal(api.readAdmission(dir).reservations.length, 1);
});

test("admission concurrent writers never grant duplicate dispatch or exceed capacity", async (t) => {
  const { spawn } = await import("node:child_process");
  const { api, dir, scope } = await admissionFixture(t);
  const module = pathToFileURL(join(ROOT, "packages/sage-core/index.mjs")).href;
  const program = `import {reserveAdmission} from ${JSON.stringify(module)}; process.send({ready:true}); process.once('message', value=>{try{process.send({result:reserveAdmission(value.dir,value.scope,value.request,value.dispatch)});}catch(error){process.send({error:error.message});}process.disconnect();});`;
  const batch = async (calls) => {
    const children = calls.map((call) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", program], { stdio: ["ignore", "pipe", "pipe", "ipc"], env: process.env });
      let result, stderr = "", stdout = "";
      child.stderr.on("data", data => { stderr += data; }); child.stdout.on("data", data => { stdout += data; });
      const ready = new Promise((resolve, reject) => { child.once("error", reject); child.once("message", value => value.ready ? resolve() : reject(Error("worker not ready"))); });
      child.on("message", value => { if (!value.ready) result = value; });
      const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => { try { assert.equal(code, 0, stderr); assert.equal(signal, null); assert.equal(stderr, ""); assert.equal(stdout, ""); assert(result); resolve(result); } catch (error) { reject(error); } }); });
      return { child, call, ready, closed };
    });
    await Promise.all(children.map(c => c.ready));
    for (const c of children) c.child.send({ dir, scope, request: admissionRequest(c.call), dispatch: admissionDispatch });
    return Promise.all(children.map(c => c.closed));
  };
  const same = await batch(Array(6).fill("same-call"));
  assert.equal(same.filter(row => row.result?.decision === "permit-once").length, 1);
  assert.equal(same.filter(row => row.result?.decision === "already-reserved").length, 5);
  assert.equal(new Set(same.map(row => row.result.assignment.id)).size, 1);
  const distinct = await batch(Array.from({ length: 6 }, (_, i) => `distinct-${i}`));
  assert.equal(distinct.filter(row => row.result?.decision === "permit-once").length, 1);
  assert.equal(distinct.filter(row => /project capacity/.test(row.error)).length, 5);
  assert.equal(api.readAdmission(dir).reservations.length, 2);
});

test("admission failure after publication keeps its slot and never reissues permission", async (t) => {
  const { api, dir, scope } = await admissionFixture(t);
  const module = pathToFileURL(join(ROOT, "packages/sage-core/index.mjs")).href;
  const program = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const link=fs.linkSync,sync=fs.fsyncSync; let linked=false,failed=false;
    fs.linkSync=(...args)=>{link(...args);linked=true;};
    fs.fsyncSync=(fd)=>{if(linked&&!failed){failed=true;throw Error('injected_sync_failure');}return sync(fd);};
    syncBuiltinESMExports(); const api=await import(${JSON.stringify(module)});
    const [dir,scope,request,dispatch]=JSON.parse(process.argv[1]); let first;
    try{first=api.reserveAdmission(dir,scope,request,dispatch);}catch(error){first={error:error.message};}
    fs.linkSync=link;fs.fsyncSync=sync;syncBuiltinESMExports();
    process.stdout.write(JSON.stringify({first,failed,retry:api.reserveAdmission(dir,scope,request,dispatch)}));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", program, JSON.stringify([dir, scope, admissionRequest("call-1"), admissionDispatch])], { encoding: "utf8", env: process.env });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.first, { error: "injected_sync_failure" });
  assert.equal(output.failed, true);
  assert.equal(output.retry.decision, "already-reserved");
  assert.deepEqual(api.readAdmission(dir).reservations, [{ assignment: output.retry.assignment, dispatch: admissionDispatch }]);
});

test("admission rejects correctly hashed records that violate replay rules", async (t) => {
  const { createHash } = await import("node:crypto");
  for (const violation of ["duplicate", "capacity"]) {
    const { api, dir, scope } = await admissionFixture(t);
    let revision = 2, previous = JSON.parse(readFileSync(join(dir, "00000001.json"), "utf8"));
    let data = previous.data;
    if (violation === "capacity") {
      api.reserveAdmission(dir, scope, admissionRequest("call-1"), admissionDispatch);
      api.reserveAdmission(dir, scope, admissionRequest("call-2"), admissionDispatch);
      revision = 4; previous = JSON.parse(readFileSync(join(dir, "00000003.json"), "utf8"));
      data = { ...previous.data, assignment: { ...previous.data.assignment, id: "33333333-3333-4333-8333-333333333333", call: "call-3" } };
    }
    const body = { schema: 1, revision, previous: previous.hash, data };
    const record = { ...body, hash: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
    writeFileSync(join(dir, `${String(revision).padStart(8, "0")}.json`), JSON.stringify(record) + "\n");
    assert.throws(() => api.readAdmission(dir), violation === "duplicate" ? /duplicate transition/ : /project capacity/);
    assert.throws(() => api.reserveAdmission(dir, scope, admissionRequest("next-call"), admissionDispatch));
  }
});


const modeTurn = "22222222-2222-4222-8222-222222222222";
const modeNextTurn = "33333333-3333-4333-8333-333333333333";

test("admission mode persists off and on without releasing held work", async (t) => {
  const { api, dir, scope, owner } = await admissionFixture(t);
  api.reserveAdmission(dir, scope, admissionRequest("held-call"), admissionDispatch);
  const off = api.changeAdmissionMode(dir, { ...scope, after: owner.activation, turn: modeTurn, sage: false });
  assert.equal(off.decision, "changed"); assert.equal(off.mode.sage, false);
  assert.deepEqual(api.activateAdmission(dir, admissionOwner), owner);
  assert.equal(api.readAdmission(dir).modes.at(-1).sage, false);
  assert.equal(api.readAdmission(dir).reservations.length, 1);
  assert.equal(api.reserveAdmission(dir, scope, admissionRequest("held-call"), admissionDispatch).decision, "already-reserved");
  assert.throws(() => api.reserveAdmission(dir, scope, admissionRequest("off-call"), admissionDispatch), /mode is off/);
  const on = api.changeAdmissionMode(dir, { ...scope, after: modeTurn, turn: modeNextTurn, sage: true });
  assert.equal(on.mode.sage, true);
  assert.equal(api.reserveAdmission(dir, scope, admissionRequest("next-call"), admissionDispatch).decision, "permit-once");
  assert.equal(api.readAdmission(dir).reservations.length, 2);
});

test("admission mode retries cannot replay an old on over a later off", async (t) => {
  const { api, dir, scope, owner } = await admissionFixture(t);
  const request = { ...scope, after: owner.activation, turn: modeTurn, sage: true };
  api.changeAdmissionMode(dir, request);
  const off = api.changeAdmissionMode(dir, { ...scope, after: modeTurn, turn: modeNextTurn, sage: false });
  const retry = api.changeAdmissionMode(dir, request);
  assert.deepEqual(retry, { decision: "already-recorded", mode: off.mode });
  assert.equal(api.readAdmission(dir).modes.length, 3);
  assert.throws(() => api.changeAdmissionMode(dir, { ...request, sage: false }), /different mode request/);
  assert.throws(() => api.changeAdmissionMode(dir, { ...request, turn: "44444444-4444-4444-8444-444444444444" }), /mode changed/);
});

test("admission mode refuses missing owners, stale epochs and invalid mode fields", async (t) => {
  const { api, dir, scope, owner } = await admissionFixture(t);
  const request = { ...scope, after: owner.activation, turn: modeTurn, sage: false };
  assert.equal(typeof api.changeAdmissionMode, "function");
  for (const change of [{ session: "absent" }, { epoch: modeNextTurn }, { project: "absent" },
    { sage: "off" }, { sage: null }, { turn: "bad" }, { after: "bad" }, { extra: true }]) {
    assert.throws(() => api.changeAdmissionMode(dir, { ...request, ...change }));
  }
  assert.equal(api.readAdmission(dir).modes.length, 1);
});


test("admission mode concurrent changes require the same unchanged prior turn", async (t) => {
  const { spawn } = await import("node:child_process");
  const { api, dir, scope, owner } = await admissionFixture(t);
  const module = pathToFileURL(join(ROOT, "packages/sage-core/index.mjs")).href;
  const program = `import {changeAdmissionMode} from ${JSON.stringify(module)}; process.send({ready:true}); process.once('message', value=>{try{process.send({result:changeAdmissionMode(value.dir,value.request)});}catch(error){process.send({error:error.message});}process.disconnect();});`;
  const children = [modeTurn, modeNextTurn].map((turn, index) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", program], { stdio: ["ignore", "pipe", "pipe", "ipc"], env: process.env });
    let result, stderr = "", stdout = "";
    child.stderr.on("data", data => { stderr += data; }); child.stdout.on("data", data => { stdout += data; });
    const ready = new Promise((resolve, reject) => { child.once("error", reject); child.once("message", value => value.ready ? resolve() : reject(Error("worker not ready"))); });
    child.on("message", value => { if (!value.ready) result = value; });
    const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => {
      try { assert.equal(code, 0, stderr); assert.equal(signal, null); assert.equal(stderr, ""); assert.equal(stdout, ""); assert(result); resolve(result); }
      catch (error) { reject(error); }
    }); });
    return { child, ready, closed, request: { ...scope, after: owner.activation, turn, sage: index === 0 } };
  });
  await Promise.all(children.map(c => c.ready));
  for (const c of children) c.child.send({ dir, request: c.request });
  const results = await Promise.all(children.map(c => c.closed));
  assert.equal(results.filter(r => r.result?.decision === "changed").length, 1);
  assert.equal(results.filter(r => /mode changed/.test(r.error)).length, 1);
  assert.deepEqual(api.readAdmission(dir).modes.at(-1), results.find(r => r.result).result.mode);
  assert.equal(api.readAdmission(dir).modes.length, 2);
});


test("admission retains the original on meaning of earlier activation records", async (t) => {
  const { createHash } = await import("node:crypto");
  const { api, dir, owner, scope } = await admissionFixture(t);
  const path = join(dir, "00000001.json");
  const record = JSON.parse(readFileSync(path, "utf8"));
  delete record.data.sage;
  const { hash, ...body } = record;
  writeFileSync(path, JSON.stringify({ ...body, hash: createHash("sha256").update(JSON.stringify(body)).digest("hex") }) + "\n");
  assert.equal(api.readAdmission(dir).modes.at(-1).sage, true);
  assert.deepEqual(api.activateAdmission(dir, admissionOwner), owner);
  api.changeAdmissionMode(dir, { ...scope, after: owner.activation, turn: modeTurn, sage: false });
  assert.equal(api.readAdmission(dir).modes.at(-1).sage, false);
});


async function roleAdmissionFixture(t, limits = { total: 50, projects: [{ project: "project-a", limit: 50 }, { project: "project-b", limit: 50 }] }, provider = "codex") {
  const { dir, plugin } = isolated(t, provider);
  const url = pathToFileURL(join(plugin, "core/index.mjs")).href;
  const api = await import(url);
  assert.equal(typeof api.reserveRoleAdmission, "function");
  const journal = join(dir, "admission");
  api.configureAdmission(journal, limits);
  const activation = "a72422c7-509c-43aa-8c42-827c556f8a57";
  const owner = api.activateAdmission(journal, { project: "project-a", session: "root", activation });
  const scope = { project: owner.project, session: owner.session, epoch: owner.epoch };
  const args = (index, issuer = "root", current = scope) => [journal, current,
    { task: `T${index}`, run: `R${index}`, issuer, call: `spawn-${index}` },
    { tool: "spawn", turn: activation, name: `agent-${index}`, argumentsHash: "a".repeat(64) }];
  const reserve = (index, role = "lead", issuerRole = "chief-of-staff", issuer = "root", current = scope) =>
    api.reserveRoleAdmission(...args(index, issuer, current), { issuerRole, role });
  return { api, url, journal, scope, activation, args, reserve };
}

test("role admission preserves chief specialist workflows and records the role plan", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = await roleAdmissionFixture(t, undefined, provider);
    const roles = ["lead", "pe", "designer", "arena-judge", "implementer", "code-reviewer", "security-reviewer", "ux-reviewer", "qa"];
    roles.forEach((role, index) => assert.equal(f.reserve(index + 1, role).decision, "permit-once"));
    assert.deepEqual(f.api.readAdmission(f.journal).reservations.map(row => row.rolePlan), roles.map(role => ({ issuerRole: "chief-of-staff", role })));
  }
});

test("role admission refuses a third layer, a lead outside its team, and a child chief", async t => {
  const f = await roleAdmissionFixture(t);
  for (const issuerRole of ["pe", "designer", "arena-judge", "implementer", "code-reviewer", "security-reviewer", "ux-reviewer", "qa"]) {
    assert.throws(() => f.reserve(1, "qa", issuerRole, "specialist"), /specialist cannot start/);
  }
  for (const role of ["lead", "pe", "designer", "arena-judge"]) assert.throws(() => f.reserve(1, role, "lead", "lead-1"), /only its permitted team/);
  assert.throws(() => f.reserve(1, "chief-of-staff"), /owner session/);
  for (const role of [undefined, "unknown", "sage:qa", 7]) assert.throws(() => f.api.reserveRoleAdmission(...f.args(1), { issuerRole: "lead", role }), /Invalid role plan/);
  assert.deepEqual(f.api.readAdmission(f.journal).reservations, []);
});

test("role admission enforces three leads across project sessions and retains other project capacity", async t => {
  const f = await roleAdmissionFixture(t);
  for (let i = 1; i <= 3; i++) f.reserve(i);
  const other = f.api.activateAdmission(f.journal, { project: "project-a", session: "other-root", activation: f.activation });
  assert.throws(() => f.reserve(4, "lead", "chief-of-staff", "other-root", { project: other.project, session: other.session, epoch: other.epoch }), /three lead slots/);
  const b = f.api.activateAdmission(f.journal, { project: "project-b", session: "root-b", activation: f.activation });
  assert.equal(f.reserve(5, "lead", "chief-of-staff", "root-b", { project: b.project, session: b.session, epoch: b.epoch }).decision, "permit-once");
  assert.equal(f.api.readAdmission(f.journal).reservations.length, 4);
});

test("role admission counts each lead's children separately and keeps the lower capacity limit", async t => {
  const f = await roleAdmissionFixture(t);
  for (let i = 1; i <= 3; i++) f.reserve(i, ["implementer", "code-reviewer", "qa"][i - 1], "lead", "lead-1");
  assert.throws(() => f.reserve(4, "qa", "lead", "lead-1"), /three child slots/);
  assert.equal(f.reserve(5, "security-reviewer", "lead", "lead-2").decision, "permit-once");
  assert.equal(f.reserve(6, "ux-reviewer", "lead", "lead-2").decision, "permit-once");
  const small = await roleAdmissionFixture(t, { total: 50, projects: [{ project: "project-a", limit: 1 }] });
  small.reserve(1);
  assert.throws(() => small.reserve(2), /project capacity/);
  const total = await roleAdmissionFixture(t, { total: 1, projects: [{ project: "project-a", limit: 50 }] });
  total.reserve(1);
  assert.throws(() => total.reserve(2, "qa", "lead", "lead-1"), /total capacity/);
});

test("role admission conservatively counts legacy roles and never changes a retry's role plan", async t => {
  const f = await roleAdmissionFixture(t);
  for (let i = 1; i <= 3; i++) f.api.reserveAdmission(...f.args(i));
  assert.throws(() => f.reserve(4), /three lead slots/);
  assert.throws(() => f.reserve(1), /different work/);
  const known = await roleAdmissionFixture(t);
  for (let i = 1; i <= 3; i++) known.reserve(i, "qa");
  assert.equal(known.reserve(4).decision, "permit-once", "known specialists do not take lead slots");
  const first = known.reserve(5, "qa", "lead", "lead-1");
  assert.equal(known.reserve(5, "qa", "lead", "lead-1").decision, "already-reserved");
  assert.throws(() => known.reserve(5, "implementer", "lead", "lead-1"), /different work/);
  assert.throws(() => known.api.reserveAdmission(...known.args(5, "lead-1")), /different work/);
  known.api.changeAdmissionMode(known.journal, { ...known.scope, after: known.activation, turn: "b72422c7-509c-43aa-8c42-827c556f8a57", sage: false });
  assert.equal(known.reserve(5, "qa", "lead", "lead-1").assignment.id, first.assignment.id);
  assert.throws(() => known.reserve(6), /mode is off/);
  assert.equal(known.api.readAdmission(known.journal).reservations.length, 5);
});

test("role admission grants only one remaining lead slot to concurrent callers", async t => {
  const f = await roleAdmissionFixture(t);
  f.reserve(1); f.reserve(2);
  const script = `
    const input = JSON.parse(process.argv[1]);
    const api = await import(input.url);
    try { console.log(JSON.stringify({ decision: api.reserveRoleAdmission(...input.args, { issuerRole: 'chief-of-staff', role: 'lead' }).decision })); }
    catch (error) { console.log(JSON.stringify({ refused: error.message })); }
  `;
  const run = index => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, JSON.stringify({ url: f.url, args: f.args(index) })], { shell: false });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => {
      try { assert.equal(code, 0, stderr); assert.equal(stderr, ""); resolve(JSON.parse(stdout)); }
      catch (error) { reject(error); }
    });
    child.stdin.end();
  });
  const results = await Promise.all([run(3), run(4)]);
  assert.equal(results.filter(row => row.decision === "permit-once").length, 1);
  assert.equal(results.filter(row => /three lead slots/.test(row.refused)).length, 1);
  assert.equal(f.api.readAdmission(f.journal).reservations.length, 3);
});

const bindingFor = (assignment, child = "child-1", turn = "child-turn") => ({ project: assignment.project,
  session: assignment.session, epoch: assignment.epoch, assignment: assignment.id,
  issuer: assignment.issuer, call: assignment.call, child, turn });

test("child binding persists the reserved role without another permit and permits exact retries", async t => {
  const f = await roleAdmissionFixture(t);
  assert.equal(typeof f.api.bindAdmission, "function");
  const first = f.reserve(1);
  const binding = bindingFor(first.assignment);
  assert.deepEqual(f.api.bindAdmission(f.journal, binding), { decision: "bound", binding, role: "lead" });
  assert.deepEqual(f.api.bindAdmission(f.journal, binding), { decision: "already-bound", binding, role: "lead" });
  f.api.changeAdmissionMode(f.journal, { ...f.scope, after: f.activation, turn: "b72422c7-509c-43aa-8c42-827c556f8a57", sage: false });
  assert.equal(f.api.bindAdmission(f.journal, binding).decision, "already-bound");
  assert.deepEqual(f.api.readAdmission(f.journal).bindings, [binding]);
  assert.equal(f.api.readAdmission(f.journal).reservations.length, 1);
  assert.equal(f.reserve(1).decision, "already-reserved");
});

test("child binding refuses changed scope, roleless reservations, self-binding, and replacement identities", async t => {
  const f = await roleAdmissionFixture(t);
  const a = f.reserve(1).assignment; const b = bindingFor(a);
  for (const change of [{ project: "project-b" }, { session: "other" }, { epoch: f.activation },
    { assignment: f.activation }, { issuer: "other" }, { call: "other" }, { child: a.issuer }, { role: "qa" }]) {
    assert.throws(() => f.api.bindAdmission(f.journal, { ...b, ...change }));
  }
  const legacy = f.api.reserveAdmission(...f.args(2));
  assert.throws(() => f.api.bindAdmission(f.journal, bindingFor(legacy.assignment)), /recorded role/);
  f.api.bindAdmission(f.journal, b);
  assert.throws(() => f.api.bindAdmission(f.journal, { ...b, child: "other-child" }), /different child binding/);
  assert.throws(() => f.api.bindAdmission(f.journal, { ...b, turn: "later-turn" }), /different child binding/);
  const second = f.reserve(3).assignment;
  assert.throws(() => f.api.bindAdmission(f.journal, bindingFor(second)), /another assignment/);
  assert.deepEqual(f.api.readAdmission(f.journal).bindings, [b]);
});

test("child binding refuses ambiguous names and role admission prevents name reuse", async t => {
  const f = await roleAdmissionFixture(t);
  const first = f.reserve(1);
  const args = f.args(2); args[3].name = "agent-1";
  assert.throws(() => f.api.reserveRoleAdmission(...args, { issuerRole: "chief-of-staff", role: "qa" }), /name is already reserved/);
  f.api.reserveAdmission(...args);
  assert.throws(() => f.api.bindAdmission(f.journal, bindingFor(first.assignment)), /name is ambiguous/);
  assert.deepEqual(f.api.readAdmission(f.journal).bindings, []);
});

test("child binding atomically selects one child when two callers claim the same assignment", async t => {
  const f = await roleAdmissionFixture(t); const a = f.reserve(1).assignment;
  const script = `const input=JSON.parse(process.argv[1]); const api=await import(input.url);
    try { console.log(JSON.stringify(api.bindAdmission(input.dir,input.binding))); }
    catch(error) { console.log(JSON.stringify({refused:error.message})); }`;
  const run = childName => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script,
      JSON.stringify({ url: f.url, dir: f.journal, binding: bindingFor(a, childName) })], { shell: false });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
    child.once("error", reject); child.once("close", code => {
      try { assert.equal(code, 0, stderr); assert.equal(stderr, ""); resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    }); child.stdin.end();
  });
  const results = await Promise.all([run("child-a"), run("child-b")]);
  assert.equal(results.filter(row => row.decision === "bound").length, 1);
  assert.equal(results.filter(row => /different child binding/.test(row.refused)).length, 1);
  assert.deepEqual(f.api.readAdmission(f.journal).bindings, [results.find(row => row.binding).binding]);
});


test("child binding keeps an exact receipt after a later legacy name collision", async t => {
  const f = await roleAdmissionFixture(t); const a = f.reserve(1).assignment;
  const b = bindingFor(a); f.api.bindAdmission(f.journal, b);
  const args = f.args(2); args[3].name = "agent-1"; f.api.reserveAdmission(...args);
  assert.deepEqual(f.api.bindAdmission(f.journal, b), { decision: "already-bound", binding: b, role: "lead" });
});

test("child binding reads prior role records with reused names but refuses a new ambiguous binding", async t => {
  const { createHash } = await import("node:crypto");
  const f = await roleAdmissionFixture(t); const first = f.reserve(1); f.reserve(2);
  let previous = null;
  for (let revision = 0; revision < 4; revision++) {
    const path = join(f.journal, String(revision).padStart(8, "0") + ".json");
    const prior = JSON.parse(readFileSync(path, "utf8"));
    if (prior.data.kind === "reserve") { delete prior.data.uniqueName; prior.data.dispatch.name = "agent-1"; }
    const body = { schema: prior.schema, revision, previous, data: prior.data };
    previous = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    writeFileSync(path, JSON.stringify({ ...body, hash: previous }) + "\n");
  }
  assert.equal(f.api.readAdmission(f.journal).reservations.length, 2);
  assert.throws(() => f.api.bindAdmission(f.journal, bindingFor(first.assignment)), /name is ambiguous/);
});


const completeBrief = goal => Object.fromEntries(["GOAL", "SCOPE", "CONTEXT", "DECISIONS", "ACCEPTANCE", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"]
  .map(field => [field, field === "GOAL" ? goal : "none"]));

test("brief admission uses the existing field contract and preserves readable text", async t => {
  const f = await roleAdmissionFixture(t);
  const { BRIEF_FIELDS } = await import("../plugins/sage/hooks/sage-hook.mjs");
  assert.deepEqual(f.api.BRIEF_FIELDS, BRIEF_FIELDS);
  assert.equal(Object.isFrozen(f.api.BRIEF_FIELDS), true);
  const brief = completeBrief("Build the fixed fixture.\nKeep the second line.");
  assert.deepEqual(f.api.parseBrief(brief), brief);
  const rendered = f.api.renderBrief(brief);
  assert(rendered.startsWith("GOAL\nBuild the fixed fixture.\nKeep the second line.\n\nSCOPE\nnone"));
  assert(rendered.endsWith("STANDING\nnone"));
});

test("brief admission rejects missing, inherited, invalid, and oversized fields", async t => {
  const f = await roleAdmissionFixture(t); const brief = completeBrief("A complete task.");
  const inherited = Object.assign(Object.create({ GOAL: brief.GOAL }), brief); delete inherited.GOAL;
  for (const value of [null, [], {}, inherited, { ...brief, extra: "unexpected" }, { ...brief, GOAL: "  " },
    { ...brief, SCOPE: null }, { ...brief, VERIFY: "bad\0text" }, { ...brief, GOAL: "\ud800" }, { ...brief, GOAL: "x".repeat(33 * 1024) }, { ...brief, CONTEXT: "\n".repeat(20_000) }]) {
    assert.throws(() => f.api.parseBrief(value));
    assert.throws(() => f.api.reserveBriefAdmission(...f.args(1), { issuerRole: "chief-of-staff", role: "lead" }, value));
  }
  assert.deepEqual(f.api.readAdmission(f.journal).reservations, []);
});

test("brief admission saves role and instructions together and copies caller values", async t => {
  const f = await roleAdmissionFixture(t); const brief = completeBrief("The original task.");
  const result = f.api.reserveBriefAdmission(...f.args(1), { issuerRole: "chief-of-staff", role: "lead" }, brief);
  assert.equal(result.decision, "permit-once");
  brief.GOAL = "Changed after admission.";
  const row = f.api.readAdmission(f.journal).reservations[0];
  assert.equal(row.assignment.id, result.assignment.id); assert.equal(row.rolePlan.role, "lead");
  assert.equal(row.brief.GOAL, "The original task.");
  row.brief.GOAL = "Changed snapshot.";
  assert.equal(f.api.readAdmission(f.journal).reservations[0].brief.GOAL, "The original task.");
});

test("brief admission retries cannot change, add, or remove saved instructions", async t => {
  const f = await roleAdmissionFixture(t); const brief = completeBrief("The fixed task.");
  const role = { issuerRole: "chief-of-staff", role: "lead" };
  const first = f.api.reserveBriefAdmission(...f.args(1), role, brief);
  const reordered = Object.fromEntries(Object.entries(brief).reverse());
  assert.equal(f.api.reserveBriefAdmission(...f.args(1), role, reordered).assignment.id, first.assignment.id);
  assert.throws(() => f.api.reserveBriefAdmission(...f.args(1), role, { ...brief, GOAL: "Different task." }), /different work/);
  assert.throws(() => f.api.reserveRoleAdmission(...f.args(1), role), /different work/);
  assert.throws(() => f.api.reserveAdmission(...f.args(1)), /different work/);
  f.reserve(2);
  assert.throws(() => f.api.reserveBriefAdmission(...f.args(2), role, brief), /different work/);
  f.api.changeAdmissionMode(f.journal, { ...f.scope, after: f.activation, turn: "b72422c7-509c-43aa-8c42-827c556f8a57", sage: false });
  assert.equal(f.api.reserveBriefAdmission(...f.args(1), role, brief).decision, "already-reserved");
  assert.equal(f.api.readAdmission(f.journal).reservations.length, 2);
});

test("brief admission keeps capacity limits and publishes no failed reservation", async t => {
  const f = await roleAdmissionFixture(t, { total: 1, projects: [{ project: "project-a", limit: 1 }] });
  const role = { issuerRole: "chief-of-staff", role: "lead" };
  f.api.reserveBriefAdmission(...f.args(1), role, completeBrief("First task."));
  assert.throws(() => f.api.reserveBriefAdmission(...f.args(2), role, completeBrief("Second task.")), /capacity/);
  const rows = f.api.readAdmission(f.journal).reservations;
  assert.equal(rows.length, 1); assert.equal(rows[0].brief.GOAL, "First task.");
});

test("brief admission permits only one of two concurrent instructions for the same call", async t => {
  const f = await roleAdmissionFixture(t);
  const script = `const input=JSON.parse(process.argv[1]);const api=await import(input.url);
    try { console.log(JSON.stringify(api.reserveBriefAdmission(...input.args,{issuerRole:'chief-of-staff',role:'lead'},input.brief))); }
    catch(error) { console.log(JSON.stringify({refused:error.message})); }`;
  const run = goal => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script,
      JSON.stringify({ url: f.url, args: f.args(1), brief: completeBrief(goal) })], { shell: false });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
    child.once("error", reject); child.once("close", code => {
      try { assert.equal(code, 0, stderr); assert.equal(stderr, ""); resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    }); child.stdin.end();
  });
  const results = await Promise.all([run("First proposed task."), run("Second proposed task.")]);
  assert.equal(results.filter(row => row.decision === "permit-once").length, 1);
  assert.equal(results.filter(row => /different work/.test(row.refused)).length, 1);
  assert.equal(f.api.readAdmission(f.journal).reservations.length, 1);
});


async function preparationFixture(t, limits) {
  const { plugin } = isolated(t, "codex");
  const api = await import(pathToFileURL(join(plugin, "core/index.mjs")));
  assert.equal(typeof api.prepareAdmission, "function", "durable task preparation must ship in core");
  assert.equal(typeof api.reservePreparedAdmission, "function", "prepared dispatch consumption must ship in core");
  const f = await roleAdmissionFixture(t, limits);
  const role = { issuerRole: "chief-of-staff", role: "lead" };
  const request = { task: "T1", run: "R1", issuer: "root", name: "agent-1" };
  const prepare = (changes = {}, brief = completeBrief("Complete the fixture task."), plan = role) =>
    f.api.prepareAdmission(f.journal, f.scope, { ...request, ...changes }, plan, brief);
  const reserve = (id, call = "spawn-1", dispatch = f.args(1)[3], issuerRole = role.issuerRole, issuer = "root", scope = f.scope) =>
    f.api.reservePreparedAdmission(f.journal, scope, { preparation: id, issuer, call }, dispatch, issuerRole);
  return { ...f, role, request, prepare, reserve };
}

test("prepared admission saves immutable work before the native call without taking capacity", async t => {
  const f = await preparationFixture(t, { total: 1, projects: [{ project: "project-a", limit: 1 }] });
  const brief = completeBrief("The saved task.");
  const first = f.prepare({}, brief);
  assert.equal(first.decision, "prepared");
  f.prepare({ name: "second" });
  brief.GOAL = "Caller changed it."; first.preparation.brief.GOAL = "Receipt changed it.";
  const snapshot = f.api.readAdmission(f.journal);
  assert.equal(snapshot.preparations.length, 2);
  assert.equal(snapshot.preparations[0].brief.GOAL, "The saved task.");
  assert.deepEqual(snapshot.reservations, []);
  const admitted = f.reserve(first.preparation.id);
  assert.equal(admitted.decision, "permit-once");
  const row = f.api.readAdmission(f.journal).reservations[0];
  assert.equal(row.preparation, first.preparation.id);
  assert.equal(row.brief.GOAL, "The saved task.");
  assert.equal(row.assignment.call, "spawn-1");
  assert.notEqual(row.assignment.id, first.preparation.id);
});

test("prepared admission retries preserve the original task role and every brief field", async t => {
  const f = await preparationFixture(t); const first = f.prepare();
  assert.deepEqual(f.prepare(), { decision: "already-prepared", preparation: first.preparation });
  for (const changes of [{ task: "T2" }, { run: "R2" }]) assert.throws(() => f.prepare(changes), /different work/);
  for (const key of f.api.BRIEF_FIELDS) {
    assert.throws(() => f.prepare({}, { ...completeBrief("Complete the fixture task."), [key]: "Replacement text." }), /different work/);
  }
  assert.throws(() => f.prepare({}, completeBrief("Complete the fixture task."), { issuerRole: "chief-of-staff", role: "qa" }), /different work/);
  assert.equal(f.api.readAdmission(f.journal).preparations.length, 1);
  const admitted = f.reserve(first.preparation.id);
  assert.equal(f.reserve(first.preparation.id).assignment.id, admitted.assignment.id);
  assert.equal(f.reserve(first.preparation.id).decision, "already-reserved");
  assert.throws(() => f.reserve(first.preparation.id, "spawn-2"), /already has a dispatch/);
  assert.throws(() => f.api.reserveBriefAdmission(...f.args(1), f.role, completeBrief("Complete the fixture task.")), /different work/);
});

test("prepared admission refuses invalid briefs roles and requests without publishing", async t => {
  const f = await preparationFixture(t);
  for (const brief of [{}, { ...completeBrief("Complete the fixture task."), GOAL: "" }, { ...completeBrief("Complete the fixture task."), GOAL: "x\0y" },
    { ...completeBrief("Complete the fixture task."), GOAL: "x".repeat(32769) }]) assert.throws(() => f.prepare({}, brief));
  for (const plan of [{ issuerRole: "qa", role: "qa" }, { issuerRole: "lead", role: "lead" },
    { issuerRole: "chief-of-staff", role: "chief-of-staff" }]) assert.throws(() => f.prepare({}, completeBrief("Complete the fixture task."), plan));
  for (const changes of [{ task: "bad" }, { run: "bad" }, { name: "" }, { issuer: null }, { extra: true }]) {
    assert.throws(() => f.prepare(changes));
  }
  assert.deepEqual(f.api.readAdmission(f.journal).preparations, []);
});

test("prepared admission requires matching scope issuer name and current issuer role at dispatch", async t => {
  const f = await preparationFixture(t); const first = f.prepare(); const id = first.preparation.id;
  assert.throws(() => f.reserve(id, "spawn-1", { ...f.args(1)[3], name: "other" }), /differs from its preparation/);
  assert.throws(() => f.reserve(id, "spawn-1", f.args(1)[3], "lead"), /differs from its preparation/);
  assert.throws(() => f.reserve(id, "spawn-1", f.args(1)[3], "chief-of-staff", "other"), /differs from its preparation/);
  const owner = f.api.activateAdmission(f.journal, { project: "project-b", session: "root", activation: f.activation });
  assert.throws(() => f.reserve(id, "spawn-1", f.args(1)[3], "chief-of-staff", "root",
    { project: owner.project, session: owner.session, epoch: owner.epoch }), /differs from its preparation/);
  assert.throws(() => f.reserve("00000000-0000-0000-0000-000000000000"), /unavailable/);
  assert.deepEqual(f.api.readAdmission(f.journal).reservations, []);
});

test("prepared admission enforces mode capacity and role limits again at dispatch", async t => {
  const f = await preparationFixture(t, { total: 1, projects: [{ project: "project-a", limit: 1 }] });
  const first = f.prepare();
  f.api.changeAdmissionMode(f.journal, { ...f.scope, after: f.activation, turn: "b72422c7-509c-43aa-8c42-827c556f8a57", sage: false });
  assert.equal(f.prepare().decision, "already-prepared");
  assert.throws(() => f.prepare({ name: "other" }), /mode is off/);
  assert.throws(() => f.reserve(first.preparation.id), /mode is off/);
  f.api.changeAdmissionMode(f.journal, { ...f.scope, after: "b72422c7-509c-43aa-8c42-827c556f8a57", turn: "c72422c7-509c-43aa-8c42-827c556f8a57", sage: true });
  f.api.reserveRoleAdmission(...f.args(2), f.role);
  assert.throws(() => f.reserve(first.preparation.id), /capacity/);
  const leads = await preparationFixture(t); const prepared = leads.prepare();
  for (let n = 2; n <= 4; n++) leads.api.reserveRoleAdmission(...leads.args(n), leads.role);
  assert.throws(() => leads.reserve(prepared.preparation.id), /three lead slots/);
  assert.equal(leads.api.readAdmission(leads.journal).reservations.length, 3);
});

test("prepared admission refuses an already dispatched name and preserves legacy reservations", async t => {
  const f = await preparationFixture(t);
  f.api.reserveAdmission(...f.args(1));
  assert.throws(() => f.prepare(), /already reserved/);
  assert.deepEqual(f.api.readAdmission(f.journal).preparations, []);
  const row = f.api.readAdmission(f.journal).reservations[0];
  assert.equal(Object.hasOwn(row, "preparation"), false);
  assert.equal(Object.hasOwn(row, "brief"), false);
  const prepared = f.prepare({ name: "agent-2" });
  f.api.reserveAdmission(...f.args(2));
  assert.throws(() => f.reserve(prepared.preparation.id, "another-call", f.args(2)[3]), /already reserved/);
});

test("prepared admission gives one preparation and one dispatch to concurrent callers", async t => {
  const f = await preparationFixture(t);
  const script = `const input=JSON.parse(process.argv[1]);const api=await import(input.url);
    try { console.log(JSON.stringify(api[input.method](...input.args))); }
    catch(error) { console.log(JSON.stringify({refused:error.message})); }`;
  const run = (method, args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, JSON.stringify({ url: f.url, method, args })], { shell: false });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
    child.once("error", reject); child.once("close", code => {
      try { assert.equal(code, 0, stderr); assert.equal(stderr, ""); resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    }); child.stdin.end();
  });
  const proposed = await Promise.all(["First work.", "Other work."].map(goal => run("prepareAdmission",
    [f.journal, f.scope, f.request, f.role, completeBrief(goal)])));
  assert.equal(proposed.filter(row => row.decision === "prepared").length, 1);
  assert.equal(proposed.filter(row => /different work/.test(row.refused)).length, 1);
  const id = proposed.find(row => row.decision === "prepared").preparation.id;
  const dispatched = await Promise.all(["call-1", "call-2"].map(call => run("reservePreparedAdmission",
    [f.journal, f.scope, { preparation: id, issuer: "root", call }, f.args(1)[3], "chief-of-staff"])));
  assert.equal(dispatched.filter(row => row.decision === "permit-once").length, 1);
  assert.equal(dispatched.filter(row => /already has a dispatch/.test(row.refused)).length, 1);
  assert.equal(f.api.readAdmission(f.journal).reservations.length, 1);
});

const filePolicyApi = () => import("../plugins/sage-codex/runtime/file-policy.mjs");

test("the Codex direct edit gate denies the active chief but leaves child and inactive checks available", async () => {
  const { directEditDecision } = await filePolicyApi();
  const patch = { tool_name: "apply_patch", tool_input: { input: "*** Begin Patch\n*** Add File: sample.txt\n+sample\n*** End Patch" } };
  assert.equal(directEditDecision(patch, { sage: true, chief: true }).decision, "deny");
  assert.deepEqual(directEditDecision(patch, { sage: true, chief: false }), { decision: "pass" });
  assert.deepEqual(directEditDecision(patch, { sage: false, chief: true }), { decision: "pass" });
  assert.deepEqual(directEditDecision({ tool_name: "collaborationlist_agents" }, { sage: true, chief: true }), { decision: "pass" });
});

test("the Codex direct edit gate refuses unverified mode or chief context", async () => {
  const { directEditDecision } = await filePolicyApi();
  for (const context of [undefined, null, {}, { sage: true }, { chief: true }, { sage: "on", chief: true }]) {
    assert.throws(() => directEditDecision({ tool_name: "apply_patch" }, context));
  }
});


async function nativeModeFixture(t) {
  const { dir, plugin } = isolated(t, "codex");
  const api = await import(pathToFileURL(join(plugin, "runtime/mode.mjs")).href);
  const core = await import(pathToFileURL(join(plugin, "core/index.mjs")).href);
  const directory = join(dir, "admission"), projectDirectory = join(dir, "workspace"), sessionsDir = join(dir, "sessions");
  mkdirSync(projectDirectory); mkdirSync(sessionsDir);
  core.configureAdmission(directory, { total: 3, projects: [{ project: "one", limit: 3 }, { project: "two", limit: 3 }] });
  const session = "11111111-1111-4111-8111-111111111111";
  const transcript = join(sessionsDir, "root.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { id: session, session_id: session, cli_version: "0.160.0" } }) + "\n");
  const input = { hook_event_name: "UserPromptSubmit", session_id: session, turn_id: modeTurn, cwd: projectDirectory,
    transcript_path: transcript, model: "fixture", permission_mode: "default", prompt: "sage mode" };
  return { api, core, input, context: { version: "0.160.0", actor: session },
    options: { directory, project: "one", projectDirectory, sessionsDir } };
}

test("Codex mode adapter persists verified phrases and keeps autopilot disabled", async (t) => {
  const { api, core, input, context, options } = await nativeModeFixture(t);
  assert.equal(api.updateOwnerMode({ ...input, prompt: "What does sage mode do?" }, context, options).sage, false);
  assert.equal(core.readAdmission(options.directory).sessions.length, 0);
  // A near miss switches nothing and names the exact phrases (T240).
  const near = api.updateOwnerMode({ ...input, prompt: "sage mode, autopilot on" }, context, options);
  assert.deepEqual([near.sage, near.phrase, near.near], [false, null, { phrases: ["sage mode", "autopilot on"], strong: true }]);
  const active = api.updateOwnerMode({ ...input, prompt: "Autopilot On." }, context, options);
  assert.deepEqual([active.sage, active.autopilot, active.phrase], [false, false, "autopilot on"]);
  const on = api.updateOwnerMode({ ...input, prompt: "Sage Mode." }, context, options);
  assert.deepEqual([on.sage, on.autopilot, on.phrase], [true, false, "sage mode"]);
  assert.equal(api.updateOwnerMode({ ...input, turn_id: modeNextTurn, prompt: "continue" }, context, options).sage, true);
  assert.equal(api.updateOwnerMode({ ...input, turn_id: "44444444-4444-4444-8444-444444444444", prompt: "sage mode off" }, context, options).sage, false);
  assert.equal(api.readMode(options.directory, options.project, input.session_id).sage, false);
  assert.equal(core.readAdmission(options.directory).modes.length, 2);
});

test("Codex mode adapter never replays old activation or mode prompts over off", async (t) => {
  const { api, input, context, options } = await nativeModeFixture(t);
  api.updateOwnerMode(input, context, options);
  const on = { ...input, turn_id: modeNextTurn };
  api.updateOwnerMode(on, context, options);
  api.updateOwnerMode({ ...input, turn_id: "44444444-4444-4444-8444-444444444444", prompt: "sage mode off" }, context, options);
  assert.equal(api.updateOwnerMode(input, context, options).sage, false);
  assert.equal(api.updateOwnerMode(on, context, options).sage, false);
  assert.throws(() => api.updateOwnerMode({ ...input, prompt: "sage mode off" }, context, options), /different mode request/);
  assert.throws(() => api.updateOwnerMode({ ...on, prompt: "sage mode off" }, context, options), /different mode request/);
  assert.equal(api.readMode(options.directory, options.project, input.session_id).modes.length, 3);
});

test("Codex mode adapter requires exact project and native owner identity before writes", async (t) => {
  const { api, core, input, context, options } = await nativeModeFixture(t);
  for (const native of [null, { ...context, actor: modeTurn }, { ...context, version: "0.160.1" }]) {
    assert.equal(api.updateOwnerMode(input, native, options), null);
  }
  assert.equal(api.updateOwnerMode({ ...input, cwd: options.sessionsDir }, context, options), null);
  assert.equal(api.updateOwnerMode({ ...input, agent_id: input.session_id }, context, options), null);
  assert.equal(core.readAdmission(options.directory).sessions.length, 0);
  api.updateOwnerMode(input, context, options);
  assert.equal(core.readAdmission(options.directory).sessions[0].session, `codex:${input.session_id}`);
  assert.equal(api.readMode(options.directory, "two", input.session_id).sage, false);
  assert.throws(() => api.readMode(options.directory, "absent", input.session_id), /not configured/);
});

test("Codex mode adapter refuses damaged storage and foreign metadata", async (t) => {
  const { api, core, input, context, options } = await nativeModeFixture(t);
  writeFileSync(input.transcript_path, JSON.stringify({ type: "session_meta", payload: { id: modeNextTurn, session_id: modeNextTurn, cli_version: "0.160.0" } }) + "\n");
  assert.equal(api.updateOwnerMode(input, context, options), null);
  assert.equal(core.readAdmission(options.directory).sessions.length, 0);
  assert.throws(() => api.updateOwnerMode({ ...input, transcript_path: join(options.projectDirectory, "outside.jsonl") }, context, options));
  writeFileSync(join(options.directory, "00000000.json"), "broken");
  assert.throws(() => api.readMode(options.directory, options.project, input.session_id));
});


test("Codex mode adapter records an initial off so its retry cannot replace later on", async (t) => {
  const { api, core, input, context, options } = await nativeModeFixture(t);
  const off = { ...input, prompt: "sage mode off" };
  assert.equal(api.updateOwnerMode(off, context, options).sage, false);
  assert.equal(core.readAdmission(options.directory).modes.length, 1);
  const owner = core.readAdmission(options.directory).sessions[0];
  const initial = { project: owner.project, session: owner.session, activation: owner.activation };
  assert.throws(() => core.activateAdmission(options.directory, initial), /different initial mode/);
  assert.throws(() => core.activateAdmission(options.directory, initial, { sage: "off" }), /invalid initial mode/);
  assert.equal(api.updateOwnerMode({ ...input, turn_id: modeNextTurn }, context, options).sage, true);
  assert.equal(api.updateOwnerMode(off, context, options).sage, true);
  assert.equal(core.readAdmission(options.directory).modes.length, 2);
  assert.throws(() => api.updateOwnerMode(input, context, options), /different mode request/);
});


test("Codex bundles the MCP SDK with native identity and hidden tool metadata intact", async (t) => {
  const { dir, plugin } = isolated(t, "codex");
  assert.ok(existsSync(join(plugin, "runtime/mcp-sdk.mjs")));
  assert.equal(existsSync(join(dir, "node_modules")), false);
  const entry = join(dir, "server.mjs");
  writeFileSync(entry, `
    import { McpServer, serveStdio, z } from './plugin/runtime/mcp-sdk.mjs';
    serveStdio(() => {
      const server = new McpServer({ name: 'sage-test', version: '0.1.0' });
      server.registerTool('sage_native_hook', {
        inputSchema: z.object({}).passthrough(), _meta: { ui: { visibility: ['app'] } },
      }, async (input, context) => ({ content: [{ type: 'text', text: JSON.stringify({
        version: server.server.getClientVersion()?.version,
        actor: context.mcpReq._meta?.threadId, input,
      }) }] }));
      return server;
    });
  `);
  const child = spawn(process.execPath, [entry], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  let stderr = '', sequence = 0;
  const pending = new Map();
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    for (const { reject } of pending.values()) reject(Error('MCP server closed before its response'));
    resolve({ code, signal });
  }));
  child.once('error', error => { for (const { reject } of pending.values()) reject(error); });
  child.stderr.on('data', chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const message = JSON.parse(line);
      pending.get(message.id)?.resolve(message);
      pending.delete(message.id);
    } catch (error) {
      for (const { reject } of pending.values()) reject(error);
      child.stdin.end();
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    const init = await request('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex', version: '0.160.0' },
    });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const listed = await request('tools/list', {});
    assert.equal(listed.result.tools.length, 1);
    assert.deepEqual(listed.result.tools[0]._meta.ui.visibility, ['app']);
    const actor = 'd72422c7-509c-43aa-8c42-827c556f8a57';
    const input = { hook_event_name: 'PreToolUse', extra: { retained: true }, actor: 'forged', version: 'forged' };
    const called = await request('tools/call', { name: 'sage_native_hook', arguments: input, _meta: { threadId: actor } });
    assert.deepEqual(JSON.parse(called.result.content[0].text), { version: '0.160.0', actor, input });
    const absent = await request('tools/call', { name: 'sage_native_hook', arguments: input });
    assert.equal(Object.hasOwn(JSON.parse(absent.result.content[0].text), 'actor'), false);
  } finally {
    child.stdin.end();
    assert.deepEqual(await closed, { code: 0, signal: null });
    assert.equal(stderr, '');
  }
});

test("Codex includes each bundled MCP dependency license", (t) => {
  const { plugin } = isolated(t, "codex");
  for (const name of ['@modelcontextprotocol-server', '@modelcontextprotocol-core', 'zod',
    'content-type']) {
    const text = readFileSync(join(plugin, 'licenses', name + '.txt'), 'utf8');
    assert.match(text, name.startsWith('@modelcontextprotocol') ? /Apache License/ : /MIT|Permission is hereby granted/);
    assert.match(text, /[Cc]opyright/);
  }
});


async function nativeBindingFixture(t) {
  const f = await roleAdmissionFixture(t);
  const api = await import(new URL("../runtime/child-binding.mjs", f.url));
  const events = await import(new URL("../runtime/events.mjs", f.url));
  const observationsDirectory = join(f.journal, "..", "observations");
  const root = "11111111-1111-4111-8111-111111111111";
  const lead = "22222222-2222-4222-8222-222222222222";
  const child = "33333333-3333-4333-8333-333333333333";
  const owner = f.api.activateAdmission(f.journal, { project: f.scope.project, session: `codex:${root}`, activation: f.activation });
  const scope = { project: owner.project, session: owner.session, epoch: owner.epoch };
  const reserve = (index, role, issuerRole, issuer = root, name = `agent_${index}`, confirm = true, brief) => {
    const args = f.args(index, issuer, scope); args[3].name = name; args[3].tool = "collaborationspawn_agent";
    if (issuerRole === "lead") args[2].task = "T1";
    const assignment = (brief === undefined ? f.api.reserveRoleAdmission(...args, { issuerRole, role })
      : f.api.reserveBriefAdmission(...args, { issuerRole, role }, brief)).assignment;
    const base = { schema: 1, runtime: "0.160.0", session: root, actor: issuer, call: assignment.call, turn: f.activation };
    events.publish(observationsDirectory, { ...base, kind: "spawn-request", name });
    if (confirm) events.publish(observationsDirectory, { ...base, kind: "spawn-result", path: issuer === root ? `/root/${name}` : `/root/agent_1/${name}` });
    return assignment;
  };
  const identity = (id = lead, parent = root, path = "/root/agent_1") => ({ session: root, child: id, parent, path, turn: f.activation });
  const observeStart = value => events.publish(observationsDirectory, { schema: 1, runtime: "0.160.0", kind: "child-start", ...value });
  observeStart(identity());
  const bind = value => api.bindNativeChild({ directory: f.journal, project: scope.project, observationsDirectory }, value);
  return { ...f, root, lead, child, scope, reserve, identity, bind, observeStart, events, observationsDirectory };
}

test("native child binding connects a lead and its specialist to exact reserved roles", async t => {
  const f = await nativeBindingFixture(t);
  const lead = f.reserve(1, "lead", "chief-of-staff");
  assert.equal(f.bind(f.identity()).assignment.id, lead.id);
  const child = f.reserve(2, "qa", "lead", f.lead);
  const native = f.identity(f.child, f.lead, "/root/agent_1/agent_2");
  f.observeStart(native);
  const result = f.bind(native);
  assert.equal(result.role, "qa"); assert.equal(result.assignment.id, child.id);
  assert.equal(result.binding.issuer, f.lead);
  assert.equal(f.bind(native).decision, "already-bound");
  assert.equal(f.api.readAdmission(f.journal).bindings.length, 2);
});

test("native child binding rejects unadmitted children and inconsistent parent paths or roles", async t => {
  const f = await nativeBindingFixture(t);
  assert.throws(() => f.bind(f.identity()));
  f.reserve(1, "lead", "chief-of-staff");
  for (const change of [{ path: "/root/other" }, { parent: f.child }, { child: f.root },
    { turn: "invalid" }, { role: "lead" }, { session: f.child }]) {
    assert.throws(() => f.bind({ ...f.identity(), ...change }));
  }
  f.bind(f.identity());
  // A trusted caller still cannot bind an inconsistent recorded issuer role.
  f.reserve(2, "qa", "chief-of-staff", f.lead);
  f.observeStart(f.identity(f.child, f.lead, "/root/agent_1/agent_2"));
  assert.throws(() => f.bind(f.identity(f.child, f.lead, "/root/agent_1/agent_2")));
  f.reserve(3, "qa", "lead", f.lead);
  assert.throws(() => f.bind(f.identity(f.child, f.lead, "/root/agent_3")));
  assert.equal(f.api.readAdmission(f.journal).bindings.length, 1);
});

test("native child binding refuses a reservation for another dispatch tool", async t => {
  const f = await nativeBindingFixture(t);
  const args = f.args(1, f.root, f.scope); args[3].name = "agent_1"; args[3].tool = "collaborationfollowup_task";
  f.api.reserveRoleAdmission(...args, { issuerRole: "chief-of-staff", role: "lead" });
  const base = { schema: 1, runtime: "0.160.0", session: f.root, actor: f.root, call: "spawn-1", turn: f.activation };
  f.events.publish(f.observationsDirectory, { ...base, kind: "spawn-request", name: "agent_1" });
  f.events.publish(f.observationsDirectory, { ...base, kind: "spawn-result", path: "/root/agent_1" });
  assert.throws(() => f.bind(f.identity()));
  assert.deepEqual(f.api.readAdmission(f.journal).bindings, []);
});


test("native child binding refuses a failed reservation later matched by an unadmitted spawn", async t => {
  const f = await nativeBindingFixture(t);
  f.reserve(1, "lead", "chief-of-staff", f.root, "agent_1", false);
  assert.throws(() => f.bind(f.identity()), /could not bind/);
  const base = { schema: 1, runtime: "0.160.0", session: f.root, actor: f.root, call: "unadmitted", turn: f.activation };
  f.events.publish(f.observationsDirectory, { ...base, kind: "spawn-request", name: "agent_1" });
  f.events.publish(f.observationsDirectory, { ...base, kind: "spawn-result", path: "/root/agent_1" });
  assert.throws(() => f.bind(f.identity()), /could not bind/);
  assert.deepEqual(f.api.readAdmission(f.journal).bindings, []);
});

test("native child binding refuses conflicting path reuse and a result from another parent turn", async t => {
  const f = await nativeBindingFixture(t);
  f.reserve(1, "lead", "chief-of-staff");
  f.observeStart(f.identity(f.child));
  assert.throws(() => f.bind(f.identity()), /could not bind/);
  assert.deepEqual(f.api.readAdmission(f.journal).bindings, []);
  const other = await nativeBindingFixture(t);
  other.reserve(1, "lead", "chief-of-staff", other.root, "agent_1", false);
  other.events.publish(other.observationsDirectory, { schema: 1, runtime: "0.160.0", session: other.root,
    actor: other.root, call: "spawn-1", turn: "99999999-9999-4999-8999-999999999999", kind: "spawn-result", path: "/root/agent_1" });
  assert.throws(() => other.bind(other.identity()), /could not bind/);
  assert.deepEqual(other.api.readAdmission(other.journal).bindings, []);
});

test("native child binding refuses a reused name before the later spawn result arrives", async t => {
  const f = await nativeBindingFixture(t); f.reserve(1, "lead", "chief-of-staff");
  f.events.publish(f.observationsDirectory, { schema: 1, runtime: "0.160.0", session: f.root, actor: f.root,
    call: "later-call", turn: f.activation, kind: "spawn-request", name: "agent_1" });
  assert.throws(() => f.bind(f.identity()), /could not bind/);
  assert.deepEqual(f.api.readAdmission(f.journal).bindings, []);
});


test("brief admission returns the saved instructions with the verified native binding", async t => {
  const f = await nativeBindingFixture(t); const brief = completeBrief("Deliver these saved instructions.");
  f.reserve(1, "lead", "chief-of-staff", f.root, "agent_1", true, brief);
  const result = f.bind(f.identity());
  assert.equal(result.role, "lead"); assert.deepEqual(result.brief, brief);
  assert(f.api.renderBrief(result.brief).includes("GOAL\nDeliver these saved instructions."));
  assert.deepEqual(f.bind(f.identity()).brief, brief);
});


async function roleInstructionsFixture(t, provider = "codex") {
  const f = isolated(t, provider);
  const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
  assert.equal(typeof api.renderRoleInstructions, "function", "shared role instructions must ship in core");
  const bindings = JSON.parse(readFileSync(join(f.plugin, "role-bindings.json"), "utf8"));
  for (const role of Object.keys(bindings).filter(key => !["common", "report"].includes(key))) {
    bindings[role] = { ...bindings.common, ...bindings[role] };
  }
  return { ...f, api, bindings };
}

test("shared role instructions ship outside the checkout and generate existing specialist bodies", async t => {
  const roles = ["implementer", "pe", "designer", "arena-judge", "code-reviewer", "security-reviewer", "ux-reviewer", "qa"];
  for (const provider of ["claude", "codex"]) {
    const f = await roleInstructionsFixture(t, provider);
    for (const role of [...roles, "lead"]) {
      const text = f.api.renderRoleInstructions(role, f.bindings[role] ?? {});
      assert(text.startsWith("# "));
      assert.match(text, /report/);
      if (provider === "codex") {
        assert.doesNotMatch(text, /sage:report/);
        assert.match(text, /report format included below/);
      }
      assert.doesNotMatch(text, /\{\{|sage-core-role/);
      if (provider === "claude" && role !== "lead") {
        const body = readFileSync(join(f.plugin, "agents", `${role}.md`), "utf8").split("\n---\n")[1].trim();
        assert.equal(body, text);
      }
    }
    const qa = f.api.renderRoleInstructions("qa", f.bindings.qa);
    assert.match(qa, /You do not fix anything/);
    assert.match(qa, /PASS or FAIL/);
    const lead = f.api.renderRoleInstructions("lead", f.bindings.lead);
    assert.match(lead, /at most nine children/);
    assert.match(lead, /code review for every change/);
    assert.match(lead, /fresh lead after/);
  }
});

test("shared role instructions require exact packaged provider bindings and refuse unknown roles", async t => {
  const f = await roleInstructionsFixture(t);
  for (const role of ["chief-of-staff", "../state", "report", null, {}, "unknown"]) assert.throws(() => f.api.renderRoleInstructions(role), /Unknown child role/);
  for (const bindings of [{}, null, [], { ...f.bindings.implementer, EXTRA: "wrong" },
    { ...f.bindings.implementer, DELIVERY_STEP: "" }, { ...f.bindings.implementer, DELIVERY_STEP: "{{UNKNOWN}}" },
    Object.create(f.bindings.implementer)]) assert.throws(() => f.api.renderRoleInstructions("implementer", bindings), /exact provider bindings/);
  const text = f.api.renderRoleInstructions("implementer", f.bindings.implementer);
  assert.match(text, /Never run `gh`/);
  assert.match(text, /The chief handles the pull request/);
  assert.doesNotMatch(text, /\.claude|CLAUDE\.md|gh pr create/);
});

test("shared role report keeps every field and separates the provider's gate statement", async t => {
  const f = await roleInstructionsFixture(t);
  const report = f.api.renderReportInstructions(f.bindings.report);
  const fields = /```\n([\s\S]*?)```/.exec(report)[1].trim().split("\n").map(line => line.split(/\s{2,}/)[0]);
  assert.deepEqual(fields, ["STATUS", "RESULT", "EVIDENCE", "FINDINGS", "QUESTIONS", "NOT VERIFIED", "BRANCH"]);
  assert.doesNotMatch(report, /hook does not let you finish/);
  const claude = await roleInstructionsFixture(t, "claude");
  assert.equal(readFileSync(join(claude.plugin, "skills/report/SKILL.md"), "utf8").split("\n---\n")[1].trim(),
    claude.api.renderReportInstructions(claude.bindings.report));
  assert.throws(() => f.api.renderReportInstructions({}), /exact provider bindings/);
});

test("shared role delivery joins verified lead and QA instructions with their own saved briefs", async t => {
  const instructions = await roleInstructionsFixture(t);
  const f = await nativeBindingFixture(t);
  const { boundChildInstructions } = await import(new URL("../runtime/instructions.mjs", f.url));
  const options = { directory: f.journal, project: f.scope.project, observationsDirectory: f.observationsDirectory };
  const lead = f.reserve(1, "lead", "chief-of-staff", f.root, "agent_1", true, completeBrief("Lead the task."));
  const first = boundChildInstructions(options, f.identity());
  assert.equal(first.decision, "deliver");
  assert(first.brief.includes(`Role: lead\nAssignment: ${lead.id}\nTask: T1\nRun: R1`));
  assert(first.brief.includes(f.api.renderRoleInstructions("lead", instructions.bindings.lead)));
  assert(first.brief.includes(f.api.renderBrief(completeBrief("Lead the task."))));
  const qa = f.reserve(2, "qa", "lead", f.lead, "agent_2", true, completeBrief("Check the task."));
  const identity = f.identity(f.child, f.lead, "/root/agent_1/agent_2"); f.observeStart(identity);
  const second = boundChildInstructions(options, identity);
  assert(second.brief.includes(`Role: qa\nAssignment: ${qa.id}\nTask: T1\nRun: R2`));
  assert(second.brief.includes(f.api.renderRoleInstructions("qa", instructions.bindings.qa)));
  assert(second.brief.includes("NOT VERIFIED"));
  assert(second.brief.includes(f.api.renderBrief(completeBrief("Check the task."))));
  assert.doesNotMatch(second.brief, /Lead the task/);
  assert.deepEqual(boundChildInstructions(options, identity), second);
  assert.throws(() => boundChildInstructions(options, { ...identity, path: "/root/other" }));
});

test("shared role delivery refuses absent saved briefs and missing instruction assets", async t => {
  const instructions = await roleInstructionsFixture(t);
  const f = await nativeBindingFixture(t);
  const { boundChildInstructions } = await import(new URL("../runtime/instructions.mjs", f.url));
  const options = { directory: f.journal, project: f.scope.project, observationsDirectory: f.observationsDirectory };
  f.reserve(1, "lead", "chief-of-staff");
  assert.throws(() => boundChildInstructions(options, f.identity()), /no saved task brief/);
  const other = await nativeBindingFixture(t);
  const api = await import(new URL("../runtime/instructions.mjs", other.url));
  other.reserve(1, "lead", "chief-of-staff", other.root, "agent_1", true, completeBrief("Preserve this task."));
  rmSync(new URL("./roles/lead.md", other.url));
  assert.throws(() => api.boundChildInstructions({ directory: other.journal, project: other.scope.project,
    observationsDirectory: other.observationsDirectory }, other.identity()));
  assert.equal(other.api.readAdmission(other.journal).reservations.length, 1, "an instruction error does not release capacity");
});

test("shared chief instructions preserve the packaged agent and every brief field", async t => {
  const f = isolated(t, "claude");
  const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
  assert.equal(typeof api.renderChiefInstructions, "function");
  const bindings = JSON.parse(readFileSync(join(f.plugin, "chief-bindings.json"), "utf8"));
  const text = api.renderChiefInstructions(bindings);
  const agent = readFileSync(join(f.plugin, "agents/chief-of-staff.md"), "utf8");
  assert.equal(agent.split("\n---\n")[1].trim(), text);
  const fields = /```\n(GOAL[\s\S]*?)```/.exec(text)[1].trim().split("\n").map(line => line.split(/\s{2,}/)[0]);
  assert.deepEqual(fields, api.BRIEF_FIELDS);
  // The chief has every tool, so the off phrase gives a full normal session; the sage hook refuses its edits (T398).
  assert.doesNotMatch(agent.split("\n---\n")[0], /^(?:tools|disallowedTools):/m);
  assert.match(agent.split("\n---\n")[0], /^skills:\n {2}- sage:sage$/m);
  assert.match(text, /The hook refuses a brief without them/);
  assert.match(text, /model sonnet/);
});

test("shared chief Codex instructions keep unsupported routes inactive, and merge only by autopilot through the plugin's hook", async t => {
  const f = isolated(t, "codex");
  const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
  assert.equal(typeof api.renderChiefInstructions, "function");
  const bindings = JSON.parse(readFileSync(join(f.plugin, "chief-bindings.json"), "utf8"));
  const text = api.renderChiefInstructions(bindings);
  const prepared = readFileSync(join(f.plugin, "runtime/chief-instructions.md"), "utf8");
  assert(prepared.endsWith(text + "\n"));
  assert.match(prepared, /prepared native adapter renders these shared rules on verified owner\s+activation and restores them after supported native compaction/);
  assert.match(prepared, /installed manual preview does not load this automatic chief role/);
  assert.match(prepared, /Full automatic Sage remains disabled/);
  assert.match(text, /you start every agent yourself, and you do the lead's work/);
  assert.match(text, /a tiny task goes to an implementer/);
  assert.match(text, /call `spawn_agent` in the `collaboration` namespace/);
  assert.match(text, /`fork_turns: "none"`/);
  assert.doesNotMatch(text, /sage_prepare_task|admission|preparation/i);
  assert.match(text, /PE and designer use the public skill-led helper/);
  assert.match(text, /Arena candidates and arena-judge remain unavailable/);
  assert.match(text, /installed acceptance/);
  assert.match(text, /Autopilot off:\*\* the user merges\. Never push to main, force-push/);
  assert.match(text, /The plugin's hook allows only this exact command when the merge check passes/);
  assert.match(text, /state tool checks at least one cycle/);
  assert.doesNotMatch(text, /CLAUDE\.md|~\/workspace|\.claude|sage:report|model fable|opus|sonnet|gh api|gate G15|\{\{|sage-core-chief/);
  // Rendering this document must not register the chief as an admitted child role.
  assert.throws(() => api.renderRoleInstructions("chief-of-staff", bindings), /Unknown child role/);
});

test("shared chief instructions reject incomplete or substituted provider bindings", async t => {
  const f = isolated(t, "codex");
  const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
  assert.equal(typeof api.renderChiefInstructions, "function");
  const bindings = JSON.parse(readFileSync(join(f.plugin, "chief-bindings.json"), "utf8"));
  for (const invalid of [{}, null, [], Object.create(bindings), { ...bindings, EXTRA: "value" },
    { ...bindings, DISPATCH: "" }, { ...bindings, TEAM: "{{TASK}}" }, { ...bindings, TEAM: "bad\0text" }]) {
    assert.throws(() => api.renderChiefInstructions(invalid), /exact provider bindings/);
  }
});


test("package boundaries allow public core imports and reject reverse private and cross-provider imports", async t => {
  const module = join(ROOT, "scripts/package-boundaries.mjs");
  assert.ok(existsSync(module), "package boundaries must have an executable check");
  const { packageBoundaryProblems } = await import(pathToFileURL(module));
  const f = isolated(t, "codex");
  for (const name of ["sage-core", "sage-claude", "sage-codex"]) {
    mkdirSync(join(f.dir, "packages", name), { recursive: true });
    writeFileSync(join(f.dir, "packages", name, "index.mjs"), "export const value = 1;\n");
  }
  const write = (name, text) => writeFileSync(join(f.dir, "packages", name, "index.mjs"), text);
  write("sage-claude", "export { value } from 'sage-core';");
  write("sage-codex", "export { value } from 'sage-core';");
  assert.deepEqual(packageBoundaryProblems(f.dir), []);
  for (const [name, text] of [
    ["sage-core", "export { value } from '../sage-codex/index.mjs';"],
    ["sage-codex", "export { value } from '../sage-core/index.mjs';"],
    ["sage-codex", "export { value } from 'sage-core/state.mjs';"],
    ["sage-codex", "export { value } from '../sage-claude/index.mjs';"],
    ["sage-claude", "export const value = import('sage-codex');"],
    ["sage-claude", "export const value = require('sage-core/private.mjs');"],
    ["sage-claude", "export const value = require('sage-core');"],
    ["sage-claude", "export const value = import('file:///tmp/other-package.mjs').catch(() => null);"],
  ]) {
    write(name, text);
    assert.ok(packageBoundaryProblems(f.dir).length > 0, `${name}: ${text}`);
    write(name, "export const value = 1;\n");
  }
  assert.equal(existsSync(join(f.dir, ".package-boundary-check")), false);
  assert.deepEqual(packageBoundaryProblems(ROOT), []);
});

test("package public imports package both quote styles and dynamic imports outside the checkout", async t => {
  const module = join(ROOT, "scripts/package-imports.mjs");
  assert.ok(existsSync(module), "packaging must parse public imports rather than replace one spelling");
  const { rewriteCoreImports } = await import(pathToFileURL(module));
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const original = [
      "import { shellCommands } from 'sage-core';",
      'export { programsRun } from "sage-core";',
      "export const loaded = import('sage-core');",
      'export const data = \'from "sage-core"\';',
      '// import { notCode } from "sage-core";',
      "export const words = shellCommands('echo fixture')[0].words;",
    ].join("\n");
    const rewritten = rewriteCoreImports(original, "./core/index.mjs");
    assert.match(rewritten, /from "sage-core"/); // Text data and comments remain unchanged.
    const entry = join(f.plugin, "import-fixture.mjs"); writeFileSync(entry, rewritten);
    const result = await import(pathToFileURL(entry));
    assert.deepEqual(result.words, ["echo", "fixture"]);
    assert.equal(typeof result.programsRun, "function");
    assert.equal(typeof (await result.loaded).shellCommands, "function");
    assert.equal(result.data, 'from "sage-core"');
    const escaped = 'export { shellCommands } from "sage-\\u0063ore";';
    assert.equal(rewriteCoreImports(escaped, "./core/index.mjs"), 'export { shellCommands } from "./core/index.mjs";');
  }
});


test("a missing shared file policy still refuses active chief edits without disabling the hook", async (t) => {
  const { dir, plugin } = isolated(t, "claude");
  rmSync(join(plugin, "hooks/file-policy.mjs"), { force: true });
  const { handle: check } = await import(pathToFileURL(join(plugin, "hooks/sage-hook.mjs")).href);
  const input = { hook_event_name: "PreToolUse", tool_name: "Edit", session_id: "fixture", cwd: dir, tool_input: { file_path: join(dir, "sample.txt") } };
  const result = check(input, { sage: true }, {});
  assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /file policy cannot load/);
  assert.equal(check(input, { sage: false }, {}), undefined);
});

test("missing shared mode policy cannot enable mode or retain autopilot", async (t) => {
  const { dir, plugin } = isolated(t, "claude");
  rmSync(join(plugin, "hooks/mode-policy.mjs"), { force: true });
  const { handle: check } = await import(pathToFileURL(join(plugin, "hooks/sage-hook.mjs")).href);
  for (const sage of [false, true]) {
    const state = { sage, autopilot: true };
    const result = check({ hook_event_name: "UserPromptSubmit", session_id: "fixture", cwd: dir, prompt: "sage mode" }, state, {});
    assert.equal(state.sage, sage); assert.equal(state.autopilot, false);
    assert.match(JSON.stringify(result), /mode policy cannot load/);
  }
});

test("shared command reader preserves substitutions pipelines and heredoc structure in both bundles", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    assert.equal(typeof api.shellCommands, "function");
    const text = 'printf "%s" "$(git status)" | cat >out\ncat <<\'END\'\n$(not-a-command)\nEND\n';
    const rows = api.shellCommands(text);
    assert.deepEqual(rows.map(row => row.words), [["git", "status"], ["printf", "%s", "$(…)"], ["cat"], ["cat"]]);
    assert.equal(rows[0].host.cmd, rows[1]);
    assert.equal(rows[0].host.index, 2);
    assert.equal(rows[1].pipeTo, rows[2]);
    assert.deepEqual(rows[2].redirects, [">out"]);
    assert.deepEqual(rows[3].bodies, ["$(not-a-command)"]);
    for (const broken of ["echo 'open", "cat <<END\nmissing", "echo $(git status", "case x in a) echo hi"]) {
      assert.throws(() => api.shellCommands(broken));
    }
    if (provider === "claude") {
      const hook = await import(pathToFileURL(join(f.plugin, "hooks/sage-hook.mjs")));
      assert.deepEqual(hook.shellCommands(text), rows);
    }
  }
});

test("shared command reader resolves fake program paths without running them", async t => {
  const { chmodSync } = await import("node:fs");
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    assert.equal(typeof api.programsRun, "function");
    const bin = join(f.dir, "bin"); mkdirSync(bin);
    for (const name of ["ps", "kill"]) { writeFileSync(join(bin, name), "fixture data, never executed"); chmodSync(join(bin, name), 0o700); }
    const text = "env ps -ax; kill 123; env kill 123; sh -c 'ps -ef'";
    const rows = api.programsRun(text, f.dir, bin);
    assert.deepEqual(rows.map(row => row.word), ["ps", "kill", "kill", "sh", "ps"]);
    assert.deepEqual(rows.map(row => row.file), [join(bin, "ps"), undefined, join(bin, "kill"), undefined, join(bin, "ps")]);
    assert.deepEqual(rows[0].args, ["-ax"]);
    if (provider === "claude") {
      const hook = await import(pathToFileURL(join(f.plugin, "hooks/sage-hook.mjs")));
      assert.deepEqual(hook.programsRun(text, f.dir, bin), rows);
    }
  }
});

test("shared command policy classifies merge candidates and executable text in both isolated providers", async t => {
  const sha = "a".repeat(40);
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    assert.equal(typeof api.createCommandPolicy, "function");
    const tool = join(f.plugin, "skills/sage/sage.mjs");
    const adapter = await import(pathToFileURL(join(f.plugin, provider === "claude" ? "hooks/command-policy.mjs" : "runtime/command-policy.mjs")));
    const policy = adapter.createCommandPolicy({ stateToolPath: tool });
    const candidate = `gh pr merge 12 --squash --delete-branch --match-head-commit ${sha}`;
    assert.deepEqual(policy.mergeIn(candidate), { pr: "12", sha });
    for (const text of [candidate.replace(" 12 ", " 012 "), candidate.replace(sha, "abc"), `${candidate} --admin`,
      `sh -c '${candidate}'`, `echo '${candidate}' | sh`, `echo '${candidate}' > run; sh run`,
      "gh api repos/o/r/pulls/12/merge", "gh pr 'merge", "$(echo gh) pr merge 12"]) {
      assert.equal(typeof policy.mergeIn(text)?.problem, "string", text);
    }
    for (const text of ["git status", "git merge topic", `echo '${candidate}'`, `echo '${candidate}' | head -1`,
      `node '${tool}' log --why '${candidate}'`]) assert.equal(policy.mergeIn(text), undefined, text);
    assert.ok(api.createCommandPolicy().mergeIn(`node '${tool}' log --why '${candidate}'`)?.problem);
    assert.ok(policy.mergeIn(`node '/other/sage.mjs' log --why '${candidate}'`)?.problem);
    const rows = policy.runnable(api.shellCommands(`echo 'git push origin main'; git push origin topic`));
    assert.deepEqual(rows.map(row => row.words), [["echo"], ["git", "push", "origin", "topic"]]);
    if (provider === "claude") {
      const hook = await import(pathToFileURL(join(f.plugin, "hooks/sage-hook.mjs")));
      assert.deepEqual(hook.mergeIn(candidate), policy.mergeIn(candidate));
      assert.equal(hook.mergeIn(`node '${tool}' log --why '${candidate}'`), undefined);
    }
  }
});

test("shared command policy rejects invalid trusted paths and snapshots its binding", async t => {
  const f = isolated(t, "codex");
  const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
  assert.equal(typeof api.createCommandPolicy, "function");
  for (const path of [null, 1, "", "relative/sage.mjs", "/tmp/bad\npath", "/tmp/bad\0path"]) {
    assert.throws(() => api.createCommandPolicy({ stateToolPath: path }), /absolute path/);
  }
  const binding = { stateToolPath: join(f.dir, "sage.mjs") };
  const original = binding.stateToolPath;
  const policy = api.createCommandPolicy(binding);
  binding.stateToolPath = "/other/sage.mjs";
  assert.equal(policy.mergeIn(`node '${original}' log --why 'gh pr merge'`), undefined);
  assert.ok(policy.mergeIn(`node '${binding.stateToolPath}' log --why 'gh pr merge'`)?.problem);
});

test("shared command policy failures deny recognized Claude command tools before native handling", async t => {
  for (const missing of ["hooks/command-policy.mjs", "core/command-policy.mjs", "invalid-path"]) {
    const f = isolated(t, "claude");
    assert.ok(existsSync(join(f.plugin, "hooks/command-policy.mjs")));
    if (missing === "invalid-path") {
      const odd = join(f.dir, "plugin\tpath");
      cpSync(f.plugin, odd, { recursive: true });
      f.plugin = odd;
    } else {
      assert.ok(existsSync(join(f.plugin, missing)));
      rmSync(join(f.plugin, missing));
    }
    const hook = await import(pathToFileURL(join(f.plugin, "hooks/sage-hook.mjs")));
    for (const sage of [false, true]) for (const tool_name of ["Bash", "Monitor", "PowerShell", "mcp__terminal__run"]) {
      for (const actor of [{}, { agent_id: "fixture-child" }]) {
        const output = hook.handle({ hook_event_name: "PreToolUse", tool_name,
          tool_input: { command: "echo fixture" }, ...actor }, { sage }, {});
        assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
      }
    }
    assert.ok(hook.mergeIn("gh pr merge 1")?.problem);
  }
});

test("shared push policy applies the same branch and force rules in both isolated providers", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    assert.equal(typeof api.createPushPolicy, "function");
    const adapter = await import(pathToFileURL(join(f.plugin, provider === "claude" ? "hooks/command-policy.mjs" : "runtime/command-policy.mjs")));
    const calls = [];
    let branch = "topic";
    const policy = adapter.createPushPolicy({ readGh: fakeGh, readGit: fakeGit(dir => { calls.push(dir); return branch; }) });
    for (const text of ["git push origin topic", "git push -u --follow-tags origin topic", "git push --delete origin topic",
      "echo 'git push origin main'", "git status"]) assert.equal(policy.pushProblem(text, f.dir), undefined, text);
    for (const text of ["git push origin main", "git push origin refs/heads/master", "git push origin topic:main",
      "git push -f origin topic", "git push --force-with-lease origin topic", "git push --forc origin topic",
      "git push --mirror origin", "git push origin HEAD", "git push origin", "git push upstream topic",
      "git push origin '$BRANCH'", "sudo git push origin topic", "sh -c 'git push origin topic'",
      "echo 'git push origin main' | sh", "git push 'origin", "gh api repos/o/r/git/refs -f ref=refs/heads/main"]) {
      const before = calls.length;
      assert.equal(typeof policy.pushProblem(text, f.dir), "string", text);
      assert.equal(calls.length, before, "invalid forms must not query a checkout");
    }
    branch = "main";
    assert.match(policy.pushProblem("git push origin topic", f.dir), /checkout is on main/);
    assert.equal(policy.pushProblem("git push --delete origin topic", f.dir), undefined);
    assert.doesNotMatch(policy.pushProblem("git push origin main", f.dir), /first creation|asks the user/);
    assert.equal(api.gitSubcommand(["-C", "folder", "-c", "x=y", "stash", "list"], 0), "stash");
  }
});

test("shared push policy derives checkout paths and scopes the state-tool text exception", async t => {
  const f = isolated(t, "codex");
  const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
  assert.equal(typeof api.createPushPolicy, "function");
  const tool = join(f.dir, "sage.mjs");
  const calls = [];
  const policy = api.createPushPolicy({ stateToolPath: tool, readGh: fakeGh, readGit: fakeGit(dir => { calls.push(dir); return "topic"; }) });
  assert.equal(policy.pushProblem("cd project; git -C nested push origin topic", f.dir), undefined);
  assert.deepEqual(calls, [join(f.dir, "project/nested")]);
  assert.equal(policy.pushProblem(`node '${tool}' log --why 'git push origin main'`, f.dir), undefined);
  assert.ok(policy.pushProblem("node /other/sage.mjs log --why 'git push origin main'", f.dir));
  assert.deepEqual(calls, [join(f.dir, "project/nested")]);
});

test("shared push policy validates and snapshots trusted branch readers and messages", async t => {
  const f = isolated(t, "codex");
  const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
  assert.equal(typeof api.createPushPolicy, "function");
  assert.throws(() => api.createPushPolicy(), /readGit/);
  assert.throws(() => api.createPushPolicy({ readGit: fakeGit("topic") }), /readGh/);
  for (const value of [null, 7, Promise.resolve("main")]) {
    assert.throws(() => api.createPushPolicy({ readGit: fakeGit("topic"), readGh: () => value }).pushProblem("git push origin topic", f.dir), /readGh/);
  }
  // The repository of a remote URL, in the forms git writes, and nothing for another host.
  assert.deepEqual(["https://github.com/acme/site.git", "git@github.com:acme/site", "ssh://git@github.com/acme/site.git", "https://gitlab.com/acme/site", "https://github.com/acme/../x", "../site.git",
    // R1949-2: a user in the URL, a capital host and ssh.github.com:443 name the same repository; an ssh host alias does not.
    "https://someone@GitHub.com/acme/site", "ssh://git@ssh.github.com:443/acme/site.git", "git@GITHUB.COM:acme/site.git", "github-work:acme/site", "https://github.com.evil.test/acme/site"].map(api.gitHubRepository),
    ["acme/site", "acme/site", "acme/site", undefined, undefined, undefined, "acme/site", "acme/site", "acme/site", undefined, undefined]);
  // R1971-2: a ?, # or % in the user part makes the part before it the host, so the URL is not GitHub's.
  assert.deepEqual(["https://evil.example?@github.com/acme/site", "https://evil.example#@github.com/acme/site", "https://evil%2eexample@github.com/acme/site",
    "ssh://evil.example?@github.com/acme/site", "evil?x@github.com:acme/site"].map(api.gitHubRepository), [undefined, undefined, undefined, undefined, undefined]);
  for (const mainReason of [null, "", " ", "bad\nmessage", "x".repeat(2049)]) {
    assert.throws(() => api.createPushPolicy({ readGh: fakeGh, readGit: fakeGit("topic"), mainReason }), /mainReason/);
  }
  const options = { readGh: fakeGh, readGit: fakeGit("main"), mainReason: "Use a reviewed pull request." };
  const policy = api.createPushPolicy(options);
  options.readGit = fakeGit("topic"); options.mainReason = "changed";
  assert.match(policy.pushProblem("git push origin topic", f.dir), /checkout is on main/);
  assert.match(policy.pushProblem("git push origin main", f.dir), /Use a reviewed pull request/);
  for (const value of [null, "", " ", "topic\tname", "topic\0name", true, Promise.resolve("topic")]) {
    assert.throws(() => api.createPushPolicy({ readGh: fakeGh, readGit: fakeGit(value) }).pushProblem("git push origin topic", f.dir), /readGit/);
  }
  // git ends its output with a line break; the policy reads the name without it.
  for (const value of ["main\n", "master\r\n"]) assert.match(api.createPushPolicy({ readGh: fakeGh, readGit: fakeGit(value) }).pushProblem("git push origin topic", f.dir), /checkout is on ma/);
  // Git permits Unicode spaces inside branch names. These strings reach the parser, never a shell.
  for (const value of ["topic\u00a0name", "topic\u2003name"]) {
    assert.equal(execFileSync("git", ["check-ref-format", "--branch", value], { encoding: "utf8" }).trimEnd(), value);
    assert.equal(api.createPushPolicy({ readGh: fakeGh, readGit: fakeGit(value) }).pushProblem(`git push origin '${value}'`, f.dir), undefined);
  }
  const broken = api.createPushPolicy({ readGh: fakeGh, readGit: () => { throw new Error("fixture read failure"); } });
  assert.throws(() => broken.pushProblem("git push origin topic", f.dir), /fixture read failure/);
  // Preserve the existing Claude rule; Codex can require its reader to throw on missing evidence.
  assert.equal(api.createPushPolicy({ readGh: fakeGh, readGit: fakeGit(undefined) }).pushProblem("git push origin topic", f.dir), undefined);
});

test("shared push policy loading failures deny Claude command tools", async t => {
  const f = isolated(t, "claude");
  const path = join(f.plugin, "core/push-policy.mjs");
  assert.ok(existsSync(path)); rmSync(path);
  const hook = await import(pathToFileURL(join(f.plugin, "hooks/sage-hook.mjs")));
  for (const sage of [false, true]) for (const tool_name of ["Bash", "Monitor", "PowerShell", "mcp__terminal__run"]) {
    for (const actor of [{}, { agent_id: "fixture-child" }]) {
      const output = hook.handle({ hook_event_name: "PreToolUse", tool_name,
        tool_input: { command: "git push origin topic" }, ...actor }, { sage }, {});
      assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
    }
  }
});

test("Codex advice refuses linked or public state directories and cannot overwrite a linked target", t => {
  const { dir, plugin } = isolated(t, "codex");
  const event = { session_id: "safe-state", hook_event_name: "UserPromptSubmit", prompt: "Design a schema" };
  const base = join(dir, "state"), outside = join(dir, "outside");
  mkdirSync(outside, { mode: 0o700 });
  const run = () => spawnSync(process.execPath, [join(plugin, "hooks/principles-hook.mjs")], {
    env: { ...process.env, AGENT_KIT_HOOKS_STATE: base }, input: JSON.stringify(event), encoding: "utf8",
  });
  symlinkSync(outside, base, "dir");
  assert.equal(run().stdout, "");
  assert.equal(existsSync(join(outside, "codex")), false);
  rmSync(base); mkdirSync(base, { mode: 0o700 });
  symlinkSync(outside, join(base, "codex"), "dir");
  assert.equal(run().stdout, "");
  assert.equal(existsSync(join(outside, `${stateKey(event)}.json`)), false);
  rmSync(join(base, "codex")); mkdirSync(join(base, "codex"), { mode: 0o700 });
  chmodSync(base, 0o777);
  assert.equal(run().stdout, "");
  chmodSync(base, 0o700);
  const shared = join(dir, "shared"); mkdirSync(shared); chmodSync(shared, 0o777);
  const redirected = spawnSync(process.execPath, [join(plugin, "hooks/principles-hook.mjs")], {
    env: { ...process.env, AGENT_KIT_HOOKS_STATE: join(shared, "state") }, input: JSON.stringify(event), encoding: "utf8",
  });
  assert.equal(redirected.stdout, "");
  assert.equal(existsSync(join(shared, "state")), false, "a shared nonsticky parent can rename a private child");
  const target = join(outside, "keep.json");
  const original = JSON.stringify({ given: ["exhaust-the-design-space"], failures: {}, marker: "unchanged" });
  writeFileSync(target, original);
  const file = join(base, "codex", `${stateKey(event)}.json`);
  symlinkSync(target, file);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(context(JSON.parse(result.stdout)), /Exhaust the design space/);
  assert.equal(readFileSync(target, "utf8"), original);
  assert.equal(lstatSync(file).isSymbolicLink(), false);
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  assert.equal(run().stdout, "", "the private replacement preserves advice deduplication");
});


test("Codex advice defaults to a private Codex home instead of the shared temp folder", t => {
  const { dir, plugin } = isolated(t, "codex");
  const codexHome = join(dir, "codex-home"); mkdirSync(codexHome, { mode: 0o700 });
  const event = { session_id: "private-default", hook_event_name: "UserPromptSubmit", prompt: "Design a schema" };
  const temporary = join(dir, "temporary"); mkdirSync(temporary, { mode: 0o700 });
  const env = { ...process.env, HOME: dir, CODEX_HOME: codexHome, TMPDIR: temporary };
  delete env.AGENT_KIT_HOOKS_STATE;
  const result = spawnSync(process.execPath, [join(plugin, "hooks/principles-hook.mjs")], {
    env, input: JSON.stringify(event), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout);
  const file = join(codexHome, "advice", "codex", `${stateKey(event)}.json`);
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  assert.equal(lstatSync(dirname(file)).mode & 0o777, 0o700);
  assert.equal(lstatSync(dirname(dirname(file))).mode & 0o777, 0o700);
});

test("Codex advice refuses state below a foreign-owned ancestor even when its mode looks safe", t => {
  const { dir, plugin } = isolated(t, "codex");
  const event = { session_id: "foreign-parent", hook_event_name: "UserPromptSubmit", prompt: "Design a schema" };
  for (const mode of [0o755, 0o1777]) for (const nested of [false, true]) {
    const foreign = join(dir, `foreign-${mode}-${nested}`); mkdirSync(foreign, { mode });
    const parent = nested ? join(foreign, "owned-child") : foreign;
    if (nested) mkdirSync(parent, { mode: 0o700 });
    const base = join(parent, "state");
    // Simulate only the UID that stat would return for another user's ancestor.
    // The real hook and filesystem still perform every read, create, and write.
    const preload = join(dir, `foreign-owner-${mode}-${nested}.mjs`);
    writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.lstatSync;
fs.lstatSync = (path, ...args) => {
  const info = original(path, ...args);
  if (path === ${JSON.stringify(foreign)}) Object.defineProperty(info, 'uid', { value: process.getuid() + 1 });
  return info;
};
syncBuiltinESMExports();\n`);
    const result = spawnSync(process.execPath, ["--import", preload, join(plugin, "hooks/principles-hook.mjs")], {
      env: { ...process.env, AGENT_KIT_HOOKS_STATE: base }, input: JSON.stringify(event), encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(base), false, "another directory owner can replace the path despite safe-looking permission bits");
    assert.equal(result.stdout, "");
  }
});

test("shared protected paths check new files, ancestors, case folding and symlink parent traversal", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const { fileWriteOutsideRoots } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    assert.equal(typeof fileWriteOutsideRoots, "function");
    const root = join(f.dir, "logbook"), cwd = join(f.dir, "project");
    mkdirSync(root); mkdirSync(cwd); mkdirSync(join(root, "nested"));
    symlinkSync(join(root, "nested"), join(cwd, "linked"));
    symlinkSync(join(root, "missing"), join(cwd, "dangling"));
    const check = paths => fileWriteOutsideRoots({ paths, cwd, roots: [root] });
    for (const path of [root, f.dir, join(root, "new.tsv"), join(f.dir, "LOGBOOK/new.tsv"),
      "../logbook/new.tsv", "linked/../new.tsv", "dangling/new.tsv"])
      assert.equal(check([path]), false, path);
    assert.equal(check(["ordinary.txt", "../logbook-other/new.tsv"]), true);
    assert.equal(check(["ordinary.txt", "../logbook/new.tsv"]), false);
    assert.equal(existsSync(join(root, "new.tsv")), false);
  }
});

test("shared protected paths refuse hard links, loops and invalid path context", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const { fileWriteOutsideRoots } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    assert.equal(typeof fileWriteOutsideRoots, "function");
    const root = join(f.dir, "logbook"), cwd = join(f.dir, "project");
    mkdirSync(root); mkdirSync(cwd); writeFileSync(join(root, "ledger.tsv"), "fixed");
    linkSync(join(root, "ledger.tsv"), join(cwd, "alias"));
    symlinkSync("loop-b", join(cwd, "loop-a")); symlinkSync("loop-a", join(cwd, "loop-b"));
    assert.equal(fileWriteOutsideRoots({ paths: ["alias"], cwd, roots: [root] }), false);
    assert.throws(() => fileWriteOutsideRoots({ paths: ["loop-a"], cwd, roots: [root] }));
    for (const input of [{ paths: ["x"], cwd, roots: [] }, { paths: ["x\0"], cwd, roots: [root] },
      { paths: ["x"], cwd: "relative", roots: [root] }, { paths: [null], cwd, roots: [root] }])
      assert.throws(() => fileWriteOutsideRoots(input));
    assert.equal(readFileSync(join(root, "ledger.tsv"), "utf8"), "fixed");
  }
});

test("shared protected paths refuse missing entries in supplied path lists", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const { fileWriteOutsideRoots } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    assert.equal(typeof fileWriteOutsideRoots, "function");
    const root = join(f.dir, "logbook"), cwd = join(f.dir, "project");
    mkdirSync(root); mkdirSync(cwd);
    let getterRead = false;
    const accessor = [root];
    Object.defineProperty(accessor, "0", { get() { getterRead = true; return root; } });
    const inherited = Array(1);
    Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: root }));
    for (const input of [
      { paths: ["ordinary"], cwd, roots: accessor },
      { paths: ["ordinary"], cwd, roots: inherited },
      { paths: ["ordinary"], cwd, roots: Array(1) },
      { paths: ["ordinary"], cwd, roots: [root, ,] },
      { paths: Array(1), cwd, roots: [root] },
    ]) assert.throws(() => fileWriteOutsideRoots(input));
    assert.equal(getterRead, false);
    assert.equal(fileWriteOutsideRoots({ paths: [], cwd, roots: [root] }), true);
  }
});

test("shared protected paths use validated values despite custom array methods", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const { fileWriteOutsideRoots } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    assert.equal(typeof fileWriteOutsideRoots, "function");
    const root = join(f.dir, "logbook"), cwd = join(f.dir, "project");
    mkdirSync(root); mkdirSync(cwd);
    let customMethodCalled = false;
    const roots = [root];
    roots.map = () => { customMethodCalled = true; return []; };
    assert.equal(fileWriteOutsideRoots({ paths: [join(root, "ledger.tsv")], cwd, roots }), false);
    const paths = [join(root, "ledger.tsv")];
    paths[Symbol.iterator] = function* () { customMethodCalled = true; };
    assert.equal(fileWriteOutsideRoots({ paths, cwd, roots: [root] }), false);
    assert.equal(customMethodCalled, false);
  }
});

test("shared shell write classification detects writes without executing payloads in either bundle", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const { commandWrites } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    assert.equal(typeof commandWrites, "function");
    // All strings below reach the parser only. None reaches a shell or interpreter.
    for (const command of [
      "printf fixed > ledger.tsv", "cat <> ledger.tsv", "echo fixed >& ledger.tsv",
      "cp source target", "rm target", "ln source target", "uniq source target", "less -o target source",
      "sed -i s/a/b/ target", "perl -pi -e x target", "awk -i inplace x target",
      "sort --out=target source", "find . -delete", "find . -exec touch target ;",
      "node -e 'writeFileSync(\"target\",\"fixed\")'", "python -c 'open(\"target\",\"w\")'",
      "source script", "eval fixed", "exec fixed", "Set-Content target fixed",
      "Out-File target", "New-Item target", "echo $(touch target)", "echo fixed | tee target",
    ]) assert.equal(commandWrites(command, f.dir), true, command);
    for (const command of ["cat ledger.tsv", "echo touch target", "printf rm", "grep -e tee ledger.tsv",
      "cat < ledger.tsv", "echo fixed >/dev/null", "echo fixed >&2", "ls .", "jq . ledger.json"])
      assert.equal(commandWrites(command, f.dir), false, command);
    assert.equal(existsSync(join(f.dir, "target")), false);
    assert.equal(existsSync(join(f.dir, "ledger.tsv")), false);
  }
});

test("shared shell reader options preserve option values and function dispatch in either bundle", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const { commandWrites } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    assert.equal(typeof commandWrites, "function");
    for (const command of ["rg --pre cat x", "rg --pre-glob '*.txt' x", "rg --search-zip x", "rg -z x",
      "rg --hostname-bin program x", "file -C -m magic", "file --comp magic", "file -z ordinary",
      "diff --paginate left right", "diff --pa left right", "diff -l left right",
      "env rg --pre cat x", "LANG=C rg --pre cat x", "f() { rg --pre cat x; }; f",
      "rg() { :; }; command rg --pre cat x"])
      assert.equal(commandWrites(command, f.dir), true, command);
    for (const command of ["rg -e --pre x", "rg -e--pre x", "rg --regexp=--pre x", "rg -- --pre x",
      "rg --no-pre x", "file -m --compile ordinary", "file -- --compile", "diff -L --paginate left right",
      "diff --label=--paginate left right", "diff -- --paginate right", "echo rg --pre cat x",
      "rg() { :; }; rg --pre cat x", "f() { env rg --pre cat x; }; env() { :; }; f"])
      assert.equal(commandWrites(command, f.dir), false, command);
  }
});

test("shared shell write classification refuses unreadable input in either bundle", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const { commandWrites } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    assert.equal(typeof commandWrites, "function");
    for (const command of ["echo 'unfinished", "$(unfinished", null, {}, undefined])
      assert.equal(commandWrites(command, f.dir), true, JSON.stringify(command));
    assert.equal(commandWrites("", f.dir), false);
  }
});


test("Codex direct patch targets retain all operations and both names of a move", async t => {
  const f = isolated(t, "codex");
  const { patchTargets } = await import(pathToFileURL(join(f.plugin, "runtime/patch-targets.mjs")));
  const patch = ["*** Begin Patch", "*** Add File: added name.txt", "+fixed",
    "*** Update File: before", "*** Move to: after", "@@", "-old", "+new",
    "*** Delete File: removed", "*** End Patch"].join("\n");
  for (const text of [patch, patch.replaceAll("\n", "\r\n")])
    assert.deepEqual(patchTargets(text), ["added name.txt", "before", "after", "removed"]);
  assert.deepEqual(patchTargets("*** Begin Patch\n*** End Patch"), []);
  assert.equal(existsSync(join(f.dir, "added name.txt")), false);
});

test("Codex direct patch targets distinguish content from headers", async t => {
  const f = isolated(t, "codex");
  const { patchTargets } = await import(pathToFileURL(join(f.plugin, "runtime/patch-targets.mjs")));
  const patch = ["*** Begin Patch", "*** Add File: added", "+*** Delete File: content-only",
    "+*** End Patch", "*** Update File: updated", "@@", " *** Move to: context-only",
    "-*** Delete File: old-content", "+*** Add File: new-content", "*** End of File", "*** End Patch"].join("\n");
  assert.deepEqual(patchTargets(patch), ["added", "updated"]);
});

test("Codex direct patch targets refuse unsupported records and invalid targets", async t => {
  const f = isolated(t, "codex");
  const { patchTargets } = await import(pathToFileURL(join(f.plugin, "runtime/patch-targets.mjs")));
  const wrap = body => `*** Begin Patch\n${body}\n*** End Patch`;
  for (const patch of [null, {}, "not a patch", "*** Begin Patch\n*** Add File: missing-end",
    wrap("*** Unknown: x"), wrap("*** Move to: x"), wrap("*** Add File: x\n*** Move to: y"),
    wrap("*** Update File: x\n@@\n+new\n*** Move to: y"),
    wrap("*** Update File: x\n*** Move to: y\n*** Move to: z"),
    wrap("*** Delete File: x\n+unexpected"), wrap("*** Add File: "),
    wrap("*** Add File: control\0name"), wrap("*** Add File: tab\tname"),
    wrap("*** Add File: x\nnot-prefixed-content")])
    assert.throws(() => patchTargets(patch), /Codex patch targets are unavailable/);
});

test("native probe removes its profile after version failure and a stalled version process", t => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-probe-cleanup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const stalled of [false, true]) {
    const temporary = join(dir, stalled ? "stalled" : "failed"); mkdirSync(temporary);
    const fake = join(dir, stalled ? "stalled-codex" : "failed-codex");
    // The fixture stays alive until its output transport closes, then exits without a signal.
    writeFileSync(fake, stalled
      ? "#!/usr/bin/env node\nprocess.stdin.resume(); const timer = setInterval(() => process.stdout.write('fixture\\n'), 25); process.stdout.on('error', () => { clearInterval(timer); process.exit(0); });\n"
      : "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o700 });
    const result = spawnSync(process.execPath, [join(ROOT, "scripts/probe-codex-lifecycle.mjs")], {
      env: { ...process.env, TMPDIR: temporary, SAGE_CODEX_BIN: fake, ...(stalled ? { SAGE_PROBE_TEST_DEADLINE_MS: "1" } : {}) },
      encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stderr);
    const rows = result.stdout.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(rows.find(row => row.type === "result").reason, stalled ? "native_deadline" : "version_check_failed");
    assert.equal(rows.at(-1).temporaryRootRemoved, true);
    assert.deepEqual(readdirSync(temporary), [], "the actual temporary profile is gone");
  }
});


test("native deadline waits for child closure when the timeout callback throws", async t => {
  const { waitNative } = await import("./fixtures/codex-native/wait-native.mjs");
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let detached = false;
  child.unref = () => { detached = true; };
  const signals = [];
  child.kill = signal => { signals.push(signal); return true; };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = waitNative(child, { onTimeout: () => { throw new Error("simulated callback failure"); } });
  t.mock.timers.tick(120_000);
  let settled = false;
  result.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, "closing pipes must not report an unclosed child as stopped");
  child.emit("close", 0, null);
  assert.deepEqual(await result, { code: null, exitCode: 0, signal: null, timedOut: true, reason: "native_deadline", timeoutCallbackFailed: true });
  t.mock.timers.tick(300_000); // A gracefully closed child must never reach either signal timer.
  assert.deepEqual(signals, []);
  assert.equal(child.stdin.writableEnded, true);
  for (const stream of [child.stdin, child.stdout, child.stderr]) assert.equal(stream.destroyed, true);
  assert.equal(detached, false);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.listenerCount("error"), 0);
});


test("native spawn error waits for closure before releasing its owner", async t => {
  const { waitNative } = await import("./fixtures/codex-native/wait-native.mjs");
  const { EventEmitter } = await import("node:events");
  const child = new EventEmitter();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = waitNative(child);
  let settled = false;
  result.then(() => { settled = true; });
  child.emit("error", new Error("simulated spawn failure"));
  await Promise.resolve();
  assert.equal(settled, false, "an error is not the child closure event");
  child.emit("close", -2, null);
  assert.deepEqual(await result, { code: null, exitCode: -2, signal: null, spawnFailed: true });
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.listenerCount("error"), 0);
});

// Signals are intercepted in the check process: even the old implementation cannot signal a test child.
for (const scenario of ['success', 'exit-error', 'bad-manifest']) test(`Codex package check: ${scenario} closes its child without signals`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sage-package-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const signalLog = join(dir, 'signals'), closed = join(dir, 'closed');
  const preload = join(dir, 'no-signals.mjs'), binary = join(dir, 'codex');
  writeFileSync(preload, `import {ChildProcess} from 'node:child_process';\nimport {appendFileSync} from 'node:fs';\nChildProcess.prototype.kill = function(signal) { appendFileSync(${JSON.stringify(signalLog)}, String(signal)+'\\n'); this.stdin?.end(); return true; };\n`);
  const plugin = {
    skills: readdirSync(join(ROOT, 'plugins/sage-codex/skills')).map(name => ({name: `sage:${name}`})),
    hooks: ['permissionRequest', 'postToolUse', 'preToolUse', 'preToolUse', 'sessionStart', 'sessionStart', 'subagentStart', 'subagentStop', 'userPromptSubmit', 'userPromptSubmit'].map(eventName => ({eventName})),
    summary: {source: {path: join(ROOT, 'plugins/sage-codex')}},
  };
  if (scenario === 'bad-manifest') plugin.hooks = [];
  writeFileSync(binary, `#!${process.execPath}\nimport {createInterface} from 'node:readline';\nimport {writeFileSync} from 'node:fs';\nif (process.argv.includes('--version')) { console.log('codex-cli 0.160.0'); } else {\nconst reader = createInterface({input: process.stdin});\nreader.on('line', line => { const request = JSON.parse(line); if (request.id) console.log(JSON.stringify({id:request.id,result:request.id===1?{}:{plugin:${JSON.stringify(plugin)}}})); });\nreader.on('close', () => { writeFileSync(${JSON.stringify(closed)}, 'stdin closed'); process.exitCode=${scenario === 'exit-error' ? 7 : 0}; });\n}\n`, {mode: 0o700});
  const child = spawn(process.execPath, ['--import', preload, join(ROOT, 'scripts/check-codex.mjs')], {
    env: {...process.env, SAGE_CODEX_BIN: binary}, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({code, signal})); });
  assert.equal(result.signal, null);
  assert.equal(existsSync(signalLog), false, 'the check requested a process signal');
  assert.equal(readFileSync(closed, 'utf8'), 'stdin closed', 'the child acknowledged transport closure');
  if (scenario === 'success') {
    assert.equal(result.code, 0, stderr);
    assert.match(stdout, /discovered \d+ skills and 10 hooks/);
  } else {
    assert.equal(result.code, 1, stdout + stderr);
    assert.doesNotMatch(stdout, /discovered \d+ skills/);
    assert.match(stderr, /Codex package check failed:/);
  }
});


test("native deadline escalates only its owned child and still waits for closure", async t => {
  const { waitNative } = await import("./fixtures/codex-native/wait-native.mjs");
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const child = new EventEmitter(), signals = [];
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = signal => { signals.push(signal); return true; };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = waitNative(child);
  let settled = false; result.then(() => { settled = true; });
  t.mock.timers.tick(120_000);
  assert.deepEqual(signals, [], "transport shutdown gets the first chance");
  t.mock.timers.tick(30_000); assert.deepEqual(signals, ["SIGTERM"]);
  t.mock.timers.tick(30_000); assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  await Promise.resolve(); assert.equal(settled, false, "a signal is not proof of exit");
  child.emit("close", null, "SIGKILL");
  assert.deepEqual(await result, { code: null, exitCode: null, signal: "SIGKILL", timedOut: true, reason: "native_deadline" });
  t.mock.timers.tick(300_000); assert.equal(signals.length, 2);
});

test("native deadline cancels escalation when the owned child closes", async t => {
  const { waitNative } = await import("./fixtures/codex-native/wait-native.mjs");
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const child = new EventEmitter(), signals = [];
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = signal => { signals.push(signal); return true; };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = waitNative(child);
  t.mock.timers.tick(120_000); t.mock.timers.tick(30_000);
  assert.deepEqual(signals, ["SIGTERM"]);
  child.emit("close", 0, null); await result;
  t.mock.timers.tick(300_000); assert.deepEqual(signals, ["SIGTERM"]);
});

test("native deadline retains error handling across both termination attempts", async t => {
  const { waitNative } = await import("./fixtures/codex-native/wait-native.mjs");
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => true;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = waitNative(child);
  try {
    t.mock.timers.tick(120_000); t.mock.timers.tick(30_000);
    child.emit("error", new Error("simulated SIGTERM failure"));
    t.mock.timers.tick(30_000);
    assert.doesNotThrow(() => child.emit("error", new Error("simulated SIGKILL failure")));
  } finally { child.emit("close", 1, null); }
  assert.deepEqual(await result, { code: null, exitCode: 1, signal: null, timedOut: true,
    reason: "native_deadline", terminationFailed: true });
  assert.equal(child.listenerCount("error"), 0);
});


test("native deadline does not signal an exited child while output closure is pending", async t => {
  const { waitNative } = await import("./fixtures/codex-native/wait-native.mjs");
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const signals = [];
  child.kill = signal => { signals.push(signal); return true; };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = waitNative(child);
  let settled = false; result.then(() => { settled = true; });
  t.mock.timers.tick(120_000);
  child.exitCode = 0;
  t.mock.timers.tick(300_000);
  await Promise.resolve(); assert.equal(settled, false);
  child.emit("close", 0, null);
  assert.deepEqual(await result, { code: null, exitCode: 0, signal: null, timedOut: true, reason: "native_deadline" });
  assert.deepEqual(signals, []);
});

test("shared shell paths refuse literal protected writes and preserve ordinary reads in both bundles", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const { shellWriteOutsideRoots } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    assert.equal(typeof shellWriteOutsideRoots, "function");
    const root = join(f.dir, "logbook"), cwd = join(f.dir, "project"); mkdirSync(root); mkdirSync(cwd);
    const check = command => shellWriteOutsideRoots({ command, cwd, roots: [root] });
    // Parser inputs only: no payload below is executed.
    for (const command of [`printf fixed > ${root}/ledger.tsv`, `cp source ${root}/ledger.tsv`,
      `rm -rf ${root}`, `sort --output=${root}/ledger.tsv source`, `env SAGE_HOME=${root} touch target`,
      `node -e 'writeFileSync("${root}/ledger.tsv", "fixed")'`]) assert.equal(check(command), false, command);
    for (const command of ["printf fixed > ordinary.txt", "cp source target", "touch ordinary.txt", `cat ${root}/ledger.tsv`])
      assert.equal(check(command), true, command);
    assert.equal(existsSync(join(root, "ledger.tsv")), false);
    assert.equal(existsSync(join(cwd, "ordinary.txt")), false);
  }
});

test("shared shell paths use directory and alias evidence and refuse unresolved write paths", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const { shellWriteOutsideRoots } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    assert.equal(typeof shellWriteOutsideRoots, "function");
    const root = join(f.dir, "logbook"), cwd = join(f.dir, "project"); mkdirSync(root); mkdirSync(cwd);
    symlinkSync(root, join(cwd, "linked")); writeFileSync(join(root, "ledger.tsv"), "fixed");
    linkSync(join(root, "ledger.tsv"), join(cwd, "hard"));
    const check = command => shellWriteOutsideRoots({ command, cwd, roots: [root] });
    for (const command of ["printf fixed > linked/ledger.tsv", "printf fixed > hard", "cd ../logbook && touch new.tsv",
      "cd $UNKNOWN && touch new.tsv", "touch $UNKNOWN", "touch link*", "touch har*", "touch ~/file", "sort -olinked/ledger.tsv input",
      "sort -ohard input", "printf() { touch fixed; }; printf linked/ledger.tsv", "echo 'unfinished"])
      assert.equal(check(command), false, command);
    assert.equal(check("cd . && touch ordinary.txt"), true);
    assert.equal(check("touch ordinary*"), true);
    assert.equal(check("sort -oordinary.txt input"), true);
    assert.equal(check("printf '%s' '{\"name\":\"fixed\"}' > config.json"), true);
    assert.equal(readFileSync(join(root, "ledger.tsv"), "utf8"), "fixed");
  }
});

test("shared shell paths validate context before read-only or malformed commands", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const { shellWriteOutsideRoots } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    assert.equal(typeof shellWriteOutsideRoots, "function");
    const root = join(f.dir, "logbook"), cwd = join(f.dir, "project"); mkdirSync(root); mkdirSync(cwd);
    for (const command of [null, {}, "echo 'unfinished"])
      assert.equal(shellWriteOutsideRoots({ command, cwd, roots: [root] }), false);
    assert.throws(() => shellWriteOutsideRoots({ command: "cat ordinary", cwd: "relative", roots: [root] }));
    assert.throws(() => shellWriteOutsideRoots({ command: "cat ordinary", cwd, roots: Array(1) }));
  }
});

test("shared shell paths retain protected roots despite custom array methods", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const { shellWriteOutsideRoots } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    assert.equal(typeof shellWriteOutsideRoots, "function");
    const root = join(f.dir, "logbook"), cwd = join(f.dir, "project"); mkdirSync(root); mkdirSync(cwd);
    let customMethodCalled = false;
    const roots = [root];
    roots.some = () => { customMethodCalled = true; return false; };
    roots[Symbol.iterator] = function* () { customMethodCalled = true; };
    // This string is parser input only. It never reaches an interpreter.
    const command = `node -e 'writeFileSync("${root}/ledger.tsv", "fixed")'`;
    assert.equal(shellWriteOutsideRoots({ command, cwd, roots }), false);
    assert.equal(customMethodCalled, false);
    assert.equal(existsSync(join(root, "ledger.tsv")), false);
  }
});

test("shared shell paths keep literal equals signs in operands and redirections", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const { shellWriteOutsideRoots } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    assert.equal(typeof shellWriteOutsideRoots, "function");
    const root = join(f.dir, "logbook"), cwd = join(f.dir, "project"); mkdirSync(root); mkdirSync(cwd);
    symlinkSync(root, join(cwd, "linked"));
    const check = command => shellWriteOutsideRoots({ command, cwd, roots: [root] });
    // Parser inputs only. '=' is part of these file names, not an assignment delimiter.
    for (const command of [`touch ${root}/a=b`, `printf fixed > ${root}/a=b`,
      "touch linked/a=b", "printf fixed > linked/a=b", "sort -olinked/a=b input",
      "sort --output=linked/a=b input", `env OUT=${root}/a=b touch target`])
      assert.equal(check(command), false, command);
    for (const command of ["touch ordinary=a", "printf fixed > ordinary=a",
      "sort -oordinary=a input", "sort --output=ordinary=a input", "env OUT=ordinary=a touch target"])
      assert.equal(check(command), true, command);
    assert.equal(existsSync(join(root, "a=b")), false);
    assert.equal(existsSync(join(cwd, "ordinary=a")), false);
  }
});

test("shared shell paths preserve quoted redirection target prefixes", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const { shellWriteOutsideRoots } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    const root = join(f.dir, "logbook"), cwd = join(f.dir, "project"); mkdirSync(root); mkdirSync(cwd);
    for (const prefix of ["&", ">", "<", "|"]) {
      symlinkSync(root, join(cwd, `${prefix}linked`));
      for (const operator of [">", ">>", ">|", "&>", "&>>", "<>"]) {
        // These strings reach the parser only, never a shell.
        assert.equal(shellWriteOutsideRoots({ command: `printf fixed ${operator} '${prefix}linked/ledger.tsv'`, cwd, roots: [root] }), false);
        assert.equal(shellWriteOutsideRoots({ command: `printf fixed ${operator} '${prefix}ordinary'`, cwd, roots: [root] }), true);
      }
    }
    assert.equal(existsSync(join(root, "ledger.tsv")), false);
  }
});

test("shared command reader keeps structured redirection targets across execution scopes", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const { programsRun } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    for (const [command, operator, target] of [
      ["printf fixed > '&name'", ">", "&name"],
      ["{ printf fixed; } >> '>name'", ">>", ">name"],
      ["(printf fixed) &> '|name'", "&>", "|name"],
      ["printf fixed | cat 2> '<name'", ">", "<name"],
      ['sh -c "printf fixed > \'&name\'"', ">", "&name"],
      ["f() { printf fixed; }; f > '&name'", ">", "&name"],
    ]) {
      const legacy = programsRun(command, f.dir, "", { redirectEvidence: true });
      const detailed = programsRun(command, f.dir, "", { redirectEvidence: true, redirectParts: true });
      assert.equal(detailed.length, 1, command);
      assert.equal(detailed[0].operator, operator, command);
      assert.equal(detailed[0].target, target, command);
      assert.deepEqual(detailed.map(({ operator, target, ...rest }) => rest), legacy);
      assert.equal(Object.hasOwn(legacy[0], "operator"), false);
      assert.equal(Object.hasOwn(legacy[0], "target"), false);
    }
  }
});

test("Codex direct patch targets refuse header whitespace that native parsing removes", async t => {
  const f = isolated(t, "codex");
  const { patchTargets } = await import(pathToFileURL(join(f.plugin, "runtime/patch-targets.mjs")));
  const wrap = body => `*** Begin Patch\n${body}\n*** End Patch`;
  for (const suffix of [" ", "\t", "\u00a0", "\u2003", "\u202f", "\u0085"]) {
    for (const body of [`*** Add File: AGENTS.md${suffix}\n+fixed`,
      `*** Update File: AGENTS.md${suffix}\n@@\n-old\n+new`,
      `*** Delete File: AGENTS.md${suffix}`,
      `*** Update File: ordinary\n*** Move to: AGENTS.md${suffix}\n@@\n-old\n+new`])
      assert.throws(() => patchTargets(wrap(body)), /Codex patch targets are unavailable/);
  }
  assert.deepEqual(patchTargets(wrap("*** Add File: ordinary name\n+fixed")), ["ordinary name"]);
  assert.equal(existsSync(join(f.dir, "AGENTS.md")), false);
});


test("shared write classification preserves numeric and device-like redirection targets", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const { commandWrites, shellWriteOutsideRoots } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    const root = join(f.dir, "logbook"), cwd = join(f.dir, "project"); mkdirSync(root); mkdirSync(cwd);
    for (const name of ["&1", "&2", "&1-", "&-"]) {
      symlinkSync(join(root, "ledger.tsv"), join(cwd, name));
      const command = `printf fixed > '${name}'`;
      assert.equal(commandWrites(command, cwd), true, command);
      assert.equal(shellWriteOutsideRoots({ command, cwd, roots: [root] }), false, command);
    }
    mkdirSync(join(cwd, ">")); symlinkSync(root, join(cwd, ">", "dev"));
    const command = "printf fixed > '>/dev/null'";
    assert.equal(commandWrites(command, cwd), true, command);
    assert.equal(shellWriteOutsideRoots({ command, cwd, roots: [root] }), false, command);
    for (const command of ["printf fixed >&1", "printf fixed 2>&2", "printf fixed > /dev/null"])
      assert.equal(commandWrites(command, cwd), false, command);
    assert.equal(existsSync(join(root, "ledger.tsv")), false);
    assert.equal(existsSync(join(root, "null")), false);
  }
});


test("shared shell paths refuse redirection-only writes after uncertain directory changes", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const { shellWriteOutsideRoots } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    const root = join(f.dir, "logbook"), cwd = join(f.dir, "project");
    mkdirSync(root); mkdirSync(join(cwd, "sub/sub"), { recursive: true });
    const check = command => shellWriteOutsideRoots({ command, cwd, roots: [root] });
    // Parse only. The actual loop would change the directory twice.
    assert.equal(check("for x in a b; do cd sub; done; > ../../../logbook/ledger.tsv"), false);
    assert.equal(check("cd sub; cd sub; > ../../../logbook/ledger.tsv"), false);
    assert.equal(check("cd sub; > ordinary.txt"), true);
    assert.equal(existsSync(join(root, "ledger.tsv")), false);
    assert.equal(existsSync(join(cwd, "sub/ordinary.txt")), false);
  }
});

test("Codex patch policy protects both move targets and logbook paths in every mode", async t => {
  const f = isolated(t, "codex");
  const { patchEditDecision } = await import(pathToFileURL(join(f.plugin, "runtime/file-policy.mjs")));
  assert.equal(typeof patchEditDecision, "function");
  const cwd = join(f.dir, "project"), root = join(f.dir, "logbook"); mkdirSync(cwd); mkdirSync(root);
  symlinkSync(root, join(cwd, "linked"));
  const input = text => ({ tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n${text}\n*** End Patch` } });
  const options = { cwd, roots: [root] };
  for (const context of [{ sage: true, chief: false }, { sage: false, chief: false }, { sage: false, chief: true }]) {
    assert.equal(patchEditDecision(input("*** Add File: ordinary\n+fixed"), context, options).decision, "pass");
    for (const body of ["*** Add File: linked/new.tsv\n+fixed", "*** Delete File: ../logbook/ledger.tsv",
      "*** Update File: ordinary\n*** Move to: ../logbook/new.tsv\n@@\n-old\n+new",
      "*** Update File: ../logbook/ledger.tsv\n*** Move to: ordinary\n@@\n-old\n+new"])
      assert.equal(patchEditDecision(input(body), context, options).decision, "deny");
  }
  assert.equal(patchEditDecision(input("*** Add File: ordinary\n+fixed"), { sage: true, chief: true }, options).decision, "deny");
});

test("Codex patch policy rejects unknown input shapes and retains the chief edit gate", async t => {
  const f = isolated(t, "codex");
  const { patchEditDecision } = await import(pathToFileURL(join(f.plugin, "runtime/file-policy.mjs")));
  assert.equal(typeof patchEditDecision, "function");
  const options = { cwd: f.dir, roots: [join(f.dir, "logbook")] };
  for (const value of [null, [], {}, { patch: "invented" }, { command: "bad", extra: true }, { command: 1 },
    { command: "*** Begin Patch\n*** Unknown: x\n*** End Patch" }])
    assert.throws(() => patchEditDecision({ tool_name: "apply_patch", tool_input: value }, { sage: false, chief: false }, options));
  const input = { tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** Add File: ordinary\n+fixed\n*** End Patch" } };
  assert.equal(patchEditDecision(input, { sage: true, chief: true }, options).decision, "deny");
  assert.equal(patchEditDecision(input, { sage: false, chief: true }, options).decision, "pass");
  assert.equal(patchEditDecision({ tool_name: "read_file" }, { sage: true, chief: true }, options).decision, "pass");
  assert.throws(() => patchEditDecision(input, { sage: false, chief: false }, { cwd: "relative", roots: options.roots }));
  assert.equal(existsSync(join(f.dir, "ordinary")), false);
});

test("Codex patch policy rejects linked move sources and targets without applying changes", async t => {
  const f = isolated(t, "codex");
  const { patchEditDecision } = await import(pathToFileURL(join(f.plugin, "runtime/file-policy.mjs")));
  assert.equal(typeof patchEditDecision, "function");
  const root = join(f.dir, "logbook"), cwd = join(f.dir, "project"); mkdirSync(root); mkdirSync(cwd);
  writeFileSync(join(root, "ledger.tsv"), "fixed");
  linkSync(join(root, "ledger.tsv"), join(cwd, "alias"));
  const decide = body => patchEditDecision({ tool_name: "apply_patch", tool_input: {
    command: `*** Begin Patch\n${body}\n*** End Patch` } }, { sage: false, chief: false }, { cwd, roots: [root] });
  for (const body of ["*** Update File: alias\n*** Move to: ordinary\n@@\n-fixed\n+new",
    "*** Update File: ordinary\n*** Move to: alias\n@@\n-fixed\n+new", "*** Delete File: alias"])
    assert.equal(decide(body).decision, "deny");
  assert.equal(readFileSync(join(root, "ledger.tsv"), "utf8"), "fixed");
  assert.equal(existsSync(join(cwd, "ordinary")), false);
});

test("Codex shell path decisions protect linked targets and literal equals names", async t => {
  const f = isolated(t, "codex");
  const { shellPathDecision } = await import(pathToFileURL(join(f.plugin, "runtime/file-policy.mjs")));
  assert.equal(typeof shellPathDecision, "function");
  const root = join(f.dir, "logbook"), cwd = join(f.dir, "project"); mkdirSync(root); mkdirSync(cwd);
  writeFileSync(join(root, "ledger.tsv"), "unchanged");
  symlinkSync(root, join(cwd, "linked"));
  linkSync(join(root, "ledger.tsv"), join(cwd, "hard"));
  for (const command of ["tee linked/ledger.tsv", "printf fixed > hard", "touch linked/a=b",
    "cd ../logbook && touch new.tsv", "sort -olinked/result.tsv input"])
    assert.equal(shellPathDecision(command, { cwd, roots: [root] }).decision, "deny", command);
  assert.equal(readFileSync(join(root, "ledger.tsv"), "utf8"), "unchanged");
  assert.equal(existsSync(join(root, "a=b")), false);
});

test("Codex shell path decisions deny unresolved writes without treating reader data as paths", async t => {
  const f = isolated(t, "codex");
  const { shellPathDecision } = await import(pathToFileURL(join(f.plugin, "runtime/file-policy.mjs")));
  assert.equal(typeof shellPathDecision, "function");
  const root = join(f.dir, "logbook"), cwd = join(f.dir, "project"); mkdirSync(root); mkdirSync(cwd);
  for (const command of [null, "touch $UNKNOWN", "cd $UNKNOWN && touch file", "touch ~/file", "echo 'unfinished"])
    assert.equal(shellPathDecision(command, { cwd, roots: [root] }).decision, "deny", String(command));
  for (const command of ["cat ordinary.txt", "touch ordinary.txt", "touch ordinary=a", `printf '%s' '${root}/ledger.tsv'`])
    assert.equal(shellPathDecision(command, { cwd, roots: [root] }).decision, "pass", command);
  assert.equal(existsSync(join(cwd, "ordinary.txt")), false);
});

test("Codex shell path decisions reject invalid execution context and retain custom-array roots", async t => {
  const f = isolated(t, "codex");
  const { shellPathDecision } = await import(pathToFileURL(join(f.plugin, "runtime/file-policy.mjs")));
  assert.equal(typeof shellPathDecision, "function");
  const root = join(f.dir, "logbook"), cwd = join(f.dir, "project"); mkdirSync(root); mkdirSync(cwd);
  for (const context of [{ cwd: "relative", roots: [root] }, { cwd, roots: [] },
    { cwd, roots: new Array(1) }, { cwd, roots: [null] }])
    assert.throws(() => shellPathDecision("cat ordinary.txt", context));
  const roots = [root];
  roots.some = () => false; roots.map = () => []; roots[Symbol.iterator] = function* () {};
  assert.equal(shellPathDecision(`touch ${root}/ledger.tsv`, { cwd, roots }).decision, "deny");
});

// Completion changes capacity only. It does not record a successful task or review.
test('exact completion releases one slot and repeated stale events cannot release newer work', async t => {
  const f = await roleAdmissionFixture(t, { total: 1, projects: [{ project: 'project-a', limit: 1 }] });
  assert.equal(typeof f.api.completeAdmission, 'function');
  const first = f.reserve(1), binding = bindingFor(first.assignment);
  f.api.bindAdmission(f.journal, binding);
  assert.throws(() => f.reserve(2), /capacity is occupied/);
  assert.equal(f.api.completeAdmission(f.journal, binding).decision, 'completed');
  const second = f.reserve(2);
  assert.equal(second.decision, 'permit-once');
  assert.equal(f.api.completeAdmission(f.journal, binding).decision, 'already-completed');
  assert.throws(() => f.reserve(3), /capacity is occupied/);
  assert.equal(f.api.readAdmission(f.journal).reservations.length, 2, 'history is retained');
  assert.deepEqual(f.api.readAdmission(f.journal).completions, [binding]);
});

test('completion refuses missing bindings and every changed identity field', async t => {
  const f = await roleAdmissionFixture(t);
  assert.equal(typeof f.api.completeAdmission, 'function');
  const binding = bindingFor(f.reserve(1).assignment);
  assert.throws(() => f.api.completeAdmission(f.journal, binding), /matching child binding/);
  f.api.bindAdmission(f.journal, binding);
  for (const key of Object.keys(binding)) {
    const replacement = key === 'assignment' || key === 'epoch' ? f.activation : 'different';
    assert.throws(() => f.api.completeAdmission(f.journal, { ...binding, [key]: replacement }));
  }
  assert.deepEqual(f.api.readAdmission(f.journal).completions ?? [], []);
  f.api.changeAdmissionMode(f.journal, { ...f.scope, after: f.activation, turn: 'b72422c7-509c-43aa-8c42-827c556f8a57', sage: false });
  assert.equal(f.api.completeAdmission(f.journal, binding).decision, 'completed', 'off does not discard terminal evidence');
});

test('a completed lead keeps child capacity held and cannot admit new children', async t => {
  const f = await roleAdmissionFixture(t, { total: 3, projects: [{ project: 'project-a', limit: 3 }] });
  assert.equal(typeof f.api.completeAdmission, 'function');
  const lead = bindingFor(f.reserve(1).assignment, 'lead-a'); f.api.bindAdmission(f.journal, lead);
  f.reserve(2, 'qa', 'lead', 'lead-a');
  f.reserve(3, 'implementer', 'lead', 'lead-a');
  f.api.completeAdmission(f.journal, lead);
  assert.throws(() => f.reserve(4, 'qa', 'lead', 'lead-a'), /completed issuer/);
  assert.equal(f.reserve(5).decision, 'permit-once');
  assert.throws(() => f.reserve(6), /capacity is occupied/);
});

test('concurrent completion publishes once and reopened capacity still has one winner', async t => {
  const f = await roleAdmissionFixture(t, { total: 1, projects: [{ project: 'project-a', limit: 1 }] });
  assert.equal(typeof f.api.completeAdmission, 'function');
  const binding = bindingFor(f.reserve(1).assignment); f.api.bindAdmission(f.journal, binding);
  const code = `const input=JSON.parse(process.argv[1]); const api=await import(input.url);
    try { console.log(JSON.stringify(input.binding ? api.completeAdmission(input.dir,input.binding)
      : api.reserveRoleAdmission(...input.args,{issuerRole:'chief-of-staff',role:'lead'}))); }
    catch(error) { console.log(JSON.stringify({refused:error.message})); }`;
  const run = input => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, JSON.stringify({ url: f.url, dir: f.journal, ...input })], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let output = '', error = '';
    child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { error += bytes; });
    child.once('error', reject); child.once('close', status => {
      try { assert.equal(status, 0, error); resolve(JSON.parse(output)); } catch (e) { reject(e); }
    }); child.stdin.end();
  });
  const completed = await Promise.all([run({ binding }), run({ binding })]);
  assert.deepEqual(completed.map(row => row.decision).sort(), ['already-completed', 'completed']);
  const admitted = await Promise.all([run({ args: f.args(2) }), run({ args: f.args(3) })]);
  assert.equal(admitted.filter(row => row.decision === 'permit-once').length, 1);
  assert.equal(admitted.filter(row => /capacity is occupied/.test(row.refused)).length, 1);
  assert.equal(f.api.readAdmission(f.journal).completions.length, 1);
});

test('completed native children cannot regain instructions through a repeated start binding', async t => {
  const f = await nativeBindingFixture(t);
  const assignment = f.reserve(1, 'lead', 'chief-of-staff');
  const bound = f.bind(f.identity());
  f.api.completeAdmission(f.journal, bound.binding);
  assert.throws(() => f.bind(f.identity()), /could not bind/);
  assert.equal(f.api.readAdmission(f.journal).completions[0].assignment, assignment.id);
});


test('verified interruption is immutable and releases only the exact bound slot in either provider', async t => {
  for (const provider of ['claude', 'codex']) {
    const f = await roleAdmissionFixture(t, { total: 1, projects: [{ project: 'project-a', limit: 1 }] }, provider);
    assert.equal(typeof f.api.interruptAdmission, 'function');
    const binding = bindingFor(f.reserve(1).assignment), evidence = 'b'.repeat(64);
    assert.throws(() => f.api.interruptAdmission(f.journal, binding, evidence), /matching child binding/);
    f.api.bindAdmission(f.journal, binding);
    const before = f.api.readAdmission(f.journal);
    for (const hash of [undefined, '', 'b'.repeat(63), 'B'.repeat(64), 'x'.repeat(64)])
      assert.throws(() => f.api.interruptAdmission(f.journal, binding, hash));
    for (const key of Object.keys(binding)) {
      const replacement = key === 'assignment' || key === 'epoch' ? f.activation : 'different';
      assert.throws(() => f.api.interruptAdmission(f.journal, { ...binding, [key]: replacement }, evidence));
    }
    assert.deepEqual(f.api.readAdmission(f.journal), before);
    const result = f.api.interruptAdmission(f.journal, binding, evidence);
    assert.equal(result.decision, 'completed');
    assert.deepEqual(result.completion, { ...binding, outcome: 'interrupted', evidenceHash: evidence });
    const next = f.reserve(2); assert.equal(next.decision, 'permit-once');
    const saved = f.api.readAdmission(f.journal);
    assert.equal(f.api.interruptAdmission(f.journal, binding, evidence).decision, 'already-completed');
    assert.throws(() => f.api.interruptAdmission(f.journal, binding, 'c'.repeat(64)), /different terminal evidence/);
    assert.throws(() => f.api.completeAdmission(f.journal, binding), /different terminal evidence/);
    assert.throws(() => f.reserve(3), /capacity is occupied/);
    assert.deepEqual(f.api.readAdmission(f.journal), saved);
    const nextBinding = bindingFor(next.assignment, 'child-2'); f.api.bindAdmission(f.journal, nextBinding);
    f.api.completeAdmission(f.journal, nextBinding);
    assert.throws(() => f.api.interruptAdmission(f.journal, nextBinding, evidence), /different terminal evidence/);
  }
});

test('terminal lead cannot prepare work and off-mode interruption preserves mode and child slots', async t => {
  const f = await roleAdmissionFixture(t, { total: 2, projects: [{ project: 'project-a', limit: 2 }] });
  assert.equal(typeof f.api.interruptAdmission, 'function');
  const lead = bindingFor(f.reserve(1).assignment, 'lead-a'); f.api.bindAdmission(f.journal, lead);
  f.reserve(2, 'qa', 'lead', 'lead-a');
  f.api.changeAdmissionMode(f.journal, { ...f.scope, after: f.activation, turn: 'b72422c7-509c-43aa-8c42-827c556f8a57', sage: false });
  const modes = f.api.readAdmission(f.journal).modes;
  f.api.interruptAdmission(f.journal, lead, 'b'.repeat(64));
  assert.deepEqual(f.api.readAdmission(f.journal).modes, modes);
  const brief = Object.fromEntries(f.api.BRIEF_FIELDS.map(field => [field, 'Fixed task brief.']));
  assert.throws(() => f.api.prepareAdmission(f.journal, f.scope,
    { task: 'T1', run: 'R3', issuer: 'lead-a', name: 'next-child' }, { issuerRole: 'lead', role: 'qa' }, brief), /completed issuer/);
  assert.throws(() => f.reserve(3), /Sage mode is off/);
  assert.equal(f.api.readAdmission(f.journal).reservations.length, 2);
  assert.equal(f.api.readAdmission(f.journal).completions.length, 1);
});

test('terminal evidence frees its project and lead limits without changing another project', async t => {
  const f = await roleAdmissionFixture(t, { total: 4, projects: [{ project: 'project-a', limit: 3 }, { project: 'project-b', limit: 1 }] });
  assert.equal(typeof f.api.completeAdmission, 'function');
  const first = f.reserve(1); f.reserve(2); f.reserve(3);
  const owner = f.api.activateAdmission(f.journal, { project: 'project-b', session: 'other', activation: f.activation });
  const scope = { project: owner.project, session: owner.session, epoch: owner.epoch };
  f.reserve(4, 'qa', 'chief-of-staff', 'other', scope);
  assert.throws(() => f.reserve(5), /three lead slots/);
  const binding = bindingFor(first.assignment); f.api.bindAdmission(f.journal, binding);
  f.api.completeAdmission(f.journal, binding);
  assert.throws(() => f.reserve(5, 'qa', 'chief-of-staff', 'other', scope), /project capacity/);
  assert.equal(f.reserve(6).decision, 'permit-once');
  assert.throws(() => f.reserve(7, 'qa'), /total capacity/);
  assert.equal(f.api.readAdmission(f.journal).reservations.length, 5);
});


test('terminal bindings cannot revive through an atomic repeated binding request', async t => {
  for (const provider of ['claude', 'codex']) for (const interrupted of [false, true]) {
    const f = await roleAdmissionFixture(t, undefined, provider);
    const binding = bindingFor(f.reserve(1).assignment);
    f.api.bindAdmission(f.journal, binding);
    if (interrupted) f.api.interruptAdmission(f.journal, binding, 'd'.repeat(64));
    else f.api.completeAdmission(f.journal, binding);
    const before = f.api.readAdmission(f.journal);
    assert.throws(() => f.api.bindAdmission(f.journal, binding), /completed assignment cannot bind/);
    assert.deepEqual(f.api.readAdmission(f.journal), before);
  }
});

const reportApi = await import("../plugins/sage-codex/core/index.mjs");
const report = ["STATUS done", "RESULT PASS", "EVIDENCE node check.mjs: 3 passed", "FINDINGS none", "QUESTIONS none", "NOT VERIFIED real model", "BRANCH none"].join("\n");

test("report structure retains evidence without converting a child claim into a verdict", () => {
  assert.equal(typeof reportApi.parseReport, "function");
  assert.equal(reportApi.parseReport(report).EVIDENCE, "node check.mjs: 3 passed");
  for (const status of ["done", "blocked", "question"]) {
    assert.equal(reportApi.parseReport(report.replace("STATUS done", `**STATUS**: ${status}`)).STATUS, status);
  }
  assert.deepEqual(Object.keys(reportApi.parseReport(report)), reportApi.REPORT_FIELDS);
  assert.deepEqual(reportApi.parseReport("```text\n" + report + "\n```"), reportApi.parseReport(report));
});

test("report structure rejects missing empty repeated malformed and oversized fields", () => {
  assert.equal(typeof reportApi.parseReport, "function");
  for (const field of reportApi.REPORT_FIELDS) {
    const rows = report.split("\n");
    assert.throws(() => reportApi.parseReport(rows.filter(line => !line.startsWith(field)).join("\n")));
    assert.throws(() => reportApi.parseReport(rows.map(line => line.startsWith(field) ? field : line).join("\n")));
    assert.throws(() => reportApi.parseReport(report + `\n${field} other`));
  }
  for (const value of [null, {}, report.replace("STATUS done", "STATUS success"), report + "\0", report + "\ud800", report + "x".repeat(32 * 1024)]) {
    assert.throws(() => reportApi.parseReport(value));
  }
});

async function reportReceiptFixture(t) {
  const f = await roleAdmissionFixture(t);
  assert.equal(typeof f.api.recordReportAdmission, "function");
  const assigned = f.reserve(1).assignment;
  const binding = bindingFor(assigned);
  f.api.bindAdmission(f.journal, binding);
  const { createHash } = await import("node:crypto");
  const receipt = (text = report, bound = binding, run = assigned.run, task = assigned.task) => ({ binding: bound, task,
    run, reportMessage: "report-message", reportHash: createHash("sha256").update(text).digest("hex"), text });
  return { ...f, binding, receipt };
}

test("durable reports record once after completion and preserve all other admission state", async t => {
  const f = await reportReceiptFixture(t);
  assert.throws(() => f.api.recordReportAdmission(f.journal, f.receipt()), /matching completed assignment/);
  f.api.completeAdmission(f.journal, f.binding);
  f.api.changeAdmissionMode(f.journal, { ...f.scope, after: f.activation, turn: modeTurn, sage: false });
  const before = f.api.readAdmission(f.journal);
  assert.equal(f.api.recordReportAdmission(f.journal, f.receipt()).decision, "report-recorded");
  const files = readdirSync(f.journal);
  assert.equal(f.api.recordReportAdmission(f.journal, f.receipt()).decision, "already-recorded");
  assert.deepEqual(readdirSync(f.journal), files);
  const { reports, ...after } = f.api.readAdmission(f.journal);
  assert.deepEqual(after, before); assert.deepEqual(reports, [f.receipt()]);
});

test("durable reports refuse changed bindings content hashes task runs and replacement evidence", async t => {
  const f = await reportReceiptFixture(t);
  f.api.completeAdmission(f.journal, f.binding);
  const receipt = f.receipt();
  for (const key of Object.keys(f.binding)) {
    assert.throws(() => f.api.recordReportAdmission(f.journal, { ...receipt, binding: { ...f.binding, [key]: "different" } }));
  }
  for (const changed of [{ task: "T2" }, { run: "R2" }, { reportHash: "a".repeat(64) }, { text: "STATUS done" }, { extra: true }]) {
    assert.throws(() => f.api.recordReportAdmission(f.journal, { ...receipt, ...changed }));
  }
  assert.equal(f.api.recordReportAdmission(f.journal, receipt).decision, "report-recorded");
  assert.throws(() => f.api.recordReportAdmission(f.journal, f.receipt(report.replace("RESULT PASS", "RESULT FAIL"))), /different recorded report/);
  assert.throws(() => f.api.recordReportAdmission(f.journal, { ...receipt, reportMessage: "other-message" }), /different recorded report/);
  assert.deepEqual(f.api.readAdmission(f.journal).reports, [receipt]);
});

test("concurrent durable report receipts publish once and conflicting reports cannot replace the winner", async t => {
  const f = await reportReceiptFixture(t); f.api.completeAdmission(f.journal, f.binding);
  const code = `const input=JSON.parse(process.argv[1]);const api=await import(input.url);
    try{console.log(JSON.stringify(api.recordReportAdmission(input.dir,input.report)))}
    catch{console.log(JSON.stringify({refused:true}))}`;
  const run = report => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, JSON.stringify({url:f.url,dir:f.journal,report})], {stdio:["pipe","pipe","pipe"],env:process.env,shell:false});
    let output="", error="";
    child.stdout.on("data",data=>output+=data);child.stderr.on("data",data=>error+=data);child.once("error",reject);
    child.once("close",status=>{try{assert.equal(status,0,error);resolve(JSON.parse(output));}catch(e){reject(e)}});child.stdin.end();
  });
  const retries = await Promise.all([run(f.receipt()), run(f.receipt())]);
  assert.deepEqual(retries.map(row=>row.decision).sort(), ["already-recorded", "report-recorded"]);
  const second = f.reserve(2).assignment, bound = bindingFor(second,"child-2","turn-2");
  f.api.bindAdmission(f.journal,bound);f.api.completeAdmission(f.journal,bound);
  const different = await Promise.all([run(f.receipt(report,bound,second.run,second.task)),run(f.receipt(report.replace("RESULT PASS","RESULT FAIL"),bound,second.run,second.task))]);
  assert.equal(different.filter(row=>row.decision==="report-recorded").length,1);
  assert.equal(different.filter(row=>row.refused).length,1);
  const saved=f.api.readAdmission(f.journal).reports;
  assert.equal(saved.length,2);assert.deepEqual(saved[1],different.find(row=>row.decision==="report-recorded").report);
});

const failureFor = assignment => ({ project: assignment.project, session: assignment.session, epoch: assignment.epoch,
  assignment: assignment.id, issuer: assignment.issuer, call: assignment.call, evidenceHash: "a".repeat(64) });

test("failed dispatch receipts release one slot and cannot release or bind later work", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = await roleAdmissionFixture(t, { total: 1, projects: [{ project: "project-a", limit: 1 }] }, provider);
    assert.equal(typeof f.api.failAdmission, "function");
    const first = f.reserve(1), failure = failureFor(first.assignment);
    assert.throws(() => f.reserve(2), /capacity is occupied/);
    assert.equal(f.api.failAdmission(f.journal, failure).decision, "dispatch-failed");
    assert.throws(() => f.api.bindAdmission(f.journal, bindingFor(first.assignment)), /failed dispatch/);
    assert.equal(f.reserve(1).decision, "already-reserved", "retry never issues a second dispatch permission");
    assert.equal(f.reserve(2).decision, "permit-once");
    assert.equal(f.api.failAdmission(f.journal, failure).decision, "already-failed");
    assert.throws(() => f.reserve(3), /capacity is occupied/);
    assert.equal(f.api.readAdmission(f.journal).failures.length, 1);
    assert.equal(f.api.readAdmission(f.journal).completions?.length ?? 0, 0);
  }
});

test("failed dispatch receipts refuse changed identity, changed evidence, and bound assignments", async t => {
  const f = await roleAdmissionFixture(t), first = f.reserve(1), failure = failureFor(first.assignment);
  assert.equal(typeof f.api.failAdmission, "function");
  for (const key of ["project", "session", "epoch", "assignment", "issuer", "call"]) {
    assert.throws(() => f.api.failAdmission(f.journal, { ...failure, [key]: key === "epoch" || key === "assignment" ? f.activation : "other" }));
  }
  const bound = f.reserve(2); f.api.bindAdmission(f.journal, bindingFor(bound.assignment));
  assert.throws(() => f.api.failAdmission(f.journal, failureFor(bound.assignment)), /bound assignment/);
  f.api.changeAdmissionMode(f.journal, { ...f.scope, after: f.activation, turn: "b72422c7-509c-43aa-8c42-827c556f8a57", sage: false });
  assert.equal(f.api.failAdmission(f.journal, failure).decision, "dispatch-failed");
  assert.throws(() => f.api.failAdmission(f.journal, { ...failure, evidenceHash: "b".repeat(64) }), /different failure evidence/);
  assert.equal(f.api.readAdmission(f.journal).failures.length, 1);
});

test("concurrent failure and binding preserve one terminal history", async t => {
  const f = await roleAdmissionFixture(t), first = f.reserve(1);
  assert.equal(typeof f.api.failAdmission, "function");
  const code = `const input=JSON.parse(process.argv[1]); const api=await import(input.url);
    try { console.log(JSON.stringify(input.failure ? api.failAdmission(input.dir,input.failure) : api.bindAdmission(input.dir,input.binding))); }
    catch(error) { console.log(JSON.stringify({refused:error.message})); }`;
  const run = input => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, JSON.stringify({ url: f.url, dir: f.journal, ...input })], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let output = "", error = "";
    child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { error += bytes; });
    child.once("error", reject); child.once("close", status => {
      try { assert.equal(status, 0, error); resolve(JSON.parse(output)); } catch (e) { reject(e); }
    }); child.stdin.end();
  });
  const result = await Promise.all([run({ failure: failureFor(first.assignment) }), run({ binding: bindingFor(first.assignment) })]);
  assert.equal(result.filter(row => row.refused).length, 1);
  const state = f.api.readAdmission(f.journal);
  assert.equal(state.bindings.length + (state.failures?.length ?? 0), 1);
});

test('role edit policy matches the shared writer and independent review roles in both bundles', async t => {
  for (const provider of ['claude', 'codex']) {
    const f = await roleAdmissionFixture(t, undefined, provider);
    for (const role of ['chief-of-staff', 'lead', 'pe', 'code-reviewer', 'security-reviewer', 'ux-reviewer', 'qa'])
      assert.equal(f.api.roleEditDenied({ sage: true, role }), true, role);
    for (const role of ['implementer', 'designer', 'arena-judge'])
      assert.equal(f.api.roleEditDenied({ sage: true, role }), false, role);
    assert.equal(f.api.roleEditDenied({ sage: false, role: null }), false);
    for (const context of [{ sage: true, role: null }, { sage: true, role: 'other' }, { sage: false, role: 'other' },
      { sage: 'on', role: 'lead' }, { sage: true }, {}]) assert.throws(() => f.api.roleEditDenied(context));
  }
});

test('lead ownership permits only one active lead for a task across owners', async t => {
  for (const provider of ['claude', 'codex']) {
    const f = await roleAdmissionFixture(t, undefined, provider), first = f.reserve(1);
    const other = f.api.activateAdmission(f.journal, { project: f.scope.project, session: 'other-owner', activation: f.activation });
    const args = f.args(2, other.session, admissionScope(other)); args[2].task = 'T1';
    assert.throws(() => f.api.reserveRoleAdmission(...args, { issuerRole: 'chief-of-staff', role: 'lead' }), /active lead or team/);
    assert.equal(f.reserve(1).decision, 'already-reserved');
    assert.equal(f.reserve(3).decision, 'permit-once');
    const binding = bindingFor(first.assignment); f.api.bindAdmission(f.journal, binding); f.api.completeAdmission(f.journal, binding);
    assert.equal(f.api.reserveRoleAdmission(...args, { issuerRole: 'chief-of-staff', role: 'lead' }).decision, 'permit-once');
  }
});

test('lead ownership retains a task while the old team runs and releases proven failures', async t => {
  const f = await roleAdmissionFixture(t), first = f.reserve(1), lead = bindingFor(first.assignment, 'lead-child');
  f.api.bindAdmission(f.journal, lead);
  const args = f.args(2, 'lead-child'); args[2].task = 'T2';
  const child = f.api.reserveRoleAdmission(...args, { issuerRole: 'lead', role: 'qa' });
  f.api.completeAdmission(f.journal, lead);
  const next = f.args(3); next[2].task = 'T1';
  const replace = () => f.api.reserveRoleAdmission(...next, { issuerRole: 'chief-of-staff', role: 'lead' });
  assert.throws(replace, /active lead or team/);
  const bound = bindingFor(child.assignment, 'qa-child'); f.api.bindAdmission(f.journal, bound); f.api.completeAdmission(f.journal, bound);
  const replacement = replace(); assert.equal(replacement.decision, 'permit-once');
  f.api.failAdmission(f.journal, failureFor(replacement.assignment));
  const fresh = f.args(4); fresh[2].task = 'T1';
  assert.equal(f.api.reserveRoleAdmission(...fresh, { issuerRole: 'chief-of-staff', role: 'lead' }).decision, 'permit-once');
});

test('lead ownership chooses one task owner under concurrent distinct run requests', async t => {
  const { spawn } = await import('node:child_process'), f = await roleAdmissionFixture(t);
  const program = `import {reserveRoleAdmission} from ${JSON.stringify(f.url)};
    process.once('disconnect', () => process.exit(0));
    process.send({ready:true}); process.once('message', args=>{try{process.send({result:reserveRoleAdmission(...args)});}
    catch(error){process.send({error:error.message});}process.disconnect();});`;
  const children = [1, 2].map(index => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', program], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: process.env });
    let result, stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const ready = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', () => reject(Error('worker closed before ready'))); child.once('message', value => value.ready ? resolve() : reject(Error('worker not ready'))); });
    child.on('message', value => { if (!value.ready) result = value; });
    const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => {
      try { assert.equal(code, 0, stderr); assert.equal(signal, null); assert.equal(stdout, ''); assert.equal(stderr, ''); assert(result); resolve(result); }
      catch(error) { reject(error); }
    }); });
    const args = f.args(index); args[2].task = 'T1'; args.push({ issuerRole: 'chief-of-staff', role: 'lead' });
    ready.catch(() => {}); closed.catch(() => {});
    return { child, args, ready, closed };
  });
  t.after(async () => {
    for (const { child } of children) if (child.connected) child.disconnect();
    await Promise.allSettled(children.map(row => row.closed));
  });
  await Promise.all(children.map(row => row.ready)); for (const row of children) row.child.send(row.args);
  const results = await Promise.all(children.map(row => row.closed));
  assert.equal(results.filter(row => row.result?.decision === 'permit-once').length, 1);
  assert.equal(results.filter(row => /active lead or team/.test(row.error)).length, 1);
  assert.equal(f.api.readAdmission(f.journal).reservations.length, 1);
});

test('lead ownership preserves a main journal with historical overlapping leads and gates new work', async t => {
  const f = await roleAdmissionFixture(t);
  const fixture = json('scripts/fixtures/admission-overlapping-leads.json');
  assert.equal(fixture.source, 'c241ec1243aef19a68e9397a82bd5e5f7ff51aaf');
  const journal = join(f.journal, '..', 'upgrade-journal'); mkdirSync(journal);
  for (const record of fixture.records) writeFileSync(join(journal, String(record.revision).padStart(8, '0') + '.json'), JSON.stringify(record) + '\n');
  const state = f.api.readAdmission(journal);
  assert.equal(state.reservations.length, 2); assert.equal(state.completions.length, 1);
  const remaining = state.reservations[1].assignment;
  const scope = { project: remaining.project, session: remaining.session, epoch: remaining.epoch };
  const reserve = () => f.api.reserveRoleAdmission(journal, scope,
    {task:'T1',run:'R3',issuer:'root',call:'spawn-3'},
    {tool:'spawn',turn:'fixture-turn',name:'lead-3',argumentsHash:'a'.repeat(64)},
    {issuerRole:'chief-of-staff',role:'lead'});
  assert.throws(reserve, /active lead or team/);
  const binding = bindingFor(remaining); f.api.bindAdmission(journal, binding); f.api.completeAdmission(journal, binding);
  assert.equal(reserve().decision, 'permit-once');
  assert.equal(f.api.readAdmission(journal).completions.length, 2);
});

test('prepared run target is immutable and persists in both isolated provider bundles', async t => {
  for (const provider of ['claude', 'codex']) {
    const f = await roleAdmissionFixture(t, undefined, provider);
    const request = { task: 'T1', run: 'R1', issuer: 'root', name: 'pinned' };
    const plan = { issuerRole: 'chief-of-staff', role: 'lead' }, brief = completeBrief('Use the saved target.');
    const target = { task: 'T1', run: 'R1', role: 'lead', round: 0, taskBranch: 'codex/t1-work', runBranch: '', candidate: '' };
    const prepare = value => f.api.prepareAdmission(f.journal, f.scope, request, plan, brief, { runTarget: value });
    const saved = prepare(target).preparation;
    assert.deepEqual(saved.runTarget, target);
    assert.equal(prepare({ ...target }).decision, 'already-prepared');
    for (const key of ['taskBranch', 'runBranch', 'candidate', 'round'])
      assert.throws(() => prepare({ ...target, [key]: key === 'round' ? 1 : 'changed' }), /different work/);
    target.candidate = 'mutated caller';
    assert.equal(f.api.readAdmission(f.journal).preparations[0].runTarget.candidate, '');
    assert.equal(f.api.readAdmission(f.journal).reservations.length, 0);
  }
});

test('prepared run target rejects malformed or mismatched assignment fields before saving', async t => {
  const f = await roleAdmissionFixture(t);
  const target = { task: 'T1', run: 'R1', role: 'lead', round: 0, taskBranch: '', runBranch: '', candidate: '' };
  for (const value of [null, {}, { ...target, extra: true }, { ...target, task: 'T2' }, { ...target, run: 'R2' },
    { ...target, role: 'qa' }, { ...target, round: -1 }, { ...target, round: '0' },
    { ...target, round: Number.MAX_SAFE_INTEGER + 1 }, { ...target, candidate: 'bad\nfield' },
    { ...target, taskBranch: 1 }, { ...target, runBranch: 'x'.repeat(4097) }]) {
    assert.throws(() => f.api.prepareAdmission(f.journal, f.scope,
      { task: 'T1', run: 'R1', issuer: 'root', name: 'pinned' },
      { issuerRole: 'chief-of-staff', role: 'lead' }, completeBrief('Use the saved target.'), { runTarget: value }));
  }
  assert.equal(f.api.readAdmission(f.journal).preparations.length, 0);
});

async function continuationFixture(t, provider = 'codex', complete = true) {
  const f = await roleAdmissionFixture(t, { total: 1, projects: [{ project: 'project-a', limit: 1 }] }, provider);
  assert.equal(typeof f.api.reservePreparedContinuation, 'function', 'atomic continuation must ship');
  assert.equal(typeof f.api.bindContinuationAdmission, 'function', 'later-turn binding must ship');
  const first = f.reserve(1), prior = bindingFor(first.assignment, 'worker', 'turn-1');
  f.api.bindAdmission(f.journal, prior);
  if (complete) f.api.completeAdmission(f.journal, prior);
  const prepare = (n, changes = {}, role = 'lead', target = true) => {
    const request = { task: 'T1', run: `R${n}`, issuer: 'root', name: `continue-${n}`, ...changes };
    return f.api.prepareAdmission(f.journal, f.scope, request, { issuerRole: 'chief-of-staff', role }, completeBrief('Continue this task.'), target ? { runTarget: { task: request.task, run: request.run, role, round: 0, taskBranch: '', runBranch: '', candidate: '' } } : {}).preparation;
  };
  const args = (prepared, previous = first.assignment.id, call = `call-${prepared.name}`) => [f.journal, f.scope,
    { preparation: prepared.id, issuer: 'root', call, previous },
    { tool: 'followup', turn: 'parent-turn', name: prepared.name, argumentsHash: 'b'.repeat(64), taskHash: 'c'.repeat(64) }, 'chief-of-staff'];
  const reserve = (...input) => f.api.reservePreparedContinuation(...args(...input));
  return { ...f, first, prior, prepare, continuationArgs: args, continue: reserve };
}

test('continuation admission reserves and binds a new turn without releasing it through an old stop', async t => {
  for (const provider of ['claude', 'codex']) {
    const f = await continuationFixture(t, provider), prepared = f.prepare(2), saved = f.continue(prepared);
    assert.equal(saved.decision, 'permit-once');
    assert.equal(f.continue(prepared).decision, 'already-reserved');
    const next = bindingFor(saved.assignment, 'worker', 'turn-2');
    assert.throws(() => f.api.bindAdmission(f.journal, next), /matching assignment kind/);
    assert.throws(() => f.api.bindContinuationAdmission(f.journal, { ...next, child: 'foreign' }), /child differs/);
    assert.throws(() => f.api.bindContinuationAdmission(f.journal, { ...next, turn: f.prior.turn }), /turn is occupied/);
    assert.equal(f.api.bindContinuationAdmission(f.journal, next).decision, 'bound');
    assert.equal(f.api.bindContinuationAdmission(f.journal, next).decision, 'already-bound');
    assert.equal(f.api.completeAdmission(f.journal, f.prior).decision, 'already-completed');
    assert.throws(() => f.reserve(3), /capacity is occupied/);
    const state = f.api.readAdmission(f.journal);
    assert.deepEqual(state.bindings, [f.prior, next]);
    assert.deepEqual(state.completions, [f.prior]);
    assert.equal(state.reservations[1].continuation, f.first.assignment.id);
    assert.equal(f.api.completeAdmission(f.journal, next).decision, 'completed');
    assert.equal(f.reserve(3).decision, 'permit-once');
  }
});

test('continuation admission refuses unfinished foreign changed and unpinned work before a reservation', async t => {
  const f = await continuationFixture(t, 'codex', false), prepared = f.prepare(2);
  assert.throws(() => f.continue(prepared), /same completed task/);
  f.api.completeAdmission(f.journal, f.prior);
  for (const p of [f.prepare(3, { task: 'T2' }), f.prepare(4, {}, 'qa'), f.prepare(5, {}, 'lead', false)])
    assert.throws(() => f.continue(p), /same completed task|saved run target/);
  const noHash = f.continuationArgs(prepared); delete noHash[3].taskHash;
  assert.throws(() => f.api.reservePreparedContinuation(...noHash), /task hash/);
  const foreign = f.continuationArgs(prepared); foreign[2].issuer = 'other';
  assert.throws(() => f.api.reservePreparedContinuation(...foreign), /differs from its preparation/);
  assert.throws(() => f.continue(prepared, modeNextTurn), /same completed task/);
  const reusedRun = f.prepare(6, { run: 'R1' });
  assert.throws(() => f.continue(reusedRun), /run already has a dispatch/);
  assert.throws(() => f.api.bindContinuationAdmission(f.journal, f.prior), /matching assignment kind/);
  assert.equal(f.api.readAdmission(f.journal).reservations.length, 1);
  assert.equal(f.continue(prepared).decision, 'permit-once');
});

test('continuation admission retains one linear history across retries mode changes and restart reads', async t => {
  const f = await continuationFixture(t), second = f.prepare(2), competitor = f.prepare(3), third = f.prepare(4);
  const saved = f.continue(second), next = bindingFor(saved.assignment, 'worker', 'turn-2');
  f.api.bindContinuationAdmission(f.journal, next);
  assert.throws(() => f.continue(competitor), /predecessor already has later work/);
  const initialArgs = f.continuationArgs(second); delete initialArgs[2].previous;
  assert.throws(() => f.api.reservePreparedAdmission(...initialArgs), /different work/);
  const { child, turn, ...failure } = next;
  assert.throws(() => f.api.failAdmission(f.journal, { ...failure, evidenceHash: 'd'.repeat(64) }), /separate evidence/);
  f.api.changeAdmissionMode(f.journal, { ...f.scope, after: f.activation, turn: modeTurn, sage: false });
  assert.equal(f.continue(second).decision, 'already-reserved');
  f.api.completeAdmission(f.journal, next);
  assert.throws(() => f.continue(third, saved.assignment.id), /mode is off/);
  f.api.changeAdmissionMode(f.journal, { ...f.scope, after: modeTurn, turn: modeNextTurn, sage: true });
  const last = f.continue(third, saved.assignment.id), final = bindingFor(last.assignment, 'worker', 'turn-3');
  f.api.bindContinuationAdmission(f.journal, final);
  assert.equal(f.api.completeAdmission(f.journal, next).decision, 'already-completed');
  assert.equal(f.api.readAdmission(f.journal).completions.length, 2);
  assert.equal(f.api.readAdmission(f.journal).bindings.length, 3);
  assert.throws(() => f.reserve(8), /capacity is occupied/);
});

test('continuation admission gives one permit when two processes compete for the same completed child', async t => {
  const f = await continuationFixture(t), proposals = [f.prepare(2), f.prepare(3)];
  const script = `const input=JSON.parse(process.argv[1]);const api=await import(input.url);
    try { console.log(JSON.stringify(api.reservePreparedContinuation(...input.args))); }
    catch(error) { console.log(JSON.stringify({refused:error.message})); }`;
  const run = prepared => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script,
      JSON.stringify({ url: f.url, args: f.continuationArgs(prepared) })], { shell: false });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.once('error', reject); child.once('close', code => {
      try { assert.equal(code, 0, stderr); assert.equal(stderr, ''); resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    }); child.stdin.end();
  });
  const settled = await Promise.allSettled(proposals.map(run));
  for (const row of settled) assert.equal(row.status, "fulfilled", row.reason?.message);
  const result = settled.map(row => row.value);
  assert.equal(result.filter(row => row.decision === 'permit-once').length, 1);
  assert.equal(result.filter(row => /predecessor already has later work/.test(row.refused)).length, 1);
  assert.equal(f.api.readAdmission(f.journal).reservations.length, 2);
});

test('continuation admission restores a lead role only after the new turn binds', async t => {
  const f = await continuationFixture(t), prepared = f.prepare(2), saved = f.continue(prepared);
  const prepareChild = () => f.api.prepareAdmission(f.journal, f.scope,
    { task: 'T1', run: 'R3', issuer: 'worker', name: 'review' }, { issuerRole: 'lead', role: 'qa' }, completeBrief('Review the change.'));
  assert.throws(prepareChild, /completed issuer/);
  const next = bindingFor(saved.assignment, 'worker', 'turn-2');
  f.api.bindContinuationAdmission(f.journal, next);
  assert.equal(prepareChild().decision, 'prepared');
  f.api.completeAdmission(f.journal, next);
  assert.throws(prepareChild, /completed issuer/);
});

test('continuation admission resumes the same lead with its running children and preserves every slot', async t => {
  const f = await roleAdmissionFixture(t, { total: 4, projects: [{ project: 'project-a', limit: 4 }] });
  assert.equal(typeof f.api.reservePreparedContinuation, 'function');
  const first = f.reserve(1), lead = bindingFor(first.assignment, 'lead-worker', 'lead-turn-1');
  f.api.bindAdmission(f.journal, lead);
  const child = n => f.api.reserveRoleAdmission(f.journal, f.scope,
    { task: 'T1', run: `R${n}`, issuer: 'lead-worker', call: `child-call-${n}` },
    { tool: 'spawn', turn: 'lead-turn-1', name: `child-${n}`, argumentsHash: 'a'.repeat(64) },
    { issuerRole: 'lead', role: 'qa' });
  for (const n of [2, 3]) {
    const saved = child(n); f.api.bindAdmission(f.journal, bindingFor(saved.assignment, `child-${n}`, `child-turn-${n}`));
  }
  f.api.completeAdmission(f.journal, lead);
  const prepared = f.api.prepareAdmission(f.journal, f.scope,
    { task: 'T1', run: 'R4', issuer: 'root', name: 'resumed-lead' }, { issuerRole: 'chief-of-staff', role: 'lead' },
    completeBrief('Continue with the existing team.'),
    { runTarget: { task: 'T1', run: 'R4', role: 'lead', round: 0, taskBranch: '', runBranch: '', candidate: '' } }).preparation;
  const resumed = f.api.reservePreparedContinuation(f.journal, f.scope,
    { preparation: prepared.id, previous: first.assignment.id, issuer: 'root', call: 'resume-lead' },
    { tool: 'followup', turn: 'parent-turn', name: prepared.name, argumentsHash: 'b'.repeat(64), taskHash: 'c'.repeat(64) }, 'chief-of-staff');
  assert.equal(resumed.decision, 'permit-once');
  f.api.bindContinuationAdmission(f.journal, bindingFor(resumed.assignment, lead.child, 'lead-turn-2'));
  assert.equal(child(5).decision, 'permit-once');
  assert.throws(() => child(6), /three child slots/);
  assert.equal(f.api.completeAdmission(f.journal, lead).decision, 'already-completed');
  assert.throws(() => f.reserve(7), /capacity is occupied/);
  const state = f.api.readAdmission(f.journal);
  assert.equal(state.reservations.length - state.completions.length, 4);
  assert.deepEqual(state.completions, [lead]);
});

test('continuation preparation pins its predecessor and prevents conversion to an initial dispatch', async t => {
  for (const provider of ['claude', 'codex']) {
    const f = await continuationFixture(t, provider);
    const request = { task: 'T1', run: 'R2', issuer: 'root', name: 'pinned-continuation' };
    const plan = { issuerRole: 'chief-of-staff', role: 'lead' }, brief = completeBrief('Continue the saved work.');
    const target = { task: 'T1', run: 'R2', role: 'lead', round: 0, taskBranch: '', runBranch: '', candidate: '' };
    const prepare = previous => f.api.prepareAdmission(f.journal, f.scope, request, plan, brief, { runTarget: target, continuation: previous });
    const saved = prepare(f.first.assignment.id).preparation;
    assert.equal(saved.continuation, f.first.assignment.id);
    assert.equal(prepare(f.first.assignment.id).decision, 'already-prepared');
    assert.throws(() => prepare(modeNextTurn), /different work/);
    const args = f.continuationArgs(saved); delete args[2].previous;
    assert.throws(() => f.api.reservePreparedAdmission(...args), /differs from its preparation/);
    assert.equal(f.continue(saved).decision, 'permit-once');
  }
});




test('continuation preparation options reject unknown or malformed fields without changing the journal', async t => {
  const f = await roleAdmissionFixture(t);
  const before = f.api.readAdmission(f.journal);
  for (const options of [null, [], true, {unknown:true}, {continuation:'not-an-assignment'}, {runTarget:null}]) {
    assert.throws(() => f.api.prepareAdmission(f.journal, f.scope,
      {task:'T1',run:'R2',issuer:'root',name:'invalid-options'},
      {issuerRole:'chief-of-staff',role:'lead'}, completeBrief('Keep the current task.'), options));
    assert.deepEqual(f.api.readAdmission(f.journal), before);
  }
});

test('run claims refuse another dispatch across names owners and task labels', async t => {
  const f = await roleAdmissionFixture(t), first = f.reserve(1);
  const other = f.api.activateAdmission(f.journal, { project: f.scope.project, session: 'other-root', activation: f.activation });
  const scope = admissionScope(other), args = f.args(2, 'other-root', scope);
  args[2].run = 'R1'; args[2].task = 'T2';
  for (const kind of ['plain', 'role', 'brief', 'prepared']) {
    const reserve = () => {
      if (kind === 'plain') return f.api.reserveAdmission(...args);
      const plan = { issuerRole: 'chief-of-staff', role: 'qa' };
      if (kind === 'role') return f.api.reserveRoleAdmission(...args, plan);
      if (kind === 'brief') return f.api.reserveBriefAdmission(...args, plan, completeBrief('Check the work.'));
      const prepared = f.api.prepareAdmission(f.journal, scope,
        { task: 'T2', run: 'R1', issuer: 'other-root', name: 'agent-2' }, plan, completeBrief('Check the work.'));
      return f.api.reservePreparedAdmission(f.journal, scope,
        { preparation: prepared.preparation.id, issuer: 'other-root', call: 'spawn-2' }, args[3], 'chief-of-staff');
    };
    assert.throws(reserve, /run already has a dispatch/, kind);
  }
  assert.equal(f.api.readAdmission(f.journal).reservations.length, 1);
  assert.deepEqual(f.reserve(1), { decision: 'already-reserved', assignment: first.assignment });
  const otherProject = f.api.activateAdmission(f.journal, { project: 'project-b', session: 'other-root', activation: f.activation });
  assert.equal(f.reserve(1, 'lead', 'chief-of-staff', 'other-root', admissionScope(otherProject)).decision, 'permit-once');
});

test('run claims allow proven pre-child failure retry but never reopen completed execution', async t => {
  const f = await roleAdmissionFixture(t), first = f.reserve(1), failure = failureFor(first.assignment);
  const nextArgs = f.args(2); nextArgs[2].run = 'R1';
  const reserve = () => f.api.reserveRoleAdmission(...nextArgs, { issuerRole: 'chief-of-staff', role: 'lead' });
  assert.throws(reserve, /run already has a dispatch/);
  f.api.failAdmission(f.journal, failure);
  const next = reserve(); assert.equal(next.decision, 'permit-once');
  assert.notEqual(next.assignment.id, first.assignment.id);
  assert.equal(f.api.failAdmission(f.journal, failure).decision, 'already-failed');
  assert.throws(() => f.api.bindAdmission(f.journal, bindingFor(first.assignment)), /failed dispatch/);
  const third = f.args(3); third[2].run = 'R1';
  assert.throws(() => f.api.reserveAdmission(...third), /run already has a dispatch/);
  const binding = bindingFor(next.assignment); f.api.bindAdmission(f.journal, binding); f.api.completeAdmission(f.journal, binding);
  assert.throws(() => f.api.reserveAdmission(...third), /run already has a dispatch/);
  assert.equal(reserve().decision, 'already-reserved');
  assert.equal(f.reserve(4).decision, 'permit-once');
  assert.equal(f.api.readAdmission(f.journal).reservations.length, 3);
});

test('run claims choose one winner for concurrent distinct dispatches of the same run', async t => {
  const { spawn } = await import('node:child_process');
  const f = await roleAdmissionFixture(t);
  const owners = ['owner-a', 'owner-b'].map(session => f.api.activateAdmission(f.journal,
    { project: f.scope.project, session, activation: f.activation }));
  const program = `import {reserveAdmission} from ${JSON.stringify(f.url)};
    process.once('disconnect', () => process.exit(0));
    process.send({ready:true}); process.once('message', args=>{try{process.send({result:reserveAdmission(...args)});}
    catch(error){process.send({error:error.message});}process.disconnect();});`;
  const children = owners.map((owner, index) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', program], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: process.env });
    let result, stderr = '', stdout = '';
    child.stderr.on('data', data => { stderr += data; }); child.stdout.on('data', data => { stdout += data; });
    const ready = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', () => reject(Error('worker closed before ready'))); child.once('message', value => value.ready ? resolve() : reject(Error('worker not ready'))); });
    child.on('message', value => { if (!value.ready) result = value; });
    const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => {
      try { assert.equal(code, 0, stderr); assert.equal(signal, null); assert.equal(stderr, ''); assert.equal(stdout, ''); assert(result); resolve(result); }
      catch(error) { reject(error); }
    }); });
    const args = f.args(index + 1, owner.session, admissionScope(owner)); args[2].run = 'R1';
    ready.catch(() => {}); closed.catch(() => {});
    return { child, args, ready, closed };
  });
  t.after(async () => {
    for (const { child } of children) if (child.connected) child.disconnect();
    await Promise.allSettled(children.map(row => row.closed));
  });
  await Promise.all(children.map(row => row.ready));
  for (const row of children) row.child.send(row.args);
  const settled = await Promise.allSettled(children.map(row => row.closed));
  for (const row of settled) assert.equal(row.status, "fulfilled", row.reason?.message);
  const results = settled.map(row => row.value);
  assert.equal(results.filter(row => row.result?.decision === 'permit-once').length, 1);
  assert.equal(results.filter(row => /run already has a dispatch/.test(row.error)).length, 1);
  assert.equal(f.api.readAdmission(f.journal).reservations.length, 1);
});


test('run claims preserve historical duplicate dispatches and still refuse new duplication', async t => {
  for (const provider of ['claude', 'codex']) {
    const f = await roleAdmissionFixture(t, undefined, provider);
    const fixture = json('scripts/fixtures/admission-duplicate-runs.json');
    const journal = join(f.journal, '..', 'upgrade-journal'); mkdirSync(journal);
    for (const record of fixture.records) writeFileSync(join(journal, String(record.revision).padStart(8, '0') + '.json'), JSON.stringify(record) + '\n');
    const bytes = readdirSync(journal).sort().map(file => readFileSync(join(journal, file), 'utf8'));
    const state = f.api.readAdmission(journal);
    assert.deepEqual(state.reservations.map(row => [row.assignment.task, row.assignment.run]), [['T1', 'R1'], ['T2', 'R1']]);
    const first = state.reservations[0], second = state.reservations[1];
    const { project, session, epoch } = first.assignment, scope = {project, session, epoch};
    const reserve = run => f.api.reserveAdmission(journal, scope,
      {task:'T3',run,issuer:'root',call:'spawn-3'},
      {tool:'spawn',turn:'fixture-turn',name:'worker-3',argumentsHash:'a'.repeat(64)});
    assert.throws(() => reserve('R1'), /run already has a dispatch/);
    assert.deepEqual(readdirSync(journal).sort().map(file => readFileSync(join(journal, file), 'utf8')), bytes);
    f.api.failAdmission(journal, failureFor(first.assignment));
    assert.throws(() => reserve('R1'), /run already has a dispatch/);
    const binding = bindingFor(second.assignment); f.api.bindAdmission(journal, binding); f.api.completeAdmission(journal, binding);
    assert.throws(() => reserve('R1'), /run already has a dispatch/);
    assert.equal(reserve('R2').decision, 'permit-once');
    assert.equal(f.api.readAdmission(journal).reservations.length, 3);
    for (const [index, record] of fixture.records.entries())
      assert.equal(readFileSync(join(journal, String(record.revision).padStart(8, '0') + '.json'), 'utf8'), bytes[index]);
  }
});

const reviewTarget = () => ({ branch: 'codex/t1-review', sha: 'a'.repeat(40), round: 0, cycle: 1 });

test('saved review targets retain every review role and link reservations to immutable scope', async t => {
  for (const provider of ['claude', 'codex']) for (const role of ['code-reviewer', 'security-reviewer', 'ux-reviewer', 'qa']) {
    const f = await roleAdmissionFixture(t, undefined, provider), review = reviewTarget();
    const request = {task:'T1',run:'R1',issuer:'root',name:'agent-1'};
    const save = options => f.api.prepareAdmission(f.journal, f.scope, request,
      {issuerRole:'chief-of-staff',role}, completeBrief('Review the saved commit.'), options);
    const first = save({review});
    assert.deepEqual(first.preparation.review, reviewTarget());
    assert.equal(save({review}).decision, 'already-prepared');
    const before = f.api.readAdmission(f.journal);
    for (const changed of [{...review,branch:'codex/t2-review'}, {...review,sha:'b'.repeat(40)}, {...review,round:1}, {...review,cycle:2}])
      assert.throws(() => save({review:changed}), /different work/);
    assert.throws(() => save({}), /different work/);
    assert.deepEqual(f.api.readAdmission(f.journal), before);
    review.sha = 'c'.repeat(40); first.preparation.review.cycle = 7;
    const receipt = f.api.reservePreparedAdmission(f.journal, f.scope,
      {preparation:first.preparation.id,issuer:'root',call:'spawn-1'}, f.args(1)[3], 'chief-of-staff');
    assert.equal(receipt.decision, 'permit-once');
    const saved = f.api.readAdmission(f.journal);
    assert.equal(saved.reservations[0].preparation, first.preparation.id);
    assert.deepEqual(saved.preparations[0].review, reviewTarget());
    const script = `import {readAdmission} from ${JSON.stringify(f.url)}; console.log(JSON.stringify(readAdmission(process.argv[1]).preparations[0].review));`;
    const restarted = spawnSync(process.execPath, ['--input-type=module','-e',script,f.journal], {encoding:'utf8',env:process.env});
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.deepEqual(JSON.parse(restarted.stdout), reviewTarget());
  }
});

test('saved review target validation refuses invalid fresh scopes without writing', async t => {
  const f = await roleAdmissionFixture(t), good = reviewTarget();
  assert.deepEqual(f.api.parseReviewTarget(good), good);
  const invalid = [null, [], {}, {...good,extra:true}, ...['main','MASTER','HEAD','refs/a','a..b','a.lock','a b'].map(branch=>({...good,branch})),
    ...['A'.repeat(40),'a'.repeat(39),'z'.repeat(40)].map(sha=>({...good,sha})),
    ...[-1,0.5,Number.MAX_SAFE_INTEGER+1,'0',NaN,Infinity].map(round=>({...good,round})),
    ...[0,11,1.5,'1',NaN,Infinity].map(cycle=>({...good,cycle}))];
  const before = f.api.readAdmission(f.journal);
  for (const review of invalid) {
    assert.throws(() => f.api.prepareAdmission(f.journal, f.scope,
      {task:'T1',run:'R1',issuer:'root',name:'fresh-review'}, {issuerRole:'chief-of-staff',role:'qa'},
      completeBrief('Review the saved commit.'), {review}));
    assert.deepEqual(f.api.readAdmission(f.journal), before);
  }
  assert.deepEqual(f.api.parseReviewTarget({...good,round:Number.MAX_SAFE_INTEGER,cycle:10}), {...good,round:Number.MAX_SAFE_INTEGER,cycle:10});
  for (const role of ['lead','pe','designer','arena-judge','implementer']) {
    assert.throws(() => f.api.prepareAdmission(f.journal, f.scope,
      {task:'T1',run:'R1',issuer:'root',name:'not-review'}, {issuerRole:'chief-of-staff',role}, completeBrief('Do the work.'), {review:good}), /only a review role/);
    assert.deepEqual(f.api.readAdmission(f.journal), before);
  }
});

test('saved review targets coexist with pinned run targets and prepared continuations', async t => {
  const f = await roleAdmissionFixture(t), first = f.reserve(1, 'qa');
  const bound = bindingFor(first.assignment); f.api.bindAdmission(f.journal, bound); f.api.completeAdmission(f.journal, bound);
  const review = reviewTarget(), runTarget = {task:'T1',run:'R2',role:'qa',round:0,taskBranch:review.branch,runBranch:'',candidate:review.sha};
  const prepared = f.api.prepareAdmission(f.journal, f.scope,
    {task:'T1',run:'R2',issuer:'root',name:'continued-review'}, {issuerRole:'chief-of-staff',role:'qa'},
    completeBrief('Review again.'), {review,runTarget,continuation:first.assignment.id}).preparation;
  assert.deepEqual(prepared.review, review);
  assert.deepEqual(prepared.runTarget, runTarget);
  assert.equal(prepared.continuation, first.assignment.id);
  const next = f.api.reservePreparedContinuation(f.journal, f.scope,
    {preparation:prepared.id,issuer:'root',call:'follow-2',previous:first.assignment.id},
    {tool:'followup',turn:'parent-turn',name:prepared.name,argumentsHash:'b'.repeat(64),taskHash:'c'.repeat(64)}, 'chief-of-staff');
  assert.equal(next.decision, 'permit-once');
  assert.equal(f.api.readAdmission(f.journal).reservations[1].preparation, prepared.id);
});

function claimedReview(role, changes = {}) {
  const target = reviewTarget();
  return { STATUS:'done', RESULT:role === 'qa' ? 'PASS' : 'CLEAN',
    EVIDENCE:JSON.stringify({commit:target.sha,round:target.round,cycle:target.cycle,summary:'Reviewed the saved change.'}),
    FINDINGS:'[]', QUESTIONS:'none', 'NOT VERIFIED':'Real model behavior.', BRANCH:target.branch, ...changes };
}

test('review claims map every clean and blocking result without accepting a verdict', async t => {
  for (const provider of ['claude','codex']) {
    const f = await roleAdmissionFixture(t, undefined, provider), before = f.api.readAdmission(f.journal);
    for (const [role,kind] of [['code-reviewer','review-clean'],['security-reviewer','security-clean'],['ux-reviewer','ux-clean'],['qa','qa-pass']]) {
      const report = claimedReview(role), original = structuredClone(report), target = reviewTarget();
      const clean = f.api.parseReviewReport(report, role, target);
      assert.deepEqual(clean, {kind,evidence:{commit:target.sha,round:0,cycle:1,summary:'Reviewed the saved change.'},findings:[]});
      for (const severity of ['low','medium','high']) {
        const findings = [{severity,summary:'A concrete finding.'}];
        const result = severity === 'low' ? report.RESULT : role === 'qa' ? 'FAIL' : 'FINDINGS';
        const parsed = f.api.parseReviewReport({...report,RESULT:result,FINDINGS:JSON.stringify(findings)},role,target);
        assert.equal(parsed.kind, severity === 'low' ? kind : role === 'qa' ? 'qa-fail' : 'findings');
        assert.deepEqual(parsed.findings,findings);
      }
      assert.deepEqual(report, original); assert.deepEqual(target, reviewTarget());
      clean.evidence.commit = 'b'.repeat(40);
      assert.equal(f.api.parseReviewReport(report,role,target).evidence.commit,'a'.repeat(40));
    }
    assert.deepEqual(f.api.readAdmission(f.journal), before);
  }
});

test('review claims refuse changed targets unanswered questions and contradictory findings', async t => {
  const f = await roleAdmissionFixture(t);
  assert.equal(f.api.parseReviewReport(claimedReview('qa'),'qa',reviewTarget()).kind,'qa-pass');
  for (const role of ['code-reviewer','security-reviewer','ux-reviewer','qa']) {
    const good = claimedReview(role), evidence = JSON.parse(good.EVIDENCE);
    const changes = [{BRANCH:'codex/t2'}, {STATUS:'blocked'}, {STATUS:'question'}, {QUESTIONS:'Please approve this.'},
      {RESULT:'done'}, {RESULT:role === 'qa' ? 'CLEAN' : 'PASS'},
      ...[{commit:'b'.repeat(40)},{round:1},{cycle:2}].map(change=>({EVIDENCE:JSON.stringify({...evidence,...change})})),
      {FINDINGS:JSON.stringify([{severity:'medium',summary:'A blocking finding.'}])},
      {RESULT:role === 'qa' ? 'FAIL' : 'FINDINGS'},
      {RESULT:role === 'qa' ? 'FAIL' : 'FINDINGS',FINDINGS:JSON.stringify([{severity:'low',summary:'A small finding.'}])}];
    for (const change of changes) assert.throws(()=>f.api.parseReviewReport({...good,...change},role,reviewTarget()), /does not match/);
  }
  for (const role of ['lead','implementer','chief-of-staff','unknown',null])
    assert.throws(()=>f.api.parseReviewReport(claimedReview('qa'),role,reviewTarget()),/does not match/);
});

test('review claims refuse malformed input with fixed errors and no caller mutation', async t => {
  const f = await roleAdmissionFixture(t), good = claimedReview('qa'), evidence = JSON.parse(good.EVIDENCE);
  assert.equal(f.api.parseReviewReport(good,'qa',reviewTarget()).kind,'qa-pass');
  const inputs = [null,[],{}, {...good,EXTRA:'private'}, {...good,QUESTIONS:null}, {...good,EVIDENCE:'{private invalid json'},
    ...[null,[],{...evidence,extra:true},{...evidence,summary:''},{...evidence,summary:'private\u0001'}].map(value=>({...good,EVIDENCE:JSON.stringify(value)})),
    ...[null,{},[null],[{severity:'critical',summary:'private'}],[{severity:'low',summary:''}],[{severity:'low',summary:'private',extra:true}]].map(value=>({...good,FINDINGS:JSON.stringify(value)})),
    {...good,EVIDENCE:'x'.repeat(32769)}];
  for (const input of inputs) {
    const before = structuredClone(input);
    assert.throws(()=>f.api.parseReviewReport(input,'qa',reviewTarget()), error => error.message === 'The review report does not match its target or findings');
    assert.deepEqual(input,before);
  }
});

async function targetedNativeFixture(t, role = 'qa') {
  const f = await nativeBindingFixture(t);
  const instructions = await import(new URL('../runtime/instructions.mjs', f.url));
  const review = reviewTarget(), runTarget = {task:'T1',run:'R1',role,round:0,taskBranch:review.branch,runBranch:'',candidate:review.sha};
  const prepared = f.api.prepareAdmission(f.journal,f.scope,
    {task:'T1',run:'R1',issuer:f.root,name:'agent_1'}, {issuerRole:'chief-of-staff',role},
    completeBrief('Review this saved target.'), {review,runTarget}).preparation;
  const message = instructions.preparedTaskMessage(prepared);
  const {createHash} = await import('node:crypto');
  const dispatch = {tool:'collaborationspawn_agent',turn:f.activation,name:'agent_1',argumentsHash:'a'.repeat(64),taskHash:createHash('sha256').update(message).digest('hex')};
  const saved = f.api.reservePreparedAdmission(f.journal,f.scope,
    {preparation:prepared.id,issuer:f.root,call:'spawn-1'},dispatch,'chief-of-staff');
  const base = {schema:1,runtime:'0.160.0',session:f.root,actor:f.root,call:'spawn-1',turn:f.activation};
  f.events.publish(f.observationsDirectory,{...base,kind:'spawn-request',name:'agent_1'});
  f.events.publish(f.observationsDirectory,{...base,kind:'spawn-result',path:'/root/agent_1'});
  const options = {directory:f.journal,project:f.scope.project,observationsDirectory:f.observationsDirectory};
  return {...f,instructions,review,runTarget,prepared,message,saved,options};
}

test('target instructions deliver exact review scope and report values for every reviewer', async t => {
  for (const role of ['code-reviewer','security-reviewer','ux-reviewer','qa']) {
    const f = await targetedNativeFixture(t,role);
    const delivered = f.instructions.boundChildInstructions(f.options,f.identity());
    assert.equal(delivered.decision,'deliver');
    for (const text of [f.message,delivered.brief]) {
      assert(text.includes('# Saved run target\n\nTask round: 0\nTask branch: codex/t1-review\nRun branch: none\nCandidate: '+ 'a'.repeat(40)));
      assert(text.includes('# Review target\n\nBranch: codex/t1-review\nCommit: '+ 'a'.repeat(40)+'\nTask round: 0\nReview cycle: 1'));
      assert(text.includes(role === 'qa' ? 'RESULT is PASS or FAIL.' : 'RESULT is CLEAN or FINDINGS.'));
      assert(text.includes('only the chief can accept the review'));
      const evidence = /EVIDENCE must be a JSON object with exactly these fields: (\{[^\n]+\})/.exec(text);
      assert(evidence, 'the child receives the exact evidence format');
      const claims = f.api.parseReviewReport({...claimedReview(role),EVIDENCE:evidence[1]},role,f.review);
      assert.equal(claims.evidence.commit,f.review.sha); assert.equal(claims.evidence.cycle,1);
    }
    assert.deepEqual(f.instructions.boundChildInstructions(f.options,f.identity()),delivered);
    assert.equal(f.api.readAdmission(f.journal).bindings.length,1);
  }
});

test('target instructions use only the linked preparation despite changed receipts or other saved work', async t => {
  const f = await targetedNativeFixture(t);
  f.api.prepareAdmission(f.journal,f.scope,{task:'T2',run:'R2',issuer:f.root,name:'other'},
    {issuerRole:'chief-of-staff',role:'qa'},completeBrief('Other work.'),{review:{...f.review,sha:'b'.repeat(40)}});
  f.prepared.review.sha='c'.repeat(40); f.prepared.runTarget.candidate='d'.repeat(40);
  const bound = f.bind(f.identity());
  assert.deepEqual(bound.review,f.review); assert.deepEqual(bound.runTarget,f.runTarget);
  bound.review.sha='e'.repeat(40); bound.runTarget.candidate='f'.repeat(40);
  const text = f.instructions.boundChildInstructions(f.options,f.identity()).brief;
  assert(text.includes('Commit: '+ 'a'.repeat(40)));
  for (const letter of ['b','c','d','e','f']) assert(!text.includes(letter.repeat(40)));
  assert.throws(()=>f.instructions.boundChildInstructions(f.options,{...f.identity(),path:'/root/other'}));
  assert.equal(f.api.readAdmission(f.journal).bindings.length,1);
});

test('T289: native reviewer instructions deliver one parseable findings contract', async t => {
  const f = await targetedNativeFixture(t, 'qa');
  const text = f.instructions.boundChildInstructions(f.options, f.identity()).brief;
  assert.doesNotMatch(text, /Under FINDINGS, write `none` alone|The hook reads the report of a review/);
  assert.match(text, /these EVIDENCE and FINDINGS formats replace the general report values above/);
  assert.match(text, /FINDINGS must be a JSON array/);
  const evidence = JSON.parse(/EVIDENCE must be a JSON object with exactly these fields: (\{[^\n]+\})/.exec(text)[1]);
  const report = { STATUS: 'done', RESULT: 'PASS', EVIDENCE: JSON.stringify(evidence),
    FINDINGS: '[]', QUESTIONS: 'none', 'NOT VERIFIED': 'Live deployment', BRANCH: f.review.branch };
  assert.equal(f.api.parseReviewReport(report, 'qa', f.review).kind, 'qa-pass');
  const problem = { severity: 'high', summary: 'An empty input loses the saved row; reproduced by the review.' };
  const failed = f.api.parseReviewReport({ ...report, RESULT: 'FAIL', FINDINGS: JSON.stringify([problem]) }, 'qa', f.review);
  assert.equal(failed.kind, 'qa-fail');
  assert.deepEqual(failed.findings, [problem]);
});

test('target instructions include writer scope without introducing reviewer report rules', async t => {
  const f = await roleAdmissionFixture(t);
  const instructions = await import(new URL('../runtime/instructions.mjs',f.url));
  const runTarget = {task:'T1',run:'R1',role:'implementer',round:2,taskBranch:'codex/t1-task',runBranch:'codex/r1-work',candidate:''};
  const prepared = f.api.prepareAdmission(f.journal,f.scope,{task:'T1',run:'R1',issuer:'root',name:'writer'},
    {issuerRole:'chief-of-staff',role:'implementer'},completeBrief('Build the saved work.'),{runTarget}).preparation;
  const text = instructions.preparedTaskMessage(prepared);
  assert(text.includes('Task round: 2\nTask branch: codex/t1-task\nRun branch: codex/r1-work\nCandidate: none'));
  assert(!text.includes('# Review target')); assert(!text.includes('# Review report values'));
  const plain = f.api.prepareAdmission(f.journal,f.scope,{task:'T2',run:'R2',issuer:'root',name:'plain'},
    {issuerRole:'chief-of-staff',role:'implementer'},completeBrief('Ordinary saved work.')).preparation;
  const ordinary = instructions.preparedTaskMessage(plain);
  assert(ordinary.includes('Ordinary saved work.'));
  assert(!ordinary.includes('# Saved run target')); assert(!ordinary.includes('# Review target'));
});

async function nativeContinuationFixture(t) {
  const f = await nativeBindingFixture(t);
  const { createHash } = await import('node:crypto');
  const childTools = await import(new URL('../runtime/child-tool.mjs', f.url));
  const stops = await import(new URL('../runtime/child-stop.mjs', f.url));
  const instructions = await import(new URL('../runtime/instructions.mjs', f.url));
  const first = f.reserve(1, 'qa', 'chief-of-staff');
  const prior = f.bind(f.identity()).binding;
  f.api.completeAdmission(f.journal, prior);
  const observationsRoot = join(f.journal, '..', 'native-observations'), observations = join(observationsRoot, f.root);
  cpSync(f.observationsDirectory, observations, { recursive: true });
  const sessionsDir = join(f.journal, '..', 'sessions'); mkdirSync(sessionsDir);
  const transcript = join(sessionsDir, 'child.jsonl'), sender = join(sessionsDir, 'root.jsonl');
  const turn = '44444444-4444-4444-8444-444444444444';
  const review = reviewTarget(), runTarget = {task:'T1',run:'R2',role:'qa',round:0,taskBranch:review.branch,runBranch:'',candidate:review.sha};
  const prepared = f.api.prepareAdmission(f.journal, f.scope, {task:'T1',run:'R2',issuer:f.root,name:'next'},
    {issuerRole:'chief-of-staff',role:'qa'}, completeBrief('Review the next saved assignment.'), {review,runTarget}).preparation;
  const message = instructions.preparedTaskMessage(prepared);
  const saved = f.api.reservePreparedContinuation(f.journal,f.scope,
    {preparation:prepared.id,issuer:f.root,call:'followup-1',previous:first.id},
    {tool:'collaborationfollowup_task',turn:f.activation,name:'next',argumentsHash:'b'.repeat(64),taskHash:createHash('sha256').update(message).digest('hex')},'chief-of-staff');
  const start = value => [{type:'event_msg',payload:{type:'task_started',turn_id:value}},{type:'turn_context',payload:{turn_id:value}}];
  const childPrefix = [{type:'session_meta',payload:{id:f.lead,session_id:f.root,parent_thread_id:f.root,agent_path:'/root/agent_1',cli_version:'0.160.0'}},
    ...start(f.activation),{type:'event_msg',payload:{type:'task_complete',turn_id:f.activation}}];
  const delivery = [...start(turn),{type:'response_item',payload:{type:'agent_message',id:'amsg_next',author:'/root',recipient:'/root/agent_1',content:[{type:'encrypted_content',encrypted_content:message}]}}];
  const accepted = [{type:'session_meta',payload:{id:f.root,session_id:f.root,cli_version:'0.160.0'}},...start(f.activation),
    {type:'response_item',metadata:{client_authored:false},payload:{type:'function_call',name:'followup_task',namespace:'collaboration',call_id:'followup-1',arguments:JSON.stringify({target:f.lead,message}),internal_chat_message_metadata_passthrough:{turn_id:f.activation}}},
    {type:'response_item',metadata:{client_authored:false},payload:{type:'function_call_output',id:'fco_next',call_id:'followup-1',output:'',internal_chat_message_metadata_passthrough:{turn_id:f.activation}}}];
  const save = (path, rows) => writeFileSync(path,rows.map(row=>JSON.stringify(row)+'\n').join(''));
  save(sender,accepted); save(transcript,[...childPrefix,...delivery]);
  f.events.publish(observations,{schema:1,runtime:'0.160.0',session:f.root,kind:'child-transcript',child:f.lead,turn:f.activation,transcript});
  f.events.publish(observations,{schema:1,runtime:'0.160.0',session:f.root,kind:'followup-transcript',actor:f.root,call:'followup-1',turn:f.activation,target:f.lead,transcript:sender});
  const options = {directory:f.journal,project:f.scope.project,observationsRoot,sessionsDir};
  const native = {version:'0.160.0',actor:f.lead};
  const input = {session:f.root,turn,transcript};
  const bind = () => childTools.bindNativeChildTranscript(input,native,options);
  const recover = () => childTools.recoverNativeChildDeliveries({version:'0.160.0',actor:f.root},f.root,options,saved.assignment.id);
  const deliver = rows => save(transcript,[...childPrefix,...rows]);
  return {...f,childTools,stops,prior,prepared,saved,review,runTarget,options,native,input,bind,recover,save,deliver,accepted,delivery,transcript,sender,turn,observations};
}

test('native continuation binding verifies both transcripts and preserves saved targets on retry', async t => {
  const f = await nativeContinuationFixture(t);
  const result = f.bind();
  assert.equal(result.decision,'bound'); assert.equal(result.binding.turn,f.turn);
  assert.deepEqual(result.review,f.review); assert.deepEqual(result.runTarget,f.runTarget);
  assert.equal(f.bind().decision,'already-bound');
  const state = f.api.readAdmission(f.journal);
  assert.deepEqual(state.bindings[0],f.prior); assert.equal(state.bindings.length,2);
  assert.equal(state.completions.length,1);
  assert.equal(f.events.readObservations(f.observations).filter(row=>row.kind==='child-transcript').length,2);
});

test('native continuation binding refuses pending changed foreign duplicate and stale delivery evidence', async t => {
  const f = await nativeContinuationFixture(t);
  f.save(f.sender,f.accepted.slice(0,-1)); assert.throws(f.bind);
  for (const mutate of [rows=>rows[3].payload.arguments=JSON.stringify({target:f.root,message:'changed'}),rows=>rows[4].metadata.client_authored=true]) {
    const rows=structuredClone(f.accepted); mutate(rows); f.save(f.sender,rows); assert.throws(f.bind);
  }
  f.save(f.sender,f.accepted);
  for (const mutate of [rows=>rows[2].payload.content[0].encrypted_content+='changed',rows=>rows[2].payload.recipient='/root/other',rows=>rows.push(structuredClone(rows[2])),
    rows=>rows.push({type:'event_msg',payload:{type:'task_started',turn_id:'55555555-5555-4555-8555-555555555555'}})]) {
    const rows=structuredClone(f.delivery); mutate(rows); f.deliver(rows); assert.throws(f.bind);
  }
  assert.equal(f.api.readAdmission(f.journal).bindings.length,1);
  assert.equal(f.api.readAdmission(f.journal).completions.length,1);
  f.deliver(f.delivery); assert.equal(f.bind().decision,'bound');
});

test('native continuation recovery retains pending capacity and recovers only its verified child after off', async t => {
  const f = await nativeContinuationFixture(t);
  f.api.changeAdmissionMode(f.journal,{...f.scope,after:f.activation,turn:'66666666-6666-4666-8666-666666666666',sage:false});
  f.deliver([]); f.recover(); assert.equal(f.api.readAdmission(f.journal).bindings.length,1);
  f.deliver(f.delivery); f.recover(); f.recover();
  const state = f.api.readAdmission(f.journal);
  assert.equal(state.bindings.length,2); assert.equal(state.completions.length,1);
  assert.equal(state.bindings[1].assignment,f.saved.assignment.id);
  assert.equal(f.api.completeAdmission(f.journal,f.prior).decision,'already-completed');
  assert.equal(f.api.readAdmission(f.journal).completions.length,1);
});

function continuationTerminal(f) {
  const text = 'Saved follow-up report.';
  return [...f.delivery,{type:'response_item',payload:{type:'message',id:'next_report',role:'assistant',content:[{type:'output_text',text}],internal_chat_message_metadata_passthrough:{turn_id:f.turn}},
    metadata:{client_authored:false,retained_source:{complete:true,id:{role:'assistant',turn_id:f.turn,message_id:'next_report'}}}},
    {type:'event_msg',payload:{type:'task_complete',turn_id:f.turn,last_agent_message:text}}];
}

test('native continuation no-tool stop after off binds once and waits for terminal evidence', async t => {
  const f = await nativeContinuationFixture(t);
  f.api.changeAdmissionMode(f.journal,{...f.scope,after:f.activation,turn:'66666666-6666-4666-8666-666666666666',sage:false});
  const stop={hook_event_name:'SubagentStop',session_id:f.root,agent_id:f.lead,turn_id:f.turn,transcript_path:f.sender,agent_transcript_path:f.transcript};
  assert.equal(f.stops.completeNativeChild(stop,f.native,f.options).decision,'stop-observed');
  assert.equal(f.api.readAdmission(f.journal).completions.length,1);
  assert.throws(()=>f.stops.completeNativeChild({...stop,turn_id:f.activation},f.native,f.options));
  assert.equal(f.api.readAdmission(f.journal).completions.length,1);
  f.deliver(continuationTerminal(f));
  assert.equal(f.stops.completeNativeChild(stop,f.native,f.options).decision,'completed');
  assert.equal(f.stops.completeNativeChild(stop,f.native,f.options).decision,'already-completed');
  assert.equal(f.api.readAdmission(f.journal).bindings.length,2);
  assert.equal(f.api.readAdmission(f.journal).completions.length,2);
});

test('native continuation parent retries an unpublished transcript reference and completes exact work', async t => {
  const f = await nativeContinuationFixture(t);
  f.api.bindContinuationAdmission(f.journal,{...f.scope,assignment:f.saved.assignment.id,issuer:f.root,call:'followup-1',child:f.lead,turn:f.turn});
  assert.equal(f.events.readObservations(f.observations).filter(row=>row.kind==='child-transcript').length,1);
  f.deliver(continuationTerminal(f));
  const reconcile=(actor,assignment=f.saved.assignment.id)=>f.stops.reconcileNativeCompletions({version:'0.160.0',actor},f.root,f.options,assignment);
  reconcile(f.child); assert.equal(f.api.readAdmission(f.journal).completions.length,1);
  reconcile(f.root,'unrelated'); assert.equal(f.api.readAdmission(f.journal).completions.length,1);
  reconcile(f.root); reconcile(f.root);
  const state=f.api.readAdmission(f.journal);
  assert.equal(state.bindings.length,2); assert.equal(state.completions.length,2);
  assert.equal(state.completions[1].assignment,f.saved.assignment.id);
  assert.equal(f.events.readObservations(f.observations).filter(row=>row.kind==='child-transcript').length,2);
});

async function continuationReportFixture(t) {
  const f = await nativeContinuationFixture(t);
  const {createHash} = await import('node:crypto');
  const reports = await import(new URL('../runtime/report-intake.mjs',f.url));
  const recovery = await import(new URL('../runtime/report-recovery.mjs',f.url));
  const fields = claimedReview('qa');
  const text = Object.entries(fields).map(([key,value])=>key+'\n'+value).join('\n\n');
  const terminal = continuationTerminal(f);
  terminal.at(-2).payload.content[0].text=text;
  terminal.at(-1).payload.last_agent_message=text;
  f.deliver(terminal);
  const parent={version:'0.160.0',actor:f.root};
  const read=()=>reports.readChildReport({name:'next'},parent,f.options);
  const record=reportHash=>reports.recordChildReport({name:'next',reportHash},parent,f.options);
  const reportHash=createHash('sha256').update(text).digest('hex');
  return {...f,reports,recovery,fields,text,terminal,parent,read,record,reportHash};
}

test('native follow-up reports reconcile exact terminal evidence and preserve one immutable receipt', async t => {
  const f=await continuationReportFixture(t);
  const ready=f.read();
  assert.equal(ready.decision,'report-ready'); assert.equal(ready.assignment,f.saved.assignment.id);
  assert.equal(ready.run,'R2'); assert.equal(ready.turn,f.turn); assert.deepEqual(ready.report,f.fields);
  assert.equal(ready.reportHash,f.reportHash);
  const before=f.api.readAdmission(f.journal);
  assert.equal(before.completions.length,2); assert.equal((before.reports ?? []).length,0);
  assert.deepEqual(f.read(),ready); assert.deepEqual(f.api.readAdmission(f.journal),before);
  assert.equal(f.record(ready.reportHash).decision,'report-recorded');
  assert.equal(f.record(ready.reportHash).decision,'already-recorded');
  const after=f.api.readAdmission(f.journal);
  assert.equal(after.reports.length,1); assert.equal(after.reports[0].binding.assignment,f.saved.assignment.id);
  assert.deepEqual(after.reservations,before.reservations); assert.deepEqual(after.bindings,before.bindings);
  assert.deepEqual(after.completions,before.completions); assert.deepEqual(after.modes,before.modes);
  assert.deepEqual(after.reports[0].binding,after.bindings[1]);
});

test('native follow-up reports refuse foreign callers and changed hashes before saving claims', async t => {
  const f=await continuationReportFixture(t);
  assert.throws(()=>f.reports.readChildReport({name:'next'},{version:'0.160.0',actor:f.child},f.options));
  assert.throws(()=>f.reports.readChildReport({name:'absent'},f.parent,f.options));
  assert.throws(()=>f.record('a'.repeat(64)));
  assert.equal((f.api.readAdmission(f.journal).reports ?? []).length,0);
  const ready=f.read();
  const changed=structuredClone(f.terminal);
  changed.at(-2).payload.content[0].text+='\nchanged'; changed.at(-1).payload.last_agent_message+='\nchanged';
  f.deliver(changed); assert.throws(()=>f.record(ready.reportHash));
  assert.equal((f.api.readAdmission(f.journal).reports ?? []).length,0);
  f.deliver(f.terminal); assert.equal(f.record(ready.reportHash).decision,'report-recorded');
  assert.equal(f.api.readAdmission(f.journal).reports[0].reportHash,f.reportHash);
});

test('native follow-up reports retain exact recovery evidence after off and transcript removal', async t => {
  const f=await continuationReportFixture(t);
  f.recover();
  f.stops.reconcileNativeCompletions(f.parent,f.root,f.options,f.saved.assignment.id);
  const binding=f.api.readAdmission(f.journal).bindings.find(row=>row.assignment===f.saved.assignment.id);
  const report={binding,task:'T1',run:'R2',reportMessage:'next_report',reportHash:f.reportHash,text:f.text};
  for(const changed of [{...report,run:'R1'}, {...report,binding:{...binding,turn:f.activation}}, {...report,reportMessage:'other_report'}]) {
    assert.throws(()=>f.recovery.recordReportRecovery(changed,f.options));
  }
  f.recovery.recordReportRecovery(report,f.options);
  assert.equal(f.recovery.hasReportRecovery(report,f.options),true);
  f.recovery.recordReportRecovery(report,f.options);
  assert.equal(f.events.readObservations(f.observations).filter(row=>row.kind==='report-recovery-verified').length,1);
  assert.equal((f.api.readAdmission(f.journal).reports ?? []).length,0);
  f.api.recordReportAdmission(f.journal,report);
  f.api.changeAdmissionMode(f.journal,{...f.scope,after:f.activation,turn:'66666666-6666-4666-8666-666666666666',sage:false});
  rmSync(f.transcript);
  assert.deepEqual(f.read().report,f.fields);
  assert.equal(f.record(f.reportHash).decision,'already-recorded');
  assert.throws(()=>f.reports.readChildReport({name:'next'},{version:'0.160.0',actor:f.lead},f.options));
  assert.equal((f.api.readAdmission(f.journal).reports ?? []).length,1);
});

async function leadPreparationFixture(t) {
  const f=await nativeBindingFixture(t);
  const preparation=await import(new URL('../runtime/preparation.mjs',f.url));
  const instructions=await import(new URL('../runtime/instructions.mjs',f.url));
  const root=join(f.journal,'..'), projectDirectory=join(root,'lead-project'), logbookRoot=join(root,'lead-logbook');
  mkdirSync(projectDirectory);
  const runEnv={...process.env,SAGE_HOME:logbookRoot};
  const git=(...args)=>execFileSync('git',['-C',projectDirectory,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',
    '-c','user.name=Fixture','-c','user.email=fixture@users.noreply.github.com',...args],{env:runEnv,encoding:'utf8'});
  git('init','--quiet','-b','codex/t1-fixture'); git('commit','--quiet','--allow-empty','-m','fixture');
  git('branch','codex/t2-fixture');
  const runTool=f.api.createStateTool({defaultRoot:()=>{throw Error('No ambient logbook');}});
  const cli=(...args)=>runTool.sage([...args,'--project',projectDirectory],runEnv);
  cli('init');cli('task','add', '--priority', 'P2','--title','Lead fixture','--size','small');cli('task','T1','set','branch=codex/t1-fixture');
  cli('run','add','T1','--role','lead');cli('run','add','T1','--role','qa');
  cli('task','add', '--priority', 'P2','--title','Chief fixture','--size','small');cli('task','T2','set','branch=codex/t2-fixture');cli('run','add','T2','--role','qa');
  const target=(run,task='T1',role='lead')=>runTool.captureRunAssignment({project:projectDirectory,task,run,role},runEnv);
  const review=(run,task)=>runTool.captureReviewTarget({project:projectDirectory,task,run,role:'qa',cycle:1},runEnv);
  const initial=f.api.prepareAdmission(f.journal,f.scope,{task:'T1',run:'R1',issuer:f.root,name:'agent_1'},
    {issuerRole:'chief-of-staff',role:'lead'},completeBrief('Lead this task.'),{runTarget:target('R1')}).preparation;
  const args=f.args(1,f.root,f.scope);args[3].name='agent_1';args[3].tool='collaborationspawn_agent';
  const first=f.api.reservePreparedAdmission(f.journal,f.scope,{preparation:initial.id,issuer:f.root,call:'spawn-1'},args[3],'chief-of-staff').assignment;
  const base={schema:1,runtime:'0.160.0',session:f.root,actor:f.root,call:'spawn-1',turn:f.activation};
  f.events.publish(f.observationsDirectory,{...base,kind:'spawn-request',name:'agent_1'});
  f.events.publish(f.observationsDirectory,{...base,kind:'spawn-result',path:'/root/agent_1'});
  const prior=f.bind(f.identity()).binding;
  const observationsRoot=join(root,'lead-observations'),sessionsDir=join(root,'lead-sessions');mkdirSync(sessionsDir);
  cpSync(f.observationsDirectory,join(observationsRoot,f.root),{recursive:true});
  const options={directory:f.journal,project:f.scope.project,observationsRoot,projectDirectory,logbookRoot,sessionsDir};
  const native={version:'0.160.0',actor:f.lead};
  const input={task:'T1',run:'R2',name:'reviewer',role:'qa',reviewCycle:1,brief:completeBrief('Review the lead task.')};
  const prepare=(changes={})=>preparation.prepareNativeTask({...input,...changes},native,options);
  const spawnInput=saved=>({hook_event_name:'PreToolUse',session_id:f.root,turn_id:f.activation,
    tool_name:'collaborationspawn_agent',tool_use_id:'team-spawn',tool_input:{task_name:saved.name,message:saved.message,fork_turns:'none'}});
  const spawn=(saved,turn=f.activation)=>preparation.reservePreparedSpawn({...spawnInput(saved),turn_id:turn},native,options);
  return {...f,preparation,instructions,first,prior,options,native,input,prepare,spawn,cli,target,review};
}

test('native lead preparation refuses other tasks while preserving same-task and chief work', async t => {
  const f=await leadPreparationFixture(t),before=f.api.readAdmission(f.journal);
  assert.throws(()=>f.prepare({task:'T2',run:'R3'}),/could not verify this task preparation/);
  assert.deepEqual(f.api.readAdmission(f.journal),before);
  const saved=f.prepare(); assert.equal(saved.task,'T1');
  assert.equal(f.spawn(saved).decision,'permit-once');
  const chief=f.preparation.prepareNativeTask({...f.input,task:'T2',run:'R3',name:'chief_review'},
    {version:'0.160.0',actor:f.root},f.options);
  assert.equal(chief.task,'T2');
});

test('native lead preparation blocks an older foreign-task preparation before dispatch', async t => {
  const f=await leadPreparationFixture(t);
  const old=f.api.prepareAdmission(f.journal,f.scope,{task:'T2',run:'R3',issuer:f.lead,name:'foreign'},
    {issuerRole:'lead',role:'qa'},f.input.brief,{runTarget:f.target('R3','T2','qa'),review:f.review('R3','T2')}).preparation;
  const before=f.api.readAdmission(f.journal);
  assert.throws(()=>f.spawn({name:old.name,message:f.instructions.preparedTaskMessage(old)}),/could not verify this task preparation/);
  assert.deepEqual(f.api.readAdmission(f.journal),before);
});

test('native lead preparation uses the unfinished continuation and original native identity', async t => {
  const f=await leadPreparationFixture(t);
  f.api.completeAdmission(f.journal,f.prior);
  f.cli('run','done','R1','--status','done'); f.cli('run','add','T1','--role','lead'); f.cli('run','add','T1','--role','qa');
  const next=f.api.prepareAdmission(f.journal,f.scope,{task:'T1',run:'R4',issuer:f.root,name:'lead_again'},
    {issuerRole:'chief-of-staff',role:'lead'},completeBrief('Continue the lead task.'),
    {runTarget:f.target('R4')}).preparation;
  const saved=f.api.reservePreparedContinuation(f.journal,f.scope,{preparation:next.id,issuer:f.root,call:'lead-followup',previous:f.first.id},
    {tool:'collaborationfollowup_task',turn:f.activation,name:next.name,argumentsHash:'b'.repeat(64),taskHash:'c'.repeat(64)},'chief-of-staff');
  const bound={...f.scope,assignment:saved.assignment.id,issuer:f.root,call:'lead-followup',child:f.lead,turn:'44444444-4444-4444-8444-444444444444'};
  f.api.bindContinuationAdmission(f.journal,bound);
  const child=f.prepare({run:'R5',name:'next_reviewer'});
  assert.equal(child.task,'T1'); assert.equal(f.spawn(child,bound.turn).decision,'permit-once');
  assert.throws(()=>f.prepare({task:'T2',run:'R3',name:'foreign_after_resume'}));
  assert.equal(f.api.readAdmission(f.journal).bindings.length,2);
  f.api.completeAdmission(f.journal,bound);
  assert.throws(()=>f.prepare({run:'R5',name:'after_second_end'}));
});

test('native lead preparation refuses completed and interrupted leads with valid pending work', async t => {
  for(const outcome of ['complete','interrupt']) {
    const f=await leadPreparationFixture(t),saved=f.prepare();
    if(outcome==='complete') f.api.completeAdmission(f.journal,f.prior);
    else f.api.interruptAdmission(f.journal,f.prior,'a'.repeat(64));
    const before=f.api.readAdmission(f.journal);
    assert.throws(()=>f.prepare({run:'R2',name:'after_end'}));
    assert.throws(()=>f.spawn(saved));
    assert.deepEqual(f.api.readAdmission(f.journal),before);
  }
});

test('T47: packaged SDK keeps Zod tool validation and refuses unused JSON Schema elicitation', async t => {
  const { dir, plugin } = isolated(t, 'codex');
  const entry = join(dir, 'sdk-validation.mjs');
  writeFileSync(entry, `
    import { McpServer, serveStdio, z } from './plugin/runtime/mcp-sdk.mjs';
    serveStdio(() => {
      const server = new McpServer({ name: 'sage-validation-test', version: '0.1.0' });
      server.registerTool('double', { inputSchema: z.object({ value: z.number().int() }) },
        async ({ value }) => ({ content: [{ type: 'text', text: String(value * 2) }] }));
      server.registerTool('form_fixture', { inputSchema: z.object({}) }, async () => ({
        content: [{ type: 'text', text: JSON.stringify(await server.server.elicitInput({
          mode: 'form', message: 'Fixed fixture form', requestedSchema: {
            type: 'object', properties: { fixed: { type: 'string' } }, required: ['fixed'],
          },
        })) }],
      }));
      return server;
    });
  `);
  const child = spawn(process.execPath, [entry], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  let stderr = '', next = 0, forms = 0;
  const pending = new Map();
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    for (const { reject } of pending.values()) reject(Error('fixture closed before response'));
    resolve({ code, signal });
  }));
  child.once('error', error => { for (const { reject } of pending.values()) reject(error); });
  child.stderr.on('data', chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const message = JSON.parse(line);
      if (message.method === 'elicitation/create') {
        forms++;
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
          result: { action: 'accept', content: { fixed: 'valid fixture value' } } }) + '\n');
      } else { pending.get(message.id)?.resolve(message); pending.delete(message.id); }
    } catch (error) { for (const { reject } of pending.values()) reject(error); child.stdin.end(); }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++next; pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    const initialized = await request('initialize', { protocolVersion: '2025-06-18',
      capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'fixed-fixture', version: '1.0.0' } });
    assert.equal(initialized.result.protocolVersion, '2025-06-18');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const good = await request('tools/call', { name: 'double', arguments: { value: 3 } });
    assert.equal(good.result.isError, undefined);
    assert.deepEqual(good.result.content, [{ type: 'text', text: '6' }]);
    const invalid = await request('tools/call', { name: 'double', arguments: { value: '3' } });
    assert.equal(invalid.result.isError, true);
    const form = await request('tools/call', { name: 'form_fixture', arguments: {} });
    assert.equal(forms, 1, 'the fixture supplies a valid accepted form through the real transport');
    assert.equal(form.result.isError, true, 'unused JSON Schema validation must refuse, never silently accept');
    assert.match(form.result.content[0].text, /Sage does not support JSON Schema elicitation validation\./);
  } finally {
    child.stdin.end();
    assert.deepEqual(await closed, { code: 0, signal: null });
    assert.equal(stderr, '');
  }
});

test('T47: build refuses the published SDK validator graph even without a root fast-uri pin', async () => {
  const { assertSdkBundleGraph } = await import('./build.mjs');
  assert.equal(typeof assertSdkBundleGraph, 'function', 'the build must check its actual dependency graph');
  const { buildSync } = await import('esbuild');
  const raw = buildSync({ absWorkingDir: ROOT, entryPoints: ['packages/sage-codex/runtime/mcp-sdk.mjs'],
    bundle: true, platform: 'node', target: 'node20', format: 'esm', write: false,
    metafile: true, minify: false, logLevel: 'silent' });
  assert.equal(Object.hasOwn(json('package.json').devDependencies, 'fast-uri'), false);
  assert.ok(Object.keys(raw.metafile.inputs).some(file => /ajvProvider/.test(file)), 'negative control must contain the real embedded provider');
  const provider = Object.keys(raw.metafile.inputs).find(file => /ajvProvider/.test(file));
  assert.match(readFileSync(join(ROOT, provider), 'utf8'), /fast-uri@3\.1\.0/);
  assert.ok(/require_fast_uri/.test(raw.outputFiles[0].text), 'the diagnostic bundle retains the embedded resolver');
  assert.throws(() => assertSdkBundleGraph(raw.metafile), /excluded JSON Schema validator dependency/);
  // A new published chunk name must not hide an old embedded resolver.
  assert.throws(() => assertSdkBundleGraph({ inputs: { 'renamed-sdk.mjs': {} } },
    () => '// node_modules/.pnpm/fast-uri@3.1.0/node_modules/fast-uri/index.js'), /excluded JSON Schema validator dependency/);
  const built = outputs().get('plugins/sage-codex/runtime/mcp-sdk.mjs');
  assert.ok(built === source('plugins/sage-codex/runtime/mcp-sdk.mjs'), 'inspect the same bundle that ships');
  assert.doesNotMatch(built, /require_fast_uri|fast-uri@|ajvProvider/);
  for (const name of ['ajv', 'ajv-formats', 'fast-deep-equal', 'fast-uri', 'json-schema-traverse']) {
    assert.equal(existsSync(join(ROOT, 'plugins/sage-codex/licenses', name + '.txt')), false, 'removed dependencies must not have stale license-version claims');
  }
});

async function reportedRunFixture(t, status = "done") {
  const { createHash } = await import("node:crypto");
  const root = mkdtempSync(join(realpathSync(tmpdir()), "sage-reported-run-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "project");
  mkdirSync(project);
  const env = { ...process.env, SAGE_HOME: join(root, "logbook") };
  const tool = createStateTool({ defaultRoot: () => { throw Error("No ambient logbook"); } });
  const cli = (...args) => tool.sage([...args, "--project", project], env);
  cli("init");
  cli("task", "add", "--priority", "P2", "--title", "Report lifecycle", "--size", "small");
  cli("run", "add", "T1", "--role", "implementer", "--branch", "codex/t1-report");
  const text = `STATUS: ${status}\nRESULT: complete\nEVIDENCE: synthetic fixture\nFINDINGS: none\nQUESTIONS: none\nNOT VERIFIED: real model\nBRANCH: arbitrary report text`;
  const input = { project, task: "T1", run: "R1", role: "implementer",
    assignment: "11111111-2222-4333-8444-555555555555", reportHash: createHash("sha256").update(text).digest("hex"), text };
  const dir = tool.storeDir(project, env);
  const finish = (data = input) => tool.finishReportedRun(data, env);
  const tables = () => Object.fromEntries(["tasks", "ledger", "findings", "gates", "decisions"].map(name =>
    [name, readFileSync(join(dir, `${name}.tsv`), "utf8")]));
  return { tool, env, cli, dir, input, finish, tables };
}

for (const status of ["done", "blocked", "question"]) test(`reported run saves ${status} evidence without accepting task or review claims`, async t => {
  const f = await reportedRunFixture(t, status);
  const before = f.tables();
  const running = f.tool.read(f.dir, "runs")[0];
  const result = f.finish();
  assert.equal(result.decision, "run-finished");
  assert.equal(result.status, status);
  assert.equal(readFileSync(join(f.dir, result.report), "utf8"), f.input.text);
  const finished = f.tool.read(f.dir, "runs")[0];
  assert.deepEqual(finished, { ...running, status, report: result.report, ended: result.ended });
  assert.match(finished.ended, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(f.tables(), before);
});

test("reported run retries preserve the original result and refuse replacement evidence", async t => {
  const f = await reportedRunFixture(t);
  const first = f.finish();
  const bytes = readFileSync(join(f.dir, "runs.tsv"), "utf8");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 60000 });
  assert.deepEqual(f.finish(), { ...first, decision: "already-finished" });
  assert.equal(readFileSync(join(f.dir, "runs.tsv"), "utf8"), bytes);
  assert.throws(() => f.finish({ ...f.input, assignment: "99999999-2222-4333-8444-555555555555" }));
  writeFileSync(join(f.dir, first.report), "changed");
  assert.throws(() => f.finish());
  rmSync(join(f.dir, first.report));
  assert.throws(() => f.finish());
  assert.equal(readFileSync(join(f.dir, "runs.tsv"), "utf8"), bytes);
});

test("reported run refuses foreign task role run hash and manually finished work", async t => {
  const f = await reportedRunFixture(t);
  assert.equal(typeof f.tool.finishReportedRun, "function");
  const before = readFileSync(join(f.dir, "runs.tsv"), "utf8");
  for (const change of [{ task: "T2" }, { run: "R2" }, { role: "qa" }, { reportHash: "0".repeat(64) },
    { text: "STATUS: done" }, { assignment: "../escape" }, { extra: "field" }]) assert.throws(() => f.finish({ ...f.input, ...change }));
  assert.equal(readFileSync(join(f.dir, "runs.tsv"), "utf8"), before);
  assert.deepEqual(readdirSync(join(f.dir, "reports")), []);
  f.cli("run", "done", "R1", "--status", "failed", "--report", "manual.md");
  assert.throws(() => f.finish());
  assert.equal(f.tool.read(f.dir, "runs")[0].report, "manual.md");
});

test("reported run recovers after evidence publication but before the run write", async t => {
  const f = await reportedRunFixture(t);
  const blocker = join(f.dir, `runs.tsv.${process.pid}`);
  mkdirSync(blocker);
  assert.throws(() => f.finish(), /EISDIR/);
  assert.equal(f.tool.read(f.dir, "runs")[0].status, "running");
  const files = readdirSync(join(f.dir, "reports"));
  assert.equal(files.length, 1);
  assert.equal(readFileSync(join(f.dir, "reports", files[0]), "utf8"), f.input.text);
  rmSync(blocker, { recursive: true });
  assert.equal(f.finish().decision, "run-finished");
  assert.deepEqual(readdirSync(join(f.dir, "reports")), files);
});

test("reported run refuses redirected evidence directories and newer table schemas", async t => {
  const f = await reportedRunFixture(t);
  assert.equal(typeof f.tool.finishReportedRun, "function");
  const elsewhere = join(f.dir, "elsewhere");
  mkdirSync(elsewhere);
  rmSync(join(f.dir, "reports"), { recursive: true });
  symlinkSync(elsewhere, join(f.dir, "reports"));
  assert.throws(() => f.finish());
  assert.deepEqual(readdirSync(elsewhere), []);
  rmSync(join(f.dir, "reports"));
  const runsFile = join(f.dir, "runs.tsv");
  const newer = readFileSync(runsFile, "utf8").replace("\n", "\tfuture\n");
  writeFileSync(runsFile, newer);
  assert.throws(() => f.finish(), /newer/);
  assert.equal(readFileSync(runsFile, "utf8"), newer);
  assert.equal(existsSync(join(f.dir, "reports")), false);
});

test("reported run refuses a linked evidence file and ambiguous task or run rows", async t => {
  const f = await reportedRunFixture(t);
  assert.equal(typeof f.tool.finishReportedRun, "function");
  const name = `${f.input.run}-${f.input.assignment}-${f.input.reportHash}.md`;
  const external = join(f.dir, "other.md");
  writeFileSync(external, f.input.text);
  symlinkSync(external, join(f.dir, "reports", name));
  assert.throws(() => f.finish());
  assert.equal(readFileSync(external, "utf8"), f.input.text);
  rmSync(join(f.dir, "reports", name));
  for (const table of ["tasks", "runs"]) {
    const file = join(f.dir, `${table}.tsv`);
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text + text.split("\n")[1] + "\n");
    assert.throws(() => f.finish());
    assert.equal(f.tool.read(f.dir, "runs")[0].status, "running");
    writeFileSync(file, text);
  }
  assert.deepEqual(readdirSync(join(f.dir, "reports")), []);
});

test("reported run recovers evidence linked before an interrupted temporary-file cleanup", async t => {
  const { linkSync } = await import("node:fs");
  const f = await reportedRunFixture(t);
  const pending = join(f.dir, "reports", ".report-interrupted-fixture");
  const published = join(f.dir, "reports", `${f.input.run}-${f.input.assignment}-${f.input.reportHash}.md`);
  writeFileSync(pending, f.input.text, { flag: "wx" });
  linkSync(pending, published);
  const result = f.finish();
  assert.equal(result.decision, "run-finished");
  assert.equal(readFileSync(published, "utf8"), f.input.text);
  assert.equal(f.finish().decision, "already-finished");
});


test("native interruption fixture permits only the root's exact one-field child target", async () => {
  const { fixtureInterruptDecision } = await import("./fixtures/codex-native/setup-completion.mjs");
  const input = { tool_name: "collaborationinterrupt_agent", session_id: "root-session", tool_input: { target: "/root/probe_child" } };
  const context = { actor: "root-session" };
  assert.equal(fixtureInterruptDecision(input, context, true).decision, "pass");
  for (const [event, actor, enabled] of [
    [input, context, false], [input, { actor: "child-session" }, true],
    [{ ...input, agent_id: "child-session" }, context, true],
    [{ ...input, session_id: "" }, { actor: "" }, true],
    ...[null, [], {}, { target: "/root/other" }, { target: "/root/probe_child", extra: true },
      { agent_id: "/root/probe_child" }].map(tool_input => [{ ...input, tool_input }, context, true]),
  ]) assert.equal(fixtureInterruptDecision(event, actor, enabled).decision, "deny");
  assert.equal(fixtureInterruptDecision({ ...input, tool_name: "list_mcp_resources" }, context, true), null);
});

async function continuationFailureFixture(t) {
  const f = await interruptedFinishFixture(t, "qa", false);
  f.api.completeAdmission(f.dir, f.binding);
  const prepared = f.prepare(2, { previous: f.first.assignment.id });
  const saved = f.reserve(prepared);
  const { project, session, epoch, issuer, call, id: assignment } = saved.assignment;
  const failure = { project, session, epoch, assignment, issuer, call,
    previous: f.first.assignment.id, target: f.binding.child, turn: "parent-turn",
    argumentsHash: "a".repeat(64), taskHash: "b".repeat(64), evidenceHash: "d".repeat(64) };
  return { ...f, next: prepared, saved, failure };
}

test("continuation failure core validates immutable exact evidence and preserves initial failure separation", async t => {
  const f = await continuationFailureFixture(t), { api, dir, failure } = f;
  const before = api.readAdmission(dir);
  for (const key of Object.keys(failure).filter(key => key !== "evidenceHash")) {
    const changed = ["epoch", "assignment", "previous"].includes(key)
      ? "00000000-0000-0000-0000-000000000001"
      : key.endsWith("Hash") ? "e".repeat(64) : "foreign";
    assert.throws(() => api.failContinuationAdmission(dir, { ...failure, [key]: changed }), key);
  }
  for (const input of [null, {}, { ...failure, extra: true }, { ...failure, evidenceHash: "bad" }])
    assert.throws(() => api.failContinuationAdmission(dir, input));
  const { previous, target, turn, argumentsHash, taskHash, ...initial } = failure;
  assert.throws(() => api.failAdmission(dir, initial), /separate evidence/);
  assert.throws(() => api.failContinuationAdmission(dir, { ...failure, assignment: f.first.assignment.id, call: f.first.assignment.call }));
  assert.deepEqual(api.readAdmission(dir), before);
  assert.equal(api.failContinuationAdmission(dir, failure).decision, "continuation-failed");
  const failed = api.readAdmission(dir), files = readdirSync(dir);
  assert.equal(api.failContinuationAdmission(dir, { ...failure }).decision, "already-failed");
  assert.deepEqual(readdirSync(dir), files);
  assert.throws(() => api.failContinuationAdmission(dir, { ...failure, evidenceHash: "e".repeat(64) }), /different failure evidence/);
  assert.deepEqual(api.readAdmission(dir), failed);
  assert.deepEqual(failed.failures, [failure]);
  assert.equal(failed.reservations.length, 2);
});

test("continuation failure core allows one new prepared retry and retains failed history", async t => {
  const f = await continuationFailureFixture(t), { api, dir, failure } = f;
  assert.throws(() => f.prepare(3, { previous: failure.previous }), /already has later work/);
  api.failContinuationAdmission(dir, failure);
  const retry = f.prepare(3, { previous: failure.previous });
  const competitor = f.prepare(4, { previous: failure.previous });
  assert.throws(() => api.bindContinuationAdmission(dir, bindingFor(f.saved.assignment, failure.target, "turn-2")), /failed dispatch/);
  const saved = f.reserve(retry);
  assert.throws(() => f.reserve(competitor), /already has later work/);
  assert.throws(() => f.prepare(5, { previous: failure.previous }), /already has later work/);
  assert.equal(f.reserve(retry).decision, "already-reserved");
  assert.equal(api.bindContinuationAdmission(dir, bindingFor(saved.assignment, failure.target, "turn-3")).decision, "bound");
  const state = api.readAdmission(dir);
  assert.equal(state.reservations.length, 3);
  assert.deepEqual(state.failures, [failure]);
  assert.equal(state.reservations[2].continuation, failure.previous);
});

test("continuation failure core resolves bind and failure in both atomic publication orders", async t => {
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  for (const winner of ["bind", "failure"]) {
    const f = await continuationFailureFixture(t), { api, dir, failure } = f;
    const binding = bindingFor(f.saved.assignment, failure.target, "turn-2");
    const bind = () => api.bindContinuationAdmission(dir, binding);
    const fail = () => api.failContinuationAdmission(dir, failure);
    const original = fs.linkSync;
    let raced = false;
    fs.linkSync = (...args) => {
      if (!raced) { raced = true; (winner === "bind" ? bind : fail)(); }
      return original(...args);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(winner === "bind" ? fail : bind, winner === "bind" ? /bound assignment/ : /failed dispatch/);
    } finally { fs.linkSync = original; syncBuiltinESMExports(); }
    assert.equal(raced, true);
    const state = api.readAdmission(dir);
    assert.equal(state.bindings.length, winner === "bind" ? 2 : 1);
    assert.equal((state.failures ?? []).length, winner === "failure" ? 1 : 0);
    assert.equal(readdirSync(dir).some(name => name.startsWith(".pending-")), false);
  }
});

test("continuation failure core retries resolve competing reservations at atomic publication", async t => {
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const f = await continuationFailureFixture(t);
  f.api.failContinuationAdmission(f.dir, f.failure);
  const proposals = [3, 4].map(n => f.prepare(n, { previous: f.failure.previous }));
  const original = fs.linkSync;
  let raced = false;
  fs.linkSync = (...args) => {
    if (!raced) { raced = true; f.reserve(proposals[1]); }
    return original(...args);
  };
  syncBuiltinESMExports();
  try { assert.throws(() => f.reserve(proposals[0]), /already has later work/); }
  finally { fs.linkSync = original; syncBuiltinESMExports(); }
  assert.equal(raced, true);
  assert.equal(f.api.readAdmission(f.dir).reservations.length, 3);
});


test("T85 isolated public PE and designer helpers render shared contracts and truthful design guidance", async t => {
  const f = await roleInstructionsFixture(t);
  const helper = join(f.plugin, "skills/sage/role.mjs");
  for (const role of ["pe", "designer"]) {
    const result = spawnSync(process.execPath, [helper, role], { encoding: "utf8", cwd: f.dir });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${f.api.renderRoleInstructions(role, f.bindings[role])}\n\n${f.api.renderReportInstructions(f.bindings.report)}\n`);
    for (const field of f.api.REPORT_FIELDS) assert.match(result.stdout, new RegExp(`^${field} +`, "m"));
    assert.match(result.stdout, role === "pe" ? /You change nothing/ : /Use sample data, and label it as sample data/);
    assert.doesNotMatch(result.stdout, /\{\{|sage:report|CLAUDE_CONFIG_DIR/);
  }
  const roles = readFileSync(join(f.plugin, "skills/sage/references/roles.md"), "utf8");
  const workflow = readFileSync(join(f.plugin, "skills/sage/references/workflow.md"), "utf8");
  const briefs = readFileSync(join(f.plugin, "skills/sage/references/briefs.md"), "utf8");
  assert.match(roles, /role\.mjs pe/);
  assert.match(roles, /role\.mjs designer/);
  assert.match(roles, /installed acceptance/);
  assert.match(workflow, /designer → PE → owner.*approval → build/);
  assert.match(workflow, /ordinary.*design.*gate.*not.*merge refusal/i);
  assert.match(briefs, /pages.*folder/);
  assert.match(briefs, /CHANGE/);
  assert.doesNotMatch(roles + workflow + briefs, /Large design\/PE work stays with the parent/);
});
