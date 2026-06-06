# Subagent Cancel State Mismatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the main agent from claiming completion while a background subagent is still running, stopping, or awaiting result synthesis, and make user scope contractions issue real cancellation instead of cooperative queued messages.

**Architecture:** Keep `SendMessage` as a running-worker message queue only. Make `CancelWorker` the model-facing stop primitive for both Agent Mode workers and normal-mode background subagents. Add a durable `stopping` worker status so Agent Mode state reflects "abort requested, cleanup pending" immediately, while final `killed` notification still comes from the existing async lifecycle.

**Tech Stack:** TypeScript, Cat Code task runtime, Agent Mode durable session state, Bun tests.

---

## Incident Facts This Plan Addresses

- In session `8823728c-8fd4-4b46-81d2-f26e96347a49`, the main agent responded to a scope contraction by calling `SendMessage` to `@Ritchie` with "Stop verification now."
- `SendMessage` only queues delivery at the worker's next tool round; it is not cancellation and did not call `AbortController.abort()`.
- `@Ritchie` continued running, completed normally, and produced a delayed task notification.
- A real cancel path already updates local `AppState.tasks[taskId].status` to `killed` promptly through `stopTask()` -> `LocalAgentTask.kill()` -> `killAsyncAgent()`.
- The delayed part is the final model-facing task notification, because `runAgent()` must unwind and run async cleanup before `runAsyncAgentLifecycle()` enqueues `Status: killed`.

## Fresh Session Handoff

Start here if you are implementing this plan without the original chat context.

- Read `CLAUDE.md`, `docs/maps/WORKSPACE_MAP.md`, `docs/maps/agent-mode.md`, and `docs/maps/tasks-workers.md` before broad searching.
- Run `git status --short` before editing. This plan was written in a dirty `phase1` worktree with many unrelated user changes. Preserve unrelated changes; do not reset, revert, or clean files outside this plan.
- Treat this document as the source of truth, but re-check the current source before each task because adjacent subagent work is already in flight. If a "failing" test already passes because a prerequisite was partially implemented, keep going to the next unchecked step instead of forcing a failure.
- Use `apply_patch` for manual edits.
- Do not implement unrelated normal-subagent footer/UI work while executing this plan. The only UI-adjacent change here is Agent Mode worker summary treatment for durable `stopping` state.
- Final verification is not optional: run the focused test suite and `bun run build:dev:full`.

## Source Context To Re-Check

- `src/tools/CancelWorkerTool/CancelWorkerTool.ts`: currently resolves Agent Mode workers through `resolveWorkerAgentId()` and calls `stopTask()`.
- `src/tasks/stopTask.ts`: validates task status is `running` and delegates to the task implementation's `kill()`.
- `src/tasks/LocalAgentTask/LocalAgentTask.tsx`: `LocalAgentTask.kill()` calls `killAsyncAgent()`, which aborts, unregisters cleanup, updates local task status to `killed`, and clears `abortController`.
- `src/tools/AgentTool/runAgent.ts`: abort notification is delayed because `AbortError` is observed after the agent stream unwinds and cleanup runs.
- `src/tools/AgentTool/agentToolUtils.ts`: async lifecycle catches `AbortError`, records terminal `killed`, extracts partial result, and enqueues the final task notification.
- `src/agent-mode/sessionState.ts`: durable worker state currently has `running`, `completed`, `failed`, and `killed`, but no intermediate cancellation state.
- `src/tools/AgentTool/resolveAgentTarget.ts`: resolves normal subagent aliases, metadata names, durable handles, and raw agent IDs. Reuse it; do not reimplement name lookup in `CancelWorker`.

## Import Checklist

Apply these import updates when adding the tests below:

- `src/tools/CancelWorkerTool/CancelWorkerTool.test.ts`: add `readSessionState` to the existing import from `../../agent-mode/sessionState.js`.
- `src/agent-mode/sessionState.test.ts`: add `recordWorkerSessionStopping` to the existing import from `./sessionState.js`.
- `src/tools/WaitWorkersTool/WaitWorkersTool.test.ts`: add `recordWorkerSessionStopping` to the existing import from `../../agent-mode/sessionState.js`.
- `src/tools/ListWorkersTool/ListWorkersTool.test.ts`: add `recordWorkerSessionStopping` to the existing import from `../../agent-mode/sessionState.js`.
- `src/tasks/LocalAgentTask/LocalAgentTask.test.ts`: add `createTaskStateBase` from `../../Task.js`, and add `LocalAgentTask` to the existing import from `./LocalAgentTask.js`.
- `src/tools/SendMessageTool/SendMessageTool.test.ts`: add `getPrompt` from `./prompt.js` for prompt assertions.

