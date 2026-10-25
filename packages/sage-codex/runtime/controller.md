# Owned controller wrapper

The wrapper runs the native owned controller of the Codex fork for one Sage task. It launches the controller, checks the effective policy before any model turn, binds one task to one root thread, and keeps every notification and an honest result for each turn. The terminal client puts the owner in front of it: each typed line is one turn.

## What it does

- **Launch.** `resolveControllerBinary` reads only `SAGE_CODEX_CONTROLLER_BIN`: no default, no PATH lookup and no other variable. It refuses an unset, relative, missing or non-executable path. It follows a link to the real path, and refuses the file, or a folder on that path, when its group or other users can write it, or when it belongs to a user other than the current user or root (a sticky folder such as `/tmp`, owned by root, is accepted). It returns the sha256 of the file, and refuses a different hash when `SAGE_CODEX_CONTROLLER_SHA256` is set. The process runs `app-server --stdio --owned-controller --strict-config` with one `-c` flag for each key of `OWNED_CONTROLLER_CONFIG`, in its own process group, with the real path of the project as its cwd. No other launch exists.
- **The launch profile.** The `-c` flags turn multi-agent v2 on, and multi-agent v1, goals, web search, plugins, apps and remote plugins off. The gated real test checks that the model gets no v1 tool (`send_input`, `resume_agent`) and no goal tool.
- **Policy binding.** `openThread` sends `config/read`, then `thread/start` with the project cwd, `ephemeral` true and the developer instructions. Each of the two requests has a deadline. `bindPolicy` then checks that each owned key has its value from the session flags layer, that the thread is a 0.160.0 ephemeral root in the project, and that the model, provider, approval policy and sandbox of the thread are the ones in the owner's config. The approval policy and the sandbox must be set, and must come from the user layer, a managed layer or the session flags, never from the project layer (an agent can write project files) or a default. The same rule holds for each key that changes the sandbox or where an approval goes: `sandbox_mode`, `sandbox_workspace_write.*`, `permissions.*`, `default_permissions`, `approval_policy`, `approvals_reviewer` and `auto_review.*`. A key that no layer sets comes from `config/read` as null with no origin: for the model and the provider that is the default, and for the approval policy and the sandbox it is a refusal that says to set it in the user config. A refusal sends no `turn/start`, stops the process and returns `refused` with a fixed code and a message that says what it found and what to change. The policy record and its binding hash go with every turn result.
- **The owner's selection.** The wrapper never sends a model, provider, approval policy, sandbox, permission profile, environment list, tool list, or a `turn/start` cwd or workspace root. The thread keeps the default environment, so the normal Codex tools run under the owner's own sandbox and approval setting. The owner's hooks stay on.
- **Events.** Every notification and every refused server request goes to `onEvent` in arrival order, with a sequence number, as frozen data. `events()` keeps them too: with an `onEvent` handler, only the events of the current turn (the handler keeps what it needs, so a long session does not grow); with no handler, every event of the process. `maxEvents` and `maxEventBytes` count from the start of the current turn; past them the process fences: a lost event never passes silently. A delta notification (such as `item/agentMessage/delta`, one for each streamed piece of text) does not count toward `maxEvents`, so a long valid turn runs on; `maxEventBytes` still bounds the deltas. A throw from `onEvent` fences too. No stderr text is kept.
- **Turn result.** `turnOutcome` decides from `turn/completed` of the bound thread and turn only: `completed`, `interrupted` or `failed`; any other status, also a name such as `constructor`, gives `uncertain`. A terminal that comes before the `turn/start` reply waits for it. Two terminals in one read give `uncertain`; a terminal for a turn that already has its result fences the process. EOF, a crash, an invalid frame, a fence or the event limit before a terminal give `uncertain`, never `completed`. At the turn deadline, and on `stop()` during a turn, the wrapper sends `turn/interrupt` first; with no terminal within `interruptGraceMs` the result is `uncertain`. An uncertain turn fences the process. `fenced()` resolves with the first fence reason.

## The terminal client

Run it from the built plugin, because `commands.mjs` needs the bundled core:

