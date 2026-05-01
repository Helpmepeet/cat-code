# Thread Goal User Manual

The `/goal` command stores one long-running objective for the current session. Cat Code can track the goal, show it in the footer, continue active goals when the session becomes idle, and mark goals complete after verification.

## Commands

### Show the current goal

```text
/goal
```

Shows usage help when no goal is set. When a goal exists, it shows the status, objective, token budget if set, tokens used, and time used.

### Set a goal

```text
/goal finish the implementation and verify it
```

Creates one active goal for the current session. If a non-complete goal already exists, Cat Code rejects the new goal:

```text
A goal already exists. Run /goal clear first.
```

### Set a goal with a token budget

```text
/goal --budget 50000 finish the implementation and verify it
/goal --budget 50K finish the implementation and verify it
/goal --budget 1.5M finish the implementation and verify it
```

The budget limits automatic goal work. Reaching the budget does not mean the goal is complete.

### Pause a goal

```text
/goal pause
```

Changes an active goal to paused. Paused goals do not automatically continue.

### Resume a goal

```text
/goal resume
```

Changes a paused goal back to active. Resuming clears continuation suppression.

### Clear a goal

```text
/goal clear
```

Removes the current goal and clears the footer indicator.

## Goal statuses

| Status | Meaning |
| --- | --- |
| `active` | Cat Code may continue the goal when the session becomes idle. |
| `paused` | Cat Code will not automatically continue the goal. |
| `budget limited` | The token budget was reached. Cat Code may do one wrap-up turn, then stops automatic work. |
| `complete` | The goal was verified as achieved. Cat Code will not continue it. |

## Idle continuation

Active goals may continue automatically after a turn completes and the session becomes idle.

Normal continuation only starts when all of these are true:

- the session is idle
- the goal status is `active`
- no goal continuation is already in flight
- continuation is not suppressed
- there is no queued user input
- there is no active local command UI

Cat Code does not continue paused, complete, or budget-limited goals as normal work.

## Automatic continuation behavior

When a goal is active, Cat Code may continue working on it after the session becomes idle. The continuation prompt includes the current objective, token budget, tokens used, elapsed time, and remaining tokens.

Before marking a goal complete, Cat Code should perform a completion audit against real evidence such as files, command output, test results, logs, or PR state. Passing tests alone is not enough unless those tests cover every requirement in the goal.

When a token budget is reached, Cat Code should not start new substantive work. It should summarize progress, identify remaining work or blockers, and leave a clear next step.

## Continuation suppression

If an automatic continuation turn makes zero tool calls, Cat Code suppresses the next automatic continuation. This prevents repeated autonomous turns that do not take concrete action.

Suppression clears when:

- you send a normal prompt
- you change the goal by setting, pausing, resuming, or clearing it

## Budget-limited behavior

When an active goal reaches its token budget, it becomes `budget limited`.

A budget-limited goal may receive one automatic wrap-up prompt. The wrap-up asks Cat Code to stop substantive work, summarize soon, and only mark the goal complete if it is actually achieved.

After that wrap-up, budget-limited goals do not automatically continue as normal work.

## Completion

Cat Code can mark a goal complete with the `UpdateGoal` tool, but only after verifying the objective is actually achieved.

Before marking a goal complete, Cat Code should:

- restate the objective as concrete deliverables or success criteria
- make a checklist of every explicit requirement
- inspect real evidence such as files, command output, test results, logs, or PR state
- verify that tests or status indicators cover the objective
- identify missing, incomplete, weakly verified, or uncovered requirements
- treat uncertainty as not achieved
- avoid marking complete only because tests passed unless the tests cover the objective

You can request a completion audit with:

```text
Audit the current goal and mark it complete only if every requirement is actually satisfied.
```

## Cancellation

If you abort while a goal is active, Cat Code pauses the goal.

After aborting, check the status with:

```text
/goal
```

Expected status:

```text
Goal: paused
```

No automatic continuation should start after the abort.

## Running `/goal` while a turn is active

The `/goal` command can run while a turn is active for inspection and control.

Allowed while running:

```text
/goal
/goal pause
/goal clear
/goal resume
```

Rejected while running:

```text
/goal a different objective
```

Expected rejection:

```text
Cannot set a new goal while a turn is running. Stop or wait first.
```

This prevents changing the objective underneath an active model turn.

## Footer indicator

When a goal exists, the prompt footer shows a compact indicator.

Examples:

```text
Goal: active
Goal: active · 12K/50K
Goal: paused
Goal: budget limited · 50K/50K
Goal: complete · 40K
```

Use `/goal` for full details.

## Prompt safety

Goal objective text is user-provided data. Cat Code treats it as the task to pursue, not as higher-priority instructions. Objective text is wrapped as untrusted data in continuation prompts and escaped so it cannot break out of the wrapper.

## Quick manual test checklist

1. Run `/goal finish a small harmless task` and confirm the goal becomes active without starting a model turn.
2. Run `/goal` and confirm the objective and status are shown.
3. Send a normal prompt and confirm active-goal work can continue after the session becomes idle.
4. Run `/goal pause` and confirm no automatic continuation starts.
5. Run `/goal resume` and confirm the goal becomes active again.
6. Start a turn, then run `/goal a different objective` while it is active and confirm it is rejected.
7. Abort an active goal turn and confirm `/goal` shows `paused`.
8. Set a very small budget with `/goal --budget 1 ...` and confirm the goal becomes budget limited and does not continue normal work after one wrap-up.
9. Ask Cat Code to audit completion and confirm it only marks the goal complete after checking evidence.
