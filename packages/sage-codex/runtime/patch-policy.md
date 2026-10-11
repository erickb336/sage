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

## Native evidence

Run `node scripts/probe-codex-patch.mjs` with fake process tools first on PATH.
The probe uses a fresh temporary profile, fixed simulated model responses,
and the real policy through the native MCP hook.

- Default: Sage is off; an ordinary patch creates the exact expected file.
- `--protected-target`: Sage is off; the logbook patch is denied and the target stays absent.
- `--chief`: Sage is on; the chief's ordinary patch is denied and the target stays absent.

CLI 0.160.0 exposes a custom `apply_patch` tool. Its pre-tool hook uses the same
name and a single `command` string. Receipts confirm the evaluator's decision
and call identity. Denied routes have no file-change event or post-tool callback.

The native probe covers a fixed local execution directory. It does not prove
active-child editing, remote environments, concurrent link changes, shell writes,
other editing tools, real-model behavior, or installed automatic operation.
Filesystem sandboxing remains necessary. The known required-hook outage still
gates activation.
