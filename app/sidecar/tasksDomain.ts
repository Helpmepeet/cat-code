/**
 * Tasks read-seam (P4-9) — the domain recipe (`docs/migration/backlog/phase4.md`
 * Standing rules) applied to the background-task model: a domain service that
 * reads the SAME `AppState.tasks` the engine mutates
 * (`src/state/AppStateStore.ts:164`), no renderer-authored writes. Read-only in
 * v1 — kill/stop/inspect verbs stay engine-side (`/tasks` command,
 * `src/commands/tasks/tasks.tsx`); no new inbound vocabulary is added here.
 */
import type { AppStateStore } from '../../src/state/AppStateStore.js'
import { isBackgroundTask, type TaskState } from '../../src/tasks/types.js'
import type { TaskSnapshotItem, TasksSnapshot } from '../shared/protocol.js'

export type SidecarTasksDomain = {
  /** Live read-only snapshot over the same app-state store the runtime mutates. */
  getSnapshot(): TasksSnapshot
  subscribe(listener: () => void): () => void
}

export function createSidecarTasksDomain(
  appStateStore: AppStateStore,
): SidecarTasksDomain {
  return {
    getSnapshot() {
      const state = appStateStore.getState()
      return tasksSnapshot(state.tasks, state.foregroundedTaskId)
    },
    subscribe(listener) {
      return appStateStore.subscribe(listener)
    },
  }
}

/**
 * Mirrors `getSelectableBackgroundTasks` / `isVisibleBackgroundTask`
 * (`src/components/tasks/BackgroundTasksDialog.tsx:122-130`): a task is
 * listed if it is a live background task, OR a terminal-but-still-backgrounded
 * local_agent (so a blocked/completed handoff stays openable). The
 * foregrounded local_agent is excluded — its messages already render in the
 * main pane, matching the same file's `agent.id !== foregroundedTaskId` filter.
 */
export function tasksSnapshot(
  tasks: Record<string, TaskState> | undefined,
  foregroundedTaskId: string | undefined,
): TasksSnapshot {
  const items = Object.values(tasks ?? {})
    .filter(isVisibleBackgroundTask)
    .filter(task => !(task.type === 'local_agent' && task.id === foregroundedTaskId))
    .map(toTaskSnapshotItem)
  return {
    items,
    ...(foregroundedTaskId ? { foregroundedTaskId } : {}),
  }
}

// Inlines `isBackgroundTask` (types.ts) rather than calling it: `BackgroundTaskState`
// is structurally identical to `TaskState` (same 7-member union), so TS's aliased-
// condition narrowing on the predicate — even via a captured boolean — collapses
// the negative branch to `never`. Semantics match the source 1:1.
function isVisibleBackgroundTask(task: TaskState): boolean {
  const isLiveBackgroundTask =
    (task.status === 'running' || task.status === 'pending') &&
    !('isBackgrounded' in task && task.isBackgrounded === false)
  return (
    isLiveBackgroundTask ||
    (task.type === 'local_agent' && task.isBackgrounded && task.status !== 'running')
  )
}

function toTaskSnapshotItem(task: TaskState): TaskSnapshotItem {
  const base = {
    id: task.id,
    type: task.type,
    status: task.status,
    startTime: task.startTime,
    ...(task.endTime !== undefined ? { endTime: task.endTime } : {}),
    ...(task.totalPausedMs !== undefined ? { totalPausedMs: task.totalPausedMs } : {}),
  }
  switch (task.type) {
    case 'local_bash':
      return {
        ...base,
        label: task.kind === 'monitor' ? task.description : task.command,
        ...(task.kind ? { kind: task.kind } : {}),
        isBackgrounded: task.isBackgrounded,
      }
    case 'remote_agent':
      return {
        ...base,
        label: task.title,
        ...(task.isUltraplan !== undefined ? { isUltraplan: task.isUltraplan } : {}),
        ...(task.ultraplanPhase ? { ultraplanPhase: task.ultraplanPhase } : {}),
      }
    case 'local_agent':
      return {
        ...base,
        label: task.description,
        isBackgrounded: task.isBackgrounded,
        ...(task.handoffStatus ? { handoffStatus: task.handoffStatus } : {}),
        ...(task.resumedAt !== undefined ? { resumedAt: task.resumedAt } : {}),
        ...(task.agentName ? { agentName: task.agentName } : {}),
        agentType: task.agentType,
      }
    case 'in_process_teammate':
      return {
        ...base,
        label: `@${task.identity.agentName}`,
        agentName: task.identity.agentName,
        awaitingPlanApproval: task.awaitingPlanApproval,
        shutdownRequested: task.shutdownRequested,
        isIdle: task.isIdle,
      }
    case 'dream':
      return {
        ...base,
        label: task.description,
      }
    // local_workflow/monitor_mcp are ant-gated features (WORKFLOW_SCRIPTS/
    // MONITOR_TOOL) not compiled into any current `scripts/build.ts` feature
    // list, so their state modules never load here (src/tasks.ts:9-14) — which
    // also stops the switch above from typechecking as exhaustive. Fall back to
    // the shared TaskStateBase description (display = degrade gracefully)
    // rather than importing fields this build can't resolve.
    default:
      return {
        ...base,
        label: task.description,
      }
  }
}
