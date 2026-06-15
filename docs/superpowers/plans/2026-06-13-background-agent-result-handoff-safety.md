# Background Agent Result Handoff Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent parent agents from reading raw local-agent transcript output when a clean structured background-agent result path exists.

**Architecture:** Keep the fix narrow: make automatic completion notifications the normal background-agent result handoff, keep `TaskOutput` as the safe structured manual retrieval/status path, reserve `block=true` for intentional waits, remove launch-result instructions that permit raw output-file reads, keep local-agent notifications at their existing `later` priority, and make running local-agent non-blocking output avoid transcript content. Do not change transcript storage or the Read tool in this pass; raw transcript guarding can be a separate hardening task after this safer path is restored.

**Tech Stack:** TypeScript, React/Ink tool rendering, Bun tests, Cat Code task queue and AgentTool runtime.

---

## File structure

**Modify:**

- `src/tools/TaskOutputTool/TaskOutputTool.tsx`
  - Responsibility: expose structured task output retrieval to the model.
  - Change: replace deprecated/raw-Read wording with guidance to prefer `TaskOutput`, especially for local agents whose disk output is a JSONL transcript symlink.

- `src/tools/AgentTool/AgentTool.tsx`
  - Responsibility: map Agent tool launch results into model-visible tool results.
  - Change: keep `output_file` available as a debug transcript path, but remove the instruction that raw `Read` is an acceptable progress path.

- `src/tasks/LocalAgentTask/LocalAgentTask.tsx`
  - Responsibility: register local agent tasks and enqueue background-agent completion notifications.
  - Change: keep local-agent completion notifications on the default `later` path; automatic completion notification is the normal background handoff, and `TaskOutput` is only the manual retrieval/status path or an intentional wait.

- `src/tools/AgentTool/AgentTool.test.ts`
  - Responsibility: AgentTool behavior and result-message tests.
  - Change: add a direct test for async launch guidance.

- `src/tasks/LocalAgentTask/LocalAgentTask.test.ts`
  - Responsibility: local agent task lifecycle tests.
  - Change: add a regression test that completion notifications keep the default `later` priority.

**Create:**

- `src/tools/TaskOutputTool/TaskOutputTool.test.tsx`
  - Responsibility: TaskOutputTool prompt and local-agent clean-result behavior tests.

**Do not modify in this plan:**

- `src/utils/task/diskOutput.ts`
  - Local agent output remains a symlink to the sidechain transcript. This plan changes the recommended retrieval path, not the storage model.

- `src/utils/messageQueueManager.ts`
  - Keep the global `enqueuePendingNotification()` default at `later`. This plan preserves that default for local-agent completion notifications.

- `src/query.ts`
  - Keep the existing mid-turn drain semantics. Changing general queue draining would be broader and riskier than this incident needs.

---

### Task 1: Restore TaskOutput as the safe structured manual retrieval path

**Files:**

- Create: `src/tools/TaskOutputTool/TaskOutputTool.test.tsx`
- Modify: `src/tools/TaskOutputTool/TaskOutputTool.tsx:157-181`

- [ ] **Step 1: Write failing tests for TaskOutputTool guidance and clean local-agent results**

Create `src/tools/TaskOutputTool/TaskOutputTool.test.tsx` with this content:

```tsx
import { describe, expect, test } from 'bun:test'

import type { AppState } from '../../state/AppStateStore.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { TaskOutputTool } from './TaskOutputTool.js'

function makeContext(appStateRef: { current: AppState }) {
  return {
    getAppState: () => appStateRef.current,
    setAppState: (updater: (prev: AppState) => AppState) => {
      appStateRef.current = updater(appStateRef.current)
    },
    abortController: new AbortController(),
  }
}

function makeCompletedLocalAgentTask(): LocalAgentTaskState {
  return {
    id: 'agent-clean-result',
    type: 'local_agent',
    status: 'completed',
    description: 'Inspect sessions page',
    startTime: 1,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    agentId: 'agent-clean-result',
    prompt: 'Inspect sessions page',
    agentType: 'Explore',
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
    result: {
      agentId: 'agent-clean-result',
      agentType: 'Explore',
      content: [
        {
          type: 'text',
          text: 'Clean final answer from the subagent.',
        },
      ],
      totalToolUseCount: 3,
      totalDurationMs: 42,
      totalTokens: 100,
    },
  }
}

describe('TaskOutputTool', () => {
  test('prompt advertises TaskOutput as the safe structured path', async () => {
    await expect(TaskOutputTool.description()).resolves.toBe(
      'Read structured output from a background task',
    )

    const prompt = await TaskOutputTool.prompt()

    expect(prompt).toContain(
      'Prefer this tool over reading task output files directly.',
    )
    expect(prompt).toContain(
      'For local agents, the output file can be a full JSONL transcript; this tool returns the clean final answer when available.',
    )
    expect(prompt).not.toContain('DEPRECATED')
    expect(prompt).not.toContain('Read that file directly')
    expect(prompt).not.toContain('prefer Read on the task output file path')
  })

  test('local agent output returns the clean final answer instead of raw disk transcript output', async () => {
    const appStateRef = { current: getDefaultAppState() }
    appStateRef.current = {
      ...appStateRef.current,
      tasks: {
        ...appStateRef.current.tasks,
        'agent-clean-result': makeCompletedLocalAgentTask(),
      },
    }

    const result = await TaskOutputTool.call(
      {
        task_id: 'agent-clean-result',
        block: false,
        timeout: 0,
      },
      makeContext(appStateRef) as never,
      undefined as never,
      undefined as never,
    )

    expect(result.data.retrieval_status).toBe('success')
    expect(result.data.task?.output).toBe('Clean final answer from the subagent.')
    expect(result.data.task?.result).toBe('Clean final answer from the subagent.')
    expect(appStateRef.current.tasks['agent-clean-result']?.notified).toBe(true)
  })
})
```

- [ ] **Step 2: Run the TaskOutputTool tests and verify they fail**

Run:

```bash
cd /Users/pt/cat-code && bun test src/tools/TaskOutputTool/TaskOutputTool.test.tsx
```

Expected result before implementation:

```text
FAIL src/tools/TaskOutputTool/TaskOutputTool.test.tsx
```

Expected failing assertions:

```text
expected "[Deprecated] — prefer Read on the task output file path" to be "Read structured output from a background task"
```

and/or prompt assertions that still find `DEPRECATED` or raw `Read` guidance.

- [ ] **Step 3: Update TaskOutputTool description and prompt**

In `src/tools/TaskOutputTool/TaskOutputTool.tsx`, replace the current `description()` and `prompt()` methods with:

```ts
  async description() {
    return 'Read structured output from a background task';
  },
```

and:

```ts
  async prompt() {
    return `Use this tool to retrieve structured output from a running or completed background task.

- Prefer this tool over reading task output files directly.
- For local agents, the output file can be a full JSONL transcript; this tool returns the clean final answer when available.
- Takes a task_id parameter identifying the task.
- Returns task status, output, and type-specific fields.
- Use block=true only when you intentionally want to wait for task completion.
- Use block=false for a non-blocking status/output check.
- Task IDs are shown in background task launch results and task notifications.
- Works with background shell tasks, local agents, and remote agent sessions.`;
  },
```

Do not change `getTaskOutputData()` in this task; it already prefers `agentTask.result` for local agents.

- [ ] **Step 4: Run the TaskOutputTool tests and verify they pass**

Run:

```bash
cd /Users/pt/cat-code && bun test src/tools/TaskOutputTool/TaskOutputTool.test.tsx
```

Expected result:

```text
PASS src/tools/TaskOutputTool/TaskOutputTool.test.tsx
```

- [ ] **Step 5: Review the diff for accidental broad behavior changes**

Run:

```bash
cd /Users/pt/cat-code && git diff -- src/tools/TaskOutputTool/TaskOutputTool.tsx src/tools/TaskOutputTool/TaskOutputTool.test.tsx
```

Expected result:

- Only TaskOutputTool wording changed in production code.
- The clean local-agent result behavior is tested but not reimplemented.
- No Read-tool behavior changed.

Do not commit unless the user explicitly asks for commits.

---

### Task 2: Remove raw transcript-read guidance from Agent launch results

**Files:**

