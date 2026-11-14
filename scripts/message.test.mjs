import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderChiefInstructions } from "../packages/sage-core/roles.mjs";
import { KINDS, frameLines, messageText, partsOf, prepareMessage } from "../packages/sage-core/message.mjs";
import { PAGE_POLICY, SWITCH_SCRIPT, messagePage } from "../packages/sage-core/message-page.mjs";
import { kindOf, messageMiss, pageProblems, renderMessage, textProblems } from "../packages/sage-core/message-checks.mjs";
import { columns, openBoxes, pictureSvg } from "../packages/sage-core/picture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "messages");
const TOOL = join(HERE, "..", "plugins", "sage", "skills", "sage", "sage.mjs");
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const ALL = readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).sort();
const resolved = (msg) => ({ ...msg, blocks: msg.blocks.map((b) => (b.t === "page" ? { ...b, path: `/pages/${b.task}/${b.file}` } : b)) });
const render = (msg) => renderMessage(resolved(msg), { pagePath: (name) => `/pages/T1/${name}` });
const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
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
  assert.equal(word({ box: "task", name: "a", state: "merged" }), "Done");
  assert.equal(word({ box: "task", name: "a", state: "abandoned" }), "Stopped");
  assert.equal(word({ box: "task", name: "a", state: "framed", waits: "the rename" }), "Waiting for the rename");
  assert.equal(word({ box: "task", name: "a", state: "building", needs: "Approve the plan?" }), "Needs you");
  assert.equal(word({ box: "task", name: "a", state: "framed" }), "Not started");
  assert.equal(word({ box: "task", name: "a", state: "dreaming" }), "State unknown");
  assert.equal(word({ box: "milestone", name: "1: a", state: "proposed" }), "Needs you");
  assert.equal(word({ box: "milestone", name: "1: a", items: [{ box: "task", name: "b", state: "merged" }, { box: "task", name: "c", state: "concluded" }] }), "Done");
  assert.equal(word({ box: "release", name: "1.0", items: [{ box: "task", name: "b", state: "abandoned" }] }), "Stopped");
  assert.deepEqual(frameLines({ box: "group", name: "x" }, 46).problems, ["frame is a group: give its word, one of: not started, waiting, needs you, in progress, done, stopped"]);
  assert.match(frameLines({ box: "task", name: "a very long name that cannot fit into the top edge of its box", state: "framed" }, 46).problems[0], /too long for a box of 46 columns/);
});

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
  const lines = ["╭─ Release 1.0 ─╮", "│ In progress   │", "╰───────────────╯"];
  assert.notEqual(pictureSvg(lines), pictureSvg(lines.map((l) => l.replace("In progress", "Done       "))));
});

