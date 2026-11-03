// Read-only input boundary for the shared board. Callers supply roots explicitly.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { validateObservations } from "./observations.mjs";
import { logbookSettings } from "./logbook-fields.mjs";
import { PROGRAM_ID, TASK_ID, checkPrograms } from "./program-rules.mjs";
import { BINDING_COLUMNS, bindingRow, ownerOf } from "./shared-root.mjs";
import { chiefsWhole } from "./chiefs.mjs";

const parseJson = text => { try { return JSON.parse(text); } catch { throw new Error("invalid JSON"); } };
const MAX_FILE = 4 * 1024 * 1024;
const MAX_READ = 16 * 1024 * 1024;
const TASK_STATES = new Set("framed designing awaiting-you briefed building held reviewing repairing replan verifying verified pr-ready merged concluded abandoned".split(" "));
const TABLES = {
  tasks: "id title size risk route state branch pr round keys",
  runs: "id task role round candidate branch status tokens report started ended",
  findings: "task key round source severity summary triage reason status",
  ledger: "task pr sha kind cycle run at",
  gates: "id task question options recommendation default answer at",
  decisions: "at task decision why",
  programs: "id name goal pilot gate at",
};

function regularBytes(file, budget) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > MAX_FILE) throw new Error("not a bounded regular file");
    if (budget && before.size > budget.remaining) throw new Error("board aggregate read limit exceeded");
    if (budget) budget.remaining -= before.size;
    const buffer = Buffer.alloc(Math.min(MAX_FILE + 1, before.size + 1));
    let bytes = 0, count;
    while (bytes < buffer.length && (count = readSync(fd, buffer, bytes, buffer.length - bytes, null)) > 0) bytes += count;
    if (bytes > MAX_FILE) throw new Error("file exceeds the read limit");
    const data = buffer.subarray(0, bytes);
    const after = fstatSync(fd);
    if (bytes !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("file changed during the read");
    return data;
  } finally { closeSync(fd); }
}

const regular = (file, budget) => new TextDecoder("utf-8", { fatal: true }).decode(regularBytes(file, budget));

function table(file, name, budget) {
  // Each line keeps its number in the file, so a damaged row says where it is (R1307-1).
  const [[header] = [], ...lines] = regular(file, budget).replace(/^\uFEFF/, "").split(/\r?\n/).map((line, i) => [line, i + 1]).filter(([line]) => line);
  const columns = header?.split("\t") ?? [];
  if (new Set(columns).size !== columns.length || !TABLES[name].split(" ").every(c => columns.includes(c))) throw new Error("damaged table header");
  const identities = new Set();
  const rows = lines.map(([line, number]) => {
    const cells = line.split("\t");
    if (cells.length !== columns.length) throw new Error(`line ${number} has ${cells.length} cell${cells.length === 1 ? "" : "s"}, and its header has ${columns.length}`);
    const row = Object.fromEntries(columns.map((column, i) => [column, cells[i]]));
    if (name === "tasks") {
      if (!TASK_ID.test(row.id) || identities.has(row.id) || !TASK_STATES.has(row.state)) throw new Error("damaged task identity or state");
      identities.add(row.id);
      // A program cell that is not a program id shows as "?", as the older board shows a bad id: no hand-edited text reaches the board.
      if (row.program && !PROGRAM_ID.test(row.program)) row.program = "?";
    }
    return row;
  });
  // Two rows of one id or of one gate make the programs table unreadable, as the state tool refuses it; so does a bad id,
  // pilot or gate cell. The error names the row's line. The older board (board.mjs) reads it with the same check.
  // A task row that the move took to the shared logbook (its moved cell is set) shows there, not here (T306, PR 7).
  return name === "programs" ? checkPrograms(rows, lines.map(([, number]) => number)) : name === "tasks" ? rows.filter(row => !row.moved) : rows;
}

