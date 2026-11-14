## Your steps in Codex

Your task name is `sage_lead_t<n>_r<k>`, where `<n>` is the number of your task. Give `project`, the absolute project folder of your brief, in each sage tool call. When your task is framed, move it to briefed, then to building, with `task_set` before your first helper.

**Start a helper.** Do these steps for each implementer, code reviewer, security reviewer, UX reviewer and QA agent:

1. Call `run_add` with `task`, `role` and `"usage-interface": "collaboration-tools"`. For an implementer, also give `branch`, the task's branch. When the task has no branch, set it first with `task_set`. It prints the run id `R<k>`.
2. Run `<node> <role.mjs> <role>`, and keep the whole output.
3. Write the helper's brief, with the fields `GOAL` to `STANDING`. Call `brief` with the task name of step 4 and the whole brief. Fix each missing field. The gate starts the helper only in the 30 minutes after this check.
4. Call `spawn_agent` in the `collaboration` namespace with:
   - `task_name`: `sage_<role>_t<n>_r<k>`, with `_` for `-` in the role, for example `sage_code_reviewer_t12_r41`. The gate refuses another role, another task and another form. A name with no run still starts, but sage keeps no report for that run, and no verdict can use it, so always give the run.
   - `message`: the whole output of step 2, a blank line, then the brief.
   - `fork_turns: "none"`. Give no agent type and no model.
   - `reasoning_effort`: the level after `reasoning_effort` in the output of step 1, for example `"medium"`. When step 1 printed none, give no `reasoning_effort`.

**Wait and read.** Do not end your turn while a helper runs: a helper's report starts no turn, so you would never read it.

1. Call `wait_agent`. It takes only `timeout_ms` (at most 3600000, one hour), and it has no target. It wakes on any message or at the time-out, and it returns no report. The report comes as a message in your next input, with the helper's path as its sender. Call `wait_agent` again until that helper's report comes.
2. Save the whole report verbatim with `pages`: `task`, `run`, and the report as `text`. Preserve Markdown, spaces and newlines. It prints a path and `sha256`. Known retained text must match before the first save. A mismatch or damaged capture leaves the page unsaved. Do not reconstruct the report or overwrite an existing page. Missing capture still cannot back a verdict.
3. For a review or QA, record the report's findings (step 1 of **A report with findings**).
4. End the run with `run_done`. For a done run, give `"status": "done"`, `"usage": "unavailable"`, `"usage-source": "codex collaboration-tools"`, `"usage-evidence": "wait_agent gives no token count"` and the path as `report`. For another status, give `status` and `report`. For a helper with no report, give `"status": "failed"`. At the helper's stop, the report gate kept its token count from its session record, and `run_done` records that count; `usage` unavailable stands only when the gate kept none.

**Record your task.** You record only your own task, with the sage tools. They ask for no approval. The shell refuses a write of the logbook. `finding_move` stays the chief's tool: name a finding to move in your report.

Use `status` for a logbook read, or the trusted literal command form in [commands](commands.md). Scoped task reads require the hook's absolute Node executable, this provider's absolute CLI and the assigned absolute project. A refused incidental action does not cancel independent allowed work; stop that action without another shell form.

- `task_set`: give `task` and `fields`, with string values, for example `{"task": "T12", "fields": {"state": "reviewing"}}`. The fields are `state` (framed to briefed, briefed to building, building to reviewing, reviewing to verifying, verifying to reviewing, repairing to reviewing), `branch` and `pr`.
- `verdict`: give `task`, `kind` (`review-clean`, `security-clean`, `ux-clean`, `qa-pass`, `qa-fail` or `findings`), `sha`, `cycle`, `pr` and the `run` whose kept report backs it, after you end that run. The `checks-pass` and `checks-fail` verdicts are the chief's.
- `lint`: give `task` and `sha`, to see early the lines that the chief's lint will name. It records `lint-pass` or `lint-fail`, which only `lint` writes. The chief runs it on the final head before the merge.

**A report with findings.** Do these steps in this order. Triage comes after the verdict, because after a `fix` triage of a medium or high finding, the gate refuses the first verdict of a head until `round`.

