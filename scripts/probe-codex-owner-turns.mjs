// Actual native owner turns with fixed simulated responses; not installed automatic Sage.
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { setupCapture } from "./fixtures/codex-native/setup-capture.mjs";
import { resolveRestartBinary } from "./fixtures/codex-native/restart-binary.mjs";
import { cleanupRestart } from "./fixtures/codex-native/restart-cleanup.mjs";
import { trackOwnerProcess, assertOwnerTurn, assertOwnerHistory } from "./fixtures/codex-native/owner-turns.mjs";

assert.equal(process.argv.length, 2, "unknown_probe_arguments");
const root = realpathSync(mkdtempSync(join(tmpdir(), "sage-owner-turns-")));
let server, verified = false, failure;
const handles = [];
const evidence = { simulatedModel: true, installedSageVerified: false, turns: [] };
const pending = new Set();
try {
  const workspace = join(root, "workspace"), codexHome = join(root, "codex");
  for (const name of ["workspace", "codex", "home", "tmp"]) mkdirSync(join(root, name));
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), CODEX_HOME: codexHome,
    TMPDIR: join(root, "tmp"), LANG: "en_US.UTF-8", DO_NOT_TRACK: "1", SAGE_TEST_MACHINE_ID: "native-fixture" };
  const { file: binary, format } = resolveRestartBinary({ override: process.env.SAGE_CODEX_BIN });
  evidence.executableFormat = format;
  const telemetry = ["-c", "analytics.enabled=false", "-c", 'otel.exporter="none"',
    "-c", 'otel.metrics_exporter="none"', "-c", 'otel.trace_exporter="none"'];
  const launch = args => {
    const child = spawn(binary, [...telemetry, ...args], { cwd: workspace, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const handle = trackOwnerProcess(child, { onTimeout: () => { for (const res of pending) res.destroy(); server?.closeAllConnections(); } });
    handles.push(handle);
    return handle;
  };
  const versionHandle = launch(["--version"]), version = versionHandle.child; let versionText = "", versionLarge = false;
  version.stdout.on("data", data => { if (Buffer.byteLength(versionText) + data.length > 4096) versionLarge = true; else versionText += data; });
  version.stderr.resume(); version.stdin.end();
  assert.equal((await versionHandle.stopped).code, 0);
  assert(!versionLarge, "version_output_too_large");
  assert.equal(versionText.trim(), "codex-cli 0.160.0", "unverified_native_version");
  const integrated = await setupCapture({ root, codexHome, workspace, env, binary, completion: true, recovery: true, captureSessionStart: true });
  const { chiefInstructionParts } = await import(pathToFileURL(join(root, "plugin/runtime/chief-output.mjs")));
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
      for await (const chunk of req) { assert(Buffer.byteLength(body) + chunk.length <= 2 * 1024 * 1024, "request_too_large"); body += chunk; }
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
    const handle = launch([...common, ...(session ? ["resume", session, "-"] : ["-"])]), child = handle.child;
    let output = "", stderrBytes = 0, outputTooLarge = false;
    child.stdout.on("data", data => {
      if (Buffer.byteLength(output) + data.length > 2 * 1024 * 1024) outputTooLarge = true;
      else if (!outputTooLarge) output += data;
    });
    child.stderr.on("data", data => { stderrBytes += data.length; }); child.stdin.on("error", () => {});
    child.stdin.end(`${prompts[phase]}\n`);
    const result = await handle.stopped;
    assert(!outputTooLarge, "native_output_too_large");
    const events = output.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert.equal(result.code, 0, "native_turn_failed"); assert(!fixtureError, "model_fixture_failed");
    assert.equal(requests, phase + 1, "missing_model_request");
    session = assertOwnerTurn(events, phase, session);
    evidence.turns.push({ phase, eventTypes: events.map(row => row.type), stderrBytes, result });
    const state = integrated.readJournal(); states.push(state);
    console.log(JSON.stringify({ type: "owner_turn", phase, sameSession: true, owners: state.sessions.length,
      modes: state.modes.map(row => row.sage), stderrBytes, simulatedModel: true }));
  }
  assertOwnerHistory({ requests, deliveries, states, session, initialLogbook, finalLogbook: integrated.readLogbook() });
  Object.assign(evidence, { requests, instructionCopiesByTurn: deliveries, ownerCounts: states.map(state => state.sessions.length),
    modeValues: states.map(state => state.modes.map(row => row.sage)), logbookUnchanged: true });
  verified = true;
  console.log(JSON.stringify({ type: "result", verified: true, sameNativeSession: true, ownerTurns: 4,
    modeChanges: 3, instructionCopiesByTurn: deliveries, simulatedModel: true, installedSageVerified: false }));
} catch (error) {
  failure = error;
} finally {
  const cleanup = await cleanupRestart({ handles,
    capture: () => {
      // Hash bounded files rather than publish native transcripts or local paths.
      const files = []; let totalBytes = 0;
      const walk = (directory, label) => {
        if (!existsSync(directory)) return;
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const file = join(directory, entry.name);
          assert(!entry.isSymbolicLink(), "unexpected_evidence_symlink");
          if (entry.isDirectory()) walk(file, label);
          else {
            assert(files.length < 256, "evidence_file_limit");
            const size = statSync(file).size;
            assert(size <= 16 * 1024 * 1024, "evidence_file_too_large");
            totalBytes += size; assert(totalBytes <= 32 * 1024 * 1024, "evidence_total_too_large");
            const bytes = readFileSync(file);
            files.push({ kind: label, bytes: size, sha256: createHash("sha256").update(bytes).digest("hex") });
          }
        }
      };
      walk(join(root, "events"), "hook"); walk(join(root, "codex/sessions"), "session");
      if (verified) {
        assert(files.some(row => row.kind === "hook"), "missing_hook_evidence");
        assert(files.some(row => row.kind === "session"), "missing_session_evidence");
      }
      if (failure) writeFileSync(join(root, "failure.txt"), String(failure.stack ?? failure));
      Object.assign(evidence, { verified, files });
      writeFileSync(join(root, "owner-turn-evidence.json"), JSON.stringify(evidence, null, 2));
      console.log(JSON.stringify({ type: "capture", ...evidence }));
      return { complete: true, verified };
    },
    closeResponses: () => { for (const res of pending) res.destroy(); },
    closeServer: () => new Promise((resolve, reject) => {
      if (!server?.listening) return resolve();
      server.closeAllConnections(); server.close(error => error ? reject(error) : resolve());
    }),
    removeRoot: () => { if (!verified) throw Error("probe_failed_preserve_evidence"); rmSync(root, { recursive: true, force: true }); assert(!existsSync(root)); }
  });
  console.log(JSON.stringify({ type: "cleanup", complete: cleanup.complete, ownedHandlesClosed: cleanup.ownedHandlesClosed,
    temporaryRootRemoved: !existsSync(root), errorPhases: cleanup.errors.map(row => row.phase) }));
  if (failure || !cleanup.complete) {
    // Do not echo arbitrary native output or assertion values, which can contain private paths.
    console.error(JSON.stringify({ type: "failure", code: "owner_turn_probe_failed", evidencePreserved: existsSync(root) }));
    process.exitCode = 1;
  }
}
