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
/** The lead's wait command (T482): `wait <T>` in the file. */
const WAIT = at("../plugins/sage/hooks/wait.mjs");
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
// The fake gh: it answers only "gh pr checks <n>" as CI with one check does, and "gh pr view <n> --json headRefOid" with
// the head of the branch in the remote that the file remote next to it names (p.remote). The check passes, unless the
// file checks next to it has lines: each call then takes the first line as the check's state (p.checks). Any other call
// fails, so the file cannot teach a gh command that the test does not know.
const FAKE_GH = `#!/usr/bin/env node
const fs = require("fs"), path = require("path").join(__dirname, "checks");
const a = process.argv.slice(2);
if (a.length === 5 && a[0] === "pr" && a[1] === "view" && /^[1-9][0-9]*$/.test(a[2]) && a[3] === "--json" && a[4] === "headRefOid") {
  const remote = fs.readFileSync(require("path").join(__dirname, "remote"), "utf8");
  const sha = require("child_process").execFileSync("git", ["--git-dir", remote, "rev-parse", "sage/t1-example"], { encoding: "utf8" }).trim();
  console.log(JSON.stringify({ headRefOid: sha }));
  process.exit(0);
}
if (!(a.length === 3 && a[0] === "pr" && a[1] === "checks" && /^[1-9][0-9]*$/.test(a[2]))) { console.error("the fake gh knows only gh pr checks <n> and gh pr view <n> --json headRefOid: " + a.join(" ")); process.exit(1); }
const [state, ...rest] = fs.existsSync(path) ? fs.readFileSync(path, "utf8").split("\\n").filter(Boolean) : [];
if (state) fs.writeFileSync(path, rest.join("\\n"));
console.log("build\\t" + (state ?? "pass") + "\\t1m\\thttps://example.invalid/runs/1");
`;
// The state tool's default agent cap: what sage config prints in an empty logbook root.
const DEFAULT_CAP = (() => {
  const root = mkdtempSync(join(tmpdir(), "sage-lead-config-"));
  const out = spawnSync("node", [TOOL, "config"], { env: { ...process.env, HOME: join(root, "home"), SAGE_HOME: join(root, "sage") } }).stdout;
  return Number(/(?:^|\s)max_agents=(\d+)(?:\s|$)/.exec(out)?.[1] ?? assert.fail(`sage config prints no max_agents: ${out}`));
})();
// The words that the file gives the lead for the first line of its RESULT.
const LEAD_RESULTS = [.../\*\*RESULT\*\*: first line ((?:`\w+`(?:, | or )?)+)/.exec(TEXT)?.[1].matchAll(/`(\w+)`/g) ?? assert.fail("agents/lead.md lists the RESULT words")].map((m) => m[1]);
// The sage's step after a lead's blocked report, from the chief bindings (step 6 of DISPATCH): the tests below play the
// sage's commands from its code spans, so a change of a command or of a move there fails a test (F-T301-39).
const BLOCKED_STEP = /^ {3}6\. \*\*A blocked report:\*\*[\s\S]*?(?=^ {3}7\. )/m.exec(JSON.parse(readFileSync(at("../plugins/sage/chief-bindings.json"), "utf8")).DISPATCH)?.[0]
  ?? assert.fail("the chief bindings have step 6, a blocked report");
// The state moves that the sage makes from the logbook after a blocked report: "- <from> to <to> (`sage task <T> set state=<to>`)".
const SAGE_MOVES = [...BLOCKED_STEP.matchAll(/^ {3}- (\w+) to (\w+) \(`sage task <T> set state=\2`\)/gm)].map((m) => `${m[1]}>${m[2]}`);
// The moves that the tests of this file play after a blocked report: the last test compares them with SAGE_MOVES, so a
// move that step 6 adds, drops or changes, and that no test plays, fails it (F-T301-51).
const PLAYED = new Set();
// The sage's step after a lead's ready report (step 5 of DISPATCH).
const READY_STEP = /^ {3}5\. \*\*A ready report\*\*[\s\S]*?(?=^ {3}6\. )/m.exec(JSON.parse(readFileSync(at("../plugins/sage/chief-bindings.json"), "utf8")).DISPATCH)?.[0]
  ?? assert.fail("the chief bindings have step 5, a ready report");
