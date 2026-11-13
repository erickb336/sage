# Security

sage runs agents on your machine, and it guards git and the logbook with a hook. A hole in it can let an agent do more than you allowed. This page tells you how to report such a hole.

## Report a vulnerability

Report it privately, through GitHub's private vulnerability reporting: open the repository's **Security** tab, then **Report a vulnerability**. Do not open a public issue or pull request for it.

Give the version (the commit), the steps that show the problem, and what an agent or a person can do with it. You get an answer on the report. sage is a project of one maintainer, so there is no fixed response time.

## In scope

- The sage hook (`packages/sage-claude/hooks/`): a way for an agent to push to main, merge, write the logbook or stop another agent, past a rule that the hook says it holds.
- The state tool and the merge check (`packages/sage-core/`): a way to make an unreviewed commit pass the merge check.
- The board server (`packages/sage-board/`): access from outside the Mac, or a page that runs text from a logbook as code.
- The Codex plugin's hooks (`packages/sage-codex/`).

## Known limits

These are known, and they are not new reports:

- The hook stops mistakes and the usual habits of an agent, not an agent that acts on purpose. A script that builds a command while it runs can pass the hook. The sandbox for agents is planned and not built yet.
- The hooks guard ordinary commands against honest mistakes, not disguised forms (T815, T909; standing order 70). They judge only the programs that a command line runs and the literal paths in their words, not free text. So these pass the hooks: a variable, a substitution or a pattern in a program word or a path (the literal part before the first expansion still counts); a wrapper program that the reader does not know, an alias and an unusual option order; a merge or a branch write through GitHub's API (`gh api`, GraphQL, `curl`, `wget`); a git or gh alias, an extension and a renamed copy of gh or Codex; a git setting that redirects a push, a git hook and a write under a `.git` folder; code (a script, `node -e`, `python -c`) that pushes, merges or builds a logbook path, and a file that a later command runs; text piped into a shell; a path through a link; PowerShell's own syntax; and gh settings that run another program. GitHub's protection of main, the merge check and the owner's phrases guard against deliberate tricks. The Codex gate follows the same rule (T903, T909): it refuses shell writes and patches into the Codex sage folder and the shared root by their literal paths, a read of them passes, and a logbook file's name in another folder passes.
- An agent that holds your GitHub token can remove branch protection or merge a pull request. A separate GitHub identity for agents is planned and not built yet.
- A tiny task without a risk flag merges after its checks pass, with no review and no QA. The chief sets the size of each task.
- A raw TCP forward to the board server, such as `ssh -L`, passes its check for a request from the Mac. It is not supported.
- The board has no sign-in. So any account or program on the Mac can read the board on 127.0.0.1: the tasks, gates, briefs and findings of every logbook. A request counts as from the Mac when it comes from a loopback address, with a loopback Host and no `Forwarded` or `X-Forwarded-*` header.

The full list is in [Rules held in code](docs/design/rules-in-code.md#the-limits-of-the-hook).
