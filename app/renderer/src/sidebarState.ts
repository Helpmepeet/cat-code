/**
 * Sidebar projection (P3-5b, order corrected to prototype parity) — the FULL
 * roster (live ∪ restorable) the left rail renders, in stable arrival order —
 * the SAME order the TabBar uses, not a recency sort.
 *
 * An earlier version of this projection sorted every row by `lastAttachedAt`
 * descending on every render, on the theory that a just-closed/just-restored
 * row should surface at the top as the obvious restore candidate. The
 * prototype does not actually do this: `Sidebar.jsx`'s `groupByWorkspace` only
 * ever sorts the GROUPS (current-workspace-first, then alphabetical); rows
 * within a group keep whatever order they arrive in and are never re-sorted
 * by an interaction. (Proof in the prototype's own mock data — `data.js`'s
 * `s-phase1a` entry, "13h" old, sits at the END of the `cat-code` group, after
 * "Yesterday"-old entries, which only makes sense if nothing re-sorts by
 * recency within a group.) The recency sort meant restoring a session visibly
 * jumped its row to the top of its group instead of settling into a stable
 * spot — surprising in actual use. `lastAttachedAt` still drives the row's
 * displayed recency text (`Sidebar.tsx`'s `formatRecency`); it no longer
 * drives row ORDER.
 *
 * Pure (no React) so the descriptor → row-visual mapping is unit-testable,
 * and it reuses `TabTone` so both panels share one status vocabulary.
 */

import type { SessionDescriptor } from '../../shared/hostApi.js'
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

export function selectSidebarRows(state: ShellState): SidebarRow[] {
  return state.order
    .map(id => state.byId[id])
    .filter((value): value is SessionDescriptor => value !== undefined)
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
