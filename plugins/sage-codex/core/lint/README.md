# The no-comments rule set

**This folder is sage's default lint rule set for code without comments: [ast-grep](https://ast-grep.github.io) rules that flag each comment in 13 languages, except a tool directive from a fixed list.**

Code says what it does through its names, types and tests. A comment goes stale and nothing checks it. So this rule set refuses explanatory comments, doc comments and docstrings. It keeps only text that a tool reads: a directive with no free text after it, and one SPDX licence line.

A project gets this rule set only after its owner says yes. The project then owns its copy and may change it.

## Quick start

Run these commands in this folder. They need ast-grep 0.51.1 (`npm install --save-dev --save-exact @ast-grep/cli@0.51.1`).

1. Run the rule tests. You see `test result: ok`.

   ```sh
   npx ast-grep test --skip-snapshot-tests
   ```

2. Scan a folder. Each comment that is not allowed is an error, and the command exits with 1.

   ```sh
   npx ast-grep scan --config sgconfig.yml <folder>
   ```

## What stays

Every language allows one SPDX line, such as `// SPDX-License-Identifier: MIT` (the `spdx` rule in `utils/`). Each directive must stand alone: a reason after it (`-- why`, `: why`, `because`) makes it a comment again. A file with CRLF line ends passes the same way.

| Language | Rule | Comment kinds | Directives that stay |
| --- | --- | --- | --- |
| JavaScript, TypeScript, TSX | `no-comments-js`, `-ts`, `-tsx` | `comment`, `html_comment` | `eslint-disable` and `eslint-enable` (also `-line` and `-next-line`, and with no space after `//` or `/*`), `@ts-expect-error`, `@ts-ignore`, `@ts-nocheck`, `@ts-check`, `/// <reference … />`, `prettier-ignore`, `istanbul ignore`, `c8` and `v8` `ignore`, `#__PURE__`, `#__NO_SIDE_EFFECTS__` (the `js-directive` rule in `utils/`). `@ts-expect-error` and `@ts-ignore` may also be a block comment, such as `{/* @ts-expect-error */}` in JSX. `c8` and `v8` pass only as a block comment, such as `/* c8 ignore next */`. |
| Python | `no-comments-python` | `comment` | a shebang on line 1 (with any arguments), the coding line on line 1 or 2, `noqa: <codes>`, `type: ignore[<codes>]`, `pyright: ignore[<rules>]` and `pyright: <mode>`, `pragma: no cover`, `fmt: off`, `on` and `skip`. A bare `# noqa` or `# type: ignore` (with no codes) is flagged. |
| Python | `no-docstrings-python` | a string that stands alone as a statement | none |
| Go | `no-comments-go` | `comment` | `//go:<directive>` with no text after it, `//nolint:<linters>`, `//export <name>`, `// Code generated … DO NOT EDIT.`, and the cgo preamble: the comments right before `import "C"`. Only `build`, `generate`, `embed`, `linkname`, `debug`, `fix`, `wasmimport`, `wasmexport` and `cgo_*` take arguments after `//go:`; `//go:generate` takes a command. |
| Rust | `no-comments-rust` | `line_comment`, `block_comment` | none |
| Java | `no-comments-java` | `line_comment`, `block_comment` | none |
| Kotlin | `no-comments-kotlin` | `line_comment`, `multiline_comment` | none |
| Shell (Bash) | `no-comments-shell` | `comment` | a shebang on line 1 (with any arguments), `shellcheck <directive>=<value>` |
| Ruby | `no-comments-ruby` | `comment` | a shebang on line 1 (with any arguments), `frozen_string_literal`, `rubocop:disable`, `enable` and `todo`, Sorbet's `typed:` |
| CSS | `no-comments-css` | `comment`, `js_comment` | `stylelint-disable` and `stylelint-enable` (also `-line` and `-next-line`), `prettier-ignore` |
| HTML | `no-comments-html` | `comment` | `prettier-ignore`, `stylelint-disable` and `stylelint-enable` |
| YAML | `no-comments-yaml` | `comment` | `yaml-language-server: $schema=<url>`, `yamllint disable` and `enable` (also `-line`), `yamllint disable-file` |

A scan of an HTML file checks only its HTML comments (see [Limits](#limits)).

The comment kinds differ by language, and a kind that a language does not have stops the whole scan (exit 8). So each rule names its own kinds. Each rule has `severity: error`, because a rule without it exits 0 when it finds comments.

## Limits

In an HTML file (`.html`, `.htm` or `.xhtml`), the rule set checks only the HTML comments. It skips each `<script>` and `<style>` block, whatever its type. A block can hold a template, and text in a template, such as `https://example.com`, looks like a `//` comment. So a comment in JavaScript or CSS inside an HTML file passes. Comments in `.js`, `.ts`, `.tsx`, `.css` and other files stay checked. The `ignores` line of the JavaScript, TypeScript, TSX and CSS rules does this.

ast-grep's own suppression comment, `ast-grep-ignore`, hides comments from a scan. After code, it hides its own line. On its own line, it hides the next line, but the rule flags it. As the first line with a blank line after it, it hides the whole file. A rule cannot refuse it, because the suppression hides that rule too. sage's lint command (task T1019) is planned to refuse each file that contains `ast-grep-ignore`. `scripts/lint-rules.test.mjs` shows this limit.

## Change the rule set

1. Add a case to the rule's test file in `rule-tests/`: `valid` for code that must pass, `invalid` for code that must be flagged.
2. Change the rule in `rules/` or `utils/`.
3. Run the rule tests (in sage: `npm run check`).

In sage, `scripts/lint-rules.test.mjs` also changes the rules in a copy, one mutant at a time, and checks that the rule tests fail for each mutant. When you change a rule, update its mutant there.

## Credits and licence

The rules run on [ast-grep](https://github.com/ast-grep/ast-grep) (MIT). They are part of sage, under its MIT licence.
