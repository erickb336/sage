import "./test-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { createServer } from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoardServer, hashPassword } from "../packages/sage-board/server.mjs";

const HEADERS = {
  tasks: "id title size risk route state branch pr round keys",
  runs: "id task role round candidate branch status tokens report started ended",
  findings: "task key round source severity summary triage reason status",
  ledger: "task pr sha kind cycle run at",
  gates: "id task question options recommendation default answer at",
  decisions: "at task decision why",
};
const key = Buffer.from("sample/project-abcdef/T1").toString("base64url");
const row = (title = "Sample first task", id = "T1", state = "framed") => `${id}\t${title}\tsmall\t\tbuild\t${state}\tcodex/sample\t\t0\t\n`;
const tasks = (...rows) => `${HEADERS.tasks.replaceAll(" ", "\t")}\n${rows.join("")}`;

function populate(root, title = "Sample first task") {
  const project = join(root, "project-abcdef"); mkdirSync(project, { recursive: true });
  for (const [name, header] of Object.entries(HEADERS)) writeFileSync(join(project, `${name}.tsv`), `${header.replaceAll(" ", "\t")}\n`);
  writeFileSync(join(project, "tasks.tsv"), tasks(row(title), row("Sample abandoned task", "T2", "abandoned")));
  return project;
}

// The production listener requires a fixed port. Reserve a free test port once, then use that exact port.
async function freePort() {
  const socket = createServer();
  await new Promise((accept, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", accept); });
  const port = socket.address().port;
  await new Promise((accept, reject) => socket.close(error => error ? reject(error) : accept()));
  return port;
}

// A sample password only, hashed once for the file: no test uses a real password.
const PASSWORD = "sample board pass 01", RECORD = await hashPassword(PASSWORD);

/** A board server on a free port. password: null is a board with no password set yet (T229). */
async function fixture(t, { missing = false, allowedHosts = [], password = RECORD, id, clock, before } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-server-")), root = join(dir, "source"), port = await freePort();
  if (!missing) populate(root);
  before?.(join(root, "project-abcdef")); // a change of the logbook before the first start
  const sources = [{ id: "sample", path: root, label: "Sample source" }];
  const server = createBoardServer({ sources, ...(password ? { password } : {}), port, allowedHosts, id, ...(clock ? { clock } : {}) });
  t.after(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); });
  await server.start();
  return { dir, root, project: join(root, "project-abcdef"), port, sources, server, authorization: `Basic ${Buffer.from(`sage:${PASSWORD}`).toString("base64")}` };
}

function read(f, path = "/", { method = "GET", headers = {}, rawHeaders } = {}) {
  return new Promise((accept, reject) => {
    const req = request({ host: "127.0.0.1", port: f.port, path, method, agent: false, headers: rawHeaders ?? { Host: `127.0.0.1:${f.port}`, Authorization: f.authorization, ...headers } }, response => {
      let body = ""; response.setEncoding("utf8"); response.on("data", chunk => body += chunk);
      response.on("end", () => accept({ status: response.statusCode, headers: response.headers, body }));
      response.on("error", reject);
    });
    req.on("error", reject); req.setTimeout(10_000, () => req.destroy(new Error("board request did not finish"))); req.end();
  });
}

function events(f, path = "/?events=1") {
  const queue = [], waiters = new Set();
  let response, buffer = "", ended = false;
  const stop = error => { ended = true; for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(error); } waiters.clear(); };
  const req = request({ host: "127.0.0.1", port: f.port, path, agent: false, headers: { Host: `127.0.0.1:${f.port}`, Authorization: f.authorization } }, incoming => {
    response = incoming;
    if (incoming.statusCode !== 200) { stop(new Error(`event status ${incoming.statusCode}`)); incoming.resume(); return; }
    incoming.setEncoding("utf8");
    incoming.on("data", chunk => {
      buffer += chunk;
      for (let end; (end = buffer.indexOf("\n\n")) !== -1;) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (!frame.includes("event: board\n")) continue;
        try {
          const payload = JSON.parse(frame.split("\n").find(line => line.startsWith("data: ")).slice(6));
          let consumed = false;
          for (const waiter of waiters) if (waiter.predicate(payload)) { consumed = true; clearTimeout(waiter.timer); waiters.delete(waiter); waiter.accept(payload); }
          if (!consumed) queue.push(payload);
        } catch (error) { stop(error); }
      }
    });
    incoming.on("error", stop); incoming.on("end", () => stop(new Error("event stream ended")));
  });
  req.on("error", stop); req.end();
  return {
    next(predicate = () => true) {
      const index = queue.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      if (ended) return Promise.reject(new Error("event stream is closed"));
      return new Promise((accept, reject) => {
        const waiter = { accept, reject, predicate, timer: null };
        // A generous deadlock guard, not a latency or performance assertion.
        waiter.timer = setTimeout(() => { waiters.delete(waiter); reject(new Error("no matching board event")); }, 10_000);
        waiters.add(waiter);
      });
    },
    close() { req.destroy(); response?.destroy(); stop(new Error("event test closed")); },
  };
}

