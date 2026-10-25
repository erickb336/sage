// The offline replay of past PRs (T485, step 1 of T344): it reads one logbook folder and prints, for the 10 merged PRs
// with the most review data, which roles ran, their tokens per round, their findings by severity, class and round, and
// which findings came later than round 0 or in a later task; then the totals per role and class. It only measures: it
// reads tasks, runs, findings, ledger and decisions, and it never writes the logbook.
//
//   node scripts/review-replay.mjs <logbook folder> [--out <file>]
//
// Without --out it prints the report. --out never names a file in the logbook folder.
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { FINDING_CLASSES } from "../packages/sage-core/logbook-fields.mjs";
import { REVIEW_ROLES } from "../packages/sage-core/review.mjs";
import { isMain } from "./is-main.mjs";

const PICK = 10;
const SEVERITIES = ["high", "medium", "low"];
const CLEAN = /-clean$|^qa-pass$/;

/** The rows of one table of the logbook, as objects by its header. */
function table(dir, name) {
  const [head = "", ...lines] = readFileSync(resolve(dir, `${name}.tsv`), "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const cols = head.split("\t");
  return lines.map((line) => { const v = line.split("\t"); return Object.fromEntries(cols.map((c, i) => [c, v[i] ?? ""])); });
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
  const tasks = table(dir, "tasks"), allRuns = table(dir, "runs"), allFindings = table(dir, "findings");
  const ledger = table(dir, "ledger"), decisions = table(dir, "decisions");
  const runById = new Map(allRuns.map((r) => [r.id, r]));
  const runs = allRuns.filter((r) => REVIEW_ROLES.includes(r.role));
  const byTask = (rows) => rows.reduce((m, r) => (m.get(r.task)?.push(r) ?? m.set(r.task, [r]), m), new Map());
  const runsOf = byTask(runs), findingsOf = byTask(allFindings);
  const verdictOf = new Map(ledger.filter((l) => l.run && !l.kind.startsWith("checks-")).map((l) => [l.run, l.kind]));

  // The run of a finding: its run cell, else the run that its key names (R12-3 or F-R12-3), when that run is of its task.
  const runOf = (f) => {
    const id = f.run || /^(?:F-)?(R\d+)-/.exec(f.key)?.[1];
    return id && runById.get(id)?.task === f.task ? { id, how: f.run ? "cell" : "key" } : undefined;
  };
  const classOf = (f) => f.class || "untagged";
  // A finding that came back after a fix ("<key> opened again"), and one moved to a follow-up task ("<key> moved to T9
  // as F-T9-1: …"): a moved finding's row now holds the new task and key, so its old task keeps only the decision.
  const again = new Set(), moved = new Map();
  const findingAt = new Map(allFindings.map((f) => [`${f.task}\t${f.key}`, f]));
  for (const d of decisions) {
    const m = /^(\S+) (?:opened again|moved to (T\d+) as (\S+):)/.exec(d.decision);
    if (m?.[2]) (moved.get(d.task) ?? moved.set(d.task, []).get(d.task)).push({ key: m[1], to: m[2], as: m[3], now: findingAt.get(`${m[2]}\t${m[3]}`) });
    else if (m) again.add(`${d.task}\t${m[1]}`);
  }
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
    out.push("", `Moved to a follow-up task: ${gone.length ? gone.map((m) => `${m.key} to ${m.to} as ${m.as}${m.now ? ` (${m.now.severity})` : ""}`).join(", ") : "none"}.`);
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
  const report = replay(dir);
  if (!file) process.stdout.write(report);
  else {
    // The report never goes into the logbook folder: it is only read.
    const book = realpathSync(dir), into = realpathSync(dirname(resolve(file)));
    if (into === book || into.startsWith(book + sep)) {
      console.error(`refused: --out ${file} is in the logbook folder, which this script only reads.`);
      process.exit(2);
    }
    writeFileSync(file, report);
  }
}
