import type { SessionDescriptor } from '../../shared/hostApi.js'
import { resolvePendingSubmit, type PendingSubmitOutcome } from './composerState.js'

export type SessionDismissal = { appSessionId: string; engineSessionId: string | null }
export type SessionDismissals = readonly SessionDismissal[]
export const SESSION_DISMISSALS_KEY = 'cat-code.dismissed-sessions.v1'
const LIMIT = 4096
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export type DismissalStorage = Pick<Storage, 'getItem' | 'setItem'>

export function readSessionDismissals(storage: DismissalStorage | null): SessionDismissals {
  const raw = storage?.getItem(SESSION_DISMISSALS_KEY)
  if (!raw) return []
  if (raw.length > LIMIT * 140) throw new Error('Closed chat preferences are too large.')
  const value: unknown = JSON.parse(raw)
  if (!Array.isArray(value) || value.length > LIMIT || value.some(item =>
    !item || typeof item !== 'object' || Object.keys(item).sort().join(',') !== 'appSessionId,engineSessionId' ||
    typeof item.appSessionId !== 'string' || !UUID.test(item.appSessionId) ||
    item.engineSessionId !== null && (typeof item.engineSessionId !== 'string' || !UUID.test(item.engineSessionId)))) {
    throw new Error('Closed chat preferences could not be read.')
  }
  return value
}

export function isSessionDismissed(entries: SessionDismissals, session: SessionDescriptor): boolean {
  return entries.some(entry => entry.appSessionId === session.appSessionId ||
    entry.engineSessionId !== null && entry.engineSessionId === session.engineSessionId)
}

export function resolveDismissiblePendingSubmit(
  connection: Parameters<typeof resolvePendingSubmit>[0],
  sessionId: string,
  session: SessionDescriptor | undefined,
  entries: SessionDismissals,
): PendingSubmitOutcome {
  if (entries.some(entry => entry.appSessionId === sessionId) ||
      session && isSessionDismissed(entries, session)) return 'release'
  return resolvePendingSubmit(connection)
}

export function reopenSession(entries: SessionDismissals, session: SessionDescriptor): SessionDismissals {
  return entries.filter(entry => entry.appSessionId !== session.appSessionId &&
    (entry.engineSessionId === null || entry.engineSessionId !== session.engineSessionId))
}

export function reconcileSessionDismissals(entries: SessionDismissals, session: SessionDescriptor): SessionDismissals {
  if (!session.engineSessionId || !UUID.test(session.engineSessionId)) return entries
  let changed = false
  const next = entries.map(entry => {
    if (entry.appSessionId !== session.appSessionId || entry.engineSessionId !== null) return entry
    changed = true
    return { ...entry, engineSessionId: session.engineSessionId }
  })
  return changed ? next : entries
}

export function dismissSession(entries: SessionDismissals, session: SessionDescriptor): SessionDismissals {
  return [...reopenSession(entries, session), { appSessionId: session.appSessionId, engineSessionId: session.engineSessionId }]
}

export function dismissSessionAndRequestStop<T>(
  entries: SessionDismissals,
  session: SessionDescriptor | undefined,
  dismiss: (entries: SessionDismissals) => void,
  requestStop: () => Promise<T>,
): Promise<T> {
  dismiss(session ? dismissSession(entries, session) : entries)
  return requestStop()
}

export function writeSessionDismissals(storage: DismissalStorage | null, entries: SessionDismissals): void {
  if (!storage) throw new Error('Closed chats cannot be saved on this device.')
  // The in-memory escape must still work when this bounded preference is full.
  // Never evict or truncate an older dismissal to make room for a new one.
  if (entries.length > LIMIT) throw new Error('Too many closed chats are saved.')
  storage.setItem(SESSION_DISMISSALS_KEY, JSON.stringify(entries))
}

export function loadSessionDismissalPreferences(storage: DismissalStorage | null): {
  entries: SessionDismissals
  error: string | null
} {
  if (!storage) return {
    entries: [], error: 'Closed chat preferences are unavailable. Chat visibility changes will not be saved.',
  }
  try {
    return { entries: readSessionDismissals(storage), error: null }
  } catch {
    return { entries: [], error: 'Closed chat preferences could not be read. Chat visibility changes will not be saved until the app reloads successfully.' }
  }
}

export function saveSessionDismissalPreferences(
  storage: DismissalStorage | null,
  entries: SessionDismissals,
  readError: string | null,
): string | null {
  // An unreadable preference may still contain other saved dismissals.
  if (readError) return readError
  try {
    writeSessionDismissals(storage, entries)
    return null
  } catch {
    return 'Chat visibility could not be saved. Closed chats may reopen after restart.'
  }
}