test("the checks catch the designer's negative cases: width, tree marks, an image not from the text, outside loads, raw ids", () => {
  const out = render(fixture("10-catch-up.json")), html = out.page.html;
  const wide = out.text.replace("│ Done: milestones 1 to 4                    │", "│ Done: milestones 1 to 4                     │");
  assert.match(textProblems(wide).join("\n"), /line 21 is 47 columns: a picture has at most 46/);
  assert.deepEqual(textProblems(wide, { width: 66 }).filter((p) => /columns/.test(p)), [], "66 on a long page");
  assert.match(textProblems(out.text.replace("What changed\n", "What changed\n├─ one\n")).join("\n"), /tree marks/);
  const stale = html.replace(/(<svg class="pic"[\s\S]*?)In progress/, "$1Done");
  assert.match(pageProblems(stale).join("\n"), /1 of the page's 1 images are not drawn from a picture of its text form/);
  for (const [what, page] of [["an image", html.replace("<main>", '<main><img src="https://example.com/x.png">')],
    ["a style sheet", html.replace("</head>", '<link rel="stylesheet" href="https://example.com/x.css"></head>')],
    ["an import", html.replace("<style>", "<style>@import 'https://example.com/x.css';")],
    ["a link", html.replace("<main>", '<main><a href="https://example.com/">x</a>')]])
    assert.match(pageProblems(page).join("\n"), /the page loads from outside itself/, what);
  assert.match(pageProblems(html.replace("</body>", "<script>fetch('https://example.com')</script></body>")).join("\n"), /2 scripts/);
  assert.match(pageProblems(html.replace(PAGE_POLICY, "default-src *")).join("\n"), /Content-Security-Policy is not sage's/);
  for (const id of ["T12345", "G7", "M12", "R40", "C2", "F-T807-1", "PR 515", "T10"])
    assert.match(textProblems(out.text.replace("18:00 today.", `18:00 today, after ${id}.`)).join("\n"), new RegExp(`raw ids in the message: ${id}\\.`), id);
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
  const arch = fixture("08-architecture.json");
  const flow = render({ ...arch, blocks: arch.blocks.map((b) => (b.t === "picture" ? { ...b, lines: ["Brief  ▶  Run  ▶  Report"] } : b)) });
  assert.equal(flow.problems, undefined, flow.problems?.join("\n"));
  assert.deepEqual(textProblems(flow.text), []);
});

test("the raw-id check has none of the false hits that the PE found: the Ref line, the Page block, code, the board, a message with no kind", () => {
  const out = render(fixture("10-catch-up.json"));
  assert.match(out.text, /Ref: T984 · T995 to T997/);
  assert.deepEqual(textProblems(out.text), [], "the Ref line and the Page block's path may name ids");
  assert.deepEqual(textProblems(out.text.replace("18:00 today.", "18:00 today, on the Mac with the `M4` chip.")), [], "a word in code is not an id");
  assert.deepEqual(textProblems(out.text.replace("18:00 today.", "18:00 today. R2-D2, MT5, T-10 and 4K are words.")), []);
  assert.deepEqual(textProblems(`${out.text}\n\n**sage board** · built 2026-11-11 20:00 UTC\n### 🔴 Needs you\n**1 · T10 a task** · G7`), [], "the board's text is not the message's own");
  assert.deepEqual(textProblems("The board: T10 waits for G7 in M4, and ├─ marks a tree."), [], "a message that names no kind is not checked");
});

test("T1005: messageMiss gives the note of a hand-written message that misses its kind's shape, with each problem, and names with no word of the message", () => {
  const out = render(fixture("02-question.json")).text;
  assert.equal(messageMiss(out), undefined, "a message that fits");
  assert.equal(messageMiss("Done: T10 merged.\n├─ next"), undefined, "a message with no kind");
  const hand = out.replace(/\n\n### Needed by\n\n[\s\S]*?(?=\n\n)/, "").replace(/\(my\s+pick\)/, "").replace("### Where this is\n\n", "### Where this is\n\nT4242, and\n├─ a tree.\n");
  const miss = messageMiss(hand);
  assert.equal(miss.kind, "question");
  assert.deepEqual(miss.names, ["tree marks", "raw ids", "missing: Needed by", "no pick"]);
  assert.deepEqual(miss.note.split("\n").slice(1, -1), textProblems(hand).map((p) => `- ${p}`), "the note lists each problem of the text check");
  assert.match(miss.note, /^sage: your last message names the kind "question"/);
  const needed = /\n\n### Needed by\n\n[\s\S]*?(?=\n\n)/.exec(out)[0];
  assert.deepEqual(messageMiss(out.replace(needed, "").replace("\n\n### If you do not answer", `${needed}\n\n### If you do not answer`)).names, ["out of order: Needed by"]);
  const chart = render(fixture("09-state-chart.json")).text.replace(/```[\s\S]*?```/g, "");
  assert.deepEqual(messageMiss(chart).names, ["missing picture"]);
});

test("F-T984-11: on the message command's path, a word in code and a product name are not ids, and the state tool's ids are", () => {
  const progress = fixture("01-progress-note.json");
  const say = (text) => render({ ...progress, blocks: [progress.blocks[0], { t: "p", text }, ...progress.blocks.slice(1)] });
  for (const text of ["The tests ran on the Mac with the `M4` chip.", "Run `sage show T12` and `gh pr view 40` first.", "A long code span: `node sage.mjs message T12 --file /tmp/sage-message/T12.json` wraps."]) {
    const out = say(text);
    assert.equal(out.problems, undefined, `${text}: ${out.problems}`);
    assert.match(out.text, /`[^`]+/, "the text form keeps the code marks");
  }
  for (const text of ["The tests ran on the M4 Mac.", "It runs on an M2 chip and an M3 Pro.", "The old G5 server is gone.", "Play a C3 chord.", "A MacBook with an M4 Max."])
    assert.equal(say(text).problems, undefined, text);
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
  design.blocks.splice(4, 0, { t: "changes", rows: [{ where: "The status lines", today: "“0 of 8 merged”", after: "“0 of 8 done”", why: "A study that ended counts too." }] });
  const changed = render(design);
  assert.equal(changed.problems, undefined, changed.problems);
  assert.match(changed.text, /\n1\. The status lines\n {3}- Today: “0 of 8 merged”\n {3}- After this change: “0 of 8 done”\n {3}- Why: A study that ended counts too\./);
  assert.match(textProblems(render(fixture("02-question.json")).text.replace(/\n\n### Needed by\n\n[\s\S]*?(?=\n\n)/, "")).join("\n"), /a question needs "Needed by"/);
});

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

const frameWord = (node) => frameLines(node, 46).lines[1]?.slice(2).trim().replace(/ *│$/, "");
const withFrame = (frame) => { const c = fixture("10-catch-up.json"); return { ...c, blocks: c.blocks.map((b) => (b.t === "picture" ? { ...b, frame } : b)) }; };

test("F-T984-44: a milestone that the chief marks done reads done; boxes that disagree with it, and a box of text lines alone, are refused", () => {
  const out = render(withFrame({ box: "release", name: "1.0", items: [
    { box: "milestone", name: "4: Board", state: "done", items: ["All 6 tasks merged"] },
    { box: "milestone", name: "5: Sage feel", items: [{ box: "task", name: "Message command", state: "reviewing", here: true }] }] }));
  assert.equal(out.problems, undefined, out.problems);
  const [frame] = pictures(out.text), at = frame.findIndex((l) => l.includes("Milestone 4: Board"));
  assert.equal(frame[at + 1].slice(4).trim().replace(/ *│ │$/, ""), "Done");
  assert.equal(frameWord({ box: "milestone", name: "4", state: "done" }), "Done");
  assert.equal(frameWord({ box: "milestone", name: "4", state: "done", items: [{ box: "task", name: "b", state: "merged" }] }), "Done");
  assert.match(frameLines({ box: "milestone", name: "4", state: "done", items: [{ box: "task", name: "b", state: "building" }] }, 46).problems.join("\n"),
    /^frame is done, but its boxes say in progress: give each task its recorded state/);
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

test("the text form: one blank line between parts, each part under a ### heading, pictures in fences, a table as numbered rows, and no bold marks", () => {
  const text = render(fixture("02-question.json")).text;
  assert.match(text, /^QUESTION\n\nShould sage stop sending pages through the\nClaude app's file tool\?\n\n### Where this is\n\nRelease 1\.0 › /);
  assert.match(text, /\n\n1\. Stop: use the link to your Mac only \(my\n {3}pick\)\n {3}- What happens next: Every page reaches you\n/);
  assert.deepEqual(text.split("\n").filter((l) => l.startsWith("#")), ["Where this is", "What you approve", "The one real choice in it", "If you do not answer", "Needed by", "Judged by", "The bad side of my pick", "After you answer"].map((label) => `### ${label}`), "a heading for each part");
  assert.doesNotMatch(text, /\*\*/, "no bold label, and the bold of a cell is dropped");
  const report = render(fixture("03-report.json")).text;
  assert.match(report, /\n {3}- You must act: Yes: update sage\n/);
  assert.match(report, /^REPORT\n\n[^\n]+\n[^\n]+\n\n### Where this is\n\nRelease 1\.0 › /, "a kind that is not on the choice card has the same headings");
  assert.doesNotMatch(report, /\*\*/);
  const steps = render(fixture("12-steps-for-you.json")).text;
  assert.match(steps, /\n1\. In a terminal, update sage for Claude Code:\n\n {3}```\n {3}claude plugin update sage@sage\n {3}```\n\n {3}Then start a new Claude Code session\.\n/);
  assert.equal(messageText(prepareMessage(resolved(fixture("07-design.json"))).msg).includes("Today\n"), false, "the chat shows the picture after the change; the page has the Today switch");
});

test("T1043: a question or confirm in its fallback text form gives each part under a ### heading and the answers as a list; the check notes a bold label, an inline label and a table", () => {
  const question = render(fixture("02-question.json")).text, confirm = render(fixture("13-confirm.json")).text;
  assert.match(question, /\n\n### What you approve\n\nHow pages reach you in the Claude desktop app\.\n/, "the heading alone on its line, a blank line, the text under it");
  assert.match(confirm, /\n\n### What I will do\n\nDelete these 3 folders/);
  assert.equal(question.split("\n").some((l) => l.trimStart().startsWith("|")), false, "the answers are a numbered list, not a table");
  assert.equal(messageMiss(question), undefined);
  assert.equal(messageMiss(confirm), undefined);
  assert.deepEqual(messageMiss(question.replace("### Needed by\n\n", "Needed by: ")).names, ["inline label: Needed by"]);
  assert.deepEqual(messageMiss(confirm.replace("### What stays\n\n", "What stays: ")).names, ["inline label: What stays"]);
  const bold = messageMiss(question.replace("### Needed by\n\n", "**Needed by**\n"));
  assert.deepEqual(bold.names, ["bold label: Needed by"]);
  assert.match(bold.note, /"Needed by" is a bold line: use a ### heading/);
  assert.deepEqual(messageMiss(confirm.replace("### What stays\n\n", "**What stays**\n\n")).names, ["bold label: What stays"]);
  const table = question.replace(/\n\n1\. [\s\S]*?(?=\n\n### If you do not answer)/, "\n\n| Answer | What happens next | Cost |\n| --- | --- | --- |\n| Stop (my pick) | Pages go by link. | None. |\n| Keep | Some open in the chat. | Small. |");
  assert.deepEqual(messageMiss(table).names, ["table"]);
  assert.equal(messageMiss(confirm.replace("\n\n### What stays", "\n\n| Folder | Size |\n| --- | --- |\n| a | 12 MB |\n\n### What stays")), undefined);
  const page = messagePage(prepareMessage(resolved(fixture("02-question.json"))).msg, "");
  assert.match(page, /<ol class="m-answers"><li class="pick"><p class="m-label"><strong>Stop: use the link to your Mac only<\/strong> <span class="pick-mark">\(my pick\)<\/span><\/p><p><span class="m-label">What happens next:<\/span> Every page/);
  assert.doesNotMatch(page, /<table/);
  assert.match(messagePage(prepareMessage(fixture("13-confirm.json")).msg, ""), /<ol class="m-answers"><li><p class="m-label">~\/sage-worktrees\/old-board-shots<\/p><p><span class="m-label">What is in it:<\/span> 41 pictures/);
});

test("T1043: a section in a question or a confirm has the same ### heading, and the check passes it", () => {
  const asSection = (msg, label) => ({ ...msg, blocks: msg.blocks.filter((b) => b.t !== "page").map((b) => (b.label === label ? { t: "section", label, body: [{ t: "p", text: b.text }] } : b)) });
  for (const [msg, label] of [[fixture("02-question.json"), "The one real choice in it"], [fixture("13-confirm.json"), "What stays"]]) {
    const out = render(asSection(msg, label));
    assert.equal(out.problems, undefined, `${label}: ${out.problems}`);
    assert.match(out.text, new RegExp(`\\n\\n### ${label}\\n\\n\\S`), "the heading alone on its line, the text after one blank line");
    assert.equal(messageMiss(out.text), undefined);
  }
});

test("T1043: a hand-written heading may keep a colon or have another level; a bold label with a colon is still a bold label", () => {
  const question = render(fixture("02-question.json")).text;
  assert.equal(messageMiss(question.replace("### Needed by\n", "### Needed by:\n")), undefined, "the colon in the heading");
  assert.equal(messageMiss(question.replace("### Needed by\n", "## Needed by\n")), undefined, "another heading level");
  assert.deepEqual(messageMiss(question.replace("### Needed by\n\n", "**Needed by:**\n")).names, ["bold label: Needed by"], "the colon inside the bold");
  assert.deepEqual(messageMiss(question.replace("### Needed by\n\n", "**Needed by**:\n")).names, ["bold label: Needed by"], "the colon after the bold");
});

test("T1043: every kind gives each part a ### heading with a blank line before and after; a section inside a section gets ####", () => {
  for (const name of readdirSync(join(HERE, "fixtures", "messages")).filter((f) => f.endsWith(".json"))) {
    const msg = resolved(fixture(name)), prepared = prepareMessage(msg);
    if (prepared.msg.long !== undefined) continue;
    const text = messageText(prepared.msg, { width: prepared.width }), lines = text.split("\n");
    const labels = prepared.msg.blocks.flatMap((b) => (b.t === "field" || b.t === "section" ? [b.label] : b.t === "table" && msg.kind === "report" ? ["What changed"] : []));
    assert.deepEqual(lines.filter((l) => /^#{3} /.test(l)), labels.map((l) => `### ${l}`), name);
    lines.forEach((l, i) => { if (/^#{3} /.test(l)) assert.ok(lines[i - 1] === "" && lines[i + 1] === "", `${name}: blank lines around ${l}`); });
    assert.equal(lines.some((l) => /^\*\*.+\*\*:?$/.test(l.trim())), false, `${name}: no bold line`);
  }
  const progress = fixture("01-progress-note.json");
  const nested = render({ ...progress, blocks: progress.blocks.map((b) => (b.label === "What changed" ? { t: "section", label: "What changed", body: [{ t: "section", label: "Inner", body: [{ t: "p", text: "One more line." }] }] } : b)) });
  assert.match(nested.text ?? nested.problems.join("\n"), /\n\n### What changed\n\n#### Inner\n\nOne more line\.\n\n### Next\n/);
});

test("F-T1043-1: a table column or a field in a section with the name of a part of the kind renders, and the check passes the text", () => {
  const named = (kind) => partsOf(kind).filter((p) => /^[A-Z]/.test(p.name)).map((p) => p.name);
  let tables = 0;
  for (const name of ALL) {
    const msg = fixture(name);
    if (KINDS[msg.kind].tableHead || !msg.blocks.some((b) => b.t === "table")) continue;
    const parts = named(msg.kind);
    const renamed = { ...msg, blocks: msg.blocks.map((b) => (b.t === "table" ? { ...b, head: b.head.map((h, k) => (k ? parts[(k - 1) % parts.length] : h)) } : b)) };
    const out = render(renamed);
    assert.equal(out.problems, undefined, `${name}: ${out.problems}`);
    assert.equal(messageMiss(out.text), undefined, name);
    tables++;
  }
  assert.ok(tables >= 3, "the estimate, the state chart and the confirm");
  const estimate = fixture("11-estimate.json");
  const basis = render({ ...estimate, blocks: estimate.blocks.map((b) => (b.t === "table" ? { ...b, head: ["Pull request", "Tokens", "Basis"] } : b)) });
  assert.equal(basis.problems, undefined, basis.problems);
  assert.match(basis.text, /\n {3}- Basis: /);
  const progress = fixture("01-progress-note.json");
  const fields = render({ ...progress, blocks: progress.blocks.map((b) => (b.label === "What changed" ? { t: "section", label: "What changed", body: [{ t: "field", label: "Next", text: "QA starts." }, { t: "field", label: "Cost so far", text: "1 M tokens." }] } : b)) });
  assert.equal(fields.problems, undefined, fields.problems);
  assert.match(fields.text, /\n\n### What changed\n\n- Next: QA starts\.\n- Cost so far: 1 M tokens\.\n\n### Next\n/);
  assert.equal(messageMiss(fields.text), undefined);
});

test("F-T1043-2: text that starts with a part's name and a colon gets no note when the part's heading is there, and the note when it is not", () => {
  const steps = "STEPS FOR YOU\n\nUpdate sage\n\n### When\n\nNow.\n\n### Why\n\nThe fix is in the new version.\n\n1. Run the update.\n   Why: the old hook stays until you do.\n\n### How you know it worked\n\nThe version shows 1.2.\n\n### Your time\n\n2 minutes.\n\n### If a step fails\n\nTell me the error.";
  const progress = "PROGRESS\n\nReview is clean\n\n### Where this is\n\nRelease 1.0 › single task › step: review\n\n### What changed\n\n- The review is clean.\n- Next: QA starts.\n\n### Next\n\nQA.\n\n### What I need from you\n\nNothing.";
  assert.equal(messageMiss(steps), undefined, "Why: under a step, with the Why heading");
  assert.equal(messageMiss(progress), undefined, "- Next: in a list, with the Next heading");
  assert.equal(messageMiss(progress.replace("### What changed\n\n", "### What changed\n\nNext: QA starts soon.\n")), undefined, "Next: in the text of another part, with the Next heading");
  assert.deepEqual(messageMiss(steps.replace("### Why\n\n", "Why: ")).names, ["inline label: Why"]);
  assert.deepEqual(messageMiss(progress.replace("### Next\n\nQA.", "Next: QA.")).names, ["inline label: Next"]);
  assert.deepEqual(messageMiss(progress.replace("### Next\n\nQA.", "**Next**\nQA.")).names, ["bold label: Next"]);
});

test("F-T1043-3: a report gives the table of the pieces of work its own ### heading, after the part before it", () => {
  const report = render(fixture("03-report.json")).text;
  assert.match(report, /\n\n### Where this is\n\nRelease 1\.0 › [^#]*?merged on 10 Nov\n\n### What changed\n\n1\. Leads wait for the automatic checks before\n/);
  assert.equal(messageMiss(report), undefined);
  assert.doesNotMatch(render(fixture("11-estimate.json")).text, /### What changed/, "only a report's table");
});

test("F-T1043-4: a question, a confirm or a progress note with its parts as a list of bold labels gets a note for each part; a plain list item gets none", () => {
  const progress = "PROGRESS\n\nReview is clean\n\n### Where this is\n\nRelease 1.0 › single task › step: review\n\n### What changed\n\n- The review is clean.\n\n### Next\n\nQA.\n\n### What I need from you\n\nNothing.";
  for (const text of [render(fixture("02-question.json")).text, render(fixture("13-confirm.json")).text, progress]) {
    const labels = [...text.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    assert.ok(labels.length >= 4, text.split("\n")[0]);
    assert.deepEqual(messageMiss(text.replace(/^### (.+)\n\n/gm, "- **$1:** ")).names, labels.map((l) => `inline label: ${l}`), text.split("\n")[0]);
    assert.equal(messageMiss(text.replace(/^### (.+)\n\n/gm, "- $1: ")), undefined, `${text.split("\n")[0]}: a plain list item`);
  }
});

test("F-T1026-1: a question gives its pick as answer 1; a pick on another answer gets a note, also from the message command", () => {
  const question = render(fixture("02-question.json")).text;
  assert.equal(messageMiss(question), undefined);
  const second = question.replace(" (my\n   pick)", "").replace("2. Keep the file tool as an extra for some\n   pages", "2. Keep the file tool as an extra for some\n   pages (my pick)");
  assert.deepEqual(messageMiss(second).names, ["pick not first"]);
  assert.match(messageMiss(second).note, /answer 2 says "\(my pick\)", so make it answer 1/);
  assert.equal(messageMiss(question.replace("### If you do not answer\n\nThe page link build uses my pick.", "### If you do not answer\n\nThe build uses answer 1 (my pick).")), undefined, "the pick named again in a later part");
});

test("F-T1026-2 and F-T1026-3: a table of answers gets the note with the head Answer, Answers, Option, Options or Choice, also with no pick in the table", () => {
  const question = render(fixture("02-question.json")).text;
  for (const head of ["Answer", "Answers", "Option", "options", "**Choice**"]) {
    const table = question.replace(/\n\n1\. [\s\S]*?(?=\n\n### If you do not answer)/, `\n\n| ${head} | Cost |\n| --- | --- |\n| Stop | None. |\n| Keep | Small. |\n\nMy pick is Stop (my pick).`);
    assert.deepEqual(messageMiss(table).names, ["table"], head);
  }
  assert.equal(messageMiss(question.replace("\n\n### If you do not answer", "\n\n| Folder | Size |\n| --- | --- |\n| pages | 12 MB |\n\n### If you do not answer")), undefined, "a table of short data");
});

test("F-T1026-6: a field keeps its own letter case under its heading", () => {
  const confirm = fixture("13-confirm.json");
  const out = render({ ...confirm, blocks: confirm.blocks.map((b) => (b.label === "What stays" ? { ...b, text: "iPhone pages and npm updates stay." } : b)) });
  assert.match(out.text, /\n### What stays\n\niPhone pages and npm updates stay\.\n/);
});

test("F-T1026-7: a bold label with its text in the same line gets the inline-label note, not a note that the part is missing", () => {
  const question = render(fixture("02-question.json")).text;
  const inline = messageMiss(question.replace("### Needed by\n\n", "**Needed by** "));
  assert.deepEqual(inline.names, ["inline label: Needed by"]);
  assert.match(inline.note, /"Needed by" is in the line: use a ### heading on its own line/);
});

test("F-T1026-11 and F-T1026-13: a confirm page draws its items as a list, like its text form; a kind that is not on the choice card keeps its table", () => {
  const page = messagePage(prepareMessage(fixture("13-confirm.json")).msg, "");
  assert.doesNotMatch(page, /<table/);
  assert.equal((page.match(/<li>/g) ?? []).length, 3, "one item for each folder");
  assert.match(messagePage(prepareMessage(fixture("11-estimate.json")).msg, ""), /<table><thead>/);
});

test("F-T1026-12: a plain list item with bold text later in the line gets no inline-label note; a bold label at its start still does", () => {
  const progress = "PROGRESS\n\nReview is clean\n\n### Where this is\n\nRelease 1.0 › single task › step: review\n\n### What changed\n\n- The review is clean.\n\n### Next\n\nQA.\n\n### What I need from you\n\nNothing.";
  assert.equal(messageMiss(progress.replace("### Next\n\nQA.", "- Next: QA, with a **big** test set.")), undefined);
  assert.deepEqual(messageMiss(progress.replace("### Next\n\nQA.", "- **Next:** QA, with a **big** test set.")).names, ["inline label: Next"]);
});

test("T1043: a message after a --- rule keeps its kind, so the check still reads it; a message with no kind is not checked", () => {
  const question = render(fixture("02-question.json")).text, report = render(fixture("03-report.json")).text;
  for (const rule of ["---", "***", "___"]) {
    assert.equal(kindOf(`${rule}\n\n${question}`), "question", rule);
    assert.equal(messageMiss(`${rule}\n\n${question}`), undefined, rule);
  }
  assert.equal(kindOf(`---\n\n${report}`), "report");
  const bold = `---\n\n${report.replace("### Weak points\n\n", "**Weak points**\n")}`;
  assert.deepEqual(messageMiss(bold).names, ["bold label: Weak points"]);
  assert.equal(messageMiss("Starting the lead for the new words now."), undefined, "a plain progress line");
});

test("T1023: a hand-written question may hold a table of short data; a table of answers gets the note", () => {
  const question = render(fixture("02-question.json")).text;
  const data = "\n\n| Folder | Size |\n| --- | --- |\n| pages | 12 MB |";
  assert.equal(messageMiss(question.replace("\n\n### If you do not answer", `${data}\n\n### If you do not answer`)), undefined, "a table of short data");
  const answers = "\n\n| Answer | What happens next | Cost |\n| --- | --- | --- |\n| Keep | Some open in the chat. | Small. |";
  assert.deepEqual(messageMiss(question.replace("\n\n### If you do not answer", `${answers}\n\n### If you do not answer`)).names, ["table"]);
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
  const before = readdirSync(folder).length;
  const plain = sage("message", "T1", "--json", JSON.stringify(fixture("01-progress-note.json")));
  assert.equal(plain.status, 0, plain.out);
  assert.match(plain.out, /^PROGRESS\n\nThe new words: the build is done, and four\nchecks run now\n/);
  assert.doesNotMatch(plain.out, /Page · /);
  assert.equal(readdirSync(folder).length, before);
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
  const { base, sage, file } = sandbox();
  const question = fixture("02-question.json");
  assert.match(sage("message", "T1", "--file", file("q.json", question)).out, /the page block "Showing visuals in every app" names .*\/pages\/T1000\/research\.html, and it does not exist\. Save the page there first\. Nothing written\./);
  const folder = sage("pages", "T1").out;
  writeFileSync(join(folder, "research.html"), "<p>research</p>");
  const local = { ...question, blocks: question.blocks.map((b) => (b.t === "page" ? { ...b, task: "T1" } : b)) };
  const through = sage("message", "T1", "--json", JSON.stringify({ ...local, blocks: local.blocks.map((b) => (b.t === "page" ? { ...b, file: "research.html/x.html" } : b)) }));
  assert.equal(through.status, 1, through.out);
  assert.match(through.out, /^sage: the page block "Showing visuals in every app" names .*\/research\.html\/x\.html, and it does not exist\. Save the page there first\. Nothing written\./);
  const ok = sage("message", "T1", "--file", file("q.json", local));
  assert.equal(ok.status, 0, ok.out);
  const logbook = basename(dirname(dirname(folder)));
  assert.ok(ok.out.endsWith(`Page · Showing visuals in every app\n  http://127.0.0.1:43123/pages/${logbook}/T1/research.html\n  ${join(folder, "research.html")}`), ok.out);
  assert.deepEqual(textProblems(ok.out), [], "the link line is part of the Page block, not the message's own words");
  const boardFolder = join(base, "home", ".config", "sage-board");
  mkdirSync(boardFolder, { recursive: true });
  writeFileSync(join(boardFolder, "board.port"), "43999\n");
  const moved = sage("message", "T1", "--file", file("q.json", local));
  assert.ok(moved.out.endsWith(`\n  http://127.0.0.1:43999/pages/${logbook}/T1/research.html\n  ${join(folder, "research.html")}`), `T1079: the link names the port of the board that started last: ${moved.out}`);
  writeFileSync(join(boardFolder, "board.port"), "80\n");
  assert.ok(sage("message", "T1", "--file", file("q.json", local)).out.includes("\n  http://127.0.0.1:43123/pages/"), "T1079: a port out of 1024 to 65535 gives the default port");
  for (const page of [{ task: "T1", file: "../T2/x.html" }, { task: "T1", file: "/etc/passwd" }, { task: "../T1", file: "x.html" }, { path: "/etc/passwd" },
    { task: "T1", file: ".research.html" }, { task: "T1", file: "a/.b/x.html" }, { task: "T1", file: "state.json" }, { task: "T1", file: "run.log" }, { task: "T1", file: "a/b/c/x.html" },
    { task: "T1", file: "v1..v2.html" }, { task: "T1", file: "notes..md" }, { task: "T1", file: "a..b/x.html" }])
    assert.match(sage("message", "T1", "--json", JSON.stringify({ ...question, blocks: question.blocks.map((b) => (b.t === "page" ? { t: "page", title: "x", ...page } : b)) })).out, /a page block names its page as \{ t: page, title, task, file \}/, JSON.stringify(page));
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
  const deep = `${'{"t":"section","label":"s","body":['.repeat(5000)}{"t":"page","title":"x","task":"T1","file":"x.html"}${"]}".repeat(5000)}`;
  const progress = fixture("01-progress-note.json"), path = join(base, "deep.json");
  writeFileSync(path, JSON.stringify({ ...progress, blocks: [...progress.blocks, "DEEP"] }).replace('"DEEP"', deep));
  const r = sage("message", "T1", "--file", path);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /^sage: the message is not in its kind's shape[^\n]*\n- blocks\[\d+\]\.body\[0\]\.body\[0\]\.body\[0\]\.body\[0\]\.body\[0\] is a section 6 deep: sections nest at most 5 deep/);
});

const batch = (picks) => {
  const json = fixture("02-question.json"), table = json.blocks.find((b) => b.t === "table");
  const rows = [["Fold them", "Old pages go under a closed group.", "Small."], ["List them all", "Every page stays.", "None."], ["Delete them", "Old pages go for good.", "Small."]];
  const questions = [
    { t: "section", label: "Question 1: Page links", body: [{ t: "p", text: "Should pages reach you only by a link?" }, { ...table, pick: picks[0] }] },
    { t: "section", label: "Question 2: Old pages", body: [{ t: "p", text: "Should the board list old pages?" }, { t: "table", head: table.head, rows, pick: picks[1] }] },
  ];
  return { ...json, blocks: json.blocks.flatMap((b) => (b.t === "table" ? questions : [b])) };
};

test("F-T1046-1: a JSON pick in any row is rendered first, as answer 1 with (my pick), on the text form and on the page; the other rows keep their order", () => {
  const json = fixture("02-question.json"), table = json.blocks.find((b) => b.t === "table");
  const rows = [...table.rows, ["Wait a week", "Nothing changes now.", "None."]];
  const plain = (cell) => cell.replace(/\*\*/g, "");
  for (const pick of [0, 1, 2]) {
    const msg = { ...json, blocks: json.blocks.map((b) => (b.t === "table" ? { ...b, rows, pick } : b)) }, out = render(msg);
    assert.deepEqual(out.problems, undefined, `pick ${pick}`);
    const order = [rows[pick], ...rows.filter((_, i) => i !== pick)].map((r) => plain(r[0]));
    const firsts = [...out.text.matchAll(/^(\d)\. ((?:.|\n {3}(?!- ))+)/gm)].map((m) => [m[1], m[2].replace(/\n {3}/g, " ")]);
    assert.deepEqual(firsts, order.map((label, i) => [String(i + 1), i ? label : `${label} (my pick)`]), `pick ${pick}`);
    assert.equal(messageMiss(out.text), undefined);
    const page = /<ol class="m-answers">([\s\S]*?)<\/ol>/.exec(messagePage(prepareMessage(resolved(msg)).msg, out.text))[1];
    assert.deepEqual([...page.matchAll(/<li( class="pick")?><p class="m-label">(?:<strong>)?([^<]+)/g)].map((m) => [!!m[1], m[2].trim()]), order.map((label, i) => [i === 0, label]), `page, pick ${pick}`);
  }
});

test("F-T1046-1: the JSON help and the refusal say that the message puts the pick's row first", () => {
  const json = fixture("02-question.json");
  const out = render({ ...json, blocks: json.blocks.map((b) => (b.t === "table" ? { ...b, pick: undefined } : b)) });
  assert.match(out.problems.join("\n"), /pick is the number of its row, from 0, and the message puts that row first/);
  const help = render({ ...json, blocks: [{ t: "table" }] }).problems.join("\n");
  assert.match(help, /pick: the number of your pick's row, from 0, which the message puts first/);
});

test("F-T1046-2: a batch of 2 questions renders each under its own ### Question heading with its own answers, pick first; the check reads each question", () => {
  const out = render(batch([0, 2]));
  assert.equal(out.problems, undefined);
  assert.match(out.text, /\n### The one real choice in it\n[\s\S]*\n\n### Question 1: Page links\n\nShould pages reach you only by a link\?\n\n1\. Stop: use the link to your Mac only \(my\n {3}pick\)\n[\s\S]*\n\n### Question 2: Old pages\n\nShould the board list old pages\?\n\n1\. Delete them \(my pick\)\n[\s\S]*\n2\. Fold them\n[\s\S]*\n3\. List them all\n[\s\S]*\n\n### If you do not answer\n/);
  assert.equal(messageMiss(out.text), undefined);
  const late = out.text.replace("1. Delete them (my pick)", "1. Delete them").replace("3. List them all", "3. List them all (my pick)");
  assert.deepEqual(messageMiss(late).names, ["pick not first"]);
  assert.match(messageMiss(late).note, /answer 3 in "Question 2: Old pages" says "\(my pick\)", so make it answer 1/);
  const none = out.text.replace("1. Delete them (my pick)", "1. Delete them");
  assert.deepEqual(messageMiss(none).names, ["no pick"]);
  assert.match(messageMiss(none).note, /marks your pick with "\(my pick\)" in "Question 2: Old pages"/);
  const first = out.text.replace(/\(my\n {3}pick\)/, "").replace("2. Keep the file tool as an extra for some\n   pages", "2. Keep the file tool as an extra for some\n   pages (my pick)");
  assert.deepEqual(messageMiss(first).names, ["pick not first"], "the first question is read too");
});

test("F-T1046-2: a batch of questions in JSON needs a pick and one table in each question, and no bare table beside a question", () => {
  assert.match(render(batch([0, undefined])).problems.join("\n"), /each table of a question marks your pick/);
  const two = batch([0, 1]);
  two.blocks.find((b) => b.label === "Question 2: Old pages").body.pop();
  assert.match(render(two).problems.join("\n"), /"Question 2: Old pages" holds one table: the answers to that question/);
  const mixed = batch([0, 1]);
  mixed.blocks.splice(mixed.blocks.findIndex((b) => b.label === "Question 1: Page links"), 1, fixture("02-question.json").blocks.find((b) => b.t === "table"));
  assert.match(render(mixed).problems.join("\n"), /a batch of questions puts each one in a section "Question <n>: <short title>"/);
});

test("F-T1046-3: the card rule holds the background condition only for Claude's card; in Codex the card may be used while work runs", () => {
  const bindings = (provider) => JSON.parse(readFileSync(join(HERE, "..", "packages", `sage-${provider}`, "chief-bindings.json"), "utf8"));
  const step4 = (provider) => /\n4\. \*\*Ask the product questions first:\*\*[^\n]*/.exec(renderChiefInstructions(bindings(provider)))[0];
  assert.match(step4("claude"), /on a choice card \(`AskUserQuestion`\) only while no run of yours works in the background and the batch fits \(at most 4 questions of at most 4 options\), else in the text form;/);
  assert.match(step4("codex"), /on a choice card \(`request_user_input_async` when you have it\) when the batch fits \(at most 4 questions of at most 4 options\), also while work runs, because it does not hold your turn; else in the text form;/);
  assert.doesNotMatch(step4("codex"), /no run of yours works in the background/);
  const skill = readFileSync(join(HERE, "..", "writing", "presentation.md"), "utf8");
  const rule = /\*\*The card rule\.\*\*[\s\S]*?\n\n1\. /.exec(skill)[0];
  assert.match(rule, /In Claude, no lead or other background run of yours runs\./);
  assert.match(rule, /Codex's card does not hold your turn, so in Codex you may use it while work runs\./);
});