/** The sage's first command of step 6 that starts with these words, in the line that has the words of "within", as an example's ! line, with its placeholders filled from values. */
function sageSays(start, values = {}, within = "") {
  const line = BLOCKED_STEP.split("\n").find((l) => l.includes(within) && l.includes(`\`${start}`)) ?? assert.fail(`the chief bindings' step 6 has no \`${start} ...\` in a line with "${within}"`);
  const span = [...line.matchAll(/`(sage [^`]+)`/g)].map((m) => m[1]).find((s) => s.startsWith(start));
  return `! ${span.replace(/F-<x>|<[^>]+>/g, (hole) => ({ "<T>": "T1", ...values })[hole] ?? assert.fail(`no value for ${hole} in "${span}"`))}`;
}
/** The sage's first command of step 5 that starts with these words, as an example's ! line, with its placeholders filled from values (F-T301-69). */
function readySays(start, values = {}) {
  const span = [...READY_STEP.matchAll(/`((?:git|gh|sage) [^`]+)`/g)].map((m) => m[1]).find((s) => s.startsWith(start)) ?? assert.fail(`the chief bindings' step 5 has no \`${start} ...\``);
  return `! ${span.replace(/<[^>]+>/g, (hole) => ({ "<n>": "12", "<branch>": "sage/t1-example", ...values })[hole] ?? assert.fail(`no value for ${hole} in "${span}"`))}`;
}
/** The lead's command of agents/lead.md that is exactly this form, in the line that has the words of "within", as an example's $ line, with its placeholders filled from values. */
function leadSays(form, within, values = {}) {
  const line = TEXT.split("\n").find((l) => l.includes(within) && l.includes(`\`${form}\``)) ?? assert.fail(`agents/lead.md has no \`${form}\` in a line with "${within}"`);
  return `$ ${form.replace(/<[^>]+>/g, (hole) => ({ "<T>": "T1", ...values })[hole] ?? assert.fail(`no value for ${hole} in "${form}" (${line.slice(0, 40)})`))}`;
}
/** The words of a ! line, where a double-quoted value is one word, as a shell reads it. */
const shellWords = (text) => [...text.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
// The line that the file says run add prints, as a pattern: each placeholder is one word, and the line may go on (· model <m>).
const RUN_ADD = (() => {
  const form = /It prints the run id: `([^`]+)`/.exec(TEXT)?.[1] ?? assert.fail("agents/lead.md states what run add prints");
  return new RegExp(`^${form.split(/(<[^>]+>)/).map((part) => (/^<[^>]+>$/.test(part) ? "\\S+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("")}(?: · .*)?$`);
})();

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
  const scripts = { sage: TOOL, wait: WAIT }; // the file's sage and wait stand for node and a script of the plugin
  const run = (program, args) => spawnSync(scripts[program] ? "node" : program, scripts[program] ? [scripts[program], ...args] : args, { cwd: folder, env });
  const chief = (...args) => {
    const r = spawnSync("node", [TOOL, ...args, "--project", folder], { env });
    assert.equal(r.status, 0, `the sage's sage ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const p = { folder, send, run, chief, lead: undefined, leads: 0 };
  /** The states of the next calls of gh pr checks, one per call; after them, the check passes. */
  p.checks = (...states) => writeFileSync(join(bin, "checks"), states.join("\n"));
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
  /** A remote origin with the task's branch, as GitHub holds it; the fake gh reads its head. Its folder. */
  p.remote = () => {
    const bare = join(dir, "origin.git");
    spawnSync("git", ["init", "-q", "--bare", bare]);
    writeFileSync(join(bin, "remote"), bare);
    git("remote", "add", "origin", bare);
    git("push", "-q", "origin", "sage/t1-example");
    return bare;
  };
  /** A commit on the remote's branch only, as a push from elsewhere or GitHub's own update makes it. Its SHA. */
  p.remoteCommit = (bare) => {
    const remote = (...args) => spawnSync("git", ["--git-dir", bare, ...args]).stdout.trim();
    const parent = remote("rev-parse", "sage/t1-example");
    const sha = remote("-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", `${parent}^{tree}`, "-p", parent, "-m", "remote work");
    remote("update-ref", "refs/heads/sage/t1-example", sha);
    return sha;
  };
  p.git = git;
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
  const roles = {}, ran = [], sage = [], moves = []; // ran: the lead's commands; sage: the sage's; moves: the sage's state moves after a blocked report
  let printed, last, logbook, recheck = new Set(); // printed: the output of the line just before; recheck: the roles that round named and that have not reported
  let blocked = false; // a lead ended blocked, and no fresh lead has started yet
  const fill = (text) => text.replaceAll("<sha>", () => p.head()).replaceAll("<logbook>", () => logbook ?? assert.fail("<logbook> before sage logbook"));
  for (const line of lines) {
    const [mark, ...rest] = line.split(" "), text = rest.join(" ");
    const was = printed;
    printed = undefined; // a → line compares only with the output of the command just before it
    if (mark === "$") {
      const [program, ...args] = fill(text).split(" ");
      assert.ok(["sage", "wait", "git", "gh", "cat"].includes(program), `agents/lead.md: the lead runs "${line}", which is not a command that the file teaches`);
      const command = program === "sage" ? `node ${TOOL} ${args.join(" ")}` : program === "wait" ? `node ${WAIT} ${args.join(" ")}` : [program, ...args].join(" ");
      assert.equal(p.ask(command), undefined, `the hook refuses: ${line}`);
      // The file says that the checks verdict is the sage's; until the hook refuses it for a lead (T302), the test does.
      assert.ok(!(program === "sage" && args[0] === "verdict" && /^checks-/.test(args[args.indexOf("--kind") + 1])),`${line}: the checks verdict is the sage's (! sage verdict ...)`);
      if (program === "sage" && args[0] === "finding" && args[1] === "close") assert.deepEqual([...recheck], [], `${line}: round named a role that has not re-checked`);
      const r = p.run(program, args);
      assert.equal(r.status, 0, `${line}: ${r.stderr}`);
      last = printed = r.stdout.trim();
      if (program === "sage") p.send({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_response: { stdout: r.stdout, stderr: r.stderr, interrupted: false }, ...p.lead });
      if (program === "sage" && args[0] === "round") recheck = new Set(/ re-run (\S+) on /.exec(printed)?.[1].split(",") ?? []);
      if (program === "sage" && args[0] === "run" && args[1] === "add") assert.match(printed, RUN_ADD, `${line}: the file says that run add prints ${RUN_ADD}`);
      ran.push([program, ...args].join(" "));
    } else if (mark === "→") {
      assert.ok(was !== undefined, `agents/lead.md: "${line}" does not follow a command`);
      if (text === "<logbook>") (logbook = was), assert.match(logbook, /^\//, "sage logbook prints a folder");
      else {
        // Word by word: a line cut inside a word (R1 for R10) differs (F-T301-25).
        const want = words(fill(text)).split(" ");
        assert.deepEqual(words(was).split(" ").slice(0, want.length), want, `the file says "${text}", the command printed "${was}"`);
      }
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
      if (who === "lead-T1") assert.ok(LEAD_RESULTS.includes(result), `${line}: the file gives the lead's RESULT only as ${LEAD_RESULTS.join(", ")}`);
      if (who === "lead-T1" && result === "blocked") blocked = true;
      recheck.delete(agent.agent_type.slice("sage:".length));
      const out = p.send({ hook_event_name: "SubagentStop", ...agent, stop_hook_active: false, last_assistant_message: report(result, findings) });
      assert.equal(out?.decision, undefined, `the stop gate blocks ${who}'s report: ${out?.reason}`);
      if (who === "lead-T1") p.lead = undefined;
    } else if (mark === "!" && rest[0] === "sage") {
      // The sage takes no state from a blocked report (D2): it makes only the moves of the chief bindings' step 6. The move
      // to verified is step 5's, and the state tool holds it: it needs a checks verdict on the head.
      const to = /^task T1 set state=(\S+)$/.exec(rest.slice(1).join(" "))?.[1], move = to && `${p.chief("task", "T1").split(" ")[1]}>${to}`;
      if (blocked && to && to !== "verified") assert.ok(SAGE_MOVES.includes(move), `${line}: after a blocked report the sage moves the task only as the chief bindings say (${SAGE_MOVES.join(", ")}), not ${move}`);
      if (blocked && to && to !== "verified") moves.push(move), PLAYED.add(move);
      last = printed = p.chief(...shellWords(fill(rest.slice(1).join(" "))));
      sage.push(fill(text));
    } else if (mark === "!" && rest[0] === "gh") {
      const r = p.run("gh", rest.slice(1)); // the sage's own gh pr checks
      assert.equal(r.status, 0, `${line}: ${r.stderr}`);
      last = printed = r.stdout.trim();
    } else if (mark === "!" && rest[0] === "git") {
      // The sage's own git command (step 5): the hook lets the main session run it, and it runs for real.
      const command = fill(text);
      assert.equal(denied(p.send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } })), undefined, `the hook refuses the sage's ${line}`);
      const r = p.run("git", shellWords(command).slice(1));
      last = printed = `${r.status === 0 ? "ok" : "refused"} ${(r.stdout + r.stderr).trim()}`;
      sage.push(command);
    } else if (mark === "!" && rest[0] === "stop") {
      p.send({ hook_event_name: "PreToolUse", tool_name: "TaskStop", tool_input: { task_id: `child-${rest[1]}` } }); // the main session's TaskStop
    } else if (mark === "!" && rest[0] === "start") {
      assert.equal(p.startLead(rest[1].slice("lead-".length)), undefined, `the hook refuses: ${line}`);
      blocked = false;
    } else assert.fail(`agents/lead.md: the example line "${line}" starts with no known mark ($, →, >, <, ! sage, ! gh, ! git, ! stop, ! start)`);
  }
  return { ran, sage, moves, printed: last };
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
  const taught = [...TEXT.matchAll(/`((?:sage|wait|git|gh|cat|node <path to skills\/sage\/sage\.mjs>) [^`]+)`/g)].map((m) => m[1].replace(/^node <path to skills\/sage\/sage\.mjs> /, "sage "));
  assert.ok(taught.length > 20, "the file teaches its commands in code spans");
  for (const form of taught) {
    // A placeholder such as <T>, <sha> or <word> stands for one word or part of one; the rest of the form must be the same, to its end.
    const shape = new RegExp(`^${form.split(/(<[^>]+>)/).map((part) => (/^<[^>]+>$/.test(part) ? "\\S+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("")}$`);
    assert.ok(ran.some((command) => shape.test(command)), `agents/lead.md teaches "${form}", and no example runs it in full`);
  }
});

