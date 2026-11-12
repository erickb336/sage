// T1001: the board's pages route. Each task's pages folder, read-only, on the Mac only, at /pages/<logbook>/<task>/ (an
// index) and /pages/<logbook>/<task>/<file>, with a sandbox policy in place of the board's. A board on a free port over a
// SAMPLE logbook, with its worktree root (SAGE_WORKTREES) in a temporary folder; and the state tool's message command,
// whose Page link opens on that board.
import "./test-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs, { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBoardServer, hashPassword } from "../packages/sage-board/server.mjs";
import { SWITCH_SCRIPT } from "../packages/sage-core/message-page.mjs";
import { renderMessage } from "../packages/sage-core/message-checks.mjs";

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
    "handler.html": "<!DOCTYPE html><title>handler</title><p title=\"a > b\" onclick=\"document.title='ran'\">SAMPLE</p>",
    "prose.html": "<!DOCTYPE html><title>prose</title><p>SAMPLE: done once = fine</p><p title=\"done once = fine\">x</p>",
    "brief.pdf": "%PDF-1.4 SAMPLE", "shot.png": "PNG SAMPLE", "photo.jpg": "JPG", "anim.gif": "GIF", "pic.webp": "WEBP", "chart.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
    "notes.md": "# SAMPLE <b>notes</b>", "notes.txt": "SAMPLE", "sub/inner.html": "<p>inner</p>", "sub/deep/deepest.txt": "three parts",
    "sub/deep/deeper/too-deep.txt": "four parts", "state.json": "{}", "events.jsonl": "{}", "run.log": "log", "page.tmp": "tmp", ".hidden.html": "<p>hidden</p>",
    "upper.HTML": "<p>case</p>", "v1..v2.html": "<p>two dots</p>", "notes..md": "two dots", "locked.html": "<p>locked</p>",
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(t1, name), text);
  chmodSync(join(t1, "locked.html"), 0o000); // a file that the board cannot open
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
  // The index has no sandbox, so that its opener policy holds (F-T1001-6): it cuts another site's handle to its tab.
  pageHeaders(index, /^script-src 'none'; default-src 'none';/);
  assert.equal(index.headers["cross-origin-opener-policy"], "same-origin");
  const listed = [...index.body.matchAll(/<a href="\/pages\/project-abcdef\/T1\/([^"?]+)">/g)].map((m) => m[1]).sort();
  assert.deepEqual(listed, ["anim.gif", "brief.pdf", "chart.svg", "handler.html", "message.html", "notes.md", "notes.txt", "photo.jpg", "pic.webp", "prose.html", "research.html", "scripted.html", "shot.png", "sub/deep/deepest.txt", "sub/inner.html"]);
  // The scripts link only for a page with a script of its own: a script element or an event attribute in a tag, not prose.
  assert.deepEqual([...index.body.matchAll(/href="([^"]+\?scripts=1)"/g)].map((m) => m[1]), [`/pages/${LOGBOOK}/T1/handler.html?scripts=1`, `/pages/${LOGBOOK}/T1/scripted.html?scripts=1`]);
  assert.match(index.body, /a page may link to sites outside this Mac/);
  assert.match(index.body, /the link "open with its scripts" runs the page's own scripts/);
  assert.equal((await get(f, `/pages/${LOGBOOK}/T1`)).body, index.body, "the index also without the last slash");

  // The index is bounded: a folder with more pages lists 200 and says that it stops.
  const many = await get(f, `/pages/${LOGBOOK}/T2/`);
  assert.equal([...many.body.matchAll(/<li>/g)].length, 200);
  assert.match(many.body, /The list stops at 200 pages/);
  assert.doesNotMatch(many.body, /open with its scripts/i, "no scripts warning when no page has a script");
});

