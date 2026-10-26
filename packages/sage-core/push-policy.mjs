import { resolve } from "node:path";
import { programsRun, shellCommands } from "./command-reader.mjs";
import { createCommandPolicy, externalCommandOperands, GIT_VALUE, gitSubcommand, programName } from "./command-policy.mjs";
import { BRANCH } from "./branch.mjs";
import { commandWrites } from "./shell-write-policy.mjs";

/** Shared push rules (T536). The provider supplies readGit(dir, args): git's output for those arguments in dir, or
 * undefined when git fails. The rules read three things with it: the checkout's branch, git's settings and the
 * remote's default branch (refs/remotes/<remote>/HEAD). This module never executes a command or offers a first-upload
 * exception. An unread branch keeps the push; unread settings refuse it; an unread default branch sends only a task's branch.
 */
export function createPushPolicy({ stateToolPath, readGit, mainReason = "work reaches main only through a pull request. Push the task's branch and open a pull request." } = {}) {
  if (typeof readGit !== "function") throw new TypeError("readGit must be a function");
  if (typeof mainReason !== "string" || !mainReason.trim() || mainReason.length > 2048 || /[\x00-\x1f\x7f]/.test(mainReason)) throw new TypeError("mainReason must be a bounded message without control characters");
  const { runnable, mergeIn } = createCommandPolicy({ stateToolPath });
  const PUSH_FORM = 'git [-C <dir>] push [-u] [--follow-tags] [-o <option>] <remote> <branch>, with the name of a remote of the checkout and the literal name of the task\'s branch: not the default branch, main or master, HEAD, @, a pattern, a variable, or a refspec with ":" or "+". Beside the push, a command line may only cd, run git add, commit, status, log, diff or fetch, run gh, or echo. To delete a branch: git push --delete <remote> <branch>';
  /** The word git, and then a later word: one linear scan from the first git (T34, T100-N5). */
  const gitThen = (text, word) => new RegExp(`\\b${word}\\b`, "i").test(/\bgit\b([\s\S]*)/i.exec(text)?.[1] ?? "");
  const pushText = (text) => gitThen(text, "push");
  /** A command line without quotes, backslashes and line joins: the text that the rules test when the reader cannot read the line (fail closed). */
  const bare = (text) => text.replace(/\\\n/g, "").replace(/['"\\]/g, "");
  const refuse = (why) => `${why} Push only with ${PUSH_FORM}.`;
  const unreadableGitHub = (command) => /\bgh(?:\.exe)?\b/i.test(bare(command))
    ? mergeIn(command)?.problem ?? refuse("the hook cannot establish the GitHub API command's destination.") : undefined;
  function pushProblem(command, cwd, options = {}) {
    let commands;
    try {
      commands = shellCommands(command);
    } catch (e) {
      return pushText(bare(command)) ? refuse(`the hook cannot read this command (${e.message}), so it refuses it. Close each quote, substitution and heredoc.`) : unreadableGitHub(command);
    }
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
          const why = pushForm([run.word, ...run.args], 0, run.dir);
          if (why) return refuse(why);
        }
        if (apiWritesMain([run.word, ...run.args])) return mergeIn(command)?.problem ?? refuse(mainReason);
      }
      if (runs.some(run => run.word === "command") && [...externalCommandOperands(command, cwd, options)]
        .some(({ word, args }) => apiWritesMain([word, ...args]))) return mergeIn(command)?.problem ?? refuse(mainReason);
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
    return BESIDE_GIT.test(gitSubcommand(words, 1)) && !words.some((w) => w === "-c" || /^--(?:git-dir|work-tree|config-env)/.test(w));
  }
  const besideReason = (words) => `"${words.join(" ").slice(0, 80)}" runs in the same command line as the push, and it can change where the push goes. Run the push as a command of its own.`;
  /** A task's branch: [<prefix>/]t<n>[-<words>], as the state tool reads a branch of a task. */
  const taskBranch = (name) => BRANCH.test(name) && /^(?:[A-Za-z0-9_-]+\/)?t\d+(?:-[A-Za-z0-9._-]+)?$/i.test(name);
  /** git's output, or undefined when git fails. Any other value is a broken reader. */
  function gitOut(dir, args) {
    const out = readGit(dir, args);
    if (out !== undefined && typeof out !== "string") throw new TypeError("readGit must return git's output or undefined");
    return out;
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
    if (!remove && values(`remote.${remote}.push`).length) return `git's setting remote.${remote}.push can send the branch to another name, such as the default branch. Ask the user to remove that setting.`;
    const upstream = /^(?:upstream|tracking)$/i.test(values("push.default").at(-1) ?? "");
    const prefix = `refs/remotes/${remote}/`;
    const ref = gitOut(dir, ["symbolic-ref", "--quiet", `${prefix}HEAD`])?.trim() ?? "";
    const head = ref.startsWith(prefix) && ref.length > prefix.length ? ref.slice(prefix.length) : undefined;
    for (const name of branches) {
      const to = name.replace(/^(?:refs\/)?(?:heads\/)?/i, "");
      const merge = values(`branch.${name}.merge`);
      if (!remove && upstream && merge.length && (merge.length > 1 || merge[0] !== `refs/heads/${to}`)) return `git's setting push.default is upstream, so this push goes to ${merge.join(", ")}, the upstream of ${name}. Push a branch with no other upstream.`;
      if (head && to.toLowerCase() === head.toLowerCase()) return `${to} is the default branch of ${remote}: ${mainReason}`;
      if (!head && !taskBranch(to)) return `the hook cannot read the default branch of ${remote} (${prefix}HEAD), so it sends only a task's branch, such as sage/t12-name.`;
    }
    if (remove) return undefined;
    const branch = gitOut(dir, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim();
    if (branch !== undefined && (!branch || /[\x00-\x20\x7f]/.test(branch))) throw new TypeError("readGit must return a branch name for rev-parse");
    return branch && (MAIN_REF.test(branch) || branch.toLowerCase() === head?.toLowerCase()) ? `this checkout is on ${branch}. Push from the task's worktree, on the task's branch.` : undefined;
  }

  /** Read request options, not display options or unrelated text, as branch evidence. Never open a supplied body file. */
  function apiWritesMain(words) {
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
    const protectedName = (text) => /(?:^|[\s/=:'"(])(?:refs\/)?(?:heads\/)?(?:main|master)(?=$|[\s/?&#:'"),}])/i.test(text);
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
    if (destinations.some(field => field.opaque || !LITERAL.test(field.value) || MAIN_REF.test(field.value))) return true;
    // The contents API defaults an omitted branch to the repository's default branch, which may be main.
    return /^contents(?:\/|$)/.test(route) && !destinations.some(field => field.key === "branch");
  }

  return Object.freeze({ pushProblem });
}
