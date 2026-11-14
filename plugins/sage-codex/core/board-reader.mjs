import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { validateObservations } from "./observations.mjs";
import { logbookSettings } from "./logbook-fields.mjs";
import { MILESTONE_ID, TASK_ID, checkMilestones, renameRows } from "./milestone-rules.mjs";
import { BINDING_COLUMNS, bindingRow, checkoutGone, githubRemote, linkedRows, ownerOf, plainName } from "./shared-root.mjs";
import { chiefsWhole } from "./chiefs.mjs";
import { LIVE_FOLDER, NAMES_FILE, chiefNames, liveRecord } from "./chief-live.mjs";
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
      if (row.milestone && !MILESTONE_ID.test(row.milestone)) row.milestone = "?";
    }
    return row;
  });
  return name === "milestones" ? checkMilestones(rows, lines.map(([, number]) => number)) : rows;
}

function sheet(file, budget) {
  const [header = "", ...lines] = regular(file, budget).replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const cols = header.split("\t");
  return { cols, lines, rows: lines.map(line => Object.fromEntries(cols.map((column, i) => [column, line.split("\t")[i] ?? ""]))) };
}
const exact = (sheet, columns) => sheet.cols.join("\t") === columns.join("\t") && sheet.lines.every(line => line.split("\t").length === columns.length);
const damaged = () => new Error("damaged table");

const REPOSITORY = String.raw`([A-Za-z0-9][A-Za-z0-9-]*)\/([\w-][\w.-]*?)`;
export const githubRepository = value => new RegExp(String.raw`^https:\/\/github\.com\/${REPOSITORY}$`).test(value) ? value : null;

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

export function logbookIdentity(directory, budget = null, into = { diagnostics: [], warnings: [] }, bound = undefined) {
  const found = { checkout: undefined, repository: null, upstream: null, archived: false };
  if (bound !== undefined) found.checkout = bound ?? undefined;
  else try { found.checkout = regular(join(directory, "checkout.txt"), budget).trim(); }
  catch (error) { if (error.code !== "ENOENT") into.diagnostics.push(`checkout: ${error.code ?? error.message}`); }
  const remotes = (() => { try { return isAbsolute(found.checkout ?? "") ? githubRemotes(regular(join(found.checkout, ".git", "config"), budget)) : {}; } catch { return {}; } })();
  found.repository = remotes.origin ?? null;
  found.upstream = remotes.upstream ?? null;
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
function folder(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isDirectory()) throw Object.assign(new Error("not a folder"), { code: stat.isSymbolicLink() ? "ELOOP" : "ENOTDIR" });
  return readdirSync(path);
}
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
      if (!stat?.isDirectory()) continue;
      let marks;
      try { marks = readdirSync(path); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (marks.length > MAX_MARKS) throw Object.assign(new Error("too many marks"), { code: "E2BIG" });
      notes.slots.push({ name, marks, at: stat.mtimeMs });
    }
    const helpers = folder(join(hooks, "helpers")) ?? [];
    if (helpers.length > MAX_NOTES) throw Object.assign(new Error("too many notes"), { code: "E2BIG" });
    for (const name of helpers) {
      const note = /^(started|stopped)-([0-9a-f]{64})\.(R[1-9]\d*)$/.exec(name);
      if (!note) continue;
      const at = note[1] === "stopped" ? lstatSync(join(hooks, "helpers", name), { throwIfNoEntry: false })?.mtimeMs ?? null : null;
      notes.helpers.push({ lead: note[2], run: note[3], stopped: note[1] === "stopped", at });
    }
  } catch (error) { Object.assign(notes, { slots: [], helpers: [], problem: error.code ?? error.message }); }
  return notes;
}

export const SHARED = "shared";
export const hookProvider = source => source.hookProvider ?? source.provider ?? null;
const RECEIPTS = ["usage-requests", "replace-requests"];
const WATCHED = [...Object.keys(TABLES), "chiefs", "sources", "programs"].map(name => `${name}.tsv`).concat("review-pending.json");
const MAX_ATTEMPTS = 3, MAX_OLD = 16;
function fingerprint(directory) {
  const stat = path => { try { const s = lstatSync(path); return `${s.ino}:${s.size}:${s.mtimeMs}`; } catch (error) { return error.code; } };
  const names = path => { try { const list = readdirSync(path); return list.length > 65536 ? `${list.length}` : list.sort().join("/"); } catch (error) { return error.code; } };
  return JSON.stringify([stat(directory), ...WATCHED.map(name => stat(join(directory, name))), ...RECEIPTS.map(name => names(join(directory, name)))]);
}
const CHANGED = /changed during the read$/;
export const changedPart = message => message === "project changed during the read" ? "the whole logbook"
  : message.startsWith("artifact ") ? message.split(":")[0] : { observations: "observations.json", checkout: "checkout.txt" }[message.split(":")[0]] ?? `${message.split(":")[0]}.tsv`;

