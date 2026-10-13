# Native command evidence

`readNativeCommand(transcriptPath, { sessionsDir }, expected)` recovers the
original `exec_command` arguments before execution. The caller authenticates
the hook and supplies the expected session, actor, parent, task path, turn,
call ID, and command text. The protected profile and its ancestors must remain
under the caller's control.

The reader requires matching native metadata for Codex CLI 0.160.0 and exactly
one pending call in the current turn. It refuses completed or interrupted turns,
results for that call, duplicate calls, conflicting identities, links, invalid
UTF-8, incomplete records, and transcripts outside the fixed session directory.
Errors omit filesystem details.

Command reads require a complete snapshot no larger than 16 MiB and 65,536
records. The existing header and initial-turn readers retain their 256 KiB
limit and ignore later content. Concurrent file or ancestor changes remain a
filesystem limitation; the reader does not authenticate arbitrary local writers.

The result preserves every original argument, including unknown fields. It is
evidence for a later decoder and policy check, not permission to execute.
Requested shell and directory fields do not prove the effective execution
environment or sandbox. This component installs no hook and enables no automatic
Sage workflow. The tests use synthetic native records and never execute their
command strings. Live native integration remains a separate verification step.
