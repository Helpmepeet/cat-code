/**
 * Sidebar SESSION order — an operator-authored ordering of the session rows
 * INSIDE one workspace group, persisted so it survives a relaunch. Operator
 * request, 2026-08-01: "we can drag the session in the claude design but still
 * cant in app" (design source `components/sidebar/index.html`, whose rows move
 * within their own list).
 *
 * A session's project is its `cwd`, not a container, so the order is namespaced
 * BY cwd and a cross-project drop is refused rather than faked — moving a
 * session between projects would mean moving its working directory.
 *
 * ── How this coexists with CC-2 float-to-top ────────────────────────────────
 * The rail's default order is activity (`sidebarState.ts`: a row rises only when
 * its session SENDS a message). A manual order and an activity order cannot both
 * decide the same row, so they are given disjoint jobs:
 *
 *  - RANKED rows — ones the operator has arranged — hold their stored slots.
 *    Sending a message no longer floats them; that is the whole point of having
 *    dragged them.
 *  - UNRANKED rows come FIRST, in the caller's incoming (activity) order. A
 *    brand-new session therefore appears at the TOP of a hand-arranged group
 *    rather than buried under the shelf, and it stays there until the operator
 *    either drags it (which ranks it) or ignores it.
 *  - A group nobody has dragged has no ranked rows at all, so it is exactly
 *    today's activity order. The feature is invisible until it is used.
 *
 * The first drag in a group FREEZES that group's whole current sequence, not
 * just the two rows involved (`allIds`) — otherwise every untouched row would be
 * left unranked and would jump above the arrangement the operator just made.
 *
 * Keyed on `MergedSessionRow.sessionId` — the ENGINE id both a registry row and
 * a terminal-history row carry — so a terminal session is draggable too, and a
 * registry row keeps its slot across a restore that mints a new app id.
 *
 * Renderer-local persistence, the `sidebarWorkspaceOrder.ts` idiom verbatim:
 * versioned JSON under a `catcode.`-prefixed key, read/written through an
 * injectable `Pick<Storage, …>`, best-effort. No protocol frame, no registry
 * field, no preload channel — a view preference with no engine meaning
 * (SECURITY-MINIMUM §2).
 */

export const SIDEBAR_SESSION_ORDER_STORAGE_KEY =
  'catcode.sidebarSessionOrder.v1'

/** Persistence bounds. The order KEEPS entries for rows not currently on screen
 * (that is how a slot survives a relaunch that has not enumerated a transcript
 * yet), so both axes need a cap or the record grows for the life of the install.
 * The tail is the least-preferred end on both. In-memory it is uncapped; the cap
 * applies at the storage boundary. */
export const MAX_SIDEBAR_ORDERED_WORKSPACES = 32
export const MAX_SIDEBAR_ORDERED_SESSIONS_PER_WORKSPACE = 64

/**
 * The drag payload type. Lower-case because `DataTransfer.types` is lower-cased
 * by the browser. Distinct from the workspace header drag
 * (`text/workspace-cwd`), the Pinned-section drag (`text/pinned-session-id`) and
 * the tab→panel split's `text/sessionId`, so none of the four ever lights up
 * another's drop edges.
 */
export const SESSION_ORDER_DRAG_MIME = 'text/sidebar-session-id'

/** Preferred session ids per workspace cwd, most-preferred first. */
export type SessionOrder = Readonly<Record<string, readonly string[]>>

/** Which side of the hovered row the dragged row would land on. */
export type SessionDropEdge = 'before' | 'after'

type OrderStorage = Pick<Storage, 'getItem' | 'setItem'>

type PersistedSessionOrder = {
  version: 1
  byWorkspace: Record<string, string[]>
}

export function createSessionOrder(): SessionOrder {
  return {}
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

/**
 * A cwd that can carry an order. The "Unknown workspace" bucket (`cwd === ''`,
 * `sessionsCatalogState.ts`) is excluded: it is not a workspace but a catch-all
 * for transcripts whose workspace could not be reconciled (MAJOR-1), its
 * membership churns, and `''` is a fragile persisted key.
 */
function isOrderableCwd(cwd: string): boolean {
  return cwd.trim().length > 0
}

/** Storage-boundary normalization: string keys and values only, deduped, capped
 * on both axes. */
function normalizeSessionOrder(
  value: Record<string, unknown>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  let workspaces = 0
  for (const [cwd, ids] of Object.entries(value)) {
    if (!isOrderableCwd(cwd) || !Array.isArray(ids)) continue
    if (workspaces >= MAX_SIDEBAR_ORDERED_WORKSPACES) break
    const strings = ids.filter(
      (id): id is string => typeof id === 'string',
    )
    const cleaned = dedupeIds(strings).slice(
      0,
      MAX_SIDEBAR_ORDERED_SESSIONS_PER_WORKSPACE,
    )
    if (cleaned.length === 0) continue
    out[cwd] = cleaned
    workspaces += 1
  }
  return out
}

export function readSessionOrderFromStorage(
  storage: OrderStorage | null,
): SessionOrder | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(SIDEBAR_SESSION_ORDER_STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<PersistedSessionOrder>
    if (value.version !== 1) return null
    const byWorkspace = value.byWorkspace
    if (
      typeof byWorkspace !== 'object' ||
      byWorkspace === null ||
      Array.isArray(byWorkspace)
    ) {
      return null
    }
    return normalizeSessionOrder(byWorkspace as Record<string, unknown>)
  } catch {
    return null
  }
}

