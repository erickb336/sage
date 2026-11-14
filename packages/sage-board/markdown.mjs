import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
md.validateLink = url => !/^\s*(?:[a-z][a-z0-9+.-]*:|\/\/|\\)/i.test(url) || /^https:\/\//i.test(url.trim());

const slug = text => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "part";
const plain = tokens => tokens.map(token => token.children ? plain(token.children) : ["text", "code_inline"].includes(token.type) ? token.content : "").join("");
const off = (token, text) => Object.assign(token, { type: "html_inline", tag: "", nesting: 0, content: text });

export function renderMarkdown(text, { href, picture }) {
  const headings = [], ids = new Set(), next = new Map(), env = {};
  const tokens = md.parse(String(text), env);
  const title = tokens[0]?.type === "heading_open" && tokens[0].tag === "h1" ? plain([tokens[1]]) : null;
  if (title !== null) tokens.splice(0, 3);
  for (const [index, token] of tokens.entries()) {
    if (token.type === "heading_open" || token.type === "heading_close") token.tag = `h${Math.min(6, Number(token.tag[1]) + 1)}`;
    if (token.type === "heading_open") {
      const words = plain([tokens[index + 1]]);
      const base = `h-${slug(words)}`;
      let id = base, n = next.get(base) ?? 2;
      while (ids.has(id)) id = `${base}-${n++}`;
      next.set(base, n); ids.add(id); token.attrSet("id", id);
      if (["h2", "h3", "h4"].includes(token.tag)) headings.push({ level: Number(token.tag[1]), id, text: words });
    }
    const opened = [];
    for (const child of token.children ?? []) {
      if (child.type === "link_open") {
        const url = href(child.attrGet("href"));
        opened.push(!!url);
        if (url) child.attrs = [["href", url]]; else off(child, "<span class=\"off\" title=\"This link leaves the task's pages folder, so the reader does not follow it.\">");
      } else if (child.type === "link_close") { if (!opened.pop()) off(child, "</span>"); }
      else if (child.type === "image") {
        const alt = plain(child.children ?? []);
        off(child, picture(child.attrGet("src"), alt) ?? `<span class="off">Picture not shown: ${md.utils.escapeHtml(alt || child.attrGet("src") || "no name")}. The reader shows only pictures from this task's pages folder.</span>`);
      }
    }
  }
  return { html: md.renderer.render(tokens, md.options, env), headings, title };
}
