/**
 * Sidebar PINNED sessions — the operator's own short list of sessions, surfaced
 * in a "Pinned" section above the project groups (design prototype
 * `components/sidebar/index.html`, 2026-08-01: "New chat, a Pinned section, and
 * a Projects section").
 *
 * A pinned session is LIFTED, not copied: it renders once, in the Pinned
 * section, and is filtered out of its project group (the prototype's
 * `visibleRows` does the same — "Pinned sessions are surfaced above, not
 * duplicated inside their project"). So the pin set is a partition of the
 * roster, not an overlay on it.
 *
 * Keyed on `MergedSessionRow.sessionId` — the ENGINE session id, which is the
 * merge key both a registry row and a terminal-history row carry
 * (`sessionsCatalogState.ts`). Never `appSessionId`: a history row has none, so
 * an app-id key would make terminal sessions unpinnable, and the two identities
 * are joined on exactly this field anyway.
 *
 * Pin ORDER is manual and is the whole point: the Pinned section is the one
 * place in the rail where the operator, not activity, decides the sequence. It
 * therefore does NOT go through the CC-2 activity sort (`sidebarState.ts`),
 * which still owns every project group.
 *
 * Renderer-local persistence, the `sidebarWorkspaceOrder.ts` idiom verbatim:
 * versioned JSON under a `catcode.`-prefixed key, read/written through an
 * injectable `Pick<Storage, …>`, best-effort. No protocol frame, no registry
 * field, no preload channel — a view preference with no engine meaning
 * (SECURITY-MINIMUM §2).
 */

export const SIDEBAR_PINNED_SESSIONS_STORAGE_KEY =
  'catcode.sidebarPinnedSessions.v1'

/**
 * Persistence bound. The list deliberately KEEPS keys for sessions that are not
 * currently enumerated (a pinned session whose transcript has not been read yet
 * must not lose its pin), so without a cap it would grow for the life of the
 * install. The tail is the least-preferred end, so truncating there costs least.
 * In-memory the list is uncapped; the cap applies at the storage boundary.
 */
export const MAX_SIDEBAR_PINNED_SESSIONS = 32

/**
 * The drag payload type for reordering within the Pinned section. Lower-case
 * because `DataTransfer.types` is lower-cased by the browser. Distinct from the
 * workspace drag (`text/workspace-cwd`) and the tab→panel split's
 * `text/sessionId`, so the three drags never light up each other's drop edges.
 */
export const PINNED_SESSION_DRAG_MIME = 'text/pinned-session-id'

/** Pinned session merge keys, most-preferred first. */
export type PinnedSessions = readonly string[]

/** Which side of the hovered pinned row the dragged row would land on. */
export type PinnedDropEdge = 'before' | 'after'

type PinnedStorage = Pick<Storage, 'getItem' | 'setItem'>

type PersistedPinnedSessions = {
  version: 1
  sessionIds: string[]
}

export function createPinnedSessions(): PinnedSessions {
  return []
}

