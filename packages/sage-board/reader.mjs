import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { BRIEF_FIELDS, LONG_WIDTH, PAGE_MAX, REPORT_FIELDS, WIDTH, briefSections, fieldsOf, frameLines, pageFile, pageTaskFolder, pageType, readReport, taskPanel } from "../sage-core/index.mjs";

const marksShown = text => String(text ?? "").replace(/\p{Cf}/gu, c => `[U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}]`);
const TEXT_MAX = 1 << 20, MD_MAX = 2 << 20, VERSIONS_MAX = 30, SHOTS_MAX = 8;
const RUN = /^R[1-9]\d*$/, GATE = /^G[1-9]\d*$/, NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const PICTURE = /\.(?:png|jpe?g|gif|webp|svg)$/i;
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const pad = n => String(n).padStart(2, "0");
const esc = text => marksShown(text).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const b64 = key => Buffer.from(key).toString("base64url");
function dedent(text) {
  const [first, ...rest] = String(text ?? "").split(/\r?\n/), indent = Math.min(...rest.filter(line => line.trim()).map(line => /^[ \t]*/.exec(line)[0].length));
  return [first.trim(), ...rest.map(line => line.slice(Number.isFinite(indent) ? indent : 0))].join("\n").trim();
}
const firstLine = text => String(text ?? "").trim().split(/\r?\n/)[0] ?? "";

export function logbookDir(configured, task) {
  const source = configured.find(item => item.id === task.source);
  return source && !task.old && task.project.startsWith(`${source.id}/`) ? join(source.path, task.project.slice(task.project.indexOf("/") + 1)) : null;
}

const LINK = "The file is a link, and the board does not open links.";
const unread = why => Object.assign(new Error(why), { why });
const whyUnread = error => error.why ?? (error instanceof SyntaxError ? "The file is not valid JSON." : "The board cannot read the file now. Reload this page to read it again.");
function readText(file, max = TEXT_MAX) {
  let stat;
  try { stat = lstatSync(file); } catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return undefined; throw error; }
  if (stat.isSymbolicLink()) throw unread(LINK);
  if (stat.isDirectory()) throw unread("It is a folder, not a file.");
  if (!stat.isFile()) throw unread("It is not a regular file.");
  if (stat.size > max) throw unread(`The file is over ${max >> 20} MiB, so the reader does not show it.`);
  return readFileSync(file, "utf8");
}
function notOpened(file) {
  try { return lstatSync(file).isSymbolicLink() || realpathSync(file) !== file ? LINK : `The board opens only a regular file of at most ${PAGE_MAX >> 20} MiB, with one name.`; } catch { return null; }
}
function readJson(file, max = TEXT_MAX) {
  try { const text = readText(file, max); return text === undefined ? undefined : JSON.parse(text); } catch { return null; }
}
const folderNames = dir => { try { return lstatSync(dir).isDirectory() ? readdirSync(dir).sort((a, b) => a.localeCompare(b, "en", { numeric: true })) : []; } catch { return []; } };

function when(at, now) {
  const date = new Date(at);
  if (!at || Number.isNaN(date.getTime())) return "time not recorded";
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.toDateString() === new Date(now).toDateString() ? clock : `${date.getDate()} ${MONTHS[date.getMonth()]} ${clock}`;
}
const plural = (n, word) => `${n} ${n === 1 ? word : `${word}s`}`;
const ago = (from, to) => { const n = minutes(from, to); return !Number.isFinite(n) ? "" : n < 60 ? ` (${n} min ago)` : n < 2880 ? ` (${Math.round(n / 60)} h ago)` : ` (${Math.round(n / 1440)} days ago)`; };
const minutes = (from, to) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60000));

export function parseReaderUrl(url) {
  if (typeof url !== "string" || url.length > 2048) return null;
  const [path, query = "", ...more] = url.split("?");
  const match = /^\/read\/([A-Za-z0-9_-]{1,512})\/(brief|report|page|design|arena|question)(?:\/(.+))?$/.exec(path);
  if (more.length || !match) return null;
  const key = Buffer.from(match[1], "base64url").toString("utf8");
  if (b64(key) !== match[1] || /[\x00-\x1f\x7f]/.test(key)) return null;
  const [, , kind, arg = null] = match;
  if ((kind === "brief" || kind === "report") && !RUN.test(arg ?? "") || kind === "question" && !GATE.test(arg ?? "") || ["design", "arena"].includes(kind) && arg !== null) return null;
  if (kind === "page" && !(/^[\w./-]+$/.test(arg ?? "") && /\.md$/.test(arg) && pageType(arg))) return null;
  const params = new URLSearchParams(query), pick = (name, test) => test.test(params.get(name) ?? "") ? params.get(name) : null;
  return { key, kind, arg, theme: pick("theme", /^light$/) ?? "dark", back: pick("back", /^(?:pull-requests|q-G[1-9]\d*)$/) ?? "tasks",
    open: pick("open", /^(?:all|none)$/), view: pick("view", /^compare$/) ?? "today", v: pick("v", NAME), a: pick("a", NAME), b: pick("b", NAME) };
}

export function readerUrl(key, kind, arg, view = {}) {
  const params = new URLSearchParams();
  for (const name of ["theme", "back", "open", "view", "v", "a", "b"]) if (view[name] && !(name === "theme" && view[name] === "dark") && !(name === "back" && view[name] === "tasks") && !(name === "view" && view[name] === "today")) params.set(name, view[name]);
  const query = params.toString();
  return `/read/${b64(key)}/${kind}${arg ? `/${arg}` : ""}${query ? `?${query}` : ""}`;
}