// The start of a life that both paths below share: the build, then one cycle of code review and QA on its head.
const BUILT = ["$ sage task T1 set state=building branch=sage/t1-example", "$ sage run add T1 --role implementer --branch sage/t1-example", "> R2 sage:implementer", "< R2 done: none",
  "$ sage run done R2 --status done --tokens 1", "$ sage task T1 set state=reviewing pr=12", "$ git rev-parse sage/t1-example", "$ sage run add T1 --role code-reviewer", "→ R3 running · code-reviewer on T1",
  "$ sage run add T1 --role qa", "→ R4 running · qa on T1", "> R3 sage:code-reviewer", "> R4 sage:qa"];
// A fresh lead's first reads, as step 1 says.
const FRESH = ["$ sage status", "$ sage logbook", "→ <logbook>", "$ cat <logbook>/tasks.tsv", "$ cat <logbook>/findings.tsv"];

// The cycle above, clean: the reports, the runs' ends and the verdicts.
const CLEAN = ["< R3 CLEAN: none", "< R4 PASS: none", "$ sage run done R3 --status done --tokens 1", "$ sage verdict T1 --sha <sha> --kind review-clean --cycle 1 --pr 12 --run R3",
  "$ sage run done R4 --status done --tokens 1", "$ sage verdict T1 --sha <sha> --kind qa-pass --cycle 1 --pr 12 --run R4"];

test("T301 D3: after a CI failure the sage adds the finding for QA and triages it fix, so the fresh lead goes on from step 1 to the round, which names QA; the task then merges", () => {
  const p = project();
  p.checks("fail");
  const { sage, printed } = play([...BUILT, ...CLEAN, "$ gh pr checks 12", "→ build fail", "< lead-T1 blocked: none",
    "! sage run done R1 --status blocked --tokens 1", "! sage verdict T1 --sha <sha> --kind checks-fail --cycle 1 --pr 12",
    sageSays("sage finding add <T> --source", { "<words>": "the CI build fails", "<R>": "R1" }, "They failed:"), "→ F-T1-1 open · medium · T1", sageSays("sage finding triage <T> <K> fix", { "<K>": "F-T1-1" }, "They failed:"),
    "! sage run add T1 --role lead", "→ R5 running · lead on T1", "! start lead-T1",
    ...FRESH, "$ sage round T1", "→ T1 repairing · round 1 of 3 · fix F-T1-1 · re-run qa on the repair's diff",
    "$ sage run add T1 --role implementer --branch sage/t1-example", "→ R6 running · implementer on T1", "> R6 sage:implementer", "< R6 done: none", "$ sage run done R6 --status done --tokens 1",
    "$ sage run add T1 --role qa", "→ R7 running · qa on T1", "> R7 sage:qa", "< R7 PASS: none", "$ sage run done R7 --status done --tokens 1",
    "$ sage finding close T1 F-T1-1", "$ sage task T1 set state=reviewing",
    "$ sage run add T1 --role code-reviewer", "→ R8 running · code-reviewer on T1", "$ sage run add T1 --role qa", "→ R9 running · qa on T1", "> R8 sage:code-reviewer", "> R9 sage:qa",
    "< R8 CLEAN: none", "< R9 PASS: none", "$ sage run done R8 --status done --tokens 1", "$ sage verdict T1 --sha <sha> --kind review-clean --cycle 1 --pr 12 --run R8",
    "$ sage run done R9 --status done --tokens 1", "$ sage verdict T1 --sha <sha> --kind qa-pass --cycle 1 --pr 12 --run R9",
    "$ gh pr checks 12", "→ build pass", "$ sage task T1 set state=verifying", "< lead-T1 ready: none",
    "! sage verdict T1 --sha <sha> --kind checks-pass --cycle 1 --pr 12", "! sage task T1 set state=verified", "! sage merge-check --sha <sha> --pr 12"], p);
  assert.match(sage.at(-1), /^sage merge-check --sha [0-9a-f]{40} --pr 12$/);
  assert.match(printed, /^T1 may merge/, "the repair's head merges after QA's re-check and a fresh clean cycle");
});

