import { createHash } from "node:crypto";
// Isolated native V2 transport check with simulated model responses; not a live Sage pilot.
// A wide deadlock guard closes transport first, then stops an unresponsive owned child.
import http from "node:http";
import assert from "node:assert/strict";
import {existsSync,readdirSync,readFileSync} from "node:fs";
import {waitNative} from "./fixtures/codex-native/wait-native.mjs";
import {setupCapture} from "./fixtures/codex-native/setup-capture.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

assert(process.argv.slice(2).every(arg => ["--sage-followup", "--sage-lead-ownership", "--sage-role-edit", "--writer", "--sage-child-message", "--sage-child-sandbox", "--sage-failed-spawn", "--deny-spawn", "--sage-completion", "--sage-report", "--sage-receipt", "--sage-child-recovery", "--sage-child-repeat-recovery"].includes(arg)), "unknown_probe_argument");
const deadlineMs = process.env.NODE_TEST_CONTEXT && /^\d+$/.test(process.env.SAGE_PROBE_TEST_DEADLINE_MS ?? "")
  ? Number(process.env.SAGE_PROBE_TEST_DEADLINE_MS) : 120_000;
const followup = process.argv.includes("--sage-followup");
assert(!followup || process.argv.slice(2).length === 1, "followup_is_a_separate_probe");
const leadOwnership = process.argv.includes("--sage-lead-ownership");
assert(!leadOwnership || process.argv.slice(2).length === 1, "ownership_is_a_separate_probe");
let ownershipStage = 0;
const roleEdit = process.argv.includes("--sage-role-edit");
const writer = process.argv.includes("--writer");
assert(!writer || roleEdit, "writer_needs_role_probe");
assert(!roleEdit || process.argv.slice(2).every(arg => ["--sage-role-edit","--writer"].includes(arg)), "role_edit_is_a_separate_probe");
let roleEditVerified = false, childPatchTool;
const childMessage = process.argv.includes("--sage-child-message");
assert(!childMessage || process.argv.slice(2).length === 1, "message_is_a_separate_probe");
let messageVerified = false, chiefMessageDelivered = false, messageWaitCycles = 0;
const childSandbox = process.argv.includes("--sage-child-sandbox");
assert(!childSandbox || process.argv.slice(2).length === 1, "sandbox_is_a_separate_probe");
let sandboxVerified = false, childCommandTool;
const denySpawn = process.argv.includes("--deny-spawn");
const repeatRecovery = process.argv.includes("--sage-child-repeat-recovery");
const recoveryProbe = repeatRecovery || process.argv.includes("--sage-child-recovery");
const finishRun = process.argv.includes("--sage-report");
const receiptProbe = finishRun || process.argv.includes("--sage-receipt") || recoveryProbe;
const reportProbe = process.argv.includes("--sage-report") || receiptProbe;
const failedSpawn = process.argv.includes("--sage-failed-spawn");
const completion = followup || leadOwnership || roleEdit || childMessage || childSandbox || failedSpawn || process.argv.includes("--sage-completion") || reportProbe;
assert(!(failedSpawn && (reportProbe || recoveryProbe)), "incompatible_failure_probe");
assert(!(denySpawn && completion), "incompatible_probe_modes");
let denied = false;
const MARKER = "sage-native-parent-ok";
const CHILD_MARKER = completion ? ["STATUS done", "RESULT sage-native-child-ok", "EVIDENCE simulated native fixture", "FINDINGS none", "QUESTIONS none", "NOT VERIFIED real model", "BRANCH none"].join("\n") : "sage-native-child-ok";
let CHILD_PROMPT = `Return exactly ${CHILD_MARKER}. Do not call any tool.`;
const binary = process.env.SAGE_CODEX_BIN ?? "codex";
const root = realpathSync(mkdtempSync(join(tmpdir(), "sage-codex-one-child-")));
try {
assert(/^[A-Za-z0-9/._-]+$/.test(root), "unsafe_probe_root");
const workspace = join(root, "workspace");
const baselineHome = join(root, "home");
const codexHome = join(root, "codex");
const temporary = join(root, "tmp");
for (const dir of [workspace, baselineHome, codexHome, temporary]) mkdirSync(dir);
const catalogPath = join(root, "model-catalog.json");
writeFileSync(catalogPath, JSON.stringify({ models: [{
  slug: "sage-native-parent", display_name: "Sage native lifecycle fixture",
  ...(roleEdit ? {apply_patch_tool_type:"freeform"} : {}),
  supported_reasoning_levels: [], shell_type: childSandbox ? "unified_exec" : "disabled", visibility: "list",
  supported_in_api: true, priority: 1, support_verbosity: false, multi_agent_version: "v2",
  truncation_policy: { mode: "bytes", limit: 10000 }, experimental_supported_tools: [], tool_mode: "direct",
  model_messages: { instructions_template: "Follow the fixed native-agent probe task. Do not use shell or external tools." },
}] }));

// An allowlist excludes provider credentials, proxies, session transport, and user config.
const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: baselineHome,
  CODEX_HOME: codexHome,
  TMPDIR: temporary,
  LANG: "en_US.UTF-8",
  DO_NOT_TRACK: "1",
};
// Disable real machine-identity queries in this probe process and its native child.
// Outside NODE_TEST_CONTEXT the fixed marker means unavailable identity, never trusted hardware evidence.
process.env.SAGE_TEST_MACHINE_ID = "native-fixture";
env.SAGE_TEST_MACHINE_ID = "native-fixture";
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const telemetryArgs = ["-c", "analytics.enabled=false", "-c", 'otel.exporter="none"', "-c", 'otel.metrics_exporter="none"', "-c", 'otel.trace_exporter="none"'];
const launch = (args) => spawn(binary, [...telemetryArgs, ...args], { cwd: workspace, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
const binaryPaths = new Set();
for (const candidate of isAbsolute(binary) ? [binary] : env.PATH.split(delimiter).map((dir) => join(dir, binary))) {
  try { binaryPaths.add(candidate); binaryPaths.add(realpathSync(candidate)); } catch { /* Not this PATH entry. */ }
}
const diagnostic = (value) => {
  let text = value.slice(0, 4096);
  for (const path of new Set([root, realpathSync(root)])) text = text.split(path).join("[baseline-temp]");
  for (const path of binaryPaths) text = text.split(path).join("[codex-binary]");
  return text.trim();
};

const versionChild = launch(["--version"]);
let versionText = "";
let versionStderr = "";
versionChild.stdout.on("data", (data) => { versionText = (versionText + data).slice(0, 200); });
versionChild.stderr.on("data", (data) => { versionStderr = (versionStderr + data).slice(0, 4096); });
versionChild.stdin.on("error", () => {});
versionChild.stdin.end();
const versionResult = await waitNative(versionChild, { deadlineMs });
const version = /^codex-cli \d+\.\d+\.\d+(?:[-+.][A-Za-z0-9.-]+)?$/.test(versionText.trim()) ? versionText.trim() : null;
if (versionResult.code !== 0 || version !== "codex-cli 0.160.0") {
  print({ type: "result", verified: false, reason: versionResult.timedOut ? "native_deadline" : "version_check_failed", diagnostic: diagnostic(versionStderr) });
  process.exitCode = 1;
} else {
  print({ type: "version", version });
  const integrated = await setupCapture({root,codexHome,workspace,env,binary,denySpawn,completion,recovery:recoveryProbe,failedSpawn,commandProbe:childSandbox,childMessageProbe:childMessage,roleEditProbe:roleEdit,writer,leadOwnership,followup,deadlineMs});
  let failureStage = 0;
  let followupPrepared, followupVerified = false, followupResponse, releaseFollowup;
  const followupReady = new Promise(resolve => { releaseFollowup = resolve; });
  let finishVerified = false, firstFinish, beforeFinishLogbook, finishedLogbook;
  let prepared = false, blockedStopVerified = false, reportVerified = false, receiptVerified = false, beforeReport, expectedReport, recordedState;
  let compactRequests = 0, recoveryRound = 0, recoveryPhase = "compact", recoveredRounds = 0;
  const texts = value => typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(texts)
    : value && typeof value === "object" ? Object.values(value).flatMap(texts) : [];
  let responseRequests = 0;
  let rejectedRequests = 0;
  let rootRequests = 0;
  let childRequests = 0;
  let rootThread;
  let childThread;
  let taskName;
  let childResponse;
  let childResponseSent = false;
  let nativeRunning = false;
  let nativeCompleted = false;
  let nativeWait = false;
  let childTaskSeen = false;
  let fixtureFailure;
  let releaseChildReady;
  const childReady = new Promise((resolve) => { releaseChildReady = resolve; });
  const pending = new Set();
  const calls = { followPrepare:"probe_follow_prepare", follow:"probe_follow", followWait:"probe_follow_wait", followDone:"probe_follow_done", finish: "probe_finish", finishRetry: "probe_finish_retry", ownerPrepare:"probe_owner_prepare", ownerSpawn:"probe_owner_spawn", ownerList:"probe_owner_list", edit:"probe_role_edit", messageControl:"probe_message_control", peerMessage:"probe_child_peer_message", chiefMessage:"probe_child_chief_message", sandbox: "probe_child_sandbox", failurePrepare: "probe_failure_prepare", failureSpawn: "probe_failure_spawn", failureList: "probe_failure_list", compact1: "probe_compact_1", compact2: "probe_compact_2", denied1: "probe_denied_1", denied2: "probe_denied_2", recovery1: "probe_recovery_1", recovery2: "probe_recovery_2", record: "probe_record", reread: "probe_reread", retry: "probe_retry", report: "probe_report", prepare: "probe_prepare", spawn: "probe_spawn", running: "probe_running", wait: "probe_wait", completed: "probe_completed" };
  const knownCalls = new Set(Object.values(calls));
  const check = (condition, reason) => { if (!condition) throw new Error(reason); };
  const reject = (res) => {
    if (res.writableEnded) return;
    if (!res.headersSent) res.writeHead(400, { "Content-Type": "application/json", Connection: "close" });
    res.end(JSON.stringify({ error: { message: "Native lifecycle fixture validation failed" } }));
  };
  const failFixture = (reason) => {
    fixtureFailure ??= reason;
    print({ type: "fixture_failure", reason: fixtureFailure });
    releaseChildReady();
    releaseFollowup();
    for (const response of pending) reject(response);
  };
  const inspectRequest = (request) => {
    const outputs = {};
    const input = Array.isArray(request.input) ? request.input : [];
    for (const item of input) {
      if (!["function_call_output", "custom_tool_call_output"].includes(item.type) || !knownCalls.has(item.call_id)) continue;
      check(!(item.call_id in outputs), "duplicate_native_tool_result");
      const output = typeof item.output === "string" ? item.output
        : Array.isArray(item.output) && item.output.length >= 1 && item.output.length <= ([calls.followPrepare, calls.finish, calls.finishRetry, calls.ownerPrepare, calls.failurePrepare, calls.prepare, calls.report, calls.record, calls.reread, calls.retry, calls.recovery1, calls.recovery2].includes(item.call_id) ? 2 : 1) && item.output.every(part => part.type === "input_text") ? item.output.at(-1).text : null;
      check(typeof output === "string", "unsupported_native_tool_result_encoding");
      try { outputs[item.call_id] = JSON.parse(output); } catch {
        if ((failedSpawn && item.call_id === calls.failureSpawn) || (denySpawn && item.call_id === calls.spawn) || [calls.follow, calls.ownerSpawn, calls.edit, calls.messageControl, calls.peerMessage, calls.chiefMessage, calls.sandbox, calls.denied1, calls.denied2].includes(item.call_id)) outputs[item.call_id] = output;
        else throw new Error("native_tool_result_is_not_json");
      }
    }
    const agentTools = [];
    for (const tool of request.tools ?? []) {
      if (tool.type === "namespace" && tool.name === "collaboration") {
        for (const member of tool.tools ?? []) if (member.type === "function") agentTools.push(member.name);
      }
    }
    const commandTools = (request.tools ?? []).flatMap(tool => tool.type === "namespace"
      ? (tool.tools ?? []).filter(member => member.type === "function" && member.name === "exec_command").map(member => ({namespace: tool.name, name: member.name}))
      : tool.type === "function" && tool.name === "exec_command" ? [{name: tool.name}] : []);
    const patchTools = (request.tools ?? []).flatMap(tool => tool.type === "namespace"
      ? (tool.tools ?? []).filter(member => member.name === "apply_patch").map(member => ({namespace:tool.name, name:member.name}))
      : tool.name === "apply_patch" ? [{name:tool.name}] : []);
    const tasks=input.filter(item=>item.type==="agent_message");
    const task=tasks[0];
    const childPromptSeen=tasks.length===1 && task.author==="/root" && task.recipient==="/root/probe_child"
      && Array.isArray(task.content) && task.content.length===2
      && task.content[0].type==="input_text"
      && task.content[0].text==="Message Type: NEW_TASK\nTask name: /root/probe_child\nSender: /root\nPayload:\n"
      && task.content[1].type==="encrypted_content" && task.content[1].encrypted_content===CHILD_PROMPT;
    const mcpTools = name => (request.tools ?? []).flatMap(tool => tool.type === "namespace"
      ? (tool.tools ?? []).filter(member => member.name === name).map(member => ({namespace: tool.name, name: member.name}))
      : tool.type === "function" && tool.name === `mcp__sage_preparation__${name}` ? [{name: tool.name}] : []);
    const followupPromptSeen = tasks.at(-1)?.author === "/root" && tasks.at(-1)?.recipient === "/root/probe_child"
      && tasks.at(-1)?.content?.some(part => part.type === "encrypted_content" && part.encrypted_content === followupPrepared?.message);
    return { followupPromptSeen, finishTools: mcpTools("sage_finish_run"), outputs, agentTools, childPromptSeen, commandTools, patchTools,
      chiefMessageDelivered: input.some(item => item.type === "agent_message" && item.author === "/root/probe_child"
        && item.recipient === "/root" && texts(item.content).includes("Fixed progress report")), prepareTools: mcpTools("sage_prepare_task"), reportTools: mcpTools("sage_read_report"), recordTools: mcpTools("sage_record_report"), assignmentTools: mcpTools("sage_read_assignment") };
  };
  let responseId = 0;
  const respond = (res, item) => {
    if (fixtureFailure) { reject(res); return; }
    const id = `native_probe_${++responseId}`;
    const events = [{ type: "response.created", response: { id, status: "in_progress", output: [] } }];
    if (item.type === "message") {
      const part = item.content[0];
      const position = { item_id: item.id, output_index: 0, content_index: 0 };
      events.push(
        { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
        { type: "response.content_part.added", ...position, part: { ...part, text: "" } },
        { type: "response.output_text.delta", ...position, delta: part.text },
        { type: "response.output_text.done", ...position, text: part.text },
        { type: "response.content_part.done", ...position, part },
      );
    }
    events.push(
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: recoveryProbe && [calls.compact1, calls.compact2].includes(item.call_id) ? 200000 : 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: recoveryProbe && [calls.compact1, calls.compact2].includes(item.call_id) ? 200000 : 0 } } },
    );
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "close" });
    for (const event of events) res.write(`event: ${event.type}
data: ${JSON.stringify(event)}

`);
    res.end();
  };
  const message = (text) => ({ id: `message_${responseId + 1}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
  // This separate namespace field matches the current Responses protocol and upstream fixtures.
  const call = (call_id, name, args) => ({ type: "function_call", namespace: "collaboration", name, call_id, arguments: JSON.stringify(args) });
  const childEntry = (result) => {
    check(Array.isArray(result?.agents), "list_result_missing_agents");
    const matches = result.agents.filter((agent) => agent.agent_name === taskName);
    check(matches.length === 1, "list_result_does_not_identify_exact_spawned_task");
    return matches[0];
  };
  const server = http.createServer(async (req, res) => {
    pending.add(res);
    res.once("finish", () => pending.delete(res));
    try {
      if (fixtureFailure) { req.resume(); reject(res); return; }
      check(req.method === "POST" && (req.url ?? "").split("?")[0] === "/v1/responses", "unexpected_http_request");
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
        check(body.length <= 2 * 1024 * 1024, "request_exceeds_fixture_bound");
      }
      let request;
      try { request = JSON.parse(body); } catch { throw new Error("invalid_request_json"); }
      body = "";
      if (recoveryProbe && texts(request.input).some(text => text.includes("SAGE_CHILD_COMPACT_REQUEST"))) {
        responseRequests++;
        check(req.headers["thread-id"] === childThread, "compaction_wrong_child");
        check(++compactRequests <= (repeatRecovery ? 2 : 1), "unexpected_compaction_count");
        respond(res, message("SAGE_CHILD_COMPACT_SUMMARY: Continue the fixed child probe.")); return;
      }
      const requestTexts = recoveryProbe ? texts(request.input) : [];
      const info = inspectRequest(request);
      request = null; // Retain only tool results, advertised names, and a fixed-task boolean.
      responseRequests++;
      const thread = req.headers["thread-id"];
      const subagent = req.headers["x-openai-subagent"];
      check(typeof thread === "string" && thread.length > 0, "missing_native_thread_header");
      if (subagent === "collab_spawn") {
        if (followup && childRequests === 2) {
          check(thread === childThread && info.followupPromptSeen, "followup_child_or_message_changed");
          childRequests++; followupResponse = res; releaseFollowup(); return;
        }
        if (roleEdit && childRequests === 1) {
          check(thread === childThread && childResponseSent, "wrong_edit_child");
          const file = join(workspace,"role-edit-proof.txt");
          if (writer) {
            check(existsSync(file) && readFileSync(file,"utf8") === "fixed role edit proof\n", "writer_file_missing_or_changed");
            const receipt = JSON.parse(readFileSync(join(root,"edit-evaluation.json"),"utf8"));
            check(receipt.call === calls.edit && receipt.role === "implementer", "wrong_writer_evaluation");
          } else {
            check(typeof info.outputs[calls.edit] === "string" && info.outputs[calls.edit].includes("This Sage role cannot edit files"), "role_edit_denial_missing");
            check(!existsSync(file) && !existsSync(join(root,"edit-evaluation.json")), "readonly_edit_reached_evaluator_or_file");
          }
          const events = readdirSync(join(root,"events")).map(name => JSON.parse(readFileSync(join(root,"events",name),"utf8")));
          check(events.filter(row => row.hook_event_name === "PostToolUse" && row.tool_use_id === calls.edit).length === (writer ? 1 : 0), "edit_execution_event_mismatch");
          roleEditVerified = true; childRequests++;
          print({type:"role_edit_evidence",writer,roleEditVerified,fileWritten:writer,simulatedModel:true});
          respond(res,message(CHILD_MARKER)); return;
        }
        if (childMessage && childRequests === 1) {
          check(thread === childThread && Object.hasOwn(info.outputs,calls.messageControl), "message_control_missing");
          check(info.agentTools.includes("send_message"), "child_message_tool_missing");
          childRequests++; respond(res,call(calls.peerMessage,"send_message",{target:"/root/nonexistent_peer",message:"Fixed progress report"})); return;
        }
        if (childMessage && childRequests === 2) {
          check(thread === childThread && childResponseSent, "wrong_message_child");
          check(typeof info.outputs[calls.peerMessage] === "string" && info.outputs[calls.peerMessage].includes(
            "A Sage child sends messages only to the chief"), "peer_message_not_denied");
          check(!existsSync(join(root,"message-evaluations.jsonl")), "peer_message_reached_evaluator");
          childRequests++; respond(res, call(calls.chiefMessage,"send_message",{target:"/root",message:"Fixed progress report"})); return;
        }
        if (childMessage && childRequests === 3) {
          check(thread === childThread && info.outputs[calls.chiefMessage] === "", "chief_message_receipt_missing");
          const receipts = readFileSync(join(root,"message-evaluations.jsonl"),"utf8").trim().split("\n").map(JSON.parse);
          check(receipts.length === 1 && receipts[0].call === calls.chiefMessage && receipts[0].target === "/root", "wrong_message_evaluation");
          const events = readdirSync(join(root,"events")).map(name => JSON.parse(readFileSync(join(root,"events",name),"utf8")));
          check(!events.some(row => row.hook_event_name === "PostToolUse" && row.tool_use_id === calls.peerMessage), "peer_message_executed");
          messageVerified = true; childRequests++; respond(res,message(CHILD_MARKER)); return;
        }
        if (childSandbox && childRequests === 1) {
          check(thread === childThread && childResponseSent, "wrong_sandbox_child");
          check(typeof info.outputs[calls.sandbox] === "string" && info.outputs[calls.sandbox].includes(
            "A child cannot request broader sandbox permissions. Ask the chief to run this command."), "sandbox_denial_missing");
          check(!existsSync(join(root, "command-policy-receipt.json")), "sandbox_reached_evaluator");
          const events = readdirSync(join(root, "events")).map(name => JSON.parse(readFileSync(join(root, "events", name), "utf8")));
          check(!events.some(row => row.hook_event_name === "PostToolUse" && row.tool_use_id === calls.sandbox), "sandbox_command_executed");
          sandboxVerified = true; childRequests++;
          print({type:"sandbox_evidence", deniedBeforeEvaluator:true, noPostToolExecution:true, simulatedModel:true});
          respond(res, message(CHILD_MARKER)); return;
        }
        if (recoveryProbe && childRequests > 0) {
          check(thread === childThread && childResponseSent, "wrong_recovery_child");
          childRequests++;
          const evidence = integrated.childEvidence(childThread), {state, bound, recovery} = evidence;
          check(JSON.stringify(state) === JSON.stringify(integrated.readRecoveryBaseline()), "recovery_changed_journal");
          check(state.reservations.length === 1 && state.bindings.length === 1 && (state.completions?.length ?? 0) === 0,
            "recovery_changed_admission");
          if (recoveryPhase === "compact") {
            recoveryRound++;
            check(evidence.compactions === recoveryRound && compactRequests === recoveryRound
              && recovery.required && recovery.compaction && recovery.call === null, "compaction_did_not_invalidate_recovery");
            check(requestTexts.some(text => text.includes("SAGE_CHILD_COMPACT_SUMMARY")), "missing_compaction_summary");
            recoveryPhase = "denied";
            respond(res, {type:"function_call", name:"list_mcp_resources", call_id: calls[`denied${recoveryRound}`], arguments:"{}"}); return;
          }
          if (recoveryPhase === "denied") {
            check(typeof info.outputs[calls[`denied${recoveryRound}`]] === "string"
              && info.outputs[calls[`denied${recoveryRound}`]].includes("Read your current assignment"), "unrecovered_work_ran");
            const events = readdirSync(join(root,"events")).map(name=>JSON.parse(readFileSync(join(root,"events",name),"utf8")));
            check(!events.some(row=>row.hook_event_name==="PostToolUse" && row.tool_use_id===calls[`denied${recoveryRound}`]), "denied_tool_executed");
            recoveryPhase = "stop"; respond(res, message(CHILD_MARKER)); return;
          }
          if (recoveryPhase === "stop") {
            check(requestTexts.some(text=>text.includes("sage_read_assignment before completing this task")), "unrecovered_stop_not_blocked");
            check(integrated.readStops().at(-1)?.decision === "recovery-required", "missing_recovery_stop");
            blockedStopVerified = true;
            check(info.assignmentTools.length === 1, "assignment_reader_missing");
            recoveryPhase = "read";
            respond(res, {type:"function_call", ...info.assignmentTools[0], call_id:calls[`recovery${recoveryRound}`], arguments:"{}"}); return;
          }
          check(recoveryPhase === "read", "unexpected_recovery_phase");
          const result = info.outputs[calls[`recovery${recoveryRound}`]];
          check(result?.decision === "current-assignment" && result.message === CHILD_PROMPT && result.child === childThread
            && result.turn === bound.turn && result.assignment === bound.assignment && result.task === "T1" && result.run === "R1"
            && result.taskHash === createHash("sha256").update(CHILD_PROMPT).digest("hex"), "assignment_recovery_changed_identity");
          check(!recovery.required && recovery.call === calls[`recovery${recoveryRound}`], "native_recovery_output_not_verified");
          recoveredRounds++;
          print({type:"child_recovery_evidence", round:recoveryRound, exactSavedAssignment:true, latestCompactionVerified:true,
            toolAndStopHeld:true, unchangedAdmission:true, simulatedModel:true});
          if (repeatRecovery && recoveryRound === 1) {
            recoveryPhase = "compact";
            respond(res, {type:"function_call", name:"list_mcp_resources", call_id:calls.compact2, arguments:"{}"}); return;
          }
          recoveryPhase = "complete"; respond(res, message(CHILD_MARKER)); return;
        }
        if (completion && childRequests === (roleEdit ? 2 : childMessage ? 4 : childSandbox ? 2 : 1)) {
          check(thread === childThread && childResponseSent, "unexpected_stop_retry");
          const state = integrated.readJournal(), stops = integrated.readStops();
          check(state.reservations.length === (failedSpawn ? 2 : 1) && state.bindings.length === 1 && (state.completions?.length ?? 0) === 0,
            "blocked_stop_released_capacity");
          check(stops.length === 1 && stops[0].decision === "stop-observed" && stops[0].completions === 0,
            "stop_callback_was_not_observed");
          check(existsSync(join(root, `blocked-${childThread}.json`)), "blocking_hook_did_not_run");
          blockedStopVerified = true; childRequests++;
          print({type: "blocked_stop_evidence", slotRetained: true, nextNativeRequestObserved: true});
          respond(res, message(CHILD_MARKER)); return;
        }
        check(rootThread && thread !== rootThread && childRequests === 0, "unexpected_child_request_identity");
        check(info.childPromptSeen, "child_did_not_receive_fixed_task");
        if (roleEdit) { check(info.patchTools.length === 1, "patch_tool_missing"); childPatchTool = info.patchTools[0]; }
        if (childSandbox) { check(info.commandTools.length === 1, "command_tool_missing"); childCommandTool = info.commandTools[0]; }
        childThread = thread;
        childRequests++;
        childTaskSeen = true;
        childResponse = res;
        print({ type: "evidence", event: "native_child_request_held", distinctThread: true, fixedTaskReceived: true });
        releaseChildReady();
        return;
      }
      check(!subagent, "unexpected_non_spawn_agent_request");
      if (childMessage && info.chiefMessageDelivered) chiefMessageDelivered = true;
      rootThread ??= thread;
      check(thread === rootThread, "unexpected_root_thread_identity");
      if (failedSpawn && failureStage < 4) {
        check(info.prepareTools.length === 1, "failure_prepare_tool_missing");
        if (failureStage === 0) {
          failureStage = 1;
          const brief = Object.fromEntries(["GOAL", "SCOPE", "CONTEXT", "DECISIONS", "ACCEPTANCE", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"].map(key => [key, "Complete the fixed native fixture task."]));
          respond(res, {type: "function_call", ...info.prepareTools[0], call_id: calls.failurePrepare,
            arguments: JSON.stringify({task: "T1", run: "R1", name: "probe_failed", role: "lead", brief})}); return;
        }
        if (failureStage === 1) {
          const receipt = info.outputs[calls.failurePrepare];
          check(receipt?.decision === "prepared" && typeof receipt.message === "string", "failure_preparation_missing");
          failureStage = 2;
          respond(res, call(calls.failureSpawn, "spawn_agent", {task_name: "probe_failed", message: receipt.message,
            fork_turns: "none", model: "sage-fixture-nonexistent-model"})); return;
        }
        if (failureStage === 2) {
          check(info.outputs[calls.failureSpawn] === "Unknown model `sage-fixture-nonexistent-model` for spawn_agent. Available models: sage-native-parent", "unexpected_native_preflight_error");
          const state = integrated.readJournal();
          check(state.config.total === 1 && state.reservations.length === 1 && state.bindings.length === 0
            && (state.failures?.length ?? 0) === 0 && childRequests === 0, "failure_released_before_reconciliation");
          failureStage = 3;
          respond(res, call(calls.failureList, "list_agents", {})); return;
        }
        const registry = info.outputs[calls.failureList], state = integrated.readJournal();
        check(registry?.agents?.length === 1 && registry.agents[0].agent_name === "/root", "failed_dispatch_created_child");
        check(state.failures?.length === 1 && state.bindings.length === 0 && childRequests === 0
          && state.failures[0].assignment === state.reservations[0].assignment.id, "failed_dispatch_not_reconciled");
        failureStage = 4;
        print({type: "failed_spawn_registry", onlyRoot: true, failures: 1, bindings: 0});
      }
      if (completion && !prepared) {
        if (!Object.hasOwn(info.outputs, calls.prepare)) {
          check(info.prepareTools.length === 1, "preparation_tool_missing");
          const brief = Object.fromEntries(["GOAL", "SCOPE", "CONTEXT", "DECISIONS", "ACCEPTANCE", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"].map(key => [key, "Complete the fixed native fixture task."]));
          respond(res, {type: "function_call", ...info.prepareTools[0], call_id: calls.prepare,
            arguments: JSON.stringify({task: "T1", run: "R1", name: "probe_child", role: writer ? "implementer" : "lead", brief})}); return;
        }
        const receipt = info.outputs[calls.prepare];
        check(receipt?.decision === "prepared" && typeof receipt.message === "string" && receipt.fork_turns === "none", "preparation_missing");
        CHILD_PROMPT = receipt.message; prepared = true;
      }
      if (leadOwnership && rootRequests === 2 && ownershipStage < 3) {
        if (ownershipStage === 0) {
          check(childEntry(info.outputs[calls.running]).agent_status === "running" && !childResponseSent, "first_lead_not_held");
          check(info.prepareTools.length === 1, "ownership_preparation_tool_missing");
          ownershipStage = 1;
          const brief = Object.fromEntries(["GOAL", "SCOPE", "CONTEXT", "DECISIONS", "ACCEPTANCE", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"].map(key => [key, "Complete the fixed native fixture task."]));
          respond(res, {type:"function_call", ...info.prepareTools[0], call_id:calls.ownerPrepare,
            arguments:JSON.stringify({task:"T1",run:"R2",name:"second_lead",role:"lead",brief})}); return;
        }
        if (ownershipStage === 1) {
          const receipt = info.outputs[calls.ownerPrepare];
          check(receipt?.decision === "prepared" && typeof receipt.message === "string", "second_lead_not_prepared");
          ownershipStage = 2;
          respond(res, call(calls.ownerSpawn, "spawn_agent", {task_name:"second_lead",message:receipt.message,fork_turns:"none"})); return;
        }
        if (!Object.hasOwn(info.outputs, calls.ownerList)) {
          check(typeof info.outputs[calls.ownerSpawn] === "string" && info.outputs[calls.ownerSpawn].includes("Sage could not verify this tool call."), "second_lead_not_denied");
          const state = integrated.readJournal();
          check(state.config.total === 5 && state.reservations.length === 1, "ownership_consumed_extra_capacity");
          respond(res, call(calls.ownerList,"list_agents",{})); return;
        }
        const registry = info.outputs[calls.ownerList];
        check(registry?.agents?.length === 2 && registry.agents.some(row => row.agent_name === "/root")
          && registry.agents.some(row => row.agent_name === "/root/probe_child"), "ownership_started_extra_child");
        ownershipStage = 3;
        print({type:"lead_ownership_evidence",capacity:5,reservations:1,deniedSecondLead:true,nativeAgents:2,simulatedModel:true});
      }
      rootRequests++;
      if (rootRequests === 1) {
        check(["spawn_agent", "list_agents", "wait_agent"].every((name) => info.agentTools.includes(name)), "required_native_tools_missing");
        respond(res, call(calls.spawn, "spawn_agent", { task_name: "probe_child", message: CHILD_PROMPT, fork_turns: "none" }));
      } else if (rootRequests === 2) {
        const result = info.outputs[calls.spawn];
        if (denySpawn) {
          check(typeof result === "string" && result.includes("sage-native-denial-fixture"), "native_denial_reason_missing");
          denied = true;
          respond(res, message(MARKER));
          return;
        }
        check(typeof result?.task_name === "string" && result.task_name === "/root/probe_child", "native_spawn_result_missing_expected_task");
        taskName = result.task_name;
        print({ type: "native_tool_result", tool: "spawn_agent", task_name: taskName });
        await childReady;
        if (fixtureFailure) { reject(res); return; }
        respond(res, call(calls.running, "list_agents", { path_prefix: taskName }));
      } else if (rootRequests === 3) {
        const agent = childEntry(info.outputs[calls.running]);
        check(agent.agent_status === "running" && childResponse && !childResponseSent, "native_child_not_running_while_response_held");
        nativeRunning = true;
        print({ type: "native_tool_result", tool: "list_agents", phase: "held", agent_name: taskName, agent_status: "running" });
        respond(res, call(calls.wait, "wait_agent", {}));
        respond(childResponse, roleEdit
          ? {type:"custom_tool_call",...childPatchTool,call_id:calls.edit,input:"*** Begin Patch\n*** Add File: role-edit-proof.txt\n+fixed role edit proof\n*** End Patch"}
          : childMessage
          ? {type:"function_call",name:"list_mcp_resources",call_id:calls.messageControl,arguments:"{}"}
          : childSandbox
          ? {type:"function_call", ...childCommandTool, call_id:calls.sandbox, arguments:JSON.stringify({cmd:"printf sage-child-sandbox-control", shell:"/bin/sh", workdir:workspace, sandbox_permissions:"require_escalated", justification:"Fixed simulated sandbox refusal probe."})}
          : recoveryProbe
          ? {type:"function_call", name:"list_mcp_resources", call_id:calls.compact1, arguments:"{}"}
          : message(CHILD_MARKER));
        childResponseSent = true;
      } else if (rootRequests === 4) {
        const result = info.outputs[calls.wait];
        check(result?.timed_out === false && result.message === "Wait completed.", "native_wait_did_not_observe_mailbox_activity");
        nativeWait = true;
        print({ type: "native_tool_result", tool: "wait_agent", timed_out: false, message: result.message });
        respond(res, call(calls.completed, "list_agents", { path_prefix: taskName }));
      } else if (rootRequests === 5) {
        const agent = childEntry(info.outputs[calls.completed]);
        if (childMessage && agent.agent_status === "running") {
          messageWaitCycles++; rootRequests = 3;
          calls.wait = `probe_message_wait_${messageWaitCycles}`;
          calls.completed = `probe_message_list_${messageWaitCycles}`;
          knownCalls.add(calls.wait); knownCalls.add(calls.completed);
          respond(res,call(calls.wait,"wait_agent",{})); return;
        }
        check(agent.agent_status?.completed === CHILD_MARKER, "native_child_completion_marker_mismatch");
        nativeCompleted = true;
        print({ type: "native_tool_result", tool: "list_agents", phase: "completed", agent_name: taskName, agent_status: { completed: CHILD_MARKER } });
        if (followup) {
          const state = integrated.readJournal();
          check(state.bindings.length === 1 && state.completions.length === 1, "followup_predecessor_not_completed");
          integrated.prepareFollowupRun();
          const brief = Object.fromEntries(["GOAL", "SCOPE", "CONTEXT", "DECISIONS", "ACCEPTANCE", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"].map(key => [key, "Complete the fixed native follow-up fixture task."]));
          respond(res, {type:"function_call", ...info.prepareTools[0], call_id:calls.followPrepare,
            arguments:JSON.stringify({task:"T1",run:"R2",name:"continued_child",role:"lead",previous:state.bindings[0].assignment,brief})});
        } else if (reportProbe) {
          check(info.reportTools.length === 1, "report_tool_missing");
          beforeReport = JSON.stringify(integrated.readJournal());
          respond(res, {type: "function_call", ...info.reportTools[0], call_id: calls.report,
            arguments: JSON.stringify({name: "probe_child"})});
        } else respond(res, message(MARKER));
      } else if (followup && rootRequests === 6) {
        followupPrepared = info.outputs[calls.followPrepare];
        check(followupPrepared?.decision === "prepared" && followupPrepared.target === childThread
          && typeof followupPrepared.message === "string" && !Object.hasOwn(followupPrepared,"fork_turns"), "followup_preparation_invalid");
        respond(res, call(calls.follow,"followup_task",{target:followupPrepared.target,message:followupPrepared.message}));
      } else if (followup && rootRequests === 7) {
        check(info.outputs[calls.follow] === "", "followup_not_accepted");
        const state = integrated.readJournal();
        check(state.reservations.length === 2 && state.reservations[1].continuation === state.bindings[0].assignment,
          "followup_reservation_missing");
        await followupReady;
        if (fixtureFailure) { reject(res); return; }
        respond(res, call(calls.followWait,"wait_agent",{}));
        respond(followupResponse,message(CHILD_MARKER));
      } else if (followup && rootRequests === 8) {
        check(info.outputs[calls.followWait]?.timed_out === false, "followup_wait_failed");
        respond(res,call(calls.followDone,"list_agents",{path_prefix:taskName}));
      } else if (followup && rootRequests === 9) {
        check(childEntry(info.outputs[calls.followDone]).agent_status?.completed === CHILD_MARKER, "followup_completion_missing");
        const state=integrated.readJournal();
        check(state.reservations.length===2 && state.bindings.length===2 && state.completions.length===2
          && state.bindings.every(row=>row.child===childThread) && state.bindings[0].turn!==state.bindings[1].turn, "followup_identity_changed");
        followupVerified=true;
        print({type:"followup_evidence",sameChild:true,exactSavedMessage:true,reservations:2,completedTurns:2,simulatedModel:true,automaticSage:false});
        respond(res,message(MARKER));
      } else if (reportProbe && rootRequests === 6) {
        const report = info.outputs[calls.report], state = integrated.readJournal();
        check(report?.decision === "report-ready" && report.assignment === state.bindings[0].assignment
          && report.child === childThread && report.turn === state.bindings[0].turn && report.task === "T1" && report.run === "R1"
          && report.reportHash === createHash("sha256").update(CHILD_MARKER).digest("hex")
          && report.report.STATUS === "done" && report.report.RESULT === "sage-native-child-ok", "report_identity_or_text_changed");
        check(JSON.stringify(state) === beforeReport, "report_read_changed_admission");
        reportVerified = true;
        print({type: "report_read_evidence", exactAssignment: true, exactTextHash: true, unchangedAdmission: true,
          reportsAccepted: 0, simulatedModel: true, realModelConsumptionVerified: false});
        if (receiptProbe) {
          expectedReport = report;
          check(info.recordTools.length === 1, "record_tool_missing");
          respond(res, {type: "function_call", ...info.recordTools[0], call_id: calls.record,
            arguments: JSON.stringify({name: "probe_child", reportHash: report.reportHash})});
        } else respond(res, message(MARKER));
      } else if (receiptProbe && rootRequests === 7) {
        const receipt = info.outputs[calls.record], state = integrated.readJournal();
        check(JSON.stringify(receipt) === JSON.stringify({...expectedReport, decision: "report-recorded"}), "recorded_report_changed");
        check(state.reports?.length === 1 && state.reports[0].text === CHILD_MARKER, "receipt_not_saved");
        const {reports, ...unchanged} = state;
        check(JSON.stringify(unchanged) === beforeReport, "receipt_changed_other_admission_state");
        recordedState = JSON.stringify(state);
        integrated.removeChildTranscript(childThread);
        check(info.reportTools.length === 1, "reread_tool_missing");
        respond(res, {type: "function_call", ...info.reportTools[0], call_id: calls.reread,
          arguments: JSON.stringify({name: "probe_child"})});
      } else if (receiptProbe && rootRequests === 8) {
        check(JSON.stringify(info.outputs[calls.reread]) === JSON.stringify(expectedReport), "lost_transcript_recovery_changed_report");
        check(JSON.stringify(integrated.readJournal()) === recordedState, "reread_changed_receipt");
        check(info.recordTools.length === 1, "retry_tool_missing");
        respond(res, {type: "function_call", ...info.recordTools[0], call_id: calls.retry,
          arguments: JSON.stringify({name: "probe_child", reportHash: expectedReport.reportHash})});
      } else if (receiptProbe && rootRequests === 9) {
        check(JSON.stringify(info.outputs[calls.retry]) === JSON.stringify({...expectedReport, decision: "already-recorded"}), "receipt_retry_changed_report");
        check(JSON.stringify(integrated.readJournal()) === recordedState, "receipt_retry_changed_admission");
        receiptVerified = true;
        print({type: "report_receipt_evidence", receipts: 1, exactReport: true, transcriptRemoved: true,
          recoveryVerified: true, retryUnchanged: true, verdictsAccepted: 0, simulatedModel: true});
        if (finishRun) {
          check(info.finishTools.length === 1, "finish_tool_missing");
          beforeFinishLogbook = integrated.readLogbook();
          respond(res, {type: "function_call", ...info.finishTools[0], call_id: calls.finish,
            arguments: JSON.stringify({assignment: expectedReport.assignment, reportHash: expectedReport.reportHash})});
        } else respond(res, message(MARKER));
      } else if (finishRun && rootRequests === 10) {
        firstFinish = info.outputs[calls.finish];
        check(firstFinish?.decision === "run-finished" && firstFinish.task === "T1" && firstFinish.run === "R1"
          && firstFinish.status === "done", "run_finish_missing");
        const after = integrated.readLogbook(), prior = beforeFinishLogbook;
        check(JSON.stringify(after.runs[0]) === JSON.stringify({...prior.runs[0], status: "done", report: firstFinish.report, ended: firstFinish.ended})
          && after.runs.length === 1 && integrated.readRunReport(firstFinish.report) === CHILD_MARKER, "run_evidence_changed");
        for (const key of ["tasks", "ledger", "findings", "gates", "decisions"])
          check(JSON.stringify(after[key]) === JSON.stringify(prior[key]), "finish_changed_" + key);
        finishedLogbook = JSON.stringify(after);
        check(JSON.stringify(integrated.readJournal()) === recordedState, "finish_changed_admission");
        check(info.finishTools.length === 1, "finish_retry_tool_missing");
        respond(res, {type: "function_call", ...info.finishTools[0], call_id: calls.finishRetry,
          arguments: JSON.stringify({assignment: expectedReport.assignment, reportHash: expectedReport.reportHash})});
      } else if (finishRun && rootRequests === 11) {
        check(JSON.stringify(info.outputs[calls.finishRetry]) === JSON.stringify({...firstFinish, decision: "already-finished"}), "finish_retry_changed_result");
        check(integrated.readRunReport(firstFinish.report) === CHILD_MARKER
          && JSON.stringify(integrated.readJournal()) === recordedState
          && JSON.stringify(integrated.readLogbook()) === finishedLogbook, "finish_retry_changed_evidence");
        finishVerified = true;
        print({type:"run_finish_evidence", exactReportBytes:true, finishedRuns:1, retryUnchanged:true,
          tasksAndVerdictsUnchanged:true, admissionAndModeUnchanged:true, simulatedModel:true, automaticSage:false});
        respond(res, message(MARKER));
      } else {
        throw new Error("unexpected_extra_root_request");
      }
    } catch (error) {
      rejectedRequests++;
      failFixture(error instanceof Error ? diagnostic(error.message) : "unknown_fixture_failure");
    }
  });

  const listening = await new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(0, "127.0.0.1", () => resolve(true));
  });
  if (!listening) {
    print({ type: "result", verified: false, reason: "loopback_listener_failed" });
    process.exitCode = 1;
  } else {
    const args = ["exec", "--strict-config", "--skip-git-repo-check", "-C", workspace, "-s", roleEdit ? "workspace-write" : "read-only", "--json"];
    const config = {
      ...(recoveryProbe ? {model_auto_compact_token_limit:100000, compact_prompt:"SAGE_CHILD_COMPACT_REQUEST"} : {}),
      model_provider: "sage_native_lifecycle",
      model: "sage-native-parent",
      model_catalog_json: catalogPath,
      cli_auth_credentials_store: "ephemeral",
      "features.hooks": true,
      "features.plugins": false,
      "features.remote_plugin": false,
      "features.apps": false,
      "features.shell_snapshot": false,
      "features.shell_tool": childSandbox,
      "features.enable_request_compression": false,
      "features.multi_agent": true,
      "features.multi_agent_v2": true,
      "agents.enabled": true,
      "agents.max_concurrent_threads_per_session": 5,
      allow_login_shell: false,
    };
    for (const [key, value] of Object.entries(config)) args.push("-c", `${key}=${JSON.stringify(value)}`);
    args.push("-c", `model_providers.sage_native_lifecycle={name="Sage native lifecycle",base_url="http://127.0.0.1:${server.address().port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`);
    args.push("-");

    const child = launch(args);
    let buffer = "";
    let malformedEvents = 0;
    let exactMessages = 0;
    let otherMessages = 0;
    let completedTurns = 0;
    let failedTurns = 0;
    let unexpectedItems = 0;
    let stderrBytes = 0;
    let stderrText = "";
    const eventTypes = new Set(["thread.started", "turn.started", "item.started", "item.updated", "item.completed", "turn.completed", "turn.failed", "error"]);
    const acceptLine = (line) => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { malformedEvents++; return; }
      const itemType = event.type === "item.completed" ? event.item?.type : undefined;
      const itemDiagnostic = itemType && !["agent_message", "reasoning"].includes(itemType)
        ? diagnostic(JSON.stringify({ type: itemType, level: event.item.level, message: event.item.message, text: event.item.text }))
        : undefined;
      print({ type: "event", event: eventTypes.has(event.type) ? event.type : "unknown", itemType, itemDiagnostic });
      if (event.type === "turn.completed") completedTurns++;
      if (event.type === "turn.failed" || event.type === "error") {
        failedTurns++;
        failFixture("native_root_error");
      }
      if (event.type === "item.completed" && event.item?.type === "error") failFixture("native_error_item");
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        if (event.item.text === MARKER) exactMessages++;
        else otherMessages++;
      } else if (event.type === "item.completed" && event.item?.type === "collab_tool_call"
        && ["spawn_agent", "wait"].includes(event.item.tool) && event.item.status === "completed") {
        // The native tool result in the next request supplies the stricter state assertion.
      } else if (completion && event.type === "item.completed" && event.item?.type === "mcp_tool_call"
        && event.item.server === "sage_preparation" && ["sage_prepare_task", ...(reportProbe ? ["sage_read_report"] : []), ...(receiptProbe ? ["sage_record_report"] : []), ...(finishRun ? ["sage_finish_run"] : [])].includes(event.item.tool) && event.item.status === "completed") {
        // The prepared message and final journal verify this tool's result.
      } else if (event.type === "item.completed" && event.item?.type !== "reasoning") {
        unexpectedItems++;
      }
    };
    child.stdout.on("data", (data) => {
      buffer += data.toString();
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        acceptLine(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
      if (buffer.length > 1024 * 1024) { malformedEvents++; buffer = ""; }
    });
    child.stderr.on("data", (data) => { stderrBytes += data.length; stderrText = (stderrText + data).slice(0, 4096); });
    child.stdin.on("error", () => {});
    child.stdin.end(completion ? "sage mode\n" : `Run the fixed one-child native lifecycle probe. Finish with exactly ${MARKER}. Do not use shell tools.\n`);
    print({ type: "event", event: "baseline_started" });
    const result = await waitNative(child, { deadlineMs, onTimeout: () => failFixture("native_root_deadline") });
    acceptLine(buffer);
    if (pending.size) failFixture("native_root_exited_with_held_response");
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    const routeVerified = denySpawn
      ? rootRequests === 2 && childRequests === 0 && denied
      : rootRequests === (followup ? 9 : finishRun ? 11 : receiptProbe ? 9 : reportProbe ? 6 : 5) && (!followup || followupVerified) && (!leadOwnership || ownershipStage === 3) && (!reportProbe || reportVerified) && (!receiptProbe || receiptVerified) && (!finishRun || finishVerified) && (!roleEdit || roleEditVerified) && (!childMessage || (messageVerified && chiefMessageDelivered)) && (!childSandbox || sandboxVerified) && childRequests === (followup ? 3 : roleEdit ? 3 : childMessage ? 5 : childSandbox ? 3 : recoveryProbe ? (repeatRecovery ? 9 : 5) : completion ? 2 : 1)
        && (!recoveryProbe || recoveredRounds === (repeatRecovery ? 2 : 1)) && (!completion || (prepared && blockedStopVerified)) && rootThread !== childThread
        && childTaskSeen && childResponseSent && nativeRunning && nativeWait && nativeCompleted;
    const verified = result.code === 0 && !fixtureFailure && routeVerified
      && exactMessages === 1 && otherMessages === 0 && completedTurns === 1 && failedTurns === 0
      && unexpectedItems === 0 && malformedEvents === 0 && rejectedRequests === 0;
    if (childMessage) print({type:"message_evidence",messageVerified,chiefMessageDelivered,messageWaitCycles,simulatedModel:true});
    print({ type: "result", ...result, responseRequests, rootRequests: rootRequests + 2 * messageWaitCycles + (leadOwnership ? 3 : 0), childRequests, childTaskSeen, childResponseSent,
      nativeRunning, nativeWait, nativeCompleted, exactMessages, otherMessages, completedTurns, failedTurns,
      unexpectedItems, malformedEvents, rejectedRequests, stderrBytes, fixtureFailure, verified,
      ...(!verified ? { diagnostic: diagnostic(stderrText) } : {}) });
    if (!verified) process.exitCode = 1;
    const rows=readdirSync(join(root,"events")).map(name=>JSON.parse(readFileSync(join(root,"events",name),"utf8")));
    const start=rows.filter(row=>row.hook_event_name==="SubagentStart");
    const stop=rows.filter(row=>row.hook_event_name==="SubagentStop");
    const before=rows.filter(row=>row.hook_event_name==="PreToolUse"&&row.tool_name==="collaborationspawn_agent");
    const after=rows.filter(row=>row.hook_event_name==="PostToolUse"&&row.tool_name==="collaborationspawn_agent");
    assert.equal(before.length,failedSpawn || leadOwnership ? 2 : 1);
    assert.equal(start.length,denySpawn ? 0 : 1);
    assert.equal(stop.length,denySpawn ? 0 : followup ? 3 : recoveryProbe ? (repeatRecovery ? 3 : 2) : completion ? 2 : 1);
    assert.equal(after.length,denySpawn ? 0 : 1);
    if (!denySpawn) {
    assert.equal(start[0].captureError,undefined);
    assert.equal(start[0].agent_id,stop[0].agent_id);
    assert.equal(start[0].metadata.id,start[0].agent_id);
    assert.equal(start[0].metadata.session_id,before[0].session_id);
    const matched = before.filter(row => row.tool_use_id === after[0].tool_use_id);
    assert.equal(matched.length, 1);
    assert.equal(matched[0].tool_use_id, calls.spawn);
    assert.equal(after[0].resultTaskName,start[0].metadata.agent_path);
    }
    if (completion) {
      const state = integrated.readJournal(), stops = integrated.readStops();
      assert.equal(state.preparations.length, failedSpawn || leadOwnership || followup ? 2 : 1); assert.equal(state.reservations.length, failedSpawn || followup ? 2 : 1);
      assert.equal(state.bindings.length, followup ? 2 : 1); assert.equal(state.completions.length, followup ? 2 : 1);
      assert.deepEqual(state.completions[0], state.bindings[0]);
      assert.equal(state.bindings[0].child, childThread);
      assert.equal(state.reports?.length ?? 0, receiptProbe ? 1 : 0);
      assert.equal(stops.length, followup ? 3 : recoveryProbe ? recoveredRounds + 1 : 2);
      assert(stops.every((row, i) => row.decision === (recoveryProbe && i < recoveredRounds ? "recovery-required" : "stop-observed") && row.completions === (followup && i === 2 ? 1 : 0)));
      print({type: "completion_evidence", reservations: state.reservations.length, bindings: state.bindings.length, completions: state.completions.length,
        blockedStopRetainedCapacity: blockedStopVerified, stopCallbacksPrecedeTerminal: true,
        parentReconciledCompletion: true, reportsAccepted: 0, fullPolicyVerified: false,
        simulatedModel: true, automaticSage: false, realModelConsumptionVerified: false});
    }
    if (failedSpawn) {
      const state = integrated.readJournal();
      assert.equal(failureStage, 4); assert.equal(state.config.total, 1);
      assert.equal(state.failures.length, 1);
      assert.equal(state.failures[0].assignment, state.reservations[0].assignment.id);
      assert.equal(state.completions[0].assignment, state.reservations[1].assignment.id);
      print({type: "failed_spawn_evidence", capacity: 1, reservations: 2, failedDispatches: 1,
        bindings: 1, completedChildren: 1, retryUsedReleasedSlot: true, simulatedModel: true,
        otherFailureKindsVerified: false});
    }
    print({type:"hook_evidence",spawnRequest:before.length,spawnResult:after.length,childStart:start.length,childStop:stop.length,exactIdentityJoin:!denySpawn,noChildStarted:denySpawn,simulatedModel:true,automaticSage:false,realModelConsumptionVerified:false});
  }
}

} finally {
  rmSync(root, { recursive: true, force: true });
  assert.equal(existsSync(root), false);
  process.stdout.write(JSON.stringify({ type: "cleanup", temporaryRootRemoved: true }) + "\n");
}