- Modify: `src/tools/AgentTool/AgentTool.tsx:1953-1955`
- Modify: `src/tools/AgentTool/AgentTool.test.ts`

- [ ] **Step 1: Add a failing AgentTool launch guidance test**

In `src/tools/AgentTool/AgentTool.test.ts`, add this test inside `describe('AgentTool UI', () => { ... })` after the existing `single async launch result introduces the resolved friendly agent name` test:

```ts
  test('async launch result frames TaskOutput as optional manual retrieval', () => {
    const block = AgentTool.mapToolResultToToolResultBlockParam(
      {
        status: 'async_launched',
        agentId: 'agent-a',
        agentName: 'Ada',
        agentType: 'Explore',
        description: 'inspect sessions page',
        prompt: 'inspect sessions page',
        outputFile: '/tmp/agent-a.output',
        canCheckProgress: true,
      },
      'tool-a',
    )

    const text = Array.isArray(block.content)
      ? block.content
          .map(part => (part.type === 'text' ? part.text : ''))
          .join('\n')
      : block.content

    expect(text).toContain(
      'TaskOutput is available for explicit status checks, manual retrieval, or intentional waits',
    )
    expect(text).toContain('not the default background-agent result handoff')
    expect(text).not.toContain('block: true')
    expect(text).not.toContain('call TaskOutput')
    expect(text).toContain('automatic completion notification')
    expect(text).toContain('end your response')
    expect(text).toContain('yield the turn')
    expect(text).toContain('output_file: /tmp/agent-a.output')
    expect(text).toContain('debug transcript path only')
    expect(text).toContain('do not read it for progress or results')
    expect(text).toContain('raw transcript forensics')
    expect(text).not.toContain('Read on the output file')
    expect(text).not.toContain('raw stdout')
  })
```

- [ ] **Step 2: Run the AgentTool test and verify it fails**

Run:

```bash
cd /Users/pt/cat-code && bun test src/tools/AgentTool/AgentTool.test.ts --test-name-pattern "async launch result frames TaskOutput as optional manual retrieval"
```

Expected result before implementation:

```text
FAIL src/tools/AgentTool/AgentTool.test.ts
```

Expected failing assertion:

```text
expected text not to contain "block: true"
```

- [ ] **Step 3: Update async launch guidance in AgentTool**

In `src/tools/AgentTool/AgentTool.tsx`, replace the `instructions` assignment in the `data.status === 'async_launched'` branch with:

```ts
      const instructions = data.canCheckProgress
        ? `Do not duplicate this agent's work — avoid working with the same files or topics it is using. Work on non-overlapping tasks.
For background launches, normally briefly tell the user what you launched, end your response, and yield the turn; the result will arrive via automatic completion notification. Do not predict or fabricate results.
${TASK_OUTPUT_TOOL_NAME} is available for explicit status checks, manual retrieval, or intentional waits when the user or task requires it; it is not the default background-agent result handoff.
output_file: ${data.outputFile} (debug transcript path only; do not read it for progress or results. Use it only when the user explicitly asks for raw transcript forensics).`
        : `Briefly tell the user what you launched and end your response. Do not generate any other text — agent results will arrive in a subsequent message.`;
```

Keep `output_file` visible for forensic/debug use, keep `TaskOutput` available for manual structured retrieval/status, and make automatic completion notification the model-facing default path.

- [ ] **Step 4: Run the AgentTool test and verify it passes**

Run:

```bash
cd /Users/pt/cat-code && bun test src/tools/AgentTool/AgentTool.test.ts --test-name-pattern "async launch result frames TaskOutput as optional manual retrieval"
```

Expected result:

```text
PASS src/tools/AgentTool/AgentTool.test.ts
```

- [ ] **Step 5: Run the existing AgentTool UI tests for nearby regressions**

Run:

```bash
cd /Users/pt/cat-code && bun test src/tools/AgentTool/AgentTool.test.ts --test-name-pattern "AgentTool UI"
```

Expected result:

```text
PASS src/tools/AgentTool/AgentTool.test.ts
```

Do not commit unless the user explicitly asks for commits.

---

### Task 3: Preserve local-agent completion notifications at later priority

**Files:**

