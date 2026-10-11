import test from "node:test";
import assert from "node:assert/strict";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { renderBoardHtml, renderBoardText, renderTaskText, renderBoardStatus } from "../packages/sage-core/board-render.mjs";
function model() {
  return buildBoardModel([{ id: "sample", label: "Sample source", diagnostics: [], projects: [{ key: "sample/project-abcdef", name: "project-abcdef", diagnostics: [], tables: { tasks: [{ id: "T1", title: "<script>alert(1)</script> & [sample](https://example.test)", size: "small", risk: "auth", route: "build,code-review,qa", state: "held", branch: "", pr: "", round: "1", keys: "" }] } }] }], { now: "2026-10-08T20:00:00Z" });
}
test("HTML renders escaped initial cards and complete offline task sections before enhancements", () => {
  const data = model(), html = renderBoardHtml(data);
  const initial = html.split("<script>")[0];
  assert.ok(initial.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!initial.includes("<script>alert(1)</script>"));
  assert.ok(initial.includes("T1"));
  for (const title of ["Where in the loop", "Brief", "Agent runs", "Evidence", "Findings", "Artifacts", "Latest decisions"]) assert.ok(initial.includes(`<h3>${title}`), title);
  assert.ok(!/src=|@import|url\(/.test(html));
  assert.ok(html.includes("prefers-reduced-motion"));
  assert.ok(html.includes("max-width:700px"));
  const page = renderBoardHtml(data, { snapshot: false, taskKey: data.tasks[0].key });
  assert.ok(page.includes('<section class="page open"'));
  assert.throws(() => renderBoardHtml(data, { taskKey: "missing" }), RangeError);
});
test("phone text and status preserve task counts and escape agent markup", () => {
  const data = model(), board = renderBoardText(data), task = renderTaskText(data.tasks[0]);
  assert.ok(board.includes("1 need you"));
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

// A small fake DOM: it parses the page that renderBoardHtml writes (no new dependency) and offers only what the page script uses.
function fakeDocument(html) {
  const VOID = new Set(["meta", "input", "br", "img"]);
  const decode = text => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  const matches = (node, selector) => selector.startsWith(".") ? node.classList.contains(selector.slice(1)) : selector.startsWith("[") ? selector.slice(1, -1) in node.attrs : node.tag === selector;
  const makeNode = (tag, attrs, parent) => {
    const node = { tag, parent, children: [], attrs: { ...attrs }, text: "" };
    node.dataset = new Proxy({}, { get: (_, key) => node.attrs[`data-${String(key).replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`] });
    node.classList = {
      contains: name => (node.attrs.class ?? "").split(/\s+/).includes(name),
      toggle: (name, on) => { const set = new Set((node.attrs.class ?? "").split(/\s+/).filter(Boolean)); if (on) set.add(name); else set.delete(name); node.attrs.class = [...set].join(" "); },
    };
    node.hidden = false;
    node.setAttribute = (name, value) => { node.attrs[name] = value; };
    node.closest = selector => { for (let n = node; n; n = n.parent) if (matches(n, selector)) return n; return null; };
    node.descendants = () => node.children.flatMap(child => [child, ...child.descendants()]);
    node.querySelectorAll = selector => node.descendants().filter(n => matches(n, selector));
    node.querySelector = selector => node.querySelectorAll(selector)[0] ?? null;
    Object.defineProperty(node, "textContent", { get: () => node.text + node.children.map(child => child.textContent).join(""), set: value => { node.text = String(value); node.children = []; } });
    return node;
  };
  const root = makeNode("root", {}, null);
  let current = root;
  const body = html.replace(/<script>[\s\S]*?<\/script>|<style>[\s\S]*?<\/style>/g, "");
  for (const m of body.matchAll(/<(\/)?([a-z0-9]+)((?:\s+[^>]*?)?)\s*>|([^<]+)/g)) {
    const [, close, tag, rawAttrs, text] = m;
    if (text !== undefined) { current.text += decode(text); continue; }
    if (close) { current = current.parent ?? root; continue; }
    const attrs = {};
    for (const [, name, quoted, bare] of (rawAttrs ?? "").matchAll(/([a-z-]+)(?:="([^"]*)"|=([^\s"]+))?/g)) attrs[name] = decode(quoted ?? bare ?? "");
    const node = makeNode(tag, attrs, current);
    current.children.push(node);
    if (!VOID.has(tag) && !(rawAttrs ?? "").endsWith("/")) current = node;
  }
  const listeners = [];
  const document = {
    querySelectorAll: selector => root.querySelectorAll(selector),
    getElementById: id => root.descendants().find(n => n.attrs.id === id) ?? null,
    addEventListener: (type, fn) => listeners.push([type, fn]),
  };
  const click = target => { for (const [type, fn] of listeners) if (type === "click") fn({ target }); };
  return { document, click };
}
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
test("T217: the page script makes the summary, the Needs-you count and the column counts follow the filter", async () => {
  const { BOARD_ENHANCEMENT } = await import("../packages/sage-core/board-render.mjs");
  const data = twoProjectModel();
  assert.deepEqual(data.counts, { tasks: 5, needsOwner: 3, recordedAgents: 1, inferredWork: 1, inReview: 2 });
  const { document, click } = fakeDocument(renderBoardHtml(data, { snapshot: false }));
  new Function("document", BOARD_ENHANCEMENT)(document);
  const summary = () => ["s-needs", "s-agents", "s-inferred", "s-review", "s-tasks"].map(id => document.getElementById(id).textContent).join(" ");
  const buttons = () => document.querySelectorAll("[data-filter]");
  const needsButton = () => buttons().find(b => b.dataset.filter === "needs");
  const needsCount = () => document.getElementById("needs-count").textContent;
  const button = name => buttons().find(b => b.textContent === name);
  const headings = () => document.querySelectorAll("[data-col]").map(col => col.querySelector(".n").textContent).join(" ");
  assert.equal(summary(), "3 1 1 2 5");
  click(button("alpha"));
  assert.equal(summary(), "1 1 0 1 2");
  assert.equal(needsCount(), "1");
  assert.equal(headings(), "1 0 0 1 0 0");
  click(button("beta"));
  assert.equal(summary(), "2 0 1 1 3");
  assert.equal(needsCount(), "2");
  assert.equal(headings(), "0 0 2 1 0 0");
  click(needsButton());
  assert.equal(summary(), "2 0 1 1 2");
  assert.equal(headings(), "0 0 1 1 0 0");
  click(button("All projects"));
  click(needsButton());
  assert.equal(summary(), "3 1 1 2 5");
  assert.equal(needsCount(), "3");
  assert.equal(headings(), "1 0 2 2 0 0");
  assert.equal(document.getElementById("nomatch").hidden, true);
});

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
    assert.equal(html.split("<script>").length, 2, "only the page's own script");
    assert.ok(!html.includes("<img src=x"));
    assert.ok(html.includes("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;alert(2)&lt;/script&gt;"));
  }
  assert.ok(renderBoardHtml(data).includes(`title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;`));
});

