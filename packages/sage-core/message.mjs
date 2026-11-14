import { box, columns, openBoxes, wrap } from "./picture.mjs";
import { milestoneWord, releaseWord, taskWord } from "./state-words.mjs";

export const WIDTH = 46, LONG_WIDTH = 66;
export const INCIDENT_STATUS = ["Investigating", "Identified", "Monitoring", "Resolved"];
const QUESTION_HEAD = ["Answer", "What happens next", "Cost"];
const REPORT_HEAD = ["Piece of work", "What changes for you", "How I know it works", "Cost", "You must act"];
const LESSON_HEAD = ["Where the lesson lives now", "What it holds", "State"];

export const KINDS = {
  progress: { head: "PROGRESS", use: "While a task runs: one short note when it moves to a new step, with nothing for the owner to do.",
    parts: ["Where this is", "?Since my last note", "What changed", "Next", "?Cost so far", "What I need from you"] },
  question: { head: "QUESTION", use: "When work waits for the owner's choice. The title is the question. Ask it on the choice card when the card rule above allows it, else in this text form. Each part starts with a ### heading on its own line. The answers are a numbered list, never a table. A batch puts each question in a section “Question <n>: <short title>”, with its own answers.", tableHead: QUESTION_HEAD, pick: true, card: true,
    parts: ["Where this is", "What you approve", "The one real choice in it", "table+", "If you do not answer", "Needed by", "?Judged by", "?The bad side of my pick", "After you answer", "?page"] },
  report: { head: "REPORT", use: "When work ends: a pull request merged, or a study concluded. The title says what happened and what it needs. The table of the pieces of work goes under its own ### What changed heading.", tableHead: REPORT_HEAD, tableLabel: "What changed",
    parts: ["Where this is", "?Why this change", "picture*", "table", "What I did not check", "Weak points", "What you need to do", "?page"] },
  "request understood": { head: "REQUEST UNDERSTOOD", use: "Right after the owner asks for new work, before agents spend hours on it. It starts on its defaults unless the owner corrects it.",
    parts: ["Your words", "What I understood", "Read back (costly if wrong)", "In", "Out", "Appetite", "?Unsure, with my default", "If you say nothing"] },
  explainer: { head: "EXPLAINER", use: "When the owner asks what a part of sage is, or a message uses a word that is new to the owner. The title is “About …”.",
    parts: ["What it is", "Why it exists", "A real example", "picture*", "?Like, and where the likeness stops", "?What it is not", "?New words", "?page"] },
  incident: { head: "INCIDENT", use: "When an agent did what it must not do, or sage told the owner something that proved wrong. The status is Investigating, Identified, Monitoring or Resolved.",
    parts: ["Where this is", "What happened", "?What I told you, and what is true", "What it changed for you", "What I did", "Why it could happen", "Has it happened before", "What stops it next time", "What you need to do", "Next update"] },
  design: { head: "DESIGN FOR APPROVAL", use: "When a design is ready for approval, before any build. Before and after: one picture of the result with each change tagged and a Today switch, or a change table for changes without a screen.",
    parts: ["Where this is", "?Try it", "?page", "How you will use it", "picture*", "?toggle", "?changes", "?Key", "?Why each change matters", "Goals", "Non-goals", "The choices, and the options I dropped", "?Why we might not do this", "Safety and cost", "Open questions", "What you approve"] },
  architecture: { head: "ARCHITECTURE", use: "When the owner asks how something is built. Usually a picture inside a design or a question: one zoom in each picture, at most 6 boxes, a [type] for each part, labelled one-way arrows, a key that names what is left out.",
    parts: ["picture+", "What changes for you", "What I need from you", "?page"] },
  "state chart": { head: "STATE CHART", use: "When the owner needs to know how one thing moves from state to state. Usually a picture inside another kind: groups as dashed boxes, about 8 to 13 states, a key that names the rest.",
    parts: ["picture", "?table", "What I need from you", "?page"] },
  "catch-up": { head: "CATCH-UP", use: "When the owner comes back after time away, or asks where the work is: boxes inside boxes (release › milestone › task), each with its state word, the current task in a double box.",
    parts: ["picture", "Each box", "Since", "What changed", "If this happens", "What I need from you"] },
  estimate: { head: "ESTIMATE", use: "Before work starts, when the owner asks how long or how much, or when a cost changes a choice. The title is the number, with its unit and range.",
    parts: ["What it covers", "table", "picture*", "Basis", "How sure", "?What would change it", "?So far", "?Your time", "What I need from you"] },
  "steps for you": { head: "STEPS FOR YOU", use: "When only the owner can do something: an install, an update, a setting, a sign-in. A warning goes before the steps it is about.",
    parts: ["When", "Why", "steps", "How you know it worked", "Your time", "If a step fails"] },
  confirm: { head: "CONFIRM", use: "Just before an act that cannot be undone: a delete, a publish, a message to other people. The title names the act and says that it cannot be undone. Ask it on the choice card too when the card rule above allows it, else in its text form, with a ### heading for each part.", card: true,
    parts: ["What I will do", "table", "What stays", "If you say yes", "If you say no, or nothing"] },
  "lesson kept": { head: "LESSON KEPT", use: "When a mistake teaches sage something: the lesson once, and where it now lives.", tableHead: LESSON_HEAD,
    parts: ["What happened", "picture*", "The lesson", "Has it happened before", "table", "What changes for you", "What I need from you"] },
};