## File Structure

- Modify `src/tools/CancelWorkerTool/CancelWorkerTool.ts`: make cancellation available outside Agent Mode, resolve normal subagent names via `resolveAgentTarget()`, and record durable stopping state when applicable.
- Modify `src/tools/CancelWorkerTool/CancelWorkerTool.test.ts`: cover normal-mode cancellation by `@name`, Agent Mode durable `stopping`, and terminal worker failure behavior.
- Modify `src/agent-mode/sessionState.ts`: add `stopping`, add `recordWorkerSessionStopping()`, and make derived phase/next action non-completable while stopping.
- Modify `src/agent-mode/sessionState.test.ts`: cover stopping derivation, spawn/terminal races, and final terminal override.
- Modify `src/agent-mode/workerUxSummary.ts`: make stopping visible and active in Agent Mode worker roster summaries.
- Modify `src/agent-mode/workerUxSummary.test.ts`: cover stopping label and counts.
- Modify `src/tools/WaitWorkersTool/WaitWorkersTool.ts`: treat `stopping` as non-terminal and include it in wait status output.
- Modify `src/tools/ListWorkersTool/ListWorkersTool.ts`: include stopping workers when `activeOnly` is true.
- Modify `src/constants/prompts.ts`: teach normal and Agent Mode sessions that `SendMessage` does not cancel and final completion must wait for active/stopping subagents.
- Modify `src/constants/prompts.test.ts`: lock prompt guidance.
- Modify `src/agent-mode/orchestratorPrompt.ts`: reinforce scope-contraction and completion-gate behavior.
- Modify `src/agent-mode/orchestratorPrompt.test.ts`: lock orchestrator doctrine.
- Modify `src/tools/SendMessageTool/prompt.ts`: explicitly forbid using `SendMessage` as a stop/cancel mechanism.
- Modify `src/tools/SendMessageTool/SendMessageTool.test.ts`: add prompt assertions for both SendMessage prompt branches.
- Modify `docs/maps/agent-mode.md`: document `stopping` and the cancellation boundary.

## Design Decisions

- `stopping` is distinct from `killed`. `stopping` means the parent dispatched cancellation and local state should stop rendering the worker as simply running; `killed` remains the terminal lifecycle status emitted after the subagent unwinds.
- `CancelWorker` stays disallowed inside subagents through `ALL_AGENT_DISALLOWED_TOOLS`; it becomes available to the main agent in normal mode.
- Normal-mode subagents do not use Agent Mode durable state unless already tracked. `CancelWorker` can still resolve them through `agentNameRegistry`, metadata, or raw agent ID using `resolveAgentTarget()`.
- Agent Mode `deriveCurrentPhase()` returns `executing` while any worker is `running` or `stopping`; final completion is not reachable from state derivation during teardown.
- `WaitWorkers` does not treat `stopping` as terminal. It returns complete only for `completed`, `failed`, or `killed`.

---

### Task 1: Make `CancelWorker` Stop Normal-Mode Subagents

**Files:**
- Modify: `src/tools/CancelWorkerTool/CancelWorkerTool.ts`
- Modify: `src/tools/CancelWorkerTool/CancelWorkerTool.test.ts`

- [ ] **Step 1: Write the failing normal-mode cancellation test**

Add this test to `src/tools/CancelWorkerTool/CancelWorkerTool.test.ts`:

```ts
test('stops a running normal-mode subagent by friendly name', async () => {
  delete process.env.CLAUDE_CODE_AGENT_MODE

  const workerAgentId = randomUUID().slice(0, 8)
  let appState = {
    agentNameRegistry: new Map([['Ritchie', workerAgentId]]),
    tasks: {
      [workerAgentId]: {
        ...createTaskStateBase(workerAgentId, 'local_agent', 'verify task'),
        status: 'running',
      },
    },
  }

  const context = {
    getAppState: () => appState,
    setAppState: (update: (next: unknown) => unknown) => {
      appState = update(appState) as typeof appState
    },
  }

  const result = await CancelWorkerTool.call(
    { worker: '@Ritchie', reason: 'user narrowed scope' },
    context as never,
  )

  expect(result.data.agentId).toBe(workerAgentId)
  expect(result.data.stopped.taskId).toBe(workerAgentId)
  expect(result.data.stopped.taskType).toBe('local_agent')
  expect(appState.tasks[workerAgentId]?.status).toBe('killed')
})
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
bun test src/tools/CancelWorkerTool/CancelWorkerTool.test.ts
```

