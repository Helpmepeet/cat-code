# Agent Mode UX Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Agent Mode visibly controllable: show durable worker state in the REPL, surface pending worker results, provide compact worker roster context, and reframe worktrees as isolated attempts instead of user-managed directories.

**Architecture:** Keep backend worker-control logic separate. This plan consumes durable Agent Mode state from `src/agent-mode/sessionState.ts`, summarizes it in a small pure helper, renders it through a focused Agent Mode roster component, and integrates that component into `src/screens/REPL.tsx`. Worktree UX copy is updated in tool result UI and exit dialog copy without changing worktree runtime behavior.

**Tech Stack:** TypeScript, React/Ink terminal UI, Bun test, existing Agent Mode session state and task runtime.

---

## Prerequisites

- The worker-control tracking plan should be complete or in progress: `docs/superpowers/plans/2026-05-02-agent-mode-worker-control-plane-tracking-plan.md`.
- At minimum, `AgentModeWorkerSession` should expose durable worker fields including `handle`, `role`, `description`, `status`, `resumable`, `worktreePath`, and, once available, `synthesisStatus`.
- Do not change `/agent` fresh-start behavior.

---

## File Structure

- Create `src/agent-mode/workerUxSummary.ts`: pure summary/formatting helper for Agent Mode worker roster.
- Create `src/agent-mode/workerUxSummary.test.ts`: focused tests for counts, visible workers, pending synthesis, labels, and fallback behavior.
- Create `src/agent-mode/AgentModeWorkerRoster.tsx`: small Ink component rendering the Agent Mode banner and compact worker roster.
- Modify `src/screens/REPL.tsx`: read durable Agent Mode state asynchronously and render `AgentModeWorkerRoster` instead of the current aggregate task-count block.
- Create `src/utils/worktreeUxCopy.ts`: pure copy helpers for worktree-as-isolated-attempt UI language.
- Create `src/utils/worktreeUxCopy.test.ts`: tests for task-centric worktree copy.
- Modify `src/tools/EnterWorktreeTool/UI.tsx`: replace worktree-centric visible copy with isolated-attempt copy.
- Modify `src/tools/ExitWorktreeTool/UI.tsx`: replace worktree-centric result copy with isolated-attempt copy.
- Modify `src/components/WorktreeExitDialog.tsx`: replace path/branch-heavy choice labels and subtitles with apply/discard/keep isolated-result framing.

---

### Task 1: Worker UX Summary Helper

**Files:**
- Create: `src/agent-mode/workerUxSummary.ts`
- Create: `src/agent-mode/workerUxSummary.test.ts`

- [ ] **Step 1: Write failing summary tests**

Create `src/agent-mode/workerUxSummary.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import type { AgentModeSessionState } from './sessionState.js'
import {
  getWorkerDisplayHandle,
  summarizeAgentModeWorkers,
} from './workerUxSummary.js'

function state(overrides: Partial<AgentModeSessionState> = {}): AgentModeSessionState {
  return {
    objective: 'Fix login race',
    currentPhase: 'executing',
    activeWorker: null,
    nextAction: 'Wait for verifier',
    knownWorkers: [],
    ...overrides,
  }
}

describe('worker UX summary', () => {
  test('counts durable worker states and pending synthesis', () => {
    const summary = summarizeAgentModeWorkers(
      state({
        knownWorkers: [
          {
            agentId: 'agent-running',
            handle: 'worker-a',
            role: 'agent-mode-coding-worker',
            description: 'patch login flow',
            status: 'running',
            resumable: false,
            worktreePath: null,
            spawnedAt: '2026-05-02T01:00:00.000Z',
          },
          {
            agentId: 'agent-done',
            handle: 'worker-b',
            role: 'agent-mode-coding-worker',
            description: 'write regression test',
            status: 'completed',
            resumable: true,
            worktreePath: null,
            synthesisStatus: 'pending',
            spawnedAt: '2026-05-02T01:01:00.000Z',
          },
          {
            agentId: 'agent-failed',
            handle: 'verifier-a',
            role: 'agent-mode-verifier',
            description: 'verify patch',
            status: 'failed',
            resumable: false,
            worktreePath: null,
            error: 'test command failed',
            spawnedAt: '2026-05-02T01:02:00.000Z',
          },
        ],
      }),
    )

    expect(summary.active).toBe(1)
    expect(summary.done).toBe(1)
    expect(summary.attention).toBe(1)
    expect(summary.pendingSynthesis).toBe(1)
    expect(summary.visibleWorkers.map(worker => worker.handle)).toEqual([
      'worker-a',
      'worker-b',
      'verifier-a',
    ])
  })

  test('falls back to no workers when no durable state exists', () => {
    const summary = summarizeAgentModeWorkers(null)

    expect(summary.hasWorkers).toBe(false)
    expect(summary.active).toBe(0)
    expect(summary.visibleWorkers).toEqual([])
  })

  test('uses handle before raw agent id for display', () => {
    expect(
      getWorkerDisplayHandle({
        agentId: 'agent-raw',
        handle: 'worker-readable',
        role: 'agent-mode-coding-worker',
        description: 'read files',
        status: 'running',
        worktreePath: null,
      }),
    ).toBe('@worker-readable')
  })
})
```

