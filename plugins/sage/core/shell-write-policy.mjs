// Shared write classification from the existing hook rules. This never executes command text.
import { shellCommands, programsRun } from "./command-reader.mjs";
import { outputDispatchWrites } from "./output-writes.mjs";
import { programName } from "./command-policy.mjs";

const CODE = /^-(?:[a-z]*[ce]|p|-eval|-print|command)$/;
/** The commands that write, move, remove or link a file, also in PowerShell (case does not matter there). uniq IN OUT and less -o FILE write, so uniq and less always count. */
const WRITE_NAMES = new Set(["uniq", "less", "tee", "cp", "mv", "rm", "rmdir", "ln", "link", "install", "touch", "dd", "truncate", "rsync", "sponge", "patch", "unlink", "shred", "tar", "unzip", "set-content", "out-file", "add-content", "copy-item", "move-item", "remove-item", "rename-item", "new-item", "ni", "sc", "ac", "del"]);
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
/** Function arguments are data; only an actual reader dispatch owns its options. */
const readerDispatch = entry => !entry.wrapper && !entry.shellFunction && !entry.resolvedDeclaration &&
  readerRuns(programName(entry.run.word), entry.run.args);
/** Keep operator and target separate: quoted filename prefixes are not shell operators. */
function toFile({ operator: op, target: to }) {
  if (op === "<" || op === "<&" || (op === ">&" && /^(?:\d+-?|-)$/.test(to))) return false;
  return !/^\/dev\/(?:null|stdout|stderr)$/.test(to);
}
function writesIn({ words }) {
  const low = words.map((w) => w.toLowerCase());
  const base = words.map(programName);
  if (READERS.test(base[low.findIndex((w) => !/^\w+=/.test(w))] ?? "")) return false;
  const has = (re) => base.some((w) => re.test(w));
  return (
    base.some((w) => WRITE_NAMES.has(w)) ||
    (has(/^g?sed$|^perl$|^ruby$/) && low.some((w) => /^-[a-z]*i|^--in-place/.test(w))) ||
    (has(/^g?awk$/) && low.includes("inplace")) ||
    (has(/^g?sort$/) && low.some((w) => /^-[a-z]*o|^--o/.test(w))) || // sort takes a shortened long option: --out=FILE, --outp=FILE (T83-R5-SORTABBR)
    (has(/^find$/) && low.some((w) => /^-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(w))) ||
    (has(/^(?:node|deno|bun|python[\d.]*|perl|ruby|php|osascript|sh|bash|zsh|dash|ksh|fish|pwsh|powershell)$/) && low.some((w) => CODE.test(w))) ||
    /^(?:eval|source|\.|exec)$/.test(base[low.findIndex((w) => !/^\w+=/.test(w))] ?? "")
  );
}
/** An interpreter with executable stdin is opaque, even when its producer is a literal reader. */
const executesStdin = ({ run }) => (run.piped || run.stdin.length > 0) &&
  /^(?:node|nodejs|python[\d.]*|perl|ruby|php|sh|bash|zsh|dash|ksh|fish)$/.test(programName(run.word)) &&
  // Python's module mode consumes stdin as module data. Other option-led launches stay opaque.
  !(/^python[\d.]*$/.test(programName(run.word)) && /^-m/.test(run.args[0] ?? "")) &&
  (run.args.length === 0 || run.args[0].startsWith("-"));
