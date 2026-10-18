#!/usr/bin/env node
// SAMPLE DATA for board QA and the browser tests (T305). It writes made-up Claude and Codex logbooks, and the fake
// checkouts that they name, into a folder that you give. It has no default folder, and it refuses a folder that is not
// empty, a path with a link in it, and a folder in a real logbook root, so it never writes over real logbooks.
//
//   node scripts/board-sample.mjs <empty folder> [--now <ISO time>]
//
// It prints the board sources as JSON: give them to createBoardServer, or to readBoardSources and buildBoardModel.
// The set: 9 projects; one repository with a Claude and a Codex logbook (one project on the board); one repository in
// two clones (two projects); long titles; an archived project; a display name with an upstream; a project with no
// remote; gates; closed and moved findings; earlier runs; a stale run; every priority and every kind.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TABLES = {
  tasks: ["id", "title", "size", "risk", "route", "state", "branch", "pr", "round", "keys", "hold", "extra", "priority", "kind"],
  runs: ["id", "task", "role", "round", "candidate", "branch", "status", "tokens", "report", "started", "ended", "model"],
  findings: ["task", "key", "round", "source", "severity", "summary", "triage", "reason", "status"],
  ledger: ["task", "pr", "sha", "kind", "cycle", "run", "at"],
  gates: ["id", "task", "question", "options", "recommendation", "default", "answer", "at"],
  decisions: ["at", "task", "decision", "why"],
};
const ROUTE = { tiny: "build", small: "build,code-review,qa", large: "design,pe,build,code-review,security-review,ux-review,qa", investigate: "investigate,evidence-review" };
const sha = seed => createHash("sha1").update(String(seed)).digest("hex");

/**
 * The real logbook roots of this user, as the board and the state tools find them (F-T305-2): SAGE_HOME,
 * CLAUDE_CONFIG_DIR/sage and ~/.claude/sage, CODEX_HOME and ~/.codex, and the board's own settings folder. Each
 * home is both $HOME and the account's home, so a changed HOME does not hide the real one.
 */
const realRoots = env => {
  const homes = [env.HOME, homedir(), userInfo().homedir].filter(Boolean);
  return [env.SAGE_HOME, env.CLAUDE_CONFIG_DIR && join(env.CLAUDE_CONFIG_DIR, "sage"), env.CODEX_HOME,
    ...homes.flatMap(home => [join(home, ".claude", "sage"), join(home, ".codex"), join(home, ".config", "sage-board")])]
    .filter(Boolean).map(root => resolve(root)).flatMap(root => { try { return [root, realpathSync(root)]; } catch { return [root]; } });
};
const inside = (root, path) => { const rel = relative(root, path); return rel === "" || !rel.startsWith("..") && !isAbsolute(rel); };

