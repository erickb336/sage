import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  if ((run.status !== 0 && run.status !== 1) || errors.length) throw new Error(`ast-grep scan exited with ${run.status ?? run.signal}: ${(errors.join(" ") || run.stderr.trim()).slice(0, 2000)}`);
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

export const skippedText = (reason) => `ast-grep skipped this file (${reason}), so no rule checked it. ${reason === "invalidUtf8" ? "Save it as UTF-8" : reason === "fileTooLarge" ? "Split it into smaller files" : "Fix the file"}, or mark it linguist-generated or linguist-vendored in the base's .gitattributes.`;

export function lintBase(project, sha) {
  const git = (args) => readLocalGit(project, args).toString();
  let main;
  try {
    main = git(["rev-parse", "--verify", "--end-of-options", `${BASE_BRANCH}^{commit}`]).trim();
  } catch (e) {
    if (typeof e?.status !== "number") throw e;
    return { base: null };
  }
  const base = git(["merge-base", main, sha]).trim();
  const [entry] = git(["ls-tree", "-z", base, "--", LINT_CONFIG]).split("\0").filter(Boolean);
  return { base, config: entry ? entry.split(/[ \t]/)[0] : null };
}

export function lintChange(project, sha, binary) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`${JSON.stringify(sha)} is not a full commit SHA`);
  const { base, config } = lintBase(project, sha);
  if (!base || !config) return { base, config };
  if (!REGULAR.test(config)) throw new Error(`${LINT_CONFIG} at the root of the base ${base.slice(0, 7)} is not a regular file`);
  const git = (args, input) => readLocalGit(project, args, input);
  const work = mkdtempSync(join(realpathSync(tmpdir()), "sage-lint-"));
  try {
    const rules = join(work, "base"), head = join(work, "head");
    const yaml = treeOf(git(["ls-tree", "-r", "-z", "--full-tree", base])).filter((e) => REGULAR.test(e.mode) && /\.ya?ml$/i.test(e.path));
    put(rules, yaml, blobs(git, yaml.map((e) => e.oid)));
    const problems = [], notChecked = [];
    const changed = changesOf(git(["diff", "--patch-with-raw", "-z", "--no-abbrev", "-U0", "-M", "--text", "--no-color", "--no-ext-diff", "--no-textconv", "--diff-filter=AMRT", base, sha]))
      .filter((c) => c.lines.size);
    const named = changed.filter((c) => {
      const why = nameProblem(c.path);
      if (why) problems.push({ file: JSON.stringify(c.path.toString("latin1")), text: why });
      return !why;
    }).map((c) => ({ ...c, path: UTF8.decode(c.path) }));
    const marked = attributes(git, base, named.map((c) => c.path));
    const files = named.filter((c) => {
      const why = NOT_CODE[c.mode] ?? (marked.get(c.path) && `${marked.get(c.path)} in the base's .gitattributes`);
      if (why) notChecked.push({ file: c.path, why });
      return !why;
    });
    blobs(git, files.map((c) => c.oid)).forEach((text, i) => (files[i].text = text));
    const written = files.filter((c) => {
      const why = putOne(head, c.path, c.text);
      if (why) problems.push({ file: c.path, text: why });
      return !why;
    });
    const scan = written.length ? astGrepScan(binary, { config: join(rules, LINT_CONFIG), cwd: head, paths: written.map((c) => c.path), args: NO_IGNORE }) : { matches: [], files: new Map() };
    let checked = 0;
    for (const c of written) {
      const seen = scan.files.get(c.path);
      if (seen?.skipped) {
        if (seen.skipped !== "emptyFile") problems.push({ file: c.path, text: skippedText(seen.skipped) });
      } else if (!seen) notChecked.push({ file: c.path, why: "no language of ast-grep" });
      else if (!seen.rules) notChecked.push({ file: c.path, why: `no rule of ${LINT_CONFIG} for ${[...new Set(seen.languages)].join(", ")}` });
      else {
        checked++;
        if (c.text.includes(SUPPRESSION)) problems.push({ file: c.path, text: `it holds ${SUPPRESSION}, which hides lines from the rules, so the whole file fails. Remove it.` });
      }
    }
    const lines = new Map(written.map((c) => [c.path, c.lines]));
    for (const m of scan.matches) {
      const added = lines.get(m.file);
      const hit = added && Array.from({ length: m.range.end.line - m.range.start.line + 1 }, (_, k) => m.range.start.line + 1 + k).find((n) => added.has(n));
      if (hit) problems.push({ file: m.file, line: hit, text: `${String(m.message ?? "").trim() || "a match"} (${m.ruleId}, ${m.severity})` });
    }
    const order = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : (a.line ?? 0) - (b.line ?? 0));
    problems.sort(order);
    notChecked.sort(order);
    return { base, config, checked, problems, notChecked };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function treeOf(out) {
  return out.toString("latin1").split("\0").filter(Boolean).map((entry) => {
    const tab = entry.indexOf("\t"), meta = entry.slice(0, tab), path = entry.slice(tab + 1);
    const [mode, , oid] = meta.split(" ");
    return { mode, oid, path: Buffer.from(path, "latin1").toString("utf8") };
  });
}

