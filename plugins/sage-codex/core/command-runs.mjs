// The rules that judge the programs a command line runs, as the command reader sees them, and the literal paths in their
// words, never free text (T815). The Claude hook uses them; the Codex gate uses mergeRun and the push rules of core, and
// takes these up in T903. None of them runs the command that it judges.
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { programsRun, shellCommands } from "./command-reader.mjs";
import { commandWrites, readerDispatch, uniqWrites } from "./shell-write-policy.mjs";
import { outputDispatchWrites } from "./output-writes.mjs";
import { programName } from "./program-name.mjs";
import { ghApiMethod, ghWords, gitSubcommand } from "./command-policy.mjs";

const fold = (text) => text.normalize("NFKC").toLowerCase();

/**
 * A resolver of real paths for one command line: the real path of an absolute path is the real path of its longest part
 * that exists, through every link (also a dangling one), then the rest. Each path is looked up once, so a line of many
 * words in one folder costs one lookup of that folder (F-T229-20). More than 64 links in a row throw: the path is unknown.
 */
function resolver() {
  const known = new Map();
  const real = (path, hops = 0) => {
    if (known.has(path)) return known.get(path);
    let result;
    try {
      result = realpathSync.native(path); // the system resolves ".." after each link
    } catch {
      let link = false;
      try { link = lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink(); } catch {}
      if (link) {
        if (hops >= 64) throw new Error(`too many links in ${path}`);
        const to = readlinkSync(path);
        result = real(isAbsolute(to) ? to : `${dirname(path)}/${to}`, hops + 1);
      } else result = dirname(path) === path ? path : join(real(dirname(path), hops), basename(path));
    }
    known.set(path, result);
    return result;
  };
  return real;
}

/** The programs that only read or print their words: their words are data, so only a redirection makes them write. */
const DATA = /^(?:echo|printf|cat|grep|egrep|fgrep|rg|head|tail|wc|jq|ls|diff|cut|stat|file|cd|pushd|popd|true|test|\[|:|tr|uniq|git|gh|node|nodejs|g?sed|g?awk|sort)$/;
/** git's subcommands that change files of a checkout, or make one: their -C folder and paths are written. */
const GIT_WRITES = /^(?:clean|checkout|restore|reset|rm|mv|stash|apply|am|merge|rebase|pull|cherry-pick|revert|clone|init|worktree|switch|archive|checkout-index)$/;
/**
 * Do a program's words name what it writes? Every program but DATA, which counts only by its bare name (/tmp/x/cat is
 * another program). Of DATA: node with code, sed or awk in place, sort -o, uniq with an output operand (uniq IN OUT), git
 * with a subcommand of GIT_WRITES, and a reader or git with an option that runs a program or writes a file (rg --pre,
 * file -C, diff -l, git diff --output): the classifiers of commandWrites.
 */
function judged(word, args, entry = { run: { word, args } }) {
  const name = word.includes("/") ? "" : programName(word);
  if (!DATA.test(name) || readerDispatch(entry) || outputDispatchWrites(entry)) return true;
  if (name === "git") return GIT_WRITES.test(gitSubcommand(args, 0));
  if (/^(?:node|nodejs)$/.test(name)) return args.some((a) => /^(?:-e|--eval|-p|--print)$|^--(?:eval|print)=/.test(a));
  if (/^g?sed$/.test(name)) return args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a));
  if (/^g?awk$/.test(name)) return args.some((a) => a === "inplace" || /^-i/.test(a));
  if (name === "sort") return args.some((a) => /^-[a-zA-Z]*o|^--o/.test(a));
  if (name === "uniq") return uniqWrites([word, ...args], [word, ...args].map(programName));
  return false;
}
/** A redirection that writes a file: not an input, a duplicate (2>&1) or /dev/null, /dev/stdout or /dev/stderr. */
const toFile = (operator, target) => !(operator === "<" || operator === "<&" || (operator === ">&" && /^(?:\d+-?|-)$/.test(target))) && !/^\/dev\/(?:null|stdout|stderr)$/.test(target);
const REDIRECT = /^(&>>?|>>|>\||>&|<>|<&|>|<)([^]*)$/;
/**
 * The words of a program that removes, moves or locks a whole folder, which take a root with them when they name it or a
 * folder above it (F-T815-4): rm, rmdir, unlink and shred; mv but its last word (where it moves to); rsync with a delete
 * option; find's start folders with -delete or with an -exec of such a program; chmod, chown, chgrp and chflags with -R.
 */
