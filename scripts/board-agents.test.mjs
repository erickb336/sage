// The Agents page (T308): the join of the hook's slots to the logbooks' runs, each state rule with fixed times, the
// median rule, the lead and helper tree, Codex rows, the caps, the reader of the hook's notes and the page. SAMPLE DATA.
import "./test-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { readBoardSources, readHookNotes } from "../packages/sage-core/board-reader.mjs";
import { renderAgentsHtml, renderBoardHtml } from "../packages/sage-core/board-render.mjs";
import { agentCaps } from "../packages/sage-core/logbook-fields.mjs";

const NOW = "2026-10-18T12:00:00.000Z", at = Date.parse(NOW);
const ago = minutes => at - minutes * 60_000;
const iso = minutes => new Date(ago(minutes)).toISOString();
const sha256 = text => createHash("sha256").update(text).digest("hex");
const task = (id, title = `Sample task ${id}`) => ({ id, title, size: "small", risk: "", route: "build,code-review,qa", state: "building", branch: "", pr: "", round: "0", keys: "", priority: "P1", kind: "ui" });
const run = (id, role, started, extra = {}) => ({ id, task: "T1", role, round: "0", status: "running", started: iso(started), ended: "", model: "", ...extra });
const ended = (id, role, minutes) => ({ id, task: "T1", role, round: "0", status: "done", started: iso(1000 + minutes), ended: iso(1000) });
const book = (name, runs, extra = {}) => ({ key: `claude/${name}`, source: "claude", name, logbook: sha256(name), diagnostics: [], warnings: [], tables: { tasks: [task("T1")], runs }, observations: { version: 1, records: [] }, ...extra });
/** A slot as the reader gives it: its marks and the time of its last activity, in minutes before NOW. */
const slot = (name, marks, idle) => ({ name, marks: [...marks, "ok"], at: ago(idle) });
const claude = (books, slots = [], { helpers = [], present = true, problem = null, config = {} } = {}) => ({ id: "claude", label: "Claude", provider: "claude", config, diagnostics: [], projects: books, hooks: { present, slots, helpers, problem } });
const agents = (...sources) => buildBoardModel(sources, { now: NOW }).agents;
const rows = model => model.projects.flatMap(project => project.agents.flatMap(agent => [agent, ...agent.children]));
const brief = agent => `${agent.runId ?? "-"} ${agent.state}${agent.lead ? ` under ${agent.lead}` : ""}`;

test("T308: a slot joins its run by the run mark; a slot with no run and a run with no slot each show as one agent", () => {
  const model = agents(claude([book("sample-abcdef", [run("R1", "implementer", 10), run("R2", "qa", 90)])], [
    slot("slot-1", ["project-sample", "role-sage_implementer", "run-R1"], 2),
    slot("slot-2", ["project-sample", "role-sage_designer"], 3),
    slot("slot-3", ["project-other", "role-sage_qa", "run-R2"], 1), // another project's R2: no join
    { name: "slot-4", marks: ["project-sample", "role-sage_qa", "run-R2"], at: ago(1) }, // not taken (no ok mark): not an agent
  ]));
  const list = rows(model);
  assert.deepEqual(list.map(agent => [agent.runId, agent.role, agent.task?.title ?? null, agent.state]), [
    ["R2", "qa", "Sample task T1", "stuck"],
    ["R1", "implementer", "Sample task T1", "work"],
    [null, "designer", null, "work"],
    ["R2", "qa", null, "work"],
  ]);
  assert.equal(list.find(agent => agent.runId === "R2" && agent.task).why, "no agent slot holds this run: the hook frees a slot after 60 min with no activity. Ask the chief to check the run.");
  assert.deepEqual(model.unmatched, [{ run: "R2", project: "sample" }]);
  assert.equal(model.count, 4);
  assert.deepEqual(model.projects.map(project => project.name), ["sample", "other"], "the project with a problem first");
});

