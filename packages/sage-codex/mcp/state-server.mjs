#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, serveStdio, z } from "../runtime/mcp-sdk.mjs";
import { tool } from "../skills/sage/sage.mjs";
import { BRIEF_FIELDS, PRIORITIES, PRIORITY_SCALE } from "sage-core";
import { BRIEF_LIMIT, NAME_RULE, recordBrief } from "../hooks/brief-hook.mjs";
import { callerRefusal, CHILD_READS, NO_GATE, takeProof } from "../hooks/gate-hook.mjs";
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
const version = z.string().regex(/^[0-9a-f]{64}$/).describe("the task's current version");
const chief = id("C", "the id of a chief of this logbook");
const offerId = z.string().describe("the id of the open offer");

/**
 * Each tool: its description, its input fields, and the command words with the positional fields (pos). Every other
 * field is an option of the command, given as --field=value so that a value that starts with -- stays a value.
 */
export const TOOLS = {
  init: { describe: "Make the project's logbook and its standing orders, or check an existing one. Run it once for a new project.", argv: () => ["init"] },
  link: {
    describe: "Only after the owner's answer in the chat: link this checkout to a logbook of the shared root (to), or start a new shared logbook for it (separate). Give one of the two.",
    input: { to: optional("the folder of an existing shared logbook, <project>-<6 hex>"), separate: z.boolean().optional().describe("true to start a new shared logbook") },
    pos: ["separate"], argv: (i) => ["link", ...(i.separate ? ["--separate"] : [])],
  },
  move: {
    describe: "Move this project's Claude and Codex logbooks into one shared logbook, when the owner asks for it. Give one of preview, plan or gate. "
      + "preview reads and changes nothing: show its text to the owner as it is. It refuses while a run runs: start no run, and tell the owner. "
      + "plan, the 8 hex of the preview's plan, opens the move gate: put its text to the owner word for word. Its options are move (or \"move, and record <provider> as unused\" when that provider has no row in plugins.tsv) and keep. "
      + "Record the owner's answer with gate_answer. Call gate, the move gate's id, only after the owner's answer in the chat: it moves, and prints the end check, the map, the backups and the restore steps. "
      + "When the logbooks changed after the preview, the plan does not match and nothing moves: show a new preview, then open a new gate. "
      + "While a move's plan is saved, every tool of the project refuses and names the gate: call move with that gate at once, from any checkout of the project, to finish it.",
    input: { preview: z.literal(true).optional().describe("true: the preview"),
      plan: z.string().regex(/^[0-9a-f]{8}$/, "the 8 hex of the preview's plan, for example 7c41e09a").optional().describe("the 8 hex of the preview's plan"),
      gate: id("G", "the move gate's id").optional() },
    pos: ["preview"], argv: (i) => ["move", ...(i.preview ? ["--preview"] : [])],
  },
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
    describe: "Change a task: its state, branch, pr, priority, kind, waits or program. Resuming a round hold needs approval=<G>, an unused owner-approved repair gate for this task and round limit. The tool refuses a move that the route does not allow. Any chief may abandon a task with no owning chief: fields {\"state\": \"abandoned\"} alone, with why.",
    input: { task, fields: z.record(z.string().regex(/^[a-z]+$/), z.string()).describe('the keys and values to set, for example {"state": "building", "branch": "codex/t7-name"}'),
      why: optional("the reason of an abandon, only with the state abandoned; needed to abandon a task with no owning chief") },
    pos: ["task", "fields"],
    argv: (i) => ["task", i.task, "set", ...Object.entries(i.fields).map(([k, v]) => `${k}=${v}`)],
  },
  task_adopt: {
    describe: "Adopt another provider's task and PR from a separate logbook into an unstarted task of this project. Preserve spent repairs and provenance; require fresh destination reviews and QA. Read the source logbook without changing it. In a shared logbook it refuses and changes nothing: there, take another chief's task only through the owner's takeover gate (gate_replace, or accept for an offer to you).",
    input: { task, "source-logbook": z.string().refine(isAbsolute, "an absolute path"), "source-provider": z.string(), "source-task": task,
      pr: z.string().regex(/^[1-9]\d*$/), branch: z.string() },
    pos: ["task"], argv: i => ["task-adopt", i.task],
  },
  run_add: {
    describe: "Record an agent run of a task before the agent starts. It prints the run id and the model to pass.",
    input: { task, role: z.string().describe("lead, implementer, pe, designer, arena-judge, code-reviewer, security-reviewer, ux-reviewer, qa, investigate or evidence-review"),
      branch: optional("the run's branch"), candidate: count("the arena candidate number"),
      "usage-interface": optional("collaboration-tools, when Codex gives no token count for the run") },
    pos: ["task"], argv: (i) => ["run", "add", i.task],
  },
  run_done: {
    describe: "Record the end of a run. A done review, QA or evidence-review run needs tokens. A run added with usage-interface collaboration-tools has no token count: "
      + "save its report with pages (task, run and text), then end it as done with usage unavailable, usage-source, usage-evidence, the path that pages printed as report, and no tokens, for example "
      + '{"project": "/absolute/project", "run": "R40", "status": "done", "usage": "unavailable", "usage-source": "codex collaboration-tools", "usage-evidence": "wait_agent gives no token count", "report": "<the path that pages printed>"}.',
    input: { run: id("R", "the run id"), status: z.enum(["done", "blocked", "question", "failed"]), tokens: count("the run's tokens, a whole number"),
      report: optional("the absolute path of the saved report, as pages printed it; needed with usage unavailable"),
      usage: optional("unavailable, only for a run added with usage-interface collaboration-tools; it needs status done, usage-source, usage-evidence and report, and no tokens"),
      "usage-source": optional("where the usage comes from, for example codex collaboration-tools; needed with usage unavailable"),
      "usage-evidence": optional("the evidence of the usage, for example wait_agent gives no token count; needed with usage unavailable") },
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
    describe: "Close a fixed finding. In a repair round, close each fix key after the repair's commit, before the task moves to reviewing.",
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
  claim: {
    describe: "Take a task with no owning chief in a shared logbook: one that you released, or one that your provider started. The version is the one that the refusal of your last write printed. A task that another chief released last, or that came from the other provider's logbook, needs the owner's takeover gate (gate_replace).",
    input: { task, version }, pos: ["task"], argv: (i) => ["claim", i.task],
  },
  offer: {
    describe: "Offer your task to another chief of a shared logbook. You stay its owning chief until that chief accepts, and active runs go on.",
    input: { task, to: chief }, pos: ["task"], argv: (i) => ["offer", i.task],
  },
  cancel: {
    describe: "Cancel your open offer of a task, or decline an offer that another chief made to you; the task keeps its owning chief. A cancelled offer never becomes valid again.",
    input: { task, offer: offerId }, pos: ["task"], argv: (i) => ["cancel", i.task],
  },
  accept: {
    describe: "Ask for a task that another chief offered to you: it opens a takeover gate, and the task is yours only after the owner's answer approve. No run of the task may be active. The CLI's task command gives the offer's id (in the task's offer cell) and the version; so does the line that the offer printed.",
    input: { task, offer: offerId, version }, pos: ["task"], argv: (i) => ["accept", i.task],
  },
  release: {
    describe: "Give up your task. Only you claim it back; another chief takes it through the owner's takeover gate. The task needs no open offer and no active run. Its work and reports stay.",
    input: { task }, pos: ["task"], argv: (i) => ["release", i.task],
  },
  round: { describe: "Start a repair round on the open findings marked fix, also on low findings only. It names the roles to run again. Past max_rounds it holds the task; while autopilot is on, the chief gives the next round itself with why, up to 5 rounds in all, also from that hold.",
    input: { task, why: optional("the chief's reason for an extra round past max_rounds") }, pos: ["task"], argv: (i) => ["round", i.task] },
  merge_check: {
    describe: "Check that the logbook allows the merge of this head SHA: clean cycles, no open findings, no open gates. It judges for your chief: a task of another chief refuses.",
    input: { sha, pr: count("the pull request number"), cycles: count("a higher count of clean cycles"), head: optional("the pull request's branch") },
    argv: () => ["merge-check"],
  },
  log: {
    describe: "Add a line to the decision trail. Put the id that the decision is about first.",
    input: { task: z.union([task, z.literal("-")]).describe("the task id, or - for none"), decision: word.describe("the decision"), why: z.string().describe("the reason") },
    pos: ["task", "decision"], argv: (i) => ["log", i.task, i.decision],
  },
  worktrees: {
    describe: "List the git worktrees of the project's repository, each with its path, branch, task, task state and reason: merged, abandoned, branch merged, open or unknown. It reads the local origin/main and does not fetch. "
      + "With prune true, after you showed the list, it removes each clean worktree of a merged or abandoned task, or of a branch in origin/main, and prints each path that it removes or keeps with the reason. It keeps the primary checkout, the project's own worktree, a locked one, one that holds another worktree, and one with changes, untracked files or unpushed commits, and it deletes no branch.",
    input: { prune: z.literal(true).optional().describe("true: remove the clean worktrees that may go") },
    pos: ["prune"], argv: (i) => ["worktrees", ...(i.prune ? ["prune", "--yes"] : [])],
  },
  standing: { describe: "Print the standing orders as written. Every agent reads them before it starts; a brief points to them.", argv: () => ["standing"] },
  standing_add: { describe: "Add one standing order.", input: { order: word.describe("the order") }, pos: ["order"], argv: (i) => ["standing", "add", i.order] },
  pages: {
    describe: "Make and print the folder where agents save the task's pages, or record a page there (its path and sha256) in the decision trail. "
      + "With run and text, it saves that run's exact report in the folder and records it. Known retained text must match before the first save. Give the printed path as run_done's report; reuse the printed sha256 for report_compare.",
    input: { task, record: z.string().refine(isAbsolute, "an absolute path").optional().describe("the absolute path of a page in that folder, to record it"),
      run: optional("a run of the task, with text: whose report to save"), text: optional("the run's whole report, with run: the text to save") },
    pos: ["task", "record"], argv: (i) => ["pages", i.task, ...(i.record === undefined ? (i.text === undefined && i.run === undefined ? [] : ["record"]) : ["record", String(i.record)])],
  },
  gate_add: {
    describe: "Park a question for the owner, with options, a recommendation and a default.",
    input: { task, question: z.string(), options: z.string().describe("the options joined by |, for example yes|no"), recommend: z.string().describe("the recommended option"),
      default: optional("the default option") },
    pos: ["task"], argv: (i) => ["gate", "add", i.task],
  },
  gate_replace: {
    describe: "The takeover gate: ask the owner to give a task of another chief, or a task with no owning chief that you may not claim, to a chief (to). The gate names each run that ends as failed. The owner's answer does the takeover, through gate_answer.",
    input: { task, to: chief }, pos: ["task"], argv: (i) => ["gate", "replace", i.task],
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
  // Each tool runs only for a call that sage's gate saw (R1916-2): Codex runs no plugin hook that the user has not
  // trusted, also after each sage update, and then no sage rule holds. The proof names the caller, whose rule the server
  // applies itself: a lead serves only its own task (T552).
  const registerTool = (name, spec, run) => server.registerTool(name, spec, async (input, extra) => {
    const caller = takeProof(extra?.mcpReq?._meta, name, env, input);
    const why = caller ? callerRefusal(caller, name, input, env) : NO_GATE;
    return why ? { isError: true, content: [{ type: "text", text: why }] } : run(input, caller, extra?.mcpReq?._meta?.sessionId);
  });
  const project = z.string().refine(isAbsolute, "an absolute path").describe("the absolute path of the project's checkout");
  for (const [name, spec] of Object.entries(TOOLS)) {
    registerTool(name, {
      description: spec.describe,
      inputSchema: z.object({ project, ...spec.input }).strict(),
      annotations: { readOnlyHint: CHILD_READS.has(name), destructiveHint: false },
    }, async (input, caller, native) => {
      if (name === "pages" && input.record !== undefined && (input.run !== undefined || input.text !== undefined))
        return { isError: true, content: [{ type: "text", text: "sage: pages takes record or inline run and text, not both. Nothing saved." }] };
      // Admission above still owns role/task access. Compare only an inline report, never a caller-selected file.
      // Missing capture keeps the existing page behavior; it still cannot back a verdict without a retained report.
      if (name === "pages" && input.record === undefined && input.run !== undefined && input.text?.trim()
        && Buffer.byteLength(input.text) <= 16 * 1024 * 1024) {
        try {
          const { status } = tool.compareRetainedReport({ project: input.project, task: input.task, run: input.run,
            sha256: createHash("sha256").update(input.text, "utf8").digest("hex") }, env);
          if (status === "mismatch" || status === "damaged") return { isError: true, content: [{ type: "text", text: status === "mismatch"
            ? `sage: ${input.run} text does not match the retained report. Nothing saved. Give the helper's exact report, including Markdown, spaces and newlines.`
            : `sage: ${input.run} retained report is damaged. Nothing saved. Report this limitation; do not replace the retained report.` }] };
        } catch (error) {
          // Let the existing page command explain malformed or foreign run input; it still refuses before a save.
          if (!/^Invalid retained report comparison (?:input|task or run association)\.$/.test(error.message))
            return { isError: true, content: [{ type: "text", text: `sage: ${error.message}` }] };
        }
      }
      // The session id is the root's on the root, a lead and a helper (T554): a shared logbook's chief is the root.
      const { code, text } = tool.command(argvFor(name, input), env, { project: input.project, native, leadTask: caller.role === "lead" ? caller.task : undefined });
      return { ...(code ? { isError: true } : {}), content: [{ type: "text", text }] };
    });
  }
  registerTool("report_compare", {
    description: "Chief only: compare an existing retained role report with the SHA256 of exact UTF-8 text. Returns only match, mismatch, missing or damaged. This observed snapshot grants no review approval or native authenticity.",
    inputSchema: z.object({ project, task, run: id("R", "the run id"), sha256: z.string().regex(/^[0-9a-f]{64}$/).describe("SHA256 of the exact UTF-8 report text, without normalization") }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async input => {
    try { return { content: [{ type: "text", text: JSON.stringify(tool.compareRetainedReport(input, env)) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text", text: `sage: ${error.message}` }] }; }
  });
  // The brief check (T462): no state-tool command, because the hooks read the record by task name.
  registerTool("brief", {
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
