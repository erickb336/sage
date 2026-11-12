import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { lstatSync, readdirSync, watch } from "node:fs";
import { createServer } from "node:http";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { readBoardSources, buildBoardModel, landingRule, renderBoardHtml, renderAgentsHtml, renderMilestonesHtml, renderReleasesHtml, BOARD_PORT } from "../sage-core/index.mjs";
import { pagesRequest, servePages } from "./pages.mjs";

const MAX_HTML = 8 * 1024 * 1024;
const MAX_CLIENTS = 16;
const digest = text => createHash("sha256").update(text).digest();
const unavailable = [{ source: "board", message: "The board snapshot is unavailable." }];
const TOO_LARGE = "The page that you opened is too large to show (over 8 MB), so the board shows this page instead.";
const NO_STREAM = " This page does not update: reload the address to try again.";
const own = (object, name) => Object.hasOwn(object, name);
const SETTLE_READS = [250, 1000, 3000, 7000, 15000];

function authority(value) {
  if (typeof value !== "string" || value.length > 255 || !/^[a-zA-Z0-9.-]+(?::[1-9]\d{0,4})?$/.test(value)) throw new TypeError("invalid allowed board host");
  const url = new URL(`https://${value}`);
  const host = value.toLowerCase();
  const declared = host.split(":")[0];
  if (url.hostname !== declared || declared.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || Number(url.port || 443) > 65535) throw new TypeError("invalid allowed board host");
  return host;
}

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

const b64 = /^[A-Za-z0-9_-]+$/;
const derive = (password, { N, r, p, salt }) => new Promise((done, fail) => scrypt(password.normalize("NFC"), Buffer.from(salt, "base64url"), 32, { N, r, p, maxmem: 256 * N * r }, (error, key) => error ? fail(error) : done(key)));
export function validPasswordRecord(record) {
  const { scheme, N, r, p, salt, hash } = record ?? {};
  return Boolean(record) && Object.keys(record).length === 6 && scheme === "scrypt" && Number.isSafeInteger(N) && N >= 16384 && N <= 1048576 && (N & (N - 1)) === 0 &&
    Number.isSafeInteger(r) && r >= 8 && r <= 32 && Number.isSafeInteger(p) && p >= 1 && p <= 4 && typeof salt === "string" && b64.test(salt) && Buffer.from(salt, "base64url").length >= 16 &&
    typeof hash === "string" && b64.test(hash) && Buffer.from(hash, "base64url").length === 32;
}
export async function hashPassword(password) {
  const record = { scheme: "scrypt", N: 32768, r: 8, p: 1, salt: randomBytes(16).toString("base64url") };
  return { ...record, hash: (await derive(password, record)).toString("base64url") };
}
export async function checkPassword(password, record) {
  return validPasswordRecord(record) && timingSafeEqual(await derive(password, record), Buffer.from(record.hash, "base64url"));
}

const WRONG_PASSWORD_DELAY = 1000;
const forwarded = name => name === "forwarded" || name.startsWith("x-forwarded-");