/** Does one field of a command's text have a write form? A text that the hook cannot read counts as one (fail closed). */
export function commandWrites(text, cwd) {
  if (typeof text !== "string") return true;
  try {
    const commands = shellCommands(text);
    if (commands.some(writesIn)) return true;
    if (commands.some(c => c.bodies.length) && commands.some(c => c.grouped || REDEFINES.test(c.words[0] ?? ""))) return true;
    const evidence = programsRun(text, cwd, undefined, { contextEvidence: true, redirectParts: true });
    if (commands.some(c => c.bodies.length) && evidence.programs.some(p => p.shellFunction || p.resolvedDeclaration)) return true;
    return evidence.redirects.some(toFile) || evidence.programs.some(entry => readerDispatch(entry) || outputDispatchWrites(entry) || executesStdin(entry));
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
const redirectParts = (redirect) => {
  const [, operator, target] = /^(&>>?|>>|>\||>&|<>|<&|>|<)([^]*)$/.exec(redirect);
  return { operator, target };
};
/** A plain reader: one of READERS or a reading git subcommand, by its bare name, whose own words have no write form. cd and pushd are in READERS, and they change the folder. */
const plainReader = ({ words }, cwd) =>
  (words[0] === "git" ? GIT_READS.test(words[1] ?? "") : READERS.test(words[0] ?? "") && !/^(?:cd|pushd)$/.test(words[0])) &&
  !commandWrites(words.map(shellQuoted).join(" "), cwd);
const shown = (commands) => commands.map(c => [...c.words, ...c.redirects, ...c.bodies].join(" ")).join(" | ");

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
      c.wordLiterals.some(literal => !literal) || c.bodyLiterals.some(literal => !literal) ||
      (c.words.length && !plainReader(c, cwd) && !/^(?:cd|pushd)$/.test(c.words[0])) ||
      (c.words[0] === "printf" && (c.words.slice(1).some(word => /^-v/.test(word)) ||
        /%[^%]*n/.test(c.words[c.words[1] === "--" ? 2 : 1] ?? ""))))) return undefined;
    if (evidence.programs.some(p => p.wrapper || p.shellFunction || p.resolvedDeclaration || p.uncertainDirectory)) return undefined;
    const reads = evidence.programs.flatMap(({ run }) => /^(?:echo|printf)$/.test(run.word) ? [] :
      [run.word, ...run.args].map(word => ({ word, dir: run.dir ?? cwd })));
    reads.push(...evidence.redirects.filter(r => !toFile(r)).map(r => ({ word: r.target, dir: r.dir ?? cwd })));
    return { reads, writes: writes.map(r => ({ word: r.target, dir: r.dir ?? cwd })) };
  } catch { return undefined; }
}
/**
 * The text of a POSIX shell command line that the rule for a logbook write judges (T621), one item for each pipeline, so
 * that a read beside a write gives no evidence against it. A pipeline's last commands are dropped when they are plain
 * readers, because they feed nothing: their words are data (.items[], 5[0-9]). Any other command stays, also one that the
 * hook does not know, and so does a reader that feeds it. { text } is the whole pipeline. { targets } is set when readers
 * were dropped: the commands that stay, and the targets of the dropped readers' redirections.
 *
 * Undefined means "judge the whole text": an unreadable line, a substitution, a subshell, a group or control flow, a part
 * that uses $ or a backtick (a part can read what an earlier part made, such as $_), a part that can change what a
 * reader's name runs (REDEFINES, or an assignment with no command), zsh's clobber forms (>! reads as a target that starts
 * with !), a part that names a file that a dropped reader wrote, or a line with no part left.
 */
export function writeParts(text, cwd) {
  try {
    const commands = shellCommands(text);
    if (commands.some(c => c.host || c.grouped || FLOW_WORD.test(c.words[0] ?? "") || REDEFINES.test(c.words[0] ?? "") || c.syntax.every(s => s.assignment) || c.redirects.some(r => redirectParts(r).target.startsWith("!")) || [...c.words, ...c.redirects, ...c.bodies].some(word => /[$`]/.test(word)))) return undefined;
    const lines = [];
    let open = [];
    for (const command of commands) {
      open.push(command);
      if (!command.piped) { lines.push(open); open = []; }
    }
    if (open.length) lines.push(open); // a line that ends in |
    const parts = [], written = [], rest = [];
    for (const line of lines) {
      const kept = line.slice(0, line.findLastIndex(c => !plainReader(c, cwd)) + 1), readers = line.slice(kept.length);
      const targets = readers.flatMap(c => c.redirects.map(redirectParts)).filter(toFile).map(({ target }) => target);
      if (!kept.length && !targets.length) continue;
      written.push(...targets);
      rest.push(shown(kept));
      parts.push(readers.length ? { text: shown(line), targets: [shown(kept), ...targets].join(" ") } : { text: shown(line) });
    }
    // A part that names a file that a dropped reader wrote can run that reader's words: echo 'rm f' > a.sh; sh a.sh.
    const named = new Set(rest.join(" ").split(/[^\w.-]+/));
    if (written.some(file => named.has(file.split("/").at(-1)))) return undefined;
    return parts.length ? parts : undefined;
  } catch {
    return undefined;
  }
}
