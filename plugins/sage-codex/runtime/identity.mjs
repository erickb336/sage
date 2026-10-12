// Read only the bounded first native session record. This does not authenticate a hook caller.
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from "node:fs";
import { isAbsolute, normalize, parse, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { createHash } from "node:crypto";
import { readRecoveryOutput } from "./recovery-output.mjs";

const LIMIT = 256 * 1024;
const FIELDS = ["id", "session_id", "parent_thread_id", "agent_path", "cli_version"];
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const pathValue = (value) => typeof value === "string" && value.length <= 4096 && isAbsolute(value)
  && normalize(value) === value && !/\p{Cc}/u.test(value);
const refuse = () => { throw new Error("Codex session identity is unavailable"); };

/** sessionsDir must be a trusted, canonical native profile directory supplied by the caller. */
function readSessionRecords(transcriptPath, { sessionsDir } = {}, count = 1) {
  let fd;
  try {
    if (!pathValue(sessionsDir) || !pathValue(transcriptPath)) refuse();
    const child = relative(sessionsDir, transcriptPath);
    if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) refuse();
    // Refuse links in every component, including the caller's directory.
    let cursor = parse(transcriptPath).root;
    const components = transcriptPath.slice(cursor.length).split(sep);
    for (let index = 0; index < components.length; index++) {
      cursor = resolve(cursor, components[index]);
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || (index < components.length - 1 && !stat.isDirectory())) refuse();
    }
    fd = openSync(transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) refuse();
    const limit = count === Infinity ? 16 * 1024 * 1024 : LIMIT;
    if (count === Infinity && fstatSync(fd).size > limit) refuse();
    const bytes = Buffer.alloc(limit);
    let used = 0, start = 0;
    const ends = [];
    while (used < limit && ends.length < count) {
      const size = readSync(fd, bytes, used, Math.min(4096, limit - used), used);
      if (size === 0) break;
      used += size;
      let end;
      while (ends.length < count && (end = bytes.subarray(start, used).indexOf(10)) >= 0) {
        start += end + 1;
        ends.push(start - 1);
        if (ends.length > 65536) refuse();
      }
    }
    if (count === Infinity) {
      if (!ends.length || ends.at(-1) !== used - 1 || fstatSync(fd).size !== used) refuse();
    } else if (ends.length !== count) refuse();
    let offset = 0;
    const rows = ends.map((end) => {
      const row = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, end)));
      offset = end + 1;
      return row;
    });
    const header = rows[0];
    if (!record(header) || header.type !== "session_meta" || !record(header.payload)) refuse();
    return rows;
  } catch {
    refuse();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}


const identity = (header) => Object.fromEntries(FIELDS.filter((field) => Object.hasOwn(header.payload, field)).map((field) => [field, header.payload[field]]));

export function readSessionIdentity(transcriptPath, options) {
  return identity(readSessionRecords(transcriptPath, options)[0]);
}

/** Read the initial native turn only. Never infer the current turn from later transcript content. */
export function readInitialSession(transcriptPath, options) {
  const [header, first] = readSessionRecords(transcriptPath, options, 2);
  if (!record(first) || first.type !== "event_msg" || !record(first.payload) || first.payload.type !== "task_started"
    || typeof first.payload.turn_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(first.payload.turn_id)) refuse();
  return { metadata: identity(header), turn: first.payload.turn_id };
}


/** The caller supplies immutable assignment evidence and a verified child transcript path.
 * This checks delivery, not report acceptance or authority to modify the journal. */
