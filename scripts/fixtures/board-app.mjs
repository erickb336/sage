import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TABLES } from "../../packages/sage-core/logbook-fields.mjs";

const HOUR = 3_600_000;
const breakdown = (id, name, pilot) => [`Approve milestone ${id}? No task builds before you approve.`, `Name: ${name}`, "Goal: Sample goal.", "Pilot, runs first:", `  ${pilot}: Sample ${pilot}`].join(" ");

export function appTables(now) {
  const at = hours => new Date(Date.parse(now) - hours * HOUR).toISOString();
  const task = (id, title, state, extra = {}) => ({ id, title, size: "small", risk: "", route: "build,code-review,qa", state, branch: "", pr: "", round: "0", keys: "", hold: "", extra: "", priority: "", kind: "", waits: "", milestone: "", adoption: "", approvals: "", ...extra });
  const run = (id, on, role, status, started, ended = "") => ({ id, task: on, role, round: "0", candidate: "", branch: "", status, tokens: "", report: "", started: at(started), ended: ended === "" ? "" : at(ended) });
  const gate = (id, on, question, options, recommendation, answer, asked) => ({ id, task: on, question, options, recommendation, default: "", answer, at: at(asked) });
  return {
    tasks: [
      task("T1", "Sample pinned bundle", "merged", { milestone: "M1", priority: "P1" }),
      task("T2", "Sample chief records", "building", { milestone: "M1", priority: "P1" }),
      task("T3", "Sample shared limits", "reviewing", { milestone: "M1", priority: "P2", pr: "12" }),
      task("T4", "Sample queue", "framed", { milestone: "M1", priority: "P2", waits: "T2" }),
      task("T10", "Sample sync design", "awaiting-you", { milestone: "M2", priority: "P0" }),
      task("T11", "Sample sync build", "framed", { milestone: "M2", priority: "P0", waits: "T10" }),
      task("T20", "Sample sign-in screen", "merged", { milestone: "M3", priority: "P1" }),
      task("T21", "Sample passkeys", "merged", { milestone: "M3", priority: "P1" }),
      task("T30", "Sample crash reports", "awaiting-you", { priority: "P2" }),
    ],
    runs: [run("R1", "T2", "implementer", "failed", 3, 1), run("R2", "T3", "code-reviewer", "running", 0.5)],
    gates: [
      gate("G1", "T1", breakdown("M1", "Board redesign", "T1"), "approve|change|drop", "approve", "approve", 72),
      gate("G2", "T10", breakdown("M2", "Offline sync", "T10"), "approve|change|drop", "approve", "approve", 70),
      gate("G3", "T20", breakdown("M3", "Sign-in rework", "T20"), "approve|change|drop", "approve", "approve", 96),
      gate("G4", "T10", "Can a viewer copy a shared list into their own lists?", "A: yes, as a new private list|B: no", "A: yes, as a new private list", "", 3),
      gate("G5", "T30", "Crash reports: send them on their own, or ask each time?", "A: ask each time|B: send them", "A: ask each time", "", 0.7),
    ],
    decisions: [
      { at: at(2), task: "T1", decision: "state merged", why: "sample" },
      { at: at(50), task: "T20", decision: "state merged", why: "sample" },
      { at: at(30), task: "T21", decision: "state merged", why: "sample" },
      { at: at(1), task: "T30", decision: "added crash report question", why: "sample" },
    ],
    milestones: [
      { id: "M1", name: "Board redesign", goal: "One board for every chief", pilot: "T1", gate: "G1", at: at(72) },
      { id: "M2", name: "Offline sync", goal: "Edits made offline reach the server safely", pilot: "T10", gate: "G2", at: at(70) },
      { id: "M3", name: "Sign-in rework", goal: "Passkeys and clearer session messages", pilot: "T20", gate: "G3", at: at(96) },
    ],
    findings: [],
    ledger: [],
  };
}

export function writeAppLogbook(root, now) {
  const project = join(root, "sample-app-abc123");
  mkdirSync(project, { recursive: true });
  for (const [name, rows] of Object.entries(appTables(now))) {
    const columns = TABLES[name];
    writeFileSync(join(project, `${name}.tsv`), [columns.join("\t"), ...rows.map(row => columns.map(column => row[column] ?? "").join("\t"))].join("\n") + "\n");
  }
  return project;
}

