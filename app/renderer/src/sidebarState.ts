/**
 * Sidebar projection (CC-2 fix, 2026-07-14) — the FULL roster (live ∪
 * restorable) the left rail renders, in a STABLE order keyed on each session's
 * immutable `createdAt`.
 *
 * Why NOT `state.order` (the TabBar's order): `reorderOnArrival`
 * (`shellState.ts`) deliberately moves a session to the END of `state.order`
 * when it regains tab membership — correct for the TabBar (restoring a closed
 * session opens it as a fresh tab at the end), but the Sidebar is the PERSISTENT
 * roster, where that same move reads as the row "warping" to a new spot on every
 * restore/open (operator, 2026-07-14: hard to track the row you just clicked).
 * `createdAt` is written once on the first spawn and preserved across every
 * restart/restore (`registry.ts` `upsertOnSpawn` sets it only for a NEW row), so
 * ordering by it keeps each row FIXED regardless of clicks or restores — matching
 * the prototype, whose `groupByWorkspace` never re-sorts rows within a group by
 * any interaction (only the GROUPS reorder, current-workspace-first).
 *
 * An earlier version sorted rows by `lastAttachedAt` (recency); the prototype
 * does not, and restore bumps `lastAttachedAt`, so that ALSO jumped a restored
 * row. `lastAttachedAt` still drives the displayed recency text (`Sidebar.tsx`
 * `formatRecency`) — never row ORDER.
 *
 * Deferred (the operator's fuller CC-2 spec, 2026-07-07): float a row to the top
 * ONLY when its session SENDS a message. That needs a `lastMessageSentAt` signal
 * the data model does not carry yet (attach/restore must NOT bump it, so
 * `lastAttachedAt` cannot stand in). Until then the order is stable-by-creation,
 * which removes the warp and matches the prototype's static order.
 *
 * Pure (no React) so the descriptor → row-visual mapping is unit-testable,
 * and it reuses `TabTone` so both panels share one status vocabulary.
 */

import type { SessionDescriptor } from '../../shared/hostApi.js'
import type { SessionId } from '../../shared/protocol.js'
import type { ShellState } from './shellState.js'
import type { TabTone } from './tabStatus.js'

/**
 * A row's status kind — the ONE truth split the Sidebar draws: a row with a
 * live process vs a `restorable` one (no process, but row + transcript can be
 * re-spawned). `restorable` is the restore-offer candidate (selecting it →
 * `restoreSession`); `live` selects like a tab (reuse App's `selectTab`).
 */
export type SidebarRowKind = 'live' | 'restorable'

/**
 * The visual state of one Sidebar row, derived purely from the descriptor.
 * Reuses 5a's `TabTone` so the dot/chip idiom matches the TabBar exactly.
 */
export type SidebarRowVisual = {
  kind: SidebarRowKind
  /** Same tone families as the TabBar (P0-2 tokens); a crashed row → `dead`. */
  tone: TabTone
  /** Short status chip label, mirroring `deriveTabVisualState`'s vocabulary. */
  label: string
  /** True when the row's process is gone but it can be re-spawned. */
  restorable: boolean
}

export type SidebarRow = {
  descriptor: SessionDescriptor
  visual: SidebarRowVisual
}

/**
 * The rows the Sidebar renders: the full roster in stable arrival order (the
 * same `state.order` the TabBar reads — see the module doc for why this is
 * NOT a recency sort). This is `listSessions()` folded into `ShellState`
 * already (App seeds the roster from it, then keeps it live off the
 * HostEvent stream), so there is no separate poll — same event-driven source
 * as the TabBar.
 */
/**
 * Resolve a nav-rail click into the view to switch to, or `null` when the
 * item is disabled. Pure so `Sidebar.tsx`'s `NavItemExpanded` and
 * `NavItemRail` can BOTH route every click through the same tested logic
 * instead of a hand-maintained per-id allowlist in the `onClick` handler —
 * that allowlist (P4-REVIEW B2) omitted `'sessions'`, so the Sessions nav
 * item silently did nothing when clicked despite `enabled: true`. Disabled
 * items already short-circuit to a non-interactive button before `onClick`
 * is wired (see `Sidebar.tsx`'s `if (!item.enabled)` early return), so this
 * only needs the `enabled` flag, never a name-by-name gate that can go stale
 * when a new nav destination is added.
 */
export function resolveNavSelection<Id extends string>(item: {
  id: Id
  enabled: boolean
}): Id | null {
  return item.enabled ? item.id : null
}

export type VisibleSidebarRows = {
  /** Rows to render now. */
  visible: SidebarRow[]
  /**
   * Rows hidden behind the "Show more" toggle — 0 when expanded, under cap, OR
   * (SIDEBAR-1 boundary) the group is exactly `limit + 1` over and the sole
   * overflow row is the kept active session, so nothing is left to reveal.
   */
  hiddenCount: number
  /** Whether the group exceeds `limit` — i.e. an expanded group has a reason
   * to offer "Show less", independent of whether anything is currently hidden. */
  overLimit: boolean
}