test("board server serves authenticated pages and HEAD with exact CSP hashes and no data writes", async t => {
  const f = await fixture(t), file = join(f.project, "tasks.tsv"), before = readFileSync(file);
  const page = await read(f);
  assert.equal(page.status, 200); assert.match(page.body, /Sample first task/); assert.match(page.body, /new EventSource/);
  assert.equal(f.server.address().address, "127.0.0.1"); assert.equal(f.server.address().port, f.port);
  assert.equal(page.headers["cache-control"], "no-store"); assert.equal(page.headers["x-content-type-options"], "nosniff");
  assert.equal(page.headers["referrer-policy"], "no-referrer"); assert.equal(page.headers["access-control-allow-origin"], undefined);
  for (const tag of ["script", "style"]) for (const [, content] of page.body.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "g"))) {
    assert.ok(page.headers["content-security-policy"].includes(`'sha256-${createHash("sha256").update(content).digest("base64")}'`));
  }
  assert.doesNotMatch(page.headers["content-security-policy"], /unsafe-inline|https:/);
  assert.match(page.headers["content-security-policy"], /frame-ancestors 'none'/);
  const head = await read(f, "/", { method: "HEAD" }); assert.equal(head.status, 200); assert.equal(head.body, ""); assert.equal(head.headers["content-length"], page.headers["content-length"]);
  const detail = await read(f, `/task/${key}`); assert.equal(detail.status, 200); assert.match(detail.body, /class="detail"/); assert.doesNotMatch(detail.body, /Sample abandoned task/);
  const hidden = Buffer.from("sample/project-abcdef/T2").toString("base64url");
  assert.match((await read(f, `/task/${hidden}`)).body, /Sample abandoned task/);
  assert.deepEqual(readFileSync(file), before);
});

test("board server authenticates every page and event route through an allowed host, with no credential or source disclosure", async t => {
  const tailnet = "sample.tailnet.ts.net", f = await fixture(t, { allowedHosts: [tailnet] });
  for (const path of ["/", `/task/${key}`, "/?events=1", `/?events=1&task=${key}`]) {
    for (const authorization of [undefined, `Basic ${Buffer.from(`wrong:${PASSWORD}`).toString("base64")}`, `Basic ${Buffer.from("sage:wrong").toString("base64")}`]) {
      const result = await read(f, path, { rawHeaders: ["Host", tailnet, ...(authorization ? ["Authorization", authorization] : [])] });
      assert.equal(result.status, 401); assert.match(result.headers["www-authenticate"], /^Basic /);
      assert.doesNotMatch(result.body, /Sample first task/); assert.ok(!result.body.includes(f.root)); assert.ok(!result.body.includes(PASSWORD));
    }
  }
  const duplicate = await read(f, "/", { rawHeaders: ["Host", tailnet, "Authorization", f.authorization, "Authorization", f.authorization] });
  assert.equal(duplicate.status, 401);
  const signed = await read(f, "/", { rawHeaders: ["Host", tailnet, "Authorization", f.authorization] });
  assert.equal(signed.status, 200); assert.match(signed.body, /Sample first task/);
  const eventHead = await read(f, "/?events=1", { method: "HEAD" }); assert.equal(eventHead.status, 200); assert.equal(eventHead.body, "");
});

test("T216: on the Mac itself (a loopback Host) the board needs no sign-in, and the browser checks still hold", async t => {
  const f = await fixture(t, { allowedHosts: ["sample.tailnet.ts.net"] });
  for (const host of [`127.0.0.1:${f.port}`, `localhost:${f.port}`, `LOCALHOST:${f.port}`, `[::1]:${f.port}`]) {
    const page = await read(f, "/", { rawHeaders: ["Host", host] });
    assert.equal(page.status, 200, host); assert.match(page.body, /Sample first task/); assert.equal(page.headers["www-authenticate"], undefined);
  }
  assert.equal((await read(f, `/task/${key}`, { rawHeaders: ["Host", `127.0.0.1:${f.port}`] })).status, 200);
  assert.equal((await read(f, "/?events=1", { method: "HEAD", rawHeaders: ["Host", `127.0.0.1:${f.port}`] })).status, 200);
  for (const extra of [["Origin", "https://attacker.test"], ["Origin", "https://sample.tailnet.ts.net"], ["Sec-Fetch-Site", "cross-site"]]) {
    const refused = await read(f, "/", { rawHeaders: ["Host", `127.0.0.1:${f.port}`, ...extra] });
    assert.equal(refused.status, 403, extra.join(": ")); assert.doesNotMatch(refused.body, /Sample first task/);
  }
  for (const host of ["attacker.test", `127.0.0.1:${f.port + 1}`, `localhost`]) assert.equal((await read(f, "/", { rawHeaders: ["Host", host] })).status, 403, host);
  assert.equal((await read(f, "/", { method: "POST", rawHeaders: ["Host", `127.0.0.1:${f.port}`] })).status, 405);
});

test("T216, T229: a request that a private HTTPS tunnel forwards signs in, also with a loopback Host (probe 4)", async t => {
  // A tunnel such as tailscale serve connects from 127.0.0.1, keeps the client's Host and adds X-Forwarded-For.
  const f = await fixture(t, { allowedHosts: ["sample.tailnet.ts.net"], id: "0123456789abcdef" });
  const loopback = `127.0.0.1:${f.port}`;
  for (const proxy of [["X-Forwarded-For", "100.64.0.7"], ["X-Forwarded-Host", loopback], ["X-Forwarded-Proto", "https"], ["Forwarded", "for=100.64.0.7"]]) {
    const proxied = await read(f, "/", { rawHeaders: ["Host", loopback, ...proxy] });
    assert.equal(proxied.status, 401, proxy[0]); assert.doesNotMatch(proxied.body, /Sample first task/);
    assert.equal(proxied.headers["x-sage-board"], undefined, "a proxied request does not learn the board's pid");
    const signed = await read(f, "/", { rawHeaders: ["Host", loopback, ...proxy, "Authorization", f.authorization] });
    assert.equal(signed.status, 200, proxy[0]);
  }
  const mac = await read(f, "/", { rawHeaders: ["Host", loopback] });
  assert.equal(mac.status, 200);
  assert.match(mac.headers["x-sage-board"], new RegExp(`^id=0123456789abcdef; pid=${process.pid}; started=\\d+$`));
});

