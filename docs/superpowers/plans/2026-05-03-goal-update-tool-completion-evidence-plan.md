# Goal Update Tool Completion Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strengthen Cat Code's `UpdateGoal` model-facing prompt so `/goal` completion requires evidence-backed end-to-end verification before the model can mark a goal complete.

**Architecture:** Keep the existing `/goal` continuation system intact. The current source already implements the strict continuation audit prompt in `src/utils/threadGoal.ts` and the two-turn no-tool continuation stall policy through `goalContinuationStallCountRef`, so this plan only tightens the completion tool prompt and locks that behavior with tests.

**Tech Stack:** TypeScript, Bun test runner, Cat Code built-in tool registry, React REPL goal runtime.

---

## Verified Current State

The implementation report is stale in two important places:

- `src/utils/threadGoal.ts:428` already has a strict `renderThreadGoalContinuationPrompt(goal: ThreadGoal): string` with prompt-to-artifact checklist language, real-evidence verification, proxy-signal warnings, and "Treat uncertainty as not achieved".
- `src/utils/threadGoal.ts:582`, `src/utils/threadGoalController.ts:14`, and `src/screens/REPL.tsx:968` already implement Option C continuation suppression with `goalContinuationStallCountRef` and `MAX_GOAL_CONTINUATION_STALL_COUNT = 2`.
- `src/tools/UpdateGoalTool/UpdateGoalTool.ts:98` already blocks some premature completion language, but it does not yet mirror the stronger evidence checklist from the continuation prompt.

Do not replace `renderThreadGoalContinuationPrompt`. Do not add new continuation suppression state. Both are already implemented and covered by tests.

## File Structure

- Modify: `src/tools/UpdateGoalTool/UpdateGoalTool.ts`
  - Responsibility: Owns the `UpdateGoal` tool's schema, prompt, validation, and completion result.
  - Planned change: Replace only `async prompt()` with stronger evidence-backed completion instructions.

- Modify: `src/tools/UpdateGoalTool/UpdateGoalTool.test.ts`
  - Responsibility: Regression tests for `UpdateGoalTool` behavior and model-facing prompt text.
  - Planned change: Add a focused prompt-content test before the runtime completion tests.

- Verify only: `src/utils/threadGoal.ts`
  - Responsibility: Thread goal data model, continuation prompt rendering, budget prompt rendering, continuation stall helpers, parsing, and formatting.
  - Planned change: None.

- Verify only: `src/utils/threadGoalController.ts`
  - Responsibility: Converts goal state and REPL idleness into `continue`, `budget-wrap-up`, `stalled`, or `none` actions.
  - Planned change: None.

- Verify only: `src/screens/REPL.tsx`
  - Responsibility: Wires idle continuation, turn accounting, stall count reset/increment behavior, and model prompt injection.
  - Planned change: None.

---

### Task 1: Add Failing Prompt Regression Test

**Files:**
- Modify: `src/tools/UpdateGoalTool/UpdateGoalTool.test.ts:60`
- Test: `src/tools/UpdateGoalTool/UpdateGoalTool.test.ts`

- [ ] **Step 1: Insert the prompt regression test**

Add this test immediately after the `createContext(...)` helper and before `test('completion uses shared goal action and clears Agent Mode objective', ...)`.

