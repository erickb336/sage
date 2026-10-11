// Render only the shared model. Agent text never becomes HTML markup: it goes through esc(), and links through safeUrl().
// The look is the T218 design (approved 2026-10-11). The page needs no script for its cards, task pages, backlog fold and theme.
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const md = value => String(value ?? "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/[\`*_{}\[\]()<>#+.!|&]/g, c => String.fromCharCode(92) + c);
const mdBlock = value => String(value ?? "").split(/\r?\n/).map(md).join("\n");
const evidenceArtifacts = task => task.artifacts.filter(record => ["report", "proof"].includes(record.data.type) && record.content?.verified && typeof record.content.text === "string");
const mark = status => ({ done: "✓", failed: "✗", running: "…", pending: "○", unknown: "?" }[status] ?? "?");
const route = task => `/task/${Buffer.from(task.key).toString("base64url")}`;
const anchor = task => `task-${Buffer.from(task.key).toString("base64url")}`;
function safeUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
function prUrl(task) {
  const repository = safeUrl(task.repository);
  return repository && /^[1-9]\d*$/.test(task.pr) ? `${repository.replace(/\/$/, "")}/pull/${task.pr}` : null;
}
function link(label, value) { const url = safeUrl(value); return url ? `<a href="${esc(url)}" rel="noopener noreferrer">${esc(label)}</a>` : esc(label); }

const ICON = '<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor" opacity=".18"/><rect x="7.2" y="3.6" width="1.6" height="5.6" rx=".8" fill="currentColor"/><circle cx="8" cy="11.6" r="1" fill="currentColor"/></svg>';
const SHORT = { checks: "checks", "code-review": "code", "security-review": "sec", "ux-review": "ux", qa: "qa", "evidence-review": "evidence" };
const LOOP = { done: "done", current: "now", "needs-owner": "need", skipped: "skip", pending: "" };
const COLUMN_NAME = { done: "Done, last 7 days" };
const BACKLOG_SHOWN = 6, RUNS_SHOWN = 6;
const hhmm = iso => String(iso ?? "").slice(11, 16);
const day = iso => iso ? `${String(iso).slice(0, 10)} ${hhmm(iso)}` : "";
const title = value => String(value ?? "").charAt(0).toUpperCase() + String(value ?? "").slice(1);
const standIn = (value, note) => `<span class="standin" title="${esc(note)}">${esc(value)}</span>`;
// N1: runs do not record their provider yet; the logbook's source stands in for it, marked with a dotted underline.
const provider = (name, task) => name ? esc(name) : standIn(title(task.providerStandIn), "Stand-in: the logbook's source. The run does not record its provider.");
function duration(seconds) {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds} s`;
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}
function runTime(run) {
  const start = Date.parse(run.started), end = Date.parse(run.ended);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? `${Math.floor((end - start) / 1000)} s · ${run.started} to ${run.ended}` : run.started ? `${run.started} · duration unknown` : "time unknown";
}
const tokens = value => /^\d+$/.test(String(value)) ? Number(value) >= 1000 ? `${Math.round(Number(value) / 1000)}k` : String(value) : "—";

/** The page's view of the model: project colour slots (8, by sorted key) and the source of each alternate agent colour. */
function context(model, snapshot) {
  const keys = [...new Set(model.tasks.map(task => task.project))].sort();
  return { snapshot, slot: new Map(keys.map((key, i) => [key, `p${i % 8}`])), sources: model.sources.map(source => source.id), at: model.at };
}
const dot = (ctx, key) => `<span class="dot ${ctx.slot.get(key) ?? "p0"}" aria-hidden="true"></span>`;
const project = (ctx, task) => `<span class="proj">${dot(ctx, task.project)}${esc(task.projectName)}</span>`;
const tags = task => `<span class="tag">${esc(task.size)}</span>${task.risk ? `<span class="tag risk">risk: ${esc(task.risk.replace(/,/g, ", "))}</span>` : ""}`;
const flag = reason => `<div class="flag" role="note">${ICON}<span>${esc(reason.text)}${reason.recommendation ? ` I recommend: ${esc(reason.recommendation)}` : ""}</span></div>`;
const agentPill = (ctx, task, agent) => `<span class="agent${ctx.sources.indexOf(task.source) % 2 ? " alt" : ""}"><span class="live" aria-hidden="true"></span><span class="prov">${provider(agent.provider, task)} ·</span> ${esc(agent.role)}</span>`;
const agents = (ctx, task, extra = "") => task.agents.length ? `<div class="agents${extra}">${task.agents.map(agent => agentPill(ctx, task, agent)).join("")}</div>` : "";

/** A card shows the current cycle; the task page shows every cycle. With no known head, a card shows no "?" chips. */
function cycleRows(task, all = false) {
  if (!task.cycles.length) return "";
  const current = task.cycles.find(cycle => cycle.steps.some(step => step.status !== "done")) ?? task.cycles.at(-1);
  if (!task.currentHead && !all) return task.pr ? `<div class="cycle">cycle ${current.number} of ${task.requiredCycles} <span class="faint">· PR head not recorded</span></div>` : "";
  return (all ? task.cycles : [current]).map(cycle => `<div class="cycle">cycle ${cycle.number} of ${task.requiredCycles}<span class="steps">${cycle.steps.map(step => `<span class="step ${esc(step.status)}">${esc(SHORT[step.role] ?? step.role)} ${mark(step.status)}</span>`).join("")}</span></div>`).join("");
}

function card(ctx, task) {
  const done = task.column === "done";
  return `<a class="card${task.reasons.length ? " needs" : ""}" href="${esc(ctx.snapshot ? `#${anchor(task)}` : route(task))}" data-project="${esc(task.project)}" data-needs="${!!task.reasons.length}" data-agents="${task.agents.length}" data-inferred="${task.inferredWork ? 1 : 0}" data-review="${task.column === "review" ? 1 : 0}">`
    + `<div class="top"><span class="id">${esc(task.id)}</span>·${project(ctx, task)}${task.pr ? `<span class="pr">PR ${esc(task.pr)}</span>` : ""}</div>`
    + `<div class="title" title="${esc(task.title)}">${esc(task.title)}</div>`
    + task.reasons.map(flag).join("") + agents(ctx, task)
    + (task.inferredWork ? `<div class="cycle">Inferred work on the open PR</div>` : "")
    + (!done && Number(task.round) > 0 && !task.currentHead ? `<div class="cycle">repair round ${esc(task.round)}</div>` : "")
    + (done ? "" : cycleRows(task))
    + `<div class="tags">${tags(task)}<span class="more">Open</span></div></a>`;
}

function column(ctx, col) {
  const name = COLUMN_NAME[col.key] ?? col.name;
  const head = `<h2>${esc(name)} <span class="n">${col.tasks.length}</span></h2>`;
  if (!col.tasks.length) return `<section class="col empty-col" aria-label="${esc(name)}" data-col="${esc(col.key)}">${head}<div class="empty">No tasks.</div></section>`;
  // The backlog shows the newest 6; a browser fold holds the rest, so it opens with scripts off.
  const fold = col.key === "backlog" ? col.tasks.slice(BACKLOG_SHOWN) : [];
  const shown = col.tasks.slice(0, col.tasks.length - fold.length);
  return `<section class="col${col.needsOwner ? " needs-col" : ""}" aria-label="${esc(name)}" data-col="${esc(col.key)}">${head}${shown.map(task => card(ctx, task)).join("")}`
    + (fold.length ? `<details class="rest"><summary><span data-all>Show all ${col.tasks.length}</span><span class="faint" data-more> · ${fold.length} more, newest activity first</span></summary>${fold.map(task => card(ctx, task)).join("")}</details>` : "")
    + `</section>`;
}

function runsTable(task, now) {
  if (!task.runs.length) return `<div class="empty">No runs recorded.</div>`;
  const seconds = run => { const start = Date.parse(run.started), end = Date.parse(run.ended); return Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.round((end - start) / 1000) : null; };
  const row = run => `<tr><td class="id">${esc(run.id)}</td><td>${provider(run.evidence?.data.provider, task)} · ${esc(run.role)}</td><td><span class="st-${esc(run.status)}">${esc(run.status)}</span></td><td>${run.status === "running" && Number.isFinite(Date.parse(run.started)) ? `${duration(Math.max(0, Math.round((Date.parse(now) - Date.parse(run.started)) / 1000)))} so far` : duration(seconds(run))}</td><td>${tokens(run.tokens)}</td></tr>`;
  const table = list => `<table class="runs"><thead><tr><th>Run</th><th>Agent</th><th>Status</th><th>Time</th><th>Tokens</th></tr></thead><tbody>${list.map(row).join("")}</tbody></table>`;
  const earlier = task.runs.slice(0, Math.max(0, task.runs.length - RUNS_SHOWN));
  return `${earlier.length ? `<details class="fold"><summary>Show ${earlier.length} earlier runs</summary>${table(earlier)}</details>` : ""}${table(task.runs.slice(-RUNS_SHOWN))}`;
}

function evidence(task) {
  const heads = [...new Set(task.ledger.map(row => row.sha))];
  const ledger = heads.map((sha, i) => `<div class="head${i < heads.length - 1 ? " old" : ""}">head <span class="id">${esc(String(sha).slice(0, 7))}</span>${i < heads.length - 1 ? ` <span class="faint">· earlier head</span>` : ""}</div><dl class="kv">${task.ledger.filter(row => row.sha === sha).map(row => `<dt>${esc(row.kind)} · cycle ${esc(row.cycle)}</dt><dd>${row.run ? esc(row.run) : "CI"} · ${esc(hhmm(row.at))}</dd>`).join("")}</dl>`).join("");
  const proof = evidenceArtifacts(task).map(record => `<h4>${esc(record.data.label)}</h4><p class="faint">${esc(record.source)} · ${esc(record.observedAt)} · ${esc(record.data.run ?? "run unknown")} · digest verified</p><pre>${esc(record.content.text)}</pre>`).join("");
  return ledger || proof ? ledger + proof : `<div class="empty">No verdicts recorded.</div>`;
}

function findings(task) {
  if (!task.findings.length) return `<div class="empty">No findings recorded.</div>`;
  // N8: a moved finding says where it went, and the follow-up task's finding says where it came from.
  const where = row => row.movedTo ? ` · moved to ${esc(row.movedTo)}` : row.movedFrom ? ` · from ${esc(row.movedFrom)}` : "";
  const one = row => `<li>${row.severity ? `<span class="sev ${esc(row.severity)}">${esc(row.severity)}</span>` : ""}<span class="${row.status === "open" ? "" : "closed-text"}">${esc(row.summary)}</span> <span class="faint">· ${esc(row.status)}${where(row)}${row.reason ? ` · ${esc(row.reason)}` : ""}</span></li>`;
  const open = task.findings.filter(row => row.status === "open"), rest = task.findings.filter(row => row.status !== "open");
  return `${open.length ? `<ul class="finds">${open.map(one).join("")}</ul>` : `<div class="empty">No open findings.</div>`}${rest.length ? `<details class="fold"><summary>Closed, dismissed or moved (${rest.length})</summary><ul class="finds">${rest.map(one).join("")}</ul></details>` : ""}`;
}

function artifacts(task) {
  if (!task.artifacts.length) return `<div class="empty">No artifacts recorded.</div>`;
  return `<ul class="log">${task.artifacts.map(record => `<li>${link(record.data.label, record.data.url)}${record.data.path ? record.content?.verified ? " · digest verified" : " · content not verified" : ""} · <span class="faint">${esc(record.source)} · ${esc(record.observedAt)}</span>${record.content?.kind === "image" && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(record.content.dataUrl) ? `<figure><img src="${record.content.dataUrl}" alt="${esc(record.data.label)}"><figcaption>${esc(record.data.label)} · digest verified</figcaption></figure>` : ""}</li>`).join("")}</ul>`;
}

function headLine(task) {
  if (!task.currentHead) return /head is unknown/.test(task.loop.explanation) ? "" : " · PR head not recorded";
  const short = esc(task.currentHead.slice(0, 7));
  return task.headBasis === "ledger" ? ` · head ${standIn(task.currentHead.slice(0, 7), "The head of the newest verdict for this PR. The current PR head is not recorded.")}` : ` · head ${short}`;
}

function page(ctx, task, { open = false, bar = "" } = {}) {
  const url = prUrl(task);
  const pr = task.pr ? ` · ${url ? link(`PR ${task.pr}`, url) : standIn(`PR ${task.pr}`, "No link: the project's GitHub remote is not known.")}` : "";
  const brief = task.brief ? `<p><b>Goal:</b> ${esc(task.briefFields.goal ?? "not recorded")}</p><p><b>Acceptance:</b></p><pre>${esc(task.briefFields.acceptance ?? "not recorded")}</pre><details class="fold"><summary>Full brief</summary><pre>${esc(task.brief)}</pre></details>` : `<div class="empty">No brief recorded for this task.</div>`;
  const decisions = task.decisions.length ? `<ol class="log">${[...task.decisions].reverse().map(row => `<li><span class="faint">${esc(day(row.at))}</span> ${esc(row.decision)}${row.why ? ` · ${esc(row.why)}` : ""}</li>`).join("")}</ol>` : `<div class="empty">No decisions recorded.</div>`;
  return `<section class="page${open ? " open" : ""}" id="${esc(anchor(task))}" aria-label="${esc(task.id)}">`
    + `<div class="pagebar"><a class="back" href="${ctx.snapshot ? "#" : "/"}">← Board</a>${bar}</div>`
    + `<div class="ptop"><span class="id">${esc(task.id)}</span> · ${project(ctx, task)}${pr} · ${tags(task)} · <span class="faint">${esc(title(task.sourceLabel))} logbook</span></div>`
    + `<h2 class="ptitle">${esc(task.title)}</h2>${task.reasons.map(flag).join("")}`
    + `<div class="detail"><section class="wide"><h3>Where in the loop</h3><div class="loop">${task.loop.steps.map(step => `<span class="${["ls", LOOP[step.status]].filter(Boolean).join(" ")}">${esc(step.label)}</span>`).join("")}</div><div class="nowline">${esc(task.loop.explanation)}</div><div class="nowmeta">${esc(task.state)} · repair round ${esc(task.round)}${headLine(task)}</div>${agents(ctx, task, " nowagents")}${cycleRows(task, true)}</section>`
    + `<div class="colL"><section><h3>Brief</h3>${brief}</section><section><h3>Agent runs <span class="n">${task.runs.length}</span></h3>${runsTable(task, ctx.at)}</section><section><h3>Findings <span class="n">${task.findings.filter(row => row.status === "open").length} open</span></h3>${findings(task)}</section></div>`
    + `<div class="colR"><section><h3>Evidence <span class="n">${task.ledger.length}</span></h3>${evidence(task)}</section><section><h3>Latest decisions</h3>${decisions}</section><section><h3>Artifacts</h3>${artifacts(task)}</section></div></div></section>`;
}