const HEAD = "b".repeat(40);
const HOSTILE = { title: `<img src=x onerror="window.hacked=1">Hostile "quotes" & 'apostrophes'`, path: "<script>window.hacked=3</script>\nsrc/evil\u202egnp\u009b.js", invisible: "src/a\u061cb\u2060c\u00add\u180ee\u{e0001}f.js", link: `<a href="javascript:window.hacked=5">click</a>` };
export const HOSTILE_TEXT = HOSTILE;

const REPOSITORY = "https://github.com/sample-owner/sample-app";
function addPullRequests(tables, records, at, hostile) {
  const base = tables.tasks.find(task => task.id === "T3"), sha = letter => letter.repeat(40);
  const pr = (task, number, head, extra = {}) => records.push({ id: `O${records.length + 1}`, task, kind: "pr", source: "gh pr view", basis: "observed", observedAt: at(1), recordedAt: at(1), data: { repository: REPOSITORY, number, state: "open", head, ...extra } });
  const verdicts = (task, number, head, kinds) => tables.ledger.push(...kinds.map(([kind, run = ""], i) => ({ task, pr: number, sha: head, kind, cycle: "1", run, at: at(3 - i * 0.1) })));
  tables.tasks.push(
    { ...base, id: "T5", title: "Sample retry backoff", state: "verified", milestone: "M1", priority: "P1", kind: "", chief: "C1", branch: "sage/t5-retry", pr: "14" },
    { ...base, id: "T6", title: "Sample sync log", state: "reviewing", milestone: "M1", priority: "P2", kind: "", chief: "C1", branch: "sage/t6-log", pr: "15", waits: "T5" },
    { ...base, id: "T7", title: "Sample offline banner", state: "repairing", milestone: "M1", priority: "P2", kind: "", chief: "C2", branch: "sage/t7-banner", pr: "16", round: "1" },
    { ...base, id: "T8", title: "Sample search highlight", state: "reviewing", milestone: "", priority: "P1", kind: "", chief: "C1", branch: "sage/t8-search", pr: "17" },
    { ...base, id: "T9", title: "Sample conflict rule", state: "merged", milestone: "M1", priority: "P1", kind: "", chief: "C1", branch: "sage/t9-rule", pr: "11" },
    { ...base, id: "T12", title: "Sample old merge", state: "merged", milestone: "", priority: "P3", kind: "", chief: "C1", branch: "sage/t12-old", pr: "9" },
    { ...base, id: "T13", title: "Sample sync export", state: "framed", milestone: "M1", priority: "P3", kind: "", chief: "C1", branch: "", pr: "", waits: "T6" },
  );
  tables.runs.push({ id: "R8", task: "T5", role: "code-reviewer", round: "0", status: "done", started: at(4), ended: at(3.5), chief: "C1" }, { id: "R9", task: "T5", role: "qa", round: "0", status: "done", started: at(3.4), ended: at(3.1), chief: "C1" });
  verdicts("T5", "14", sha("e"), [["checks-pass"], ["review-clean", "R8"], ["qa-pass", "R9"]]);
  verdicts("T8", "17", sha("f"), [["checks-fail"]]);
  verdicts("T9", "11", sha("9"), [["checks-pass"], ["review-clean"], ["qa-pass"]]);
  pr("T5", 14, sha("e")); pr("T6", 15, sha("6")); pr("T8", 17, sha("f")); pr("T9", 11, sha("9"), { state: "merged" });
  records.push({ id: `O${records.length + 1}`, task: "T8", kind: "files", source: "git diff", basis: "observed", observedAt: at(2), recordedAt: at(2), data: { head: sha("f"), paths: ["src/shared.js"], truncated: false } });
  records.push({ id: `O${records.length + 1}`, task: "T5", kind: "mode", source: "chief", basis: "reported", observedAt: at(1), recordedAt: at(1), data: { session: "sample-session", autopilot: true } });
  tables.decisions.push({ at: at(5), task: "T9", decision: "state merged", why: "sample" }, { at: at(24 * 9), task: "T12", decision: "state merged", why: "sample" });
  if (hostile) {
    tables.tasks = tables.tasks.map(task => task.id === "T50" ? { ...task, pr: "51" } : task);
    tables.gates.push({ id: "G10", task: "T50", question: `<img src=x onerror="window.hacked=11">Merge <b>now</b>?`, options: "A|B", recommendation: "A", default: "", answer: "", at: at(0.2) });
  }
}