export const headOf = (msg) => `${KINDS[msg.kind].head}${msg.status ? ` · ${msg.status}` : ""}`;

const isText = (v) => typeof v === "string" && v.trim() !== "";
const texts = (v) => Array.isArray(v) && v.every((s) => typeof s === "string");
const BLOCKS = {
  field: (b) => isText(b.label) && isText(b.text),
  p: (b) => isText(b.text),
  section: (b) => isText(b.label) && Array.isArray(b.body) && b.body.length > 0,
  list: (b) => texts(b.items) && b.items.length > 0,
  table: (b) => texts(b.head) && Array.isArray(b.rows) && b.rows.length > 0 && b.rows.every((r) => texts(r) && r.length === b.head.length)
    && (b.pick === undefined || (Number.isInteger(b.pick) && b.pick >= 0 && b.pick < b.rows.length)),
  picture: (b) => isText(b.title) && (texts(b.lines) !== (b.frame !== undefined)),
  page: (b) => isText(b.title) && isText(b.path ?? b.file),
  code: (b) => texts(b.lines) && b.lines.length > 0,
  steps: (b) => Array.isArray(b.items) && b.items.length > 0 && b.items.every((s) => isText(s?.text) && (s.cmd === undefined || texts(s.cmd)) && (s.see === undefined || isText(s.see))),
  toggle: (b) => [b.after, b.today].every((side) => Array.isArray(side) && side.length > 0 && side.every((p) => isText(p?.title) && texts(p.lines))),
  changes: (b) => Array.isArray(b.rows) && b.rows.length > 0 && b.rows.every((r) => ["where", "today", "after", "why"].every((k) => isText(r?.[k]))),
};
const SHAPES = {
  field: "{ t: field, label, text }", p: "{ t: p, text }", section: "{ t: section, label, body: [blocks] }", list: "{ t: list, items: [text], ordered }",
  table: "{ t: table, head: [text], rows: [[text]] with one cell for each head, pick: the number of your pick's row, from 0, which the message puts first, caption }",
  picture: "{ t: picture, title, key, and lines: [text] or frame: a box }", page: "{ t: page, title, task, file }", code: "{ t: code, lines: [text] }",
  steps: "{ t: steps, items: [{ text, cmd: [text], see }] }", toggle: "{ t: toggle, after: [{ title, lines }], today: [{ title, lines }] }",
  changes: "{ t: changes, rows: [{ where, today, after, why }] }",
};

