/**
 * Sidebar projection (CC-2 fix, 2026-07-14; float-to-top 2026-07-20) — the FULL
 * roster (live ∪ restorable) the left rail renders, ordered by last-message
 * activity (`lastMessageSentAt`, falling back to the immutable `createdAt`),
 * MOST-RECENT FIRST.
 *
 * Why NOT `state.order` (the TabBar's order): `reorderOnArrival`
 * (`shellState.ts`) deliberately moves a session to the END of `state.order`
 * when it regains tab membership — correct for the TabBar (restoring a closed
 * session opens it as a fresh tab at the end), but the Sidebar is the PERSISTENT
 * roster, where that same move reads as the row "warping" to a new spot on every
 * restore/open (operator, 2026-07-14: hard to track the row you just clicked).
 * The sort key `lastMessageSentAt` moves ONLY on a real message-send (never on
 * attach/open/restore — CC-2, `host.ts`), so clicks and restores keep every row
 * FIXED; only sending a message floats a row up. That is the warp-free behavior
 * the createdAt-only order was a placeholder for — matching the prototype, whose
 * `groupByWorkspace` never re-sorts rows within a group on mere interaction (only
 * the GROUPS reorder, current-workspace-first).
 *
 * An earlier version sorted rows by `lastAttachedAt` (recency) — but restore
 * bumps `lastAttachedAt`, so that jumped a restored row. The same
 * `lastMessageSentAt` now drives BOTH the displayed recency (`Sidebar.tsx`
 * `formatRecency`) and this order, so the two are consistent.
 *
 * DONE (CC-2 message-sent signal, 2026-07-19): the data model now carries
 * `lastMessageSentAt` — a persisted registry field bumped ONLY by the host's
 * `markMessageSent` on a live (non-replay) turn-end frame, never by
 * attach/restore/spawn (`registry.ts`, `host.ts onSupervisorEvent`). It drives
 * the DISPLAYED recency (above), which was the bug: merely opening a session
 * used to read "now".
 *
 * DONE (float-to-top, 2026-07-20): the operator's fuller CC-2 spec — a row floats
 * to the top ONLY when its session SENDS a message — is now the actual order
 * (descending `lastMessageSentAt`), buildable once the signal existed.
 *
 * Pure (no React) so the descriptor → row-visual mapping is unit-testable,
 * and it reuses `TabTone` so both panels share one status vocabulary.
 */

import type { SessionDescriptor } from '../../shared/hostApi.js'
import type { SessionId } from '../../shared/protocol.js'
import type { MergedSessionRow } from './sessionsCatalogState.js'
import { sessionStatusVisual } from './sessionStatusVisual.js'
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

