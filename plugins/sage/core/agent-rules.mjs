import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { programsRun } from "./command-reader.mjs";
import { gitSubcommand, programName, unreadable } from "./command-policy.mjs";
import { commandWrites, gitDestroysWork } from "./shell-write-policy.mjs";
import { worktreeRoot } from "./worktrees.mjs";

const bare = (text) => text.replace(/\\\n/g, "").replace(/['"\\]/g, "");
const gitThen = (text, word) => new RegExp(`\\b${word}\\b`, "i").test(/\bgit\b([\s\S]*)/i.exec(text)?.[1] ?? "");
const quoted = (name) => `"${[...String(name).replace(/(?! )[\p{Cc}\p{Cf}\p{Z}"'`‘-‟＂]/gu, "")].slice(0, 60).join("")}"`;

const NO_STASH = "an agent never runs git stash: every worktree of a repo shares one stash list, so another agent can pop or drop your work (standing order 16). To test old code, use git worktree add --detach <scratch> <sha>, or git show <sha>:<path> into your scratch folder.";
const UNIX_PROCESS = "ps|pgrep|pkill|kill|killall|lsof|top|htop|fuser|pidof|kill-port|fkill|launchctl";
const POWERSHELL_PROCESS = "get-process|stop-process|gps|spps";
const isProcess = (name = "") => {
  const bare = programName(name.replace(/(?<=.)@.*$/, ""));
  return new RegExp(`^(?:${UNIX_PROCESS})$`, "i").test(bare) || new RegExp(`^(?:${POWERSHELL_PROCESS})$`, "i").test(bare);
};
const NO_PROCESS = (word) => `an agent never reads or signals the real process list (standing order 14), so ${quoted(word)} is refused. Put a fake ps in a folder under the temp folder (/tmp, or the folder that TMPDIR names) and put that folder first on PATH: a fake in any other folder is refused. The fake prints a start time in the past (for example "Sat Jan  1 00:00:00 2000"). Run a fake kill by its path: a bare kill is the shell's builtin. Use literal paths: the hook does not expand variables. To stop your own server or background job, run it as a background task and stop that task.`;
export const TEMP = [...new Set([tmpdir(), "/tmp", process.env.TMPDIR].filter(Boolean).map((d) => { try { return realpathSync.native(d); } catch { return resolve(d); } }))];
export const CHIEF_SHELL = 'sage mode is on, so the chief does not change files, also not from the shell: this command has a write form (a redirection or a heredoc into a file, tee, cp, mv, rm, sed -i, code in node -e, or gh repo clone, gh run download or gh extension install) outside your scratch places. Brief an implementer to make this change. Your scratch places are the temp folder and the sage worktrees folder (~/sage-worktrees, which holds the pages folder that the pages command of the state tool prints), outside the project. There a redirection, rm, rmdir, touch, tee, cp, mv and a gh clone or download run, with literal paths (for example > /tmp/notes/out.txt, or rm -rf /tmp/notes). sed -i, code in node -e and the other forms are refused also there. gh, the sage tools, reads and git run as before, except git rm, git mv and the git forms that throw away uncommitted work. The user ends sage mode with the message "sage mode off", alone.';
export const chiefPlaces = (env = process.env) => [...TEMP, worktreeRoot(env)];
export const CHIEF_WORKTREE = 'sage mode is on, so the chief does not change a git work tree in the sage worktrees folder (~/sage-worktrees): a task worktree or a clone there holds repository files, and rm -rf can lose uncommitted work. This command writes into a work tree there, or removes a folder that holds one. To remove a worktree, run git worktree remove <path> (without --force): git refuses a worktree with changes. For a clone or any other change, brief an implementer or ask the owner. Folders there that hold no work tree stay your scratch place.';
export const CHIEF_GIT = 'sage mode is on, so the chief does not throw away uncommitted work: git reset --hard, git checkout -- <path> (or ., or --force), git clean -f, git restore of the work tree and git worktree remove --force can destroy changes in the owner\'s checkout or a task\'s worktree. Make a scratch worktree in the temp folder and run the command there (for example git worktree add --detach /tmp/<name>/wt <sha>, then git -C /tmp/<name>/wt reset --hard), or ask the owner. git commit, git checkout <branch>, git fetch, git merge-tree, git commit-tree, git worktree add, git worktree remove without --force, and reads run as before.';
export function chiefShellProblem(command, cwd, env = process.env) {
  const guard = [worktreeRoot(env)];
  if (gitDestroysWork(command, cwd, TEMP, guard)) return CHIEF_GIT;
  const places = chiefPlaces(env), options = { placed: true, home: env.HOME || homedir() };
  if (!commandWrites(command, cwd, places, { ...options, guard })) return undefined;
  return commandWrites(command, cwd, places, options) ? CHIEF_SHELL : CHIEF_WORKTREE;
}
export const READ_ONLY_SHELL_WAY = "To keep output or a probe, redirect it into your scratch folder in the temp folder, with a literal path (for example > /tmp/<run>/out.txt). To try a changed copy, write the copy the same way: git show <sha>:<path> | sed 's/a/b/' > /tmp/<run>/copy.mjs. To check out a head, make a worktree in your scratch folder: git worktree add --detach /tmp/<run>/head <sha>; git commands run there.";
const inTemp = (file) => !!file && TEMP.some((t) => file.startsWith(`${t}/`));
const PROCESS_TEXT = new RegExp(`(?:^|[\\s;&|(\`'"/<>])(?:${UNIX_PROCESS}|${POWERSHELL_PROCESS})(?:\\.exe)?(?=$|[\\s;&|)\`'"<>])`, "im");

export function agentCommandProblem(command, cwd, path = process.env.PATH ?? "") {
  let runs;
  try {
    runs = programsRun(command, cwd, path);
  } catch (e) {
    const text = bare(command), program = PROCESS_TEXT.exec(text)?.[0].replace(/^\W/, "");
    const [what, why] = gitThen(text, "stash") ? ["git stash", NO_STASH] : program ? [`a process program (${quoted(program)})`, NO_PROCESS(program)] : [];
    return why && `${unreadable(e, what)} ${why[0].toUpperCase()}${why.slice(1)}`;
  }
  for (const { word, file, args } of runs) {
    const name = programName(word);
    if (name === "git" && /^stash$/i.test(gitSubcommand(args, 0))) return NO_STASH;
    if ((isProcess(name) || isProcess(file ?? "")) && !inTemp(file)) return NO_PROCESS(word);
  }
  return undefined;
}
