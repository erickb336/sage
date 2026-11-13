# The no-comments rule set

**This folder is sage's default lint rule set for code without comments: [ast-grep](https://ast-grep.github.io) rules that flag each comment in JavaScript, YAML and HTML, except a tool directive from a fixed list.**

Code says what it does through its names, types and tests. A comment goes stale and nothing checks it. So this rule set refuses explanatory comments and doc comments. It keeps only text that a tool reads: a directive with no free text after it, and one SPDX licence line.

A project gets this rule set only after its owner says yes. The project then owns its copy and may change it.

## Quick start

Run these commands in this folder. They run ast-grep 0.51.1 with the real package, `@ast-grep/cli`, pinned. The form works with a local install and without one. On npm, the bare name `ast-grep` is an unrelated package, so never run it by that name.

1. Run the rule tests. You see `test result: ok`.

   ```sh
   npx --yes --package=@ast-grep/cli@0.51.1 ast-grep test --skip-snapshot-tests
   ```

2. Scan a folder. Each comment that is not allowed is an error, and the command exits with 1.

   ```sh
   npx --yes --package=@ast-grep/cli@0.51.1 ast-grep scan --config sgconfig.yml --no-ignore hidden --globs '!.git' <folder>
   ```

   The scan then includes hidden folders such as `.github`, but not `.git`.

## What stays

Every language allows one SPDX line, such as `// SPDX-License-Identifier: MIT` (the `spdx` rule in `utils/`). Each directive must stand alone: a reason after it (`-- why`, `: why`, `because`) makes it a comment again. A file with CRLF line ends passes the same way.

| Language | Rule | Comment kinds | Directives that stay |
| --- | --- | --- | --- |
| JavaScript (`.js`, `.mjs`, `.cjs`, `.jsx`) | `no-comments-js` | `comment`, `html_comment` | `eslint-disable` and `eslint-enable` (also `-line` and `-next-line`, and with no space after `//` or `/*`), `prettier-ignore`, `istanbul ignore`, `c8` and `v8` `ignore`, `#__PURE__`, `#__NO_SIDE_EFFECTS__` (the `js-directive` rule in `utils/`). `c8` and `v8` pass only as a block comment, such as `/* c8 ignore next */`. |
| HTML | `no-comments-html` | `comment` | `prettier-ignore` |
| YAML | `no-comments-yaml` | `comment` | `yaml-language-server: $schema=<url>`, `yamllint disable` and `enable` (also `-line`), `yamllint disable-file` |

A scan of an HTML file checks only its HTML comments (see [Limits](#limits)).

A file in another language is not checked. The comment kinds differ by language, and a kind that a language does not have stops the whole scan (exit 8). So each rule names its own kinds. Each rule has `severity: error`, because a rule without it exits 0 when it finds comments.

## Limits

In an HTML file (`.html`, `.htm` or `.xhtml`), the rule set checks only the HTML comments. It skips each `<script>` block, whatever its type. A block can hold a template, and text in a template, such as `https://example.com`, looks like a `//` comment. So a comment in JavaScript inside an HTML file passes. Comments in `.js`, `.mjs`, `.cjs` and `.jsx` files stay checked. The `ignores` line of the JavaScript rule does this.

ast-grep's own suppression comment, `ast-grep-ignore`, hides comments from a scan. After code, it hides its own line. On its own line, it hides the next line, but the rule flags it. As the first line with a blank line after it, it hides the whole file. A rule cannot refuse it, because the suppression hides that rule too. sage's lint command (task T1019) is planned to refuse each file that contains `ast-grep-ignore`. `scripts/lint-rules.test.mjs` shows this limit.

## Add a language

The rule set has a rule only for each language that sage itself uses. A language joins when a project that uses it adopts the rules. Task T1020 then adds that language's rule and its rule tests, with a mutant in `scripts/lint-rules.test.mjs`.

## Change the rule set

1. Add a case to the rule's test file in `rule-tests/`: `valid` for code that must pass, `invalid` for code that must be flagged.
2. Change the rule in `rules/` or `utils/`.
3. Run the rule tests (in sage: `npm run check`).

In sage, `scripts/lint-rules.test.mjs` also changes the rules in a copy, one mutant at a time, and checks that the rule tests fail for each mutant. When you change a rule, update its mutant there.

## In sage: the strip, the proof and the exclusions

`npm run check` scans sage's own sources (`packages/`, `scripts/` and `.github/`) with this rule set. The code of the scan is in `scripts/lint-rules.mjs`. When the check fails on a comment:

1. Commit your change.
2. Run `node scripts/strip-comments.mjs [path ...]`. It removes each comment that the scan flags, and keeps the allowed directives. A second run changes nothing.
3. Run `node scripts/comment-proof.mjs [base] [head]` (by default, from `HEAD` to the working tree). For each changed JavaScript or YAML file, it compares the code tokens and the minified code (for YAML, the parsed value). It must report 0 failed.
4. Put a reason that a reader needs in a name, a test name or a doc, never in a comment.

`--help` gives the usage of each script. The scan skips these folders (`SCAN_EXCLUSIONS` in `scripts/lint-rules.mjs`):

| Folder | Why the scan skips it |
| --- | --- |
| `scripts/fixtures/sage-14c0d0c/**` | A frozen copy of the state tool at commit 14c0d0c, which `scripts/sage.test.mjs` runs as the old version. Its text is test data. |
| `packages/sage-core/lint/rule-tests/**` | The rule set's own test cases. Their comments are the data that the rules must flag or pass. |

The scan reads code, not the text in a string. A script or a style that a page serves from a string, such as the board's page script, is not in the scan. So a test in `scripts/comment-sweep.test.mjs` renders each page that the board, a message and a move serve, and fails on a comment in its HTML, its scripts or its styles.

## Credits and licence

The rules run on [ast-grep](https://github.com/ast-grep/ast-grep) (MIT). They are part of sage, under its MIT licence.