/** Drop blanks and duplicates, preserving first-seen order. */
function dedupeIds(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of values) {
    if (id.trim().length === 0 || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** Storage-boundary normalization: strings only, deduped, capped. */
function normalizePinnedSessions(values: readonly unknown[]): string[] {
  const strings = values.filter(
    (value): value is string => typeof value === 'string',
  )
  return dedupeIds(strings).slice(0, MAX_SIDEBAR_PINNED_SESSIONS)
}

export function readPinnedSessionsFromStorage(
  storage: PinnedStorage | null,
): PinnedSessions | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(SIDEBAR_PINNED_SESSIONS_STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<PersistedPinnedSessions>
    if (value.version !== 1 || !Array.isArray(value.sessionIds)) return null
    return normalizePinnedSessions(value.sessionIds)
  } catch {
    return null
  }
}

export function writePinnedSessionsToStorage(
  storage: PinnedStorage | null,
  pinned: PinnedSessions,
): void {
  if (!storage) return
  try {
    const value: PersistedPinnedSessions = {
      version: 1,
      sessionIds: normalizePinnedSessions(pinned),
    }
    storage.setItem(
      SIDEBAR_PINNED_SESSIONS_STORAGE_KEY,
      JSON.stringify(value),
    )
  } catch {
    // View persistence is best-effort; a storage failure must never affect live
    // session state (`sidebarWorkspaceOrder.ts:133`).
  }
}

export function isSessionPinned(
  pinned: PinnedSessions,
  sessionId: string,
): boolean {
  return pinned.includes(sessionId)
}

/**
 * Toggle one session's pin. A NEW pin lands at the END of the list, so pinning
 * something never displaces the order the operator already arranged above it.
 * Returns the SAME reference on a no-op so the caller can skip a state write.
 */
export function reducePinnedSessionsToggled(
  pinned: PinnedSessions,
  sessionId: string,
): PinnedSessions {
  if (sessionId.trim().length === 0) return pinned
  if (pinned.includes(sessionId)) {
    return pinned.filter(id => id !== sessionId)
  }
  return [...pinned, sessionId]
}

/**
 * The pinned rows for one render, in PIN order (not activity order).
 *
 * Pin entries naming sessions that are not in `rows` are skipped — the normal
 * case while the rail's search box is filtering, and also how a pin survives a
 * relaunch that has not enumerated that transcript yet.
 *
 * Generic over `{ sessionId }` (the `selectVisibleSidebarRows` idiom) so this
 * module needs no `MergedSessionRow` import and is testable on bare fixtures.
 */
export function selectPinnedRows<T extends { sessionId: string }>(
  rows: readonly T[],
  pinned: PinnedSessions,
): T[] {
  const byId = new Map<string, T>()
  for (const row of rows) {
    if (!byId.has(row.sessionId)) byId.set(row.sessionId, row)
  }
  const out: T[] = []
  for (const id of pinned) {
    const row = byId.get(id)
    if (row) out.push(row)
  }
  return out
}

/** The rows that are NOT pinned, in the caller's incoming order. A pinned row is
 * lifted out of its project group rather than shown twice. */
export function selectUnpinnedRows<T extends { sessionId: string }>(
  rows: readonly T[],
  pinned: PinnedSessions,
): T[] {
  if (pinned.length === 0) return [...rows]
  const set = new Set(pinned)
  return rows.filter(row => !set.has(row.sessionId))
}

/**
 * Which side of `overId` the dragged `fromId` would land on, or `null` when this
 * is not a legal drop (same row, or either row missing from the rendered
 * sequence).
 *
 * Direction decides the edge — dragging DOWN lands after, UP lands before — the
 * same rule the workspace headers use (`sidebarWorkspaceOrder.ts:194`), so the
 * two reorder gestures in one rail feel identical and neither needs pointer
 * geometry to be headlessly testable.
 */
export function selectPinnedDropEdge(
  ids: readonly string[],
  fromId: string,
  overId: string,
): PinnedDropEdge | null {
  if (fromId === overId) return null
  const from = ids.indexOf(fromId)
  const over = ids.indexOf(overId)
  if (from < 0 || over < 0) return null
  return from < over ? 'after' : 'before'
}

/**
 * Move `fromId` onto `overId` and return the next pin order.
 *
 * `ids` is the sequence the operator is looking at (search filter included) and
 * alone decides the drop edge. Pins hidden by the search box keep their slot:
 * the move is applied to the FULL list, only the insertion point is read off the
 * rendered one.
 *
 * Returns the SAME reference on a no-op so the caller can skip a state write.
 */
export function reducePinnedSessionsMoved(
  pinned: PinnedSessions,
  ids: readonly string[],
  fromId: string,
  overId: string,
): PinnedSessions {
  const edge = selectPinnedDropEdge(ids, fromId, overId)
  if (!edge) return pinned
  if (!pinned.includes(fromId) || !pinned.includes(overId)) return pinned
  const without = pinned.filter(id => id !== fromId)
  const at = without.indexOf(overId)
  if (at < 0) return pinned
  const insertAt = edge === 'before' ? at : at + 1
  return [...without.slice(0, insertAt), fromId, ...without.slice(insertAt)]
}

/**
 * The keyboard path (⌥↑/⌥↓ on a pinned row): move it one slot within the
 * rendered sequence, expressed as a move onto its neighbour so drag and keyboard
 * share ONE reducer — the workspace headers' arrangement
 * (`sidebarWorkspaceOrder.ts:257`). A step past either end is a no-op.
 */
export function reducePinnedSessionsStepped(
  pinned: PinnedSessions,
  ids: readonly string[],
  sessionId: string,
  direction: 'up' | 'down',
): PinnedSessions {
  const index = ids.indexOf(sessionId)
  if (index < 0) return pinned
  const target = direction === 'up' ? index - 1 : index + 1
  if (target < 0 || target >= ids.length) return pinned
  return reducePinnedSessionsMoved(pinned, ids, sessionId, ids[target])
}
