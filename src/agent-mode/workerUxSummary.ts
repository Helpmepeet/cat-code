import type {
  AgentModeSessionState,
  AgentModeWorkerSession,
} from './sessionState.js'

export type AgentModeWorkerUxSummary = {
  hasWorkers: boolean
  active: number
  ready: number
  reviewed: number
  resumable: number
  stale: number
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
  return worker.origin !== 'prior' && worker.synthesisStatus === 'pending'
}

function isReviewed(worker: AgentModeWorkerSession): boolean {
  return (
    worker.origin !== 'prior' &&
    worker.status === 'completed' &&
    worker.synthesisStatus === 'synthesized'
  )
}

function isPriorResumable(worker: AgentModeWorkerSession): boolean {
  return worker.origin === 'prior' && worker.resumable === true
}

function isPriorStale(worker: AgentModeWorkerSession): boolean {
  return worker.origin === 'prior' && worker.resumable === false
}

function isVisibleWorker(worker: AgentModeWorkerSession): boolean {
  return (
    worker.status === 'running' ||
    isResultReady(worker) ||
    needsAttention(worker) ||
    isPriorResumable(worker) ||
    isPriorStale(worker)
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
  origin?: AgentModeWorkerSession['origin']
  resumable?: AgentModeWorkerSession['resumable']
}): string {
  if (worker.origin === 'prior' && worker.resumable === true) {
    return 'resumable'
  }
  if (worker.origin === 'prior' && worker.resumable === false) {
    return 'stale'
  }
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
    resumable: workers.filter(worker => isPriorResumable(worker)).length,
    stale: workers.filter(worker => isPriorStale(worker)).length,
    attention: workers.filter(worker => needsAttention(worker)).length,
    pendingSynthesis: workers.filter(worker => isResultReady(worker)).length,
    visibleWorkers: workers.filter(worker => isVisibleWorker(worker)).slice(-4),
  }
}