function assignmentFromRecords(records, expected, discoverTurn = false) {
  const unavailable = () => { throw Error("Codex assignment evidence is unavailable"); };
  try {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const taskPath = /^\/root(?:\/(?!root(?:\/|$))[a-z0-9_]+)*$/;
    const keys = ["session", "child", "parent", "path", "author", ...(discoverTurn ? [] : ["turn"]), "taskHash"];
    if (!record(expected) || Object.keys(expected).length !== keys.length || keys.some(key => !Object.hasOwn(expected, key))
      || !["session", "child", "parent", ...(discoverTurn ? [] : ["turn"])].every(key => typeof expected[key] === "string" && uuid.test(expected[key]))
      || expected.child === expected.session || expected.child === expected.parent
      || !["path", "author"].every(key => typeof expected[key] === "string" && taskPath.test(expected[key]))
      || expected.path.slice(0, expected.path.lastIndexOf("/")) !== expected.author
      || typeof expected.taskHash !== "string" || !/^[0-9a-f]{64}$/.test(expected.taskHash)) unavailable();
    const [header, ...rows] = records;
    const wanted = { id: expected.child, session_id: expected.session, parent_thread_id: expected.parent,
      agent_path: expected.path, cli_version: "0.160.0" };
    if (Object.entries(wanted).some(([key, value]) => header.payload[key] !== value)) unavailable();
    let turn, context;
    const turns = new Set(), matches = [];
    for (const [index, row] of rows.entries()) {
      if (!record(row) || typeof row.type !== "string" || !record(row.payload)) unavailable();
      const payload = row.payload;
      if (row.type === "session_meta") unavailable();
      if (row.type === "event_msg" && payload.type === "task_started") {
        if (!uuid.test(payload.turn_id ?? "") || turns.has(payload.turn_id)) unavailable();
        turn = payload.turn_id; context = undefined; turns.add(turn);
      }
      if (row.type === "turn_context") {
        if (!turn || payload.turn_id !== turn) unavailable();
        context = turn;
      }
      if (row.type !== "response_item" || payload.type !== "agent_message") continue;
      if (!turn || context !== turn || !Array.isArray(payload.content)) unavailable();
      const parts = payload.content.filter(part => record(part) && part.type === "encrypted_content");
      // Native result notifications contain plain text, not an assigned task.
      if (parts.length === 0) continue;
      if (parts.length !== 1 || typeof parts[0].encrypted_content !== "string") unavailable();
      const taskHash = createHash("sha256").update(parts[0].encrypted_content).digest("hex");
      if (taskHash !== expected.taskHash) continue;
      if (payload.author !== expected.author || payload.recipient !== expected.path
        || typeof payload.id !== "string" || !/^amsg_[A-Za-z0-9_-]{1,256}$/.test(payload.id)) unavailable();
      matches.push({ session: expected.session, child: expected.child, turn, message: payload.id, taskHash, position: index + 1 });
    }
    if (discoverTurn && matches.length === 0) return null;
    if (matches.length !== 1 || matches[0].turn !== (discoverTurn ? turn : expected.turn)) unavailable();
    return matches[0];
  } catch { unavailable(); }
}


export function readAssignmentTurn(transcriptPath, options, expected) {
  try {
    const { position, ...evidence } = assignmentFromRecords(readSessionRecords(transcriptPath, options, Infinity), expected);
    return evidence;
  }
  catch { throw Error("Codex assignment evidence is unavailable"); }
}

/** Read recovery ordering from the same protected snapshot as assignment delivery.
 * A ready result does not grant permission or validate a final report's ordering. */
export function readNativeRecovery(transcriptPath, options, expected) {
  try { return recoveryFromRecords(readSessionRecords(transcriptPath, options, Infinity), expected); }
  catch { throw Error("Codex recovery evidence is unavailable"); }
}

