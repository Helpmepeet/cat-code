# Agent Mode Worker Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the missing Agent Mode worker control-plane primitives: list known workers, wait for worker completion, read worker results, cancel a worker, and track whether completed worker results have been synthesized into the main objective.

**Architecture:** Build on the existing task runtime instead of duplicating it. `TaskOutput` already waits for background task completion and reads output; `TaskStop` already stops running tasks. This plan adds Agent Mode worker-aware wrappers and state fields in `sessionState.ts`, then updates the orchestrator prompt to use those explicit primitives for convergence.

**Tech Stack:** TypeScript, Bun test runner, existing Cat Code tools/task runtime.

---

## Prerequisite

Complete or include the plan in:

- `docs/superpowers/plans/2026-05-01-agent-mode-live-worker-state-plan.md`

This plan assumes:

- live Agent Mode turns receive formatted durable worker state
- `SendMessage` can resolve durable worker handles
- failed/killed workers are not advertised as clean resumable workers

## Files

- Modify: `src/agent-mode/sessionState.ts`
- Modify: `src/agent-mode/orchestratorPrompt.ts`
- Modify: `src/constants/tools.ts`
- Modify: `src/tools.ts`
- Create: `src/tools/ListWorkersTool/constants.ts`
- Create: `src/tools/ListWorkersTool/ListWorkersTool.ts`
- Create: `src/tools/WaitWorkersTool/constants.ts`
- Create: `src/tools/WaitWorkersTool/WaitWorkersTool.ts`
- Create: `src/tools/GetWorkerResultTool/constants.ts`
- Create: `src/tools/GetWorkerResultTool/GetWorkerResultTool.ts`
- Create: `src/tools/CancelWorkerTool/constants.ts`
- Create: `src/tools/CancelWorkerTool/CancelWorkerTool.ts`
- Test: `src/agent-mode/sessionState.test.ts`
- Test: `src/tools/ListWorkersTool/ListWorkersTool.test.ts`
- Test: `src/tools/WaitWorkersTool/WaitWorkersTool.test.ts`
- Test: `src/tools/GetWorkerResultTool/GetWorkerResultTool.test.ts`
- Test: `src/tools/CancelWorkerTool/CancelWorkerTool.test.ts`

## Existing Code To Reuse

- `src/agent-mode/sessionState.ts`: durable Agent Mode worker records
- `src/tools/TaskOutputTool/TaskOutputTool.tsx`: blocking/non-blocking task output and completion wait
- `src/tools/TaskStopTool/TaskStopTool.ts`: task cancellation
- `src/utils/task/diskOutput.ts`: task output paths and reads
- `src/tasks/stopTask.ts`: shared task stop implementation
- `src/tools/AgentTool/agentToolUtils.ts`: records worker terminal states

## Task 1: Add Worker Result Synthesis State

**Files:**
- Modify: `src/agent-mode/sessionState.ts`
- Test: `src/agent-mode/sessionState.test.ts`

- [ ] **Step 1: Extend worker session type**

In `AgentModeWorkerSession`, add:

```ts
  lastResultAt?: string
  lastResultSummary?: string
  synthesisStatus?: 'pending' | 'synthesized'
  lastSynthesizedAt?: string
```

- [ ] **Step 2: Mark completed results as pending synthesis**

In `recordWorkerSessionTerminal(...)`, update the stored worker object so completed workers get synthesis metadata:

```ts
const endedAt = new Date().toISOString()
const completed = status === 'completed'

state.knownWorkers[agentId] = {
  ...existing,
  status,
  resumable: completed,
  ...(error ? { error } : {}),
  ...(outputSummary ? { outputSummary } : {}),
  ...(completed
    ? {
        lastResultAt: endedAt,
        lastResultSummary: outputSummary,
        synthesisStatus: 'pending' as const,
      }
    : {}),
}
```

Do not set `synthesisStatus: 'pending'` for failed or killed workers. Those should remain evidence to inspect, not completed results waiting for synthesis.

- [ ] **Step 3: Add a function to mark a worker synthesized**

Add this export in `src/agent-mode/sessionState.ts`:

```ts
export async function markWorkerResultSynthesized({
  sessionId,
  agentId,
}: {
  sessionId: string
  agentId: string
}): Promise<boolean> {
  let found = false
  await mutatePersistedSessionState(sessionId, null, state => {
    const existing = state.knownWorkers[agentId]
    if (!existing) return

    found = true
    state.knownWorkers[agentId] = {
      ...existing,
      synthesisStatus: 'synthesized',
      lastSynthesizedAt: new Date().toISOString(),
    }
  })
  return found
}
```

- [ ] **Step 4: Update formatted session state**

