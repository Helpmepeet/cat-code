/**
 * Live worker read-seam over the engine's `AppState.tasks` store.
 *
 * This domain carries only the current session's `local_agent` task records.
 * Worker controls remain on the generic task-control verbs, and no persisted
 * worker ledger or mode state crosses the desktop boundary.
 */
import type { AppStateStore } from '../../src/state/AppStateStore.js'
import {
  isLocalAgentTask,
  type LocalAgentTaskState,
} from '../../src/tasks/LocalAgentTask/LocalAgentTask.js'
import type { TaskState } from '../../src/tasks/types.js'
import { scanForSecrets } from '../shared/secretGuard.js'
import type {
  LiveWorkerItem,
  LiveWorkersSnapshot,
} from '../shared/protocol.js'

const MAX_RESULT_SUMMARY_CHARS = 2_048

export type SidecarWorkersDomain = {
  getSnapshot(): LiveWorkersSnapshot
  subscribe(listener: () => void): () => void
}

export function createSidecarWorkersDomain(
  appStateStore: AppStateStore,
): SidecarWorkersDomain {
  return {
    getSnapshot() {
      return workersSnapshot(appStateStore.getState().tasks)
    },
    subscribe(listener) {
      return appStateStore.subscribe(listener)
    },
  }
}

export function workersSnapshot(
  tasks: Record<string, TaskState> | undefined,
): LiveWorkersSnapshot {
  return {
    workers: Object.values(tasks ?? {})
      .filter(isLocalAgentTask)
      .map(toLiveWorkerItem),
  }
}

function toLiveWorkerItem(task: LocalAgentTaskState): LiveWorkerItem {
  const resultSummary = resultSummaryFor(task)
  return {
    agentId: task.agentId || task.id,
    handle: task.agentName ?? null,
    role: task.agentType ?? null,
    status: task.status === 'pending' ? 'running' : task.status,
    description: task.description ?? null,
    isBackgrounded: task.isBackgrounded === true,
    ...(task.handoffStatus ? { handoffStatus: task.handoffStatus } : {}),
    ...(task.handoffStatus === 'blocked' && task.blockReason
      ? { blockReason: task.blockReason }
      : {}),
    ...(task.verdict ? { verdict: task.verdict } : {}),
    ...(resultSummary ? { resultSummary } : {}),
  }
}

function resultSummaryFor(task: LocalAgentTaskState): string | undefined {
  const result = task.result
  if (!result || !scanForSecrets(result).ok) return undefined

  const text = result.content
    .filter(block => typeof block?.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
  if (!text) return undefined
  return text.slice(0, MAX_RESULT_SUMMARY_CHARS)
}
