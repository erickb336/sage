import { createHash } from "node:crypto";
import { escapeHtml as esc, pictureSvg } from "./picture.mjs";
import { headOf } from "./message.mjs";

const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
const hash = (s) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;

export const SWITCH_SCRIPT = "(function(){document.querySelectorAll('.tg').forEach(function(t){var bar=t.querySelector('.tg-bar');bar.hidden=false;t.classList.add('js');bar.querySelectorAll('button').forEach(function(b){b.addEventListener('click',function(){t.classList.toggle('show-today',b.dataset.v==='today');bar.querySelectorAll('button').forEach(function(x){x.setAttribute('aria-pressed',String(x===b))})})})})})();";

const CSS = `:root{color-scheme:light dark;--bg:#f7f6f2;--fg:#1c1b19;--muted:#5d5952;--line:#d9d5cc;--panel:#fff;--panel2:#f0eee8;--accent:#2d5bc4;--accent-fill:#e8eefc;--new:#fff0b3;--new-line:#c99a00;--pic-f0:#fff;--pic-f1:#f4f2ec;--pic-line:#57534c;--st-prog:#1f5fcf;--st-wait:#8a6510;--st-need:#c2410c;--st-done:#1d7a3e;--st-stop:#9b2c2c;--st-not:#6b6760}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ebe9e4;--muted:#a9a49b;--line:#3a3833;--panel:#1d1c1a;--panel2:#262522;--accent:#8fb0ff;--accent-fill:#1d2840;--new:#3d3412;--new-line:#d6b23a;--pic-f0:#1d1c1a;--pic-f1:#262522;--pic-line:#b8b3a8;--st-prog:#8fb0ff;--st-wait:#e0bd62;--st-need:#fb923c;--st-done:#6fd394;--st-stop:#f08a8a;--st-not:#aaa59c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:22px 20px 48px}main.long{max-width:1040px}
.m-kind{font-size:12px;font-weight:700;letter-spacing:.06em;color:var(--accent)}
h1{font-size:22px;line-height:1.3;margin:4px 0 12px}p{margin:8px 0}.m-label{font-weight:650}
h2{font-size:15px;margin:16px 0 4px}ul,ol{margin:6px 0;padding-left:22px}li{margin:3px 0}
.m-table{overflow-x:auto;margin:10px 0}table{border-collapse:collapse;font-size:14px;min-width:100%}caption{text-align:left;font-weight:650;padding:0 0 4px}
th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{background:var(--panel2);font-weight:650}
.pick-mark{font-weight:650;color:var(--accent)}.m-answers li{margin:8px 0}.m-answers li.pick{background:var(--accent-fill);border-radius:6px;padding:2px 8px}
figure{margin:14px 0}figcaption{font-weight:650;font-size:14px;margin-bottom:6px}.m-key{font-size:13px;color:var(--muted);margin-top:6px}
.m-pic{border:1px solid var(--line);border-radius:10px;padding:10px;background:var(--pic-f0);overflow-x:auto}
svg.pic{display:block;width:100%;max-width:600px;height:auto}main.long svg.pic{max-width:860px}
.pic-box{fill:var(--pic-f0);stroke:var(--pic-line);stroke-width:1.3}.pic-box.d1{fill:var(--pic-f1)}.pic-box.dashed{stroke-dasharray:5 4;fill:none}
.pic-box.double{stroke:var(--accent);stroke-width:2.6;fill:var(--accent-fill)}
.pic-box.st-prog{stroke:var(--st-prog)}.pic-box.st-wait{stroke:var(--st-wait)}.pic-box.st-need{stroke:var(--st-need)}.pic-box.st-done{stroke:var(--st-done)}.pic-box.st-stop{stroke:var(--st-stop)}.pic-box.double.st-prog{stroke:var(--accent)}
.pic-labelbg{fill:var(--pic-f0)}.pic-labelbg.d1{fill:var(--pic-f1)}.pic-labelbg.double{fill:var(--accent-fill)}.pic-labelbg.dashed{fill:var(--pic-f0)}
.pic-line{stroke:var(--pic-line);stroke-width:1.4;fill:none;stroke-linecap:round}.pic-line.dash{stroke-dasharray:3 3}.pic-head{fill:var(--pic-line)}.pic-bar{fill:var(--accent)}
.pic-text{fill:var(--fg);font:12.5px -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}.pic-raw{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.pic-label{font-weight:700}.pic-label.here{fill:var(--accent)}.pic-strong{font-weight:600}
tspan.st{font-weight:700}tspan.st-prog{fill:var(--st-prog)}tspan.st-wait{fill:var(--st-wait)}tspan.st-need{fill:var(--st-need)}tspan.st-done{fill:var(--st-done)}tspan.st-stop{fill:var(--st-stop)}tspan.st-not{fill:var(--st-not)}
.pic-tag.new{fill:var(--new);stroke:var(--new-line);stroke-width:1}.pic-tag.was{fill:var(--panel2);stroke:var(--line);stroke-width:1}.pic-tagtext{font-size:11.5px}
.tag-new{font-weight:700}.tag-was{font-weight:700;fill:var(--muted)}.tag-old{text-decoration:line-through;fill:var(--muted)}
.m-page{border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:8px;padding:8px 10px;margin:12px 0;font-size:14px;background:var(--panel2);overflow-wrap:anywhere}
.m-page-title{font-weight:650}.m-page-path{color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
pre{background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:6px 10px;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;overflow-x:auto;margin:6px 0}
.m-see{color:var(--muted);font-size:14px}.m-ref{font-size:12px;color:var(--muted);margin-top:16px}
.tg-bar[hidden]{display:none}.tg-bar{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;margin:6px 0 10px}
.tg-bar button{font:inherit;font-size:14px;padding:5px 14px;border:0;background:var(--panel);color:var(--fg);cursor:pointer}.tg-bar button[aria-pressed=true]{background:var(--accent);color:var(--panel);font-weight:650}
.tg-label{font-size:15px;font-weight:700;color:var(--muted);margin:6px 0 2px}.tg-after .tg-label{color:var(--accent)}
.tg.js .tg-today{display:none}.tg.js.show-today .tg-today{display:block}.tg.js.show-today .tg-after{display:none}
details.text-form{margin-top:28px;border-top:1px solid var(--line);padding-top:10px}details.text-form summary{cursor:pointer;font-size:13px;color:var(--muted)}
details.text-form pre{font-size:12.5px;line-height:1.45;white-space:pre;background:var(--panel)}`;

