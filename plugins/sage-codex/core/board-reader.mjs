// Read-only input boundary for the shared board. Callers supply roots explicitly.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { validateObservations } from "./observations.mjs";
import { nameProblem } from "./logbook-fields.mjs";

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
  return lines.map(line => {
    const cells = line.split("\t");
    if (cells.length !== columns.length) throw new Error("damaged table row");
    const row = Object.fromEntries(columns.map((column, i) => [column, cells[i]]));
    if (name === "tasks") {
      if (!/^T[1-9]\d*$/.test(row.id) || identities.has(row.id) || !TASK_STATES.has(row.state)) throw new Error("damaged task identity or state");
      identities.add(row.id);
    }
    return row;
  });
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

/** Missing or damaged input is a diagnostic, never a silently empty board. */
export function readBoardSources(sources, { now = Date.now() } = {}) {
  if (!Array.isArray(sources) || sources.length > 32) throw new TypeError("board sources must be an array of at most 32 roots");
  const budget = { remaining: MAX_READ };
  const ids = new Set(), identities = new Set();
  return sources.map(source => {
    if (!source || !/^[a-zA-Z0-9_-]{1,80}$/.test(source.id ?? "") || ids.has(source.id) || !isAbsolute(source.path ?? "")) throw new TypeError("each board source needs a unique id and an absolute path");
    ids.add(source.id);
    const result = { id: source.id, label: source.label ?? source.id, provider: source.provider ?? null, config: {}, projects: [], diagnostics: [] };
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
        const project = { key: `${source.id}/${entry.name}`, source: source.id, name: entry.name, tables: {}, diagnostics: [] };
        result.projects.push(project);
        if (!entry.isDirectory() || entry.isSymbolicLink()) { project.diagnostics.push("project is not a directory"); continue; }
        const directory = join(source.path, entry.name), before = lstatSync(directory);
        for (const name of Object.keys(TABLES)) {
          try { project.tables[name] = table(join(source.path, entry.name, `${name}.tsv`), name, budget); }
          catch (error) { project.diagnostics.push(`${name}: ${error.code ?? error.message}`); }
        }
        try { project.observations = validateObservations(parseJson(regular(join(directory, "observations.json"), budget)), { now }); }
        catch (error) {
          project.observations = { version: 1, records: [] };
          if (error.code !== "ENOENT") project.diagnostics.push(`observations: ${error.code ?? error.message}`);
        }
        try { project.checkout = regular(join(directory, "checkout.txt"), budget).trim(); }
        catch (error) { if (error.code !== "ENOENT") project.diagnostics.push(`checkout: ${error.code ?? error.message}`); }
        // The PR link needs the checkout's GitHub origin, and the project's name may come from its upstream. Read its Git
        // config as a file; run no Git command. No remote: no link.
        const remotes = (() => { try { return isAbsolute(project.checkout ?? "") ? githubRemotes(regular(join(project.checkout, ".git", "config"), budget)) : {}; } catch { return {}; } })();
        project.repository = remotes.origin ?? null;
        project.upstream = remotes.upstream ?? null;
        // The owner's settings of this logbook (sage config name= and archived=), checked again: a bad name is not shown.
        project.archived = false;
        try {
          const config = parseJson(regular(join(directory, "config.json"), budget));
          if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("config is not an object");
          const why = config.name === undefined ? null : nameProblem(config.name);
          if (why) project.diagnostics.push(`config: the name ${why}`);
          else if (config.name !== undefined) project.displayName = config.name;
          if (config.archived !== undefined && typeof config.archived !== "boolean") project.diagnostics.push("config: archived is not true or false");
          project.archived = config.archived === true;
        } catch (error) { if (error.code !== "ENOENT") project.diagnostics.push(`config: ${error.code ?? error.message}`); }
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
      const after = lstatSync(source.path);
      if (after.dev !== root.dev || after.ino !== root.ino || !after.isDirectory()) throw new Error("source changed during the read");
    } catch (error) { result.diagnostics.push(error.code ?? error.message); result.projects = []; }
    return result;
  });
}