function blobs(git, oids) {
  if (!oids.length) return [];
  const out = git(["cat-file", "--batch"], `${oids.join("\n")}\n`);
  const texts = [];
  let at = 0;
  for (const oid of oids) {
    const end = out.indexOf(0x0a, at), head = out.toString("latin1", at, end).split(" ");
    if (head[0] !== oid || head[1] !== "blob") throw new Error(`git cat-file gave ${JSON.stringify(head.join(" "))} for ${oid}`);
    const size = Number(head[2]);
    texts.push(out.subarray(end + 1, end + 1 + size));
    at = end + 1 + size + 1;
  }
  return texts;
}

function inside(root, path) {
  const full = resolve(root, path);
  return full.startsWith(root + sep) ? full : null;
}

function put(root, entries, texts) {
  entries.forEach((e, i) => {
    const full = inside(root, e.path);
    if (!full) throw new Error(`the base holds a path outside its tree: ${JSON.stringify(e.path)}`);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, texts[i]);
  });
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
  let at = 0;
  while (at < out.length && out[at] === 0x3a) {
    const end = out.indexOf(0, at), [, mode, , oid, status] = out.toString("latin1", at + 1, end).split(" ");
    at = end + 1;
    const paths = [];
    for (let k = /^[RC]/.test(status) ? 2 : 1; k > 0; k--) {
      const stop = out.indexOf(0, at);
      paths.push(out.subarray(at, stop));
      at = stop + 1;
    }
    raw.push({ mode, oid, path: paths.at(-1), lines: new Set() });
  }
  if (raw.length && out[at++] !== 0) throw new Error("git diff gave no end to its file list");
  let file = -1;
  for (const line of out.toString("latin1", at).split("\n")) {
    if (line.startsWith("diff --git ")) file++;
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && raw[file]) for (let n = Number(hunk[1]), end = n + Number(hunk[2] ?? 1); n < end; n++) raw[file].lines.add(n);
  }
  if (file + 1 !== raw.length) throw new Error(`git diff gave ${raw.length} files and ${file + 1} patches`);
  return raw;
}

function attributes(git, base, paths) {
  if (!paths.length) return new Map();
  const out = git(["-c", "core.attributesFile=/dev/null", "check-attr", "-z", "--stdin", "--source", base, "linguist-generated", "linguist-vendored"], `${paths.join("\0")}\0`).toString("utf8").split("\0");
  const marked = new Map();
  for (let k = 0; k + 2 < out.length; k += 3) if (["set", "true"].includes(out[k + 2]) && !marked.has(out[k])) marked.set(out[k], out[k + 1]);
  return marked;
}