const LEVELS = ["release", "milestone", "task", "group"];
const MIN_BOX = 8;
export const MAX_SECTIONS = 5;
export const BATCH = /^Question [1-9]\d*: \S/;
const WORDS = ["not started", "waiting", "needs you", "in progress", "done", "stopped"];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function frameLines(node, width) {
  const problems = [];
  let here = 0;
  const lay = (n, w, path) => {
    if (!n || typeof n !== "object" || !LEVELS.includes(n.box)) { problems.push(`${path} is a box: { box: ${LEVELS.join(" | ")}, name, … }`); return { rows: [], counts: [] }; }
    if (w < MIN_BOX) { problems.push(`${path} is nested too deep for a box of ${width} columns`); return { rows: [], counts: [] }; }
    if (n.here) here++;
    const items = Array.isArray(n.items) ? n.items : [];
    const kids = items.map((item, k) => (typeof item === "string" ? null : lay(item, w - 4, `${path}.items[${k}]`)));
    const words = kids.filter(Boolean).flatMap((kid) => kid.counts);
    let word = null;
    if (n.word !== undefined) {
      if (WORDS.includes(String(n.word).toLowerCase())) word = String(n.word).toLowerCase();
      else problems.push(`${path}.word is one of: ${WORDS.join(", ")}`);
    } else if (n.box === "task") word = taskWord({ state: n.state, reasons: isText(n.needs) ? [{ kind: "owner", text: n.needs }] : [], waitLine: isText(n.waits) ? { text: n.waits } : null }).word;
    else if (n.box === "group") problems.push(`${path} is a group: give its word, one of: ${WORDS.join(", ")}`);
    else if (n.box === "milestone" && n.state === "done") {
      const from = releaseWord(words).word;
      if (words.length && from !== "done") problems.push(`${path} is done, but its boxes say ${from}: give each task its recorded state, or the milestone its state`);
      else word = "done";
    } else if (!words.length && items.length) problems.push(`${path} has only lines of text, so no box gives its word: give its word, one of: ${WORDS.join(", ")}, or its tasks as boxes`);
    else word = (n.box === "milestone" ? milestoneWord({ state: n.state ?? "active" }, words) : releaseWord(words)).word;
    const first = `${word ? cap(word) : "State unknown"}${word === "waiting" && isText(n.waits) ? ` for ${n.waits}` : ""}${isText(n.note) ? ` · ${n.note}` : ""}`;
    const title = isText(n.title) ? n.title : { release: `Release ${n.name}`, milestone: `Milestone ${n.name}`, task: `Task: ${n.name}`, group: `${n.name}` }[n.box];
    let rows = [];
    try {
      rows = box({ w, title, style: n.here ? "double" : "round", lines: [first, ...items.map((item, k) => (typeof item === "string" ? item : kids[k].rows))] });
    } catch (e) { problems.push(`${path}: ${e.message}`); }
    return { rows, counts: n.box === "group" && words.length ? words : [word] };
  };
  const { rows } = lay(node, width, "frame");
  return { lines: rows, problems, here };
}

