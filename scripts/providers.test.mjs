import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { ROOT, filesUnder, outputs } from "./build.mjs";
import { createStateTool } from "../packages/sage-core/index.mjs";
import { stateKey } from "../plugins/sage-codex/hooks/hook-state.mjs";

const context = (output) => output?.hookSpecificOutput?.additionalContext ?? "";
const source = (path) => readFileSync(join(ROOT, path), "utf8");
const json = (path) => JSON.parse(source(path));

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
const fakeGit = (branch, { head = "main", settings = "remote.origin.url\nhttps://github.com/acme/project.git\0" } = {}) => (dir, args) =>
  args[1] === "--symbolic-full-name" ? `refs/heads/${args[2].replace(/^(?:refs\/)?(?:heads\/)?/, "")}\n`
    : args[0] === "rev-parse" ? (typeof branch === "function" ? branch(dir) : branch)
      : args[0] === "config" ? settings
        : head === undefined ? undefined : `refs/remotes/origin/${head}\n`;
const fakeGh = (args) => (args.at(-1) === ".default_branch" ? "main\n" : undefined);

test("T51: external command operands do not become executable evidence", async t => {
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
      assert.equal(hook.agentProblem("COMMAND pr create", f.dir, bin), undefined, "gh under another name");
      assert.match(hook.agentProblem("gh repo delete o/r", f.dir, bin) ?? "", /an agent runs only these gh commands/);
    }
  }
});