test("T218: the page keeps all its code in one <style> and one <script> with no attributes, so the server's CSP hashes cover it", () => {
  const data = twoProjectModel();
  for (const html of [renderBoardHtml(data, { snapshot: false, live: true }), renderBoardHtml(data, { snapshot: false, live: true, taskKey: data.tasks[0].key }), renderBoardHtml(data)]) {
    assert.deepEqual(html.match(/<(script|style)\b[^>]*>/g), ["<style>", "<script>"]);
    const markup = html.replace(/<script>[\s\S]*?<\/script>|<style>[\s\S]*?<\/style>/g, "");
    assert.doesNotMatch(markup, /\sstyle=|\son[a-z]+=|javascript:/i, "an inline style or handler needs 'unsafe-inline'");
    assert.doesNotMatch(html, /\ssrc=|@import|url\(|<link/, "no external script, style, font or image");
  }
});

test("T218: the backlog shows the newest 6 tasks, then a Show all fold that needs no script", () => {
  const tasks = Array.from({ length: 8 }, (_, i) => row(`T${i + 1}`, "framed"));
  const decisions = tasks.map((task, i) => ({ at: `2026-10-0${i + 1}T10:00:00Z`, task: task.id, decision: "task framed", why: "sample" }));
  const html = renderBoardHtml(sample(tasks, { decisions }));
  const backlog = /<section class="col" aria-label="Backlog" data-col="backlog">([\s\S]*?)<\/section>/.exec(html)[1];
  const [shown, folded] = backlog.split('<details class="rest">');
  assert.deepEqual([...shown.matchAll(/<span class="id">(T\d+)<\/span>/g)].map(m => m[1]), ["T8", "T7", "T6", "T5", "T4", "T3"]);
  assert.match(folded, /^<summary><span data-all>Show all 8<\/span><span class="faint" data-more> · 2 more, newest activity first<\/span><\/summary>/);
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
  assert.ok(page.includes(`<section class="page open" id="${id}" aria-label="T2"><div class="pagebar"><a class="back" href="/">← Board</a><span class="livepill" id="live-state" role="status">`));
  assert.ok(page.includes('<h2 class="ptitle">Sample T2</h2>'));
  assert.ok(page.includes('<div class="flag" role="note">'));
  assert.ok(!page.includes('class="board"'));
});

test("T218: the phone layout puts needs-you columns first and hides empty ones", () => {
  const data = twoProjectModel(), html = renderBoardHtml(data, { snapshot: false });
  assert.match(html, /@media \(max-width:700px\)\{[^}]*\{[^}]*\}[\s\S]*?\.col\.needs-col\{order:-1\}\.col\.empty-col\{display:none\}/);
  assert.ok(html.includes('<section class="col needs-col" aria-label="In review" data-col="review">'));
  assert.ok(html.includes('<section class="col empty-col" aria-label="Design" data-col="design">'));
  assert.ok(html.includes('<section class="col" aria-label="Backlog" data-col="backlog">'));
});

