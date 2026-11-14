import { execFileSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { programsRun } from "./command-reader.mjs";
import { GIT_VALUE, gitSubcommand, programName, unreadable } from "./command-policy.mjs";

export function gitHubRepository(url) {
  const m = /^(?:(?:https|ssh):\/\/(?:[^@\/\s?#%]+@)?(?:ssh\.)?github\.com(?::\d+)?\/|[^@\/\s:?#%]+@(?:ssh\.)?github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(url ?? "");
  return m && !/^\.+$/.test(m[1]) && !/^\.+$/.test(m[2]) ? `${m[1]}/${m[2]}` : undefined;
}

export function readGit(dir, args) {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } });
  } catch {
    return undefined;
  }
}
export function readGh(args) {
  try {
    return execFileSync("gh", args, { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GH_HOST: undefined, GH_REPO: undefined } });
  } catch {
    return undefined;
  }
}

export function createPushPolicy({ readGit: gitReader = readGit, readGh: ghReader = readGh, mainReason = "work reaches main only through a pull request. Push the task's branch and open a pull request.", moveNote = "" } = {}) {
  if (typeof gitReader !== "function") throw new TypeError("readGit must be a function");
  if (typeof ghReader !== "function") throw new TypeError("readGh must be a function");
  if (typeof mainReason !== "string" || !mainReason.trim() || mainReason.length > 2048 || /[\x00-\x1f\x7f]/.test(mainReason)) throw new TypeError("mainReason must be a bounded message without control characters");
  const PUSH_FORM = 'git [-C <dir>] push [-u] [--follow-tags] [-o <option>] <remote> <branch>, with the name of a remote of the checkout and the literal name of the task\'s branch: not the default branch, main or master, HEAD, @, a pattern, a variable, or a refspec with ":" or "+". To delete a branch: git push --delete <remote> <branch>';
  const pushText = (text) => /\bpush\b/i.test(/\bgit\b([\s\S]*)/i.exec(text)?.[1] ?? "");
  const bare = (text) => text.replace(/\\\n/g, "").replace(/['"\\]/g, "");
  const refuse = (why) => `${why} Push only with ${PUSH_FORM}.`;
  function pushProblem(command, cwd, { owner } = {}) {
    let programs;
    try {
      ({ programs } = programsRun(command, cwd, undefined, { contextEvidence: true }));
    } catch (e) {
      return pushText(bare(command)) ? refuse(unreadable(e, "a push")) : undefined;
    }
    defaults.clear();
    for (const { run, wrapper, uncertainDirectory } of programs) {
      if (wrapper) continue;
      if (programName(run.word) === "git" && /^push$/i.test(gitSubcommand(run.args, 0))) {
        const form = pushForm(run.args, uncertainDirectory ? undefined : run.dir ?? cwd);
        if (typeof form === "string") return refuse(form);
        const bar = ownerWhy(form, owner);
        if (bar) return bar;
      }
      const send = sendsOtherwise(run.word, run.args);
      if (send) return send.alone ? send.why : refuse(send);
    }
    return undefined;
  }
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
  function sendsOtherwise(word, args) {
    const name = programName(word);
    if (name === "git") return gitSubcommand(args, 0).toLowerCase() === "subtree" && args.some((a) => /^push$/i.test(a)) ? "git subtree push sends commits outside the push form." : undefined;
    if (name !== "gh") return undefined;
    const words = args.filter((a) => !a.startsWith("-"));
    if (words[0] === "repo" && words[1] === "sync") return { alone: true, why: "gh repo sync writes a branch on GitHub outside a pull request, so sage mode refuses it. Ask the user." };
    if (words[0] === "repo" && words[1] === "edit" && args.some((a) => /^--default-branch/.test(a))) return { alone: true, why: `gh repo edit --default-branch moves the default branch, and only the user does that.${moveNote}` };
    return undefined;
  }
  function gitOut(dir, args) {
    const out = gitReader(dir, args);
    if (out !== undefined && typeof out !== "string") throw new TypeError("readGit must return git's output or undefined");
    return out;
  }
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
  function remoteDefault(remote, values) {
    const urls = values(`remote.${remote}.pushurl`).length ? values(`remote.${remote}.pushurl`) : values(`remote.${remote}.url`);
    const repos = urls.map(gitHubRepository);
    if (!repos.length || repos.some((r) => !r)) return { why: `${remote} is not a GitHub repository URL that the hook can read (https://github.com/<owner>/<name>), so it cannot tell its default branch.` };
    const names = [...new Set(repos.map((r) => gitHubDefault(`repos/${r}`)))];
    if (names.some((n) => !n)) return { why: `the hook cannot read the default branch of ${repos.join(", ")} from GitHub (gh api), so it refuses the push. Check that gh is logged in.` };
    if (names.length > 1) return { why: `${remote} sends to repositories with different default branches (${names.join(", ")}).` };
    return { name: names[0] };
  }
  const MAIN_REF = /^(?:refs\/)?(?:heads\/)?(?:main|master)$/i;
  const LITERAL = /^(?!-)(?!(?:.*\/)?HEAD$)[^$`*?[\]:+~^\\{}<>|&;!@'"()]+$/i;
  const PUSH_OPTIONS = /^(?:-u|--set-upstream|--follow-tags|-q|--quiet|--no-verify|--delete|-d|-n|--dry-run|-o.*|--push-option=.*)$/;
  const longOption = (word, names) => {
    const name = word.split("=")[0];
    return name.length > 3 && names.some((n) => n.startsWith(name));
  };
  const FORCE = "sage mode never force-pushes. Push a new commit instead.";
  function pushForm(words, dir) {
    let force = false;
    let main = false;
    let remove = false;
    let other;
    const names = [];
    let k = 0;
    for (; !/^push$/i.test(words[k]); k++) {
      if (words[k] === "-C") dir = dir === undefined && !isAbsolute(words[k + 1] ?? "") ? undefined : resolve(dir ?? "/", words[k + 1]);
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
    if (dir === undefined) return "the hook cannot tell which checkout this push runs in, after a cd that it cannot follow (cd $X, cd -). Name the checkout with git -C <dir>.";
    const [remote, ...branches] = names;
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

export function pushedBranches(command, cwd) {
  if (typeof command !== "string" || !/\bpush\b/i.test(command)) return [];
  let programs;
  try { ({ programs } = programsRun(command, cwd, undefined, { contextEvidence: true })); } catch { return []; }
  const sent = [];
  for (const { run, wrapper, uncertainDirectory } of programs) {
    if (wrapper || uncertainDirectory || programName(run.word) !== "git" || !/^push$/i.test(gitSubcommand(run.args, 0))) continue;
    const words = run.args, names = [];
    let dir = run.dir ?? cwd, k = 0, remove = false;
    for (; !/^push$/i.test(words[k]); k += GIT_VALUE.test(words[k]) ? 2 : 1) if (words[k] === "-C") dir = resolve(dir, words[k + 1]);
    for (k++; k < words.length; k++) {
      if (words[k] === "-o" || words[k] === "--push-option") k++;
      else if (words[k] === "--delete" || words[k] === "-d") remove = true;
      else if (!words[k].startsWith("-")) names.push(words[k]);
    }
    if (!remove && typeof dir === "string" && isAbsolute(dir)) for (const name of names.slice(1)) sent.push({ dir, branch: name.slice(name.indexOf(":") + 1).replace(/^(?:refs\/)?(?:heads\/)?/i, "") });
  }
  return sent;
}
