import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { readLocalGit } from "./local-git.mjs";

export const AST_GREP_VERSION = "0.51.1";
export const LINT_CONFIG = "sgconfig.yml";
export const LINT_KINDS = ["lint-pass", "lint-fail"];
const BASE_BRANCH = "refs/remotes/origin/main";
const SUPPRESSION = ["ast-grep", "ignore"].join("-");
const NO_IGNORE = ["hidden", "dot", "exclude", "global", "parent", "vcs"].flatMap((kind) => ["--no-ignore", kind]);
const REGULAR = /^100(644|755)$/;
const NOT_CODE = { "120000": "a symbolic link: it holds a path, not code", "160000": "a submodule" };
const UTF8 = new TextDecoder("utf-8", { fatal: true });
export const LINT_MAX_BYTES = 10 * 1024 * 1024;
const BATCH_BYTES = 64 * 1024 * 1024;
const BIG = { maxBuffer: 1 << 28, timeout: 300_000 };
const ALL = "all";
const TOO_LARGE = "sage-lint-too-large-";

export function astGrepBinary(project, tools) {
  for (const folder of [project, tools]) {
    const path = join(folder, "node_modules", ".bin", "ast-grep");
    if (!existsSync(path)) continue;
    const run = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 10_000 });
    if (run.status === 0 && run.stdout.trim() === `ast-grep ${AST_GREP_VERSION}`) return path;
  }
  return null;
}