// The start of a repair: R3 reports a medium finding (F-T1-1, and with low, a low one F-T1-2 too), R4 passes, round 1
// fixes them, R5 repairs, and R6 re-checks the repair's head.
const REPAIR = (low) => [...BUILT, `< R3 FINDINGS: - K1 medium a.mjs:1 the token is logged${low ? "\n- K2 low a.mjs:2 the log line has no label" : ""}`, "< R4 PASS: none",
  "$ sage finding add T1 --source code-reviewer --severity medium --summary=token-logged --run R3 --class security", "→ F-T1-1 open · medium · T1",
  ...(low ? ["$ sage finding add T1 --source code-reviewer --severity low --summary=log-line-has-no-label --run R3 --class copy", "→ F-T1-2 open · low · T1"] : []),
  "$ sage run done R3 --status done --tokens 1", "$ sage verdict T1 --sha <sha> --kind findings --cycle 1 --pr 12 --run R3",
  "$ sage run done R4 --status done --tokens 1", "$ sage verdict T1 --sha <sha> --kind qa-pass --cycle 1 --pr 12 --run R4",
  "$ sage finding triage T1 F-T1-1 fix", ...(low ? ["$ sage finding triage T1 F-T1-2 fix"] : []), "$ sage round T1",
  `→ T1 repairing · round 1 of 3 · fix ${low ? "F-T1-1,F-T1-2" : "F-T1-1"} · re-run code-reviewer on the repair's diff`,
  "$ sage run add T1 --role implementer --branch sage/t1-example", "→ R5 running · implementer on T1", "> R5 sage:implementer", "< R5 done: none", "$ sage run done R5 --status done --tokens 1",
  "$ sage run add T1 --role code-reviewer", "→ R6 running · code-reviewer on T1", "> R6 sage:code-reviewer"];
// The sage's triage of a finding that the lead calls a repeat: fix, never a dismissal (F-T301-55).
const repeatFix = (key) => sageSays("sage finding triage <T> <K> fix", { "<K>": key }, "Never dismiss a finding because the lead names it");
/** The finding's row: its key, severity, triage and status. */
const findingOf = (p, key) => readFileSync(join(p.chief("logbook"), "findings.tsv"), "utf8").split("\n").map((row) => row.split("\t")).find((cells) => cells[1] === key)?.slice(0, 9); // task to status: the columns before run and class (T346)

test("T301 D1, F-T301-55: a fix that the re-check did not confirm is never moved; the sage triages its repeat fix, never a dismissal, the task goes back to reviewing, and round re-plans it", () => {
  const p = project();
  const { printed, moves } = play([...REPAIR(false), "< R6 FINDINGS: - K2 medium a.mjs:1 the token is still logged",
    "$ sage finding add T1 --source code-reviewer --severity medium --summary=token-still-logged --run R6 --class security", "→ F-T1-2 open · medium · T1", "$ sage run done R6 --status done --tokens 1",
    "< lead-T1 blocked: - F-T1-2 medium a.mjs:1 the token is still logged, repeat of F-T1-1",
    "! sage run done R1 --status blocked --tokens 1", repeatFix("F-T1-2"),
    sageSays("sage task <T> set state=reviewing"), "! sage run add T1 --role lead", "→ R7 running · lead on T1", "! start lead-T1",
    ...FRESH, "$ sage round T1"], p);
  assert.match(printed, /^T1 replan: round 1 did not fix F-T1-1\./, "the unconfirmed fix re-plans the task instead of a move");
  assert.match(p.chief("task", "T1"), /^T1 replan /);
  assert.deepEqual(moves, ["repairing>reviewing"], "the sage's one state move");
  assert.deepEqual(findingOf(p, "F-T1-2").slice(-3), ["fix", "", "open"], "the repeat stays open, triaged fix: it is not dismissed");
});

test("T301 F-T301-55: a high finding of a re-check that the lead calls a repeat of a closed fix key stays open: it blocks the merge and gets the next round", () => {
  const p = project();
  play([...REPAIR(false), "< R6 FINDINGS: - K2 high b.mjs:9 user input reaches a shell command",
    "$ sage finding add T1 --source code-reviewer --severity high --summary=user-input-reaches-shell --run R6 --class security", "→ F-T1-2 open · high · T1", "$ sage run done R6 --status done --tokens 1",
    "$ sage finding close T1 F-T1-1", "$ sage task T1 set state=reviewing",
    "< lead-T1 blocked: - F-T1-2 high b.mjs:9 user input reaches a shell command, repeat of F-T1-1",
    "! sage run done R1 --status blocked --tokens 1", repeatFix("F-T1-2")], p);
  assert.deepEqual(findingOf(p, "F-T1-2").slice(-3), ["fix", "", "open"], "the high repeat stays open");
  const verifying = p.run("sage", ["task", "T1", "set", "state=verifying"]);
  assert.match(verifying.stderr, /T1 has open findings: F-T1-2 \(fix\)/, "the task cannot reach verifying");
  play(["! sage verdict T1 --sha <sha> --kind checks-pass --cycle 1 --pr 12"], p); // even with the checks passed on the head
  const merge = p.run("sage", ["merge-check", "--sha", p.head(), "--pr", "12"]);
  assert.notEqual(merge.status, 0, "the merge check refuses");
  assert.match(merge.stdout + merge.stderr, /open findings: F-T1-2/, "because the high repeat is open");
  const { printed: next } = play(["! sage run add T1 --role lead", "→ R7 running · lead on T1", "! start lead-T1", ...FRESH, "$ sage round T1"], p);
  assert.match(next, /^T1 repairing · round 2 of 3 · fix F-T1-2 · re-run code-reviewer/, "the next round fixes it");
});

