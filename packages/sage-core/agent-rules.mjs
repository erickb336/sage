// The command rules that both providers hold for their agents (T931): no git stash, no process program, and the board
// password rule (T229). The Claude sage hook and the Codex gate call these; each provider decides who is an agent.
// The rules guard ordinary commands against honest mistakes (standing order 70): a variable, a pattern after the
// literal part, a link, a wrapper that the reader does not know and code inside a script are limits.
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { programsRun } from "./command-reader.mjs";
import { gitSubcommand, programName, unreadable } from "./command-policy.mjs";
import { canonical } from "./protected-paths.mjs";

const fold = (text) => text.normalize("NFKC").toLowerCase();
/** A command line without quotes, backslashes and line joins: the text that a rule tests when the reader cannot read the line (fail closed). */
const bare = (text) => text.replace(/\\\n/g, "").replace(/['"\\]/g, "");
/** The word git, and then a later word: one linear scan from the first git. */
const gitThen = (text, word) => new RegExp(`\\b${word}\\b`, "i").test(/\bgit\b([\s\S]*)/i.exec(text)?.[1] ?? "");
/** A word in quotes for a refusal, without control, format or quote characters, at most 60 characters. */
const quoted = (name) => `"${[...String(name).replace(/(?! )[\p{Cc}\p{Cf}\p{Z}"'`‘-‟＂]/gu, "")].slice(0, 60).join("")}"`;
const from = (cwd, path) => (isAbsolute(path) ? path : `${cwd}/${path}`);

/**
 * Two lessons that came back, held for agents in every tool that runs a command line. An agent never runs git stash
 * in any form: every worktree of a repo shares one stash list, so another agent's pop can take it (standing order 16).
 * An agent never lists or signals the real processes (standing order 14): a process program passes only when its
 * word resolves, through PATH and links, to a file in the temp folder. A bare kill is the shell's builtin, so it never
 * passes. A process.kill inside a script is not visible here.
 */
const NO_STASH = "an agent never runs git stash: every worktree of a repo shares one stash list, so another agent can pop or drop your work (standing order 16). To test old code, use git worktree add --detach <scratch> <sha>, or git show <sha>:<path> into your scratch folder.";
/** The process programs: names ignore case and a trailing .exe, including PowerShell names. */
const UNIX_PROCESS = "ps|pgrep|pkill|kill|killall|lsof|top|htop|fuser|pidof|kill-port|fkill|launchctl";
const POWERSHELL_PROCESS = "get-process|stop-process|gps|spps";
/** A program name, without the version that npx and its kind take after "@" (kill-port@2). */
const isProcess = (name = "") => {
  const bare = programName(name.replace(/(?<=.)@.*$/, ""));
  return new RegExp(`^(?:${UNIX_PROCESS})$`, "i").test(bare) || new RegExp(`^(?:${POWERSHELL_PROCESS})$`, "i").test(bare);
};
const NO_PROCESS = (word) => `an agent never reads or signals the real process list (standing order 14), so ${quoted(word)} is refused. Put a fake ps first on PATH, in the temp folder or your scratch folder, that prints a start time in the past (for example "Sat Jan  1 00:00:00 2000"), and run a fake kill by its path: a bare kill is the shell's builtin. Use literal paths: the hook does not expand variables. To stop your own server or background job, run it as a background task and stop that task.`;
const TEMP = [...new Set([tmpdir(), "/tmp", process.env.TMPDIR].filter(Boolean).map((d) => { try { return realpathSync.native(d); } catch { return resolve(d); } }))];
const inTemp = (file) => !!file && TEMP.some((t) => file.startsWith(`${t}/`));
const PROCESS_TEXT = new RegExp(`(?:^|[\\s;&|(\`'"/<>])(?:${UNIX_PROCESS}|${POWERSHELL_PROCESS})(?:\\.exe)?(?=$|[\\s;&|)\`'"<>])`, "im");

