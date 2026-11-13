import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export const worktreeRoot = (env = process.env) => resolve(env.SAGE_WORKTREES || join(env.HOME || homedir(), "sage-worktrees"));
export const pagesFolder = (logbook, env = process.env) => join(worktreeRoot(env), logbook, "pages");

const OVER = ["merged", "concluded", "abandoned"];
const REASONS = [...OVER, "branch merged", "open", "unknown"];
const REMOVABLE = REASONS.slice(0, 4);
const REBUILT = ["node_modules", "dist"];
const isLink = (path) => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };
const rebuilt = (top, entry) => REBUILT.includes(entry.replace(/\/$/, "").split("/").at(-1)) && (entry.endsWith("/") || isLink(join(top, entry)));
const some = (items) => (items.length > 3 ? `${items.slice(0, 3).join(", ")} and ${items.length - 3} more` : items.join(", "));
const real = (path) => { try { return realpathSync(path); } catch { return path; } };
const short = (sha) => String(sha ?? "").slice(0, 7);

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

const commitOf = (git, root, ref) => { try { return git(["-C", root, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim(); } catch { return undefined; } };
const inMain = (git, root, sha, main) => { try { git(["-C", root, "merge-base", "--is-ancestor", sha, main]); return true; } catch { return false; } };
function onTrunk(git, root, sha, main) {
  try {
    const k = git(["-C", root, "rev-list", "--first-parent", "--count", main, `^${sha}`]).trim();
    return { fresh: git(["-C", root, "rev-parse", "--verify", `${main}~${k}^{commit}`]).trim() === sha };
  } catch (e) {
    return { fresh: false, failed: String(e.stderr || e.message).trim().split("\n").at(-1) };
  }
}
const topOf = (git, path) => { try { return real(git(["-C", path, "rev-parse", "--show-toplevel"]).trim()); } catch { return undefined; } };
const lower = (s) => String(s ?? "").toLowerCase();

function rows({ git, root, tasks, runs, main }) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return listed(git, root).map((w, k) => {
    const name = lower(w.branch);
    const ids = !w.branch ? [] : [...new Set([...tasks.filter((t) => lower(t.branch) === name).map((t) => t.id), ...runs.filter((r) => lower(r.branch) === name).map((r) => r.task)])].filter((id) => byId.has(id));
    const matched = ids.map((id) => byId.get(id)), open = matched.filter((t) => !OVER.includes(t.state));
    const shown = open.length ? open : matched;
    const check = !matched.length && w.branch && main && w.head && inMain(git, root, w.head, main) ? onTrunk(git, root, w.head, main) : undefined;
    const reason = matched.length
      ? (open.length ? "open" : OVER.find((s) => matched.some((t) => t.state === s)))
      : check && !check.fresh && !check.failed ? "branch merged" : "unknown";
    return { ...w, primary: k === 0, tasks: shown, reason, fresh: Boolean(check?.fresh), failed: check?.failed };
  });
}

const branchText = (w) => (w.bare ? "bare" : w.branch ?? `detached ${short(w.head)}`);
const line = (w, note) => [w.path, branchText(w), w.tasks.map((t) => t.id).join(",") || "-", w.tasks.map((t) => t.state).join(",") || "-", w.reason].join(" · ") + (note ? ` · ${note}` : "");

function kept(w, here, all) {
  if (w.primary || w.bare) return "the primary checkout";
  if (here.includes(real(w.path))) return "the worktree that this command runs in";
  if (w.locked) return "locked";
  const inner = all.find((o) => o !== w && real(o.path).startsWith(real(w.path) + sep));
  if (inner) return `another worktree is inside it: ${inner.path}`;
  if (REMOVABLE.includes(w.reason)) return "";
  if (w.tasks.length) return `open: ${w.tasks.map((t) => `${t.id} is ${t.state}`).join(", ")}, so its work may still need this folder`;
  if (!w.branch) return "unknown: it has no branch, so no task matches it";
  if (w.failed) return `unknown: no task of the logbook names its branch, and git could not check it against origin/main: ${w.failed}`;
  return `unknown: no task of the logbook names its branch, and ${w.fresh ? "the branch adds no commit to origin/main, so a run may have just started on it" : "the branch is not in origin/main"}`;
}

function changed(git, root, w, ledger) {
  const status = git(["-C", w.path, "status", "--porcelain", "-z", "--untracked-files=all", "--ignored=matching"]).split("\0").filter(Boolean);
  const untracked = status.filter((s) => s.startsWith("?? ")).length, edits = status.filter((s) => !/^(\?\?|!!) /.test(s)).length;
  const ignored = status.filter((s) => s.startsWith("!! ")).map((s) => s.slice(3));
  const again = ignored.filter((s) => rebuilt(w.path, s)), lost = ignored.filter((s) => !again.includes(s));
  const why = [edits && "uncommitted changes", untracked && "untracked files", lost.length && `ignored files that the prune would delete: ${some(lost)}`].filter(Boolean);
  if (why.length) return { why: why.join(" and "), again };
  const ids = w.tasks.map((t) => t.id), reviewed = [...new Set(ledger.filter((l) => ids.includes(l.task) && /^[0-9a-f]{40}$/i.test(l.sha ?? "")).map((l) => l.sha))];
  const ahead = Number(git(["-C", root, "rev-list", "--count", "--ignore-missing", w.head, "--not", "--remotes", ...reviewed]).trim());
  return { why: ahead ? `${ahead} unpushed commit${ahead === 1 ? "" : "s"}` : "", again };
}

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
    let why = kept(w, homes, all), again = [];
    try {
      if (!why) ({ why, again } = changed(git, root, w, ledger));
      if (!why) {
        git(["-C", root, "worktree", "remove", w.path]);
        removed++;
        out.push(`removed ${w.path} · ${w.reason}${again.length ? ` · also deleted ignored ${some(again)}` : ""}`);
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
