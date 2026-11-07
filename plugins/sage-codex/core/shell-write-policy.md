# Shared shell-write classification

`commandWrites(text, cwd)` identifies known shell write forms and reader options
that can run another program. It parses text without executing it. Non-text or
unreadable input counts as a write form.

`shellExecutionUncertain(text, cwd)` identifies executable stdin and uncertain
heredoc consumers. Codex combines this with known writes for its conservative
gate checks. Other callers keep their own execution rules and refusal reasons.

Executable-name checks ignore case and a trailing `.exe`, using the shared
normalizer. Reader-option parsing keeps the original arguments and option case.

The public core entry point exposes the same function in both provider bundles.
This component prepares shared rules for the Codex runtime. It does not change
the active Claude hook or install a Codex hook.

Ordinary reader arguments remain data. Option values, words after `--`, and
shell functions retain their parser context. Redirections to files count as
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

`writeParts(text, cwd)` gives the parts of a POSIX shell command list that a
caller judges, so that a read beside a write gives no evidence against it. It
drops the last commands of a pipeline when they are plain readers: a name of
the reader list or `git log`, `show`, `status`, `diff` or `rev-parse`, as a bare
word, with no write form of its own. `awk` and `sed` are not plain readers,
because their text can write a file. Every other command stays, and so does a
reader that feeds one. The redirection targets of a dropped reader stay too.
Undefined means that the caller judges the whole text: the line has a
substitution, a subshell, a group or control flow, a part uses `$` or a
backtick, a part can change what a reader's name runs (an alias, a variable, a
script of the same shell), a redirection is a zsh clobber form (`>!`), a part
names a file that a dropped reader wrote, or no part is left.

A false result is not permission to execute a command. This classifier does not
prove that an arbitrary program cannot write. Callers must also enforce role,
command, path, and workflow rules using verified execution context.
