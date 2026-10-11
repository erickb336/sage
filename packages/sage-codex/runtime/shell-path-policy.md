# Shell path policy

`shellPathDecision(command, options)` checks path evidence for known write forms.
The caller supplies the original command, verified execution directory, and fixed
protected roots. A pass from this component is not permission to run a command.

The shared check uses the existing write classifier and command reader. It checks
literal arguments, assignments, redirections, and directory changes. It resolves
links with the same protected-path check as direct patches. Reads remain reads.
Ordinary arguments to echo, printf, and jq are data; their redirections still need
a path check. Shell functions and wrappers do not receive this exception.

A final path segment can use bounded `*` and `?` patterns. The check inspects each
matching directory entry, including links. It refuses patterns in parent segments,
complex patterns, runtime variables, home syntax, and unknown directory evidence.
Unreadable paths also cause a denial. Case and Unicode comparisons are conservative.

This is a static component, not a complete shell policy. Arbitrary scripts can
construct paths that static checks cannot discover. State-tool access, agent roles,
command identity, shell selection, and execution environment need separate rules.
The caller must not substitute the hook directory for the execution directory.
Filesystem sandboxing remains necessary, including protection against link races.

The tests pass command strings to the parser only. They check protected paths,
links, directory changes, unresolved inputs, and ordinary project writes in both
provider bundles. They do not prove native enforcement or installed operation.
The known required-hook outage still prevents activation.
