import type { ReadyFrame } from '../../shared/protocol.js'

export function isAppReadyFrame(frame: unknown): frame is ReadyFrame {
  if (typeof frame !== 'object' || frame === null) return false
  const candidate = frame as {
    kind?: unknown
    payload?: { type?: unknown }
  }
  return (
    candidate.kind === 'ready' &&
    typeof candidate.payload === 'object' &&
    candidate.payload !== null &&
    candidate.payload.type === 'app.ready'
  )
}
