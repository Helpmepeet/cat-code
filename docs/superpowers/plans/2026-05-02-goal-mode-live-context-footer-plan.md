# Goal Mode Live Context Footer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the goal footer update during an active turn by showing display-only live context-token growth, while keeping transcript persistence unchanged until turn completion.

**Architecture:** Persisted goal accounting remains turn-end only in `REPL.accountCompletedTurnThreadGoal()`. A pure display helper builds a temporary `ThreadGoal`-shaped value by adding positive live context growth to the persisted goal, and the footer receives that display value through props instead of reading only app state. Streaming text and reasoning are estimated separately because they are visible before they become finalized transcript messages.

**Tech Stack:** TypeScript, React/Ink, Bun test, existing Cat Code token estimators (`tokenCountWithEstimation`, `roughTokenCountEstimation`).

---

## File Structure

- Modify `src/utils/threadGoal.ts`
  - Own pure goal accounting and display helpers.
  - Add `buildThreadGoalDisplayState(...)` for footer-only live display.
  - Do not add React dependencies here.
- Modify `src/utils/threadGoal.test.ts`
  - Add unit coverage for live display deltas, context shrink, completed goals, mismatched goal IDs, and budget-threshold display.
- Modify `src/components/PromptInput/PromptInputFooter.tsx`
  - Accept an optional `threadGoalDisplay` prop.
  - Render the prop when provided; fall back to `useAppState(s => s.threadGoal)` for current behavior.
- Modify `src/components/PromptInput/PromptInput.tsx`
  - Accept and forward `threadGoalDisplay` to `PromptInputFooter`.
- Modify `src/screens/REPL.tsx`
  - Compute live context tokens from `messages`, `streamingText`, and `streamingThinking`.
  - Build the display-only goal value and pass it into `PromptInput`.
  - Keep persisted `saveThreadGoal(...)` behavior unchanged.

---

### Task 1: Add Pure Live Display Helper

**Files:**
- Modify: `src/utils/threadGoal.ts`
- Test: `src/utils/threadGoal.test.ts`

- [ ] **Step 1: Write failing tests for display-only goal state**

Add `buildThreadGoalDisplayState` to the import list in `src/utils/threadGoal.test.ts`:

```ts
import {
  accountThreadGoalUsage,
  buildThreadGoalDisplayState,
  calculateThreadGoalContextTokenDelta,
  createThreadGoal,
  deriveThreadGoalContinuationResetState,
  deriveThreadGoalContinuationSeed,
  formatThreadGoalFooterLabel,
  formatThreadGoalSummary,
  nextThreadGoalContinuationStallCount,
  parseGoalCommand,
  parseThreadGoal,
  pauseActiveThreadGoalOnAbort,
  renderThreadGoalBudgetLimitPrompt,
  renderThreadGoalContinuationPrompt,
  shouldResetThreadGoalContinuationStallCount,
  shouldStartThreadGoalBudgetWrapUp,
  shouldStartThreadGoalContinuation,
  updateThreadGoalStatus,
} from './threadGoal.js'
```

Add these tests inside `describe('thread goal formatting and parsing', ...)`, immediately after `calculates only positive context-token deltas`:

```ts
  test('builds live display usage from positive context growth only', () => {
    const goal = {
      ...createThreadGoal('session-1', 'finish phase 1D', undefined, 100),
      tokensUsed: 12_000,
      timeUsedSeconds: 30,
    }

    const displayGoal = buildThreadGoalDisplayState({
      goal,
      liveContextTokens: 50_000,
      turnStartContextTokens: 40_000,
      turnGoalId: goal.goalId,
      isTurnRunning: true,
    })

    expect(displayGoal).toEqual({
      ...goal,
      tokensUsed: 22_000,
    })
    expect(goal.tokensUsed).toBe(12_000)
  })

  test('live display usage does not decrease when context shrinks or resets', () => {
    const goal = {
      ...createThreadGoal('session-1', 'finish phase 1D', undefined, 100),
      tokensUsed: 12_000,
      timeUsedSeconds: 30,
    }

    expect(
      buildThreadGoalDisplayState({
        goal,
        liveContextTokens: 0,
        turnStartContextTokens: 40_000,
        turnGoalId: goal.goalId,
        isTurnRunning: true,
      }),
    ).toEqual(goal)

    expect(
      buildThreadGoalDisplayState({
        goal,
        liveContextTokens: 35_000,
        turnStartContextTokens: 40_000,
        turnGoalId: goal.goalId,
        isTurnRunning: true,
      }),
    ).toEqual(goal)
  })

  test('live display usage is disabled when idle or when goal identity changed', () => {
    const goal = {
      ...createThreadGoal('session-1', 'finish phase 1D', undefined, 100),
      tokensUsed: 12_000,
      timeUsedSeconds: 30,
    }

    expect(
      buildThreadGoalDisplayState({
        goal,
        liveContextTokens: 50_000,
        turnStartContextTokens: 40_000,
        turnGoalId: goal.goalId,
        isTurnRunning: false,
      }),
    ).toBe(goal)

    expect(
      buildThreadGoalDisplayState({
        goal,
        liveContextTokens: 50_000,
        turnStartContextTokens: 40_000,
        turnGoalId: 'different-goal',
        isTurnRunning: true,
      }),
    ).toBe(goal)
  })

  test('live display usage does not alter paused or complete goals', () => {
    const activeGoal = {
      ...createThreadGoal('session-1', 'finish phase 1D', undefined, 100),
      tokensUsed: 12_000,
      timeUsedSeconds: 30,
    }
    const pausedGoal = updateThreadGoalStatus(activeGoal, 'paused', 200)
    const completeGoal = updateThreadGoalStatus(activeGoal, 'complete', 200)

    for (const goal of [pausedGoal, completeGoal]) {
      expect(
        buildThreadGoalDisplayState({
          goal,
          liveContextTokens: 50_000,
          turnStartContextTokens: 40_000,
          turnGoalId: goal.goalId,
          isTurnRunning: true,
        }),
      ).toBe(goal)
    }
  })

  test('live display can show budget limited without persisting it', () => {
    const goal = {
      ...createThreadGoal('session-1', 'finish phase 1D', 20_000, 100),
      tokensUsed: 12_000,
      timeUsedSeconds: 30,
    }

    const displayGoal = buildThreadGoalDisplayState({
      goal,
      liveContextTokens: 50_000,
      turnStartContextTokens: 40_000,
      turnGoalId: goal.goalId,
      isTurnRunning: true,
    })

    expect(displayGoal).toEqual({
      ...goal,
      status: 'budget_limited',
      tokensUsed: 22_000,
    })
    expect(goal.status).toBe('active')
    expect(goal.tokensUsed).toBe(12_000)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test src/utils/threadGoal.test.ts
```

Expected: FAIL with an import error like `Export named 'buildThreadGoalDisplayState' not found`.

- [ ] **Step 3: Add the display helper implementation**

In `src/utils/threadGoal.ts`, add this function immediately after `calculateThreadGoalContextTokenDelta(...)`:

```ts
export function buildThreadGoalDisplayState({
  goal,
  liveContextTokens,
  turnStartContextTokens,
  turnGoalId,
  isTurnRunning,
}: {
  goal: ThreadGoal | null
  liveContextTokens: number
  turnStartContextTokens: number
  turnGoalId: string | null
  isTurnRunning: boolean
}): ThreadGoal | null {
  if (!goal || !isTurnRunning || goal.goalId !== turnGoalId) {
    return goal
  }
  if (goal.status !== 'active' && goal.status !== 'budget_limited') {
    return goal
  }

  const liveDelta = calculateThreadGoalContextTokenDelta(
    turnStartContextTokens,
    liveContextTokens,
  )
  if (liveDelta === 0) {
    return goal
  }

  const tokensUsed = goal.tokensUsed + liveDelta
  const status =
    goal.status === 'active' &&
    goal.tokenBudget !== undefined &&
    tokensUsed >= goal.tokenBudget
      ? 'budget_limited'
      : goal.status

  return {
    ...goal,
    status,
    tokensUsed,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
bun test src/utils/threadGoal.test.ts
```

Expected: PASS, including the new display-helper tests.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/utils/threadGoal.ts src/utils/threadGoal.test.ts
git commit -m "test: cover live goal display state"
```

---

### Task 2: Pass Display Goal Through Prompt Input Footer

**Files:**
- Modify: `src/components/PromptInput/PromptInputFooter.tsx`
- Modify: `src/components/PromptInput/PromptInput.tsx`
- Test: none unless this repo already has component render tests nearby; this is verified by build in Task 4.

- [ ] **Step 1: Add `ThreadGoal` type import and prop to footer**

In `src/components/PromptInput/PromptInputFooter.tsx`, change the existing thread-goal import:

```ts
import {
  formatThreadGoalFooterLabel,
  type ThreadGoal,
} from '../../utils/threadGoal.js';
```

Add this field to `type Props`:

```ts
  threadGoalDisplay?: ThreadGoal | null;
