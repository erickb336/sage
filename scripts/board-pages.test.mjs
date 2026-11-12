// T1001: the board's pages route. Each task's pages folder, read-only, on the Mac only, at /pages/<logbook>/<task>/ (an
// index) and /pages/<logbook>/<task>/<file>, with a sandbox policy in place of the board's. A board on a free port over a
// SAMPLE logbook, with its worktree root (SAGE_WORKTREES) in a temporary folder; and the state tool's message command,
// whose Page link opens on that board.
import "./test-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBoardServer, hashPassword } from "../packages/sage-board/server.mjs";
import { SWITCH_SCRIPT } from "../packages/sage-core/message-page.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, "..", "plugins", "sage", "skills", "sage", "sage.mjs");
const HEADERS = ["id title size risk route state branch pr round keys", "id task role round candidate branch status tokens report started ended", "task key round source severity summary triage reason status", "task pr sha kind cycle run at", "id task question options recommendation default answer at", "at task decision why"];
const NAMES = ["tasks", "runs", "findings", "ledger", "gates", "decisions"];
const LOGBOOK = "project-abcdef";
const PASSWORD = "sample board pass 01", RECORD = await hashPassword(PASSWORD);
const SWITCH = `<script>${SWITCH_SCRIPT}</script>`;

/** A free loopback port that is not one of the owner's own (4173, 43123). */
async function freePort() {
  for (;;) {
    const socket = createServer();
    await new Promise((accept, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", accept); });
    const { port } = socket.address();
    await new Promise((accept) => socket.close(accept));
    if (![4173, 43123].includes(port)) return port;
  }
}

/** A logbook folder with one task, in root/<name>. */
function logbook(root, name) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  NAMES.forEach((table, i) => writeFileSync(join(dir, `${table}.tsv`), `${HEADERS[i].replaceAll(" ", "\t")}\n`));
  writeFileSync(join(dir, "tasks.tsv"), `${HEADERS[0].replaceAll(" ", "\t")}\nT1\tSample task\tsmall\t\tbuild\tframed\tsample/t1\t\t0\t\n`);
}

/**
 * The sample worktree root: the logbook's pages, with every kind of file that the route must serve or refuse, a task
 * checkout and a run folder beside the pages folder, and the pages of a logbook that the board does not know.
 */
function sampleRoot(base) {
  const root = join(base, "worktrees"), pages = join(root, LOGBOOK, "pages"), t1 = join(pages, "T1");
  mkdirSync(join(t1, "sub", "deep", "deeper"), { recursive: true });
  const files = {
    "research.html": "<!DOCTYPE html><title>research</title><p>SAMPLE research</p>",
    "message.html": `<!DOCTYPE html><title>message</title><p>SAMPLE</p>${SWITCH}`,
    "scripted.html": "<!DOCTYPE html><title>scripted</title><p>SAMPLE</p><script>document.title='ran'</script>",
    "brief.pdf": "%PDF-1.4 SAMPLE", "shot.png": "PNG SAMPLE", "photo.jpg": "JPG", "anim.gif": "GIF", "pic.webp": "WEBP", "chart.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
    "notes.md": "# SAMPLE <b>notes</b>", "notes.txt": "SAMPLE", "sub/inner.html": "<p>inner</p>", "sub/deep/deepest.txt": "three parts",
    "sub/deep/deeper/too-deep.txt": "four parts", "state.json": "{}", "events.jsonl": "{}", "run.log": "log", "page.tmp": "tmp", ".hidden.html": "<p>hidden</p>",
    "upper.HTML": "<p>case</p>",
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(t1, name), text);
  writeFileSync(join(t1, "big.html"), "");
  truncateSync(join(t1, "big.html"), 16 * 1024 * 1024 + 1);
  // Beside the pages folder: a task checkout and a run folder, which must never be reachable.
  for (const dir of ["t1-checkout", "R12"]) { mkdirSync(join(root, LOGBOOK, dir), { recursive: true }); writeFileSync(join(root, LOGBOOK, dir, "secret.html"), "<p>CHECKOUT SECRET</p>"); }
  writeFileSync(join(base, "outside.html"), "<p>OUTSIDE SECRET</p>");
  // A link in each place: the file, a folder in the path, the task folder; and a hard link to a file outside.
  symlinkSync(join(base, "outside.html"), join(t1, "link.html"));
  symlinkSync(join(root, LOGBOOK, "t1-checkout"), join(t1, "checkout"));
  symlinkSync(join(t1, "sub"), join(t1, "alias"));
  symlinkSync(join(root, LOGBOOK, "t1-checkout"), join(pages, "T7"));
  linkSync(join(base, "outside.html"), join(t1, "hard.html"));
  // A task folder with more files than the index lists.
  mkdirSync(join(pages, "T2"));
  for (let i = 0; i < 260; i++) writeFileSync(join(pages, "T2", `page-${String(i).padStart(3, "0")}.html`), "<p>x</p>");
  // The pages of a logbook that no board source holds.
  mkdirSync(join(root, "other-123456", "pages", "T1"), { recursive: true });
  writeFileSync(join(root, "other-123456", "pages", "T1", "research.html"), "<p>OTHER</p>");
  return root;
}

async function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-board-pages-"))), source = join(base, "source"), port = await freePort();
  logbook(source, LOGBOOK);
  const root = sampleRoot(base), before = process.env.SAGE_WORKTREES;
  process.env.SAGE_WORKTREES = root;
  const server = createBoardServer({ sources: [{ id: "sample", path: source, label: "Sample" }], password: RECORD, port, allowedHosts: ["board.example.test"] });
  t.after(async () => { await server.close(); if (before === undefined) delete process.env.SAGE_WORKTREES; else process.env.SAGE_WORKTREES = before; rmSync(base, { recursive: true, force: true }); });
  await server.start();
  return { base, root, port, t1: join(root, LOGBOOK, "pages", "T1") };
}