function recoveryFromRecords(rows, expected) {
  const unavailable = () => { throw Error("Codex recovery evidence is unavailable"); };
  try {
    const { position } = assignmentFromRecords(rows, expected);
    const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
    let turn, context, terminal = false, pendingCompaction = false, windowNumber = 0;
    let compaction = null, call = null, recoveredPosition = null;
    const windows = new Set(), calls = new Map(), outputs = new Set();
    for (const [index, row] of rows.entries()) {
      if (index === 0) continue;
      const p = row.payload;
      if (row.type === "event_msg" && p.type === "task_started") { turn = p.turn_id; context = undefined; }
      if (row.type === "turn_context") context = p.turn_id;
      if (turn !== expected.turn || index <= position) continue;
      if (row.type === "event_msg" && ["task_complete", "turn_aborted"].includes(p.type)) {
        if (terminal || p.turn_id !== turn || pendingCompaction) unavailable();
        terminal = true; continue;
      }
      if (terminal && ["response_item", "compacted"].includes(row.type)) unavailable();
      if (row.type === "response_item" && row.metadata?.compaction_output === true) {
        if (row.metadata.client_authored !== false || p.type !== "message" || p.role !== "assistant"
          || p.internal_chat_message_metadata_passthrough?.turn_id !== turn) unavailable();
        pendingCompaction = true; call = null; recoveredPosition = null; continue;
      }
      if (row.type === "compacted") {
        if (context !== turn || !Number.isSafeInteger(p.window_number) || p.window_number <= windowNumber
          || typeof p.window_id !== "string" || !uuid.test(p.window_id) || windows.has(p.window_id)
          || p.resume_metadata?.last_started_turn_id !== turn || p.resume_metadata?.multi_agent_version !== "v2") unavailable();
        windows.add(p.window_id); windowNumber = p.window_number;
        compaction = p.window_id; pendingCompaction = false; call = null; recoveredPosition = null;
        // A call made before this checkpoint cannot establish a later read.
        for (const id of calls.keys()) calls.set(id, false);
        continue;
      }
      if (row.type !== "response_item" || !["function_call", "function_call_output"].includes(p.type)) continue;
      if (context !== turn || row.metadata?.client_authored !== false
        || p.internal_chat_message_metadata_passthrough?.turn_id !== turn
        || typeof p.call_id !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/.test(p.call_id)) unavailable();
      if (p.type === "function_call") {
        if (calls.has(p.call_id)) unavailable();
        let empty = false;
        try { const args = JSON.parse(p.arguments); empty = record(args) && Object.keys(args).length === 0; } catch {}
        calls.set(p.call_id, compaction && !pendingCompaction && empty
          && p.namespace === "mcp__sage_preparation" && p.name === "sage_read_assignment" ? row : false);
      } else {
        if (outputs.has(p.call_id)) unavailable();
        outputs.add(p.call_id);
        if (!calls.get(p.call_id) || pendingCompaction) continue;
        try {
          readRecoveryOutput(row, { child: expected.child, turn: expected.turn, taskHash: expected.taskHash }, calls.get(p.call_id));
          call = p.call_id; recoveredPosition = index;
        } catch {
          // Failed or shortened results do not recover context. A fresh read can retry.
        }
      }
    }
    if (pendingCompaction) unavailable();
    return { required: compaction !== null && call === null, compaction, call, position: recoveredPosition };
  } catch { unavailable(); }
}

/** Discover delivery only for an exact saved task hash in the current native child turn. */
export function readDeliveredAssignment(transcriptPath, options, expected) {
  try {
    const found = assignmentFromRecords(readSessionRecords(transcriptPath, options, Infinity), expected, true);
    if (!found) return null;
    const { position, ...evidence } = found;
    return evidence;
  } catch { throw Error("Codex assignment delivery evidence is unavailable"); }
}

/** Verify native interruption of an exact assignment. This does not accept a report or release a slot. */
export function readNativeInterruption(transcriptPath, options, expected) {
  const unavailable = () => { throw Error("Codex interruption evidence is unavailable"); };
  try {
    const rows = readSessionRecords(transcriptPath, options, Infinity);
    const { position, ...assigned } = assignmentFromRecords(rows, expected);
    let turn, aborted;
    for (const [index, row] of rows.entries()) {
      if (index === 0) continue;
      const payload = row.payload;
      if (row.type === "event_msg" && payload.type === "task_started") turn = payload.turn_id;
      if (row.type === "event_msg" && payload.type === "turn_aborted"
        && (turn === expected.turn || payload.turn_id === expected.turn)) {
        if (turn !== expected.turn || payload.turn_id !== expected.turn || payload.reason !== "interrupted"
          || aborted || index <= position) unavailable();
        aborted = payload;
      } else if ((row.type === "event_msg" && payload.type === "task_complete"
        && (turn === expected.turn || payload.turn_id === expected.turn))
        || (turn === expected.turn && aborted && row.type === "response_item")) unavailable();
    }
    if (!aborted) { if (turn === expected.turn) return null; unavailable(); }
    return { ...assigned, reason: "interrupted",
      evidenceHash: createHash("sha256").update(JSON.stringify({ ...assigned, abort: aborted })).digest("hex") };
  } catch { unavailable(); }
}

