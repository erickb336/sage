import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** All files and the scoped tool approvals belong only to setupCapture's validated temporary root. */
export async function setupSage(root, { disconnectOnSpawn = false, review = false, nestedReview = false, capacity = 5, denyCommand = false } = {}) {
  cpSync(new URL("../../../plugins/sage-codex", import.meta.url), join(root, "plugin"), { recursive: true });
  for (const file of ["sage-options.mjs", "sage-hook-server.mjs", "sage-preparation-server.mjs"]) {
    writeFileSync(join(root, file), readFileSync(new URL(file, import.meta.url)));
  }
  const { configureAdmission, readAdmission, createStateTool } = await import(pathToFileURL(join(root, "plugin/core/index.mjs")));
  writeFileSync(join(root, "fixture-fault.json"), JSON.stringify({ disconnectOnSpawn, denyCommand }));
  const directory = join(root, "admission");
  configureAdmission(directory, { total: capacity, projects: [{ project: "native-fixture", limit: capacity }] });
  const mode = { directory, project: "native-fixture", projectDirectory: join(root, "workspace"),
    sessionsDir: join(root, "codex/sessions"), observationsRoot: join(root, "observations"), logbookRoot: join(root, "logbook") };
  mkdirSync(mode.observationsRoot);
  const tool = createStateTool({ defaultRoot: () => { throw Error("No ambient logbook"); } });
  const env = { ...process.env, SAGE_HOME: mode.logbookRoot, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args) => tool.git(["-C", mode.projectDirectory, ...args], env);
  if (review) {
    git("init", "--quiet", "-b", "codex/t1-review");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@users.noreply.github.com", "commit", "--quiet", "--allow-empty", "-m", "fixture");
  }
  const command = (...args) => tool.sage([...args, "--project", mode.projectDirectory], env);
  command("init"); command("task", "add", "--title", "Native report fixture", "--size", "small");
  if (review) command("task", "T1", "set", "branch=codex/t1-review");
  command("run", "add", "T1", "--role", review && !nestedReview ? "code-reviewer" : "lead");
  if (nestedReview) command("run", "add", "T1", "--role", "code-reviewer");
  const reviewTarget = review ? { branch: "codex/t1-review", sha: git("rev-parse", "--verify", "HEAD").trim(), round: 0, cycle: 1 } : undefined;
  const logbook = tool.storeDir(mode.projectDirectory, env);
  writeFileSync(join(root, "sage-config.json"), JSON.stringify({ version: 3, mode }));
  const readLogbook = () => Object.fromEntries(["tasks", "runs", "ledger", "findings", "gates", "decisions"].map(name => [name, tool.read(logbook, name)]));
  const servers = [["sage_fixture", "sage-hook-server.mjs"], ["sage_preparation", "sage-preparation-server.mjs"]];
  const config = servers.map(([name, file]) => `[mcp_servers.${name}]\nrequired=true\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(join(root, file))}]\n`).join("")
    + '[mcp_servers.sage_preparation.tools.sage_prepare_task]\napproval_mode="approve"\n[mcp_servers.sage_preparation.tools.sage_read_report]\napproval_mode="approve"\n[mcp_servers.sage_preparation.tools.sage_record_report]\napproval_mode="approve"\n[mcp_servers.sage_preparation.tools.sage_finish_run]\napproval_mode="approve"\n[mcp_servers.sage_preparation.tools.sage_accept_review]\napproval_mode="approve"\n[mcp_servers.sage_preparation.tools.sage_read_recorded_report]\napproval_mode="approve"\n';
  return { config, reviewTarget, readLogbook, mergeReady: () => tool.mergeCheck(reviewTarget.sha, env).ok, readRunReport: () => readFileSync(join(logbook, tool.read(logbook, "runs")[0].report), "utf8"), readFault: () => JSON.parse(readFileSync(join(root, "hook-outage.json"), "utf8")), readJournal: () => readAdmission(directory), hook: event => {
    // Deliberately omit MCP SubagentStart: the first tool must establish the child's binding.
    if (event === "SubagentStart") return [];
    const fields = event === "UserPromptSubmit" ? ["cwd", "hook_event_name", "model", "permission_mode", "prompt", "session_id", "transcript_path", "turn_id"]
      : event === "SubagentStop" ? ["hook_event_name", "session_id", "agent_id", "turn_id", "transcript_path", "agent_transcript_path", "stop_hook_active", "last_assistant_message"]
      : ["hook_event_name", "session_id", "turn_id", "tool_name", "tool_use_id", "tool_input", "transcript_path", ...(event === "PostToolUse" ? ["tool_response"] : [])];
    const handler = { type: "mcp_tool", server: "sage_fixture", tool: "sage_native_hook", timeout: 10,
      input: Object.fromEntries(fields.map(key => [key, "${" + key + "}"])) };
    return event === "UserPromptSubmit" ? [handler, { ...handler, input: { ...handler.input, instruction_part: 1 } }] : [handler];
  } };
}
