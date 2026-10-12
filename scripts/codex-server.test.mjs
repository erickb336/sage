import "./test-env.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { ROOT } from "./build.mjs";

const session = "d72422c7-509c-43aa-8c42-827c556f8a57";
const childActor = "f22422c7-509c-43aa-8c42-827c556f8a58";
const turns = ["e22422c7-509c-43aa-8c42-827c556f8a57", "e22422c7-509c-43aa-8c42-827c556f8a58", "e22422c7-509c-43aa-8c42-827c556f8a59"];

function fixture(t, policy = "normal") {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-native-server-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plugin = join(dir, "plugin");
  cpSync(join(ROOT, "plugins/sage-codex"), plugin, { recursive: true });
  assert.ok(existsSync(join(plugin, "runtime/mcp-server.mjs")), "the native server ships in the plugin");
  const sessions = join(dir, "sessions"); mkdirSync(sessions);
  const transcript = join(sessions, "root.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { id: session, session_id: session, cli_version: "0.160.0" } }) + "\n");
  const mode = { directory: join(dir, "admission"), project: "fixture", projectDirectory: dir, sessionsDir: sessions };
  const entry = join(dir, "server.mjs");
  writeFileSync(entry, `
    import { configureAdmission } from './plugin/core/index.mjs';
    import { readMode } from './plugin/runtime/mode.mjs';
    import { directEditDecision } from './plugin/runtime/file-policy.mjs';
    import { serveHooks } from './plugin/runtime/mcp-server.mjs';
    const mode = ${JSON.stringify(mode)};
    configureAdmission(mode.directory, { total: 3, projects: [{ project: 'fixture', limit: 3 }] });
    serveHooks({ mode, loadPolicy: async () => {
      if (${JSON.stringify(policy)} === 'throw') throw Error('private loader detail');
      return { evaluate: (input, native) => ${JSON.stringify(policy)} === 'invalid' ? { decision: 'allow' }
        : directEditDecision(input, { sage: readMode(mode.directory, mode.project, input.session_id).sage, chief: native.actor === input.session_id }) };
    } });
  `);
  return { dir, plugin, mode, entry, prompt: (text, turn = turns[0]) => ({ cwd: dir, hook_event_name: "UserPromptSubmit", model: "fixture",
    permission_mode: "default", prompt: text, session_id: session, transcript_path: transcript, turn_id: turn }) };
}
const patch = (turn = turns[0]) => ({ hook_event_name: "PreToolUse", session_id: session, turn_id: turn,
  tool_name: "apply_patch", tool_use_id: "call-1", tool_input: { patch: "fixed input" } });

async function connect(t, fixture, version = "0.160.0", expectedStderr = "", toolName = "sage_native_hook") {
  const child = spawn(process.execPath, [fixture.entry], { cwd: fixture.dir, stdio: ["pipe", "pipe", "pipe"], shell: false });
  t.after(() => child.stdin.end());
  let stderr = "", nextId = 0;
  const pending = new Map();
  const closed = new Promise(resolve => child.once("close", (code, signal) => {
    for (const { reject } of pending.values()) reject(Error("server closed before response"));
    resolve({ code, signal });
  }));
  child.stderr.on("data", data => { stderr += data; });
  createInterface({ input: child.stdout }).on("line", line => {
    try { const reply = JSON.parse(line); pending.get(reply.id)?.resolve(reply); pending.delete(reply.id); }
    catch (error) { for (const { reject } of pending.values()) reject(error); child.stdin.end(); }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex", version } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const listed = await request("tools/list", {});
  assert.deepEqual(listed.result.tools.map(tool => tool.name).sort(), toolName === "sage_native_hook"
    ? ["sage_native_hook"] : ["sage_accept_review", "sage_create_run", "sage_create_task", "sage_finish_run", "sage_prepare_task", "sage_read_recorded_report", "sage_read_report", "sage_read_task", "sage_record_report", "sage_update_task"]);
  assert(listed.result.tools.some(tool => tool.name === toolName));
  if (toolName === "sage_native_hook") assert.deepEqual(listed.result.tools[0]._meta.ui.visibility, ["app"]);
  else assert.equal(listed.result.tools[0]._meta?.ui?.visibility, undefined);
  return {
    call: async (input, actor = session) => {
      const response = await request("tools/call", { name: toolName, arguments: input, _meta: { threadId: actor } });
      assert.equal(response.error, undefined);
      if (toolName === "sage_native_hook") assert.equal(response.result.isError, undefined, "policy denials must be successful MCP results");
      else if (response.result.isError) return { error: response.result.content[0].text };
      assert.doesNotMatch(JSON.stringify(response), /private loader detail/);
      return JSON.parse(response.result.content[0].text);
    },
    close: async () => { child.stdin.end(); assert.deepEqual(await closed, { code: 0, signal: null }); assert.equal(stderr, expectedStderr); },
  };
}

test("packaged native server persists owner mode and keeps native child identity across connections", async t => {
  const f = fixture(t);
  for (const [index, text] of ["sage mode", "continue", "sage mode off"].entries()) {
    const client = await connect(t, f);
    const ownerOutput = await client.call(f.prompt(text, turns[index]));
    if (index === 0) assert.match(ownerOutput.hookSpecificOutput.additionalContext, /sage_prepare_task/);
    else assert.deepEqual(ownerOutput, {});
    const output = await client.call(patch(turns[index]));
    if (index < 2) assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
    else assert.deepEqual(output, {});
    assert.deepEqual(await client.call(patch(turns[index]), childActor), {});
    await client.close();
  }
  const { readAdmission } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
  assert.deepEqual(readAdmission(f.mode.directory).modes.map(row => row.sage), [true, false]);
});

test("packaged native server explicitly blocks unverified and unsupported prompt requests", async t => {
  const f = fixture(t);
  const client = await connect(t, f);
  for (const [input, actor] of [[f.prompt("sage mode"), childActor], [f.prompt("sage mode"), null],
    [{ ...f.prompt("sage mode"), cwd: "/wrong-project" }, session], [{ hook_event_name: "Unknown" }, session],
    [{ ...f.prompt("sage mode"), prompt: "x".repeat(1024 * 1024 + 1) }, session]]) {
    assert.deepEqual(await client.call(input, actor), { decision: "block", reason: "Sage could not verify this hook request." });
  }
  await client.close();
  const unsupported = await connect(t, f, "unsupported");
  assert.equal((await unsupported.call(f.prompt("sage mode"))).decision, "block");
  assert.equal((await unsupported.call(patch())).hookSpecificOutput.permissionDecision, "deny");
  await unsupported.close();
  const { readAdmission } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
  assert.deepEqual(readAdmission(f.mode.directory).sessions, []);
});

test("packaged native server denies failed and invalid tool policies without leaking errors", async t => {
  for (const policy of ["throw", "invalid"]) {
    const f = fixture(t, policy); const client = await connect(t, f);
    assert.equal((await client.call(patch())).hookSpecificOutput.permissionDecision, "deny");
    assert.equal((await client.call({ hook_event_name: "PreToolUse" })).hookSpecificOutput.permissionDecision, "deny");
    await client.close();
  }
});

test("packaged native server turns missing policy modules into explicit denials", async t => {
  const f = fixture(t);
  // Load the server first, then remove modules before their lazy import.
  const client = await connect(t, f);
  rmSync(join(f.plugin, "runtime/mcp-policy.mjs"));
  assert.equal((await client.call(patch())).hookSpecificOutput.permissionDecision, "deny");
  // mode.mjs was imported by the fixture launcher, so test its first lazy dependency instead.
  const source = readFileSync(f.entry, "utf8");
  await client.close();
  writeFileSync(f.entry, source.replace("import { readMode } from './plugin/runtime/mode.mjs';", "const readMode = () => ({ sage: false });"));
  rmSync(join(f.plugin, "runtime/mode.mjs"));
  const next = await connect(t, f);
  assert.equal((await next.call(f.prompt("sage mode"))).decision, "block");
  await next.close();
});


async function configured(t) {
  const f = fixture(t);
  const core = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
  core.configureAdmission(f.mode.directory, { total: 3, projects: [{ project: "fixture", limit: 3 }] });
  const configFile = join(f.dir, "native.json");
  const config = { version: 1, mode: { ...f.mode } };
  writeFileSync(configFile, JSON.stringify(config));
  const api = await import(pathToFileURL(join(f.plugin, "runtime/configuration.mjs")));
  const entry = readFileSync(f.entry, "utf8")
    .replace("import { serveHooks } from './plugin/runtime/mcp-server.mjs';", "import { serveConfiguredHooks } from './plugin/runtime/configuration.mjs';")
    .replace("serveHooks({ mode, loadPolicy: async () => {", `serveConfiguredHooks(${JSON.stringify(configFile)}, async mode => {`)
    .replace("    } });", "    });");
  writeFileSync(f.entry, entry);
  return { ...f, ...api, configFile, config };
}
const configDenied = error => error.message === "Sage native hook configuration is unavailable.";

test("native launcher configuration reads fixed project settings without changing the journal", async t => {
  const f = await configured(t);
  const before = readdirSync(f.mode.directory).sort().map(name => [name, readFileSync(join(f.mode.directory, name), "utf8")]);
  const mode = f.readHookConfiguration(f.configFile);
  assert.deepEqual(mode, f.mode);
  assert.equal(Object.isFrozen(mode), true);
  assert.deepEqual(readdirSync(f.mode.directory).sort().map(name => [name, readFileSync(join(f.mode.directory, name), "utf8")]), before);
  const client = await connect(t, f);
  assert.match((await client.call(f.prompt("sage mode"))).hookSpecificOutput.additionalContext, /sage_prepare_task/);
  assert.equal((await client.call(patch())).hookSpecificOutput.permissionDecision, "deny");
  // A connection keeps its verified configuration even if the file changes later.
  writeFileSync(f.configFile, "invalid");
  assert.deepEqual(await client.call(f.prompt("sage mode off", turns[1])), {});
  assert.deepEqual(await client.call(patch(turns[1])), {});
  await client.close();
});

test("native launcher configuration rejects unknown fields and unconfigured paths without creating state", async t => {
  const f = await configured(t);
  const missing = join(f.dir, "must-not-be-created");
  for (const config of [null, [], {}, { ...f.config, version: 2 }, { ...f.config, loader: "untrusted.mjs" },
    { ...f.config, mode: { ...f.mode, extra: true } }, { ...f.config, mode: { ...f.mode, project: "other" } },
    { ...f.config, mode: { ...f.mode, directory: missing } }, { ...f.config, mode: { ...f.mode, directory: f.dir } },
    { ...f.config, mode: { ...f.mode, sessionsDir: f.configFile } }, { ...f.config, mode: { ...f.mode, projectDirectory: "." } }]) {
    writeFileSync(f.configFile, JSON.stringify(config));
    assert.throws(() => f.readHookConfiguration(f.configFile), configDenied);
  }
  assert.equal(existsSync(missing), false);
});

test("native launcher configuration rejects links, oversized files, invalid bytes, and non-files", async t => {
  const f = await configured(t);
  const linked = join(f.dir, "linked.json"); symlinkSync(f.configFile, linked);
  const linkedDir = join(f.dir, "linked-directory"); symlinkSync(f.dir, linkedDir, "dir");
  for (const path of [linked, join(linkedDir, "native.json"), f.dir, "native.json"]) {
    assert.throws(() => f.readHookConfiguration(path), configDenied);
  }
  writeFileSync(f.configFile, JSON.stringify({ ...f.config, mode: { ...f.mode, sessionsDir: linkedDir } }));
  assert.throws(() => f.readHookConfiguration(f.configFile), configDenied);
  for (const bytes of [Buffer.from([0xff]), Buffer.from("{}".padEnd(64 * 1024 + 1, " "))]) {
    writeFileSync(f.configFile, bytes);
    assert.throws(() => f.readHookConfiguration(f.configFile), configDenied);
  }
});

test("invalid native launcher configuration blocks prompts and tools until a new connection", async t => {
  const f = await configured(t);
  const marker = join(f.dir, "loader-called");
  writeFileSync(f.entry, "import {writeFileSync} from 'node:fs';\n" + readFileSync(f.entry, "utf8")
    .replace("async mode => {", `async mode => { writeFileSync(${JSON.stringify(marker)}, 'called');`));
  writeFileSync(f.configFile, "invalid");
  const client = await connect(t, f, "0.160.0", "Sage native hook configuration is unavailable.\n");
  assert.equal((await client.call(f.prompt("sage mode"))).decision, "block");
  assert.equal((await client.call(patch())).hookSpecificOutput.permissionDecision, "deny");
  writeFileSync(f.configFile, JSON.stringify(f.config));
  assert.equal((await client.call(f.prompt("sage mode"))).decision, "block");
  assert.equal((await client.call(patch())).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(existsSync(marker), false, "invalid configuration must not invoke policy loading");
  await client.close();
  const repaired = await connect(t, f);
  assert.match((await repaired.call(f.prompt("sage mode"))).hookSpecificOutput.additionalContext, /sage_prepare_task/);
  assert.equal((await repaired.call(patch())).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(readFileSync(marker, "utf8"), "called");
  await repaired.close();
});


test("native launcher configuration permits a not-yet-created session directory but rejects dangling links", async t => {
  const f = await configured(t);
  rmSync(f.mode.sessionsDir, { recursive: true });
  assert.deepEqual(f.readHookConfiguration(f.configFile), f.mode);
  assert.equal(existsSync(f.mode.sessionsDir), false, "configuration must not create the native session directory");
  symlinkSync(join(f.dir, "absent-target"), f.mode.sessionsDir, "dir");
  assert.throws(() => f.readHookConfiguration(f.configFile), configDenied);
  writeFileSync(f.configFile, JSON.stringify({ ...f.config, mode: { ...f.mode, sessionsDir: f.mode.sessionsDir + "/" } }));
  assert.throws(() => f.readHookConfiguration(f.configFile), configDenied);
});

function childFixture(t, outcome = { decision: "deliver", brief: "Role: implementer\nTask: the fixed fixture task." }) {
  const f = fixture(t);
  const transcript = join(f.mode.sessionsDir, "child.jsonl");
  const metadata = { id: childActor, session_id: session, parent_thread_id: session,
    agent_path: "/root/fixture", cli_version: "0.160.0" };
  const writeMetadata = (value = metadata, turn = turns[0]) => writeFileSync(transcript,
    JSON.stringify({ type: "session_meta", payload: value }) + "\n"
    + JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: turn } }) + "\n");
  writeMetadata();
  const marker = join(f.dir, "start-policy.json");
  writeFileSync(f.entry, "import { writeFileSync } from 'node:fs';\n" + readFileSync(f.entry, "utf8")
    .replace("return { evaluate:", `return { startChild: identity => {
      if (!Object.isFrozen(identity)) throw Error('private unfrozen identity');
      writeFileSync(${JSON.stringify(marker)}, JSON.stringify(identity));
      return ${JSON.stringify(outcome)};
    }, evaluate:`));
  return { ...f, transcript, metadata, marker, writeMetadata, start: () => ({ hook_event_name: "SubagentStart",
    session_id: session, turn_id: turns[0], agent_id: childActor, transcript_path: transcript }) };
}

test("packaged child start delivers policy instructions only after native identity verification", async t => {
  const f = childFixture(t); const client = await connect(t, f);
  assert.deepEqual(await client.call(f.start(), childActor), { hookSpecificOutput: {
    hookEventName: "SubagentStart", additionalContext: "Role: implementer\nTask: the fixed fixture task." } });
  assert.deepEqual(JSON.parse(readFileSync(f.marker, "utf8")), { session, child: childActor,
    parent: session, path: "/root/fixture", turn: turns[0] });
  await client.close();
});

test("packaged child start rejects mismatched native actors and metadata before policy invocation", async t => {
  const f = childFixture(t); const client = await connect(t, f);
  for (const [input, actor] of [[f.start(), session], [f.start(), null],
    [{ ...f.start(), role: "lead" }, childActor], [{ ...f.start(), turn_id: "invalid" }, childActor],
    [{ ...f.start(), transcript_path: f.prompt("test").transcript_path }, childActor]]) {
    assert.equal((await client.call(input, actor)).decision, "block");
    assert.equal(existsSync(f.marker), false);
  }
  for (const change of [{ cli_version: "old" }, { session_id: childActor }, { id: session },
    { parent_thread_id: childActor }, { parent_thread_id: null }, { agent_path: "/root" }]) {
    f.writeMetadata({ ...f.metadata, ...change });
    assert.equal((await client.call(f.start(), childActor)).decision, "block");
    assert.equal(existsSync(f.marker), false);
  }
  f.writeMetadata();
  await client.close();
  const unsupported = await connect(t, f, "old");
  assert.equal((await unsupported.call(f.start(), childActor)).decision, "block");
  assert.equal(existsSync(f.marker), false);
  await unsupported.close();
});

test("packaged child start refuses missing identity and invalid briefs without protocol errors", async t => {
  for (const outcome of [null, { decision: "allow" }, { decision: "deliver", brief: "" },
    { decision: "deliver", brief: "x".repeat(64 * 1024 + 1) }, { decision: "deliver", brief: "x\0y" },
    { decision: "pass", brief: "unexpected" }]) {
    const f = childFixture(t, outcome); const client = await connect(t, f);
    assert.deepEqual(await client.call(f.start(), childActor), { decision: "block", reason: "Sage could not verify this hook request." });
    await client.close();
  }
  const f = childFixture(t); const client = await connect(t, f);
  rmSync(f.transcript);
  assert.equal((await client.call(f.start(), childActor)).decision, "block");
  assert.equal(existsSync(f.marker), false);
  await client.close();
});

test("packaged child start supports explicit no-instruction policy and contains loader failures", async t => {
  const f = childFixture(t, { decision: "pass" }); const client = await connect(t, f);
  assert.deepEqual(await client.call(f.start(), childActor), {});
  await client.close();
  for (const replacement of ["throw Error('private loader detail');", "return {};",
    "return { startChild() { throw Error('private loader detail'); } };"]) {
    const failed = childFixture(t);
    writeFileSync(failed.entry, readFileSync(failed.entry, "utf8").replace("loadPolicy: async () => {", `loadPolicy: async () => { ${replacement}`));
    const next = await connect(t, failed);
    assert.equal((await next.call(failed.start(), childActor)).decision, "block");
    await next.close();
  }
});

test("packaged child start uses child metadata and native turn when history contains parent records", async t => {
  const f = childFixture(t);
  writeFileSync(f.transcript, JSON.stringify({ type: "session_meta", payload: f.metadata }) + "\n"
    + JSON.stringify({ type: "session_meta", payload: { id: session, session_id: session, cli_version: "0.160.0" } }) + "\n"
    + JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: turns[0] } }) + "\n");
  const client = await connect(t, f);
  const result = await client.call({ ...f.start(), turn_id: turns[1] }, childActor);
  assert.equal(result.hookSpecificOutput?.additionalContext, "Role: implementer\nTask: the fixed fixture task.");
  assert.equal(JSON.parse(readFileSync(f.marker, "utf8")).turn, turns[1]);
  await client.close();
});

const postSpawn = () => ({ hook_event_name: "PostToolUse", session_id: session, turn_id: turns[0],
  tool_name: "collaborationspawn_agent", tool_use_id: "spawn-1", tool_input: { task_name: "qa", message: "private task" },
  tool_response: JSON.stringify({ task_name: "/root/qa", detail: "private result" }) });

test("packaged native server records post-tool identity with a durable idempotent receipt", async t => {
  const f = fixture(t); const observations = join(f.dir, "observations");
  writeFileSync(f.entry, "import { publish } from './plugin/runtime/events.mjs';\n" + readFileSync(f.entry, "utf8")
    .replace("return { evaluate:", `return { recordDispatchResult: record => {
      publish(${JSON.stringify(observations)}, record); return { decision: 'recorded' };
    }, evaluate:`));
  const client = await connect(t, f);
  for (const actor of [session, session, childActor]) assert.deepEqual(await client.call(postSpawn(), actor), {});
  await client.close();
  const { readObservations } = await import(pathToFileURL(join(f.plugin, "runtime/events.mjs")));
  const records = readObservations(observations);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(row => row.actor).sort(), [session, childActor].sort());
  assert(records.every(row => row.kind === "spawn-result" && row.session === session && row.call === "spawn-1"));
  assert.doesNotMatch(JSON.stringify(records), /private/);
});

test("packaged native server contains post-tool validation, loading, and publication failures", async t => {
  const f = fixture(t, "throw"); const client = await connect(t, f);
  for (const [input, actor] of [[postSpawn(), session], [postSpawn(), null],
    [{ ...postSpawn(), agent_id: childActor }, session], [{ ...postSpawn(), tool_response: "malformed" }, session]]) {
    assert.deepEqual(await client.call(input, actor), { decision: "block", reason: "Sage could not verify this hook request." });
  }
  await client.close();
  const missing = fixture(t); rmSync(join(missing.plugin, "runtime/post-tool.mjs"));
  const next = await connect(t, missing);
  assert.equal((await next.call(postSpawn())).decision, "block");
  await next.close();
  const failed = fixture(t);
  writeFileSync(failed.entry, readFileSync(failed.entry, "utf8").replace("return { evaluate:",
    "return { recordDispatchResult() { throw Error('private loader detail'); }, evaluate:"));
  const failedClient = await connect(t, failed);
  assert.equal((await failedClient.call(postSpawn())).decision, "block");
  await failedClient.close();
});

test("packaged child start rejects inherited policy fields instead of delivering an invalid brief", async t => {
  for (const expression of ["Object.assign(Object.create({decision:'deliver'}),{brief:'invalid inherited decision',extra:true})",
    "Object.assign(Object.create({brief:'invalid inherited brief'}),{decision:'deliver',extra:true})"]) {
    const f = childFixture(t);
    writeFileSync(f.entry, readFileSync(f.entry, "utf8").replace(
      'return {"decision":"deliver","brief":"Role: implementer\\nTask: the fixed fixture task."};', `return ${expression};`));
    const client = await connect(t, f);
    assert.equal((await client.call(f.start(), childActor)).decision, "block");
    await client.close();
  }
});

