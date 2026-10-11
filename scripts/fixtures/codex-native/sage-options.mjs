import { readFileSync, writeFileSync, existsSync } from "node:fs";
// Copied into a fresh native test profile, never loaded from an installed plugin.
import { patchEditDecision } from "./plugin/runtime/file-policy.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
export const options = { directory: join(root, "admission"), project: "native-fixture",
  projectDirectory: join(root, "workspace"), sessionsDir: join(root, "codex/sessions"),
  observationsRoot: join(root, "observations"), logbookRoot: join(root, "logbook") };

export const disconnectOnSpawn = JSON.parse(readFileSync(join(root, "fixture-fault.json"), "utf8")).disconnectOnSpawn;
export function recordOutage(input) {
  const event = Object.fromEntries(["session_id", "turn_id", "tool_use_id", "tool_name"].map(key => [key, input[key]]));
  writeFileSync(join(root, "hook-outage.json"), JSON.stringify(event), { flag: "wx" });
}

export const outageRecorded = () => existsSync(join(root, "hook-outage.json"));

export function commandDecision(input, context) {
  const deny = JSON.parse(readFileSync(join(root, "fixture-fault.json"), "utf8")).denyCommand === true;
  const result = deny ? { decision: "deny", reason: "sage-fixed-command-denial" } : { decision: "pass" };
  writeFileSync(join(root, "command-policy-receipt.json"), JSON.stringify({ session: input.session_id,
    turn: input.turn_id, call: input.tool_use_id, sage: context.sage, command: context.command, result }), { flag: "wx" });
  return result;
}

export function patchDecision(input, context) {
  const result = patchEditDecision(input, { sage: context.sage, chief: context.actor === input.session_id },
    { cwd: options.projectDirectory, roots: [options.logbookRoot] });
  writeFileSync(join(root, "patch-policy-receipt.json"), JSON.stringify({ session: input.session_id,
    turn: input.turn_id, call: input.tool_use_id, result }), { flag: "wx" });
  return result;
}


export function recordUnmanagedStop(input, context, result) {
  writeFileSync(join(root, "unmanaged-stop-receipt.json"), JSON.stringify({ session: input.session_id,
    child: context.actor, turn: input.turn_id, decision: result.decision }), { flag: "wx" });
}
