# Agent Mode Live Worker State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make normal Agent Mode turns see and address durable worker session state, so resumable workers are visible outside compaction and `SendMessage` can target persisted worker handles.

**Architecture:** The runtime already persists Agent Mode worker sessions in `src/agent-mode/sessionState.ts` and can resume subagent transcripts through `src/tools/AgentTool/resumeAgent.ts`. This plan wires that state into live prompt context and `SendMessage` routing, then fixes terminal-state semantics so failed/killed workers are not advertised as clean resumable workers.

**Tech Stack:** TypeScript, Bun test runner, existing Cat Code Agent Mode runtime.

---

## Files

- Modify: `src/agent-mode/sessionState.ts`
- Modify: `src/agent-mode/agentMode.ts`
- Modify: `src/QueryEngine.ts`
- Modify: `src/utils/queryContext.ts`
- Modify: `src/screens/REPL.tsx`
- Modify: `src/tools/SendMessageTool/SendMessageTool.ts`
- Test: `src/agent-mode/sessionState.test.ts`
- Test: `src/agent-mode/agentMode.test.ts`
- Test: `src/tools/SendMessageTool/SendMessageTool.test.ts`

## Current Code Facts

- `src/agent-mode/sessionState.ts` stores `knownWorkers` keyed by `agentId`, with optional friendly `handle`.
- `src/tools/AgentTool/runAgent.ts` records worker spawns through `recordWorkerSessionSpawn(...)`.
- `src/tools/AgentTool/resumeAgent.ts` can resume an existing subagent transcript by `agentId`.
- `src/tools/SendMessageTool/SendMessageTool.ts` routes to a subagent only when `input.to` resolves via `appState.agentNameRegistry` or raw `agentId`.
- `src/agent-mode/agentMode.ts` currently injects only worker tool capability context into live turns.
- `src/services/compact/prompt.ts` already includes formatted Agent Mode session state after compaction.

## Task 1: Make Durable Worker Lookup Explicit

**Files:**
- Modify: `src/agent-mode/sessionState.ts`
- Test: `src/agent-mode/sessionState.test.ts`

- [ ] **Step 1: Export a handle resolver**

Add an exported async function to `src/agent-mode/sessionState.ts`:

```ts
export async function resolveWorkerAgentId(
  sessionId: string,
  target: string,
): Promise<string | null> {
  const state = await readPersistedSessionState(sessionId)
  if (!state) return null

  if (state.knownWorkers[target]) {
    return target
  }

  const byHandle = Object.values(state.knownWorkers).find(
    worker => worker.handle === target,
  )
  return byHandle?.agentId ?? null
}
```

- [ ] **Step 2: Fix terminal resumability semantics**

In `recordWorkerSessionTerminal(...)`, replace:

```ts
resumable: true,
```

with:

```ts
resumable: status === 'completed',
```

This keeps completed workers resumable and stops advertising failed/killed workers as clean continuation targets.

- [ ] **Step 3: Add tests for resolver and resumability**

Create `src/agent-mode/sessionState.test.ts` with tests that use a temporary fake session id and mock or isolate the transcript path if existing test helpers are available. If no helper exists, keep the tests focused on exported pure formatting where possible and add a small filesystem-backed integration test using Bun temp directories only after checking existing patterns.

Required assertions:

```ts
expect(await resolveWorkerAgentId(sessionId, 'explore-1')).toBe(agentId)
expect(await resolveWorkerAgentId(sessionId, agentId)).toBe(agentId)
expect(completedWorker.resumable).toBe(true)
expect(failedWorker.resumable).toBe(false)
expect(killedWorker.resumable).toBe(false)
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
bun test src/agent-mode/sessionState.test.ts
```

Expected: all new tests pass.

## Task 2: Inject Live Agent Mode Session State

**Files:**
- Modify: `src/agent-mode/agentMode.ts`
- Modify: `src/QueryEngine.ts`
- Modify: `src/utils/queryContext.ts`
- Modify: `src/screens/REPL.tsx`
- Test: `src/agent-mode/agentMode.test.ts`

- [ ] **Step 1: Make `getAgentModeUserContext` async**

Change the signature in `src/agent-mode/agentMode.ts` from:

```ts
export function getAgentModeUserContext(
  mcpClients: ReadonlyArray<{ name: string }>,
  scratchpadDir?: string,
): { [k: string]: string }
```

