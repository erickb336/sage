// Test only: the real runtime with a fixed harmless tool route, not the complete product policy.
import { serveHooks } from "./plugin/runtime/mcp-server.mjs";
import { createNativePolicy } from "./plugin/runtime/policy.mjs";
import { options, disconnectOnSpawn, recordOutage, outageRecorded, commandDecision } from "./sage-options.mjs";
const allowed = new Set(["collaborationspawn_agent", "collaborationlist_agents", "collaborationwait_agent",
  "list_mcp_resources", "mcp__sage_preparation__sage_prepare_task", "mcp__sage_preparation__sage_read_report", "mcp__sage_preparation__sage_record_report", "mcp__sage_preparation__sage_finish_run", "mcp__sage_preparation__sage_accept_review", "mcp__sage_preparation__sage_read_recorded_report"]);
serveHooks({ mode: options, loadPolicy: async () => {
  // Keep the injected outage active on every connection after the root spawn attempt.
  if (disconnectOnSpawn && outageRecorded()) process.exit(0);
  return createNativePolicy(options, (input, context) => {
  if (disconnectOnSpawn && input.tool_name === "collaborationspawn_agent") {
    recordOutage(input);
    process.exit(0); // Exit this test server only; never signal another process.
  }
  if (input.tool_name === "Bash" && context.sage && context.actor === input.session_id
    && context.command?.cmd === "printf sage-native-command-ok; pwd" && context.command.max_output_tokens === 1000
    && ((context.command.shell === "/bin/sh" && context.command.workdir === options.projectDirectory + "/command-workdir"
      && context.command.tty === false && Object.keys(context.command).length === 5)
      || Object.keys(context.command).length === 2)) return commandDecision(input, context);
  return allowed.has(input.tool_name) ? { decision: "pass" }
    : { decision: "deny", reason: "Outside the fixed native fixture route." };
});
} });
