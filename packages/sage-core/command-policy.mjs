import { programsRun } from "./command-reader.mjs";
import { PR } from "./pull-request.mjs";

const MERGE_FORM = "gh pr merge <n> --squash --delete-branch --match-head-commit <sha>";
const bare = (text) => text.replace(/\\\n/g, "").replace(/['"\\]/g, "");

/** Recognize executable spellings across providers without changing arguments or merge authorization. */
export { programName } from "./program-name.mjs";
import { programName } from "./program-name.mjs";

/** Text that names a merge: the word gh and the word merge in any order. Each test is one linear scan. */
export const mentionsMerge = (text) => /\bgh\b/i.test(text) && /\bmerge\b/i.test(text);

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
 * gh api's options other than -X and --method that take the next word as their value (gh api --help), so that the word
 * after them is never read as an option: in gh api -X PATCH <path> -t -XGET, gh sends PATCH (F-T815-27).
 */
const GH_API_VALUE = /^(?:-[HqtpfF]|--(?:header|jq|template|preview|raw-field|field|hostname|cache|input))$/;
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
/** Classify command text without executing it. A matching merge is only a candidate: role, mode and ledger approval are separate checks. */
export function createCommandPolicy({ prPattern = PR } = {}) {
  const CANNOT = `merge only with ${MERGE_FORM}, as a command of its own: not after or inside another command, and not with another flag.`;

  /**
   * The merge that a Bash command runs, judged by the programs that run, never by text (T815). Undefined when no program
   * merges. Else { pr, sha } when the whole command is the one merge form, which the merge check then decides, or
   * { problem }. A program merges when it is gh pr merge (after gh's own options), at any depth that the command reader
   * sees (env, command, sh -c, eval, $( ), xargs, find -exec). A line that the reader cannot read is refused only when
   * its text names a merge. A merge through gh api, curl or wget, a gh alias or extension, a wrapper that the reader does
   * not know, and a variable or a script that merges are limits of the hook (docs/design/rules-in-code.md).
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
    // A wrapper's own entry is not the program.
    const merges = ({ run, wrapper }) => !wrapper && programName(run.word) === "gh" && ghWords(run.args).slice(0, 2).join(" ") === "pr merge";
    return programs.some(merges) ? { problem: CANNOT } : undefined;
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

  return Object.freeze({ mergeRun });
}