function banners(model) {
  if (!model.diagnostics.length) return "";
  return `<div class="banner warn" role="status">${ICON}<div><b>Incomplete sources.</b> The numbers can be low.<ul class="diag">${model.diagnostics.map(d => `<li>${esc(d.source)} · ${esc(d.project ?? "")} · ${esc(d.message)}</li>`).join("")}</ul></div></div>`;
}

const CSS = `body{--bg:#121212;--panel:#1b1b1a;--panel2:#222220;--text:#ecebe6;--muted:#a3a198;--faint:#86847c;--line:#2f2e2b;--accent:#9d9cff;--accent-soft:#25254a;--need:#ff7a4d;--need-soft:#3d2016;--ok:#5cc28e;--ok-soft:#163426;--run:#7aa7ff;--run-soft:#182540;--warn:#e6a94a;--warn-soft:#3a2b12;--p0:#9d9cff;--p1:#4cc7bd;--p2:#f0a35a;--p3:#ff8fb8;--p4:#7bd88f;--p5:#e6d26a;--p6:#6fb7ff;--p7:#d69bff;--shadow:0 1px 2px rgba(0,0,0,.3);color-scheme:dark}
body:has(#light:checked){--bg:#f7f7f5;--panel:#ffffff;--panel2:#f1f0ec;--text:#1c1c1a;--muted:#5f5e58;--faint:#77756e;--line:#e4e2dc;--accent:#5b5bd6;--accent-soft:#ececfc;--need:#c7380a;--need-soft:#fdeae3;--ok:#1f7a4d;--ok-soft:#e3f2ea;--run:#1d4ed8;--run-soft:#e5edfd;--warn:#8a5800;--warn-soft:#fbf0dc;--p0:#5b5bd6;--p1:#0d8a7f;--p2:#b5590b;--p3:#c2477a;--p4:#2f8a45;--p5:#8a7a00;--p6:#1f6fc2;--p7:#8a4fc2;--shadow:0 1px 2px rgba(0,0,0,.06);color-scheme:light}
*{box-sizing:border-box}[hidden]{display:none!important}html{background:#121212}
body{margin:0;background:var(--bg);color:var(--text);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;min-height:100vh}
a{color:var(--accent)}.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
header{display:flex;flex-wrap:wrap;align-items:center;gap:10px 16px;padding:14px 20px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:2}
h1{font-size:15px;margin:0;font-weight:650}.spacer{flex:1}.chips{display:flex;gap:6px;flex-wrap:wrap}
.chip{border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:99px;padding:4px 10px;font:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:6px;text-decoration:none;white-space:nowrap}
.chip[aria-pressed="true"]{background:var(--accent-soft);border-color:var(--accent);color:var(--accent)}
.chip.need[aria-pressed="true"]{background:var(--need-soft);border-color:var(--need);color:var(--need)}
.chip:focus-visible,.card:focus-visible,summary:focus-visible,.back:focus-visible,.linkbtn:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
body:has(#light:focus-visible) .theme{outline:2px solid var(--accent);outline-offset:2px}
.count{font-weight:700}.dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none;background:var(--accent)}
.dot.p0{background:var(--p0)}.dot.p1{background:var(--p1)}.dot.p2{background:var(--p2)}.dot.p3{background:var(--p3)}.dot.p4{background:var(--p4)}.dot.p5{background:var(--p5)}.dot.p6{background:var(--p6)}.dot.p7{background:var(--p7)}
.livepill{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--muted);border:1px solid var(--line);border-radius:99px;padding:3px 9px;white-space:nowrap}
.livepill .ld{width:7px;height:7px;border-radius:50%;background:var(--faint)}
.livepill.ok{color:var(--ok)}.livepill.ok .ld{background:var(--ok);animation:pulse 1.6s infinite}
.livepill.wait{color:var(--run)}.livepill.wait .ld{background:var(--run);animation:pulse 1s infinite}
.livepill.bad{color:var(--need)}.livepill.bad .ld{background:var(--need)}
.summary{display:flex;gap:18px;padding:10px 20px;color:var(--muted);font-size:12px;flex-wrap:wrap}
.summary b{color:var(--text)}.summary b.needn{color:var(--need)}
.banner{display:flex;gap:8px;align-items:flex-start;margin:0 20px 10px;padding:8px 10px;border-radius:8px;font-size:12px}
.banner.warn{background:var(--warn-soft);color:var(--warn)}.banner svg{flex:none;margin-top:1px}.diag{margin:4px 0 0;padding-left:16px;overflow-wrap:anywhere}
.board{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(220px,1fr);gap:12px;padding:6px 20px 24px;overflow-x:auto;align-items:start}
.col{background:var(--panel2);border-radius:10px;padding:8px;min-height:120px}
.col h2{font-size:12px;font-weight:650;margin:4px 6px 10px;display:flex;align-items:center;gap:8px}
.col h2 .n,h3 .n{color:var(--muted);font-weight:500}
.card{display:block;color:inherit;text-decoration:none;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 11px;margin-bottom:8px;box-shadow:var(--shadow);position:relative}
a.card:hover{border-color:var(--accent)}.card.needs{border-color:var(--need);box-shadow:0 0 0 1px var(--need) inset}.card.needs:hover{border-color:var(--need)}
.top{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:11.5px;min-width:0}
.id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.proj{display:inline-flex;align-items:center;gap:5px;color:var(--text);font-weight:550;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pr{margin-left:auto;color:var(--muted);white-space:nowrap}
.title{margin:6px 0 8px;font-weight:550;font-size:13px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.flag{display:flex;align-items:flex-start;gap:6px;background:var(--need-soft);color:var(--need);border-radius:6px;padding:6px 8px;font-size:12px;font-weight:600;margin-bottom:8px;overflow-wrap:anywhere}
.flag svg{flex:none;margin-top:1px}
.agents{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px}
.agent{display:inline-flex;align-items:center;gap:5px;background:var(--run-soft);color:var(--run);border-radius:5px;padding:2px 7px;font-size:11.5px;font-weight:550}
.agent .live{width:6px;height:6px;border-radius:50%;background:var(--run);animation:pulse 1.6s infinite}
.agent.alt{background:var(--ok-soft);color:var(--ok)}.agent.alt .live{background:var(--ok)}
.prov{opacity:.8;font-weight:500}
@keyframes pulse{50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
.cycle{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--muted);flex-wrap:wrap;margin-bottom:2px}
.steps{display:inline-flex;gap:3px;flex-wrap:wrap}
.step{font-size:10.5px;padding:1px 5px;border-radius:4px;background:var(--panel2);color:var(--muted);border:1px solid var(--line)}
.step.done{background:var(--ok-soft);color:var(--ok);border-color:transparent}
.step.running{background:var(--run-soft);color:var(--run);border-color:transparent}
.step.failed{background:var(--need-soft);color:var(--need);border-color:transparent}
.step.unknown{border-style:dashed;background:transparent;color:var(--faint)}
.tags{display:flex;gap:4px;margin-top:6px;align-items:center;flex-wrap:wrap}
.tag{font-size:10.5px;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:0 5px}
.tag.risk{color:var(--warn);border-color:var(--warn)}
.more{margin-left:auto;font-size:11px;color:var(--muted)}.more::after{content:" →"}
.faint{color:var(--faint);font-weight:400}.empty{color:var(--muted);font-size:12px;padding:6px}
details.rest>summary{cursor:pointer;color:var(--accent);font-size:12px;font-weight:600;padding:4px 6px 8px;list-style:none}
details.rest>summary::-webkit-details-marker{display:none}
details.rest>summary::before{content:"▸ "}details.rest[open]>summary::before{content:"▾ "}
.standin{text-decoration:underline dotted;text-underline-offset:3px;text-decoration-thickness:1px}
.page{display:none;max-width:1100px;margin:0 auto;padding:18px 20px 40px}.page:target,.page.open{display:block}
body:has(.page:target) .boardview{display:none}
.pagebar{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.back{display:inline-block;color:var(--accent);text-decoration:none;font-weight:600}
.ptop{display:flex;flex-wrap:wrap;align-items:center;gap:6px;color:var(--muted);font-size:12.5px}
.ptitle{font-size:20px;margin:8px 0 14px;font-weight:650;line-height:1.3;overflow-wrap:anywhere}
.detail{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:16px 24px;align-items:start}
.detail .wide{grid-column:1/-1}.colL,.colR{display:grid;gap:16px;min-width:0}
.detail section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;min-width:0}
.detail h3{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:0 0 8px;font-weight:650}
.detail h4{font-size:12px;margin:10px 0 2px}.detail p{margin:0 0 6px;overflow-wrap:anywhere}
.loop{display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-bottom:8px}
.ls{font-size:11px;padding:2px 7px;border-radius:99px;border:1px solid var(--line);color:var(--muted)}
.ls.done{color:var(--ok);border-color:transparent;background:var(--ok-soft)}
.ls.now{color:var(--run);border-color:var(--run);background:var(--run-soft);font-weight:650}
.ls.skip{opacity:.45;text-decoration:line-through}
.ls.need{color:var(--need);border-color:var(--need);background:var(--need-soft);font-weight:650}
.nowline{font-size:13px;margin-bottom:2px;overflow-wrap:anywhere}.nowmeta{font-size:12px;color:var(--muted);margin-bottom:8px}.nowagents{margin-bottom:8px}
.kv{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;font-size:12px;margin:0 0 8px}.kv dt{color:var(--muted)}.kv dd{margin:0}
.head{font-size:11.5px;color:var(--muted);margin:2px 0 4px}.head.old{opacity:.8}
table.runs{width:100%;border-collapse:collapse;font-size:11.5px}
table.runs th{text-align:left;color:var(--muted);font-weight:550;padding:2px 4px;border-bottom:1px solid var(--line)}
table.runs td{padding:3px 4px;border-bottom:1px solid var(--line);vertical-align:top}
.st-running{color:var(--run);font-weight:600}.st-done{color:var(--ok)}.st-failed{color:var(--need)}.st-blocked,.st-question{color:var(--warn)}
details.fold>summary{cursor:pointer;color:var(--accent);font-size:12px;margin:2px 0 6px}
.finds{list-style:none;margin:0;padding:0;display:grid;gap:8px;font-size:12px}.finds li{overflow-wrap:anywhere}
.sev{font-size:10.5px;border-radius:4px;padding:0 5px;margin-right:6px;font-weight:600}
.sev.medium{background:var(--warn-soft);color:var(--warn)}.sev.low{background:var(--panel2);color:var(--muted)}.sev.high{background:var(--need-soft);color:var(--need)}
.closed-text{color:var(--muted)}
.log{font-size:12px;margin:0;padding-left:16px;display:grid;gap:5px}.log li{overflow-wrap:anywhere}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;margin:0 0 6px}img{max-width:100%;height:auto}figure{margin:6px 0}
.legend{padding:0 20px 18px;color:var(--muted);font-size:12px;display:flex;gap:16px;flex-wrap:wrap;align-items:center}
.legend>span{display:inline-flex;gap:5px;align-items:center;flex-wrap:wrap}
.emptyboard{border:1px dashed var(--line);border-radius:8px;padding:12px;margin:0 20px 12px;font-size:12px;color:var(--muted)}
.emptyboard b{color:var(--text);display:block;margin-bottom:2px}
.linkbtn{background:none;border:0;padding:0;margin-top:6px;font:inherit;color:var(--accent);text-decoration:underline;cursor:pointer}
@media (max-width:700px){
 header{padding:12px 16px;gap:8px 10px}
 header .chips{flex-wrap:nowrap;overflow-x:auto;width:100%;padding-bottom:2px;scrollbar-width:none}
 .summary,.legend{padding-left:16px;padding-right:16px;gap:6px 14px}
 .banner,.emptyboard{margin:0 16px 10px}
 .board{grid-auto-flow:row;grid-auto-columns:auto;grid-template-columns:1fr;padding:6px 16px 20px;overflow:visible}
 .col{min-height:0}.col.needs-col{order:-1}.col.empty-col{display:none}
 .page{padding:14px 16px 32px}.detail{grid-template-columns:1fr}.ptitle{font-size:18px}
}`;

