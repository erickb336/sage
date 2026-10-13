# Verified child report inspection

`sage_read_report` lets a parent inspect its named child's final report. The server obtains the caller identity from the native connection. The caller supplies only the child's name.

The reader resolves the current owner, saved assignment, child, turn, and task hash. It verifies report provenance in the saved protected transcript. Required report fields must contain values, and status must be `done`, `blocked`, or `question`. The response includes the assignment identity and a SHA-256 hash of the exact report text.

Inspection can first reconcile terminal evidence through the completion adapter. A stop callback or reported status alone cannot complete an assignment. An interrupted assignment cannot supply a completed report. Once completion is recorded, repeated reads change no admission state. Sage off still permits inspection of preserved work.

The reader does not save report evidence, finish a logbook run, accept findings, or record a review verdict. A report describes the child's claims; it does not prove task success. Missing, changed, ambiguous, linked, or stale transcript evidence is refused. Durable receipts and later assignments remain separate work.

Run `node scripts/probe-codex-lifecycle.mjs --sage-report` with fake process tools first on PATH. The probe uses CLI 0.160.0, a temporary profile, and simulated responses. It checks the exact report identity and text hash through the packaged MCP tool, then removes the temporary profile. It does not establish installed automatic Sage or real-model behavior.
