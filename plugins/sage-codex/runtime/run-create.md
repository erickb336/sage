# Record a native run request

`sage_create_run` records one run on an existing task. It does not dispatch a child or accept a review. Preparation, dispatch, report recording, and run completion keep their separate checks.

The authenticated chief supplies a UUID request, task, lowercase role, branch, and candidate. Use an empty string for an unused branch or candidate. The provider fixes the owner, project, and logbook location. The shared run frame enforces the CLI role, writer, lead-capacity, and investigation rules. The CLI still normalizes role text; this native request requires its canonical lowercase form.

A new request on a held task is refused. An exact historical retry returns its original run, including the saved model, round, and timestamp. It does not reopen a finished run or recompute those fields from current settings. Each authenticated owner has a separate request namespace.

The shared transaction engine saves the run append and its receipt under the logbook lock. Before recovery writes, a pure run validator checks the saved result and exact table append. Damaged records, conflicting receipts, redirected receipt folders, and unrelated table edits refuse publication. Run and task receipts both protect guarded snapshots against a transaction that finishes between table reads.

`--sage-create-run` uses a real CLI with simulated model responses and a temporary logbook. It creates and retries a task and run, dispatches one prepared child, records its report, finishes the run, and retries creation. It checks that the task remains framed and no verdict is accepted. Installed automatic operation and real-model decisions remain outside this probe.