async function preparationServerFixture(t) {
  const f = fixture(t);
  assert.ok(existsSync(join(f.plugin, "runtime/preparation-server.mjs")), "the separate preparation server must ship");
  const core = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
  const events = await import(pathToFileURL(join(f.plugin, "runtime/events.mjs")));
  const api = await import(pathToFileURL(join(f.plugin, "runtime/preparation.mjs")));
  const options = { directory: f.mode.directory, project: f.mode.project, sessionsDir: f.mode.sessionsDir, observationsRoot: join(f.dir, "observations"),
    projectDirectory: join(f.dir, "assignment-project"), logbookRoot: join(f.dir, "assignment-logbook") };
  mkdirSync(options.projectDirectory); mkdirSync(options.observationsRoot);
  const assignmentTool = core.createStateTool({ defaultRoot: () => { throw Error("No ambient logbook"); } });
  const assignmentEnv = { ...process.env, SAGE_HOME: options.logbookRoot };
  const assignmentCli = (...args) => assignmentTool.sage([...args, "--project", options.projectDirectory], assignmentEnv);
  const assignmentGit = (...args) => execFileSync("git", ["-C", options.projectDirectory, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "user.name=Fixture", "-c", "user.email=fixture@users.noreply.github.com", ...args], { env: assignmentEnv, encoding: "utf8" });
  assignmentGit("init", "--quiet", "-b", "codex/t1-fixture"); assignmentGit("commit", "--quiet", "--allow-empty", "-m", "fixture");
  assignmentCli("init"); assignmentCli("task", "add", "--title", "Fixture task", "--size", "small");
  assignmentCli("task", "T1", "set", "branch=codex/t1-fixture");
  assignmentCli("run", "add", "T1", "--role", "lead"); assignmentCli("run", "add", "T1", "--role", "qa");
  assignmentCli("task", "add", "--title", "Second fixture task", "--size", "small");
  assignmentCli("run", "add", "T2", "--role", "lead");
  const assignmentLogbook = assignmentTool.storeDir(options.projectDirectory, assignmentEnv);
  core.configureAdmission(options.directory, { total: 5, projects: [{ project: options.project, limit: 5 }] });
  const owner = core.activateAdmission(options.directory, { project: options.project, session: `codex:${session}`, activation: turns[0] });
  const scope = { project: owner.project, session: owner.session, epoch: owner.epoch };
  writeFileSync(f.entry, `import { servePreparations } from './plugin/runtime/preparation-server.mjs'; servePreparations(${JSON.stringify(options)});`);
  const brief = Object.fromEntries(["GOAL", "SCOPE", "CONTEXT", "DECISIONS", "ACCEPTANCE", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"].map(key => [key, "Complete the fixture task."]));
  const input = { task: "T1", run: "R1", name: "fixture_lead", role: "lead", brief };
  const native = actor => ({ version: "0.160.0", actor });
  const { preparedTaskMessage } = await import(pathToFileURL(join(f.plugin, "runtime/instructions.mjs")));
  const spawnInput = (name = input.name, call = "spawn-1") => {
    const prepared = core.readAdmission(options.directory).preparations.find(row => row.name === name);
    return ({ hook_event_name: "PreToolUse", session_id: session,
    turn_id: turns[0], tool_name: "collaborationspawn_agent", tool_use_id: call, tool_input: { task_name: name, fork_turns: "none", message: prepared ? preparedTaskMessage(prepared) : "unprepared task" } });
  };
  const childTranscript = ({ child = childActor, parent = session, path = "/root/fixture_lead", turn = turns[1], message } = {}) => {
    const preparation = core.readAdmission(options.directory).preparations.find(row => row.name === path.split("/").at(-1));
    const transcript = join(f.mode.sessionsDir, `${child}.jsonl`);
    writeFileSync(transcript, [
      { type: "session_meta", payload: { id: child, session_id: session, parent_thread_id: parent, agent_path: path, cli_version: "0.160.0" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: turn } },
      { type: "turn_context", payload: { turn_id: turn } },
      { type: "response_item", payload: { type: "agent_message", id: `amsg_${turn}`, author: path.slice(0, path.lastIndexOf("/")),
        recipient: path, content: [{ type: "encrypted_content", encrypted_content: message ?? preparedTaskMessage(preparation) }] } },
    ].map(row => JSON.stringify(row) + "\n").join(""));
    return transcript;
  };
  const bindLead = () => {
    api.prepareNativeTask(input, native(session), options);
    const admitted = api.reservePreparedSpawn(spawnInput(), native(session), options);
    events.publish(join(options.observationsRoot, session), { schema: 1, runtime: "0.160.0", session,
      kind: "spawn-result", actor: session, call: "spawn-1", turn: turns[0], path: "/root/fixture_lead" });
    events.publish(join(options.observationsRoot, session), { schema: 1, runtime: "0.160.0", session,
      kind: "child-start", child: childActor, parent: session, path: "/root/fixture_lead", turn: turns[1] });
    core.bindAdmission(options.directory, { ...scope, assignment: admitted.assignment.id, issuer: session,
      call: "spawn-1", child: childActor, turn: turns[1] });
  };
  const connectVisible = version => connect(t, f, version, "", "sage_prepare_task");
  return { ...f, core, events, api, options, scope, input, native, spawnInput, childTranscript, bindLead, connectVisible, assignmentTool, assignmentEnv, assignmentCli, assignmentLogbook };
}

test("visible preparation server saves the native owner's brief without dispatch or capacity", async t => {
  const f = await preparationServerFixture(t); const client = await f.connectVisible();
  const saved = await client.call(f.input);
  assert.equal(saved.decision, "prepared");
  assert.deepEqual(Object.keys(saved).sort(), ["decision", "preparation", "task", "run", "name", "role", "message", "fork_turns"].sort());
  assert.equal(saved.name, f.input.name);
  assert.equal((await client.call(f.input)).preparation, saved.preparation);
  await client.close();
  const state = f.core.readAdmission(f.options.directory);
  assert.equal(state.preparations.length, 1);
  assert.equal(state.preparations[0].issuer, session);
  assert.deepEqual(state.preparations[0].brief, f.input.brief);
  assert.deepEqual(state.reservations, []);
  assert.equal(existsSync(join(f.options.observationsRoot, session)), false);
});

test("visible preparation server refuses forged identity unsupported versions and invalid work", async t => {
  const f = await preparationServerFixture(t); const client = await f.connectVisible();
  for (const [input, actor] of [[f.input, childActor], [f.input, null], [{ ...f.input, issuer: session }, session],
    [{ ...f.input, role: "chief-of-staff" }, session], [{ ...f.input, name: "root" }, session],
    [{ ...f.input, name: "../other" }, session], [{ ...f.input, brief: { ...f.input.brief, GOAL: "" } }, session],
    [{ ...f.input, brief: { ...f.input.brief, GOAL: "x".repeat(32769) } }, session]]) {
    assert.equal(typeof (await client.call(input, actor)).error, "string");
  }
  await client.close();
  const unsupported = await f.connectVisible("old");
  assert.equal(typeof (await unsupported.call(f.input)).error, "string"); await unsupported.close();
  assert.deepEqual(f.core.readAdmission(f.options.directory).preparations, []);
});

test("visible preparation server uses a verified lead binding and rejects ambiguous native history", async t => {
  const f = await preparationServerFixture(t); f.bindLead(); const client = await f.connectVisible();
  const task = { ...f.input, name: "qa_child", run: "R2", role: "qa", reviewCycle: 1 };
  assert.equal((await client.call(task, childActor)).decision, "prepared");
  assert.equal(typeof (await client.call({ ...task, name: "nested_lead", role: "lead" }, childActor)).error, "string");
  f.events.publish(join(f.options.observationsRoot, session), { schema: 1, runtime: "0.160.0", session,
    kind: "spawn-request", actor: session, call: "reused-path", turn: turns[2], name: "fixture_lead" });
  assert.equal(typeof (await client.call({ ...task, name: "another_qa" }, childActor)).error, "string");
  await client.close();
  assert.equal(f.core.readAdmission(f.options.directory).preparations.length, 2);
});

test("native prepared spawn consumes only matching authenticated work and keeps rejected observations", async t => {
  const f = await preparationServerFixture(t); const client = await f.connectVisible();
  const saved = await client.call(f.input); await client.close();
  assert.throws(() => f.api.reservePreparedSpawn(f.spawnInput(), f.native(childActor), f.options));
  const first = f.api.reservePreparedSpawn(f.spawnInput(), f.native(session), f.options);
  assert.equal(first.decision, "permit-once");
  assert.equal(f.api.reservePreparedSpawn(f.spawnInput(), f.native(session), f.options).decision, "already-reserved");
  assert.throws(() => f.api.reservePreparedSpawn(f.spawnInput(f.input.name, "another-call"), f.native(session), f.options), /already has a dispatch/);
  assert.throws(() => f.api.reservePreparedSpawn(f.spawnInput("unprepared", "unknown"), f.native(session), f.options));
  const state = f.core.readAdmission(f.options.directory);
  assert.equal(state.reservations.length, 1); assert.equal(state.reservations[0].preparation, saved.preparation);
  assert.deepEqual(state.reservations[0].brief, f.input.brief);
  const observed = f.events.readObservations(join(f.options.observationsRoot, session));
  assert.equal(observed.length, 4);
  assert.doesNotMatch(JSON.stringify(observed), /Complete the fixture task/);
});

test("native prepared spawn refuses mode-off and changed scope and keeps the prepared work", async t => {
  const f = await preparationServerFixture(t);
  f.api.prepareNativeTask(f.input, f.native(session), f.options);
  const other = "d72422c7-509c-43aa-8c42-827c556f8a58";
  assert.throws(() => f.api.reservePreparedSpawn({ ...f.spawnInput(), session_id: other }, f.native(session), f.options));
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[1], sage: false });
  assert.throws(() => f.api.reservePreparedSpawn(f.spawnInput(), f.native(session), f.options), /mode is off/);
  const client = await f.connectVisible();
  assert.equal(typeof (await client.call({ ...f.input, name: "other" })).error, "string");
  assert.equal((await client.call(f.input)).decision, "already-prepared"); await client.close();
  assert.equal(f.core.readAdmission(f.options.directory).preparations.length, 1);
  assert.deepEqual(f.core.readAdmission(f.options.directory).reservations, []);
});

test("visible preparation server contains missing modules and unavailable storage", async t => {
  for (const failure of ["module", "journal"]) {
    const f = await preparationServerFixture(t); const client = await f.connectVisible();
    if (failure === "module") rmSync(join(f.plugin, "runtime/preparation.mjs"));
    else writeFileSync(join(f.options.directory, "00000000.json"), "private storage error");
    const output = await client.call(f.input);
    assert.deepEqual(output, { error: "Sage could not prepare this task. Check the active role, task brief, and unique agent name." });
    await client.close();
  }
  const specialist = await preparationServerFixture(t); specialist.input.role = "qa"; specialist.input.run = "R2"; specialist.input.reviewCycle = 1; specialist.bindLead();
  const client = await specialist.connectVisible();
  assert.equal(typeof (await client.call({ ...specialist.input, name: "third_layer" }, childActor)).error, "string");
  await client.close();
  assert.equal(specialist.core.readAdmission(specialist.options.directory).preparations.length, 1);
});

async function sharedConfiguration(t) {
  const f = await configured(t);
  const observationsRoot = join(f.dir, "observations"); mkdirSync(observationsRoot);
  f.mode.projectDirectory = join(f.dir, "configuration-project"); mkdirSync(f.mode.projectDirectory);
  const logbookRoot = join(f.dir, "configuration-logbook");
  const { createStateTool } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
  const tool = createStateTool({ defaultRoot: () => { throw Error("No ambient logbook"); } });
  const cli = (...args) => tool.sage([...args, "--project", f.mode.projectDirectory], { ...process.env, SAGE_HOME: logbookRoot });
  cli("init"); cli("task", "add", "--title", "Configuration fixture", "--size", "small"); cli("run", "add", "T1", "--role", "lead");
  const config = { version: 3, mode: { ...f.mode, observationsRoot, logbookRoot } };
  writeFileSync(f.configFile, JSON.stringify(config));
  const preparationEntry = join(f.dir, "preparation.mjs");
  writeFileSync(preparationEntry, `import { serveConfiguredPreparations } from './plugin/runtime/configuration.mjs'; serveConfiguredPreparations(${JSON.stringify(f.configFile)});`);
  return { ...f, config, preparationEntry, prompt: (...args) => ({ ...f.prompt(...args), cwd: f.mode.projectDirectory }) };
}

test("shared server configuration fixes the same journal project and event store for both launchers", async t => {
  const f = await sharedConfiguration(t);
  assert.deepEqual(f.readHookConfiguration(f.configFile), f.config.mode);
  assert.equal(Object.isFrozen(f.readHookConfiguration(f.configFile)), true);
  const loaded = join(f.dir, "loaded-config.json");
  writeFileSync(f.entry, "import { writeFileSync } from 'node:fs';\n" + readFileSync(f.entry, "utf8")
    .replace("async mode => {", `async mode => { writeFileSync(${JSON.stringify(loaded)}, JSON.stringify(mode));`));
  const hooks = await connect(t, f);
  assert.match((await hooks.call(f.prompt("sage mode"))).hookSpecificOutput.additionalContext, /sage_prepare_task/);
  const visible = await connect(t, { ...f, entry: f.preparationEntry }, "0.160.0", "", "sage_prepare_task");
  // Both connections retain their startup values after the file changes.
  writeFileSync(f.configFile, "invalid");
  const core = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
  const brief = Object.fromEntries(core.BRIEF_FIELDS.map(field => [field, "Fixed fixture value."]));
  const prepared = await visible.call({ task: "T1", run: "R1", name: "lead_1", role: "lead", brief });
  assert.equal(prepared.decision, "prepared");
  const state = core.readAdmission(f.mode.directory);
  assert.equal(state.preparations.length, 1);
  assert.equal(state.preparations[0].project, f.mode.project);
  assert.equal(state.reservations.length, 0);
  assert.deepEqual(readdirSync(f.config.mode.observationsRoot), []);
  assert.equal((await hooks.call(patch())).hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(JSON.parse(readFileSync(loaded, "utf8")), f.config.mode);
  await visible.close(); await hooks.close();
});

test("shared server configuration rejects missing linked or unknown observation settings", async t => {
  const f = await sharedConfiguration(t);
  const root = f.config.mode.observationsRoot;
  const linked = join(f.dir, "linked-observations"); symlinkSync(root, linked, "dir");
  const missing = join(f.dir, "missing-observations");
  for (const config of [{ ...f.config, version: 2 },
    { version: 1, mode: f.config.mode }, { version: 2, mode: f.mode },
    ...[linked, missing, f.configFile, "relative", f.mode.directory, f.dir].map(observationsRoot => ({ ...f.config, mode: { ...f.config.mode, observationsRoot } }))]) {
    writeFileSync(f.configFile, JSON.stringify(config));
    assert.throws(() => f.readHookConfiguration(f.configFile), configDenied);
  }
  assert.equal(existsSync(missing), false);
});

test("shared server configuration leaves invalid preparation connections unavailable until restart", async t => {
  const f = await sharedConfiguration(t);
  assert.equal(typeof f.serveConfiguredPreparations, "function");
  const core = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
  const hooks = await connect(t, f);
  await hooks.call(f.prompt("sage mode")); await hooks.close();
  const input = { task: "T1", run: "R1", name: "lead_1", role: "lead",
    brief: Object.fromEntries(core.BRIEF_FIELDS.map(field => [field, "Fixed fixture value."])) };
  writeFileSync(f.configFile, JSON.stringify({ version: 1, mode: f.mode }));
  const visible = await connect(t, { ...f, entry: f.preparationEntry }, "0.160.0", "Sage native hook configuration is unavailable.\n", "sage_prepare_task");
  assert.match((await visible.call(input)).error, /could not prepare/);
  writeFileSync(f.configFile, JSON.stringify(f.config));
  assert.match((await visible.call(input)).error, /could not prepare/);
  assert.equal(core.readAdmission(f.mode.directory).preparations.length, 0);
  await visible.close();
  const repaired = await connect(t, { ...f, entry: f.preparationEntry }, "0.160.0", "", "sage_prepare_task");
  assert.equal((await repaired.call(input)).decision, "prepared");
  await repaired.close();
});

async function composedPolicyFixture(t) {
  const f = await preparationServerFixture(t);
  const module = join(f.plugin, "runtime/policy.mjs");
  assert.ok(existsSync(module), "the composed native policy must ship");
  const { createNativePolicy } = await import(pathToFileURL(module));
  const { nativeToolEvent } = await import(pathToFileURL(join(f.plugin, "runtime/native-tool.mjs")));
  const evaluate = (policy, input = f.spawnInput(), actor = session) => policy.evaluate(nativeToolEvent(input, f.native(actor), "PreToolUse"), f.native(actor));
  const identity = { session, child: childActor, parent: session, path: "/root/fixture_lead", turn: turns[1] };
  const result = { schema: 1, runtime: "0.160.0", session, kind: "spawn-result", actor: session, call: "spawn-1", turn: turns[0], path: identity.path };
  return { ...f, createNativePolicy, evaluate, identity, result };
}

test("composed native policy connects configured preparation spawn and nested child instructions", async t => {
  const f = await composedPolicyFixture(t);
  mkdirSync(f.options.observationsRoot, { recursive: true });
  const config = join(f.dir, "policy.json");
  writeFileSync(config, JSON.stringify({ version: 3, mode: f.options }));
  const hiddenEntry = join(f.dir, "hidden.mjs");
  writeFileSync(hiddenEntry, `import { serveConfiguredHooks } from './plugin/runtime/configuration.mjs';
    import { createNativePolicy } from './plugin/runtime/policy.mjs';
    serveConfiguredHooks(${JSON.stringify(config)}, options => createNativePolicy(options, (input, context) =>
      input.tool_name === 'apply_patch' && context.sage && context.actor === input.session_id
        ? { decision: 'deny', reason: 'The fixture chief cannot edit.' } : { decision: 'pass' }));`);
  writeFileSync(f.entry, `import { serveConfiguredPreparations } from './plugin/runtime/configuration.mjs'; serveConfiguredPreparations(${JSON.stringify(config)});`);
  const visible = await f.connectVisible();
  const hooks = await connect(t, { ...f, entry: hiddenEntry });
  const qa = "a22422c7-509c-43aa-8c42-827c556f8a59";
  const start = (child, parent, path, turn) => {
    const transcript = f.childTranscript({ child, parent, path, turn });
    return { hook_event_name: "SubagentStart", session_id: session, agent_id: child, turn_id: turn, transcript_path: transcript };
  };
  for (const [request, actor, child, path, turn] of [
    [f.input, session, childActor, "/root/fixture_lead", turns[1]],
    [{ ...f.input, name: "qa_child", run: "R2", role: "qa", reviewCycle: 1 }, childActor, qa, "/root/fixture_lead/qa_child", turns[2]],
  ]) {
    assert.equal((await visible.call(request, actor)).decision, "prepared");
    const spawn = f.spawnInput(request.name, request.name);
    if (actor !== session) { spawn.turn_id = turns[1]; spawn.transcript_path = join(f.mode.sessionsDir, `${actor}.jsonl`); }
    assert.deepEqual(await hooks.call(spawn, actor), {});
    assert.equal((await hooks.call(spawn, actor)).hookSpecificOutput.permissionDecision, "deny");
    assert.deepEqual(await hooks.call({ ...spawn, hook_event_name: "PostToolUse", tool_response: { task_name: path } }, actor), {});
    const delivered = await hooks.call(start(child, actor, path, turn), child);
    assert.match(delivered.hookSpecificOutput.additionalContext, new RegExp(`Role: ${request.role}`));
    assert.match(delivered.hookSpecificOutput.additionalContext, /# Task brief/);
    assert.match(delivered.hookSpecificOutput.additionalContext, /Complete the fixture task/);
  }
  assert.equal((await hooks.call(patch())).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 2);
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 2);
  assert.equal(f.events.readObservations(join(f.options.observationsRoot, session)).length, 7);
  await visible.close(); await hooks.close();
});

test("composed native policy captures inactive and denied attempts without consuming capacity", async t => {
  const f = await composedPolicyFixture(t);
  f.api.prepareNativeTask(f.input, f.native(session), f.options);
  const denied = f.createNativePolicy(f.options, () => ({ decision: "deny", reason: "Fixture denial." }));
  assert.deepEqual(await f.evaluate(denied), { decision: "deny", reason: "Fixture denial." });
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 0);
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[1], sage: false });
  const policy = f.createNativePolicy(f.options, () => ({ decision: "pass" }));
  assert.deepEqual(await f.evaluate(policy, f.spawnInput("inactive", "off-call")), { decision: "pass" });
  assert.deepEqual(policy.startChild(f.identity), { decision: "pass" });
  assert.deepEqual(policy.recordDispatchResult(f.result), { decision: "recorded" });
  assert.deepEqual(f.events.readObservations(join(f.options.observationsRoot, session)).map(row => row.kind).sort(),
    ["child-start", "spawn-request", "spawn-request", "spawn-result"]);
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 0);
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 0);
});

test("composed native policy requires exact tool decisions and authenticated derived actors", async t => {
  const f = await composedPolicyFixture(t);
  assert.throws(() => f.createNativePolicy(f.options));
  f.api.prepareNativeTask(f.input, f.native(session), f.options);
  for (const value of [Object.assign(Object.create({ decision: "pass" }), { unrelated: true }), undefined, {}, { decision: "allow" }, { decision: "pass", extra: true }, { decision: "deny", reason: "" }]) {
    const policy = f.createNativePolicy(f.options, () => value);
    await assert.rejects(f.evaluate(policy));
  }
  const policy = f.createNativePolicy(f.options, () => { throw Error("private detail"); });
  await assert.rejects(f.evaluate(policy));
  const passing = f.createNativePolicy(f.options, () => ({ decision: "pass" }));
  await assert.rejects(passing.evaluate({ ...f.spawnInput(), agent_id: childActor }, f.native(session)));
  await assert.rejects(passing.evaluate(f.spawnInput(), f.native(childActor)));
  await assert.rejects(passing.evaluate(f.spawnInput(), { ...f.native(session), version: "unsupported" }));
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 0);
});

test("composed native policy keeps the admitted input private and refuses a changed mode", async t => {
  const f = await composedPolicyFixture(t);
  f.api.prepareNativeTask(f.input, f.native(session), f.options);
  const options = { ...f.options };
  const policy = f.createNativePolicy(options, input => {
    input.tool_input.task_name = "mutated";
    return { decision: "pass" };
  });
  options.directory = "not-the-journal";
  assert.deepEqual(await f.evaluate(policy), { decision: "pass" });
  assert.equal(f.core.readAdmission(f.options.directory).reservations[0].dispatch.name, f.input.name);
  assert.equal((await f.evaluate(policy)).decision, "deny");
  const changed = f.createNativePolicy(f.options, () => {
    f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[1], sage: false });
    return { decision: "pass" };
  });
  await assert.rejects(f.evaluate(changed, f.spawnInput("next", "next-call")));
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 1);
});

test("composed native policy holds incomplete child evidence until the matching result is recorded", async t => {
  const f = await composedPolicyFixture(t);
  f.api.prepareNativeTask(f.input, f.native(session), f.options);
  const policy = f.createNativePolicy(f.options, () => ({ decision: "pass" }));
  await f.evaluate(policy);
  assert.throws(() => policy.startChild(f.identity));
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 1);
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 0);
  assert.throws(() => policy.recordDispatchResult({ ...f.result, kind: "spawn-request", name: "invalid" }));
  policy.recordDispatchResult(f.result);
  assert.equal(policy.startChild(f.identity).decision, "deliver");
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 1);
  // A new call reusing the path makes further delivery ambiguous, even though it was denied.
  const denied = f.createNativePolicy(f.options, () => ({ decision: "deny", reason: "Fixture denial." }));
  await f.evaluate(denied, f.spawnInput(f.input.name, "reused-call"));
  assert.throws(() => policy.startChild(f.identity));
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 1);
});

test('native admission saves the exact task hash and refuses missing task content', async t => {
  const { createHash } = await import('node:crypto');
  const f = await preparationServerFixture(t);
  f.api.prepareNativeTask(f.input, f.native(session), f.options);
  const input = f.spawnInput();
  f.api.reservePreparedSpawn(input, f.native(session), f.options);
  const saved = f.core.readAdmission(f.options.directory).reservations[0];
  assert.equal(saved.dispatch.taskHash, createHash('sha256').update(input.tool_input.message).digest('hex'));
  input.tool_input.message = 'changed task';
  assert.throws(() => f.api.reservePreparedSpawn(input, f.native(session), f.options), /could not verify/);
  const other = await preparationServerFixture(t);
  other.api.prepareNativeTask(other.input, other.native(session), other.options);
  for (const message of [undefined, null, 1, '', 'x'.repeat(1024 * 1024 + 1)]) {
    const invalid = other.spawnInput(); invalid.tool_input.message = message;
    assert.throws(() => other.api.reservePreparedSpawn(invalid, other.native(session), other.options));
  }
  assert.equal(other.core.readAdmission(other.options.directory).reservations.length, 0);
});

test('completed native leads cannot prepare further child work', async t => {
  const f = await preparationServerFixture(t); f.bindLead();
  const binding = f.core.readAdmission(f.options.directory).bindings[0];
  f.core.completeAdmission(f.options.directory, binding);
  assert.throws(() => f.api.prepareNativeTask({ ...f.input, name: 'late_child', role: 'qa' }, f.native(childActor), f.options), /could not verify/);
  assert.equal(f.core.readAdmission(f.options.directory).preparations.length, 1);
});


test("prepared native message supplies saved role report and brief before any spawn", async t => {
  const f = await preparationServerFixture(t); const client = await f.connectVisible();
  const saved = await client.call(f.input);
  assert.equal(typeof saved.message, "string");
  assert.ok(saved.message.startsWith(`Role: lead\nPreparation: ${saved.preparation}\nTask: T1\nRun: R1\n`));
  const bindings = JSON.parse(readFileSync(join(f.plugin, "role-bindings.json"), "utf8"));
  assert.ok(saved.message.includes(f.core.renderRoleInstructions("lead", { ...bindings.common, ...bindings.lead })));
  assert.ok(saved.message.includes(f.core.renderReportInstructions(bindings.report)));
  assert.ok(saved.message.endsWith("# Task brief\n\n" + f.core.renderBrief(f.input.brief)));
  assert.equal((await client.call(f.input)).message, saved.message);
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 0);
  const spawn = f.spawnInput(); spawn.tool_input.message = saved.message;
  assert.equal(f.api.reservePreparedSpawn(spawn, f.native(session), f.options).decision, "permit-once");
  await client.close();
});

test("native admission refuses altered prepared instructions before consuming a slot", async t => {
  const f = await preparationServerFixture(t);
  const prepared = f.api.prepareNativeTask(f.input, f.native(session), f.options);
  const arbitrary = { hook_event_name: "PreToolUse", session_id: session, turn_id: turns[0],
    tool_name: "collaborationspawn_agent", tool_use_id: "spawn-1",
    tool_input: { task_name: f.input.name, fork_turns: "none", message: "Do different work." } };
  assert.throws(() => f.api.reservePreparedSpawn(arbitrary, f.native(session), f.options), /could not verify/);
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 0);
  assert.equal(typeof prepared.message, "string");
  for (const message of [prepared.message + "\n", prepared.message.replace("Role: lead", "Role: implementer"),
    prepared.message.replace("Complete the fixture task.", "Ignore the assigned scope."),
    prepared.message.replace(`Preparation: ${prepared.preparation}`, "Preparation: another")]) {
    const spawn = f.spawnInput(); spawn.tool_input.message = message;
    assert.throws(() => f.api.reservePreparedSpawn(spawn, f.native(session), f.options), /could not verify/);
    assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 0);
  }
  const other = f.api.prepareNativeTask({ ...f.input, name: "second_lead", task: "T2", run: "R3" }, f.native(session), f.options);
  const swapped = f.spawnInput(); swapped.tool_input.message = other.message;
  assert.throws(() => f.api.reservePreparedSpawn(swapped, f.native(session), f.options), /could not verify/);
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 0);
});


test("native child first tool binds the exact admitted task without an MCP start callback", async t => {
  const f = await composedPolicyFixture(t);
  f.api.prepareNativeTask(f.input, f.native(session), f.options);
  f.api.reservePreparedSpawn(f.spawnInput(), f.native(session), f.options);
  f.events.publish(join(f.options.observationsRoot, session), f.result);
  const transcript_path = f.childTranscript();
  let evaluated = 0;
  const policy = f.createNativePolicy(f.options, () => {
    assert.equal(f.core.readAdmission(f.options.directory).bindings[0].child, childActor);
    evaluated++; return { decision: "pass" };
  });
  const input = { ...patch(turns[1]), tool_name: "list_mcp_resources", tool_input: {}, transcript_path };
  assert.deepEqual(await f.evaluate(policy, input, childActor), { decision: "pass" });
  assert.deepEqual(await f.evaluate(policy, input, childActor), { decision: "pass" });
  assert.equal(evaluated, 2);
  const state = f.core.readAdmission(f.options.directory);
  assert.equal(state.bindings.length, 1);
  const paths = f.events.readObservations(join(f.options.observationsRoot, session)).filter(row => row.kind === "child-transcript");
  assert.deepEqual(paths.map(row => [row.child, row.turn, row.transcript]), [[childActor, turns[1], transcript_path]]);
  f.core.completeAdmission(f.options.directory, state.bindings[0]);
  await assert.rejects(f.evaluate(policy, input, childActor));
  assert.equal(evaluated, 2);
});

test("native child tools refuse missing dispatch results changed tasks and foreign turns before policy", async t => {
  const f = await composedPolicyFixture(t);
  f.api.prepareNativeTask(f.input, f.native(session), f.options);
  f.api.reservePreparedSpawn(f.spawnInput(), f.native(session), f.options);
  let evaluated = 0;
  const policy = f.createNativePolicy(f.options, () => { evaluated++; return { decision: "pass" }; });
  const transcript_path = f.childTranscript();
  const input = { ...patch(turns[1]), transcript_path };
  await assert.rejects(f.evaluate(policy, input, childActor));
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 0);
  f.events.publish(join(f.options.observationsRoot, session), f.result);
  await assert.rejects(f.evaluate(policy, { ...input, turn_id: turns[2] }, childActor));
  await assert.rejects(f.evaluate(policy, patch(turns[1]), childActor));
  f.childTranscript({ message: "Changed task" });
  await assert.rejects(f.evaluate(policy, input, childActor));
  assert.equal(evaluated, 0);
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 0);
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 1);
});


test("prepared native spawn requires a fresh context before reserving capacity", async t => {
  const f = await preparationServerFixture(t);
  const prepared = f.api.prepareNativeTask(f.input, f.native(session), f.options);
  assert.equal(prepared.fork_turns, "none");
  for (const fork_turns of [undefined, null, "all", "1", 0, "NONE"]) {
    const input = f.spawnInput(); input.tool_input.fork_turns = fork_turns;
    assert.throws(() => f.api.reservePreparedSpawn(input, f.native(session), f.options), /could not verify/);
  }
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 0);
  assert.equal(f.api.reservePreparedSpawn(f.spawnInput(), f.native(session), f.options).decision, "permit-once");
});

test("configured MCP child tools bind without any SubagentStart call", async t => {
  const f = await preparationServerFixture(t);
  f.api.prepareNativeTask(f.input, f.native(session), f.options);
  writeFileSync(f.entry, `import { serveHooks } from './plugin/runtime/mcp-server.mjs';
    import { createNativePolicy } from './plugin/runtime/policy.mjs';
    const options = ${JSON.stringify(f.options)};
    serveHooks({ mode: ${JSON.stringify(f.mode)}, loadPolicy: async () => createNativePolicy(options, () => ({decision: 'pass'})) });`);
  const client = await connect(t, f);
  const spawn = f.spawnInput();
  assert.deepEqual(await client.call(spawn), {});
  assert.deepEqual(await client.call({ ...spawn, hook_event_name: "PostToolUse", tool_response: { task_name: "/root/fixture_lead" } }), {});
  const transcript_path = f.childTranscript();
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 0);
  assert.deepEqual(await client.call({ ...patch(turns[1]), tool_name: "list_mcp_resources", tool_input: {}, transcript_path }, childActor), {});
  assert.equal(f.core.readAdmission(f.options.directory).bindings[0].child, childActor);
  const refused = await client.call({ ...patch(turns[2]), tool_name: "list_mcp_resources", tool_input: {}, transcript_path }, childActor);
  assert.equal(refused.hookSpecificOutput.permissionDecision, "deny");
  await client.close();
});