In `formatWorkerSession(...)`, append synthesis status when present:

```ts
worker.synthesisStatus ? `synthesis:${worker.synthesisStatus}` : undefined,
```

The formatted line should make pending worker results visible in live Agent Mode context.

- [ ] **Step 5: Test synthesis state transitions**

Extend `src/agent-mode/sessionState.test.ts` with assertions:

```ts
expect(completedWorker.synthesisStatus).toBe('pending')
expect(completedWorker.lastResultAt).toBeTruthy()

await markWorkerResultSynthesized({ sessionId, agentId })
const state = await readSessionState(sessionId)
expect(state!.knownWorkers.find(w => w.agentId === agentId)!.synthesisStatus)
  .toBe('synthesized')
```

- [ ] **Step 6: Run focused test**

Run:

```bash
bun test src/agent-mode/sessionState.test.ts
```

Expected: all session state tests pass.

## Task 2: Add ListWorkers Tool

**Files:**
- Create: `src/tools/ListWorkersTool/constants.ts`
- Create: `src/tools/ListWorkersTool/ListWorkersTool.ts`
- Modify: `src/tools.ts`
- Modify: `src/constants/tools.ts`
- Test: `src/tools/ListWorkersTool/ListWorkersTool.test.ts`

- [ ] **Step 1: Add constants file**

Create `src/tools/ListWorkersTool/constants.ts`:

```ts
export const LIST_WORKERS_TOOL_NAME = 'ListWorkers'
```

- [ ] **Step 2: Implement read-only tool**

Create `src/tools/ListWorkersTool/ListWorkersTool.ts`:

```ts
import { z } from 'zod/v4'
import { getSessionId } from '../../bootstrap/state.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { isAgentMode } from '../../agent-mode/agentMode.js'
import { readSessionState } from '../../agent-mode/sessionState.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { LIST_WORKERS_TOOL_NAME } from './constants.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    activeOnly: z.boolean().optional().describe('Only return running workers'),
    resumableOnly: z.boolean().optional().describe('Only return resumable workers'),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

export const ListWorkersTool = buildTool({
  name: LIST_WORKERS_TOOL_NAME,
  searchHint: 'list Agent Mode worker sessions',
  maxResultSizeChars: 100_000,
  userFacingName: () => '',
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  isEnabled() {
    return isAgentMode()
  },
  isReadOnly() {
    return true
  },
  async description() {
    return 'List known Agent Mode worker sessions and their status'
  },
  async prompt() {
    return 'List known Agent Mode workers, including handle, agentId, role, status, resumability, and synthesis status.'
  },
  async call(input: Input) {
    const state = await readSessionState(getSessionId())
    const workers = state?.knownWorkers ?? []
    const filtered = workers.filter(worker => {
      if (input.activeOnly && worker.status !== 'running') return false
      if (input.resumableOnly && !worker.resumable) return false
      return true
    })
    return {
      data: {
        objective: state?.objective ?? '',
        currentPhase: state?.currentPhase ?? 'planning',
        nextAction: state?.nextAction ?? '',
        workers: filtered,
      },
    }
  },
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(data),
    }
  },
} satisfies ToolDef<InputSchema, unknown>)
```

- [ ] **Step 3: Register tool**

In `src/tools.ts`, import:

```ts
import { ListWorkersTool } from './tools/ListWorkersTool/ListWorkersTool.js'
```

Add `ListWorkersTool` to `getAllBaseTools()` near `TaskOutputTool` / `TaskStopTool`.

- [ ] **Step 4: Block tool inside subagents**

In `src/constants/tools.ts`, import:

```ts
import { LIST_WORKERS_TOOL_NAME } from '../tools/ListWorkersTool/constants.js'
```

Add `LIST_WORKERS_TOOL_NAME` to `ALL_AGENT_DISALLOWED_TOOLS`.

- [ ] **Step 5: Test ListWorkers**

Create `src/tools/ListWorkersTool/ListWorkersTool.test.ts` with assertions:

```ts
process.env.CLAUDE_CODE_AGENT_MODE = '1'
const result = await ListWorkersTool.call({ activeOnly: false }, context as never)
expect(result.data.workers).toEqual(expect.arrayContaining([
  expect.objectContaining({ handle: 'explore-1', status: 'completed' }),
]))
```

- [ ] **Step 6: Run focused test**

Run:

```bash
bun test src/tools/ListWorkersTool/ListWorkersTool.test.ts
```

Expected: test passes.

## Task 3: Add WaitWorkers Tool

