# Shared shell-write classification

`commandWrites(text, cwd)` identifies known shell write forms and reader options
that can run another program. It parses text without executing it. Non-text or
unreadable input counts as a write form.

Executable-name checks ignore case and a trailing `.exe`, using the shared
normalizer. Reader-option parsing keeps the original arguments and option case.

The public core entry point exposes the same function in both provider bundles.
This component prepares shared rules for the Codex runtime. It does not change
the active Claude hook or install a Codex hook.

Ordinary reader arguments remain data. Option values, words after `--`, and
shell functions retain their parser context. Redirections to files count as
writes; input-only redirections and the listed standard device outputs do not.

Known output-file programs also count as writes. These include curl output and
configuration options, Git diff/show/log output, OpenSSL output, and the ordinary
operands of ditto, scp, wget, and sqlite3. The curl scanner preserves option
case and skips known option values. Unknown curl and OpenSSL options count as writes.
The path check can permit an explicit scratch target while refusing a logbook
target. This does not inspect configuration files or prove sandbox protection.

Option references: [curl](https://curl.se/docs/manpage.html),
[Git diff](https://git-scm.com/docs/git-diff), and
[OpenSSL dgst](https://docs.openssl.org/master/man1/openssl-dgst/).

A false result is not permission to execute a command. This classifier does not
prove that an arbitrary program cannot write. Callers must also enforce role,
command, path, and workflow rules using verified execution context.