async function completionFixture(t) {
  const f = await composedPolicyFixture(t);
  f.api.prepareNativeTask(f.input, f.native(session), f.options);
  f.api.reservePreparedSpawn(f.spawnInput(), f.native(session), f.options);
  f.events.publish(join(f.options.observationsRoot, session), f.result);
  const transcript_path = f.childTranscript();
  const policy = f.createNativePolicy(f.options, () => ({ decision: "pass" }));
  await f.evaluate(policy, { ...patch(turns[1]), transcript_path }, childActor);
  const stop = { hook_event_name: "SubagentStop", session_id: session, agent_id: childActor,
    turn_id: turns[1], transcript_path: join(f.mode.sessionsDir, "root.jsonl") };
  return { ...f, policy, stop };
}

test("native completion uses the saved child transcript and releases once even after Sage off", async t => {
  const f = await completionFixture(t);
  appendReport(f);
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  assert.deepEqual(f.policy.completeChild(f.stop, f.native(childActor)), { decision: "completed" });
  assert.deepEqual(f.policy.completeChild(f.stop, f.native(childActor)), { decision: "already-completed" });
  const state = f.core.readAdmission(f.options.directory);
  assert.equal(state.completions.length, 1);
  assert.deepEqual(state.completions[0], state.bindings[0]);
  assert.equal(state.reservations.length, 1);
  assert.equal(f.events.readObservations(join(f.options.observationsRoot, session)).filter(row => row.kind === "child-stop").length, 1);
});

test("native completion refuses forged stale unbound and changed assignment evidence", async t => {
  const f = await completionFixture(t);
  for (const input of [{ ...f.stop, agent_id: session }, { ...f.stop, turn_id: turns[2] },
    { ...f.stop, session_id: childActor }, { ...f.stop, role: "lead" }, { ...f.stop, transcript_path: null }]) {
    assert.throws(() => f.policy.completeChild(input, f.native(childActor)));
  }
  assert.throws(() => f.policy.completeChild(f.stop, f.native(session)));
  assert.throws(() => f.policy.completeChild(f.stop, { version: "unsupported", actor: childActor }));
  f.childTranscript({ message: "Changed assignment" });
  assert.throws(() => f.policy.completeChild(f.stop, f.native(childActor)));
  assert.equal((f.core.readAdmission(f.options.directory).completions ?? []).length, 0);
  assert.equal(f.events.readObservations(join(f.options.observationsRoot, session)).filter(row => row.kind === "child-stop").length, 0);
  f.childTranscript();
  appendReport(f);
  assert.deepEqual(f.policy.completeChild(f.stop, f.native(childActor)), { decision: "completed" });
  const unbound = await composedPolicyFixture(t);
  unbound.api.prepareNativeTask(unbound.input, unbound.native(session), unbound.options);
  unbound.api.reservePreparedSpawn(unbound.spawnInput(), unbound.native(session), unbound.options);
  const policy = unbound.createNativePolicy(unbound.options, () => ({ decision: "pass" }));
  assert.throws(() => policy.completeChild(f.stop, unbound.native(childActor)));
  assert.equal((unbound.core.readAdmission(unbound.options.directory).completions ?? []).length, 0);
});

test("packaged MCP stop accepts exact completion and contains invalid stop requests", async t => {
  const f = await completionFixture(t);
  appendReport(f);
  writeFileSync(f.entry, `import { serveHooks } from './plugin/runtime/mcp-server.mjs';
    import { createNativePolicy } from './plugin/runtime/policy.mjs';
    const options = ${JSON.stringify(f.options)};
    serveHooks({ mode: ${JSON.stringify(f.mode)}, loadPolicy: async () => createNativePolicy(options, () => ({decision: 'pass'})) });`);
  const client = await connect(t, f);
  assert.equal((await client.call({ ...f.stop, stop_hook_active: false, last_assistant_message: reportText, turn_id: turns[2] }, childActor)).decision, "block");
  assert.equal((f.core.readAdmission(f.options.directory).completions ?? []).length, 0);
  assert.deepEqual(await client.call({ ...f.stop, stop_hook_active: false, last_assistant_message: reportText }, childActor), {});
  assert.deepEqual(await client.call({ ...f.stop, stop_hook_active: false, last_assistant_message: reportText }, childActor), {});
  assert.equal(f.core.readAdmission(f.options.directory).completions.length, 1);
  await client.close();
});


const reportText = ["STATUS done", "RESULT PASS", "EVIDENCE fixed fixture: 1 passed", "FINDINGS none", "QUESTIONS none", "NOT VERIFIED real model", "BRANCH none"].join("\n");
function appendReport(f, text = reportText, child = childActor, turn = turns[1]) {
  const transcript = join(f.mode.sessionsDir, `${child}.jsonl`);
  appendFileSync(transcript, [
    { type: "response_item", payload: { type: "message", id: "fixture_report", role: "assistant",
      content: [{ type: "output_text", text }], internal_chat_message_metadata_passthrough: { turn_id: turn } },
      metadata: { client_authored: false, retained_source: { complete: true,
        id: { role: "assistant", turn_id: turn, message_id: "fixture_report" } } } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: turn, last_agent_message: text } },
  ].map(row => JSON.stringify(row) + "\n").join(""));
}

test("native blocked stop retains capacity until the transcript confirms completion", async t => {
  const f = await completionFixture(t);
  const { reconcileNativeCompletions } = await import(pathToFileURL(join(f.plugin, "runtime/child-stop.mjs")));
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual(f.policy.completeChild(f.stop, f.native(childActor)), { decision: "stop-observed" });
    assert.deepEqual(reconcileNativeCompletions(f.native(session), session, f.options), { decision: "reconciled" });
    assert.equal((f.core.readAdmission(f.options.directory).completions ?? []).length, 0);
  }
  appendReport(f);
  // A child cannot release its own slot through the parent's reconciliation route.
  reconcileNativeCompletions(f.native(childActor), session, f.options);
  assert.equal((f.core.readAdmission(f.options.directory).completions ?? []).length, 0);
  reconcileNativeCompletions(f.native(session), session, f.options);
  reconcileNativeCompletions(f.native(session), session, f.options);
  assert.equal(f.core.readAdmission(f.options.directory).completions.length, 1);
});

test("native status hooks require terminal evidence instead of a reported done status", async t => {
  const f = await completionFixture(t);
  const { postToolOutput } = await import(pathToFileURL(join(f.plugin, "runtime/post-tool.mjs")));
  assert.deepEqual(f.policy.completeChild(f.stop, f.native(childActor)), { decision: "stop-observed" });
  appendReport(f);
  const transcript = join(f.mode.sessionsDir, `${childActor}.jsonl`);
  const complete = readFileSync(transcript, "utf8");
  writeFileSync(transcript, complete.trimEnd().split("\n").slice(0, -1).join("\n") + "\n");
  const input = { ...postSpawn(), tool_name: "collaborationlist_agents", tool_input: {},
    tool_response: JSON.stringify({ status: "completed" }) };
  assert.deepEqual(await postToolOutput(input, f.native(session), async () => f.policy), {});
  assert.equal((f.core.readAdmission(f.options.directory).completions ?? []).length, 0);
  writeFileSync(transcript, complete);
  assert.deepEqual(await postToolOutput({ ...input, tool_name: "collaborationwait_agent" }, f.native(session), async () => f.policy), {});
  assert.equal(f.core.readAdmission(f.options.directory).completions.length, 1);
});

test("native report read reconciles a stopped child only after terminal evidence", async t => {
  const f = await completionFixture(t);
  const { readChildReport } = await import(pathToFileURL(join(f.plugin, "runtime/report-intake.mjs")));
  assert.deepEqual(f.policy.completeChild(f.stop, f.native(childActor)), { decision: "stop-observed" });
  assert.throws(() => readChildReport({ name: f.input.name }, f.native(session), f.options));
  assert.equal((f.core.readAdmission(f.options.directory).completions ?? []).length, 0);
  appendReport(f);
  const report = readChildReport({ name: f.input.name }, f.native(session), f.options);
  assert.equal(report.decision, "report-ready");
  assert.equal(report.report.STATUS, "done");
  assert.equal(f.core.readAdmission(f.options.directory).completions.length, 1);
});

test("native parent reads its completed child's validated report without changing task or admission state", async t => {
  const f = await completionFixture(t);
  const { readChildReport } = await import(pathToFileURL(join(f.plugin, "runtime/report-intake.mjs")));
  assert.equal(typeof readChildReport, "function");
  assert.throws(() => readChildReport({ name: f.input.name }, f.native(session), f.options));
  appendReport(f);
  f.policy.completeChild(f.stop, f.native(childActor));
  const before = f.core.readAdmission(f.options.directory);
  const read = readChildReport({ name: f.input.name }, f.native(session), f.options);
  assert.equal(read.decision, "report-ready"); assert.equal(read.report.STATUS, "done");
  assert.equal(read.task, "T1"); assert.equal(read.run, "R1"); assert.equal(read.child, childActor);
  assert.equal(read.assignment, before.bindings[0].assignment);
  for (const actor of [childActor, "a22422c7-509c-43aa-8c42-827c556f8a59"]) {
    assert.throws(() => readChildReport({ name: f.input.name }, f.native(actor), f.options));
  }
  for (const input of [{ name: "another" }, { name: f.input.name, text: reportText }, { name: f.input.name, assignment: read.assignment }]) {
    assert.throws(() => readChildReport(input, f.native(session), f.options));
  }
  assert.deepEqual(f.core.readAdmission(f.options.directory), before);
});

test("packaged report tool refuses forged callers and incomplete reports before returning a verified report", async t => {
  const f = await completionFixture(t);
  f.policy.completeChild(f.stop, f.native(childActor));
  writeFileSync(f.entry, `import { servePreparations } from './plugin/runtime/preparation-server.mjs'; servePreparations(${JSON.stringify(f.options)});`);
  const client = await connect(t, f, "0.160.0", "", "sage_read_report");
  const input = { name: f.input.name };
  assert.match((await client.call(input)).error, /could not read this report/);
  appendReport(f, "STATUS done");
  assert.match((await client.call(input)).error, /could not read this report/);
  f.childTranscript(); appendReport(f);
  assert.match((await client.call(input, childActor)).error, /could not read this report/);
  assert.equal((await client.call(input)).report.RESULT, "PASS");
  await client.close();
  const unsupported = await connect(t, f, "unsupported", "", "sage_read_report");
  assert.match((await unsupported.call(input)).error, /could not read this report/);
  await unsupported.close();
});


test("native durable reports pin the read hash and retain evidence after transcript removal", async t => {
  const f = await completionFixture(t);
  const api = await import(pathToFileURL(join(f.plugin,"runtime/report-intake.mjs")));
  assert.equal(typeof api.recordChildReport,"function");
  appendReport(f);f.policy.completeChild(f.stop,f.native(childActor));
  const initial=api.readChildReport({name:f.input.name},f.native(session),f.options);
  const input={name:f.input.name,reportHash:initial.reportHash};
  assert.throws(()=>api.recordChildReport(input,f.native(childActor),f.options));
  assert.throws(()=>api.recordChildReport({...input,reportHash:"a".repeat(64)},f.native(session),f.options));
  f.childTranscript();appendReport(f,reportText.replace("RESULT PASS","RESULT FAIL"));
  assert.throws(()=>api.recordChildReport(input,f.native(session),f.options));
  assert.equal(f.core.readAdmission(f.options.directory).reports?.length??0,0);
  f.childTranscript();appendReport(f);
  assert.equal(api.recordChildReport(input,f.native(session),f.options).decision,"report-recorded");
  rmSync(join(f.mode.sessionsDir,`${childActor}.jsonl`));
  assert.deepEqual(api.readChildReport({name:f.input.name},f.native(session),f.options),initial);
  assert.equal(api.recordChildReport(input,f.native(session),f.options).decision,"already-recorded");
  assert.throws(()=>api.readChildReport({name:f.input.name},f.native(childActor),f.options));
  const saved=f.core.readAdmission(f.options.directory).reports;
  assert.equal(saved.length,1);assert.equal(saved[0].text,reportText);assert.equal(saved[0].reportHash,initial.reportHash);
});

test("packaged report receipt survives reconnect and refuses another actor without duplicate writes", async t => {
  const f=await completionFixture(t);appendReport(f);f.policy.completeChild(f.stop,f.native(childActor));
  const {readChildReport}=await import(pathToFileURL(join(f.plugin,"runtime/report-intake.mjs")));
  const report=readChildReport({name:f.input.name},f.native(session),f.options);
  writeFileSync(f.entry,`import {servePreparations} from './plugin/runtime/preparation-server.mjs';servePreparations(${JSON.stringify(f.options)});`);
  const input={name:f.input.name,reportHash:report.reportHash};
  const client=await connect(t,f,"0.160.0","","sage_record_report");
  assert.match((await client.call(input,childActor)).error,/could not record this report/);
  assert.equal((await client.call(input)).decision,"report-recorded");await client.close();
  rmSync(join(f.mode.sessionsDir,`${childActor}.jsonl`));
  const retry=await connect(t,f,"0.160.0","","sage_record_report");
  assert.equal((await retry.call(input)).decision,"already-recorded");await retry.close();
  const reader=await connect(t,f,"0.160.0","","sage_read_report");
  assert.deepEqual(await reader.call({name:f.input.name}),report);await reader.close();
  assert.equal(f.core.readAdmission(f.options.directory).reports.length,1);
});

async function runReportFixture(t) {
  const f = await completionFixture(t);
  const projectDirectory = join(f.dir, "project"); mkdirSync(projectDirectory);
  const logbookRoot = join(f.dir, "logbook");
  const options = { ...f.options, projectDirectory, logbookRoot };
  const tool = f.core.createStateTool({ defaultRoot: () => { throw Error("No ambient logbook"); } });
  const env = { ...process.env, SAGE_HOME: logbookRoot };
  const cli = (...args) => tool.sage([...args, "--project", projectDirectory], env);
  cli("init"); cli("task", "add", "--title", "Native report fixture", "--size", "small");
  cli("run", "add", "T1", "--role", "lead");
  appendReport(f); f.policy.completeChild(f.stop, f.native(childActor));
  const reports = await import(pathToFileURL(join(f.plugin, "runtime/report-intake.mjs")));
  const runtime = await import(pathToFileURL(join(f.plugin, "runtime/run-report.mjs")));
  const receipt = reports.readChildReport({ name: f.input.name }, f.native(session), options);
  const record = () => reports.recordChildReport({ name: f.input.name, reportHash: receipt.reportHash }, f.native(session), options);
  const input = { assignment: receipt.assignment, reportHash: receipt.reportHash };
  const logbook = tool.storeDir(projectDirectory, env);
  const finish = (request = input, actor = session, fixed = options) => runtime.finishRecordedRun(request, f.native(actor), fixed);
  return { ...f, options, tool, env, cli, record, logbook, finish, finishInput: input };
}

test("native recorded run requires a saved receipt and only finishes its assigned logbook run", async t => {
  const f = await runReportFixture(t);
  assert.throws(() => f.finish());
  f.record();
  const journal = f.core.readAdmission(f.options.directory);
  const tables = () => Object.fromEntries(["tasks", "ledger", "findings", "gates", "decisions"].map(name =>
    [name, readFileSync(join(f.logbook, `${name}.tsv`), "utf8")]));
  const before = tables();
  const first = f.finish();
  assert.equal(first.decision, "run-finished");
  assert.equal(first.status, "done");
  assert.equal(readFileSync(join(f.logbook, first.report), "utf8"), reportText);
  assert.deepEqual(f.finish(), { ...first, decision: "already-finished" });
  assert.deepEqual(tables(), before);
  assert.deepEqual(f.core.readAdmission(f.options.directory), journal);
});

test("native recorded run rejects foreign agents forged paths hashes scopes and unsupported clients", async t => {
  const f = await runReportFixture(t); f.record();
  const bytes = readFileSync(join(f.logbook, "runs.tsv"), "utf8");
  for (const actor of [childActor, "a22422c7-509c-43aa-8c42-827c556f8a59"]) assert.throws(() => f.finish(f.finishInput, actor));
  for (const change of [{ reportHash: "f".repeat(64) }, { assignment: turns[0] }, { text: reportText }, { logbookRoot: f.dir }]) {
    assert.throws(() => f.finish({ ...f.finishInput, ...change }));
  }
  for (const change of [{ project: "foreign" }, { logbookRoot: undefined }, { logbookRoot: f.options.projectDirectory }]) {
    assert.throws(() => f.finish(f.finishInput, session, { ...f.options, ...change }));
  }
  const { finishRecordedRun } = await import(pathToFileURL(join(f.plugin, "runtime/run-report.mjs")));
  assert.throws(() => finishRecordedRun(f.finishInput, { version: "unsupported", actor: session }, f.options));
  assert.equal(readFileSync(join(f.logbook, "runs.tsv"), "utf8"), bytes);
  assert.equal(f.core.readAdmission(f.options.directory).reports.length, 1);
});

test("native recorded run finishes preserved work after off and transcript loss without changing mode", async t => {
  const f = await runReportFixture(t); f.record();
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  rmSync(join(f.mode.sessionsDir, `${childActor}.jsonl`));
  const before = f.core.readAdmission(f.options.directory);
  assert.equal(f.finish().decision, "run-finished");
  assert.deepEqual(f.core.readAdmission(f.options.directory), before);
});

test("native logbook configuration fixes an external location and refuses redirects or unknown versions", async t => {
  const f = await runReportFixture(t);
  const { readHookConfiguration } = await import(pathToFileURL(join(f.plugin, "runtime/configuration.mjs")));
  const file = join(f.dir, "native-run.json");
  const config = { version: 3, mode: f.options };
  writeFileSync(file, JSON.stringify(config));
  assert.deepEqual(readHookConfiguration(file), f.options);
  const alias = join(f.dir, "logbook-link"); symlinkSync(f.options.logbookRoot, alias);
  for (const bad of [{ ...config, version: 4 }, { ...config, version: 2 },
    { ...config, mode: { ...f.options, logbookRoot: undefined } },
    ...[alias, f.options.projectDirectory, f.options.directory, f.options.observationsRoot, f.options.sessionsDir, join(f.options.projectDirectory, "..")].map(logbookRoot =>
      ({ ...config, mode: { ...f.options, logbookRoot } }))]) {
    writeFileSync(file, JSON.stringify(bad));
    assert.throws(() => readHookConfiguration(file), configDenied);
  }
});

test("packaged chief run tool uses fixed configuration rejects children and survives reconnect", async t => {
  const f = await runReportFixture(t); f.record();
  const file = join(f.dir, "run-config.json");
  writeFileSync(file, JSON.stringify({ version: 3, mode: f.options }));
  writeFileSync(f.entry, `import { serveConfiguredPreparations } from './plugin/runtime/configuration.mjs'; serveConfiguredPreparations(${JSON.stringify(file)});`);
  const client = await connect(t, f, "0.160.0", "", "sage_finish_run");
  assert.match((await client.call(f.finishInput, childActor)).error, /could not finish/);
  assert.equal(f.tool.read(f.logbook, "runs")[0].status, "running");
  const first = await client.call(f.finishInput);
  assert.equal(first.decision, "run-finished");
  await client.close();
  const retry = await connect(t, f, "0.160.0", "", "sage_finish_run");
  assert.deepEqual(await retry.call(f.finishInput), { ...first, decision: "already-finished" });
  await retry.close();
  const { logbookRoot, ...legacy } = f.options;
  writeFileSync(file, JSON.stringify({ version: 2, mode: legacy }));
  const unavailable = await connect(t, f, "0.160.0", "", "sage_finish_run");
  assert.match((await unavailable.call(f.finishInput)).error, /could not finish/);
  await unavailable.close();
});


async function reviewPreparationFixture(t, role = "code-reviewer") {
  const f = await composedPolicyFixture(t);
  const projectDirectory = join(f.dir, "project"); mkdirSync(projectDirectory);
  const env = { ...process.env, SAGE_HOME: join(f.dir, "logbook") };
  const git = (...args) => execFileSync("git", ["-C", projectDirectory, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "user.name=Fixture", "-c", "user.email=fixture@users.noreply.github.com", ...args], { env, encoding: "utf8" }).trim();
  git("init", "--quiet", "-b", "codex/t1-review");
  git("commit", "--quiet", "--allow-empty", "-m", "fixture");
  const tool = f.core.createStateTool({ defaultRoot: () => { throw Error("No ambient logbook"); } });
  const cli = (...args) => tool.sage([...args, "--project", projectDirectory], env);
  cli("init"); cli("task", "add", "--title", "Pinned review", "--size", "small");
  cli("task", "T1", "set", "branch=codex/t1-review");
  cli("run", "add", "T1", "--role", role);
  mkdirSync(f.options.observationsRoot, { recursive: true });
  const options = { ...f.options, projectDirectory, logbookRoot: env.SAGE_HOME };
  const input = { ...f.input, role, reviewCycle: 1 };
  const prepare = (request = input) => f.api.prepareNativeTask(request, f.native(session), options);
  const logbook = tool.storeDir(projectDirectory, env);
  return { ...f, options, input, prepare, git, cli, tool, env, logbook };
}

test("native review target captures the actual head round and cycle in immutable child instructions", async t => {
  const f = await reviewPreparationFixture(t);
  const receipt = f.prepare();
  const expected = { branch: "codex/t1-review", sha: f.git("rev-parse", "HEAD"), round: 0, cycle: 1 };
  assert.deepEqual(receipt.review, expected);
  assert.match(receipt.message, new RegExp(`Commit: ${expected.sha}`));
  assert.match(receipt.message, /Task round: 0\nReview cycle: 1/);
  assert.deepEqual(f.prepare().review, expected);
  assert.throws(() => f.prepare({ ...f.input, reviewCycle: 2 }));
  const policy = f.createNativePolicy(f.options, () => ({ decision: "pass" }));
  assert.deepEqual(await f.evaluate(policy), { decision: "pass" });
  f.events.publish(join(f.options.observationsRoot, session), f.result);
  const delivered = policy.startChild(f.identity);
  assert.match(delivered.brief, new RegExp(`Commit: ${expected.sha}`));
  assert.match(delivered.brief, /Review cycle: 1/);
  const journal = f.core.readAdmission(f.options.directory);
  assert.deepEqual(journal.preparations[0].review, expected);
  assert.equal(journal.reservations[0].preparation, journal.preparations[0].id);
});

test("native review target refuses stale heads before reservation and preserves the saved review", async t => {
  const f = await reviewPreparationFixture(t);
  const receipt = f.prepare();
  f.git("commit", "--quiet", "--allow-empty", "-m", "changed head");
  assert.notEqual(f.git("rev-parse", "HEAD"), receipt.review.sha);
  const policy = f.createNativePolicy(f.options, () => ({ decision: "pass" }));
  await assert.rejects(f.evaluate(policy));
  const journal = f.core.readAdmission(f.options.directory);
  assert.equal(journal.reservations.length, 0);
  assert.deepEqual(journal.preparations[0].review, receipt.review);
  assert.throws(() => f.prepare());
});

test("native review target rejects missing cycles foreign roles and changed run state", async t => {
  const f = await reviewPreparationFixture(t);
  const receipt = f.prepare();
  assert.ok(receipt.review);
  const { reviewCycle, ...missing } = f.input;
  for (const request of [missing, { ...f.input, reviewCycle: 0 }, { ...f.input, reviewCycle: 11 },
    { ...f.input, reviewCycle: "1" }, { ...f.input, role: "lead" }, { ...f.input, role: "qa" },
    { ...f.input, task: "T2" }, { ...f.input, sha: receipt.review.sha }]) assert.throws(() => f.prepare(request));
  f.cli("run", "done", "R1", "--status", "done");
  const policy = f.createNativePolicy(f.options, () => ({ decision: "pass" }));
  await assert.rejects(f.evaluate(policy));
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 0);
});

test("native review target ignores injected git selection and refuses a stale task round", async t => {
  const f = await reviewPreparationFixture(t);
  const receipt = f.prepare();
  f.git("checkout", "--quiet", "-b", "other-branch");
  f.git("commit", "--quiet", "--allow-empty", "-m", "other branch");
  assert.notEqual(f.git("rev-parse", "HEAD"), receipt.review.sha);
  const request = { project: f.options.projectDirectory, task: "T1", run: "R1", role: "code-reviewer", cycle: 1 };
  assert.deepEqual(f.tool.captureReviewTarget(request, { ...f.env, GIT_DIR: join(f.dir, "missing-repository"),
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "false" }), receipt.review);
  const table = join(f.logbook, "tasks.tsv");
  const lines = readFileSync(table, "utf8").trimEnd().split("\n");
  const columns = lines[0].split("\t"), row = lines[1].split("\t");
  row[columns.indexOf("round")] = "1";
  writeFileSync(table, lines[0] + "\n" + row.join("\t") + "\n");
  const policy = f.createNativePolicy(f.options, () => ({ decision: "pass" }));
  await assert.rejects(f.evaluate(policy));
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 0);
});

test("native review target refuses redirected project logbooks and missing fixed options", async t => {
  const { renameSync } = await import("node:fs");
  const f = await reviewPreparationFixture(t);
  assert.ok(f.prepare().review);
  const incomplete = f.createNativePolicy({ ...f.options, logbookRoot: undefined }, () => ({ decision: "pass" }));
  await assert.rejects(f.evaluate(incomplete));
  renameSync(f.logbook, `${f.logbook}-saved`);
  symlinkSync(`${f.logbook}-saved`, f.logbook);
  const policy = f.createNativePolicy(f.options, () => ({ decision: "pass" }));
  await assert.rejects(f.evaluate(policy));
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 0);
});


