/**
 * The desktop app's own picture of the window an agent is driving through computer use.
 * The renderer names an app; main resolves its window, captures only that window, and
 * returns a bounded JPEG. Pictures are display-only and never reach a model prompt.
 */
export type ComputerWindowCaptureRequest = { app: string }

/** 16 by 12 grayscale samples, row-major, 0-255: enough to tell whether the screen changed. */
export const COMPUTER_CAPTURE_FINGERPRINT_LENGTH = 192

export type ComputerWindowCapture =
  | { status: 'captured'; dataUrl: string; fingerprint: number[] }
  /** Screen Recording is not granted to the desktop app. */
  | { status: 'denied' }
  /** Not macOS, no matching window, capture failed, or the capturer is busy. */
  | { status: 'unavailable' }

/** An app name or bundle identifier as the agent named it; never a path or window id. */
export function parseComputerWindowCaptureRequest(value: unknown): ComputerWindowCaptureRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const request = value as Record<string, unknown>
  const keys = Object.keys(request)
  if (keys.length !== 1 || keys[0] !== 'app') return null
  const app = request.app
  if (typeof app !== 'string') return null
  const trimmed = app.trim()
  if (!trimmed || trimmed.length > 256 || /[\u0000-\u001f\u007f/]/.test(trimmed)) return null
  return { app: trimmed }
}
