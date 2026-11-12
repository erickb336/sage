// T984: sage's messages to the owner. One message model (core's message.mjs), its text form at 46 columns, its page
// with each picture drawn as an image from its own text, the pure checks, and the state tool's message command.
// The fixtures in fixtures/messages are the 15 example messages that the owner approved (real content from the logbook
// of 11 Nov 2026; the confirm message is SAMPLE DATA, as its example page said).
import "./test-env.mjs"; // first: no variable of the developer's shell changes a result
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { KINDS, frameLines, messageText, prepareMessage } from "../packages/sage-core/message.mjs";
import { PAGE_POLICY, SWITCH_SCRIPT, messagePage } from "../packages/sage-core/message-page.mjs";
import { kindOf, messageMiss, pageProblems, renderMessage, textProblems } from "../packages/sage-core/message-checks.mjs";
import { columns, openBoxes, pictureSvg } from "../packages/sage-core/picture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "messages");
const TOOL = join(HERE, "..", "plugins", "sage", "skills", "sage", "sage.mjs");
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const ALL = readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).sort();
/** A fixture with its Page blocks pointed at a made-up pages folder, as the command does it. */
const resolved = (msg) => ({ ...msg, blocks: msg.blocks.map((b) => (b.t === "page" ? { ...b, path: `/pages/${b.task}/${b.file}` } : b)) });
const render = (msg) => renderMessage(resolved(msg), { pagePath: (name) => `/pages/T1/${name}` });
const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
/** The plain-text form that a page holds. */
const pageText = (html) => unescape(/<pre>([\s\S]*?)<\/pre><\/details>/.exec(html)[1]);
const pictures = (text) => [...text.matchAll(/^```\n([\s\S]*?)\n```$/gm)].map((m) => m[1].split("\n")).filter((l) => l.some((x) => /[\u2500-\u257f]/u.test(x)));

test("each of the 15 example messages renders through the model: text at 46 columns (66 on a long page), no tree marks, and its checks pass", () => {
  assert.equal(ALL.length, 15);
  const kinds = new Set();
  for (const name of ALL) {
    const msg = fixture(name), out = render(msg);
    assert.equal(out.problems, undefined, `${name}: ${out.problems}`);
    kinds.add(msg.long ? "long page" : msg.kind);
    assert.equal(kindOf(out.text), msg.kind, `${name}: the first line names its kind`);
    assert.deepEqual(textProblems(out.text), [], name);
    for (const pic of pictures(out.text)) assert.ok(pic.every((l) => columns(l) <= 46), `${name}: a picture over 46 columns`);
    assert.doesNotMatch(out.text, /[├└┬┴┼┤┌┐┘]/, name);
    if (out.page) {
      assert.deepEqual(pageProblems(out.page.html), [], name);
      for (const pic of pictures(pageText(out.page.html))) assert.ok(pic.every((l) => columns(l) <= (msg.long ? 66 : 46)), `${name}: a page picture over its width`);
    }
  }
  assert.deepEqual([...kinds].sort(), [...Object.keys(KINDS), "long page"].sort(), "every kind and the long page");
});

test("a message with a picture, and a long message, get a page and a Page block; a message with none gets neither", () => {
  const catchUp = render(fixture("10-catch-up.json"));
  assert.match(catchUp.text, /^CATCH-UP\n\nRelease 1\.0: the presentation skill is in\ndesign/);
  assert.match(catchUp.text, /\n\nPage · Release 1\.0: the presentation skill is\nin design, and the new words are in review\n {2}\/pages\/T1\/catch-up-[0-9a-f]{8}\.html\n\nRef: T984/);
  const question = render(fixture("02-question.json"));
  assert.equal(question.page, undefined);
  assert.match(question.text, /\n\nPage · Showing visuals in every app\n {2}\/pages\/T1000\/research\.html$/, "a page that the message names, by its title and path");
  const long = render(fixture("15-long-page.json"));
  assert.equal(long.text.split("\n\n").length, 5, "the chat holds the head, the title, the main point, the Page block and the Ref line");
  assert.match(long.text, /^REPORT\n\nThe clean-up change is merged; the full\ndescription is on its page\n\nMain point: /);
  assert.match(long.page.html, /<main class="long">/);
  assert.match(long.page.html, /Why this change/, "the page holds the rest");
});

test("the catch-up frame: boxes inside boxes, each state word from core's state words, the current task in a double box", () => {
  const out = render(fixture("10-catch-up.json")), [frame] = pictures(out.text);
  assert.deepEqual(frame.slice(0, 2), ["╭─ Release 1.0 ──────────────────────────────╮", "│ In progress                                │"]);
  assert.ok(frame.includes("│ │ ╔═ Task: Presentation skill ═════════╗ │ │"));
  assert.ok(frame.includes("│ │ │ Waiting for the presentation skill │ │ │"));
  const word = (node) => frameLines(node, 46).lines[1].slice(2).trim().replace(/ *│$/, "");
  // A task's recorded state gives its word (taskWord), a wait gives "waiting", an owner's question "needs you".
  assert.equal(word({ box: "task", name: "a", state: "merged" }), "Done");
  assert.equal(word({ box: "task", name: "a", state: "abandoned" }), "Stopped");
  assert.equal(word({ box: "task", name: "a", state: "framed", waits: "the rename" }), "Waiting for the rename");
  assert.equal(word({ box: "task", name: "a", state: "building", needs: "Approve the plan?" }), "Needs you");
  assert.equal(word({ box: "task", name: "a", state: "framed" }), "Not started");
  // A state that the tool does not write has no word: the box says so.
  assert.equal(word({ box: "task", name: "a", state: "dreaming" }), "State unknown");
  // A milestone's own state, or its tasks; a release's items.
  assert.equal(word({ box: "milestone", name: "1: a", state: "proposed" }), "Needs you");
  assert.equal(word({ box: "milestone", name: "1: a", items: [{ box: "task", name: "b", state: "merged" }, { box: "task", name: "c", state: "concluded" }] }), "Done");
  assert.equal(word({ box: "release", name: "1.0", items: [{ box: "task", name: "b", state: "abandoned" }] }), "Stopped");
  assert.deepEqual(frameLines({ box: "group", name: "x" }, 46).problems, ["frame is a group: give its word, one of: not started, waiting, needs you, in progress, done, stopped"]);
  assert.match(frameLines({ box: "task", name: "a very long name that cannot fit into the top edge of its box", state: "framed" }, 46).problems[0], /too long for a box of 46 columns/);
});

