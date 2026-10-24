# How sage works

This page shows the parts of sage and how a request becomes a verified pull request: the two loops, the team, the routes, a task's life and the arena. The rules that the code holds are in [Rules held in code](../design/rules-in-code.md).

<a href="../assets/loop-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/loop-dark.svg">
  <img alt="How sage works: you, the chief of staff, the team (design, build, review, QA), the pull request, the logbook, and the outer loop that seals each lesson." src="../assets/loop-light.svg" width="100%">
</picture>
</a>

There are two loops:

- **The inner loop** turns a request into verified work. The chief briefs the team. The team designs, builds, reviews and tests. Findings go back to the build. A clean result becomes a pull request.
- **The outer loop** [seals the lesson](concepts.md): it gives a mistake that comes back twice a lasting fix, a test or a check in code first. Each sealed lesson makes [the dojo](concepts.md) stronger.

<a href="../assets/tip-seal-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/tip-seal-dark.svg">
  <img alt="The toad sage's tip: seal the lesson. Give a mistake that comes back twice a lasting fix: a test or a check in code first; a principle or a standing order only when code cannot hold it. That is how the dojo gets stronger." src="../assets/tip-seal-light.svg" width="100%">
</picture>
</a>

The state lives in the logbook: plain files in `~/.claude/sage/<project>-<hash>/`. It holds the tasks, the agent runs, the findings, the verdicts, your answers and the decision trail. So you can leave, and a new session on another device continues the work.

## The team

| Agent | What it does | Changes files? |
| --- | --- | --- |
| **Chief of staff** | Frames the work, picks routes, writes briefs, records results, asks you the questions | No |
| **Lead** | Runs one task's pull request from the build to its clean cycles, with its own implementer, reviewers and QA | No |
| **Designer** | A clickable prototype with sample data, and every state of each screen | Yes, in its own worktree |
| **PE** (principal engineer) | Checks a plan or a design before the build: feasibility, data, risks, cost | No |
| **Implementer** | Builds one task, runs the checks, opens the pull request, repairs findings | Yes, in its own worktree |
| **Code reviewer** | Correctness, data safety, regressions, test evidence | No |
| **Security reviewer** | Input at the boundaries, injection, secrets, access | No |
| **UX reviewer** | The flow, the states, the copy and accessibility | No |
| **QA** | Runs the checks and the real app, and tries to break it | No |
| **Arena judge** | Scores an arena's candidates and grafts the best parts into one | Yes, the final version |

Only one agent writes on a branch at a time. Reviewers start fresh, so they don't share the builder's blind spots. How the lead and the models work: see [Using sage](using-sage.md#the-lead-and-the-models).

## Routes

Each task gets the least route for its size. The chief can add steps, never remove these.

<a href="../assets/routes-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/routes-dark.svg">
  <img alt="Routes by size. Tiny: build. Small: build, code review, QA. Large: design, PE check, you approve, build, code review, security review, UX review, QA. Investigate: gather evidence, evidence review, a proposal to you. A risk flag adds the security review to every size except investigate, which changes no code." src="../assets/routes-light.svg" width="100%">
</picture>
</a>

## A task's life

<a href="../assets/lifecycle-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/lifecycle-dark.svg">
  <img alt="A task's states: framed, briefed, building, reviewing, verifying, verified, merged. A product question moves a building task to held until your answer. Findings to fix, or a QA fail, move it from verifying to repairing, and the next round goes back to reviewing, at most 3 rounds. Verified needs 1 clean cycle; autopilot merges after 1 for a small task, 2 for a large or risky one. A tiny task has no review and no QA: it is clean when its checks pass." src="../assets/lifecycle-light.svg" width="100%">
</picture>
</a>

A **cycle** is one full set of fresh reviews and QA on one commit. A new commit starts again from cycle 1.

A task is **verified** after 1 clean cycle. With autopilot on, it **merges** after its clean cycles on the same commit: 1 for a small task, 2 for a large task or any task with a risk flag.

A tiny task's route is only the build: it has no review and no QA, so it has no cycle. It is clean when its checks pass on its commit. A risk flag adds the security review, and then a tiny task needs 2 clean cycles too.

## The arena

When a design has no clear answer, the chief can run an **arena**. You can also ask for one: `arena` or `arena 4`.

<a href="../assets/arena-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/arena-dark.svg">
  <img alt="The arena: one brief and a hidden rubric, three candidates on a mix of Claude models, an arena judge, one final version." src="../assets/arena-light.svg" width="100%">
</picture>
</a>

N candidates (3 by default) get the same brief, each with a different angle. A judge scores them against a rubric that they do not see, and grafts the best parts into one final version.

That version goes through reviews and QA like any build. The candidates never merge.
