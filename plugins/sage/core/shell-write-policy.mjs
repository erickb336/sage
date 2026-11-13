import { shellCommands, programsRun } from "./command-reader.mjs";
import { ghTargets, outputDispatchWrites } from "./output-writes.mjs";
import { GIT_VALUE, gitSubcommand, programName } from "./command-policy.mjs";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

const CODE = /^-(?:[a-z]*[ce]|p|-eval|-print|command)$/;
const WRITE_NAMES = new Set(["less", "tee", "cp", "mv", "rm", "rmdir", "ln", "link", "install", "touch", "dd", "truncate", "rsync", "sponge", "patch", "unlink", "shred", "tar", "unzip", "set-content", "out-file", "add-content", "copy-item", "move-item", "remove-item", "rename-item", "new-item", "ni", "sc", "ac", "del"]);
const READERS = /^(?:cat|grep|egrep|fgrep|rg|head|tail|wc|echo|printf|ls|diff|cut|stat|file|jq|cd|pushd)$/;
const READER_OPTIONS = {
  rg: {
    shortRun: "z", shortValue: "ABCEdefgjmMrtT",
    run: "pre pre-glob search-zip hostname-bin",
    value: "regexp file dfa-size-limit encoding engine max-count regex-size-limit threads glob iglob ignore-file max-depth max-filesize type type-not type-add type-clear after-context before-context color colors context context-separator field-context-separator field-match-separator hyperlink-format max-columns path-separator replace sort sortr generate",
  },
  file: {
    shortRun: "CzZ", shortValue: "efFmMP", prefixes: true,
    run: "compile uncompress uncompress-noreport",
    value: "magic-file exclude exclude-quiet files-from separator parameter",
    flag: "help version brief checking-printout mime apple extension mime-type mime-encoding keep-going list dereference no-dereference no-buffer no-pad print0 preserve-date raw special-files no-sandbox debug",
  },
  diff: {
    shortRun: "l", shortValue: "ACDFILSUWxX", prefixes: true,
    run: "paginate",
    value: "algorithm changed-group-format exclude exclude-from from-file horizon-lines ifdef ignore-matching-lines label line-format new-group-format new-line-format old-group-format old-line-format palette show-function-line starting-file tabsize to-file unchanged-group-format unchanged-line-format width",
    flag: "color context unified binary brief ed expand-tabs forward-ed help ignore-all-space ignore-blank-lines ignore-case ignore-file-name-case ignore-space-change ignore-tab-expansion ignore-trailing-space inhibit-hunk-merge initial-tab left-column minimal new-file no-dereference no-ignore-file-name-case normal rcs recursive report-identical-files sdiff-merge-assist show-c-function side-by-side speed-large-files strip-trailing-cr suppress-blank-empty suppress-common-lines text unidirectional-new-file version -no-directory -presume-output-tty",
  },
};
for (const options of Object.values(READER_OPTIONS)) {
  options.run = new Set(options.run.split(" "));
  options.value = new Set(options.value.split(" "));
  options.names = [...options.run, ...options.value, ...(options.flag ?? "").split(" ")];
}
function readerRuns(name, args) {
  if (!Object.hasOwn(READER_OPTIONS, name)) return false;
  const options = READER_OPTIONS[name];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("="), raw = arg.slice(2, equals < 0 ? undefined : equals);
      let option = raw;
      if (options.prefixes && !options.names.includes(raw)) {
        const matches = options.names.filter(candidate => candidate.startsWith(raw));
        if (matches.length === 1) option = matches[0];
        else if (name === "diff" && (raw === "p" || raw === "pa")) option = "paginate";
      }
      if (options.run.has(option)) return true;
      if (options.value.has(option) && equals < 0) i++;
    } else if (arg.startsWith("-")) {
      for (let k = 1; k < arg.length; k++) {
        if (options.shortRun.includes(arg[k])) return true;
        if (options.shortValue.includes(arg[k])) { if (k === arg.length - 1) i++; break; }
      }
    }
  }
  return false;
}
export const readerDispatch = entry => !entry.wrapper &&
  readerRuns(programName(entry.run.word), entry.run.args);
