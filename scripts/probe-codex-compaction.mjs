// Actual Codex compaction with simulated responses and a temporary Sage profile.
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, realpathSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setupCapture } from "./fixtures/codex-native/setup-capture.mjs";
import { waitNative } from "./fixtures/codex-native/wait-native.mjs";

assert(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--sage-off"), "unknown_probe_arguments");
const sageOff = process.argv.includes("--sage-off");
const root = realpathSync(mkdtempSync(join(tmpdir(), "sage-compaction-")));
const pending = new Set();
let server, child, closure, failure;
try {
  for (const name of ["workspace", "codex", "home", "tmp"]) mkdirSync(join(root, name));
  const workspace = join(root, "workspace"), codexHome = join(root, "codex");
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), CODEX_HOME: codexHome,
    TMPDIR: join(root, "tmp"), LANG: "en_US.UTF-8", DO_NOT_TRACK: "1" };
  const binary = process.env.SAGE_CODEX_BIN ?? "codex";
  const telemetry = ["-c", "analytics.enabled=false", "-c", 'otel.exporter="none"',
    "-c", 'otel.metrics_exporter="none"', "-c", 'otel.trace_exporter="none"'];
  const launch = args => spawn(binary, [...telemetry, ...args], { cwd: workspace, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  const version = launch(["--version"]); let versionText = "";
  version.stdout.on("data", data => { versionText += data; }); version.stderr.resume(); version.stdin.end();
  assert.equal((await waitNative(version)).code, 0);
  assert.equal(versionText.trim(), "codex-cli 0.160.0", "unverified_native_version");
  const integrated = await setupCapture({ root, codexHome, workspace, env, binary, sage: true, captureCompaction: true, restoreCompaction: true });
  const { chiefInstructionParts } = await import(pathToFileURL(join(root, "plugin/runtime/chief-output.mjs")));
  const chiefParts = chiefInstructionParts();
  const catalog = join(root, "models.json");
  writeFileSync(catalog, JSON.stringify({ models: [{ slug: "sage-compact-fixture", display_name: "Sage compaction fixture",
    supported_reasoning_levels: [], shell_type: "disabled", visibility: "list", supported_in_api: true,
    priority: 1, support_verbosity: false, multi_agent_version: "v2", truncation_policy: { mode: "bytes", limit: 10000 },
    experimental_supported_tools: [], tool_mode: "direct", model_messages: { instructions_template: "Return the fixed fixture response. Do not call tools." } }] }));
  let phase = 0, requests = 0, fixtureError = false;
  const deliveries = [];
  const strings = value => typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings)
    : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
  server = http.createServer(async (req, res) => {
    pending.add(res); res.once("close", () => pending.delete(res));
    try {
      assert.equal(req.method, "POST"); assert.equal(req.url, "/v1/responses");
      let body = "";
      for await (const chunk of req) { body += chunk; assert(body.length <= 2 * 1024 * 1024, "request_too_large"); }
      const request = JSON.parse(body); requests++;
      assert.equal(requests, phase + 1, "unexpected_model_request");
      const values = strings(request.input);
      deliveries.push(chiefParts.map(part => values.reduce((count, text) => count + text.split(part).length - 1, 0)));
      if (phase === 1) assert(values.some(text => text.includes("SAGE_FIXED_COMPACTION_REQUEST")), "missing_compaction_request");
      if (phase === 2) assert(values.some(text => text.includes("SAGE_FIXED_COMPACTION_SUMMARY")), "summary_not_in_followup");
      const id = `compact_response_${phase}`;
      const text = phase === 1 ? "SAGE_FIXED_COMPACTION_SUMMARY: Continue the fixed fixture. No tools were called." : `compact-turn-${phase}-ok`;
      const item = { id: `compact_message_${phase}`, type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text, annotations: [] }] };
      res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
      for (const event of [{ type: "response.created", response: { id, status: "in_progress", output: [] } },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }]) {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      res.end();
    } catch { fixtureError = true; res.writeHead(400); res.end("Fixed compaction fixture failed"); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const config = { model_provider: "sage_compact_fixture", model: "sage-compact-fixture", model_catalog_json: catalog,
    cli_auth_credentials_store: "ephemeral", compact_prompt: "SAGE_FIXED_COMPACTION_REQUEST", model_auto_compact_token_limit: 1000000,
    "features.hooks": true, "features.plugins": false, "features.remote_plugin": false, "features.apps": false,
    "features.shell_snapshot": false, "features.shell_tool": false, "features.enable_request_compression": false,
    "features.multi_agent": true, "features.multi_agent_v2": true, "agents.enabled": true, allow_login_shell: false };
  const args = ["app-server", "--strict-config"];
  for (const [key, value] of Object.entries(config)) args.push("-c", `${key}=${JSON.stringify(value)}`);
  args.push("-c", `model_providers.sage_compact_fixture={name="Sage compaction fixture",base_url="http://127.0.0.1:${server.address().port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`);
  child = launch(args);
  const events = [], requestsById = new Map(), watchers = new Set();
  let buffer = "", nextId = 0, stderrBytes = 0;
  const fail = error => {
    failure ??= error;
    for (const entry of requestsById.values()) entry.reject(failure);
    requestsById.clear();
    for (const entry of watchers) entry.reject(failure);
    watchers.clear();
    child.stdin.end();
  };
  closure = waitNative(child, { onTimeout: () => {
    fail(Error("native_compaction_deadline"));
    for (const res of pending) res.destroy(); server.closeAllConnections();
  } });
  closure.then(result => { if (result.code !== 0) fail(Error("native_compaction_exit"));
    else if (requestsById.size || watchers.size) fail(Error("native_compaction_ended_early")); });
  child.stdin.on("error", () => fail(Error("native_input_failed")));
  child.stderr.on("data", data => { stderrBytes += data.length; });
  child.stdout.on("data", data => {
    try {
      buffer += data; assert(buffer.length <= 2 * 1024 * 1024, "native_line_too_large");
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        const message = JSON.parse(line);
        if (Object.hasOwn(message, "id")) {
          const entry = requestsById.get(message.id);
          assert(entry && !message.method, "unexpected_native_request"); requestsById.delete(message.id);
          if (message.error) entry.reject(Error("native_rpc_failed")); else entry.resolve(message.result);
        } else {
          assert(events.length < 4096, "too_many_native_events"); events.push(message);
          for (const entry of [...watchers]) if (events.slice(entry.after).some(entry.match)) {
            watchers.delete(entry); entry.resolve(events.slice(entry.after).find(entry.match));
          }
        }
      }
    } catch { fail(Error("invalid_native_output")); }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = ++nextId; requestsById.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  const observe = (after, match) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const found = events.slice(after).find(match);
    if (found) resolve(found); else watchers.add({ after, match, resolve, reject });
  });
  await rpc("initialize", { clientInfo: { name: "sage-compaction-fixture", version: "0.1.0" }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  const started = await rpc("thread/start", { cwd: workspace, approvalPolicy: "never", sandbox: "read-only" });
  const session = started.thread.id, initialLogbook = integrated.readLogbook();
  const runTurn = async text => {
    const after = events.length;
    const result = await rpc("turn/start", { threadId: session, input: [{ type: "text", text }] });
    const ended = await observe(after, e => e.method === "turn/completed" && e.params.threadId === session && e.params.turn.id === result.turn.id);
    assert.equal(ended.params.turn.status, "completed", "native_turn_failed");
    return result.turn.id;
  };
  await runTurn(sageOff ? "sage mode off" : "sage mode");
  const activated = integrated.readJournal(); assert.equal(activated.sessions.length, 1); assert.equal(activated.modes.length, 1);
  assert.equal(activated.modes[0].sage, !sageOff); assert.deepEqual(deliveries[0], sageOff ? [0, 0] : [1, 1]);
  phase = 1;
  const afterCompact = events.length;
  await rpc("thread/compact/start", { threadId: session });
  const compacted = await observe(afterCompact, e => e.method === "item/completed" && e.params.threadId === session && e.params.item.type === "contextCompaction");
  const compactTurn = compacted.params.turnId;
  const compactStart = events.slice(afterCompact).find(e => e.method === "item/started" && e.params.threadId === session
    && e.params.turnId === compactTurn && e.params.item.id === compacted.params.item.id && e.params.item.type === "contextCompaction");
  assert(compactStart, "missing_native_compaction_start");
  const compactEnd = await observe(afterCompact, e => e.method === "turn/completed" && e.params.threadId === session && e.params.turn.id === compactTurn);
  assert.equal(compactEnd.params.turn.status, "completed");
  phase = 2; await runTurn("Continue the fixed fixture after compaction.");
  assert(!fixtureError, "model_fixture_failed"); assert.equal(requests, 3);
  const final = integrated.readJournal(); assert.deepEqual(final, activated, "compaction_changed_journal");
  assert.deepEqual(integrated.readLogbook(), initialLogbook, "compaction_changed_logbook");
  const captures = readdirSync(join(root, "events")).map(name => JSON.parse(readFileSync(join(root, "events", name), "utf8")));
  const compactHooks = captures.filter(row => ["PreCompact", "PostCompact"].includes(row.hook_event_name));
  const sessionHooks = captures.filter(row => row.hook_event_name === "SessionStart");
  const saved = JSON.parse(readFileSync(join(root, "compaction-transcript.json"), "utf8")); assert.equal(saved.session, session);
  const transcriptStat = lstatSync(saved.path);
  assert(transcriptStat.isFile() && transcriptStat.size <= 16 * 1024 * 1024, "invalid_fixture_transcript");
  const transcript = readFileSync(saved.path, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const checkpoints = transcript.filter(row => row.type === "compacted");
  assert.equal(checkpoints.length, 1, "missing_persisted_compaction");
  const checkpoint = checkpoints[0].payload;
  assert.equal(checkpoint.compaction_response_id, "compact_response_1");
  assert(Number.isSafeInteger(checkpoint.window_number) && checkpoint.window_number > 0, "invalid_compaction_window");
  assert.equal(typeof checkpoint.window_id, "string"); assert.equal(typeof checkpoint.previous_window_id, "string");
  assert.notEqual(checkpoint.window_id, checkpoint.previous_window_id);
  assert(Array.isArray(checkpoint.replacement_history), "missing_replacement_history");
  const chiefContextPresent = deliveries[2].every(count => count >= 1);
  console.log(JSON.stringify({ type: "compaction_evidence", nativeCompactionCompleted: true, persistedCompaction: true,
    sameOwnerAndEpoch: true, unchangedLogbook: true, sage: !sageOff, noChildDispatch: final.reservations.length === 0,
    compactHooks: compactHooks.map(row => ({ event: row.hook_event_name, trigger: row.trigger, fields: row.inputKeys })),
    sessionHooks: sessionHooks.map(row => ({ source: row.source, fields: row.inputKeys })),
    instructionCopiesByPhase: deliveries, chiefContextPresent, simulatedModel: true, installedSageVerified: false, stderrBytes }));
  assert.deepEqual(deliveries[2], sageOff ? [0, 0] : [1, 1], "chief_context_after_compaction_does_not_match_mode");
} finally {
  let shutdown;
  if (child) { child.stdin.end(); if (closure) shutdown = await closure; }
  for (const res of pending) res.destroy();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  rmSync(root, { recursive: true, force: true });
  assert.equal(existsSync(root), false);
  console.log(JSON.stringify({ type: "cleanup", temporaryRootRemoved: true }));
  if (shutdown) { assert.equal(shutdown.code, 0, "native_shutdown_failed"); assert.equal(shutdown.signal, null, "native_shutdown_signal"); }
  if (failure) throw failure;
}
