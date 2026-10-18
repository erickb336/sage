// The lead agent file (agents/lead.md) against the sage hook (T301). The file's worked examples are lives of one lead:
// each line goes through the hook as Claude Code sends it, from the main session's start of lead-T1 to a passing merge
// check after the sage's own steps. A line that the hook refuses, a command that fails, or an output that the file states
// wrongly fails the test. The file's tables (the state moves, the verdict kinds, the helper cap) are played against the
// hook too. So the file teaches only what the hook allows. No real agent starts: the events are hook JSON only.
import "./test-env.mjs"; // first: no variable of the developer's shell changes a result
import assert from "node:assert/strict";
import { spawnSync as rawSpawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const at = (path) => fileURLToPath(new URL(path, import.meta.url));
const LAUNCHER = [at("../plugins/sage/hooks/launcher.mjs"), "sage-hook.mjs"];
const TOOL = at("../plugins/sage/skills/sage/sage.mjs");
const LEAD_FILE = at("../plugins/sage/agents/lead.md");
const TEXT = readFileSync(LEAD_FILE, "utf8");
// Each child call normally takes under 1 s: one that runs 60 s is stuck, and fails instead of stalling the run.
const spawnSync = (command, args, options) => rawSpawnSync(command, args, { timeout: 60_000, killSignal: "SIGKILL", encoding: "utf8", ...options });
const BRIEF = ["GOAL build the form", "SCOPE src/", "CONTEXT none", "DECISIONS none", "ACCEPTANCE it works", "VERIFY npm test", "BUDGET 1 hour of agent time",
  "FORBIDDEN no merge", "REPORT the report of the sage:report skill", "STANDING 1. Work only in your own worktree."].join("\n");
const report = (result, findings) => ["STATUS        done", `RESULT        ${result}`, "EVIDENCE      npm test: pass", `FINDINGS      ${findings}`,
  "QUESTIONS     none", "NOT VERIFIED  none", "BRANCH        sage/t1-example"].join("\n");
const denied = (out) => out?.hookSpecificOutput?.permissionDecision === "deny" ? out.hookSpecificOutput.permissionDecisionReason : undefined;
const words = (text) => text.trim().split(/\s+/).join(" ");
// The fake gh: it answers only "gh pr checks <n>" as CI with one passing check does. Any other call fails, so the file
// cannot teach a gh command that the test does not know.
const FAKE_GH = `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a.length === 3 && a[0] === "pr" && a[1] === "checks" && /^[1-9][0-9]*$/.test(a[2])) console.log("build\\tpass\\t1m\\thttps://example.invalid/runs/1");
else { console.error("the fake gh knows only gh pr checks <n>: " + a.join(" ")); process.exit(1); }
`;

/** A text block of the file: the first one after the heading. */
function block(heading) {
  const m = new RegExp(`^## ${heading}\\n[\\s\\S]*?^\`\`\`text\\n([\\s\\S]*?)^\`\`\`$`, "m").exec(TEXT);
  assert.ok(m, `agents/lead.md has a text block under "## ${heading}"`);
  return m[1].split("\n").filter(Boolean);
}
/** A table of the file: its rows after the header line that starts with `| <first> |`, as arrays of cells. */
function table(first) {
  const m = new RegExp(`^\\| ${first} \\|.*\\n\\|[- |]+\\|\\n((?:\\|.*\\|\\n)+)`, "m").exec(TEXT);
  assert.ok(m, `agents/lead.md has a table that starts with "| ${first} |"`);
  return m[1].trim().split("\n").map((row) => row.slice(1, -1).split("|").map((cell) => cell.trim()));
}

/** A project with a git repository, a logbook and the sage's own steps before a lead: T1 briefed, its lead run, lead-T1 started. */
function project({ size = "small", config = [] } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-lead-agent-")));
  const folder = join(dir, "project"), bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), FAKE_GH, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: join(dir, "home"), SAGE_HOME: join(dir, "sage"), SAGE_HOOKS_STATE: join(dir, "hooks") };
  const git = (...args) => spawnSync("git", ["-C", folder, ...args]).stdout.trim();
  spawnSync("git", ["init", "-q", "-b", "main", folder]);
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "start");
  const send = (event) => {
    const r = spawnSync("node", LAUNCHER, { input: JSON.stringify({ session_id: "s1", cwd: folder, ...event }), env });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : undefined;
  };
  // A command as the lead runs it: from the project's folder, without --project or SAGE_PROJECT. git, gh and cat run for real.
  const run = (program, args) => spawnSync(program === "sage" ? "node" : program, program === "sage" ? [TOOL, ...args] : args, { cwd: folder, env });
  const chief = (...args) => {
    const r = spawnSync("node", [TOOL, ...args, "--project", folder], { env });
    assert.equal(r.status, 0, `the sage's sage ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const p = { folder, send, run, chief, lead: undefined, leads: 0 };
  /** The main session starts lead-T<n>, as the chief bindings say: after its lead run. */
  p.startLead = (task = "T1") => {
    const id = `lead-${++p.leads}`, call = `start-${id}`;
    const start = { subagent_type: "sage:lead", name: `lead-${task}`, description: `lead-${task}`, prompt: BRIEF, run_in_background: true };
    const why = denied(send({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: start, tool_use_id: call }));
    if (why) return why;
    send({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: call, tool_response: { status: "async_launched", agentId: id } });
    send({ hook_event_name: "SubagentStart", agent_id: id, agent_type: "sage:lead" });
    p.lead = { agent_id: id, agent_type: "sage:lead" };
  };
  send({ hook_event_name: "UserPromptSubmit", prompt: "sage mode" });
  chief("init");
  if (config.length) chief("config", ...config);
  chief("task", "add", "--title", "example", "--size", size); // T1; small: build, code review, QA
  chief("task", "T1", "set", "state=briefed");
  chief("run", "add", "T1", "--role", "lead"); // R1
  assert.equal(p.startLead(), undefined, "the sage starts lead-T1");
  // The implementer's work: a new commit at the tip of the task's branch.
  p.commit = () => {
    const parent = git("rev-parse", "--verify", "--quiet", "sage/t1-example") || git("rev-parse", "main");
    const sha = git("-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", `${parent}^{tree}`, "-p", parent, "-m", "work");
    git("update-ref", "refs/heads/sage/t1-example", sha);
  };
  p.head = () => git("rev-parse", "sage/t1-example");
  /** Sets T1's state in the logbook as a fixture, for the state table's check: the hook reads the state from tasks.tsv. */
  p.setState = (state) => {
    const file = join(chief("logbook"), "tasks.tsv"), [header, ...rows] = readFileSync(file, "utf8").trimEnd().split("\n"), column = header.split("\t").indexOf("state");
    writeFileSync(file, [header, ...rows.map((row) => row.startsWith("T1\t") ? row.split("\t").map((cell, i) => (i === column ? state : cell)).join("\t") : row)].join("\n") + "\n");
  };
  /** The hook's answer to the lead's Bash command, without running it. */
  p.ask = (command) => denied(send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, ...p.lead }));
  return p;
}

/**
 * Plays an example's lines in order, as the file's marks say. Returns the commands that ran, the lead's and the sage's apart,
 * each in full ("sage round T1", "git rev-parse sage/t1-example"), and the last output.
 */
function play(lines, p) {
  const roles = {}, ran = [], sage = []; // ran: the lead's commands; sage: the sage's
  let printed, last, logbook, recheck = new Set(); // printed: the output of the line just before; recheck: the roles that round named and that have not reported
  const fill = (text) => text.replaceAll("<sha>", () => p.head()).replaceAll("<logbook>", () => logbook ?? assert.fail("<logbook> before sage logbook"));
  for (const line of lines) {
    const [mark, ...rest] = line.split(" "), text = rest.join(" ");
    const was = printed;
    printed = undefined; // a → line compares only with the output of the command just before it
    if (mark === "$") {
      const [program, ...args] = fill(text).split(" ");
      assert.ok(["sage", "git", "gh", "cat"].includes(program), `agents/lead.md: the lead runs "${line}", which is not a command that the file teaches`);
      const command = program === "sage" ? `node ${TOOL} ${args.join(" ")}` : [program, ...args].join(" ");
      assert.equal(p.ask(command), undefined, `the hook refuses: ${line}`);
      // The file says that the checks verdict is the sage's; until the hook refuses it for a lead (T302), the test does.
      assert.ok(!(program === "sage" && args[0] === "verdict" && /^checks-/.test(args[args.indexOf("--kind") + 1])),`${line}: the checks verdict is the sage's (! sage verdict ...)`);
      if (program === "sage" && args[0] === "finding" && args[1] === "close") assert.deepEqual([...recheck], [], `${line}: round named a role that has not re-checked`);
      const r = p.run(program, args);
      assert.equal(r.status, 0, `${line}: ${r.stderr}`);
      last = printed = r.stdout.trim();
      if (program === "sage") p.send({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_response: { stdout: r.stdout, stderr: r.stderr, interrupted: false }, ...p.lead });
      if (program === "sage" && args[0] === "round") recheck = new Set(/ re-run (\S+) on /.exec(printed)?.[1].split(",") ?? []);
      ran.push([program, ...args].join(" "));
    } else if (mark === "→") {
      assert.ok(was !== undefined, `agents/lead.md: "${line}" does not follow a command`);
      if (text === "<logbook>") (logbook = was), assert.match(logbook, /^\//, "sage logbook prints a folder");
      else assert.ok(words(was).startsWith(words(fill(text))), `the file says "${text}", the command printed "${was}"`);
    } else if (mark === ">") {
      const [run, type] = rest;
      roles[run] = type;
      const spawn = { subagent_type: type, name: run, description: `${type} for ${run}`, prompt: BRIEF, run_in_background: true };
      assert.equal(denied(p.send({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: spawn, tool_use_id: `spawn-${run}`, ...p.lead })), undefined, `the hook refuses: ${line}`);
      p.send({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: `spawn-${run}`, tool_response: { status: "async_launched", agentId: `child-${run}` }, ...p.lead });
      p.send({ hook_event_name: "SubagentStart", agent_id: `child-${run}`, agent_type: type });
    } else if (mark === "<") {
      const [who, said] = rest, result = said.replace(/:$/, ""), findings = rest.slice(2).join(" ");
      const agent = who === "lead-T1" ? p.lead : { agent_id: `child-${who}`, agent_type: roles[who] };
      assert.ok(agent?.agent_type, `agents/lead.md: "${line}" is a report of no agent that started`);
      if (agent.agent_type === "sage:implementer") p.commit();
      recheck.delete(agent.agent_type.slice("sage:".length));
      const out = p.send({ hook_event_name: "SubagentStop", ...agent, stop_hook_active: false, last_assistant_message: report(result, findings) });
      assert.equal(out?.decision, undefined, `the stop gate blocks ${who}'s report: ${out?.reason}`);
      if (who === "lead-T1") p.lead = undefined;
    } else if (mark === "!" && rest[0] === "sage") {
      last = printed = p.chief(...fill(rest.slice(1).join(" ")).split(" "));
      sage.push(fill(text));
    } else if (mark === "!" && rest[0] === "stop") {
      p.send({ hook_event_name: "PreToolUse", tool_name: "TaskStop", tool_input: { task_id: `child-${rest[1]}` } }); // the main session's TaskStop
    } else if (mark === "!" && rest[0] === "start") {
      assert.equal(p.startLead(rest[1].slice("lead-".length)), undefined, `the hook refuses: ${line}`);
    } else assert.fail(`agents/lead.md: the example line "${line}" starts with no known mark ($, →, >, <, ! sage, ! stop, ! start)`);
  }
  return { ran, sage, printed: last };
}

