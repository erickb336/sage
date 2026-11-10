// The worktrees command of the state tool (T927): it lists the git worktrees of a project's repository with the task of
// each, and it removes only the clean ones of a merged or abandoned task, or of a branch that is in origin/main. The idea
// comes from pstack's worktree audit playbook (worktree-audit.sh: audit, then prune only what is merged and clean).
// The listing reads the local git data and the logbook only: it does not fetch. The prune runs git worktree remove with
// no --force, so git also refuses a worktree with changes, and it deletes no branch.
import { realpathSync } from "node:fs";
import { sep } from "node:path";

/** The tasks that are over: a worktree of another task is open, and the prune keeps it. */
const OVER = ["merged", "abandoned"];
/** The reasons of a row: the ones that the prune may remove come first. */
const REASONS = ["merged", "abandoned", "branch merged", "open", "unknown"];
const REMOVABLE = REASONS.slice(0, 3);
const real = (path) => { try { return realpathSync(path); } catch { return path; } };
const short = (sha) => String(sha ?? "").slice(0, 7);

/** git worktree list --porcelain -z as records: { path, head, branch, detached, bare, locked, gone }. The first is the primary checkout. */
function listed(git, root) {
  const records = [];
  let at;
  for (const line of git(["-C", root, "worktree", "list", "--porcelain", "-z"]).split("\0")) {
    if (!line) { at = undefined; continue; }
    const [key, ...rest] = line.split(" "), value = rest.join(" ");
    if (key === "worktree") records.push(at = { path: value });
    else if (!at) continue;
    else if (key === "HEAD") at.head = value;
    else if (key === "branch") at.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "detached" || key === "bare") at[key] = true;
    else if (key === "locked") at.locked = true;
    else if (key === "prunable") at.gone = true;
  }
  return records;
}