test("T51: built hook normalizes agent stash, process, reader and writer executable names", async t => {
  const f = isolated(t, "claude"), logbook = join(f.dir, "logbook"); mkdirSync(logbook);
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
  for (const [actor, sage] of [[{}, false], [{ agent_id: "fixture-child", agent_type: "sage:implementer" }, true]]) {
    for (const command of commands) {
      const result = hook.handle({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: f.dir,
        tool_input: { command }, ...actor }, { sage }, { touch() {} });
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
        assert.equal(result?.hookSpecificOutput?.permissionDecision, broken || !actor.agent_id ? "deny" : undefined, `${broken}: ${JSON.stringify(result)}`);
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

test("T933: a redirection into a scratch folder outside the project is no write; every other write form still is", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const { commandWrites } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    const project = join(f.dir, "project"), scratch = join(f.dir, "scratch");
    mkdirSync(project, { recursive: true });
    mkdirSync(scratch, { recursive: true });
    for (const command of [`echo x > ${scratch}/out.txt`, `npm test > ${scratch}/log.txt 2>&1`, `cd ${scratch} && echo x >> out.txt`,
      `cat > ${scratch}/new/probe.mjs <<'EOF'\nx\nEOF`, "echo x > /dev/null", "npm test"])
      assert.equal(commandWrites(command, project, [scratch]), false, command);
    for (const command of ["echo x > out.txt", `echo x > ${project}/out.txt`, `echo x > ${scratch}/../project/out.txt`,
      "echo x > $TMPDIR/out.txt", `echo x > ${scratch}/*.txt`, `cp a.txt ${scratch}/b.txt`, `tee ${scratch}/out.txt`,
      `sed -i s/a/b/ ${scratch}/out.txt`, `rm -rf ${scratch}/old`])
      assert.equal(commandWrites(command, project, [scratch]), true, command);
    assert.equal(commandWrites(`echo x > ${scratch}/out.txt`, project), true);
    assert.equal(commandWrites(`echo x > ${scratch}/inner/a.txt`, join(scratch, "inner"), [scratch]), true);
    assert.equal(commandWrites(`echo x > ${scratch}/other/a.txt`, join(scratch, "inner"), [scratch]), false);
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

test("T44: value-taking options and alternate output spellings preserve the write boundary", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider), root = join(f.dir, "logbook"); mkdirSync(root);
    const { commandWrites } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    for (const command of [
      `openssl dgst --out ${root}/ledger.tsv source.txt`,
      `openssl dgst -hmac -out --out ${root}/ledger.tsv source.txt`,
      `git diff --no-index --src-prefix '--' --output=${root}/ledger.tsv left.txt right.txt`,
      `git show --out=${root}/ledger.tsv`,
    ]) {
      assert.equal(commandWrites(command, f.dir), true, command);
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
    assert.equal(tool.sageRoot({ HOME: join(dir, "home") }), join(dir, "home", `.${provider}`, "sage"));
    const config = run("config");
    assert.equal(config.status, 0, config.stderr);
    assert.match(config.stdout, provider === "codex" ? /inherit,inherit,inherit/ : /opus,sonnet,sonnet/);
  }
});

test("T216, T1054, T1063: each plugin's board is a cross-provider reader: its server modules import only Node built-ins and the bundled core, its app holds only built files, and it installs from the plugin", async (t) => {
  for (const provider of ["claude", "codex"]) {
    const { dir, plugin } = isolated(t, provider);
    const files = filesUnder(join(plugin, "board")), app = join(plugin, "board/app");
    const manifest = JSON.parse(readFileSync(join(app, "manifest.json"), "utf8")), built = [manifest.script, manifest.style, manifest.vendor, manifest.graph];
    assert.deepEqual(files.map((file) => relative(join(plugin, "board"), file)).sort(), ["access.mjs", "cli.mjs", "install.mjs", "pages.mjs", "server.mjs", "writes.mjs", ...["manifest.json", ...built].map((name) => `app/${name}`)].sort());
    for (const name of built) assert.match(name, /^(?:app|vendor|graph)-[A-Z0-9]{8}\.(?:js|css)$/);
    const { parse } = await import("es-module-lexer/minimal");
    for (const file of files.filter((path) => path.endsWith(".mjs"))) {
      const [imports] = parse(readFileSync(file, "utf8"));
      for (const { n: name } of imports.filter((item) => item.d !== -2)) {
        const allowed = name?.startsWith("node:") || name === "../core/index.mjs" || /^\.\/(?:access|cli|install|pages|server|writes)\.mjs$/.test(name ?? "");
        assert.ok(allowed, `${provider} ${relative(plugin, file)} imports ${name}`);
      }
    }
    const importsOf = (name) => parse(readFileSync(join(app, name), "utf8"))[0].filter((item) => item.d !== -2).map((item) => item.n);
    assert.deepEqual(importsOf(manifest.script), [`./${manifest.vendor}`, `./${manifest.graph}`], `${provider}: the app script imports only the vendor file, and loads the graph file on demand`);
    assert.deepEqual(importsOf(manifest.graph), [`./${manifest.vendor}`], `${provider}: the graph file imports only the vendor file`);
    assert.deepEqual(importsOf(manifest.vendor), [], `${provider}: the vendor file imports nothing`);
    for (const name of ["react", "react-dom", "scheduler", "@xyflow-react", "zustand"]) assert.match(readFileSync(join(plugin, "licenses", `${name}.txt`), "utf8"), /^\S+ \d+\.\d+\.\d+\n\nMIT License/, `${provider}: ${name}'s licence ships with the plugin`);
    const env = { ...process.env, HOME: join(dir, "home") };
    delete env.SAGE_HOME; delete env.CODEX_HOME;
    const config = join(dir, "board.json"), installDir = join(dir, "stable");
    const run = (cli, ...args) => spawnSync(process.execPath, [cli, "board", ...args, "--config", config], { encoding: "utf8", env });
    assert.equal(run(join(plugin, "board/cli.mjs"), "--setup").status, 0);
    const installed = run(join(plugin, "board/cli.mjs"), "--install", "--install-dir", installDir);
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(installed.stdout, `Installed board command: ${join(installDir, "packages", "board", "cli.mjs")}\n`);
    for (const name of built) assert.equal(readFileSync(join(installDir, "packages", "board", "app", name), "utf8"), readFileSync(join(app, name), "utf8"));
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
  const env = { HOME: join(dir, "home") };
  assert.equal(a.config(env).arena_models, "a");
  assert.equal(b.config(env).arena_models, "inherit,inherit,inherit");
  assert.throws(() => b.sage(["config", "model.qa=opus"], env), /inherit/);
  assert.equal(b.sageRoot({ SAGE_HOME: dir }), dir);
  a.sage(["config", "model.qa=a"], env);
  assert.equal(a.config(env)["model.qa"], "a");
  assert.equal(b.config(env)["model.qa"], undefined);
  for (const file of filesUnder(join(ROOT, "packages/sage-core"))) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /CLAUDE_|CODEX_|sage-claude|sage-codex|"(?:opus|sonnet|haiku|fable)"/);
  }
});

test("manifests point to disjoint plugin roots and only supported Codex hooks", async () => {
  assert.equal(json(".claude-plugin/marketplace.json").plugins[0].source, "./plugins/sage");
  assert.equal(json(".agents/plugins/marketplace.json").plugins[0].source.path, "./plugins/sage-codex");
  assert.equal("hooks" in json("plugins/sage-codex/.codex-plugin/plugin.json"), false);
  assert.equal(existsSync(join(ROOT, "plugins/sage-codex/hooks/hooks.json")), false);
  const { EVENTS } = await import(pathToFileURL(join(ROOT, "plugins/sage-codex/hooks/entries.mjs")).href);
  assert.deepEqual(Object.keys(EVENTS), ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "SubagentStart", "SubagentStop", "Stop"]);
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

test("Codex hook state keys hash the session and the child, so a child gets its own state file", () => {
  assert.equal(stateKey({ session_id: "session" }), "ed133cd93c6eea4c2d1386123756bfd0c51ea7b5c30e9a62d5aeeb604a07a941");
  assert.equal(stateKey({ session_id: "session", agent_id: "child" }), "aab1d55d8c3961d024de7d577c57fa43221377c47880bd91fe2c8f8a148d2253");
  assert.notEqual(stateKey({ session_id: "a/b" }), stateKey({ session_id: "a_b" }));
  assert.equal(stateKey({ session_id: "" }), undefined);
  assert.equal(stateKey({}), undefined);
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

test("F-T114-3: shared write classification keeps executable stdin out of known writes and reader evidence", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const { commandWrites, shellWriteEvidence } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    for (const command of [
      "bash <<'EOF'\ngrep -n 'merge' *.md\nEOF",
      "python3 - <<'EOF'\nimport subprocess\nsubprocess.run([\"gh\", \"pr\", \"merge\", \"41\"])\nEOF",
      "cat script.txt | sh",
    ]) {
      assert.equal(commandWrites(command, f.dir), false, `${provider}: ${command}`);
      assert.equal(shellWriteEvidence(command, f.dir, ""), undefined, "executable input is not proven reader data");
    }
    for (const command of ["cat <<'EOF' > src/a.mjs\nliteral\nEOF", "bash -c 'echo x > out'", "cat < input > output"])
      assert.equal(commandWrites(command, f.dir), true, `${provider}: ${command}`);
    assert.deepEqual(shellWriteEvidence("cat < input > output", f.dir, ""), {
      reads: [{ word: "cat", dir: f.dir }, { word: "input", dir: f.dir }],
      writes: [{ word: "output", dir: f.dir }],
    });
  }
});

test("F-T114-2: shared write evidence preserves redirect expansion in both isolated bundles", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const { shellWriteEvidence } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    for (const target of ["~/.codex/sessions/private.jsonl", "$HOME/.codex/sage/private.json",
      '"$HOME/.codex/sessions/private.jsonl"', "${HOME}/.codex/sage/private.json", "input*", "$(printf input)"]) {
      assert.equal(shellWriteEvidence(`cat < ${target} > src/a.mjs`, f.dir, ""), undefined, `${provider}: ${target}`);
    }
    for (const target of ["'.codex/AGENTS.md'", "\".codex/AGENTS.md\""]) {
      assert.deepEqual(shellWriteEvidence(`cat < ${target} > src/a.mjs`, f.dir, ""), {
        reads: [{ word: "cat", dir: f.dir }, { word: ".codex/AGENTS.md", dir: f.dir }],
        writes: [{ word: "src/a.mjs", dir: f.dir }],
      }, provider);
    }
    assert.deepEqual(shellWriteEvidence("cat < '$HOME/input*' > src/a.mjs", f.dir, ""), {
      reads: [{ word: "cat", dir: f.dir }, { word: "$HOME/input*", dir: f.dir }],
      writes: [{ word: "src/a.mjs", dir: f.dir }],
    }, provider);
  }
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

test("shared merge and push extraction classifies merges in both isolated bundles", async t => {
  const sha = "a".repeat(40);
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    const tool = join(f.plugin, "skills/sage/sage.mjs");
    const policy = api.createCommandPolicy();
    const candidate = `gh pr merge 12 --squash --delete-branch --match-head-commit ${sha}`;
    assert.deepEqual(policy.mergeRun(candidate, f.dir), { pr: "12", sha });
    for (const text of [candidate.replace(" 12 ", " 012 "), candidate.replace(sha, "abc"), `${candidate} --admin`,
      `sh -c '${candidate}'`, "gh pr 'merge"]) {
      assert.equal(typeof policy.mergeRun(text, f.dir)?.problem, "string", text);
    }
    for (const text of ["git status", "git merge topic", "gh api repos/o/r/pulls/12/merge -X PUT", `echo '${candidate}'`, `echo '${candidate}' | head -1`,
      `node '${tool}' log --why '${candidate}'`, `node '/other/sage.mjs' log --why '${candidate}'`,
      `echo '${candidate}' | sh`, `echo '${candidate}' > run; sh run`, "$(echo gh) pr merge 12"]) assert.equal(policy.mergeRun(text, f.dir), undefined, text);
    assert.equal(api.mentionsMerge("gh pr 'merge 1"), true);
    assert.equal(api.mentionsMerge("git merge topic"), false);
    assert.equal(api.PR.test("12"), true);
    assert.equal(api.PR.test("012"), false);
    if (provider === "claude") {
      const adapter = await import(pathToFileURL(join(f.plugin, "hooks/command-policy.mjs")));
      assert.deepEqual(adapter.createCommandPolicy().mergeRun(candidate, f.dir), { pr: "12", sha });
      const hook = await import(pathToFileURL(join(f.plugin, "hooks/sage-hook.mjs")));
      assert.deepEqual(hook.mergeRun(candidate, f.dir), { pr: "12", sha });
    }
  }
});

test("shared merge and push extraction applies push rules and injected branch evidence in both isolated bundles", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    const tool = join(f.plugin, "skills/sage/sage.mjs");
    mkdirSync(join(f.dir, "project/nested"), { recursive: true });
    const policy = api.createPushPolicy({ readGh: fakeGh, readGit: fakeGit(dir => dir === join(f.dir, "project/nested") ? "main" : "topic") });
    for (const text of ["git push origin topic", "git push -u --follow-tags origin topic", "git push --delete origin topic",
      "echo 'git push origin main'", "git status", `node '${tool}' log --why 'git push origin main'`,
      "node /other/sage.mjs log --why 'git push origin main'", "echo 'git push origin main' | sh", "sudo git push origin topic",
      "sh -c 'git push origin topic'", "eval git push origin topic", "echo $(git push origin topic)", "gh api repos/o/r/git/refs -f ref=refs/heads/main"]) {
      assert.equal(policy.pushProblem(text, f.dir), undefined, text);
    }
    for (const text of ["git push origin main", "git push origin refs/heads/master", "git push origin topic:main",
      "git push -f origin topic", "git push --force-with-lease origin topic", "git push --forc origin topic",
      "git push --mirror origin", "git push origin HEAD", "git push origin", "git push upstream topic",
      "git push origin '$BRANCH'", "sudo git push origin main", "sh -c 'git push -f origin topic'",
      "eval git push origin main", "echo $(git push origin HEAD)", "git push 'origin"]) {
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
      assert.match(policy.pushProblem(`${executable} repo sync`, f.dir), /gh repo sync writes a branch on GitHub/);
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

test("T42: the shared merge rule recognizes executable spelling without changing arguments or merge form", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    const policy = api.createCommandPolicy();
    for (const executable of ["GH", "Gh.exe", "/usr/bin/GH", "'C:\\Tools\\GH.EXE'"]) {
      assert.match(policy.mergeRun(`${executable} pr merge 12 --squash --delete-branch --match-head-commit ${"a".repeat(40)}`, f.dir)?.problem, /merge only with/, executable);
    }
    assert.deepEqual(policy.mergeRun(`gh pr merge 12 --squash --delete-branch --match-head-commit ${"a".repeat(40)}`, f.dir), { pr: "12", sha: "a".repeat(40) });
  }
});

test("T815 repair: core's readers in both bundles (F-T815-4, -6, -9, -16, -27; F-T903-7, F-T903-10)", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    const home = join(f.dir, "home"), root = join(home, ".claude", "sage"), shared = join(home, ".sage"), work = join(f.dir, "work"), link = join(f.dir, "link");
    for (const folder of [join(root, "p"), shared, work]) mkdirSync(folder, { recursive: true });
    symlinkSync(root, link);
    const write = (command) => api.logbookWrite(command, work, [root, shared], home);
    for (const [command, word] of [["rm -rf ~/.claude", "~/.claude"], ["mv ~/.claude ~/.claude.bak", "~/.claude"], [`rm -rf ${home}`, home], [`rm -rf ${home}/..`, `${home}/..`],
      ["rm -rf ~/*", "~/*"], ["rm -rf /", "/"], [`find ${shared} -delete`, shared],
      [`rsync -a --delete ${work}/ ${home}/`, `${home}/`], [`sudo rm -rf ${home}`, home],
      ["chmod -R 000 ~/.claude/sage", "~/.claude/sage"], [`chmod -R 000 ${shared}`, shared], ["chown -R x ~/.sage", "~/.sage"],
      [`chgrp -R staff ${root}/p`, `${root}/p`], [`cd ${shared} && chmod -R u+w .`, "u+w"]]) assert.equal(write(command), word, `${provider}: ${command}`);
    for (const command of ["mv a.txt ~/", "rm -rf build", "rm *.log", `cp -R ${home}/.claude /tmp/x`, `chmod 644 ${home}/.claude`, `find ${work} -name '*.o' -delete`, "ls ~",
      "find ~ -name '*.tmp' -delete", `find ${home} -name x -exec rm -rf {} +`, "chmod -R u+w ~", `chmod -R 000 ${home}`, `chown -R x ${home}/.claude`, `rm ${link}`, `unlink ${link}`]) {
      assert.equal(write(command), undefined, `${provider}: ${command}`);
    }
    for (const [command, word] of [[`pushd ${root} && echo x >> tasks.json`, "tasks.json"],
      [`pushd ${root} && rm -rf p`, "p"], [`pushd ${shared} && echo x > a.json`, "a.json"], [`pushd /usr && popd && pushd ${root} && rm x`, "x"]]) assert.equal(write(command), word, `${provider}: ${command}`);
    assert.equal(write(`pushd ${root} && popd && echo x > tasks.json`), undefined, "popd goes back to the work folder");
    for (const [command, method] of [["gh api -iXDELETE repos/o/r/x", "DELETE"], ["gh api -iX DELETE repos/o/r/x", "DELETE"], ["gh api -iX POST repos/o/r/x", "POST"], ["gh api -i repos/o/r", "GET"], ["gh api -f a=b repos/o/r/x", "POST"],
      ["gh api -X PATCH repos/o/r/x -t -XGET", "PATCH"], ["gh api -X DELETE repos/o/r/x -itXGET", "DELETE"], ["gh api -X PUT repos/o/r/x -H --method=GET", "PUT"],
      ["gh api repos/o/r/x -q -fa=b", "GET"], ["gh api -X PATCH repos/o/r/x --template=-XGET", "PATCH"], ["gh api -X PATCH repos/o/r/x --hostname -XGET", "PATCH"]]) {
      assert.deepEqual(api.ghRuns(command, work).map((run) => run.method), [method], command);
    }
    const policy = api.createCommandPolicy();
    assert.equal(policy.mergeRun("gh pr merge 1 && echo 'x", work)?.problem, "the hook cannot read this command (an open quote), so it refuses it. Close each quote, substitution and heredoc. Its text names a merge. Merge only with gh pr merge <n> --squash --delete-branch --match-head-commit <sha>, as a command of its own.");
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
  assert.deepEqual(hook.mergeRun(candidate, f.dir), { pr: "012", sha }, "a broken state tool preserves the old diagnostic order");
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
      const read = (file_path) => hook.handle({ hook_event_name: "PreToolUse", tool_name: "Read", cwd: f.dir, tool_input: { file_path } }, { sage: false }, {});
      assert.match(read("~/.config/sage-board/board.json")?.hookSpecificOutput?.permissionDecisionReason ?? "passed", /^sage: the board config rule \(T229\) could not load/);
      assert.equal(read(join(f.dir, "sample.txt")), undefined);
    }
  }
});

