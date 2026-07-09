/**
 * Tasks state (P4-9) — per-session background-task snapshots from the
 * `tasks.snapshot` read-seam, plus derived display state that reuses the
 * P4-2 `agentIdentity` vocabulary for the three task types that carry real
 * agent state (local_agent / in_process_teammate / remote_agent).
 */
import {
  deriveTaskAgentState,
  type AgentStateDerivationOptions,
  type AgentStateKey,
  type TaskAgentSource,
} from './agentIdentity.js'
import type {
  ServerFrame,
  SessionId,
  TaskSnapshotItem,
  TasksSnapshot,
} from '../../shared/protocol.js'

export type TasksState = {
  bySession: Record<SessionId, TasksSnapshot | undefined>
}

export type TasksAction = { type: 'frame'; frame: ServerFrame }

export function createTasksState(): TasksState {
  return { bySession: {} }
}

export function reduceTasksState(state: TasksState, action: TasksAction): TasksState {
  const { frame } = action

  if (frame.kind === 'tasks.snapshot') {
    return {
      bySession: { ...state.bySession, [frame.sessionId]: frame.tasks },
    }
  }

  if (frame.kind === 'lifecycle') {
    return {
      bySession: { ...state.bySession, [frame.sessionId]: undefined },
    }
  }

  return state
}

export function selectTasksSnapshot(
  state: TasksState,
  sessionId: SessionId | null,
): TasksSnapshot | null {
  const snapshot = sessionId ? state.bySession[sessionId] : undefined
  return snapshot ?? null
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'killed'])

export function isTerminalTaskStatus(status: TaskSnapshotItem['status']): boolean {
  return TERMINAL_STATUSES.has(status)
}

/** Running-first, then newest — mirrors `BackgroundTasksDialog.tsx`'s sort. */
export function sortTaskItems(items: readonly TaskSnapshotItem[]): TaskSnapshotItem[] {
  return [...items].sort((a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1
    if (a.status !== 'running' && b.status === 'running') return 1
    return b.startTime - a.startTime
  })
}

export type TaskGroups = {
  active: TaskSnapshotItem[]
  completed: TaskSnapshotItem[]
}

/**
 * Active/Completed grouping (`TasksPage.jsx:217-218`) — a display choice, not
 * a fixture field; the real Ink dialog groups by task TYPE instead
 * (`BackgroundTasksDialog.tsx`'s `bashTasks`/`agentTasks`/… buckets). Parity
 * default follows the prototype; the divergence from the real dialog's
 * grouping is the flagged trade-off (PARITY-LEDGER.md §21).
 */
export function groupTaskItems(snapshot: TasksSnapshot | null): TaskGroups {
  if (!snapshot) return { active: [], completed: [] }
  const active: TaskSnapshotItem[] = []
  const completed: TaskSnapshotItem[] = []
  for (const item of sortTaskItems(snapshot.items)) {
    ;(isTerminalTaskStatus(item.status) ? completed : active).push(item)
  }
  return { active, completed }
}

const TASK_AGENT_TYPES = new Set<TaskSnapshotItem['type']>([
  'local_agent',
  'in_process_teammate',
  'remote_agent',
])

function toTaskAgentSource(item: TaskSnapshotItem): TaskAgentSource | null {
  if (!TASK_AGENT_TYPES.has(item.type)) return null
  // Narrowed by the membership check above; TS can't narrow a Set.has result,
  // so the type field is asserted structurally via the object literal below
  // (no `as` cast — every field is copied explicitly from the snapshot item).
  const type = item.type as TaskAgentSource['type']
  return {
    type,
    status: item.status,
    ...(item.isBackgrounded !== undefined ? { isBackgrounded: item.isBackgrounded } : {}),
    ...(item.handoffStatus ? { handoffStatus: item.handoffStatus } : {}),
    ...(item.resumedAt !== undefined ? { resumedAt: item.resumedAt } : {}),
    ...(item.awaitingPlanApproval !== undefined
      ? { awaitingPlanApproval: item.awaitingPlanApproval }
      : {}),
    ...(item.shutdownRequested !== undefined
      ? { shutdownRequested: item.shutdownRequested }
      : {}),
    ...(item.isIdle !== undefined ? { isIdle: item.isIdle } : {}),
    ...(item.ultraplanPhase ? { ultraplanPhase: item.ultraplanPhase } : {}),
    ...(item.agentName ? { agentName: item.agentName } : {}),
  }
}

/**
 * Real per-type state derivation. local_agent/in_process_teammate/remote_agent
 * reuse P4-2's `deriveTaskAgentState` (the same "needs input"/background/
 * resumed logic P4-8's roster will consume) over REAL fields
 * (`handoffStatus`/`awaitingPlanApproval`/`ultraplanPhase` — not fixture
 * enrichment). The other four task types (local_bash/local_workflow/
 * monitor_mcp/dream) have no such per-type state machine — their status IS
 * the whole state, mapped 1:1 onto the same `AgentStateKey` vocabulary.
 */
export function taskDisplayState(
  item: TaskSnapshotItem,
  options?: AgentStateDerivationOptions,
): AgentStateKey {
  const agentSource = toTaskAgentSource(item)
  if (agentSource) return deriveTaskAgentState(agentSource, options)
  switch (item.status) {
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'killed':
      return 'stopped'
    case 'pending':
    case 'running':
      return 'running'
  }
}

export type TaskKindMeta = {
  label: string
  color: string
}

/**
 * The per-type kind badge (`TP_KINDS`, `TasksPage.jsx:12-20`) — adapted, not
 * ported: labels match `TaskType` 1:1 (`src/Task.ts:6-13`), colors are new
 * P0-2-token-era picks (not the prototype's literal oklch values) using the
 * same "arbitrary-value Tailwind class over a data-driven color" idiom P4-2's
 * `agentTypeMeta` establishes (`WorkspacePanels.tsx:283` precedent).
 */
export const TASK_KIND_META: Record<TaskSnapshotItem['type'], TaskKindMeta> = {
  local_bash: { label: 'Bash', color: '#5eead4' },
  local_agent: { label: 'Agent', color: '#c084fc' },
  remote_agent: { label: 'Remote', color: '#60a5fa' },
  in_process_teammate: { label: 'Teammate', color: '#c4b5fd' },
  dream: { label: 'Dream', color: '#fbbf24' },
  local_workflow: { label: 'Workflow', color: '#4ade80' },
  monitor_mcp: { label: 'Monitor', color: '#a1a1aa' },
}

export function taskKindMeta(type: TaskSnapshotItem['type']): TaskKindMeta {
  return TASK_KIND_META[type]
}