/** Writes the sample logbooks into folder (absolute, empty or missing) and gives the board sources. */
export function writeSampleLogbooks(folder, { now = new Date().toISOString(), env = process.env } = {}) {
  if (!isAbsolute(folder ?? "")) throw new TypeError("give an absolute folder for the sample logbooks");
  folder = resolve(folder);
  const root = realRoots(env).find(root => inside(root, folder));
  if (root) throw new Error(`${folder} is in the real logbook root ${root}: give a folder outside it`);
  // A link anywhere in the path could lead the writes somewhere else (F-T305-1): refuse it, and name the real path.
  for (let path = folder; ; path = dirname(path)) {
    let link = false;
    try { link = lstatSync(path).isSymbolicLink(); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (link) {
      let real = "a path with no link"; try { real = realpathSync(path) + folder.slice(path.length); } catch {}
      throw new Error(`${folder} goes through the link ${path}: give the real path (${real})`);
    }
    if (dirname(path) === path) break;
  }
  if (existsSync(folder) && readdirSync(folder).length) throw new Error(`${folder} is not empty: give an empty or a new folder`);
  const at = Date.parse(now);
  if (!Number.isFinite(at)) throw new TypeError("--now must be an ISO time");
  const ago = (hours) => new Date(at - hours * 3600000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const sources = [{ id: "claude", label: "claude", provider: "Claude", path: join(folder, "claude") }, { id: "codex", label: "codex", provider: "Codex", path: join(folder, "codex") }];

  /** One repository: a fake checkout with a Git config, and one logbook per provider that names it. */
  const repo = ({ folder: name, at: path = join(folder, "checkouts", name), origin, upstream, display, archived, books }) => {
    mkdirSync(join(path, ".git"), { recursive: true });
    const remote = (which, slug) => slug ? `[remote "${which}"]\n\turl = https://github.com/${slug}.git\n\tfetch = +refs/heads/*:refs/remotes/${which}/*\n` : "";
    writeFileSync(join(path, ".git", "config"), `[core]\n\trepositoryformatversion = 0\n${remote("origin", origin)}${remote("upstream", upstream)}`);
    const key = `${basename(path).toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${sha(path).slice(0, 6)}`;
    for (const [source, data] of Object.entries(books)) {
      const dir = join(folder, source, key);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "checkout.txt"), `${path}\n`);
      if (display || archived) writeFileSync(join(dir, "config.json"), `${JSON.stringify({ ...(display ? { name: display } : {}), ...(archived ? { archived: true } : {}) })}\n`);
      for (const [table, columns] of Object.entries(TABLES)) {
        const rows = (data[table] ?? []).map(row => columns.map(column => String(row[column] ?? "")).join("\t"));
        writeFileSync(join(dir, `${table}.tsv`), [columns.join("\t"), ...rows].join("\n") + "\n");
      }
    }
  };
  const task = (id, title, state, extra = {}) => ({ id, title, state, size: extra.size ?? "small", risk: "", route: ROUTE[extra.size ?? "small"], branch: "", pr: "", round: "0", keys: "", ...extra });
  const framed = (id, title, priority, kind, hours) => [task(id, title, "framed", { priority, kind }), { at: ago(hours), task: id, decision: "task framed", why: "sample" }];
  const backlog = list => ({ tasks: list.map(item => item[0]), decisions: list.map(item => item[1]) });
  const merge = (...parts) => parts.reduce((all, part) => Object.fromEntries(Object.keys(TABLES).map(name => [name, [...(all[name] ?? []), ...(part[name] ?? [])]])), {});

  // 1. sage: one repository with a Claude and a Codex logbook. Every step of the loop, and every kind.
  const head = sha("sample head 1"), old = sha("sample head 0"), fixed = sha("sample head 2");
  const claudeSage = merge(
    backlog([
      framed("T310", "Sample: a priority column in the tasks table", "P1", "logbook", 30),
      framed("T311", "Sample: a faster logbook read on start", "", "optimization", 40),
      framed("T313", "Sample: the lead's time limit", "P3", "orchestration", 50),
      framed("T320", "Sample: a much longer task title that goes on to show how a card clamps a title of three lines or more at the narrow column widths of a phone and of a laptop", "P2", "docs", 60),
      framed("T321", "Sample: checks for the README graphics", "P2", "checks", 70),
      framed("T322", "Sample: the provider word on each card", "", "providers", 80),
      framed("T323", "Sample: the eighth backlog task, in the fold", "P3", "ui", 90),
    ]),
    {
      tasks: [
        task("T305", "Sample: the project picker for the board", "awaiting-you", { size: "large", priority: "P0", kind: "design" }),
        task("T301", "Sample: one password per tunnel", "reviewing", { size: "large", risk: "auth", route: `${ROUTE.large}`, pr: "117", branch: "sage/t301-sample", priority: "P1", kind: "security" }),
        task("T298", "Sample: the hook reads only the owner", "held", { priority: "P0", kind: "orchestration", branch: "sage/t298-sample" }),
        task("T302", "Sample: council minutes search drops accents", "repairing", { pr: "52", branch: "sage/t302-sample", round: "1", priority: "P0", kind: "bug-fix" }),
        task("T303", "Sample: retry the carrier poll", "verified", { pr: "41", branch: "sage/t303-sample", priority: "P1", kind: "bug-fix" }),
        task("T304", "Sample: build the agenda import", "building", { pr: "", branch: "sage/t304-sample", priority: "P2", kind: "ui" }),
        task("T205", "Sample: the task board", "merged", { pr: "90", branch: "sage/t205-sample", kind: "ui" }),
      ],
      runs: [
        { id: "R201", task: "T301", role: "implementer", round: "0", status: "done", tokens: "48000", started: ago(9), ended: ago(7) },
        { id: "R202", task: "T301", role: "code-reviewer", round: "0", status: "done", tokens: "21000", started: ago(6), ended: ago(5.5) },
        { id: "R203", task: "T301", role: "security-reviewer", round: "0", status: "running", tokens: "", started: ago(0.4) },
        { id: "R210", task: "T302", role: "implementer", round: "0", status: "done", tokens: "30000", started: ago(30), ended: ago(28) },
        { id: "R211", task: "T302", role: "code-reviewer", round: "0", status: "done", tokens: "12000", started: ago(27), ended: ago(26) },
        { id: "R212", task: "T302", role: "qa", round: "0", status: "done", tokens: "9000", started: ago(27), ended: ago(26.5) },
        { id: "R213", task: "T302", role: "implementer", round: "1", status: "running", tokens: "", started: ago(1.2) },
        { id: "R220", task: "T303", role: "implementer", round: "0", status: "done", tokens: "15000", started: ago(20), ended: ago(19) },
        { id: "R221", task: "T303", role: "code-reviewer", round: "0", status: "done", tokens: "8000", started: ago(18), ended: ago(17.5) },
        { id: "R222", task: "T303", role: "qa", round: "0", status: "done", tokens: "7000", started: ago(18), ended: ago(17) },
        { id: "R230", task: "T304", role: "implementer", round: "0", status: "running", tokens: "", started: ago(0.7) },
        ...Array.from({ length: 7 }, (_, i) => ({ id: `R${180 + i}`, task: "T205", role: i % 2 ? "code-reviewer" : "implementer", round: "0", status: "done", tokens: String(10000 + i * 1000), started: ago(150 - i), ended: ago(149.5 - i) })),
      ],
      ledger: [
        { task: "T301", pr: "117", sha: old, kind: "checks-fail", cycle: "1", run: "", at: ago(8) },
        { task: "T301", pr: "117", sha: head, kind: "checks-pass", cycle: "1", run: "", at: ago(6.5) },
        { task: "T301", pr: "117", sha: head, kind: "review-clean", cycle: "1", run: "R202", at: ago(5.5) },
        { task: "T302", pr: "52", sha: sha("sample head 52"), kind: "checks-pass", cycle: "1", run: "", at: ago(27) },
        { task: "T302", pr: "52", sha: sha("sample head 52"), kind: "findings", cycle: "1", run: "R211", at: ago(26) },
        { task: "T303", pr: "41", sha: fixed, kind: "checks-pass", cycle: "1", run: "", at: ago(18) },
        { task: "T303", pr: "41", sha: fixed, kind: "review-clean", cycle: "1", run: "R221", at: ago(17.5) },
        { task: "T303", pr: "41", sha: fixed, kind: "qa-pass", cycle: "1", run: "R222", at: ago(17) },
      ],
      findings: [
        { task: "T302", key: "F-T302-1", round: "0", source: "code-reviewer", severity: "high", summary: "Sample: the search drops accents", triage: "fix", status: "open" },
        { task: "T302", key: "F-T302-2", round: "0", source: "code-reviewer", severity: "low", summary: "Sample: a long query has no limit", triage: "fix", status: "open" },
        { task: "T302", key: "F-T302-3", round: "0", source: "qa", severity: "low", summary: "Sample: a typo in the empty state", triage: "dismiss", reason: "sample: fixed in the copy pass", status: "dismissed" },
        { task: "T301", key: "F-T301-1", round: "0", source: "code-reviewer", severity: "medium", summary: "Sample: the tunnel header check", triage: "fix", status: "closed" },
      ],
      gates: [
        { id: "G3", task: "T298", question: "Sample: should the hook also refuse an agent's copy?", options: "yes|no", recommendation: "yes", default: "yes", at: ago(3) },
        { id: "G4", task: "T305", question: "Sample: picker design A, B or C?", options: "A|B|C", recommendation: "B", default: "B", at: ago(2) },
      ],
      decisions: [
        { at: ago(140), task: "T205", decision: "state merged", why: "sample" },
        { at: ago(2), task: "T305", decision: "state awaiting-you", why: "sample" },
        { at: ago(0.7), task: "T304", decision: "state building", why: "sample" },
      ],
    },
  );
  const codexSage = {
    tasks: [task("T7", "Sample: the Codex hook manifest", "building", { branch: "codex/t7-sample", priority: "P1", kind: "providers" }), task("T9", "Sample: why the review queue stalls", "verifying", { size: "investigate", route: ROUTE.investigate, priority: "P2", kind: "design" })],
    runs: [
      { id: "R18", task: "T9", role: "investigate", status: "done", tokens: "22000", started: ago(5), ended: ago(4) },
      { id: "R19", task: "T9", role: "evidence-review", status: "running", started: ago(0.3) },
      // A run that started 3 days ago, with no logbook change since: the board says it may have stopped.
      { id: "R5", task: "T7", role: "implementer", status: "running", started: ago(72) },
    ],
  };
  repo({ folder: "sage", origin: "sample-owner/sage", books: { claude: claudeSage, codex: codexSage } });

  // 2. A display name, an upstream and an origin; tasks in both providers.
  repo({ folder: "product-demos", origin: "sample-owner/council-record", upstream: "sample-org/council-record", display: "Council Record (sample)", books: {
    claude: { tasks: [task("T41", "Sample: council minutes search", "reviewing", { pr: "12", priority: "P0", kind: "ui" })], gates: [{ id: "G1", task: "T41", question: "Sample: ship the search behind a flag?", options: "yes|no", recommendation: "yes", at: ago(1) }], decisions: [{ at: ago(1), task: "T41", decision: "state reviewing", why: "sample" }] },
    codex: { tasks: [task("T3", "Sample: the contributor guide", "framed", { priority: "P3", kind: "docs" })], decisions: [{ at: ago(4), task: "T3", decision: "task framed", why: "sample" }] },
  } });
  // 3. Claude only; verified, waits for the merge.
  repo({ folder: "order-chaser", origin: "sample-owner/order-chaser", books: { claude: { tasks: [task("T12", "Sample: retry the carrier poll", "verified", { pr: "41", priority: "P1", kind: "bug-fix" }), task("T13", "Sample: an email digest", "framed", { kind: "ui" })], decisions: [{ at: ago(26), task: "T12", decision: "state verified", why: "sample" }] } } });
  // 4. Codex only, with a gate.
  repo({ folder: "review-queue", origin: "sample-owner/review-queue", books: { codex: { tasks: [task("T9", "Sample: the review queue page", "designing", { size: "large", route: ROUTE.large, priority: "P1", kind: "design" })], gates: [{ id: "G2", task: "T9", question: "Sample: one queue or one per project?", options: "one|per project", recommendation: "one", at: ago(50) }], decisions: [{ at: ago(50), task: "T9", decision: "state designing", why: "sample" }] } } });
  // 5. Two clones of one repository at two paths: two projects.
  for (const clone of ["trip-planner", "trip-planner-copy"]) repo({ folder: clone, origin: "sample-owner/trip-planner", books: { claude: { tasks: [task("T20", `Sample: a shared packing list (${clone})`, "building", { kind: "ui" })], decisions: [{ at: ago(80), task: "T20", decision: "state building", why: "sample" }] } } });
  // 6. No GitHub remote; idle for 9 days.
  repo({ folder: "home-lab", books: { claude: { tasks: [task("T5", "Sample: back up the NAS", "framed", { priority: "P3", kind: "docs" })], decisions: [{ at: ago(9 * 24), task: "T5", decision: "task framed", why: "sample" }] } } });
  // 7. Archived.
  repo({ folder: "old-site", origin: "sample-owner/old-site", archived: true, books: { codex: { tasks: [task("T2", "Sample: a dark mode", "framed", { kind: "ui" }), task("T3", "Sample: the old held task", "held")], decisions: [{ at: ago(60 * 24), task: "T2", decision: "task framed", why: "sample" }] } } });
  // 8. Idle for 3 weeks.
  repo({ folder: "recipes-app", origin: "sample-owner/recipes", books: { claude: { tasks: [task("T8", "Sample: scale a recipe", "framed", { kind: "optimization" })], decisions: [{ at: ago(21 * 24), task: "T8", decision: "task framed", why: "sample" }] } } });
  return sources;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [folder, flag, value] = process.argv.slice(2);
  if (!folder || (flag && flag !== "--now")) { console.error("usage: node scripts/board-sample.mjs <empty folder> [--now <ISO time>]"); process.exit(2); }
  try { console.log(JSON.stringify(writeSampleLogbooks(resolve(folder), flag ? { now: value } : {}), null, 2)); }
  catch (error) { console.error(error.message); process.exit(1); }
}
