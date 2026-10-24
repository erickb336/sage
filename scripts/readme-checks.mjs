// The README's limits and the docs' links, for `npm run check` (T381). The README is a short front page: a line
// budget, at most 5 What's new items, and a first screen that says what sage is, its status and where to start.
// Every relative link in the README and the docs resolves to a file, and every #anchor to a heading or an id; so does
// each link to this repository's main branch on GitHub. A local check, not a link checker such as lychee: it needs no
// download and no network, and other web links stay unchecked.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/** The README's budget: every line of the raw file counts, also a blank one. */
export const MAX_LINES = 150;
export const MAX_BYTES = 15_000;
export const MAX_NEWS = 5;
/** A link to a file on this repository's main branch, which the check reads as a path from the root. */
const GITHUB = /^https:\/\/github\.com\/erickb336\/sage\/blob\/main\//;

/** The first screen, as the README guide defines it: the first 10 lines that are not blank and not a lone tag. */
export const firstScreen = (text) => text.split("\n").filter((l) => !/^\s*(<\/?(a|picture|p)( [^>]*)?>|<source [^>]*>)?\s*$/.test(l)).slice(0, 10);

/** The problems of a README's text: its budget, its What's new list and its first screen. */
export function readmeProblems(text) {
  const problems = [];
  const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0), bytes = Buffer.byteLength(text);
  if (lines > MAX_LINES) problems.push(`README.md: ${lines} lines; keep it at ${MAX_LINES} or fewer. Move reference material to a page under docs/`);
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

/** A heading's anchor, as GitHub makes it: lower case, punctuation removed (an underscore stays), each space a hyphen. */
export const slug = (heading) => heading.trim().toLowerCase().replace(/<[^>]*>/g, "").replace(/[`*]/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");

/** The anchors of a Markdown file: each heading's slug, and each id or name in a tag. As GitHub does (github-slugger),
 * a slug that is taken gets the next free -1, -2, … of its base, so "A", "A", "A-1" give a, a-1, a-1-1. */
export function anchors(text) {
  const count = new Map(), out = new Set();
  for (const line of withoutCode(text).split("\n")) {
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const base = slug(h[1]);
      let anchor = base;
      while (count.has(anchor)) { count.set(base, count.get(base) + 1); anchor = `${base}-${count.get(base)}`; }
      count.set(anchor, 0);
      out.add(anchor);
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
  for (const m of t.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push({ target: m[1], at: m.index });
  for (const m of t.matchAll(/\s(?:href|src|srcset)="([^"]+)"/g)) out.push({ target: m[1], at: m.index });
  // In the order of the text, so that the problems come in the order in which a reader meets them.
  return out.sort((a, b) => a.at - b.at).map(({ target, at }) => ({ target, line: line(at) }));
}

/** The Markdown files whose links the check reads: the root's own pages, the docs, the board's guide, and the help
 * skill, which links the docs on GitHub. */
export function docFiles(root) {
  const under = (dir) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? under(join(dir, e.name)) : e.name.endsWith(".md") ? [join(dir, e.name)] : []));
  return [...["README.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md", "AGENTS.md"].filter((f) => existsSync(join(root, f))), ...under("docs"), "packages/sage-board/README.md", "packages/sage-claude/skills/sage-help/SKILL.md"].filter((f) => existsSync(join(root, f)));
}

/** Each relative link that does not resolve: a missing file, or an #anchor that the target page does not have. */
export function linkProblems(root, files = docFiles(root)) {
  const problems = [], cache = new Map();
  const anchorsOf = (file) => cache.get(file) ?? cache.set(file, anchors(readFileSync(file, "utf8"))).get(file);
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    for (const link of links(text)) {
      const { line } = link, onMain = GITHUB.test(link.target);
      const target = onMain ? link.target.replace(GITHUB, "/") : link.target;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue; // a web link, mailto: and the like
      const [path, anchor] = target.split("#");
      let decoded;
      try { decoded = decodeURIComponent(path); } catch { problems.push(`${file}:${line}: ${link.target} has a bad % escape`); continue; }
      const to = path ? join(root, path.startsWith("/") ? "" : dirname(file), decoded) : join(root, file);
      if (!relative(root, to) || relative(root, to).startsWith("..")) { problems.push(`${file}:${line}: ${target} leaves the repository`); continue; }
      if (!existsSync(to)) { problems.push(`${file}:${line}: ${link.target} does not exist`); continue; }
      if (anchor && to.endsWith(".md") && statSync(to).isFile() && !anchorsOf(to).has(anchor)) problems.push(`${file}:${line}: ${link.target} names #${anchor}, which ${relative(root, to)} does not have`);
    }
  }
  return problems;
}
