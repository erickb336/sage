# Security

sage runs agents on your machine, and it guards git and the logbook with a hook. A hole in it can let an agent do more than you allowed. This page tells you how to report such a hole.

## Report a vulnerability

Report it privately, through GitHub's private vulnerability reporting: open the repository's **Security** tab, then **Report a vulnerability**. Do not open a public issue or pull request for it.

Give the version (the commit), the steps that show the problem, and what an agent or a person can do with it. You get an answer on the report. sage is a project of one maintainer, so there is no fixed response time.

## In scope

- The sage hook (`packages/sage-claude/hooks/`): a way for an agent to push to main, merge, write the logbook, stop another agent, or read the board config, past a rule that the hook says it holds.
- The state tool and the merge check (`packages/sage-core/`): a way to make an unreviewed commit pass the merge check.
- The PR script (`sage-pr.mjs`): a way past its checks.
- The board server (`packages/sage-board/`): access from outside the Mac without the password, or a page that runs text from a logbook as code.
- The Codex plugin's hooks (`packages/sage-codex/`).

## Known limits

These are known, and they are not new reports:

- The hook stops mistakes and the usual habits of an agent, not an agent that acts on purpose. A script that builds a command while it runs can pass the hook. The sandbox for agents is planned and not built yet.
- An agent that holds your GitHub token can remove branch protection or merge a pull request. A separate GitHub identity for agents is planned and not built yet.
- A tiny task without a risk flag merges after its checks pass, with no review and no QA. The chief sets the size of each task.
- A raw TCP forward to the board server, such as an SSH tunnel, bypasses its sign-in. It is not supported.

The full list is in [Rules held in code](docs/design/rules-in-code.md#the-limits-of-the-hook).