test("R1069-2: the checkout's full path is a search term only on the Mac's own page; a tunnel viewer gets none", async t => {
  const f = await fixture(t, { allowedHosts: ["sample.tailnet.ts.net"] }), checkout = join(f.dir, "work", "sample-checkout-folder");
  mkdirSync(checkout, { recursive: true }); writeFileSync(join(f.project, "checkout.txt"), `${checkout}\n`);
  const loopback = `127.0.0.1:${f.port}`;
  // The board reads the logbooks again on a file event; wait until the Mac's page names the checkout's folder.
  let mac;
  for (let i = 0; i < 100 && !(mac = await read(f, "/", { rawHeaders: ["Host", loopback] })).body.includes("folder sample-checkout-folder"); i++) await new Promise(wake => setTimeout(wake, 50));
  assert.ok(mac.body.includes(checkout), "the Mac's own page can search by the path");
  for (const raw of [["Host", loopback, "X-Forwarded-For", "100.64.0.7", "Authorization", f.authorization], ["Host", "sample.tailnet.ts.net", "Authorization", f.authorization]]) {
    const remote = await read(f, "/", { rawHeaders: raw });
    assert.equal(remote.status, 200);
    assert.ok(remote.body.includes("folder sample-checkout-folder") && !remote.body.includes(checkout), raw.join(" "));
  }
});

test("T229: a generic proxy that adds only X-Forwarded-For needs the password, and the board knows no vendor's headers", async t => {
  const f = await fixture(t, { id: "0123456789abcdef" }), loopback = `127.0.0.1:${f.port}`;
  // A proxy of any vendor: a loopback peer, a loopback Host and one X-Forwarded-For header, nothing else.
  const proxied = await read(f, "/", { rawHeaders: ["Host", loopback, "X-Forwarded-For", "203.0.113.9"] });
  assert.equal(proxied.status, 401); assert.match(proxied.headers["www-authenticate"], /^Basic realm="Sage board"/); assert.doesNotMatch(proxied.body, /Sample first task/);
  assert.equal((await read(f, "/", { rawHeaders: ["Host", loopback, "X-Forwarded-For", "203.0.113.9", "Authorization", f.authorization] })).status, 200);
  // A header name of one vendor is no proxy sign: the board does not depend on Tailscale (least coupling).
  const vendor = await read(f, "/", { rawHeaders: ["Host", loopback, "Tailscale-User-Login", "sample@example.test"] });
  assert.equal(vendor.status, 200); assert.match(vendor.headers["x-sage-board"], /^id=0123456789abcdef; /);
});

test("T229: with no password set, every request that is not the Mac path gets 403 with a fixed text that names no path", async t => {
  const tailnet = "sample.tailnet.ts.net", f = await fixture(t, { allowedHosts: [tailnet], password: null }), loopback = `127.0.0.1:${f.port}`;
  const text = "Access from outside this Mac is off until the owner sets a board password on the Mac.\n";
  for (const rawHeaders of [["Host", tailnet], ["Host", tailnet, "Authorization", f.authorization], ["Host", loopback, "X-Forwarded-For", "203.0.113.9"], ["Host", loopback, "Forwarded", "for=203.0.113.9"], ["Host", loopback, "X-Forwarded-Proto", "https", "Authorization", f.authorization]]) {
    for (const path of ["/", `/task/${key}`, "/?events=1"]) {
      const refused = await read(f, path, { rawHeaders });
      assert.equal(refused.status, 403, rawHeaders.join(" ")); assert.equal(refused.body, text);
      assert.equal(refused.headers["www-authenticate"], undefined, "no sign-in dialog: no password can pass");
    }
  }
  const mac = await read(f, "/", { rawHeaders: ["Host", loopback] });
  assert.equal(mac.status, 200); assert.match(mac.body, /Sample first task/);
});

test("T216: the server checks one password at a time and waits after a wrong one", async t => {
  const tailnet = "sample.tailnet.ts.net", f = await fixture(t, { allowedHosts: [tailnet], password: await hashPassword("sample board pass 01") });
  const as = password => ["Host", tailnet, "Authorization", `Basic ${Buffer.from(`sage:${password}`).toString("base64")}`];
  const began = Date.now();
  const [first, second] = await Promise.all([read(f, "/", { rawHeaders: as("sample wrong pass 1") }), read(f, "/", { rawHeaders: as("sample wrong pass 2") })]);
  assert.deepEqual([first.status, second.status].sort(), [401, 429]);
  const busy = first.status === 429 ? first : second;
  assert.equal(busy.headers["retry-after"], "1"); assert.doesNotMatch(busy.body, /Sample first task/);
  // A lower bound only: the fixed one-second delay after a wrong password can make a reply later, never sooner.
  assert.ok(Date.now() - began >= 900, "a wrong password waits");
  assert.equal((await read(f, "/", { rawHeaders: as("sample board pass 01") })).status, 200, "the check is free again after the delay");
});