function designVersions(folder) {
  const root = folder && join(folder, "designs");
  return folderNames(root).filter(name => NAME.test(name) && !name.startsWith(".")).slice(0, VERSIONS_MAX).flatMap(name => {
    const dir = join(root, name);
    try { if (!lstatSync(dir).isDirectory()) return []; } catch { return []; }
    const json = readJson(join(dir, "version.json"), 256 * 1024), meta = json && typeof json === "object" && !Array.isArray(json) ? json : {};
    const files = folderNames(dir).filter(file => pageFile(folder, `designs/${name}/${file}`));
    const own = value => typeof value === "string" && files.includes(value) ? value : null;
    const text = value => typeof value === "string" && value.trim() ? value.trim().slice(0, 2000) : null;
    const shots = Array.isArray(meta.screenshots)
      ? meta.screenshots.map(item => typeof item === "string" ? { file: item, caption: null } : { file: item?.file, caption: text(item?.caption) }).filter(item => own(item.file) && PICTURE.test(item.file))
      : files.filter(file => PICTURE.test(file)).map(file => ({ file, caption: null }));
    const final = meta.final && typeof meta.final === "object" ? meta.final : null;
    return [{
      name, title: text(meta.title), about: text(meta.about), at: text(meta.at), run: RUN.test(meta.run ?? "") ? meta.run : null, today: meta.today === true,
      prototype: own(meta.prototype) ?? files.find(file => file === "index.html") ?? files.find(file => file.endsWith(".html")) ?? null,
      notes: own(meta.notes) ?? files.find(file => file.endsWith(".md")) ?? null, shots,
      gates: Array.isArray(meta.gates) ? meta.gates.filter(id => GATE.test(id)) : [],
      candidate: typeof meta.candidate === "string" && /^[A-Za-z0-9]{1,8}$/.test(meta.candidate) ? meta.candidate : null,
      angle: text(meta.angle), strong: text(meta.strong), weak: text(meta.weak),
      final: final && { base: text(final.base), why: text(final.why), grafted: Array.isArray(final.grafted) ? final.grafted.filter(item => typeof item === "string") : [],
        grafts: Array.isArray(final.grafts) ? final.grafts.map(text).filter(Boolean) : [], unused: Array.isArray(final.unused) ? final.unused.map(text).filter(Boolean) : [],
        gate: GATE.test(final.gate ?? "") ? final.gate : null,
        rubric: Array.isArray(final.scores?.rubric) ? final.scores.rubric.map(text).filter(Boolean) : [], max: Number.isInteger(final.scores?.max) ? final.scores.max : 5,
        scores: final.scores?.candidates && typeof final.scores.candidates === "object" ? final.scores.candidates : {} },
    }];
  });
}

const plainVersion = version => !version.candidate && !version.final;
export function designSummary(logbook, taskId) {
  const versions = designVersions(pageTaskFolder(logbook, taskId));
  return { versions: versions.filter(plainVersion).length, arena: versions.some(version => !plainVersion(version)) };
}

export function recordedPages(task, folder) {
  return (task.decisionRows ?? []).flatMap(row => {
    const match = /^page (.+) sha256 ([0-9a-f]{64})$/.exec(String(row.decision ?? "")), at = match ? match[1].lastIndexOf(`/${task.id}/`) : -1;
    const file = at < 0 ? "" : match[1].slice(at + task.id.length + 2);
    if (!pageType(file)) return [];
    const bytes = folder ? pageFile(folder, file, true)?.bytes : null;
    return [{ file, sha: match[2], at: row.at, state: !bytes ? "gone" : createHash("sha256").update(bytes).digest("hex") === match[2] ? "same" : "changed" }];
  });
}

