// Provider-neutral, read-only board transport. The caller owns configuration and secret generation.
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { lstatSync, watch } from "node:fs";
import { createServer } from "node:http";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { readBoardSources, buildBoardModel, renderBoardHtml } from "../sage-core/index.mjs";

const MAX_HTML = 8 * 1024 * 1024;
const MAX_CLIENTS = 16;
const digest = text => createHash("sha256").update(text).digest();
const unavailable = [{ source: "board", message: "The board snapshot is unavailable." }];
const own = (object, name) => Object.hasOwn(object, name);

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

// The owner's own board password (T216) is kept only as a salted scrypt hash, with its parameters next to it.
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

// After a wrong password the next check waits this long; with one check at a time, a guesser gets about one try a second.
const WRONG_PASSWORD_DELAY = 1000;
// Headers that a proxy adds. tailscale serve connects from 127.0.0.1, keeps the client's Host and always adds
// X-Forwarded-For, so a request that has any of them came through a proxy, not from the Mac itself.
const forwarded = name => name === "forwarded" || name.startsWith("x-forwarded-") || name.startsWith("tailscale-");

/**
 * The caller supplies a secret made from at least 32 random bytes (length cannot establish entropy), or a password record
 * from hashPassword. With an id (a non-secret name of the caller's config), a response on the Mac carries the
 * X-Sage-Board header: the id, this process's pid and the time the listener started, so the board command can tell
 * which board answers on the port.
 */
