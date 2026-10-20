import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoardSources } from "../packages/sage-core/board-reader.mjs";

test("board reader preserves source-qualified duplicate tasks and never initializes missing tables", t => {
  const root = mkdtempSync(join(tmpdir(), "sage-board-reader-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sources = ["one", "two"].map(id => {
    const path = join(root, id), project = join(path, "sample-abcdef");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "tasks.tsv"), "id\ttitle\tsize\trisk\troute\tstate\tbranch\tpr\tround\tkeys\nT197\t<script>sample</script>\tsmall\t\tbuild\tframed\t\t\t0\t\n");
    return { id, path };
  });
  const before = sources.map(s => readFileSync(join(s.path, "sample-abcdef/tasks.tsv"), "utf8"));
  const result = readBoardSources(sources);
  assert.notEqual(result[0].projects[0].key, result[1].projects[0].key);
  for (const [i, source] of sources.entries()) {
    assert.equal(result[i].projects[0].tables.tasks[0].id, "T197");
    assert.equal(result[i].projects[0].tables.tasks[0].title, "<script>sample</script>");
    assert.equal(result[i].projects[0].diagnostics.length, 5);
    assert.deepEqual(readdirSync(join(source.path, "sample-abcdef")), ["tasks.tsv"]);
    assert.equal(readFileSync(join(source.path, "sample-abcdef/tasks.tsv"), "utf8"), before[i]);
  }
});

