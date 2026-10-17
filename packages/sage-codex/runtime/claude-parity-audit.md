# Claude parity audit for issue #88

Prepared Codex components now support owner activation, context restoration, assignment delivery, report intake and exact-target review operations. Full automatic Sage remains disabled. This audit describes repository contracts and bounded diagnostic evidence, not a live Claude comparison or installed Codex pilot.

The installed skill-led workflow uses explicit instructions and manual coordination. It does not supply persistent automatic enforcement. Prepared components require isolated configuration and verified native identities; their existence does not make the installed workflow automatic.

| Area | Claude baseline | Prepared Codex capability and remaining limit |
| --- | --- | --- |
| Owner activation | The hook checks owner text, changes mode and delivers chief instructions | [Owner mode](mode.md) and [instruction delivery](chief-output.md) exist. Native ordinary/on/off/on delivery is verified with simulated responses; installed automatic activation remains disabled. |
| Off | The mode hook clears Sage, instruction-given and autopilot flags; direct chief edits resume | Off stops new chief instruction delivery and ordinary role restrictions. It does not interrupt agents. Tracked terminal turns still cannot use tools; terminal evidence remains readable. |
| Compaction | PostCompact clears instruction-given; the next prompt restores chief instructions | [Prepared restoration](compaction.md) exists for supported local native compaction. Other recovery contexts and installed use remain unverified. |
| Chief authority | The chief delegates file edits; the state tool writes the logbook | Role restrictions and [patch checks](patch-policy.md) exist. The full evaluator, all write paths and trusted execution context remain incomplete. |
| Routes | Shared chief rules choose routes by size and add risk reviews | Shared routes, task states and product gates remain the target. All routes and unanswered-gate handling still need complete workflow enforcement. |
| Brief and assignment | Ten brief fields precede dispatch | [Preparation](preparation.md), saved instructions and exact dispatch/delivery joins exist. A receipt alone grants no dispatch authority or proof of model application. |
| Roles and limits | Chiefs start leads; leads start permitted children within shared limits | Shared admission and prepared native role checks exist. Installed enforcement and full lifecycle recovery remain incomplete. |
| Native start and continuation | Hooks bind slots and handle results and failures | [Child binding](child-binding.md) and [continuation binding](native-followup.md) join exact saved identities. Transport diagnostics establish selected routes, not every race or installed operation. |
| Report stop | One incomplete report blocks; the next stop avoids an endless loop | [Completion](child-stop.md) keeps bounded correction separate from report acceptance. A terminal result does not validate an incomplete report. |
| Slot release | Stop, failed dispatch and registry reconciliation release slots; leases also exist | Exact native terminal and failed-start evidence can settle assignments. [Interrupted-run closure](interrupted-run.md) records an explicit non-success ending. Abrupt loss remains #246. |
| Reports and verdicts | The chief records reports, findings and exact-head verdicts | [Report intake](report-intake.md), durable receipts, run finishing and [review acceptance](review-acceptance.md) exist. Claims do not directly certify task success. |
| Reviews and repairs | Shared rounds, holds and clean cycles apply; a new head restarts cycles | Shared state checks and [authenticated task updates](task-update.md) exist. Full required-cycle workflows and real-model review quality remain unverified. |
| Manual merging | Autopilot starts off; verified work waits for owner merge | Manual merging remains the first automatic-workflow target. Prepared Codex policy does not authorize merges. |
| Autopilot | Explicit owner activation enables exact-commit merge checks; children never merge | Prepared Codex autopilot stays false. A separate verified delivery step is required for parity. |
| Board and status | Shared board and status routes show source-qualified questions | The board model and manual skill routes exist. Installed automatic phrase delivery remains unverified. |
| Arena and models | Shared chief rules describe candidates and judges; the provider binds model settings | Preserve the shared workflow with Codex model settings. A complete real-model arena pilot remains unverified. |

## Evidence and its limits

The prepared handlers in `chief-output.mjs` render the shared rules. `mcp-server.mjs` consumes verified owner prompts and supported compaction events. The [restoration contract](compaction.md) distinguishes local manual and automatic compaction from remote, child and cross-session recovery.

These merged units provide bounded evidence. Their original reports retain their own execution results; this audit adds no new test counts or native runs.

- [PR #261](https://github.com/erickb336/sage/pull/261): four resumed owner turns observe both exact instruction parts. Off retains earlier context without another injection. One owner epoch remains stable after activation.
- [PR #263](https://github.com/erickb336/sage/pull/263): three native patch trials verify an ordinary off-mode write, a protected-path refusal and a chief-role refusal. The fixture supplies a fixed local working directory and protected logbook root. The protected target also lies outside the writable workspace; exact Sage denial evidence distinguishes the observed refusal from file absence alone.
- [PR #257](https://github.com/erickb336/sage/pull/257): authenticated task updates coordinate logbook publication with admission decisions, recovery and task generations. Historical retries do not restore old state or certify current readiness.
- [PR #259](https://github.com/erickb336/sage/pull/259): tracked terminal child turns cannot regain tool authority after Sage off. Permission refusal does not fabricate completion or release capacity.
- [PR #249](https://github.com/erickb336/sage/pull/249): prepared nested report transfer supports the lead-to-reviewer route. Report transport does not prove independent review quality or a complete review cycle.

Native diagnostics use CLI 0.160.0, temporary profiles and fixed simulated responses. Exact request bytes, hook identities, tool results and artifacts support their stated claims. Instruction delivery is not model application. Report inspection, run completion, review acceptance and task verification are separate operations.

## Remaining activation requirements

[Issue #88](https://github.com/erickb336/sage/issues/88) still requires the complete evaluator, all task routes, unanswered product gates, full review/repair cycles and real-model and installed pilots. The [automatic workflow design](automatic-workflow-design.md) remains the target, with manual merging first and gated autopilot later.

These specific gaps remain open:

- [#239](https://github.com/erickb336/sage/issues/239): project-wide PR ownership.
- [#243](https://github.com/erickb336/sage/issues/243): trusted effective execution context. Fixed local patch fixtures do not supply a general native producer.
- [#246](https://github.com/erickb336/sage/issues/246): authoritative settlement after abrupt process loss. A timeout, lease or signal alone is not completion evidence.
- [openai/codex#41979](https://github.com/openai/codex/issues/41979): required-hook failure handling. The prepared policy cannot enforce a rule when the required hook does not run. Disconnection evidence does not establish every absent, untrusted, timed-out, malformed or reload case.

## Interpretation and cleanup

Parity means the same owner experience, routes and shared rules through each provider's supported transport. It does not mean copying Claude metadata, tool names or process leases into Codex. Claude source descriptions here are not live Claude verification.

The second report-stop escape prevents a loop; it does not validate missing fields. Native stop evidence and capacity accounting do not accept a report's claims. Mode-off and explicit cancellation remain distinct.

Run diagnostics only with fake process tools first on PATH. They use isolated profiles and do not change trust in the owner's profile. Use the owning diagnostic's instructions and preserve evidence when a check fails.

Current owner-turn and patch probes track version and execution processes from launch; their setup helper owns and awaits its setup process. Cleanup waits for actual closure and closes response transports and servers. It preserves failed evidence and reports incomplete cleanup. A timeout or signal alone never proves exit. These helper guarantees do not establish abrupt-loss recovery for installed Sage.
