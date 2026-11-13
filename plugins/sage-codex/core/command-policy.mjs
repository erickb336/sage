import { programsRun } from "./command-reader.mjs";
import { PR } from "./pull-request.mjs";

const MERGE_FORM = "gh pr merge <n> --squash --delete-branch --match-head-commit <sha>";
const bare = (text) => text.replace(/\\\n/g, "").replace(/['"\\]/g, "");

export { programName } from "./program-name.mjs";
import { programName } from "./program-name.mjs";

export const mentionsMerge = (text) => /\bgh\b/i.test(text) && /\bmerge\b/i.test(text);

export const GIT_VALUE = /^(?:-C|-c|--git-dir|--work-tree|--namespace|--config-env|--super-prefix)$/;
export const gitSubcommand = (words, k) => {
  while (words[k]?.startsWith("-")) k += GIT_VALUE.test(words[k]) ? 2 : 1;
  return words[k] ?? "";
};

const GH_VALUE = /^(?:-R|--repo)$/;
export const ghWords = (args) => args.filter((a, k) => !a.startsWith("-") && !GH_VALUE.test(args[k - 1] ?? ""));
const GH_API_VALUE = /^(?:-[HqtpfF]|--(?:header|jq|template|preview|raw-field|field|hostname|cache|input))$/;
export function ghApiMethod(args) {
  let method, payload = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k].replace(/^-[ih]+(?=[^-])/, "-");
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
export const unreadable = (error, what) => {
  const cause = String(error?.message ?? error);
  const way = /nested more than/.test(cause) ? "Run the inner command as a command of its own." : "Close each quote, substitution and heredoc.";
  return `the hook cannot read this command (${cause}), so it refuses it. ${way} Its text names ${what}.`;
};
export function createCommandPolicy({ prPattern = PR } = {}) {
  const CANNOT = `merge only with ${MERGE_FORM}, as a command of its own: not after or inside another command, and not with another flag.`;

  function mergeRun(command, cwd = process.cwd()) {
    const form = mergeForm(command);
    if (form) return form;
    let programs;
    try {
      ({ programs } = programsRun(command, cwd, undefined, { contextEvidence: true }));
    } catch (e) {
      return mentionsMerge(bare(command)) ? { problem: `${unreadable(e, "a merge")} Merge only with ${MERGE_FORM}, as a command of its own.` } : undefined;
    }
    const merges = ({ run, wrapper }) => !wrapper && programName(run.word) === "gh" && ghWords(run.args).slice(0, 2).join(" ") === "pr merge";
    return programs.some(merges) ? { problem: CANNOT } : undefined;
  }

  function mergeForm(command) {
    const text = command.trim();
    const words = text.split(/[ \t]+/);
    if (words.slice(0, 3).join(" ") !== "gh pr merge" || /[^\w \t=-]/.test(text)) return undefined;
    const [, , , pr, ...flags] = words;
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
