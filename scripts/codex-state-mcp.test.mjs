import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { ROOT } from "./build.mjs";

const SHA = "1".repeat(40);

async function connect(t, overrides = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-state-mcp-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(ROOT, "plugins/sage-codex"), join(dir, "plugin"), { recursive: true });
  const project = join(dir, "project");
  mkdirSync(project);
  execFileSync("git", ["init", "-q", project]);
  const { SAGE_HOME, ...inherited } = process.env;
  const env = { ...inherited, HOME: join(dir, "home"), CODEX_HOME: join(dir, "codex-home"), SAGE_WORKTREES: join(dir, "worktrees"), ...overrides };
  const child = spawn(process.execPath, [join(dir, "plugin/mcp/state-server.mjs")], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "", id = 0, calls = 0;
  const { gate: gateOf, writeProof } = await import(pathToFileURL(join(dir, "plugin/hooks/gate-hook.mjs")).href);
  child.stderr.on("data", (data) => { stderr += data; });
  const closed = new Promise((resolve) => child.once("close", (code) => resolve(code)));
  const pending = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => { const reply = JSON.parse(line); pending.get(reply.id)(reply); });
  const rpc = (method, params) => new Promise((resolve) => {
    pending.set(++id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex", version: "0.160.0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  t.after(async () => { child.stdin.end(); assert.equal(await closed, 0); assert.equal(stderr, ""); });
  return {
    dir, project, env, gateOf,
    writeProof: (name, id, caller) => writeProof({ tool_use_id: id, session_id: "019a0000-0000-7000-8000-0000000000aa", tool_name: `mcp__sage__${name}` }, env, caller),
    tools: async () => (await rpc("tools/list", {})).result.tools,
    call: async (name, args = {}, { gate = true, callId = `call_${++calls}`, agent, sessionId = "019a0000-0000-7000-8000-0000000000aa" } = {}) => {
      let thread = { transcript_path: null };
      if (agent) {
        thread = { agent_id: "agent-1", transcript_path: join(dir, `child-${callId}.jsonl`) };
        writeFileSync(thread.transcript_path, JSON.stringify({ type: "session_meta", payload: { id: "019a0000-0000-7000-8000-0000000000bb", agent_path: agent, source: { subagent: { thread_spawn: { depth: 1 } } } } }) + "\n");
      }
      const out = gate ? await gateOf({ hook_event_name: "PreToolUse", session_id: sessionId, turn_id: "t1", cwd: project, model: "m",
        permission_mode: "default", tool_name: `mcp__sage__${name}`, tool_use_id: callId, tool_input: { project, ...args }, ...thread }, { env }) : undefined;
      if (agent && out) return { denied: out.hookSpecificOutput.permissionDecisionReason };
      assert.equal(out, undefined);
      const reply = await rpc("tools/call", { name, arguments: { project, ...args }, _meta: { callId, sessionId, threadId: sessionId } });
      assert.equal(reply.error, undefined);
      const text = reply.result.content.map((part) => part.text).join("\n");
      return reply.result.isError ? { error: text } : text;
    },
  };
}

test("the state server serves only a call that sage's gate saw: with no hook running, sage records nothing and says why (R1916-2)", async (t) => {
  const s = await connect(t);
  const NO_GATE = `sage's gate is not running. If sage's hooks are not installed yet, tell the user. To install them, the user runs this command in a terminal, or says yes and then the chief runs it (never without that yes): node "${join(s.dir, "plugin/skills/sage/sage.mjs")}" hooks install. Then the user trusts them with /hooks in the Codex CLI (or the app's hook review), and you try again.`;
  assert.deepEqual(await s.call("init", {}, { gate: false }), { error: NO_GATE }, "no proof");
  assert.deepEqual(await s.call("status", {}, { gate: false }), { error: NO_GATE }, "a read too");
  assert.equal(existsSync(join(s.env.CODEX_HOME, "sage")), false, "nothing written");
  assert.equal((await s.call("init", {}, { callId: "call_once" })).error, undefined, "the gate saw it");
  assert.equal(existsSync(join(s.env.CODEX_HOME, "sage")), true, "the logbook is made");
  assert.deepEqual(await s.call("init", {}, { gate: false, callId: "call_once" }), { error: NO_GATE }, "a proof serves one call");
  s.writeProof("status", "call_other", { role: "chief" });
  assert.deepEqual(await s.call("init", {}, { gate: false, callId: "call_other" }), { error: NO_GATE }, "a proof of another tool");
  for (const [id, caller] of [["no_caller", undefined], ["no_role", {}], ["bad_form", "chief"], ["null", null], ["other_role", { role: "qa", task: "T1", run: "R5" }], ["lead_no_task", { role: "lead", project: s.project }], ["lead_bad_task", { role: "lead", task: "12", project: s.project }],
    ["lead_no_project", { role: "lead", task: "T1" }], ["lead_bad_run", { role: "lead", task: "T1", run: "x", project: s.project }]]) {
    s.writeProof("status", id, caller);
    assert.deepEqual(await s.call("status", {}, { gate: false, callId: id }), { error: NO_GATE }, id);
  }
  s.writeProof("status", "chief_form", { role: "chief" });
  assert.equal((await s.call("status", {}, { gate: false, callId: "chief_form" })).error, undefined, "the chief's own form serves");
});

test("a shared logbook through the server: the root's session is one chief, a lead acts for it, a child reads, and a task with no chief takes the claim tool (T604)", async (t) => {
  const shared = realpathSync(mkdtempSync(join(tmpdir(), "sage-state-mcp-shared-")));
  t.after(() => rmSync(shared, { recursive: true, force: true }));
  const s = await connect(t, { SAGE_SHARED_HOME: shared });
  const other = "019a0000-0000-7000-8000-0000000000cc";
  await s.call("link", { separate: true });
  assert.match(await s.call("task_add", { title: "first", size: "small", priority: "P2" }), /^T1 framed .* · chief C1$/);
  assert.match((await s.call("task_set", { task: "T1", fields: { title: "taken" } }, { sessionId: other })).error, /^sage: T1 belongs to chief C1 \(codex\), not to C2\. Nothing changed\./);
  assert.match(await s.call("task_add", { title: "second", size: "small", priority: "P2" }, { sessionId: other }), /^T2 framed .* · chief C2$/);
  await s.call("task_set", { task: "T1", fields: { state: "briefed", branch: "sage/t1-a" } });
  assert.match(await s.call("run_add", { task: "T1", role: "lead" }), /^R1 running/);
  assert.match((await s.call("task_set", { task: "T1", fields: { state: "building" } }, { agent: LEAD })), /^T1 building/, "a lead acts for the chief of its lead run");
  assert.match(await s.call("run_add", { task: "T1", role: "qa" }, { agent: LEAD }), /^R2 running/);
  assert.match((await s.call("task_set", { task: "T1", fields: { title: "x" } }, { agent: `${LEAD}/sage_qa_t1_r2` })).denied, /./, "a child writes nothing");
  assert.match(await s.call("status", {}, { agent: `${LEAD}/sage_qa_t1_r2` }), /tasks {3}2/, "a child reads");
  const { tool } = await import(pathToFileURL(join(s.dir, "plugin/skills/sage/sage.mjs")).href);
  const dir = tool.storeDir(s.project, s.env), tasks = join(dir, "tasks.tsv");
  assert.equal(readFileSync(join(dir, "chiefs.tsv"), "utf8").trim().split("\n").length, 3, "a header and two chiefs: the lead made no row");
  writeFileSync(tasks, readFileSync(tasks, "utf8").replace(/\tC2\n/, "\t\n"));
  const version = /call the claim tool with this task and version ([0-9a-f]{64})/.exec((await s.call("task_set", { task: "T2", fields: { title: "x" } })).error)[1];
  assert.equal(await s.call("claim", { task: "T2", version }), "T2 claimed · chief C1");
  writeFileSync(join(dir, "chiefs.tsv"), "id\tother\n");
  assert.match((await s.call("task_add", { title: "third", size: "small", priority: "P2" })).error, /^sage: .*chiefs\.tsv is damaged, so sage cannot tell which chief owns a task/, "F-T604-18: the tool gives the real cause");
});

test("T893: a Codex chief abandons, through task_set with why, a task with no owning chief that came in the move from the Claude logbook; any other change still needs the claim", async (t) => {
  const shared = realpathSync(mkdtempSync(join(tmpdir(), "sage-state-mcp-abandon-")));
  t.after(() => rmSync(shared, { recursive: true, force: true }));
  const s = await connect(t, { SAGE_SHARED_HOME: shared });
  await s.call("link", { separate: true });
  await s.call("task_add", { title: "stale", size: "small", priority: "P2" });
  const { tool } = await import(pathToFileURL(join(s.dir, "plugin/skills/sage/sage.mjs")).href);
  const file = join(tool.storeDir(s.project, s.env), "tasks.tsv");
  const cells = () => { const [head, line] = readFileSync(file, "utf8").split("\n"); return { cols: head.split("\t"), row: line.split("\t") }; };
  const { cols, row } = cells(), adoption = { version: 2, provider: "claude", task: "T7", logbook: join(s.dir, "old"), project: s.project, round: 0, digest: "0".repeat(64) };
  writeFileSync(file, `${cols.join("\t")}\n${row.with(cols.indexOf("chief"), "").with(cols.indexOf("adoption"), JSON.stringify(adoption)).join("\t")}\n`);
  assert.equal((await s.call("task_set", { task: "T1", fields: { state: "abandoned" } })).error, `sage: T1 has no owning chief. Any chief may abandon it, with a reason: add --why "<reason>". Nothing changed.`);
  assert.match((await s.call("task_set", { task: "T1", fields: { state: "abandoned", priority: "P1" }, why: "stale" })).error, /^sage: T1 has no owning chief, so C1 cannot change it\. Claim it first: call the claim tool/);
  assert.match(await s.call("task_set", { task: "T1", fields: { state: "abandoned" }, why: "stale: Codex native runtime work" }), /^T1 abandoned /);
  const after = cells();
  assert.deepEqual([after.row[after.cols.indexOf("state")], after.row[after.cols.indexOf("chief")]], ["abandoned", ""], "the abandon gives the task to no chief");
  assert.match(readFileSync(join(tool.storeDir(s.project, s.env), "decisions.tsv"), "utf8").trim().split("\n").at(-1), /\tT1\tstate abandoned\tstale: Codex native runtime work · abandoned by C1, with no owning chief$/);
});

test("the transfer commands through the server: offer, accept, cancel, unclaim and a Replace by the owner's answer, with the rules of the state tool (T618)", async (t) => {
  const shared = realpathSync(mkdtempSync(join(tmpdir(), "sage-state-mcp-transfer-")));
  t.after(() => rmSync(shared, { recursive: true, force: true }));
  const s = await connect(t, { SAGE_SHARED_HOME: shared });
  const other = "019a0000-0000-7000-8000-0000000000cc", as = { sessionId: other };
  await s.call("link", { separate: true });
  await s.call("task_add", { title: "first", size: "small", priority: "P2" });
  await s.call("task_add", { title: "second", size: "small", priority: "P2" }, as);
  const [, first] = /offer ([0-9a-f]{8})/.exec(await s.call("offer", { task: "T1", to: "C2" }));
  assert.match((await s.call("offer", { task: "T1", to: "C2" }, as)).error, /^sage: T1 belongs to chief C1/);
  assert.equal(await s.call("cancel", { task: "T1", offer: first }), `T1 offer ${first} cancelled`);
  const [, declined] = /offer ([0-9a-f]{8})/.exec(await s.call("offer", { task: "T1", to: "C2" }));
  assert.equal(await s.call("cancel", { task: "T1", offer: declined }, as), `T1 offer ${declined} declined by C2 · chief C1 keeps T1`);
  const [, offer, version] = /offer ([0-9a-f]{8}) · version ([0-9a-f]{64})/.exec(await s.call("offer", { task: "T1", to: "C2" }));
  const tools = await s.tools(), describe = (name) => tools.find((one) => one.name === name).description;
  assert.match(describe("accept"), /The CLI's task command gives the offer's id \(in the task's offer cell\) and the version/);
  assert.match(describe("cancel"), /decline an offer that another chief made to you/);
  assert.match((await s.call("accept", { task: "T1", offer: first, version }, as)).error, /has the open offer/);
  assert.match((await s.call("accept", { task: "T1", offer, version })).error, /names C2, not C1/);
  assert.match(await s.call("accept", { task: "T1", offer, version }, as), /^G1 open · Hand T1 from C1 \(codex\) to C2 \(codex\)\? Runs that end as failed: none\. Approve: C2 owns T1\. C1 can no longer write T1\. .* Decline: C1 stays the owning chief, and the offer to C2 ends\. Title of T1: first\nAsk the owner to answer G1, in either chat\. Nothing changes until then\.$/);
  assert.match((await s.call("task_set", { task: "T1", fields: { title: "x" } }, as)).error, /^sage: T1 belongs to chief C1 \(codex\), not to C2\./, "the gate alone gives nothing");
  assert.equal(await s.call("gate_answer", { gate: "G1", option: 1 }), "G1 answered · approve · T1 chief C2");
  const { tool } = await import(pathToFileURL(join(s.dir, "plugin/skills/sage/sage.mjs")).href);
  const picked = JSON.parse(tool.read(tool.storeDir(s.project, s.env), "gates").find((g) => g.id === "G1").picked);
  assert.equal(picked.chief, "C1", "the gate records the chief whose tool applied the answer, not the receiving chief C2");
  assert.equal(await s.call("unclaim", { task: "T2" }, as), "T2 unclaimed · no owning chief. Only C2 claims it back; another chief needs the owner's takeover gate.");
  assert.match(await s.call("run_add", { task: "T1", role: "qa" }, as), /^R1 running/);
  assert.match(await s.call("gate_replace", { task: "T1", to: "C1" }), /^G2 open · Hand T1 from C2 \(codex\) to C1 \(codex\)\? Runs that end as failed: R1 \(qa\)\. Approve: C1 owns T1\. Each of those runs ends as failed, and work that it did not report may be lost\. .* Decline: nothing changes, and C2 stays the owning chief\. Title of T1: first\nAsk the owner to answer G2, in either chat\. Nothing changes until then\.$/);
  assert.equal(await s.call("gate_answer", { gate: "G2", option: 1 }), "G2 answered · approve · T1 chief C1 · R1 failed");
  assert.match((await s.call("task_set", { task: "T1", fields: { title: "x" } }, as)).error, /^sage: T1 belongs to chief C1 \(codex\), not to C2\./);
  assert.match(await s.call("verdict", { task: "T1", kind: "checks-pass", sha: SHA }), /^T1 checks-pass/);
  assert.match((await s.call("merge_check", { sha: SHA }, as)).error, /^sage: T1 belongs to chief C1 \(codex\), not to C2\. Nothing changed\./);
  assert.match((await s.call("merge_check", { sha: SHA })).error, /^sage: T1: 0 of 1 clean cycles on this SHA/, "the owning chief gets the cycle rule");
});

const OFF_LIST = (name) => `sage: "${name.replaceAll("_", " ")}" is not on a lead's list. A lead records only its own task, with run add, run done, finding add, finding close, finding triage, verdict, lint, round, pages, and task set of state, branch, pr. Put what else the logbook needs in your report`;
const BRIEF = ["GOAL", "SCOPE", "CONTEXT", "DECISIONS", "ACCEPTANCE", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"].map((field) => `${field}: the ${field.toLowerCase()}.`).join("\n");
const LEAD = "/root/sage_lead_t1_r1";
async function leadWorld(t) {
  const s = await connect(t);
  await s.call("init");
  for (const n of [1, 2]) {
    await s.call("task_add", { title: `task ${n}`, size: "small", priority: "P2" });
    await s.call("task_set", { task: `T${n}`, fields: { state: "briefed", branch: `sage/t${n}-a` } });
    await s.call("run_add", { task: `T${n}`, role: "lead" });
  }
  const { tool } = await import(pathToFileURL(join(s.dir, "plugin/skills/sage/sage.mjs")).href);
  return { ...s, tool, lead: (name, args, options) => s.call(name, args, { agent: LEAD, ...options }) };
}
async function reviewed(w, role, text, record = async () => {}) {
  const run = (await w.lead("run_add", { task: "T1", role })).split(" ")[0];
  w.tool.keepReport(w.project, { task: "T1", run, role, sha: SHA, text }, w.env);
  await record(run);
  assert.equal(await w.lead("run_done", { run, status: "done", tokens: 1 }), `${run} done`);
  return run;
}
const CLEAN = `STATUS done\nRESULT CLEAN\nEVIDENCE npm test passed\nFINDINGS none\nQUESTIONS none\nNOT VERIFIED none\nBRANCH sage/t1-a head ${SHA}`;
const FOUND = CLEAN.replace("RESULT CLEAN", "RESULT FINDINGS").replace("FINDINGS none", "FINDINGS\n- K1 medium a.js:1 a bad value\n  proof: npm test\n  saw: not ok 1 a bad value");
const proofCheck = (w, outcomes) => reviewed(w, "qa", CLEAN.replace("RESULT CLEAN", "RESULT PASS").replace("EVIDENCE npm test passed", `EVIDENCE\n${Object.entries(outcomes).map(([key, outcome]) => `- ${key} ${outcome}`).join("\n")}`));

test("T955: run_add gives each Codex role and size the reasoning effort of its model key, never a model, and a role with no effort gets none", async (t) => {
  const s = await connect(t);
  await s.call("init");
  await s.call("config", { settings: { max_agents: "50" } });
  for (const size of ["tiny", "small", "large"]) await s.call("task_add", { title: size, size, priority: "P2" });
  const expected = {
    T1: { "code-reviewer": "medium", "security-reviewer": "high", "ux-reviewer": "medium", qa: "medium", implementer: "medium", pe: "high", designer: "high" },
    T2: { "code-reviewer": "high", "security-reviewer": "high", "ux-reviewer": "medium", qa: "medium", implementer: "high", pe: "high", designer: "high" },
    T3: { "code-reviewer": "high", "security-reviewer": "high", "ux-reviewer": "medium", qa: "high", implementer: "high", pe: "high", designer: "high" },
  };
  let r = 0;
  for (const [task, roles] of Object.entries(expected)) {
    for (const [role, effort] of Object.entries(roles)) {
      const branch = { implementer: `sage/${task.toLowerCase()}-a`, designer: `sage/${task.toLowerCase()}-d` }[role];
      assert.equal(await s.call("run_add", { task, role, ...(branch && { branch }) }), `R${++r} running · ${role} on ${task}${branch ? ` · ${branch}` : ""} · reasoning_effort ${effort}`, `${role} on ${task}`);
    }
  }
  assert.equal(await s.call("run_add", { task: "T2", role: "lead" }), `R${++r} running · lead on T2`);
  for (const [value, line] of [["haiku", " · reasoning_effort low"], ["fable", ""], ["inherit", " · reasoning_effort high"]]) {
    assert.match(await s.call("config", { settings: { "model.qa.small": value } }), new RegExp(` model\\.qa\\.small=${value}(?: |$)`));
    assert.equal(await s.call("run_add", { task: "T2", role: "qa" }), `R${++r} running · qa on T2${line}`, value);
  }
  assert.match((await s.call("config", { settings: { "model.qa.small": "gpt-6-sol" } })).error, /^sage: model\.qa\.small is opus, sonnet, haiku, fable, or inherit/, "a key takes no Codex model name");
  const { tool } = await import(pathToFileURL(join(s.dir, "plugin/skills/sage/sage.mjs")).href);
  assert.deepEqual([...new Set(tool.read(tool.storeDir(s.project, s.env), "runs").map((run) => run.model))], [""]);
});

test("T552: a lead records its own task's cycle through the state server, from a build to a repair", async (t) => {
  const w = await leadWorld(t), { lead } = w;
  assert.match(await lead("task_set", { task: "T1", fields: { state: "building" } }), /^T1 building/);
  assert.equal(await lead("run_add", { task: "T1", role: "implementer", branch: "sage/t1-a" }), "R3 running · implementer on T1 · sage/t1-a · reasoning_effort high");
  assert.equal(await lead("brief", { task_name: "sage_implementer_t1_r3", brief: BRIEF }), "brief sage_implementer_t1_r3 checked: all 10 fields. Spawn the agent with this task name and this brief.");
  assert.equal(await lead("run_done", { run: "R3", status: "done" }), "R3 done");
  assert.match(await lead("task_set", { task: "T1", fields: { state: "reviewing", pr: "5" } }), /^T1 reviewing .* PR 5/);
  const found = await reviewed(w, "code-reviewer", FOUND, async (run) => assert.equal(await lead("finding_add", { task: "T1", source: "code-reviewer", severity: "medium", summary: "a.js:1 a bad value", run, class: "state-edge" }), "F-T1-1 open · medium · T1"));
  const proof = await proofCheck(w, { "F-T1-1": "reproduced" });
  assert.match(await lead("verdict", { task: "T1", kind: "findings", sha: SHA, pr: 5, run: found }), /^T1 findings · 1111111/);
  assert.equal(await lead("finding_triage", { task: "T1", key: "F-T1-1", decision: "fix", proof }), "F-T1-1 open · fix");
  assert.equal(await lead("round", { task: "T1" }), "T1 repairing · round 1 of 3 · fix F-T1-1 · re-run code-reviewer on the repair's diff");
  assert.equal(await lead("finding_close", { task: "T1", key: "F-T1-1" }), "F-T1-1 closed · fix");
  assert.match(await lead("task_set", { task: "T1", fields: { state: "reviewing" } }), /^T1 reviewing/);
  assert.equal(await lead("finding_add", { task: "T1", source: "qa", severity: "low", summary: "d.js:4 slow", run: found, class: "speed" }), "F-T1-2 open · low · T1");
  assert.equal(await lead("finding_triage", { task: "T1", key: "F-T1-2", decision: "dismiss", reason: "polish" }), "F-T1-2 dismissed · dismiss");
  const clean = await reviewed(w, "qa", CLEAN);
  assert.match(await lead("verdict", { task: "T1", kind: "qa-pass", sha: SHA, pr: 5, run: clean }), /^T1 qa-pass · 1111111/);
  const pages = await lead("pages", { task: "T1" });
  assert.match(await lead("pages", { task: "T1", run: clean, text: CLEAN }), new RegExp(`${clean}-report\\.md`));
  assert.ok(pages.endsWith("/pages/T1"), pages);
  assert.match(await lead("status"), /^sage · project/, "a lead reads as every child does");
});

test("T552: each call of a lead on another task is refused with its reason, by the gate and by the server", async (t) => {
  const w = await leadWorld(t), { lead } = w;
  await lead("task_set", { task: "T1", fields: { state: "building" } });
  await w.call("task_set", { task: "T2", fields: { state: "building" } });
  await w.call("task_set", { task: "T2", fields: { state: "reviewing" } });
  await w.call("run_add", { task: "T2", role: "qa" });
  await w.call("finding_add", { task: "T2", source: "qa", severity: "low", summary: "x", run: "R3", class: "other" });
  const before = readFileSync(join(w.env.CODEX_HOME, "sage", readdirSync(join(w.env.CODEX_HOME, "sage")).find((name) => name.startsWith("project-")), "runs.tsv"), "utf8");
  const other = /^sage: (?:T2|R2|R3|F-T2-1) is not of T1, and a lead records only its own task/;
  for (const [name, args] of [["run_add", { task: "T2", role: "qa" }], ["run_done", { run: "R3", status: "failed" }], ["run_done", { run: "R2", status: "failed" }], ["finding_add", { task: "T2", source: "qa", severity: "low", summary: "x", run: "R3", class: "other" }],
    ["finding_triage", { task: "T2", key: "F-T2-1", decision: "fix" }], ["finding_triage", { task: "T1", key: "F-T2-1", decision: "fix" }], ["finding_close", { task: "T2", key: "F-T2-1" }], ["finding_close", { task: "T1", key: "F-T2-1" }],
    ["verdict", { task: "T2", kind: "qa-pass", sha: SHA, pr: 5, run: "R3" }], ["round", { task: "T2" }], ["pages", { task: "T2" }], ["pages", { task: "T2", run: "R3", text: "x" }], ["task_set", { task: "T2", fields: { state: "verifying" } }]]) {
    const { denied } = await lead(name, args);
    assert.match(String(denied), other, `the gate: ${name} ${JSON.stringify(args)}`);
    const callId = `forced_${name}_${JSON.stringify(args).length}`;
    w.writeProof(name, callId, { role: "lead", task: "T1", run: "R1", project: w.project });
    assert.match(String((await w.call(name, args, { gate: false, callId })).error), other, `the server: ${name} ${JSON.stringify(args)}`);
  }
  assert.match((await lead("brief", { task_name: "sage_qa_t2_r9", brief: BRIEF })).denied, /^sage: a lead records a brief only for the team of T1, not for "sage_qa_t2_r9"/);
  assert.match((await lead("brief", { task_name: "sage_pe_t1_r9", brief: BRIEF })).denied, /^sage: a lead records a brief only for the team of T1, not for "sage_pe_t1_r9"/);
  assert.equal(readFileSync(join(w.env.CODEX_HOME, "sage", readdirSync(join(w.env.CODEX_HOME, "sage")).find((name) => name.startsWith("project-")), "runs.tsv"), "utf8"), before, "nothing changed");
});

test("T552: a lead's own task keeps the rules of the flow: its team, a kept report, the round, the chief's calls", async (t) => {
  const w = await leadWorld(t), { lead } = w;
  const refused = async (name, args, reason) => assert.match(String((await lead(name, args)).denied), reason, `${name} ${JSON.stringify(args)}`);
  await refused("run_add", { task: "T1", role: "lead" }, /^sage: a lead adds only runs of its team \(implementer, code-reviewer, security-reviewer, ux-reviewer, qa\), not "lead"/);
  await refused("run_add", { task: "T1", role: "pe" }, /adds only runs of its team/);
  await refused("run_add", { task: "T1", role: "implementer", branch: "sage/t2-a" }, /^sage: sage\/t2-a is not a branch of T1/);
  await refused("run_done", { run: "R1", status: "done" }, /^sage: R1 is a lead run: only the chief ends it/);
  await refused("finding_add", { task: "T1", source: "qa", severity: "low", summary: "x", key: "F-T1-1" }, /^sage: only the chief opens a known finding again/);
  for (const [name, args] of Object.entries({ task_add: { title: "x", size: "small", priority: "P2" }, gate_add: { task: "T1", question: "q", options: "a|b", recommend: "a" }, gate_answer: { gate: "G1", option: 1 },
    log: { task: "T1", decision: "d", why: "w" }, standing_add: { order: "o" }, report_compare: { task: "T1", run: "R1", sha256: "0".repeat(64) }, finding_move: { task: "T1", key: "F-T1-1", to: "later" } })) {
    assert.equal((await lead(name, args)).denied, OFF_LIST(name), name);
  }
  await refused("task_set", { task: "T1", fields: { title: "x" } }, /^sage: a lead sets only state, branch, pr of its task, not title/);
  await refused("task_set", { task: "T1", fields: { state: "merged" } }, /^sage: T1 is briefed: a lead moves it only to building/);
  await refused("task_set", { task: "T1", fields: { state: "abandoned" } }, /a lead moves it only to building/);
  await refused("task_set", { task: "T1", fields: { branch: "sage/t2-a" } }, /is not a branch named for T1/);
  await lead("task_set", { task: "T1", fields: { state: "building" } });
  await lead("task_set", { task: "T1", fields: { state: "reviewing" } });
  const qa = await reviewed(w, "qa", CLEAN);
  await refused("verdict", { task: "T1", kind: "qa-pass", sha: SHA, pr: 5, run: qa }, /^sage: a lead's verdict names its task's PR \(T1 has none yet/);
  await lead("task_set", { task: "T1", fields: { pr: "5" } });
  await refused("task_set", { task: "T1", fields: { pr: "6" } }, /^sage: a lead gives T1 one PR, once/);
  await refused("verdict", { task: "T1", kind: "checks-pass", sha: SHA, pr: 5 }, /^sage: the checks-pass verdict is the chief's/);
  await refused("verdict", { task: "T1", kind: "evidence-clean", sha: SHA, pr: 5 }, /^sage: the evidence-clean verdict is the chief's/);
  await refused("verdict", { task: "T1", kind: "qa-pass", sha: SHA, pr: 6, run: qa }, /names its task's PR \(pr 5\)/);
  await refused("verdict", { task: "T1", kind: "qa-pass", sha: SHA, pr: 5 }, /names a run of T1 in its current round 0, whose kept report backs it; "no run"/);
  const none = (await lead("run_add", { task: "T1", role: "code-reviewer" })).split(" ")[0];
  await lead("run_done", { run: none, status: "done", tokens: 1 });
  assert.match((await lead("verdict", { task: "T1", kind: "review-clean", sha: SHA, pr: 5, run: none })).error, new RegExp(`^sage: ${none} has no kept report`));
  await lead("finding_add", { task: "T1", source: "qa", severity: "medium", summary: "a", run: qa, class: "other" });
  await refused("finding_triage", { task: "T1", key: "F-T1-1", decision: "dismiss", reason: "r" }, /^sage: F-T1-1 is medium: a lead dismisses it only with --proof R<n>/);
  await refused("finding_triage", { task: "T1", key: "F-T1-1", decision: "ask" }, /^sage: a lead asks the owner nothing/);
  await refused("finding_close", { task: "T1", key: "F-T1-1" }, /^sage: F-T1-1 is not triaged fix/);
  await w.call("finding_triage", { task: "T1", key: "F-T1-1", decision: "ask" });
  await refused("finding_triage", { task: "T1", key: "F-T1-1", decision: "fix" }, /^sage: F-T1-1 is triaged ask: only the chief changes it/);
  await w.call("finding_triage", { task: "T1", key: "F-T1-1", decision: "fix" });
  await refused("finding_close", { task: "T1", key: "F-T1-1" }, /^sage: T1 has a medium or high finding triaged fix and is not repairing: run round T1 first/);
  const newer = await reviewed(w, "code-reviewer", CLEAN.replaceAll(SHA, "2".repeat(40)));
  await refused("verdict", { task: "T1", kind: "review-clean", sha: "2".repeat(40), pr: 5, run: newer }, /run round T1 first/);
  assert.match(await lead("round", { task: "T1" }), /^T1 repairing · round 1/);
  await lead("finding_add", { task: "T1", source: "qa", severity: "low", summary: "b", run: qa, class: "other" });
  await lead("finding_triage", { task: "T1", key: "F-T1-2", decision: "fix" });
  await refused("finding_close", { task: "T1", key: "F-T1-2" }, /^sage: F-T1-2 is not a fix of T1's round/);
  await refused("verdict", { task: "T1", kind: "review-clean", sha: "2".repeat(40), pr: 5, run: newer }, new RegExp(`names a run of T1 in its current round 1, whose kept report backs it; "${newer}"`));
  await refused("finding_triage", { task: "T1", key: "F-T1-1", decision: "dismiss", reason: "r" }, /is medium/);
  assert.match(await w.call("log", { task: "T1", decision: "T1 kept", why: "chief" }), /^logged$/);
  assert.match(await w.call("verdict", { task: "T1", kind: "checks-pass", sha: SHA }), /^T1 checks-pass/);
});

test("T552: a reviewer, QA, an implementer, a run of another task and a lead that is not the chief's child are refused; a lead stops with its lead run or its task", async (t) => {
  const w = await leadWorld(t), { lead } = w;
  const LOGBOOK = "sage: role agents report; only the chief records the logbook. Put this in your report";
  for (const agent of ["/root/sage_code_reviewer_t1_r5", "/root/sage_security_reviewer_t1_r5", "/root/sage_ux_reviewer_t1_r5", "/root/sage_qa_t1_r5", "/root/sage_implementer_t1_r5", `${LEAD}/sage_qa_t1_r5`, `${LEAD}/sage_implementer_t1_r5`,
    "/root/sage_pe_t1/sage_lead_t1_r1", "/root/worker/sage_lead_t1_r1", `${LEAD}/sage_lead_t1_r1`, "/root/sage_lead_x", "/root/Sage_Lead_T1_r1"]) {
    for (const [name, args] of [["run_add", { task: "T1", role: "qa" }], ["verdict", { task: "T1", kind: "qa-pass", sha: SHA, run: "R1" }], ["brief", { task_name: "sage_qa_t1_r9", brief: BRIEF }]]) {
      assert.equal((await w.call(name, args, { agent })).denied, LOGBOOK, `${agent} ${name}`);
    }
    assert.match(await w.call("status", {}, { agent }), /^sage · project/, `${agent} reads`);
    w.writeProof("run_add", `forced_${agent}`, { role: "child" });
    assert.equal((await w.call("run_add", { task: "T1", role: "qa" }, { gate: false, callId: `forced_${agent}` })).error, `${LOGBOOK}.`, "the server holds the rule itself");
  }
  assert.match((await lead("run_add", { task: "T1", role: "qa" }, { agent: "/root/sage_lead_t1_r9" })).denied, /^sage: T1 has no running lead run R9, so this lead records nothing/);
  assert.match(await lead("run_add", { task: "T1", role: "qa" }, { agent: "/root/sage_lead_t1" }), /^R3 running/, "a name with no run: its task's running lead run");
  const elsewhere = join(w.dir, "elsewhere");
  mkdirSync(elsewhere);
  execFileSync("git", ["init", "-q", elsewhere]);
  assert.match((await lead("run_add", { project: elsewhere, task: "T1", role: "qa" })).denied, /^sage: a lead records only the logbook of its own project/);
  await w.call("task_set", { task: "T1", fields: { state: "abandoned" } });
  assert.match((await lead("round", { task: "T1" })).denied, /^sage: T1 is abandoned, so its lead records nothing/);
  await w.call("run_done", { run: "R1", status: "failed" });
  assert.match((await lead("round", { task: "T1" })).denied, /^sage: T1 has no running lead run R1/);
});

test("T803: a Codex lead started on a framed task briefs it itself, then builds; a framed task with a design step stays the chief's", async (t) => {
  const s = await connect(t);
  await s.call("init");
  await s.call("task_add", { title: "task 1", size: "small", priority: "P2" });
  await s.call("task_add", { title: "task 2", size: "small", priority: "P2", add: "design", why: "a-screen-first" });
  for (const n of [1, 2]) assert.match(await s.call("run_add", { task: `T${n}`, role: "lead" }), new RegExp(`^R${n} running · lead on T${n}`), "the chief starts a lead on a framed task");
  const lead = (n, name, args) => s.call(name, args, { agent: `/root/sage_lead_t${n}_r${n}` });
  assert.match(await lead(1, "task_set", { task: "T1", fields: { state: "briefed" } }), /^T1 briefed /);
  assert.match(await lead(1, "task_set", { task: "T1", fields: { state: "building", branch: "sage/t1-a" } }), /^T1 building /);
  assert.match((await lead(2, "task_set", { task: "T2", fields: { state: "briefed" } })).denied, /^sage: T2 is framed, and its route has a design step: the chief runs the design before the brief\. Report to your chief/);
  assert.match(await s.call("status"), /building 1 · framed 1/, "T2 stays framed");
});

test("T803: a Codex lead's CI wait passes the gate, reads only its PR's head and checks with gh, and ends when CI ends", async (t) => {
  const s = await connect(t);
  await s.call("init");
  await s.call("task_add", { title: "task 1", size: "small", priority: "P2" });
  await s.call("task_set", { task: "T1", fields: { state: "briefed", branch: "sage/t1-a" } });
  await s.call("run_add", { task: "T1", role: "lead" });
  const git = (...args) => execFileSync("git", ["-C", s.project, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
  git("commit", "-q", "--allow-empty", "-m", "work");
  git("branch", "sage/t1-a");
  const sha = git("rev-parse", "sage/t1-a"), agent = "/root/sage_lead_t1_r1";
  await s.call("task_set", { task: "T1", fields: { state: "building" } }, { agent });
  await s.call("task_set", { task: "T1", fields: { state: "reviewing", pr: "5" } }, { agent });
  const bin = join(s.dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("fs"), at = (f) => require("path").join(__dirname, f), a = process.argv.slice(2);
fs.appendFileSync(at("log"), a.join(" ") + "\\n");
if (a.join(" ") === "pr view 5 --json headRefOid") { console.log(JSON.stringify({ headRefOid: ${JSON.stringify(sha)} })); process.exit(0); }
if (a.join(" ") !== "pr checks 5") { console.error("the fake gh does not know: " + a.join(" ")); process.exit(1); }
const [mode, ...rest] = fs.readFileSync(at("mode"), "utf8").split(" ");
fs.writeFileSync(at("mode"), (rest.length ? rest : [mode]).join(" "));
if (mode === "none") { console.error("no checks reported on the 'sage/t1-a' branch"); process.exit(1); }
console.log("build\\t" + mode + "\\t1m\\thttps://example.invalid/runs/1");
`, { mode: 0o755 });
  const script = join(s.dir, "plugin/skills/sage/ci-wait.mjs"), command = `${process.execPath} ${script} T1`;
  const thread = { agent_id: "agent-1", transcript_path: join(s.dir, "lead-shell.jsonl") };
  writeFileSync(thread.transcript_path, JSON.stringify({ type: "session_meta", payload: { id: "019a0000-0000-7000-8000-0000000000bb", agent_path: agent, source: { subagent: { thread_spawn: { depth: 1 } } } } }) + "\n");
  assert.equal(await s.gateOf({ hook_event_name: "PreToolUse", session_id: "019a0000-0000-7000-8000-0000000000aa", turn_id: "t1", cwd: s.project, model: "m", permission_mode: "default",
    tool_name: "Bash", tool_use_id: "ci-wait", tool_input: { command }, ...thread }, { env: s.env }), undefined, "the gate lets the lead run its CI wait");
  const wait = (mode) => {
    writeFileSync(join(bin, "mode"), mode);
    writeFileSync(join(bin, "log"), "");
    const r = spawnSync(process.execPath, [script, "T1"], { cwd: s.project, env: { ...s.env, PATH: `${bin}:${s.env.PATH}`, SAGE_WAIT_MS: "3000" }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return { out: r.stdout, log: readFileSync(join(bin, "log"), "utf8").trim().split("\n") };
  };
  const passed = wait("pending pending pass");
  assert.equal(passed.out, `CI pass · PR 5 · ${sha}\nbuild pass\nCI passed on this head: start the reviews and QA on it.\n`, "it waits while CI runs, and ends at the pass");
  assert.deepEqual(passed.log, Array(3).fill(["pr view 5 --json headRefOid", "pr checks 5"]).flat(), "three looks, each with the two reads only");
  assert.match(wait("fail").out, /^CI fail · PR 5 · [0-9a-f]{40}\nbuild fail\nCI failed on this head: start no review\. End blocked/);
  assert.match(wait("none").out, /^CI none · PR 5 · [0-9a-f]{40}\nThe pull request has no checks, so the project has no CI/, "no checks, after the grace for checks that come late");
});

async function reviewingWorld(t) {
  const w = await leadWorld(t);
  await w.lead("task_set", { task: "T1", fields: { state: "building" } });
  await w.lead("task_set", { task: "T1", fields: { state: "reviewing", pr: "5" } });
  return { ...w, found: await reviewed(w, "code-reviewer", FOUND, (run) => add({ ...w, found: run }, "medium")) };
}
const add = (w, severity, summary = "a.js:1 a bad value") => w.lead("finding_add", { task: "T1", source: "code-reviewer", severity, summary, run: w.found, class: "other" });
const triage = (w, key, decision = "fix", proof) => w.lead("finding_triage", { task: "T1", key, decision, proof });

test("T947: in a cycle, a lead triages a medium or high finding fix, or drops a medium one, only with a proof check; a high one is never its to drop", async (t) => {
  const w = await reviewingWorld(t), { lead } = w;
  await add(w, "high", "c.js:3 a crash");
  await add(w, "medium", "d.js:4 a leak");
  const proof = await proofCheck(w, { "F-T1-1": "not reproduced", "F-T1-2": "not reproduced", "F-T1-3": "reproduced" });
  assert.equal((await triage(w, "F-T1-3")).denied, `sage: F-T1-3 is medium: in a cycle, a lead triages it fix only with --proof R<n>, the done proof check whose report says F-T1-3 reproduced or could not run. Run the proof check first (the proof-check reference)`);
  assert.equal((await triage(w, "F-T1-2")).denied?.startsWith("sage: F-T1-2 is high: in a cycle, a lead triages it fix only with --proof"), true);
  assert.match((await lead("finding_triage", { task: "T1", key: "F-T1-1", decision: "dismiss", reason: "r" })).denied, /^sage: F-T1-1 is medium: a lead dismisses it only with --proof R<n>, the done proof check whose report says F-T1-1 not reproduced/);
  assert.match((await triage(w, "F-T1-2", "dismiss", proof)).denied, /^sage: F-T1-2 is high: a lead never dismisses it, also when the proof check did not reproduce it\. Report it, or triage it fix: the chief decides/);
  assert.match((await triage(w, "F-T1-3", "dismiss", proof)).error, new RegExp(`^sage: ${proof} says F-T1-3 reproduced, so it is not dismissed: triage it fix`));
  assert.equal(await triage(w, "F-T1-1", "dismiss", proof), "F-T1-1 dismissed · dismiss");
  assert.equal(await triage(w, "F-T1-3", "fix", proof), "F-T1-3 open · fix");
});

test("F-T552-1: a lead leaves repairing only after it closed each fix key of the round, so a correct repair never ends in replan", async (t) => {
  const w = await reviewingWorld(t), { lead } = w;
  await add(w, "low", "b.js:2 slow");
  await triage(w, "F-T1-1", "fix", await proofCheck(w, { "F-T1-1": "reproduced" }));
  await triage(w, "F-T1-2");
  assert.match(await lead("round", { task: "T1" }), /^T1 repairing · round 1/);
  const OPEN = "sage: T1 has an open fix finding of its round: close each one after the repair's commit (finding close), then move it to reviewing. When the re-check did not confirm one, run round T1: it starts the next round";
  assert.equal((await lead("task_set", { task: "T1", fields: { state: "reviewing" } })).denied, OPEN);
  assert.equal(await lead("finding_close", { task: "T1", key: "F-T1-1" }), "F-T1-1 closed · fix");
  assert.equal((await lead("task_set", { task: "T1", fields: { state: "reviewing" } })).denied, OPEN, "a low fix key of the round counts too");
  assert.equal(await lead("finding_close", { task: "T1", key: "F-T1-2" }), "F-T1-2 closed · fix");
  assert.match(await lead("task_set", { task: "T1", fields: { state: "reviewing" } }), /^T1 reviewing/);
});

test("F-T552-1: the refusal of finding_close gives a step that the lead can take in its state", async (t) => {
  const w = await leadWorld(t), { lead } = w;
  await lead("task_set", { task: "T1", fields: { state: "building" } });
  const qa = (await lead("run_add", { task: "T1", role: "qa" })).split(" ")[0];
  await lead("finding_add", { task: "T1", source: "qa", severity: "medium", summary: "a", run: qa, class: "other" });
  await triage(w, "F-T1-1");
  assert.match((await lead("round", { task: "T1" })).error, /^sage: T1 is building\. A repair starts from reviewing, verifying or repairing/, "so round is no step from here");
  const close = async () => (await lead("finding_close", { task: "T1", key: "F-T1-1" })).denied;
  assert.equal(await close(), "sage: T1 has a medium or high finding triaged fix and is not repairing: move T1 to reviewing first (task T1 set state=reviewing), then run round T1, then repair");
  await lead("task_set", { task: "T1", fields: { state: "reviewing" } });
  assert.equal(await close(), "sage: T1 has a medium or high finding triaged fix and is not repairing: run round T1 first, then repair");
  assert.match(await lead("round", { task: "T1" }), /^T1 repairing · round 1/);
  assert.equal(await lead("finding_close", { task: "T1", key: "F-T1-1" }), "F-T1-1 closed · fix");
});

const CHIEF_NAMES = ["/root/sage_chief_t1", "/root/worker/sage_chief_t1", "/root/sage_chief_t1_r9", "/root/sage_lead_t1_r1/sage_chief_t1"];

test("F-T552-5: a child named like a chief calls only what a child calls, at the gate and at the server", async (t) => {
  const w = await reviewingWorld(t);
  await add(w, "low");
  await w.call("gate_add", { task: "T1", question: "q", options: "a|b", recommend: "a" });
  const LOGBOOK = "sage: role agents report; only the chief records the logbook. Put this in your report";
  for (const agent of CHIEF_NAMES) {
    for (const [name, args] of [["gate_answer", { gate: "G1", option: 1 }], ["verdict", { task: "T1", kind: "checks-pass", sha: SHA }], ["task_set", { task: "T1", fields: { state: "merged" } }],
      ["finding_triage", { task: "T1", key: "F-T1-1", decision: "dismiss", reason: "r" }]]) {
      assert.equal((await w.call(name, args, { agent })).denied, LOGBOOK, `${agent} ${name}`);
      w.writeProof(name, `forced_${agent}_${name}`, { role: "child" });
      assert.equal((await w.call(name, args, { gate: false, callId: `forced_${agent}_${name}` })).error, `${LOGBOOK}.`, `the server: ${agent} ${name}`);
    }
    assert.match(await w.call("status", {}, { agent }), /^sage · project/, `${agent} reads`);
  }
  assert.match(await w.call("status"), /G1/, "the gate stays open");
  assert.match(await w.call("gate_answer", { gate: "G1", option: 1 }), /G1/, "the root thread is the chief");
});

test("F-T552-2: a lead moves no task off a branch that another task shares", async (t) => {
  const w = await leadWorld(t), { lead } = w;
  assert.match(await lead("task_set", { task: "T1", fields: { branch: "sage/t1-b" } }), /^T1 briefed/, "a free branch of its task");
  assert.match(await w.call("task_set", { task: "T2", fields: { branch: "sage/t1-b" } }), /^T2 briefed/);
  assert.equal((await lead("task_set", { task: "T1", fields: { branch: "sage/t1-c" } })).denied, "sage: sage/t1-b is shared with T2: only the chief moves a task onto a shared branch or off it");
});

test("F-T552-2: a task on a branch of another task keeps it for a lead: no move off it, and a run on it", async (t) => {
  const w = await leadWorld(t), { lead } = w;
  assert.match(await w.call("task_set", { task: "T1", fields: { branch: "sage/t2-a" } }), /^T1 briefed/);
  assert.equal((await lead("task_set", { task: "T1", fields: { branch: "sage/t1-c" } })).denied, 'sage: "sage/t1-c" is not a branch named for T1, or T1 is on a branch of another task: only the chief sets that');
  assert.match(await lead("run_add", { task: "T1", role: "implementer", branch: "sage/t2-a" }), /^R3 running · implementer on T1 · sage\/t2-a/, "a run on the task's own branch, whatever its name");
});

test("F-T552-2: a lead gives its task no PR that another task has or had", async (t) => {
  const w = await leadWorld(t), { lead } = w;
  await w.call("task_set", { task: "T2", fields: { pr: "7" } });
  assert.equal((await lead("task_set", { task: "T1", fields: { pr: "7" } })).denied, "sage: a lead gives T1 one PR, once, that no other task has or had");
  assert.match(await lead("task_set", { task: "T1", fields: { pr: "8" } }), /PR 8/);
});

test("F-T552-2: a lead dismisses no fix key of a round, of this round or an earlier one", async (t) => {
  const w = await reviewingWorld(t), { lead } = w;
  await add(w, "low", "b.js:2 slow");
  await add(w, "low", "c.js:3 slow");
  await triage(w, "F-T1-1");
  await triage(w, "F-T1-2");
  await lead("round", { task: "T1" });
  await lead("finding_close", { task: "T1", key: "F-T1-1" });
  await triage(w, "F-T1-3");
  for (const key of ["F-T1-2", "F-T1-3"]) {
    assert.equal((await lead("finding_triage", { task: "T1", key, decision: "dismiss", reason: "polish" })).denied, `sage: ${key} is a fix key of a round: only the chief dismisses it`);
  }
});

test("F-T552-2: a lead's verdict on a commit of the ledger passes while a repair waits, so a cycle's other reports still count", async (t) => {
  const w = await reviewingWorld(t), { lead } = w;
  await lead("verdict", { task: "T1", kind: "findings", sha: SHA, pr: 5, run: w.found });
  await triage(w, "F-T1-1");
  const other = await reviewed(w, "code-reviewer", FOUND, (run) => add({ ...w, found: run }, "medium"));
  assert.match(await lead("verdict", { task: "T1", kind: "findings", sha: SHA, pr: 5, run: other }), /^T1 findings · 1111111/);
});

test("F-T928-8: a Codex lead moves its task to verifying only when the head of its branch has a full clean cycle", async (t) => {
  const w = await leadWorld(t), { lead } = w;
  const git = (...args) => execFileSync("git", ["-C", w.project, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
  git("commit", "-q", "--allow-empty", "-m", "work");
  git("branch", "sage/t1-a");
  const head = git("rev-parse", "sage/t1-a"), NO_CYCLE = new RegExp(`^sage: T1's head ${head.slice(0, 7)} has no full clean cycle yet .* so T1 stays at reviewing: record them first`);
  await lead("task_set", { task: "T1", fields: { state: "building" } });
  await lead("task_set", { task: "T1", fields: { state: "reviewing", pr: "5" } });
  const verifying = () => lead("task_set", { task: "T1", fields: { state: "verifying" } });
  assert.match((await verifying()).denied, NO_CYCLE, "no verdict on the head");
  for (const [role, kind, result] of [["code-reviewer", "review-clean", "CLEAN"], ["qa", "qa-pass", "PASS"]]) {
    const run = (await lead("run_add", { task: "T1", role })).split(" ")[0];
    w.tool.keepReport(w.project, { task: "T1", run, role, sha: head, text: CLEAN.replace("RESULT CLEAN", `RESULT ${result}`).replaceAll(SHA, head) }, w.env);
    assert.equal(await lead("run_done", { run, status: "done", tokens: 1 }), `${run} done`);
    assert.match(await lead("verdict", { task: "T1", kind, sha: head, pr: 5, run }), new RegExp(`^T1 ${kind} · ${head.slice(0, 7)}`));
    if (kind === "review-clean") assert.match((await verifying()).denied, NO_CYCLE, "the review alone is no full clean cycle of a small task");
  }
  assert.match(await verifying(), /^T1 verifying/, "a full clean cycle on the head");
});

test("F-T928-10: a Codex lead's call that names no task, no run or no finding says so, with the lead's own task", async (t) => {
  const { lead } = await leadWorld(t);
  assert.equal((await lead("pages", {})).denied, 'sage: "pages" names no task: a lead names its own task, T1');
  assert.equal((await lead("run_done", { status: "failed" })).denied, 'sage: "run done" names no run: a lead names a run of T1');
  assert.equal((await lead("finding_close", { task: "T1" })).denied, 'sage: "finding close" names no finding: a lead names a finding of T1');
});

test("T956, T970: the gap rule holds a Codex lead at its next step, also its round: a medium finding of a kept report needs its row with the run; a low one does not", async (t) => {
  const w = await leadWorld(t), { lead } = w;
  await lead("task_set", { task: "T1", fields: { state: "building" } });
  await lead("task_set", { task: "T1", fields: { state: "reviewing", pr: "5" } });
  const run = (await lead("run_add", { task: "T1", role: "code-reviewer" })).split(" ")[0];
  w.tool.keepReport(w.project, { task: "T1", run, role: "code-reviewer", sha: SHA, text: FOUND.replace("- K1 medium", "- K2 low b.js:2 a typo\n- K1 medium") }, w.env);
  const GAP = `sage: ${run}'s code-reviewer report has a medium or high finding with no row on T1: K1 (medium). Record each one first with finding add, one row for each key: task T1, source code-reviewer, severity medium or above, run ${run}, its class and a summary`;
  const calls = [["run_add", { task: "T1", role: "code-reviewer" }], ["run_done", { run, status: "done", tokens: 1 }], ["task_set", { task: "T1", fields: { state: "verifying" } }], ["round", { task: "T1" }]];
  for (const [name, args] of calls) {
    assert.equal((await lead(name, args)).denied, GAP, `the gate: ${name}`);
    w.writeProof(name, `gap_${name}`, { role: "lead", task: "T1", run: "R1", project: w.project });
    const error = String((await w.call(name, args, { gate: false, callId: `gap_${name}` })).error);
    assert.ok(error.startsWith(GAP), `the server: ${name}: ${error}`);
  }
  assert.match(await lead("run_add", { task: "T1", role: "qa" }), /^R\d+ running · qa on T1/);
  await lead("finding_add", { task: "T1", source: "code-reviewer", severity: "low", summary: "a.js:1 a bad value", run, class: "other" });
  assert.equal((await lead(...calls[0])).denied, GAP, "a low row does not hold a medium finding");
  assert.match(await lead("finding_add", { task: "T1", source: "code-reviewer", severity: "medium", summary: "a.js:1 a bad value", run, class: "state-edge" }), /^F-T1-2 open · medium · T1$/);
  assert.equal(await lead("run_done", { run, status: "done", tokens: 1 }), `${run} done`);
  assert.match(await lead(...calls[0]), /^R\d+ running · code-reviewer on T1/);
});

test("T984: the message tool gives the chief the same text and page as the CLI's message command", async (t) => {
  const s = await connect(t);
  await s.call("init");
  await s.call("task_add", { title: "t", size: "small", priority: "P2" });
  const fixture = (name) => JSON.parse(readFileSync(join(ROOT, "scripts/fixtures/messages", name), "utf8"));
  const text = await s.call("message", { task: "T1", message: fixture("10-catch-up.json") });
  assert.match(text, /^CATCH-UP\n\nRelease 1\.0: the presentation skill is in\n/);
  const page = /\n {2}(\/\S+\/pages\/T1\/catch-up-[0-9a-f]{8}\.html)\n/.exec(text)?.[1];
  assert.ok(page && existsSync(page), text);
  assert.ok(page.startsWith(join(s.dir, "worktrees")), "in the task's pages folder");
  assert.match((await s.call("message", { task: "T1", message: { kind: "question", title: "Why?", blocks: [] } })).error, /^sage: the message is not in its kind's shape/);
});

test("the state server lists one tool for each state-tool command, and marks only the reads read-only", async (t) => {
  const s = await connect(t);
  const tools = await s.tools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["accept", "brief", "cancel", "chief_name", "claim", "config", "finding_add", "finding_close", "finding_move", "finding_triage", "gate_add", "gate_answer", "gate_give", "gate_replace", "gate_undo",
    "init", "link", "lint", "log", "merge_check", "message", "milestone_propose", "milestone_set", "move", "offer", "pages", "release_add", "report_compare", "round", "run_add", "run_done", "standing", "standing_add", "status", "task_add", "task_adopt", "task_set", "unclaim", "verdict", "worktrees"]);
  assert.deepEqual(tools.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name).sort(), ["merge_check", "report_compare", "standing", "status"]);
  assert.ok(tools.every((tool) => tool.inputSchema.required.includes("project") && tool.inputSchema.additionalProperties === false));
  const add = tools.find((tool) => tool.name === "task_add").inputSchema;
  assert.deepEqual([add.required.sort(), add.properties.priority.enum], [["priority", "project", "size", "title"], ["P0", "P1", "P2", "P3"]]);
});

test("T91: MCP compares synthetic retained reports with status-only results and existing admission", async t => {
  const s = await connect(t);
  const { tool } = await import(pathToFileURL(join(s.dir, "plugin/skills/sage/sage.mjs")).href);
  const dir = (await s.call("init")).slice(8);
  await s.call("task_add", { title: "Synthetic", size: "large", priority: "P2" });
  await s.call("run_add", { task: "T1", role: "pe" });
  const text = "STATUS question\nRESULT café 🙂\r\n ";
  const args = { task: "T1", run: "R1", sha256: createHash("sha256").update(text).digest("hex") };
  assert.match((await s.call("report_compare", args, { gate: false })).error, /gate is not running/);
  assert.equal(await s.call("report_compare", args), '{"status":"missing"}');
  tool.keepReport(s.project, { task: "T1", run: "R1", role: "pe", text }, s.env);
  await s.call("run_done", { run: "R1", status: "question" });
  assert.equal(await s.call("report_compare", args), '{"status":"match"}');
  assert.equal(await s.call("report_compare", { ...args, sha256: "0".repeat(64) }), '{"status":"mismatch"}');
  assert.match((await s.call("report_compare", { ...args, run: "R9" })).error, /comparison/);
  assert.match((await s.call("report_compare", { ...args, sha256: "bad" })).error, /validation/i);
  writeFileSync(join(dir, "kept/R1.json"), "{");
  assert.equal(await s.call("report_compare", args), '{"status":"damaged"}');
});

test("T108: a changed report cannot consume the save-once page; exact Markdown still backs its verdict", async t => {
  const w = await leadWorld(t);
  await w.lead("task_set", { task: "T1", fields: { state: "building" } });
  await w.lead("task_set", { task: "T1", fields: { state: "reviewing", pr: "5" } });
  const text = CLEAN.replace("EVIDENCE npm test passed", "EVIDENCE **Sample** test passed\n\n`café 🙂`\r\n");
  const run = await reviewed(w, "code-reviewer", text);
  const folder = await w.lead("pages", { task: "T1" });
  const path = join(folder, `${run}-report.md`);
  const dir = w.tool.storeDir(w.project, w.env);
  const before = readFileSync(join(dir, "decisions.tsv"), "utf8");
  for (const changed of [text.replace("**Sample**", "Sample"), text.replaceAll("\r\n", "\n"), `${text}\n`]) {
    const refused = await w.lead("pages", { task: "T1", run, text: changed });
    assert.match(refused.error, /does not match the retained report.*Nothing saved/);
    assert.equal(existsSync(path), false, "a mismatch leaves the first save available");
    assert.equal(readFileSync(join(dir, "decisions.tsv"), "utf8"), before, "no page decision for refused text");
    assert.equal(refused.error.includes("café"), false, "no retained text in the refusal");
  }
  const saved = await w.lead("pages", { task: "T1", run, text });
  assert.match(saved, / · sha256 [0-9a-f]{64}$/);
  assert.equal(readFileSync(path, "utf8"), text);
  assert.equal(await w.lead("pages", { task: "T1", run, text }), saved, "exact retry keeps the page");
  const sha256 = saved.split(" · sha256 ")[1];
  assert.equal(await w.call("report_compare", { task: "T1", run, sha256 }), '{"status":"match"}');
  assert.match(await w.lead("verdict", { task: "T1", kind: "review-clean", sha: SHA, pr: 5, run }), /^T1 review-clean/);
});

test("T108: record input cannot bypass report comparison or consume its first save", async t => {
  const w = await leadWorld(t);
  await w.lead("task_set", { task: "T1", fields: { state: "building" } });
  const run = (await w.lead("run_add", { task: "T1", role: "implementer", branch: "sage/t1-a" })).split(" ")[0];
  w.tool.keepReport(w.project, { task: "T1", run, role: "implementer", sha: SHA, text: CLEAN }, w.env);
  const folder = await w.lead("pages", { task: "T1" });
  const page = join(folder, `${run}-report.md`);
  const decisions = join(w.tool.storeDir(w.project, w.env), "decisions.tsv");
  const before = readFileSync(decisions, "utf8");
  for (const input of [
    { record: `--run=${run}`, text: "SAMPLE altered report" },
    { record: page, run }, { record: page, text: CLEAN }, { record: page, run, text: CLEAN },
    { record: page, text: "" }, { record: page, run: "" },
    { record: `--run=${run}` }, { record: "relative/report.md" }, { record: "" },
  ]) {
    const refused = await w.lead("pages", { task: "T1", ...input });
    assert.equal(typeof refused.error, "string", JSON.stringify(input));
    assert.equal(existsSync(page), false, "invalid input leaves the first save available");
    assert.equal(readFileSync(decisions, "utf8"), before, "no decision for invalid input");
  }
  assert.match(await w.lead("pages", { task: "T1", run, text: CLEAN }), / · sha256 /);
  assert.equal(readFileSync(page, "utf8"), CLEAN);
  assert.match(await w.lead("pages", { task: "T1", record: page }), / · sha256 /);
});

test("T108: page preflight preserves admission, damaged capture and missing-capture verdict refusals", async t => {
  const w = await leadWorld(t);
  await w.lead("task_set", { task: "T1", fields: { state: "building" } });
  await w.lead("task_set", { task: "T1", fields: { state: "reviewing", pr: "5" } });
  const run = (await w.lead("run_add", { task: "T1", role: "code-reviewer" })).split(" ")[0];
  const args = { task: "T1", run, text: CLEAN };
  assert.match((await w.call("pages", args, { gate: false })).error, /gate is not running/);
  assert.match((await w.call("pages", args, { agent: `/root/sage_code_reviewer_t1_${run.toLowerCase()}` })).denied, /only the chief records/);
  assert.match((await w.lead("pages", { ...args, task: "T2" })).denied, /own task/);
  assert.match((await w.call("pages", { ...args, task: "T2" })).error, /--run is a run of T2/);
  const folder = await w.lead("pages", { task: "T1" });
  const dir = w.tool.storeDir(w.project, w.env);
  w.tool.keepReport(w.project, { task: "T1", run, role: "code-reviewer", sha: SHA, text: CLEAN }, w.env);
  writeFileSync(join(dir, `kept/${run}.json`), "{");
  assert.match((await w.lead("pages", args)).error, /retained report is damaged.*Nothing saved/);
  assert.equal(existsSync(join(folder, `${run}-report.md`)), false);
  const missing = (await w.lead("run_add", { task: "T1", role: "code-reviewer" })).split(" ")[0];
  assert.match(await w.lead("pages", { ...args, run: missing }), / · sha256 /, "manual pages still work without capture");
  await w.lead("run_done", { run: missing, status: "done", tokens: 1 });
  assert.match((await w.lead("verdict", { task: "T1", kind: "review-clean", sha: SHA, pr: 5, run: missing })).error, /has no kept report/);
  assert.throws(() => w.tool.keepReport(w.project, { task: "T1", run: missing, role: "code-reviewer", sha: SHA, text: CLEAN }, w.env), /ended as done/);
  await w.call("run_done", { run: "R1", status: "failed" });
  assert.match((await w.lead("pages", args)).denied, /no running lead run/);
});

test("T48: task_adopt and approved repair reach the shared rule through Codex MCP", async t => {
  const bin = mkdtempSync(join(tmpdir(), 'sage-adoption-mcp-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const fake = join(bin, 'gh');
  writeFileSync(fake, `#!${process.execPath}\nif (process.argv[2] === '--fake-proof') console.log('FAKE_mcp_adoption'); else if (process.argv.slice(2).join(' ') === 'pr view 362 --json headRefName,isCrossRepository') console.log(JSON.stringify({ headRefName: 'sage/t536-adopt', isCrossRepository: false })); else process.exit(1);\n`);
  chmodSync(fake, 0o755);
  assert.equal(spawnSync(fake, ['--fake-proof'], { encoding: 'utf8' }).stdout.trim(), 'FAKE_mcp_adoption');
  const s = await connect(t, { PATH: `${bin}:${process.env.PATH}` });
  const { tool } = await import(pathToFileURL(join(s.dir, 'plugin/skills/sage/sage.mjs')).href);
  const sourceEnv = { ...s.env, SAGE_HOME: join(s.dir, 'claude', 'sage') };
  const source = tool.command(['init', '--project', s.project], sourceEnv).text.slice(8);
  assert.equal(tool.command(['task', 'add', '--title', 'Source', '--size', 'small', '--risk', 'auth', '--priority', 'P0', '--project', s.project], sourceEnv).code, 0);
  const tasks = join(source, 'tasks.tsv'), rows = readFileSync(tasks, 'utf8').trimEnd().split('\n');
  const cols = rows[0].split('\t'), values = rows[1].split('\t');
  for (const [key, value] of Object.entries({ id: 'T536', pr: '362', round: '4', state: 'reviewing' })) values[cols.indexOf(key)] = value;
  writeFileSync(tasks, `${rows[0]}\n${values.join('\t')}\n`);
  const before = readFileSync(tasks, 'utf8');
  const dest = (await s.call('init')).slice(8);
  await s.call('task_add', { title: 'Destination', size: 'small', priority: 'P0', risk: 'auth' });
  const args = { task: 'T1', 'source-logbook': source, 'source-provider': 'claude', 'source-task': 'T536', pr: '362', branch: 'sage/t536-adopt' };
  assert.equal(await s.call('task_adopt', args), 'T1 adopted · claude T536 · PR 362 · sage/t536-adopt · round 4; fresh destination reviews and QA required');
  assert.equal(tool.read(dest, 'tasks')[0].round, '4');
  assert.equal(readFileSync(tasks, 'utf8'), before);
  assert.match(await s.call('task_set', { task: 'T1', fields: { branch: 'sage/t536-adopt', state: 'briefed' } }), /T1 briefed.*round 4/);
  assert.match((await s.call('merge_check', { sha: SHA, pr: 362, head: 'sage/t536-adopt' })).error, /no verdicts/);
  for (const state of ['building', 'reviewing']) await s.call('task_set', { task: 'T1', fields: { state } });
  const run = (await s.call('run_add', { task: 'T1', role: 'qa' })).split(' ')[0];
  await s.call('run_done', { run, status: 'done', tokens: 1 });
  await s.call('finding_add', { task: 'T1', source: 'qa', severity: 'medium', summary: 'Repair needed', run, class: 'state-edge' });
  assert.match(await s.call('finding_triage', { task: 'T1', key: 'F-T1-1', decision: 'fix' }), /open · fix/);
  assert.match(await s.call('round', { task: 'T1' }), /held: 4 repair rounds/);
  assert.match((await s.call('task_set', { task: 'T1', fields: { state: 'building' } })).error, /approval/);
  await s.call('gate_add', { task: 'T1', question: 'Approve one more repair round for T1 after 4 spent rounds and limit 3?', options: 'approve|decline', recommend: 'approve' });
  await s.call('gate_answer', { gate: 'G1', option: 1 });
  assert.match(await s.call('task_set', { task: 'T1', fields: { state: 'building', approval: 'G1' } }), /T1 building.*round 4/);
  assert.equal(tool.read(dest, 'tasks')[0].extra, '2');
  await s.call('task_set', { task: 'T1', fields: { state: 'reviewing' } });
  assert.match(await s.call('round', { task: 'T1' }), /round 5 of 5/);
  await s.call('task_set', { task: 'T1', fields: { state: 'reviewing' } });
  assert.match(await s.call('round', { task: 'T1' }), /held: 5 repair rounds/);
  assert.match((await s.call('task_set', { task: 'T1', fields: { state: 'building', approval: 'G1' } })).error, /approval/);
});

test("T804: the round tool takes why: with autopilot on in the root's mode file, the chief gives round 4 itself; with it off, round 4 holds", async (t) => {
  const shared = realpathSync(mkdtempSync(join(tmpdir(), "sage-state-mcp-rounds-")));
  t.after(() => rmSync(shared, { recursive: true, force: true }));
  const s = await connect(t, { SAGE_SHARED_HOME: shared });
  const { modeDirectory, stateKey } = await import(pathToFileURL(join(s.dir, "plugin/hooks/hook-state.mjs")).href);
  const mode = join(modeDirectory(s.env), `${stateKey({ session_id: "019a0000-0000-7000-8000-0000000000aa" })}.json`);
  const autopilot = (on) => { mkdirSync(modeDirectory(s.env), { recursive: true, mode: 0o700 }); writeFileSync(mode, JSON.stringify({ sage: true, autopilot: on }), { mode: 0o600 }); };
  await s.call("link", { separate: true });
  await s.call("task_add", { title: "a", size: "small", priority: "P2" });
  for (const state of ["briefed", "building", "reviewing"]) await s.call("task_set", { task: "T1", fields: { state } });
  const run = (await s.call("run_add", { task: "T1", role: "qa" })).split(" ")[0];
  await s.call("run_done", { run, status: "done", tokens: 1 });
  for (let n = 1; n <= 4; n++) {
    if (n > 1) await s.call("finding_close", { task: "T1", key: `F-T1-${n - 1}` });
    await s.call("finding_add", { task: "T1", source: "qa", severity: "medium", summary: `problem ${n}`, run, class: "other" });
    await s.call("finding_triage", { task: "T1", key: `F-T1-${n}`, decision: "fix" });
    if (n === 4) break;
    assert.match(await s.call("round", { task: "T1" }), new RegExp(`round ${n} of 3`));
    await s.call("task_set", { task: "T1", fields: { state: "reviewing" } });
  }
  autopilot(false);
  assert.match(await s.call("round", { task: "T1", why: "close" }), /^T1 held: 3 repair rounds/);
  assert.match((await s.call("round", { task: "T1", why: "close" })).error, /T1 stays held: autopilot is off for this chief's session/);
  autopilot(true);
  assert.equal(await s.call("round", { task: "T1", why: "close" }), "T1 repairing · round 4 of 4 · fix F-T1-4 · re-run qa on the repair's diff");
});

test("T594: the link tool starts a shared logbook or joins one, with the CLI's refusals, and the server finds both roots", async (t) => {
  const shared = realpathSync(mkdtempSync(join(tmpdir(), "sage-state-mcp-shared-")));
  t.after(() => rmSync(shared, { recursive: true, force: true }));
  const s = await connect(t, { SAGE_SHARED_HOME: shared });
  const form = /^(?:.*: )?link takes exactly one of --to <folder> or --separate; --separate takes no value\. Nothing changed\.$/;
  assert.match((await s.call("link", {})).error, form);
  assert.match((await s.call("link", { to: "a-123456", separate: true })).error, form);
  assert.match((await s.call("link", { to: "Not A Folder" })).error, /"Not A Folder" is not a logbook folder: its name is <project>-<6 hex>, as sage link prints it/);
  assert.match((await s.call("link", { to: "absent-123456" })).error, /is not a logbook of the shared root\. Nothing changed\. Run sage link --separate to start a new logbook\.$/);
  assert.match(await s.call("link", { separate: true }), new RegExp(`now uses the shared logbook ${shared}/project-[0-9a-f]{6}$`));
  assert.match(await s.call("link", { separate: true }), /^already linked: /);
  assert.match(await s.call("task_add", { title: "Shared", size: "tiny", priority: "P2" }), /T1/);
  assert.deepEqual(readdirSync(join(s.env.CODEX_HOME, "sage")).filter((name) => name.startsWith("project-")), [], "no Codex logbook");
  assert.equal(readFileSync(join(shared, "plugins.tsv"), "utf8").split("\n")[1].split("\t").slice(0, 2).join(" "), "codex 2");
});

test("T594 with T552: a lead's rules read the shared logbook, and only the chief links", async (t) => {
  const shared = realpathSync(mkdtempSync(join(tmpdir(), "sage-state-mcp-shared-")));
  t.after(() => rmSync(shared, { recursive: true, force: true }));
  const s = await connect(t, { SAGE_SHARED_HOME: shared });
  const folder = (await s.call("link", { separate: true })).split(" ").at(-1);
  await s.call("task_add", { title: "Shared", size: "small", priority: "P2" });
  await s.call("task_set", { task: "T1", fields: { state: "briefed", branch: "sage/t1-a" } });
  await s.call("run_add", { task: "T1", role: "lead" });
  assert.match(await s.call("run_add", { task: "T1", role: "qa" }, { agent: LEAD }), /^R2 running/);
  assert.match(readFileSync(join(folder, "runs.tsv"), "utf8"), /\nR2\tT1\tqa\t/);
  const bindings = readFileSync(join(shared, "bindings.tsv"), "utf8");
  const LINK_LEAD = OFF_LIST("link");
  const LINK_CHILD = "sage: role agents report; only the chief records the logbook. Put this in your report";
  for (const [agent, reason, caller] of [[LEAD, LINK_LEAD, { role: "lead", task: "T1", run: "R1", project: s.project }], ["/root/sage_qa_t1_r2", LINK_CHILD, { role: "child" }]]) {
    assert.equal((await s.call("link", { separate: true }, { agent })).denied, reason, `the gate, ${agent}`);
    s.writeProof("link", `forced_${agent}`, caller);
    assert.equal((await s.call("link", { separate: true }, { gate: false, callId: `forced_${agent}` })).error, `${reason}.`, `the server, ${agent}`);
  }
  assert.equal(readFileSync(join(shared, "bindings.tsv"), "utf8"), bindings, "no refused call changes the table");
});

test("the Codex chief's list of tools names the link tool, with the owner's answer first", () => {
  const { PROJECT_SETUP } = JSON.parse(readFileSync(join(ROOT, "plugins/sage-codex/chief-bindings.json"), "utf8"));
  assert.match(PROJECT_SETUP, /`link`\. Call `link` only after the owner's answer in the chat\./);
});

async function moveWorld(t, { claudeRow = true } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-state-mcp-move-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const shared = join(base, "shared"), claudeRoot = join(base, "claude-config", "sage");
  const s = await connect(t, { SAGE_SHARED_HOME: shared, CLAUDE_CONFIG_DIR: join(base, "claude-config"), SAGE_TEST_PIDS: "{}" });
  const codexRoot = join(s.env.CODEX_HOME, "sage");
  execFileSync("git", ["-C", s.project, "-c", "user.name=Fixture", "-c", "user.email=fixture@users.noreply.github.com", "commit", "-q", "--allow-empty", "-m", "first"]);
  const roots = () => [{ provider: "claude", path: claudeRoot }, { provider: "codex", path: codexRoot }];
  const { createStateTool } = await import("../packages/sage-core/index.mjs");
  const tool = createStateTool({ provider: "claude", defaultRoot: () => claudeRoot, legacyRoots: roots });
  const env = { ...process.env, HOME: s.env.HOME, SAGE_HOME: claudeRoot, SAGE_SHARED_HOME: shared, SAGE_TEST_PIDS: "{}" };
  const claude = (args, extra = {}) => {
    const { code, text } = tool.command([...args, "--project", s.project], { ...env, ...extra }, { project: s.project, native: "claude-chief" });
    if (code) throw new Error(text);
    return text;
  };
  if (claudeRow) {
    claude(["init"]);
    claude(["task", "add", "--title", "claude open", "--size", "tiny", "--priority", "P2"]);
  }
  await s.call("init");
  await s.call("task_add", { title: "codex open", size: "tiny", priority: "P2" });
  const folder = basename(tool.storeDir(s.project, env));
  return { s, claude, shared, folder, claudeDir: join(claudeRoot, folder), codexDir: join(codexRoot, folder) };
}
const planOf = (preview) => /plan ([0-9a-f]{8})\n/.exec(preview)[1];

test("T658: the Codex move tool moves a project with a Claude and a Codex logbook: preview, gate, the owner's answer, then the move, with the Claude logbook marked", async (t) => {
  const { s, claude, shared, folder, claudeDir, codexDir } = await moveWorld(t);
  claude(["run", "add", "T1", "--role", "pe"]);
  assert.match((await s.call("move", { preview: true })).error, /^sage: refused: 1 run is running in this project\n[\s\S]*The move needs zero running runs\. Nothing changed\.$/);
  claude(["run", "done", "R1", "--status", "blocked"]);
  const preview = await s.call("move", { preview: true });
  assert.match(preview, /^Move preview · project project {2,}plan [0-9a-f]{8}\nRead only\. Nothing changed\.\n\nWhat moves {11}Claude {11}Codex\n/);
  const plan = planOf(preview);
  const gate = await s.call("move", { plan });
  const id = /^(G\d+) · move · plan /.exec(gate)[1];
  assert.match(gate, /\n1 · move RECOMMENDED\nMoves the project now, exactly as in the preview\.\n2 · keep\n/);
  assert.match(readFileSync(join(codexDir, "gates.tsv"), "utf8"), new RegExp(`\\n${id}\\t\\tmove · plan ${plan}`), "the Codex logbook holds the move gate");
  assert.equal((await s.call("move", { gate: id })).error, `sage: refused: ${id} has no answer yet, so nothing moves. Nothing changed. The owner answers it first.`);
  assert.match(await s.call("gate_answer", { gate: id, option: 1 }), new RegExp(`^${id} `));
  const moved = await s.call("move", { gate: id });
  assert.match(moved, /Reconciliation · every count matches the plan/);
  assert.equal(JSON.parse(readFileSync(join(claudeDir, "moved.json"), "utf8")).folder, folder);
  assert.ok(existsSync(join(claudeDir, "tasks.before-move.tsv")));
  assert.match(readFileSync(join(claudeDir, "tasks.tsv"), "utf8").split("\n")[0], /\tmoved$/);
  assert.ok(existsSync(join(codexDir, "moved.json")));
  assert.match(readFileSync(join(shared, "bindings.tsv"), "utf8"), new RegExp(`\\n${s.project}\\t${folder}\\t`));
  const added = /^(T\d+) /.exec(await s.call("task_add", { title: "after the move", size: "tiny", priority: "P2" }))[1];
  assert.equal(added, "T4", "the new numbers start above both old logbooks: T2 and T3 are the moved tasks");
  assert.equal(claude(["task", added]), "T4 framed · tiny · round 0 · route build · P2 · chief C1", "Claude reads the Codex chief's new task");
});

test("T658: the Codex move tool takes only its three forms, and no other text reaches the state tool", async (t) => {
  const { s, codexDir } = await moveWorld(t, { claudeRow: false });
  const gates = () => readFileSync(join(codexDir, "gates.tsv"), "utf8");
  const before = gates();
  for (const input of [{ preview: false }, { plan: "7C41E09A" }, { plan: "--gate=G1" }, { plan: "7c41e09a extra" }, { gate: "G1 --plan=7c41e09a" }, { gate: "g1" }, { gate: "G0" }, { other: "x" }])
    assert.match((await s.call("move", input)).error, /^Input validation error: /, JSON.stringify(input));
  const one = /^(?:.*: )?move takes one of --preview, --plan <plan> \(the 8 hex that the preview printed\) or --gate <G> \(the answered move gate\); --preview takes no value\. Nothing changed\.$/;
  for (const input of [{}, { preview: true, plan: "7c41e09a" }, { plan: "7c41e09a", gate: "G1" }]) assert.match((await s.call("move", input)).error, one, JSON.stringify(input));
  assert.equal(gates(), before, "no refused call opens a gate");
  const preview = await s.call("move", { preview: true });
  assert.match(preview, /What moves {11}Codex\n/);
  const gate = await s.call("move", { plan: planOf(preview) });
  assert.match(gate, /\n1 · move, and record Claude as unused RECOMMENDED\nOnly if you do not use Claude on this project\. Sage writes "Claude: unused" and does not wait for the Claude plugin\. This answer counts for every project of this shared root: a later move or a new project does not wait for the Claude plugin either\.\n2 · keep\n/);
  const id = /^(G\d+) /.exec(gate)[1];
  await s.call("task_add", { title: "after the preview", size: "tiny", priority: "P2" });
  await s.call("gate_answer", { gate: id, option: 1 });
  assert.equal((await s.call("move", { gate: id })).error, `sage: refused: the logbooks changed after plan ${planOf(preview)}\n  Codex: 1 more open task (T2)\nNothing changed. ${id} is closed: its answer covers plan ${planOf(preview)} only, and a move gate answers once. Show the owner a new preview (sage move --preview), then open a new gate (sage move --plan <plan>).`);
  assert.match((await s.call("move", { plan: planOf(preview) })).error, /^sage: refused: plan [0-9a-f]{8} is not the plan of the logbooks now: the preview now gives plan [0-9a-f]{8}\n {2}If plan [0-9a-f]{8} was typed by hand, check its 8 hex\. If not, a logbook changed after the preview\.\nNothing changed\. Show the owner the preview again \(sage move --preview\), then open the gate with its plan\.$/);
  assert.equal(existsSync(join(codexDir, "moved.json")), false, "nothing moved");
});

test("T658: a move that stopped in Claude refuses every Codex tool of the project, and the Codex move tool with the same gate finishes it", async (t) => {
  const { s, claude, shared, folder, claudeDir } = await moveWorld(t);
  const plan = planOf(claude(["move", "--preview"])), id = /^(G\d+) /.exec(claude(["move", "--plan", plan]))[1];
  claude(["gate", "answer", id, "--option", "1"]);
  assert.throws(() => claude(["move", "--gate", id], { SAGE_TEST_MOVE_STOP: "3" }), /test stop after step 3/);
  assert.ok(existsSync(join(claudeDir, "moved.json")) && existsSync(join(shared, "moves", `${folder}.json`)));
  const stopped = await s.call("task_add", { title: "while it stopped", size: "tiny", priority: "P2" });
  assert.match(stopped.error, new RegExp(`refused: the move of project project did not finish[\\s\\S]*To finish: sage move --gate ${id} \\(the same command\\)`));
  const finished = await s.call("move", { gate: id });
  assert.match(finished, /Reconciliation · every count matches the plan/);
  assert.equal(existsSync(join(shared, "moves", `${folder}.json`)), false, "the plan is removed");
  assert.match(await s.call("task_add", { title: "after the finish", size: "tiny", priority: "P2" }), /^T\d+ /);
});

test("T658: the Codex chief's list of tools names the move tool, with the owner's answer before gate", () => {
  const { PROJECT_SETUP } = JSON.parse(readFileSync(join(ROOT, "plugins/sage-codex/chief-bindings.json"), "utf8"));
  const [list] = /The tools are .*?\./.exec(PROJECT_SETUP);
  assert.ok(list.includes("`move`"), list);
  assert.match(PROJECT_SETUP, /To move a project into one shared logbook when the owner asks, call `move` with `preview`, then with `plan`, and put the gate to the owner word for word; call it with `gate` only after the owner's answer in the chat\./);
  assert.match(PROJECT_SETUP, /When a tool refuses with `sage move --gate <G>`, call `move` with that gate at once\./);
});

test("F-T618-3: the Codex chief's list of tools names each tool that moves a task between chiefs", () => {
  const { PROJECT_SETUP } = JSON.parse(readFileSync(join(ROOT, "plugins/sage-codex/chief-bindings.json"), "utf8"));
  const [list] = /The tools are .*?\./.exec(PROJECT_SETUP);
  for (const name of ["claim", "offer", "cancel", "accept", "unclaim", "gate_replace"]) assert.ok(list.includes(`\`${name}\``), name);
});

test("the Codex settings pass both roots to the state server", () => {
  const { env_vars: vars } = JSON.parse(readFileSync(join(ROOT, "plugins/sage-codex/.mcp.json"), "utf8")).mcpServers.sage;
  assert.deepEqual(vars, ["CODEX_HOME", "SAGE_HOME", "SAGE_SHARED_HOME", "CLAUDE_CONFIG_DIR"]);
});

test("each tool writes the Codex logbook in CODEX_HOME/sage, and returns each refusal as a tool error with its reason", async (t) => {
  const s = await connect(t);
  const call = s.call;
  assert.match((await call("status")).error, /^sage: no logbook for the project .*project\. Run: sage init --project /);
  const logbook = (await call("init")).replace(/^logbook /, "");
  assert.match(logbook, new RegExp(`^${s.env.CODEX_HOME}/sage/project-[0-9a-f]{6}$`));
  assert.match(await call("status"), /^sage · project · \d\d:\d\d UTC\ntasks {3}0\n/);
  assert.match((await call("init", { project: "relative/path" })).error, /^Input validation error: .*project: an absolute path/);

  assert.equal(await call("task_add", { title: "--why=x first", size: "small", priority: "P2" }), "T1 framed · small · route build,code-review,qa · P2");
  assert.match(readFileSync(join(logbook, "tasks.tsv"), "utf8"), /\nT1\t--why=x first\t/);
  assert.equal((await call("task_add", { title: "bad", size: "small", risk: "bogus", priority: "P2" })).error,
    "sage: unknown: bogus. Risks: auth, data, schema, money, secrets, input. Blocks: design, arena, pe, build, code-review, security-review, ux-review, qa, investigate, evidence-review");
  assert.match((await call("task_add", { title: "bad", size: "huge", priority: "P2" })).error, /^Input validation error: .*size/);
  assert.match((await call("task_add", { title: "bad", size: "small", colour: "red", priority: "P2" })).error, /^Input validation error: .*colour/);
  const scale = "A task needs a priority: P0 the owner's current focus and what blocks it; P1 next: function or safety bugs, work in flight, pre-pilot items; P2 later: polish, hardening lows, follow-ups; P3 parked but kept.";
  for (const input of [{ title: "none", size: "small" }, { title: "bad", size: "small", priority: "P4" }]) {
    const { error } = await call("task_add", input);
    assert.match(error, /^Input validation error: .*priority/);
    assert.ok(error.includes(scale), error);
  }
  assert.doesNotMatch(readFileSync(join(logbook, "tasks.tsv"), "utf8"), /\nT2\t/);
  assert.equal(await call("task_set", { task: "T1", fields: { priority: "none" } }).then((r) => r.error), `sage: ${scale} T1 is framed, so its priority does not clear: set another one. Nothing changed.`);

  assert.equal((await call("task_set", { task: "T1", fields: { state: "merged" } })).error, "sage: T1 cannot go from framed to merged. Next: designing, briefed");
  assert.equal(await call("task_set", { task: "T1", fields: { state: "briefed", branch: "codex/t1-a" } }), "T1 briefed · small · round 0 · route build,code-review,qa · codex/t1-a · P2");

  assert.match((await call("run_add", { task: "T1", role: "boss" })).error, /^sage: "boss" is not a role of a run\./);
  assert.equal(await call("run_add", { task: "T1", role: "lead", branch: "codex/t1-a" }), "R1 running · lead on T1 · codex/t1-a");
  assert.equal(await call("run_done", { run: "R1", status: "done", tokens: "90000" }), "R1 done");
  assert.match((await call("run_done", { run: "R1", status: "failed" })).error, /^sage: R1 already ended as done: a run ends once\./);
  assert.match(readFileSync(join(logbook, "runs.tsv"), "utf8"), /\nR1\tT1\tlead\t/);

  await call("task_set", { task: "T1", fields: { state: "building" } });
  await call("task_set", { task: "T1", fields: { state: "reviewing" } });
  assert.equal((await call("finding_add", { task: "T9", source: "code-reviewer", severity: "medium", summary: "x" })).error, "sage: no task T9. The latest: T1.");
  for (const role of ["code-reviewer", "qa"]) await call("run_add", { task: "T1", role });
  for (const run of ["R2", "R3"]) await call("run_done", { run, status: "done", tokens: 1 });
  assert.equal((await call("finding_add", { task: "T1", source: "code-reviewer", severity: "medium", summary: "a.js:1 bad", run: "R2" })).error,
    "sage: code-reviewer is a review or QA role, so finding add needs --run with the run whose report holds the finding and --class with one of state-edge, speed, copy, layout, security, other; it lacks --class. Nothing changed.");
  assert.equal(await call("finding_add", { task: "T1", source: "code-reviewer", severity: "medium", summary: "a.js:1 bad", run: "R2", class: "state-edge" }), "F-T1-1 open · medium · T1");
  assert.match(readFileSync(join(logbook, "findings.tsv"), "utf8"), /\nT1\tF-T1-1\t0\tcode-reviewer\tmedium\ta\.js:1 bad\t\t\topen\tR2\tstate-edge\n/);
  assert.equal((await call("finding_triage", { task: "T1", key: "F-T1-1", decision: "dismiss" })).error, "sage: missing --reason for a dismissal");
  assert.equal(await call("finding_triage", { task: "T1", key: "F-T1-1", decision: "fix" }), "F-T1-1 open · fix");
  assert.equal(await call("round", { task: "T1" }), "T1 repairing · round 1 of 3 · fix F-T1-1 · re-run code-reviewer on the repair's diff");
  assert.match((await call("round", { task: "T9" })).error, /^sage: no task T9/);
  assert.equal((await call("finding_close", { task: "T1", key: "F-T1-9" })).error, "sage: no finding F-T1-9 on T1. The latest: F-T1-1.");
  assert.equal(await call("finding_close", { task: "T1", key: "F-T1-1" }), "F-T1-1 closed · fix");
  await call("finding_add", { task: "T1", source: "qa", severity: "high", summary: "b.js:2 crash", run: "R3", class: "state-edge" });
  assert.match((await call("finding_move", { task: "T1", key: "F-T1-2", to: "Follow up" })).error, /^sage: F-T1-2 is high, so it blocks T1 until it is fixed/);
  await call("finding_add", { task: "T1", source: "qa", severity: "low", summary: "c.js:3 slow", run: "R3", class: "speed" });
  assert.equal(await call("finding_move", { task: "T1", key: "F-T1-3", to: "Follow up" }), "F-T1-3 moved to T2 as F-T2-1 · T2 framed · small · route build,code-review,qa · P2");
  await call("finding_add", { task: "T1", source: "qa", severity: "low", summary: "d.js:4 slow", run: "R3", class: "speed" });
  assert.match((await call("finding_move", { task: "T1", key: "F-T1-4", to: "T2" })).error, /is a task id\. To move F-T1-4 into that open task, use --into T2\./);
  assert.equal(await call("finding_move", { task: "T1", key: "F-T1-4", into: "T2" }), "F-T1-4 moved to T2 as F-T2-2 · T2 framed");

  assert.match((await call("verdict", { task: "T1", kind: "checks-pass", sha: "abc" })).error, /^sage: "abc" is not a full commit SHA/);
  assert.equal(await call("verdict", { task: "T1", kind: "checks-pass", sha: SHA }), "T1 checks-pass · 1111111 · cycle 1");
  assert.match(readFileSync(join(logbook, "ledger.tsv"), "utf8"), new RegExp(`\\nT1\\t\\t${SHA}\\tchecks-pass\\t1\\t`));
  assert.equal((await call("merge_check", { sha: SHA })).error, "sage: T1 has open findings: F-T1-2. Triage and close them first.");

  assert.equal(await call("log", { task: "T1", decision: "T1 kept", why: "a test" }), "logged");
  assert.match((await call("log", { task: "T1", decision: "--why=x", why: "y" })).error, /^Input validation error: .*does not start with --/);
  assert.match(await call("standing"), /^# Standing orders\n/);
  assert.equal(await call("standing_add", { order: "Run the checks." }), "standing order 5 added");
  assert.match(readFileSync(join(logbook, "standing.md"), "utf8"), /\n5\. Run the checks\.\n$/);
  assert.equal((await call("standing_add", { order: "" })).error, "sage: missing the order's text");

  const pages = await call("pages", { task: "T1" });
  assert.match(pages, new RegExp(`^${s.env.SAGE_WORKTREES}/project-[0-9a-f]{6}/pages/T1$`));
  writeFileSync(join(pages, "plan.md"), "# Plan\n");
  assert.match(await call("pages", { task: "T1", record: join(pages, "plan.md") }), /plan\.md/);
  assert.match((await call("pages", { task: "T1", record: join(s.dir, "elsewhere.md") })).error, /^sage: .*elsewhere\.md is not a file in .*pages\/T1\. Save the page there first\./);

  assert.match((await call("gate_add", { task: "T1", question: "Ship it?", options: "yes|no", recommend: "maybe" })).error, /^sage: --recommend is one of the options/);
  assert.equal(await call("gate_add", { task: "T1", question: "Ship it?", options: "yes|no", recommend: "yes" }), "G1 open · Ship it?");
  assert.match((await call("gate_answer", { gate: "G1", option: 9 })).error, /^sage: gate answer G1 takes --option <n>/);
  assert.equal(await call("gate_answer", { gate: "G1", option: 1 }), "G1 answered · yes");
});

test("brief checks a brief's fields, keeps it by task name in the logbook, and the start note reads it back (T462)", async (t) => {
  const s = await connect(t);
  const fields = ["GOAL", "SCOPE", "CONTEXT", "DECISIONS", "ACCEPTANCE", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"];
  const text = (skip = []) => fields.filter((f) => !skip.includes(f)).map((f) => `${f}\nThe ${f.toLowerCase()} of T1.`).join("\n\n");
  assert.match((await s.call("brief", { task_name: "sage_implementer_t1", brief: text() })).error, /^sage: no logbook for the project .*project\. Run init first\.$/);
  const logbook = (await s.call("init")).replace(/^logbook /, "");
  assert.equal((await s.call("brief", { task_name: "sage_implementer_t1", brief: text(["VERIFY"]) })).error,
    "sage: the brief of sage_implementer_t1 has no VERIFY. Every brief has all of GOAL, SCOPE, CONTEXT, DECISIONS, ACCEPTANCE, VERIFY, BUDGET, FORBIDDEN, REPORT, STANDING, each at the start of a line that is not in a list or a code block, with a colon, two spaces or a tab after its name (GOAL: …, GOAL   …), or its name alone on the line. Add them, then run brief again.");
  for (const [form, after] of [["colon", ": "], ["spaces", "  "], ["tab", "\t"]]) {
    const brief = fields.map((f) => `${f}${after}The ${f.toLowerCase()} of T1.`).join("\n");
    assert.equal(await s.call("brief", { task_name: "sage_implementer_t2", brief }), "brief sage_implementer_t2 checked: all 10 fields. Spawn the agent with this task name and this brief.", form);
  }
  assert.equal(await s.call("brief", { task_name: "sage_implementer_t1", brief: text() }), "brief sage_implementer_t1 checked: all 10 fields. Spawn the agent with this task name and this brief.");
  const kept = JSON.parse(readFileSync(join(logbook, "briefs", "sage_implementer_t1.json"), "utf8"));
  assert.deepEqual({ ...kept, checked: typeof kept.checked }, { task: "sage_implementer_t1", text: text(), checked: "number" });
  assert.match((await s.call("brief", { task_name: "../x", brief: text() })).error, /^Input validation error: .*sage_, the role with _ for -/);
  assert.match((await s.call("brief", { task_name: "sage_qa_t1", brief: "x".repeat(32 * 1024 + 1) })).error, /^Input validation error: /);
  assert.equal(await s.call("brief", { task_name: "sage_code_reviewer_t1_r12", brief: text() }), "brief sage_code_reviewer_t1_r12 checked: all 10 fields. Spawn the agent with this task name and this brief.");
  assert.match((await s.call("brief", { task_name: "sage_code_reviewer_t1_r", brief: text() })).error, /^Input validation error: .*the task, and the run, for example sage_implementer_t12_r40/);

  const meta = join(s.dir, "child.jsonl");
  writeFileSync(meta, JSON.stringify({ type: "session_meta", payload: { id: "c1", agent_path: "/root/sage_implementer_t1" } }) + "\n");
  const start = { session_id: "s1", turn_id: "t1", transcript_path: meta, cwd: s.project, hook_event_name: "SubagentStart", model: "m", permission_mode: "default", agent_id: "c1", agent_type: "default" };
  const out = JSON.parse(execFileSync(process.execPath, [join(s.dir, "plugin/hooks/brief-hook.mjs")], { input: JSON.stringify(start), env: s.env, encoding: "utf8" }));
  assert.ok(out.hookSpecificOutput.additionalContext.endsWith(`Your checked brief (sage_implementer_t1), as it was recorded:\n\n${text()}`));
  assert.match(out.hookSpecificOutput.additionalContext, /\n\nFORBIDDEN, from your checked brief\. Never do these:\nThe forbidden of T1\.\n\n/);
});

test("merge_check passes for a head with its clean cycle", async (t) => {
  const { call } = await connect(t);
  await call("init");
  await call("task_add", { title: "one", size: "tiny", priority: "P1" });
  await call("task_set", { task: "T1", fields: { state: "briefed", branch: "codex/t1-a" } });
  assert.equal((await call("merge_check", { sha: SHA })).error, `sage: no verdicts recorded for ${SHA}. Record the reviews and QA with sage verdict first.`);
  await call("verdict", { task: "T1", kind: "checks-pass", sha: SHA });
  assert.equal(await call("merge_check", { sha: SHA }), "T1 may merge: 1 clean cycle on this SHA");
});

test("the lint tool runs the state tool's lint on the task and the SHA, and verdict refuses the lint kinds", async (t) => {
  const { call } = await connect(t);
  await call("init");
  await call("task_add", { title: "one", size: "tiny", priority: "P1" });
  assert.match(await call("lint", { task: "T1", sha: SHA }), /^T1 · [0-9a-f]{7}: \S+ has no origin\/main and no sgconfig\.yml at its root, so there is nothing to lint, and the merge check needs no lint verdict\. Nothing changed\.$/);
  assert.match((await call("verdict", { task: "T1", kind: "lint-pass", sha: SHA })).error, /kind|lint-pass/);
});

test("merge_check gives the state tool's refusal for a task moved off a shared PR's head branch unchanged, with the branch= that puts it back (R1759-1)", async (t) => {
  const { call } = await connect(t);
  await call("init");
  for (const title of ["one", "two"]) await call("task_add", { title, size: "tiny", priority: "P1" });
  for (const task of ["T1", "T2"]) {
    await call("task_set", { task, fields: { state: "briefed", branch: "codex/t1-a", pr: "41" } });
    await call("verdict", { task, kind: "checks-pass", sha: SHA, pr: 41 });
  }
  assert.match(await call("merge_check", { sha: SHA, pr: 41, head: "codex/t1-a" }), /^2 tasks have verdicts on 1111111 or belong to PR 41, and each must pass/);
  await call("task_set", { task: "T2", fields: { branch: "codex/t2" } });
  const { error } = await call("merge_check", { sha: SHA, pr: 41, head: "codex/t1-a" });
  assert.equal(error.replace(/ \S+ T2,/, " T2,"), `sage: PR 41's head branch "codex/t1-a" is not a branch of T2, so the merge check refuses: each task that is or was on a pull request must own its head branch, a branch named for the task. It is the branch of another task, so set the branch= back to it: sage task T2 set branch=codex/t1-a, or the user lands this pull request.`);
});

test("the chief's setup text sends only read commands to the state CLI, and names the milestone and config tools (F-T471-10, T930)", async () => {
  const setup = JSON.parse(readFileSync(join(ROOT, "plugins/sage-codex/chief-bindings.json"), "utf8")).PROJECT_SETUP;
  const { TOOLS } = await import(join(ROOT, "plugins/sage-codex/mcp/state-server.mjs"));
  const cli = setup.split(/(?<=\.) /).filter((sentence) => /state CLI/.test(sentence)).flatMap((sentence) => [...sentence.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]));
  assert.ok(cli.length > 0, setup);
  assert.deepEqual(cli.filter((command) => !["board", "config", "status", "standing", "merge-check", "logbook"].includes(command)), [], "each command it runs through the CLI only reads");
  const [list] = /The tools are .*?\./.exec(setup);
  for (const name of ["milestone_propose", "milestone_set", "release_add", "config"]) assert.ok(Object.hasOwn(TOOLS, name) && list.includes(`\`${name}\``), name);
  assert.doesNotMatch(setup, /no milestone runs in Codex/);
});

async function milestoneWorld(t) {
  const s = await connect(t, { SAGE_SHARED_HOME: join(realpathSync(tmpdir()), `sage-state-mcp-t930-${process.pid}-${Date.now()}`) });
  t.after(() => rmSync(s.env.SAGE_SHARED_HOME, { recursive: true, force: true }));
  const project = join(s.dir, "claude", "project");
  mkdirSync(project, { recursive: true });
  execFileSync("git", ["init", "-q", project]);
  const env = { PATH: process.env.PATH, HOME: join(s.dir, "claude-home"), SAGE_HOME: join(s.dir, "claude-sage"), SAGE_SHARED_HOME: join(s.dir, "claude-shared"),
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", SAGE_TEST_MACHINE_ID: "test-machine" };
  const { sage } = await import(pathToFileURL(join(ROOT, "plugins/sage/skills/sage/sage.mjs")).href);
  const claude = (...args) => { try { return sage([...args, "--project", project], env); } catch (error) { return { error: `sage: ${error.message}` }; } };
  const both = async (name, input, args) => {
    const codex = await s.call(name, input);
    assert.deepEqual(codex, claude(...args), `${name} ${JSON.stringify(input)}`);
    return codex;
  };
  await s.call("init");
  claude("init");
  for (const title of ["pilot", "second", "third"]) await both("task_add", { title, size: "small", priority: "P2" }, ["task", "add", "--title", title, "--size", "small", "--priority", "P2"]);
  return { ...s, claude, both };
}

test("T930: milestone_propose (new and again) and task_set milestone= give the Claude state tool's own lines through the Codex server", async (t) => {
  const { both } = await milestoneWorld(t);
  const first = await both("milestone_propose", { name: "Codex milestones", goal: "Codex runs milestones.", pilot: "T1", tasks: "T2" },
    ["milestone", "propose", "--name", "Codex milestones", "--goal", "Codex runs milestones.", "--pilot", "T1", "--tasks", "T2"]);
  assert.match(first, /^M1 proposed .*G1/s, first);
  assert.match((await both("milestone_propose", { milestone: "M1", tasks: "T2,T3" }, ["milestone", "propose", "M1", "--tasks", "T2,T3"])).error, /^sage: the breakdown gate G1 of M1 is still open/);
  assert.match(await both("gate_answer", { gate: "G1", option: 2 }, ["gate", "answer", "G1", "--option", "2"]), /^G1 answered · change/);
  const again = await both("milestone_propose", { milestone: "M1", tasks: "T2,T3" }, ["milestone", "propose", "M1", "--tasks", "T2,T3"]);
  assert.match(again, /G2/, again);
  assert.match(await both("gate_answer", { gate: "G2", option: 1 }, ["gate", "answer", "G2", "--option", "1"]), /^G2 answered · approve/);
  assert.match(await both("task_set", { task: "T3", fields: { milestone: "none" } }, ["task", "T3", "set", "milestone=none"]), /^T3 framed/);
  assert.match(await both("task_set", { task: "T3", fields: { milestone: "M1" } }, ["task", "T3", "set", "milestone=M1"]), /^T3 framed .*M1/);
  assert.match((await both("milestone_propose", { milestone: "M9" }, ["milestone", "propose", "M9"])).error, /^sage: .*M9/);
  assert.match(await both("status", {}, ["status"]), /M1/);
});

test("T1003: release_add, milestone_set and task_set release= give the Claude state tool's own lines through the Codex server", async (t) => {
  const { both } = await milestoneWorld(t);
  assert.match(await both("release_add", { name: "1.0", goal: "Ship the first version" }, ["release", "add", "--name", "1.0", "--goal", "Ship the first version"]), /^release 1\.0 added · goal: Ship the first version\./);
  assert.match((await both("release_add", { name: "M5" }, ["release", "add", "--name", "M5"])).error, /^sage: the release's name has the form of a sage id/);
  await both("milestone_propose", { name: "Codex milestones", goal: "Codex runs milestones.", pilot: "T1", tasks: "T2" }, ["milestone", "propose", "--name", "Codex milestones", "--goal", "Codex runs milestones.", "--pilot", "T1", "--tasks", "T2"]);
  assert.equal(await both("milestone_set", { milestone: "M1", release: "1.0" }, ["milestone", "M1", "set", "release=1.0"]), "M1 · release 1.0 · name: Codex milestones");
  assert.match((await both("task_set", { task: "T2", fields: { release: "1.0" } }, ["task", "T2", "set", "release=1.0"])).error, /^sage: T2 is in M1, and a task of a milestone is in its milestone's release\./);
  assert.match(await both("task_set", { task: "T3", fields: { release: "1.0" } }, ["task", "T3", "set", "release=1.0"]), /^T3 framed .* · release 1\.0$/);
  assert.match(await both("status", {}, ["status"]), /^release 1\.0 · in progress · 0 of 3 tasks done · milestones M1 · single tasks T3 · goal: Ship the first version$/m);
});

test("T930: config sets the board name, the archive, the cycle counts and max_leads through the Codex server, with the Claude state tool's lines", async (t) => {
  const s = await milestoneWorld(t), { both } = s;
  assert.equal(await both("config", { settings: { name: "Council Record" } }, ["config", "name=Council Record"]), "name=Council Record archived=no start=normal");
  assert.equal(await both("config", { settings: { archived: "yes" } }, ["config", "archived=yes"]), "name=Council Record archived=yes start=normal");
  assert.equal(await both("config", { settings: { name: "", archived: "no" } }, ["config", "name=", "archived=no"]), "name= archived=no start=normal");
  assert.match((await both("config", { settings: { name: "x", max_leads: "4" } }, ["config", "name=x", "max_leads=4"])).error, /^sage: "max_leads" is a key for all projects/);
  assert.match((await both("config", { settings: { "cycles.large": "1" } }, ["config", "cycles.large=1"])).error, /^sage: cycles\.large must be a whole number of 2 or more: 1 is below the floor of 2/);
  const counts = (text) => text.replace(/ arena_models=\S+/, "").replace(/ model\..*$/, "");
  const set = await s.call("config", { settings: { "cycles.small": "2", "cycles.large": "3", "cycles.risk": "4", max_leads: "4" } });
  assert.equal(counts(set), counts(s.claude("config", "cycles.small=2", "cycles.large=3", "cycles.risk=4", "max_leads=4")));
  assert.match(set, /^max_agents=10 max_leads=4 cycles\.small=2 cycles\.large=3 cycles\.risk=4 max_rounds=3 /);
  const { tool } = await import(pathToFileURL(join(s.dir, "plugin/skills/sage/sage.mjs")).href);
  assert.equal(tool.command(["config", "--project", s.project], s.env).text, set);
  assert.deepEqual(JSON.parse(readFileSync(join(s.env.CODEX_HOME, "sage", "config.json"), "utf8")), { "cycles.small": 2, "cycles.large": 3, "cycles.risk": 4, max_leads: 4 });
});

test("F-T950-1: after the brief tool's check, the gate starts the chief's sage spawn from a session outside the project, in that session only", async (t) => {
  const s = await connect(t), outside = join(s.dir, "elsewhere");
  mkdirSync(outside);
  await s.call("init");
  const { gate } = await import(pathToFileURL(join(s.dir, "plugin/hooks/gate-hook.mjs")).href);
  const spawn = async (session_id = "019a0000-0000-7000-8000-0000000000aa") => (await gate({ hook_event_name: "PreToolUse", session_id, turn_id: "t1", cwd: outside, model: "m", permission_mode: "default",
    tool_name: "collaborationspawn_agent", tool_use_id: "call_spawn", transcript_path: null, tool_input: { task_name: "sage_qa_t1_r2", message: "go", fork_turns: "none" } }, { mode: () => ({ sage: true }), env: s.env }))?.hookSpecificOutput?.permissionDecisionReason;
  assert.match(await spawn() ?? "", /^sage: sage_qa_t1_r2 does not start, because no brief for it was checked in the last 30 minutes\./, "before the check");
  const brief = ["GOAL", "SCOPE", "CONTEXT", "DECISIONS", "ACCEPTANCE", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"].map((f) => `${f}: the ${f.toLowerCase()}.`).join("\n");
  assert.match(await s.call("brief", { task_name: "sage_qa_t1_r2", brief }), /checked: all 10 fields/);
  assert.equal(await spawn(), undefined, "the check names the project, which the session's folder is not");
  assert.match(await spawn("019a0000-0000-7000-8000-0000000000cc") ?? "", /^sage: sage_qa_t1_r2 does not start/, "another session");
});

test("T952, T1057: run_add holds the project's agent cap in Codex as in Claude: the 11th run waits in the queue with the same line, and an ended run admits it", async (t) => {
  const s = await milestoneWorld(t), { both } = s;
  for (let n = 1; n <= 10; n++) {
    const task = `T${(n % 3) + 1}`;
    assert.match(await s.call("run_add", { task, role: "qa" }), new RegExp(`^R${n} running · qa on ${task}`));
    assert.match(s.claude("run", "add", task, "--role", "qa"), new RegExp(`^R${n} running · qa on ${task}`));
  }
  const queued = await s.call("run_add", { task: "T1", role: "code-reviewer" });
  assert.match(queued, /^R11 is queued, place 1 · code-reviewer on T1 · reasoning_effort high · the project runs 10 of its 10 agents\. Start its agent only after its admission/);
  assert.match(s.claude("run", "add", "T1", "--role", "code-reviewer"), /^R11 is queued, place 1 · code-reviewer on T1 · model opus · the project runs 10 of its 10 agents\./);
  const steps = readFileSync(new URL("../plugins/sage-codex/skills/sage/references/lead-steps.md", import.meta.url), "utf8");
  assert.ok(steps.includes("is queued, place"), "the lead's steps name the queue line");
  assert.equal(await both("run_done", { run: "R4", status: "failed" }, ["run", "done", "R4", "--status", "failed"]), "R4 failed\nR11 admitted · code-reviewer on T1: start its agent within 10 minutes, or the run ends as failed");
  assert.match(await s.call("run_add", { task: "T1", role: "qa" }), /^R12 is queued, place 1 · qa on T1/);
});

test("T930: only the chief calls milestone_propose and config, and a lead sets no milestone=, at the gate and at the server", async (t) => {
  const w = await leadWorld(t), { lead } = w;
  const calls = [["milestone_propose", { name: "n", goal: "g", pilot: "T1", tasks: "T2" }], ["config", { settings: { max_leads: "9" } }], ["config", { settings: { name: "Mine" } }],
    ["release_add", { name: "1.0" }], ["milestone_set", { milestone: "M1", release: "1.0" }]];
  const LOGBOOK = "sage: role agents report; only the chief records the logbook. Put this in your report";
  const before = readFileSync(join(w.env.CODEX_HOME, "sage", readdirSync(join(w.env.CODEX_HOME, "sage")).find((name) => name.startsWith("project-")), "tasks.tsv"), "utf8");
  for (const [name, args] of calls) {
    const notLead = OFF_LIST(name);
    assert.equal((await lead(name, args)).denied, notLead, `the gate: lead ${name}`);
    assert.equal((await w.call(name, args, { agent: `${LEAD}/sage_qa_t1_r5` })).denied, LOGBOOK, `the gate: child ${name}`);
    for (const [who, caller, why] of [["lead", { role: "lead", task: "T1", run: "R1", project: w.project }, `${notLead}.`], ["child", { role: "child" }, `${LOGBOOK}.`]]) {
      w.writeProof(name, `forced_${who}_${name}_${JSON.stringify(args).length}`, caller);
      assert.equal((await w.call(name, args, { gate: false, callId: `forced_${who}_${name}_${JSON.stringify(args).length}` })).error, why, `the server: ${who} ${name}`);
    }
  }
  assert.match((await lead("task_set", { task: "T1", fields: { milestone: "M1" } })).denied, /^sage: a lead sets only state, branch, pr of its task, not milestone/);
  assert.match((await lead("task_set", { task: "T1", fields: { release: "1.0" } })).denied, /^sage: a lead sets only state, branch, pr of its task, not release/);
  assert.equal(readFileSync(join(w.env.CODEX_HOME, "sage", readdirSync(join(w.env.CODEX_HOME, "sage")).find((name) => name.startsWith("project-")), "tasks.tsv"), "utf8"), before, "nothing changed");
  assert.equal(existsSync(join(w.env.CODEX_HOME, "sage", "config.json")), false, "no config written");
  assert.match(await w.call("config", { settings: { max_leads: "9" } }), /^max_agents=10 max_leads=9 /, "the chief sets it");
});

test("T506: the chief saves a report with pages, and each run_done example ends a Codex run on the first try", async (t) => {
  const s = await connect(t);
  const runDone = (await s.tools()).find((tool) => tool.name === "run_done");
  for (const field of ["usage", "usage-source", "usage-evidence", "report"]) {
    assert.match(runDone.inputSchema.properties[field].description, /needed with usage unavailable|it needs status done/, field);
  }
  const { renderChiefInstructions } = await import(pathToFileURL(join(ROOT, "plugins/sage-codex/core/index.mjs")));
  const chief = renderChiefInstructions(JSON.parse(readFileSync(join(ROOT, "plugins/sage-codex/chief-bindings.json"), "utf8"))).replace(/\s+/g, " ");
  const examples = { description: runDone.description.match(/for example (\{.*\})\.$/)?.[1], dispatch: chief.match(/`run_done`, no `tokens`, for example `(\{.*?\})`/)?.[1] };
  const usageInterface = JSON.parse(`{${chief.match(/`run_add` `("usage-interface": "[a-z-]+")`/)?.[1]}}`)["usage-interface"];
  assert.equal(usageInterface, "collaboration-tools");
  assert.match(chief, /`sage run done` with `--tokens` from the agent's usage \(where the host gives no token count, as \*\*Run the route\*\* says\)/);
  assert.match(chief, /\*\*Run the route\.\*\* [^*]*Codex's agent tools give no token count, so at each child's stop the report gate reads it from the child's session record, and `run_done` records it:/);

  const logbook = (await s.call("init")).replace(/^logbook /, "");
  for (const n of [1, 2]) {
    await s.call("task_add", { title: `task ${n}`, size: "small", priority: "P1" });
    await s.call("task_set", { task: `T${n}`, fields: { state: "briefed", branch: `codex/t${n}-a` } });
  }
  assert.equal(await s.call("run_add", { task: "T1", role: "code-reviewer", "usage-interface": usageInterface }), "R1 running · code-reviewer on T1 · reasoning_effort high");
  assert.equal(await s.call("run_add", { task: "T2", role: "qa" }), "R2 running · qa on T2 · reasoning_effort medium");
  assert.equal((await s.call("run_done", { run: "R1", status: "done", usage: "unavailable" })).error,
    "sage: Unavailable usage needs a running run, its unsupported interface snapshot (or a lead run with a report), a report, source and evidence, without tokens. Nothing changed.");

  const folder = join(s.env.SAGE_WORKTREES, basename(logbook), "pages", "T1");
  const report = "STATUS done\nRESULT PASS\n";
  assert.equal((await s.call("pages", { task: "T1", run: "R1", text: " \n" })).error, "sage: --text is the run's whole report, and it is empty. Nothing changed.");
  for (const run of ["R2", "../R1", "R1/../../T2/R1", "R9"]) {
    assert.equal((await s.call("pages", { task: "T1", run, text: report })).error, `sage: --run is a run of T1, for example R7; not ${JSON.stringify(run)}. Nothing changed.`, run);
  }
  assert.deepEqual(readdirSync(folder), [], "a refused save writes no file");

  for (const [where, example] of Object.entries(examples)) {
    assert.ok(example, `${where} has an example call`);
    const run = where === "dispatch" ? "R1" : "R3";
    if (run === "R3") assert.equal(await s.call("run_add", { task: "T1", role: "code-reviewer", "usage-interface": usageInterface }), "R3 running · code-reviewer on T1 · reasoning_effort high");
    const saved = await s.call("pages", { task: "T1", run, text: `${report}${run}\n` });
    const path = saved.match(/^page (\/.+) · sha256 [0-9a-f]{64}$/)?.[1];
    assert.equal(path, join(folder, `${run}-report.md`), saved);
    assert.equal(readFileSync(path, "utf8"), `${report}${run}\n`);
    assert.equal(await s.call("pages", { task: "T1", run, text: `${report}${run}\n` }), saved);
    assert.equal((await s.call("pages", { task: "T1", run, text: "STATUS blocked\n" })).error, `sage: ${path} already holds another report of ${run}, and a report is saved once. Nothing changed.`);
    const call = JSON.parse(example);
    assert.equal(call.project, "/absolute/project", `${where} names the project`);
    assert.equal(await s.call("run_done", { ...call, project: s.project, run, report: path }), `${run} done`, where);
  }
  assert.deepEqual(readdirSync(folder).sort(), ["R1-report.md", "R3-report.md"]);
  assert.match(await s.call("status"), /\nagents {2}3 runs · 1 running · about 0k tokens · partial measured total; 0 measured, 2 unavailable, 0 legacy-unrecorded\n/);
});


test("T83 sample investigation and independent evidence check retain real outputs and conclude without SHA", async t => {
  const s = await connect(t);
  const book = (await s.call("init")).slice(8);
  assert.match(await s.call("task_add", { title: "SAMPLE: inspect answer", size: "investigate", priority: "P2" }), /route investigate,evidence-review/);
  for (const state of ["briefed", "building"]) assert.match(await s.call("task_set", { task: "T1", fields: { state } }), new RegExp(`T1 ${state}`));
  const sample = join(s.project, "sample.txt");
  writeFileSync(sample, "answer=42\n");
  const { briefHook } = await import(pathToFileURL(join(s.dir, "plugin/hooks/brief-hook.mjs")));
  const { reportGate } = await import(pathToFileURL(join(s.dir, "plugin/hooks/report-gate.mjs")));
  const ledger = () => readFileSync(join(book, "ledger.tsv"), "utf8");
  const before = ledger();
  let reviewRun;
  for (const role of ["investigate", "evidence-review"]) {
    if (role === "evidence-review") assert.match(await s.call("task_set", { task: "T1", fields: { state: "reviewing" } }), /T1 reviewing/);
    const run = (await s.call("run_add", { task: "T1", role })).split(" ")[0];
    const file = join(s.dir, `${run}-sample-transcript.jsonl`);
    writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: `sample-${run}`, agent_path: `/root/sage_${role.replaceAll("-", "_")}_t1_${run.toLowerCase()}` } }) + "\n");
    briefHook({ hook_event_name: "SubagentStart", session_id: "sample-root", transcript_path: file, cwd: s.project }, s.env);
    const code = role === "investigate"
      ? 'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8"))'
      : 'require("node:assert/strict").equal(require("node:fs").readFileSync(process.argv[1], "utf8"), "answer=42\\n"); console.log("PASS answer=42")';
    const check = spawnSync(process.execPath, ["-e", code, sample], { encoding: "utf8", env: s.env });
    assert.equal(check.status, 0, check.stderr);
    const report = `STATUS done\nRESULT ${role === "investigate" ? "answer=42" : "CLEAN"}\nEVIDENCE SAMPLE T1 ${run} ${role}: node -e ${JSON.stringify(code)} ${sample} printed ${JSON.stringify(check.stdout)}\nFINDINGS none\nQUESTIONS none\nNOT VERIFIED installed or native dispatch; synthetic hook events\nBRANCH none\n`;
    assert.deepEqual(reportGate({ hook_event_name: "SubagentStop", stop_hook_active: false, agent_transcript_path: file, cwd: s.project, last_assistant_message: report }, s.env), {});
    assert.equal(JSON.parse(readFileSync(join(book, "kept", `${run}.json`), "utf8")).text, report);
    const page = await s.call("pages", { task: "T1", run, text: report });
    assert.equal(typeof page, "string", JSON.stringify(page));
    const path = join(s.env.SAGE_WORKTREES, basename(book), "pages", "T1", `${run}-report.md`);
    assert.equal(readFileSync(path, "utf8"), report);
    assert.equal(await s.call("run_done", { run, status: "done", report: path, tokens: 1 }), `${run} done`);
    assert.equal(ledger(), before, "retention and manual records create no verdict");
    reviewRun = run;
  }
  assert.match((await s.call("verdict", { task: "T1", kind: "evidence-clean", run: reviewRun, sha: SHA })).error, /leave out --sha/);
  assert.equal(await s.call("verdict", { task: "T1", kind: "evidence-clean", run: reviewRun }), "T1 evidence-clean · cycle 1");
  for (const state of ["verifying", "concluded"]) assert.match(await s.call("task_set", { task: "T1", fields: { state } }), new RegExp(`T1 ${state}`));
  const { tool } = await import(pathToFileURL(join(s.dir, "plugin/skills/sage/sage.mjs")));
  assert.deepEqual(tool.read(book, "ledger").map(row => [row.task, row.kind, row.run, row.sha]), [["T1", "evidence-clean", reviewRun, ""]]);
  assert.match((await s.call("merge_check", { sha: SHA, pr: 1, head: "codex/sample" })).error, /no verdicts/);
  console.log("T83 SAMPLE: investigate R1 answer=42; independent evidence-review R2 PASS; exact reports retained; chief evidence-clean without SHA; T1 concluded; merge refused");
});

test("T586 SYNTHETIC: candidates, a judge and the landing play through the Codex path, with fixture commits and fixture reports", async t => {
  const s = await connect(t);
  const { briefHook } = await import(pathToFileURL(join(s.dir, "plugin/hooks/brief-hook.mjs")));
  const { reportGate } = await import(pathToFileURL(join(s.dir, "plugin/hooks/report-gate.mjs")));
  const { gate } = await import(pathToFileURL(join(s.dir, "plugin/hooks/gate-hook.mjs")));
  const { tool } = await import(pathToFileURL(join(s.dir, "plugin/skills/sage/sage.mjs")));
  const git = (...args) => execFileSync("git", ["-C", s.project, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
  const commit = (message) => { git("commit", "-q", "--allow-empty", "-m", message); return git("rev-parse", "HEAD"); };
  git("checkout", "-q", "-b", "main");
  const base = commit("SAMPLE base");
  const book = (await s.call("init")).slice(8);
  assert.match(await s.call("task_add", { title: "SAMPLE: arena", size: "small", add: "arena", why: "no clear answer", priority: "P2" }), /route arena,build,code-review,qa/);
  const pages = await s.call("pages", { task: "T1" });
  assert.equal(typeof pages, "string");
  assert.equal(await s.call("log", { task: "T1", decision: "SAMPLE rubric: smallest change", why: "arena rubric" }), "logged");

  const hookEvent = (toolName, input, transcript, cwd = s.project) => ({ hook_event_name: "PreToolUse", session_id: "019a0000-0000-7000-8000-0000000000aa", turn_id: "t1",
    transcript_path: transcript, cwd, model: "m", permission_mode: "default", tool_name: toolName, tool_use_id: `hook_${toolName}`, tool_input: input,
    ...(transcript ? { agent_id: "child" } : {}) });
  const sageOn = { mode: () => ({ sage: true, autopilot: false }), env: s.env };
  const USAGE = { usage: "unavailable", "usage-source": "codex collaboration-tools", "usage-evidence": "SAMPLE: wait_agent gives no token count" };
  const report = (run, branch, sha) => `STATUS done\nRESULT SYNTHETIC SAMPLE ${run}\nEVIDENCE SYNTHETIC SAMPLE ${run}: fixture commit\nFINDINGS none\nQUESTIONS none\nNOT VERIFIED actual role dispatch, installed hooks\nBRANCH ${branch} head ${sha}\n`;

  const play = async (role, branch, candidate, work) => {
    const added = await s.call("run_add", { task: "T1", role, branch, "usage-interface": "collaboration-tools", ...(candidate ? { candidate } : {}) });
    const run = /^R\d+/.exec(added)[0], name = `sage_${role.replaceAll("-", "_")}_t1_${run.toLowerCase()}`;
    assert.match(await s.call("brief", { task_name: name, brief: BRIEF }), /checked: all 10 fields/, "the chief checks the brief before the spawn (T950)");
    assert.equal(await gate(hookEvent("collaborationspawn_agent", { task_name: name, fork_turns: "none", message: "SAMPLE" }, null), sageOn), undefined, "the chief spawns it");
    const row = tool.logbookView(s.project, s.env).row(run);
    assert.deepEqual([row.branch, row.candidate], [branch, String(candidate ?? "")]);
    const file = join(s.dir, `${run}-synthetic-transcript.jsonl`);
    writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: `sample-${run}`, agent_path: `/root/${name}`, source: { subagent: { thread_spawn: {} } } } }) + "\n");
    briefHook({ hook_event_name: "SubagentStart", session_id: "sample-root", transcript_path: file, cwd: s.project }, s.env);
    const edit = await gate(hookEvent("apply_patch", { command: "*** Begin Patch\n*** Add File: sample.txt\n+SAMPLE\n*** End Patch" }, file), sageOn);
    assert.equal(edit, undefined, `${role} writes its own branch`);
    assert.match((await gate(hookEvent("collaborationspawn_agent", { task_name: "sage_qa_t1_r9", message: "SAMPLE" }, file), sageOn)).hookSpecificOutput.permissionDecisionReason, /role agents start no agents/);
    assert.match((await gate(hookEvent("mcp__sage__run_done", { project: s.project, run, status: "done" }, file), sageOn)).hookSpecificOutput.permissionDecisionReason, /only the chief records the logbook/);
    const sha = work();
    const text = report(run, branch, sha);
    assert.deepEqual(reportGate({ hook_event_name: "SubagentStop", stop_hook_active: false, agent_transcript_path: file, cwd: s.project, last_assistant_message: text }, s.env), {});
    const kept = JSON.parse(readFileSync(join(book, "kept", `${run}.json`), "utf8"));
    assert.deepEqual([kept.text, kept.sha, kept.role], [text, sha, role], "the report is kept with the head of its own branch");
    await s.call("pages", { task: "T1", run, text });
    assert.equal(await s.call("run_done", { run, status: "done", report: join(pages, `${run}-report.md`), ...USAGE }), `${run} done`);
    return { run, sha };
  };
  const onBranch = (name, from, message) => () => { git("checkout", "-q", "-b", name, from); return commit(message); };

  assert.match((await s.call("run_add", { task: "T1", role: "implementer", branch: "sage/t1-extra" })).error, /arena step is open/);
  const one = await play("implementer", "sage/t1-c1", 1, onBranch("sage/t1-c1", base, "SAMPLE candidate 1"));
  const two = await play("implementer", "sage/t1-c2", 2, onBranch("sage/t1-c2", base, "SAMPLE candidate 2"));
  assert.notEqual(one.sha, two.sha);
  writeFileSync(join(pages, `${one.run}-artifact.diff`), "SAMPLE DATA\n");
  assert.match(await s.call("pages", { task: "T1", record: join(pages, `${one.run}-artifact.diff`) }), /sha256 [0-9a-f]{64}$/);

  await s.call("verdict", { task: "T1", kind: "checks-pass", sha: one.sha, pr: 7 });
  assert.match((await s.call("merge_check", { sha: one.sha, pr: 7, head: "sage/t1-c1" })).error, /a candidate's branch never merges/);
  assert.match((await s.call("merge_check", { sha: one.sha, pr: 7, head: "sage/t1-other" })).error, /arena step is open[\s\S]*Finish a judge/);

  assert.match((await s.call("run_add", { task: "T1", role: "arena-judge", branch: "sage/t1-c1" })).error, /never shares a branch with a candidate/);
  assert.match(await s.call("task_set", { task: "T1", fields: { branch: "sage/t1-judge" } }), /sage\/t1-judge/);
  const judge = await play("arena-judge", "sage/t1-judge", undefined, onBranch("sage/t1-judge", one.sha, "SAMPLE graft from candidate 2"));
  assert.equal(git("merge-base", "--is-ancestor", one.sha, judge.sha), "", "the judge's branch starts at the base's head");
  assert.equal(git("rev-parse", "sage/t1-c1"), one.sha, "a candidate's branch stays as it is");

  const pr = 7;
  for (const fields of [{ state: "briefed" }, { state: "building" }, { state: "reviewing", pr: String(pr) }]) assert.match(await s.call("task_set", { task: "T1", fields }), /^T1 /);
  for (const [kind, role] of [["review-clean", "code-reviewer"], ["qa-pass", "qa"]]) {
    const run = /^R\d+/.exec(await s.call("run_add", { task: "T1", role, "usage-interface": "collaboration-tools" }))[0];
    assert.equal(tool.branchTip(s.project, tool.logbookView(s.project, s.env).task("T1").branch, s.env), judge.sha, "a review reads the judge's head");
    const name = `sage_${role.replaceAll("-", "_")}_t1_${run.toLowerCase()}`, file = join(s.dir, `${run}-synthetic-transcript.jsonl`);
    writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: `sample-${run}`, agent_path: `/root/${name}`, source: { subagent: { thread_spawn: {} } } } }) + "\n");
    briefHook({ hook_event_name: "SubagentStart", session_id: "sample-root", transcript_path: file, cwd: s.project }, s.env);
    const text = `STATUS done\nRESULT CLEAN\nEVIDENCE SYNTHETIC SAMPLE ${run}: fixture check\nFINDINGS none\nQUESTIONS none\nNOT VERIFIED installed hooks\nBRANCH sage/t1-judge head ${judge.sha}\n`;
    assert.deepEqual(reportGate({ hook_event_name: "SubagentStop", stop_hook_active: false, agent_transcript_path: file, cwd: s.project, last_assistant_message: text }, s.env), {});
    await s.call("pages", { task: "T1", run, text });
    assert.equal(await s.call("run_done", { run, status: "done", report: join(pages, `${run}-report.md`), ...USAGE }), `${run} done`);
    await s.call("verdict", { task: "T1", kind, sha: judge.sha, run, pr, cycle: 1 });
  }
  await s.call("verdict", { task: "T1", kind: "checks-pass", sha: judge.sha, pr, cycle: 1 });
  assert.match(await s.call("task_set", { task: "T1", fields: { state: "verifying" } }), /^T1 verifying/);
  assert.match(await s.call("task_set", { task: "T1", fields: { state: "verified" } }), /^T1 verified/);
  assert.match((await s.call("merge_check", { sha: one.sha, pr, head: "sage/t1-c1" })).error, /a candidate's branch never merges/);
  assert.match(await s.call("merge_check", { sha: judge.sha, pr, head: "sage/t1-judge" }), /T1 may merge/);
  console.log("T586 SYNTHETIC SAMPLE: candidates R1 and R2 on their own branches → judge R3 on its own branch → review and QA of the judge's head → merge check passes for the judge's branch and refuses a candidate's; fixture commits and reports; no installed Codex, no real agent, no real pull request");
});

test("T85 synthetic designer prototype, separate PE report and chief artifact records preserve authority", async t => {
  const s = await connect(t);
  const book = (await s.call("init")).slice(8);
  assert.match(await s.call("task_add", { title: "SAMPLE: design review", size: "large", priority: "P2" }), /route design,pe,build/);
  const folder = await s.call("pages", { task: "T1" });
  assert.equal(typeof folder, "string");
  const branch = "codex/t1-sample-design";
  assert.match((await s.call("run_add", { task: "T1", role: "designer" })).error, /designer run needs --branch/);
  assert.match(await s.call("run_add", { task: "T1", role: "designer", branch }), /^R1 running/);
  for (const role of ["designer", "implementer"]) {
    assert.match((await s.call("run_add", { task: "T1", role, branch })).error, /branch has one writer/);
  }
  const prototype = join(folder, "sample-prototype.html");
  const html = '<!doctype html><title>SAMPLE DATA: design fixture</title><h1>SAMPLE DATA</h1><details><summary>Show sample result</summary><p>Sample success</p></details>\n';
  writeFileSync(prototype, html);
  const { briefHook } = await import(pathToFileURL(join(s.dir, "plugin/hooks/brief-hook.mjs")));
  const { reportGate } = await import(pathToFileURL(join(s.dir, "plugin/hooks/report-gate.mjs")));
  const ledger = () => readFileSync(join(book, "ledger.tsv"), "utf8"), before = ledger();
  const retained = [];
  for (const [role, run] of [["designer", "R1"], ["pe", "R2"]]) {
    if (role === "pe") {
      assert.match(await s.call("run_add", { task: "T1", role }), /^R2 running/);
      assert.equal(readFileSync(prototype, "utf8"), html, "PE receives the actual recorded sample artifact");
      assert.equal(readFileSync(join(folder, "R1-report.md"), "utf8"), retained[0]);
    }
    const file = join(s.dir, `${run}-synthetic-transcript.jsonl`);
    writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: `sample-${run}`, agent_path: `/root/sage_${role}_t1_${run.toLowerCase()}` } }) + "\n");
    briefHook({ hook_event_name: "SubagentStart", session_id: "sample-root", transcript_path: file, cwd: s.project }, s.env);
    const report = `STATUS done\nRESULT ${role === "designer" ? prototype : "OK: sample artifact contains the agreed example"}\nEVIDENCE SYNTHETIC SAMPLE T1 ${run} ${role}: ${prototype}; fixture reads match saved bytes\nFINDINGS none\nQUESTIONS none\nNOT VERIFIED actual role dispatch, screenshots, installed hooks or owner approval\nBRANCH ${role === "designer" ? branch : "none"}\n`;
    assert.deepEqual(reportGate({ hook_event_name: "SubagentStop", stop_hook_active: false, agent_transcript_path: file, cwd: s.project, last_assistant_message: report }, s.env), {});
    assert.equal(JSON.parse(readFileSync(join(book, "kept", `${run}.json`), "utf8")).text, report);
    assert.match(await s.call("pages", { task: "T1", run, text: report }), /^page /);
    assert.equal(readFileSync(join(folder, `${run}-report.md`), "utf8"), report);
    if (role === "designer") {
      assert.match(await s.call("pages", { task: "T1", record: prototype }), /^page .*sample-prototype\.html · sha256 [0-9a-f]{64}$/);
      assert.equal(readFileSync(prototype, "utf8"), html, "recording preserves the artifact");
    }
    assert.equal(await s.call("run_done", { run, status: "done", report: join(folder, `${run}-report.md`), tokens: 1 }), `${run} done`);
    assert.match((await s.call("verdict", { task: "T1", kind: "review-clean", sha: SHA, run })).error, /backs no review-clean verdict/);
    assert.equal(ledger(), before, "design reports grant no review verdict or design approval");
    retained.push(report);
  }
  assert.match(await s.call("gate_add", { task: "T1", question: "SAMPLE: approve this design?", options: "approve|change", recommend: "approve" }), /^G1 open/);
  assert.match((await s.call("merge_check", { sha: SHA, pr: 1, head: branch })).error, /no verdicts/);
  assert.match(await s.call("gate_answer", { gate: "G1", option: "1" }), /G1/);
  assert.match(await s.call("run_add", { task: "T1", role: "implementer", branch }), /^R3 running/);
  assert.equal(await s.call("run_done", { run: "R3", status: "blocked" }), "R3 blocked");
  console.log("T85 SYNTHETIC SAMPLE: designer R1 → recorded prototype/report → separate PE R2 → simulated owner answer → build R3; no verdict; missing-review merge refusal preserved; no installed execution");
});
