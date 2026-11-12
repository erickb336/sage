// Read-only input boundary for the shared board. Callers supply roots explicitly.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { validateObservations } from "./observations.mjs";
import { logbookSettings } from "./logbook-fields.mjs";
import { MILESTONE_ID, TASK_ID, checkMilestones, renameRows } from "./milestone-rules.mjs";
import { BINDING_COLUMNS, bindingRow, checkoutGone, githubRemote, linkedRows, ownerOf, plainName } from "./shared-root.mjs";
import { chiefsWhole } from "./chiefs.mjs";
import { MOVES } from "./shared-root.mjs";

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
  milestones: "id name goal pilot gate at",
  releases: "name goal at",
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

function table(file, name, budget, expected = TABLES[name]) {
  // Each line keeps its number in the file, so a damaged row says where it is (R1307-1).
  const [[header] = [], ...lines] = regular(file, budget).replace(/^\uFEFF/, "").split(/\r?\n/).map((line, i) => [line, i + 1]).filter(([line]) => line);
  const columns = header?.split("\t") ?? [];
  if (new Set(columns).size !== columns.length || !expected.split(" ").every(c => columns.includes(c))) throw new Error("damaged table header");
  const identities = new Set();
  const rows = lines.map(([line, number]) => {
    const cells = line.split("\t");
    if (cells.length !== columns.length) throw new Error(`line ${number} has ${cells.length} cell${cells.length === 1 ? "" : "s"}, and its header has ${columns.length}`);
    const row = Object.fromEntries(columns.map((column, i) => [column, cells[i]]));
    if (name === "tasks") {
      if (!TASK_ID.test(row.id) || identities.has(row.id) || !TASK_STATES.has(row.state)) throw new Error("damaged task identity or state");
      identities.add(row.id);
      // A milestone cell that is not a milestone id shows as "?", as the older board shows a bad id: no hand-edited text reaches the board.
      if (row.milestone && !MILESTONE_ID.test(row.milestone)) row.milestone = "?";
    }
    return row;
  });
  // Two rows of one id or of one gate make the milestones table unreadable, as the state tool refuses it; so does a bad id,
  // pilot or gate cell. The error names the row's line. The older board (board.mjs) reads it with the same check.
  return name === "milestones" ? checkMilestones(rows, lines.map(([, number]) => number)) : rows;
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
    const repository = url && githubRemote(url);
    if (repository) found[remote] = `https://github.com/${repository}`;
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
/**
 * The provider whose hook writes a root's notes and logbooks: a source's hookProvider (the in-session board's root: it
 * keeps today's label as its provider stand-in), else its provider, else null when the board does not know it.
 */
export const hookProvider = source => source.hookProvider ?? source.provider ?? null;
/** The folders of a logbook's receipts: a write adds one before it changes the tables. */
const RECEIPTS = ["usage-requests", "replace-requests"];
const WATCHED = [...Object.keys(TABLES), "chiefs", "sources", "programs"].map(name => `${name}.tsv`).concat("review-pending.json");
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
/** What a message of a change during the read names, in plain words: the whole logbook, a table, a file or an artifact (F-T624-11). */
export const changedPart = message => message === "project changed during the read" ? "the whole logbook"
  : message.startsWith("artifact ") ? message.split(":")[0] : { observations: "observations.json", checkout: "checkout.txt" }[message.split(":")[0]] ?? `${message.split(":")[0]}.tsv`;

/**
 * One read of one logbook into project. bound is a shared logbook's checkout (null when none is known), else undefined.
 * duringRead (for tests) runs at the end of the read, before the folder's second check.
 */
function readLogbook(directory, project, budget, { now, bound, chiefs = true, duringRead, attempt }) {
  const before = lstatSync(directory);
  let none = false; // no milestones.tsv, and no task names a milestone
  for (const name of Object.keys(TABLES)) {
    try { project.tables[name] = table(join(directory, `${name}.tsv`), name, budget); }
    catch (error) {
      // A logbook from before milestones has no milestones table: that is a table with no rows while no task names a
      // milestone (the state tool's namedBy rule). Once one does, a missing table is a diagnostic, as for any table.
      // A program cell names a milestone too, when its logbook from before the rename (T995) lost programs.tsv.
      // A logbook with no releases table has no releases (T1003): a cell that names one shows the release as not in the logbook.
      if (name === "releases" && error.code === "ENOENT") project.tables.releases = [];
      else if (name === "milestones" && error.code === "ENOENT" && !(project.tables.tasks ?? []).some(task => task.milestone || (task.program && !lstatSync(join(directory, "programs.tsv"), { throwIfNoEntry: false })))) project.tables.milestones = [], none = true;
      else project.diagnostics.push(`${name}: ${error.code ?? error.message}`);
    }
  }
  // A logbook from before the rename of program to milestone (T995) reads as the state tool reads it: its programs with
  // their new ids, each task's program cell as its milestone cell, and the new first line of each open breakdown gate.
  let programs;
  try { programs = table(join(directory, "programs.tsv"), "programs", budget, TABLES.milestones); }
  catch (error) { if (error.code !== "ENOENT") project.diagnostics.push(`programs: ${error.code ?? error.message}`); }
  if (programs) {
    const [tasks = [], decisions = [], gates = [], milestones] = ["tasks", "decisions", "gates", "milestones"].map(name => project.tables[name]);
    Object.assign(project.tables, renameRows({ tasks, decisions, gates, milestones: none ? undefined : milestones, programs }, ""));
    try { checkMilestones(project.tables.milestones); }
    catch (error) { delete project.tables.milestones; project.diagnostics.push(`milestones: ${error.message}`); }
  }
  // A task row that the move took to the shared logbook (its moved cell is set) shows there, not here (T306, PR 7). Its
  // milestone moved with it, with a new number, so the milestone and its cells leave this old logbook too (F-T624-12).
  const moved = (project.tables.tasks ?? []).filter(task => task.moved), gone = new Set(moved.map(task => task.milestone).filter(Boolean));
  if (moved.length) project.tables.tasks = project.tables.tasks.filter(task => !task.moved).map(task => gone.has(task.milestone) ? { ...task, milestone: "" } : task);
  if (gone.size && project.tables.milestones) project.tables.milestones = project.tables.milestones.filter(milestone => !gone.has(milestone.id));
  // The chiefs of a shared logbook (T306, PR 3), by the state tool's rule. A legacy logbook has none: no file, no rows.
  // A table that the board cannot read gives null: its one diagnostic says so, and no task's chief counts as not listed.
  project.chiefs = [];
  if (chiefs) try {
    const found = sheet(join(directory, "chiefs.tsv"), budget);
    if (!chiefsWhole(found.cols, found.lines, found.rows)) throw damaged();
    project.chiefs = found.rows;
  } catch (error) { if (error.code !== "ENOENT") { project.chiefs = null; project.diagnostics.push(`chiefs: ${error.code ?? error.message}`); } }
  try { project.observations = validateObservations(parseJson(regular(join(directory, "observations.json"), budget)), { now }); }
  catch (error) {
    project.observations = { version: 1, records: [] };
    if (error.code !== "ENOENT") project.diagnostics.push(`observations: ${error.code ?? error.message}`);
  }
  Object.assign(project, logbookIdentity(directory, budget, project, bound));
  // The run checkouts of a shared logbook that are gone from this Mac (T625), by the state tool's rule (checkoutGone): one lstat
  // for each distinct absolute path, at most 64, with no content read and no Git command. The board did not check the
  // others, and says so (F-T625-5).
  if (bound !== undefined) {
    const checkouts = [...new Set((project.tables.runs ?? []).map(run => run.checkout).filter(path => path && isAbsolute(path)))];
    project.goneCheckouts = checkouts.slice(0, 64).filter(root => checkoutGone({ root }));
    project.uncheckedCheckouts = checkouts.slice(64);
  }
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
  duringRead?.(project.key, attempt);
  const after = lstatSync(directory);
  if (after.dev !== before.dev || after.ino !== before.ino || !after.isDirectory() || after.isSymbolicLink()) {
    project.tables = {}; project.contents = {}; project.observations = { version: 1, records: [] }; project.diagnostics.push("project changed during the read");
  }
  return project;
}

/**
 * A consistent read of one logbook (T306, F9): a read counts only when the logbook's fingerprint is the same before and
 * after it, and no file changed while it was read. At most 3 reads, each with the same share of the read budget. After the
 * third difference the third read stays, with changing: { at }. A file that changed during it is no diagnostic: the
 * note names it in dropped, as its data does not show (F-T624-2).
 */
function consistentRead(directory, base, budget, options) {
  const share = budget.remaining;
  for (let attempt = 1; ; attempt++) {
    budget.remaining = share;
    const before = fingerprint(directory);
    const project = readLogbook(directory, { ...base, tables: {}, diagnostics: [], warnings: [] }, budget, { ...options, attempt });
    const changed = project.diagnostics.filter(message => CHANGED.test(message)).map(changedPart);
    const dropped = changed.includes("the whole logbook") ? ["the whole logbook"] : [...new Set(changed)];
    if (!dropped.length && fingerprint(directory) === before) return project;
    if (attempt === MAX_ATTEMPTS) return Object.assign(project, { diagnostics: project.diagnostics.filter(message => !CHANGED.test(message)), changing: { at: new Date(options.now).toISOString(), ...(dropped.length && { dropped }) } });
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
 * A shared logbook's rows of bindings.tsv (T633), in link order, at most 64, with one lstat each and no Git command. A row
 * that has no first commit in common with the owner row is a foreign one, which the state tool refuses (disjoint): only
 * its folder name stays. The others are the logbook's checkouts, gone by the run rule (checkoutGone), so the picker's
 * count and the runs agree (F-T630-3).
 */
function linkedCheckouts(rows, folder) {
  const { linked, foreign } = linkedRows(rows, folder);
  return { checkouts: linked.map(row => ({ root: row.root, gone: checkoutGone(row) })), foreignCheckouts: foreign.map(row => plainName(basename(row.root))) };
}

/**
 * The old logbooks that a shared logbook's sources.tsv names (T306, the move): each row is a provider, a path and a time.
 * The board reads a path only when it is a logbook folder directly under a known provider root, not a link, with the
 * move's mark moved.json, and its row names the root's provider (when the board knows it); any other row is a
 * note, and the board reads nothing there, so a live logbook stays on its own. Only the move (PR 7) writes this file.
 * A problem here is a note, not a diagnostic (F-T624-20): no table of the shared logbook is in doubt, so the board stays live.
 */
const OLD_PROVIDERS = ["claude", "codex"];
function oldSources(directory, roots, budget, project) {
  let found;
  try { found = sheet(join(directory, "sources.tsv"), budget); }
  catch (error) { if (error.code !== "ENOENT") project.notes.push(`sources: ${error.code ?? error.message}`); return []; }
  if (!exact(found, ["provider", "path", "at"]) || found.rows.length > MAX_OLD) { project.notes.push("sources: damaged table"); return []; }
  return found.rows.flatMap((row, i) => {
    const path = isAbsolute(row.path) ? resolve(row.path) : null, root = path && roots.find(item => item.path === dirname(path));
    // A root of no known provider (SAGE_HOME stands for both) takes a row of any provider that no other root is known to hold.
    const provider = root && (root.provider ?? (roots.some(other => other.provider === row.provider) ? null : row.provider));
    const named = root && provider === row.provider && /^[a-z0-9-]+-[0-9a-f]{6}$/.test(basename(path)) && OLD_PROVIDERS.includes(row.provider);
    // A folder that the board cannot search, or a name too long for the disk, refuses its own row only (F-T624-17, F-T624-23).
    try {
      const stat = named ? lstatSync(path, { throwIfNoEntry: false }) : null;
      if (stat?.isDirectory() && !stat.isSymbolicLink() && lstatSync(join(path, "moved.json"), { throwIfNoEntry: false })?.isFile()) return [{ provider: row.provider, path, root, at: row.at }];
      project.notes.push(`sources: line ${i + 2} does not name a moved logbook of its provider under a provider root`);
    } catch (error) { project.notes.push(`sources: line ${i + 2} names a folder that the board cannot read (${error.code ?? error.message})`); }
    return [];
  });
}

/**
 * Missing or damaged input is a diagnostic, never a silently empty board. The source with the id "shared" is the shared
 * root: when it is missing, that is no diagnostic (no project is shared yet). providerRoots are the provider roots that
 * the caller knows beyond the sources, each { path, provider }, provider null when the root stands for both (SAGE_HOME):
 * an old logbook must be directly under one of them, or under a provider source.
 */
export function readBoardSources(sources, { now = Date.now(), logbookKey = null, providerRoots = [], duringRead = null } = {}) {
  if (!Array.isArray(sources) || sources.length > 32) throw new TypeError("board sources must be an array of at most 32 roots");
  if (logbookKey !== null && !/^[a-zA-Z0-9_-]{1,80}\/[a-z0-9-]+-[0-9a-f]{6}$/.test(logbookKey)) throw new TypeError("invalid logbook key");
  const budget = { remaining: MAX_READ };
  const ids = new Set(), identities = new Set(), moved = new Set();
  // The roots where an old logbook may be: each source's root, with its id, then the caller's other roots. A root's provider
  // is the logbook provider that a source or the caller knows for it, never a hook provider (F-T624-9), so the chat board
  // and the server judge a sources.tsv row alike.
  const roots = [];
  for (const item of [...sources.filter(source => source?.id !== SHARED).map(source => ({ id: source.id, path: source.path, provider: source.provider })), ...providerRoots.map(root => ({ id: null, ...root }))]) {
    if (!isAbsolute(item?.path ?? "")) continue;
    const path = resolve(item.path), known = roots.find(root => root.path === path), provider = item.provider ?? null;
    if (!known) roots.push({ id: item.id, path, provider });
    else known.provider ??= provider;
  }
  const results = sources.map(source => {
    if (!source || !/^[a-zA-Z0-9_-]{1,80}$/.test(source.id ?? "") || ids.has(source.id) || !isAbsolute(source.path ?? "")) throw new TypeError("each board source needs a unique id and an absolute path");
    ids.add(source.id);
    const shared = source.id === SHARED;
    const result = { id: source.id, label: source.label ?? source.id, provider: source.provider ?? null, ...(source.hookProvider && { hookProvider: source.hookProvider }), ...(shared && { shared: true }), config: {}, projects: [], diagnostics: [], hooks: { present: false, slots: [], helpers: [], problem: null } };
    if (logbookKey !== null && !logbookKey.startsWith(`${source.id}/`)) return result;
    try {
      const root = lstatSync(source.path, { throwIfNoEntry: !shared });
      if (!root) return result;
      // A shared root that is a link or a file holds no project that the board reads: a note, as a missing one is none (F-T624-22).
      if (shared && (!root.isDirectory() || root.isSymbolicLink())) return Object.assign(result, { notes: [`The shared root is ${root.isSymbolicLink() ? "a link" : "not a folder"}, so the board reads no shared project there.`] });
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
        const owner = shared ? ownerOf(bindings.rows, entry.name) : undefined;
        const project = consistentRead(directory, base, budget, { now, bound: shared ? owner?.root ?? null : undefined, duringRead });
        if (bindings?.problem) project.diagnostics.push(bindings.problem);
        if (shared) Object.assign(project, linkedCheckouts(bindings.rows, entry.name));
        result.projects.push(project);
        if (!shared) continue;
        // The finished tasks of the old logbooks stay there, read-only. Each shows once, in this project, with its provider,
        // also in the task view of this one logbook (F-T624-21).
        project.notes = [];
        const olds = oldSources(directory, roots, budget, project);
        // The time of the move, from sources.tsv: the board shows a banner for 7 days after it (T640, the design's Q5 a).
        const movedAt = olds.map(old => old.at).filter(at => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(at ?? "") && !Number.isNaN(Date.parse(at))).sort()[0];
        // A move that stopped did not move the project yet: its plan is still in the moves folder, so no banner (F-T647-8).
        if (movedAt && !lstatSync(join(source.path, MOVES, `${entry.name}.json`), { throwIfNoEntry: false })) project.movedAt = movedAt;
        for (const old of olds) {
          const folder = basename(old.path), key = `${old.root.id ?? `old-${old.provider}`}/${folder}`;
          if (moved.has(old.path) || result.projects.some(other => other.key === key)) { project.notes.push(`sources: ${folder} is named twice`); continue; }
          moved.add(old.path);
          try { result.projects.push(consistentRead(old.path, { key, source: source.id, name: folder, logbook: createHash("sha256").update(old.path).digest("hex"), old: { provider: old.provider, of: base.key } }, budget, { now, chiefs: false, duringRead })); }
          catch (error) { project.notes.push(`sources: ${folder} cannot be read (${error.code ?? error.message})`); }
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
