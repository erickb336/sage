# The no-comments rule set

**This folder is sage's default lint rule set for code without comments: [ast-grep](https://ast-grep.github.io) rules that flag each comment in JavaScript, YAML, HTML and CSS, and in the shell of a YAML `run:` block, except a tool directive from a fixed list.**

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
| CSS | `no-comments-css` | `comment` | `prettier-ignore`, `stylelint-disable` and `stylelint-enable` (also `-line` and `-next-line`) |
| YAML | `no-comments-yaml` | `comment` | `yaml-language-server: $schema=<url>`, `yamllint disable` and `enable` (also `-line`), `yamllint disable-file` |
| Shell in a YAML `run:` block | `no-comments-shell` | `comment` | `shellcheck disable=`, `enable=`, `source=`, `source-path=`, `shell=`, `external-sources=` |

In an HTML file, the JavaScript rule checks each `<script>` block and the CSS rule checks each `<style>` block. ast-grep reads them as embedded languages.

In a YAML file, the shell rule checks each literal block scalar (`|`, `|-` or `|+`) whose key is `run`, such as a step of a GitHub Actions workflow. The `languageInjections` part of `sgconfig.yml` gives that block to ast-grep as Bash. The shell rule applies only to YAML files, so a `.sh` file is not checked.

A file in another language is not checked. The comment kinds differ by language, and a kind that a language does not have stops the whole scan (exit 8). So each rule names its own kinds. Each rule has `severity: error`, because a rule without it exits 0 when it finds comments.

## Limits

ast-grep reads each `<script>` block of an HTML file as JavaScript, whatever its `type`. So text in a template script, such as `https://example.com`, can look like a `//` comment, and it fails. Put a template in a `<template>` element: ast-grep reads its content as HTML.

ast-grep reads the `|` sign at the start of a `run:` block as shell too. So when the `run:` key is at the top level of a YAML document, a comment on the first line of its `|` block passes if no command follows it in the block, as in `run: |` with only `# why` under it. A `run:` key in a mapping or a list, such as a step of a GitHub Actions workflow, does not have this limit.

The shell rule does not check a folded `run:` block (`>`, `>-` or `>+`). YAML folds its lines into one line, so a `#` in it makes the rest of the commands a comment, and a strip of that comment would change the command that runs. Check a comment in a folded `run:` block by hand, or write the block with `|`.

A shell comment in a `run:` block is part of the YAML value. So after the strip removes one, the proof of that file fails. Check its change by hand with `git diff -- <file>`: each line that changed must only have lost a `#` comment.