Expected before implementation: the new test fails because `CancelWorkerTool.call()` only resolves Agent Mode durable workers through `resolveWorkerAgentId()`.

- [ ] **Step 3: Implement normal-mode target resolution**

In `src/tools/CancelWorkerTool/CancelWorkerTool.ts`, import `resolveAgentTarget()`:

```ts
import type { AppState } from '../../state/AppStateStore.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { resolveAgentTarget } from '../AgentTool/resolveAgentTarget.js'
```

Add a helper above `CancelWorkerTool`:

```ts
async function resolveCancelableAgentId({
  worker,
  sessionId,
  context,
}: {
  worker: string
  sessionId: string
  context: {
    getAppState: () => AppState
  }
}): Promise<string | null> {
  const durableAgentId = await resolveWorkerAgentId(sessionId, worker)
  if (durableAgentId) return durableAgentId

  const appState = context.getAppState()
  const resolved = await resolveAgentTarget({
    input: worker,
    appState,
    sessionId,
  })
  if (resolved && isLocalAgentTask(appState.tasks?.[resolved.agentId])) {
    return resolved.agentId
  }

  const directTask = appState.tasks?.[worker]
  if (isLocalAgentTask(directTask)) return worker

  return null
}
```

Replace the direct `resolveWorkerAgentId()` call with:

```ts
const agentId = await resolveCancelableAgentId({
  worker: input.worker,
  sessionId,
  context,
})
if (!agentId) {
  throw new Error(`No running subagent or Agent Mode worker found for: ${input.worker}`)
}
```

- [ ] **Step 4: Enable the tool in normal mode**

Change `isEnabled()` in `CancelWorkerTool.ts` from:

```ts
isEnabled() {
  return isAgentMode()
}
```

to:

```ts
isEnabled() {
  return true
}
```

Remove the unused `isAgentMode` import after this change.

- [ ] **Step 5: Update user-facing tool wording**

Change `searchHint`, `description()`, and `prompt()` to make the boundary explicit:

```ts
searchHint: 'cancel a running background subagent or Agent Mode worker',
```

```ts
async description() {
  return 'Stop a running background subagent or Agent Mode worker by handle, name, or ID'
}
```

```ts
async prompt() {
  return 'Stop a running background subagent or Agent Mode worker before it continues consuming resources. Use this for cancellation; SendMessage only queues a cooperative message and does not abort work.'
}
```

- [ ] **Step 6: Run the focused tests**

Run:

```bash
bun test src/tools/CancelWorkerTool/CancelWorkerTool.test.ts
```

Expected: all `CancelWorkerTool` tests pass.

---

### Task 2: Add Durable `stopping` State

**Files:**
- Modify: `src/agent-mode/sessionState.ts`
- Modify: `src/agent-mode/sessionState.test.ts`
- Modify: `src/tools/CancelWorkerTool/CancelWorkerTool.ts`
- Modify: `src/tools/CancelWorkerTool/CancelWorkerTool.test.ts`

- [ ] **Step 1: Write the failing stopping-state derivation test**

Add this test to `src/agent-mode/sessionState.test.ts`:

```ts
test('records stopping workers as non-completable while cancellation cleanup is pending', async () => {
  const mode = 'agent'
  const objective = 'Cancel stale verification'
  const workerAgentId = randomUUID().slice(0, 8)

  await updateSessionState(
    sessionId,
    () => createSessionState({ sessionId, mode, objective }),
    () => {},
  )
  await recordWorkerSessionSpawn({
    sessionId,
    mode,
    objective,
    handle: 'Ritchie',
    agentId: workerAgentId,
    role: 'verification',
    description: 'Verify the patch',
    worktreePath: null,
    spawnedAt: '2026-06-02T15:11:00.000Z',
  })

  await recordWorkerSessionStopping({
    sessionId,
    agentId: workerAgentId,
    reason: 'user narrowed scope',
  })

  const state = await readSessionState(sessionId)
  const worker = state?.knownWorkers.find(item => item.agentId === workerAgentId)

  expect(worker?.status).toBe('stopping')
  expect(worker?.stopReason).toBe('user narrowed scope')
  expect(state?.currentPhase).toBe('executing')
  expect(state?.activeWorker?.agentId).toBe(workerAgentId)
  expect(state?.nextAction).toBe('Wait for @Ritchie to stop before concluding the objective.')
})
```

