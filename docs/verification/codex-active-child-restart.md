# T4: observe an active child across process restart

This probe gathers native CLI 0.160.0 evidence for issue #245. It does not change Sage policy or enable installed automatic work.

## Why a separate probe

The existing owner-turn probe resumes a root after each completed turn. Its `exec` process consumes stdin as the initial prompt. Closing that input is not a live transport shutdown test.

T4 uses the app-server stdio transport. Pinned source distinguishes [stdio connection closure](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/src/lib.rs#L1103-L1125) from [graceful signal draining](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/src/lib.rs#L239-L289). The [exec resume configuration](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/exec/src/lib.rs#L1337-L1360) identifies the existing root. These sources do not prove that an active child survives a restart.

## Separate observations

Run one mode per disposable profile:

- `node scripts/probe-codex-active-child-restart.mjs --clean-eof`
- `node scripts/probe-codex-active-child-restart.mjs --abrupt-loss`

Both modes require fake process commands first on PATH and `SAGE_TEST_MACHINE_ID=native-fixture`. They launch a validated Mach-O or ELF executable and require its exact version to be 0.160.0. An explicit `SAGE_CODEX_BIN` script is refused. Otherwise the harness resolves the installed npm package vendor executable without running its launcher. They use a local model-response fixture with no provider credentials.

1. Prepare T1/R1 through the actual MCP tool and spawn one native child.
2. Require its harmless tool to return exactly `{"resources":[]}`. Hold its next model response.
3. Require the parent registry to show that child running. Save the owner, assignment, binding, run, and transcript evidence.
4. For clean EOF, close stdin and await the tracked process's terminal event. A deadline is failure, never clean shutdown evidence.
5. For abrupt loss, signal only the fixture's tracked process handle. Record the actual terminal signal.
6. Open a fresh app-server connection in the same temporary profile. Resume the same root and observe the registry through a parent tool.
7. Compare admission and the logbook. A release requires an exact native interruption receipt. Never fabricate a report or finish the run.
8. Save bounded evidence before cleanup can change the failed phase. Await every owned handle before removing the disposable profile.

The probe records SessionStart availability and source, owner epoch, native turn data, and exact chief-instruction occurrence counts. It does not require these observations to match a completed-root probe. An absent SessionStart event remains an observation.

No direct child app-server input is allowed. This bounded route does not obtain a completed public report predecessor, so it does not attempt a continuation. Adoption by another root needs a separate design.

## Evidence limits

The helper tests cover transport closure, response identity, failure capture, symlink refusal, independent teardown, and the required resumed registry phase. They do not prove native shutdown or resume behavior. Separate native observations appear below.

These observations cover one fixed simulated route per mode. They do not establish behavior for other shutdown causes, versions, or task shapes. Process disappearance alone proves neither release nor restored execution.

The main suite loads these helper tests through `scripts/codex-server.test.mjs`. Run only the restart helpers with:

```sh
node --test --test-name-pattern="restart |EOF is not exit|abrupt loss signals|RPC close rejects" scripts/codex-server.test.mjs
```

No real-model judgment, installed activation, or cross-session authority transfer is verified.

## Initial launcher observations

The first two local runs used the npm `codex.js` launcher. Both resumed the same root with unchanged owner epoch and chief-instruction counts of `[1, 1]`. The resumed registry contained only the root. No child model request resumed. Parent reconciliation recorded one exact interrupted assignment; the run stayed open and no report was created.

The clean-EOF launcher exited with code 0. The launcher-loss run recorded SIGKILL on the Node launcher only. Its native descendant inherited stdio, so this is **not** an abrupt native-process test. The launcher forwards INT, TERM, and HUP, but cannot forward SIGKILL. Closed inherited pipes and a retained interruption record are indirect cleanup evidence, not a direct native process exit observation.

These captures remain separate historical evidence. The direct-native runs below supersede them for process-loss conclusions.


## Direct-native observations

Both modes ran on the installed Mach-O executable with its actual version checked as `codex-cli 0.160.0`. The fixture used simulated responses. Both captures completed, all tracked handles closed, and the temporary profiles were removed.

| Observation | Clean EOF | Direct native SIGKILL |
| --- | --- | --- |
| Original process terminal | Code 0, no signal | SIGKILL, no exit code |
| Child terminal record before stop | None | None |
| Child terminal record after stop | Exact `turn_aborted` | None |
| Child transcript during resume and reconciliation | Unchanged from after stop | Unchanged from before stop |
| Interrupted completion after parent reconciliation | One | Zero |
| Sage capacity released | Yes, from exact interruption evidence | No |
| Resumed registry | Root only | Root only |
| Resumed child model requests | Zero | Zero |

Both runs retained the same owner epoch and assignment history. Chief-instruction counts were exactly `[1, 1]` before and after resume. Both observed root SessionStart events with `startup` and `resume` sources. Neither changed the run, created a report, or attempted a continuation.

Clean EOF wrote the interruption before the new process resumed. Abrupt native loss left the child without a terminal record; parent reconciliation retained the reservation's capacity. Neither observation proves automatic child restoration.

To reproduce, set `SAGE_CODEX_BIN` to the installed native executable, not its JavaScript launcher. Put the test process-command directory first on PATH, then run each mode separately:

```sh
SAGE_TEST_MACHINE_ID=native-fixture env -u NODE_TEST_CONTEXT node scripts/probe-codex-active-child-restart.mjs --clean-eof
SAGE_TEST_MACHINE_ID=native-fixture env -u NODE_TEST_CONTEXT node scripts/probe-codex-active-child-restart.mjs --abrupt-loss
```

Each command prints the local capture destination and cleanup result. Raw isolated evidence stays local. A `verified` observation means the required phases completed; it does not mean the child survived or recovered.

The original 11 focused helper tests pass; the repaired candidate has 16 passing helper tests. Copying only their five test files onto detached main `bdd7aa2` produces five missing-module failures. That establishes absent harness APIs, not a repaired production regression. A separate mutant that treated EOF as terminal failed the existing terminal-event assertion.

## Optional child-load observation

`--abrupt-loss --load-child` preserves the base observation, then loads the recorded child through `thread/resume` after its immediate parent. It supplies no child input or configuration override. Only an exact saved turn reported as active permits `turn/interrupt`. Otherwise the fixture records the unmet condition. A displayed interrupted status is not a persisted terminal receipt. A second parent registry call reconciles only authenticated native evidence.

This route does not start a child turn or send a follow-up. The protected transcript and admission snapshots remain the authority for any release observation. The direct-native route completed after source review. Loading appended only a `thread_settings_applied` event. The returned saved turn displayed `interrupted`, so the fixture did not request interruption. The second registry contained the root and the recorded child as `pending_init`. No child model request resumed, no terminal transcript record appeared, and no completion receipt released capacity.

The capture completed and all tracked handles closed. This proves the bounded load observation, not child execution recovery. A timeout or transport error from an interrupt request is recorded as an unknown outcome, never an authoritative refusal.
