/**
 * Sidebar workspace-group ORDER — an operator-authored ordering of the left
 * rail's workspace headers (`CAT-CODE`, `PTCLOVE/APP`, …), persisted so it
 * survives a relaunch. Operator request, 2026-07-26: "the workspace on left side
 * bar should be draggable to reorder the order of workspace".
 *
 * ➕ real-added: the prototype's sidebar has no workspace reordering at all (its
 * only drag is a SESSION dragged into a split pane, `Sidebar.jsx:246`), so this
 * is not parity work and nothing here has a prototype anchor to match.
 *
 * SIDEBAR-ONLY, by construction. The shared `groupByWorkspace`
 * (`sessionsCatalogState.ts:508`) is deliberately used by BOTH the rail and the
 * Sessions page so the two surfaces group and label identically; its frozen
 * alphabetical `.sort()` is untouched. This module re-orders the RESULT on the
 * sidebar side of that call, so the Sessions page keeps frozen-alphabetical.
 *
 * Keyed on `cwd`, NEVER on the rendered label. The label is derived and mutable:
 * `disambiguateWorkspaceLabels` widens `APP` into `CAT-CODE/APP` the moment a
 * second workspace shares its basename (CC-14/CC-15, `sessionsCatalogState.ts:449`),
 * so an order keyed on the label would scramble itself when an unrelated
 * workspace is opened.
 *
 * Warp-free (CC-2, `Sidebar.tsx:177-183`): the order is a pure function of the
 * persisted list plus the group set, and never consults `activeCwd`. Selecting,
 * restoring or opening a session cannot move a group; only an explicit
 * drag/keyboard reorder can.
 *
 * Renderer-local persistence through the shared codec (`viewPreference.ts`):
 * versioned JSON under a `catcode.`-prefixed key, read/written through an
 * injectable storage, best-effort (a storage failure never touches live session
 * state). No protocol frame, no host/registry field, no preload channel — this
 * is a view preference with no engine meaning (SECURITY-MINIMUM §2).
 */

import {
  readViewPreference,
  writeViewPreference,
  type ViewPreferenceStorage,
} from './viewPreference.js'

export const SIDEBAR_WORKSPACE_ORDER_STORAGE_KEY =
  'catcode.sidebarWorkspaceOrder.v1'

/**
 * Persistence bound. The order deliberately KEEPS entries for workspaces that
 * are not currently on screen (see `selectOrderedWorkspaceGroups`), so without a
 * cap it would grow for the life of the install. The tail is the least-preferred
 * end, so truncating there costs the least. In-memory order is uncapped; the cap
 * applies at the storage boundary (read and write).
 */
export const MAX_SIDEBAR_WORKSPACE_ORDER_ENTRIES = 64

/**
 * The drag payload type. Lower-case because `DataTransfer.types` is lower-cased
 * by the browser and the receiving `dragover` compares against it directly.
 * Distinct from the tab→panel split's `text/sessionId` (`TabBar.tsx:265`), so a
 * workspace drag never lights up `WorkspacePanels`' drop edges and vice versa.
 */
export const WORKSPACE_ORDER_DRAG_MIME = 'text/workspace-cwd'

/** Preferred workspace cwds, most-preferred first. */
export type WorkspaceOrder = readonly string[]

/** Which side of the hovered group the dragged group would land on. */
export type WorkspaceDropEdge = 'before' | 'after'

export function createWorkspaceOrder(): WorkspaceOrder {
  return []
}

/**
 * A cwd that can carry a rank. The "Unknown workspace" bucket
 * (`cwd === ''`, `sessionsCatalogState.ts:524`) is excluded everywhere: it is not
 * a workspace but a catch-all for transcripts whose workspace could not be
 * reconciled (MAJOR-1), its membership churns, and `''` is a fragile persisted
 * key. It is pinned LAST instead of ranked.
 */
function isRankableCwd(cwd: string): boolean {
  return cwd.trim().length > 0
}

/** Drop blanks and duplicates, preserving first-seen order. */
function dedupeCwds(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const cwd of values) {
    if (!isRankableCwd(cwd) || seen.has(cwd)) continue
    seen.add(cwd)
    out.push(cwd)
  }
  return out
}

/** Storage-boundary normalization: strings only, deduped, capped. */
function normalizeWorkspaceOrder(values: readonly unknown[]): string[] {
  const strings = values.filter(
    (value): value is string => typeof value === 'string',
  )
  return dedupeCwds(strings).slice(0, MAX_SIDEBAR_WORKSPACE_ORDER_ENTRIES)
}

export function readWorkspaceOrderFromStorage(
  storage: ViewPreferenceStorage | null,
): WorkspaceOrder | null {
  return readViewPreference(
    storage,
    SIDEBAR_WORKSPACE_ORDER_STORAGE_KEY,
    'cwds',
    value => (Array.isArray(value) ? normalizeWorkspaceOrder(value) : null),
  )
}

export function writeWorkspaceOrderToStorage(
  storage: ViewPreferenceStorage | null,
  order: WorkspaceOrder,
): void {
  writeViewPreference(
    storage,
    SIDEBAR_WORKSPACE_ORDER_STORAGE_KEY,
    'cwds',
    normalizeWorkspaceOrder(order),
  )
}

