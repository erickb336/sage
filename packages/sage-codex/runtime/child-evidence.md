# Native child transcript evidence

These readers inspect protected Codex 0.160.0 transcripts. The caller must first
verify native identity and provide the saved assignment. Reader results do not
grant permission, bind children, release capacity or change a logbook.

`readAssignmentTurn` requires the exact child, parent, author, recipient, turn
and task hash. It refuses duplicate delivery, missing context and conflicting
identity. The shared reader refuses linked, incomplete or oversized snapshots.
The full-transcript limit is 16 MiB and 65,536 records.

`readNativeReport` requires a retained native assistant message and matching
terminal event in that assignment's turn. A compaction summary cannot preserve
an earlier report. `readNativeCompletion` can return terminal evidence for an
invalid report, but that evidence does not make its report acceptable. With
`requireRecovery: true`, both readers require recovery before the final report.

`readNativeInterruption` verifies native interruption of the exact assignment.
It refuses conflicting success evidence. `readNativeFollowup` verifies one
accepted sender call and result with the expected target and message hash.
A successful sender call does not prove recipient delivery.

`readNativeRecovery` joins delivery and recovery in one protected snapshot.
Each new compaction invalidates earlier recovery. A matching native reader call
and result must restore the exact complete task after the latest checkpoint.
`readRecoveryOutput` verifies call provenance, identity, message hash and output
bounds. Each text item's replay cost is the ceiling of its UTF-8 bytes divided
by four, using the budget saved by the pinned native runtime. Combined output
must not exceed 1 MiB. Cumulative MCP attribution is not per-call provenance.

The extraction tests synthetic transcripts and saved output shapes. Earlier
native checks informed those shapes; this PR does not establish live delivery,
real-model recovery or installed automatic Sage. Runtime wiring, atomic state
transitions and the upstream required-hook outage remain separate work.