test("board server rejects foreign, duplicate and mismatched browser authority headers", async t => {
  const f = await fixture(t, { allowedHosts: ["sample.tailnet.ts.net"] });
  for (const headers of [
    { Host: "attacker.test" }, { Host: `localhost:${f.port}.attacker.test` }, { Host: `127.0.0.1:${f.port}.` },
    { Origin: "https://attacker.test" }, { Origin: "null" }, { Origin: "https://sample.tailnet.ts.net" },
    { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" },
  ]) assert.equal((await read(f, "/", { headers })).status, 403);
  for (const name of ["Host", "Origin", "Sec-Fetch-Site"]) {
    const value = name === "Host" ? `127.0.0.1:${f.port}` : name === "Origin" ? `http://127.0.0.1:${f.port}` : "same-origin";
    const headers = ["Authorization", f.authorization, ...(name === "Host" ? [] : ["Host", `127.0.0.1:${f.port}`]), name, value, name, value];
    assert.equal((await read(f, "/", { rawHeaders: headers })).status, 403);
  }
  assert.equal((await read(f, "/", { headers: { Origin: `http://127.0.0.1:${f.port}`, "Sec-Fetch-Site": "same-origin" } })).status, 200);
  assert.equal((await read(f, "/", { headers: { Host: "sample.tailnet.ts.net", Origin: "https://sample.tailnet.ts.net", "Sec-Fetch-Site": "same-origin" } })).status, 200);
});

/** A hook slot of the sample project (T308): one empty file per mark, as sage-hook.mjs writes it. */
function slot(root, name, marks) {
  const dir = join(root, ".hooks", "slots", name); mkdirSync(dir, { recursive: true });
  for (const mark of [...marks, "ok"]) writeFileSync(join(dir, mark), "");
}

test("T308: the Agents page is a route with the same sign-in, CSP and browser checks; its stream follows the hook's slots", async t => {
  const f = await fixture(t, { allowedHosts: ["sample.tailnet.ts.net"] }), loopback = `127.0.0.1:${f.port}`;
  writeFileSync(join(f.project, "runs.tsv"), `${HEADERS.runs.replaceAll(" ", "\t")}\nR1\tT1\tqa\t0\t\t\trunning\t\t\t${new Date(Date.now() - 60_000).toISOString()}\t\n`);
  slot(f.root, "slot-1", ["project-project", "role-sage_qa", "run-R1"]);
  let mac;
  for (let i = 0; i < 100 && !(mac = await read(f, "/agents", { rawHeaders: ["Host", loopback] })).body.includes("Sample first task"); i++) await new Promise(wake => setTimeout(wake, 50));
  assert.equal(mac.status, 200); assert.equal(mac.headers["www-authenticate"], undefined, "no sign-in on the Mac");
  assert.match(mac.body, /<a href="\/agents" aria-current="page">Agents \(1\)<\/a>/); assert.match(mac.body, /<span class="role">qa<\/span><span class="id">R1<\/span>/);
  assert.match(mac.body, /new EventSource\("\/agents\?events=1"\)/);
  for (const [tag, content] of [...mac.body.matchAll(/<(script|style)>([\s\S]*?)<\/\1>/g)].map(m => [m[1], m[2]])) assert.ok(mac.headers["content-security-policy"].includes(`'sha256-${createHash("sha256").update(content).digest("base64")}'`), tag);
  // The task board names the page with its count.
  assert.match((await read(f, "/", { rawHeaders: ["Host", loopback] })).body, /<a href="\/" aria-current="page">Task board<\/a><a href="\/programs">Programs<\/a><a href="\/agents">Agents \(1\)<\/a>/);
  // Away from the Mac, the page and its stream need the password.
  for (const path of ["/agents", "/agents?events=1"]) {
    const refused = await read(f, path, { rawHeaders: ["Host", "sample.tailnet.ts.net"] });
    assert.equal(refused.status, 401, path); assert.doesNotMatch(refused.body, /Sample first task/);
    assert.equal((await read(f, path, { rawHeaders: ["Host", loopback, "X-Forwarded-For", "100.64.0.7"] })).status, 401, path);
    assert.equal((await read(f, path, { method: "HEAD", rawHeaders: ["Host", "sample.tailnet.ts.net", "Authorization", f.authorization] })).status, 200, path);
    assert.equal((await read(f, path, { rawHeaders: ["Host", loopback, "Origin", "https://attacker.test"] })).status, 403, path);
  }
  for (const path of ["/agents/", "/agents?events=1&task=x", "/agents?x=1", "/Agents"]) assert.equal((await read(f, path)).status, 404, path);
  // The stream sends the Agents page, and a new slot of the hook sends the page again with it.
  const stream = events(f, "/agents?events=1"); t.after(() => stream.close());
  assert.match((await stream.next()).html, /Agents \(1\)/);
  writeFileSync(join(f.project, "runs.tsv"), `${readFileSync(join(f.project, "runs.tsv"), "utf8")}R2\tT1\tcode-reviewer\t0\t\t\trunning\t\t\t${new Date().toISOString()}\t\n`);
  slot(f.root, "slot-2", ["project-project", "role-sage_code-reviewer", "run-R2"]);
  const next = await stream.next(p => p.html.includes("Agents (2)"));
  assert.match(next.html, /<span class="role">code-reviewer<\/span><span class="id">R2<\/span>/); assert.doesNotMatch(next.html, /class="board"/);
});

test("board server exposes only canonical read routes and refuses invalid configuration", async t => {
  const f = await fixture(t);
  for (const path of ["/tasks.tsv", "/../config.json", "/%2e%2e/config.json", "/?events=1&events=1", "/?events=1&other=x", `/?events=1&task=${key}&task=${key}`, `/?task=${key}&events=1`, `/task/${key}=`, "/task/_w", `/task/${Buffer.from("missing").toString("base64url")}`, "/task/YR"]) {
    const result = await read(f, path); assert.equal(result.status, 404, path); assert.doesNotMatch(result.body, /Sample first task/);
  }
  assert.equal((await read(f, "/", { method: "POST" })).status, 405);
  const options = { sources: f.sources, password: RECORD, port: f.port };
  for (const changed of [{ password: { ...RECORD, scheme: "plain" } }, { password: { ...RECORD, hash: "short" } }, { port: 0 }, { sources: [] }, { sources: Array(1) }, { sources: [{ id: 2, path: f.root }] }, { sources: [{ id: "one", path: f.root, label: {} }] }, { allowedHosts: ["127.1"] }, { allowedHosts: ["name."] }, { allowedHosts: ["https://host"] }, { allowedHosts: Array(1) }]) assert.throws(() => createBoardServer({ ...options, ...changed }), TypeError);
});

test("board server fails on an occupied fixed port and closes without changing another listener", async t => {
  const f = await fixture(t), other = createBoardServer({ sources: f.sources, password: RECORD, port: f.port });
  t.after(() => other.close());
  await assert.rejects(other.start(), { code: "EADDRINUSE" });
  assert.equal((await read(f)).status, 200);
  assert.deepEqual(await f.server.start(), f.server.address());
  await Promise.all([f.server.close(), f.server.close()]); assert.equal(f.server.address(), null);
  await assert.rejects(f.server.start(), /closed/);
});

test("board event streams deliver initial and atomic file updates for the selected page and reconnect", async t => {
  const f = await fixture(t), board = events(f), task = events(f, `/?events=1&task=${key}`);
  t.after(() => { board.close(); task.close(); });
  const first = await board.next(), firstTask = await task.next();
  assert.equal(first.stale, false); assert.deepEqual(first.diagnostics, []); assert.match(first.html, /class="board"/);
  assert.match(firstTask.html, /class="detail"/); assert.match(firstTask.html, /Agent runs/);
  const temporary = join(f.project, "tasks.pending"), target = join(f.project, "tasks.tsv");
  writeFileSync(temporary, tasks(row("Sample replaced title"))); renameSync(temporary, target);
  const updated = await board.next(p => p.html.includes("Sample replaced title") && !p.stale);
  const updatedTask = await task.next(p => p.html.includes("Sample replaced title") && !p.stale);
  assert.ok(Number(updated.revision) > Number(first.revision)); assert.match(updatedTask.html, /class="detail"/);
  const reconnect = events(f); t.after(() => reconnect.close());
  const snapshot = await reconnect.next(); assert.equal(snapshot.revision, updated.revision); assert.match(snapshot.html, /Sample replaced title/);
});

test("T305 R1023-3: a file event that does not change the page sends nothing; the next change sends the new page", async t => {
  // A fixed clock, so the page's built time does not change between the two refreshes.
  const f = await fixture(t, { clock: () => "2026-10-18T12:00:00Z" }), stream = events(f); t.after(() => stream.close());
  const first = await stream.next(); assert.match(first.html, /Sample first task/);
  writeFileSync(join(f.project, "unrelated.txt"), "sample\n");
  // Time for the watcher and its 20 ms debounce. A slower machine merges the two events, so the test still passes; it
  // can never fail for time. On the old server this file event alone sent the same page again.
  await new Promise(wake => setTimeout(wake, 1000));
  const temporary = join(f.project, "tasks.pending"); writeFileSync(temporary, tasks(row("Sample changed title"))); renameSync(temporary, join(f.project, "tasks.tsv"));
  const next = await stream.next();
  assert.match(next.html, /Sample changed title/, "the next event is the change, not a copy of the page");
});

test("board event streams keep the last valid content while an incomplete write is stale, then recover", async t => {
  const f = await fixture(t), stream = events(f); t.after(() => stream.close());
  const initial = await stream.next(); assert.equal(initial.stale, false);
  const file = join(f.project, "tasks.tsv"); writeFileSync(file, "incomplete header\nprivate partial data\n");
  const stale = await stream.next(p => p.stale);
  assert.match(stale.html, /Sample first task/); assert.doesNotMatch(stale.html, /private partial data/);
  assert.ok(stale.diagnostics.some(d => /tasks/.test(d.message))); assert.ok(Number(stale.revision) > Number(initial.revision));
  const page = await read(f); assert.match(page.body, /Sample first task/); assert.match(page.body, /Incomplete sources/);
  writeFileSync(file, tasks(row("Sample repaired title")));
  const repaired = await stream.next(p => !p.stale && p.html.includes("Sample repaired title")); assert.deepEqual(repaired.diagnostics, []);
});

test("R1506-F1: a table written in place after an earlier rename onto it still updates the board, on Linux too", async t => {
  // Node's recursive fs.watch on Linux (24.21) watched each file's inode. After the rename, the path's watch stayed on the
  // old inode and its folder's event named a known file, so the in-place writes below sent nothing (CI run 40140060375).
  const f = await fixture(t), stream = events(f); t.after(() => stream.close());
  assert.equal((await stream.next()).stale, false);
  const target = join(f.project, "tasks.tsv"), temporary = join(f.project, "tasks.pending");
  writeFileSync(temporary, tasks(row("Sample renamed title"))); renameSync(temporary, target);
  await stream.next(p => !p.stale && p.html.includes("Sample renamed title"));
  writeFileSync(target, "Sample invalid table header\nSample incomplete write\n");
  const stale = await stream.next(p => p.stale);
  assert.match(stale.html, /Sample renamed title/); assert.doesNotMatch(stale.html, /Sample incomplete write/);
  writeFileSync(target, tasks(row("Sample written in place")));
  await stream.next(p => !p.stale && p.html.includes("Sample written in place"));
});

test("T314 R1042-2: a bad name or archived value in a logbook's config.json is a warning: the board stays live and shows the warning", async t => {
  const f = await fixture(t), stream = events(f); t.after(() => stream.close());
  const initial = await stream.next(); assert.equal(initial.stale, false);
  writeFileSync(join(f.project, "config.json"), JSON.stringify({ name: "bad\ttab", archived: "yes" }));
  writeFileSync(join(f.project, "tasks.tsv"), tasks(row("Sample title after the bad config")));
  const live = await stream.next(p => p.html.includes("Sample title after the bad config"));
  assert.equal(live.stale, false); assert.deepEqual(live.diagnostics, []);
  assert.match(live.html, /<b>Settings ignored\.<\/b>.*<li>sample · sample\/project-abcdef · config: the name has a control, format or hidden character [^<]*<\/li><li>sample · sample\/project-abcdef · config: archived is not true or false<\/li>/);
  assert.doesNotMatch(live.html, /Incomplete sources/);
});

test("F-T216-19: a root that appears while the board starts does not stop the start, and close ends", async t => {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-server-")), root = join(dir, "source"), port = await freePort();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const server = createBoardServer({ sources: [{ id: "sample", path: root, label: "Sample source" }], port });
  // A generous deadlock guard, not a latency assertion: before the fix, start never settled.
  const within = (promise, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not finish`)), 10_000).unref())]);
  const started = server.start();
  await new Promise(wake => setTimeout(wake, 30));
  populate(root);
  try { assert.equal((await within(started, "start")).port, port); }
  finally { await within(server.close(), "close"); }
  assert.equal(server.address(), null);
});

test("board watches a missing root and reattaches after root replacement without polling", async t => {
  const f = await fixture(t, { missing: true }), stream = events(f); t.after(() => stream.close());
  // T216: a root that does not exist is not set up yet (an owner who uses one provider only): a quiet note, no failure.
  const missing = await stream.next(); assert.equal(missing.stale, false); assert.deepEqual(missing.diagnostics, []);
  assert.match(missing.html, /Not set up yet: Sample source\./); assert.doesNotMatch(missing.html, /Incomplete sources/);
  const page = await read(f); assert.match(page.body, /Not set up yet: Sample source\./); assert.doesNotMatch(page.body, /Incomplete sources/);
  populate(f.root, "Sample created source");
  const created = await stream.next(p => !p.stale && p.html.includes("Sample created source")); assert.doesNotMatch(created.html, /Not set up yet/);
  const old = join(f.dir, "old-source"); renameSync(f.root, old);
  const removed = await stream.next(p => p.html.includes("Not set up yet")); assert.equal(removed.stale, false); assert.deepEqual(removed.diagnostics, []);
  populate(f.root, "Sample replacement source");
  await stream.next(p => !p.stale && p.html.includes("Sample replacement source"));
  writeFileSync(join(f.project, "tasks.tsv"), tasks(row("Sample replacement changed")));
  await stream.next(p => !p.stale && p.html.includes("Sample replacement changed"));
});

test("board watcher errors publish a stale diagnostic and recover on an observed root change", async t => {
  const original = fs.watch, captured = [];
  fs.watch = (...args) => { const watcher = original(...args); captured.push({ path: args[0], watcher }); return watcher; };
  syncBuiltinESMExports();
  let f;
  try { f = await fixture(t); } finally { fs.watch = original; syncBuiltinESMExports(); }
  const stream = events(f); t.after(() => stream.close()); await stream.next();
  const root = captured.find(item => item.path === f.root); assert.ok(root);
  root.watcher.emit("error", new Error("sample watcher failure"));
  const stale = await stream.next(p => p.stale && p.diagnostics.some(d => /File watching/.test(d.message)));
  assert.match(stale.html, /Sample first task/); assert.doesNotMatch(stale.html, /sample watcher failure/);
  renameSync(f.root, join(f.dir, "old-source"));
  await stream.next(p => p.html.includes("Not set up yet: Sample source"));
  populate(f.root, "Sample watcher restored");
  await stream.next(p => !p.stale && p.html.includes("Sample watcher restored"));
});


test("a parent rename that names only the destination refreshes the missing board root", async t => {
  const original = fs.watch, captured = [];
  // Simulate the allowed rename notification with no old-name event. No real watcher delivers extra events.
  fs.watch = (path, callback) => {
    const watcher = new EventEmitter(); watcher.close = () => { watcher.closed = true; };
    captured.push({ path, callback, watcher });
    return watcher;
  };
  syncBuiltinESMExports();
  let f;
  try { f = await fixture(t); } finally { fs.watch = original; syncBuiltinESMExports(); }
  const stream = events(f); t.after(() => stream.close());
  await stream.next(p => !p.stale);
  renameSync(f.root, join(f.dir, "renamed-source"));
  const parent = captured.find(entry => entry.path === f.dir);
  assert.ok(parent);
  parent.callback("rename", "renamed-source");
  // T216: a missing root is a quiet note, not a stale board.
  const missing = await stream.next(p => p.html.includes("Not set up yet: Sample source"));
  assert.equal(missing.stale, false); assert.doesNotMatch(missing.html, /Sample first task/);
  populate(f.root, "Sample recreated source");
  parent.callback("rename", "source");
  await stream.next(p => !p.stale && p.html.includes("Sample recreated source"));
});

// T368 (T233 C9): the programs list and each program's page. SAMPLE DATA: one program of two tasks, its pilot merged.
function programs(project, goal = "Sample goal of PG1.", pilot = "Sample pilot") {
  writeFileSync(join(project, "tasks.tsv"), `${HEADERS.tasks.replaceAll(" ", "\t")}\twaits\tprogram\nT1\t${pilot}\tsmall\t\tbuild\tmerged\t\t\t0\t\t\tPG1\nT2\tSample second\tsmall\t\tbuild\tframed\t\t\t0\t\tT1\tPG1\n`);
  writeFileSync(join(project, "gates.tsv"), `${HEADERS.gates.replaceAll(" ", "\t")}\nG1\tT1\tApprove program PG1? No task builds before you approve.\tapprove|change|drop\tapprove\t\tapprove\t\n`);
  writeFileSync(join(project, "programs.tsv"), `id\tname\tgoal\tpilot\tgate\tat\nPG1\tSample program\t${goal}\tT1\tG1\t\n`);
}
const programKey = id => Buffer.from(`sample/project-abcdef/${id}`).toString("base64url");
async function until(f, path, text) {
  let page;
  for (let i = 0; i < 100 && !(page = await read(f, path)).body.includes(text); i++) await new Promise(wake => setTimeout(wake, 50));
  return page;
}

test("T368 C9: /programs and /program/KEY are routes with the same sign-in and CSP; an unknown key is the not-found page with 404; a bad key is 404", async t => {
  const f = await fixture(t, { allowedHosts: ["sample.tailnet.ts.net"] });
  programs(f.project);
  const list = await until(f, "/programs", "Sample program");
  assert.equal(list.status, 200); assert.match(list.headers["content-type"], /^text\/html/);
  assert.match(list.body, /<a href="\/programs" aria-current="page">Programs<\/a>/);
  assert.ok(list.body.includes(`<a class="prog" href="/program/${programKey("PG1")}">`) && list.body.includes("1 of 2 merged"));
  assert.match(list.body, /new EventSource\("\/programs\?events=1"\)/);
  for (const [tag, content] of [...list.body.matchAll(/<(script|style)>([\s\S]*?)<\/\1>/g)].map(m => [m[1], m[2]])) assert.ok(list.headers["content-security-policy"].includes(`'sha256-${createHash("sha256").update(content).digest("base64")}'`), tag);
  const page = await read(f, `/program/${programKey("PG1")}`);
  assert.equal(page.status, 200); assert.ok(page.body.includes("Sample goal of PG1.") && page.body.includes("<h1 class=\"ptitle\"><span aria-hidden=\"true\">◫</span> Sample program</h1>"), page.body.slice(-3000));
  // The board names the page, and the task page links its program.
  assert.match((await read(f, "/")).body, /<a href="\/" aria-current="page">Task board<\/a><a href="\/programs">Programs<\/a><a href="\/agents">Agents \(0\)<\/a>/);
  assert.ok((await read(f, `/task/${Buffer.from("sample/project-abcdef/T2").toString("base64url")}`)).body.includes(`<a class="back plink" href="/program/${programKey("PG1")}" title="Sample program">◫ <span class="cn">Sample program</span><span class="pid">PG1</span></a>`));
  const missing = await read(f, `/program/${programKey("PG9")}`);
  assert.equal(missing.status, 404); assert.match(missing.headers["content-type"], /^text\/html/); assert.ok(missing.body.includes("<b>No program PG9 on the board.</b>"));
  assert.equal((await read(f, `/program/${programKey("PG9")}`, { method: "HEAD" })).status, 404);
  assert.equal((await read(f, `/program/${programKey("PG9")}?events=1`)).status, 404, "no stream for an unknown program");
  for (const path of ["/program/", "/program/_w", `/program/${programKey("PG1")}=`, `/program/${programKey("PG1")}/`, `/program/${programKey("PG1")}?events=2`, "/programs/", "/programs?x=1", "/Programs", `/program/${Buffer.from("a\nb").toString("base64url")}`]) {
    const result = await read(f, path); assert.equal(result.status, 404, path); assert.doesNotMatch(result.body, /Sample program/, path);
  }
  // Away from the Mac, the pages and their streams need the password.
  for (const path of ["/programs", "/programs?events=1", `/program/${programKey("PG1")}`, `/program/${programKey("PG1")}?events=1`]) {
    const refused = await read(f, path, { rawHeaders: ["Host", "sample.tailnet.ts.net"] });
    assert.equal(refused.status, 401, path); assert.doesNotMatch(refused.body, /Sample program/);
    assert.equal((await read(f, path, { method: "HEAD", rawHeaders: ["Host", "sample.tailnet.ts.net", "Authorization", f.authorization] })).status, 200, path);
  }
  // The program's stream sends its page, and a change of the logbook sends it again.
  const stream = events(f, `/program/${programKey("PG1")}?events=1`); t.after(() => stream.close());
  assert.ok((await stream.next()).html.includes("Sample goal of PG1."));
  programs(f.project, "Sample changed goal.");
  assert.ok((await stream.next(p => p.html.includes("Sample changed goal."))).html.includes("Sample program"));
});

test("T368 C9: the size check covers the programs list: a goal that makes it too large keeps the last good board, marked stale", async t => {
  const f = await fixture(t);
  programs(f.project);
  await until(f, "/programs", "Sample goal of PG1.");
  // A logbook file is at most 4 MB, but each "<" of the goal is 4 bytes of HTML: the programs list passes 8 MB, the task board does not.
  programs(f.project, "<".repeat(3.9 * 1024 * 1024));
  const page = await until(f, "/programs", "The board snapshot is unavailable.");
  assert.ok(page.body.includes("The board snapshot is unavailable.") && page.body.includes("Sample goal of PG1.") && !page.body.includes("&lt;&lt;&lt;&lt;"), "the last good page, with the reason");
  assert.ok(Buffer.byteLength(page.body) < 8 * 1024 * 1024);
});

test("R1334-3, T383 items 15 and 16: a program page that is too large shows the programs list with a note, and keeps its stream; the rest of the board stays live", async t => {
  const f = await fixture(t);
  programs(f.project);
  const path = `/program/${programKey("PG1")}`;
  await until(f, path, "Sample pilot");
  const stream = events(f, `${path}?events=1`); t.after(() => stream.close());
  assert.equal((await stream.next()).stale, false);
  // The merged pilot T1 is not on the board, and the programs list does not name it; its program page lists it, and each "<" is 4 bytes of HTML.
  programs(f.project, "Sample changed goal.", "<".repeat(3.9 * 1024 * 1024));
  const page = await until(f, path, "too large to show");
  assert.equal(page.status, 200);
  assert.ok(page.body.includes("so the board shows this page instead") && page.body.includes("Sample changed goal.") && !page.body.includes("&lt;&lt;&lt;&lt;"), "the programs list of the new snapshot, with the reason");
  assert.ok(!page.body.includes("new EventSource("), "R1509-2: the page with the note opens no stream, so no update of the programs list removes the note");
  const sent = await stream.next(p => p.html.includes("too large to show"));
  assert.ok(sent.html.includes("Sample changed goal.") && !sent.html.includes("&lt;&lt;&lt;&lt;") && sent.stale === false, "the stream stays open and sends the same page");
  assert.ok(page.body.includes("This page does not update: reload the address to try again.") && !sent.html.includes("does not update"), "R1534-2: only the page without a stream says that it does not update; the stream does update it");
  // The refresh checks only the shared pages, so they show the new logbook, live (T383): no page is stale.
  const list = await read(f, "/programs");
  assert.ok(list.body.includes("Sample changed goal.") && !list.body.includes("too large to show") && !list.body.includes("The board snapshot is unavailable."), "the programs list is live");
  assert.ok(!(await read(f, "/")).body.includes("The board snapshot is unavailable."), "the board is live");
});

test("T383 item 16: a task page that is too large shows the board with a note, by the same rule, also at the first start; the board stays live", async t => {
  // Each "<" of a finding's summary is 4 bytes of HTML: the task page passes 8 MB, the board does not (a card shows no summary).
  const finding = project => writeFileSync(join(project, "findings.tsv"), `${HEADERS.findings.replaceAll(" ", "\t")}\nT1\tF-1\t1\tcode-review\tlow\t${"<".repeat(3.9 * 1024 * 1024)}\t\t\topen\n`);
  const f = await fixture(t);
  await until(f, `/task/${key}`, "Sample first task");
  finding(f.project);
  const page = await until(f, `/task/${key}`, "too large to show");
  assert.equal(page.status, 200);
  assert.ok(page.body.includes("so the board shows this page instead") && page.body.includes("Sample first task") && !page.body.includes("&lt;&lt;&lt;&lt;"), "the board, with the reason");
  assert.ok(!page.body.includes("Incomplete sources"), "R1391-3: the note is its own banner, not an incomplete source");
  assert.ok(page.body.includes("This page does not update: reload the address to try again.") && !page.body.includes("new EventSource("), "R1509-2: the page with the note opens no stream, so no update of the board removes the note");
  const board = await read(f, "/");
  assert.ok(board.body.includes("Sample first task") && !board.body.includes("too large to show") && !board.body.includes("The board snapshot is unavailable."), "the board is live");
  // The first start: the rule needs no older copy.
  const first = await fixture(t, { before: finding });
  const fallback = await read(first, `/task/${key}`);
  assert.equal(fallback.status, 200);
  assert.ok(fallback.body.includes("so the board shows this page instead") && fallback.body.includes("Sample first task") && !fallback.body.includes("&lt;&lt;&lt;&lt;"), fallback.body.slice(0, 2000));
  assert.ok(Buffer.byteLength(fallback.body) < 8 * 1024 * 1024);
  const stream = events(first, `/?events=1&task=${key}`); t.after(() => stream.close());
  const sent = await stream.next();
  assert.ok(sent.html.includes("so the board shows this page instead") && !sent.html.includes("does not update") && sent.stale === false, "its stream sends the same page, without the reload sentence (R1534-2)");
});
