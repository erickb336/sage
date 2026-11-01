// The shared root and the one rule that finds a project's logbook (T306 design, PR 2). The root holds one logbook for
// each project that both providers use, with three tables that only the state tool writes, under the root's lock:
//   bindings.tsv: one row for each checkout: root (the validated project root), folder, commits (its first commits), at.
//   plugins.tsv: one row for each provider that ran: provider, contract, at.
//   projects.tsv: the known project list of this root, as in each provider root.
// Every command finds its logbook again. A row means shared. No row means legacy, as before this root existed.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

const BINDINGS = ["root", "folder", "commits", "at"];
const PLUGINS = ["provider", "contract", "at"];
/** What plugins.tsv says that a provider's state tool understands. Raise it only when a change needs both providers to update. */
const CONTRACT = "1";
/** A logbook's folder name: today's rule, computed once and saved in the row. */
const FOLDER = /^[a-z0-9-]+-[0-9a-f]{6}$/;
const COMMITS = /^(?:[0-9a-f]{40,64}(?:,[0-9a-f]{40,64})*)?$/;
/** The bound on the Git call of a write that makes a row. It refuses at the bound; no measured basis, as the design notes. */
const FIRST_COMMIT_TIMEOUT_MS = 5000;
/** The largest table that the tool reads: a checkout row is short, so a bigger file is not a table of this tool. */
const TABLE_MAX = 1024 * 1024;

/**
 * The one function that picks the shared root: the launcher's fixed option, SAGE_SHARED_HOME, <SAGE_HOME>/shared, then
 * ~/.sage. SAGE_HOME alone does not mean a test: the Codex runtime sets it in production, so it passes the fixed option.
 */
export const sharedRoot = (env = process.env, fixed) => resolve(fixed || env.SAGE_SHARED_HOME || (env.SAGE_HOME ? join(env.SAGE_HOME, "shared") : join(env.HOME || homedir(), ".sage")));

