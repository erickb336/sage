// Isolated native V2 transport check with simulated model responses; not a live Sage pilot.
// A wide deadlock guard ends the isolated transport without a process signal.
import http from "node:http";
import { NESTED_CALLS, createNestedReportFlow } from "./fixtures/codex-native/nested-report.mjs";
import {createHash} from "node:crypto";
import assert from "node:assert/strict";
import {existsSync,readdirSync,readFileSync} from "node:fs";
import {waitNative} from "./fixtures/codex-native/wait-native.mjs";
import {readAssignmentTurn} from "../packages/sage-codex/runtime/identity.mjs";
import {setupCapture} from "./fixtures/codex-native/setup-capture.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

assert(process.argv.slice(2).every(arg => ["--sage-create-run", "--sage-create-task", "--sage-off", "--deny-spawn", "--follow-up", "--nested", "--sage", "--sage-hook-outage", "--sage-report", "--sage-nested-report", "--sage-no-tool", "--sage-stop-block", "--sage-report-correction", "--sage-report-escape", "--sage-failed-spawn"].includes(arg)), "unknown_probe_argument");
const deadlineMs = process.env.NODE_TEST_CONTEXT && /^\d+$/.test(process.env.SAGE_PROBE_TEST_DEADLINE_MS ?? "")
  ? Number(process.env.SAGE_PROBE_TEST_DEADLINE_MS) : 120_000;
