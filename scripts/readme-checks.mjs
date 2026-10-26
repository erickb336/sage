// The README's limits and the docs' links, for `npm run check` (T381). The README is a short front page: a line
// budget, a link to the changelog (T465: the changelog alone lists the changes), and a first screen that says what sage
// is, its status and where to start.
// Every relative link in the README and the docs resolves to a file, and every #anchor to a heading or an id; so does
// each link to this repository's main branch on GitHub. A local check, not a link checker such as lychee: it needs no
// download and no network, and other web links stay unchecked.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/** The README's budget: every line of the raw file counts, also a blank one. */
export const MAX_LINES = 150;
export const MAX_BYTES = 15_000;
/** A link to a file or a folder on this repository's main branch, which the check reads as a path from the root. */
const GITHUB = /^https:\/\/github\.com\/erickb336\/sage\/(?:blob|tree)\/main(?:\/|(?=[?#]|$))/;

/** The first screen, as the README guide defines it: the first 10 lines that are not blank and not a lone tag. */
export const firstScreen = (text) => text.split("\n").filter((l) => !/^\s*(<\/?(a|picture|p)( [^>]*)?>|<source [^>]*>)?\s*$/.test(l)).slice(0, 10);

/** The problems of a README's text: its budget, its link to the changelog and its first screen. */
export function readmeProblems(text) {
  const problems = [];
  const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0), bytes = Buffer.byteLength(text);
  if (lines > MAX_LINES) problems.push(`README.md: ${lines} lines; keep it at ${MAX_LINES} or fewer. Move reference material to a page under docs/`);
  if (bytes > MAX_BYTES) problems.push(`README.md: ${bytes} bytes; keep it at ${MAX_BYTES} or fewer. Move reference material to a page under docs/`);
  if (!text.includes("](CHANGELOG.md)")) problems.push("README.md: no link to CHANGELOG.md; the changelog holds the list of changes");
  const screen = firstScreen(text).join("\n");
  for (const [need, what] of [[/^\*\*sage is an? [^*]+\.\*\*/m, 'one bold sentence that starts "**sage is a"'], [/^\*\*Status:\*\* /m, 'a status line that starts "**Status:**"'], [/\]\(#quick-start\)/, "a link to #quick-start"]])
    if (!need.test(screen)) problems.push(`README.md: the first screen (the first 10 lines with text) needs ${what}`);
  return problems;
}

/** A pair of "_" or "__" that makes emphasis: it opens at the start of a word and closes at the end of a word. An "_"
 * inside a word (max_agents) or without its pair (_private) is text, and GitHub keeps it. */
const EMPHASIS = /(^|[^\p{L}\p{N}_])(_{1,2})(?!\s)(.+?)(?<!\s)\2(?![\p{L}\p{N}_])/gu;
/** A part of a heading: a code span keeps its text as it is; other text loses its emphasis marks. */
const plain = (part, i) => (i % 2 ? part.slice(1, -1) : part.replace(/\*/g, "").replace(EMPHASIS, "$1$3"));
/** A heading's anchor, as GitHub makes it from the heading's text: lower case, no emphasis marks, punctuation removed (an
 * underscore in a word or in code stays), each space a hyphen. */
export const slug = (heading) => heading.trim().toLowerCase().replace(/<[^>]*>/g, "").split(/(`[^`]*`)/).map(plain).join("").replace(/`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");

/** The anchors of a Markdown file: each heading's slug, and each id or name in a tag. As GitHub does (github-slugger),
 * a slug that is taken gets the next free -1, -2, … of its base, so "A", "A", "A-1" give a, a-1, a-1-1. */
export function anchors(text) {
  const count = new Map(), out = new Set();
  for (const line of withoutFences(text).split("\n")) {
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line); // with its code spans: their text is part of the anchor
    if (h) {
      const base = slug(h[1]);
      let anchor = base;
      while (count.has(anchor)) { count.set(base, count.get(base) + 1); anchor = `${base}-${count.get(base)}`; }
      count.set(anchor, 0);
      out.add(anchor);
    }
    for (const m of withoutSpans(line).matchAll(/<a\s[^>]*?(?:id|name)="([^"]+)"/g)) out.add(m[1]);
  }
  return out;
}

/** The text without its fenced code blocks, or without its code spans. Line breaks stay. */
const withoutFences = (text) => text.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm, (m) => m.replace(/[^\n]/g, " "));
const withoutSpans = (text) => text.replace(/(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g, (m) => " ".repeat(m.length));
/** The text without its code, which holds no links. */
const withoutCode = (text) => withoutSpans(withoutFences(text));

/** Each link target of a Markdown file: Markdown links and images, the definition of each reference link ([x]: path),
 * and href, src and srcset in tags. */
export function links(text) {
  const t = withoutCode(text), out = [];
  const line = (i) => t.slice(0, i).split("\n").length;
  for (const m of t.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push({ target: m[1], at: m.index });
  for (const m of t.matchAll(/^ {0,3}\[[^\]^][^\]]*\]:[ \t]*<?([^\s>]+)/gm)) out.push({ target: m[1], at: m.index });
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
export function linkProblems(root, files = docFiles(root), read = (file) => readFileSync(join(root, file), "utf8")) {
  const problems = [], cache = new Map();
  const anchorsOf = (file) => cache.get(file) ?? cache.set(file, anchors(readFileSync(file, "utf8"))).get(file);
  for (const file of files) {
    const text = read(file);
    for (const link of links(text)) {
      const { line } = link, onMain = GITHUB.test(link.target);
      const target = onMain ? link.target.replace(GITHUB, "/") : link.target;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue; // a web link, mailto: and the like
      // GitHub finds the file without the query (?plain=1); with ?plain=1, an anchor names a line (#L12), not a heading.
      const [address, anchor] = target.split("#"), [path, query = ""] = address.split("?");
      let decoded;
      try { decoded = decodeURIComponent(path); } catch { problems.push(`${file}:${line}: ${link.target} has a bad % escape`); continue; }
      const to = path ? join(root, path.startsWith("/") ? "" : dirname(file), decoded) : join(root, file);
      if (/^\.\.(\/|$)/.test(relative(root, to))) { problems.push(`${file}:${line}: ${target} leaves the repository`); continue; }
      if (!existsSync(to)) { problems.push(`${file}:${line}: ${link.target} does not exist`); continue; }
      if (anchor && !/(^|&)plain=1(&|$)/.test(query) && to.endsWith(".md") && statSync(to).isFile() && !anchorsOf(to).has(anchor)) problems.push(`${file}:${line}: ${link.target} names #${anchor}, which ${relative(root, to)} does not have`);
    }
  }
  return problems;
}

/** The most sentences in one paragraph, list item or table cell of the README and the guide, so that a reader can take
 * in each at once. */
export const MAX_SENTENCES = 3;
/** A line that ends a paragraph and is not prose: a heading, a quote, a rule or an image. */
const NOT_PROSE = /^\s*(#|>|---|\*\*\*|!\[)/;
/** A list item's first line: a bullet, or a number of 1 to 9 digits and "." or ")". */
const ITEM = /^\s*(?:[-*+]|(\d{1,9})[.)])(?:\s+(\S.*))?$/;
/** The underline of a setext heading, which makes the paragraph above it a heading. */
const SETEXT = /^ {0,3}(=+|-+)\s*$/;
/** An HTML block that runs to the next blank line, as in CommonMark: a block tag, or a line of tags only. A line that
 * starts with an inline tag (<kbd>, <a>) and has text after it is prose. */
const HTML_BLOCK = /^ {0,3}<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|pre|script|search|section|style|summary|table|tbody|td|textarea|tfoot|th|thead|title|tr|track|ul)(\s|\/?>|$)|^\s*(<[^>]+>\s*)+$/i;

/** The sentences of a text: each end mark (. ! ?) before a space or the end, outside code spans and link URLs. The dot
 * of "e.g." and "i.e." ends no sentence, nor does the dot of "etc." before a word in lower case or a mark. */
export const sentences = (text) => (text.replace(/(`+)[^`]*?\1/g, "x").replace(/\]\([^)]*\)/g, "]").replace(/\b(e\.g|i\.e)\./gi, "$1").replace(/\betc\.(?=\s+[^\s\p{Lu}]|[^\s])/gu, "etc").match(/[.!?]+["')*_\]]*(?=\s|$)/g) ?? []).length;

/** Each paragraph, list item and table cell of a Markdown file with more than MAX_SENTENCES sentences. A paragraph is
 * a run of prose lines that starts at the margin; a list item is its first line and the lines that continue it, up to
 * a blank line. Code blocks, HTML blocks and comments, quotes, headings and indented paragraphs are not checked. */
export function paragraphProblems(file, text) {
  const problems = [], lines = text.split("\n");
  let start = -1, kind = "paragraph", fence = null, html = null;
  const check = (i, n, what) => {
    if (n > MAX_SENTENCES) problems.push(`${file}:${i + 1}: a ${what} of ${n} sentences; keep it at ${MAX_SENTENCES} or fewer. ${what === "paragraph" ? "Split it, or make it a list or a table" : "Shorten it, or split it"}`);
  };
  const end = (i) => {
    if (start >= 0) check(start, sentences(lines.slice(start, i).join(" ").replace(/^\s*\d{1,9}[.)]/, "")), kind); // "1." is a list mark
    start = -1;
  };
  lines.forEach((line, i) => {
    const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) { if (mark?.startsWith(fence)) fence = null; return; }
    if (html) { if (html === "comment" ? line.includes("-->") : !line.trim()) html = null; return; }
    if (mark) { end(i); fence = mark; return; }
    if (start >= 0 && kind === "paragraph" && SETEXT.test(line)) { start = -1; return; } // the lines above are a heading
    // A list item, unless it cannot interrupt the paragraph: a number other than 1 (a wrapped "2026. The year…"), or no text.
    const item = ITEM.exec(line);
    if (item && !(start >= 0 && kind === "paragraph" && (item[1] ? item[1] !== "1" : !item[2]))) { end(i); start = i; kind = "list item"; return; }
    if (/^ {0,3}<!--/.test(line)) { end(i); if (!line.includes("-->")) html = "comment"; return; }
    if (HTML_BLOCK.test(line)) { end(i); html = "block"; return; }
    if (/^\s*\|/.test(line)) { end(i); for (const cell of line.split(/(?<!\\)\|/)) check(i, sentences(cell), "table cell"); return; }
    if (!line.trim() || NOT_PROSE.test(line) || (start < 0 && /^\s/.test(line))) { end(i); return; }
    if (start < 0) { start = i; kind = "paragraph"; }
  });
  end(lines.length);
  return problems;
}
