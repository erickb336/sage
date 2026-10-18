// The lead agent file (agents/lead.md) against the sage hook (T301). The file's worked example is the life of one lead:
// each line goes through the hook as Claude Code sends it, from the main session's start of lead-T1 to a passing merge
// check. A line that the hook refuses, a state tool command that fails, or an output that the file states wrongly fails
// the test. So the file teaches only what the hook allows. No real agent starts: the events are hook JSON only.
import "./test-env.mjs"; // first: no variable of the developer's shell changes a result
import assert from "node:assert/strict";
import { spawnSync as rawSpawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const at = (path) => fileURLToPath(new URL(path, import.meta.url));
const LAUNCHER = [at("../plugins/sage/hooks/launcher.mjs"), "sage-hook.mjs"];
const TOOL = at("../plugins/sage/skills/sage/sage.mjs");
const LEAD_FILE = at("../plugins/sage/agents/lead.md");
// Each child call normally takes under 1 s: one that runs 60 s is stuck, and fails instead of stalling the run.
const spawnSync = (command, args, options) => rawSpawnSync(command, args, { timeout: 60_000, killSignal: "SIGKILL", encoding: "utf8", ...options });
const BRIEF = ["GOAL build the form", "SCOPE src/", "CONTEXT none", "DECISIONS none", "ACCEPTANCE it works", "VERIFY npm test", "BUDGET 1 hour of agent time",
  "FORBIDDEN no merge", "REPORT the report of the sage:report skill", "STANDING 1. Work only in your own worktree."].join("\n");
const report = (result, findings) => ["STATUS        done", `RESULT        ${result}`, "EVIDENCE      npm test: pass", `FINDINGS      ${findings}`,
  "QUESTIONS     none", "NOT VERIFIED  none", "BRANCH        sage/t1-example"].join("\n");
const LEAD = { agent_id: "lead-1", agent_type: "sage:lead" };
const denied = (out) => out?.hookSpecificOutput?.permissionDecision === "deny" ? out.hookSpecificOutput.permissionDecisionReason : undefined;

/** The worked example: the first text block after its heading. */
function example(text) {
  const block = /^## A worked example\n[\s\S]*?^```text\n([\s\S]*?)^```$/m.exec(text);
  assert.ok(block, "agents/lead.md has a worked example in a text block");
  return block[1].split("\n").filter(Boolean);
}

/** A project with a git repository, a logbook and the sage's own steps before a lead: T1 briefed, its lead run, lead-T1 started. */
function project() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-lead-agent-")));
  const folder = join(dir, "project");
  const env = { ...process.env, HOME: join(dir, "home"), SAGE_HOME: join(dir, "sage"), SAGE_HOOKS_STATE: join(dir, "hooks") };
  const git = (...args) => spawnSync("git", ["-C", folder, ...args]).stdout.trim();
  spawnSync("git", ["init", "-q", "-b", "main", folder]);
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "start");
  const send = (event) => {
    const r = spawnSync("node", LAUNCHER, { input: JSON.stringify({ session_id: "s1", cwd: folder, ...event }), env });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : undefined;
  };
  // A command as the lead runs it: from the project's folder, without --project or SAGE_PROJECT.
  const run = (args) => spawnSync("node", [TOOL, ...args], { cwd: folder, env });
  const chief = (...args) => {
    const r = spawnSync("node", [TOOL, ...args, "--project", folder], { env });
    assert.equal(r.status, 0, `sage ${args.join(" ")}: ${r.stderr}`);
  };
  send({ hook_event_name: "UserPromptSubmit", prompt: "sage mode" });
  chief("init");
  chief("task", "add", "--title", "example", "--size", "small"); // T1: build, code review, QA
  chief("task", "T1", "set", "state=briefed");
  chief("run", "add", "T1", "--role", "lead"); // R1
  const start = { subagent_type: "sage:lead", name: "lead-T1", description: "lead-T1", prompt: BRIEF, run_in_background: true };
  assert.equal(denied(send({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: start, tool_use_id: "start-lead" })), undefined, "the sage starts lead-T1");
  send({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "start-lead", tool_response: { status: "async_launched", agentId: LEAD.agent_id } });
  send({ hook_event_name: "SubagentStart", ...LEAD });
  // The implementer's work: a new commit at the tip of the task's branch.
  const commit = () => {
    const parent = git("rev-parse", "--verify", "--quiet", "sage/t1-example") || git("rev-parse", "main");
    const sha = git("-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", `${parent}^{tree}`, "-p", parent, "-m", "work");
    git("update-ref", "refs/heads/sage/t1-example", sha);
  };
  return { folder, send, run, commit, head: () => git("rev-parse", "sage/t1-example") };
}