function get(f, path, { method = "GET", headers = {}, raw } = {}) {
  return new Promise((accept, reject) => {
    const req = request({ host: "127.0.0.1", port: f.port, path, method, agent: false, ...(raw ? { setHost: false, headers: raw } : { headers: { Host: `127.0.0.1:${f.port}`, ...headers } }) }, (response) => {
      let body = ""; response.setEncoding("latin1"); response.on("data", (chunk) => body += chunk);
      response.on("end", () => accept({ status: response.statusCode, headers: response.headers, body }));
    });
    req.on("error", reject); req.setTimeout(60_000, () => req.destroy(new Error("board request did not finish"))); req.end();
  });
}

/** The status line of a request written by hand, for headers that the HTTP client does not send. */
function raw(f, text) {
  return new Promise((accept, reject) => {
    const socket = connect(f.port, "127.0.0.1", () => socket.end(text));
    let got = ""; socket.setEncoding("latin1"); socket.on("data", (chunk) => got += chunk); socket.on("error", reject);
    socket.on("close", () => accept(got.split("\r\n")[0]));
  });
}

const FILE_POLICY = /^sandbox; script-src 'sha256-[A-Za-z0-9+/]+=*'; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'$/;
/** The headers that every pages response carries: a sandbox policy in place of the board's, and the board's others. */
function pageHeaders(response, policy = FILE_POLICY) {
  assert.match(response.headers["content-security-policy"], policy);
  assert.doesNotMatch(response.headers["content-security-policy"], /connect-src|allow-same-origin.*allow-scripts|allow-scripts.*allow-same-origin/);
  assert.equal(response.headers["x-dns-prefetch-control"], "off");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["cross-origin-resource-policy"], "same-origin");
}