/** Why an agent's command line is refused by the stash rule or the process rule, or undefined when it passes. */
export function agentCommandProblem(command, cwd, path = process.env.PATH ?? "") {
  let runs;
  try {
    runs = programsRun(command, cwd, path);
  } catch (e) {
    // A line that the reader cannot read is refused only when its text names a stash or a process program: the cause
    // and the way forward first, then the rule (F-T815-9).
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

/**
 * The board password rule (T229): the board password is the owner's alone. No one:
 *   - runs a program, other than grep or rg, with the word --set-password (a line that the reader cannot read is
 *     refused when its text has it);
 *   - names the board config folder ~/.config/sage-board, its board.json or a temporary .board-*.json, in a command, a
 *     redirection or a file tool's path. A path resolves against its working folder first (., .., //, ~ and git -C), as
 *     written: a link to the config is a limit. A word counts by its literal part, the text before its first variable,
 *     substitution or pattern character (T815), also as the value of key=value or --option=value;
 *   - searches, copies, moves or links that folder or a folder above it (grep -r, rg, find -exec, cp -R, tar, mv, ln,
 *     and a provider's search tools).
 * Only the board command may name its config, as the value of --config. Only the home folder counts: a repository path
 * such as packages/sage-board, or a search word such as board.json, is not the config.
 */
const BOARD_RULE = "the board password rule (T229)";
const SET_PASSWORD = `${BOARD_RULE}: only the owner sets the board password, in Terminal on the Mac. Never run board --set-password: give the owner the command to run there, and never ask for the password in the chat.`;
const BOARD_CONFIG = `${BOARD_RULE}: no agent reads, copies or replaces the board config (~/.config/sage-board/board.json), or searches, copies or moves a folder that holds it, because it holds the owner's password hash. The board command's own output (board --ensure, the chat board) says what you need.`;
const VARIABLE = /[$`]/;
/** The board config folder, as written from home and as its real path, in lower case: the two spellings a path can have. */
function boardFolders(home) {
  const folder = join(home, ".config", "sage-board");
  let resolved = fold(folder);
  try { resolved = canonical(folder); } catch {}
  return [...new Set([fold(folder), resolved])];
}
/** The parts of a path word from its folder (undefined: not known), with ., .. and // resolved. A variable stays a part. */
function pathParts(word, dir, home) {
  const start = word.startsWith("/") ? [] : /^~(?:\/|$)/.test(word) ? home.split("/") : /^[$`~]/.test(word) ? [] : dir === undefined ? ["$"] : dir.split("/");
  const parts = [];
  for (const part of [...start, ...word.replace(/^~[^/]*/, (t) => (t === "~" ? "" : "$")).split("/")]) {
    if (!part || part === ".") continue;
    // ".." removes the part before it, unless that part is a variable, which can stand for any number of parts.
    if (part === "..") { if (parts.length && !VARIABLE.test(parts.at(-1))) parts.pop(); continue; }
    parts.push(part);
  }
  return parts;
}
/**
 * What a word (a path from the folder dir, maybe with ~, a pattern or a variable) can stand for: config, the board
 * config folder, its board.json or a temporary .board-*.json; above, that folder or a folder above it.
 */
function boardReach(word, dir, folders, home) {
  // The literal part of the word: the text before its first variable, substitution or pattern character (T815). A word
  // that starts with a variable or a substitution has none; a relative pattern stands for its own folder.
  const cut = word.search(/[$`*?[{]/);
  if (!word || (cut === 0 && /^[$`]/.test(word))) return {};
  const literal = cut < 0 ? word : word.slice(0, cut) || ".";
  if (literal.length > 4096) return {}; // the system opens no path this long
  // As written: a link to the config is a limit of the hook (standing order 70).
  const path = fold(`/${pathParts(literal, dir, home).join("/")}`);
  const is = (p) => p === path;
  const temporary = (f) => dirname(path) === f && /^\.board-.*\.json$/.test(basename(path));
  return {
    config: folders.some((f) => is(f) || is(`${f}/board.json`) || is(`${f}/.board-000000000000.json`) || temporary(f)),
    above: folders.some((f) => f.split("/").some((_, k, all) => is(all.slice(0, k + 1).join("/") || "/"))),
  };
}
/**
 * Why a file tool's path is refused by the board password rule, or undefined. search: the tool searches the folder
 * (a grep or a glob tool), so a folder above the config counts too.
 */