const CSS = `:root{--bg:#09090b;--card:#111114;--card-2:#17171b;--line:#222228;--line-2:#2e2e36;--text:#ededf0;--muted:#a3a3ad;--faint:#8e8e98;--accent:#9aa2ff;--accent-fill:#1c1f3d;--done:#4ade80;--need:#fbbf24;--fail:#fb7f7f;--need-fill:#241d0b;--fail-fill:#2a1414;--focus:#c3c8ff;--font:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;color-scheme:dark}
:root[data-theme=light]{--bg:#fafafa;--card:#fff;--card-2:#f7f7f8;--line:#e4e4e7;--line-2:#d4d4d8;--text:#18181b;--muted:#52525b;--faint:#63636d;--accent:#4f46e5;--accent-fill:#eef0ff;--done:#136c34;--need:#8f5106;--fail:#b91c1c;--need-fill:#fdf3e1;--fail-fill:#fdecec;--focus:#4f46e5;color-scheme:light}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text)}body{font:14px/1.55 var(--font)}a{color:inherit}h1,h2,h3,p{margin:0}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:4px}
.top{display:flex;align-items:center;gap:12px;height:52px;padding:0 24px;border-bottom:1px solid var(--line);font-size:13.5px;color:var(--muted)}.top b{color:var(--text);font-weight:500}.grow{flex:1}
main{max-width:1240px;margin:0 auto;padding:22px 32px 64px}.where{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:22px;color:var(--muted)}.back{color:var(--text);font-weight:500}
.btn{display:inline-block;border:1px solid var(--line-2);border-radius:8px;padding:5px 12px;text-decoration:none;color:var(--text);background:var(--card)}.btn[aria-current]{border-color:var(--accent);background:var(--accent-fill)}
.kind{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);font-weight:600}h1{font-size:26px;font-weight:600;margin:6px 0 14px;overflow-wrap:anywhere}
.facts{display:flex;flex-wrap:wrap;gap:6px 40px;margin:0 0 22px}.facts div{min-width:0}.facts dt{color:var(--muted);font-size:12.5px}.facts dd{margin:2px 0 0;overflow-wrap:anywhere}
.cols{display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:32px}.side h2{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 8px}.side ul{list-style:none;padding:0;margin:0 0 18px}.side li{margin:0 0 6px;overflow-wrap:anywhere}.side p{color:var(--muted);font-size:13px}
.bar{display:flex;gap:16px;justify-content:flex-end;margin-bottom:10px}
details{border:1px solid var(--line);border-radius:12px;background:var(--card);margin:0 0 12px}summary{display:flex;gap:24px;align-items:baseline;padding:14px 18px;cursor:pointer;list-style:none}summary::-webkit-details-marker{display:none}
.fname{font-family:var(--mono);font-size:12.5px;letter-spacing:.06em;font-weight:600;min-width:150px}.first{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}details[open] .first{display:none}
.body{padding:0 18px 16px 192px;overflow-wrap:anywhere}.body>:first-child{margin-top:0}
.result{border:1px solid var(--accent);background:var(--accent-fill);border-radius:12px;padding:16px 20px;margin:0 0 14px}.result .lead{font-size:20px;font-weight:600;margin:4px 0 6px}
.pill{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line-2);border-radius:999px;padding:1px 10px;font-size:12.5px;white-space:nowrap}.pill.done,.pill.base{color:var(--done);border-color:var(--done)}.pill.blocked,.pill.high,.pill.fail{color:var(--fail);border-color:var(--fail)}.pill.question,.pill.medium{color:var(--need);border-color:var(--need)}.pill.grafted,.pill.today{color:var(--accent);border-color:var(--accent)}
.finding{display:grid;grid-template-columns:90px 50px minmax(0,1fr);gap:4px 14px;padding:12px 0;border-top:1px dashed var(--line-2)}.finding:first-child{border-top:0}.finding .det{grid-column:3;font-family:var(--mono);font-size:12.5px;color:var(--muted);white-space:pre-wrap}
.note{border:1px solid var(--line);border-radius:12px;background:var(--card);padding:16px 20px;margin:0 0 14px}.note.fail{border-color:var(--fail);background:var(--fail-fill)}.note.need{border-color:var(--need);background:var(--need-fill)}
.doc{display:grid;grid-template-columns:minmax(0,68ch) 220px;gap:40px}.md{overflow-wrap:anywhere}.md h2{font-size:19px;margin:24px 0 8px}.md h3{font-size:16px;margin:18px 0 6px}.md h4,.md h5,.md h6{font-size:14px;margin:16px 0 6px}.md p,.md ul,.md ol,.md table,.md pre{margin:0 0 12px}
.md table{border-collapse:collapse;display:block;overflow-x:auto}.md th,.md td{border:1px solid var(--line-2);padding:5px 9px;text-align:left}.md pre{background:var(--card-2);border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow-x:auto}.md code{font-family:var(--mono);font-size:12.5px}
.zoom img{max-width:100%;height:auto;border:1px solid var(--line);border-radius:8px;background:var(--card-2)}.note>.sec:first-child{margin-top:0}.off{color:var(--muted);text-decoration:underline dotted}
.zoom:target{position:fixed;inset:0;z-index:9;background:rgba(0,0,0,.86);display:grid;place-items:center;padding:24px}.zoom:target img{max-height:90vh;max-width:96vw;width:auto}.zoom .x{display:none}.zoom:target .x{display:block;position:fixed;top:16px;right:24px;color:#fff;background:#000;padding:6px 12px;border-radius:8px}
.toc{position:sticky;top:16px;align-self:start;font-size:13px}.toc a{display:block;color:var(--muted);text-decoration:none;padding:2px 0}.toc .l2{padding-left:12px}
.switch{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 14px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:20px}.version{border:1px solid var(--line);border-radius:12px;background:var(--card);padding:16px 18px;min-width:0}.version h2{font-size:18px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 6px}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin:12px 0}.shot{margin:0}.shot figcaption{color:var(--muted);font-size:12.5px}
.decision{border-top:1px solid var(--line);padding:10px 0 0;margin-top:10px}.faint{color:var(--faint)}.muted{color:var(--muted)}.mono{font-family:var(--mono);font-size:12.5px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;margin:0 0 24px}.card{border:1px solid var(--line);border-radius:12px;background:var(--card);padding:16px}.card.base{border-color:var(--done)}.card h3{display:flex;justify-content:space-between;align-items:center;margin:0 0 10px}.score{font-size:20px;font-weight:600}
table.scores{border-collapse:collapse;width:100%;margin:0 0 24px}.scores th,.scores td{border-bottom:1px solid var(--line);padding:8px 10px;text-align:left}.scores svg{width:60px;height:6px;margin-right:8px;vertical-align:middle}.scores .t{fill:var(--line-2)}.scores .v{fill:var(--accent)}
h2.sec{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:22px 0 10px}.two{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:0 0 18px}.answer{border:1px solid var(--line);border-radius:12px;background:var(--card);padding:14px 18px;margin:0 0 12px}.answer.pick{border-color:var(--accent)}.answer dl{display:grid;grid-template-columns:170px minmax(0,1fr);gap:4px 16px;margin:8px 0 0}.answer dt{color:var(--muted)}.answer dd{margin:0}h3.sub{font-size:15px;font-weight:600;margin:18px 0 10px}
.skel{border:1px solid var(--line);border-radius:12px;padding:24px;display:grid;gap:18px}.skel i{display:block;height:28px;border-radius:8px;background:var(--line)}.skel i:nth-child(3n){height:120px}.skel:has(~ .ready){display:none}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}@media (prefers-reduced-motion:reduce){*{transition:none!important}}
@media (max-width:720px){main{padding:16px 16px 48px}.top{height:auto;min-height:52px;flex-wrap:wrap;padding:8px 16px}.cols,.doc,.pair,.two,.answer dl{grid-template-columns:minmax(0,1fr)}summary{flex-wrap:wrap;gap:2px 12px}.fname{min-width:0}.body{padding:0 16px 14px}pre.md{overflow-x:auto}}`;
const STYLE_HASH = `'sha256-${createHash("sha256").update(CSS).digest("base64")}'`;