to:

```ts
export async function getAgentModeUserContext(
  mcpClients: ReadonlyArray<{ name: string }>,
  scratchpadDir?: string,
  sessionId?: string,
): Promise<{ [k: string]: string }>
```

- [ ] **Step 2: Add live session-state context**

Import these in `src/agent-mode/agentMode.ts`:

```ts
import { getSessionId } from '../bootstrap/state.js'
import {
  formatAgentModeSessionState,
  readSessionState,
} from './sessionState.js'
```

At the end of `getAgentModeUserContext(...)`, before returning, add:

```ts
const effectiveSessionId = sessionId ?? getSessionId()
const sessionState = await readSessionState(effectiveSessionId)

return {
  workerToolsContext: content,
  ...(sessionState
    ? {
        agentModeSessionState:
          `${formatAgentModeSessionState(sessionState)}\n\n` +
          'Use this state to choose whether to resume an existing worker or spawn a fresh worker. Prefer SendMessage to a resumable worker handle when the follow-up strongly overlaps that worker.',
      }
    : {}),
}
```

Keep the existing early return for non-Agent Mode:

```ts
if (!isAgentMode()) {
  return {}
}
```

- [ ] **Step 3: Await all call sites**

Update all call sites to `await getAgentModeUserContext(...)`.

Known call sites:

- `src/QueryEngine.ts`
- `src/utils/queryContext.ts`
- `src/screens/REPL.tsx`

Example shape:

```ts
const agentModeUserContext = await getAgentModeUserContext(
  mcpClients,
  isScratchpadEnabled() ? getScratchpadDir() : undefined,
)

const userContext = {
  ...baseUserContext,
  ...coordinatorUserContext,
  ...agentModeUserContext,
}
```

Do not call an async function inside an object literal without awaiting it first.

- [ ] **Step 4: Add tests for live context**

Create `src/agent-mode/agentMode.test.ts`.

Required assertions:

```ts
process.env.CLAUDE_CODE_AGENT_MODE = '1'
const context = await getAgentModeUserContext([], undefined, sessionId)
expect(context.workerToolsContext).toContain('Delegated workers')
expect(context.agentModeSessionState).toContain('Agent Mode session state:')
expect(context.agentModeSessionState).toContain('Known workers:')
```

Also test non-Agent Mode:

```ts
delete process.env.CLAUDE_CODE_AGENT_MODE
await expect(getAgentModeUserContext([], undefined, sessionId)).resolves.toEqual({})
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
bun test src/agent-mode/agentMode.test.ts
```

Expected: all tests pass.

## Task 3: Resolve Durable Handles in SendMessage

**Files:**
- Modify: `src/tools/SendMessageTool/SendMessageTool.ts`
- Test: `src/tools/SendMessageTool/SendMessageTool.test.ts`

- [ ] **Step 1: Import session lookup**

Add imports:

```ts
import { getSessionId } from '../../bootstrap/state.js'
import { resolveWorkerAgentId } from '../../agent-mode/sessionState.js'
```

- [ ] **Step 2: Add durable fallback resolution**

In `SendMessageTool.call(...)`, replace:

```ts
const registered = appState.agentNameRegistry.get(input.to)
const agentId = registered ?? toAgentId(input.to)
```

with:

```ts
const registered = appState.agentNameRegistry.get(input.to)
const rawAgentId = toAgentId(input.to)
const durableAgentId =
  registered || rawAgentId
    ? null
    : await resolveWorkerAgentId(getSessionId(), input.to)
const agentId = registered ?? rawAgentId ?? durableAgentId
```

This keeps current behavior first, then resolves persisted worker handles.

- [ ] **Step 3: Keep teammate fallback behavior intact**

Do not change the later block:

```ts
return handleMessage(input.to, teammateMessage, context)
```

If no local worker resolves, normal teammate/mailbox routing must still work.

- [ ] **Step 4: Add tests for handle fallback**

Create or extend `src/tools/SendMessageTool/SendMessageTool.test.ts`.

Required behavior:

```ts
// Given durable state has handle "explore-1" -> agentId "agent-..."
// and appState.agentNameRegistry is empty:
await SendMessageTool.call(
  { to: 'explore-1', summary: 'follow up', message: 'go deeper' },
  context,
  canUseTool,
)

// Expect resumeAgentBackground path, not teammate mailbox path.
```