export function boardPathProblem(path, cwd, { home = process.env.HOME || homedir(), search = false } = {}) {
  const reach = boardReach(path, cwd, boardFolders(home), home);
  return reach.config || (search && reach.above) ? BOARD_CONFIG : undefined;
}
/** Programs that read, copy or move a whole folder: always, or with a recursive option. They also search their folder. */
const SEARCHES = /^(?:e|f)?grep$|^(?:rg|ag|ack|find|fd)$/;
const WHOLE = (name, args) => /^(?:rg|ag|ack|fd|ditto|tar|bsdtar|zip|rsync|mv|ln)$/.test(name) ||
  // find lists names; only a program that it runs on each file reads one (F-T909-9: find ~ -name '*.tmp' -delete passes).
  (name === "find" && args.some((a) => /^-(?:exec|execdir|ok|okdir)$/.test(a))) ||
  (/^(?:e|f)?grep$/.test(name) && args.some((a) => /^-[^-]*[rR]|^--(?:recursive|dereference-recursive|directories=recurse)$|^recurse$/.test(a))) ||
  (/^(?:cp|gcp|scp)$/.test(name) && args.some((a) => /^-[^-]*[rRa]|^--(?:recursive|archive)$/.test(a)));
const BOARD_RUN = ({ word, args }) => (basename(word) === "cli.mjs" || args.some((a) => /(?:^|\/)cli\.mjs$/i.test(a)) || /^(?:npm|pnpm|yarn|bun)$/.test(programName(word))) && args.includes("board");
/**
 * Why one command line is refused by the board password rule, or undefined. uncertain: the folder of the line is not
 * known (a working folder with a variable), so only an absolute path or a path from ~ counts.
 */
export function boardCommandProblem(text, cwd, { home = process.env.HOME || homedir(), uncertain = false } = {}) {
  let read;
  try {
    read = programsRun(text, cwd, undefined, { contextEvidence: true, uncertainDirectory: uncertain, home });
  } catch {
    // The reader cannot read the line: it is refused only when its text has the option word (fail closed). A word such
    // as a checkout path that holds "board" or "config" is not the config (T632).
    return /--set-password/.test(text.replace(/['"\\]/g, "")) ? SET_PASSWORD : undefined;
  }
  // Each word once per line: a long command line often repeats its words.
  const folders = boardFolders(home), seen = new Map();
  const reachOf = (word, dir) => {
    const key = `${dir}\0${word}`;
    if (!seen.has(key)) seen.set(key, boardReach(word, dir, folders, home));
    return seen.get(key);
  };
  for (const { run, uncertainDirectory } of read.programs) {
    const name = programName(run.word), board = BOARD_RUN(run);
    // The option word, in a run that is not a search for it (grep or rg).
    if (!/^(?:e|f)?grep$|^rg$/.test(name) && run.args.some((a) => /^--set-password(?:=|$)/.test(a))) return SET_PASSWORD;
    const whole = WHOLE(name, run.args);
    const start = uncertainDirectory ? undefined : run.dir;
    let dir = start;
    for (const [k, arg] of run.args.entries()) {
      const value = arg.startsWith("-") ? arg.slice(arg.indexOf("=") + 1 || arg.length) : arg;
      if (!value) continue;
      for (const path of [value, /^[\w.-]+=(.+)$/s.exec(value)?.[1]].filter(Boolean)) {
        const reach = reachOf(path, dir);
        // Only the board command may name its config, as the value of --config.
        if (reach.config && !(board && (run.args[k - 1] === "--config" || arg.startsWith("--config=")))) return BOARD_CONFIG;
        if (reach.above && whole) return BOARD_CONFIG;
      }
      // git -C <folder>: the path words after it are from that folder.
      if (name === "git" && run.args[k - 1] === "-C") dir = /[$`]|^~[^/]/.test(value) || (dir === undefined && !/^[/~]/.test(value)) ? undefined : from(dir ?? "/", value.replace(/^~(?=\/|$)/, home));
    }
    if (SEARCHES.test(name) && whole && reachOf(".", start).above) return BOARD_CONFIG;
  }
  for (const { redirect, dir, uncertainDirectory } of read.redirects) if (reachOf(redirect.replace(/^\d*[<>&|]+/, ""), uncertainDirectory ? undefined : dir).config) return BOARD_CONFIG;
  return undefined;
}
