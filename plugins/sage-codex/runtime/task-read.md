# Recorded task reads

`sage_read_task` lets the authenticated chief read one task from the fixed project logbook. The only input is `task`.
A saved owner can read while Sage is off. Children and unknown roots cannot read through this tool.

The result contains the exact task row and a SHA-256 `version` for that row alone.
The token does not cover runs, findings, reviews, branch HEAD or merge permission.
The locked read refuses pending task, run and review writes, corrupt tables and redirected receipt directories. It performs no recovery.

Run the isolated `--sage-read-task` lifecycle probe to check two native MCP reads with simulated responses.
It seeds one fixture task, compares exact rows and tokens, checks unchanged records and admission, and removes its temporary profile.
It creates no child and does not verify installed activation or real-model behavior.