export function writeSessionOrderToStorage(
  storage: OrderStorage | null,
  order: SessionOrder,
): void {
  if (!storage) return
  try {
    const value: PersistedSessionOrder = {
      version: 1,
      byWorkspace: normalizeSessionOrder(order as Record<string, unknown>),
    }
    storage.setItem(SIDEBAR_SESSION_ORDER_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // View persistence is best-effort; a storage failure must never affect live
    // session state (`sidebarWorkspaceOrder.ts:133`).
  }
}

/**
 * Apply one workspace's custom order to its rows for a render.
 *
 * Unranked rows first (the caller's activity order), then the ranked block in
 * its stored order — see the module header for why round that way. Order entries
 * naming rows that are not present are skipped, which is the normal case while
 * the rail's search box is filtering and is also how a row keeps its slot across
 * a relaunch that has not enumerated its transcript yet.
 *
 * Generic over `{ sessionId }` (the `selectVisibleSidebarRows` idiom) so this
 * module needs no `MergedSessionRow` import and is testable on bare fixtures.
 */
export function selectOrderedGroupRows<T extends { sessionId: string }>(
  rows: readonly T[],
  order: SessionOrder,
  cwd: string,
): T[] {
  const stored = isOrderableCwd(cwd) ? order[cwd] : undefined
  if (!stored || stored.length === 0) return [...rows]

  const rank = new Map<string, number>()
  stored.forEach((id, index) => {
    if (!rank.has(id)) rank.set(id, index)
  })

  const ranked: T[] = []
  const unranked: T[] = []
  for (const row of rows) {
    if (rank.has(row.sessionId)) ranked.push(row)
    else unranked.push(row)
  }
  // Stable sort: two rows can only tie when `stored` held a duplicate, which
  // `rank` already collapsed to its first index.
  ranked.sort(
    (a, b) => (rank.get(a.sessionId) ?? 0) - (rank.get(b.sessionId) ?? 0),
  )
  return [...unranked, ...ranked]
}

/**
 * Which side of `overId` the dragged `fromId` would land on, or `null` when this
 * is not a legal drop (same row, or either row missing from the rendered
 * sequence).
 *
 * Direction decides the edge — dragging DOWN lands after, UP lands before — the
 * rule the workspace headers and the Pinned section already use, so all three
 * reorder gestures in one rail feel identical and none needs pointer geometry to
 * be headlessly testable.
 */
export function selectSessionDropEdge(
  ids: readonly string[],
  fromId: string,
  overId: string,
): SessionDropEdge | null {
  if (fromId === overId) return null
  const from = ids.indexOf(fromId)
  const over = ids.indexOf(overId)
  if (from < 0 || over < 0) return null
  return from < over ? 'after' : 'before'
}

/**
 * Move `fromId` onto `overId` within one workspace and return the next order.
 *
 * `ids` is the sequence the operator is looking at (search filter and the
 * "Show N more" cap included) and alone decides the drop edge and insertion
 * point. `allIds` is that group's FULL row sequence (defaults to `ids`) and is
 * what gets frozen — see the module header: freezing only what is on screen
 * would leave every hidden row unranked, and an unranked row sorts ABOVE the
 * ranked block, so it would jump the arrangement the operator just made.
 *
 * A cross-project drop is impossible by construction: the caller scopes `ids` to
 * one group and passes that group's `cwd`.
 *
 * Returns the SAME reference on a no-op so the caller can skip a state write.
 */
export function reduceSessionOrderMoved(
  order: SessionOrder,
  cwd: string,
  ids: readonly string[],
  fromId: string,
  overId: string,
  allIds: readonly string[] = ids,
): SessionOrder {
  if (!isOrderableCwd(cwd)) return order
  const edge = selectSessionDropEdge(ids, fromId, overId)
  if (!edge) return order
  const covered = dedupeIds([...(order[cwd] ?? []), ...allIds, ...ids])
  const without = covered.filter(id => id !== fromId)
  const at = without.indexOf(overId)
  if (at < 0) return order
  const insertAt = edge === 'before' ? at : at + 1
  return {
    ...order,
    [cwd]: [
      ...without.slice(0, insertAt),
      fromId,
      ...without.slice(insertAt),
    ],
  }
}

/**
 * The keyboard path (⌥↑/⌥↓ on a session row): move it one slot within the
 * rendered sequence, expressed as a move onto its neighbour so drag and keyboard
 * share ONE reducer. Drag-only would make the feature unreachable without a
 * pointer, and the row is already focusable. A step past either end is a no-op.
 */
export function reduceSessionOrderStepped(
  order: SessionOrder,
  cwd: string,
  ids: readonly string[],
  sessionId: string,
  direction: 'up' | 'down',
  allIds: readonly string[] = ids,
): SessionOrder {
  const index = ids.indexOf(sessionId)
  if (index < 0) return order
  const target = direction === 'up' ? index - 1 : index + 1
  if (target < 0 || target >= ids.length) return order
  return reduceSessionOrderMoved(
    order,
    cwd,
    ids,
    sessionId,
    ids[target],
    allIds,
  )
}
