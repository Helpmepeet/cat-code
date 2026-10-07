/**
 * A view preference only: archiving never mutates transcripts. row.sessionId
 * also names history-only rows; a pre-ready app-id fallback is reconciled to
 * the engine key once known. Only newer message or active-acquisition evidence
 * clears a mark, never transcript metadata or a host-only attach timestamp.
 */
import type { MergedSessionRow } from './sessionsCatalogState.js'
import {
  readViewPreference,
  writeViewPreference,
  type ViewPreferenceStorage,
} from './viewPreference.js'

export const SIDEBAR_ARCHIVED_SESSIONS_STORAGE_KEY =
  'catcode.sidebarArchivedSessions.v1'

export type ArchivedSessions = readonly {
  sessionId: string
  archivedAt: number
}[]

export function createArchivedSessions(): ArchivedSessions {
  return []
}

function validId(id: string): boolean {
  return id.trim().length > 0
}

function normalizeArchivedSessions(values: readonly unknown[]): ArchivedSessions {
  const entries = new Map<string, number>()
  for (const value of values) {
    if (typeof value !== 'object' || value === null) continue
    const entry = value as Partial<ArchivedSessions[number]>
    if (
      typeof entry.sessionId !== 'string' ||
      !validId(entry.sessionId) ||
      typeof entry.archivedAt !== 'number' ||
      !Number.isFinite(entry.archivedAt) ||
      entry.archivedAt < 0
    ) continue
    entries.set(
      entry.sessionId,
      Math.max(entries.get(entry.sessionId) ?? 0, entry.archivedAt),
    )
  }
  // No retention cap: dropping an entry would silently unarchive saved work.
  return [...entries].map(([sessionId, archivedAt]) => ({ sessionId, archivedAt }))
}

export function readArchivedSessionsFromStorage(
  storage: ViewPreferenceStorage | null,
): ArchivedSessions | null {
  return readViewPreference(
    storage,
    SIDEBAR_ARCHIVED_SESSIONS_STORAGE_KEY,
    'sessions',
    value => Array.isArray(value) ? normalizeArchivedSessions(value) : null,
  )
}

export function writeArchivedSessionsToStorage(
  storage: ViewPreferenceStorage | null,
  state: ArchivedSessions,
): void {
  writeViewPreference(
    storage,
    SIDEBAR_ARCHIVED_SESSIONS_STORAGE_KEY,
    'sessions',
    normalizeArchivedSessions(state),
  )
}

function namesRow(entry: ArchivedSessions[number], row: MergedSessionRow): boolean {
  return entry.sessionId === row.sessionId ||
    (row.appSessionId != null && entry.sessionId === row.appSessionId)
}

export function reduceSessionArchived(
  state: ArchivedSessions,
  row: MergedSessionRow,
  at: number,
): ArchivedSessions {
  if (!validId(row.sessionId) || !Number.isFinite(at) || at < 0) return state
  return [
    { sessionId: row.sessionId, archivedAt: at },
    ...state.filter(entry => !namesRow(entry, row)),
  ]
}

export function reduceSessionUnarchived(
  state: ArchivedSessions,
  row: MergedSessionRow,
): ArchivedSessions {
  if (!state.some(entry => namesRow(entry, row))) return state
  return state.filter(entry => !namesRow(entry, row))
}

function realActivity(row: MergedSessionRow): number {
  return Math.max(
    row.lastMessageSentAt ?? 0,
    row.sessionActivityAtMs ?? 0,
  )
}

export function reduceArchivedSessionsReconciled(
  state: ArchivedSessions,
  rows: readonly MergedSessionRow[],
): ArchivedSessions {
  if (state.length === 0) return state
  const rowById = new Map<string, MergedSessionRow>()
  for (const row of rows) {
    rowById.set(row.sessionId, row)
    if (row.appSessionId != null) rowById.set(row.appSessionId, row)
  }
  const canonical = normalizeArchivedSessions(state.map(entry => ({
    ...entry,
    sessionId: rowById.get(entry.sessionId)?.sessionId ?? entry.sessionId,
  })))
  const next = canonical.filter(entry => {
    const row = rowById.get(entry.sessionId)
    return row == null || realActivity(row) <= entry.archivedAt
  })
  if (
    next.length === state.length &&
    next.every((entry, index) =>
      entry.sessionId === state[index]!.sessionId &&
      entry.archivedAt === state[index]!.archivedAt,
    )
  ) return state
  // Remove superseded marks durably, even if a later catalog read is stale.
  return next
}

export function selectArchivedSidebarRows(
  rows: readonly MergedSessionRow[],
  state: ArchivedSessions,
): { visible: MergedSessionRow[]; archived: MergedSessionRow[] } {
  const ids = new Set(
    reduceArchivedSessionsReconciled(state, rows).map(entry => entry.sessionId),
  )
  const visible: MergedSessionRow[] = []
  const archived: MergedSessionRow[] = []
  for (const row of rows) {
    ;(ids.has(row.sessionId) ? archived : visible).push(row)
  }
  return { visible, archived }
}