/** The commit of a ref, or undefined when the repository has no such ref. */
const commitOf = (git, root, ref) => { try { return git(["-C", root, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim(); } catch { return undefined; } };
/** Is the commit in origin/main? */
const inMain = (git, root, sha, main) => { try { git(["-C", root, "merge-base", "--is-ancestor", sha, main]); return true; } catch { return false; } };
/** The top folder of the worktree that holds a folder, as a real path, or undefined outside a repository. */
const topOf = (git, path) => { try { return real(git(["-C", path, "rev-parse", "--show-toplevel"]).trim()); } catch { return undefined; } };
const lower = (s) => String(s ?? "").toLowerCase();

/**
 * One row for each worktree: its task and reason. A worktree matches a task only through the logbook: the branch of the
 * task's row in tasks.tsv, or the branch of a run of the task in runs.tsv (a number in a branch's name is no match,
 * because older branches carry another logbook's numbers). A detached worktree has no branch, so its reason is unknown.
 */
function rows({ git, root, tasks, runs, main }) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return listed(git, root).map((w, k) => {
    const name = lower(w.branch);
    const ids = !w.branch ? [] : [...new Set([...tasks.filter((t) => lower(t.branch) === name).map((t) => t.id), ...runs.filter((r) => lower(r.branch) === name).map((r) => r.task)])].filter((id) => byId.has(id));
    const matched = ids.map((id) => byId.get(id)), open = matched.filter((t) => !OVER.includes(t.state));
    const shown = open.length ? open : matched;
    const reason = matched.length
      ? (open.length ? "open" : matched.some((t) => t.state === "merged") ? "merged" : "abandoned")
      : w.branch && main && w.head && inMain(git, root, w.head, main) ? "branch merged" : "unknown";
    return { ...w, primary: k === 0, tasks: shown, reason };
  });
}

const branchText = (w) => (w.bare ? "bare" : w.branch ?? `detached ${short(w.head)}`);
const line = (w, note) => [w.path, branchText(w), w.tasks.map((t) => t.id).join(",") || "-", w.tasks.map((t) => t.state).join(",") || "-", w.reason].join(" · ") + (note ? ` · ${note}` : "");

/**
 * Why the prune keeps a worktree before it looks inside it, or "". git worktree remove deletes ignored files, so it would
 * also delete another worktree in an ignored folder of this one: such a worktree stays.
 */
function kept(w, here, all) {
  if (w.primary || w.bare) return "the primary checkout";
  if (here.includes(real(w.path))) return "the worktree that this command runs in";
  if (w.locked) return "locked";
  const inner = all.find((o) => o !== w && real(o.path).startsWith(real(w.path) + sep));
  if (inner) return `another worktree is inside it: ${inner.path}`;
  if (REMOVABLE.includes(w.reason)) return "";
  if (w.tasks.length) return `${w.reason}: ${w.tasks.map((t) => `${t.id} is ${t.state}`).join(", ")}`;
  return `${w.reason}: ${w.branch ? "no task of the logbook names its branch, and the branch is not in origin/main" : "it has no branch, so no task matches it"}`;
}

/**
 * Why a clean-looking worktree must stay: uncommitted changes, untracked files or unpushed commits, or "". A commit is
 * pushed when a remote-tracking ref holds it, or when it is a reviewed head of the worktree's task (a verdict SHA of the
 * task in the ledger) or an ancestor of one: a squash merge leaves the task's commits out of origin/main, and
 * gh pr merge --delete-branch deletes its remote branch.
 */
function changed(git, root, w, ledger) {
  const status = git(["-C", w.path, "status", "--porcelain", "-z", "--untracked-files=all"]).split("\0").filter(Boolean);
  const untracked = status.filter((s) => s.startsWith("?? ")).length, edits = status.length - untracked;
  const why = [edits && "uncommitted changes", untracked && "untracked files"].filter(Boolean);
  if (why.length) return why.join(" and ");
  const ids = w.tasks.map((t) => t.id), reviewed = [...new Set(ledger.filter((l) => ids.includes(l.task) && /^[0-9a-f]{40}$/i.test(l.sha ?? "")).map((l) => l.sha))];
  const ahead = Number(git(["-C", root, "rev-list", "--count", "--ignore-missing", w.head, "--not", "--remotes", ...reviewed]).trim());
  return ahead ? `${ahead} unpushed commit${ahead === 1 ? "" : "s"}` : "";
}

/**
 * The worktrees command. root is the project's main checkout; here holds the folders that this command runs for (the
 * current folder and the project), whose worktrees the prune keeps. git runs one git command and throws on a failure.
 */
export function worktrees({ git, root, tasks, runs, ledger, here, prune = false }) {
  const main = commitOf(git, root, "refs/remotes/origin/main");
  const head = main ? `origin/main is ${short(main)} (${git(["-C", root, "log", "-1", "--format=%cs", main]).trim()}), the local copy: this command does not fetch.` : "This repository has no origin/main, so no branch reads as merged.";
  const all = rows({ git, root, tasks, runs, main });
  const homes = here.map((p) => topOf(git, p)).filter(Boolean);
  if (!prune) {
    const count = (r) => all.filter((w) => w.reason === r).length;
    const can = all.filter((w) => !w.gone && !kept(w, homes, all)).length;
    const notes = (w) => [w.primary && "primary checkout", homes.includes(real(w.path)) && !w.primary && "this worktree", w.locked && "locked", w.gone && "folder gone"].filter(Boolean).join(", ");
    return [head, ...all.map((w) => line(w, notes(w))),
      `${all.length} worktrees: ${REASONS.map((r) => `${count(r)} ${r}`).join(", ")}. ${can} can go when clean, and ${all.filter((w) => w.gone && !w.locked).length} entries have no folder. To remove them: sage worktrees prune --yes. It removes each clean one, prints each path that it removes or keeps, and deletes no branch.`].join("\n");
  }
  const out = [head];
  let removed = 0;
  const gone = all.filter((w) => w.gone && !w.locked);
  for (const w of all.filter((x) => !gone.includes(x))) {
    let why = kept(w, homes, all);
    try {
      why ||= changed(git, root, w, ledger);
      if (!why) {
        git(["-C", root, "worktree", "remove", w.path]);
        removed++;
        out.push(`removed ${w.path} · ${w.reason}`);
        continue;
      }
    } catch (e) {
      why = `git refused: ${String(e.stderr || e.message).trim().split("\n").at(-1)}`;
    }
    out.push(`kept ${w.path} · ${why}`);
  }
  if (gone.length) {
    git(["-C", root, "worktree", "prune"]);
    for (const w of gone) out.push(`pruned the entry of ${w.path} · its folder is gone`);
  }
  out.push(`Removed ${removed}, kept ${all.length - removed - gone.length}, pruned ${gone.length} entries with no folder. No branch was deleted.`);
  return out.join("\n");
}