/** The lines of a small table of exact columns, as rows: the shared root's bindings, a logbook's chiefs and its old sources. */
function sheet(file, budget) {
  const [header = "", ...lines] = regular(file, budget).replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const cols = header.split("\t");
  return { cols, lines, rows: lines.map(line => Object.fromEntries(cols.map((column, i) => [column, line.split("\t")[i] ?? ""]))) };
}
const exact = (sheet, columns) => sheet.cols.join("\t") === columns.join("\t") && sheet.lines.every(line => line.split("\t").length === columns.length);
const damaged = () => new Error("damaged table");

const REPOSITORY = String.raw`([A-Za-z0-9][A-Za-z0-9-]*)\/([\w-][\w.-]*?)`;
/** A repository link the board accepts, from a remote or a PR observation: https://github.com/<owner>/<repo>, or null. */
export const githubRepository = value => new RegExp(String.raw`^https:\/\/github\.com\/${REPOSITORY}$`).test(value) ? value : null;

/** The origin and upstream remotes of a Git config file, each as https://github.com/<owner>/<repo>, or null for any other remote. */
function githubRemotes(config) {
  const found = { origin: null, upstream: null };
  let remote = null;
  for (const line of config.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]*)\]/.exec(line);
    if (section) { remote = /^remote\s+"(origin|upstream)"$/.exec(section[1].trim())?.[1] ?? null; continue; }
    const url = remote && !found[remote] && /^\s*url\s*=\s*(\S+)\s*$/.exec(line)?.[1];
    const match = url && new RegExp(String.raw`^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[:/]${REPOSITORY}(?:\.git)?\/?$`).exec(url);
    if (match) found[remote] = `https://github.com/${match[1]}/${match[2]}`;
  }
  return found;
}

/**
 * What names one logbook: its checkout (checkout.txt), the checkout's origin and upstream GitHub remotes, and the owner's
 * settings (sage config name= and archived=). It pushes a problem to the lists of `into` (diagnostics, warnings).
 */
export function logbookIdentity(directory, budget = null, into = { diagnostics: [], warnings: [] }, bound = undefined) {
  const found = { checkout: undefined, repository: null, upstream: null, archived: false };
  // A shared logbook has no checkout.txt: its checkout is its owner row of the shared root's bindings.tsv (bound).
  if (bound !== undefined) found.checkout = bound ?? undefined;
  else try { found.checkout = regular(join(directory, "checkout.txt"), budget).trim(); }
  catch (error) { if (error.code !== "ENOENT") into.diagnostics.push(`checkout: ${error.code ?? error.message}`); }
  // The PR link needs the checkout's GitHub origin, and the project's name may come from its upstream. Read its Git
  // config as a file; run no Git command. No remote: no link.
  const remotes = (() => { try { return isAbsolute(found.checkout ?? "") ? githubRemotes(regular(join(found.checkout, ".git", "config"), budget)) : {}; } catch { return {}; } })();
  found.repository = remotes.origin ?? null;
  found.upstream = remotes.upstream ?? null;
  // The owner's settings of this logbook, checked again. A bad value falls back (no name; not archived) with a warning,
  // not a diagnostic: no table is in doubt, so the board stays live.
  try {
    const settings = logbookSettings(parseJson(regular(join(directory, "config.json"), budget)));
    if (settings.name !== null) found.displayName = settings.name;
    found.archived = settings.archived;
    into.warnings.push(...settings.warnings);
  } catch (error) { if (error.code !== "ENOENT") into.warnings.push(`config: ${error.code ?? error.message}`); }
  if (found.checkout === undefined) delete found.checkout;
  return found;
}