test("shared file and mode extraction clears cached autopilot before tool checks when the mode policy is missing", async t => {
  for (const missing of ["hooks/mode-policy.mjs", "core/mode-policy.mjs"]) {
    const f = isolated(t, "claude");
    rmSync(join(f.plugin, missing), { force: true });
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
  const roles = ["implementer", "pe", "designer", "arena-judge", "code-reviewer", "security-reviewer", "ux-reviewer", "qa", "investigate", "evidence-review"];
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
    const investigate = f.api.renderRoleInstructions("investigate", f.bindings.investigate);
    const review = f.api.renderRoleInstructions("evidence-review", f.bindings["evidence-review"]);
    assert.match(investigate, /^# Investigate\n\nYou investigate one task for the chief\. /);
    assert.match(review, /^# Evidence review\n\nYou independently review an investigation for the chief\. /);
    assert.match(investigate, provider === "codex" ? /This role is read-only in the Codex skill-led workflow\./ : /You write only your pages, in the task's pages folder/);
    assert.match(review, provider === "codex" ? /This role is read-only in the Codex skill-led workflow\./ : /This role is read-only: you have no file tools/);
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
  assert.match(text, /The chief or the lead handles the pull request/);
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
  assert.doesNotMatch(agent.split("\n---\n")[0], /^(?:tools|disallowedTools):/m);
  assert.match(agent.split("\n---\n")[0], /^skills:\n {2}- sage:sage$/m);
  assert.match(text, /The hook refuses a brief without them/);
  assert.match(text, /model sonnet/);
});

test("T586: the Codex arena steps come in Claude's order, and the Codex steps name only Codex's tools", () => {
  const titles = (text) => [...text.matchAll(/^\d\. \*\*(.+?)\*\*/gm)].map(([, title]) => title.replace(/[.:,]$/, ""));
  assert.match(JSON.parse(source("packages/sage-claude/chief-bindings.json")).ARENA, /first read `skills\/sage\/references\/arena\.md`/);
  const claude = titles(source("packages/sage-claude/skills/sage/references/arena.md"));
  const steps = source("packages/sage-codex/skills/sage/references/arena.md");
  assert.equal(claude.length, 9);
  assert.deepEqual(titles(steps), claude.map((title) => title.replace("`sage:arena-judge`", "the arena judge").replace("draft pull request", "branch")));
  assert.doesNotMatch(steps, /sage:arena-judge|sage run add|sage task|\bopus\b|\bsonnet\b/);
  assert.match(steps, /Run the PE with the judge's branch and page in its brief\. Give its `run_add` no `branch`/);
  assert.doesNotMatch(steps, /PE on the judge's branch/);
  const judge = source("plugins/sage/agents/arena-judge.md");
  assert.match(judge, /\n {3}- For a build: push your branch and open a draft pull request from it, as an implementer does\.\n/);
  assert.doesNotMatch(judge, /leaves? the pull request to the chief/);
});

test("shared chief Codex instructions keep unsupported routes inactive, and merge only by autopilot through sage's merge command", async t => {
  const f = isolated(t, "codex");
  const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
  assert.equal(typeof api.renderChiefInstructions, "function");
  const bindings = JSON.parse(readFileSync(join(f.plugin, "chief-bindings.json"), "utf8"));
  const text = api.renderChiefInstructions(bindings);
  assert.match(text, /sage on Codex needs a multi-agent v2 model for the chief and each child/);
  assert.match(text, /a tiny task goes through a lead to an implementer/);
  assert.match(text, /call `spawn_agent` in the `collaboration` namespace/);
  assert.match(text, /`fork_turns: "none"`/);
  assert.doesNotMatch(text, /sage_prepare_task|admission|preparation/i);
  assert.match(text, /PE and designer use the public skill-led helper/);
  assert.match(text, /\| arena-judge \| Scores/);
  assert.match(text, /first read the sage skill's `references\/arena\.md`/);
  assert.doesNotMatch(text, /arena[^\n]*(?:unavailable|not yet integrated)/i);
  assert.match(text, /installed acceptance/);
  assert.match(text, /Autopilot off:\*\* the user merges\. Report the PR link, exact head SHA and evidence\. Never push to main, force-push/);
  assert.match(text, /run sage's merge command from the main thread, escalated, as one command with no other words: `"<node>" "<plugin>\/skills\/sage\/merge\.mjs" <n> <sha>`/);
  assert.match(text, /The plugin's hook admits only this exact command, while autopilot is on and the merge check passes: no prompt\./);
  assert.match(text, /state tool checks at least one cycle/);
  assert.doesNotMatch(text, /CLAUDE\.md|~\/workspace|\.claude|sage:report|model fable|opus|sonnet|gh api|gate G15|\{\{|sage-core-chief/);
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
    assert.match(rewritten, /from "sage-core"/);
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
    const adapter = await import(pathToFileURL(join(f.plugin, provider === "claude" ? "hooks/command-policy.mjs" : "core/index.mjs")));
    const policy = adapter.createCommandPolicy();
    const candidate = `gh pr merge 12 --squash --delete-branch --match-head-commit ${sha}`;
    assert.deepEqual(policy.mergeRun(candidate, f.dir), { pr: "12", sha });
    for (const text of [candidate.replace(" 12 ", " 012 "), candidate.replace(sha, "abc"), `${candidate} --admin`,
      `sh -c '${candidate}'`, "gh pr 'merge"]) {
      assert.equal(typeof policy.mergeRun(text, f.dir)?.problem, "string", text);
    }
    for (const text of ["git status", "git merge topic", `echo '${candidate}'`, `echo '${candidate}' | head -1`, `node '${tool}' log --why '${candidate}'`, `node '/other/sage.mjs' log --why '${candidate}'`]) {
      assert.equal(policy.mergeRun(text, f.dir), undefined, text);
      assert.equal(api.createCommandPolicy().mergeRun(text, f.dir), undefined, text);
    }
    if (provider === "claude") {
      const hook = await import(pathToFileURL(join(f.plugin, "hooks/sage-hook.mjs")));
      assert.deepEqual(hook.mergeRun(candidate, f.dir), policy.mergeRun(candidate, f.dir));
      assert.equal(hook.mergeRun(`node '${tool}' log --why '${candidate}'`, f.dir), undefined);
    }
  }
});

test("shared command policy failures deny recognized Claude command tools before native handling", async t => {
  for (const missing of ["hooks/command-policy.mjs", "core/command-policy.mjs"]) {
    const f = isolated(t, "claude");
    assert.ok(existsSync(join(f.plugin, missing)));
    rmSync(join(f.plugin, missing));
    const hook = await import(pathToFileURL(join(f.plugin, "hooks/sage-hook.mjs")));
    for (const sage of [false, true]) for (const tool_name of ["Bash", "Monitor", "PowerShell", "mcp__terminal__run"]) {
      for (const actor of [{}, { agent_id: "fixture-child" }]) {
        const output = hook.handle({ hook_event_name: "PreToolUse", tool_name,
          tool_input: { command: "echo fixture" }, ...actor }, { sage }, {});
        assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
      }
    }
    assert.ok(hook.mergeRun("gh pr merge 1", f.dir)?.problem);
  }
});

test("shared push policy applies the same branch and force rules in both isolated providers", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    assert.equal(typeof api.createPushPolicy, "function");
    const adapter = await import(pathToFileURL(join(f.plugin, provider === "claude" ? "hooks/command-policy.mjs" : "core/index.mjs")));
    const calls = [];
    let branch = "topic";
    const policy = adapter.createPushPolicy({ readGh: fakeGh, readGit: fakeGit(dir => { calls.push(dir); return branch; }) });
    for (const text of ["git push origin topic", "git push -u --follow-tags origin topic", "git push --delete origin topic",
      "echo 'git push origin main'", "git status", "echo 'git push origin main' | sh"]) assert.equal(policy.pushProblem(text, f.dir), undefined, text);
    for (const text of ["git push origin main", "git push origin refs/heads/master", "git push origin topic:main",
      "git push -f origin topic", "git push --force-with-lease origin topic", "git push --forc origin topic",
      "git push --mirror origin", "git push origin HEAD", "git push origin", "git push upstream topic",
      "git push origin '$BRANCH'", "sudo git push origin main", "sh -c 'git push -f origin topic'", "git push 'origin"]) {
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
  mkdirSync(join(f.dir, "project/nested"), { recursive: true });
  const policy = api.createPushPolicy({ readGh: fakeGh, readGit: fakeGit(dir => { calls.push(dir); return "topic"; }) });
  assert.equal(policy.pushProblem("cd project; git -C nested push origin topic", f.dir), undefined);
  assert.deepEqual(calls, [join(f.dir, "project/nested")]);
  assert.equal(policy.pushProblem(`node '${tool}' log --why 'git push origin main'`, f.dir), undefined);
  assert.equal(policy.pushProblem("node /other/sage.mjs log --why 'git push origin main'", f.dir), undefined);
  assert.deepEqual(calls, [join(f.dir, "project/nested")]);
});

test("shared push policy validates and snapshots trusted branch readers and messages", async t => {
  const f = isolated(t, "codex");
  const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
  assert.equal(typeof api.createPushPolicy, "function");
  assert.equal(typeof api.createPushPolicy().pushProblem, "function");
  assert.throws(() => api.createPushPolicy({ readGit: 7 }), /readGit/);
  assert.throws(() => api.createPushPolicy({ readGit: fakeGit("topic"), readGh: "gh" }), /readGh/);
  for (const value of [null, 7, Promise.resolve("main")]) {
    assert.throws(() => api.createPushPolicy({ readGit: fakeGit("topic"), readGh: () => value }).pushProblem("git push origin topic", f.dir), /readGh/);
  }
  assert.deepEqual(["https://github.com/acme/site.git", "git@github.com:acme/site", "ssh://git@github.com/acme/site.git", "https://gitlab.com/acme/site", "https://github.com/acme/../x", "../site.git",
    "https://someone@GitHub.com/acme/site", "ssh://git@ssh.github.com:443/acme/site.git", "git@GITHUB.COM:acme/site.git", "github-work:acme/site", "https://github.com.evil.test/acme/site"].map(api.gitHubRepository),
    ["acme/site", "acme/site", "acme/site", undefined, undefined, undefined, "acme/site", "acme/site", "acme/site", undefined, undefined]);
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
  for (const value of ["main\n", "master\r\n"]) assert.match(api.createPushPolicy({ readGh: fakeGh, readGit: fakeGit(value) }).pushProblem("git push origin topic", f.dir), /checkout is on ma/);
  for (const value of ["topic\u00a0name", "topic\u2003name"]) {
    assert.equal(execFileSync("git", ["check-ref-format", "--branch", value], { encoding: "utf8" }).trimEnd(), value);
    assert.equal(api.createPushPolicy({ readGh: fakeGh, readGit: fakeGit(value) }).pushProblem(`git push origin '${value}'`, f.dir), undefined);
  }
  const broken = api.createPushPolicy({ readGh: fakeGh, readGit: () => { throw new Error("fixture read failure"); } });
  assert.throws(() => broken.pushProblem("git push origin topic", f.dir), /fixture read failure/);
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

test("Codex hook state refuses linked or public state directories and cannot overwrite a linked target", async t => {
  const { dir, plugin } = isolated(t, "codex");
  const { privateDirectory, readState, saveState } = await import(pathToFileURL(join(plugin, "hooks/hook-state.mjs")));
  const base = join(dir, "state"), outside = join(dir, "outside");
  mkdirSync(outside, { mode: 0o700 });
  symlinkSync(outside, base, "dir");
  assert.throws(() => privateDirectory(join(base, "codex")), /unsafe state/);
  assert.equal(existsSync(join(outside, "codex")), false);
  rmSync(base); mkdirSync(base, { mode: 0o700 });
  symlinkSync(outside, join(base, "codex"), "dir");
  assert.throws(() => privateDirectory(join(base, "codex")), /unsafe state directory/);
  rmSync(join(base, "codex")); mkdirSync(join(base, "codex"), { mode: 0o700 });
  chmodSync(base, 0o777);
  assert.throws(() => privateDirectory(join(base, "codex")), /unsafe state parent/);
  chmodSync(base, 0o700);
  const shared = join(dir, "shared"); mkdirSync(shared); chmodSync(shared, 0o777);
  assert.throws(() => privateDirectory(join(shared, "state")), /unsafe state parent/);
  assert.equal(existsSync(join(shared, "state")), false, "a shared nonsticky parent can rename a private child");
  privateDirectory(join(base, "codex"));
  const target = join(outside, "keep.json");
  const original = JSON.stringify({ sage: true, marker: "unchanged" });
  writeFileSync(target, original);
  const file = join(base, "codex", "linked.json");
  symlinkSync(target, file);
  assert.throws(() => readState(file), { code: "ELOOP" });
  saveState(file, { sage: false });
  assert.equal(readFileSync(target, "utf8"), original);
  assert.equal(lstatSync(file).isSymbolicLink(), false);
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readState(file), { sage: false });
});

test("Codex hook state refuses a folder below a foreign-owned ancestor even when its mode looks safe", async t => {
  const { dir, plugin } = isolated(t, "codex");
  const { privateDirectory } = await import(pathToFileURL(join(plugin, "hooks/hook-state.mjs")));
  const original = fs.lstatSync;
  t.after(() => { fs.lstatSync = original; syncBuiltinESMExports(); });
  for (const mode of [0o755, 0o1777]) for (const nested of [false, true]) {
    const foreign = join(dir, `foreign-${mode}-${nested}`); mkdirSync(foreign, { mode });
    const parent = nested ? join(foreign, "owned-child") : foreign;
    if (nested) mkdirSync(parent, { mode: 0o700 });
    const base = join(parent, "state");
    fs.lstatSync = (path, ...args) => {
      const info = original(path, ...args);
      if (path === foreign) Object.defineProperty(info, "uid", { value: process.getuid() + 1 });
      return info;
    };
    syncBuiltinESMExports();
    try {
      assert.throws(() => privateDirectory(join(base, "codex")), /unsafe state (parent|ancestor)/);
    } finally { fs.lstatSync = original; syncBuiltinESMExports(); }
    assert.equal(existsSync(base), false, "another directory owner can replace the path despite safe-looking permission bits");
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

test("shared shell reader options preserve option values in either bundle", async t => {
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
      "diff --label=--paginate left right", "diff -- --paginate right", "echo rg --pre cat x"])
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

test("native deadline waits for child closure when the timeout callback throws", async t => {
  const { waitNative } = await import("./wait-child.mjs");
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
  t.mock.timers.tick(300_000);
  assert.deepEqual(signals, []);
  assert.equal(child.stdin.writableEnded, true);
  for (const stream of [child.stdin, child.stdout, child.stderr]) assert.equal(stream.destroyed, true);
  assert.equal(detached, false);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.listenerCount("error"), 0);
});


test("native spawn error waits for closure before releasing its owner", async t => {
  const { waitNative } = await import("./wait-child.mjs");
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

for (const scenario of ['success', 'exit-error', 'bad-manifest']) test(`Codex package check: ${scenario} closes its child without signals`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sage-package-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const signalLog = join(dir, 'signals'), closed = join(dir, 'closed');
  const preload = join(dir, 'no-signals.mjs'), binary = join(dir, 'codex');
  writeFileSync(preload, `import {ChildProcess} from 'node:child_process';\nimport {appendFileSync} from 'node:fs';\nChildProcess.prototype.kill = function(signal) { appendFileSync(${JSON.stringify(signalLog)}, String(signal)+'\\n'); this.stdin?.end(); return true; };\n`);
  const plugin = {
    skills: readdirSync(join(ROOT, 'plugins/sage-codex/skills')).map(name => ({name: `sage:${name}`})),
    hooks: [],
    summary: {source: {path: join(ROOT, 'plugins/sage-codex')}},
  };
  if (scenario === 'bad-manifest') plugin.hooks = [{eventName: 'preToolUse'}];
  const list = `const hooks = Object.entries(JSON.parse(readFileSync(process.env.CODEX_HOME + '/hooks.json', 'utf8')).hooks).map(([e, [g]]) => ({eventName: e[0].toLowerCase() + e.slice(1), key: process.env.CODEX_HOME + '/hooks.json:' + e + ':0:0', currentHash: 'sha256:1', source: 'user', matcher: null, command: g.hooks[0].command, trustStatus: trusted ? 'trusted' : 'untrusted'}));`;
  writeFileSync(binary, `#!${process.execPath}\nimport {createInterface} from 'node:readline';\nimport {readFileSync, writeFileSync} from 'node:fs';\nlet trusted = false;\nif (process.argv.includes('--version')) { console.log('codex-cli 0.160.0'); } else {\nconst reader = createInterface({input: process.stdin});\nreader.on('line', line => { const request = JSON.parse(line); if (!request.id) return; let result = {}; if (request.method === 'plugin/read') result = {plugin:${JSON.stringify(plugin)}}; if (request.method === 'config/batchWrite') trusted = true; if (request.method === 'hooks/list') { ${list} result = {data: [{hooks}]}; } console.log(JSON.stringify({id:request.id,result})); });\nreader.on('close', () => { writeFileSync(${JSON.stringify(closed)}, 'stdin closed'); process.exitCode=${scenario === 'exit-error' ? 7 : 0}; });\n}\n`, {mode: 0o700});
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
    assert.match(stdout, /discovered \d+ skills and no plugin hook .* all 8 stay trusted/);
  } else {
    assert.equal(result.code, 1, stdout + stderr);
    assert.doesNotMatch(stdout, /discovered \d+ skills/);
    assert.match(stderr, /Codex package check failed:/);
  }
});


test("native deadline escalates only its owned child and still waits for closure", async t => {
  const { waitNative } = await import("./wait-child.mjs");
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
  const { waitNative } = await import("./wait-child.mjs");
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
  const { waitNative } = await import("./wait-child.mjs");
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
  const { waitNative } = await import("./wait-child.mjs");
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
    const { commandWrites } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    const root = join(f.dir, "logbook"), cwd = join(f.dir, "project"); mkdirSync(root); mkdirSync(cwd);
    for (const name of ["&1", "&2", "&1-", "&-"]) {
      symlinkSync(join(root, "ledger.tsv"), join(cwd, name));
      const command = `printf fixed > '${name}'`;
      assert.equal(commandWrites(command, cwd), true, command);
    }
    mkdirSync(join(cwd, ">")); symlinkSync(root, join(cwd, ">", "dev"));
    const command = "printf fixed > '>/dev/null'";
    assert.equal(commandWrites(command, cwd), true, command);
    for (const command of ["printf fixed >&1", "printf fixed 2>&2", "printf fixed > /dev/null"])
      assert.equal(commandWrites(command, cwd), false, command);
    assert.equal(existsSync(join(root, "ledger.tsv")), false);
    assert.equal(existsSync(join(root, "null")), false);
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

test('role edit policy matches the shared writer and independent review roles in both bundles', async t => {
  for (const provider of ['claude', 'codex']) {
    const f = { api: await import(pathToFileURL(join(isolated(t, provider).plugin, "core/index.mjs"))) };
    for (const role of ['chief-of-staff', 'lead', 'pe', 'code-reviewer', 'security-reviewer', 'ux-reviewer', 'qa'])
      assert.equal(f.api.roleEditDenied({ sage: true, role }), true, role);
    for (const role of ['implementer', 'designer', 'arena-judge'])
      assert.equal(f.api.roleEditDenied({ sage: true, role }), false, role);
    assert.equal(f.api.roleEditDenied({ sage: false, role: null }), false);
    for (const context of [{ sage: true, role: null }, { sage: true, role: 'other' }, { sage: false, role: 'other' },
      { sage: 'on', role: 'lead' }, { sage: true }, {}]) assert.throws(() => f.api.roleEditDenied(context));
  }
});

const reviewTarget = () => ({ branch: 'codex/t1-review', sha: 'a'.repeat(40), round: 0, cycle: 1 });

function claimedReview(role, changes = {}) {
  const target = reviewTarget();
  return { STATUS:'done', RESULT:role === 'qa' ? 'PASS' : 'CLEAN',
    EVIDENCE:JSON.stringify({commit:target.sha,round:target.round,cycle:target.cycle,summary:'Reviewed the saved change.'}),
    FINDINGS:'[]', QUESTIONS:'none', 'NOT VERIFIED':'Real model behavior.', BRANCH:target.branch, ...changes };
}

test('review claims map every clean and blocking result without accepting a verdict', async t => {
  for (const provider of ['claude','codex']) {
    const f = { api: await import(pathToFileURL(join(isolated(t, provider).plugin, "core/index.mjs"))) };
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
  }
});

test('review claims refuse changed targets unanswered questions and contradictory findings', async t => {
  const f = { api: await import(pathToFileURL(join(isolated(t, "codex").plugin, "core/index.mjs"))) };
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
  const f = { api: await import(pathToFileURL(join(isolated(t, "codex").plugin, "core/index.mjs"))) }, good = claimedReview('qa'), evidence = JSON.parse(good.EVIDENCE);
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
  assert.throws(() => assertSdkBundleGraph({ inputs: { 'renamed-sdk.mjs': {} } },
    () => '// node_modules/.pnpm/fast-uri@3.1.0/node_modules/fast-uri/index.js'), /excluded JSON Schema validator dependency/);
  const built = outputs().get('plugins/sage-codex/runtime/mcp-sdk.mjs');
  assert.ok(built === source('plugins/sage-codex/runtime/mcp-sdk.mjs'), 'inspect the same bundle that ships');
  assert.doesNotMatch(built, /require_fast_uri|fast-uri@|ajvProvider/);
  for (const name of ['ajv', 'ajv-formats', 'fast-deep-equal', 'fast-uri', 'json-schema-traverse']) {
    assert.equal(existsSync(join(ROOT, 'plugins/sage-codex/licenses', name + '.txt')), false, 'removed dependencies must not have stale license-version claims');
  }
});

test("T85 isolated public PE and designer helpers render shared contracts and truthful design guidance", async t => {
  const f = await roleInstructionsFixture(t);
  const helper = join(f.plugin, "skills/sage/role.mjs");
  for (const role of ["pe", "designer"]) {
    const result = spawnSync(process.execPath, [helper, role], { encoding: "utf8", cwd: f.dir });
    assert.equal(result.status, 0, result.stderr);
    const approvals = readFileSync(join(f.plugin, `skills/sage/references/${role === "designer" ? "approvals" : "sandbox-refusal"}.md`), "utf8").trim();
    assert.ok(result.stdout.startsWith(`${f.api.renderRoleInstructions(role, f.bindings[role])}\n\n# The principles of your role\n\n## `));
    assert.ok(result.stdout.endsWith(`\n\n${approvals}\n\n${f.api.renderReportInstructions(f.bindings.report)}\n`));
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
  assert.match(workflow, /designer → PE → the owner's answer on the design → build\. A design waits for the owner's approval when it changes what the user sees or data that the user keeps; an internal shape goes ahead/);
  assert.match(workflow, /ordinary.*design.*gate.*not.*merge refusal/i);
  assert.match(briefs, /pages.*folder/);
  assert.match(briefs, /CHANGE/);
  assert.doesNotMatch(roles + workflow + briefs, /Large design\/PE work stays with the parent/);
});