- Modify: `src/tasks/LocalAgentTask/LocalAgentTask.tsx:316-320`
- Modify: `src/tasks/LocalAgentTask/LocalAgentTask.test.ts`

- [ ] **Step 1: Add a regression test for local-agent notification priority**

In `src/tasks/LocalAgentTask/LocalAgentTask.test.ts`, update the import from `messageQueueManager.js`:

```ts
import {
  dequeue,
  getCommandsByMaxPriority,
  resetCommandQueue,
} from '../../utils/messageQueueManager.js'
```

Then add this test after `agent notifications prefer the friendly agent name in the visible summary`:

```ts
  test('local agent completion notifications keep default later priority', () => {
    registerAgentForeground({
      agentId: 'sync-agent-12',
      description: 'Inspect sessions page',
      prompt: 'test prompt',
      selectedAgent: {
        name: 'Explore',
        agentType: 'Explore',
        prompt: 'test prompt',
      },
      agentName: 'Ada',
      setAppState,
    })

    enqueueAgentNotification({
      taskId: 'sync-agent-12',
      description: 'Inspect sessions page',
      status: 'completed',
      setAppState,
    })

    const nextCommands = getCommandsByMaxPriority('next')
    const laterCommands = getCommandsByMaxPriority('later')

    expect(nextCommands).toHaveLength(0)
    expect(laterCommands).toHaveLength(1)
    expect(laterCommands[0]?.mode).toBe('task-notification')
    expect(laterCommands[0]?.priority).toBe('later')
    expect(laterCommands[0]?.value).toContain('Agent @Ada completed')
  })
```

- [ ] **Step 2: Run the targeted LocalAgentTask test**

Run:

```bash
cd /Users/pt/cat-code && bun test src/tasks/LocalAgentTask/LocalAgentTask.test.ts --test-name-pattern "local agent completion notifications keep default later priority"
```

Expected result:

```text
PASS src/tasks/LocalAgentTask/LocalAgentTask.test.ts
```

- [ ] **Step 3: Keep local-agent completion notifications on the default later path**

In `src/tasks/LocalAgentTask/LocalAgentTask.tsx`, keep the `enqueuePendingNotification()` call in `enqueueAgentNotification()` without an explicit priority:

```ts
  enqueuePendingNotification({
    value: formatTaskNotificationText(details),
    mode: 'task-notification',
    origin: toTaskNotificationOrigin(details),
  });
```

Do not change `enqueuePendingNotification()` itself. Shell, hook, remote-agent, scheduled-task, local-agent, and slash-command notification priorities should keep their existing behavior unless another incident justifies widening the change.

- [ ] **Step 4: Run the full LocalAgentTask test file**

Run:

```bash
cd /Users/pt/cat-code && bun test src/tasks/LocalAgentTask/LocalAgentTask.test.ts
```

Expected result:

```text
PASS src/tasks/LocalAgentTask/LocalAgentTask.test.ts
```

Do not commit unless the user explicitly asks for commits.

---

### Task 4: Run focused integration checks across the changed surfaces

**Files:**

- Test only: `src/tools/TaskOutputTool/TaskOutputTool.test.tsx`
- Test only: `src/tools/AgentTool/AgentTool.test.ts`
- Test only: `src/tasks/LocalAgentTask/LocalAgentTask.test.ts`

- [ ] **Step 1: Run all changed-surface tests together**

Run:

```bash
cd /Users/pt/cat-code && bun test src/tools/TaskOutputTool/TaskOutputTool.test.tsx src/tools/AgentTool/AgentTool.test.ts src/tasks/LocalAgentTask/LocalAgentTask.test.ts
```

Expected result:

```text
PASS src/tools/TaskOutputTool/TaskOutputTool.test.tsx
PASS src/tools/AgentTool/AgentTool.test.ts
PASS src/tasks/LocalAgentTask/LocalAgentTask.test.ts
```

If a pre-existing unrelated test in one of these files fails, capture the exact failing test name and output before deciding whether to adjust this plan.

- [ ] **Step 2: Check for stale raw-output guidance in changed files**

Run:

```bash
cd /Users/pt/cat-code && rg "DEPRECATED: Prefer using the Read tool|prefer Read on the task output file path|Read on the output file for raw stdout|Read that file directly" src/tools/TaskOutputTool src/tools/AgentTool src/tasks/LocalAgentTask
```

Expected result:

```text
(no matches)
```

- [ ] **Step 3: Check that local-agent transcript symlink behavior remains unchanged**

Run:

```bash
cd /Users/pt/cat-code && git diff -- src/tasks/LocalAgentTask/LocalAgentTask.tsx src/utils/task/diskOutput.ts
```

Expected result:

- `src/tasks/LocalAgentTask/LocalAgentTask.tsx` does not add an explicit notification priority.
- `src/utils/task/diskOutput.ts` has no diff.

Do not commit unless the user explicitly asks for commits.

---

### Task 5: Final verification and Cat Code change-impact check

**Files:**

- Verify changed code and tests.
- No production source edits in this task.

- [ ] **Step 1: Run the focused test suite again**

Run:

```bash
cd /Users/pt/cat-code && bun test src/tools/TaskOutputTool/TaskOutputTool.test.tsx src/tools/AgentTool/AgentTool.test.ts src/tasks/LocalAgentTask/LocalAgentTask.test.ts
```

Expected result:

```text
PASS src/tools/TaskOutputTool/TaskOutputTool.test.tsx
PASS src/tools/AgentTool/AgentTool.test.ts
PASS src/tasks/LocalAgentTask/LocalAgentTask.test.ts
```

- [ ] **Step 2: Run the documented full build**

Run:

```bash
cd /Users/pt/cat-code && bun run build:dev:full
```

Expected result:

```text
The build completes successfully.
```

Use this exact command because repository instructions say not to use `bun run build` or `./cli` unless explicitly asked.

- [ ] **Step 3: Run whitespace/diff sanity check**

Run:

```bash
cd /Users/pt/cat-code && git diff --check
```

Expected result:

```text
(no output)
```

- [ ] **Step 4: Search for stale user-facing guidance across the repo**

Run:

```bash
cd /Users/pt/cat-code && rg "TaskOutput.*Deprecated|DEPRECATED: Prefer using the Read tool|prefer Read on the task output file path|Read on the output file for raw stdout|Read that file directly" src docs/superpowers/plans
```

Expected result:

```text
(no matches)
```

- [ ] **Step 5: Run the Cat Code change-impact skill before reporting completion**

Because this changes Cat Code tool instructions, preserves task notification timing, and changes agent handoff behavior, run the `checking-cat-code-change-impact` skill before declaring the implementation complete.

Expected checklist outcome:

- Tool prompt/user-facing wording reviewed.
- Agent launch result wording reviewed.
- Task queue priority impact reviewed.
- Tests and build evidence included in final report.

Do not commit unless the user explicitly asks for commits.

---

## Self-review

**Spec coverage:**

- Unsafe raw `output_file` guidance is addressed by Task 2.
- Contradictory `TaskOutputTool` deprecation guidance is addressed by Task 1.
- Existing clean local-agent result path is preserved and tested by Task 1.
- Normal delayed local-agent final-result delivery is addressed by automatic completion notifications while local-agent completion notifications keep their default `later` priority; `TaskOutput` remains the safe structured manual retrieval/status path, with `block=true` reserved for intentional waits.
- The raw transcript symlink storage model is intentionally not changed; the plan prevents routine parent reads of that transcript by changing instructions and structured retrieval behavior.
- Full notification trimming and Read-tool transcript guards are not included because they are broader behavior changes. They should be separate follow-up work if this minimal fix does not prevent recurrence.

**Placeholder scan:**

- This plan contains no `TBD`, no unfinished code blocks, and no generic “add tests” steps without test code.

**Type consistency:**

- `TaskOutputTool` tests use `LocalAgentTaskState.result` with the current `AgentToolResult` fields: `agentId`, `agentType`, `content`, `totalToolUseCount`, `totalDurationMs`, and `totalTokens`.
- Local agent queue test uses existing `enqueueAgentNotification()` and `getCommandsByMaxPriority()` APIs to verify `later` remains the default delivery path.
- AgentTool launch guidance test uses existing `AgentTool.mapToolResultToToolResultBlockParam()` and current async launch result fields.
