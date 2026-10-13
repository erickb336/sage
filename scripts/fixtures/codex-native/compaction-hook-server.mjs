// Test-only launcher. Configuration belongs to the isolated profile, never model input.
import { readFileSync } from "node:fs";
import { serveHooks } from "./plugin/runtime/mcp-server.mjs";
const mode = JSON.parse(readFileSync(new URL("./compaction-mode.json", import.meta.url), "utf8"));
serveHooks({ mode });
