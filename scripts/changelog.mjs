// CHANGELOG.md is built from changes/ (T492), so that two pull requests never edit the same lines of one file:
//   changes/<task>.md  (one file per pull request: frontmatter `date: YYYY-MM-DD`, then its list item)
//   changes/earlier.md (the heading, the intro and the entries from before T492, as they were)
//   → CHANGELOG.md     (dates newest first; in a date, the files of changes/ by name, highest task first, then the
//                       entries of changes/earlier.md for that date)
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const CHANGES = "changes";
const EARLIER = "earlier.md";
const BUILT = "<!-- Built by scripts/build.mjs from changes/: write your entry in changes/<task>.md, then run npm run build. -->";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MARKER = "<!-- Lines of the last build (a digest of each line): ";
const MARKER_READ = /^<!-- Lines of the last build \([^)]*\): (.*) -->$/; // also the earlier wording, "of each list line"
const CONFLICT = /^(?:<{7}|={7}|>{7}|\|{7})(?: |$)/;
const digest = (line) => createHash("sha1").update(line.trimEnd()).digest("hex").slice(0, 10);
/** The lines that carry text: not blank, not a conflict marker, not the digest line. */
const textLines = (text) => text.split("\n").filter((l) => l.trim() && !CONFLICT.test(l) && !MARKER_READ.test(l));

/** The dated sections of a change log text: the text before the first date, and each date with its entries. */
function sections(text) {
  const [head, ...rest] = text.split(/^## (\d{4}-\d{2}-\d{2})\n/m);
  const dated = [];
  for (let i = 0; i < rest.length; i += 2) dated.push({ date: rest[i], body: rest[i + 1].trim() });
  return { head: head.trim(), dated };
}

/** One fragment: its date and its list item. A fragment that the build cannot place stops the build. */
function fragment(name, text) {
  const m = /^---\ndate: (.*)\n---\n([\s\S]*)$/.exec(text);
  if (!m || !DATE.test(m[1].trim())) throw new Error(`${CHANGES}/${name}: start it with the lines ---, date: YYYY-MM-DD and ---`);
  const body = m[2].trim();
  if (!body.startsWith("- ") || /^#/m.test(body)) throw new Error(`${CHANGES}/${name}: write one list item that starts with "- ", and no heading`);
  return { name, date: m[1].trim(), body };
}

/** CHANGELOG.md from the text of changes/earlier.md and the other files of changes/ ({ "T492.md": text }). */
export function assemble(earlier, files) {
  const { head, dated } = sections(earlier);
  const byDate = new Map();
  const add = (date, body) => byDate.set(date, [...(byDate.get(date) ?? []), body]);
  const fragments = Object.entries(files).map(([name, text]) => fragment(name, text));
  fragments.sort((a, b) => b.name.localeCompare(a.name, "en", { numeric: true }));
  for (const f of fragments) add(f.date, f.body);
  for (const s of dated) add(s.date, s.body);
  const dates = [...byDate.keys()].sort().reverse();
  return `${BUILT}\n\n${head}\n\n${dates.map((d) => `## ${d}\n\n${byDate.get(d).join("\n")}`).join("\n\n")}\n`;
}

/**
 * CHANGELOG.md from the changes/ folder of a checkout. Nothing is dropped without a line that says so (R1771):
 * a file of changes/ that is not a .md file stops the build, and so does any line of text in the present CHANGELOG.md
 * that the build would not write, whatever its form (a list item, a paragraph, a wrapped line, an edit of the intro).
 * The build writes nothing when this throws.
 */
export function changelog(root) {
  const dir = join(root, CHANGES);
  const all = readdirSync(dir);
  // A dot file (a Finder .DS_Store, an editor swap file) is not a change log file, and the build does not stop for it.
  // A name that ends in .md is always read, also when it starts with a dot, so no entry is skipped by its name.
  const odd = all.filter((f) => !f.endsWith(".md") && !f.startsWith("."));
  if (odd.length) throw new Error(odd.map((f) => `${CHANGES}/${f}: the build reads only .md files, so it would drop this file; rename it to ${CHANGES}/<task>.md (for example ${CHANGES}/T500.md)`).join("\n"));
  const names = all.filter((f) => f.endsWith(".md") && f !== EARLIER);
  const built = assemble(readFileSync(join(dir, EARLIER), "utf8"), Object.fromEntries(names.map((f) => [f, readFileSync(join(dir, f), "utf8")])));
  const file = join(root, "CHANGELOG.md");
  const lines = textLines(built).map(digest);
  if (existsSync(file)) {
    // A line is not by hand when this build makes it, or when the last build made it (the file ends with the digests of that
    // build): so an edited fragment, whose old lines are still in the file, is only out of date, and the build replaces it.
    const text = readFileSync(file, "utf8");
    const made = new Set([...lines, ...text.split("\n").flatMap((l) => (MARKER_READ.exec(l)?.[1] ?? "").split(" "))]);
    const byHand = textLines(text).filter((l) => !made.has(digest(l)));
    if (byHand.length) throw new Error(byHand.map((l) => `CHANGELOG.md has a line that no file of ${CHANGES}/ makes, so the build would drop it: "${l.trim().length > 70 ? `${l.trim().slice(0, 70)}...` : l.trim()}". Move it into ${CHANGES}/<task>.md with its date (or into ${CHANGES}/${EARLIER} if it is an older entry or the intro), then run npm run build.`).join("\n"));
  }
  return `${built}${MARKER}${lines.join(" ")} -->\n`;
}
