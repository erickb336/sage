// Test-only observer: record native compaction events inside this fresh profile.
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
const root = dirname(fileURLToPath(import.meta.url));
const input = JSON.parse(readFileSync(0, "utf8"));
if (!["SessionStart", "PreCompact", "PostCompact"].includes(input.hook_event_name)) throw Error("unexpected_event");
const base = realpathSync(join(root, "codex/sessions")), transcript = realpathSync(input.transcript_path);
const rel = relative(base, transcript);
if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw Error("outside_fresh_session_tree");
writeFileSync(join(root, "compaction-transcript.json"), JSON.stringify({ path: transcript, session: input.session_id }));
writeFileSync(join(root, "events", randomUUID() + ".json"), JSON.stringify({
  hook_event_name: input.hook_event_name, source: input.source, trigger: input.trigger, inputKeys: Object.keys(input).sort(),
}), { flag: "wx" });
