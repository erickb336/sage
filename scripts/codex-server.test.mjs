import { createHash } from "node:crypto";
import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
    ? ["sage_native_hook"] : ["sage_prepare_task", "sage_read_assignment", "sage_read_recorded_report", "sage_read_report", "sage_record_report"]);
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

async function preparationServerFixture(t) {
  const f = fixture(t);
  assert.ok(existsSync(join(f.plugin, "runtime/preparation-server.mjs")), "the separate preparation server must ship");
  const core = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
  const events = await import(pathToFileURL(join(f.plugin, "runtime/events.mjs")));
  const api = await import(pathToFileURL(join(f.plugin, "runtime/preparation.mjs")));
  const options = { directory: f.mode.directory, project: f.mode.project, observationsRoot: join(f.dir, "observations"), sessionsDir: f.mode.sessionsDir };
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
  return { ...f, core, events, api, options, scope, input, native, spawnInput, childTranscript, bindLead, connectVisible };
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
  assert.equal(existsSync(f.options.observationsRoot), false);
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
  const task = { ...f.input, name: "qa_child", role: "qa" };
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
  const specialist = await preparationServerFixture(t); specialist.input.role = "qa"; specialist.bindLead();
  const client = await specialist.connectVisible();
  assert.equal(typeof (await client.call({ ...specialist.input, name: "third_layer" }, childActor)).error, "string");
  await client.close();
  assert.equal(specialist.core.readAdmission(specialist.options.directory).preparations.length, 1);
});

async function sharedConfiguration(t) {
  const f = await configured(t);
  const observationsRoot = join(f.dir, "observations"); mkdirSync(observationsRoot);
  const config = { version: 2, mode: { ...f.mode, observationsRoot } };
  writeFileSync(f.configFile, JSON.stringify(config));
  const preparationEntry = join(f.dir, "preparation.mjs");
  writeFileSync(preparationEntry, `import { serveConfiguredPreparations } from './plugin/runtime/configuration.mjs'; serveConfiguredPreparations(${JSON.stringify(f.configFile)});`);
  return { ...f, config, preparationEntry };
}

test("shared server configuration fixes the same journal project and event store for both launchers", async t => {
  const f = await sharedConfiguration(t);
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
  mkdirSync(f.options.observationsRoot);
  const config = join(f.dir, "policy.json");
  writeFileSync(config, JSON.stringify({ version: 2, mode: { ...f.mode, observationsRoot: f.options.observationsRoot } }));
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
    [{ ...f.input, run: "R2", name: "qa_child", role: "qa" }, childActor, qa, "/root/fixture_lead/qa_child", turns[2]],
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
  f.api.prepareNativeTask({ ...f.input, task: "T2", run: "R2", name }, f.native(session), f.options);
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
  const f = await completionFixture(t), request = { ...f.input, name: "failed_qa", run: "R2", role: "qa" };
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
    f.input.role = role; f.bindLead();
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
  f.input.role = 'implementer'; f.bindLead();
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

async function roleEditFixture(t, role) {
  const f = await composedPolicyFixture(t);
  f.input.role = role;
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
  const request = { task: "T1", run: "R2", name: "qa_child", role: "qa", brief: f.input.brief };
  const review = { branch: "codex/fixture", sha: "a".repeat(40), round: 0, cycle: 1 };
  f.core.prepareAdmission(f.options.directory, f.scope,
    { task: request.task, run: request.run, name: request.name, issuer: childActor },
    { issuerRole: "lead", role: "qa" }, request.brief, { review });
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
