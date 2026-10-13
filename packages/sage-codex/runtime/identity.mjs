// Read bounded native session records. This does not authenticate a hook caller.
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from "node:fs";
import { isAbsolute, normalize, parse, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

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
