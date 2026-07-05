/**
 * Shell root state (P3-5a) — the ordered session roster the shell shows, a pure
 * projection of the host control plane's `HostEvent` stream.
 *
 * It owns ONLY the roster + ordering; per-session transcript / connection /
 * permission state stays in the P3-4 stores keyed by `sessionId` (this reducer
 * never tears those down). `activeSessionId` is deliberately NOT part of this
 * reducer — it is renderer UI state held by `App`, so a background frame can
 * never steal focus through an event fold here.
 */

import type { SessionId } from '../../shared/protocol.js'
import type { HostEvent, SessionDescriptor } from '../../shared/hostApi.js'

/**
 * The shell's session roster: a stable id order plus the descriptor map. Order
 * is insertion order of `session-added` (a new tab appears at the end of the
 * bar); a status change never reorders. 5b's Sidebar orders its OWN list by
 * `lastAttachedAt` off `listSessions()` — the TabBar keeps arrival order so a
 * tab does not jump under the user mid-session.
 */
export type ShellState = {
  /** Tab order = arrival order of live sessions. */
  order: SessionId[]
  byId: Record<SessionId, SessionDescriptor>
}

export function createShellState(): ShellState {
  return { order: [], byId: {} }
}

/**
 * Fold one `HostEvent` into the roster. `added` appends (idempotent — a
 * re-added id refreshes in place, never duplicates the tab); `status` replaces
 * the descriptor without reordering; `removed` drops the id from both order and
 * map. A `status`/`removed` for an unknown id is ignored (no ghost tab).
 */
export function reduceShellState(
  state: ShellState,
  event: HostEvent,
): ShellState {
  switch (event.type) {
    case 'session-added': {
      const id = event.session.appSessionId
      const present = Boolean(state.byId[id])
      return {
        order: present ? state.order : [...state.order, id],
        byId: { ...state.byId, [id]: event.session },
      }
    }
    case 'session-status': {
      const id = event.session.appSessionId
      // A status event carries the FULL descriptor (hostApi.ts:115), so a status
      // that races ahead of its `session-added` is not a ghost — ADOPT it
      // (append like an add) rather than dropping it, or the row is lost until a
      // later event happens to re-add it. A known id updates in place (no
      // reorder). This closes the hydrate/subscribe ordering race (Finding 3):
      // a status landing between listSessions() and subscribeHost() survives.
      const present = Boolean(state.byId[id])
      return {
        order: present ? state.order : [...state.order, id],
        byId: { ...state.byId, [id]: event.session },
      }
    }
    case 'session-removed': {
      const id = event.appSessionId
      if (!state.byId[id]) return state
      const byId = { ...state.byId }
      delete byId[id]
      return {
        order: state.order.filter(candidate => candidate !== id),
        byId,
      }
    }
    default:
      return state
  }
}

/** Every descriptor in the roster (arrival order) — the Sidebar's live∪restorable source. */
export function selectSessions(state: ShellState): SessionDescriptor[] {
  return state.order.map(id => state.byId[id]).filter(isDescriptor)
}

/**
 * The LIVE sessions the TabBar renders (arrival order) — one tab per live
 * session (P3-5a). A cleanly-closed row (no live process, `restorable:true`
 * after the isRestorable fix) leaves the bar and surfaces in the Sidebar's
 * restore-offer instead; a CRASHED-but-not-yet-reaped session stays live
 * process-wise (`restorable:false`) so its TabBar restart stays valid — exactly
 * the host's restart-acceptance boundary (host.ts restartSession isLive check).
 * The row stays in the roster either way; only this projection is narrowed.
 */
export function selectLiveSessions(state: ShellState): SessionDescriptor[] {
  return selectSessions(state).filter(descriptor => !descriptor.restorable)
}

/**
 * The active id after the roster changes such that the ACTIVE session is no
 * longer a LIVE tab (it was closed → now restorable, or removed). Only moves
 * focus OFF a now-non-live active session, to the first remaining LIVE tab (or
 * null → empty shell); a background change never moves focus. `liveOrder` is the
 * post-change live tab order.
 */
export function activeAfterLiveChange(
  current: SessionId | null,
  liveOrder: readonly SessionId[],
): SessionId | null {
  if (current === null) return null
  if (liveOrder.includes(current)) return current
  return liveOrder[0] ?? null
}

export function selectSession(
  state: ShellState,
  sessionId: SessionId | null,
): SessionDescriptor | null {
  return sessionId ? (state.byId[sessionId] ?? null) : null
}

function isDescriptor(
  value: SessionDescriptor | undefined,
): value is SessionDescriptor {
  return value !== undefined
}

/* ------------------------------------------------------------------------- *
 * Active-tab selection helpers (renderer UI state — lives in App). Active
 * selection is driven imperatively off the frame + host-event streams (a
 * background frame never steals focus; only the ACTIVE tab's removal moves
 * focus), so the fallback policy is in App, not a roster-snapshot resolver.
 * ------------------------------------------------------------------------- */

/**
 * The tab a ⌘<n> jump targets: 1-based index into the visible tab order, or
 * null if that slot is empty. ⌘1..9 map to slots 1..9 (slot 9 is the LAST tab
 * in the prototype's convention when there are ≥9; here we keep the literal
 * 1..9 → index 0..8 mapping, matching a plain tab-order jump).
 */
export function sessionAtSlot(
  state: ShellState,
  slot: number,
): SessionId | null {
  if (slot < 1 || slot > 9) return null
  return state.order[slot - 1] ?? null
}