async function reviewAcceptanceFixture(t, { role = "code-reviewer", findings = [], overrides = {}, finish = true } = {}) {
  const f = await reviewPreparationFixture(t, role);
  const preparation = f.prepare();
  const policy = f.createNativePolicy(f.options, () => ({ decision: "pass" }));
  await f.evaluate(policy);
  f.events.publish(join(f.options.observationsRoot, session), f.result);
  const transcript = f.childTranscript();
  await f.evaluate(policy, { ...patch(turns[1]), transcript_path: transcript }, childActor);
  const blocking = findings.some(row => row.severity !== "low");
  const fields = { STATUS: "done", RESULT: role === "qa" ? blocking ? "FAIL" : "PASS" : blocking ? "FINDINGS" : "CLEAN",
    EVIDENCE: JSON.stringify({ commit: preparation.review.sha, round: preparation.review.round, cycle: 1, summary: "Synthetic review evidence" }),
    FINDINGS: JSON.stringify(findings), QUESTIONS: "none", "NOT VERIFIED": "A real review", BRANCH: preparation.review.branch, ...overrides };
  const text = Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n");
  appendReport(f, text);
  policy.completeChild({ hook_event_name: "SubagentStop", session_id: session, agent_id: childActor,
    turn_id: turns[1], transcript_path: join(f.mode.sessionsDir, "root.jsonl") }, f.native(childActor));
  const reportApi = await import(pathToFileURL(join(f.plugin, "runtime/report-intake.mjs")));
  const runApi = await import(pathToFileURL(join(f.plugin, "runtime/run-report.mjs")));
  assert.equal(typeof runApi.acceptRecordedReview, "function");
  const receipt = reportApi.readChildReport({ name: f.input.name }, f.native(session), f.options);
  reportApi.recordChildReport({ name: f.input.name, reportHash: receipt.reportHash }, f.native(session), f.options);
  const input = { assignment: receipt.assignment, reportHash: receipt.reportHash };
  if (finish) runApi.finishRecordedRun(input, f.native(session), f.options);
  const accept = (request = input, actor = session) => runApi.acceptRecordedReview(request, f.native(actor), f.options);
  return { ...f, preparation, receipt, accept, acceptInput: input, runApi, text };
}
const fixtureTaskField = (f, key, value) => {
  const file = join(f.logbook, "tasks.tsv"), lines = readFileSync(file, "utf8").trimEnd().split("\n");
  const columns = lines[0].split("\t"), row = lines[1].split("\t"); row[columns.indexOf(key)] = value;
  writeFileSync(file, lines[0] + "\n" + row.join("\t") + "\n");
};

for (const [role, kind] of [["code-reviewer", "review-clean"], ["security-reviewer", "security-clean"], ["ux-reviewer", "ux-clean"], ["qa", "qa-pass"]]) {
  test(`review acceptance records ${role} evidence once without approving a task or merge`, async t => {
    const f = await reviewAcceptanceFixture(t, { role });
    const before = readFileSync(join(f.logbook, "tasks.tsv"), "utf8");
    const first = f.accept();
    assert.equal(first.decision, "review-accepted"); assert.equal(first.kind, kind);
    const ledger = f.tool.read(f.logbook, "ledger");
    assert.equal(ledger.length, 1); assert.equal(ledger[0].run, "R1"); assert.equal(ledger[0].sha, f.preparation.review.sha);
    assert.deepEqual(f.accept(), { ...first, decision: "already-accepted" });
    assert.equal(f.tool.read(f.logbook, "ledger").length, 1);
    assert.equal(readFileSync(join(f.logbook, "tasks.tsv"), "utf8"), before);
    assert.equal(f.tool.mergeCheck(first.sha, f.env).ok, false);
    f.git("commit", "--quiet", "--allow-empty", "-m", "later head");
    assert.deepEqual(f.accept(), { ...first, decision: "already-accepted" });
    assert.equal(f.tool.read(f.logbook, "ledger")[0].sha, first.sha);
  });
}

test("review acceptance keeps low findings open and blocking findings return verified work to reviewing", async t => {
  for (const state of ["verified", "pr-ready"]) {
    const f = await reviewAcceptanceFixture(t, { findings: [{ severity: "low", summary: "A small issue" }, { severity: "high", summary: "An unsafe result" }] });
    fixtureTaskField(f, "state", state);
    const result = f.accept();
    assert.equal(result.kind, "findings");
    assert.equal(f.tool.read(f.logbook, "tasks")[0].state, "reviewing");
    assert.equal(f.tool.read(f.logbook, "decisions").filter(row => row.decision === `${state} → reviewing`).length, 1);
    const findings = f.tool.read(f.logbook, "findings");
    assert.equal(findings.length, 2); assert(findings.every(row => row.status === "open" && row.source === "code-reviewer"));
    assert.equal(f.tool.mergeCheck(result.sha, f.env).ok, false);
    f.accept(); assert.equal(f.tool.read(f.logbook, "findings").length, 2);
  }
  const low = await reviewAcceptanceFixture(t, { findings: [{ severity: "low", summary: "Only a small issue" }] });
  assert.equal(low.accept().kind, "review-clean");
  assert.equal(low.tool.read(low.logbook, "findings")[0].status, "open");
});

test("review acceptance rejects stale commits rounds unfinished runs foreign actors and conflicting report claims", async t => {
  const f = await reviewAcceptanceFixture(t, { finish: false });
  assert.throws(() => f.accept());
  f.runApi.finishRecordedRun(f.acceptInput, f.native(session), f.options);
  assert.throws(() => f.accept(f.acceptInput, childActor));
  assert.throws(() => f.accept({ ...f.acceptInput, reportHash: "a".repeat(64) }));
  assert.throws(() => f.accept({ ...f.acceptInput, kind: "review-clean" }));
  fixtureTaskField(f, "round", "1"); assert.throws(() => f.accept());
  fixtureTaskField(f, "round", "0");
  f.git("commit", "--quiet", "--allow-empty", "-m", "changed head"); assert.throws(() => f.accept());
  assert.equal(f.tool.read(f.logbook, "ledger").length, 0);
  for (const overrides of [{ EVIDENCE: "unstructured" }, { FINDINGS: "none" }, { RESULT: "PASS" },
    { RESULT: "FINDINGS" }, { QUESTIONS: "An unanswered product choice" }, { BRANCH: "another-branch" },
    { FINDINGS: JSON.stringify([{ severity: "high", summary: "Contradicts a clean result" }]) }]) {
    const bad = await reviewAcceptanceFixture(t, { overrides });
    assert.throws(() => bad.accept());
    assert.equal(bad.tool.read(bad.logbook, "ledger").length, 0);
    assert.equal(existsSync(join(bad.logbook, "review-pending.json")), false);
  }
});

async function stopReviewWrite(t, f, table) {
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const original = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === join(f.logbook, `${table}.tsv`)) throw Object.assign(Error("Injected review write failure"), { code: "EIO" });
    return original(from, to);
  });
  syncBuiltinESMExports();
  const restore = () => { t.mock.restoreAll(); syncBuiltinESMExports(); };
  t.after(restore);
  return restore;
}
for (const table of ["tasks", "ledger"]) test(`review acceptance recovers a failed ${table} write and blocks merging while incomplete`, async t => {
  const f = await reviewAcceptanceFixture(t, { findings: [{ severity: "high", summary: "Preserve this finding" }] });
  fixtureTaskField(f, "state", "verified");
  for (const kind of ["checks-pass", "review-clean", "qa-pass"]) f.cli("verdict", "T1", "--sha", f.preparation.review.sha, "--kind", kind);
  assert.equal(f.tool.mergeCheck(f.preparation.review.sha, f.env).ok, true);
  const restore = await stopReviewWrite(t, f, table);
  assert.throws(() => f.accept(), /Injected review write failure/);
  assert(existsSync(join(f.logbook, "review-pending.json")));
  assert.match(f.tool.mergeCheck(f.preparation.review.sha, f.env).reason, /recorded update is incomplete/);
  assert.throws(() => f.cli("log", "T1", "unrelated change", "--why", "must wait"), /recorded update is incomplete/);
  restore();
  // A changed Git head does not erase a write intent already validated for the older commit.
  f.git("commit", "--quiet", "--allow-empty", "-m", "later head");
  const result = f.accept();
  assert.equal(result.decision, "review-accepted"); assert.equal(result.sha, f.preparation.review.sha);
  assert.equal(existsSync(join(f.logbook, "review-pending.json")), false);
  assert.equal(f.tool.read(f.logbook, "findings").length, 1);
  assert.equal(f.tool.read(f.logbook, "ledger").filter(row => row.run === "R1").length, 1);
  assert.equal(f.tool.read(f.logbook, "tasks")[0].state, "reviewing");
  assert.deepEqual(f.accept(), { ...result, decision: "already-accepted" });
});

test("review acceptance recovery preserves unexpected table changes and refuses damaged pending evidence", async t => {
  const f = await reviewAcceptanceFixture(t, { findings: [{ severity: "medium", summary: "Retained issue" }] });
  fixtureTaskField(f, "state", "verified");
  const original = readFileSync(join(f.logbook, "tasks.tsv"), "utf8");
  const restore = await stopReviewWrite(t, f, "tasks");
  assert.throws(() => f.accept(), /Injected/); restore();
  fixtureTaskField(f, "title", "Unexpected edit");
  const edited = readFileSync(join(f.logbook, "tasks.tsv"), "utf8");
  assert.throws(() => f.accept());
  assert.equal(readFileSync(join(f.logbook, "tasks.tsv"), "utf8"), edited);
  writeFileSync(join(f.logbook, "tasks.tsv"), original);
  const file = join(f.logbook, "review-pending.json"), saved = readFileSync(file, "utf8");
  writeFileSync(file, saved.replace("Retained issue", "Altered issue"));
  assert.throws(() => f.accept());
  assert.equal(f.tool.mergeCheck(f.preparation.review.sha, f.env).ok, false);
  writeFileSync(file, saved);
  assert.equal(f.accept().decision, "review-accepted");
});

test("packaged review acceptance requires the chief and preserves one verdict after reconnect", async t => {
  const f = await reviewAcceptanceFixture(t);
  writeFileSync(f.entry, `import { servePreparations } from './plugin/runtime/preparation-server.mjs'; servePreparations(${JSON.stringify(f.options)});`);
  const client = await connect(t, f, "0.160.0", "", "sage_accept_review");
  assert.match((await client.call(f.acceptInput, childActor)).error, /could not accept/);
  assert.equal(f.tool.read(f.logbook, "ledger").length, 0);
  const first = await client.call(f.acceptInput);
  assert.equal(first.decision, "review-accepted"); await client.close();
  const retry = await connect(t, f, "0.160.0", "", "sage_accept_review");
  assert.deepEqual(await retry.call(f.acceptInput), { ...first, decision: "already-accepted" }); await retry.close();
  assert.equal(f.tool.read(f.logbook, "ledger").length, 1);
});


test("review acceptance during a merge read cannot hide a new open finding", async t => {
  const f = await reviewAcceptanceFixture(t, { findings: [{ severity: "low", summary: "Needs explicit triage" }] });
  fixtureTaskField(f, "state", "verified");
  for (const kind of ["checks-pass", "review-clean", "qa-pass"]) f.cli("verdict", "T1", "--sha", f.preparation.review.sha, "--kind", kind);
  assert.equal(f.tool.mergeCheck(f.preparation.review.sha, f.env).ok, true);
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const original = fs.openSync;
  let accepted = false;
  t.mock.method(fs, "openSync", (file, ...args) => {
    if (!accepted && file === join(f.logbook, "ledger.tsv")) {
      accepted = true;
      assert.equal(f.accept().decision, "review-accepted");
    }
    return original(file, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = f.tool.mergeCheck(f.preparation.review.sha, f.env);
  assert.equal(accepted, true);
  assert.equal(result.ok, false);
});


async function recordedReader(f) {
  const api = await import(pathToFileURL(join(f.plugin, "runtime/run-report.mjs")));
  assert.equal(typeof api.readRecordedReport, "function");
  return (input = f.finishInput, actor = session, options = f.options) => api.readRecordedReport(input, f.native(actor), options);
}

test("chief saved report inspection reads exact evidence without finishing or accepting it", async t => {
  const f = await runReportFixture(t), read = await recordedReader(f);
  assert.throws(() => read()); f.record();
  const before = JSON.stringify(f.core.readAdmission(f.options.directory));
  const tables = ["tasks", "runs", "ledger", "findings", "gates", "decisions"];
  const snapshot = () => tables.map(name => readFileSync(join(f.logbook, `${name}.tsv`), "utf8"));
  const prior = snapshot(), report = read();
  assert.equal(report.decision, "recorded-report"); assert.equal(report.text, reportText);
  assert.equal(report.reportHash, f.finishInput.reportHash); assert.equal(report.assignment, f.finishInput.assignment);
  assert.equal(report.role, "lead"); assert.equal(report.issuer, session); assert.equal(report.child, childActor);
  assert.equal(report.turn, turns[1]); assert.equal(report.task, "T1"); assert.equal(report.run, "R1");
  assert.equal(Object.hasOwn(report, "project"), false); assert.equal(Object.hasOwn(report, "review"), false);
  assert.deepEqual(read(), report); assert.deepEqual(snapshot(), prior);
  assert.equal(JSON.stringify(f.core.readAdmission(f.options.directory)), before);
  assert.equal(f.tool.read(f.logbook, "runs")[0].status, "running");
});

test("chief saved report inspection refuses other actors hashes scope and versions but survives transcript loss", async t => {
  const f = await runReportFixture(t), read = await recordedReader(f); f.record();
  for (const actor of [childActor, turns[0]]) assert.throws(() => read(f.finishInput, actor));
  for (const extra of [{ reportHash: "a".repeat(64) }, { assignment: turns[0] }, { text: reportText }, { session }])
    assert.throws(() => read({ ...f.finishInput, ...extra }));
  assert.throws(() => read(f.finishInput, session, { ...f.options, project: "other" }));
  const api = await import(pathToFileURL(join(f.plugin, "runtime/run-report.mjs")));
  assert.throws(() => api.readRecordedReport(f.finishInput, { version: "unsupported", actor: session }, f.options));
  const expected = read();
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  rmSync(f.mode.sessionsDir, { recursive: true }); assert.deepEqual(read(), expected);
});

test("chief saved report inspection exposes the pinned review target through the packaged tool", async t => {
  const f = await reviewAcceptanceFixture(t, { finish: false });
  writeFileSync(f.entry, `import { servePreparations } from './plugin/runtime/preparation-server.mjs'; servePreparations(${JSON.stringify(f.options)});`);
  const client = await connect(t, f, "0.160.0", "", "sage_read_recorded_report");
  assert.match((await client.call(f.acceptInput, childActor)).error, /could not read/);
  const report = await client.call(f.acceptInput); await client.close();
  assert.equal(report.decision, "recorded-report"); assert.equal(report.text, f.text);
  assert.deepEqual(report.review, f.preparation.review);
  assert.equal(f.tool.read(f.logbook, "runs")[0].status, "running");
  assert.equal(f.tool.read(f.logbook, "ledger").length, 0);
  const retry = await connect(t, f, "0.160.0", "", "sage_read_recorded_report");
  assert.deepEqual(await retry.call(f.acceptInput), report); await retry.close();
});

test("chief saved report inspection reads a lead's recorded nested report without taking parent authority", async t => {
  const f = await composedPolicyFixture(t);
  f.api.prepareNativeTask(f.input, f.native(session), f.options);
  const policy = f.createNativePolicy(f.options, () => ({ decision: "pass" }));
  await f.evaluate(policy); f.events.publish(join(f.options.observationsRoot, session), f.result);
  const leadTranscript = f.childTranscript();
  await f.evaluate(policy, { ...patch(turns[1]), transcript_path: leadTranscript }, childActor);
  const qa = "a22422c7-509c-43aa-8c42-827c556f8a59", path = "/root/fixture_lead/qa_child";
  const request = { ...f.input, name: "qa_child", run: "R2", role: "qa", reviewCycle: 1 };
  f.api.prepareNativeTask(request, f.native(childActor), f.options);
  const spawn = { ...f.spawnInput(request.name, "spawn-qa"), turn_id: turns[1], transcript_path: leadTranscript };
  await f.evaluate(policy, spawn, childActor);
  f.events.publish(join(f.options.observationsRoot, session), { ...f.result, actor: childActor, call: "spawn-qa", turn: turns[1], path });
  const transcript = f.childTranscript({ child: qa, parent: childActor, path, turn: turns[2] });
  await f.evaluate(policy, { ...patch(turns[2]), transcript_path: transcript }, qa);
  appendReport(f, reportText, qa, turns[2]);
  policy.completeChild({ hook_event_name: "SubagentStop", session_id: session, agent_id: qa, turn_id: turns[2],
    transcript_path: leadTranscript }, f.native(qa));
  const api = await import(pathToFileURL(join(f.plugin, "runtime/report-intake.mjs")));
  assert.throws(() => api.readChildReport({ name: request.name }, f.native(session), f.options));
  const receipt = api.readChildReport({ name: request.name }, f.native(childActor), f.options);
  api.recordChildReport({ name: request.name, reportHash: receipt.reportHash }, f.native(childActor), f.options);
  const projectDirectory = join(f.dir, "project"), logbookRoot = join(f.dir, "logbook");
  mkdirSync(projectDirectory); mkdirSync(logbookRoot);
  f.options = { ...f.options, projectDirectory, logbookRoot };
  f.finishInput = { assignment: receipt.assignment, reportHash: receipt.reportHash };
  const read = await recordedReader(f), report = read();
  assert.equal(report.issuer, childActor); assert.equal(report.child, qa); assert.equal(report.role, "qa");
  assert.equal(report.run, "R2"); assert.equal(report.text, reportText);
  assert.throws(() => read(f.finishInput, childActor)); assert.throws(() => read(f.finishInput, qa));
  assert.throws(() => api.readChildReport({ name: request.name }, f.native(session), f.options));
});


async function noToolCompletionFixture(t) {
  const f = await composedPolicyFixture(t);
  f.api.prepareNativeTask(f.input, f.native(session), f.options);
  await f.evaluate(f.createNativePolicy(f.options, () => ({ decision: "pass" })));
  f.events.publish(join(f.options.observationsRoot, session), f.result);
  const transcript = f.childTranscript(); appendReport(f);
  const policy = f.createNativePolicy(f.options, () => ({ decision: "pass" }));
  const stop = { hook_event_name: "SubagentStop", session_id: session, agent_id: childActor, turn_id: turns[1],
    transcript_path: join(f.mode.sessionsDir, "root.jsonl"), agent_transcript_path: transcript };
  return { ...f, policy, stop, transcript };
}

test("no-tool completion binds the exact initial task and exposes its completed report once", async t => {
  const f = await noToolCompletionFixture(t);
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 0);
  assert.deepEqual(f.policy.completeChild(f.stop, f.native(childActor)), { decision: "completed" });
  assert.deepEqual(f.policy.completeChild(f.stop, f.native(childActor)), { decision: "already-completed" });
  const state = f.core.readAdmission(f.options.directory);
  assert.equal(state.bindings.length, 1); assert.equal(state.completions.length, 1);
  assert.deepEqual(state.completions[0], state.bindings[0]);
  const { readChildReport } = await import(pathToFileURL(join(f.plugin, "runtime/report-intake.mjs")));
  const report = readChildReport({ name: f.input.name }, f.native(session), f.options);
  assert.equal(report.reportHash, createHash("sha256").update(reportText).digest("hex"));
  assert.equal(report.assignment, state.bindings[0].assignment);
});

test("no-tool completion refuses missing foreign changed or stale transcript evidence", async t => {
  const f = await noToolCompletionFixture(t);
  const { agent_transcript_path, ...missing } = f.stop;
  for (const input of [missing, { ...f.stop, agent_transcript_path: f.stop.transcript_path },
    { ...f.stop, agent_transcript_path: "relative" }, { ...f.stop, turn_id: turns[2] },
    { ...f.stop, agent_id: session }, { ...f.stop, extra: true }]) assert.throws(() => f.policy.completeChild(input, f.native(childActor)));
  assert.throws(() => f.policy.completeChild(f.stop, f.native(session)));
  assert.throws(() => f.policy.completeChild(f.stop, { version: "unsupported", actor: childActor }));
  f.childTranscript({ message: "Changed task" }); assert.throws(() => f.policy.completeChild(f.stop, f.native(childActor)));
  const state = f.core.readAdmission(f.options.directory);
  assert.equal(state.bindings.length, 0); assert.equal(state.completions?.length ?? 0, 0);
  f.childTranscript(); appendReport(f);
  assert.deepEqual(f.policy.completeChild(f.stop, f.native(childActor)), { decision: "completed" });
});

test("no-tool completion retains missing-result work then completes it after the result even when mode is off", async t => {
  const f = await composedPolicyFixture(t);
  f.api.prepareNativeTask(f.input, f.native(session), f.options);
  const policy = f.createNativePolicy(f.options, () => ({ decision: "pass" }));
  await f.evaluate(policy);
  const transcript = f.childTranscript(); appendReport(f);
  const stop = { hook_event_name: "SubagentStop", session_id: session, agent_id: childActor, turn_id: turns[1],
    transcript_path: join(f.mode.sessionsDir, "root.jsonl"), agent_transcript_path: transcript };
  assert.throws(() => policy.completeChild(stop, f.native(childActor)));
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 0);
  f.events.publish(join(f.options.observationsRoot, session), f.result);
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  assert.deepEqual(policy.completeChild(stop, f.native(childActor)), { decision: "completed" });
  assert.equal(f.core.readAdmission(f.options.directory).modes.at(-1).sage, false);
});

test("no-tool completion through the packaged stop tool refuses a conflicting path after completion", async t => {
  const f = await noToolCompletionFixture(t);
  writeFileSync(f.entry, `import { serveHooks } from './plugin/runtime/mcp-server.mjs';
    import { createNativePolicy } from './plugin/runtime/policy.mjs';
    const options = ${JSON.stringify(f.options)};
    serveHooks({ mode: ${JSON.stringify(f.mode)}, loadPolicy: async () => createNativePolicy(options, () => ({decision: 'pass'})) });`);
  const client = await connect(t, f);
  assert.deepEqual(await client.call({ ...f.stop, stop_hook_active: false, last_assistant_message: reportText }, childActor), {});
  assert.deepEqual(await client.call({ ...f.stop, stop_hook_active: false, last_assistant_message: reportText }, childActor), {});
  assert.equal((await client.call({ ...f.stop, stop_hook_active: false, last_assistant_message: reportText, agent_transcript_path: f.stop.transcript_path }, childActor)).decision, "block");
  assert.equal(f.core.readAdmission(f.options.directory).completions.length, 1);
  await client.close();
});


test("no-tool completion recovers a binding whose transcript publication failed", async t => {
  const f = await noToolCompletionFixture(t);
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const original = fs.linkSync;
  t.mock.method(fs, "linkSync", (from, to) => {
    if (String(from).startsWith(join(f.options.observationsRoot, session))
      && JSON.parse(readFileSync(from, "utf8")).kind === "child-transcript") {
      throw Object.assign(Error("Injected transcript publication failure"), { code: "EIO" });
    }
    return original(from, to);
  });
  syncBuiltinESMExports();
  const restore = () => { t.mock.restoreAll(); syncBuiltinESMExports(); }; t.after(restore);
  assert.throws(() => f.policy.completeChild(f.stop, f.native(childActor)), /Injected transcript publication failure/);
  const before = f.core.readAdmission(f.options.directory);
  assert.equal(before.bindings.length, 1); assert.equal(before.completions?.length ?? 0, 0);
  restore();
  assert.deepEqual(f.policy.completeChild(f.stop, f.native(childActor)), { decision: "completed" });
  assert.deepEqual(f.policy.completeChild(f.stop, f.native(childActor)), { decision: "already-completed" });
  assert.equal(f.core.readAdmission(f.options.directory).completions.length, 1);
});


async function stopReportClient(t, f) {
  writeFileSync(f.entry, `import { serveHooks } from './plugin/runtime/mcp-server.mjs';
    import { createNativePolicy } from './plugin/runtime/policy.mjs';
    serveHooks({ mode: ${JSON.stringify(f.mode)}, loadPolicy: async () => createNativePolicy(${JSON.stringify(f.options)}, () => ({decision: 'pass'})) });`);
  return connect(t, f);
}

test("native report correction asks once then permits an invalid report to finish without accepting it", async t => {
  const f = await completionFixture(t), client = await stopReportClient(t, f);
  const stop = { ...f.stop, stop_hook_active: false, last_assistant_message: "STATUS done" };
  const first = await client.call(stop, childActor);
  assert.equal(first.decision, "block"); assert.match(first.reason, /RESULT, EVIDENCE, FINDINGS, QUESTIONS, NOT VERIFIED, BRANCH/);
  assert.equal((f.core.readAdmission(f.options.directory).completions ?? []).length, 0);
  assert.deepEqual(await client.call({ ...stop, stop_hook_active: true }, childActor), {});
  assert.equal((f.core.readAdmission(f.options.directory).completions ?? []).length, 0);
  appendReport(f, stop.last_assistant_message);
  const { readChildReport } = await import(pathToFileURL(join(f.plugin, "runtime/report-intake.mjs")));
  assert.throws(() => readChildReport({ name: f.input.name }, f.native(session), f.options), /report needs every required field/);
  const state = f.core.readAdmission(f.options.directory);
  assert.equal(state.completions.length, 1); assert.equal(state.reports?.length ?? 0, 0);
  assert.deepEqual(await client.call(stop, childActor), {}); // Terminal evidence prevents another correction.
  await client.close();
});

test("native report correction accepts repaired fields while retaining capacity until the native turn ends", async t => {
  const f = await completionFixture(t), client = await stopReportClient(t, f);
  const stop = { ...f.stop, stop_hook_active: false, last_assistant_message: "unfinished" };
  assert.equal((await client.call(stop, childActor)).decision, "block");
  assert.deepEqual(await client.call({ ...stop, stop_hook_active: true, last_assistant_message: reportText }, childActor), {});
  assert.equal((f.core.readAdmission(f.options.directory).completions ?? []).length, 0);
  appendReport(f);
  const { readChildReport, recordChildReport } = await import(pathToFileURL(join(f.plugin, "runtime/report-intake.mjs")));
  const receipt = readChildReport({ name: f.input.name }, f.native(session), f.options);
  assert.equal(receipt.report.STATUS, "done");
  recordChildReport({ name: f.input.name, reportHash: receipt.reportHash }, f.native(session), f.options);
  assert.equal(f.core.readAdmission(f.options.directory).reports.length, 1);
  await client.close();
});

test("native report correction requires typed native fields and the admitted child identity", async t => {
  const f = await completionFixture(t), client = await stopReportClient(t, f);
  const stop = { ...f.stop, stop_hook_active: false, last_assistant_message: reportText };
  for (const invalid of [f.stop, { ...stop, stop_hook_active: "true" }, { ...stop, last_assistant_message: {} },
    { ...stop, turn_id: turns[2] }, { ...stop, agent_id: session }]) {
    assert.deepEqual(await client.call(invalid, childActor), { decision: "block", reason: "Sage could not verify this hook request." });
  }
  assert.equal(f.events.readObservations(join(f.options.observationsRoot, session)).filter(row => row.kind === "child-stop").length, 0);
  assert.deepEqual(await client.call(stop, childActor), {});
  assert.equal((f.core.readAdmission(f.options.directory).completions ?? []).length, 0);
  await client.close();
});

test("native report correction matches Claude field presence without accepting invalid field values", async t => {
  const f = await completionFixture(t), client = await stopReportClient(t, f);
  assert.equal(typeof f.core.missingReportFields, "function");
  const headings = f.core.REPORT_FIELDS.map(field => `| **${field}** |`).join("\n");
  assert.deepEqual(f.core.missingReportFields(headings), []);
  assert.deepEqual(f.core.missingReportFields("prefix STATUS\nRESULTS"), f.core.REPORT_FIELDS);
  assert.deepEqual(f.core.missingReportFields("\u00a0STATUS done"), f.core.REPORT_FIELDS.slice(1));
  assert.throws(() => f.core.parseReport(headings));
  assert.deepEqual(await client.call({ ...f.stop, stop_hook_active: false, last_assistant_message: headings }, childActor), {});
  assert.equal((f.core.readAdmission(f.options.directory).completions ?? []).length, 0);
  await client.close();
});


function failedCallRows(spawn) {
  const metadata = { client_authored: false }, turn = spawn.turn_id, call = spawn.tool_use_id;
  return [
    { type: "response_item", payload: { type: "function_call", namespace: "collaboration", name: "spawn_agent", id: "fc_fixture",
      call_id: call, arguments: JSON.stringify(spawn.tool_input), internal_chat_message_metadata_passthrough: { turn_id: turn } }, metadata },
    { type: "response_item", payload: { type: "function_call_output", id: "fco_fixture", call_id: call,
      output: `Unknown model \`${spawn.tool_input.model}\` for spawn_agent. Available models: fixture`,
      internal_chat_message_metadata_passthrough: { turn_id: turn } }, metadata: { ...metadata } },
  ];
}
async function failedDispatchFixture(t) {
  const f = await composedPolicyFixture(t);
  f.api.prepareNativeTask(f.input, f.native(session), f.options);
  const spawn = f.spawnInput(); spawn.tool_input.model = "missing-fixture-model";
  f.api.reservePreparedSpawn(spawn, f.native(session), f.options);
  const transcript = join(f.mode.sessionsDir, "root.jsonl");
  const prefix = readFileSync(transcript, "utf8") + [
    { type: "event_msg", payload: { type: "task_started", turn_id: spawn.turn_id } },
    { type: "turn_context", payload: { turn_id: spawn.turn_id } },
  ].map(row => JSON.stringify(row) + "\n").join("");
  const rows = failedCallRows(spawn);
  const write = (input = rows) => writeFileSync(transcript, prefix + input.map(row => JSON.stringify(row) + "\n").join(""));
  write();
  const policy = f.createNativePolicy(f.options, () => ({ decision: "pass" }));
  const event = { ...postSpawn(), tool_name: "collaborationlist_agents", tool_input: {}, tool_response: "{}", transcript_path: transcript };
  return { ...f, spawn, transcript, rows, write, policy, event };
}

test("native failed dispatch reconciliation binds the exact call and survives Sage off and retries", async t => {
  const f = await failedDispatchFixture(t);
  assert.equal((f.core.readAdmission(f.options.directory).failures ?? []).length, 0);
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  assert.deepEqual(f.policy.reconcileCompletions(f.event, f.native(session)), { decision: "reconciled" });
  const state = f.core.readAdmission(f.options.directory);
  assert.equal(state.failures.length, 1); assert.equal(state.failures[0].assignment, state.reservations[0].assignment.id);
  assert.equal(state.bindings.length, 0); assert.equal(state.completions?.length ?? 0, 0);
  assert.equal(state.reports?.length ?? 0, 0);
  assert.deepEqual(f.policy.reconcileCompletions(f.event, f.native(session)), { decision: "reconciled" });
  assert.equal(f.core.readAdmission(f.options.directory).failures.length, 1);
});

test("native failed dispatch reconciliation retains unknown errors and refuses forged or conflicting evidence", async t => {
  const f = await failedDispatchFixture(t);
  for (const text of ["other failure", "Unknown model `other` for spawn_agent. Available models: fixture", "", "Unknown model `missing-fixture-model` for spawn_agent. Available models: fixture\nextra"]) {
    const rows = structuredClone(f.rows); rows[1].payload.output = text; f.write(rows);
    f.policy.reconcileCompletions(f.event, f.native(session));
    assert.equal(f.core.readAdmission(f.options.directory).failures?.length ?? 0, 0);
  }
  for (const alter of [rows => { rows[1].metadata.client_authored = true; },
    rows => { rows[0].payload.name = "other_tool"; }, rows => { rows[0].payload.arguments = "{}"; },
    rows => { rows[1].payload.internal_chat_message_metadata_passthrough.turn_id = turns[2]; },
    rows => { rows.push(structuredClone(rows[1])); }, rows => { rows.reverse(); }]) {
    const rows = structuredClone(f.rows); alter(rows); f.write(rows);
    assert.throws(() => f.policy.reconcileCompletions(f.event, f.native(session)), /failure evidence/);
    assert.equal(f.core.readAdmission(f.options.directory).failures?.length ?? 0, 0);
  }
  f.write();
  f.policy.reconcileCompletions(f.event, f.native(childActor));
  assert.equal(f.core.readAdmission(f.options.directory).failures?.length ?? 0, 0);
  const linked = join(f.mode.sessionsDir, "linked-root.jsonl"); symlinkSync(f.transcript, linked);
  assert.throws(() => f.policy.reconcileCompletions({ ...f.event, transcript_path: linked }, f.native(session)));
  f.policy.reconcileCompletions(f.event, f.native(session));
  assert.equal(f.core.readAdmission(f.options.directory).failures.length, 1);
});

test("native failed dispatch reconciliation retains any dispatch with child or success evidence", async t => {
  const good = await failedDispatchFixture(t);
  good.policy.reconcileCompletions(good.event, good.native(session));
  assert.equal(good.core.readAdmission(good.options.directory).failures.length, 1);
  for (const kind of ["result", "start"]) {
    const f = await failedDispatchFixture(t);
    f.events.publish(join(f.options.observationsRoot, session), kind === "result" ? f.result : {
      schema: 1, runtime: "0.160.0", kind: "child-start", session, child: childActor, parent: session,
      turn: turns[1], path: `/root/${f.input.name}`,
    });
    f.policy.reconcileCompletions(f.event, f.native(session));
    assert.equal(f.core.readAdmission(f.options.directory).failures?.length ?? 0, 0);
  }
});

test("native failed dispatch reconciliation lets an admitted lead recover its own rejected child only", async t => {
  const f = await completionFixture(t), request = { ...f.input, name: "failed_qa", run: "R2", role: "qa", reviewCycle: 1 };
  f.api.prepareNativeTask(request, f.native(childActor), f.options);
  const transcript = join(f.mode.sessionsDir, `${childActor}.jsonl`);
  const spawn = { ...f.spawnInput(request.name, "failed-qa"), turn_id: turns[1], transcript_path: transcript };
  spawn.tool_input.model = "missing-fixture-model";
  f.api.reservePreparedSpawn(spawn, f.native(childActor), f.options);
  appendFileSync(transcript, failedCallRows(spawn).map(row => JSON.stringify(row) + "\n").join(""));
  const event = { ...postSpawn(), turn_id: turns[1], tool_name: "collaborationwait_agent", tool_input: {}, tool_response: "", transcript_path: transcript };
  f.policy.reconcileCompletions(event, f.native(session));
  assert.equal(f.core.readAdmission(f.options.directory).failures?.length ?? 0, 0);
  f.policy.reconcileCompletions(event, f.native(childActor));
  const state = f.core.readAdmission(f.options.directory);
  assert.equal(state.failures.length, 1); assert.equal(state.failures[0].issuer, childActor);
  assert.equal(state.failures[0].assignment, state.reservations.find(row => row.assignment.run === "R2").assignment.id);
  assert.equal(state.bindings.length, 1); assert.equal(state.completions?.length ?? 0, 0);
});


test("native failed dispatch reconciliation runs before a new admitted spawn", async t => {
  const f = await failedDispatchFixture(t), request = { ...f.input, name: "retry_lead" };
  f.api.prepareNativeTask(request, f.native(session), f.options);
  const next = { ...f.spawnInput(request.name, "retry-call"), transcript_path: f.transcript };
  assert.equal(f.core.readAdmission(f.options.directory).failures?.length ?? 0, 0);
  assert.deepEqual(await f.evaluate(f.policy, next), { decision: "pass" });
  const state = f.core.readAdmission(f.options.directory);
  assert.equal(state.failures.length, 1); assert.equal(state.reservations.length, 2);
  assert.equal(state.failures[0].assignment, state.reservations[0].assignment.id);
  assert.notEqual(state.failures[0].assignment, state.reservations[1].assignment.id);
});

function commandPolicyInput(f, actor = session, command = 'printf fixed', turn = actor === session ? turns[0] : turns[1], message) {
  const envelope = { cmd: command, shell: '/bin/sh', workdir: f.dir, tty: false, sandbox_permissions: 'use_default' };
  const transcript_path = actor === session ? join(f.mode.sessionsDir, 'command.jsonl') : f.childTranscript({ turn, message });
  const call = { type: 'response_item', metadata: { client_authored: false }, payload: { type: 'function_call',
    name: 'exec_command', call_id: 'command-1', arguments: JSON.stringify(envelope),
    internal_chat_message_metadata_passthrough: { turn_id: turn } } };
  const prefix = actor === session ? [
    { type: 'session_meta', payload: { id: session, session_id: session, cli_version: '0.160.0' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turn } },
    { type: 'turn_context', payload: { turn_id: turn } },
  ].map(row => JSON.stringify(row) + '\n').join('') : readFileSync(transcript_path, 'utf8');
  writeFileSync(transcript_path, prefix + JSON.stringify(call) + '\n');
  return { envelope, input: { hook_event_name: 'PreToolUse', session_id: session, turn_id: turn,
    tool_name: 'Bash', tool_use_id: 'command-1', tool_input: { command }, transcript_path } };
}

test('native command policy receives the original root envelope and shared expansion verdict', async t => {
  const f = await composedPolicyFixture(t);
  const rules = f.core.createCommandPolicy({ stateToolPath: join(f.plugin, 'scripts/sage.mjs') });
  let evaluated = 0, saved;
  const policy = f.createNativePolicy(f.options, (input, context) => {
    evaluated++; saved = structuredClone(context.command);
    assert.equal(context.command.cmd, input.tool_input.command);
    const reason = rules.expansionProblem(context.command.cmd, context.command.workdir);
    return reason ? { decision: 'deny', reason } : { decision: 'pass' };
  });
  const safe = commandPolicyInput(f);
  assert.deepEqual(await f.evaluate(policy, safe.input), { decision: 'pass' });
  assert.deepEqual(saved, safe.envelope);
  // Parser input only. No command from this test reaches a shell.
  const expanded = commandPolicyInput(f, session, 'g{it,h} status');
  assert.equal((await f.evaluate(policy, expanded.input)).decision, 'deny');
  assert.equal(evaluated, 2);
});

test('native command policy refuses missing or changed evidence before evaluation', async t => {
  const f = await composedPolicyFixture(t); let evaluated = 0;
  const policy = f.createNativePolicy(f.options, (input, context) => {
    assert.equal(context.command.cmd, input.tool_input.command); evaluated++; return { decision: 'pass' };
  });
  const { input } = commandPolicyInput(f);
  assert.equal((await f.evaluate(policy, input)).decision, 'pass');
  const { transcript_path, ...missing } = input;
  for (const changed of [missing, { ...input, tool_use_id: 'another' },
    { ...input, tool_input: { command: 'different' } }, { ...input, tool_input: { ...input.tool_input, shell: '/bin/sh' } }]) {
    await assert.rejects(f.evaluate(policy, changed));
  }
  assert.equal(evaluated, 1);
});

test('native command policy verifies the admitted child before providing its envelope', async t => {
  const f = await composedPolicyFixture(t); f.bindLead();
  let evaluated = 0;
  const policy = f.createNativePolicy(f.options, (input, context) => {
    assert.equal(context.actor, childActor); assert.equal(context.command.cmd, input.tool_input.command);
    assert.equal(f.core.readAdmission(f.options.directory).bindings[0].child, childActor);
    evaluated++; return { decision: 'pass' };
  });
  const { input } = commandPolicyInput(f, childActor);
  assert.equal((await f.evaluate(policy, input, childActor)).decision, 'pass');
  const root = commandPolicyInput(f);
  await assert.rejects(f.evaluate(policy, { ...input, transcript_path: root.input.transcript_path }, childActor));
  const state = f.core.readAdmission(f.options.directory); f.core.completeAdmission(f.options.directory, state.bindings[0]);
  await assert.rejects(f.evaluate(policy, input, childActor));
  assert.equal(evaluated, 1);
});


test('native off-mode command evidence supports protected-path decisions without granting admission', async t => {
  const f = await composedPolicyFixture(t);
  const logbookRoot = join(f.dir, 'logbook'); mkdirSync(logbookRoot);
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  const { shellPathDecision } = await import(pathToFileURL(join(f.plugin, 'runtime/file-policy.mjs')));
  let evaluated = 0;
  const policy = f.createNativePolicy(f.options, (input, context) => {
    assert.equal(context.sage, false); assert.equal(context.command.cmd, input.tool_input.command);
    assert.equal(context.command.shell, '/bin/sh'); assert.equal(context.command.workdir, f.dir);
    evaluated++;
    return shellPathDecision(context.command.cmd, { cwd: f.dir, roots: [logbookRoot] });
  });
  const safe = commandPolicyInput(f, session, 'touch ordinary.txt', turns[2]);
  assert.equal((await f.evaluate(policy, safe.input)).decision, 'pass');
  // Parser input only. No command from this test reaches a shell.
  const protectedWrite = commandPolicyInput(f, session, `touch ${logbookRoot}/ledger.tsv`, turns[2]);
  assert.equal((await f.evaluate(policy, protectedWrite.input)).decision, 'deny');
  assert.equal(evaluated, 2);
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 0);
  assert.equal(existsSync(join(f.dir, 'ordinary.txt')), false);
});