- [ ] **Step 2: Run the failing session-state test**

Run:

```bash
bun test src/agent-mode/sessionState.test.ts --grep stopping
```

Expected before implementation: TypeScript/test failure because `recordWorkerSessionStopping` and status `stopping` do not exist.

- [ ] **Step 3: Add the `stopping` type and field**

In `src/agent-mode/sessionState.ts`, change:

```ts
export type AgentModeWorkerSessionStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed'
```

to:

```ts
export type AgentModeWorkerSessionStatus =
  | 'running'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'killed'

export type AgentModeWorkerTerminalStatus = Exclude<
  AgentModeWorkerSessionStatus,
  'running' | 'stopping'
>
```

Add `stopReason?: string` to `AgentModeWorkerSession`.

- [ ] **Step 4: Add `recordWorkerSessionStopping()`**

Add this function before `recordWorkerSessionTerminal()`:

```ts
export async function recordWorkerSessionStopping({
  sessionId,
  agentId,
  reason,
}: {
  sessionId: string
  agentId: string
  reason?: string
}): Promise<void> {
  await mutatePersistedSessionState(sessionId, null, state => {
    const existing = state.knownWorkers[agentId]
    if (!existing) return

    for (const [handle, worker] of Object.entries(state.activeWorkers)) {
      if (worker.agentId === agentId) {
        delete state.activeWorkers[handle]
      }
    }

    state.knownWorkers[agentId] = {
      ...existing,
      status: 'stopping',
      resumable: false,
      ...(reason ? { stopReason: reason } : {}),
    }
  })
}
```

- [ ] **Step 5: Keep terminal recording terminal-only**

Change the `status` parameter type in `recordWorkerSessionTerminal()` from:

```ts
status: Exclude<AgentModeWorkerSessionStatus, 'running'>
```

to:

```ts
status: AgentModeWorkerTerminalStatus
```

- [ ] **Step 6: Call stopping recording from `CancelWorker`**

In `CancelWorkerTool.ts`, import:

```ts
import { recordWorkerSessionStopping } from '../../agent-mode/sessionState.js'
```

After `stopTask()` succeeds and before returning success data, add:

```ts
await recordWorkerSessionStopping({
  sessionId,
  agentId,
  reason: input.reason,
})
```

Do not call `recordWorkerSessionStopping()` for `not_running` or `not_found`; those remain error states.

- [ ] **Step 7: Add a CancelWorker durable-state test**

Append to `CancelWorkerTool.test.ts`:

```ts
test('records Agent Mode worker as stopping immediately after successful cancel', async () => {
  const workerAgentId = randomUUID().slice(0, 8)
  const handle = 'Ritchie'
  const objective = 'Cancel stale verifier'

  await updateSessionState(
    sessionId,
    () => createSessionState({ sessionId, mode: 'agent', objective }),
    () => {},
  )
  await recordWorkerSessionSpawn({
    sessionId,
    mode: 'agent',
    objective,
    handle,
    agentId: workerAgentId,
    role: 'verification',
    description: 'Long-running verifier',
    worktreePath: null,
  })

  let appState = {
    agentNameRegistry: new Map(),
    tasks: {
      [workerAgentId]: {
        ...createTaskStateBase(workerAgentId, 'local_agent', 'worker task'),
        status: 'running',
      },
    },
  }
  const context = {
    getAppState: () => appState,
    setAppState: (update: (next: unknown) => unknown) => {
      appState = update(appState) as typeof appState
    },
  }

  await CancelWorkerTool.call(
    { worker: handle, reason: 'scope contraction' },
    context as never,
  )

  const state = await readSessionState(sessionId)
  const worker = state?.knownWorkers.find(item => item.agentId === workerAgentId)

  expect(appState.tasks[workerAgentId]?.status).toBe('killed')
  expect(worker?.status).toBe('stopping')
  expect(worker?.stopReason).toBe('scope contraction')
  expect(state?.currentPhase).toBe('executing')
})
```

- [ ] **Step 8: Run focused tests**

Run:

```bash
bun test src/agent-mode/sessionState.test.ts src/tools/CancelWorkerTool/CancelWorkerTool.test.ts
```

