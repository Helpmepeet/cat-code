# Thread Goal User Manual

The `/goal` command stores one long-running objective for the current session. Cat Code can track the goal, show it in the footer, continue active goals when the session becomes idle, and mark goals complete after verification.

## Codex parity notes

This section compares Cat Code's current `/goal` behavior with OpenAI Codex's `/goal` behavior, ignoring feature-flag differences.

Cat Code and Codex match on the main goal-mode concept, but not on every command, tool schema, or runtime detail:

- `/goal <objective>` creates one active durable objective for the current thread.
- `/goal` shows the current goal or usage text when no goal exists.
- `/goal pause`, `/goal resume`, and `/goal clear` control the current goal.
- Active goals can continue automatically when the session becomes idle.
- Active goals are paused when the run is interrupted.
- Budget-limited goals should wrap up instead of starting new substantive work.
- Completion is model-driven through the goal update tool and should only happen after verification.

Current intentional differences from Codex:

- Cat Code supports `/goal --budget N <objective>` in the slash command. Codex's slash command does not expose budget syntax.
- Cat Code keeps textual replacement with `/goal replace <objective>` and `/goal replace --budget N <objective>` as a compatibility extension. Plain `/goal <objective>` now matches Codex by opening a replacement confirmation UI when a non-complete goal already exists.
- Cat Code's hidden continuation prompt follows Codex's completion-audit wording and keeps additional Agent Mode orchestration guidance as a Cat Code safety behavior.
- Cat Code's completion tool keeps an Agent Mode safety gate: it refuses completion while Agent Mode workers are still running or pending synthesis. Codex does not have that Cat Code-specific worker gate.
- Cat Code keeps Agent Mode objective state synchronized when goals are created, replaced, cleared, or completed. That integration is local to Cat Code.

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

Creates one active goal for the current session. If a non-complete goal already exists, Cat Code opens a confirmation UI:

```text
Replace goal?
New objective: finish the implementation and verify it

Replace current goal — Set the new objective and start it now
Cancel — Keep the current goal
```

### Set a goal with a token budget

```text
/goal --budget 50000 finish the implementation and verify it
/goal --budget 50K finish the implementation and verify it
/goal --budget 1.5M finish the implementation and verify it
```

The budget limits automatic goal work. Reaching the budget does not mean the goal is complete.

### Replace a goal

```text
/goal replace finish the new implementation and verify it
/goal replace --budget 50K finish the new implementation and verify it
```

Replaces the current goal immediately. This is a Cat Code compatibility extension; Codex uses the confirmation UI for plain `/goal <objective>` replacement.

### Pause a goal

```text
/goal pause
```

Changes an active goal to paused. Paused goals do not automatically continue. If the goal is already limited by budget, `/goal pause` leaves it limited by budget.

### Resume a goal

```text
/goal resume
```

Changes a paused goal back to active. Resuming resets the continuation stall count.

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
- the automatic continuation stall count is below the limit
- there is no queued user input
- there is no active local command UI
- plan mode is not active

Cat Code does not continue paused, complete, or budget-limited goals as normal work.

When reopening or resuming a thread with a paused goal, Cat Code prompts:

```text
Resume paused goal?
Goal: <objective>

Resume goal — Mark it active and continue when idle
Leave paused — Keep it paused; use /goal resume later
```

## Automatic continuation behavior

When a goal is active, Cat Code may continue working on it after the session becomes idle. The continuation prompt includes the current objective, token budget, tokens used, elapsed time, and remaining tokens.

Before marking a goal complete, Cat Code should perform a completion audit against real evidence such as files, command output, test results, logs, or PR state. Passing tests alone is not enough unless those tests cover every requirement in the goal.

When a token budget is reached, Cat Code should not start new substantive work. It should summarize progress, identify remaining work or blockers, and leave a clear next step.

## Continuation stall limit

If an automatic continuation turn makes zero tool calls, Cat Code increments a stall count. After repeated zero-tool automatic continuations, Cat Code stops starting more automatic continuation turns until the stall count is reset. This prevents repeated autonomous turns that do not take concrete action.

The stall count resets when:

- you send a normal prompt
- you change the goal by setting, pausing, resuming, or clearing it

## Budget-limited behavior

When an active goal reaches its token budget, it becomes `budget limited`.

A budget-limited goal may receive one automatic wrap-up prompt. The wrap-up asks Cat Code to stop substantive work, summarize soon, and only mark the goal complete if it is actually achieved.

After that wrap-up, budget-limited goals do not automatically continue as normal work.

## Completion

Cat Code can mark a goal complete with the `update_goal` tool, but only after verifying the objective is actually achieved.

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

The `/goal` command is marked as immediate, so it can run while a turn is active. The current command implementation does not add a turn-running guard.

Supported command forms are still parsed the same way:

```text
/goal
/goal pause
/goal clear
/goal resume
/goal replace a different objective
```

If a non-complete goal exists, `/goal a different objective` opens the replacement confirmation UI. `/goal replace ...` replaces the goal immediately.

## Footer indicator

When a goal exists, the prompt footer shows a compact indicator.

Examples:

```text
Goal: active
Goal: active · 12K/50K
Goal: paused
Goal: limited by budget · 50K/50K tokens
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
6. Start a turn, then run `/goal a different objective` while it is active and confirm the replacement UI appears. Run `/goal replace a different objective` and confirm it replaces immediately.
7. Abort an active goal turn and confirm `/goal` shows `paused`.
8. Set a very small budget with `/goal --budget 1 ...` and confirm the goal becomes budget limited and does not continue normal work after one wrap-up.
9. Ask Cat Code to audit completion and confirm it only marks the goal complete after checking evidence.
