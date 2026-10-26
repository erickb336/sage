import { readFileSync, realpathSync } from "node:fs";
import { renderChiefInstructions } from "../core/index.mjs";
import { readMode, updateOwnerMode } from "./mode.mjs";

import { readSessionIdentity } from "./identity.mjs";
import { nativeOwnerSessionStart } from "./owner.mjs";

const stamp = state => JSON.stringify([state.owner?.epoch, state.modes.at(-1)]);

/** Authenticate the owner and replay the same role context for the activation turn.
 * Mode history is the retry record; no unconfirmed 'delivered' flag is written. */
export function ownerPromptOutput(input, context, options, part = 0) {
  if (!Number.isInteger(part) || part < 0 || part >= PARTS) throw Error("Sage instruction part is unavailable");
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


/** Codex gives an mcp_tool hook no additionalContextLimit, so its default of 2500 tokens applies, and it counts a
 * token as 4 bytes (codex-rs 0.164.0: hooks/src/output_spill.rs, utils/string/src/truncate.rs). Codex cuts a longer
 * part. Two fixed native handlers ask for the two parts. */
export const PART_BYTES = 2_500 * 4;
const PARTS = 2;
const head = (index, count) => `Sage chief instructions: part ${index + 1} of ${count}\n\n`;

/** The bounded parts of the chief text, header included. Preserve every source byte. */
export function chiefInstructionParts(text = renderChiefInstructions(JSON.parse(readFileSync(new URL("../chief-bindings.json", import.meta.url), "utf8")))) {
  if (typeof text !== "string" || !text.trim() || text.includes("\0")) throw Error("Sage chief instructions are unavailable");
  const room = PART_BYTES - Buffer.byteLength(head(0, PARTS));
  const parts = []; let part = "";
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (part && Buffer.byteLength(part + line, "utf8") > room) { parts.push(part); part = ""; }
    part += line;
  }
  if (part) parts.push(part);
  if (parts.length > PARTS || parts.some(body => Buffer.byteLength(body, "utf8") > room) || parts.join("") !== text)
    throw Error(`Sage chief instructions are ${Buffer.byteLength(text, "utf8")} bytes and do not fit in ${PARTS} native hook parts of ${PART_BYTES} bytes: shorten the chief text`);
  return parts.map((body, index) => head(index, parts.length) + body);
}

/** Restore active chief context after the observed native compaction event. Never activate or change mode. */
export function ownerSessionStartOutput(input, context, options, part = 0) {
  if (!Number.isInteger(part) || part < 0 || part >= PARTS) throw Error("Sage instruction part is unavailable");
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
