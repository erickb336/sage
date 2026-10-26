#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, serveStdio, z } from "../runtime/mcp-sdk.mjs";
import { tool } from "../skills/sage/sage.mjs";
import { BRIEF_FIELDS, PRIORITIES, PRIORITY_SCALE } from "sage-core";
import { BRIEF_LIMIT, NAME_RULE, recordBrief } from "../hooks/brief-hook.mjs";
import { CHILD_READS } from "../hooks/gate-hook.mjs";
import { TASK_NAME } from "../hooks/report-gate.mjs";

// The state tool as MCP tools. Codex starts this server outside the shell sandbox, so it can write the logbook
// ($CODEX_HOME/sage, or SAGE_HOME) while agent shells under workspace-write cannot. Each tool runs one command of the
// same state tool as the CLI, with the same checks, and returns its text; a refusal is a tool error with its reason.
const id = (letter, what) => z.string().regex(new RegExp(`^${letter}[1-9]\\d*$`), `${what}, for example ${letter}7`).describe(what);
const task = id("T", "the task id");
const word = z.string().regex(/^(?!--)/, "a value that does not start with --");
const optional = (what) => z.string().optional().describe(what);
const count = (what) => z.union([z.number().int().nonnegative(), z.string()]).optional().describe(what);
const sha = z.string().describe("the full 40-character SHA of the head commit");

/**
 * Each tool: its description, its input fields, and the command words with the positional fields (pos). Every other
 * field is an option of the command, given as --field=value so that a value that starts with -- stays a value.
 */
export const TOOLS = {
  init: { describe: "Make the project's logbook and its standing orders, or check an existing one. Run it once for a new project.", argv: () => ["init"] },
  status: { describe: "Print the status lines of the project's logbook: tasks, runs, gates and programs.", argv: () => ["status"] },
  task_add: {
    describe: "Frame a task and its route. The size gives the least route; a risk flag adds the security review.",
    input: { title: z.string(), size: z.enum(Object.keys(tool.SIZES)), risk: optional(`risk flags joined by a comma: ${tool.RISKS.join(", ")}`),
      add: optional("added blocks, joined by a comma (needs why)"), why: optional("the reason for the added blocks"),
      priority: z.enum(PRIORITIES, { error: PRIORITY_SCALE }).describe(PRIORITY_SCALE), kind: optional("the task's main kind"), waits: optional("the task ids that it waits for, joined by a comma"),
      program: optional("the program id, for example PG1") },
    argv: () => ["task", "add"],
  },
  task_set: {
    describe: "Change a task: its state, branch, pr, priority, kind, waits or program. The tool refuses a move that the route does not allow.",
    input: { task, fields: z.record(z.string().regex(/^[a-z]+$/), z.string()).describe('the keys and values to set, for example {"state": "building", "branch": "codex/t7-name"}') },
    pos: ["task", "fields"],
    argv: (i) => ["task", i.task, "set", ...Object.entries(i.fields).map(([k, v]) => `${k}=${v}`)],
  },
  run_add: {
    describe: "Record an agent run of a task before the agent starts. It prints the run id and the model to pass.",
    input: { task, role: z.string().describe("lead, implementer, pe, designer, arena-judge, code-reviewer, security-reviewer, ux-reviewer, qa, investigate or evidence-review"),
      branch: optional("the run's branch"), candidate: count("the arena candidate number"),
      "usage-interface": optional("collaboration-tools, when Codex gives no token count for the run") },
    pos: ["task"], argv: (i) => ["run", "add", i.task],
  },
  run_done: {
    describe: "Record the end of a run. A done review, QA or evidence-review run needs tokens.",
    input: { run: id("R", "the run id"), status: z.enum(["done", "blocked", "question", "failed"]), tokens: count("the run's tokens, a whole number"),
      report: optional("the absolute path of the saved report"), usage: optional("unavailable, for the collaboration-tools interface only"),
      "usage-source": optional("where the usage comes from"), "usage-evidence": optional("the evidence of the usage") },
    pos: ["run"], argv: (i) => ["run", "done", i.run],
  },
  finding_add: {
    describe: "Record a finding of a review or QA. A known key opens it again. A review or QA finding needs run and class.",
    input: { task, source: z.string().describe("the role that found it, for example code-reviewer"), severity: z.enum(["high", "medium", "low"]),
      summary: optional("the location and the steps that show it"), key: optional("a known finding key, to open it again"),
      run: optional("the run whose report holds the finding; needed for a review or QA source"),
      class: optional("state-edge, speed, copy, layout, security or other; needed for a review or QA source") },
    pos: ["task"], argv: (i) => ["finding", "add", i.task],
  },
  finding_triage: {
    describe: "Triage a finding: fix, dismiss (needs a reason) or ask the owner.",
    input: { task, key: z.string().describe("the finding key, for example F-T7-1"), decision: z.enum(["fix", "dismiss", "ask"]), reason: optional("the reason, needed to dismiss") },
    pos: ["task", "key", "decision"], argv: (i) => ["finding", "triage", i.task, i.key, i.decision],
  },
  finding_close: {
    describe: "Close a fixed finding after a review confirms the fix.",
    input: { task, key: z.string().describe("the finding key") }, pos: ["task", "key"], argv: (i) => ["finding", "close", i.task, i.key],
  },
  finding_move: {
    describe: "Move an open medium or low finding to a new follow-up task, which the tool frames.",
    input: { task, key: z.string().describe("the finding key"), to: z.string().describe("the title of the follow-up task"), size: optional("tiny, small or large (small by default)") },
    pos: ["task", "key"], argv: (i) => ["finding", "move", i.task, i.key],
  },
  verdict: {
    describe: "Record a verdict of checks, a review or QA on a head SHA. Record medium and high findings before a problem verdict.",
    input: { task, kind: z.enum(tool.KINDS), sha: sha.optional(), cycle: count("the cycle number"), pr: count("the pull request number"), run: optional("the run id of the review or QA") },
    pos: ["task"], argv: (i) => ["verdict", i.task],
  },
  round: { describe: "Start a repair round on the open findings marked fix. It names the roles to run again.", input: { task }, pos: ["task"], argv: (i) => ["round", i.task] },
  merge_check: {
    describe: "Check that the logbook allows the merge of this head SHA: clean cycles, no open findings, no open gates.",
    input: { sha, pr: count("the pull request number"), cycles: count("a higher count of clean cycles"), head: optional("the pull request's branch") },
    argv: () => ["merge-check"],
  },
  log: {
    describe: "Add a line to the decision trail. Put the id that the decision is about first.",
    input: { task: z.union([task, z.literal("-")]).describe("the task id, or - for none"), decision: word.describe("the decision"), why: z.string().describe("the reason") },
    pos: ["task", "decision"], argv: (i) => ["log", i.task, i.decision],
  },
  standing: { describe: "Print the standing orders as written. Every brief carries them word for word.", argv: () => ["standing"] },
  standing_add: { describe: "Add one standing order.", input: { order: word.describe("the order") }, pos: ["order"], argv: (i) => ["standing", "add", i.order] },
  pages: {
    describe: "Make and print the folder where agents save the task's pages, or record a page there (its path and sha256) in the decision trail.",
    input: { task, record: optional("the absolute path of a page in that folder, to record it") },
    pos: ["task", "record"], argv: (i) => ["pages", i.task, ...(i.record === undefined ? [] : ["record", String(i.record)])],
  },
  gate_add: {
    describe: "Park a question for the owner, with options, a recommendation and a default.",
    input: { task, question: z.string(), options: z.string().describe("the options joined by |, for example yes|no"), recommend: z.string().describe("the recommended option"),
      default: optional("the default option") },
    pos: ["task"], argv: (i) => ["gate", "add", i.task],
  },
  gate_answer: {
    describe: "Record the owner's answer to a gate: the option's number, or the owner's own words as the hex of their UTF-8 bytes.",
    input: { gate: id("G", "the gate id"), option: count("the number of the option"), "other-hex": optional("the owner's own words, as lower-case hex of their UTF-8 bytes") },
    pos: ["gate"], argv: (i) => ["gate", "answer", i.gate],
  },
};