**Files:**
- Create: `src/tools/WaitWorkersTool/constants.ts`
- Create: `src/tools/WaitWorkersTool/WaitWorkersTool.ts`
- Modify: `src/tools.ts`
- Modify: `src/constants/tools.ts`
- Test: `src/tools/WaitWorkersTool/WaitWorkersTool.test.ts`

- [ ] **Step 1: Add constants file**

Create `src/tools/WaitWorkersTool/constants.ts`:

```ts
export const WAIT_WORKERS_TOOL_NAME = 'WaitWorkers'
```

- [ ] **Step 2: Implement wait by handle or agent id**

Create `src/tools/WaitWorkersTool/WaitWorkersTool.ts`:

```ts
import { z } from 'zod/v4'
import { getSessionId } from '../../bootstrap/state.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { isAgentMode } from '../../agent-mode/agentMode.js'
import { resolveWorkerAgentId } from '../../agent-mode/sessionState.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { sleep } from '../../utils/sleep.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import type { TaskState } from '../../tasks/types.js'
import { WAIT_WORKERS_TOOL_NAME } from './constants.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    workers: z.array(z.string()).min(1).describe('Worker handles or agent IDs to wait for'),
    timeout: z.number().min(0).max(600000).default(30000).describe('Max wait time in ms'),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

export const WaitWorkersTool = buildTool({
  name: WAIT_WORKERS_TOOL_NAME,
  searchHint: 'wait for Agent Mode workers to finish',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  userFacingName: () => '',
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  isEnabled() {
    return isAgentMode()
  },
  async description() {
    return 'Wait for selected Agent Mode workers to reach a terminal status'
  },
  async prompt() {
    return 'Wait for one or more Agent Mode workers by handle or agentId before synthesizing their results.'
  },
  async call(input: Input, context) {
    const sessionId = getSessionId()
    const resolved = await Promise.all(
      input.workers.map(async target => ({
        target,
        agentId: await resolveWorkerAgentId(sessionId, target),
      })),
    )
    const missing = resolved.filter(item => !item.agentId).map(item => item.target)
    const agentIds = resolved.flatMap(item => (item.agentId ? [item.agentId] : []))
    const start = Date.now()

    while (Date.now() - start < input.timeout) {
      const tasks = context.getAppState().tasks ?? {}
      const statuses = agentIds.map(agentId => {
        const task = tasks[agentId] as TaskState | undefined
        return {
          agentId,
          status: task?.status ?? 'not_in_memory',
          description: task?.description ?? '',
        }
      })
      if (statuses.every(item => item.status !== 'running' && item.status !== 'pending')) {
        return { data: { status: 'complete', missing, workers: statuses } }
      }
      await sleep(100)
    }

    const tasks = context.getAppState().tasks ?? {}
    return {
      data: {
        status: 'timeout',
        missing,
        workers: agentIds.map(agentId => {
          const task = tasks[agentId] as TaskState | undefined
          return {
            agentId,
            status: task?.status ?? 'not_in_memory',
            description: task?.description ?? '',
          }
        }),
      },
    }
  },
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(data),
    }
  },
} satisfies ToolDef<InputSchema, unknown>)
```

- [ ] **Step 3: Register and disallow in subagents**

Add `WaitWorkersTool` to `src/tools.ts`.

Add `WAIT_WORKERS_TOOL_NAME` to `ALL_AGENT_DISALLOWED_TOOLS` in `src/constants/tools.ts`.

- [ ] **Step 4: Test terminal and timeout behavior**

Create `src/tools/WaitWorkersTool/WaitWorkersTool.test.ts`.

Required assertions:

```ts
expect(result.data.status).toBe('complete')
expect(timeoutResult.data.status).toBe('timeout')
expect(missingResult.data.missing).toContain('unknown-worker')
```

- [ ] **Step 5: Run focused test**

Run:

```bash
bun test src/tools/WaitWorkersTool/WaitWorkersTool.test.ts
```

Expected: test passes.

## Task 4: Add GetWorkerResult Tool

**Files:**
- Create: `src/tools/GetWorkerResultTool/constants.ts`
- Create: `src/tools/GetWorkerResultTool/GetWorkerResultTool.ts`
- Modify: `src/tools.ts`
- Modify: `src/constants/tools.ts`
- Test: `src/tools/GetWorkerResultTool/GetWorkerResultTool.test.ts`

- [ ] **Step 1: Add constants file**

Create `src/tools/GetWorkerResultTool/constants.ts`:

```ts
export const GET_WORKER_RESULT_TOOL_NAME = 'GetWorkerResult'
```

- [ ] **Step 2: Implement result reader by handle or id**

Create `src/tools/GetWorkerResultTool/GetWorkerResultTool.ts`:

```ts
import { z } from 'zod/v4'
import { getSessionId } from '../../bootstrap/state.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { isAgentMode } from '../../agent-mode/agentMode.js'
import {
  markWorkerResultSynthesized,
  resolveWorkerAgentId,
} from '../../agent-mode/sessionState.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getTaskOutput } from '../../utils/task/diskOutput.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { GET_WORKER_RESULT_TOOL_NAME } from './constants.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    worker: z.string().describe('Worker handle or agent ID'),
    markSynthesized: z.boolean().default(false).describe('Mark this result as synthesized after reading'),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

export const GetWorkerResultTool = buildTool({
  name: GET_WORKER_RESULT_TOOL_NAME,
  searchHint: 'read an Agent Mode worker result',
  maxResultSizeChars: 100_000,
  userFacingName: () => '',
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  isEnabled() {
    return isAgentMode()
  },
  isReadOnly(input) {
    return !input.markSynthesized
  },
  async description() {
    return 'Read a worker output by handle or agentId and optionally mark it synthesized'
  },
  async prompt() {
    return 'Read a completed Agent Mode worker result before synthesizing it into the main objective.'
  },
  async call(input: Input) {
    const sessionId = getSessionId()
    const agentId = await resolveWorkerAgentId(sessionId, input.worker)
    if (!agentId) {
      throw new Error(`No Agent Mode worker found for: ${input.worker}`)
    }

    const output = await getTaskOutput(agentId)
    const synthesized = input.markSynthesized
      ? await markWorkerResultSynthesized({ sessionId, agentId })
      : false

    return {
      data: {
        worker: input.worker,
        agentId,
        output,
        synthesized,
      },
    }
  },
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(data),
    }
  },
} satisfies ToolDef<InputSchema, unknown>)
```

- [ ] **Step 3: Register and disallow in subagents**

Add `GetWorkerResultTool` to `src/tools.ts`.

Add `GET_WORKER_RESULT_TOOL_NAME` to `ALL_AGENT_DISALLOWED_TOOLS` in `src/constants/tools.ts`.

- [ ] **Step 4: Test read and mark synthesized**

Create `src/tools/GetWorkerResultTool/GetWorkerResultTool.test.ts`.

Required assertions:

```ts
expect(result.data.agentId).toBe(agentId)
expect(result.data.output).toContain('worker final answer')
expect(marked.data.synthesized).toBe(true)
```

- [ ] **Step 5: Run focused test**

Run:

```bash
bun test src/tools/GetWorkerResultTool/GetWorkerResultTool.test.ts
```

Expected: test passes.

## Task 5: Add CancelWorker Tool

**Files:**
- Create: `src/tools/CancelWorkerTool/constants.ts`
- Create: `src/tools/CancelWorkerTool/CancelWorkerTool.ts`
- Modify: `src/tools.ts`
- Modify: `src/constants/tools.ts`
- Test: `src/tools/CancelWorkerTool/CancelWorkerTool.test.ts`

- [ ] **Step 1: Add constants file**

Create `src/tools/CancelWorkerTool/constants.ts`:

```ts
export const CANCEL_WORKER_TOOL_NAME = 'CancelWorker'
```

- [ ] **Step 2: Implement worker-aware stop wrapper**

Create `src/tools/CancelWorkerTool/CancelWorkerTool.ts`:

```ts
import { z } from 'zod/v4'
import { getSessionId } from '../../bootstrap/state.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { isAgentMode } from '../../agent-mode/agentMode.js'
import { resolveWorkerAgentId } from '../../agent-mode/sessionState.js'
import { stopTask } from '../../tasks/stopTask.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { CANCEL_WORKER_TOOL_NAME } from './constants.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    worker: z.string().describe('Worker handle or agent ID to cancel'),
    reason: z.string().optional().describe('Short reason for cancellation'),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

export const CancelWorkerTool = buildTool({
  name: CANCEL_WORKER_TOOL_NAME,
  searchHint: 'cancel an Agent Mode worker',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  userFacingName: () => '',
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  isEnabled() {
    return isAgentMode()
  },
  async description() {
    return 'Cancel a running Agent Mode worker by handle or agentId'
  },
  async prompt() {
    return 'Cancel a specific Agent Mode worker when it is stale, wrongly scoped, or no longer needed.'
  },
  async call(input: Input, { getAppState, setAppState }) {
    const agentId = await resolveWorkerAgentId(getSessionId(), input.worker)
    if (!agentId) {
      throw new Error(`No Agent Mode worker found for: ${input.worker}`)
    }

    const result = await stopTask(agentId, { getAppState, setAppState })
    return {
      data: {
        worker: input.worker,
        agentId,
        reason: input.reason,
        stopped: result,
      },
    }
  },
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(data),
    }
  },
} satisfies ToolDef<InputSchema, unknown>)
```

