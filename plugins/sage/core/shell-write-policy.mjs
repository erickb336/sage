// Shared write classification from the existing hook rules. This never executes command text.
import { shellCommands, programsRun } from "./command-reader.mjs";
import { ghTargets, outputDispatchWrites } from "./output-writes.mjs";
import { GIT_VALUE, gitSubcommand, programName } from "./command-policy.mjs";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

const CODE = /^-(?:[a-z]*[ce]|p|-eval|-print|command)$/;
/**
 * The commands that write, move, remove or link a file, also in PowerShell (case does not matter there). less -o FILE
 * writes, so less always counts; uniq has its own rule (uniqWrites). A name counts only as a program that the command
 * runs, also through a wrapper (xargs rm, env rm): as an argument it is data, so "npm install", "man tee" and a state-tool
 * note "--why rm" write nothing (F-T960-3).
 */
const WRITE_NAMES = new Set(["less", "tee", "cp", "mv", "rm", "rmdir", "ln", "link", "install", "touch", "dd", "truncate", "rsync", "sponge", "patch", "unlink", "shred", "tar", "unzip", "set-content", "out-file", "add-content", "copy-item", "move-item", "remove-item", "rename-item", "new-item", "ni", "sc", "ac", "del"]);
/** The commands that only read: their words name no command to run, so only a redirection makes them write. */
const READERS = /^(?:cat|grep|egrep|fgrep|rg|head|tail|wc|echo|printf|ls|diff|cut|stat|file|jq|cd|pushd)$/;
/** Audited option grammars: rg 15.2, file 5.46/macOS, and GNU diff 3.12/Apple diff. */
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
    // Optional long values attach with '='; they never consume the next option.
    flag: "color context unified binary brief ed expand-tabs forward-ed help ignore-all-space ignore-blank-lines ignore-case ignore-file-name-case ignore-space-change ignore-tab-expansion ignore-trailing-space inhibit-hunk-merge initial-tab left-column minimal new-file no-dereference no-ignore-file-name-case normal rcs recursive report-identical-files sdiff-merge-assist show-c-function side-by-side speed-large-files strip-trailing-cr suppress-blank-empty suppress-common-lines text unidirectional-new-file version -no-directory -presume-output-tty",
  },
};
for (const options of Object.values(READER_OPTIONS)) {
  options.run = new Set(options.run.split(" "));
  options.value = new Set(options.value.split(" "));
  options.names = [...options.run, ...options.value, ...(options.flag ?? "").split(" ")];
}
/** Only actual option positions count. Values and all words after '--' remain data. */
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
        // Apple diff accepts these; GNU's separate palette option makes them ambiguous there.
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
/** Only a reader's own run owns its options; a wrapper's entry does not. */
export const readerDispatch = entry => !entry.wrapper &&
  readerRuns(programName(entry.run.word), entry.run.args);
/** Keep operator and target separate: quoted filename prefixes are not shell operators. */
function toFile({ operator: op, target: to }) {
  if (op === "<" || op === "<&" || (op === ">&" && /^(?:\d+-?|-)$/.test(to))) return false;
  return !/^\/dev\/(?:null|stdout|stderr)$/.test(to);
}
/**
 * uniq [option]... [input [output]] writes only its second operand (T670): uniq IN and uniq -c IN read. It counts as a
 * write when uniq is not the command's own word (xargs uniq, env uniq), when an operand can expand to more words ($, a
 * backtick or a pattern), or when it has two operands. -f, -s and -w take the next word; after the first operand every
 * word is an operand, as BSD uniq reads them; an unknown option that takes a value makes its value an operand (fail closed).
 */
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
/** Does a command run inline code: an interpreter or a shell with a code option (node -e, python -c, sh -c)? The hook cannot read that code, so it counts as a write. */
const runsCode = (base, low) => base.some((w) => /^(?:node|deno|bun|python[\d.]*|perl|ruby|php|osascript|sh|bash|zsh|dash|ksh|fish|pwsh|powershell)$/.test(w)) && low.some((w) => CODE.test(w));
/** Does a command line run inline code (runsCode) in one of its commands? A line that the reader cannot read does not (T947). */
export function inlineCode(text) {
  try {
    return shellCommands(text).some(({ words }) => runsCode(words.map(programName), words.map((w) => w.toLowerCase())));
  } catch {
    return false;
  }
}
/**
 * The write programs whose targets the reader names (placedTargets): with places (the chief's rule, T807), each counts
 * only when a target is outside the scratch folders, as a redirection does.
 */
