# Shared protected-path checks

`fileWriteOutsideRoots({ paths, cwd, roots })` checks explicit write targets
against protected directories. The caller supplies trusted absolute roots and
the verified execution directory. Every target must remain outside those roots
and their ancestors. Invalid or unreadable evidence throws an error.

The check resolves symlinks before parent traversal and checks new targets whose
parents exist. It folds case and Unicode conservatively. A file with multiple
hard links is refused because another name could reach a protected inode.
Empty target lists are valid for context checks; protected roots must be present.
Each list has at most 4096 entries. Missing, inherited, or accessor entries are invalid.
The check copies validated values before it uses them; custom array methods cannot
remove roots or targets from the check.

This component adds a shared API to both provider bundles. It does not change
the active Claude hook or install Codex enforcement. Callers must enforce its
result and preserve native permissions. Concurrent filesystem changes can
invalidate a path snapshot, so filesystem sandboxing remains necessary.
