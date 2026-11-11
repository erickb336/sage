# Make a program

The chief reads this page before it frames the tasks of a program. The sage skill has the program commands.

Make a program when one request needs two or more tasks for one goal, and at least one of them waits for another. Frame every task first, with its `--waits`, then propose once: `sage program propose --name "<name>" --goal "<goal>" --pilot <T> --tasks <T,T>`. Ask its breakdown gate in the task's one batch of questions, with the cost. The pilot builds and merges first; the design and PE of the other tasks may run meanwhile. Give each task its own pull request. After a change answer, propose again (`sage program propose <PG>`) and tell the user what changed. Tell the user when a task joins or leaves after the approval. When the pilot is abandoned, propose a new pilot; after a drop, take each task that has not ended out with `program=none`. The sage skill has the other program rules, and the tool refuses a wrong step and names the fix.