export function createBoardServer({ sources, secret, password, port = 43123, allowedHosts = [], id } = {}) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new TypeError("board port must be an integer from 1024 through 65535");
  if (password !== undefined ? !validPasswordRecord(password) || secret !== undefined : typeof secret !== "string" || !/^[!-~]{32,1024}$/.test(secret)) throw new TypeError("board needs a secret of 32 to 1024 printable ASCII bytes, or a valid password record instead");
  if (!Array.isArray(sources) || !sources.length || sources.length > 32) throw new TypeError("board needs 1 to 32 explicit sources");
  const ids = new Set();
  const configured = Array.from(sources, source => {
    if (!source || !own(source, "id") || !own(source, "path") || typeof source.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(source.id) || ids.has(source.id) || typeof source.path !== "string" || !isAbsolute(source.path) || resolve(source.path) !== source.path) throw new TypeError("board sources need unique ids and absolute normalized paths");
    for (const key of ["label", "provider"]) if (own(source, key) && (typeof source[key] !== "string" || source[key].length > 160 || /[\x00-\x1f\x7f]/.test(source[key]))) throw new TypeError("invalid board source label");
    ids.add(source.id);
    return Object.freeze({ id: source.id, path: source.path, ...(own(source, "label") ? { label: source.label } : {}), ...(own(source, "provider") ? { provider: source.provider } : {}) });
  });
  if (!Array.isArray(allowedHosts) || allowedHosts.length > 32) throw new TypeError("invalid allowed board hosts");
  if (id !== undefined && (typeof id !== "string" || !/^[a-f0-9]{16,64}$/.test(id))) throw new TypeError("the board id must be 16 to 64 lowercase hex characters");
  const local = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const hosts = new Set([...local, ...Array.from(allowedHosts, authority)]);
  const origins = new Map([...hosts].map(host => [host, new URL(`${local.has(host) ? "http" : "https"}://${host}`).origin]));
  const expected = digest(`sage:${secret ?? randomBytes(32).toString("base64url")}`);
  let remembered = null; // the digest of the last sign-in that passed the scrypt check, so a page's next requests cost no scrypt
  let checking = false; // one password check at a time: scrypt is slow on purpose, and the delay after a wrong one counts too
  let boardHeader = null;
  const watchers = new Map(), watchErrors = new Map(), clients = new Set();
  let model, lastGood, revision = 0, refreshTimer, boundaryTimer, settleTimer, startPromise, closePromise, closed = false;

  /** true, false, or "busy" while another password check runs. */
  async function authenticated(request) {
    const value = oneHeader(request, "authorization");
    if (typeof value !== "string" || value.length > 2048) return false;
    const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match) return false;
    const decoded = Buffer.from(match[1], "base64");
    if (decoded.toString("base64") !== match[1]) return false;
    if (!password) return timingSafeEqual(digest(decoded), expected);
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

  /** On the Mac itself: a loopback peer, a loopback Host, and no header that a proxy adds. */
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

  function htmlFor(key) {
    const html = renderBoardHtml(model, { taskKey: key, snapshot: false, live: true });
    if (Buffer.byteLength(html) > MAX_HTML) throw new RangeError("board rendering exceeds the size limit");
    return html;
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
      const payload = { revision: String(revision), html: htmlFor(client.task), stale: model.stale, diagnostics: model.diagnostics };
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
    const add = (path, recursive, child = null) => {
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("watch directory is unavailable");
      const key = `${recursive ? "tree" : "parent"}:${path}`;
      const plan = plans.get(key) ?? { key, path, recursive, identity: `${info.dev}:${info.ino}`, children: new Set() };
      if (child) plan.children.add(child);
      plans.set(key, plan);
    };
    for (const source of configured) {
      try { add(source.path, true); } catch {}
      let ancestor = dirname(source.path);
      for (;;) {
        try { add(ancestor, false, source.path.slice(ancestor.length + (ancestor.endsWith(sep) ? 0 : 1)).split(sep)[0]); break; }
        catch { const parent = dirname(ancestor); if (parent === ancestor) break; ancestor = parent; }
      }
    }
    return plans;
  }

  function reconcileWatchers() {
    const plans = watchPlans(), first = revision === 0;
    let added = false;
    for (const [key, item] of watchers) if (!plans.has(key) || plans.get(key).identity !== item.plan.identity) { item.watcher.close(); watchers.delete(key); }
    for (const [key] of watchErrors) if (!plans.has(key)) watchErrors.delete(key);
    for (const [key, plan] of plans) {
      if (watchers.has(key)) { watchers.get(key).plan = plan; continue; }
      if (watchErrors.has(key)) continue;
      try {
        const item = { plan, watcher: null };
        item.watcher = watch(plan.path, { recursive: plan.recursive }, (_event, filename) => {
          if (!item.plan.recursive && filename && !item.plan.children.has(String(filename).split(sep)[0])) return;
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
    // A new watcher misses the changes made while it starts, for example the files of a logbook just created. One more
    // read, once it has settled, sees them. This is one read per new watcher, not polling.
    if (added && !first) { clearTimeout(settleTimer); settleTimer = setTimeout(schedule, 250); settleTimer.unref(); }
  }

  function refresh() {
    if (closed) return;
    clearTimeout(boundaryTimer);
    let next;
    try {
      reconcileWatchers();
      // A root that does not exist is not set up yet (an owner may use only one provider): a quiet note, not a failure.
      const read = readBoardSources(configured), notSetUp = [];
      for (const [index, source] of read.entries()) {
        if (lstatSync(configured[index].path, { throwIfNoEntry: false })) continue;
        source.diagnostics = source.diagnostics.filter(message => message !== "ENOENT");
        notSetUp.push(source.label);
      }
      next = { ...buildBoardModel(read), notSetUp };
      next.diagnostics = [...next.diagnostics, ...watchErrors.values()];
      // Validate the complete HTML before replacing a good snapshot.
      const preview = renderBoardHtml(next, { snapshot: false, live: true });
      if (Buffer.byteLength(preview) > MAX_HTML) throw new RangeError("board rendering exceeds the size limit");
    } catch { next = { ...buildBoardModel([]), diagnostics: unavailable }; }
    if (!next.diagnostics.length) { lastGood = next; model = { ...next, stale: false }; }
    else model = { ...(lastGood ?? next), stale: true, diagnostics: next.diagnostics, notSetUp: next.notSetUp };
    revision++;
    for (const client of clients) publish(client);
    // A clock boundary changes the seven-day column; this never polls files on an interval.
    const now = Date.now(), boundary = model.tasks.reduce((first, task) => {
      const at = task.completedAt === null ? NaN : task.completedAt + 7 * 86400000 + 1;
      return Number.isFinite(at) && at > now ? Math.min(first, at) : first;
    }, Infinity);
    if (Number.isFinite(boundary)) { boundaryTimer = setTimeout(schedule, Math.min(boundary - now, 2_147_483_647)); boundaryTimer.unref(); }
  }

  const server = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    securityHeaders(response);
    const fail = (status, text) => { response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }); response.end(request.method === "HEAD" ? undefined : `${text}\n`); };
    if (!browserBoundary(request)) return fail(403, "This request is not permitted.");
    // The owner's decision (T216): on the Mac itself the board needs no sign-in. Every other request signs in: also one
    // that tailscale serve forwards, which reaches the loopback listener from 127.0.0.1, maybe with a loopback Host.
    if (onMac(request)) { if (boardHeader) response.setHeader("X-Sage-Board", boardHeader); }
    else {
      const signedIn = await authenticated(request);
      if (signedIn === "busy") { response.setHeader("Retry-After", "1"); return fail(429, "Another sign-in is being checked. Try again in a second."); }
      if (!signedIn) { response.setHeader("WWW-Authenticate", 'Basic realm="Sage board", charset="UTF-8"'); return fail(401, "Sign in to the Sage board."); }
    }
    if (!["GET", "HEAD"].includes(request.method)) { response.setHeader("Allow", "GET, HEAD"); return fail(405, "This method is not permitted."); }
    const selected = route(request.url);
    if (!selected || selected.task && !model.tasks.some(task => task.key === selected.task)) return fail(404, "This board page does not exist.");
    if (selected.events) {
      if (clients.size >= MAX_CLIENTS && request.method !== "HEAD") return fail(503, "There are too many open board streams.");
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" });
      if (request.method === "HEAD") return response.end();
      response.flushHeaders();
      const client = { response, task: selected.task, blocked: false, pending: null, deadline: null };
      clients.add(client); response.once("close", () => removeClient(client)); publish(client);
      return;
    }
    try {
      const html = htmlFor(selected.task);
      securityHeaders(response, html);
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
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
        // The first watchers settle before the listener opens: the second read sees what changed while they started.
        settleTimer = setTimeout(() => {
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
      clearTimeout(refreshTimer); clearTimeout(boundaryTimer); // a pending start's settle timer ends that start
      for (const client of clients) { client.response.destroy(); removeClient(client); }
      closePromise = (async () => {
        if (startPromise) await startPromise.catch(() => {});
        if (server.listening) { server.closeAllConnections(); await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept())); }
      })();
      return closePromise;
    },
  });
}
