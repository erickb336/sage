import { appendFileSync } from "node:fs";

export function appendSyntheticHistory(file, entries = 181, largestEntry = 0) {
  if (largestEntry) {
    const prefix = '{"type":"response_item","payload":{"type":"function_call_output","output":"';
    const suffix = '"}}';
    appendFileSync(file, prefix + "x".repeat(largestEntry - prefix.length - suffix.length) + suffix + "\n");
  }
  const line = JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "x".repeat(1024 * 1024) } }) + "\n";
  for (let i = 0; i < entries; i++) appendFileSync(file, line);
}