export function writeTasksLogbook(root, worktrees, now, { hostile = false, many = 0, edge = false, chiefCases = false, stuck = false, prs = false, waits = {}, crowd = 0, documents = false } = {}) {
  const at = hours => new Date(Date.parse(now) - hours * HOUR).toISOString();
  const tables = appTables(now), dir = join(root, "sample-app-abc123");
  const chiefs = { T1: "C1", T2: "C1", T3: "C2", T4: "C1", T10: "C1", T11: "C2", T20: "C1", T21: "C1", T30: "C2" };
  const kinds = { T2: "logbook", T3: "providers", T4: "orchestration", T10: "design", T30: "ui" };
  tables.tasks = tables.tasks.map(task => ({ ...task, chief: chiefs[task.id], kind: kinds[task.id] ?? "", branch: task.id === "T3" ? "sage/t3-limits" : task.branch }));
  tables.tasks.push({ ...tables.tasks[1], id: "T40", title: "Sample crash fix", state: "building", milestone: "", priority: "P1", kind: "bug-fix", chief: "C1", branch: "sage/t40-crash", waits: "" });
  tables.runs = [
    { ...tables.runs[0], chief: "C1" },
    { id: "R5", task: "T3", role: "code-reviewer", round: "0", status: "done", started: at(1.5), ended: at(1), chief: "C2" },
    { id: "R6", task: "T3", role: "qa", round: "0", status: "running", started: at(0.5), chief: "C2" },
    { id: "R7", task: "T3", role: "implementer", round: "0", status: "done", branch: "sage/t3-limits", started: at(5), ended: at(4), chief: "C2" },
  ];
  tables.ledger = [
    { task: "T3", pr: "12", sha: HEAD, kind: "checks-pass", cycle: "1", run: "", at: at(1.2) },
    { task: "T3", pr: "12", sha: HEAD, kind: "review-clean", cycle: "1", run: "R5", at: at(0.9) },
  ];
  tables.decisions.push({ at: at(6), task: "T3", decision: "state reviewing", why: "the PR is open" });
  tables.gates.push({ id: "G6", task: "T3", question: "Keep one limit for both providers?", options: "A: yes|B: no", recommendation: "A: yes", default: "", answer: "A: yes", at: at(8) });
  const records = [
    { id: "O1", task: "T3", kind: "pr", source: "gh pr view", basis: "observed", observedAt: at(1), recordedAt: at(1), data: { repository: "https://github.com/sample-owner/sample-app", number: 12, state: "open", head: HEAD } },
    { id: "O2", task: "T3", kind: "files", source: "git diff", basis: "observed", observedAt: at(2), recordedAt: at(2), data: { head: HEAD, paths: ["src/limits.js", "src/shared.js"], truncated: false } },
    { id: "O3", task: "T40", kind: "files", source: "git diff", basis: "observed", observedAt: at(2), recordedAt: at(2), data: { head: "c".repeat(40), paths: ["src/shared.js", ...(hostile ? [HOSTILE.path, HOSTILE.invisible, "javascript:window.hacked=4"] : [])], truncated: false } },
    { id: "O4", task: "T3", kind: "artifact", source: "chief", basis: "reported", observedAt: at(3), recordedAt: at(3), data: { type: "artifact", label: "Limits design note", url: "https://github.com/sample-owner/sample-app/pull/12", run: "R7" } },
  ];
  if (hostile) {
    tables.tasks.push({ ...tables.tasks[1], id: "T50", title: HOSTILE.title, state: "building", milestone: "", priority: "P0", kind: "security", chief: "C2", branch: "sage/t50-<b>bold</b>" });
    tables.decisions.push({ at: at(0.2), task: "T50", decision: `state building ${HOSTILE.link}`, why: "<i>why</i>" });
    tables.gates.push({ id: "G9", task: "T50", question: `Ship "it"? <b>now</b>`, options: "A|B", recommendation: "A", default: "", answer: `<script>window.hacked=7</script>`, at: at(0.3) });
    records.push({ id: "O5", task: "T50", kind: "files", source: "git diff", basis: "observed", observedAt: at(1), recordedAt: at(1), data: { head: "d".repeat(40), paths: [HOSTILE.path, HOSTILE.invisible, "javascript:window.hacked=4", "src/shared.js"], truncated: false } },
      { id: "O6", task: "T50", kind: "artifact", source: "chief", basis: "reported", observedAt: at(1), recordedAt: at(1), data: { type: "artifact", label: `<img src=x onerror="window.hacked=6">label`, url: "https://example.com/a?b=%22%3E%3Cscript%3E" } });
  }
  if (prs) addPullRequests(tables, records, at, hostile);
  if (documents) addDocumentRows(tables, at, join(worktrees, "sample-app-abc123", "pages"));
  tables.tasks = tables.tasks.map(task => task.id in waits ? { ...task, waits: waits[task.id] } : task);
  for (let i = 0; i < crowd; i++) {
    const id = `T${80 + i}`;
    tables.tasks.push({ ...tables.tasks.find(task => task.id === "T3"), id, title: `Sample crowded change ${i + 1}`, milestone: "", priority: "P2", kind: "", chief: `C${i + 1}`, branch: `sage/t${80 + i}-crowd`, pr: `${80 + i}` });
    records.push({ id: `O${records.length + 1}`, task: id, kind: "files", source: "git diff", basis: "observed", observedAt: at(2), recordedAt: at(2), data: { head: "a".repeat(40), paths: ["src/crowd.js"], truncated: false } });
  }
  if (chiefCases) for (const [id, title, chief] of [["T70", "Sample stopped chief", "C3"], ["T71", "Sample unlisted chief", "C9"], ["T72", "Sample task with no chief", ""]]) tables.tasks.push({ ...tables.tasks[1], id, title, state: "building", milestone: "", priority: "P3", kind: "", chief, branch: "", waits: "" });
  if (stuck) {
    tables.tasks = tables.tasks.map(task => task.id === "T20" ? { ...task, state: "abandoned" } : task);
    tables.milestones = tables.milestones.map(milestone => milestone.id === "M3" ? { ...milestone, pilot: "T20" } : milestone);
    tables.tasks.push({ ...tables.tasks.find(task => task.id === "T21"), id: "T22", state: "framed" });
  }
  if (edge) tables.tasks.push({ ...tables.tasks[1], id: "T60", title: "Sample".repeat(500), state: "building", milestone: "", priority: "P3", kind: "", chief: "C1", branch: "" });
  for (let i = 0; tables.tasks.length < many; i++) tables.tasks.push({ ...tables.tasks[0], id: `T${1000 + i}`, title: `Sample ended task ${i}`, milestone: "", state: i % 7 ? "merged" : "abandoned", chief: i % 2 ? "C1" : "C2", priority: ["P1", "P2", "P3"][i % 3] });
  mkdirSync(dir, { recursive: true });
  for (const [name, rows] of Object.entries(tables)) {
    const columns = [...TABLES[name], ...(["tasks", "runs"].includes(name) ? ["chief"] : [])];
    writeFileSync(join(dir, `${name}.tsv`), [columns.join("\t"), ...rows.map(row => columns.map(column => row[column] ?? "").join("\t"))].join("\n") + "\n");
  }
  if (prs) writeFileSync(join(root, "projects.tsv"), `logbook\tat\thow\nsample-app-abc123\t${at(100)}\tinit\n`);
  writeFileSync(join(dir, "chiefs.tsv"), `id\tprovider\tnative\tat\nC1\tclaude\tsession-a\t${at(48)}\nC2\tcodex\tsession-b\t${at(48)}\n${chiefCases ? `C3\tclaude\tsession-c\t${at(48)}\n` : ""}`);
  writeFileSync(join(dir, "observations.json"), JSON.stringify({ version: 1, records }));
  if (edge) { mkdirSync(join(dir, "live")); writeFileSync(join(dir, "live", "C1.json"), JSON.stringify({ at: at(2) })); }
  if (chiefCases) { mkdirSync(join(dir, "live"), { recursive: true }); writeFileSync(join(dir, "live", "C3.json"), JSON.stringify({ at: at(2) })); }
  mkdirSync(join(dir, "kept"), { recursive: true });
  writeFileSync(join(dir, "kept", "R5.json"), JSON.stringify({ task: "T3", run: "R5", role: "code-reviewer", sha: HEAD, text: `STATUS        done\nRESULT        CLEAN. The limits change is correct.${hostile ? " <img src=x onerror=window.hacked=8>" : ""}\nEVIDENCE      ran the tests\n`, at: at(1) }));
  writeFileSync(join(dir, "kept", "R7.json"), JSON.stringify({ task: "T2", run: "R7", role: "implementer", sha: "", text: "STATUS done\nRESULT a report that names another task", at: at(1) }));
  mkdirSync(join(dir, "briefs"), { recursive: true });
  writeFileSync(join(dir, "briefs", "sage_qa_t3_r6.json"), JSON.stringify({ task: "sage_qa_t3_r6", text: "Run R6 · task T3" }));
  writeFileSync(join(dir, "briefs", "sage_qa_t30_r60.json"), JSON.stringify({ task: "sage_qa_t30_r60", text: "Run R60 · task T30" }));
  if (hostile) writeFileSync(join(dir, "briefs", `sage_x_t50_r9 <img src=x onerror=window.hacked=9>.json`), "{}");
  const pages = join(worktrees, "sample-app-abc123", "pages", "T3");
  mkdirSync(pages, { recursive: true });
  writeFileSync(join(pages, "limits-design.html"), "<!doctype html><title>Limits</title><p>Sample page.</p>\n");
  writeFileSync(join(pages, "notes.md"), "# Notes\n\nSample notes.\n");
  if (documents) writeDocumentFiles(dir, join(worktrees, "sample-app-abc123", "pages"), at, hostile);
  return dir;
}

