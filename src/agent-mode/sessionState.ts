import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { isFsInaccessible } from '../utils/errors.js'
import { getTranscriptPathForSession } from '../utils/sessionStorage.js'

export type AgentModeRunPhase =
  | 'planning'
  | 'awaiting_approval'
  | 'executing'
  | 'verifying'
  | 'completed'
  | 'blocked'
  | 'cancelled'

export type WorkerRole = string

export type AgentModeWorkerSessionStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed'

export type AgentModeWorkerSession = {
  agentId: string
  handle?: string
  role: WorkerRole
  description: string
  status: AgentModeWorkerSessionStatus
  resumable?: boolean
  worktreePath: string | null
  outputSummary?: string
  error?: string
  spawnedAt?: string
}

export type AgentModeSessionState = {
  objective: string
  currentPhase: AgentModeRunPhase
  activeWorker: AgentModeWorkerSession | null
  knownWorkers: AgentModeWorkerSession[]
  nextAction: string
}

export type DurableWorkerSession = AgentModeWorkerSession

export type AgentSessionState = {
  sessionId: string
  mode: string
  objective: string
  activeWorkers: Record<string, { role: string; agentId: string }>
  knownWorkers: Record<string, DurableWorkerSession>
}

const sessionStateWriteChains = new Map<string, Promise<void>>()

function getSessionStatePath(sessionId: string): string {
  return getTranscriptPathForSession(sessionId).replace(
    /\.jsonl$/,
    '.agent-mode-state.json',
  )
}

function formatWorkerSession(worker: AgentModeWorkerSession): string {
  const label =
    worker.handle && worker.handle !== worker.agentId
      ? `${worker.handle} (${worker.role})`
      : worker.role
  const parts = [
    label,
    worker.description,
    worker.status,
    worker.resumable ? 'resumable' : undefined,
  ]
  return `- ${parts.filter(Boolean).join(' — ')}`
}

function sortWorkers(
  workers: AgentModeWorkerSession[],
): AgentModeWorkerSession[] {
  return [...workers].sort((left, right) => {
    const leftTime = left.spawnedAt ? Date.parse(left.spawnedAt) : 0
    const rightTime = right.spawnedAt ? Date.parse(right.spawnedAt) : 0
    return leftTime - rightTime
  })
}

function getActiveWorker(
  state: AgentSessionState,
  knownWorkers: AgentModeWorkerSession[],
): AgentModeWorkerSession | null {
  const activeAgentIds = new Set(
    Object.values(state.activeWorkers).map(worker => worker.agentId),
  )

  return (
    knownWorkers.findLast(
      worker => worker.status === 'running' && activeAgentIds.has(worker.agentId),
    ) ??
    knownWorkers.findLast(worker => worker.status === 'running') ??
    knownWorkers.at(-1) ??
    null
  )
}

function deriveCurrentPhase(
  activeWorker: AgentModeWorkerSession | null,
): AgentModeRunPhase {
  return activeWorker?.status === 'running' ? 'executing' : 'planning'
}

function deriveNextAction(
  activeWorker: AgentModeWorkerSession | null,
  knownWorkers: AgentModeWorkerSession[],
  objective: string,
): string {
  if (activeWorker?.status === 'running') {
    return `Continue ${activeWorker.handle ?? activeWorker.agentId} on the current objective.`
  }

  if (knownWorkers.some(worker => worker.resumable)) {
    return 'Resume the relevant prior worker when the follow-up strongly overlaps.'
  }

  return objective
    ? 'Continue the current objective.'
    : 'Choose the next step for the current objective.'
}

async function readPersistedSessionState(
  sessionId: string,
): Promise<AgentSessionState | null> {
  const path = getSessionStatePath(sessionId)

  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as AgentSessionState
  } catch (error) {
    if (isFsInaccessible(error)) return null
    if (error instanceof SyntaxError) return null
    throw error
  }
}

async function mutatePersistedSessionState(
  sessionId: string,
  initFn: (() => AgentSessionState) | null,
  mutateFn: (state: AgentSessionState) => void,
): Promise<void> {
  const path = getSessionStatePath(sessionId)
  const prior = sessionStateWriteChains.get(path) ?? Promise.resolve()

  const next = prior
    .catch(() => {})
    .then(async () => {
      const state = (await readPersistedSessionState(sessionId)) ?? initFn?.()
      if (!state) return

      mutateFn(state)
      await mkdir(dirname(path), { recursive: true })
      const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
      await writeFile(tempPath, JSON.stringify(state, null, 2))
      await rename(tempPath, path)
    })

  sessionStateWriteChains.set(path, next)

  try {
    await next
  } finally {
    if (sessionStateWriteChains.get(path) === next) {
      sessionStateWriteChains.delete(path)
    }
  }
}