export function prepareMessage(input) {
  const problems = [];
  const msg = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const kind = typeof msg.kind === "string" && Object.hasOwn(KINDS, msg.kind) ? KINDS[msg.kind] : undefined;
  if (!kind) return { problems: [`kind is one of: ${Object.keys(KINDS).join(", ")}; not ${JSON.stringify(msg.kind ?? "")}`] };
  const long = msg.long !== undefined;
  const width = long ? LONG_WIDTH : WIDTH;
  if (!isText(msg.title)) problems.push("title is the text of the title");
  if (msg.ref !== undefined && !isText(msg.ref)) problems.push("ref is one line of ids, for example \"T12 · PR 40\"");
  if (long && !(isText(msg.long?.title) && isText(msg.long?.main))) problems.push("long is { title, main }: the title and the main point of the chat message; the page holds the rest");
  if (msg.kind === "incident" ? !INCIDENT_STATUS.includes(msg.status) : msg.status !== undefined) problems.push(msg.kind === "incident" ? `status is one of: ${INCIDENT_STATUS.join(", ")}` : "only an incident has a status");
  if (msg.kind === "question" && isText(msg.title) && !msg.title.trim().endsWith("?")) problems.push("the title of a question is the question: it ends with ?");
  if (msg.kind === "confirm" && isText(msg.title) && !/cannot be undone/i.test(msg.title)) problems.push("the title of a confirm names the act and says that it cannot be undone");
  if (!Array.isArray(msg.blocks)) return { problems: [...problems, "blocks is a list of blocks"] };
  const bad = (b) => !b || typeof b !== "object" || typeof b.t !== "string" || !Object.hasOwn(BLOCKS, b.t) || !BLOCKS[b.t](b);
  let here = 0;
  const walk = (blocks, path, depth = 0) => blocks.map((b, k) => {
    if (bad(b)) { problems.push(`${path}[${k}] is not a block. The blocks: ${Object.values(SHAPES).join("; ")}`); return b; }
    if (b.t === "section") {
      if (depth >= MAX_SECTIONS) { problems.push(`${path}[${k}] is a section ${depth + 1} deep: sections nest at most ${MAX_SECTIONS} deep`); return b; }
      return { ...b, body: walk(b.body, `${path}[${k}].body`, depth + 1) };
    }
    if (b.t === "picture") {
      const lines = b.frame !== undefined ? frameLines(b.frame, width) : { lines: b.lines, problems: [], here: 0 };
      here += lines.here;
      problems.push(...lines.problems.map((p) => `${path}[${k}] (${b.title}): ${p}`));
      problems.push(...pictureProblems(lines.lines, width).map((p) => `${path}[${k}] (${b.title}): ${p}`));
      return { ...b, lines: lines.lines };
    }
    if (b.t === "table" && b.pick) return { ...b, rows: [b.rows[b.pick], ...b.rows.filter((_, i) => i !== b.pick)], pick: 0 };
    if (b.t === "toggle") for (const p of [...b.after, ...b.today]) problems.push(...pictureProblems(p.lines, width).map((x) => `${path}[${k}] (${p.title}): ${x}`));
    return b;
  });
  const blocks = walk(msg.blocks, "blocks");
  if (problems.length) return { problems };
  problems.push(...shapeProblems(msg.kind, blocks, { long }));
  const answerBlocks = blocks.filter((b) => nameOf(b, msg.kind) === "table");
  const tables = answerBlocks.flatMap((b) => (b.t === "table" ? [b] : b.body.filter((x) => x.t === "table")));
  if (kind.tableHead && tables.some((t) => t.head.join("|") !== kind.tableHead.join("|"))) problems.push(`the table of a ${msg.kind} has the columns: ${kind.tableHead.join(", ")}`);
  if (kind.pick && tables.some((t) => t.pick === undefined)) problems.push(`each table of a ${msg.kind} marks your pick: pick is the number of its row, from 0, and the message puts that row first`);
  for (const b of answerBlocks) if (b.t === "section" && b.body.filter((x) => x.t === "table").length !== 1) problems.push(`"${b.label}" holds one table: the answers to that question`);
  if (kind.pick && answerBlocks.length > 1 && answerBlocks.some((b) => b.t === "table")) problems.push(`a batch of questions puts each one in a section "Question <n>: <short title>", with its own table of answers`);
  if (msg.kind === "catch-up" && !blocks.some((b) => b.t === "picture" && b.frame !== undefined)) problems.push("a catch-up's picture is a frame: boxes inside boxes from release to task, so that each box gets its state word");
  if (msg.kind === "catch-up" && here !== 1) problems.push(here ? `a catch-up has one double box, not ${here}: mark only the task that runs now with "here": true` : 'a catch-up has one double box: mark the task that runs now with "here": true');
  if (msg.kind === "design" && !blocks.some((b) => b.t === "toggle" || b.t === "changes")) problems.push("a design shows its before and after: a toggle (the picture after the change, each change tagged [new] or [was: …], and today's picture), or a changes table for changes without a screen");
  if (msg.kind === "explainer") for (const b of blocks) if (b.t === "section" && b.label === "New words" && b.body.some((x) => x.t === "list" && x.items.length > 3)) problems.push("New words has at most 3 words");
  return problems.length ? { problems } : { problems, msg: { ...msg, blocks }, width };
}

