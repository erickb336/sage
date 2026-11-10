# Logbook recovery

## The logbook check

One check guards the merge check and every write, `init` on an existing logbook too. Each of the seven tables must be:

- there (not deleted, and not a link to nothing);
- a regular file that the tool can read;
- not empty (not 0 bytes, and not only blank lines);
- with its header line: the first line names each of its columns. A BOM and CRLF line ends from an editor are read as a plain file.

A table that fails refuses every merge and every write, and the refusal names the file. No command makes a lost table again or repairs it in silence. The ways out:

- Restore the file from a copy.
- A table that cannot be read (EACCES): fix its permissions. Do not remove it: its rows are there.
- If no copy is left and the user accepts the loss: `logbook repair --accept-loss <table>`. Run the command that the refusal prints. When a second table fails too, the repair refuses and prints the command with both tables: run that one.

After a repair of tasks.tsv, the verdicts of its lost tasks stay in ledger.tsv. The merge check refuses their SHA, says that tasks.tsv was started again, and asks for a new commit with its verdicts under a task that the logbook has.

The programs table came after the others. A logbook made before it has no programs.tsv: that reads as a table with no rows while no task names a program, and `program propose` writes the file. When a task names a program and the file is missing, its rows are lost, as for any table.

Limit: a table cut to only its header line is a table without rows. The check cannot tell it from a new table.

A folder without tasks.tsv is no logbook: `init` has not finished it. `init` finishes it when its tables have no rows. When they have rows, its task list is lost, and `init` refuses: restore tasks.tsv, or repair it.

## A saved change that cannot finish

Each write starts by finishing or undoing a saved change that an earlier write left. Sage never drops a saved change by itself. When the change cannot finish, every write and merge of that project refuses with one line, and other projects go on. The line names two ways out:

1. **With a backup:** the owner restores the folder that `sage logbook` prints. Rows newer than the backup are lost.
2. **With no backup:** ask the owner in the chat to accept the loss of this saved change. After the answer, run `logbook repair --accept-change-loss yes`, or the owner runs it in a terminal when you cannot. This is the one step that passes a saved change, and it needs the owner's answer each time.

What the repair does:

- It works the same on a shared logbook, from any checkout with a row in `bindings.tsv`, also on a path through a link to that checkout.
- It refuses, and changes nothing, on a logbook with no saved change and on a saved change that can finish. Any write finishes that one.
- It also refuses, and changes nothing, when the change may still finish elsewhere, each time with the next step:
  - The logbook is reached through a link. The line names the real folder and the next step. When the logbook's path is the link itself, move the real folder there, in place of the link. When a folder above it is the link, set the setting that the line names, `SAGE_HOME` or, for a shared logbook, `SAGE_SHARED_HOME`.
  - A newer sage wrote the change: its schema is above the highest that this version knows, or a table has columns that this version does not know. Update the sage plugin.
- It writes a decision row first. The row names the kept file and says that the owner accepts the loss.
- It moves `review-pending.json` aside as `review-pending.json.lost-<n>`, and never deletes it. Each repair keeps its own file.
- It does not repair the tables, and it says so. A half-published update can leave mixed tables: some tables hold the change and others do not. Its output ends with the result of the logbook check.

Sage writes saved changes of two schemas only: 7 (usage) and 9 (Replace). Schemas 2 to 6 and 8 belonged to the Codex native runtime, which sage deleted (T732, T914). A saved change of one of them cannot finish, so it stops the writes of its logbook until the repair above. No readable logbook had one when sage deleted them.

When the check fails, the output prints the refusal, and the table repair above applies. The check reads each table alone, so tables that are each whole but do not agree pass it: read the rows of the last work.

When decisions.tsv fails the check, the repair cannot write its decision, and it prints the command that takes both losses: `logbook repair --accept-change-loss yes --accept-loss decisions`.

## The logbook command

| Command | Does |
| --- | --- |
| `logbook` · `logbook repair --accept-loss <table>[,<table>...]` · `logbook repair --accept-change-loss yes` | Prints the logbook's folder. `repair --accept-loss` starts each named table that fails the logbook check again, without rows. Run it only after the user accepts the loss of their rows. Name every damaged table in one command, joined by commas (`--accept-loss tasks,ledger`): a repair refuses when another table fails too, and names the command with both. The old file stays beside each as `<table>.tsv.lost-<n>`, and the decision trail records each repair before the table starts again. A named table that passes the check refuses the whole command. `repair --accept-change-loss yes` is the way past a saved change that cannot finish (see "A saved change that cannot finish"). After the owner accepts the loss, the chief runs it, or the owner runs it in a terminal when the chief cannot. In Codex, the chief cannot. On a shared logbook each form of `repair` names no chief, because it is the owner's act. |