/** The state tool's arguments for one call of a tool: its words, then its options, then the project. */
export function argvFor(name, input) {
  const { pos = [], argv } = TOOLS[name];
  const options = Object.entries(input).filter(([key, v]) => key !== "project" && !pos.includes(key) && v !== undefined);
  return [...argv(input), ...options.map(([key, v]) => `--${key}=${v}`), `--project=${input.project}`];
}

export function createStateServer({ env = process.env } = {}) {
  const server = new McpServer({ name: "sage", version: "0.1.0" });
  const project = z.string().refine(isAbsolute, "an absolute path").describe("the absolute path of the project's checkout");
  for (const [name, spec] of Object.entries(TOOLS)) {
    server.registerTool(name, {
      description: spec.describe,
      inputSchema: z.object({ project, ...spec.input }).strict(),
      annotations: { readOnlyHint: CHILD_READS.has(name), destructiveHint: false },
    }, async (input) => {
      const { code, text } = tool.command(argvFor(name, input), env);
      return { ...(code ? { isError: true } : {}), content: [{ type: "text", text }] };
    });
  }
  // The brief check (T462): no state-tool command, because the hooks read the record by task name.
  server.registerTool("brief", {
    description: `Check a role agent's brief before you spawn it: it names each missing field of ${BRIEF_FIELDS.join(", ")}, and keeps the brief for the agent's start note. Fix the brief and run it again until no field is missing, then spawn the agent with the same task name and brief.`,
    inputSchema: z.object({ project, task_name: z.string().regex(TASK_NAME, NAME_RULE).describe("the task_name of the spawn"),
      brief: z.string().max(BRIEF_LIMIT).describe("the whole brief, each field at the start of a line") }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async ({ project: folder, task_name: task, brief }) => {
    let missing;
    try { missing = recordBrief(folder, task, brief, env); } catch (error) { return { isError: true, content: [{ type: "text", text: `sage: ${error.message}` }] }; }
    const text = missing.length
      ? `sage: the brief of ${task} has no ${missing.join(", ")}. Every brief has all of ${BRIEF_FIELDS.join(", ")}, each at the start of a line that is not in a list or a code block, with a colon, two spaces or a tab after its name (GOAL: …, GOAL   …), or its name alone on the line. Add them, then run brief again.`
      : `brief ${task} checked: all ${BRIEF_FIELDS.length} fields. Spawn the agent with this task name and this brief.`;
    return { ...(missing.length ? { isError: true } : {}), content: [{ type: "text", text }] };
  });
  return server;
}

let entry;
try { if (process.argv[1]) entry = realpathSync(process.argv[1]); } catch { /* Import only. */ }
if (entry === fileURLToPath(import.meta.url)) serveStdio(() => createStateServer());