const sketch = (title, rows, accent) => `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="240" viewBox="0 0 360 240"><rect width="360" height="240" rx="14" fill="#17171b"/><rect x="20" y="18" width="150" height="14" rx="7" fill="#3a3a44"/><text x="20" y="62" fill="#ededf0" font-family="sans-serif" font-size="15">${title}</text>${rows.map((row, i) => `<rect x="20" y="${80 + i * 34}" width="320" height="26" rx="6" fill="#222228"/><text x="32" y="${98 + i * 34}" fill="#a3a3ad" font-family="sans-serif" font-size="12">${row}</text>`).join("")}<rect x="250" y="200" width="90" height="26" rx="8" fill="${accent}"/></svg>\n`;
export const DOCUMENT_PAGE = "retry-design.md";
export const HOSTILE_MARKDOWN = ["# Hostile sample", "", "<script>window.hacked=1</script>", "", "<img src=x onerror=\"window.hacked=2\">", "",
  "[run it](javascript:window.hacked=3) [up](../../../../etc/passwd) [to the api](/api/answer) [other host](//evil.invalid/x) [data](data:text/html,<b>x</b>)", "",
  "![outside](https://evil.invalid/x.png) ![traversal](../T10/designs/A/screen.svg) ![data picture](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)", "",
  "Right-to-left: abc\u202edcba and isolate \u2066x\u2069 end.", "", "<form action=\"/api/answer\" method=\"post\"><button>go</button></form>", "", "<iframe src=\"/app/\"></iframe>", "",
  "[a safe page](notes.md) and [a safe site](https://example.com/docs).", ""].join("\n");