test("T308: may be stuck after 30 min with no hook activity, not at 29; a lead with a running helper waits", () => {
  const lead = sha256("lead agent");
  const model = agents(claude([book("sample-abcdef", [run("R1", "implementer", 60), run("R2", "implementer", 60), run("R3", "lead", 120), run("R4", "qa", 40)])], [
    slot("slot-1", ["project-sample", "role-sage_implementer", "run-R1"], 29),
    slot("slot-2", ["project-sample", "role-sage_implementer", "run-R2"], 30),
    slot("slot-3", ["project-sample", "role-sage_lead", "run-R3", `bound-${lead}`], 45),
    slot("slot-4", ["project-sample", "role-sage_qa", "run-R4", `parent-${lead}`], 5),
  ]));
  const byRun = Object.fromEntries(rows(model).map(agent => [agent.runId, agent]));
  assert.deepEqual([byRun.R1.state, byRun.R2.state, byRun.R2.why], ["work", "stuck", "no activity for 30 min"]);
  assert.deepEqual([byRun.R3.state, byRun.R3.why], ["wait", "1 of 1 helper working"], "a quiet lead with a running helper waits; it is not stuck");
  assert.equal(byRun.R4.lead, "R3");
  // The page refreshes by itself when R1 reaches 30 min: no file event comes then.
  assert.equal(model.next, ago(29) + 30 * 60_000);
  // Without the helper, the same quiet lead may be stuck.
  const alone = agents(claude([book("sample-abcdef", [run("R3", "lead", 120)])], [slot("slot-3", ["project-sample", "role-sage_lead", "run-R3", `bound-${lead}`], 45)]));
  assert.deepEqual(rows(alone).map(brief), ["R3 stuck"]);
});

test("T308: a helper whose stop the hook noted, while the logbook still says running, is 'helper stopped, run still open'", () => {
  const b = book("sample-abcdef", [run("R3", "lead", 120), run("R4", "ux-reviewer", 40), run("R5", "qa", 40), run("R6", "qa", 40)]);
  const key = sha256(`${b.logbook}:R3`);
  const model = agents(claude([b], [slot("slot-1", ["project-sample", "role-sage_lead", "run-R3", `logbook-${b.logbook}`, "bound-" + sha256("x")], 1)], { helpers: [
    { lead: key, run: "R4", stopped: false, at: null }, { lead: key, run: "R4", stopped: true, at: Date.parse("2026-10-18T11:46:00Z") },
    { lead: key, run: "R5", stopped: false, at: null }, // its slot ended: may be stuck, still under its lead
    { lead: sha256("another lead"), run: "R6", stopped: true, at: ago(5) }, // the note of another lead: not this run's
  ] }));
  // The lead has no running helper (R5 has no slot, R4 stopped), so it does not wait; R6's lead is not known.
  assert.deepEqual(rows(model).map(brief), ["R6 stuck", "R3 work", "R5 stuck under R3", "R4 stop under R3"]);
  assert.equal(rows(model).find(agent => agent.runId === "R4").why, "stopped at 11:46 UTC; the logbook still says running");
});

test("T308: running long is more than 2 times the median of the same role's ended runs in the project, with at least 5", () => {
  const history = [10, 10, 10, 20, 30].map((minutes, i) => ended(`R${10 + i}`, "implementer", minutes)); // median 10 min
  const slots = ["R1", "R2", "R3"].map((id, i) => slot(`slot-${i + 1}`, ["project-sample", "role-sage_implementer", `run-${id}`], 1));
  const model = agents(claude([book("sample-abcdef", [...history, ended("R20", "qa", 1), run("R1", "implementer", 20), run("R2", "implementer", 21), run("R3", "qa", 500)])], slots));
  const byRun = Object.fromEntries(rows(model).map(agent => [agent.runId, agent]));
  assert.deepEqual([byRun.R1.state, byRun.R2.state, byRun.R2.why], ["work", "long", "21 min; usual for an implementer here is about 10 min"]);
  assert.equal(byRun.R3.state, "work", "one ended qa run is no basis");
  // Four ended runs are no basis either.
  const four = agents(claude([book("sample-abcdef", [...history.slice(0, 4), run("R2", "implementer", 100)])], [slots[1]]));
  assert.equal(rows(four)[0].state, "work");
  // An even count takes the mean of the middle two: 10, 10, 20, 30, 40, 50 gives 25, so 51 min is long and 50 is not.
  const six = [10, 10, 20, 30, 40, 50].map((minutes, i) => ended(`R${30 + i}`, "qa", minutes));
  const even = agents(claude([book("sample-abcdef", [...six, run("R1", "qa", 50), run("R2", "qa", 51)])], ["R1", "R2"].map((id, i) => slot(`slot-${i + 1}`, ["project-sample", "role-sage_qa", `run-${id}`], 1))));
  assert.deepEqual(rows(even).map(brief).sort(), ["R1 work", "R2 long"]);
});

