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
  for (const title of ["Loop", "Brief", "Agent runs", "Evidence", "Findings", "Artifacts", "Latest decisions"]) assert.ok(initial.includes(`<h3>${title}</h3>`));
  assert.ok(!/src=|@import|url\(/.test(html));
  assert.ok(html.includes("prefers-reduced-motion"));
  assert.ok(html.includes("max-width:700px"));
  const page = renderBoardHtml(data, { snapshot: false, taskKey: data.tasks[0].key });
  assert.ok(page.includes("<main class=\"detail\">"));
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
    if (!VOID.has(tag)) current = node;
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
  const summary = () => document.getElementById("board-summary").textContent;
  const buttons = () => document.querySelectorAll("[data-filter]");
  const needsButton = () => buttons().find(b => b.dataset.filter === "needs");
  const button = name => buttons().find(b => b.textContent === name);
  const headings = () => document.querySelectorAll(".column").map(col => col.querySelector("h2").textContent).join(" | ");
  const allSummary = "3 need you · 1 recorded agents · 1 inferred PRs · 2 in review";
  assert.equal(summary(), allSummary);
  click(button("alpha"));
  assert.equal(summary(), "1 need you · 1 recorded agents · 0 inferred PRs · 1 in review");
  assert.equal(needsButton().textContent, "Needs you (1)");
  assert.equal(headings(), "Backlog (1) | Design (0) | Building (0) | In review (1) | Ready to merge (0) | Done (0)");
  click(button("beta"));
  assert.equal(summary(), "2 need you · 0 recorded agents · 1 inferred PRs · 1 in review");
  assert.equal(needsButton().textContent, "Needs you (2)");
  assert.equal(headings(), "Backlog (0) | Design (0) | Building (2) | In review (1) | Ready to merge (0) | Done (0)");
  click(needsButton());
  assert.equal(summary(), "2 need you · 0 recorded agents · 1 inferred PRs · 1 in review");
  assert.equal(headings(), "Backlog (0) | Design (0) | Building (1) | In review (1) | Ready to merge (0) | Done (0)");
  click(button("All projects"));
  click(needsButton());
  assert.equal(summary(), allSummary);
  assert.equal(needsButton().textContent, "Needs you (3)");
  assert.equal(headings(), "Backlog (1) | Design (0) | Building (2) | In review (2) | Ready to merge (0) | Done (0)");
});
