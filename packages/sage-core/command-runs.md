# The rules of the programs that a command line runs

`command-runs.mjs` holds the shared rules that judge the programs that a command
line runs, as the command reader (`programsRun`) sees them, and the literal paths
in their words, never free text (T815). The Claude hook uses them. The Codex
gate uses `mergeRun`, the push readers and `logbookWrite`, with its own roots
(T903). None of them runs the command that it judges.

- `logbookWrite(command, cwd, roots, home)` gives the word with which a command
  line writes into one of `roots` (the sage root and the shared root), or
  undefined. It judges a line with a write form (`commandWrites`): each word of a
  program that is not a reader, the value of a `key=value` or an
  `--option=value`, and each redirection's target. A word counts by its literal
  part, the text before its first `$`, backtick or pattern character, resolved
  from the program's folder (after a literal `cd`, `pushd` or `popd`). Only the
  roots are resolved through links: a word is judged as written, so `rm` of a
  link to a root removes the link and passes. A word whose text holds a root's
  path counts too. In any line, a word of a program that removes or moves a whole
  folder (`rm`, `mv` but its last word, `rsync --delete`) also counts when it
  names a root or a folder above one; for a pattern or a variable, the folder of
  its literal part counts. `chmod`, `chown`, `chgrp` and `chflags` with `-R`
  count in any line when a word names a root or a path in one, not a folder
  above one. `find -delete` counts only as a write: a word in a root.
- `stateToolRun(command, cwd)` gives each run of `sage.mjs` or `sage-pr.mjs`:
  node or the script itself as the program. A program that only reads the file
  is no run.
- `ghRuns(command, cwd, path)` gives each gh run's command words and, for
  `gh api`, its method (core's `ghApiMethod`).
  `AGENT_GH` and `agentGh` are the gh commands that an agent runs.

The merge rule is `mergeRun`, a method of `createCommandPolicy`, because it
needs the policy's pull request pattern for the one merge form.

These rules guard the common forms against honest mistakes (standing order 70).
A wrapper program that the reader does not know, a variable or a substitution in
a program word or a path, a pattern in a path after its literal part, a path
through a link, code (`node -e`), a script and text piped into a shell can build
a path or a command while the line runs. These
are limits of the hook ([Rules held in code](../../docs/design/rules-in-code.md#the-limits-of-the-hook)),
and the sandbox, GitHub's protection of main and the merge check are the guards.