/**
 * Which rows a workspace group shows given its "Show more" cap (a declutter
 * deviation, NOT a prototype element). Expanded, or at/under `limit`: every row.
 * Collapsed and over `limit`: the first `limit` rows PLUS the active session's
 * row if it falls in the hidden tail — so a long project list never buries the
 * session you are actually on. The head keeps the caller's stable order; a kept
 * active row is appended (it is highlighted, so its exact slot does not matter).
 */
export function selectVisibleSidebarRows(
  rows: SidebarRow[],
  activeSessionId: SessionId | null,
  limit: number,
  expanded: boolean,
): VisibleSidebarRows {
  const overLimit = rows.length > limit
  if (!overLimit || expanded) {
    return { visible: rows, hiddenCount: 0, overLimit }
  }
  const head = rows.slice(0, limit)
  const activeHidden = rows.find(
    row =>
      row.descriptor.appSessionId === activeSessionId && !head.includes(row),
  )
  const visible = activeHidden ? [...head, activeHidden] : head
  return { visible, hiddenCount: rows.length - visible.length, overLimit }
}

/**
 * SIDEBAR-2 — the React-correct state transition for a group's sticky
 * `expanded` flag: reset to collapsed the moment the group is no longer
 * `overLimit` (shrunk to/below the cap), so a later regrowth past the cap
 * starts collapsed again instead of silently reusing a stale `expanded=true`.
 * Call from a `useEffect` keyed on `overLimit` — never mutate state at render.
 */
export function normalizeSidebarGroupExpansion(
  expanded: boolean,
  overLimit: boolean,
): boolean {
  return overLimit ? expanded : false
}

/**
 * SIDEBAR-1 — gates the "Show more"/"Show less" toggle on an actual reason to
 * show it: collapsed, only when rows are truly hidden (`hiddenCount > 0` — not
 * `overLimit`, which stays true even at the boundary where every row is
 * already visible, e.g. limit+1 rows with the sole overflow row being the kept
 * active session); expanded, whenever the group is still `overLimit` so
 * "Show less" remains reachable.
 */
export function shouldShowSidebarGroupExpansionToggle(
  expanded: boolean,
  hiddenCount: number,
  overLimit: boolean,
): boolean {
  return expanded ? overLimit : hiddenCount > 0
}

export function selectSidebarRows(state: ShellState): SidebarRow[] {
  return state.order
    .map(id => state.byId[id])
    .filter((value): value is SessionDescriptor => value !== undefined)
    .slice()
    // Stable order by the immutable `createdAt` (see module doc): a click or
    // restore never moves a row, because `createdAt` never changes. Ties (same
    // creation ms) break on the immutable id so the order is fully deterministic.
    .sort((a, b) =>
      a.createdAt !== b.createdAt
        ? a.createdAt - b.createdAt
        : a.appSessionId.localeCompare(b.appSessionId),
    )
    .map(descriptor => ({
      descriptor,
      visual: deriveSidebarRowVisual(descriptor),
    }))
}

/**
 * Fold a descriptor into its Sidebar row visual. Mirrors
 * `deriveTabVisualState`'s label/tone mapping so the two panels share one
 * status vocabulary — a `restorable` exited/disconnected row is the restore
 * candidate and paints `dead` (the same tone the TabBar's dead-tab chip uses),
 * a spawning row is `warn`/starting, a live `ready` row is `live`.
 *
 * The host descriptor's `status` is authoritative here (unlike the TabBar, the
 * Sidebar has no per-session connection snapshot — it lists background sessions
 * that may never have streamed, so it reads the control-plane truth only).
 */
export function deriveSidebarRowVisual(
  descriptor: SessionDescriptor,
): SidebarRowVisual {
  // A row is a restore candidate when its process is gone but the row +
  // transcript survive. The host sets `restorable` for exactly that; a live
  // row never carries it.
  const kind: SidebarRowKind = descriptor.restorable ? 'restorable' : 'live'

  let tone: TabTone
  let label: string
  switch (descriptor.status) {
    case 'spawning':
      tone = 'warn'
      label = 'starting'
      break
    case 'ready':
      tone = 'live'
      label = 'live'
      break
    case 'disconnected':
      // `disconnected` is overloaded (hostApi.ts status doc): a crash-marked
      // DEAD row surfaces it with restorable:true, while a LIVE socket-drop
      // (F13 — child may still be alive) carries restorable:false. Only the
      // dead one is a crash; labeling the live drop "crashed" would lie.
      tone = 'dead'
      label = descriptor.restorable ? 'crashed' : 'disconnected'
      break
    case 'exited':
      tone = 'dead'
      label = 'closed'
      break
    default:
      tone = 'warn'
      label = 'unknown'
      break
  }

  return { kind, tone, label, restorable: descriptor.restorable }
}
