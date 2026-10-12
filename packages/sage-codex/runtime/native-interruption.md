# Native interruption evidence

The runtime can read evidence that Codex interrupted an exact assigned child turn.
This reader does not release a task slot or accept a report.

The caller supplies the saved assignment identity, task hash, and trusted transcript directory.
The reader checks one complete transcript snapshot and the original task delivery.
It accepts one `turn_aborted` event with the exact turn ID and reason `interrupted`.
It refuses a conflicting completion, duplicate interruption, or later response in that turn.
It preserves evidence when the child starts another turn.

An unfinished current turn returns `null`. Unsupported or inconsistent evidence throws an error.
The receipt contains the assignment identity, reason, and an evidence hash.
It contains no transcript path or task text.

The native diagnostic used Codex 0.160.0 with a simulated model response server.
The native interrupt tool returned `previous_status: running`; the child then had status `interrupted`.
Its transcript contained the exact turn ID and no successful completion.
No SubagentStop callback arrived. The native process exited and the temporary profile was removed.

Other abort reasons and Codex versions remain unverified.
Interruption recovery in the task journal and installed automatic Sage remain separate work.
