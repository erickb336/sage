# Contributing to sage

This page tells you how to change sage: which files are sources, how to build and check them, and how sage follows pstack. An agent that works on sage also reads [AGENTS.md](AGENTS.md), which has the same rules in short form.

To report a security problem, do not open an issue: see [SECURITY.md](SECURITY.md).

## Sources and build output

Edit only the sources. The build makes everything else, and `npm run check` fails when a built file differs from its sources.

| Edit these sources | Never edit by hand |
| --- | --- |
| `principles/`, `writing/`, `preferences/` | `plugins/sage/` and `plugins/sage-codex/` (the built plugins) |
| `packages/` (shared code, and each provider's hooks, agents and skills) | `instructions/core.md` (built from `preferences/` and `writing/`) |
| `scripts/graphics.mjs` (draws the README's graphics) | `docs/assets/*.svg` (drawn by the script) |
| `scripts/board-shots.mjs` (takes the board screenshots) | `docs/assets/board-*.png` (taken by the script) |
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

## The README and the docs

- The README is a short front page. `npm run check` holds it to a line budget, at most 5 What's new items, a first screen that answers what sage is, and relative links that resolve. A longer text goes into a page under `docs/`, listed in the [docs index](docs/README.md).
- Each change for users goes into [CHANGELOG.md](CHANGELOG.md), newest first. The README's What's new keeps only the last five.
- Write at about 80% of Simplified Technical English ([writing/ste-80.md](writing/ste-80.md)), with sage's words from [writing/dictionary.md](writing/dictionary.md). `npm run check` fails on a flagged word.

## The board screenshots

The README's board screenshots come from `scripts/board-shots.mjs`. It renders the built board with a fixed sample logbook (made-up data, from `scripts/fixtures/board-programs.mjs`) in Playwright's Chromium, in light and dark. Playwright is not a dependency of sage, so give it through `NODE_PATH`:

```sh
NODE_PATH=<folder with playwright in node_modules> node scripts/board-shots.mjs
```

`npm run check` fails when a PNG is missing, or when the sample data changed after the last screenshots. It does not compare pixels.

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