function readLogbook(directory, project, budget, { now, bound, chiefs = true, duringRead, attempt }) {
  const before = lstatSync(directory);
  let none = false;
  for (const name of Object.keys(TABLES)) {
    try { project.tables[name] = table(join(directory, `${name}.tsv`), name, budget); }
    catch (error) {
      if (name === "releases" && error.code === "ENOENT") project.tables.releases = [];
      else if (name === "milestones" && error.code === "ENOENT" && !(project.tables.tasks ?? []).some(task => task.milestone || (task.program && !lstatSync(join(directory, "programs.tsv"), { throwIfNoEntry: false })))) project.tables.milestones = [], none = true;
      else project.diagnostics.push(`${name}: ${error.code ?? error.message}`);
    }
  }
  let programs;
  try { programs = table(join(directory, "programs.tsv"), "programs", budget, TABLES.milestones); }
  catch (error) { if (error.code !== "ENOENT") project.diagnostics.push(`programs: ${error.code ?? error.message}`); }
  if (programs) {
    const [tasks = [], decisions = [], gates = [], milestones] = ["tasks", "decisions", "gates", "milestones"].map(name => project.tables[name]);
    Object.assign(project.tables, renameRows({ tasks, decisions, gates, milestones: none ? undefined : milestones, programs }, ""));
    try { checkMilestones(project.tables.milestones); }
    catch (error) { delete project.tables.milestones; project.diagnostics.push(`milestones: ${error.message}`); }
  }
  const moved = (project.tables.tasks ?? []).filter(task => task.moved), gone = new Set(moved.map(task => task.milestone).filter(Boolean));
  if (moved.length) project.tables.tasks = project.tables.tasks.filter(task => !task.moved).map(task => gone.has(task.milestone) ? { ...task, milestone: "" } : task);
  if (gone.size && project.tables.milestones) project.tables.milestones = project.tables.milestones.filter(milestone => !gone.has(milestone.id));
  project.chiefs = [];
  if (chiefs) try {
    const found = sheet(join(directory, "chiefs.tsv"), budget);
    if (!chiefsWhole(found.cols, found.lines, found.rows)) throw damaged();
    project.chiefs = found.rows;
  } catch (error) { if (error.code !== "ENOENT") { project.chiefs = null; project.diagnostics.push(`chiefs: ${error.code ?? error.message}`); } }
  project.chiefLive = {}, project.chiefNames = {};
  if (project.chiefs?.length) {
    try {
      const files = new Set(folder(join(directory, LIVE_FOLDER)) ?? []);
      for (const { id } of project.chiefs.filter(row => files.has(`${row.id}.json`))) {
        try {
          const record = liveRecord(parseJson(regular(join(directory, LIVE_FOLDER, `${id}.json`), budget)));
          if (!record) throw new Error("not a JSON object");
          project.chiefLive[id] = record;
        } catch (error) { project.warnings.push(`${LIVE_FOLDER}/${id}.json: ${error.code ?? error.message}`); }
      }
    } catch (error) { project.warnings.push(`${LIVE_FOLDER}: ${error.code ?? error.message}`); }
    try {
      const { names, bad } = chiefNames(parseJson(regular(join(directory, NAMES_FILE), budget)));
      project.chiefNames = names;
      project.warnings.push(...bad.map(problem => `${NAMES_FILE}: ${problem}`));
    } catch (error) { if (error.code !== "ENOENT") project.warnings.push(`${NAMES_FILE}: ${error.code ?? error.message}`); }
  }
  try { project.observations = validateObservations(parseJson(regular(join(directory, "observations.json"), budget)), { now }); }
  catch (error) {
    project.observations = { version: 1, records: [] };
    if (error.code !== "ENOENT") project.diagnostics.push(`observations: ${error.code ?? error.message}`);
  }
  Object.assign(project, logbookIdentity(directory, budget, project, bound));
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

function bindingsOf(root, budget) {
  try {
    const found = sheet(join(root, "bindings.tsv"), budget);
    if (!exact(found, BINDING_COLUMNS) || !found.rows.every(bindingRow) || new Set(found.rows.map(row => row.root)).size !== found.rows.length) throw damaged();
    return { rows: found.rows, problem: null };
  } catch (error) { return { rows: [], problem: error.code === "ENOENT" ? null : `bindings: ${error.code ?? error.message}` }; }
}

function linkedCheckouts(rows, folder) {
  const { linked, foreign } = linkedRows(rows, folder);
  return { checkouts: linked.map(row => ({ root: row.root, gone: checkoutGone(row) })), foreignCheckouts: foreign.map(row => plainName(basename(row.root))) };
}

const OLD_PROVIDERS = ["claude", "codex"];
function oldSources(directory, roots, budget, project) {
  let found;
  try { found = sheet(join(directory, "sources.tsv"), budget); }
  catch (error) { if (error.code !== "ENOENT") project.notes.push(`sources: ${error.code ?? error.message}`); return []; }
  if (!exact(found, ["provider", "path", "at"]) || found.rows.length > MAX_OLD) { project.notes.push("sources: damaged table"); return []; }
  return found.rows.flatMap((row, i) => {
    const path = isAbsolute(row.path) ? resolve(row.path) : null, root = path && roots.find(item => item.path === dirname(path));
    const provider = root && (root.provider ?? (roots.some(other => other.provider === row.provider) ? null : row.provider));
    const named = root && provider === row.provider && /^[a-z0-9-]+-[0-9a-f]{6}$/.test(basename(path)) && OLD_PROVIDERS.includes(row.provider);
    try {
      const stat = named ? lstatSync(path, { throwIfNoEntry: false }) : null;
      if (stat?.isDirectory() && !stat.isSymbolicLink() && lstatSync(join(path, "moved.json"), { throwIfNoEntry: false })?.isFile()) return [{ provider: row.provider, path, root, at: row.at }];
      project.notes.push(`sources: line ${i + 2} does not name a moved logbook of its provider under a provider root`);
    } catch (error) { project.notes.push(`sources: line ${i + 2} names a folder that the board cannot read (${error.code ?? error.message})`); }
    return [];
  });
}

export function readBoardSources(sources, { now = Date.now(), logbookKey = null, providerRoots = [], duringRead = null } = {}) {
  if (!Array.isArray(sources) || sources.length > 32) throw new TypeError("board sources must be an array of at most 32 roots");
  if (logbookKey !== null && !/^[a-zA-Z0-9_-]{1,80}\/[a-z0-9-]+-[0-9a-f]{6}$/.test(logbookKey)) throw new TypeError("invalid logbook key");
  const budget = { remaining: MAX_READ };
  const ids = new Set(), identities = new Set(), moved = new Set();
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
        const base = { key: `${source.id}/${entry.name}`, source: source.id, name: entry.name, logbook: createHash("sha256").update(join(source.path, entry.name)).digest("hex"), ...(shared && { shared: true }) };
        if (!entry.isDirectory() || entry.isSymbolicLink()) { result.projects.push({ ...base, tables: {}, diagnostics: ["project is not a directory"], warnings: [] }); continue; }
        const directory = join(source.path, entry.name);
        const owner = shared ? ownerOf(bindings.rows, entry.name) : undefined;
        const project = consistentRead(directory, base, budget, { now, bound: shared ? owner?.root ?? null : undefined, duringRead });
        if (bindings?.problem) project.diagnostics.push(bindings.problem);
        if (shared) Object.assign(project, linkedCheckouts(bindings.rows, entry.name));
        result.projects.push(project);
        if (!shared) continue;
        project.notes = [];
        const olds = oldSources(directory, roots, budget, project);
        const movedAt = olds.map(old => old.at).filter(at => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(at ?? "") && !Number.isNaN(Date.parse(at))).sort()[0];
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
  for (const [i, result] of results.entries()) if (!result.shared) result.projects = result.projects.filter(project => !moved.has(join(resolve(sources[i].path), project.name)));
  return results;
}
