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
import { sessionStatusVisual } from './sessionStatusVisual.js'

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
 * The status → label/tone base comes from the shared `sessionStatusVisual`
 * (audit §I.2 — one status vocabulary across every surface); this wrapper adds
 * ONLY the tab-specific parts: the connection-dead escalation (a background tab
 * whose transport already failed looks dead before the host status catches up)
 * and the dead-tab restart affordance.
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

  // IDLE-PARK — the two truth sources for "parked" are FUSED here, then handed
  // to the shared vocabulary so this surface cannot drift from the four
  // descriptor-derived ones. The host descriptor carries `parked` (§1b) and is
  // authoritative on liveness; the renderer's own connection snapshot read the
  // park exit code off the lifecycle frame and is authoritative on WHY the
  // engine went away, and it is the FASTER of the two. Either alone is enough
  // to know an engine was reclaimed rather than lost.
  //
  // Both spawning/ready gates stay: the connection snapshot holds `parked` until
  // the resumed sidecar's `ready` frame, while the host reports `spawning` the
  // moment a restore starts, so without them an unpark would paint the tab
  // resting for the several seconds of a real engine boot and swallow the
  // `starting` signal. `sessionStatusVisual` applies the third gate itself
  // (`restorable`, the §1c honesty one).
  const parked =
    (descriptor.parked || connection.status === 'parked') &&
    descriptor.status !== 'spawning' &&
    descriptor.status !== 'ready'

  let { label, tone } = sessionStatusVisual(
    descriptor.status,
    descriptor.restorable,
    true,
    parked,
  )
  let restartable = false

  // A parked tab offers nothing to restart: the user's next message brings the
  // engine back (§3a). `sessionStatusVisual` already refused the resting label
  // for an unrestorable park, so this only fires where that label was granted.
  if (parked && descriptor.restorable) {
    return {
      label,
      tone,
      restartable: false,
      needsAttention: pendingPermissionCount > 0 && !isActive,
    }
  }

  if (descriptor.status === 'ready' && connectionDead) {
    // Host still says ready, but the connection view saw a send fail — escalate.
    label = 'disconnected'
    tone = 'dead'
    restartable = true
  } else if (
    descriptor.status === 'disconnected' ||
    descriptor.status === 'exited'
  ) {
    // A terminal tab offers the dead-tab restart affordance (CH_RESTART).
    restartable = true
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