export const PAGE_POLICY = `default-src 'none'; style-src ${hash(CSS)}; script-src ${hash(SWITCH_SCRIPT)}; img-src 'none'; base-uri 'none'; form-action 'none'`;

const figure = (title, lines, key) => `<figure><figcaption>${esc(title)}</figcaption><div class="m-pic">${pictureSvg(lines, { title })}</div>${key ? `<p class="m-key">${inline(key)}</p>` : ""}</figure>`;

function blockHtml(b, level = 2) {
  switch (b.t) {
    case "field": return `<p><span class="m-label">${esc(b.label)}:</span> ${inline(b.text)}</p>`;
    case "p": return `<p>${inline(b.text)}</p>`;
    case "section": return `<section><h${level}>${esc(b.label)}</h${level}>${b.body.map((x) => blockHtml(x, Math.min(level + 1, 6))).join("")}</section>`;
    case "list": { const tag = b.ordered ? "ol" : "ul"; return `<${tag}>${b.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${tag}>`; }
    case "table": if (b.pick !== undefined) return `${b.caption ? `<p class="m-label">${esc(b.caption)}</p>` : ""}<ol class="m-answers">${b.rows.map((r, i) => `<li${b.pick === i ? ' class="pick"' : ""}><p class="m-label">${inline(r[0])}${b.pick === i && !/\(my pick\)/i.test(r[0]) ? ' <span class="pick-mark">(my pick)</span>' : ""}</p>${r.slice(1).map((c, k) => `<p><span class="m-label">${esc(b.head[k + 1])}:</span> ${inline(c)}</p>`).join("")}</li>`).join("")}</ol>`;
      return `<div class="m-table"><table>${b.caption ? `<caption>${esc(b.caption)}</caption>` : ""}<thead><tr>${b.head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    case "picture": return figure(b.title, b.lines, b.key);
    case "toggle": {
      const side = (cls, label, pics) => `<div class="tg-pane ${cls}"><p class="tg-label">${label}</p>${pics.map((p) => figure(p.title, p.lines)).join("")}</div>`;
      return `<div class="tg"><div class="tg-bar" hidden role="group" aria-label="Which picture"><button type="button" data-v="after" aria-pressed="true">After this change</button><button type="button" data-v="today" aria-pressed="false">Today</button></div>${side("tg-after", "After this change", b.after)}${side("tg-today", "Today", b.today)}</div>`;
    }
    case "changes": return `<div class="m-table"><table><thead><tr><th>Where you see it</th><th>Today</th><th>After this change</th><th>Why</th></tr></thead><tbody>${b.rows.map((r) => `<tr>${[r.where, r.today, r.after, r.why].map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    case "page": return `<div class="m-page"><div class="m-page-title">Page · ${inline(b.title)}</div>${b.url ? `<div class="m-page-path">${esc(b.url)}</div>` : ""}<div class="m-page-path">${esc(b.path ?? b.file)}</div></div>`;
    case "code": return `<pre>${esc(b.lines.join("\n"))}</pre>`;
    case "steps": return `<ol>${b.items.map((s) => `<li>${inline(s.text)}${s.cmd ? `<pre>${esc(s.cmd.join("\n"))}</pre>` : ""}${s.see ? `<p class="m-see">${inline(s.see)}</p>` : ""}</li>`).join("")}</ol>`;
    default: throw new Error(`unknown block ${b.t}`);
  }
}

export function messagePage(msg, text) {
  const body = `<main${msg.long !== undefined ? ' class="long"' : ""}><div class="m-kind">${esc(headOf(msg))}</div><h1>${inline(msg.title)}</h1>${msg.blocks.map((b) => blockHtml(b)).join("")}${msg.ref ? `<p class="m-ref">Ref: ${esc(msg.ref)}</p>` : ""}<details class="text-form"><summary>The same message as plain text</summary><pre>${esc(text)}</pre></details></main>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PAGE_POLICY}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(msg.title)}</title><style>${CSS}</style></head><body>${body}<script>${SWITCH_SCRIPT}</script></body></html>\n`;
}
