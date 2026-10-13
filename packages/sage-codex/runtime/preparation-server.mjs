import { McpServer, serveStdio, z } from "./mcp-sdk.mjs";

/** Keep visible tools off the hidden hook server so native children start their hooks eagerly. */
export function createPreparationServer(options = {}) {
  const fixed = Object.freeze({ directory: options.directory, project: options.project, observationsRoot: options.observationsRoot, sessionsDir: options.sessionsDir });
  const server = new McpServer({ name: "sage-preparation", version: "0.1.0" });
  server.registerTool("sage_prepare_task", {
    description: "Save a complete Sage task brief before spawning a named agent. Preparation does not start the agent or reserve capacity. Pass the returned name, exact message and fork_turns to the later spawn.",
    inputSchema: z.object({ task: z.string(), run: z.string(), name: z.string(), role: z.string(),
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
  return server;
}

export function servePreparations(options) {
  return serveStdio(() => createPreparationServer(options));
}