Expected: all tests pass.

---

### Task 3: Make Derived State Treat `stopping` as Non-Completable

**Files:**
- Modify: `src/agent-mode/sessionState.ts`
- Modify: `src/agent-mode/sessionState.test.ts`
- Modify: `src/agent-mode/workerUxSummary.ts`
- Modify: `src/agent-mode/workerUxSummary.test.ts`
- Modify: `src/tools/WaitWorkersTool/WaitWorkersTool.ts`
- Modify: `src/tools/ListWorkersTool/ListWorkersTool.ts`

- [ ] **Step 1: Update active-worker selection**

In `getActiveWorker()`, treat `stopping` like `running` for active selection:

```ts
const isActiveStatus = (worker: AgentModeWorkerSession): boolean =>
  worker.status === 'running' || worker.status === 'stopping'

return (
  knownWorkers.findLast(
    worker => isActiveStatus(worker) && activeAgentIds.has(worker.agentId),
  ) ??
  knownWorkers.findLast(isActiveStatus) ??
  knownWorkers.findLast(worker => worker.synthesisStatus === 'pending') ??
  knownWorkers.findLast(
    worker => worker.status === 'failed' || worker.status === 'killed',
  ) ??
  knownWorkers.at(-1) ??
  null
)
```

- [ ] **Step 2: Update phase derivation**

Change `deriveCurrentPhase()` so teardown remains non-completable:

```ts
if (
  knownWorkers.some(
    worker => worker.status === 'running' || worker.status === 'stopping',
  )
) {
  return 'executing'
}
```

- [ ] **Step 3: Update next action**

Add this branch before pending synthesis:

```ts
if (activeWorker?.status === 'stopping') {
  return `Wait for ${activeWorker.handle ? `@${activeWorker.handle}` : activeWorker.agentId} to stop before concluding the objective.`
}
```

- [ ] **Step 4: Ensure terminal update overrides stopping**

Add this test to `sessionState.test.ts`:

```ts
test('terminal killed update replaces stopping state after cleanup finishes', async () => {
  const mode = 'agent'
  const objective = 'Replace stopping with killed'
  const workerAgentId = randomUUID().slice(0, 8)

  await updateSessionState(
    sessionId,
    () => createSessionState({ sessionId, mode, objective }),
    () => {},
  )
  await recordWorkerSessionSpawn({
    sessionId,
    mode,
    objective,
    handle: 'Ritchie',
    agentId: workerAgentId,
    role: 'verification',
    description: 'Verify patch',
    worktreePath: null,
  })
  await recordWorkerSessionStopping({
    sessionId,
    agentId: workerAgentId,
    reason: 'obsolete',
  })
  await recordWorkerSessionTerminal({
    sessionId,
    agentId: workerAgentId,
    status: 'killed',
    outputSummary: 'Stopped after cancellation',
  })

  const state = await readSessionState(sessionId)
  const worker = state?.knownWorkers.find(item => item.agentId === workerAgentId)

  expect(worker?.status).toBe('killed')
  expect(worker?.outputSummary).toBe('Stopped after cancellation')
  expect(state?.currentPhase).toBe('blocked')
  expect(state?.nextAction).toBe('Inspect @Ritchie and recover or report the blocker.')
})
```

- [ ] **Step 5: Update worker UX summary**

In `workerUxSummary.ts`, add:

```ts
function isActive(worker: AgentModeWorkerSession): boolean {
  return worker.status === 'running' || worker.status === 'stopping'
}
```

Use `isActive(worker)` for `active` and `isVisibleWorker()`.

Update `getWorkerStatusLabel()`:

```ts
if (worker.status === 'stopping') {
  return 'stopping'
}
```

- [ ] **Step 6: Add worker UX summary assertions**

In `workerUxSummary.test.ts`, add:

```ts
test('counts stopping workers as active and visible', () => {
  const stoppingWorker = worker({
    agentId: 'worker-stopping',
    handle: 'Ritchie',
    role: 'verification',
    description: 'Stopping verifier',
    status: 'stopping',
    spawnedAt: '2026-06-02T15:12:00.000Z',
  })

  const state: AgentModeSessionState = {
    objective: 'Cancel verifier',
    currentPhase: 'executing',
    activeWorker: stoppingWorker,
    knownWorkers: [stoppingWorker],
    nextAction: 'Wait for @Ritchie to stop before concluding the objective.',
  }

  expect(getWorkerStatusLabel(stoppingWorker)).toBe('stopping')
  expect(summarizeAgentModeWorkers(state)).toMatchObject({
    active: 1,
    visibleWorkers: [stoppingWorker],
  })
})
```

