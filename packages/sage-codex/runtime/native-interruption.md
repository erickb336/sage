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
The native parent can now reconcile a bound interruption into the admission journal.
The saved terminal outcome is `interrupted`, with the evidence hash and exact child binding.
This releases capacity once. It preserves the reservation and does not finish the logbook run.
It cannot become an accepted report or a successful completion on retry.
The interrupted child loses Sage delegation authority. Sage off still permits ordinary tool use.

Recovery requires an existing verified binding and transcript reference.
Missing initial binding evidence, logbook repair scheduling, and installed automatic Sage remain separate work.
Run `node scripts/probe-codex-lifecycle.mjs --sage-interruption` for the native recovery check.
It prepares and binds a lead, holds its next model response, and calls the native interrupt tool.
The parent's next tool call reconciles the exact interruption without a stop callback.
The check compares the saved journal hash with the native transcript receipt.
It also checks that no report or verdict exists and that the logbook run remains open.
The model responses are simulated, and the fixture permits only its fixed interruption target.
This does not prove the full product command policy or installed automatic operation.
