// The offline replay of past PRs (scripts/review-replay.mjs, T485): its report on a small sample logbook, as people run
// it, and proof that it only reads the logbook: it runs on a read-only copy, changes no byte of it, and refuses --out
// into the logbook folder.
import "./test-env.mjs"; // first: no variable of the developer's shell changes a result
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "./build.mjs";

const SCRIPT = join(ROOT, "scripts", "review-replay.mjs");
const FIXTURE = join(ROOT, "scripts", "fixtures", "review-replay");
const replay = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
const dated = (text) => text.replace(/^Measured \d{4}-\d{2}-\d{2} /m, "Measured <date> ");

/** A read-only copy of the sample logbook (files 0444, folder 0555), and a writable folder for the report. */
function readOnlyCopy(t) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-replay-"));
  const book = join(dir, "logbook"), out = join(dir, "out");
  cpSync(FIXTURE, book, { recursive: true });
  cpSync(FIXTURE, out, { recursive: true, filter: (src) => src === FIXTURE }); // an empty folder
  for (const f of readdirSync(book)) chmodSync(join(book, f), 0o444);
  chmodSync(book, 0o555);
  t.after(() => { chmodSync(book, 0o755); rmSync(dir, { recursive: true, force: true }); });
  const snapshot = () => readdirSync(book).sort().map((f) => [f, readFileSync(join(book, f), "utf8"), statSync(join(book, f)).mtimeMs]);
  return { book, out, snapshot };
}

test("the report of the sample logbook: the pick, each PR's roles, tokens, findings and escapes, the totals and the gaps", () => {
  const r = replay(FIXTURE);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(dated(r.stdout), EXPECTED);
});

test("it runs on a read-only copy of the logbook and changes no byte of it", (t) => {
  const { book, out, snapshot } = readOnlyCopy(t);
  const before = snapshot();
  const r = replay(book, "--out", join(out, "report.md"));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(dated(readFileSync(join(out, "report.md"), "utf8")), EXPECTED);
  assert.deepEqual(snapshot(), before);
});

test("--out into the logbook folder is refused, and no file is made there", (t) => {
  const { book, snapshot } = readOnlyCopy(t);
  chmodSync(book, 0o755); // writable, so that only the script's own rule can stop the write
  const before = snapshot();
  const r = replay(book, "--out", join(book, "report.md"));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^refused: --out .*report\.md is in the logbook folder, which this script only reads\.$/m);
  assert.equal(existsSync(join(book, "report.md")), false);
  assert.deepEqual(snapshot(), before);
  assert.equal(replay(book, "--out", join(book, "..", "logbook", "x.md")).status, 2);
});