export function astGrepScan(binary, { config, cwd, paths, args = [] }) {
  const run = spawnSync(binary, ["scan", "--config", config, "--color", "never", "--json=stream", "--inspect", "entity", ...args, "--", ...paths], { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
  if (run.error) throw new Error(`ast-grep could not run (${run.error.code ?? run.error.message})`);
  const errors = run.stderr.split("\n").filter((line) => /^(ERROR|Error: (?!\d+ error\(s\) found in code))/.test(line));
  if ((run.status !== 0 && run.status !== 1) || errors.length) throw Object.assign(new Error(`ast-grep scan exited with ${run.status ?? run.signal}: ${(errors.join(" ") || run.stderr.trim()).slice(0, 2000)}`), { stderr: run.stderr });
  const files = new Map();
  for (const line of run.stderr.split("\n")) {
    const m = /^sg: entity\|file\|(.*): (?:language=([^,]+),appliedRuleCount=(\d+)|skipped=(\w+))$/.exec(line);
    if (!m) continue;
    const file = files.get(m[1]) ?? files.set(m[1], { languages: [], rules: 0, skipped: null }).get(m[1]);
    if (m[4]) file.skipped = m[4];
    else file.languages.push(m[2]), (file.rules += Number(m[3]));
  }
  const matches = run.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { matches, files };
}

export const skippedText = (reason) => `ast-grep skipped this file (${reason}), so no rule checked it. ${reason === "invalidUtf8" ? "Save it as UTF-8" : reason === "fileTooLarge" ? "Split it into smaller files" : "Fix the file"}, or mark it linguist-generated or linguist-vendored in the .gitattributes of origin/main.`;

const fault = (message, fix) => Object.assign(new Error(message), { fix });
const MAIN_FIX = `Fix ${LINT_CONFIG} and the rules on origin/main, then lint again.`;

export function lintBase(project) {
  const read = (folder, args) => {
    try {
      return readLocalGit(folder, args).toString();
    } catch (e) {
      if (typeof e?.status !== "number") throw e;
      return null;
    }
  };
  const top = read(project, ["rev-parse", "--show-toplevel"])?.replace(/\n$/, "") ?? project;
  const main = read(top, ["rev-parse", "--verify", "--end-of-options", `${BASE_BRANCH}^{commit}`])?.trim();
  if (!main) return { top, main: null, config: null, local: lstatSync(join(top, LINT_CONFIG), { throwIfNoEntry: false }) !== undefined };
  const [entry] = readLocalGit(top, ["ls-tree", "-z", main, "--", LINT_CONFIG]).toString().split("\0").filter(Boolean);
  return { top, main, config: entry ? entry.split(/[ \t]/)[0] : null };
}

export function lintChange(project, sha, binary, at = lintBase(project)) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`${JSON.stringify(sha)} is not a full commit SHA`);
  const { top, main, config } = at;
  if (!main || !config) return at;
  if (!REGULAR.test(config)) throw fault(`${LINT_CONFIG} at the root of origin/main ${main.slice(0, 7)} is not a regular file`, MAIN_FIX);
  const git = (args, input) => readLocalGit(top, args, input, BIG);
  const status = (args, code, error) => {
    try {
      return git(args).toString().trim();
    } catch (e) {
      if (e?.status === code) throw error;
      throw e;
    }
  };
  status(["cat-file", "-e", `${sha}^{commit}`], 128, fault(`the commit ${sha.slice(0, 7)} is not in ${top}`, "Fetch the head (git fetch origin), then lint again."));
  const base = status(["merge-base", main, sha], 1, fault(`${sha.slice(0, 7)} shares no history with origin/main ${main.slice(0, 7)}`, "Start the branch from origin/main, then lint again."));
  const work = mkdtempSync(join(realpathSync(tmpdir()), "sage-lint-"));
  try {
    const rules = join(work, "rules"), head = join(work, "head");
    const yaml = treeOf(git(["ls-tree", "-r", "-z", "-l", "--full-tree", main])).filter((e) => REGULAR.test(e.mode) && /\.ya?ml$/i.test(e.path));
    const copy = (e, text) => {
      const full = inside(rules, e.path);
      if (!full) throw fault(`origin/main holds a path outside its tree: ${JSON.stringify(e.path)}`, MAIN_FIX);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    };
    const large = yaml.filter((e) => e.size > LINT_MAX_BYTES);
    eachBlob(git, yaml.filter((e) => e.size <= LINT_MAX_BYTES), copy);
    large.forEach((e, i) => copy(e, `${TOO_LARGE}${i}: [\n`));
    const scan = (cwd, paths) => {
      if (!paths.length) return { matches: [], files: new Map() };
      try {
        return astGrepScan(binary, { config: join(rules, LINT_CONFIG), cwd, paths, args: NO_IGNORE });
      } catch (e) {
        const hit = large.filter((l, i) => e.stderr?.includes(`${TOO_LARGE}${i}: [`));
        if (hit.length) throw fault(`origin/main ${main.slice(0, 7)} has ${hit.map((l) => `${l.path} (${mib(l.size)} MiB)`).join(", ")} in a rule or util folder of ${LINT_CONFIG}, more than the ${mib(LINT_MAX_BYTES)} MiB that lint reads, so its rules cannot run`, `Split ${hit.length === 1 ? "it" : "them"} into smaller files on origin/main, then lint again.`);
        throw fault(e.message, `Fix the rule or ${LINT_CONFIG} on origin/main that the message names, then lint again.`);
      }
    };
    const problems = [], notChecked = [];
    const named = changesOf(git(["diff", "--raw", "-z", "--no-abbrev", "--no-renames", "--no-color", "--diff-filter=AMT", base, sha])).filter((c) => {
      const why = nameProblem(c.path);
      if (why) problems.push({ file: JSON.stringify(c.path.toString("latin1")), text: why });
      return !why;
    }).map((c) => ({ ...c, path: UTF8.decode(c.path) }));
    const marked = attributes(git, main, named.map((c) => c.path));
    const code = named.filter((c) => {
      const why = NOT_CODE[c.mode] ?? (marked.get(c.path) && `${marked.get(c.path)} in the .gitattributes of origin/main`);
      if (why) notChecked.push({ file: c.path, why });
      return !why;
    }).filter((c) => {
      const why = putOne(head, c.path, "\n");
      if (why) problems.push({ file: c.path, text: why });
      return !why;
    });
    const probe = scan(head, code.map((c) => c.path)).files;
    const ruled = code.filter((c) => {
      const seen = probe.get(c.path);
      const why = !seen ? "no language of ast-grep" : !seen.rules ? `no rule of ${LINT_CONFIG} for ${[...new Set(seen.languages)].join(", ")}` : "";
      if (why) notChecked.push({ file: c.path, why });
      return !why;
    });
    const sizes = sizesOf(git, ruled.flatMap((c) => (c.oldOid && REGULAR.test(c.oldMode) ? [c.oid, c.oldOid] : [c.oid])));
    const files = ruled.filter((c) => {
      const size = sizes.get(c.oid);
      if (size > LINT_MAX_BYTES) problems.push({ file: c.path, text: `it is ${mib(size)} MiB, more than the ${mib(LINT_MAX_BYTES)} MiB that lint scans, so no rule checked it. Split it into smaller files, or mark it linguist-generated or linguist-vendored in the .gitattributes of origin/main.` });
      return size <= LINT_MAX_BYTES;
    }).map((c) => {
      const checkedBefore = REGULAR.test(c.oldMode) && sizes.get(c.oldOid) <= LINT_MAX_BYTES;
      return { ...c, size: sizes.get(c.oid), lines: !checkedBefore ? ALL : c.oldOid === c.oid ? new Set() : addedLines(git(["diff", "-U0", "--text", "--no-color", "--no-ext-diff", "--no-textconv", c.oldOid, c.oid])) };
    }).filter((c) => c.lines === ALL || c.lines.size);
    const suppressed = new Set();
    eachBlob(git, files, (c, text) => {
      if (text.includes(SUPPRESSION)) suppressed.add(c.path);
      writeFileSync(join(head, c.path), text);
    });
    const result = scan(head, files.map((c) => c.path));
    let checked = 0;
    for (const c of files) {
      const skipped = result.files.get(c.path)?.skipped;
      if (skipped) {
        if (skipped !== "emptyFile") problems.push({ file: c.path, text: skippedText(skipped) });
      } else {
        checked++;
        if (suppressed.has(c.path)) problems.push({ file: c.path, text: `it holds ${SUPPRESSION}, which hides lines from the rules, so the whole file fails. Remove it.` });
      }
    }
    const lines = new Map(files.map((c) => [c.path, c.lines]));
    for (const m of result.matches) {
      const added = lines.get(m.file);
      const hit = added && Array.from({ length: m.range.end.line - m.range.start.line + 1 }, (_, k) => m.range.start.line + 1 + k).find((n) => added === ALL || added.has(n));
      if (hit) problems.push({ file: m.file, line: hit, text: `${String(m.message ?? "").trim() || "a match"} (${m.ruleId}, ${m.severity})` });
    }
    const order = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : (a.line ?? 0) - (b.line ?? 0));
    problems.sort(order);
    notChecked.sort(order);
    return { main, base, config, checked, problems, notChecked };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const mib = (bytes) => Math.round((bytes / 1048576) * 10) / 10;

function treeOf(out) {
  return out.toString("latin1").split("\0").filter(Boolean).map((entry) => {
    const tab = entry.indexOf("\t"), meta = entry.slice(0, tab), path = entry.slice(tab + 1);
    const [mode, , oid, size] = meta.split(/ +/);
    return { mode, oid, size: Number(size), path: Buffer.from(path, "latin1").toString("utf8") };
  });
}

function sizesOf(git, oids) {
  const sizes = new Map();
  if (!oids.length) return sizes;
  for (const line of git(["cat-file", "--batch-check"], `${oids.join("\n")}\n`).toString("latin1").split("\n").filter(Boolean)) {
    const [oid, type, size] = line.split(" ");
    if (type !== "blob") throw new Error(`git cat-file gave ${JSON.stringify(line)}`);
    sizes.set(oid, Number(size));
  }
  return sizes;
}

function eachBlob(git, items, each) {
  for (let i = 0; i < items.length;) {
    const batch = [];
    for (let bytes = 0; i < items.length && (!batch.length || bytes + items[i].size <= BATCH_BYTES); i++) batch.push(items[i]), (bytes += items[i].size);
    const out = git(["cat-file", "--batch"], `${batch.map((e) => e.oid).join("\n")}\n`);
    let at = 0;
    for (const item of batch) {
      const end = out.indexOf(0x0a, at), head = out.toString("latin1", at, end).split(" ");
      if (head[0] !== item.oid || head[1] !== "blob") throw new Error(`git cat-file gave ${JSON.stringify(head.join(" "))} for ${item.oid}`);
      const size = Number(head[2]);
      each(item, out.subarray(end + 1, end + 1 + size));
      at = end + 1 + size + 1;
    }
  }
}

function inside(root, path) {
  const full = resolve(root, path);
  return full.startsWith(root + sep) ? full : null;
}

function putOne(root, path, text) {
  const full = inside(root, path);
  if (!full) return "its path leaves the tree, so the scan cannot hold it. Rename it.";
  try {
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, { flag: "wx" });
  } catch (e) {
    if (["EEXIST", "ENOTDIR", "EISDIR"].includes(e.code)) return "another changed file has the same name on this file system (a name that differs only in case or in its Unicode form), so the scan cannot hold both. Rename one of them.";
    throw e;
  }
}