```

Add `threadGoalDisplay` to the `PromptInputFooter` destructuring:

```ts
  threadGoalDisplay,
  onOpenTasksDialog
}: Props): ReactNode {
```

- [ ] **Step 2: Pass display goal into the indicator**

In `src/components/PromptInput/PromptInputFooter.tsx`, replace:

```tsx
          <GoalStatusIndicator />
```

with:

```tsx
          <GoalStatusIndicator goalDisplay={threadGoalDisplay} />
```

Replace the existing `GoalStatusIndicator` function with:

```tsx
function GoalStatusIndicator({
  goalDisplay,
}: {
  goalDisplay?: ThreadGoal | null
}): React.ReactNode {
  const appGoal = useAppState(s => s.threadGoal);
  const goal = goalDisplay === undefined ? appGoal : goalDisplay;
  if (!goal) return null;
  return <Text dimColor wrap="truncate">{formatThreadGoalFooterLabel(goal)}</Text>;
}
```

- [ ] **Step 3: Add `ThreadGoal` type import and prop to `PromptInput`**

In `src/components/PromptInput/PromptInput.tsx`, add a type import near the other utility/type imports:

```ts
import type { ThreadGoal } from '../../utils/threadGoal.js';
```

Add this field to the `Props` type:

```ts
  threadGoalDisplay?: ThreadGoal | null;
```

Add `threadGoalDisplay` to the main `PromptInput` prop destructuring.

- [ ] **Step 4: Forward `threadGoalDisplay` to `PromptInputFooter`**

In the `<PromptInputFooter ... />` call in `src/components/PromptInput/PromptInput.tsx`, add:

```tsx
threadGoalDisplay={threadGoalDisplay}
```

The final footer call should still include the existing props such as `apiKeyStatus`, `messages`, `isLoading`, and `onOpenTasksDialog`.

- [ ] **Step 5: Run build to catch prop/type mistakes**

Run:

```bash
bun run build:dev
```

Expected: PASS and output ending with `Built ./cli-dev`.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/components/PromptInput/PromptInputFooter.tsx src/components/PromptInput/PromptInput.tsx
git commit -m "feat: allow live goal footer display"
```

---

### Task 3: Compute Live Context Tokens In REPL

**Files:**
- Modify: `src/screens/REPL.tsx`

- [ ] **Step 1: Add imports for display helper and streaming token estimate**

In `src/screens/REPL.tsx`, extend the thread-goal import to include `buildThreadGoalDisplayState`:

```ts
import {
  accountThreadGoalUsage,
  buildThreadGoalDisplayState,
  calculateThreadGoalContextTokenDelta,
  deriveThreadGoalContinuationResetState,
  nextThreadGoalContinuationStallCount,
  pauseActiveThreadGoalOnAbort,
  renderThreadGoalBudgetLimitPrompt,
  renderThreadGoalContinuationPrompt,
  shouldResetThreadGoalContinuationStallCount,
  type ThreadGoal,
  type ThreadGoalContinuationKind,
} from '../utils/threadGoal.js';
```

Add this import near other service utility imports:

```ts
import { roughTokenCountEstimation } from '../services/tokenEstimation.js';
```

- [ ] **Step 2: Add live streaming token estimate**

Near the existing `visibleStreamingText` calculation around `streamingText` / `streamingThinking`, add:

```ts
  const liveStreamingTokenEstimate = useMemo(() => {
    const textTokens = streamingText
      ? roughTokenCountEstimation(streamingText)
      : 0;
    const thinkingTokens = streamingThinking?.thinking
      ? roughTokenCountEstimation(streamingThinking.thinking)
      : 0;
    return textTokens + thinkingTokens;
  }, [streamingText, streamingThinking]);
```

If the file's style omits semicolons in this area, match the surrounding style while keeping the same logic.

- [ ] **Step 3: Add live goal display value**

After `displayedMessages` is defined in `src/screens/REPL.tsx`, add:

```ts
  const threadGoalDisplay = useMemo(
    () =>
      buildThreadGoalDisplayState({
        goal: threadGoal,
        liveContextTokens:
          tokenCountWithEstimation(messages) + liveStreamingTokenEstimate,
        turnStartContextTokens: turnContextTokensAtStartRef.current,
        turnGoalId: turnGoalAtStartRef.current?.goalId ?? null,
        isTurnRunning: isLoading,
      }),
    [threadGoal, messages, liveStreamingTokenEstimate, isLoading],
  );
```

Use `messages`, not `displayedMessages`, because `displayedMessages` can be deferred for render smoothness. Goal display should reflect current REPL state plus streaming estimates.

- [ ] **Step 4: Pass display goal into `PromptInput`**

In the large `<PromptInput ... />` call in `src/screens/REPL.tsx`, add:

```tsx
threadGoalDisplay={threadGoalDisplay}
```

Place it near related state props such as `isLoading={isLoading}` or `messages={messages}` so future readers can find it.

- [ ] **Step 5: Build to verify REPL/component wiring**

Run:

```bash
bun run build:dev
```

Expected: PASS and output ending with `Built ./cli-dev`.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/screens/REPL.tsx src/components/PromptInput/PromptInput.tsx
git commit -m "feat: show live goal context usage"
```

---

### Task 4: Focused Verification And Cleanup

**Files:**
- Read: `git diff --stat`
- Read: `git diff --check`
- Test: focused goal tests and dev build
- Modify: `DONE.md` only if the implementation changes user-facing behavior enough to warrant a done-log entry

- [ ] **Step 1: Run focused tests**

Run:

```bash
bun test src/utils/threadGoal.test.ts src/tools/UpdateGoalTool/UpdateGoalTool.test.ts src/tools/GetGoalTool/GetGoalTool.test.ts src/tools/CreateGoalTool/CreateGoalTool.test.ts src/commands/goal/goal.test.ts
```

Expected: PASS with all tests passing.

- [ ] **Step 2: Run build**

Run:

```bash
bun run build:dev
```

Expected: PASS and output ending with `Built ./cli-dev`.

- [ ] **Step 3: Check whitespace and staged scope**

Run:

```bash
git diff --check
git diff --stat
git status --short
```

Expected:
- `git diff --check` prints no whitespace errors.
- `git diff --stat` includes only the files in this plan and any intentional `DONE.md` update.
- `git status --short` may show unrelated pre-existing changes, but they must remain unstaged for this work.

- [ ] **Step 4: Manually smoke test live footer**

Run the local CLI from the built dev binary:

```bash
./cli-dev
```

In the interactive session:

```text
/goal test live footer movement
```

Then send a prompt that streams visible reasoning/text for a few seconds:

```text
Write a concise but non-trivial explanation of how goal context accounting works in this app.
```

Expected:
- During the running turn, footer changes from `Goal: active` to a value like `Goal: active · 1.2K ctx`.
- After the turn completes, the persisted footer remains close to the live value.
- If the turn compacts or context shrinks, the displayed goal value does not go below the persisted `tokensUsed`.

- [ ] **Step 5: Add a `DONE.md` entry if requested**

If the user asks to update `DONE.md`, add this under the latest `### 2 May 2026` section:

```md
58. Added live goal footer usage — active goal status now shows display-only context-token growth while a turn streams, without persisting the live estimate until turn completion.
```

Then stage it with the implementation. If the user does not request a done-log update, skip this step.

- [ ] **Step 6: Commit final verification/doc cleanup**

If Task 4 changed files:

```bash
git add DONE.md
git commit -m "docs: record live goal footer usage"
```

If Task 4 did not change files, do not create an empty commit.

---

## Self-Review

- Spec coverage: The plan covers live footer movement, display-only state, positive context growth, no decrement after compaction/reset, completed-goal freeze, streaming text/reasoning estimates, component prop wiring, focused tests, build verification, and manual smoke testing.
- Placeholder scan: No `TBD`, `TODO`, vague edge handling, or unspecified tests remain. Each implementation step names exact files and code to add.
- Type consistency: The helper is consistently named `buildThreadGoalDisplayState`. The prop is consistently named `threadGoalDisplay`. Existing `ThreadGoal`, `tokenCountWithEstimation`, and `roughTokenCountEstimation` names match the current codebase.
