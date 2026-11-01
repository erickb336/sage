// T573: builds the principle review page (index.html) from the current principles and proposal.mjs, and checks each
// new text first. It reads the repository; it changes nothing outside this folder. Run: node design/T573/build-page.mjs
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MOMENTS } from "../../packages/sage-core/principles.mjs";
import { GROUPS, QUESTIONS, ROWS } from "./proposal.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const LIMIT = 200, SHARED_RUN_LIMIT = 6, SENTENCE_LIMIT = 25; // a run of 6 or more words shared with an old text fails
const VERSION = "proposal v1";
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");
const words = (s) => s.split(/\s+/).filter(Boolean).length;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---- The current principles: the same set that scripts/build.mjs ships.
function parse(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta = {};
  let key = null;
  for (const line of m[1].split("\n")) {
    const k = line.match(/^([A-Za-z-]+):\s?(.*)$/);
    if (k) { key = k[1]; meta[key] = k[2]; } else if (key) meta[key] += " " + line.trim();
  }
  return { meta, body: m[2].trim() };
}
const unquote = (s) => (s.startsWith('"') ? JSON.parse(s) : s);
function currentPrinciples() {
  const list = new Map();
  for (const f of readdirSync(join(ROOT, "principles")).filter((f) => f.endsWith(".md") && f !== "README.md")) {
    const { meta, body } = parse(read("principles", f));
    list.set(meta.id, { id: meta.id, name: meta.name, applyWhen: meta.applyWhen, source: meta.source, upstream: meta.upstream ?? "", origin: /^pstack /.test(meta.source) ? "pstack, adapted" : "sage's own", body, shared: [body] });
  }
  const { sha } = JSON.parse(read("upstream/pstack.json"));
  for (const d of readdirSync(join(ROOT, "upstream/pstack/skills"))) {
    const id = d.replace(/^principle-/, ""), p = join("upstream/pstack/skills", d, "SKILL.md");
    if (!existsSync(join(ROOT, p))) continue;
    const { meta, body } = parse(read(p));
    if (list.has(id)) { list.get(id).shared.push(body); continue; }
    const title = body.match(/^# (.+)$/m)[1];
    const clean = body.replace(/^# .+\n+/, "").replace(/\[([^\]]+)\]\(\.\.\/[^)]+\)/g, "$1");
    list.set(id, { id, name: title, applyWhen: unquote(meta.description).split(/(?<=\.)\s/)[0].replace(/^Apply (?:when |to )?/, "").replace(/\.$/, "."), source: `pstack ${d}, MIT, Copyright (c) 2026 Lauren Tan, github.com/cursor/plugins at ${sha.slice(0, 7)}, as it is`, upstream: "", origin: "pstack, as it is", body: clean, shared: [clean] });
  }
  return list;
}

// ---- Where each principle is used today: the hook moments and the role files.
const MOMENT_NAMES = { design: "design request", refactor: "refactor request", testEdit: "test edit", docEdit: "document edit", readmeEdit: "README edit", commit: "commit", checkFailed: "failed check", fixesFailed: "failed repairs", unchecked: "stop with no check" };
function usesToday() {
  const uses = new Map();
  const add = (id, kind, what) => {
    if (!uses.has(id)) uses.set(id, { moments: [], roles: [] });
    uses.get(id)[kind].push(what);
  };
  for (const [m, { skills }] of Object.entries(MOMENTS)) for (const s of skills) if (s.startsWith("principle-")) add(s.slice(10), "moments", MOMENT_NAMES[m]);
  const dir = "packages/sage-claude/agents";
  for (const f of readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".md"))) {
    for (const m of read(dir, f).matchAll(/sage:principle-([a-z-]+)/g)) add(m[1], "roles", f.replace(/\.md$/, ""));
  }
  return uses;
}