const PLACED = new Set(["rm", "rmdir", "touch", "tee", "cp", "mv"]);
/**
 * The paths that a placed write program changes: each operand, but for cp only the last (its destination). True (a place
 * that the reader cannot tell) when it has no operand, or a -t or --target-directory option.
 */
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
  // gh's words are its own arguments, never a program that it runs: "gh api -X PATCH" or "gh config set pager less"
  // writes no file (T948). A redirection still counts, and so does gh after a wrapper (xargs gh, env gh). The gh commands
  // that clone, download or install count by their own words (ghTargets).
  if (READERS.test(program) || program === "gh") return false;
  // git's words are its own arguments too: of the write names, only git rm and git mv write, so "git worktree add
  // ../install" or "git commit -m patch" is no write (T960). git diff --output counts by its own rule (outputDispatchWrites).
  if (program === "git") return /^(?:rm|mv)$/.test(gitSubcommand(words, at + 1));
  // A program of this command that runs: a word that only names one (man sed, --why rm) is data.
  const has = (re) => base.some((w) => re.test(w) && runs.has(w));
  return (
    base.some((w) => WRITE_NAMES.has(w) && runs.has(w) && !(placed && PLACED.has(w))) || (runs.has("uniq") && uniqWrites(words, base)) ||
    (has(/^g?sed$|^perl$|^ruby$/) && low.some((w) => /^-[a-z]*i|^--in-place/.test(w))) ||
    (has(/^[gmn]?awk$/) && (low.includes("inplace") || words.some(awkWrites))) ||
    (has(/^g?sort$/) && low.some((w) => /^-[a-z]*o|^--o/.test(w))) || // sort takes a shortened long option: --out=FILE, --outp=FILE (T83-R5-SORTABBR)
    (has(/^find$/) && low.some((w) => /^-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(w))) ||
    runsCode(base, low) ||
    /^(?:eval|source|\.|exec)$/.test(base[low.findIndex((w) => !/^\w+=/.test(w))] ?? "")
  );
}
/** awk code that runs a command: "cmd" | getline, or system() (F-T932-4). */
const AWK_RUNS = /\|&?\s*getline\b|\bsystem\s*\(/;
/** awk code that prints into > FILE, >> FILE or | "cmd" (F-T932-4). */
const AWK_PRINTS = /\bprintf?\b[^;{}\n]*[>|]/;
/**
 * A word of awk code that writes (AWK_RUNS, AWK_PRINTS), with the text of its strings left out: print "a|b" only
 * prints. A print into /dev/stdout, /dev/stderr or /dev/null writes no file, and a > in parentheses is a comparison:
 * print ($1 > 3) prints 0 or 1 (F-T936-1).
 */
const awkWrites = (word) => {
  const code = word.replace(/>>?\s*"\/dev\/(?:stdout|stderr|null)"/g, "").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  let printed = code;
  for (let last; last !== printed;) [last, printed] = [printed, printed.replace(/\([^()]*\)/g, "")];
  return AWK_RUNS.test(code) || AWK_PRINTS.test(printed);
};
/** The operands of chmod, chown, chgrp and chflags that they change: every operand after the mode or the owner (none with --reference). */
function modeTargets(name, args) {
  const operands = [];
  let reference = false;
  for (let k = 0; k < args.length; k++) {
    const arg = args[k];
    // chmod -x FILE: -x, -w, -rwx and the like are modes, not options.
    if (arg.startsWith("-") && arg !== "-" && !(name === "chmod" && /^-[rwxXst]+$/.test(arg) && !operands.length && !reference)) {
      if (arg === "--") { operands.push(...args.slice(k + 1)); break; }
      if (/^--reference(?:=|$)/.test(arg)) { reference = true; if (!arg.includes("=")) k++; }
      continue;
    }
    operands.push(arg);
  }
  return reference ? operands : operands.slice(1);
}
/** The git subcommands that change a checkout's files, its index or its history (T936): each changes the work tree it runs in. */
const GIT_CHANGES = /^(?:checkout|switch|restore|reset|clean|apply|am|merge|pull|rebase|cherry-pick|revert|commit|add|rm|mv)$/;
/** The options of git clean, add, commit and apply that only show what the command would do. */
const GIT_DRY = { clean: /^(?:-[a-zA-Z]*n[a-zA-Z]*|--dry-run)$/, add: /^(?:-[a-zA-Z]*n[a-zA-Z]*|--dry-run)$/, commit: /^--dry-run$/, apply: /^--(?:check|stat|numstat|summary)$/ };
/** git branch options that delete, move, copy or force a branch, or change its upstream. */
const BRANCH_CHANGES = /^(?:-[a-zA-Z]*[dDmMcCfu][a-zA-Z]*|--(?:delete|move|copy|force|set-upstream-to|unset-upstream|edit-description)(?:=.*)?)$/;
/** git branch options that take the next word as their value. */
const BRANCH_VALUE = /^--(?:sort|format|contains|no-contains|merged|no-merged|points-at)$/;
/** git config options that change a setting, and its subcommands that change one (git 2.46 and later). */
const CONFIG_CHANGES = /^(?:--(?:unset|unset-all|add|replace-all|rename-section|remove-section|edit)|-e)$/;
const CONFIG_VALUE = /^(?:-f|--file|--blob|--type|--default|--comment|--value)$/;
const CONFIG_READS = /^--(?:get|get-all|get-regexp|get-urlmatch|get-color|get-colorbool|list|show-origin|show-scope|name-only|null)$|^-[lz]$/;
/**
 * The git forms that throw away uncommitted work in the work tree that they run in (T968): reset --hard, checkout with
 * paths (after --, or .) or --force, switch --force or --discard-changes, clean with --force (not a dry run), and restore
 * of the work tree (not --staged alone).
 */
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
        // -s takes its value: the rest of the word, or the next word.
        if (c === "s") { if (a.endsWith("s") && a.indexOf("s") === a.length - 1) i++; break; }
      }
    }
  }
  return worktree || !staged;
}
/**
 * The folders and paths where a git command changes the project, for a read-only role (T936, F-T933-1, F-T932-4), or
 * true when the hook cannot tell where. A command of GIT_CHANGES changes the work tree that it runs in (its -C folder, or
 * the command's folder), except a dry run; git branch with a delete, move, copy or force option, and git config with a
 * change, change the checkout's branches or settings; git worktree add, move and remove change their paths. Every other git
 * command, such as fetch, log, worktree list or branch --list, changes no file of the project. git --git-dir or
 * --work-tree names another checkout: true. With destroys (the chief, T968), only the forms of gitDestroys count, at their
 * work tree, and git worktree remove --force, at the path that it removes.
 */