const OFF = "Access from outside this Mac is off until the owner sets a board password on the Mac.";
export function createBoardServer({ sources, password, port = BOARD_PORT, allowedHosts = [], id, clock = () => new Date().toISOString(), settleReads = SETTLE_READS, duringRead = null, providerRoots = [] } = {}) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new TypeError("board port must be an integer from 1024 through 65535");
  if (typeof clock !== "function") throw new TypeError("the board clock must be a function that gives an ISO time");
  if (password !== undefined && !validPasswordRecord(password)) throw new TypeError("the board password must be a record from hashPassword");
  if (!Array.isArray(sources) || !sources.length || sources.length > 32) throw new TypeError("board needs 1 to 32 explicit sources");
  const ids = new Set();
  const configured = Array.from(sources, source => {
    if (!source || !own(source, "id") || !own(source, "path") || typeof source.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(source.id) || ids.has(source.id) || typeof source.path !== "string" || !isAbsolute(source.path) || resolve(source.path) !== source.path) throw new TypeError("board sources need unique ids and absolute normalized paths");
    for (const key of ["label", "provider"]) if (own(source, key) && (typeof source[key] !== "string" || source[key].length > 160 || /[\x00-\x1f\x7f]/.test(source[key]))) throw new TypeError("invalid board source label");
    ids.add(source.id);
    return Object.freeze({ id: source.id, path: source.path, ...(own(source, "label") ? { label: source.label } : {}), ...(own(source, "provider") ? { provider: source.provider } : {}) });
  });
  const landing = landingRule(configured);
  if (!Array.isArray(allowedHosts) || allowedHosts.length > 32) throw new TypeError("invalid allowed board hosts");
  if (id !== undefined && (typeof id !== "string" || !/^[a-f0-9]{16,64}$/.test(id))) throw new TypeError("the board id must be 16 to 64 lowercase hex characters");
  const local = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const hosts = new Set([...local, ...Array.from(allowedHosts, authority)]);
  const origins = new Map([...hosts].map(host => [host, new URL(`${local.has(host) ? "http" : "https"}://${host}`).origin]));
  let remembered = null;
  let checking = false;
  let boardHeader = null;
  const watchers = new Map(), watchErrors = new Map(), clients = new Set();
  let model, lastGood, revision = 0, refreshTimer, boundaryTimer, settleTimer, startTimer, startPromise, closePromise, closed = false;

  async function authenticated(request) {
    const value = oneHeader(request, "authorization");
    if (typeof value !== "string" || value.length > 2048) return false;
    const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match) return false;
    const decoded = Buffer.from(match[1], "base64");
    if (decoded.toString("base64") !== match[1]) return false;
    const seen = digest(decoded);
    if (remembered && timingSafeEqual(seen, remembered)) return true;
    const text = decoded.toString("utf8"), colon = text.indexOf(":");
    if (colon === -1 || text.slice(0, colon) !== "sage") return false;
    if (checking) return "busy";
    checking = true;
    try {
      if (await checkPassword(text.slice(colon + 1), password).catch(() => false)) { remembered = seen; return true; }
      await new Promise(wake => setTimeout(wake, WRONG_PASSWORD_DELAY));
      return false;
    } finally { checking = false; }
  }

  function onMac(request) {
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress) || !local.has(oneHeader(request, "host").toLowerCase())) return false;
    for (let i = 0; i < request.rawHeaders.length; i += 2) if (forwarded(request.rawHeaders[i].toLowerCase())) return false;
    return true;
  }

  function browserBoundary(request) {
    const host = oneHeader(request, "host"), origin = oneHeader(request, "origin"), site = oneHeader(request, "sec-fetch-site");
    return typeof host === "string" && hosts.has(host.toLowerCase()) &&
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
    revision++;
    for (const client of clients) publish(client);
    const now = Date.now(), boundary = model.tasks.reduce((first, task) => {
      const at = task.completedAt === null ? NaN : task.completedAt + 7 * 86400000 + 1;
      return Number.isFinite(at) && at > now ? Math.min(first, at) : first;
    }, model.agents?.next > now ? model.agents.next : Infinity);
    if (Number.isFinite(boundary)) { boundaryTimer = setTimeout(schedule, Math.min(boundary - now, 2_147_483_647)); boundaryTimer.unref(); }
  }

  const server = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    securityHeaders(response);
    if (pagesRequest(request.url)) return servePages(request, response, { onMac, model });
    const fail = (status, text) => { response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }); response.end(request.method === "HEAD" ? undefined : `${text}\n`); };
    if (!browserBoundary(request)) return fail(403, "This request is not permitted.");
    const mac = onMac(request);
    if (mac) { if (boardHeader) response.setHeader("X-Sage-Board", boardHeader); }
    else if (!password) return fail(403, OFF);
    else {
      const signedIn = await authenticated(request);
      if (signedIn === "busy") { response.setHeader("Retry-After", "1"); return fail(429, "Another sign-in is being checked. Try again in a second."); }
      if (!signedIn) { response.setHeader("WWW-Authenticate", 'Basic realm="Sage board", charset="UTF-8"'); return fail(401, "Sign in to the Sage board."); }
    }
    if (!["GET", "HEAD"].includes(request.method)) { response.setHeader("Allow", "GET, HEAD"); return fail(405, "This method is not permitted."); }
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
      const client = { response, task: selected.task, agents: !!selected.agents, releases: !!selected.releases, milestones: !!selected.milestones, milestone: selected.milestone ?? null, paths: mac, blocked: false, pending: null, deadline: null, sent: null };
      clients.add(client); response.once("close", () => removeClient(client)); publish(client);
      return;
    }
    try {
      const { html } = pageFor(selected, mac);
      securityHeaders(response, html);
      response.writeHead(missing ? 404 : 200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
      response.end(request.method === "HEAD" ? undefined : html);
    } catch { fail(503, "The board snapshot is unavailable."); }
  });
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
