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
 * The independent reasons the sidebar rail stays expanded. Keeping this
 * derivation pure prevents focus entry from replacing the established pointer,
 * pin, or row-menu ownership rules.
 */
export function selectSidebarOpen({
  pinned,
  hovering,
  menuActive,
  focusWithin,
}: {
  pinned: boolean
  hovering: boolean
  menuActive: boolean
  focusWithin: boolean
}): boolean {
  return pinned || hovering || menuActive || focusWithin
}

/**
 * Preserve the identity of a focused collapsed-rail nav button across the
 * collapsed -> expanded branch replacement. Entry through the stable pin has
 * no nav id, while focus already inside an expanded rail needs no handoff.
 */
export function selectSidebarNavFocusHandoff<Id extends string>(
  sidebarOpen: boolean,
  focusedNavId: Id | null,
): Id | null {
  return sidebarOpen ? null : focusedNavId
}

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
 * Generic over the row type via an `isActive` predicate (the Sidebar calls it
 * with `MergedSessionRow`; the generic keeps the cap logic reusable and tested
 * independent of the row shape).
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

/**
 * The shell's session roster (live ∪ restorable) as raw `SessionDescriptor`s in
 * the Sidebar's activity order — the descriptor SOURCE the merge selector, the
 * workspace-trust join, the ⌘K palette, the startup transcript preload, and the
 * debug export all read (F9: the old `selectSidebarRows` also folded in a
 * per-row VISUAL, but that visual is now derived at the point of use via
 * `sessionStatusVisual`/`deriveMergedRowVisual`, so this carries only the roster
 * + ordering/hydration assumptions).
 *
 * Ordered by activity — `lastMessageSentAt` (falling back to the immutable
 * `createdAt`), DESCENDING — so the most-recently-messaged session is at the
 * top and the order matches the recency each row displays. `lastMessageSentAt`
 * never bumps on attach/open/restore (CC-2, `host.ts`), so a row floats up ONLY
 * when its session sends a message — no warp on click/restore. Ties break on the
 * immutable id for a fully deterministic order. This is `listSessions()` folded
 * into `ShellState` already (no separate poll — the same HostEvent-driven source
 * as the TabBar).
 */
export function selectShellDescriptors(state: ShellState): SessionDescriptor[] {
  return state.order
    .map(id => state.byId[id])
    .filter((value): value is SessionDescriptor => value !== undefined)
    .slice()
    .sort((a, b) => {
      const at = a.lastMessageSentAt ?? a.createdAt
      const bt = b.lastMessageSentAt ?? b.createdAt
      return at !== bt ? bt - at : a.appSessionId.localeCompare(b.appSessionId)
    })
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
 * the shared `sessionStatusVisual` vocabulary (live/starting/crashed/closed/
 * disconnected), so every surface reads live/restorable state identically. A
 * history row paints a subdued `history` chip and is
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
    // A resolvable, still-EXISTING cwd makes a history row openable (Part-A host
    // path). An empty-cwd row degrades to a non-interactive `none` intent
    // (browse-only); a dead-cwd row (workspace gone from disk — bug-sweep #1) is
    // likewise non-openable, so it never presents a button that fails
    // `invalid_cwd` only on click. (`isSidebarVisibleRow` also hides it from the
    // rail; the Sessions page still lists it as browse-only.)
    const openable = row.cwd.trim().length > 0 && row.cwdExists
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
 * Whether a merged row belongs in the sidebar RAIL (bug-sweep #1, operator ruling
 * 2026-07-21: HIDE dead-workspace rows, don't delete them). The pre-fix rail
 * showed every history row whose cwd was merely non-empty, so the ~40 stale
 * test/eval transcripts pointing at ephemeral temp dirs rendered as clickable
 * rows that failed `invalid_cwd` on open. This drops a history row whose recorded
 * workspace no longer exists on disk (`cwdExists === false`).
 *
 * Kept visible: every REGISTRY row (addressed by appSessionId, not cwd — always
 * openable/visible), and every EMPTY-cwd "Unknown workspace" history row (a
 * transcript whose workspace couldn't be reconciled — MAJOR-1 — which is
 * intentionally browse-only, not dead). Non-destructive + self-healing: the
 * transcript stays on disk (still on the Sessions page, which lists everything),
 * and the row reappears if its workspace ever returns, since `cwdExists` is
 * re-derived each catalog run.
 */
export function isSidebarVisibleRow(row: MergedSessionRow): boolean {
  if (row.inRegistry) return true
  if (row.cwd.trim().length === 0) return true
  return row.cwdExists
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
 * key so the order is fully deterministic (matches `selectShellDescriptors`). */
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
