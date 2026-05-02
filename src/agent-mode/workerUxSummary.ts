import type {
  AgentModeSessionState,
  AgentModeWorkerSession,
} from './sessionState.js'

export type AgentModeWorkerUxSummary = {
  hasWorkers: boolean
  active: number
  ready: number
  reviewed: number
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

function isResultReady(worker: AgentModeWorkerSession): boolean {
  return worker.synthesisStatus === 'pending'
}

function isReviewed(worker: AgentModeWorkerSession): boolean {
  return worker.status === 'completed' && worker.synthesisStatus === 'synthesized'
}

function isVisibleWorker(worker: AgentModeWorkerSession): boolean {
  return worker.status === 'running' || isResultReady(worker) || needsAttention(worker)
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
    return 'result ready'
  }
  if (worker.synthesisStatus === 'synthesized') {
    return 'reviewed'
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
    ready: workers.filter(worker => isResultReady(worker)).length,
    reviewed: workers.filter(worker => isReviewed(worker)).length,
    attention: workers.filter(worker => needsAttention(worker)).length,
    pendingSynthesis: workers.filter(worker => isResultReady(worker)).length,
    visibleWorkers: workers.filter(worker => isVisibleWorker(worker)).slice(-4),
  }
}
