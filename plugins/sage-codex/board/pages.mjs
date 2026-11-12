// The board's pages route (T1001): each task's pages folder, read-only, on the Mac only, at
// /pages/<logbook>/<task>/ (an index) and /pages/<logbook>/<task>/<file>. Agents write these pages, so the route trusts no
// name and no file: core's pageTaskFolder and pageFile decide which folder and which files it serves (the message
// command and the index ask the same two), and each response carries a sandbox policy in place of the board's, so a page
// cannot reach the board.
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { PAGE_TYPES, SWITCH_SCRIPT, pageFile, pageTaskFolder, pageType } from "../core/index.mjs";

// The index reads at most SCAN entries and lists at most LIST pages (one task folder holds over 4,000 entries). It reads
// at most READ bytes of pages to find the ones with scripts of their own; a page past that gets the scripts link too.
const SCAN = 2000, LIST = 200, READ = 32 * 1024 * 1024;
const SWITCH = `'sha256-${createHash("sha256").update(SWITCH_SCRIPT).digest("base64")}'`;
const REST = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
/**
 * The policy of a page. Its origin is no origin (a sandbox without allow-same-origin), so it reads no storage of the
 * board and the board refuses its requests; nothing loads. Only sage's own script runs (a message page's Today switch),
 * and a page without that script gets no scripts at all, so it cannot move itself with a meta refresh either. With
 * ?scripts=1 the page's own inline scripts run under the same sandbox.
 */
const pagePolicy = (scripts) => `sandbox${scripts ? " allow-scripts" : ""}; script-src ${scripts === "own" ? "'unsafe-inline'" : SWITCH}; ${REST}`;
/**
 * The index is the board's own page with no script and no sandbox: it keeps its origin, so that its links are
 * same-origin. Its opener policy cuts the window handle of another site that opened it (F-T1001-6), so that site cannot
 * move the tab or hear a page that the owner then opens with its scripts. A browser refuses that policy with a sandbox.
 */
const INDEX_POLICY = `script-src 'none'; ${REST}`;
const PLAIN = "text/plain; charset=utf-8";

/** Is this request for the pages route? */
export const pagesRequest = (url) => typeof url === "string" && /^\/pages(?:[/?]|$)/.test(url);

const one = (request, name) => { const values = request.headersDistinct[name]; return values?.length === 1 ? values[0] : values ? null : undefined; };

/**
 * The browser boundary of the pages route: the Host and Origin of the board, and a request from the board's own pages or
 * from no page (an address that a person opens). F6: a host app's chat may open a link as a cross-site navigation, so a
 * person's click (a top-level navigation with user activation) may open a page from any site. A page is read-only and
 * sandboxed, and that other site cannot read it. The scripts link (?scripts=1) never opens from another site.
 */
function permitted(request, scripts) {
  const host = one(request, "host"), origin = one(request, "origin"), site = one(request, "sec-fetch-site");
  if (typeof host !== "string" || origin !== undefined && origin !== `http://${host.toLowerCase()}`) return false;
  if (site === undefined || site === "none" || site === "same-origin") return true;
  return !scripts && one(request, "sec-fetch-mode") === "navigate" && one(request, "sec-fetch-dest") === "document" && one(request, "sec-fetch-user") === "?1";
}

/**
 * The raw path as { logbook, task, file, scripts }, or null: no %, no backslash, one query. The path is never decoded;
 * pageTaskFolder and pageFile judge its parts.
 */
function parse(url) {
  if (url.length > 1024 || /[%\\]/.test(url)) return null;
  const [path, query, ...more] = url.split("?");
  if (more.length || query !== undefined && query !== "scripts=1") return null;
  const [logbook, task, ...rest] = path.split("/").slice(2);
  const file = rest.join("/");
  if (!file) return query ? null : { logbook, task, file: null };
  return !query || file.endsWith(".html") ? { logbook, task, file, scripts: !!query } : null;
}

/** Has a page a script of its own: a script element or an event attribute, other than sage's Today switch? */
const ownScript = (html) => /<script\b|\son[a-z]+\s*=/i.test(html.replaceAll(`<script>${SWITCH_SCRIPT}</script>`, ""));

/**
 * The pages of a task folder, its own files first, then each folder's, at most 3 parts deep: { pages, more }. It lists
 * only the files that the route serves (pageFile), so that each of its links opens.
 */
