/**
 * P4-1 shared primitive — `ConnectionChip` (Surfaces.jsx:1149-1194).
 *
 * Renders the REAL per-session connection state from the P3-4 reducer
 * (connectionState.ts `ConnectionSnapshot`) — NOT a demo simulator. The
 * `ConnectionDemoBar` and its `MOCK_CONNECTION` state machine are CUT (INVENTORY
 * CUT list); this chip reads the same `selectConnection(...)` snapshot the
 * TabBar and SessionPane already read.
 *
 * `CONN_STATES` is kept as the prototype's VISUAL vocabulary (label tone + dot
 * style); `mapConnectionToChip` folds the richer real status set onto it. The
 * chip is HIDDEN when the session is healthy (`ready`) — a quiet-until-wrong
 * signal, matching the prototype (Surfaces.jsx:1167).
 *
 * Divergence from the prototype (flagged): the real transport has no
 * auto-reconnect/backoff — `connecting`/`starting` are one-shot spawn states
 * (shown as a pulsing "connecting"/"starting"), and `disconnected`/`dead`/
 * `failed`/`exited` are terminal-restartable, so "retry" here means restart the
 * sidecar (the caller wires `onRetry` → `bridge.restart`). No `Ns` backoff
 * countdown exists to show.
 */

import type { ReactNode } from 'react'
import type { ConnectionSnapshot } from './connectionState.js'
import { toneClasses, type Tone } from './tone.js'

/** The prototype's 4-state visual grammar (Surfaces.jsx:1150-1155). */
export type ConnChipVisual =
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'reconnect_failed'

type DotStyle = 'solid' | 'pulse' | 'ring'

export const CONN_STATES: Record<
  ConnChipVisual,
  { tone: Tone; dot: DotStyle }
> = {
  connected: { tone: 'good', dot: 'solid' },
  reconnecting: { tone: 'warn', dot: 'pulse' },
  disconnected: { tone: 'danger', dot: 'ring' },
  reconnect_failed: { tone: 'danger', dot: 'ring' },
}

export type ConnectionChipModel = {
  visual: ConnChipVisual
  /** Honest label carried from the REAL status (not flattened to 4 words). */
  label: string
  /** Whether a restart affordance applies (terminal states). */
  canRetry: boolean
}

/**
 * Fold the real `ConnectionSnapshot.status` onto the visual grammar. Returns
 * `null` when the session is healthy (`ready`) so the caller hides the chip.
 */
export function mapConnectionToChip(
  connection: ConnectionSnapshot,
): ConnectionChipModel | null {
  switch (connection.status) {
    case 'ready':
      return null
    case 'connecting':
      return { visual: 'reconnecting', label: 'connecting', canRetry: false }
    case 'starting':
      return { visual: 'reconnecting', label: 'starting', canRetry: false }
    case 'disconnected':
      return { visual: 'disconnected', label: 'disconnected', canRetry: true }
    case 'dead':
      return { visual: 'reconnect_failed', label: 'dead', canRetry: true }
    case 'failed':
      return { visual: 'reconnect_failed', label: 'failed', canRetry: true }
    case 'exited':
      return { visual: 'reconnect_failed', label: 'exited', canRetry: true }
    default:
      // Wire drift: an unknown status still surfaces as a restartable failure
      // rather than vanishing or crashing.
      return {
        visual: 'reconnect_failed',
        label: String(connection.status),
        canRetry: true,
      }
  }
}

export function ConnectionChip({
  connection,
  onRetry,
}: {
  connection: ConnectionSnapshot
  onRetry?: () => void
}): ReactNode {
  const model = mapConnectionToChip(connection)
  if (!model) return null
  const t = toneClasses(CONN_STATES[model.visual].tone)
  const clickable = model.canRetry && Boolean(onRetry)
  return (
    <button
      type="button"
      onClick={clickable ? onRetry : undefined}
      aria-disabled={!clickable}
      className={
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 py-[3px] font-mono text-[11px] font-medium transition-colors ' +
        `${t.text} ${t.softBg} ${t.softBorder} ` +
        (clickable ? 'cursor-pointer hover:brightness-125' : 'cursor-default')
      }
    >
      <ConnDot visual={model.visual} />
      {model.label}
      {clickable ? <span className="text-[10px] opacity-70">· retry</span> : null}
    </button>
  )
}

function ConnDot({ visual }: { visual: ConnChipVisual }): ReactNode {
  const meta = CONN_STATES[visual]
  const t = toneClasses(meta.tone)
  if (meta.dot === 'ring') {
    return (
      <span
        className={`box-border h-1.5 w-1.5 shrink-0 rounded-full border-[1.5px] ${t.border}`}
        aria-hidden="true"
      />
    )
  }
  return (
    <span
      className={
        `h-1.5 w-1.5 shrink-0 rounded-full ${t.dot} ` +
        (meta.dot === 'pulse' ? 'animate-pulse' : '')
      }
      aria-hidden="true"
    />
  )
}
