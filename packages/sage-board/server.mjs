import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, watch } from "node:fs";
import { createServer } from "node:http";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readBoardSources, buildBoardModel, boardOverview, taskPanel, landingRule, pageTaskFolder, renderBoardHtml, renderAgentsHtml, renderMilestonesHtml, renderReleasesHtml, BOARD_PORT } from "../sage-core/index.mjs";
import { pagesRequest, servePages, taskFiles } from "./pages.mjs";
import { designSummary, logbookDir, readerPage, recordedPages } from "./reader.mjs";

const MARKDOWN = await import("./markdown.mjs").then(module => module.renderMarkdown, () => null);
const NO_READER = "The reader's Markdown renderer is not in this copy of the board. Run the board from the sage plugin, or run npm ci and npm run build.";

const MAX_HTML = 8 * 1024 * 1024;
const MAX_CLIENTS = 16;
const digest = text => createHash("sha256").update(text).digest();
const unavailable = [{ source: "board", message: "The board snapshot is unavailable." }];
const TOO_LARGE = "The page that you opened is too large to show (over 8 MB), so the board shows this page instead.";
const NO_STREAM = " This page does not update: reload the address to try again.";
const own = (object, name) => Object.hasOwn(object, name);
const SETTLE_READS = [250, 1000, 3000, 7000, 15000];

function oneHeader(request, name) {
  const values = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i].toLowerCase() === name) values.push(request.rawHeaders[i + 1]);
  return values.length === 1 ? values[0] : values.length ? null : undefined;
}

function taskKey(encoded) {
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(encoded)) return null;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    const key = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return bytes.toString("base64url") === encoded && !/[\x00-\x1f\x7f]/.test(key) ? key : null;
  } catch { return null; }
}

function route(target) {
  if (typeof target !== "string" || target.length > 4096) return null;
  if (target === "/") return { task: null, events: false };
  if (target === "/agents" || target === "/agents?events=1") return { task: null, agents: true, events: target !== "/agents" };
  if (target === "/releases" || target === "/releases?events=1") return { task: null, releases: true, events: target !== "/releases" };
  if (target === "/milestones" || target === "/milestones?events=1") return { task: null, milestones: true, events: target !== "/milestones" };
  const milestone = /^\/milestone\/([A-Za-z0-9_-]+)(\?events=1)?$/.exec(target);
  const old = /^\/program(?:s|\/([A-Za-z0-9_-]+))(\?events=1)?$/.exec(target);
  if (old) { const key = old[1] && taskKey(old[1]); return old[1] && !key ? null : { renamed: key ?? null, events: !!old[2] }; }
  if (milestone) { const key = taskKey(milestone[1]); return key ? { task: null, milestone: key, events: !!milestone[2] } : null; }
  const page = /^\/task\/([A-Za-z0-9_-]+)$/.exec(target);
  if (page) { const key = taskKey(page[1]); return key ? { task: key, events: false } : null; }
  const stream = /^\/\?events=1(?:&task=([A-Za-z0-9_-]+))?$/.exec(target);
  if (stream) { const key = stream[1] ? taskKey(stream[1]) : null; return !stream[1] || key ? { task: key, events: true } : null; }
  return null;
}

function securityHeaders(response, html = null) {
  const hashes = tag => [...(html ?? "").matchAll(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "g"))].map(match => `'sha256-${digest(match[1]).toString("base64")}'`).join(" ") || "'none'";
  response.setHeader("Content-Security-Policy", `default-src 'none'; script-src ${hashes("script")}; style-src ${hashes("style")}; connect-src 'self'; img-src data:; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'`);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

