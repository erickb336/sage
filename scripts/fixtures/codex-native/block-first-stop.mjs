// Test only: block one native stop inside this disposable profile. No process signals or model text execution.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const input = JSON.parse(readFileSync(0, "utf8"));
if (input.hook_event_name !== "SubagentStop" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(input.agent_id)) throw Error("Invalid fixture stop");
try {
  writeFileSync(join(dirname(fileURLToPath(import.meta.url)), `blocked-${input.agent_id}.json`), JSON.stringify({ turn: input.turn_id }), { flag: "wx", mode: 0o600 });
  process.stdout.write(JSON.stringify({ decision: "block", reason: "Fixed fixture: return the same report once more." }));
} catch (error) { if (error.code !== "EEXIST") throw error; }