test("T308: Codex agents come from the logbook only: running, no activity, no helpers and no cap", () => {
  const codex = { id: "codex", label: "Codex", provider: "codex", config: {}, diagnostics: [], hooks: { present: false, slots: [], helpers: [], problem: null },
    projects: [{ ...book("sample-abcdef", [run("R7", "implementer", 12)]), key: "codex/sample-abcdef", source: "codex" }, { ...book("solo-abcdef", [run("R8", "qa", 5)]), key: "codex/solo-abcdef", source: "codex" }] };
  const model = agents(claude([book("sample-abcdef", [run("R1", "qa", 5)])], [slot("slot-1", ["project-sample", "role-sage_qa", "run-R1"], 1)], { config: { max_agents: "3" } }), codex);
  const byRun = Object.fromEntries(rows(model).map(agent => [agent.runId, agent]));
  assert.deepEqual([byRun.R7.provider, byRun.R7.state, byRun.R7.why, byRun.R7.idle], ["codex", "unk", "Codex sends no activity notes yet", null]);
  assert.deepEqual(model.providers, [{ name: "Claude", count: 1 }, { name: "Codex", count: 2 }]);
  assert.deepEqual(model.projects.map(project => [project.name, project.cap]), [["sample", { label: "Claude", used: 1, cap: 3 }], ["sample", null], ["solo", null]]);
  assert.deepEqual(model.caps, [{ label: "Claude", total: { used: 1, cap: 20 }, projects: [{ name: "sample", used: 1, cap: 3 }] }]);
});

test("T308: unreadable hook notes show every Claude run from the logbook, with activity not known and no caps", () => {
  const model = agents(claude([book("sample-abcdef", [run("R1", "qa", 5)])], [], { problem: "EACCES" }));
  assert.deepEqual(rows(model).map(agent => [agent.state, agent.why]), [["unk", "no hook notes: activity not known"]]);
  assert.deepEqual(model.problems, [{ source: "claude", message: "its folder has no read permission" }]);
  assert.deepEqual([model.caps, model.unmatched], [[], []]);
  const html = renderAgentsHtml(buildBoardModel([claude([book("sample-abcdef", [run("R1", "qa", 5)])], [], { problem: "EACCES" })], { now: NOW }));
  assert.match(html, /<b>The hook notes cannot be read<\/b> \(claude: its folder has no read permission\)/);
  assert.match(html, /Caps: not known while the hook notes cannot be read\./);
});

test("T308: the caps are the hook's: cap.<project>, else max_agents, and cap_total, read as the state tool reads a count", () => {
  assert.deepEqual([agentCaps({}).cap("x"), agentCaps({}).total], [10, 20]);
  const caps = agentCaps({ max_agents: "2.9", "cap.sage": 6, cap_total: "0", "cap.bad": "many" });
  assert.deepEqual([caps.cap("sage"), caps.cap("other"), caps.cap("bad"), caps.total], [6, 2, 2, 1]);
  assert.equal(agentCaps({ cap_total: 900 }).total, 50);
});

test("T308: the reader takes slot marks and times, helper notes by name only, and refuses a link", t => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-board-agents-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(readHookNotes(dir), { present: false, slots: [], helpers: [], problem: null });
  const slotDir = join(dir, ".hooks", "slots", "slot-1"), helpers = join(dir, ".hooks", "helpers"), lead = "a".repeat(64);
  mkdirSync(slotDir, { recursive: true }); mkdirSync(helpers);
  for (const mark of ["ok", "run-R3", "project-sample"]) writeFileSync(join(slotDir, mark), "");
  mkdirSync(join(dir, ".hooks", "slots", "not-a-slot"));
  utimesSync(slotDir, new Date(ago(7)), new Date(ago(7)));
  for (const name of [`started-${lead}.R4`, `stopped-${lead}.R4`, `owned-${lead}.R4`, "stopped-short.R4"]) writeFileSync(join(helpers, name), "secret report text");
  utimesSync(join(helpers, `stopped-${lead}.R4`), new Date(ago(3)), new Date(ago(3)));
  const notes = readHookNotes(dir);
  assert.deepEqual(notes.slots, [{ name: "slot-1", marks: ["ok", "project-sample", "run-R3"], at: ago(7) }]);
  assert.deepEqual(notes.helpers.sort((a, b) => a.stopped - b.stopped), [{ lead, run: "R4", stopped: false, at: null }, { lead, run: "R4", stopped: true, at: ago(3) }]);
  assert.ok(!JSON.stringify(notes).includes("secret"), "no note's content is read");
  // A link in place of the slot folder is not followed.
  const linked = mkdtempSync(join(realpathSync(tmpdir()), "sage-board-agents-link-"));
  t.after(() => rmSync(linked, { recursive: true, force: true }));
  mkdirSync(join(linked, ".hooks")); symlinkSync(join(dir, ".hooks", "slots"), join(linked, ".hooks", "slots"));
  assert.deepEqual(readHookNotes(linked), { present: false, slots: [], helpers: [], problem: "ELOOP" });
  // readBoardSources gives each source its notes; the logbook's hook name is the sha256 of its folder.
  mkdirSync(join(dir, "sample-abcdef"));
  const [source] = readBoardSources([{ id: "claude", path: dir }], { now: at });
  assert.equal(source.hooks.slots.length, 1);
  assert.equal(source.projects[0].logbook, sha256(join(dir, "sample-abcdef")));
});