// The filter recounts the summary, the Needs-you chip, the columns and the backlog fold (T217). The live script calls filter()
// after each update, so the chosen project and the Needs-you choice stay. Only simple selectors: the test's small DOM reads them.
export const BOARD_ENHANCEMENT = `let project='',needs=false;function filter(){const buttons=[...document.querySelectorAll('[data-filter]')];if(project&&!buttons.some(b=>b.dataset.filter===project))project='';buttons.forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.filter==='needs'?needs:b.dataset.filter===project)));const cards=[...document.querySelectorAll('.card')];let needsAll=0;cards.forEach(card=>{const inProject=!project||card.dataset.project===project;if(inProject&&card.dataset.needs==='true')needsAll++;card.hidden=!(inProject&&(!needs||card.dataset.needs==='true'))});const shown=cards.filter(card=>!card.hidden),sum=key=>shown.reduce((n,card)=>n+Number(card.dataset[key]),0);document.querySelectorAll('[data-col]').forEach(col=>{const visible=[...col.querySelectorAll('.card')].filter(card=>!card.hidden);const count=col.querySelector('.n');if(count)count.textContent=String(visible.length);col.classList.toggle('empty-col',!visible.length);col.classList.toggle('needs-col',visible.some(card=>card.dataset.needs==='true'));const rest=col.querySelector('.rest');if(rest){const more=[...rest.querySelectorAll('.card')].filter(card=>!card.hidden).length;rest.hidden=!more;const all=rest.querySelector('[data-all]'),left=rest.querySelector('[data-more]');if(all)all.textContent='Show all '+visible.length;if(left)left.textContent=' · '+more+' more, newest activity first'}});const set=(id,value)=>{const element=document.getElementById(id);if(element)element.textContent=String(value)};if(cards.length){set('s-needs',shown.filter(card=>card.dataset.needs==='true').length);set('s-agents',sum('agents'));set('s-inferred',sum('inferred'));set('s-review',sum('review'));set('s-tasks',shown.length);set('needs-count',needsAll)}const none=document.getElementById('nomatch');if(none)none.hidden=!cards.length||shown.length>0}document.addEventListener('click',event=>{if(event.target.closest('[data-reset]')){project='';needs=false;filter();return}const button=event.target.closest('[data-filter]');if(!button)return;if(button.dataset.filter==='needs')needs=!needs;else project=button.dataset.filter;filter()});try{if(localStorage.getItem('board-theme')==='light')document.getElementById('light').checked=true}catch(error){}document.addEventListener('change',event=>{if(event.target.id==='light')try{localStorage.setItem('board-theme',event.target.checked?'light':'dark')}catch(error){}});`;

