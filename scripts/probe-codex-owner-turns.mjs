// Actual native owner turns with fixed simulated responses; not installed automatic Sage.
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupCapture } from "./fixtures/codex-native/setup-capture.mjs";
import { waitNative } from "./fixtures/codex-native/wait-native.mjs";

assert.equal(process.argv.length, 2, "unknown_probe_arguments");
const root = realpathSync(mkdtempSync(join(tmpdir(), "sage-owner-turns-")));
let server;
const pending = new Set();
try {
  const workspace = join(root, "workspace"), codexHome = join(root, "codex");
  for (const name of ["workspace", "codex", "home", "tmp"]) mkdirSync(join(root, name));
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
  const integrated = await setupCapture({ root, codexHome, workspace, env, binary, sage: true, emptyLogbook: true });
  const { chiefInstructionParts } = await import(new URL(`file://${join(root, "plugin/runtime/chief-output.mjs")}`));
  const chiefParts = chiefInstructionParts();
  const catalog = join(root, "models.json");
  writeFileSync(catalog, JSON.stringify({ models: [{ slug: "sage-owner-fixture", display_name: "Sage owner fixture",
    supported_reasoning_levels: [], shell_type: "disabled", visibility: "list", supported_in_api: true,
    priority: 1, support_verbosity: false, multi_agent_version: "v2", truncation_policy: { mode: "bytes", limit: 10000 },
    experimental_supported_tools: [], tool_mode: "direct", model_messages: { instructions_template: "Return the fixed fixture response. Do not call tools." } }] }));
  let phase = 0, requests = 0, fixtureError;
  const deliveries = [];
  const strings = value => typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings)
    : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
  server = http.createServer(async (req, res) => {
    pending.add(res); res.once("close", () => pending.delete(res));
    try {
      assert.equal(req.method, "POST"); assert.equal(req.url, "/v1/responses");
      let body = "";
      for await (const chunk of req) { body += chunk; assert(body.length <= 2 * 1024 * 1024, "request_too_large"); }
      const request = JSON.parse(body);
      requests++;
      assert.equal(requests, phase + 1, "unexpected_model_request");
      const values = strings(request.input);
      deliveries.push(chiefParts.map(part => values.reduce((count, text) => count + text.split(part).length - 1, 0)));
      const id = `owner_turn_${phase}`;
      const item = { id: `owner_message_${phase}`, type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: `owner-turn-${phase}-ok`, annotations: [] }] };
      res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
      for (const event of [{ type: "response.created", response: { id, status: "in_progress", output: [] } },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }]) {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      res.end();
    } catch { fixtureError = true; res.writeHead(400); res.end("Fixed fixture failed"); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const config = { model_provider: "sage_owner_fixture", model: "sage-owner-fixture", model_catalog_json: catalog,
    cli_auth_credentials_store: "ephemeral", "features.hooks": true, "features.plugins": false,
    "features.remote_plugin": false, "features.apps": false, "features.shell_snapshot": false,
    "features.shell_tool": false, "features.enable_request_compression": false,
    "features.multi_agent": true, "features.multi_agent_v2": true, "agents.enabled": true, allow_login_shell: false };
  const common = ["exec", "--strict-config", "--skip-git-repo-check", "-C", workspace, "-s", "read-only", "--json"];
  for (const [key, value] of Object.entries(config)) common.push("-c", `${key}=${JSON.stringify(value)}`);
  common.push("-c", `model_providers.sage_owner_fixture={name="Sage owner fixture",base_url="http://127.0.0.1:${server.address().port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`);
  const prompts = ["Return the fixed ordinary response.", "sage mode", "sage mode off", "sage mode"];
  const states = []; let session;
  const initialLogbook = integrated.readLogbook();
  for (phase = 0; phase < prompts.length; phase++) {
    const child = launch([...common, ...(session ? ["resume", session, "-"] : ["-"])]);
    let output = "", stderrBytes = 0, outputTooLarge = false;
    child.stdout.on("data", data => {
      if (Buffer.byteLength(output) + data.length > 2 * 1024 * 1024) outputTooLarge = true;
      else if (!outputTooLarge) output += data;
    });
    child.stderr.on("data", data => { stderrBytes += data.length; }); child.stdin.on("error", () => {});
    child.stdin.end(`${prompts[phase]}\n`);
    const result = await waitNative(child, { onTimeout: () => { for (const res of pending) res.destroy(); server.closeAllConnections(); } });
    assert(!outputTooLarge, "native_output_too_large");
    const events = output.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert.equal(result.code, 0, "native_turn_failed"); assert(!fixtureError, "model_fixture_failed");
    const starts = events.filter(event => event.type === "thread.started"); assert.equal(starts.length, 1);
    if (session) assert.equal(starts[0].thread_id, session, "resume_changed_session"); else session = starts[0].thread_id;
    assert.equal(events.filter(event => event.type === "turn.completed").length, 1);
    assert(!events.some(event => ["error", "turn.failed"].includes(event.type)));
    const items = events.filter(event => event.type === "item.completed").map(event => event.item);
    assert.equal(items.filter(item => item.type === "agent_message" && item.text === `owner-turn-${phase}-ok`).length, 1);
    assert(items.every(item => ["agent_message", "reasoning"].includes(item.type)), "unexpected_tool_execution");
    const state = integrated.readJournal(); states.push(state);
    console.log(JSON.stringify({ type: "owner_turn", phase, sameSession: true, owners: state.sessions.length,
      modes: state.modes.map(row => row.sage), stderrBytes, simulatedModel: true }));
  }
  assert.equal(requests, 4);
  assert.deepEqual(deliveries, [[0, 0], [1, 1], [1, 1], [2, 2]], "chief_instruction_delivery_changed");
  assert.equal(states[0].sessions.length, 0); assert.equal(states[0].modes.length, 0);
  for (let i = 1; i < states.length; i++) {
    assert.equal(states[i].sessions.length, 1);
    assert.equal(states[i].sessions[0].session, `codex:${session}`);
    assert.deepEqual(states[i].modes.map(row => row.sage), [true, false, true].slice(0, i));
    assert.equal(states[i].sessions[0].epoch, states[1].sessions[0].epoch);
    assert.equal(states[i].reservations.length, 0);
  }
  assert.equal(new Set(states[3].modes.map(row => row.turn)).size, 3);
  assert.deepEqual(integrated.readLogbook(), initialLogbook);
  console.log(JSON.stringify({ type: "result", verified: true, sameNativeSession: true, ownerTurns: 4,
    modeChanges: 3, instructionCopiesByTurn: deliveries, simulatedModel: true, installedSageVerified: false }));
} finally {
  for (const res of pending) res.destroy();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  rmSync(root, { recursive: true, force: true });
  assert.equal(existsSync(root), false);
  console.log(JSON.stringify({ type: "cleanup", temporaryRootRemoved: true }));
}
