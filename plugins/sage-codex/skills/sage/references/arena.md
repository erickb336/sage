# Run an arena

An arena gives one task to several candidates, each on its own branch. A judge then scores them, picks the base and grafts the best parts of the others onto its own new branch. Use it for a design with no clear answer, or when the user says "arena" or "arena N".

The steps come in the same order as in Claude Code. You run the arena yourself: in Codex the team is flat, so you also do the lead's work after it. Each `run_add`, `spawn_agent` and `run_done` goes as **Run the route** says in the chief's instructions, also with its `usage-interface`.

Frame the task with `task_add`, with `add: "arena"` and the reason as `why`.

## The rules

**A large task's arena is a design arena.** It stands for the route's design block, so start no other designer, and its order is arena, PE, the user's approval, build. A build arena runs only on a tiny or small task, or on a briefed task after an approved design.

**The arena step is open** while the route has the arena block or the task has a candidate run, and no judge of the task ended done. While it is open, the state tool refuses an implementer or designer `run_add` with no `candidate`. It also refuses `task_set` to verified or concluded, and `merge_check`. To close the step, finish a judge. For a task that needs no arena, abandon it and frame it again: `candidate` on a build's run marks the build's branch as a candidate's. An abandoned task has no open step, but its candidate's branch still never merges.

**A tiny arena has the code review,** because a judge's graft is new code that nobody read: `add: "arena"` adds it to the route. It has no QA, and its cycles follow from its route.

## The steps

1. **Write the rubric:** 3 to 6 criteria from the acceptance that a judge can grade. Record it with `log`, with `arena rubric` as `why`. The candidates do not see it.
2. **Start N candidates** (3 by default): designers or implementers, with the same brief and a different angle each.
   - Start at most three at one time. An `arena 4` runs in waves: start the next candidate when a slot is free.
   - A large task before briefed takes only designers: move a framed task first with `task_set`, `state` designing. A large task at briefed, after an approved design, may take implementers.
   - A candidate run opens the step on a task with no arena block, but the state tool refuses a candidate on a route with no code review, such as a tiny task framed with no arena.
   - For candidate k, call `run_add` with the role, `branch` `sage/t<n>-c<k>` and `candidate` k. The task name is `sage_<role>_t<n>_r<run>`. Give no model: the candidates differ by their angles.
   - Each brief names its branch, a worktree, the folder that `pages` prints and its page name: `<R>-artifact.html` for a designer, `<R>-artifact.diff` for an implementer. A candidate opens no pull request.
3. **Record each candidate:** save its report and end its run with its STATUS, then record its page with `pages` and `record`.
   - An artifact that is not committed does not count.
   - A candidate that ends blocked keeps its report, branch, head and partial files. Decide if its evidence meets the brief, and tell the judge.
   - To correct a candidate, add a new run on a new branch, such as `sage/t<n>-c<k>-2`. The old run stays.
4. **Start the arena judge.** For a build, first call `task_set` with `branch` `sage/t<n>-judge`. Then call `run_add` with the role `arena-judge` and that `branch`: the state tool refuses a candidate's branch. Start it with the output of `role.mjs arena-judge` and the task name `sage_arena_judge_t<n>_r<run>`.
   - Give the judge the rubric, the brief, each candidate's branch, worktree and report, its own branch, and whether the arena is a design or a build.
   - For a design, also give the folder that `pages` prints and the page name `<R>-final.html`, with the judge's run id as `<R>`.
   - The judge makes its branch from the chosen candidate's head, and it stops if the branch exists. It scores each candidate, picks the base, grafts the best parts of the others into it on its own branch, and checks the result. When all candidates converge, it keeps the shared shape.
5. **Record the judge's report,** then go on from its STATUS:
   - done: the arena step is closed. Show the user the judge's scores, base, grafts, rejections and empty candidates in one short message, from its RESULT. Then go to step 6 for a build, or step 7 for a design.
   - question: the candidates diverge on the product. The report gives both choices with a recommendation. Ask the user with `gate_add`, then add a new judge run on the same branch, with the resolved brief.
   - blocked, with no usable candidate: there is no winner and no result. Resolve the brief: start new candidates on new branches, or abandon the task.
   - blocked, because its branch exists: take a new name, such as `sage/t<n>-judge-2`, set it with `task_set` for a build, and add a new judge run.
   - failed: there is no result, and the arena step stays open. Do the same: a new judge run on a new name, set with `task_set` for a build.
6. **A build goes on from the judge's branch.** A Codex judge leaves the pull request to you: push its branch and open a draft pull request from it. Move the task one state at a time to briefed, building and reviewing, with `pr` on the last move. Then do the lead's work: the reviews and QA of the route check the branch like any build, and a repair needs no `candidate`. At verified, run `gh pr ready <n>`, then merge or tell the user as usual.
7. **A design goes to the PE.** The judge opens no pull request. It saves the final design in the pages folder, and its RESULT gives the page's path.
   - Record the page with `pages` and `record`. Run the PE with the judge's branch and page in its brief. Give its `run_add` no `branch`: a design arena's task has none, and a PE run on any other branch is refused.
   - Move the task to awaiting-you, through designing when it is framed. Then ask the user to approve the design with `gate_add`, and name the page in the question: the user reviews the page, not a branch.
   - After the approval, move the task to briefed. The build starts as for any approved design: one implementer, on a new branch from main (`sage/t<n>`), not on the judge's branch, so that the prototype and its sample data stay out of main. The implementer's brief names the judge's branch as the design to build.
8. **A candidate's branch never merges,** also for an abandoned task: `task_set` to verified and `merge_check` refuse it.
9. **Keep the evidence.** Candidate branches and pages stay until the user deletes them, and so does the judge's branch of a design. A merge deletes the branch that it lands: its commits are in main. Worktrees go at the end of the task.

## Limits

- The state tool refuses an open arena step at `task_set` and `merge_check`. A Codex chief opens a pull request with `gh`, and nothing refuses that command: the merge check refuses a candidate's branch later.
- The first real arena on Codex is the installed pilot. A synthetic test plays this flow, and it does not prove installed execution.
