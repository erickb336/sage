import { isAbsolute } from "node:path";
import { programsRun } from "./command-reader.mjs";
import { PR } from "./pull-request.mjs";

const MERGE_FORM = "gh pr merge <n> --squash --delete-branch --match-head-commit <sha>";
const bare = (text) => text.replace(/\\\n/g, "").replace(/['"\\]/g, "");

/** Recognize executable spellings across providers without changing arguments or merge authorization. */
export { programName } from "./program-name.mjs";
import { programName } from "./program-name.mjs";

/**
 * Text that names a merge: the word gh and the word merge in any order (so also "$G pr merge" or "gh pr $(echo merge)"),
 * a merge path of the REST API, or a GraphQL merge mutation. Each test is one linear scan.
 */
export const mentionsMerge = (text) =>
  (/\bgh\b/i.test(text) && /\bmerge\b/i.test(text)) || (/\bpulls\//i.test(text) && /\/merge\b/i.test(text)) || /\/merges\b|\b(?:mergePullRequest|mergeBranch|enablePullRequestAutoMerge)\b/i.test(text);

/** git's options before its subcommand, and the ones that take the next word as their value. */
export const GIT_VALUE = /^(?:-C|-c|--git-dir|--work-tree|--namespace|--config-env|--super-prefix)$/;
export const gitSubcommand = (words, k) => {
  while (words[k]?.startsWith("-")) k += GIT_VALUE.test(words[k]) ? 2 : 1;
  return words[k] ?? "";
};

/** gh's own options that take the next word as their value, before or between its command words. */
const GH_VALUE = /^(?:-R|--repo)$/;
/** gh's command words: its words without options and their values, so "gh -R o/r pr view 1" gives pr, view, 1. */
export const ghWords = (args) => args.filter((a, k) => !a.startsWith("-") && !GH_VALUE.test(args[k - 1] ?? ""));
/**
 * The option that stands before gh's first command word, or between its first two (other than -R or --repo and its
 * value), or undefined (F-T815-5). gh lets an option take the next word as its value, so "gh pr -b view merge 12" runs
 * gh pr merge: the hook cannot tell gh's command words then. A command with no subcommand (GH_LEAF; after api comes an
 * endpoint) counts only the options before it.
 */
export function ghOptionBefore(args) {
  let words = 0;
  for (let k = 0; k < args.length && words < 2; k++) {
    if (GH_VALUE.test(args[k])) k++;
    else if (/^-R.|^--repo=/.test(args[k])) continue;
    else if (args[k].startsWith("-")) return args.slice(k + 1).some((a) => !a.startsWith("-")) ? args[k] : undefined;
    else if (++words === 1 && GH_LEAF.test(args[k])) return undefined;
  }
  return undefined;
}
/** gh's commands that take no subcommand: their next word is an argument, not a command word. */
const GH_LEAF = /^(?:api|browse|status|version|completion|help)$/;
/**
 * gh api's options other than -X and --method that take the next word as their value (gh api --help), so that the word
 * after them is never read as an option: in gh api -X PATCH <path> -t -XGET, gh sends PATCH (F-T815-27).
 */
export const GH_API_VALUE = /^(?:-[HqtpfF]|--(?:header|jq|template|preview|raw-field|field|hostname|cache|input))$/;
/** gh api's request method: its -X or --method, also in a cobra bundle (-iX DELETE, -iXDELETE), else POST with a field or an input, else GET. */
export function ghApiMethod(args) {
  let method, payload = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k].replace(/^-[ih]+(?=[^-])/, "-"); // cobra bundles flags: -iX DELETE is -i -X DELETE
    if (a === "-X" || a === "--method") method = args[++k];
    else if (/^-X./.test(a)) method = a.slice(2).replace(/^=/, "");
    else if (a.startsWith("--method=")) method = a.slice(9);
    else {
      if (/^(?:-[fF]|--field|--raw-field|--input)(?:$|=)|^-[fF]./.test(a)) payload = true;
      if (GH_API_VALUE.test(a)) k++;
    }
  }
  return String(method ?? (payload ? "POST" : "GET")).toUpperCase();
}
/**
 * The refusal of a line that the reader cannot read and whose text names what a rule guards (T815): the cause and the
 * way forward first, in the same words for every rule, then what the text names. The rule's own text follows it.
 */
export const unreadable = (error, what) => {
  const cause = String(error?.message ?? error);
  const way = /nested more than/.test(cause) ? "Run the inner command as a command of its own." : "Close each quote, substitution and heredoc.";
  return `the hook cannot read this command (${cause}), so it refuses it. ${way} Its text names ${what}.`;
};
/**
 * A merge path of the REST API (a pull request's pulls/<n>/merge, or a repository's merges, which merges a branch into a
 * base), or a GraphQL mutation that merges, in a word of a request.
 */
const apiMerges = (words) => words.some((w) => /(?:^|\/)pulls\/+[^/\s?#]+\/+merge(?![\w-])|(?:^|\/)(?:repos\/+[^/\s?#]+\/+[^/\s?#]+|repositories\/+\d+)\/+merges(?![\w-])/i.test(w) || /\b(?:mergePullRequest|enablePullRequestAutoMerge|mergeBranch)\b/.test(w));
/** Programs that only print, list or search their words, or run git's or gh's own commands: a program name among their words is text. */
const TEXT = /^(?:echo|printf|cat|grep|rg|git|gh|ls|which)$/;
/**
 * The program among the words of a run that the reader gives (F-T815-30): the run's own word when names(its base name)
 * is true, else the first later word that names takes and whose later words command takes (by default: a word other
 * than an option follows), with the words after it. A wrapper that the reader does not know (arch -arm64, op run --,
 * script -q /dev/null, direnv exec .) runs the program in its words, so the rules read that program as they read a known
 * wrapper's. It returns the run with that program's word and arguments, or undefined when there is none.
 */
export function programAmong(run, names, command = (rest) => rest.some((a) => !a.startsWith("-"))) {
  const { word, args } = run;
  if (names(programName(word))) return run;
  if (TEXT.test(programName(word))) return undefined;
  const k = args.findIndex((w, i) => names(programName(w)) && command(args.slice(i + 1)));
  return k < 0 ? undefined : { ...run, word: args[k], args: args.slice(k + 1) };
}
/** gh's own command groups (gh 2.x help) and their built-in aliases (co, cs, at, ext, extensions): an extension or a user's alias is a limit. */
const GH_GROUPS = /^(?:agent-task|alias|api|at|attestation|auth|browse|cache|co|codespace|completion|config|copilot|cs|ext|extensions?|gist|gpg-key|issue|label|org|pr|preview|project|release|repo|ruleset|run|search|secret|ssh-key|status|variable|workflow)$/;
/**
 * The git or gh run of a run (F-T815-39, F-T815-42): the run itself when git or gh is its program, else the git or gh that
 * a wrapper the reader does not know runs (programAmong), when the words after it are a command of that program: for gh
 * a command group of gh and a word after it (gh repo sync, gh api <path>), for git a subcommand name (git -C x frobnicate).
 * So in brew install gh jq, man gh pr, cp gh backup or cp /usr/bin/git fakes/git the word is a file, not a program.
 */
export const gitOrGh = (run, name) => programAmong(run, (n) => n === name, name === "gh"
  ? (rest) => { const [group, next] = ghWords(rest); return GH_GROUPS.test(group ?? "") && next !== undefined; }
  : (rest) => /^[a-z][\w-]*$/i.test(gitSubcommand(rest, 0)));
/** Does a gh run merge: gh pr merge, or gh api with a merge path or a merge mutation in its words or its input? */
const ghMerges = (args, stdin = []) => {
  const [group, sub] = ghWords(args);
  return (group === "pr" && sub === "merge") || (group === "api" && apiMerges([...args, ...stdin]));
};

/** Conservative refusal candidates after an external command; never executable evidence or permission to run.
 * Inspect only literal command operand chains. Do not evaluate text, infer directory changes, or expand words.
 */
export function* externalCommandOperands(command, cwd, options) {
  const { programs } = programsRun(command, cwd, undefined, { ...options, contextEvidence: true });
  for (const entry of programs) {
    if (entry.wrapper || entry.shellFunction || entry.resolvedDeclaration) continue;
    let { word, args } = entry.run;
    while (word === "command") {
      let next = 0;
      while (args[next] === "-p") next++;
      if (args[next] === "--") next++;
      if (!args[next] || args[next].startsWith("-")) break; // queries and unknown options do not establish a command operand
      [word, ...args] = args.slice(next);
      yield { word, args };
    }
  }
}

/** Classify command text without executing it. The path is trusted provider configuration, never tool input.
 * A matching merge is only a candidate: role, mode and ledger approval are separate checks.
 */
export function createCommandPolicy({ stateToolPath, prPattern = PR } = {}) {
  if (stateToolPath !== undefined && (typeof stateToolPath !== "string" || !isAbsolute(stateToolPath) || /[\x00-\x1f\x7f]/.test(stateToolPath))) {
    throw new TypeError("stateToolPath must be an absolute path without control characters");
  }
  /**
   * Expansion in a command word can hide git, gh, push or merge, and so can an option before or between gh's command
   * words (ghOptionBefore). Arguments keep their ordinary braces and globs.
   */
  function expansionProblem(command, cwd, options = {}) {
    const expansion = /[{[*?]/;
    const expands = (word) => !/^(?:[{}]|\[\[?)$/.test(word) && expansion.test(word); // literal groups and test commands
    // The word as the command wrote it, in its own capitals, without control characters or quotes (F-T815-10).
    const shown = (word) => `"${String(word).replace(/[\x00-\x1f\x7f"]/g, "")}"`;
    const reason = (word) => `shell expansion in ${shown(word)} can hide the command. Use literal program and git or gh subcommand words, without {, [, * or ?.`;
    let runs;
    try {
      runs = programsRun(command, cwd, undefined, options);
      if (runs.some(run => run.word === "command")) runs.push(...externalCommandOperands(command, cwd, options));
    } catch (e) {
      // A line that the reader cannot read is refused only when it names a merge or a push: mergeRun and the push rule
      // judge that text themselves (T815).
      return e.code === "SAGE_POWERSHELL_LAUNCH" ? e.message : undefined;
    }
    for (const { word, args } of runs) {
      if (expands(word)) return reason(word);
      const name = programName(word);
      if (name === "git" && expansion.test(gitSubcommand(args, 0))) return reason(gitSubcommand(args, 0));
      if (name !== "gh") continue;
      const option = ghOptionBefore(args);
      if (option) return `gh reads ${shown(option)} before or between its command words, and an option there can take the next word as its value, so the hook cannot tell which command gh runs. Write gh's command words first, then the options, for example gh pr view 12 --json state. Only -R <owner/repo> or --repo <owner/repo> may come before them.`;
      let k = 0;
      for (let n = 0; n < 2; n++) {
        while (args[k]?.startsWith("-")) k += /^(?:-R|--repo)$/.test(args[k]) ? 2 : 1;
        const sub = args[k++] ?? "";
        if (expansion.test(sub)) return reason(sub);
        if (n === 0 && sub !== "pr") break; // api's next word is an endpoint, not a subcommand
      }
    }
    return undefined;
  }

  const CANNOT = `merge only with ${MERGE_FORM}, as a command of its own: not after or inside another command, not through gh api, curl or wget, and not with another flag.`;

  /**
   * The merge that a Bash command runs, judged by the programs that run, never by text (T815). Undefined when no program
   * merges. Else { pr, sha } when the whole command is the one merge form, which the merge check then decides, or
   * { problem }. A program merges when it is gh pr merge (after gh's own options), or gh api, curl or wget with a pull
   * request's merge path (pulls/<n>/merge) or a GraphQL merge mutation in its words or its input, at any depth that the
   * command reader sees (env, command, sh -c, eval, $( ), xargs, find -exec), also behind a wrapper that the reader does
   * not know (programAmong: arch -arm64 gh pr merge 12). A line that the reader cannot read is
   * refused only when its text names a merge. A gh alias or extension, and a variable or a script that merges, are
   * limits of the hook (docs/design/rules-in-code.md).
   */
  function mergeRun(command, cwd = process.cwd()) {
    const form = mergeForm(command);
    if (form) return form;
    let programs;
    try {
      ({ programs } = programsRun(command, cwd, undefined, { contextEvidence: true }));
    } catch (e) {
      return mentionsMerge(bare(command)) ? { problem: `${unreadable(e, "a merge")} Merge only with ${MERGE_FORM}, as a command of its own.` } : undefined;
    }
    for (const { run, wrapper, shellFunction } of programs) {
      if (wrapper || shellFunction) continue;
      const found = programAmong(run, (name) => /^(?:gh|curl|wget)$/.test(name));
      if (!found) continue;
      const merges = programName(found.word) === "gh" ? ghMerges(found.args, found.stdin) : apiMerges([...found.args, ...found.stdin]);
      if (merges) return { problem: CANNOT };
    }
    return undefined;
  }

  /** The merge form, when the command is one gh pr merge with plain words only: { pr, sha }, or { problem }. */
  function mergeForm(command) {
    const text = command.trim();
    const words = text.split(/[ \t]+/);
    if (words.slice(0, 3).join(" ") !== "gh pr merge" || /[^\w \t=-]/.test(text)) return undefined;
    const [, , , pr, ...flags] = words;
    // A null pattern preserves diagnostics when the provider state tool could not load.
    if (prPattern && !prPattern.test(pr ?? "")) return { problem: `name the pull request by its number (digits, no leading zero): ${MERGE_FORM}.` };
    const shas = [];
    const modes = new Set();
    for (let k = 0; k < flags.length; k++) {
      const f = flags[k];
      if (f === "--match-head-commit") shas.push(flags[++k] ?? "");
      else if (f.startsWith("--match-head-commit=")) shas.push(f.slice(f.indexOf("=") + 1));
      else if (f === "--squash" || f === "--delete-branch") modes.add(f);
      else return { problem: `merge only with ${MERGE_FORM}; "${f}" is not part of it.` };
    }
    if (!shas.length) return { problem: "merge only the checked commit: add --match-head-commit <the head SHA that the ledger verified>." };
    if (shas.length > 1) return { problem: `give --match-head-commit once, not ${shas.length} times: gh uses the last one, and the merge check reads one.` };
    if (!/^[0-9a-f]{40}$/i.test(shas[0])) return { problem: `--match-head-commit needs the full 40-character head SHA that the ledger verified, not "${shas[0]}".` };
    if (modes.size < 2) return { problem: `merge only with ${MERGE_FORM}: add --squash and --delete-branch.` };
    return { pr, sha: shas[0] };
  }

  /** The number of leading words that run, when the rest of a command's words are only text, else 0. A search runs
   * nothing that it names: not rg without --pre, and not git grep without -O (its pager). */
  function harmless([a, b, c, ...rest]) {
    const words = [b, c, ...rest];
    if (a === "echo" || a === "cat" || a === "grep" || (a === "printf" && !words.some((w) => w?.startsWith("-v")))) return 1;
    if (a === "rg" && !words.some((w) => /^--pre\b/.test(w ?? ""))) return 1;
    if (a === "git" && b === "-C" && rest[0] === "commit") return 4;
    if ((a === "git" && b === "grep" && !words.some((w) => /^(?:-O|--open-files-in-pager\b)/.test(w ?? ""))) || (a === "git" && b === "commit") || (a === "node" && stateToolPath !== undefined && b === stateToolPath)) return 2;
    return a === "gh" && b === "pr" && /^(?:create|comment|view|edit)$/.test(c ?? "") ? 3 : 0;
  }
  /** The commands that may end a pipe after a harmless command: they only cut, count or sort its text. */
  const FILTER = /^(?:head|tail|wc|sort|uniq|less)$/;
  const filters = (c) => FILTER.test(c.words[0] ?? "") && c.words.slice(1).every((w) => /^(?:-\w*|\d+)$/.test(w) && !/^-o|^--output/.test(w));
  /** Shell structure that can send a command's output somewhere other than its own line: then no text is harmless. */
  const STRUCTURE = /^(?:[{}!]|if|then|elif|else|fi|for|while|until|do|done|case|esac|select|function|time|coproc|alias|shopt|enable)$/;

  /**
   * The words of each command that can run: all its words and heredoc bodies, except the arguments and heredocs of a
   * harmless command whose output stays harmless. That command is not in a group, not written to a file that a later
   * command could run, is piped on only through filters, and, in a substitution, lands in a harmless argument itself.
   */
  function runnable(commands) {
    const structure = commands.some((c) => STRUCTURE.test(c.words[0] ?? ""));
    const last = commands.at(-1);
    const stays = (c) => !(c.writes && c !== last) && (!c.piped || (c.pipeTo && filters(c.pipeTo) && stays(c.pipeTo)));
    const contained = (c) => {
      const n = harmless(c.words);
      if (!n || structure || c.grouped || !stays(c)) return false;
      return !c.host || (contained(c.host.cmd) && (c.host.index < 0 || c.host.index >= harmless(c.host.cmd.words)));
    };
    return commands.map((c) => (contained(c) ? { cmd: c, words: c.words.slice(0, harmless(c.words)), bodies: [] } : { cmd: c, words: c.words, bodies: c.bodies }));
  }

  return Object.freeze({ expansionProblem, mergeRun, runnable });
}
