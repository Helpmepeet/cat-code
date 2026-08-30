import { randomUUID } from 'crypto'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { asAgentId } from '../types/ids.js'
import { isFsInaccessible } from '../utils/errors.js'
import { recipientNameKey } from '../utils/recipientIdentity.js'

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

export type AgentModeWorkerSynthesisStatus = 'pending' | 'synthesized'

export type AgentModeWorkerSession = {
  agentId: string
  handle?: string
  origin?: 'current' | 'prior'
  originSessionId?: string
  role: WorkerRole
  description: string
  status: AgentModeWorkerSessionStatus
  synthesisStatus?: AgentModeWorkerSynthesisStatus
  resumable?: boolean
  worktreePath: string | null
  outputSummary?: string
  error?: string
  spawnedAt?: string
  lastResultAt?: string
  lastResultSummary?: string
  lastSynthesizedAt?: string
  reuseBlockedReason?: string
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
const AGENT_MODE_STATE_SUFFIX = '.agent-mode-state.json'
const MAX_PRIOR_AGENT_MODE_SESSIONS = 12
// Coordinator sessions write state files too, so the newest files are not all
// resume candidates. Qualifying is only knowable after a read, so bound the
// reads separately from the qualifying-session cap.
const MAX_PRIOR_AGENT_MODE_STATE_READS = 48

export function getSessionStatePathFromTranscriptPath(
  transcriptPath: string,
): string {
  return transcriptPath.replace(/\.jsonl$/, AGENT_MODE_STATE_SUFFIX)
}

async function getSessionStatePath(sessionId: string): Promise<string> {
  const { getTranscriptPathForSession } =
    await import('../utils/sessionStorage.js')
  return getSessionStatePathFromTranscriptPath(
    getTranscriptPathForSession(sessionId),
  )
}

async function resolveSessionStatePath(
  sessionId: string,
  statePath?: string,
): Promise<string> {
  return statePath ?? (await getSessionStatePath(sessionId))
}

async function getCurrentProjectDir(): Promise<string> {
  const { getOriginalCwd, getSessionProjectDir } = await import(
    '../bootstrap/state.js'
  )
  const { getProjectDir } = await import('../utils/sessionStorage.js')
  return getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
}

function getSessionStatePathInProject(
  projectDir: string,
  sessionId: string,
): string {
  return join(projectDir, `${sessionId}${AGENT_MODE_STATE_SUFFIX}`)
}

function parseSessionIdFromStateFile(fileName: string): string | null {
  if (!fileName.endsWith(AGENT_MODE_STATE_SUFFIX)) return null
  return fileName.slice(0, -AGENT_MODE_STATE_SUFFIX.length)
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
    worker.origin === 'prior' ? 'prior-session' : undefined,
    worker.resumable ? 'resumable' : undefined,
    worker.reuseBlockedReason ? `not reusable:${worker.reuseBlockedReason}` : undefined,
    worker.synthesisStatus ? `synthesis:${worker.synthesisStatus}` : undefined,
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
    knownWorkers.findLast(worker => worker.synthesisStatus === 'pending') ??
    knownWorkers.findLast(
      worker => worker.status === 'failed' || worker.status === 'killed',
    ) ??
    knownWorkers.at(-1) ??
    null
  )
}

function deriveCurrentPhase(
  knownWorkers: AgentModeWorkerSession[],
): AgentModeRunPhase {
  if (knownWorkers.some(worker => worker.status === 'running')) {
    return 'executing'
  }

  if (knownWorkers.some(worker => worker.synthesisStatus === 'pending')) {
    return 'verifying'
  }

  if (
    knownWorkers.some(
      worker => worker.status === 'failed' || worker.status === 'killed',
    )
  ) {
    return 'blocked'
  }

  return 'planning'
}