- [ ] **Step 7: Update and test `WaitWorkers` terminal logic**

In `WaitWorkersTool.ts`, keep `stopping` non-terminal:

```ts
const isTerminal = (status: string): boolean => {
  return status === 'completed' || status === 'failed' || status === 'killed'
}
```

Add this test to `src/tools/WaitWorkersTool/WaitWorkersTool.test.ts`:

```ts
test('treats stopping durable workers as non-terminal', async () => {
  const workerAgentId = randomUUID().slice(0, 8)

  await updateSessionState(
    sessionId,
    () =>
      createSessionState({
        sessionId,
        mode: 'agent',
        objective: 'Wait for stopping worker',
      }),
    () => {},
  )
  await recordWorkerSessionSpawn({
    sessionId,
    mode: 'agent',
    objective: 'Wait for stopping worker',
    handle: 'Ritchie',
    agentId: workerAgentId,
    role: 'verification',
    description: 'Stopping worker',
    worktreePath: null,
  })
  await recordWorkerSessionStopping({
    sessionId,
    agentId: workerAgentId,
    reason: 'scope contraction',
  })

  const context = {
    getAppState: () => ({ tasks: {} }),
    setAppState: () => {},
  }

  const result = await WaitWorkersTool.call(
    {
      workers: ['Ritchie'],
      timeout: 10,
    },
    context as never,
  )

  expect(result.data.status).toBe('timeout')
  expect(result.data.workers[0]?.status).toBe('stopping')
})
```

- [ ] **Step 8: Update `ListWorkers` active filtering**

Change active-only filtering from:

```ts
if (input.activeOnly && worker.status !== 'running') return false
```

to:

```ts
if (
  input.activeOnly &&
  worker.status !== 'running' &&
  worker.status !== 'stopping'
) {
  return false
}
```

Add this test to `src/tools/ListWorkersTool/ListWorkersTool.test.ts`:

```ts
test('includes stopping workers in activeOnly roster', async () => {
  const mode = 'agent'
  const objective = 'List active stopping worker'
  const stoppingWorker = randomUUID().slice(0, 8)
  const completedWorker = randomUUID().slice(0, 8)

  await updateSessionState(
    sessionId,
    () => createSessionState({ sessionId, mode, objective }),
    () => {},
  )
  await recordWorkerSessionSpawn({
    sessionId,
    mode,
    objective,
    handle: 'Ritchie',
    agentId: stoppingWorker,
    role: 'verification',
    description: 'Stopping verifier',
    worktreePath: null,
  })
  await recordWorkerSessionStopping({
    sessionId,
    agentId: stoppingWorker,
    reason: 'scope contraction',
  })
  await recordWorkerSessionSpawn({
    sessionId,
    mode,
    objective,
    handle: 'Ada',
    agentId: completedWorker,
    role: 'explorer',
    description: 'Completed explorer',
    worktreePath: null,
  })
  await recordWorkerSessionTerminal({
    sessionId,
    agentId: completedWorker,
    status: 'completed',
    outputSummary: 'Done',
  })

  const result = await ListWorkersTool.call(
    {
      activeOnly: true,
      resumableOnly: false,
    },
    undefined as never,
  )

  expect(result.data.workers).toEqual([
    expect.objectContaining({
      agentId: stoppingWorker,
      handle: 'Ritchie',
      status: 'stopping',
    }),
  ])
})
```

- [ ] **Step 9: Run focused state and worker-control tests**

Run:

```bash
bun test src/agent-mode/sessionState.test.ts src/agent-mode/workerUxSummary.test.ts src/tools/ListWorkersTool/ListWorkersTool.test.ts src/tools/WaitWorkersTool/WaitWorkersTool.test.ts
```

Expected: all tests pass.

---

### Task 4: Prompt the Model to Cancel, Wait, or Read Results Instead of Inferring Completion

**Files:**
- Modify: `src/constants/prompts.ts`
- Modify: `src/constants/prompts.test.ts`
- Modify: `src/agent-mode/orchestratorPrompt.ts`
- Modify: `src/agent-mode/orchestratorPrompt.test.ts`
- Modify: `src/tools/SendMessageTool/prompt.ts`
- Modify: `src/tools/SendMessageTool/SendMessageTool.test.ts`

