import "./fixtures/codex-native/nested-report.test.mjs";
import "./fixtures/codex-native/restart-child.test.mjs";
import { createHash } from "node:crypto";
import "./test-env.mjs";
import "./fixtures/codex-native/restart-rpc.test.mjs";
import "./fixtures/codex-native/restart-evidence.test.mjs";
import "./fixtures/codex-native/restart-cleanup.test.mjs";
import "./fixtures/codex-native/restart-result.test.mjs";
import "./fixtures/codex-native/restart-binary.test.mjs";
import assert from "node:assert/strict";
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
    ? ["sage_native_hook"] : ["sage_accept_review", "sage_create_run", "sage_create_task", "sage_finish_run", "sage_prepare_task", "sage_read_assignment", "sage_read_recorded_report", "sage_read_report", "sage_read_task", "sage_record_report", "sage_update_task"]);
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
    const promptOutput = await client.call(f.prompt(text, turns[index]));
    if (index === 0) assert.match(promptOutput.hookSpecificOutput?.additionalContext, /Sage chief instructions/);
    else assert.deepEqual(promptOutput, {});
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
  assert.match((await client.call(f.prompt("sage mode"))).hookSpecificOutput?.additionalContext, /Sage chief instructions/);
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
  assert.match((await repaired.call(f.prompt("sage mode"))).hookSpecificOutput?.additionalContext, /Sage chief instructions/);
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

function assignmentLogbookFixture(core, options) {
  mkdirSync(options.projectDirectory, { recursive: true }); mkdirSync(options.observationsRoot, { recursive: true });
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
  return { assignmentTool, assignmentEnv, assignmentCli, assignmentLogbook };
}

