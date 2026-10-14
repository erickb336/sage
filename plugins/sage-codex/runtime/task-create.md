# Record a native task request

`sage_create_task` creates a task and its route decision in the configured logbook. It grants no run, child, review, or merge permission.

The authenticated chief supplies a UUID request and the task fields. The provider fixes the project, owner, and logbook location. Each owner has a separate request namespace. A retry with the same request and fields returns the original result. A changed request or a missing saved task is refused.

The core holds the logbook lock while it saves an intent, both tables, and an immutable receipt. The intent uses `review-pending.json`, the shared marker for guarded recorded writes. After an interrupted write, only the exact request can finish the saved publication. Recovery refuses unrelated table edits. This does not protect older installations that lack the pending guard.

Guarded snapshots compare receipt names before and after the table reads. They refuse pending writes and transactions that finish between those reads. Read-only aliases remain supported; mutation paths and receipt directories must be canonical. An empty logbook reader may return no task before a guarded snapshot. This grants no authority: a missing task cannot pass a merge check.

The native probe uses a real CLI and a temporary logbook with simulated model responses. `--sage-create-task` checks one task, one decision, an exact retry, and no run or dispatch. It does not enable automatic Sage.

Integration-only task updates and review acceptance still use the older recorded writer. They need separate domain validators before recovery publishes tables. Task and run creation use the validated writer. See `run-create.md` and `task-update.md` for those prepared APIs.