Mock `resumeAgentBackground` if this repo's Bun test setup supports module mocking. If module mocking is too brittle, test `resolveWorkerAgentId` in Task 1 and manually smoke-test `SendMessage` in a dev session.

- [ ] **Step 5: Run focused tests**

Run:

```bash
bun test src/tools/SendMessageTool/SendMessageTool.test.ts
```

Expected: new tests pass, and no teammate fallback is used when a durable worker handle matches.

## Task 4: Make Agent Mode Explore Continuation Consistent

**Files:**
- Modify: `src/tools/AgentTool/AgentTool.tsx`

- [ ] **Step 1: Import Agent Mode state**

Add:

```ts
import { isAgentMode } from '../../agent-mode/agentMode.js'
```

if not already available in this file.

- [ ] **Step 2: Do not suppress continuation metadata for one-shot built-ins in Agent Mode**

Find the block:

```ts
if (data.status === 'completed' && data.agentType && ONE_SHOT_BUILTIN_AGENT_TYPES.has(data.agentType) && !worktreeInfoText) {
  return {
    tool_use_id: toolUseID,
    type: 'tool_result',
    content: contentOrMarker
  };
}
```

Change it to:

```ts
if (
  !isAgentMode() &&
  data.status === 'completed' &&
  data.agentType &&
  ONE_SHOT_BUILTIN_AGENT_TYPES.has(data.agentType) &&
  !worktreeInfoText
) {
  return {
    tool_use_id: toolUseID,
    type: 'tool_result',
    content: contentOrMarker,
  }
}
```

Then change:

```ts
const continuationText = data.agentType && ONE_SHOT_BUILTIN_AGENT_TYPES.has(data.agentType) ? `agentId: ${data.agentId}` : `agentId: ${data.agentId} (use SendMessage with to: '${data.agentId}' to continue this agent)`;
```

to:

```ts
const continuationText =
  data.agentType &&
  ONE_SHOT_BUILTIN_AGENT_TYPES.has(data.agentType) &&
  !isAgentMode()
    ? `agentId: ${data.agentId}`
    : `agentId: ${data.agentId} (use SendMessage with to: '${data.agentId}' to continue this agent)`
```

- [ ] **Step 3: Run existing AgentTool tests if present**

Find tests:

```bash
rg "ONE_SHOT_BUILTIN_AGENT_TYPES|completed_with_error|AgentTool" src -g "*.test.ts" -g "*.test.tsx"
```

Run the relevant tests. If no test exists, run type/build validation in the final task.

## Task 5: Validation

**Files:**
- No new files unless fixing test failures.

- [ ] **Step 1: Run all focused tests**

Run:

```bash
bun test src/agent-mode/sessionState.test.ts src/agent-mode/agentMode.test.ts src/tools/SendMessageTool/SendMessageTool.test.ts src/services/compact/prompt.test.ts src/commands/agent/agent.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run build**

Run:

```bash
bun run build:dev
```

Expected: build completes successfully.

- [ ] **Step 3: Manual smoke test in Agent Mode**

Run a local dev session:

```bash
CLAUDE_CODE_AGENT_MODE=1 bun run dev
```

In the session:

1. Spawn a named/background Explore or coding worker.
2. Wait for completion.
3. Ask a follow-up that should continue the same worker.
4. Verify the prompt includes `Agent Mode session state`.
5. Verify `SendMessage` can target the durable handle, not just raw agent id.

Expected: the worker is resumed from its transcript and the orchestrator does not spawn a redundant worker for a strongly overlapping follow-up.

## Commit Plan

- Commit 1: `test: cover agent mode worker session state`
- Commit 2: `feat: inject live agent mode worker state`
- Commit 3: `feat: resolve durable worker handles in SendMessage`
- Commit 4: `fix: align agent mode built-in worker continuation`

## Acceptance Criteria

- Normal Agent Mode turns include durable worker session state when it exists.
- `SendMessage` resolves persisted worker handles even when `agentNameRegistry` is empty.
- Completed workers are resumable; failed and killed workers are not advertised as clean resumable workers.
- In Agent Mode, Explore/Plan completion metadata does not hide continuation capability when the worker can be resumed.
- Focused tests and `bun run build:dev` pass.