/** Plays the example's lines in order. The state tool commands that ran, with their words. */
function play(lines, p) {
  const roles = {}, ran = [];
  let printed;
  for (const line of lines) {
    const [mark, ...rest] = line.split(" "), text = rest.join(" ");
    if (mark === "$") {
      const state = text.startsWith("sage ");
      const words = (state ? text.slice("sage ".length) : text).replaceAll("<sha>", () => p.head()).split(" ");
      const command = state ? `node ${TOOL} ${words.join(" ")}` : words.join(" ");
      assert.equal(denied(p.send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, ...LEAD })), undefined, `the hook refuses: ${line}`);
      if (!state) continue; // git and gh: the hook's answer is the check
      const r = p.run(words);
      assert.equal(r.status, 0, `${line}: ${r.stderr}`);
      printed = r.stdout.trim();
      p.send({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_response: { stdout: r.stdout, stderr: r.stderr, interrupted: false }, ...LEAD });
      ran.push(words.join(" "));
    } else if (mark === "→") {
      assert.ok(printed?.startsWith(text), `the file says "${text}", the state tool printed "${printed}"`);
    } else if (mark === ">") {
      const [run, type] = rest;
      roles[run] = type;
      const spawn = { subagent_type: type, name: run, description: `${type} for ${run}`, prompt: BRIEF, run_in_background: true };
      assert.equal(denied(p.send({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: spawn, tool_use_id: `spawn-${run}`, ...LEAD })), undefined, `the hook refuses: ${line}`);
      p.send({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: `spawn-${run}`, tool_response: { status: "async_launched", agentId: `child-${run}` }, ...LEAD });
      p.send({ hook_event_name: "SubagentStart", agent_id: `child-${run}`, agent_type: type });
    } else if (mark === "<") {
      const [run, said] = rest, result = said.replace(/:$/, ""), findings = rest.slice(2).join(" ");
      if (roles[run] === "sage:implementer") p.commit();
      const out = p.send({ hook_event_name: "SubagentStop", agent_id: `child-${run}`, agent_type: roles[run], stop_hook_active: false, last_assistant_message: report(result, findings) });
      assert.equal(out?.decision, undefined, `the stop gate blocks ${run}'s report: ${out?.reason}`);
    } else if (mark === "!") {
      const [run] = /R[1-9]\d*/.exec(text);
      p.send({ hook_event_name: "PreToolUse", tool_name: "TaskStop", tool_input: { task_id: `child-${run}` } }); // the main session's TaskStop
    } else assert.fail(`agents/lead.md: the example line "${line}" starts with no known mark ($, →, >, <, !)`);
  }
  return { ran, printed };
}

test("T301: the lead file's worked example runs through the hook, from lead-T1's start to a passing merge check, and runs every command that the file teaches", () => {
  const text = readFileSync(LEAD_FILE, "utf8");
  const { ran, printed } = play(example(text), project());
  assert.match(ran.at(-1), /^merge-check --sha [0-9a-f]{40} --pr 12$/, "the example ends with the merge check");
  assert.match(printed, /may merge/, "and the merge check passes");
  const taught = [...text.matchAll(/`sage ([^`]+)`/g)].map((m) => m[1]);
  assert.ok(taught.length > 10, "the file teaches its commands in code spans");
  for (const form of taught) {
    // A placeholder such as <T>, <sha> or <word> stands for one word; the rest of the form must be the same.
    const shape = new RegExp(`^${form.split(/(<[^>]+>)/).map((part) => (/^<[^>]+>$/.test(part) ? "\\S+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("")}(?: |$)`);
    assert.ok(ran.some((command) => shape.test(command)), `agents/lead.md teaches "sage ${form}", and its worked example never runs it`);
  }
});

test("T301: the hook refuses what the lead file says is the sage's, so the example's passes are real", () => {
  const p = project();
  const bash = (command) => denied(p.send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, ...LEAD }));
  for (const args of ["finding move T1 F-T1-1 --to later", "task T1 set state=merged", "run add T1 --role lead", "run add T1 --role pe", "round T1 --project /tmp",
    "finding add T1 --source qa --severity low --summary 'two words'", "gate add T1 --question q --options a,b --recommend a", "log T1 x --why y"]) {
    assert.match(bash(`node ${TOOL} ${args}`) ?? "", /^sage: /, `the lead's ${args}`);
  }
  const spawn = (type, name) => denied(p.send({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: type, name, prompt: BRIEF, run_in_background: true }, tool_use_id: `try-${name}`, ...LEAD }));
  assert.match(spawn("sage:pe", "R2") ?? "", /a lead starts only an implementer/);
  assert.match(spawn("sage:qa", "lead-T2") ?? "", /never names a spawn "main" or "lead-T<n>"/);
  assert.match(spawn("sage:qa", "R7") ?? "", /R7 is not a running qa run of T1/, "a helper's name is a run that the lead added");
  const message = (to) => denied(p.send({ hook_event_name: "PreToolUse", tool_name: "SendMessage", tool_input: { to, message: "done" }, ...LEAD }));
  assert.match(message("R2") ?? "", /an agent sends a message only to main/);
  assert.equal(message("main"), undefined, "a message to the sage passes");
});
