// Shared write classification from the existing hook rules. This never executes command text.
import { shellCommands, programsRun } from "./command-reader.mjs";
import { outputDispatchWrites } from "./output-writes.mjs";
import { programName } from "./command-policy.mjs";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

const CODE = /^-(?:[a-z]*[ce]|p|-eval|-print|command)$/;
/** The commands that write, move, remove or link a file, also in PowerShell (case does not matter there). less -o FILE writes, so less always counts; uniq has its own rule (uniqWrites). */
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
function writesIn({ words }) {
  const low = words.map((w) => w.toLowerCase());
  const base = words.map(programName);
  const program = base[low.findIndex((w) => !/^\w+=/.test(w))] ?? "";
  // gh's words are its own arguments, never a program that it runs: "gh api -X PATCH" or "gh config set pager less"
  // writes no file (T948). A redirection still counts, and so does gh after a wrapper (xargs gh, env gh).
  if (READERS.test(program) || program === "gh") return false;
  const has = (re) => base.some((w) => re.test(w));
  return (
    base.some((w) => WRITE_NAMES.has(w)) || uniqWrites(words, base) ||
    (has(/^g?sed$|^perl$|^ruby$/) && low.some((w) => /^-[a-z]*i|^--in-place/.test(w))) ||
    (has(/^g?awk$/) && low.includes("inplace")) ||
    (has(/^g?sort$/) && low.some((w) => /^-[a-z]*o|^--o/.test(w))) || // sort takes a shortened long option: --out=FILE, --outp=FILE (T83-R5-SORTABBR)
    (has(/^find$/) && low.some((w) => /^-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(w))) ||
    (has(/^(?:node|deno|bun|python[\d.]*|perl|ruby|php|osascript|sh|bash|zsh|dash|ksh|fish|pwsh|powershell)$/) && low.some((w) => CODE.test(w))) ||
    /^(?:eval|source|\.|exec)$/.test(base[low.findIndex((w) => !/^\w+=/.test(w))] ?? "")
  );
}
/** The real path of a path: the real path of its longest part that exists, then the rest. */
function realPath(path) {
  try { return realpathSync.native(path); } catch { return dirname(path) === path ? path : join(realPath(dirname(path)), basename(path)); }
}
/**
 * Is a redirection's target in a scratch folder and outside cwd (the caller's project)? Only a literal target in a known
 * folder counts: a variable, a pattern or ~ in it, or a folder that the reader cannot follow, does not.
 */
function intoScratch({ target, dir, uncertainDirectory }, cwd, scratch) {
  if (!scratch.length || uncertainDirectory || /[$`*?[\]{}~!]/.test(target)) return false;
  const path = realPath(resolve(dir ?? cwd, target)), project = realPath(resolve(cwd));
  const under = (folder) => path.startsWith(folder.endsWith(sep) ? folder : folder + sep);
  return path !== project && !under(project) && scratch.some((folder) => under(realPath(resolve(folder))));
}
/**
 * Does one field of a command's text have a write form? A text that the hook cannot read counts as one (fail closed).
 * scratch: absolute folders (such as the temp folder) where a redirection does not count, unless its target is in cwd.
 * Every other write form counts also there.
 */
export function commandWrites(text, cwd, scratch = []) {
  if (typeof text !== "string") return true;
  try {
    const commands = shellCommands(text);
    if (commands.some(writesIn)) return true;
    const evidence = programsRun(text, cwd, undefined, { contextEvidence: true, redirectParts: true });
    return evidence.redirects.some(r => toFile(r) && !intoScratch(r, cwd, scratch)) || evidence.programs.some(entry => readerDispatch(entry) || outputDispatchWrites(entry));
  } catch {
    return true;
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
