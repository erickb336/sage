## Your steps in Codex

Your task name is `sage_lead_t<n>_r<k>`, where `<n>` is the number of your task. Give `project`, the absolute project folder of your brief, in each sage tool call.

**Start a helper.** Do these steps for each implementer, code reviewer, security reviewer, UX reviewer and QA agent:

1. Call `run_add` with `task`, `role` and `"usage-interface": "collaboration-tools"`. It prints the run id `R<k>`.
2. Run `node <role.mjs> <role>`, and keep the whole output.
3. Write the helper's brief, with the fields `GOAL` to `STANDING`. Call `brief` with the task name of step 4 and the whole brief. Fix each missing field.
4. Call `spawn_agent` in the `collaboration` namespace with:
   - `task_name`: `sage_`, the role with `_` for `-`, then `_t<n>_r<k>`, for example `sage_code_reviewer_t12_r41`. The gate refuses another role, another task and another form.
   - `message`: the whole output of step 2, a blank line, then the brief.
   - `fork_turns: "none"`. Give no agent type and no model.

**Wait and read.** Do not end while a helper runs.

1. Call `wait_agent` for the helper, and read its report.
2. Save the whole report with `pages`: `task`, `run`, and the report as `text`. It prints a path.
3. End the run with `run_done`. For a done run, give `"status": "done"`, `"usage": "unavailable"`, `"usage-source": "codex collaboration-tools"`, `"usage-evidence": "wait_agent gives no token count"` and the path as `report`. For another status, give `status` and `report`. For a helper with no report, give `"status": "failed"`.

**Record your task.** You record only your own task, with the sage tools. The shell refuses a write of the logbook.

- `task_set`: move `state` (briefed to building, building to reviewing, reviewing to verifying, repairing to reviewing), and set `branch` and `pr`.
- `finding_add`: give `task`, `source` (the role), `severity`, `summary`, `run` and `class`. Record one finding for each medium or high finding of a report, at its severity or above, before you end that run, add a next run of the role, record a verdict or move the task. Claude's hook checks this count (its gap rule), and the Codex gate does not, so this rule is yours to keep.
- `finding_triage`: `fix` for a finding to repair. `dismiss` only a low finding, with a `reason`. Report a medium or high finding that you think is wrong.
- `round`: start each repair with it. Start an implementer on the same branch for the keys that it names. After the repair's commit, call `finding_close` for each key, then move the task to reviewing, and start the roles that `round` named.
- `verdict`: give `task`, `kind` (`review-clean`, `security-clean`, `ux-clean`, `qa-pass`, `qa-fail` or `findings`), `sha`, `cycle`, `pr` and the `run` whose kept report backs it, after you end that run. The `checks-pass` and `checks-fail` verdicts are the chief's.

**The pull request.** A Codex implementer commits and reports, and it does not push. After its first commit, send the branch with `git -C <worktree> push -u <remote> <branch>`, open the pull request with `gh pr create`, and record the number with `task_set`. Send the branch again after each repair. A verdict needs the pull request. Never merge.

**Steer by a new agent.** The gate refuses `send_message`, `followup_task` and `send_input` from a lead, because each agent works only from its checked brief. To change a helper's work, close it with `close_agent`, end its run as failed, then start a new agent on a new run with a new brief. The gate also refuses `resume_agent`.

**Thread limit.** `AgentLimitReached` means that no thread is free. Call `list_agents`, wait for a helper that runs, close each helper whose report you saved, then call `spawn_agent` again with the same task name. When no helper runs and it still fails, end the run as blocked, and report STATUS blocked: the chief asks the owner to raise `agents.max_concurrent_threads_per_session`.

**Multi-agent v1.** A v1 child cannot start agents. When your tools have no `spawn_agent` in the `collaboration` namespace, report STATUS blocked at once: the chief does the lead's work.

**End.** Stop at verifying with a ready report, or report blocked and name what is left. The chief records the checks, moves the task to verified and merges.
