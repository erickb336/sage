import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export const MAX_LINES = 150;
export const MAX_BYTES = 15_000;
const GITHUB = /^https:\/\/github\.com\/erickb336\/sage-stack\/(?:blob|tree)\/main(?:\/|(?=[?#]|$))/;

export const firstScreen = (text) => text.split("\n").filter((l) => !/^\s*(<\/?(a|picture|p)( [^>]*)?>|<source [^>]*>)?\s*$/.test(l)).slice(0, 10);

export const RELEASES = "https://github.com/erickb336/sage-stack/releases";

export function readmeProblems(text) {
  const problems = [];
  const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0), bytes = Buffer.byteLength(text);
  if (lines > MAX_LINES) problems.push(`README.md: ${lines} lines; keep it at ${MAX_LINES} or fewer. Move reference material to a page under docs/`);
  if (bytes > MAX_BYTES) problems.push(`README.md: ${bytes} bytes; keep it at ${MAX_BYTES} or fewer. Move reference material to a page under docs/`);
  if (!text.includes(`](${RELEASES})`)) problems.push(`README.md: no link to the releases page (${RELEASES}); the release notes list the changes`);
  const screen = firstScreen(text).join("\n");
  for (const [need, what] of [[/^\*\*sage-stack is an? [^*]+\.\*\*/m, 'one bold sentence that starts "**sage-stack is a"'], [/^\*\*Status:\*\* /m, 'a status line that starts "**Status:**"'], [/\]\(#quick-start\)/, "a link to #quick-start"]])
    if (!need.test(screen)) problems.push(`README.md: the first screen (the first 10 lines with text) needs ${what}`);
  return problems;
}

const EMPHASIS = /(^|[^\p{L}\p{N}_])(_{1,2})(?!\s)(.+?)(?<!\s)\2(?![\p{L}\p{N}_])/gu;
const plain = (part, i) => (i % 2 ? part.slice(1, -1) : part.replace(/\*/g, "").replace(EMPHASIS, "$1$3"));
export const slug = (heading) => heading.trim().toLowerCase().replace(/<[^>]*>/g, "").split(/(`[^`]*`)/).map(plain).join("").replace(/`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");

export function anchors(text) {
  const count = new Map(), out = new Set();
  for (const line of withoutFences(text).split("\n")) {
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
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

const withoutFences = (text) => text.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm, (m) => m.replace(/[^\n]/g, " "));
const withoutSpans = (text) => text.replace(/(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g, (m) => " ".repeat(m.length));
const withoutCode = (text) => withoutSpans(withoutFences(text));

export function links(text) {
  const t = withoutCode(text), out = [];
  const line = (i) => t.slice(0, i).split("\n").length;
  for (const m of t.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push({ target: m[1], at: m.index });
  for (const m of t.matchAll(/^ {0,3}\[[^\]^][^\]]*\]:[ \t]*<?([^\s>]+)/gm)) out.push({ target: m[1], at: m.index });
  for (const m of t.matchAll(/\s(?:href|src|srcset)="([^"]+)"/g)) out.push({ target: m[1], at: m.index });
  return out.sort((a, b) => a.at - b.at).map(({ target, at }) => ({ target, line: line(at) }));
}

export function docFiles(root) {
  const under = (dir) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? under(join(dir, e.name)) : e.name.endsWith(".md") ? [join(dir, e.name)] : []));
  return [...["README.md", "CONTRIBUTING.md", "SECURITY.md", "AGENTS.md"].filter((f) => existsSync(join(root, f))), ...under("docs"), "packages/sage-board/README.md", "packages/sage-claude/skills/sage-help/SKILL.md"].filter((f) => existsSync(join(root, f)));
}

export function linkProblems(root, files = docFiles(root), read = (file) => readFileSync(join(root, file), "utf8")) {
  const problems = [], cache = new Map();
  const anchorsOf = (file) => cache.get(file) ?? cache.set(file, anchors(readFileSync(file, "utf8"))).get(file);
  for (const file of files) {
    const text = read(file);
    for (const link of links(text)) {
      const { line } = link, onMain = GITHUB.test(link.target);
      const target = onMain ? link.target.replace(GITHUB, "/") : link.target;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;
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

export const MAX_SENTENCES = 3;
const NOT_PROSE = /^\s*(#|>|---|\*\*\*|!\[)/;
const ITEM = /^\s*(?:[-*+]|(\d{1,9})[.)])(?:\s+(\S.*))?$/;
const SETEXT = /^ {0,3}(=+|-+)\s*$/;
const HTML_BLOCK = /^ {0,3}<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|pre|script|search|section|style|summary|table|tbody|td|textarea|tfoot|th|thead|title|tr|track|ul)(\s|\/?>|$)|^\s*(<[^>]+>\s*)+$/i;

export const sentences = (text) => (text.replace(/(`+)[^`]*?\1/g, "x").replace(/\]\([^)]*\)/g, "]").replace(/\b(e\.g|i\.e)\./gi, "$1").replace(/\betc\.(?=\s+[^\s\p{Lu}]|[^\s])/gu, "etc").match(/[.!?]+["')*_\]]*(?=\s|$)/g) ?? []).length;

export function paragraphProblems(file, text) {
  const problems = [], lines = text.split("\n");
  let start = -1, kind = "paragraph", fence = null, html = null;
  const check = (i, n, what) => {
    if (n > MAX_SENTENCES) problems.push(`${file}:${i + 1}: a ${what} of ${n} sentences; keep it at ${MAX_SENTENCES} or fewer. ${what === "paragraph" ? "Split it, or make it a list or a table" : "Shorten it, or split it"}`);
  };
  const end = (i) => {
    if (start >= 0) check(start, sentences(lines.slice(start, i).join(" ").replace(/^\s*\d{1,9}[.)]/, "")), kind);
    start = -1;
  };
  lines.forEach((line, i) => {
    const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) { if (mark?.startsWith(fence)) fence = null; return; }
    if (html) { if (html === "comment" ? line.includes("-->") : !line.trim()) html = null; return; }
    if (mark) { end(i); fence = mark; return; }
    if (start >= 0 && kind === "paragraph" && SETEXT.test(line)) { start = -1; return; }
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
