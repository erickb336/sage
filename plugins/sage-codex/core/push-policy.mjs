import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { programsRun } from "./command-reader.mjs";
import { GIT_VALUE, gitSubcommand, programName, unreadable } from "./command-policy.mjs";

/** The owner/name of a GitHub repository URL as git writes it (https, ssh or scp form), or undefined for any other URL. */
export function gitHubRepository(url) {
  // https or ssh with an optional user (and port), or the scp form user@host:owner/name; the host is github.com or
  // ssh.github.com in any letter case. An ssh host alias names no host that the hook can read, so it gives undefined.
  // The user part has no ?, # or %: with them, "https://evil.example?@github.com/…" names the host evil.example (R1971-2).
  const m = /^(?:(?:https|ssh):\/\/(?:[^@\/\s?#%]+@)?(?:ssh\.)?github\.com(?::\d+)?\/|[^@\/\s:?#%]+@(?:ssh\.)?github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(url ?? "");
  return m && !/^\.+$/.test(m[1]) && !/^\.+$/.test(m[2]) ? `${m[1]}/${m[2]}` : undefined;
}

/** git's output for args in the checkout at dir, or undefined when git fails. GIT_DIR and GIT_WORK_TREE never change the checkout. */
export function readGit(dir, args) {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } });
  } catch {
    return undefined;
  }
}
/** gh's output for args (a GET of GitHub's API), or undefined when gh fails. GH_HOST and GH_REPO never change its target. */
export function readGh(args) {
  try {
    return execFileSync("gh", args, { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GH_HOST: undefined, GH_REPO: undefined } });
  } catch {
    return undefined;
  }
}

/** Shared push rules (T536). Two readers return a program's output, or undefined when it fails: readGit(dir, args) runs
 * git in dir, and readGh(args) runs gh (with GH_HOST and GH_REPO cleared). Both providers use the defaults above; a test
 * may give its own. The rules read the checkout's branch, its remotes and, from GitHub, the repository's default branch.
 * The rules themselves never run the command that they judge, and offer no first-upload exception. An unread branch
 * keeps the push; unread settings, or a default branch that GitHub does not give, refuse it. They guard the common
 * forms: a git setting that redirects a push (remote.<name>.push, url.<base>.insteadOf, push.default upstream), a
 * wrapper that the reader does not know and a push from code are limits of the hook (docs/design/rules-in-code.md).
 */