test("F-T1013-1: a page with sage's switch and an http-equiv refresh in any spelling gets no scripts; sage's own message page keeps its switch", async (t) => {
  const f = await fixture(t);
  const policy = async (name, text) => { writeFileSync(join(f.t1, name), text); return (await get(f, `/pages/${LOGBOOK}/T1/${name}`)).headers["content-security-policy"]; };
  const none = await policy("plain.html", "<!DOCTYPE html><title>plain</title><p>SAMPLE</p>");
  assert.match(none, /^sandbox; /);
  // A message page as the message command writes it: its own policy tag (an http-equiv), its style and its switch.
  const design = JSON.parse(readFileSync(join(HERE, "fixtures", "messages", "07-design.json"), "utf8"));
  const page = renderMessage(design, { pagePath: (name) => join(f.base, name) }).page?.html;
  assert.match(page ?? "", /<meta http-equiv="Content-Security-Policy"/, "the message page names its own policy");
  assert.equal(await policy("design.html", page), none.replace(/^sandbox;/, "sandbox allow-scripts;"));
  const url = "0;url=http://other.example.test/?data=SAMPLE";
  const refreshes = {
    quoted: `<meta http-equiv="refresh" content="${url}">`,
    "odd case and spacing": `<META  HTTP-EQUIV = 'Refresh' CONTENT='${url}'>`,
    "no quotes": `<meta http-equiv=refresh content=${url}>`,
    "new lines and tabs": `<meta\n\thttp-equiv\n=\n"REFRESH"\tcontent="${url}">`,
    "an entity": `<meta http-equiv="&#x72;efresh" content="${url}">`,
    "a second meta after sage's policy tag": `<meta http-equiv="Content-Security-Policy" content="default-src 'none'"><meta http-equiv="refresh" content="${url}">`,
    "inside a value that looks like sage's policy tag": `<p title='<meta http-equiv="Content-Security-Policy" content="'><meta http-equiv=refresh content=${url}>">x</p>`,
    "in a comment (fails closed)": `<!-- <meta http-equiv="refresh" content="${url}"> -->`,
  };
  for (const [kind, meta] of Object.entries(refreshes)) assert.equal(await policy("refresh.html", `${page.replace("<title>", `${meta}<title>`)}`), none, kind);
  // A UTF-16 byte order mark makes the browser read other characters than the bytes that hold the switch.
  assert.equal(await policy("utf16.html", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(page)])), none, "a UTF-16 byte order mark");
});

