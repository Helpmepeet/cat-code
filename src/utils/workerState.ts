import { randomUUID } from 'crypto'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { dirname } from 'path'
import type { SessionMode } from '../types/logs.js'
import { normalizeSessionMode } from '../types/logs.js'
import { isFsInaccessible } from '../utils/errors.js'
import { recipientNameKey } from '../utils/recipientIdentity.js'

export type WorkerRole = string

export type WorkerSessionStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed'

export type WorkerSession = {
  agentId: string
  handle?: string
  role: WorkerRole
  description: string
  status: WorkerSessionStatus
  worktreePath: string | null
  spawnedAt?: string
}

export type WorkerSessionState = {
  sessionId: string
  mode: SessionMode
  activeWorkers: Record<string, { role: string; agentId: string }>
  knownWorkers: Record<string, WorkerSession>
}

const sessionStateWriteChains = new Map<string, Promise<void>>()
const WORKER_STATE_SUFFIX = '.worker-state.json'
const LEGACY_AGENT_MODE_STATE_SUFFIX = '.agent-mode-state.json'

export function getSessionStatePathFromTranscriptPath(
  transcriptPath: string,
): string {
  return transcriptPath.replace(/\.jsonl$/, WORKER_STATE_SUFFIX)
}

function getLegacySessionStatePathFromTranscriptPath(
  transcriptPath: string,
): string {
  return transcriptPath.replace(/\.jsonl$/, LEGACY_AGENT_MODE_STATE_SUFFIX)
}

async function getSessionStatePath(sessionId: string): Promise<string> {
  const { getTranscriptPathForSession } =
    await import('../utils/sessionStorage.js')
  return getSessionStatePathFromTranscriptPath(
    getTranscriptPathForSession(sessionId),
  )
}

async function getLegacySessionStatePath(sessionId: string): Promise<string> {
  const { getTranscriptPathForSession } =
    await import('../utils/sessionStorage.js')
  return getLegacySessionStatePathFromTranscriptPath(
    getTranscriptPathForSession(sessionId),
  )
}

async function resolveSessionStatePath(
  sessionId: string,
  statePath?: string,
): Promise<string> {
  return statePath ?? (await getSessionStatePath(sessionId))
}

function normalizeWorkerSession(
  value: unknown,
  fallbackAgentId: string,
): WorkerSession | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const agentId = typeof raw.agentId === 'string' ? raw.agentId : fallbackAgentId
  const status = raw.status
  if (
    status !== 'running' &&
    status !== 'completed' &&
    status !== 'failed' &&
    status !== 'killed'
  ) {
    return null
  }

  return {
    agentId,
    ...(typeof raw.handle === 'string' ? { handle: raw.handle } : {}),
    role: typeof raw.role === 'string' ? raw.role : 'unknown',
    description:
      typeof raw.description === 'string' ? raw.description : 'worker',
    status,
    worktreePath:
      typeof raw.worktreePath === 'string' ? raw.worktreePath : null,
    ...(typeof raw.spawnedAt === 'string' ? { spawnedAt: raw.spawnedAt } : {}),
  }
}

function normalizePersistedSessionState(
  value: unknown,
): WorkerSessionState | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const mode = normalizeSessionMode(raw.mode)
  if (!mode || typeof raw.sessionId !== 'string') return null

  const activeWorkers: WorkerSessionState['activeWorkers'] = {}
  if (raw.activeWorkers && typeof raw.activeWorkers === 'object') {
    for (const [handle, candidate] of Object.entries(raw.activeWorkers)) {
      if (!candidate || typeof candidate !== 'object') continue
      const worker = candidate as Record<string, unknown>
      if (
        typeof worker.role === 'string' &&
        typeof worker.agentId === 'string'
      ) {
        activeWorkers[handle] = {
          role: worker.role,
          agentId: worker.agentId,
        }
      }
    }
  }

  const knownWorkers: WorkerSessionState['knownWorkers'] = {}
  if (raw.knownWorkers && typeof raw.knownWorkers === 'object') {
    for (const [agentId, candidate] of Object.entries(raw.knownWorkers)) {
      const worker = normalizeWorkerSession(candidate, agentId)
      if (worker) knownWorkers[agentId] = worker
    }
  }

  return { sessionId: raw.sessionId, mode, activeWorkers, knownWorkers }
}

async function readStateFile(path: string): Promise<WorkerSessionState | null> {
  try {
    const raw = await readFile(path, 'utf-8')
    return normalizePersistedSessionState(JSON.parse(raw))
  } catch (error) {
    if (isFsInaccessible(error)) return null
    if (error instanceof SyntaxError) return null
    throw error
  }
}

async function readPersistedSessionState(
  sessionId: string,
  statePath?: string,
): Promise<WorkerSessionState | null> {
  const path = await resolveSessionStatePath(sessionId, statePath)
  const current = await readStateFile(path)
  if (current) return current
  if (statePath) return null

  // Older records are read only when their normalized mode is coordinator.
  // Legacy records with mode `agent` intentionally disappear from the generic
  // worker view.
  return readStateFile(await getLegacySessionStatePath(sessionId)).then(state =>
    state?.mode === 'coordinator' ? state : null,
  )
}