test("T218: cycle steps show the ledger's verdicts on the newest reviewed head, a run of the role runs, and a card shows no ? steps", () => {
  const head = "c".repeat(40);
  const data = sample([row("T1", "reviewing", { pr: "9" }), row("T2", "reviewing", { pr: "10" })], {
    ledger: [{ task: "T1", pr: "9", sha: head, kind: "checks-pass", cycle: "1", run: "", at }, { task: "T1", pr: "9", sha: head, kind: "qa-fail", cycle: "1", run: "R2", at }],
    runs: [{ id: "R1", task: "T1", role: "code-reviewer", status: "running", started: at }],
  });
  const html = renderBoardHtml(data, { snapshot: false });
  assert.ok(html.includes('cycle 1 of 1<span class="steps"><span class="step done">checks ✓</span><span class="step running">code …</span><span class="step failed">qa ✗</span></span>'));
  assert.ok(html.includes('cycle 1 of 1 <span class="faint">· PR head not recorded</span>'));
  assert.ok(!html.includes('class="step unknown"'));
  const page = renderBoardHtml(data, { snapshot: false, taskKey: data.tasks.find(t => t.id === "T1").key });
  assert.ok(page.includes(`head <span class="standin" title="The head of the newest verdict for this PR. The current PR head is not recorded.">ccccccc</span>`));
  assert.ok(page.includes('<span class="prov"><span class="standin" title="Stand-in: the logbook&#39;s source. The run does not record its provider.">Sample</span> ·</span> code-reviewer'));
});

test("T218: the PR links to the project's GitHub remote only through safeUrl, and stays text without one", () => {
  const make = repository => sample([row("T1", "reviewing", { pr: "7" })], {}, { repository });
  const linked = renderBoardHtml(make("https://github.com/acme/sage"), { snapshot: false, taskKey: "sample/project-abcdef/T1" });
  assert.ok(linked.includes('<a href="https://github.com/acme/sage/pull/7" rel="noopener noreferrer">PR 7</a>'));
  for (const repository of [null, "javascript:alert(1)", "http://github.com/acme/sage", "https://user:pw@github.com/acme/sage"]) {
    const page = renderBoardHtml(make(repository), { snapshot: false, taskKey: "sample/project-abcdef/T1" });
    assert.ok(!page.includes("/pull/7"), String(repository));
    assert.ok(page.includes('title="No link: the project&#39;s GitHub remote is not known.">PR 7</span>'));
  }
});

test("T218: the chat board keeps the backlog to its count and the next 3 framed tasks by id, with the card's cycle", () => {
  const tasks = [...Array.from({ length: 40 }, (_, i) => row(`T${40 - i}`, "framed", { title: `Sample backlog ${40 - i} ${"long title ".repeat(10)}` })), row("T41", "reviewing", { pr: "3" })];
  const text = renderBoardText(sample(tasks));
  const backlog = /### 📋 Backlog \(40\)\n([\s\S]*?)\n\n###/.exec(text)[1];
  assert.deepEqual([...backlog.matchAll(/\*\*(T\d+) /g)].map(m => m[1]), ["T1", "T2", "T3"]);
  assert.ok(backlog.endsWith("Next up by id. 37 more in the backlog: open the board page for all."));
  assert.ok(text.includes("**T41 Sample T41** · sample · project · PR 3\nCycle 1 of 1: PR head not recorded"));
  assert.ok(!text.includes("? checks"));
  assert.ok(text.length < 3000, `${text.length} characters`);
});