test("the pages route serves each page type with its own type and the sandbox policy, and the index lists only those pages", async (t) => {
  const f = await fixture(t);
  const types = { "research.html": "text/html; charset=utf-8", "brief.pdf": "application/pdf", "shot.png": "image/png", "photo.jpg": "image/jpeg", "anim.gif": "image/gif", "pic.webp": "image/webp", "chart.svg": "image/svg+xml", "notes.md": "text/plain; charset=utf-8", "notes.txt": "text/plain; charset=utf-8", "sub/inner.html": "text/html; charset=utf-8", "sub/deep/deepest.txt": "text/plain; charset=utf-8" };
  for (const [name, type] of Object.entries(types)) {
    const r = await get(f, `/pages/${LOGBOOK}/T1/${name}`);
    assert.equal(r.status, 200, name);
    assert.equal(r.headers["content-type"], type, name);
    assert.equal(r.body, readFileSync(join(f.t1, name), "latin1"), name);
    pageHeaders(r);
  }
  assert.equal((await get(f, `/pages/${LOGBOOK}/T1/research.html`, { method: "HEAD" })).body, "");
  // Only sage's own script may run: a message page gets scripts, with the hash of its Today switch only; any other page none.
  const message = await get(f, `/pages/${LOGBOOK}/T1/message.html`);
  assert.equal(message.headers["content-security-policy"], (await get(f, `/pages/${LOGBOOK}/T1/research.html`)).headers["content-security-policy"].replace(/^sandbox;/, "sandbox allow-scripts;"));
  pageHeaders(message, /^sandbox allow-scripts; script-src 'sha256-/);
  assert.match((await get(f, `/pages/${LOGBOOK}/T1/scripted.html`)).headers["content-security-policy"], FILE_POLICY);
  // With ?scripts=1, the page's own inline scripts run, in the same sandbox, and still connect nowhere.
  const scripted = await get(f, `/pages/${LOGBOOK}/T1/scripted.html?scripts=1`);
  assert.equal(scripted.status, 200);
  pageHeaders(scripted, /^sandbox allow-scripts; script-src 'unsafe-inline'; default-src 'none';/);

  const index = await get(f, `/pages/${LOGBOOK}/T1/`);
  assert.equal(index.status, 200);
  assert.equal(index.headers["content-type"], "text/html; charset=utf-8");
  pageHeaders(index, /^sandbox allow-same-origin; script-src 'none'; default-src 'none';/);
  const listed = [...index.body.matchAll(/<a href="\/pages\/project-abcdef\/T1\/([^"?]+)">/g)].map((m) => m[1]).sort();
  assert.deepEqual(listed, ["anim.gif", "brief.pdf", "chart.svg", "message.html", "notes.md", "notes.txt", "photo.jpg", "pic.webp", "research.html", "scripted.html", "shot.png", "sub/deep/deepest.txt", "sub/inner.html"]);
  assert.deepEqual([...index.body.matchAll(/href="([^"]+\?scripts=1)"/g)].map((m) => m[1]), [`/pages/${LOGBOOK}/T1/scripted.html?scripts=1`], "the scripts link only for a page with a script of its own");
  assert.match(index.body, /A page may link to sites outside this Mac/);
  assert.match(index.body, /"Open with its scripts" runs the page's own scripts/);
  assert.equal((await get(f, `/pages/${LOGBOOK}/T1`)).body, index.body, "the index also without the last slash");

  // The index is bounded: a folder with more pages lists 200 and says that it stops.
  const many = await get(f, `/pages/${LOGBOOK}/T2/`);
  assert.equal([...many.body.matchAll(/<li>/g)].length, 200);
  assert.match(many.body, /The list stops at 200 pages/);
  assert.doesNotMatch(many.body, /Open with its scripts/, "no scripts warning when no page has a script");
});

test("the pages route refuses each path that leaves a task's pages, a link, a second name, a type, a depth and a size", async (t) => {
  const f = await fixture(t);
  const refused = {
    "a path out with ..": `/pages/${LOGBOOK}/T1/../../t1-checkout/secret.html`,
    "a .. that a client keeps": `/pages/${LOGBOOK}/T1/sub/../research.html`,
    "an encoded path": `/pages/${LOGBOOK}/T1/%2e%2e/%2e%2e/t1-checkout/secret.html`,
    "an encoded name": `/pages/${LOGBOOK}/T1/research%2ehtml`,
    "a backslash": `/pages/${LOGBOOK}/T1/sub\\inner.html`,
    "a hidden file": `/pages/${LOGBOOK}/T1/.hidden.html`,
    "a hidden folder": `/pages/${LOGBOOK}/T1/.git/x.html`,
    "another query": `/pages/${LOGBOOK}/T1/research.html?x=1`,
    "two queries": `/pages/${LOGBOOK}/T1/research.html?scripts=1?scripts=1`,
    "scripts on a picture": `/pages/${LOGBOOK}/T1/shot.png?scripts=1`,
    "scripts on the index": `/pages/${LOGBOOK}/T1/?scripts=1`,
    "a logbook that the board does not know": "/pages/other-123456/T1/research.html",
    "a logbook name of another form": "/pages/Project-abcdef/T1/research.html",
    "a task checkout": `/pages/${LOGBOOK}/t1-checkout/secret.html`,
    "a run folder": `/pages/${LOGBOOK}/R12/secret.html`,
    "the logbook's pages folder": `/pages/${LOGBOOK}/`,
    "the pages root": "/pages",
    "a task folder that is a link": `/pages/${LOGBOOK}/T7/secret.html`,
    "the index of a task folder that is a link": `/pages/${LOGBOOK}/T7/`,
    "a file that is a link": `/pages/${LOGBOOK}/T1/link.html`,
    "a folder that is a link, out": `/pages/${LOGBOOK}/T1/checkout/secret.html`,
    "a folder that is a link, in": `/pages/${LOGBOOK}/T1/alias/inner.html`,
    "a hard link": `/pages/${LOGBOOK}/T1/hard.html`,
    "a type that is not a page": `/pages/${LOGBOOK}/T1/state.json`,
    "jsonl": `/pages/${LOGBOOK}/T1/events.jsonl`,
    "a log": `/pages/${LOGBOOK}/T1/run.log`,
    "a temporary file": `/pages/${LOGBOOK}/T1/page.tmp`,
    "a type in capitals": `/pages/${LOGBOOK}/T1/upper.HTML`,
    "too deep": `/pages/${LOGBOOK}/T1/sub/deep/deeper/too-deep.txt`,
    "too large": `/pages/${LOGBOOK}/T1/big.html`,
    "a file that is not there": `/pages/${LOGBOOK}/T1/none.html`,
    "a task that has no pages": `/pages/${LOGBOOK}/T9/`,
  };
  for (const [why, path] of Object.entries(refused)) {
    const r = await get(f, path);
    assert.equal(r.status, 404, `${why}: ${path}`);
    assert.doesNotMatch(r.body, /SECRET|OTHER|SAMPLE/, why);
    pageHeaders(r);
  }
  // The index never lists what the route refuses, also after a refused file has a page's name.
  const index = (await get(f, `/pages/${LOGBOOK}/T1/`)).body;
  for (const name of ["link.html", "hard.html", "checkout", "alias", "big.html", "state.json", ".hidden.html", "too-deep.txt", "upper.HTML"]) assert.equal(index.includes(name), false, name);
  // The board's other routes keep the board's own policy.
  assert.match((await get(f, "/")).headers["content-security-policy"], /^default-src 'none'; script-src 'sha256-.*connect-src 'self'/);
});

test("the pages route answers only on the Mac, only GET and HEAD, and only to the board's own pages or a person's click", async (t) => {
  const f = await fixture(t);
  const page = `/pages/${LOGBOOK}/T1/research.html`, authorization = `Basic ${Buffer.from(`sage:${PASSWORD}`).toString("base64")}`;
  // Off the Mac (a tunnel adds a forwarding header, or names the tunnel's host), also signed in: not found.
  for (const headers of [{ "X-Forwarded-For": "203.0.113.9" }, { Forwarded: "for=203.0.113.9" }, { "X-Forwarded-For": "203.0.113.9", Authorization: authorization }]) {
    const r = await get(f, page, { headers });
    assert.equal(r.status, 404, JSON.stringify(headers));
    pageHeaders(r);
  }
  assert.equal((await get(f, page, { raw: { Host: "board.example.test", Authorization: authorization } })).status, 404, "the tunnel's own host");
  assert.equal((await get(f, page, { raw: { Host: "evil.example" } })).status, 404, "a rebound name");
  // No Host (HTTP/1.0) or two Host headers: refused, and the board still answers.
  for (const head of ["HTTP/1.0\r\n", `HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\nHost: 127.0.0.1:${f.port}\r\n`]) assert.match(await raw(f, `GET ${page} ${head}\r\n`), /^HTTP\/1\.[01] 4\d\d /, head);
  assert.equal((await get(f, page)).status, 200);
  // On the Mac: a page opened from an address, from the board's own page, or by a person's click on another site.
  const click = { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document", "Sec-Fetch-User": "?1" };
  for (const headers of [{}, { "Sec-Fetch-Site": "none" }, { "Sec-Fetch-Site": "same-origin" }, click, { ...click, "Sec-Fetch-Site": "same-site" }])
    assert.equal((await get(f, page, { headers })).status, 200, JSON.stringify(headers));
  // Refused: a read from another site, a navigation that no person started, the scripts link from another site, a foreign Origin.
  for (const headers of [{ "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" }, { ...click, "Sec-Fetch-User": undefined }, { ...click, "Sec-Fetch-Dest": "iframe" },
    { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "image" }, { Origin: "null" }, { Origin: "http://evil.example" }]) {
    for (const name of Object.keys(headers)) if (headers[name] === undefined) delete headers[name];
    const r = await get(f, page, { headers });
    assert.equal(r.status, 403, JSON.stringify(headers));
    pageHeaders(r);
  }
  assert.equal((await get(f, `/pages/${LOGBOOK}/T1/scripted.html?scripts=1`, { headers: click })).status, 403, "the scripts link opens only from the board's own index");
  assert.equal((await get(f, `/pages/${LOGBOOK}/T1/scripted.html?scripts=1`, { headers: { "Sec-Fetch-Site": "same-origin" } })).status, 200);
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
    const r = await get(f, page, { method });
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.allow, "GET, HEAD");
  }
});

// The state tool's message command, in a sandbox: the link that its Page block prints opens on the board.
test("a message's Page block prints the board's link, and the link opens the page on the board", async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-t1001-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const env = { ...process.env, HOME: join(base, "home"), SAGE_HOME: join(base, "sage"), SAGE_WORKTREES: join(base, "worktrees"), SAGE_TEST_PIDS: "{}", SAGE_TEST_KILLS: join(base, "kills"),
    NODE_OPTIONS: `--import=${JSON.stringify(join(HERE, "kill-spy.mjs"))}` };
  const project = join(base, "project");
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  execFileSync("git", ["-C", project, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "start"]);
  const sage = (...args) => { const r = spawnSync("node", [TOOL, ...args, "--project", project], { encoding: "utf8", env, timeout: 60_000 }); return { status: r.status, out: (r.stdout + r.stderr).trim() }; };
  assert.equal(sage("init").status, 0);
  assert.equal(sage("task", "add", "--priority", "P2", "--title", "t", "--size", "small").status, 0);
  const folder = sage("pages", "T1").out, name = basename(dirname(dirname(folder)));
  writeFileSync(join(folder, "research.html"), "<!DOCTYPE html><title>SAMPLE</title><p>SAMPLE research page</p>");
  const question = JSON.parse(readFileSync(join(HERE, "fixtures", "messages", "02-question.json"), "utf8"));
  const msg = { ...question, blocks: question.blocks.map((b) => (b.t === "page" ? { ...b, task: "T1", file: "research.html" } : b)) };
  const r = sage("message", "T1", "--json", JSON.stringify(msg));
  assert.equal(r.status, 0, r.out);
  const link = new RegExp(`\\nPage · Showing visuals in every app\\n  (http://127\\.0\\.0\\.1:43123/pages/${name}/T1/research\\.html)\\n  ${folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/research\\.html$`).exec(r.out)?.[1];
  assert.ok(link, r.out);
  // A board over the sandbox's logbook, on a free port instead of the owner's 43123.
  const book = readdirSync(base, { recursive: true }).map((path) => join(base, path)).find((path) => basename(path) === name && !path.includes(`${join(base, "worktrees")}`));
  assert.ok(book, "the sandbox's logbook");
  const port = await freePort(), before = process.env.SAGE_WORKTREES;
  process.env.SAGE_WORKTREES = env.SAGE_WORKTREES;
  const server = createBoardServer({ sources: [{ id: "sample", path: dirname(book) }], port });
  t.after(async () => { await server.close(); if (before === undefined) delete process.env.SAGE_WORKTREES; else process.env.SAGE_WORKTREES = before; });
  await server.start();
  const opened = await get({ port }, new URL(link).pathname);
  assert.equal(opened.status, 200);
  assert.match(opened.body, /SAMPLE research page/);
});