```ts
  test('prompt requires evidence-backed completion before marking goal complete', async () => {
    const prompt = await UpdateGoalTool.prompt()

    expect(prompt).toContain(
      'Use this tool only to mark the current thread goal complete.',
    )
    expect(prompt).toContain(
      '- every explicit requirement in the goal objective is satisfied',
    )
    expect(prompt).toContain(
      '- relevant files, command output, tests, logs, PR state, or other real evidence support completion',
    )
    expect(prompt).toContain(
      '- tests or green status actually cover the objective requirements',
    )
    expect(prompt).toContain('- no required work remains')
    expect(prompt).toContain(
      'Do not use this tool because the work seems mostly done.',
    )
    expect(prompt).toContain(
      'Do not use this tool because tests passed unless those tests cover the objective.',
    )
    expect(prompt).toContain(
      'Do not use this tool because the token budget is nearly exhausted.',
    )
    expect(prompt).toContain(
      'Do not use this tool because you are stopping work.',
    )
    expect(prompt).toContain('The only valid status is "complete".')
    expect(prompt).toContain(
      'When marking a budgeted goal complete, report the final token usage and elapsed time from the tool result to the user.',
    )
  })
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
bun test src/tools/UpdateGoalTool/UpdateGoalTool.test.ts
```

Expected: FAIL. The new test should fail because the current prompt does not include the stronger evidence checklist lines such as `every explicit requirement in the goal objective is satisfied`.

- [ ] **Step 3: Commit the failing test**

```bash
git add src/tools/UpdateGoalTool/UpdateGoalTool.test.ts
git commit -m "test: cover goal completion evidence prompt"
```

---

### Task 2: Strengthen UpdateGoal Tool Prompt

**Files:**
- Modify: `src/tools/UpdateGoalTool/UpdateGoalTool.ts:98`
- Test: `src/tools/UpdateGoalTool/UpdateGoalTool.test.ts`

- [ ] **Step 1: Replace `UpdateGoalTool.prompt()`**

In `src/tools/UpdateGoalTool/UpdateGoalTool.ts`, replace the existing `async prompt()` method with this exact implementation:

```ts
  async prompt() {
    return [
      'Use this tool only to mark the current thread goal complete.',
      '',
      'Before using this tool, verify that:',
      '- every explicit requirement in the goal objective is satisfied',
      '- relevant files, command output, tests, logs, PR state, or other real evidence support completion',
      '- tests or green status actually cover the objective requirements',
      '- no required work remains',
      '',
      'Do not use this tool because the work seems mostly done.',
      'Do not use this tool because tests passed unless those tests cover the objective.',
      'Do not use this tool because the token budget is nearly exhausted.',
      'Do not use this tool because you are stopping work.',
      '',
      'The only valid status is "complete".',
      'You cannot use this tool to pause, resume, clear, or budget-limit a goal; those status changes are controlled by the user or runtime.',
      'When marking a budgeted goal complete, report the final token usage and elapsed time from the tool result to the user.',
    ].join('\n')
  },
```

- [ ] **Step 2: Run the focused test to verify it passes**

Run:

```bash
bun test src/tools/UpdateGoalTool/UpdateGoalTool.test.ts
```

Expected: PASS. The prompt regression test and all existing `UpdateGoalTool` runtime validation tests should pass.

- [ ] **Step 3: Commit the prompt change**

```bash
git add src/tools/UpdateGoalTool/UpdateGoalTool.ts
git commit -m "fix: require evidence before goal completion"
```

---

### Task 3: Verify Existing Goal Continuation Behavior Still Matches the Report's Intent

**Files:**
- Verify: `src/utils/threadGoal.ts`
- Verify: `src/utils/threadGoalController.ts`
- Verify: `src/screens/REPL.tsx`
- Test: `src/utils/threadGoal.test.ts`
- Test: `src/utils/threadGoalController.test.ts`

- [ ] **Step 1: Confirm the continuation prompt still contains strict audit language**

Run:

```bash
bun test src/utils/threadGoal.test.ts --grep "renders the active continuation prompt safely and requires completion audit"
```

Expected: PASS. This confirms the existing continuation prompt still includes the completion audit, prompt-to-artifact checklist, real evidence requirement, proxy-signal warning, and post-`UpdateGoal` reporting language.

- [ ] **Step 2: Confirm zero-tool active continuations allow one retry and stall on the second**

Run:

```bash
bun test src/utils/threadGoal.test.ts --grep "zero-tool active continuations increment stall count instead of immediately stopping"
```

