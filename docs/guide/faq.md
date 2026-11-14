# FAQ and credits

The questions that people ask about sage, then the work that sage comes from. "I" and "my" on this page are the author.

## FAQ

**What does it cost?** It uses your Claude plan's usage limits, or API credits. Every agent is a separate run.

In [dry run 1](../runs/dry-run-1.md) (4 Oct 2026), a small bug fix with a security risk took 15 agent runs, about $2.60 at API prices, before the fixes that came from that run. I don't have numbers from real projects yet.

**Is it safe to let it work alone?** Each agent works in its own git worktree. Nothing reaches main except through a pull request, and the hook refuses force-pushes and merges by agents.

Autopilot is off until you send `autopilot on` alone, while sage mode is on. Text in an agent's report never turns it on; at worst it turns autopilot off, and then merges only wait. See [The limits of the hook](../design/rules-in-code.md#the-limits-of-the-hook) and [the known limits](../../SECURITY.md#known-limits) for what the hook does not stop.

**Which projects fit?** A project with tests and a GitHub remote.

- Without tests, QA can only check by running the app.
- Without a remote, the work stops at a verified branch.

**Does it work in Codex?** In part, and the work goes on.

In the Codex CLI and the desktop app, sage mode, autopilot, the logbook tools, the board phrases and the shared logbook with Claude work through the sage plugin. sage was checked with the CLI and with the desktop app's own Codex, not with the app's screens: the app's hook review and a child's approval prompt there are not checked yet. The chief starts one lead for each task, and the lead starts the implementer, the reviewers and QA.

A pilot ran a lead and its team with a test model. The PE, the designer and the arena have not run on a real task in Codex yet. See the [known limits](codex.md#known-limits-in-codex).

**How mature is it?** Early. I use it every day to build sage itself.

One dry run is recorded ([the report](../runs/dry-run-1.md)). The first design is in [docs/design/sage-mode.md](../design/sage-mode.md).

**Another program uses the board's port.** The board uses port 43123. When another program on the Mac uses it, `show board` says so and gives one command, for example `node <board folder>/cli.mjs board --port 43124`.

Run it in Terminal on the Mac, or ask the chief to run it. It moves the board to that port, keeps your other settings, and starts the board there. See [Change the board's port](board.md#change-the-boards-port).

**How do I stop a task?** Tell the chief in your own words, for example "stop the run on T3". To stop merges, send `autopilot off` alone.

See [Stop a running task](using-sage.md#stop-a-running-task).

**How do I uninstall it?** Follow the full steps in [Uninstall sage](using-sage.md#uninstall-sage). In short:

1. Stop the board server, its login service and the Remote Control server.
2. Remove `~/.local/share/sage-board`, if it exists. This also deletes the board's offline pages: copy each page that you want to keep first.
3. Remove the `"agent": "sage:chief-of-staff"` line from each `.claude/settings.json` that has it.
4. Run `claude plugin uninstall sage@sage`.
5. Run `claude plugin marketplace remove sage`.

Your logbooks stay.

## Credits

- **[pstack](https://github.com/cursor/plugins/tree/main/pstack) and poteto mode, by [Lauren Tan (poteto)](https://github.com/poteto).** sage's principles come from pstack, and sage mode takes its main ideas from poteto mode: the chief that never writes code, the brief, the ledger of verdicts by commit, the arena, and the trust ladder. I adopted pstack the day I found it, and I thank Lauren for it.
- **Sage Mode in *Naruto*, by Masashi Kishimoto**, gave the name and the look: a sage stays still and gathers the energy around it, as the chief gathers its team's work. The graphics and the toad sage mascot are original drawings, and no character from the series appears. sage is a fan's nod and is not affiliated with *Naruto* or its owners.
- **My [Orchestrator](https://github.com/erickb336/orchestrator)** taught the lessons that sage keeps in code.
- **[affectUI](https://github.com/flohoeller/affectui), by Florian Höller (adfects)**, MIT licence: some colour, shadow, radius and easing values of the board page come from its free items. The board copies no code, component or font.
- **Anthropic's and Cognition's writing on multi-agent systems** shaped the rules: one writer at a time, fresh reviewers, and evidence before a claim.
