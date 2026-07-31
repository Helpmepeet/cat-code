import type { SessionId } from '../../shared/protocol.js'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import { reduceShellState, type ShellState } from './shellState.js'

export type RosterBootstrapState = {
  status: 'pending' | 'failure' | 'ready'
  retrying: boolean
}

export type RosterBootstrapAction =
  | { type: 'read-started' }
  | { type: 'read-failed' }
  | { type: 'read-succeeded' }

export function createRosterBootstrapState(): RosterBootstrapState {
  return { status: 'pending', retrying: false }
}

export function reduceRosterBootstrapState(
  state: RosterBootstrapState,
  action: RosterBootstrapAction,
): RosterBootstrapState {
  switch (action.type) {
    case 'read-started':
      return state.status === 'failure'
        ? { status: 'failure', retrying: true }
        : { status: 'pending', retrying: false }
    case 'read-failed':
      return { status: 'failure', retrying: false }
    case 'read-succeeded':
      return { status: 'ready', retrying: false }
  }
}

export async function attemptRosterBootstrap({
  listSessions,
  onStarted,
  onSnapshot,
  onFailure,
}: {
  listSessions: () => Promise<readonly SessionDescriptor[]>
  onStarted: () => void
  onSnapshot: (sessions: readonly SessionDescriptor[]) => void
  onFailure: () => void
}): Promise<void> {
  onStarted()
  let sessions: readonly SessionDescriptor[]
  try {
    sessions = await listSessions()
  } catch {
    onFailure()
    return
  }
  onSnapshot(sessions)
}

/**
 * Fold a host snapshot as the baseline beneath any live host events that have
 * already landed. Removed rows stay removed, and newer live descriptors win.
 */
export function mergeRosterSnapshot(
  state: ShellState,
  sessions: readonly SessionDescriptor[],
  removed: ReadonlySet<SessionId>,
): ShellState {
  let next = state
  for (const session of sessions) {
    const id = session.appSessionId
    if (removed.has(id)) continue
    const existing = next.byId[id]
    if (existing && existing.lastAttachedAt >= session.lastAttachedAt) continue
    next = reduceShellState(next, { type: 'session-added', session })
  }
  return next
}
