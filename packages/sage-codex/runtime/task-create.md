# Native task creation

The prepared `sage_create_task` tool lets the current root owner create a task
in the configured Codex logbook. It uses the shared state tool's size, risk, and
route rules. It does not initialize a project, create a run, approve a design,
start an agent, or change merge readiness. The installed manifest is unchanged.

The request has `request` (a UUID), `title`, `size`, `risk` (an array), `add`
(an array of extra blocks), and `why`. Extra blocks need a nonempty reason;
otherwise `why` must be empty. The server derives the owner scope from its
native connection and the current saved owner epoch. Arguments cannot select
an owner, project, or logbook. Children and unknown roots are refused.

A request UUID identifies one creation within that owner scope. After a lost
response, repeat the same request and fields. A retry returns the original
creation record, not the task's current state. Changed reuse is refused.
Use a fresh UUID for a distinct task. Tasks remain visible in the shared project
logbook. A recorded owner can create a manual task while Sage is off; this
creates no admission or dispatch permission.

The core writes the task, added-block decision, and immutable receipt under the
logbook lock. Partial writes retain a recoverable intent. Other writes and merge
checks refuse until the original request recovers it. Recovery refuses unrelated
table changes. Task creation shares the existing pending marker. Earlier versions with the
pending-review guard also refuse a partial creation, but cannot recover its
newer schema. Versions before that guard are not safe concurrent writers.
Use the same or a newer tool to retry the original request.

The route keeps all shared requirements. A large or investigation task can be
framed, but unsupported native roles still cannot run. Task creation does not
establish full automatic coordination. Use the prepared `sage_create_run` tool to record a run; see `run-create.md`.
Use `sage_read_task` and `sage_update_task` for versioned task changes; see
`task-update.md`.

Run `node scripts/probe-codex-lifecycle.mjs --sage-create-task` with fake process
tools first on PATH. It creates one task and retries through the actual 0.160.0
CLI. Direct reads verify one task, its risk and route, and one added-block
decision. An existing task and run remain as the lifecycle control. This uses
simulated responses in a temporary profile; it is not a real-project pilot.