test("board reader reports unreadable, duplicate and linked sources rather than a complete empty board", t => {
  const root = mkdtempSync(join(tmpdir(), "sage-board-reader-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const link = join(root, "link"); symlinkSync(root, link);
  const result = readBoardSources([{ id: "one", path: root }, { id: "two", path: root }, { id: "link", path: link }, { id: "missing", path: join(root, "missing") }]);
  assert.deepEqual(result[0].diagnostics, []);
  assert.deepEqual(result[1].diagnostics, ["duplicate physical source"]);
  assert.deepEqual(result[2].diagnostics, ["source is not a directory"]);
  assert.deepEqual(result[3].diagnostics, ["ENOENT"]);
  assert.throws(() => readBoardSources([{ id: "one", path: root }, { id: "one", path: root }]), TypeError);
});

test("board reader refuses linked, oversized and damaged tables without following their contents", t => {
  const root = mkdtempSync(join(tmpdir(), "sage-board-reader-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "sample-abcdef"); mkdirSync(project);
  const outside = join(root, "outside"); writeFileSync(outside, "private sentinel");
  symlinkSync(outside, join(project, "tasks.tsv"));
  writeFileSync(join(project, "runs.tsv"), "x".repeat(4 * 1024 * 1024 + 1));
  writeFileSync(join(project, "gates.tsv"), "id\tid\nG1\tG1\n");
  const [source] = readBoardSources([{ id: "sample", path: root }]);
  const book = source.projects[0];
  assert.equal(book.tables.tasks, undefined);
  assert.equal(book.tables.runs, undefined);
  assert.equal(book.tables.gates, undefined);
  assert.ok(book.diagnostics.some(d => d.startsWith("tasks:")));
  assert.ok(book.diagnostics.includes("runs: not a bounded regular file"));
  assert.ok(book.diagnostics.includes("gates: damaged table header"));
  assert.equal(readFileSync(outside, "utf8"), "private sentinel");
});

test("reader accepts versioned evidence and rejects future or damaged sidecars", t => {
  const root = mkdtempSync(join(tmpdir(), "sage-board-reader-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "sample-abcdef"); mkdirSync(project);
  const at = "2026-10-08T20:00:00.000Z";
  const record = { id: "O1", task: "T1", kind: "pr", source: "fixture recorder", basis: "observed", observedAt: at, recordedAt: at, data: { repository: "https://example.test/team/project", number: 12, state: "open", head: "a".repeat(40) } };
  const file = join(project, "observations.json");
  writeFileSync(file, JSON.stringify({ version: 1, records: [record] }));
  const read = () => readBoardSources([{ id: "sample", path: root }], { now: Date.parse(at) })[0].projects[0];
  assert.equal(read().observations.records[0].data.head, "a".repeat(40));
  record.observedAt = "2027-10-08T20:00:00.000Z"; record.recordedAt = record.observedAt;
  writeFileSync(file, JSON.stringify({ version: 1, records: [record] }));
  assert.equal(read().observations.records.length, 0);
  assert.ok(read().diagnostics.some(d => d.startsWith("observations:")));
  writeFileSync(file, "{broken");
  assert.equal(read().observations.records.length, 0);
  assert.ok(read().diagnostics.some(d => d.startsWith("observations:")));
});

test("reader exposes a recorded brief only after its content digest matches", t => {
  const root = mkdtempSync(join(tmpdir(), "sage-board-reader-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "sample-abcdef"), briefs = join(project, "briefs"); mkdirSync(briefs, { recursive: true });
  writeFileSync(join(project, "tasks.tsv"), "id\ttitle\tsize\trisk\troute\tstate\tbranch\tpr\tround\tkeys\nT1\tSample\tsmall\t\tbuild\tframed\t\t\t0\t\n");
  const body = "Goal: sample brief.\nAcceptance: sample result.\n", file = join(briefs, "T1.md"); writeFileSync(file, body);
  const at = "2026-10-08T20:00:00.000Z";
  writeFileSync(join(project, "observations.json"), JSON.stringify({ version: 1, records: [{ id: "O1", task: "T1", kind: "artifact", source: "fixture recorder", basis: "observed", observedAt: at, recordedAt: at, data: { type: "brief", label: "Sample brief", path: "briefs/T1.md", sha256: createHash("sha256").update(body).digest("hex") } }] }));
  const read = () => readBoardSources([{ id: "sample", path: root }], { now: Date.parse(at) })[0].projects[0];
  assert.equal(read().contents.O1.text, body);
  writeFileSync(file, "changed brief");
  assert.equal(read().contents.O1, undefined);
  assert.ok(read().diagnostics.includes("artifact O1: artifact digest does not match"));
});


test("recorded screenshots embed only digest-verified raster bytes; config errors expose no input", t => {
  const root = mkdtempSync(join(tmpdir(), "sage-board-reader-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "sample-abcdef"), artifacts = join(project, "artifacts"); mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(project, "tasks.tsv"), "id\ttitle\tsize\trisk\troute\tstate\tbranch\tpr\tround\tkeys\nT1\tSample\tsmall\t\tbuild\tframed\t\t\t0\t\n");
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AAAAAElFTkSuQmCC", "base64"), file = join(artifacts, "sample.png"), at = "2026-10-08T20:00:00.000Z";
  writeFileSync(file, bytes);
  writeFileSync(join(root, "config.json"), "SAMPLE_PRIVATE_CONFIG_DO_NOT_SHOW");
  writeFileSync(join(project, "observations.json"), JSON.stringify({ version: 1, records: [{ id: "O1", task: "T1", kind: "artifact", source: "fixture", basis: "observed", observedAt: at, recordedAt: at, data: { type: "artifact", label: "Sample screenshot", path: "artifacts/sample.png", sha256: createHash("sha256").update(bytes).digest("hex") } }] }));
  const read = () => readBoardSources([{ id: "sample", path: root }], { now: Date.parse(at) })[0];
  const result = read();
  assert.equal(result.projects[0].contents.O1.dataUrl, `data:image/png;base64,${bytes.toString("base64")}`);
  assert.deepEqual(result.diagnostics, ["config: invalid JSON"]);
  writeFileSync(file, "<svg onload=sample>changed</svg>");
  assert.equal(read().projects[0].contents.O1, undefined);
});


test("damaged task identities and states are diagnostics, and repeated artifacts share a read budget", t => {
  const root = mkdtempSync(join(tmpdir(), "sage-board-reader-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "sample-abcdef"), artifacts = join(project, "artifacts"); mkdirSync(artifacts, { recursive: true });
  const header = "id\ttitle\tsize\trisk\troute\tstate\tbranch\tpr\tround\tkeys\n", row = "T1\tSample\tsmall\t\tbuild\tframed\t\t\t0\t\n", tasks = join(project, "tasks.tsv"), at = "2026-10-08T20:00:00.000Z";
  const read = () => readBoardSources([{ id: "sample", path: root }], { now: Date.parse(at) })[0].projects[0];
  for (const damaged of [row.replace("T1", "bad"), row.replace("framed", "lost-state"), row + row]) {
    writeFileSync(tasks, header + damaged);
    assert.ok(read().diagnostics.includes("tasks: damaged task identity or state"));
  }
  writeFileSync(tasks, header + row);
  const body = "sample proof\n".repeat(22000), digest = createHash("sha256").update(body).digest("hex");
  writeFileSync(join(artifacts, "proof.txt"), body);
  const records = Array.from({ length: 80 }, (_, i) => ({ id: `O${i + 1}`, task: "T1", kind: "artifact", source: "fixture", basis: "observed", observedAt: at, recordedAt: at, data: { type: "proof", label: `Sample ${i + 1}`, path: "artifacts/proof.txt", sha256: digest } }));
  writeFileSync(join(project, "observations.json"), JSON.stringify({ version: 1, records }));
  const result = read();
  assert.ok(result.diagnostics.some(message => message.endsWith("board aggregate read limit exceeded")));
  assert.ok(Object.keys(result.contents).length < records.length);
  assert.ok(Object.values(result.contents).reduce((bytes, content) => bytes + Buffer.byteLength(content.text ?? ""), 0) <= 16 * 1024 * 1024);
});

test("T233 C3: the programs table: missing is no rows while no task names a program, else a diagnostic; a damaged header, two rows of one id, or a bad pilot or gate cell make it unreadable; a bad program cell shows as ?", t => {
  const root = mkdtempSync(join(tmpdir(), "sage-board-reader-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const HEAD = "id\ttitle\tsize\trisk\troute\tstate\tbranch\tpr\tround\tkeys\twaits\tprogram\n";
  const task = (id, program = "", waits = "") => `${id}\tSample\tsmall\t\tbuild\tframed\t\t\t0\t\t${waits}\t${program}\n`;
  const EMPTY = { runs: "id\ttask\trole\tround\tcandidate\tbranch\tstatus\ttokens\treport\tstarted\tended\n", findings: "task\tkey\tround\tsource\tseverity\tsummary\ttriage\treason\tstatus\n", ledger: "task\tpr\tsha\tkind\tcycle\trun\tat\n", gates: "id\ttask\tquestion\toptions\trecommendation\tdefault\tanswer\tat\n", decisions: "at\ttask\tdecision\twhy\n" };
  const read = (tasks, programs) => {
    const path = mkdtempSync(join(root, "source-")), project = join(path, "sample-abcdef");
    mkdirSync(project);
    writeFileSync(join(project, "tasks.tsv"), HEAD + tasks.join(""));
    for (const [table, text] of Object.entries(EMPTY)) writeFileSync(join(project, `${table}.tsv`), text);
    if (programs !== undefined) writeFileSync(join(project, "programs.tsv"), programs);
    return readBoardSources([{ id: "one", path }])[0].projects[0];
  };
  const PROGRAMS = "id\tname\tgoal\tpilot\tgate\tat\n";
  // A logbook from before programs: no programs table, and no task names a program.
  const old = read([task("T1")]);
  assert.deepEqual(old.diagnostics, []);
  assert.deepEqual(old.tables.programs, []);
  // A task names a program, and the table is missing: a diagnostic.
  const lost = read([task("T1", "PG1")]);
  assert.deepEqual(lost.diagnostics, ["programs: ENOENT"]);
  assert.equal(lost.tables.programs, undefined);
  // A good table: its rows as stored, also a name with marks (the renderers escape it).
  const good = read([task("T1", "PG1"), task("T2", "PG1", "T1")], `${PROGRAMS}PG1\t<b>Codex</b> *support*\tSample goal\tT1\tG1\t2026-10-20T10:00:00Z\n`);
  assert.deepEqual(good.diagnostics, []);
  assert.deepEqual(good.tables.programs, [{ id: "PG1", name: "<b>Codex</b> *support*", goal: "Sample goal", pilot: "T1", gate: "G1", at: "2026-10-20T10:00:00Z" }]);
  assert.equal(good.tables.tasks[1].waits, "T1");
  // Unreadable: a damaged header, two rows of one id, a bad id, pilot or gate cell. The other tables stay readable.
  for (const [why, text] of [
    ["header", "id\tname\tgoal\tpilot\n"],
    ["twice", `${PROGRAMS}PG1\tA\tg\tT1\tG1\t\nPG1\tB\tg\tT2\tG2\t\n`],
    ["id", `${PROGRAMS}P1\tA\tg\tT1\tG1\t\n`],
    ["pilot", `${PROGRAMS}PG1\tA\tg\tX1\tG1\t\n`],
    ["gate", `${PROGRAMS}PG1\tA\tg\tT1\tgate 1\t\n`],
  ]) {
    const bad = read([task("T1", "PG1")], text);
    assert.equal(bad.tables.programs, undefined, why);
    assert.deepEqual(bad.diagnostics, [why === "header" ? "programs: damaged table header" : "programs: damaged program identity, pilot or gate"], why);
    assert.equal(bad.tables.tasks.length, 1, why);
  }
  // A program cell that is not a program id shows as ?; a good one stays.
  const cell = read([task("T1", "<img src=x>"), task("T2", "PG1")], `${PROGRAMS}PG1\tA\tg\tT2\tG1\t\n`);
  assert.deepEqual(cell.tables.tasks.map(row => row.program), ["?", "PG1"]);
});