function liveScript(taskKey) {
  const stream = taskKey ? `/?events=1&task=${Buffer.from(taskKey).toString("base64url")}` : "/?events=1";
  return `const stream=new EventSource(${JSON.stringify(stream)});const at=()=>document.getElementById('board-content').dataset.at;const show=(kind,text)=>{const pill=document.getElementById('live-state');if(!pill)return;pill.className='livepill '+kind;pill.querySelector('.lt').textContent=text};show('wait','Connecting…');stream.addEventListener('board',event=>{try{const payload=JSON.parse(event.data);const page=new DOMParser().parseFromString(payload.html,'text/html');const content=page.getElementById('board-content');if(!content)throw new Error('incomplete update');for(const id of ['board-content','board-summary','board-filters']){const next=page.getElementById(id),old=document.getElementById(id);if(next&&old)old.replaceChildren(...next.childNodes)}document.getElementById('board-content').dataset.at=content.dataset.at;filter();if(payload.stale)show('bad','Update failed · board from '+at());else show('ok','Live · updated '+at())}catch{show('bad','Update failed · board from '+at())}});stream.onerror=()=>show('bad','Reconnecting · board from '+at());`;
}

export function renderBoardHtml(model, { taskKey = null, snapshot = true, live = false } = {}) {
  const task = taskKey ? model.tasks.find(task => task.key === taskKey) : null;
  if (taskKey && !task) throw new RangeError("unknown task key");
  const ctx = context(model, snapshot), counts = model.counts, at = hhmm(model.at);
  // Without scripts, a live page keeps this text; the live script changes it at once.
  const pill = `<span class="livepill" id="live-state" role="status"><span class="ld" aria-hidden="true"></span><span class="lt">${snapshot ? "Snapshot" : "Board"} · ${esc(at)}</span></span>`;
  const theme = `<label class="chip theme" for="light">Light theme</label>`;
  let body;
  if (task) body = `<div id="board-content" data-at="${esc(at)}">${banners(model)}${page(ctx, task, { open: true, bar: `${pill}<span class="spacer"></span>${theme}` })}</div>`;
  else {
    const projects = [...new Map(model.tasks.map(task => [task.project, task.projectName])).entries()].sort(([a], [b]) => a.localeCompare(b));
    const filters = `<div class="chips" id="board-filters"><button class="chip need" type="button" data-filter="needs" aria-pressed="false">${ICON}Needs you <span class="count" id="needs-count">${counts.needsOwner}</span></button><button class="chip" type="button" data-filter="" aria-pressed="true">All projects</button>${projects.map(([key, name]) => `<button class="chip" type="button" data-filter="${esc(key)}" aria-pressed="false">${dot(ctx, key)}${esc(name)}</button>`).join("")}</div>`;
    const summary = `<div class="summary" id="board-summary"><span><b class="needn" id="s-needs">${counts.needsOwner}</b> needs you</span><span><b id="s-agents">${counts.recordedAgents}</b> agents at work</span>${counts.inferredWork ? `<span><b id="s-inferred">${counts.inferredWork}</b> inferred PRs</span>` : ""}<span><b id="s-review">${counts.inReview}</b> in review</span><span><b id="s-tasks">${counts.tasks}</b> tasks</span><span>built ${esc(day(model.at))} UTC</span></div>`;
    const empty = counts.tasks ? "" : `<div class="emptyboard"><b>No tasks recorded yet.</b> The board reads the logbooks. Frame a task in a sage session, and it shows here.</div>`;
    const nomatch = `<div class="emptyboard" id="nomatch" hidden><b>No task matches.</b> No visible task fits this filter. <button class="linkbtn" type="button" data-reset>Show all projects</button></div>`;
    const legend = `<div class="legend"><span><span class="agent"><span class="live" aria-hidden="true"></span><span class="prov">${standIn("Provider", "A dotted underline marks a stand-in value.")} ·</span> role</span> an agent at work now</span><span><span class="step done">code ✓</span><span class="step running">qa …</span><span class="step failed">sec ✗</span><span class="step pending">ux ○</span> one review cycle on the PR's head</span></div>`;
    body = `<div class="boardview"><header><h1>Task board</h1>${pill}<span class="spacer"></span>${theme}${filters}</header>${summary}<div id="board-content" data-at="${esc(at)}">${banners(model)}${empty}${nomatch}<main class="board">${model.columns.map(col => column(ctx, col)).join("")}</main>${legend}</div></div>`
      + (snapshot ? `<div id="pages">${model.tasks.map(task => page(ctx, task)).join("")}</div>` : "");
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${task ? `${esc(task.id)} · ` : ""}Sage task board</title><style>${CSS}</style></head><body><input type="checkbox" id="light" class="vh" aria-label="Light theme">${body}<script>${BOARD_ENHANCEMENT}${live ? liveScript(taskKey) : ""}</script></body></html>`;
}

const columnMark = key => ({ backlog: "📋", design: "🎨", building: "🔨", review: "🔁", ready: "✅", done: "🏁" }[key]);
const providerText = (name, task) => name ? md(name) : `${md(title(task.providerStandIn))} (logbook source)`;
const cycleText = cycle => `${cycle.steps.map(s => `${mark(s.status)} ${s.role}`).join(" · ")}`;
/** The chat card shows the same cycle as the HTML card: the current one, and no "?" steps when the head is unknown. */
function cardCycleText(task) {
  if (!task.cycles.length || task.column === "done") return "";
  const current = task.cycles.find(cycle => cycle.steps.some(step => step.status !== "done")) ?? task.cycles.at(-1);
  if (!task.currentHead) return task.pr ? `Cycle ${current.number} of ${task.requiredCycles}: PR head not recorded\n` : "";
  return `Cycle ${current.number} of ${task.requiredCycles}: ${cycleText(current)}\n`;
}
const BACKLOG_NEXT = 3;

export function renderTaskText(task) {
  const head = task.currentHead ? `${md(task.currentHead)}${task.headBasis === "ledger" ? " (newest verdict)" : ""}` : "unknown";
  const where = row => row.movedTo ? ` · moved to ${md(row.movedTo)}` : row.movedFrom ? ` · from ${md(row.movedFrom)}` : "";
  return `**${md(task.id)} ${md(task.title)}**\n${md(task.sourceLabel)} · ${md(task.projectName)} · ${md(task.state)} · ${md(task.size)}${task.risk ? ` · risk: ${md(task.risk)}` : ""}${task.pr ? ` · PR ${prUrl(task) ? `[${md(task.pr)}](${prUrl(task)})` : md(task.pr)}` : ""}\n\n**Loop**\n${task.loop.steps.map(step => `${step.status === "done" ? "✓ " : step.status === "current" ? "▶ " : step.status === "needs-owner" ? "🔴 " : ""}${step.status === "skipped" ? `~~${md(step.label)}~~` : md(step.label)}`).join(" · ")}\n> ${md(task.loop.explanation)}\n${md(task.state)} · repair round ${md(task.round)} · head ${head}\n${task.cycles.map(c => `Cycle ${c.number} of ${task.requiredCycles}: ${cycleText(c)}`).join("\n")}\n\n**Brief**\nGoal: ${mdBlock(task.briefFields.goal ?? "not recorded")}\nAcceptance: ${mdBlock(task.briefFields.acceptance ?? "not recorded")}\n\nFull brief:\n${mdBlock(task.brief ?? "No verified brief content is available.")}\n\n**Agent runs**\n${task.runs.map(r => `${md(r.id)} ${providerText(r.evidence?.data.provider, task)} · ${md(r.role)} · ${md(r.status)} · ${md(runTime(r))} · tokens ${md(r.tokens || "unknown")}`).join("\n") || "No runs recorded."}\n\n**Evidence**\n${task.ledger.map(r => `${md(r.kind)} · cycle ${md(r.cycle)} · ${md(r.sha)} · ${md(r.run)} · ${md(r.at)}`).join("\n") || "No verdicts recorded."}${evidenceArtifacts(task).map(r => `\n\n${md(r.data.label)} · ${md(r.source)} · ${md(r.observedAt)} · ${md(r.data.run ?? "run unknown")} · digest verified\n${mdBlock(r.content.text)}`).join("")}\n\n**Findings**\n${task.findings.map(r => `${md(r.severity)} · ${md(r.summary)} · ${md(r.status)}${where(r)}${r.reason ? ` · ${md(r.reason)}` : ""}`).join("\n") || "No findings recorded."}\n\n**Artifacts**\n${task.artifacts.map(r => `${md(r.data.label)} · ${md(r.data.url ?? (r.content?.verified ? "local artifact; digest verified" : "local artifact; content not verified"))}`).join("\n") || "No artifacts recorded."}\n\n**Latest decisions**\n${task.decisions.map(r => `${md(r.at)} · ${md(r.decision)} · ${md(r.why)}`).join("\n") || "No decisions recorded."}`;
}

export function renderBoardText(model) {
  const line = task => `**${md(task.id)} ${md(task.title)}** · ${md(task.sourceLabel)} · ${md(task.projectName)}${task.pr ? ` · PR ${md(task.pr)}` : ""}\n${task.agents.map(agent => `${providerText(agent.provider, task)} · ${md(agent.role)} · recorded running\n`).join("")}${task.inferredWork ? "Inferred from the open PR.\n" : ""}${cardCycleText(task)}`.trimEnd();
  // The backlog is long: its count and the next 3 framed tasks in id order, as the chat board always showed them.
  const id = task => Number(task.id.slice(1));
  const section = column => {
    const tasks = column.key === "backlog" ? [...column.tasks].sort((a, b) => id(a) - id(b) || a.project.localeCompare(b.project)).slice(0, BACKLOG_NEXT) : column.tasks;
    const rest = column.tasks.length - tasks.length;
    return `### ${columnMark(column.key)} ${md(column.name)} (${column.tasks.length})\n${tasks.map(line).join("\n\n") || "No tasks."}${rest ? `\n\n${column.key === "backlog" ? "Next up by id. " : ""}${rest} more in the ${md(column.name.toLowerCase())}: open the board page for all.` : ""}`;
  };
  return `**sage board** · ${md(model.at)}\n🔴 ${model.counts.needsOwner} need you · ${model.counts.recordedAgents} recorded agents · ${model.counts.inferredWork} inferred PRs · 🔁 ${model.counts.inReview} in review\n\n### 🔴 Needs you\n${model.needsOwner.map((task, i) => `**${i + 1} · ${md(task.id)} ${md(task.title)}**\n${md(task.sourceLabel)} · ${md(task.projectName)}\n${task.reasons.map(reason => `> ${reason.gateId ? `${md(reason.key)} · ` : ""}${md(reason.text)}${reason.options?.length ? `\n> Options: ${reason.options.map((option, i) => `${i + 1}: ${md(option)}`).join(" · ")}` : ""}${reason.recommendation ? `\n> Recommended: ${md(reason.recommendation)}` : ""}`).join("\n")}`).join("\n\n") || "No recorded task needs you."}\n\n${model.columns.map(section).join("\n\n")}\n${model.diagnostics.map(d => `Incomplete source: ${md(d.source)} · ${md(d.message)}`).join("\n")}`;
}
export function renderBoardStatus(model) {
  const states = new Map(); for (const task of model.tasks) states.set(task.state, (states.get(task.state) ?? 0) + 1);
  return `Tasks: ${[...states].map(([state,n]) => `${state} ${n}`).join(" · ") || "none recorded"}\nAgents: ${model.counts.recordedAgents} recorded running · ${model.counts.inferredWork} inferred PRs\nOwner: ${model.counts.needsOwner} tasks need you\nBudget this week: unknown; no provider observation available${model.diagnostics.length ? `\nSources: ${model.diagnostics.length} diagnostics; counts may be incomplete` : ""}`;
}
