import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** All files and the one tool approval belong only to setupCapture's validated temporary root. */
export async function setupSage(root, { disconnectOnSpawn = false } = {}) {
  cpSync(new URL("../../../plugins/sage-codex", import.meta.url), join(root, "plugin"), { recursive: true });
  for (const file of ["sage-options.mjs", "sage-hook-server.mjs", "sage-preparation-server.mjs"]) {
    writeFileSync(join(root, file), readFileSync(new URL(file, import.meta.url)));
  }
  const { configureAdmission, readAdmission } = await import(pathToFileURL(join(root, "plugin/core/index.mjs")));
  writeFileSync(join(root, "fixture-fault.json"), JSON.stringify({ disconnectOnSpawn }));
  const directory = join(root, "admission");
  configureAdmission(directory, { total: 5, projects: [{ project: "native-fixture", limit: 5 }] });
  const servers = [["sage_fixture", "sage-hook-server.mjs"], ["sage_preparation", "sage-preparation-server.mjs"]];
  const config = servers.map(([name, file]) => `[mcp_servers.${name}]\nrequired=true\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(join(root, file))}]\n`).join("")
    + '[mcp_servers.sage_preparation.tools.sage_prepare_task]\napproval_mode="approve"\n';
  return { config, readFault: () => JSON.parse(readFileSync(join(root, "hook-outage.json"), "utf8")), readJournal: () => readAdmission(directory), hook: event => {
    // Deliberately omit MCP SubagentStart: the first tool must establish the child's binding.
    if (event === "SubagentStart") return [];
    const fields = event === "UserPromptSubmit" ? ["cwd", "hook_event_name", "model", "permission_mode", "prompt", "session_id", "transcript_path", "turn_id"]
      : event === "SubagentStop" ? ["hook_event_name", "session_id", "agent_id", "turn_id", "transcript_path"]
      : ["hook_event_name", "session_id", "turn_id", "tool_name", "tool_use_id", "tool_input", "transcript_path", ...(event === "PostToolUse" ? ["tool_response"] : [])];
    return [{ type: "mcp_tool", server: "sage_fixture", tool: "sage_native_hook", timeout: 10,
      input: Object.fromEntries(fields.map(key => [key, "${" + key + "}"])) }];
  } };
}
