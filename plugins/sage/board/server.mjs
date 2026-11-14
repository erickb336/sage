import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, watch } from "node:fs";
import { createServer } from "node:http";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readBoardSources, buildBoardModel, boardOverview, taskPanel, landingRule, renderBoardHtml, renderAgentsHtml, renderMilestonesHtml, renderReleasesHtml, BOARD_PORT } from "../core/index.mjs";
import { COOKIE, boardAccess, readJson } from "./access.mjs";
import { pagesRequest, servePages, taskFiles } from "./pages.mjs";
import { writeInWorker } from "./writes.mjs";

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
  const shell = (writes = "off") => `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="sage-writes" content="${writes}"><title>Sage board</title><link rel="stylesheet" href="/app/${manifest.style}"><link rel="modulepreload" href="/app/${manifest.vendor}"><script type="module" src="/app/${manifest.script}"></script></head><body><div id="root"></div><noscript><p>This board needs scripts. The board in the chat needs none: send a message that starts with "show board".</p></noscript></body></html>`;
  return { files, shell };
}

function appPolicy(origin) {
  return `default-src 'none'; script-src ${origin}/app/; style-src ${origin}/app/; connect-src 'self'; img-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'`;
}

const forwarded = name => name === "forwarded" || name.startsWith("x-forwarded-");

const BODY_MAX = 16 * 1024;
const GATE = /^G[1-9]\d*$/, TASK = /^T[1-9]\d*$/, CHIEF = /^C[1-9]\d*$/, LOGBOOK = /^([A-Za-z0-9_-]{1,80})\/([a-z0-9-]+-[0-9a-f]{6})$/;
const JOBS = {
  answer: body => GATE.test(body.gate) && Number.isInteger(body.option) && body.option >= 1 && body.option <= 99 && /^[0-9a-f]{16}$/.test(body.digest ?? "") && ["gate", "answer", body.gate, "--via", "board", "--option", String(body.option), "--seen", body.digest],
  undo: body => GATE.test(body.gate) && ["gate", "undo", body.gate],
  give: body => TASK.test(body.task) && CHIEF.test(body.to) && ["gate", "give", body.task, "--to", body.to],
  name: body => CHIEF.test(body.chief) && typeof body.name === "string" && body.name.length <= 240 && ["chief", "name", body.chief, ...(body.name.trim() ? [body.name.trim()] : [])],
};
const jsonCell = text => { try { const value = JSON.parse(text || "null"); return value && typeof value === "object" && !Array.isArray(value) ? value : null; } catch { return null; } };

function json(response, status, body, headers = {}) {
  const text = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": text.length, ...headers });
  response.end(text);
}
const broken = error => `The board could not do this on this Mac (${/^E[A-Z]+$/.test(error?.code ?? "") ? error.code : "an error"}), so nothing changed. Check that the board's state folder, beside its board.json, is an ordinary folder that can be written, and that the disk has space.`;

function jsonBody(request) {
  return new Promise((accept, reject) => {
    const parts = []; let size = 0;
    request.on("data", part => { size += part.length; if (size > BODY_MAX) { reject(new Error("too large")); request.destroy(); } else parts.push(part); });
    request.on("end", () => { try { const value = JSON.parse(Buffer.concat(parts).toString("utf8")); value && typeof value === "object" && !Array.isArray(value) ? accept(value) : reject(new Error("not an object")); } catch (error) { reject(error); } });
    request.on("error", reject);
  });
}