/** Read one completed turn from the same protected snapshot as its assigned task.
 * This verifies report provenance, not its claims or a review verdict. */
function reportFromRecords(rows, expected, { pending = false, report = true, recovery = false } = {}) {
  const unavailable = () => { throw Error("Codex report evidence is unavailable"); };
  try {
    const { position, ...assigned } = assignmentFromRecords(rows, expected);
    let turn, final, completed, aborted, finalPosition;
    for (const [index, row] of rows.entries()) {
      if (index === 0) continue;
      const payload = row.payload;
      if (row.type === "event_msg" && payload.type === "task_started") turn = payload.turn_id;
      if (row.type === "event_msg" && payload.type === "turn_aborted"
        && (turn === expected.turn || payload.turn_id === expected.turn)) aborted = true;
      if (turn !== expected.turn) continue;
      if (row.type === "response_item" && payload.type === "message" && payload.role === "assistant") {
        if (completed || index <= position) unavailable();
        // Native compaction output has no retained report source. A later final
        // message must supply its own provenance before this turn can complete.
        if (row.metadata?.compaction_output === true) {
          if (row.metadata.client_authored !== false || Object.hasOwn(row.metadata, "retained_source")
            || payload.internal_chat_message_metadata_passthrough?.turn_id !== turn) unavailable();
          final = undefined;
          continue;
        }
        if (payload.phase !== undefined && payload.phase !== "final_answer") continue;
        const retained = row.metadata?.retained_source;
        if (typeof payload.id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(payload.id)
          || row.metadata?.client_authored !== false || retained?.complete !== true
          || retained.id?.role !== "assistant" || retained.id?.turn_id !== turn || retained.id?.message_id !== payload.id
          || payload.internal_chat_message_metadata_passthrough?.turn_id !== turn
          || !Array.isArray(payload.content) || !payload.content.length
          || payload.content.some(part => !record(part) || part.type !== "output_text" || typeof part.text !== "string")) unavailable();
        const text = payload.content.map(part => part.text).join("");
        if ((report && (!text.trim() || Buffer.byteLength(text, "utf8") > 32 * 1024 || text.includes("\0")))
          || Buffer.from(text, "utf8").toString("utf8") !== text) unavailable();
        finalPosition = index;
        final = { reportMessage: payload.id, reportHash: createHash("sha256").update(text).digest("hex"), text };
      }
      if (row.type === "event_msg" && payload.type === "task_complete") {
        if (completed || payload.turn_id !== turn || !final || payload.last_agent_message !== final.text) unavailable();
        completed = final;
      }
    }
    if (aborted && completed) unavailable();
    if (!completed) { if (pending) return null; unavailable(); }
    if (recovery) {
      const restored = recoveryFromRecords(rows, expected);
      if (restored.required || (restored.position !== null && finalPosition <= restored.position)) unavailable();
    }
    return { ...assigned, ...completed };
  } catch { unavailable(); }
}


export function readNativeReport(transcriptPath, options, expected) {
  try { return reportFromRecords(readSessionRecords(transcriptPath, options, Infinity), expected, { recovery: options.requireRecovery === true }); }
  catch { throw Error("Codex report evidence is unavailable"); }
}

/** A stop callback can be blocked. Only the later native task_complete record confirms this turn. */
export function readNativeCompletion(transcriptPath, options, expected) {
  try { return reportFromRecords(readSessionRecords(transcriptPath, options, Infinity), expected, { pending: true, report: false, recovery: options.requireRecovery === true }); }
  catch { throw Error("Codex report evidence is unavailable"); }
}


/** Only the captured 0.160.0 unknown-model preflight rejection proves this dispatch failed.
 * Other tool errors return null. This never releases admission by itself. */