const MAX_SLOTS = 64, MAX_MARKS = 64, MAX_NOTES = 4096;
/** A folder that is a real folder, not a link: its entries, or null when it is missing. Anything else throws its code. */
function folder(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isDirectory()) throw Object.assign(new Error("not a folder"), { code: stat.isSymbolicLink() ? "ELOOP" : "ENOTDIR" });
  return readdirSync(path);
}
/**
 * The hook's notes under a sage root (T308), read-only and bounded, by name only: no file content. Each agent slot
 * (.hooks/slots/slot-<n>) gives its marks (the names of its empty files) and its last activity (the folder's change time,
 * which the hook renews on each event of the agent). The helper notes (.hooks/helpers) give each helper's lead and run,
 * and whether it stopped, with the time of its stop note. present is false when the root has no slot folder: no hook
 * wrote here. problem is the code of a folder that the board cannot read; the slots are then not known.
 */
export function readHookNotes(root) {
  const notes = { present: false, slots: [], helpers: [], problem: null };
  try {
    const hooks = join(root, ".hooks");
    if (folder(hooks) === null) return notes;
    const names = folder(join(hooks, "slots"));
    if (names === null) return notes;
    notes.present = true;
    const slots = names.filter(name => /^slot-[1-9]\d{0,3}$/.test(name));
    if (slots.length > MAX_SLOTS) throw Object.assign(new Error("too many slots"), { code: "E2BIG" });
    for (const name of slots) {
      const path = join(hooks, "slots", name), stat = lstatSync(path, { throwIfNoEntry: false });
      if (!stat?.isDirectory()) continue; // a slot that the hook frees while the board reads it is gone
      let marks;
      try { marks = readdirSync(path); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (marks.length > MAX_MARKS) throw Object.assign(new Error("too many marks"), { code: "E2BIG" });
      notes.slots.push({ name, marks, at: stat.mtimeMs });
    }
    const helpers = folder(join(hooks, "helpers")) ?? [];
    if (helpers.length > MAX_NOTES) throw Object.assign(new Error("too many notes"), { code: "E2BIG" });
    // A helper's key is <its lead's key>.<its run id>: started-<key> when its slot was taken, stopped-<key> at its stop.
    for (const name of helpers) {
      const note = /^(started|stopped)-([0-9a-f]{64})\.(R[1-9]\d*)$/.exec(name);
      if (!note) continue;
      const at = note[1] === "stopped" ? lstatSync(join(hooks, "helpers", name), { throwIfNoEntry: false })?.mtimeMs ?? null : null;
      notes.helpers.push({ lead: note[2], run: note[3], stopped: note[1] === "stopped", at });
    }
  } catch (error) { Object.assign(notes, { slots: [], helpers: [], problem: error.code ?? error.message }); }
  return notes;
}

/** The id of the board source that is the shared root (T306): its logbooks have no checkout.txt and may name old logbooks. */
export const SHARED = "shared";
/** The folders of a logbook's receipts: a write adds one before it changes the tables. */
const RECEIPTS = ["task-requests", "run-requests", "usage-requests", "reviews", "interrupted-runs", "replace-requests", "task-updates"];
const WATCHED = [...Object.keys(TABLES), "chiefs", "sources"].map(name => `${name}.tsv`).concat("review-pending.json");
const MAX_ATTEMPTS = 3, MAX_OLD = 16;
/**
 * What says that a logbook changed between two reads: the folder, each table and review-pending.json (a table write is a
 * temp file and a rename, so its inode changes), and the names in each receipt folder. Names and stats only, no content.
 */
function fingerprint(directory) {
  const stat = path => { try { const s = lstatSync(path); return `${s.ino}:${s.size}:${s.mtimeMs}`; } catch (error) { return error.code; } };
  const names = path => { try { const list = readdirSync(path); return list.length > 65536 ? `${list.length}` : list.sort().join("/"); } catch (error) { return error.code; } };
  return JSON.stringify([stat(directory), ...WATCHED.map(name => stat(join(directory, name))), ...RECEIPTS.map(name => names(join(directory, name)))]);
}
const CHANGED = /changed during the read$/;

/** One read of one logbook into project. bound is a shared logbook's checkout (null when none is known), else undefined. */
function readLogbook(directory, project, budget, { now, bound, chiefs = true }) {
  const before = lstatSync(directory);
  for (const name of Object.keys(TABLES)) {
    try { project.tables[name] = table(join(directory, `${name}.tsv`), name, budget); }
    catch (error) {
      // A logbook from before programs has no programs table: that is a table with no rows while no task names a
      // program (the state tool's namesProgram rule). Once one does, a missing table is a diagnostic, as for any table.
      if (name === "programs" && error.code === "ENOENT" && !(project.tables.tasks ?? []).some(task => task.program)) project.tables.programs = [];
      else project.diagnostics.push(`${name}: ${error.code ?? error.message}`);
    }
  }
  // The chiefs of a shared logbook (T306, PR 3), by the state tool's rule. A legacy logbook has none: no file, no rows.
  project.chiefs = [];
  if (chiefs) try {
    const found = sheet(join(directory, "chiefs.tsv"), budget);
    if (!chiefsWhole(found.cols, found.lines, found.rows)) throw damaged();
    project.chiefs = found.rows;
  } catch (error) { if (error.code !== "ENOENT") project.diagnostics.push(`chiefs: ${error.code ?? error.message}`); }
  try { project.observations = validateObservations(parseJson(regular(join(directory, "observations.json"), budget)), { now }); }
  catch (error) {
    project.observations = { version: 1, records: [] };
    if (error.code !== "ENOENT") project.diagnostics.push(`observations: ${error.code ?? error.message}`);
  }
  Object.assign(project, logbookIdentity(directory, budget, project, bound));
  project.contents = {};
  for (const record of project.observations.records.filter(record => record.kind === "artifact" && record.data.path)) {
    try {
      if (!(project.tables.tasks ?? []).some(task => task.id === record.task)) throw new Error("artifact has no recorded task");
      const parts = record.data.path.split("/");
      const parents = parts.slice(0, -1).map((_, i) => join(directory, ...parts.slice(0, i + 1)));
      const identities = parents.map(path => { const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("artifact parent is not a directory"); return `${stat.dev}:${stat.ino}`; });
      const data = regularBytes(join(directory, ...parts), budget);
      if (createHash("sha256").update(data).digest("hex") !== record.data.sha256) throw new Error("artifact digest does not match");
      for (const [i, path] of parents.entries()) { const stat = lstatSync(path); if (`${stat.dev}:${stat.ino}` !== identities[i] || !stat.isDirectory()) throw new Error("artifact parent changed during the read"); }
      if (/\.(md|txt)$/i.test(parts.at(-1))) project.contents[record.id] = { kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(data), verified: true };
      else {
        const mime = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png" : data[0] === 255 && data[1] === 216 && data[2] === 255 ? "image/jpeg" : data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP" ? "image/webp" : null;
        project.contents[record.id] = mime ? { kind: "image", verified: true, dataUrl: `data:${mime};base64,${data.toString("base64")}` } : { kind: "attachment", verified: true };
      }
    } catch (error) { project.diagnostics.push(`artifact ${record.id}: ${error.code ?? error.message}`); }
  }
  const after = lstatSync(directory);
  if (after.dev !== before.dev || after.ino !== before.ino || !after.isDirectory() || after.isSymbolicLink()) {
    project.tables = {}; project.contents = {}; project.observations = { version: 1, records: [] }; project.diagnostics.push("project changed during the read");
  }
  return project;
}

/**
 * A consistent read of one logbook (T306, F9): a read counts only when the logbook's fingerprint is the same before and
 * after it, and no file changed while it was read. At most 3 reads, each with the same share of the read budget. After the
 * third difference the third read stays, with changing: { at }, and a file that changed during it is no diagnostic.
 * duringRead (for tests) runs after each read, before its second fingerprint.
 */
function consistentRead(directory, base, budget, options) {
  const share = budget.remaining;
  for (let attempt = 1; ; attempt++) {
    budget.remaining = share;
    const before = fingerprint(directory);
    const project = readLogbook(directory, { ...base, tables: {}, diagnostics: [], warnings: [] }, budget, options);
    options.duringRead?.(project.key, attempt);
    if (!project.diagnostics.some(message => CHANGED.test(message)) && fingerprint(directory) === before) return project;
    if (attempt === MAX_ATTEMPTS) return Object.assign(project, { diagnostics: project.diagnostics.filter(message => !CHANGED.test(message)), changing: { at: new Date(options.now).toISOString() } });
  }
}

/** The rows of the shared root's bindings.tsv, by the state tool's rule. A damaged table gives a problem and no rows. */
function bindingsOf(root, budget) {
  try {
    const found = sheet(join(root, "bindings.tsv"), budget);
    if (!exact(found, BINDING_COLUMNS) || !found.rows.every(bindingRow) || new Set(found.rows.map(row => row.root)).size !== found.rows.length) throw damaged();
    return { rows: found.rows, problem: null };
  } catch (error) { return { rows: [], problem: error.code === "ENOENT" ? null : `bindings: ${error.code ?? error.message}` }; }
}

/**
 * The old logbooks that a shared logbook's sources.tsv names (T306, the move): each row is a provider, a path and a time.
 * The board reads a path only when it is a logbook folder directly under a known provider root and not a link; any
 * other row is a diagnostic, and the board reads nothing there. Only the move (PR 7) writes this file.
 */
function oldSources(directory, roots, budget, project) {
  let found;
  try { found = sheet(join(directory, "sources.tsv"), budget); }
  catch (error) { if (error.code !== "ENOENT") project.diagnostics.push(`sources: ${error.code ?? error.message}`); return []; }
  if (!exact(found, ["provider", "path", "at"]) || found.rows.length > MAX_OLD) { project.diagnostics.push("sources: damaged table"); return []; }
  return found.rows.flatMap((row, i) => {
    const path = isAbsolute(row.path) ? resolve(row.path) : null, root = path && roots.find(item => item.path === dirname(path));
    const stat = root && /^[a-z0-9-]+-[0-9a-f]{6}$/.test(basename(path)) && /^[a-z][a-z0-9-]{0,30}$/.test(row.provider) ? lstatSync(path, { throwIfNoEntry: false }) : null;
    if (!stat?.isDirectory() || stat.isSymbolicLink()) { project.diagnostics.push(`sources: line ${i + 2} does not name an old logbook folder under a provider root`); return []; }
    return [{ provider: row.provider, path, root }];
  });
}

/**
 * Missing or damaged input is a diagnostic, never a silently empty board. The source with the id "shared" is the shared
 * root: when it is missing, that is no diagnostic (no project is shared yet). providerRoots are the provider roots that
 * the caller knows beyond the sources: an old logbook must be directly under one of them, or under a provider source.
 */
export function readBoardSources(sources, { now = Date.now(), logbookKey = null, providerRoots = [], duringRead = null } = {}) {
  if (!Array.isArray(sources) || sources.length > 32) throw new TypeError("board sources must be an array of at most 32 roots");
  if (logbookKey !== null && !/^[a-zA-Z0-9_-]{1,80}\/[a-z0-9-]+-[0-9a-f]{6}$/.test(logbookKey)) throw new TypeError("invalid logbook key");
  const budget = { remaining: MAX_READ };
  const ids = new Set(), identities = new Set(), moved = new Set();
  // The roots where an old logbook may be: each provider source's root, with its id, then the caller's other roots.
  const roots = [...sources.filter(source => source?.id !== SHARED && isAbsolute(source?.path ?? "")).map(source => ({ id: source.id, path: resolve(source.path) })),
    ...providerRoots.filter(path => isAbsolute(path)).map(path => ({ id: null, path: resolve(path) }))];
  const results = sources.map(source => {
    if (!source || !/^[a-zA-Z0-9_-]{1,80}$/.test(source.id ?? "") || ids.has(source.id) || !isAbsolute(source.path ?? "")) throw new TypeError("each board source needs a unique id and an absolute path");
    ids.add(source.id);
    const shared = source.id === SHARED;
    const result = { id: source.id, label: source.label ?? source.id, provider: source.provider ?? null, ...(shared && { shared: true }), config: {}, projects: [], diagnostics: [], hooks: { present: false, slots: [], helpers: [], problem: null } };
    if (logbookKey !== null && !logbookKey.startsWith(`${source.id}/`)) return result;
    try {
      const root = lstatSync(source.path, { throwIfNoEntry: !shared });
      if (!root) return result;
      if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("source is not a directory");
      const identity = `${root.dev}:${root.ino}`;
      if (identities.has(identity)) throw new Error("duplicate physical source");
      identities.add(identity);
      try {
        const config = parseJson(regular(join(source.path, "config.json"), budget));
        if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("config is not an object");
        result.config = config;
      } catch (error) { if (error.code !== "ENOENT") result.diagnostics.push(`config: ${error.code ?? error.message}`); }
      const entries = readdirSync(source.path, { withFileTypes: true }).filter(entry => /^[a-z0-9-]+-[0-9a-f]{6}$/.test(entry.name) && (logbookKey === null || `${source.id}/${entry.name}` === logbookKey)).sort((a,b) => a.name.localeCompare(b.name));
      if (entries.length > 4096) throw new Error("board project count exceeds 4096");
      const bindings = shared && entries.length ? bindingsOf(source.path, budget) : null;
      for (const entry of entries) {
        // logbook: the hook's name of this logbook (the sha256 of its folder), which its lead slots and helper notes carry (T308).
        const base = { key: `${source.id}/${entry.name}`, source: source.id, name: entry.name, logbook: createHash("sha256").update(join(source.path, entry.name)).digest("hex"), ...(shared && { shared: true }) };
        if (!entry.isDirectory() || entry.isSymbolicLink()) { result.projects.push({ ...base, tables: {}, diagnostics: ["project is not a directory"], warnings: [] }); continue; }
        const directory = join(source.path, entry.name);
        const project = consistentRead(directory, base, budget, { now, bound: shared ? ownerOf(bindings.rows, entry.name)?.root ?? null : undefined, duringRead });
        if (bindings?.problem) project.diagnostics.push(bindings.problem);
        result.projects.push(project);
        if (!shared) continue;
        // Each task's owning chief is a row of chiefs.tsv; an id with none shows as the id, with a warning.
        for (const task of project.tables.tasks ?? []) if (task.chief && !project.chiefs.some(chief => chief.id === task.chief)) project.warnings.push(`chiefs: ${task.id} names the chief ${task.chief}, which chiefs.tsv does not list`);
        if (logbookKey !== null) continue;
        // The finished tasks of the old logbooks stay there, read-only. Each shows once, in this project, with its provider.
        for (const old of oldSources(directory, roots, budget, project)) {
          const folder = basename(old.path), key = `${old.root.id ?? `old-${old.provider}`}/${folder}`;
          if (moved.has(old.path) || result.projects.some(other => other.key === key)) { project.diagnostics.push(`sources: ${folder} is named twice`); continue; }
          moved.add(old.path);
          result.projects.push(consistentRead(old.path, { key, source: source.id, name: folder, logbook: createHash("sha256").update(old.path).digest("hex"), old: { provider: old.provider, of: base.key } }, budget, { now, chiefs: false, duringRead }));
        }
      }
      if (logbookKey === null) result.hooks = readHookNotes(source.path);
      const after = lstatSync(source.path);
      if (after.dev !== root.dev || after.ino !== root.ino || !after.isDirectory()) throw new Error("source changed during the read");
    } catch (error) { result.diagnostics.push(error.code ?? error.message); result.projects = []; }
    return result;
  });
  // An old logbook that a provider source holds too (it has moved.json) shows once: in its shared project.
  for (const [i, result] of results.entries()) if (!result.shared) result.projects = result.projects.filter(project => !moved.has(join(resolve(sources[i].path), project.name)));
  return results;
}
