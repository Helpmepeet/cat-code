/**
 * Tasks state (P4-9) — per-session background-task snapshots from the
 * `tasks.snapshot` read-seam, plus derived display state that reuses the
 * P4-2 `agentIdentity` vocabulary for the three task types that carry real
 * agent state (local_agent / in_process_teammate / remote_agent).
 */
import {
  deriveTaskAgentState,
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

export type TasksAction =
  | { type: 'frame'; frame: ServerFrame }
  | { type: 'session-removed'; sessionId: SessionId }

export function createTasksState(): TasksState {
  return { bySession: {} }
}

export function reduceTasksState(state: TasksState, action: TasksAction): TasksState {
  if (action.type === 'session-removed') {
    if (!(action.sessionId in state.bySession)) return state
    const bySession = { ...state.bySession }
    delete bySession[action.sessionId]
    return { ...state, bySession }
  }
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

/**
 * P4-8b — where the dialog's selected task sits in the list it is rendering now,
 * or -1 when that task is gone. The selection is held as a task ID and resolved
 * here at READ time because `groupTaskItems` re-sorts on every snapshot (running
 * first, then newest): a task that starts while the dialog is open takes the
 * first slot, so a STORED index silently addresses a different row than the one
 * under the highlight. A vanished id degrades to no selection, the way
 * `selectWorkerById` degrades a vanished worker back to the roster.
 */
export function selectedTaskIndex(
  items: readonly TaskSnapshotItem[],
  selectedTaskId: string | null,
): number {
  if (!selectedTaskId) return -1
  return items.findIndex(item => item.id === selectedTaskId)
}

/**
 * The `K → stop` target: the selected task's id IF it is still in the list and
 * non-terminal (stoppable), else null. The prototype gates `K` on
 * `!isTerminal(t)` (`TasksPage.jsx:109`); this is that gate, pure so the keyboard
 * decision is unit-testable despite the SSR-only renderer harness.
 */
export function stoppableTaskId(
  items: readonly TaskSnapshotItem[],
  selectedTaskId: string | null,
): string | null {
  if (!selectedTaskId) return null
  const target = items.find(item => item.id === selectedTaskId)
  if (!target || isTerminalTaskStatus(target.status)) return null
  return target.id
}

/**
 * Arrow-key movement over the id-tracked selection, clamped at both ends exactly
 * as the index arithmetic it replaces was. An unresolvable selection (never set,
 * or vanished from the snapshot) recovers at the top of the list.
 */
export function stepTaskSelection(
  items: readonly TaskSnapshotItem[],
  selectedTaskId: string | null,
  step: 1 | -1,
): string | null {
  if (items.length === 0) return null
  const index = selectedTaskIndex(items, selectedTaskId)
  const next =
    step === 1 ? Math.min(items.length - 1, index + 1) : Math.max(0, index - 1)
  return items[next]?.id ?? null
}

export type TasksDialogKeyAction = 'close' | 'next' | 'previous' | 'stop'

/**
 * What a keypress means to the open Tasks dialog, or null for "not ours".
 *
 * A chord is NEVER ours: ⌘K reopens the command palette, and `event.key` is
 * still `'k'` while Meta is held, so an unguarded `k` test destroys the first
 * running task on the way to the palette. Same shape and same modifier bail as
 * `permissionKeyIntent` (`permissionPromptModel.ts`), and pure for the same
 * reason as `stoppableTaskId` above: the renderer suite is SSR-only and can
 * never press a key.
 */
export function tasksDialogKeyAction(event: {
  key: string
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
}): TasksDialogKeyAction | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null
  if (event.key === 'Escape') return 'close'
  if (event.key === 'ArrowDown') return 'next'
  if (event.key === 'ArrowUp') return 'previous'
  if (event.key === 'k' || event.key === 'K') return 'stop'
  return null
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
    if (item.type === 'local_agent') continue
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
 * resumed logic) over REAL fields (`handoffStatus`/`awaitingPlanApproval`/
 * `ultraplanPhase` — not fixture enrichment). The other four task types
 * (local_bash/local_workflow/monitor_mcp/dream) have no such per-type state
 * machine — their status IS the whole state, mapped 1:1 onto the same
 * `AgentStateKey` vocabulary. NOTE (B6, 2026-07-12 review): the P4-8
 * orchestrator roster does NOT consume this function — it derives its own
 * state via `orchestratorState.ts`'s `orchestratorWorkerState` (a different
 * source shape, `AgentModeWorkerItem` vs `TaskSnapshotItem`, and it carries
 * the `active` flag this function has no access to).
 */
export function taskDisplayState(item: TaskSnapshotItem): AgentStateKey {
  const agentSource = toTaskAgentSource(item)
  if (agentSource) return deriveTaskAgentState(agentSource)
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

export type TaskColorClass = {
  /** `text-*` foreground utility. */
  text: string
  /** `border-*` utility (35% alpha, for the kind-badge outline). */
  border: string
  /** `bg-*` utility (for the status dot). */
  dot: string
}

/**
 * STATIC hex→fixed-class map — the `AGENT_DOT_CLASS` idiom
 * (`AgentsPage.tsx:58`). Tailwind v4 only emits class LITERALS it can see at
 * build time, so a dynamic `text-[${kind.color}]` / `bg-[${state.color}]` is
 * scanned as an incomplete token and NEVER generated (the P4-9 colorless-badge
 * bug). Routing every `TASK_KIND_META.color` / `AGENT_STATE_META.color` through
 * this map guarantees only complete literal classes reach the DOM. The nearest
 * Tailwind palette token stands in for each token-era hex pick (exact enough —
 * the prototype's literal oklch values were already adapted, `tasksState.ts`
 * TASK_KIND_META header).
 */
export const TASK_COLOR_CLASS: Record<string, TaskColorClass> = {
  '#5eead4': { text: 'text-teal-300', border: 'border-teal-300/35', dot: 'bg-teal-300' },
  '#c084fc': { text: 'text-purple-400', border: 'border-purple-400/35', dot: 'bg-purple-400' },
  '#60a5fa': { text: 'text-blue-400', border: 'border-blue-400/35', dot: 'bg-blue-400' },
  '#c4b5fd': { text: 'text-violet-300', border: 'border-violet-300/35', dot: 'bg-violet-300' },
  '#fbbf24': { text: 'text-amber-400', border: 'border-amber-400/35', dot: 'bg-amber-400' },
  '#4ade80': { text: 'text-green-400', border: 'border-green-400/35', dot: 'bg-green-400' },
  '#a1a1aa': { text: 'text-zinc-400', border: 'border-zinc-400/35', dot: 'bg-zinc-400' },
  '#f87171': { text: 'text-red-400', border: 'border-red-400/35', dot: 'bg-red-400' },
  '#a8a29e': { text: 'text-stone-400', border: 'border-stone-400/35', dot: 'bg-stone-400' },
  '#71717a': { text: 'text-zinc-500', border: 'border-zinc-500/35', dot: 'bg-zinc-500' },
  '#fca5a5': { text: 'text-red-300', border: 'border-red-300/35', dot: 'bg-red-300' },
}

/** Muted fallback (never an arbitrary-value class) for an unmapped color. */
export const FALLBACK_TASK_COLOR_CLASS: TaskColorClass = {
  text: 'text-text-subtle',
  border: 'border-shell-seam',
  dot: 'bg-text-subtle',
}

export function taskColorClass(color: string): TaskColorClass {
  return TASK_COLOR_CLASS[color] ?? FALLBACK_TASK_COLOR_CLASS
}
