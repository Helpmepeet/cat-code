/**
 * What each session's WORK needs from the user, for the sidebar row mark
 * (operator, 2026-10-19, `docs/design-html/2026-10-19-sidebar-session-state-marks.html`,
 * "B + Glyph" with a green unseen dot). It replaces the O1 live dot, which
 * showed process liveness: true of nearly every row, so it said nothing.
 *
 * Connection state is deliberately absent. Starting, parked, disconnected and
 * closed rows carry no mark; only these four do:
 *  - `needs-you`: a permission request or question is waiting.
 *  - `working`:   a turn is running.
 *  - `failed`:    the last turn ended in an error. Cleared when the next turn starts.
 *  - `unseen`:    a turn ended while the session was not on screen. Cleared by viewing it.
 *
 * `working` and `needs-you` are read from the stores that already own them
 * (`connectionState`, `permissionState`). This module owns only the two facts no
 * other store keeps: the last turn's outcome and whether its end was seen.
 */
import { createContext } from 'react'
import type { ServerFrame, SessionId } from '../../shared/protocol.js'
import type { ConnectionSnapshot } from './connectionState.js'

export type SessionWorkMark = 'needs-you' | 'working' | 'failed' | 'unseen'

export type SessionWorkEntry = {
  /** Turn ends observed live for this session. */
  turnEnds: number
  /** The `turnEnds` value as of the last time the session was on screen. */
  seenTurnEnds: number
  /** The last turn's result was an error (not a user stop). */
  failed: boolean
}

export type SessionWorkState = {
  sessions: Record<SessionId, SessionWorkEntry>
}

export const INITIAL_SESSION_WORK_STATE: SessionWorkState = { sessions: {} }

export type SessionWorkAction =
  | {
      type: 'frames'
      frames: readonly ServerFrame[]
      /** Sessions on screen while this batch lands: a turn ending there is seen. */
      visible: ReadonlySet<SessionId>
      /**
       * The renderer's first batch is main's attachment replay of turns that
       * ended before this renderer existed. Counting them would mark every
       * session unseen after a reload, so they are recorded as already seen.
       */
      baseline: boolean
    }
  | { type: 'seen'; sessionIds: readonly SessionId[] }
  | { type: 'session-removed'; sessionId: SessionId }

const EMPTY: SessionWorkEntry = { turnEnds: 0, seenTurnEnds: 0, failed: false }

export function reduceSessionWork(
  state: SessionWorkState,
  action: SessionWorkAction,
): SessionWorkState {
  if (action.type === 'session-removed') {
    if (!(action.sessionId in state.sessions)) return state
    const sessions = { ...state.sessions }
    delete sessions[action.sessionId]
    return { sessions }
  }
  if (action.type === 'seen') {
    let sessions: Record<SessionId, SessionWorkEntry> | null = null
    for (const id of action.sessionIds) {
      const entry = state.sessions[id]
      if (!entry || entry.seenTurnEnds === entry.turnEnds) continue
      sessions ??= { ...state.sessions }
      sessions[id] = { ...entry, seenTurnEnds: entry.turnEnds }
    }
    return sessions ? { sessions } : state
  }

  let sessions: Record<SessionId, SessionWorkEntry> | null = null
  for (const frame of action.frames) {
    // Restored history from a resumed sidecar describes turns that already
    // happened; none of them is news.
    if (frame.kind !== 'event' || frame.replay) continue
    const event = frame.event
    const current = (sessions ?? state.sessions)[frame.sessionId] ?? EMPTY
    let next: SessionWorkEntry | null = null
    if (event.type === 'turn.status') {
      if (event.activeTurn) {
        if (current.failed) next = { ...current, failed: false }
      } else {
        const turnEnds = current.turnEnds + 1
        const seen = action.baseline || action.visible.has(frame.sessionId)
        next = {
          ...current,
          turnEnds,
          seenTurnEnds: seen ? turnEnds : current.seenTurnEnds,
        }
      }
    } else if (event.type === 'message') {
      const failed = resultFailed(event.message)
      if (failed !== null && failed !== current.failed) {
        next = { ...current, failed }
      }
    }
    if (!next) continue
    sessions ??= { ...state.sessions }
    sessions[frame.sessionId] = next
  }
  return sessions ? { sessions } : state
}

/** True/false for a top-level turn result, null for any other message. */
function resultFailed(message: unknown): boolean | null {
  if (typeof message !== 'object' || message === null) return null
  const record = message as Record<string, unknown>
  if (record.type !== 'result') return null
  if (record.parent_tool_use_id != null) return null
  // A user stop is reported as an `interrupted` result; it is not a failure.
  return record.is_error === true && record.subtype !== 'interrupted'
}

/**
 * The one mark a row shows, by urgency: a waiting request outranks a running
 * turn (the turn is blocked on it), and a failure outranks an unread reply.
 * `working` and `needs-you` require a ready connection, matching the TabBar's
 * attention rule: a dropped session cannot show or answer its stale queue.
 */
export function selectSessionWorkMark({
  connection,
  pendingPermissionCount,
  work,
}: {
  connection: ConnectionSnapshot | undefined
  pendingPermissionCount: number
  work: SessionWorkEntry | undefined
}): SessionWorkMark | null {
  const ready = connection?.status === 'ready'
  if (ready && pendingPermissionCount > 0) return 'needs-you'
  if (ready && !connection.inputEnabled) return 'working'
  if (work?.failed) return 'failed'
  if (work && work.turnEnds > work.seenTurnEnds) return 'unseen'
  return null
}

/** The mark is decorative; the row's accessible name carries these words. */
export const SESSION_WORK_MARK_LABEL: Record<SessionWorkMark, string> = {
  'needs-you': 'waiting for you',
  working: 'working',
  failed: 'last turn failed',
  unseen: 'unread reply',
}

/** Each registry session's mark, keyed by app session id; App provides it to the Sidebar. */
export const SessionWorkMarksContext = createContext<ReadonlyMap<SessionId, SessionWorkMark>>(new Map())
