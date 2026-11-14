import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { programsRun } from "./command-reader.mjs";
import { gitSubcommand, programName, unreadable } from "./command-policy.mjs";
import { canonical } from "./protected-paths.mjs";
import { commandWrites, gitDestroysWork } from "./shell-write-policy.mjs";
import { worktreeRoot } from "./worktrees.mjs";

const fold = (text) => text.normalize("NFKC").toLowerCase();
const bare = (text) => text.replace(/\\\n/g, "").replace(/['"\\]/g, "");
const gitThen = (text, word) => new RegExp(`\\b${word}\\b`, "i").test(/\bgit\b([\s\S]*)/i.exec(text)?.[1] ?? "");
const quoted = (name) => `"${[...String(name).replace(/(?! )[\p{Cc}\p{Cf}\p{Z}"'`‘-‟＂]/gu, "")].slice(0, 60).join("")}"`;
const from = (cwd, path) => (isAbsolute(path) ? path : `${cwd}/${path}`);

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

const BOARD_CONFIG = "the board config rule (T229): no agent reads, copies or replaces the board config (~/.config/sage-board/board.json), or lists, searches, copies or moves the board's folder or a folder that holds it, because only the owner and the board command change the board's state. The board command's own output (board --ensure, the chat board) says what you need. The rule covers the board's state folder (~/.config/sage-board/state) too, because it holds the browser pairing (T1059).";
const BOARD_PAIR = "the board pairing rule (T1059): no agent runs board --pair. It pairs the owner's browser with the board, so that the browser can answer questions and rename chiefs, and it prints a one-time code for the owner's eyes only. The owner runs it in Terminal; give the owner the command, and do not run it.";
const VARIABLE = /[$`]/;
function boardFolders(home) {
  const folder = join(home, ".config", "sage-board");
  let resolved = fold(folder);
  try { resolved = canonical(folder); } catch {}
  return [...new Set([fold(folder), resolved])];
}
function pathParts(word, dir, home) {
  const start = word.startsWith("/") ? [] : /^~(?:\/|$)/.test(word) ? home.split("/") : /^[$`~]/.test(word) ? [] : dir === undefined ? ["$"] : dir.split("/");
  const parts = [];
  for (const part of [...start, ...word.replace(/^~[^/]*/, (t) => (t === "~" ? "" : "$")).split("/")]) {
    if (!part || part === ".") continue;
    if (part === "..") { if (parts.length && !VARIABLE.test(parts.at(-1))) parts.pop(); continue; }
    parts.push(part);
  }
  return parts;
}
function boardReach(word, dir, folders, home) {
  const cut = word.search(/[$`*?[{]/);
  if (!word || (cut === 0 && /^[$`]/.test(word))) return {};
  const literal = cut < 0 ? word : word.slice(0, cut) || ".";
  if (literal.length > 4096) return {};
  const path = fold(`/${pathParts(literal, dir, home).join("/")}`);
  const is = (p) => p === path;
  const temporary = (f) => dirname(path) === f && /^\.board-.*\.json$/.test(basename(path));
  return {
    config: folders.some((f) => is(f) || is(`${f}/board.json`) || is(`${f}/.board-000000000000.json`) || temporary(f) || is(`${f}/state`) || path.startsWith(`${f}/state/`)),
    above: folders.some((f) => f.split("/").some((_, k, all) => is(all.slice(0, k + 1).join("/") || "/"))),
  };
}
export function boardPathProblem(path, cwd, { home = process.env.HOME || homedir(), search = false } = {}) {
  const reach = boardReach(path, cwd, boardFolders(home), home);
  return reach.config || (search && reach.above) ? BOARD_CONFIG : undefined;
}
const SEARCHES = /^(?:e|f)?grep$|^(?:rg|ag|ack|find|fd)$/;
const WHOLE = (name, args) => /^(?:rg|ag|ack|fd|ditto|tar|bsdtar|zip|rsync|mv|ln)$/.test(name) ||
  (name === "find" && args.some((a) => /^-(?:exec|execdir|ok|okdir)$/.test(a))) ||
  (/^(?:e|f)?grep$/.test(name) && args.some((a) => /^-[^-]*[rR]|^--(?:recursive|dereference-recursive|directories=recurse)$|^recurse$/.test(a))) ||
  (/^(?:cp|gcp|scp)$/.test(name) && args.some((a) => /^-[^-]*[rRa]|^--(?:recursive|archive)$/.test(a)));
const BOARD_RUN = ({ word, args }) => (basename(word) === "cli.mjs" || args.some((a) => /(?:^|\/)cli\.mjs$/i.test(a)) || /^(?:npm|pnpm|yarn|bun)$/.test(programName(word))) && args.includes("board");
export function boardCommandProblem(text, cwd, { home = process.env.HOME || homedir(), uncertain = false } = {}) {
  let read;
  try {
    read = programsRun(text, cwd, undefined, { contextEvidence: true, uncertainDirectory: uncertain, home });
  } catch {
    return undefined;
  }
  const folders = boardFolders(home), seen = new Map();
  const reachOf = (word, dir) => {
    const key = `${dir}\0${word}`;
    if (!seen.has(key)) seen.set(key, boardReach(word, dir, folders, home));
    return seen.get(key);
  };
  for (const { run, uncertainDirectory } of read.programs) {
    const name = programName(run.word), board = BOARD_RUN(run);
    if (board && run.args.some((a) => /^--pair(?:=|$)/.test(a))) return BOARD_PAIR;
    const whole = WHOLE(name, run.args);
    const start = uncertainDirectory ? undefined : run.dir;
    let dir = start;
    for (const [k, arg] of run.args.entries()) {
      const value = arg.startsWith("-") ? arg.slice(arg.indexOf("=") + 1 || arg.length) : arg;
      if (!value) continue;
      for (const path of [value, /^[\w.-]+=(.+)$/s.exec(value)?.[1]].filter(Boolean)) {
        const reach = reachOf(path, dir);
        if (reach.config && !(board && (run.args[k - 1] === "--config" || arg.startsWith("--config=")))) return BOARD_CONFIG;
        if (reach.above && whole) return BOARD_CONFIG;
      }
      if (name === "git" && run.args[k - 1] === "-C") dir = /[$`]|^~[^/]/.test(value) || (dir === undefined && !/^[/~]/.test(value)) ? undefined : from(dir ?? "/", value.replace(/^~(?=\/|$)/, home));
    }
    if (SEARCHES.test(name) && whole && reachOf(".", start).above) return BOARD_CONFIG;
  }
  for (const { redirect, dir, uncertainDirectory } of read.redirects) if (reachOf(redirect.replace(/^\d*[<>&|]+/, ""), uncertainDirectory ? undefined : dir).config) return BOARD_CONFIG;
  return undefined;
}