async function preparationServerFixture(t) {
  const f = fixture(t);
  assert.ok(existsSync(join(f.plugin, "runtime/preparation-server.mjs")), "the separate preparation server must ship");
  const core = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
  const events = await import(pathToFileURL(join(f.plugin, "runtime/events.mjs")));
  const api = await import(pathToFileURL(join(f.plugin, "runtime/preparation.mjs")));
  const options = { directory: f.mode.directory, project: f.mode.project, sessionsDir: f.mode.sessionsDir, observationsRoot: join(f.dir, "observations"),
    projectDirectory: join(f.dir, "assignment-project"), logbookRoot: join(f.dir, "assignment-logbook") };
  const { assignmentTool, assignmentEnv, assignmentCli, assignmentLogbook } = assignmentLogbookFixture(core, options);
  core.configureAdmission(options.directory, { total: 5, projects: [{ project: options.project, limit: 5 }] });
  const owner = core.activateAdmission(options.directory, { project: options.project, session: `codex:${session}`, activation: turns[0] });
  const scope = { project: owner.project, session: owner.session, epoch: owner.epoch };
  writeFileSync(f.entry, `import { servePreparations } from './plugin/runtime/preparation-server.mjs'; servePreparations(${JSON.stringify(options)});`);
  const brief = Object.fromEntries(["GOAL", "SCOPE", "CONTEXT", "DECISIONS", "ACCEPTANCE", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"].map(key => [key, "Complete the fixture task."]));
  const input = { task: "T1", run: "R1", name: "fixture_lead", role: "lead", brief };
  const native = actor => ({ version: "0.160.0", actor });
  const { preparedTaskMessage: renderMessage } = await import(pathToFileURL(join(f.plugin, "runtime/instructions.mjs")));
  const spawnInput = (name = input.name, call = "spawn-1") => ({ hook_event_name: "PreToolUse", session_id: session,
    turn_id: turns[0], tool_name: "collaborationspawn_agent", tool_use_id: call, tool_input: { task_name: name, fork_turns: "none", message: (() => {
      const saved = core.readAdmission(options.directory).preparations.find(row => row.name === name);
      return saved && renderMessage ? renderMessage(saved) : "opaque native input";
    })() } });
  const childTranscript = ({ child = childActor, parent = session, path = "/root/fixture_lead", turn = turns[1], message } = {}) => {
    const preparation = core.readAdmission(options.directory).preparations.find(row => row.name === path.split("/").at(-1));
    const transcript = join(f.mode.sessionsDir, `${child}.jsonl`);
    writeFileSync(transcript, [
      { type: "session_meta", payload: { id: child, session_id: session, parent_thread_id: parent, agent_path: path, cli_version: "0.160.0" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: turn } },
      { type: "turn_context", payload: { turn_id: turn } },
      { type: "response_item", payload: { type: "agent_message", id: `amsg_${turn}`, author: path.slice(0, path.lastIndexOf("/")),
        recipient: path, content: [{ type: "encrypted_content", encrypted_content: message ?? renderMessage(preparation) }] } },
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
  assert.deepEqual(readdirSync(f.options.observationsRoot), [], "fixed observation directory remains empty");
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
  const task = { ...f.input, run: "R2", name: "qa_child", role: "qa", reviewCycle: 1 };
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
  assert.doesNotMatch(JSON.stringify(observed), /opaque native input/);
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

async function sharedConfiguration(t, recorded = false) {
  const f = await configured(t);
  const observationsRoot = join(f.dir, "observations"); mkdirSync(observationsRoot);
  const config = { version: recorded ? 3 : 2, mode: { ...f.mode, observationsRoot, ...(recorded ? { projectDirectory: join(f.dir, "fixed-project"), logbookRoot: join(f.dir, "fixed-logbook") } : {}) } };
  if (recorded) {
    const core = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    assignmentLogbookFixture(core, config.mode);
  }
  writeFileSync(f.configFile, JSON.stringify(config));
  const preparationEntry = join(f.dir, "preparation.mjs");
  writeFileSync(preparationEntry, `import { serveConfiguredPreparations } from './plugin/runtime/configuration.mjs'; serveConfiguredPreparations(${JSON.stringify(f.configFile)});`);
  return { ...f, config, preparationEntry, ...(recorded ? { prompt: (...args) => ({ ...f.prompt(...args), cwd: config.mode.projectDirectory }) } : {}) };
}

test("shared server configuration fixes the same journal project and event store for both launchers", async t => {
  const f = await sharedConfiguration(t, true);
  assert.deepEqual(f.readHookConfiguration(f.configFile), f.config.mode);
  assert.equal(Object.isFrozen(f.readHookConfiguration(f.configFile)), true);
  const loaded = join(f.dir, "loaded-config.json");
  writeFileSync(f.entry, "import { writeFileSync } from 'node:fs';\n" + readFileSync(f.entry, "utf8")
    .replace("async mode => {", `async mode => { writeFileSync(${JSON.stringify(loaded)}, JSON.stringify(mode));`));
  const hooks = await connect(t, f);
  assert.match((await hooks.call(f.prompt("sage mode"))).hookSpecificOutput?.additionalContext, /Sage chief instructions/);
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
  for (const config of [{ ...f.config, version: 3 },
    { version: 1, mode: f.config.mode }, { version: 2, mode: f.mode },
    ...[linked, missing, f.configFile, "relative", f.mode.directory, f.dir].map(observationsRoot => ({ ...f.config, mode: { ...f.config.mode, observationsRoot } }))]) {
    writeFileSync(f.configFile, JSON.stringify(config));
    assert.throws(() => f.readHookConfiguration(f.configFile), configDenied);
  }
  assert.equal(existsSync(missing), false);
});

test("shared server configuration leaves invalid preparation connections unavailable until restart", async t => {
  const f = await sharedConfiguration(t, true);
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
  writeFileSync(config, JSON.stringify({ version: 3, mode: { ...f.mode, ...f.options } }));
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
    [{ ...f.input, run: "R2", name: "qa_child", role: "qa", reviewCycle: 1 }, childActor, qa, "/root/fixture_lead/qa_child", turns[2]],
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


test('native command decoder refuses sparse arrays with extra or hidden keys', async t => {
  const decode = await commandDecoder(t);
  const hidden = Object.defineProperty(['fixed'], 'extra', { value: 'fixed' });
  const symbolic = Object.assign(['fixed'], { [Symbol('extra')]: 'fixed' });
  const hiddenIndex = Object.defineProperty(['fixed'], '0', { enumerable: false });
  for (const values of [Object.assign(Array(1), { extra: 'fixed' }), hidden, symbolic, hiddenIndex]) {
    for (const input of [{ cmd: 'fixed', prefix_rule: values },
      { cmd: 'fixed', additional_permissions: { file_system: { read: values } } }])
      assert.throws(() => decode(input), { message: 'Codex command arguments are unavailable' });
  }
});

test('native command decoder refuses array getters and hides inspection failures', async t => {
  const decode = await commandDecoder(t);
  let called = false;
  const values = [];
  Object.defineProperty(values, '0', { enumerable: true,
    get() { called = true; throw Error('private fixture text'); } });
  assert.throws(() => decode({ cmd: 'fixed', prefix_rule: values }),
    { message: 'Codex command arguments are unavailable' });
  assert.equal(called, false);
  const throwing = new Proxy({ cmd: 'fixed' }, { ownKeys() { throw Error('private fixture text'); } });
  const unclonable = new Proxy({ cmd: 'fixed' }, {});
  for (const input of [throwing, unclonable])
    assert.throws(() => decode(input), { message: 'Codex command arguments are unavailable' });
});

function compactStart(f, source = 'compact') {
  const { prompt, turn_id, ...fields } = f.prompt('sage mode');
  return { ...fields, hook_event_name: 'SessionStart', source };
}

test('chief compaction restores both instruction parts without changing mode or ownership', async t => {
  const f = fixture(t), client = await connect(t, f);
  const first = await client.call(f.prompt('sage mode'));
  const second = await client.call({ ...f.prompt('sage mode'), instruction_part: 1 });
  const { readAdmission } = await import(pathToFileURL(join(f.plugin, 'core/index.mjs')));
  const before = readAdmission(f.mode.directory);
  for (const [part, expected] of [first, second].entries()) {
    const input = { ...compactStart(f), instruction_part: part };
    const restored = await client.call(input);
    assert.deepEqual(restored, { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: expected.hookSpecificOutput.additionalContext } });
    assert.deepEqual(await client.call(input), restored);
  }
  assert.deepEqual(readAdmission(f.mode.directory), before);
  assert.deepEqual(await client.call(compactStart(f, 'startup')), {});
  await client.call(f.prompt('sage mode off', turns[1]));
  const off = readAdmission(f.mode.directory);
  assert.deepEqual(await client.call(compactStart(f)), {});
  assert.deepEqual(readAdmission(f.mode.directory), off);
  await client.close();
});

test('chief compaction refuses foreign callers unsupported sources and malformed context', async t => {
  const f = fixture(t), client = await connect(t, f);
  await client.call(f.prompt('sage mode'));
  assert.ok((await client.call(compactStart(f))).hookSpecificOutput?.additionalContext);
  const denied = { continue: false, stopReason: 'Sage could not verify this hook request.' };
  assert.deepEqual(await client.call(compactStart(f), childActor), denied);
  for (const input of [{ ...compactStart(f), source: 'resume' }, { ...compactStart(f), cwd: '/wrong' },
    { ...compactStart(f), agent_id: childActor }, { ...compactStart(f), turn_id: turns[0] },
    { ...compactStart(f), instruction_part: -1 }, { ...compactStart(f), instruction_part: 2 },
    { ...compactStart(f), instruction_part: null }, { ...compactStart(f), transcript_path: null }])
    assert.deepEqual(await client.call(input), denied);
  await client.close();
  const wrongVersion = await connect(t, f, '0.159.0');
  assert.deepEqual(await wrongVersion.call(compactStart(f)), denied);
  await wrongVersion.close();
});

test('chief compaction retries failed rendering and never activates an inactive owner', async t => {
  const f = fixture(t), client = await connect(t, f);
  assert.deepEqual(await client.call(compactStart(f)), {});
  const first = await client.call(f.prompt('sage mode'));
  const bindings = join(f.plugin, 'chief-bindings.json'), saved = readFileSync(bindings, 'utf8');
  const { readAdmission } = await import(pathToFileURL(join(f.plugin, 'core/index.mjs')));
  const before = readAdmission(f.mode.directory);
  writeFileSync(bindings, 'invalid fixture JSON');
  assert.deepEqual(await client.call(compactStart(f)), { continue: false, stopReason: 'Sage could not verify this hook request.' });
  assert.deepEqual(readAdmission(f.mode.directory), before);
  writeFileSync(bindings, saved);
  const restored = await client.call(compactStart(f));
  assert.equal(restored.hookSpecificOutput?.additionalContext, first.hookSpecificOutput.additionalContext);
  assert.deepEqual(readAdmission(f.mode.directory), before);
  await client.close();
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
});


test("native child tools refuse missing dispatch results changed tasks and foreign turns before policy", async t => {
  const f = await composedPolicyFixture(t);
  f.api.prepareNativeTask(f.input, f.native(session), f.options);
  f.api.reservePreparedSpawn(f.spawnInput(), f.native(session), f.options);
  let evaluated = 0;
  const policy = f.createNativePolicy(f.options, () => { evaluated++; return { decision: "pass" }; });
  const transcript_path = f.childTranscript();
  const input = { ...patch(turns[1]), tool_name: "list_mcp_resources", tool_input: {}, transcript_path };
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
  f.childTranscript();
  assert.deepEqual(await f.evaluate(policy, input, childActor), { decision: "pass" });
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 1);
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



async function deliveredChildFixture(t) {
  const f = await composedPolicyFixture(t);
  f.api.prepareNativeTask(f.input, f.native(session), f.options);
  f.api.reservePreparedSpawn(f.spawnInput(), f.native(session), f.options);
  f.events.publish(join(f.options.observationsRoot, session), f.result);
  const tool = { ...patch(turns[1]), tool_name: "list_mcp_resources", tool_input: {}, transcript_path: f.childTranscript() };
  return { ...f, tool };
}

test("native child tool permission refuses terminal turns without releasing capacity", async t => {
  for (const type of ["turn_aborted", "task_complete"]) {
    const f = await deliveredChildFixture(t); let calls = 0;
    const policy = f.createNativePolicy(f.options, () => { calls++; return { decision: "pass" }; });
    assert.deepEqual(await f.evaluate(policy, f.tool, childActor), { decision: "pass" });
    const before = f.core.readAdmission(f.options.directory);
    appendFileSync(f.tool.transcript_path, JSON.stringify({ type: "event_msg", payload: { type, turn_id: turns[1] } }) + "\n");
    await assert.rejects(f.evaluate(policy, f.tool, childActor), /child turn evidence is unavailable/);
    assert.equal(calls, 1);
    assert.deepEqual(f.core.readAdmission(f.options.directory), before);
  }
});

test("native child tool permission rechecks terminal evidence after an awaited evaluator", async t => {
  for (const type of ["turn_aborted", "task_complete"]) {
    const f = await deliveredChildFixture(t); let entered, resume;
    const waiting = new Promise(resolve => { entered = resolve; });
    const release = new Promise(resolve => { resume = resolve; });
    const policy = f.createNativePolicy(f.options, async () => { entered(); await release; return { decision: "pass" }; });
    const result = f.evaluate(policy, f.tool, childActor);
    // A broken precondition must fail, not leave this test waiting for a callback that never ran.
    await Promise.race([waiting, result.then(() => { throw Error("The evaluator did not wait"); })]);
    const before = f.core.readAdmission(f.options.directory);
    appendFileSync(f.tool.transcript_path, JSON.stringify({ type: "event_msg", payload: { type, turn_id: turns[1] } }) + "\n");
    resume();
    await assert.rejects(result, /child turn evidence is unavailable/);
    assert.deepEqual(f.core.readAdmission(f.options.directory), before);
  }
});

test("native child delivery refuses foreign metadata linked paths and replaced current turns", async t => {
  const f = await deliveredChildFixture(t); let calls = 0;
  const policy = f.createNativePolicy(f.options, () => { calls++; return { decision: "pass" }; });
  const original = readFileSync(f.tool.transcript_path, "utf8");
  for (const change of [{ id: session }, { session_id: childActor }, { parent_thread_id: childActor },
    { agent_path: "/root/other" }, { cli_version: "old" }]) {
    const rows = original.trim().split("\n").map(JSON.parse);
    Object.assign(rows[0].payload, change);
    writeFileSync(f.tool.transcript_path, rows.map(row => JSON.stringify(row) + "\n").join(""));
    await assert.rejects(f.evaluate(policy, f.tool, childActor));
  }
  writeFileSync(f.tool.transcript_path, original);
  const linked = join(f.mode.sessionsDir, "linked.jsonl"); symlinkSync(f.tool.transcript_path, linked);
  await assert.rejects(f.evaluate(policy, { ...f.tool, transcript_path: linked }, childActor));
  const outside = join(f.dir, "outside.jsonl"); writeFileSync(outside, original);
  await assert.rejects(f.evaluate(policy, { ...f.tool, transcript_path: outside }, childActor));
  for (const rows of [
    [{ type: "event_msg", payload: { type: "task_started", turn_id: turns[2] } }, { type: "turn_context", payload: { turn_id: turns[2] } }],
    [{ type: "event_msg", payload: { type: "task_started", turn_id: turns[1] } }],
    [{ type: "turn_context", payload: { turn_id: turns[2] } }],
  ]) {
    writeFileSync(f.tool.transcript_path, original + rows.map(row => JSON.stringify(row) + "\n").join(""));
    await assert.rejects(f.evaluate(policy, f.tool, childActor));
  }
  assert.equal(calls, 0);
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 0);
  writeFileSync(f.tool.transcript_path, original);
  assert.deepEqual(await f.evaluate(policy, f.tool, childActor), { decision: "pass" });
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 1);
});

async function completionFixture(t) {
  const f = await composedPolicyFixture(t);
  f.api.prepareNativeTask(f.input, f.native(session), f.options);
  f.api.reservePreparedSpawn(f.spawnInput(), f.native(session), f.options);
  f.events.publish(join(f.options.observationsRoot, session), f.result);
  const transcript_path = f.childTranscript();
  const policy = f.createNativePolicy(f.options, () => ({ decision: "pass" }));
  await f.evaluate(policy, { ...patch(turns[1]), tool_name: "list_mcp_resources", tool_input: {}, transcript_path }, childActor);
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
  assert.deepEqual(await client.call({ ...f.stop, stop_hook_active: false, last_assistant_message: headings }, childActor), {});
  assert.equal((f.core.readAdmission(f.options.directory).completions ?? []).length, 0);
  await client.close();
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

test("native report correction is bounded and never accepts report claims", async t => {
  const f = await completionFixture(t), client = await stopReportClient(t, f);
  const stop = { ...f.stop, stop_hook_active: false, last_assistant_message: "STATUS done" };
  const first = await client.call(stop, childActor);
  assert.equal(first.decision, "block");
  assert.match(first.reason, /RESULT, EVIDENCE, FINDINGS, QUESTIONS, NOT VERIFIED, BRANCH/);
  assert.deepEqual(await client.call({ ...stop, stop_hook_active: true }, childActor), {});
  assert.equal(f.core.readAdmission(f.options.directory).completions?.length ?? 0, 0);
  assert.equal((await client.call({ ...stop, stop_hook_active: true, turn_id: turns[2] }, childActor)).decision, "block");
  appendReport(f, stop.last_assistant_message);
  assert.deepEqual(await client.call(stop, childActor), {});
  const state = f.core.readAdmission(f.options.directory);
  assert.equal(state.completions.length, 1);
  assert.equal(state.reports?.length ?? 0, 0);
  await client.close();
});

test("native completion retains compacted work but can record verified interruption", async t => {
  for (const interrupted of [false, true]) {
    const f = await completionFixture(t);
    appendFileSync(join(f.mode.sessionsDir, `${childActor}.jsonl`), JSON.stringify({ type: "compacted", payload: {
      window_number: 1, window_id: "a1111111-2222-4333-8444-555555555555",
      resume_metadata: { last_started_turn_id: turns[1], multi_agent_version: "v2" },
    } }) + "\n");
    if (interrupted) appendInterruption(f);
    const client = await stopReportClient(t, f);
    for (const stop_hook_active of [false, true]) {
      const output = await client.call({ ...f.stop, stop_hook_active, last_assistant_message: reportText }, childActor);
      assert.equal(output.decision, "block"); assert.match(output.reason, /compaction/);
      assert.equal(f.core.readAdmission(f.options.directory).completions?.length ?? 0, 0);
    }
    const { reconcileNativeCompletions } = await import(pathToFileURL(join(f.plugin, "runtime/child-stop.mjs")));
    reconcileNativeCompletions(f.native(session), session, f.options);
    const state = f.core.readAdmission(f.options.directory);
    assert.equal(state.completions?.length ?? 0, interrupted ? 1 : 0);
    if (interrupted) assert.equal(state.completions[0].outcome, "interrupted");
    else {
      appendReport(f);
      assert.equal((await client.call({ ...f.stop, stop_hook_active: true, last_assistant_message: reportText }, childActor)).decision, "block");
      assert.throws(() => reconcileNativeCompletions(f.native(session), session, f.options));
      assert.equal(f.core.readAdmission(f.options.directory).completions?.length ?? 0, 0);
    }
    await client.close();
  }
});
test("initial delivery recovery binds a late result without another child callback", async t => {
  const f = await composedPolicyFixture(t);
  f.api.prepareNativeTask(f.input, f.native(session), f.options);
  const policy = f.createNativePolicy(f.options, () => ({ decision: "pass" }));
  await f.evaluate(policy);
  const transcript = f.childTranscript(); appendReport(f);
  const stop = { hook_event_name: "SubagentStop", session_id: session, agent_id: childActor, turn_id: turns[1],
    transcript_path: join(f.mode.sessionsDir, "root.jsonl"), agent_transcript_path: transcript };
  assert.throws(() => policy.completeChild(stop, f.native(childActor)));
  const { reconcileNativeCompletions } = await import(pathToFileURL(join(f.plugin, "runtime/child-stop.mjs")));
  const reconcile = actor => reconcileNativeCompletions(f.native(actor), session, f.options);
  reconcile(session);
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 0);
  f.events.publish(join(f.options.observationsRoot, session), f.result);
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  reconcile(childActor);
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 0);
  reconcile(session);
  const state = f.core.readAdmission(f.options.directory);
  assert.equal(state.bindings.length, 1);
  assert.equal(state.completions.length, 1);
  assert.equal(state.modes.at(-1).sage, false);
  reconcile(session);
  assert.deepEqual(f.core.readAdmission(f.options.directory), state);
});

test("initial delivery recovery refuses changed or missing transcript evidence", async t => {
  const f = await composedPolicyFixture(t);
  f.api.prepareNativeTask(f.input, f.native(session), f.options);
  const policy = f.createNativePolicy(f.options, () => ({ decision: "pass" }));
  await f.evaluate(policy);
  const transcript = f.childTranscript(); appendReport(f);
  const stop = { hook_event_name: "SubagentStop", session_id: session, agent_id: childActor, turn_id: turns[1],
    transcript_path: join(f.mode.sessionsDir, "root.jsonl"), agent_transcript_path: transcript };
  assert.throws(() => policy.completeChild(stop, f.native(childActor)));
  f.events.publish(join(f.options.observationsRoot, session), f.result);
  const { reconcileNativeCompletions } = await import(pathToFileURL(join(f.plugin, "runtime/child-stop.mjs")));
  const reconcile = () => reconcileNativeCompletions(f.native(session), session, f.options);
  const original = readFileSync(transcript, "utf8");
  f.childTranscript({ message: "Changed task" });
  assert.throws(reconcile);
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 0);
  rmSync(transcript);
  assert.throws(reconcile);
  assert.equal(f.core.readAdmission(f.options.directory).completions?.length ?? 0, 0);
  writeFileSync(transcript, original);
  reconcile();
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

test("report inspection pins exact text identity and refuses changed native provenance", async t => {
  const f = await completionFixture(t);
  const { createHash } = await import("node:crypto");
  const { readChildReport } = await import(pathToFileURL(join(f.plugin, "runtime/report-intake.mjs")));
  appendReport(f); f.policy.completeChild(f.stop, f.native(childActor));
  const file = join(f.mode.sessionsDir, `${childActor}.jsonl`), original = readFileSync(file, "utf8");
  const before = f.core.readAdmission(f.options.directory);
  const read = () => readChildReport({name: f.input.name}, f.native(session), f.options);
  const result = read();
  assert.equal(result.reportHash, createHash("sha256").update(reportText).digest("hex"));
  assert.equal(result.reportMessage, "fixture_report"); assert.equal(result.turn, turns[1]);
  for (const change of [rows => rows[0].payload.parent_thread_id = childActor,
    rows => rows.at(-2).metadata.client_authored = true,
    rows => rows.at(-2).metadata.retained_source.complete = false,
    rows => rows.at(-2).payload.internal_chat_message_metadata_passthrough.turn_id = turns[2],
    rows => rows.at(-1).payload.last_agent_message = "changed text",
    rows => rows.at(-1).payload.turn_id = turns[2],
    rows => rows.pop()]) {
    const rows = original.trimEnd().split("\n").map(JSON.parse); change(rows);
    writeFileSync(file, rows.map(row => JSON.stringify(row) + "\n").join(""));
    assert.throws(read);
    assert.deepEqual(f.core.readAdmission(f.options.directory), before);
  }
  writeFileSync(file, original); assert.deepEqual(read(), result);
  assert.deepEqual(f.core.readAdmission(f.options.directory), before);
});

test("report inspection refuses interrupted assignments without accepting their report text", async t => {
  const f = await completionFixture(t);
  const { readChildReport } = await import(pathToFileURL(join(f.plugin, "runtime/report-intake.mjs")));
  appendInterruption(f);
  assert.throws(() => readChildReport({name: f.input.name}, f.native(session), f.options));
  const state = f.core.readAdmission(f.options.directory);
  assert.equal(state.completions.length, 1); assert.equal(state.completions[0].outcome, "interrupted");
  assert.equal(state.reports?.length ?? 0, 0);
});

test("packaged report inspection contains transcript failures and preserves owner scope", async t => {
  const f = await completionFixture(t);
  appendReport(f); f.policy.completeChild(f.stop, f.native(childActor));
  writeFileSync(f.entry, `import { servePreparations } from './plugin/runtime/preparation-server.mjs'; servePreparations(${JSON.stringify(f.options)});`);
  const client = await connect(t, f, "0.160.0", "", "sage_read_report");
  const input = {name: f.input.name};
  assert.equal((await client.call(input)).report.STATUS, "done");
  for (const actor of [null, childActor, "a22422c7-509c-43aa-8c42-827c556f8a59"])
    assert.match((await client.call(input, actor)).error, /could not read/);
  const file = join(f.mode.sessionsDir, `${childActor}.jsonl`), text = readFileSync(file, "utf8");
  rmSync(file); assert.match((await client.call(input)).error, /could not read/);
  const target = join(f.mode.sessionsDir, "other.jsonl"); writeFileSync(target, text); symlinkSync(target, file);
  assert.match((await client.call(input)).error, /could not read/);
  rmSync(file); writeFileSync(file, text); assert.equal((await client.call(input)).report.STATUS, "done");
  await client.close();
});


test("native report read leaves an unrelated sibling unchanged with missing or terminal evidence", async t => {
  const f = await completionFixture(t);
  appendReport(f);
  f.policy.completeChild(f.stop, f.native(childActor));
  const other = "a22422c7-509c-43aa-8c42-827c556f8a59";
  const name = "other_lead";
  f.api.prepareNativeTask({ ...f.input, task: "T2", run: "R3", name }, f.native(session), f.options);
  f.api.reservePreparedSpawn(f.spawnInput(name, "spawn-2"), f.native(session), f.options);
  f.events.publish(join(f.options.observationsRoot, session), { ...f.result, call: "spawn-2", path: `/root/${name}` });
  const transcript = f.childTranscript({ child: other, path: `/root/${name}`, turn: turns[2] });
  await f.evaluate(f.policy, { ...patch(turns[2]), tool_name: "list_mcp_resources", tool_input: {}, transcript_path: transcript }, other);
  const original = readFileSync(transcript, "utf8");
  const before = f.core.readAdmission(f.options.directory);
  const { readChildReport } = await import(pathToFileURL(join(f.plugin, "runtime/report-intake.mjs")));
  rmSync(transcript);
  assert.equal(readChildReport({ name: f.input.name }, f.native(session), f.options).report.STATUS, "done");
  assert.deepEqual(f.core.readAdmission(f.options.directory), before);
  writeFileSync(transcript, original);
  appendReport(f, reportText, other, turns[2]);
  assert.equal(readChildReport({ name: f.input.name }, f.native(session), f.options).report.STATUS, "done");
  assert.deepEqual(f.core.readAdmission(f.options.directory), before);
});

async function assignmentReader(f) {
  const file = join(f.plugin, "runtime/child-assignment.mjs");
  assert.ok(existsSync(file), "the current child assignment reader must ship");
  const { readNativeChildAssignment } = await import(pathToFileURL(file));
  return (input = {}, actor = childActor, options = f.options) => readNativeChildAssignment(input, f.native(actor), options);
}

test("child assignment recovery returns exact saved instructions without changing state", async t => {
  const f = await completionFixture(t), read = await assignmentReader(f);
  const before = JSON.stringify(f.core.readAdmission(f.options.directory));
  const prepared = f.api.prepareNativeTask(f.input, f.native(session), f.options);
  const result = read();
  assert.equal(result.decision, "current-assignment"); assert.equal(result.message, prepared.message);
  assert.equal(result.task, "T1"); assert.equal(result.run, "R1"); assert.equal(result.child, childActor);
  assert.equal(result.turn, turns[1]); assert.equal(result.role, "lead");
  assert.equal(result.taskHash, createHash("sha256").update(prepared.message).digest("hex"));
  assert.deepEqual(read(), result);
  assert.equal(JSON.stringify(f.core.readAdmission(f.options.directory)), before);
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  assert.deepEqual(read(), result, "an existing child can finish after Sage off");
});

test("child assignment recovery refuses selectors foreign actors and terminal turns", async t => {
  const f = await completionFixture(t), read = await assignmentReader(f);
  assert.equal(read().task, "T1");
  for (const input of [{ task: "T1" }, { actor: childActor }, { turn: turns[1] }, [], null]) assert.throws(() => read(input));
  for (const actor of [session, turns[0]]) assert.throws(() => read({}, actor));
  assert.throws(() => read({}, childActor, { ...f.options, project: "foreign" }));
  const api = await import(pathToFileURL(join(f.plugin, "runtime/child-assignment.mjs")));
  assert.throws(() => api.readNativeChildAssignment({}, { version: "unsupported", actor: childActor }, f.options));
  appendReport(f); assert.throws(() => read(), "native terminal evidence is sufficient to refuse a stale read");
  f.childTranscript(); assert.equal(read().task, "T1");
  f.policy.completeChild(f.stop, f.native(childActor));
  appendReport(f); f.policy.completeChild(f.stop, f.native(childActor)); assert.throws(() => read());
});

test("child assignment recovery refuses changed delivery and missing transcripts", async t => {
  const f = await completionFixture(t), read = await assignmentReader(f);
  const expected = read();
  f.childTranscript({ message: "A changed task" }); assert.throws(() => read());
  const path = f.childTranscript(); const bytes = readFileSync(path); rmSync(path); assert.throws(() => read());
  writeFileSync(path, bytes); assert.deepEqual(read(), expected);

});

test("child assignment recovery is available only to the bound child through the packaged tool", async t => {
  const f = await completionFixture(t);
  assert.ok(existsSync(join(f.plugin, "runtime/child-assignment.mjs")), "the child recovery reader must ship");
  writeFileSync(f.entry, `import { servePreparations } from './plugin/runtime/preparation-server.mjs'; servePreparations(${JSON.stringify(f.options)});`);
  const client = await connect(t, f, "0.160.0", "", "sage_read_assignment");
  const result = await client.call({}, childActor); assert.equal(result.decision, "current-assignment");
  assert.equal(result.message, f.api.prepareNativeTask(f.input, f.native(session), f.options).message);
  assert.match((await client.call({}, session)).error, /could not read/);
  appendReport(f); assert.match((await client.call({}, childActor)).error, /could not read/);
  await client.close();
});


function appendRecoveryCheckpoint(transcript, number = 1, turn = turns[1]) {
  appendFileSync(transcript, JSON.stringify({ type: "compacted", payload: { window_number: number,
    window_id: `${String(number).padStart(8, "0")}-8888-4888-8888-888888888888`,
    resume_metadata: { last_started_turn_id: turn, multi_agent_version: "v2" } } }) + "\n");
}

test("child tool recovery denies work after compaction in either Sage mode", async t => {
  for (const sage of [true, false]) {
    const f = await completionFixture(t); let calls = 0;
    const transcript = f.childTranscript();
    const input = { ...patch(turns[1]), transcript_path: transcript, tool_name: "list_mcp_resources", tool_input: {} };
    const policy = f.createNativePolicy(f.options, () => { calls++; return { decision: "pass" }; });
    if (!sage) f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
    assert.deepEqual(await f.evaluate(policy, input, childActor), { decision: "pass" });
    const before = f.core.readAdmission(f.options.directory);
    appendRecoveryCheckpoint(transcript);
    const result = await f.evaluate(policy, input, childActor);
    assert.equal(result.decision, "deny"); assert.match(result.reason, /read.*assignment/i);
    assert.equal(calls, 1, "unrecovered work must not reach the evaluator");
    assert.deepEqual(f.core.readAdmission(f.options.directory), before);
    const reader = { ...input, tool_name: "mcp__sage_preparation__sage_read_assignment" };
    assert.deepEqual(await f.evaluate(policy, reader, childActor), { decision: "pass" });
    assert.equal(calls, 2, "the reader still needs the normal evaluator");
    assert.equal((await f.evaluate(policy, { ...reader, tool_input: { task: "T1" } }, childActor)).decision, "deny");
  }
});

test("child tool recovery rechecks compaction after an awaited evaluator", async t => {
  const f = await completionFixture(t); let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  const transcript = f.childTranscript();
  const input = { ...patch(turns[1]), transcript_path: transcript, tool_name: "list_mcp_resources", tool_input: {} };
  const policy = f.createNativePolicy(f.options, async () => { entered(); await resume; return { decision: "pass" }; });
  const result = f.evaluate(policy, input, childActor);
  await waiting;
  appendRecoveryCheckpoint(transcript);
  release();
  assert.equal((await result).decision, "deny");
});


test("child tool recovery permits work only after an intact current read and resets on compaction", async t => {
  const f = await completionFixture(t), read = await assignmentReader(f);
  const result = read(), transcript = f.childTranscript();
  const input = { ...patch(turns[1]), transcript_path: transcript, tool_name: "list_mcp_resources", tool_input: {} };
  const policy = f.createNativePolicy(f.options, () => ({ decision: "pass" }));
  appendRecoveryCheckpoint(transcript);
  assert.equal((await f.evaluate(policy, input, childActor)).decision, "deny");
  appendAssignmentRecovery(transcript, result);
  assert.deepEqual(await f.evaluate(policy, input, childActor), { decision: "pass" });
  appendRecoveryCheckpoint(transcript, 2);
  assert.equal((await f.evaluate(policy, input, childActor)).decision, "deny");
});



function appendAssignmentRecovery(transcript, result) {
  const stamp = { internal_chat_message_metadata_passthrough: { turn_id: result.turn } };
  const rows = [{ type: "response_item", metadata: { client_authored: false }, payload: {
    type: "function_call", id: "fc_read_current", namespace: "mcp__sage_preparation", name: "sage_read_assignment",
    call_id: "read_current", arguments: "{}", ...stamp } },
  { type: "response_item", metadata: { client_authored: false, fallback_token_limit_override: 100000,
    mcp_attribution: { status: "complete", sources: [{ server_name: "sage_preparation", tool_name: "sage_read_assignment", first_turn_id: result.turn }] } },
    payload: { type: "function_call_output", id: "fco_read_current", call_id: "read_current", ...stamp,
      output: [{ type: "input_text", text: "Wall time: 0.01 seconds\nOutput:" }, { type: "input_text", text: JSON.stringify(result) }] } }];
  appendFileSync(transcript, rows.map(row => JSON.stringify(row) + "\n").join(""));
}

test("child stop recovery blocks repeated stops and parent completion after compaction", async t => {
  for (const sage of [true, false]) {
    const f = await completionFixture(t), client = await stopReportClient(t, f);
    if (!sage) f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
    appendRecoveryCheckpoint(f.childTranscript());
    const before = f.core.readAdmission(f.options.directory);
    for (const stop_hook_active of [false, true]) {
      const result = await client.call({ ...f.stop, stop_hook_active, last_assistant_message: reportText }, childActor);
      assert.equal(result.decision, "block"); assert.match(result.reason, /read.*assignment/i);
      assert.deepEqual(f.core.readAdmission(f.options.directory), before);
    }
    appendReport(f);
    const { reconcileNativeCompletions } = await import(pathToFileURL(join(f.plugin, "runtime/child-stop.mjs")));
    assert.throws(() => reconcileNativeCompletions(f.native(session), session, f.options));
    assert.deepEqual(f.core.readAdmission(f.options.directory), before, "a terminal report cannot bypass missing recovery");
    const { readChildReport } = await import(pathToFileURL(join(f.plugin, "runtime/report-intake.mjs")));
    assert.throws(() => readChildReport({ name: f.input.name }, f.native(session), f.options));
    await client.close();
  }
});


test("child stop recovery completes the recovered assignment once and preserves interruption", async t => {
  for (const interrupted of [false, true]) {
    const f = await completionFixture(t), read = await assignmentReader(f);
    const result = read(), transcript = f.childTranscript();
    f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
    appendRecoveryCheckpoint(transcript);
    assert.deepEqual(f.policy.completeChild(f.stop, f.native(childActor)), { decision: "recovery-required" });
    if (interrupted) {
      appendFileSync(transcript, JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted", turn_id: turns[1], reason: "interrupted" } }) + "\n");
      const { reconcileNativeCompletions } = await import(pathToFileURL(join(f.plugin, "runtime/child-stop.mjs")));
      reconcileNativeCompletions(f.native(session), session, f.options);
      const state = f.core.readAdmission(f.options.directory);
      assert.equal(state.completions.length, 1); assert.equal(state.completions[0].outcome, "interrupted");
      assert.equal(state.reports?.length ?? 0, 0);
    } else {
      appendAssignmentRecovery(transcript, result);
      const client = await stopReportClient(t, f);
      assert.deepEqual(await client.call({ ...f.stop, stop_hook_active: true, last_assistant_message: reportText }, childActor), {});
      assert.equal(f.core.readAdmission(f.options.directory).completions?.length ?? 0, 0);
      appendReport(f);
      const { readChildReport } = await import(pathToFileURL(join(f.plugin, "runtime/report-intake.mjs")));
      const report = readChildReport({ name: f.input.name }, f.native(session), f.options);
      assert.equal(report.report.STATUS, "done");
      const state = f.core.readAdmission(f.options.directory);
      assert.equal(state.completions.length, 1); assert.equal(state.reports?.length ?? 0, 0);
      assert.equal(state.bindings.length, 1); assert.equal(state.reservations.length, 1);
      await client.close();
    }
  }
});

test("unbound child recovery after Sage off cannot bypass its pending assignment", async t => {
  const f = await composedPolicyFixture(t); let calls = 0;
  f.api.prepareNativeTask(f.input, f.native(session), f.options);
  f.api.reservePreparedSpawn(f.spawnInput(), f.native(session), f.options);
  f.events.publish(join(f.options.observationsRoot, session), f.result);
  const transcript = f.childTranscript(); appendRecoveryCheckpoint(transcript);
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 0);
  const policy = f.createNativePolicy(f.options, () => { calls++; return { decision: "pass" }; });
  const input = { ...patch(turns[1]), transcript_path: transcript, tool_name: "list_mcp_resources", tool_input: {} };
  const result = await f.evaluate(policy, input, childActor);
  assert.equal(result.decision, "deny"); assert.match(result.reason, /read.*assignment/i);
  assert.equal(calls, 0);
  const state = f.core.readAdmission(f.options.directory);
  assert.equal(state.bindings.length, 1); assert.equal(state.reservations.length, 1);
  assert.equal(state.completions?.length ?? 0, 0); assert.equal(state.modes.at(-1).sage, false);
  assert.equal((await f.evaluate(policy, input, childActor)).decision, "deny");
  assert.deepEqual(f.core.readAdmission(f.options.directory), state);
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


test("report recovery proof alone cannot replace a missing durable receipt", async t => {
  const f = await completionFixture(t); appendReport(f); f.policy.completeChild(f.stop, f.native(childActor));
  const api = await import(pathToFileURL(join(f.plugin, "runtime/report-intake.mjs")));
  const recovery = await import(pathToFileURL(join(f.plugin, "runtime/report-recovery.mjs")));
  const read = api.readChildReport({ name: f.input.name }, f.native(session), f.options);
  const state = f.core.readAdmission(f.options.directory);
  const report = { binding: state.bindings[0], task: "T1", run: "R1", reportMessage: read.reportMessage,
    reportHash: read.reportHash, text: reportText };
  recovery.recordReportRecovery(report, f.options);
  assert.deepEqual(f.core.readAdmission(f.options.directory), state);
  const transcript = join(f.mode.sessionsDir, `${childActor}.jsonl`), saved = readFileSync(transcript, "utf8");
  rmSync(transcript);
  assert.throws(() => api.readChildReport({ name: f.input.name }, f.native(session), f.options));
  assert.throws(() => api.recordChildReport({ name: f.input.name, reportHash: read.reportHash }, f.native(session), f.options));
  assert.deepEqual(f.core.readAdmission(f.options.directory), state);
  writeFileSync(transcript, saved);
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  assert.equal(api.recordChildReport({ name: f.input.name, reportHash: read.reportHash }, f.native(session), f.options).decision, "report-recorded");
  rmSync(transcript);
  assert.deepEqual(api.readChildReport({ name: f.input.name }, f.native(session), f.options), read);
});

test("cached report inspection refuses missing changed and conflicting recovery proofs", async t => {
  const f = await completionFixture(t); appendReport(f); f.policy.completeChild(f.stop, f.native(childActor));
  const api = await import(pathToFileURL(join(f.plugin, "runtime/report-intake.mjs")));
  const input = { name: f.input.name };
  const read = api.readChildReport(input, f.native(session), f.options);
  api.recordChildReport({ ...input, reportHash: read.reportHash }, f.native(session), f.options);
  const directory = join(f.options.observationsRoot, session);
  const proof = f.events.readObservations(directory).find(row => row.kind === "report-recovery-verified");
  assert.ok(proof);
  const file = readdirSync(directory).find(name => name.endsWith(".json")
    && JSON.parse(readFileSync(join(directory, name), "utf8")).kind === "report-recovery-verified");
  rmSync(join(directory, file)); rmSync(join(f.mode.sessionsDir, `${childActor}.jsonl`));
  const before = f.core.readAdmission(f.options.directory);
  assert.throws(() => api.readChildReport(input, f.native(session), f.options));
  f.events.publish(directory, { ...proof, receiptHash: "f".repeat(64) });
  assert.throws(() => api.readChildReport(input, f.native(session), f.options));
  f.events.publish(directory, proof);
  assert.throws(() => api.readChildReport(input, f.native(session), f.options));
  assert.deepEqual(f.core.readAdmission(f.options.directory), before);
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

test("native failed dispatch rejects post-terminal evidence and preserves historical rejection", async t => {
  for (const type of ["task_complete", "turn_aborted"]) {
    const f = await failedDispatchFixture(t);
    const terminal = { type: "event_msg", payload: { type, turn_id: f.spawn.turn_id } };
    for (const position of [0, 1]) {
      const rows = structuredClone(f.rows); rows.splice(position, 0, terminal); f.write(rows);
      assert.throws(() => f.policy.reconcileCompletions(f.event, f.native(session)), /failure evidence/);
      assert.equal(f.core.readAdmission(f.options.directory).failures?.length ?? 0, 0);
    }
    f.write([...f.rows, terminal]);
    f.policy.reconcileCompletions(f.event, f.native(session));
    assert.equal(f.core.readAdmission(f.options.directory).failures.length, 1);
    const saved = f.core.readAdmission(f.options.directory);
    f.policy.reconcileCompletions(f.event, f.native(session));
    assert.deepEqual(f.core.readAdmission(f.options.directory), saved);
  }
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

test('native command policy rechecks pending evidence after an awaited evaluator', async t => {
  for (const sage of [true, false]) {
    for (const change of ['complete', 'interrupt', 'result', 'arguments']) {
      const f = await composedPolicyFixture(t);
      if (!sage) f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
      const { input } = commandPolicyInput(f, session, 'printf fixed', sage ? turns[0] : turns[2]);
      let entered, release;
      const waiting = new Promise(resolve => { entered = resolve; });
      const resume = new Promise(resolve => { release = resolve; });
      const policy = f.createNativePolicy(f.options, async () => { entered(); await resume; return { decision: 'pass' }; });
      const pending = f.evaluate(policy, input);
      await waiting;
      if (change === 'arguments') {
        const rows = readFileSync(input.transcript_path, 'utf8').trim().split('\n').map(JSON.parse);
        const args = JSON.parse(rows.at(-1).payload.arguments); args.workdir = join(f.dir, 'changed');
        rows.at(-1).payload.arguments = JSON.stringify(args);
        writeFileSync(input.transcript_path, rows.map(row => JSON.stringify(row) + '\n').join(''));
      } else {
        const row = change === 'result'
          ? { type: 'response_item', payload: { type: 'function_call_output', call_id: input.tool_use_id, output: 'fixed' } }
          : { type: 'event_msg', payload: { type: change === 'complete' ? 'task_complete' : 'turn_aborted', turn_id: input.turn_id } };
        appendFileSync(input.transcript_path, JSON.stringify(row) + '\n');
      }
      release();
      await assert.rejects(pending);
    }
  }
});

test('native command policy gives the evaluator a separate copy of command inputs', async t => {
  const f = await composedPolicyFixture(t), { input, envelope } = commandPolicyInput(f);
  const before = readFileSync(input.transcript_path, 'utf8');
  const policy = f.createNativePolicy(f.options, (_input, context) => {
    assert.deepEqual(context.command, envelope);
    context.command.workdir = 'callback-local-change';
    return { decision: 'pass' };
  });
  assert.deepEqual(await f.evaluate(policy, input), { decision: 'pass' });
  assert.equal(readFileSync(input.transcript_path, 'utf8'), before);
});

test('native off-mode child command needs no observation directory and refuses invalid stored evidence', async t => {
  const f = await composedPolicyFixture(t); let evaluated = 0;
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  const directory = join(f.options.observationsRoot, session);
  assert.equal(existsSync(directory), false);
  const policy = f.createNativePolicy(f.options, (_input, context) => {
    evaluated++; assert.equal(context.command.cmd, 'printf fixed'); return { decision: 'pass' };
  });
  const { input } = commandPolicyInput(f, childActor, 'printf fixed', turns[1], 'unassigned native child');
  assert.equal((await f.evaluate(policy, input, childActor)).decision, 'pass');
  assert.equal(existsSync(directory), false);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'unexpected.json'), '{}');
  await assert.rejects(f.evaluate(policy, input, childActor), /unexpected published entry/);
  assert.equal(evaluated, 1);
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 0);
});

function commandPermissionInput(f, actor, permissions, turn) {
  const command = commandPolicyInput(f, actor, 'cat example.txt', turn);
  const rows = readFileSync(command.input.transcript_path, 'utf8').trim().split('\n').map(JSON.parse);
  rows.at(-1).payload.arguments = JSON.stringify({...command.envelope, ...permissions});
  writeFileSync(command.input.transcript_path, rows.map(row => JSON.stringify(row) + '\n').join(''));
  return command.input;
}

test('native child sandbox escalation is refused before a permissive evaluator', async t => {
  for (const role of ['lead', 'implementer']) {
    const f = await composedPolicyFixture(t); let evaluated = 0;
    recordedFixtureRole(f, role); f.bindLead();
    const policy = f.createNativePolicy(f.options, () => { evaluated++; return {decision: 'pass'}; });
    for (const permissions of [
      {sandbox_permissions: 'require_escalated'},
      {sandbox_permissions: 'with_additional_permissions'},
      {sandbox_permissions: 'with_additional_permissions', additional_permissions: {network: {enabled: true}}},
      {sandbox_permissions: 'use_default', additional_permissions: {file_system: {write: ['/outside']}}},
    ]) {
      const input = commandPermissionInput(f, childActor, permissions, turns[1]);
      assert.equal((await f.evaluate(policy, input, childActor)).reason,
        'A child cannot request broader sandbox permissions. Ask the chief to run this command.');
      assert.equal(evaluated, 0);
    }
    const ordinary = commandPermissionInput(f, childActor, {sandbox_permissions: 'use_default', additional_permissions: null}, turns[1]);
    assert.deepEqual(await f.evaluate(policy, ordinary, childActor), {decision: 'pass'});
    assert.equal(evaluated, 1);
  }
});

test('native child sandbox escalation stays refused when off while chief permission checks remain authoritative', async t => {
  const f = await composedPolicyFixture(t); let evaluated = 0;
  recordedFixtureRole(f, 'implementer'); f.bindLead();
  const initial = commandPermissionInput(f, childActor, {sandbox_permissions: 'use_default'}, turns[1]);
  assert.deepEqual(await f.evaluate(f.createNativePolicy(f.options, () => ({decision: 'pass'})), initial, childActor), {decision: 'pass'});
  const policy = f.createNativePolicy(f.options, () => { evaluated++; return {decision: 'deny', reason: 'Native permission check refused.'}; });
  f.core.changeAdmissionMode(f.options.directory, {...f.scope, after: turns[0], turn: turns[2], sage: false});
  const child = commandPermissionInput(f, childActor, {sandbox_permissions: 'require_escalated'}, turns[1]);
  assert.equal((await f.evaluate(policy, child, childActor)).reason,
    'A child cannot request broader sandbox permissions. Ask the chief to run this command.');
  assert.equal(evaluated, 0);
  const chief = commandPermissionInput(f, session, {sandbox_permissions: 'require_escalated'}, turns[2]);
  assert.deepEqual(await f.evaluate(policy, chief), {decision: 'deny', reason: 'Native permission check refused.'});
  assert.equal(evaluated, 1);
});


test('native child sandbox escalation refuses an unassigned off-mode child', async t => {
  const f = await composedPolicyFixture(t); let evaluated = 0;
  f.core.changeAdmissionMode(f.options.directory, {...f.scope, after: turns[0], turn: turns[2], sage: false});
  const policy = f.createNativePolicy(f.options, () => { evaluated++; return {decision: 'pass'}; });
  const {input, envelope} = commandPolicyInput(f, childActor, 'printf fixed', turns[1], 'unassigned native child');
  const rows = readFileSync(input.transcript_path, 'utf8').trim().split('\n').map(JSON.parse);
  rows.at(-1).payload.arguments = JSON.stringify({...envelope, sandbox_permissions: 'require_escalated'});
  writeFileSync(input.transcript_path, rows.map(row => JSON.stringify(row) + '\n').join(''));
  assert.deepEqual(await f.evaluate(policy, input, childActor), {decision: 'deny',
    reason: 'A child cannot request broader sandbox permissions. Ask the chief to run this command.'});
  assert.equal(evaluated, 0);
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 0);
  assert.equal(existsSync(join(f.options.observationsRoot, session)), false);
});

function recordedFixtureRole(f, role) {
  f.input.role = role;
  if (role !== "lead") {
    f.assignmentCli("run", "add", "T1", "--role", role, ...(role === "implementer" || role === "designer" ? ["--branch", "codex/t1-fixture"] : []));
    f.input.run = "R4";
  }
  if (f.core.REVIEW_ROLES.includes(role)) f.input.reviewCycle = 1;
}

async function roleEditFixture(t, role) {
  const f = await composedPolicyFixture(t);
  recordedFixtureRole(f, role);
  f.api.prepareNativeTask(f.input, f.native(session), f.options);
  f.api.reservePreparedSpawn(f.spawnInput(), f.native(session), f.options);
  f.events.publish(join(f.options.observationsRoot, session), f.result);
  return { ...f, editInput: { ...patch(turns[1]), tool_input: { command: '*** Begin Patch\n*** Add File: example.txt\n+fixed\n*** End Patch' }, transcript_path: f.childTranscript() } };
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

test('native Sage child messages reach only the chief even when the supplied evaluator permits other targets', async t => {
  const f = await completionFixture(t);
  const event = target => ({ ...patch(turns[1]), tool_name: 'collaborationsend_message', tool_use_id: `message-${target.replace(/[^a-z0-9]/gi, '')}`,
    tool_input: { target, message: 'Fixed progress report' }, transcript_path: join(f.mode.sessionsDir, `${childActor}.jsonl`) });
  for (const target of ['/root/peer', '/root/fixture_lead/reviewer', 'peer', childActor]) {
    const result = await f.evaluate(f.policy, event(target), childActor);
    assert.equal(result.decision, 'deny'); assert.match(result.reason, /chief/);
  }
  for (const target of ['/root', session]) assert.deepEqual(await f.evaluate(f.policy, event(target), childActor), { decision: 'pass' });
  assert.equal(f.core.readAdmission(f.options.directory).completions?.length ?? 0, 0);
});
test('native Sage child message restriction survives off while ordinary children and the chief retain evaluator access', async t => {
  const f = await completionFixture(t);
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  const event = { ...patch(turns[1]), tool_name: 'collaborationsend_message', tool_use_id: 'off-message', tool_input: { target: '/root/peer', message: 'Fixed progress report' } };
  assert.equal((await f.evaluate(f.policy, event, childActor)).decision, 'deny');
  for (const actor of [session, 'a1111111-2222-4333-8444-555555555555']) {
    assert.deepEqual(await f.evaluate(f.policy, { ...event, tool_use_id: `ordinary-${actor}` }, actor), { decision: 'pass' });
  }
  assert.equal(f.core.readAdmission(f.options.directory).modes.at(-1).sage, false);
});
test('native Sage child message permission cannot bypass malformed input or the supplied evaluator', async t => {
  const f = await completionFixture(t);
  const event = { ...patch(turns[1]), tool_name: 'collaborationsend_message', tool_use_id: 'checked-message', tool_input: { target: '/root', message: 'Fixed progress report' }, transcript_path: join(f.mode.sessionsDir, `${childActor}.jsonl`) };
  for (const input of [{ target: '/root', message: '' }, { target: '/root', message: '   ' }, { target: '/root', message: 7 }, { ...event.tool_input, extra: true }]) {
    await assert.rejects(f.evaluate(f.policy, { ...event, tool_input: input }, childActor));
  }
  const denied = f.createNativePolicy(f.options, () => ({ decision: 'deny', reason: 'Fixed native denial' }));
  assert.deepEqual(await f.evaluate(denied, event, childActor), { decision: 'deny', reason: 'Fixed native denial' });
});

async function savedReportFixture(t) {
  const f = await completionFixture(t);
  const { readRecordedReport } = await import(pathToFileURL(join(f.plugin, "runtime/recorded-report.mjs")));
  const intake = await import(pathToFileURL(join(f.plugin, "runtime/report-intake.mjs")));
  appendReport(f); f.policy.completeChild(f.stop, f.native(childActor));
  const report = intake.readChildReport({ name: f.input.name }, f.native(session), f.options);
  const input = { assignment: report.assignment, reportHash: report.reportHash };
  return { ...f, intake, savedInput: input, readRecordedReport,
    record: () => intake.recordChildReport({ name: f.input.name, reportHash: report.reportHash }, f.native(session), f.options),
    read: (request = input, actor = session, options = f.options) => readRecordedReport(request, f.native(actor), options) };
}
const journalBytes = f => readdirSync(f.options.directory).sort().map(name => [name, readFileSync(join(f.options.directory, name), "utf8")]);

test("T43: chief reads only recorded evidence and retains it after transcript loss and off", async t => {
  const f = await savedReportFixture(t);
  assert.throws(() => f.read()); f.record();
  const before = journalBytes(f), state = f.core.readAdmission(f.options.directory);
  const expected = { decision: "recorded-report", ...f.savedInput, task: "T1", run: "R1", role: "lead",
    issuer: session, child: childActor, turn: turns[1], text: reportText };
  assert.deepEqual(f.read(), expected); assert.deepEqual(f.read(), expected);
  assert.deepEqual(journalBytes(f), before); assert.deepEqual(f.core.readAdmission(f.options.directory), state);
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  rmSync(f.mode.sessionsDir, { recursive: true });
  const off = journalBytes(f);
  assert.deepEqual(f.read(), expected); assert.deepEqual(journalBytes(f), off);
});

test("T43: chief report reader refuses forged inputs actors versions and scope without writes", async t => {
  const f = await savedReportFixture(t); f.record(); const before = journalBytes(f);
  for (const request of [null, [], {}, { ...f.savedInput, extra: true }, { ...f.savedInput, assignment: turns[0] },
    { ...f.savedInput, reportHash: "a".repeat(64) }, { ...f.savedInput, reportHash: 1 }]) assert.throws(() => f.read(request));
  for (const actor of [childActor, turns[0], null]) assert.throws(() => f.read(f.savedInput, actor));
  assert.throws(() => f.read(f.savedInput, session, { ...f.options, project: "other" }));
  assert.throws(() => f.readRecordedReport(f.savedInput, { version: "unsupported", actor: session }, f.options));
  assert.deepEqual(journalBytes(f), before);
});

test("T43: saved report reads refuse missing changed and conflicting recovery proof", async t => {
  const f = await savedReportFixture(t); f.record();
  const directory = join(f.options.observationsRoot, session);
  const proof = f.events.readObservations(directory).find(row => row.kind === "report-recovery-verified");
  const file = readdirSync(directory).find(name => name.endsWith(".json")
    && JSON.parse(readFileSync(join(directory, name), "utf8")).kind === "report-recovery-verified");
  rmSync(join(directory, file)); const before = journalBytes(f);
  assert.throws(() => f.read());
  f.events.publish(directory, { ...proof, receiptHash: "f".repeat(64) }); assert.throws(() => f.read());
  f.events.publish(directory, proof); assert.throws(() => f.read());
  assert.deepEqual(journalBytes(f), before);
});

test("T43: root chief reads a lead child's recorded review without parent authority", async t => {
  const f = await completionFixture(t);
  const { readRecordedReport } = await import(pathToFileURL(join(f.plugin, "runtime/recorded-report.mjs")));
  const qa = "a22422c7-509c-43aa-8c42-827c556f8a59", path = "/root/fixture_lead/qa_child";
  const request = { task: "T1", run: "R2", name: "qa_child", role: "qa", reviewCycle: 1, brief: f.input.brief };
  f.api.prepareNativeTask(request, f.native(childActor), f.options);
  const review = f.core.readAdmission(f.options.directory).preparations.find(row => row.name === request.name).review;
  const spawn = { ...f.spawnInput(request.name, "spawn-qa"), turn_id: turns[1], transcript_path: join(f.mode.sessionsDir, `${childActor}.jsonl`) };
  f.api.reservePreparedSpawn(spawn, f.native(childActor), f.options);
  f.events.publish(join(f.options.observationsRoot, session), { ...f.result, actor: childActor, call: "spawn-qa", turn: turns[1], path });
  const transcript = f.childTranscript({ child: qa, parent: childActor, path, turn: turns[2] });
  await f.evaluate(f.policy, { ...patch(turns[2]), transcript_path: transcript }, qa);
  appendReport(f, reportText, qa, turns[2]);
  f.policy.completeChild({ hook_event_name: "SubagentStop", session_id: session, agent_id: qa, turn_id: turns[2],
    transcript_path: join(f.mode.sessionsDir, `${childActor}.jsonl`) }, f.native(qa));
  const intake = await import(pathToFileURL(join(f.plugin, "runtime/report-intake.mjs")));
  assert.throws(() => intake.readChildReport({ name: request.name }, f.native(session), f.options));
  const report = intake.readChildReport({ name: request.name }, f.native(childActor), f.options);
  intake.recordChildReport({ name: request.name, reportHash: report.reportHash }, f.native(childActor), f.options);
  const input = { assignment: report.assignment, reportHash: report.reportHash }, before = journalBytes(f);
  const read = readRecordedReport(input, f.native(session), f.options);
  assert.equal(read.issuer, childActor); assert.equal(read.child, qa); assert.equal(read.role, "qa");
  assert.equal(read.text, reportText); assert.deepEqual(read.review, review);
  for (const actor of [childActor, qa]) assert.throws(() => readRecordedReport(input, f.native(actor), f.options));
  assert.throws(() => intake.readChildReport({ name: request.name }, f.native(session), f.options));
  assert.deepEqual(journalBytes(f), before);
});

test("T43: packaged v2 report reader needs no logbook and survives reconnect", async t => {
  const f = await savedReportFixture(t); f.record();
  const config = join(f.dir, "config.json");
  writeFileSync(config, JSON.stringify({ version: 2, mode: { ...f.mode, observationsRoot: f.options.observationsRoot } }));
  writeFileSync(f.entry, `import { serveConfiguredPreparations } from './plugin/runtime/configuration.mjs'; serveConfiguredPreparations(${JSON.stringify(config)});`);
  const expected = f.read(), before = journalBytes(f);
  const client = await connect(t, f, "0.160.0", "", "sage_read_recorded_report");
  assert.match((await client.call(f.savedInput, childActor)).error, /could not read/);
  assert.deepEqual(await client.call(f.savedInput), expected); await client.close();
  rmSync(join(f.mode.sessionsDir, `${childActor}.jsonl`));
  const retry = await connect(t, f, "0.160.0", "", "sage_read_recorded_report");
  assert.deepEqual(await retry.call(f.savedInput), expected); await retry.close();
  assert.deepEqual(journalBytes(f), before);
});

test("T43: recorded report proof cannot be replayed under another owner epoch", async t => {
  const f = await savedReportFixture(t); f.record();
  let previous = null;
  for (const name of readdirSync(f.options.directory).sort()) {
    const file = join(f.options.directory, name);
    const row = JSON.parse(readFileSync(file, "utf8").replaceAll(f.scope.epoch, turns[2]));
    const body = { schema: row.schema, revision: row.revision, previous, data: row.data };
    previous = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    writeFileSync(file, JSON.stringify({ ...body, hash: previous }) + "\n");
  }
  assert.equal(f.core.readAdmission(f.options.directory).sessions[0].epoch, turns[2]);
  const before = journalBytes(f);
  assert.throws(() => f.read()); assert.deepEqual(journalBytes(f), before);
});

test("T43: report reader refuses an admission change while checking recovery proof", async t => {
  const f = await savedReportFixture(t); f.record();
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const original = fs.openSync, directory = join(f.options.observationsRoot, session);
  let changed = false;
  t.mock.method(fs, "openSync", (file, ...args) => {
    if (!changed && typeof file === "string" && file.startsWith(`${directory}/`)) {
      changed = true;
      f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
    }
    return original(file, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.throws(() => f.read()); assert.equal(changed, true);
  t.mock.restoreAll(); syncBuiltinESMExports();
  assert.equal(f.read().text, reportText);
});

const nativeMergeRefusal = { decision: 'deny',
  reason: 'This Sage runtime cannot merge pull requests. Leave the reviewed pull request for the owner.' };
const nativeMergeCommands = [
  `gh pr merge 123 --squash --delete-branch --match-head-commit ${'a'.repeat(40)}`,
  'gh pr merge 123',
  'env gh pr merge 123 --squash',
  'sh -c "gh pr merge 123"',
  'gh api repos/example/project/pulls/123/merge --method PUT',
  'gh api graphql -f query="mutation { mergePullRequest(input: {pullRequestId: \\\"fixed\\\"}) { clientMutationId } }"',
  'gh pr merge "',
];

test('native mandatory merge refusal blocks the chief before a permissive evaluator', async t => {
  // Parser inputs only. These strings never reach a shell or GitHub.
  const f = await composedPolicyFixture(t); let evaluated = 0;
  const policy = f.createNativePolicy(f.options, () => { evaluated++; return { decision: 'pass' }; });
  for (const command of nativeMergeCommands) {
    const { input } = commandPolicyInput(f, session, command);
    assert.deepEqual(await f.evaluate(policy, input), nativeMergeRefusal, command);
    assert.equal(evaluated, 0);
  }
  for (const command of ['git status', 'printf "%s" "gh pr merge 123"']) {
    assert.deepEqual(await f.evaluate(policy, commandPolicyInput(f, session, command).input), { decision: 'pass' });
  }
  assert.equal(evaluated, 2);
});

test('native mandatory merge refusal blocks an implementer and preserves other evaluator denials', async t => {
  const f = await roleEditFixture(t, 'implementer'); let evaluated = 0;
  const policy = f.createNativePolicy(f.options, () => { evaluated++; return { decision: 'pass' }; });
  for (const command of nativeMergeCommands) {
    assert.deepEqual(await f.evaluate(policy, commandPolicyInput(f, childActor, command).input, childActor), nativeMergeRefusal, command);
    assert.equal(evaluated, 0);
  }
  const denied = { decision: 'deny', reason: 'Further command check refused.' };
  const other = f.createNativePolicy(f.options, () => { evaluated++; return denied; });
  assert.deepEqual(await f.evaluate(other, commandPolicyInput(f, childActor, 'git status').input, childActor), denied);
  assert.equal(evaluated, 1);
});

test('native mandatory merge refusal survives off for bound children and preserves ordinary off evaluation', async t => {
  const f = await roleEditFixture(t, 'implementer'); let evaluated = 0;
  const policy = f.createNativePolicy(f.options, () => { evaluated++; return { decision: 'pass' }; });
  // Bind the native child before changing mode.
  assert.deepEqual(await f.evaluate(policy, commandPolicyInput(f, childActor, 'git status').input, childActor), { decision: 'pass' });
  evaluated = 0;
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  for (const command of nativeMergeCommands) {
    assert.deepEqual(await f.evaluate(policy, commandPolicyInput(f, childActor, command).input, childActor), nativeMergeRefusal, command);
    assert.equal(evaluated, 0);
  }
  const chief = commandPolicyInput(f, session, nativeMergeCommands[0], turns[2]);
  assert.deepEqual(await f.evaluate(policy, chief.input), { decision: 'pass' });
  assert.equal(evaluated, 1);
  const unassigned = await composedPolicyFixture(t); let ordinaryCalls = 0;
  unassigned.core.changeAdmissionMode(unassigned.options.directory, { ...unassigned.scope, after: turns[0], turn: turns[2], sage: false });
  const ordinaryPolicy = unassigned.createNativePolicy(unassigned.options, () => { ordinaryCalls++; return { decision: 'pass' }; });
  const ordinary = commandPolicyInput(unassigned, childActor, nativeMergeCommands[0], turns[1], 'unassigned native child');
  assert.deepEqual(await unassigned.evaluate(ordinaryPolicy, ordinary.input, childActor), { decision: 'pass' });
  assert.equal(ordinaryCalls, 1);
  assert.equal(unassigned.core.readAdmission(unassigned.options.directory).bindings.length, 0);
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



test("native recorded run requires its exact saved recovery proof before writing", async t => {
  const f = await runReportFixture(t); f.record();
  const directory = join(f.options.observationsRoot, session);
  const names = readdirSync(directory).filter(name => name.endsWith(".json"));
  const proofs = names.filter(name => JSON.parse(readFileSync(join(directory, name), "utf8")).kind === "report-recovery-verified");
  assert.equal(proofs.length, 1);
  const file = join(directory, proofs[0]), bytes = readFileSync(file);
  const before = readFileSync(join(f.logbook, "runs.tsv"), "utf8");
  rmSync(file);
  assert.throws(() => f.finish());
  assert.equal(readFileSync(join(f.logbook, "runs.tsv"), "utf8"), before);
  writeFileSync(file, bytes);
  assert.equal(f.finish().decision, "run-finished");
});

function editAssignmentRows(f, table, change) {
  const file = join(f.assignmentLogbook, `${table}.tsv`), text = readFileSync(file, 'utf8');
  const lines = text.trimEnd().split('\n'), keys = lines.shift().split('\t');
  const rows = lines.map(line => Object.fromEntries(line.split('\t').map((value, index) => [keys[index], value])));
  const next = change(rows);
  writeFileSync(file, keys.join('\t') + '\n' + next.map(row => keys.map(key => row[key] ?? '').join('\t')).join('\n') + '\n');
  return () => writeFileSync(file, text);
}

test('T53: native assignment preparation requires one actual matching active task and run', async t => {
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

test('T53: native assignment dispatch rechecks records changed after preparation without taking capacity', async t => {
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


async function reviewPreparationFixture(t, role = "code-reviewer", size = "small") {
  const f = await composedPolicyFixture(t);
  const projectDirectory = join(f.dir, "project"); mkdirSync(projectDirectory);
  const env = { ...process.env, SAGE_HOME: join(f.dir, "logbook") };
  const git = (...args) => execFileSync("git", ["-C", projectDirectory, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "user.name=Fixture", "-c", "user.email=fixture@users.noreply.github.com", ...args], { env, encoding: "utf8" }).trim();
  git("init", "--quiet", "-b", "codex/t1-review");
  git("commit", "--quiet", "--allow-empty", "-m", "fixture");
  const tool = f.core.createStateTool({ defaultRoot: () => { throw Error("No ambient logbook"); } });
  const cli = (...args) => tool.sage([...args, "--project", projectDirectory], env);
  cli("init"); cli("task", "add", "--title", "Pinned review", "--size", size);
  cli("task", "T1", "set", "branch=codex/t1-review");
  cli("run", "add", "T1", "--role", role);
  mkdirSync(f.options.observationsRoot, { recursive: true });
  const options = { ...f.options, projectDirectory, logbookRoot: env.SAGE_HOME };
  const input = { ...f.input, role, reviewCycle: 1 };
  const prepare = (request = input) => f.api.prepareNativeTask(request, f.native(session), options);
  const logbook = tool.storeDir(projectDirectory, env);
  return { ...f, options, input, prepare, git, cli, tool, env, logbook };
}

test("T53: native review target captures the actual head round and cycle in immutable child instructions", async t => {
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

test("T53: native review target refuses stale heads before reservation and preserves the saved review", async t => {
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

test("T53: native review target rejects missing cycles foreign roles and changed run state", async t => {
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

test("T53: native review target ignores injected git selection and refuses a stale task round", async t => {
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

test("T53: native review target refuses redirected project logbooks and missing fixed options", async t => {
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



test('T53: native saved run target holds lead delegation and is delivered with the saved brief', async t => {
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


test('T53: native saved run target refuses a legacy unpinned preparation without replacing it', async t => {
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




test("T53: saved targets refuse valid retargets and changes during awaited evaluation", async t => {
  for (const change of ["branch", "round", "candidate", "status"]) {
    const f = await composedPolicyFixture(t);
    f.api.prepareNativeTask(f.input, f.native(session), f.options);
    const mutate = () => {
      const value = change === "branch" ? "codex/t1-other" : change === "round" ? "1" : change === "status" ? "done" : "other";
      editAssignmentRows(f, "runs", rows => rows.map(row => row.id === "R1" ? { ...row, [change]: value } : row));
      if (change === "branch" || change === "round") editAssignmentRows(f, "tasks", rows => rows.map(row => row.id === "T1" ? { ...row, [change]: value } : row));
    };
    const policy = f.createNativePolicy(f.options, async () => { await Promise.resolve(); mutate(); return { decision: "pass" }; });
    await assert.rejects(f.evaluate(policy));
    assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 0);
  }
});


test("T53: held tasks refuse new preparation and saved dispatch without ending the active run", async t => {
  for (const prepared of [false, true]) {
    const f = await preparationServerFixture(t);
    if (prepared) f.api.prepareNativeTask(f.input, f.native(session), f.options);
    const runs = f.assignmentTool.read(f.assignmentLogbook, "runs");
    const restore = editAssignmentRows(f, "tasks", rows => rows.map(row => row.id === "T1" ? { ...row, state: "held", hold: "Owner pause" } : row));
    assert.throws(() => prepared ? f.api.reservePreparedSpawn(f.spawnInput(), f.native(session), f.options)
      : f.api.prepareNativeTask(f.input, f.native(session), f.options), /is held/);
    assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 0);
    assert.deepEqual(f.assignmentTool.read(f.assignmentLogbook, "runs"), runs);
    assert.throws(() => f.assignmentTool.captureReviewTarget({ project: f.options.projectDirectory, task: "T1", run: "R2", role: "qa", cycle: 1 }, f.assignmentEnv), /is held/);
    restore();
    editAssignmentRows(f, "tasks", rows => rows.map(row => row.id === "T1" ? { ...row, hold: "Historical reason" } : row));
    assert.equal(f.api.prepareNativeTask(f.input, f.native(session), f.options).decision, prepared ? "already-prepared" : "prepared");
  }
});

async function preparedFollowupFixture(t, role = "lead", beforeComplete) {
  const f = await composedPolicyFixture(t);
  if (role === "qa") Object.assign(f.input, { role, run: "R2", reviewCycle: 1 });
  f.bindLead();
  const prior = f.core.readAdmission(f.options.directory).bindings[0];
  if (beforeComplete) await beforeComplete(f);
  f.core.completeAdmission(f.options.directory, prior);
  f.assignmentCli('run', 'done', f.input.run, '--status', 'done');
  f.assignmentCli('run', 'add', 'T1', '--role', role);
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
  assert.throws(() => f.api.reservePreparedSpawn({ ...f.spawnInput(f.request.name, 'wrong-spawn'), tool_input: { task_name: f.prepared.name, message: f.prepared.message, fork_turns: 'none' } }, f.native(session), f.options));
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



test('native follow-up dispatch keeps evaluator denial free of reservations', async t => {
  const f = await preparedFollowupFixture(t), before = f.core.readAdmission(f.options.directory);
  const policy = f.createNativePolicy(f.options, () => ({ decision: 'deny', reason: 'Fixture refused.' }));
  assert.deepEqual(await f.evaluate(policy, f.followupInput), { decision: 'deny', reason: 'Fixture refused.' });
  assert.deepEqual(f.core.readAdmission(f.options.directory), before);
});

test('native follow-up dispatch rechecks run review and held targets after awaited approval', async t => {
  for (const change of ['candidate', 'held', 'review']) {
    const f = await preparedFollowupFixture(t, change === 'review' ? 'qa' : 'lead');
    const before = f.core.readAdmission(f.options.directory);
    const policy = f.createNativePolicy(f.options, async () => {
      await Promise.resolve();
      if (change === 'held') editAssignmentRows(f, 'tasks', rows => rows.map(row => row.id === 'T1' ? {...row,state:'held',hold:'Owner pause'} : row));
      else if (change === 'candidate') editAssignmentRows(f, 'runs', rows => rows.map(row => row.id === 'R4' ? {...row,candidate:'other'} : row));
      else execFileSync('git',['-C',f.options.projectDirectory,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',
        '-c','user.name=Fixture','-c','user.email=fixture@users.noreply.github.com','commit','--quiet','--allow-empty','-m','Changed review target'],{env:f.assignmentEnv});
      return {decision:'pass'};
    });
    await assert.rejects(f.evaluate(policy, f.followupInput));
    assert.deepEqual(f.core.readAdmission(f.options.directory), before);
  }
});

test('native follow-up preparation requires a completed predecessor owned by the same actor', async t => {
  const f = await composedPolicyFixture(t); f.bindLead();
  const previous = f.core.readAdmission(f.options.directory).bindings[0].assignment;
  // The next run is independently valid; only admission completion is absent.
  f.assignmentCli('run','done','R1','--status','done'); f.assignmentCli('run','add','T1','--role','lead');
  const request = {...f.input,run:'R4',name:'continued',previous};
  assert.throws(()=>f.api.prepareNativeTask(request,f.native(session),f.options));
  const bound = f.core.readAdmission(f.options.directory).bindings[0];
  f.core.completeAdmission(f.options.directory,bound);
  const other = '44444444-4444-4444-8444-444444444444';
  f.core.activateAdmission(f.options.directory,{project:f.options.project,session:`codex:${other}`,activation:turns[0]});
  assert.throws(()=>f.api.prepareNativeTask(request,f.native(other),f.options));
  assert.equal(f.api.prepareNativeTask(request,f.native(session),f.options).target,childActor);
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length,1);
});

test('native current run refuses child tools after assignment or lifecycle changes', async t => {
  const f = await roleEditFixture(t, 'implementer'); let evaluated = 0;
  const policy = f.createNativePolicy(f.options, () => { evaluated++; return { decision: 'pass' }; });
  assert.deepEqual(await f.evaluate(policy, f.editInput, childActor), { decision: 'pass' });
  for (const [table, field, value] of [
    ['runs', 'status', 'done'], ['runs', 'ended', '2026-01-01T00:00:00Z'],
    ['runs', 'report', 'reports/saved.md'], ['runs', 'role', 'lead'], ['runs', 'task', 'T2'],
    ['runs', 'round', '1'], ['runs', 'branch', 'codex/t1-other'],
    ['tasks', 'state', 'held'], ['tasks', 'round', '1'], ['tasks', 'state', 'abandoned'], ['tasks', 'state', 'concluded'],
  ]) {
    const calls = evaluated;
    const restore = editAssignmentRows(f, table, rows => rows.map(row => row.id === (table === 'runs' ? 'R4' : 'T1') ? { ...row, [field]: value } : row));
    await assert.rejects(f.evaluate(policy, f.editInput, childActor), /active run|is held/, `${table}.${field}`);
    await assert.rejects(f.evaluate(policy, { ...f.editInput, tool_name: 'list_mcp_resources', tool_input: {} }, childActor), /active run|is held/);
    assert.equal(evaluated, calls, `${table}.${field} reached the evaluator`);
    restore();
  }
  assert.deepEqual(await f.evaluate(policy, f.editInput, childActor), { decision: 'pass' });
  editAssignmentRows(f, 'runs', rows => rows.map(row => row.id === 'R4' ? { ...row, status: 'done' } : row));
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  assert.deepEqual(await f.evaluate(policy, f.editInput, childActor), { decision: 'pass' });
});

test('native current run refuses permission when the assignment changes during evaluation', async t => {
  for (const change of ['done', 'candidate', 'branch', 'round', 'held']) {
    const f = await roleEditFixture(t, 'implementer'); let entered, release;
    const pending = new Promise(resolve => { entered = resolve; });
    const continueEvaluation = new Promise(resolve => { release = resolve; });
    const policy = f.createNativePolicy(f.options, async () => { entered(); await continueEvaluation; return { decision: 'pass' }; });
    const result = f.evaluate(policy, f.editInput, childActor);
    await pending;
    if (change === 'held') editAssignmentRows(f, 'tasks', rows => rows.map(row => row.id === 'T1' ? {...row,state:'held',hold:'Owner pause'} : row));
    if (change === 'done') editAssignmentRows(f, 'runs', rows => rows.map(row => row.id === 'R4' ? { ...row, status: 'done' } : row));
    if (change === 'candidate') editAssignmentRows(f, 'runs', rows => rows.map(row => row.id === 'R4' ? { ...row, candidate: 'changed' } : row));
    if (change === 'branch' || change === 'round') {
      const field = change, value = change === 'branch' ? 'codex/t1-other' : '1';
      editAssignmentRows(f, 'runs', rows => rows.map(row => row.id === 'R4' ? { ...row, [field]: value } : row));
      editAssignmentRows(f, 'tasks', rows => rows.map(row => row.id === 'T1' ? { ...row, [field]: value } : row));
    }
    release();
    await assert.rejects(result, /active run|could not evaluate|is held/, change);
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


test('T55: recovery refuses ended held and retargeted runs without changing admission', async t => {
  const f=await completionFixture(t),read=await assignmentReader(f),before=f.core.readAdmission(f.options.directory);
  assert.equal(read().run,'R1');
  for(const [table,field,value] of [['runs','status','done'],['tasks','state','held'],['runs','candidate','other']]) {
    const restore=editAssignmentRows(f,table,rows=>rows.map(row=>row.id===(table==='runs'?'R1':'T1')?{...row,[field]:value}:row));
    assert.throws(()=>read()); assert.deepEqual(f.core.readAdmission(f.options.directory),before); restore();
  }
  assert.equal(read().run,'R1');
});

test('T55: recovered reviewer instructions require the saved review commit and round', async t => {
  const f=await reviewPreparationFixture(t); f.prepare();
  const policy=f.createNativePolicy(f.options,()=>({decision:'pass'}));
  await f.evaluate(policy); f.events.publish(join(f.options.observationsRoot,session),f.result);
  await f.evaluate(policy,{...patch(turns[1]),tool_name:'list_mcp_resources',tool_input:{},transcript_path:f.childTranscript()},childActor);
  const read=await assignmentReader(f),saved=read(); assert.match(saved.message,/Review cycle: 1/);
  const sha=f.git('rev-parse','HEAD'); f.git('commit','--quiet','--allow-empty','-m','changed head');
  assert.throws(()=>read()); f.git('update-ref','refs/heads/codex/t1-review',sha);
  assert.deepEqual(read(),saved);
  const fixture={...f,assignmentLogbook:f.logbook};
  const undoTask=editAssignmentRows(fixture,'tasks',rows=>rows.map(row=>({...row,round:'1'})));
  const undoRun=editAssignmentRows(fixture,'runs',rows=>rows.map(row=>({...row,round:'1'})));
  assert.throws(()=>read()); undoRun();undoTask();assert.deepEqual(read(),saved);
});

test('T55: recovered completion refuses changed targets but preserves historical success and interruption', async t => {
  for(const change of ['held','candidate']) {
    const f=await completionFixture(t),read=await assignmentReader(f),transcript=f.childTranscript();
    appendRecoveryCheckpoint(transcript);appendAssignmentRecovery(transcript,read());
    f.policy.completeChild(f.stop,f.native(childActor));appendReport(f);
    const {reconcileNativeCompletions}=await import(pathToFileURL(join(f.plugin,'runtime/child-stop.mjs')));
    const reconcile=()=>reconcileNativeCompletions(f.native(session),session,f.options);
    const restore=change==='held'?editAssignmentRows(f,'tasks',rows=>rows.map(row=>row.id==='T1'?{...row,state:'held'}:row))
      :editAssignmentRows(f,'runs',rows=>rows.map(row=>row.id==='R1'?{...row,candidate:'other'}:row));
    assert.throws(reconcile);assert.equal(f.core.readAdmission(f.options.directory).completions?.length??0,0);
    restore();reconcile();const before=f.core.readAdmission(f.options.directory);
    editAssignmentRows(f,'runs',rows=>rows.map(row=>row.id==='R1'?{...row,status:'done'}:row));
    reconcile();assert.deepEqual(f.core.readAdmission(f.options.directory),before);
  }
  const f=await completionFixture(t),transcript=f.childTranscript();appendRecoveryCheckpoint(transcript);
  f.policy.completeChild(f.stop,f.native(childActor));
  editAssignmentRows(f,'tasks',rows=>rows.map(row=>row.id==='T1'?{...row,state:'held'}:row));
  appendFileSync(transcript,JSON.stringify({type:'event_msg',payload:{type:'turn_aborted',turn_id:turns[1],reason:'interrupted'}})+'\n');
  const {reconcileNativeCompletions}=await import(pathToFileURL(join(f.plugin,'runtime/child-stop.mjs')));
  reconcileNativeCompletions(f.native(session),session,f.options);
  assert.equal(f.core.readAdmission(f.options.directory).completions[0].outcome,'interrupted');
});

async function deliveredFollowupFixture(t, beforeComplete) {
  const f = await preparedFollowupFixture(t, "lead", beforeComplete);
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


test('T55: continuation recovery uses the new target and preserves prior report evidence', async t => {
  const f=await deliveredFollowupFixture(t);await f.evaluate(f.policy,f.tool,childActor);
  const read=await assignmentReader(f),prior=readFileSync(f.transcript,'utf8');
  const result=read();assert.equal(result.run,'R4');assert.equal(result.message,f.prepared.message);assert.equal(result.turn,turns[2]);
  assert.ok(prior.includes('RESULT first'));
  const restore=editAssignmentRows(f,'runs',rows=>rows.map(row=>row.id==='R4'?{...row,candidate:'changed'}:row));
  assert.throws(()=>read());assert.equal(readFileSync(f.transcript,'utf8'),prior);restore();assert.deepEqual(read(),result);
});

test('T55: recovered review completion checks the commit while interruption remains authoritative', async t => {
  for(const interrupted of [false,true]) {
    const f=await reviewPreparationFixture(t);f.prepare();
    const policy=f.createNativePolicy(f.options,()=>({decision:'pass'}));
    await f.evaluate(policy);f.events.publish(join(f.options.observationsRoot,session),f.result);
    const transcript=f.childTranscript();
    await f.evaluate(policy,{...patch(turns[1]),tool_name:'list_mcp_resources',tool_input:{},transcript_path:transcript},childActor);
    appendRecoveryCheckpoint(transcript);const read=await assignmentReader(f);appendAssignmentRecovery(transcript,read());
    const stop={hook_event_name:'SubagentStop',session_id:session,agent_id:childActor,turn_id:turns[1],transcript_path:join(f.mode.sessionsDir,'root.jsonl')};
    policy.completeChild(stop,f.native(childActor));
    if(interrupted) appendFileSync(transcript,JSON.stringify({type:'event_msg',payload:{type:'turn_aborted',turn_id:turns[1],reason:'interrupted'}})+'\n');
    else appendReport(f);
    const sha=f.git('rev-parse','HEAD');f.git('commit','--quiet','--allow-empty','-m','Changed review head');
    const {reconcileNativeCompletions}=await import(pathToFileURL(join(f.plugin,'runtime/child-stop.mjs')));
    const reconcile=()=>reconcileNativeCompletions(f.native(session),session,f.options);
    if(interrupted) {
      reconcile();assert.equal(f.core.readAdmission(f.options.directory).completions[0].outcome,'interrupted');
    } else {
      assert.throws(reconcile);assert.equal(f.core.readAdmission(f.options.directory).completions?.length??0,0);
      f.git('update-ref','refs/heads/codex/t1-review',sha);reconcile();
      assert.equal(f.core.readAdmission(f.options.directory).completions.length,1);
    }
  }
});

async function stopTaskWrite(t, f, table) {
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const original = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === join(f.logbook, `${table}.tsv`)) throw Object.assign(Error("Injected task write failure"), { code: "EIO" });
    return original(from, to);
  });
  syncBuiltinESMExports();
  const restore = () => { t.mock.restoreAll(); syncBuiltinESMExports(); };
  t.after(restore);
  return restore;
}

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
  const restore = await stopTaskWrite(t, f, 'decisions');
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
  const restore = await stopTaskWrite(t, f, 'decisions');
  assert.throws(() => f.create(), /Injected/); restore();
  appendFileSync(join(f.logbook, 'decisions.tsv'), 'changed outside the tool\n');
  assert.throws(() => f.create());
  assert.equal(existsSync(join(f.logbook, 'review-pending.json')), true);
  assert.deepEqual(existsSync(receipts) ? readdirSync(receipts) : [], []);
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


for (const view of ['merge', 'logbook']) test(`T56: ${view} refuses a fully published transaction between snapshot table reads`, async t => {
  const f = await taskCreationFixture(t), fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const sha = '1'.repeat(40);
  f.cli('task', 'add', '--title', 'Reviewed existing task', '--size', 'tiny');
  for (const kind of ['checks-pass', 'review-clean', 'qa-pass']) f.cli('verdict', 'T1', '--sha', sha, '--kind', kind);
  assert.equal(f.tool.mergeCheck(sha, f.env).ok, true, 'the stable snapshot permits this reviewed merge');
  const original = fs.openSync;
  let armed = true, committed = false;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (armed && file === join(f.logbook, 'decisions.tsv')) {
      armed = false;
      f.create();
      committed = true;
      assert.equal(existsSync(join(f.logbook, 'review-pending.json')), false);
    }
    return original(file, ...args);
  });
  syncBuiltinESMExports();
  try {
    if (view === 'merge') assert.equal(f.tool.mergeCheck(sha, f.env).ok, false);
    else assert.throws(() => f.tool.logbookView(f.options.projectDirectory, f.env), /created while/);
    assert.equal(committed, true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(f.tool.logbookView(f.options.projectDirectory, f.env).task('T2').title, f.input.title);
  assert.equal(f.tool.mergeCheck(sha, f.env).ok, true, 'the new stable snapshot still permits the reviewed merge');
});

test('T56: task publication recovers every table receipt and pending-marker failure boundary', async t => {
  for(const boundary of ['intent','tasks','decisions','receipt','clear']) {
    const f=await taskCreationFixture(t),fs=(await import('node:fs')).default;
    const {syncBuiltinESMExports}=await import('node:module');
    const method=['intent','receipt'].includes(boundary)?'linkSync':boundary==='clear'?'unlinkSync':'renameSync';
    const original=fs[method];let hit=false;
    t.mock.method(fs,method,(...args)=>{
      const to=String(args[method==='unlinkSync'?0:1]);
      if((boundary==='intent' && to===join(f.logbook,'review-pending.json'))
        || (boundary==='receipt' && to.startsWith(join(f.logbook,'task-requests')+'/'))
        || (boundary==='clear' && to===join(f.logbook,'review-pending.json'))
        || (['tasks','decisions'].includes(boundary) && to===join(f.logbook,`${boundary}.tsv`))) {
        hit=true;throw Object.assign(Error('Injected task publication failure'),{code:'EIO'});
      }
      return original(...args);
    });syncBuiltinESMExports();
    try {assert.throws(()=>f.create(),/Injected/);assert.equal(hit,true);}
    finally {t.mock.restoreAll();syncBuiltinESMExports();}
    if(boundary!=='intent') assert.throws(()=>f.create({...f.input,title:'Different request'}));
    assert.equal(f.create().decision,'task-created');assert.equal(f.create().decision,'already-created');
    assert.equal(f.tool.read(f.logbook,'tasks').length,1);assert.equal(f.tool.read(f.logbook,'decisions').length,1);
    assert.equal(existsSync(join(f.logbook,'review-pending.json')),false);
  }
});

test('T56: malformed durable task records and deleted tasks cannot authorize duplicate creation', async t => {
  for(const damage of ['intent','receipt','deleted']) {
    const f=await taskCreationFixture(t);
    if(damage==='intent') {
      const restore=await stopTaskWrite(t,f,'decisions');assert.throws(()=>f.create());restore();
      writeFileSync(join(f.logbook,'review-pending.json'),'{}');
    } else {
      f.create();
      if(damage==='receipt') writeFileSync(join(f.logbook,'task-requests',readdirSync(join(f.logbook,'task-requests'))[0]),'{}');
      else {const file=join(f.logbook,'tasks.tsv');writeFileSync(file,readFileSync(file,'utf8').split('\n')[0]+'\n');}
    }
    const before=Object.fromEntries(['tasks','decisions'].map(name=>[name,readFileSync(join(f.logbook,`${name}.tsv`),'utf8')]));
    assert.throws(()=>f.create());assert.deepEqual(Object.fromEntries(Object.keys(before).map(name=>[name,readFileSync(join(f.logbook,`${name}.tsv`),'utf8')])),before);
  }
});

test('T56: distinct owners keep separate task requests and exact retry preserves later edits', async t => {
  const f=await taskCreationFixture(t),first=f.create();
  f.core.activateAdmission(f.options.directory,{project:f.options.project,session:`codex:${turns[2]}`,activation:turns[0]});
  const second=f.create(f.input,turns[2]);assert.equal(second.task.id,'T2');
  f.cli('task','T1','set','title=Updated outside request');
  const before=readFileSync(join(f.logbook,'tasks.tsv'),'utf8');
  assert.deepEqual(f.create(),{...first,decision:'already-created'});
  assert.equal(readFileSync(join(f.logbook,'tasks.tsv'),'utf8'),before);
  assert.equal(f.tool.read(f.logbook,'tasks')[0].title,'Updated outside request');
});

test('T56: read-only aliases remain valid and missing task tables cannot approve a merge', async t => {
  const f=await taskCreationFixture(t);f.create();
  const alias=join(f.dir,'alias');symlinkSync(f.options.logbookRoot,alias,'dir');
  const env={...f.env,SAGE_HOME:alias};
  assert.equal(f.tool.logbookView(f.options.projectDirectory,env).task('T1').title,f.input.title);
  assert.equal(f.tool.mergeCheck('1'.repeat(40),env).ok,false);
  const file=join(f.logbook,'tasks.tsv');rmSync(file);
  writeFileSync(join(f.logbook,'review-pending.json'),'{}');
  assert.equal(f.tool.mergeCheck('1'.repeat(40),f.env).ok,false);
  assert.throws(()=>f.tool.logbookView(f.options.projectDirectory,f.env));
  const empty=await taskCreationFixture(t);rmSync(join(empty.logbook,'tasks.tsv'));
  writeFileSync(join(empty.logbook,'review-pending.json'),'{}');
  assert.equal(empty.tool.logbookView(empty.options.projectDirectory,empty.env).task('T1'),undefined);
  assert.equal(empty.tool.mergeCheck('1'.repeat(40),empty.env).ok,false);
  assert.throws(()=>empty.cli('init'),/incomplete/);
});


test('T56: checksum-valid malformed receipt values cannot publish another task', async t => {
  for (const value of [null, false, 0, '', true, 1, [], {}]) await t.test(JSON.stringify(value), async t => {
    const f = await taskCreationFixture(t);
    f.create();
    const folder = join(f.logbook, 'task-requests');
    const receipt = join(folder, readdirSync(folder)[0]);
    const damaged = JSON.stringify({ value, hash: createHash('sha256').update(JSON.stringify(value)).digest('hex') }) + '\n';
    writeFileSync(receipt, damaged);
    const before = Object.fromEntries(['tasks', 'decisions'].map(name => [name, readFileSync(join(f.logbook, `${name}.tsv`), 'utf8')]));
    assert.throws(() => f.create());
    assert.deepEqual(Object.fromEntries(Object.keys(before).map(name => [name, readFileSync(join(f.logbook, `${name}.tsv`), 'utf8')])), before);
    assert.equal(existsSync(join(f.logbook, 'review-pending.json')), false);
    assert.equal(readFileSync(receipt, 'utf8'), damaged);
    assert.equal(readdirSync(folder).length, 1);
  });
});


test('T56: malformed saved task results refuse before recovery publishes tables', async t => {
  for (const result of [null, false, {}, { id: 'T1' }, { id: 'T999', title: 'changed' }]) await t.test(JSON.stringify(result), async t => {
    const f = await taskCreationFixture(t);
    const restore = await stopTaskWrite(t, f, 'tasks');
    assert.throws(() => f.create());
    restore();
    const pending = join(f.logbook, 'review-pending.json');
    const record = JSON.parse(readFileSync(pending, 'utf8'));
    record.value.receipt.result = result;
    record.hash = createHash('sha256').update(JSON.stringify(record.value)).digest('hex');
    const damaged = JSON.stringify(record) + '\n';
    writeFileSync(pending, damaged);
    const before = Object.fromEntries(['tasks', 'decisions'].map(name => [name, readFileSync(join(f.logbook, `${name}.tsv`), 'utf8')]));
    assert.throws(() => f.create());
    assert.deepEqual(Object.fromEntries(Object.keys(before).map(name => [name, readFileSync(join(f.logbook, `${name}.tsv`), 'utf8')])), before);
    assert.equal(readFileSync(pending, 'utf8'), damaged);
    assert.deepEqual(existsSync(join(f.logbook, 'task-requests')) ? readdirSync(join(f.logbook, 'task-requests')) : [], []);
  });
});


test('T56: recovery preflights table meaning and receipt destinations before publication', async t => {
  for (const damage of ['task-after', 'decision-after', 'receipt-conflict', 'receipt-alias']) await t.test(damage, async t => {
    const f = await taskCreationFixture(t);
    f.cli('task', 'add', '--title', 'Keep this task', '--size', 'tiny');
    const restore = await stopTaskWrite(t, f, 'tasks');
    assert.throws(() => f.create());
    restore();
    const pending = join(f.logbook, 'review-pending.json');
    const record = JSON.parse(readFileSync(pending, 'utf8'));
    if (damage === 'task-after') record.value.tables.tasks.after = record.value.tables.tasks.after.replace('Keep this task', 'Unrelated rewrite');
    if (damage === 'decision-after') record.value.tables.decisions.after = record.value.tables.decisions.before;
    record.hash = createHash('sha256').update(JSON.stringify(record.value)).digest('hex');
    const damaged = JSON.stringify(record) + '\n';
    writeFileSync(pending, damaged);
    const folder = join(f.logbook, 'task-requests');
    if (damage === 'receipt-alias') { const elsewhere = join(f.dir, 'elsewhere'); mkdirSync(elsewhere); if (existsSync(folder)) { assert.deepEqual(readdirSync(folder), []); rmSync(folder, { recursive: true }); } symlinkSync(elsewhere, folder, 'dir'); }
    if (damage === 'receipt-conflict') {
      mkdirSync(folder, { recursive: true });
      const { owner, request } = record.value.receipt.reference;
      writeFileSync(join(folder, createHash('sha256').update(JSON.stringify([owner, request])).digest('hex') + '.json'), 'conflict');
    }
    const before = Object.fromEntries(['tasks', 'decisions'].map(name => [name, readFileSync(join(f.logbook, `${name}.tsv`), 'utf8')]));
    const receipts = existsSync(folder) ? readdirSync(folder) : [];
    assert.throws(() => f.create());
    assert.deepEqual(Object.fromEntries(Object.keys(before).map(name => [name, readFileSync(join(f.logbook, `${name}.tsv`), 'utf8')])), before);
    assert.equal(readFileSync(pending, 'utf8'), damaged);
    assert.deepEqual(existsSync(folder) ? readdirSync(folder) : [], receipts);
  });
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
  assert.deepEqual(existsSync(join(f.logbook, 'run-requests')) ? readdirSync(join(f.logbook, 'run-requests')) : [], []);
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
  const restore = await stopTaskWrite(t, f, 'runs');
  assert.throws(() => f.createRun(), /Injected/); restore();
  assert.equal(f.tool.read(f.logbook, 'runs').length, 0);
  appendFileSync(join(f.logbook, 'runs.tsv'), 'unrelated change\n');
  assert.throws(() => f.createRun());
  assert.equal(existsSync(join(f.logbook, 'review-pending.json')), true);
  assert.deepEqual(existsSync(join(f.logbook, 'run-requests')) ? readdirSync(join(f.logbook, 'run-requests')) : [], []);
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

test('native run creation retains merged lead uniqueness and project capacity', async t => {
  const f = await runCreationFixture(t);
  assert.equal(f.createRun().run.id, 'R1');
  assert.throws(() => f.createRun({...f.input, request: turns[2]}), /one running lead/);
  for (const task of ['T2', 'T3', 'T4']) f.cli('task', 'add', '--title', task, '--size', 'small');
  f.cli('run', 'add', 'T2', '--role', 'lead');
  f.cli('run', 'add', 'T3', '--role', 'lead');
  const next = {...f.input, request: turns[2], task: 'T4'};
  assert.throws(() => f.createRun(next), /3 running lead runs/);
  assert.equal(f.tool.read(f.logbook, 'runs').length, 3);
  f.cli('run', 'done', 'R1', '--status', 'done');
  assert.equal(f.createRun(next).run.task, 'T4');
  assert.equal(f.tool.read(f.logbook, 'runs').filter(run => run.status === 'running' && run.role === 'lead').length, 3);
});

test('native run creation retains merged role and lead task eligibility rules', async t => {
  const f = await runCreationFixture(t);
  assert.throws(() => f.createRun({...f.input, role: 'unknown-role'}), /not a role of a run/);
  f.cli('task', 'add', '--title', 'investigation', '--size', 'investigate');
  assert.throws(() => f.createRun({...f.input, task: 'T2'}), /investigation/);
  f.cli('task', 'T1', 'set', 'state=abandoned');
  assert.throws(() => f.createRun(), /task has ended/);
  assert.equal(f.tool.read(f.logbook, 'runs').length, 0);
  assert.equal(f.createRun({...f.input, task: 'T2', role: 'investigate'}).run.role, 'investigate');
});


test('T57: held tasks refuse new runs while exact historical retries remain unchanged', async t => {
  const f = await runCreationFixture(t), first = f.createRun();
  f.cli('run', 'done', 'R1', '--status', 'done');
  for (const state of ['briefed', 'building', 'held']) f.cli('task', 'T1', 'set', `state=${state}`);
  const before = readFileSync(join(f.logbook, 'runs.tsv'), 'utf8');
  const receipts = readdirSync(join(f.logbook, 'run-requests'));
  assert.throws(() => f.createRun({ ...f.input, request: turns[2], role: 'qa' }));
  assert.deepEqual(f.createRun(), { ...first, decision: 'already-created' });
  assert.equal(readFileSync(join(f.logbook, 'runs.tsv'), 'utf8'), before);
  assert.deepEqual(readdirSync(join(f.logbook, 'run-requests')), receipts);
  assert.equal(existsSync(join(f.logbook, 'review-pending.json')), false);
});

test('T57: run framing matches CLI normalization and preserves saved model round candidate and time', async t => {
  const f = await runCreationFixture(t);
  f.cli('config', 'cycles.small=2');
  f.cli('run', 'add', 'T1', '--role', 'QA ', '--candidate', 'candidate-a');
  const first = f.createRun({ ...f.input, role: 'qa', candidate: 'candidate-a' });
  const cli = f.tool.read(f.logbook, 'runs')[0];
  for (const key of ['task', 'role', 'round', 'candidate', 'branch', 'status', 'model']) assert.equal(first.run[key], cli[key]);
  assert.equal(first.run.model, '');
  f.cli('run', 'done', first.run.id, '--status', 'done');
  f.cli('config', 'cycles.small=3');
  const before = readFileSync(join(f.logbook, 'runs.tsv'), 'utf8');
  assert.deepEqual(f.createRun({ ...f.input, role: 'qa', candidate: 'candidate-a' }), { ...first, decision: 'already-created' });
  assert.equal(readFileSync(join(f.logbook, 'runs.tsv'), 'utf8'), before);
});

test('T57: separate owners and concurrent exact retries create only their own runs', async t => {
  const f = await runCreationFixture(t), input = { ...f.input, role: 'qa' };
  const clients = await Promise.all([connect(t, f, '0.160.0', '', 'sage_create_run'), connect(t, f, '0.160.0', '', 'sage_create_run')]);
  const outputs = await Promise.all(clients.map(client => client.call(input)));
  assert.deepEqual(outputs.map(row => row.decision).sort(), ['already-created', 'run-created']);
  assert.deepEqual(outputs[0].run, outputs[1].run);
  await Promise.all(clients.map(client => client.close()));
  f.core.activateAdmission(f.options.directory, { project: f.options.project, session: `codex:${turns[2]}`, activation: turns[0] });
  assert.equal(f.createRun(input, turns[2]).run.id, 'R2');
  assert.equal(f.tool.read(f.logbook, 'runs').length, 2);
});

for (const view of ['merge', 'logbook']) test(`T57: ${view} refuses a completed run transaction between table reads`, async t => {
  const f = await runCreationFixture(t), sha = '1'.repeat(40);
  for (const cycle of ['1', '2']) for (const kind of ['checks-pass', 'review-clean', 'security-clean', 'ux-clean', 'qa-pass'])
    f.cli('verdict', 'T1', '--sha', sha, '--kind', kind, '--cycle', cycle);
  assert.equal(f.tool.mergeCheck(sha, f.env).ok, true);
  const fs = (await import('node:fs')).default, { syncBuiltinESMExports } = await import('node:module');
  const original = fs.openSync; let armed = true, committed = false;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (armed && file === join(f.logbook, 'decisions.tsv')) {
      armed = false; f.createRun(); committed = true;
      assert.equal(existsSync(join(f.logbook, 'review-pending.json')), false);
    }
    return original(file, ...args);
  }); syncBuiltinESMExports();
  try {
    if (view === 'merge') assert.equal(f.tool.mergeCheck(sha, f.env).ok, false);
    else assert.throws(() => f.tool.logbookView(f.options.projectDirectory, f.env));
    assert.equal(committed, true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(f.tool.mergeCheck(sha, f.env).ok, true);
});

test('T57: malformed saved run result or delta refuses before any recovery publication', async t => {
  for (const damage of ['null', 'array-id', 'round', 'model', 'time', 'array-time', 'role', 'after', 'receipt']) await t.test(damage, async t => {
    const f = await runCreationFixture(t);
    const restore = await stopTaskWrite(t, f, 'runs'); assert.throws(() => f.createRun()); restore();
    const pending = join(f.logbook, 'review-pending.json'), record = JSON.parse(readFileSync(pending, 'utf8'));
    const result = record.value.receipt.result;
    if (damage === 'null') record.value.receipt.result = null;
    if (damage === 'array-id') result.id = [result.id];
    if (damage === 'array-time') result.started = [result.started];
    if (damage === 'round') result.round = '9007199254740992';
    if (damage === 'model') result.model = 'line\nbreak';
    if (damage === 'time') result.started = '2026-02-30T00:00:00Z';
    if (damage === 'role') result.role = 'qa';
    if (damage === 'after') record.value.tables.runs.after += record.value.tables.runs.after.split('\n')[1] + '\n';
    record.hash = createHash('sha256').update(JSON.stringify(record.value)).digest('hex');
    const saved = JSON.stringify(record) + '\n'; writeFileSync(pending, saved);
    const folder = join(f.logbook, 'run-requests');
    if (damage === 'receipt') {
      const { owner, request } = record.value.receipt.reference;
      writeFileSync(join(folder, createHash('sha256').update(JSON.stringify([owner, request])).digest('hex') + '.json'), 'conflicting receipt');
    }
    const before = readFileSync(join(f.logbook, 'runs.tsv'), 'utf8'), receipts = readdirSync(folder);
    assert.throws(() => f.createRun());
    assert.equal(readFileSync(join(f.logbook, 'runs.tsv'), 'utf8'), before);
    assert.equal(readFileSync(pending, 'utf8'), saved);
    assert.deepEqual(readdirSync(folder), receipts);
  });
});


test('T57: core historical run receipts preserve the selected model after provider settings change', async t => {
  const f = await runCreationFixture(t);
  const tool = f.core.createStateTool({ defaultRoot: () => { throw Error('No ambient logbook'); }, models: ['inherit', 'first-model', 'second-model'] });
  const cli = (...args) => tool.sage([...args, '--project', f.options.projectDirectory], f.env);
  cli('config', 'model.qa.small=first-model');
  const input = { ...f.input, role: 'qa', project: f.options.projectDirectory, owner: 'test-owner' };
  const first = tool.createRequestedRun(input, f.env); assert.equal(first.run.model, 'first-model');
  cli('run', 'done', first.run.id, '--status', 'done'); cli('config', 'model.qa.small=second-model');
  const before = readFileSync(join(f.logbook, 'runs.tsv'), 'utf8');
  assert.deepEqual(tool.createRequestedRun(input, f.env), { ...first, decision: 'already-created' });
  assert.equal(readFileSync(join(f.logbook, 'runs.tsv'), 'utf8'), before);
  assert.equal(tool.createRequestedRun({ ...input, request: turns[2] }, f.env).run.model, 'second-model');
});


test('T57: historical run receipts preserve a nonzero round and timestamp after clock advancement', async t => {
  const f = await runCreationFixture(t);
  for (const state of ['briefed', 'building', 'reviewing']) f.cli('task', 'T1', 'set', `state=${state}`);
  f.cli('finding', 'add', 'T1', '--key', 'F-T1-1', '--source', 'code-review', '--severity', 'medium', '--summary', 'Repair fixture');
  f.cli('finding', 'triage', 'T1', 'F-T1-1', 'fix');
  f.cli('round', 'T1');
  assert.equal(f.tool.read(f.logbook, 'tasks')[0].round, '1');
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-02T03:04:05Z') });
  const first = f.createRun();
  assert.equal(first.run.round, '1');
  assert.equal(first.run.started, '2026-01-02T03:04:05Z');
  f.cli('run', 'done', first.run.id, '--status', 'done');
  const before = readFileSync(join(f.logbook, 'runs.tsv'), 'utf8');
  t.mock.timers.setTime(Date.parse('2026-02-03T04:05:06Z'));
  assert.deepEqual(f.createRun(), { ...first, decision: 'already-created' });
  assert.equal(readFileSync(join(f.logbook, 'runs.tsv'), 'utf8'), before);
});

test('T58: wrong-typed saved task IDs refuse without changing recorded state', async t => {
  for (const kind of ['receipt', 'intent']) {
    const f = await taskCreationFixture(t);
    if (kind === 'intent') {
      const restore = await stopTaskWrite(t, f, 'tasks');
      assert.throws(() => f.create(), /Injected task write failure/);
      restore();
    } else f.create();
    const folder = join(f.logbook, 'task-requests');
    const pending = join(f.logbook, 'review-pending.json');
    const file = kind === 'receipt' ? join(folder, readdirSync(folder)[0]) : pending;
    const record = JSON.parse(readFileSync(file, 'utf8'));
    const receipt = kind === 'receipt' ? record.value : record.value.receipt;
    receipt.result.id = ['T1'];
    record.hash = createHash('sha256').update(JSON.stringify(record.value)).digest('hex');
    writeFileSync(file, JSON.stringify(record) + '\n');
    const tables = readdirSync(f.logbook).filter(name => name.endsWith('.tsv'));
    const before = Object.fromEntries(tables.map(name => [name, readFileSync(join(f.logbook, name), 'utf8')]));
    const pendingBefore = existsSync(pending) ? readFileSync(pending, 'utf8') : undefined;
    const readReceipts = () => Object.fromEntries((existsSync(folder) ? readdirSync(folder) : [])
      .map(name => [name, readFileSync(join(folder, name), 'utf8')]));
    const receiptsBefore = readReceipts();
    assert.throws(() => f.create());
    assert.deepEqual(Object.fromEntries(tables.map(name => [name, readFileSync(join(f.logbook, name), 'utf8')])), before, kind);
    assert.equal(existsSync(pending) ? readFileSync(pending, 'utf8') : undefined, pendingBefore, kind);
    assert.deepEqual(readReceipts(), receiptsBefore, kind);
  }
});

async function reviewAcceptanceFixture(t, { role = "code-reviewer", findings = [], overrides = {}, finish = true, size = "small" } = {}) {
  const f = await reviewPreparationFixture(t, role, size);
  const preparation = f.prepare();
  const policy = f.createNativePolicy(f.options, () => ({ decision: "pass" }));
  await f.evaluate(policy);
  f.events.publish(join(f.options.observationsRoot, session), f.result);
  const transcript = f.childTranscript();
  await f.evaluate(policy, { ...patch(turns[1]), tool_name: "list_mcp_resources", tool_input: {}, transcript_path: transcript }, childActor);
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
  test(`T59: review acceptance records ${role} evidence once without approving a task or merge`, async t => {
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

test("T59: review acceptance keeps low findings open and blocking findings return verified work to reviewing", async t => {
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

test("T59: review acceptance rejects stale commits rounds unfinished runs foreign actors and conflicting report claims", async t => {
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
for (const table of ["tasks", "findings", "ledger", "decisions"]) test(`T59: review acceptance recovers a failed ${table} write and blocks merging while incomplete`, async t => {
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

test("T59: review acceptance recovery preserves unexpected table changes and refuses damaged pending evidence", async t => {
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

test("T59: packaged review acceptance requires the chief and preserves one verdict after reconnect", async t => {
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


test("T59: review acceptance during a merge read cannot hide a new open finding", async t => {
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


test('T59: a held task refuses fresh review but preserves a historical acceptance', async t => {
  const f = await reviewAcceptanceFixture(t);
  fixtureTaskField(f, 'state', 'held');
  const before = readFileSync(join(f.logbook, 'tasks.tsv'), 'utf8');
  assert.throws(() => f.accept());
  assert.equal(f.tool.read(f.logbook, 'ledger').length, 0);
  assert.equal(readFileSync(join(f.logbook, 'tasks.tsv'), 'utf8'), before);
  assert.equal(existsSync(join(f.logbook, 'review-pending.json')), false);
  fixtureTaskField(f, 'state', 'reviewing');
  const result = f.accept();
  fixtureTaskField(f, 'state', 'held');
  assert.deepEqual(f.accept(), {...result, decision:'already-accepted'});
  assert.equal(f.tool.read(f.logbook, 'tasks')[0].state, 'held');
});

test('T59: checks evidence coexists with one review while a second review is refused', async t => {
  for (const kind of ['checks-pass', 'checks-fail']) {
    const f = await reviewAcceptanceFixture(t);
    f.cli('verdict','T1','--sha',f.preparation.review.sha,'--kind',kind,'--run','R1');
    assert.equal(f.accept().kind, 'review-clean');
    assert.deepEqual(f.tool.read(f.logbook, 'ledger').map(row => row.kind), [kind, 'review-clean']);
  }
  const f = await reviewAcceptanceFixture(t);
  f.cli('verdict','T1','--sha',f.preparation.review.sha,'--kind','review-clean','--run','R1');
  const before = readFileSync(join(f.logbook,'ledger.tsv'),'utf8');
  assert.throws(() => f.accept());
  assert.equal(readFileSync(join(f.logbook,'ledger.tsv'),'utf8'), before);
  assert.equal(existsSync(join(f.logbook,'review-pending.json')), false);
});

test('T59: QA failure preserves all findings and returns pr-ready work to reviewing', async t => {
  const f = await reviewAcceptanceFixture(t, {role:'qa', findings:[{severity:'medium',summary:'A failed result'}]});
  fixtureTaskField(f,'state','pr-ready');
  assert.equal(f.accept().kind,'qa-fail');
  assert.equal(f.tool.read(f.logbook,'tasks')[0].state,'reviewing');
  assert.equal(f.tool.read(f.logbook,'findings')[0].source,'qa');
  assert.equal(f.tool.read(f.logbook,'decisions').at(-1).decision,'pr-ready → reviewing');
});

const reviewTables = f => Object.fromEntries(['tasks','findings','ledger','decisions'].map(table => [table,readFileSync(join(f.logbook,`${table}.tsv`),'utf8')]));
test('T59: checksum-valid malformed review records and deltas refuse before publication', async t => {
  for (const damage of ['null','false','array-id','array-time','bad-time','extra-result','wrong-kind','missing-key','extra-key','tasks','findings','ledger','decisions','tasks-prior','findings-prior','ledger-prior','decisions-prior','receipt-conflict','receipt-alias']) await t.test(damage, async t => {
    const f = await reviewAcceptanceFixture(t, {findings:[{severity:'high',summary:'Keep this finding'}]});
    fixtureTaskField(f,'state','verified');
    f.cli('task','add','--title','Keep prior task','--size','tiny');
    f.cli('finding','add','T1','--source','code-reviewer','--severity','low','--summary','Keep prior finding');
    f.cli('verdict','T1','--sha',f.preparation.review.sha,'--kind','checks-pass');
    f.cli('log','T1','Keep prior decision','--why','Existing evidence');
    const restore = await stopReviewWrite(t,f,'tasks');
    assert.throws(() => f.accept(), /Injected/); restore();
    const file=join(f.logbook,'review-pending.json'), record=JSON.parse(readFileSync(file,'utf8'));
    const result=record.value.receipt.result;
    if(damage==='null') record.value.receipt.result=null;
    if(damage==='false') record.value.receipt.result=false;
    if(damage==='array-id') result.task=['T1'];
    if(damage==='array-time') result.at=[result.at];
    if(damage==='extra-key') result.findings.push('F-extra');
    if(damage.endsWith('-prior')) { const table=damage.slice(0,-6), lines=record.value.tables[table].after.split('\n'); lines[1]+='corrupted'; record.value.tables[table].after=lines.join('\n'); }
    if(damage==='bad-time') result.at='2026-02-30T00:00:00Z';
    if(damage==='extra-result') result.extra=true;
    if(damage==='wrong-kind') result.kind='review-clean';
    if(damage==='missing-key') result.findings=[];
    if(['tasks','findings','ledger','decisions'].includes(damage)) record.value.tables[damage].after=record.value.tables[damage].before;
    record.hash=createHash('sha256').update(JSON.stringify(record.value)).digest('hex');
    const bytes=JSON.stringify(record)+'\n'; writeFileSync(file,bytes);
    const folder=join(f.logbook,'reviews');
    if(damage==='receipt-alias') { const outside=join(f.dir,'redirected');mkdirSync(outside);if(existsSync(folder))rmSync(folder,{recursive:true});symlinkSync(outside,folder); }
    if(damage==='receipt-conflict') { mkdirSync(folder,{recursive:true});writeFileSync(join(folder,`${f.acceptInput.assignment}-${f.acceptInput.reportHash}.json`),'conflict'); }
    const before=reviewTables(f), receipts=existsSync(folder)?readdirSync(folder):[];
    assert.throws(() => f.accept());
    assert.deepEqual(reviewTables(f),before);assert.equal(readFileSync(file,'utf8'),bytes);
    assert.deepEqual(existsSync(folder)?readdirSync(folder):[],receipts);
  });
});

test('T59: present malformed review receipt values never republish tables', async t => {
  for (const value of [null,false,0,[],{}]) await t.test(JSON.stringify(value), async t => {
    const f=await reviewAcceptanceFixture(t);f.accept();
    const file=join(f.logbook,'reviews',`${f.acceptInput.assignment}-${f.acceptInput.reportHash}.json`);
    const bytes=JSON.stringify({value,hash:createHash('sha256').update(JSON.stringify(value)).digest('hex')})+'\n';writeFileSync(file,bytes);
    const before=reviewTables(f);assert.throws(()=>f.accept());assert.deepEqual(reviewTables(f),before);
    assert.equal(readFileSync(file,'utf8'),bytes);assert.equal(existsSync(join(f.logbook,'review-pending.json')),false);
  });
});

test('T59: concurrent chief connections publish one review receipt', async t => {
  const f=await reviewAcceptanceFixture(t);
  writeFileSync(f.entry,`import { servePreparations } from './plugin/runtime/preparation-server.mjs'; servePreparations(${JSON.stringify(f.options)});`);
  const clients=await Promise.all([connect(t,f,'0.160.0','','sage_accept_review'),connect(t,f,'0.160.0','','sage_accept_review')]);
  const results=await Promise.allSettled(clients.map(client=>client.call(f.acceptInput)));
  await Promise.all(clients.map(client=>client.close()));
  assert(results.every(result=>result.status==='fulfilled'));
  assert.deepEqual(results.map(result=>result.value.decision).sort(),['already-accepted','review-accepted']);
  assert.equal(f.tool.read(f.logbook,'ledger').length,1);
  assert.equal(readdirSync(join(f.logbook,'reviews')).length,1);
});

for (const boundary of ['intent','receipt','cleanup']) test(`T59: review publication retries safely after ${boundary} failure`, async t => {
  const f=await reviewAcceptanceFixture(t,{findings:[{severity:'medium',summary:'Retained finding'}]});
  fixtureTaskField(f,'state','verified');
  const fs=(await import('node:fs')).default, {syncBuiltinESMExports}=await import('node:module');
  const method=boundary==='cleanup'?'unlinkSync':'linkSync', original=fs[method];
  const destination=boundary==='receipt'?join(f.logbook,'reviews',`${f.acceptInput.assignment}-${f.acceptInput.reportHash}.json`):join(f.logbook,'review-pending.json');
  t.mock.method(fs,method,(...args)=>{if(args[boundary==='cleanup'?0:1]===destination)throw Error('Injected publication boundary');return original(...args);});
  syncBuiltinESMExports();
  const restore=()=>{t.mock.restoreAll();syncBuiltinESMExports();};t.after(restore);
  assert.throws(()=>f.accept(),/Injected publication boundary/);restore();
  const result=f.accept(); assert.equal(result.decision,'review-accepted');
  assert.equal(f.tool.read(f.logbook,'ledger').length,1);assert.equal(f.tool.read(f.logbook,'findings').length,1);
  assert.equal(f.tool.read(f.logbook,'tasks')[0].state,'reviewing');assert.equal(existsSync(join(f.logbook,'review-pending.json')),false);
  assert.deepEqual(f.accept(),{...result,decision:'already-accepted'});
});

test('T59: saved report recovery proof is required for review acceptance', async t => {
  const f=await reviewAcceptanceFixture(t), directory=join(f.options.observationsRoot,session);
  const proofs=readdirSync(directory).filter(name=>name.endsWith('.json')).map(name=>({path:join(directory,name),row:JSON.parse(readFileSync(join(directory,name),'utf8'))})).filter(item=>item.row.kind==='report-recovery-verified');
  assert.equal(proofs.length,1);
  rmSync(proofs[0].path);assert.throws(()=>f.accept());assert.equal(f.tool.read(f.logbook,'ledger').length,0);
  f.events.publish(join(f.options.observationsRoot,session),proofs[0].row);
  assert.equal(f.accept().decision,'review-accepted');
});


test('T59: investigation tasks refuse commit review verdicts without publication', async t => {
  const f=await reviewAcceptanceFixture(t,{size:'investigate'});
  const before=reviewTables(f);
  assert.equal(f.tool.read(f.logbook,'runs')[0].status,'done');
  assert.equal(f.tool.read(f.logbook,'tasks')[0].route.includes('build'),false);
  assert.throws(()=>f.accept());
  assert.deepEqual(reviewTables(f),before);
  assert.equal(existsSync(join(f.logbook,'review-pending.json')),false);
  assert.deepEqual(existsSync(join(f.logbook,'reviews'))?readdirSync(join(f.logbook,'reviews')):[],[]);
});


test('T59: recovery rejects a no-build preimage while historical receipts remain readable', async t => {
  const f=await reviewAcceptanceFixture(t);
  const restore=await stopReviewWrite(t,f,'ledger');assert.throws(()=>f.accept(),/Injected/);restore();
  const file=join(f.logbook,'review-pending.json'),record=JSON.parse(readFileSync(file,'utf8'));
  const investigation=text=>{
    const lines=text.replace(/\n$/, '').split('\n'), keys=lines[0].split('\t');
    const row=lines[1].split('\t');row[keys.indexOf('size')]='investigate';row[keys.indexOf('route')]='investigate,evidence-review';
    lines[1]=row.join('\t');return lines.join('\n')+'\n';
  };
  record.value.tables.tasks.before=investigation(record.value.tables.tasks.before);
  record.value.tables.tasks.after=investigation(record.value.tables.tasks.after);
  writeFileSync(join(f.logbook,'tasks.tsv'),record.value.tables.tasks.before);
  record.hash=createHash('sha256').update(JSON.stringify(record.value)).digest('hex');
  const bytes=JSON.stringify(record)+'\n';writeFileSync(file,bytes);
  const before=reviewTables(f);assert.throws(()=>f.accept());assert.deepEqual(reviewTables(f),before);
  assert.equal(readFileSync(file,'utf8'),bytes);assert.deepEqual(readdirSync(join(f.logbook,'reviews')),[]);
  const historical=await reviewAcceptanceFixture(t), accepted=historical.accept();
  fixtureTaskField(historical,'route','investigate,evidence-review');
  assert.deepEqual(historical.accept(),{...accepted,decision:'already-accepted'});
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

async function taskReadFixture(t) {
  const f = await preparationServerFixture(t);
  const file = join(f.plugin, 'runtime/task-read.mjs');
  assert.ok(existsSync(file), 'task reader adapter must ship');
  const { readNativeTask } = await import(pathToFileURL(file));
  return { ...f, readTask: (input = {task:'T1'}, actor = session, options = f.options) => readNativeTask(input, f.native(actor), options), readNativeTask };
}

test('T61: task reader returns exact metadata, stable tokens and off-mode reads without authority', async t => {
  const f = await taskReadFixture(t), before = f.core.readAdmission(f.options.directory);
  const row = f.assignmentTool.read(f.assignmentLogbook, 'tasks')[0], value = f.readTask();
  assert.deepEqual(value, {task:row,version:createHash('sha256').update(JSON.stringify(row)).digest('hex')});
  assert.deepEqual(f.readTask(), value);
  f.assignmentCli('run','done','R1','--status','done');
  assert.deepEqual(f.readTask(), value, 'run evidence is outside the task metadata token');
  f.assignmentCli('task','T1','set','title=Changed recorded task');
  const changed = f.readTask(); assert.notEqual(changed.version,value.version); assert.equal(changed.task.title,'Changed recorded task');
  assert.deepEqual(f.core.readAdmission(f.options.directory),before);
  f.core.changeAdmissionMode(f.options.directory,{...f.scope,after:turns[0],turn:turns[2],sage:false});
  const off = f.core.readAdmission(f.options.directory); assert.deepEqual(f.readTask(),changed);
  assert.deepEqual(f.core.readAdmission(f.options.directory),off);
});

test('T61: task reader rejects foreign identity, caller paths and malformed requests', async t => {
  const f = await taskReadFixture(t); assert.equal(f.readTask().task.id,'T1');
  for (const input of [null,[],{}, {task:'T1',project:f.options.projectDirectory}, {task:'T1',extra:true}, {task:[]}, {task:'T0'}, {task:'T999'}, Object.assign(Object.create({task:'T1'}),{extra:true})]) assert.throws(()=>f.readTask(input));
  for (const actor of [childActor,turns[2],null]) assert.throws(()=>f.readTask({task:'T1'},actor));
  assert.throws(()=>f.readNativeTask({task:'T1'},{version:'0.159.0',actor:session},f.options));
  for (const patch of [{project:'other'},{logbookRoot:undefined},{projectDirectory:undefined}]) assert.throws(()=>f.readTask({task:'T1'},session,{...f.options,...patch}));
  const alias=join(f.dir,'logbook-alias');symlinkSync(f.options.logbookRoot,alias);
  assert.throws(()=>f.readTask({task:'T1'},session,{...f.options,logbookRoot:alias}));
  const coreRead = input => f.assignmentTool.readTaskSnapshot(input,f.assignmentEnv);
  assert.equal(coreRead({project:f.options.projectDirectory,task:'T1'}).task.id,'T1');
  for (const input of [{project:f.options.projectDirectory,task:'T1',extra:true}, Object.assign(Object.create({project:f.options.projectDirectory}),{task:'T1',extra:true}), Object.assign(Object.create({task:'T1'}),{project:f.options.projectDirectory,extra:true})]) assert.throws(()=>coreRead(input));
});

test('T61: task reader refuses duplicate IDs, corruption and receipt aliases without recovery', async t => {
  const f = await taskReadFixture(t), dir=f.assignmentLogbook;
  const snapshot = () => Object.fromEntries(readdirSync(dir).filter(name=>name.endsWith('.tsv') || name==='review-pending.json').map(name=>[name,readFileSync(join(dir,name),'utf8')]));
  const admission=f.core.readAdmission(f.options.directory), initial=snapshot(); assert.equal(f.readTask().task.id,'T1');
  assert.deepEqual(snapshot(),initial);
  const file=join(dir,'tasks.tsv'), original=readFileSync(file,'utf8');
  for (const bytes of [original+original.split('\n')[1]+'\n','invalid header\n']) {
    writeFileSync(file,bytes);const before=snapshot();assert.throws(()=>f.readTask());assert.deepEqual(snapshot(),before);
  }
  writeFileSync(file,original);
  for (const name of ['task-requests','run-requests','reviews']) {
    const target=join(f.dir,`alias-${name}`);mkdirSync(target);const alias=join(dir,name);symlinkSync(target,alias);
    const before=snapshot();assert.throws(()=>f.readTask());assert.deepEqual(snapshot(),before);assert.deepEqual(readdirSync(target),[]);rmSync(alias);
  }
  assert.equal(f.readTask().task.id,'T1');assert.deepEqual(f.core.readAdmission(f.options.directory),admission);
});

test('T61: packaged task tool consumes authenticated reads and contains refusals', async t => {
  const f=await taskReadFixture(t),expected=f.readTask();
  const before=journalBytes(f);
  const client=await connect(t,f,'0.160.0','','sage_read_task');
  assert.deepEqual(await client.call({task:'T1'}),expected);assert.deepEqual(await client.call({task:'T1'}),expected);
  assert.match((await client.call({task:'T1'},childActor)).error,/could not read/);
  assert.match((await client.call({task:'T999'})).error,/could not read/);
  assert.deepEqual(journalBytes(f),before);
  await client.close();
});


const taskReadDiskSnapshot = f => {
  const dir = f.logbook ?? f.assignmentLogbook;
  const tree = path => existsSync(path) ? readdirSync(path, {withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))
    .map(entry => [entry.name, entry.isDirectory() ? tree(join(path,entry.name)) : readFileSync(join(path,entry.name),'utf8')]) : null;
  return { tables: readdirSync(dir).filter(name=>name.endsWith('.tsv')).sort().map(name=>[name,readFileSync(join(dir,name),'utf8')]),
    pending: existsSync(join(dir,'review-pending.json')) ? readFileSync(join(dir,'review-pending.json'),'utf8') : null,
    receipts: ['task-requests','run-requests','reviews','reports'].map(name=>[name,tree(join(dir,name))]), admission: journalBytes(f) };
};
for (const writer of ['task','run','review']) test(`T61: task reader refuses a valid recoverable ${writer} intent without publishing or recovery`, async t => {
  const f = writer === 'task' ? await taskCreationFixture(t) : writer === 'run' ? await runCreationFixture(t) : await reviewAcceptanceFixture(t);
  if (writer === 'task') f.create();
  const {readNativeTask} = await import(pathToFileURL(join(f.plugin,'runtime/task-read.mjs')));
  const read = () => readNativeTask({task:'T1'},f.native(session),f.options);
  const stable=taskReadDiskSnapshot(f), saved=read();assert.equal(saved.task.id,'T1');
  assert.deepEqual(taskReadDiskSnapshot(f),stable);
  const publish = writer === 'task' ? () => f.create({...f.input,request:turns[1],title:'Second recorded task'})
    : writer === 'run' ? () => f.createRun() : () => f.accept();
  const restore = await stopTaskWrite(t,f,writer === 'run' ? 'runs' : writer === 'review' ? 'ledger' : 'tasks');
  assert.throws(publish,/Injected/);restore();
  const pending=taskReadDiskSnapshot(f);assert.notEqual(pending.pending,null);
  assert.throws(read);assert.deepEqual(taskReadDiskSnapshot(f),pending);
  const result=publish();assert.equal(result.decision,writer === 'task' ? 'task-created' : writer === 'run' ? 'run-created' : 'review-accepted');
  assert.equal(existsSync(join(f.logbook,'review-pending.json')),false,'the unchanged intent remains recoverable by its writer');
  const completed=taskReadDiskSnapshot(f);assert.equal(read().task.id,'T1');assert.deepEqual(taskReadDiskSnapshot(f),completed);
});

test('T17: assignment recovery refuses an interrupted turn before parent reconciliation', async t => {
  const f = await completionFixture(t), read = await assignmentReader(f);
  const prepared = f.api.prepareNativeTask(f.input, f.native(session), f.options);
  const before = f.core.readAdmission(f.options.directory), saved = read();
  assert.equal(saved.message, prepared.message); assert.equal(saved.role, 'lead');
  assert.equal(saved.task, 'T1'); assert.equal(saved.run, 'R1'); assert.equal(saved.turn, turns[1]);
  assert.equal(saved.taskHash, createHash('sha256').update(prepared.message).digest('hex'));
  assert.deepEqual(f.core.readAdmission(f.options.directory), before);
  appendInterruption(f);
  assert.equal(f.core.readAdmission(f.options.directory).completions?.length ?? 0, 0);
  assert.throws(() => read());
  assert.deepEqual(f.core.readAdmission(f.options.directory), before);
});

test('T17: assignment recovery refuses two valid active bindings across owner sessions', async t => {
  const f = await completionFixture(t), read = await assignmentReader(f);
  assert.equal(read().run, 'R1');
  const owner = f.core.activateAdmission(f.options.directory, { project: f.options.project,
    session: `codex:${turns[2]}`, activation: turns[0] });
  const scope = { project: owner.project, session: owner.session, epoch: owner.epoch };
  const reserved = f.core.reserveRoleAdmission(f.options.directory, scope,
    { task: 'T2', run: 'R4', issuer: turns[2], call: 'second-owner' },
    { tool: 'spawn_agent', turn: turns[0], name: 'second-owner', argumentsHash: '1'.repeat(64) },
    { issuerRole: 'chief-of-staff', role: 'lead' });
  f.core.bindAdmission(f.options.directory, { ...scope, assignment: reserved.assignment.id,
    issuer: turns[2], call: 'second-owner', child: childActor, turn: turns[1] });
  const valid = f.core.readAdmission(f.options.directory);
  const active = valid.bindings.filter(row => row.child === childActor
    && !valid.completions?.some(done => done.assignment === row.assignment));
  assert.equal(active.length, 2); assert.equal(new Set(active.map(row => row.session)).size, 2);
  assert.throws(() => read());
  assert.deepEqual(f.core.readAdmission(f.options.directory), valid);
});

test('T17: owner activation retry preserves the exact recovered assignment and epoch', async t => {
  const f = await completionFixture(t), read = await assignmentReader(f);
  const before = f.core.readAdmission(f.options.directory), saved = read();
  const owner = before.sessions.find(row => row.session === `codex:${session}`);
  const request = { project: f.options.project, session: owner.session, activation: turns[0] };
  assert.deepEqual(f.core.activateAdmission(f.options.directory, request), owner);
  assert.deepEqual(f.core.readAdmission(f.options.directory), before);
  assert.deepEqual(read(), saved);
  assert.throws(() => f.core.activateAdmission(f.options.directory, { ...request, activation: turns[2] }));
  assert.deepEqual(f.core.readAdmission(f.options.directory), before);
  assert.deepEqual(read(), saved);
});


test('T17: assignment recovery accepts the exact message byte limit and refuses one extra byte', async t => {
  for (const bytes of [1024 * 1024, 1024 * 1024 + 1]) {
    const f = await preparationServerFixture(t);
    const prepared = f.api.prepareNativeTask(f.input, f.native(session), f.options);
    const saved = f.core.readAdmission(f.options.directory).preparations[0];
    const { preparedTaskMessage } = await import(pathToFileURL(join(f.plugin, 'runtime/instructions.mjs')));
    // Grow only this isolated package's instructions. Core admission remains valid; this
    // tests the reader independently of the native dispatch adapter's own size refusal.
    const file = join(f.plugin, 'core/roles/lead.md'), original = readFileSync(file, 'utf8').trim();
    writeFileSync(file, original + 'x'.repeat(bytes - Buffer.byteLength(prepared.message)));
    const message = preparedTaskMessage(saved), taskHash = createHash('sha256').update(message).digest('hex');
    assert.equal(Buffer.byteLength(message), bytes);
    const reserved = f.core.reservePreparedAdmission(f.options.directory, f.scope,
      { preparation: saved.id, issuer: session, call: 'size-boundary' },
      { tool: 'spawn_agent', turn: turns[0], name: f.input.name, argumentsHash: '1'.repeat(64), taskHash }, 'chief-of-staff');
    f.core.bindAdmission(f.options.directory, { ...f.scope, assignment: reserved.assignment.id,
      issuer: session, call: 'size-boundary', child: childActor, turn: turns[1] });
    const transcript = f.childTranscript({ message });
    const base = { schema: 1, runtime: '0.160.0', session };
    f.events.publish(join(f.options.observationsRoot, session), { ...base, kind: 'child-start', child: childActor,
      parent: session, path: '/root/fixture_lead', turn: turns[1] });
    f.events.publish(join(f.options.observationsRoot, session), { ...base, kind: 'child-transcript', child: childActor,
      turn: turns[1], transcript });
    const before = f.core.readAdmission(f.options.directory), read = await assignmentReader(f);
    if (bytes === 1024 * 1024) {
      const result = read(); assert.equal(result.message, message); assert.equal(result.taskHash, taskHash);
      assert.equal(result.preparation, saved.id); assert.equal(result.assignment, reserved.assignment.id);
    } else assert.throws(() => read());
    assert.deepEqual(f.core.readAdmission(f.options.directory), before);
  }
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
    // Synthetic reservations fill the remaining slots of the existing five-slot fixture.
    if (!off) for (const id of [10,11,12]) f.core.reserveAdmission(f.options.directory,f.scope,
      {task:`T${id}`,run:`R${id}`,issuer:session,call:`filler-${id}`},
      {tool:'spawn_agent',turn:turns[0],name:`filler-${id}`,argumentsHash:'2'.repeat(64)});
    const before = f.core.readAdmission(f.options.directory);
    const reserve = () => f.core.reserveAdmission(f.options.directory, f.scope,
      {task:'T2',run:'R9',issuer:session,call:'synthetic-replacement'},
      {tool:'spawn_agent',turn:turns[0],name:'synthetic-replacement',argumentsHash:'1'.repeat(64)});
    if (!off) assert.throws(reserve,/capacity/);
    const configured = f.core.readAdmission(f.options.directory);
    f.policy.reconcileCompletions(event, f.native(session));
    assert.deepEqual(f.core.readAdmission(f.options.directory), configured);
    const original = readFileSync(f.transcript, 'utf8');
    const changed = original.trimEnd().split('\n').map(JSON.parse);
    changed[0].payload.parent_thread_id = 'a1111111-2222-4333-8444-555555555555';
    writeFileSync(f.transcript, changed.map(row => JSON.stringify(row) + '\n').join(''));
    assert.throws(() => f.policy.reconcileCompletions(event, f.native(childActor)));
    assert.deepEqual(f.core.readAdmission(f.options.directory), configured);
    writeFileSync(f.transcript, original);
    f.policy.reconcileCompletions(event, f.native(childActor));
    const state = f.core.readAdmission(f.options.directory);
    assert.equal(state.failures.length, 1); assert.equal(state.failures[0].issuer, childActor);
    assert.equal(state.failures[0].assignment, state.reservations.find(row => row.assignment.run === 'R2').assignment.id);
    assert.deepEqual(state.bindings, before.bindings); assert.deepEqual(state.completions, before.completions);
    assert.deepEqual(state.reservations, before.reservations);
    f.policy.reconcileCompletions(event, f.native(childActor));
    assert.deepEqual(f.core.readAdmission(f.options.directory), state);
    if (!off) {
      assert.equal(reserve().decision,'permit-once');assert.equal(reserve().decision,'already-reserved');
      const replacement=f.core.readAdmission(f.options.directory);
      assert.equal(replacement.reservations.length,state.reservations.length+1);
      assert.deepEqual(replacement.bindings,state.bindings);assert.deepEqual(replacement.completions,state.completions);
    }
  }
});

async function interruptedRunFixture(t, { terminal = true } = {}) {
  const f = await completionFixture(t);
  if (terminal) {
    appendInterruption(f);
    const { reconcileNativeCompletions } = await import(pathToFileURL(join(f.plugin, 'runtime/child-stop.mjs')));
    reconcileNativeCompletions(f.native(session), session, f.options);
  }
  const api = await import(pathToFileURL(join(f.plugin, 'runtime/run-report.mjs')));
  const input = { outcome: 'interrupted', run: 'R1', status: 'blocked' };
  const finish = (request = input, actor = session, options = f.options) => api.finishRecordedRun(request, f.native(actor), options);
  return { ...f, input, finish, logbook: f.assignmentLogbook, tool: f.assignmentTool, cli: f.assignmentCli, env: f.assignmentEnv };
}
const interruptedTables = f => Object.fromEntries(['tasks', 'runs', 'ledger', 'findings', 'gates', 'decisions'].map(name =>
  [name, readFileSync(join(f.logbook, `${name}.tsv`), 'utf8')]));

test('T63: native interrupted run finishes only its row and preserves exact historical retries after later work', async t => {
  for (const status of ['blocked', 'question', 'failed']) {
    const f = await interruptedRunFixture(t), before = interruptedTables(f), state = f.core.readAdmission(f.options.directory);
    const originalRuns = f.tool.read(f.logbook, 'runs');
    const input = { ...f.input, status }, result = f.finish(input);
    assert.deepEqual(result, { decision: 'run-finished', task: 'T1', run: 'R1', assignment: state.bindings[0].assignment, evidenceHash: state.completions[0].evidenceHash, status, report: '', ended: result.ended });
    assert.match(result.ended, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const after = interruptedTables(f); delete before.runs; delete after.runs; assert.deepEqual(after, before);
    const runs = f.tool.read(f.logbook, 'runs'); assert.equal(runs[0].status, status); assert.equal(runs[0].report, '');
    assert.deepEqual(runs.slice(1), originalRuns.slice(1));
    const saved = f.core.readAdmission(f.options.directory);
    for (const key of Object.keys(state)) assert.deepEqual(saved[key], state[key]);
    assert.equal(saved.interruptedFinishes.length, 1); assert.match(saved.interruptedFinishes[0].receiptHash, /^[a-f0-9]{64}$/);
    f.cli('run', 'add', 'T1', '--role', 'lead');
    const later = interruptedTables(f), journal = f.core.readAdmission(f.options.directory);
    assert.deepEqual(f.finish(input), { ...result, decision: 'already-finished' });
    assert.deepEqual(interruptedTables(f), later); assert.deepEqual(f.core.readAdmission(f.options.directory), journal);
    assert.throws(() => f.finish({ ...input, status: status === 'blocked' ? 'failed' : 'blocked' }));
    assert.deepEqual(interruptedTables(f), later);
  }
});

test('T63: native interrupted run refuses malformed requests foreign callers and absent terminal evidence before publication', async t => {
  const f = await interruptedRunFixture(t), before = interruptedTables(f), journal = f.core.readAdmission(f.options.directory);
  for (const request of [null, {}, [], { ...f.input, status: 'done' }, { ...f.input, run: ['R1'] }, { ...f.input, extra: true },
    { ...f.input, run: 'R2' }, { ...f.input, assignment: journal.bindings[0].assignment }, Object.create(f.input)]) assert.throws(() => f.finish(request));
  for (const actor of [childActor, turns[2]]) assert.throws(() => f.finish(f.input, actor));
  assert.throws(() => f.finish(f.input, session, { ...f.options, project: 'foreign' }));
  assert.deepEqual(interruptedTables(f), before); assert.deepEqual(f.core.readAdmission(f.options.directory), journal);
  assert.equal(existsSync(join(f.logbook, 'review-pending.json')), false);
  const unfinished = await interruptedRunFixture(t, { terminal: false }); assert.throws(() => unfinished.finish());
  appendReport(unfinished); unfinished.policy.completeChild(unfinished.stop, unfinished.native(childActor));
  assert.throws(() => unfinished.finish());
  assert.equal(f.finish().status, 'blocked', 'the otherwise valid authenticated interruption must finish');
});

test('T63: native interrupted finish works after off and transcript loss and rejects changed saved run targets', async t => {
  const f = await interruptedRunFixture(t);
  f.cli('task', 'add', '--title', 'Valid other task', '--size', 'small');
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  rmSync(join(f.mode.sessionsDir, `${childActor}.jsonl`));
  const file = join(f.logbook, 'runs.tsv'), original = readFileSync(file, 'utf8');
  for (const [key, value] of [['round', '1'], ['branch', 'codex/other'], ['candidate', 'other'], ['task', 'T3'], ['role', 'qa']]) {
    const lines = original.trimEnd().split('\n'), columns = lines[0].split('\t'), row = lines[1].split('\t');
    row[columns.indexOf(key)] = value; lines[1] = row.join('\t'); writeFileSync(file, lines.join('\n') + '\n');
    assert.equal(f.tool.readTaskSnapshot({ project: f.options.projectDirectory, task: 'T1' }, f.env).task.id, 'T1');
    const before = interruptedTables(f); assert.throws(() => f.finish()); assert.deepEqual(interruptedTables(f), before);
    assert.equal(f.core.readAdmission(f.options.directory).interruptedFinishes, undefined);
    writeFileSync(file, original);
  }
  const mode = f.core.readAdmission(f.options.directory).modes;
  assert.equal(f.finish().status, 'blocked'); assert.deepEqual(f.core.readAdmission(f.options.directory).modes, mode);
});

test('T63: interrupted finish retains its fence across failed publication and recovers exactly once', async t => {
  const f = await interruptedRunFixture(t), before = interruptedTables(f);
  const restore = await stopReviewWrite(t, f, 'runs');
  assert.throws(() => f.finish(), /Injected/); restore();
  assert.deepEqual(interruptedTables(f), before);
  const pending = readFileSync(join(f.logbook, 'review-pending.json'), 'utf8');
  assert.equal(f.core.readAdmission(f.options.directory).interruptedFinishes[0].receiptHash, undefined);
  assert.throws(() => f.finish({ ...f.input, status: 'failed' }));
  assert.equal(readFileSync(join(f.logbook, 'review-pending.json'), 'utf8'), pending);
  const result = f.finish(); assert.equal(result.status, 'blocked');
  assert.equal(existsSync(join(f.logbook, 'review-pending.json')), false);
  assert.deepEqual(f.finish(), { ...result, decision: 'already-finished' });
});

test('T63: malformed interrupted recovery intent cannot publish tables or clear its fence', async t => {
  for (const damage of [r => { r.result = null; }, r => { r.result.status = 'done'; }, r => { r.result.ended = 'bad'; },
    r => { r.reference.run = ['R1']; }, r => { r.result.extra = true; }, r => { r.result.report = 'invented.md'; }]) {
    const f = await interruptedRunFixture(t), restore = await stopReviewWrite(t, f, 'runs');
    assert.throws(() => f.finish(), /Injected/); restore();
    const path = join(f.logbook, 'review-pending.json'), record = JSON.parse(readFileSync(path, 'utf8'));
    damage(record.value.receipt); record.hash = createHash('sha256').update(JSON.stringify(record.value)).digest('hex');
    const bytes = JSON.stringify(record) + '\n'; writeFileSync(path, bytes);
    const before = interruptedTables(f), journal = f.core.readAdmission(f.options.directory);
    assert.throws(() => f.finish()); assert.deepEqual(interruptedTables(f), before);
    assert.deepEqual(f.core.readAdmission(f.options.directory), journal); assert.equal(readFileSync(path, 'utf8'), bytes);
    assert.deepEqual(readdirSync(join(f.logbook, 'interrupted-runs')), []);
  }
});

test('T63: packaged finish tool accepts only exclusive report or interrupted inputs', async t => {
  const f = await interruptedRunFixture(t), client = await connect(t, f, '0.160.0', '', 'sage_finish_run');
  for (const request of [{ ...f.input, status: 'done' }, { ...f.input, assignment: turns[0], reportHash: '0'.repeat(64) },
    { run: 'R1', status: 'blocked' }, { ...f.input, extra: true }]) assert.equal(typeof (await client.call(request)).error, 'string');
  assert.equal(typeof (await client.call(f.input, childActor)).error, 'string');
  const result = await client.call(f.input); assert.equal(result.status, 'blocked');
  assert.deepEqual(await client.call(f.input), { ...result, decision: 'already-finished' });
  await client.close();
});

test('T63: recovery refuses a missing subject and any changed or extra run-table delta before publication', async t => {
  for (const damage of ['missing-task', 'other-row', 'remove-row', 'changed-started', 'changed-model', 'duplicate-row']) {
    const f = await interruptedRunFixture(t), restore = await stopReviewWrite(t, f, 'runs');
    assert.throws(() => f.finish(), /Injected/); restore();
    const path = join(f.logbook, 'review-pending.json'), record = JSON.parse(readFileSync(path, 'utf8'));
    if (damage === 'missing-task') {
      const file = join(f.logbook, 'tasks.tsv'), lines = readFileSync(file, 'utf8').trimEnd().split('\n');
      writeFileSync(file, lines.filter((line, index) => !index || !line.startsWith('T1\t')).join('\n') + '\n');
    } else {
      const lines = record.value.tables.runs.after.trimEnd().split('\n'), columns = lines[0].split('\t');
      if (damage === 'remove-row') lines.pop();
      else if (damage === 'duplicate-row') lines.push(lines[1]);
      else {
        const index = damage === 'other-row' ? 2 : 1, row = lines[index].split('\t');
        const key = damage === 'changed-started' ? 'started' : 'model';
        row[columns.indexOf(key)] = key === 'started' ? '2020-01-01T00:00:00Z' : 'changed';
        lines[index] = row.join('\t');
      }
      record.value.tables.runs.after = lines.join('\n') + '\n';
    }
    record.hash = createHash('sha256').update(JSON.stringify(record.value)).digest('hex');
    const bytes = JSON.stringify(record) + '\n'; writeFileSync(path, bytes);
    const before = interruptedTables(f), journal = f.core.readAdmission(f.options.directory);
    assert.throws(() => f.finish()); assert.deepEqual(interruptedTables(f), before);
    assert.deepEqual(f.core.readAdmission(f.options.directory), journal); assert.equal(readFileSync(path, 'utf8'), bytes);
    assert.deepEqual(readdirSync(join(f.logbook, 'interrupted-runs')), []);
  }
});

test('T63: a durable receipt recovers a failed fence acknowledgement without reopening or changing history', async t => {
  const f = await interruptedRunFixture(t), state = f.core.readAdmission(f.options.directory);
  const binding = state.bindings[0], preparation = state.preparations[0];
  const work = { project: f.options.projectDirectory, binding, task: 'T1', run: 'R1', role: 'lead', status: 'blocked',
    evidenceHash: state.completions[0].evidenceHash, runTarget: preparation.runTarget };
  assert.throws(() => f.tool.finishInterruptedRun(work, f.env, {
    begin: value => f.core.beginInterruptedRunFinish(f.options.directory, value),
    end: () => { throw Error('Injected acknowledgement failure'); },
  }), /Injected acknowledgement/);
  assert.equal(existsSync(join(f.logbook, 'review-pending.json')), false);
  assert.equal(readdirSync(join(f.logbook, 'interrupted-runs')).length, 1);
  assert.equal(f.core.readAdmission(f.options.directory).interruptedFinishes[0].receiptHash, undefined);
  const before = interruptedTables(f), receiptFile = join(f.logbook, 'interrupted-runs', `${binding.assignment}.json`);
  const bytes = readFileSync(receiptFile, 'utf8');
  const result = f.finish(); assert.equal(result.decision, 'already-finished');
  assert.deepEqual(interruptedTables(f), before); assert.equal(readFileSync(receiptFile, 'utf8'), bytes);
  assert.match(f.core.readAdmission(f.options.directory).interruptedFinishes[0].receiptHash, /^[a-f0-9]{64}$/);
  rmSync(receiptFile); assert.throws(() => f.finish()); assert.deepEqual(interruptedTables(f), before);
});

test('T63: historical interrupted receipt refuses missing task and conflicting terminal row without changing later runs', async t => {
  const f = await interruptedRunFixture(t); f.finish(); f.cli('run', 'add', 'T1', '--role', 'lead');
  const runsFile = join(f.logbook, 'runs.tsv'), original = readFileSync(runsFile, 'utf8');
  const lines = original.trimEnd().split('\n'), columns = lines[0].split('\t'), row = lines[1].split('\t');
  row[columns.indexOf('status')] = 'failed'; lines[1] = row.join('\t'); writeFileSync(runsFile, lines.join('\n') + '\n');
  const conflicting = interruptedTables(f); assert.throws(() => f.finish()); assert.deepEqual(interruptedTables(f), conflicting);
  writeFileSync(runsFile, original);
  const taskFile = join(f.logbook, 'tasks.tsv'), tasks = readFileSync(taskFile, 'utf8').trimEnd().split('\n');
  writeFileSync(taskFile, tasks.filter((line, index) => !index || !line.startsWith('T1\t')).join('\n') + '\n');
  const missing = interruptedTables(f); assert.throws(() => f.finish()); assert.deepEqual(interruptedTables(f), missing);
});

for (const window of ['before-receipt', 'before-pending-removal']) test(`T63: interrupted finish recovers ${window} without changing its saved end time`, async t => {
  const f = await interruptedRunFixture(t), fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const method = window === 'before-receipt' ? 'linkSync' : 'unlinkSync', original = fs[method];
  t.mock.method(fs, method, (...args) => {
    const destination = method === 'linkSync' ? args[1] : args[0];
    if (window === 'before-receipt' ? destination.startsWith(join(f.logbook, 'interrupted-runs') + '/')
      : destination === join(f.logbook, 'review-pending.json')) throw Error('Injected finish boundary');
    return original(...args);
  });
  syncBuiltinESMExports(); const restore = () => { t.mock.restoreAll(); syncBuiltinESMExports(); }; t.after(restore);
  assert.throws(() => f.finish(), /Injected finish boundary/); restore();
  const record = JSON.parse(readFileSync(join(f.logbook, 'review-pending.json'), 'utf8'));
  assert.equal(f.tool.read(f.logbook, 'runs')[0].status, 'blocked');
  assert.equal(f.core.readAdmission(f.options.directory).interruptedFinishes[0].receiptHash, undefined);
  assert.equal(readdirSync(join(f.logbook, 'interrupted-runs')).length, window === 'before-receipt' ? 0 : 1);
  const before = interruptedTables(f), result = f.finish();
  assert.equal(result.ended, record.value.receipt.result.ended); assert.deepEqual(interruptedTables(f), before);
  assert.equal(existsSync(join(f.logbook, 'review-pending.json')), false);
  assert.deepEqual(f.finish(), { ...result, decision: 'already-finished' });
});

const capacityError = 'collab spawn failed: agent thread limit reached';
async function capacityFailureFixture(t, model) {
  const f = await completionFixture(t);
  const request = { ...f.input, task: 'T2', run: 'R3', name: 'capacity_rejected' };
  f.api.prepareNativeTask(request, f.native(session), f.options);
  const spawn = f.spawnInput(request.name, 'capacity-call');
  if (model !== undefined) spawn.tool_input.model = model;
  const rejected = f.api.reservePreparedSpawn(spawn, f.native(session), f.options).assignment;
  const transcript = join(f.mode.sessionsDir, 'root.jsonl');
  const prefix = readFileSync(transcript, 'utf8') + [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: spawn.turn_id } },
    { type: 'turn_context', payload: { turn_id: spawn.turn_id } },
  ].map(row => JSON.stringify(row) + '\n').join('');
  const rows = failedCallRows(spawn); rows[1].payload.output = capacityError;
  const write = (input = rows) => writeFileSync(transcript, prefix + input.map(row => JSON.stringify(row) + '\n').join(''));
  write();
  const event = { ...postSpawn(), tool_name: 'collaborationlist_agents', tool_input: {}, tool_response: '{}', transcript_path: transcript };
  const reconcile = (actor = session, input = event) => f.policy.reconcileCompletions(input, f.native(actor));
  return { ...f, request, spawn, rejected, transcript, prefix, rows, write, event, reconcile };
}

test('T65: exact native capacity rejection with inherited or explicit model releases only the rejected reservation', async t => {
  for (const model of [undefined, 'gpt-6.1-sol']) {
    const f = await capacityFailureFixture(t, model), before = f.core.readAdmission(f.options.directory);
    assert.equal(Object.hasOwn(f.spawn.tool_input, 'model'), model !== undefined);
    const retry = { ...f.request, name: 'capacity_retry' };
    f.api.prepareNativeTask(retry, f.native(session), f.options);
    assert.throws(() => f.api.reservePreparedSpawn(f.spawnInput(retry.name, 'retry-call'), f.native(session), f.options));
    f.reconcile();
    const after = f.core.readAdmission(f.options.directory);
    assert.equal((after.failures?.length ?? 0), 1); assert.equal(after.failures[0].assignment, f.rejected.id);
    assert.deepEqual(after.bindings, before.bindings); assert.deepEqual(after.completions, before.completions);
    assert.deepEqual(after.reservations, before.reservations); assert.deepEqual(after.reports, before.reports);
    assert.deepEqual(after.modes, before.modes);
    f.reconcile(); assert.deepEqual(f.core.readAdmission(f.options.directory), after);
    assert.throws(() => f.core.bindAdmission(f.options.directory, { ...f.scope, assignment: f.rejected.id,
      issuer: session, call: 'capacity-call', child: turns[2], turn: turns[1] }), /failed/);
    const replacement = f.api.reservePreparedSpawn(f.spawnInput(retry.name, 'retry-call'), f.native(session), f.options);
    assert.equal(replacement.decision, 'permit-once'); assert.notEqual(replacement.assignment.id, f.rejected.id);
    assert.equal(f.core.readAdmission(f.options.directory).bindings[0].assignment, before.bindings[0].assignment);
  }
});

test('T65: capacity rejection refuses text variants forged identity and duplicate or conflicting native results', async t => {
  const f = await capacityFailureFixture(t);
  for (const text of [`${capacityError}\n`, ` ${capacityError}`, `${capacityError}.`, `${capacityError}: 1`,
    'collab spawn failed: child crashed', 'agent thread limit reached', 'Unknown model `undefined` for spawn_agent. Available models: fixture']) {
    const rows = structuredClone(f.rows); rows[1].payload.output = text; f.write(rows); f.reconcile();
    assert.equal(f.core.readAdmission(f.options.directory).failures?.length ?? 0, 0);
  }
  for (const change of [rows => { rows[0].metadata.client_authored = true; }, rows => { rows[1].metadata.client_authored = true; },
    rows => { rows[0].payload.arguments = JSON.stringify({ ...f.spawn.tool_input, message: 'changed' }); },
    rows => { rows[0].payload.namespace = 'other'; }, rows => { rows[1].payload.internal_chat_message_metadata_passthrough.turn_id = turns[2]; },
    rows => { rows.push(structuredClone(rows[1])); }, rows => { rows.push({ ...structuredClone(rows[1]), payload: { ...rows[1].payload, output: '{}' } }); },
    rows => { rows.reverse(); }, rows => { rows.splice(1, 0, { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: turns[0] } }); }]) {
    const rows = structuredClone(f.rows); change(rows); f.write(rows);
    assert.throws(() => f.reconcile(), /failure evidence/);
    assert.equal(f.core.readAdmission(f.options.directory).failures?.length ?? 0, 0);
  }
  f.write();
  for (const actor of [childActor, turns[2]]) f.reconcile(actor);
  assert.equal(f.core.readAdmission(f.options.directory).failures?.length ?? 0, 0);
  const wrongSession = f.prefix.replaceAll(session, turns[2]);
  writeFileSync(f.transcript, wrongSession + f.rows.map(row => JSON.stringify(row) + '\n').join(''));
  assert.throws(() => f.reconcile(), /failure evidence/);
  f.write(); f.reconcile(); assert.equal((f.core.readAdmission(f.options.directory).failures?.length ?? 0), 1);
});

test('T65: native capacity recovery preserves binding and success ambiguity and supports off-mode historical evidence', async t => {
  for (const kind of ['result', 'start', 'binding']) {
    const f = await capacityFailureFixture(t);
    if (kind === 'binding') f.core.bindAdmission(f.options.directory, { ...f.scope, assignment: f.rejected.id,
      issuer: session, call: 'capacity-call', child: turns[2], turn: turns[1] });
    else f.events.publish(join(f.options.observationsRoot, session), kind === 'result'
      ? { ...f.result, call: 'capacity-call', path: '/root/capacity_rejected' }
      : { schema: 1, runtime: '0.160.0', kind: 'child-start', session, child: turns[2], parent: session,
        turn: turns[1], path: '/root/capacity_rejected' });
    const before = f.core.readAdmission(f.options.directory); f.reconcile();
    assert.deepEqual(f.core.readAdmission(f.options.directory), before);
  }
  const f = await capacityFailureFixture(t);
  f.write([...f.rows, { type: 'event_msg', payload: { type: 'task_complete', turn_id: turns[0] } }]);
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  const before = f.core.readAdmission(f.options.directory); f.reconcile();
  const after = f.core.readAdmission(f.options.directory);
  assert.equal((after.failures?.length ?? 0), 1); assert.deepEqual(after.modes, before.modes);
  assert.deepEqual(after.bindings, before.bindings); assert.deepEqual(after.reservations, before.reservations);
  f.reconcile(); assert.deepEqual(f.core.readAdmission(f.options.directory), after);
});

test('T65: next native spawn reconciles inherited-model capacity rejection before admitting a fresh retry', async t => {
  const f = await capacityFailureFixture(t), retry = { ...f.request, name: 'capacity_retry' };
  f.api.prepareNativeTask(retry, f.native(session), f.options);
  const spawn = { ...f.spawnInput(retry.name, 'capacity-retry'), transcript_path: f.transcript };
  assert.deepEqual(await f.evaluate(f.policy, spawn), { decision: 'pass' });
  const state = f.core.readAdmission(f.options.directory);
  assert.equal((state.failures?.length ?? 0), 1); assert.equal(state.failures[0].assignment, f.rejected.id);
  assert.equal(state.reservations.length, 3); assert.equal(state.bindings.length, 1);
  assert.notEqual(state.reservations.at(-1).assignment.id, f.rejected.id);
});

async function failedFollowupFixture(t) {
  const f = await preparedFollowupFixture(t);
  const transcript = f.childTranscript(); appendReport(f);
  f.events.publish(join(f.options.observationsRoot, session), { schema: 1, runtime: '0.160.0', session,
    kind: 'child-transcript', child: childActor, turn: turns[1], transcript });
  const policy = f.createNativePolicy(f.options, () => ({ decision: 'pass' }));
  assert.deepEqual(await f.evaluate(policy, f.followupInput), { decision: 'pass' });
  const rows = [...f.rows(), { type: 'response_item', metadata: { client_authored: false }, payload: {
    type: 'function_call_output', id: 'fco_capacity_followup', call_id: 'followup-1',
    output: 'collab tool failed: agent thread limit reached',
    internal_chat_message_metadata_passthrough: { turn_id: turns[0] } } }];
  f.save(rows);
  const event = { ...postSpawn(), tool_name: 'collaborationlist_agents', tool_input: {}, tool_response: '{}',
    transcript_path: f.followupInput.transcript_path };
  return { ...f, policy, transcript, failedRows: rows, event };
}

test('T2 followup failure releases only exact attempt and allows a fresh original-predecessor retry', async t => {
  for (const off of [false, true]) {
    const f = await failedFollowupFixture(t), before = f.core.readAdmission(f.options.directory);
    if (off) {
      f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
      f.save([...f.failedRows, { type: 'event_msg', payload: { type: 'task_complete', turn_id: turns[0] } }]);
    }
    f.policy.reconcileCompletions(f.event, f.native(session));
    const state = f.core.readAdmission(f.options.directory);
    assert.equal(state.failures.length, 1); assert.equal(state.failures[0].assignment, before.reservations[1].assignment.id);
    assert.equal(state.failures[0].previous, f.prior.assignment); assert.equal(state.failures[0].target, childActor);
    assert.deepEqual(state.bindings, before.bindings); assert.deepEqual(state.completions, before.completions);
    f.policy.reconcileCompletions(f.event, f.native(session)); assert.deepEqual(f.core.readAdmission(f.options.directory), state);
    if (off) continue;
    const fresh = f.api.prepareNativeTask({ ...f.request, name: 'retry_lead' }, f.native(session), f.options);
    assert.equal(fresh.previous, f.prior.assignment);
    const input = { ...f.followupInput, tool_use_id: 'retry-followup', tool_input: { target: childActor, message: fresh.message } };
    const rows = f.rows(); rows[3].payload.call_id = input.tool_use_id; rows[3].payload.arguments = JSON.stringify(input.tool_input); f.save(rows);
    assert.deepEqual(await f.evaluate(f.policy, input), { decision: 'pass' });
    const retried = f.core.readAdmission(f.options.directory);
    assert.equal(retried.reservations.length, 3); assert.equal(retried.reservations[2].continuation, f.prior.assignment);
    assert.equal(retried.failures.length, 1);
    f.save([...rows, { type: 'response_item', metadata: { client_authored: false }, payload: {
      type: 'function_call_output', id: 'fco_retry', call_id: input.tool_use_id, output: '',
      internal_chat_message_metadata_passthrough: { turn_id: turns[0] } } }]);
    appendFileSync(f.transcript, [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: turns[2] } },
      { type: 'turn_context', payload: { turn_id: turns[2] } },
      { type: 'response_item', payload: { type: 'agent_message', id: 'amsg_retry', author: '/root', recipient: '/root/fixture_lead',
        content: [{ type: 'encrypted_content', encrypted_content: fresh.message }] } },
    ].map(row => JSON.stringify(row) + '\n').join(''));
    await f.evaluate(f.policy, { ...patch(turns[2]), tool_name: 'list_mcp_resources', tool_input: {}, transcript_path: f.transcript }, childActor);
    const delivered = f.core.readAdmission(f.options.directory);
    assert.equal(delivered.bindings.length, 2);
    assert.equal(delivered.bindings[1].assignment, retried.reservations[2].assignment.id);
    assert.deepEqual(delivered.failures, retried.failures);
    const { failContinuationAdmission } = f.core;
    assert.equal(failContinuationAdmission(f.options.directory, delivered.failures[0]).decision, 'already-failed');
    assert.deepEqual(f.core.readAdmission(f.options.directory), delivered);
  }
});

test('T2 followup failure retains unknown errors and rejects forged duplicate or mismatched records', async t => {
  const f = await failedFollowupFixture(t), before = f.core.readAdmission(f.options.directory);
  for (const output of ['', 'collab spawn failed: agent thread limit reached', 'collab tool failed: agent thread limit reached\n', 'other failure']) {
    const rows = structuredClone(f.failedRows); rows.at(-1).payload.output = output; f.save(rows);
    f.policy.reconcileCompletions(f.event, f.native(session)); assert.deepEqual(f.core.readAdmission(f.options.directory), before);
  }
  for (const alter of [rows => rows.at(-1).metadata.client_authored = true, rows => rows.push(structuredClone(rows.at(-1))),
    rows => rows[3].payload.arguments = JSON.stringify({ target: session, message: f.prepared.message }),
    rows => rows.at(-1).payload.internal_chat_message_metadata_passthrough.turn_id = turns[2],
    rows => rows[3].payload.name = 'spawn_agent']) {
    const rows = structuredClone(f.failedRows); alter(rows); f.save(rows);
    assert.throws(() => f.policy.reconcileCompletions(f.event, f.native(session)));
    assert.deepEqual(f.core.readAdmission(f.options.directory), before);
  }
});

test('T2 followup failure cannot override delivered message or successful callback evidence', async t => {
  for (const conflict of ['delivery', 'callback']) {
    const f = await failedFollowupFixture(t), before = f.core.readAdmission(f.options.directory);
    if (conflict === 'callback') f.events.publish(join(f.options.observationsRoot, session), { schema: 1, runtime: '0.160.0', session,
      kind: 'dispatch-result', actor: session, call: 'followup-1', turn: turns[0], mode: 'task', target: childActor });
    else appendFileSync(f.transcript, [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: turns[2] } },
      { type: 'turn_context', payload: { turn_id: turns[2] } },
      { type: 'response_item', payload: { type: 'agent_message', id: 'amsg_conflict', author: '/root', recipient: '/root/fixture_lead',
        content: [{ type: 'encrypted_content', encrypted_content: f.prepared.message }] } },
    ].map(row => JSON.stringify(row) + '\n').join(''));
    // Reconciliation can refuse contradictory evidence, but must never free its slot.
    try { f.policy.reconcileCompletions(f.event, f.native(session)); } catch {}
    assert.deepEqual(f.core.readAdmission(f.options.directory), before);
  }
});


test('T2 followup failure refuses foreign sender identity without changing admission or runs', async t => {
  const f = await failedFollowupFixture(t), before = f.core.readAdmission(f.options.directory);
  const runFile = join(f.assignmentLogbook, 'runs.tsv'), beforeRuns = readFileSync(runFile, 'utf8');
  for (const change of [rows => rows[0].payload.id = childActor,
    rows => rows[0].payload.session_id = childActor,
    rows => { rows[0].payload.parent_thread_id = childActor; rows[0].payload.agent_path = '/root/foreign'; }]) {
    const rows = structuredClone(f.failedRows); change(rows); f.save(rows);
    assert.throws(() => f.policy.reconcileCompletions(f.event, f.native(session)));
    assert.deepEqual(f.core.readAdmission(f.options.directory), before);
    assert.equal(readFileSync(runFile, 'utf8'), beforeRuns);
  }
  f.save(f.failedRows);
  try { f.policy.reconcileCompletions(f.event, f.native(childActor)); } catch {}
  assert.deepEqual(f.core.readAdmission(f.options.directory), before);
  assert.equal(readFileSync(runFile, 'utf8'), beforeRuns);
});

test('T2 pending parent followup result waits without authority then binds exact successful delivery', async t => {
  const f = await deliveredFollowupFixture(t);
  f.save(f.rows()); // Exact parent call and child delivery exist, but parent success has not published.
  let calls = 0, settled = false;
  const policy = f.createNativePolicy(f.options, () => { calls++; return { decision: 'pass' }; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = f.evaluate(policy, f.tool, childActor).then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false, 'missing parent result must wait, not deny or grant');
  assert.equal(calls, 0); assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 1);
  f.save(f.accepted); t.mock.timers.tick(25);
  const result = await pending;
  assert.deepEqual(result, { value: { decision: 'pass' } });
  assert.equal(calls, 1); assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 2);
});

test('T2 pending parent wait refuses timeout mode change interruption and conflicting result', async t => {
  for (const stop of ['timeout', 'mode', 'interrupted', 'conflict', 'failed', 'bound']) {
    const f = await deliveredFollowupFixture(t); f.save(f.rows());
    let calls = 0, settled = false;
    const policy = f.createNativePolicy(f.options, () => { calls++; return { decision: 'pass' }; });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = f.evaluate(policy, f.tool, childActor).then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(settled, false); assert.equal(calls, 0);
    if (stop === 'mode') f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
    if (stop === 'interrupted') appendFileSync(f.transcript, JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: turns[2], reason: 'interrupted' } }) + '\n');
    if (stop === 'conflict') { const rows = structuredClone(f.accepted); rows.at(-1).payload.output = 'collab tool failed: agent thread limit reached'; f.save(rows); }
    const reserved = f.core.readAdmission(f.options.directory).reservations[1];
    // Simulate another trusted provider winning the atomic transition during the wait.
    if (stop === 'failed') f.core.failContinuationAdmission(f.options.directory, { ...f.scope,
      assignment: reserved.assignment.id, issuer: session, call: reserved.assignment.call, previous: f.prior.assignment,
      target: childActor, turn: reserved.dispatch.turn, argumentsHash: reserved.dispatch.argumentsHash,
      taskHash: reserved.dispatch.taskHash, evidenceHash: 'a'.repeat(64) });
    if (stop === 'bound') f.core.bindContinuationAdmission(f.options.directory, { ...f.scope,
      assignment: reserved.assignment.id, issuer: session, call: reserved.assignment.call, child: childActor, turn: turns[0] });
    const afterExternal = f.core.readAdmission(f.options.directory);
    for (let step = 0; step < 41 && !settled; step++) {
      t.mock.timers.tick(25); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    }
    assert.equal(settled, true, stop); assert.ok((await pending).error, stop);
    assert.equal(calls, 0); assert.deepEqual(f.core.readAdmission(f.options.directory), afterExternal);
    t.mock.timers.reset();
  }
});

test('T2 pending parent wait never delays malformed sender or absent child delivery', async t => {
  for (const invalid of ['sender', 'delivery']) {
    const f = await deliveredFollowupFixture(t), rows = f.rows();
    if (invalid === 'sender') rows[3].metadata.client_authored = true;
    else f.deliver([]);
    f.save(rows);
    let scheduled = 0;
    t.mock.method(globalThis, 'setTimeout', () => { scheduled++; throw Error('Unexpected wait for invalid evidence'); });
    await assert.rejects(f.evaluate(f.policy, f.tool, childActor));
    assert.equal(scheduled, 0); assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 1);
    t.mock.restoreAll();
  }
});

test('T2 off-mode pending wait retains its original claim after concurrent failure', async t => {
  for (const stop of ['failed', 'bound']) {
  const f = await deliveredFollowupFixture(t); f.save(f.rows());
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  let calls = 0, settled = false;
  const policy = f.createNativePolicy(f.options, () => { calls++; return { decision: 'pass' }; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = f.evaluate(policy, f.tool, childActor).then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
  await Promise.resolve(); await Promise.resolve(); assert.equal(settled, false);
  const reserved = f.core.readAdmission(f.options.directory).reservations[1];
  if (stop === 'failed') f.core.failContinuationAdmission(f.options.directory, { ...f.scope, assignment: reserved.assignment.id,
    issuer: session, call: reserved.assignment.call, previous: f.prior.assignment, target: childActor,
    turn: reserved.dispatch.turn, argumentsHash: reserved.dispatch.argumentsHash, taskHash: reserved.dispatch.taskHash,
    evidenceHash: 'a'.repeat(64) });
  if (stop === 'bound') f.core.bindContinuationAdmission(f.options.directory, { ...f.scope, assignment: reserved.assignment.id,
    issuer: session, call: reserved.assignment.call, child: childActor, turn: turns[0] });
  const failed = f.core.readAdmission(f.options.directory);
  t.mock.timers.tick(25); const result = await pending;
  assert.ok(result.error, 'failed tracked work cannot become unmanaged during the wait');
  assert.equal(calls, 0); assert.deepEqual(f.core.readAdmission(f.options.directory), failed);
  t.mock.timers.reset();
  }
});

test('T2 off-mode pending wait binds the same claim after parent success without changing mode', async t => {
  const f = await deliveredFollowupFixture(t); f.save(f.rows());
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  const contexts = [];
  const policy = f.createNativePolicy(f.options, (_input, context) => { contexts.push(context); return { decision: 'pass' }; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = f.evaluate(policy, f.tool, childActor);
  await Promise.resolve(); await Promise.resolve(); assert.equal(contexts.length, 0);
  f.save(f.accepted); t.mock.timers.tick(25);
  assert.deepEqual(await pending, { decision: 'pass' });
  assert.equal(contexts.length, 1); assert.equal(contexts[0].sage, false); assert.equal(contexts[0].role, null);
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 2);
});


test('T2 pending binding pins expected assignment before any publication', async t => {
  const f = await deliveredFollowupFixture(t);
  const { bindNativeChildTool } = await import(pathToFileURL(join(f.plugin, 'runtime/child-tool.mjs')));
  const before = f.core.readAdmission(f.options.directory);
  const observations = f.events.readObservations(join(f.options.observationsRoot, session));
  assert.throws(() => bindNativeChildTool(f.tool, f.native(childActor), f.options, f.prior.assignment));
  assert.deepEqual(f.core.readAdmission(f.options.directory), before);
  assert.deepEqual(f.events.readObservations(join(f.options.observationsRoot, session)), observations);
  const correct = before.reservations[1].assignment.id;
  assert.equal(bindNativeChildTool(f.tool, f.native(childActor), f.options, correct).assignment.id, correct);
});

test("nested report probe tool contract matches the packaged MCP registry",async t=>{
 const {setupCompletion}=await import("./fixtures/codex-native/setup-completion.mjs");
 const {NESTED_INSPECT_TOOL,nestedReviewerReport}=await import("./fixtures/codex-native/nested-report.mjs");
 const root=mkdtempSync(join(realpathSync(tmpdir()),"sage-nested-contract-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
 for(const name of ["workspace","codex","codex/sessions"])mkdirSync(join(root,name),{recursive:true});
 const integrated=await setupCompletion(root,{nestedReport:true,env:{...process.env,SAGE_TEST_MACHINE_ID:"native-fixture"}});
 assert(integrated.config.includes(`[mcp_servers.sage_preparation.tools.${NESTED_INSPECT_TOOL}]`));
 const client=await connect(t,{dir:root,entry:join(root,"completion-preparation.mjs")},"0.160.0","",NESTED_INSPECT_TOOL);
 assert.deepEqual(integrated.readLogbook().runs.map(row=>[row.id,row.task,row.role,row.status]),[["R1","T1","lead","running"],["R2","T1","code-reviewer","running"]]);
 assert.match(integrated.reviewTarget.sha,/^[a-f0-9]{40}$/);assert.equal(integrated.mergeReady(),false);
 const {parseReviewReport,parseReport}=await import(pathToFileURL(join(root,"plugin/core/index.mjs")));
 const text=nestedReviewerReport(integrated.reviewTarget);
 assert.equal(parseReviewReport(parseReport(text),"code-reviewer",integrated.reviewTarget).kind,"review-clean");
 assert.throws(()=>parseReviewReport(parseReport(text.replace("FINDINGS []","FINDINGS none")),"code-reviewer",integrated.reviewTarget),/findings/);
 await client.close();
});

async function descendantAuthorityFixture(t, { reserve = true, bind = true } = {}) {
  const f = await completionFixture(t);
  const worker = 'a22422c7-509c-43aa-8c42-827c556f8a59', path = '/root/fixture_lead/worker';
  f.assignmentCli('run', 'add', 'T1', '--role', 'implementer', '--branch', 'codex/t1-fixture');
  const request = { task: 'T1', run: 'R4', name: 'worker', role: 'implementer', brief: f.input.brief };
  f.api.prepareNativeTask(request, f.native(childActor), f.options);
  const spawn = { ...f.spawnInput('worker', 'spawn-worker'), turn_id: turns[1], transcript_path: join(f.mode.sessionsDir, `${childActor}.jsonl`) };
  if (reserve) f.api.reservePreparedSpawn(spawn, f.native(childActor), f.options);
  f.events.publish(join(f.options.observationsRoot, session), { ...f.result, actor: childActor, call: 'spawn-worker', turn: turns[1], path });
  const transcript = f.childTranscript({ child: worker, parent: childActor, path, turn: turns[2] });
  const input = { ...patch(turns[2]), transcript_path: transcript };
  if (bind) assert.deepEqual(await f.evaluate(f.policy, input, worker), { decision: 'pass' });
  const rebrief = () => {
    for (const state of ['briefed', 'building', 'held', 'briefed']) f.assignmentCli('task', 'T1', 'set', `state=${state}`);
  };
  return { ...f, worker, input, spawn, transcript, rebrief };
}

test('T14: a rebrief never restores the old descendant write or recovery authority', async t => {
  const f = await descendantAuthorityFixture(t);
  f.rebrief();
  const before = f.core.readAdmission(f.options.directory);
  let calls = 0;
  const policy = f.createNativePolicy(f.options, () => { calls++; return { decision: 'pass' }; });
  await assert.rejects(f.evaluate(policy, f.input, f.worker), /run|lead/);
  assert.equal(calls, 0);
  const { readNativeChildAssignment } = await import(pathToFileURL(join(f.plugin, 'runtime/child-assignment.mjs')));
  assert.throws(() => readNativeChildAssignment({}, f.native(f.worker), f.options), /run|lead/);
  assert.equal(f.assignmentTool.read(f.assignmentLogbook, 'runs').find(row => row.id === 'R4').status, 'running');
  assert.deepEqual(f.core.readAdmission(f.options.directory), before);
});

test('T14: ancestor revocation during the evaluator refuses its earlier permission', async t => {
  const f = await descendantAuthorityFixture(t);
  let calls = 0;
  const policy = f.createNativePolicy(f.options, async () => { calls++; f.rebrief(); return { decision: 'pass' }; });
  await assert.rejects(f.evaluate(policy, f.input, f.worker), /run|lead/);
  assert.equal(calls, 1);
});

test('T14: prepared child cannot dispatch after its issuing lead is revoked', async t => {
  const f = await descendantAuthorityFixture(t, { reserve: false, bind: false });
  f.rebrief();
  assert.throws(() => f.api.reservePreparedSpawn(f.spawn, f.native(childActor), f.options), /run|lead/);
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 1);
});

test('T14: delivered stale child cannot bind for tools but authentic completion settles its slot', async t => {
  const f = await descendantAuthorityFixture(t, { bind: false });
  f.rebrief();
  await assert.rejects(f.evaluate(f.policy, f.input, f.worker), /run|lead/);
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 1);
  appendReport(f, reportText, f.worker, turns[2]);
  const stop = { ...f.stop, agent_id: f.worker, turn_id: turns[2], agent_transcript_path: f.transcript };
  assert.deepEqual(f.policy.completeChild(stop, f.native(f.worker)), { decision: 'completed' });
  const state = f.core.readAdmission(f.options.directory);
  assert.equal(state.completions.length, 1);
  assert.equal(state.completions[0].child, f.worker);
  assert.equal(f.assignmentTool.read(f.assignmentLogbook, 'runs').find(row => row.id === 'R4').status, 'running');
});

test('T14: reused lead cannot inherit earlier preparations but can issue fresh work', async t => {
  const f = await deliveredFollowupFixture(t, prior => {
    prior.api.prepareNativeTask({ task: 'T1', run: 'R2', name: 'old_qa', role: 'qa', reviewCycle: 1, brief: prior.input.brief }, prior.native(childActor), prior.options);
  });
  assert.deepEqual(await f.evaluate(f.policy, f.tool, childActor), { decision: 'pass' });
  const old = { ...f.spawnInput('old_qa', 'old-qa'), turn_id: turns[2], transcript_path: f.transcript };
  assert.throws(() => f.api.reservePreparedSpawn(old, f.native(childActor), f.options), /issuing lead/);
  f.assignmentCli('run', 'add', 'T1', '--role', 'implementer', '--branch', 'codex/t1-fixture');
  const request = { task: 'T1', run: 'R5', name: 'fresh_worker', role: 'implementer', brief: f.input.brief };
  assert.equal(f.api.prepareNativeTask(request, f.native(childActor), f.options).decision, 'prepared');
  const fresh = { ...f.spawnInput('fresh_worker', 'fresh-worker'), turn_id: turns[2], transcript_path: f.transcript };
  assert.throws(() => f.api.reservePreparedSpawn({ ...fresh, turn_id: turns[1] }, f.native(childActor), f.options), /preparation/);
  assert.equal(f.api.reservePreparedSpawn(fresh, f.native(childActor), f.options).decision, 'permit-once');
});

test('T14: stale descendant interruption retains terminal evidence without certifying its run', async t => {
  const f = await descendantAuthorityFixture(t);
  f.rebrief();
  appendFileSync(f.transcript, JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: turns[2], reason: 'interrupted' } }) + '\n');
  const { reconcileNativeCompletions } = await import(pathToFileURL(join(f.plugin, 'runtime/child-stop.mjs')));
  reconcileNativeCompletions(f.native(childActor), session, f.options);
  const state = f.core.readAdmission(f.options.directory);
  assert.equal(state.completions.length, 1);
  assert.equal(state.completions[0].child, f.worker);
  assert.equal(state.completions[0].outcome, 'interrupted');
  assert.equal(f.assignmentTool.read(f.assignmentLogbook, 'runs').find(row => row.id === 'R4').status, 'running');
});

test('T14: legacy nested preparation remains readable but cannot grant tool authority', async t => {
  const f = await completionFixture(t);
  f.assignmentCli('run', 'add', 'T1', '--role', 'implementer', '--branch', 'codex/t1-fixture');
  const target = f.assignmentTool.captureRunAssignment({ project: f.options.projectDirectory, task: 'T1', run: 'R4', role: 'implementer' }, f.assignmentEnv);
  const prepared = f.core.prepareAdmission(f.options.directory, f.scope, { task: 'T1', run: 'R4', issuer: childActor, name: 'legacy_worker' },
    { issuerRole: 'lead', role: 'implementer' }, f.input.brief, { runTarget: target });
  assert.equal(prepared.decision, 'prepared');
  assert.equal(f.core.readAdmission(f.options.directory).preparations.length, 2);
  const spawn = { ...f.spawnInput('legacy_worker', 'legacy'), turn_id: turns[1], transcript_path: join(f.mode.sessionsDir, `${childActor}.jsonl`) };
  assert.throws(() => f.api.reservePreparedSpawn(spawn, f.native(childActor), f.options), /issuing lead/);
});

test('T14: core rejects invalid issuing references without losing valid prepared work', async t => {
  const f = await completionFixture(t);
  const parent = f.core.readAdmission(f.options.directory).bindings[0].assignment;
  const request = { task: 'T1', run: 'R2', issuer: childActor, name: 'checked_qa' };
  const role = { issuerRole: 'lead', role: 'qa' };
  const before = f.core.readAdmission(f.options.directory);
  for (const issuerAssignment of [null, 42, {}, [], 'not-an-id', session]) {
    assert.throws(() => f.core.prepareAdmission(f.options.directory, f.scope, request, role, f.input.brief, { issuerAssignment }), /issuer assignment|issuer/);
    assert.deepEqual(f.core.readAdmission(f.options.directory), before);
  }
  for (const [scope, changed, changedRole] of [
    [{ ...f.scope, project: 'elsewhere' }, request, role],
    [f.scope, { ...request, issuer: session }, role],
    [f.scope, { ...request, task: 'T2' }, role],
    [f.scope, request, { issuerRole: 'chief-of-staff', role: 'qa' }],
  ]) {
    assert.throws(() => f.core.prepareAdmission(f.options.directory, scope, changed, changedRole, f.input.brief, { issuerAssignment: parent }));
    assert.deepEqual(f.core.readAdmission(f.options.directory), before);
  }
  assert.equal(f.core.prepareAdmission(f.options.directory, f.scope, request, role, f.input.brief, { issuerAssignment: parent }).decision, 'prepared');
});

test('T14: ordinary off-mode descendant tools retain their existing scope', async t => {
  const f = await descendantAuthorityFixture(t);
  f.rebrief();
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  assert.deepEqual(await f.evaluate(f.policy, f.input, f.worker), { decision: 'pass' });
});

test('T14: a new assignment for the same lead actor cannot rescue its old bound child', async t => {
  const worker = 'a22422c7-509c-43aa-8c42-827c556f8a59';
  let workerInput;
  const f = await deliveredFollowupFixture(t, async prior => {
    prior.api.prepareNativeTask({ task: 'T1', run: 'R2', name: 'old_checker', role: 'qa', reviewCycle: 1, brief: prior.input.brief }, prior.native(childActor), prior.options);
    const spawn = { ...prior.spawnInput('old_checker', 'old-checker'), turn_id: turns[1] };
    prior.api.reservePreparedSpawn(spawn, prior.native(childActor), prior.options);
    prior.events.publish(join(prior.options.observationsRoot, session), { ...prior.result, actor: childActor, call: 'old-checker', turn: turns[1], path: '/root/fixture_lead/old_checker' });
    const transcript_path = prior.childTranscript({ child: worker, parent: childActor, path: '/root/fixture_lead/old_checker', turn: turns[2] });
    workerInput = { ...patch(turns[2]), tool_name: 'list_mcp_resources', tool_input: {}, transcript_path };
    const policy = prior.createNativePolicy(prior.options, () => ({ decision: 'pass' }));
    assert.deepEqual(await prior.evaluate(policy, workerInput, worker), { decision: 'pass' });
  });
  assert.deepEqual(await f.evaluate(f.policy, f.tool, childActor), { decision: 'pass' });
  await assert.rejects(f.evaluate(f.policy, workerInput, worker), /issuing lead/);
  assert.equal(f.assignmentTool.read(f.assignmentLogbook, 'runs').find(row => row.id === 'R2').status, 'running');
});

test('T14: unbound stale child interruption recovers delivery and releases only its native slot', async t => {
  const f = await descendantAuthorityFixture(t, { bind: false });
  // Record independently verified delivery before the parent dispatch result is available.
  // This is the same evidence retained by first-tool delivery when its result is pending.
  f.events.publish(join(f.options.observationsRoot, session), { schema: 1, runtime: '0.160.0', session,
    kind: 'child-start', child: f.worker, parent: childActor, path: '/root/fixture_lead/worker', turn: turns[2] });
  f.events.publish(join(f.options.observationsRoot, session), { schema: 1, runtime: '0.160.0', session,
    kind: 'initial-child-transcript', child: f.worker, turn: turns[2], transcript: f.transcript });
  f.rebrief();
  appendFileSync(f.transcript, JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: turns[2], reason: 'interrupted' } }) + '\n');
  const { reconcileNativeCompletions } = await import(pathToFileURL(join(f.plugin, 'runtime/child-stop.mjs')));
  reconcileNativeCompletions(f.native(childActor), session, f.options);
  const state = f.core.readAdmission(f.options.directory);
  assert.equal(state.completions.length, 1);
  assert.equal(state.completions[0].child, f.worker);
  assert.equal(state.completions[0].outcome, 'interrupted');
  assert.equal(f.assignmentTool.read(f.assignmentLogbook, 'runs').find(row => row.id === 'R4').status, 'running');
});

async function nestedDescendantContinuationFixture(t) {
  const f = await descendantAuthorityFixture(t);
  appendReport(f, reportText, f.worker, turns[2]);
  f.policy.completeChild({ ...f.stop, agent_id: f.worker, turn_id: turns[2] }, f.native(f.worker));
  f.assignmentCli('run', 'done', 'R4', '--status', 'done');
  f.assignmentCli('run', 'add', 'T1', '--role', 'implementer', '--branch', 'codex/t1-fixture');
  const previous = f.core.readAdmission(f.options.directory).bindings.find(row => row.child === f.worker).assignment;
  const prepared = f.api.prepareNativeTask({ task: 'T1', run: 'R5', name: 'continued_worker', role: 'implementer',
    brief: f.core.readAdmission(f.options.directory).preparations[1].brief, previous }, f.native(childActor), f.options);
  const transcript = join(f.mode.sessionsDir, `${childActor}.jsonl`);
  const input = { hook_event_name: 'PreToolUse', session_id: session, turn_id: turns[1],
    tool_name: 'collaborationfollowup_task', tool_use_id: 'worker-followup', transcript_path: transcript,
    tool_input: { target: f.worker, message: prepared.message } };
  const response = payload => JSON.stringify({ type: 'response_item', metadata: { client_authored: false },
    payload: { ...payload, internal_chat_message_metadata_passthrough: { turn_id: turns[1] } } }) + '\n';
  appendFileSync(transcript, response({ type: 'function_call', namespace: 'collaboration', name: 'followup_task',
    call_id: input.tool_use_id, arguments: JSON.stringify(input.tool_input) }));
  assert.equal(f.api.reservePreparedFollowup(input, f.native(childActor), f.options).decision, 'permit-once');
  appendFileSync(transcript, response({ type: 'function_call_output', id: 'fco_worker_followup', call_id: input.tool_use_id, output: '' }));
  const turn = 'b22422c7-509c-43aa-8c42-827c556f8a59';
  appendFileSync(f.transcript, [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turn } },
    { type: 'turn_context', payload: { turn_id: turn } },
    { type: 'response_item', payload: { type: 'agent_message', id: 'amsg_worker_later', author: '/root/fixture_lead', recipient: '/root/fixture_lead/worker', content: [{ type: 'encrypted_content', encrypted_content: prepared.message }] } },
  ].map(row => JSON.stringify(row) + '\n').join(''));
  return { ...f, turn };
}

test('T14: nested continuation delivery refuses revoked lead authority and preserves terminal cleanup', async t => {
  const f = await nestedDescendantContinuationFixture(t), { turn } = f;
  f.rebrief();
  await assert.rejects(f.evaluate(f.policy, { ...f.input, turn_id: turn }, f.worker), /run|lead/);
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 2);
  appendFileSync(f.transcript, JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: turn, reason: 'interrupted' } }) + '\n');
  const { reconcileNativeCompletions } = await import(pathToFileURL(join(f.plugin, 'runtime/child-stop.mjs')));
  reconcileNativeCompletions(f.native(childActor), session, f.options);
  const state = f.core.readAdmission(f.options.directory);
  assert.equal(state.completions.length, 2);
  assert.equal(state.completions[1].turn, turn);
  assert.equal(state.completions[1].outcome, 'interrupted');
  assert.equal(f.assignmentTool.read(f.assignmentLogbook, 'runs').find(row => row.id === 'R5').status, 'running');
});

for (const continued of [false, true]) test(`T14: recovered ${continued ? 'continued' : 'initial'} child completion survives parent rebrief`, async t => {
  const f = continued ? await nestedDescendantContinuationFixture(t) : await descendantAuthorityFixture(t);
  const turn = continued ? f.turn : turns[2], run = continued ? 'R5' : 'R4';
  if (continued) assert.deepEqual(await f.evaluate(f.policy, { ...f.input, turn_id: turn }, f.worker), { decision: 'pass' });
  appendRecoveryCheckpoint(f.transcript, 1, turn);
  const { readNativeChildAssignment } = await import(pathToFileURL(join(f.plugin, 'runtime/child-assignment.mjs')));
  appendAssignmentRecovery(f.transcript, readNativeChildAssignment({}, f.native(f.worker), f.options));
  f.rebrief();
  assert.throws(() => readNativeChildAssignment({}, f.native(f.worker), f.options), /run|lead/);
  await assert.rejects(f.evaluate(f.policy, { ...f.input, turn_id: turn }, f.worker), /run|lead/);
  appendReport(f, reportText, f.worker, turn);
  const { reconcileNativeCompletions } = await import(pathToFileURL(join(f.plugin, 'runtime/child-stop.mjs')));
  reconcileNativeCompletions(f.native(childActor), session, f.options);
  const state = f.core.readAdmission(f.options.directory);
  assert.equal(state.completions.length, continued ? 2 : 1);
  assert.equal(state.completions.at(-1).child, f.worker);
  assert.equal(state.completions.at(-1).turn, turn);
  assert.equal(f.assignmentTool.read(f.assignmentLogbook, 'runs').find(row => row.id === run).status, 'running');
  assert.equal(f.assignmentTool.read(f.assignmentLogbook, 'tasks').find(row => row.id === 'T1').state, 'briefed');
});

test('T13: ordered CLI task changes accumulate lead retirements across repeated rebriefs', async t => {
  const f = await completionFixture(t);
  for (const state of ['briefed', 'building', 'held']) f.assignmentCli('task', 'T1', 'set', `state=${state}`);
  const unrelated = f.assignmentTool.read(f.assignmentLogbook, 'runs').filter(row => row.id !== 'R1');
  f.assignmentCli('task', 'T1', 'set', 'state=briefed', 'state=building', 'state=held', 'state=briefed', 'title=Replanned twice');
  const runs = f.assignmentTool.read(f.assignmentLogbook, 'runs');
  assert.equal(runs.find(row => row.id === 'R1').status, 'blocked');
  assert.deepEqual(runs.filter(row => row.id !== 'R1'), unrelated);
  assert.equal(f.assignmentTool.read(f.assignmentLogbook, 'decisions').filter(row => row.decision === 'R1 blocked: T1 went back to briefed').length, 1);
  const task = f.assignmentTool.read(f.assignmentLogbook, 'tasks').find(row => row.id === 'T1');
  assert.equal(task.state, 'briefed'); assert.equal(task.title, 'Replanned twice');
});

async function nativeTaskUpdateFixture(t) {
  const f = await completionFixture(t);
  const { updateNativeTask } = await import(pathToFileURL(join(f.plugin, 'runtime/task-update.mjs')));
  const snapshot = () => f.assignmentTool.readTaskSnapshot({ project: f.options.projectDirectory, task: 'T1' }, f.assignmentEnv);
  const request = (changes, id = 'a1111111-1111-4111-8111-111111111111') => ({ request: id, task: 'T1', version: snapshot().version, changes });
  const update = input => updateNativeTask(input, f.native(session), f.options);
  return { ...f, snapshot, request, update };
}

test('T13: authenticated metadata update and historical retry preserve later task data', async t => {
  const f = await nativeTaskUpdateFixture(t);
  const first = f.request({ title: 'First title' });
  const result = f.update(first);
  assert.equal(result.decision, 'task-updated'); assert.equal(result.task.title, 'First title');
  assert.equal(f.snapshot().task.title, 'First title');
  f.update(f.request({ title: 'Second title' }, 'a2222222-2222-4222-8222-222222222222'));
  assert.deepEqual(f.update(first), { ...result, decision: 'task-update-history' });
  assert.equal(f.snapshot().task.title, 'Second title');
  assert.throws(() => f.update({ ...first, changes: { title: 'Changed retry' } }));
  const state = f.core.readAdmission(f.options.directory);
  assert.equal(state.taskUpdates.length, 2); assert.ok(state.taskUpdates.every(row => row.released));
});

test('T13: disruptive task update records immutable rejection for unresolved native work', async t => {
  const f = await nativeTaskUpdateFixture(t);
  const request = f.request({ state: 'briefed' });
  const result = f.update(request);
  assert.equal(result.decision, 'task-update-rejected'); assert.match(result.reason, /Reconcile or interrupt/);
  assert.equal(f.snapshot().task.state, 'framed');
  appendReport(f); f.policy.completeChild(f.stop, f.native(childActor));
  assert.deepEqual(f.update(request), result);
  const accepted = f.update(f.request({ state: 'briefed' }, 'a3333333-3333-4333-8333-333333333333'));
  assert.equal(accepted.task.state, 'briefed');
  assert.equal(f.core.readAdmission(f.options.directory).taskUpdates.length, 2);
});

async function taskUpdateCoordinator(f, request) {
  const { chiefLogbook } = await import(pathToFileURL(join(f.plugin, 'runtime/logbook-owner.mjs')));
  const context = chiefLogbook(f.native(session), f.options);
  const [project, ownerSession, epoch] = JSON.parse(context.owner);
  let update;
  const coordination = {
    decide(digest, proposal) {
      update = { project, session: ownerSession, epoch, request: request.request, task: request.task, digest, disruptive: proposal.disruptive };
      const row = f.core.decideTaskUpdate(f.options.directory, update);
      return { digest, accepted: row.accepted, reason: row.reason };
    },
    acknowledge(digest, receiptHash) {
      const row = f.core.acknowledgeTaskUpdate(f.options.directory, update, receiptHash);
      return { digest: row.update.digest, receiptHash: row.receiptHash };
    },
    release(digest, receiptHash) {
      const row = f.core.releaseTaskUpdate(f.options.directory, update, receiptHash);
      return { digest: row.update.digest, receiptHash: row.receiptHash };
    },
  };
  const run = callbacks => context.tool.updateRequestedTask({ ...request, project: context.project, owner: context.owner }, context.env, callbacks);
  return { run, coordination };
}

for (const fault of ['unknown-decision', 'promise-ack', 'empty-ack', 'wrong-ack', 'reverted-after', 'release-crash']) {
  test(`T13: ${fault} retains transaction protection and recovers exact update`, async t => {
    const f = await nativeTaskUpdateFixture(t), request = f.request({ title: 'Durable title' });
    const before = readFileSync(join(f.assignmentLogbook, 'tasks.tsv'), 'utf8');
    const { run, coordination } = await taskUpdateCoordinator(f, request);
    const callbacks = { ...coordination };
    if (fault === 'unknown-decision') callbacks.decide = () => { throw Error('injected unknown result'); };
    if (fault === 'promise-ack') callbacks.acknowledge = () => Promise.resolve({});
    if (fault === 'empty-ack') callbacks.acknowledge = () => undefined;
    if (fault === 'wrong-ack') callbacks.acknowledge = (digest, receiptHash) => ({ digest: '0'.repeat(64), receiptHash });
    if (fault === 'reverted-after') callbacks.acknowledge = (digest, receiptHash) => {
      const receipt = coordination.acknowledge(digest, receiptHash);
      writeFileSync(join(f.assignmentLogbook, 'tasks.tsv'), before);
      return receipt;
    };
    if (fault === 'release-crash') callbacks.release = () => { throw Error('injected release failure'); };
    assert.throws(() => run(callbacks));
    const pending = existsSync(join(f.assignmentLogbook, 'review-pending.json'));
    assert.equal(pending, fault !== 'release-crash');
    if (pending) assert.throws(() => f.snapshot());
    else assert.throws(() => f.core.assertTaskAdmissionOpen(f.options.directory, f.options.project, 'T1'));
    const recovered = f.update(request);
    assert.equal(recovered.task.title, 'Durable title');
    assert.equal(f.snapshot().task.title, 'Durable title');
    assert.equal(existsSync(join(f.assignmentLogbook, 'review-pending.json')), false);
    assert.equal(f.core.readAdmission(f.options.directory).taskUpdates.at(-1).released, true);
  });
}

for (const pending of [false, true]) test(`T13: recovered child terminal evidence survives ${pending ? 'pending publication' : 'held task'} without authority`, async t => {
  const f = await nativeTaskUpdateFixture(t), transcript = f.childTranscript();
  if (!pending) for (const state of ['briefed', 'building']) f.assignmentCli('task', 'T1', 'set', `state=${state}`);
  appendRecoveryCheckpoint(transcript);
  const { readNativeChildAssignment } = await import(pathToFileURL(join(f.plugin, 'runtime/child-assignment.mjs')));
  appendAssignmentRecovery(transcript, readNativeChildAssignment({}, f.native(childActor), f.options));
  const request = f.request(pending ? { title: 'Pending title' } : { state: 'held' });
  if (pending) {
    const { run, coordination } = await taskUpdateCoordinator(f, request);
    assert.throws(() => run({ ...coordination, acknowledge() { throw Error('injected acknowledgement outage'); } }));
  } else f.update(request);
  assert.throws(() => readNativeChildAssignment({}, f.native(childActor), f.options));
  await assert.rejects(f.evaluate(f.policy, { ...patch(turns[1]), tool_name: 'list_mcp_resources', tool_input: {}, transcript_path: transcript }, childActor));
  appendReport(f);
  assert.equal(f.policy.completeChild(f.stop, f.native(childActor)).decision, 'completed');
  assert.equal(f.core.readAdmission(f.options.directory).completions.length, 1);
  assert.equal(f.assignmentTool.read(f.assignmentLogbook, 'runs').find(row => row.id === 'R1').status, 'running');
  if (pending) {
    assert.equal(existsSync(join(f.assignmentLogbook, 'review-pending.json')), true);
    f.update(request);
  } else assert.equal(f.snapshot().task.state, 'held');
});

test('T13: historical success does not validate or clear a later pending update', async t => {
  const f = await nativeTaskUpdateFixture(t), first = f.request({ title: 'First accepted title' });
  f.update(first);
  const second = f.request({ title: 'Later pending title' }, 'a4444444-4444-4444-8444-444444444444');
  const { run, coordination } = await taskUpdateCoordinator(f, second);
  assert.throws(() => run({ ...coordination, acknowledge() { throw Error('injected outage'); } }));
  appendFileSync(join(f.assignmentLogbook, 'tasks.tsv'), 'unrelated damaged row\n');
  const before = readFileSync(join(f.assignmentLogbook, 'tasks.tsv'), 'utf8');
  assert.equal(f.update(first).decision, 'task-update-history');
  assert.equal(readFileSync(join(f.assignmentLogbook, 'tasks.tsv'), 'utf8'), before);
  assert.equal(existsSync(join(f.assignmentLogbook, 'review-pending.json')), true);
  assert.equal(f.core.readAdmission(f.options.directory).taskUpdates.at(-1).released, undefined);
});

for (const sage of [true, false]) test(`T13: managed ${sage ? 'on' : 'off'} tool refuses a transaction begun during evaluation`, async t => {
  const f = await nativeTaskUpdateFixture(t);
  if (!sage) f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[2], sage: false });
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const policy = f.createNativePolicy(f.options, async () => { entered(); await waiting; return { decision: 'pass' }; });
  const input = { ...patch(turns[1]), tool_name: 'list_mcp_resources', tool_input: {}, transcript_path: f.childTranscript() };
  const evaluation = f.evaluate(policy, input, childActor);
  const denied = assert.rejects(evaluation, /incomplete|unresolved|fenced/);
  await started;
  const request = f.request({ title: 'Awaited update' });
  const { run, coordination } = await taskUpdateCoordinator(f, request);
  assert.throws(() => run({ ...coordination, decide() { throw Error('injected unknown decision'); } }));
  release(); await denied;
  let calls = 0;
  const next = f.createNativePolicy(f.options, () => { calls++; return { decision: 'pass' }; });
  await assert.rejects(f.evaluate(next, input, childActor));
  assert.equal(calls, 0);
  f.update(request);
  assert.deepEqual(await f.evaluate(next, input, childActor), { decision: 'pass' });
});

for (const boundary of ['intent', 'tasks', 'runs', 'decisions', 'receipt', 'clear']) for (const after of [false, true]) {
  test(`T13: publication recovers ${after ? 'after' : 'before'} ${boundary}`, async t => {
    const f = await nativeTaskUpdateFixture(t);
    for (const state of ['briefed', 'building', 'held']) f.assignmentCli('task', 'T1', 'set', `state=${state}`);
    appendReport(f); f.policy.completeChild(f.stop, f.native(childActor));
    const request = f.request({ state: 'briefed' });
    const fs = (await import('node:fs')).default;
    const { syncBuiltinESMExports } = await import('node:module');
    const method = ['intent', 'receipt'].includes(boundary) ? 'linkSync' : boundary === 'clear' ? 'unlinkSync' : 'renameSync';
    const original = fs[method]; let hit = false;
    t.mock.method(fs, method, (...args) => {
      const to = String(args[method === 'unlinkSync' ? 0 : 1]);
      const matches = boundary === 'receipt' ? to.startsWith(join(f.assignmentLogbook, 'task-updates') + '/')
        : to === join(f.assignmentLogbook, ['intent', 'clear'].includes(boundary) ? 'review-pending.json' : `${boundary}.tsv`);
      if (!hit && matches) {
        hit = true;
        if (after) original(...args);
        throw Object.assign(Error('Injected task update publication failure'), { code: 'EIO' });
      }
      return original(...args);
    }); syncBuiltinESMExports();
    try { assert.throws(() => f.update(request), /Injected/); assert.equal(hit, true); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    const result = f.update(request);
    assert.equal(result.task.state, 'briefed');
    assert.equal(f.assignmentTool.read(f.assignmentLogbook, 'runs').find(row => row.id === 'R1').status, 'blocked');
    assert.equal(f.assignmentTool.read(f.assignmentLogbook, 'decisions').filter(row => row.decision === 'R1 blocked: T1 went back to briefed').length, 1);
    assert.equal(existsSync(join(f.assignmentLogbook, 'review-pending.json')), false);
    assert.equal(f.core.readAdmission(f.options.directory).taskUpdates.length, 1);
    assert.equal(f.core.readAdmission(f.options.directory).taskUpdates[0].released, true);
  });
}

test('T13: disruptive update retires unreserved preparations and permits fresh task generation', async t => {
  const f = await nativeTaskUpdateFixture(t);
  appendReport(f); f.policy.completeChild(f.stop, f.native(childActor));
  f.assignmentCli('run', 'done', 'R1', '--status', 'done');
  f.assignmentCli('run', 'add', 'T1', '--role', 'lead');
  f.api.prepareNativeTask({ ...f.input, run: 'R4', name: 'not_yet_started' }, f.native(session), f.options);
  const old = f.core.readAdmission(f.options.directory).preparations.find(row => row.name === 'not_yet_started');
  f.update(f.request({ state: 'briefed' }));
  assert.throws(() => f.core.assertTaskAdmissionOpen(f.options.directory, f.options.project, 'T1', old.id), /generation/);
  assert.throws(() => f.api.reservePreparedSpawn(f.spawnInput('not_yet_started', 'old-prepared-call'), f.native(session), f.options), /generation/);
  const fresh = f.api.prepareNativeTask({ ...f.input, run: 'R4', name: 'fresh_generation' }, f.native(session), f.options);
  assert.equal(f.core.readAdmission(f.options.directory).preparations.find(row => row.id === fresh.preparation).generation, 1);
  assert.equal(f.api.reservePreparedSpawn(f.spawnInput('fresh_generation', 'fresh-prepared-call'), f.native(session), f.options).decision, 'permit-once');
});

test('T13: disruptive update sees unresolved unbound work from another owner session', async t => {
  const f = await nativeTaskUpdateFixture(t);
  appendReport(f); f.policy.completeChild(f.stop, f.native(childActor));
  const other = turns[2];
  const owner = f.core.activateAdmission(f.options.directory, { project: f.options.project, session: `codex:${other}`, activation: turns[0] });
  const scope = { project: owner.project, session: owner.session, epoch: owner.epoch };
  const previous = f.core.readAdmission(f.options.directory).reservations[0];
  const reserved = f.core.reserveAdmission(f.options.directory, scope, { task: 'T1', run: 'R4', issuer: other, call: 'other-unbound' },
    { ...previous.dispatch, name: 'other_unbound' });
  const request = f.request({ state: 'briefed' });
  const result = f.update(request);
  assert.equal(result.decision, 'task-update-rejected');
  assert.ok(result.reason.includes(reserved.assignment.id));
  assert.equal(f.snapshot().task.state, 'framed');
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 1);
});

test('T13: preparation pins task generation before capture across branch away and back', async t => {
  const f = await nativeTaskUpdateFixture(t);
  appendReport(f); f.policy.completeChild(f.stop, f.native(childActor));
  f.assignmentCli('run', 'done', 'R1', '--status', 'done');
  f.assignmentCli('run', 'add', 'T1', '--role', 'lead');
  f.assignmentCli('task', 'T1', 'set', 'branch=codex/t1-original');
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const original = fs.rmdirSync; let captured = false;
  t.mock.method(fs, 'rmdirSync', (path, ...args) => {
    const result = original(path, ...args);
    if (!captured && path === join(f.assignmentLogbook, '.lock')) {
      captured = true;
      f.update(f.request({ branch: 'codex/t1-away' }));
      f.update(f.request({ branch: 'codex/t1-original' }, 'a5555555-5555-4555-8555-555555555555'));
    }
    return result;
  }); syncBuiltinESMExports();
  try {
    assert.throws(() => f.api.prepareNativeTask({ ...f.input, run: 'R4', name: 'capture_race' }, f.native(session), f.options), /generation/);
    assert.equal(captured, true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(f.snapshot().task.branch, 'codex/t1-original');
  assert.equal(f.core.readAdmission(f.options.directory).preparations.some(row => row.name === 'capture_race'), false);
});

test('T13: preparation server exposes authenticated task updates and historical replies', async t => {
  const f = await nativeTaskUpdateFixture(t), client = await connect(t, f, '0.160.0', '', 'sage_update_task');
  const request = f.request({ title: 'Updated through MCP' });
  const before = f.snapshot();
  assert.match((await client.call(request, childActor)).error, /could not update/);
  assert.match((await client.call(request, turns[2])).error, /could not update/);
  assert.deepEqual(f.snapshot(), before);
  assert.equal((await client.call(request)).decision, 'task-updated');
  assert.equal((await client.call(request)).decision, 'task-update-history');
  assert.equal(f.snapshot().task.title, 'Updated through MCP');
  await client.close();
});

async function taskUpdateReadinessFixture(t) {
  const f = await reviewPreparationFixture(t);
  f.cli('run', 'done', 'R1', '--status', 'done');
  for (const state of ['briefed', 'building', 'reviewing', 'verifying']) f.cli('task', 'T1', 'set', `state=${state}`);
  const head = f.git('rev-parse', 'HEAD');
  for (const kind of ['checks-pass', 'review-clean', 'qa-pass']) f.cli('verdict', 'T1', '--sha', head, '--kind', kind);
  const { updateNativeTask } = await import(pathToFileURL(join(f.plugin, 'runtime/task-update.mjs')));
  const snapshot = () => f.tool.readTaskSnapshot({ project: f.options.projectDirectory, task: 'T1' }, f.env);
  const request = { request: 'a6666666-6666-4666-8666-666666666666', task: 'T1', version: snapshot().version, changes: { state: 'verified' } };
  return { ...f, head, snapshot, request, update: () => updateNativeTask(request, f.native(session), f.options) };
}

for (const obstacle of ['none', 'old-head', 'configured-cycles', 'gate', 'running-checker']) test(`T13: readiness checks ${obstacle}`, async t => {
  const f = await taskUpdateReadinessFixture(t);
  if (obstacle === 'old-head') f.git('commit', '--quiet', '--allow-empty', '-m', 'New candidate');
  if (obstacle === 'configured-cycles') writeFileSync(join(f.env.SAGE_HOME, 'config.json'), JSON.stringify({ 'cycles.small': 2 }));
  if (obstacle === 'gate') f.cli('gate', 'add', 'T1', '--question', 'Choose scope', '--options', 'yes|no', '--recommend', 'no');
  if (obstacle === 'running-checker') f.cli('run', 'add', 'T1', '--role', 'qa');
  if (obstacle !== 'none') {
    assert.throws(() => f.update());
    assert.equal(f.snapshot().task.state, 'verifying');
    assert.equal(existsSync(join(f.logbook, 'review-pending.json')), false);
    assert.equal(f.core.readAdmission(f.options.directory).taskUpdates?.length ?? 0, 0);
  } else {
    assert.equal(f.update().task.state, 'verified');
    const files = readdirSync(join(f.logbook, 'task-updates'));
    const receipt = JSON.parse(readFileSync(join(f.logbook, 'task-updates', files[0]), 'utf8'));
    assert.ok(JSON.stringify(receipt).includes(f.head));
    assert.ok(JSON.stringify(receipt).includes('cycles.small'));
    f.git('commit', '--quiet', '--allow-empty', '-m', 'Later candidate');
    writeFileSync(join(f.env.SAGE_HOME, 'config.json'), JSON.stringify({ 'cycles.small': 3 }));
    assert.equal(f.update().decision, 'task-update-history');
  }
});

for (const corruption of ['task-delta', 'run-delta', 'decision-delta', 'timestamp', 'identity']) test(`T13: valid checksum cannot authorize corrupted ${corruption}`, async t => {
  const f = await nativeTaskUpdateFixture(t), request = f.request({ title: 'Legal title' });
  const { run, coordination } = await taskUpdateCoordinator(f, request);
  assert.throws(() => run({ ...coordination, decide() { throw Error('injected unknown outcome'); } }));
  const file = join(f.assignmentLogbook, 'review-pending.json'), envelope = JSON.parse(readFileSync(file, 'utf8'));
  const intent = envelope.value;
  if (corruption === 'task-delta') intent.tables.tasks.after = intent.tables.tasks.after.replace('Legal title', 'Unrequested title');
  if (corruption === 'run-delta') intent.tables.runs.after += 'forged run\n';
  if (corruption === 'decision-delta') intent.tables.decisions.after += 'forged decision\n';
  if (corruption === 'timestamp') intent.proposal.at = '2026-99-99T00:00:00Z';
  if (corruption === 'identity') intent.reference.owner = 'different-owner';
  envelope.hash = createHash('sha256').update(JSON.stringify(intent)).digest('hex');
  writeFileSync(file, JSON.stringify(envelope) + '\n');
  const before = Object.fromEntries(['tasks', 'runs', 'decisions'].map(table => [table, readFileSync(join(f.assignmentLogbook, `${table}.tsv`), 'utf8')]));
  assert.throws(() => f.update(request));
  assert.deepEqual(Object.fromEntries(Object.keys(before).map(table => [table, readFileSync(join(f.assignmentLogbook, `${table}.tsv`), 'utf8')])), before);
  assert.equal(f.core.readAdmission(f.options.directory).taskUpdates?.length ?? 0, 0);
  assert.equal(existsSync(file), true);
});

for (const view of ['merge', 'logbook']) test(`T13: ${view} refuses a task update between table reads`, async t => {
  const f = await taskUpdateReadinessFixture(t), fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const original = fs.openSync; let armed = true, committed = false;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (armed && file === join(f.logbook, 'decisions.tsv')) {
      armed = false; f.update(); committed = true;
    }
    return original(file, ...args);
  }); syncBuiltinESMExports();
  try {
    if (view === 'merge') assert.equal(f.tool.mergeCheck(f.head, f.env).ok, false);
    else assert.throws(() => f.tool.logbookView(f.options.projectDirectory, f.env), /created while/);
    assert.equal(committed, true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(f.tool.logbookView(f.options.projectDirectory, f.env).task('T1').state, 'verified');
});

test('T13: retired review terminal evidence uses exact candidate and coherent history including pre-run updates', async t => {
  const f = await reviewPreparationFixture(t);
  const { updateNativeTask } = await import(pathToFileURL(join(f.plugin, 'runtime/task-update.mjs')));
  const update = (changes, request) => updateNativeTask({ request, task: 'T1', changes,
    version: f.tool.readTaskSnapshot({ project: f.options.projectDirectory, task: 'T1' }, f.env).version }, f.native(session), f.options);
  update({ title: 'Before new review run' }, 'a7777777-7777-4777-8777-777777777777');
  f.cli('run', 'done', 'R1', '--status', 'done'); f.cli('run', 'add', 'T1', '--role', 'code-reviewer');
  const prepared = f.prepare({ ...f.input, run: 'R2', name: 'later_review' });
  const row = f.core.readAdmission(f.options.directory).preparations.find(value => value.id === prepared.preparation);
  const input = { project: f.options.projectDirectory, target: row.runTarget, review: row.review };
  assert.deepEqual(f.tool.validateTerminalAssignment(input, f.env), row.runTarget);
  f.git('commit', '--quiet', '--allow-empty', '-m', 'Advanced original branch');
  assert.throws(() => f.tool.validateTerminalAssignment(input, f.env), /terminal assignment/);
  f.git('branch', 'codex/t1-new-candidate');
  update({ branch: 'codex/t1-new-candidate' }, 'a8888888-8888-4888-8888-888888888888');
  const retired = f.core.readAdmission(f.options.directory).taskUpdates.find(value => value.update.disruptive).update;
  input.retirement = { owner: JSON.stringify([retired.project, retired.session, retired.epoch]), request: retired.request, digest: retired.digest };
  assert.deepEqual(f.tool.validateTerminalAssignment(input, f.env), row.runTarget);
  update({ branch: 'codex/t1-review' }, 'a9999999-9999-4999-8999-999999999998');
  assert.deepEqual(f.tool.validateTerminalAssignment(input, f.env), row.runTarget);
  const fresh = f.prepare({ ...f.input, run: 'R2', name: 'after_away_back' });
  const freshRow = f.core.readAdmission(f.options.directory).preparations.find(value => value.id === fresh.preparation);
  assert.equal(freshRow.generation, 2);
  f.git('commit', '--quiet', '--allow-empty', '-m', 'Unrelated new drift');
  const { checkPreparedRunTarget } = await import(pathToFileURL(join(f.plugin, 'runtime/run-assignment.mjs')));
  const reservation = preparation => ({ preparation: preparation.id, assignment: Object.fromEntries(['project', 'session', 'epoch', 'issuer', 'task', 'run'].map(key => [key, preparation[key]])), rolePlan: preparation.rolePlan });
  assert.throws(() => checkPreparedRunTarget(f.options, reservation(freshRow), freshRow), /terminal assignment/);
  assert.deepEqual(checkPreparedRunTarget(f.options, reservation(row), row), row.runTarget);
  assert.throws(() => f.tool.validateTerminalAssignment({ ...input, target: { ...row.runTarget, candidate: '2' } }, f.env));
  assert.throws(() => f.core.assertTaskAdmissionOpen(f.options.directory, f.options.project, 'T1', row.id), /generation/);
  const folder = join(f.logbook, 'task-updates');
  const file = readdirSync(folder).map(name => join(folder, name)).find(file => JSON.parse(readFileSync(file, 'utf8')).value.intent.reference.changes.branch);
  const envelope = JSON.parse(readFileSync(file, 'utf8'));
  envelope.value.intent.tables.runs.after += 'unexplained retirement\n';
  envelope.hash = createHash('sha256').update(JSON.stringify(envelope.value)).digest('hex');
  writeFileSync(file, JSON.stringify(envelope) + '\n');
  assert.throws(() => f.tool.validateTerminalAssignment(input, f.env));
});

test('T13: verified and pr-ready metadata retains fresh readiness and PR requirements', async t => {
  const f = await taskUpdateReadinessFixture(t);
  f.update();
  const { updateNativeTask } = await import(pathToFileURL(join(f.plugin, 'runtime/task-update.mjs')));
  let serial = 1;
  const update = changes => updateNativeTask({ request: `b0000000-0000-4000-8000-${String(serial++).padStart(12, '0')}`,
    task: 'T1', version: f.snapshot().version, changes }, f.native(session), f.options);
  assert.throws(() => update({ state: 'pr-ready' }));
  assert.throws(() => update({ pr: 'invalid', state: 'pr-ready' }));
  assert.equal(update({ title: 'Verified title' }).task.state, 'verified');
  assert.equal(update({ pr: '17', state: 'pr-ready' }).task.pr, '17');
  assert.equal(update({ title: 'Ready title' }).task.state, 'pr-ready');
  assert.throws(() => update({ pr: '' }));
  f.git('commit', '--quiet', '--allow-empty', '-m', 'Unreviewed candidate');
  assert.throws(() => update({ title: 'Not yet ready' }));
  assert.equal(f.snapshot().task.title, 'Ready title');
});

test('T13: acknowledgement keeps initial continuation and preparation work fenced until separate release', async t => {
  const f = await nativeTaskUpdateFixture(t);
  appendReport(f); f.policy.completeChild(f.stop, f.native(childActor));
  f.assignmentCli('run', 'done', 'R1', '--status', 'done'); f.assignmentCli('run', 'add', 'T1', '--role', 'lead');
  const previous = f.core.readAdmission(f.options.directory).bindings[0].assignment;
  const initial = f.api.prepareNativeTask({ ...f.input, run: 'R4', name: 'reserved_after_release' }, f.native(session), f.options);
  const continuation = f.api.prepareNativeTask({ ...f.input, run: 'R4', name: 'continued_after_release', previous }, f.native(session), f.options);
  const request = f.request({ title: 'Metadata fence' }), { run, coordination } = await taskUpdateCoordinator(f, request);
  const dispatch = f.core.readAdmission(f.options.directory).reservations[0].dispatch;
  let checkedAck = false, checkedRelease = false;
  const refuseWork = () => {
    assert.throws(() => f.core.prepareAdmission(f.options.directory, f.scope, { task: 'T1', run: 'R4', issuer: session, name: 'during_update' },
      { issuerRole: 'chief-of-staff', role: 'lead' }, f.input.brief, { generation: 0 }), /fenced/);
    assert.throws(() => f.core.reservePreparedAdmission(f.options.directory, f.scope, { preparation: initial.preparation, issuer: session, call: 'during-initial' },
      { ...dispatch, name: 'reserved_after_release' }, 'chief-of-staff'), /fenced/);
    assert.throws(() => f.core.reservePreparedContinuation(f.options.directory, f.scope, { preparation: continuation.preparation, issuer: session, call: 'during-continuation', previous },
      { ...dispatch, name: 'continued_after_release' }, 'chief-of-staff'), /fenced/);
  };
  run({ ...coordination,
    acknowledge(digest, receiptHash) {
      const result = coordination.acknowledge(digest, receiptHash);
      assert.equal(existsSync(join(f.assignmentLogbook, 'review-pending.json')), true);
      refuseWork(); checkedAck = true; return result;
    },
    release(digest, receiptHash) {
      assert.equal(existsSync(join(f.assignmentLogbook, 'review-pending.json')), false);
      refuseWork(); checkedRelease = true; return coordination.release(digest, receiptHash);
    },
  });
  assert.equal(checkedAck && checkedRelease, true);
  assert.equal(f.api.reservePreparedSpawn(f.spawnInput('reserved_after_release', 'after-release'), f.native(session), f.options).decision, 'permit-once');
});

test('T13: disruptive update refuses an unresolved continuation even when its initial turn is complete', async t => {
  const f = await preparedFollowupFixture(t);
  const policy = f.createNativePolicy(f.options, () => ({ decision: 'pass' }));
  assert.deepEqual(await f.evaluate(policy, f.followupInput), { decision: 'pass' });
  const { updateNativeTask } = await import(pathToFileURL(join(f.plugin, 'runtime/task-update.mjs')));
  const snapshot = f.assignmentTool.readTaskSnapshot({ project: f.options.projectDirectory, task: 'T1' }, f.assignmentEnv);
  const result = updateNativeTask({ request: 'b1111111-1111-4111-8111-111111111111', task: 'T1', version: snapshot.version,
    changes: { state: 'briefed' } }, f.native(session), f.options);
  assert.equal(result.decision, 'task-update-rejected');
  const state = f.core.readAdmission(f.options.directory);
  assert.ok(result.reason.includes(state.reservations.find(row => row.continuation).assignment.id));
  assert.equal(state.completions.length, 1);
  assert.equal(state.bindings.length, 1);
});

test('T13: legacy optional task columns update to a current readable version', async t => {
  const f = await nativeTaskUpdateFixture(t), file = join(f.assignmentLogbook, 'tasks.tsv');
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n').map(line => line.split('\t'));
  const keep = lines[0].map((name, index) => ['hold', 'extra'].includes(name) ? -1 : index).filter(index => index >= 0);
  writeFileSync(file, lines.map(row => keep.map(index => row[index]).join('\t')).join('\n') + '\n');
  const result = f.update(f.request({ title: 'Updated legacy task' }));
  assert.deepEqual({ task: result.task, version: result.version }, f.snapshot());
  assert.equal(f.snapshot().task.title, 'Updated legacy task');
});
