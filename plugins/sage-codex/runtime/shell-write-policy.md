# Shared shell-write classification

`commandWrites(text, cwd)` classifies command forms that can write files.
Codex imports it through the public core entry point.
The rules come from the existing hook's write classifier and reader-option checks.
The current Claude hook remains unchanged while its active work continues.

The classifier detects file redirections, writer programs, in-place options,
interpreter code options, and reader options that can launch another program.
It uses the shared command reader to distinguish an actual reader dispatch from
option-like argument data and shell-function calls.
Unparseable text and non-string input count as possible writes.
A result of false describes only this classification; it is not permission to run a command.

The caller must supply the verified execution directory and apply the path,
logbook, role, and command rules. The classifier does not prove that arbitrary
scripts cannot write. It does not execute a command or inspect the process list.
The native role boundary uses a text-only call to deny known writes by read-only
roles. It supplies no inferred execution directory and grants no command permission.
The complete command policy still needs trusted execution context before activation.

Tests run both isolated provider bundles. They cover redirections, wrappers,
reader launch options, option values, function dispatch, and malformed inputs.
All test command strings go to the parser only.
