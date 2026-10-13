import { resolve } from "node:path";
import { programsRun, shellCommands } from "./command-reader.mjs";
import { createCommandPolicy, GIT_VALUE, gitSubcommand, programName } from "./command-policy.mjs";

/** Shared push rules. The provider supplies a synchronous reader of the checkout's current branch.
 * This module never executes a command or offers a first-upload exception.
 * Undefined branch evidence retains the existing Claude behavior; a stricter reader can throw.
 */
export function createPushPolicy({ stateToolPath, readBranch, mainReason = "work reaches main only through a pull request. Push the task's branch and open a pull request." } = {}) {
  if (typeof readBranch !== "function") throw new TypeError("readBranch must be a function");
  if (typeof mainReason !== "string" || !mainReason.trim() || mainReason.length > 2048 || /[\x00-\x1f\x7f]/.test(mainReason)) throw new TypeError("mainReason must be a bounded message without control characters");
  const { runnable, mergeIn } = createCommandPolicy({ stateToolPath });
  const PUSH_FORM = 'git [-C <dir>] push [-u] [--follow-tags] [-o <option>] origin <branch>, as a command of its own, with the literal name of the task\'s branch: not main or master, HEAD, @, a pattern, a variable, or a refspec with ":" or "+". To delete a branch: git push --delete origin <branch>';
  /** The word git, and then a later word: one linear scan from the first git (T34, T100-N5). */
  const gitThen = (text, word) => new RegExp(`\\b${word}\\b`, "i").test(/\bgit\b([\s\S]*)/i.exec(text)?.[1] ?? "");
  const pushText = (text) => gitThen(text, "push");
  /** A command line without quotes, backslashes and line joins: the text that the rules test when the reader cannot read the line (fail closed). */
  const bare = (text) => text.replace(/\\\n/g, "").replace(/['"\\]/g, "");
  const refuse = (why) => `${why} Push only with ${PUSH_FORM}.`;
  const unreadableGitHub = (command) => /\bgh(?:\.exe)?\b/i.test(bare(command))
    ? mergeIn(command)?.problem ?? refuse("the hook cannot establish the GitHub API command's destination.") : undefined;
  function pushProblem(command, cwd) {
    let commands;
    try {
      commands = shellCommands(command);
    } catch (e) {
      return pushText(bare(command)) ? refuse(`the hook cannot read this command (${e.message}), so it refuses it. Close each quote, substitution and heredoc.`) : unreadableGitHub(command);
    }
    let dir = cwd;
    for (const { cmd, words, bodies } of runnable(commands)) {
      if (cmd.words[0] === "cd" && cmd.words.length === 2) dir = resolve(dir, cmd.words[1]);
      const git = words.findIndex((w, k) => programName(w) === "git" && /^push$/i.test(gitSubcommand(words, k + 1)));
      const why = git >= 0 ? pushForm(words, git, dir) : [...words, ...bodies].some((w) => /\s/.test(w) && pushText(w)) ? "this command gives push text to another program (a shell, eval or a script), so the hook cannot read the push." : undefined;
      if (why) return refuse(why);
    }
    try {
      // Use the shared reader for wrappers, their option values, and nested command text.
      for (const run of programsRun(command, cwd)) {
        if (apiWritesMain([run.word, ...run.args])) return mergeIn(command)?.problem ?? refuse(mainReason);
      }
    } catch {
      return unreadableGitHub(command);
    }
    return undefined;
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
    if (names[0] !== "origin") return `push to origin, not to "${names[0]}".`;
    if (remove) return undefined;
    const branch = readBranch(dir);
    if (branch !== undefined && (typeof branch !== "string" || !branch || /[\x00-\x20\x7f]/.test(branch))) throw new TypeError("readBranch must return a branch name or undefined");
    return branch && MAIN_REF.test(branch) ? `this checkout is on ${branch}. Push from the task's worktree, on the task's branch.` : undefined;
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