function nameProblem(path) {
  let name;
  try {
    name = UTF8.decode(path);
  } catch {
    return "its name is not UTF-8, so ast-grep cannot name it. Rename it.";
  }
  return /[\x00-\x1f\x7f]/.test(name) ? "its name holds a control character, such as a line break, so ast-grep cannot name it. Rename it." : "";
}

function changesOf(out) {
  const raw = [];
  for (let at = 0; at < out.length;) {
    const end = out.indexOf(0, at), [oldMode, mode, oldOid, oid] = out.toString("latin1", at + 1, end).split(" ");
    const stop = out.indexOf(0, end + 1);
    raw.push({ mode, oid, oldMode, oldOid: /^0+$/.test(oldOid) ? null : oldOid, path: out.subarray(end + 1, stop) });
    at = stop + 1;
  }
  return raw;
}

function addedLines(out) {
  const lines = new Set();
  for (const line of out.toString("latin1").split("\n")) {
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) for (let n = Number(hunk[1]), end = n + Number(hunk[2] ?? 1); n < end; n++) lines.add(n);
  }
  return lines;
}

function attributes(git, main, paths) {
  if (!paths.length) return new Map();
  const out = git(["-c", "core.attributesFile=/dev/null", "check-attr", "-z", "--stdin", "--source", main, "linguist-generated", "linguist-vendored"], `${paths.join("\0")}\0`).toString("utf8").split("\0");
  const marked = new Map();
  for (let k = 0; k + 2 < out.length; k += 3) if (["set", "true"].includes(out[k + 2]) && !marked.has(out[k])) marked.set(out[k], out[k + 1]);
  return marked;
}
