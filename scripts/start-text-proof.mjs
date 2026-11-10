// The proof that T934 lost no rule: each sentence of the old start texts of the Claude chief and lead (the chief's
// agent file, the sage skill and the lead's agent file at a base commit) is in the new start texts or in a reference
// that they name. A sentence that T934 changed on purpose is listed in CHANGED with its new text, which must be there.
//   node scripts/start-text-proof.mjs [<base commit>]     (default: the merge base of origin/main and HEAD, the main
//   that T934's branch last took in; on T934's own start that was 8a38e314)
// It prints the counts, and each sentence that is missing; it exits with 1 when one is missing.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./build.mjs";
import { referenceFiles } from "./start-text.mjs";

const BASE = process.argv[2] ?? execFileSync("git", ["-C", ROOT, "merge-base", "origin/main", "HEAD"], { encoding: "utf8" }).trim();
const OLD = ["plugins/sage/agents/chief-of-staff.md", "plugins/sage/skills/sage/SKILL.md", "plugins/sage/agents/lead.md"];
const NEW = [...OLD, ...referenceFiles().map((f) => `plugins/sage/${f}`)];
/** The sentences that T934 changed on purpose: the old sentence, its new text and the reason. */
const CHANGED = [
  ["After the owner chooses approve, record that answer with `gate_answer`, then call `task_set` with `task: T1` and `fields: {\"state\":\"building\",\"approval\":\"G1\"}`.",
    "After the owner chooses approve, record that answer with `sage gate answer G1 --option 1 --project <folder>`, then run `sage task T1 set state=building approval=G1`.",
    "F4: the state tool's own commands in place of Codex's tool names"],
  ["The CLI form is `task T1 set state=building approval=G1`.", "then run `sage task T1 set state=building approval=G1`.", "F4: the command is now the only form"],
  ["A repeated CLI or `task_set` call after success refuses and adds nothing.", "A repeated `sage task T1 set` call after success refuses and adds nothing.", "F4: no Codex tool name"],
];

/** A text without its frontmatter (the agent's skills list is no rule), as units: lines, table cells and sentences. */
function sentences(text) {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, "");
  return body.split("\n").flatMap((line) => {
    const plain = line.replace(/^\s*(?:#+|[-*]|\d+\.)\s+/, "").trim();
    const cells = /^\|.*\|$/.test(plain) ? plain.slice(1, -1).split(/(?<!\\) \| /) : [plain];
    // A sentence ends at ". " (or "? ", "! ") before a capital letter, a code span, bold text or a quote, outside a code span.
    return cells.flatMap((cell) => {
      const out = [];
      let code = false, start = 0;
      for (let i = 0; i < cell.length; i++) {
        if (cell[i] === "`") code = !code;
        if (!code && /[.?!]/.test(cell[i]) && cell[i + 1] === " " && /[A-Z`*"(]/.test(cell[i + 2] ?? "")) { out.push(cell.slice(start, i + 1)); start = i + 2; }
      }
      out.push(cell.slice(start));
      return out;
    });
  }).map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s && !/^[-|: ]+$/.test(s) && s !== "```" && !/^```\w+$/.test(s));
}
const squash = (s) => s.replace(/\s+/g, " ");

const corpus = squash(NEW.map((f) => sentences(readFileSync(join(ROOT, f), "utf8")).join("\n")).join("\n"));
const changed = new Map(CHANGED.map(([old, now, why]) => [old, { now, why }]));
let total = 0, found = 0;
const missing = [], moved = [];
for (const file of OLD) {
  const old = execFileSync("git", ["-C", ROOT, "show", `${BASE}:${file}`], { encoding: "utf8" });
  for (const sentence of new Set(sentences(old))) {
    total++;
    if (corpus.includes(sentence)) { found++; continue; }
    const change = changed.get(sentence);
    if (change && corpus.includes(squash(change.now))) { moved.push(`${file}: "${sentence}" → "${change.now}" (${change.why})`); continue; }
    missing.push(`${file}: ${sentence}`);
  }
}
console.log(`old start texts at ${BASE}: ${total} sentences; ${found} word for word in the new start texts or the ${NEW.length - OLD.length} references; ${moved.length} changed on purpose; ${missing.length} missing`);
for (const line of moved) console.log(`changed: ${line}`);
for (const line of missing) console.log(`missing: ${line}`);
process.exit(missing.length ? 1 : 0);
