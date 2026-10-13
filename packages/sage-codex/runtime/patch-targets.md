# Direct patch target parsing

`patchTargets(patch)` returns the file names in the supported direct Codex patch
format. It includes add, update, and delete targets, plus both names of a move.
Content lines that resemble file headers remain content.

The parser accepts LF and CRLF line endings. Missing patch markers, unknown
records, misplaced moves, control characters or trailing whitespace in targets, and oversized input
throw a fixed error. It never applies a patch or writes a file.

This component is separate from the advice hook's loose header reader. A caller
must check every returned target against its path and role rules. Parsing alone
grants no edit permission. Codex still validates the complete patch when it
applies it; this reader does not replace that validation.

The component does not install a policy hook or activate automatic Sage. Native
application, filesystem changes, and composed authorization are separate checks.
