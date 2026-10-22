import test from "node:test";
import assert from "node:assert/strict";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { renderBoardHtml, renderProgramsHtml, renderBoardText, renderTaskText, renderBoardStatus, needCounts, cardFits, BOARD_ENHANCEMENT } from "../packages/sage-core/board-render.mjs";
import { NOW as PROGRAMS_NOW, programsSource, programsTables } from "./fixtures/board-programs.mjs";
function model() {
  return buildBoardModel([{ id: "sample", label: "Sample source", diagnostics: [], projects: [{ key: "sample/project-abcdef", name: "project-abcdef", diagnostics: [], tables: { tasks: [{ id: "T1", title: "<script>alert(1)</script> & [sample](https://example.test)", size: "small", risk: "auth", route: "build,code-review,qa", state: "held", branch: "", pr: "", round: "1", keys: "" }], gates: [{ id: "G1", task: "T1", question: "Sample: go on?", answer: "" }] } }] }], { now: "2026-10-08T20:00:00Z" });
}
test("HTML renders escaped initial cards and complete offline task sections before enhancements", () => {
  const data = model(), html = renderBoardHtml(data);
  const initial = html.slice(0, html.lastIndexOf("<script>"));
  assert.ok(initial.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!initial.includes("<script>alert(1)</script>"));
  assert.ok(initial.includes("T1"));
  for (const title of ["Where in the loop", "Brief", "Agent runs", "Evidence", "Findings", "Artifacts", "Latest decisions"]) assert.ok(initial.includes(`<h3>${title}`), title);
  assert.ok(!/src=|@import|url\(/.test(html));
  assert.ok(html.includes("prefers-reduced-motion"));
  assert.ok(html.includes("max-width:700px"));
  const page = renderBoardHtml(data, { snapshot: false, taskKey: data.tasks[0].key });
  assert.ok(page.includes('<main class="page open"'));
  assert.throws(() => renderBoardHtml(data, { taskKey: "missing" }), RangeError);
});
test("phone text and status preserve task counts and escape agent markup", () => {
  const data = model(), board = renderBoardText(data), task = renderTaskText(data.tasks[0]);
  assert.ok(board.includes("1 needs you"));
  assert.ok(board.includes("**1 · T1"));
  assert.ok(board.includes("Needs you"));
  assert.ok(!board.includes("<script>"));
  assert.ok(!board.includes("[sample](https://example.test)"));
  assert.ok(board.includes(String.fromCharCode(92) + "[sample"));
  assert.ok(!board.includes("${c}"));
  for (const section of ["Loop", "Brief", "Agent runs", "Evidence", "Findings", "Artifacts", "Latest decisions"]) assert.ok(task.includes(`**${section}**`));
  assert.equal(renderBoardStatus(data).split("\n").length, 4);
  assert.ok(renderBoardStatus(data).includes("held 1"));
});


test("task evidence includes verified report contents and preserves brief lines in both views", () => {
  const data = model(), task = data.tasks[0];
  task.brief = "Goal line\nAcceptance line";
  task.artifacts = [{ source: "QA recorder", observedAt: data.at, data: { type: "proof", run: "R42", label: "Check output", path: "artifacts/check.txt" }, content: { verified: true, text: "tests 9\npass 9\n<script>sample</script>" } }];
  const html = renderBoardHtml(data, { taskKey: task.key }), text = renderTaskText(task);
  assert.ok(html.includes("tests 9\npass 9\n&lt;script&gt;sample&lt;/script&gt;"));
  assert.ok(text.includes("Goal line\nAcceptance line"));
  assert.ok(text.includes("tests 9\npass 9"));
  assert.ok(html.includes("R42 · digest verified"));
  assert.ok(text.includes("R42 · digest verified"));
  assert.ok(text.includes("local artifact; digest verified"));
  assert.ok(!text.includes("content not verified"));
});

function twoProjectModel() {
  const task = (id, state, extra = {}) => ({ id, title: `Sample ${id}`, state, size: "small", risk: "", route: "build,code-review,qa", branch: "", pr: "", round: "0", keys: "", ...extra });
  const head = "a".repeat(40), at = "2026-10-08T20:00:00Z";
  const pr = (id, taskId, number) => ({ id, task: taskId, kind: "pr", source: "Sample", observedAt: at, data: { number, state: "open", head, repository: "https://example.test/sample/sage" } });
  const alpha = { key: "sample/alpha-abcdef", name: "alpha-abcdef", diagnostics: [], tables: {
    tasks: [task("T1", "framed"), task("T2", "reviewing", { pr: "7" })],
    gates: [{ id: "G1", task: "T2", question: "Sample: accept?", options: "yes|no", recommendation: "yes", answer: "" }],
    runs: [{ id: "R1", task: "T2", role: "code-reviewer", status: "running", started: at, tokens: "1" }],
  }, observations: { records: [pr("O1", "T2", 7)] } };
  const beta = { key: "sample/beta-abcdef", name: "beta-abcdef", diagnostics: [], tables: {
    tasks: [task("T3", "held"), task("T4", "reviewing", { pr: "8", branch: "codex/sample" }), task("T5", "building")],
  }, observations: { records: [pr("O2", "T4", 8)] } };
  return buildBoardModel([{ id: "sample", label: "Sample source", diagnostics: [], projects: [alpha, beta] }], { now: at });
}
// T218: the approved look. Each test reads the rendered page as the browser gets it.
const at = "2026-10-08T20:00:00Z";
const sample = (tasks, tables = {}, extra = {}) => buildBoardModel([{ id: "sample", label: "sample", diagnostics: [], projects: [{ key: "sample/project-abcdef", name: "project-abcdef", diagnostics: [], tables: { tasks, ...tables }, ...extra }] }], { now: at });
const row = (id, state, extra = {}) => ({ id, title: `Sample ${id}`, size: "small", risk: "", route: "build,code-review,qa", state, branch: "", pr: "", round: "0", keys: "", ...extra });

test("T218: a hostile title, gate, finding and decision stay text in the card, the title attribute and the task page", () => {
  const hostile = `"><img src=x onerror=alert(1)><script>alert(2)</script>`;
  const data = sample([row("T1", "held", { title: hostile, pr: "7" })], {
    gates: [{ id: "G1", task: "T1", question: hostile, recommendation: hostile, answer: "" }],
    findings: [{ task: "T1", key: "F-T1-1", severity: "high", summary: hostile, status: "open", reason: "" }],
    decisions: [{ at, task: "T1", decision: hostile, why: hostile }],
  });
  for (const html of [renderBoardHtml(data), renderBoardHtml(data, { snapshot: false, live: true, taskKey: data.tasks[0].key })]) {
    assert.equal(html.split("<script>").length, 3, "only the page's own two scripts: the theme in the head, and the page script");
    assert.ok(!html.includes("<img src=x"));
    assert.ok(html.includes("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;alert(2)&lt;/script&gt;"));
  }
  assert.ok(renderBoardHtml(data).includes(`title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;`));
});

test("T218, T305: the page keeps all its code in one <style> and two <script>s with no attributes, so the server's CSP hashes cover it", () => {
  const data = twoProjectModel();
  for (const html of [renderBoardHtml(data, { snapshot: false, live: true }), renderBoardHtml(data, { snapshot: false, live: true, taskKey: data.tasks[0].key }), renderBoardHtml(data)]) {
    assert.deepEqual(html.match(/<(script|style)\b[^>]*>/g), ["<script>", "<style>", "<script>"]);
    const markup = html.replace(/<script>[\s\S]*?<\/script>|<style>[\s\S]*?<\/style>/g, "");
    assert.doesNotMatch(markup, /\sstyle=|\son[a-z]+=|javascript:/i, "an inline style or handler needs 'unsafe-inline'");
    assert.doesNotMatch(html, /\ssrc=|@import|url\(|<link/, "no external script, style, font or image");
  }
});

test("T218: the backlog shows the newest 6 tasks, then a fold that needs no script; R1075-2: its words count the folded tasks", () => {
  const tasks = Array.from({ length: 8 }, (_, i) => row(`T${i + 1}`, "framed"));
  const decisions = tasks.map((task, i) => ({ at: `2026-10-0${i + 1}T10:00:00Z`, task: task.id, decision: "task framed", why: "sample" }));
  const html = renderBoardHtml(sample(tasks, { decisions }));
  const backlog = /<section class="col" aria-label="Backlog" data-col="backlog" data-scroll="col-backlog">([\s\S]*?)<\/section>/.exec(html)[1];
  const [shown, folded] = backlog.split('<details class="rest" data-key="fold-backlog">');
  assert.deepEqual([...shown.matchAll(/<span class="id">(T\d+)<\/span>/g)].map(m => m[1]), ["T8", "T7", "T6", "T5", "T4", "T3"]);
  assert.match(folded, /^<summary id="sum-fold-backlog"><span data-more>Show 2 more tasks<\/span><\/summary>/);
  assert.deepEqual([...backlog.matchAll(/data-i="(\d+)"/g)].map(m => m[1]), ["0", "1", "2", "3", "4", "5", "6", "7"], "each card has its place, so the page script folds after the filters");
  assert.deepEqual([...folded.matchAll(/<span class="id">(T\d+)<\/span>/g)].map(m => m[1]), ["T2", "T1"]);
  assert.match(backlog, /<h2>Backlog <span class="n">8<\/span><\/h2>/);
});

test("T218: a task page opens by its anchor offline and at its route on the server, with a way back", () => {
  const data = twoProjectModel(), task = data.tasks.find(t => t.id === "T2"), id = `task-${Buffer.from(task.key).toString("base64url")}`;
  const offline = renderBoardHtml(data);
  assert.ok(offline.includes(`href="#${id}"`));
  assert.ok(offline.includes(`<section class="page" id="${id}" aria-label="T2"><div class="pagebar"><a class="back" href="#">← Board</a>`));
  assert.ok(offline.includes("body:has(.page:target) .boardview{display:none}"));
  const served = renderBoardHtml(data, { snapshot: false, live: true });
  assert.ok(served.includes(`href="/task/${Buffer.from(task.key).toString("base64url")}"`));
  assert.ok(!served.includes('class="page'));
  const page = renderBoardHtml(data, { snapshot: false, live: true, taskKey: task.key });
  // F-T218-14: one h1 (the task title) inside main, and the way back before the theme switch.
  assert.ok(page.includes(`<main class="page open" id="${id}" aria-label="T2"><div class="pagebar"><a class="back" href="/">← Board</a><span class="livepill" id="live-state">`));
  assert.deepEqual(page.match(/<h1\b[^>]*>[^<]*<\/h1>/g), ['<h1 class="ptitle">Sample T2</h1>']);
  assert.ok(page.indexOf('<h1 class="ptitle">') > page.indexOf("<main ") && page.indexOf('<h1 class="ptitle">') < page.indexOf("</main>"));
  assert.ok(page.indexOf('class="back"') < page.indexOf('id="flip"'));
  assert.ok(offline.includes('<h2 class="ptitle">Sample T2</h2>'));
  assert.ok(page.includes('<div class="nowline need">'), "the gate shows once, in the Needs you line");
  assert.ok(!page.includes('class="flag"'));
  assert.ok(!page.includes('class="board"'));
});

test("T218: the phone layout puts needs-you columns first and hides empty ones", () => {
  const data = twoProjectModel(), html = renderBoardHtml(data, { snapshot: false });
  assert.match(html, /@media \(max-width:700px\)\{[^}]*\{[^}]*\}[\s\S]*?\.col\.needs-col\{order:-1\}\.col\.empty-col\{display:none\}/);
  assert.ok(html.includes('<section class="col needs-col" aria-label="In review" data-col="review" data-scroll="col-review">'));
  assert.ok(html.includes('<section class="col empty-col" aria-label="Design" data-col="design" data-scroll="col-design">'));
  assert.ok(html.includes('<section class="col" aria-label="Backlog" data-col="backlog" data-scroll="col-backlog">'));
});

test("T305: the step line shows the ledger's verdicts on the newest reviewed head with a word for each mark, and plain words when no head is known", () => {
  const head = "c".repeat(40);
  const data = sample([row("T1", "reviewing", { pr: "9" }), row("T2", "reviewing", { pr: "10" })], {
    ledger: [{ task: "T1", pr: "9", sha: head, kind: "checks-pass", cycle: "1", run: "", at }, { task: "T1", pr: "9", sha: head, kind: "qa-fail", cycle: "1", run: "R2", at }],
    runs: [{ id: "R1", task: "T1", role: "code-reviewer", status: "running", started: at }],
  });
  const html = renderBoardHtml(data, { snapshot: false });
  assert.ok(html.includes('<ol class="sline" aria-label="Steps"><li class="s s-done"><span aria-hidden="true">✓</span>Plan<span class="vh">: done</span></li><li class="sep" aria-hidden="true">›</li><li class="s s-done"><span aria-hidden="true">✓</span>Build<span class="vh">: done</span></li><li class="sep" aria-hidden="true">›</li><li class="s s-fail"><span aria-hidden="true">✗</span>Review 1 of 1<span class="vh">: failed</span></li>'));
  assert.ok(html.includes('<b>Needs you:</b> QA failed on the recorded PR head.</span></div><div class="nextline"><b>Next:</b> A repair round, then the reviews start again at cycle 1.</div>'));
  assert.ok(html.includes("<b>Now:</b> No agent works on review cycle 1 of 1 now. The board does not know the PR&#39;s last commit."));
  assert.ok(!html.includes("PR head not recorded"), "no jargon");
  const page = renderBoardHtml(data, { snapshot: false, taskKey: data.tasks.find(t => t.id === "T1").key });
  assert.ok(page.includes(`last commit <span class="standin" tabindex="0" title="The commit of the newest verdict for this PR. The PR&#39;s own last commit is not recorded." data-why="The commit of the newest verdict for this PR. The PR&#39;s own last commit is not recorded.">ccccccc<span class="vh">`));
  assert.ok(page.includes('<div class="parts"><span class="part p-done"><span aria-hidden="true">✓</span> checks: done</span><span class="part p-run"><span aria-hidden="true">▶</span> code review: running now</span><span class="part p-fail"><span aria-hidden="true">✗</span> QA: failed</span></div>'));
  assert.ok(!page.includes('class="step '), "the old legend of cycle chips is gone");
  assert.ok(page.includes('<span class="prov"><span class="standin" tabindex="0" title="Stand-in: the logbook&#39;s source. The run does not record its provider." data-why="Stand-in: the logbook&#39;s source. The run does not record its provider.">Sample<span class="vh"> (Stand-in: the logbook&#39;s source. The run does not record its provider.)</span></span> ·</span> code-reviewer'), "R1075-7: the reason takes the focus on the task page");
  const board = renderBoardHtml(data, { snapshot: false });
  assert.ok(board.includes('<span class="prov"><span class="standin" title="Stand-in: the logbook&#39;s source. The run does not record its provider." data-why'), "in a card, which is a link, the stand-in takes no focus");
});

test("T218: the PR links only to https://github.com/<owner>/<repo>, from the remote or the PR observation, and stays text otherwise", () => {
  const observed = repository => ({ observations: { records: [{ id: "O1", task: "T1", kind: "pr", source: "Sample", observedAt: at, data: { number: 7, state: "open", repository } }] } });
  const make = (repository, extra = { repository }) => sample([row("T1", "reviewing", { pr: "7" })], {}, extra);
  for (const data of [make("https://github.com/acme/sage"), make(null, observed("https://github.com/acme/sage"))]) {
    const linked = renderBoardHtml(data, { snapshot: false, taskKey: "sample/project-abcdef/T1" });
    assert.ok(linked.includes('<a href="https://github.com/acme/sage/pull/7" rel="noopener noreferrer">PR 7</a>'));
    assert.ok(renderTaskText(data.tasks[0]).includes("· PR [7](https://github.com/acme/sage/pull/7)"));
  }
  const hostile = [null, "javascript:alert(1)", "http://github.com/acme/sage", "https://user:pw@github.com/acme/sage", "https://example.test/acme/sage", "https://github.com/acme/sage/pull/1#x", "https://github.com/acme/sage)[x](https://evil.test", "https://github.com/acme/sage?x=1"];
  for (const data of [...hostile.map(value => make(value)), ...hostile.map(value => make(null, observed(value)))]) {
    const page = renderBoardHtml(data, { snapshot: false, taskKey: "sample/project-abcdef/T1" }), text = renderTaskText(data.tasks[0]);
    assert.equal(data.tasks[0].repository, null);
    assert.ok(!page.includes("/pull/7") && !text.includes("/pull/7"));
    assert.ok(page.includes('data-why="No link: the project&#39;s GitHub remote is not known.">PR 7<span class="vh">'));
  }
});

test("T218: a severity or run status outside the closed list gets the neutral class, never a class from the logbook", () => {
  const data = sample([row("T1", "reviewing")], {
    findings: [{ task: "T1", key: "F-T1-1", severity: "high", summary: "Sample high", status: "open" }, { task: "T1", key: "F-T1-2", severity: "x needs", summary: "Sample odd", status: "open" }],
    runs: [{ id: "R1", task: "T1", role: "qa", status: "done" }, { id: "R2", task: "T1", role: "qa", status: "card needs" }],
  });
  const page = renderBoardHtml(data, { snapshot: false, taskKey: data.tasks[0].key });
  assert.deepEqual(page.match(/class="(?:sev|st-)[^"]*"/g), ['class="st-done"', 'class="st-other"', 'class="sev high"', 'class="sev other"']);
  assert.ok(page.includes('<span class="sev other">x needs</span>'));
});

test("T218: the chat board shows 5 cards a column in the page's order, with the card's cycle, clamped titles and the page's words", () => {
  const long = "Sample long title ".repeat(8);
  const tasks = [
    ...Array.from({ length: 40 }, (_, i) => row(`T${i + 1}`, "framed", { title: `Sample backlog ${i + 1} ${long}` })),
    row("T41", "reviewing", { pr: "3" }),
    ...Array.from({ length: 7 }, (_, i) => row(`T${50 + i}`, "building")), row("T60", "held"),
  ];
  const gates = [{ id: "G1", task: "T60", question: "Sample: go on?", answer: "" }];
  const decisions = tasks.map((task, i) => ({ at: new Date(Date.parse(at) - (60 - i) * 60000).toISOString(), task: task.id, decision: "sample", why: "sample" }));
  const runs = [{ id: "R1", task: "T50", role: "implementer", status: "running", started: at }];
  const data = sample(tasks, { decisions, runs, gates }), text = renderBoardText(data);
  // The same order as the page: newest activity first (F-T218-2), 5 a column and the rest counted (F-T218-6).
  const backlog = /### 📋 Backlog \(40\)\n([\s\S]*?)\n\n###/.exec(text)[1];
  assert.deepEqual([...backlog.matchAll(/\*\*(T\d+) /g)].map(m => m[1]), ["T40", "T39", "T38", "T37", "T36"]);
  assert.deepEqual(data.columns.find(c => c.key === "backlog").tasks.slice(0, 5).map(t => t.id), ["T40", "T39", "T38", "T37", "T36"]);
  assert.ok(backlog.endsWith("35 more in Backlog: open the board page for all."));
  const building = /### 🔨 Building \(8\)\n([\s\S]*?)\n\n###/.exec(text)[1];
  assert.deepEqual([...building.matchAll(/\*\*(T\d+) /g)].map(m => m[1]), ["T60", "T50", "T56", "T55", "T54"], "needs you first, then the newest activity");
  assert.ok(building.endsWith("3 more in Building: open the board page for all."));
  // F-T218-11: titles stop at 80 characters with an ellipsis.
  const title = /\*\*T40 ([^*]*)\*\*/.exec(text)[1];
  assert.ok([...title].length <= 80 && [...title].length >= 75, title);
  assert.ok(title.endsWith("…"));
  // F-T218-12: the page's date, summary words and column names; one note for the provider stand-in.
  assert.ok(text.startsWith("**sage board** · built 2026-10-08 20\\:00 UTC\\\n🔴 1 needs you · 1 agents at work · 🔁 1 in review · 49 tasks\\\n"));
  assert.ok(text.includes("### 🏁 Done, last 7 days (0)"));
  assert.ok(text.includes("**T41 Sample T41** · sample · project · PR 3\\\n✓ Plan › ✓ Build › ▷ Review 1 of 1 › ○ Merge\\\nNow: No agent works on review cycle 1 of 1 now\\. The board does not know the PR's last commit\\."), text.slice(text.indexOf("**T41"), text.indexOf("**T41") + 200));
  assert.ok(!text.includes("? checks"));
  assert.ok(!text.includes("logbook source)"));
  assert.equal(text.split("A stand-in: the run does not record its provider").length, 2);
  assert.ok(text.includes("**T50 Sample T50** · sample · project\\\nSample\\* · implementer at work"));
  assert.ok(text.length < 3000, `${text.length} characters`);
});

test("T314: a card and a task page show the display name, the priority and the kind; archived projects are folded into one group", () => {
  const book = (key, name, tasks, extra = {}) => ({ key: `sample/${key}`, name: key, diagnostics: [], tables: { tasks }, displayName: name, ...extra });
  const data = buildBoardModel([{ id: "sample", label: "sample", diagnostics: [], projects: [
    book("demos-abcdef", "seacc (Council Record)", [row("T1", "framed", { priority: "P1", kind: "bug-fix" }), row("T2", "framed")]),
    book("old-abcdef", "Old <app>", [row("T1", "awaiting-you"), row("T2", "framed")], { archived: true }),
  ] }], { now: at });
  const html = renderBoardHtml(data);
  const board = html.slice(html.indexOf('<main class="board"'), html.indexOf("</main>"));
  assert.ok(board.includes('<span class="tag prio" title="P1, second priority">P1<span class="vh">, second priority</span></span><span class="tag kind"><span aria-hidden="true">✱</span>Bug fix</span><span class="tag">small</span>'), "the tags come before the size");
  const cards = board.split('<a class="card').slice(1);
  assert.equal(cards.filter(card => !card.includes(" data-archived hidden>")).length, 2, "the two tasks of the live project are the shown cards");
  assert.equal(cards.filter(card => card.includes(" data-archived hidden>") && card.includes("Old &lt;app&gt;")).length, 2, "an archived project's cards are hidden until you choose it in the picker");
  assert.ok(board.includes("seacc (Council Record)</span>") && !board.includes("demos-abcdef</span>"));
  assert.ok(html.includes('<details class="archived" id="board-archived" data-key="archived"><summary id="sum-archived">Archived · 1 project</summary><ul><li>Old &lt;app&gt; · 2 tasks · 1 needs you</li></ul></details>'));
  const list = html.slice(html.indexOf('id="pick-list"'), html.indexOf("</header>"));
  assert.ok(/data-list="idle">[\s\S]*seacc \(Council Record\)[\s\S]*data-list="archived">[\s\S]*Old &lt;app&gt;[\s\S]*<\/ul><button type="button" class="morebtn" id="pick-more" data-showarchived>Show 1 archived project<\/button>/.test(list), "the archived project is in the picker's folded Archived group; R1071-4, R1069-1: its button is after the listbox, with its own attribute");
  assert.ok(!html.slice(html.indexOf('id="pick-chips"'), html.indexOf("</header>")).includes("Old &lt;app&gt;"), "no needs-you chip for an archived project");
  const page = renderBoardHtml(data, { snapshot: false, taskKey: data.tasks[0].key });
  assert.ok(page.includes('<span class="tag prio" title="P1, second priority">P1<span class="vh">, second priority</span></span><span class="tag kind"><span aria-hidden="true">✱</span>Bug fix</span>'), "the task page has the tags too");
  const text = renderBoardText(data);
  assert.ok(text.includes("**T1 Sample T1** · sample · seacc \\(Council Record\\) · P1 · Bug fix\\\n"), text);
  assert.ok(text.includes("\n\nArchived: Old \\<app\\> (2 tasks · 1 needs you)"), text);
  assert.ok(!text.includes("· Old \\<app\\>\n"), "an archived task is not on the chat board");
});

/** One source with a live project and an archived one, each a list of tasks; extra goes to the live project. */
const twoBooks = (live, old, extra = {}) => buildBoardModel([{ id: "sample", label: "sample", diagnostics: [], projects: [
  { key: "sample/live-abcdef", name: "live-abcdef", diagnostics: [], tables: { tasks: live }, ...extra },
  { key: "sample/old-abcdef", name: "old-abcdef", diagnostics: [], tables: { tasks: old }, displayName: "Old app", archived: true },
] }], { now: at });

test("T314 R1040-2: the status leaves archived tasks out of Tasks and Owner, and one line counts the archived projects and what needs you there", () => {
  const status = renderBoardStatus(twoBooks([row("T1", "framed"), row("T2", "awaiting-you")], [row("T1", "awaiting-you"), row("T2", "building"), row("T3", "awaiting-you")]));
  assert.deepEqual(status.split("\n").slice(0, 4), ["Tasks: framed 1 · awaiting-you 1", "Agents: 0 recorded running · 0 inferred PRs", "Owner: 1 tasks need you", "Archived: 1 project · 2 tasks need you"]);
  assert.equal(renderBoardStatus(twoBooks([row("T1", "framed")], [])).split("\n")[3], "Archived: 1 project · 0 tasks need you", "an archived project without tasks still counts");
  assert.ok(!renderBoardStatus(sample([row("T1", "framed")])).includes("Archived"), "no archived project: no line");
});

test("T314 R1040-3: the empty-board text shows only with no task at all; tasks only in archived projects get one line that says so", () => {
  const empty = "<b>No tasks recorded yet.</b>", archived = "<b>All tasks are in archived projects.</b> The Archived group below counts them.";
  const onlyArchived = renderBoardHtml(twoBooks([], [row("T1", "framed")]));
  assert.ok(!onlyArchived.includes(empty) && onlyArchived.includes(archived));
  assert.ok(onlyArchived.indexOf(archived) < onlyArchived.indexOf('id="board-archived"'));
  const none = renderBoardHtml(twoBooks([], []));
  assert.ok(none.includes(empty) && !none.includes(archived));
  const live = renderBoardHtml(twoBooks([row("T1", "framed")], [row("T1", "framed")]));
  assert.ok(!live.includes(empty) && !live.includes(archived));
});

test("T314 R1042-3 R1042-2: each chat diagnostic names its project, and an ignored setting is a warning line, not an incomplete source", () => {
  const model = twoBooks([row("T1", "framed")], [], { diagnostics: ["runs: EACCES"], warnings: ["config: archived is not true or false"] });
  const text = renderBoardText(model);
  assert.ok(text.endsWith("\nIncomplete source: sample · sample/live-abcdef · its runs file has no read permission\\\nSetting ignored: sample · sample/live-abcdef · config\\: archived is not true or false"), text);
  const html = renderBoardHtml(model);
  assert.ok(html.includes("<b>Settings ignored.</b> The board shows these projects without them.<ul class=\"diag\"><li>sample · sample/live-abcdef · config: archived is not true or false</li></ul>"));
});

test("T314 R1045-3: the task text shows the priority and the kind when they are set, and nothing for them when not", () => {
  const model = twoBooks([row("T1", "framed", { priority: "P1", kind: "bug-fix", risk: "auth" }), row("T2", "framed")], []);
  assert.equal(renderTaskText(model.tasks[0]).split("\n")[1], "sample · live · framed · small · P1 · Bug fix · risk: auth");
  assert.equal(renderTaskText(model.tasks[1]).split("\n")[1], "sample · live · framed · small");
});

// T305: the picker, the filter bar, the theme and the live pill, as the page gives them. Sample data only.
const providers = () => buildBoardModel([
  { id: "claude", label: "claude", provider: "Claude", diagnostics: [], projects: [{ key: "claude/sage-43265b", name: "sage-43265b", checkout: "/sample/sage", diagnostics: [], tables: { tasks: [row("T1", "awaiting-you", { priority: "P0", kind: "ui" })] } }, { key: "claude/demo-111111", name: "demo-111111", checkout: "/sample/sdc/product-demos", displayName: "seacc (Council Record)", diagnostics: [], tables: { tasks: [row("T2", "framed")] } }] },
  { id: "codex", label: "codex", provider: "Codex", diagnostics: [], projects: [{ key: "codex/sage-43265b", name: "sage-43265b", checkout: "/sample/sage", diagnostics: [], tables: { tasks: [row("T1", "framed")] } }] },
], { now: at });

test("T305: the picker is one button with an ARIA combobox and listbox, every project as an option with the names that search reads", () => {
  const html = renderBoardHtml(providers(), { snapshot: false });
  assert.ok(html.includes('<button class="trigger" type="button" id="pick-trig" aria-haspopup="listbox" aria-expanded="false" aria-controls="pick-pop">'));
  assert.ok(html.includes('<input id="pick-q" type="text" role="combobox" aria-expanded="true" aria-controls="pick-list" aria-autocomplete="list" aria-label="Find a project"'));
  assert.ok(html.includes('<div class="list"><ul class="opts" role="listbox" id="pick-list" aria-label="Projects"><li role="option" id="pick-o-all" class="opt" data-key="" data-name="All projects" aria-selected="false">'));
  const listbox = html.slice(html.indexOf('role="listbox"'), html.indexOf("</ul>", html.lastIndexOf('role="option"')));
  assert.ok(!/<button/.test(listbox), "R1071-4: the listbox holds only options and their groups");
  assert.ok(html.includes('<div class="vh" id="pick-say" role="status" aria-live="polite"></div>'), "R1075-6: a polite status says the count of matches");
  const sage = /<li role="option" id="pick-o-[^"]+" class="opt" data-key="sage-43265b"[^>]*>/.exec(html)[0];
  assert.ok(sage.includes('data-name="sage"') && sage.includes('data-provider="claude codex"') && sage.includes('data-providers="Claude + Codex"'), sage);
  assert.ok(sage.includes('data-terms="sage\nsage-43265b\nclaude/sage-43265b\ncodex/sage-43265b"'), sage);
  // R1069-2: the checkout paths go only to the Mac's own page, which the server asks for with paths.
  assert.ok(!html.includes("/sample/sage") && !renderBoardHtml(providers()).includes("/sample/sage"), "no path for a tunnel viewer or in the offline snapshot");
  assert.ok(renderBoardHtml(providers(), { snapshot: false, paths: true }).includes('data-terms="sage\nsage-43265b\nclaude/sage-43265b\ncodex/sage-43265b\n/sample/sage"'));
  assert.ok(html.includes('data-list="needs"><div class="grp" id="pick-g-needs"><span>Needs you</span><span class="n">1</span></div>'));
  assert.ok(/id="pick-chips"><span class="vh">Projects that need you:<\/span><button class="chip" type="button" id="need-[^"]+" data-pick="sage-43265b" data-provider="claude codex"[^>]*><span class="dot p\d" aria-hidden="true"><\/span><span class="cn">sage<\/span> <span class="badge"><span data-n>1<\/span><span class="vh"> need you<\/span><\/span><\/button><\/span>/.test(html), "one chip for each project that needs you, with its count");
  assert.equal((html.match(/data-pick="seacc|data-pick="demo-111111"/g) ?? []).length, 0, "no chip for a project that needs nothing");
  const empty = renderBoardHtml(buildBoardModel([], { now: at }), { snapshot: false });
  assert.ok(empty.includes("<b>No projects yet.</b>") && !empty.includes('id="pick-chips"><span'));
});

test("R1079-1: two clones show their path tails only on the Mac's own page; every other render says clone 1 and clone 2", () => {
  const clone = (key, checkout) => ({ key, name: key, checkout, repository: "https://github.com/sample-owner/sage", diagnostics: [], tables: { tasks: [row("T1", "awaiting-you")] } });
  const twins = buildBoardModel([{ id: "claude", label: "claude", provider: "Claude", diagnostics: [], projects: [clone("sage-9a9a9a", "/sample/clone/sage"), clone("sage-43265b", "/sample/work/sage")] }], { now: at });
  const lines = html => [...html.matchAll(/data-key="(sage-[0-9a-f]+)"[^>]*>.*?<span class="sub"><span class="why" data-why><\/span>([^<]*)<\/span>/g)].map(m => [m[1], m[2]]).sort();
  const titles = html => [...html.matchAll(/data-pick="(sage-[0-9a-f]+)"[^>]*title="([^"]*)"/g)].map(m => [m[1], m[2]]).sort();
  for (const html of [renderBoardHtml(twins), renderBoardHtml(twins, { snapshot: false })]) {
    assert.deepEqual(lines(html), [["sage-43265b", "clone 1 · sample-owner/sage · Claude"], ["sage-9a9a9a", "clone 2 · sample-owner/sage · Claude"]]);
    assert.deepEqual(titles(html), [["sage-43265b", "sage · clone 1 · sample-owner/sage"], ["sage-9a9a9a", "sage · clone 2 · sample-owner/sage"]]);
    assert.ok(!html.includes("…/"), "no path tail for a tunnel viewer or in the offline snapshot");
  }
  const mac = renderBoardHtml(twins, { snapshot: false, paths: true });
  assert.deepEqual(lines(mac), [["sage-43265b", "…/work/sage · sample-owner/sage · Claude"], ["sage-9a9a9a", "…/clone/sage · sample-owner/sage · Claude"]]);
  assert.deepEqual(titles(mac), [["sage-43265b", "sage · …/work/sage · sample-owner/sage"], ["sage-9a9a9a", "sage · …/clone/sage · sample-owner/sage"]]);
});

test("T305: the picker's search matches the shown name, else another name, and says which (the page carries this function)", async () => {
  const { matchProject, BOARD_ENHANCEMENT } = await import("../packages/sage-core/board-render.mjs");
  const terms = ["seattle-digital-commons/seacc", "erickb336/seacc", "product-demos", "/sample/sdc/product-demos", "product-demos-1c0254", "claude/product-demos-1c0254"];
  assert.deepEqual(matchProject("seacc (Council Record)", terms, "Council"), { ok: true, why: "" });
  assert.deepEqual(matchProject("seacc (Council Record)", terms, "product-demos"), { ok: true, why: "matches product-demos" });
  assert.deepEqual(matchProject("seacc (Council Record)", terms, " SEATTLE "), { ok: true, why: "matches seattle-digital-commons/seacc" });
  assert.deepEqual(matchProject("seacc (Council Record)", terms, "seattle digital"), { ok: false, why: "" });
  assert.deepEqual(matchProject("Café", [], "café"), { ok: true, why: "" }, "the composed and decomposed forms match");
  assert.ok(BOARD_ENHANCEMENT.includes(matchProject.toString()));
});

test("T305: the filter bar has Who from the sources, Priority P0 to P3 or none, and the ten kinds; it needs the script", () => {
  const html = renderBoardHtml(providers(), { snapshot: false });
  assert.ok(html.includes('<div class="seg" role="group" aria-label="Who"><button type="button" id="who-all" data-who="" aria-pressed="true">All</button><button type="button" id="who-claude" data-who="claude" aria-pressed="false">Claude</button><button type="button" id="who-codex" data-who="codex" aria-pressed="false">Codex</button></div>'));
  assert.deepEqual([.../<select id="f-priority" data-f="priority">(.*?)<\/select>/.exec(html)[1].matchAll(/<option value="([^"]*)">([^<]*)</g)].map(m => `${m[1]}=${m[2]}`), ["=Any", "P0=P0", "P1=P1", "P2=P2", "P3=P3", "none=No priority"]);
  assert.deepEqual([.../<select id="f-kind" data-f="kind">(.*?)<\/select>/.exec(html)[1].matchAll(/<option value="([^"]*)">([^<]*)</g)].map(m => m[2]), ["Any", "Design", "UI", "Orchestration", "Optimization", "Bug fix", "Logbook", "Docs", "Security", "Providers", "Checks"]);
  assert.ok(html.includes("html:not(.scripted) .pick,html:not(.scripted) .fbar{display:none}"));
  assert.ok(/<a class="card needs" id="card-[^"]+" href="[^"]+" data-key="claude\/sage-43265b\/T1" data-project="sage-43265b" data-provider="claude" data-priority="P0" data-kind="ui"/.test(html));
  assert.ok(html.includes('<span class="who" title="The logbook that holds this task">Codex</span>'), "each card names the provider whose logbook holds it");
});

test("T305, T349: the theme is dark until you choose light, a choice applies in the head, and the switch names the theme it switches to", async () => {
  const { THEME_HEAD } = await import("../packages/sage-core/board-render.mjs");
  const html = renderBoardHtml(providers());
  assert.ok(html.indexOf(`<script>${THEME_HEAD}</script>`) < html.indexOf("<style>"), "the saved theme applies before the first paint");
  assert.ok(html.includes('<input type="checkbox" id="flip" class="vh flip"><label class="chip theme" for="flip"><span class="to-light">Light theme</span><span class="to-dark">Dark theme</span></label>'));
  assert.ok(html.includes(":root[data-theme=light]:not(:has(.flip:checked)),:root:not([data-theme=light]):has(.flip:checked){--bg:#f0f0f1;"), "light shows for a light choice, or for a flipped dark or no choice");
  assert.ok(html.includes(":root[data-theme=light]:not(:has(.flip:checked)) .to-light,:root:not([data-theme=light]):has(.flip:checked) .to-light{display:none}"));
  assert.ok(!html.includes("prefers-color-scheme"), "the system theme does not choose the theme");
  const store = new Map([["board-theme", "light"]]), root = { dataset: {} };
  new Function("localStorage", "document", THEME_HEAD)({ getItem: key => store.get(key) ?? null }, { documentElement: root });
  assert.equal(root.dataset.theme, "light");
  const none = { dataset: {} };
  new Function("localStorage", "document", THEME_HEAD)({ getItem: () => { throw new Error("blocked"); } }, { documentElement: none });
  assert.equal(none.dataset.theme, undefined, "no storage: no choice, so the dark default");
});

test("T305 R1056-2: a backlog card shows only its step line; a card in another column and the task page keep Now and Next", () => {
  const data = sample([row("T1", "framed"), row("T2", "building")]);
  const html = renderBoardHtml(data, { snapshot: false });
  const cardOf = id => /<a class="card[^"]*" id="card-[^"]+"[^>]*>([\s\S]*?)<\/a>/g;
  const cards = Object.fromEntries([...html.matchAll(cardOf())].map(match => [/<span class="id">(T\d+)<\/span>/.exec(match[1])[1], match[1]]));
  assert.ok(cards.T1.includes('<ol class="sline" aria-label="Steps">'), "the backlog card has its steps");
  assert.ok(!cards.T1.includes('class="nowline') && !cards.T1.includes('class="nextline"'), "and no Now or Next line");
  assert.ok(cards.T2.includes("<b>Now:</b> No agent works on the build now.") && cards.T2.includes("<b>Next:</b> Review cycle 1 of 1, when the PR opens."));
  const page = renderBoardHtml(data, { snapshot: false, taskKey: data.tasks.find(task => task.id === "T1").key });
  assert.ok(page.includes("<b>Now:</b> In the backlog. No agent works on it.") && page.includes("<b>Next:</b> The build."), "the task page keeps both lines");
});

test("R1245-1: a breakdown gate's lines (U+2028 in its cell) show as lines on the card, in the text board and on the task text, with the recommendation on a line of its own", () => {
  const question = ["Approve program PG1? No task builds before you approve.", "Name: Codex support", "Pilot, runs first:", "  T1: <b>Ship</b> it: 100% done"].join(" ");
  const data = sample([row("T1", "framed", { program: "PG1" })], { programs: [{ id: "PG1", name: "Codex support", goal: "Sample", pilot: "T1", gate: "G1", at }], gates: [{ id: "G1", task: "T1", question, options: "approve|change|drop", recommendation: "approve", answer: "" }] });
  // T368 QF: the card shows the stored lines in the frame; the task page keeps them in its Needs you line.
  assert.ok(renderBoardHtml(data, { snapshot: false }).includes('<b>Needs you:</b> the breakdown of PG1.</span></div><p class="q">Approve program PG1? No task builds before you approve.</p><p class="q">Name: Codex support</p><p class="q">Pilot, runs first:</p><p class="q">  T1: &lt;b&gt;Ship&lt;/b&gt; it: 100% done</p><p class="q"><b>I recommend:</b> approve</p>'));
  const html = renderBoardHtml(data, { snapshot: false, taskKey: data.tasks[0].key });
  assert.ok(html.includes("<b>Needs you:</b> Approve program PG1? No task builds before you approve.<br>Name: Codex support<br>Pilot, runs first:<br>  T1: &lt;b&gt;Ship&lt;/b&gt; it: 100% done<br>I recommend: approve</span>"), html);
  assert.ok(renderBoardText(data).includes("#### ◫ Program approval\n**1 · PG1 Codex support** · sample · project · pilot T1 · gate G1\n> sample/project-abcdef/G1 · Approve program PG1? No task builds before you approve\\.\\\n> Name\\: Codex support\\\n> Pilot, runs first\\:\\\n>   T1\\: \\<b\\>Ship\\</b\\> it\\: 100% done\\\n> Options: 1: approve"), renderBoardText(data));
  assert.ok(renderTaskText(data.tasks[0]).includes("Needs you: Approve program PG1? No task builds before you approve\\.\nName\\: Codex support\nPilot, runs first\\:\n  T1\\: \\<b\\>Ship\\</b\\> it\\: 100% done\nI recommend\\: approve"), renderTaskText(data.tasks[0]));
});

test("R1249-1: only a breakdown gate's question shows as lines: a plain gate's line breaks show as spaces on the card, in the text board and on the task text", () => {
  const question = "Ship it? I recommend: no 1. no";
  const data = sample([row("T1", "framed")], { gates: [{ id: "G1", task: "T1", question, options: "yes|no", recommendation: "yes", answer: "" }] });
  const html = renderBoardHtml(data, { snapshot: false });
  assert.ok(html.includes("<b>Needs you:</b> Ship it? I recommend: no 1. no I recommend: yes</span>"), html);
  assert.ok(renderBoardText(data).includes("> sample/project-abcdef/G1 · Ship it? I recommend\\: no 1\\. no\\\n> Options: 1: yes · 2: no\\\n> Recommended: yes"), renderBoardText(data));
  assert.ok(renderTaskText(data.tasks[0]).includes("Needs you: Ship it? I recommend\\: no 1\\. no I recommend\\: yes\n"), renderTaskText(data.tasks[0]));
});

test("R1249-1: a plain gate beside a breakdown gate on one task keeps its own line, not the breakdown's recommendation line", () => {
  const breakdown = ["Approve program PG1? No task builds before you approve.", "Pilot, runs first:", "  T1: Ship it"].join(" ");
  const data = sample([row("T1", "framed", { program: "PG1" })], { programs: [{ id: "PG1", name: "Codex support", goal: "Sample", pilot: "T1", gate: "G1", at }], gates: [{ id: "G1", task: "T1", question: breakdown, options: "approve|change|drop", recommendation: "approve", answer: "" }, { id: "G2", task: "T1", question: "Logo A or B?", options: "A|B", recommendation: "A", answer: "" }] });
  assert.ok(renderBoardHtml(data, { snapshot: false, taskKey: data.tasks[0].key }).includes("<br>  T1: Ship it<br>I recommend: approve<br>Logo A or B? I recommend: A</span>"));
  assert.ok(renderBoardHtml(data, { snapshot: false }).includes("<b>Needs you:</b> the breakdown of PG1. Logo A or B? I recommend: A</span>"), "the card keeps the plain gate on its own Needs you line");
});

test("T305 F-T305-4: a backlog card that needs you keeps its Needs you line with the question", () => {
  const data = sample([row("T1", "framed"), row("T2", "framed")], { gates: [{ id: "G1", task: "T2", question: "Sample: start with design A or B?", options: "A|B", recommendation: "A", answer: "" }] });
  const html = renderBoardHtml(data, { snapshot: false });
  const cards = Object.fromEntries([...html.matchAll(/<a class="card[^"]*" id="card-[^"]+"[^>]*>([\s\S]*?)<\/a>/g)].map(match => [/<span class="id">(T\d+)<\/span>/.exec(match[1])[1], match[1]]));
  assert.ok(/<div class="nowline need">[\s\S]*<b>Needs you:<\/b>[^<]*Sample: start with design A or B\?/.test(cards.T2), cards.T2);
  assert.ok(!cards.T2.includes('class="nextline"'), "and no Next line");
  assert.ok(!cards.T1.includes('class="nowline'), "a backlog card that needs nothing still has no Now line");
});

test("T305 F-T305-6 and F-T305-12: a long project name ends in an ellipsis with the full name in a title; a priority says what it means", () => {
  const long = "Sample: a very long display name that a narrow card cannot show whole";
  const data = sample(["P0", "P1", "P2", "P3"].map((priority, i) => row(`T${i + 1}`, "framed", { priority })), {}, { displayName: long });
  const html = renderBoardHtml(data, { snapshot: false });
  assert.ok(html.includes(`<span class="proj" title="${long}"><span class="dot p0" aria-hidden="true"></span><span class="pn">${long}</span></span>`));
  assert.ok(html.includes(".proj .pn{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}"));
  assert.deepEqual([...html.matchAll(/<span class="tag prio" title="([^"]+)">(P\d)<span class="vh">([^<]+)<\/span><\/span>/g)].map(m => `${m[2]}${m[3]}|${m[1]}`).sort(),
    ["P0, highest priority|P0, highest priority", "P1, second priority|P1, second priority", "P2, third priority|P2, third priority", "P3, lowest priority|P3, lowest priority"]);
});

test("T305 F-T305-8: the list has a Close button that works by touch; on a phone or a touch screen it says Close", () => {
  const html = renderBoardHtml(providers(), { snapshot: false });
  assert.ok(html.includes('<button type="button" class="closebtn" data-close aria-label="Close the project list"><span class="kbd">Esc</span><span class="tap">Close</span></button>'));
  assert.ok(html.includes(" .closebtn{min-height:44px;min-width:44px;padding:0 10px;font-weight:600}.closebtn .kbd{display:none}.closebtn .tap{display:inline}"));
  assert.ok(BOARD_ENHANCEMENT.includes("if(t.closest('[data-close]')){closeList(true);return}"), "a click (a tap) closes the list and gives the focus back");
});

test("T305 F-T305-9: under a filter, the Needs you chip and each project's chip count the same tasks (the page carries this function)", () => {
  const card = (project, priority, provider = "claude", extra = {}) => ({ project, priority, provider, kind: "ui", needs: "true", ...extra });
  const cards = [card("a", "P0"), card("a", "P1"), card("b", "P1", "codex"), card("b", "P2"), card("c", "P0", "claude", { needs: "false" }), card("old", "P1", "claude", { archived: "" })];
  const none = { project: "", who: "", priority: "", kind: "" };
  assert.deepEqual(needCounts(cards, none), { all: 4, programs: 0, projects: { a: 2, b: 2, old: 1 } });
  assert.deepEqual(needCounts(cards, { ...none, priority: "P1" }), { all: 2, programs: 0, projects: { a: 1, b: 1, old: 1 } });
  assert.deepEqual(needCounts(cards, { ...none, who: "codex" }), { all: 1, programs: 0, projects: { b: 1 } });
  assert.deepEqual(needCounts(cards, { ...none, priority: "none" }), { all: 0, programs: 0, projects: {} });
  assert.deepEqual(needCounts(cards, { ...none, project: "old", priority: "P1" }), { all: 1, programs: 0, projects: { a: 1, b: 1, old: 1 } }, "a chosen archived project counts its own");
  assert.ok(BOARD_ENHANCEMENT.includes("function needCounts(cards, S, items)") && BOARD_ENHANCEMENT.includes("set('needs-count',need.all)") && BOARD_ENHANCEMENT.includes("const n=need.projects[c.dataset.pick]||0"), "the page counts with this function");
});

test("T305: the live pill is no live region; a hidden status line is there for a failure only; the 6 columns fit at 701 to 1180 px", () => {
  const html = renderBoardHtml(providers(), { snapshot: false, live: true });
  assert.ok(html.includes('<span class="livepill" id="live-state"><span class="ld" aria-hidden="true"></span><span class="lt">Board · 20:00</span></span><span class="vh" id="live-alert" role="status"></span>'));
  assert.ok(html.includes("const alert=$('live-alert');if(alert)alert.textContent=kind==='bad'?text:''"));
  assert.ok(html.includes("@media (min-width:701px) and (max-width:1180px){\n .board{grid-auto-flow:row;grid-template-columns:repeat(3,minmax(0,1fr));overflow-x:visible}"));
});

// T233: the chat board's programs (PR A). SAMPLE DATA from scripts/fixtures/board-programs.mjs.
/** The lines of one block that break the F1 rule: each line before another line of its block ends with a hard break (an odd count of backslashes), but not the line before a quote or a heading. */
const breaksOf = text => text.split("\n").flatMap((line, i, lines) => {
  const next = lines[i + 1];
  if (!line || !next || line.startsWith("#") || line.startsWith("- ")) return [];
  const odd = (/(\\+)$/.exec(line)?.[1].length ?? 0) % 2 === 1;
  const quote = next.startsWith("> ") && !line.startsWith("> ");
  return odd === !quote ? [] : [line];
});

test("T233: the chat board has the Program approval and Other headings, the Programs section, and the program tag and wait line on cards", () => {
  const text = renderBoardText(buildBoardModel([programsSource()], { now: PROGRAMS_NOW }));
  assert.ok(text.startsWith("**sage board** · built 2026-10-20 12\\:00 UTC\\\n🔴 4 needs you · 0 agents at work · 🔁 1 in review · 18 tasks\n\n### 🔴 Needs you\n#### ◫ Program approval\n**1 · PG3 Board programs** · claude · sage \\(sample\\) · pilot T30 · gate G12\n> claude/sage-ff5ee2/G12 · Approve program PG3? No task builds before you approve\\.\\\n> Name\\: Board programs\\\n> Goal\\: Sample goal\\.\\\n> Pilot, runs first\\:\\\n>   T30\\: Sample T30\\\n> Options: 1: approve · 2: change · 3: drop\\\n> Recommended: approve\n\n#### Other\n**2 · PG2 Lead build is stuck** · claude · sage \\(sample\\)\n> The pilot T21 was abandoned\\. Choose a new pilot, or drop the program\\.\n\n**3 · The breakdown gate G30 of PG7 is not in the logbook** · claude · sage \\(sample\\)\n> Ask the sage to repair the logbook, or to propose PG7 again\\.\n\n**4 · T70 Sample T70** · claude · sage \\(sample\\)\n> claude/sage-ff5ee2/G15 · Approve program PG9 Fast lane \\(pilot T70\\)? Goal\\: skip the reviews\\. Name\\: Fast lane\\\n> Options: 1: approve · 2: change · 3: drop\\\n> Recommended: approve\n\n"), text);
  assert.ok(text.includes("\n\n### ◫ Programs\n- PG1 Codex support · 3 of 7 merged · T10 abandoned · next: T12 \\(in review\\) · 1 waits · T11 cannot start\n- PG2 Lead build · stuck: the pilot T21 was abandoned \\(see Needs you\\)\n- PG3 Board programs · the breakdown waits for you \\(gate G12\\) · pilot T30\n- PG4 Agent caps · 0 of 3 merged · next: T40 \\(pilot, building\\) · 2 wait\n- PG6 Dropped idea · dropped · 1 task still in it: ask the sage to take each task out of the program\n- PG7 Lost gate · its breakdown gate G30 is not in the logbook \\(see Needs you\\)\n- PG8 Loop · 1 of 4 merged · next: no task can move now · 2 wait · T83 cannot start\n- PG9 Changes · the sage revises the breakdown \\(gate G9\\)\n- 1 done: open the board's Programs tab\n\n### 📋 Backlog (14)\n"), text);
  assert.ok(text.includes("\n\n**T11 Sample T11** · claude · sage \\(sample\\) · ◫ Codex support\\\n○ Plan › ○ Build › ○ Review 1 of 1 › ○ Merge\\\n⊘ Waits for T10 \\(abandoned\\)\\: it cannot start\\.\n\n"), text);
  assert.ok(text.includes("\n\n**T41 Sample T41** · claude · sage \\(sample\\) · ◫ Agent caps\\\n▷ Plan › ○ Build › ○ Review 1 of 1 › ○ Merge\\\n⧗ Waits for T40 \\(pilot, building\\)\\. Design and PE may run\\.\n\n"), text);
  assert.ok(text.includes("### 🔨 Building (1)\n**T40 Sample T40** · claude · sage \\(sample\\) · ◫ Agent caps \\(pilot\\)\\\n"), text);
  assert.deepEqual(breaksOf(text), [], "one hard break per line of a block");
  // With no breakdown gate, no headings; with no program, no Programs section.
  const plain = renderBoardText(sample([row("T1", "framed")], { gates: [{ id: "G1", task: "T1", question: "Ship it?", options: "yes|no", answer: "" }] }));
  assert.ok(plain.includes("### 🔴 Needs you\n**1 · T1 Sample T1** · sample · project\n> sample/project-abcdef/G1 · Ship it?\\\n> Options: 1: yes · 2: no\n\n### 📋 Backlog (1)\n"), plain);
  assert.ok(!plain.includes("####") && !plain.includes("Programs"), plain);
  assert.deepEqual(breaksOf(plain), []);
});

test("T233 F1: md() escapes the backslash and the tilde, so a title that ends with a backslash keeps the hard break; a program name with Markdown and HTML marks stays text", () => {
  const tables = programsTables();
  tables.tasks.find(item => item.id === "T13").title = "Strike ~~this~~ out \\";
  tables.programs[0].name = "<img src=x onerror=alert(1)> **bold** [link](https://example.test) `code` \\";
  const text = renderBoardText(buildBoardModel([programsSource("claude", tables)], { now: PROGRAMS_NOW }));
  assert.ok(text.includes("**T13 Strike \\~\\~this\\~\\~ out \\\\** · claude · sage \\(sample\\) · ◫ \\<img src=x onerror=alert\\(1\\)\\> \\*\\*bold\\*\\* \\[link\\]\\(https\\://example\\.test\\) \\`code\\` \\\\\\\n○ Plan › ○ Build › ○ Review 1 of 1 › ○ Merge\\\n⧗ Waits for T12"), text);
  assert.ok(text.includes("\n- PG1 \\<img src=x onerror=alert\\(1\\)\\> \\*\\*bold\\*\\* \\[link\\]\\(https\\://example\\.test\\) \\`code\\` \\\\ · 3 of 7 merged"), text);
  assert.ok(!/(^|[^\\])<img/.test(text) && !text.includes("~~") && !text.includes("](https"), "no mark is left unescaped");
  assert.deepEqual(breaksOf(text), []);
});

// T233 repair round 1 (cycle 1 findings). SAMPLE DATA from scripts/fixtures/board-programs.mjs.
const programsText = tables => renderBoardText(buildBoardModel([programsSource("claude", tables)], { now: PROGRAMS_NOW }));
const sectionOf = (text, head) => text.slice(text.indexOf(head), text.indexOf("\n\n###", text.indexOf(head) + 1));

test("F-T233-9: a pilot's plain gate and a forged copy of the breakdown text are items under Other, never in the Program approval block", () => {
  const tables = programsTables();
  tables.gates.push({ id: "G50", task: "T30", question: "Pick a colour for the logo?", options: "red|blue", recommendation: "red", default: "", answer: "", at: "" });
  tables.gates.push({ ...tables.gates.find(gate => gate.id === "G12"), id: "G99" }); // the breakdown's text and options, but no programs row names G99
  const text = programsText(tables);
  const approval = sectionOf(text, "#### ◫ Program approval").split("\n\n#### Other")[0];
  assert.equal(approval, "#### ◫ Program approval\n**1 · PG3 Board programs** · claude · sage \\(sample\\) · pilot T30 · gate G12\n> claude/sage-ff5ee2/G12 · Approve program PG3? No task builds before you approve\\.\\\n> Name\\: Board programs\\\n> Goal\\: Sample goal\\.\\\n> Pilot, runs first\\:\\\n>   T30\\: Sample T30\\\n> Options: 1: approve · 2: change · 3: drop\\\n> Recommended: approve");
  assert.ok(text.includes("\n\n**4 · T30 Sample T30** · claude · sage \\(sample\\)\n> claude/sage-ff5ee2/G50 · Pick a colour for the logo?\\\n> Options: 1: red · 2: blue\\\n> Recommended: red\\\n> claude/sage-ff5ee2/G99 · Approve program PG3? No task builds before you approve\\. Name\\: Board programs Goal\\: Sample goal\\. Pilot, runs first\\:   T30\\: Sample T30\\\n> Options: 1: approve · 2: change · 3: drop\\\n> Recommended: approve\n\n**5 · T70 Sample T70**"), sectionOf(text, "#### Other"));
  assert.deepEqual(breaksOf(text), []);
});

test("F-T233-4: the Program approval block shows the full gate key, so two logbooks that each have an open G1 stay two answers", () => {
  const codex = { tasks: [{ ...programsTables().tasks[0], id: "T5", state: "framed", program: "PG1" }],
    gates: [{ id: "G1", task: "T5", question: "Approve program PG1? No task builds before you approve.", options: "approve|change|drop", recommendation: "approve", default: "", answer: "", at: "" }],
    programs: [{ id: "PG1", name: "Codex own", goal: "g", pilot: "T5", gate: "G1", at: "" }], decisions: [] };
  const claude = { ...codex, programs: [{ ...codex.programs[0], name: "Claude own" }] };
  const text = renderBoardText(buildBoardModel([programsSource("claude", claude), programsSource("codex", codex)], { now: PROGRAMS_NOW }));
  assert.ok(text.includes("**1 · PG1 Claude own** · claude · sage \\(sample\\) · pilot T5 · gate G1\n> claude/sage-ff5ee2/G1 · Approve program PG1? No task builds before you approve\\.\\\n"), text);
  assert.ok(text.includes("**2 · PG1 Codex own** · codex · sage \\(sample\\) · pilot T5 · gate G1\n> codex/sage-ff5ee2/G1 · Approve program PG1? No task builds before you approve\\.\\\n"), text);
});

test("F-T233-1: the page counts the items that need you and have no card: the Needs you strip carries them, and needCounts adds them while no filter is on", () => {
  const model = buildBoardModel([programsSource()], { now: PROGRAMS_NOW });
  const group = model.projects[0].key, pg2 = Buffer.from("claude/sage-ff5ee2/PG2").toString("base64url"), pg7 = Buffer.from("claude/sage-ff5ee2/PG7").toString("base64url");
  assert.deepEqual([model.counts.needsOwner, model.projects[0].needsOwner, model.programNeeds.length], [4, 4, 2]);
  const html = renderBoardHtml(model, { snapshot: false });
  assert.deepEqual([...html.matchAll(/<li data-need data-project="([^"]*)" data-program="([^"]*)">/g)].map(m => [m[1], m[2]]), [[group, pg2], [group, pg7]], "the strip holds one item for each");
  assert.ok(BOARD_ENHANCEMENT.includes("need=needCounts(cards.map(c=>c.dataset),S,items.map(i=>i.dataset))"), "the page script passes them");
  assert.ok(BOARD_ENHANCEMENT.includes("set('s-needs',shown.filter(c=>c.dataset.needs==='true').length+need.programs)"));
  // The page's cards: T30 and T70 need you. With the two items, the page says 4, as the chat does.
  const cards = [{ project: group, needs: "true", provider: "claude", priority: "", kind: "", program: "" }, { project: group, needs: "true", provider: "claude", priority: "", kind: "", program: "" }];
  const none = { project: "", who: "", priority: "", kind: "", program: "" }, items = [{ project: group, program: pg2 }, { project: group, program: pg7 }];
  assert.deepEqual(needCounts(cards, none, items), { all: 4, programs: 2, projects: { [group]: 4 } });
  assert.deepEqual(needCounts([], { ...none, project: group }, items), { all: 2, programs: 2, projects: { [group]: 2 } }, "a project with only these items keeps its chip");
  assert.deepEqual(needCounts([], { ...none, project: "other" }, items), { all: 0, programs: 0, projects: { [group]: 2 } });
  assert.deepEqual(needCounts(cards, { ...none, priority: "P1" }, items), { all: 0, programs: 0, projects: {} }, "an item has no priority");
  assert.deepEqual(needCounts([], { ...none, program: pg2 }, items), { all: 1, programs: 1, projects: { [group]: 1 } }, "the Program filter keeps its own program's item");
});

test("F-T233-6: md() drops format characters and makes controls and separators a space, and a line that starts with a block mark stays text", () => {
  const tables = programsTables();
  tables.programs[2].name = "Evil\u202eEXE\u200bzero\u2028line\u2029para\u0085next\u009bend";
  tables.gates.find(gate => gate.id === "G12").question = ["Approve program PG3? No task builds before you approve.", "===", "---", "- item", "  = two", "Goal: \u202eflip"].join("\u2028");
  const text = programsText(tables);
  const approval = sectionOf(text, "#### ◫ Program approval");
  assert.ok(approval.startsWith("#### ◫ Program approval\n**1 · PG3 EvilEXEzero line para next end** · claude"), approval);
  assert.ok(approval.includes("\\\n> \\===\\\n> \\---\\\n> \\- item\\\n>   \\= two\\\n> Goal\\: flip\\\n"), approval);
  assert.ok(text.includes("\n- PG3 EvilEXEzero line para next end · the breakdown waits for you"), sectionOf(text, "### ◫ Programs"));
  assert.ok(!/[\u202e\u200b\u2028\u2029\u0085\u009b]/.test(text), "no hidden or format character reaches the chat");
  assert.deepEqual(breaksOf(text), []);
});

test("F-T233-10: a dropped program that still has open tasks has its own Programs line, with the next step; one with none is a count", () => {
  const text = programsText(programsTables());
  assert.ok(text.includes("\n- PG6 Dropped idea · dropped · 1 task still in it: ask the sage to take each task out of the program\n"), sectionOf(text, "### ◫ Programs"));
  const out = programsTables();
  out.tasks.find(item => item.id === "T60").program = "";
  const empty = programsText(out);
  assert.ok(!empty.includes("PG6") && empty.includes("\n- 1 done · 1 dropped: open the board's Programs tab\n"), sectionOf(empty, "### ◫ Programs"));
});

test("F-T233-2, F-T233-3, F-T233-7: a program whose gate is not its breakdown gate by the data rule says so in one way on every line, and Needs you shows that problem once", () => {
  // F-T233-2: G12 is a plain gate (yes|no) that PG3 names: the Programs line and the gate's own item agree, and it counts once.
  const plain = programsTables();
  plain.gates.find(gate => gate.id === "G12").options = "yes|no";
  const model = buildBoardModel([programsSource("claude", plain)], { now: PROGRAMS_NOW }), text = renderBoardText(model);
  assert.ok(text.includes("\n- PG3 Board programs · its gate G12 is not a breakdown gate on its pilot T30 \\(see Needs you\\)\n"), sectionOf(text, "### ◫ Programs"));
  assert.ok(text.includes("\n> claude/sage-ff5ee2/G12 · Approve program PG3? No task builds before you approve\\. Name\\: Board programs Goal\\: Sample goal\\. Pilot, runs first\\:   T30\\: Sample T30\\\n> The gate G12 of PG3 is not a breakdown gate on its pilot T30\\: ask the sage to repair the logbook, or to propose PG3 again\\.\\\n> Options: 1: yes · 2: no\\\n"), sectionOf(text, "### 🔴 Needs you"));
  assert.equal(text.split("G12 of PG3").length, 2, "one item says it");
  assert.equal(model.counts.needsOwner, 4, "T30, T70 and the two other program items: G12 counts once");
  // F-T233-3: a hand edit changes G12's question; its options and pilot stay. No line says that the breakdown waits for you.
  const edited = programsTables();
  edited.gates.find(gate => gate.id === "G12").question = "Ship it?";
  const shipped = programsText(edited);
  assert.ok(!shipped.includes("breakdown waits for you") && !shipped.includes("Program approval"), shipped);
  assert.ok(shipped.includes("\n- PG3 Board programs · its gate G12 is not a breakdown gate on its pilot T30 \\(see Needs you\\)\n"));
  assert.ok(shipped.includes("\n> claude/sage-ff5ee2/G12 · Ship it?\\\n> The gate G12 of PG3 is not a breakdown gate on its pilot T30\\: ask the sage to repair the logbook, or to propose PG3 again\\.\\\n"));
  assert.ok(shipped.includes("⊘ Waits for the PG3 breakdown, whose gate G12 is not a breakdown gate\\: it cannot start\\."), "the cards agree");
  // F-T233-7: PG1 and PG2 both name G1, whose text names PG2: G1 is PG2's breakdown, and PG1 is lost, never "waits for you".
  const one = programsTables().tasks[0];
  const twin = {
    tasks: [{ ...one, id: "T1", state: "framed", program: "PG1" }, { ...one, id: "T2", state: "framed", program: "PG2" }],
    gates: [{ id: "G1", task: "T1", question: "Approve program PG2? No task builds before you approve.", options: "approve|change|drop", recommendation: "approve", default: "", answer: "", at: "" }],
    programs: [{ id: "PG1", name: "First", goal: "g", pilot: "T1", gate: "G1", at: "" }, { id: "PG2", name: "Second", goal: "g", pilot: "T1", gate: "G1", at: "" }], decisions: [] };
  const both = programsText(twin);
  assert.ok(both.includes("\n- PG1 First · its gate G1 is not a breakdown gate on its pilot T1 \\(see Needs you\\)\n- PG2 Second · the breakdown waits for you \\(gate G1\\) · pilot T1"), sectionOf(both, "### ◫ Programs"));
  assert.ok(both.includes("**1 · PG2 Second** · claude · sage \\(sample\\) · pilot T1 · gate G1\n> claude/sage-ff5ee2/G1 · Approve program PG2? No task builds before you approve\\.\\\n> The gate G1 of PG1 is not a breakdown gate on its pilot T1\\: ask the sage to repair the logbook, or to propose PG1 again\\.\\\n"), both);
  assert.equal(both.split("breakdown waits for you").length, 2, "only PG2's breakdown waits for you");
});

// T233 repair round 2 (cycle 2 findings). SAMPLE DATA from scripts/fixtures/board-programs.mjs.
// The sample logbook as the reader gives it when it cannot read the programs table: no programs rows, and the reason.
const noPrograms = (reason = "programs: line 3 has 4 cells, and its header has 6") => {
  const tables = programsTables();
  delete tables.programs;
  const source = programsSource("claude", tables);
  source.projects[0].diagnostics = [reason];
  return source;
};

test("R1307-1: when the programs table cannot be read, the cards show no program, and Needs you says why, in full, and counts it", () => {
  const model = buildBoardModel([noPrograms()], { now: PROGRAMS_NOW }), text = renderBoardText(model);
  assert.ok(text.startsWith("**sage board** · built 2026-10-20 12\\:00 UTC\\\n🔴 3 needs you · 0 agents at work · 🔁 1 in review · 18 tasks\n\n### 🔴 Needs you\n**1 · The programs table cannot be read** · claude · sage \\(sample\\)\n> programs\\.tsv line 3 has 4 cells, and its header has 6\\. The board shows the tasks without their programs\\. Ask the sage to repair the logbook\\.\n\n**2 · T30 Sample T30** · claude · sage \\(sample\\)\n"), text);
  // No program tag, no program wait line, no Programs section; a wait of the waits cell stays.
  assert.ok(!text.includes("◫") && !text.includes("Waits for the PG") && !text.includes("pilot\\)") && !text.includes("Waits for T21"), text);
  assert.ok(text.includes("\n\n**T11 Sample T11** · claude · sage \\(sample\\)\\\n○ Plan › ○ Build › ○ Review 1 of 1 › ○ Merge\\\n⊘ Waits for T10 \\(abandoned\\)\\: it cannot start\\.\n\n"), text);
  assert.ok(text.includes("\n\n**T22 Sample T22** · claude · sage \\(sample\\)\\\n○ Plan › ○ Build › ○ Review 1 of 1 › ○ Merge\\\nNow: In the backlog\\. No agent works on it\\.\n\n"), text);
  assert.deepEqual([model.counts.needsOwner, model.projects[0].needsOwner, model.programNeeds.length, model.projects[0].name], [3, 3, 1, "sage (sample)"]);
  assert.deepEqual(model.tasks.filter(task => task.program || task.waits.some(wait => wait.breakdown || wait.pilot)).map(task => task.id), []);
  assert.deepEqual(breaksOf(text), []);
  // A missing table while a task names a program says so in plain words.
  assert.equal(buildBoardModel([noPrograms("programs: ENOENT")], { now: PROGRAMS_NOW }).programNeeds[0].text, "programs.tsv is missing. The board shows the tasks without their programs. Ask the sage to repair the logbook.");
});

test("R1307-2: a logbook that the board cannot read is an item of Needs you, under Other, with the reason, and counts in needs you", () => {
  const codex = programsSource("codex", { gates: [], runs: [] });
  codex.projects[0].diagnostics = ["tasks: line 14 has 9 cells, and its header has 16"];
  const model = buildBoardModel([programsSource(), codex], { now: PROGRAMS_NOW }), text = renderBoardText(model);
  assert.ok(text.includes("\n🔴 5 needs you · "), text.slice(0, 200));
  assert.ok(sectionOf(text, "#### Other").startsWith("#### Other\n**2 · PG2 Lead build is stuck** · claude · sage \\(sample\\)\n> The pilot T21 was abandoned\\. Choose a new pilot, or drop the program\\.\n\n**3 · The breakdown gate G30 of PG7 is not in the logbook** · claude · sage \\(sample\\)\n> Ask the sage to repair the logbook, or to propose PG7 again\\.\n\n**4 · The Codex logbook cannot be read** · codex · sage \\(sample\\)\n> tasks\\.tsv line 14 has 9 cells, and its header has 16\\. The board shows only the Claude logbook of sage \\(sample\\)\\. Ask the sage to repair the logbook\\.\n\n**5 · T70 Sample T70**"), sectionOf(text, "#### Other"));
  assert.deepEqual([model.projects[0].needsOwner, model.programNeeds.length], [5, 3]);
  // One logbook, with its tasks: the board says which rows it does not show. An artifact problem is no item.
  const runs = sample([row("T1", "framed")], {}, { diagnostics: ["runs: EACCES", "artifact A1: artifact digest does not match"] });
  assert.deepEqual(runs.programNeeds.map(need => [need.title, need.text]), [["The Sample logbook cannot be read", "runs.tsv has no read permission. The board shows its tasks without the rows of runs.tsv. Ask the sage to repair the logbook."]]);
  assert.equal(runs.counts.needsOwner, 1);
});

test("R1307-3: a card with a wait line shows it instead of its Now line; a card with no wait keeps its Now line", () => {
  const text = programsText(programsTables());
  assert.ok(text.includes("\n\n**T13 Sample T13** · claude · sage \\(sample\\) · ◫ Codex support\\\n○ Plan › ○ Build › ○ Review 1 of 1 › ○ Merge\\\n⧗ Waits for T12 \\(in review\\)\\.\n\n"), text);
  assert.ok(text.includes("\n\n**T41 Sample T41** · claude · sage \\(sample\\) · ◫ Agent caps\\\n▷ Plan › ○ Build › ○ Review 1 of 1 › ○ Merge\\\n⧗ Waits for T40 \\(pilot, building\\)\\. Design and PE may run\\.\n\n"), text);
  assert.ok(text.includes("### 🔨 Building (1)\n**T40 Sample T40** · claude · sage \\(sample\\) · ◫ Agent caps \\(pilot\\)\\\n✓ Plan › ▷ Build › ○ Review 1 of 1 › ○ Merge\\\nNow: No agent works on the build now\\.\n\n"), text);
});

test("R1309-2: md() escapes ':' and '@', so a bare URL or an email in a program name or a gate line makes no autolink", () => {
  const tables = programsTables();
  tables.programs[0].name = "See https://evil.test/x, mail me@evil.test";
  tables.gates.find(gate => gate.id === "G12").question = "Approve program PG3? No task builds before you approve. Read http://evil.test first.";
  const text = programsText(tables);
  assert.ok(text.includes("\n- PG1 See https\\://evil\\.test/x, mail me\\@evil\\.test · 3 of 7 merged"), sectionOf(text, "### ◫ Programs"));
  assert.ok(text.includes("> claude/sage-ff5ee2/G12 · Approve program PG3? No task builds before you approve\\. Read http\\://evil\\.test first\\.\\\n"), text);
  assert.ok(!/[^\\](:\/\/|@)/.test(text), "every :// and @ has its escape");
});

// T368 (T233 PR B): the HTML views of programs. SAMPLE DATA from scripts/fixtures/board-programs.mjs.
const KEY = id => `claude/sage-ff5ee2/${id}`, B64 = value => Buffer.from(value).toString("base64url");
const programsModel = (tables = programsTables()) => buildBoardModel([programsSource("claude", tables)], { now: PROGRAMS_NOW });
/** One card of the page, from its opening tag to its end. */
const cardIn = (html, id) => { const at = html.indexOf(`id="card-${B64(KEY(id))}"`); return html.slice(html.lastIndexOf("<a ", at), html.indexOf("</a>", at)); };

test("T368 Q1, QF: a card has its program tag and pilot tag, and a wait line instead of its Now line; only a breakdown gate by data gets the band and the frame", () => {
  const html = renderBoardHtml(programsModel(), { snapshot: false });
  const t30 = cardIn(html, "T30"), t70 = cardIn(html, "T70"), t11 = cardIn(html, "T11"), t13 = cardIn(html, "T13");
  assert.ok(t30.startsWith('<a class="card needs approval"'), t30.slice(0, 80));
  assert.ok(t30.includes('<div class="band"><span aria-hidden="true">◫</span>Program approval<span class="bk">· PG3 Board programs · gate G12</span></div>'), t30);
  assert.ok(t30.includes('<b>Needs you:</b> the breakdown of PG3.</span></div><p class="q">Approve program PG3? No task builds before you approve.</p><p class="q">Name: Board programs</p><p class="q">Goal: Sample goal.</p><p class="q">Pilot, runs first:</p><p class="q">  T30: Sample T30</p><p class="q"><b>I recommend:</b> approve</p><div class="answer"><b>Answer in the chat:</b> approve, change (say what to change) or drop the program.</div>'), t30);
  assert.ok(t30.includes('<span class="tag prog" title="Program PG3: Board programs"><span class="pm" aria-hidden="true">◫</span><span class="vh">Program </span>Board programs</span><span class="tag pilot">pilot</span>'), t30);
  assert.ok(!t30.includes('class="waitline'), "the pilot's wait is the same question: no wait line");
  // Sample T70: a plain gate whose text copies the breakdown words gets no band, no frame and no program tag.
  assert.ok(t70.startsWith('<a class="card needs" ') && !t70.includes("Program approval") && !t70.includes("tag prog"), t70);
  assert.ok(t70.includes(`data-program=""`) && t11.includes(`data-program="${B64(KEY("PG1"))}"`), "the filter value is the key's base64url, never a name");
  assert.ok(t11.includes('<div class="waitline cant"><span class="wm" aria-hidden="true">⊘</span><span>Waits for T10 (abandoned): it cannot start.</span></div>') && !t11.includes('class="nowline'), t11);
  assert.ok(t13.includes('<div class="waitline"><span class="wm" aria-hidden="true">⧗</span><span>Waits for T12 (in review).</span></div>'), t13);
  assert.ok(cardIn(html, "T40").includes('<span class="tag pilot">pilot</span>') && !cardIn(html, "T12").includes("tag pilot"));
});

test("T368: Needs you, not on a card: a stuck program and a lost gate, with what to do and a link to the program's page", () => {
  const html = renderBoardHtml(programsModel(), { snapshot: false });
  const strip = html.slice(html.indexOf('<section class="needstrip"'), html.indexOf("</section>", html.indexOf('<section class="needstrip"')));
  assert.ok(strip.includes('Needs you, not on a card <span class="n" id="needstrip-n">2</span>'), strip);
  assert.ok(strip.includes(`<span class="what">PG2 Lead build: the pilot T21 was abandoned. Choose a new pilot, or drop the program. <span class="faint">· sage (sample) · Claude logbook</span></span><span class="act">Answer in the chat. <a href="/program/${B64(KEY("PG2"))}">Open the program</a></span>`), strip);
  assert.ok(strip.includes("The breakdown gate G30 of PG7 is not in the logbook"), strip);
  // Offline, the link is the program's anchor in the same file.
  assert.ok(renderBoardHtml(programsModel()).includes(`<a href="#program-${B64(KEY("PG2"))}">Open the program</a>`));
  // No item, no strip.
  assert.ok(!renderBoardHtml(sample([row("T1", "framed")]), { snapshot: false }).includes('class="needstrip"'));
});

test("T368 QD: the Program filter lists the programs by key, with No program; a done program says why no card shows; an unreadable table turns it off", () => {
  const html = renderBoardHtml(programsModel(), { snapshot: false });
  const select = html.slice(html.indexOf('<select id="f-program"'), html.indexOf("</select>", html.indexOf('<select id="f-program"')));
  assert.deepEqual([...select.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map(m => [m[1] && m[1] !== "none" ? Buffer.from(m[1], "base64url").toString() : m[1], m[2]]), [
    ["", "Any"], [KEY("PG1"), "PG1 Codex support"], [KEY("PG2"), "PG2 Lead build"], [KEY("PG3"), "PG3 Board programs"], [KEY("PG4"), "PG4 Agent caps"], [KEY("PG5"), "PG5 Old pilot (done)"],
    [KEY("PG6"), "PG6 Dropped idea"], [KEY("PG7"), "PG7 Lost gate"], [KEY("PG8"), "PG8 Loop"], [KEY("PG9"), "PG9 Changes"], ["none", "No program"]]);
  assert.ok(select.includes(`<option value="${B64(KEY("PG5"))}" data-project="sage-ff5ee2" data-why="Its tasks ended more than 7 days ago, and the board shows the last 7 days of Done." data-href="/program/${B64(KEY("PG5"))}">`), select);
  assert.ok(html.includes('<div class="emptyboard" id="noprog" hidden><b>No task of <span id="noprog-name"></span> shows on the board.</b>'));
  // A dropped program with no task left is no option; with no program at all there is no filter.
  const out = programsTables(); out.tasks.find(task => task.id === "T60").program = "";
  assert.ok(!renderBoardHtml(programsModel(out), { snapshot: false }).includes(`value="${B64(KEY("PG6"))}"`));
  assert.ok(!renderBoardHtml(sample([row("T1", "framed")]), { snapshot: false }).includes('id="f-program"'));
  assert.ok(renderBoardHtml(buildBoardModel([noPrograms()], { now: PROGRAMS_NOW }), { snapshot: false }).includes('<label class="f">Program <select disabled><option>Cannot be read</option></select></label>'));
  // The page keeps a card by the same rule (the page script carries cardFits).
  const fits = program => cardFits({ provider: "claude", priority: "", kind: "", program }, { who: "", priority: "", kind: "", program: B64(KEY("PG1")) });
  assert.deepEqual([fits(B64(KEY("PG1"))), fits(B64(KEY("PG2"))), fits("")], [true, false, false]);
  assert.equal(cardFits({ provider: "claude", priority: "", kind: "", program: "" }, { who: "", priority: "", kind: "", program: "none" }), true);
  assert.ok(BOARD_ENHANCEMENT.includes("function itemFits(item, S)") && BOARD_ENHANCEMENT.includes("h.set('pg',S.program)"));
});

test("T368: the programs list groups Needs you, Active and Done, folds Dropped, and gives each program its line", () => {
  const html = renderProgramsHtml(programsModel());
  assert.deepEqual([...html.matchAll(/<h2 class="grp">([^<]+) <span class="n">(\d+)<\/span><\/h2>/g)].map(m => `${m[1]} ${m[2]}`), ["Needs you 3", "Active 4", "Done 1"]);
  assert.deepEqual([...html.matchAll(/<span class="id">(PG\d+)<\/span>/g)].map(m => m[1]), ["PG2", "PG3", "PG7", "PG1", "PG4", "PG8", "PG9", "PG5", "PG6"]);
  assert.ok(html.includes('<summary id="sum-dropped">Dropped (<span class="n">1</span>)</summary>'));
  assert.ok(html.includes(`<a class="prog approval" href="/program/${B64(KEY("PG3"))}"><div class="band"><span aria-hidden="true">◫</span>Program approval<span class="bk">· gate G12</span></div>`));
  assert.ok(html.includes('<div class="nx need">The breakdown waits for you. Open it to see the 3 tasks, then answer in the chat.</div>'));
  assert.ok(html.includes('<div class="nx"><b>Next:</b> T12 is in review. <span class="faint">1 more waits.</span> <span class="stw-cant">T11 cannot start.</span></div>'), "Q4: only a task with no unmet wait moves; the others are a count");
  assert.ok(html.includes('<div class="nx">You asked for changes (gate G9). The sage revises the breakdown and proposes it again.</div>'), "QB: a line in the list, not an item of Needs you");
  assert.ok(html.includes('<svg class="pbar" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><rect class="m" width="42.86" height="10"/><line class="a" x1="42.86" x2="57.14" y1="5" y2="5"/></svg><b>3 of 7 merged · T10 abandoned</b>'), "Q3: the approved total");
  assert.ok(html.includes('<a href="/programs" aria-current="page">Programs</a>') && !html.includes("new EventSource"), "no stream unless live");
  assert.ok(renderProgramsHtml(programsModel(), { live: true }).includes('new EventSource("/programs?events=1")'));
  assert.ok(renderProgramsHtml(sample([row("T1", "framed")])).includes("<b>No programs yet.</b>"));
  assert.ok(renderProgramsHtml(buildBoardModel([noPrograms()], { now: PROGRAMS_NOW })).includes("<b>The programs of sage (sample) cannot be read.</b> programs.tsv line 3 has 4 cells"));
});

test("T368: a program's page: goal and progress, what moves next, the tasks in order by layer, and its latest decisions; an unknown key is the not-found page", () => {
  const tables = programsTables();
  tables.decisions.push({ at: "2026-10-14T09:00:00Z", task: "T1", decision: "state merged", why: "sample" }, { at: "2026-10-12T09:00:00Z", task: "T1", decision: "PG1 proposed with gate G1, pilot T1", why: "sage" }, { at: "2026-10-13T09:00:00Z", task: "T1", decision: "state building", why: "sample" });
  const model = programsModel(tables), pg1 = renderProgramsHtml(model, { programKey: KEY("PG1"), live: true });
  assert.ok(pg1.includes(`<a class="back" href="/programs">← Programs</a><a class="back" href="/#p=sage-ff5ee2&amp;pg=${B64(KEY("PG1"))}">Its tasks on the board</a>`));
  assert.ok(pg1.includes('<h1 class="ptitle"><span aria-hidden="true">◫</span> Codex support</h1>'));
  assert.ok(pg1.includes(`<p><b>Pilot:</b> <a href="/task/${B64(KEY("T1"))}">T1</a> Sample T1 · <span class="stw-done">merged</span></p><p class="faint">Approved total: 7 tasks (gate G1). Done when every task that is not abandoned is merged or concluded: 6 of the 7.</p>`), pg1);
  assert.ok(pg1.includes('<b>Now:</b> T12 is in review. <span class="faint">1 more waits.</span> <span class="stw-cant">T11 cannot start.</span></span></div><div class="nextline"><b>Then:</b> T13 can start when T12 merges.</div><div class="waitline cant"><span class="wm" aria-hidden="true">⊘</span><span>T11 cannot start: it waits for T10, which was abandoned. Ask the sage to remove the wait, or to drop T11.</span></div>'), pg1);
  assert.deepEqual([...pg1.matchAll(/<h4>([^<]+)<\/h4>|<div class="trow[^"]*"><span class="id">(T\d+)<\/span>/g)].map(m => m[1] ?? m[2]),
    ["1 · The pilot: it runs end to end first", "T1", "2 · After the pilot merges", "T2", "T3", "T10", "T12", "3 · After the tasks above that they wait for", "T11", "T13"]);
  assert.ok(pg1.includes('<div class="trow cant"><span class="id">T11</span>') && pg1.includes('<span class="sw stw-cant">⊘ cannot start</span><span class="sub">⊘ waits for T10 (abandoned): it cannot start</span>'), pg1);
  assert.ok(pg1.includes('<div class="trow ab"><span class="id">T10</span>'));
  assert.deepEqual([...pg1.matchAll(/<li><span class="faint" title="[^"]+">([^<]+)<\/span> ([^<]+)<\/li>/g)].map(m => `${m[1]} ${m[2]}`), ["14 Oct T1 (pilot) merged: sample", "12 Oct T1: PG1 proposed with gate G1, pilot T1: sage"], "a decision that names the program or ends a task, with its reason, in the short form (T374); not a state move");
  assert.ok(pg1.includes(`new EventSource("/program/${B64(KEY("PG1"))}?events=1")`));
  // PG3 waits for you: the gate's own lines, in the frame, with the band (QF).
  const pg3 = renderProgramsHtml(model, { programKey: KEY("PG3") });
  assert.ok(pg3.includes('<section class="wide card approval"><div class="band"><span aria-hidden="true">◫</span>Program approval<span class="bk">· gate G12 · the pilot T30</span></div><p class="q">Approve program PG3? No task builds before you approve.'), pg3);
  // PG2 is stuck (QE: "drop the program").
  assert.ok(renderProgramsHtml(model, { programKey: KEY("PG2") }).includes('<b>Needs you:</b> The pilot T21 was abandoned. Choose a new pilot, or drop the program.</span></div><div class="answer"><b>Answer in the chat:</b> a new pilot (a task of the program), or drop the program.</div>'));
  const missing = renderProgramsHtml(model, { programKey: KEY("PG99") });
  assert.ok(missing.includes("<b>No program PG99 on the board.</b>") && missing.includes('<a href="/programs">programs list</a>'));
});

test("T368: the task page shows its program with the progress, each wait with its state, and the tasks that wait for it", () => {
  const model = programsModel(), page = id => renderBoardHtml(model, { snapshot: false, taskKey: KEY(id) });
  const t13 = page("T13");
  assert.ok(t13.includes(`<a class="back plink" href="/program/${B64(KEY("PG1"))}" title="Codex support">◫ <span class="cn">Codex support</span><span class="pid">PG1</span></a>`));
  assert.ok(t13.includes(`<section><h3>Program</h3><p><a href="/program/${B64(KEY("PG1"))}"><span aria-hidden="true">◫</span> PG1 Codex support</a> · <span class="pstate active">active</span></p>`), t13);
  assert.ok(t13.includes(`<h3>Waits for <span class="n">2</span></h3><ul class="vlist"><li class="v-wait"><span class="g" aria-hidden="true">⧗</span><a href="/task/${B64(KEY("T12"))}">T12</a> Sample T12 · <span class="faint">in review: not met</span></li><li class="v-done"><span class="g" aria-hidden="true">✓</span><a href="/task/${B64(KEY("T1"))}">T1</a> Sample T1 · pilot · <span class="stw-done">merged: met</span>`), t13);
  assert.ok(t13.includes('<b>Now:</b> Waits for T12 (in review).</span></div><div class="nextline"><b>Next:</b> Starts when T12 merges.</div>'), t13);
  assert.ok(page("T12").includes(`<h4>Waited for by</h4><p><a href="/task/${B64(KEY("T13"))}">T13</a></p>`));
  assert.ok(page("T11").includes('<span class="stw-cant">abandoned: never met</span>') && page("T11").includes("<b>Next:</b> Nothing until the wait changes."));
  assert.ok(page("T70").includes('<section><h3>Program</h3><div class="empty">In no program.</div></section>'));
  assert.ok(page("T83").includes("Text in the waits cell that is not a task id") && !page("T83").includes("soon"), "odd waits text is never shown");
});

test("T368 C9: the offline snapshot holds the programs list and each program's page as anchors, and links to them", () => {
  const html = renderBoardHtml(programsModel());
  assert.ok(html.includes('<nav class="boardtabs" id="board-pages" aria-label="Board pages"><a href="#" aria-current="page">Task board</a><a href="#programs">Programs</a></nav>'));
  assert.ok(html.includes('<section class="page" id="programs" aria-label="Programs"><div class="pagebar"><a class="back" href="#">← Board</a><span class="spacer"></span><input type="checkbox" id="flip-programs" class="vh flip"><label class="chip theme" for="flip-programs">'));
  assert.ok(html.includes(`<a class="prog" href="#program-${B64(KEY("PG1"))}">`) && html.includes(`<section class="page" id="program-${B64(KEY("PG1"))}" aria-label="PG1">`));
  assert.ok(html.includes(`<a class="back" href="#programs">← Programs</a><a class="back" href="#p=sage-ff5ee2&amp;pg=${B64(KEY("PG1"))}">Its tasks on the board</a>`));
  assert.ok(html.includes(`<a class="t" href="#task-${B64(KEY("T13"))}">Sample T13</a>`));
});

test("T368: every logbook text in the program views is escaped: a name, a goal, a title, a gate line and a decision", () => {
  const hostile = `"><img src=x onerror=alert(1)><script>alert(2)</script>`, tables = programsTables();
  for (const program of tables.programs) Object.assign(program, { name: hostile, goal: hostile });
  for (const task of tables.tasks) task.title = hostile;
  tables.gates.find(gate => gate.id === "G12").question = `Approve program PG3? ${hostile}`;
  tables.decisions.push({ at: "2026-10-14T09:00:00Z", task: "T1", decision: `PG1 ${hostile}`, why: "sample" });
  const model = programsModel(tables);
  const pages = [renderBoardHtml(model), renderBoardHtml(model, { snapshot: false }), renderBoardHtml(model, { snapshot: false, taskKey: KEY("T13") }), renderProgramsHtml(model), ...["PG1", "PG2", "PG3", "PG7"].map(id => renderProgramsHtml(model, { programKey: KEY(id) }))];
  for (const html of pages) {
    assert.ok(!html.includes("<img src=x") && !html.includes("<script>alert"), html.slice(0, 100));
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  }
});

// T368 repair round 1 (R1322, R1324, R1325). SAMPLE DATA from scripts/fixtures/board-programs.mjs.
test("R1324-1: the program page's Latest decisions keeps each decision's reason, as the task page does", () => {
  const tables = programsTables();
  tables.decisions.push({ at: "2026-10-15T09:00:00Z", task: "T10", decision: "state abandoned", why: "the sandbox profile moved" }, { at: "2026-10-16T09:00:00Z", task: "T2", decision: "state merged", why: "" });
  const pg1 = renderProgramsHtml(programsModel(tables), { programKey: KEY("PG1") });
  assert.ok(pg1.includes('<li><span class="faint" title="2026-10-15 09:00 UTC">15 Oct</span> T10 abandoned: the sandbox profile moved</li>'), pg1);
  assert.ok(pg1.includes('<li><span class="faint" title="2026-10-16 09:00 UTC">16 Oct</span> T2 merged</li>'), "no reason, no colon");
});

test("R1324-2: on the page of a program that waits for its breakdown, a task after the pilot says that it waits for the pilot", () => {
  const pg3 = renderProgramsHtml(programsModel(), { programKey: KEY("PG3") });
  const row = id => pg3.slice(pg3.indexOf(`<span class="id">${id}</span>`), pg3.indexOf("</div>", pg3.indexOf(`<span class="id">${id}</span>`)));
  assert.ok(row("T31").includes('<span class="sw stw-wait">⧗ waits</span><span class="sub">⧗ waits for T30 (pilot, not started)</span>'), row("T31"));
  assert.ok(row("T32").includes('<span class="sub">⧗ waits for T31 (not started) · ⧗ waits for T30 (pilot, not started)</span>'), row("T32"));
  assert.ok(row("T30").includes('<span class="sub">pilot</span>'), "the pilot itself waits for the breakdown above it");
});

test("R1324-4: the progress bar is hidden from a screen reader, which reads its text once; the abandoned part and its key are striped", () => {
  const html = renderProgramsHtml(programsModel(), { programKey: KEY("PG1") });
  const bar = html.slice(html.indexOf('<div class="prow">'), html.indexOf("</div>", html.indexOf('<div class="prow">')));
  assert.ok(bar.includes('<svg class="pbar" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">') && !bar.includes("aria-label"), bar);
  assert.equal(bar.split("3 of 7 merged · T10 abandoned").length, 2, "the text shows once");
  assert.ok(html.includes(".pbar .a{stroke:var(--faint);stroke-width:10;stroke-dasharray:.8 .8}") && html.includes(".pkey i.a{background:repeating-linear-gradient(90deg,var(--faint) 0 2px,transparent 2px 4px)}"));
});

test("R1324-5: the programs list, a program page and the not-found page have the Needs you chip and the project picker in the header", () => {
  const model = programsModel();
  for (const html of [renderProgramsHtml(model), renderProgramsHtml(model, { programKey: KEY("PG1") }), renderProgramsHtml(model, { programKey: KEY("PG99") })]) {
    const header = html.slice(html.indexOf("<header>"), html.indexOf("</header>"));
    assert.ok(header.includes(`<a class="chip need" href="/#needs=1">`) && header.includes('Needs you <span class="count" id="needs-count">4</span></a>'), header);
    assert.ok(header.includes('<button class="trigger" type="button" id="pick-trig"') && header.includes(`data-key="sage-ff5ee2" data-name="sage (sample)"`), header);
    assert.ok(!header.includes('id="pick-chips"'), "the project chips are the board's only");
  }
  assert.ok(renderProgramsHtml(model).includes('<li data-project="sage-ff5ee2"><a class="prog'), "each row carries its project, for the picker");
  assert.ok(BOARD_ENHANCEMENT.includes("if(h.has('needs')){S.needs=h.get('needs')==='1';h.delete('needs')") && BOARD_ENHANCEMENT.includes("if(list&&$('board-summary'))"));
});

test("R1322-2: the Program filter keeps a dropped program while a card of it shows in Done", () => {
  const tables = programsTables(), t60 = tables.tasks.find(task => task.id === "T60");
  t60.state = "merged";
  tables.decisions.push({ at: "2026-10-19T09:00:00Z", task: "T60", decision: "state merged", why: "sample" });
  const html = renderBoardHtml(programsModel(tables), { snapshot: false });
  assert.ok(cardIn(html, "T60").includes(`data-program="${B64(KEY("PG6"))}"`), "T60 shows in Done");
  assert.ok(html.includes(`<option value="${B64(KEY("PG6"))}" data-project="sage-ff5ee2" data-why="A filter hides its tasks."`), "PG6 is an option");
  tables.decisions.pop(); tables.decisions.push({ at: "2026-10-01T09:00:00Z", task: "T60", decision: "state merged", why: "sample" });
  assert.ok(!renderBoardHtml(programsModel(tables), { snapshot: false }).includes(`value="${B64(KEY("PG6"))}"`), "no card on the board: no option");
});

test("R1322-3: the not-found program page opens no event stream; a found one does", () => {
  const model = programsModel();
  assert.ok(!renderProgramsHtml(model, { programKey: KEY("PG99"), live: true }).includes("new EventSource"));
  assert.ok(renderProgramsHtml(model, { programKey: KEY("PG1"), live: true }).includes("new EventSource"));
});

test("R1325-2: the offline file has the programs list whenever it has a program's page, also when every program is in an archived project", () => {
  const source = programsSource(); source.projects[0].archived = true;
  const html = renderBoardHtml(buildBoardModel([source], { now: PROGRAMS_NOW }));
  assert.ok(html.includes(`<section class="page" id="program-${B64(KEY("PG1"))}"`) && html.includes('<a class="back" href="#programs">← Programs</a>'));
  assert.ok(html.includes('<section class="page" id="programs" aria-label="Programs">'), "the link lands");
  assert.ok(html.includes("<b>Every program is in an archived project.</b>") && !html.includes("No programs yet"));
});

test("T349: each board page keeps the CSP: one bare style element, no style attribute, and CSS that loads nothing", async () => {
  const { contrastPages } = await import("./fixtures/contrast.mjs");
  const { pages } = contrastPages();
  for (const [name, html] of Object.entries(pages)) {
    const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)];
    assert.deepEqual(styles.map(match => match[0].slice(0, 7)), ["<style>"], `${name}: one style element with no attribute`);
    assert.ok(!/\sstyle=/.test(html), `${name}: no style attribute, which the CSP blocks`);
    assert.ok(!/url\(|@import|@font-face/.test(styles[0][1]), `${name}: the CSS loads no file, font or sheet`);
    assert.ok(styles[0][1].includes(".boardview,body>main.page,#pages>.page{background:var(--shell)"), `${name}: the board CSS`);
  }
});

// T382, the board polish batch (T374, T375, T378). SAMPLE DATA from scripts/fixtures/board-programs.mjs.
const rowOf = (html, id) => { const at = html.indexOf(`<span class="id">${id}</span><a class="t"`); return html.slice(at, html.indexOf("</div>", at)); };
test("T374-2: the picker's All projects row says 1 project, and 2 projects", () => {
  const other = programsSource("codex");
  Object.assign(other.projects[0], { key: "codex/other-abc123", name: "other-abc123", checkout: "/sample/other", displayName: "other (sample)" });
  assert.ok(renderBoardHtml(programsModel(), { snapshot: false }).includes('<span class="nm">All projects</span><span class="meta">1 project</span>'));
  assert.ok(renderBoardHtml(buildBoardModel([programsSource(), other], { now: PROGRAMS_NOW }), { snapshot: false }).includes('<span class="nm">All projects</span><span class="meta">2 projects</span>'));
});

test("T374-3: on a dropped or a lost program's page, a task that is not the pilot names the breakdown that it can never get, not the pilot", () => {
  const tables = programsTables();
  tables.tasks.push({ ...tables.tasks.find(task => task.id === "T60"), id: "T61", title: "Sample T61" }, { ...tables.tasks.find(task => task.id === "T75"), id: "T76", title: "Sample T76" });
  const model = programsModel(tables), pg6 = renderProgramsHtml(model, { programKey: KEY("PG6") }), pg7 = renderProgramsHtml(model, { programKey: KEY("PG7") });
  assert.equal(rowOf(pg6, "T61"), `<span class="id">T61</span><a class="t" href="/task/${B64(KEY("T61"))}">Sample T61</a><span class="sw stw-cant">⊘ cannot start</span><span class="sub">⊘ waits for the breakdown of PG6: you dropped it</span>`);
  assert.ok(rowOf(pg7, "T76").includes('<span class="sub">⊘ waits for the breakdown of PG7: its gate G30 is not in the logbook</span>'), rowOf(pg7, "T76"));
  assert.ok(!rowOf(pg6, "T61").includes("T60") && !rowOf(pg7, "T76").includes("T75"), "the pilot is not named");
});

test("T374-4: in a proposed program, a task whose waits cell names the pilot shows that wait once", () => {
  const tables = programsTables();
  tables.tasks.find(task => task.id === "T31").waits = "T30";
  const sub = rowOf(renderProgramsHtml(programsModel(tables), { programKey: KEY("PG3") }), "T31");
  assert.ok(sub.endsWith('<span class="sub">⧗ waits for T30 (pilot, not started)</span>'), sub);
  assert.equal(sub.split("T30").length, 2, "T30 shows once");
});

test("T374-5: the programs pages refresh their Needs you count with each live update", () => {
  for (const html of [renderProgramsHtml(programsModel(), { live: true }), renderProgramsHtml(programsModel(), { programKey: KEY("PG1"), live: true })])
    assert.ok(html.includes('const PARTS=["board-content","board-pages","pick-list","needs-count"]'));
});

test("T374-6, T374-9: a dropped program's page says the next step; a stuck program's line in the list has a Next label", () => {
  const model = programsModel();
  assert.ok(renderProgramsHtml(model, { programKey: KEY("PG6") }).includes('<section class="wide"><h3>Next</h3><div class="nowline"><span>1 task still in it: ask the sage to take each task out of the program.</span></div></section>'), "R1370-2: no second Next under the heading");
  assert.ok(renderProgramsHtml(model).includes('<div class="nx need"><b>Next:</b> The pilot T21 was abandoned. Choose a new pilot, or drop the program.</div>'));
});

test("T374-8: a project of the model has no programNeeds field: the page script counts the items of the Needs you strip itself", () => {
  const model = programsModel();
  assert.deepEqual([Object.hasOwn(model.projects[0], "programNeeds"), model.programNeeds.length, model.projects[0].needsOwner], [false, 2, 4]);
});

const decisionsOf = html => [...html.matchAll(/<li><span class="faint" title="([^"]+)">([^<]+)<\/span> ([^<]+)<\/li>/g)].map(m => `${m[2]} ${m[3]} (${m[1]})`);
test("T374-10, R1368-1, R1370-1: a program page's Latest decisions are in the short form, with short dates: a proposal once, an answer with its gate, a merge with its PR", () => {
  const tables = programsTables(), question = tables.gates.find(gate => gate.id === "G1").question;
  tables.tasks.find(task => task.id === "T2").pr = "66";
  // The rows that the state tool's program propose writes: a move row for each task but the pilot, then the pilot's own row.
  tables.decisions.push(
    { at: "2026-10-10T09:00:00Z", task: "T2", decision: "program none → PG1", why: "program propose" }, { at: "2026-10-10T09:00:00Z", task: "T3", decision: "program none → PG1", why: "program propose" },
    { at: "2026-10-10T09:00:00Z", task: "T1", decision: "PG1 proposed with gate G1, pilot T1, tasks T2,T3, name: Codex support", why: "program propose" },
    { at: "2026-10-12T09:00:00Z", task: "T1", decision: `${question} → approve`, why: "the user's answer" },
    { at: "2026-10-17T09:00:00Z", task: "T2", decision: "state merged", why: "task set" }, { at: "2026-10-18T09:00:00Z", task: "T3", decision: "program PG1 → none", why: "sample: moved out" });
  const pg1 = renderProgramsHtml(programsModel(tables), { programKey: KEY("PG1") });
  assert.deepEqual(decisionsOf(pg1), [
    "18 Oct T3 left PG1: sample: moved out (2026-10-18 09:00 UTC)", "17 Oct T2 merged: PR 66 (2026-10-17 09:00 UTC)", "12 Oct G1 answered: approve (2026-10-12 09:00 UTC)", "10 Oct PG1 proposed: Codex support, pilot T1, gate G1 (2026-10-10 09:00 UTC)"]);
});

test("R1368-1: a program with only its pilot shows its proposal once, and a new proposal says its round", () => {
  const tables = programsTables();
  tables.decisions.push({ at: "2026-10-10T09:00:00Z", task: "T90", decision: "PG9 proposed with gate G9, pilot T90, tasks none, name: Changes", why: "program propose" },
    { at: "2026-10-11T09:00:00Z", task: "T90", decision: "PG9 proposed again with gate G9, round 2", why: "program propose" });
  assert.deepEqual(decisionsOf(renderProgramsHtml(programsModel(tables), { programKey: KEY("PG9") })), ["11 Oct PG9 proposed again: Changes, gate G9, round 2 (2026-10-11 09:00 UTC)", "10 Oct PG9 proposed: Changes, pilot T90, gate G9 (2026-10-10 09:00 UTC)"]);
});

test("R1375-1, R1375-3, R1375-4: over three rounds each answer names its own gate, a task that a later round takes in joins, and an older round has no name", () => {
  const tables = programsTables(), question = tables.gates.find(gate => gate.id === "G1").question, round = n => question.replace("Approve program PG1?", `Approve program PG1 (round ${n})?`);
  Object.assign(tables.programs.find(row => row.id === "PG1"), { gate: "G21", name: "Codex support v2" });
  // The rows in the forms that the state tool writes: program propose (rounds 1 to 3, round 2 takes in T11) and two answers.
  tables.decisions.push(
    { at: "2026-10-10T09:00:00Z", task: "T2", decision: "program none → PG1", why: "program propose" },
    { at: "2026-10-10T09:00:00Z", task: "T1", decision: "PG1 proposed with gate G1, pilot T1, tasks T2, name: Codex support", why: "program propose" },
    { at: "2026-10-11T09:00:00Z", task: "T1", decision: `${question} → change`, why: "the user's answer" },
    { at: "2026-10-12T09:00:00Z", task: "T11", decision: "program none → PG1", why: "program propose" },
    { at: "2026-10-12T09:00:00Z", task: "T1", decision: "PG1 proposed again with gate G20, round 2", why: "program propose" },
    { at: "2026-10-13T09:00:00Z", task: "T1", decision: `${round(2)} → change`, why: "the user's answer" },
    { at: "2026-10-14T09:00:00Z", task: "T1", decision: "PG1 proposed again with gate G21, round 3", why: "program propose" });
  assert.deepEqual(decisionsOf(renderProgramsHtml(programsModel(tables), { programKey: KEY("PG1") })), [
    "14 Oct PG1 proposed again: Codex support v2, gate G21, round 3 (2026-10-14 09:00 UTC)", "13 Oct G20 answered: change (2026-10-13 09:00 UTC)",
    "12 Oct PG1 proposed again: gate G20, round 2 (2026-10-12 09:00 UTC)", "12 Oct T11 joined PG1 (2026-10-12 09:00 UTC)", "11 Oct G1 answered: change (2026-10-11 09:00 UTC)",
    "10 Oct PG1 proposed: Codex support, pilot T1, gate G1 (2026-10-10 09:00 UTC)"]);
});

test("R1378-2, R1378-3: a decision with no valid time, also a day that its month does not have, goes last and shows no date", () => {
  const tables = programsTables();
  tables.decisions.push({ at: "2026-02-99T00:00:00Z", task: "T1", decision: "state merged", why: "sample one" }, { at: "unknown", task: "T2", decision: "state merged", why: "sample two" },
    { at: "2026-10-10T09:00:00Z", task: "T3", decision: "state merged", why: "sample three" });
  const pg1 = renderProgramsHtml(programsModel(tables), { programKey: KEY("PG1") }), items = [...pg1.matchAll(/<li>(.*?)<\/li>/g)].map(m => m[1]).filter(item => item.includes("sample"));
  assert.deepEqual(items, ['<span class="faint" title="2026-10-10 09:00 UTC">10 Oct</span> T3 merged: sample three', "T1 (pilot) merged: sample one", "T2 merged: sample two"]);
});

test("R1371-4: a decision whose time is not a date shows no date and no title", () => {
  const tables = programsTables();
  tables.decisions.push({ at: "garbage", task: "T1", decision: "state merged", why: "sample" });
  const pg1 = renderProgramsHtml(programsModel(tables), { programKey: KEY("PG1") });
  assert.ok(pg1.includes("<li>T1 (pilot) merged: sample</li>"), pg1.slice(pg1.indexOf("Latest decisions")));
  assert.ok(!pg1.includes("garbage"));
});

test("R1368-2: in a proposed program, a task that waits for an abandoned or a missing pilot cannot start, and says so once", () => {
  const sub = drop => { const tables = programsTables(); tables.tasks.find(task => task.id === "T31").waits = "T30"; drop(tables); return rowOf(renderProgramsHtml(programsModel(tables), { programKey: KEY("PG3") }), "T31"); };
  const abandoned = sub(tables => { tables.tasks.find(task => task.id === "T30").state = "abandoned"; }), missing = sub(tables => tables.tasks.splice(tables.tasks.findIndex(task => task.id === "T30"), 1));
  assert.ok(abandoned.endsWith('<span class="sub">⊘ waits for T30 (abandoned): it cannot start</span>'), abandoned);
  assert.ok(missing.endsWith('<span class="sub">⊘ waits for T30 (not in the logbook): it cannot start</span>'), missing);
});

test("R1371-5: a lost program's page says what is wrong once, under Needs you", () => {
  const pg7 = renderProgramsHtml(programsModel(), { programKey: KEY("PG7") });
  assert.equal(pg7.split("The breakdown gate G30 of PG7 is not in the logbook. Ask the sage to repair the logbook, or to propose PG7 again.").length, 2, pg7);
  assert.ok(pg7.includes("<b>Needs you:</b> The breakdown gate G30 of PG7 is not in the logbook."));
});

test("T375: the not-found program page has its heading and title, and names the id only when the key ends in a program id", () => {
  const model = programsModel(), page = key => renderProgramsHtml(model, { programKey: key });
  for (const html of [page(KEY("PG99")), page("claude/sage-ff5ee2/<b>x</b>"), page("PG12"), page("claude/sage-ff5ee2/PG0")]) {
    assert.ok(html.includes("<title>Program not found · Sage programs</title>") && html.includes('<h1 class="ptitle">Program not found</h1>'), html.slice(0, 300));
    assert.ok(!html.includes("&lt;b&gt;") && !html.includes("<b>x</b>"));
  }
  assert.ok(page(KEY("PG99")).includes("<b>No program PG99 on the board.</b>"));
  for (const key of ["claude/sage-ff5ee2/<b>x</b>", "PG12", "claude/sage-ff5ee2/PG0"]) assert.ok(page(key).includes("<b>No program on the board.</b>"), key);
  assert.ok(page(`claude/sage-ff5ee2/PG${"1".repeat(400)}`).includes("<b>No program PG111111111… on the board.</b>"), "R1371-1: a long id shows its first 12 characters");
});

test("T378-18: the offline snapshot's task, programs and program pages each have a theme switch after the way back", () => {
  const html = renderBoardHtml(programsModel());
  for (const id of [`task-${B64(KEY("T13"))}`, "programs", `program-${B64(KEY("PG1"))}`]) {
    const at = html.indexOf(`<section class="page" id="${id}"`), bar = html.slice(at, html.indexOf("</div>", html.indexOf('class="pagebar"', at)));
    assert.ok(bar.includes(`<span class="spacer"></span><input type="checkbox" id="flip-${id}" class="vh flip"><label class="chip theme" for="flip-${id}">`), bar);
    assert.ok(bar.indexOf('class="back"') < bar.indexOf("flip-"), "the way back comes first");
  }
  assert.ok(!renderBoardHtml(programsModel(), { snapshot: false, taskKey: KEY("T13") }).includes("flip-task-"), "a served page has the one switch of its bar");
});
