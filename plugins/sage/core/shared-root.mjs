// The shared root and the one rule that finds a project's logbook (T306 design, PR 2). The root holds one logbook for
// each project that both providers use, with three tables that only the state tool writes, under the root's lock:
//   bindings.tsv: one row for each checkout: root (the validated project root), folder, commits (its first commits), at.
//     Its marker bindings.made says that sage made it, so a table that goes missing refuses and never reads as no rows.
//   plugins.tsv: one row for each provider that ran: provider, contract, at.
//   projects.tsv: the known project list of this root, as in each provider root.
// Every command finds its logbook again. A row means shared. No row means legacy, as before this root existed.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { readLocalGit } from "./local-git.mjs";
import { stoppedText } from "./move-text.mjs";

const BINDINGS = ["root", "folder", "commits", "at"];
const PLUGINS = ["provider", "contract", "at"];
/**
 * What plugins.tsv says that a provider's state tool understands. Raise it only when a change needs both providers to
 * update. 2: the state tool knows the move (T641): a write refuses a moved logbook, so the move may start.
 */
const CONTRACT = "2";
/** A logbook's folder name: today's rule, computed once and saved in the row. */
const FOLDER = /^[a-z0-9-]+-[0-9a-f]{6}$/;
const COMMITS = /^(?:[0-9a-f]{40,64}(?:,[0-9a-f]{40,64})*)?$/;
/** What a refusal about first commits adds: a shallow clone's first commit is its newest one, so it matches no other checkout. */
const SHALLOW = "A shallow clone needs its full history here: run git fetch --unshallow in it, then try again.";
/** The warning of a link prompt (T633 design), before its choices: a link or a new logbook stays. */
const LASTS = "Note: no sage command can change this answer later.";

/** The <owner>/<repo> of a GitHub remote's URL, or null for any other remote. The board and the link prompt read remotes with it. */
export const githubRemote = (url) => {
  const match = /^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[:/]([A-Za-z0-9][A-Za-z0-9-]*)\/([\w-][\w.-]*?)(?:\.git)?\/?$/.exec(url ?? "");
  return match ? `${match[1]}/${match[2]}` : null;
};
/** The largest table that the tool reads: a checkout row is short, so a bigger file is not a table of this tool. */
const TABLE_MAX = 1024 * 1024;
/** The folder of the shared root that holds the plan of a move while it runs (T640): moves/<folder>.json, one per new logbook. */
export const MOVES = "moves";
const PLAN = /^[a-z0-9-]+-[0-9a-f]{6}\.json$/;
/** The largest plan: the rows of the open tasks of two logbooks, far below the board's 16 MiB read. */
export const PLAN_MAX = 32 * 1024 * 1024;

/**
 * The one function that picks the shared root: the launcher's fixed option, SAGE_SHARED_HOME, <SAGE_HOME>/shared, then
 * ~/.sage. SAGE_HOME alone does not mean a test: the Codex runtime sets it in production, so it passes the fixed option.
 */
export const sharedRoot = (env = process.env, fixed) => resolve(fixed || env.SAGE_SHARED_HOME || (env.SAGE_HOME ? join(env.SAGE_HOME, "shared") : join(env.HOME || homedir(), ".sage")));

/** The column names of bindings.tsv, and the check of one of its rows: the state tool and the board read the table with them. */
export const BINDING_COLUMNS = BINDINGS;
export const bindingRow = (r) => isAbsolute(r.root) && FOLDER.test(r.folder) && COMMITS.test(r.commits);

/** Is something at the path? A folder on the way that is no folder holds nothing: the later read names it, as before this root. */
const present = (path) => {
  try {
    return !!lstatSync(path, { throwIfNoEntry: false });
  } catch (e) {
    if (["ENOTDIR", "ELOOP"].includes(e.code)) return false;
    throw e;
  }
};
/** Is a row's checkout gone from the disk? A path that cannot be read may still be there, so it counts as live. */
export const gone = ({ root }) => {
  try {
    return !present(root);
  } catch {
    return false;
  }
};
/**
 * Is a run's checkout gone, so that git cannot read its branch there? A checkout has its .git, so a plain file or a
 * folder without .git at its path is gone too (F-T625-6). The state tool and the board read a run's checkout by it.
 */