export function readNativeDispatchFailure(transcriptPath, options, expected) {
  const unavailable = () => { throw Error("Codex dispatch failure evidence is unavailable"); };
  try {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const keys = ["session", "actor", "parent", "path", "turn", "call", "argumentsHash"];
    if (!record(expected) || Object.keys(expected).length !== keys.length || keys.some(key => !Object.hasOwn(expected, key))
      || !["session", "actor", "turn"].every(key => uuid.test(expected[key] ?? ""))
      || !/^[A-Za-z0-9_.:-]{1,256}$/.test(expected.call ?? "") || !/^[0-9a-f]{64}$/.test(expected.argumentsHash ?? "")) unavailable();
    const rows = readSessionRecords(transcriptPath, options, Infinity), meta = rows[0].payload;
    if (meta.id !== expected.actor || meta.session_id !== expected.session || meta.cli_version !== "0.160.0") unavailable();
    if (expected.actor === expected.session) {
      if (expected.parent !== null || expected.path !== "/root" || Object.hasOwn(meta, "parent_thread_id") || Object.hasOwn(meta, "agent_path")) unavailable();
    } else if (!uuid.test(expected.parent ?? "") || !/^\/root(?:\/(?!root(?:\/|$))[a-z0-9_]+)+$/.test(expected.path ?? "")
      || meta.parent_thread_id !== expected.parent || meta.agent_path !== expected.path) unavailable();
    let turn, context, request, result;
    const turns = new Set();
    for (const row of rows.slice(1)) {
      if (!record(row) || !record(row.payload) || row.type === "session_meta") unavailable();
      const p = row.payload;
      if (row.type === "event_msg" && p.type === "task_started") {
        if (!uuid.test(p.turn_id ?? "") || turns.has(p.turn_id)) unavailable();
        turns.add(p.turn_id); turn = p.turn_id; context = undefined;
      }
      if (row.type === "turn_context") {
        if (!turn || p.turn_id !== turn) unavailable();
        context = turn;
      }
      if (row.type !== "response_item" || p.call_id !== expected.call) continue;
      if (turn !== expected.turn || context !== turn || p.internal_chat_message_metadata_passthrough?.turn_id !== turn
        || row.metadata?.client_authored !== false) unavailable();
      if (p.type === "function_call") {
        if (request || result || p.name !== "spawn_agent" || p.namespace !== "collaboration" || typeof p.arguments !== "string") unavailable();
        const args = JSON.parse(p.arguments);
        if (!record(args) || createHash("sha256").update(JSON.stringify(args)).digest("hex") !== expected.argumentsHash) unavailable();
        request = args;
      } else if (p.type === "function_call_output") {
        if (!request || result || typeof p.output !== "string" || typeof p.id !== "string" || !/^fco_[A-Za-z0-9_-]{1,256}$/.test(p.id)) unavailable();
        result = { id: p.id, output: p.output };
      } else unavailable();
    }
    if (!request || !result || typeof request.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(request.model)) return null;
    const prefix = `Unknown model \`${request.model}\` for spawn_agent. Available models: `;
    if (!result.output.startsWith(prefix) || result.output.length <= prefix.length || /\p{Cc}/u.test(result.output)) return null;
    return { evidenceHash: createHash("sha256").update(JSON.stringify({ ...expected, result })).digest("hex") };
  } catch { unavailable(); }
}

