import "./test-env.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { readBoardSources } from "../packages/sage-core/board-reader.mjs";
import { renderMarkdown } from "../packages/sage-board/markdown.mjs";
import { readerPage, readerUrl } from "../packages/sage-board/reader.mjs";
import { createBoardServer, loadBoardApp } from "../packages/sage-board/server.mjs";
import { writeTasksLogbook } from "./fixtures/board-app.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = "2026-11-13T12:00:00.000Z";
const KEY = id => `shared/sample-app-abc123/${id}`;
const ORIGIN = "http://127.0.0.1:5000";
const BIDI = /[\u202a-\u202e\u2066-\u2069]/;

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

test("T1064: a report shows the STATUS pill, RESULT first, each finding as a row with severity, key, summary, location and its state, then the other fields and the PR link", t => {
  const page = read(world(t), "T3", "report", "R5");
  assert.match(page.html, /<dt>Status<\/dt><dd><span class="pill done">done<\/span>/);
  const result = page.html.indexOf("RESULT</span><p class=\"lead\">FINDINGS · 1 medium, 1 low</p>"), findings = page.html.indexOf(">FINDINGS</span>");
  assert.ok(result > 0 && result < findings, "RESULT comes first, in its box");
  const rows = [...page.html.matchAll(/<div class="finding"><span><span class="pill (\w+)">\w+<\/span><\/span><span class="mono">(\w+)<\/span><span>([^<]+)<\/span><span>(?:<span class="pill[^"]*">([^<]+)<\/span>)?<\/span>(?:<span class="det">([^<]*)<\/span>)?/g)].map(match => match.slice(1));
  assert.deepEqual(rows, [
    ["medium", "F1", "A revoked limit still applies for 10 minutes.", "open", "src/limits.js:42\nproof: npm test -- scripts/limits-probe.test.mjs\nsaw: the limit 5 after revoke"],
    ["low", "F2", "The limit field has no label.", "follow-up", "src/limits-view.js:88"],
  ]);
  assert.deepEqual(fieldsOpen(page.html), ["FINDINGS open", "QUESTIONS", "EVIDENCE", "NOT VERIFIED open", "BRANCH open"], "QUESTIONS none stays closed");
  assert.match(page.html, /<a href="https:\/\/github\.com\/sample-owner\/sample-app\/pull\/12">PR #12<\/a>/);
  assert.match(page.html, /head b{40}, PR 12/);
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
  symlinkSync(join(w.logbook, "briefs", "R7.md"), join(w.logbook, "briefs", "R5.md"));
  assert.match(read(w, "T3", "brief", "R5").text, /The board cannot read this brief now\. The file is not a regular file/, "a link is not followed");
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
    assert.doesNotMatch(body, BIDI, "no raw bidi control");
  }
  const md = pages[0].html;
  assert.match(md, /&lt;script&gt;window\.hacked=1&lt;\/script&gt;/, "raw HTML shows as text");
  assert.match(md, /\[run it\]\(javascript:window\.hacked=3\)/, "a javascript: link stays text");
  assert.match(md, /Picture not shown: outside\. .*Picture not shown: traversal\./s);
  assert.match(md, /abc\[U\+202E\]dcba and isolate \[U\+2066\]x\[U\+2069\] end\./, "bidi controls show as visible marks");
  assert.match(pages[1].html, /&lt;script&gt;window\.hacked=11&lt;\/script&gt; \[U\+202E\]evil/, "the brief's raw HTML and bidi override show as text");
  assert.equal(read(w, "T3", "page", "../T10/designs/v2/notes.md"), null, "a path out of the task folder is no reader page");
  assert.equal(read(w, "T3", "page", "retry.svg"), null, "the reader opens Markdown only");
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
