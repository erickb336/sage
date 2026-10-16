# Verify an initial native child assignment

The composed Codex policy verifies an active Sage child's saved assignment before
it evaluates a tool. It can bind the child without an MCP SubagentStart callback.
The trusted connection supplies the child ID and runtime version. The configured
native session directory contains the transcript; the request cannot select that
directory.

The first native turn, root session, child, parent, path and exact prepared
message hash must match the current owner's reservation. The matching parent
spawn result must exist. Missing results retain the reservation. A validated
initial transcript reference permits later reconciliation work; it grants no
binding or permission by itself. A retry can bind after the result arrives.
The saved binding and transcript observation are idempotent.

Tool evaluation requires the current unfinished native turn. Completed, aborted,
replaced or ambiguous turns are refused. The policy checks that the turn is still
active after an awaited evaluator returns. The existing mode check also remains.
A valid binding does not make a denied tool pass or release capacity.

This extraction handles initial assignments only. Prepared later assignments,
completion, report intake, current logbook targets and compaction recovery remain
separate runtime integration work. It does not enable installed automatic Sage.
The supplied evaluator still owns tool permission rules.

Packaged tests use synthetic native transcripts and real local MCP connections.
They check exact delivery, missing-result retries, foreign metadata, linked paths,
terminal turns and a turn that ends while policy evaluation waits. They do not
prove real-model behavior or installed hook enforcement.
