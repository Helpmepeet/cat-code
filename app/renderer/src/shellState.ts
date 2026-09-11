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
 * is insertion/open order: `session-added` appends a new live tab, and opening a
 * restorable preview appends that newly-opened tab. A status change never
 * reorders. The Sidebar sorts its OWN projection by message activity, so that
 * recency order cannot move a tab under the user mid-session.
 */
export type ShellState = {
  /** Tab/pane order = the order panes were opened this run. */
  order: SessionId[]
  byId: Record<SessionId, SessionDescriptor>
  /**
   * Ids that are TabBar tabs this run. Tab membership is event history, not a
   * descriptor predicate: a session that goes live grants it, a clean close
   * (`restorable` + `exited`) or removal revokes it, and a CRASH (`restorable`
   * + `disconnected`) keeps it — the dead tab stays for restart-in-place while
   * the SAME descriptor is the Sidebar's crashed restore-offer. A restorable
   * row folded from the hydrate snapshot (previous run) never becomes a tab.
   */
  tabs: Record<SessionId, true>
  /** Dead-session panes opened from the transcript cache, keyed like live tabs. */
  previews: Record<SessionId, true>
}

export function createShellState(): ShellState {
  return { order: [], byId: {}, tabs: {}, previews: {} }
}

export type ShellStateAction =
  | HostEvent
  | { type: 'preview-open'; sessionId: SessionId }
  | { type: 'preview-close'; sessionId: SessionId }

/**
 * Fold one `HostEvent` into the roster. `added` appends (idempotent — a
 * re-added id refreshes in place, never duplicates the tab); `status` replaces
 * the descriptor without reordering; `removed` drops the id from both order and
 * map. Opening a restorable preview appends it like any other newly-opened tab.
 */
export function reduceShellState(
  state: ShellState,
  event: ShellStateAction,
): ShellState {
  switch (event.type) {
    case 'preview-open': {
      const id = event.sessionId
      const descriptor = state.byId[id]
      if (!descriptor?.restorable || state.previews[id]) return state
      return {
        ...state,
        // A hydrated/restorable row may sit anywhere in the roster because the
        // Sidebar has its own recency order. Once the user OPENS that row as a
        // preview, it becomes a new tab and belongs at the end of the tab strip.
        // If it is already a live/crashed tab, keep its existing spatial slot.
        order: state.tabs[id] ? state.order : moveToEnd(state.order, id),
        previews: { ...state.previews, [id]: true },
      }
    }
    case 'preview-close': {
      if (!state.previews[event.sessionId]) return state
      const previews = { ...state.previews }
      delete previews[event.sessionId]
      return { ...state, previews }
    }
    case 'session-added': {
      const id = event.session.appSessionId
      const present = Boolean(state.byId[id])
      const wasTab = Boolean(state.tabs[id])
      const tabs = foldTabMembership(state.tabs, event.session)
      return {
        order: reorderOnArrival(
          state.order,
          id,
          present,
          wasTab,
          Boolean(state.previews[id]),
          tabs,
        ),
        byId: { ...state.byId, [id]: event.session },
        tabs,
        previews: state.previews,
      }
    }
    case 'session-status': {
      const id = event.session.appSessionId
      // A status event carries the FULL descriptor (hostApi.ts:115), so a status
      // that races ahead of its `session-added` is not a ghost — ADOPT it
      // (append like an add) rather than dropping it, or the row is lost until a
      // later event happens to re-add it. A known id updates in place (no
      // reorder) UNLESS it is just regaining tab membership (see
      // `reorderOnArrival`). This closes the hydrate/subscribe ordering race
      // (Finding 3): a status landing between listSessions() and
      // subscribeHost() survives.
      const present = Boolean(state.byId[id])
      const wasTab = Boolean(state.tabs[id])
      const tabs = foldTabMembership(state.tabs, event.session)
      return {
        order: reorderOnArrival(
          state.order,
          id,
          present,
          wasTab,
          Boolean(state.previews[id]),
          tabs,
        ),
        byId: { ...state.byId, [id]: event.session },
        tabs,
        previews: state.previews,
      }
    }
    case 'session-removed': {
      const id = event.appSessionId
      if (!state.byId[id]) return state
      const byId = { ...state.byId }
      delete byId[id]
      const tabs = { ...state.tabs }
      delete tabs[id]
      const previews = { ...state.previews }
      delete previews[id]
      return {
        order: state.order.filter(candidate => candidate !== id),
        byId,
        tabs,
        previews,
      }
    }
    default:
      return state
  }
}

/**
 * Fold one descriptor into the tab-membership set:
 *  - not restorable (a process is live or restart-in-place pending) → tab;
 *  - restorable + `disconnected` (CRASH) → membership unchanged: a session that
 *    was a tab when its sidecar died stays one (restart stays valid), while a
 *    crashed row from a previous run — no tab to keep — never gains one;
 *  - restorable + anything else (clean close / plain exited row) → not a tab;
 *    it lives on in the roster as the Sidebar's restore-offer only.
 */
function foldTabMembership(
  tabs: ShellState['tabs'],
  session: SessionDescriptor,
): ShellState['tabs'] {
  const id = session.appSessionId
  if (!session.restorable) {
    if (tabs[id]) return tabs
    return { ...tabs, [id]: true }
  }
  if (session.status === 'disconnected') return tabs
  if (!tabs[id]) return tabs
  const next = { ...tabs }
  delete next[id]
  return next
}