/** Recover an exec_command envelope before execution. The caller authenticates the hook first. */
export function readNativeCommand(transcriptPath, options, expected) {
  const unavailable = () => { throw Error("Codex command evidence is unavailable"); };
  try {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const keys = ["session", "actor", "parent", "path", "turn", "call", "command"];
    if (!record(expected) || Object.keys(expected).length !== keys.length || keys.some(key => !Object.hasOwn(expected, key))
      || !["session", "actor", "turn"].every(key => typeof expected[key] === "string" && uuid.test(expected[key]))
      || typeof expected.call !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/.test(expected.call)
      || typeof expected.command !== "string" || expected.command.length === 0 || expected.command.length > 1024 * 1024) unavailable();
    const rows = readSessionRecords(transcriptPath, options, Infinity), meta = rows[0].payload;
    if (meta.id !== expected.actor || meta.session_id !== expected.session || meta.cli_version !== "0.160.0") unavailable();
    if (expected.actor === expected.session) {
      if (expected.parent !== null || expected.path !== "/root" || Object.hasOwn(meta, "parent_thread_id") || Object.hasOwn(meta, "agent_path")) unavailable();
    } else if (typeof expected.parent !== "string" || !uuid.test(expected.parent)
      || typeof expected.path !== "string" || !/^\/root(?:\/(?!root(?:\/|$))[a-z0-9_]+)+$/.test(expected.path)
      || meta.parent_thread_id !== expected.parent || meta.agent_path !== expected.path) unavailable();
    let turn, context, command;
    const turns = new Set();
    for (const row of rows.slice(1)) {
      if (!record(row) || !record(row.payload) || row.type === "session_meta") unavailable();
      const p = row.payload;
      if (row.type === "event_msg" && p.type === "task_started") {
        if (typeof p.turn_id !== "string" || !uuid.test(p.turn_id) || turns.has(p.turn_id)) unavailable();
        turns.add(p.turn_id); turn = p.turn_id; context = undefined;
      }
      if (row.type === "event_msg" && ["task_complete", "turn_aborted"].includes(p.type)
        && (p.turn_id === expected.turn || turn === expected.turn)) unavailable();
      if (row.type === "turn_context") {
        if (!turn || p.turn_id !== turn) unavailable();
        context = turn;
      }
      if (row.type !== "response_item" || p.call_id !== expected.call) continue;
      // A result means this is no longer evidence for a pending pre-tool decision.
      if (command || p.type !== "function_call" || p.name !== "exec_command" || Object.hasOwn(p, "namespace")
        || turn !== expected.turn || context !== turn || p.internal_chat_message_metadata_passthrough?.turn_id !== turn
        || row.metadata?.client_authored !== false || typeof p.arguments !== "string") unavailable();
      const args = JSON.parse(p.arguments);
      if (!record(args) || args.cmd !== expected.command) unavailable();
      command = args;
    }
    if (!command || turn !== expected.turn || context !== turn) unavailable();
    // Preserve all fields. The command adapter must validate and apply their policy.
    return structuredClone(command);
  } catch { unavailable(); }
}


/** Current child-turn identity only. This does not prove task admission or completion. */
export function readChildTurn(transcriptPath, options, expected, { active = false } = {}) {
  const unavailable = () => { throw Error("Codex child turn evidence is unavailable"); };
  try {
    const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
    if (!record(expected) || Object.keys(expected).length !== 3
      || !["session", "child", "turn"].every(key => Object.hasOwn(expected, key) && uuid.test(expected[key]))
      || expected.child === expected.session) unavailable();
    const [header, ...rows] = readSessionRecords(transcriptPath, options, Infinity);
    const metadata = identity(header);
    if (metadata.id !== expected.child || metadata.session_id !== expected.session || metadata.cli_version !== "0.160.0") unavailable();
    const seen = new Set(); let initialTurn, turn, context, ended = false;
    for (const row of rows) {
      if (!record(row) || !record(row.payload) || row.type === "session_meta") unavailable();
      const p = row.payload;
      if (row.type === "event_msg" && p.type === "task_started") {
        if (typeof p.turn_id !== "string" || !uuid.test(p.turn_id) || seen.has(p.turn_id)) unavailable();
        seen.add(p.turn_id); initialTurn ??= p.turn_id; turn = p.turn_id; context = undefined; ended = false;
      }
      if (row.type === "turn_context") {
        if (!turn || p.turn_id !== turn) unavailable();
        context = turn;
      }
      if (row.type === "event_msg" && ["task_complete", "turn_aborted"].includes(p.type)) {
        if (!turn || p.turn_id !== turn) unavailable();
        ended = true;
      }
    }
    if (!initialTurn || turn !== expected.turn || context !== turn || (active && ended)) unavailable();
    return { metadata, initialTurn, turn };
  } catch { unavailable(); }
}

