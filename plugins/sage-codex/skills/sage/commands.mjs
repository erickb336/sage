#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { exactPhrase, parseBoardIntent, phrasesNear } from "../../core/index.mjs";

// Classification only. The caller verifies the direct owner message and available capabilities.
export function parseCommand(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== 1 || !Object.hasOwn(input, "text")
    || typeof input.text !== "string") throw new TypeError('Expected exactly {"text": string}');
  const phrase = exactPhrase(input.text);
  if (phrase) return { kind: "phrase", phrase };
  const board = parseBoardIntent(input.text);
  if (board) return board;
  const near = phrasesNear(input.text);
  return near ? { kind: "near", ...near } : { kind: "none" };
}

let entryPath;
try {
  if (process.argv[1]) entryPath = realpathSync(process.argv[1]);
} catch {
  // Imports from stdin or virtual entry points have no filesystem entry path.
}
if (entryPath === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(parseCommand(JSON.parse(readFileSync(0, "utf8"))))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