- [ ] **Step 2: Run failing summary tests**

Run:

```bash
bun test src/agent-mode/workerUxSummary.test.ts
```

Expected: fails because `workerUxSummary.ts` does not exist.

- [ ] **Step 3: Implement summary helper**

Create `src/agent-mode/workerUxSummary.ts`:

```ts
import type {
  AgentModeSessionState,
  AgentModeWorkerSession,
} from './sessionState.js'

export type AgentModeWorkerUxSummary = {
  hasWorkers: boolean
  active: number
  done: number
  attention: number
  pendingSynthesis: number
  visibleWorkers: AgentModeWorkerSession[]
}

function isAttentionWorker(worker: AgentModeWorkerSession): boolean {
  return worker.status === 'failed' || worker.status === 'killed'
}

function isVisibleWorker(worker: AgentModeWorkerSession): boolean {
  return (
    worker.status === 'running' ||
    worker.synthesisStatus === 'pending' ||
    isAttentionWorker(worker)
  )
}

function sortBySpawnTime(
  workers: AgentModeWorkerSession[],
): AgentModeWorkerSession[] {
  return [...workers].sort((left, right) => {
    const leftTime = left.spawnedAt ? Date.parse(left.spawnedAt) : 0
    const rightTime = right.spawnedAt ? Date.parse(right.spawnedAt) : 0
    return leftTime - rightTime
  })
}

export function getWorkerDisplayHandle(
  worker: AgentModeWorkerSession,
): string {
  return `@${worker.handle && worker.handle !== worker.agentId ? worker.handle : worker.agentId}`
}

export function getWorkerStatusLabel(worker: AgentModeWorkerSession): string {
  if (worker.synthesisStatus === 'pending') return 'pending review'
  if (worker.synthesisStatus === 'synthesized') return 'synthesized'
  if (worker.status === 'failed' || worker.status === 'killed') return 'attention'
  return worker.status
}

export function summarizeAgentModeWorkers(
  state: AgentModeSessionState | null,
): AgentModeWorkerUxSummary {
  const workers = sortBySpawnTime(state?.knownWorkers ?? [])
  const active = workers.filter(worker => worker.status === 'running').length
  const done = workers.filter(worker => worker.status === 'completed').length
  const attention = workers.filter(isAttentionWorker).length
  const pendingSynthesis = workers.filter(
    worker => worker.synthesisStatus === 'pending',
  ).length
  const visibleWorkers = workers.filter(isVisibleWorker).slice(-4)

  return {
    hasWorkers: workers.length > 0,
    active,
    done,
    attention,
    pendingSynthesis,
    visibleWorkers,
  }
}
```

- [ ] **Step 4: Run summary tests**

Run:

```bash
bun test src/agent-mode/workerUxSummary.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/agent-mode/workerUxSummary.ts src/agent-mode/workerUxSummary.test.ts
git commit -m "feat: summarize agent mode worker ux state"
```

---

### Task 2: Agent Mode Worker Roster Component

**Files:**
- Create: `src/agent-mode/AgentModeWorkerRoster.tsx`
- Modify: `src/screens/REPL.tsx`