export function buildAgentModeSessionState(
  snapshot: {
    ledger: { objective: string; run_status: AgentModeRunPhase; next_action: string }
    workerSessions: AgentModeWorkerSession[]
  },
): AgentModeSessionState {
  const activeWorker =
    snapshot.workerSessions.findLast(worker => worker.status === 'running') ??
    snapshot.workerSessions.at(-1) ??
    null

  return {
    objective: snapshot.ledger.objective,
    currentPhase: snapshot.ledger.run_status,
    activeWorker,
    knownWorkers: [...snapshot.workerSessions],
    nextAction: snapshot.ledger.next_action,
  }
}

export function createSessionState(opts: {
  sessionId: string
  mode: string
  objective: string
}): AgentSessionState {
  return { ...opts, activeWorkers: {}, knownWorkers: {} }
}

export async function updateSessionState(
  sessionId: string,
  initFn: () => AgentSessionState,
  mutateFn: (state: AgentSessionState) => void,
): Promise<void> {
  await mutatePersistedSessionState(sessionId, initFn, mutateFn)
}

export async function recordWorkerSessionSpawn({
  sessionId,
  mode,
  objective,
  handle,
  agentId,
  role,
  description,
  worktreePath,
  spawnedAt,
}: {
  sessionId: string
  mode: string
  objective: string
  handle?: string
  agentId: string
  role: string
  description: string
  worktreePath: string | null
  spawnedAt?: string
}): Promise<void> {
  await mutatePersistedSessionState(
    sessionId,
    () =>
      createSessionState({
        sessionId,
        mode,
        objective,
      }),
    state => {
      state.mode = mode
      if (!state.objective && objective) {
        state.objective = objective
      }
      const existing = state.knownWorkers[agentId]
      const effectiveHandle = existing?.handle ?? handle ?? agentId
      const effectiveSpawnedAt = existing?.spawnedAt ?? spawnedAt

      state.activeWorkers[effectiveHandle] = { role, agentId }
      state.knownWorkers[agentId] = {
        ...existing,
        agentId,
        handle: effectiveHandle,
        role,
        description,
        status: 'running',
        resumable: false,
        worktreePath,
        ...(effectiveSpawnedAt ? { spawnedAt: effectiveSpawnedAt } : {}),
      }
    },
  )
}

export async function readPersistedWorkerHandle(
  sessionId: string,
  agentId: string,
): Promise<string | null> {
  const state = await readPersistedSessionState(sessionId)
  const handle = state?.knownWorkers[agentId]?.handle
  if (!handle || handle === agentId) return null
  return handle
}

export async function recordWorkerSessionTerminal({
  sessionId,
  agentId,
  status,
  error,
  outputSummary,
}: {
  sessionId: string
  agentId: string
  status: Exclude<AgentModeWorkerSessionStatus, 'running'>
  error?: string
  outputSummary?: string
}): Promise<void> {
  await mutatePersistedSessionState(sessionId, null, state => {
    for (const [handle, worker] of Object.entries(state.activeWorkers)) {
      if (worker.agentId === agentId) {
        delete state.activeWorkers[handle]
      }
    }

    const existing = state.knownWorkers[agentId]
    if (!existing) return

    state.knownWorkers[agentId] = {
      ...existing,
      status,
      resumable: true,
      ...(error ? { error } : {}),
      ...(outputSummary ? { outputSummary } : {}),
    }
  })
}

export async function readSessionState(
  sessionId: string,
): Promise<AgentModeSessionState | null> {
  const persistedState = await readPersistedSessionState(sessionId)
  if (!persistedState) return null

  const knownWorkers = sortWorkers(Object.values(persistedState.knownWorkers))
  const activeWorker = getActiveWorker(persistedState, knownWorkers)

  return {
    objective: persistedState.objective,
    currentPhase: deriveCurrentPhase(activeWorker),
    activeWorker,
    knownWorkers,
    nextAction: deriveNextAction(
      activeWorker,
      knownWorkers,
      persistedState.objective,
    ),
  }
}

export function formatAgentModeSessionState(state: AgentModeSessionState): string {
  const lines = [
    'Agent Mode session state:',
    `- Objective: ${state.objective}`,
    `- Current phase: ${state.currentPhase}`,
    `- Next action: ${state.nextAction}`,
    state.activeWorker
      ? `- Active worker: ${(state.activeWorker.handle && state.activeWorker.handle !== state.activeWorker.agentId ? `${state.activeWorker.handle} (${state.activeWorker.role})` : state.activeWorker.role)} — ${state.activeWorker.description} (${state.activeWorker.status})`
      : '- Active worker: none',
    'Known workers:',
    state.knownWorkers.length > 0
      ? state.knownWorkers.map(formatWorkerSession).join('\n')
      : '- None.',
  ]

  return lines.join('\n')
}
