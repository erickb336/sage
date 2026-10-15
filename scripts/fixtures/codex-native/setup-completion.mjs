import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync, realpathSync, unlinkSync, existsSync } from "node:fs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

// The native policy authenticates context.actor before it calls this fixture evaluator.
export function fixtureInterruptDecision(input, context, enabled) {
  if (input.tool_name !== "collaborationinterrupt_agent") return null;
  const args = input.tool_input;
  const permitted = enabled && typeof input.session_id === "string" && input.session_id.length > 0
    && context.actor === input.session_id && !Object.hasOwn(input, "agent_id")
    && args !== null && typeof args === "object" && !Array.isArray(args)
    && Object.keys(args).length === 1 && Object.hasOwn(args, "target")
    && args.target === "/root/probe_child";
  return permitted ? { decision: "pass" }
    : { decision: "deny", reason: "Outside the fixed interruption fixture." };
}

// Test-only configuration in setupCapture's fresh profile. No installed configuration changes.
export async function setupCompletion(root, { failedSpawn = false, followupCapacity = false, capacityFailure = false, commandProbe = false, denyCommand = false, childMessageProbe = false, roleEditProbe = false, writer = false, leadOwnership = false, followup = false, createTask = false, createRun = false, acceptReview = false, nestedReport = false, interruption = false, readTask = false, resumedFailure = false, env = process.env } = {}) {
  cpSync(new URL("./policy-diagnostic.mjs", import.meta.url), join(root, "policy-diagnostic.mjs"));
  cpSync(new URL("../../../plugins/sage-codex", import.meta.url), join(root, "plugin"), { recursive: true });
  const options = { directory: join(root, "admission"), project: "native-fixture",
    projectDirectory: join(root, "workspace"), sessionsDir: join(root, "codex/sessions"),
    observationsRoot: join(root, "observations") };
  mkdirSync(options.observationsRoot);
  // Every preparation route needs actual active records. The identity marker prevents hardware queries.
  assert.equal(env.SAGE_TEST_MACHINE_ID, "native-fixture", "native state writes need the hardware-query guard");
  options.logbookRoot = join(root, "logbook");
  const { createStateTool } = await import(pathToFileURL(join(root, "plugin/core/index.mjs")));
  const runTool = createStateTool({ defaultRoot: () => { throw Error("No ambient logbook"); } });
  const runEnv = { ...env, SAGE_HOME: options.logbookRoot, SAGE_TEST_MACHINE_ID: "native-fixture" };
  const git = (...args) => execFileSync("git", ["-C", options.projectDirectory, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "user.name=Fixture", "-c", "user.email=fixture@users.noreply.github.com", ...args], { env: runEnv, encoding: "utf8" });
  git("init", "--quiet", "-b", "codex/t1-native"); git("commit", "--quiet", "--allow-empty", "-m", "Native fixture");
  const cli = (...args) => runTool.sage([...args, "--project", options.projectDirectory], runEnv);
  cli("init");
  if (!createTask && !createRun) {
    cli("task", "add", "--title", readTask ? "Simulated task read fixture" : "Native recorded run", "--size", "small");
    cli("task", "T1", "set", "branch=codex/t1-native");
    if (!readTask) cli("run", "add", "T1", "--role", acceptReview ? "code-reviewer" : writer ? "implementer" : "lead", ...(writer ? ["--branch", "codex/t1-native"] : []));
  }
  if(nestedReport) cli("run","add","T1","--role","code-reviewer");
  const reviewTarget=nestedReport ? {branch:"codex/t1-native",sha:git("rev-parse","HEAD").trim(),round:0,cycle:1} : undefined;
  if(followupCapacity) {
    cli("task","add","--title","Held capacity child","--size","small");
    cli("run","add","T2","--role","lead");
  }
  if (capacityFailure) {
    cli("task", "add", "--title", "Native capacity retry", "--size", "small");
    cli("run", "add", "T2", "--role", "lead");
  }
  const logbook = runTool.storeDir(options.projectDirectory, runEnv);
  if (leadOwnership) {
    // Synthetic historical overlap: the CLI now prevents two active leads. Restore only the saved R1 row
    // to exercise admission's independent protection against an older overlapping logbook.
    const file = join(logbook, "runs.tsv"), before = readFileSync(file, "utf8").trimEnd().split("\n");
    const id = before[0].split("\t").indexOf("id"), original = before.filter(row => row.split("\t")[id] === "R1");
    assert.equal(original.length, 1);
    cli("run", "done", "R1", "--status", "done"); cli("run", "add", "T1", "--role", "lead");
    const after = readFileSync(file, "utf8").trimEnd().split("\n");
    assert.equal(after.filter(row => row.split("\t")[id] === "R1").length, 1);
    writeFileSync(file, after.map(row => row.split("\t")[id] === "R1" ? original[0] : row).join("\n") + "\n");
    console.log(JSON.stringify({ type: "fixture", event: "historical_lead_overlap", synthetic: true, restoredRun: "R1" }));
  }
  const { configureAdmission, readAdmission, reserveRoleAdmission } = await import(pathToFileURL(join(root, "plugin/core/index.mjs")));
  const { readObservations } = await import(pathToFileURL(join(root, "plugin/runtime/events.mjs")));
  configureAdmission(options.directory, { total: followupCapacity || capacityFailure ? 2 : failedSpawn || interruption ? 1 : 5, projects: [{ project: options.project, limit: followupCapacity || capacityFailure ? 2 : failedSpawn || interruption ? 1 : 5 }] });
  writeFileSync(join(root, "completion-hooks.mjs"), `
    import { appendFileSync, writeFileSync } from 'node:fs';
    import { readAdmission } from './plugin/core/index.mjs';
    import { serveHooks } from './plugin/runtime/mcp-server.mjs';
    import { capturePolicyFailure } from './policy-diagnostic.mjs';
    import { createNativePolicy } from './plugin/runtime/policy.mjs';
    const options = ${JSON.stringify(options)};
    const interruptDecision = ${fixtureInterruptDecision.toString()};
    const allowed = new Set([...(${JSON.stringify(acceptReview || nestedReport)} ? ['mcp__sage_preparation__sage_accept_review'] : []),...(${JSON.stringify(createTask || createRun)} ? ['mcp__sage_preparation__sage_create_task'] : []), ...(${JSON.stringify(createRun || interruption)} ? ['mcp__sage_preparation__sage_create_run'] : []), ...(${JSON.stringify(followup || followupCapacity)} ? ['collaborationfollowup_task'] : []), 'collaborationspawn_agent', 'collaborationlist_agents', 'collaborationwait_agent',
      ...(${JSON.stringify(nestedReport)} ? ['mcp__sage_preparation__sage_read_recorded_report'] : []), 'list_mcp_resources', 'mcp__sage_preparation__sage_read_assignment', 'mcp__sage_preparation__sage_prepare_task', 'mcp__sage_preparation__sage_read_report', 'mcp__sage_preparation__sage_record_report', 'mcp__sage_preparation__sage_finish_run']);
    serveHooks({mode: options, loadPolicy: async () => {
      const policy = createNativePolicy(options, (input, context) => {
        if (${JSON.stringify(readTask)}) return input.tool_name === 'mcp__sage_preparation__sage_read_task'
          && context.actor === input.session_id && !Object.hasOwn(input,'agent_id')
          && Object.keys(input.tool_input).length === 1 && input.tool_input.task === 'T1'
          ? {decision:'pass'} : {decision:'deny',reason:'Outside the fixed task read fixture.'};
        const interrupt = interruptDecision(input, context, ${JSON.stringify(interruption)});
        if (interrupt) return interrupt;
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
      return {...policy, async evaluate(input, context) {
        try {return await policy.evaluate(input, context);}
        catch(error) {
          if (${JSON.stringify(followupCapacity)}) {
            try {capturePolicyFailure(${JSON.stringify(root)}, error);} catch {}
          }
          throw error;
        }
      }, completeChild(input, context) {
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
    + '[mcp_servers.sage_preparation.tools.sage_read_task]\napproval_mode="approve"\n[mcp_servers.sage_preparation.tools.sage_create_run]\napproval_mode="approve"\n[mcp_servers.sage_preparation.tools.sage_create_task]\napproval_mode="approve"\n[mcp_servers.sage_preparation.tools.sage_prepare_task]\napproval_mode="approve"\n[mcp_servers.sage_preparation.tools.sage_read_report]\napproval_mode="approve"\n';
  const receiptConfig = (nestedReport ? '[mcp_servers.sage_preparation.tools.sage_read_recorded_report]\napproval_mode="approve"\n' : "") + '[mcp_servers.sage_preparation.tools.sage_accept_review]\napproval_mode="approve"\n[mcp_servers.sage_preparation.tools.sage_finish_run]\napproval_mode="approve"\n[mcp_servers.sage_preparation.tools.sage_read_assignment]\napproval_mode="approve"\n[mcp_servers.sage_preparation.tools.sage_record_report]\napproval_mode="approve"\n';
  const { readAssignmentTurn, readNativeRecovery } = await import(pathToFileURL(join(root, "plugin/runtime/identity.mjs")));
  return { reviewTarget, verifyNestedAssignments(expected) {
    const state=readAdmission(options.directory);
    for(const {child,parent,path,message} of expected) {
      const bound=state.bindings.find(row=>row.child===child);assert(bound);
      const rows=readObservations(join(options.observationsRoot,bound.session.slice(6))).filter(row=>row.kind==="child-transcript"&&row.child===child&&row.turn===bound.turn);
      assert.equal(rows.length,1);
      const assigned=state.reservations.find(row=>row.assignment.id===bound.assignment);assert(assigned);
      const found=readAssignmentTurn(rows[0].transcript,{sessionsDir:options.sessionsDir},{session:bound.session.slice(6),child,parent,path,author:path.slice(0,path.lastIndexOf("/")),turn:bound.turn,taskHash:assigned.dispatch.taskHash});
      assert.equal(found.taskHash,createHash("sha256").update(message).digest("hex"));
    }
  }, mergeReady:()=>runTool.mergeCheck(reviewTarget.sha,runEnv,{readOnly:true,project:options.projectDirectory}).ok, prepareFollowupCapacityRun() {
    cli("run","done","R1","--status","done");cli("run","add","T1","--role","lead");
    assert.equal(runTool.read(logbook,"runs").find(row=>row.id==="R3")?.task,"T1");
  }, interruptionEvidence(child) {
    const state = readAdmission(options.directory), bound = state.bindings.find(row => row.child === child);
    assert(bound);
    const rows = readObservations(join(options.observationsRoot, bound.session.slice(6)));
    const paths = rows.filter(row => row.kind === "child-transcript" && row.child === child && row.turn === bound.turn);
    const starts = rows.filter(row => row.kind === "child-start" && row.child === child);
    assert.equal(paths.length, 1); assert.equal(starts.length, 1);
    const assigned = state.reservations.find(row => row.assignment.id === bound.assignment);
    return { transcript: paths[0].transcript, expected: {session:bound.session.slice(6),child,parent:bound.issuer,
      path:starts[0].path,author:"/root",turn:bound.turn,taskHash:assigned.dispatch.taskHash} };
  }, checkInterruptionCapacity(released) {
    const state=readAdmission(options.directory), bound=state.bindings[0];
    assert(bound); const scope={project:bound.project,session:bound.session,epoch:bound.epoch};
    const reserve=call=>reserveRoleAdmission(options.directory,scope,{task:call==="replacement"?"T2":"T3",run:call==="replacement"?"R2":"R3",issuer:bound.issuer,call},
      {tool:"spawn_agent",turn:bound.turn,name:call,argumentsHash:"0".repeat(64)},{issuerRole:"chief-of-staff",role:"lead"});
    if(!released) { assert.throws(()=>reserve("replacement"),/capacity/); return; }
    assert.equal(reserve("replacement").decision,"permit-once");
    assert.equal(reserve("replacement").decision,"already-reserved");
    assert.throws(()=>reserve("third"),/capacity/);
    const after=readAdmission(options.directory);
    assert.equal(after.reservations.length,state.reservations.length+1);
    assert.deepEqual(after.reservations[0],state.reservations[0]);
    assert.deepEqual(after.bindings,state.bindings);assert.deepEqual(after.completions,state.completions);
  }, prepareFollowupRun() {
    cli("run", "done", "R1", "--status", "done");
    cli("run", "add", "T1", "--role", "lead");
    if (resumedFailure) cli("run", "add", "T1", "--role", "code-reviewer");
    const rows = runTool.read(logbook, "runs");
    assert.equal(rows.filter(row => row.id === "R2" && row.task === "T1" && row.role === "lead" && row.status === "running").length, 1);
  }, readLogbook: () => Object.fromEntries(["tasks", "runs", "ledger", "findings", "gates", "decisions"].map(name => [name, runTool.read(logbook, name)])),
    readRunReport: name => { assert(/^reports\/R[1-9][0-9]*-[a-f0-9-]+\.md$/.test(name)); return readFileSync(join(logbook, name), "utf8"); },
    config: config + receiptConfig, readRecoveryBaseline: () => JSON.parse(readFileSync(join(root, "recovery-baseline.json"), "utf8")), childEvidence(child) {
      const state = readAdmission(options.directory);
      const bindings = state.bindings.filter(row => row.child === child && !state.completions?.some(done => done.assignment === row.assignment));
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