- [ ] **Step 3: Register and disallow in subagents**

Add `CancelWorkerTool` to `src/tools.ts`.

Add `CANCEL_WORKER_TOOL_NAME` to `ALL_AGENT_DISALLOWED_TOOLS` in `src/constants/tools.ts`.

- [ ] **Step 4: Test handle resolution and stop path**

Create `src/tools/CancelWorkerTool/CancelWorkerTool.test.ts`.

Required assertions:

```ts
expect(result.data.agentId).toBe(agentId)
expect(result.data.stopped.taskId).toBe(agentId)
```

If direct `stopTask` testing requires too much setup, use the existing `TaskStopTool` test pattern if present; otherwise keep this as an integration-style test with a fake running local-agent task in `appState.tasks`.

- [ ] **Step 5: Run focused test**

Run:

```bash
bun test src/tools/CancelWorkerTool/CancelWorkerTool.test.ts
```

Expected: test passes.

## Task 6: Update Orchestrator Doctrine For Convergence

**Files:**
- Modify: `src/agent-mode/orchestratorPrompt.ts`

- [ ] **Step 1: Add explicit worker convergence rules**

In `src/agent-mode/orchestratorPrompt.ts`, under `## Delegation rules` or immediately after it, add:

```ts
## Worker convergence

- Use ListWorkers when you need the current worker roster instead of inferring from transcript.
- Use WaitWorkers after launching parallel workers when their results must be joined before the next decision.
- Use GetWorkerResult before synthesizing a completed worker result. Mark it synthesized once you have incorporated it into the main objective.
- Use CancelWorker for a specific stale, wrongly scoped, or no-longer-needed worker. Do not broadly cancel all workers when one worker is the problem.
- Treat worker completion and objective completion as different states. A worker completing means its bounded assignment ended; you still own synthesis, verification, and final user-facing judgment.
- If any worker has synthesisStatus pending, synthesize or explicitly defer that result before spawning redundant work on the same topic.
```

- [ ] **Step 2: Keep prompt compact**

Do not add a new long workflow. This is a control-plane rule patch only.

- [ ] **Step 3: Run prompt-related tests**

Run:

```bash
bun test src/services/compact/prompt.test.ts src/commands/agent/agent.test.ts
```

Expected: tests still pass.

## Task 7: Validation

**Files:**
- No new files unless fixing test failures.

- [ ] **Step 1: Run focused tests**

Run:

```bash
bun test \
  src/agent-mode/sessionState.test.ts \
  src/tools/ListWorkersTool/ListWorkersTool.test.ts \
  src/tools/WaitWorkersTool/WaitWorkersTool.test.ts \
  src/tools/GetWorkerResultTool/GetWorkerResultTool.test.ts \
  src/tools/CancelWorkerTool/CancelWorkerTool.test.ts \
  src/services/compact/prompt.test.ts \
  src/commands/agent/agent.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run build**

Run:

```bash
bun run build:dev
```

Expected: build completes successfully.

- [ ] **Step 3: Manual Agent Mode smoke test**

Run:

```bash
CLAUDE_CODE_AGENT_MODE=1 bun run dev
```

In the session:

1. Spawn two background workers.
2. Call `ListWorkers`.
3. Call `WaitWorkers` for both handles.
4. Call `GetWorkerResult` for each completed worker with `markSynthesized: true`.
5. Confirm live Agent Mode state no longer shows those workers as `synthesis:pending`.
6. Spawn one long-running worker and call `CancelWorker`.
7. Confirm that worker becomes killed and is not advertised as clean resumable.

Expected: the orchestrator can explicitly list, wait, read, synthesize, and cancel workers without transcript archaeology.

## Commit Plan

- Commit 1: `feat: track worker synthesis state`
- Commit 2: `feat: list agent mode workers`
- Commit 3: `feat: wait for agent mode workers`
- Commit 4: `feat: read and mark worker results`
- Commit 5: `feat: cancel agent mode workers`
- Commit 6: `docs: clarify agent mode worker convergence`

## Acceptance Criteria

- Agent Mode has explicit tools for worker roster, wait/join, result read, and targeted cancellation.
- Completed worker results are marked `synthesis:pending` until the orchestrator explicitly marks them synthesized.
- Failed and killed workers are not treated as normal pending synthesis results.
- The orchestrator prompt distinguishes worker completion from objective completion.
- Parallel worker convergence no longer depends only on notifications or conversational memory.
- Focused tests and `bun run build:dev` pass.
