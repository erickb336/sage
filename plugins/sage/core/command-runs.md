# The rules of the programs that a command line runs

`command-runs.mjs` holds the shared rules that judge the programs that a command
line runs, as the command reader (`programsRun`) sees them, and the literal paths
in their words, never free text (T815). The Claude hook uses them. The Codex
gate uses only `mergeRun` and the push readers until T903. None of them runs the
command that it judges.

- `logbookWrite(command, cwd, roots, home)` gives the word with which a command
  line writes into one of `roots` (the sage root and the shared root), or
  undefined. It judges a line with a write form (`commandWrites`): each word of a
  program that is not a reader, the value of a `key=value` or an
  `--option=value`, and each redirection's target. A word counts by its literal
  part, the text before its first `$`, backtick or pattern character, resolved
  from the program's folder (after a literal `cd`, `pushd` or `popd`) and through
  the links on disk; a word whose text holds a root's path counts too. In any
  line, a word of a program that removes, moves or locks a whole folder (`rm`,
  `mv` but its last word, `rsync --delete`, `find -delete`, `chmod -R` and the
  like) also counts when it names a root or a folder above one; for a pattern or
  a variable, the folder of its literal part counts. It throws on a loop of links.
- `stateToolRun(command, cwd)` gives each run of `sage.mjs` or `sage-pr.mjs`:
  node or the script itself as the program, and node's code or module that names
  one of them. A program that only reads the file is no run.
- `ghRuns(command, cwd, path, options)` gives each gh run's command words and,
  for `gh api`, its method (core's `ghApiMethod`, which the push rules use too).
  `AGENT_GH` and `agentGh` are the gh commands that an agent runs.

The merge rule is `mergeRun`, a method of `createCommandPolicy`, because it
needs the policy's pull request pattern for the one merge form. The policy's
`expansionProblem` refuses a pattern in a program word or in git's or gh's
command words, and an option before or between gh's first two command words.

A variable or a substitution in a program word or a path, a pattern in a path or
a plain argument after its literal part, code, a script and text piped into a
shell can build a path or a command while the line runs. These
are limits of the hook ([Rules held in code](../../docs/design/rules-in-code.md#the-limits-of-the-hook)),
and the sandbox is the full guard.
