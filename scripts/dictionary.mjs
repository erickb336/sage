const section = (body, heading) => body.split(/^## /m).find((s) => s.startsWith(`${heading}\n`)) ?? "";
const rows = (body, heading) => section(body, heading).split("\n").filter((l) => l.startsWith("| **"))
  .map((l) => l.slice(1, -1).split(" | ").map((c) => c.trim())).map(([w, ...rest]) => [w.replace(/\*\*/g, ""), ...rest]);

export function wordTable(body) {
  const line = ([w, meaning]) => `| **${w[0].toUpperCase()}${w.slice(1)}** | ${meaning} |`;
  return ["| Word | Meaning |", "| --- | --- |", ...rows(body, "Words").map(line), ...rows(body, "Names").map(line)].join("\n");
}

export const TABLE_START = "<!-- The word table comes from writing/dictionary.md: edit it there, then run npm run build. -->";
export const TABLE_END = "<!-- The end of the word table. -->";
export const WORDS_PAGE = "docs/guide/concepts.md";
export const PRINCIPLES_PAGE = "docs/guide/principles.md";
export function withBlock(readme, start, end, text, what, file) {
  const i = readme.indexOf(start), j = readme.indexOf(end);
  if (i < 0 || j < i) throw new Error(`${file}: ${what} needs the lines ${start} and ${end}`);
  return `${readme.slice(0, i + start.length)}\n\n${text}\n\n${readme.slice(j)}`;
}
export const withWordTable = (page, table) => withBlock(page, TABLE_START, TABLE_END, table, "the word table", WORDS_PAGE);

const pattern = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[- ]/g, "(?:-|\\s+)?");
export function checkWords(body) {
  const list = (key) => (new RegExp(`^\\*\\*${key}:\\*\\*(.*)$`, "m").exec(body)?.[1] ?? "").split(",").map((s) => /^(.+?)(?: \((.*)\))?$/.exec(s.trim())).filter(Boolean);
  const flagged = list("Flagged");
  const said = (f) => rows(body, "Words").filter(([, , not]) => not.split(/[,;]/).some((n) => n.trim().replace(/ \(.*$/, "") === f)).map(([w]) => w);
  const use = new Map(flagged.map(([, f, note]) => [f, note?.startsWith("say ") ? [note.slice(4)] : said(f)]));
  const words = { words: flagged.map(([, f]) => f), allowed: list("Allowed names").map(([, n]) => n), use };
  const refuse = (problem) => { throw new Error(`writing/dictionary.md: ${problem}`); };
  if (!words.words.length) refuse("the check needs its flagged words, on one line: **Flagged:** word, word, …");
  const approved = [...rows(body, "Words"), ...rows(body, "Names")].map(([w]) => w);
  const twice = approved.find((w, i) => approved.findIndex((v) => v.toLowerCase() === w.toLowerCase()) < i);
  if (twice) refuse(`the word "${twice}" has two rows; keep one`);
  for (const w of approved) for (const { word } of flaggedWords(w, words)) refuse(`the row "${w}" has a flagged word, "${word}"; take it out of the Flagged line`);
  for (const [f, say] of use) if (!say.length) refuse(`the flagged word "${f}" has no word to say; put it in the "Do not say" column of a row, or write "${f} (say …)" in the Flagged line`);
  return words;
}

export function yamlText(value) {
  const v = value.trim();
  if (/^".*"$/.test(v) && v.length > 1) return v.slice(1, -1).replace(/\\(?:(["\\/])|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (e, c) => c ?? " ");
  if (/^'.*'$/.test(v) && v.length > 1) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

const blank = (s) => s.replace(/[^\n]/g, "\0");
const sp = "[ \\t]*(?:\\n[ \\t]*)?";
const TAG = new RegExp(`<(?:[A-Za-z][A-Za-z0-9-]*(?:(?=\\s)${sp}[A-Za-z_:][\\w.:-]*(?:${sp}=${sp}(?:[^\\s"'=<>\`]+|'[^'\\n]*'|"[^"\\n]*"))?)*${sp}/?|/[A-Za-z][A-Za-z0-9-]*${sp}|![A-Za-z][^>\\n]*)>|<https?:[^>\\s]*>`, "g");
const tag = (t) => t.replace(/(\s(?:alt|title|aria-label)=)(?:"([^"]*)"|'([^']*)')|[^\n]/gi, (m, key, dq, sq) => (key ? `${blank(key)}\0${dq ?? sq}\0` : "\0"));
const link = (l) => l.replace(/\s(?:"([^"]*)"|'([^']*)'|\(([^)]*)\))(?=\s*\)$)|[^\n]/g, (m, dq, sq, pq) => (m.length > 1 ? `\0\0${dq ?? sq ?? pq}\0` : "\0"));
function indentedCode(text) {
  let base = 0, afterBlank = true, code = false;
  return text.split("\n").map((line) => {
    const indent = line.replace(/\t/g, "    ").search(/\S/);
    if (indent < 0) return (afterBlank = true), line;
    if ((afterBlank || code) && indent >= base + 4) return (code = true), blank(line);
    base = /^\s*(?:[-*+]|\d+[.)])\s+/.exec(line)?.[0].length ?? indent;
    afterBlank = code = false;
    return line;
  }).join("\n");
}

function prose(text, html) {
  const t = text.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, (front) => front.replace(/^(description:)(.*)$/m, (all, key, value) => `${key} ${yamlText(value)}`));
  return (html ? t : indentedCode(t))
    .replace(/^([ \t]*)(`{3,}|~{3,})mermaid[ \t]*\n([\s\S]*?)^[ \t]*\2[ \t]*$/gm, (m, indent, fence, body) => `${blank(`${indent}${fence}mermaid`)}\n${body.replace(/"/g, " ")}${blank(fence)}`)
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1/gm, blank)
    .replace(/(?<=(?:^|[^\\])(?:\\\\)*)(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g, blank)
    .replace(/<pre class="mermaid">[\s\S]*?<\/pre>/g, (m) => m.replace(/"/g, " "))
    .replace(/<(script|style|code)\b[\s\S]*?<\/\1>/gi, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(TAG, tag)
    .replace(/\]\([^()\n]*(?:\([^()\n]*\)[^()\n]*)?\)/g, link)
    .replace(/(?<!\d)"[^"\n]*"|“[^”\n]*”|(?<![\p{L}\p{N}\0])'(?:[^'\n]|'(?=\p{L}))*'(?![\p{L}\p{N}])|‘(?:[^’\n]|’(?=\p{L}))*’/gu, blank);
}

export function flaggedWords(text, { words, allowed, use }, { html = false } = {}) {
  const t = prose(text, html);
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map(pattern).join("|")})s?(?![\\p{L}\\p{N}])`, "giu");
  return [...t.matchAll(re)].filter((m) => !allowed.includes(m[0])).map((m) => {
    const f = words.find((w) => new RegExp(`^${pattern(w)}s?$`, "iu").test(m[0]));
    return { line: t.slice(0, m.index).split("\n").length, word: m[0].replace(/\s+/g, " "), use: use.get(f) ?? [] };
  });
}