Expected: PASS. This confirms `nextThreadGoalContinuationStallCount(...)` increments from `0` to `1`, increments from `1` to `2`, and resets to `0` after an active continuation turn with at least one tool use.

- [ ] **Step 3: Confirm the controller returns stalled at the threshold**

Run:

```bash
bun test src/utils/threadGoalController.test.ts
```

Expected: PASS. This confirms `getThreadGoalContinuationAction(...)` returns `continue` below the stall threshold and `stalled` once `goalContinuationStallCount` reaches `2`.

- [ ] **Step 4: Commit only if verification required edits**

No commit is expected for this task because it verifies existing behavior. If a test fails due to drift, fix only the smallest relevant assertion or implementation line, then commit:

```bash
git add src/utils/threadGoal.ts src/utils/threadGoal.test.ts src/utils/threadGoalController.ts src/utils/threadGoalController.test.ts src/screens/REPL.tsx
git commit -m "fix: preserve goal continuation stall behavior"
```

---

### Task 4: Run Goal System Regression Suite

**Files:**
- Test: `src/utils/threadGoal.test.ts`
- Test: `src/utils/threadGoalController.test.ts`
- Test: `src/commands/goal/goal.test.ts`
- Test: `src/tools/GetGoalTool/GetGoalTool.test.ts`
- Test: `src/tools/CreateGoalTool/CreateGoalTool.test.ts`
- Test: `src/tools/UpdateGoalTool/UpdateGoalTool.test.ts`

- [ ] **Step 1: Run the targeted goal regression suite**

Run:

```bash
bun test src/utils/threadGoal.test.ts src/utils/threadGoalController.test.ts src/commands/goal/goal.test.ts src/tools/GetGoalTool/GetGoalTool.test.ts src/tools/CreateGoalTool/CreateGoalTool.test.ts src/tools/UpdateGoalTool/UpdateGoalTool.test.ts
```

Expected: PASS. The verifier subagent observed this suite passing with `63 pass, 0 fail` before the prompt change; after this plan, the count should increase by one because of the new `UpdateGoalTool.prompt()` regression test.

- [ ] **Step 2: Run the TypeScript build check**

Run:

```bash
bun run build:dev
```

Expected: PASS. The build should complete without TypeScript or bundling errors.

- [ ] **Step 3: Review the final diff**

Run:

```bash
git diff -- src/tools/UpdateGoalTool/UpdateGoalTool.ts src/tools/UpdateGoalTool/UpdateGoalTool.test.ts
```

Expected: The diff should contain only the prompt regression test and the strengthened `UpdateGoalTool.prompt()` text.

- [ ] **Step 4: Final commit if Task 1 and Task 2 were not committed separately**

If the executor skipped the per-task commits, make one focused commit:

```bash
git add src/tools/UpdateGoalTool/UpdateGoalTool.ts src/tools/UpdateGoalTool/UpdateGoalTool.test.ts
git commit -m "fix: strengthen goal completion evidence prompt"
```

---

## Self-Review

Spec coverage:

- Change 1 from the report is covered by existing source and tests, so the plan intentionally avoids replacing `renderThreadGoalContinuationPrompt`.
- Change 2 from the report is implemented by Task 1 and Task 2.
- Change 3 from the report is covered by existing source and tests, so the plan intentionally avoids adding new stall state.
- The requested verifier subagent step has already been completed before this plan was written.

Placeholder scan:

- The plan contains no placeholder markers or generic "add tests" instructions.
- Every code-changing step includes exact code.
- Every verification step includes an exact command and expected result.

Type consistency:

- The plan uses the existing `UpdateGoalTool.prompt()` method and Bun `expect(...).toContain(...)` assertions.
- The plan uses existing function names exactly as implemented: `renderThreadGoalContinuationPrompt`, `nextThreadGoalContinuationStallCount`, and `getThreadGoalContinuationAction`.
