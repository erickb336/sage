// Test only: the real runtime with a fixed harmless tool route, not the complete product policy.
import { serveHooks } from "./plugin/runtime/mcp-server.mjs";
import { createNativePolicy } from "./plugin/runtime/policy.mjs";
import { options, disconnectOnSpawn, recordOutage, outageRecorded } from "./sage-options.mjs";
const allowed = new Set(["collaborationspawn_agent", "collaborationlist_agents", "collaborationwait_agent",
  "list_mcp_resources", "mcp__sage_preparation__sage_prepare_task", "mcp__sage_preparation__sage_read_report", "mcp__sage_preparation__sage_record_report", "mcp__sage_preparation__sage_finish_run", "mcp__sage_preparation__sage_accept_review", "mcp__sage_preparation__sage_read_recorded_report"]);
serveHooks({ mode: options, loadPolicy: async () => {
  // Keep the injected outage active on every connection after the root spawn attempt.
  if (disconnectOnSpawn && outageRecorded()) process.exit(0);
  return createNativePolicy(options, input => {
  if (disconnectOnSpawn && input.tool_name === "collaborationspawn_agent") {
    recordOutage(input);
    process.exit(0); // Exit this test server only; never signal another process.
  }
  return allowed.has(input.tool_name) ? { decision: "pass" }
    : { decision: "deny", reason: "Outside the fixed native fixture route." };
});
} });