export function pictureProblems(lines, width = WIDTH) {
  const out = [];
  lines.forEach((l, i) => { if (columns(l) > width) out.push(`line ${i + 1} is ${columns(l)} columns: a picture has at most ${width}`); });
  if (lines.some((l) => TREE.test(l))) out.push("a picture has no tree marks (├ └ ┬ ┴ ┼ ┤ ┌ ┐ ┘): draw boxes inside boxes");
  return [...out, ...openBoxes(lines)];
}
export const TREE = /[├└┬┴┼┤┌┐┘]/;

export const partsOf = (kind) => KINDS[kind].parts.map((p) => {
  const m = /^(\?)?(.+?)([*+])?$/.exec(p);
  return { name: m[2], need: !m[1] && m[3] !== "*", many: !!m[3] };
});
const LABELLED = new Set(["field", "section"]);
const nameOf = (b, kind) => (b.t === "section" && KINDS[kind].pick && BATCH.test(b.label) ? "table" : LABELLED.has(b.t) ? b.label : b.t);

function shapeProblems(kind, blocks, { long }) {
  const parts = partsOf(kind), problems = [], list = parts.map((p) => p.name).join(", ");
  let at = 0;
  for (const b of blocks) {
    if (b.t === "p") continue;
    const name = nameOf(b, kind);
    let k = at;
    while (k < parts.length && parts[k].name !== name) k++;
    if (k === parts.length) {
      if (long && b.t === "section") continue;
      problems.push(parts.some((p) => p.name === name) ? `"${name}" is out of order in a ${kind}. The parts, in order: ${list}` : `"${name}" is not a part of a ${kind}. The parts, in order: ${list}`);
      continue;
    }
    for (const p of parts.slice(at, k)) if (p.need && !p.seen) problems.push(`a ${kind} needs "${p.name}" before "${name}"`);
    parts[k].seen = true;
    at = parts[k].many ? k : k + 1;
  }
  for (const p of parts.slice(at)) if (p.need && !p.seen) problems.push(`a ${kind} needs "${p.name}"`);
  return problems;
}

const plain = (s) => String(s).replace(/\*\*(.+?)\*\*/g, "$1");
const FENCE = "```";