- [ ] **Step 1: Create roster component**

Create `src/agent-mode/AgentModeWorkerRoster.tsx`:

```tsx
import * as React from 'react'
import { Box, Text } from '../ink.js'
import type { AgentModeWorkerUxSummary } from './workerUxSummary.js'
import {
  getWorkerDisplayHandle,
  getWorkerStatusLabel,
} from './workerUxSummary.js'

function roleLabel(role: string): string {
  if (role === 'agent-mode-coding-worker') return 'worker'
  if (role === 'agent-mode-verifier') return 'verifier'
  return role
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`
}

export function AgentModeWorkerRoster({
  summary,
}: {
  summary: AgentModeWorkerUxSummary | null
}): React.ReactNode {
  return (
    <Box width="100%" flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="claude">◉ Agent Mode</Text>
        <Text dimColor> · orchestrating workers</Text>
      </Box>
      {!summary?.hasWorkers ? (
        <Box>
          <Text dimColor>  workers: none yet</Text>
        </Box>
      ) : (
        <>
          <Box>
            <Text dimColor>  workers: </Text>
            <Text>{summary.active} active</Text>
            {summary.done > 0 ? (
              <Text dimColor>{` · ${summary.done} done`}</Text>
            ) : null}
            {summary.pendingSynthesis > 0 ? (
              <Text color="warning">{` · ${summary.pendingSynthesis} pending review`}</Text>
            ) : null}
            {summary.attention > 0 ? (
              <Text color="warning">{` · ${summary.attention} attention`}</Text>
            ) : null}
          </Box>
          {summary.visibleWorkers.map(worker => (
            <Box key={worker.agentId}>
              <Text dimColor>  </Text>
              <Text>{getWorkerDisplayHandle(worker)}</Text>
              <Text dimColor>{` ${getWorkerStatusLabel(worker)} · ${roleLabel(worker.role)} · ${truncate(worker.description, 64)}`}</Text>
            </Box>
          ))}
        </>
      )}
    </Box>
  )
}
```

- [ ] **Step 2: Integrate durable state in `REPL.tsx`**

In `src/screens/REPL.tsx`, add imports near the other Agent Mode imports:

```ts
import { AgentModeWorkerRoster } from '../agent-mode/AgentModeWorkerRoster.js'
import type { AgentModeSessionState } from '../agent-mode/sessionState.js'
import { summarizeAgentModeWorkers } from '../agent-mode/workerUxSummary.js'
```

Remove the old local `getAgentModeWorkerSummary(tasks: Record<string, unknown>)` helper once the new summary is wired.

- [ ] **Step 3: Add async durable state refresh in `REPL.tsx`**

Near the existing `agentModeWorkerSummary` calculation, replace the old task-count summary with:

```ts
const [agentModeSessionState, setAgentModeSessionState] =
  useState<AgentModeSessionState | null>(null)
const agentModeActive = isAgentMode()

useEffect(() => {
  let cancelled = false

  if (!agentModeActive) {
    setAgentModeSessionState(null)
    return
  }

  void import('../agent-mode/sessionState.js')
    .then(({ readSessionState }) => readSessionState(getSessionId()))
    .then(state => {
      if (!cancelled) setAgentModeSessionState(state)
    })
    .catch(error => {
      logForDebugging(`Failed to read Agent Mode session state: ${error}`)
      if (!cancelled) setAgentModeSessionState(null)
    })

  return () => {
    cancelled = true
  }
}, [agentModeActive, tasks, messages.length])

const agentModeWorkerSummary = useMemo(
  () =>
    agentModeActive
      ? summarizeAgentModeWorkers(agentModeSessionState)
      : null,
  [agentModeActive, agentModeSessionState],
)
```

If `logForDebugging`, `useEffect`, `useState`, or `getSessionId` are already imported or in scope, reuse the existing imports instead of duplicating them.

- [ ] **Step 4: Replace inline Agent Mode banner JSX**

Replace the current block:

```tsx
{agentModeActive ? <Box width="100%" flexDirection="column" marginBottom={1}>
  ...
</Box> : null}
```

with:

```tsx
{agentModeActive ? (
  <AgentModeWorkerRoster summary={agentModeWorkerSummary} />
) : null}
```

- [ ] **Step 5: Run summary tests and typecheck/build**

Run:

```bash
bun test src/agent-mode/workerUxSummary.test.ts
bun run build:dev
```

Expected: tests pass and build completes.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/agent-mode/AgentModeWorkerRoster.tsx src/screens/REPL.tsx
git commit -m "feat: show durable agent mode worker roster"
```

