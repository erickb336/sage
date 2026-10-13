import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Test-only configuration in setupCapture's fresh profile. No installed configuration changes.
export async function setupCompletion(root) {
  cpSync(new URL("../../../plugins/sage-codex", import.meta.url), join(root, "plugin"), { recursive: true });
  const options = { directory: join(root, "admission"), project: "native-fixture",
    projectDirectory: join(root, "workspace"), sessionsDir: join(root, "codex/sessions"),
    observationsRoot: join(root, "observations") };
  mkdirSync(options.observationsRoot);
  const { configureAdmission, readAdmission } = await import(pathToFileURL(join(root, "plugin/core/index.mjs")));
  configureAdmission(options.directory, { total: 5, projects: [{ project: options.project, limit: 5 }] });
  writeFileSync(join(root, "completion-hooks.mjs"), `
    import { appendFileSync } from 'node:fs';
    import { readAdmission } from './plugin/core/index.mjs';
    import { serveHooks } from './plugin/runtime/mcp-server.mjs';
    import { createNativePolicy } from './plugin/runtime/policy.mjs';
    const options = ${JSON.stringify(options)};
    const allowed = new Set(['collaborationspawn_agent', 'collaborationlist_agents', 'collaborationwait_agent',
      'mcp__sage_preparation__sage_prepare_task', 'mcp__sage_preparation__sage_read_report']);
    serveHooks({mode: options, loadPolicy: async () => {
      const policy = createNativePolicy(options, input => allowed.has(input.tool_name)
        ? {decision: 'pass'} : {decision: 'deny', reason: 'Outside the fixed completion fixture.'});
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
    .map(([name, file]) => `[mcp_servers.${name}]\nrequired=true\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(join(root, file))}]\n`).join("")
    + '[mcp_servers.sage_preparation.tools.sage_prepare_task]\napproval_mode="approve"\n[mcp_servers.sage_preparation.tools.sage_read_report]\napproval_mode="approve"\n';
  return { config, readJournal: () => readAdmission(options.directory),
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
