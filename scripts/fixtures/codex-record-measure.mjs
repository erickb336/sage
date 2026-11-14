import { readRecord, callInRecord } from "../../plugins/sage-codex/hooks/owner-record.mjs";
const start = performance.now();
const record = readRecord(process.argv[2]);
if (record.refused || !callInRecord(record, "last", 0)) throw new Error(record.refused ?? "missing final call");
console.log(JSON.stringify({ elapsedMs: performance.now() - start, peakRssKiB: process.resourceUsage().maxRSS, lines: record.lines }));