function toFile({ operator: op, target: to }) {
  if (op === "<" || op === "<&" || (op === ">&" && /^(?:\d+-?|-)$/.test(to))) return false;
  return !/^\/dev\/(?:null|stdout|stderr)$/.test(to);
}
export function uniqWrites(words, base) {
  const at = base.indexOf("uniq");
  if (at < 0) return false;
  if (at !== words.findIndex((w) => !FLOW_WORD.test(w) && !/^\w+=/.test(w)) || base.indexOf("uniq", at + 1) >= 0) return true;
  let operands = 0, options = true;
  for (let k = at + 1; k < words.length; k++) {
    const w = words[k];
    if (options && w === "--") options = false;
    else if (options && /^(?:-[cdDiuz]*[fsw]|--(?:skip-fields|skip-chars|check-chars))$/.test(w)) k++;
    else if (options && /^-./.test(w)) continue;
    else if (/[$`*?[{]/.test(w)) return true;
    else { operands++; options = false; }
  }
  return operands > 1;
}
const runsCode = (base, low) => base.some((w) => /^(?:node|deno|bun|python[\d.]*|perl|ruby|php|osascript|sh|bash|zsh|dash|ksh|fish|pwsh|powershell)$/.test(w)) && low.some((w) => CODE.test(w));
export function inlineCode(text) {
  try {
    return shellCommands(text).some(({ words }) => runsCode(words.map(programName), words.map((w) => w.toLowerCase())));
  } catch {
    return false;
  }
}
const PLACED = new Set(["rm", "rmdir", "touch", "tee", "cp", "mv"]);
function placedTargets(name, args) {
  const end = args.indexOf("--"), options = end < 0 ? args : args.slice(0, end);
  const operands = [...options.filter((a) => !a.startsWith("-")), ...(end < 0 ? [] : args.slice(end + 1))];
  if (!operands.length || options.some((a) => /^-[^-]*t|^--t/.test(a))) return true;
  return name === "cp" ? operands.slice(-1) : operands;
}
function writesIn({ words }, runs, placed) {
  const low = words.map((w) => w.toLowerCase());
  const base = words.map(programName);
  const at = low.findIndex((w) => !/^\w+=/.test(w)), program = base[at] ?? "";
  if (READERS.test(program) || program === "gh") return false;
  if (program === "git") return /^(?:rm|mv)$/.test(gitSubcommand(words, at + 1));
  const has = (re) => base.some((w) => re.test(w) && runs.has(w));
  return (
    base.some((w) => WRITE_NAMES.has(w) && runs.has(w) && !(placed && PLACED.has(w))) || (runs.has("uniq") && uniqWrites(words, base)) ||
    (has(/^g?sed$|^perl$|^ruby$/) && low.some((w) => /^-[a-z]*i|^--in-place/.test(w))) ||
    (has(/^[gmn]?awk$/) && (low.includes("inplace") || words.some(awkWrites))) ||
    (has(/^g?sort$/) && low.some((w) => /^-[a-z]*o|^--o/.test(w))) ||
    (has(/^find$/) && low.some((w) => /^-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(w))) ||
    runsCode(base, low) ||
    /^(?:eval|source|\.|exec)$/.test(base[low.findIndex((w) => !/^\w+=/.test(w))] ?? "")
  );
}
const AWK_RUNS = /\|&?\s*getline\b|\bsystem\s*\(/;
const AWK_PRINTS = /\bprintf?\b[^;{}\n]*[>|]/;
const awkWrites = (word) => {
  const code = word.replace(/>>?\s*"\/dev\/(?:stdout|stderr|null)"/g, "").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  let printed = code;
  for (let last; last !== printed;) [last, printed] = [printed, printed.replace(/\([^()]*\)/g, "")];
  return AWK_RUNS.test(code) || AWK_PRINTS.test(printed);
};
function modeTargets(name, args) {
  const operands = [];
  let reference = false;
  for (let k = 0; k < args.length; k++) {
    const arg = args[k];
    if (arg.startsWith("-") && arg !== "-" && !(name === "chmod" && /^-[rwxXst]+$/.test(arg) && !operands.length && !reference)) {
      if (arg === "--") { operands.push(...args.slice(k + 1)); break; }
      if (/^--reference(?:=|$)/.test(arg)) { reference = true; if (!arg.includes("=")) k++; }
      continue;
    }
    operands.push(arg);
  }
  return reference ? operands : operands.slice(1);
}
const GIT_CHANGES = /^(?:checkout|switch|restore|reset|clean|apply|am|merge|pull|rebase|cherry-pick|revert|commit|add|rm|mv)$/;
const GIT_DRY = { clean: /^(?:-[a-zA-Z]*n[a-zA-Z]*|--dry-run)$/, add: /^(?:-[a-zA-Z]*n[a-zA-Z]*|--dry-run)$/, commit: /^--dry-run$/, apply: /^--(?:check|stat|numstat|summary)$/ };
const BRANCH_CHANGES = /^(?:-[a-zA-Z]*[dDmMcCfu][a-zA-Z]*|--(?:delete|move|copy|force|set-upstream-to|unset-upstream|edit-description)(?:=.*)?)$/;
const BRANCH_VALUE = /^--(?:sort|format|contains|no-contains|merged|no-merged|points-at)$/;
const CONFIG_CHANGES = /^(?:--(?:unset|unset-all|add|replace-all|rename-section|remove-section|edit)|-e)$/;
const CONFIG_VALUE = /^(?:-f|--file|--blob|--type|--default|--comment|--value)$/;
const CONFIG_READS = /^--(?:get|get-all|get-regexp|get-urlmatch|get-color|get-colorbool|list|show-origin|show-scope|name-only|null)$|^-[lz]$/;
function gitDestroys(sub, rest) {
  const options = rest.slice(0, rest.includes("--") ? rest.indexOf("--") : undefined), paths = rest.length - options.length > 1;
  if (sub === "reset") return options.includes("--hard");
  if (sub === "checkout") return paths || options.some((a) => a === "." || /^(?:-f|--force)$/.test(a));
  if (sub === "switch") return options.some((a) => /^(?:-f|--force|--discard-changes)$/.test(a));
  if (sub === "clean") return !options.some((a) => GIT_DRY.clean.test(a)) && options.some((a) => /^(?:-[a-zA-Z]*f[a-zA-Z]*|--force)$/.test(a));
  if (sub !== "restore") return false;
  let staged = false, worktree = false;
  for (let i = 0; i < options.length; i++) {
    const a = options[i];
    if (a === "--staged") staged = true;
    else if (a === "--worktree") worktree = true;
    else if (a === "--source") i++;
    else if (/^-[^-]/.test(a)) {
      for (const c of a.slice(1)) {
        if (c === "S") staged = true;
        if (c === "W") worktree = true;
        if (c === "s") { if (a.endsWith("s") && a.indexOf("s") === a.length - 1) i++; break; }
      }
    }
  }
  return worktree || !staged;
}
function gitTargets(args, destroys = false) {
  let tree = ".", k = 0, other = false;
  for (; args[k]?.startsWith("-"); k++) {
    if (/^--(?:git-dir|work-tree)(?:=|$)/.test(args[k])) other = true;
    if (args[k] === "-C") tree = isAbsolute(args[k + 1] ?? "") ? args[k + 1] : join(tree, args[k + 1] ?? "");
    if (GIT_VALUE.test(args[k])) k++;
  }
  if (destroys && args[k] === "worktree" && args[k + 1] === "remove") return args.slice(k + 2).some((a) => /^(?:-f+|--force)$/.test(a)) ? gitTargets(args) : [];
  if (destroys) return !gitDestroys(args[k] ?? "", args.slice(k + 1)) ? [] : other || [tree];
  if (other) return true;
  const sub = args[k] ?? "", rest = args.slice(k + 1);
  if (GIT_CHANGES.test(sub)) return Object.hasOwn(GIT_DRY, sub) && rest.some((a) => GIT_DRY[sub].test(a)) ? [] : [tree];
  if (sub === "branch") {
    for (let i = 0; i < rest.length; i++) {
      if (BRANCH_VALUE.test(rest[i])) i++;
      else if (BRANCH_CHANGES.test(rest[i])) return [tree];
    }
    return [];
  }
  if (sub === "config") {
    const operands = [];
    let change = false;
    for (let i = 0; i < rest.length; i++) {
      if (CONFIG_CHANGES.test(rest[i])) change = true;
      else if (CONFIG_READS.test(rest[i])) return [];
      else if (CONFIG_VALUE.test(rest[i])) i++;
      else if (!rest[i].startsWith("-")) operands.push(rest[i]);
    }
    change ||= /^(?:set|unset|rename-section|remove-section|edit)$/.test(operands[0] ?? "") || (operands.length > 1 && !/^(?:get|list)$/.test(operands[0]));
    return !change ? [] : rest.some((a) => /^--(?:global|system)$/.test(a)) ? true : [tree];
  }
  if (sub === "worktree" && /^(?:add|move|remove)$/.test(rest[0] ?? "")) {
    const paths = [];
    for (let i = 1; i < rest.length; i++) {
      if (/^(?:-b|-B|--reason)$/.test(rest[i])) i++;
      else if (!rest[i].startsWith("-")) paths.push(rest[i]);
    }
    const changed = rest[0] === "move" ? paths.slice(0, 2) : paths.slice(0, 1);
    return changed.length ? changed.map((p) => (isAbsolute(p) ? p : join(tree, p))) : true;
  }
  return [];
}
function realPath(path) {
  try { return realpathSync.native(path); } catch { return dirname(path) === path ? path : join(realPath(dirname(path)), basename(path)); }
}
function intoScratch({ target, dir, uncertainDirectory }, cwd, scratch, { home, guard = [] } = {}) {
  const word = home && /^~(?:\/|$)/.test(target) ? home + target.slice(1) : target;
  if (!scratch.length || uncertainDirectory || /[$`*?[\]{}~!]/.test(word)) return false;
  const absolute = resolve(dir ?? cwd, word), project = mainCheckout(realPath(resolve(cwd)));
  return [...new Set([join(realPath(dirname(absolute)), basename(absolute)), realPath(absolute)])].every((path) => {
    const under = (folder) => path.startsWith(folder.endsWith(sep) ? folder : folder + sep);
    return path !== project && !under(project) && !project.startsWith(path.endsWith(sep) ? path : path + sep) &&
      scratch.some((folder) => under(realPath(resolve(folder)))) && !inWorkTree(path, guard);
  });
}
const WALK_MAX = 2000;
function inWorkTree(path, guard) {
  const root = guard.map((folder) => realPath(resolve(folder))).find((folder) => path === folder || path.startsWith(folder + sep));
  if (!root) return false;
  for (let dir = path; dir.startsWith(root + sep); dir = dirname(dir)) if (existsSync(join(dir, ".git"))) return true;
  const folders = [path];
  for (let i = 0; i < folders.length; i++) {
    if (i === WALK_MAX) return true;
    let entries;
    try { entries = readdirSync(folders[i], { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name === ".git") return true;
      if (entry.isDirectory()) folders.push(join(folders[i], entry.name));
    }
  }
  return false;
}
function mainCheckout(folder) {
  for (let dir = folder; ; dir = dirname(dir)) {
    const marker = join(dir, ".git"), stat = statSync(marker, { throwIfNoEntry: false });
    if (stat?.isFile()) {
      const gitdir = /^gitdir: (.+)$/m.exec(readFileSync(marker, "utf8"))?.[1].trim(), worktrees = gitdir && dirname(resolve(dir, gitdir));
      return worktrees && basename(worktrees) === "worktrees" && basename(dirname(worktrees)) === ".git" ? realPath(dirname(dirname(worktrees))) : dir;
    }
    if (stat) return dir;
    if (dirname(dir) === dir) return folder;
  }
}
function inProject({ target, dir, uncertainDirectory }, cwd) {
  if (/^~(?:\/|$)/.test(target)) return false;
  if (/[$`]/.test(target) || (uncertainDirectory && !isAbsolute(target))) return true;
  const cut = target.search(/[*?[{]/), literal = cut < 0 ? target : target.slice(0, target.lastIndexOf("/", cut) + 1);
  const path = realPath(resolve(dir ?? cwd, literal || ".")), project = realPath(resolve(cwd));
  return path === project || path.startsWith(project.endsWith(sep) ? project : project + sep);
}
export function commandWrites(text, cwd, scratch = [], { readOnly = false, placed = false, home, guard } = {}) {
  const place = { home, guard };
  if (typeof text !== "string") return true;
  try {
    const commands = shellCommands(text);
    const evidence = programsRun(text, cwd, undefined, { contextEvidence: true, redirectParts: true });
    const runs = new Set(evidence.programs.map(({ run }) => programName(run.word)));
    if (commands.some((command) => writesIn(command, runs, placed))) return true;
    const placeWrites = (entry, i) => {
      const name = programName(entry.run.word);
      if (placed && PLACED.has(name)) return Boolean(evidence.programs[i - 1]?.wrapper) || outsideScratch(placedTargets(name, entry.run.args), entry, cwd, scratch, place);
      if (/^(?:chmod|chown|chgrp|chflags)$/.test(name)) return modeTargets(name, entry.run.args).some((target) => inProject(at(entry, target), cwd));
      return outsideScratch(name === "gh" ? ghTargets(entry.run.args) : readOnly && name === "git" ? gitTargets(entry.run.args) : [], entry, cwd, scratch, place);
    };
    return evidence.redirects.some(r => toFile(r) && !intoScratch(r, cwd, scratch, place)) || evidence.programs.some((entry, i) => readerDispatch(entry) || outputDispatchWrites(entry) || placeWrites(entry, i));
  } catch {
    return true;
  }
}
const at = ({ run, uncertainDirectory }, target) => ({ target, dir: run.dir, uncertainDirectory });
const outsideScratch = (targets, entry, cwd, scratch, place) => targets === true || targets.some((target) => !intoScratch(at(entry, target), cwd, scratch, place));
export function gitDestroysWork(text, cwd, scratch = [], guard = []) {
  try {
    return programsRun(text, cwd, undefined, { contextEvidence: true }).programs.some((entry) => programName(entry.run.word) === "git" && outsideScratch(gitTargets(entry.run.args, true), entry, cwd, scratch, { guard }));
  } catch {
    return false;
  }
}

const FLOW_WORD = /^(?:if|then|elif|else|fi|for|while|until|do|done|select|case|esac|function|time|coproc|\{|\}|\[\[|!)$/;
const REDEFINES = /^(?:export|unset|readonly|declare|typeset|local|set|shopt|setopt|alias|unalias|hash|enable|builtin|command|eval|source|\.)$/;
const GIT_READS = /^(?:log|show|status|diff|rev-parse)$/;
const shellQuoted = (word) => (/^[\w./=:@%+,-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`);
const plainReader = ({ words }, cwd) =>
  (words[0] === "git" ? GIT_READS.test(words[1] ?? "") : READERS.test(words[0] ?? "") && !/^(?:cd|pushd)$/.test(words[0])) &&
  !commandWrites(words.map(shellQuoted).join(" "), cwd);

export function shellWriteEvidence(text, cwd, path) {
  try {
    const commands = shellCommands(text, { provenance: true });
    const evidence = programsRun(text, cwd, path, { contextEvidence: true, redirectParts: true });
    const writes = evidence.redirects.filter(toFile);
    if (writes.some(r => r.uncertainDirectory || /[$`*?\[\]{}~!]/.test(r.target))) return { uncertain: true };
    if (!commands.length || commands.some(c => c.host || c.grouped || FLOW_WORD.test(c.words[0] ?? "") ||
      REDEFINES.test(c.words[0] ?? "") || c.syntax.some(s => s.assignment) ||
      c.wordLiterals.some(literal => !literal) || c.bodyLiterals.some(literal => !literal) || c.redirectLiterals.some(literal => !literal) ||
      (c.words.length && !plainReader(c, cwd) && !/^(?:cd|pushd)$/.test(c.words[0])) ||
      (c.words[0] === "printf" && (c.words.slice(1).some(word => /^-v/.test(word)) ||
        /%[^%]*n/.test(c.words[c.words[1] === "--" ? 2 : 1] ?? ""))))) return undefined;
    if (evidence.programs.some(p => p.wrapper || p.uncertainDirectory)) return undefined;
    const reads = evidence.programs.flatMap(({ run }) => /^(?:echo|printf)$/.test(run.word) ? [] :
      [run.word, ...run.args].map(word => ({ word, dir: run.dir ?? cwd })));
    reads.push(...evidence.redirects.filter(r => !toFile(r)).map(r => ({ word: r.target, dir: r.dir ?? cwd })));
    return { reads, writes: writes.map(r => ({ word: r.target, dir: r.dir ?? cwd })) };
  } catch { return undefined; }
}
