import { useCallback, useSyncExternalStore } from 'react'
import type { SubagentDockEntry, SubagentDockClearMarker } from './subagentDockState.js'
import {
  defaultViewPreferenceStorage,
  readViewPreference,
  writeViewPreference,
  type ViewPreferenceStorage,
} from './viewPreference.js'

export const SUBAGENT_DOCK_SESSIONS_STORAGE_KEY = 'catcode.subagentDockSessions.v1'
export const SUBAGENT_DOCK_COLLAPSED_STORAGE_KEY = 'catcode.subagentDockCollapsed.v1'
export const MAX_PERSISTED_DOCK_SESSIONS = 32
export const MAX_PERSISTED_DOCK_FINISHED = 128
export const MAX_PERSISTED_DOCK_CLEAR_MARKERS = 512
export const MAX_PERSISTED_DOCK_CHARS = 2_000_000
const MAX_ID_CHARS = 256
const MAX_DISPLAY_CHARS = 2_000

export type { SubagentDockClearMarker } from './subagentDockState.js'

export type SubagentDockSessionPersistence = {
  cleared: SubagentDockClearMarker[]
  finished: SubagentDockEntry[]
}
export type SubagentDockSessionsPersistence = Record<string, SubagentDockSessionPersistence>

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS
}
function text(value: unknown): string | null {
  return typeof value === 'string' && value.length <= MAX_DISPLAY_CHARS ? value : null
}
function time(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function finishedEntry(value: unknown): SubagentDockEntry | null {
  const row = record(value)
  if (!row || !id(row.agentId) || !id(row.runKey) ||
      !['completed', 'failed', 'stopped'].includes(String(row.state)) ||
      !time(row.terminalAt) || !time(row.launchOrder) || !time(row.lastSeenAt) ||
      typeof row.task !== 'string' || row.task.length > MAX_DISPLAY_CHARS) return null
  return {
    agentId: row.agentId,
    runKey: row.runKey,
    toolUseId: id(row.toolUseId) ? row.toolUseId : null,
    name: text(row.name), task: row.task, type: text(row.type),
    state: row.state as 'completed' | 'failed' | 'stopped',
    model: text(row.model), recordedAccount: text(row.recordedAccount),
    usageLabel: text(row.usageLabel), verdict: text(row.verdict),
    resultSummary: text(row.resultSummary), blockReason: null,
    launchOrder: row.launchOrder, terminalAt: row.terminalAt,
    resumedAt: time(row.resumedAt) ? row.resumedAt : null,
    lastSeenAt: row.terminalAt,
    missingSince: null, settleUntil: null,
  }
}

/** Only terminal display evidence survives: live activity and leases never do. */
function normalizeSessions(value: unknown): SubagentDockSessionsPersistence | null {
  const sessions = record(value)
  if (!sessions) return null
  const out: SubagentDockSessionsPersistence = {}
  for (const [sessionId, raw] of Object.entries(sessions).reverse()) {
    if (Object.keys(out).length >= MAX_PERSISTED_DOCK_SESSIONS) break
    const session = record(raw)
    if (!id(sessionId) || !session) continue
    const cleared: SubagentDockClearMarker[] = []
    const seenMarkers = new Set<string>()
    if (Array.isArray(session.cleared)) for (const rawMarker of [...session.cleared].reverse()) {
      const marker = record(rawMarker)
      if (!marker || !id(marker.agentId) || !id(marker.runKey)) continue
      const key = JSON.stringify([marker.agentId, marker.runKey])
      if (seenMarkers.has(key)) continue
      seenMarkers.add(key)
      cleared.push({ agentId: marker.agentId, runKey: marker.runKey })
      if (cleared.length === MAX_PERSISTED_DOCK_CLEAR_MARKERS) break
    }
    const finished: SubagentDockEntry[] = []
    const seenAgents = new Set<string>()
    const candidates = Array.isArray(session.finished)
      ? session.finished.map(finishedEntry).filter((entry): entry is SubagentDockEntry => entry !== null)
      : []
    for (const entry of candidates.sort((a, b) => (b.terminalAt ?? 0) - (a.terminalAt ?? 0))) {
      if (seenAgents.has(entry.agentId)) continue
      seenAgents.add(entry.agentId)
      finished.push(entry)
      if (finished.length === MAX_PERSISTED_DOCK_FINISHED) break
    }
    // defineProperty admits an opaque session id safely, including __proto__.
    Object.defineProperty(out, sessionId, { value: { cleared: cleared.reverse(), finished }, enumerable: true, configurable: true, writable: true })
  }
  // Keep the whole record below the shared localStorage quota as well as
  // bounding each collection. Drop older sessions before the current session.
  const ordered = Object.fromEntries(Object.entries(out).reverse())
  while (JSON.stringify(ordered).length > MAX_PERSISTED_DOCK_CHARS) {
    const sessionIds = Object.keys(ordered)
    if (sessionIds.length > 1) {
      delete ordered[sessionIds[0]!]
      continue
    }
    const session = ordered[sessionIds[0]!]
    if (!session || session.finished.length === 0) break
    session.finished.pop()
  }
  return ordered
}

/** Canonical durable display fields, shared by the shell observer and panes. */
export function normalizeSubagentDockSession(value: unknown): SubagentDockSessionPersistence {
  return normalizeSessions({ session: value })?.session ?? { cleared: [], finished: [] }
}

export function readSubagentDockSessionsFromStorage(storage: ViewPreferenceStorage | null): SubagentDockSessionsPersistence | null {
  const bounded = storage ? {
    getItem: (key: string) => {
      const raw = storage.getItem(key)
      return raw !== null && raw.length <= MAX_PERSISTED_DOCK_CHARS + 100 ? raw : null
    },
    setItem: (key: string, value: string) => storage.setItem(key, value),
  } : null
  return readViewPreference(bounded, SUBAGENT_DOCK_SESSIONS_STORAGE_KEY, 'sessions', normalizeSessions)
}
export function writeSubagentDockSessionsToStorage(storage: ViewPreferenceStorage | null, sessions: SubagentDockSessionsPersistence): void {
  writeViewPreference(storage, SUBAGENT_DOCK_SESSIONS_STORAGE_KEY, 'sessions', normalizeSessions(sessions) ?? {})
}
export function readSubagentDockCollapsedFromStorage(storage: ViewPreferenceStorage | null): boolean | null {
  return readViewPreference(storage, SUBAGENT_DOCK_COLLAPSED_STORAGE_KEY, 'collapsed', value => typeof value === 'boolean' ? value : null)
}
export function writeSubagentDockCollapsedToStorage(storage: ViewPreferenceStorage | null, collapsed: boolean): void {
  writeViewPreference(storage, SUBAGENT_DOCK_COLLAPSED_STORAGE_KEY, 'collapsed', collapsed)
}

// Native storage events do not fire in the writing window. One shared store
// publishes local changes to every pane and accepts changes from other windows.
type CollapseStore = {
  value: boolean
  listeners: Set<() => void>
  subscribe: (listener: () => void) => () => void
  snapshot: () => boolean
  set: (next: boolean) => void
}
const collapseStores = new WeakMap<ViewPreferenceStorage, CollapseStore>()
let transientCollapseStore: CollapseStore | undefined
function createCollapseStore(storage: ViewPreferenceStorage | null): CollapseStore {
  const listeners = new Set<() => void>()
  const store: CollapseStore = {
    value: readSubagentDockCollapsedFromStorage(storage) ?? false,
    listeners,
    snapshot: () => store.value,
    subscribe: listener => {
      if (listeners.size === 0) {
        if (storage) store.value = readSubagentDockCollapsedFromStorage(storage) ?? false
        if (typeof window !== 'undefined') window.addEventListener('storage', receiveStorage)
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', receiveStorage)
      }
    },
    set: next => {
      writeSubagentDockCollapsedToStorage(storage, next)
      if (store.value === next) return
      store.value = next
      for (const listener of listeners) listener()
    },
  }
  function receiveStorage(event: StorageEvent) {
    if (event.key !== SUBAGENT_DOCK_COLLAPSED_STORAGE_KEY && event.key !== null) return
    if (event.storageArea !== null && event.storageArea !== storage) return
    const next = readSubagentDockCollapsedFromStorage(storage) ?? false
    if (store.value === next) return
    store.value = next
    for (const listener of listeners) listener()
  }
  return store
}

export function useSubagentDockCollapsedPreference(storage?: ViewPreferenceStorage | null): [boolean, (next: boolean) => void] {
  const backing = storage === undefined ? defaultViewPreferenceStorage() : storage
  let store = backing === null ? transientCollapseStore : collapseStores.get(backing)
  if (!store) {
    store = createCollapseStore(backing)
    if (backing === null) transientCollapseStore = store
    else collapseStores.set(backing, store)
  }
  const collapsed = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
  const set = useCallback((next: boolean) => store.set(next), [store])
  return [collapsed, set]
}
