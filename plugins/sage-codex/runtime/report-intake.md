# Verified child report inspection

`sage_read_report` lets a parent inspect its named child's final report. The server obtains the caller identity from the native connection. The caller supplies only the child's name.

The reader resolves the current owner, saved assignment, child, turn, and task hash. It verifies report provenance in the saved protected transcript. Required report fields must contain values, and status must be `done`, `blocked`, or `question`. The response includes the assignment identity and a SHA-256 hash of the exact report text.

Inspection can first reconcile terminal evidence for the requested assignment through the completion adapter. It does not reconcile other children. A stop callback or reported status alone cannot complete an assignment. An interrupted assignment cannot supply a completed report. Once completion is recorded, repeated reads change no admission state. Sage off still permits inspection of preserved work.

`sage_record_report` saves the inspected report when the caller supplies its exact hash. Recovery proof binds the receipt to the verified assignment before the journal records it. A proof without a receipt grants no report authority. Exact retries preserve one receipt; conflicting evidence is refused. A saved receipt with valid recovery proof remains readable after native transcript removal.

Neither operation finishes a logbook run, accepts findings, or records a review verdict. A report describes the child's claims; it does not prove task success. Missing, changed, ambiguous, linked, or stale evidence is refused unless an exact saved receipt and valid recovery proof permit recovery. Later assignments use their saved turn, while the original child start still proves parent and path identity.

Run `node scripts/probe-codex-lifecycle.mjs --sage-report` with fake process tools first on PATH. The probe uses CLI 0.160.0, a temporary profile, and simulated responses. It checks the exact report identity and text hash through the packaged MCP tool, then removes the temporary profile. It does not establish installed automatic Sage or real-model behavior.

Run the same probe with `--sage-receipt` to verify persistence, exact-hash replay, and inspection after removal of the temporary child transcript. This route records one receipt and leaves the other admission records unchanged. It does not accept a verdict or enable installed automatic Sage.

## Follow-up reports

Each saved continuation names a distinct assignment, run and native turn on the same child.
The parent reads and records that assignment by its saved dispatch name.
The reader verifies the matching terminal record, task hash and final message.
It does not require a second child-start event. Initial assignments still require their original start turn.

Recovery proof binds the exact report receipt to that continuation.
A verified receipt remains readable after transcript removal and Sage off.
Changed hashes, foreign callers, wrong turns and mismatched report messages cannot replace it.
Reading or recording a report does not accept its claims, finish a logbook run or grant merge authority.
