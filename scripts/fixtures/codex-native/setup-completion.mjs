import { cpSync, mkdirSync, readFileSync, writeFileSync, realpathSync, unlinkSync, existsSync } from "node:fs";
import assert from "node:assert/strict";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

// Test-only configuration in setupCapture's fresh profile. No installed configuration changes.
export async function setupCompletion(root, { failedSpawn = false, commandProbe = false, denyCommand = false, childMessageProbe = false, roleEditProbe = false, finishRun = false } = {}) {
  cpSync(new URL("../../../plugins/sage-codex", import.meta.url), join(root, "plugin"), { recursive: true });
  const options = { directory: join(root, "admission"), project: "native-fixture",
    projectDirectory: join(root, "workspace"), sessionsDir: join(root, "codex/sessions"),
    observationsRoot: join(root, "observations") };
  mkdirSync(options.observationsRoot);
  let runTool, runEnv, logbook;
  if (finishRun) {
    assert.equal(process.env.SAGE_TEST_MACHINE_ID, "native-fixture", "native state writes need the hardware-query guard");
    options.logbookRoot = join(root, "logbook");
    const { createStateTool } = await import(pathToFileURL(join(root, "plugin/core/index.mjs")));
    runTool = createStateTool({ defaultRoot: () => { throw Error("No ambient logbook"); } });
    runEnv = { ...process.env, SAGE_HOME: options.logbookRoot, SAGE_TEST_MACHINE_ID: "native-fixture" };
    const cli = (...args) => runTool.sage([...args, "--project", options.projectDirectory], runEnv);
    cli("init"); cli("task", "add", "--title", "Native recorded run", "--size", "small");
    cli("run", "add", "T1", "--role", "lead");
    logbook = runTool.storeDir(options.projectDirectory, runEnv);
  }
  const { configureAdmission, readAdmission } = await import(pathToFileURL(join(root, "plugin/core/index.mjs")));
  const { readObservations } = await import(pathToFileURL(join(root, "plugin/runtime/events.mjs")));
  configureAdmission(options.directory, { total: failedSpawn ? 1 : 5, projects: [{ project: options.project, limit: failedSpawn ? 1 : 5 }] });
  writeFileSync(join(root, "completion-hooks.mjs"), `
    import { appendFileSync, writeFileSync } from 'node:fs';
    import { readAdmission } from './plugin/core/index.mjs';
    import { serveHooks } from './plugin/runtime/mcp-server.mjs';
    import { createNativePolicy } from './plugin/runtime/policy.mjs';
    const options = ${JSON.stringify(options)};
    const allowed = new Set(['collaborationspawn_agent', 'collaborationlist_agents', 'collaborationwait_agent',
      'list_mcp_resources', 'mcp__sage_preparation__sage_read_assignment', 'mcp__sage_preparation__sage_prepare_task', 'mcp__sage_preparation__sage_read_report', 'mcp__sage_preparation__sage_record_report', 'mcp__sage_preparation__sage_finish_run']);
    serveHooks({mode: options, loadPolicy: async () => {
      const policy = createNativePolicy(options, (input, context) => {
        if (${JSON.stringify(roleEditProbe)} && input.tool_name === 'apply_patch') {
          writeFileSync(${JSON.stringify(join(root, "edit-evaluation.json"))}, JSON.stringify({call:input.tool_use_id,role:context.role}), {flag:'wx'});
          return {decision:'pass'};
        }
        if (${JSON.stringify(childMessageProbe)} && input.tool_name === 'collaborationsend_message') {
          appendFileSync(${JSON.stringify(join(root, "message-evaluations.jsonl"))}, JSON.stringify({call:input.tool_use_id,target:input.tool_input.target}) + '\\n');
          return {decision:'pass'};
        }
        if (${JSON.stringify(commandProbe)} && input.tool_name === 'Bash') {
          const result = ${JSON.stringify(denyCommand)} ? {decision:'deny',reason:'sage-fixed-command-denial'} : {decision:'pass'};
          writeFileSync(${JSON.stringify(join(root, "command-policy-receipt.json"))}, JSON.stringify({
            session:input.session_id,turn:input.turn_id,call:input.tool_use_id,command:context.command,sage:context.sage,result}), {flag:'wx'});
          return result;
        }
        if (input.tool_use_id === 'probe_compact_1' && context.actor !== input.session_id) {
          writeFileSync(${JSON.stringify(join(root, "recovery-baseline.json"))}, JSON.stringify(readAdmission(options.directory)), {flag: 'wx'});
        }
        return allowed.has(input.tool_name) ? {decision: 'pass'} : {decision: 'deny', reason: 'Outside the fixed completion fixture.'};
      });
      return {...policy, completeChild(input, context) {
        const result = policy.completeChild(input, context);
        const state = readAdmission(options.directory);
        appendFileSync(${JSON.stringify(join(root, "stop-receipts.jsonl"))}, JSON.stringify({decision: result.decision,
          reservations: state.reservations.length, bindings: state.bindings.length,
          completions: state.completions?.length ?? 0}) + '\\n');
        return result;
      }};
    }});
  `);
  writeFileSync(join(root, "completion-preparation.mjs"), `
    import { servePreparations } from './plugin/runtime/preparation-server.mjs';
    servePreparations(${JSON.stringify(options)});
  `);
  const config = [["sage_fixture", "completion-hooks.mjs"], ["sage_preparation", "completion-preparation.mjs"]]
    .map(([name, file]) => `[mcp_servers.${name}]\nrequired=true\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(join(root, file))}]\nenv={SAGE_TEST_MACHINE_ID="native-fixture"}\n`).join("")
    + '[mcp_servers.sage_preparation.tools.sage_prepare_task]\napproval_mode="approve"\n[mcp_servers.sage_preparation.tools.sage_read_report]\napproval_mode="approve"\n';
  const receiptConfig = '[mcp_servers.sage_preparation.tools.sage_finish_run]\napproval_mode="approve"\n[mcp_servers.sage_preparation.tools.sage_read_assignment]\napproval_mode="approve"\n[mcp_servers.sage_preparation.tools.sage_record_report]\napproval_mode="approve"\n';
  const { readNativeRecovery } = await import(pathToFileURL(join(root, "plugin/runtime/identity.mjs")));
  return { readLogbook: () => Object.fromEntries(["tasks", "runs", "ledger", "findings", "gates", "decisions"].map(name => [name, runTool.read(logbook, name)])),
    readRunReport: name => { assert(/^reports\/R[1-9][0-9]*-[a-f0-9-]+\.md$/.test(name)); return readFileSync(join(logbook, name), "utf8"); },
    config: config + receiptConfig, readRecoveryBaseline: () => JSON.parse(readFileSync(join(root, "recovery-baseline.json"), "utf8")), childEvidence(child) {
      const state = readAdmission(options.directory);
      const bindings = state.bindings.filter(row => row.child === child);
      assert.equal(bindings.length, 1);
      const bound = bindings[0], session = bound.session.slice(6);
      const rows = readObservations(join(options.observationsRoot, session));
      const paths = rows.filter(row => row.kind === "child-transcript" && row.child === child && row.turn === bound.turn);
      const starts = rows.filter(row => row.kind === "child-start" && row.child === child);
      assert.equal(paths.length, 1); assert.equal(starts.length, 1);
      const assigned = state.reservations.find(row => row.assignment.id === bound.assignment);
      const recovery = readNativeRecovery(paths[0].transcript, { sessionsDir: options.sessionsDir }, {
        session, child, parent: bound.issuer, path: starts[0].path, author: "/root", turn: bound.turn,
        taskHash: assigned.dispatch.taskHash });
      const text = readFileSync(paths[0].transcript, "utf8"); assert(Buffer.byteLength(text) <= 16 * 1024 * 1024);
      const compactions = text.trim().split("\n").map(JSON.parse).filter(row => row.type === "compacted").length;
      return { state, bound, recovery, compactions };
    }, removeChildTranscript(child) {
      const bindings = readAdmission(options.directory).bindings.filter(row => row.child === child);
      assert.equal(bindings.length, 1);
      const bound = bindings[0];
      const rows = readObservations(join(options.observationsRoot, bound.session.slice(6)))
        .filter(row => row.kind === "child-transcript" && row.child === child && row.turn === bound.turn);
      assert.equal(rows.length, 1);
      const file = realpathSync(rows[0].transcript);
      assert(file.startsWith(realpathSync(options.sessionsDir) + sep));
      unlinkSync(file);
      assert.equal(existsSync(file), false);
    }, readJournal: () => readAdmission(options.directory),
    readStops: () => readFileSync(join(root, "stop-receipts.jsonl"), "utf8").trim().split("\n").map(JSON.parse),
    hook(event) {
      if (event === "SubagentStart") return []; // Exercise no-tool initial transcript binding.
      const fields = event === "UserPromptSubmit"
        ? ["cwd", "hook_event_name", "model", "permission_mode", "prompt", "session_id", "transcript_path", "turn_id"]
        : event === "SubagentStop"
          ? ["hook_event_name", "session_id", "agent_id", "turn_id", "transcript_path", "agent_transcript_path", "stop_hook_active", "last_assistant_message"]
          : ["hook_event_name", "session_id", "turn_id", "tool_name", "tool_use_id", "tool_input", "transcript_path", ...(event === "PostToolUse" ? ["tool_response"] : [])];
      const handler = { type: "mcp_tool", server: "sage_fixture", tool: "sage_native_hook", timeout: 10,
        input: Object.fromEntries(fields.map(key => [key, "${" + key + "}"])) };
      return event === "UserPromptSubmit" ? [handler, { ...handler, input: { ...handler.input, instruction_part: 1 } }] : [handler];
    } };
}