const EXPECTED = `# Review replay: measured from the logbook

Measured <date> by scripts/review-replay.mjs, read only. Logbook rows: 5 tasks, 10 runs, 8 findings, 8 verdicts, 2 decisions.

Pick rule: of the 4 merged tasks with a PR, the 2 whose done review runs all have tokens; the 2 with the most review findings (then the most review tokens).
A review role is code-reviewer, security-reviewer, ux-reviewer, qa. Tokens are of done runs only. "Kept" is a finding that was not dismissed. A class is the reviewer's tag (finding add --class); "untagged" is a finding without one.

## T1 · PR 11 · small · risk input · repair rounds: 1

5 review runs · 550k tokens · round 0: 400k · later rounds: 150k

| Role | Runs | Tokens by round | High · medium · low | Dismissed | Kept by round |
| --- | --- | --- | --- | --- | --- |
| code-reviewer | 2 | r0 100k · r1 100k | 1 · 1 · 0 | 0 | r0 1 · r1 1 |
| security-reviewer | 1 | r0 200k · r1 0k | 0 · 1 · 1 | 1 | r0 1 |
| qa | 2 | r0 100k · r1 50k | 0 · 1 · 0 | 0 | r1 1 |

Found nothing kept: none. Found only low: none.
Findings from other roles (not counted): 1.

Each medium or high finding that was kept:

- R2-1 · high · code-reviewer · round 0 · state-edge · run R2 (from key): Lock file left after a crash
- R3-1 · medium · security-reviewer · round 0 · security · run R3: Path check follows a link
- R5-1 · medium · code-reviewer · round 1 · untagged · run R5 (from key) · after round 0: Retry loses the second row
- F-T1-9 · medium · qa · round 1 · untagged · run unknown · after round 0, opened again: Empty name saves a blank row

Moved to a follow-up task: R4-1 to T5 as F-T5-1 (low).
Findings of other tasks whose summary names T1: T5 F-T5-1 (low).

## T2 · PR 12 · large · no risk flag · repair rounds: 0

3 review runs · 400k tokens · round 0: 400k · later rounds: 0k

| Role | Runs | Tokens by round | High · medium · low | Dismissed | Kept by round |
| --- | --- | --- | --- | --- | --- |
| code-reviewer | 1 | r0 300k | 0 · 0 · 1 | 0 | r0 1 |
| ux-reviewer | 1 | r0 0k | 0 · 0 · 0 | 0 | none |
| qa | 1 | r0 100k | 0 · 0 · 0 | 0 | none |

Found nothing kept: qa. Found only low: code-reviewer.

Each medium or high finding that was kept:

- none

Moved to a follow-up task: none.
Findings of other tasks whose summary names T2: none.

## Totals over the picked PRs

| Role | PRs | Runs | Tokens | Kept | Medium or high kept | Kept per M tokens | Medium or high per M tokens | PRs where it found nothing kept | PRs with no medium or high kept | Clean verdicts |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| code-reviewer | 2 | 3 | 500k | 3 | 2 | 6.0 | 4.0 | 0 of 2 | 1 of 2 | 1 of 3 |
| security-reviewer | 1 | 1 | 200k | 1 | 1 | 5.0 | 5.0 | 0 of 1 | 0 of 1 | 0 of 1 |
| ux-reviewer | 0 | 1 | 0k | 0 | 0 | – | – | 0 of 0 | 0 of 0 | 0 of 0 |
| qa | 2 | 3 | 250k | 1 | 1 | 4.0 | 4.0 | 1 of 2 | 1 of 2 | 3 of 3 |
| all | 2 | 8 | 950k | 5 | 4 | 5.3 | 4.2 | 1 of 5 (20%) | 2 of 5 (40%) | |

Medium or high kept, by class and role (per M tokens: of all review tokens of the picked PRs):

| Class | code-reviewer | security-reviewer | ux-reviewer | qa | All | Per M tokens |
| --- | --- | --- | --- | --- | --- | --- |
| state-edge | 1 | 0 | 0 | 0 | 1 | 1.1 |
| security | 0 | 1 | 0 | 0 | 1 | 1.1 |
| untagged | 1 | 0 | 0 | 1 | 2 | 2.1 |

Tokens and findings by round:

| Round | Runs | Tokens | Share of tokens | Medium or high kept | Medium or high per M tokens |
| --- | --- | --- | --- | --- | --- |
| 0 | 6 | 800k | 84% | 2 | 2.5 |
| 1 | 2 | 150k | 16% | 2 | 13.3 |

Medium or high kept: 4. After round 0: 2. Opened again after a fix: 1. Moved to a follow-up task (any severity): 1. Findings of other tasks that name a picked task: 1.

## Data gaps

- Run: 1 of 7 review findings in the logbook name their run (finding add --run). Of the 6 review findings of the picked PRs: run cell 1, run from the key 4, no known run 1.
- Class: 3 of 7 review findings in the logbook have a class tag (finding add --class); the class table counts the others as untagged.
- Tokens: 1 of 8 done review runs in the logbook have no token count; the pick leaves out every PR with such a run, so the pick favours later PRs.
- A finding's round is the task's repair round when the finding was recorded. "After round 0" says that the round-0 reviews did not report it; the logbook cannot tell whether the problem was in the round-0 code or came with a repair.
- The logbook does not record a problem that shipped after a merge. A later finding that names the task is a proxy from the summary text, and a task id can also name a test case.
- This counts past runs only. It cannot tell what a different set of reviews would have found: that needs reviews re-run on the past commits (design v2, R1).
`;