test("T308: the page shows each state with a mark and a word, the tree, the caps and the links; logbook text is escaped", () => {
  const lead = sha256("lead agent"), b = book("sample-abcdef", [run("R3", "lead", 50, { model: "opus" }), run("R4", "qa", 20), run("R9", "implementer", 300)]);
  b.tables.tasks = [task("T1", `<img src=x onerror=alert(1)> title`)];
  const model = buildBoardModel([claude([b], [
    slot("slot-1", ["project-sample", "role-sage_lead", "run-R3", `bound-${lead}`], 1),
    slot("slot-2", ["project-sample", "role-sage_qa", "run-R4", `parent-${lead}`], 2),
  ], { config: { "cap.sample": 2 } })], { now: NOW });
  const html = renderAgentsHtml(model, { live: true });
  assert.ok(!html.includes("<img src=x"), "a task title is text");
  assert.match(html, /<span class="st st-wait"><span class="m" aria-hidden="true">◷<\/span>waiting for its helpers<\/span>/);
  assert.match(html, /<span class="st st-stuck"><span class="m" aria-hidden="true">!<\/span>may be stuck<\/span>/);
  assert.match(html, /<ul aria-label="Helpers of R3"><li><div class="arow child">.*<span class="role">qa<\/span><span class="id">R4<\/span><span class="faint">helper of R3<\/span>/);
  assert.match(html, new RegExp(`<a class="t" id="al-[\\w-]+" href="/task/${Buffer.from("claude/sample-abcdef/T1").toString("base64url")}"><span class="id">T1</span> &lt;img`));
  assert.match(html, /<span class="cap full">.*sample 2 of 2 · at cap<\/span>/);
  assert.match(html, /model opus<\/span><span>running 50 min<\/span><span>last activity 1 min ago/);
  assert.ok(html.includes('<b>1 run has no hook record.</b> The logbook says R9 (sample) runs, but no agent slot holds it. Each row stays, marked "may be stuck", until the chief ends the run.</div>'), "R1449-1: the chief ends the run");
  assert.match(html, /<b class="needn">1<\/b> needs a look/);
  assert.match(html, /<a href="\/agents" aria-current="page">Agents \(3\)<\/a>/);
  // Offline (no server), there is no tab and no task link.
  const offline = renderAgentsHtml(model);
  assert.ok(!offline.includes('class="boardtabs"') && !offline.includes('href="/task/'));
  // The task board shows the tab only when it is served.
  assert.match(renderBoardHtml(model, { snapshot: false }), /<nav class="boardtabs" id="board-pages" aria-label="Board pages"><a href="\/" aria-current="page">Task board<\/a><a href="\/programs">Programs<\/a><a href="\/agents">Agents \(3\)<\/a><\/nav>/);
  assert.ok(!renderBoardHtml(model).includes('id="board-pages"'));
  // No agent: the empty state.
  assert.match(renderAgentsHtml(buildBoardModel([claude([book("sample-abcdef", [])])], { now: NOW }), { live: true }), /<b>No agent runs now\.<\/b>/);
});

test("T308: two clones of one name show the end of their paths only on the Mac's own page", () => {
  const twin = (name, folder) => ({ ...book(name, [run("R1", "qa", 5)]), checkout: `/Users/sample/${folder}/trip`, repository: "https://github.com/sample/trip" });
  const model = buildBoardModel([claude([twin("trip-aaaaaa", "one"), twin("trip-bbbbbb", "two")], [])], { now: NOW });
  const mac = renderAgentsHtml(model, { live: true, paths: true }), remote = renderAgentsHtml(model, { live: true });
  assert.match(mac, /…\/one\/trip · sample\/trip/);
  assert.ok(!remote.includes("/one/trip") && remote.includes("clone 1"), "a tunnel viewer sees clone 1 and clone 2");
});
