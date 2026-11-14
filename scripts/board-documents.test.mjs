import "./test-env.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { readBoardSources } from "../packages/sage-core/board-reader.mjs";
import { readReport } from "../packages/sage-core/index.mjs";
import { renderMarkdown } from "../packages/sage-board/markdown.mjs";
import { readerPage, readerUrl } from "../packages/sage-board/reader.mjs";
import { createBoardServer, loadBoardApp } from "../packages/sage-board/server.mjs";
import { writeTasksLogbook } from "./fixtures/board-app.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = "2026-11-13T12:00:00.000Z";
const KEY = id => `shared/sample-app-abc123/${id}`;
const ORIGIN = "http://127.0.0.1:5000";
const FORMAT = /\p{Cf}/u;

function world(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-documents-")), before = process.env.SAGE_WORKTREES;
  process.env.SAGE_WORKTREES = join(dir, "worktrees");
  t.after(() => { if (before === undefined) delete process.env.SAGE_WORKTREES; else process.env.SAGE_WORKTREES = before; rmSync(dir, { recursive: true, force: true }); });
  const logbook = writeTasksLogbook(join(dir, "logbooks"), join(dir, "worktrees"), NOW, { documents: true, ...options });
  const sources = [{ id: "shared", path: join(dir, "logbooks"), label: "Shared" }];
  const model = () => buildBoardModel(readBoardSources(sources, { now: Date.parse(NOW) }), { now: NOW });
  return { dir, logbook, pages: join(dir, "worktrees", "sample-app-abc123", "pages"), sources, model };
}
function read(w, task, kind, arg = null, view = {}, model = w.model()) {
  const page = readerPage({ model, configured: w.sources, url: readerUrl(KEY(task), kind, arg, view), origin: ORIGIN, render: renderMarkdown });
  return page && { ...page, html: page.top + page.rest, text: (page.top + page.rest).replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ") };
}
const findingRowsOrRawHtml = html => [...(/<span class="fname">FINDINGS<\/span>[\s\S]*?<div class="body">([\s\S]*?)<\/div><\/details>/.exec(html)?.[1] ?? "").matchAll(/<div class="finding">([\s\S]*?)<\/div>/g)]
  .map(([, row]) => /^<span><span class="pill (high|medium|low)">\1<\/span><\/span><span class="mono">([^<]+)<\/span><span>([^<]*)<\/span>(?:<span class="det">([^<]*)<\/span>)?$/.exec(row)?.slice(1) ?? row);
const fieldsOpen = html => [...html.matchAll(/<details( open)?><summary><span class="fname">([A-Z ]+)<\/span>/g)].map(match => `${match[2]}${match[1] ? " open" : ""}`);

test("T1064: a brief shows its ten fields in order, GOAL and ACCEPTANCE open, a closed field with its first line; Open all and Close all open and close every field", t => {
  const w = world(t);
  const page = read(w, "T3", "brief", "R7");
  assert.deepEqual(fieldsOpen(page.html), ["GOAL open", "SCOPE", "CONTEXT", "DECISIONS", "ACCEPTANCE open", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"]);
  assert.match(page.html, /<span class="fname">SCOPE<\/span><span class="first">Task T3 only\. Branch sage\/t3-limits, in your own worktree\. <span class="faint">\(\+2\)<\/span>/, "a closed field shows its first line and how many lines follow");
  assert.match(page.html, /<ul>\n<li>Change the limit reader\.<\/li>\n<li>Keep the old keys readable\.<\/li>/, "the field's list renders as a list, without the column indent");
  assert.match(page.text, /Run R7 Role implementer Task T3 Chief C2 · Codex Model sonnet Started/);
  assert.match(page.html, /href="\/read\/[\w-]+\/report\/R7">Report of R7<\/a>/, "a link to the run's report");
  assert.match(page.html, /<a class="back" href="\/app\/#tasks\?task=shared%2Fsample-app-abc123%2FT3">&#8592; Back to T3<\/a>/);
  assert.ok(fieldsOpen(read(w, "T3", "brief", "R7", { open: "all" }).html).every(name => name.endsWith(" open")));
  assert.ok(fieldsOpen(read(w, "T3", "brief", "R7", { open: "none" }).html).every(name => !name.endsWith(" open")));
  assert.match(read(w, "T3", "brief", "R7", { back: "pull-requests" }).html, /href="\/app\/#pull-requests\?task=shared%2Fsample-app-abc123%2FT3">&#8592; Back to T3/, "the back link returns to the page that opened the panel");
});

test("T1064: a report shows the STATUS pill, RESULT first, each finding as a row with severity, key, summary and location, the logbook's rows with their states, then the other fields and the PR link", t => {
  const w = world(t), page = read(w, "T3", "report", "R5");
  assert.match(page.html, /<dt>Status<\/dt><dd><span class="pill done">done<\/span>/);
  const result = page.html.indexOf("RESULT</span><p class=\"lead\">FINDINGS · 1 medium, 1 low</p>"), findings = page.html.indexOf(">FINDINGS</span>");
  assert.ok(result > 0 && result < findings, "RESULT comes first, in its box");
  assert.deepEqual(findingRowsOrRawHtml(page.html), [
    ["medium", "F1", "A revoked limit still applies for 10 minutes.", "src/limits.js:42\nproof: npm test -- scripts/limits-probe.test.mjs\nsaw: the limit 5 after revoke"],
    ["low", "F2", "The limit field has no label.", "src/limits-view.js:88"],
  ], "each finding row has no logbook state: no key joins a report finding to its logbook row");
  assert.deepEqual(logbookRows(page.html), ["F-T3-1 medium revoked-limit-applies-10-min open", "F-T3-2 low limit-field-no-label follow-up"], "R5's own rows, not R4's row with the key F1");
  assert.match(page.html, /<h2 class="sec">In the logbook<\/h2><p class="muted">The logbook's own record of these findings, with their states:<\/p><table/);
  assert.deepEqual(fieldsOpen(page.html), ["FINDINGS open", "QUESTIONS", "EVIDENCE", "NOT VERIFIED open", "BRANCH open"], "QUESTIONS none stays closed");
  assert.match(page.html, /<a href="https:\/\/github\.com\/sample-owner\/sample-app\/pull\/12">PR #12<\/a>/);
  assert.match(page.html, /head b{40}, PR 12/);
});

function reviewOf(w, lines, rows, decisions = []) {
  const add = (table, row) => { const file = join(w.logbook, `${table}.tsv`), head = readFileSync(file, "utf8").split("\n")[0].split("\t"); writeFileSync(file, `${readFileSync(file, "utf8").replace(/\n?$/, "\n")}${head.map(name => row[name] ?? "").join("\t")}\n`); };
  add("runs", { id: "R31", task: "T3", role: "code-reviewer", round: "0", status: "done", started: "2026-11-13T10:00:00.000Z", ended: "2026-11-13T11:00:00.000Z", chief: "C2" });
  for (const [key, severity, status, task = "T3", run = task === "T3" ? "R31" : ""] of rows) add("findings", { task, key, round: "0", source: "code-reviewer", severity, summary: `${key}-summary`, triage: status === "dismissed" ? "dismiss" : "fix", reason: "", status, run, class: "" });
  for (const row of decisions) add("decisions", { at: "2026-11-13T11:30:00.000Z", task: "T3", ...row });
  writeFileSync(join(w.logbook, "reports", "R31.md"), ["STATUS        done", "RESULT        FINDINGS · see below", "EVIDENCE      npm test: pass", "FINDINGS", ...lines, "QUESTIONS     none", "NOT VERIFIED  none", `BRANCH        b, head ${"d".repeat(40)}`].join("\n"));
  const page = read(w, "T3", "report", "R31");
  return {
    shown: findingRowsOrRawHtml(page.html).map(row => Array.isArray(row) ? `${row[1]} ${row[0]}` : row),
    logbook: logbookRows(page.html),
  };
}
function logbookRows(html) {
  return [...(/<h2 class="sec">In the logbook<\/h2>([\s\S]*?)(?:<details|<\/div><aside)/.exec(html)?.[1] ?? "").matchAll(/<tr><td class="mono">([^<]+)<\/td><td>([^<]+)<\/td><td>([^<]+)<\/td><td>([^<]+)<\/td><\/tr>/g)].map(match => match.slice(1).join(" "));
}
const MEDIUM = ["    a.js:1", "    proof: npm test", "    saw: `x`"];

test("T1064: no FINDINGS row shows a logbook state, whatever the lead recorded, and In the logbook lists each row of the run with its true state", t => {
  const cases = [
    { name: "severity-raised: the lead records F1 as high and F2 as medium, F3 has no row", lines: ["- F1 medium a.js:1 first", ...MEDIUM.slice(1), "- F2 low b.js:2 second", "- F3 low c.js:3 third"],
      rows: [["F-T3-17", "high", "open"], ["F-T3-18", "medium", "closed"]], shown: ["F1 medium", "F2 low", "F3 low"], logbook: ["F-T3-17 high F-T3-17-summary open", "F-T3-18 medium F-T3-18-summary closed"] },
    { name: "cross: one finding recorded one severity up, the other one down", lines: ["- F1 low a.js:1 dismissed in truth", "- F2 medium b.js:2 open in truth", ...MEDIUM.slice(1)],
      rows: [["F-T3-17", "medium", "dismissed"], ["F-T3-18", "low", "open"]], shown: ["F1 low", "F2 medium"], logbook: ["F-T3-17 medium F-T3-17-summary dismissed", "F-T3-18 low F-T3-18-summary open"] },
    { name: "moved: the lead moved F2 to a follow-up task, so its row lost its run", lines: ["- F1 medium a.js:1 closed", ...MEDIUM.slice(1), "- F2 low b.js:2 moved to T9", "- F3 low c.js:3 open", "- F4 low d.js:4 dismissed"],
      rows: [["F-T3-13", "medium", "closed"], ["F-T9-1", "low", "open", "T9"], ["F-T3-15", "low", "open"], ["F-T3-16", "low", "dismissed"]],
      decisions: [{ decision: "F-T3-14 moved to T9 as F-T9-1: F-T3-14-summary", why: "the follow-up task (from R31, low): Later polish" }],
      shown: ["F1 medium", "F2 low", "F3 low", "F4 low"], logbook: ["F-T3-13 medium F-T3-13-summary closed", "F-T3-15 low F-T3-15-summary open", "F-T3-16 low F-T3-16-summary dismissed", "F-T3-14 low F-T9-1-summary moved to T9"] },
    { name: "skipped: a low finding has no row (allowed)", lines: ["- F1 low a.js:1 not recorded", "- F2 medium b.js:2 open", ...MEDIUM.slice(1)],
      rows: [["F-T3-17", "medium", "open"]], shown: ["F1 low", "F2 medium"], logbook: ["F-T3-17 medium F-T3-17-summary open"] },
    { name: "reversed: two findings of one severity, both rows closed", lines: ["- F1 low a.js:1 first", "- F2 low b.js:2 second"],
      rows: [["F-T3-17", "low", "closed"], ["F-T3-18", "low", "closed"]], shown: ["F1 low", "F2 low"], logbook: ["F-T3-17 low F-T3-17-summary closed", "F-T3-18 low F-T3-18-summary closed"] },
  ];
  for (const { name, lines, rows, decisions, shown, logbook } of cases) {
    const result = reviewOf(world(t), lines, rows, decisions);
    assert.deepEqual(result.shown, shown, `${name}: each row has severity, key and summary only`);
    assert.deepEqual(result.logbook, logbook, `${name}: the table has each row's true state`);
  }
});

test("T1064: a report shows each finding that the hook reads, with the hook's severity: the dash, numbered, long-dash and indented forms", t => {
  const w = world(t), file = join(w.logbook, "reports", "R5.md"), text = readFileSync(file, "utf8");
  writeFileSync(file, text.replace(/^FINDINGS\n[\s\S]*?(?=^QUESTIONS)/m, ["FINDINGS", "- F1 - high - the dash form: a save loses data", "    src/save.js:3", "    proof: npm test", "    saw: `lost`",
    "1. F2 high the numbered form: a crash on start", "- F3 — medium the long-dash form", "  - F4 low an indented finding", ""].join("\n")));
  assert.deepEqual(readReport(readFileSync(file, "utf8")).findings.map(item => `${item.key} ${item.severity}`), ["F1 high", "F2 high", "F3 medium", "F4 low"], "the hook reads four findings");
  assert.deepEqual(findingRowsOrRawHtml(read(w, "T3", "report", "R5").html), [
    ["high", "F1", "the dash form: a save loses data", "src/save.js:3\nproof: npm test\nsaw: `lost`"],
    ["high", "F2", "the numbered form: a crash on start", undefined],
    ["medium", "F3", "the long-dash form", undefined],
    ["low", "F4", "an indented finding", undefined],
  ]);
});

test("T1064: the reader states: a running run's report is not written yet, an older run's report or brief is not kept, a review's kept report is the fallback, a stale logbook names the copy's time", t => {
  const w = world(t);
  assert.match(read(w, "T3", "report", "R6").text, /Not written yet\. qa R6 runs \(30 min\)\. The board shows the report when the run ends/);
  assert.match(read(w, "T3", "report", "R7").text, /Not kept\. The logbook keeps no report of R7\./, "R7's kept report names another task, so it is not R7's");
  assert.match(read(w, "T3", "brief", "R5").text, /Not kept\. The logbook keeps no brief of R5\./);
  rmSync(join(w.logbook, "reports", "R5.md"));
  const kept = read(w, "T3", "report", "R5");
  assert.match(kept.text, /RESULT CLEAN\. The limits change is correct\./, "the review's kept report");
  assert.match(kept.text, /kept\/R5\.json in the logbook/);
  assert.match(read(w, "T3", "report", "R99").text, /The logbook has no run R99 of T3\./);
  const stale = read(w, "T3", "brief", "R7", {}, { ...w.model(), stale: true });
  assert.match(stale.text, /The board cannot read the logbook now\. This is the copy that it read at \d\d:\d\d\./);
  assert.match(stale.text, /GOAL/, "the copy still shows");
  for (const page of [read(w, "T3", "report", "R7"), read(w, "T3", "brief", "R5"), read(w, "T30", "question", "G5")]) assert.doesNotMatch(page.text, /\bT1058\b/, "the copy names no internal task");
  assert.match(read(w, "T3", "brief", "R5").text, /sage keeps briefs only for newer runs/);
  symlinkSync(join(w.logbook, "briefs", "R7.md"), join(w.logbook, "briefs", "R5.md"));
  assert.match(read(w, "T3", "brief", "R5").text, /The board cannot read this brief\. The file is a link, and the board does not open links\./, "a link is not followed");
  rmSync(join(w.logbook, "briefs", "R5.md"));
  mkdirSync(join(w.logbook, "briefs", "R5.md"));
  assert.match(read(w, "T3", "brief", "R5").text, /The board cannot read this brief\. It is a folder, not a file\./);
  writeFileSync(join(w.logbook, "reports", "R5.md"), "x".repeat((1 << 20) + 1));
  assert.match(read(w, "T3", "report", "R5").text, /The board cannot read this report\. The file is over 1 MiB, so the reader does not show it\./);
  for (const page of [read(w, "T3", "brief", "R5"), read(w, "T3", "report", "R5")]) assert.doesNotMatch(/<div class="note fail" role="alert">([\s\S]*?)<\/div>/.exec(page.html)[1], /reload/i, "the note does not say that a reload fixes these");
  symlinkSync(join(w.pages, "T3", "notes.md"), join(w.pages, "T3", "linked.md"));
  const linked = read(w, "T3", "page", "linked.md").text;
  assert.match(linked, /The board does not open this page\. The file is a link, and the board does not open links\./);
  assert.doesNotMatch(linked, /not written yet/);
});

test("T1064: an older Codex run's brief comes from its kept file briefs/sage_<role>_t<n>_r<n>.json", t => {
  const w = world(t);
  writeFileSync(join(w.logbook, "briefs", "sage_qa_t3_r6.json"), JSON.stringify({ task: "sage_qa_t3_r6", text: "Run R6 · task T3 (qa)\n\nGOAL        Check the limits change as a user would.\n\nACCEPTANCE  PASS or FAIL, with evidence.\n", checked: true }));
  writeFileSync(join(w.logbook, "briefs", "sage_code_reviewer_t3_r5.json"), JSON.stringify({ task: "sage_code_reviewer_t3_r5", text: "Run R5 · task T3 (code-reviewer)\n\nGOAL        Review the limits change.\n" }));
  const qa = read(w, "T3", "brief", "R6");
  assert.match(qa.text, /GOAL Check the limits change as a user would\./);
  assert.match(qa.text, /ACCEPTANCE PASS or FAIL, with evidence\./);
  assert.match(qa.text, /briefs\/sage_qa_t3_r6\.json in the logbook/);
  assert.match(read(w, "T3", "brief", "R5").text, /GOAL Review the limits change\./, "a role with a dash has an underscore in the file name");
  writeFileSync(join(w.logbook, "briefs", "sage_qa_t3_r6.json"), "{ not json");
  assert.match(read(w, "T3", "brief", "R6").text, /The board cannot read this brief\. The file is not valid JSON\./);
});

test("T1064: a Markdown page has a contents list and its pictures from the task's pages folder; a recorded page that is gone says so with the logbook's record", t => {
  const w = world(t), page = read(w, "T3", "page", "retry-design.md");
  assert.match(page.html, /<nav class="toc" aria-label="Contents">.*<a class="l1" href="#h-the-rule">The rule<\/a><a class="l1" href="#h-the-code">The code<\/a><\/nav>/s);
  assert.equal([...page.html.matchAll(/<h1\b/g)].length, 1, "the page's first heading is its title, once");
  assert.match(page.html, /<h1>Retry with backoff<\/h1>/);
  assert.match(page.html, /<img src="\/pages\/sample-app-abc123\/T3\/retry\.svg" alt="The retry screen"/);
  assert.match(page.html, /<a href="\/read\/[\w-]+\/page\/notes\.md">the notes<\/a>/, "a relative link to another Markdown page opens it in the reader");
  assert.match(page.html, /<a class="btn" href="\/pages\/sample-app-abc123\/T3\/retry-design\.md">Open the file<\/a>/);
  assert.match(read(w, "T3", "page", "gone-plan.md").text, /The file is gone from the pages folder\. The logbook still has its record: gone-plan\.md ?, sha256 abababababababab…/);
  assert.match(read(w, "T3", "page", "notes.md").text, /Recorded .* changed since it was recorded/, "a page that differs from its recorded digest says so");
  assert.match(read(w, "T3", "page", "never.md").text, /This page is not in the task's pages folder\./);
});

test("T1064: a design shows today's version or two versions side by side, each with its screenshots, the prototype link and the owner's decisions; an arena shows candidates, scores and the judge's final", t => {
  const w = world(t);
  const today = read(w, "T10", "design");
  assert.match(today.text, /v2 · 12 Nov \d\d:\d\d Today designer R8/);
  assert.deepEqual([...today.html.matchAll(/<img src="([^"]+)"/g)].map(match => match[1]), ["/pages/sample-app-abc123/T10/designs/v2/first.svg", "/pages/sample-app-abc123/T10/designs/v2/after.svg"]);
  assert.match(today.html, /href="\/pages\/sample-app-abc123\/T10\/designs\/v2\/index\.html">Open the prototype/);
  assert.doesNotMatch(today.html, /designs\/A\//, "arena candidates are not design versions");
  const compare = read(w, "T10", "design", null, { view: "compare" });
  assert.deepEqual([...compare.html.matchAll(/<section class="version" aria-label="(\w+)">/g)].map(match => match[1]), ["v1", "v2"]);
  assert.match(compare.text, /G7 · Which design for the share sheet\? You answered: v2 · the other options: v1/);
  const arena = read(w, "T10", "arena");
  assert.deepEqual([...arena.html.matchAll(/<section class="card[^"]*"><h3><span>(\w+) .*?<span class="pill[^"]*">([\w ]+)<\/span><\/h3>.*?<span class="score">(\d+)<\/span> of (\d+)/g)].map(match => match.slice(1)), [["A", "Base", "21", "25"], ["B", "Not used", "17", "25"]]);
  assert.match(arena.text, /Fits the brief 5 of 5 3 of 5/);
  assert.match(arena.text, /Base: candidate A\. It scored highest and fits the brief best\. Grafted in From B: the total in the tooltip\. Not used B's header total: it hides which list waits\. You answered G12: A/);
});

test("T1064: the full question view shows the kept message: Needed by and If you do not answer first, every part, the answers with the chief's pick first, and links to read more", t => {
  const w = world(t), page = read(w, "T10", "question", "G4");
  const order = ["Needed by", "If you do not answer", "Where this is", "What you approve", "The one real choice in it", "After you answer", "The answers", "Read more"].map(name => page.html.indexOf(`<h2 class="sec">${name}</h2>`));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), `the parts in order: ${order}`);
  assert.deepEqual([...page.html.matchAll(/<section class="answer[^"]*"><h3>([^<]+)/g)].map(match => match[1].trim()), ["A: yes, as a new private list", "B: no"], "the pick (row 1) comes first");
  assert.match(page.html, /A: yes, as a new private list <span class="pill grafted">C1's pick<\/span><\/h3><dl><dt>What happens next<\/dt><dd>C1 adds &#34;Copy to my lists&#34; and builds after T3 merges\.<\/dd><dt>Cost<\/dt><dd>About 1 to 2 h more agent time/);
  assert.match(page.html, /href="\/read\/[\w-]+\/page\/designs\/v2\/notes\.md\?back=q-G4">Design notes of v2<\/a>/);
  assert.match(page.html, /<a class="back" href="\/app\/#">&#8592; Back to Needs you<\/a>/);
  assert.match(read(w, "T10", "page", "designs/v2/notes.md", { back: "q-G4" }).html, /<a class="back" href="\/read\/[\w-]+\/question\/G4">&#8592; Back to G4<\/a>/, "a page opened from the question returns to it");
  const old = read(w, "T30", "question", "G5");
  assert.match(old.text, /Not kept\. The logbook keeps no full message of G5/);
  assert.deepEqual([...old.html.matchAll(/<section class="answer[^"]*"><h3>([^<]+)/g)].map(match => match[1].trim()), ["A: ask each time", "B: send them"], "the gate's options, the recommendation first");
});

test("T1064: a batch question shows the answers of each question under its own heading, the chief's pick first in each", t => {
  const w = world(t), file = join(w.logbook, "gates", "G4.json"), kept = JSON.parse(readFileSync(file, "utf8"));
  const table = (rows, pick) => ({ t: "table", head: ["Answer", "What happens next", "Cost"], rows, pick });
  kept.message.blocks = [...kept.message.blocks.filter(block => block.t !== "table"),
    { t: "section", label: "Question 1: Colour", body: [table([["1A: blue", "Blue buttons.", "None"], ["1B: red", "Red buttons.", "None"]], 0)] },
    { t: "section", label: "Question 2: Size", body: [{ t: "p", text: "The size of the share sheet." }, table([["2A: small", "A small sheet.", "None"], ["2B: large", "A large sheet.", "About 1 h"]], 1)] }];
  writeFileSync(file, JSON.stringify(kept));
  const page = read(w, "T10", "question", "G4"), answers = page.html.slice(page.html.indexOf(`<h2 class="sec">The answers</h2>`));
  assert.deepEqual([...answers.matchAll(/<h3 class="sub">([^<]+)<\/h3>|<section class="answer( pick)?"><h3>([^<]+)/g)].map(match => match[1] ?? `${match[3].trim()}${match[2] ? " (pick)" : ""}`),
    ["Question 1: Colour", "1A: blue (pick)", "1B: red", "Question 2: Size", "2B: large (pick)", "2A: small"]);
  assert.match(page.html, /<h2 class="sec">Question 2: Size<\/h2><p>The size of the share sheet\.<\/p>/, "a section with other parts keeps its heading above them");
  assert.doesNotMatch(page.html, /<h2 class="sec">Question 1: Colour<\/h2>/, "a section with only its answers has no empty heading");
});

test("T1064: the question view shows every part of the kept message: a frame and a picture with their keys, steps with commands and what you see, a toggle, a changes table, table captions; a part it cannot show gets a note", t => {
  const w = world(t), file = join(w.logbook, "gates", "G4.json"), kept = JSON.parse(readFileSync(file, "utf8"));
  const answers = kept.message.blocks.find(block => block.t === "table");
  kept.message.blocks = [...kept.message.blocks.filter(block => block !== answers),
    { t: "picture", title: "Where the work is", key: "The double box is the task that runs now.", frame: { box: "milestone", name: "Offline sync", state: "active", items: [{ box: "task", name: "T10 Share sheet", state: "building", here: true }] } },
    { t: "picture", title: "The share sheet", key: "[new] marks a new control.", lines: ["+--------------+", "| Copy [new]   |", "+--------------+"] },
    { t: "steps", items: [{ text: "Open the board.", cmd: ["sage board --open"], see: "The Overview opens." }, { text: "Pick the list." }] },
    { t: "toggle", after: [{ title: "Sheet after", lines: ["[Copy to my lists]"] }], today: [{ title: "Sheet today", lines: ["[View only]"] }] },
    { t: "changes", rows: [{ where: "Share sheet", today: "View only", after: "A Copy button", why: "Viewers ask for it" }] },
    { t: "table", head: ["Role", "Can copy"], rows: [["Viewer", "Yes"]], caption: "Who can copy" },
    { ...answers, caption: "Pick one answer" },
    { t: "video", title: "A part from a newer sage" }];
  kept.text = "QUESTION\n\nPage · Can a viewer copy?\n  http://127.0.0.1:43123/pages/sample-app-abc123/T10/question-0a1b2c3d.html\n  question-0a1b2c3d.html";
  writeFileSync(file, JSON.stringify(kept));
  writeFileSync(join(w.pages, "T10", "question-0a1b2c3d.html"), "<!doctype html><title>q</title>\n");
  const html = read(w, "T10", "question", "G4").html;
  const parts = {
    "the frame as its boxes": /<p><b>Where the work is<\/b><\/p><pre class="md">╭─ Milestone Offline sync ─+╮\n│ In progress +│\n│ ╔═ Task: T10 Share sheet ═+╗ │/,
    "the frame's key": /<\/pre><p class="muted">The double box is the task that runs now\.<\/p>/,
    "the picture and its key": /<pre class="md">\+-+\+\n\| Copy \[new\] +\|\n\+-+\+<\/pre><p class="muted">\[new\] marks a new control\.<\/p>/,
    "each step with its command and what you see": /<ol><li>Open the board\.<pre class="md">sage board --open<\/pre><p class="muted">The Overview opens\.<\/p><\/li><li>Pick the list\.<\/li><\/ol>/,
    "both sides of the toggle": /<h3 class="sub">After this change<\/h3><p><b>Sheet after<\/b><\/p><pre class="md">\[Copy to my lists\]<\/pre><h3 class="sub">Today<\/h3><p><b>Sheet today<\/b><\/p><pre class="md">\[View only\]<\/pre>/,
    "the changes table": /<thead><tr><th scope="col">Where you see it<\/th><th scope="col">Today<\/th><th scope="col">After this change<\/th><th scope="col">Why<\/th><\/tr><\/thead><tbody><tr><td>Share sheet<\/td><td>View only<\/td><td>A Copy button<\/td><td>Viewers ask for it<\/td><\/tr>/,
    "a table's caption": /<table class="scores"><caption>Who can copy<\/caption>/,
    "the answers table's caption": /<h2 class="sec">The answers<\/h2><p class="muted">Pick one answer<\/p><section class="answer pick">/,
    "a note for a part that the view cannot show, with a link to the message page": /<b>Not shown here\.<\/b> This page cannot show one part of the question \(video\)\. <a href="\/pages\/sample-app-abc123\/T10\/question-0a1b2c3d\.html">Open the question's message page<\/a>/,
  };
  assert.deepEqual(Object.keys(parts).filter(name => !parts[name].test(html)), [], "each part of the kept message shows");
});

test("T1064 security: hostile Markdown and hostile logbook text render harmless: no raw HTML, no script or javascript: link, no outside or traversal picture, no bidi override", t => {
  const w = world(t, { hostile: true });
  const pages = [["T3", "page", "hostile.md"], ["T3", "brief", "R7"], ["T3", "report", "R5"], ["T10", "question", "G4"], ["T50", "question", "G9"], ["T10", "design"], ["T10", "arena"]].map(([task, kind, arg]) => read(w, task, kind, arg ?? null));
  for (const page of pages) {
    const body = page.html.replace(/<style>[\s\S]*?<\/style>/, "");
    assert.doesNotMatch(body, /<(?:script|iframe|form|object|embed|base|meta http-equiv)\b/i);
    for (const tag of body.match(/<[a-z][^>]*>/gi)) assert.doesNotMatch(tag, /\son[a-z]+\s*=/i, `no event attribute: ${tag}`);
    assert.doesNotMatch(body, /(?:href|src)="\s*(?:javascript|data|vbscript):/i);
    assert.doesNotMatch(body, /(?:href|src)="(?:\/\/|\/api|https?:\/\/(?!github\.com\/sample-owner|example\.com))/i, "no link to another host, other than the PR, and none to the write API");
    for (const [, src] of body.matchAll(/<img src="([^"]+)"/g)) assert.match(src, /^\/pages\/sample-app-abc123\/T(?:3|10)\/(?!.*\.\.)/, `a picture only from the task's own pages folder: ${src}`);
    assert.doesNotMatch(body, FORMAT, "no raw format mark (bidi control, zero-width mark)");
  }
  const md = pages[0].html;
  assert.match(md, /&lt;script&gt;window\.hacked=1&lt;\/script&gt;/, "raw HTML shows as text");
  assert.match(md, /\[run it\]\(javascript:window\.hacked=3\)/, "a javascript: link stays text");
  assert.match(md, /Picture not shown: outside\. .*Picture not shown: traversal\./s);
  assert.match(md, /abc\[U\+202E\]dcba and isolate \[U\+2066\]x\[U\+2069\] end\./, "bidi controls show as visible marks");
  assert.match(pages[1].html, /&lt;script&gt;window\.hacked=11&lt;\/script&gt; \[U\+202E\]evil/, "the brief's raw HTML and bidi override show as text");
  assert.equal(read(w, "T3", "page", "../T10/designs/v2/notes.md"), null, "a path out of the task folder is no reader page");
  writeFileSync(join(w.pages, "T3", "entity.md"), ["# Entity &#x202E;gnirts", "", "## Isolate &#8295;x&#8297;", "",
    "Text: abc&#x202E;gpj.exe, zero width a&#x200B;b, mark a&#x200F;1, Arabic mark a&#x61C;1, BOM a&#xFEFF;b, raw a\u200eb.", "",
    "Code: `x&#x202E;y` and `x\u202ey`.", "", "```", "fence \u202e end", "```", "",
    "[a title](https://example.com/a \"t&#x202E;x\") ![alt a&#x202E;b](retry.svg) ![gone c&#x202E;d](nothing.png)", ""].join("\n"));
  const entity = read(w, "T3", "page", "entity.md");
  assert.doesNotMatch(entity.html.replace(/<style>[\s\S]*?<\/style>/, ""), FORMAT, "a mark written as an HTML entity, in code, in a fence, in a title or in an alt is no raw mark");
  for (const mark of ["202E", "2067", "2069", "200B", "200F", "061C", "FEFF", "200E"]) assert.match(entity.html, new RegExp(`\\[U\\+${mark}\\]`), `U+${mark} shows as a visible mark`);
  assert.match(entity.html, /<h1>Entity \[U\+202E\]gnirts<\/h1>/);
  assert.match(entity.html, /<code>x\[U\+202E\]y<\/code>/, "a raw mark in a code span shows as a visible mark");
  assert.equal(read(w, "T3", "page", "retry.svg"), null, "the reader opens Markdown only");
});

test("T1064 security: a link with an encoded, doubly encoded or mixed-case scheme, or a scheme split by whitespace or a control character, is refused like any outside link", t => {
  const w = world(t), hex = n => `%${n.toString(16).toUpperCase().padStart(2, "0")}`;
  const bad = ["https%3A//x/../../../../../../pages/sample-app-abc123/T3/proto.html?scripts=1", "https%3a//x/../../app/task/abc?any=query", "https%253A//x/../../pages/sample-app-abc123/T3/proto.html",
    "HtTpS%3A//x/../proto.html", "hTTps%3a//x/..", "javascript%3Aalert(1)", "JaVaScRiPt%3aalert(1)", "javascript%253Aalert(1)", "javascript%25253Aalert(1)",
    "<java\tscript:alert(1)>", "< javascript:alert(1)>", "<\thttps%3A//x/../proto.html>", "%20https%3A//x/../proto.html",
    ...Array.from({ length: 32 }, (_, n) => [`java${hex(n)}script:alert(1)`, `${hex(n)}javascript:alert(1)`, `${hex(n)}https%3A//x/../proto.html`, `https%3A${hex(n)}//x/../proto.html`, `https:${hex(n)}//x/../proto.html`]).flat()];
  writeFileSync(join(w.pages, "T3", "encoded.md"), ["# Encoded links", "", "- [ok-https](https://example.com/a)", "- [ok-page](notes.md)", ...bad.map((url, i) => `- [bad-${i}](${url})`), ""].join("\n"));
  const article = /<article class="md">([\s\S]*?)<\/article>/.exec(read(w, "T3", "page", "encoded.md").html)[1];
  assert.deepEqual([...article.matchAll(/<a href="[^"]*">([^<]*)<\/a>/g)].map(match => match[1]), ["ok-https", "ok-page"], "only the true https link and the page link open");
  const off = new Set([...article.matchAll(/<span class="off"[^>]*>([^<]*)<\/span>/g)].map(match => match[1]));
  assert.deepEqual(bad.map((url, i) => `bad-${i}`).filter(label => !off.has(label) && !article.includes(`[${label}](`)), [], "each encoded form shows as a refused link or as plain text");
});

test("T1064: heading ids keep their form for repeated headings, and a page of 40,000 equal headings renders in linear time", () => {
  const ids = text => [...renderMarkdown(text, { href: () => null, picture: () => null }).html.matchAll(/<h\d id="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(ids(["## A", "## A", "## A 2", "## A", "## A-1", "## A-3", "## A", "### Ä b", "#### ä-b", "## !!!", "## ???", `## ${"x".repeat(70)}`, `## ${"x".repeat(65)} y`].join("\n\n")),
    ["h-a", "h-a-2", "h-a-2-2", "h-a-3", "h-a-1", "h-a-3-2", "h-a-4", "h-ä-b", "h-ä-b-2", "h-part", "h-part-2", `h-${"x".repeat(60)}`, `h-${"x".repeat(60)}-2`]);
  const started = performance.now();
  const out = renderMarkdown("## a\n".repeat(40_000), { href: () => null, picture: () => null });
  const took = performance.now() - started;
  assert.equal(out.headings.at(-1).id, "h-a-40000");
  assert.ok(took < 5_000, `40,000 headings took ${Math.round(took)} ms (timing-ok: the bound is wide on purpose; a linear id loop takes well under 1 s on a busy machine, and the quadratic loop that this test guards against took about 85 s)`);
});

async function freePort() {
  const socket = createServer();
  await new Promise((accept, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", accept); });
  const { port } = socket.address();
  await new Promise(accept => socket.close(accept));
  return port;
}
const get = (base, path, headers = {}) => new Promise((accept, reject) => {
  const req = request(`${base}${path}`, { headers }, response => { let body = ""; response.setEncoding("utf8"); response.on("data", part => { body += part; }); response.on("end", () => accept({ status: response.statusCode, headers: response.headers, body })); });
  req.on("error", reject); req.end();
});

test("T1064: the server serves the reader script-free under the sandbox policy, pictures only from the task's pages folder, and the task panel lists the design and the recorded pages", async t => {
  const w = world(t, { hostile: true }), port = await freePort(), base = `http://127.0.0.1:${port}`;
  const server = createBoardServer({ sources: w.sources, port, app: loadBoardApp(join(ROOT, "plugins/sage/board/app")), settleReads: [] });
  t.after(() => server.close());
  await server.start();
  const page = await get(base, readerUrl(KEY("T3"), "page", "hostile.md"));
  assert.equal(page.status, 200);
  const policy = page.headers["content-security-policy"];
  assert.match(policy, /^sandbox allow-same-origin; default-src 'none'; script-src 'none'; style-src 'sha256-[\w+/=]+'; img-src http:\/\/127\.0\.0\.1:\d+\/pages\/sample-app-abc123\/T3\/; base-uri 'none'; form-action 'none'; frame-ancestors 'none'$/);
  assert.doesNotMatch(policy, /allow-scripts|allow-forms|allow-popups|allow-top-navigation|unsafe/);
  assert.equal(page.headers["x-content-type-options"], "nosniff");
  assert.match(page.body, /<div class="skel" aria-hidden="true">.*<div class="ready">/s, "the outline comes first, and the document after it hides it");
  for (const path of [`/read/${Buffer.from(KEY("T3")).toString("base64url")}/page/..%2Fsecret.md`, `/read/${Buffer.from(KEY("T3")).toString("base64url")}/page/../secret.md`, `/read/${Buffer.from(KEY("T999")).toString("base64url")}/brief/R1`, `/read/${Buffer.from(KEY("T3")).toString("base64url")}/brief/R1x`, `/read/${Buffer.from(KEY("T3")).toString("base64url")}/brief/R7?x=1?y=2`]) {
    assert.equal((await get(base, path)).status, 404, path);
  }
  assert.equal((await get(base, readerUrl(KEY("T3"), "brief", "R7"), { "sec-fetch-site": "cross-site" })).status, 403, "another site cannot open the reader");
  const panel = JSON.parse((await get(base, `/app/task/${Buffer.from(KEY("T10")).toString("base64url")}`)).body);
  assert.deepEqual(panel.files.designs, { versions: 2, arena: true });
  const limits = JSON.parse((await get(base, `/app/task/${Buffer.from(KEY("T3")).toString("base64url")}`)).body);
  assert.deepEqual(limits.files.recorded.map(item => [item.file, item.state]), [["gone-plan.md", "gone"], ["notes.md", "changed"]]);
  const bare = createBoardServer({ sources: w.sources, port: await freePort(), app: null, markdown: null, settleReads: [] });
  t.after(() => bare.close());
  const { port: barePort } = await bare.start(), missing = await get(`http://127.0.0.1:${barePort}`, readerUrl(KEY("T3"), "brief", "R7"));
  assert.deepEqual([missing.status, missing.body], [503, "The reader's Markdown renderer is not in this copy of the board. Run the board from the sage plugin, or run npm ci and npm run build.\n"], "a copy of the board without its built renderer still starts, and says why it has no reader");
});
