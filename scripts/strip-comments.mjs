import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SCAN_FOLDERS, commentScan } from "./lint-rules.mjs";

const MARK = "\u0000";

export function stripRanges(text, byteRanges, { yaml = false } = {}) {
  if (text.includes(MARK)) throw new Error("the file holds a NUL character, which the strip uses as its mark");
  const bytes = Buffer.from(text);
  let marked = "", at = 0, atByte = 0;
  for (const [startByte, endByte] of [...byteRanges].sort((a, b) => a[0] - b[0])) {
    const start = at + bytes.subarray(atByte, startByte).toString().length;
    const end = start + bytes.subarray(startByte, endByte).toString().length;
    const lineBefore = text.slice(text.lastIndexOf("\n", start - 1) + 1, start);
    const lineAfter = text.slice(end, (text.indexOf("\n", end) + 1 || text.length + 1) - 1);
    const keepsLineBreak = text.slice(start, end).includes("\n") && lineBefore.trim() && lineAfter.trim();
    marked += text.slice(at, start) + (keepsLineBreak ? `${MARK}\n${MARK}` : MARK);
    at = end;
    atByte = endByte;
  }
  marked += text.slice(at);
  const lines = [];
  let dropped = false;
  for (const line of marked.split("\n")) {
    if (!line.includes(MARK)) {
      if (dropped && !line.trim() && (yaml || !lines.length || !lines.at(-1).trim() || /^#!/.test(lines.at(-1)) && lines.length === 1)) { dropped = yaml; continue; }
      dropped = false;
      lines.push(line);
      continue;
    }
    const tidy = tidyLine(line);
    if (tidy.trim()) { lines.push(tidy); dropped = false; } else dropped = true;
  }
  return lines.join("\n");
}

function tidyLine(line) {
  let out = line;
  for (let i = out.indexOf(MARK); i >= 0; i = out.indexOf(MARK)) {
    const left = out.slice(0, i), right = out.slice(i + 1);
    const head = left.trimEnd(), tail = right.trimStart();
    if (!head) out = left + tail;
    else if (!tail || /[([]$/.test(head) || /^[;,)\]}]/.test(tail)) out = head + tail;
    else out = head + (left.slice(head.length) || " ") + tail;
  }
  return out;
}

export function stripComments(root, paths = SCAN_FOLDERS) {
  const byFile = new Map();
  for (const m of commentScan(root, paths)) byFile.set(m.file, [...byFile.get(m.file) ?? [], [m.range.byteOffset.start, m.range.byteOffset.end]]);
  for (const [file, ranges] of byFile) {
    const path = join(root, file);
    writeFileSync(path, stripRanges(readFileSync(path, "utf8"), ranges, { yaml: /\.ya?ml$/.test(file) }));
  }
  return { files: byFile.size, comments: [...byFile.values()].reduce((n, r) => n + r.length, 0) };
}

const USAGE = `usage: node scripts/strip-comments.mjs [path ...]
Removes each comment that the rule set in packages/sage-core/lint flags, in the paths (default: ${SCAN_FOLDERS.join(" ")}).`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const paths = process.argv.slice(2), option = paths.find((arg) => arg.startsWith("-"));
  if (option) {
    if (option === "--help" || option === "-h") console.log(USAGE);
    else console.error(`strip-comments: unknown option ${option}\n${USAGE}`);
    process.exit(option === "--help" || option === "-h" ? 0 : 2);
  }
  const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim() || process.cwd();
  try {
    const { files, comments } = stripComments(root, paths.length ? paths : SCAN_FOLDERS);
    console.log(`removed ${comments} comments from ${files} files in ${root}`);
  } catch (error) {
    console.error(`strip-comments: ${error.message.split("\n")[0]}`);
    process.exitCode = 1;
  }
}
