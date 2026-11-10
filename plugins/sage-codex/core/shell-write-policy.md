# Shared shell-write classification

`commandWrites(text, cwd, scratch, { readOnly })` identifies known shell write forms and reader options
that can run another program. It parses text without executing it. Non-text or
unreadable input counts as a write form.

`scratch` is an optional list of absolute folders, such as the temp folder. A
redirection, or a gh clone or download (`ghTargets`), whose literal target is
in one of them, and not in `cwd` (the caller's project), does not count. Every other write form counts, also into a
scratch folder. A target with a variable, a pattern or `~`, or in a folder that
the reader cannot follow, counts. Both providers pass the temp folders for a
read-only role (T933, T936) and for the chief in sage mode (T948, T960), with
core's `CHIEF_SHELL` text.

A write program's name (`rm`, `tee`, `install`, `sed -i`, `uniq`) counts only
where the command runs that program, also through a wrapper that the reader
knows (`xargs rm`, `env rm`, `find -exec rm`). As an argument it is data, so
`npm install`, `man tee` and a state-tool note with `--why rm` write nothing
(F-T960-3). awk code counts when it prints into a file or a command, or runs
`system()` or a command into `getline` (F-T932-4); a print into `/dev/stdout`,
`/dev/stderr` or `/dev/null`, and a `>` in parentheses (`print ($1 > 3)`), do
not (F-T936-1). `chmod`, `chown`, `chgrp`
and `chflags` count only for a path in `cwd` (F-T933-1), so `chmod +x` of a
fake in scratch, or `chmod -R u+w ~`, does not.

`readOnly: true` is for a role that changes no files (T936). It adds the git
commands that change the checkout (`gitTargets`): `checkout`, `switch`,
`restore`, `reset`, `clean`, `apply`, `am`, `merge`, `pull`, `rebase`,
`cherry-pick`, `revert`, `commit` and `add` at their work tree (the `-C` folder
or the command's folder), except a dry run, `git apply --check` and `--stat`;
`branch` with a delete, move, copy, force or upstream option and `config` with a
change at the work tree (`--global` or `--system` in every folder); and
`worktree add`, `move` and `remove` at their paths. In a scratch folder, outside
`cwd`, they do not count, so `git worktree add --detach /tmp/r/head <sha>` and
git inside that worktree run. `--git-dir` and `--work-tree` count in every
folder. The chief's rule leaves `readOnly` out, so the chief's git runs (T960).

A scratch folder's target counts only outside the project: the main checkout of
the repository that holds `cwd` (the nearest `.git` entry; a linked worktree's
`.git` file names its main checkout). So a worktree in the temp folder is
scratch also when it is `cwd` (F-T936-5).

`gitDestroysWork(text, cwd, scratch)` is the chief's git rule (T968): true for
a git form that throws away uncommitted work at a work tree outside the scratch
folders: `reset --hard`, `checkout` with paths (after `--`, or `.`) or
`--force`, `switch --force` or `--discard-changes`, `clean` with `-f` (not a
dry run) and `restore` of the work tree (not `--staged` alone). A line that the
reader cannot read is false here; `commandWrites` counts it. Core's
`chiefShellProblem` (in `agent-rules.mjs`) calls both, and both providers call
it for the chief in sage mode, with core's `CHIEF_GIT` or `CHIEF_SHELL` text.

Executable-name checks ignore case and a trailing `.exe`, using the shared
normalizer. Reader-option parsing keeps the original arguments and option case.

The public core entry point exposes the same function in both provider bundles.
The Codex gate and the Claude hook both call it for a read-only role, with
core's `roleEditDenied`, the temp folders and `readOnly: true`.

The words of `gh` are its own arguments, so a word such as `PATCH` or `less` after `gh` does not count (`gh api -X PATCH`, T948); a redirection still counts.
`ghTargets` (in `output-writes.mjs`) reads the gh commands that write files
(F-T948-1, F-T948-5, F-T960-2), with gh's options before, between or after its
command words (`gh -R o/r release download`): `gh repo clone` and
`gh gist clone` (the folder that they name, or one named after the repository),
`gh repo fork --clone` and `gh repo create --clone` (a folder named after the
repository), `gh run download` and `gh release download` (the folder of `-D`,
the file of `-O`, or the command's folder), `gh attestation download` (the
command's folder) and `gh codespace cp` (a local destination). `gh extension install`,
`upgrade`, `remove` and `create` count in every folder. `gh pr checkout` does
not count: it changes the work tree as `git checkout` does.
The words of `git` are its own arguments too: of the write names, only
`git rm` and `git mv` count, so `git worktree add ../install` does not (T960);
the other git forms count only with `readOnly`. Ordinary reader arguments remain data. Option values and words after `--`
retain their parser context. Redirections to files count as
writes; input-only redirections and the listed standard device outputs do not.

`uniq` counts as a write only with an output operand (`uniq in out`), or
when the hook cannot count its operands: uniq is not the command word, or an
operand can expand to more words. `uniq in` and `uniq -c in` only read.

Known output-file programs also count as writes. These include curl output and
configuration options, Git diff/show/log output, OpenSSL output, and the ordinary
operands of ditto, scp, wget, and sqlite3. The curl scanner preserves option
case and skips known option values. Unknown curl and OpenSSL options count as writes.
The path check can permit an explicit scratch target while refusing a logbook
target. This does not inspect configuration files or prove sandbox protection.

Option references: [curl](https://curl.se/docs/manpage.html),
[Git diff](https://git-scm.com/docs/git-diff), and
[OpenSSL dgst](https://docs.openssl.org/master/man1/openssl-dgst/).

`readerDispatch(entry)` and `uniqWrites(words, base)` are the two classifiers
that `logbookWrite` (in `command-runs.mjs`) reuses: a reader with an option that
runs a program or writes a file, and `uniq` with an output operand.

A false result is not permission to execute a command. This classifier does not
prove that an arbitrary program cannot write. Callers must also enforce role,
command, path, and workflow rules using verified execution context.
