// Isolated native V2 transport check with simulated model responses; not a live Sage pilot.
// A wide deadlock guard closes transport first, then stops an unresponsive owned child.
import http from "node:http";
import { NESTED_CALLS, createNestedReportFlow } from "./fixtures/codex-native/nested-report.mjs";
import {createHash} from "node:crypto";
import assert from "node:assert/strict";
import {existsSync,readdirSync,readFileSync,lstatSync} from "node:fs";
import {waitNative} from "./fixtures/codex-native/wait-native.mjs";
import {readNativeInterruption,readAssignmentTurn,readNativeFollowup,readNativeRecovery} from "../packages/sage-codex/runtime/identity.mjs";
import {readObservations} from "../packages/sage-codex/runtime/events.mjs";
import {readRecoveryOutput} from "../packages/sage-codex/runtime/recovery-output.mjs";
import {setupCapture} from "./fixtures/codex-native/setup-capture.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

assert(process.argv.slice(2).every(arg => ["--sage-completion", "--sage-followup-recovery", "--sage-child-repeat-recovery", "--sage-child-recovery", "--sage-child-compaction", "--sage-child-sandbox", "--sage-child-message", "--sage-interruption", "--sage-followup-missed-callbacks", "--sage-followup-failed-child", "--sage-followup-no-tool", "--sage-missed-stop", "--sage-followup", "--sage-unprepared-followup", "--sage-retargeted-run", "--sage-ended-run", "--sage-readonly-patch", "--sage-task-lifecycle", "--sage-create-run", "--sage-create-task", "--sage-off", "--deny-spawn", "--follow-up", "--nested", "--sage", "--sage-hook-outage", "--sage-report", "--sage-nested-report", "--sage-no-tool", "--sage-stop-block", "--sage-report-correction", "--sage-report-escape", "--sage-failed-spawn"].includes(arg)), "unknown_probe_argument");
const deadlineMs = process.env.NODE_TEST_CONTEXT && /^\d+$/.test(process.env.SAGE_PROBE_TEST_DEADLINE_MS ?? "")
  ? Number(process.env.SAGE_PROBE_TEST_DEADLINE_MS) : 120_000;