function gitTargets(args, destroys = false) {
  let tree = ".", k = 0, other = false;
  for (; args[k]?.startsWith("-"); k++) {
    if (/^--(?:git-dir|work-tree)(?:=|$)/.test(args[k])) other = true;
    if (args[k] === "-C") tree = isAbsolute(args[k + 1] ?? "") ? args[k + 1] : join(tree, args[k + 1] ?? "");
    if (GIT_VALUE.test(args[k])) k++;
  }
  // git worktree remove --force throws away the changes of the worktree that it removes, at its path (F-T807-1).
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
    // --global and --system change a file outside every checkout.
    return !change ? [] : rest.some((a) => /^--(?:global|system)$/.test(a)) ? true : [tree];
  }
  if (sub === "worktree" && /^(?:add|move|remove)$/.test(rest[0] ?? "")) {
    const paths = [];
    for (let i = 1; i < rest.length; i++) {
      if (/^(?:-b|-B|--reason)$/.test(rest[i])) i++;
      else if (!rest[i].startsWith("-")) paths.push(rest[i]);
    }
    // add: its path (then a commit); move: both paths; remove: its path.
    const changed = rest[0] === "move" ? paths.slice(0, 2) : paths.slice(0, 1);
    return changed.length ? changed.map((p) => (isAbsolute(p) ? p : join(tree, p))) : true;
  }
  return [];
}
/** The real path of a path: the real path of its longest part that exists, then the rest. */
function realPath(path) {
  try { return realpathSync.native(path); } catch { return dirname(path) === path ? path : join(realPath(dirname(path)), basename(path)); }
}
/**
 * Is a redirection's target in a scratch folder, outside cwd (the caller's project), and not a folder that holds the
 * project, both as written and through a link? Only a literal target in a known folder counts: a variable, a pattern or ~
 * in it, or a folder that the reader cannot follow, does not. The chief's places (T807) add home, which reads a leading ~
 * as the shell does, and guard, the folders where a git work tree holds repository files (inWorkTree, F-T807-1).
 */
