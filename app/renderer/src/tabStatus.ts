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

  let { label, tone } = sessionStatusVisual(
    descriptor.status,
    descriptor.restorable,
    true,
  )
  let restartable = false

  // IDLE-PARK — the host descriptor for a parked session is byte-identical to a
  // crash by design (decisions/IDLE-PARK.md §11: the distinction lives in the
  // registry row, so the descriptor cannot carry it), which alone would paint an
  // intentional reclaim with the danger dot and offer a Restart button for a
  // session that needs no restarting. The renderer's OWN connection snapshot is
  // where the distinction survives — it read the park exit code off the lifecycle
  // frame — so the two truth sources are fused here, exactly as the `ready` +
  // connectionDead escalation below fuses them in the other direction.
  //
  // `busy` is the tone a PREVIEW pane already uses, and for good reason: the two
  // states are the same situation reached from opposite ends — a readable
  // transcript with no engine behind it, which re-engages when the user uses it.
  // No new tone, no new colour, and nothing for the user to do.
  // Gated on the DESCRIPTOR still agreeing there is no process. The connection
  // snapshot stays `parked` until the resumed sidecar's `ready` frame, but the
  // host reports `spawning` as soon as the restore starts, so without this gate
  // an unpark would paint `idle` for the several seconds of a real engine boot
  // and swallow the `starting` signal. The host descriptor is the authority on
  // liveness; the connection snapshot is only the authority on WHY it died.
  // `restorable` is the third gate, and it is the honesty one. A session parked
  // before it ever ran a turn has no transcript on disk (the engine writes one on
  // the first message), so it can never be brought back — `canResume` refuses it
  // and both restore and restart fail. Presenting that as a resting `idle` tab
  // with no affordance would turn a visible failure into a silent one, which is
  // the opposite of the point. Such a session falls through to the honest dead
  // presentation below.
  if (
    connection.status === 'parked' &&
    descriptor.status !== 'spawning' &&
    descriptor.status !== 'ready' &&
    descriptor.restorable
  ) {
    return {
      label: 'idle',
      tone: 'busy',
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