export type VisibleRows<T> = {
  /** Rows to render now. */
  visible: T[]
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
 *
 * Generic over the row type via an `isActive` predicate so both the registry
 * `SidebarRow` and the unified `MergedSessionRow` (SESSIONS-UNIFICATION) share
 * one tested cap implementation.
 */
export function selectVisibleSidebarRows<T>(
  rows: T[],
  isActive: (row: T) => boolean,
  limit: number,
  expanded: boolean,
): VisibleRows<T> {
  const overLimit = rows.length > limit
  if (!overLimit || expanded) {
    return { visible: rows, hiddenCount: 0, overLimit }
  }
  const head = rows.slice(0, limit)
  const activeHidden = rows.find(row => isActive(row) && !head.includes(row))
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
    .sort((a, b) => {
      // Order by activity — `lastMessageSentAt` (falling back to `createdAt`),
      // DESCENDING — so the most-recently-messaged session is at the top and the
      // order matches the recency each row displays. `lastMessageSentAt` never
      // bumps on attach/open/restore (CC-2, `host.ts`), so a row floats up ONLY
      // when its session sends a message — no warp on click/restore. Ties break
      // on the immutable id for a fully deterministic order.
      const at = a.lastMessageSentAt ?? a.createdAt
      const bt = b.lastMessageSentAt ?? b.createdAt
      return at !== bt ? bt - at : a.appSessionId.localeCompare(b.appSessionId)
    })
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
  const { tone, label } = sessionStatusVisual(
    descriptor.status,
    descriptor.restorable,
    true,
  )
  return { kind, tone, label, restorable: descriptor.restorable }
}

/* ------------------------------------------------------------------------- *
 * Unified sidebar (SESSIONS-UNIFICATION — operator ruling 2026-07-20)
 *
 * The sidebar now renders the MERGED roster (desktop registry ∪ terminal
 * history), reusing `selectMergedSessionRows` (the D5-blessed shared selector —
 * no second merge). These pure helpers fold one `MergedSessionRow` into its
 * sidebar visual + click intent, and give the CC-2 warp-free activity order.
 * ------------------------------------------------------------------------- */

/** A merged sidebar row's kind — registry rows split live/restorable as before;
 * a terminal-history row (no registry) is its own kind. */
export type MergedRowKind = 'live' | 'restorable' | 'history'

/** What a click on a merged row should do. `select` focuses a live tab;
 * `restore` re-spawns a registry row; `open-history` opens a terminal session by
 * its engine id (the Part-A host path); `none` is a browse-only row whose
 * workspace is unresolvable (MAJOR-1) — clickable-looking would be a lie. */
export type MergedRowIntent = 'select' | 'restore' | 'open-history' | 'none'

export type MergedRowVisual = {
  kind: MergedRowKind
  tone: TabTone
  label: string
  /** True when a click opens something (registry rows always; history rows only
   * when their workspace is resolvable). */
  openable: boolean
  intent: MergedRowIntent
}

/**
 * Fold a merged row into its sidebar visual + click intent. Registry rows reuse
 * the exact status→tone/label vocabulary the TabBar/`deriveSidebarRowVisual`
 * use (live/starting/crashed/closed/disconnected), so live/restorable state
 * reads identically. A history row paints a subdued `history` chip and is
 * openable ONLY when it carries a resolvable cwd — an empty-cwd row degrades to
 * a non-interactive `none` intent (browse-only), never a dead-looking button.
 */
export function deriveMergedRowVisual(row: MergedSessionRow): MergedRowVisual {
  const { tone, label } = sessionStatusVisual(
    row.status,
    row.restorable,
    row.inRegistry,
  )
  if (!row.inRegistry) {
    // A resolvable cwd makes a history row openable (Part-A host path); an
    // empty-cwd row degrades to a non-interactive `none` intent (browse-only),
    // never a dead-looking button.
    const openable = row.cwd.trim().length > 0
    return {
      kind: 'history',
      tone,
      label,
      openable,
      intent: openable ? 'open-history' : 'none',
    }
  }

  const kind: MergedRowKind = row.restorable ? 'restorable' : 'live'
  return {
    kind,
    tone,
    label,
    openable: true,
    intent: row.restorable ? 'restore' : 'select',
  }
}

/**
 * The CC-2 warp-free activity key for a merged sidebar row. A row floats up ONLY
 * on a real message-send — never on open/restore, which bump `lastAttachedAt`/
 * `modifiedAtMs`.
 *
 * Registry rows order by `lastMessageSentAt`, then by the transcript's own last
 * activity, then by `createdAtMs`. The transcript step is what keeps opening a
 * TERMINAL session warp-free: opening one mints a registry row whose `createdAt`
 * is the moment it was clicked, so falling straight through to `createdAtMs`
 * would float every opened session to the top of the sidebar without a single
 * message being sent. Its transcript activity is the real answer, and it is only
 * absent for a session created in the app and not yet enumerated — for which
 * `createdAtMs` genuinely IS the last activity.
 *
 * History rows order by their transcript mtime (a terminal session has no
 * descriptor to carry `lastMessageSentAt`).
 */
export function sidebarActivityKey(row: MergedSessionRow): number {
  return row.inRegistry
    ? row.lastMessageSentAt ?? row.transcriptActivityAtMs ?? row.createdAtMs
    : row.modifiedAtMs
}

/** Comparator: most-recent activity first, ties broken on the immutable merge
 * key so the order is fully deterministic (matches `selectSidebarRows`). */
export function compareSidebarActivity(
  a: MergedSessionRow,
  b: MergedSessionRow,
): number {
  const ak = sidebarActivityKey(a)
  const bk = sidebarActivityKey(b)
  return ak !== bk ? bk - ak : a.sessionId.localeCompare(b.sessionId)
}

/** Sort merged rows into the sidebar's warp-free activity order (does not
 * mutate the input; the shared `selectMergedSessionRows` mtime order stands for
 * the Sessions page / Welcome recents). */
export function sortSidebarSessionRows(
  rows: readonly MergedSessionRow[],
): MergedSessionRow[] {
  return [...rows].sort(compareSidebarActivity)
}
