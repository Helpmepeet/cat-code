/**
 * The ONE status → {label, tone} mapping every session surface shares (audit
 * §I.2 "status-mapping collapse"). It replaces FOUR drifted copies of the same
 * switch: the Sidebar rows (`deriveMergedRowVisual`), the ⌘K palette rows
 * (`commandPaletteModel`), the TabBar tab chip (`deriveTabVisualState`, now a
 * thin wrapper), and the Sessions page `StatusBadge`.
 *
 * Keyed off the host descriptor's `status` + `restorable` (the two-signal truth
 * the host emits — `app/shared/hostApi.ts:82`, produced by `host.ts:792-804` +
 * the crash-tombstone rule `host.ts:705-709`), plus `inRegistry` so a terminal-
 * history row (no registry row) paints its distinct subdued `history` chip.
 *
 * `disconnected` is overloaded (hostApi.ts status doc; F13): a crash-marked DEAD
 * row carries `restorable:true` → `crashed`, while a LIVE socket-drop carries
 * `restorable:false` → `disconnected` (the child may still be alive; labeling
 * the live drop `crashed` would lie and wrongly offer restore).
 */

import type { SessionDescriptor } from '../../shared/hostApi.js'
import type { Tone } from './tone.js'
import type { TabTone } from './tabStatus.js'

export type SessionStatusVisual = {
  /** Short status chip label, one vocabulary across every surface. */
  label: string
  /** The P0-2 tone family (the internal `TabTone`; the shared-primitive chip
   * `Tone` is derived from it via `statusChipTone`). */
  tone: TabTone
}

/**
 * Fold a session's control-plane status into its canonical chip label + tone.
 * `status` accepts the merged-row extension `'history'`, but only a row with
 * `inRegistry:false` is ever a history row, so the early return owns that case
 * and the switch only sees the four real descriptor statuses.
 */
export function sessionStatusVisual(
  status: SessionDescriptor['status'] | 'history' | 'preview',
  restorable: boolean,
  inRegistry: boolean,
): SessionStatusVisual {
  // A PREVIEWED pane (`shell.previews`, never promoted to a real tab) is a
  // shell-layout fact rather than a control-plane status, which is why it used
  // to be hand-built inline at the TabBar call site — the exact fifth drifted
  // copy this module exists to prevent. It lands here so one module owns every
  // label a session surface can print.
  if (status === 'preview') return { tone: 'busy', label: 'preview' }
  // A terminal-history row (no registry row) is a not-live session — `dead`
  // tone, but its distinct `history` label reads apart from a restorable row's
  // `closed`/`crashed` and a live row's no-chip.
  if (!inRegistry) return { tone: 'dead', label: 'history' }

  switch (status) {
    case 'spawning':
      return { tone: 'warn', label: 'starting' }
    case 'ready':
      return { tone: 'live', label: 'live' }
    case 'disconnected':
      return { tone: 'dead', label: restorable ? 'crashed' : 'disconnected' }
    case 'exited':
      return { tone: 'dead', label: 'closed' }
    default:
      // Forward-compatible fallback for an unknown host status (matches the
      // prior derivers' non-throwing default) — never an exhaustiveness trap.
      return { tone: 'warn', label: 'unknown' }
  }
}

/**
 * Map the internal `TabTone` to the shared-primitive chip `Tone` (the
 * SessionsPage `StatusBadge` idiom). The second tone system is routed through
 * this one module so no third status vocabulary is invented (audit §I.2).
 */
export function statusChipTone(tone: TabTone): Tone {
  switch (tone) {
    case 'live':
      return 'good'
    case 'busy':
      return 'info'
    case 'warn':
      return 'warn'
    case 'dead':
      return 'default'
  }
}
