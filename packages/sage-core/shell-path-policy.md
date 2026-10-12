# Shared shell-path checks

`shellWriteOutsideRoots({ command, cwd, roots })` checks path evidence for known
shell-write forms. The caller supplies the original command, verified execution
directory, and fixed protected roots. The check copies validated roots without
using caller-supplied array methods. A true result grants no execution permission.

The check uses the shared write classifier and command reader. It checks literal
arguments, assignments, redirections, and directory changes against protected
paths. Literal '=' characters remain part of a file name; option and assignment
values also receive checks. Ordinary arguments to echo, printf, and jq remain data; their redirections
still need checks. Shell functions and wrappers do not receive this exception.

A final path segment can use bounded `*` and `?` patterns. Matching directory
entries, including links, receive path checks. Patterns in parent segments,
complex patterns, runtime variables, home syntax, and unknown directories refuse
the operation. Invalid context throws; unreadable command evidence returns false.

This is a static component, not complete shell enforcement. Arbitrary scripts can
construct paths that static checks cannot discover. Roles, command identity,
shell selection, and execution environment need separate checks. Filesystem
sandboxing remains necessary because concurrent changes can invalidate a snapshot.

The tests pass command strings to the parser only. This component does not change
the active Claude hook, install Codex enforcement, or activate automatic Sage.