ast-grep's own suppression comment, `ast-grep-ignore`, hides comments from a scan. After code, it hides its own line. On its own line, it hides the next line, but the rule flags it. As the first line with a blank line after it, it hides the whole file. A rule cannot refuse it, because the suppression hides that rule too. So sage's lint command fails each changed file whose text holds `ast-grep-ignore` anywhere, as a whole file (see [The lint command](#the-lint-command)). `scripts/lint-rules.test.mjs` shows this limit of the scan. sage's own code that must hold the word, such as a test of this rule, builds it from parts, so that a change to the file passes lint.

## The lint command

sage's state tool checks a pull request with a project's own rules: `sage lint <T> --sha <sha>`. The chief runs it on the final head before the merge, and the merge check refuses a head without lint-pass. A project opts in with an ast-grep project file, `sgconfig.yml`, at the root of its main branch. sage's own `sgconfig.yml` names this rule set.

| Rule | Why |
| --- | --- |
| The rules, `sgconfig.yml` and `.gitattributes` come from the tip of `origin/main`, never from the head. | A pull request cannot weaken its own check, and a branch that started before a rule reached main gets that rule too, like a required check that applies the branch's current settings. |
| Only the lines that the head adds since its merge base with `origin/main` count, so a moved or an edited line counts. lint does not look for renames: a renamed file is a new file, so every line counts, under the rules of its new path. A rename with no match passes. | An old comment on a line that the pull request does not touch is not its problem. A rename can move a file into another language or into the `files` of a stricter rule, so its old lines need the rules of the new path. |
| lint runs at the root of the repository, also when you run it from a subfolder. | The root `sgconfig.yml` decides. |
| The scan reads a copy of the changed files, with the paths after `--`. | A file named like an option, such as `--off`, stays a path. |
| Each match on an added line fails, whatever its severity. lint reads the JSON matches, never the exit code alone. | A rule without `severity: error` exits 0 when it finds matches. |
| A changed file whose text holds `ast-grep-ignore` fails as a whole file. | The suppression hides lines from the rules. |
| A changed file that ast-grep skips (not UTF-8, too large), or one of more than 10 MiB, fails, by name. lint reads no file that it does not scan. | A skipped file is not checked, and a large asset with no rule does not stop lint. |
| A YAML file of more than 10 MiB in a rule or util folder of `origin/main` makes lint refuse, by name, with no verdict. | lint copies no larger YAML file, so the rules in it would not run. |
| A symbolic link, a submodule, a file marked `linguist-generated` or `linguist-vendored` in `origin/main`, and a file with no ast-grep language or no rule are not checked. lint lists each one by name. | They hold no code that the rules read. |
| With no `sgconfig.yml` at the root of `origin/main`, lint records nothing, and the merge check needs no lint verdict. The chief's lint offers this rule set (see [Adopt the rules](#adopt-the-rules)). With no `origin/main` and a root `sgconfig.yml` in the checkout, lint and the merge check refuse. | Like a required status check that a repository has not turned on; a repository that turned it on is never let through. |

lint runs ast-grep 0.51.1 from the `node_modules/.bin` at the root of the project's checkout when it is that version, else from sage's tools folder (`tools/` beside the logbook folders). With neither, it refuses and writes no verdict. It puts the pinned lockfile in the tools folder and prints the command that installs from it, which the chief runs only with the owner's yes.

## Adopt the rules

sage offers this rule set to a project that has no `sgconfig.yml` at the root of `origin/main`. Nothing reaches a project without its owner's yes.

1. The chief runs `sage lint <T> --sha <sha>` on such a project. The note opens one gate, the lint offer: add the rules, not now, or never for this project. sage recommends add; the default is not now.
2. Not now keeps the offer quiet for 30 days. Never keeps it away (`sage config lint_offer=never`), until `sage config lint_offer=ask`.
3. Add frames one small task. Its brief, `brief.md` in the task's pages folder, lists the project's languages: those of the files of `origin/main`, by extension, as ast-grep reads them (`languages.json`). A file marked `linguist-generated` or `linguist-vendored` adds no language.
4. The same yes covers ast-grep 0.51.1 in sage's tools folder, when the project has no copy at that version. sage puts its pinned `tools/package.json` and `tools/package-lock.json` there, and the chief runs `npm ci --ignore-scripts --prefix <tools folder>`, so npm installs only the pin and checks its integrity. sage installs nothing else.

The implementer of that task does these steps in the project, on a branch from `origin/main`:

1. Write a root `sgconfig.yml`:

   ```yaml
   ruleDirs: [lint/rules]
   utilDirs: [lint/utils]
   testConfigs:
     - testDir: lint/rule-tests
   ```

2. Copy `utils/` to `lint/utils/`. For each language of the brief that has a rule here, copy its rule to `lint/rules/` and its rule tests to `lint/rule-tests/`.
3. For a language with no rule here, write `lint/rules/no-comments-<language>.yml` and its rule tests, like the rules here: the language's comment kinds (`ast-grep run --lang <language> --pattern '<a comment>' --debug-query=cst` shows each kind), `severity: error`, the same message, the `spdx` util, and only the directives that a tool reads with no free text after them. Refuse a directive that demands free text.
4. Write `lint/README.md`: for each rule, the directives that stay. The message of each rule points to it.
5. Turn off each repository linter setting that requires a comment (the table below), and list each one in the pull request.
6. Run `ast-grep test --skip-snapshot-tests`, then `ast-grep scan --config sgconfig.yml .` on the whole tree. The scan does not check a file that ast-grep cannot parse: list each one in the pull request. Keep the comments that the code has now: lint checks only the lines that a later pull request adds.

| Language | Rule here | Settings that require comments |
| --- | --- | --- |
| Go | none yet | revive: the exported rule |
| Html | `no-comments-html` | none |
| JavaScript | `no-comments-js` | ESLint: jsdoc/require-jsdoc (eslint-plugin-jsdoc) and require-jsdoc |
| Python | none yet | Ruff: the D1 rules (D100 to D107) |
| Rust | none yet | rustc: missing_docs; Clippy: undocumented_unsafe_blocks |
| TypeScript | none yet | ESLint: jsdoc/require-jsdoc (eslint-plugin-jsdoc) |
| Tsx | none yet | ESLint: jsdoc/require-jsdoc (eslint-plugin-jsdoc) |
| Yaml | `no-comments-yaml` | none |

A language that is not in the table has no rule here and no known setting. `scripts/lint-offer.test.mjs` checks that this table matches `languages.json`, and that each extension there is the language that ast-grep 0.51.1 gives it. A rule that a project writes stays in that project. sage adds a language's rule here only when sage itself uses the language.

## Change the rule set

1. Add a case to the rule's test file in `rule-tests/`: `valid` for code that must pass, `invalid` for code that must be flagged.
2. Change the rule in `rules/` or `utils/`.
3. Run the rule tests (in sage: `npm run check`).

In sage, `scripts/lint-rules.test.mjs` also changes the rules in a copy, one mutant at a time, and checks that the rule tests fail for each mutant. When you change a rule, update its mutant there.

## In sage: the strip, the proof and the exclusions

`npm run check` scans sage's own sources (`packages/`, `scripts/` and `.github/`) with this rule set, through the `sgconfig.yml` at the root of the repository, which the lint command reads too. The root `sgconfig.yml` holds the same `languageInjections` as the rule set's own, and `scripts/lint-rules.test.mjs` fails when they differ. The code of the scan is in `scripts/lint-rules.mjs`. It fails on a comment, and on a file that ast-grep skips. When the check fails on a comment:

1. Commit your change.
2. Run `node scripts/strip-comments.mjs [path ...]`. It removes each comment that the scan flags, and keeps the allowed directives. A second run changes nothing. A path is relative to the current folder, or absolute. A path that is not there, or that is outside the repository, fails by name. A named file that `.gitattributes` marks `linguist-generated` or `linguist-vendored` is skipped, and the script names it, as the scan of a folder skips it.
3. Run `node scripts/comment-proof.mjs [base] [head]` (by default, from `HEAD` to the working tree). For each changed JavaScript or YAML file, it compares the code tokens and the minified code (for YAML, the parsed value). A deleted, added or renamed file fails, because a strip only edits files. A file of another type, such as `.json`, is "not proved", and does not fail the run. It must report 0 failed, except for a YAML file whose `run:` block lost a shell comment: check that file by hand (see [Limits](#limits)).
4. Put a reason that a reader needs in a name, a test name or a doc, never in a comment.

Both scripts work in the git repository of the current folder, and print its path. Outside a git repository, the strip fails and changes no file. `--help` gives the usage of each script. The scan skips `.git`, `node_modules` and the files that the repository's `.gitattributes` marks `linguist-generated` or `linguist-vendored`. It reads every other file, also a file that a `.gitignore` or `.ignore` file names, so that an ignore file cannot hide code from the check. The lint command skips the same `.gitattributes` files: the plugins, which the build makes, and these folders:

| Folder | Why the scan skips it |
| --- | --- |
| `scripts/fixtures/sage-14c0d0c/**` | A frozen copy of the state tool at commit 14c0d0c, which `scripts/sage.test.mjs` runs as the old version. Its text is test data. |
| `packages/sage-core/lint/rule-tests/**` | The rule set's own test cases. Their comments are the data that the rules must flag or pass. |

The scan reads code, not the text in a string. A script or a style that a page serves from a string, such as the board's page script, is not in the scan. So a test in `scripts/comment-sweep.test.mjs` renders each page that the board, a message and a move serve, and fails on a comment in its HTML, its scripts or its styles.

## Credits and licence

The rules run on [ast-grep](https://github.com/ast-grep/ast-grep) (MIT). They are part of sage, under its MIT licence.
