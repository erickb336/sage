// Render only the shared model. Agent text never becomes HTML markup: it goes through esc(), and links through safeUrl().
// The look is the T218 design (approved 2026-10-11) with the T305 picker, filter bar and step line (approved 2026-10-18).
// The page needs no script for its cards, task pages, backlog fold and theme; the picker and the filters need the script.
import { LINE, PRIORITIES, TASK_KINDS, proposalOf } from "./logbook-fields.mjs";
import { ENDED, lostClause, lostWhy, MILESTONE_ID, milestoneName } from "./milestone-rules.mjs";
import { releaseWord, taskWord } from "./state-words.mjs";
import { box, columns } from "./picture.mjs";
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// The backslash and the tilde too (F1): a text that ends with a backslash would cancel the chat's hard break, and "~~" strikes text through.
// Every control (C0, C1 with U+0085) and line or paragraph separator is a space, and every format character (\p{Cf}:
// U+202E, U+200B, …) goes, as the older board's text() does (F-T233-6). ":" and "@" too, as text() escapes them, so that GFM
// makes no autolink of a bare URL or an email (R1309-2).
const md = value => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ").replace(/\p{Cf}/gu, "").replace(/[\\`*_{}\[\]()<>#+.!|&~:@]/g, c => String.fromCharCode(92) + c);
/** Text whose lines one table cell holds with LINE (a breakdown gate's question), in Markdown: its lines joined with join. */
const mdLines = (value, join = "\n") => String(value ?? "").split(LINE).map(md).join(join);
const mdBlock = value => String(value ?? "").split(/\r?\n/).map(md).join("\n");
const evidenceArtifacts = task => task.artifacts.filter(record => ["report", "proof"].includes(record.data.type) && record.content?.verified && typeof record.content.text === "string");
const b64 = value => Buffer.from(value).toString("base64url");
const route = task => `/task/${b64(task.key)}`;
const anchor = task => `task-${b64(task.key)}`;
// A milestone's page: its route on the server, an anchor in the offline snapshot (T233 C9), as a task's page is.
const milestoneAnchor = key => `milestone-${b64(key)}`;
const milestoneHref = (ctx, key) => ctx.snapshot ? `#${milestoneAnchor(key)}` : `/milestone/${b64(key)}`;
const taskHref = (ctx, task) => ctx.snapshot ? `#${anchor(task)}` : route(task);
function safeUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
// The model accepts a repository only as https://github.com/<owner>/<repo> (board-reader's githubRepository).
const prUrl = task => task.repository && /^[1-9]\d*$/.test(task.pr) ? `${task.repository}/pull/${task.pr}` : null;
const mdUrl = url => url.replace(/[()<>\[\]\\\s]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
// A class word comes from a closed list, never from logbook text; any other value gets the neutral class.
const known = (values, value) => values.includes(value) ? value : "other";
const SEVERITIES = ["high", "medium", "low"], RUN_STATUSES = ["running", "done", "failed", "blocked", "question"];
function link(label, value) { const url = safeUrl(value); return url ? `<a href="${esc(url)}" rel="noopener noreferrer">${esc(label)}</a>` : esc(label); }

const ICON = '<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor" opacity=".18"/><rect x="7.2" y="3.6" width="1.6" height="5.6" rx=".8" fill="currentColor"/><circle cx="8" cy="11.6" r="1" fill="currentColor"/></svg>';
// The step line (T305 loop design 1): each status has a mark and a word, so no status relies on colour or hover.
// "Running now" only with a live run; a current step that no agent runs is "no agent at work"; a run with no news for 24 h "may have stopped".
const MARK = { done: "✓", run: "▶", fail: "✗", need: "!", wait: "○", idle: "▷", stale: "⧗", unknown: "?" };
const WORD = { done: "done", run: "running now", fail: "failed", need: "needs you", wait: "not started", idle: "no agent at work", stale: "may have stopped", unknown: "not known yet" };
const status = value => MARK[value] ? value : "unknown";
// The ten kinds, each with a shape and a word (T305 notes, section 6).
const KIND = { design: ["◇", "Design"], ui: ["▢", "UI"], orchestration: ["⇄", "Orchestration"], optimization: ["↗", "Optimization"], "bug-fix": ["✱", "Bug fix"], logbook: ["≡", "Logbook"], docs: ["¶", "Docs"], security: ["▲", "Security"], providers: ["⊞", "Providers"], checks: ["✓", "Checks"] };
const COLUMN_NAME = { done: "Done, last 7 days" };
const BACKLOG_SHOWN = 6, RUNS_SHOWN = 6;
const foldText = n => `Show ${n} more task${n === 1 ? "" : "s"}`;
const hhmm = iso => String(iso ?? "").slice(11, 16);
const day = iso => iso ? `${String(iso).slice(0, 10)} ${hhmm(iso)}` : "";
const title = value => String(value ?? "").charAt(0).toUpperCase() + String(value ?? "").slice(1);
const standIn = (value, note, focus = true) => `<span class="standin"${focus ? ' tabindex="0"' : ""} title="${esc(note)}" data-why="${esc(note)}">${esc(value)}<span class="vh"> (${esc(note)})</span></span>`;
// N1: runs do not record their provider yet; the logbook's source stands in for it, marked with a dotted underline.
const NO_CHIEF = "Stand-in: the run names no chief, so the board does not know its provider.";
const provider = (name, task, focus = true) => name ? esc(name) : standIn(title(task.providerStandIn), task.shared ? NO_CHIEF : "Stand-in: the logbook's source. The run does not record its provider.", focus);
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
// A provider's filter word: lowercase letters, digits and dashes only, so it is safe in an attribute and a selector.
// A task of a shared or an old logbook has its own word (T306): its owning chief's provider, the old logbook's, or none.
const who = task => String(task.who ?? task.providerStandIn ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "-");
const PROVIDERS = ["claude", "codex"];
/**
 * The top line's holder (T306, F9): the logbook that holds a legacy task; the owning chief of a shared task, or Unclaimed
 * with a dashed outline; the old logbook of a finished task that did not move, or of an open row that an unfinished move left (F-T624-25).
 */
const oldWhy = task => task.old.finished ? "It did not move." : "The move did not take it to the shared logbook.";
const oldWhat = (task, where) => `${task.old.finished ? "A finished" : "An open"} task ${where} the old ${title(task.old.provider)} logbook`;
const holderTag = task => task.old ? `<span class="who oldtag" title="${esc(`${oldWhat(task, "in")}. ${oldWhy(task)}`)}">${esc(task.old.label)}</span>`
  : !task.shared ? `<span class="who" title="The logbook that holds this task">${esc(title(task.providerStandIn))}</span>`
  : task.owner ? `<span class="who own own-${known(PROVIDERS, task.owner.provider)}" title="The owning chief: the one chief that can change this task"><span class="vh">Owning chief: </span>${esc(task.owner.label)}</span>`
  : `<span class="who own own-none" title="No chief owns this task: a chief claims it in the chat">Unclaimed</span>`;
const offerLine = (task, tag = "div") => task.offer ? `<${tag} class="offerline"><span aria-hidden="true">⇄</span> ${esc(task.offer)}</${tag}>` : "";

/** The page's view of the model: project colour slots (8, by sorted project key) and the source of each alternate agent colour. */
function context(model, snapshot) {
  const keys = [...new Set([...(model.projects ?? []).map(project => project.key), ...model.tasks.map(task => task.group ?? task.project)])].sort();
  // The tasks and milestones by key, and the tasks that wait for each task (the task page's "Waited for by"), built once.
  const waitedBy = new Map();
  for (const task of model.tasks) for (const wait of task.waits ?? []) if (wait.id) waitedBy.set(`${task.project}/${wait.id}`, [...(waitedBy.get(`${task.project}/${wait.id}`) ?? []), task]);
  // The shared root is no provider (T306): its agents take the colour of their provider's source, and the legend does not name it.
  const providers = model.sources.filter(source => !source.shared);
  // The id map of each project's rename of program to milestone (T995), from each milestone's old id, for a breakdown gate's old answer rows.
  const renamed = new Map();
  for (const milestone of model.milestones ?? []) if (milestone.was) (renamed.get(milestone.project) ?? renamed.set(milestone.project, new Map()).get(milestone.project)).set(milestone.was, milestone.id);
  return { snapshot, slot: new Map(keys.map((key, i) => [key, `p${i % 8}`])), sources: providers.map(source => source.id), names: providers.map(source => title(source.standIn)), at: model.at,
    tasks: new Map(model.tasks.map(task => [task.key, task])), milestones: new Map((model.milestones ?? []).map(milestone => [milestone.key, milestone])), renamed, waitedBy, model };
}
const dot = (ctx, key) => `<span class="dot ${ctx.slot.get(key) ?? "p0"}" aria-hidden="true"></span>`;
// A long name ends in an ellipsis on its inner span (a flex box cuts its own text with none); the title keeps it whole.
const project = (ctx, task) => `<span class="proj" title="${esc(task.projectName)}">${dot(ctx, task.group ?? task.project)}<span class="pn">${esc(task.projectName)}</span></span>`;
// The model keeps a priority and a kind only from their fixed lists.
const kindTag = task => task.kind ? `<span class="tag kind"><span aria-hidden="true">${KIND[task.kind][0]}</span>${KIND[task.kind][1]}</span>` : "";
// A priority's meaning, for its title and for screen readers (F-T305-12).
const PRIORITY_WORD = { P0: "highest priority", P1: "second priority", P2: "third priority", P3: "lowest priority" };
// A milestone's tag (T233): its name, and pilot on its pilot. A milestone that the logbook lost shows its id.
// The card names its nearest level (T996): its milestone with the level's word, else its release, else "no release" when
// its logbook has releases. A logbook with no releases gives its single tasks no release field, so they show no tag.
const milestoneTag = task => task.milestone ? `<span class="tag prog" title="Milestone ${esc(task.milestone.id)}${task.milestone.name ? `: ${esc(task.milestone.name)}` : ""}"><span class="pm" aria-hidden="true">◫</span>${esc(milestoneName(task.milestone))}</span>${task.milestone.pilot ? `<span class="tag pilot">pilot</span>` : ""}`
  : task.release ? `<span class="tag rel"><span class="pm" aria-hidden="true">◎</span>Release ${esc(task.release)}</span>` : task.release === null ? `<span class="tag norel" title="In no release: ask the chief to put it in one">no release</span>` : "";
// An open task with no priority shows the gap (T500): every task needs one, and the chief sets it.
const tags = task => `${task.priority ? `<span class="tag prio" title="${task.priority}, ${PRIORITY_WORD[task.priority]}">${task.priority}<span class="vh">, ${PRIORITY_WORD[task.priority]}</span></span>` : ENDED.includes(task.state) ? "" : `<span class="tag noprio" title="No priority: ask the chief to set P0 to P3">no priority</span>`}${kindTag(task)}<span class="tag">${esc(task.size)}</span>${task.risk ? `<span class="tag risk">risk: ${esc(task.risk.replace(/,/g, ", "))}</span>` : ""}${milestoneTag(task)}`;
/** The archived group: each archived project's name and task count, folded, with what needs you there. Its tasks are on no column. */
const archivedCounts = book => `${book.tasks} task${book.tasks === 1 ? "" : "s"}${book.needsOwner ? ` · ${book.needsOwner} need${book.needsOwner === 1 ? "s" : ""} you` : ""}`;
const archivedGroup = model => model.archived.length ? `<details class="archived" id="board-archived" data-key="archived"><summary id="sum-archived">Archived · ${model.archived.length} project${model.archived.length === 1 ? "" : "s"}</summary><ul>${model.archived.map(book => `<li>${esc(book.name)} · ${archivedCounts(book)}</li>`).join("")}</ul></details>` : "";
const agentPill = (ctx, task, agent, focus) => agent.stale ? `<span class="agent stale"><span aria-hidden="true">${MARK.stale}</span><span class="prov">${provider(agent.provider, task, focus)} ·</span> ${esc(agent.role)} · may have stopped</span>`
  : `<span class="agent${(task.shared ? ctx.names.indexOf(title(agent.provider)) : ctx.sources.indexOf(task.source)) % 2 === 1 ? " alt" : ""}"><span class="live" aria-hidden="true"></span><span class="prov">${provider(agent.provider, task, focus)} ·</span> ${esc(agent.role)}</span>`;
const agents = (ctx, task, extra = "", focus = true) => task.agents.length ? `<div class="agents${extra}">${task.agents.map(agent => agentPill(ctx, task, agent, focus)).join("")}</div>` : "";

/** The step line: only the route's steps, each with its mark and its word (the word is for screen readers on the line). */
const stepLine = task => `<ol class="sline" aria-label="Steps">${task.loop.steps.map(step => `<li class="s s-${status(step.status)}"><span aria-hidden="true">${MARK[status(step.status)]}</span>${esc(step.label)}<span class="vh">: ${WORD[status(step.status)]}</span></li>`).join('<li class="sep" aria-hidden="true">›</li>')}</ol>`;
/** "Now" or "Needs you", then "Next". A gate's question shows here once, not again in a banner (bug bash R1023). */
const nowNext = (task, next = true) => `<div class="nowline${task.loop.now.needs ? " need" : task.loop.now.stale ? " stale" : ""}">${task.loop.now.needs ? ICON : task.loop.now.stale ? `<span aria-hidden="true">${MARK.stale}</span>` : ""}<span><b>${task.loop.now.needs ? "Needs you" : "Now"}:</b> ${String(task.loop.now.text).split(LINE).map(esc).join("<br>")}</span></div>${next && task.loop.next ? `<div class="nextline"><b>Next:</b> ${esc(task.loop.next)}</div>` : ""}`;
/** The wait line (T233): the unmet waits of a task, with ⊘ when one is never met, so the task cannot start. */
const waitHtml = (task, now = false) => task.waitLine ? `<div class="waitline${task.waitLine.never ? " cant" : ""}"><span class="wm" aria-hidden="true">${task.waitLine.never ? "⊘" : "⧗"}</span><span>${now ? "<b>Now:</b> " : ""}${esc(task.waitLine.text)}</span></div>` : "";
/** A milestone's progress bar: merged, then abandoned, of the approved total (Q3). An SVG, as the page's CSP allows no style attribute. The text after it says the same, so a screen reader skips the bar; the abandoned part is striped, not only a colour. */
const pbar = milestone => {
  const { merged, total, abandoned } = milestone.progress, part = n => total ? (100 * n / total).toFixed(2) : "0";
  return `<div class="prow"><svg class="pbar" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><rect class="m" width="${part(merged)}" height="10"/><line class="a" x1="${part(merged)}" x2="${part(merged + abandoned.length)}" y1="5" y2="5"/></svg><b>${esc(milestone.progressText)}</b></div>`;
};
/** The six state words of the owner (state-words.mjs, the T995 design): each with its mark, so it reads without colour too. */
const STATE_WORD = { "not started": ["○", "stw-new"], waiting: ["⧗", "stw-wait"], "needs you": ["!", "stw-need"], "in progress": ["▶", "stw-run"], done: ["✓", "stw-done"], stopped: ["■", "stw-ab"] };
/** A task's or a milestone's word, with its mark; nothing for a state that the board cannot read (its diagnostic shows). */
const wordTag = (word, cls = "sw") => STATE_WORD[word] ? `<span class="${cls} ${STATE_WORD[word][1]}"><span aria-hidden="true">${STATE_WORD[word][0]}</span> ${esc(word)}</span>` : "";
const ANSWER = `<div class="answer"><b>Answer in the chat:</b> approve, change (say what to change) or drop the milestone.</div>`;
/** A breakdown gate's question as the sage stored it, line by line (QF): the board adds no words of its own but the answer line. */
const breakdownBody = reason => `${String(reason?.text ?? "").split(LINE).map(line => `<p class="q">${esc(line)}</p>`).join("")}${reason?.recommendation ? `<p class="q"><b>I recommend:</b> ${esc(reason.recommendation)}</p>` : ""}${ANSWER}`;
/** The task page lists each step with its detail and, for a review, each role with a word for its state. */
const stepRows = task => `<ol class="vlist">${task.loop.steps.map(step => `<li class="v-${status(step.status)}"><span class="g" aria-hidden="true">${MARK[status(step.status)]}</span><b>${esc(step.label)}</b> <span class="faint">${WORD[status(step.status)]}</span>${step.detail ? `<div class="faint">${esc(step.detail)}</div>` : ""}${step.parts?.length ? `<div class="parts">${step.parts.map(([name, value]) => `<span class="part p-${status(value)}"><span aria-hidden="true">${MARK[status(value)]}</span> ${esc(name)}: ${WORD[status(value)]}</span>`).join("")}</div>` : ""}</li>`).join("")}</ol>`;

function card(ctx, task, { archived = false, i = 0 } = {}) {
  const done = task.column === "done", approval = task.reasons.find(reason => reason.breakdown);
  // A wait line shows instead of the Now line; a task that needs you keeps its question, and its wait line under it.
  // A pilot whose breakdown waits for you shows the breakdown, and no wait line when its only wait is that question (Q1,
  // QF): a wait that is never met is first on the wait line (waitLine), so a line that is never met says more (R1535-1).
  const others = approval && task.reasons.filter(reason => reason !== approval);
  const now = approval ? `<div class="nowline need">${ICON}<span><b>Needs you:</b> the breakdown of ${esc(milestoneName({ id: approval.breakdown.id }, true))}.${others.length ? ` ${others.map(reason => esc(`${String(reason.text).split(LINE).join(" ")}${reason.recommendation ? ` I recommend: ${reason.recommendation}` : ""}`)).join(" ")}` : ""}</span></div>${task.waitLine?.never ? waitHtml(task) : ""}${breakdownBody(approval)}`
    : task.waitLine && !task.loop.now.needs ? waitHtml(task) : (task.column !== "backlog" ? nowNext(task) : task.loop.now.needs ? nowNext(task, false) : "") + waitHtml(task);
  return `<a class="card${task.reasons.length ? " needs" : ""}${approval ? " approval" : ""}" id="card-${b64(task.key)}" href="${esc(taskHref(ctx, task))}" data-key="${esc(task.key)}" data-project="${esc(task.group ?? task.project)}" data-provider="${esc(who(task))}" data-priority="${esc(task.priority)}" data-kind="${esc(task.kind)}" data-needs="${!!task.reasons.length}" data-agents="${task.agents.filter(agent => !agent.stale).length}" data-inferred="${task.inferredWork ? 1 : 0}" data-review="${task.column === "review" ? 1 : 0}" data-i="${i}" data-milestone="${task.milestone ? b64(task.milestone.key) : ""}"${archived ? " data-archived hidden" : ""}>`
    + (approval ? `<div class="band"><span aria-hidden="true">◫</span>Milestone approval<span class="bk">· ${esc(milestoneName(approval.breakdown))} · gate ${esc(approval.gateId)}</span></div>` : "")
    + `<div class="top"><span class="id">${esc(task.id)}</span>·${project(ctx, task)}${holderTag(task)}${task.pr ? `<span class="pr">PR ${esc(task.pr)}</span>` : ""}${wordTag(task.word)}</div>`
    // A moved task keeps its old number in view (T640): the owner knows "T640" from chats, briefs and reports.
    + (task.was ? `<div class="nextline was">${esc(task.was)}</div>` : "")
    + `<div class="title" title="${esc(task.title)}">${esc(task.title)}</div>`
    // A backlog card shows only its steps: its Now and Next lines would say the same on every card (R1056-2). A task
    // that needs you keeps its Needs you line, with the question, on every card (F-T305-4).
    + (done ? "" : stepLine(task) + now + offerLine(task)) + agents(ctx, task, "", false)
    + (task.inferredWork ? `<div class="nextline">Inferred work on the open PR</div>` : "")
    + `<div class="tags">${tags(task)}${polishTag(task)}<span class="more">Open</span></div></a>`;
}

function column(ctx, col) {
  const name = COLUMN_NAME[col.key] ?? col.name;
  const head = `<h2>${esc(name)} <span class="n">${col.tasks.length}</span></h2>`;
  // An archived project's cards are in the page but hidden: they show only when you choose that project in the picker.
  const archived = (col.archivedTasks ?? []).map((task, i) => card(ctx, task, { archived: true, i: col.tasks.length + i })).join("");
  const attrs = `aria-label="${esc(name)}" data-col="${esc(col.key)}" data-scroll="col-${esc(col.key)}"`;
  if (!col.tasks.length) return `<section class="col empty-col" ${attrs}>${head}<div class="empty">No tasks.</div>${archived}</section>`;
  // The backlog shows its first 6 cards; a browser fold holds the rest, so it opens with scripts off. The page script folds
  // again after the project and the filters, and never when 6 or fewer cards show (R1075-2).
  const fold = col.key === "backlog" ? col.tasks.slice(BACKLOG_SHOWN) : [];
  const shown = col.tasks.slice(0, col.tasks.length - fold.length);
  return `<section class="col${col.needsOwner ? " needs-col" : ""}" ${attrs}>${head}${shown.map((task, i) => card(ctx, task, { i })).join("")}`
    + (fold.length ? `<details class="rest" data-key="fold-${esc(col.key)}"><summary id="sum-fold-${esc(col.key)}"><span data-more>${foldText(fold.length)}</span></summary>${fold.map((task, i) => card(ctx, task, { i: shown.length + i })).join("")}</details>` : "")
    + `${archived}</section>`;
}

function runsTable(task) {
  if (!task.runs.length) return `<div class="empty">No runs recorded.</div>`;
  const seconds = run => { const start = Date.parse(run.started), end = Date.parse(run.ended); return Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.round((end - start) / 1000) : null; };
  // A running run shows minutes or hours up to 24 h; after 24 h with no logbook change, it says the run may have stopped.
  const clock = run => { const value = task.runClocks?.[run.id]; return value ? `<span class="${value.stale ? "stale" : ""}">${esc(value.text)}${/^\d/.test(value.text) ? " so far" : ""}</span>` : duration(seconds(run)); };
  // A shared run that records its checkout shows the folder name under its role, never the path (T625). A folder that is
  // gone from this Mac gets "· gone": the warning colour while the task is active (a review step stops), faint once it ended.
  // Only the folder of the branch's newest writer run stops a review (goneRun, F-T625-4): another gone folder is faint.
  const ended = ENDED.includes(task.state), blocks = run => !ended && run.id === task.goneRun;
  const goneWhy = run => blocks(run) ? "The folder is not on this Mac now, so sage cannot read this run's branch. The next review step of this task stops until the folder is back."
    : ended ? "The folder is not on this Mac now. The task has ended, so nothing waits on it." : "The folder is not on this Mac now. A review reads the branch in the folder of a newer run, so nothing waits on it.";
  // The board checks at most 64 folders of a logbook: a later one says that it was not checked, not that it is there (F-T625-5).
  const unchecked = "The board checks at most 64 checkout folders of a logbook, so it did not check if this one is on this Mac.";
  const checkout = run => !run.checkoutName ? "" : `<div class="faint ck">checkout ${esc(run.checkoutName)}${run.checkoutGone ? ` <span class="gone${blocks(run) ? " gone-active" : ""}" tabindex="0" title="${esc(goneWhy(run))}" data-why="${esc(goneWhy(run))}">· gone<span class="vh"> (${esc(goneWhy(run))})</span></span>` : run.checkoutGone === null ? ` <span title="${esc(unchecked)}">· not checked<span class="vh"> (${esc(unchecked)})</span></span>` : ""}</div>`;
  // A task of a shared logbook has a Provider column (T306, F9): each run's provider, from its chief. A legacy task keeps its columns.
  const agent = run => task.shared ? `<td>${run.provider ? `<span class="ptag ptag-${known(PROVIDERS, String(run.provider).toLowerCase())}">${esc(title(run.provider))}</span>` : standIn(title(task.providerStandIn), NO_CHIEF)}</td><td>${esc(run.role)}${checkout(run)}</td>` : `<td>${provider(run.provider, task)} · ${esc(run.role)}</td>`;
  const row = run => `<tr><td class="id">${esc(run.id)}</td>${agent(run)}<td><span class="st-${known(RUN_STATUSES, run.status)}">${esc(run.status)}</span></td><td>${run.status === "running" ? clock(run) : duration(seconds(run))}</td><td>${tokens(run.tokens)}</td></tr>`;
  const table = list => `<table class="runs"><thead><tr><th>Run</th>${task.shared ? "<th>Provider</th>" : ""}<th>Agent</th><th>Status</th><th>Time</th><th>Tokens</th></tr></thead><tbody>${list.map(row).join("")}</tbody></table>`;
  const earlier = task.runs.slice(0, Math.max(0, task.runs.length - RUNS_SHOWN));
  const note = goneNote(task);
  return `${earlier.length ? `<details class="fold" data-key="runs"><summary id="sum-runs">Show ${earlier.length} earlier runs</summary>${table(earlier)}</details>` : ""}${table(task.runs.slice(-RUNS_SHOWN))}${note ? `<p class="cknote">${ICON}<span>The folder <b>${esc(note.name)}</b> of ${esc(note.run)} is not on this Mac now, so sage cannot read the branch there. The next review step of ${esc(task.id)} stops until the folder is back.</span></p>` : ""}`;
}
/**
 * The gone checkout folder that stops an active task's next review (T625): the folder of the branch's newest writer run,
 * by its run, so a name that another run's present folder has too is clear (F-T625-9). Null when none or when the task ended.
 */
const goneNote = task => { const run = !ENDED.includes(task.state) && task.runs.find(item => item.id === task.goneRun); return run ? { run: run.id, name: run.checkoutName } : null; };

function evidence(task) {
  const heads = [...new Set(task.ledger.map(row => row.sha))];
  const ledger = heads.map((sha, i) => `<div class="head">commit <span class="id">${esc(String(sha).slice(0, 7))}</span>${i < heads.length - 1 ? ` <span class="faint">· an earlier commit</span>` : ""}</div><dl class="kv">${task.ledger.filter(row => row.sha === sha).map(row => `<dt>${esc(row.kind)} · cycle ${esc(row.cycle)}</dt><dd>${row.run ? esc(row.run) : "CI"} · ${esc(hhmm(row.at))}</dd>`).join("")}</dl>`).join("");
  const proof = evidenceArtifacts(task).map(record => `<h4>${esc(record.data.label)}</h4><p class="faint">${esc(record.source)} · ${esc(record.observedAt)} · ${esc(record.data.run ?? "run unknown")} · digest verified</p><pre>${esc(record.content.text)}</pre>`).join("");
  return ledger || proof ? ledger + proof : `<div class="empty">No verdicts recorded.</div>`;
}

/** A task's polish list (T671): its open low findings. An open low finding never blocks a merge. */
const polishOf = task => task.findings.filter(row => row.status === "open" && row.severity === "low");
const polishTag = task => {
  const n = polishOf(task).length;
  return n ? `<span class="tag" title="Polish list: ${n} open low finding${n === 1 ? "" : "s"}, which never block a merge">polish ${n}</span>` : "";
};

function findings(task) {
  if (!task.findings.length) return `<div class="empty">No findings recorded.</div>`;
  // N8: a moved finding says where it went, and the follow-up task's finding says where it came from.
  const where = row => row.movedTo ? ` · moved to ${esc(row.movedTo)}` : row.movedFrom ? ` · from ${esc(row.movedFrom)}` : "";
  const one = row => `<li>${row.severity ? `<span class="sev ${known(SEVERITIES, row.severity)}">${esc(row.severity)}</span>` : ""}<span class="${row.status === "open" ? "" : "closed-text"}">${esc(row.summary)}</span> <span class="faint">· ${esc(row.status)}${where(row)}${row.reason ? ` · ${esc(row.reason)}` : ""}</span></li>`;
  const polish = polishOf(task), open = task.findings.filter(row => row.status === "open" && !polish.includes(row)), rest = task.findings.filter(row => row.status !== "open");
  // T671: the open low findings are the task's polish list, apart from the findings that block it.
  const list = polish.length ? `<h4>Polish list <span class="n">${polish.length}</span></h4><p class="faint">Open low findings. They never block a merge.</p><ul class="finds">${polish.map(one).join("")}</ul>` : "";
  return `${open.length ? `<ul class="finds">${open.map(one).join("")}</ul>` : `<div class="empty">No open findings${polish.length ? " that block the merge" : ""}.</div>`}${list}${rest.length ? `<details class="fold" data-key="findings"><summary id="sum-findings">Closed, dismissed or moved (${rest.length})</summary><ul class="finds">${rest.map(one).join("")}</ul></details>` : ""}`;
}

function artifacts(task) {
  if (!task.artifacts.length) return `<div class="empty">No artifacts recorded.</div>`;
  return `<ul class="log">${task.artifacts.map(record => `<li>${link(record.data.label, record.data.url)}${record.data.path ? record.content?.verified ? " · digest verified" : " · content not verified" : ""} · <span class="faint">${esc(record.source)} · ${esc(record.observedAt)}</span>${record.content?.kind === "image" && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(record.content.dataUrl) ? `<figure><img src="${record.content.dataUrl}" alt="${esc(record.data.label)}"><figcaption>${esc(record.data.label)} · digest verified</figcaption></figure>` : ""}</li>`).join("")}</ul>`;
}

/** The recorded facts under the steps, in plain words: the state, the repair round and the last commit. */
function meta(task) {
  const head = !task.currentHead ? "" : task.headBasis === "ledger" ? ` · last commit ${standIn(task.currentHead.slice(0, 7), "The commit of the newest verdict for this PR. The PR's own last commit is not recorded.")}` : ` · last commit ${esc(task.currentHead.slice(0, 7))}`;
  return `<div class="nowmeta">Recorded state: ${esc(task.state)}${Number(task.round) > 0 ? ` · repair round ${esc(task.round)}` : ""}${head}</div>`;
}

const BREAKDOWN_STATE = { proposed: "waits for your approval", changing: "you asked for changes: the chief revises it", dropped: "you dropped it" };
// missing: the stand-in for a milestone row that the logbook does not have; an empty gate cell is another reason (R1508-1).
const breakdownWhy = breakdown => BREAKDOWN_STATE[breakdown.state] ?? lostClause(breakdown);
/** One wait of a task, with its state (T233): met, not met, or never met. */
function waitItem(ctx, task, wait) {
  if (wait.odd) return `<li class="v-stale"><span class="g" aria-hidden="true">⊘</span>Text in the waits cell that is not a task id · <span class="stw-cant">never met</span>: the chief sets the waits again.</li>`;
  if (wait.breakdown) {
    const { id, gate } = wait.breakdown, why = breakdownWhy(wait.breakdown);
    return `<li class="${wait.never ? "v-stale" : "v-wait"}"><span class="g" aria-hidden="true">${wait.never ? "⊘" : "⧗"}</span>The breakdown of ${esc(milestoneName({ id }, true))}${gate ? ` (gate ${esc(gate)})` : ""}: ${esc(why)} · <span class="${wait.never ? "stw-cant" : "faint"}">${wait.never ? "never met" : "not met"}</span></li>`;
  }
  const other = ctx.tasks.get(`${task.project}/${wait.id}`);
  const name = other ? `<a href="${esc(taskHref(ctx, other))}">${esc(wait.id)}</a> ${esc(other.title)}` : esc(wait.id);
  return `<li class="${wait.met ? "v-done" : wait.never ? "v-stale" : "v-wait"}"><span class="g" aria-hidden="true">${wait.met ? "✓" : wait.never ? "⊘" : "⧗"}</span>${name}${wait.pilot ? " · pilot" : ""} · <span class="${wait.met ? "stw-done" : wait.never ? "stw-cant" : "faint"}">${esc(wait.word)}: ${wait.met ? "met" : wait.never ? "never met" : "not met"}</span>${wait.pilot ? ' <span class="faint">(every task of the milestone waits for its pilot)</span>' : ""}</li>`;
}
/** The task page's milestone and waits (T233): its milestone with the progress, each wait with its state, and the tasks that wait for it. */
function milestoneSections(ctx, task) {
  const milestone = task.milestone && ctx.milestones.get(task.milestone.key);
  const box = !task.milestone ? `<div class="empty">In no milestone.</div>`
    : milestone ? `<p><a href="${esc(milestoneHref(ctx, milestone.key))}"><span aria-hidden="true">◫</span> ${esc(milestoneName(milestone))}</a> · ${wordTag(milestone.word, "pstate")}${task.milestone.pilot ? ' · <span class="tag pilot">pilot</span>' : ""}</p>${milestone.progress.total ? pbar(milestone) : ""}`
    : `<p><span aria-hidden="true">◫</span> ${esc(milestoneName({ id: task.milestone.id }))} · <span class="stw-cant">not in the logbook</span></p>`;
  const by = ctx.waitedBy.get(task.key) ?? [];
  return `<section><h3>Milestone</h3>${box}</section><section><h3>Waits for <span class="n">${task.waits.length}</span></h3>${task.waits.length ? `<ul class="vlist">${task.waits.map(wait => waitItem(ctx, task, wait)).join("")}</ul>` : `<div class="empty">Waits for no task.</div>`}`
    + `${by.length ? `<h4>Waited for by</h4><p>${by.map(other => `<a href="${esc(taskHref(ctx, other))}">${esc(other.id)}</a>`).join(", ")}</p>` : ""}</section>`;
}
/**
 * The Now and Next lines of a task page: a task that waits says what it waits for, and when it starts. A task that needs
 * you keeps its question as its Now line; when a wait is never met, its wait line follows and the Next line says that
 * nothing starts, also after your answer (R1535-1).
 */
function waitNext(task) {
  if (!task.waitLine || task.loop.now.needs && !task.waitLine.never) return null;
  const open = task.waits.filter(wait => !wait.met);
  return task.waitLine.never ? "Nothing until the wait changes. Ask the chief to remove the wait, or to drop this task."
    : `Starts when ${open.map(wait => wait.breakdown ? "you approve the breakdown" : `${wait.id} merges`).join(" and ")}.${task.column === "design" ? " Its design and PE may run before." : ""}`;
}
function nowWaits(task) {
  const needs = task.loop.now.needs, next = waitNext(task);
  if (next === null) return nowNext(task);
  return `${needs ? nowNext(task, false) : ""}${waitHtml(task, !needs)}<div class="nextline"><b>Next:</b> ${esc(next)}</div>`;
}
// A long milestone name ends with an ellipsis, and its title has the full name, so the page bar keeps its width (R1334-1).
const milestoneLink = (ctx, task) => {
  if (!task.milestone || !ctx.milestones.has(task.milestone.key)) return "";
  const name = task.milestone.name ?? task.milestone.id;
  // At phone width the bar shows the milestone's id, not a name cut to a letter or two (T374).
  return `<a class="back plink" href="${esc(milestoneHref(ctx, task.milestone.key))}" title="${esc(name)}">◫ <span class="cn">${esc(name)}</span><span class="pid">${esc(task.milestone.id)}</span></a>`;
};

/** A task page. Offline it is a section of the board file with its own way back; at its route it is the main content. */
function page(ctx, task, { routed = false } = {}) {
  const url = prUrl(task);
  const pr = task.pr ? ` · ${url ? link(`PR ${task.pr}`, url) : standIn(`PR ${task.pr}`, "No link: the project's GitHub remote is not known.")}` : "";
  const brief = task.brief ? `<p><b>Goal:</b> ${esc(task.briefFields.goal ?? "not recorded")}</p><p><b>Acceptance:</b></p><pre>${esc(task.briefFields.acceptance ?? "not recorded")}</pre><details class="fold" data-key="brief"><summary id="sum-brief">Full brief</summary><pre>${esc(task.brief)}</pre></details>` : `<div class="empty">No brief recorded for this task.</div>`;
  const decisions = task.decisions.length ? `<ol class="log">${[...task.decisions].reverse().map(row => `<li><span class="faint">${esc(day(row.at))}</span> ${esc(row.decision)}${row.why ? ` · ${esc(row.why)}` : ""}</li>`).join("")}</ol>` : `<div class="empty">No decisions recorded.</div>`;
  // A shared task names its owning chief and its offer over the steps; an old task says why it did not move (T306, F9).
  const holder = task.old ? `<span class="who oldtag">${esc(task.old.label)}</span>` : `<span class="faint">${esc(title(task.sourceLabel))} logbook</span>`;
  const oldNote = task.old ? `<div class="banner info oldnote"><div><b>${esc(oldWhat(task, "of"))}.</b> It stays there, read-only: ${task.old.finished ? "finished tasks did not move to the shared logbook" : "the move did not take it to the shared logbook"}. Its number belongs to that old logbook, so ${esc(task.id)} here is not a task of the shared logbook.</div></div>` : "";
  // A chief id that chiefs.tsv does not list is about this one task, so its note is on this page only (F-T624-4).
  const unlisted = task.owner?.unlisted ? `<div class="banner warn">${ICON}<div><b>The owning chief is not in chiefs.tsv.</b> ${esc(task.id)} names the chief ${esc(task.owner.id)}, which chiefs.tsv does not list, so the board does not know its provider.</div></div>` : "";
  const ownRow = task.shared ?`<div class="ownrow"><span class="f">Owning chief</span> ${holderTag(task)}${offerLine(task, "span")}</div>` : "";
  const content = `<div class="ptop"><span class="id">${esc(task.id)}</span>${task.was ? ` <span class="faint">${esc(task.was)}</span>` : ""} · ${wordTag(task.word, "pstate")} · ${project(ctx, task)}${pr} · ${tags(task)} · ${holder}</div>`
    + `<${routed ? "h1" : "h2"} class="ptitle">${esc(task.title)}</${routed ? "h1" : "h2"}>${oldNote}${unlisted}`
    + `<div class="detail"><section class="wide"><h3>Where in the loop</h3>${ownRow}${stepLine(task)}${nowWaits(task)}${stepRows(task)}${agents(ctx, task, " nowagents")}${meta(task)}<p class="faint">${task.shared ? "To claim, offer, accept or unclaim this task, ask a chief in the chat. " : ""}To change the priority or the kind, ask the chief in the chat. The board is read-only.</p></section>`
    + `<div class="colL"><section><h3>Brief</h3>${brief}</section><section><h3>Agent runs <span class="n">${task.runs.length}</span></h3>${runsTable(task)}</section><section><h3>Findings <span class="n">${task.findings.filter(row => row.status === "open").length} open</span></h3>${findings(task)}</section></div>`
    + `<div class="colR">${milestoneSections(ctx, task)}<section><h3>Evidence <span class="n">${task.ledger.length}</span></h3>${evidence(task)}</section><section><h3>Latest decisions</h3>${decisions}</section><section><h3>Artifacts</h3>${artifacts(task)}</section></div></div>${legend(null)}`;
  return routed ? content : `<section class="page" id="${esc(anchor(task))}" aria-label="${esc(task.id)}"><div class="pagebar"><a class="back" href="#">← Board</a>${milestoneLink(ctx, task)}<span class="spacer"></span>${themeSwitch(`flip-${anchor(task)}`, true)}</div>${content}</section>`;
}

/** The marks of the board and the task page, with one visible sentence for the dotted stand-in values (F-T218-7). */
// F-T218-16: one agent pill for each pill colour, named by the sources that use it (sources alternate the two colours).
// The step line needs no legend: each mark has its word (T305).
const legendPill = (alt, name, text) => `<span><span class="agent${alt ? " alt" : ""}"><span class="live" aria-hidden="true"></span><span class="prov">${esc(name)} ·</span> role</span> ${esc(text)}</span>`;
const legend = ctx => {
  const names = parity => ctx?.names.filter((_, i) => i % 2 === parity).join(" or ");
  return `<div class="legend">${ctx ? legendPill(false, names(0) || "Provider", "an agent at work now") + (names(1) ? legendPill(true, names(1), `the same for ${names(1)}`) : "") : ""}<span>${standIn("Dotted", "A stand-in value.")} a stand-in value: the logbook does not record the real one. On a task page, tap it or move the focus to it to see the reason.</span></div>`;
};

/** The banner's text after its first sentence, in the chat board too: the moved cards, the finished tasks and the map. */
// A finished task of a milestone moved with it and has a new number too (F-T647-5).
const movedText = item => `${item.tasks === 1 ? "1 open task has a new number" : `${item.tasks} open tasks have new numbers`}, and each card shows its old number. Finished tasks stay in Done as Old and read-only${item.finished ? `, except ${item.finished === 1 ? "1 finished task of a milestone, which moved with its milestone and has" : `${item.finished} finished tasks of milestones, which moved with their milestones and have`} a new number too` : ""}. The old-to-new map is move-map.html in the logbook folder ${item.folder}, on this Mac.`;
function banners(model) {
  // A configured root that does not exist yet is a quiet note, not an incomplete source (F-T216-8).
  const notSetUp = model.notSetUp?.length ? `<div class="banner"><div>Not set up yet: ${model.notSetUp.map(esc).join(", ")}. The board adds a logbook when it appears.</div></div>` : "";
  // A source's own problem has no project: its line has no empty field (R1391-3).
  const list = items => `<ul class="diag">${items.map(d => `<li>${[d.source, d.project, d.message].filter(Boolean).map(esc).join(" · ")}</li>`).join("")}</ul>`;
  // A page note is about the page, not a source: the server's note for a page that is too large to show (R1391-3).
  const note = model.pageNote ? `<div class="banner warn">${ICON}<div>${esc(model.pageNote)}</div></div>` : "";
  // A warning is a logbook setting that the board ignores (a bad name or archived value): the numbers are still whole.
  const warned = model.warnings.length ? `<div class="banner warn">${ICON}<div><b>Settings ignored.</b> The board shows these projects without them.${list(model.warnings)}</div></div>` : "";
  // A note says how the board joined or kept apart the logbooks of one key (T305 notes, section 3).
  const noted = model.notes?.length ? `<div class="banner warn">${ICON}<div><b>Logbook notes.</b> How the board joined the logbooks of each repository.${list(model.notes)}</div></div>` : "";
  // The logbook kept changing through 3 reads (T306, F9): the board shows its last read, and the note says so. It never hides the board.
  const changing = model.changing?.length ? `<div class="banner warn changing" role="status">${ICON}<div><b>The logbook is changing.</b> The board shows the last read. It reads again at the next change.<ul class="diag">${model.changing.map(item => `<li>${esc(item.project)} · last read ${esc(hhmm(item.at))} UTC${item.dropped ? ` · not shown, as it changed during that read: ${esc(item.dropped.join("; "))}` : ""}</li>`).join("")}</ul></div></div>` : "";
  // A project that moved in the last 7 days (T640): the map page shows paths, so the board names it and its folder only.
  const moved = (model.moved ?? []).map(item => `<div class="banner info moved" role="status"><div><b>${esc(item.project)} moved to one shared logbook on ${esc(day(item.at))} UTC.</b> ${esc(movedText(item))}</div></div>`).join("");
  return `${changing}${moved}${note}${notSetUp}${model.diagnostics.length ? `<div class="banner warn">${ICON}<div><b>Incomplete sources.</b> The numbers can be low.${list(model.diagnostics)}</div></div>` : ""}${warned}${noted}`;
}

// Theme (bug bash R1023-4, T349): the page is dark until you choose light; a choice is kept in the browser and the head
// script applies it before the first paint. The switch is a checkbox, so it works with scripts off: it shows the
// other theme. Its label names the theme that it switches to. With scripts, a change keeps the shown theme as the choice.
// The look is the Tray direction of T349: cards in grey trays, an inset page shell.
// Some colour, shadow, radius and easing values come from affectUI free items (https://github.com/flohoeller/affectui), MIT licence, Copyright (c) 2026 Florian Höller (adfects).
// MIT License
//
// Copyright (c) 2026 Florian Höller (adfects)
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
export const DARK = "--bg:#0c0c0d;--shell:#121213;--panel:#232326;--panel2:#18181a;--text:#ededed;--muted:#a8a8ad;--faint:#9a9aa0;--line:#2e2e32;--edge:#6e6e75;--accent:#86a2ff;--accent-soft:#1f2747;--ink:#f4f4f5;--ink2:#e4e4e7;--ink-fg:#121213;--link:#93acff;--need:#ff8a52;--need-soft:#3b1e12;--ok:#4cc38a;--ok-soft:#143020;--run:#ad9bff;--run-soft:#2a2145;--warn:#e8ad4a;--warn-soft:#352812;--p0:#9d9cff;--p1:#4cc7bd;--p2:#f0a35a;--p3:#ff8fb8;--p4:#7bd88f;--p5:#e6d26a;--p6:#6fb7ff;--p7:#d69bff;--shadow:0 1px 2px rgba(0,0,0,.4);--ring:0 0 0 1px rgba(255,255,255,.07),0 1px 2px rgba(0,0,0,.4);--shellshadow:0 1px 0 rgba(0,0,0,.45),0 0 0 1px #222224;--pop:0 4px 42px rgba(0,0,0,.4),0 0 0 1px rgba(255,255,255,.08);--pill:0 0 0 1px rgba(255,255,255,.06),0 1px 2px rgba(0,0,0,.4);--lift:0 8px 20px -8px rgba(0,0,0,.7);--ease:cubic-bezier(.22,1,.36,1);--fast:160ms;--scheme:dark;color-scheme:dark";
// --p2 and --p6 are text colours of the provider tag on the Agents page: darker than before, for 4.5:1.
export const LIGHT = "--bg:#f0f0f1;--shell:#fcfcfc;--panel:#ffffff;--panel2:#f0f0f1;--text:#0a0a0a;--muted:#57575c;--faint:#626267;--line:#e5e5e7;--edge:#87878d;--accent:#2a5fe6;--accent-soft:#edf2ff;--ink:#323137;--ink2:#201e25;--ink-fg:#fafafa;--link:#2a5fe6;--need:#bf3a0c;--need-soft:#fff0e8;--ok:#16794a;--ok-soft:#e6f5ed;--run:#5a3fc9;--run-soft:#f1eefc;--warn:#875800;--warn-soft:#fbf2df;--p0:#4f4fd0;--p1:#0b7f75;--p2:#9a4a06;--p3:#b83f70;--p4:#2a7f3f;--p5:#7a6c00;--p6:#1a63b0;--p7:#7f45b8;--shadow:0 1px 2px rgba(0,0,0,.06);--ring:0 0 0 1px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.06);--shellshadow:0 1px 0 rgba(0,0,0,.04),0 2px 1px -1px rgba(0,0,0,.05),0 0 0 1px #ececec;--pop:0 4px 42px rgba(0,0,0,.06),0 2px 6px rgba(0,0,0,.05),0 0 0 1px rgba(0,0,0,.06);--pill:0 0 0 .5px rgba(0,0,0,.08),0 1px 2px rgba(0,0,0,.08),0 2px 8px -2px rgba(0,0,0,.06);--lift:0 8px 20px -8px rgba(0,0,0,.16);--ease:cubic-bezier(.22,1,.36,1);--fast:160ms;--scheme:light;color-scheme:light";
/** A rule for the times that the light theme shows: a light choice, or a flipped dark (or no) choice. */
const whenLight = (suffix, body) => `:root[data-theme=light]:not(:has(.flip:checked))${suffix},:root:not([data-theme=light]):has(.flip:checked)${suffix}{${body}}`;
const THEME_CSS = `:root{${DARK}}${whenLight("", LIGHT)}.to-dark{display:none}${whenLight(" .to-light", "display:none")}${whenLight(" .to-dark", "display:inline")}`;
export const THEME_HEAD = "try{const t=localStorage.getItem('board-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}";

const CSS = `${THEME_CSS}
*{box-sizing:border-box}[hidden]{display:none!important}html{background:var(--bg)}
body{margin:0;background:var(--bg);color:var(--text);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;min-height:100vh;letter-spacing:-.003em;-webkit-font-smoothing:antialiased}
a{color:var(--link)}.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
button{font:inherit;color:inherit}
header{display:flex;flex-wrap:wrap;align-items:center;gap:10px 16px;padding:14px 20px;border-bottom:1px solid var(--line);background:transparent}
h1{font-size:15px;margin:0;font-weight:600;letter-spacing:-.01em}.spacer{flex:1}html:not(.scripted) .pick,html:not(.scripted) .fbar{display:none}
.pick{display:flex;flex-wrap:wrap;gap:6px;align-items:center;width:100%}.pickchips{display:contents}
.chip{border:1px solid var(--edge);background:var(--panel);box-shadow:var(--ring);color:var(--text);border-radius:999px;padding:4px 10px;font:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:6px;text-decoration:none;white-space:nowrap;min-height:28px;max-width:100%;min-width:0}.chip .cn{overflow:hidden;text-overflow:ellipsis;min-width:0}
.chip[aria-pressed="true"]{background:linear-gradient(var(--ink),var(--ink2));border-color:transparent;color:var(--ink-fg);box-shadow:0 0 0 1px var(--ink2),0 2px 4px rgba(0,0,0,.12)}
.chip.need[aria-pressed="true"]{background:var(--need);border-color:var(--need);color:var(--panel)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.flip:focus-visible+.theme{outline:2px solid var(--accent);outline-offset:2px}
.chip.unflip{display:none}:root:has(.flip:checked) .flip:not(:checked)~.chip.unflip,.chip.unflip:focus-visible{display:inline-flex}
:root:has(.flip:checked) .flip:not(:checked):has(~.unflip),:root:has(.flip:checked) .flip:not(:checked)+.theme:has(~.unflip),.theme:has(~.unflip:focus-visible){display:none}
.count{font-weight:700}.dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none;background:var(--accent)}.dot.none{background:var(--faint)}
.dot.p0{background:var(--p0)}.dot.p1{background:var(--p1)}.dot.p2{background:var(--p2)}.dot.p3{background:var(--p3)}.dot.p4{background:var(--p4)}.dot.p5{background:var(--p5)}.dot.p6{background:var(--p6)}.dot.p7{background:var(--p7)}
.badge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--need-soft);color:var(--need);font-size:11px;font-weight:700}
.livepill{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--muted);border:1px solid transparent;background:var(--panel);box-shadow:var(--ring);border-radius:99px;padding:3px 9px;white-space:nowrap}
.livepill .ld{width:7px;height:7px;border-radius:50%;background:var(--faint)}
.livepill.ok{color:var(--ok)}.livepill.ok .ld{background:var(--ok);animation:pulse 1.6s infinite}
.livepill.wait{color:var(--run)}.livepill.wait .ld{background:var(--run);animation:pulse 1s infinite}
.livepill.bad{color:var(--need)}.livepill.bad .ld{background:var(--need)}
.pickwrap{position:relative;min-width:0;max-width:100%}
.trigger{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--edge);background:var(--panel);box-shadow:var(--ring);border-radius:8px;padding:5px 10px;cursor:pointer;min-height:32px;max-width:100%;min-width:0}
.trigger[aria-expanded="true"]{border-color:var(--accent)}.trigger .tname{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.trigger .chev{color:var(--muted);flex:none}
.pop{position:absolute;z-index:10;margin-top:6px;width:min(420px,calc(100vw - 32px));background:var(--panel);border:1px solid transparent;border-radius:12px;box-shadow:var(--pop);display:flex;flex-direction:column;max-height:min(520px,70vh)}
.search{display:flex;align-items:center;gap:6px;padding:8px;border-bottom:1px solid var(--line)}
.search input{flex:1;min-width:0;font:inherit;color:var(--text);background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:6px 8px}
.kbd{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:0 4px}
.closebtn{flex:none;background:none;border:0;padding:0;font:inherit;color:var(--accent);cursor:pointer;display:inline-flex;align-items:center;min-height:24px}.closebtn .tap{display:none}
.list{overflow:auto;padding:4px;flex:1;margin:0}.list ul{list-style:none;margin:0;padding:0}
.grp{font-size:11px;font-weight:650;color:var(--muted);padding:8px 8px 4px;display:flex;justify-content:space-between}
.opt{display:grid;grid-template-columns:10px 1fr auto;gap:2px 8px;align-items:center;padding:7px 8px;border-radius:8px;cursor:pointer;min-height:40px}
.opt .nm{font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.opt .sub{grid-column:2/4;color:var(--muted);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.opt .meta{display:flex;gap:6px;align-items:center;color:var(--muted);font-size:11.5px;white-space:nowrap}
.opt.active,.opt:hover{background:var(--panel2)}.opt.active{box-shadow:0 0 0 1px var(--accent) inset}.opt[aria-selected="true"] .nm{color:var(--accent)}
.opt.warn .sub{color:var(--warn)}.opt.warn .sub svg{vertical-align:-2px;margin-right:3px}.archtag{flex:none;font-size:10.5px;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:0 5px}.why{color:var(--accent)}
.morebtn{display:block;width:calc(100% - 8px);margin:4px;text-align:left;background:none;border:1px dashed var(--line);border-radius:7px;padding:7px 8px;color:var(--muted);cursor:pointer}
.nomatch{padding:14px 10px;color:var(--muted)}.nomatch b{color:var(--text)}
.foot{border-top:1px solid var(--line);padding:6px 10px;color:var(--muted);font-size:11.5px;display:flex;gap:10px;flex-wrap:wrap}
.fbar{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;padding:10px 20px 0}
.f{display:inline-flex;align-items:center;gap:6px;color:var(--muted);font-size:12px;max-width:100%;min-width:0}.f select{min-width:0;text-overflow:ellipsis}
select{font:inherit;color:var(--text);background:var(--panel);border:1px solid var(--edge);box-shadow:var(--ring);border-radius:8px;padding:4px 6px;min-height:32px;max-width:100%}
.seg{display:inline-flex;border:0;background:var(--panel2);border-radius:10px;padding:3px;gap:2px;flex:none}
.seg button{border:1px solid transparent;border-radius:7px;background:transparent;color:var(--muted);padding:2px 10px;cursor:pointer;min-height:30px}
.seg button[aria-pressed="true"]{background:var(--panel);border-color:var(--edge);color:var(--text);font-weight:600;box-shadow:var(--pill)}
.summary{display:flex;gap:18px;padding:10px 20px;color:var(--muted);font-size:12px;flex-wrap:wrap}
.summary b{color:var(--text);font-variant-numeric:tabular-nums}.summary b.needn{color:var(--need)}
.banner{display:flex;gap:8px;align-items:flex-start;margin:0 20px 10px;padding:8px 10px;border-radius:10px;font-size:12px}
.banner.warn{background:var(--warn-soft);color:var(--warn)}.banner.info{background:var(--accent-soft);color:var(--accent)}.banner svg{flex:none;margin-top:1px}.diag{margin:4px 0 0;padding-left:16px;overflow-wrap:anywhere}
.board{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(170px,1fr);gap:12px;padding:6px 20px 24px;overflow-x:auto;align-items:start}
.col{background:var(--panel2);border-radius:18px;padding:5px;min-height:120px;min-width:0}
.col h2{font-size:11px;font-weight:600;margin:8px 9px 9px;display:flex;align-items:center;gap:8px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.col h2 .n,h3 .n{color:var(--muted);font-weight:500}.col h2 .n{font-variant-numeric:tabular-nums;letter-spacing:0;background:var(--panel);border-radius:6px;padding:0 6px}
.card{display:block;color:inherit;text-decoration:none;background:var(--panel);border:1px solid transparent;border-radius:14px;padding:9px 10px;margin-bottom:5px;box-shadow:var(--ring);position:relative}
a.card:hover{transform:translateY(-1px);box-shadow:var(--ring),var(--lift)}.card.needs,.card.needs:hover{box-shadow:0 0 0 1.5px var(--need),var(--shadow)}
.top{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:11.5px;min-width:0}
.id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.proj{display:inline-flex;align-items:center;gap:5px;color:var(--text);font-weight:550;min-width:0}.proj .pn{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.who{font-size:10.5px;color:var(--muted);border:1px solid transparent;background:var(--panel2);border-radius:999px;padding:0 5px;font-weight:550;white-space:nowrap;margin-left:auto;flex:none}
.who.own{color:var(--text);background:var(--panel2);border-color:var(--line)}.who.own-claude{color:var(--p2)}.who.own-codex{color:var(--p6)}.who.own-none,.who.oldtag{color:var(--muted);border:1px dashed var(--edge);background:transparent}
.offerline{display:block;font-size:12px;color:var(--accent);margin:2px 0 4px;overflow-wrap:anywhere}.ownrow{display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center;font-size:12.5px;margin:2px 0 8px}.ownrow .who{margin-left:0;font-size:12px;padding:1px 8px}.ownrow .offerline{margin:0;flex-basis:100%}
.top:has(.oldtag){flex-wrap:wrap}.top .oldtag{margin-left:0}.oldnote{margin:8px 0 10px}
.pr{color:var(--muted);white-space:nowrap}
.title{margin:6px 0 4px;font-weight:550;font-size:13.5px;letter-spacing:-.006em;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.sline{display:flex;flex-wrap:wrap;gap:2px 4px;list-style:none;margin:6px 0 4px;padding:0;align-items:center;font-size:12px}
.sline .s{display:inline-flex;gap:4px;align-items:center;padding:1px 6px;border-radius:6px;color:var(--muted)}.sline .sep{color:var(--muted)}
.s-done{color:var(--ok)!important}.s-idle{color:var(--text)!important;font-weight:650;box-shadow:0 0 0 1px var(--line) inset}.s-stale{background:var(--warn-soft);color:var(--warn)!important;font-weight:650}.s-run{background:var(--run-soft);color:var(--run)!important;font-weight:650}
.s-fail{background:var(--need-soft);color:var(--need)!important;font-weight:600}.s-need{background:var(--need-soft);color:var(--need)!important;font-weight:650;box-shadow:0 0 0 1px var(--need) inset}
.nowline{display:flex;gap:6px;align-items:flex-start;font-size:12.5px;margin:4px 0 2px;overflow-wrap:anywhere}.nowline svg{flex:none;margin-top:2px}
.nowline.stale{color:var(--warn);font-weight:600}.nowline.need{background:var(--need-soft);color:var(--need);border-radius:8px;padding:5px 8px;font-weight:600}
.nextline{font-size:12px;color:var(--muted);margin-bottom:4px;overflow-wrap:anywhere}
.vlist{list-style:none;padding:0;margin:10px 0 6px;display:flex;flex-direction:column;gap:8px;font-size:12px}
.vlist li{padding-left:20px;position:relative;overflow-wrap:anywhere}.vlist .g{position:absolute;left:0;top:0;font-weight:700}
.v-done .g{color:var(--ok)}.v-stale .g{color:var(--warn)}.p-stale{color:var(--warn)}.v-run .g{color:var(--run)}.v-fail .g,.v-need .g{color:var(--need)}.v-wait .g,.v-unknown .g{color:var(--muted)}
.parts{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:2px;color:var(--muted)}.p-done{color:var(--ok)}.p-run{color:var(--run)}.p-fail{color:var(--need)}
.stale{color:var(--warn);font-weight:600}
.agents{display:flex;flex-wrap:wrap;gap:5px;margin:4px 0 6px}
.agent{display:inline-flex;align-items:center;gap:5px;background:var(--run-soft);color:var(--run);border-radius:999px;padding:2px 9px;font-size:11.5px;font-weight:550}
.agent .live{width:6px;height:6px;border-radius:50%;background:var(--run);animation:pulse 1.6s infinite}
.agent.alt{background:var(--ok-soft);color:var(--ok)}.agent.alt .live{background:var(--ok)}.agent.stale{background:var(--warn-soft);color:var(--warn);display:inline-block;max-width:100%;border-radius:10px}.agent.stale>[aria-hidden]{margin-right:5px}
.prov{font-weight:500}
@keyframes pulse{50%{opacity:.25}}
.chip,.trigger,select,.seg button,.boardtabs a,.card,a.prog,.opt,.linkbtn,.morebtn,.closebtn{transition:background-color var(--fast) var(--ease),border-color var(--fast) var(--ease),box-shadow var(--fast) var(--ease),transform var(--fast) var(--ease),color var(--fast) var(--ease)}
.chip:active,.trigger:active,.seg button:active,.boardtabs a:active,.morebtn:active{transform:scale(.97)}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;transform:none!important}}
.tags{display:flex;gap:4px;margin-top:6px;align-items:center;flex-wrap:wrap}
.tag{display:inline-flex;gap:3px;align-items:center;font-size:10.5px;color:var(--muted);border:1px solid transparent;background:var(--panel2);border-radius:999px;padding:1px 7px}
.tag.risk{color:var(--warn);background:var(--warn-soft)}.tag.prio{color:var(--text);font-weight:600}.tag.noprio{color:var(--warn);border:1px dashed var(--warn)}.tag.kind{color:var(--text)}
.archived{padding:0 20px 14px;color:var(--muted)}.archived summary{cursor:pointer}.archived ul{margin:6px 0 0;padding-left:18px}
.more{margin-left:auto;font-size:11px;color:var(--muted)}.more::after{content:" →"}
.faint{color:var(--faint);font-weight:400}.empty{color:var(--muted);font-size:12px;padding:6px}
details.rest>summary{cursor:pointer;color:var(--accent);font-size:12px;font-weight:600;padding:4px 6px 8px;list-style:none}
details.rest>summary::-webkit-details-marker{display:none}
details.rest>summary::before{content:"▸ "}details.rest[open]>summary::before{content:"▾ "}
.standin{text-decoration:underline dotted;text-underline-offset:3px;text-decoration-thickness:1px;position:relative}
.ck{font-size:11px;margin-top:1px;overflow-wrap:anywhere}.ck>span{white-space:nowrap}.cknote{display:flex;gap:6px;align-items:flex-start;margin:6px 0 0;padding:6px 8px;border-radius:8px;background:var(--warn-soft);color:var(--warn);font-size:11.5px}.cknote svg{flex:none;margin-top:1px}.gone{position:relative}.gone-active{color:var(--warn);font-weight:550}
:is(.standin,.gone)[tabindex]:focus::after{content:attr(data-why);position:absolute;left:0;top:calc(100% + 4px);z-index:6;width:max-content;max-width:min(280px,80vw);white-space:normal;background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:5px 7px;font-size:11.5px;font-weight:400;box-shadow:var(--pop)}
.page{display:none;max-width:1100px;margin:0 auto;padding:18px 20px 40px}.page:target,.page.open{display:block}
.boardview,body>main.page,#pages>.page{background:var(--shell);border-radius:20px;margin:8px;box-shadow:var(--shellshadow)}body>main.page,#pages>.page{margin:8px auto}
body:has(.page:target) .boardview{display:none}
.pagebar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-bottom:12px}
.back{display:inline-flex;align-items:center;min-height:24px;min-width:24px;padding:2px 4px 2px 0;color:var(--text);text-decoration:none;font-weight:600}
.plink{min-width:0;gap:4px;color:var(--text)}.pagebar>:not(.plink,.spacer){flex:none}.plink .cn{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.plink .pid{display:none}
.ptop{display:flex;flex-wrap:wrap;align-items:center;gap:6px;color:var(--muted);font-size:12.5px}
.ptitle{font-size:22px;margin:8px 0 14px;font-weight:600;letter-spacing:-.02em;line-height:1.3;overflow-wrap:anywhere}
.detail{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:14px 18px;align-items:start}
.detail .wide{grid-column:1/-1}.colL,.colR{display:grid;gap:16px;min-width:0}
.detail section{background:var(--panel);border:1px solid transparent;border-radius:16px;box-shadow:var(--ring);padding:11px 13px;min-width:0}
.detail h3{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 8px;font-weight:650}
.detail h4{font-size:12px;margin:10px 0 2px}.detail p{margin:0 0 6px;overflow-wrap:anywhere}
.nowmeta{font-size:12px;color:var(--muted);margin:8px 0}.nowagents{margin-bottom:8px}
.kv{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;font-size:12px;margin:0 0 8px}.kv dt{color:var(--muted)}.kv dd{margin:0}
.head{font-size:11.5px;color:var(--muted);margin:2px 0 4px}
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
.legend>span{display:inline-flex;gap:5px;align-items:center;flex-wrap:wrap}.page .legend{padding:14px 0 0}
.emptyboard{border:1px dashed var(--line);border-radius:10px;padding:12px;margin:0 20px 12px;font-size:12px;color:var(--muted);overflow-wrap:anywhere}
.emptyboard b{color:var(--text);display:block;margin-bottom:2px}
.linkbtn{background:none;border:0;padding:0;margin-top:6px;font:inherit;color:var(--accent);text-decoration:underline;cursor:pointer}
.boardtabs{display:inline-flex;border:0;background:var(--panel2);border-radius:10px;padding:3px;gap:2px;flex:none}
.boardtabs a{border:1px solid transparent;border-radius:7px;padding:2px 10px;text-decoration:none;color:var(--muted);min-height:30px;display:inline-flex;align-items:center}
.boardtabs a[aria-current="page"]{background:var(--panel);border-color:var(--edge);color:var(--text);font-weight:600;box-shadow:var(--pill)}
.caps{display:flex;flex-wrap:wrap;gap:4px 10px;padding:0 20px 10px;font-size:12px;color:var(--muted)}
.cap{display:inline-flex;gap:5px;align-items:center;white-space:nowrap}.cap .bar{display:inline-flex;gap:2px}.cap .bar i{width:6px;height:10px;border-radius:2px;background:var(--line)}.cap .bar i.on{background:var(--run)}
.cap.full{color:var(--warn);font-weight:600}.cap.full .bar i.on{background:var(--warn)}
.agentsview{padding:0 20px 8px}.group{border:0;background:var(--panel2);border-radius:18px;padding:5px;margin:0 0 12px;overflow:hidden}
.ghead{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center;padding:6px 9px 8px}
.ghead h2{margin:0;font-size:13px;font-weight:650;overflow-wrap:anywhere}.ghead .n{color:var(--muted);font-size:12px}.ghead .gcap{margin-left:auto;font-size:12px;color:var(--muted)}
.alist,.alist ul{list-style:none;margin:0;padding:0}.alist{background:var(--panel);border-radius:14px;box-shadow:var(--ring);overflow:hidden}
.arow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 12px;padding:9px 12px;border-top:1px solid var(--line)}.alist>li:first-child>.arow{border-top:0}
.arow.child{padding-left:34px;position:relative}.arow.child::before{content:"";position:absolute;left:18px;top:0;bottom:0;border-left:1px solid var(--line)}.arow.child::after{content:"";position:absolute;left:18px;top:19px;width:9px;border-top:1px solid var(--line)}
.amain{min-width:0}.l1,.l2{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:center;min-width:0}.l2{margin-top:2px}.role{font-weight:650}
.l2 .t{color:var(--text);text-decoration:none;font-weight:500;overflow-wrap:anywhere}.l2 a.t:hover{text-decoration:underline}
.l3{color:var(--muted);font-size:11.5px;margin-top:2px;display:flex;flex-wrap:wrap;gap:2px 10px}
.ptag{font-size:10.5px;border:1px solid currentColor;border-radius:4px;padding:0 5px;font-weight:550;white-space:nowrap;color:var(--muted)}.ptag-claude{color:var(--p2)}.ptag-codex{color:var(--p6)}
.rside{text-align:right;max-width:300px;display:flex;flex-direction:column;align-items:flex-end;gap:2px}
.st{display:inline-flex;gap:5px;align-items:baseline;font-size:12px;font-weight:600}.st .m{font-weight:700;width:12px;text-align:center;flex:none}
.st-work{color:var(--ok)}.st-wait{color:var(--run)}.st-stuck,.st-stop{color:var(--need)}.st-long{color:var(--warn)}.st-unk{color:var(--muted)}
.awhy{font-size:11.5px;color:var(--muted);font-weight:400;overflow-wrap:anywhere}
.arow.flag{background:linear-gradient(90deg,var(--need-soft),transparent 60%)}.arow.flagw{background:linear-gradient(90deg,var(--warn-soft),transparent 60%)}
.rules{margin:4px 20px 28px;padding:11px 13px;border:1px solid transparent;border-radius:16px;box-shadow:var(--ring);background:var(--panel);font-size:12px;color:var(--muted)}
.rules h2{margin:0 0 6px;font-size:12.5px;color:var(--text)}.rules ul{margin:0;padding-left:18px}.rules li{margin:2px 0}.rules b{color:var(--text)}
.tag.prog{color:var(--text);background:var(--accent-soft);font-weight:550;overflow-wrap:anywhere;max-width:100%}.tag.prog .pm{color:var(--accent)}.tag.pilot{color:var(--accent);background:var(--accent-soft);font-weight:650}
.waitline{display:flex;gap:6px;align-items:flex-start;font-size:12.5px;margin:4px 0 2px;color:var(--text);overflow-wrap:anywhere}.waitline .wm{color:var(--muted);flex:none;font-weight:700;width:12px;text-align:center}
.waitline.cant{background:var(--warn-soft);color:var(--warn);border-radius:8px;padding:5px 8px;font-weight:600}.waitline.cant .wm{color:var(--warn)}
.card.approval,a.card.approval:hover,a.prog.approval,a.prog.approval:hover{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent),0 0 0 5px var(--accent-soft);padding-top:0;overflow:hidden}.card.approval{margin:6px 6px 11px}a.prog.approval{margin:6px}
.band{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:-1px -10px 8px;padding:5px 10px;background:var(--accent);color:var(--panel);font-size:11.5px;font-weight:700;letter-spacing:.02em}.band .bk{font-weight:500;opacity:.92}
.detail section.approval{padding-top:0;margin:0}.detail section.approval .band{margin:-1px -14px 10px;padding:6px 14px}
.q{font-size:12.5px;margin:4px 0;overflow-wrap:anywhere}.q b{font-weight:650}
.answer{font-size:12px;margin-top:8px;padding:7px 9px;border-radius:8px;background:var(--panel2);overflow-wrap:anywhere}.answer b{color:var(--text)}
.needstrip{margin:0 20px 12px;border-radius:18px;background:var(--panel2);padding:5px;box-shadow:inset 0 0 0 1px var(--need);overflow:hidden}
.needstrip h2{margin:0;padding:6px 9px 8px;font-size:12.5px;color:var(--need);display:flex;gap:6px;align-items:center}.needstrip ul{list-style:none;margin:0;padding:0;background:var(--panel);border-radius:14px;box-shadow:var(--ring)}
.needstrip li{padding:9px 12px;border-top:1px solid var(--line);font-size:12.5px;display:grid;grid-template-columns:18px minmax(0,1fr);gap:2px 8px;overflow-wrap:anywhere}
.needstrip li:first-child{border-top:0}.needstrip .ic{font-weight:700;color:var(--need)}.needstrip .what{font-weight:650}.needstrip .act{grid-column:2;color:var(--muted);font-size:12px}
.prow{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;font-size:12.5px;margin:4px 0}
.pbar{display:block;height:8px;border-radius:99px;overflow:hidden;background:var(--panel2);border:0;min-width:120px;flex:1 1 160px;max-width:360px}.pbar .m{fill:var(--ok)}.pbar .a{stroke:var(--faint);stroke-width:10;stroke-dasharray:.8 .8}
.pkey{display:flex;gap:10px;flex-wrap:wrap;font-size:11.5px;color:var(--muted);margin:2px 0 6px}.pkey i{display:inline-block;width:10px;height:10px;border-radius:2px;vertical-align:-1px;margin-right:4px;border:1px solid var(--line)}
.pkey i.m{background:var(--ok)}.pkey i.a{background:repeating-linear-gradient(90deg,var(--faint) 0 2px,transparent 2px 4px)}.pkey i.o{background:var(--panel2)}
.pstate{display:inline-flex;font-size:11px;border-radius:4px;padding:1px 6px;font-weight:650;white-space:nowrap}
.pstate{gap:4px}.pstate.stw-run{background:var(--run-soft)}.pstate.stw-done{background:var(--ok-soft)}.pstate.stw-need{background:var(--need-soft)}.pstate.stw-new,.pstate.stw-wait,.pstate.stw-ab{background:var(--panel2)}
.layers{list-style:none;margin:0;padding:0;display:grid;gap:12px}.layer h4{font-size:11.5px;color:var(--muted);margin:0 0 5px;font-weight:600}
.trow{display:grid;grid-template-columns:3.4em minmax(0,1fr) auto;gap:2px 10px;align-items:baseline;padding:7px 9px;border-radius:10px;background:var(--panel2);margin-bottom:5px;font-size:12.5px}
.trow .id{color:var(--muted)}.trow a.t{color:var(--text);font-weight:550;text-decoration:none;overflow-wrap:anywhere}.trow a.t:hover{text-decoration:underline}
.trow .sw{font-size:12px;font-weight:600;white-space:nowrap}.trow .sub{grid-column:2/4;color:var(--muted);font-size:12px;overflow-wrap:anywhere}
.trow.ab a.t{text-decoration:line-through;color:var(--muted)}.trow.cant{box-shadow:0 0 0 1px var(--warn) inset}.trow.cant .sub{color:var(--warn);font-weight:600}.trow.needs{box-shadow:0 0 0 1px var(--need) inset}
.stw-done{color:var(--ok)}.stw-run{color:var(--run)}.stw-new,.stw-ab,.stw-wait{color:var(--muted)}
.top:has(.sw){flex-wrap:wrap;row-gap:2px}.top:has(.sw) .who{margin-left:0}.top .sw{margin-left:auto;flex:none;font-size:11px;font-weight:650;white-space:nowrap}.stw-cant{color:var(--warn)}.stw-need{color:var(--need)}
.plist{list-style:none;margin:0;padding:0;display:grid;gap:12px}h2.grp{font-size:12px;color:var(--muted);margin:14px 0 6px;font-weight:650;display:flex;justify-content:space-between}
a.prog{display:block;background:var(--panel);border:1px solid transparent;border-radius:16px;box-shadow:var(--ring);padding:10px 12px;color:inherit;text-decoration:none;min-width:0}
a.prog:hover{transform:translateY(-1px);box-shadow:var(--ring),var(--lift)}a.prog.needs,a.prog.needs:hover{box-shadow:0 0 0 1.5px var(--need),var(--shadow)}a.prog.approval .band{margin:-1px -12px 8px;padding:5px 12px}
.prog .ph{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center}.prog h3{margin:0;font-size:14px;overflow-wrap:anywhere}
.prog .goal{margin:4px 0 8px;color:var(--muted);font-size:12.5px;overflow-wrap:anywhere}.prog .nx{font-size:12.5px;margin-top:6px;overflow-wrap:anywhere}
.prog .nx.need{background:var(--need-soft);color:var(--need);border-radius:6px;padding:5px 8px;font-weight:600}.pmeta{color:var(--muted);font-size:12px;margin-left:auto}
.page .emptyboard,.page .banner{margin:0 0 10px}
.where{margin:0 20px 12px;background:var(--panel);border-radius:14px;padding:8px 10px 10px;box-shadow:var(--ring)}
.wh{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;font-weight:650;color:var(--muted);margin:0 0 6px}
.hframe,.hbc{display:flex;flex-direction:column;gap:6px}.hbc{margin-top:6px}
.hb{border:1.5px solid var(--edge);border-radius:12px;padding:6px 9px;min-width:0;background:var(--panel);overflow-wrap:anywhere}
.hb.release{border-color:var(--ok)}.hb.milestone{border-color:var(--accent)}.hb.loose{border-style:dashed}.hb.here{border:4px double var(--need)}.hb.here.now{border-color:var(--text)}
.hbt{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px}.hbk{font-weight:650}.hbk a{color:inherit}
.hbl{font-size:12.5px;color:var(--muted);margin-top:2px}.hbl a{color:var(--link)}.hbl.tail{margin-top:6px}
@media (min-width:900px){.hbc .hbc{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start}}
.rintro{color:var(--muted);font-size:13px;margin:0 0 12px}
.rcard{background:var(--panel);border-radius:14px;padding:10px 12px;box-shadow:var(--ring);margin:0 0 10px}.rcard.loose{box-shadow:none;border:1.5px dashed var(--edge)}
.rtitle{font-weight:700;font-size:15px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 4px;overflow-wrap:anywhere}
.rrow{border-top:1px solid var(--line);padding:7px 0}.rhead{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:center;overflow-wrap:anywhere}.rhead a{color:inherit}
.rtext{font-size:12.5px;color:var(--muted);margin-top:2px;overflow-wrap:anywhere}.rcard .goal{margin:4px 0;font-size:13px;overflow-wrap:anywhere}
.tag.rel{color:var(--text);background:var(--ok-soft);font-weight:550;overflow-wrap:anywhere;max-width:100%}.tag.rel .pm{color:var(--ok)}.tag.norel{font-style:italic}
@media (forced-colors:active){:is(.card,a.prog,.trow).needs:not(:focus-visible),.needstrip{outline:3px double CanvasText;outline-offset:1px}
 .boardtabs a[aria-current="page"],.seg button[aria-pressed="true"]{border:2px solid Highlight}.trow{border:1px solid CanvasText}}
@media (max-width:1116px){body>main.page,#pages>.page{margin:8px}}
@media (min-width:701px) and (max-width:1180px){
 .board{grid-auto-flow:row;grid-template-columns:repeat(3,minmax(0,1fr));overflow-x:visible}
}
@media (max-width:700px){
 header{padding:12px 16px;gap:8px 10px}
 .fbar{padding:10px 16px 0}
 .summary,.legend{padding-left:16px;padding-right:16px;gap:6px 14px}
 .banner,.emptyboard,.where{margin:0 16px 10px}
 .pop{position:fixed;left:0;right:0;bottom:0;top:auto;width:100%;max-height:80vh;border-radius:14px 14px 0 0;margin:0}
 .board{grid-auto-flow:row;grid-auto-columns:auto;grid-template-columns:1fr;padding:6px 16px 20px;overflow:visible}
 .col{min-height:0}.col.needs-col{order:-1}.col.empty-col{display:none}
 .page{padding:14px 16px 32px}.detail{grid-template-columns:1fr}.ptitle{font-size:19px}
 .boardview,body>main.page,#pages>.page{margin:0;border-radius:0;box-shadow:none}
 .plink .cn{display:none}.plink .pid{display:inline}
 .needstrip{margin:0 16px 12px}.trow{grid-template-columns:3em minmax(0,1fr)}.trow .sw{grid-column:2}.pmeta{margin-left:0}
 .caps{padding:0 16px 10px}.agentsview{padding:0 16px 8px}.rules{margin:4px 16px 24px}
 .arow{grid-template-columns:minmax(0,1fr)}.rside{text-align:left;align-items:flex-start;flex-direction:row;flex-wrap:wrap;gap:4px 10px;max-width:none}
}
@media (max-width:700px),(pointer:coarse){
 .chip,.trigger,select,.seg button,.morebtn,.opt,.back,.boardtabs a{min-height:44px}.l2 a.t{display:inline-block;padding:13px 0;margin:-13px 0}.linkbtn{min-height:44px;display:inline-flex;align-items:center}
 .archived summary{min-height:44px;display:flex;align-items:center}.seg button{min-width:44px}
 details.fold>summary,details.rest>summary{min-height:44px;padding-top:13px;padding-bottom:13px;margin:0}
 .standin[tabindex],.ptop a[href]{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;margin:-14px 0;vertical-align:middle;position:relative;z-index:1}table.runs .standin[tabindex]{margin:0}table.runs td{vertical-align:middle}.nowagents{row-gap:26px;margin:14px 0 22px}
 .closebtn{min-height:44px;min-width:44px;padding:0 10px;font-weight:600}.closebtn .kbd{display:none}.closebtn .tap{display:inline}.pop .foot{display:none}
}`;

/**
 * Does a project match the picker's search? It matches the shown name, else any other name a person may know (the
 * display names, the repositories, the folder, its path and the logbook keys), and then says which one. The page script
 * carries this function's own source, so this test of it is a test of the page.
 */
export function matchProject(name, terms, query) {
  const fold = value => String(value).normalize("NFC").toLowerCase();
  const q = fold(query).trim();
  if (!q || fold(name).includes(q)) return { ok: true, why: "" };
  const hit = terms.find(term => fold(term).includes(q));
  return hit ? { ok: true, why: `matches ${hit}` } : { ok: false, why: "" };
}

/**
 * What the filter bar keeps, and the Needs you counts under it (F-T305-9): the Needs you chip counts the tasks that need
 * you in the chosen project (else in every project that is not archived), and each project's chip counts its own, both
 * under the same Who, Priority and Kind. A card is its data attributes. The page script carries both functions' own
 * source, so these tests of them are tests of the page.
 */
export function cardFits(card, S) {
  return (!S.who || card.provider === S.who) && (!S.priority || (S.priority === "none" ? !card.priority : card.priority === S.priority)) && (!S.kind || card.kind === S.kind)
    && (!S.milestone || (S.milestone === "none" ? !card.milestone : card.milestone === S.milestone));
}
/** An item of Needs you that no card holds (a stuck milestone, a lost gate, a logbook that cannot be read) has no provider, priority or kind: it fits only while none of those filters is on, and the Milestone filter keeps its own milestone's. */
export function itemFits(item, S) {
  return !S.who && !S.priority && !S.kind && (!S.milestone || item.milestone === S.milestone);
}
export function needCounts(cards, S, items) {
  const counts = { all: 0, projects: {}, milestones: 0 };
  for (const card of cards) {
    if (card.needs !== "true" || !cardFits(card, S)) continue;
    counts.projects[card.project] = (counts.projects[card.project] || 0) + 1;
    if (S.project ? card.project === S.project : card.archived === undefined) counts.all++;
  }
  // The items that need you and have no card (F-T233-1): items are the data of the page's Needs you strip, one per item.
  for (const item of items || []) {
    if (!itemFits(item, S)) continue;
    counts.projects[item.project] = (counts.projects[item.project] || 0) + 1;
    if (!S.project || S.project === item.project) { counts.all++; counts.milestones++; }
  }
  return counts;
}

// The page script (T305). All state lives here, not in the DOM, so the live script can replace the server's parts and call
// filter() and list() again: the chosen project, the filters, the open list with its search text and active row. The choice
// is kept in the URL hash and in localStorage (with try/catch). Only the parts with ids change on a live update.
export const BOARD_ENHANCEMENT = `document.documentElement.classList.add('scripted');
const $=id=>document.getElementById(id),all=(selector,root)=>[...(root||document).querySelectorAll(selector)];
const match=${matchProject.toString()};
${cardFits.toString()}
${itemFits.toString()}
${needCounts.toString()}
const SHOWN=${BACKLOG_SHOWN},foldText=${foldText.toString()};
const S={project:'',needs:false,who:'',priority:'',kind:'',milestone:'',open:false,query:'',active:null,archived:false,gone:false};
// The address keeps the project (p) and the milestone (pg): a milestone page links to its tasks on the board with both. A
// milestones page's Needs you chip opens the board with needs=1, which turns the Needs you filter on once: the board then
// takes needs=1 out of the address, so a reload does not turn the filter on again.
// A Milestone filter of a milestone in another project ends when you choose a project, also in the address (R1371-2).
function ownMilestone(){const o=S.milestone&&S.milestone!=='none'&&S.project&&all('#f-milestone option').find(o=>o.value===S.milestone);if(o&&o.dataset.project!==S.project){S.milestone='';return true}return false}
function fromHash(){try{const h=new URLSearchParams(location.hash.slice(1));S.project=h.has('p')?h.get('p'):localStorage.getItem('board-project')||'';S.milestone=h.get('pg')||'';if(ownMilestone()){h.delete('pg');save()}if(h.has('needs')){S.needs=h.get('needs')==='1';h.delete('needs');const t=h.toString();history.replaceState(null,'',t?'#'+t:location.pathname+location.search)}}catch(e){}}
fromHash();
function save(){try{localStorage.setItem('board-project',S.project)}catch(e){}try{if(!location.hash||/^#(p|pg|needs)=/.test(location.hash)){const h=new URLSearchParams();if(S.project)h.set('p',S.project);if(S.milestone)h.set('pg',S.milestone);const t=h.toString();history.replaceState(null,'',t?'#'+t:location.pathname+location.search)}}catch(e){}}
const options=()=>all('#pick-list [role=option]');
function filter(){
  const list=$('pick-list');
  if(list&&S.project&&!options().some(o=>o.dataset.key===S.project)){S.project='';S.gone=true;save()}
  const sel=$('f-milestone');if(S.milestone&&!(sel&&all('option',sel).some(o=>o.value===S.milestone)))S.milestone='';
  const cards=all('.card[data-key]'),items=all('[data-need]'),need=needCounts(cards.map(c=>c.dataset),S,items.map(i=>i.dataset));
  items.forEach(i=>{i.hidden=!itemFits(i.dataset,S)||!!S.project&&i.dataset.project!==S.project});const strip=$('needstrip');if(strip){const n=items.filter(i=>!i.hidden).length;strip.hidden=!n;const c=$('needstrip-n');if(c)c.textContent=String(n)}
  cards.forEach(c=>{const base=(S.project?c.dataset.project===S.project:!c.hasAttribute('data-archived'))&&cardFits(c.dataset,S);c.hidden=!(base&&(!S.needs||c.dataset.needs==='true'))});
  const shown=cards.filter(c=>!c.hidden),sum=key=>shown.reduce((n,c)=>n+Number(c.dataset[key]),0);
  all('[data-col]').forEach(col=>{const visible=all('.card',col).filter(c=>!c.hidden);const count=col.querySelector('.n');if(count)count.textContent=String(visible.length);col.classList.toggle('empty-col',!visible.length);col.classList.toggle('needs-col',visible.some(c=>c.dataset.needs==='true'));const empty=col.querySelector('.empty');if(empty)empty.hidden=visible.length>0;const rest=col.querySelector('.rest');if(rest){const order=all('.card',col).sort((a,b)=>a.dataset.i-b.dataset.i),seen=order.filter(c=>!c.hidden);order.forEach(c=>{const at=seen.indexOf(c);if(at>-1&&at<SHOWN)rest.before(c);else rest.append(c)});const more=Math.max(0,seen.length-SHOWN);rest.hidden=!more;const m=rest.querySelector('[data-more]');if(m)m.textContent=foldText(more)}});
  const set=(id,value)=>{const e=$(id);if(e)e.textContent=String(value)};
  if(list&&$('board-summary')){set('s-needs',shown.filter(c=>c.dataset.needs==='true').length+need.milestones);set('s-agents',sum('agents'));set('s-inferred',sum('inferred'));set('s-review',sum('review'));set('s-tasks',shown.length);set('needs-count',need.all)}
  all('[data-filter=needs]').forEach(b=>b.setAttribute('aria-pressed',String(S.needs)));
  all('[data-who]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.who===S.who)));
  for(const f of ['priority','kind','milestone']){const e=$('f-'+f);if(e)e.value=S[f]}
  if(sel)all('option[data-project]',sel).forEach(o=>o.hidden=!!S.project&&o.dataset.project!==S.project);
  const clear=$('f-clear');if(clear)clear.hidden=!(S.who||S.priority||S.kind||S.milestone);
  const cur=options().find(o=>o.dataset.key===S.project&&S.project);
  set('pick-name',cur?cur.dataset.name:'All projects');const arch=$('pick-arch');if(arch)arch.hidden=!(cur&&cur.closest('[data-list=archived]'));const d=$('pick-dot');if(d)d.className='dot '+(cur?cur.dataset.slot:'none');
  options().forEach(o=>o.setAttribute('aria-selected',String(o.dataset.key===S.project)));
  all('[data-pick]').forEach(c=>{const n=need.projects[c.dataset.pick]||0,b=c.querySelector('[data-n]');if(b)b.textContent=String(n);c.hidden=c.dataset.pick===''?!S.project:c.dataset.pick===S.project||!n});
  const noprov=$('noprov'),lacks=!!cur&&!!S.who&&!cur.dataset.provider.split(' ').includes(S.who);
  if(noprov){noprov.hidden=!lacks;if(lacks){const w=all('[data-who]').find(b=>b.dataset.who===S.who);set('noprov-who',w?w.textContent:S.who);set('noprov-name',cur.dataset.name);set('noprov-has',cur.dataset.providers)}}
  // QD: a milestone with no card on the board (its tasks ended more than 7 days ago) says why, with a link to its page.
  const opt=sel&&S.milestone&&S.milestone!=='none'?all('option',sel).find(o=>o.value===S.milestone):null,noprog=!!opt&&!shown.length,np=$('noprog');
  if(np){np.hidden=!noprog;if(noprog){set('noprog-name',opt.textContent);set('noprog-why',opt.dataset.why);$('noprog-link').href=opt.dataset.href}}
  const none=$('nomatch');if(none)none.hidden=!cards.length||shown.length>0||lacks||noprog;
  const gone=$('gone');if(gone)gone.hidden=!S.gone;
  // The milestones list keeps the chosen project's milestones, with the count of each group.
  let rows=0;all('[data-plist]').forEach(ul=>{const own=all('li[data-project]',ul);own.forEach(li=>li.hidden=!!S.project&&li.dataset.project!==S.project);const n=own.filter(li=>!li.hidden).length,head=ul.closest('details')||ul.previousElementSibling;rows+=n;ul.hidden=!n;if(head){head.hidden=!n;const c=head.querySelector('.n');if(c)c.textContent=String(n)}});
  const nomilestones=$('nomilestones');if(nomilestones)nomilestones.hidden=rows>0;
  // The release frames above the columns and the Releases tab keep the chosen project's releases (T996).
  const rel=all('[data-rproject]');rel.forEach(e=>e.hidden=!!S.project&&e.dataset.rproject!==S.project);const nr=$('noreleases');if(nr)nr.hidden=rel.some(e=>!e.hidden);
  draw();
}
function draw(){
  const pop=$('pick-pop'),input=$('pick-q');if(!pop||!input)return;
  pop.hidden=!S.open;$('pick-trig').setAttribute('aria-expanded',String(S.open));if(input.value!==S.query)input.value=S.query;
  const q=S.query.trim(),shown=[];
  options().forEach(o=>{let ok,why='';const archived=!!o.closest('[data-list=archived]');
    if(o.dataset.key==='')ok=!q;
    else{ok=(!S.who||o.dataset.provider.split(' ').includes(S.who))&&(!archived||S.archived||!!q);if(ok&&q){const m=match(o.dataset.name,o.dataset.terms.split('\\n'),q);ok=m.ok;why=m.why}}
    o.hidden=!ok;const w=o.querySelector('[data-why]');if(w)w.textContent=why?why+' · ':'';if(ok)shown.push(o)});
  all('#pick-list [data-list]').forEach(g=>{const n=all('[role=option]',g).filter(o=>!o.hidden).length;g.querySelector('.grp').hidden=!n;const c=g.querySelector('.grp .n');if(c)c.textContent=String(n);g.hidden=!n});
  const more=$('pick-more');if(more)more.hidden=S.archived||!!q||!all('#pick-list [data-list=archived] [role=option]').length;
  const nomatch=$('pick-none');if(nomatch){nomatch.hidden=!(q&&!shown.length);const t=$('pick-qtext');if(t)t.textContent=q}
  const say=$('pick-say');if(say){const n=shown.filter(o=>o.dataset.key!=='').length,text=!S.open||!q?'':n?n+(n===1?' project matches':' projects match'):'No project matches “'+q+'”';if(say.textContent!==text)say.textContent=text}
  if(!shown.some(o=>o.dataset.key===S.active))S.active=shown.length?shown[0].dataset.key:null;
  shown.forEach(o=>o.classList.toggle('active',o.dataset.key===S.active));options().filter(o=>o.hidden).forEach(o=>o.classList.remove('active'));
  const act=shown.find(o=>o.dataset.key===S.active);if(act&&S.open){input.setAttribute('aria-activedescendant',act.id);if(act.scrollIntoView)act.scrollIntoView({block:'nearest'})}else input.removeAttribute('aria-activedescendant');
  S.keys=shown.map(o=>o.dataset.key);
}
// A Milestone filter of another project ends when you choose a project: its cards would never show there.
function choose(key){S.project=key;ownMilestone();S.open=false;S.query='';S.active=null;S.gone=false;save();filter();const t=$('pick-trig');if(t)t.focus()}
function openList(){S.open=true;S.query='';S.active=null;draw();const q=$('pick-q');if(q)q.focus()}
function closeList(focus){S.open=false;draw();if(focus){const t=$('pick-trig');if(t)t.focus()}}
document.addEventListener('click',e=>{const t=e.target;
  if(t.closest('[data-close]')){closeList(true);return}
  if(t.closest('#pick-trig')){if(S.open)closeList(true);else openList();return}
  if(t.closest('[data-showarchived]')){S.archived=true;draw();const q=$('pick-q');if(q)q.focus();return}
  if(t.closest('[data-clear]')){S.query='';S.active=null;draw();const q=$('pick-q');if(q)q.focus();return}
  const o=t.closest('#pick-list [role=option]');if(o){choose(o.dataset.key);return}
  const p=t.closest('[data-pick]');if(p){choose(p.dataset.pick);return}
  if(S.open&&!t.closest('#pick-pop'))closeList(false);
  if(t.closest('[data-filter=needs]')){S.needs=!S.needs;filter();return}
  const w=t.closest('[data-who]');if(w){S.who=w.dataset.who;filter();return}
  if(t.closest('[data-clearf]')){S.who=S.priority=S.kind=S.milestone='';save();filter();return}
  if(t.closest('[data-showall]')){S.who='';filter();return}
  if(t.closest('[data-reset]')){S.project='';S.needs=false;S.who=S.priority=S.kind=S.milestone='';save();filter();return}
  if(t.closest('[data-dismiss]')){S.gone=false;filter();return}});
window.addEventListener('hashchange',()=>{if(/^#(p|pg|needs)=/.test(location.hash)){fromHash();filter()}});
document.addEventListener('change',e=>{const f=e.target.dataset&&e.target.dataset.f;if(f){S[f]=e.target.value;if(f==='milestone')save();filter()}
  if(e.target.classList&&e.target.classList.contains('flip')){const now=getComputedStyle(document.documentElement).getPropertyValue('--scheme').trim();document.documentElement.dataset.theme=now;e.target.checked=false;try{localStorage.setItem('board-theme',now)}catch(x){}}});
// A theme chosen in another tab of the board shows here too.
window.addEventListener('storage',e=>{if(e.key==='board-theme'&&(e.newValue==='light'||e.newValue==='dark'))document.documentElement.dataset.theme=e.newValue});
// The list closes when the focus leaves the picker (R1075-5). A press inside the list keeps the focus in the search field,
// so a click on a row or a button still lands.
document.addEventListener('focusout',e=>{const w=$('pick-pop')&&$('pick-pop').parentNode;if(S.open&&w&&w.contains(e.target)&&!(e.relatedTarget&&w.contains(e.relatedTarget)))closeList(false)});
document.addEventListener('mousedown',e=>{if(e.target.closest&&e.target.closest('#pick-pop')&&!e.target.closest('input'))e.preventDefault()});
document.addEventListener('input',e=>{if(e.target.id==='pick-q'){S.query=e.target.value;S.active=null;draw()}});
document.addEventListener('keydown',e=>{const inQ=e.target.id==='pick-q';
  if(e.key==='/'&&!inQ&&!/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)&&$('pick-pop')){e.preventDefault();openList();return}
  if(e.key==='Escape'&&S.open){e.preventDefault();closeList(true);return}
  if(!inQ||!S.keys)return;const i=S.keys.indexOf(S.active),n=S.keys.length;
  if(e.key==='ArrowDown'){e.preventDefault();S.active=S.keys[Math.min(n-1,i+1)];draw()}
  else if(e.key==='ArrowUp'){e.preventDefault();S.active=S.keys[Math.max(0,i-1)];draw()}
  else if(e.key==='Home'&&!S.query){e.preventDefault();S.active=S.keys[0];draw()}
  else if(e.key==='End'&&!S.query){e.preventDefault();S.active=S.keys[n-1];draw()}
  else if(e.key==='Enter'&&n&&S.active!==null){e.preventDefault();choose(S.active)}});
filter();`;

// The live script (bug bash R1023-1, -2 and -5). It replaces a part only when the server's HTML of that part changed, then
// gives back what the viewer had: the open details (by data-key), the page and column scroll, and the focus (by id). The
// picker's state lives in the page script, which draws the new list again. The pill has no live region; a hidden status
// line announces only a failure.
function liveScript(stream, parts = ["board-content", "board-summary", "board-filters", "pick-list", "pick-chips", "board-pages"]) {
  return `const PARTS=${JSON.stringify(parts)},last={};PARTS.forEach(id=>{const e=$(id);if(e)last[id]=e.innerHTML});
const stream=new EventSource(${JSON.stringify(stream)});const at=()=>$('board-content').dataset.at;
const show=(kind,text)=>{const pill=$('live-state');if(pill){pill.className='livepill '+kind;pill.querySelector('.lt').textContent=text}const alert=$('live-alert');if(alert)alert.textContent=kind==='bad'?text:''};
show('wait','Connecting…');
function keep(){const a=document.activeElement;return{focus:a&&a.id?a.id:null,open:all('details[open][data-key]').map(d=>d.dataset.key),x:scrollX,y:scrollY,scroll:all('[data-scroll]').map(e=>[e.dataset.scroll,e.scrollLeft,e.scrollTop])}}
function give(k){all('details[data-key]').forEach(d=>{if(k.open.includes(d.dataset.key))d.open=true});all('[data-scroll]').forEach(e=>{const s=k.scroll.find(item=>item[0]===e.dataset.scroll);if(s){e.scrollLeft=s[1];e.scrollTop=s[2]}});scrollTo(k.x,k.y);const a=document.activeElement;if(k.focus&&(!a||a.id!==k.focus)){const e=$(k.focus);if(e)e.focus({preventScroll:true})}}
stream.addEventListener('board',event=>{try{const payload=JSON.parse(event.data);const page=new DOMParser().parseFromString(payload.html,'text/html');const content=page.getElementById('board-content');if(!content)throw new Error('incomplete update');
  const k=keep();let changed=false;
  for(const id of PARTS){const next=page.getElementById(id),old=$(id);if(next&&old&&next.innerHTML!==last[id]){last[id]=next.innerHTML;old.replaceChildren(...next.childNodes);changed=true}}
  $('board-content').dataset.at=content.dataset.at;if(changed){filter();give(k)}
  if(payload.stale)show('bad','Update failed · board from '+at());else show('ok','Live · updated '+at())}catch{show('bad','Update failed · board from '+at())}});
stream.onerror=()=>show('bad','Reconnecting · board from '+at());`;
}

const ago = (iso, now) => { if (!iso) return "no activity"; const days = Math.floor((Date.parse(now) - Date.parse(iso)) / 86400000); return days <= 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`; };
const LIST_NAME = { needs: "Needs you", active: "Active · last 14 days", idle: "Idle", archived: "Archived" };
/** The project picker (T305 design B): one button opens a searchable list; the server writes every row, the script filters them. */
function picker(ctx, model, paths, board = true) {
  const projects = model.projects ?? [];
  // The checkout paths are search terms only on the Mac's own page; a tunnel viewer and the offline snapshot get none (R1069-2).
  // So is the path tail of two clones; the others see "clone 1", "clone 2" (R1079-1).
  const sub = book => paths && book.pathSub ? book.pathSub : book.sub;
  const option = book => `<li role="option" id="pick-o-${b64(book.key)}" class="opt${book.problem ? " warn" : ""}" data-key="${esc(book.key)}" data-name="${esc(book.name)}" data-slot="${ctx.slot.get(book.key) ?? "p0"}" data-terms="${esc([...book.terms, ...(paths ? book.paths ?? [] : [])].join("\n"))}" data-provider="${esc(book.providers.map(name => name.toLowerCase().replace(/[^a-z0-9-]/g, "-")).join(" "))}" data-providers="${esc(book.providers.join(" + "))}" aria-selected="false">`
    + `${dot(ctx, book.key)}<span class="nm">${esc(book.name)}</span><span class="meta">${book.agents ? `<span>${book.agents} at work</span>` : ""}${book.needsOwner ? `<span class="badge">${book.needsOwner}<span class="vh"> need you</span></span>` : `<span>${ago(book.lastActivity, model.at)}</span>`}</span>`
    + `<span class="sub"><span class="why" data-why></span>${book.problem ? `${ICON}Logbook unreadable: ${esc(book.problem)}` : esc(sub(book))} · ${esc(book.providers.join(" + "))}</span></li>`;
  const group = list => {
    const books = projects.filter(book => book.list === list);
    if (!books.length) return "";
    return `<li role="presentation" data-list="${list}"><div class="grp" id="pick-g-${list}"><span>${LIST_NAME[list]}</span><span class="n">${books.length}</span></div><ul role="group" aria-labelledby="pick-g-${list}">${books.map(option).join("")}</ul></li>`;
  };
  const items = projects.length ? `<li role="option" id="pick-o-all" class="opt" data-key="" data-name="All projects" aria-selected="false"><span class="dot none" aria-hidden="true"></span><span class="nm">All projects</span><span class="meta">${plural(projects.filter(book => !book.archived).length, "project")}</span></li>${["needs", "active", "idle", "archived"].map(group).join("")}` : "";
  const archivedCount = projects.filter(book => book.list === "archived").length;
  const after = projects.length
    ? (archivedCount ? `<button type="button" class="morebtn" id="pick-more" data-showarchived>Show ${archivedCount} archived project${archivedCount === 1 ? "" : "s"}</button>` : "")
      + `<div class="nomatch" id="pick-none" hidden><b>No project matches “<span id="pick-qtext"></span>”.</b><br>Search looks at the shown name, the GitHub repository, the folder${paths ? ", its path" : ""} and the logbook key. <button type="button" class="linkbtn" data-clear>Clear the search</button></div>`
    : `<div class="nomatch"><b>No projects yet.</b><br>A project shows here when it has a logbook. Start sage in a project folder to make one.</div>`;
  const chips = projects.filter(book => book.needsOwner && !book.archived).map(book => `<button class="chip" type="button" id="need-${b64(book.key)}" data-pick="${esc(book.key)}" data-provider="${esc(book.providers.map(name => name.toLowerCase().replace(/[^a-z0-9-]/g, "-")).join(" "))}" title="${esc(book.name)} · ${esc(sub(book))}">${dot(ctx, book.key)}<span class="cn">${esc(book.name)}</span> <span class="badge"><span data-n>${book.needsOwner}</span><span class="vh"> need you</span></span></button>`).join("");
  // On a milestones page, the Needs you chip opens the board with its Needs you filter on; the project chips are the board's only.
  const count = `<span class="count" id="needs-count">${model.counts.needsOwner}</span>`;
  return `<div class="pick">${board ? `<button class="chip need" type="button" data-filter="needs" aria-pressed="false">${ICON}Needs you ${count}</button>` : `<a class="chip need" href="/#needs=1">${ICON}Needs you ${count}</a>`}`
    + `<div class="pickwrap"><button class="trigger" type="button" id="pick-trig" aria-haspopup="listbox" aria-expanded="false" aria-controls="pick-pop"><span class="vh">Project: </span><span class="dot none" id="pick-dot" aria-hidden="true"></span><span class="tname" id="pick-name">All projects</span><span class="archtag" id="pick-arch" hidden>Archived</span><span class="chev" aria-hidden="true">▾</span></button>`
    + `<div class="pop" id="pick-pop" hidden><div class="search"><input id="pick-q" type="text" role="combobox" aria-expanded="true" aria-controls="pick-list" aria-autocomplete="list" aria-label="Find a project" placeholder="Find a project: name, repo or folder" autocomplete="off" spellcheck="false"><button type="button" class="closebtn" data-close aria-label="Close the project list"><span class="kbd">Esc</span><span class="tap">Close</span></button></div>`
    + `<div class="list"><ul class="opts" role="listbox" id="pick-list" aria-label="Projects">${items}</ul>${after}</div><div class="vh" id="pick-say" role="status" aria-live="polite"></div><div class="foot"><span>↑ ↓ to move · Enter to choose</span><span>“/” opens</span></div></div></div>`
    + (board ? `<button class="chip" type="button" id="pick-all" data-pick="" hidden>All projects</button><span class="pickchips" id="pick-chips">${chips ? `<span class="vh">Projects that need you:</span>${chips}` : ""}</span>` : "") + "</div>";
}

/** The filter bar (T305 decision 4): who holds the task (a source's provider), its priority and its kind. */
/** The milestones that the pages show: those of projects that are not archived, as the chat board does. */
const shownMilestones = model => (model.milestones ?? []).filter(milestone => !milestone.archived);
/** A milestone's name in a list of milestones of many projects: its project when milestones of two projects show, its logbook when one project has milestones in two (C4). */
function milestoneWhere(model) {
  const milestones = shownMilestones(model), groups = new Set(milestones.map(milestone => milestone.group));
  return milestone => [groups.size > 1 ? milestone.projectName : "", milestones.some(other => other !== milestone && other.group === milestone.group && other.project !== milestone.project) ? `${title(milestone.sourceLabel)} logbook` : ""].filter(Boolean).join(" · ");
}
/**
 * The Milestone filter (T233): each milestone that has or had tasks on the board (not a dropped one with no task left, unless a card of it shows), and
 * No milestone. Its value is the base64url of the milestone's key, never its name. A done milestone's option carries why no card
 * shows and the link to its page (QD). A milestones table that cannot be read leaves the filter off, and says so.
 */
function milestoneFilter(ctx, model) {
  const where = milestoneWhere(model), onBoard = milestone => milestone.tasks.some(key => ctx.tasks.get(key)?.visible && ctx.tasks.get(key).column);
  const milestones = shownMilestones(model).filter(milestone => milestone.state !== "dropped" || milestone.open || onBoard(milestone));
  if (!milestones.length) return (model.milestoneNeeds ?? []).some(need => need.kind === "milestones") ? `<label class="f">Milestone <select disabled><option>Cannot be read</option></select></label>` : "";
  const why = milestone => onBoard(milestone) ? "A filter hides its tasks." : milestone.state === "done" ? "Its tasks ended more than 7 days ago, and the board shows the last 7 days of Done." : "None of its tasks is on the board now.";
  const option = milestone => `<option value="${b64(milestone.key)}" data-project="${esc(milestone.group)}" data-why="${esc(why(milestone))}" data-href="${esc(milestoneHref(ctx, milestone.key))}">${esc(milestone.id)} ${esc(milestone.name)}${milestone.state === "done" ? " (done)" : ""}${where(milestone) ? ` · ${esc(where(milestone))}` : ""}</option>`;
  return `<label class="f">Milestone <select id="f-milestone" data-f="milestone"><option value="">Any</option>${milestones.map(option).join("")}<option value="none">No milestone</option></select></label>`;
}
/** Needs you, not on a card (T233): the items that no card holds, each with what to do; a milestone's item links to its page. */
function needStrip(ctx, model) {
  const items = model.milestoneNeeds ?? [];
  if (!items.length) return "";
  // A stuck milestone says its level, its name and why in one line, "Milestone 2: Lead build is stuck: the pilot T21 was abandoned. …" (T374, T390, F-T996-12).
  const stuck = need => need.kind === "stuck" && ctx.milestones.get(need.key);
  const what = need => stuck(need) ? `${need.title}: ${need.text.charAt(0).toLowerCase()}${need.text.slice(1)}` : need.title;
  const item = need => `<li data-need data-project="${esc(need.group)}" data-milestone="${need.milestone ? b64(need.key) : ""}"><span class="ic" aria-hidden="true">${need.milestone ? "◫" : "!"}</span><span class="what">${esc(what(need))} <span class="faint">· ${esc(need.projectName)} · ${esc(title(need.sourceLabel))} logbook</span></span>`
    + `<span class="act">${stuck(need) ? "Answer in the chat." : esc(need.text)}${need.milestone && ctx.milestones.has(need.key) ? ` <a href="${esc(milestoneHref(ctx, need.key))}">Open the milestone</a>` : ""}</span></li>`;
  return `<section class="needstrip" id="needstrip" aria-labelledby="needstrip-h"><h2 id="needstrip-h">${ICON}Needs you, not on a card <span class="n" id="needstrip-n">${items.length}</span></h2><ul>${items.map(item).join("")}</ul></section>`;
}

function filterBar(ctx, model) {
  // Each provider source, then each provider that owns a shared task or holds an old one (T306). An unclaimed task is only under All; no button names the shared root.
  const providers = [...new Map([...model.sources.filter(source => !source.shared).map(source => source.standIn), ...model.tasks.map(task => task.who).filter(Boolean)].map(name => [String(name ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "-"), title(name)])).entries()];
  const select = (name, label, values) => `<label class="f">${label} <select id="f-${name}" data-f="${name}">${values.map(([value, text]) => `<option value="${esc(value)}">${esc(text)}</option>`).join("")}</select></label>`;
  return `<span class="f">Who</span><div class="seg" role="group" aria-label="Who"><button type="button" id="who-all" data-who="" aria-pressed="true">All</button>${providers.map(([key, name]) => `<button type="button" id="who-${esc(key)}" data-who="${esc(key)}" aria-pressed="false">${esc(name)}</button>`).join("")}</div>`
    + select("priority", "Priority", [["", "Any"], ...PRIORITIES.map(value => [value, value]), ["none", "No priority"]])
    + select("kind", "Kind", [["", "Any"], ...TASK_KINDS.map(value => [value, KIND[value][1]])])
    + milestoneFilter(ctx, model)
    + `<button class="linkbtn" type="button" id="f-clear" data-clearf hidden>Clear filters</button>`;
}

/** The live pill, and a hidden status line that announces only a failure (R1023-5). */
const livePill = text => `<span class="livepill" id="live-state"><span class="ld" aria-hidden="true"></span><span class="lt">${esc(text)}</span></span><span class="vh" id="live-alert" role="status"></span>`;
/**
 * The theme switch. The offline snapshot gives each of its pages its own (T378): a page hides the board's header. Any
 * checked switch flips the theme. Without scripts, a flipped snapshot shows a reset button in each other switch's place:
 * it clears every switch of the form "themes", so each page's switch flips the theme back (R1384-2). The checked switch
 * stays, so a second press flips back, and no control hides while it has focus: a reset that a key pressed stays until
 * focus moves (R1481-1).
 */
const THEME_WORDS = '<span class="to-light">Light theme</span><span class="to-dark">Dark theme</span>';
const themeSwitch = (id = "flip", snapshot = false) => `<input type="checkbox" id="${id}" class="vh flip"${snapshot ? ' form="themes"' : ""}><label class="chip theme" for="${id}">${THEME_WORDS}</label>${snapshot ? `<button type="reset" form="themes" class="chip theme unflip">${THEME_WORDS}</button>` : ""}`;
const THEME_SWITCH = themeSwitch();

export function renderBoardHtml(model, { taskKey = null, snapshot = true, live = false, paths = false } = {}) {
  const task = taskKey ? model.tasks.find(task => task.key === taskKey) : null;
  if (taskKey && !task) throw new RangeError("unknown task key");
  const ctx = context(model, snapshot), counts = model.counts, at = hhmm(model.at);
  // Without scripts, a live page keeps this text; the live script changes it at once. Only a failure is announced (R1023-5).
  const pill = livePill(`${snapshot ? "Snapshot" : "Board"} · ${at}`);
  // The theme switch sits in the header or the page bar, so the way back comes before it in focus order (F-T218-14).
  const theme = snapshot && !task ? themeSwitch("flip", true) : THEME_SWITCH;
  let body;
  if (task) body = `<main class="page open" id="${esc(anchor(task))}" aria-label="${esc(task.id)}"><div class="pagebar"><a class="back" href="${snapshot ? "#" : "/"}">← Board</a>${milestoneLink(ctx, task)}${pill}<span class="spacer"></span>${theme}</div><div id="board-content" data-at="${esc(at)}">${banners(model)}${page(ctx, task, { routed: true })}</div></main>`;
  else {
    const summary = `<div class="summary" id="board-summary"><span><b class="needn" id="s-needs">${counts.needsOwner}</b> needs you</span><span><b id="s-agents">${counts.recordedAgents}</b> agents at work</span>${counts.inferredWork ? `<span><b id="s-inferred">${counts.inferredWork}</b> inferred PRs</span>` : ""}<span><b id="s-review">${counts.inReview}</b> in review</span><span><b id="s-tasks">${counts.tasks}</b> tasks</span><span>built ${esc(day(model.at))} UTC</span></div>`;
    // No task at all, archived ones included: the board is new. Tasks only in archived projects: one line says so.
    const empty = !model.tasks.length ? `<div class="emptyboard"><b>No tasks recorded yet.</b> The board reads the logbooks. Frame a task in a sage session, and it shows here.</div>`
      : model.tasks.every(task => task.archived) ? `<div class="emptyboard"><b>All tasks are in archived projects.</b> The Archived group below counts them.</div>` : "";
    const nomatch = `<div class="emptyboard" id="nomatch" hidden><b>No task matches.</b> No visible task fits this filter. <button class="linkbtn" type="button" data-reset>Show all tasks</button></div>`;
    const noprog = `<div class="emptyboard" id="noprog" hidden><b>No task of <span id="noprog-name"></span> shows on the board.</b> <span id="noprog-why"></span> <a id="noprog-link" href="">Open the milestone</a> · <button class="linkbtn" type="button" data-reset>Show all tasks</button></div>`;
    const noprov = `<div class="emptyboard" id="noprov" hidden><b>No <span id="noprov-who"></span> logbook in this project.</b> <span id="noprov-name"></span> has tasks only in <span id="noprov-has"></span>. <button class="linkbtn" type="button" data-showall>Show all providers</button></div>`;
    const gone = `<div role="status"><div class="banner info" id="gone" hidden><div>The project that you chose before has no logbook now. The board shows all projects. <button class="linkbtn" type="button" data-dismiss>Dismiss</button></div></div></div>`;
    body = `<div class="boardview"><header>${snapshot ? `<h1>Task board</h1>${model.milestones?.length || releasesTab(model) ? pagesNav("board", model, true) : ""}` : `<h1>Sage board</h1>${pagesNav("board", model)}`}${pill}<span class="spacer"></span>${theme}${picker(ctx, model, paths)}</header><div class="fbar" id="board-filters" role="group" aria-label="Filters">${filterBar(ctx, model)}</div>${summary}<div id="board-content" data-at="${esc(at)}">${banners(model)}${needStrip(ctx, model)}${gone}${whereHtml(ctx)}${empty}${nomatch}${noprog}${noprov}<main class="board" data-scroll="board">${model.columns.map(col => column(ctx, col)).join("")}</main>${archivedGroup(model)}${legend(ctx)}</div></div>`
      // Offline, the task pages, the milestones list and each milestone's page are sections of the one file (C9).
      + (snapshot ? `<form id="themes" hidden></form><div id="pages">${model.tasks.map(task => page(ctx, task)).join("")}${releasesTab(model) ? `<section class="page" id="releases" aria-label="Releases"><div class="pagebar"><a class="back" href="#">← Board</a><span class="spacer"></span>${themeSwitch("flip-releases", true)}</div>${releasesList(ctx, model, false)}</section>` : ""}${model.milestones?.length ? `<section class="page" id="milestones" aria-label="Milestones"><div class="pagebar"><a class="back" href="#">← Board</a><span class="spacer"></span>${themeSwitch("flip-milestones", true)}</div>${milestonesList(ctx, model, false)}</section>` : ""}${(model.milestones ?? []).map(milestone => `<section class="page" id="${esc(milestoneAnchor(milestone.key))}" aria-label="${esc(milestone.id)}">${milestonePage(ctx, milestone, false)}</section>`).join("")}</div>` : "");
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${task ? `${esc(task.id)} · ` : ""}Sage task board</title><script>${THEME_HEAD}</script><style>${CSS}</style></head><body>${body}<script>${BOARD_ENHANCEMENT}${live ? liveScript(taskKey ? `/?events=1&task=${b64(taskKey)}` : "/?events=1") : ""}</script></body></html>`;
}

/**
 * The pages of the served board, as links (T308, T233, T996): "Task board | Releases | Milestones | Agents (n)". The count is
 * the running agents. The Releases tab shows only when a logbook has releases, or a table that cannot be read hides them. Offline, the board, its releases and its milestones list.
 */
const pagesNav = (current, model, snapshot = false) => {
  const tab = (href, key, name) => `<a href="${href}"${current === key ? ' aria-current="page"' : ""}>${name}</a>`, releases = releasesTab(model) || current === "releases";
  return `<nav class="boardtabs" id="board-pages" aria-label="Board pages">${snapshot ? tab("#", "board", "Task board") + (releases ? tab("#releases", "releases", "Releases") : "") + (model.milestones?.length ? tab("#milestones", "milestones", "Milestones") : "")
    : tab("/", "board", "Task board") + (releases ? tab("/releases", "releases", "Releases") : "") + tab("/milestones", "milestones", "Milestones") + tab("/agents", "agents", `Agents (${model.agents?.count ?? 0})`)}</nav>`;
};

// The Agents page (T308 layout A, approved 2026-10-18): one box per project with its cap, a lead's helpers under it,
// the projects and the rows that need a look first. Each state has a mark and a word, never colour alone.
const AGENT_STATE = { stuck: ["!", "may be stuck"], stop: ["■", "helper stopped, run still open"], long: ["▲", "running long"], wait: ["◷", "waiting for its helpers"], work: ["●", "working"], unk: ["○", "running"] };
const agentState = value => AGENT_STATE[value] ? value : "unk";
const minutesText = ms => { const m = Math.max(0, Math.floor(ms / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`; };
const PROVIDER_TAGS = ["claude", "codex"];
const capBar = (used, cap) => `<span class="bar" aria-hidden="true">${Array.from({ length: Math.min(cap, 50) }, (_, i) => `<i${i < used ? ' class="on"' : ""}></i>`).join("")}</span>`;
const capText = (name, used, cap, bar = true) => `<span class="cap${used >= cap ? " full" : ""}">${bar ? capBar(used, cap) : ""}${esc(name)} ${used} of ${cap}${used >= cap ? " · at cap" : ""}</span>`;

function agentRow(agent, live, child) {
  const state = agentState(agent.state), [mark, word] = AGENT_STATE[state];
  const flag = ["stuck", "stop"].includes(state) ? " flag" : state === "long" ? " flagw" : "";
  const prov = agent.provider.toLowerCase();
  const task = agent.task;
  const link = task?.key && live ? `<a class="t" id="al-${b64(agent.key)}" href="${route(task)}"><span class="id">${esc(task.id)}</span> ${esc(task.title)}</a>`
    : task ? `<span class="t"><span class="id">${esc(task.id)}</span> ${esc(task.title)}</span>` : `<span class="faint">${agent.runId ? `Run ${esc(agent.runId)} is not a running run in the logbook.` : "No run recorded: the agent's brief named no run."}</span>`;
  const prio = task?.priority ? `<span class="tag prio" title="${task.priority}, ${PRIORITY_WORD[task.priority]}">${task.priority}<span class="vh">, ${PRIORITY_WORD[task.priority]}</span></span>` : "";
  const facts = [agent.model ? `model ${esc(agent.model)}` : "", agent.running === null ? "time running not known" : `running ${minutesText(agent.running)}`, `last activity ${agent.idle === null ? "not recorded" : agent.idle < 60000 ? "just now" : `${minutesText(agent.idle)} ago`}`].filter(Boolean);
  return `<div class="arow${child ? " child" : ""}${flag}"><div class="amain"><div class="l1"><span class="ptag ptag-${known(PROVIDER_TAGS, prov)}">${esc(title(agent.provider))}</span><span class="role">${esc(agent.role)}</span>${agent.runId ? `<span class="id">${esc(agent.runId)}</span>` : ""}${child ? `<span class="faint">helper of ${esc(agent.lead)}</span>` : ""}</div>`
    + `<div class="l2">${link}${prio}${task ? kindTag(task) : ""}</div><div class="l3">${facts.map(fact => `<span>${fact}</span>`).join("")}</div></div>`
    + `<div class="rside"><span class="st st-${state}"><span class="m" aria-hidden="true">${mark}</span>${word}</span>${agent.why ? `<span class="awhy">${esc(agent.why)}</span>` : ""}</div></div>`;
}
const agentItem = (agent, live) => `<li>${agentRow(agent, live, false)}${agent.children.length ? `<ul aria-label="Helpers of ${esc(agent.runId ?? agent.role)}">${agent.children.map(kid => `<li>${agentRow(kid, live, true)}</li>`).join("")}</ul>` : ""}</li>`;

/** The Agents page: the totals and caps, the notes, one box per project, and how each state is decided. */
export function renderAgentsHtml(model, { live = false, paths = false } = {}) {
  const agents = model.agents, at = hhmm(model.at);
  const pill = livePill(`Board · ${at}`), theme = THEME_SWITCH;
  const totals = `<div class="summary"><span><b>${agents.count}</b> agent${agents.count === 1 ? "" : "s"} running</span>${agents.providers.length ? `<span>${agents.providers.map(p => `<b>${p.count}</b> ${esc(p.name)}`).join(" · ")}</span>` : ""}${agents.look ? `<span><b class="needn">${agents.look}</b> need${agents.look === 1 ? "s" : ""} a look</span>` : ""}<span>built ${esc(day(model.at))} UTC</span></div>`;
  const caps = agents.problems.length ? `<div class="caps">Caps: not known while the hook notes cannot be read.</div>`
    : agents.caps.map(entry => `<div class="caps" aria-label="Agent caps, ${esc(entry.label)} agents"><span>Caps (${esc(entry.label)} agents):</span>${entry.projects.map(project => capText(project.name, project.used, project.cap)).join("")}${capText("total", entry.total.used, entry.total.cap, false)}</div>`).join("");
  const problems = agents.problems.length ? `<div class="banner warn">${ICON}<div><b>The hook notes cannot be read</b> (${agents.problems.map(p => `${esc(p.source)}: ${esc(p.message)}`).join("; ")}). The page shows runs from the logbooks only, with no last activity and no helpers. Caps are not known.</div></div>` : "";
  const unmatched = agents.unmatched.length ? `<div class="banner warn">${ICON}<div><b>${agents.unmatched.length} run${agents.unmatched.length === 1 ? " has" : "s have"} no hook record.</b> The logbook says ${agents.unmatched.map(item => `${esc(item.run)} (${esc(item.project)})`).join(", ")} ${agents.unmatched.length === 1 ? "runs" : "run"}, but no agent slot holds ${agents.unmatched.length === 1 ? "it" : "them"}. Each row stays, marked "may be stuck", until the chief ends the run.</div></div>` : "";
  const box = project => `<section class="group" aria-labelledby="g-${b64(project.key)}"><div class="ghead"><h2 id="g-${b64(project.key)}">${esc(project.name)}</h2>${paths && project.pathSub ? `<span class="faint">${esc(project.pathSub)}</span>` : project.pathSub ? `<span class="faint">${esc(project.sub)}</span>` : ""}<span class="n">${project.count} running</span>${project.cap ? `<span class="gcap">${capText(`${project.cap.label} cap`, project.cap.used, project.cap.cap)}</span>` : ""}</div><ul class="alist">${project.agents.map(agent => agentItem(agent, live)).join("")}</ul></section>`;
  const rules = agents.rules, list = agents.count ? `<div class="wrap">${agents.projects.map(box).join("")}</div>`
    : `<div class="emptyboard"><b>No agent runs now.</b> When the chief starts an agent in any project, it shows here within a few seconds. The ${live ? '<a href="/">Task board</a>' : "Task board"} shows what comes next.</div>`;
  const how = `<section class="rules" aria-label="How the page decides each state"><h2>How each state is decided</h2><ul>`
    + `<li><b>${AGENT_STATE.work[0]} working</b>: the hook saw the agent in the last ${rules.quiet} min.</li>`
    + `<li><b>${AGENT_STATE.wait[0]} waiting for its helpers</b>: a lead with at least one helper that still runs. A quiet lead is normal then.</li>`
    + `<li><b>${AGENT_STATE.stuck[0]} may be stuck</b>: no activity for ${rules.quiet} min or more, and no running helper; or the logbook says the run runs, and no agent slot holds it (the hook frees a slot after 60 min with no activity).</li>`
    + `<li><b>${AGENT_STATE.long[0]} running long</b>: the time running is more than ${rules.factor} times the median of the same role's ended runs in this project (it needs ${rules.basis} ended runs).</li>`
    + `<li><b>${AGENT_STATE.stop[0]} helper stopped, run still open</b>: the hook saw the helper stop, but the logbook still says the run runs. The chief must end the run.</li>`
    + `<li><b>${AGENT_STATE.unk[0]} running</b>: the logbook says the run runs, and no activity is recorded (Codex sends no activity notes yet).</li></ul></section>`;
  const body = `<div class="boardview"><header><h1>Sage board</h1>${live ? pagesNav("agents", model) : ""}${pill}<span class="spacer"></span>${theme}</header>`
    + `<div id="board-content" data-at="${esc(at)}">${totals}${caps}${banners(model)}${problems}${unmatched}<main class="agentsview">${list}</main>${how}</div></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sage agents</title><script>${THEME_HEAD}</script><style>${CSS}</style></head><body>${body}<script>${BOARD_ENHANCEMENT}${live ? liveScript("/agents?events=1", ["board-content", "board-pages"]) : ""}</script></body></html>`;
}

// The milestones pages (T233, the approved design of R1284): the milestones list, and one page for each milestone.
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const MET_WORDS = ["merged", "concluded"], ENDED_STATES = [...MET_WORDS, "abandoned"], NEEDS_MILESTONE = ["proposed", "stuck", "lost"];
const roles = task => task ? [...new Set(task.agents.filter(agent => !agent.stale).map(agent => agent.role))] : [];
const lostText = milestone => `${lostWhy(milestone)}. Ask the chief to repair the logbook, or to propose ${milestone.id} again.`;
/** What moves next in an active milestone (Q4): the first task with no unmet wait, then the count of the tasks that wait and those that cannot start. */
function nextOf(ctx, milestone) {
  const task = milestone.next && ctx.tasks.get(milestone.next.key), at = roles(task);
  return { first: task, html: (task ? `${esc(task.id)}${milestone.next.pilot ? " (pilot)" : ""}: ${esc(milestone.next.word)}${at.length ? `, the ${esc(at.join(" and the "))} at work` : ""}.` : "No task can move now.")
    + (milestone.waiting ? ` <span class="faint">${milestone.waiting} more ${milestone.waiting === 1 ? "waits" : "wait"}.</span>` : "")
    + cannotHtml(milestone) };
}
const cannotHtml = milestone => milestone.cannotStart.length ? ` <span class="stw-cant">${esc(milestone.cannotStart.join(", "))} cannot start.</span>` : "";
// A proposed or changing milestone still names its tasks that cannot start, so its approval does not hide a stuck wait (R1551-2).
const BEFORE_APPROVAL = ["proposed", "changing"];
const droppedNext = milestone => milestone.open ? `${plural(milestone.open, "task")} still in it: ask the chief to take each task out of the milestone.` : "No task is in it.";
/** The line under a milestone in the list, by its state: what you do, what the sage does, or what moves next. A changing milestone is a line here, not an item of Needs you (QB). */
function milestoneNext(ctx, milestone) {
  const fixed = {
    proposed: `The breakdown waits for you. Open it to see the ${plural(milestone.progress.total, "task")}, then answer in the chat.`,
    stuck: milestone.need?.text ?? `The pilot ${milestone.pilot} cannot run. Choose a new pilot, or drop the milestone.`,
    lost: lostText(milestone),
    changing: `You asked for changes (gate ${milestone.gate}). The chief revises the breakdown and proposes it again.`,
    done: "Nothing: every task that is not abandoned is merged or concluded.",
    dropped: droppedNext(milestone),
  }[milestone.state];
  // A stuck milestone's line says what you do next, as the prototype labels it (T374).
  return fixed === undefined ? `<b>Next:</b> ${nextOf(ctx, milestone).html}` : `${milestone.state === "stuck" ? "<b>Next:</b> " : ""}${esc(fixed)}${BEFORE_APPROVAL.includes(milestone.state) ? cannotHtml(milestone) : ""}`;
}
function milestoneRow(ctx, milestone, where) {
  const approval = milestone.state === "proposed", needs = NEEDS_MILESTONE.includes(milestone.state);
  const meta = [`pilot ${milestone.pilot}`, plural(milestone.progress.total, "task"), title(milestone.sourceLabel), where(milestone)].filter(Boolean).join(" · ");
  return `<li data-project="${esc(milestone.group)}"><a class="prog${approval ? " approval" : needs ? " needs" : ""}" href="${esc(milestoneHref(ctx, milestone.key))}">${approval ? `<div class="band"><span aria-hidden="true">◫</span>Milestone approval<span class="bk">· gate ${esc(milestone.gate)}</span></div>` : ""}`
    + `<div class="ph"><h3><span aria-hidden="true">◫</span> ${esc(milestone.name)}</h3><span class="id">${esc(milestone.id)}</span>${wordTag(milestone.word, "pstate")}<span class="pmeta">${esc(meta)}</span></div>`
    + `${milestone.goal ? `<p class="goal">${esc(milestone.goal)}</p>` : ""}${milestone.progress.total ? pbar(milestone) : ""}<div class="nx${needs ? " need" : ""}">${milestoneNext(ctx, milestone)}</div></a></li>`;
}
/** The milestones list: Needs you, Active (with the changing ones), Done, and Dropped folded. */
function milestonesList(ctx, model, routed) {
  const milestones = shownMilestones(model), where = milestoneWhere(model), h = routed ? "h1" : "h2";
  const head = `<${h} class="ptitle">Milestones</${h}>`;
  const broken = (model.milestoneNeeds ?? []).filter(need => need.kind === "milestones").map(need => `<div class="banner warn">${ICON}<div><b>The milestones of ${esc(need.projectName)} cannot be read.</b> ${esc(need.text)} The <a href="${ctx.snapshot ? "#" : "/"}">task board</a> still shows every task, without its milestone.</div></div>`).join("");
  if (!milestones.length && model.milestones?.length) return head + broken + `<div class="emptyboard"><b>Every milestone is in an archived project.</b> The list shows the milestones of the projects that are not archived. A task of an archived project still links to its milestone's page.</div>`;
  if (!milestones.length) return head + broken + (broken ? "" : `<div class="emptyboard"><b>No milestones yet.</b> A milestone starts when you ask for work that needs two or more tasks, where one task waits for another. The chief then proposes a breakdown, and it shows in Needs you for your approval.</div>`);
  const group = ([name, states]) => {
    const list = milestones.filter(milestone => states.includes(milestone.state));
    return list.length ? `<h2 class="grp">${name} <span class="n">${list.length}</span></h2><ul class="plist" data-plist>${list.map(milestone => milestoneRow(ctx, milestone, where)).join("")}</ul>` : "";
  };
  const dropped = milestones.filter(milestone => milestone.state === "dropped");
  const none = `<div class="emptyboard" id="nomilestones" hidden><b>No milestone in this project.</b> <button class="linkbtn" type="button" data-reset>Show all projects</button></div>`;
  return head + broken + none + [["Needs you", NEEDS_MILESTONE], ["Active", ["active", "changing"]], ["Done", ["done"]]].map(group).join("")
    + (dropped.length ? `<details class="fold" data-key="dropped"><summary id="sum-dropped">Dropped (<span class="n">${dropped.length}</span>)</summary><ul class="plist" data-plist>${dropped.map(milestone => milestoneRow(ctx, milestone, where)).join("")}</ul></details>` : "");
}
/** One task of a milestone on its page: its state word, and its waits, agents, PR, priority and kind under it. */
function milestoneTask(ctx, task) {
  const ab = task.state === "abandoned", cant = !ab && task.waitLine?.never, needs = task.reasons.length > 0;
  // A task that waits for the breakdown waits for the pilot after it, as the prototype says: "waits for T30 (pilot, not started)",
  // and only once when its waits cell names the pilot too. A breakdown that is never met (dropped or lost) is named itself,
  // and so is a wait for a pilot that is never met (abandoned): that task cannot start (R1368-2).
  const milestone = ctx.milestones.get(task.milestone?.key), pilot = milestone && !task.milestone.pilot && ctx.tasks.get(`${milestone.project}/${milestone.pilot}`);
  const ownPilot = pilot && task.waits.find(wait => wait.id === pilot.id), viaPilot = !!pilot && !ownPilot?.never && task.waits.some(wait => wait.breakdown && !wait.never);
  const waits = task.waits.filter(wait => !(wait.breakdown && (!pilot || !wait.never && !viaPilot)) && !(wait.pilot && wait.met) && !(viaPilot && wait === ownPilot)).map(wait => wait.odd ? "⊘ its waits cell has text that is not a task id"
    : wait.breakdown ? wait.never ? `⊘ waits for the breakdown of ${milestoneName({ id: wait.breakdown.id }, true)}: ${breakdownWhy(wait.breakdown)}` : `⧗ waits for ${pilot.id} (pilot, ${pilot.word})`
    : wait.met ? `✓ waits for ${wait.id}, ${wait.word}` : `${wait.never ? "⊘" : "⧗"} waits for ${wait.id} (${wait.word})${wait.never ? ": it cannot start" : ""}`);
  const at = roles(task), sub = [task.milestone?.pilot ? "pilot" : "", ...waits, at.length ? `${at.join(", ")} at work` : "", task.pr ? `PR ${task.pr}` : "", task.priority, task.kind ? KIND[task.kind][1] : ""].filter(Boolean);
  return `<div class="trow${ab ? " ab" : ""}${cant ? " cant" : ""}${needs ? " needs" : ""}"><span class="id">${esc(task.id)}</span><a class="t" href="${esc(taskHref(ctx, task))}">${esc(task.title)}</a>${wordTag(task.word)}${sub.length ? `<span class="sub">${esc(sub.join(" · "))}</span>` : ""}</div>`;
}
/** A decision as one line: a breakdown gate's answer keeps its first line and the answer. */
function decisionText(ctx, project, text) {
  const lines = text.split(LINE), answer = answerOf(ctx, project, text);
  return lines.length > 1 && answer !== null ? `${lines[0]} … → ${answer}` : lines[0];
}
/**
 * The answer of a breakdown gate's decision row ("<question> → <answer>"): the text after the gate's own question, so
 * the owner's own words keep each " → " in them (F-T384-1). Without the gate's row, the text after the first arrow on
 * the last line: a breakdown question has more than one line and an answer has none, so a waits-for arrow in the
 * question and an arrow in the answer both stay (R1481-2). null when that line has no arrow.
 */
function answerOf(ctx, project, text) {
  const question = ctx.milestones.get(`${project}/${proposalOf({ question: text }, ctx.renamed.get(project))}`)?.questions.find(asked => text.startsWith(`${asked} → `)), arrow = text.indexOf(" → ", text.lastIndexOf(LINE) + 1);
  return question !== undefined ? text.slice(question.length + 3) : arrow >= 0 ? text.slice(arrow + 3) : null;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A short date, "12 Oct", from an ISO time; the full time is the title. */
const shortDay = iso => {
  const [, y, m, d] = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? "")) ?? [], date = new Date(Date.UTC(y, m - 1, d));
  // A day that the month does not have, such as 2026-02-30, is not a date (R1378-3).
  return y && date.getUTCMonth() === m - 1 && date.getUTCDate() === Number(d) ? `${Number(d)} ${MONTHS[m - 1]}` : "";
};
// The reasons that the state tool writes itself say nothing to the owner, so the short form leaves them out.
/** The why of a proposal's rows; program propose wrote them before the rename (T995). */
const PROPOSE_WHY = ["milestone propose", "program propose"];
const TOOL_WHY = ["", "task set", ...PROPOSE_WHY, "the user's answer", "the user's own words"];
/** A milestone's ids as alternatives of a regular expression: its id, and its id from before the rename (T995), which older rows name. */
const idsOf = milestone => [milestone.id, milestone.was].filter(Boolean).join("|");
/**
 * A milestone's decision in the prototype's short form (T374): "T9 merged: PR 66", "M1 proposed: Codex support, pilot T7,
 * gate G7", "G7 answered: approve", "T5 joined M1". Any other decision keeps its own words, after its task. A proposal
 * writes its own row on the pilot and a move row for each other task that it takes in: its own row is its one line, so
 * those move rows show nothing (null) (R1368-1). A later round names no tasks, so its move rows show (R1375-3). The
 * rounds: each proposal row of the milestone, by round, with its time and gate; an answer names the gate of its own round.
 */
function decisionLine(ctx, milestone, row, task, rounds) {
  const why = TOOL_WHY.includes(String(row.why ?? "")) ? "" : String(row.why), text = String(row.decision), because = line => why ? `${line}: ${why}` : line;
  const state = /^state (merged|concluded|abandoned)$/.exec(text), moved = /^(?:milestone|program) (\S+) → (\S+)$/.exec(text), arrow = text.includes(" → ");
  const proposed = proposal(milestone, row), answer = arrow && new RegExp(`^Approve (?:milestone|program) (?:${idsOf(milestone)})(?: \\(round ([1-9]\\d*)\\))?\\?`).exec(text);
  const own = id => id === milestone.id || id === milestone.was;
  if (state) return because(`${row.id}${row.id === milestone.pilot ? " (pilot)" : ""} ${state[1]}${!why && state[1] === "merged" && task.pr ? `: PR ${task.pr}` : ""}`);
  // An older round's row has no name, so its line has none; the milestone's name is the name of its latest round (R1375-4).
  if (proposed) return proposed.round > 1 ? `${milestone.id} proposed again: ${proposed.gate === milestone.gate ? `${milestone.name}, ` : ""}gate ${proposed.gate}, round ${proposed.round}` : `${milestone.id} proposed: ${proposed.name}, pilot ${proposed.pilot}, gate ${proposed.gate}`;
  if (moved && PROPOSE_WHY.includes(row.why) && own(moved[2]) && rounds.get(1)?.at === row.at) return null;
  if (moved) return because(`${row.id} ${own(moved[2]) ? "joined" : "left"} ${milestone.id}`);
  if (answer) { const gate = rounds.get(Number(answer[1] ?? 1))?.gate; return `${gate ?? `${milestone.id}${answer[1] ? ` round ${answer[1]}` : ""}`} answered: ${answerOf(ctx, milestone.project, text)}`; }
  return because(`${row.id}: ${decisionText(ctx, milestone.project, text)}`);
}
/** A proposal row of the milestone, in the forms that the state tool's milestone propose writes, or null. */
function proposal(milestone, row) {
  const m = PROPOSE_WHY.includes(row.why) && new RegExp(`^(?:${idsOf(milestone)}) proposed (?:with gate (G[1-9]\\d*), pilot (\\S+), tasks \\S+, name: (.*)|again with gate (G[1-9]\\d*), round ([1-9]\\d*))$`).exec(String(row.decision));
  return m ? (m[1] ? { round: 1, gate: m[1], pilot: m[2], name: m[3], at: row.at } : { round: Number(m[5]), gate: m[4], at: row.at }) : null;
}
/** A milestone's page: its goal and progress (or its breakdown while it waits for you), what moves next, its tasks in order, and its latest decisions. */
function milestonePage(ctx, milestone, routed) {
  const tasks = milestone.tasks.map((key, i) => [ctx.tasks.get(key), milestone.depths[i]]).filter(([task]) => task), own = tasks.map(([task]) => task);
  const pilot = ctx.tasks.get(`${milestone.project}/${milestone.pilot}`), { total, abandoned } = milestone.progress, h = routed ? "h1" : "h2";
  const onBoard = milestone.archived ? "" : `<a class="back" href="${ctx.snapshot ? "" : "/"}#${esc(new URLSearchParams({ p: milestone.group, pg: b64(milestone.key) }))}">Its tasks on the board</a>`;
  const top = `<div class="pagebar"><a class="back" href="${ctx.snapshot ? "#milestones" : "/milestones"}">← Milestones</a>${onBoard}${ctx.snapshot ? `<span class="spacer"></span>${themeSwitch(`flip-${milestoneAnchor(milestone.key)}`, true)}` : ""}</div>`
    + `<div class="ptop"><span class="id">${esc(milestone.id)}</span> · ${project(ctx, milestone)} · ${wordTag(milestone.word, "pstate")} · <span class="faint">${esc(title(milestone.sourceLabel))} logbook</span></div>`
    + `<${h} class="ptitle"><span aria-hidden="true">◫</span> ${esc(milestone.name)}</${h}>`;
  let lead;
  if (milestone.state === "proposed") {
    // QF: the gate's own lines, as the sage stored them; the band comes from data (Q1).
    const reason = pilot?.reasons.find(item => item.breakdown?.key === milestone.key);
    lead = `<section class="wide card approval"><div class="band"><span aria-hidden="true">◫</span>Milestone approval<span class="bk">· gate ${esc(milestone.gate)} · the pilot ${esc(milestone.pilot)}</span></div>`
      + `${breakdownBody(reason)}</section>`;
  } else {
    const pilotLine = `<p><b>Pilot:</b> ${pilot ? `<a href="${esc(taskHref(ctx, pilot))}">${esc(pilot.id)}</a> ${esc(pilot.title)} · ${wordTag(pilot.word, "pw")}${roles(pilot).length ? ` · the ${esc(roles(pilot).join(" and the "))} at work` : ""}` : `${esc(milestone.pilot)} · <span class="stw-cant">not in the logbook</span>`}</p>`;
    const rule = { dropped: `You dropped the breakdown (gate ${milestone.gate}).`, changing: `You asked for changes (gate ${milestone.gate}). The chief revises the breakdown and proposes it again.`, lost: "" }[milestone.state]
      ?? `Approved total: ${plural(total, "task")} (gate ${milestone.gate}). Done when every task that is not abandoned is merged or concluded${abandoned.length ? `: ${total - abandoned.length} of the ${total}` : ""}.`;
    lead = `<section class="wide"><h3>Goal and progress</h3>${milestone.goal ? `<p>${esc(milestone.goal)}</p>` : ""}${total ? `${pbar(milestone)}<div class="pkey" aria-hidden="true"><span><i class="m"></i>merged</span><span><i class="a"></i>abandoned</span><span><i class="o"></i>open</span></div>` : ""}${pilotLine}${rule ? `<p class="faint">${esc(rule)}</p>` : ""}</section>`;
    // "T13 can start when T12 merges.": each task that waits for the task that moves next, with each of its unmet waits.
    const next = nextOf(ctx, milestone), then = next.first ? (ctx.waitedBy.get(next.first.key) ?? []).filter(task => task.milestone?.key === milestone.key && !ENDED_STATES.includes(task.state) && !task.waitLine?.never)
      .map(task => { const ids = task.waits.filter(wait => !wait.met && wait.id).map(wait => wait.id); return `${task.id} can start when ${ids.join(" and ")} ${ids.length === 1 ? "merges" : "merge"}.`; }) : [];
    const moving = own.filter(task => task !== next.first && !ENDED_STATES.includes(task.state) && !task.waitLine);
    // "T11 cannot start: it waits for T10, which was abandoned." Each wait that is never met, in the prototype's words; odd
    // text in the waits cell is its own clause, "its waits cell has text that is not a task id" (R1391-2).
    const never = wait => wait.breakdown ? `the breakdown of ${milestoneName({ id: wait.breakdown.id }, true)}: ${breakdownWhy(wait.breakdown)}` : wait.loop ? `${wait.id}, in a loop of waits that never ends` : `${wait.id}, which ${wait.state ? `was ${wait.word}` : "is not in the logbook"}`;
    const why = task => { const named = task.waits.filter(wait => wait.never && !wait.odd).map(never), odd = task.waits.some(wait => wait.odd);
      return [named.length && `it waits for ${named.join(" and ")}`, odd && "its waits cell has text that is not a task id"].filter(Boolean).join(", and "); };
    const cannot = own.filter(task => task.waitLine?.never && !ENDED_STATES.includes(task.state)).map(task => `<div class="waitline cant"><span class="wm" aria-hidden="true">⊘</span><span>${esc(task.id)} cannot start: ${esc(why(task))}. Ask the chief to ${task.waits.some(wait => wait.odd) ? "set its waits again" : "remove the wait"}, or to drop ${esc(task.id)}.</span></div>`).join("");
    const body = {
      stuck: () => `<div class="nowline need">${ICON}<span><b>Needs you:</b> ${esc(milestone.need?.text ?? "")}</span></div><div class="answer"><b>Answer in the chat:</b> a new pilot (a task of the milestone), or drop the milestone.</div>`,
      lost: () => `<div class="nowline need">${ICON}<span><b>Needs you:</b> ${esc(lostText(milestone))}</span></div>`,
      changing: () => `<div class="nowline"><span><b>Now:</b> the chief revises the breakdown. No task builds before you approve the new one.</span></div>`,
      done: () => `<div class="nowline"><span>Nothing: every task that is not abandoned is merged or concluded.</span></div>`,
      dropped: () => milestone.open ? `<div class="nowline"><span>${esc(droppedNext(milestone))}</span></div>` : "",
      active: () => `<div class="nowline"><span><b>Now:</b> ${next.html}</span></div>${then.length ? `<div class="nextline"><b>Then:</b> ${esc(then.join(" "))}</div>` : ""}${cannot}${moving.length ? `<div class="nextline">Also moving: ${esc(moving.map(task => `${task.id} (${task.word})`).join(", "))}.</div>` : ""}`,
    }[milestone.state];
    const said = body?.();
    if (said) lead += `<section class="wide"><h3>Next</h3>${said}</section>`;
  }
  const max = Math.max(0, ...tasks.map(([, depth]) => depth)), hasPilot = !!pilot;
  const head = depth => depth === 0 ? hasPilot ? "1 · The pilot: it runs end to end first" : "1 · First" : depth === 1 && hasPilot ? "2 · After the pilot merges" : `${depth + 1} · After the tasks above that they wait for`;
  const layers = Array.from({ length: max + 1 }, (_, depth) => tasks.filter(([, d]) => d === depth)).map((list, depth) => list.length ? `<li class="layer"><h4>${head(depth)}</h4>${list.map(([task]) => milestoneTask(ctx, task)).join("")}</li>` : "").join("");
  const order = total ? `<section><h3>Tasks in order <span class="n">${total}</span></h3><ol class="layers">${layers}</ol><p class="faint">The order: the pilot first, then each task after the tasks that it waits for, then by number.</p></section>` : `<section><h3>Tasks in order</h3><div class="empty">No task is in it.</div></section>`;
  // The latest decisions of its tasks that name the milestone, move a task in or out, or end a task.
  const named = new RegExp(`\\b(?:${idsOf(milestone)})\\b`);
  const rounds = new Map(own.flatMap(task => task.decisions.map(row => proposal(milestone, row)).filter(Boolean)).map(round => [round.round, round]));
  // The newest first; a row with no valid time goes last, in its own order (R1378-2).
  const dated = row => shortDay(row.at) ? 1 : 0;
  const log = own.flatMap(task => task.decisions.filter(row => named.test(row.decision) || /^state (merged|concluded|abandoned)$/.test(row.decision)).map(row => ({ at: row.at, text: decisionLine(ctx, milestone, { ...row, id: task.id }, task, rounds) })))
    .filter(row => row.text !== null).sort((a, b) => dated(b) - dated(a) || (dated(a) ? String(b.at).localeCompare(String(a.at)) : 0)).slice(0, 8);
  // A time that is not a date gets no date and no title (R1371-4).
  const when = at => shortDay(at) ? `<span class="faint" title="${esc(day(at))} UTC">${esc(shortDay(at))}</span> ` : "";
  const decisions = `<section><h3>Latest decisions</h3>${log.length ? `<ol class="log">${log.map(row => `<li>${when(row.at)}${esc(row.text)}</li>`).join("")}</ol>` : `<div class="empty">No decisions recorded.</div>`}</section>`;
  return `${top}<div class="detail">${lead}<div class="colL">${order}</div><div class="colR">${decisions}</div></div>`;
}

// The releases (T996, the T995 design that the owner approved in gate G141): the "Where we are" frame above the columns
// (option B), in the page's boxes and in the chat's text, and the Releases tab. One frame model gives both forms. A logbook
// with no releases has no entry in model.releases, so its board shows as before.
const ENDS = ["done", "stopped"], WORDS = ["needs you", "in progress", "waiting", "not started", "done", "stopped"], LISTED = 4;
const byWord = (a, b) => WORDS.indexOf(a.word) - WORDS.indexOf(b.word);
const open = item => !!item && !!item.word && (!ENDS.includes(item.word) || item.open > 0);
const doneText = (done, total, stopped) => `${done} of ${plural(total, "task")} done${stopped ? ` · ${stopped} stopped` : ""}`;
const countsText = tasks => WORDS.map(word => [word, tasks.filter(task => task.word === word).length]).filter(([, n]) => n).map(([word, n]) => `${n} ${word}`).join(" · ");
const shownReleases = model => (model.releases ?? []).filter(entry => !entry.archived);
/** The Releases tab shows while a logbook shows releases, or a table that cannot be read hides them: its banner says why (F-T996-40). */
const releasesTab = model => shownReleases(model).length > 0 || (model.milestoneNeeds ?? []).some(need => need.hidesReleases);
/** The releases that the frame shows: each one that is not done or stopped, or the last one when all are. */
const frameReleases = entry => { const live = entry.releases.filter(release => !ENDS.includes(release.word)); return live.length ? live : entry.releases.slice(-1); };

/**
 * What a box of waiting tasks waits for, when each of them waits for the same thing (the design's "Waiting for the
 * presentation skill"): the same tasks, the owner's approval or the new breakdown of their milestone, or nothing that can
 * be met. Else "": the box has its word alone. A task's title is cut, so that no word is wider than the chat's box.
 */
function waitingFor(ctx, items) {
  const why = item => item.waitLine?.never ? "never" : item.waits.find(wait => wait.breakdown && !wait.met)?.breakdown.state ?? item.waits.filter(wait => wait.id && !wait.met).map(wait => wait.id).sort().join(" ");
  const [first, ...rest] = items.map(why);
  if (!first || rest.some(key => key !== first)) return "";
  if (first === "never") return `Waiting · ${items.length === 1 ? "it cannot" : "they cannot"} start`;
  if (first === "proposed") return "Waiting for your approval";
  if (first === "changing") return "Waiting for the new breakdown";
  const names = first.split(" ").map(id => fit(ctx.tasks.get(`${items[0].project}/${id}`)?.title || id, 24));
  return `Waiting for ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]}`;
}

/**
 * The frame's boxes of one logbook: a box for each release that it shows, then one for what is in no release. A milestone
 * box holds its open tasks that need you or are in progress (at most 3), then a box for each other word with its count,
 * and for waiting tasks what they wait for. The single tasks of a release are one list box. A box that needs you, and a
 * task in progress ("you are here", the design's section 1), is a double box. A task is named by its title, not its id.
 */
function frameOf(ctx, entry) {
  const task = key => ctx.tasks.get(key), milestone = key => ctx.milestones.get(key);
  const taskNode = (item, pilot) => ({ level: "task", id: item.id, name: item.title, href: taskHref(ctx, item), word: item.word, here: ["needs you", "in progress"].includes(item.word), note: item.word === "in progress" ? "you are here" : pilot ? "the pilot" : "" });
  const milestoneNode = m => {
    const tasks = m.tasks.map(task).filter(open), shown = tasks.filter(item => ["needs you", "in progress"].includes(item.word)).sort(byWord).slice(0, 3), rest = tasks.filter(item => !shown.includes(item));
    const groups = WORDS.map(word => [word, rest.filter(item => item.word === word)]).filter(([, items]) => items.length).map(([word, items]) => ({ level: "group", name: plural(items.length, "task"), word, note: word === "waiting" ? waitingFor(ctx, items) : "" }));
    return { level: "milestone", name: milestoneName(m), href: milestoneHref(ctx, m.key), word: m.word, here: m.word === "needs you", done: doneText(m.progress.merged, m.progress.total, m.progress.abandoned.length),
      // A dropped milestone with tasks still in it gives their next step, as the Milestones tab and the chat's line do (F-T996-13).
      note: m.word === "needs you" ? m.reason : m.state === "dropped" && m.open ? droppedNext(m) : "", kids: [...shown.map(item => taskNode(item, item.id === m.pilot)), ...groups] };
  };
  const list = (name, tasks, extra = {}) => ({ level: "list", name, word: releaseWord(tasks.map(item => item.word)).word, list: [...tasks].sort(byWord).map(item => ({ id: item.id, title: item.title, word: item.word, href: taskHref(ctx, item) })), ...extra });
  const nodes = frameReleases(entry).map(release => {
    const milestones = release.milestones.map(milestone).filter(Boolean), singles = release.singles.map(task).filter(item => item?.word);
    const ended = state => milestones.filter(m => !open(m) && m.word === state).length;
    return { level: "release", name: `Release ${release.name}`, word: release.word, done: doneText(release.done, release.total, release.stopped),
      note: release.missing ? "It is not in the logbook. Ask the chief to add it." : "",
      kids: [...milestones.filter(open).map(milestoneNode), ...(singles.length ? [list(plural(singles.length, "single task"), singles)] : [])],
      tail: ENDS.map(state => ended(state) ? `${title(state)}: ${plural(ended(state), "milestone")}` : "").filter(Boolean).join(" · ") };
  });
  const milestones = entry.loose.milestones.map(milestone).filter(open), singles = entry.loose.singles.map(task).filter(open);
  if (milestones.length || singles.length) nodes.push(list(`Not in a release: ${[milestones.length && plural(milestones.length, "milestone"), singles.length && plural(singles.length, "task")].filter(Boolean).join(" and ")}`, singles,
    { level: "loose", word: releaseWord([...milestones, ...singles].map(item => item.word)).word, kids: milestones.map(milestoneNode) }));
  return nodes;
}

/** A task's id after its title, as secondary text (F-T996-7): the owner reads the title first. */
const idAfter = id => id ? ` <span class="faint">${esc(id)}</span>` : "";
/** The page's form of a box: its level, its name (a link to its page) and its word, then its lines and the boxes inside it. */
function frameHtml(node) {
  const name = node.level === "task" ? `Task: ${node.name}` : node.name;
  const head = `<div class="hbt"><span class="hbk">${node.href ? `<a href="${esc(node.href)}">${esc(name)}</a>` : esc(name)}${idAfter(node.id)}</span>${node.list ? "" : wordTag(node.word, "pstate")}</div>`;
  const lines = [node.done, title(node.note)].filter(Boolean).map(line => `<div class="hbl">${esc(line)}</div>`).join("");
  const listed = (node.list ?? []).slice(0, LISTED).map(item => `<div class="hbl">${wordTag(item.word, "pstate")} <a href="${esc(item.href)}">${esc(item.title)}</a>${idAfter(item.id)}</div>`).join("");
  const more = (node.list?.length ?? 0) > LISTED ? `<div class="hbl">${esc(`and ${plural(node.list.length - LISTED, "more task")}: ${countsText(node.list.slice(LISTED))}`)}</div>` : "";
  const kids = node.kids?.length ? `<div class="hbc">${node.kids.map(frameHtml).join("")}</div>` : "";
  // "You are here" is a double box in the text colour, as in the design; a box that needs you keeps the colour of needs you.
  return `<div class="hb ${node.level}${node.here ? ` here${node.word === "in progress" ? " now" : ""}` : ""}">${head}${lines}${listed}${more}${kids}${node.tail ? `<div class="hbl tail">${esc(node.tail)}</div>` : ""}</div>`;
}
/** The "Where we are" frame of each logbook with releases, above the columns. The project filter shows the chosen project's. */
const whereHtml = ctx => shownReleases(ctx.model).map(entry => `<section class="where" data-rproject="${esc(entry.group)}" aria-label="Where we are · ${esc(entry.projectName)}"><h2 class="wh">Where we are <span class="faint">· ${esc(entry.projectName)}</span></h2><div class="hframe">${frameOf(ctx, entry).map(frameHtml).join("")}</div></section>`).join("");

/** Text for a fixed-width frame: each control or line break a space, and no format character (as md does), but no Markdown escapes: it is in a code block. */
const plain = value => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ").replace(/\p{Cf}/gu, "");
/** A title cut to n columns with an ellipsis, so that a long name never breaks the box. */
const fit = (text, n) => { let chars = [...plain(text)]; if (columns(chars.join("")) <= n) return chars.join(""); while (chars.length && columns(chars.join("")) > n - 1) chars.pop(); return `${chars.join("").trimEnd()}…`; };
const FRAME_WIDTH = 46;
/**
 * The chat's form of a box (the T984 catch-up frame's look: box() of the message pictures, a double box for the item that
 * needs you). Only a title holds logbook text, and fit cuts it; each line is the board's own words and counts.
 */
function frameText(node, w = FRAME_WIDTH) {
  const name = node.level === "task" ? `Task: ${node.name}` : node.name;
  // A task's note ("you are here", "the pilot") goes on its first line, and a group's ("Waiting for …") is its first line;
  // a milestone's or a release's note is a sentence, on its own line.
  const short = ["task", "group"].includes(node.level);
  const first = node.list ? countsText(node.list) || title(node.word) : node.level === "group" && node.note ? node.note : [title(node.word), node.done, short ? node.note : ""].filter(Boolean).join(" · ");
  const text = line => line ? [line] : [];
  return box({ w, title: fit(name, w - 6), style: node.here ? "double" : "round", lines: [...text(first), ...text(short ? "" : node.note), ...(node.kids ?? []).map(kid => frameText(kid, w - 4)), ...text(node.tail)] });
}
/** The chat's "Where we are" section of each logbook with releases: its frame in a code block. */
const whereText = model => { const ctx = context(model, false); return shownReleases(model).map(entry => `### ◫ Where we are · ${md(entry.projectName)}\n${"```"}\n${frameOf(ctx, entry).flatMap(node => frameText(node)).join("\n")}\n${"```"}`); };

/** A row of the Releases tab: an item's level and name (a link to its page), its word, and what happens next. */
const releaseRow = (name, href, word, text, id = "") => `<div class="rrow"><div class="rhead"><a href="${esc(href)}"><b>${esc(name)}</b></a>${idAfter(id)}${wordTag(word, "pstate")}</div>${text ? `<div class="rtext">${esc(text)}</div>` : ""}</div>`;
const firstLine = text => String(text ?? "").split(LINE)[0];
function releaseItems(ctx, milestones, singles) {
  return milestones.map(m => releaseRow(milestoneName(m), milestoneHref(ctx, m.key), m.word, `${doneText(m.progress.merged, m.progress.total, m.progress.abandoned.length)}.${m.word === "needs you" ? ` ${m.reason}` : ""}`)).join("")
    + singles.map(task => releaseRow(`Task: ${task.title}`, taskHref(ctx, task), task.word, firstLine(taskWord(task).reason), task.id)).join("");
}
function releaseCard(ctx, release) {
  const milestones = release.milestones.map(key => ctx.milestones.get(key)).filter(Boolean), singles = release.singles.map(key => ctx.tasks.get(key)).filter(Boolean);
  return `<section class="rcard"><h3 class="rtitle"><span aria-hidden="true">◎</span> Release ${esc(release.name)} ${wordTag(release.word, "pstate")}</h3><div class="rtext">${esc(doneText(release.done, release.total, release.stopped))}</div>`
    + `${release.goal ? `<p class="goal">${esc(release.goal)}</p>` : ""}${release.missing ? `<div class="rtext stw-need">This release is not in the logbook: a milestone or a task names it. Ask the chief to add it.</div>` : ""}${releaseItems(ctx, milestones, singles)}</section>`;
}
/** The Releases tab of one logbook: its releases that are not done, what is in no release, then its done releases. */
function releasesOfEntry(ctx, entry, named) {
  const live = entry.releases.filter(release => !ENDS.includes(release.word)), ended = entry.releases.filter(release => ENDS.includes(release.word));
  const milestones = entry.loose.milestones.map(key => ctx.milestones.get(key)).filter(open), singles = entry.loose.singles.map(key => ctx.tasks.get(key)).filter(open).sort(byWord);
  const loose = milestones.length || singles.length ? `<section class="rcard loose"><h3 class="rtitle">Not in a release</h3><div class="rtext">To put a milestone or a task in a release, ask the chief.</div>${releaseItems(ctx, milestones, singles)}</section>` : "";
  const done = `<section class="rcard"><h3 class="rtitle">Done releases</h3>${ended.length ? ended.map(release => `<div class="rrow"><div class="rhead"><b><span aria-hidden="true">◎</span> Release ${esc(release.name)}</b>${wordTag(release.word, "pstate")}</div><div class="rtext">${esc(doneText(release.done, release.total, release.stopped))}</div></div>`).join("") : `<div class="rtext">No release is done yet.</div>`}</section>`;
  return `<div class="rproject" data-rproject="${esc(entry.group)}">${named ? `<h2 class="grp">${esc(entry.projectName)}</h2>` : ""}${live.map(release => releaseCard(ctx, release)).join("")}${loose}${done}</div>`;
}
function releasesList(ctx, model, routed) {
  const entries = shownReleases(model), h = routed ? "h1" : "h2";
  const intro = `<p class="rintro">A release holds milestones and single tasks. It is done when each of them is done or stopped. Shipping it (a tag, a publish) is your action, not a state.</p>`;
  // A releases table that cannot be read says so for its project, as the Milestones tab does, so that the owner never asks
  // for releases that the logbook has (F-T996-11). So does a milestones or tasks table that cannot be read, as the board then
  // shows no release of the project (F-T996-28, F-T996-29). Only where it hides releases: never for a project with none, nor
  // for an old logbook, which shows none (F-T996-37, F-T996-42). The project filter shows the line with its project.
  const broken = (model.milestoneNeeds ?? []).filter(need => need.hidesReleases).map(need => `<div class="banner warn" data-rproject="${esc(need.group)}">${ICON}<div><b>The releases of ${esc(need.projectName)} cannot be read.</b> ${esc(need.text)}</div></div>`).join("");
  if (!entries.length) return `<${h} class="ptitle">Releases</${h}>${broken || `<div class="emptyboard"><b>No releases yet.</b> A release is a version that you ship, such as 1.0. To add one, ask the chief. It then holds milestones and single tasks.</div>`}`;
  const none = `<div class="emptyboard" id="noreleases" hidden><b>No release in this project.</b> <button class="linkbtn" type="button" data-reset>Show all projects</button></div>`;
  return `<${h} class="ptitle">Releases</${h}>${intro}${broken}${none}${entries.map(entry => releasesOfEntry(ctx, entry, entries.length > 1)).join("")}`;
}
export function renderReleasesHtml(model, { live = false, paths = false } = {}) {
  const ctx = context(model, false), at = hhmm(model.at);
  const body = `<div class="boardview"><header><h1>Sage board</h1>${pagesNav("releases", model)}${livePill(`Board · ${at}`)}<span class="spacer"></span>${THEME_SWITCH}${picker(ctx, model, paths, false)}</header>`
    + `<div id="board-content" data-at="${esc(at)}">${banners(model)}<main class="page open" aria-label="Releases">${releasesList(ctx, model, true)}</main></div></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sage releases</title><script>${THEME_HEAD}</script><style>${CSS}</style></head><body>${body}<script>${BOARD_ENHANCEMENT}${live ? liveScript("/releases?events=1", ["board-content", "board-pages", "pick-list", "needs-count"]) : ""}</script></body></html>`;
}

/** The served milestones list, or one milestone's page (T233 C9). An unknown milestone key gives the not-found page. */
export function renderMilestonesHtml(model, { milestoneKey = null, live = false, paths = false } = {}) {
  const ctx = context(model, false), at = hhmm(model.at), milestone = milestoneKey ? ctx.milestones.get(milestoneKey) : null;
  // The address can hold any text: the page names the milestone only when the key ends in a milestone id (T375).
  const asked = String(milestoneKey).split("/"), id = asked.length > 1 && MILESTONE_ID.test(asked.at(-1)) ? asked.at(-1) : null;
  // A long id wraps, and shows its first 12 characters (R1371-1).
  const shown = id && id.length > 12 ? `${id.slice(0, 11)}…` : id;
  const missing = `<div class="pagebar"><a class="back" href="/milestones">← Milestones</a></div><h1 class="ptitle">Milestone not found</h1><div class="emptyboard"><b>No milestone ${shown ? `${esc(shown)} ` : ""}on the board.</b> The logbook may not have it now, or the link is old. Open the <a href="/milestones">milestones list</a>.</div>`;
  const main = !milestoneKey ? milestonesList(ctx, model, true) : milestone ? milestonePage(ctx, milestone, true) : missing;
  // A milestone that is not on the board has no stream: the server answers its stream with 404 (R1322-3).
  live = live && (!milestoneKey || !!milestone);
  const body = `<div class="boardview"><header><h1>Sage board</h1>${pagesNav("milestones", model)}${livePill(`Board · ${at}`)}<span class="spacer"></span>${THEME_SWITCH}${picker(ctx, model, paths, false)}</header>`
    + `<div id="board-content" data-at="${esc(at)}">${banners(model)}<main class="page open" aria-label="${milestone ? esc(milestone.id) : milestoneKey ? "Milestone not found" : "Milestones"}">${main}</main></div></div>`;
  const stream = milestoneKey ? `/milestone/${b64(milestoneKey)}?events=1` : "/milestones?events=1";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${milestone ? `${esc(milestone.id)} · ` : milestoneKey ? "Milestone not found · " : ""}Sage milestones</title><script>${THEME_HEAD}</script><style>${CSS}</style></head><body>${body}<script>${BOARD_ENHANCEMENT}${live ? liveScript(stream, ["board-content", "board-pages", "pick-list", "needs-count"]) : ""}</script></body></html>`;
}

const goneText = task => { const note = goneNote(task); return note ? `\nThe folder ${md(note.name)} of ${md(note.run)} is not on this Mac now, so sage cannot read the branch there. The next review step of ${md(task.id)} stops until the folder is back.` : ""; };
const columnMark = key => ({ backlog: "📋", design: "🎨", building: "🔨", review: "🔁", ready: "✅", done: "🏁" }[key]);
const providerText = (name, task) => name ? md(name) : `${md(title(task.providerStandIn))} (${task.shared ? "the run names no chief" : "logbook source"})`;
/** The chat's step line: the same steps, marks and words as the page. */
const stepText = task => task.loop.steps.map(step => `${MARK[status(step.status)]} ${md(step.label)}`).join(" › ");
/** The chat lookup's Now and Next lines: the task page's lines (nowWaits), also for a task that waits (F-T420-1). */
const nowText = task => {
  const needs = task.loop.now.needs, next = waitNext(task), ask = `Needs you: ${mdLines(task.loop.now.text)}`;
  if (next === null) return `${needs ? ask : `Now: ${mdLines(task.loop.now.text)}`}${task.loop.next ? `\nNext: ${md(task.loop.next)}` : ""}`;
  return `${needs ? `${ask}\n` : ""}${WAIT_MARK[task.waitLine.never ? "never" : "wait"]} ${needs ? "" : "Now: "}${md(task.waitLine.text)}\nNext: ${md(next)}`;
};
const CHAT_SHOWN = 5, TITLE_MAX = 80;
/** The owner's state word of a task or a milestone after its title in the chat (T997), or nothing for a state that the board cannot read. */
const wordText = item => item.word ? ` · ${md(item.word)}` : "";
const tagText = task => `${task.priority ? ` · ${md(task.priority)}` : ""}${task.kind ? ` · ${md(KIND[task.kind][1])}` : ""}`;
/** A chat title of at most 80 characters, cut with an ellipsis (whole characters, before escaping). */
const clamp = value => { const chars = [...String(value ?? "")]; return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join("").trimEnd()}…` : chars.join(""); };

export function renderTaskText(task) {
  const head = task.currentHead ? `${md(task.currentHead)}${task.headBasis === "ledger" ? " (newest verdict)" : ""}` : "not recorded";
  const where = row => row.movedTo ? ` · moved to ${md(row.movedTo)}` : row.movedFrom ? ` · from ${md(row.movedFrom)}` : "";
  const rows = task.loop.steps.map(step => `${MARK[status(step.status)]} ${md(step.label)}: ${WORD[status(step.status)]}${step.detail ? ` · ${md(step.detail)}` : ""}${step.parts?.length ? `\n  ${step.parts.map(([name, value]) => `${MARK[status(value)]} ${md(name)}: ${WORD[status(value)]}`).join(" · ")}` : ""}`).join("\n");
  // A shared task names its owning chief (or Unclaimed) and its offer; an old task its old logbook and why it did not move (T306).
  const holder = `${task.shared ? `Owning chief: ${md(task.holder)}${task.owner?.unlisted ? `\n${md(`${task.owner.id} is not in chiefs.tsv, so the board does not know its provider.`)}` : ""}${task.offer ? `\n⇄ ${md(task.offer)}` : ""}\n` : ""}${task.old ? `${md(`${oldWhat(task, "of")}.${task.old.finished ? "" : " The move did not take it to the shared logbook."} It stays there, read-only, and its number belongs to that old logbook.`)}\n` : ""}`;
  return `**${md(task.id)} ${md(task.title)}**${task.was ? ` · ${md(task.was)}` : ""}\n${md(task.holder ?? task.sourceLabel)} · ${md(task.projectName)}${wordText(task)} · ${md(task.size)}${tagText(task)}${task.risk ? ` · risk: ${md(task.risk)}` : ""}${task.pr ? ` · PR ${prUrl(task) ? `[${md(task.pr)}](${mdUrl(prUrl(task))})` : md(task.pr)}` : ""}\n${holder}\n**Loop**\n${stepText(task)}\n${nowText(task)}\n${rows}\nRecorded state: ${md(task.state)} · repair round ${md(task.round)} · last commit ${head}\n\n**Brief**\nGoal: ${mdBlock(task.briefFields.goal ?? "not recorded")}\nAcceptance: ${mdBlock(task.briefFields.acceptance ?? "not recorded")}\n\nFull brief:\n${mdBlock(task.brief ?? "No verified brief content is available.")}\n\n**Agent runs**\n${task.runs.map(r => `${md(r.id)} ${providerText(r.provider, task)} · ${md(r.role)}${r.checkoutName ? ` · checkout ${md(r.checkoutName)}${r.checkoutGone ? " (gone)" : r.checkoutGone === null ? " (not checked)" : ""}` : ""} · ${md(r.status)} · ${md(task.runClocks?.[r.id]?.text ?? runTime(r))} · tokens ${md(r.tokens || "unknown")}`).join("\n") || "No runs recorded."}${goneText(task)}\n\n**Evidence**\n${task.ledger.map(r => `${md(r.kind)} · cycle ${md(r.cycle)} · ${md(r.sha)} · ${md(r.run)} · ${md(r.at)}`).join("\n") || "No verdicts recorded."}${evidenceArtifacts(task).map(r => `\n\n${md(r.data.label)} · ${md(r.source)} · ${md(r.observedAt)} · ${md(r.data.run ?? "run unknown")} · digest verified\n${mdBlock(r.content.text)}`).join("")}\n\n**Findings**\n${task.findings.map(r => `${md(r.severity)} · ${md(r.summary)} · ${md(r.status)}${where(r)}${r.reason ? ` · ${md(r.reason)}` : ""}`).join("\n") || "No findings recorded."}\n\n**Artifacts**\n${task.artifacts.map(r => `${md(r.data.label)} · ${md(r.data.url ?? (r.content?.verified ? "local artifact; digest verified" : "local artifact; content not verified"))}`).join("\n") || "No artifacts recorded."}\n\n**Latest decisions**\n${task.decisions.map(r => `${md(r.at)} · ${md(r.decision)} · ${md(r.why)}`).join("\n") || "No decisions recorded."}`;
}

/** A hard break (F1): a chat that joins soft line breaks still shows each line of a block on its own line. */
const BREAK = "\\\n";
/** A block of the chat board: its lines with a hard break each, then the quoted lines under them (a quote ends the paragraph, so the line before it takes no break). */
const block = (lines, quoted = []) => [lines.filter(Boolean).join(BREAK), quoted.length ? quoted.map(line => `> ${line}`).join(BREAK) : ""].filter(Boolean).join("\n");
/** The quoted lines of a reason: a breakdown gate's stored lines (QF), else one line, then its options and recommendation. */
const reasonLines = reason => {
  // A "-" or "=" that starts a stored line is escaped, so the line makes no list, rule or heading in the quote (F-T233-6).
  const [first, ...rest] = String(reason.text ?? "").split(LINE).map(line => md(line).replace(/^(\s*)([-=])/, "$1\\$2"));
  return [`${reason.gateId ? `${md(reason.key)} · ` : ""}${first}`, ...rest, ...(reason.options?.length ? [`Options: ${reason.options.map((option, i) => `${i + 1}: ${md(option)}`).join(" · ")}`] : []), ...(reason.recommendation ? [`Recommended: ${md(reason.recommendation)}`] : [])];
};
const WAIT_MARK = { never: "⊘", wait: "⧗" };
/** A milestone's line in the chat's Milestones section, by its state. */
const milestoneLine = milestone => {
  const head = `${md(milestoneName({ id: milestone.id, name: milestone.name && clamp(milestone.name) }))}${wordText(milestone)}${milestone.where ? ` · ${milestone.where}` : ""}`;
  const tasks = n => `${n} ${n === 1 ? "task" : "tasks"}`;
  const pilot = `the pilot ${md(milestone.pilot)} ${milestone.pilotState ? "was abandoned" : "is not in the logbook"}`;
  const cannot = milestone.cannotStart.length ? ` · ${milestone.cannotStart.map(md).join(", ")} cannot start` : "";
  const next = milestone.next ? `${md(milestone.next.id)} \\(${milestone.next.pilot ? "pilot, " : ""}${md(milestone.next.word)}\\)` : "no task can move now";
  return `${head} · ${{
    proposed: () => `the breakdown waits for you \\(gate ${md(milestone.gate)}\\) · pilot ${md(milestone.pilot)}${cannot}`,
    changing: () => `the chief revises the breakdown \\(gate ${md(milestone.gate)}\\)${cannot}`,
    lost: () => `${md(lostClause(milestone))} \\(see Needs you\\)`,
    dropped: () => `dropped · ${tasks(milestone.open)} still in it: ask the chief to take each task out of the milestone`,
    stuck: () => `stuck: ${pilot} \\(see Needs you\\)`,
  }[milestone.state]?.() ?? `${md(milestone.progressText)} · next: ${next}${milestone.waiting ? ` · ${milestone.waiting} ${milestone.waiting === 1 ? "waits" : "wait"}` : ""}${cannot}`}`;
};

export function renderBoardText(model) {
  // The chat board uses the page's words: its summary, its column names and its date. A stand-in provider gets one note, not one per card.
  const shown = model.columns.flatMap(column => column.tasks.slice(0, CHAT_SHOWN));
  const standIns = shown.some(task => task.agents.some(agent => !agent.provider));
  const milestoneTag = task => task.milestone ? ` · ◫ ${md(milestoneName({ id: task.milestone.id, name: task.milestone.name && clamp(task.milestone.name) }))}${task.milestone.pilot ? " \\(pilot\\)" : ""}`
    : task.release ? ` · ◎ Release ${md(clamp(task.release))}` : task.release === null ? " · no release" : "";
  // A card's question is in the Needs you section above; the card shows its steps and, when nothing needs you, its Now line.
  // A card of a milestone has its tag. A card with a wait has the tasks that it waits for in one line (⊘ when one is never
  // met), instead of its Now line and in its place, after the step line (R1307-3, T374). Each line ends with a hard break.
  const line = task => block([`**${md(task.id)} ${md(clamp(task.title))}**${task.was ? ` · ${md(task.was)}` : ""}${wordText(task)} · ${md(task.holder ?? task.sourceLabel)} · ${md(task.projectName)}${task.pr ? ` · PR ${md(task.pr)}` : ""}${tagText(task)}${milestoneTag(task)}`,
    ...task.agents.map(agent => `${agent.provider ? md(agent.provider) : md(`${title(task.providerStandIn)}*`)} · ${md(agent.role)} at work`),
    task.inferredWork ? "Inferred from the open PR." : "",
    task.column === "done" ? "" : stepText(task),
    task.waitLine ? `${WAIT_MARK[task.waitLine.never ? "never" : "wait"]} ${md(task.waitLine.text)}` : "",
    task.column === "done" || task.loop.now.needs || task.waitLine ? "" : `Now: ${md(task.loop.now.text)}`,
    task.column === "done" || !task.offer ? "" : `⇄ ${md(task.offer)}`]);
  // Each column shows its first 5 cards in the page's order (needs you first, then the newest activity) and counts the rest.
  const section = column => {
    const name = COLUMN_NAME[column.key] ?? column.name, rest = column.tasks.length - CHAT_SHOWN;
    return `### ${columnMark(column.key)} ${md(name)} (${column.tasks.length})\n${column.tasks.slice(0, CHAT_SHOWN).map(line).join("\n\n") || "No tasks."}${rest > 0 ? `\n\n${rest} more in ${md(name)}: open the board page for all.` : ""}`;
  };
  const counts = model.counts;
  // Needs you: a milestone's breakdown gate (by the data rule) under its own heading, then every other item under Other: the
  // milestone items that no card shows (a stuck milestone, a lost gate), then the cards. With no breakdown gate, no headings.
  // A pilot's other reasons are an item under Other, so the approval block holds the breakdown gate alone (F-T233-9).
  const approvals = model.needsOwner.flatMap(task => task.reasons.filter(reason => reason.breakdown).map(gate => [task, gate]));
  const others = model.needsOwner.map(task => ({ ...task, reasons: task.reasons.filter(reason => !reason.breakdown) })).filter(task => task.reasons.length);
  const milestoneNeeds = model.milestoneNeeds ?? [];
  let n = 0;
  // The breakdown gate shows its full key, as every other gate does: the owner answers by that key (F-T233-4).
  const approval = ([task, gate]) => block([`**${++n} · ${md(milestoneName({ id: gate.breakdown.id, name: gate.breakdown.name && clamp(gate.breakdown.name) }))}**${wordText(model.milestones?.find(milestone => milestone.key === gate.breakdown.key) ?? {})} · ${md(task.sourceLabel)} · ${md(task.projectName)} · pilot ${md(task.id)} · gate ${md(gate.gateId)}`], reasonLines(gate));
  const milestoneNeed = need => block([`**${++n} · ${md(clamp(need.title))}** · ${md(need.sourceLabel)} · ${md(need.projectName)}`], [md(need.text)]);
  const other = task => block([`**${++n} · ${md(task.id)} ${md(clamp(task.title))}**${wordText(task)} · ${md(task.holder ?? task.sourceLabel)} · ${md(task.projectName)}`], task.reasons.flatMap(reason => reasonLines(reason)));
  const needs = approvals.length
    ? [`#### ◫ Milestone approval\n${approvals.map(approval).join("\n\n")}`, ...(others.length || milestoneNeeds.length ? [`#### Other\n${[...milestoneNeeds.map(milestoneNeed), ...others.map(other)].join("\n\n")}`] : [])].join("\n\n")
    : [...milestoneNeeds.map(milestoneNeed), ...others.map(other)].join("\n\n") || "No recorded task needs you.";
  // Milestones: each milestone that is not done or dropped, in a line; the done and dropped ones as counts. The project's name
  // shows when milestones of two projects show; the logbook's source when one project has milestones in two logbooks (C4).
  // A dropped milestone with tasks still in it keeps its line, with the next step for them (F-T233-10).
  const counted = milestone => milestone.state === "done" || milestone.state === "dropped" && !milestone.open;
  // A logbook with releases shows its milestones in its "Where we are" frame (T996), not here: here it keeps only a
  // milestone with a line that the frame does not show, such as a dropped one with tasks still in it, in a done release (F-T996-2).
  const framed = new Set(shownReleases(model).map(entry => entry.key));
  const inFrame = new Set(shownReleases(model).flatMap(entry => [...frameReleases(entry).flatMap(release => release.milestones), ...entry.loose.milestones]));
  const milestones = (model.milestones ?? []).filter(milestone => !milestone.archived && (!framed.has(milestone.project) || !inFrame.has(milestone.key) && !counted(milestone)));
  const groups = new Set(milestones.map(milestone => milestone.group));
  const books = group => new Set(milestones.filter(milestone => milestone.group === group).map(milestone => milestone.project)).size;
  const where = milestone => [groups.size > 1 ? md(milestone.projectName) : "", books(milestone.group) > 1 ? md(milestone.sourceLabel) : ""].filter(Boolean).join(" · ");
  const ended = ["done", "dropped"].map(state => [state, milestones.filter(milestone => counted(milestone) && milestone.state === state).length]).filter(([, count]) => count);
  const milestoneText = milestones.length ? `### ◫ Milestones\n${[...milestones.filter(milestone => !counted(milestone)).map(milestone => `- ${milestoneLine({ ...milestone, where: where(milestone) })}`), ...(ended.length ? [`- ${ended.map(([state, count]) => `${count} ${state}`).join(" · ")}: open the board's Milestones tab`] : [])].join("\n")}` : "";
  // The count is the number of the numbered items above (n), so a pilot with a breakdown gate and another reason counts twice, as it shows.
  // The logbook kept changing through 3 reads (T306, F9): this board is its third read, which may mix two moments.
  const changing = (model.changing ?? []).map(item => `⧗ The logbook is changing: ${md(item.project)} · read at ${md(hhmm(item.at))} UTC${item.dropped ? `, without what changed during it (${md(item.dropped.join("; "))})` : ""}. The board shows that read; ask for the board again for a read with no change.`);
  const moved = (model.moved ?? []).map(item => `⇢ ${md(`${item.project} moved to one shared logbook on ${day(item.at)} UTC. ${movedText(item)}`)}`);
  const top = block([`**sage board** · built ${md(day(model.at))} UTC`, ...changing, ...moved,`🔴 ${n} needs you · ${counts.recordedAgents} agents at work${counts.inferredWork ? ` · ${counts.inferredWork} inferred PRs` : ""} · 🔁 ${counts.inReview} in review · ${counts.tasks} tasks`, standIns ? `${md("*")} A stand-in: the run does not record its provider, so the board names the logbook's source.` : ""]);
  const end = block([model.archived.length ? `Archived: ${model.archived.map(book => `${md(book.name)} (${archivedCounts(book)})`).join(", ")}` : "",
    ...model.diagnostics.map(d => `Incomplete source: ${md(d.source)}${d.project ? ` · ${md(d.project)}` : ""} · ${md(d.message)}`), ...model.warnings.map(d => `Setting ignored: ${md(d.source)} · ${md(d.project)} · ${md(d.message)}`), ...(model.notes ?? []).map(d => `Logbook note: ${md(d.source)} · ${md(d.project)} · ${md(d.message)}`)]);
  return [top, `### 🔴 Needs you\n${needs}`, ...whereText(model), milestoneText, ...model.columns.map(section), end].filter(Boolean).join("\n\n");
}
export function renderBoardStatus(model) {
  // An archived project's tasks are not in Tasks or Owner: one line counts the archived projects and what needs you there.
  const states = new Map(); for (const task of model.tasks.filter(task => !task.archived)) states.set(task.state, (states.get(task.state) ?? 0) + 1);
  const archivedNeeds = model.archived.reduce((n, book) => n + book.needsOwner, 0);
  return `Tasks: ${[...states].map(([state,n]) => `${state} ${n}`).join(" · ") || "none recorded"}\nAgents: ${model.counts.recordedAgents} recorded running · ${model.counts.inferredWork} inferred PRs\nOwner: ${model.counts.needsOwner} need you\n${model.archived.length ? `Archived: ${model.archived.length} project${model.archived.length === 1 ? "" : "s"} · ${archivedNeeds} need you\n` : ""}Budget this week: unknown; no provider observation available${model.diagnostics.length ? `\nSources: ${model.diagnostics.length} diagnostics; counts may be incomplete` : ""}`;
}