function listPages(folder) {
  const pages = [];
  let seen = 0, more = false;
  for (const queue = [""]; queue.length && !more;) {
    const dir = queue.shift();
    let entries;
    try { entries = readdirSync(join(folder, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { continue; }
    for (const entry of entries) {
      if (++seen > SCAN || pages.length === LIST) { more = true; break; }
      const name = dir ? `${dir}/${entry.name}` : entry.name;
      // A Dirent is the entry itself, so a link is neither a file nor a folder here.
      if (entry.isDirectory() && name.split("/").length < 3 && pageType(`${name}/x.txt`)) queue.push(name);
      else if (entry.isFile()) { const page = pageFile(folder, name); if (page) pages.push({ name, size: page.size }); }
    }
  }
  return { pages, more };
}

const sizeText = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;

function indexHtml(logbook, task, folder) {
  const { pages, more } = listPages(folder);
  let budget = READ;
  for (const page of pages) if (page.name.endsWith(".html")) {
    budget -= page.size;
    page.scripts = budget < 0 || ownScript(pageFile(folder, page.name, true)?.bytes.toString("utf8") ?? "");
  }
  const base = `/pages/${logbook}/${task}/`;
  const rows = pages.map((page) => `<li><a href="${base}${page.name}">${page.name}</a> <span class="m">${sizeText(page.size)}</span>${page.scripts ? ` · <a href="${base}${page.name}?scripts=1" aria-label="Open ${page.name} with its scripts">open with its scripts</a>` : ""}</li>`).join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pages of ${task}</title>
<style>:root{color-scheme:light dark}body{margin:0;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}main{max-width:860px;margin:0 auto;padding:22px 20px 48px}h1{font-size:22px;margin:4px 0 8px}.m{color:#595959;font-size:13px}@media (prefers-color-scheme:dark){.m{color:#b3b3b3}}li{margin:4px 0;overflow-wrap:anywhere}.w{border-left:3px solid #c99a00;padding:4px 10px;margin:8px 0}</style></head>
<body><main><h1>Pages of ${task}</h1><p class="m">Logbook ${logbook} · read-only, on this Mac only</p>
<p class="w" role="note"><strong>Warning:</strong> a page may link to sites outside this Mac. When you click such a link, your browser opens that site, and the site gets everything in the link's address.</p>
${pages.some((page) => page.scripts) ? `<p class="w" role="note"><strong>Warning:</strong> the link "open with its scripts" runs the page's own scripts. They cannot read the board or your files, but they can send the page's content to another site. Use it only for a page that you trust.</p>\n` : ""}${pages.length ? `<ul>${rows}</ul>` : "<p>This task has no pages yet.</p>"}
${more ? `<p class="m">The list stops at ${pages.length} pages: the folder holds more files than the index reads.</p>` : ""}</main></body></html>\n`;
}

/**
 * Serve a request of the pages route. onMac tells whether the request comes from the Mac itself; model is the board's
 * snapshot, whose projects name the logbooks. Pages are never served through a tunnel: off the Mac, every address is
 * not found.
 */
export function servePages(request, response, { onMac, model }) {
  const send = (status, type, body, policy = pagePolicy(false)) => {
    response.setHeader("Content-Security-Policy", policy);
    if (policy === INDEX_POLICY) response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("X-DNS-Prefetch-Control", "off");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
    response.end(request.method === "HEAD" ? undefined : body);
  };
  const missing = () => send(404, PLAIN, "This page does not exist.\n");
  const target = parse(request.url);
  if (typeof one(request, "host") !== "string" || !onMac(request)) return missing();
  if (!permitted(request, target?.scripts)) return send(403, PLAIN, "This request is not permitted.\n");
  if (!["GET", "HEAD"].includes(request.method)) { response.setHeader("Allow", "GET, HEAD"); return send(405, PLAIN, "This method is not permitted.\n"); }
  const logbooks = new Set((model?.projects ?? []).flatMap((project) => project.books ?? []).map((key) => key.slice(key.indexOf("/") + 1)));
  if (!target || !logbooks.has(target.logbook)) return missing();
  const folder = pageTaskFolder(target.logbook, target.task);
  if (!folder) return missing();
  // A folder that the board cannot read (or that changed during the read) is unavailable, never a crash of the board.
  if (!target.file) { try { return send(200, "text/html; charset=utf-8", indexHtml(target.logbook, target.task, folder), INDEX_POLICY); } catch { return send(503, PLAIN, "This index is unavailable.\n"); } }
  const bytes = pageFile(folder, target.file, true)?.bytes;
  if (!bytes) return missing();
  const type = pageType(target.file), html = type === PAGE_TYPES.html;
  return send(200, type, bytes, pagePolicy(target.scripts ? "own" : html && bytes.includes(SWITCH_SCRIPT)));
}
