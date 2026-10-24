# Owned controller wrapper

The wrapper runs the native owned controller of the Codex fork for one Sage task. It launches the controller, checks the effective policy before any model turn, binds one task to one root thread, and keeps every notification and an honest result for each turn.

## What it does

- **Launch.** `resolveControllerBinary` reads only `SAGE_CODEX_CONTROLLER_BIN`: no default, no PATH lookup and no other variable. It refuses an unset, relative, linked, missing or non-executable path. It returns the sha256 of the file, and refuses a different hash when `SAGE_CODEX_CONTROLLER_SHA256` is set. The process runs `app-server --stdio --owned-controller --strict-config` with one `-c` flag for each key of `OWNED_CONTROLLER_CONFIG`. No other launch exists.
- **Policy binding.** `openThread` sends `config/read`, then `thread/start` with the project cwd, `ephemeral` true and the developer instructions. `bindPolicy` then checks that each owned key has its value from the session flags layer, that the thread is a 0.160.0 ephemeral root in the project, and that the model, provider, approval policy and sandbox of the thread are the ones in the owner's config. A refusal sends no `turn/start`, stops the process and returns `refused` with a fixed code. The policy record and its binding hash go with every turn result.
- **The owner's selection.** The wrapper never sends a model, provider, approval policy, sandbox, permission profile, environment list or tool list. The thread keeps the default environment, so the normal Codex tools run under the owner's own sandbox and approval setting. The owner's hooks stay on.
- **Events.** Every notification and every refused server request is kept in arrival order, with a sequence number, as frozen data. Past `maxEvents` or `maxEventBytes`, the process fences: a lost event never passes silently. A throw from `onEvent` fences too. No stderr text is kept.
- **Turn result.** `turnOutcome` decides from `turn/completed` of the bound thread and turn only: `completed`, `interrupted` or `failed`. A terminal that comes before the `turn/start` reply waits for it. Two terminals in one read give `uncertain`. EOF, a crash, an invalid frame, a fence or the event limit before a terminal give `uncertain`, never `completed`. At the turn deadline, and on `stop()` during a turn, the wrapper sends `turn/interrupt` first; with no terminal within `interruptGraceMs` the result is `uncertain`. An uncertain turn fences the process.

## What it refuses

- A second `openThread`, a second turn while one is active, and any turn after a fence or a stop.
- Every server request, with error -32601. So an approval request is a refusal: with an approval policy that asks, the command does not run.
- A task id, run id, project, instructions or turn text that fails the checks in `bindTask` and `bindTurnText`.

## What it does not prove

- That the binary that runs is the one that was hashed: a swap between the hash and the launch is not detected.
- That a terminal arriving after a result was given agrees with it. Only terminals in the same read are compared.
- That the native tool policy is safe for children (T391). The wrapper checks the launch profile, not the tool list.
- Real-model behaviour. The gated test in `controller-owned.test.mjs` uses a loopback synthetic provider.

## Checks

Run each test file alone with `node --test`, with fake `ps`, `pgrep` and `kill` first on PATH. `controller-owned.test.mjs` replays `controller-fixture.json`, which comes from the labelled synthetic U3 transcript and the `config/read` format of the real fork binary. Its two real cases run only when `SAGE_CODEX_CONTROLLER_BIN` names the built fork binary; `SAGE_CODEX_CONTROLLER_EVIDENCE` names a folder for their JSON evidence.
