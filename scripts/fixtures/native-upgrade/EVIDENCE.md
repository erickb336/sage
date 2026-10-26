# Native task-table upgrade evidence

This inventory supports T48 recovery across a task-table schema change.
Creation and review acceptance have the same defect as the previously repaired task updates.
No product decision is needed.

The rejected premise was: fixing the task-update planner covers every saved task-table write.

The first repair preserved update hashes but still used current transition rules.
The second repair selected historical transition rules but left other writers unchecked.
The common cause is replay through current serialization instead of the saved writer's columns.

The writer inventory in `packages/sage-core/state.mjs` is:

| Writer | Task-table behavior | Compatibility evidence |
| --- | --- | --- |
| `taskUpdates` (schema 6/8) | Saves tasks, runs and decisions | Eleven existing T48 upgrade tests |
| `taskWrites` (schema 2) | Saves tasks and decisions | Base-generated creation fixture and recovery tests |
| `reviewWrites` (schema 4) | Saves tasks, findings, ledger and decisions | Base-generated review fixture and recovery tests |
| `runWrites` (schema 3) | Saves runs only | No task-table after-image |
| `interruptedWrites` (schema 5) | Saves runs only | No task-table after-image |
| `usageWrites` (schema 7) | Saves runs and decisions | No task-table after-image |
| `finishReportedRun` | Writes runs and report files | No task-table after-image |
| CLI task writes | Reads legacy optional cells, then writes current columns | Existing legacy-table and approval tests |

Creation and review recovery both used current columns. Both need historical serialization.
The generator loads unmodified base source. Fixtures use disposable sample logbooks, never live native receipts.

The six creation and review tests cover completed receipts, pending writes and partial publication.
Before the repair, both completed receipts passed and all four pending cases failed validation.
After the repair, all six pass, together with the eleven earlier upgrade cases.
They check exact saved bytes, identical retries, later current writes and tamper rejection.
The review fixture also checks findings, ledger entries, spent rounds and the prior allowance.

Run this command from the repository to repeat the seventeen upgrade checks:

```sh
node --test --test-name-pattern='T48 upgrade:' scripts/task-adoption.test.mjs
```

The fixtures simulate a review and process interruption. They do not prove live controller behavior.