function wholeWords(name, args) {
  if (/^(?:g?rm|rmdir|unlink|shred)$/.test(name)) return args;
  if (/^g?mv$/.test(name)) return args.slice(0, -1);
  if (name === "rsync") return args.some((a) => /^--(?:del|delete|remove-source-files)/.test(a)) ? args : [];
  if (/^(?:chmod|chown|chgrp|chflags)$/.test(name)) return args.some((a) => /^-[a-zA-Z]*R|^--recursive$/.test(a)) ? args : [];
  if (name !== "find") return [];
  const start = args.findIndex((a) => /^[-(!]/.test(a));
  const removes = args.some((a, k) => a === "-delete" || (/^-(?:exec|execdir|ok|okdir)$/.test(a) && wholeWords(programName(args[k + 1] ?? ""), args.slice(k + 2)).length > 0));
  return removes ? args.slice(0, start < 0 ? undefined : start) : [];
}

/**
 * The word of a shell command line that writes into the sage root or the shared root (roots), or undefined (T815). In a
 * line with a write form (commandWrites) it judges each word of each program that is not a reader (DATA), with the value
 * of a key=value or an --option=value, and each redirection's target. A word counts when its literal part (the text
 * before its first $, backtick or pattern character; ~ is the home folder), resolved from the program's folder and
 * through the links on disk, is in a root, or when its text holds a root's path. In any line, a word of a program that
 * removes, moves or locks a whole folder (wholeWords) also counts when it names a folder above a root: for a pattern or
 * a variable, the folder of its literal part (so ~/* is the home folder). The reader follows a literal cd, pushd and
 * popd; after one that it cannot follow, only absolute paths count. zsh's clobber form (>! file) gives the reader a word,
 * not a target, so with it every word counts. A line that the reader cannot read gives undefined. A path that a script,
 * a variable or code builds while it runs is a limit of the hook. It throws when a path has a loop of links.
 */
export function logbookWrite(command, cwd, roots, home = process.env.HOME) {
  if (typeof command !== "string") return undefined;
  const writes = commandWrites(command, cwd);
  const real = resolver();
  const forms = [...new Set(roots.filter((r) => typeof r === "string" && isAbsolute(r)).flatMap((r) => [fold(r), fold(real(r))]))];
  const into = (path) => forms.some((r) => path === r || path.startsWith(r.endsWith(sep) ? r : r + sep));
  // A root or a folder above one: a remove or a move of it takes the root with it.
  const holder = (path) => forms.some((r) => r === path || r.startsWith(path.endsWith(sep) ? path : path + sep));
  // The text holds a root's path when a root's text stands in it with no path character right after it.
  const holds = (text) => {
    const low = fold(text);
    return forms.some((r) => { for (let at = low.indexOf(r); at >= 0; at = low.indexOf(r, at + 1)) if (!/[\w.-]/.test(low[at + r.length] ?? "")) return true; return false; });
  };
  const path = (word, dir) => {
    const cut = word.search(/[$`*?[{]/);
    if (cut === 0 && /^[$`]/.test(word)) return undefined; // a variable or a substitution: no literal part
    let lit = cut < 0 ? word : word.slice(0, cut) || ".";
    if (/^~(?=\/|$)/.test(lit)) { if (!home) return undefined; lit = home + lit.slice(1); }
    if (lit.startsWith("-") || lit.length > 4096 || lit.includes("\0")) return undefined;
    if (!isAbsolute(lit)) { if (!dir) return undefined; lit = `${dir}/${lit}`; }
    return fold(real(lit));
  };
  const named = (word, dir) => {
    const value = /^(?:--?[\w-]+|\w+)=(.+)$/s.exec(word)?.[1];
    return [word, ...(value ? [value] : [])].some((v) => holds(v) || into(path(v, dir) ?? "\0"));
  };
  // A pattern or a variable can stand for any name in the folder of its literal part, so that folder counts.
  const above = (word, dir) => {
    const cut = word.search(/[$`*?[{]/);
    if (cut === 0 && /^[$`]/.test(word)) return false;
    const p = path(cut < 0 ? word : word.slice(0, word.lastIndexOf("/", cut) + 1) || ".", dir);
    return p !== undefined && holder(p);
  };
  const whole = (word, args, dir) => wholeWords(programName(word), args).find((w) => above(w, dir) || named(w, dir));
  let evidence;
  try {
    evidence = programsRun(command, cwd, undefined, { contextEvidence: true, redirectParts: true });
  } catch {
    return unreadWrite(command, cwd, named, whole, home);
  }
  const clobber = evidence.redirects.some(({ operator, target }) => /^&?>>?$/.test(operator) && target.startsWith("!"));
  for (const entry of evidence.programs) {
    const { run, uncertainDirectory } = entry;
    const dir = uncertainDirectory ? undefined : run.dir ?? cwd;
    const top = entry.wrapper || entry.shellFunction ? undefined : whole(run.word, run.args, dir);
    if (top !== undefined) return top;
    if (!writes || (!clobber && !judged(run.word, run.args, entry))) continue;
    const word = [run.word, ...run.args].find((w) => named(w, dir));
    if (word !== undefined) return word;
  }
  if (!writes) return undefined;
  for (const { operator, target, dir, uncertainDirectory } of evidence.redirects) {
    if (toFile(operator, target) && named(target, uncertainDirectory ? undefined : dir ?? cwd)) return target;
  }
  return undefined;
}
/** The same check, when the reader cannot follow the line's folders (cd ~, cd $X): each command by its own words, in order. */
function unreadWrite(command, cwd, named, whole, home) {
  let commands;
  try { commands = shellCommands(command); } catch { return undefined; }
  let dir = cwd;
  for (const c of commands) {
    const k = c.words.findIndex((_, i) => !c.syntax?.[i]?.assignment);
    const [word, ...args] = k < 0 ? [] : c.words.slice(k);
    const at = c.host ? undefined : dir;
    // A literal cd or pushd gives the folder of the commands after it; popd and any other form leave it unknown.
    if (/^(?:cd|pushd|popd)$/.test(word ?? "") && !c.host) {
      const to = word !== "popd" && args.length === 1 && !/[$`*?[{]/.test(args[0]) ? args[0].replace(/^~(?=\/|$)/, home ?? "~") : undefined;
      dir = to && !to.startsWith("~") ? (isAbsolute(to) ? to : dir && `${dir}/${to}`) : undefined;
      continue;
    }
    const top = word === undefined ? undefined : whole(word, args, at);
    if (top !== undefined) return top;
    if (word !== undefined && judged(word, args)) {
      const found = [word, ...args].find((w) => named(w, at));
      if (found !== undefined) return found;
    }
    for (const redirect of c.redirects) {
      const [, operator, target] = REDIRECT.exec(redirect) ?? [];
      if (operator && toFile(operator, target) && named(target, at)) return target;
    }
  }
  return undefined;
}

/** Node's options that take the next word as code or a module to load, and those that take another value. */
const NODE_CODE = /^(?:-e|--eval|-p|--print|-r|--require|--import)$/;
const NODE_VALUE = /^(?:--loader|--experimental-loader|-C|--conditions|--input-type|--title)$/;
const TOOL_FILE = /(?:^|[/\\])(sage(?:-pr)?)\.mjs$/i;
/**
 * The runs of the state tool (sage.mjs) or the PR script (sage-pr.mjs) in a command line, at any depth that the reader
 * sees: node or nodejs with the script as its program, or the script run directly, each as { tool: "state" | "pr",
 * code: false, script, args, dir } (dir: the folder it runs in); and node's -e or -p code, or the module of -r or --import, that names one of them, as
 * { tool, code: true }. A program that only reads the file (cat, grep, git show) is no run. It throws when the reader
 * cannot read the line.
 */
export function stateToolRun(command, cwd) {
  const { programs } = programsRun(command, cwd, undefined, { contextEvidence: true });
  const found = [];
  for (const { run, wrapper, shellFunction } of programs) {
    if (wrapper || shellFunction) continue;
    let script = run.word, args = run.args;
    if (/^(?:node|nodejs)$/.test(programName(run.word))) {
      let k = 0;
      for (; k < run.args.length && /^-./.test(run.args[k]) && run.args[k] !== "--"; k++) {
        const a = run.args[k], code = NODE_CODE.test(a) ? run.args[++k] ?? "" : /^--(?:eval|print|require|import)=/.test(a) ? a : undefined;
        const tool = code && /sage(-pr)?\.mjs/i.exec(code);
        if (tool) found.push({ tool: tool[1] ? "pr" : "state", code: true });
        else if (NODE_VALUE.test(a)) k++;
      }
      if (run.args[k] === "--") k++;
      // An option that takes its value in the next word and that NODE_VALUE does not know (--env-file .env) leaves the
      // program a later word: a sage.mjs right after such values is the program.
      let j = k;
      while (j < run.args.length && !TOOL_FILE.test(run.args[j]) && /^--?[^=]+$/.test(run.args[j - 1] ?? "") && !run.args[j].startsWith("-")) j++;
      if (TOOL_FILE.test(run.args[j] ?? "")) k = j;
      [script, ...args] = run.args.slice(k);
    }
    const tool = TOOL_FILE.exec(script ?? "");
    if (tool) found.push({ tool: tool[1].toLowerCase() === "sage-pr" ? "pr" : "state", code: false, script, args, dir: run.dir });
  }
  return found;
}

/**
 * Each gh run of a command line, at any depth that the reader sees, as { group, sub, method, args }: gh's first two
 * command words (after its own options) and, for gh api, the request's method. gh by another name (a copy, an alias or
 * an extension) is a limit of the hook. It throws when the reader cannot read the line.
 */
export function ghRuns(command, cwd, path, options = {}) {
  const { programs } = programsRun(command, cwd, path, { ...options, contextEvidence: true });
  return programs.filter(({ run, wrapper, shellFunction }) => !wrapper && !shellFunction && programName(run.word) === "gh").map(({ run }) => {
    const [group, sub] = ghWords(run.args);
    return { group, sub, method: group === "api" ? ghApiMethod(run.args) : undefined, args: run.args };
  });
}
/** The gh commands that an agent runs: a pull request's own steps and the reads (T815, Q1), and gh api with GET. */
export const AGENT_GH = Object.freeze({
  pr: Object.freeze(["create", "view", "comment", "edit", "checks", "diff", "list", "status"]),
  issue: Object.freeze(["view", "list"]),
  run: Object.freeze(["view", "list", "watch"]),
  repo: Object.freeze(["view"]),
});
/** Does an agent's gh run stay in AGENT_GH? */
export const agentGh = ({ group, sub, method }) => (group === "api" ? method === "GET" : Object.hasOwn(AGENT_GH, group ?? "") && AGENT_GH[group].includes(sub));