const createRun = process.argv.includes("--sage-create-run");
const createTask = createRun || process.argv.includes("--sage-create-task");
assert(!createTask || process.argv.slice(2).length === 1, "task_creation_is_a_separate_route");
const sageOff = process.argv.includes("--sage-off");
assert(!sageOff || process.argv.slice(2).length === 1, "sage_off_is_a_separate_route");
const denySpawn = process.argv.includes("--deny-spawn");
const failedSpawn = process.argv.includes("--sage-failed-spawn");
const followUp = process.argv.includes("--follow-up");
const blockStop = process.argv.includes("--sage-stop-block");
const correctReport = process.argv.includes("--sage-report-correction");
const escapeReport = process.argv.includes("--sage-report-escape");
assert([correctReport, escapeReport, blockStop].filter(Boolean).length <= 1, "incompatible_stop_routes");
const noTool = process.argv.includes("--sage-no-tool") || blockStop || correctReport || escapeReport;
const nestedReport = process.argv.includes("--sage-nested-report");
const nested = process.argv.includes("--nested") || nestedReport;
const outage = process.argv.includes("--sage-hook-outage");
const reportProbe = process.argv.includes("--sage-report") || (noTool && !escapeReport);
const sage = createTask || process.argv.includes("--sage") || outage || reportProbe || nestedReport || noTool || failedSpawn;
assert([failedSpawn, outage, process.argv.includes("--sage-report"), nestedReport, noTool].filter(Boolean).length <= 1, "incompatible_probe_routes");
assert([denySpawn, followUp, process.argv.includes("--nested"), sage].filter(Boolean).length <= 1, "incompatible_probe_routes");
let denied = false;
const MARKER = "sage-native-parent-ok";
let GRAND_MARKER = "sage-native-grandchild-ok";
let GRAND_PROMPT = `Return exactly ${GRAND_MARKER}. Do not call any tool.`;
let CHILD_MARKER = reportProbe ? ["STATUS done", "RESULT CLEAN", "EVIDENCE fixed native fixture completed", "FINDINGS none", "QUESTIONS none", "NOT VERIFIED real model", "BRANCH codex/t1-review"].join("\n") : "sage-native-child-ok";
if (sage && !reportProbe && !nestedReport && !outage && !escapeReport) CHILD_MARKER = ["STATUS done", "RESULT sage-native-child-ok", "EVIDENCE fixed simulated response", "FINDINGS none", "QUESTIONS none", "NOT VERIFIED real model", "BRANCH none"].join("\n");
let CHILD_PROMPT = `Return exactly ${CHILD_MARKER}. Do not call any tool.`;
const FOLLOWUP_MARKER = "sage-native-followup-ok";
const FOLLOWUP_PROMPT = `Return exactly ${FOLLOWUP_MARKER}. Do not call any tool.`;
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
  supported_reasoning_levels: [], shell_type: "disabled", visibility: "list",
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
  const integrated = await setupCapture({root,codexHome,workspace,env,binary,denySpawn,sage:sage||sageOff,disconnectOnSpawn:outage,review:reportProbe || nestedReport,nestedReview:nestedReport,blockStop,captureFailure:failedSpawn,emptyLogbook:createRun,deadlineMs});
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
  let followupResponse, releaseFollowupReady;
  const followupReady = new Promise(resolve => { releaseFollowupReady = resolve; });
  let childResponseSent = false;
  let nativeRunning = false;
  let nativeCompleted = false;
  let nativeWait = false;
  let childTaskSeen = false;
  let fixtureFailure;
  let releaseChildReady;
  const childReady = new Promise((resolve) => { releaseChildReady = resolve; });
  const pending = new Set();
  let createdTask, createdTaskVerified = false, createdRun, createdRunVerified = false, finishedCreatedRun = false;
  const runRequest = { request: "b1111111-2222-4333-8444-555555555555", task: "T1", role: "lead", branch: "", candidate: "" };
  const taskRequest = { request: "a1111111-2222-4333-8444-555555555555", title: "Native task creation", size: "small", risk: ["input"], add: ["ux-review"], why: "Check the fixed experience" };
  let prepared = false, reportReceipt, failedDispatchRecovered = false;
  const calls = { createRun: "probe_create_run", createRunRetry: "probe_create_run_retry", createdRunAfterFinish: "probe_created_run_after_finish", create: "probe_create", createRetry: "probe_create_retry", failureList: "probe_failure_list", prepareRetry: "probe_prepare_retry", spawnRetry: "probe_spawn_retry", inspect: "probe_inspect", accept: "probe_accept", acceptRetry: "probe_accept_retry", finish: "probe_finish", finishRetry: "probe_finish_retry", record: "probe_record", recordRetry: "probe_record_retry", reread: "probe_reread", report: "probe_report", prepare: "probe_prepare", childControl: "probe_child_control", childSpawn: "probe_child_spawn", childWait: "probe_child_wait", childList: "probe_child_list", spawn: "probe_spawn", running: "probe_running", wait: "probe_wait", completed: "probe_completed", followup: "probe_followup", followupWait: "probe_followup_wait", followupDone: "probe_followup_done" };
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
    for (const response of pending) reject(response);
  };
  const inspectRequest = (request) => {
    const outputs = {};
    const input = Array.isArray(request.input) ? request.input : [];
    for (const item of input) {
      if (item.type !== "function_call_output" || !knownCalls.has(item.call_id)) continue;
      check(!(item.call_id in outputs), "duplicate_native_tool_result");
      const output = typeof item.output === "string" ? item.output
        : Array.isArray(item.output) && item.output.length >= 1 && item.output.length <= ([calls.createRun, calls.createRunRetry, calls.createdRunAfterFinish, calls.create, calls.createRetry, calls.prepare, calls.prepareRetry, calls.report, calls.record, calls.recordRetry, calls.reread, calls.finish, calls.finishRetry, calls.accept, calls.acceptRetry, calls.inspect, ...Object.values(NESTED_CALLS)].includes(item.call_id) ? 2 : 1)
          && item.output.every(part => part.type === "input_text") ? item.output.at(-1).text : null;
      check(typeof output === "string", "unsupported_native_tool_result_encoding");
      try { outputs[item.call_id] = JSON.parse(output); } catch {
        if ((denySpawn || outage || failedSpawn) && [calls.spawn, calls.spawnRetry].includes(item.call_id)) outputs[item.call_id] = output;
        else if ([calls.followup, calls.childControl, NESTED_CALLS.control].includes(item.call_id)) outputs[item.call_id] = output;
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
    return { outputs, agentTools, childPromptSeen, followupPromptSeen, grandchildPromptSeen,
      chiefCopies: chiefParts.map(part => textValues(input).reduce((count, text) => count + text.split(part).length - 1, 0)),
      chiefOrder: chiefParts.map(part => textValues(input).join("\n").indexOf(part)),
      createRunTools: mcpTools("sage_create_run"), createTools: mcpTools("sage_create_task"), prepareTools: mcpTools("sage_prepare_task"), reportTools: mcpTools("sage_read_report"), recordTools: mcpTools("sage_record_report"), finishTools: mcpTools("sage_finish_run"), acceptTools: mcpTools("sage_accept_review"), inspectTools: mcpTools("sage_read_recorded_report") };
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
      { type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } },
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
      const info = inspectRequest(request);
      request = null; // Retain only tool results, advertised names, and a fixed-task boolean.
      responseRequests++;
      const thread = req.headers["thread-id"];
      const subagent = req.headers["x-openai-subagent"];
      check(typeof thread === "string" && thread.length > 0, "missing_native_thread_header");
      if (subagent === "collab_spawn") {
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
        if (sage && Object.hasOwn(info.outputs, calls.childControl)) {
          check(thread === childThread && childRequests === 1, "child_control_changed_identity_or_repeated"); childRequests++;
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
      if (nestedReport && rootRequests > 5) { nestedFlow.chief(rootRequests - 5, info, res, CHILD_MARKER); return; }
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
        respond(res, call(calls.wait, "wait_agent", {}));
        if (sage) check(integrated.readJournal().bindings.length === 0, "binding_existed_before_first_tool");
        respond(childResponse, sage && !noTool ? { type: "function_call", name: "list_mcp_resources", call_id: calls.childControl, arguments: "{}" } : nested ? call(calls.childSpawn, "spawn_agent", {task_name: "probe_grandchild", message: GRAND_PROMPT, fork_turns: "none"}) : message(correctReport ? "STATUS done" : CHILD_MARKER));
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
        print({ type: "native_tool_result", tool: "list_agents", phase: "completed", agent_name: taskName, agent_status: { completed: CHILD_MARKER } });
        if (nestedReport) { nestedFlow.chief(0, info, res, CHILD_MARKER); return; }
        if (reportProbe || createRun) {
          check(info.reportTools.length === 1, "report_tool_missing");
          respond(res, { type: "function_call", ...info.reportTools[0], call_id: calls.report, arguments: JSON.stringify({ name: "probe_child" }) });
        } else if (followUp) respond(res, call(calls.followup, "followup_task", { target: taskName, message: FOLLOWUP_PROMPT }));
        else respond(res, message(MARKER));
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
          && integrated.readRunReport() === CHILD_MARKER && logbook.tasks[0].state === "framed"
          && logbook.ledger.length === 0 && logbook.gates.length === 0 && journal.completions.length === 1
          && journal.reservations[0].assignment.task === createdTask.id && journal.reservations[0].assignment.run === createdRun.id,
          "created_run_completion_mismatch");
        finishedCreatedRun = true;
        print({ type: "created_run_completion_evidence", createdTasks: 1, createdRuns: 1, completedRuns: 1,
          recordedReports: journal.reports.length, retryDidNotReopenRun: true, preseededTasks: 0, preseededRuns: 0,
          taskStillFramed: true, acceptedVerdicts: 0, simulatedModel: true });
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
      cli_auth_credentials_store: "ephemeral",
      "features.hooks": true,
      "features.plugins": false,
      "features.remote_plugin": false,
      "features.apps": false,
      "features.shell_snapshot": false,
      "features.shell_tool": false,
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
      } else if (sage && event.type === "item.completed" && event.item?.type === "mcp_tool_call" && event.item.status === "completed") {
        // The exact preparation receipt and final journal assertions verify this visible tool call.
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
      : rootRequests === (createRun ? 9 : followUp ? 8 : nestedReport ? 12 : reportProbe ? 14 : 5) && childRequests === (nestedReport ? 8 : nested ? 4 : blockStop || correctReport || escapeReport || followUp || (sage && !noTool) ? 2 : 1) && grandchildRequests === (nestedReport ? 2 : nested ? 1 : 0) && rootThread !== childThread
        && childTaskSeen && childResponseSent && nativeRunning && nativeWait && nativeCompleted;
    const verified = result.code === 0 && !fixtureFailure && routeVerified
      && exactMessages === 1 && otherMessages === 0 && completedTurns === 1 && failedTurns === 0
      && unexpectedItems === 0 && malformedEvents === 0 && rejectedRequests === 0;
    print({ type: "result", ...result, responseRequests, rootRequests, ...(failedSpawn ? { rejectedDispatchRootRequests: 3 } : {}), childRequests, childTaskSeen, childResponseSent,
      nativeRunning, nativeWait, nativeCompleted, exactMessages, otherMessages, completedTurns, failedTurns,
      unexpectedItems, malformedEvents, rejectedRequests, stderrBytes, fixtureFailure, verified,
      ...(!verified ? { diagnostic: diagnostic(stderrText) } : {}) });
    if (!verified) process.exitCode = 1;
    if (sage || sageOff) assert(chiefContextVerified, "chief_context_not_observed");
    if (createTask) assert(createdTaskVerified, "task_creation_not_observed");
    if (createRun) assert(createdRunVerified && finishedCreatedRun, "run_creation_not_observed");
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
      const count = nestedReport ? 2 : 1;
      assert.equal(saved.preparations.length, count + (failedSpawn ? 1 : 0)); assert.equal(saved.reservations.length, count + (failedSpawn ? 1 : 0));
      assert.equal(saved.bindings.length, count); assert.equal(saved.completions?.length, count);
      assert.equal(saved.bindings[0].child, childThread);
      for (const bound of saved.bindings) assert.deepEqual(saved.completions.find(row => row.assignment === bound.assignment), bound);
      print({ type: "integrated_sage_evidence", owners: 1, preparations: saved.preparations.length, reservations: saved.reservations.length, bindings: count, completions: count,
        firstToolBinding: !noTool, stopBinding: noTool, simulatedModel: true, fullPolicyVerified: false, realModelConsumptionVerified: false });
    }
    const rows=readdirSync(join(root,"events")).map(name=>JSON.parse(readFileSync(join(root,"events",name),"utf8")));
    const start=rows.filter(row=>row.hook_event_name==="SubagentStart");
    const stop=rows.filter(row=>row.hook_event_name==="SubagentStop");
    const before=rows.filter(row=>row.hook_event_name==="PreToolUse"&&row.tool_name==="collaborationspawn_agent");
    const after=rows.filter(row=>row.hook_event_name==="PostToolUse"&&row.tool_name==="collaborationspawn_agent");
    assert.equal(before.length,nested || failedSpawn ? 2 : 1);
    assert.equal(start.length, noChild ? 0 : nested ? 2 : 1);
    assert.equal(stop.length, noChild ? 0 : blockStop || correctReport || escapeReport || followUp || nested ? 2 : 1);
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
      assert.equal(new Set(stop.map(row => row.turn_id)).size, 2);
      assert(stop.every(row => row.agent_id === start[0].agent_id && row.session_id === start[0].session_id));
      assert(stop.some(row => row.turn_id === start[0].turn_id));
    }
    assert.equal(after.length,noChild ? 0 : nested ? 2 : 1);
    const expectedTasks = new Set([CHILD_PROMPT, ...(followUp ? [FOLLOWUP_PROMPT] : []), ...(nested ? [GRAND_PROMPT] : [])].map(text => createHash("sha256").update(text).digest("hex")));
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
    if (!noChild) assert.equal(matchedTasks.size, expectedTasks.size);
    for (const started of start) {
      const result = after.find(row => row.resultTaskName === started.metadata.agent_path);
      const request = result && before.find(row => row.tool_use_id === result.tool_use_id);
      assert(result); assert(request);
      assert.equal(started.metadata.id, started.agent_id);
      assert.equal(started.metadata.session_id, request.session_id);
      assert(stop.some(row => row.agent_id === started.agent_id));
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
    print({type:"hook_evidence",spawnRequest:before.length,spawnResult:after.length,childStart:start.length,childStop:stop.length,exactIdentityJoin:!noChild,followupTurnVerified:followUp,nestedTurnsVerified:nested,noChildStarted:noChild,simulatedModel:true,automaticSage:false,realModelConsumptionVerified:false});
  }
}

} finally {
  rmSync(root, { recursive: true, force: true });
  assert.equal(existsSync(root), false);
  process.stdout.write(JSON.stringify({ type: "cleanup", temporaryRootRemoved: true }) + "\n");
}