// ---- Small Markdown: paragraphs, lists, bold and code spans.
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
function markdown(text) {
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of text.split("\n")) {
    const li = line.match(/^(-|\d+\.)\s+(.*)$/);
    if (li) {
      const want = li[1] === "-" ? "ul" : "ol";
      if (list !== want) { close(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${inline(li[2])}</li>`);
    } else if (!line.trim()) close();
    else { close(); out.push(`<p>${inline(line.replace(/^#+\s*/, ""))}</p>`); }
  }
  close();
  return out.join("");
}

// ---- The checks on the proposal.
const flagged = read("writing/dictionary.md").match(/\*\*Flagged:\*\* (.+)/)[1].replace(/\s*\(say merge check\)/, "").split(", ");
const SOFT = ["issue", "phase", "pipeline", "workflow", "ticket", "job", "subagent", "worker", "human", "user story"]; // "do not say" words that the repository check leaves to writers
const plainWords = (s) => s.toLowerCase().replace(/\*\*/g, "").replace(/[^a-z0-9'-]+/g, " ").trim().split(/\s+/);
function longestSharedRun(text, corpus) {
  const a = plainWords(text);
  const seen = new Set();
  for (const c of corpus) {
    const b = plainWords(c);
    for (let i = 0; i + 3 <= b.length; i++) seen.add(b.slice(i, i + 3).join(" "));
  }
  let best = { n: 0, run: "" };
  for (let i = 0; i < a.length; i++) {
    if (!seen.has(a.slice(i, i + 3).join(" "))) continue;
    for (let n = 3; i + n <= a.length; n++) {
      const run = a.slice(i, i + n).join(" ");
      if (!corpus.some((c) => plainWords(c).join(" ").includes(run))) break;
      if (n > best.n) best = { n, run };
    }
  }
  return best;
}
const sentences = (text) => text.replace(/\*\*/g, "").split("\n").flatMap((l) => l.replace(/^(-|\d+\.)\s+/, "").split(/(?<=[.?!:;])\s+/)).map((s) => s.trim()).filter(Boolean);
const wordHit = (text, w) => new RegExp(`(^|[^a-z])${w.replace(/ /g, "\\s+")}s?([^a-z]|$)`, "i").test(text);

function check(old) {
  const problems = [], table = [];
  const seen = new Set();
  const ids = new Map();
  for (const r of ROWS) {
    if (!old.has(r.old)) problems.push(`${r.old}: not a current principle`);
    if (seen.has(r.old)) problems.push(`${r.old}: two rows`);
    seen.add(r.old);
    if (r.next) {
      if (ids.has(r.next.id)) problems.push(`${r.next.id}: two rows`);
      ids.set(r.next.id, r);
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(r.next.id)) problems.push(`${r.next.id}: bad id`);
    }
  }
  for (const id of old.keys()) if (!seen.has(id)) problems.push(`${id}: no row`);
  const corpus = [...old.values()].filter((p) => p.origin !== "sage's own").flatMap((p) => p.shared);
  for (const r of ROWS) {
    if (r.action === "merge" && !ids.has(r.target)) problems.push(`${r.old}: unknown target ${r.target}`);
    if (r.action === "split") for (const p of r.parts) if (!ids.has(p.into)) problems.push(`${r.old}: unknown part target ${p.into}`);
    for (const f of ["reason", "fit"]) {
      if (!r[f]) problems.push(`${r.old}: no ${f}`);
      else if (words(r[f]) > 32) problems.push(`${r.old}: the ${f} has ${words(r[f])} words`);
      const open = (r[f] ?? "").replace(/"[^"]*"/g, " ");
      for (const w of flagged) if (wordHit(open, w)) problems.push(`${r.old}: flagged word in the ${f}: ${w}`);
    }
    if (!r.next) continue;
    const text = r.next.sameText ? old.get(r.old).body : r.next.text;
    const n = words(text);
    if (n > LIMIT) problems.push(`${r.next.id}: ${n} words`);
    for (const w of [...flagged, ...SOFT]) if (wordHit(`${r.next.name} ${r.next.applyWhen} ${text}`, w)) problems.push(`${r.next.id}: word "${w}"`);
    if (/\bstep\b|\bsteps\b/i.test(text)) problems.push(`${r.next.id}: "step" has a fixed meaning in the dictionary`);
    if (!/\*\*Stop\*\*/.test(text)) problems.push(`${r.next.id}: no Stop rule`);
    const long = sentences(text).filter((s) => words(s) > SENTENCE_LIMIT);
    const shared = r.next.sameText ? { n: 0, run: "(sage's own text, kept)" } : longestSharedRun(text, corpus);
    if (shared.n >= SHARED_RUN_LIMIT) problems.push(`${r.next.id}: shares ${shared.n} words with an old text: "${shared.run}"`);
    table.push({ id: r.next.id, words: n, longSentences: long.length, sharedRun: shared.n, run: shared.run });
    for (const s of long) console.log(`note: ${r.next.id}: ${words(s)} words: ${s}`);
  }
  return { problems, table, ids };
}

// ---- The page.
const old = currentPrinciples();
const uses = usesToday();
const { problems, table, ids } = check(old);
const nameOf = (id) => ids.get(id).next.name;
const newSource = (s) => s.replace(/, (adapted|as it is)$/, ", rewritten in sage's words");
const ACTION_WORD = { keep: "Keep", rewrite: "Rewrite", merge: "Merge", split: "Split", drop: "Drop" };

const usedToday = (id) => {
  const u = uses.get(id);
  if (!u) return `<span class="use none">Skill listing only</span>`;
  const parts = [];
  if (u.moments.length) parts.push(`<span class="use">Hook: ${esc(u.moments.join(", "))}</span>`);
  if (u.roles.length) parts.push(`<span class="use">Roles: ${esc(u.roles.join(", "))}</span>`);
  return parts.join("");
};
const creditsFor = (r) => {
  const incoming = ROWS.filter((x) => (x.action === "merge" && x.target === r.next.id) || (x.action === "split" && x.parts.some((p) => p.into === r.next.id)));
  const own = r.action === "keep" ? old.get(r.old).source : newSource(old.get(r.old).source);
  return [own, ...incoming.map((x) => `Also from: ${newSource(old.get(x.old).source)}`)];
};

function rowHtml(r, n) {
  const p = old.get(r.old);
  const oldCell = `<td class="c-old" role="cell" data-label="Old">
    <div class="head"><span class="num">${n}</span><div><h3>${esc(p.name)}</h3><p class="origin">${esc(p.origin)}</p></div></div>
    <p class="when"><span>Apply when</span> ${esc(p.applyWhen)}</p>
    <details class="oldtext" open><summary>Old text · ${words(p.body)} words</summary><div class="md">${markdown(p.body)}</div>
    <p class="src">Source: ${esc(p.source)}${p.upstream ? `<br>Fingerprint: ${esc(p.upstream)}` : ""}</p></details>
  </td>`;
  let newCell;
  if (r.next) {
    const text = r.next.sameText ? p.body : r.next.text;
    const renamed = r.next.name !== p.name;
    newCell = `<td class="c-new" role="cell" data-label="New">
      <div class="head"><div><h3>${esc(r.next.name)}</h3><p class="origin">${renamed ? "New name" : "Same name"} · ${words(text)} words${r.next.sameText ? " · same text" : ""}</p></div></div>
      <p class="when"><span>Apply when</span> ${esc(r.next.applyWhen)}</p>
      <div class="md">${markdown(text)}</div>
      <p class="src">${creditsFor(r).map((c) => (c.startsWith("Also") ? esc(c) : `Source: ${esc(c)}`)).join("<br>")}</p>
    </td>`;
  } else if (r.action === "merge") {
    newCell = `<td class="c-new" role="cell" data-label="New">
      <div class="head"><div><h3>No text of its own</h3><p class="origin">Goes into <a href="#row-${esc(r.target)}">${esc(nameOf(r.target))}</a></p></div></div>
      <p class="sub">What moves</p><ul class="plain">${r.moves.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>
      <p class="sub">What is lost</p><p class="lost">${esc(r.lost)}</p>
    </td>`;
  } else {
    newCell = `<td class="c-new" role="cell" data-label="New">
      <div class="head"><div><h3>No text of its own</h3><p class="origin">Splits into ${r.parts.length} principles</p></div></div>
      <p class="sub">Where each part goes</p><ul class="plain">${r.parts.map((x) => `<li><a href="#row-${esc(x.into)}">${esc(nameOf(x.into))}</a>: ${esc(x.what)}</li>`).join("")}</ul>
    </td>`;
  }
  const target = r.action === "merge" ? ` into <a href="#row-${esc(r.target)}">${esc(nameOf(r.target))}</a>` : "";
  const propCell = `<td class="c-prop" role="cell" data-label="Proposal">
    <p class="action"><span class="badge a-${r.action}">${ACTION_WORD[r.action]}</span>${target}</p>
    <p class="reason">${esc(r.reason)}</p>
    <p class="sub">Fit with sage today</p><p class="fit">${esc(r.fit)}</p>
    <p class="uses">${usedToday(r.old)}</p>
  </td>`;
  const label = esc(r.next?.name ?? p.name);
  const markCell = `<td class="c-mark" role="cell" data-label="Your mark"><div class="stick">
    <div class="marks" role="group" aria-label="Your mark for ${label}">
      <button type="button" class="mark m-keep" data-mark="keep" aria-pressed="false">Keep</button>
      <button type="button" class="mark m-change" data-mark="change" aria-pressed="false">Change</button>
      <button type="button" class="mark m-drop" data-mark="drop" aria-pressed="false">Drop</button>
    </div>
    <p class="effect" aria-live="polite"></p>
    <label class="note" hidden>What to change<textarea rows="4" placeholder="For example: keep it separate"></textarea></label>
  </div></td>`;
  return `<tr role="row" id="row-${esc(r.next?.id ?? r.old)}" data-old="${esc(r.old)}" data-action="${r.action}">${oldCell}${newCell}${propCell}${markCell}</tr>`;
}

function tableHtml() {
  let n = 0, html = "";
  GROUPS.forEach((g, i) => {
    const rows = ROWS.filter((r) => r.group === i);
    html += `<tbody role="rowgroup"><tr role="row" class="group"><th role="columnheader" colspan="4" scope="colgroup"><h2>${esc(g)}</h2></th></tr>${rows.map((r) => rowHtml(r, ++n)).join("")}</tbody>`;
  });
  return html;
}

function glanceHtml() {
  return GROUPS.map((g, i) => {
    const rows = ROWS.filter((r) => r.group === i && r.next);
    return `<div class="gl"><h3>${esc(g)}</h3><ul>${rows.map((r) => {
      const from = ROWS.filter((x) => (x.action === "merge" && x.target === r.next.id) || (x.action === "split" && x.parts.some((p) => p.into === r.next.id))).map((x) => old.get(x.old).name);
      return `<li><a href="#row-${esc(r.next.id)}">${esc(r.next.name)}</a>${from.length ? `<span class="from"> takes in ${esc(from.join(", "))}</span>` : ""}</li>`;
    }).join("")}</ul></div>`;
  }).join("");
}

function questionsHtml() {
  return QUESTIONS.map((q) => `<fieldset class="q" data-q="${q.id}"><legend><span class="num">${q.id}</span> ${esc(q.text)}</legend><p class="why">${esc(q.why)}</p><div class="opts">${q.options.map((o) => `<button type="button" class="opt" data-opt="${o.key}" aria-pressed="false"><strong>${o.key}. ${esc(o.label)}</strong>${o.recommended ? ` <span class="rec">Recommended</span>` : ""}<span class="optd">${esc(o.detail)}</span></button>`).join("")}</div></fieldset>`).join("");
}

const counts = { rows: ROWS.length, next: ROWS.filter((r) => r.next).length, merge: ROWS.filter((r) => r.action === "merge").length, split: ROWS.filter((r) => r.action === "split").length, rewrite: ROWS.filter((r) => r.action === "rewrite").length, keep: ROWS.filter((r) => r.action === "keep").length };

const pageData = {
  version: VERSION,
  rows: ROWS.map((r, i) => ({ n: i + 1, old: r.old, id: r.next?.id ?? r.old, name: r.next?.name ?? old.get(r.old).name, action: r.action, target: r.target ?? null, targetName: r.target ? nameOf(r.target) : null, parts: r.parts?.map((p) => nameOf(p.into)) ?? null, incoming: r.next ? ROWS.filter((x) => (x.action === "merge" && x.target === r.next.id) || (x.action === "split" && x.parts.some((p) => p.into === r.next.id))).length : 0 })),
  questions: QUESTIONS.map((q) => ({ id: q.id, text: q.text, options: Object.fromEntries(q.options.map((o) => [o.key, o.label])) })),
};

const CSS = readFileSync(join(HERE, "page.css"), "utf8");
const JS = readFileSync(join(HERE, "page.js"), "utf8");
const licence = read("upstream/pstack/LICENSE").trim();
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Principles Review</title>
<style>${CSS}</style>
</head>
<body>
<div class="proposal-flag">Proposal for review. Nothing here is in force. No principle changes until you agree and a later task builds it.</div>
<header class="intro">
  <h1>Principles review</h1>
  <p class="lead">This page proposes a new set of sage principles in sage's own words: ${counts.rows} principles become ${counts.next}. Mark each row, then paste your marks in the chat.</p>
  <p>Goal: task T573 frees sage from pstack for version 1. No pstack text stays, only its credit. Next: an implementer builds what you mark. Until then, no file of sage changes.</p>
  <ul class="tally">
    <li><strong>${counts.rewrite}</strong> rewrite</li><li><strong>${counts.merge}</strong> merge</li><li><strong>${counts.split}</strong> split</li><li><strong>${counts.keep}</strong> keep</li><li><strong>0</strong> drop</li>
  </ul>
  <h2 class="h-how">Your three marks</h2>
  <dl class="key">
    <div><dt><span class="k m-keep">Keep</span></dt><dd>Do what the row proposes.</dd></div>
    <div><dt><span class="k m-change">Change</span></dt><dd>You want something else. Write what.</dd></div>
    <div><dt><span class="k m-drop">Drop</span></dt><dd>This principle leaves sage, and its text goes nowhere.</dd></div>
  </dl>
  <p class="hint">Press a mark again to clear it. This browser remembers your marks when you reload.</p>
  <details class="glance" open><summary>The ${counts.next} new principles at a glance</summary><div class="glgrid">${glanceHtml()}</div></details>
</header>
<noscript><p class="banner warn">The marks need JavaScript. You can still read the whole proposal here.</p></noscript>
<div class="bar" id="bar">
  <p class="banner warn" id="storage-warning" hidden>This browser does not keep your marks. Copy the text before you close the page.</p>
  <div class="progress"><span id="count">0 of ${counts.rows} rows marked</span><span class="meter" aria-hidden="true"><span id="meter-fill"></span></span></div>
  <button type="button" class="primary" id="copy">Copy my choices</button>
  <p class="status" id="status" role="status" aria-live="polite"></p>
</div>
<main>
  <div class="filters" role="group" aria-label="Show rows">
    <button type="button" class="chip" data-filter="all" aria-pressed="true">All rows</button>
    <button type="button" class="chip" data-filter="open" aria-pressed="false">Not marked</button>
    <button type="button" class="chip" data-filter="moved" aria-pressed="false">Merges and splits</button>
  </div>
  <p class="empty" id="empty" hidden></p>
  <table role="table" aria-label="Old and new principles">
    <thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Old</th><th role="columnheader" scope="col">New</th><th role="columnheader" scope="col">Proposal</th><th role="columnheader" scope="col">Your mark</th></tr></thead>
    ${tableHtml()}
  </table>
  <section class="questions" aria-labelledby="qh">
    <h2 id="qh">Three questions for you</h2>
    <p>These cover the whole set, not one row. The copied text includes your answers.</p>
    ${questionsHtml()}
  </section>
  <section class="finish" aria-labelledby="fh">
    <h2 id="fh">Send your marks</h2>
    <p id="finish-line">Copy the text, then paste it in the chat.</p>
    <div class="finish-actions"><button type="button" class="primary" id="copy2">Copy my choices</button><button type="button" class="quiet" id="clear">Clear all marks</button></div>
    <details id="preview"><summary>See the text that the button copies</summary><textarea id="copy-text" rows="14" readonly aria-label="The text to copy"></textarea></details>
  </section>
</main>
<footer>
  <p>The principles come from pstack by Lauren Tan (MIT), at github.com/cursor/plugins, and from the owner of sage. Thank you to Lauren Tan. The old texts on this page are copies, for review only.</p>
  <details><summary>The pstack licence</summary><pre>${esc(licence)}</pre></details>
</footer>
<script id="data" type="application/json">${JSON.stringify(pageData).replace(/</g, "\\u003c")}</script>
<script>${JS}</script>
</body>
</html>
`;

if (/\/Users\/|\/private\/tmp|<script src|<link /.test(html)) problems.push("the page has a local path or an external file");
console.log("id                          words  long  sharedRun");
for (const t of table) console.log(t.id.padEnd(28), String(t.words).padStart(4), String(t.longSentences).padStart(5), String(t.sharedRun).padStart(6), " ", t.run);
console.log(`rows ${ROWS.length}, current principles ${old.size}, new principles ${counts.next}, largest new text ${Math.max(...table.map((t) => t.words))} words, longest shared run ${Math.max(...table.map((t) => t.sharedRun))} words`);
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n${problems.join("\n")}`);
  process.exit(1);
}
writeFileSync(join(HERE, "index.html"), html);
console.log("wrote index.html,", Buffer.byteLength(html), "bytes");
