# Finish an interrupted run

The Codex chief can finish a logbook run from its saved interruption evidence. Interruption alone releases admission capacity and leaves the run open. This explicit operation records a non-success ending so eligible later work can proceed.

Call `sage_finish_run` with this input:

```json
{"outcome":"interrupted","run":"R1","status":"blocked"}
```

The chief selects `blocked`, `question`, or `failed`. The run ID comes from `sage_create_run` or the saved preparation. The tool does not accept `done`, caller-supplied evidence, or a child identity. The existing `{assignment, reportHash}` form still finishes runs from recorded reports.

The adapter requires the current chief, fixed project and logbook, exact owner epoch, saved assignment, binding, run target, and authenticated interruption receipt. A chief can consume a nested child's saved receipt. It cannot impersonate the parent to create missing interruption evidence.

The operation changes only the matching run's status and ending time. Its report field stays empty. The result includes the assignment and evidence hash. It creates no report, finding, verdict, or task transition, and grants no merge permission. Later task metadata can change; the run must still match its saved identity.

## Concurrent work and recovery

A temporary admission record protects the interrupted actor's historical team while the run ending is saved. Admission checks and this record use the same atomic journal publication. An active descendant, unbound dispatch, or conflicting continuation prevents closure. While closure is pending, new work cannot wake or extend that team.

The logbook operation holds its lock, saves a validated ending receipt and run update, then acknowledges that exact receipt in admission. A failed publication retains the pending record. Retry the identical request to recover; changing the status or evidence cannot clear it. No timeout silently releases it.

An identical completed retry returns the original ending time and evidence without changing later work. After acknowledgement, ordinary admission rules can permit eligible child reuse. Missing or conflicting saved state is damage, not permission to rewrite history.

## Verification scope

T63 tests cover the provider tool, logbook recovery, and admission races. The native `--sage-interruption` probe checks explicit closure, an unchanged retry, and replacement-run creation through packaged tools. Run tests and probes with fake process commands first on PATH.

The native probe uses simulated model responses. It does not prove real-model judgment, cross-session transfer, complete installed policy, or automatic Sage activation. Independent review and final-commit checks remain required before release.