1. `finding_add`: record every finding of the report, before you end its run. Give `task`, `source` (the role), `severity` (the report's, or above), `summary`, `run` and `class` (`state-edge`, `speed`, `copy`, `layout`, `security` or `other`). Until each medium or high finding of the report has its row with that `run`, the gate refuses your next `run_add` of that role, your `run_done` of that run, a state move and a `round` (the gap rule, as in Claude). Its refusal names the run and the report's keys.
2. `run_done`: end the run.
3. The proof check: when the cycle has a medium or high finding, wait for every helper of the cycle and do steps 1 and 2 for each, then read [the proof check](../../../core/references/proof-check.md) before any verdict of the cycle. Start one `qa` helper with its brief, save its report, and end its run. For each medium finding that did not reproduce, call `finding_triage` with `decision` `dismiss` and `proof`, the run id of the proof check.
4. `verdict`: for a medium or high finding that is still open, give `findings`, or `qa-fail` for QA. For only low findings, or when the proof check dropped each medium one, give the clean kind. The proof check's own run backs no verdict.
5. `finding_triage`: give `task`, `key` and `decision`: `fix` for a finding to repair, or `dismiss` with a `reason` for a low finding. For a medium or high finding in reviewing or verifying, `fix` also needs `proof`. Report a high finding that did not reproduce, and a finding that you think is wrong. An open finding blocks the task, so a low finding that you keep needs a round.
6. `round`: when a medium or high finding has `fix`, start the repair with it. First do steps 1 to 5 for each helper of the cycle: after `round`, the gate refuses a verdict on a run of an earlier round. When `round` prints held or replan, report blocked: the sage tools now refuse you. Start an implementer on the same branch for the keys that it names. After the repair's commit, call `finding_close` for each key, then move the task to reviewing, and start the roles that `round` named.

**The pull request.** A Codex implementer commits and reports, and it does not push. After its first commit, send the branch with `git -C <worktree> push -u <remote> <branch>`, open the pull request with `gh pr create --head <branch> --title <title> --body <body>`, and record the number with `task_set`. Send the branch again after each repair. A verdict needs the pull request. Never merge.

**Wait for CI.** Start no review or QA on a head before CI passes there. After each push, run `<node> <ci-wait.mjs> T<n>` with the project folder as the working folder. It reaches GitHub, as `gh` does. It waits up to 9 minutes for CI on the head of your task's branch, on the PR of the logbook, and reads only that PR's head and its checks. It prints `CI pass`, `CI fail`, `CI none` (no checks) or `CI runs` (run it again), and the next step: do it. After `CI fail`, report STATUS blocked with `Left: the checks`.

**Steer by a new agent.** The gate refuses `send_message`, `followup_task` and `send_input` from a lead, because each agent works only from its checked brief. To change a helper's work, stop it with `interrupt_agent`, end its run as failed, then start a new agent on a new run with a new brief. The gate also refuses `resume_agent`.

**Thread limit.** `collab spawn failed: agent thread limit reached` means that no thread is free. Codex allows 4 threads by default: the chief, you and 2 helpers, so a third helper at the same time fails. A finished or interrupted helper frees its thread. Call `list_agents`, wait for a helper that runs, then call `spawn_agent` again with the same task name, after a new `brief` when the last check is over 30 minutes old. When no helper runs and it still fails, end the run as blocked, and report STATUS blocked: the chief asks the owner to raise `agents.max_concurrent_threads_per_session`.

**Agent cap.** When the project is at its agent cap, `run_add` records the run in the queue and prints `R<n> is queued, place <k>`. The gate refuses its spawn until a run that ends admits it, oldest first. Wait for a helper's report with `wait_agent` and end its run: that end admits the oldest queued run. Then call `spawn_agent` again with the same task name: the gate names the run's place again, or lets it start. An admitted run must start within 10 minutes, or it ends as failed. Never end the run of a helper that still works. When no helper of yours runs and your run still waits, report STATUS blocked: the chief frees a place.

**No spawn tools.** sage on Codex needs a multi-agent v2 model for the chief and each child. When your tools have no `spawn_agent` in the `collaboration` namespace, start nothing, and report STATUS blocked at once with the reason that you have no spawn tools. The chief tells the owner the fix.

**End.** Stop at verifying with a ready report, or report blocked and name what is left. The chief records final-head CI and both required risk cycles, runs `merge_check`, and merges with autopilot on, or gives the owner the PR link, exact head SHA and evidence. A lead never merges.
