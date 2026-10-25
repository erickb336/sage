# Start a role agent

The chief starts each role agent (lead, implementer, pe, designer, arena-judge, code-reviewer, security-reviewer, ux-reviewer, qa) as a Codex child agent. Codex plugins cannot ship agent roles, so the role text goes at the top of the spawn message. The plugin writes no role files into your Codex home.

**The shape is flat for now.** The chief starts every role agent, also the reviewers and QA of a lead's task. A lead asks the chief to start them; it does not start agents itself.

## Steps

1. Print the role text. Run the `role.mjs` script beside this skill with the role name, for example `node <this skill folder>/role.mjs implementer`.
2. Write the message: the whole output of step 1, without a change, then a blank line, then the brief (see [briefs and reports](briefs.md)).
3. Call `spawn_agent` in the `collaboration` namespace with:
   - `task_name`: `sage_`, the role with `_` for `-`, then the task, for example `sage_implementer_t12` or `sage_code_reviewer_t12`. The report check knows a sage role agent by the `sage_` start.
   - `message`: the message of step 2.
   - `fork_turns: "none"`. The default, `all`, gives the agent the chief's history in place of a clean start.
   - Leave out `agent_type`: sage has no Codex role of that name.
4. Wait for the agent with `wait_agent`, and read its report.

When your tool list has `spawn_agent` only in the `multi_agent_v1` namespace (an older model), give `message` alone. That spawn form has no task name, so the report check does not check the agent: read its report yourself.

## The report check

The plugin's report check (a `SubagentStop` hook) reads each agent whose task name starts with `sage_`. When the agent stops and its last message has no field of the report (`STATUS` to `BRANCH`), the check continues the agent once and names the missing fields. At the second stop, the agent stops, and you see one plain line that names the fields that are still missing. Read that report as it is. Other agents pass.

The check runs only after you trust the plugin hooks in Codex.
