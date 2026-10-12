# Codex mode adapter

`updateOwnerMode(input, context, options)` connects native prompt identity, shared phrase rules, and the admission journal. The options are the configured `directory`, `project`, canonical `projectDirectory`, and trusted `sessionsDir`. Configure the admission store before use. Model arguments must not supply these options.

The adapter accepts only a verified root prompt in that exact project directory. It reads native metadata with the bounded identity reader and verifies the current MCP connection version and actor. Unrecognized identity returns `null`; storage and metadata errors throw. The hook entry must turn either failure into an explicit prompt refusal. Do not let a thrown error serve as the refusal.

The first on or off phrase, sent as the whole prompt, records session identity with its requested initial mode. An initial off stays off and leaves a durable receipt. Later on or off phrases use checked journal transitions. A neutral prompt keeps the saved mode. An exact repeated mode prompt returns current state without reapplying its old state. Conflicting reuse of a mode turn is refused. No prompt text is stored.

Journal session keys have the `codex:` prefix. The project key remains caller-configured. `readMode(directory, project, nativeSession)` reads that exact scope and returns its owner, mode records, and current Sage flag. It grants no tool permission; verify native context at the tool boundary first. Child role and task rights remain separate checks.

The returned autopilot flag is always false for the manual-merge Codex beta. A prompt switches only when it is exactly a shared phrase, as in the Claude hook. The result gives that phrase, or null, and `near`: the phrases to ask the user for after a near miss, for a clear user note. Changing mode does not release held reservations or prove child completion. A root that moves to another project directory requires explicit rebinding; this adapter does not transfer ownership automatically.

The installed manifest does not call this adapter yet. Production transport, role and lifecycle integration remain required before automatic Sage activation.


The prepared MCP owner route now calls `ownerPromptOutput`. It returns the shared
chief rules as native UserPromptSubmit context on the first on-turn after an off
record, or on the initial on-turn. A retry of that activation turn returns the
same rendered rules. Later ordinary prompts and repeated on requests in the same
active period return no extra context. Off-to-on starts a new delivery period.

The mode journal records intent, not confirmed delivery. If instruction rendering
fails after the mode write, the hook returns an error; retrying the same activation
can recover delivery. No separate delivered flag can suppress that retry.
A changed provider bundle needs separate upgrade handling; this does not promise
identical instructions across code versions. Compaction and restored-context
recovery remain unverified. The installed hook manifest remains unchanged.


Codex 0.160.0 spills large MCP hook context at its default 2,500-token estimate.
The prepared owner route therefore uses two authenticated handlers for the same
prompt: the default part and `instruction_part: 1`. Each part stays below 8,000
UTF-8 bytes, including its label. Splitting preserves the full shared text and
line boundaries. Oversized text fails instead of silently omitting later rules.
Both handlers must be configured and trusted; one response alone is incomplete.
The native probe checks both exact parts in order in the first model request.
This proves transport with simulated responses, not real-model understanding.

## Later owner turns in a resumed CLI session

Run `node scripts/probe-codex-owner-turns.mjs` with fake process tools first on PATH.
The isolated native check starts with an ordinary owner prompt, then uses explicit
`codex exec resume` calls for `sage mode`, `sage mode off`, and `sage mode`.
All four turns use the same native session. The saved owner epoch stays unchanged,
and three distinct turns record the requested mode changes. No child is dispatched.

The model receives both chief-instruction parts once on each activation. Earlier
instructions remain in conversation history after off; off does not erase that history.
The probe checks exact instruction-copy counts and an unchanged task logbook.

This uses actual CLI 0.160.0 with fixed simulated responses and a temporary profile.
Each CLI process exits before the next begins. The temporary profile is removed.
It verifies an otherwise idle resumed session, not active-child recovery, compaction,
a different session, the desktop app, full policy, or installed automatic Sage.