function intoScratch({ target, dir, uncertainDirectory }, cwd, scratch, { home, guard = [] } = {}) {
  const word = home && /^~(?:\/|$)/.test(target) ? home + target.slice(1) : target;
  if (!scratch.length || uncertainDirectory || /[$`*?[\]{}~!]/.test(word)) return false;
  const absolute = resolve(dir ?? cwd, word), project = mainCheckout(realPath(resolve(cwd)));
  // Both the path itself (a link that rm removes) and the place that it resolves to (where a write lands) count.
  return [...new Set([join(realPath(dirname(absolute)), basename(absolute)), realPath(absolute)])].every((path) => {
    const under = (folder) => path.startsWith(folder.endsWith(sep) ? folder : folder + sep);
    return path !== project && !under(project) && !project.startsWith(path.endsWith(sep) ? path : path + sep) &&
      scratch.some((folder) => under(realPath(resolve(folder)))) && !inWorkTree(path, guard);
  });
}
/** The most folders that inWorkTree reads below a path; a larger tree counts as one that holds a work tree (fail closed). */
const WALK_MAX = 2000;
/**
 * Is a path in or over a git work tree, inside one of the guard folders (the sage worktrees folder, F-T807-1)? A .git
 * entry (a worktree's file or a clone's folder) at the path or in a folder between it and the guard folder counts, and so
 * does one in a folder below the path. The walk does not follow links.
 */
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
/**
 * The project of a folder: the main checkout of the repository that holds it, so that a worktree in a scratch folder is
 * not the project, also as the working folder (F-T936-5). It is the nearest folder above with a .git entry; a linked
 * worktree's .git file (gitdir: <main>/.git/worktrees/<name>) names its main checkout. Without a .git entry: the folder.
 */
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
/**
 * Is a target of chmod, chown, chgrp or chflags in the project (cwd), or a place that the reader cannot tell (a variable,
 * a folder after a cd that it cannot follow)? A pattern counts by the folder of its literal part; ~ is outside.
 */
function inProject({ target, dir, uncertainDirectory }, cwd) {
  if (/^~(?:\/|$)/.test(target)) return false;
  if (/[$`]/.test(target) || (uncertainDirectory && !isAbsolute(target))) return true;
  const cut = target.search(/[*?[{]/), literal = cut < 0 ? target : target.slice(0, target.lastIndexOf("/", cut) + 1);
  const path = realPath(resolve(dir ?? cwd, literal || ".")), project = realPath(resolve(cwd));
  return path === project || path.startsWith(project.endsWith(sep) ? project : project + sep);
}
/**
 * Does one field of a command's text have a write form? A text that the hook cannot read counts as one (fail closed).
 * scratch: absolute folders (such as the temp folder) where a redirection or a gh clone or download (ghTargets) does
 * not count, unless its target is in cwd. Every other write form counts also there. A chmod, chown, chgrp or chflags
 * counts only in cwd (modeTargets, inProject, F-T933-1): chmod +x of a fake in scratch, or chmod -R u+w ~, runs. readOnly: also
 * the git commands that change the project's work tree, index, history, branches or settings (gitTargets), for a role
 * that changes no files (T936); a git command in a scratch folder, such as a worktree of the head, does not count. The
 * chief's rule leaves it out, so the chief's git runs (T960). placed (the chief's rule, T807): a placed write program
 * (rm, rmdir, touch, tee, cp, mv) counts only when one of its targets (placedTargets) is outside the scratch folders, or
 * when a wrapper runs it; home reads a leading ~ in a target. guard: folders where a target in or over a git work tree
 * is no scratch place (inWorkTree, F-T807-1).
 */
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
/** A target of a program's entry, in the program's folder. */
const at = ({ run, uncertainDirectory }, target) => ({ target, dir: run.dir, uncertainDirectory });
/** Is one of the targets (or true: a place that the hook cannot tell) outside the scratch folders (intoScratch)? */
const outsideScratch = (targets, entry, cwd, scratch, place) => targets === true || targets.some((target) => !intoScratch(at(entry, target), cwd, scratch, place));
/**
 * Does a command line run a git form that throws away uncommitted work (gitDestroys) in a work tree outside the scratch
 * folders, such as git reset --hard in the project (T968)? A work tree in a guard folder is no scratch place (F-T807-1).
 * A line that the reader cannot read does not: commandWrites counts it as a write.
 */
export function gitDestroysWork(text, cwd, scratch = [], guard = []) {
  try {
    return programsRun(text, cwd, undefined, { contextEvidence: true }).programs.some((entry) => programName(entry.run.word) === "git" && outsideScratch(gitTargets(entry.run.args, true), entry, cwd, scratch, { guard }));
  } catch {
    return false;
  }
}

/** A word that opens or closes shell control flow: such a line is not a plain list of parts. */
const FLOW_WORD = /^(?:if|then|elif|else|fi|for|while|until|do|done|select|case|esac|function|time|coproc|\{|\}|\[\[|!)$/;
/** A command that can change what a later reader's name runs: an alias, a variable such as PATH, or a script of the same shell. */
const REDEFINES = /^(?:export|unset|readonly|declare|typeset|local|set|shopt|setopt|alias|unalias|hash|enable|builtin|command|eval|source|\.)$/;
/** The git subcommands that only read. git's own option forms (git -C, git -c) are not plain, so they stay judged. */
const GIT_READS = /^(?:log|show|status|diff|rev-parse)$/;
const shellQuoted = (word) => (/^[\w./=:@%+,-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`);
/** A plain reader: one of READERS or a reading git subcommand, by its bare name, whose own words have no write form. cd and pushd are in READERS, and they change the folder. */
const plainReader = ({ words }, cwd) =>
  (words[0] === "git" ? GIT_READS.test(words[1] ?? "") : READERS.test(words[0] ?? "") && !/^(?:cd|pushd)$/.test(words[0])) &&
  !commandWrites(words.map(shellQuoted).join(" "), cwd);

/**
 * Proven non-executing readers, with read references separate from write targets. Literal stdin and echo/printf data
 * cannot name a target. Undefined retains the caller's conservative whole-command policy for opaque execution.
 * No caller-supplied directory grants authority: dir is only the parser's execution context for each path.
 */
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