const APP_DIR = fileURLToPath(new URL("./app/", import.meta.url));
const APP_FILE = /^(?:app|vendor|graph)-[A-Z0-9]{8}\.(?:js|css)$/;
const APP_TYPES = { js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8" };
const NO_APP = "The board app is not built in this copy of the board. Run the board from the sage plugin, or run npm run build.";

export function loadBoardApp(dir = APP_DIR) {
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")); } catch { return null; }
  const names = [manifest?.script, manifest?.style, manifest?.vendor, manifest?.graph];
  if (!names.every(name => typeof name === "string" && APP_FILE.test(name)) || !manifest.script.endsWith(".js") || !manifest.style.endsWith(".css") || !manifest.vendor.endsWith(".js") || !manifest.graph.endsWith(".js")) return null;
  const files = new Map(names.map(name => [name, { type: APP_TYPES[name.split(".").pop()], body: readFileSync(join(dir, name)) }]));
  const shell = `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sage board</title><link rel="stylesheet" href="/app/${manifest.style}"><link rel="modulepreload" href="/app/${manifest.vendor}"><script type="module" src="/app/${manifest.script}"></script></head><body><div id="root"></div><noscript><p>This board needs scripts. The board in the chat needs none: send a message that starts with "show board".</p></noscript></body></html>`;
  return { files, shell };
}

function appPolicy(origin) {
  return `default-src 'none'; script-src ${origin}/app/; style-src ${origin}/app/; connect-src 'self'; img-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'`;
}

const forwarded = name => name === "forwarded" || name.startsWith("x-forwarded-");

export function createBoardServer({ sources, port = BOARD_PORT, id, clock = () => new Date().toISOString(), settleReads = SETTLE_READS, duringRead = null, providerRoots = [], app = loadBoardApp(), markdown = MARKDOWN } = {}) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new TypeError("board port must be an integer from 1024 through 65535");
  if (typeof clock !== "function") throw new TypeError("the board clock must be a function that gives an ISO time");
  if (!Array.isArray(sources) || !sources.length || sources.length > 32) throw new TypeError("board needs 1 to 32 explicit sources");
  const ids = new Set();
  const configured = Array.from(sources, source => {
    if (!source || !own(source, "id") || !own(source, "path") || typeof source.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(source.id) || ids.has(source.id) || typeof source.path !== "string" || !isAbsolute(source.path) || resolve(source.path) !== source.path) throw new TypeError("board sources need unique ids and absolute normalized paths");
    for (const key of ["label", "provider"]) if (own(source, key) && (typeof source[key] !== "string" || source[key].length > 160 || /[\x00-\x1f\x7f]/.test(source[key]))) throw new TypeError("invalid board source label");
    ids.add(source.id);
    return Object.freeze({ id: source.id, path: source.path, ...(own(source, "label") ? { label: source.label } : {}), ...(own(source, "provider") ? { provider: source.provider } : {}) });
  });
  const landing = landingRule(configured);
  if (id !== undefined && (typeof id !== "string" || !/^[a-f0-9]{16,64}$/.test(id))) throw new TypeError("the board id must be 16 to 64 lowercase hex characters");
  const local = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const origins = new Map([...local].map(host => [host, `http://${host}`]));
  let boardHeader = null;
  const watchers = new Map(), watchErrors = new Map(), clients = new Set();
  let model, overview, lastGood, revision = 0, refreshTimer, boundaryTimer, settleTimer, startTimer, startPromise, closePromise, closed = false;

  function onMac(request) {
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress) || !local.has(oneHeader(request, "host").toLowerCase())) return false;
    for (let i = 0; i < request.rawHeaders.length; i += 2) if (forwarded(request.rawHeaders[i].toLowerCase())) return false;
    return true;
  }

  function browserBoundary(request) {
    const host = oneHeader(request, "host"), origin = oneHeader(request, "origin"), site = oneHeader(request, "sec-fetch-site");
    return typeof host === "string" && local.has(host.toLowerCase()) &&
      (origin === undefined || typeof origin === "string" && origin === origins.get(host.toLowerCase())) &&
      (site === undefined || ["none", "same-origin"].includes(site));
  }

  const render = (state, view, paths, live = true) => view.agents ? renderAgentsHtml(state, { live, paths }) : view.releases ? renderReleasesHtml(state, { live, paths }) : view.milestones || view.milestone ? renderMilestonesHtml(state, { milestoneKey: view.milestone ?? null, live, paths })
    : renderBoardHtml(state, { taskKey: view.task, snapshot: false, live, paths });
  const fits = html => Buffer.byteLength(html) <= MAX_HTML;
  function pageFor(view, paths = false, stream = false) {
    const html = render(model, view, paths);
    if (fits(html)) return { html, stale: model.stale, diagnostics: model.diagnostics };
    const other = render({ ...model, pageNote: stream ? TOO_LARGE : TOO_LARGE + NO_STREAM }, { milestones: !!view.milestone }, paths, false);
    if (!fits(other)) throw new RangeError("board rendering exceeds the size limit");
    return { html: other, stale: model.stale, diagnostics: model.diagnostics };
  }

  function removeClient(client) {
    clients.delete(client);
    clearTimeout(client.deadline);
    client.pending = null;
  }

  function send(client, message) {
    if (client.response.destroyed || !clients.has(client)) return;
    if (client.blocked) { client.pending = message; return; }
    if (!client.response.write(message)) {
      client.blocked = true;
      client.deadline = setTimeout(() => client.response.destroy(), 30_000);
      client.deadline.unref();
      client.response.once("drain", () => {
        clearTimeout(client.deadline); client.blocked = false;
        const next = client.pending; client.pending = null;
        if (next) send(client, next);
      });
    }
  }

  function publish(client) {
    if (client.app) {
      const data = JSON.stringify(overview);
      if (client.sent === data) return;
      client.sent = data;
      if (Buffer.byteLength(data) > MAX_HTML) { client.response.end(); removeClient(client); return; }
      return send(client, `id: ${revision}\nevent: model\ndata: ${data}\n\n`);
    }
    try {
      const payload = { revision: String(revision), ...pageFor(client, client.paths, true) };
      const sent = digest(JSON.stringify([payload.html, payload.stale, payload.diagnostics])).toString("base64");
      if (client.sent === sent) return;
      client.sent = sent;
      send(client, `id: ${revision}\nevent: board\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch { client.response.end(); removeClient(client); }
  }

  function schedule() {
    if (closed || refreshTimer) return;
    refreshTimer = setTimeout(() => { refreshTimer = undefined; refresh(); }, 20);
    refreshTimer.unref();
  }

  function watchPlans() {
    const plans = new Map();
    const add = (path, child = null) => {
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("watch directory is unavailable");
      const plan = plans.get(path) ?? { path, identity: `${info.dev}:${info.ino}`, children: new Set(), all: false };
      if (child) plan.children.add(child); else plan.all = true;
      plans.set(path, plan);
    };
    const tree = path => {
      add(path);
      for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isDirectory()) try { tree(join(path, entry.name)); } catch {}
    };
    for (const source of configured) {
      try { tree(source.path); } catch {}
      let ancestor = dirname(source.path);
      for (;;) {
        try { add(ancestor, source.path.slice(ancestor.length + (ancestor.endsWith(sep) ? 0 : 1)).split(sep)[0]); break; }
        catch { const parent = dirname(ancestor); if (parent === ancestor) break; ancestor = parent; }
      }
    }
    return plans;
  }

  function settle(step = 0) {
    clearTimeout(settleTimer);
    if (step === settleReads.length) return;
    settleTimer = setTimeout(() => { schedule(); settle(step + 1); }, settleReads[step] - (settleReads[step - 1] ?? 0));
    settleTimer.unref();
  }

  function reconcileWatchers() {
    const plans = watchPlans();
    let added = false;
    for (const [key, item] of watchers) if (!plans.has(key) || plans.get(key).identity !== item.plan.identity) { item.watcher.close(); watchers.delete(key); }
    for (const [key] of watchErrors) if (!plans.has(key)) watchErrors.delete(key);
    for (const [key, plan] of plans) {
      if (watchers.has(key)) { watchers.get(key).plan = plan; continue; }
      if (watchErrors.has(key)) continue;
      try {
        const item = { plan, watcher: null };
        item.watcher = watch(plan.path, (event, filename) => {
          if (event !== "rename" && !item.plan.all && filename && !item.plan.children.has(String(filename))) return;
          watchErrors.clear(); schedule();
        });
        item.watcher.on("error", () => {
          item.watcher.close(); watchers.delete(key);
          watchErrors.set(key, { source: "board", message: "File watching is unavailable; the displayed board may be stale." });
          schedule();
        });
        watchers.set(key, item); added = true;
      } catch { watchErrors.set(key, { source: "board", message: "File watching is unavailable; the displayed board may be stale." }); }
    }
    if (added) settle();
  }

  function refresh() {
    if (closed) return;
    clearTimeout(boundaryTimer);
    let next;
    try {
      reconcileWatchers();
      const read = readBoardSources(configured, { duringRead, providerRoots }), notSetUp = [];
      for (const [index, source] of read.entries()) {
        if (lstatSync(configured[index].path, { throwIfNoEntry: false })) continue;
        source.diagnostics = source.diagnostics.filter(message => message !== "ENOENT");
        if (!source.shared) notSetUp.push(source.label);
      }
      next = { ...buildBoardModel(read, { now: clock(), landing }), notSetUp };
      next.diagnostics = [...next.diagnostics, ...watchErrors.values()];
      const pages = [() => renderBoardHtml(next, { snapshot: false, live: true }), () => renderAgentsHtml(next, { live: true }), () => renderMilestonesHtml(next, { live: true }), () => renderReleasesHtml(next, { live: true })];
      if (pages.some(render => Buffer.byteLength(render()) > MAX_HTML)) throw new RangeError("board rendering exceeds the size limit");
    } catch { next = { ...buildBoardModel([], { now: clock() }), diagnostics: unavailable }; }
    const changing = next.changing ?? [];
    if (changing.length && !model?.changing?.length) settle();
    if (!next.diagnostics.length && !changing.length) { lastGood = next; model = { ...next, stale: false }; }
    else if (!next.diagnostics.length) model = lastGood ? { ...lastGood, stale: false, changing: changing.map(item => ({ project: item.project, at: lastGood.at })) } : { ...next, stale: false };
    else model = { ...(lastGood ?? next), stale: true, diagnostics: next.diagnostics, notSetUp: next.notSetUp, changing };
    overview = boardOverview(model);
    revision++;
    for (const client of clients) publish(client);
    const now = Date.now(), boundary = model.tasks.reduce((first, task) => {
      const at = task.completedAt === null ? NaN : task.completedAt + 7 * 86400000 + 1;
      return Number.isFinite(at) && at > now ? Math.min(first, at) : first;
    }, Math.min(model.agents?.next > now ? model.agents.next : Infinity, overview.next > now ? overview.next : Infinity));
    if (Number.isFinite(boundary)) { boundaryTimer = setTimeout(schedule, Math.min(boundary - now, 2_147_483_647)); boundaryTimer.unref(); }
  }

  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    securityHeaders(response);
    if (pagesRequest(request.url)) return servePages(request, response, { onMac, model });
    const fail = (status, text) => { response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }); response.end(request.method === "HEAD" ? undefined : `${text}\n`); };
    if (!browserBoundary(request) || !onMac(request)) return fail(403, "This request is not permitted.");
    if (boardHeader) response.setHeader("X-Sage-Board", boardHeader);
    if (!["GET", "HEAD"].includes(request.method)) { response.setHeader("Allow", "GET, HEAD"); return fail(405, "This method is not permitted."); }
    if (request.url === "/app" || request.url.startsWith("/app/")) return serveApp(request, response, fail);
    if (request.url.startsWith("/read/")) return serveReader(request, response, fail);
    let selected = route(request.url);
    if (selected?.renamed !== undefined) {
      const key = selected.renamed && (model.milestones.find(milestone => milestone.was && `${milestone.project}/${milestone.was}` === selected.renamed)?.key ?? selected.renamed);
      if (selected.events) selected = key ? { task: null, milestone: key, events: true } : { task: null, milestones: true, events: true };
      else {
        response.writeHead(301, { Location: key ? `/milestone/${Buffer.from(key).toString("base64url")}` : "/milestones" });
        return response.end();
      }
    }
    if (!selected || selected.task && !model.tasks.some(task => task.key === selected.task)) return fail(404, "This board page does not exist.");
    const missing = selected.milestone && !model.milestones.some(milestone => milestone.key === selected.milestone);
    if (missing && selected.events) return fail(404, "This board page does not exist.");
    if (selected.events) {
      if (clients.size >= MAX_CLIENTS && request.method !== "HEAD") return fail(503, "There are too many open board streams.");
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" });
      if (request.method === "HEAD") return response.end();
      response.flushHeaders();
      const client = { response, task: selected.task, agents: !!selected.agents, releases: !!selected.releases, milestones: !!selected.milestones, milestone: selected.milestone ?? null, paths: true, blocked: false, pending: null, deadline: null, sent: null };
      clients.add(client); response.once("close", () => removeClient(client)); publish(client);
      return;
    }
    try {
      const { html } = pageFor(selected, true);
      securityHeaders(response, html);
      response.writeHead(missing ? 404 : 200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
      response.end(request.method === "HEAD" ? undefined : html);
    } catch { fail(503, "The board snapshot is unavailable."); }
  });
  function serveApp(request, response, fail) {
    if (request.url === "/app") { response.writeHead(301, { Location: "/app/" }); return response.end(); }
    if (!app) return fail(503, NO_APP);
    const name = request.url.slice("/app/".length);
    if (name === "events") {
      if (clients.size >= MAX_CLIENTS && request.method !== "HEAD") return fail(503, "There are too many open board streams.");
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" });
      if (request.method === "HEAD") return response.end();
      response.flushHeaders();
      const client = { response, app: true, blocked: false, pending: null, deadline: null, sent: null };
      clients.add(client); response.once("close", () => removeClient(client)); publish(client);
      return;
    }
    if (name.startsWith("task/")) {
      try {
        const key = taskKey(name.slice("task/".length)), panel = key && model && taskPanel(model, key);
        if (!panel) return fail(404, "This task is not on the board.");
        const task = model.tasks.find(item => item.key === key), dir = logbookDir(configured, task);
        const files = { ...taskFiles({ dir, logbook: panel.logbook, task: task.id, runs: panel.runs }), designs: designSummary(panel.logbook, task.id), recorded: recordedPages(task, pageTaskFolder(panel.logbook, task.id)) };
        const body = Buffer.from(JSON.stringify({ ...panel, files }));
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
        return response.end(request.method === "HEAD" ? undefined : body);
      } catch { return fail(503, "The board snapshot is unavailable."); }
    }
    const body = name === "" ? Buffer.from(app.shell) : app.files.get(name)?.body;
    if (!body) return fail(404, "This board page does not exist.");
    if (name === "") response.setHeader("Content-Security-Policy", appPolicy(origins.get(oneHeader(request, "host").toLowerCase())));
    response.writeHead(200, { "Content-Type": name === "" ? "text/html; charset=utf-8" : app.files.get(name).type, "Content-Length": body.length });
    response.end(request.method === "HEAD" ? undefined : body);
  }

  function serveReader(request, response, fail) {
    if (!markdown) return fail(503, NO_READER);
    let page;
    try { page = readerPage({ model, configured, url: request.url, origin: origins.get(oneHeader(request, "host").toLowerCase()), render: markdown }); } catch { return fail(503, "The board cannot read this document now. Reload the page to try again."); }
    if (!page) return fail(404, "This document is not on the board.");
    response.setHeader("Content-Security-Policy", page.policy);
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (request.method === "HEAD") return response.end();
    response.write(page.top);
    response.end(page.rest);
  }

  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  return Object.freeze({
    start() {
      if (closed) return Promise.reject(new Error("the board server is closed"));
      if (startPromise) return startPromise;
      startPromise = new Promise((accept, reject) => {
        refresh();
        const failed = error => {
          for (const { watcher } of watchers.values()) watcher.close(); watchers.clear();
          clearTimeout(refreshTimer); clearTimeout(boundaryTimer); clearTimeout(settleTimer);
          reject(Object.assign(new Error(error.code === "EADDRINUSE" ? `Board port ${port} is already in use.` : "The board listener could not start."), { code: error.code }));
        };
        server.once("error", failed);
        startTimer = setTimeout(() => {
          if (closed) return failed({});
          refresh();
          server.listen(port, "127.0.0.1", () => {
            server.off("error", failed);
            if (id) boardHeader = `id=${id}; pid=${process.pid}; started=${Date.now()}`;
            accept(server.address());
          });
        }, 250);
      });
      return startPromise;
    },
    address: () => server.address(),
    close() {
      if (closePromise) return closePromise;
      closed = true;
      for (const { watcher } of watchers.values()) watcher.close(); watchers.clear();
      clearTimeout(refreshTimer); clearTimeout(boundaryTimer); clearTimeout(settleTimer);
      for (const client of clients) { client.response.destroy(); removeClient(client); }
      closePromise = (async () => {
        if (startPromise) await startPromise.catch(() => {});
        if (server.listening) { server.closeAllConnections(); await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept())); }
      })();
      return closePromise;
    },
  });
}
