import { McpServer, serveStdio, z } from "./mcp-sdk.mjs";

/** Keep visible tools off the hidden hook server so native children start their hooks eagerly. */
export function createPreparationServer(options = {}) {
  const fixed = Object.freeze({ directory: options.directory, project: options.project, observationsRoot: options.observationsRoot, sessionsDir: options.sessionsDir,
    projectDirectory: options.projectDirectory, logbookRoot: options.logbookRoot });
  const server = new McpServer({ name: "sage-preparation", version: "0.1.0" });
  server.registerTool("sage_create_task", {
    description: "Chief only: create one framed task in the configured logbook. Reuse the same request UUID and identical fields after a lost response. Returns the original creation record on retry; it does not start a run, approve a route, dispatch an agent, or merge. Extra blocks require a reason. Unsupported routes remain unavailable for dispatch.",
    inputSchema: z.object({ request: z.string(), title: z.string(), size: z.string(), risk: z.array(z.string()),
      add: z.array(z.string()), why: z.string() }).strict(),
  }, async (input, context) => {
    const native = { version: server.server.getClientVersion()?.version, actor: context.mcpReq._meta?.threadId };
    try {
      if (Buffer.byteLength(JSON.stringify(input), "utf8") > 16 * 1024) throw Error("Invalid request size");
      const { createNativeTask } = await import("./task-create.mjs");
      return { content: [{ type: "text", text: JSON.stringify(createNativeTask(input, native, fixed)) }] };
    } catch {
      return { isError: true, content: [{ type: "text", text: "Sage could not create this task. Check the chief identity, configured logbook, request UUID, and route. Retry an incomplete request with the same fields." }] };
    }
  });
  server.registerTool("sage_create_run", {
    description: "Chief only: record one run on an existing task. Reuse the same request UUID and identical fields after a lost response. Writers need a branch and cannot share it with another running writer. Use empty strings for an unused branch or candidate. Returns a creation record, not proof of agent execution. Preparation and dispatch still require their own checks.",
    inputSchema: z.object({ request: z.string(), task: z.string(), role: z.string(), branch: z.string(), candidate: z.string() }).strict(),
  }, async (input, context) => {
    const native = { version: server.server.getClientVersion()?.version, actor: context.mcpReq._meta?.threadId };
    try {
      if (Buffer.byteLength(JSON.stringify(input), "utf8") > 16 * 1024) throw Error("Invalid request size");
      const { createNativeRun } = await import("./run-create.mjs");
      return { content: [{ type: "text", text: JSON.stringify(createNativeRun(input, native, fixed)) }] };
    } catch {
      return { isError: true, content: [{ type: "text", text: "Sage could not create this run. Check the chief identity, request UUID, task, role, and branch writer. Retry an incomplete request with the same fields." }] };
    }
  });
  server.registerTool("sage_read_task", {
    description: "Chief only: read a current task and its version for a later update. This does not grant transition or merge permission.",
    inputSchema: z.object({ task: z.string() }).strict(),
  }, async (input, context) => {
    const native = { version: server.server.getClientVersion()?.version, actor: context.mcpReq._meta?.threadId };
    try {
      const { readNativeTask } = await import("./task-update.mjs");
      return { content: [{ type: "text", text: JSON.stringify(readNativeTask(input, native, fixed)) }] };
    } catch {
      return { isError: true, content: [{ type: "text", text: "Sage could not read this task. Check the chief identity, task ID, and configured logbook." }] };
    }
  });
  server.registerTool("sage_update_task", {
    description: "Chief only: update a task using its last read version and a fresh request UUID. Repeat identical fields after a lost response. Shared state and PR-history rules apply; verified and pr-ready need configured clean cycles on the current branch commit. Unanswered gates block forward progress. A retry returns its original update, not current status. This tool cannot mark a task merged or start a repair round.",
    inputSchema: z.object({ request: z.string(), task: z.string(), version: z.string(), changes: z.object({
      title: z.string().optional(), branch: z.string().optional(), pr: z.string().optional(), state: z.string().optional() }).strict() }).strict(),
  }, async (input, context) => {
    const native = { version: server.server.getClientVersion()?.version, actor: context.mcpReq._meta?.threadId };
    try {
      if (Buffer.byteLength(JSON.stringify(input), "utf8") > 20 * 1024) throw Error("Invalid request size");
      const { updateNativeTask } = await import("./task-update.mjs");
      return { content: [{ type: "text", text: JSON.stringify(updateNativeTask(input, native, fixed)) }] };
    } catch {
      return { isError: true, content: [{ type: "text", text: "Sage could not update this task. Check the current version, state route, unanswered gates, findings, and current-commit reviews. Retry an incomplete request with identical fields." }] };
    }
  });
  server.registerTool("sage_prepare_task", {
    description: "Save a complete Sage task brief before spawning a named agent. Configured review roles also require reviewCycle and receive a fixed commit target. Preparation does not start the agent or reserve capacity. For an initial spawn, copy the returned name, message, and fork_turns unchanged. For a completed child, provide its previous assignment ID and a new run and logical name; copy the returned target and message into followup_task. Later-turn binding remains required before work can continue.",
    inputSchema: z.object({ task: z.string(), run: z.string(), name: z.string(), role: z.string(), previous: z.string().optional(), reviewCycle: z.number().int().min(1).max(10).optional(),
      brief: z.object({ GOAL: z.string(), SCOPE: z.string(), CONTEXT: z.string(), DECISIONS: z.string(),
        ACCEPTANCE: z.string(), VERIFY: z.string(), BUDGET: z.string(), FORBIDDEN: z.string(), REPORT: z.string(), STANDING: z.string() }).strict() }).strict(),
  }, async (input, context) => {
    const native = { version: server.server.getClientVersion()?.version, actor: context.mcpReq._meta?.threadId };
    try {
      if (Buffer.byteLength(JSON.stringify(input), "utf8") > 64 * 1024) throw Error("Invalid request size");
      const { prepareNativeTask } = await import("./preparation.mjs");
      const output = prepareNativeTask(input, native, fixed);
      return { content: [{ type: "text", text: JSON.stringify(output) }] };
    } catch {
      return { isError: true, content: [{ type: "text", text: "Sage could not prepare this task. Check the active role, task brief, and unique agent name." }] };
    }
  });
  server.registerTool("sage_read_assignment", {
    description: "Read your own active Sage assignment, including the exact saved role, brief, and review target. No arguments. This read changes no state and grants no permission to act, complete, or merge. A completed or changed assignment is refused.",
    inputSchema: z.object({}).strict(),
  }, async (input, context) => {
    const native = { version: server.server.getClientVersion()?.version, actor: context.mcpReq._meta?.threadId };
    try {
      const { readNativeChildAssignment } = await import("./child-assignment.mjs");
      return { content: [{ type: "text", text: JSON.stringify(readNativeChildAssignment(input, native, fixed)) }] };
    } catch {
      return { isError: true, content: [{ type: "text", text: "Sage could not read your current assignment. Check the active child identity, saved delivery, and current task and run." }] };
    }
  });
  server.registerTool("sage_read_report", {
    description: "Read the validated final report for your completed named child. This does not mark a task successful or record a review verdict.",
    inputSchema: z.object({ name: z.string() }).strict(),
  }, async (input, context) => {
    const native = { version: server.server.getClientVersion()?.version, actor: context.mcpReq._meta?.threadId };
    try {
      const { readChildReport } = await import("./report-intake.mjs");
      return { content: [{ type: "text", text: JSON.stringify(readChildReport(input, native, fixed)) }] };
    } catch {
      return { isError: true, content: [{ type: "text", text: "Sage could not read this report. Check the child name, completed assignment, and report fields." }] };
    }
  });
  server.registerTool("sage_record_report", {
    description: "Save your completed child's validated report using the exact hash returned by sage_read_report. Retries preserve one receipt. This records evidence, not task success or a review verdict.",
    inputSchema: z.object({ name: z.string(), reportHash: z.string() }).strict(),
  }, async (input, context) => {
    const native = { version: server.server.getClientVersion()?.version, actor: context.mcpReq._meta?.threadId };
    try {
      const { recordChildReport } = await import("./report-intake.mjs");
      return { content: [{ type: "text", text: JSON.stringify(recordChildReport(input, native, fixed)) }] };
    } catch {
      return { isError: true, content: [{ type: "text", text: "Sage could not record this report. Check the child name, completed assignment, and exact report hash." }] };
    }
  });
  server.registerTool("sage_read_recorded_report", {
    description: "Chief only: inspect an already recorded team report by its assignment ID and exact hash, including a lead's child. Returns saved text, provenance, and an optional pinned review target. This changes no state and accepts no claims.",
    inputSchema: z.object({ assignment: z.string(), reportHash: z.string() }).strict(),
  }, async (input, context) => {
    const native = { version: server.server.getClientVersion()?.version, actor: context.mcpReq._meta?.threadId };
    try {
      const { readRecordedReport } = await import("./recorded-report.mjs");
      return { content: [{ type: "text", text: JSON.stringify(readRecordedReport(input, native, fixed)) }] };
    } catch {
      return { isError: true, content: [{ type: "text", text: "Sage could not read this saved report. Check the chief identity, recorded assignment, exact hash, and recovery proof." }] };
    }
  });
  server.registerTool("sage_finish_run", {
    description: "Chief only: finish the assigned logbook run from an already recorded report and its exact hash. Retries preserve the first result. This does not accept a review verdict or change task state.",
    inputSchema: z.object({ assignment: z.string(), reportHash: z.string() }).strict(),
  }, async (input, context) => {
    const native = { version: server.server.getClientVersion()?.version, actor: context.mcpReq._meta?.threadId };
    try {
      const { finishRecordedRun } = await import("./run-report.mjs");
      return { content: [{ type: "text", text: JSON.stringify(finishRecordedRun(input, native, fixed)) }] };
    } catch {
      return { isError: true, content: [{ type: "text", text: "Sage could not finish this run. Check the chief identity, saved report, assigned run, and configured logbook." }] };
    }
  });
  server.registerTool("sage_accept_review", {
    description: "Chief only: accept a finished review's recorded report and exact hash against its saved commit, round, and cycle. Record its findings and verdict. Failed partial writes block logbook changes and merges until this request recovers them. This does not merge or mark a task verified.",
    inputSchema: z.object({ assignment: z.string(), reportHash: z.string() }).strict(),
  }, async (input, context) => {
    const native = { version: server.server.getClientVersion()?.version, actor: context.mcpReq._meta?.threadId };
    try {
      const { acceptRecordedReview } = await import("./run-report.mjs");
      return { content: [{ type: "text", text: JSON.stringify(acceptRecordedReview(input, native, fixed)) }] };
    } catch {
      return { isError: true, content: [{ type: "text", text: "Sage could not accept this review. Check the chief identity, completed run, report fields, and current commit. Retry the same request if a saved update is incomplete." }] };
    }
  });
  return server;
}

export function servePreparations(options) {
  return serveStdio(() => createPreparationServer(options));
}