/** The cells of an SVG's text, by row and column, as the renderer placed them (the tags' pills left out). */
function svgCells(svg) {
  const cells = new Map();
  for (const [, cls, x, y, body] of svg.matchAll(/<text class="([^"]*)" x="([\d.]+)" y="([\d.]+)">(.*?)<\/text>/g)) {
    if (cls.includes("pic-tagtext")) continue;
    const text = unescape(body.replace(/<[^>]+>/g, ""));
    const row = Math.round((Number(y) - 19 * 0.68) / 19), col = Math.round(Number(x) / 9);
    [...text].forEach((ch, k) => cells.set(`${row},${col + k}`, ch));
  }
  return cells;
}

test("each picture's image is drawn from its text: every letter of the text is in the image, in its own row and column", () => {
  let checked = 0;
  for (const name of ALL) {
    const out = render(fixture(name));
    if (!out.page) continue;
    for (const lines of pictures(pageText(out.page.html))) {
      const svg = pictureSvg(lines), cells = svgCells(svg);
      assert.ok(out.page.html.includes(svg.replace(/aria-label="[^"]*"/, "")) || out.page.html.includes(svg.slice(svg.indexOf(" data-source"))), `${name}: the page holds the image of this text`);
      lines.forEach((line, row) => [...line.replace(/\[(?:new|was: [^\]]+)\]/g, (m) => " ".repeat([...m].length))].forEach((ch, col) => {
        if (/[\s\u2500-\u257f▼▲▶◀●━]/u.test(ch)) return;
        assert.equal(cells.get(`${row},${col}`), ch, `${name}: "${line}" column ${col + 1}`);
      }));
      checked++;
    }
  }
  assert.ok(checked >= 12, `pictures checked: ${checked}`);
  // A change of one word in the text changes the image, so an image cannot stay from an older text.
  const lines = ["╭─ Release 1.0 ─╮", "│ In progress   │", "╰───────────────╯"];
  assert.notEqual(pictureSvg(lines), pictureSvg(lines.map((l) => l.replace("In progress", "Done       "))));
});

test("the checks catch the designer's negative cases: width, tree marks, an image not from the text, outside loads, raw ids", () => {
  const out = render(fixture("10-catch-up.json")), html = out.page.html;
  // Width: one column too many in a picture.
  const wide = out.text.replace("│ Done: milestones 1 to 4                    │", "│ Done: milestones 1 to 4                     │");
  assert.match(textProblems(wide).join("\n"), /line 21 is 47 columns: a picture has at most 46/);
  assert.deepEqual(textProblems(wide, { width: 66 }).filter((p) => /columns/.test(p)), [], "66 on a long page");
  // Tree marks, in a picture or in the text.
  assert.match(textProblems(out.text.replace("What changed\n", "What changed\n├─ one\n")).join("\n"), /tree marks/);
  // An image that is not drawn from the text: the page's text form says one thing, the image another.
  const stale = html.replace(/(<svg class="pic"[\s\S]*?)In progress/, "$1Done");
  assert.match(pageProblems(stale).join("\n"), /1 of the page's 1 images are not drawn from a picture of its text form/);
  // Loads from outside the page.
  for (const [what, page] of [["an image", html.replace("<main>", '<main><img src="https://example.com/x.png">')],
    ["a style sheet", html.replace("</head>", '<link rel="stylesheet" href="https://example.com/x.css"></head>')],
    ["an import", html.replace("<style>", "<style>@import 'https://example.com/x.css';")],
    ["a link", html.replace("<main>", '<main><a href="https://example.com/">x</a>')]])
    assert.match(pageProblems(page).join("\n"), /the page loads from outside itself/, what);
  assert.match(pageProblems(html.replace("</body>", "<script>fetch('https://example.com')</script></body>")).join("\n"), /2 scripts/);
  assert.match(pageProblems(html.replace(PAGE_POLICY, "default-src *")).join("\n"), /Content-Security-Policy is not sage's/);
  // Raw ids in the state tool's own forms, also those that the designer's pattern missed (G7, M12, T12345).
  for (const id of ["T12345", "G7", "M12", "R40", "C2", "F-T807-1", "PR 515", "T10"])
    assert.match(textProblems(out.text.replace("Since: 18:00 today.", `Since: 18:00 today, after ${id}.`)).join("\n"), new RegExp(`raw ids in the message: ${id}\\.`), id);
  assert.match(textProblems(out.text.replace("│ In progress · in review                │", "│ In progress · in review T995           │")).join("\n"), /raw ids in the message: T995/, "in a picture too");
});

const explainerWith = (pic) => {
  const msg = fixture("05-explainer.json"), at = msg.blocks.findIndex((b) => b.t === "picture");
  return { ...msg, blocks: msg.blocks.map((b, k) => (k === at ? { ...b, ...pic } : b)) };
};

test("F-T984-1: the page check reads only real attributes, not a picture's title in its aria-label", () => {
  for (const title of ["Where data = truth", "A background = the old board", "Its src=the text form", "The page onload= nothing", "x href = y"]) {
    const out = render(explainerWith({ title }));
    assert.equal(out.problems, undefined, `${title}: ${out.problems}`);
    assert.ok(out.page.html.includes(`aria-label="${title}"`), title);
  }
  // Real attributes are still caught, quoted or not.
  const html = render(fixture("05-explainer.json")).page.html;
  assert.match(pageProblems(html.replace('<svg class="pic"', '<svg class="pic" onload="alert(1)"')).join("\n"), /an event attribute/);
  assert.match(pageProblems(html.replace("<main>", "<main><a href=https://example.com>x</a>")).join("\n"), /loads from outside itself/);
  assert.match(pageProblems(html.replace("</head>", '<meta http-equiv="refresh" content="0;url=https://example.com"></head>')).join("\n"), /loads from outside itself/);
});

test("F-T984-2: a picture of arrows alone, with no box mark, is a picture: its image passes, and it counts as the kind's picture", () => {
  const arrows = render(explainerWith({ title: "The flow", lines: ["Brief  ▶  Run  ▶  Report"] }));
  assert.equal(arrows.problems, undefined, arrows.problems?.join("\n"));
  assert.equal((arrows.page.html.match(/<svg class="pic"/g) ?? []).length, 1);
  assert.deepEqual(pageProblems(arrows.page.html), []);
  // An architecture needs a picture: one of arrows alone counts, also in the text check.
  const arch = fixture("08-architecture.json");
  const flow = render({ ...arch, blocks: arch.blocks.map((b) => (b.t === "picture" ? { ...b, lines: ["Brief  ▶  Run  ▶  Report"] } : b)) });
  assert.equal(flow.problems, undefined, flow.problems?.join("\n"));
  assert.deepEqual(textProblems(flow.text), []);
});

test("the raw-id check has none of the false hits that the PE found: the Ref line, the Page block, code, the board, a message with no kind", () => {
  const out = render(fixture("10-catch-up.json"));
  assert.match(out.text, /Ref: T984 · T995 to T997/);
  assert.deepEqual(textProblems(out.text), [], "the Ref line and the Page block's path may name ids");
  assert.deepEqual(textProblems(out.text.replace("Since: 18:00 today.", "Since: 18:00 today, on the Mac with the `M4` chip.")), [], "a word in code is not an id");
  assert.deepEqual(textProblems(out.text.replace("Since: 18:00 today.", "Since: 18:00 today. R2-D2, MT5, T-10 and 4K are words.")), []);
  assert.deepEqual(textProblems(`${out.text}\n\n**sage board** · built 2026-11-11 20:00 UTC\n### 🔴 Needs you\n**1 · T10 a task** · G7`), [], "the board's text is not the message's own");
  assert.deepEqual(textProblems("The board: T10 waits for G7 in M4, and ├─ marks a tree."), [], "a message that names no kind is not checked");
});

test("T1005: messageMiss gives the note of a hand-written message that misses its kind's shape, with each problem, and names with no word of the message", () => {
  const out = render(fixture("02-question.json")).text;
  assert.equal(messageMiss(out), undefined, "a message that fits");
  assert.equal(messageMiss("Done: T10 merged.\n├─ next"), undefined, "a message with no kind");
  const hand = out.replace(/\n\n\*\*Needed by\*\*\n[\s\S]*?(?=\n\n)/, "").replace(/\(my\s+pick\)/, "").replace("**Where this is**\n", "**Where this is**\nT4242, and\n├─ a tree.\n");
  const miss = messageMiss(hand);
  assert.equal(miss.kind, "question");
  assert.deepEqual(miss.names, ["tree marks", "raw ids", "missing: Needed by", "no pick"]);
  assert.deepEqual(miss.note.split("\n").slice(1, -1), textProblems(hand).map((p) => `- ${p}`), "the note lists each problem of the text check");
  assert.match(miss.note, /^sage: your last message names the kind "question"/);
  // A part out of order, and a missing picture, have names of their own.
  const needed = /\n\n\*\*Needed by\*\*\n[\s\S]*?(?=\n\n)/.exec(out)[0];
  assert.deepEqual(messageMiss(out.replace(needed, "").replace("\n\n**If you do not answer**", `${needed}\n\n**If you do not answer**`)).names, ["out of order: Needed by"]);
  const chart = render(fixture("09-state-chart.json")).text.replace(/```[\s\S]*?```/g, "");
  assert.deepEqual(messageMiss(chart).names, ["missing picture"]);
});

test("F-T984-11: on the message command's path, a word in code and a product name are not ids, and the state tool's ids are", () => {
  // renderMessage is what the message command runs. Before T984's repair its text form dropped the code marks, so a word
  // in code reached the raw-id check bare, and "the M4 Mac" (a milestone's form, the PE's false hit) refused a message.
  const progress = fixture("01-progress-note.json");
  const say = (text) => render({ ...progress, blocks: [progress.blocks[0], { t: "p", text }, ...progress.blocks.slice(1)] });
  for (const text of ["The tests ran on the Mac with the `M4` chip.", "Run `sage show T12` and `gh pr view 40` first.", "A long code span: `node sage.mjs message T12 --file /tmp/sage-message/T12.json` wraps."]) {
    const out = say(text);
    assert.equal(out.problems, undefined, `${text}: ${out.problems}`);
    assert.match(out.text, /`[^`]+/, "the text form keeps the code marks");
  }
  for (const text of ["The tests ran on the M4 Mac.", "It runs on an M2 chip and an M3 Pro.", "The old G5 server is gone.", "Play a C3 chord.", "A MacBook with an M4 Max."])
    assert.equal(say(text).problems, undefined, text);
  // The state tool's own forms stay ids, also next to a product name that is not right after them.
  for (const [text, id] of [["After G7, the Mac.", "G7"], ["It waits for M12.", "M12"], ["The M4 milestone is done.", "M4"], ["T12345 is next.", "T12345"],
    ["T10 waits.", "T10"], ["See PR 515.", "PR 515"], ["R40 ran.", "R40"], ["C2 owns it.", "C2"], ["F-T807-1 is fixed.", "F-T807-1"], ["The T10 chip.", "T10"]])
    assert.match(say(text).problems?.join("\n") ?? "", new RegExp(`raw ids in the message: ${id}\\.`), text);
});

test("a picture drawn by hand: each box that does not close is named, and its marks stay in the image as fixed-width text", () => {
  const lines = ["╔═ The part in focus ═╗", "║ text                ║", "╚══════════════════"];
  assert.deepEqual(openBoxes(lines), ["the box that starts at line 1, column 1 does not close: each corner needs its edge and the three other corners"]);
  const svg = pictureSvg(lines);
  assert.doesNotMatch(svg, /<rect class="pic-box/, "no box is drawn from it");
  assert.match(svg, /<text class="pic-text pic-raw" x="0" y="[\d.]+">╔<\/text>/, "the corner stays in its cell, in a fixed-width font");
  assert.equal((svg.match(/pic-raw/g) ?? []).length, [...lines.join("")].filter((ch) => /[╔╗╚═║]/.test(ch)).length, "every mark of the open box is in the image");
  // The rail of a state chart is a curve, not a box: ╭─ meets the side of a dashed box.
  assert.deepEqual(openBoxes(fixture("09-state-chart.json").blocks.find((b) => b.t === "picture").lines), []);
  const msg = { ...fixture("08-architecture.json") };
  msg.blocks = msg.blocks.map((b, k) => (k === 1 ? { ...b, lines: [...b.lines.slice(0, -1), "╰────"] } : b));
  assert.match(render(msg).problems.join("\n"), /does not close/);
});

test("the shape of each kind holds in code: a missing part, a part out of order, an unknown part, the pick, the status", () => {
  const problems = (change) => { const msg = structuredClone(fixture("02-question.json")); change(msg); return render(msg).problems?.join("\n") ?? ""; };
  assert.match(problems((m) => { m.blocks = m.blocks.filter((b) => b.label !== "What you approve"); }), /a question needs "What you approve" before "The one real choice in it"/);
  assert.match(problems((m) => { m.blocks.reverse(); }), /out of order in a question/);
  assert.match(problems((m) => { m.blocks.splice(1, 0, { t: "field", label: "Mood", text: "fine" }); }), /"Mood" is not a part of a question/);
  assert.match(problems((m) => { delete m.blocks.find((b) => b.t === "table").pick; }), /marks your pick/);
  assert.match(problems((m) => { m.title = "Stop sending pages."; }), /ends with \?/);
  assert.match(problems((m) => { m.blocks.find((b) => b.t === "table").head = ["A", "B", "C"]; }), /the columns: Answer, What happens next, Cost/);
  assert.match(problems((m) => { m.kind = "memo"; }), /kind is one of: progress, question/);
  assert.match(problems((m) => { m.blocks[0] = { t: "field", label: "Where this is" }; }), /blocks\[0\] is not a block/);
  const incident = structuredClone(fixture("06-incident.json"));
  incident.status = "Fixed";
  assert.match(render(incident).problems.join("\n"), /status is one of: Investigating, Identified, Monitoring, Resolved/);
  const design = structuredClone(fixture("07-design.json"));
  design.blocks = design.blocks.filter((b) => b.t !== "toggle");
  assert.match(render(design).problems.join("\n"), /a design shows its before and after/);
  // The design's change table: for changes without a screen.
  design.blocks.splice(4, 0, { t: "changes", rows: [{ where: "The status lines", today: "“0 of 8 merged”", after: "“0 of 8 done”", why: "A study that ended counts too." }] });
  const changed = render(design);
  assert.equal(changed.problems, undefined, changed.problems);
  assert.match(changed.text, /\n1\. The status lines\n {3}- Today: “0 of 8 merged”\n {3}- After this change: “0 of 8 done”\n {3}- Why: A study that ended counts too\./);
  // The text check reads the same shape: a hand-written question with no "Needed by".
  assert.match(textProblems(render(fixture("02-question.json")).text.replace(/\n\n\*\*Needed by\*\*\n[\s\S]*?(?=\n\n)/, "")).join("\n"), /a question needs "Needed by"/);
});

/** The problems of a message that the command must refuse: a list, never a throw. */
const refusal = (msg) => { const out = renderMessage(msg); assert.ok(out.problems, "refused"); return out.problems.join("\n"); };

test("F-T984-3: a kind or a block type that is an inherited name is refused, not a crash", () => {
  const progress = fixture("01-progress-note.json");
  for (const kind of ["constructor", "__proto__", "toString", "hasOwnProperty"]) assert.match(refusal({ ...progress, kind }), /^kind is one of: progress/, kind);
  for (const t of ["constructor", "__proto__", "toString"])
    assert.match(refusal({ ...progress, blocks: [{ t: "section", label: "x", body: [{ t, text: "x" }] }, ...progress.blocks] }), /blocks\[0\]\.body\[0\] is not a block/, t);
});

test("F-T984-13: a null block, and sections or a frame nested too deep, are refused, not a crash", () => {
  const progress = fixture("01-progress-note.json");
  assert.match(refusal({ ...progress, blocks: [null, ...progress.blocks] }), /blocks\[0\] is not a block/);
  assert.match(refusal({ ...progress, blocks: [{ t: "section", label: "x", body: [null] }, ...progress.blocks] }), /blocks\[0\]\.body\[0\] is not a block/);
  const nest = (n) => { let b = { t: "p", text: "x" }; for (let i = 0; i < n; i++) b = { t: "section", label: "s", body: [b] }; return b; };
  assert.match(refusal({ ...progress, blocks: [...progress.blocks, nest(5000)] }), /sections nest at most 5 deep/);
  assert.match(refusal({ ...progress, blocks: [...progress.blocks, nest(6)] }), /sections nest at most 5 deep/);
  // Five deep is still a message: a page shows the labels as h2 to h6.
  assert.doesNotMatch(renderMessage({ ...progress, blocks: [...progress.blocks, nest(5)] }).problems?.join("\n") ?? "", /nest/);
  let frame = { box: "task", name: "a", state: "framed" };
  for (let i = 0; i < 5000; i++) frame = { box: "group", name: "g", word: "done", items: [frame] };
  const catchUp = fixture("10-catch-up.json");
  assert.match(refusal({ ...catchUp, blocks: catchUp.blocks.map((b) => (b.t === "picture" ? { ...b, frame } : b)) }), /nested too deep for a box of 46 columns/);
});

test("F-T984-7: no example text numbers a row twice", () => {
  for (const name of ALL) assert.doesNotMatch(render(fixture(name)).text, /^\d+\. \d+\. /m, `${name}: a row numbered twice`);
});

test("F-T984-8: the estimate's total is a total line, not an item, and its title, total and picture agree with its rows", () => {
  const msg = fixture("11-estimate.json"), { text } = render(msg);
  const rows = msg.blocks.find((b) => b.t === "table").rows;
  assert.deepEqual(text.match(/^\d+\. .*/gm).map((l) => l.split(" ")[0]), ["1.", "2.", "3."], "one numbered item for each of the three pull requests");
  const sum = (col, unit) => [0, 1].map((side) => rows.reduce((t, r) => t + Number(r[col].split(` ${unit}`)[0].split(" to ")[side]), 0));
  const [tokLo, tokHi] = sum(1, "M"), [hLo, hHi] = sum(2, "h");
  assert.deepEqual([tokLo, tokHi, hLo, hHi], [10.5, 21, 13, 26]);
  assert.ok(msg.title.includes(`${tokLo} to ${tokHi} M tokens and ${hLo} to ${hHi} h`), msg.title);
  const paragraphs = text.split("\n\n").map((p) => p.replace(/\n/g, " "));
  assert.ok(paragraphs.includes(`All three together: ${tokLo} to ${tokHi} M tokens and ${hLo} to ${hHi} h of agent time.`), "a total line of its own");
  assert.match(text, new RegExp(`All three {2}${tokLo}–${tokHi} `), "the picture's tokens");
  assert.match(text, new RegExp(`All three {2}${hLo}–${hHi} `), "the picture's hours");
});

test("F-T984-9: the confirm example is sample data, and its text says so before its first part", () => {
  const text = render(fixture("13-confirm.json")).text, at = text.indexOf("SAMPLE CONTENT");
  assert.ok(at > 0 && at < text.indexOf("What I will do"), text);
});

/** The state word on the first line of a frame's top box. */
const frameWord = (node) => frameLines(node, 46).lines[1]?.slice(2).trim().replace(/ *│$/, "");
/** A catch-up with its frame replaced. */
const withFrame = (frame) => { const c = fixture("10-catch-up.json"); return { ...c, blocks: c.blocks.map((b) => (b.t === "picture" ? { ...b, frame } : b)) }; };

test("F-T984-44: a milestone that the chief marks done reads done; boxes that disagree with it, and a box of text lines alone, are refused", () => {
  // QA's catch-up (R3325): milestone 4 is done, its tasks one line of text.
  const out = render(withFrame({ box: "release", name: "1.0", items: [
    { box: "milestone", name: "4: Board", state: "done", items: ["All 6 tasks merged"] },
    { box: "milestone", name: "5: Sage feel", items: [{ box: "task", name: "Message command", state: "reviewing", here: true }] }] }));
  assert.equal(out.problems, undefined, out.problems);
  const [frame] = pictures(out.text), at = frame.findIndex((l) => l.includes("Milestone 4: Board"));
  assert.equal(frame[at + 1].slice(4).trim().replace(/ *│ │$/, ""), "Done");
  assert.equal(frameWord({ box: "milestone", name: "4", state: "done" }), "Done");
  assert.equal(frameWord({ box: "milestone", name: "4", state: "done", items: [{ box: "task", name: "b", state: "merged" }] }), "Done");
  // The chief's state and the boxes inside it disagree: the frame is refused, not shown with either word.
  assert.match(frameLines({ box: "milestone", name: "4", state: "done", items: [{ box: "task", name: "b", state: "building" }] }, 46).problems.join("\n"),
    /^frame is done, but its boxes say in progress: give each task its recorded state/);
  // A box whose items are only lines of text has nothing to count: it gives its word.
  for (const node of [{ box: "release", name: "1.0", items: ["Done: milestones 1 to 4"] }, { box: "milestone", name: "4", items: ["All 6 tasks merged"] }])
    assert.match(frameLines(node, 46).problems.join("\n"), /^frame has only lines of text, so no box gives its word: give its word/, node.box);
  assert.equal(frameWord({ box: "release", name: "1.0", word: "done", items: ["Done: milestones 1 to 4"] }), "Done");
  assert.equal(frameWord({ box: "release", name: "1.0", items: [] }), "Not started", "an empty box has nothing in it yet");
});

test("F-T984-48: a group's own word does not hide the tasks inside it: its box counts them", () => {
  const group = { box: "group", name: "g", word: "waiting", items: [{ box: "task", name: "t", state: "building" }] };
  assert.equal(frameWord({ box: "milestone", name: "5", items: [group] }), "In progress");
  assert.equal(frameWord({ box: "release", name: "1.0", items: [{ box: "milestone", name: "5", items: [group] }] }), "In progress");
  assert.equal(frameWord(group), "Waiting", "the group shows its own word");
  // A group with no boxes inside counts as its own word.
  assert.equal(frameWord({ box: "milestone", name: "5", items: [{ box: "group", name: "g", word: "done" }] }), "Done");
});

test("F-T984-46: a catch-up has exactly one double box, the task that runs now", () => {
  const task = (here) => ({ box: "task", name: "t", state: "building", ...(here ? { here: true } : {}) });
  assert.match(refusal(withFrame({ box: "milestone", name: "5", items: [task(false), task(false)] })), /a catch-up has one double box: mark the task that runs now with "here": true/);
  assert.match(refusal(withFrame({ box: "milestone", name: "5", items: [task(true), task(true)] })), /a catch-up has one double box, not 2: mark only the task that runs now with "here": true/);
  assert.equal(render(withFrame({ box: "milestone", name: "5", items: [task(true), task(false)] })).problems, undefined);
});

test("F-T984-27: a kind or a block type that is not a string is refused, not a crash", () => {
  const progress = fixture("01-progress-note.json");
  assert.match(refusal({ ...progress, kind: ["progress"] }), /^kind is one of: progress/);
  assert.match(refusal({ ...progress, blocks: [{ t: ["page"], title: "x", file: "x.html" }, ...progress.blocks] }), /blocks\[0\] is not a block/);
  assert.match(refusal({ ...progress, blocks: [{ t: ["p"], text: "x" }, ...progress.blocks] }), /blocks\[0\] is not a block/);
});

test("F-T984-26: the skill's message steps make the folder before they write a file in it", () => {
  const skill = readFileSync(join(HERE, "..", "writing", "presentation.md"), "utf8");
  const steps = skill.slice(skill.indexOf("## The message command"));
  const writes = [...steps.matchAll(/cat > (\S+)\//g)];
  assert.ok(writes.length > 0, "the steps write the JSON to a file");
  for (const [whole, folder] of writes) {
    const made = steps.indexOf(`mkdir -p ${folder}`);
    assert.ok(made >= 0 && made < steps.indexOf(whole), `a step makes ${folder} before ${whole}`);
  }
});

test("F-T984-30: the lesson's rows say what is true: the check of raw ids runs on the message command's path", () => {
  const lesson = fixture("14-lesson-kept.json"), rows = lesson.blocks.find((b) => b.t === "table").rows;
  const row = rows.find((r) => /^A check that fails on a message with raw ids/.test(r[1]));
  assert.match(row[2], /^Done/, row.join(" | "));
  assert.match(refusal({ ...fixture("01-progress-note.json"), title: "T12 is built" }), /raw ids in the message: T12/);
});

test("F-T984-31: the incident and the design give the cost of the new words that the estimate's rows add up to", () => {
  const rows = fixture("11-estimate.json").blocks.find((b) => b.t === "table").rows;
  const total = [0, 1].map((side) => rows.reduce((t, r) => t + Number(r[1].split(" M")[0].split(" to ")[side]), 0)).join(" to ");
  assert.equal(total, "10.5 to 21");
  for (const name of ["06-incident.json", "07-design.json"]) {
    // The incident also quotes the old figure that was wrong, 2 to 5 M tokens.
    const said = [...render(fixture(name)).text.replace(/\s+/g, " ").matchAll(/([\d.]+ to [\d.]+) M tokens/g)].map((m) => m[1]).filter((r) => r !== "2 to 5");
    assert.ok(said.length > 0 && said.every((r) => r === total), `${name}: ${said.join(", ")}`);
  }
});

test("the page escapes every text, loads nothing, and allows only its own style and the hash of its one script", () => {
  const msg = structuredClone(fixture("05-explainer.json"));
  msg.title = "About <script>alert(1)</script> & \"quotes\"";
  msg.blocks[0].text = 'a <img src=x onerror="alert(2)"> **bold** `code`';
  msg.blocks.find((b) => b.t === "picture").title = "</figcaption><script>alert(3)</script>";
  const { page, problems } = render(msg);
  assert.equal(problems, undefined, problems);
  assert.match(page.html, /<h1>About &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;quotes&quot;<\/h1>/);
  assert.match(page.html, /a &lt;img src=x onerror=&quot;alert\(2\)&quot;&gt; <strong>bold<\/strong> <code>code<\/code>/);
  assert.equal((page.html.match(/<script>/g) ?? []).length, 1, "only the switch script");
  assert.equal((page.html.match(/<img|<link|<iframe/g) ?? []).length, 0);
  const sha = createHash("sha256").update(SWITCH_SCRIPT).digest("base64");
  assert.match(page.html, new RegExp(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'sha256-[^']+'; script-src 'sha256-${sha.replace(/[+/]/g, "\\$&")}'; img-src 'none'; base-uri 'none'; form-action 'none'">`));
  assert.ok(page.html.includes(`<script>${SWITCH_SCRIPT}</script>`));
  const style = /<style>([\s\S]*?)<\/style>/.exec(page.html)[1];
  assert.ok(PAGE_POLICY.includes(`'sha256-${createHash("sha256").update(style).digest("base64")}'`), "the style's hash");
  assert.deepEqual(pageProblems(page.html), []);
  assert.equal(messagePage(prepareMessage(resolved(msg)).msg, "").includes("<script>alert"), false);
});

test("the text form: one blank line between parts, pictures in fences, a table as numbered rows, and no Markdown marks but a card kind's bold labels", () => {
  const text = render(fixture("02-question.json")).text;
  assert.match(text, /^QUESTION\n\nShould sage stop sending pages through the\nClaude app's file tool\?\n\n\*\*Where this is\*\*\nRelease 1\.0 › /);
  assert.match(text, /\n\n1\. Stop: use the link to your Mac only \(my\n {3}pick\)\n {3}- What happens next: Every page reaches you\n/);
  assert.deepEqual(text.split("\n").filter((l) => l.includes("**")), ["Where this is", "What you approve", "The one real choice in it", "If you do not answer", "Needed by", "Judged by", "The bad side of my pick", "After you answer"].map((label) => `**${label}**`), "only the labels are bold, the bold of a cell is dropped");
  const report = render(fixture("03-report.json")).text;
  assert.match(report, /\n {3}- You must act: Yes: update sage\n/);
  assert.match(report, /\n\nWhere this is: /, "a kind that is not on the choice card keeps its labels in the line");
  assert.doesNotMatch(report, /\*\*/);
  const steps = render(fixture("12-steps-for-you.json")).text;
  assert.match(steps, /\n1\. In a terminal, update sage for Claude Code:\n\n {3}```\n {3}claude plugin update sage@sage\n {3}```\n\n {3}Then start a new Claude Code session\.\n/);
  assert.equal(messageText(prepareMessage(resolved(fixture("07-design.json"))).msg).includes("Today\n"), false, "the chat shows the picture after the change; the page has the Today switch");
});

test("T1023: a question or confirm in its fallback text form gives each part under a bold label on its own line and the answers as a list; the check notes an inline label and a table", () => {
  const question = render(fixture("02-question.json")).text, confirm = render(fixture("13-confirm.json")).text;
  assert.match(question, /\n\n\*\*What you approve\*\*\nHow pages reach you in the Claude desktop app\.\n/, "the label alone on its line, the text under it");
  assert.match(confirm, /\n\n\*\*What I will do\*\*\nDelete these 3 folders/);
  assert.equal(question.split("\n").some((l) => l.trimStart().startsWith("|")), false, "the answers are a numbered list, not a table");
  assert.equal(messageMiss(question), undefined);
  assert.equal(messageMiss(confirm), undefined);
  // The same question with one label in the line, or with its answers as a Markdown table: one note each.
  assert.deepEqual(messageMiss(question.replace("**Needed by**\n", "Needed by: ")).names, ["inline label: Needed by"]);
  assert.deepEqual(messageMiss(confirm.replace("**What stays**\n", "What stays: ")).names, ["inline label: What stays"]);
  const table = question.replace(/\n\n1\. [\s\S]*?(?=\n\n\*\*If you do not answer)/, "\n\n| Answer | What happens next | Cost |\n| --- | --- | --- |\n| Stop (my pick) | Pages go by link. | None. |\n| Keep | Some open in the chat. | Small. |");
  assert.deepEqual(messageMiss(table).names, ["table"]);
  // A table of short data in a kind with no answers stays allowed.
  assert.equal(messageMiss(confirm.replace("\n\n**What stays**", "\n\n| Folder | Size |\n| --- | --- |\n| a | 12 MB |\n\n**What stays**")), undefined);
  // The page draws the answers as a list too, the pick marked; a table with no pick stays a table.
  const page = messagePage(prepareMessage(resolved(fixture("02-question.json"))).msg, "");
  assert.match(page, /<ol class="m-answers"><li class="pick"><p class="m-label"><strong>Stop: use the link to your Mac only<\/strong> <span class="pick-mark">\(my pick\)<\/span><\/p><p><span class="m-label">What happens next:<\/span> Every page/);
  assert.doesNotMatch(page, /<table/);
  assert.match(messagePage(prepareMessage(fixture("13-confirm.json")).msg, ""), /<table><thead><tr><th>Folder<\/th>/);
});

test("T1023: a section in a question or a confirm has the same bold label on its own line, and the check passes it", () => {
  const asSection = (msg, label) => ({ ...msg, blocks: msg.blocks.filter((b) => b.t !== "page").map((b) => (b.label === label ? { t: "section", label, body: [{ t: "p", text: b.text }] } : b)) });
  for (const [msg, label] of [[fixture("02-question.json"), "The one real choice in it"], [fixture("13-confirm.json"), "What stays"]]) {
    const out = render(asSection(msg, label));
    assert.equal(out.problems, undefined, `${label}: ${out.problems}`);
    assert.match(out.text, new RegExp(`\\n\\n\\*\\*${label}\\*\\*\\n\\S`), "the label alone on its line, the text right under it");
    assert.equal(messageMiss(out.text), undefined);
  }
});

test("T1023: a hand-written question may keep a colon with its bold label", () => {
  const question = render(fixture("02-question.json")).text;
  assert.equal(messageMiss(question.replace("**Needed by**\n", "**Needed by:**\n")), undefined, "the colon inside the bold");
  assert.equal(messageMiss(question.replace("**Needed by**\n", "**Needed by**:\n")), undefined, "the colon after the bold");
});

test("T1023: a hand-written question may hold a table of short data; a table of answers gets the note", () => {
  const question = render(fixture("02-question.json")).text;
  const data = "\n\n| Folder | Size |\n| --- | --- |\n| pages | 12 MB |";
  assert.equal(messageMiss(question.replace("\n\n**If you do not answer**", `${data}\n\n**If you do not answer**`)), undefined, "a table of short data");
  // A table of answers gets the note also when no row holds the pick: its head names the answers.
  const answers = "\n\n| Answer | What happens next | Cost |\n| --- | --- | --- |\n| Keep | Some open in the chat. | Small. |";
  assert.deepEqual(messageMiss(question.replace("\n\n**If you do not answer**", `${answers}\n\n**If you do not answer**`)).names, ["table"]);
});

test("T1023: the presentation skill's before and after example: the check notes the run-together question with a table, and passes the fallback", () => {
  const skill = readFileSync(join(HERE, "..", "writing", "presentation.md"), "utf8");
  const example = skill.slice(skill.indexOf("### Before and after"), skill.indexOf("## The kinds"));
  const questions = [...example.matchAll(/^```text\n([\s\S]*?)\n```$/gm)].map((m) => m[1]).filter((b) => b.startsWith("QUESTION\n"));
  assert.equal(questions.length, 2, "a before and an after");
  const [before, after] = questions;
  const names = messageMiss(before).names;
  assert.ok(names.includes("table") && names.includes("missing: Where this is"), names.join(", "));
  assert.equal(messageMiss(after), undefined);
});

// ---------------------------------------------------------------- the state tool's message command

function sandbox() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-t984-")));
  const env = { ...process.env, HOME: join(base, "home"), SAGE_HOME: join(base, "sage"), SAGE_TEST_PIDS: "{}", SAGE_TEST_KILLS: join(base, "kills"),
    NODE_OPTIONS: `--import=${JSON.stringify(join(HERE, "kill-spy.mjs"))}` };
  delete env.SAGE_WORKTREES;
  const project = join(base, "project");
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  execFileSync("git", ["-C", project, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "start"]);
  const sage = (...args) => {
    const r = spawnSync("node", [TOOL, ...args, "--project", project], { encoding: "utf8", env, timeout: 60_000 });
    return { status: r.status, out: (r.stdout + r.stderr).trim() };
  };
  assert.equal(sage("init").status, 0);
  assert.equal(sage("task", "add", "--priority", "P2", "--title", "t", "--size", "small").status, 0);
  return { base, sage, file: (name, msg) => { const path = join(base, name); writeFileSync(path, JSON.stringify(msg)); return path; } };
}

test("the message command prints the text, writes the page of a pictured message in the task's pages folder, and the page passes its checks", () => {
  const { base, sage, file } = sandbox();
  const folder = sage("pages", "T1").out;
  const r = sage("message", "T1", "--file", file("catch-up.json", fixture("10-catch-up.json")));
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /^CATCH-UP\n\n/);
  const path = new RegExp(`\\n {2}(${folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/catch-up-[0-9a-f]{8}\\.html)\\n`).exec(r.out)?.[1];
  assert.ok(path && existsSync(path), `the Page block names the written page: ${r.out}`);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(pageProblems(readFileSync(path, "utf8")), []);
  assert.deepEqual(textProblems(r.out), []);
  assert.equal(sage("message", "T1", "--file", file("catch-up.json", fixture("10-catch-up.json"))).out, r.out, "the same message gives the same page again");
  // A message with no picture: the text only, and no page.
  const before = readdirSync(folder).length;
  const plain = sage("message", "T1", "--json", JSON.stringify(fixture("01-progress-note.json")));
  assert.equal(plain.status, 0, plain.out);
  assert.match(plain.out, /^PROGRESS\n\nThe new words: the build is done, and four\nchecks run now\n/);
  assert.doesNotMatch(plain.out, /Page · /);
  assert.equal(readdirSync(folder).length, before);
  // A link that waits at the page's name is replaced, not followed.
  const target = join(base, "outside.txt");
  writeFileSync(target, "keep");
  const html = readFileSync(path, "utf8");
  execFileSync("rm", [path]);
  symlinkSync(target, path);
  assert.equal(sage("message", "T1", "--file", file("catch-up.json", fixture("10-catch-up.json"))).status, 0);
  assert.equal(readFileSync(target, "utf8"), "keep");
  assert.equal(readFileSync(path, "utf8"), html);
});

test("the message command resolves a Page block in a task's pages folder, and refuses a page that is not there, a path, and a wrong shape", () => {
  const { sage, file } = sandbox();
  const question = fixture("02-question.json");
  assert.match(sage("message", "T1", "--file", file("q.json", question)).out, /the page block "Showing visuals in every app" names .*\/pages\/T1000\/research\.html, and it does not exist\. Save the page there first\. Nothing written\./);
  const folder = sage("pages", "T1").out;
  writeFileSync(join(folder, "research.html"), "<p>research</p>");
  const local = { ...question, blocks: question.blocks.map((b) => (b.t === "page" ? { ...b, task: "T1" } : b)) };
  // F-T1001-18: a path through a regular file (research.html is a file) is not there either: the same refusal, not a crash.
  const through = sage("message", "T1", "--json", JSON.stringify({ ...local, blocks: local.blocks.map((b) => (b.t === "page" ? { ...b, file: "research.html/x.html" } : b)) }));
  assert.equal(through.status, 1, through.out);
  assert.match(through.out, /^sage: the page block "Showing visuals in every app" names .*\/research\.html\/x\.html, and it does not exist\. Save the page there first\. Nothing written\./);
  const ok = sage("message", "T1", "--file", file("q.json", local));
  assert.equal(ok.status, 0, ok.out);
  // T1001: the board's link to the page, between the title and the path: its logbook is the folder above the pages folder.
  const logbook = basename(dirname(dirname(folder)));
  assert.ok(ok.out.endsWith(`Page · Showing visuals in every app\n  http://127.0.0.1:43123/pages/${logbook}/T1/research.html\n  ${join(folder, "research.html")}`), ok.out);
  assert.deepEqual(textProblems(ok.out), [], "the link line is part of the Page block, not the message's own words");
  // A file that the board does not serve gets no Page block: a path out, a part with a dot first or with two dots inside
  // (F-T1001-1), a type that is not a page, more than 3 parts.
  for (const page of [{ task: "T1", file: "../T2/x.html" }, { task: "T1", file: "/etc/passwd" }, { task: "../T1", file: "x.html" }, { path: "/etc/passwd" },
    { task: "T1", file: ".research.html" }, { task: "T1", file: "a/.b/x.html" }, { task: "T1", file: "state.json" }, { task: "T1", file: "run.log" }, { task: "T1", file: "a/b/c/x.html" },
    { task: "T1", file: "v1..v2.html" }, { task: "T1", file: "notes..md" }, { task: "T1", file: "a..b/x.html" }])
    assert.match(sage("message", "T1", "--json", JSON.stringify({ ...question, blocks: question.blocks.map((b) => (b.t === "page" ? { t: "page", title: "x", ...page } : b)) })).out, /a page block names its page as \{ t: page, title, task, file \}/, JSON.stringify(page));
  // A link, a file with a second name, or a link in a folder of the path: the board refuses each, so the command does too.
  writeFileSync(join(folder, "outside.html"), "<p>x</p>");
  symlinkSync(join(folder, "outside.html"), join(folder, "link.html"));
  linkSync(join(folder, "outside.html"), join(folder, "hard.html"));
  mkdirSync(join(folder, "real"));
  writeFileSync(join(folder, "real", "in.html"), "<p>x</p>");
  symlinkSync(join(folder, "real"), join(folder, "via"));
  for (const name of ["link.html", "hard.html", "via/in.html"])
    assert.match(sage("message", "T1", "--json", JSON.stringify({ ...local, blocks: local.blocks.map((b) => (b.t === "page" ? { ...b, file: name } : b)) })).out, /names .*, and the board serves only a regular file with one name that it can read, of at most 16 MiB, with no link in its path or in the pages folders/, name);
  const bad = sage("message", "T1", "--json", JSON.stringify({ ...local, blocks: local.blocks.filter((b) => b.label !== "Needed by") }));
  assert.equal(bad.status, 1);
  assert.match(bad.out, /^sage: the message is not in its kind's shape, so nothing reaches the owner in another shape\. Nothing written\.\n- a question needs "Needed by" before "Judged by"/);
  assert.match(sage("message", "T1", "--json", "{not json").out, /the message is not JSON/);
  assert.match(sage("message", "T2", "--json", "{}").out, /no task T2/);
  assert.match(sage("message", "T1").out, /message takes <task> and one of --file/);
});

test("F-T984-24: on the message command's path, sections nested thousands deep are refused, not a stack overflow", () => {
  const { base, sage } = sandbox();
  // The JSON is written as text: JSON.stringify itself recurses, and a small stack (as on CI) overflows in the test.
  const deep = `${'{"t":"section","label":"s","body":['.repeat(5000)}{"t":"page","title":"x","task":"T1","file":"x.html"}${"]}".repeat(5000)}`;
  const progress = fixture("01-progress-note.json"), path = join(base, "deep.json");
  writeFileSync(path, JSON.stringify({ ...progress, blocks: [...progress.blocks, "DEEP"] }).replace('"DEEP"', deep));
  const r = sage("message", "T1", "--file", path);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /^sage: the message is not in its kind's shape[^\n]*\n- blocks\[\d+\]\.body\[0\]\.body\[0\]\.body\[0\]\.body\[0\]\.body\[0\] is a section 6 deep: sections nest at most 5 deep/);
});
