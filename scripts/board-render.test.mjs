import test from "node:test";
import assert from "node:assert/strict";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { renderBoardHtml, renderBoardText, renderTaskText, renderBoardStatus, needCounts, BOARD_ENHANCEMENT } from "../packages/sage-core/board-render.mjs";
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
  assert.ok(text.startsWith("**sage board** · built 2026-10-08 20:00 UTC\\\n🔴 1 needs you · 1 agents at work · 🔁 1 in review · 49 tasks\\\n"));
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
  assert.ok(text.endsWith("\nIncomplete source: sample · sample/live-abcdef · its runs file has no read permission\\\nSetting ignored: sample · sample/live-abcdef · config: archived is not true or false"), text);
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

test("T305: the theme follows the system until you choose, a choice applies in the head, and the switch names the theme it switches to", async () => {
  const { THEME_HEAD } = await import("../packages/sage-core/board-render.mjs");
  const html = renderBoardHtml(providers());
  assert.ok(html.indexOf(`<script>${THEME_HEAD}</script>`) < html.indexOf("<style>"), "the saved theme applies before the first paint");
  assert.ok(html.includes('<input type="checkbox" id="flip" class="vh"><label class="chip theme" for="flip"><span class="to-light">Light theme</span><span class="to-dark">Dark theme</span></label>'));
  assert.ok(html.includes("@media (prefers-color-scheme:light){:root:not([data-theme]):not(:has(#flip:checked)){--bg:#f7f7f5"));
  assert.ok(html.includes(":root[data-theme=light]:not(:has(#flip:checked)) .to-light,:root[data-theme=dark]:has(#flip:checked) .to-light{display:none}"));
  const store = new Map([["board-theme", "light"]]), root = { dataset: {} };
  new Function("localStorage", "document", THEME_HEAD)({ getItem: key => store.get(key) ?? null }, { documentElement: root });
  assert.equal(root.dataset.theme, "light");
  const none = { dataset: {} };
  new Function("localStorage", "document", THEME_HEAD)({ getItem: () => { throw new Error("blocked"); } }, { documentElement: none });
  assert.equal(none.dataset.theme, undefined, "no storage: the system theme");
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
  const html = renderBoardHtml(data, { snapshot: false });
  assert.ok(html.includes("<b>Needs you:</b> Approve program PG1? No task builds before you approve.<br>Name: Codex support<br>Pilot, runs first:<br>  T1: &lt;b&gt;Ship&lt;/b&gt; it: 100% done<br>I recommend: approve</span>"), html);
  assert.ok(renderBoardText(data).includes("#### ◫ Program approval\n**1 · PG1 Codex support** · sample · project · pilot T1 · gate G1\n> Approve program PG1? No task builds before you approve\\.\\\n> Name: Codex support\\\n> Pilot, runs first:\\\n>   T1: \\<b\\>Ship\\</b\\> it: 100% done\\\n> Options: 1: approve"), renderBoardText(data));
  assert.ok(renderTaskText(data.tasks[0]).includes("Needs you: Approve program PG1? No task builds before you approve\\.\nName: Codex support\nPilot, runs first:\n  T1: \\<b\\>Ship\\</b\\> it: 100% done\nI recommend: approve"), renderTaskText(data.tasks[0]));
});

test("R1249-1: only a breakdown gate's question shows as lines: a plain gate's line breaks show as spaces on the card, in the text board and on the task text", () => {
  const question = "Ship it? I recommend: no 1. no";
  const data = sample([row("T1", "framed")], { gates: [{ id: "G1", task: "T1", question, options: "yes|no", recommendation: "yes", answer: "" }] });
  const html = renderBoardHtml(data, { snapshot: false });
  assert.ok(html.includes("<b>Needs you:</b> Ship it? I recommend: no 1. no I recommend: yes</span>"), html);
  assert.ok(renderBoardText(data).includes("> sample/project-abcdef/G1 · Ship it? I recommend: no 1\\. no\\\n> Options: 1: yes · 2: no\\\n> Recommended: yes"), renderBoardText(data));
  assert.ok(renderTaskText(data.tasks[0]).includes("Needs you: Ship it? I recommend: no 1\\. no I recommend: yes\n"), renderTaskText(data.tasks[0]));
});