test('native off-mode command refuses missing and conflicting original evidence before evaluation', async t => {
  const f = await composedPolicyFixture(t); let evaluated = 0;
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  const policy = f.createNativePolicy(f.options, () => { evaluated++; return { decision: 'pass' }; });
  const { input } = commandPolicyInput(f, session, 'printf fixed', turns[2]);
  const { transcript_path, ...missing } = input;
  for (const changed of [missing, { ...input, tool_use_id: 'another' },
    { ...input, tool_input: { command: 'different' } }, { ...input, tool_input: { ...input.tool_input, shell: '/bin/sh' } }])
    await assert.rejects(f.evaluate(policy, changed));
  assert.equal(evaluated, 0);
  assert.equal((await f.evaluate(policy, input)).decision, 'pass');
  assert.equal(evaluated, 1);
});

test('native off-mode child command verifies its transcript without a Sage admission or start callback', async t => {
  const f = await composedPolicyFixture(t); let evaluated = 0;
  mkdirSync(join(f.options.observationsRoot, session), { recursive: true });
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  const policy = f.createNativePolicy(f.options, (input, context) => {
    assert.equal(context.sage, false); assert.equal(context.actor, childActor);
    assert.equal(context.command.cmd, input.tool_input.command);
    evaluated++; return { decision: 'pass' };
  });
  const { input } = commandPolicyInput(f, childActor, 'printf fixed', turns[1], 'fixed off-mode task');
  assert.equal((await f.evaluate(policy, input, childActor)).decision, 'pass');
  assert.equal(f.events.readObservations(join(f.options.observationsRoot, session)).length, 0);
  const root = commandPolicyInput(f, session, 'printf fixed', turns[2]);
  await assert.rejects(f.evaluate(policy, { ...input, transcript_path: root.input.transcript_path }, childActor));
  assert.equal(evaluated, 1);
  const state = f.core.readAdmission(f.options.directory);
  assert.equal(state.reservations.length, 0); assert.equal(state.bindings.length, 0);
});


test('native off-mode command follows the current child turn and rejects conflicting stored identity', async t => {
  const f = await composedPolicyFixture(t); let evaluated = 0;
  mkdirSync(join(f.options.observationsRoot, session), { recursive: true });
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  const policy = f.createNativePolicy(f.options, (input, context) => {
    assert.equal(context.command.cmd, input.tool_input.command); evaluated++; return { decision: 'pass' };
  });
  const first = commandPolicyInput(f, childActor, 'printf fixed', turns[1], 'fixed first task');
  const original = readFileSync(first.input.transcript_path, 'utf8');
  const next = commandPolicyInput(f, childActor, 'printf followup', turns[2], 'fixed later task');
  const call = JSON.parse(readFileSync(next.input.transcript_path, 'utf8').trim().split('\n').at(-1));
  call.payload.call_id = 'command-2'; next.input.tool_use_id = 'command-2';
  writeFileSync(next.input.transcript_path, original + [
    { type: 'response_item', payload: { type: 'function_call_output', call_id: first.input.tool_use_id, output: 'fixed' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: turns[1] } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turns[2] } },
    { type: 'turn_context', payload: { turn_id: turns[2] } }, call,
  ].map(row => JSON.stringify(row) + '\n').join(''));
  assert.equal((await f.evaluate(policy, next.input, childActor)).decision, 'pass');
  await assert.rejects(f.evaluate(policy, first.input, childActor));
  policy.startChild({ ...f.identity, path: '/root/conflicting_child' });
  await assert.rejects(f.evaluate(policy, next.input, childActor));
  assert.equal(evaluated, 1);
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 0);
});


async function commandDecoder(t) {
  const f = fixture(t);
  const { decodeNativeCommand } = await import(pathToFileURL(join(f.plugin, 'runtime/command-input.mjs')));
  return decodeNativeCommand;
}

test('native command decoder preserves all supported fields without approving or inventing defaults', async t => {
  const decode = await commandDecoder(t);
  assert.deepEqual(decode({ cmd: 'printf fixed' }), { cmd: 'printf fixed' });
  const value = { cmd: 'printf fixed', shell: 'pwsh', login: false, tty: true, yield_time_ms: 0,
    timeout_ms: 1000, max_output_tokens: 200, sandbox_permissions: 'with_additional_permissions',
    additional_permissions: { network: { enabled: true }, file_system: { read: ['relative'], write: ['/fixture'] } },
    justification: 'fixed reason', prefix_rule: ['printf'], environment_id: 'remote-fixture', workdir: '../relative' };
  const saved = decode(value); assert.deepEqual(saved, value);
  value.additional_permissions.file_system.write[0] = '/changed';
  assert.deepEqual(saved.additional_permissions.file_system.write, ['/fixture']);
  for (const mode of ['use_default', 'require_escalated', 'with_additional_permissions'])
    assert.equal(decode({ cmd: 'fixed', sandbox_permissions: mode }).sandbox_permissions, mode);
  const nullable = Object.fromEntries(['shell', 'login', 'timeout_ms', 'max_output_tokens', 'sandbox_permissions',
    'additional_permissions', 'justification', 'prefix_rule', 'environment_id', 'workdir'].map(key => [key, null]));
  assert.deepEqual(decode({ cmd: 'fixed', ...nullable }), { cmd: 'fixed', ...nullable });
  assert.deepEqual(decode({ cmd: 'fixed', workdir: '' }), { cmd: 'fixed', workdir: '' });
});

test('native command decoder rejects malformed and unknown top-level fields with a fixed error', async t => {
  const decode = await commandDecoder(t);
  for (const fields of [{ cmd: '' }, { cmd: ['fixed'] }, { cmd: 'x'.repeat(1024 * 1024 + 1) }, { cmd: 'fixed\0private' },
    { shell: 1 }, { shell: '' }, { shell: 'private\npath' }, { login: 'false' }, { tty: null }, { yield_time_ms: null },
    { timeout_ms: -1 }, { max_output_tokens: 0.5 }, { yield_time_ms: Number.MAX_SAFE_INTEGER + 1 },
    { sandbox_permissions: 'danger-full-access' }, { environment_id: {} }, { workdir: [] },
    { justification: false }, { prefix_rule: ['fixed', 1] }, { prefix_rule: Array(2) },
    { prefix_rule: Array(257).fill('fixed') }, { future_option: 'private' }])
    assert.throws(() => decode({ cmd: 'fixed', ...fields }), { message: 'Codex command arguments are unavailable' });
  for (const value of [null, [], Object.assign(Object.create({ shell: 'private' }), { cmd: 'fixed' })])
    assert.throws(() => decode(value), { message: 'Codex command arguments are unavailable' });
});

test('native command decoder preserves permission variants and refuses mixed or malformed permission shapes', async t => {
  const decode = await commandDecoder(t);
  const paths = [{ type: 'path', path: '/fixture' }, { type: 'glob_pattern', pattern: '**/fixed' },
    ...['root', 'minimal', 'tmpdir', 'slash_tmp'].map(kind => ({ type: 'special', value: { kind } })),
    ...['project_roots', 'current_working_directory'].map(kind => ({ type: 'special', value: { kind, subpath: 'src' } })),
    { type: 'special', value: { kind: 'unknown', path: ':future', subpath: null } }];
  const permissions = { network: { enabled: false }, file_system: { entries: paths.map(path =>
    ({ path, access: 'deny', missing_path_behavior: 'skip' })), glob_scan_max_depth: 3 } };
  assert.deepEqual(decode({ cmd: 'fixed', additional_permissions: permissions }).additional_permissions, permissions);
  for (const invalid of [[], { fileSystem: {} }, { network: { enabled: 'true' } }, { network: { other: true } },
    { file_system: { read: ['/fixture'], entries: [] } }, { file_system: { entries: null } },
    { file_system: { write: [false] } }, { file_system: { glob_scan_max_depth: 0 } },
    { file_system: { entries: [{ path: paths[0], access: 'admin' }] } },
    { file_system: { entries: [{ path: paths[0], access: 'write', missing_path_behavior: 'create' }] } },
    { file_system: { entries: [{ path: { type: 'special', value: { kind: 'invented' } }, access: 'read' }] } },
    { file_system: { entries: [{ path: { type: 'path', path: '/fixture', extra: true }, access: 'read' }] } }])
    assert.throws(() => decode({ cmd: 'fixed', additional_permissions: invalid }), { message: 'Codex command arguments are unavailable' });
});

test('native command policy validates recovered argument shapes before its callback in both modes', async t => {
  for (const sage of [true, false]) {
    const f = await composedPolicyFixture(t); let evaluated = 0;
    if (!sage) f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
    const policy = f.createNativePolicy(f.options, (input, context) => {
      evaluated++; assert.equal(context.sage, sage); assert.equal(context.command.login, false);
      assert.deepEqual(context.command.additional_permissions, { network: { enabled: false } });
      return { decision: 'pass' };
    });
    for (const [fields, valid] of [[{ login: 'false' }, false], [{ future: true }, false],
      [{ additional_permissions: { fileSystem: {} } }, false],
      [{ login: false, additional_permissions: { network: { enabled: false } } }, true]]) {
      const { input, envelope } = commandPolicyInput(f, session, 'printf fixed', sage ? turns[0] : turns[2]);
      const rows = readFileSync(input.transcript_path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      rows.at(-1).payload.arguments = JSON.stringify({ ...envelope, ...fields });
      writeFileSync(input.transcript_path, rows.map(row => JSON.stringify(row) + '\n').join(''));
      if (valid) assert.equal((await f.evaluate(policy, input)).decision, 'pass');
      else { await assert.rejects(f.evaluate(policy, input)); assert.equal(evaluated, 0); }
    }
    assert.equal(evaluated, 1);
  }
});


async function unmanagedStopFixture(t) {
  const f = await composedPolicyFixture(t);
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  const transcript = f.childTranscript({ message: 'ordinary native task' });
  const policy = f.createNativePolicy(f.options, () => ({ decision: 'pass' }));
  const stop = { hook_event_name: 'SubagentStop', session_id: session, agent_id: childActor, turn_id: turns[1],
    transcript_path: join(f.mode.sessionsDir, 'root.jsonl'), agent_transcript_path: transcript };
  const { childStopOutput } = await import(pathToFileURL(join(f.plugin, 'runtime/child-stop.mjs')));
  return { ...f, transcript, policy, stop, output: input => childStopOutput(input, f.native(childActor), async () => policy) };
}

test('off-mode ordinary child stops without a Sage report or admission writes', async t => {
  const f = await unmanagedStopFixture(t);
  const before = f.core.readAdmission(f.options.directory);
  assert.deepEqual(f.policy.completeChild(f.stop, f.native(childActor)), { decision: 'unmanaged' });
  assert.deepEqual(await f.output({ ...f.stop, stop_hook_active: false, last_assistant_message: 'ordinary answer' }), {});
  assert.deepEqual(f.core.readAdmission(f.options.directory), before);
  assert.equal(existsSync(join(f.options.observationsRoot, session)), false);
});

test('off-mode ordinary stop requires matching protected child and current-turn evidence', async t => {
  const f = await unmanagedStopFixture(t);
  assert.deepEqual(f.policy.completeChild(f.stop, f.native(childActor)), { decision: 'unmanaged' });
  const { agent_transcript_path, ...missing } = f.stop;
  for (const input of [missing, { ...f.stop, agent_id: session }, { ...f.stop, turn_id: turns[2] },
    { ...f.stop, agent_transcript_path: join(f.mode.sessionsDir, 'root.jsonl') }])
    assert.throws(() => f.policy.completeChild(input, f.native(childActor)));
  appendFileSync(f.transcript, [
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: turns[1] } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turns[2] } },
    { type: 'turn_context', payload: { turn_id: turns[2] } },
  ].map(row => JSON.stringify(row) + '\n').join(''));
  assert.throws(() => f.policy.completeChild(f.stop, f.native(childActor)));
  assert.deepEqual(f.policy.completeChild({ ...f.stop, turn_id: turns[2] }, f.native(childActor)), { decision: 'unmanaged' });
});

test('off-mode ordinary child cannot hide a pending Sage reservation or release another run', async t => {
  const f = await composedPolicyFixture(t);
  f.api.prepareNativeTask(f.input, f.native(session), f.options);
  const policy = f.createNativePolicy(f.options, () => ({ decision: 'pass' }));
  await f.evaluate(policy);
  const transcript = f.childTranscript();
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  const stop = { hook_event_name: 'SubagentStop', session_id: session, agent_id: childActor, turn_id: turns[1],
    transcript_path: join(f.mode.sessionsDir, 'root.jsonl'), agent_transcript_path: transcript };
  assert.throws(() => policy.completeChild(stop, f.native(childActor)));
  const before = f.core.readAdmission(f.options.directory);
  const other = 'a22422c7-509c-43aa-8c42-827c556f8a59';
  const otherTranscript = f.childTranscript({ child: other, path: '/root/ordinary', message: 'ordinary task' });
  assert.deepEqual(policy.completeChild({ ...stop, agent_id: other, agent_transcript_path: otherTranscript }, f.native(other)), { decision: 'unmanaged' });
  assert.deepEqual(f.core.readAdmission(f.options.directory), before);
  assert.equal(before.reservations.length, 1); assert.equal(before.completions?.length ?? 0, 0);
  f.events.publish(join(f.options.observationsRoot, session), f.result);
  assert.deepEqual(policy.completeChild(stop, f.native(childActor)), { decision: 'stop-observed' });
  const bound = f.core.readAdmission(f.options.directory);
  const reused = f.childTranscript({ child: other, message: 'ordinary task with a reused name' });
  assert.deepEqual(policy.completeChild({ ...stop, agent_id: other, agent_transcript_path: reused }, f.native(other)), { decision: 'unmanaged' });
  assert.deepEqual(f.core.readAdmission(f.options.directory), bound);
});

