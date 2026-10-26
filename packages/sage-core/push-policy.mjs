import { resolve } from "node:path";
import { programsRun, shellCommands } from "./command-reader.mjs";
import { createCommandPolicy, externalCommandOperands, GIT_VALUE, gitSubcommand, programName } from "./command-policy.mjs";
import { commandWrites } from "./shell-write-policy.mjs";

/** The owner/name of a GitHub repository URL as git writes it (https, ssh or scp form), or undefined for any other URL. */
export function gitHubRepository(url) {
  // https or ssh with an optional user (and port), or the scp form user@host:owner/name; the host is github.com or
  // ssh.github.com in any letter case. An ssh host alias names no host that the hook can read, so it gives undefined.
  // The user part has no ?, # or %: with them, "https://evil.example?@github.com/…" names the host evil.example (R1971-2).
  const m = /^(?:(?:https|ssh):\/\/(?:[^@\/\s?#%]+@)?(?:ssh\.)?github\.com(?::\d+)?\/|[^@\/\s:?#%]+@(?:ssh\.)?github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(url ?? "");
  return m && !/^\.+$/.test(m[1]) && !/^\.+$/.test(m[2]) ? `${m[1]}/${m[2]}` : undefined;
}
/** A path with a .git folder or file in it: git's own files (hooks, settings, refs). No file tool and no shell write changes them in sage mode. */
export const gitInternalPath = (path) => typeof path === "string" && /(?:^|[\\/])\.git(?:[\\/]|$)/i.test(path);
/** A .git folder or a path under one, also the bare word .git. */
const gitFile = (path) => gitInternalPath(path) || /^\.git$/i.test(path ?? "");

/** Shared push rules (T536). The provider supplies two readers, which return a program's output, or undefined when it
 * fails: readGit(dir, args) runs git in dir, and readGh(args) runs gh (with GH_HOST and GH_REPO cleared). The rules read
 * the checkout's branch, git's settings, refs/remotes/<remote>/HEAD and, from GitHub, the repository's default branch.
 * This module never executes a command or offers a first-upload exception. An unread branch keeps the push; unread
 * settings, or a default branch that GitHub does not give, refuse it.
 */
export function createPushPolicy({ stateToolPath, readGit, readGh, mainReason = "work reaches main only through a pull request. Push the task's branch and open a pull request." } = {}) {
  if (typeof readGit !== "function") throw new TypeError("readGit must be a function");
  if (typeof readGh !== "function") throw new TypeError("readGh must be a function");
  if (typeof mainReason !== "string" || !mainReason.trim() || mainReason.length > 2048 || /[\x00-\x1f\x7f]/.test(mainReason)) throw new TypeError("mainReason must be a bounded message without control characters");
  const { runnable, mergeIn } = createCommandPolicy({ stateToolPath });
  const PUSH_FORM = 'git [-C <dir>] push [-u] [--follow-tags] [-o <option>] <remote> <branch>, with the name of a remote of the checkout and the literal name of the task\'s branch: not the default branch, main or master, HEAD, @, a pattern, a variable, or a refspec with ":" or "+". Beside the push, a command line may only run cd, pwd, git add, commit, status, log, diff, show, fetch or rev-parse, gh, echo, printf, true, cat, head, tail, grep or wc; it sets no variable, no upstream (no --set-upstream, no fetch -u) and writes no file (no tee, no >). To delete a branch: git push --delete <remote> <branch>';
  /** The word git, and then a later word: one linear scan from the first git (T34, T100-N5). */
  const gitThen = (text, word) => new RegExp(`\\b${word}\\b`, "i").test(/\bgit\b([\s\S]*)/i.exec(text)?.[1] ?? "");
  const pushText = (text) => gitThen(text, "push");
  /** A command line without quotes, backslashes and line joins: the text that the rules test when the reader cannot read the line (fail closed). */
  const bare = (text) => text.replace(/\\\n/g, "").replace(/['"\\]/g, "");
  const refuse = (why) => `${why} Push only with ${PUSH_FORM}.`;
  const unreadableGitHub = (command) => /\bgh(?:\.exe)?\b/i.test(bare(command))
    ? mergeIn(command)?.problem ?? refuse("the hook cannot establish the GitHub API command's destination.") : undefined;
  /** described: the text is only a tool call's description, which runs nothing, so the git settings rule skips it (R1949-1). */
  function pushProblem(command, cwd, options = {}, { described = false } = {}) {
    let commands;
    try {
      commands = shellCommands(command);
    } catch (e) {
      return pushText(bare(command)) ? refuse(`the hook cannot read this command (${e.message}), so it refuses it. Close each quote, substitution and heredoc.`) : unreadableGitHub(command);
    }
    defaults.clear(); // read GitHub's default branch once for each command, never from an earlier command
    const state = described ? undefined : gitStateChange(command, commands, cwd);
    if (state) return state;
    let dir = cwd;
    /** The first command beside the push that the line may not run, or undefined. Read only for a line with a push. */
    const beside = () => commands.length < 2 ? undefined : commands.find((c) => !besidePush(c.words))?.words
      ?? (commandWrites(command, cwd) ? ["a file write"] : undefined);
    const pushWhy = (words, git, dir) => {
      const why = pushForm(words, git, dir);
      const other = why ? undefined : beside();
      return why ?? (other && besideReason(other));
    };
    for (const { cmd, words, bodies } of runnable(commands)) {
      if (cmd.words[0] === "cd" && cmd.words.length === 2) dir = resolve(dir, cmd.words[1]);
      const git = words.findIndex((w, k) => programName(w) === "git" && /^push$/i.test(gitSubcommand(words, k + 1)));
      const why = git >= 0 ? pushWhy(words, git, dir) : [...words, ...bodies].some((w) => /\s/.test(w) && pushText(w)) ? "this command gives push text to another program (a shell, eval or a script), so the hook cannot read the push." : undefined;
      if (why) return refuse(why);
    }
    try {
      // Preserve the raw push path above. Only launcher descendants add new push evidence here;
      // checking every git twice would read branches twice with different cd-failure semantics.
      const runs = programsRun(command, cwd, undefined, options);
      for (const run of runs) {
        if (run.powerShellLaunch && programName(run.word) === "git" && /^push$/i.test(gitSubcommand(run.args, 0))) {
          const why = pushWhy([run.word, ...run.args], 0, run.dir);
          if (why) return refuse(why);
        }
        const send = sendsOtherwise(run.word, run.args);
        if (send) return mergeIn(command)?.problem ?? (send.alone ? send.why : refuse(send));
        if (apiWritesMain([run.word, ...run.args], run.dir ?? cwd)) return mergeIn(command)?.problem ?? refuse(mainReason);
      }
      if (runs.some(run => run.word === "command") && [...externalCommandOperands(command, cwd, options)]
        .some(({ word, args }) => apiWritesMain([word, ...args], cwd))) return mergeIn(command)?.problem ?? refuse(mainReason);
    } catch (error) {
      if (error.code === "SAGE_POWERSHELL_LAUNCH") return refuse(error.message);
      return pushText(bare(command)) ? refuse("the hook cannot establish the push command") : unreadableGitHub(command);
    }
    return undefined;
  }

  /** Git's settings can change where a push goes (remote.<name>.push, push.default with branch.<name>.merge), and
   * another command of the same line can change them after the hook read them. So beside a push a line runs only
   * these commands, with no variable set before one, and writes no file. */
  const BESIDE_PROGRAMS = new Set(["cd", "pwd", "echo", "printf", "true", "gh", "cat", "head", "tail", "grep", "wc"]);
  const BESIDE_GIT = /^(?:add|commit|status|log|diff|show|fetch|push|rev-parse)$/;
  function besidePush(words) {
    const name = programName(words[0] ?? "");
    if (/^\w+=/.test(words[0] ?? "")) return false;
    if (name !== "git") return BESIDE_PROGRAMS.has(name);
    const sub = gitSubcommand(words, 1);
    // An upstream set beside a push (fetch --set-upstream, or fetch's -u) can change where the push goes (R1950-1).
    // Only fetch of the commands allowed here takes -u in that sense; add -u and the push's own -u stay allowed.
    const setsUpstream = sub !== "push" && words.some((w) => w.startsWith("--")
      ? longOption(w, ["--set-upstream", "--set-upstream-to", "--update-head-ok"])
      : sub === "fetch" && /^-[a-z]*u/i.test(w));
    return BESIDE_GIT.test(sub) && !setsUpstream && !words.some((w) => w === "-c" || /^--(?:git-dir|work-tree|config-env)/.test(w));
  }
  const besideReason = (words) => `"${words.join(" ").slice(0, 80)}" runs in the same command line as the push, and it can change where the push goes. Run the push as a command of its own.`;
  /**
   * Git's own files and the settings that run a program can send commits outside the hook's view: a git hook
   * (.git/hooks, core.hooksPath) runs on commit or push, and core.fsmonitor runs on status. So in sage mode a command
   * line never sets hooksPath or fsmonitor, and never writes a file under a .git folder. A text check, so not complete.
   */
  function gitStateChange(command, commands, cwd) {
    if (setsRunKey(commands)) return "a command that sets core.hooksPath or core.fsmonitor can make git run a program on a commit or a push, so sage mode refuses it. Ask the user.";
    const GIT_WRITE = "this command writes a file under a .git folder, where git keeps its hooks and settings, so sage mode refuses it. Ask the user.";
    if (commands.some((c) => gitOutputs(c.words))) return GIT_WRITE;
    if (!commandWrites(command, cwd)) return undefined;
    // The reader keeps each redirection as its operator and target in one string, such as ">.git/hooks/pre-push" or "2>&1".
    const target = (r) => /^[\w{}]*?(?:&>>?|>>|>\||>&|<>|>)(.*)$/.exec(r)?.[1];
    if (gitInternalPath(cwd) || commands.some((c) => c.redirects.some((r) => gitFile(target(r)))
      || (c.words.length > 1 && !READ_ONLY.has(programName(c.words[0] ?? "")) && c.words.slice(1).some(gitFile)))) return GIT_WRITE;
    return undefined;
  }
  /** Programs that only read their file arguments: a .git path among them is not a write target. git's own output options are read by gitOutputs. */
  const READ_ONLY = new Set(["ls", "cat", "head", "tail", "grep", "rg", "wc", "stat", "file", "diff", "less", "git", "echo", "printf"]);
  /** Does a git command write under .git through its own output option: checkout-index --prefix, diff --output, format-patch -o (R1971-2)? */
  function gitOutputs(words) {
    const g = words.findIndex((w) => programName(w) === "git");
    return g >= 0 && words.slice(g + 1).some((w, k, rest) => {
      const short = /^-o(.*)$/.exec(w);
      if (short) return gitFile(short[1] || rest[k + 1]);
      if (!w.startsWith("--") || !longOption(w, ["--prefix", "--output", "--output-directory"])) return false;
      return gitFile(w.includes("=") ? w.slice(w.indexOf("=") + 1) : rest[k + 1]);
    });
  }
  const RUN_KEY = /^\s*core\.(?:hookspath|fsmonitor)\s*$/i;
  /**
   * Does a command of the line set core.hooksPath or core.fsmonitor: a git config write, git -c or --config-env, or a
   * GIT_CONFIG_KEY_<n> or GIT_CONFIG_PARAMETERS variable? It reads the parsed words, so a commit message, an echo or a
   * grep pattern that names the key passes. Text that another program runs as a command (sh -c, a heredoc) is read
   * the same way, up to 3 levels deep; text that the reader cannot read is refused when it names a key (fail closed).
   */
  function setsRunKey(commands, depth = 0) {
    return runnable(commands).some(({ words, bodies }) => setsInWords(words)
      || [...words, ...bodies].some((t) => /\s/.test(t) && /hookspath|fsmonitor/i.test(t) && nestedSets(t, depth)));
  }
  function nestedSets(text, depth) {
    if (depth >= 3) return true;
    try {
      return setsRunKey(shellCommands(text), depth + 1);
    } catch {
      return true;
    }
  }
  function setsInWords(words) {
    const setting = (w) => /^\s*core\.(?:hookspath|fsmonitor)\s*(?:=|$)/i.test(w ?? "");
    if (words.some((w, k) => /^GIT_CONFIG_PARAMETERS=/i.test(w) && /hookspath|fsmonitor/i.test(w)
      || /^GIT_CONFIG_KEY_\d+=/i.test(w) && RUN_KEY.test(w.slice(w.indexOf("=") + 1))
      || /^(?:-c|--config-env)$/.test(words[k - 1] ?? "") && setting(w)
      || /^--config-env=/.test(w) && setting(w.slice(w.indexOf("=") + 1)))) return true;
    return configWrites(words);
  }
  /**
   * Is the command a git config write that names core.hooksPath or core.fsmonitor? git reads only with the get or
   * list subcommand right after config, or with --get, --get-all, --get-regexp, --get-urlmatch, --list or -l before
   * any "--". Every other form that names the key writes it, also when its value is the word get or list (R1971-1).
   */
  function configWrites(words) {
    const g = words.findIndex((w) => programName(w) === "git");
    if (g < 0) return false;
    let c = g + 1;
    while (words[c]?.startsWith("-")) c += GIT_VALUE.test(words[c]) ? 2 : 1;
    if (words[c]?.toLowerCase() !== "config") return false;
    const args = words.slice(c + 1);
    if (!args.some((w) => RUN_KEY.test(w))) return false;
    if (/^(?:get|list)$/.test(args[0] ?? "")) return false;
    const options = args.includes("--") ? args.slice(0, args.indexOf("--")) : args;
    return !options.some((w) => /^(?:--get(?:-all|-regexp|-urlmatch)?|--list|-l)$/.test(w));
  }
  /**
   * The git subcommands that the hook knows: git's built-ins and git lfs, without the ones that send commits or run a
   * command for each repository. A git alias or a git-<name> program can hide a push, so any other subcommand is refused.
   */
  const KNOWN_GIT = new Set(`add am annotate apply archive bisect blame branch bugreport bundle cat-file check-attr check-ignore
    check-mailmap check-ref-format checkout checkout-index cherry cherry-pick clean clone column commit commit-graph commit-tree
    config count-objects describe diagnose diff diff-files diff-index diff-tree difftool fast-export fetch for-each-ref
    format-patch fsck gc grep hash-object help init interpret-trailers lfs log ls-files ls-remote ls-tree maintenance merge
    merge-base merge-file merge-tree mergetool mktag mktree mv name-rev notes pack-refs patch-id prune pull push range-diff
    read-tree rebase reflog remote repack replace rerere reset restore rev-list rev-parse revert rm shortlog show show-branch
    show-ref sparse-checkout stash status submodule subtree switch symbolic-ref tag update-index update-ref var verify-commit
    verify-tag version whatchanged worktree write-tree backfill fast-import filter-branch index-pack multi-pack-index replay
    repo request-pull stripspace verify-pack`.split(/\s+/));
  /** Why a git or gh run sends commits or moves the default branch another way than the push form, or undefined. */
  function sendsOtherwise(word, args) {
    const name = programName(word);
    if (name === "git") {
      const sub = gitSubcommand(args, 0).toLowerCase();
      if (!sub) return undefined;
      // Not a push, so this refusal gives no push form (R1949-2).
      if (!KNOWN_GIT.has(sub)) return { alone: true, why: `"git ${sub}" is not a git command that the hook knows, and a git alias or a git-${sub} program can send commits to a remote, so sage mode refuses it. Use a git built-in, or ask the user to run it.` };
      if (sub === "subtree" && args.some((a) => /^push$/i.test(a))) return "git subtree push sends commits outside the push form.";
      return undefined;
    }
    if (name !== "gh") return undefined;
    const words = args.filter((a) => !a.startsWith("-"));
    if (words[0] === "repo" && words[1] === "sync") return { alone: true, why: "gh repo sync writes a branch on GitHub outside a pull request, so sage mode refuses it. Ask the user." };
    if (words[0] === "repo" && words[1] === "edit" && args.some((a) => /^--default-branch/.test(a))) return { alone: true, why: "gh repo edit --default-branch moves the default branch, and only the user does that." };
    return undefined;
  }
  /** git's output, or undefined when git fails. Any other value is a broken reader. */
  function gitOut(dir, args) {
    const out = readGit(dir, args);
    if (out !== undefined && typeof out !== "string") throw new TypeError("readGit must return git's output or undefined");
    return out;
  }
  /** The default branch of a GitHub repository (owner/name or repositories/<id> path), read from GitHub, or undefined. */
  const defaults = new Map();
  function gitHubDefault(path) {
    if (!defaults.has(path)) {
      const out = readGh(["api", "--hostname", "github.com", path, "--jq", ".default_branch"]);
      if (out !== undefined && typeof out !== "string") throw new TypeError("readGh must return gh's output or undefined");
      const name = out?.trim();
      defaults.set(path, name && !/[\s\x00-\x1f\x7f]/.test(name) ? name : undefined);
    }
    return defaults.get(path);
  }
  /** The GitHub repositories (owner/name) that the checkout's remotes name, by url or pushurl. */
  function remoteRepositories(dir) {
    const settings = gitOut(dir, ["config", "-z", "--list"]) ?? "";
    const urls = [...settings.matchAll(/(?:^|\0)remote\.[^\n]+\.(?:push)?url\n([^\0]*)/g)].map((m) => m[1]);
    return [...new Set(urls.map(gitHubRepository).filter(Boolean))];
  }
  /** The remote's default branch from refs/remotes/<remote>/HEAD, or undefined when git cannot read it. */
  function remoteHead(dir, remote) {
    const prefix = `refs/remotes/${remote}/`;
    const ref = gitOut(dir, ["symbolic-ref", "--quiet", `${prefix}HEAD`])?.trim() ?? "";
    return ref.startsWith(prefix) && ref.length > prefix.length ? ref.slice(prefix.length) : undefined;
  }
  /**
   * The default branch of a remote: GitHub's answer for each URL the push goes to (pushurl, else url). The local
   * refs/remotes/<remote>/HEAD only has to agree; it never decides alone, because a command can plant it.
   * Returns { name } or { why }.
   */
  function remoteDefault(dir, remote, values, settings) {
    if (/(?:^|\0)url\.[^\n]*\.(?:push)?insteadof\n/i.test(settings)) return { why: "a url.<base>.insteadOf setting can send this push to another repository, so the hook refuses it. Ask the user to remove it." };
    const urls = values(`remote.${remote}.pushurl`).length ? values(`remote.${remote}.pushurl`) : values(`remote.${remote}.url`);
    const repos = urls.map(gitHubRepository);
    if (!repos.length || repos.some((r) => !r)) return { why: `${remote} is not a GitHub repository URL that the hook can read (https://github.com/<owner>/<name>), so it cannot tell its default branch.` };
    const names = [...new Set(repos.map((r) => gitHubDefault(`repos/${r}`)))];
    if (names.some((n) => !n)) return { why: `the hook cannot read the default branch of ${repos.join(", ")} from GitHub (gh api), so it refuses the push. Check that gh is logged in.` };
    if (names.length > 1) return { why: `${remote} sends to repositories with different default branches (${names.join(", ")}).` };
    const head = remoteHead(dir, remote);
    if (head && head.toLowerCase() !== names[0].toLowerCase()) return { why: `refs/remotes/${remote}/HEAD names ${head}, but GitHub names ${names[0]} as the default branch. Run git remote set-head ${remote} --auto, then push again.` };
    return { name: names[0] };
  }
  /** A ref that git reads as main or master: main, heads/main, refs/heads/main. */
  const MAIN_REF = /^(?:refs\/)?(?:heads\/)?(?:main|master)$/i;
  /** A branch name with no expansion, pattern or special ref in it: not HEAD, @, a variable, a glob or a refspec. */
  const LITERAL = /^(?!-)(?!(?:.*\/)?HEAD$)[^$`*?[\]:+~^\\{}<>|&;!@'"()]+$/i;
  const PUSH_OPTIONS = /^(?:-u|--set-upstream|--follow-tags|-q|--quiet|--no-verify|--delete|-d|-o.*|--push-option=.*)$/;
  /** git accepts a long option by any unambiguous start of its name, such as --forc. */
  const longOption = (word, names) => {
    const name = word.split("=")[0];
    return name.length > 3 && names.some((n) => n.startsWith(name));
  };
  const FORCE = "sage mode never force-pushes. Push a new commit instead.";
  /** Why the git push at words[git] is not the push form, or undefined. dir is where the command runs. */
  function pushForm(words, git, dir) {
    let force = false;
    let main = false;
    let remove = false;
    let other = git > 0 ? `"${words.slice(0, git).join(" ")}" runs this push; the hook reads a push only as a command of its own.` : undefined;
    const names = [];
    let k = git + 1;
    for (; !/^push$/i.test(words[k]); k++) {
      if (words[k] === "-C") dir = resolve(dir, words[k + 1]);
      else other ??= `"${words[k]}" is not part of the push form.`;
      if (GIT_VALUE.test(words[k])) k++;
    }
    for (k++; k < words.length; k++) {
      let w = words[k];
      // A redirection, such as 2>&1, ">/dev/null" or "main>/dev/null": keep only the word before it.
      const r = w.search(/&?[<>]/);
      if (r >= 0) {
        if (w.length === r + /^&?[<>]+&?/.exec(w.slice(r))[0].length) k++; // its target is the next word
        w = /^\d*$/.test(w.slice(0, r)) ? "" : w.slice(0, r);
        if (!w) continue;
      }
      if (w.startsWith("--") ? longOption(w, ["--force", "--force-with-lease", "--force-if-includes"]) : /^-[^-o]*f/.test(w) || w.startsWith("+")) force = true;
      else if (longOption(w, ["--mirror", "--all", "--branches"]) || (!w.startsWith("-") && MAIN_REF.test(w.slice(w.indexOf(":") + 1)))) main = true;
      else if (w === "--delete" || w === "-d") remove = true;
      else if (w === "-o" || w === "--push-option") k++;
      else if (w.startsWith("-") ? !PUSH_OPTIONS.test(w) : names.length && !LITERAL.test(w)) other ??= `"${w}" is not part of the push form.`;
      if (!w.startsWith("-")) names.push(w);
    }
    if (force) return FORCE;
    if (main) return mainReason;
    if (other) return other;
    if (names.length < 2) return "name the remote and the branch: a push with no branch pushes what the checkout's settings say, which can be main.";
    const [remote, ...branches] = names;
    // git config -z --list: each setting is its key, a newline and its value, then a NUL. Section and key are in lower case.
    const settings = gitOut(dir, ["config", "-z", "--list"]);
    if (settings === undefined) return "the hook cannot read git's settings for this checkout, so it cannot tell where the push goes.";
    const values = (key) => settings.split("\0").filter((s) => s.startsWith(`${key}\n`)).map((s) => s.slice(key.length + 1));
    if (!/^[\w.-]+$/.test(remote) || !values(`remote.${remote}.url`).length) return `push to a remote of this checkout (git remote -v), not to "${remote}".`;
    if (/^(?:true|yes|on|1)$/i.test(values(`remote.${remote}.mirror`).at(-1) ?? "")) return `git's setting remote.${remote}.mirror makes every push a mirror push: ${mainReason}`;
    if (!remove && values(`remote.${remote}.push`).length) return `git's setting remote.${remote}.push can send the branch to another name, such as the default branch. Ask the user to remove that setting.`;
    const upstream = /^(?:upstream|tracking)$/i.test(values("push.default").at(-1) ?? "");
    const target = remoteDefault(dir, remote, values, settings);
    if (target.why) return target.why;
    const head = target.name.toLowerCase();
    for (const name of branches) {
      const to = name.replace(/^(?:refs\/)?(?:heads\/)?/i, "");
      if (to.toLowerCase() === head) return `${to} is the default branch of ${remote}: ${mainReason}`;
      if (remove) continue;
      // The source must be the plain branch of that name: a symbolic ref (refs/heads/x -> refs/heads/main) sends main.
      // A name that git cannot resolve fails the push itself ("src refspec does not match any").
      const full = gitOut(dir, ["rev-parse", "--symbolic-full-name", name])?.trim();
      if (full && full !== `refs/heads/${to}`) return `${name} is not a plain branch of this checkout (git reads it as ${full || "no branch"}), so the hook cannot tell what the push sends.`;
    }
    // With push.default upstream (or tracking), git sends a named branch to its upstream, and a command in the same line
    // (fetch --set-upstream) can set that upstream after the hook read it. So no push runs while it is set (R1950-1).
    if (!remove && upstream) return "git's setting push.default is upstream, so git can send the branch to its upstream, such as main. The hook refuses every push while it is set: ask the user to change it (git config --unset push.default).";
    if (remove) return undefined;
    const branch = gitOut(dir, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim();
    if (branch !== undefined && (!branch || /[\x00-\x20\x7f]/.test(branch))) throw new TypeError("readGit must return a branch name for rev-parse");
    return branch && (MAIN_REF.test(branch) || branch.toLowerCase() === head) ? `this checkout is on ${branch}. Push from the task's worktree, on the task's branch.` : undefined;
  }

  /** Read request options, not display options or unrelated text, as branch evidence. Never open a supplied body file. */
  function apiWritesMain(words, dir) {
    if (programName(words[0] ?? "") !== "gh") return false;
    let method;
    let endpoint;
    let api = false;
    let opaque = false;
    const fields = [];
    const args = words.slice(1);
    for (let k = 0; k < args.length; k++) {
      const word = args[k];
      // Cobra permits flag bundles such as -iX PATCH and -ifbranch=main. A value flag owns the rest.
      if (/^-[ih]./.test(word)) {
        args.splice(k, 1, word.slice(0, 2), `-${word.slice(2)}`);
        k--;
        continue;
      }
      if (word === "-X" || word === "--method") method = args[++k];
      else if (word.startsWith("--method=")) method = word.slice(9);
      else if (/^-X./.test(word)) method = word.slice(2).replace(/^=/, "");
      else if (/^(?:-[fF]|--(?:raw-)?field)$/.test(word)) fields.push({ value: args[++k] ?? "", typed: word === "-F" || word === "--field" });
      else if (/^(?:-[fF].|--(?:raw-)?field=)/.test(word)) fields.push({
        value: word.replace(/^(?:-[fF]=?|--(?:raw-)?field=)/, ""), typed: /^-F|^--field=/.test(word),
      });
      else if (word === "--input") { opaque = true; k++; }
      else if (word.startsWith("--input=")) opaque = true;
      else if (/^(?:--hostname|--cache|--header|-H|--jq|-q|--preview|-p|--template|-t)$/.test(word)) k++;
      else if (!word.startsWith("-")) {
        if (!api) { if (word !== "api") return false; api = true; }
        else endpoint ??= word;
      }
    }
    if (!api) return false;
    const writes = (method ?? (fields.length || opaque ? "POST" : "GET")).toUpperCase() !== "GET";
    // Only the two repository-name parts may contain known templates. Check before URL normalization.
    const literalEndpoint = (endpoint ?? "").replace(
      /^((?:https?:\/\/[^/?#{}]+\/)?\/?(?:api\/v3\/)?repos\/)([^/]+)\/([^/?#]+)/,
      (_, prefix, owner, repo) => prefix + [owner, repo].map(part => part.replace(/\{(?:owner|repo)\}|:(?:owner|repo)\b/g, "template")).join("/"),
    );
    if (writes && /[$`\\*\[\]{}]|:(?:owner|repo|branch)\b/.test(literalEndpoint)) return true;
    let path = (endpoint ?? "").split("#", 1)[0];
    let search = "";
    if (/^https?:\/\//i.test(path)) {
      try {
        const url = new URL(path);
        path = url.pathname;
        search = url.search;
      } catch { return true; }
    } else if (path.includes("?")) {
      const split = path.indexOf("?");
      search = path.slice(split);
      path = path.slice(0, split);
    }
    try { path = decodeURIComponent(path).replace(/^\//, ""); } catch { return true; }
    path = path.replace(/^api\/v3\//, "").replace(/^api\/graphql$/, "graphql");
    const hasBodyFields = fields.length > 0;
    for (const [key, value] of new URLSearchParams(search)) fields.push({ value: `${key}=${value}`, typed: false });
    const values = fields.map(({ value, typed }) => {
      const split = value.indexOf("=");
      return { key: value.slice(0, split), value: value.slice(split + 1),
        opaque: typed && /^(?:@)|\{(?:owner|repo|branch)\}|:(?:owner|repo|branch)\b/.test(value.slice(split + 1)) };
    });
    const bracketedFields = values.some(field => /[\[\]]/.test(field.key));
    // main, master and the default branch that GitHub names (T536): of the request's repository, or for GraphQL of each
    // GitHub remote of the checkout. Read only for a request that can write a branch; an unread default protects every name.
    const repoPath = /^(?:repos\/[^/]+\/[^/]+|repositories\/\d+)/.exec(path)?.[0];
    let names;
    const branchNames = () => {
      if (names !== undefined) return names;
      const found = repoPath ? [gitHubDefault(repoPath)] : remoteRepositories(dir).map((r) => gitHubDefault(`repos/${r}`));
      return (names = found.some((n) => !n) ? null : ["main", "master", ...found].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"));
    };
    const protectedName = (text) => branchNames() === null || new RegExp(`(?:^|[\\s/=:'"(])(?:refs\\/)?(?:heads\\/)?(?:${branchNames()})(?=$|[\\s/?&#:'"),}])`, "i").test(text);
    const protectedRef = (text) => branchNames() === null || new RegExp(`^(?:refs\\/)?(?:heads\\/)?(?:${branchNames()})$`, "i").test(text);
    // The repository's own settings: a write of default_branch moves the default branch (R1936 F8).
    if (writes && repoPath === path && (opaque || bracketedFields || values.some((field) => /default_branch/i.test(field.key)))) return true;
    if (path === "graphql") {
      if (opaque || bracketedFields || values.some(field => field.opaque)) return true;
      const query = values.filter(field => field.key === "query").map(field => field.value).join(" ");
      // The shell reader does not retain which quote protected a dollar sign. Require literal query text.
      if (/[$`]/.test(query)) return true;
      // GraphQL ignores comments and commas. Strings are data, so their words cannot select an operation.
      const operations = query.replace(/"""(?:\\[\s\S]|(?!""")[\s\S])*"""|"(?:\\[\s\S]|[^"\\])*"|#[^\r\n]*|,/g, " ");
      if (!/\bmutation\b/.test(operations)) return false;
      // Ref ids hide their branch name. A ref update or deletion must use the reviewed PR path.
      if (/\b(?:updateRefs?|deleteRef|updatePullRequestBranch)\s*\(/.test(operations)) return true;
      if (/\bcreateCommitOnBranch\s*\(/.test(operations) &&
        (/\bbranch\s*:\s*\{[^{}]*\bid\s*:/.test(operations) || !/\bbranchName\s*:\s*"[^"\\]+"/.test(query))) return true;
      return /\b(?:createCommitOnBranch|createRef|createLinkedBranch|mergeBranch)\s*\(/.test(operations) &&
        (/\\/.test(query) || values.some(field => protectedName(field.value) ||
          (field.key !== "query" && /[$`\\]/.test(field.value))));
    }
    if ((method ?? (hasBodyFields || opaque ? "POST" : "GET")).toUpperCase() === "GET") return false;
    // Without quote provenance a question mark can be a shell glob, not an API query separator.
    if (endpoint?.includes("?")) return true;
    // Owner and repository templates each name one path part. Branch templates can insert a whole route.
    const literalPath = path.replace(/^repos\/([^/]+)\/([^/]+)/, (prefix) => prefix.replace(/\{(?:owner|repo)\}|:(?:owner|repo)\b/g, "template"));
    if (/[$`\\*\[\]{}]|:(?:owner|repo|branch)\b/.test(literalPath)) return true;
    const route = /^(?:repos\/[^/]+\/[^/]+|repositories\/\d+)\/(git\/refs(?:\/.*)?|contents(?:\/.*)?|merges|merge-upstream|branches\/.*\/rename|pulls\/[^/]+\/update-branch)$/.exec(path)?.[1];
    if (!route) return false;
    if (bracketedFields) return true; // gh interprets bracketed keys as structured fields, including incomplete brackets.
    if (/^pulls\//.test(route)) return true; // The PR id does not prove which branch this request changes.
    if ((!route.startsWith("contents") && (protectedName(route) || !LITERAL.test(route))) || opaque) return true;
    const destinations = values.filter(field => /^(?:ref|branch|base|new_name)$/.test(field.key));
    if (destinations.some(field => field.opaque || !LITERAL.test(field.value) || protectedRef(field.value))) return true;
    // The contents API defaults an omitted branch to the repository's default branch, which may be main.
    return /^contents(?:\/|$)/.test(route) && !destinations.some(field => field.key === "branch");
  }

  return Object.freeze({ pushProblem });
}