```sh
SAGE_CODEX_CONTROLLER_BIN=/absolute/path/to/fork/codex \
  node plugins/sage-codex/runtime/controller-client.mjs --project <folder> --task T400 --run R1 --instructions <file>
```

- Before it starts the controller, it checks the options, the binary, the project folder, the instructions file and the task and run ids. A refusal says what it found and what to do.
- It prints the binary path and its sha256, and a warning when `SAGE_CODEX_CONTROLLER_SHA256` is not set. Then it prints the task, the run, the model, approval and sandbox of the owner's config, each in quotes, and how to use the client.
- Each non-empty line is one turn, one at a time, sent unchanged. A line typed during a turn waits, and the client says so. `commands.mjs` classifies the line: the client says that a mode phrase goes to the chief, or that a near line changed no mode.
- It prints the agent messages of the root thread, each with `chief> ` before each of its lines, and each controller warning. An approval request names the command and says that it did not run. Each turn result says what happened and what to do next.
- Controller text never reaches the terminal raw. Each of these characters becomes U+FFFD: the C0 and C1 controls (a newline in a client line too), the bidi controls (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069), the zero-width characters (U+200B to U+200D, U+2060, U+FEFF) and the line and paragraph separators (U+2028, U+2029). So model text cannot move the cursor, write the clipboard, reorder what the owner sees or print a line that looks like the client's. A config value on the Ready line goes through the same filter, in quotes.
- Ctrl-C stops the active turn at once with a message. A line typed during that turn then runs, and the client says that it starts now. A second Ctrl-C stops the controller, also before the chief is ready. SIGTERM stops the controller. The end of the input (Ctrl-D) stops the controller after the lines already typed; during a turn the client says that Ctrl-C stops it now. After the end of the input or a stop, the result of a turn says that the controller stops now.
- A lost terminal (SIGHUP, or an EIO or EPIPE on the terminal) stops the controller at any time, idle or in a turn, and the client writes nothing more. The client writes to its terminal without blocking and opens stderr at its start: after a terminal closes (macOS), a blocking write and the first open of stderr wait for ever.
- The controller runs in its own process group, so a terminal Ctrl-C reaches the client only. The controller still ends with the client: the client stops it on every path, and a killed client closes its stdin, which ends the controller by itself (the gated real test checks this).
- The exit code is 0 only after a stop that the owner asked for (Ctrl-C, Ctrl-D or SIGTERM). A refusal, a crash, a fence, an unknown turn result or a lost terminal gives 1.
- The controller gets the client's environment, so it uses the owner's `CODEX_HOME`, config, hooks and login.

## What it refuses

- A second `openThread`, an `openThread` before the start, a second turn while one is active, and any turn after a fence or a stop.
- Every server request, with error -32601. So an approval request is a refusal: with an approval policy that asks, the command does not run.
- A task id, run id, project, instructions or turn text that fails the checks in `bindTask` and `bindTurnText`.

## What it does not prove

- That the binary that runs is the one that was hashed: a swap between the hash and the launch is not detected.
- That the native tool policy is safe for children (T391). The wrapper checks the launch profile and the root's tool names, not the children's tools.
- Real-model behaviour. The gated test in `controller-owned.test.mjs` uses a loopback synthetic provider.
- A bound on memory for a long session with no `onEvent` handler: then `events()` keeps every event of the process. The client gives a handler.

## Checks

Run each test file alone with `node --test`, with fake `ps`, `pgrep` and `kill` first on PATH. `controller-owned.test.mjs` replays `controller-fixture.json`, which comes from the labelled synthetic U3 transcript and the `config/read` format of the real fork binary. Its signal cases run the built client as its own process on a fake controller script, and send SIGINT to the process group of that client only. Its pty cases run the built client on a pseudo terminal (Python `pty.fork`, skipped when `python3` is missing) and close that terminal. Its five real cases run only when `SAGE_CODEX_CONTROLLER_BIN` names the built fork binary; `SAGE_CODEX_CONTROLLER_EVIDENCE` names a folder for their JSON evidence.
