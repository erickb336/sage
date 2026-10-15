import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** All files and the scoped tool approvals belong only to setupCapture's validated temporary root. */
export async function setupSage(root, { disconnectOnSpawn = false, review = false, nestedReview = false, capacity = 5, denyCommand = false, emptyLogbook = false, taskLifecycle = false, omitStop = false, restoreCompaction = false, interruption = false, readTask = false } = {}) {
  cpSync(new URL("../../../plugins/sage-codex", import.meta.url), join(root, "plugin"), { recursive: true });
  for (const file of ["fixture-interrupt.mjs", "sage-options.mjs", "sage-hook-server.mjs", "sage-preparation-server.mjs"]) {
    writeFileSync(join(root, file), readFileSync(new URL(file, import.meta.url)));
  }
  const { configureAdmission, readAdmission, reserveRoleAdmission, createStateTool } = await import(pathToFileURL(join(root, "plugin/core/index.mjs")));
  writeFileSync(join(root, "fixture-fault.json"), JSON.stringify({ disconnectOnSpawn, denyCommand, interruption, readTask }));
  const directory = join(root, "admission");
  configureAdmission(directory, { total: capacity, projects: [{ project: "native-fixture", limit: capacity }] });
  const mode = { directory, project: "native-fixture", projectDirectory: join(root, "workspace"),
    sessionsDir: join(root, "codex/sessions"), observationsRoot: join(root, "observations"), logbookRoot: join(root, "logbook") };
  mkdirSync(mode.observationsRoot);
  const tool = createStateTool({ defaultRoot: () => { throw Error("No ambient logbook"); } });
  const env = { ...process.env, SAGE_HOME: mode.logbookRoot, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args) => tool.git(["-C", mode.projectDirectory, ...args], env);
  if (review || taskLifecycle) {
    git("init", "--quiet", "-b", review ? "codex/t1-review" : "codex/t1-lifecycle");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@users.noreply.github.com", "commit", "--quiet", "--allow-empty", "-m", "fixture");
  }
  const command = (...args) => tool.sage([...args, "--project", mode.projectDirectory], env);
  assert.equal(process.env.SAGE_TEST_MACHINE_ID, "native-fixture", "native state writes need the hardware-query guard");
  command("init");
  if (!emptyLogbook) { command("task", "add", "--title", readTask ? "Simulated task read fixture" : "Native report fixture", "--size", "small");
  if (review) command("task", "T1", "set", "branch=codex/t1-review");
  if (!readTask) command("run", "add", "T1", "--role", review && !nestedReview ? "code-reviewer" : "lead");
  if (nestedReview) command("run", "add", "T1", "--role", "code-reviewer");
  }
  const reviewTarget = review ? { branch: "codex/t1-review", sha: git("rev-parse", "--verify", "HEAD").trim(), round: 0, cycle: 1 } : undefined;
  const logbook = tool.storeDir(mode.projectDirectory, env);
  writeFileSync(join(root, "sage-config.json"), JSON.stringify({ version: 3, mode }));
  const readLogbook = () => Object.fromEntries(["tasks", "runs", "ledger", "findings", "gates", "decisions"].map(name => [name, tool.read(logbook, name)]));
  const retargetFixtureRun = () => {
    const branch = tool.read(logbook, "tasks").find(row => row.id === "T1").branch;
    command("task", "T1", "set", "branch=codex/t1-retargeted");
    return () => command("task", "T1", "set", `branch=${branch}`);
  };
  const servers = [["sage_fixture", "sage-hook-server.mjs"], ["sage_preparation", "sage-preparation-server.mjs"]];
  const config = servers.map(([name, file]) => `[mcp_servers.${name}]\nrequired=true\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(join(root, file))}]\nenv={SAGE_TEST_MACHINE_ID="native-fixture"}\n`).join("")
    + '[mcp_servers.sage_preparation.tools.sage_read_assignment]\napproval_mode="approve"\n[mcp_servers.sage_preparation.tools.sage_read_task]\napproval_mode="approve"\n[mcp_servers.sage_preparation.tools.sage_update_task]\napproval_mode="approve"\n[mcp_servers.sage_preparation.tools.sage_create_run]\napproval_mode="approve"\n[mcp_servers.sage_preparation.tools.sage_create_task]\napproval_mode="approve"\n[mcp_servers.sage_preparation.tools.sage_prepare_task]\napproval_mode="approve"\n[mcp_servers.sage_preparation.tools.sage_read_report]\napproval_mode="approve"\n[mcp_servers.sage_preparation.tools.sage_record_report]\napproval_mode="approve"\n[mcp_servers.sage_preparation.tools.sage_finish_run]\napproval_mode="approve"\n[mcp_servers.sage_preparation.tools.sage_accept_review]\napproval_mode="approve"\n[mcp_servers.sage_preparation.tools.sage_read_recorded_report]\napproval_mode="approve"\n';
  return { checkInterruptionCapacity(released) {
    const state=readAdmission(directory), bound=state.bindings[0];
    assert(bound); const scope={project:bound.project,session:bound.session,epoch:bound.epoch};
    const reserve=call=>reserveRoleAdmission(directory,scope,{task:call==="replacement"?"T2":"T3",run:call==="replacement"?"R2":"R3",issuer:bound.issuer,call},
      {tool:"spawn_agent",turn:bound.turn,name:call,argumentsHash:"0".repeat(64)},{issuerRole:"chief-of-staff",role:"lead"});
    if(!released) { assert.throws(()=>reserve("replacement"),/capacity/); return; }
    assert.equal(reserve("replacement").decision,"permit-once");
    assert.equal(reserve("replacement").decision,"already-reserved");
    assert.throws(()=>reserve("third"),/capacity/);
    const after=readAdmission(directory);
    assert.equal(after.reservations.length,state.reservations.length+1);
    assert.deepEqual(after.reservations[0],state.reservations[0]);
    assert.deepEqual(after.bindings,state.bindings);assert.deepEqual(after.completions,state.completions);
  }, config, reviewTarget, readLogbook, endFixtureRun: () => command("run", "done", "R1", "--status", "done"), retargetFixtureRun, mergeReady: () => tool.mergeCheck(reviewTarget.sha, env).ok, readRunReport: () => readFileSync(join(logbook, tool.read(logbook, "runs")[0].report), "utf8"), readFault: () => JSON.parse(readFileSync(join(root, "hook-outage.json"), "utf8")), readJournal: () => readAdmission(directory), hook: event => {
    // Deliberately omit MCP SubagentStart: the first tool must establish the child's binding.
    if (event === "SubagentStart" || (omitStop && event === "SubagentStop")) return [];
    const fields = event === "SessionStart" && restoreCompaction ? ["cwd", "hook_event_name", "model", "permission_mode", "session_id", "source", "transcript_path"]
      : event === "UserPromptSubmit" ? ["cwd", "hook_event_name", "model", "permission_mode", "prompt", "session_id", "transcript_path", "turn_id"]
      : event === "SubagentStop" ? ["hook_event_name", "session_id", "agent_id", "turn_id", "transcript_path", "agent_transcript_path", "stop_hook_active", "last_assistant_message"]
      : ["hook_event_name", "session_id", "turn_id", "tool_name", "tool_use_id", "tool_input", "transcript_path", ...(event === "PostToolUse" ? ["tool_response"] : [])];
    const handler = { type: "mcp_tool", server: "sage_fixture", tool: "sage_native_hook", timeout: 10,
      input: Object.fromEntries(fields.map(key => [key, "${" + key + "}"])) };
    return (event === "UserPromptSubmit" || (event === "SessionStart" && restoreCompaction)) ? [handler, { ...handler, input: { ...handler.input, instruction_part: 1 } }] : [handler];
  } };
}
