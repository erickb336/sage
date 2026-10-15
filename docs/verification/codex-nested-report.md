# T6: native nested report handoff

This fixture preserves the integration branch's lead → reviewer → chief report check on main. It verifies existing production APIs. It does not add orchestration policy or enable installed automatic work.

Run `node scripts/probe-codex-lifecycle.mjs --sage-nested-report` with fake process commands first on PATH and `SAGE_TEST_MACHINE_ID=native-fixture`. The fixture checks CLI 0.160.0 and uses an isolated profile with fixed simulated responses.

The fixture creates a temporary branch and commit, task T1, lead run R1, and reviewer run R2. It then checks:

1. The chief prepares and spawns the lead with its exact saved brief.
2. The lead prepares and spawns its reviewer against the actual branch target.
3. Both native children complete a successful harmless first tool before they can emit their reports.
4. The lead reads and records its own reviewer's report. It passes the immutable assignment and hash to the chief.
5. The chief records its lead's report and finishes R1. It inspects the nested receipt, checks ownership and exact text, then finishes R2.
6. The chief accepts one pinned review verdict and retries without changing the logbook or admission state.
7. Both protected transcripts match the saved briefs and parent identities. Exact report bytes attach only to the matching runs.

Tasks, findings, gates, and decisions remain unchanged. The task remains ineligible for merge. The fixture does not merge or push anything.

Four helper tests check foreign ownership, substituted receipts and text, denied first tools, and unchanged acceptance retries. They use simulated API results, so they do not prove production execution. Four existing report and review boundary tests supplement them. The eight focused checks pass:

```sh
node --test --test-name-pattern='nested report probe|report inspection refuses|T43: recorded report proof|T59: review acceptance rejects' scripts/codex-server.test.mjs
```

Removing the fixture's issuer check or exact receipt reference check makes the respective refusal test fail. Copying all four new test groups to detached main produces one missing-module load failure. This proves the helper is absent; it does not establish four historical production failures.

Native execution and the final full suite remain pending. The native route preserves bounded local evidence even when it fails. Fixed responses cannot prove real-model review quality, all workflow routes, installed activation, or the real-project pilot required by #88.
