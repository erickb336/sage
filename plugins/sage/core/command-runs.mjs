// The rules that judge the programs a command line runs, as the command reader sees them, and the literal paths in their
// words, never free text (T815). The Claude hook uses them; the Codex gate uses mergeRun, the push rules of core and
// logbookWrite (T903). None of them runs the command that it judges.
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { programsRun } from "./command-reader.mjs";
import { commandWrites, readerDispatch, uniqWrites } from "./shell-write-policy.mjs";
import { outputDispatchWrites } from "./output-writes.mjs";
import { programName } from "./program-name.mjs";
import { ghApiMethod, ghWords, gitSubcommand } from "./command-policy.mjs";

const fold = (text) => text.normalize("NFKC").toLowerCase();

/** The real path of a root: the real path of its longest part that exists, then the rest. Only the roots are resolved: a word is judged as written. */
function realRoot(path) {
  try { return realpathSync.native(path); } catch { return dirname(path) === path ? path : join(realRoot(dirname(path)), basename(path)); }
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
 * The words of a program that removes or moves a whole folder, which take a root with them when they name it or a folder
 * above it (F-T815-4): rm, rmdir, unlink and shred; mv but its last word (where it moves to); rsync with a delete option.
 * A find with -delete removes only the files that it matches (F-T903-7): it counts only when a word names a path in a
 * root, as every write does.
 */
function wholeWords(name, args) {
  if (/^(?:g?rm|rmdir|unlink|shred)$/.test(name)) return args;
  if (/^g?mv$/.test(name)) return args.slice(0, -1);
  if (name === "rsync") return args.some((a) => /^--(?:del|delete|remove-source-files)/.test(a)) ? args : [];
  return [];
}
/**
 * The words of chmod, chown, chgrp and chflags with -R, which change every file under a word, in a line with or without
 * a write form (F-T909-5): each counts only when it names a path in a root. A folder that only holds a root (chmod -R
 * u+w ~) does not count (F-T903-7).
 */
const recursiveWords = (name, args) => /^(?:chmod|chown|chgrp|chflags)$/.test(name) && args.some((a) => /^-[a-zA-Z]*R|^--recursive$/.test(a)) ? args : [];

/**
 * The word of a shell command line that writes into the sage root or the shared root (roots), or undefined (T815). In a
 * line with a write form (commandWrites) it judges each word of each program that is not a reader (DATA), with the value
 * of a key=value or an --option=value, and each redirection's target. A word counts when its literal part (the text
 * before its first $, backtick or pattern character; ~ is the home folder), resolved from the program's folder, is in a
 * root (as written, or the root's real path), or when its text holds a root's path. A word is not followed through links:
 * rm of a link to a root removes the link, not the root (F-T903-10), and a path through a link is a limit of the hook. In
 * any line, a word of a recursive mode or owner change (recursiveWords) counts when it names a path in a root, and a word
 * of a program that removes or moves a whole folder (wholeWords) also counts when it names a folder above a root: for a pattern or a variable, the folder of its literal part (so ~/* is the home folder). The reader
 * follows a literal cd, pushd and popd; after one that it cannot follow, only absolute paths count. zsh's clobber form
 * (>! file) gives the reader a word, not a target, so with it every word counts. A line that the reader cannot read gives
 * undefined. A path that a script, a variable or code builds while it runs is a limit of the hook.
 */
export function logbookWrite(command, cwd, roots, home = process.env.HOME) {
  if (typeof command !== "string") return undefined;
  const writes = commandWrites(command, cwd);
  const forms = [...new Set(roots.filter((r) => typeof r === "string" && isAbsolute(r)).flatMap((r) => [fold(r), fold(realRoot(r))]))];
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
    return fold(resolve(lit));
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
  const whole = (word, args, dir) => wholeWords(programName(word), args).find((w) => above(w, dir) || named(w, dir))
    ?? recursiveWords(programName(word), args).find((w) => named(w, dir));
  let evidence;
  try {
    evidence = programsRun(command, cwd, undefined, { contextEvidence: true, redirectParts: true, home });
  } catch {
    return undefined;
  }
  const clobber = evidence.redirects.some(({ operator, target }) => /^&?>>?$/.test(operator) && target.startsWith("!"));
  for (const entry of evidence.programs) {
    const { run, uncertainDirectory } = entry;
    const dir = uncertainDirectory ? undefined : run.dir ?? cwd;
    const top = entry.wrapper ? undefined : whole(run.word, run.args, dir);
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
/** Node's options that take the next word as a value, not as the program. */
const NODE_VALUE = /^(?:-e|--eval|-p|--print|-r|--require|--import|--loader|--experimental-loader|-C|--conditions|--input-type|--title)$/;
const TOOL_FILE = /(?:^|[/\\])(sage(?:-pr)?)\.mjs$/i;
/**
 * The runs of the state tool (sage.mjs) or the PR script (sage-pr.mjs) in a command line, at any depth that the reader
 * sees: node or nodejs with the script as its program, or the script run directly, each as { tool: "state" | "pr",
 * script, args, dir } (dir: the folder it runs in). A program that only reads the file (cat, grep, git show) is no run,
 * and so is code that loads the script (node -e, -r or --import): a limit of the hook. It throws when the reader cannot
 * read the line.
 */
export function stateToolRun(command, cwd) {
  const { programs } = programsRun(command, cwd, undefined, { contextEvidence: true });
  const found = [];
  for (const { run, wrapper, uncertainDirectory } of programs) {
    if (wrapper) continue;
    let script = run.word, args = run.args;
    if (/^(?:node|nodejs)$/.test(programName(run.word))) {
      let k = 0;
      for (; k < run.args.length && /^-./.test(run.args[k]) && run.args[k] !== "--"; k++) if (NODE_VALUE.test(run.args[k])) k++;
      if (run.args[k] === "--") k++;
      // An option that takes its value in the next word and that NODE_VALUE does not know (--env-file .env) leaves the
      // program a later word: a sage.mjs right after such values is the program.
      let j = k;
      while (j < run.args.length && !TOOL_FILE.test(run.args[j]) && /^--?[^=]+$/.test(run.args[j - 1] ?? "") && !run.args[j].startsWith("-")) j++;
      if (TOOL_FILE.test(run.args[j] ?? "")) k = j;
      [script, ...args] = run.args.slice(k);
    }
    const tool = TOOL_FILE.exec(script ?? "");
    if (tool) found.push({ tool: tool[1].toLowerCase() === "sage-pr" ? "pr" : "state", script, args, dir: uncertainDirectory ? undefined : run.dir });
  }
  return found;
}

/**
 * Each gh run of a command line, at any depth that the reader sees, as { group, sub, method, args }: gh's first two
 * command words (after its own options) and, for gh api, the request's method. gh by another name (a copy, an alias or
 * an extension) and gh behind a wrapper that the reader does not know are limits of the hook. It throws when the reader
 * cannot read the line.
 */
export function ghRuns(command, cwd, path) {
  const { programs } = programsRun(command, cwd, path, { contextEvidence: true });
  return programs.filter(({ run, wrapper }) => !wrapper && programName(run.word) === "gh").map(({ run }) => {
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
