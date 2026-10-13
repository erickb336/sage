# Direct patch policy

`patchEditDecision(input, context, options)` combines the chief edit rule with
logbook path protection. The caller authenticates the actor and mode, and supplies
fixed protected roots and the verified execution directory. This is a policy
component, not an installed entry point or a complete file policy.

An active chief cannot patch files. In other cases, every add, update, delete,
and both ends of a move must stay outside the protected roots. This protection
also applies when Sage is off. Invalid inputs and unknown patch structures
throw; the native decision boundary converts errors into denials.

The shared `fileWriteOutsideRoots` check resolves links before parent traversal.
It checks new targets, ancestors of a protected root, and case/Unicode variants.
It refuses a file with multiple hard links because another name can reach a
protected inode. It also refuses unreadable paths and link loops.
Path comparison is conservative on filesystems that distinguish case.

The target parser is separate from the advice hook's loose header extraction.
It distinguishes header-like file content from actual file targets. Codex still
validates and applies the patch. The policy never emits native `allow`; a pass
retains Codex's normal permission checks.

This extraction tests the packaged policy directly. It does not wire an installed
hook or prove native delivery, active-child editing, remote execution context,
concurrent filesystem changes, shell writes, or a complete automatic workflow.
