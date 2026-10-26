# Contributing to sage

This page tells you how to change sage: which files are sources, how to build and check them, and how sage follows pstack. An agent that works on sage also reads [AGENTS.md](AGENTS.md), which has the same rules in short form.

To report a security problem, do not open an issue: see [SECURITY.md](SECURITY.md).

## The folders

| Path | What it is |
| --- | --- |
| `packages/` | The sources: shared core, the Claude Code and Codex parts, and the board server. |
| `plugins/sage/`, `plugins/sage-codex/` | The built plugins for Claude Code and Codex. Never edit them by hand. |
| `principles/`, `upstream/pstack/`, `writing/`, `preferences/` | The principles (sage's and pstack's), the writing standard, the dictionary and the author's working preferences. |
| `docs/` | The guides, the design pages, the dry run report and the README's graphics: see the [docs index](docs/README.md). |
| `scripts/` | The build, the checks, the tests, and the scripts that draw the graphics and take the board screenshots. |

## Sources and build output

Edit only the sources. The build makes everything else, and `npm run check` fails when a built file differs from its sources.

| Edit these sources | Never edit by hand |
| --- | --- |
| `principles/`, `writing/`, `preferences/` | `plugins/sage/` and `plugins/sage-codex/` (the built plugins) |
| `packages/` (shared code, and each provider's hooks, agents and skills) | `instructions/core.md` (built from `preferences/` and `writing/`) |
| `scripts/graphics.mjs` (draws the README's graphics) | `docs/assets/*.svg` (drawn by the script) |
| `scripts/board-shots.mjs` (takes the board screenshots) | `docs/assets/board-*.png` and `learn-*.png` (taken by the script) |
| | `upstream/pstack/` (`npm run sync` owns it) |

To override a pstack principle, add `principles/<name>.md` with `source: pstack principle-<name>` and its `upstream:` fingerprint.

## Change it

1. Install the pinned build dependencies. Installed plugins do not need this step.

   ```sh
   npm ci --ignore-scripts
   ```

2. Edit a source.
3. After a change to a graphic, draw the graphics again:

   ```sh
   npm run graphics
   ```

4. Build:

   ```sh
   npm run build
   ```

5. Run the checks. They include the README's limits, its links and sage's word check:

   ```sh
   npm run check
   ```

6. Run the tests. CI runs the check and the tests on each pull request.

   ```sh
   npm test
   ```

7. Run the browser tests of the board. They are not in `npm test`, so that it stays fast. They use the Chromium headless shell of the pinned `playwright` devDependency. `npm ci` downloads no browser, so install it once:

   ```sh
   npx playwright install --only-shell chromium
   npm run test:browser
   ```

   To run one file: `node --test scripts/board-picker.test.mjs`. CI installs the same browser and runs `npm run test:browser` after `npm test`.

## The README and the docs

- The README is a short front page. `npm run check` holds it to 150 lines, a first screen that answers what sage is and its status, a link to the changelog, and relative links that resolve. A longer text goes into a page under `docs/`, listed in the [docs index](docs/README.md).
- Each change for users goes into [CHANGELOG.md](CHANGELOG.md), newest first. The README has no list of changes: it links to the changelog.
- Do not edit `CHANGELOG.md` in a task pull request. It is built from the folder `changes/`, on main only, so that two pull requests never conflict in it. Each pull request adds one file, `changes/<task>.md` (for example `changes/T492.md`), and nothing else for the change log: `npm run build` does not write `CHANGELOG.md`. The file has the date of the first commit of the change, then one list item, with links written as from `CHANGELOG.md`:

  ```markdown
  ---
  date: 2026-10-25
  ---
  - **A short title.** What changed for users, and what they do now.
  ```

  `npm run changelog` puts the dates newest first. In one date, it puts the files by name, highest task first, then the older entries of `changes/earlier.md`. A test that reads a new entry reads its `changes/<task>.md`, because `CHANGELOG.md` gets the entry only later.
- The chief rebuilds `CHANGELOG.md` after merges: on a branch from main (for example `sage/changelog-2026-10-26`), it runs `npm run changelog` and opens a small change-log pull request that changes only `CHANGELOG.md`. No CI job or other automatic job writes to main. `npm run check` tells the two kinds of pull request apart by the diff from the merge base with `origin/main`:
  - a diff that changes `CHANGELOG.md` and other files fails: undo the edit of `CHANGELOG.md`;
  - a diff that changes only `CHANGELOG.md` is a change-log pull request, and it fails when `CHANGELOG.md` is not exactly what `npm run changelog` makes;
  - any other diff passes when `CHANGELOG.md` lags behind `changes/`, with a warning. So main can lag between change-log pull requests, and a merge never makes main fail.

  The check needs `origin/main` (run `git fetch origin main`; CI checks out with `fetch-depth: 0`). `npm run changelog` and the check stop, and write nothing, in two cases: a file of `changes/` that is not a `.md` file (rename it to `changes/<task>.md`), and any line of text in `CHANGELOG.md` that no file of `changes/` makes, in any form: an entry written by hand, a paragraph, or an edit of the intro (move it into `changes/<task>.md` with its date, or into `changes/earlier.md` for the intro or an older entry). A dot file in `changes/`, such as `.DS_Store`, is ignored.
- The word table of [Concepts](docs/guide/concepts.md) and the table of [Principles](docs/guide/principles.md) come from the build: edit `writing/dictionary.md` or the principles, then run `npm run build`.
- Write at about 80% of Simplified Technical English ([writing/ste-80.md](writing/ste-80.md)), with sage's words from [writing/dictionary.md](writing/dictionary.md). `npm run check` fails on a flagged word.

## The board screenshots

The board screenshots of the README and of [Learn sage in 5 minutes](docs/guide/learn-sage.md) come from `scripts/board-shots.mjs`. It renders the built board with fixed sample logbooks (made-up data, from `scripts/fixtures/board-programs.mjs` and `scripts/fixtures/board-walkthrough.mjs`) in Playwright's Chromium. Each shot is at laptop width (1280 by 800 CSS pixels, so the board shows its desktop layout) and 2x, and carries a SAMPLE DATA label. It uses the same browser as the browser tests (step 7 above):

```sh
node scripts/board-shots.mjs
```

`npm run check` fails when a PNG is missing, or when the sample data changed after the last screenshots. It does not compare pixels.

For board QA, `node scripts/board-sample.mjs <empty folder>` writes sample logbooks (made-up data), with sample agent slots for the Agents page. It prints the board sources as JSON.

## Following pstack

pstack changes often. sage follows it so that its users do not have to.

<a href="docs/assets/pstack-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/pstack-dark.svg">
  <img alt="Following pstack: a weekly sync into upstream/pstack, local versions in principles/ that win, one build, the sage plugin. If pstack changed a local version, the update waits for review; otherwise it merges." src="docs/assets/pstack-light.svg" width="100%">
</picture>
</a>

1. `upstream/pstack/` holds pstack's principles and its MIT licence, at the commit in `upstream/pstack.json`.
2. The build takes each pstack principle as it is, unless `principles/` has sage's adapted version with the same name.
3. Every Monday, a workflow brings pstack up to date, rebuilds, and runs the checks and tests. The update merges by itself, unless pstack changed a principle that sage adapted. Then its pull request waits for the maintainer, with the change listed.

Only principles come in for now. pstack's own modes (poteto mode, orchestrate, autopilot) stay out, because sage mode is the orchestration layer here. Each other pstack skill comes in only when it works in Claude Code and has a test.

## Design pages

- [The sage mode design](docs/design/sage-mode.md): the first design, with its decisions.
- [Rules held in code](docs/design/rules-in-code.md): every rule that the hook and the state tool hold.
- [Separate provider packages](docs/design/provider-packages.md): the Claude Code and Codex plugins, and the shared core.
