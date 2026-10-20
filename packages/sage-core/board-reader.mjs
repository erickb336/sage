// Read-only input boundary for the shared board. Callers supply roots explicitly.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { validateObservations } from "./observations.mjs";
import { logbookSettings } from "./logbook-fields.mjs";
import { PROGRAM_ID, TASK_ID, checkPrograms } from "./program-rules.mjs";

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
  const [header, ...lines] = regular(file, budget).replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const columns = header?.split("\t") ?? [];
  if (new Set(columns).size !== columns.length || !TABLES[name].split(" ").every(c => columns.includes(c))) throw new Error("damaged table header");
  const identities = new Set();
  const rows = lines.map(line => {
    const cells = line.split("\t");
    if (cells.length !== columns.length) throw new Error("damaged table row");
    const row = Object.fromEntries(columns.map((column, i) => [column, cells[i]]));
    if (name === "tasks") {
      if (!TASK_ID.test(row.id) || identities.has(row.id) || !TASK_STATES.has(row.state)) throw new Error("damaged task identity or state");
      identities.add(row.id);
      // A program cell that is not a program id shows as "?", as the older board shows a bad id: no hand-edited text reaches the board.
      if (row.program && !PROGRAM_ID.test(row.program)) row.program = "?";
    }
    return row;
  });
  // Two rows of one id make the programs table unreadable, as the state tool refuses it; so does a bad id, pilot or gate
  // cell. The older board (board.mjs) reads it with the same check.
  return name === "programs" ? checkPrograms(rows) : rows;
}

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
export function logbookIdentity(directory, budget = null, into = { diagnostics: [], warnings: [] }) {
  const found = { checkout: undefined, repository: null, upstream: null, archived: false };
  try { found.checkout = regular(join(directory, "checkout.txt"), budget).trim(); }
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

/** Missing or damaged input is a diagnostic, never a silently empty board. */
export function readBoardSources(sources, { now = Date.now() } = {}) {
  if (!Array.isArray(sources) || sources.length > 32) throw new TypeError("board sources must be an array of at most 32 roots");
  const budget = { remaining: MAX_READ };
  const ids = new Set(), identities = new Set();
  return sources.map(source => {
    if (!source || !/^[a-zA-Z0-9_-]{1,80}$/.test(source.id ?? "") || ids.has(source.id) || !isAbsolute(source.path ?? "")) throw new TypeError("each board source needs a unique id and an absolute path");
    ids.add(source.id);
    const result = { id: source.id, label: source.label ?? source.id, provider: source.provider ?? null, config: {}, projects: [], diagnostics: [], hooks: { present: false, slots: [], helpers: [], problem: null } };
    try {
      const root = lstatSync(source.path);
      if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("source is not a directory");
      const identity = `${root.dev}:${root.ino}`;
      if (identities.has(identity)) throw new Error("duplicate physical source");
      identities.add(identity);
      try {
        const config = parseJson(regular(join(source.path, "config.json"), budget));
        if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("config is not an object");
        result.config = config;
      } catch (error) { if (error.code !== "ENOENT") result.diagnostics.push(`config: ${error.code ?? error.message}`); }
      const entries = readdirSync(source.path, { withFileTypes: true }).filter(entry => /^[a-z0-9-]+-[0-9a-f]{6}$/.test(entry.name)).sort((a,b) => a.name.localeCompare(b.name));
      if (entries.length > 4096) throw new Error("board project count exceeds 4096");
      for (const entry of entries) {
        // logbook: the hook's name of this logbook (the sha256 of its folder), which its lead slots and helper notes carry (T308).
        const project = { key: `${source.id}/${entry.name}`, source: source.id, name: entry.name, logbook: createHash("sha256").update(join(source.path, entry.name)).digest("hex"), tables: {}, diagnostics: [], warnings: [] };
        result.projects.push(project);
        if (!entry.isDirectory() || entry.isSymbolicLink()) { project.diagnostics.push("project is not a directory"); continue; }
        const directory = join(source.path, entry.name), before = lstatSync(directory);
        for (const name of Object.keys(TABLES)) {
          try { project.tables[name] = table(join(source.path, entry.name, `${name}.tsv`), name, budget); }
          catch (error) {
            // A logbook from before programs has no programs table: that is a table with no rows while no task names a
            // program (the state tool's namesProgram rule). Once one does, a missing table is a diagnostic, as for any table.
            if (name === "programs" && error.code === "ENOENT" && !(project.tables.tasks ?? []).some(task => task.program)) project.tables.programs = [];
            else project.diagnostics.push(`${name}: ${error.code ?? error.message}`);
          }
        }
        try { project.observations = validateObservations(parseJson(regular(join(directory, "observations.json"), budget)), { now }); }
        catch (error) {
          project.observations = { version: 1, records: [] };
          if (error.code !== "ENOENT") project.diagnostics.push(`observations: ${error.code ?? error.message}`);
        }
        Object.assign(project, logbookIdentity(directory, budget, project));
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
      }
      result.hooks = readHookNotes(source.path);
      const after = lstatSync(source.path);
      if (after.dev !== root.dev || after.ino !== root.ino || !after.isDirectory()) throw new Error("source changed during the read");
    } catch (error) { result.diagnostics.push(error.code ?? error.message); result.projects = []; }
    return result;
  });
}