test("R1249-1: a plain gate beside a breakdown gate on one task keeps its own line, not the breakdown's recommendation line", () => {
  const breakdown = ["Approve program PG1? No task builds before you approve.", "Pilot, runs first:", "  T1: Ship it"].join(" ");
  const data = sample([row("T1", "framed", { program: "PG1" })], { programs: [{ id: "PG1", name: "Codex support", goal: "Sample", pilot: "T1", gate: "G1", at }], gates: [{ id: "G1", task: "T1", question: breakdown, options: "approve|change|drop", recommendation: "approve", answer: "" }, { id: "G2", task: "T1", question: "Logo A or B?", options: "A|B", recommendation: "A", answer: "" }] });
  assert.ok(renderBoardHtml(data, { snapshot: false }).includes("<br>  T1: Ship it<br>I recommend: approve<br>Logo A or B? I recommend: A</span>"));
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
  assert.deepEqual(needCounts(cards, none), { all: 4, projects: { a: 2, b: 2, old: 1 } });
  assert.deepEqual(needCounts(cards, { ...none, priority: "P1" }), { all: 2, projects: { a: 1, b: 1, old: 1 } });
  assert.deepEqual(needCounts(cards, { ...none, who: "codex" }), { all: 1, projects: { b: 1 } });
  assert.deepEqual(needCounts(cards, { ...none, priority: "none" }), { all: 0, projects: {} });
  assert.deepEqual(needCounts(cards, { ...none, project: "old", priority: "P1" }), { all: 1, projects: { a: 1, b: 1, old: 1 } }, "a chosen archived project counts its own");
  assert.ok(BOARD_ENHANCEMENT.includes("function needCounts(cards, S)") && BOARD_ENHANCEMENT.includes("set('needs-count',need.all)") && BOARD_ENHANCEMENT.includes("const n=need.projects[c.dataset.pick]||0"), "the page counts with this function");
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
  assert.ok(text.startsWith("**sage board** · built 2026-10-20 12:00 UTC\\\n🔴 4 needs you · 0 agents at work · 🔁 1 in review · 18 tasks\n\n### 🔴 Needs you\n#### ◫ Program approval\n**1 · PG3 Board programs** · claude · sage \\(sample\\) · pilot T30 · gate G12\n> Approve program PG3? No task builds before you approve\\.\\\n> Name: Board programs\\\n> Goal: Sample goal\\.\\\n> Pilot, runs first:\\\n>   T30: Sample T30\\\n> Options: 1: approve · 2: change · 3: drop\\\n> Recommended: approve\n\n#### Other\n**2 · PG2 Lead build is stuck** · claude · sage \\(sample\\)\n> The pilot T21 was abandoned\\. Choose a new pilot, or drop the program\\.\n\n**3 · The breakdown gate G30 of PG7 is not in the logbook** · claude · sage \\(sample\\)\n> Ask the sage to repair the logbook, or to propose PG7 again\\.\n\n**4 · T70 Sample T70** · claude · sage \\(sample\\)\n> claude/sage-ff5ee2/G15 · Approve program PG9 Fast lane \\(pilot T70\\)? Goal: skip the reviews\\. Name: Fast lane\\\n> Options: 1: approve · 2: change · 3: drop\\\n> Recommended: approve\n\n"), text);
  assert.ok(text.includes("\n\n### ◫ Programs\n- PG1 Codex support · 3 of 7 merged · T10 abandoned · next: T12 \\(in review\\) · 1 waits · T11 cannot start\n- PG2 Lead build · stuck: the pilot T21 was abandoned \\(see Needs you\\)\n- PG3 Board programs · the breakdown waits for you \\(gate G12\\) · pilot T30\n- PG4 Agent caps · 0 of 3 merged · next: T40 \\(pilot, building\\) · 2 wait\n- PG7 Lost gate · its breakdown gate G30 is not in the logbook \\(see Needs you\\)\n- PG8 Loop · 1 of 4 merged · next: no task can move now · 2 wait · T83 cannot start\n- PG9 Changes · the sage revises the breakdown \\(gate G9\\)\n- 1 done · 1 dropped\n\n### 📋 Backlog (14)\n"), text);
  assert.ok(text.includes("\n\n**T11 Sample T11** · claude · sage \\(sample\\) · ◫ Codex support\\\n⊘ Waits for T10 \\(abandoned\\): it cannot start\\.\\\n○ Plan › ○ Build › ○ Review 1 of 1 › ○ Merge\\\nNow: In the backlog\\. No agent works on it\\.\n\n"), text);
  assert.ok(text.includes("\n\n**T41 Sample T41** · claude · sage \\(sample\\) · ◫ Agent caps\\\n⧗ Waits for T40 \\(pilot, building\\)\\. Design and PE may run\\.\\\n"), text);
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
  assert.ok(text.includes("**T13 Strike \\~\\~this\\~\\~ out \\\\** · claude · sage \\(sample\\) · ◫ \\<img src=x onerror=alert\\(1\\)\\> \\*\\*bold\\*\\* \\[link\\]\\(https://example\\.test\\) \\`code\\` \\\\\\\n⧗ Waits for T12"), text);
  assert.ok(text.includes("\n- PG1 \\<img src=x onerror=alert\\(1\\)\\> \\*\\*bold\\*\\* \\[link\\]\\(https://example\\.test\\) \\`code\\` \\\\ · 3 of 7 merged"), text);
  assert.ok(!/(^|[^\\])<img/.test(text) && !text.includes("~~") && !text.includes("](https"), "no mark is left unescaped");
  assert.deepEqual(breaksOf(text), []);
});
