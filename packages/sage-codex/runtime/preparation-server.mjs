import { McpServer, serveStdio, z } from "./mcp-sdk.mjs";

/** Keep visible tools off the hidden hook server so native children start their hooks eagerly. */
export function createPreparationServer(options = {}) {
  const fixed = Object.freeze({ directory: options.directory, project: options.project, observationsRoot: options.observationsRoot, sessionsDir: options.sessionsDir,
    projectDirectory: options.projectDirectory, logbookRoot: options.logbookRoot });
  const server = new McpServer({ name: "sage-preparation", version: "0.1.0" });
  server.registerTool("sage_prepare_task", {
    description: "Save a complete Sage task brief before spawning a named agent. Configured review roles also require reviewCycle and receive a fixed commit target. Preparation does not start the agent or reserve capacity. Copy the returned name, message, and fork_turns unchanged into the later spawn.",
    inputSchema: z.object({ task: z.string(), run: z.string(), name: z.string(), role: z.string(), reviewCycle: z.number().int().min(1).max(10).optional(),
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
