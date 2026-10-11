// Read only the bounded first native session record. This does not authenticate a hook caller.
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from "node:fs";
import { isAbsolute, normalize, parse, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { createHash } from "node:crypto";

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
export function readAssignmentTurn(transcriptPath, options, expected) {
  const unavailable = () => { throw Error("Codex assignment evidence is unavailable"); };
  try {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const taskPath = /^\/root(?:\/(?!root(?:\/|$))[a-z0-9_]+)*$/;
    const keys = ["session", "child", "parent", "path", "author", "turn", "taskHash"];
    if (!record(expected) || Object.keys(expected).length !== keys.length || keys.some(key => !Object.hasOwn(expected, key))
      || !["session", "child", "parent", "turn"].every(key => typeof expected[key] === "string" && uuid.test(expected[key]))
      || expected.child === expected.session || expected.child === expected.parent
      || !["path", "author"].every(key => typeof expected[key] === "string" && taskPath.test(expected[key]))
      || expected.path.slice(0, expected.path.lastIndexOf("/")) !== expected.author
      || typeof expected.taskHash !== "string" || !/^[0-9a-f]{64}$/.test(expected.taskHash)) unavailable();
    const [header, ...rows] = readSessionRecords(transcriptPath, options, Infinity);
    const wanted = { id: expected.child, session_id: expected.session, parent_thread_id: expected.parent,
      agent_path: expected.path, cli_version: "0.160.0" };
    if (Object.entries(wanted).some(([key, value]) => header.payload[key] !== value)) unavailable();
    let turn, context;
    const turns = new Set(), matches = [];
    for (const row of rows) {
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
      if (parts.length !== 1 || typeof parts[0].encrypted_content !== "string") unavailable();
      const taskHash = createHash("sha256").update(parts[0].encrypted_content).digest("hex");
      if (taskHash !== expected.taskHash) continue;
      if (payload.author !== expected.author || payload.recipient !== expected.path
        || typeof payload.id !== "string" || !/^amsg_[A-Za-z0-9_-]{1,256}$/.test(payload.id)) unavailable();
      matches.push({ session: expected.session, child: expected.child, turn, message: payload.id, taskHash });
    }
    if (matches.length !== 1 || matches[0].turn !== expected.turn) unavailable();
    return matches[0];
  } catch { unavailable(); }
}
