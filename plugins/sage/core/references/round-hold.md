# A round hold

## An approved repair after a round hold

A round hold needs an explicit answer from the owner. A default answer does not grant a repair.

For a task with four spent rounds and a current limit of three, open a gate on that task:

```text
sage gate add T1 --question "Approve one more repair round for T1 after 4 spent rounds and limit 3?" --options "approve|decline" --recommend approve
```

After the owner chooses approve, record that answer with `sage gate answer G1 --option 1 --project <folder>`, then run `sage task T1 set state=building approval=G1`. Use the actual gate ID. Use `briefed` instead of `building` when a new brief is needed.

The limit is `max_rounds + extra`. One approval permits the next round above the greater of spent rounds and that limit. This example permits round five; round six holds again. The task keeps its cumulative rounds, PR, branch, earlier allowances and review minimum.

Missing, declined, wrong-task, stale, malformed or used approvals refuse before any changes. A repeated `sage task T1 set` call after success refuses and adds nothing. After an uncertain result, read the task before a new request. The allowance and used gate IDs share one task-row write.

## An extra round in autopilot

While autopilot is on for your session, you give the next round past `max_rounds` yourself, up to 5 rounds in all, with the reason: `sage round T1 --why "<reason>"`. It works from the round hold or before it, and writes a decision row with the reason. Without `--why`, with autopilot off, or for round 6 and later, the round hold and the owner's gate above stay. Only the chief gives such a round: a lead's `round` takes no `--why`.
