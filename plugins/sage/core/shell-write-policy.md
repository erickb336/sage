# Shared shell-write classification

`commandWrites(text, cwd)` identifies known shell write forms and reader options
that can run another program. It parses text without executing it. Non-text or
unreadable input counts as a write form.

The public core entry point exposes the same function in both provider bundles.
This component prepares shared rules for the Codex runtime. It does not change
the active Claude hook or install a Codex hook.

Ordinary reader arguments remain data. Option values, words after `--`, and
shell functions retain their parser context. Redirections to files count as
writes; input-only redirections and the listed standard device outputs do not.

A false result is not permission to execute a command. This classifier does not
prove that an arbitrary program cannot write. Callers must also enforce role,
command, path, and workflow rules using verified execution context.
