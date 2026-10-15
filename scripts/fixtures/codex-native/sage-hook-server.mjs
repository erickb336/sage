// Test only: the real runtime with a fixed harmless tool route, not the complete product policy.
import { fixtureInterruptDecision } from "./fixture-interrupt.mjs";
import { serveHooks } from "./plugin/runtime/mcp-server.mjs";
import { createNativePolicy } from "./plugin/runtime/policy.mjs";
import { options, fixtureModes, disconnectOnSpawn, recordOutage, outageRecorded, commandDecision, patchDecision, recordUnmanagedStop } from "./sage-options.mjs";
const allowed = new Set(["collaborationsend_message", "collaborationfollowup_task", "collaborationspawn_agent", "collaborationlist_agents", "collaborationwait_agent",
  "list_mcp_resources", "mcp__sage_preparation__sage_read_assignment", "mcp__sage_preparation__sage_read_task", "mcp__sage_preparation__sage_update_task", "mcp__sage_preparation__sage_create_run", "mcp__sage_preparation__sage_create_task", "mcp__sage_preparation__sage_prepare_task", "mcp__sage_preparation__sage_read_report", "mcp__sage_preparation__sage_record_report", "mcp__sage_preparation__sage_finish_run", "mcp__sage_preparation__sage_accept_review", "mcp__sage_preparation__sage_read_recorded_report"]);
serveHooks({ mode: options, loadPolicy: async () => {
  // Keep the injected outage active on every connection after the root spawn attempt.
  if (disconnectOnSpawn && outageRecorded()) process.exit(0);
  const policy = createNativePolicy(options, (input, context) => {
  const interrupt = fixtureInterruptDecision(input, context, fixtureModes.interruption);
  if (interrupt) return interrupt;
  if (fixtureModes.readTask) return input.tool_name === 'mcp__sage_preparation__sage_read_task'
    && context.actor === input.session_id && !Object.hasOwn(input,'agent_id')
    && Object.keys(input.tool_input).length === 1 && input.tool_input.task === 'T1'
    ? {decision:'pass'} : {decision:'deny',reason:'Outside the fixed task read fixture.'};
  if (disconnectOnSpawn && input.tool_name === "collaborationspawn_agent") {
    recordOutage(input);
    process.exit(0); // Exit this test server only; never signal another process.
  }
  if (input.tool_name === "Bash" && context.actor === input.session_id
    && context.command?.cmd === "printf sage-native-command-ok; pwd" && context.command.max_output_tokens === 1000
    && ((context.command.shell === "/bin/sh" && context.command.workdir === options.projectDirectory + "/command-workdir"
      && context.command.tty === false && (Object.keys(context.command).length === 5
        || (Object.keys(context.command).length === 12 && context.command.login === false
          && context.command.timeout_ms === 60000 && context.command.sandbox_permissions === "use_default"
          && ["additional_permissions", "justification", "prefix_rule", "environment_id"].every(key => context.command[key] === null))))
      || Object.keys(context.command).length === 2)) return commandDecision(input, context);
  if (input.tool_name === "apply_patch") return patchDecision(input, context);
  return allowed.has(input.tool_name) ? { decision: "pass" }
    : { decision: "deny", reason: "Outside the fixed native fixture route." };
});
  return { ...policy, completeChild(input, context) {
    const result = policy.completeChild(input, context);
    if (result.decision === "unmanaged") recordUnmanagedStop(input, context, result);
    return result;
  } };
} });