test('active-mode ordinary child still needs a Sage admission at stop', async t => {
  const f = await unmanagedStopFixture(t);
  assert.deepEqual(f.policy.completeChild(f.stop, f.native(childActor)), { decision: 'unmanaged' });
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[2], turn: turns[1], sage: true });
  assert.throws(() => f.policy.completeChild(f.stop, f.native(childActor)));
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 0);
});

test('ordinary native stop before owner activation leaves Sage state unchanged', async t => {
  const f = await unmanagedStopFixture(t);
  const directory = join(f.dir, 'unused-admission');
  f.core.configureAdmission(directory, { total: 5, projects: [{ project: f.options.project, limit: 5 }] });
  const policy = f.createNativePolicy({ ...f.options, directory }, () => ({ decision: 'pass' }));
  const before = f.core.readAdmission(directory);
  assert.equal(before.sessions.length, 0);
  assert.deepEqual(policy.completeChild(f.stop, f.native(childActor)), { decision: 'unmanaged' });
  assert.deepEqual(f.core.readAdmission(directory), before);
});


test('chief context replays activation across connections without repeating on ordinary prompts', async t => {
  const f = fixture(t);
  const client = await connect(t, f);
  const first = await client.call(f.prompt('sage mode'));
  assert.equal(first.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
  const expected = readFileSync(join(f.plugin, 'runtime/chief-instructions.md'), 'utf8').split('\n---\n\n')[1].slice(0, -1); // The Markdown file adds its own final newline.
  const second = await client.call({ ...f.prompt('sage mode'), instruction_part: 1 });
  const strip = text => text.replace(/^Sage chief instructions: part [12] of [12]\n\n/, '');
  assert.equal(strip(first.hookSpecificOutput.additionalContext) + strip(second.hookSpecificOutput.additionalContext), expected);
  for (const output of [first, second]) assert.ok(Buffer.byteLength(output.hookSpecificOutput.additionalContext, 'utf8') < 8_000);
  assert.match(expected, /sage_prepare_task/); assert.match(expected, /Autopilot remains off/);
  await client.close();
  const retry = await connect(t, f);
  assert.deepEqual(await retry.call(f.prompt('sage mode')), first);
  assert.deepEqual(await retry.call({ ...f.prompt('sage mode'), instruction_part: 1 }), second);
  assert.deepEqual(await retry.call({ ...f.prompt('continue', turns[1]), instruction_part: 1 }), {});
  assert.deepEqual(await retry.call(f.prompt('continue', turns[1])), {});
  assert.deepEqual(await retry.call(f.prompt('sage mode', turns[1])), {});
  assert.deepEqual(await retry.call(f.prompt('sage mode')), first);
  await retry.close();
});

test('chief context restarts after off-to-on and refuses delivery to a native child', async t => {
  const f = fixture(t), client = await connect(t, f);
  const first = await client.call(f.prompt('sage mode'));
  assert.ok(first.hookSpecificOutput?.additionalContext);
  assert.deepEqual(await client.call(f.prompt('sage mode off', turns[1])), {});
  assert.deepEqual(await client.call(f.prompt('continue', turns[2])), {});
  assert.equal((await client.call(f.prompt('sage mode', turns[2]), childActor)).decision, 'block');
  for (const part of [-1, 2, null, '1']) assert.equal((await client.call({ ...f.prompt('sage mode', turns[2]), instruction_part: part })).decision, 'block');
  assert.deepEqual(await client.call(f.prompt('sage mode', turns[2])), first);
  assert.deepEqual(await client.call(f.prompt('sage mode')), {});
  await client.close();
});

test('chief context retries rendering failure without losing the saved activation', async t => {
  const f = fixture(t), client = await connect(t, f);
  const bindings = join(f.plugin, 'chief-bindings.json'), saved = readFileSync(bindings, 'utf8');
  writeFileSync(bindings, 'invalid fixture JSON');
  assert.equal((await client.call(f.prompt('sage mode'))).decision, 'block');
  const { readAdmission } = await import(pathToFileURL(join(f.plugin, 'core/index.mjs')));
  assert.equal(readAdmission(f.mode.directory).modes.length, 1);
  writeFileSync(bindings, saved);
  const restored = await client.call(f.prompt('sage mode'));
  assert.match(restored.hookSpecificOutput?.additionalContext, /sage_prepare_task/);
  assert.deepEqual(await client.call(f.prompt('sage mode')), restored);
  assert.equal(readAdmission(f.mode.directory).modes.length, 1);
  await client.close();
});


test('chief context refuses oversized rules and recovers all parts after repair', async t => {
  const f = fixture(t), client = await connect(t, f);
  const bindings = join(f.plugin, 'chief-bindings.json'), saved = readFileSync(bindings, 'utf8');
  for (const oversized of ['x'.repeat(8_000), 'Extra instruction.\n'.repeat(1_000)]) {
    writeFileSync(bindings, JSON.stringify({ ...JSON.parse(saved), TEAM: oversized }));
    for (const part of [0, 1])
      assert.equal((await client.call({ ...f.prompt('sage mode'), instruction_part: part })).decision, 'block');
  }
  writeFileSync(bindings, saved);
  for (const part of [0, 1]) {
    const restored = await client.call({ ...f.prompt('sage mode'), instruction_part: part });
    assert.ok(restored.hookSpecificOutput?.additionalContext);
    assert.equal((await client.call({ ...f.prompt('sage mode'), instruction_part: part }, childActor)).decision, 'block');
  }
  await client.close();
});

async function taskCreationFixture(t) {
  const f = await composedPolicyFixture(t);
  const projectDirectory = join(f.dir, 'project'); mkdirSync(projectDirectory);
  const env = { ...process.env, SAGE_HOME: join(f.dir, 'logbook') };
  const tool = f.core.createStateTool({ defaultRoot: () => { throw Error('No ambient logbook'); } });
  const cli = (...args) => tool.sage([...args, '--project', projectDirectory], env);
  cli('init'); mkdirSync(f.options.observationsRoot, { recursive: true });
  const options = { ...f.options, projectDirectory, logbookRoot: env.SAGE_HOME };
  const { createNativeTask } = await import(pathToFileURL(join(f.plugin, 'runtime/task-create.mjs')));
  const input = { request: turns[0], title: 'Native task request', size: 'small', risk: ['input'], add: ['ux-review'], why: 'Check the agreed experience' };
  const create = (data = input, actor = session) => createNativeTask(data, f.native(actor), options);
  const logbook = tool.storeDir(projectDirectory, env);
  return { ...f, options, env, tool, cli, logbook, input, create };
}

test('native task creation preserves core routes and retries across server connections', async t => {
  const f = await taskCreationFixture(t);
  const file = join(f.dir, 'task-config.json');
  writeFileSync(file, JSON.stringify({ version: 3, mode: f.options }));
  writeFileSync(f.entry, `import { serveConfiguredPreparations } from './plugin/runtime/configuration.mjs'; serveConfiguredPreparations(${JSON.stringify(file)});`);
  const firstClient = await connect(t, f, '0.160.0', '', 'sage_create_task');
  const first = await firstClient.call(f.input);
  assert.equal(first.decision, 'task-created'); assert.equal(first.task.id, 'T1');
  assert.equal(first.task.route, 'build,code-review,security-review,ux-review,qa');
  assert.equal(first.task.state, 'framed');
  await firstClient.close();
  const retry = await connect(t, f, '0.160.0', '', 'sage_create_task');
  assert.deepEqual(await retry.call(f.input), { ...first, decision: 'already-created' });
  assert.match((await retry.call({ ...f.input, title: 'conflicting reuse' })).error, /could not create/);
  assert.match((await retry.call(f.input, childActor)).error, /could not create/);
  assert.equal(f.tool.read(f.logbook, 'tasks').length, 1);
  assert.equal(f.tool.read(f.logbook, 'decisions').length, 1);
  assert.equal(f.tool.read(f.logbook, 'runs').length, 0);
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 0);
  await retry.close();
});

test('native task creation refuses foreign identity storage and invalid requests without changes', async t => {
  const f = await taskCreationFixture(t);
  const before = Object.fromEntries(readdirSync(f.logbook).filter(name => name.endsWith('.tsv')).map(name => [name, readFileSync(join(f.logbook, name), 'utf8')]));
  for (const input of [{ ...f.input, project: f.options.projectDirectory }, { ...f.input, owner: session },
    { ...f.input, request: '../outside' }, { ...f.input, size: ['small'] }, { ...f.input, title: '' },
    { ...f.input, title: 'hidden\ntext' }, { ...f.input, risk: ['unknown'] }, { ...f.input, add: ['build', 'build'] },
    { ...f.input, why: '' }, { ...f.input, size: 'investigate', add: ['build'] }]) assert.throws(() => f.create(input));
  assert.throws(() => f.create(f.input, childActor));
  assert.throws(() => f.create(f.input, turns[2]));
  const alias = join(f.dir, 'logbook-alias'); symlinkSync(f.options.logbookRoot, alias);
  const { createNativeTask } = await import(pathToFileURL(join(f.plugin, 'runtime/task-create.mjs')));
  assert.throws(() => createNativeTask(f.input, f.native(session), { ...f.options, logbookRoot: alias }));
  assert.deepEqual(Object.fromEntries(Object.keys(before).map(name => [name, readFileSync(join(f.logbook, name), 'utf8')])), before);
});

test('native task creation recovers partial publication and blocks unrelated writes until recovery', async t => {
  const f = await taskCreationFixture(t);
  const receipts = join(f.logbook, 'task-requests');
  const restore = await stopReviewWrite(t, f, 'decisions');
  assert.throws(() => f.create(), /Injected/);
  assert.equal(existsSync(join(f.logbook, 'review-pending.json')), true);
  assert.equal(f.tool.read(f.logbook, 'tasks').length, 1);
  assert.throws(() => f.cli('task', 'add', '--title', 'unrelated', '--size', 'tiny'), /incomplete/);
  assert.equal(f.tool.mergeCheck('1'.repeat(40), f.env).ok, false);
  assert.throws(() => f.create({ ...f.input, title: 'changed retry' }));
  restore();
  assert.equal(f.create().decision, 'task-created');
  assert.equal(f.create().decision, 'already-created');
  assert.equal(existsSync(join(f.logbook, 'review-pending.json')), false);
  assert.equal(f.tool.read(f.logbook, 'tasks').length, 1);
  assert.equal(f.tool.read(f.logbook, 'decisions').length, 1);
  assert.equal(readdirSync(receipts).length, 1);
});

test('native task creation refuses recovery after an unrelated partial-table edit', async t => {
  const f = await taskCreationFixture(t);
  const receipts = join(f.logbook, 'task-requests');
  const restore = await stopReviewWrite(t, f, 'decisions');
  assert.throws(() => f.create(), /Injected/); restore();
  appendFileSync(join(f.logbook, 'decisions.tsv'), 'changed outside the tool\n');
  assert.throws(() => f.create());
  assert.equal(existsSync(join(f.logbook, 'review-pending.json')), true);
  assert.equal(existsSync(receipts), false);
});

test('native task creation allows manual off-mode records without dispatch and serializes concurrent retries', async t => {
  const f = await taskCreationFixture(t);
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  const file = join(f.dir, 'task-config.json');
  writeFileSync(file, JSON.stringify({ version: 3, mode: f.options }));
  writeFileSync(f.entry, `import { serveConfiguredPreparations } from './plugin/runtime/configuration.mjs'; serveConfiguredPreparations(${JSON.stringify(file)});`);
  const clients = await Promise.all([connect(t, f, '0.160.0', '', 'sage_create_task'), connect(t, f, '0.160.0', '', 'sage_create_task')]);
  const outputs = await Promise.all(clients.map(client => client.call(f.input)));
  assert.deepEqual(outputs.map(out => out.decision).sort(), ['already-created', 'task-created']);
  assert.deepEqual(outputs[0].task, outputs[1].task);
  assert.equal(f.tool.read(f.logbook, 'tasks').length, 1);
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 0);
  await Promise.all(clients.map(client => client.close()));
});

async function runCreationFixture(t) {
  const f = await taskCreationFixture(t); f.create();
  const { createNativeRun } = await import(pathToFileURL(join(f.plugin, 'runtime/run-create.mjs')));
  const input = { request: turns[1], task: 'T1', role: 'lead', branch: '', candidate: '' };
  const createRun = (data = input, actor = session) => createNativeRun(data, f.native(actor), f.options);
  const file = join(f.dir, 'run-create-config.json');
  writeFileSync(file, JSON.stringify({ version: 3, mode: f.options }));
  writeFileSync(f.entry, `import { serveConfiguredPreparations } from './plugin/runtime/configuration.mjs'; serveConfiguredPreparations(${JSON.stringify(file)});`);
  return { ...f, input, createRun };
}

test('native run creation records one real task run and retries after reconnect without dispatch', async t => {
  const f = await runCreationFixture(t), before = f.core.readAdmission(f.options.directory);
  const client = await connect(t, f, '0.160.0', '', 'sage_create_run');
  const first = await client.call(f.input);
  assert.equal(first.decision, 'run-created'); assert.equal(first.run.id, 'R1');
  assert.equal(first.run.task, 'T1'); assert.equal(first.run.role, 'lead');
  assert.equal(first.run.round, '0'); assert.equal(first.run.status, 'running');
  assert.equal(first.run.model, ''); assert.match(first.run.started, /^\d{4}-\d\d-\d\dT/);
  await client.close();
  const retry = await connect(t, f, '0.160.0', '', 'sage_create_run');
  assert.deepEqual(await retry.call(f.input), { ...first, decision: 'already-created' });
  assert.match((await retry.call({ ...f.input, role: 'qa' })).error, /could not create/);
  assert.match((await retry.call(f.input, childActor)).error, /could not create/);
  assert.equal(f.tool.read(f.logbook, 'runs').length, 1);
  assert.equal(f.tool.read(f.logbook, 'tasks')[0].state, 'framed');
  assert.deepEqual(f.core.readAdmission(f.options.directory), before);
  await retry.close();
});

test('native run creation shares the CLI single-writer rule and never revives a completed run on retry', async t => {
  const f = await runCreationFixture(t);
  const input = { ...f.input, role: 'implementer', branch: 'codex/t1-build' };
  f.cli('run', 'add', 'T1', '--role', 'designer', '--branch', input.branch);
  assert.throws(() => f.createRun(input), /one writer/);
  assert.throws(() => f.createRun({ ...input, branch: '' }), /needs --branch/);
  f.cli('run', 'done', 'R1', '--status', 'done');
  const first = f.createRun(input); assert.equal(first.run.id, 'R2');
  assert.throws(() => f.cli('run', 'add', 'T1', '--role', 'implementer', '--branch', input.branch), /one writer/);
  f.cli('run', 'done', 'R2', '--status', 'done');
  assert.deepEqual(f.createRun(input), { ...first, decision: 'already-created' });
  assert.equal(f.tool.read(f.logbook, 'runs')[1].status, 'done');
  const next = f.createRun({ ...input, request: turns[2] }); assert.equal(next.run.id, 'R3');
  assert.equal(f.tool.read(f.logbook, 'runs').length, 3);
});

test('native run creation refuses missing tasks malformed fields and foreign owners without writes', async t => {
  const f = await runCreationFixture(t);
  for (const data of [{ ...f.input, task: 'T999' }, { ...f.input, task: '../other' }, { ...f.input, owner: session },
    { ...f.input, project: f.options.projectDirectory }, { ...f.input, model: 'inherit' }, { ...f.input, request: 'invalid' },
    { ...f.input, role: 'invalid role' }, { ...f.input, branch: 'invalid branch' }, { ...f.input, candidate: 'a\nb' },
    { ...f.input, candidate: 1 }]) assert.throws(() => f.createRun(data));
  assert.throws(() => f.createRun(f.input, childActor)); assert.throws(() => f.createRun(f.input, turns[2]));
  assert.equal(f.tool.read(f.logbook, 'runs').length, 0);
  assert.equal(existsSync(join(f.logbook, 'run-requests')), false);
});

test('native run creation recovers a written run whose receipt publication failed', async t => {
  const f = await runCreationFixture(t);
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const original = fs.linkSync;
  t.mock.method(fs, 'linkSync', (from, to) => {
    if (to.startsWith(join(f.logbook, 'run-requests') + '/')) throw Object.assign(Error('Injected run receipt failure'), { code: 'EIO' });
    return original(from, to);
  });
  syncBuiltinESMExports();
  const restore = () => { t.mock.restoreAll(); syncBuiltinESMExports(); }; t.after(restore);
  assert.throws(() => f.createRun(), /Injected/);
  assert.equal(f.tool.read(f.logbook, 'runs').length, 1);
  assert.equal(existsSync(join(f.logbook, 'review-pending.json')), true);
  assert.throws(() => f.cli('run', 'add', 'T1', '--role', 'qa'), /incomplete/);
  assert.equal(f.tool.mergeCheck('1'.repeat(40), f.env).ok, false);
  restore();
  assert.throws(() => f.createRun({ ...f.input, request: turns[2] }));
  assert.equal(f.createRun().decision, 'run-created'); assert.equal(f.createRun().decision, 'already-created');
  assert.equal(f.tool.read(f.logbook, 'runs').length, 1);
  assert.equal(existsSync(join(f.logbook, 'review-pending.json')), false);
});

test('native run creation preserves unrelated table edits after an interrupted run write', async t => {
  const f = await runCreationFixture(t);
  const restore = await stopReviewWrite(t, f, 'runs');
  assert.throws(() => f.createRun(), /Injected/); restore();
  assert.equal(f.tool.read(f.logbook, 'runs').length, 0);
  appendFileSync(join(f.logbook, 'runs.tsv'), 'unrelated change\n');
  assert.throws(() => f.createRun());
  assert.equal(existsSync(join(f.logbook, 'review-pending.json')), true);
  assert.equal(existsSync(join(f.logbook, 'run-requests')), false);
});

test('native run creation serializes competing writers while preserving manual off-mode records', async t => {
  const f = await runCreationFixture(t);
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  const clients = await Promise.all([connect(t, f, '0.160.0', '', 'sage_create_run'), connect(t, f, '0.160.0', '', 'sage_create_run')]);
  const input = { ...f.input, role: 'implementer', branch: 'codex/t1-build' };
  const outputs = await Promise.all(clients.map((client, index) => client.call({ ...input, request: turns[index + 1] })));
  assert.equal(outputs.filter(out => out.decision === 'run-created').length, 1);
  assert.equal(outputs.filter(out => /could not create/.test(out.error)).length, 1);
  assert.equal(f.tool.read(f.logbook, 'runs').length, 1);
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 0);
  await Promise.all(clients.map(client => client.close()));
});

async function taskUpdateFixture(t) {
  const f = await taskCreationFixture(t); f.create();
  const api = await import(pathToFileURL(join(f.plugin, 'runtime/task-update.mjs')));
  const read = (actor = session) => api.readNativeTask({ task: 'T1' }, f.native(actor), f.options);
  const update = (input, actor = session) => api.updateNativeTask(input, f.native(actor), f.options);
  const request = (changes, id = turns[1], version = read().version) => ({ request: id, task: 'T1', version, changes });
  const file = join(f.dir, 'task-update-config.json');
  writeFileSync(file, JSON.stringify({ version: 3, mode: f.options }));
  writeFileSync(f.entry, `import { serveConfiguredPreparations } from './plugin/runtime/configuration.mjs'; serveConfiguredPreparations(${JSON.stringify(file)});`);
  return { ...f, read, update, request };
}

test('native task updates read real versions and replay one transition without reverting later work', async t => {
  const f = await taskUpdateFixture(t);
  const reader = await connect(t, f, '0.160.0', '', 'sage_read_task');
  const before = await reader.call({ task: 'T1' });
  assert.equal(before.task.state, 'framed'); assert.match(before.version, /^[0-9a-f]{64}$/);
  assert.match((await reader.call({ task: 'T1' }, childActor)).error, /could not read/);
  await reader.close();
  const client = await connect(t, f, '0.160.0', '', 'sage_update_task');
  const input = f.request({ state: 'briefed', branch: 'codex/t1-update' }, turns[1], before.version);
  const first = await client.call(input); assert.equal(first.decision, 'task-updated');
  assert.equal(first.task.state, 'briefed'); assert.notEqual(first.version, before.version);
  assert.match((await client.call(input, childActor)).error, /could not update/);
  await client.close();
  const later = f.update(f.request({ state: 'building' }, turns[2]));
  const retry = await connect(t, f, '0.160.0', '', 'sage_update_task');
  assert.deepEqual(await retry.call(input), { ...first, decision: 'already-updated' });
  assert.deepEqual(f.read(), { task: later.task, version: later.version });
  assert.equal(f.tool.read(f.logbook, 'decisions').length, 3);
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 0);
  await retry.close();
});

test('native task updates refuse stale versions illegal states merges and invalid metadata', async t => {
  const f = await taskUpdateFixture(t), before = f.read();
  for (const changes of [{ state: 'verified' }, { state: 'merged' }, { state: 'repairing' }, { state: 'unknown' },
    { branch: 'codex/t99-other' }, { pr: '01' }, { title: 'line\nbreak' }, { risk: 'none' }, {}])
    assert.throws(() => f.update(f.request(changes)));
  assert.throws(() => f.update({ ...f.request({ state: 'briefed' }), owner: session }));
  assert.throws(() => f.update(f.request({ state: 'briefed' }), turns[2]));
  const input = f.request({ title: 'Updated title' }); f.update(input);
  assert.throws(() => f.update(f.request({ state: 'briefed' }, turns[2], before.version)));
  assert.throws(() => f.update({ ...input, changes: { title: 'Conflicting reuse' } }));
  assert.equal(f.read().task.state, 'framed'); assert.equal(f.read().task.title, 'Updated title');
});

test('native task updates preserve PR history and refuse progress through unanswered gates or findings', async t => {
  const f = await taskUpdateFixture(t);
  f.cli('gate', 'add', 'T1', '--question', 'Choose the design', '--options', 'One|Two', '--recommend', '1');
  assert.throws(() => f.update(f.request({ state: 'briefed' })), /unanswered gate/);
  f.cli('gate', 'answer', 'G1', '--option', '1');
  f.update(f.request({ state: 'briefed', pr: '7' }));
  f.update(f.request({ pr: '8' }, turns[2]));
  assert.equal(f.read().task.pr, '8');
  assert.deepEqual(f.tool.read(f.logbook, 'decisions').filter(row => row.decision.startsWith('PR ')).map(row => row.decision), ['PR none → 7', 'PR 7 → 8']);
  f.cli('task', 'T1', 'set', 'state=building'); f.cli('task', 'T1', 'set', 'state=reviewing');
  f.cli('finding', 'add', 'T1', '--source', 'qa', '--severity', 'high', '--summary', 'Unresolved fixture finding');
  assert.throws(() => f.update(f.request({ state: 'verifying' }, turns[0])), /open findings/);
  assert.equal(f.read().task.state, 'reviewing');
});