function addDocumentRows(tables, at, pagesRoot) {
  tables.runs = tables.runs.map(run => ({ ...run, model: run.id === "R5" ? "opus" : run.id === "R7" ? "sonnet" : "" }));
  tables.runs.push({ id: "R8", task: "T10", role: "designer", round: "0", status: "done", started: at(30), ended: at(29), chief: "C1", model: "opus" },
    { id: "R9", task: "T10", role: "arena-judge", round: "0", status: "done", started: at(26), ended: at(25), chief: "C1", model: "opus" });
  tables.runs.push({ id: "R4", task: "T3", role: "code-reviewer", round: "0", status: "done", started: at(3), ended: at(2.5), chief: "C2" });
  tables.findings.push({ task: "T3", key: "F1", round: "0", source: "code-reviewer", severity: "medium", summary: "An older finding of R4 with the key F1.", triage: "fix", reason: "", status: "closed", run: "R4", class: "other" },
    { task: "T3", key: "F-T3-1", round: "0", source: "code-reviewer", severity: "medium", summary: "revoked-limit-applies-10-min", triage: "fix", reason: "", status: "open", run: "R5", class: "state-edge" },
    { task: "T3", key: "F-T3-2", round: "0", source: "code-reviewer", severity: "low", summary: "limit-field-no-label", triage: "follow-up", reason: "", status: "follow-up", run: "R5", class: "copy" });
  tables.decisions.push({ at: at(7), task: "T3", decision: `page ${pagesRoot}/T3/gone-plan.md sha256 ${"ab".repeat(32)}`, why: "the chief recorded a page" },
    { at: at(6.5), task: "T3", decision: `page ${pagesRoot}/T3/notes.md sha256 ${"cd".repeat(32)}`, why: "the chief recorded a page" });
  tables.gates.push({ id: "G7", task: "T10", question: "Which design for the share sheet?", options: "v2|v1", recommendation: "v2", default: "", answer: "v2", at: at(28) },
    { id: "G12", task: "T10", question: "Base the unsynced count on candidate A or B?", options: "A|B", recommendation: "A", default: "", answer: "A", at: at(24) });
}

