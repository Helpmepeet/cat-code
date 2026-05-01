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

function sortWorkersBySpawnedAt(
  workers: AgentModeWorkerSession[],
): AgentModeWorkerSession[] {
  return [...workers].sort((left, right) => {
    const leftTime = left.spawnedAt ? Date.parse(left.spawnedAt) : 0
    const rightTime = right.spawnedAt ? Date.parse(right.spawnedAt) : 0
    return leftTime - rightTime
  })
}

function needsAttention(worker: AgentModeWorkerSession): boolean {
  return worker.status === 'failed' || worker.status === 'killed'
}

function isVisibleWorker(worker: AgentModeWorkerSession): boolean {
  return (
    worker.status === 'running' ||
    worker.synthesisStatus === 'pending' ||
    needsAttention(worker)
  )
}

export function getWorkerDisplayHandle(
  worker: Pick<AgentModeWorkerSession, 'agentId' | 'handle'>,
): string {
  const handle =
    worker.handle && worker.handle !== worker.agentId
      ? worker.handle
      : worker.agentId
  return `@${handle}`
}

export function getWorkerStatusLabel(worker: {
  status: AgentModeWorkerSession['status']
  synthesisStatus?: AgentModeWorkerSession['synthesisStatus']
}): string {
  if (worker.synthesisStatus === 'pending') {
    return 'pending review'
  }
  if (worker.synthesisStatus === 'synthesized') {
    return 'synthesized'
  }
  if (worker.status === 'failed' || worker.status === 'killed') {
    return 'attention'
  }
  return worker.status
}

export function summarizeAgentModeWorkers(
  state: AgentModeSessionState | null,
): AgentModeWorkerUxSummary {
  const workers = sortWorkersBySpawnedAt(state?.knownWorkers ?? [])

  return {
    hasWorkers: workers.length > 0,
    active: workers.filter(worker => worker.status === 'running').length,
    done: workers.filter(worker => worker.status === 'completed').length,
    attention: workers.filter(worker => needsAttention(worker)).length,
    pendingSynthesis: workers.filter(
      worker => worker.synthesisStatus === 'pending',
    ).length,
    visibleWorkers: workers.filter(worker => isVisibleWorker(worker)).slice(-4),
  }
}