/** Verify one accepted follow-up call. This proves dispatch, not recipient delivery or admission. */
export function readNativeFollowup(transcriptPath, options, expected) {
  const unavailable = () => { throw Error("Codex follow-up evidence is unavailable"); };
  try {
    const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
    const keys = ["session", "actor", "parent", "path", "turn", "call", "target", "taskHash"];
    if (!record(expected) || Object.keys(expected).length !== keys.length || keys.some(key => !Object.hasOwn(expected, key))
      || !["session", "actor", "turn"].every(key => typeof expected[key] === "string" && uuid.test(expected[key]))
      || typeof expected.call !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/.test(expected.call)
      || typeof expected.target !== "string" || !/^[A-Za-z0-9_./:-]{1,4096}$/.test(expected.target)
      || typeof expected.taskHash !== "string" || !/^[0-9a-f]{64}$/.test(expected.taskHash)) unavailable();
    const rows = readSessionRecords(transcriptPath, options, Infinity), meta = rows[0].payload;
    if (meta.id !== expected.actor || meta.session_id !== expected.session || meta.cli_version !== "0.160.0") unavailable();
    if (expected.actor === expected.session) {
      if (expected.parent !== null || expected.path !== "/root" || Object.hasOwn(meta, "parent_thread_id") || Object.hasOwn(meta, "agent_path")) unavailable();
    } else if (typeof expected.parent !== "string" || !uuid.test(expected.parent) || expected.parent === expected.actor
      || typeof expected.path !== "string" || !/^\/root(?:\/(?!root(?:\/|$))[a-z0-9_]+)+$/.test(expected.path)
      || meta.parent_thread_id !== expected.parent || meta.agent_path !== expected.path) unavailable();
    let turn, context, request = false, result;
    const turns = new Set(), completed = new Set();
    for (const row of rows.slice(1)) {
      if (!record(row) || !record(row.payload) || row.type === "session_meta") unavailable();
      const p = row.payload;
      if (row.type === "event_msg" && p.type === "task_started") {
        if (typeof p.turn_id !== "string" || !uuid.test(p.turn_id) || turns.has(p.turn_id)) unavailable();
        turns.add(p.turn_id); turn = p.turn_id; context = undefined;
      }
      if (row.type === "event_msg" && ["task_complete", "turn_aborted"].includes(p.type)) {
        if (!turn || p.turn_id !== turn || completed.has(turn)) unavailable();
        completed.add(turn);
      }
      if (row.type === "turn_context") {
        if (!turn || p.turn_id !== turn || completed.has(turn)) unavailable();
        context = turn;
      }
      if (row.type !== "response_item" || p.call_id !== expected.call) continue;
      if (turn !== expected.turn || context !== turn || completed.has(turn)
        || p.internal_chat_message_metadata_passthrough?.turn_id !== turn || row.metadata?.client_authored !== false) unavailable();
      if (p.type === "function_call") {
        if (request || result || p.name !== "followup_task" || p.namespace !== "collaboration" || typeof p.arguments !== "string") unavailable();
        const args = JSON.parse(p.arguments);
        if (!record(args) || Object.keys(args).length !== 2 || !Object.hasOwn(args, "message") || !Object.hasOwn(args, "target")
          || args.target !== expected.target || typeof args.message !== "string" || !args.message
          || Buffer.byteLength(args.message) > 1024 * 1024 || args.message.includes("\0")
          || Buffer.from(args.message, "utf8").toString("utf8") !== args.message
          || createHash("sha256").update(args.message).digest("hex") !== expected.taskHash) unavailable();
        request = true;
      } else if (p.type === "function_call_output") {
        if (!request || result || p.output !== "" || typeof p.id !== "string" || !/^fco_[A-Za-z0-9_-]{1,256}$/.test(p.id)) unavailable();
        result = p.id;
      } else unavailable();
    }
    if (!request) unavailable();
    if (!result) {
      if (turn !== expected.turn || context !== turn || completed.has(turn)) unavailable();
      return null; // A live pending call is not successful dispatch.
    }
    return { call: expected.call, turn: expected.turn, target: expected.target, taskHash: expected.taskHash,
      resultMessage: result, evidenceHash: createHash("sha256").update(JSON.stringify([...keys.map(key => expected[key]), result])).digest("hex") };
  } catch { unavailable(); }
}