test('native task updates require configured cycles on the current commit before verified or pr-ready', async t => {
  const f = await taskUpdateFixture(t);
  const git = (...args) => f.tool.git(['-C', f.options.projectDirectory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@users.noreply.github.com', ...args], f.env).trim();
  git('init', '--quiet', '-b', 'codex/t1-update'); git('commit', '--quiet', '--allow-empty', '-m', 'fixture');
  const sha = git('rev-parse', 'HEAD');
  f.cli('task', 'T1', 'set', 'branch=codex/t1-update');
  for (const state of ['briefed', 'building', 'reviewing', 'verifying']) f.cli('task', 'T1', 'set', `state=${state}`);
  const kinds = ['checks-pass', 'review-clean', 'security-clean', 'ux-clean', 'qa-pass'];
  for (const kind of kinds) f.cli('verdict', 'T1', '--sha', sha, '--kind', kind, '--cycle', '1');
  const input = f.request({ state: 'verified' });
  assert.throws(() => f.update(input), /1 of 2 clean cycles/);
  for (const kind of kinds.slice(1)) f.cli('verdict', 'T1', '--sha', sha, '--kind', kind, '--cycle', '2');
  assert.equal(f.update(input).task.state, 'verified');
  assert.throws(() => f.update(f.request({ state: 'pr-ready' }, turns[2])), /pull request number/);
  git('commit', '--quiet', '--allow-empty', '-m', 'new head');
  assert.throws(() => f.update(f.request({ state: 'pr-ready', pr: '7' }, turns[2])), /not verified/);
  assert.throws(() => f.update(f.request({ title: 'Keep stale readiness' }, turns[2])), /not verified/);
  assert.equal(f.read().task.state, 'verified'); assert.equal(f.read().task.pr, '');
  const current = git('rev-parse', 'HEAD');
  for (const cycle of ['1', '2']) for (const kind of kinds) f.cli('verdict', 'T1', '--sha', current, '--kind', kind, '--cycle', cycle);
  assert.equal(f.update(f.request({ state: 'pr-ready', pr: '7' }, turns[2])).task.state, 'pr-ready');
});

test('native task updates recover partial writes without duplicate decisions and refuse unrelated edits', async t => {
  const f = await taskUpdateFixture(t), input = f.request({ state: 'briefed' });
  const restore = await stopReviewWrite(t, f, 'decisions');
  assert.throws(() => f.update(input), /Injected/);
  assert.equal(existsSync(join(f.logbook, 'review-pending.json')), true);
  assert.throws(() => f.read(), /incomplete/);
  assert.throws(() => f.cli('task', 'T1', 'set', 'title=unrelated'), /incomplete/);
  assert.equal(f.tool.mergeCheck('1'.repeat(40), f.env).ok, false);
  restore();
  assert.throws(() => f.update({ ...input, changes: { state: 'building' } }));
  const first = f.update(input); assert.equal(first.task.state, 'briefed');
  assert.deepEqual(f.update(input), { ...first, decision: 'already-updated' });
  assert.equal(f.tool.read(f.logbook, 'decisions').length, 2);
  const second = f.request({ state: 'building' }, turns[2]), restoreAgain = await stopReviewWrite(t, f, 'tasks');
  assert.throws(() => f.update(second), /Injected/); restoreAgain();
  appendFileSync(join(f.logbook, 'decisions.tsv'), 'unrelated edit\n');
  assert.throws(() => f.update(second));
  assert.equal(existsSync(join(f.logbook, 'review-pending.json')), true);
});

test('native task updates serialize conflicting changes and preserve off-mode owner access', async t => {
  const f = await taskUpdateFixture(t), version = f.read().version;
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  const clients = await Promise.all([connect(t, f, '0.160.0', '', 'sage_update_task'), connect(t, f, '0.160.0', '', 'sage_update_task')]);
  const outputs = await Promise.all(clients.map((client, index) => client.call(f.request({ title: `Choice ${index}` }, turns[index + 1], version))));
  assert.equal(outputs.filter(out => out.decision === 'task-updated').length, 1);
  assert.equal(outputs.filter(out => /could not update/.test(out.error)).length, 1);
  assert.equal(f.read().version, outputs.find(out => out.decision === 'task-updated').version);
  assert.equal(f.read().task.state, 'framed');
  await Promise.all(clients.map(client => client.close()));
});

function editAssignmentRows(f, table, change) {
  const file = join(f.assignmentLogbook, `${table}.tsv`), text = readFileSync(file, 'utf8');
  const lines = text.trimEnd().split('\n'), keys = lines.shift().split('\t');
  const rows = lines.map(line => Object.fromEntries(line.split('\t').map((value, index) => [keys[index], value])));
  const next = change(rows);
  writeFileSync(file, keys.join('\t') + '\n' + next.map(row => keys.map(key => row[key] ?? '').join('\t')).join('\n') + '\n');
  return () => writeFileSync(file, text);
}

test('native assignment preparation requires one actual matching active task and run', async t => {
  const f = await preparationServerFixture(t);
  for (const input of [{ ...f.input, task: 'T3' }, { ...f.input, run: 'R4' },
    { ...f.input, task: 'T2' }, { ...f.input, role: 'implementer' }])
    assert.throws(() => f.api.prepareNativeTask(input, f.native(session), f.options));
  for (const [table, field, value] of [
    ['runs', 'status', 'done'], ['runs', 'report', 'reports/saved.md'], ['runs', 'ended', '2026-01-01T00:00:00Z'],
    ['runs', 'round', '1'], ['runs', 'task', 'T2'], ['runs', 'role', 'qa'], ['runs', 'branch', 'codex/t1-other'],
    ['tasks', 'round', '-1'], ['tasks', 'round', '9007199254740992'], ['tasks', 'state', 'abandoned'],
    ['tasks', 'state', 'merged'], ['tasks', 'state', 'concluded'], ['tasks', 'state', 'unknown'], ['tasks', 'branch', 'codex/t2-foreign']]) {
    const restore = editAssignmentRows(f, table, rows => rows.map((row, index) => index ? row : { ...row, [field]: value }));
    assert.throws(() => f.api.prepareNativeTask(f.input, f.native(session), f.options), `${table}.${field}=${value}`);
    restore();
  }
  for (const table of ['tasks', 'runs']) for (const duplicate of [false, true]) {
    const restore = editAssignmentRows(f, table, rows => duplicate ? [...rows, rows[0]] : rows.slice(1));
    assert.throws(() => f.api.prepareNativeTask(f.input, f.native(session), f.options)); restore();
  }
  assert.equal(f.core.readAdmission(f.options.directory).preparations.length, 0);
  assert.equal(f.api.prepareNativeTask(f.input, f.native(session), f.options).decision, 'prepared');
});

test('native assignment dispatch rechecks records changed after preparation without taking capacity', async t => {
  const f = await preparationServerFixture(t);
  f.api.prepareNativeTask(f.input, f.native(session), f.options);
  for (const [table, field, value] of [['runs', 'status', 'failed'], ['runs', 'round', '1'],
    ['runs', 'branch', 'codex/t1-other'], ['tasks', 'state', 'abandoned'], ['runs', 'role', 'qa']]) {
    const restore = editAssignmentRows(f, table, rows => rows.map((row, index) => index ? row : { ...row, [field]: value }));
    assert.throws(() => f.api.reservePreparedSpawn(f.spawnInput(), f.native(session), f.options));
    assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 0); restore();
  }
  assert.equal(f.api.reservePreparedSpawn(f.spawnInput(), f.native(session), f.options).decision, 'permit-once');
});

test('native assignment checks cannot bypass missing aliased or pending logbooks', async t => {
  const f = await preparationServerFixture(t), alias = join(f.dir, 'assignment-alias');
  symlinkSync(f.options.logbookRoot, alias);
  for (const fixed of [{ ...f.options, logbookRoot: undefined }, { ...f.options, logbookRoot: alias },
    { ...f.options, projectDirectory: f.dir }])
    assert.throws(() => f.api.prepareNativeTask(f.input, f.native(session), fixed));
  const pending = join(f.assignmentLogbook, 'review-pending.json'); writeFileSync(pending, '{}');
  assert.throws(() => f.api.prepareNativeTask(f.input, f.native(session), f.options)); rmSync(pending);
  f.api.prepareNativeTask(f.input, f.native(session), f.options);
  writeFileSync(pending, '{}');
  assert.throws(() => f.api.reservePreparedSpawn(f.spawnInput(), f.native(session), f.options)); rmSync(pending);
  assert.throws(() => f.api.reservePreparedSpawn(f.spawnInput(), f.native(session), { ...f.options, logbookRoot: undefined }));
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 0);
});

test('shared assignment capture enforces writer ownership and leaves recorded work unchanged', async t => {
  const f = await preparationServerFixture(t);
  f.assignmentCli('run', 'add', 'T1', '--role', 'implementer', '--branch', 'codex/t1-fixture');
  const input = { project: f.options.projectDirectory, task: 'T1', run: 'R4', role: 'implementer' };
  const before = Object.fromEntries(['tasks', 'runs', 'decisions'].map(table => [table, readFileSync(join(f.assignmentLogbook, `${table}.tsv`), 'utf8')]));
  const captured = f.assignmentTool.captureRunAssignment(input, f.assignmentEnv);
  assert.deepEqual(captured, { task: 'T1', run: 'R4', role: 'implementer', round: 0,
    taskBranch: 'codex/t1-fixture', runBranch: 'codex/t1-fixture', candidate: '' });
  assert.deepEqual(Object.fromEntries(Object.keys(before).map(table => [table, readFileSync(join(f.assignmentLogbook, `${table}.tsv`), 'utf8')])), before);
  for (const change of [rows => rows.map(row => row.id === 'R4' ? { ...row, branch: '' } : row),
    rows => [...rows, { ...rows.at(-1), id: 'R5', role: 'designer' }]]) {
    const restore = editAssignmentRows(f, 'runs', change);
    assert.throws(() => f.assignmentTool.captureRunAssignment(input, f.assignmentEnv)); restore();
  }
  assert.throws(() => f.assignmentTool.captureRunAssignment({ ...input, role: '' }, f.assignmentEnv));
  assert.throws(() => f.assignmentTool.captureRunAssignment({ ...input, owner: session }, f.assignmentEnv));
});

test('native assignment server refuses invented work with a redacted error and no preparation', async t => {
  const f = await preparationServerFixture(t), client = await f.connectVisible();
  const result = await client.call({ ...f.input, run: 'R99' });
  assert.match(result.error, /Sage could not prepare this task/);
  assert.equal(result.error.includes(f.dir), false);
  assert.equal(f.core.readAdmission(f.options.directory).preparations.length, 0);
  assert.equal((await client.call(f.input)).decision, 'prepared');
  await client.close();
});

test('native run claims refuse a second prepared agent while preserving the first dispatch retry', async t => {
  const f = await preparationServerFixture(t);
  f.api.prepareNativeTask(f.input, f.native(session), f.options);
  f.api.prepareNativeTask({ ...f.input, name: 'duplicate_lead' }, f.native(session), f.options);
  const first = f.api.reservePreparedSpawn(f.spawnInput(), f.native(session), f.options);
  assert.throws(() => f.api.reservePreparedSpawn(f.spawnInput('duplicate_lead', 'spawn-duplicate'), f.native(session), f.options), /run already has a dispatch/);
  assert.deepEqual(f.api.reservePreparedSpawn(f.spawnInput(), f.native(session), f.options), { decision: 'already-reserved', assignment: first.assignment });
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 1);
  f.api.prepareNativeTask({ ...f.input, task: 'T2', run: 'R3', name: 'other_task' }, f.native(session), f.options);
  assert.equal(f.api.reservePreparedSpawn(f.spawnInput('other_task', 'spawn-other'), f.native(session), f.options).decision, 'permit-once');
});

async function foreignLeadWork(t) {
  const f = await preparationServerFixture(t); f.bindLead();
  f.assignmentCli('task', 'T2', 'set', 'branch=codex/t2-other');
  f.assignmentCli('run', 'add', 'T2', '--role', 'implementer', '--branch', 'codex/t2-other');
  const input = { ...f.input, task: 'T2', run: 'R4', role: 'implementer', name: 'foreign_builder' };
  assert.equal(f.assignmentTool.captureRunAssignment({ project: f.options.projectDirectory, task: input.task,
    run: input.run, role: input.role }, f.assignmentEnv).task, 'T2');
  return { ...f, foreign: input };
}

test('native lead ownership refuses valid work on another task at preparation', async t => {
  const f = await foreignLeadWork(t);
  assert.throws(() => f.api.prepareNativeTask(f.foreign, f.native(childActor), f.options), /could not verify/);
  const own = { ...f.input, name: 'own_qa', run: 'R2', role: 'qa', reviewCycle: 1 };
  assert.equal(f.api.prepareNativeTask(own, f.native(childActor), f.options).decision, 'prepared');
  assert.equal(f.core.readAdmission(f.options.directory).preparations.length, 2);
});

test('native lead ownership refuses an older foreign-task preparation at dispatch', async t => {
  const f = await foreignLeadWork(t);
  f.core.prepareAdmission(f.options.directory, f.scope,
    { task: f.foreign.task, run: f.foreign.run, name: f.foreign.name, issuer: childActor },
    { issuerRole: 'lead', role: 'implementer' }, f.input.brief);
  const spawn = { ...f.spawnInput(f.foreign.name, 'foreign-spawn'), turn_id: turns[1], transcript_path: f.childTranscript() };
  assert.throws(() => f.api.reservePreparedSpawn(spawn, f.native(childActor), f.options), /could not verify/);
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 1);
});

test('native lead ownership rechecks the parent run before preparing or dispatching children', async t => {
  const f = await preparationServerFixture(t); f.bindLead();
  const input = { ...f.input, run: 'R2', name: 'own_qa', role: 'qa', reviewCycle: 1 };
  f.api.prepareNativeTask(input, f.native(childActor), f.options);
  const spawn = { ...f.spawnInput(input.name, 'qa-spawn'), turn_id: turns[1], transcript_path: f.childTranscript() };
  for (const [field, value] of [['status', 'done'], ['round', '1'], ['role', 'qa'], ['task', 'T2'], ['report', 'reports/old.md']]) {
    const restore = editAssignmentRows(f, 'runs', rows => rows.map(row => row.id === 'R1' ? { ...row, [field]: value } : row));
    assert.throws(() => f.api.prepareNativeTask({ ...input, name: 'late_qa' }, f.native(childActor), f.options), field);
    assert.throws(() => f.api.reservePreparedSpawn(spawn, f.native(childActor), f.options), field);
    restore();
  }
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 1);
  assert.equal(f.api.reservePreparedSpawn(spawn, f.native(childActor), f.options).decision, 'permit-once');
});

async function roleEditFixture(t, role) {
  const f = await composedPolicyFixture(t);
  f.assignmentCli('run', 'add', 'T1', '--role', role,
    ...(['implementer', 'designer', 'arena-judge'].includes(role) ? ['--branch', 'codex/t1-fixture'] : []));
  Object.assign(f.input, { role, run: 'R4' });
  if (['code-reviewer', 'security-reviewer', 'ux-reviewer', 'qa'].includes(role)) f.input.reviewCycle = 1;
  f.api.prepareNativeTask(f.input, f.native(session), f.options);
  f.api.reservePreparedSpawn(f.spawnInput(), f.native(session), f.options);
  f.events.publish(join(f.options.observationsRoot, session), f.result);
  const input = { ...patch(turns[1]), tool_input: { command: '*** Begin Patch\n*** Add File: example.txt\n+fixed\n*** End Patch' }, transcript_path: f.childTranscript() };
  return { ...f, editInput: input };
}

test('native role edit enforcement denies read-only children before a permissive evaluator runs', async t => {
  for (const role of ['lead', 'pe', 'code-reviewer', 'security-reviewer', 'ux-reviewer', 'qa']) {
    const f = await roleEditFixture(t, role); let evaluated = 0;
    const policy = f.createNativePolicy(f.options, () => { evaluated++; return { decision: 'pass' }; });
    assert.match((await f.evaluate(policy, f.editInput, childActor)).reason, /role cannot edit files/);
    assert.equal(evaluated, 0, role);
    const saved = f.core.readAdmission(f.options.directory);
    assert.equal(saved.bindings[0].child, childActor);
    assert.equal(saved.reservations[0].rolePlan.role, role);
    await assert.rejects(policy.evaluate({ ...f.editInput, agent_id: childActor }, { ...f.native(childActor), role: 'implementer' }));
  }
});

test('native role edit context comes from the bound writer and keeps evaluator denials', async t => {
  for (const role of ['implementer', 'designer', 'arena-judge']) {
    const f = await roleEditFixture(t, role); let received;
    const policy = f.createNativePolicy(f.options, (input, context) => { received = context; return { decision: 'deny', reason: 'Further path check refused.' }; });
    assert.deepEqual(await f.evaluate(policy, f.editInput, childActor), { decision: 'deny', reason: 'Further path check refused.' });
    assert.equal(received.role, role); assert.equal(received.actor, childActor); assert.equal(received.sage, true);
    assert.equal(Object.isFrozen(received), true);
    const passing = f.createNativePolicy(f.options, () => ({ decision: 'pass' }));
    assert.deepEqual(await f.evaluate(passing, f.editInput, childActor), { decision: 'pass' });
  }
});

test('native role edit enforcement blocks the chief and restores ordinary evaluation when off', async t => {
  const f = await composedPolicyFixture(t); let received, evaluated = 0;
  const policy = f.createNativePolicy(f.options, (input, context) => { received = context; evaluated++; return { decision: 'pass' }; });
  assert.match((await f.evaluate(policy, patch())).reason, /role cannot edit files/);
  assert.equal(evaluated, 0);
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  assert.deepEqual(await f.evaluate(policy, patch(turns[2])), { decision: 'pass' });
  assert.equal(evaluated, 1); assert.equal(received.role, null); assert.equal(received.sage, false);
});


test('native current run refuses child tools after assignment or lifecycle changes', async t => {
  const f = await roleEditFixture(t, 'implementer'); let evaluated = 0;
  const policy = f.createNativePolicy(f.options, () => { evaluated++; return { decision: 'pass' }; });
  assert.deepEqual(await f.evaluate(policy, f.editInput, childActor), { decision: 'pass' });
  for (const [table, field, value] of [
    ['runs', 'status', 'done'], ['runs', 'ended', '2026-01-01T00:00:00Z'],
    ['runs', 'report', 'reports/saved.md'], ['runs', 'role', 'lead'], ['runs', 'task', 'T2'],
    ['runs', 'round', '1'], ['runs', 'branch', 'codex/t1-other'],
    ['tasks', 'round', '1'], ['tasks', 'state', 'abandoned'], ['tasks', 'state', 'concluded'],
  ]) {
    const calls = evaluated;
    const restore = editAssignmentRows(f, table, rows => rows.map(row => row.id === (table === 'runs' ? 'R4' : 'T1') ? { ...row, [field]: value } : row));
    await assert.rejects(f.evaluate(policy, f.editInput, childActor), /active run/, `${table}.${field}`);
    await assert.rejects(f.evaluate(policy, { ...f.editInput, tool_name: 'list_mcp_resources', tool_input: {} }, childActor), /active run/);
    assert.equal(evaluated, calls, `${table}.${field} reached the evaluator`);
    restore();
  }
  assert.deepEqual(await f.evaluate(policy, f.editInput, childActor), { decision: 'pass' });
  editAssignmentRows(f, 'runs', rows => rows.map(row => row.id === 'R4' ? { ...row, status: 'done' } : row));
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  assert.deepEqual(await f.evaluate(policy, f.editInput, childActor), { decision: 'pass' });
});

test('native current run refuses permission when the assignment changes during evaluation', async t => {
  for (const change of ['done', 'candidate', 'branch', 'round']) {
    const f = await roleEditFixture(t, 'implementer'); let entered, release;
    const pending = new Promise(resolve => { entered = resolve; });
    const continueEvaluation = new Promise(resolve => { release = resolve; });
    const policy = f.createNativePolicy(f.options, async () => { entered(); await continueEvaluation; return { decision: 'pass' }; });
    const result = f.evaluate(policy, f.editInput, childActor);
    await pending;
    if (change === 'done') editAssignmentRows(f, 'runs', rows => rows.map(row => row.id === 'R4' ? { ...row, status: 'done' } : row));
    if (change === 'candidate') editAssignmentRows(f, 'runs', rows => rows.map(row => row.id === 'R4' ? { ...row, candidate: 'changed' } : row));
    if (change === 'branch' || change === 'round') {
      const field = change, value = change === 'branch' ? 'codex/t1-other' : '1';
      editAssignmentRows(f, 'runs', rows => rows.map(row => row.id === 'R4' ? { ...row, [field]: value } : row));
      editAssignmentRows(f, 'tasks', rows => rows.map(row => row.id === 'T1' ? { ...row, [field]: value } : row));
    }
    release();
    await assert.rejects(result, /active run|could not evaluate/, change);
  }
});


test('native saved run target refuses a valid retarget before dispatch or child tools', async t => {
  for (const afterDispatch of [false, true]) for (const change of ['branch', 'round', 'candidate']) {
    const f = afterDispatch ? await roleEditFixture(t, 'implementer') : await preparationServerFixture(t);
    if (!afterDispatch) f.api.prepareNativeTask(f.input, f.native(session), f.options);
    const run = afterDispatch ? 'R4' : 'R1';
    const value = change === 'branch' ? 'codex/t1-other' : change === 'round' ? '1' : 'other';
    editAssignmentRows(f, 'runs', rows => rows.map(row => row.id === run ? { ...row, [change]: value } : row));
    if (change !== 'candidate') editAssignmentRows(f, 'tasks', rows => rows.map(row => row.id === 'T1' ? { ...row, [change]: value } : row));
    assert.equal(f.assignmentTool.captureRunAssignment({ project: f.options.projectDirectory, task: 'T1', run,
      role: afterDispatch ? 'implementer' : 'lead' }, f.assignmentEnv).run, run, 'the changed records are otherwise valid');
    if (afterDispatch) {
      let calls = 0;
      const policy = f.createNativePolicy(f.options, () => { calls++; return { decision: 'pass' }; });
      await assert.rejects(f.evaluate(policy, f.editInput, childActor), /saved run target changed/);
      assert.equal(calls, 0);
    } else {
      assert.throws(() => f.api.reservePreparedSpawn(f.spawnInput(), f.native(session), f.options), /saved run target changed/);
      assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 0);
    }
  }
});

test('native saved run target holds lead delegation and is delivered with the saved brief', async t => {
  const f = await preparationServerFixture(t); f.bindLead();
  const saved = f.core.readAdmission(f.options.directory).preparations[0];
  const receipt = f.api.prepareNativeTask(f.input, f.native(session), f.options);
  assert.match(receipt.message, /# Saved run target/);
  assert.match(receipt.message, /Task branch: codex\/t1-fixture/);
  assert.equal(saved.runTarget.round, 0);
  const child = { ...f.input, name: 'pinned_qa', run: 'R2', role: 'qa', reviewCycle: 1 };
  f.api.prepareNativeTask(child, f.native(childActor), f.options);
  editAssignmentRows(f, 'tasks', rows => rows.map(row => row.id === 'T1' ? { ...row, branch: 'codex/t1-other' } : row));
  assert.throws(() => f.api.prepareNativeTask({ ...child, name: 'late_qa' }, f.native(childActor), f.options), /saved run target changed/);
  const input = { ...f.spawnInput(child.name, 'qa-spawn'), turn_id: turns[1], transcript_path: f.childTranscript() };
  assert.throws(() => f.api.reservePreparedSpawn(input, f.native(childActor), f.options), /saved run target changed/);
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 1);
});

test('native saved run target refuses a legacy unpinned preparation without replacing it', async t => {
  const f = await preparationServerFixture(t);
  const saved = f.core.prepareAdmission(f.options.directory, f.scope,
    { task: f.input.task, run: f.input.run, issuer: session, name: f.input.name },
    { issuerRole: 'chief-of-staff', role: f.input.role }, f.input.brief).preparation;
  assert.equal(saved.runTarget, undefined);
  assert.throws(() => f.api.reservePreparedSpawn(f.spawnInput(), f.native(session), f.options), /saved run target changed/);
  assert.throws(() => f.api.prepareNativeTask(f.input, f.native(session), f.options), /different work/);
  assert.deepEqual(f.core.readAdmission(f.options.directory).preparations, [saved]);
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 0);
});


test('native shell role enforcement refuses known writes from each read-only child before evaluation', async t => {
  // These strings reach only the policy parser, never a real shell.
  for (const role of ['lead', 'pe', 'code-reviewer', 'security-reviewer', 'ux-reviewer', 'qa']) {
    const f = await roleEditFixture(t, role); let evaluated = 0;
    const policy = f.createNativePolicy(f.options, () => { evaluated++; return { decision: 'pass' }; });
    for (const command of ['printf fixed > example.txt', 'touch example.txt', 'rg --pre helper fixed', 'echo "']) {
      const { input } = commandPolicyInput(f, childActor, command);
      assert.match((await f.evaluate(policy, input, childActor)).reason, /role cannot edit files/, role);
      assert.equal(evaluated, 0, role);
    }
    const read = commandPolicyInput(f, childActor, 'cat example.txt');
    assert.deepEqual(await f.evaluate(policy, read.input, childActor), { decision: 'pass' });
    assert.equal(evaluated, 1);
  }
});

test('native shell role enforcement blocks the chief and preserves off-mode and writer policy checks', async t => {
  const f = await composedPolicyFixture(t); let evaluated = 0, received;
  const policy = f.createNativePolicy(f.options, (input, context) => {
    evaluated++; received = context; return { decision: 'deny', reason: 'Further command check refused.' };
  });
  const root = commandPolicyInput(f, session, 'printf fixed > example.txt');
  assert.match((await f.evaluate(policy, root.input)).reason, /role cannot edit files/);
  assert.equal(evaluated, 0);
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  const off = commandPolicyInput(f, session, 'printf fixed > example.txt', turns[2]);
  assert.deepEqual(await f.evaluate(policy, off.input), { decision: 'deny', reason: 'Further command check refused.' });
  assert.equal(evaluated, 1); assert.equal(received.role, null);
  for (const role of ['implementer', 'designer', 'arena-judge']) {
    const writer = await roleEditFixture(t, role); let calls = 0;
    const checked = writer.createNativePolicy(writer.options, (input, context) => {
      calls++; assert.equal(context.role, role);
      assert.equal(context.command.cmd, 'touch example.txt');
      return { decision: 'deny', reason: 'Further command check refused.' };
    });
    const command = commandPolicyInput(writer, childActor, 'touch example.txt');
    assert.deepEqual(await writer.evaluate(checked, command.input, childActor), { decision: 'deny', reason: 'Further command check refused.' });
    assert.equal(calls, 1);
  }
});

async function preparedFollowupFixture(t) {
  const f = await composedPolicyFixture(t); f.bindLead();
  const prior = f.core.readAdmission(f.options.directory).bindings[0];
  f.core.completeAdmission(f.options.directory, prior);
  f.assignmentCli('run', 'add', 'T1', '--role', 'lead');
  const request = { ...f.input, run: 'R4', name: 'continued_lead', previous: prior.assignment };
  const prepared = f.api.prepareNativeTask(request, f.native(session), f.options);
  const transcript = join(f.mode.sessionsDir, 'followup-parent.jsonl');
  const input = { hook_event_name: 'PreToolUse', session_id: session, turn_id: turns[0],
    tool_name: 'collaborationfollowup_task', tool_use_id: 'followup-1', transcript_path: transcript,
    tool_input: { target: prepared.target, message: prepared.message } };
  const rows = () => [
    { type: 'session_meta', payload: { id: session, session_id: session, cli_version: '0.160.0' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turns[0] } },
    { type: 'turn_context', payload: { turn_id: turns[0] } },
    { type: 'response_item', metadata: { client_authored: false }, payload: { type: 'function_call', namespace: 'collaboration',
      name: 'followup_task', call_id: input.tool_use_id, arguments: JSON.stringify(input.tool_input),
      internal_chat_message_metadata_passthrough: { turn_id: turns[0] } } },
  ];
  const save = value => writeFileSync(transcript, value.map(row => JSON.stringify(row) + '\n').join(''));
  save(rows());
  return { ...f, prior, request, prepared, followupInput: input, rows, save };
}

test('native follow-up preparation fixes the recipient and cannot dispatch as an initial spawn', async t => {
  const f = await preparedFollowupFixture(t);
  assert.equal(f.prepared.target, childActor); assert.equal(f.prepared.previous, f.prior.assignment);
  assert.equal(Object.hasOwn(f.prepared, 'fork_turns'), false);
  const state = f.core.readAdmission(f.options.directory);
  assert.equal(state.reservations.length, 1);
  assert.equal(state.preparations[1].continuation, f.prior.assignment);
  assert.equal(f.api.prepareNativeTask(f.request, f.native(session), f.options).preparation, f.prepared.preparation);
  assert.throws(() => f.api.reservePreparedSpawn(f.spawnInput(f.request.name, 'wrong-spawn'), f.native(session), f.options));
  const visible = await f.connectVisible();
  const response = await visible.call(f.request);
  assert.deepEqual(response, { ...f.prepared, decision: 'already-prepared' });
  await visible.close();
  for (const change of [{ previous: session }, { previous: 'invalid' }, { task: 'T2' }, { role: 'qa' }])
    assert.throws(() => f.api.prepareNativeTask({ ...f.request, ...change }, f.native(session), f.options));
});

test('native follow-up dispatch consumes exact prepared work once before permitting a callback-approved call', async t => {
  const f = await preparedFollowupFixture(t);
  const policy = f.createNativePolicy(f.options, () => ({ decision: 'pass' }));
  assert.deepEqual(await f.evaluate(policy, f.followupInput), { decision: 'pass' });
  const retry = await f.evaluate(policy, f.followupInput);
  assert.equal(retry.decision, 'deny'); assert.match(retry.reason, /already reserved/);
  const state = f.core.readAdmission(f.options.directory), saved = state.reservations[1];
  assert.equal(saved.continuation, f.prior.assignment); assert.equal(saved.assignment.run, 'R4');
  assert.equal(saved.preparation, f.prepared.preparation); assert.equal(state.bindings.length, 1);
  assert.equal(state.completions.length, 1);
  const observations = f.events.readObservations(join(f.options.observationsRoot, session));
  const evidence = observations.filter(row => row.kind === 'followup-transcript');
  assert.equal(evidence.length, 1); assert.equal(evidence[0].target, childActor);
  assert.equal(evidence[0].call, f.followupInput.tool_use_id);
});