export const checkoutGone = ({ root }) => gone({ root: join(root, ".git") });
/**
 * The row that a logbook belongs to: its oldest live row with first commits, or its oldest gone row when none is live.
 * A later row with none of them is the foreign one, so the owner keeps working. A row of a checkout that left stays
 * and does no harm: it can refuse a newcomer, but never the only live checkout. The board names a shared logbook's
 * checkout by this row too.
 */
export const ownerOf = (rows, folder) => rows.filter((r) => r.folder === folder && r.commits).sort((a, b) => gone(a) - gone(b) || a.at.localeCompare(b.at))[0];

export function createSharedRoot({ Refusal, refuse, listed, legacyRoots, makeLogbook, enroll, now, projectRoot, provider, raiseCounts, readRegular, rowsOf, sageRoot, sheetText, slug, swap, visible, withLock }) {
  const realOf = (path) => {
    try { return realpathSync.native(path); } catch { return path; }
  };
  /** The shared root of a command. A relative SAGE_SHARED_HOME would name another root from another folder, and a project would lose its row in silence. */
  const rootOf = (env) => {
    if (env.SAGE_SHARED_HOME && !isAbsolute(env.SAGE_SHARED_HOME)) refuse(`SAGE_SHARED_HOME is ${JSON.stringify(visible(env.SAGE_SHARED_HOME))}, but it must be an absolute path, so that each folder finds the same shared root. Nothing changed. Ask the user to fix it.`);
    return sharedRoot(env);
  };
  /** Today's folder name: from the checkout's main root, as it was before any row. */
  const folderOf = (checkout) => `${slug(basename(checkout))}-${createHash("sha1").update(checkout).digest("hex").slice(0, 6)}`;
  /**
   * Every root that may hold this project's legacy logbook, with its provider: this tool's own, then what the adapter
   * names. A root that the adapter gives as a bare path has provider null. A path that comes twice keeps its first name.
   */
  const roots = (env) => {
    const seenPaths = new Map();
    for (const { provider: name, path } of [{ provider: provider ?? null, path: sageRoot(env) }, ...legacyRoots(env)]) if (!seenPaths.has(resolve(path))) seenPaths.set(resolve(path), name);
    return [...seenPaths].map(([path, name]) => ({ provider: name, path }));
  };
  /**
   * What the resolver sees in a provider root that it may not read: nothing. A project with a row never looks there, and
   * a project with no row keeps today's result, because today's commands never read the other root. Only the link stays
   * strict (present), because a link over a logbook that it cannot see would hide that logbook.
   */
  const seen = (path) => {
    try {
      return present(path);
    } catch (e) {
      if (["EACCES", "EPERM"].includes(e.code)) return false;
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

  /** bindings.tsv: root is the key, so a path on two rows is a damaged table. A table that sage made and that is gone refuses. */
  function bindings(shared) {
    const rows = table(shared, "bindings", BINDINGS, bindingRow);
    const file = join(shared, "bindings.tsv"), made = join(shared, "bindings.made");
    if (!rows.length && !present(file) && present(made)) refuse(`${file} is missing, but sage made it before (${made}), so sage cannot tell which logbook a project uses. Nothing changed. Ask the user to restore it from a copy. If no project uses the shared root, the user removes ${made}.`);
    const seenRoots = new Set();
    for (const { root } of rows) {
      if (seenRoots.has(root)) refuse(`${file} has two rows for ${visible(root)}, but a checkout has one row, so sage cannot tell which logbook it uses. Nothing changed. Ask the user to keep the right row.`);
      seenRoots.add(root);
    }
    return rows;
  }
  /** The table, then its marker: a stop between the two leaves a working table, and the next write adds the marker. */
  function writeBindings(shared, rows) {
    writeTable(shared, "bindings", BINDINGS, rows);
    const made = join(shared, "bindings.made");
    if (!present(made)) swap(made, `${now()}\n`);
  }

  const disjoint = (a, b) => !!a && !!b && !a.split(",").some((commit) => b.split(",").includes(commit));
  const shares = (a, b) => !!a && !!b && !disjoint(a, b);
  /** A logbook's project name: its folder without the hash. */
  const nameOf = (folder) => folder.slice(0, -7);
  /**
   * A link prompt of the T633 design, as the chief puts it to the owner word for word: the head line, the facts, the
   * notes, the numbered choices with the recommended one marked, and then, for the chief, the command of each choice.
   */
  const prompt = (checkout, head, facts, notes, choices, reply) => [
    `**${head}:** ${visible(checkout)}`, facts, ...notes, `Choose one:\n${choices.map(({ text }, i) => `${i + 1}. ${text}`).join("\n")}`,
    reply ?? `Reply ${choices.slice(0, -1).map((_, i) => i + 1).join(", ")} or ${choices.length}.`,
    `After the reply, run one command in ${visible(checkout)}: ${choices.map(({ run }, i) => `for ${i + 1}, ${run}`).join("; ")}.`,
  ].join("\n\n");
  const SEPARATE = "sage link --separate", ANOTHER = "sage link --to <the folder of the project that the user names>";
  /** The logbook of a row. A row that names a missing folder, or a folder that another project owns, refuses with the link prompt. */
  function boundFolder(shared, rows, row) {
    const dir = join(shared, row.folder);
    if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) refuse(prompt(row.root, "This folder's logbook is missing",
      `Its row links it to the logbook ${row.folder}, but that folder is not in the shared root (${visible(shared)}) now. Nothing has changed.`,
      ["Note: a new link or a new logbook does not bring back the old tasks."], [
        { text: `**Restore the folder** (recommended if it was removed by mistake). Put ${row.folder} back from a copy, for example Time Machine. Then ask me again.`, run: `no command: the user puts ${row.folder} back in ${visible(shared)}` },
        { text: "**Start separate.** This folder gets a new, empty logbook.", run: SEPARATE },
        { text: "**Link to another project.** Tell me its name.", run: ANOTHER },
      ]));
    const owner = ownerOf(rows, row.folder);
    if (owner && disjoint(owner.commits, row.commits)) refuse(prompt(row.root, "This folder's link is wrong",
      `Its row links it to the logbook ${row.folder}, but that logbook belongs to another project (${visible(owner.root)}): the two folders have no first commit in common. So sage does not use that logbook here, and nothing has changed. The ${nameOf(row.folder)} tasks are safe.`,
      ["If this folder is a shallow clone, its first commit is its newest one. Then run `git fetch --unshallow` in it, and ask me again.", LASTS], [
        { text: "**Start separate** (recommended). This folder gets a new, empty logbook in place of the wrong link.", run: SEPARATE },
        { text: "**Link to another project.** Tell me its name. The link stops if that project does not have this folder's first commit.", run: ANOTHER },
      ], "Reply 1, or 2 and the name."));
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
   * The plans of the moves that run or stopped now (T640): moves/<folder>.json in the shared root. Most commands find no
   * folder here, at the cost of one read of the folder. A plan that does not read as JSON is still a plan: it stops the
   * commands of every project, because sage cannot tell which project it moves.
   */
  function movePlans(shared) {
    let names;
    try {
      names = readdirSync(join(shared, MOVES));
    } catch (e) {
      if (["ENOENT", "ENOTDIR"].includes(e.code)) return [];
      throw e;
    }
    return names.filter((name) => PLAN.test(name)).map((name) => {
      const file = join(shared, MOVES, name);
      try {
        return { file, plan: JSON.parse(readRegular(file, { link: false, max: PLAN_MAX })) };
      } catch {
        return { file, plan: null };
      }
    });
  }
  /**
   * While the plan of a move exists, every command of the project refuses and names the command that finishes the move:
   * the project's new logbook (folder), a checkout that the move links, or an old logbook that it moves (dirs).
   */
  function stopped(shared, folder, checkout, dirs) {
    for (const { file, plan } of movePlans(shared)) {
      if (!plan || plan.folder === folder || plan.checkouts?.some((c) => c.root === checkout) || plan.sources?.some((s) => dirs.includes(s.dir))) refuse(stoppedText(plan, file));
    }
  }

  /**
   * Every logbook of this repository in the provider roots, for the move: this checkout's folder in each root, and each
   * other logbook whose checkout.txt names another checkout with a first commit in common (a clone). A logbook that moved
   * already is no source. The Claude logbooks come first, then the Codex ones, then any other provider; this checkout's
   * own folder first in each. checkouts: each checkout that the move links, with its first commits. A root that cannot be
   * read refuses: a logbook that the move does not see would stay behind, and its link would hide it.
   */
  function repositoryLogbooks(checkout, env = process.env) {
    const key = realOf(checkout), folder = folderOf(checkout), known = new Map();
    const commitsOf = (path) => {
      if (!known.has(path)) {
        try {
          known.set(path, firstCommits(path));
        } catch (e) {
          if (!(e instanceof Refusal)) throw e;
          known.set(path, null);
        }
      }
      return known.get(path);
    };
    const mine = firstCommits(checkout), rank = (p) => ["claude", "codex"].indexOf(p) + 1 || 3, sources = [];
    known.set(key, mine);
    for (const root of roots(env)) {
      let names = [];
      try {
        names = readdirSync(root.path).sort();
      } catch (e) {
        if (!["ENOENT", "ENOTDIR"].includes(e.code)) refuse(`refused: cannot read the ${root.provider ?? "unnamed"} logbook root ${visible(root.path)} (${e.code}), so the move cannot see each logbook of this project. Nothing changed. Ask the user to fix its rights, or run the move from the other provider.`);
      }
      for (const name of names) {
        const dir = join(root.path, name);
        if (!FOLDER.test(name) || !lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() || !present(join(dir, "tasks.tsv"))) continue;
        let told;
        try {
          told = readRegular(join(dir, "checkout.txt"), { link: false, max: 65536 })?.trim();
        } catch {}
        const at = told && isAbsolute(told) ? realOf(told) : undefined;
        if (name === folder) sources.push({ provider: root.provider, dir, checkout: at ?? key, own: true });
        // Another folder of this checkout (a path that reached it by another name), or of a clone with a first commit in common.
        else if (at && !present(join(dir, "moved.json")) && (at === key || (lstatSync(at, { throwIfNoEntry: false })?.isDirectory() && shares(commitsOf(at), mine)))) sources.push({ provider: root.provider, dir, checkout: at });
      }
    }
    sources.sort((a, b) => rank(a.provider) - rank(b.provider) || (b.own ?? false) - (a.own ?? false));
    const paths = [...new Set([key, ...sources.map((s) => s.checkout)])];
    const live = paths.filter((p) => p === key || (lstatSync(p, { throwIfNoEntry: false })?.isDirectory() && shares(commitsOf(p), mine)));
    return { sources: sources.map(({ own, ...s }) => s), checkouts: live.map((root) => ({ root, commits: commitsOf(root) ?? "" })), gone: paths.filter((p) => !live.includes(p)) };
  }

  /**
   * The one resolver, the same order for both providers. A row means shared. No row and a moved marker in a provider
   * root refuses. No row and no marker is this provider's legacy path, whether a logbook is there or not: rule 3 stays
   * off, so the caller keeps today's refusal or today's init. legacy says whether either provider root holds one.
   */
  function locate(project, env = process.env) {
    const checkout = projectRoot(resolve(project)), shared = rootOf(env), rows = bindings(shared);
    const row = rows.find((r) => r.root === realOf(checkout));
    const folder = folderOf(checkout), all = roots(env);
    stopped(shared, row?.folder ?? folder, realOf(checkout), row ? [] : all.map((root) => join(root.path, folder)));
    // owner: the checkout of the logbook's owner row (ownerOf), whose origin is the logbook's repository (sage-pr, T634).
    if (row) return { dir: boundFolder(shared, rows, row), row, get owner() { return ownerOf(rows, row.folder)?.root; }, checkout, shared: true };
    const moved = all.map((root) => join(root.path, folder, "moved.json")).find(seen);
    if (moved) refuse(`this project's logbook moved to the shared root, but the move did not finish (${moved}). Nothing changed. Run the move again.`);
    // old: each provider root's logbook of this project, with the root's provider (null when the adapter does not name it).
    const old = all.map((root) => ({ provider: root.provider, dir: join(root.path, folder) })).filter(({ dir }) => seen(join(dir, "tasks.tsv")));
    return { dir: join(sageRoot(env), folder), checkout, shared: false, legacy: old.length > 0, old };
  }

  /** The nearest folder, from the checkout up, with a .git entry: where Git looks for a repository. A path that cannot be read counts as one. */
  const gitEntry = (checkout) => {
    for (let dir = realOf(checkout); ; dir = dirname(dir)) {
      try {
        if (present(join(dir, ".git"))) return dir;
      } catch {
        return dir;
      }
      if (dir === dirname(dir)) return undefined;
    }
  };

  /**
   * The first commits of a checkout, sorted, or "" when HEAD has no commit yet or no repository is there. The call is the
   * hardened local read, because the folder may be a planted one. Replace refs do not count, and no missing object is
   * fetched. Every other failed read refuses, because a repository that Git cannot read may have commits. symbolic-ref
   * tells a branch with no commit yet from a garbage ref: it fails on the garbage ref, and rev-parse fails on both.
   */
  function firstCommits(checkout) {
    const read = (args) => {
      try {
        return readLocalGit(checkout, args).toString();
      } catch (e) {
        if (typeof e.status === "number") return undefined;
        refuse(e.code === "ETIMEDOUT" ? `git took more than 5 s to find the first commit of ${visible(checkout)}. sage made no row. Run the command again.` : `git cannot run on ${visible(checkout)} (${e.code ?? e.message}). sage made no row. Ask the user to check the Git install.`);
      }
    };
    const out = read(["rev-list", "--max-parents=0", "HEAD"]);
    if (out !== undefined) return out.split("\n").filter(Boolean).sort().join(",");
    if (read(["rev-parse", "--verify", "-q", "HEAD"]) !== undefined) refuse(`git cannot read the history of ${visible(checkout)}, which has a HEAD commit. sage made no row. Ask the user to repair the repository.`);
    if (read(["symbolic-ref", "-q", "HEAD"]) !== undefined) return "";
    const repository = gitEntry(checkout);
    if (repository) refuse(`git cannot read the repository at ${visible(repository)}, so sage cannot find its first commit. sage made no row. Ask the user to repair the repository, then run the link again. Only a .git file that points to a removed worktree is safe to delete. Never delete a .git folder: it holds the history and any unpushed work.`);
    return "";
  }

  /**
   * A checkout with no row and no logbook, with the first commit of a shared logbook: a moved checkout, a clone or a fork.
   * A new legacy logbook here would hide the shared one, and link refuses a project with a legacy logbook, so the refusal
   * offers the link now. It runs only on the way to that refusal or to init, so a normal command calls no Git. A repository
   * that Git cannot read has no first commit to compare: it keeps today's result.
   */
  function refuseNewLogbook(checkout, env) {
    const shared = rootOf(env), rows = bindings(shared);
    if (!rows.some((r) => r.commits)) return;
    let commits;
    try {
      commits = firstCommits(checkout);
    } catch (e) {
      if (e instanceof Refusal) return;
      throw e;
    }
    const twins = rows.filter((r) => shares(r.commits, commits) && healthy(shared, rows, r));
    if (!twins.length) return;
    // The recommendation follows the GitHub origin: the same one links, another one (a fork) starts separate, and a
    // folder with none that sage can read links. Git reads the remotes only here, on the way to this refusal.
    const origin = (root) => {
      try {
        return githubRemote(readLocalGit(root, ["config", "--get", "remote.origin.url"]).toString().trim());
      } catch {
        return null;
      }
    };
    const mine = origin(checkout), here = visible(basename(checkout));
    const same = (remote) => !!mine && !!remote && mine.toLowerCase() === remote.toLowerCase(); // GitHub ignores the case
    const logbooks = [...new Set(twins.map((r) => r.folder))].map((folder) => {
      const root = ownerOf(rows, folder).root;
      return { folder, name: nameOf(folder), used: visible(root), remote: origin(root) };
    });
    const head = "This folder has no logbook yet", done = "sage does not guess, and nothing has changed.";
    const separate = { text: "**Start separate.** This folder gets a new, empty logbook, and the board shows it as another project.", run: SEPARATE };
    if (logbooks.length === 1) {
      const [{ folder, name, used, remote }] = logbooks, linkTo = `sage link --to ${folder}`;
      const facts = `It has the same first commit as the project ${name} (logbook ${folder}, used by ${used}).`;
      if (mine && remote && !same(remote)) refuse(prompt(checkout, head, `${facts} But its GitHub remote is ${mine}, not ${remote}. So it is most likely a fork. ${done}`, [LASTS], [
        { ...separate, text: separate.text.replace(".**", "** (recommended).") },
        { text: `**Link to ${name}.** This folder uses the ${name} logbook, and its tasks show in the ${name} project. Choose this only if the fork and ${name} are one project to you.`, run: linkTo },
      ]));
      const why = mine && remote ? `Its GitHub remote is also ${remote}. So it is most likely a second clone of ${name}.` : `sage cannot compare GitHub remotes: ${mine ? used : "this folder"} has none that sage can read. So it is most likely a second clone of ${name}, or this folder moved.`;
      refuse(prompt(checkout, head, `${facts} ${why} ${done}`, [LASTS], [
        { text: `**Link to ${name}** (recommended). This folder uses the ${name} logbook. Its tasks show in the one ${name} project on the board, and its runs show "checkout ${here}". No record is copied.`, run: linkTo },
        { ...separate, text: `${separate.text} Choose this for a fork that is now its own project.` },
      ]));
    }
    // Two or more shared logbooks: the one with this folder's GitHub remote is recommended. With a remote that none of
    // them has, a new logbook is. When a remote is missing, sage cannot tell, so no choice is recommended.
    const pick = logbooks.find((b) => same(b.remote));
    const fork = !pick && mine && logbooks.every((b) => b.remote);
    const ordered = pick ? [pick, ...logbooks.filter((b) => b !== pick)] : logbooks;
    refuse(prompt(checkout, head, `${logbooks.length === 2 ? "Two" : logbooks.length} shared logbooks have its first commit. ${done}${pick || fork ? "" : " sage cannot recommend one: a folder has no GitHub remote that sage can read."}`, [LASTS], [
      ...ordered.map((b) => ({ text: `${b === pick ? `**Link to ${b.name}** (recommended: the same GitHub remote, ${b.remote}).` : `**Link to ${b.name}.**`} Logbook ${b.folder}, used by ${b.used}.`, run: `sage link --to ${b.folder}` })),
      { text: `${fork ? `**Start separate** (recommended: no logbook has its GitHub remote, ${mine}).` : "**Start separate.**"} A new, empty logbook.`, run: SEPARATE },
    ]));
  }

  /** A provider's row in plugins.tsv, under the root's lock: this provider's contract, or the owner's "unused" from the move gate. */
  function writePlugin(shared, name = provider, contract = CONTRACT) {
    const rows = table(shared, "plugins", PLUGINS);
    writeTable(shared, "plugins", PLUGINS, [...rows.filter((r) => r.provider !== name), { provider: name, contract, at: now() }]);
  }
  /** The rows of plugins.tsv, for the move's refusal that shows each provider's contract and when it was written. */
  const pluginRows = (env = process.env) => table(rootOf(env), "plugins", PLUGINS);
  /**
   * The provider's row at its first command that takes a lock, never at a read. It only tells a later move what ran, so
   * a failure stops nothing: a legacy project works as before, also when the shared root cannot be written.
   */
  function notePlugin(env) {
    if (!provider) return;
    try {
      const shared = rootOf(env);
      if (table(shared, "plugins", PLUGINS).some((r) => r.provider === provider && r.contract === CONTRACT)) return;
      mkdirSync(shared, { recursive: true });
      withLock(shared, () => writePlugin(shared));
    } catch {}
  }

  /**
   * The providers that may still write a legacy logbook without the move's rules: every provider of a root and of
   * plugins.tsv whose row is missing or below CONTRACT. A row with contract "unused" (the owner's answer in the move gate)
   * counts as ready. A root whose provider the adapter does not name cannot be checked, so it waits too, with provider
   * null and its path. An empty list means that the move may start. A damaged plugins.tsv refuses, and so do two rows for
   * one provider: no plugin writes them (writePlugin keeps one row), so which one is true is unknown.
   */
  function waitingPlugins(env = process.env) {
    const shared = rootOf(env), rows = table(shared, "plugins", PLUGINS), all = roots(env);
    const twice = rows.find((r, i) => rows.findIndex((o) => o.provider === r.provider) !== i);
    if (twice) refuse(`${join(shared, "plugins.tsv")} has two rows for the provider ${JSON.stringify(visible(twice.provider))}, so sage cannot tell which plugin contract it runs. Nothing changed. Ask the user to keep one row for each provider.`);
    const names = [...new Set([...all.map((root) => root.provider), ...rows.map((r) => r.provider)].filter(Boolean))];
    const ready = (contract) => contract === "unused" || (/^[1-9]\d*$/.test(contract ?? "") && Number(contract) >= Number(CONTRACT));
    return [
      ...names.map((name) => ({ provider: name, contract: rows.find((r) => r.provider === name)?.contract ?? null })).filter(({ contract }) => !ready(contract)),
      ...all.filter((root) => !root.provider).map(({ path }) => ({ provider: null, contract: null, path })),
    ];
  }

  /** The next write of a row made before the first commit fills its commits. True when it wrote them, so the caller finds the logbook again. */
  function fillCommits(checkout, env) {
    let commits;
    try {
      commits = firstCommits(checkout);
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

  /** The link's work under the root's lock. See link. */
  function bind(shared, checkout, key, commits, { to }, env) {
    const rows = bindings(shared), row = rows.find((r) => r.root === key), folder = to ?? folderOf(checkout), dir = join(shared, folder);
    if (row && healthy(shared, rows, row)) {
      if (to !== undefined && row.folder !== to) refuse(`${visible(checkout)} is already linked to ${row.folder}, and a checkout has one logbook. Nothing changed. Keep using ${row.folder}: no command takes a linked checkout to another logbook.`);
      return `already linked: ${join(shared, row.folder)}. Nothing changed.`;
    }
    const old = folderOf(checkout), all = roots(env).map((root) => root.path);
    const moved = all.map((root) => join(root, old, "moved.json")).find(present);
    if (moved) refuse(`this project's logbook moved to the shared root, but the move did not finish (${moved}). Nothing changed. Run the move again.`);
    const legacy = !row && all.map((root) => join(root, old)).find((path) => present(join(path, "tasks.tsv")));
    if (legacy) refuse(`this project has a logbook at ${legacy}. A link would hide its tasks, so sage made no row. Nothing changed. Keep using that logbook, or ask the user for the move (sage move --preview): only the move takes an existing project to the shared root.`);
    const others = rows.filter((r) => r !== row);
    if (to !== undefined) {
      if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() || !present(join(dir, "tasks.tsv")) || !listed(shared)?.has(to)) {
        const names = [...(listed(shared) ?? [])].sort().map(visible); // named here, because an agent may not read the list
        refuse(`${dir} is not a logbook of the shared root. Nothing changed. ${names.length ? `Its logbooks are ${names.join(", ")}. Run sage link --to <folder> with one of them, or run` : "Run"} sage link --separate to start a new logbook.`);
      }
      const owner = ownerOf(others, to);
      if (owner && disjoint(owner.commits, commits)) refuse(`${to} belongs to another project (${visible(owner.root)}): the two checkouts have no first commit in common. ${SHALLOW} Nothing changed. Use sage link --separate, or name the right folder.`);
    } else if (present(dir) || others.some((r) => r.folder === folder)) refuse(`the logbook folder ${dir} is already in use, so sage made no row. Nothing changed. Ask the user to link to it with sage link --to ${folder}, or to rename or remove it.`);
    raiseCounts(shared, env);
    if (to === undefined) enroll(shared, folder, () => makeLogbook(dir, checkout, env));
    try { if (provider) writePlugin(shared); } catch {} // only for a later move, as in notePlugin
    writeBindings(shared, [...others, { root: key, folder, commits, at: now() }]); // last: a stop before it leaves no row to a half-made logbook
    const twin = to === undefined ? others.find((r) => shares(r.commits, commits)) : undefined;
    return `${visible(checkout)} now uses the shared logbook ${dir}${twin ? `, apart from ${twin.folder}, which has the same first commit` : ""}`;
  }

  /**
   * sage link: the explicit join. It runs only after the owner's answer in the chat. --to adds a row for an existing
   * shared logbook; --separate makes a new one. The first commits are read here, at the write that makes the row, and
   * never at a read. A match never joins a logbook, and a mismatch with the logbook's owner refuses a --to. A healthy row
   * stays, so a retry is safe. A row that names a missing or foreign folder is the one that link replaces. A project with
   * a legacy logbook refuses: its tasks would disappear from view, and only the move carries them over. A path that the
   * system refuses (an unwritable shared root, a file at its path, a provider root that it may not read) makes no row.
   */
  function link(project, { to, separate }, env = process.env) {
    if ((to === undefined) === (separate === undefined) || (separate !== undefined && separate !== true)) refuse("link takes exactly one of --to <folder> or --separate; --separate takes no value. Nothing changed.");
    if (to !== undefined && !FOLDER.test(to)) refuse(`${JSON.stringify(visible(to))} is not a logbook folder: its name is <project>-<6 hex>, as sage link prints it. Nothing changed.`);
    const checkout = projectRoot(resolve(project)), key = realOf(checkout), shared = rootOf(env);
    if (!lstatSync(key, { throwIfNoEntry: false })?.isDirectory()) refuse(`${visible(key)} is not a folder, so it cannot be a row. Nothing changed.`);
    if (/\p{Cc}/u.test(key)) refuse(`the path of ${visible(key)} has control characters, so it cannot be a row. Rename the folder. Nothing changed.`);
    const commits = firstCommits(checkout); // before the lock: Git may take seconds
    try {
      mkdirSync(shared, { recursive: true });
      return withLock(shared, () => bind(shared, checkout, key, commits, { to }, env));
    } catch (e) {
      if (e instanceof Refusal || !/^E[A-Z]+$/.test(e.code ?? "")) throw e;
      refuse(`sage cannot use ${visible(e.path && !e.path.startsWith(`${shared}/`) ? e.path : shared)} (${e.code}), so it made no row. Ask the user to fix that path or its rights, then run the link again.`);
    }
  }

  return { bindings, fillCommits, folderOf, link, locate, movePlans, notePlugin, pluginRows, refuseNewLogbook, repositoryLogbooks, rootOf, waitingPlugins, writeBindings, writePlugin };
}