async function mutatePersistedSessionState(
  sessionId: string,
  initFn: (() => WorkerSessionState) | null,
  mutateFn: (state: WorkerSessionState) => void,
  statePath?: string,
): Promise<void> {
  const path = await resolveSessionStatePath(sessionId, statePath)
  const writeChainKey = path
  const prior = sessionStateWriteChains.get(writeChainKey) ?? Promise.resolve()

  const next = prior
    .catch(() => {})
    .then(async () => {
      const state =
        (await readPersistedSessionState(sessionId, statePath)) ?? initFn?.()
      if (!state) return

      mutateFn(state)
      state.mode = normalizeSessionMode(state.mode) ?? 'normal'
      await mkdir(dirname(path), { recursive: true })
      const tempPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
      await writeFile(tempPath, JSON.stringify(state, null, 2))
      await rename(tempPath, path)
    })

  sessionStateWriteChains.set(writeChainKey, next)

  try {
    await next
  } finally {
    if (sessionStateWriteChains.get(writeChainKey) === next) {
      sessionStateWriteChains.delete(writeChainKey)
    }
  }
}

export function createSessionState(opts: {
  sessionId: string
  mode: string
}): WorkerSessionState {
  return {
    sessionId: opts.sessionId,
    mode: normalizeSessionMode(opts.mode) ?? 'normal',
    activeWorkers: {},
    knownWorkers: {},
  }
}

export async function updateSessionState(
  sessionId: string,
  initFn: () => WorkerSessionState,
  mutateFn: (state: WorkerSessionState) => void,
  statePath?: string,
): Promise<void> {
  await mutatePersistedSessionState(sessionId, initFn, mutateFn, statePath)
}

export async function recordWorkerSessionSpawn({
  sessionId,
  mode,
  handle,
  agentId,
  role,
  description,
  worktreePath,
  spawnedAt,
  statePath,
}: {
  sessionId: string
  mode: string
  statePath?: string
  handle?: string
  agentId: string
  role: string
  description: string
  worktreePath: string | null
  spawnedAt?: string
}): Promise<void> {
  await mutatePersistedSessionState(
    sessionId,
    () => createSessionState({ sessionId, mode }),
    state => {
      state.mode = normalizeSessionMode(mode) ?? 'normal'
      const existing = state.knownWorkers[agentId]
      const effectiveHandle = existing?.handle ?? handle ?? agentId
      const effectiveSpawnedAt = existing?.spawnedAt ?? spawnedAt
      const terminalStatus = existing?.status
      const isAlreadyTerminal =
        terminalStatus !== undefined && terminalStatus !== 'running'

      if (isAlreadyTerminal) {
        for (const [activeHandle, worker] of Object.entries(
          state.activeWorkers,
        )) {
          if (worker.agentId === agentId) delete state.activeWorkers[activeHandle]
        }
      } else {
        state.activeWorkers[effectiveHandle] = { role, agentId }
      }

      state.knownWorkers[agentId] = {
        ...existing,
        agentId,
        handle: effectiveHandle,
        role,
        description,
        status: terminalStatus ?? 'running',
        worktreePath,
        ...(effectiveSpawnedAt ? { spawnedAt: effectiveSpawnedAt } : {}),
      }
    },
    statePath,
  )
}

export async function readPersistedWorkerHandle(
  sessionId: string,
  agentId: string,
  statePath?: string,
): Promise<string | null> {
  const state = await readPersistedSessionState(sessionId, statePath)
  const handle = state?.knownWorkers[agentId]?.handle
  if (!handle || handle === agentId) return null
  return handle
}

export type WorkerAgentTarget = {
  agentId: string
  originSessionId: string
}

export async function resolveWorkerAgentId(
  sessionId: string,
  worker: string,
): Promise<string | null> {
  const target = await resolveWorkerAgentTarget(sessionId, worker)
  return target?.agentId ?? null
}

export async function resolveWorkerAgentTarget(
  sessionId: string,
  worker: string,
): Promise<WorkerAgentTarget | null> {
  const workerKey = recipientNameKey(worker)
  const state = await readPersistedSessionState(sessionId)
  if (!state) return null

  const directMatch = state.knownWorkers[worker]
  if (directMatch) return { agentId: worker, originSessionId: sessionId }

  for (const [agentId, knownWorker] of Object.entries(state.knownWorkers)) {
    if (
      recipientNameKey(agentId) === workerKey ||
      (knownWorker.handle !== undefined &&
        recipientNameKey(knownWorker.handle) === workerKey)
    ) {
      return { agentId, originSessionId: sessionId }
    }
  }

  return null
}

export async function recordWorkerSessionTerminal({
  sessionId,
  agentId,
  status,
  createStateIfMissing,
}: {
  sessionId: string
  agentId: string
  status: Exclude<WorkerSessionStatus, 'running'>
  createStateIfMissing?: {
    mode: string
    statePath?: string
  }
}): Promise<void> {
  const statePath = createStateIfMissing?.statePath
  await mutatePersistedSessionState(
    sessionId,
    createStateIfMissing
      ? () =>
          createSessionState({
            sessionId,
            mode: createStateIfMissing.mode,
          })
      : null,
    state => {
      const existing = state.knownWorkers[agentId]
      if (!existing && !createStateIfMissing) return

      for (const [handle, worker] of Object.entries(state.activeWorkers)) {
        if (worker.agentId === agentId) delete state.activeWorkers[handle]
      }

      state.knownWorkers[agentId] = {
        agentId,
        role: existing?.role ?? 'unknown',
        description: existing?.description ?? 'Worker ended before spawn was recorded',
        worktreePath: existing?.worktreePath ?? null,
        ...(existing ?? {}),
        status,
      }
    },
    statePath,
  )
}

export async function readSessionState(
  sessionId: string,
  statePath?: string,
): Promise<WorkerSessionState | null> {
  return readPersistedSessionState(sessionId, statePath)
}