/**
 * Apply the custom order to one render's workspace groups.
 *
 *  - RANKED groups (present in `order`) come first, in the stored order.
 *  - UNRANKED groups follow in the caller's incoming order — which from
 *    `groupByWorkspace` is the frozen-alphabetical one — so a workspace opened
 *    for the first time joins at the end of the ranked block instead of
 *    displacing anything the operator placed, and an empty order degrades to
 *    exactly today's alphabetical rail.
 *  - The "Unknown workspace" bucket is pinned LAST (see `isRankableCwd`).
 *
 * Order entries naming workspaces that are NOT in `groups` are simply skipped —
 * that is the normal case while the rail's search box is filtering groups in and
 * out (`Sidebar.tsx:191-204`), and it is also how a workspace keeps its rank
 * across a relaunch that has not enumerated it yet. Nothing throws and nothing
 * re-shuffles: the surviving groups keep their relative order.
 *
 * Generic over `{ cwd }` (the `selectVisibleSidebarRows` idiom) so the module
 * stays free of a `WorkspaceGroup` import and is testable on bare fixtures.
 */
export function selectOrderedWorkspaceGroups<T extends { cwd: string }>(
  groups: readonly T[],
  order: WorkspaceOrder,
): T[] {
  const rank = new Map<string, number>()
  order.forEach((cwd, index) => {
    if (!rank.has(cwd)) rank.set(cwd, index)
  })

  const ranked: T[] = []
  const unranked: T[] = []
  const unknown: T[] = []
  for (const group of groups) {
    if (!isRankableCwd(group.cwd)) unknown.push(group)
    else if (rank.has(group.cwd)) ranked.push(group)
    else unranked.push(group)
  }
  // Stable sort: two groups can only tie when `order` held a duplicate, which
  // `rank` already collapsed to its first index.
  ranked.sort(
    (a, b) => (rank.get(a.cwd) ?? 0) - (rank.get(b.cwd) ?? 0),
  )
  return [...ranked, ...unranked, ...unknown]
}

/**
 * Which side of `overCwd` the dragged `fromCwd` would land on, or `null` when
 * this is not a legal drop (same group, either group missing from the rendered
 * sequence, or either one being the un-rankable "Unknown workspace" bucket).
 *
 * Direction decides the edge: dragging DOWN lands after the hovered group,
 * dragging UP lands before it. That is the standard reorder-list feel, it needs
 * no pointer geometry (so it is fully testable headlessly), and the drop
 * indicator renders on exactly the edge this returns — the visual and the
 * semantic can never disagree.
 */
export function selectWorkspaceDropEdge(
  cwds: readonly string[],
  fromCwd: string,
  overCwd: string,
): WorkspaceDropEdge | null {
  if (fromCwd === overCwd) return null
  if (!isRankableCwd(fromCwd) || !isRankableCwd(overCwd)) return null
  const from = cwds.indexOf(fromCwd)
  const over = cwds.indexOf(overCwd)
  if (from < 0 || over < 0) return null
  return from < over ? 'after' : 'before'
}

/**
 * Move `fromCwd` onto `overCwd` and return the next order.
 *
 * `cwds` is the sequence the operator is looking at (the rendered group order),
 * and it alone decides the drop edge and the insertion point.
 *
 * `allCwds` is the UNFILTERED group sequence (defaults to `cwds`), and is what
 * gets frozen into the order: the first drag must freeze every group's current
 * position, not just the ones the search box happens to be showing. Freezing
 * only the filtered sequence would leave every hidden group unranked, and an
 * unranked group sorts BEHIND every ranked one — so reordering two search hits
 * would silently demote the untouched groups above them, permanently.
 *
 * Entries already in `order` keep their slot, INCLUDING ones not currently
 * rendered — a group hidden by the search box does not lose its rank because
 * the operator reordered two visible neighbours.
 *
 * Returns the SAME reference on a no-op so the caller can skip a state write.
 */
export function reduceWorkspaceOrderMoved(
  order: WorkspaceOrder,
  cwds: readonly string[],
  fromCwd: string,
  overCwd: string,
  allCwds: readonly string[] = cwds,
): WorkspaceOrder {
  const edge = selectWorkspaceDropEdge(cwds, fromCwd, overCwd)
  if (!edge) return order
  const covered = dedupeCwds([...order, ...allCwds, ...cwds])
  const without = covered.filter(cwd => cwd !== fromCwd)
  const at = without.indexOf(overCwd)
  if (at < 0) return order
  const insertAt = edge === 'before' ? at : at + 1
  return [
    ...without.slice(0, insertAt),
    fromCwd,
    ...without.slice(insertAt),
  ]
}

/**
 * The keyboard path (⌥↑/⌥↓ on a workspace header): move `cwd` one slot within
 * the rendered sequence, expressed as a move onto its neighbour so drag and
 * keyboard share ONE reducer. Drag-only would make the feature unreachable
 * without a pointer, and the header is already a focusable button.
 *
 * A step past either end is a no-op, and so is a step onto the "Unknown
 * workspace" bucket — which is pinned last, so a real workspace can never be
 * pushed below it.
 */
export function reduceWorkspaceOrderStepped(
  order: WorkspaceOrder,
  cwds: readonly string[],
  cwd: string,
  direction: 'up' | 'down',
  allCwds: readonly string[] = cwds,
): WorkspaceOrder {
  const index = cwds.indexOf(cwd)
  if (index < 0) return order
  const target = direction === 'up' ? index - 1 : index + 1
  if (target < 0 || target >= cwds.length) return order
  return reduceWorkspaceOrderMoved(order, cwds, cwd, cwds[target], allCwds)
}