export function createBoardServer({ sources, port = BOARD_PORT, id, clock = () => new Date().toISOString(), settleReads = SETTLE_READS, duringRead = null, providerRoots = [], app = loadBoardApp(), stateDir = null, write = writeInWorker } = {}) {
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
  const access = stateDir ? boardAccess(stateDir) : null;
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
    if (request.url.startsWith("/api/")) return serveApi(request, response, fail).catch(error => response.headersSent ? response.destroy() : json(response, 500, { problem: broken(error) }));
    if (!["GET", "HEAD"].includes(request.method)) { response.setHeader("Allow", "GET, HEAD"); return fail(405, "This method is not permitted."); }
    if (request.url === "/app" || request.url.startsWith("/app/")) return serveApp(request, response, fail);
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
  async function serveApi(request, response, fail) {
    const reply = (status, body, headers) => json(response, status, body, headers);
    if (request.method !== "POST") { response.setHeader("Allow", "POST"); return fail(405, "This method is not permitted."); }
    const host = oneHeader(request, "host").toLowerCase();
    if (oneHeader(request, "origin") !== origins.get(host) || oneHeader(request, "sec-fetch-site") !== "same-origin") return fail(403, "This write is not permitted: only the board's own page, in a browser on this Mac, writes.");
    if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(oneHeader(request, "content-type") ?? "")) return fail(415, "A write sends JSON.");
    if (!access) return fail(503, "This board writes nothing: it started without its config folder.");
    let body;
    try { body = await jsonBody(request); } catch { return response.destroyed ? undefined : fail(400, "A write is one JSON object of at most 16 KiB."); }
    const name = request.url.slice("/api/".length);
    if (name === "pair") {
      const paired = access.pair(body.code);
      return paired.problem ? reply(403, { problem: paired.problem }) : reply(200, { token: paired.token }, { "Set-Cookie": `${COOKIE}=${paired.cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` });
    }
    const browser = access.browserOf(oneHeader(request, "cookie"));
    if (!browser) return reply(401, { problem: "This browser is not paired with the board. Run board --pair in Terminal, then type its code on the board." });
    if (!access.tokenFits(browser, oneHeader(request, "x-sage-token"))) return reply(403, { problem: "This page does not have this browser's pairing token. Pair again: run board --pair in Terminal, then type its code on the board." });
    if (name === "seen") return reply(200, { previous: access.seen() });
    if (name === "name" && /^\s*-/.test(body.name ?? "")) return reply(400, { problem: "A chief's name cannot start with \"-\", because the state tool would read it as an option. Start it with a letter or a digit. Nothing changed." });
    const book = LOGBOOK.exec(body.logbook ?? ""), source = book && configured.find(item => item.id === book[1]);
    const argv = Object.hasOwn(JOBS, name) && JOBS[name](body);
    if (!argv || !source || !model?.sources.some(item => item.id === source.id && item.shared)) return reply(400, { problem: "The board cannot send this write: it names no question, task or chief of a shared logbook." });
    const done = await write({ shared: source.path, folder: book[2], argv });
    return reply(done.pending ? 202 : done.code ? 409 : 200, { ok: !done.code, ...(done.pending && { pending: true }), text: String(done.text).replace(/^sage: /, "") });
  }

  function gateDetail(key) {
    const at = key.lastIndexOf("/"), logbook = key.slice(0, at), id = key.slice(at + 1);
    const task = GATE.test(id) && model?.tasks.find(item => item.project === logbook && item.gateRows?.some(gate => gate.id === id));
    if (!task) return null;
    const gate = task.gateRows.find(row => row.id === id), source = configured.find(item => item.id === task.source);
    const kept = source && LOGBOOK.test(logbook) ? readJson(join(source.path, logbook.slice(logbook.indexOf("/") + 1), "gates"), `${id}.json`, 1 << 20) : null;
    const answered = jsonCell(gate.answered), picked = jsonCell(gate.picked), need = model.needsOwner.flatMap(item => item.reasons).find(reason => reason.key === key);
    return { key, id, logbook, task: { key: task.key, id: task.id, title: task.title }, project: task.projectName, question: String(gate.question ?? ""), options: String(gate.options ?? "").split("|").map(option => option.trim()).filter(Boolean),
      recommendation: gate.recommendation || null, default: gate.default || null, at: gate.at || null, answer: gate.answer || null, answered: answered && { at: String(answered.at ?? ""), via: String(answered.via ?? ""), answer: answered.answer == null ? null : String(answered.answer) },
      picked: picked && { at: String(picked.at ?? ""), chief: String(picked.chief ?? "") }, digest: need?.digest ?? null, owner: (gate.kind === "replace" && gate.chief) || task.owner?.id || gate.chief || null, takeover: gate.kind === "replace", text: need?.text ?? null,
      message: kept?.message?.kind === "question" ? kept.message : null };
  }

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
        const task = model.tasks.find(item => item.key === key), source = configured.find(item => item.id === task.source);
        const dir = source && !task.old && task.project.startsWith(`${source.id}/`) ? join(source.path, panel.logbook) : null;
        const body = Buffer.from(JSON.stringify({ ...panel, files: taskFiles({ dir, logbook: panel.logbook, task: task.id, runs: panel.runs }) }));
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
        return response.end(request.method === "HEAD" ? undefined : body);
      } catch { return fail(503, "The board snapshot is unavailable."); }
    }
    if (name.startsWith("gate/")) {
      const key = taskKey(name.slice("gate/".length)), detail = key && model && gateDetail(key);
      if (!detail) return fail(404, "This question is not on the board.");
      const body = Buffer.from(JSON.stringify(detail));
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
      return response.end(request.method === "HEAD" ? undefined : body);
    }
    const body = name === "" ? Buffer.from(app.shell(access ? "on" : "off")) : app.files.get(name)?.body;
    if (!body) return fail(404, "This board page does not exist.");
    if (name === "") response.setHeader("Content-Security-Policy", appPolicy(origins.get(oneHeader(request, "host").toLowerCase())));
    response.writeHead(200, { "Content-Type": name === "" ? "text/html; charset=utf-8" : app.files.get(name).type, "Content-Length": body.length });
    response.end(request.method === "HEAD" ? undefined : body);
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