---

### Task 3: Worktree UX Copy Helpers

**Files:**
- Create: `src/utils/worktreeUxCopy.ts`
- Create: `src/utils/worktreeUxCopy.test.ts`

- [ ] **Step 1: Write failing copy helper tests**

Create `src/utils/worktreeUxCopy.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import {
  getEnterWorktreeResultCopy,
  getExitWorktreeActionCopy,
  getWorktreeExitDialogCopy,
} from './worktreeUxCopy.js'

describe('worktree UX copy', () => {
  test('frames worktree entry as an isolated attempt', () => {
    const copy = getEnterWorktreeResultCopy()

    expect(copy.title).toBe('Started isolated attempt')
    expect(copy.detail).toBe('The main workspace is untouched.')
  })

  test('frames exit actions around isolated results', () => {
    expect(getExitWorktreeActionCopy('keep').title).toBe('Kept isolated result')
    expect(getExitWorktreeActionCopy('remove').title).toBe('Discarded isolated result')
  })

  test('uses semantic exit dialog labels', () => {
    const copy = getWorktreeExitDialogCopy({
      changedFiles: 2,
      commits: 1,
      hasTmuxSession: false,
    })

    expect(copy.title).toBe('Finish isolated attempt')
    expect(copy.subtitle).toContain('This isolated attempt has 2 changed files and 1 commit')
    expect(copy.options.map(option => option.label)).toEqual([
      'Keep isolated result',
      'Discard isolated result',
    ])
  })
})
```

- [ ] **Step 2: Run failing copy tests**

Run:

```bash
bun test src/utils/worktreeUxCopy.test.ts
```

Expected: fails because `worktreeUxCopy.ts` does not exist.

- [ ] **Step 3: Implement copy helper**

Create `src/utils/worktreeUxCopy.ts`:

```ts
export type WorktreeExitCopyInput = {
  changedFiles: number
  commits: number
  hasTmuxSession: boolean
}

export type WorktreeExitOptionCopy = {
  label: string
  description: string
}

export function getEnterWorktreeResultCopy(): {
  title: string
  detail: string
} {
  return {
    title: 'Started isolated attempt',
    detail: 'The main workspace is untouched.',
  }
}

export function getExitWorktreeActionCopy(action: 'keep' | 'remove'): {
  title: string
  detail: string
} {
  if (action === 'keep') {
    return {
      title: 'Kept isolated result',
      detail: 'You can return to it later if needed.',
    }
  }

  return {
    title: 'Discarded isolated result',
    detail: 'The session returned to the main workspace.',
  }
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

function changedWorkDescription(input: WorktreeExitCopyInput): string {
  const parts = [
    input.changedFiles > 0
      ? plural(input.changedFiles, 'changed file', 'changed files')
      : null,
    input.commits > 0 ? plural(input.commits, 'commit', 'commits') : null,
  ].filter((part): part is string => part !== null)

  if (parts.length === 0) return 'This isolated attempt has no pending changes.'
  return `This isolated attempt has ${parts.join(' and ')}.`
}

export function getWorktreeExitDialogCopy(
  input: WorktreeExitCopyInput,
): {
  title: string
  subtitle: string
  options: WorktreeExitOptionCopy[]
} {
  const hasChanges = input.changedFiles > 0 || input.commits > 0
  const discardDescription = hasChanges
    ? 'Discard the isolated result. This cannot be undone.'
    : 'Clean up the isolated attempt.'

  return {
    title: 'Finish isolated attempt',
    subtitle: hasChanges
      ? `${changedWorkDescription(input)} Choose whether to keep or discard it.`
      : 'This isolated attempt has no pending changes and can be cleaned up safely.',
    options: input.hasTmuxSession
      ? [
          {
            label: 'Keep isolated result and tmux session',
            description: 'Preserve the isolated result and leave its tmux session running.',
          },
          {
            label: 'Keep isolated result',
            description: 'Preserve the isolated result and stop its tmux session.',
          },
          {
            label: 'Discard isolated result',
            description: discardDescription,
          },
        ]
      : [
          {
            label: 'Keep isolated result',
            description: 'Preserve the isolated result for later.',
          },
          {
            label: 'Discard isolated result',
            description: discardDescription,
          },
        ],
  }
}
```