function writeDocumentFiles(dir, pagesRoot, at, hostile) {
  const hostileLine = hostile ? "\n- Hostile text: <script>window.hacked=11</script> \u202eevil\n" : "";
  mkdirSync(join(dir, "reports"), { recursive: true });
  mkdirSync(join(dir, "gates"), { recursive: true });
  writeFileSync(join(dir, "briefs", "R7.md"), `Run R7 · task T3 (implementer)

GOAL        Keep one agent limit for both providers, so that a Codex chief and a Claude chief share it.

SCOPE       Task T3 only. Branch sage/t3-limits, in your own worktree.
            - Change the limit reader.
            - Keep the old keys readable.

CONTEXT     The limits are read from each provider root today.${hostileLine}

DECISIONS   Owner, gate G6: one limit for both providers.

ACCEPTANCE  - The board shows one limit.
            - npm run check passes.
            - The two changed test files pass, each run alone.

VERIFY      npm run build, npm run check and the changed test files.

BUDGET      45 minutes of agent time and 200 k tokens.

FORBIDDEN   No merge, no force-push, no push to main.

REPORT      The report of the sage:report skill.

STANDING    Read the standing orders first.
`);
  writeFileSync(join(dir, "reports", "R5.md"), `STATUS        done
RESULT        FINDINGS · 1 medium, 1 low
              The limit change works and its tests pass. One medium finding blocks the cycle.${hostile ? " <img src=x onerror=window.hacked=12>" : ""}
EVIDENCE      - npm test -- scripts/limits.test.mjs: 14 pass
              - npm run check: pass
FINDINGS
- F1 medium A revoked limit still applies for 10 minutes.
    src/limits.js:42
    proof: npm test -- scripts/limits-probe.test.mjs
    saw: the limit 5 after revoke
- F2 low The limit field has no label.
    src/limits-view.js:88
QUESTIONS     none
NOT VERIFIED  - A Codex chief on another Mac.
              - A limit of 0.
BRANCH        sage/t3-limits, head ${"b".repeat(40)}, PR 12
`);
  writeFileSync(join(dir, "gates", "G4.json"), JSON.stringify({ gate: "G4", task: "T10", at: at(3), message: { kind: "question", title: "Can a viewer copy a shared list into their own lists?", blocks: [
    { t: "field", label: "Where this is", text: "Milestone Offline sync · task T10 · step Plan. The share sheet design (v2) is approved." },
    { t: "field", label: "What you approve", text: "The rule for viewers. It goes into the permission table of the design and into the tests." },
    { t: "field", label: "The one real choice in it", text: "Does a viewer get a \"Copy to my lists\" action?" },
    { t: "table", head: ["Answer", "What happens next", "Cost"], rows: [["B: no", "C1 builds now with view only.", "No extra cost now."], ["A: yes, as a new private list", "C1 adds \"Copy to my lists\" and builds after T3 merges.", "About 1 to 2 h more agent time. Basis: the build of T3."]], pick: 1 },
    { t: "field", label: "If you do not answer", text: "C1 takes A at 20:00 today." },
    { t: "field", label: "Needed by", text: "20:00 today, so that T11 can build tonight." },
    { t: "field", label: "After you answer", text: hostile ? "C1 records it. <script>window.hacked=13</script> \u202eevil" : "C1 records your answer and starts T11." },
    { t: "page", title: "Design notes of v2", task: "T10", file: "designs/v2/notes.md" }] }, text: "QUESTION" }));
  const pages = join(pagesRoot, "T3"), design = join(pagesRoot, "T10");
  writeFileSync(join(pages, DOCUMENT_PAGE), `# Retry with backoff\n\nThe design for retries after a reconnect.\n\n## The rule\n\n| Try | Wait |\n| --- | --- |\n| 1 | 1 s |\n| 2 | 4 s |\n\n![The retry screen](retry.svg)\n\n## The code\n\n\`\`\`js\nretry({ times: 5 });\n\`\`\`\n\nSee [the notes](notes.md).\n`);
  writeFileSync(join(pages, "retry.svg"), sketch("Retry with backoff", ["Try 1 · 1 s", "Try 2 · 4 s", "Try 3 · 16 s"], "#9aa2ff"));
  writeFileSync(join(pages, "hostile.md"), HOSTILE_MARKDOWN);
  const version = (name, meta, shots) => {
    mkdirSync(join(design, "designs", name), { recursive: true });
    writeFileSync(join(design, "designs", name, "version.json"), JSON.stringify(meta));
    writeFileSync(join(design, "designs", name, "index.html"), `<!doctype html><title>${name}</title><p>Sample prototype ${name}.</p>\n`);
    writeFileSync(join(design, "designs", name, "notes.md"), `# Notes of ${name}\n\nSample design notes.\n`);
    for (const [file, title, rows, accent] of shots) writeFileSync(join(design, "designs", name, file), sketch(title, rows, accent));
  };
  version("v1", { title: "v1", about: "A sheet from the bottom, with the link at once.", at: at(30), run: "R8", gates: ["G7"] }, [["sheet.svg", "Share list", ["list.example/L-77", "Anyone with the link · view"], "#ededf0"]]);
  version("v2", { title: "v2", about: "Create link first; then the link, the permission row and Revoke.", at: at(28), run: "R8", today: true, screenshots: [{ file: "first.svg", caption: "Before a link exists" }, { file: "after.svg", caption: "After Create link" }] },
    [["first.svg", "Share list", ["No link yet. Only you see this list."], "#ededf0"], ["after.svg", "Share list", ["list.example/L-77", "Anyone with the link · view", "Expires in 7 days"], "#fb7f7f"]]);
  version("A", { title: "Candidate A", candidate: "A", run: "R8", angle: "Precision: a count on each list", strong: "People see which list holds unsent edits.", weak: "Many badges when many lists have edits." }, [["screen.svg", "Lists", ["Groceries · 3", "Work · 1", "Trip · 12"], "#fbbf24"]]);
  version("B", { title: "Candidate B", candidate: "B", run: "R8", angle: "Calm: one total in the header", strong: "One place, little noise.", weak: "It does not say which list waits." }, [["screen.svg", "Lists · 16 unsent", ["Groceries", "Work", "Trip"], "#fbbf24"]]);
  version("final", { title: "The judge's final", run: "R9", at: at(25), final: { base: "A", why: "It scored highest and fits the brief best.", grafted: [], grafts: ["From B: the total in the tooltip."], unused: ["B's header total: it hides which list waits."], gate: "G12",
    scores: { rubric: ["Fits the brief", "Clear at a glance", "Every state", "Access", "Cost to build"], max: 5, candidates: { A: [5, 4, 4, 4, 4], B: [3, 4, 3, 4, 3] } } } }, [["screen.svg", "Lists", ["Groceries · 3", "Work · 1 · 3 edits not sent", "Trip · 12"], "#4ade80"]]);
}