const EXAMPLES = ["A worked example", "An example that ends blocked"];

test("T301: each example of the lead file runs through the hook, from lead-T1's start to a passing merge check, and the examples run every command that the file teaches", () => {
  const ran = [];
  for (const heading of EXAMPLES) {
    const { ran: here, sage, printed } = play(block(heading), project());
    assert.match(sage.at(-1), /^sage merge-check --sha [0-9a-f]{40} --pr 12$/, `"${heading}" ends with the merge check`);
    assert.match(printed, /^T1 may merge/, `and the merge check of "${heading}" passes`);
    ran.push(...here);
  }
  // Each command form in a code span, run by the lead itself (a form that only the sage ran is not the lead's): the state tool (also as node <path to skills/sage/sage.mjs> ...), git, gh and cat.
  const taught = [...TEXT.matchAll(/`((?:sage|git|gh|cat|node <path to skills\/sage\/sage\.mjs>) [^`]+)`/g)].map((m) => m[1].replace(/^node <path to skills\/sage\/sage\.mjs> /, "sage "));
  assert.ok(taught.length > 20, "the file teaches its commands in code spans");
  for (const form of taught) {
    // A placeholder such as <T>, <sha> or <word> stands for one word or part of one; the rest of the form must be the same, to its end.
    const shape = new RegExp(`^${form.split(/(<[^>]+>)/).map((part) => (/^<[^>]+>$/.test(part) ? "\\S+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("")}$`);
    assert.ok(ran.some((command) => shape.test(command)), `agents/lead.md teaches "${form}", and no example runs it in full`);
  }
});

test("T301: the lead file's state table is the hook's: each move in it passes, and each other move of the lead is refused", () => {
  const p = project();
  const moves = table("From").map(([from, to]) => `${from}>${to}`);
  assert.ok(moves.length >= 5, "the file has its state table");
  const STATES = ["framed", "designing", "awaiting-you", "briefed", "building", "reviewing", "repairing", "verifying", "verified", "pr-ready", "held", "replan", "merged", "concluded", "abandoned"];
  const wrong = [];
  for (const from of STATES) {
    p.setState(from);
    for (const to of STATES) {
      if (to === from) continue;
      const passes = p.ask(`node ${TOOL} task T1 set state=${to}`) === undefined;
      if (passes !== moves.includes(`${from}>${to}`)) wrong.push(`${from} to ${to}: the hook ${passes ? "lets it pass" : "refuses it"}`);
    }
  }
  assert.deepEqual(wrong, [], "the file's state table and the hook differ");
});

test("T301: the lead file's verdict table is the hook's: each report gives only the kind that the table names", () => {
  const rows = table("Report");
  assert.equal(rows.length, 4, "the file has its verdict table");
  const kinds = (report) => rows.find(([said]) => said === report)?.[1].split(/, | or /) ?? assert.fail(`the verdict table has no row "${report}"`);
  const ALL = ["review-clean", "security-clean", "ux-clean", "qa-pass", "qa-fail", "findings"];
  // Each case: a helper's role, its report (as an example's < line), and the table row that names its kind.
  const CASES = [
    ["code-reviewer", "CLEAN: none", "CLEAN, or FINDINGS with only low findings"],
    ["security-reviewer", "CLEAN: none", "CLEAN, or FINDINGS with only low findings"],
    ["ux-reviewer", "CLEAN: none", "CLEAN, or FINDINGS with only low findings"],
    ["code-reviewer", "FINDINGS: - K1 low a.js:1 a typo", "CLEAN, or FINDINGS with only low findings"],
    ["qa", "PASS: none", "PASS, or FAIL with only low findings"],
    ["qa", "FAIL: - Q1 low a.js:1 a typo", "PASS, or FAIL with only low findings"],
    ["code-reviewer", "FINDINGS: - K1 medium a.js:1 an empty name saves a row", "FINDINGS with a medium or high finding"],
    ["qa", "FAIL: - Q1 high a.js:1 the form loses data", "FAIL with a medium or high finding"],
  ];
  const p = project({ size: "large", config: ["max_agents=20"] });
  play(["$ sage task T1 set state=building branch=sage/t1-example", "$ sage run add T1 --role implementer --branch sage/t1-example", "> R2 sage:implementer", "< R2 done: none",
    "$ sage run done R2 --status done --tokens 1", "$ sage task T1 set state=reviewing pr=12"], p);
  const wrong = [];
  let keys = 0;
  CASES.forEach(([role, said, row], i) => {
    const run = `R${i + 3}`, [, severity] = / (low|medium|high) /.exec(said) ?? [];
    const lines = [`$ sage run add T1 --role ${role}`, `> ${run} sage:${role}`, `< ${run} ${said}`];
    if (severity) lines.push(`$ sage finding add T1 --source ${role} --severity ${severity} --summary=case-${i}`);
    play([...lines, `$ sage run done ${run} --status done --tokens 1`], p);
    const passes = ALL.filter((kind) => p.ask(`node ${TOOL} verdict T1 --sha ${p.head()} --kind ${kind} --cycle 1 --pr 12 --run ${run}`) === undefined);
    if (passes.length !== 1 || !kinds(row).includes(passes[0])) wrong.push(`${role} "${said}": the hook passes ${passes.join(", ") || "no kind"}; the table names ${kinds(row).join(", ")}`);
    if (severity) p.chief("finding", "triage", "T1", `F-T1-${++keys}`, "dismiss", "--reason", "a-fixture"); // the next case starts with no open finding
  });
  assert.deepEqual(wrong, [], "the file's verdict table and the hook differ");
});

test("T301: the lead file's helper cap is the hook's, and with the default agent cap one lead and its helpers fill the project", () => {
  const cap = Number(/At most (\d) helpers run at once/.exec(TEXT)?.[1] ?? assert.fail("the file states its helper cap"));
  const p = project({ size: "large" }); // the default max_agents: 4
  play(["$ sage task T1 set state=building branch=sage/t1-example", "$ sage run add T1 --role implementer --branch sage/t1-example", "> R2 sage:implementer", "< R2 done: none",
    "$ sage run done R2 --status done --tokens 1", "$ sage task T1 set state=reviewing pr=12"], p);
  const ROLES = ["code-reviewer", "security-reviewer", "ux-reviewer", "qa"];
  play(ROLES.slice(0, cap).flatMap((role, i) => [`$ sage run add T1 --role ${role}`, `> R${i + 3} sage:${role}`]), p);
  play([`$ sage run add T1 --role ${ROLES[cap]}`], p);
  const spawn = { subagent_type: `sage:${ROLES[cap]}`, name: `R${cap + 3}`, description: "one more", prompt: BRIEF, run_in_background: true };
  assert.match(denied(p.send({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: spawn, tool_use_id: "one-more", ...p.lead })) ?? "", new RegExp(`already has ${cap} children|its cap is`), `helper ${cap + 1} waits`);
  // A second lead finds the project's cap full while lead-T1 and its helpers run.
  p.chief("task", "add", "--title", "second", "--size", "small");
  p.chief("task", "T2", "set", "state=briefed");
  p.chief("run", "add", "T2", "--role", "lead");
  assert.match(p.startLead("T2") ?? "", /cap is 4/, "a second lead waits for room under the default cap");
});

test("T301: the hook refuses what the lead file says is the sage's, so the examples' passes are real", () => {
  const p = project();
  for (const args of ["finding move T1 F-T1-1 --to later", "task T1 set state=merged", "run add T1 --role lead", "run add T1 --role pe", "round T1 --project /tmp",
    "finding add T1 --source qa --severity low --summary 'two words'", "gate add T1 --question q --options a,b --recommend a", "log T1 x --why y"]) {
    assert.match(p.ask(`node ${TOOL} ${args}`) ?? "", /^sage: /, `the lead's ${args}`);
  }
  const spawn = (type, name) => denied(p.send({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: type, name, prompt: BRIEF, run_in_background: true }, tool_use_id: `try-${name}`, ...p.lead }));
  assert.match(spawn("sage:pe", "R2") ?? "", /a lead starts only an implementer/);
  assert.match(spawn("sage:qa", "lead-T2") ?? "", /never names a spawn "main" or "lead-T<n>"/);
  assert.match(spawn("sage:qa", "R7") ?? "", /R7 is not a running qa run of T1/, "a helper's name is a run that the lead added");
  const message = (to) => denied(p.send({ hook_event_name: "PreToolUse", tool_name: "SendMessage", tool_input: { to, message: "done" }, ...p.lead }));
  assert.match(message("R2") ?? "", /an agent sends a message only to main/);
  assert.equal(message("main"), undefined, "a message to the sage passes");
  assert.match(denied(p.send({ hook_event_name: "PreToolUse", tool_name: "TaskStop", tool_input: { task_id: "child-R2" }, ...p.lead })) ?? "", /a lead stops no agent/, "the lead's TaskStop (F-T301-14)");
});

test("T301: the lead file gets only the tools that a lead needs", () => {
  const tools = /^tools: (.+)$/m.exec(TEXT.split("\n---\n")[0])?.[1].split(", ") ?? assert.fail("agents/lead.md lists its tools");
  assert.deepEqual(tools.filter((t) => !["Bash", "Read", "Grep", "Glob", "Agent", "SendMessage"].includes(t)), [], "no tool past the lead's own: no web, no MCP, no edit");
  for (const t of ["Bash", "Agent", "SendMessage"]) assert.ok(tools.includes(t), `the examples need ${t}`);
});