/** Put a newly-opened pane at the end while keeping every other pane stable. */
function moveToEnd(order: SessionId[], id: SessionId): SessionId[] {
  if (order[order.length - 1] === id) return order
  return [...order.filter(candidate => candidate !== id), id]
}

/**
 * Where an id lands in `order` on `session-added` / `session-status`:
 *  - unknown id → append (a genuinely new tab arrives at the end);
 *  - known id, tab membership unchanged → unchanged (a plain status update,
 *    e.g. busy→ready, or the crash→restart-in-place path where the tab was
 *    kept the whole time — must NOT reorder, or a live tab would jump under
 *    the user for an unrelated status frame);
 *  - known id that JUST regained tab membership (restoreSession on a closed
 *    row, or crashed-restorable adopted from a hydrate snapshot) → moved to
 *    the end, like a freshly-opened tab. Without this, `order` still holds
 *    the id at its ORIGINAL arrival index from earlier in the run (only
 *    `session-removed` ever drops an id from `order`), so restoring an old
 *    session would snap it back to that stale slot — e.g. index 0 if it was
 *    the very first session — jumping it ahead of tabs the user has open
 *    now instead of appending after them.
 */
function reorderOnArrival(
  order: SessionId[],
  id: SessionId,
  present: boolean,
  wasTab: boolean,
  wasPreview: boolean,
  tabs: ShellState['tabs'],
): SessionId[] {
  if (!present) return [...order, id]
  const becameTab = !wasTab && !wasPreview && tabs[id] === true
  if (!becameTab) return order
  return moveToEnd(order, id)
}

/** Every descriptor in the roster (arrival order) — the Sidebar's live∪restorable source. */
export function selectSessions(state: ShellState): SessionDescriptor[] {
  return state.order.map(id => state.byId[id]).filter(isDescriptor)
}

/**
 * The sessions the TabBar renders (arrival order) — the run-local tab set
 * (P3-5a/5b). A cleanly-closed row (`restorable` + `exited`) leaves the bar and
 * surfaces in the Sidebar's restore-offer instead; a CRASHED session
 * (`restorable` + `disconnected` — the P3-5b kill/close parity descriptor)
 * keeps its tab so restart-in-place stays reachable, while the same row is
 * simultaneously the Sidebar's crashed restore-offer. Membership is the
 * event-history `tabs` set, NOT `!restorable`: a crashed row hydrated from a
 * previous run is an offer only (its restart tombstone died with that run).
 * The row stays in the roster either way; only this projection is narrowed.
 */
export function selectLiveSessions(state: ShellState): SessionDescriptor[] {
  return selectSessions(state).filter(
    descriptor => state.tabs[descriptor.appSessionId] === true,
  )
}

/** Pane/TabBar roster: running tabs plus dead sessions opened as previews. */
export function selectPaneSessions(state: ShellState): SessionDescriptor[] {
  return selectSessions(state).filter(descriptor => {
    const id = descriptor.appSessionId
    return state.tabs[id] === true || state.previews[id] === true
  })
}

/**
 * The active id after the pane roster changes. Live tabs and cached previews are
 * both valid focus owners; only a close/reap that removes the active id moves
 * focus to the immediately preceding open tab, or the next tab when there is no
 * preceding one.
 */
export function activeAfterPaneChange(
  current: SessionId | null,
  paneOrder: readonly SessionId[],
  openOrder: readonly SessionId[] = paneOrder,
): SessionId | null {
  if (current === null) return null
  if (paneOrder.includes(current)) return current

  const openIndex = openOrder.indexOf(current)
  if (openIndex >= 0) {
    const remaining = new Set(paneOrder)
    for (let index = openIndex - 1; index >= 0; index -= 1) {
      const candidate = openOrder[index]
      if (candidate !== undefined && remaining.has(candidate)) return candidate
    }
    for (let index = openIndex + 1; index < openOrder.length; index += 1) {
      const candidate = openOrder[index]
      if (candidate !== undefined && remaining.has(candidate)) return candidate
    }
  }

  return paneOrder[0] ?? null
}

/**
 * One session by id. Its last production caller left with the creation seam
 * (2026-09-05); it stays as this module's read API beside `selectSessions`,
 * because the alternative is reducer tests reaching into `byId` directly.
 */
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
 * The tab a ⌘<n> jump targets: 1-based index into the visible TAB order (the
 * run-local `tabs` projection the TabBar renders and numbers its ⌘n hints by),
 * or null if that slot is empty. Indexing the full roster instead would let a
 * hydrated restorable-only row (a Sidebar offer, not a tab) absorb a slot and
 * shift every hint off by one. ⌘1..9 map to slots 1..9 (slot 9 is the LAST tab
 * in the prototype's convention when there are ≥9; here we keep the literal
 * 1..9 → index 0..8 mapping, matching a plain tab-order jump).
 */
export function sessionAtSlot(
  state: ShellState,
  slot: number,
): SessionId | null {
  if (slot < 1 || slot > 9) return null
  return selectPaneSessions(state)[slot - 1]?.appSessionId ?? null
}