test("F-T1001-24: a tag with millions of quoted values keeps the index whole: no link for its quoted values, a link for an event attribute after them", async (t) => {
  const f = await fixture(t), t3 = join(f.root, LOGBOOK, "pages", "T3"), values = "\"x\" ".repeat(3_000_000); // 11.4 MiB in one tag
  mkdirSync(t3);
  writeFileSync(join(t3, "quoted.html"), `<a ${values}>`);
  writeFileSync(join(t3, "handler.html"), `<a ${values} onclick=1>`);
  const index = await get(f, `/pages/${LOGBOOK}/T3/`);
  assert.equal(index.status, 200, index.body);
  assert.deepEqual([...index.body.matchAll(/<a href="\/pages\/project-abcdef\/T3\/([^"?]+)">/g)].map((m) => m[1]), ["handler.html", "quoted.html"]);
  assert.deepEqual([...index.body.matchAll(/href="([^"]+\?scripts=1)"/g)].map((m) => m[1]), [`/pages/${LOGBOOK}/T3/handler.html?scripts=1`]);
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
    "two dots inside a name": `/pages/${LOGBOOK}/T1/v1..v2.html`,
    "two dots inside a Markdown name": `/pages/${LOGBOOK}/T1/notes..md`,
    "a file that the board cannot open": `/pages/${LOGBOOK}/T1/locked.html`,
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
  for (const name of ["link.html", "hard.html", "checkout", "alias", "big.html", "state.json", ".hidden.html", "too-deep.txt", "upper.HTML", "v1..v2.html", "notes..md", "locked.html"]) assert.equal(index.includes(name), false, name);
  // The board's other routes keep the board's own policy.
  assert.match((await get(f, "/")).headers["content-security-policy"], /^default-src 'none'; script-src 'sha256-.*connect-src 'self'/);
});

/**
 * F-T1001-7: an agent that cannot read a file of the owner's may still give it a second name in a task's pages folder (a
 * hard link), and remove and add the outside name while the board checks the page. The test acts at the board's own
 * check of the opened file: it removes the outside name just before that check and adds it back just after. once: only
 * at the first check; each: at every check, with a pause, so that the file's change time moves between them.
 */
function swapAtCheck(secret, inside, each) {
  const real = fs.fstatSync, { ino } = statSync(secret);
  let acted = false;
  const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); // a wide gap on any clock
  const mock = test.mock.method(fs, "fstatSync", (fd, options) => {
    if (real(fd).ino !== ino || acted && !each) return real(fd, options);
    acted = true;
    unlinkSync(secret);
    try { return real(fd, options); } finally { pause(20); linkSync(inside, secret); }
  });
  syncBuiltinESMExports(); // the named imports of node:fs see the mock too
  return () => { mock.mock.restore(); syncBuiltinESMExports(); };
}

test("a page whose names change while the board checks it is refused: a hard link to a file outside never opens", async (t) => {
  const f = await fixture(t);
  const secret = join(f.base, "owner-secret.html"), inside = join(f.t1, "swap.html");
  writeFileSync(secret, "<p>OWNER SECRET</p>");
  linkSync(secret, inside);
  assert.equal((await get(f, `/pages/${LOGBOOK}/T1/swap.html`)).status, 404, "a second name, with no change");
  for (const each of [false, true]) {
    const restore = swapAtCheck(secret, inside, each);
    let r;
    try { r = await get(f, `/pages/${LOGBOOK}/T1/swap.html`); } finally { restore(); }
    assert.equal(r.status, 404, each ? "a change at every check" : "a change at the first check");
    assert.doesNotMatch(r.body, /OWNER SECRET/);
    assert.equal(statSync(secret).nlink, 2, "the test put the outside name back");
  }
});

/**
 * F-T1001-14: an agent may make a folder of a task's pages a link to a folder of the owner's, and flip it between a link
 * and a real folder while the board checks the page: a real folder at the board's path check, and the link again at its
 * stat of the path. The test flips at the board's own calls: to a real folder at the check of the opened file, and back
 * to the link at the stat of the path. macOS refuses the link at the open; other systems have no such flag.
 */
test("a page whose folder flips between a link and a folder while the board checks it is refused", { skip: process.platform !== "darwin" && "the board refuses a link in the path at the open on macOS only" }, async (t) => {
  const f = await fixture(t);
  const owner = join(f.base, "owner-docs"), decoy = join(f.base, "decoy"), flip = join(f.t1, "flip"), want = join(flip, "notes.md");
  mkdirSync(owner); mkdirSync(decoy);
  writeFileSync(join(owner, "notes.md"), "OWNER SECRET");
  writeFileSync(join(decoy, "notes.md"), "decoy");
  symlinkSync(owner, flip);
  const { ino } = statSync(join(owner, "notes.md"));
  assert.equal((await get(f, `/pages/${LOGBOOK}/T1/flip/notes.md`)).status, 404, "a link in the path, with no flip");
  const fstat = fs.fstatSync, stat = fs.statSync;
  let flipped = false;
  const mocks = [
    test.mock.method(fs, "fstatSync", (fd, options) => { if (!flipped && fstat(fd).ino === ino) { flipped = true; unlinkSync(flip); fs.renameSync(decoy, flip); } return fstat(fd, options); }),
    test.mock.method(fs, "statSync", (path, options) => { if (path === want && flipped) { fs.renameSync(flip, decoy); symlinkSync(owner, flip); } return stat(path, options); }),
  ];
  syncBuiltinESMExports();
  let r;
  try { r = await get(f, `/pages/${LOGBOOK}/T1/flip/notes.md`); } finally { for (const mock of mocks) mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(r.status, 404);
  assert.doesNotMatch(r.body, /OWNER SECRET/);
  unlinkSync(flip);
  fs.renameSync(decoy, flip);
  assert.equal((await get(f, `/pages/${LOGBOOK}/T1/flip/notes.md`)).body, "decoy", "a real folder in the path");
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
  const { sage, folder, name, port } = await messageSandbox(t);
  writeFileSync(join(folder, "research.html"), "<!DOCTYPE html><title>SAMPLE</title><p>SAMPLE research page</p>");
  const question = JSON.parse(readFileSync(join(HERE, "fixtures", "messages", "02-question.json"), "utf8"));
  const msg = { ...question, blocks: question.blocks.map((b) => (b.t === "page" ? { ...b, task: "T1", file: "research.html" } : b)) };
  const r = sage("message", "T1", "--json", JSON.stringify(msg));
  assert.equal(r.status, 0, r.out);
  const link = new RegExp(`\\nPage · Showing visuals in every app\\n  (http://127\\.0\\.0\\.1:43123/pages/${name}/T1/research\\.html)\\n  ${folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/research\\.html$`).exec(r.out)?.[1];
  assert.ok(link, r.out);
  const opened = await get({ port }, new URL(link).pathname);
  assert.equal(opened.status, 200);
  assert.match(opened.body, /SAMPLE research page/);
});

// The one promise of F-T1001-1, -2 and -13: a link that the message command prints, or that the index lists, never gets
// 404. For each file, the command accepts its Page block exactly when the board serves it, and the index lists exactly
// those.
test("the message command, the index and the board agree on every file: a link that the command prints or the index lists opens", async (t) => {
  const { base, sage, folder, name, port } = await messageSandbox(t);
  const t2 = dirname(folder) + "/T2", elsewhere = join(base, "elsewhere");
  writeFileSync(join(folder, "research.html"), "<p>SAMPLE</p>");
  mkdirSync(join(folder, "sub"));
  writeFileSync(join(folder, "sub", "ok.txt"), "SAMPLE");
  for (const file of ["v1..v2.html", "notes..md", "locked.html", "outside.html"]) writeFileSync(join(folder, file), "<p>SAMPLE</p>");
  chmodSync(join(folder, "locked.html"), 0o000);
  linkSync(join(folder, "outside.html"), join(folder, "hard.html"));
  symlinkSync(join(folder, "research.html"), join(folder, "link.html"));
  mkdirSync(join(folder, "real"));
  writeFileSync(join(folder, "real", "in.html"), "<p>SAMPLE</p>");
  symlinkSync(join(folder, "real"), join(folder, "via"));
  // A task whose pages folder is a link to a real folder elsewhere.
  assert.equal(sage("task", "add", "--priority", "P2", "--title", "t2", "--size", "small").status, 0);
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "x.html"), "<p>SAMPLE</p>");
  symlinkSync(elsewhere, t2);
  const question = JSON.parse(readFileSync(join(HERE, "fixtures", "messages", "02-question.json"), "utf8"));
  const message = (task, file) => sage("message", "T1", "--json", JSON.stringify({ ...question, blocks: question.blocks.map((b) => (b.t === "page" ? { ...b, task, file } : b)) }));
  const listed = async (task) => [...(await get({ port }, `/pages/${name}/${task}/`)).body.matchAll(/<a href="\/pages\/[^/]+\/T\d+\/([^"?]+)">/g)].map((m) => m[1]);
  const index = { T1: await listed("T1"), T2: await listed("T2") };
  const served = [];
  for (const [task, file] of [["T1", "research.html"], ["T1", "sub/ok.txt"], ["T1", "v1..v2.html"], ["T1", "notes..md"], ["T1", "locked.html"], ["T1", "hard.html"],
    ["T1", "link.html"], ["T1", "via/in.html"], ["T2", "x.html"]]) {
    const command = message(task, file), status = (await get({ port }, `/pages/${name}/${task}/${file}`)).status;
    assert.equal(command.status === 0, status === 200, `${task}/${file}: the command ${command.status === 0 ? "accepts" : "refuses"} it, and the board answers ${status}\n${command.out}`);
    assert.equal(index[task].includes(file), status === 200, `${task}/${file}: the index ${index[task].includes(file) ? "lists" : "leaves out"} it, and the board answers ${status}`);
    if (status === 200) served.push(`${task}/${file}`);
  }
  assert.deepEqual(served, ["T1/research.html", "T1/sub/ok.txt"]);
  // The message's own page: the command writes none into a pages folder that is a link, as the board serves none there.
  const design = JSON.parse(readFileSync(join(HERE, "fixtures", "messages", "07-design.json"), "utf8"));
  const own = sage("message", "T2", "--json", JSON.stringify({ ...design, blocks: design.blocks.filter((b) => b.t !== "page") }));
  assert.equal(own.status, 1, own.out);
  assert.match(own.out, /is a link, or the pages folder or the logbook folder above it is one/);
  assert.deepEqual(readdirSync(elsewhere), ["x.html"], "nothing written through the link");
});

/** A sandboxed state tool with one task and its pages folder, and a board over its logbook on a free port. */
async function messageSandbox(t) {
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
  // A board over the sandbox's logbook, on a free port instead of the owner's 43123.
  const book = readdirSync(base, { recursive: true }).map((path) => join(base, path)).find((path) => basename(path) === name && !path.includes(`${join(base, "worktrees")}`));
  assert.ok(book, "the sandbox's logbook");
  const port = await freePort(), before = process.env.SAGE_WORKTREES;
  process.env.SAGE_WORKTREES = env.SAGE_WORKTREES;
  const server = createBoardServer({ sources: [{ id: "sample", path: dirname(book) }], port });
  t.after(async () => { await server.close(); if (before === undefined) delete process.env.SAGE_WORKTREES; else process.env.SAGE_WORKTREES = before; });
  await server.start();
  return { base, sage, folder, name, port };
}