export function createPushPolicy({ readGit: gitReader = readGit, readGh: ghReader = readGh, mainReason = "work reaches main only through a pull request. Push the task's branch and open a pull request.", moveNote = "" } = {}) {
  if (typeof gitReader !== "function") throw new TypeError("readGit must be a function");
  if (typeof ghReader !== "function") throw new TypeError("readGh must be a function");
  if (typeof mainReason !== "string" || !mainReason.trim() || mainReason.length > 2048 || /[\x00-\x1f\x7f]/.test(mainReason)) throw new TypeError("mainReason must be a bounded message without control characters");
  const PUSH_FORM = 'git [-C <dir>] push [-u] [--follow-tags] [-o <option>] <remote> <branch>, with the name of a remote of the checkout and the literal name of the task\'s branch: not the default branch, main or master, HEAD, @, a pattern, a variable, or a refspec with ":" or "+". To delete a branch: git push --delete <remote> <branch>';
  /** The word git, and then a later word: one linear scan from the first git (T34, T100-N5). */
  const pushText = (text) => /\bpush\b/i.test(/\bgit\b([\s\S]*)/i.exec(text)?.[1] ?? "");
  /** A command line without quotes, backslashes and line joins: the text that the rules test when the reader cannot read the line (fail closed). */
  const bare = (text) => text.replace(/\\\n/g, "").replace(/['"\\]/g, "");
  const refuse = (why) => `${why} Push only with ${PUSH_FORM}.`;
  /**
   * Why a command line's push, or another way to send commits, is refused, or undefined. Each git push that the reader
   * finds, at any depth that it sees, must be the push form. The caller gives only the text of a field that runs, never a
   * description (T386). owner(dir, branch): why the session's chief does not push that branch of the checkout at dir,
   * or "" (T822). A push in the push form that it bars is refused with its words alone; a throw refuses the push too. A
   * line that the reader cannot read is refused when its text names a push.
   */
  function pushProblem(command, cwd, { owner } = {}) {
    let runs;
    try {
      runs = programsRun(command, cwd);
    } catch (e) {
      return pushText(bare(command)) ? refuse(unreadable(e, "a push")) : undefined;
    }
    defaults.clear(); // read GitHub's default branch once for each command, never from an earlier command
    for (const run of runs) {
      if (programName(run.word) === "git" && /^push$/i.test(gitSubcommand(run.args, 0))) {
        const form = pushForm(run.args, run.dir ?? cwd);
        if (typeof form === "string") return refuse(form);
        const bar = ownerWhy(form, owner);
        if (bar) return bar;
      }
      const send = sendsOtherwise(run.word, run.args);
      if (send) return send.alone ? send.why : refuse(send);
    }
    return undefined;
  }
  /** The owner's bar of the first branch that the push sends (or deletes) from the checkout at dir. */
  function ownerWhy({ dir, branches }, owner) {
    if (!owner) return undefined;
    for (const name of branches) {
      let bar;
      try {
        bar = owner(dir, name);
      } catch (e) {
        bar = `the hook cannot tell which chief owns ${name} (${e?.message ?? e}), so it refuses the push.`;
      }
      if (bar) return bar;
    }
    return undefined;
  }
  /** Why a git or gh run sends commits or moves the default branch another way than the push form, or undefined. */
  function sendsOtherwise(word, args) {
    const name = programName(word);
    if (name === "git") return gitSubcommand(args, 0).toLowerCase() === "subtree" && args.some((a) => /^push$/i.test(a)) ? "git subtree push sends commits outside the push form." : undefined;
    if (name !== "gh") return undefined;
    const words = args.filter((a) => !a.startsWith("-"));
    if (words[0] === "repo" && words[1] === "sync") return { alone: true, why: "gh repo sync writes a branch on GitHub outside a pull request, so sage mode refuses it. Ask the user." };
    if (words[0] === "repo" && words[1] === "edit" && args.some((a) => /^--default-branch/.test(a))) return { alone: true, why: `gh repo edit --default-branch moves the default branch, and only the user does that.${moveNote}` };
    return undefined;
  }
  /** git's output, or undefined when git fails. Any other value is a broken reader. */
  function gitOut(dir, args) {
    const out = gitReader(dir, args);
    if (out !== undefined && typeof out !== "string") throw new TypeError("readGit must return git's output or undefined");
    return out;
  }
  /** The default branch of a GitHub repository (owner/name), read from GitHub, or undefined. */
  const defaults = new Map();
  function gitHubDefault(path) {
    if (!defaults.has(path)) {
      const out = ghReader(["api", "--hostname", "github.com", path, "--jq", ".default_branch"]);
      if (out !== undefined && typeof out !== "string") throw new TypeError("readGh must return gh's output or undefined");
      const name = out?.trim();
      defaults.set(path, name && !/[\s\x00-\x1f\x7f]/.test(name) ? name : undefined);
    }
    return defaults.get(path);
  }
  /** The default branch of a remote: GitHub's answer for each URL the push goes to (pushurl, else url). Returns { name } or { why }. */
  function remoteDefault(remote, values) {
    const urls = values(`remote.${remote}.pushurl`).length ? values(`remote.${remote}.pushurl`) : values(`remote.${remote}.url`);
    const repos = urls.map(gitHubRepository);
    if (!repos.length || repos.some((r) => !r)) return { why: `${remote} is not a GitHub repository URL that the hook can read (https://github.com/<owner>/<name>), so it cannot tell its default branch.` };
    const names = [...new Set(repos.map((r) => gitHubDefault(`repos/${r}`)))];
    if (names.some((n) => !n)) return { why: `the hook cannot read the default branch of ${repos.join(", ")} from GitHub (gh api), so it refuses the push. Check that gh is logged in.` };
    if (names.length > 1) return { why: `${remote} sends to repositories with different default branches (${names.join(", ")}).` };
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
  /** Why a git push (git's words after the program) is not the push form, or else the checkout (dir) and the branches that it sends. dir is where the command runs. */
  function pushForm(words, dir) {
    let force = false;
    let main = false;
    let remove = false;
    let other;
    const names = [];
    let k = 0;
    for (; !/^push$/i.test(words[k]); k++) {
      if (words[k] === "-C") dir = resolve(dir, words[k + 1]);
      else other ??= `"${words[k]}" is not part of the push form.`;
      if (GIT_VALUE.test(words[k])) k++;
    }
    for (k++; k < words.length; k++) {
      const w = words[k];
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
    const target = remoteDefault(remote, values);
    if (target.why) return target.why;
    const head = target.name.toLowerCase();
    const sent = { dir, branches: branches.map((name) => name.replace(/^(?:refs\/)?(?:heads\/)?/i, "")) };
    const onDefault = sent.branches.find((to) => to.toLowerCase() === head);
    if (onDefault) return `${onDefault} is the default branch of ${remote}: ${mainReason}`;
    if (remove) return sent;
    const branch = gitOut(dir, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim();
    if (branch !== undefined && (!branch || /[\x00-\x20\x7f]/.test(branch))) throw new TypeError("readGit must return a branch name for rev-parse");
    return branch && (MAIN_REF.test(branch) || branch.toLowerCase() === head) ? `this checkout is on ${branch}. Push from the task's worktree, on the task's branch.` : sent;
  }

  return Object.freeze({ pushProblem });
}
