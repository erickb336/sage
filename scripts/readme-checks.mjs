// The README's limits and the docs' relative links, for `npm run check` (T381). The README is a short front page: a
// line budget, at most 5 What's new items, and a first screen that says what sage is, its status and where to start.
// Every relative link in the README and the docs resolves to a file, and every #anchor to a heading or an id. A local
// check, not a link checker such as lychee: it needs no download and no network, and web links stay unchecked.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { TABLE_END, TABLE_START } from "./dictionary.mjs";

/** The README's budget. Lines count when they hold text, outside the two tables that the build writes. */
export const MAX_LINES = 260;
export const MAX_BYTES = 40_000;
export const MAX_NEWS = 5;
const PRINCIPLES = ["<!-- The principles table comes from", "<!-- The end of the principles table. -->"];

/** The first screen, as the README guide defines it: the first 10 lines that are not blank and not a lone tag. */
export const firstScreen = (text) => text.split("\n").filter((l) => !/^\s*(<\/?(a|picture|p)( [^>]*)?>|<source [^>]*>)?\s*$/.test(l)).slice(0, 10);

/** The lines that count for the budget: not blank, and outside the generated tables. */
export function countedLines(text) {
  let generated = false;
  return text.split("\n").filter((l) => {
    if (l.startsWith(TABLE_START) || l.startsWith(PRINCIPLES[0])) generated = true;
    if (l.startsWith(TABLE_END) || l.startsWith(PRINCIPLES[1])) { generated = false; return false; }
    return !generated && l.trim() !== "";
  }).length;
}

/** The problems of a README's text: its budget, its What's new list and its first screen. */
export function readmeProblems(text) {
  const problems = [];
  const lines = countedLines(text), bytes = Buffer.byteLength(text);
  if (lines > MAX_LINES) problems.push(`README.md: ${lines} lines of text; keep it at ${MAX_LINES} or fewer (the generated tables do not count). Move reference material to a page under docs/`);
  if (bytes > MAX_BYTES) problems.push(`README.md: ${bytes} bytes; keep it at ${MAX_BYTES} or fewer. Move reference material to a page under docs/`);
  const news = /^## What's new\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text)?.[1];
  if (news === undefined) problems.push("README.md: no \"## What's new\" section");
  else {
    const items = news.split("\n").filter((l) => /^[-*] /.test(l)).length;
    if (items > MAX_NEWS) problems.push(`README.md: What's new has ${items} items; keep the last ${MAX_NEWS}, and move the others to CHANGELOG.md`);
    if (!news.includes("](CHANGELOG.md)")) problems.push("README.md: What's new must link to CHANGELOG.md");
  }
  const screen = firstScreen(text).join("\n");
  for (const [need, what] of [[/^\*\*sage is an? [^*]+\.\*\*/m, 'one bold sentence that starts "**sage is a"'], [/\]\(#status\)/, "a link to #status"], [/\]\(#quick-start\)/, "a link to #quick-start"]])
    if (!need.test(screen)) problems.push(`README.md: the first screen (the first 10 lines with text) needs ${what}`);
  return problems;
}

/** A heading's anchor, as GitHub makes it: lower case, punctuation removed, each space a hyphen. */
export const slug = (heading) => heading.trim().toLowerCase().replace(/<[^>]*>/g, "").replace(/[`*_]/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-");

/** The anchors of a Markdown file: each heading's slug (a repeat gets -1, -2, …), and each id or name in a tag. */
export function anchors(text) {
  const seen = new Map(), out = new Set();
  for (const line of withoutCode(text).split("\n")) {
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const base = slug(h[1]), n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      out.add(n ? `${base}-${n}` : base);
    }
    for (const m of line.matchAll(/<a\s[^>]*?(?:id|name)="([^"]+)"/g)) out.add(m[1]);
  }
  return out;
}

/** The text without its fenced code blocks and code spans, which hold no links. Line breaks stay. */
const withoutCode = (text) => text.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm, (m) => m.replace(/[^\n]/g, " ")).replace(/(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g, (m) => " ".repeat(m.length));

/** Each link target of a Markdown file: Markdown links and images, and href, src and srcset in tags. */
export function links(text) {
  const t = withoutCode(text), out = [];
  const line = (i) => t.slice(0, i).split("\n").length;
  for (const m of t.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push({ target: m[1], line: line(m.index) });
  for (const m of t.matchAll(/\s(?:href|src|srcset)="([^"]+)"/g)) out.push({ target: m[1], line: line(m.index) });
  return out;
}

/** The Markdown files whose links the check reads: the root's own pages, the docs and the board's guide. */
export function docFiles(root) {
  const under = (dir) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? under(join(dir, e.name)) : e.name.endsWith(".md") ? [join(dir, e.name)] : []));
  return [...["README.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md", "AGENTS.md"].filter((f) => existsSync(join(root, f))), ...under("docs"), "packages/sage-board/README.md"].filter((f) => existsSync(join(root, f)));
}

/** Each relative link that does not resolve: a missing file, or an #anchor that the target page does not have. */
export function linkProblems(root, files = docFiles(root)) {
  const problems = [], cache = new Map();
  const anchorsOf = (file) => cache.get(file) ?? cache.set(file, anchors(readFileSync(file, "utf8"))).get(file);
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    for (const { target, line } of links(text)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue; // a web link, mailto: and the like
      const [path, anchor] = target.split("#");
      const to = path ? join(root, dirname(file), decodeURIComponent(path)) : join(root, file);
      if (!relative(root, to) || relative(root, to).startsWith("..")) { problems.push(`${file}:${line}: ${target} leaves the repository`); continue; }
      if (!existsSync(to)) { problems.push(`${file}:${line}: ${target} does not exist`); continue; }
      if (anchor && to.endsWith(".md") && statSync(to).isFile() && !anchorsOf(to).has(anchor)) problems.push(`${file}:${line}: ${target} names #${anchor}, which ${relative(root, to)} does not have`);
    }
  }
  return problems;
}