export function readerPolicy(origin, logbook, taskId) {
  const pictures = origin && logbook && taskId ? `${origin}/pages/${logbook}/${taskId}/` : "'none'";
  return `sandbox allow-same-origin; default-src 'none'; script-src 'none'; style-src ${STYLE_HASH}; img-src ${pictures}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

const BACK = { tasks: "#tasks?task=", "pull-requests": "#pull-requests?task=" };

function frame(view, { project, title, crumb, back, file, state }) {
  const flip = { ...view, theme: view.theme === "light" ? "dark" : "light" };
  return `<!doctype html><html lang="en" data-theme="${view.theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc(title)} · sage board</title><style>${CSS}</style></head><body>
<header class="top"><a href="/app/">sage board</a><span aria-hidden="true">/</span><span>${esc(project)}</span><span aria-hidden="true">/</span><b>${esc(crumb)}</b><span class="grow"></span><span>${esc(state)}</span><a class="btn" href="${esc(readerUrl(view.key, view.kind, view.arg, flip))}">Switch to the ${flip.theme} theme</a></header>
<main><nav class="where" aria-label="Where this is"><a class="back" href="${esc(back.href)}">&#8592; ${esc(back.text)}</a><span>${esc(back.where)}</span><span class="grow"></span>${file ?? ""}</nav>
<div class="skel" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>`;
}

const END = "</main></body></html>\n";
const facts = items => `<dl class="facts">${items.filter(Boolean).map(([name, value]) => `<div><dt>${esc(name)}</dt><dd>${value}</dd></div>`).join("")}</dl>`;
const note = (text, kind = "") => `<div class="note ${kind}" role="${kind === "fail" ? "alert" : "note"}">${text}</div>`;

export function readerPage({ model, configured, url, origin, render }) {
  const view = parseReaderUrl(url);
  if (!view) return null;
  const task = model?.tasks.find(item => item.key === view.key), panel = task && taskPanel(model, view.key);
  if (!task || !panel) return null;
  const dir = logbookDir(configured, task), folder = pageTaskFolder(panel.logbook, task.id);
  const pagesBase = `/pages/${panel.logbook}/${task.id}/`;
  const question = view.back.startsWith("q-") ? view.back.slice(2) : null;
  const back = question ? { href: readerUrl(view.key, "question", question, { theme: view.theme }), text: `Back to ${question}`, where: `Overview / Needs you / ${question}` }
    : view.kind === "question" ? { href: "/app/#", text: "Back to Needs you", where: `Overview / Needs you / ${view.arg}` }
    : { href: `/app/${BACK[view.back]}${encodeURIComponent(view.key)}`, text: `Back to ${task.id}`, where: `${task.id} · ${task.title} / Artifacts` };
  const link = (kind, arg, extra = {}) => readerUrl(view.key, kind, arg, { theme: view.theme, back: view.back, ...extra });
  const staleNote = model.stale ? note(`<b>The board cannot read the logbook now.</b> This is the copy that it read at ${esc(when(model.at, model.at))}.`, "fail") : "";
  const state = model.stale ? `Not updated since ${when(model.at, model.at)}` : `Read ${when(model.at, model.at)} · reload to read again`;
  const run = RUN.test(view.arg ?? "") ? task.runs.find(item => item.id === view.arg) : null;
  const chief = item => item?.chief ? `${esc(item.chief)}${item.provider ? ` · ${esc(item.provider)}` : ""}` : panel.chief ? esc([panel.chief.id, panel.chief.provider].filter(Boolean).join(" · ")) : "not recorded";
  const taskHref = `/app/${BACK[view.back] ?? BACK.tasks}${encodeURIComponent(view.key)}`, taskA = (label = task.id) => `<a href="${esc(taskHref)}">${esc(label)}</a>`, taskLink = taskA();
  const picture = (file, alt, n) => `<span class="zoom" id="p${n}"><a href="#p${n}" aria-label="Enlarge the picture ${esc(alt || file)}"><img src="${esc(pagesBase + file)}" alt="${esc(alt)}" loading="lazy"></a><a class="x" href="#_">Close the picture</a></span>`;
  let pictures = 0;
  const markdown = (text, base = "") => { const out = render(text, {
    href: raw => {
      let url;
      try { url = decodeURIComponent(raw); } catch { return null; }
      if (/^https:\/\//i.test(raw)) return /[\s\x00-\x1f"<>\\]/.test(url) ? null : raw;
      if (/[\\\x00-\x1f]/.test(url)) return null;
      const [pathPart, fragment] = url.split("#"), path = pathPart.split("?")[0];
      if (!path) return fragment ? `#h-${fragment.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-")}` : null;
      const target = posix.normalize(posix.join(base, path));
      if (target.startsWith("..") || target.startsWith("/") || !pageType(target)) return null;
      return target.endsWith(".md") ? link("page", target) : pagesBase + target;
    },
    picture: (raw, alt) => {
      let path;
      try { path = decodeURIComponent(String(raw)).split(/[?#]/)[0]; } catch { return null; }
      const target = posix.normalize(posix.join(base, path));
      if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(path) || target.startsWith("..") || target.startsWith("/") || !PICTURE.test(target) || !folder || !pageFile(folder, target)) return null;
      return picture(target, alt, ++pictures);
    },
  }); return { ...out, html: marksShown(out.html) }; };
  const field = (name, body, open, more = "") => `<details${open ? " open" : ""}><summary><span class="fname">${esc(name)}</span><span class="first">${esc(firstLine(body).replace(/^(?:[-*+]|\d+[.)])\s+/, ""))}${more}</span></summary><div class="body md">${body ? markdown(body).html : `<p class="muted">This field is empty.</p>`}</div></details>`;
  const openBar = `<div class="bar"><a href="${esc(link(view.kind, view.arg, { open: "all" }))}">Open all</a><a href="${esc(link(view.kind, view.arg, { open: "none" }))}">Close all</a></div>`;
  const isOpen = (name, first) => view.open === "all" || view.open !== "none" && first.includes(name);
  const runMissing = () => ({ crumb: view.arg, title: `${view.kind === "brief" ? "Brief" : "Report"} of ${view.arg}`, body: note(`The logbook has no run ${esc(view.arg)} of ${esc(task.id)}.`, "fail") });

  const pages = {
    brief() {
      if (!run) return runMissing();
      const codex = /^[a-z-]+$/.test(run.role) ? `sage_${run.role.replaceAll("-", "_")}_${task.id.toLowerCase()}_${run.id.toLowerCase()}.json` : null;
      let text, problem, from = `${run.id}.md`;
      try {
        text = dir ? readText(join(dir, "briefs", from)) : undefined;
        const kept = text === undefined && dir && codex ? readText(join(dir, "briefs", codex)) : undefined;
        if (kept !== undefined) { text = JSON.parse(kept)?.text; from = codex; if (typeof text !== "string") throw unread("The file has no brief text."); }
      } catch (error) { problem = whyUnread(error); }
      const head = [["Run", esc(run.id)], ["Role", esc(run.role)], ["Task", taskLink], ["Chief", chief(run)], ["Model", esc(run.model || "not recorded")], ["Started", esc(when(run.started, model.at))]];
      const side = `<aside class="side"><h2>This run</h2><ul><li><a href="${esc(link("report", run.id))}">Report of ${esc(run.id)}</a></li><li>${taskA(`Task ${task.id}`)}</li></ul><p>GOAL and ACCEPTANCE open first: what the agent must do, and how the chief checks it. A closed field shows its first line.</p></aside>`;
      if (problem) return { crumb: run.id, title: `Brief of ${run.id}`, head, body: note(`<b>The board cannot read this brief.</b> ${esc(problem)}`, "fail") };
      if (text === undefined) return { crumb: run.id, title: `Brief of ${run.id}`, head, body: note(`<b>Not kept.</b> The logbook keeps no brief of ${esc(run.id)}. sage keeps briefs only for newer runs; this run is older, or its brief was not kept.`) };
      const sections = briefSections(text);
      const body = `${openBar}${BRIEF_FIELDS.map(name => {
        const value = dedent(sections[name]), count = value.split(/\r?\n/).filter(line => line.trim()).length;
        return field(name, value, isOpen(name, ["GOAL", "ACCEPTANCE"]), count > 1 ? ` <span class="faint">(+${count - 1})</span>` : "");
      }).join("")}`;
      return { crumb: run.id, title: `Brief of ${run.id} · ${run.role}`, head, body, side, file: `<span class="faint mono">briefs/${esc(from)} in the logbook</span>` };
    },
    report() {
      if (!run) return runMissing();
      let text, from, problem;
      try {
        text = dir ? readText(join(dir, "reports", `${run.id}.md`)) : undefined; from = `reports/${run.id}.md in the logbook`;
        if (text === undefined && folder && pageFile(folder, `${run.id}-report.md`)) { text = pageFile(folder, `${run.id}-report.md`, true).bytes.toString("utf8"); from = `<a href="${esc(pagesBase)}${esc(run.id)}-report.md">Open the file</a>`; }
        if (text === undefined && dir) { const kept = readJson(join(dir, "kept", `${run.id}.json`)); if (kept?.task === task.id && kept.run === run.id && typeof kept.text === "string") { text = kept.text; from = `kept/${run.id}.json in the logbook (a review's kept report)`; } }
      } catch (error) { problem = whyUnread(error); }
      const ran = run.ended ? `${when(run.started, model.at)}–${when(run.ended, model.at)}` : `${when(run.started, model.at)}–`;
      const fields = text === undefined ? [] : fieldsOf(text, REPORT_FIELDS), of = name => { const item = fields.find(entry => entry.name === name); return item ? dedent([item.rest, ...item.lines].join("\n")) : ""; };
      const status = /^(done|blocked|question)\b/i.exec(of("STATUS"))?.[1].toLowerCase() ?? null;
      const head = [["Status", status ? `<span class="pill ${status}">${status}</span>` : run.status === "running" ? `<span class="pill">running</span>` : "not given"], ["Run", esc(run.id)], ["Role", esc(run.role)], ["Chief", chief(run)], ["Model", esc(run.model || "not recorded")], ["Ran", esc(ran)]];
      const side = `<aside class="side"><h2>Links</h2><ul>${panel.prUrl ? `<li><a href="${esc(panel.prUrl)}">PR #${esc(panel.pr)}</a></li>` : ""}<li><a href="${esc(link("brief", run.id))}">Brief of ${esc(run.id)}</a></li><li>${taskA(`Task ${task.id}`)}</li></ul></aside>`;
      if (problem) return { crumb: run.id, title: `Report of ${run.id}`, head, body: note(`<b>The board cannot read this report.</b> ${esc(problem)}`, "fail") };
      if (text === undefined) return run.status === "running"
        ? { crumb: run.id, title: `Report of ${run.id}`, head, body: note(`<b>Not written yet.</b> ${esc(run.role)} ${esc(run.id)} runs (${minutes(run.started, model.at)} min). The board shows the report when the run ends; reload this page then.`, "need") }
        : { crumb: run.id, title: `Report of ${run.id}`, head, body: note(`<b>Not kept.</b> The logbook keeps no report of ${esc(run.id)}. sage keeps reports only for newer runs and for reviews; this run is older, or its report was not kept.`) };
      const result = of("RESULT"), findings = readReport(text).findings;
      const runRows = (task.findings ?? []).filter(entry => entry.run === run.id || String(entry.key).startsWith(`${run.id}-`));
      const stateOf = row => row.movedTo ? `moved to ${row.movedTo}` : row.status || row.triage || "";
      const lead = firstLine(result);
      const findingRows = findings.map(item => `<div class="finding"><span><span class="pill ${item.severity}">${item.severity}</span></span><span class="mono">${esc(item.key)}</span><span>${esc(item.summary)}</span>${item.details.length ? `<span class="det">${esc(item.details.join("\n"))}</span>` : ""}</div>`).join("");
      const body = `<section class="result" aria-label="RESULT"><span class="fname">RESULT</span><p class="lead">${esc(lead || "No RESULT")}</p><div class="md">${markdown(result.split(/\r?\n/).slice(1).join("\n")).html}</div></section>${openBar}${
        findings.length ? `<details${view.open !== "none" ? " open" : ""}><summary><span class="fname">FINDINGS</span><span class="first">${findings.length} ${findings.length === 1 ? "finding" : "findings"}</span></summary><div class="body">${findingRows}</div></details>` : field("FINDINGS", of("FINDINGS"), view.open !== "none")}<h2 class="sec">In the logbook</h2>${runRows.length
          ? `<p class="muted">The logbook's own record of these findings, with their states:</p><table class="scores"><thead><tr><th scope="col">Finding</th><th scope="col">Severity</th><th scope="col">Summary</th><th scope="col">State</th></tr></thead><tbody>${runRows.map(row => `<tr><td class="mono">${esc(row.key)}</td><td>${esc(row.severity || "not recorded")}</td><td>${esc(row.summary || "not recorded")}</td><td>${esc(stateOf(row) || "not recorded")}</td></tr>`).join("")}</tbody></table>`
          : `<p class="muted">The logbook has no finding of ${esc(run.id)}.</p>`}${
        ["QUESTIONS", "EVIDENCE", "NOT VERIFIED", "BRANCH"].map(name => field(name, of(name), isOpen(name, /^none\.?$/i.test(of("QUESTIONS")) ? ["NOT VERIFIED", "BRANCH"] : ["QUESTIONS", "NOT VERIFIED", "BRANCH"]))).join("")}`;
      return { crumb: run.id, title: `Report of ${run.id} · ${run.role}`, head, body, side, file: from.startsWith("<a") ? from.replace(">Open", ' class="btn">Open') : `<span class="faint mono">${esc(from)}</span>` };
    },
    page() {
      const file = view.arg, recorded = recordedPages(task, folder).filter(item => item.file === file).at(-1);
      const head = [["Task", taskLink], ["File", `<span class="mono">${esc(file)}</span>`], recorded && ["Recorded", esc(`${when(recorded.at, model.at)} · ${recorded.state === "same" ? "the same as recorded" : recorded.state === "changed" ? "changed since it was recorded" : "gone"}`)]];
      const got = folder ? pageFile(folder, file, true) : null;
      const why = !got && folder ? notOpened(join(folder, file)) : null;
      if (why) return { crumb: file, title: file, head, body: note(`<b>The board does not open this page.</b> ${esc(why)}`, "need") };
      if (!got) return { crumb: file, title: file, head, body: note(recorded
        ? `<b>The file is gone from the pages folder.</b> The logbook still has its record: <span class="mono">${esc(file)}</span>, sha256 <span class="mono">${esc(recorded.sha.slice(0, 16))}…</span>, recorded ${esc(when(recorded.at, model.at))}.`
        : `<b>This page is not in the task's pages folder.</b> It may be gone, or not written yet. The logbook has no record of it.`, "need") };
      if (got.size > MD_MAX) return { crumb: file, title: file, head, body: note("This Markdown page is over 2 MiB, so the reader does not show it. Open the file instead."), file: `<a class="btn" href="${esc(pagesBase + file)}">Open the file</a>` };
      const { html, headings, title } = markdown(got.bytes.toString("utf8"), posix.dirname(file) === "." ? "" : posix.dirname(file));
      const top = Math.min(...headings.map(item => item.level)), toc = headings.length > 1 ? `<nav class="toc" aria-label="Contents"><h2 class="sec">Contents</h2>${headings.filter(item => item.level <= top + 1).map(item => `<a class="l${item.level - top + 1}" href="#${esc(item.id)}">${esc(item.text)}</a>`).join("")}</nav>` : "<span></span>";
      return { crumb: file, title: title ?? file, head, body: `<div class="doc"><article class="md">${html}</article>${toc}</div>`, file: `<a class="btn" href="${esc(pagesBase + file)}">Open the file</a>` };
    },
    design() {
      const versions = designVersions(folder).filter(plainVersion), designer = task.runs.find(item => item.role === "designer" && item.status === "running");
      const head = [["Task", taskLink], ["Versions", versions.length ? esc(`${versions[0].name} to ${versions.at(-1).name}`) : "none"]];
      if (!versions.length) return { crumb: "Design", title: `Design of ${task.id}`, head, body: note(designer
        ? `<b>Not written yet.</b> designer ${esc(designer.id)} runs (${minutes(designer.started, model.at)} min). The board shows the design when the run saves it in designs/&lt;version&gt;/; reload this page then.`
        : `<b>No design versions.</b> This task's pages folder has no designs/&lt;version&gt;/ folder.`, designer ? "need" : "") };
      const today = versions.filter(item => item.today).at(-1) ?? versions.at(-1), byName = name => versions.find(item => item.name === name);
      const gates = task.gateRows ?? [];
      const card = (version, side) => {
        const decisions = version.gates.map(id => gates.find(gate => gate.id === id)).filter(Boolean);
        return `<section class="version" aria-label="${esc(version.name)}"><h2>${esc(version.title ?? version.name)} <span class="faint">· ${esc(version.at ? when(version.at, model.at) : "date not recorded")}</span>${version === today ? ` <span class="pill today">Today</span>` : ""}${version.run ? ` <span class="faint mono">designer ${esc(version.run)}</span>` : ""}</h2>
${version.about ? `<p>${esc(version.about)}</p>` : ""}<p class="switch">${version.prototype ? `<a class="btn" href="${esc(`${pagesBase}designs/${version.name}/${version.prototype}`)}">Open the prototype</a>` : `<span class="muted">No prototype in this version.</span>`}${version.notes ? ` <a href="${esc(link("page", `designs/${version.name}/${version.notes}`))}">Read the design notes</a>` : ""}</p>
${version.shots.length ? `<div class="gallery">${version.shots.slice(0, SHOTS_MAX).map((shot, i) => `<figure class="shot">${picture(`designs/${version.name}/${shot.file}`, shot.caption ?? shot.file, `${side}${i}`)}${shot.caption ? `<figcaption>${esc(shot.caption)}</figcaption>` : ""}</figure>`).join("")}</div>${version.shots.length > SHOTS_MAX ? `<p class="muted">${version.shots.length - SHOTS_MAX} more pictures are in the pages folder.</p>` : ""}` : `<p class="muted">No screenshots in this version.</p>`}
${decisions.length ? decisions.map(gate => `<div class="decision"><p><b>${esc(gate.id)}</b> · ${esc(firstLine(gate.question))}</p><p>${gate.answer ? `You answered: <b>${esc(gate.answer)}</b>` : "Open: no answer yet."}${String(gate.options ?? "").split("|").filter(option => option.trim() && option.trim() !== gate.answer).length ? ` <span class="muted">· the other options: ${esc(String(gate.options).split("|").map(option => option.trim()).filter(option => option && option !== gate.answer).join(", "))}</span>` : ""} <span class="faint">· ${esc(when(gate.at, model.at))}</span></p></div>`).join("") : `<p class="faint">No decision of yours is recorded on this version.</p>`}</section>`;
      };
      const chips = (current, name, extra) => `<div class="switch" role="group" aria-label="${esc(name)}">${versions.map(version => `<a class="btn" href="${esc(link("design", null, extra(version.name)))}"${version === current ? ` aria-current="true"` : ""}>${esc(version.name)}${version === today ? " · today" : ""}</a>`).join("")}</div>`;
      const mode = `<div class="switch" role="group" aria-label="View"><a class="btn" href="${esc(link("design", null, {}))}"${view.view === "today" ? ` aria-current="true"` : ""}>Today</a><a class="btn" href="${esc(link("design", null, { view: "compare" }))}"${view.view === "compare" ? ` aria-current="true"` : ""}>Compare two</a><span class="muted">${plural(versions.length, "version")} · ${plural(new Set(versions.flatMap(version => version.gates)).size, "decision")} by you</span></div>`;
      let body;
      if (view.view === "compare") {
        const right = byName(view.b) ?? today, left = byName(view.a) ?? versions[Math.max(0, versions.indexOf(today) - 1)];
        body = `${mode}<div class="pair"><div>${chips(left, "Left version", name => ({ view: "compare", a: name, b: right.name }))}${card(left, "a")}</div><div>${chips(right, "Right version", name => ({ view: "compare", a: left.name, b: name }))}${card(right, "b")}</div></div>`;
      } else {
        const shown = byName(view.v) ?? today;
        body = `${mode}${chips(shown, "Version", name => ({ v: name }))}${card(shown, "v")}`;
      }
      return { crumb: "Design", title: `Design of ${task.id} · ${task.title}`, head: [...head, ["Today", esc(today.name)]], body, file: `<a class="btn" href="${esc(pagesBase)}">Open the pages index</a>` };
    },
    arena() {
      const versions = designVersions(folder), candidates = versions.filter(item => item.candidate), final = versions.find(item => item.final);
      const judge = task.runs.filter(item => item.role === "arena-judge").at(-1);
      const head = [["Task", taskLink], ["Judge", judge ? esc(`arena-judge ${judge.id}`) : "not recorded"], ["Chief", chief(judge)], ["Judged", esc(final?.at ? when(final.at, model.at) : "not recorded")]];
      if (!candidates.length && !final) return { crumb: "Arena", title: `Arena of ${task.id}`, head, body: note(judge?.status === "running"
        ? `<b>Not written yet.</b> arena-judge ${esc(judge.id)} runs (${minutes(judge.started, model.at)} min). The board shows the arena when the judge saves designs/&lt;version&gt;/version.json; reload this page then.`
        : "<b>No arena recorded.</b> No designs/&lt;version&gt;/version.json in this task's pages folder names a candidate or a judge's final.", judge?.status === "running" ? "need" : "") };
      const f = final?.final, total = name => (Array.isArray(f?.scores?.[name]) ? f.scores[name] : []).reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0), best = (f?.rubric.length ?? 0) * (f?.max ?? 5);
      const use = name => f?.base === name ? ["base", "Base"] : f?.grafted.includes(name) ? ["grafted", "Grafted"] : f ? ["", "Not used"] : ["", "Not judged yet"];
      const shot = (version, id) => version.shots[0] ? picture(`designs/${version.name}/${version.shots[0].file}`, version.shots[0].caption ?? version.name, id) : `<p class="muted">No picture.</p>`;
      const cards = `<h2 class="sec">Candidates</h2><div class="cards">${candidates.map((version, i) => {
        const [kind, word] = use(version.candidate);
        return `<section class="card ${kind}"><h3><span>${esc(version.candidate)} <span class="faint mono">${esc(version.run ?? "")}</span></span><span class="pill ${kind}">${word}</span></h3>${shot(version, `c${i}`)}<p><b>${esc(version.angle ?? version.title ?? version.name)}</b></p>${best ? `<p><span class="score">${total(version.candidate)}</span> of ${best}</p>` : ""}${version.strong ? `<p><span class="muted">Strong</span> ${esc(version.strong)}</p>` : ""}${version.weak ? `<p><span class="muted">Weak</span> ${esc(version.weak)}</p>` : ""}${version.prototype ? `<p><a href="${esc(`${pagesBase}designs/${version.name}/${version.prototype}`)}">Open its prototype</a></p>` : ""}</section>`;
      }).join("") || `<p class="muted">No candidate is recorded.</p>`}</div>`;
      const bar = (n, max) => `<svg aria-hidden="true" viewBox="0 0 60 6"><rect class="t" width="60" height="6" rx="3"/><rect class="v" width="${Math.max(0, Math.min(60, Math.round(60 * n / max)))}" height="6" rx="3"/></svg>`;
      const scores = f?.rubric.length && candidates.length ? `<h2 class="sec">The judge's scores</h2><table class="scores"><thead><tr><th scope="col">Rubric</th>${candidates.map(version => `<th scope="col">${esc(version.candidate)} ${esc(version.run ?? "")}</th>`).join("")}</tr></thead><tbody>${f.rubric.map((line, row) => `<tr><th scope="row">${esc(line)}</th>${candidates.map(version => { const n = f.scores[version.candidate]?.[row]; return `<td>${Number.isFinite(n) ? `${bar(n, f.max)}${n} of ${f.max}` : "not scored"}</td>`; }).join("")}</tr>`).join("")}<tr><th scope="row">Total</th>${candidates.map(version => `<td><b>${total(version.candidate)}</b> of ${best}</td>`).join("")}</tr></tbody></table>` : "";
      const gate = f?.gate && (task.gateRows ?? []).find(row => row.id === f.gate);
      const judged = final ? `<h2 class="sec">The judge's final</h2><div class="version"><div class="pair"><div>${shot(final, "f")}</div><div>${f.base ? `<p><b>Base: candidate ${esc(f.base)}.</b> ${esc(f.why ?? "")}</p>` : ""}${f.grafts.length ? `<h2 class="sec">Grafted in</h2><ul>${f.grafts.map(item => `<li>${esc(item)}</li>`).join("")}</ul>` : ""}${f.unused.length ? `<h2 class="sec">Not used</h2><ul>${f.unused.map(item => `<li>${esc(item)}</li>`).join("")}</ul>` : ""}${gate ? note(gate.answer ? `You answered ${esc(gate.id)}: <b>${esc(gate.answer)}</b>, at ${esc(when(gate.at, model.at))}.` : `${esc(gate.id)} waits for your answer: ${esc(firstLine(gate.question))}`, gate.answer ? "" : "need") : ""}${final.prototype ? `<p><a href="${esc(`${pagesBase}designs/${final.name}/${final.prototype}`)}">Open the final prototype</a></p>` : ""}</div></div></div>` : note("The judge's final is not saved yet.");
      return { crumb: "Arena", title: `Arena of ${task.id}: ${candidates.length} ${candidates.length === 1 ? "candidate" : "candidates"}${final ? " and the final" : ""}`, head, body: `${cards}${scores}${judged}`, file: `<a class="btn" href="${esc(pagesBase)}">Open the pages index</a>` };
    },
    question() {
      const gate = (task.gateRows ?? []).find(row => row.id === view.arg);
      if (!gate) return { crumb: view.arg, title: view.arg, body: note(`The logbook has no question ${esc(view.arg)} on ${esc(task.id)}. It may have moved to another task.`, "fail") };
      const kept = dir ? readJson(join(dir, "gates", `${gate.id}.json`)) : undefined, message = kept?.message?.kind === "question" && Array.isArray(kept.message.blocks) ? kept.message : null;
      const options = String(gate.options ?? "").split("|").map(option => option.trim()).filter(Boolean), owner = panel.chief ? [panel.chief.id, panel.chief.provider].filter(Boolean).join(" · ") : "The chief";
      const ownerId = panel.chief?.id ?? "The chief";
      const blocks = [], labelled = {}, pagesOf = [], answers = [];
      const walk = (list, label = null) => (list ?? []).forEach(block => {
        if (block?.t === "section" && Array.isArray(block.body)) { const at = blocks.push({ t: "heading", text: block.label }); walk(block.body, block.label); if (blocks.length === at) blocks.pop(); }
        else if (block?.t === "table" && Array.isArray(block.head) && /^answer$/i.test(String(block.head[0]).trim())) answers.push({ table: block, label });
        else if (block?.t === "page") pagesOf.push(block);
        else if (block?.t === "field" && ["Needed by", "If you do not answer"].includes(block.label)) labelled[block.label] = block.text;
        else if (block) blocks.push(block);
      });
      walk(message?.blocks);
      const text = value => esc(typeof value === "string" ? value : "");
      const width = message?.long !== undefined ? LONG_WIDTH : WIDTH, muted = value => text(value) && `<p class="muted">${text(value)}</p>`;
      const pre = (title, lines) => `${title ? `<p><b>${text(title)}</b></p>` : ""}<pre class="md">${esc(lines.join("\n"))}</pre>`;
      const grid = (head, rows, caption) => `<table class="scores">${caption ? `<caption>${text(caption)}</caption>` : ""}<thead><tr>${head.map(cell => `<th scope="col">${text(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${(Array.isArray(row) ? row : []).map(cell => `<td>${text(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
      const linesOf = block => { if (block.frame === undefined) return block.lines; const drawn = frameLines(block.frame, width); return drawn.problems.length ? null : drawn.lines; };
      const messagePage = /\b(question-[0-9a-f]{8}\.html)\b/.exec(typeof kept?.text === "string" ? kept.text : "")?.[1], shownPage = messagePage && folder && pageFile(folder, messagePage) ? pagesBase + messagePage : null;
      const render = block => (block.t === "field" ? `<h2 class="sec">${text(block.label)}</h2><p>${text(block.text)}</p>` : block.t === "heading" ? `<h2 class="sec">${text(block.text)}</h2>` : block.t === "p" ? `<p>${text(block.text)}</p>`
        : block.t === "list" && Array.isArray(block.items) ? `<${block.ordered ? "ol" : "ul"}>${block.items.map(item => `<li>${text(item)}</li>`).join("")}</${block.ordered ? "ol" : "ul"}>`
        : block.t === "steps" && Array.isArray(block.items) ? `<ol>${block.items.map(item => `<li>${text(item?.text)}${Array.isArray(item?.cmd) ? `<pre class="md">${esc(item.cmd.join("\n"))}</pre>` : ""}${muted(item?.see)}</li>`).join("")}</ol>`
        : ["code", "picture"].includes(block.t) ? (lines => Array.isArray(lines) ? `${pre(block.title, lines)}${muted(block.key)}` : "")(linesOf(block))
        : block.t === "toggle" && Array.isArray(block.after) && Array.isArray(block.today) ? [["After this change", block.after], ["Today", block.today]].map(([label, side]) => `<h3 class="sub">${label}</h3>${side.map(item => pre(item?.title, Array.isArray(item?.lines) ? item.lines : [])).join("")}`).join("")
        : block.t === "changes" && Array.isArray(block.rows) ? grid(["Where you see it", "Today", "After this change", "Why"], block.rows.map(row => [row?.where, row?.today, row?.after, row?.why]))
        : block.t === "table" && Array.isArray(block.head) && Array.isArray(block.rows) ? grid(block.head, block.rows, block.caption) : "")
        || note(`<b>Not shown here.</b> This page cannot show one part of the question (${text(block.t)}). ${shownPage ? `<a href="${esc(shownPage)}">Open the question's message page</a>` : "Read it in the chief's chat."}`, "need");
      const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase() || String(a).trim().toLowerCase().replace(/^[a-z0-9]\s*[·:.)-]\s*/, "") === String(b).trim().toLowerCase();
      const groups = answers.length ? answers : [{ table: null, label: null }];
      const answerCards = groups.map(({ table, label }) => {
        const rows = table ? table.rows.filter(Array.isArray) : options.map(option => [option]);
        const pickIndex = table && Number.isInteger(table.pick) && rows[table.pick] ? table.pick : rows.findIndex(row => gate.recommendation && same(row[0], gate.recommendation));
        const ordered = pickIndex >= 0 ? [rows[pickIndex], ...rows.filter((_, i) => i !== pickIndex)] : rows;
        return `${groups.length > 1 && label ? `<h3 class="sub">${text(label)}</h3>` : ""}${muted(table?.caption)}${ordered.map((row, i) => `<section class="answer${i === 0 && pickIndex >= 0 ? " pick" : ""}"><h3>${text(String(row[0]))}${i === 0 && pickIndex >= 0 ? ` <span class="pill grafted">${esc(ownerId)}'s pick</span>` : ""}${gate.answer && same(row[0], gate.answer) ? ` <span class="pill done">Your answer</span>` : ""}</h3>${row.length > 1 ? `<dl>${row.slice(1).map((cell, k) => `<dt>${text(table.head[k + 1])}</dt><dd>${text(cell)}</dd>`).join("")}</dl>` : ""}</section>`).join("")}`;
      }).join("");
      const readMore = [`<li>${taskA(`Task ${task.id}`)} · ${esc(task.title)}</li>`, ...pagesOf.filter(block => typeof block.file === "string").map(block => {
        const where = block.task === task.id && pageType(block.file) ? (block.file.endsWith(".md") ? link("page", block.file, { back: `q-${gate.id}` }) : pagesBase + block.file) : null;
        return `<li>${where ? `<a href="${esc(where)}">${text(block.title)}</a>` : `${text(block.title)} <span class="faint">(in ${text(block.task)}'s pages folder)</span>`}</li>`;
      })];
      const summary = designSummary(panel.logbook, task.id);
      if (summary.versions) readMore.push(`<li><a href="${esc(link("design", null, { back: `q-${gate.id}` }))}">Design · ${summary.versions} ${summary.versions === 1 ? "version" : "versions"}</a></li>`);
      const status = gate.answer ? note(`<b>Answered: ${esc(gate.answer)}.</b> The first answer wins; to change it, tell the chief in its chat.`) : "";
      const head = `<p class="muted">${esc(owner)} · <span class="mono">${esc(gate.id)}</span> · asked ${esc(when(gate.at, model.at) + ago(gate.at, model.at))} · ${taskLink} · ${esc(task.title)}</p>`;
      const body = `${status}${message ? "" : note(`<b>Not kept.</b> The logbook keeps no full message of ${esc(gate.id)} (sage keeps the full message only for newer questions that the chief asks with a message). The board shows its question and options only.`)}
<div class="two"><div class="note"><h2 class="sec">Needed by</h2><p>${text(labelled["Needed by"] ?? "not recorded")}</p></div><div class="note"><h2 class="sec">If you do not answer</h2><p>${text(labelled["If you do not answer"] ?? (gate.default ? `The chief takes ${gate.default}.` : "not recorded"))}</p></div></div>
${blocks.map(render).join("")}<h2 class="sec">The answers</h2>${answerCards}<h2 class="sec">Read more</h2><ul>${readMore.join("")}</ul>${gate.answer ? "" : note(`This page only reads. Answer in ${esc(ownerId)}'s chat.`)}`;
      return { crumb: gate.id, title: message?.title ?? firstLine(gate.question), head, body, raw: true };
    },
  };

  const page = pages[view.kind]();
  const policy = readerPolicy(origin, panel.logbook, task.id);
  const top = frame(view, { project: task.projectName, title: page.title, crumb: view.kind === "question" ? "Overview" : "Tasks", back, file: page.file, state });
  const kind = { brief: "Brief", report: "Report", page: "Markdown page", design: "Design", arena: "Arena", question: "Question" }[view.kind];
  const rest = `<div class="ready">${staleNote}<p class="kind">${kind}</p><h1>${esc(page.title)}</h1>${page.raw ? page.head : page.head ? facts(page.head) : ""}${page.side ? `<div class="cols"><div>${page.body}</div>${page.side}</div>` : page.body}</div>${END}`;
  return { policy, top, rest };
}
