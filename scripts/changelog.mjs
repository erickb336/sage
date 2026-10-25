// CHANGELOG.md is built from changes/ (T492), so that two pull requests never edit the same lines of one file:
//   changes/<task>.md  (one file per pull request: frontmatter `date: YYYY-MM-DD`, then its list item)
//   changes/earlier.md (the heading, the intro and the entries from before T492, as they were)
//   → CHANGELOG.md     (dates newest first; in a date, the files of changes/ by name, highest task first, then the
//                       entries of changes/earlier.md for that date)
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const CHANGES = "changes";
const EARLIER = "earlier.md";
const BUILT = "<!-- Built by scripts/build.mjs from changes/: write your entry in changes/<task>.md, then run npm run build. -->";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

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

/** CHANGELOG.md from the changes/ folder of a checkout. */
export function changelog(root) {
  const dir = join(root, CHANGES);
  const names = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== EARLIER);
  return assemble(readFileSync(join(dir, EARLIER), "utf8"), Object.fromEntries(names.map((f) => [f, readFileSync(join(dir, f), "utf8")])));
}