const followupRecovery = process.argv.includes("--sage-followup-recovery");
let followupRecoveryPhase = 0, followupRecoveryVerified = false, followupAdmissionSnapshot;
const repeatChildRecovery = process.argv.includes("--sage-child-repeat-recovery");
const childRecovery = repeatChildRecovery || process.argv.includes("--sage-child-recovery");
const childCompaction = childRecovery || process.argv.includes("--sage-child-compaction");
let childRecoveryPending = false, childRecoveryGatePhase = 0, restoreRecoveryTarget, recoveryTargetVerified = false;
assert(!childCompaction || process.argv.slice(2).length === 1, "child_compaction_is_a_separate_route");
let childCompactionObserved = false, childCompactionReady = false, childCompactionRequests = 0;
const childSandbox = process.argv.includes("--sage-child-sandbox");
assert(!childSandbox || process.argv.slice(2).length === 1, "child_sandbox_is_a_separate_route");
let childSandboxVerified = false;
const childMessage = process.argv.includes("--sage-child-message");
assert(!childMessage || process.argv.slice(2).length === 1, "child_message_is_a_separate_route");
let chiefReceivedMessage = false, childMessageVerified = false, childMessagePhase = "wait", childMessageWaitCall, childMessageListCall;
const interruption = process.argv.includes("--sage-interruption");
assert(!interruption || process.argv.slice(2).length === 1, "interruption_is_a_separate_route");
let interruptionVerified = false;
const unobservedFollowup = process.argv.includes("--sage-followup-missed-callbacks");
const missedStop = unobservedFollowup || process.argv.includes("--sage-missed-stop");
const followupNoTool = unobservedFollowup || process.argv.includes("--sage-followup-no-tool");
const resumedFailure = process.argv.includes("--sage-followup-failed-child");
const sageFollowup = followupRecovery || resumedFailure || followupNoTool || missedStop || process.argv.includes("--sage-followup");
assert(!sageFollowup || process.argv.slice(2).length === 1, "sage_followup_is_a_separate_route");
let sageFollowupVerified = false;
let resumedFailureStep = 0, resumedFailureVerified = false;
const unpreparedFollowup = process.argv.includes("--sage-unprepared-followup");
assert(!unpreparedFollowup || process.argv.slice(2).length === 1, "unprepared_followup_is_a_separate_route");
let unpreparedFollowupVerified = false;
const retargetedRun = process.argv.includes("--sage-retargeted-run");
assert(!retargetedRun || process.argv.slice(2).length === 1, "retargeted_run_is_a_separate_route");
const endedRun = process.argv.includes("--sage-ended-run");
assert(!endedRun || process.argv.slice(2).length === 1, "ended_run_is_a_separate_route");
const readonlyPatch = process.argv.includes("--sage-readonly-patch");
assert(!readonlyPatch || process.argv.slice(2).length === 1, "readonly_patch_is_a_separate_route");
const taskLifecycle = process.argv.includes("--sage-task-lifecycle");
const createRun = taskLifecycle || process.argv.includes("--sage-create-run");
const createTask = createRun || process.argv.includes("--sage-create-task");
assert(!createTask || process.argv.slice(2).length === 1, "task_creation_is_a_separate_route");
const sageOff = process.argv.includes("--sage-off");
assert(!sageOff || process.argv.slice(2).length === 1, "sage_off_is_a_separate_route");
const denySpawn = process.argv.includes("--deny-spawn");
const failedSpawn = process.argv.includes("--sage-failed-spawn");
const followUp = process.argv.includes("--follow-up");
const blockStop = process.argv.includes("--sage-stop-block") || process.argv.includes("--sage-completion");
const correctReport = process.argv.includes("--sage-report-correction");
const escapeReport = process.argv.includes("--sage-report-escape");
assert([correctReport, escapeReport, blockStop].filter(Boolean).length <= 1, "incompatible_stop_routes");
const noTool = process.argv.includes("--sage-no-tool") || blockStop || correctReport || escapeReport;
const nestedReport = process.argv.includes("--sage-nested-report");
const nested = process.argv.includes("--nested") || nestedReport;
const outage = process.argv.includes("--sage-hook-outage");
const reportProbe = process.argv.includes("--sage-report") || (noTool && !escapeReport);
const sage = childCompaction || childSandbox || childMessage || interruption || sageFollowup || unpreparedFollowup || retargetedRun || endedRun || readonlyPatch || createTask || process.argv.includes("--sage") || outage || reportProbe || nestedReport || noTool || failedSpawn;
assert([failedSpawn, outage, process.argv.includes("--sage-report"), nestedReport, noTool].filter(Boolean).length <= 1, "incompatible_probe_routes");
assert([denySpawn, followUp, process.argv.includes("--nested"), sage].filter(Boolean).length <= 1, "incompatible_probe_routes");
let denied = false;
const MARKER = "sage-native-parent-ok";
let GRAND_MARKER = "sage-native-grandchild-ok";
let GRAND_PROMPT = `Return exactly ${GRAND_MARKER}. Do not call any tool.`;
let CHILD_MARKER = reportProbe ? ["STATUS done", "RESULT CLEAN", "EVIDENCE fixed native fixture completed", "FINDINGS none", "QUESTIONS none", "NOT VERIFIED real model", "BRANCH codex/t1-review"].join("\n") : "sage-native-child-ok";
if (sage && !reportProbe && !nestedReport && !outage && !escapeReport) CHILD_MARKER = ["STATUS done", "RESULT sage-native-child-ok", "EVIDENCE fixed simulated response", "FINDINGS none", "QUESTIONS none", "NOT VERIFIED real model", "BRANCH none"].join("\n");
let CHILD_PROMPT = `Return exactly ${CHILD_MARKER}. Do not call any tool.`;
const FOLLOWUP_MARKER = sageFollowup ? CHILD_MARKER.replace("sage-native-child-ok", "sage-native-followup-ok") : "sage-native-followup-ok";
let FOLLOWUP_PROMPT = `Return exactly ${FOLLOWUP_MARKER}. Do not call any tool.`;
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
  supported_reasoning_levels: [], shell_type: childSandbox ? "unified_exec" : "disabled", ...(readonlyPatch ? { apply_patch_tool_type: "freeform" } : {}), visibility: "list",
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
  const integrated = await setupCapture({root,codexHome,workspace,env,binary,denySpawn,sage:sage||sageOff,disconnectOnSpawn:outage,review:reportProbe || nestedReport || resumedFailure,nestedReview:nestedReport || resumedFailure,blockStop,captureFailure:failedSpawn,emptyLogbook:createRun,taskLifecycle,omitStop:missedStop,captureCompaction:childCompaction || followupRecovery,restoreCompaction:childCompaction || followupRecovery,deadlineMs});
  const initialLogbook = sage || sageOff ? integrated.readLogbook() : null;
  if (createRun) { assert.equal(initialLogbook.tasks.length, 0); assert.equal(initialLogbook.runs.length, 0); }
  if (reportProbe) CHILD_MARKER = ["STATUS done", "RESULT CLEAN",
    `EVIDENCE ${JSON.stringify({ commit: integrated.reviewTarget.sha, round: 0, cycle: 1, summary: "Fixed native fixture completed; simulated review only." })}`,
    "FINDINGS []", "QUESTIONS none", "NOT VERIFIED real model or real review", "BRANCH codex/t1-review"].join("\n");
  if (nestedReport) GRAND_MARKER = ["STATUS done", "RESULT CLEAN",
    `EVIDENCE ${JSON.stringify({ commit: integrated.reviewTarget.sha, round: 0, cycle: 1, summary: "Fixed nested review; simulated evidence only." })}`,
    "FINDINGS []", "QUESTIONS none", "NOT VERIFIED real model or real review", "BRANCH codex/t1-review"].join("\n");
  const chiefText = (sage || sageOff) ? readFileSync(join(root, "plugin/runtime/chief-instructions.md"), "utf8").split("\n---\n\n")[1].slice(0, -1) : null;
  const chiefParts = chiefText ? (await import(`file://${join(root, "plugin/runtime/chief-output.mjs")}`)).chiefInstructionParts() : [];
  let chiefContextVerified = false;
  const textValues = value => typeof value === "string" ? [value] : Array.isArray(value)
    ? value.flatMap(textValues) : value && typeof value === "object" ? Object.values(value).flatMap(textValues) : [];
  let finishedRun, acceptedReview, prematureCompletions;
  let responseRequests = 0;
  let rejectedRequests = 0;
  let rootRequests = 0;
  let childRequests = 0;
  let grandchildRequests = 0, grandchildThread;
  let rootThread;
  let childThread;
  let taskName;
  let childResponse;
  let followupResponse, releaseFollowupReady, followupRun, followupPrepared, followupReport;
  const followupReady = new Promise(resolve => { releaseFollowupReady = resolve; });
  let childResponseSent = false;
  let nativeRunning = false;
  let nativeCompleted = false;
  let nativeWait = false;
  let childTaskSeen = false;
  let fixtureFailure;
  let releaseChildReady;
  const childReady = new Promise((resolve) => { releaseChildReady = resolve; });
  let releaseBoundChild;
  const boundChild = new Promise(resolve => { releaseBoundChild = resolve; });
  const pending = new Set();
  let taskStarted = false, taskTransitionsVerified = false, initialTask, briefedTask, buildingTask, reviewingTask, verifyingTask;
  const taskChange = (index, version, changes) => ({ request: `c1111111-2222-4333-8444-55555555555${index}`, task: "T1", version, changes });
  let createdTask, createdTaskVerified = false, createdRun, createdRunVerified = false, finishedCreatedRun = false;
  const runRequest = { request: "b1111111-2222-4333-8444-555555555555", task: "T1", role: "lead", branch: "", candidate: "" };
  const taskRequest = { request: "a1111111-2222-4333-8444-555555555555", title: "Native task creation", size: "small", risk: ["input"], add: ["ux-review"], why: "Check the fixed experience" };
  let prepared = false, reportReceipt, failedDispatchRecovered = false, childPatchTool, readonlyPatchVerified = false, endedRunVerified = false, retargetedRunVerified = false;
  const calls = { childRecompact: "probe_child_recompact", childRecoverySecond: "probe_child_recovery_second", childUnrecoveredSecond: "probe_child_unrecovered_second", childUnrecovered: "probe_child_unrecovered", childRecovery: "probe_child_recovery", childSandbox: "probe_child_sandbox", childPeerMessage: "probe_child_peer_message", childChiefMessage: "probe_child_chief_message", resumedPrepare: "resumed_prepare", resumedSpawn: "resumed_spawn", resumedList: "resumed_list", followupCreate: "probe_followup_create", followupPrepare: "probe_followup_prepare", followupControl: "probe_followup_control", followupReport: "probe_followup_report", followupRecord: "probe_followup_record", followupOld: "probe_followup_old", readTask: "probe_read_task", brief: "probe_brief", briefRetry: "probe_brief_retry", build: "probe_build", review: "probe_review", verify: "probe_verify", verifyWithoutReviews: "probe_verify_without_reviews", createRun: "probe_create_run", createRunRetry: "probe_create_run_retry", createdRunAfterFinish: "probe_created_run_after_finish", create: "probe_create", createRetry: "probe_create_retry", failureList: "probe_failure_list", prepareRetry: "probe_prepare_retry", spawnRetry: "probe_spawn_retry", inspect: "probe_inspect", accept: "probe_accept", acceptRetry: "probe_accept_retry", finish: "probe_finish", finishRetry: "probe_finish_retry", record: "probe_record", recordRetry: "probe_record_retry", reread: "probe_reread", report: "probe_report", prepare: "probe_prepare", childControl: "probe_child_control", childSpawn: "probe_child_spawn", childWait: "probe_child_wait", childList: "probe_child_list", spawn: "probe_spawn", running: "probe_running", wait: "probe_wait", completed: "probe_completed", followup: "probe_followup", followupWait: "probe_followup_wait", followupDone: "probe_followup_done" };
  const knownCalls = new Set([...Object.values(calls), ...Object.values(NESTED_CALLS)]);
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
    releaseFollowupReady();
    releaseBoundChild();
    for (const response of pending) reject(response);
  };
  const inspectRequest = (request) => {
    const outputs = {};
    const input = Array.isArray(request.input) ? request.input : [];
    for (const item of input) {
      if ((item.type !== "function_call_output" && !(readonlyPatch && item.type === "custom_tool_call_output" && item.call_id === calls.childControl)) || !knownCalls.has(item.call_id)) continue;
      check(!(item.call_id in outputs), "duplicate_native_tool_result");
      const output = typeof item.output === "string" ? item.output
        : Array.isArray(item.output) && item.output.length >= 1 && item.output.length <= ([calls.childRecovery, calls.childRecoverySecond, calls.resumedPrepare, calls.followupCreate, calls.followupPrepare, calls.followupReport, calls.followupRecord, calls.followupOld, calls.readTask, calls.brief, calls.briefRetry, calls.build, calls.review, calls.verify, calls.verifyWithoutReviews, calls.createRun, calls.createRunRetry, calls.createdRunAfterFinish, calls.create, calls.createRetry, calls.prepare, calls.prepareRetry, calls.report, calls.record, calls.recordRetry, calls.reread, calls.finish, calls.finishRetry, calls.accept, calls.acceptRetry, calls.inspect, ...Object.values(NESTED_CALLS)].includes(item.call_id) ? 2 : 1)
          && item.output.every(part => part.type === "input_text") ? item.output.at(-1).text : null;
      check(typeof output === "string", "unsupported_native_tool_result_encoding");
      try { outputs[item.call_id] = JSON.parse(output); } catch {
        if (resumedFailure && item.call_id === calls.resumedSpawn) outputs[item.call_id] = output;
        else if ((denySpawn || outage || failedSpawn) && [calls.spawn, calls.spawnRetry].includes(item.call_id)) outputs[item.call_id] = output;
        else if ([calls.childUnrecovered, calls.childUnrecoveredSecond, calls.childRecompact, calls.childSandbox, calls.childPeerMessage, calls.childChiefMessage, calls.verifyWithoutReviews, calls.followup, calls.followupControl, calls.childControl, NESTED_CALLS.control].includes(item.call_id)) outputs[item.call_id] = output;
        else throw new Error("native_tool_result_is_not_json");
      }
    }
    const agentTools = [];
    for (const tool of request.tools ?? []) {
      if (tool.type === "namespace" && tool.name === "collaboration") {
        for (const member of tool.tools ?? []) if (member.type === "function") agentTools.push(member.name);
      }
    }
    const tasks=input.filter(item=>item.type==="agent_message");
    const task=tasks[0];
    const childPromptSeen=tasks.length===1 && task.author==="/root" && task.recipient==="/root/probe_child"
      && Array.isArray(task.content) && task.content.length===2
      && task.content[0].type==="input_text"
      && task.content[0].text==="Message Type: NEW_TASK\nTask name: /root/probe_child\nSender: /root\nPayload:\n"
      && task.content[1].type==="encrypted_content" && task.content[1].encrypted_content===CHILD_PROMPT;
    const followupTask = tasks.at(-1);
    const followupPromptSeen = followupTask?.author === "/root" && followupTask?.recipient === "/root/probe_child"
      && followupTask.content?.some(part => part.type === "encrypted_content" && part.encrypted_content === FOLLOWUP_PROMPT);
    const grandchildPromptSeen = task?.author === "/root/probe_child" && task?.recipient === "/root/probe_child/probe_grandchild"
      && task.content?.some(part => part.type === "encrypted_content" && part.encrypted_content === GRAND_PROMPT);
    const mcpTools = name => (request.tools ?? []).flatMap(tool => tool.type === "namespace"
      ? (tool.tools ?? []).filter(member => member.name === name).map(member => ({ namespace: tool.name, name: member.name }))
      : tool.type === "function" && tool.name === `mcp__sage_preparation__${name}` ? [{ name: tool.name }] : []);
    const patchTools = (request.tools ?? []).flatMap(tool => tool.type === "namespace"
      ? (tool.tools ?? []).filter(member => member.name === "apply_patch").map(member => ({ namespace: tool.name, ...member }))
      : tool.name === "apply_patch" ? [tool] : []);
    const commandTools = (request.tools ?? []).flatMap(tool => tool.type === "namespace"
      ? (tool.tools ?? []).filter(member => member.name === "exec_command").map(member => ({ namespace: tool.name, name: member.name }))
      : tool.name === "exec_command" ? [{ name: tool.name }] : []);
    const progressMessageSeen = tasks.some(row => row.author === "/root/probe_child" && row.recipient === "/root"
      && row.content?.some(part => part.type === "encrypted_content" && part.encrypted_content === "Fixed progress report"));
    return { commandTools, progressMessageSeen, outputs, agentTools, childPromptSeen, followupPromptSeen, grandchildPromptSeen, patchTools,
      chiefCopies: chiefParts.map(part => textValues(input).reduce((count, text) => count + text.split(part).length - 1, 0)),
      chiefOrder: chiefParts.map(part => textValues(input).join("\n").indexOf(part)),
      assignmentTools: mcpTools("sage_read_assignment"), readTaskTools: mcpTools("sage_read_task"), updateTaskTools: mcpTools("sage_update_task"), createRunTools: mcpTools("sage_create_run"), createTools: mcpTools("sage_create_task"), prepareTools: mcpTools("sage_prepare_task"), reportTools: mcpTools("sage_read_report"), recordTools: mcpTools("sage_record_report"), finishTools: mcpTools("sage_finish_run"), acceptTools: mcpTools("sage_accept_review"), inspectTools: mcpTools("sage_read_recorded_report") };
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
      { type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: (childCompaction && [calls.childControl, calls.childRecompact].includes(item.call_id) || followupRecovery && item.call_id === calls.followupControl) ? 200000 : 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: (childCompaction && [calls.childControl, calls.childRecompact].includes(item.call_id) || followupRecovery && item.call_id === calls.followupControl) ? 200000 : 0 } } },
    );
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "close" });
    for (const event of events) res.write(`event: ${event.type}
data: ${JSON.stringify(event)}

`);
    res.end();
  };
  let messageId = 0;
  const message = (text) => ({ id: `message_${++messageId}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
  // This separate namespace field matches the current Responses protocol and upstream fixtures.
  const call = (call_id, name, args) => ({ type: "function_call", namespace: "collaboration", name, call_id, arguments: JSON.stringify(args) });
  const childEntry = (result) => {
    check(Array.isArray(result?.agents), "list_result_missing_agents");
    const matches = result.agents.filter((agent) => agent.agent_name === taskName);
    check(matches.length === 1, "list_result_does_not_identify_exact_spawned_task");
    return matches[0];
  };
  const nestedFlow = nestedReport && createNestedReportFlow({ integrated, check, respond, message, call, print,
    identities: () => ({ lead: childThread, reviewer: grandchildThread }), reviewerReport: GRAND_MARKER, parentMarker: MARKER,
    setReviewerTask: text => { GRAND_PROMPT = text; }, setLeadReport: text => { CHILD_MARKER = text; } });
  const server = http.createServer(async (req, res) => {
    pending.add(res);
    res.once("close", () => pending.delete(res));
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
      responseRequests++;
      if ((childCompaction || followupRecovery) && textValues(request.input).some(text => text.includes("SAGE_CHILD_COMPACT_REQUEST"))) {
        check(req.headers["thread-id"] === childThread, "compaction_wrong_child");
        check(++childCompactionRequests <= (repeatChildRecovery ? 2 : 1), "unexpected_child_compaction_count");
        respond(res, message("SAGE_CHILD_COMPACT_SUMMARY: Continue the fixed child probe.")); return;
      }
      const info = inspectRequest(request);
      if (followupRecovery && childCompactionRequests && req.headers["thread-id"] === childThread) {
        const state = integrated.readJournal(), binding = state.bindings[1];
        check(state.bindings.length === 2 && state.reservations.length === 2
          && state.completions.length === 1 && binding.child === childThread
          && binding.turn !== state.bindings[0].turn, "followup_recovery_wrong_assignment");
        const transcript = JSON.parse(readFileSync(join(root, `child-path-${childThread}.json`), "utf8"));
        const expected = { session: rootThread, child: childThread, parent: rootThread, path: taskName,
          author: "/root", turn: binding.turn, taskHash: createHash("sha256").update(FOLLOWUP_PROMPT).digest("hex") };
        const recovery = readNativeRecovery(transcript, { sessionsDir: join(codexHome, "sessions") }, expected);
        childRequests++;
        if (followupRecoveryPhase !== 0) assert.deepEqual(state, followupAdmissionSnapshot,
          "followup_recovery_changed_admission");
        if (followupRecoveryPhase === 0) {
          followupAdmissionSnapshot = structuredClone(state);
          check(recovery.required && recovery.compaction && recovery.call === null,
            "followup_compaction_did_not_require_recovery");
          check(!textValues(request.input).some(text => text.includes(FOLLOWUP_PROMPT)),
            "followup_assignment_not_removed_by_compaction");
          followupRecoveryPhase = 1;
          respond(res, { type: "function_call", name: "list_mcp_resources", call_id: calls.childUnrecovered, arguments: "{}" });
        } else if (followupRecoveryPhase === 1) {
          check(String(info.outputs[calls.childUnrecovered]).includes("Read your current assignment with sage_read_assignment"),
            "followup_unrecovered_tool_not_denied");
          check(info.assignmentTools.length === 1, "followup_assignment_reader_missing");
          followupRecoveryPhase = 2;
          respond(res, { type: "function_call", ...info.assignmentTools[0], call_id: calls.childRecovery, arguments: "{}" });
        } else {
          check(followupRecoveryPhase === 2 && !recovery.required && recovery.call === calls.childRecovery,
            "followup_recovery_not_verified");
          const result = info.outputs[calls.childRecovery];
          check(result?.decision === "current-assignment" && result.message === FOLLOWUP_PROMPT && result.message !== CHILD_PROMPT
            && result.taskHash === expected.taskHash, "followup_restored_previous_assignment");
          const events = readdirSync(join(root, "events")).map(name => JSON.parse(readFileSync(join(root, "events", name), "utf8")));
          check(!events.some(row => row.hook_event_name === "PostToolUse" && row.tool_use_id === calls.childUnrecovered),
            "followup_unrecovered_tool_ran");
          const compactHooks = events.filter(row => ["PreCompact", "PostCompact"].includes(row.hook_event_name));
          check(compactHooks.length === 2 && new Set(compactHooks.map(row => row.hook_event_name)).size === 2
            && compactHooks.every(row => row.trigger === "auto" && row.agent_id === childThread
              && row.session_id === rootThread && row.turn_id === binding.turn), "followup_compaction_identity_mismatch");
          const history = readFileSync(transcript, "utf8").trim().split("\n").map(line => JSON.parse(line));
          check(history.filter(row => row.type === "compacted").length === 1, "followup_saved_compaction_missing");
          followupRecoveryVerified = true; followupRecoveryPhase = 3;
          print({ type: "followup_compaction_recovery", exactCurrentAssignment: true,
            previousAssignmentNotRestored: true, sameChildNewTurn: true, unchangedAdmission: true,
            simulatedModel: true });
          respond(res, message(FOLLOWUP_MARKER));
        }
        return;
      }
      if (childCompaction && childCompactionRequests && req.headers["thread-id"] === childThread) {
        const recoveryCall = childCompactionRequests === 2 ? calls.childRecoverySecond : calls.childRecovery;
        const deniedCall = childCompactionRequests === 2 ? calls.childUnrecoveredSecond : calls.childUnrecovered;
        if (childRecoveryGatePhase === 6) {
          check(childCompactionRequests === 2, "second_compaction_missing");
          const state = integrated.readJournal(), binding = state.bindings[0];
          const transcript = JSON.parse(readFileSync(join(root, `child-path-${childThread}.json`), "utf8"));
          const history = readFileSync(transcript, "utf8").trim().split("\n").map(line => JSON.parse(line));
          check(history.filter(row => row.type === "compacted").length === 2, "second_checkpoint_missing");
          const recovery = readNativeRecovery(transcript, { sessionsDir: join(codexHome, "sessions") }, {
            session: rootThread, child: childThread, parent: rootThread, path: taskName, author: "/root",
            turn: binding.turn, taskHash: createHash("sha256").update(CHILD_PROMPT).digest("hex") });
          check(recovery.required && recovery.compaction && recovery.call === null, "old_recovery_survived_compaction");
          check(state.reservations.length === 1 && state.bindings.length === 1
            && (state.completions?.length ?? 0) === 0, "second_compaction_changed_admission");
          childCompactionReady = false; childRecoveryGatePhase = 1; childRequests++;
          print({ type: "child_repeat_compaction_evidence", persistedCompactions: 2,
            previousRecoveryInvalidated: true, unchangedAdmission: true, simulatedModel: true });
          respond(res, { type: "function_call", name: "list_mcp_resources", call_id: deniedCall, arguments: "{}" }); return;
        }
        if (childRecoveryGatePhase === 1) {
          check(typeof info.outputs[deniedCall] === "string"
            && info.outputs[deniedCall].includes("Read your current assignment with sage_read_assignment"),
            "unrecovered_tool_was_not_denied");
          const events = readdirSync(join(root, "events")).map(name => JSON.parse(readFileSync(join(root, "events", name), "utf8")));
          check(!events.some(row => row.hook_event_name === "PostToolUse" && row.tool_use_id === deniedCall),
            "unrecovered_tool_ran");
          check((integrated.readJournal().completions?.length ?? 0) === 0, "premature_recovery_completion");
          childRecoveryGatePhase = 2; childRequests++;
          respond(res, message(CHILD_MARKER)); return;
        }
        if (childRecoveryGatePhase === 2) {
          check(textValues(request.input).some(text => text.includes("Read your current assignment with sage_read_assignment before reporting completion.")),
            "unrecovered_stop_was_not_blocked");
          const state = integrated.readJournal();
          check(state.reservations.length === 1 && state.bindings.length === 1
            && (state.completions?.length ?? 0) === 0, "unrecovered_stop_changed_admission");
          check(info.assignmentTools.length === 1, "child_assignment_reader_missing");
          childRecoveryGatePhase = 3; childRecoveryPending = true; childRequests++;
          respond(res, { type: "function_call", ...info.assignmentTools[0], call_id: recoveryCall, arguments: "{}" }); return;
        }
        if (childRecoveryGatePhase === 4) {
          check(textValues(request.input).some(text => text.includes("Sage could not verify this hook request")),
            "changed_recovery_target_stop_not_blocked");
          const state = integrated.readJournal();
          check(state.reservations.length === 1 && state.bindings.length === 1
            && (state.completions?.length ?? 0) === 0, "changed_recovery_target_released_capacity");
          check(integrated.readLogbook().tasks[0].branch === "codex/t1-retargeted", "changed_recovery_target_missing");
          restoreRecoveryTarget(); restoreRecoveryTarget = undefined;
          recoveryTargetVerified = true; childRecoveryGatePhase = 5; childRequests++;
          print({ type: "child_recovery_target_evidence", changedTargetRefused: true,
            noPrematureCompletion: true, simulatedModel: true });
          respond(res, message(CHILD_MARKER)); return;
        }
        if (childRecoveryPending) {
          const recovered = info.outputs[recoveryCall];
          const state = integrated.readJournal(), binding = state.bindings[0];
          check(recovered?.decision === "current-assignment" && recovered.message === CHILD_PROMPT
            && recovered.taskHash === createHash("sha256").update(CHILD_PROMPT).digest("hex")
            && recovered.child === childThread && recovered.turn === binding.turn
            && recovered.assignment === binding.assignment && recovered.task === "T1" && recovered.run === "R1"
            && state.reservations.length === 1 && state.bindings.length === 1
            && (state.completions?.length ?? 0) === 0, "child_assignment_recovery_mismatch");
          const transcript = JSON.parse(readFileSync(join(root, `child-path-${childThread}.json`), "utf8"));
          check(lstatSync(transcript).size <= 16 * 1024 * 1024, "recovery_transcript_too_large");
          const outputs = readFileSync(transcript, "utf8").trim().split("\n").map(line => JSON.parse(line))
            .filter(row => row.type === "response_item" && row.payload?.type === "function_call_output"
              && row.payload.call_id === recoveryCall);
          const matchingCalls = readFileSync(transcript, "utf8").trim().split("\n").map(line => JSON.parse(line))
            .filter(row => row.type === "response_item" && row.payload?.type === "function_call"
              && row.payload.call_id === recoveryCall);
          check(outputs.length === 1 && matchingCalls.length === 1 && readRecoveryOutput(outputs[0], { child: childThread, turn: binding.turn,
            taskHash: recovered.taskHash }, matchingCalls[0]) === CHILD_PROMPT, "recovery_output_would_change_on_replay");
          const recovery = readNativeRecovery(transcript, { sessionsDir: join(codexHome, "sessions") }, {
            session: rootThread, child: childThread, parent: rootThread, path: taskName, author: "/root",
            turn: binding.turn, taskHash: recovered.taskHash });
          check(!recovery.required && recovery.compaction && recovery.call === recoveryCall,
            "recovery_not_bound_to_current_compaction");
          childRecoveryPending = false; childCompactionReady = true; childRequests++;
          print({ type: "child_assignment_recovery_evidence", exactPreparedMessage: true, sameChildAndTurn: true,
            unchangedAdmission: true, replayTextStable: true, recoveryAfterLatestCompaction: true, toolAndStopRecoveryEnforced: true, simulatedModel: true, automaticRecoveryEnforced: false });
          if (repeatChildRecovery && childCompactionRequests === 1) {
            childRecoveryGatePhase = 6;
            respond(res, { type: "function_call", name: "list_mcp_resources", call_id: calls.childRecompact, arguments: "{}" }); return;
          }
          restoreRecoveryTarget = integrated.retargetFixtureRun(); childRecoveryGatePhase = 4;
          respond(res, message(CHILD_MARKER)); return;
        }
        if (childCompactionObserved) {
          print({ type: "child_compaction_stop_evidence", modelContinuedAfterReport: true,
            nativeCompletionAccepted: (integrated.readJournal().completions?.length ?? 0) !== 0,
            hookRefusalPresent: textValues(request.input).some(text => text.includes("Sage could not verify this hook request")) });
          check(false, "child_compaction_stop_not_accepted");
        }
        check(childRequests === 1, "unexpected_post_compaction_request");
        const values = textValues(request.input);
        check(values.some(text => text.includes("SAGE_CHILD_COMPACT_SUMMARY")), "missing_child_compaction_summary");
        const transcript = JSON.parse(readFileSync(join(root, `child-path-${childThread}.json`), "utf8"));
        const stat = lstatSync(transcript);
        check(stat.isFile() && stat.size <= 16 * 1024 * 1024, "invalid_child_compaction_transcript");
        const lines = readFileSync(transcript, "utf8").trim().split("\n");
        check(lines.length <= 65536, "child_compaction_transcript_too_many_rows");
        const history = lines.map(line => JSON.parse(line));
        check(history.filter(row => row.type === "compacted").length === 1, "missing_saved_child_compaction");
        const captured = readdirSync(join(root, "events")).map(name => JSON.parse(readFileSync(join(root, "events", name), "utf8")));
        const hooks = captured.filter(row => ["PreCompact", "PostCompact"].includes(row.hook_event_name));
        const journal = integrated.readJournal(), bound = journal.bindings[0];
        check(journal.reservations.length === 1 && journal.bindings.length === 1
          && bound.child === childThread && (journal.completions?.length ?? 0) === 0, "child_compaction_changed_admission");
        check(hooks.length === 2 && new Set(hooks.map(row => row.hook_event_name)).size === 2
          && hooks.every(row => row.trigger === "auto" && row.agent_id === childThread
            && row.session_id === rootThread && row.turn_id === bound.turn), "child_compaction_hook_identity_mismatch");
        const recovery = readNativeRecovery(transcript, { sessionsDir: join(codexHome, "sessions") }, {
          session: rootThread, child: childThread, parent: rootThread, path: taskName, author: "/root",
          turn: bound.turn, taskHash: createHash("sha256").update(CHILD_PROMPT).digest("hex") });
        check(recovery.required && recovery.compaction && recovery.call === null, "compaction_did_not_require_recovery");
        childCompactionReady = values.some(text => text.includes(CHILD_PROMPT));
        childCompactionObserved = true; childRequests++;
        print({ type: "child_compaction_evidence", exactAssignmentPresent: childCompactionReady,
          persistedCompactions: 1, sameChildAndTurn: true, reservations: 1, bindings: 1,
          childSessionStartCompact: captured.some(row => row.hook_event_name === "SessionStart" && row.source === "compact"
            && (row.agent_id === childThread || row.session_id === childThread)),
          simulatedModel: true, readyForChildCompaction: childCompactionReady });
        if (childRecovery) {
          check(info.assignmentTools.length === 1, "child_assignment_reader_missing");
          childRecoveryGatePhase = 1;
          respond(res, { type: "function_call", name: "list_mcp_resources", call_id: calls.childUnrecovered, arguments: "{}" });
        } else respond(res, message(CHILD_MARKER));
        return;
      }
      request = null; // Retain only tool results, advertised names, and a fixed-task boolean.
      const thread = req.headers["thread-id"];
      const subagent = req.headers["x-openai-subagent"];
      check(typeof thread === "string" && thread.length > 0, "missing_native_thread_header");
      if (subagent === "collab_spawn") {
        if (sageFollowup && info.followupPromptSeen) {
          check(thread === childThread, "sage_followup_changed_child");
          if (resumedFailure && resumedFailureStep > 0) {
            childRequests++;
            if (resumedFailureStep === 1) {
              const prepared = info.outputs[calls.resumedPrepare];
              check(prepared?.decision === "prepared" && prepared.role === "code-reviewer", "resumed_failure_preparation_missing");
              resumedFailureStep++;
              respond(res, call(calls.resumedSpawn, "spawn_agent", { task_name: prepared.name, message: prepared.message,
                fork_turns: prepared.fork_turns, model: "sage-fixture-nonexistent-model" }));
            } else if (resumedFailureStep === 2) {
              check(info.outputs[calls.resumedSpawn] === "Unknown model `sage-fixture-nonexistent-model` for spawn_agent. Available models: sage-native-parent", "resumed_failure_error_missing");
              resumedFailureStep++;
              respond(res, call(calls.resumedList, "list_agents", {}));
            } else if (resumedFailureStep === 3) {
              const journal = integrated.readJournal(), agents = info.outputs[calls.resumedList]?.agents;
              print({ type: "resumed_failure_observed", failures: journal.failures?.length ?? 0, bindings: journal.bindings.length });
              check(Array.isArray(agents) && agents.length === 2
                && agents.every(row => ["/root", taskName].includes(row.agent_name)), "resumed_failure_created_child");
              const failed = journal.reservations.find(row => row.assignment.run === "R2");
              check(journal.failures?.length === 1 && journal.failures[0].assignment === failed?.assignment.id
                && journal.failures[0].issuer === childThread && journal.bindings.length === 2
                && journal.completions.length === 1, "resumed_failure_not_recovered");
              resumedFailureStep++; resumedFailureVerified = true;
              respond(res, message(FOLLOWUP_MARKER));
            } else check(false, "resumed_failure_repeated");
            return;
          }
          if (Object.hasOwn(info.outputs, calls.followupControl)) {
            check(childRequests === 3 && integrated.readJournal().bindings.length === 2, "sage_followup_tool_did_not_bind");
            check(!JSON.stringify(info.outputs[calls.followupControl]).includes("Sage could not"), "sage_followup_tool_denied");
            childRequests++;
            if (resumedFailure) {
              check(info.prepareTools.length === 1, "resumed_failure_prepare_tool_missing");
              resumedFailureStep = 1;
              const brief = Object.fromEntries(["GOAL", "SCOPE", "CONTEXT", "DECISIONS", "ACCEPTANCE", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"]
                .map(key => [key, "Review the fixed temporary commit. Simulated evidence only."]));
              respond(res, { type: "function_call", ...info.prepareTools[0], call_id: calls.resumedPrepare,
                arguments: JSON.stringify({ task: "T1", run: "R2", name: "failed_reviewer", role: "code-reviewer", reviewCycle: 1, brief }) });
            } else respond(res, message(FOLLOWUP_MARKER));
            return;
          }
          check(childRequests === 2, "sage_followup_child_repeated");
          childRequests++; followupResponse = res; releaseFollowupReady(); return;
        }
        if ((blockStop || correctReport || escapeReport) && thread === childThread && childRequests === 1) {
          childRequests++;
          prematureCompletions = integrated.readJournal().completions?.length ?? 0;
          const transcript = JSON.parse(readFileSync(join(root, `child-path-${childThread}.json`), "utf8"));
          const rows = readFileSync(transcript, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
          const terminalMarkers = rows.filter(row => row.type === "event_msg" && row.payload?.type === "task_complete").length;
          print({ type: "stop_continuation_evidence", sameNativeChild: true, modelContinuedAfterBlockedStop: true,
            savedCompletionsWhileContinuing: prematureCompletions, terminalMarkers, simulatedModel: true });
          respond(res, message(CHILD_MARKER)); return;
        }
        if (nestedReport && thread === childThread) {
          childRequests++; nestedFlow.lead(info, res); return;
        }
        if (nestedReport && info.grandchildPromptSeen) {
          check(thread !== rootThread && thread !== childThread && (!grandchildThread || thread === grandchildThread), "nested_reviewer_identity_changed");
          grandchildThread = thread; grandchildRequests++; nestedFlow.reviewer(info, res); return;
        }
        if (childSandbox && Object.hasOwn(info.outputs, calls.childSandbox)) {
          check(thread === childThread && childRequests === 2, "child_sandbox_identity_changed");
          check(String(info.outputs[calls.childSandbox]).includes("A child cannot request broader sandbox permissions. Ask the chief to run this command."), "child_sandbox_sage_denial_missing");
          childRequests++; childSandboxVerified = true; respond(res, message(CHILD_MARKER)); return;
        }
        if (childMessage && Object.hasOwn(info.outputs, calls.childChiefMessage)) {
          check(thread === childThread && childRequests === 3, "chief_message_identity_changed");
          check(info.outputs[calls.childChiefMessage] === "", "chief_message_receipt_missing");
          childRequests++; childMessageVerified = true; respond(res, message(CHILD_MARKER)); return;
        }
        if (childMessage && Object.hasOwn(info.outputs, calls.childPeerMessage)) {
          check(thread === childThread && childRequests === 2, "peer_message_identity_changed");
          check(String(info.outputs[calls.childPeerMessage]).includes("A Sage child sends messages only to the chief"), "peer_message_not_denied");
          childRequests++; respond(res, call(calls.childChiefMessage, "send_message", { target: "/root", message: "Fixed progress report" })); return;
        }
        if (sage && Object.hasOwn(info.outputs, calls.childControl)) {
          check(thread === childThread && childRequests === 1, "child_control_changed_identity_or_repeated"); childRequests++;
          if (childSandbox) {
            check(info.commandTools.length === 1, "child_command_tool_missing");
            respond(res, { type: "function_call", ...info.commandTools[0], call_id: calls.childSandbox,
              arguments: JSON.stringify({cmd: "printf sage-child-sandbox-control", shell: "/bin/sh", workdir: workspace,
                sandbox_permissions: "require_escalated", justification: "Fixed harmless sandbox-denial probe", max_output_tokens: 100}) });
            return;
          }
          if (childMessage) {
            respond(res, call(calls.childPeerMessage, "send_message", { target: "/root/peer", message: "Fixed progress report" })); return;
          }
          if (interruption) {
            check(integrated.readJournal().bindings.length === 1, "interrupted_child_not_bound");
            releaseBoundChild(); return;
          }
          if (retargetedRun) {
            check(JSON.stringify(info.outputs[calls.childControl]).includes("Sage could not verify this tool call"), "retargeted_run_denial_missing");
            check(integrated.readLogbook().runs[0].status === "running", "retargeted_run_stopped");
            check(integrated.readLogbook().tasks[0].branch === "codex/t1-retargeted", "retargeted_task_reset");
            retargetedRunVerified = true;
          }
          if (endedRun) {
            check(JSON.stringify(info.outputs[calls.childControl]).includes("Sage could not verify this tool call"), "ended_run_denial_missing");
            check(integrated.readLogbook().runs[0].status === "done", "ended_run_reopened");
            endedRunVerified = true;
          }
          if (readonlyPatch) {
            check(JSON.stringify(info.outputs[calls.childControl]).includes("This Sage role cannot edit files"), "readonly_role_denial_missing");
            check(!existsSync(join(workspace, "readonly-lead-probe.txt")), "readonly_role_created_file");
            check(!existsSync(join(root, "patch-policy-receipt.json")), "readonly_role_reached_evaluator");
            readonlyPatchVerified = true;
          }
          respond(res, message(CHILD_MARKER)); return;
        }
        if (nested && info.grandchildPromptSeen) {
          check(thread !== rootThread && thread !== childThread && grandchildRequests === 0, "grandchild_identity_invalid");
          grandchildThread = thread; grandchildRequests++;
          respond(res, message(GRAND_MARKER)); return;
        }
        if (nested && Object.hasOwn(info.outputs, calls.childList)) {
          check(thread === childThread, "child_list_changed_identity");
          const grand = info.outputs[calls.childList]?.agents?.find(row => row.agent_name === "/root/probe_child/probe_grandchild");
          check(grand?.agent_status?.completed === GRAND_MARKER, "grandchild_completion_missing");
          childRequests++; respond(res, message(CHILD_MARKER)); return;
        }
        if (nested && Object.hasOwn(info.outputs, calls.childWait)) {
          check(thread === childThread, "child_wait_changed_identity"); childRequests++;
          respond(res, call(calls.childList, "list_agents", {})); return;
        }
        if (nested && Object.hasOwn(info.outputs, calls.childSpawn)) {
          check(thread === childThread && info.outputs[calls.childSpawn].task_name === "/root/probe_child/probe_grandchild", "nested_spawn_missing"); childRequests++;
          respond(res, call(calls.childWait, "wait_agent", {})); return;
        }
        if (followUp && childRequests === 1) {
          check(thread === childThread, "followup_changed_child_identity");
          check(info.followupPromptSeen, "followup_task_not_received");
          childRequests++;
          followupResponse = res;
          releaseFollowupReady();
          print({ type: "evidence", event: "native_followup_received", sameThread: true, fixedTaskReceived: true });
          return;
        }
        check(rootThread && thread !== rootThread && childRequests === 0, "unexpected_child_request_identity");
        check(info.childPromptSeen, "child_did_not_receive_fixed_task");
        if (nested) check(["spawn_agent", "list_agents", "wait_agent"].every(name => info.agentTools.includes(name)), "nested_tools_missing");
        childThread = thread;
        childRequests++;
        childTaskSeen = true;
        if (readonlyPatch) {
          check(info.patchTools.length === 1 && info.patchTools[0].type === "custom", "child_patch_schema_missing");
          childPatchTool = info.patchTools[0];
        }
        childResponse = res;
        print({ type: "evidence", event: "native_child_request_held", distinctThread: true, fixedTaskReceived: true });
        releaseChildReady();
        return;
      }
      check(!subagent, "unexpected_non_spawn_agent_request");
      if (!rootThread && chiefText) {
        const count = info.chiefCopies;
        check(count.every(copies => copies === (sage ? 1 : 0)), "chief_context_delivery_mismatch");
        if (sage) check(info.chiefOrder.every((position, index) => index === 0 || position > info.chiefOrder[index - 1]), "chief_context_order_mismatch");
        chiefContextVerified = true;
        print({ type: "chief_context_evidence", sageMode: sage, exactSharedRulesDelivered: sage,
          copiesPerPart: count, ordered: sage, simulatedModel: true, realModelConsumptionVerified: false });
      }
      rootThread ??= thread;
      check(thread === rootThread, "unexpected_root_thread_identity");
      if (childMessage && info.progressMessageSeen) chiefReceivedMessage = true;
      if (createTask && !createdTaskVerified) {
        check(info.createTools.length === 1, "task_creation_tool_missing");
        if (!Object.hasOwn(info.outputs, calls.create)) {
          respond(res, { type: "function_call", ...info.createTools[0], call_id: calls.create, arguments: JSON.stringify(taskRequest) }); return;
        }
        const receipt = info.outputs[calls.create];
        check(receipt?.decision === "task-created" && receipt.task?.id === (createRun ? "T1" : "T2") && receipt.task.state === "framed"
          && receipt.task.route === "build,code-review,security-review,ux-review,qa", "task_creation_receipt_invalid");
        createdTask = receipt.task;
        if (!Object.hasOwn(info.outputs, calls.createRetry)) {
          respond(res, { type: "function_call", ...info.createTools[0], call_id: calls.createRetry, arguments: JSON.stringify(taskRequest) }); return;
        }
        const retried = info.outputs[calls.createRetry];
        check(retried?.decision === "already-created" && JSON.stringify(retried.task) === JSON.stringify(createdTask), "task_creation_retry_invalid");
        const logbook = integrated.readLogbook();
        check(logbook.tasks.length === (createRun ? 1 : 2) && logbook.tasks.at(-1).title === taskRequest.title
          && logbook.tasks.at(-1).route === createdTask.route && logbook.tasks.at(-1).state === "framed"
          && logbook.runs.length === (createRun ? 0 : 1) && logbook.decisions.length === 1
          && logbook.decisions[0].task === createdTask.id && logbook.decisions[0].why === taskRequest.why, "task_creation_logbook_mismatch");
        check(integrated.readJournal().reservations.length === 0, "task_creation_reserved_capacity");
        createdTaskVerified = true;
        print({ type: "task_creation_evidence", createdTasks: 1, retryReusedTask: true, addedBlockDecisions: 1,
          noRunOrDispatchCreated: true, simulatedModel: true, preseededControlTask: !createRun });
      }
      if (createRun && !createdRunVerified) {
        check(info.createRunTools.length === 1, "run_creation_tool_missing");
        if (!Object.hasOwn(info.outputs, calls.createRun)) {
          respond(res, { type: "function_call", ...info.createRunTools[0], call_id: calls.createRun, arguments: JSON.stringify(runRequest) }); return;
        }
        const receipt = info.outputs[calls.createRun];
        check(receipt?.decision === "run-created" && receipt.run?.id === "R1" && receipt.run.task === createdTask.id
          && receipt.run.role === "lead" && receipt.run.status === "running", "run_creation_receipt_invalid");
        createdRun = receipt.run;
        if (!Object.hasOwn(info.outputs, calls.createRunRetry)) {
          respond(res, { type: "function_call", ...info.createRunTools[0], call_id: calls.createRunRetry, arguments: JSON.stringify(runRequest) }); return;
        }
        const retried = info.outputs[calls.createRunRetry], logbook = integrated.readLogbook();
        check(retried?.decision === "already-created" && JSON.stringify(retried.run) === JSON.stringify(createdRun), "run_creation_retry_invalid");
        check(logbook.tasks.length === 1 && logbook.runs.length === 1 && logbook.runs[0].id === createdRun.id
          && logbook.runs[0].task === createdTask.id && logbook.runs[0].role === "lead" && logbook.runs[0].status === "running"
          && logbook.ledger.length === 0 && integrated.readJournal().reservations.length === 0, "run_creation_logbook_mismatch");
        createdRunVerified = true;
        print({ type: "run_creation_evidence", createdRuns: 1, retryReusedRun: true, preseededTasks: 0, preseededRuns: 0,
          admissionUnchanged: true, simulatedModel: true });
      }
      if (taskLifecycle && !taskStarted) {
        check(info.readTaskTools.length === 1 && info.updateTaskTools.length === 1, "task_lifecycle_tools_missing");
        if (!Object.hasOwn(info.outputs, calls.readTask)) {
          respond(res, { type: "function_call", ...info.readTaskTools[0], call_id: calls.readTask, arguments: JSON.stringify({ task: "T1" }) }); return;
        }
        initialTask = info.outputs[calls.readTask];
        check(initialTask?.task?.state === "framed" && /^[0-9a-f]{64}$/.test(initialTask.version), "task_snapshot_missing");
        const brief = taskChange(1, initialTask.version, { state: "briefed", branch: "codex/t1-lifecycle" });
        if (!Object.hasOwn(info.outputs, calls.brief)) {
          respond(res, { type: "function_call", ...info.updateTaskTools[0], call_id: calls.brief, arguments: JSON.stringify(brief) }); return;
        }
        briefedTask = info.outputs[calls.brief];
        check(briefedTask?.decision === "task-updated" && briefedTask.task.state === "briefed" && briefedTask.task.branch === "codex/t1-lifecycle", "briefed_task_missing");
        if (!Object.hasOwn(info.outputs, calls.briefRetry)) {
          respond(res, { type: "function_call", ...info.updateTaskTools[0], call_id: calls.briefRetry, arguments: JSON.stringify(brief) }); return;
        }
        check(JSON.stringify(info.outputs[calls.briefRetry]) === JSON.stringify({ ...briefedTask, decision: "already-updated" }), "task_update_retry_mismatch");
        if (!Object.hasOwn(info.outputs, calls.build)) {
          respond(res, { type: "function_call", ...info.updateTaskTools[0], call_id: calls.build,
            arguments: JSON.stringify(taskChange(2, briefedTask.version, { state: "building" })) }); return;
        }
        buildingTask = info.outputs[calls.build];
        check(buildingTask?.decision === "task-updated" && buildingTask.task.state === "building"
          && integrated.readLogbook().tasks[0].state === "building", "building_task_missing");
        taskStarted = true;
      }
      const preparationCall = failedDispatchRecovered ? calls.prepareRetry : calls.prepare;
      if (sage && !prepared) {
        if (!Object.hasOwn(info.outputs, preparationCall)) {
          check(info.prepareTools.length === 1, "preparation_tool_missing");
          const brief = Object.fromEntries(["GOAL", "SCOPE", "CONTEXT", "DECISIONS", "ACCEPTANCE", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"].map(key => [key, "Complete the fixed native fixture task."]));
          respond(res, { type: "function_call", ...info.prepareTools[0], call_id: preparationCall,
            arguments: JSON.stringify({ task: "T1", run: "R1", name: failedSpawn && !failedDispatchRecovered ? "probe_failed" : "probe_child", role: reportProbe ? "code-reviewer" : "lead", ...(reportProbe ? { reviewCycle: 1 } : {}), brief }) }); return;
        }
        const receipt = info.outputs[preparationCall];
        check(receipt?.decision === "prepared" && typeof receipt.message === "string" && receipt.fork_turns === "none", "invalid_preparation_receipt");
        if (reportProbe) {
          check(JSON.stringify(receipt.review) === JSON.stringify(integrated.reviewTarget)
            && receipt.message.includes(`Commit: ${integrated.reviewTarget.sha}`), "review_target_not_delivered");
          print({type:"review_target_evidence",actualBranchHead:true,round:receipt.review.round,cycle:receipt.review.cycle,deliveredInTask:true,simulatedModel:true});
        }
        CHILD_PROMPT = receipt.message; prepared = true;
      }
      rootRequests++;
      if (failedSpawn && !failedDispatchRecovered && rootRequests === 2) {
        const result = info.outputs[calls.spawn];
        check(typeof result === "string" && result.length > 0, "failed_spawn_has_no_native_error");
        check(result === "Unknown model `sage-fixture-nonexistent-model` for spawn_agent. Available models: sage-native-parent", "unexpected_native_preflight_error");
        print({ type: "failed_spawn_result", verifiedUnknownModelError: true });
        respond(res, call(calls.failureList, "list_agents", {})); return;
      }
      if (failedSpawn && !failedDispatchRecovered && rootRequests === 3) {
        const registry = info.outputs[calls.failureList], state = integrated.readJournal();
        check(registry?.agents?.length === 1 && registry.agents[0].agent_name === "/root", "failed_dispatch_created_child");
        check(state.failures?.length === 1 && state.bindings.length === 0 && childRequests === 0, "failed_dispatch_not_reconciled");
        print({ type: "failed_spawn_registry", onlyRoot: true, failures: 1, bindings: 0 });
        failedDispatchRecovered = true; prepared = false; rootRequests = 0;
        const brief = Object.fromEntries(["GOAL", "SCOPE", "CONTEXT", "DECISIONS", "ACCEPTANCE", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"].map(key => [key, "Complete the fixed native fixture task."]));
        respond(res, { type: "function_call", ...info.prepareTools[0], call_id: calls.prepareRetry,
          arguments: JSON.stringify({ task: "T1", run: "R1", name: "probe_child", role: "lead", brief }) }); return;
      }
      if (childMessage && rootRequests >= 4) {
        if (childMessagePhase === "wait") {
          const waited = info.outputs[childMessageWaitCall ?? calls.wait];
          check(typeof waited?.timed_out === "boolean", "child_message_wait_missing"); nativeWait = true;
          childMessageListCall = `child_message_list_${rootRequests}`; knownCalls.add(childMessageListCall);
          childMessagePhase = "list";
          respond(res, call(childMessageListCall, "list_agents", { path_prefix: taskName })); return;
        }
        const agent = childEntry(info.outputs[childMessageListCall]);
        if (agent.agent_status?.completed === CHILD_MARKER) {
          nativeCompleted = true; respond(res, message(MARKER)); return;
        }
        check(agent.agent_status === "running", "child_message_child_failed");
        childMessageWaitCall = `child_message_wait_${rootRequests}`; knownCalls.add(childMessageWaitCall);
        childMessagePhase = "wait";
        respond(res, call(childMessageWaitCall, "wait_agent", {})); return;
      }
      if (interruption && rootRequests === 4) {
        check(info.outputs[calls.wait]?.previous_status === "running", "interrupt_did_not_stop_running_child");
        respond(res, call(calls.completed, "list_agents", { path_prefix: taskName })); return;
      }
      if (interruption && rootRequests === 5) {
        check(childEntry(info.outputs[calls.completed]).agent_status === "interrupted", "native_child_not_interrupted");
        const journal = integrated.readJournal(), logbook = integrated.readLogbook();
        check(journal.completions?.length === 1 && journal.completions[0].outcome === "interrupted", "interruption_not_recovered");
        check((journal.reports?.length ?? 0) === 0 && logbook.runs[0].status === "running" && logbook.ledger.length === 0, "interruption_accepted_success");
        interruptionVerified = true;
        respond(res, message(MARKER)); return;
      }
      if (nestedReport && rootRequests > 5) { nestedFlow.chief(rootRequests - 5, info, res, CHILD_MARKER); return; }
      if (sageFollowup && rootRequests > 5) {
        const mcp = (tools, id, input) => { check(tools.length === 1, "followup_visible_tool_missing");
          respond(res, { type: "function_call", ...tools[0], call_id: id, arguments: JSON.stringify(input) }); };
        if (rootRequests === 6) {
          reportReceipt = info.outputs[calls.report];
          check(reportReceipt?.decision === "report-ready" && reportReceipt.run === "R1"
            && reportReceipt.reportHash === createHash("sha256").update(CHILD_MARKER).digest("hex"), "followup_first_report_missing");
          mcp(info.recordTools, calls.record, { name: "probe_child", reportHash: reportReceipt.reportHash });
          return;
        }
        if (rootRequests === 7) {
          check(info.outputs[calls.record]?.decision === "report-recorded", "followup_first_report_not_recorded");
          mcp(info.finishTools, calls.finish, { assignment: reportReceipt.assignment, reportHash: reportReceipt.reportHash });
          return;
        }
        if (rootRequests === 8) {
          check(info.outputs[calls.finish]?.decision === "run-finished"
            && integrated.readLogbook().runs.find(run => run.id === "R1")?.status === "done", "followup_first_run_not_finished");
          mcp(info.createRunTools, calls.followupCreate, runRequest);
          return;
        }
        const step = rootRequests - 3;
        if (step === 6) {
          followupRun = info.outputs[calls.followupCreate];
          check(followupRun?.decision === "run-created" && followupRun.run.id !== "R1", "followup_run_missing");
          const prior = integrated.readJournal().bindings[0];
          mcp(info.prepareTools, calls.followupPrepare, { task: "T1", run: followupRun.run.id, name: "probe_continued", role: "lead",
            previous: prior.assignment, brief: Object.fromEntries(["GOAL", "SCOPE", "CONTEXT", "DECISIONS", "ACCEPTANCE", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"].map(key => [key, "Complete the second fixed native fixture task."])) });
        } else if (step === 7) {
          followupPrepared = info.outputs[calls.followupPrepare];
          check(followupPrepared?.target === childThread && typeof followupPrepared.message === "string", "followup_preparation_missing");
          FOLLOWUP_PROMPT = followupPrepared.message;
          respond(res, call(calls.followup, "followup_task", { target: childThread, message: FOLLOWUP_PROMPT }));
        } else if (step === 8) {
          check(info.outputs[calls.followup] === "", "followup_native_result_invalid");
          await followupReady;
          if (fixtureFailure) { reject(res); return; }
          respond(res, call(calls.followupWait, "wait_agent", {}));
          check(integrated.readJournal().bindings.length === 1, "followup_bound_before_child_callback");
          respond(followupResponse, followupNoTool ? message(FOLLOWUP_MARKER)
            : { type: "function_call", name: "list_mcp_resources", call_id: calls.followupControl, arguments: "{}" });
        } else if (step === 9) respond(res, call(calls.followupDone, "list_agents", { path_prefix: taskName }));
        else if (step === 10) {
          check(childEntry(info.outputs[calls.followupDone]).agent_status?.completed === FOLLOWUP_MARKER, "followup_native_completion_missing");
          if (unobservedFollowup) {
            const recovered = integrated.readJournal();
            print({ type: "unobserved_followup_recovery", nativeCompleted: true,
              bindings: recovered.bindings.length, completions: recovered.completions?.length ?? 0 });
            check(recovered.bindings.length === 2 && recovered.completions?.length === 2, "unobserved_followup_not_recovered");
          }
          mcp(info.reportTools, calls.followupReport, { name: "probe_continued" });
        } else if (step === 11) {
          followupReport = info.outputs[calls.followupReport];
          check(followupReport?.run === followupRun.run.id && followupReport.child === childThread
            && followupReport.reportHash === createHash("sha256").update(FOLLOWUP_MARKER).digest("hex"), "followup_report_missing");
          mcp(info.recordTools, calls.followupRecord, { name: "probe_continued", reportHash: followupReport.reportHash });
        } else if (step === 12) {
          check(info.outputs[calls.followupRecord]?.decision === "report-recorded", "followup_report_not_recorded");
          mcp(info.reportTools, calls.followupOld, { name: "probe_child" });
        } else if (step === 13) {
          const old = info.outputs[calls.followupOld];
          check(old?.run === "R1" && old.turn !== followupReport.turn && old.child === childThread
            && old.reportHash === createHash("sha256").update(CHILD_MARKER).digest("hex"), "followup_changed_prior_report");
          sageFollowupVerified = true; respond(res, message(MARKER));
        } else throw Error("unexpected_followup_root_request");
        return;
      }
      if (rootRequests === 1) {
        check(["spawn_agent", "list_agents", "wait_agent"].every((name) => info.agentTools.includes(name)), "required_native_tools_missing");
        respond(res, call(failedDispatchRecovered ? calls.spawnRetry : calls.spawn, "spawn_agent", {
          task_name: failedSpawn && !failedDispatchRecovered ? "probe_failed" : "probe_child", message: CHILD_PROMPT,
          fork_turns: "none", ...(failedSpawn && !failedDispatchRecovered ? { model: "sage-fixture-nonexistent-model" } : {}) }));
      } else if (rootRequests === 2) {
        const result = info.outputs[failedDispatchRecovered ? calls.spawnRetry : calls.spawn];
        if (outage && typeof result === "string" && result.length > 0) {
          denied = true;
          respond(res, message(MARKER));
          return;
        }
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
        if (interruption) {
          check(info.agentTools.includes("interrupt_agent"), "native_interrupt_tool_missing");
          respond(childResponse, { type: "function_call", name: "list_mcp_resources", call_id: calls.childControl, arguments: "{}" });
          childResponseSent = true;
          await boundChild;
          if (fixtureFailure) { reject(res); return; }
          respond(res, call(calls.wait, "interrupt_agent", { target: taskName })); return;
        }
        respond(res, call(calls.wait, "wait_agent", {}));
        if (sage) check(integrated.readJournal().bindings.length === 0, "binding_existed_before_first_tool");
        if (retargetedRun) {
          integrated.retargetFixtureRun();
          check(integrated.readLogbook().tasks[0].branch === "codex/t1-retargeted", "fixture_task_not_retargeted");
        }
        if (endedRun) {
          integrated.endFixtureRun();
          check(integrated.readLogbook().runs[0].status === "done", "fixture_run_not_ended");
        }
        respond(childResponse, readonlyPatch ? { type: "custom_tool_call", name: "apply_patch",
          ...(childPatchTool.namespace ? { namespace: childPatchTool.namespace } : {}), call_id: calls.childControl,
          input: "*** Begin Patch\n*** Add File: readonly-lead-probe.txt\n+fixed probe\n*** End Patch" } : sage && !noTool ? { type: "function_call", name: "list_mcp_resources", call_id: calls.childControl, arguments: "{}" } : nested ? call(calls.childSpawn, "spawn_agent", {task_name: "probe_grandchild", message: GRAND_PROMPT, fork_turns: "none"}) : message(correctReport ? "STATUS done" : CHILD_MARKER));
        childResponseSent = true;
      } else if (rootRequests === 4) {
        const result = info.outputs[calls.wait];
        check(result?.timed_out === false && result.message === "Wait completed.", "native_wait_did_not_observe_mailbox_activity");
        nativeWait = true;
        print({ type: "native_tool_result", tool: "wait_agent", timed_out: false, message: result.message });
        respond(res, call(calls.completed, "list_agents", { path_prefix: taskName }));
      } else if (rootRequests === 5) {
        const agent = childEntry(info.outputs[calls.completed]);
        check(agent.agent_status?.completed === CHILD_MARKER, "native_child_completion_marker_mismatch");
        nativeCompleted = true;
        if (missedStop) {
          const recovered = integrated.readJournal().completions?.length ?? 0;
          print({ type: "missed_stop_first_completion", nativeCompleted: true, recoveredAssignments: recovered });
          check(recovered === 1, "missed_stop_first_assignment_not_recovered");
        }
        print({ type: "native_tool_result", tool: "list_agents", phase: "completed", agent_name: taskName, agent_status: { completed: CHILD_MARKER } });
        if (nestedReport) { nestedFlow.chief(0, info, res, CHILD_MARKER); return; }
        if (reportProbe || createRun || sageFollowup) {
          check(info.reportTools.length === 1, "report_tool_missing");
          respond(res, { type: "function_call", ...info.reportTools[0], call_id: calls.report, arguments: JSON.stringify({ name: "probe_child" }) });
        }
        else if (unpreparedFollowup) respond(res, call(calls.followup, "followup_task", { target: childThread, message: FOLLOWUP_PROMPT }));
        else if (followUp) respond(res, call(calls.followup, "followup_task", { target: taskName, message: FOLLOWUP_PROMPT }));
        else respond(res, message(MARKER));
      } else if (rootRequests === 6 && unpreparedFollowup) {
        check(JSON.stringify(info.outputs[calls.followup]).includes("Sage could not verify this tool call."), "unprepared_followup_denial_missing");
        respond(res, call(calls.followupDone, "list_agents", { path_prefix: taskName }));
      } else if (rootRequests === 7 && unpreparedFollowup) {
        check(childEntry(info.outputs[calls.followupDone]).agent_status?.completed === CHILD_MARKER, "unprepared_followup_restarted_child");
        unpreparedFollowupVerified = true;
        respond(res, message(MARKER));
      } else if (rootRequests === 6 && createRun) {
        reportReceipt = info.outputs[calls.report];
        check(reportReceipt?.decision === "report-ready" && reportReceipt.task === createdTask.id && reportReceipt.run === createdRun.id
          && reportReceipt.child === childThread && reportReceipt.reportHash === createHash("sha256").update(CHILD_MARKER).digest("hex"), "created_run_report_mismatch");
        check(info.recordTools.length === 1, "report_record_tool_missing");
        respond(res, { type: "function_call", ...info.recordTools[0], call_id: calls.record,
          arguments: JSON.stringify({ name: "probe_child", reportHash: reportReceipt.reportHash }) });
      } else if (rootRequests === 7 && createRun) {
        const recorded = info.outputs[calls.record];
        check(recorded?.decision === "report-recorded" && recorded.assignment === reportReceipt.assignment
          && recorded.reportHash === reportReceipt.reportHash && info.finishTools.length === 1, "created_run_record_mismatch");
        respond(res, { type: "function_call", ...info.finishTools[0], call_id: calls.finish,
          arguments: JSON.stringify({ assignment: reportReceipt.assignment, reportHash: reportReceipt.reportHash }) });
      } else if (rootRequests === 8 && createRun) {
        const finished = info.outputs[calls.finish];
        check(finished?.decision === "run-finished" && finished.run === createdRun.id && finished.status === "done", "created_run_finish_mismatch");
        respond(res, { type: "function_call", ...info.createRunTools[0], call_id: calls.createdRunAfterFinish, arguments: JSON.stringify(runRequest) });
      } else if (rootRequests === 9 && createRun) {
        const retry = info.outputs[calls.createdRunAfterFinish], logbook = integrated.readLogbook(), journal = integrated.readJournal();
        check(retry?.decision === "already-created" && JSON.stringify(retry.run) === JSON.stringify(createdRun)
          && logbook.runs.length === 1 && logbook.runs[0].status === "done" && logbook.runs[0].ended
          && integrated.readRunReport() === CHILD_MARKER && logbook.tasks[0].state === (taskLifecycle ? "building" : "framed")
          && logbook.ledger.length === 0 && logbook.gates.length === 0 && journal.completions.length === 1
          && journal.reservations[0].assignment.task === createdTask.id && journal.reservations[0].assignment.run === createdRun.id,
          "created_run_completion_mismatch");
        finishedCreatedRun = true;
        print({ type: "created_run_completion_evidence", createdTasks: 1, createdRuns: 1, completedRuns: 1,
          recordedReports: journal.reports.length, retryDidNotReopenRun: true, preseededTasks: 0, preseededRuns: 0,
          taskStillFramed: !taskLifecycle, acceptedVerdicts: 0, simulatedModel: true });
        if (taskLifecycle) respond(res, { type: "function_call", ...info.updateTaskTools[0], call_id: calls.review,
          arguments: JSON.stringify(taskChange(3, buildingTask.version, { state: "reviewing" })) });
        else respond(res, message(MARKER));
      } else if (rootRequests === 10 && taskLifecycle) {
        reviewingTask = info.outputs[calls.review];
        check(reviewingTask?.decision === "task-updated" && reviewingTask.task.state === "reviewing", "reviewing_task_missing");
        respond(res, { type: "function_call", ...info.updateTaskTools[0], call_id: calls.verify,
          arguments: JSON.stringify(taskChange(4, reviewingTask.version, { state: "verifying" })) });
      } else if (rootRequests === 11 && taskLifecycle) {
        verifyingTask = info.outputs[calls.verify];
        check(verifyingTask?.decision === "task-updated" && verifyingTask.task.state === "verifying", "verifying_task_missing");
        respond(res, { type: "function_call", ...info.updateTaskTools[0], call_id: calls.verifyWithoutReviews,
          arguments: JSON.stringify(taskChange(5, verifyingTask.version, { state: "verified" })) });
      } else if (rootRequests === 12 && taskLifecycle) {
        const refusal = info.outputs[calls.verifyWithoutReviews], logbook = integrated.readLogbook();
        check(typeof refusal === "string" && refusal.includes("Sage could not update this task"), "premature_verification_not_refused");
        check(logbook.tasks.length === 1 && logbook.tasks[0].state === "verifying" && logbook.runs.length === 1
          && logbook.runs[0].status === "done" && logbook.ledger.length === 0 && logbook.decisions.length === 5
          && logbook.decisions.filter(row => row.decision.startsWith("state ")).length === 4, "task_transition_logbook_mismatch");
        taskTransitionsVerified = true;
        print({ type: "task_transition_evidence", states: ["framed", "briefed", "building", "reviewing", "verifying"],
          recordedTransitions: 4, retryCreatedDuplicate: false, prematureVerificationRefused: true,
          completedRuns: 1, recordedVerdicts: 0, simulatedModel: true });
        respond(res, message(MARKER));
      } else if (rootRequests === 6 && reportProbe) {
        const receipt = info.outputs[calls.report];
        check(receipt?.decision === "report-ready" && receipt.task === "T1" && receipt.run === "R1"
          && receipt.child === childThread && receipt.report?.STATUS === "done" && receipt.report?.RESULT === "CLEAN"
          && receipt.reportHash === createHash("sha256").update(CHILD_MARKER).digest("hex"), "invalid_report_receipt");
        const saved = integrated.readJournal();
        check(receipt.assignment === saved.bindings[0]?.assignment && receipt.turn === saved.bindings[0]?.turn, "report_assignment_mismatch");
        print({type:"report_evidence",exactAssignment:true,completedTurn:true,completeFields:true,claimsVerified:false,simulatedModel:true});
        reportReceipt = receipt;
        check(info.recordTools.length === 1, "report_record_tool_missing");
        respond(res, { type: "function_call", ...info.recordTools[0], call_id: calls.record,
          arguments: JSON.stringify({ name: "probe_child", reportHash: receipt.reportHash }) });
      } else if (rootRequests === 7 && reportProbe) {
        const receipt = info.outputs[calls.record];
        check(receipt?.decision === "report-recorded" && receipt.reportHash === reportReceipt.reportHash
          && receipt.assignment === reportReceipt.assignment, "report_record_receipt_mismatch");
        check(info.recordTools.length === 1, "report_record_tool_missing");
        respond(res, { type: "function_call", ...info.recordTools[0], call_id: calls.recordRetry,
          arguments: JSON.stringify({ name: "probe_child", reportHash: reportReceipt.reportHash }) });
      } else if (rootRequests === 8 && reportProbe) {
        const receipt = info.outputs[calls.recordRetry];
        const saved = integrated.readJournal();
        check(receipt?.decision === "already-recorded" && receipt.reportHash === reportReceipt.reportHash
          && receipt.assignment === reportReceipt.assignment && saved.reports?.length === 1
          && saved.reports[0].reportHash === receipt.reportHash && saved.reports[0].text === CHILD_MARKER, "report_retry_receipt_mismatch");
        check(info.reportTools.length === 1, "report_tool_missing");
        respond(res, { type: "function_call", ...info.reportTools[0], call_id: calls.reread, arguments: JSON.stringify({ name: "probe_child" }) });
      } else if (rootRequests === 9 && reportProbe) {
        check(JSON.stringify(info.outputs[calls.reread]) === JSON.stringify(reportReceipt), "recorded_report_read_changed");
        print({type:"report_receipt_evidence",recordedReports:1,retryCreatedDuplicate:false,readBackMatches:true,claimsVerified:false,simulatedModel:true});
        check(info.inspectTools.length === 1, "saved_report_read_tool_missing");
        respond(res, { type: "function_call", ...info.inspectTools[0], call_id: calls.inspect,
          arguments: JSON.stringify({ assignment: reportReceipt.assignment, reportHash: reportReceipt.reportHash }) });
      } else if (rootRequests === 10 && reportProbe) {
        const report = info.outputs[calls.inspect];
        check(report?.decision === "recorded-report" && report.text === CHILD_MARKER && report.role === "code-reviewer"
          && report.assignment === reportReceipt.assignment && report.reportHash === reportReceipt.reportHash
          && report.child === childThread && report.issuer === rootThread
          && JSON.stringify(report.review) === JSON.stringify(integrated.reviewTarget), "saved_report_read_mismatch");
        check(JSON.stringify(integrated.readLogbook()) === JSON.stringify(initialLogbook), "saved_report_read_changed_logbook");
        print({type:"chief_report_read_evidence",exactSavedText:true,provenanceMatches:true,reviewTargetMatches:true,
          logbookUnchanged:true,simulatedModel:true});
        check(info.finishTools.length === 1, "finish_run_tool_missing");
        respond(res, { type: "function_call", ...info.finishTools[0], call_id: calls.finish,
          arguments: JSON.stringify({ assignment: reportReceipt.assignment, reportHash: reportReceipt.reportHash }) });
      } else if (rootRequests === 11 && reportProbe) {
        finishedRun = info.outputs[calls.finish];
        const logbook = integrated.readLogbook();
        check(finishedRun?.decision === "run-finished" && finishedRun.task === "T1" && finishedRun.run === "R1"
          && finishedRun.status === "done" && logbook.runs.length === 1 && logbook.runs[0].status === "done"
          && logbook.runs[0].report === finishedRun.report && integrated.readRunReport() === CHILD_MARKER, "run_finish_mismatch");
        check(["tasks", "ledger", "findings", "gates", "decisions"].every(key =>
          JSON.stringify(logbook[key]) === JSON.stringify(initialLogbook[key])), "report_changed_task_or_gates");
        check(info.finishTools.length === 1, "finish_run_tool_missing");
        respond(res, { type: "function_call", ...info.finishTools[0], call_id: calls.finishRetry,
          arguments: JSON.stringify({ assignment: reportReceipt.assignment, reportHash: reportReceipt.reportHash }) });
      } else if (rootRequests === 12 && reportProbe) {
        check(JSON.stringify(info.outputs[calls.finishRetry]) === JSON.stringify({ ...finishedRun, decision: "already-finished" })
          && integrated.readLogbook().runs[0].ended === finishedRun.ended, "run_retry_changed_result");
        print({type:"run_report_evidence",savedRunFinished:true,reportMatches:true,retryPreservesResult:true,taskAndGatesUnchanged:true,claimsVerified:false,simulatedModel:true});
        check(info.acceptTools.length === 1, "review_accept_tool_missing");
        respond(res, { type: "function_call", ...info.acceptTools[0], call_id: calls.accept,
          arguments: JSON.stringify({ assignment: reportReceipt.assignment, reportHash: reportReceipt.reportHash }) });
      } else if (rootRequests === 13 && reportProbe) {
        acceptedReview = info.outputs[calls.accept];
        const logbook = integrated.readLogbook(), row = logbook.ledger[0];
        check(acceptedReview?.decision === "review-accepted" && acceptedReview.kind === "review-clean"
          && acceptedReview.sha === integrated.reviewTarget.sha && acceptedReview.task === "T1" && acceptedReview.run === "R1"
          && acceptedReview.cycle === 1 && logbook.ledger.length === 1 && row.run === "R1" && row.cycle === "1"
          && row.sha === integrated.reviewTarget.sha && row.kind === "review-clean", "review_acceptance_mismatch");
        check(["tasks", "findings", "gates", "decisions"].every(key =>
          JSON.stringify(logbook[key]) === JSON.stringify(initialLogbook[key])) && !integrated.mergeReady(), "review_approved_task_or_merge");
        check(info.acceptTools.length === 1, "review_accept_tool_missing");
        respond(res, { type: "function_call", ...info.acceptTools[0], call_id: calls.acceptRetry,
          arguments: JSON.stringify({ assignment: reportReceipt.assignment, reportHash: reportReceipt.reportHash }) });
      } else if (rootRequests === 14 && reportProbe) {
        check(JSON.stringify(info.outputs[calls.acceptRetry]) === JSON.stringify({ ...acceptedReview, decision: "already-accepted" })
          && integrated.readLogbook().ledger.length === 1 && !integrated.mergeReady(), "review_retry_changed_result");
        print({type:"review_acceptance_evidence",recordedVerdicts:1,actualBranchHead:true,retryCreatedDuplicate:false,
          taskAndGatesUnchanged:true,mergeReady:false,realReviewVerified:false,simulatedModel:true});
        respond(res, message(MARKER));
      } else if (rootRequests === 6) {
        check(info.outputs[calls.followup] !== undefined, "followup_result_missing");
        check(info.outputs[calls.followup] === "", "unexpected_followup_result");
        await followupReady;
        if (fixtureFailure) { reject(res); return; }
        respond(res, call(calls.followupWait, "wait_agent", {}));
        respond(followupResponse, message(FOLLOWUP_MARKER));
      } else if (rootRequests === 7) {
        check(typeof info.outputs[calls.followupWait]?.timed_out === "boolean", "followup_wait_result_missing");
        // A completion delivered before this wait can leave no new mailbox event.
        // The next native status read proves completion in either case.
        respond(res, call(calls.followupDone, "list_agents", { path_prefix: taskName }));
      } else if (rootRequests === 8) {
        check(childEntry(info.outputs[calls.followupDone]).agent_status?.completed === FOLLOWUP_MARKER, "followup_completion_mismatch");
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
    const args = ["exec", "--strict-config", "--skip-git-repo-check", "-C", workspace, "-s", "read-only", "--json"];
    const config = {
      model_provider: "sage_native_lifecycle",
      model: "sage-native-parent",
      model_catalog_json: catalogPath,
      ...(childCompaction || followupRecovery ? { model_auto_compact_token_limit: 100000, compact_prompt: "SAGE_CHILD_COMPACT_REQUEST" } : {}),
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
    let unexpectedItems = 0, refusedTaskUpdates = 0;
    let stderrBytes = 0;
    let stderrText = "";
    const eventTypes = new Set(["thread.started", "turn.started", "item.started", "item.updated", "item.completed", "turn.completed", "turn.failed", "error"]);
    const acceptLine = (line) => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { malformedEvents++; return; }
      const itemType = event.type === "item.completed" ? event.item?.type : undefined;
      const itemDiagnostic = itemType && !["agent_message", "reasoning"].includes(itemType)
        ? diagnostic(JSON.stringify({ type: itemType, level: event.item.level, message: event.item.message, text: event.item.text, status: event.item.status, server: event.item.server, tool: event.item.tool }))
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
      } else if (sage && event.type === "item.completed" && event.item?.type === "mcp_tool_call" && event.item.status === "completed") {
        // The exact preparation receipt and final journal assertions verify this visible tool call.
      } else if (taskLifecycle && event.type === "item.completed" && event.item?.type === "mcp_tool_call"
        && event.item.status === "failed" && event.item.server === "sage_preparation" && event.item.tool === "sage_update_task"
        && rootRequests === 11 && JSON.stringify(event.item.arguments) === JSON.stringify(taskChange(5, verifyingTask.version, { state: "verified" }))) {
        refusedTaskUpdates++;
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
    child.stdin.end(sageOff ? "sage mode off\n" : sage ? "sage mode\n" : `Run the fixed one-child native lifecycle probe. Finish with exactly ${MARKER}. Do not use shell tools.\n`);
    print({ type: "event", event: "baseline_started" });
    const result = await waitNative(child, { deadlineMs, onTimeout: () => failFixture("native_root_deadline") });
    acceptLine(buffer);
    if (pending.size) failFixture("native_root_exited_with_held_response");
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    const noChild = denySpawn || (outage && denied);
    const routeVerified = noChild
      ? rootRequests === 2 && childRequests === 0 && denied
      : (childMessage ? rootRequests >= 5 : rootRequests === (sageFollowup ? 16 : unpreparedFollowup ? 7 : taskLifecycle ? 12 : createRun ? 9 : followUp ? 8 : nestedReport ? 12 : reportProbe ? 14 : 5)) && childRequests === (repeatChildRecovery ? 10 : childRecovery ? 6 : childSandbox ? 3 : childMessage ? 4 : sageFollowup ? (followupRecovery ? 6 : resumedFailure ? 7 : followupNoTool ? 3 : 4) : nestedReport ? 8 : nested ? 4 : blockStop || correctReport || escapeReport || followUp || (sage && !noTool) ? 2 : 1) && grandchildRequests === (nestedReport ? 2 : nested ? 1 : 0) && rootThread !== childThread
        && childTaskSeen && childResponseSent && nativeRunning && (interruption ? interruptionVerified : nativeWait && nativeCompleted);
    const verified = (!followupRecovery || followupRecoveryVerified) && (!childRecovery || recoveryTargetVerified) && (!childCompaction || (childCompactionObserved && childCompactionReady)) && result.code === 0 && !fixtureFailure && routeVerified && (!readonlyPatch || readonlyPatchVerified) && (!endedRun || endedRunVerified) && (!retargetedRun || retargetedRunVerified)
      && (!childSandbox || childSandboxVerified) && (!childMessage || childMessageVerified) && (!resumedFailure || resumedFailureVerified) && (!unpreparedFollowup || unpreparedFollowupVerified) && (!sageFollowup || sageFollowupVerified)
      && exactMessages === 1 && otherMessages === 0 && completedTurns === 1 && failedTurns === 0
      && unexpectedItems === 0 && refusedTaskUpdates === (taskLifecycle ? 1 : 0) && malformedEvents === 0 && rejectedRequests === 0;
    print({ type: "result", ...result, responseRequests, rootRequests, ...(failedSpawn ? { rejectedDispatchRootRequests: 3 } : {}), childRequests, childTaskSeen, childResponseSent,
      nativeRunning, nativeWait, nativeCompleted, exactMessages, otherMessages, completedTurns, failedTurns,
      unexpectedItems, refusedTaskUpdates, malformedEvents, rejectedRequests, stderrBytes, fixtureFailure, verified,
      ...(!verified ? { diagnostic: diagnostic(stderrText) } : {}) });
    if (!verified) process.exitCode = 1;
    if (childCompaction && childCompactionObserved && !childCompactionReady && result.code !== 0) throw Error("child_compaction_not_ready");
    if (sage || sageOff) assert(chiefContextVerified, "chief_context_not_observed");
    if (createTask) assert(createdTaskVerified, "task_creation_not_observed");
    if (createRun) assert(createdRunVerified && finishedCreatedRun, "run_creation_not_observed");
    if (taskLifecycle) assert(taskTransitionsVerified, "task_transitions_not_observed");
    if (sageOff) {
      const saved = integrated.readJournal();
      assert.equal(saved.modes.at(-1)?.sage, false);
      for (const key of ["preparations", "reservations", "bindings", "completions", "reports"])
        assert.equal(saved[key]?.length ?? 0, 0);
      assert.deepEqual(integrated.readLogbook(), initialLogbook);
      const receipt = JSON.parse(readFileSync(join(root, "unmanaged-stop-receipt.json"), "utf8"));
      assert.equal(receipt.session, rootThread); assert.equal(receipt.child, childThread);
      assert.equal(receipt.decision, "unmanaged");
      const stops = readdirSync(join(root, "events")).map(name => JSON.parse(readFileSync(join(root, "events", name), "utf8")))
        .filter(row => row.hook_event_name === "SubagentStop");
      assert.equal(stops.length, 1); assert.equal(receipt.turn, stops[0].turn_id);
      print({ type: "inactive_child_evidence", nativeCompletionVerified: nativeCompleted, exactStopIdentity: true,
        reportCorrectionRequired: false, sageCapacityUsed: false, logbookUnchanged: true, simulatedModel: true });
    }
    if (noTool) {
      const observed = readdirSync(join(root, "events")).map(name => JSON.parse(readFileSync(join(root, "events", name), "utf8")));
      print({ type: "no_tool_callback_evidence", callbacks: observed.filter(row => ["SubagentStart", "SubagentStop"].includes(row.hook_event_name))
        .map(row => ({ event: row.hook_event_name, fields: row.inputKeys, childTranscriptFields: row.childTranscriptFields })),
        bindings: integrated.readJournal().bindings.length, completions: integrated.readJournal().completions?.length ?? 0 });
    }
    if (sage && !outage) {
      const saved = integrated.readJournal();
      assert.equal(saved.sessions.length, 1); assert.equal(saved.modes.at(-1)?.sage, true);
      const count = nestedReport || sageFollowup ? 2 : 1;
      assert.equal(saved.preparations.length, count + (failedSpawn || resumedFailure ? 1 : 0)); assert.equal(saved.reservations.length, count + (failedSpawn || resumedFailure ? 1 : 0));
      assert.equal(saved.bindings.length, count); assert.equal(saved.completions?.length, count);
      assert.equal(saved.bindings[0].child, childThread);
      for (const bound of saved.bindings) {
        const terminal = saved.completions.find(row => row.assignment === bound.assignment);
        if (interruption) {
          const { outcome, evidenceHash, ...identity } = terminal;
          assert.equal(outcome, "interrupted"); assert.match(evidenceHash, /^[a-f0-9]{64}$/); assert.deepEqual(identity, bound);
        } else assert.deepEqual(terminal, bound);
      }
      if (reportProbe || nestedReport) {
        const proofs = readObservations(join(root, "observations", rootThread))
          .filter(row => row.kind === "report-recovery-verified");
        assert.equal(proofs.length, saved.reports.length);
        for (const report of saved.reports) {
          const own = proofs.filter(row => row.assignment === report.binding.assignment);
          assert.equal(own.length, 1); assert.equal(own[0].child, report.binding.child);
          assert.equal(own[0].turn, report.binding.turn); assert.match(own[0].receiptHash, /^[a-f0-9]{64}$/);
        }
        print({ type: "saved_report_recovery_evidence", receipts: saved.reports.length,
          durableProofs: proofs.length, exactAssignmentIdentity: true, simulatedModel: true });
      }
      print({ type: "integrated_sage_evidence", owners: 1, preparations: saved.preparations.length, reservations: saved.reservations.length, bindings: count, completions: count,
        firstToolBinding: !noTool, stopBinding: noTool, simulatedModel: true, fullPolicyVerified: false, realModelConsumptionVerified: false });
    }
    const rows=readdirSync(join(root,"events")).map(name=>JSON.parse(readFileSync(join(root,"events",name),"utf8")));
    const start=rows.filter(row=>row.hook_event_name==="SubagentStart");
    const stop=rows.filter(row=>row.hook_event_name==="SubagentStop");
    const before=rows.filter(row=>row.hook_event_name==="PreToolUse"&&row.tool_name==="collaborationspawn_agent");
    const after=rows.filter(row=>row.hook_event_name==="PostToolUse"&&row.tool_name==="collaborationspawn_agent");
    assert.equal(before.length,nested || failedSpawn || resumedFailure ? 2 : 1);
    assert.equal(start.length, noChild ? 0 : nested ? 2 : 1);
    assert.equal(stop.length, noChild || interruption ? 0 : repeatChildRecovery ? 4 : childRecovery ? 3 : blockStop || correctReport || escapeReport || followUp || sageFollowup || nested ? 2 : 1);
    if (childRecovery) {
      assert.equal(childRecoveryGatePhase, 5);
      assert.equal(recoveryTargetVerified, true);
      assert.deepEqual(stop.map(row => row.stopHookActive).sort(), repeatChildRecovery ? [false, true, true, true] : [false, true, true]);
      assert.equal(childCompactionRequests, repeatChildRecovery ? 2 : 1);
      assert.equal(new Set(stop.map(row => row.turn_id)).size, 1);
    }
    if (escapeReport) {
      assert.equal(prematureCompletions, 0);
      assert.deepEqual(stop.map(row => row.stopHookActive).sort(), [false, true]);
      assert.equal(new Set(stop.map(row => row.turn_id)).size, 1);
      assert(stop.every(row => row.lastMessageHash === createHash("sha256").update(CHILD_MARKER).digest("hex")));
      const state = integrated.readJournal(), logbook = integrated.readLogbook();
      assert.equal(state.reports?.length ?? 0, 0); assert.equal(logbook.ledger.length, 0);
      assert.equal(logbook.runs[0].status, "running");
      print({ type: "report_escape_evidence", correctionStops: 2, sameNativeTurn: true,
        repeatedInvalidReport: true, completions: state.completions.length, savedReports: 0, verdicts: 0,
        runUnchanged: true, simulatedModel: true });
    }
    if (correctReport) {
      assert.equal(prematureCompletions, 0);
      assert.deepEqual(stop.map(row => row.stopHookActive).sort(), [false, true]);
      assert.equal(new Set(stop.map(row => row.turn_id)).size, 1);
      print({ type: "report_correction_evidence", correctionStops: 2, sameNativeTurn: true,
        firstReportIncomplete: stop.some(row => row.lastMessageHash === createHash("sha256").update("STATUS done").digest("hex")),
        finalReportRecorded: integrated.readJournal().reports[0]?.text === CHILD_MARKER, simulatedModel: true });
      assert(stop.some(row => row.lastMessageHash === createHash("sha256").update("STATUS done").digest("hex")));
    }
    if (followUp) {
      const captured = JSON.parse(readFileSync(join(root, 'followup-dispatch.json'), 'utf8'));
      assert.equal(captured.session, rootThread); assert.equal(captured.call, calls.followup);
      const receipt = readNativeFollowup(captured.transcript, { sessionsDir: join(codexHome, 'sessions') }, {
        session: rootThread, actor: rootThread, parent: null, path: '/root', turn: captured.turn,
        call: calls.followup, target: taskName, taskHash: createHash('sha256').update(FOLLOWUP_PROMPT).digest('hex'),
      });
      assert(receipt); assert.equal(receipt.call, calls.followup);
      print({ type: 'followup_dispatch_evidence', exactNativeCall: true, exactTaskHash: true,
        acceptedResult: true, recipientDeliveryCheckedSeparately: true, simulatedModel: true });
      assert.equal(new Set(stop.map(row => row.turn_id)).size, 2);
      assert(stop.every(row => row.agent_id === start[0].agent_id && row.session_id === start[0].session_id));
      assert(stop.some(row => row.turn_id === start[0].turn_id));
    }
    assert.equal(after.length,noChild ? 0 : nested ? 2 : 1);
    const expectedTasks = new Set([CHILD_PROMPT, ...(followUp || sageFollowup ? [FOLLOWUP_PROMPT] : []), ...(nested ? [GRAND_PROMPT] : [])].map(text => createHash("sha256").update(text).digest("hex")));
    const matchedTasks = new Set();
    for (const stopped of stop) {
      assert.equal(stopped.captureError, undefined);
      const matched = stopped.assignments.filter(row => row.turn === stopped.turn_id);
      assert.equal(matched.length, 1, "each stopped turn must contain one fixture assignment");
      const started = start.find(row => row.agent_id === stopped.agent_id);
      assert(started); assert.equal(started.captureError, undefined);
      const grand = nested && stopped.agent_id === grandchildThread;
      const author = grand ? taskName : "/root";
      const path = grand ? `${taskName}/probe_grandchild` : taskName;
      assert.equal(started.metadata.parent_thread_id, grand ? childThread : rootThread);
      assert.equal(matched[0].author, author);
      assert.equal(matched[0].recipient, path);
      assert(expectedTasks.has(matched[0].taskHash));
      const transcript = JSON.parse(readFileSync(join(root, `child-path-${stopped.agent_id}.json`), "utf8"));
      const bound = readAssignmentTurn(transcript, { sessionsDir: join(codexHome, "sessions") }, {
        session: stopped.session_id, child: stopped.agent_id, parent: started.metadata.parent_thread_id,
        path, author, turn: stopped.turn_id, taskHash: matched[0].taskHash,
      });
      assert.equal(bound.message, matched[0].message);
      matchedTasks.add(bound.taskHash);
    }
    if (childMessage) {
      assert(childMessageVerified && chiefReceivedMessage, "chief_did_not_receive_exact_progress_message");
      const sent = rows.filter(row => row.hook_event_name === "PostToolUse" && row.tool_name === "collaborationsend_message");
      assert.equal(sent.length, 1);
      print({ type: "child_message_evidence", peerDenied: true, chiefMessageAccepted: true, exactMessageReceived: true, nativeChild: true, simulatedModel: true });
    }
    if (interruption) {
      const state = integrated.readJournal(), bound = state.bindings[0];
      const transcript = JSON.parse(readFileSync(join(root, `child-path-${childThread}.json`), "utf8"));
      const receipt = readNativeInterruption(transcript, { sessionsDir: join(codexHome, "sessions") }, {
        session: rootThread, child: childThread, parent: rootThread, path: taskName, author: "/root", turn: bound.turn,
        taskHash: createHash("sha256").update(CHILD_PROMPT).digest("hex"),
      });
      assert.equal(receipt.evidenceHash, state.completions[0].evidenceHash);
      print({ type: "interruption_recovery_evidence", nativeInterrupted: true, exactTurn: true,
        terminalOutcomes: 1, savedReports: 0, runStillOpen: true, stopCallbacks: 0, simulatedModel: true });
    } else if (!noChild) assert.equal(matchedTasks.size, expectedTasks.size);
    for (const started of start) {
      const result = after.find(row => row.resultTaskName === started.metadata.agent_path);
      const request = result && before.find(row => row.tool_use_id === result.tool_use_id);
      assert(result); assert(request);
      assert.equal(started.metadata.id, started.agent_id);
      assert.equal(started.metadata.session_id, request.session_id);
      if (!interruption) assert(stop.some(row => row.agent_id === started.agent_id));
    }
    if (missedStop) {
      const hooks = JSON.parse(readFileSync(join(codexHome, "hooks.json"), "utf8")).hooks.SubagentStop;
      assert(hooks.length > 0 && hooks.every(group => group.hooks.every(hook => hook.type !== "mcp_tool")));
      const observations = readObservations(join(root, "observations", rootThread));
      assert.equal(observations.filter(row => row.kind === "child-stop").length, 0);
      assert.equal(integrated.readJournal().completions.length, 2);
      print({ type: "missed_stop_evidence", sageStopHooks: 0, storedStopCallbacks: 0,
        nativeCompletions: 2, recoveredAssignments: 2, simulatedModel: true });
    }
    if (resumedFailure) {
      assert.equal(resumedFailureVerified, true);
      print({ type: "resumed_lead_failure_evidence", sameNativeLead: true, assignments: 2,
        failedChildDispatches: 1, extraChildren: 0, preservedCompletions: 2, simulatedModel: true });
    }
    if (childSandbox) {
      const commands = rows.filter(row => row.hook_event_name === "PreToolUse" && row.tool_name === "Bash");
      assert.equal(commands.length, 1);
      assert.equal(commands[0].fixedSandboxCommandMatched, true);
      assert.equal(rows.filter(row => row.hook_event_name === "PostToolUse" && row.tool_name === "Bash").length, 0);
      assert.equal(childSandboxVerified, true);
      print({type: "child_sandbox_evidence", nativeChild: true, sageDenialReceived: true,
        preToolEvents: 1, postToolEvents: 0, simulatedModel: true});
    }
    if (sageFollowup) {
      const saved = integrated.readJournal();
      assert.equal(new Set(saved.bindings.map(row => row.child)).size, 1);
      assert.equal(new Set(saved.bindings.map(row => row.turn)).size, 2);
      assert.equal(saved.reservations[1].continuation, saved.bindings[0].assignment);
      assert.equal(saved.reports.length, 2);
      assert.deepEqual(saved.reports.map(report => report.run), ["R1", followupRun.run.id]);
      assert.equal(integrated.readLogbook().runs.find(run => run.id === "R1").status, "done");
      if (followupNoTool) {
        const turn = saved.bindings[1].turn;
        assert.equal(rows.filter(row => row.hook_event_name === "PreToolUse" && row.turn_id === turn).length, 0);
        const stops = readObservations(join(root, "observations", rootThread)).filter(row => row.kind === "child-stop" && row.turn === turn);
        assert.equal(stops.length, unobservedFollowup ? 0 : 1);
        if (!unobservedFollowup) assert.equal(stops[0].child, childThread);
        print({ type: "followup_no_tool_evidence", childToolCalls: 0, stopBoundSecondAssignment: !unobservedFollowup,
          parentRecoveredDelivery: unobservedFollowup,
          sameNativeChild: true, completedAssignments: 2, simulatedModel: true });
      }
      print({ type: "sage_followup_evidence", sameNativeChild: true, assignments: 2, turns: 2, completions: 2,
        secondReportRecorded: true, firstReportPreserved: true, firstRunFinished: true, simulatedModel: true });
    }
    if (unpreparedFollowup) {
      assert.equal(unpreparedFollowupVerified, true);
      assert.equal(rows.filter(event => event.hook_event_name === "PostToolUse" && event.tool_name === "collaborationfollowup_task").length, 0);
      const saved = integrated.readJournal();
      assert.equal(saved.preparations.length, 1); assert.equal(saved.reservations.length, 1);
      assert.equal(saved.bindings.length, 1); assert.equal(saved.completions.length, 1);
      print({ type: "unprepared_followup_evidence", denied: true, noSecondChildTurn: true, noNewReservation: true, simulatedModel: true });
    }
    if (retargetedRun) {
      assert.equal(retargetedRunVerified, true);
      assert.equal(rows.filter(event => event.hook_event_name === "PostToolUse" && event.tool_name === "list_mcp_resources").length, 0);
      assert.equal(integrated.readLogbook().runs[0].status, "running");
      assert.equal(integrated.readLogbook().tasks[0].branch, "codex/t1-retargeted");
      assert.equal(integrated.readJournal().preparations[0].runTarget.taskBranch, "");
      print({ type: "retargeted_run_evidence", denied: true, toolExecuted: false, originalTargetPreserved: true, completionRecorded: true, simulatedModel: true });
    }
    if (endedRun) {
      assert.equal(endedRunVerified, true);
      assert.equal(rows.filter(event => event.hook_event_name === "PostToolUse" && event.tool_name === "list_mcp_resources").length, 0);
      assert.equal(integrated.readLogbook().runs[0].status, "done");
      print({ type: "ended_run_evidence", denied: true, toolExecuted: false, completionRecorded: true, simulatedModel: true });
    }
    if (readonlyPatch) {
      assert.equal(readonlyPatchVerified, true);
      assert.equal(existsSync(join(workspace, "readonly-lead-probe.txt")), false);
      print({ type: "readonly_role_evidence", role: "lead", deniedBeforeEvaluator: true, fileCreated: false, simulatedModel: true });
    }
    if (failedSpawn) {
      const saved = integrated.readJournal();
      assert(failedDispatchRecovered); assert.equal(saved.config.total, 1); assert.equal(saved.failures.length, 1);
      assert.equal(saved.failures[0].assignment, saved.reservations[0].assignment.id);
      assert.equal(saved.completions[0].assignment, saved.reservations[1].assignment.id);
      assert.equal(saved.reports?.length ?? 0, 0);
      print({ type: "failed_spawn_evidence", failureHookAvailable: integrated.failureHookAvailable, capacity: 1,
        reservations: 2, failedDispatches: 1, bindings: 1, completedChildren: 1, retryUsedReleasedSlot: true,
        simulatedModel: true, otherFailureKindsVerified: false });
    }
    if (blockStop) {
      check(prematureCompletions !== undefined, "stop_block_did_not_resume_child");
      print({ type: "stop_block_evidence", heldWhileContinuing: prematureCompletions === 0, simulatedModel: true });
      if (prematureCompletions !== 0) process.exitCode = 1;
    }
    if (outage) {
      const fault = integrated.readFault();
      for (const key of ["session_id", "turn_id", "tool_use_id", "tool_name"]) assert.equal(fault[key], before[0][key]);
      const saved = integrated.readJournal();
      assert.equal(saved.sessions.length, 1); assert.equal(saved.modes.at(-1)?.sage, true);
      assert.equal(saved.preparations.length, 1); assert.equal(saved.reservations.length, 0);
      assert.equal(saved.bindings.length, 0); assert.equal(saved.completions?.length ?? 0, 0);
      const failClosed = verified && denied && childRequests === 0 && start.length === 0 && after.length === 0;
      print({ type: "hook_outage_evidence", requiredServer: true, faultAtVerifiedSpawn: true,
        nativeChildStarted: start.length > 0, nativeChildCompleted: nativeCompleted, reservations: 0,
        failClosed, readyForActivation: false, simulatedModel: true });
      if (!failClosed) process.exitCode = 1;
    }
    print({type:"hook_evidence",spawnRequest:before.length,spawnResult:after.length,childStart:start.length,childStop:stop.length,exactIdentityJoin:!noChild,followupTurnVerified:followUp || sageFollowup,nestedTurnsVerified:nested,noChildStarted:noChild,simulatedModel:true,automaticSage:false,realModelConsumptionVerified:false});
  }
}

} finally {
  rmSync(root, { recursive: true, force: true });
  assert.equal(existsSync(root), false);
  process.stdout.write(JSON.stringify({ type: "cleanup", temporaryRootRemoved: true }) + "\n");
}