- [ ] **Step 4: Run copy helper tests**

Run:

```bash
bun test src/utils/worktreeUxCopy.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/utils/worktreeUxCopy.ts src/utils/worktreeUxCopy.test.ts
git commit -m "feat: add task-centric worktree ux copy"
```

---

### Task 4: Worktree Tool Result UI Copy

**Files:**
- Modify: `src/tools/EnterWorktreeTool/UI.tsx`
- Modify: `src/tools/ExitWorktreeTool/UI.tsx`
- Test: `src/utils/worktreeUxCopy.test.ts`

- [ ] **Step 1: Update EnterWorktree UI**

In `src/tools/EnterWorktreeTool/UI.tsx`, import the helper:

```ts
import { getEnterWorktreeResultCopy } from '../../utils/worktreeUxCopy.js'
```

Replace `renderToolUseMessage()`:

```ts
export function renderToolUseMessage(): React.ReactNode {
  return 'Starting isolated attempt…'
}
```

Replace `renderToolResultMessage(...)` body with:

```tsx
const copy = getEnterWorktreeResultCopy()
return (
  <Box flexDirection="column">
    <Text>{copy.title}</Text>
    <Text dimColor>{copy.detail}</Text>
  </Box>
)
```

Do not remove `worktreePath` or `worktreeBranch` from the tool output schema; only stop emphasizing them in normal visible copy.

- [ ] **Step 2: Update ExitWorktree UI**

In `src/tools/ExitWorktreeTool/UI.tsx`, import the helper:

```ts
import { getExitWorktreeActionCopy } from '../../utils/worktreeUxCopy.js'
```

Replace `renderToolUseMessage()`:

```ts
export function renderToolUseMessage(): React.ReactNode {
  return 'Finishing isolated attempt…'
}
```

Replace the visible action label logic in `renderToolResultMessage(...)`:

```tsx
const copy = getExitWorktreeActionCopy(output.action)
return (
  <Box flexDirection="column">
    <Text>{copy.title}</Text>
    <Text dimColor>{copy.detail}</Text>
  </Box>
)
```

- [ ] **Step 3: Run copy tests and build**

Run:

```bash
bun test src/utils/worktreeUxCopy.test.ts
bun run build:dev
```

Expected: tests pass and build completes.

- [ ] **Step 4: Commit Task 4**

```bash
git add src/tools/EnterWorktreeTool/UI.tsx src/tools/ExitWorktreeTool/UI.tsx
git commit -m "feat: hide worktree mechanics in tool result copy"
```

---

### Task 5: Worktree Exit Dialog Copy

**Files:**
- Modify: `src/components/WorktreeExitDialog.tsx`
- Test: `src/utils/worktreeUxCopy.test.ts`

- [ ] **Step 1: Import copy helper**

In `src/components/WorktreeExitDialog.tsx`, add:

```ts
import { getWorktreeExitDialogCopy } from '../utils/worktreeUxCopy.js'
```

- [ ] **Step 2: Replace subtitle and option copy**

Replace the existing `branchName`, `subtitle`, `removeDescription`, and `options` construction with:

```ts
const copy = getWorktreeExitDialogCopy({
  changedFiles: changes.length,
  commits: commitCount,
  hasTmuxSession: Boolean(worktreeSession.tmuxSessionName),
})

const hasTmuxSession = Boolean(worktreeSession.tmuxSessionName)
const options = hasTmuxSession
  ? [
      {
        label: copy.options[0]!.label,
        value: 'keep-with-tmux',
        description: copy.options[0]!.description,
      },
      {
        label: copy.options[1]!.label,
        value: 'keep-kill-tmux',
        description: copy.options[1]!.description,
      },
      {
        label: copy.options[2]!.label,
        value: 'remove-with-tmux',
        description: copy.options[2]!.description,
      },
    ]
  : [
      {
        label: copy.options[0]!.label,
        value: 'keep',
        description: copy.options[0]!.description,
      },
      {
        label: copy.options[1]!.label,
        value: 'remove',
        description: copy.options[1]!.description,
      },
    ]
```

