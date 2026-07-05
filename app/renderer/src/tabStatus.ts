/**
 * Per-tab visual state (P3-5a) — the derivation behind a TabBar tab's status
 * chip, restart affordance, and background-permission badge.
 *
 * Kept as a pure function (no React, no jsdom) so the tab lifecycle → visual
 * mapping is unit-testable. It fuses the THREE truth sources the shell already
 * owns:
 *  - `SessionDescriptor.status` (host control plane: spawning/ready/
 *    disconnected/exited) — the authoritative process/transport view.
 *  - the P3-4 `connectionState` snapshot (renderer transport view incl. the
 *    typed forward-failure states dead/starting/disconnected) — a background
 *    tab whose send failed shows `dead` here before a host `session-status`
 *    lands.
 *  - the P3-4 `permissionState` pending queue — a permission request in a
 *    BACKGROUND session must be visibly signalled on its tab, never silently
 *    queued.
 *
 * The chip vocabulary is deliberately small and maps to the P0-2 tone tokens;
 * no invented status strings.
 */

import type { SessionDescriptor } from '../../shared/hostApi.js'
import type { ConnectionSnapshot } from './connectionState.js'

/** The tone a chip / dead-tab affordance paints with (P0-2 token families). */
export type TabTone = 'live' | 'busy' | 'warn' | 'dead'

export type TabVisualState = {
  /** Short chip label shown on the tab. */
  label: string
  tone: TabTone
  /** A terminal tab offers restart (CH_RESTART) — the dead-tab affordance. */
  restartable: boolean
  /**
   * A pending permission request is waiting in THIS session. On a background
   * tab this drives the attention badge; on the active tab the permission
   * surface in the pane already shows it, so the badge is suppressed there.
   */
  needsAttention: boolean
}

/**
 * Fold the descriptor + connection + attention into the tab's visual state.
 * The host descriptor status is authoritative for the label; the renderer
 * connection view escalates to `dead` when a send already failed for a
 * background tab (so a tab can look dead before the host status catches up).
 */
export function deriveTabVisualState(args: {
  descriptor: SessionDescriptor
  connection: ConnectionSnapshot
  pendingPermissionCount: number
  isActive: boolean
}): TabVisualState {
  const { descriptor, connection, pendingPermissionCount, isActive } = args

  // A background tab whose transport already reported a terminal failure looks
  // dead immediately (P3-4 typed states), even before the host emits its
  // session-status. The host descriptor remains authoritative for restart.
  const connectionDead =
    connection.status === 'dead' || connection.status === 'disconnected'

  let label: string
  let tone: TabTone
  let restartable = false

  switch (descriptor.status) {
    case 'spawning':
      label = 'starting'
      tone = 'busy'
      break
    case 'ready':
      if (connectionDead) {
        label = 'disconnected'
        tone = 'dead'
        restartable = true
      } else {
        label = 'ready'
        tone = 'live'
      }
      break
    case 'disconnected':
      label = 'disconnected'
      tone = 'dead'
      restartable = true
      break
    case 'exited':
      label = 'exited'
      tone = 'dead'
      restartable = true
      break
    default:
      label = 'unknown'
      tone = 'warn'
      break
  }

  return {
    label,
    tone,
    restartable,
    // The active tab's pane already surfaces the permission; the badge exists
    // for BACKGROUND tabs (the "never silently queued" requirement).
    needsAttention: pendingPermissionCount > 0 && !isActive,
  }
}