- [ ] **Step 1: Strengthen normal-session worker-control guidance**

In `getAgentModeWorkerControlGuidance()` in `src/constants/prompts.ts`, change the `CancelWorker` bullet from:

```ts
enabledTools.has('CancelWorker')
  ? 'Use CancelWorker for stale, wrong, conflicting, unsafe, or no-longer-needed workers.'
  : null,
```

to:

```ts
enabledTools.has('CancelWorker')
  ? 'Use CancelWorker for stale, wrong, conflicting, unsafe, or no-longer-needed workers. SendMessage is not cancellation; it only queues a message for the next worker tool round.'
  : null,
```

Append this sentence to the returned `Worker control:` paragraph:

```ts
Before reporting final completion, account for every background subagent you spawned: wait for it, read its result, cancel it because it is obsolete, or explicitly state why its result is not part of the outcome.
```

- [ ] **Step 2: Lock the prompt guidance test**

In `src/constants/prompts.test.ts`, update the worker-control test to assert:

```ts
expect(prompt).toContain('SendMessage is not cancellation')
expect(prompt).toContain('Before reporting final completion, account for every background subagent you spawned')
```

- [ ] **Step 3: Strengthen Agent Mode orchestrator scope-contraction wording**

In `src/agent-mode/orchestratorPrompt.ts`, add these bullets under `## Worker control tools`:

```md
- If the user contracts scope or questions why a worker is still running, first decide whether that worker is now obsolete. If it is obsolete, call CancelWorker; do not rely on SendMessage as a stop request.
- Do not tell the user a worker was stopped unless CancelWorker returned success or durable state shows it is no longer running/stopping.
- Before reporting final completion, no worker may remain running, stopping, or completed_pending_synthesis unless you explicitly report that unresolved worker state as the blocker.
```

- [ ] **Step 4: Lock the orchestrator prompt test**

In `orchestratorPrompt.test.ts`, add:

```ts
expect(prompt).toContain('do not rely on SendMessage as a stop request')
expect(prompt).toContain('no worker may remain running, stopping, or completed_pending_synthesis')
expect(prompt).toContain('unless you explicitly report that unresolved worker state as the blocker')
```

- [ ] **Step 5: Strengthen `SendMessage` prompt text**

In both branches of `src/tools/SendMessageTool/prompt.ts`, add:

```md
Never use SendMessage to stop, cancel, or interrupt a running worker. Use CancelWorker for cancellation. SendMessage only queues content for the recipient's next tool round.
```

- [ ] **Step 6: Add SendMessage prompt assertions**

Add this describe block to `src/tools/SendMessageTool/SendMessageTool.test.ts`:

```ts
describe('SendMessage prompt cancellation boundary', () => {
  const originalUserType = process.env.USER_TYPE
  const originalAgentTeams = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS

  afterEach(() => {
    if (originalUserType === undefined) {
      delete process.env.USER_TYPE
    } else {
      process.env.USER_TYPE = originalUserType
    }
    if (originalAgentTeams === undefined) {
      delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
    } else {
      process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = originalAgentTeams
    }
  })

  test('non-team prompt says SendMessage is not cancellation', () => {
    process.env.USER_TYPE = 'external'
    delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS

    const prompt = getPrompt()

    expect(prompt).toContain('Never use SendMessage to stop, cancel, or interrupt')
    expect(prompt).toContain('Use CancelWorker for cancellation')
  })

  test('agent-teams prompt says SendMessage is not cancellation', () => {
    process.env.USER_TYPE = 'ant'

    const prompt = getPrompt()

    expect(prompt).toContain('Never use SendMessage to stop, cancel, or interrupt')
    expect(prompt).toContain('Use CancelWorker for cancellation')
  })
})
```

- [ ] **Step 7: Run focused prompt tests**

Run:

```bash
bun test src/constants/prompts.test.ts src/agent-mode/orchestratorPrompt.test.ts src/tools/SendMessageTool/SendMessageTool.test.ts
```

Expected: prompt tests pass and fail if future edits reintroduce SendMessage-as-cancel guidance.

---

### Task 5: Add Immediate-Kill Regression Coverage

**Files:**
- Modify: `src/tasks/LocalAgentTask/LocalAgentTask.test.ts`

- [ ] **Step 1: Add local AppState immediate-kill regression test**

