# FAQ and credits

The questions that people ask about sage, then the work that sage comes from. "I" and "my" on this page are the author.

## FAQ

**What does it cost?** It uses your Claude plan's usage limits, or API credits. Every agent is a separate run.

In [dry run 1](../runs/dry-run-1.md) (4 Oct 2026), a small bug fix with a security risk took 15 agent runs, about $2.60 at API prices, before the fixes that came from that run. I don't have numbers from real projects yet.

**Is it safe to let it work alone?** Each agent works in its own git worktree. Nothing reaches main except through a pull request, and the hook refuses force-pushes and merges by agents.

Autopilot is off until you send `autopilot on` alone, while sage mode is on. Text in an agent's report never turns it on; at worst it turns autopilot off, and then merges only wait. See [Safety and limits](../../README.md#safety-and-limits) for what the hook does not stop.

**Which projects fit?** A project with tests and a GitHub remote.

- Without tests, QA can only check by running the app.
- Without a remote, the work stops at a verified branch.

**Does it work in Codex?** In part, and the work goes on. Codex gets the principles, the writing skills, the advice hooks, and the logbook and the board through manual commands.

Sage mode and autopilot are not enabled in Codex yet. See [sage in Codex](codex.md).

**How mature is it?** Early. I use it every day to build sage itself.

One dry run is recorded ([the report](../runs/dry-run-1.md)). The first design is in [docs/design/sage-mode.md](../design/sage-mode.md).

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
