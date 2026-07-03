import {
  MAX_FRAME_BYTES,
  MAX_FRAMES_PER_WINDOW,
  RATE_WINDOW_MS,
} from '../shared/limits.js'

export type RendererIpcGuard = {
  assertAllowed(payload: unknown): void
}

export function createRendererIpcGuard({
  now = Date.now,
}: {
  now?: () => number
} = {}): RendererIpcGuard {
  let windowStart = now()
  let frameCount = 0

  return {
    assertAllowed(payload: unknown): void {
      let serialized: string | undefined
      try {
        serialized = JSON.stringify(payload)
      } catch {
        throw new Error('renderer IPC payload is not serializable')
      }
      if (serialized === undefined) {
        throw new Error('renderer IPC payload is not serializable')
      }
      if (new TextEncoder().encode(serialized).byteLength > MAX_FRAME_BYTES) {
        throw new Error(`renderer IPC payload exceeds ${MAX_FRAME_BYTES} bytes`)
      }

      const currentTime = now()
      if (currentTime - windowStart >= RATE_WINDOW_MS) {
        windowStart = currentTime
        frameCount = 0
      }
      if (frameCount >= MAX_FRAMES_PER_WINDOW) {
        throw new Error(
          `renderer IPC rate exceeds ${MAX_FRAMES_PER_WINDOW} frames per ${RATE_WINDOW_MS}ms`,
        )
      }
      frameCount++
    },
  }
}