test("T301 F-T301-56, F-T301-59: a medium finding that the lead calls a repeat of a low fix key joins the next round, and the low key joins it too: no low path", () => {
  const p = project();
  const { printed, moves } = play([...REPAIR(true), "< R6 FINDINGS: - K3 medium a.mjs:2 the log line now writes the session token",
    "$ sage finding add T1 --source code-reviewer --severity medium --summary=log-line-writes-session-token --run R6 --class security", "→ F-T1-3 open · medium · T1", "$ sage run done R6 --status done --tokens 1",
    "$ sage finding close T1 F-T1-1",
    "< lead-T1 blocked: - F-T1-3 medium a.mjs:2 the log line now writes the session token, repeat of F-T1-2",
    "! sage run done R1 --status blocked --tokens 1", repeatFix("F-T1-3"),
    sageSays("sage task <T> set state=reviewing"), "! sage run add T1 --role lead", "→ R7 running · lead on T1", "! start lead-T1", ...FRESH, "$ sage round T1"], p);
  assert.match(printed, /^T1 repairing · round 2 of 3 · fix F-T1-2,F-T1-3 · re-run code-reviewer/, "the low key joins the next round with the medium repeat");
  assert.deepEqual(moves, ["repairing>reviewing"]);
  assert.deepEqual(findingOf(p, "F-T1-2").slice(-3), ["fix", "", "open"], "the low key is not dismissed");
});

test("T301 F-T301-59: while a medium fix key of the round is still open, the sage keeps the unconfirmed low key, and round still re-plans when the round fixed nothing", () => {
  const p = project();
  const { printed } = play([...REPAIR(true), "< R6 FINDINGS: - K3 medium a.mjs:1 the token is still logged\n- K4 low a.mjs:2 the log line still has no label",
    "$ sage finding add T1 --source code-reviewer --severity medium --summary=token-still-logged --run R6 --class security", "→ F-T1-3 open · medium · T1",
    "$ sage finding add T1 --source code-reviewer --severity low --summary=log-line-still-has-no-label --run R6 --class copy", "→ F-T1-4 open · low · T1", "$ sage run done R6 --status done --tokens 1",
    "< lead-T1 blocked: - F-T1-3 medium a.mjs:1 the token is still logged, repeat of F-T1-1\n- F-T1-4 low a.mjs:2 the log line still has no label, repeat of F-T1-2",
    "! sage run done R1 --status blocked --tokens 1", repeatFix("F-T1-3"), repeatFix("F-T1-4"),
    sageSays("sage task <T> set state=reviewing"), "! sage run add T1 --role lead", "→ R7 running · lead on T1", "! start lead-T1", ...FRESH, "$ sage round T1"], p);
  assert.match(printed, /^T1 replan: round 1 did not fix F-T1-1,F-T1-2\./, "the round fixed none of its keys: a replan, as without the low key");
  assert.equal(findingOf(p, "F-T1-2").at(-1), "open", "the low key waits with the medium one");
  assert.match(BLOCKED_STEP, /While a medium or high finding of the task is open and triaged fix[^\n]*it joins the next round with that finding: keep it open\./, "step 6 keeps the low key while a medium or high finding is open");
});

test("T301 F-T301-35, F-T301-68: a low fix that the re-check did not confirm, with no medium or high finding open, goes to a follow-up task that the sage frames; the sage dismisses the key with its reason, triages its low repeat fix and moves it, and the fresh lead reaches verifying", () => {
  const p = project();
  const { moves } = play([...REPAIR(true), "< R6 FINDINGS: - K3 low a.mjs:2 the log line still has no label",
    "$ sage finding add T1 --source code-reviewer --severity low --summary=log-line-still-has-no-label --run R6 --class copy", "→ F-T1-3 open · low · T1", "$ sage run done R6 --status done --tokens 1",
    "$ sage finding close T1 F-T1-1",
    "< lead-T1 blocked: - F-T1-3 low a.mjs:2 the log line still has no label, repeat of F-T1-2",
    "! sage run done R1 --status blocked --tokens 1", repeatFix("F-T1-3"),
    sageSays("sage task <T> set state=reviewing"), sageSays("sage task add", { "<title>": "label the log line", "<size>": "small" }, "unconfirmed low fix"), "→ T2",
    sageSays("sage finding triage <T> <K> dismiss", { "<K>": "F-T1-2", "<n>": "2" }, "unconfirmed low fix"),
    sageSays("sage finding move <T> <K> --to", { "<K>": "F-T1-3", "<title>": "label the log line again" }, "unconfirmed low fix"), "→ F-T1-3 moved to T3 as F-T3-1",
    "! sage run add T1 --role lead", "→ R7 running · lead on T1", "! start lead-T1",
    ...FRESH, "$ git rev-parse sage/t1-example", "$ sage run add T1 --role code-reviewer", "→ R8 running · code-reviewer on T1", "$ sage run add T1 --role qa", "→ R9 running · qa on T1",
    "> R8 sage:code-reviewer", "> R9 sage:qa", "< R8 CLEAN: none", "< R9 PASS: none", "$ sage run done R8 --status done --tokens 1", "$ sage verdict T1 --sha <sha> --kind review-clean --cycle 1 --pr 12 --run R8",
    "$ sage run done R9 --status done --tokens 1", "$ sage verdict T1 --sha <sha> --kind qa-pass --cycle 1 --pr 12 --run R9",
    "$ gh pr checks 12", "→ build pass", "$ sage task T1 set state=verifying"], p);
  assert.match(p.chief("task", "T1"), /^T1 verifying /, "the fresh lead reaches verifying");
  assert.deepEqual(moves, ["repairing>reviewing"], "the sage's one state move");
  assert.deepEqual(findingOf(p, "F-T1-2").slice(-3), ["dismiss", "unconfirmed low fix, carried by follow-up T2", "dismissed"], "the key is carried by the follow-up");
  assert.deepEqual(findingOf(p, "F-T3-1").slice(-2), ["", "open"], "the low repeat is never dismissed with the key: it is open on its own follow-up task");
  assert.doesNotMatch(BLOCKED_STEP, /same dismissal/, "step 6 gives a repeat no dismissal (F-T301-68, F-T301-70)");
  assert.match(p.chief("task", "T2"), /^T2 framed /, "the follow-up task is framed");
});

