// The offline replay of past PRs (T485, step 1 of T344): it reads one logbook folder and prints, for the 10 merged PRs
// with the most review data, which roles ran, their tokens per round, their findings by severity, class and round, and
// which findings came later than round 0 or in a later task; then the totals per role and class. It only measures: it
// reads tasks, runs, findings, ledger and decisions, and it never writes the logbook.
//
//   node scripts/review-replay.mjs <logbook folder> [--out <file>]
//
// Without --out it prints the report. --out never names a file in the logbook folder.
import { closeSync, constants, lstatSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { FINDING_CLASSES } from "../packages/sage-core/logbook-fields.mjs";
import { REVIEW_ROLES } from "../packages/sage-core/review.mjs";
import { isMain } from "./is-main.mjs";

const PICK = 10;
const SEVERITIES = ["high", "medium", "low"];
const CLEAN = /-clean$|^qa-pass$/;

/** The rows of one table of the logbook, as objects by its header. It counts in `ragged` the rows whose cell count differs from the header. */
function table(dir, name, ragged) {
  const [head = "", ...lines] = readFileSync(resolve(dir, `${name}.tsv`), "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const cols = head.split("\t");
  return lines.map((line) => {
    const v = line.split("\t");
    if (v.length !== cols.length) ragged[name] = (ragged[name] ?? 0) + 1;
    return Object.fromEntries(cols.map((c, i) => [c, v[i] ?? ""]));
  });
}

const ran = (run) => run.status === "done";
const tokensOf = (run) => (ran(run) && /^[1-9]\d{0,11}$/.test(run.tokens) ? Number(run.tokens) : 0);
const sum = (xs, f) => xs.reduce((n, x) => n + f(x), 0);
const k = (n) => `${Math.round(n / 1000).toLocaleString("en-US")}k`;
const perM = (n, tokens) => (tokens ? (n / (tokens / 1e6)).toFixed(1) : "–");
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "–");
const kept = (f) => f.triage !== "dismiss";
const serious = (f) => kept(f) && f.severity !== "low";
const one = (s) => s.replace(/\s+/g, " ").replace(/\|/g, "\\|");

/** The report, as Markdown, from the logbook folder `dir`. `at` is the date it prints. Read only. */
export function replay(dir, at = new Date().toISOString().slice(0, 10)) {
  const ragged = {}, read = (name) => table(dir, name, ragged);
  const tasks = read("tasks"), allRuns = read("runs"), rows = read("findings"), ledger = read("ledger"), decisions = read("decisions");
  const runById = new Map(allRuns.map((r) => [r.id, r]));
  const runs = allRuns.filter((r) => REVIEW_ROLES.includes(r.role));
  const keyRun = (key) => /^(?:F-)?(R\d+)-/.exec(key)?.[1];

  // A finding that came back after a fix ("<key> opened again"), and one moved to a follow-up task ("<key> moved to T9
  // as F-T9-1: …"). A move rewrites the row to the new task and key, round 0 and no run, and its old task keeps only
  // the decision. So each moved row counts once, back on the task and key where a review found it, as kept, in the
  // round of the run that its old key names, else in round 1: a move is for a finding of a repair round.
  const again = new Set(), moved = new Map(), from = new Map();
  for (const d of decisions) {
    const m = /^(\S+) (?:opened again|moved to (T\d+) as (\S+):)/.exec(d.decision);
    if (m?.[2]) {
      (moved.get(d.task) ?? moved.set(d.task, []).get(d.task)).push({ key: m[1], to: m[2], as: m[3] });
      from.set(`${m[2]}\t${m[3]}`, { task: d.task, key: m[1] });
    } else if (m) again.add(`${d.task}\t${m[1]}`);
  }
  const originOf = (f) => {
    let o = from.get(`${f.task}\t${f.key}`);
    for (let n = 0, up; o && n < from.size && (up = from.get(`${o.task}\t${o.key}`)); n++) o = up; // moved again
    return o;
  };
  const allFindings = rows.map((f) => {
    const o = originOf(f);
    if (!o) return f;
    const run = runById.get(keyRun(o.key));
    return { ...f, task: o.task, key: o.key, triage: "moved", round: run?.task === o.task ? run.round : "1", movedTo: `${f.task} ${f.key}` };
  });
  const byTask = (rows) => rows.reduce((m, r) => (m.get(r.task)?.push(r) ?? m.set(r.task, [r]), m), new Map());
  const runsOf = byTask(runs), findingsOf = byTask(allFindings);
  const verdictOf = new Map(ledger.filter((l) => l.run && !l.kind.startsWith("checks-")).map((l) => [l.run, l.kind]));
  const movedRow = new Map(allFindings.filter((f) => f.movedTo).map((f) => [`${f.task}\t${f.key}`, f]));

  // The run of a finding: its run cell, else the run that its key names (R12-3 or F-R12-3), when that run is of its task.
  const runOf = (f) => {
    const id = f.run || keyRun(f.key);
    return id && runById.get(id)?.task === f.task ? { id, how: f.run ? "cell" : "key" } : undefined;
  };
  const classOf = (f) => f.class || "untagged";
  // A later task's finding whose summary names this task id: a rough sign that a problem shipped (a proxy, not a record).
  const namedBy = (id) => allFindings.filter((f) => f.task !== id && new RegExp(`\\b${id}\\b`).test(f.summary));

  // The pick: merged tasks with a PR and done review runs that all have tokens, by review findings, then review tokens.
  const candidates = tasks.filter((t) => t.state === "merged" && t.pr).map((t) => {
    const own = runsOf.get(t.id) ?? [], done = own.filter(ran);
    const found = (findingsOf.get(t.id) ?? []).filter((f) => REVIEW_ROLES.includes(f.source));
    return { t, own, found, tokens: sum(own, tokensOf), full: done.length > 0 && done.every((r) => tokensOf(r) > 0) };
  });
  const picked = candidates.filter((c) => c.full)
    .sort((a, b) => b.found.length - a.found.length || b.tokens - a.tokens || a.t.id.localeCompare(b.t.id)).slice(0, PICK);

  const out = [
    "# Review replay: measured from the logbook",
    "",
    `Measured ${at} by scripts/review-replay.mjs, read only. Logbook rows: ${tasks.length} tasks, ${allRuns.length} runs, ${allFindings.length} findings, ${ledger.length} verdicts, ${decisions.length} decisions.`,
    "",
    `Pick rule: of the ${candidates.length} merged tasks with a PR, the ${candidates.filter((c) => c.full).length} whose done review runs all have tokens; the ${picked.length} with the most review findings (then the most review tokens).`,
    `A review role is ${REVIEW_ROLES.join(", ")}. Tokens are of done runs only. "Kept" is a finding that was not dismissed. A class is the reviewer's tag (finding add --class); "untagged" is a finding without one.`,
    "",
  ];
  const all = []; // [pick, finding] over the picked PRs, for the totals
  for (const c of picked) {
    const { t, own, found } = c;
    const rounds = [...new Set(own.map((r) => Number(r.round) || 0))].sort((a, b) => a - b);
    out.push(`## ${t.id} · PR ${t.pr} · ${t.size} · ${t.risk ? `risk ${t.risk}` : "no risk flag"} · repair rounds: ${t.round || 0}`, "");
    out.push(`${own.length} review runs · ${k(c.tokens)} tokens · round 0: ${k(sum(own.filter((r) => !(Number(r.round) > 0)), tokensOf))} · later rounds: ${k(sum(own.filter((r) => Number(r.round) > 0), tokensOf))}`, "");
    out.push(`| Role | Runs | Tokens by round | High · medium · low | Dismissed | Kept by round |`, `| --- | --- | --- | --- | --- | --- |`);
    const silent = [], noSerious = [];
    for (const role of REVIEW_ROLES) {
      const rr = own.filter((r) => r.role === role), ff = found.filter((f) => f.source === role);
      if (!rr.length && !ff.length) continue;
      const byRound = rounds.map((n) => `r${n} ${k(sum(rr.filter((r) => (Number(r.round) || 0) === n), tokensOf))}`).join(" · ");
      const keptRounds = [...new Set(ff.filter(kept).map((f) => Number(f.round) || 0))].sort((a, b) => a - b)
        .map((n) => `r${n} ${ff.filter((f) => kept(f) && (Number(f.round) || 0) === n).length}`).join(" · ") || "none";
      out.push(`| ${role} | ${rr.length} | ${byRound} | ${SEVERITIES.map((s) => ff.filter((f) => f.severity === s).length).join(" · ")} | ${ff.filter((f) => !kept(f)).length} | ${keptRounds} |`);
      if (!rr.some(ran)) continue; // a role whose runs all failed did not look
      if (!ff.some(kept)) silent.push(role);
      else if (!ff.some(serious)) noSerious.push(role);
    }
    out.push("", `Found nothing kept: ${silent.join(", ") || "none"}. Found only low: ${noSerious.join(", ") || "none"}.`);
    const others = (findingsOf.get(t.id) ?? []).filter((f) => !REVIEW_ROLES.includes(f.source));
    if (others.length) out.push(`Findings from other roles (not counted): ${others.length}.`);
    out.push("", "Each medium or high finding that was kept:", "");
    for (const f of found.filter(serious)) {
      const run = runOf(f), marks = [];
      if (Number(f.round) > 0) marks.push(`after round 0`);
      if (again.has(`${t.id}\t${f.key}`)) marks.push("opened again");
      out.push(`- ${f.key} · ${f.severity} · ${f.source} · round ${Number(f.round) || 0} · ${classOf(f)} · run ${run ? `${run.id}${run.how === "key" ? " (from key)" : ""}` : "unknown"}${marks.length ? ` · ${marks.join(", ")}` : ""}: ${one(f.summary).slice(0, 90)}`);
    }
    if (!found.some(serious)) out.push("- none");
    const later = namedBy(t.id), gone = moved.get(t.id) ?? [];
    out.push("", `Moved to a follow-up task: ${gone.length ? gone.map((m) => { const f = movedRow.get(`${t.id}\t${m.key}`); return `${m.key} to ${m.to} as ${m.as}${f ? ` (${f.severity}, ${f.source})` : ""}`; }).join(", ") : "none"}.`);
    out.push(`Findings of other tasks whose summary names ${t.id}: ${later.length ? later.map((f) => `${f.task} ${f.key} (${f.severity})`).join(", ") : "none"}.`, "");
    for (const f of found) all.push([c, f]);
  }

  // The totals over the picked PRs.
  const pickedRuns = picked.flatMap((c) => c.own), total = sum(pickedRuns, tokensOf);
  out.push("## Totals over the picked PRs", "", "| Role | PRs | Runs | Tokens | Kept | Medium or high kept | Kept per M tokens | Medium or high per M tokens | PRs where it found nothing kept | PRs with no medium or high kept | Clean verdicts |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  let pairs = 0, silentPairs = 0, lowPairs = 0;
  for (const role of REVIEW_ROLES) {
    const rr = pickedRuns.filter((r) => r.role === role), ff = all.filter(([, f]) => f.source === role).map(([, f]) => f);
    const prs = picked.filter((c) => c.own.some((r) => r.role === role && ran(r)));
    const silent = prs.filter((c) => !c.found.some((f) => f.source === role && kept(f))).length;
    const low = prs.filter((c) => !c.found.some((f) => f.source === role && serious(f))).length;
    const verdicts = rr.map((r) => verdictOf.get(r.id)).filter(Boolean);
    pairs += prs.length; silentPairs += silent; lowPairs += low;
    const tk = sum(rr, tokensOf);
    out.push(`| ${role} | ${prs.length} | ${rr.length} | ${k(tk)} | ${ff.filter(kept).length} | ${ff.filter(serious).length} | ${perM(ff.filter(kept).length, tk)} | ${perM(ff.filter(serious).length, tk)} | ${silent} of ${prs.length} | ${low} of ${prs.length} | ${verdicts.filter((v) => CLEAN.test(v)).length} of ${verdicts.length} |`);
  }
  out.push(`| all | ${picked.length} | ${pickedRuns.length} | ${k(total)} | ${all.filter(([, f]) => kept(f)).length} | ${all.filter(([, f]) => serious(f)).length} | ${perM(all.filter(([, f]) => kept(f)).length, total)} | ${perM(all.filter(([, f]) => serious(f)).length, total)} | ${silentPairs} of ${pairs} (${pct(silentPairs, pairs)}) | ${lowPairs} of ${pairs} (${pct(lowPairs, pairs)}) | |`, "");

  const classes = [...FINDING_CLASSES, "untagged"].filter((c) => all.some(([, f]) => serious(f) && classOf(f) === c));
  out.push("Medium or high kept, by class and role (per M tokens: of all review tokens of the picked PRs):", "", `| Class | ${REVIEW_ROLES.join(" | ")} | All | Per M tokens |`, `| --- | ${REVIEW_ROLES.map(() => "---").join(" | ")} | --- | --- |`);
  for (const cls of classes) {
    const ff = all.filter(([, f]) => serious(f) && classOf(f) === cls).map(([, f]) => f);
    out.push(`| ${cls} | ${REVIEW_ROLES.map((r) => ff.filter((f) => f.source === r).length).join(" | ")} | ${ff.length} | ${perM(ff.length, total)} |`);
  }
  const maxRound = Math.max(0, ...pickedRuns.map((r) => Number(r.round) || 0));
  out.push("", "Tokens and findings by round:", "", "| Round | Runs | Tokens | Share of tokens | Medium or high kept | Medium or high per M tokens |", "| --- | --- | --- | --- | --- | --- |");
  for (let n = 0; n <= maxRound; n++) {
    const rr = pickedRuns.filter((r) => (Number(r.round) || 0) === n);
    const found = all.filter(([, f]) => serious(f) && (Number(f.round) || 0) === n).length, tk = sum(rr, tokensOf);
    out.push(`| ${n} | ${rr.length} | ${k(tk)} | ${pct(tk, total)} | ${found} | ${perM(found, tk)} |`);
  }
  const ser = all.filter(([, f]) => serious(f));
  out.push("", `Medium or high kept: ${ser.length}. After round 0: ${ser.filter(([, f]) => Number(f.round) > 0).length}. Opened again after a fix: ${ser.filter(([c, f]) => again.has(`${c.t.id}\t${f.key}`)).length}. Moved to a follow-up task (any severity): ${sum(picked, (c) => (moved.get(c.t.id) ?? []).length)}. Findings of other tasks that name a picked task: ${sum(picked, (c) => namedBy(c.t.id).length)}.`, "");

  // What the data cannot tell, with the counts behind each gap.
  const reviewFindings = allFindings.filter((f) => REVIEW_ROLES.includes(f.source));
  const doneRuns = runs.filter(ran);
  const linked = all.filter(([, f]) => runOf(f));
  out.push("## Data gaps", "",
    `- Run: ${reviewFindings.filter((f) => f.run).length} of ${reviewFindings.length} review findings in the logbook name their run (finding add --run). Of the ${all.length} review findings of the picked PRs: run cell ${linked.filter(([, f]) => runOf(f).how === "cell").length}, run from the key ${linked.filter(([, f]) => runOf(f).how === "key").length}, no known run ${all.length - linked.length}.`,
    `- Class: ${reviewFindings.filter((f) => f.class).length} of ${reviewFindings.length} review findings in the logbook have a class tag (finding add --class); the class table counts the others as untagged.`,
    `- Tokens: ${doneRuns.filter((r) => !tokensOf(r)).length} of ${doneRuns.length} done review runs in the logbook have no token count; the pick leaves out every PR with such a run, so the pick favours later PRs.`,
    `- A finding's round is the task's repair round when the finding was recorded. "After round 0" says that the round-0 reviews did not report it; the logbook cannot tell whether the problem was in the round-0 code or came with a repair.`,
    `- The logbook does not record a problem that shipped after a merge. A later finding that names the task is a proxy from the summary text, and a task id can also name a test case.`,
    `- Moves: ${movedRow.size} findings in the logbook moved to a follow-up task. Each counts once, as kept, on the task and key where a review found it (from the move's decision), and not on the follow-up task. Its round is the round of the run that its old key names, else round 1, because a move is for a finding of a repair round.`,
    `- Bounds: a finding that is added again with its key and an unchanged summary takes the new round and leaves no decision. So "after round 0" is an upper bound and "opened again after a fix" is a lower bound.`,
    `- Rows: ${sum(Object.values(ragged), (n) => n)} of ${tasks.length + allRuns.length + rows.length + ledger.length + decisions.length} rows of the five tables it reads have a cell count that differs from their header${Object.keys(ragged).length ? ` (${Object.entries(ragged).map(([n, c]) => `${n} ${c}`).join(", ")})` : ""}; a missing cell reads as empty.`,
    `- This counts past runs only. It cannot tell what a different set of reviews would have found: that needs reviews re-run on the past commits (design v2, R1).`,
    "");
  return out.join("\n");
}

if (isMain(import.meta.url)) {
  const [dir, flag, file, ...rest] = process.argv.slice(2);
  if (!dir || (flag && flag !== "--out") || (flag && !file) || rest.length) {
    console.error("usage: node scripts/review-replay.mjs <logbook folder> [--out <file>]");
    process.exit(2);
  }
  try {
    const report = replay(dir);
    if (file) writeOutside(dir, file, report);
    else process.stdout.write(report);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    console.error(`review-replay: ${e.path} does not exist.`);
    process.exit(2);
  }
}

/**
 * Writes the report to `file`, never into the logbook folder `dir`: it is only read. The check compares device and
 * inode, not path text, so a link, a hard link or another letter case of a logbook path is refused too.
 */
function writeOutside(dir, file, report) {
  const refuse = (why) => { console.error(`refused: --out ${file} ${why}`); process.exit(2); };
  const id = (s) => `${s.dev}:${s.ino}`, book = new Set();
  const walk = (d) => {
    book.add(id(statSync(d)));
    for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : book.add(id(lstatSync(join(d, e.name))));
  };
  walk(dir);
  const target = resolve(file), at = lstatSync(target, { throwIfNoEntry: false });
  if (at?.isSymbolicLink()) refuse("is a link: give a plain file outside the logbook folder.");
  if (book.has(id(statSync(dirname(target)))) || (at && book.has(id(at)))) refuse("is in the logbook folder, which this script only reads.");
  const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o644);
  try { writeFileSync(fd, report); } finally { closeSync(fd); }
}