export const BOARD_PORT = 43123;
export const PAGE_MAX = 16 * 1024 * 1024;
export const PAGE_TYPES = Object.freeze({ html: "text/html; charset=utf-8", pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", md: "text/plain; charset=utf-8", txt: "text/plain; charset=utf-8" });
const PAGE_PART = /^(?!.*\.\.)[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
export const pageType = (file) => {
  const parts = String(file).split("/"), type = /\.([a-z0-9]+)$/.exec(parts.at(-1))?.[1];
  return parts.length <= 3 && parts.every((part) => PAGE_PART.test(part)) && Object.hasOwn(PAGE_TYPES, type) ? PAGE_TYPES[type] : null;
};
export const pagePath = (logbook, task, file) => `/pages/${logbook}/${task}/${file}`;
export const pageUrl = (logbook, task, file, port = BOARD_PORT) => `http://127.0.0.1:${port}${pagePath(logbook, task, file)}`;

export const pageBlock = ({ title, url, path, file }, width = WIDTH) => [...wrap(`Page · ${plain(title)}`, width), ...(url ? [`  ${url}`] : []), `  ${path ?? file}`];

export function messageText(msg, { width = WIDTH, page, full = false, today = false } = {}) {
  const own = page ? [pageBlock(page)] : [], ref = msg.ref ? [[`Ref: ${msg.ref}`]] : [];
  const parts = msg.long !== undefined && !full
    ? [[headOf(msg)], wrap(plain(msg.long.title), WIDTH), wrap(`Main point: ${plain(msg.long.main)}`, WIDTH), ...own, ...ref]
    : [[headOf(msg)], wrap(plain(msg.title), width), ...msg.blocks.map((b) => [...(b.t === "table" && KINDS[msg.kind].tableLabel ? [heading(KINDS[msg.kind].tableLabel, 0), ""] : []), ...blockText(b, width, today)]), ...own, ...ref];
  return parts.map((p) => p.join("\n")).join("\n\n");
}

const indentRows = (rows, n) => rows.map((r) => (r ? " ".repeat(n) + r : r));
const bullet = (text, width, mark = "- ", ind = 0) => wrap(plain(text), width - ind - mark.length).map((l, j) => " ".repeat(ind) + (j ? " ".repeat(mark.length) : mark) + l);

const heading = (label, depth) => `${"#".repeat(Math.min(3 + depth, 6))} ${plain(label)}`;

function blockText(b, width, today = false, depth = 0) {
  switch (b.t) {
    case "field": return [heading(b.label, depth), "", ...wrap(plain(b.text), width)];
    case "p": return wrap(plain(b.text), width);
    case "section": {
      const body = b.body.map((x) => (x.t === "field" ? bullet(`${x.label}: ${x.text}`, width) : blockText(x, width, today, depth + 1)));
      return [heading(b.label, depth), "", ...body.flatMap((rows, k) => (k && !(b.body[k].t === "field" && b.body[k - 1].t === "field") ? ["", ...rows] : rows))];
    }
    case "list": return b.items.flatMap((item, i) => bullet(item, width, b.ordered ? `${i + 1}. ` : "- "));
    case "table": return [...(b.caption ? [b.caption, ""] : []), ...b.rows.flatMap((r, i) => [
      ...(i ? [""] : []),
      ...bullet(`${r[0]}${b.pick === i && !/\(my pick\)/i.test(r[0]) ? " (my pick)" : ""}`, width, `${i + 1}. `),
      ...r.slice(1).flatMap((cell, k) => bullet(`${b.head[k + 1]}: ${cell}`, width, "- ", 3)),
    ])];
    case "picture": return [b.title, FENCE, ...b.lines, FENCE, ...(b.key ? ["", ...wrap(plain(b.key), width)] : [])];
    case "toggle": {
      const side = (label, pics) => [label, ...pics.flatMap((p) => ["", p.title, FENCE, ...p.lines, FENCE])];
      return [...side("After this change", b.after), ...(today ? ["", ...side("Today", b.today)] : [])];
    }
    case "changes": return b.rows.flatMap((r, i) => [...(i ? [""] : []), ...bullet(r.where, width, `${i + 1}. `),
      ...[["Today", r.today], ["After this change", r.after], ["Why", r.why]].flatMap(([label, text]) => bullet(`${label}: ${text}`, width, "- ", 3))]);
    case "page": return pageBlock(b, width);
    case "code": return [FENCE, ...b.lines, FENCE];
    case "steps": return b.items.flatMap((s, i) => [...(i ? [""] : []), ...bullet(s.text, width, `${i + 1}. `),
      ...(s.cmd ? ["", ...indentRows([FENCE, ...s.cmd, FENCE], 3)] : []), ...(s.see ? ["", ...indentRows(wrap(plain(s.see), width - 3), 3)] : [])]);
    default: throw new Error(`unknown block ${b.t}`);
  }
}