Update the dialog title:

```tsx
<Dialog title={copy.title} subtitle={copy.subtitle} onCancel={handleCancel}>
```

- [ ] **Step 3: Replace result messages**

In `handleSelect`, replace user-facing result messages:

```ts
setResultMessage('Isolated result kept. The session returned to the main workspace.')
```

For `keep-kill-tmux`:

```ts
setResultMessage('Isolated result kept and tmux session terminated. The session returned to the main workspace.')
```

For successful removal:

```ts
setResultMessage(
  commitCount > 0 || changes.length > 0
    ? `Isolated result discarded.${tmuxNote}`
    : `Isolated attempt cleaned up.${tmuxNote}`,
)
```

Keep debug logs and structured internal state unchanged.

- [ ] **Step 4: Run copy tests and build**

Run:

```bash
bun test src/utils/worktreeUxCopy.test.ts
bun run build:dev
```

Expected: tests pass and build completes.

- [ ] **Step 5: Commit Task 5**

```bash
git add src/components/WorktreeExitDialog.tsx
git commit -m "feat: reframe worktree exit as isolated result decision"
```

---

### Task 6: Full UX Validation

**Files:**
- All files touched by Tasks 1-5

- [ ] **Step 1: Run targeted tests**

Run:

```bash
bun test src/agent-mode/workerUxSummary.test.ts src/utils/worktreeUxCopy.test.ts
```

Expected: pass.

- [ ] **Step 2: Run related existing tests**

Run:

```bash
bun test src/agent-mode/agentMode.test.ts
bun test src/agent-mode/sessionState.test.ts
```

Expected: pass.

- [ ] **Step 3: Run build**

Run:

```bash
bun run build:dev
```

Expected: build completes successfully.

- [ ] **Step 4: Manual Agent Mode UX smoke test**

Run:

```bash
CLAUDE_CODE_AGENT_MODE=1 bun run dev
```

Manual acceptance:

- Agent Mode banner shows worker counts based on durable session state when workers exist.
- Banner shows `pending review` when a completed worker has pending synthesis.
- Banner shows compact worker rows using handles like `@worker-a`, not raw internal IDs.
- Failed/killed workers show `attention`.
- No worker state still shows `workers: none yet`.
- Starting an isolated worktree says `Started isolated attempt`, not `Switched to worktree on branch...`.
- Exiting a worktree asks the user to keep or discard the isolated result, not to manage a worktree path/branch.

- [ ] **Step 5: Final diff check**

Run:

```bash
git diff --stat
git diff -- src/agent-mode src/screens/REPL.tsx src/tools/EnterWorktreeTool src/tools/ExitWorktreeTool src/components/WorktreeExitDialog.tsx src/utils/worktreeUxCopy.ts
```

Expected:

- UI/copy/helper changes only.
- No `/agent` command behavior changes.
- No worktree runtime or cleanup safety changes.
- No task runtime changes.
- Structured worktree path/branch output remains available.

---

## Non-Goals

- Do not implement `ListWorkers`, `WaitWorkers`, `GetWorkerResult`, or `CancelWorker` in this plan.
- Do not change `/agent` fresh-start behavior.
- Do not remove worktree path/branch from structured tool output, logs, or debug state.
- Do not change worktree creation/removal safety gates.
- Do not make every Agent Mode task use a worktree.
- Do not add a large modal/panel system; keep the first UX pass terminal-native and compact.

---

## Self-Review

- Spec coverage: Covers visible Agent Mode worker roster, pending synthesis surfacing, handle-first display, attention state, and worktree-as-backend UX copy.
- Placeholder scan: No placeholders are left; tasks include concrete code snippets, file paths, commands, and acceptance checks.
- Type consistency: Helper types use existing Agent Mode state names and depend on `synthesisStatus` from the worker-control tracking plan.
