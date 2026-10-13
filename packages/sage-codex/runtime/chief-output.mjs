import { readFileSync, realpathSync } from "node:fs";
import { renderChiefInstructions } from "sage-core";
import { readMode, updateOwnerMode } from "./mode.mjs";

import { readSessionIdentity } from "./identity.mjs";
import { nativeOwnerSessionStart } from "./owner.mjs";

const stamp = state => JSON.stringify([state.owner?.epoch, state.modes.at(-1)]);

/** Authenticate the owner and replay the same role context for the activation turn.
 * Mode history is the retry record; no unconfirmed 'delivered' flag is written. */
export function ownerPromptOutput(input, context, options, part = 0) {
  if (!Number.isInteger(part) || part < 0 || part > 1) throw Error("Sage instruction part is unavailable");
  const updated = updateOwnerMode(input, context, options);
  if (!updated) throw Error("Sage owner prompt is unavailable");
  if (!updated.sage) return {};
  const current = readMode(options.directory, options.project, updated.session);
  if (!current.sage || !current.owner) throw Error("Sage owner mode changed");
  const lastOff = current.modes.findLastIndex(row => !row.sage);
  const activation = current.modes[lastOff + 1];
  if (!activation || !activation.sage) throw Error("Sage activation is unavailable");
  if (activation.turn !== updated.turn) return {};
  const parts = chiefInstructionParts();
  if (stamp(current) !== stamp(readMode(options.directory, options.project, updated.session))) throw Error("Sage owner mode changed");
  return parts[part] === undefined ? {} : { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: parts[part] } };
}


/** Two fixed native handlers cover these bounded parts. Preserve every source byte. */
export function chiefInstructionParts() {
  const bindings = JSON.parse(readFileSync(new URL("../chief-bindings.json", import.meta.url), "utf8"));
  const text = renderChiefInstructions(bindings);
  if (typeof text !== "string" || !text.trim() || text.includes("\0")) throw Error("Sage chief instructions are unavailable");
  const parts = []; let part = "";
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (Buffer.byteLength(line, "utf8") > 7_500) throw Error("Sage chief instruction line is too long");
    if (part && Buffer.byteLength(part + line, "utf8") > 7_500) { parts.push(part); part = ""; }
    part += line;
  }
  if (part) parts.push(part);
  if (parts.length > 2 || parts.join("") !== text) throw Error("Sage chief instructions exceed the native hook budget");
  return parts.map((body, index) => `Sage chief instructions: part ${index + 1} of ${parts.length}\n\n${body}`);
}

/** Restore active chief context after the observed native compaction event. Never activate or change mode. */
export function ownerSessionStartOutput(input, context, options, part = 0) {
  if (!Number.isInteger(part) || part < 0 || part > 1) throw Error("Sage instruction part is unavailable");
  if (realpathSync(options.projectDirectory) !== options.projectDirectory || input?.cwd !== options.projectDirectory)
    throw Error("Sage owner session is unavailable");
  const metadata = readSessionIdentity(input.transcript_path, { sessionsDir: options.sessionsDir });
  const event = nativeOwnerSessionStart(input, context, metadata);
  if (!event) throw Error("Sage owner session is unavailable");
  if (event.source !== "compact") return {};
  const current = readMode(options.directory, options.project, event.session);
  if (!current.owner || !current.sage) return {};
  const parts = chiefInstructionParts();
  if (stamp(current) !== stamp(readMode(options.directory, options.project, event.session))) throw Error("Sage owner mode changed");
  return parts[part] === undefined ? {} : { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: parts[part] } };
}
