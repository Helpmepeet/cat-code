import {
  MAX_DIAGNOSTIC_FRAMES_PER_WINDOW,
  MAX_FRAME_BYTES,
  MAX_FRAMES_PER_WINDOW,
  RATE_WINDOW_MS,
} from '../shared/limits.js'

/**
 * `diagnostics` is automatic, high-volume traffic whose rate follows engine
 * output rather than user intent, and whose loss costs evidence only. It is
 * bounded below the total so it can never consume the whole window.
 * `control` is anything a user is waiting on. Default, and deliberately NOT
 * sub-capped: with a quiet window it may use the full allowance.
 * See `docs/migration/decisions/IPC-RATE-BUDGET.md` §4 for why the fault
 * reporter and the health response are control rather than diagnostics.
 */
export type RendererIpcClass = 'control' | 'diagnostics'

/**
 * Why a payload was refused. `rate` clears on its own when the window rolls;
 * the other two are properties of the payload and will refuse identically
 * forever, so a caller that retries must be able to tell them apart or it spins.
 */
export type RendererIpcRejectionReason = 'serialization' | 'size' | 'rate'

export class RendererIpcRejection extends Error {
  readonly reason: RendererIpcRejectionReason
  constructor(message: string, reason: RendererIpcRejectionReason) {
    super(message)
    this.name = 'RendererIpcRejection'
    this.reason = reason
  }
}

export type RendererIpcGuard = {
  assertAllowed(payload: unknown, kind?: RendererIpcClass): void
}

export function createRendererIpcGuard({
  now = Date.now,
}: {
  now?: () => number
} = {}): RendererIpcGuard {
  let windowStart = now()
  let frameCount = 0
  let diagnosticFrameCount = 0

  return {
    assertAllowed(payload: unknown, kind: RendererIpcClass = 'control'): void {
      let serialized: string | undefined
      try {
        serialized = JSON.stringify(payload)
      } catch {
        throw new RendererIpcRejection('renderer IPC payload is not serializable', 'serialization')
      }
      if (serialized === undefined) {
        throw new RendererIpcRejection('renderer IPC payload is not serializable', 'serialization')
      }
      if (new TextEncoder().encode(serialized).byteLength > MAX_FRAME_BYTES) {
        throw new RendererIpcRejection(`renderer IPC payload exceeds ${MAX_FRAME_BYTES} bytes`, 'size')
      }

      const currentTime = now()
      if (currentTime < windowStart || currentTime - windowStart >= RATE_WINDOW_MS) {
        windowStart = currentTime
        frameCount = 0
        diagnosticFrameCount = 0
      }
      // The total is checked for BOTH classes and never rises, so the flood
      // bound is exactly what it was. The sub-cap only decides who is turned
      // away first once the window fills.
      if (frameCount >= MAX_FRAMES_PER_WINDOW) {
        throw new RendererIpcRejection(
          `renderer IPC rate exceeds ${MAX_FRAMES_PER_WINDOW} frames per ${RATE_WINDOW_MS}ms`,
          'rate',
        )
      }
      if (kind === 'diagnostics' && diagnosticFrameCount >= MAX_DIAGNOSTIC_FRAMES_PER_WINDOW) {
        throw new RendererIpcRejection(
          `renderer IPC diagnostics rate exceeds ${MAX_DIAGNOSTIC_FRAMES_PER_WINDOW} frames per ${RATE_WINDOW_MS}ms`,
          'rate',
        )
      }
      if (kind === 'diagnostics') diagnosticFrameCount++
      frameCount++
    },
  }
}
