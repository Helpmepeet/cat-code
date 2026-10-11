import { useLayoutEffect } from 'react'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import type { SessionId } from '../../shared/protocol.js'
import type { WorkersState } from './workersState.js'
import type { TasksState } from './tasksState.js'
import type { LeaseStateStore } from './leaseState.js'
import { selectNestedTranscriptRows, type TranscriptState } from './transcriptProjector.js'
import {
  createSubagentDockState, reconcileSubagentDockState, isSubagentDockTerminal, mergeSubagentDockObservation,
  type SubagentDockState, type SubagentDockEntry,
} from './subagentDockState.js'
import {
  normalizeSubagentDockSession,
  readSubagentDockSessionsFromStorage, writeSubagentDockSessionsToStorage,
} from './subagentDockPersistence.js'
import { defaultViewPreferenceStorage, type ViewPreferenceStorage } from './viewPreference.js'

const MAX_OBSERVED_SESSIONS = 64
const runtimeByStorage = new WeakMap<ViewPreferenceStorage, Map<string, { sessionId: string; state: SubagentDockState }>>()
const signaturesByStorage = new WeakMap<ViewPreferenceStorage, Map<string, {
  source: SubagentDockEntry[]; signature: string; previousKey: string | null | undefined
}>>()
const durableFields: readonly (keyof SubagentDockEntry)[] = [
  'agentId', 'runKey', 'toolUseId', 'name', 'task', 'type', 'state', 'model',
  'recordedAccount', 'usageLabel', 'verdict', 'resultSummary', 'launchOrder', 'terminalAt', 'resumedAt',
]
function sameTerminalDisplay(left: readonly SubagentDockEntry[], right: readonly SubagentDockEntry[]): boolean {
  return left.length === right.length && left.every((entry, index) =>
    durableFields.every(field => entry[field] === right[index]?.[field]))
}
const transientRuntime = new Map<string, { sessionId: string; state: SubagentDockState }>()
function runtime(storage: ViewPreferenceStorage | null) {
  if (!storage) return transientRuntime
  let store = runtimeByStorage.get(storage)
  if (!store) { store = new Map(); runtimeByStorage.set(storage, store) }
  return store
}

/** A single run identity is shared between visible panes and offscreen observation. */
export function readSubagentDockObservation(sessionId: string, key: string, storage: ViewPreferenceStorage | null): SubagentDockState | null {
  const entry = runtime(storage).get(key)
  return entry?.sessionId === sessionId ? entry.state : null
}

export function commitSubagentDockObservation(sessionId: string, key: string, state: SubagentDockState,
  storage: ViewPreferenceStorage | null, previousKey?: string | null): SubagentDockState {
  const store = runtime(storage)
  const prior = store.get(key)?.state
  const bounded = mergeSubagentDockObservation(state, prior)
  if (previousKey && previousKey !== key && store.get(previousKey)?.sessionId === sessionId) store.delete(previousKey)
  store.delete(key)
  store.set(key, { sessionId, state: bounded })
  while (store.size > MAX_OBSERVED_SESSIONS) store.delete(store.keys().next().value!)
  return bounded
}

/** Read before each write: other sessions and Clear markers remain authoritative. */
export function persistSubagentDockObservation(storage: ViewPreferenceStorage | null, key: string,
  state: SubagentDockState, previousKey?: string | null): void {
  if (!storage) return
  const source = Object.values(state.entries).filter(entry => isSubagentDockTerminal(entry.state))
  let signatures = signaturesByStorage.get(storage)
  if (!signatures) { signatures = new Map(); signaturesByStorage.set(storage, signatures) }
  const cached = signatures.get(key)
  // Compare display fields before any JSON work; transient lastSeen/settle
  // changes must not serialize the finished history on every streamed frame.
  if (cached && cached.previousKey === previousKey && sameTerminalDisplay(cached.source, source)) return
  const finished = normalizeSubagentDockSession({ cleared: [], finished: source }).finished
  const signature = JSON.stringify({ finished, previousKey })
  if (cached?.signature === signature) {
    signatures.set(key, { source, signature, previousKey })
    return
  }
  const saved = readSubagentDockSessionsFromStorage(storage) ?? {}
  const previous = saved[key] ?? (previousKey ? saved[previousKey] : undefined)
  const record = normalizeSubagentDockSession({ cleared: previous?.cleared ?? [], finished })
  if (JSON.stringify(saved[key]) !== JSON.stringify(record) ||
      (previousKey && previousKey !== key && saved[previousKey])) {
    if (previousKey && previousKey !== key) delete saved[previousKey]
    delete saved[key]
    saved[key] = record
    writeSubagentDockSessionsToStorage(storage, saved)
  }
  signatures.delete(key)
  signatures.set(key, { source, signature, previousKey })
  while (signatures.size > MAX_OBSERVED_SESSIONS) signatures.delete(signatures.keys().next().value!)
}

export type SubagentDockObservationInput = {
  sessions: readonly SessionDescriptor[]
  workers: WorkersState
  tasks: TasksState
  transcript: TranscriptState
  leases: LeaseStateStore
}

/** Mounted in the shell so terminal snapshots are retained even with no pane. */
export function useSubagentDockObservation({ sessions, workers, tasks, transcript, leases }: SubagentDockObservationInput): void {
  const storage = defaultViewPreferenceStorage()
  useLayoutEffect(() => {
    const store = runtime(storage)
    const sessionIds = new Set(sessions.map(session => session.appSessionId))
    for (const [key, entry] of store) if (!sessionIds.has(entry.sessionId as SessionId)) store.delete(key)
    let saved: ReturnType<typeof readSubagentDockSessionsFromStorage> | undefined
    for (const session of sessions) {
      const sessionId = session.appSessionId
      const key = session.engineSessionId ?? sessionId
      const cached = readSubagentDockObservation(sessionId, key, storage)
        ?? readSubagentDockObservation(sessionId, sessionId, storage)
      if (!cached && !workers.bySession[sessionId] && !tasks.bySession[sessionId]) continue
      if (!cached && saved === undefined) saved = readSubagentDockSessionsFromStorage(storage)
      const previous = cached ?? createSubagentDockState((saved?.[key] ?? saved?.[sessionId])?.finished)
      const state = reconcileSubagentDockState(previous, {
        workers: workers.bySession[sessionId]?.workers ?? [],
        tasks: tasks.bySession[sessionId] ?? null,
        transcriptRows: selectNestedTranscriptRows(transcript, sessionId),
        leases: leases.bySession[sessionId] ?? null,
        nowMs: Date.now(), reducedMotion: true,
      })
      const committed = commitSubagentDockObservation(sessionId, key, state, storage, sessionId)
      persistSubagentDockObservation(storage, key, committed, sessionId)
    }
  }, [sessions, workers, tasks, transcript, leases, storage])
}