test('native follow-up dispatch refuses changed fields stale runs and forged or finished calls without capacity', async t => {
  const f = await preparedFollowupFixture(t);
  const reserve = input => f.api.reservePreparedFollowup(input, f.native(session), f.options);
  for (const change of [{ target: session }, { target: '/root/fixture_lead' }, { message: 'replacement' }, { extra: true }])
    assert.throws(() => reserve({ ...f.followupInput, tool_input: { ...f.followupInput.tool_input, ...change } }));
  const restore = editAssignmentRows(f, 'runs', rows => rows.map(row => row.id === 'R4' ? { ...row, status: 'done' } : row));
  assert.throws(() => reserve(f.followupInput)); restore();
  for (const change of [rows => rows[0].payload.id = childActor, rows => rows[3].metadata.client_authored = true,
    rows => rows[3].payload.arguments = JSON.stringify({ ...f.followupInput.tool_input, message: 'replacement' }),
    rows => rows.push({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turns[0] } }),
    rows => rows.push({ type: 'response_item', metadata: { client_authored: false }, payload: { type: 'function_call_output',
      id: 'fco_done', call_id: 'followup-1', output: '', internal_chat_message_metadata_passthrough: { turn_id: turns[0] } } })]) {
    const rows = f.rows(); change(rows); f.save(rows); assert.throws(() => reserve(f.followupInput));
  }
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 1);
  f.save(f.rows()); assert.equal(reserve(f.followupInput).decision, 'permit-once');
});

test('native follow-up policy denies unprepared active-mode calls but retains ordinary off-mode checks', async t => {
  const f = await composedPolicyFixture(t);
  const input = { hook_event_name: 'PreToolUse', session_id: session, turn_id: turns[0],
    tool_name: 'collaborationfollowup_task', tool_use_id: 'unprepared-followup', tool_input: { target: childActor, message: 'unprepared' } };
  const policy = f.createNativePolicy(f.options, () => ({ decision: 'pass' }));
  const { mcpPreToolResult } = await import(pathToFileURL(join(f.plugin, 'runtime/mcp-policy.mjs')));
  const result = await mcpPreToolResult(JSON.stringify(input), f.native(session), async () => policy);
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse(result.content[0].text).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 0);
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  assert.deepEqual(await f.evaluate(policy, { ...input, turn_id: turns[2] }), { decision: 'pass' });
});

async function deliveredFollowupFixture(t) {
  const f = await preparedFollowupFixture(t);
  const transcript = f.childTranscript(); appendReport(f, reportText.replace('RESULT PASS', 'RESULT first'));
  f.events.publish(join(f.options.observationsRoot, session), { schema: 1, runtime: '0.160.0', session,
    kind: 'child-transcript', child: childActor, turn: turns[1], transcript });
  const policy = f.createNativePolicy(f.options, () => ({ decision: 'pass' }));
  assert.deepEqual(await f.evaluate(policy, f.followupInput), { decision: 'pass' });
  const accepted = [...f.rows(), { type: 'response_item', metadata: { client_authored: false }, payload: {
    type: 'function_call_output', id: 'fco_followup', call_id: 'followup-1', output: '',
    internal_chat_message_metadata_passthrough: { turn_id: turns[0] } } }];
  f.save(accepted);
  const later = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turns[2] } },
    { type: 'turn_context', payload: { turn_id: turns[2] } },
    { type: 'response_item', payload: { type: 'agent_message', id: 'amsg_later', author: '/root', recipient: '/root/fixture_lead',
      content: [{ type: 'encrypted_content', encrypted_content: f.prepared.message }] } },
  ];
  const before = readFileSync(transcript, 'utf8');
  const deliver = rows => writeFileSync(transcript, before + rows.map(row => JSON.stringify(row) + '\n').join(''));
  deliver(later);
  const input = { ...patch(turns[2]), tool_name: 'list_mcp_resources', tool_input: {}, transcript_path: transcript };
  const stop = { hook_event_name: 'SubagentStop', session_id: session, agent_id: childActor,
    turn_id: turns[2], transcript_path: f.followupInput.transcript_path, agent_transcript_path: transcript };
  return { ...f, policy, transcript, later, accepted, deliver, tool: input, stop };
}

test('native later turn binds exact follow-up once and retains the first assignment', async t => {
  const f = await deliveredFollowupFixture(t);
  assert.deepEqual(await f.evaluate(f.policy, f.tool, childActor), { decision: 'pass' });
  assert.deepEqual(await f.evaluate(f.policy, f.tool, childActor), { decision: 'pass' });
  const state = f.core.readAdmission(f.options.directory);
  assert.equal(state.bindings.length, 2); assert.equal(state.completions.length, 1);
  assert.deepEqual(state.bindings[0], f.prior);
  assert.equal(state.bindings[1].child, childActor); assert.equal(state.bindings[1].turn, turns[2]);
  assert.equal(state.bindings[1].assignment, state.reservations[1].assignment.id);
  const observations = f.events.readObservations(join(f.options.observationsRoot, session));
  assert.equal(observations.filter(row => row.kind === 'child-start').length, 1);
  assert.deepEqual(observations.filter(row => row.kind === 'child-transcript').map(row => row.turn).sort(), [turns[1], turns[2]].sort());
});

test('native later turn refuses pending or changed dispatch and changed delivery before binding', async t => {
  const f = await deliveredFollowupFixture(t);
  const attempt = () => f.evaluate(f.policy, f.tool, childActor);
  f.save(f.rows()); await assert.rejects(attempt());
  for (const mutate of [rows => rows[3].payload.arguments = JSON.stringify({ ...f.followupInput.tool_input, target: session }),
    rows => rows[4].metadata.client_authored = true]) {
    const changed = structuredClone(f.accepted); mutate(changed); f.save(changed); await assert.rejects(attempt());
  }
  f.save(f.accepted);
  for (const mutate of [rows => rows[2].payload.content[0].encrypted_content += '\nchanged',
    rows => rows[2].payload.recipient = '/root/other', rows => rows[2].payload.author = '/root/other']) {
    const changed = structuredClone(f.later); mutate(changed); f.deliver(changed); await assert.rejects(attempt());
  }
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 1);
  f.deliver(f.later); assert.deepEqual(await attempt(), { decision: 'pass' });
});

test('native later turn no-tool stop binds after Sage off and keeps reports separate', async t => {
  const f = await deliveredFollowupFixture(t);
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  assert.deepEqual(f.policy.completeChild(f.stop, f.native(childActor)), { decision: 'stop-observed' });
  assert.equal(f.core.readAdmission(f.options.directory).completions.length, 1);
  appendReport(f, reportText.replace('RESULT PASS', 'RESULT second'), childActor, turns[2]);
  assert.deepEqual(f.policy.completeChild(f.stop, f.native(childActor)), { decision: 'completed' });
  assert.deepEqual(f.policy.completeChild(f.stop, f.native(childActor)), { decision: 'already-completed' });
  const { readChildReport, recordChildReport } = await import(pathToFileURL(join(f.plugin, 'runtime/report-intake.mjs')));
  const first = readChildReport({ name: f.input.name }, f.native(session), f.options);
  const second = readChildReport({ name: f.request.name }, f.native(session), f.options);
  assert.equal(first.run, 'R1'); assert.equal(second.run, 'R4');
  assert.equal(first.report.RESULT, 'first'); assert.equal(second.report.RESULT, 'second');
  assert.notEqual(first.assignment, second.assignment); assert.notEqual(first.turn, second.turn);
  for (const [name, report] of [[f.input.name, first], [f.request.name, second]])
    assert.equal(recordChildReport({ name, reportHash: report.reportHash }, f.native(session), f.options).decision, 'report-recorded');
  assert.equal(f.core.readAdmission(f.options.directory).reports.length, 2);
});

test('native later turn old stop cannot release new work and parent reconciliation completes only its turn', async t => {
  const f = await deliveredFollowupFixture(t);
  await f.evaluate(f.policy, f.tool, childActor);
  assert.deepEqual(f.policy.completeChild({ ...f.stop, turn_id: turns[1] }, f.native(childActor)), { decision: 'already-completed' });
  assert.equal(f.core.readAdmission(f.options.directory).completions.length, 1);
  assert.deepEqual(f.policy.completeChild(f.stop, f.native(childActor)), { decision: 'stop-observed' });
  const { reconcileNativeCompletions } = await import(pathToFileURL(join(f.plugin, 'runtime/child-stop.mjs')));
  reconcileNativeCompletions(f.native(session), session, f.options);
  assert.equal(f.core.readAdmission(f.options.directory).completions.length, 1);
  appendReport(f, reportText, childActor, turns[2]);
  reconcileNativeCompletions(f.native(session), session, f.options);
  const state = f.core.readAdmission(f.options.directory);
  assert.equal(state.completions.length, 2); assert.deepEqual(state.completions[1], state.bindings[1]);
  await assert.rejects(f.evaluate(f.policy, f.tool, childActor));
});

test('native later turn lead can prepare its team under the new run and loses access on completion', async t => {
  const f = await deliveredFollowupFixture(t);
  await f.evaluate(f.policy, f.tool, childActor);
  const input = { ...f.input, name: 'later_qa', role: 'qa', run: 'R2', reviewCycle: 1 };
  const saved = f.api.prepareNativeTask(input, f.native(childActor), f.options);
  assert.equal(saved.role, 'qa'); assert.equal(saved.task, 'T1');
  const restore = editAssignmentRows(f, 'runs', rows => rows.map(row => row.id === 'R4' ? { ...row, status: 'done' } : row));
  assert.throws(() => f.api.prepareNativeTask({ ...input, name: 'ended_lead_qa' }, f.native(childActor), f.options));
  restore();
  appendReport(f, reportText, childActor, turns[2]);
  f.policy.completeChild(f.stop, f.native(childActor));
  assert.throws(() => f.api.prepareNativeTask({ ...input, name: 'completed_lead_qa' }, f.native(childActor), f.options));
});

test('native later turn refuses a superseded recipient turn before binding', async t => {
  const f = await deliveredFollowupFixture(t);
  const laterTurn = 'a1111111-2222-4333-8444-555555555555';
  f.deliver([...f.later,
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: turns[2] } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: laterTurn } },
    { type: 'turn_context', payload: { turn_id: laterTurn } },
  ]);
  await assert.rejects(f.evaluate(f.policy, f.tool, childActor));
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 1);
  f.deliver(f.later);
  assert.deepEqual(await f.evaluate(f.policy, f.tool, childActor), { decision: 'pass' });
});

test('native missed-stop recovery completes a bound child once from its parent even after Sage off', async t => {
  for (const off of [false, true]) {
    const f = await completionFixture(t);
    if (off) f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
    appendReport(f);
    const { readChildReport } = await import(pathToFileURL(join(f.plugin, 'runtime/report-intake.mjs')));
    const report = readChildReport({ name: f.input.name }, f.native(session), f.options);
    assert.equal(report.decision, 'report-ready'); assert.equal(report.run, 'R1');
    const state = f.core.readAdmission(f.options.directory);
    assert.equal(state.completions.length, 1); assert.deepEqual(state.completions[0], state.bindings[0]);
    assert.deepEqual(readChildReport({ name: f.input.name }, f.native(session), f.options), report);
    assert.deepEqual(f.core.readAdmission(f.options.directory), state);
    assert.equal(f.events.readObservations(join(f.options.observationsRoot, session)).filter(row => row.kind === 'child-stop').length, 0);
  }
});

test('native missed-stop recovery keeps later work until its own terminal record and preserves parent ownership', async t => {
  const f = await deliveredFollowupFixture(t);
  await f.evaluate(f.policy, f.tool, childActor);
  f.events.publish(join(f.options.observationsRoot, session), { schema: 1, runtime: '0.160.0', session,
    kind: 'child-stop', child: childActor, turn: turns[1] });
  const { reconcileNativeCompletions } = await import(pathToFileURL(join(f.plugin, 'runtime/child-stop.mjs')));
  const reconcile = actor => reconcileNativeCompletions(f.native(actor), session, f.options);
  reconcile(session); assert.equal(f.core.readAdmission(f.options.directory).completions.length, 1);
  appendReport(f, reportText, childActor, turns[2]);
  for (const actor of [childActor, 'a1111111-2222-4333-8444-555555555555']) {
    reconcile(actor); assert.equal(f.core.readAdmission(f.options.directory).completions.length, 1);
  }
  reconcile(session);
  const state = f.core.readAdmission(f.options.directory);
  assert.equal(state.completions.length, 2); assert.deepEqual(state.completions[1], state.bindings[1]);
  reconcile(session); assert.deepEqual(f.core.readAdmission(f.options.directory), state);
  const stops = f.events.readObservations(join(f.options.observationsRoot, session)).filter(row => row.kind === 'child-stop');
  assert.deepEqual(stops.map(row => row.turn), [turns[1]]);
});

test('native missed-stop recovery refuses altered completion evidence without releasing capacity', async t => {
  const f = await completionFixture(t);
  appendReport(f);
  const transcript = join(f.mode.sessionsDir, `${childActor}.jsonl`);
  const original = readFileSync(transcript, 'utf8');
  const { reconcileNativeCompletions } = await import(pathToFileURL(join(f.plugin, 'runtime/child-stop.mjs')));
  const reconcile = () => reconcileNativeCompletions(f.native(session), session, f.options);
  const save = rows => writeFileSync(transcript, rows.map(row => JSON.stringify(row) + '\n').join(''));
  for (const change of [rows => rows[0].payload.id = session,
    rows => rows.at(-2).metadata.client_authored = true,
    rows => rows.at(-1).payload.last_agent_message = 'changed terminal result',
    rows => rows.at(-1).payload.turn_id = turns[2]]) {
    const rows = original.trimEnd().split('\n').map(JSON.parse); change(rows); save(rows);
    assert.throws(reconcile); assert.equal(f.core.readAdmission(f.options.directory).completions?.length ?? 0, 0);
  }
  const rows = original.trimEnd().split('\n').map(JSON.parse); rows.pop(); save(rows);
  reconcile(); assert.equal(f.core.readAdmission(f.options.directory).completions?.length ?? 0, 0);
  writeFileSync(transcript, original); reconcile();
  assert.equal(f.core.readAdmission(f.options.directory).completions.length, 1);
});

test('native missed-stop recovery waits for initial binding evidence before requiring a transcript', async t => {
  const f = await composedPolicyFixture(t); f.bindLead();
  const { reconcileNativeCompletions } = await import(pathToFileURL(join(f.plugin, 'runtime/child-stop.mjs')));
  const reconcile = () => reconcileNativeCompletions(f.native(session), session, f.options);
  assert.deepEqual(reconcile(), { decision: 'reconciled' });
  assert.equal(f.core.readAdmission(f.options.directory).completions?.length ?? 0, 0);
  const policy = f.createNativePolicy(f.options, () => ({ decision: 'pass' }));
  await f.evaluate(policy, { ...patch(turns[1]), tool_name: 'list_mcp_resources', tool_input: {}, transcript_path: f.childTranscript() }, childActor);
  appendReport(f); reconcile();
  assert.equal(f.core.readAdmission(f.options.directory).completions.length, 1);
});


test('resumed lead failure recovery keeps assignment history and verifies the original identity', async t => {
  for (const off of [false, true]) {
    const f = await deliveredFollowupFixture(t);
    await f.evaluate(f.policy, f.tool, childActor);
    const request = { ...f.input, name: 'resumed_failed_qa', run: 'R2', role: 'qa', reviewCycle: 1 };
    f.api.prepareNativeTask(request, f.native(childActor), f.options);
    const spawn = { ...f.spawnInput(request.name, 'resumed-failed-qa'), turn_id: turns[2], transcript_path: f.transcript };
    spawn.tool_input.model = 'missing-fixture-model';
    f.api.reservePreparedSpawn(spawn, f.native(childActor), f.options);
    appendFileSync(f.transcript, failedCallRows(spawn).map(row => JSON.stringify(row) + '\n').join(''));
    if (off) {
      appendReport(f, reportText, childActor, turns[2]);
      f.policy.completeChild(f.stop, f.native(childActor));
      f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
    }
    const event = { ...postSpawn(), turn_id: turns[2], tool_name: 'collaborationwait_agent', tool_input: {}, tool_response: '', transcript_path: f.transcript };
    const before = f.core.readAdmission(f.options.directory);
    f.policy.reconcileCompletions(event, f.native(session));
    assert.deepEqual(f.core.readAdmission(f.options.directory), before);
    const original = readFileSync(f.transcript, 'utf8');
    const changed = original.trimEnd().split('\n').map(JSON.parse);
    changed[0].payload.parent_thread_id = 'a1111111-2222-4333-8444-555555555555';
    writeFileSync(f.transcript, changed.map(row => JSON.stringify(row) + '\n').join(''));
    assert.throws(() => f.policy.reconcileCompletions(event, f.native(childActor)));
    assert.deepEqual(f.core.readAdmission(f.options.directory), before);
    writeFileSync(f.transcript, original);
    f.policy.reconcileCompletions(event, f.native(childActor));
    const state = f.core.readAdmission(f.options.directory);
    assert.equal(state.failures.length, 1); assert.equal(state.failures[0].issuer, childActor);
    assert.equal(state.failures[0].assignment, state.reservations.find(row => row.assignment.run === 'R2').assignment.id);
    assert.deepEqual(state.bindings, before.bindings); assert.deepEqual(state.completions, before.completions);
    assert.deepEqual(state.reservations, before.reservations);
    f.policy.reconcileCompletions(event, f.native(childActor));
    assert.deepEqual(f.core.readAdmission(f.options.directory), state);
  }
});


test('native unobserved follow-up recovery binds and completes exact work once even after Sage off', async t => {
  for (const off of [false, true]) {
    const f = await deliveredFollowupFixture(t);
    if (off) f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
    appendReport(f, reportText, childActor, turns[2]);
    const { readChildReport } = await import(pathToFileURL(join(f.plugin, 'runtime/report-intake.mjs')));
    const report = readChildReport({ name: f.request.name }, f.native(session), f.options);
    assert.equal(report.run, 'R4'); assert.equal(report.turn, turns[2]);
    const state = f.core.readAdmission(f.options.directory);
    assert.equal(state.bindings.length, 2); assert.equal(state.completions.length, 2);
    assert.deepEqual(state.completions[1], state.bindings[1]); assert.deepEqual(state.bindings[0], f.prior);
    assert.deepEqual(readChildReport({ name: f.request.name }, f.native(session), f.options), report);
    assert.deepEqual(f.core.readAdmission(f.options.directory), state);
    assert.equal(f.events.readObservations(join(f.options.observationsRoot, session)).filter(row => row.kind === 'child-stop').length, 0);
  }
});

test('native unobserved follow-up recovery waits for delivery and terminal evidence without trusting another actor', async t => {
  const f = await deliveredFollowupFixture(t);
  const { reconcileNativeCompletions } = await import(pathToFileURL(join(f.plugin, 'runtime/child-stop.mjs')));
  const recover = actor => reconcileNativeCompletions(f.native(actor), session, f.options);
  const before = f.core.readAdmission(f.options.directory);
  f.deliver([]); recover(session); assert.deepEqual(f.core.readAdmission(f.options.directory), before);
  f.deliver(f.later);
  for (const actor of [childActor, 'a1111111-2222-4333-8444-555555555555']) {
    recover(actor); assert.deepEqual(f.core.readAdmission(f.options.directory), before);
  }
  recover(session);
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 2);
  assert.equal(f.core.readAdmission(f.options.directory).completions.length, 1);
  appendReport(f, reportText, childActor, turns[2]); recover(session);
  assert.equal(f.core.readAdmission(f.options.directory).completions.length, 2);
});

test('native unobserved follow-up recovery refuses ambiguous stale forged and unaccepted delivery', async t => {
  const f = await deliveredFollowupFixture(t);
  const { reconcileNativeCompletions } = await import(pathToFileURL(join(f.plugin, 'runtime/child-stop.mjs')));
  const recover = () => reconcileNativeCompletions(f.native(session), session, f.options);
  const before = f.core.readAdmission(f.options.directory);
  f.save(f.rows()); assert.throws(recover); assert.deepEqual(f.core.readAdmission(f.options.directory), before);
  f.save(f.accepted);
  for (const mutate of [rows => rows.push(structuredClone(rows[2])),
    rows => rows[2].payload.author = '/root/other', rows => rows[2].payload.recipient = '/root/other',
    rows => rows.push({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'a1111111-2222-4333-8444-555555555555' } })]) {
    const changed = structuredClone(f.later); mutate(changed); f.deliver(changed);
    assert.throws(recover); assert.deepEqual(f.core.readAdmission(f.options.directory), before);
  }
  f.deliver(f.later);
  const original = readFileSync(f.transcript, 'utf8');
  const rows = original.trimEnd().split('\n').map(JSON.parse); rows[0].payload.id = session;
  writeFileSync(f.transcript, rows.map(row => JSON.stringify(row) + '\n').join(''));
  assert.throws(recover); assert.deepEqual(f.core.readAdmission(f.options.directory), before);
  writeFileSync(f.transcript, original); recover();
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 2);
});

test('native unobserved follow-up recovery repairs interrupted transcript publication', async t => {
  const f = await deliveredFollowupFixture(t);
  const assigned = f.core.readAdmission(f.options.directory).reservations[1].assignment;
  f.core.bindContinuationAdmission(f.options.directory, { project: assigned.project, session: assigned.session,
    epoch: assigned.epoch, assignment: assigned.id, issuer: session, call: assigned.call, child: childActor, turn: turns[2] });
  appendReport(f, reportText, childActor, turns[2]);
  const { readChildReport } = await import(pathToFileURL(join(f.plugin, 'runtime/report-intake.mjs')));
  const report = readChildReport({ name: f.request.name }, f.native(session), f.options);
  assert.equal(report.run, 'R4'); assert.equal(report.turn, turns[2]);
  const state = f.core.readAdmission(f.options.directory);
  assert.equal(state.bindings.length, 2); assert.equal(state.completions.length, 2);
  assert.deepEqual(readChildReport({ name: f.request.name }, f.native(session), f.options), report);
  assert.deepEqual(f.core.readAdmission(f.options.directory), state);
});

function appendInterruption(f, turn = turns[1], reason = 'interrupted') {
  appendFileSync(join(f.mode.sessionsDir, `${childActor}.jsonl`), JSON.stringify({ type: 'event_msg',
    payload: { type: 'turn_aborted', turn_id: turn, reason } }) + '\n');
}
test('native interruption recovery records one terminal outcome without a report or successful run', async t => {
  const f = await completionFixture(t);
  const before = f.core.readAdmission(f.options.directory);
  appendInterruption(f);
  const { reconcileNativeCompletions } = await import(pathToFileURL(join(f.plugin, 'runtime/child-stop.mjs')));
  const reconcile = actor => reconcileNativeCompletions(f.native(actor), session, f.options);
  reconcile(childActor); assert.equal(f.core.readAdmission(f.options.directory).completions?.length ?? 0, 0);
  reconcile(session);
  const state = f.core.readAdmission(f.options.directory), ended = state.completions[0];
  assert.equal(state.completions.length, 1);
  assert.deepEqual({ ...ended, outcome: undefined, evidenceHash: undefined }, { ...before.bindings[0], outcome: undefined, evidenceHash: undefined });
  assert.equal(ended.outcome, 'interrupted'); assert.match(ended.evidenceHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(state.reservations, before.reservations); assert.deepEqual(state.reports, before.reports);
  reconcile(session); assert.deepEqual(f.core.readAdmission(f.options.directory), state);
  const { readChildReport } = await import(pathToFileURL(join(f.plugin, 'runtime/report-intake.mjs')));
  assert.throws(() => readChildReport({ name: f.input.name }, f.native(session), f.options));
  assert.throws(() => f.core.completeAdmission(f.options.directory, before.bindings[0]));
  assert.throws(() => f.core.interruptAdmission(f.options.directory, before.bindings[0], '0'.repeat(64)));
  assert.deepEqual(f.core.readAdmission(f.options.directory), state);
});
test('native interruption recovery refuses wrong turns and conflicting terminal records', async t => {
  const f = await completionFixture(t), file = join(f.mode.sessionsDir, `${childActor}.jsonl`);
  const before = readFileSync(file, 'utf8');
  const { reconcileNativeCompletions } = await import(pathToFileURL(join(f.plugin, 'runtime/child-stop.mjs')));
  const reconcile = () => reconcileNativeCompletions(f.native(session), session, f.options);
  for (const [turn, reason] of [[turns[2], 'interrupted'], [turns[1], 'replaced']]) {
    writeFileSync(file, before); appendInterruption(f, turn, reason);
    assert.throws(reconcile); assert.equal(f.core.readAdmission(f.options.directory).completions?.length ?? 0, 0);
  }
  for (const abortFirst of [true, false]) {
    writeFileSync(file, before);
    if (abortFirst) appendInterruption(f);
    appendReport(f);
    if (!abortFirst) appendInterruption(f);
    assert.throws(reconcile); assert.equal(f.core.readAdmission(f.options.directory).completions?.length ?? 0, 0);
  }
});
test('native interruption recovery after off frees only its exact later assignment', async t => {
  const f = await deliveredFollowupFixture(t);
  await f.evaluate(f.policy, f.tool, childActor);
  appendInterruption(f, turns[2]);
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: 'a1111111-2222-4333-8444-555555555555', sage: false });
  const { reconcileNativeCompletions } = await import(pathToFileURL(join(f.plugin, 'runtime/child-stop.mjs')));
  reconcileNativeCompletions(f.native(session), session, f.options);
  const state = f.core.readAdmission(f.options.directory);
  assert.equal(state.completions.length, 2);
  assert.deepEqual(state.completions[0], state.bindings[0]);
  assert.equal(state.completions[1].assignment, state.bindings[1].assignment);
  assert.equal(state.completions[1].outcome, 'interrupted');
  assert.throws(() => f.api.prepareNativeTask({ ...f.input, name: 'interrupted_lead_qa', role: 'qa', reviewCycle: 1 }, f.native(childActor), f.options));
  assert.equal(state.modes.at(-1).sage, false);
});
test('native interruption recovery releases capacity once and stale evidence cannot release a new child', async t => {
  const f = await completionFixture(t), directory = join(f.mode.sessionsDir, 'capacity-store');
  f.core.configureAdmission(directory, { total: 1, projects: [{ project: 'fixture', limit: 1 }] });
  const owner = f.core.activateAdmission(directory, { project: 'fixture', session: `codex:${session}`, activation: turns[0] });
  const scope = { project: owner.project, session: owner.session, epoch: owner.epoch };
  const reserve = call => f.core.reserveRoleAdmission(directory, scope, { task: `T${['first', 'second', 'third'].indexOf(call) + 1}`, run: `R${['first', 'second', 'third'].indexOf(call) + 1}`, issuer: session, call },
    { tool: 'spawn_agent', turn: turns[0], name: call, argumentsHash: '0'.repeat(64) }, { issuerRole: 'chief-of-staff', role: 'lead' });
  const first = reserve('first').assignment;
  const bound = { ...scope, assignment: first.id, issuer: session, call: 'first', child: childActor, turn: turns[1] };
  f.core.bindAdmission(directory, bound);
  assert.throws(() => reserve('second'), /capacity/);
  assert.throws(() => f.core.interruptAdmission(directory, { ...bound, turn: turns[2] }, '1'.repeat(64)));
  assert.throws(() => reserve('second'), /capacity/);
  f.core.interruptAdmission(directory, bound, '1'.repeat(64));
  const second = reserve('second'); assert.equal(second.decision, 'permit-once');
  assert.equal(f.core.interruptAdmission(directory, bound, '1'.repeat(64)).decision, 'already-completed');
  assert.throws(() => reserve('third'), /capacity/);
  assert.equal(f.core.readAdmission(directory).completions.length, 1);
});
