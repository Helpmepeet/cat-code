/**
 * Sidebar projection (P3-5b) — the FULL roster (live ∪ restorable) the left rail
 * renders, ordered by recency.
 *
 * A second projection over the SAME `ShellState` the TabBar reads. The two
 * orderings differ deliberately: the TabBar keeps arrival order so a tab never
 * jumps mid-session, while the Sidebar orders by `lastAttachedAt` so a
 * just-closed row surfaces at the top as the obvious restore candidate. Pure
 * (no React) so the descriptor → row-visual mapping is unit-testable, and it
 * reuses `TabTone` so both panels share one status vocabulary.
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
 * The rows the Sidebar renders: the full roster, ordered by `lastAttachedAt`
 * descending (most-recently touched first), ties broken by `createdAt` then id
 * for a stable order. This is `listSessions()` folded into `ShellState` already
 * (App seeds the roster from it, then keeps it live off the HostEvent stream),
 * so there is no separate poll — same event-driven source as the TabBar.
 */
export function selectSidebarRows(state: ShellState): SidebarRow[] {
  const descriptors = state.order
    .map(id => state.byId[id])
    .filter((value): value is SessionDescriptor => value !== undefined)

  return descriptors
    .slice()
    .sort(byRecency)
    .map(descriptor => ({
      descriptor,
      visual: deriveSidebarRowVisual(descriptor),
    }))
}

/**
 * Most-recently-attached first. `lastAttachedAt` is the restore-offer's recency
 * key (REGISTRY §4.4); `createdAt` and the id are deterministic tie-breakers so
 * two rows with the same attach time never reorder between renders.
 */
function byRecency(a: SessionDescriptor, b: SessionDescriptor): number {
  if (b.lastAttachedAt !== a.lastAttachedAt) {
    return b.lastAttachedAt - a.lastAttachedAt
  }
  if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt
  return a.appSessionId < b.appSessionId ? -1 : 1
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
      tone = 'dead'
      label = 'crashed'
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