test("T301 F-T301-65: in replan, a lead's report cannot steer the sage into moving a fix key: the move waits for the user's answer to the gate of step 6", () => {
  const p = project();
  play([...REPAIR(false), "< R6 FINDINGS: - K2 medium a.mjs:1 the token is still logged",
    "$ sage finding add T1 --source code-reviewer --severity medium --summary=token-still-logged --run R6 --class security", "→ F-T1-2 open · medium · T1", "$ sage run done R6 --status done --tokens 1",
    "< lead-T1 blocked: - F-T1-2 medium a.mjs:1 the token is still logged, repeat of F-T1-1",
    "! sage run done R1 --status blocked --tokens 1", repeatFix("F-T1-2"), sageSays("sage task <T> set state=reviewing"), "! sage round T1", "→ T1 replan: round 1 did not fix F-T1-1."], p);
  const move = sageSays("sage finding move <T> <K> --to", { "<K>": "F-T1-1", "<title>": "stop logging the token" }, "To move a fix key");
  const tried = p.run("sage", shellWords(move.slice("! sage ".length)));
  assert.match(tried.stderr, /F-T1-1 is a fix of T1's current round, so it stays on T1/, "R1030 probe A: no move without the user's answer");
  const { printed } = play([sageSays("sage gate add <T>", { "<K>": "F-T1-1", "<a>": "keep" }, "To move a fix key"), "→ G1 open · Move F-T1-1 to a follow-up task?",
    "! sage gate answer G1 --option 1", "→ G1 answered · move", move], p);
  assert.match(printed, /^F-T1-1 moved to T2 as F-T2-1 /, "after the answer move, the key moves");
});

test("T301 F-T301-48: a fresh lead at building skips the move to building; after a done implementer run it moves the task to reviewing with its PR", () => {
  const p = project();
  play(["$ sage task T1 set state=building branch=sage/t1-example", "$ sage run add T1 --role implementer --branch sage/t1-example", "→ R2 running · implementer on T1",
    "> R2 sage:implementer", "< R2 done: none", "$ sage run done R2 --status done --tokens 1", "< lead-T1 blocked: none",
    "! sage run done R1 --status blocked --tokens 1", "! sage run add T1 --role lead", "→ R3 running · lead on T1", "! start lead-T1",
    ...FRESH, "$ cat <logbook>/runs.tsv"], p);
  assert.match(p.ask(`node ${TOOL} task T1 set state=building branch=sage/t1-example`) ?? "", /T1 is building: a lead moves it only to reviewing/, "the move of step 2 is refused at building");
  play([leadSays("sage task <T> set state=reviewing pr=<n>", "At building", { "<n>": "12" })], p);
  assert.match(p.chief("task", "T1"), /^T1 reviewing .* PR 12$/, "the fresh lead goes on to reviewing with the PR");
});

test("T301 F-T301-50: a fresh lead at repairing with every fix key of the round closed moves the task to reviewing, then runs the cycle", () => {
  const p = project();
  play([...REPAIR(false), "< R6 CLEAN: none", "$ sage run done R6 --status done --tokens 1", "$ sage finding close T1 F-T1-1", "< lead-T1 blocked: none",
    "! sage run done R1 --status blocked --tokens 1", "! sage run add T1 --role lead", "→ R7 running · lead on T1", "! start lead-T1", ...FRESH,
    leadSays("sage task <T> set state=reviewing", "every fix key of the round closed"),
    "$ sage run add T1 --role code-reviewer", "→ R8 running · code-reviewer on T1", "$ sage run add T1 --role qa", "→ R9 running · qa on T1", "> R8 sage:code-reviewer", "> R9 sage:qa",
    "< R8 CLEAN: none", "< R9 PASS: none", "$ sage run done R8 --status done --tokens 1", "$ sage verdict T1 --sha <sha> --kind review-clean --cycle 1 --pr 12 --run R8",
    "$ sage run done R9 --status done --tokens 1", "$ sage verdict T1 --sha <sha> --kind qa-pass --cycle 1 --pr 12 --run R9",
    "$ gh pr checks 12", "→ build pass", "$ sage task T1 set state=verifying"], p);
  assert.match(p.chief("task", "T1"), /^T1 verifying /);
});

test("T301 F-T301-49: after a ready report whose head moved, the sage records no verdict, and the fresh lead moves the task from verifying back to reviewing and runs the cycle on the new head; the task then merges", () => {
  const p = project();
  play([...BUILT, ...CLEAN, "$ gh pr checks 12", "→ build pass", "$ sage task T1 set state=verifying"], p);
  assert.match(p.ask(`node ${TOOL} task T1 set state=reviewing`) ?? "", /has a full clean cycle, so T1 stays at verifying/, "on the head of the clean cycles, the lead's move back is refused");
  play(["< lead-T1 ready: none"], p);
  p.commit(); // a new commit lands after the clean cycles
  assert.match(READY_STEP, /When they differ, the head moved past the clean cycles: record no verdict\.[^\n]*Then start a fresh lead \(step 7\)/, "step 5 sends a moved head to a fresh lead");
  const { printed } = play(["! sage run done R1 --status done --tokens 1", "! sage run add T1 --role lead", "→ R5 running · lead on T1", "! start lead-T1", ...FRESH, "$ git rev-parse sage/t1-example",
    leadSays("sage task <T> set state=reviewing", "not on the PR's head SHA"),
    "$ sage run add T1 --role code-reviewer", "→ R6 running · code-reviewer on T1", "$ sage run add T1 --role qa", "→ R7 running · qa on T1", "> R6 sage:code-reviewer", "> R7 sage:qa",
    "< R6 CLEAN: none", "< R7 PASS: none", "$ sage run done R6 --status done --tokens 1", "$ sage verdict T1 --sha <sha> --kind review-clean --cycle 1 --pr 12 --run R6",
    "$ sage run done R7 --status done --tokens 1", "$ sage verdict T1 --sha <sha> --kind qa-pass --cycle 1 --pr 12 --run R7",
    "$ gh pr checks 12", "→ build pass", "$ sage task T1 set state=verifying", "< lead-T1 ready: none",
    "! sage verdict T1 --sha <sha> --kind checks-pass --cycle 1 --pr 12", "! sage task T1 set state=verified", "! sage merge-check --sha <sha> --pr 12"], p);
  assert.match(printed, /^T1 may merge/, "the new head merges after its own clean cycle");
});

test("T301 F-T301-69: after a ready report whose head moved only on GitHub, the sage brings that head into the local branch before the fresh lead, which runs the cycle on it; the task then merges", () => {
  const p = project();
  play([...BUILT, ...CLEAN, "$ gh pr checks 12", "→ build pass", "$ sage task T1 set state=verifying", "< lead-T1 ready: none"], p);
  const bare = p.remote(), old = p.head(), moved = p.remoteCommit(bare);
  assert.notEqual(moved, old, "the head moved on GitHub only");
  play(["! sage run done R1 --status done --tokens 1", readySays("gh pr view"), `→ {"headRefOid":"${moved}"}`,
    readySays("git fetch origin <branch>"), "→ ok", readySays("git fetch origin <branch>:"), "→ ok"], p);
  assert.equal(p.head(), moved, "the local branch has GitHub's head before the fresh lead starts");
  const { printed } = play(["! sage run add T1 --role lead", "→ R5 running · lead on T1", "! start lead-T1", ...FRESH, "$ git rev-parse sage/t1-example", `→ ${moved}`,
    leadSays("sage task <T> set state=reviewing", "not on the PR's head SHA"),
    "$ sage run add T1 --role code-reviewer", "→ R6 running · code-reviewer on T1", "$ sage run add T1 --role qa", "→ R7 running · qa on T1", "> R6 sage:code-reviewer", "> R7 sage:qa",
    "< R6 CLEAN: none", "< R7 PASS: none", "$ sage run done R6 --status done --tokens 1", "$ sage verdict T1 --sha <sha> --kind review-clean --cycle 1 --pr 12 --run R6",
    "$ sage run done R7 --status done --tokens 1", "$ sage verdict T1 --sha <sha> --kind qa-pass --cycle 1 --pr 12 --run R7",
    "$ gh pr checks 12", "→ build pass", "$ sage task T1 set state=verifying", "< lead-T1 ready: none",
    "! sage verdict T1 --sha <sha> --kind checks-pass --cycle 1 --pr 12", "! sage task T1 set state=verified", "! sage merge-check --sha <sha> --pr 12"], p);
  assert.match(printed, /^T1 may merge/, "GitHub's head merges after its own clean cycle");
});

test("T301 F-T301-69: a branch in a worktree fast-forwards there; when the local branch has other commits, git refuses, and the sage asks the user", () => {
  const p = project();
  play([...BUILT, ...CLEAN, "$ gh pr checks 12", "→ build pass", "$ sage task T1 set state=verifying", "< lead-T1 ready: none", "! sage run done R1 --status done --tokens 1"], p);
  const bare = p.remote(), wt = join(p.folder, "..", "worktree");
  p.git("worktree", "add", "-q", wt, "sage/t1-example");
  const moved = p.remoteCommit(bare);
  play([readySays("git fetch origin <branch>"), "→ ok", readySays("git -C", { "<folder>": wt }), "→ ok"], p);
  assert.equal(p.head(), moved, "the worktree's branch has GitHub's head");
  spawnSync("git", ["-C", wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "local only"]);
  p.remoteCommit(bare);
  const { printed } = play([readySays("git fetch origin <branch>"), "→ ok", readySays("git -C", { "<folder>": wt })], p);
  assert.match(printed, /^refused /, "git refuses a merge that is no fast-forward");
  assert.match(READY_STEP, /When git refuses \(the local branch has other commits, or the folder has changes\), ask the user with `sage gate add`, and start no lead until the answer\./, "step 5 sends it to the user");
});

test("T301 F-T301-67, F-T301-75: a lead moves the task from verifying or verified back to reviewing only when the head has no full clean cycle of the route; a head that cannot be read stays", () => {
  const p = project();
  p.chief("task", "T1", "set", "branch=sage/t1-example");
  p.commit();
  const STATES = ["verifying", "verified"];
  const back = (state) => (p.setState(state), p.ask(`node ${TOOL} task T1 set state=reviewing`));
  const verdict = (kind, cycle, sha = p.head()) => p.chief("verdict", "T1", "--sha", sha, "--kind", kind, "--cycle", cycle);
  for (const state of STATES) assert.equal(back(state), undefined, `${state}: no verdict on the head`);
  verdict("qa-pass", "1");
  verdict("review-clean", "2");
  for (const state of STATES) assert.equal(back(state), undefined, `${state}: QA in cycle 1 and the review in cycle 2 are no full clean cycle (F-T301-75)`);
  verdict("review-clean", "1", p.head().toUpperCase());
  for (const state of STATES) assert.match(back(state) ?? "", new RegExp(`T1's head [0-9a-f]{7} has a full clean cycle, so T1 stays at ${state}`), `${state}: cycle 1 is full (F-T301-67, R1028 m_verified_same_probe)`);
  p.commit();
  for (const state of STATES) assert.equal(back(state), undefined, `${state}: the head moved past the clean cycle`);
  p.chief("task", "T1", "set", "branch=sage/t1-gone");
  for (const state of STATES) assert.match(back(state) ?? "", new RegExp(`the head of T1's branch cannot be read, so T1 stays at ${state}`), `${state}: fail closed`);
});

test("T301 F-T301-58: after a ready report whose checks fail, the sage does as after a blocked report: the fresh lead at verifying repairs through round, which names QA", () => {
  const p = project();
  p.checks("pass", "fail");
  play([...BUILT, ...CLEAN, "$ gh pr checks 12", "→ build pass", "$ sage task T1 set state=verifying", "< lead-T1 ready: none", "! sage run done R1 --status done --tokens 1", "! gh pr checks 12", "→ build fail"], p);
  assert.match(READY_STEP, /When a check fails, still runs, or there are none, do as \*\*The checks\*\* in step 6 say/, "step 5 sends a failed check to step 6's way");
  const { printed } = play(["! sage verdict T1 --sha <sha> --kind checks-fail --cycle 1 --pr 12",
    sageSays("sage finding add <T> --source", { "<words>": "the CI build fails", "<R>": "R1" }, "They failed:"), "→ F-T1-1 open · medium · T1", sageSays("sage finding triage <T> <K> fix", { "<K>": "F-T1-1" }, "They failed:"),
    "! sage run add T1 --role lead", "→ R5 running · lead on T1", "! start lead-T1", ...FRESH, "$ sage round T1"], p);
  assert.match(printed, /^T1 repairing · round 1 of 3 · fix F-T1-1 · re-run qa on the repair's diff/, "the fresh lead at verifying goes to step 5, and round names QA");
});

test("T301 checks still run:after a blocked report, the sage waits, and after the checks pass it makes its move to verifying; the task then merges", () => {
  const p = project();
  p.checks("pending");
  const { printed, moves } = play([...BUILT, ...CLEAN, "$ gh pr checks 12", "→ build pending", "< lead-T1 blocked: none",
    "! sage run done R1 --status blocked --tokens 1", "! gh pr checks 12", "→ build pass", sageSays("sage task <T> set state=verifying"),
    "! sage verdict T1 --sha <sha> --kind checks-pass --cycle 1 --pr 12", "! sage task T1 set state=verified", "! sage merge-check --sha <sha> --pr 12"], p);
  assert.match(printed, /^T1 may merge/);
  assert.deepEqual(moves, ["reviewing>verifying"], "the sage's one state move");
});

test("T301: the lead file's state table is the hook's: each move in it passes, and each other move of the lead is refused", () => {
  const p = project();
  const moves = table("From").map(([from, to]) => `${from}>${to}`);
  assert.ok(moves.length >= 5, "the file has its state table");
  const STATES = ["framed", "designing", "awaiting-you", "briefed", "building", "reviewing", "repairing", "verifying", "verified", "pr-ready", "held", "replan", "merged", "concluded", "abandoned"];
  p.chief("task", "T1", "set", "branch=sage/t1-example"); // a head with no verdict: the move from verifying to reviewing needs one (F-T301-49)
  p.commit();
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
  const wrong = [], passed = new Map(rows.map(([said]) => [said, new Set()])); // passed: each row's kinds that the hook let pass in its cases
  let keys = 0;
  CASES.forEach(([role, said, row], i) => {
    const run = `R${i + 3}`, [, severity] = / (low|medium|high) /.exec(said) ?? [];
    const lines = [`$ sage run add T1 --role ${role}`, `> ${run} sage:${role}`, `< ${run} ${said}`];
    if (severity) lines.push(`$ sage finding add T1 --source ${role} --severity ${severity} --summary=case-${i} --run ${run} --class copy`);
    play([...lines, `$ sage run done ${run} --status done --tokens 1`], p);
    const passes = ALL.filter((kind) => p.ask(`node ${TOOL} verdict T1 --sha ${p.head()} --kind ${kind} --cycle 1 --pr 12 --run ${run}`) === undefined);
    if (passes.length !== 1 || !kinds(row).includes(passes[0])) wrong.push(`${role} "${said}": the hook passes ${passes.join(", ") || "no kind"}; the table names ${kinds(row).join(", ")}`);
    passes.forEach((kind) => passed.get(row)?.add(kind));
    if (severity) p.chief("finding", "triage", "T1", `F-T1-${++keys}`, "dismiss", "--reason", "a-fixture"); // the next case starts with no open finding
  });
  // A row also names no kind that the hook refuses for each of its cases (F-T301-26).
  for (const [said, kindsOf] of rows) for (const kind of kindsOf.split(/, | or /)) if (!passed.get(said).has(kind)) wrong.push(`the row "${said}" names ${kind}, which the hook passes for none of its reports`);
  assert.deepEqual(wrong, [], "the file's verdict table and the hook differ");
});

test("T301: the lead file's helper cap is the hook's, and with the default agent cap one lead and its helpers fill the project", () => {
  const cap = Number(/At most (\d) helpers run at once/.exec(TEXT)?.[1] ?? assert.fail("the file states its helper cap"));
  const stated = Number(/\(`max_agents`, (\d+) by default\)/.exec(TEXT)?.[1] ?? assert.fail("the file states the default agent cap"));
  assert.equal(stated, DEFAULT_CAP, "the file's default agent cap is the state tool's");
  const BUILD = ["$ sage task T1 set state=building branch=sage/t1-example", "$ sage run add T1 --role implementer --branch sage/t1-example", "> R2 sage:implementer", "< R2 done: none",
    "$ sage run done R2 --status done --tokens 1", "$ sage task T1 set state=reviewing pr=12"];
  const ROLES = ["code-reviewer", "security-reviewer", "ux-reviewer", "qa"];
  /** Starts helpers up to n, one more run, and the hook's answer to its helper's spawn. */
  const fill = (p, n) => {
    const role = (i) => ROLES[i % ROLES.length];
    play(Array.from({ length: n }, (_, i) => [`$ sage run add T1 --role ${role(i)}`, `> R${i + 3} sage:${role(i)}`]).flat(), p);
    play([`$ sage run add T1 --role ${role(n)}`], p);
    const spawn = { subagent_type: `sage:${role(n)}`, name: `R${n + 3}`, description: "one more", prompt: BRIEF, run_in_background: true };
    return denied(p.send({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: spawn, tool_use_id: "one-more", ...p.lead })) ?? "";
  };
  const raised = project({ size: "large", config: [`max_agents=${cap + 2}`] }); // room for the lead, its helpers and one more
  play(BUILD, raised);
  assert.match(fill(raised, cap), new RegExp(`already has ${cap} children`), `helper ${cap + 1} waits for the lead's cap`);
  const p = project({ size: "large" }); // the default max_agents
  play(BUILD, p);
  assert.match(fill(p, DEFAULT_CAP - 1), new RegExp(`its cap is ${DEFAULT_CAP}\\b`), "under the default cap, the project's cap holds first");
  // A second lead finds the project's cap full while lead-T1 and its helpers run.
  p.chief("task", "add", "--title", "second", "--size", "small");
  p.chief("task", "T2", "set", "state=briefed");
  p.chief("run", "add", "T2", "--role", "lead");
  assert.match(p.startLead("T2") ?? "", new RegExp(`cap is ${DEFAULT_CAP}\\b`), "a second lead waits for room under the default cap");
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
  assert.match(denied(p.send({ hook_event_name: "PreToolUse", tool_name: "TaskStop", tool_input: { task_id: "child-R2" }, ...p.lead })) ?? "", /a lead stops no task, also no shell task/, "the lead's TaskStop (F-T301-14)");
});

test("T301: the lead file gets only the tools that a lead needs", () => {
  const tools = /^tools: (.+)$/m.exec(TEXT.split("\n---\n")[0])?.[1].split(", ") ?? assert.fail("agents/lead.md lists its tools");
  assert.deepEqual(tools.filter((t) => !["Bash", "Read", "Grep", "Glob", "Agent", "SendMessage"].includes(t)), [], "no tool past the lead's own: no web, no MCP, no edit");
  for (const t of ["Bash", "Agent", "SendMessage"]) assert.ok(tools.includes(t), `the examples need ${t}`);
});

test("T301 F-T301-51: the state moves that the chief bindings give the sage after a blocked report are the moves that the tests of this file play", () => {
  assert.deepEqual([...PLAYED].sort(), [...SAGE_MOVES].sort(), "the moves of the chief bindings' step 6 and the moves that the tests play differ");
});