In `LocalAgentTask.test.ts`, import `LocalAgentTask` from `./LocalAgentTask.js` and add a test around the public `LocalAgentTask.kill()` path that asserts local task state flips to `killed` before lifecycle notification exists:

```ts
test('kill updates local agent AppState before async lifecycle notification', async () => {
  const taskId = 'agent-kill-immediate'
  let appState = {
    tasks: {
      [taskId]: {
        ...createTaskStateBase(taskId, 'local_agent', 'slow cleanup agent'),
        status: 'running',
        abortController: new AbortController(),
      },
    },
  }

  await LocalAgentTask.kill(taskId, update => {
    appState = update(appState) as typeof appState
  })

  expect(appState.tasks[taskId]?.status).toBe('killed')
  expect(appState.tasks[taskId]?.abortController).toBeUndefined()
})
```

Keep the assertion order unchanged: status must be `killed` and `abortController` must be cleared in local state before any notification assertion.

- [ ] **Step 2: Run local task tests**

Run:

```bash
bun test src/tasks/LocalAgentTask/LocalAgentTask.test.ts
```

Expected: tests prove local killed state is observable before final task-notification delivery.

---

### Task 6: Update Documentation Maps

**Files:**
- Modify: `docs/maps/agent-mode.md`

- [ ] **Step 1: Document the worker status set**

In the worker lifecycle row, add:

```md
Cancellation is two-stage: `CancelWorker` records durable `stopping` immediately after dispatching abort, then the async agent lifecycle records terminal `killed` after cleanup and partial-result extraction.
```

- [ ] **Step 2: Document the tool boundary**

In the worker spawn/resume/steering row, add:

```md
`SendMessage` is cooperative queueing only. It must not be used as cancellation; `CancelWorker` is the aborting stop primitive for stale, wrong, conflicting, unsafe, or no-longer-needed workers.
```

- [ ] **Step 3: Run docs lint-free check**

Run:

```bash
git diff -- docs/maps/agent-mode.md
```

Expected: docs describe the new two-stage cancellation behavior and do not imply `SendMessage` can stop work.

---

### Task 7: Full Verification

**Files:** no additional edits.

- [ ] **Step 1: Run the focused suite**

Run:

```bash
bun test src/tools/CancelWorkerTool/CancelWorkerTool.test.ts src/agent-mode/sessionState.test.ts src/agent-mode/workerUxSummary.test.ts src/tools/ListWorkersTool/ListWorkersTool.test.ts src/tools/WaitWorkersTool/WaitWorkersTool.test.ts src/constants/prompts.test.ts src/agent-mode/orchestratorPrompt.test.ts src/tools/SendMessageTool/SendMessageTool.test.ts src/tasks/LocalAgentTask/LocalAgentTask.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 2: Run the repo-required build**

Run:

```bash
bun run build:dev:full
```

Expected: build succeeds with no TypeScript errors.

- [ ] **Step 3: Manual incident replay check**

Start a normal-mode background verification subagent, then ask a scope-contraction message equivalent to:

```text
I haven't asked you to edit. The task is just to research, isn't it?
```

Expected behavior:

- The main agent uses `CancelWorker` if the verifier is obsolete.
- The footer or worker state stops presenting the worker as normally active after cancellation dispatch.
- The main agent does not claim "finished" while the worker is running, stopping, or has an unread result.
- If the worker already completed, the main agent reads the result before reporting final completion.

- [ ] **Step 4: Inspect final diff**

Run:

```bash
git diff -- src/tools/CancelWorkerTool src/agent-mode src/tools/WaitWorkersTool src/tools/ListWorkersTool src/constants/prompts.ts src/tools/SendMessageTool docs/maps/agent-mode.md
```

Expected: diff is limited to cancellation routing, stopping state, prompt guidance, tests, and docs. It does not modify unrelated normal-subagent UI work.

---

## Acceptance Criteria

- User scope contraction can trigger real cancellation in normal mode and Agent Mode through `CancelWorker`.
- `SendMessage` prompt text clearly says it is not cancellation.
- `CancelWorker` immediately updates local task state to `killed`.
- Agent Mode durable state records `stopping` immediately after successful cancellation dispatch.
- `deriveCurrentPhase()` cannot fall back to a completable/planning path while a worker is `running` or `stopping`.
- `WaitWorkers` treats `stopping` as non-terminal.
- Prompt tests enforce that final completion requires active/stopping/pending worker state to be resolved or reported as a blocker.
- `bun run build:dev:full` passes.
