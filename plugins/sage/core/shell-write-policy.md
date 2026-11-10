# Shared shell-write classification

`commandWrites(text, cwd, scratch)` identifies known shell write forms and reader options
that can run another program. It parses text without executing it. Non-text or
unreadable input counts as a write form.

`scratch` is an optional list of absolute folders, such as the temp folder. A
redirection whose literal target is in one of them, and not in `cwd` (the
caller's project), does not count. Every other write form counts, also into a
scratch folder. A target with a variable, a pattern or `~`, or in a folder that
the reader cannot follow, counts. The Claude hook passes its temp folders for a
read-only role (T933).

Executable-name checks ignore case and a trailing `.exe`, using the shared
normalizer. Reader-option parsing keeps the original arguments and option case.

The public core entry point exposes the same function in both provider bundles.
The Codex gate and the Claude hook both call it for a read-only role, with
core's `roleEditDenied`.

The words of `gh` are its own arguments, so a word such as `PATCH` or `less` after `gh` does not count (`gh api -X PATCH`, T948); a redirection still counts. Ordinary reader arguments remain data. Option values and words after `--`
retain their parser context. Redirections to files count as
writes; input-only redirections and the listed standard device outputs do not.

`uniq` counts as a write only with an output operand (`uniq in out`), or
when the hook cannot count its operands: uniq is not the command word, or an
operand can expand to more words. `uniq in` and `uniq -c in` only read.

Known output-file programs also count as writes. These include curl output and
configuration options, Git diff/show/log output, OpenSSL output, and the ordinary
operands of ditto, scp, wget, and sqlite3. The curl scanner preserves option
case and skips known option values. Unknown curl and OpenSSL options count as writes.
The path check can permit an explicit scratch target while refusing a logbook
target. This does not inspect configuration files or prove sandbox protection.

Option references: [curl](https://curl.se/docs/manpage.html),
[Git diff](https://git-scm.com/docs/git-diff), and
[OpenSSL dgst](https://docs.openssl.org/master/man1/openssl-dgst/).

`readerDispatch(entry)` and `uniqWrites(words, base)` are the two classifiers
that `logbookWrite` (in `command-runs.mjs`) reuses: a reader with an option that
runs a program or writes a file, and `uniq` with an output operand.

A false result is not permission to execute a command. This classifier does not
prove that an arbitrary program cannot write. Callers must also enforce role,
command, path, and workflow rules using verified execution context.
