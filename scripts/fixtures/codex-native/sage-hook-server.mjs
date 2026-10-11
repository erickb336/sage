// Test only: the real runtime with a fixed harmless tool route, not the complete product policy.
import { serveHooks } from "./plugin/runtime/mcp-server.mjs";
import { createNativePolicy } from "./plugin/runtime/policy.mjs";
import { options } from "./sage-options.mjs";
const allowed = new Set(["collaborationspawn_agent", "collaborationlist_agents", "collaborationwait_agent",
  "list_mcp_resources", "mcp__sage_preparation__sage_prepare_task"]);
serveHooks({ mode: options, loadPolicy: async () => createNativePolicy(options, input =>
  allowed.has(input.tool_name) ? { decision: "pass" }
    : { decision: "deny", reason: "Outside the fixed native fixture route." }) });
