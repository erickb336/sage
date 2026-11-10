# Several sessions on one project

- Several chief sessions may share one project's logbook. Each command that changes the logbook holds its lock while it runs.
- A command waits up to 3 s for the lock. Then it refuses with `the logbook is busy: pid <n> on <host> has held <path> for <n> s`, or with `<path> has no valid owner file`. Nothing changed: run the command again.
- The next command clears a lock that a crashed command left. A lock from another machine, a live process that is not sage, or an odd owner file stays. Remove the folder in the message only when no sage command runs.
- The next command also removes the temp folder (`.lock.<id>`) of a command that was killed while it waited.
- `status`, `logbook`, `standing` and `merge-check` take no lock. They work while another command runs.
- The sessions may run two versions of sage. A version refuses to change a logbook whose tables have columns that it does not know: its write would lose them. The refusal says to update the sage plugin and restart the session, and that `status`, `logbook`, `standing` and `merge-check` still work.
- A command refuses, before any change, when status.md or standing.md is not a regular file, also a link to nothing.