export function createSharedRoot({ Refusal, refuse, git, listed, legacyRoots, makeLogbook, enroll, now, projectRoot, provider, raiseCounts, readRegular, rowsOf, sageRoot, sheetText, slug, swap, visible, withLock }) {
  const realOf = (path) => {
    try { return realpathSync.native(path); } catch { return path; }
  };
  /** Today's folder name: from the checkout's main root, as it was before any row. */
  const folderOf = (checkout) => `${slug(basename(checkout))}-${createHash("sha1").update(checkout).digest("hex").slice(0, 6)}`;
  /** Every root that may hold this project's legacy logbook: this tool's own, then what the adapter names. */
  const roots = (env) => [...new Set([sageRoot(env), ...legacyRoots(env)].map((root) => resolve(root)))];
  /** Is something at the path? A folder on the way that is no folder holds nothing: the later read names it, as before this root. */
  const present = (path) => {
    try {
      return !!lstatSync(path, { throwIfNoEntry: false });
    } catch (e) {
      if (["ENOTDIR", "ELOOP"].includes(e.code)) return false;
      throw e;
    }
  };

  /** A table of the root as rows. A missing file has no rows. Anything else that does not read as the table refuses. */
  function table(shared, name, columns, check = () => true) {
    const file = join(shared, `${name}.tsv`);
    const damaged = (why) => refuse(`${file} ${why}, so sage cannot tell which logbook a project uses. Nothing changed. Ask the user to fix it, or update the sage plugin if a newer sage wrote it.`);
    let text;
    try {
      text = readRegular(file, { link: false, max: TABLE_MAX });
    } catch (e) {
      damaged(`cannot be read (${e.code ?? "not a regular file under 1 MiB"})`);
    }
    if (text === undefined) return [];
    const { cols, lines } = sheetText(text);
    if (cols.join("\t") !== columns.join("\t")) damaged(`does not start with the column names ${columns.join(", ")}`);
    const rows = rowsOf({ cols, lines });
    if (lines.some((line) => line.split("\t").length !== columns.length) || !rows.every(check)) damaged("has a damaged row");
    return rows;
  }
  const writeTable = (shared, name, columns, rows) => swap(join(shared, `${name}.tsv`), [columns.join("\t"), ...rows.map((r) => columns.map((c) => r[c]).join("\t"))].join("\n") + "\n");

  /** bindings.tsv: root is the key, so a path on two rows is a damaged table. */
  function bindings(shared) {
    const rows = table(shared, "bindings", BINDINGS, (r) => isAbsolute(r.root) && FOLDER.test(r.folder) && COMMITS.test(r.commits));
    const seen = new Set();
    for (const { root } of rows) {
      if (seen.has(root)) refuse(`${join(shared, "bindings.tsv")} has two rows for ${visible(root)}, but a checkout has one row, so sage cannot tell which logbook it uses. Nothing changed. Ask the user to keep the right row.`);
      seen.add(root);
    }
    return rows;
  }
  const writeBindings = (shared, rows) => writeTable(shared, "bindings", BINDINGS, rows);

  /** Two rows of one logbook with first commits and none in common: one of them names a folder of another project. */
  const disjoint = (a, b) => !!a && !!b && !a.split(",").some((commit) => b.split(",").includes(commit));
  const offer = (checkout) => `Nothing changed. Ask the user, then run sage link --to <folder> or sage link --separate, in ${visible(checkout)}.`;
  /** The logbook of a row. A row that names a missing folder, or a folder of another project, refuses and offers the link. */
  function boundFolder(shared, rows, row) {
    const dir = join(shared, row.folder);
    if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() || !present(join(dir, "tasks.tsv"))) refuse(`the row of ${visible(row.root)} in ${join(shared, "bindings.tsv")} names the logbook ${row.folder}, which is missing. ${offer(row.root)}`);
    const other = rows.find((r) => r !== row && r.folder === row.folder && disjoint(r.commits, row.commits));
    if (other) refuse(`the row of ${visible(row.root)} in ${join(shared, "bindings.tsv")} names the logbook ${row.folder}, which belongs to another project (${visible(other.root)}): the two checkouts have no first commit in common. ${offer(row.root)}`);
    return dir;
  }
  const healthy = (shared, rows, row) => {
    try {
      return !!boundFolder(shared, rows, row);
    } catch (e) {
      if (e instanceof Refusal) return false;
      throw e;
    }
  };

  /**
   * The one resolver, the same order for both providers. A row means shared. No row and a moved marker in a provider
   * root refuses. No row and no marker is this provider's legacy path, whether a logbook is there or not: rule 3 stays
   * off, so the caller keeps today's refusal or today's init. legacy says whether either provider root holds one.
   */
  function locate(project, env = process.env) {
    const checkout = projectRoot(resolve(project)), shared = sharedRoot(env), rows = bindings(shared);
    const row = rows.find((r) => r.root === realOf(checkout));
    if (row) return { dir: boundFolder(shared, rows, row), row, checkout, shared: true };
    const folder = folderOf(checkout), all = roots(env);
    const moved = all.map((root) => join(root, folder, "moved.json")).find(present);
    if (moved) refuse(`this project's logbook moved to the shared root, but the move did not finish (${moved}). Nothing changed. Run the move again.`);
    return { dir: join(sageRoot(env), folder), checkout, shared: false, legacy: all.some((root) => present(join(root, folder, "tasks.tsv"))) };
  }

  /** The first commits of a checkout, sorted, or "" when it has none or is not a Git repository. A Git call that takes too long refuses. */
  function firstCommits(checkout, env) {
    try {
      return git(["-C", checkout, "rev-list", "--max-parents=0", "HEAD"], env, { timeout: FIRST_COMMIT_TIMEOUT_MS }).split("\n").filter(Boolean).sort().join(",");
    } catch (e) {
      if (e.code === "ETIMEDOUT") refuse(`git took more than ${FIRST_COMMIT_TIMEOUT_MS / 1000} s to find the first commit of ${visible(checkout)}. sage made no row. Run the command again.`);
      return "";
    }
  }

  /** The provider's row in plugins.tsv, under the root's lock. */
  function writePlugin(shared) {
    const rows = table(shared, "plugins", PLUGINS);
    writeTable(shared, "plugins", PLUGINS, [...rows.filter((r) => r.provider !== provider), { provider, contract: CONTRACT, at: now() }]);
  }
  /**
   * The provider's row at its first command that takes a lock, never at a read. It only tells a later move what ran, so
   * a failure stops nothing: a legacy project works as before, also when the shared root cannot be written.
   */
  function notePlugin(env) {
    if (!provider) return;
    try {
      const shared = sharedRoot(env);
      if (table(shared, "plugins", PLUGINS).some((r) => r.provider === provider && r.contract === CONTRACT)) return;
      mkdirSync(shared, { recursive: true });
      withLock(shared, () => writePlugin(shared));
    } catch {}
  }

  /** The next write of a row made before the first commit fills its commits. True when it wrote them, so the caller finds the logbook again. */
  function fillCommits(checkout, env) {
    let commits;
    try {
      commits = firstCommits(checkout, env);
    } catch (e) {
      if (e instanceof Refusal) return false; // a later write tries again
      throw e;
    }
    if (!commits) return false;
    const shared = sharedRoot(env), key = realOf(checkout);
    withLock(shared, () => {
      const rows = bindings(shared);
      if (rows.some((r) => r.root === key && !r.commits)) writeBindings(shared, rows.map((r) => (r.root === key ? { ...r, commits } : r)));
    });
    return true;
  }

  /**
   * sage link: the explicit join. It runs only after the owner's answer in the chat. --to adds a row for an existing
   * shared logbook; --separate makes a new one. The first commits are read here, at the write that makes the row, and
   * never at a read. A match never joins a logbook, and a mismatch refuses a --to. A healthy row stays, so a retry is
   * safe. A row that names a missing or foreign folder is the one that link replaces. A project with a legacy logbook
   * refuses: its tasks would disappear from view, and only the move carries them over.
   */
  function link(project, { to, separate }, env = process.env) {
    if ((to === undefined) === (separate === undefined) || (separate !== undefined && separate !== true)) refuse("link takes one of --to <folder> or --separate, the second with no value.");
    if (to !== undefined && !FOLDER.test(to)) refuse(`${JSON.stringify(visible(to))} is not a logbook folder: its name is <project>-<6 hex>, as sage link prints it. Nothing changed.`);
    const checkout = projectRoot(resolve(project)), key = realOf(checkout), shared = sharedRoot(env);
    if (!lstatSync(key, { throwIfNoEntry: false })?.isDirectory()) refuse(`${visible(key)} is not a folder, so it cannot be a row. Nothing changed.`);
    if (/\p{Cc}/u.test(key)) refuse(`the path of ${visible(key)} has control characters, so it cannot be a row. Rename the folder. Nothing changed.`);
    const commits = firstCommits(checkout, env); // before the lock: Git may take seconds
    mkdirSync(shared, { recursive: true });
    return withLock(shared, () => {
      const rows = bindings(shared), row = rows.find((r) => r.root === key), folder = to ?? folderOf(checkout), dir = join(shared, folder);
      if (row && healthy(shared, rows, row)) {
        if (to !== undefined && row.folder !== to) refuse(`${visible(checkout)} is already linked to ${row.folder}, and a checkout has one logbook. Nothing changed.`);
        return `already linked: ${join(shared, row.folder)}. Nothing changed.`;
      }
      const old = folderOf(checkout), all = roots(env);
      const moved = all.map((root) => join(root, old, "moved.json")).find(present);
      if (moved) refuse(`this project's logbook moved to the shared root, but the move did not finish (${moved}). Nothing changed. Run the move again.`);
      const legacy = !row && all.map((root) => join(root, old)).find((path) => present(join(path, "tasks.tsv")));
      if (legacy) refuse(`this project has a logbook at ${legacy}. A link would hide its tasks, so sage made no row. Only the move takes an existing project to the shared root. Nothing changed.`);
      const others = rows.filter((r) => r !== row);
      if (to !== undefined) {
        if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() || !present(join(dir, "tasks.tsv")) || !listed(shared)?.has(to)) refuse(`${dir} is not a logbook of the shared root. Nothing changed.`);
        const other = others.find((r) => r.folder === to && disjoint(r.commits, commits));
        if (other) refuse(`${to} belongs to another project (${visible(other.root)}): the two checkouts have no first commit in common. Nothing changed. Use sage link --separate, or name the right folder.`);
      } else if (present(dir) || others.some((r) => r.folder === folder)) refuse(`the logbook folder ${dir} is already in use, so sage made no row. Nothing changed. Ask the user to link to it with sage link --to ${folder}, or to rename or remove it.`);
      raiseCounts(shared, env);
      if (to === undefined) enroll(shared, folder, () => makeLogbook(dir, checkout, env));
      try { if (provider) writePlugin(shared); } catch {} // only for a later move, as in notePlugin
      writeBindings(shared, [...others, { root: key, folder, commits, at: now() }]); // last: a stop before it leaves no row to a half-made logbook
      const twin = to === undefined && commits ? others.find((r) => r.commits.split(",").some((commit) => commits.split(",").includes(commit))) : undefined;
      return `${visible(checkout)} now uses the shared logbook ${dir}${twin ? `, apart from ${twin.folder}, which has the same first commit` : ""}`;
    });
  }

  return { bindings, fillCommits, link, locate, notePlugin };
}