function deriveNextAction(
  activeWorker: AgentModeWorkerSession | null,
  knownWorkers: AgentModeWorkerSession[],
  objective: string,
): string {
  if (activeWorker?.status === 'running') {
    return `Continue ${activeWorker.handle ?? activeWorker.agentId} on the current objective.`
  }

  if (activeWorker?.synthesisStatus === 'pending') {
    return `Read and synthesize ${activeWorker.handle ?? activeWorker.agentId} before concluding the objective.`
  }

  if (activeWorker?.status === 'failed' || activeWorker?.status === 'killed') {
    return `Inspect ${activeWorker.handle ?? activeWorker.agentId} and recover or report the blocker.`
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
  statePath?: string,
): Promise<AgentSessionState | null> {
  const path = await resolveSessionStatePath(sessionId, statePath)

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
  statePath?: string,
): Promise<void> {
  const path = await resolveSessionStatePath(sessionId, statePath)
  const writeChainKey = path
  const prior = sessionStateWriteChains.get(writeChainKey) ?? Promise.resolve()

  const next = prior
    .catch(() => {})
    .then(async () => {
      const state =
        (await readPersistedSessionState(sessionId, path)) ?? initFn?.()
      if (!state) return

      mutateFn(state)
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
  statePath?: string,
): Promise<void> {
  await mutatePersistedSessionState(sessionId, initFn, mutateFn, statePath)
}

export async function updateSessionObjective({
  sessionId,
  objective,
  resetWorkers = false,
}: {
  sessionId: string
  objective: string
  resetWorkers?: boolean
}): Promise<void> {
  await mutatePersistedSessionState(sessionId, null, state => {
    state.objective = objective.trim()
    if (resetWorkers) {
      state.activeWorkers = {}
      state.knownWorkers = {}
    }
  })
}

async function readPersistedSessionStateFromPath(
  path: string,
): Promise<AgentSessionState | null> {
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as AgentSessionState
  } catch (error) {
    if (isFsInaccessible(error)) return null
    if (error instanceof SyntaxError) return null
    throw error
  }
}

async function hasPriorAgentTranscript(
  sessionId: string,
  agentId: string,
): Promise<boolean> {
  const { getAgentTranscriptForSession } = await import(
    '../utils/sessionStorage.js'
  )
  return Boolean(await getAgentTranscriptForSession(sessionId, asAgentId(agentId)))
}

function ensureUniquePriorHandle(
  handle: string | undefined,
  agentId: string,
  sessionId: string,
  usedHandles: Set<string>,
): string {
  const base = handle && handle.length > 0 ? handle : agentId
  if (!usedHandles.has(recipientNameKey(base))) {
    usedHandles.add(recipientNameKey(base))
    return base
  }

  const shortSessionId = sessionId.slice(0, 8)
  const disambiguated = `${base}-${shortSessionId}`
  usedHandles.add(recipientNameKey(disambiguated))
  return disambiguated
}

async function readPriorWorkerSessions(
  currentSessionId: string,
  currentWorkers: AgentModeWorkerSession[],
): Promise<AgentModeWorkerSession[]> {
  const projectDir = await getCurrentProjectDir()
  let entries: string[]

  try {
    entries = await readdir(projectDir)
  } catch (error) {
    if (isFsInaccessible(error)) return []
    throw error
  }

  const candidates = await Promise.all(
    entries
      .map(fileName => ({
        fileName,
        sessionId: parseSessionIdFromStateFile(fileName),
      }))
      .filter(
        (entry): entry is { fileName: string; sessionId: string } =>
          Boolean(entry.sessionId) && entry.sessionId !== currentSessionId,
      )
      .map(async entry => {
        const path = getSessionStatePathInProject(projectDir, entry.sessionId)
        try {
          const fileStat = await stat(path)
          return { ...entry, path, mtime: fileStat.mtime.getTime() }
        } catch (error) {
          if (isFsInaccessible(error)) return null
          throw error
        }
      }),
  )

  const usedHandles = new Set(
    currentWorkers
      .map(worker => worker.handle)
      .filter((handle): handle is string => Boolean(handle))
      .map(recipientNameKey),
  )
  const currentAgentIds = new Set(currentWorkers.map(worker => worker.agentId))
  const priorWorkers: AgentModeWorkerSession[] = []

  let agentModeSessionsRead = 0

  for (const candidate of candidates
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .sort((left, right) => right.mtime - left.mtime)
    .slice(0, MAX_PRIOR_AGENT_MODE_STATE_READS)) {
    if (agentModeSessionsRead >= MAX_PRIOR_AGENT_MODE_SESSIONS) break
    const priorState = await readPersistedSessionStateFromPath(candidate.path)
    if (!priorState || priorState.mode !== 'agent') continue
    agentModeSessionsRead++

    for (const worker of sortWorkers(Object.values(priorState.knownWorkers))) {
      if (worker.status !== 'completed' || !worker.resumable) continue
      if (currentAgentIds.has(worker.agentId)) continue

      const transcriptAvailable = await hasPriorAgentTranscript(
        candidate.sessionId,
        worker.agentId,
      )
      const handle = ensureUniquePriorHandle(
        worker.handle,
        worker.agentId,
        candidate.sessionId,
        usedHandles,
      )

      priorWorkers.push({
        ...worker,
        handle,
        origin: 'prior',
        originSessionId: candidate.sessionId,
        resumable: transcriptAvailable,
        ...(transcriptAvailable
          ? {}
          : { reuseBlockedReason: 'original worker transcript is unavailable' }),
      })
    }
  }

  return priorWorkers
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
  statePath,
}: {
  sessionId: string
  mode: string
  objective: string
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
      const terminalStatus = existing?.status
      const isAlreadyTerminal =
        terminalStatus !== undefined && terminalStatus !== 'running'

      if (isAlreadyTerminal) {
        for (const [activeHandle, worker] of Object.entries(
          state.activeWorkers,
        )) {
          if (worker.agentId === agentId) {
            delete state.activeWorkers[activeHandle]
          }
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
        resumable: existing?.resumable ?? false,
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

export async function resolveWorkerAgentId(
  sessionId: string,
  worker: string,
): Promise<string | null> {
  const target = await resolveWorkerAgentTarget(sessionId, worker)
  return target?.agentId ?? null
}

export type WorkerAgentTarget = {
  agentId: string
  originSessionId: string
}

export async function resolveWorkerAgentTarget(
  sessionId: string,
  worker: string,
): Promise<WorkerAgentTarget | null> {
  const workerKey = recipientNameKey(worker)
  const state = await readPersistedSessionState(sessionId)
  const directMatch = state?.knownWorkers[worker]
  if (directMatch) {
    return { agentId: worker, originSessionId: sessionId }
  }

  if (state) {
    for (const [agentId, knownWorker] of Object.entries(state.knownWorkers)) {
      if (
        recipientNameKey(agentId) === workerKey ||
        (knownWorker.handle !== undefined &&
          recipientNameKey(knownWorker.handle) === workerKey)
      ) {
        return { agentId, originSessionId: sessionId }
      }
    }
  }

  const continuityState = await readSessionStateWithContinuity(sessionId)
  const priorWorker = continuityState?.knownWorkers.find(
    knownWorker =>
      knownWorker.origin === 'prior' &&
      knownWorker.resumable &&
      (recipientNameKey(knownWorker.agentId) === workerKey ||
        (knownWorker.handle !== undefined &&
          recipientNameKey(knownWorker.handle) === workerKey)),
  )
  if (priorWorker?.originSessionId) {
    return {
      agentId: priorWorker.agentId,
      originSessionId: priorWorker.originSessionId,
    }
  }

  return null
}

export async function recordWorkerSessionTerminal({
  sessionId,
  agentId,
  status,
  error,
  outputSummary,
  createStateIfMissing,
}: {
  sessionId: string
  agentId: string
  status: Exclude<AgentModeWorkerSessionStatus, 'running'>
  error?: string
  outputSummary?: string
  createStateIfMissing?: {
    mode: string
    objective: string
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
            objective: createStateIfMissing.objective,
          })
      : null,
    state => {
      const existing = state.knownWorkers[agentId]
      if (!existing && !createStateIfMissing) return

      for (const [handle, worker] of Object.entries(state.activeWorkers)) {
        if (worker.agentId === agentId) {
          delete state.activeWorkers[handle]
        }
      }

      const completed = status === 'completed'
      const endedAt = new Date().toISOString()
      const existingWorkerFields = { ...existing }
      delete existingWorkerFields.synthesisStatus
      delete existingWorkerFields.lastResultAt
      delete existingWorkerFields.lastResultSummary
      delete existingWorkerFields.lastSynthesizedAt

      state.knownWorkers[agentId] = {
        agentId,
        role: existing?.role ?? 'unknown',
        description:
          existing?.description ??
          outputSummary ??
          'Worker ended before spawn was recorded',
        worktreePath: existing?.worktreePath ?? null,
        ...existingWorkerFields,
        status,
        resumable: completed,
        ...(error ? { error } : {}),
        ...(outputSummary ? { outputSummary } : {}),
        ...(completed
          ? {
              lastResultAt: endedAt,
              lastResultSummary: outputSummary,
              synthesisStatus: 'pending' as const,
            }
          : {}),
      }
    },
    statePath,
  )
}

export async function markWorkerResultSynthesized({
  sessionId,
  agentId,
}: {
  sessionId: string
  agentId: string
}): Promise<boolean> {
  let found = false

  await mutatePersistedSessionState(sessionId, null, state => {
    const existing = state.knownWorkers[agentId]
    if (!existing || existing.synthesisStatus !== 'pending') return

    found = true
    state.knownWorkers[agentId] = {
      ...existing,
      synthesisStatus: 'synthesized',
      lastSynthesizedAt: new Date().toISOString(),
    }
  })

  return found
}

export async function readSessionState(
  sessionId: string,
  statePath?: string,
): Promise<AgentModeSessionState | null> {
  const persistedState = await readPersistedSessionState(sessionId, statePath)
  if (!persistedState) return null

  const knownWorkers = sortWorkers(
    Object.values(persistedState.knownWorkers).map(worker => ({
      ...worker,
      origin: worker.origin ?? 'current',
      originSessionId: worker.originSessionId ?? sessionId,
    })),
  )
  const activeWorker = getActiveWorker(persistedState, knownWorkers)

  return {
    objective: persistedState.objective,
    currentPhase: deriveCurrentPhase(knownWorkers),
    activeWorker,
    knownWorkers,
    nextAction: deriveNextAction(
      activeWorker,
      knownWorkers,
      persistedState.objective,
    ),
  }
}

export async function readSessionStateWithContinuity(
  sessionId: string,
): Promise<AgentModeSessionState | null> {
  const currentState =
    (await readSessionState(sessionId)) ??
    ({
      objective: '',
      currentPhase: 'planning',
      activeWorker: null,
      knownWorkers: [],
      nextAction: '',
    } satisfies AgentModeSessionState)
  const priorWorkers = await readPriorWorkerSessions(
    sessionId,
    currentState.knownWorkers,
  )
  const knownWorkers = sortWorkers([...currentState.knownWorkers, ...priorWorkers])

  return {
    objective: currentState.objective,
    currentPhase: currentState.currentPhase,
    activeWorker: currentState.activeWorker,
    knownWorkers,
    nextAction: deriveNextAction(
      currentState.activeWorker,
      knownWorkers,
      currentState.objective,
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
