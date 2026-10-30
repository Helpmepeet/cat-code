import {
  MAX_DIAGNOSTIC_FRAMES_PER_WINDOW,
  MAX_FRAME_BYTES,
  MAX_FRAMES_PER_WINDOW,
  MAX_LARGE_SUBMIT_BYTES_PER_WINDOW,
  MAX_QUESTION_REPLY_FRAME_BYTES,
  MAX_QUESTION_REPLY_BYTES_PER_WINDOW,
  MAX_SUBMIT_FRAME_BYTES,
  RATE_WINDOW_MS,
} from '../shared/limits.js'
import { isImageSubmitPrompt, validateSubmitPromptBudget } from '../shared/submitBudget.js'
import { PROTOCOL_VERSION } from '../shared/protocol.js'

/**
 * `diagnostics` is automatic, high-volume traffic whose rate follows engine
 * output rather than user intent, and whose loss costs evidence only. It is
 * bounded below the total so it can never consume the whole window.
 * `control` is anything a user is waiting on. Default, and deliberately NOT
 * sub-capped: with a quiet window it may use the full allowance.
 * `submit` additionally admits validated inline images under their own byte budget.
 * `question-reply` admits only that verb under its aggregate envelope and byte budget.
 * See `docs/migration/decisions/IPC-RATE-BUDGET.md` §4 for why the fault
 * reporter and the health response are control rather than diagnostics.
 */
export type RendererIpcClass = 'control' | 'diagnostics' | 'submit' | 'question-reply'

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
  let largeSubmitBytes = 0
  let questionReplyBytes = 0

  return {
    assertAllowed(payload: unknown, kind: RendererIpcClass = 'control'): void {
      let serialized: string | undefined
      try {
        serialized = JSON.stringify(payload)
      } catch {
        throw new RendererIpcRejection('Could not send this request. Try again.', 'serialization')
      }
      if (serialized === undefined) {
        throw new RendererIpcRejection('Could not send this request. Try again.', 'serialization')
      }
      let bytes = new TextEncoder().encode(serialized).byteLength
      let maxBytes = MAX_FRAME_BYTES
      if (kind === 'question-reply' && (payload as { verb?: { type?: unknown } })?.verb?.type === 'askUserQuestion.reply') {
        maxBytes = MAX_QUESTION_REPLY_FRAME_BYTES
        const request = payload as { sessionId?: unknown; verb: unknown }
        // Budget the actual socket envelope too, not just the shorter IPC wrapper.
        bytes = Math.max(bytes, new TextEncoder().encode(JSON.stringify({
          protocolVersion: PROTOCOL_VERSION, sessionId: request.sessionId, message: request.verb,
        })).byteLength)
      }
      if (kind === 'submit') {
        const request = payload as { prompt?: unknown }
        const problem = validateSubmitPromptBudget(request?.prompt)
        if (problem) throw new RendererIpcRejection(problem, 'size')
        if (isImageSubmitPrompt(request.prompt)) {
          maxBytes = MAX_SUBMIT_FRAME_BYTES
          const metadata = { ...request, prompt: '' }
          if (new TextEncoder().encode(JSON.stringify(metadata)).byteLength > MAX_FRAME_BYTES) {
            throw new RendererIpcRejection('This request is too large to send.', 'size')
          }
        }
      }
      if (bytes > maxBytes) {
        throw new RendererIpcRejection(
          'This request is too large. Try sending less text or fewer attachments.',
          'size',
        )
      }

      const currentTime = now()
      if (currentTime < windowStart || currentTime - windowStart >= RATE_WINDOW_MS) {
        windowStart = currentTime
        frameCount = 0
        diagnosticFrameCount = 0
        largeSubmitBytes = 0
        questionReplyBytes = 0
      }
      // The total is checked for BOTH classes and never rises, so the flood
      // bound is exactly what it was. The sub-cap only decides who is turned
      // away first once the window fills.
      if (frameCount >= MAX_FRAMES_PER_WINDOW) {
        throw new RendererIpcRejection(
          'Too many requests at once. Wait a moment and try again.',
          'rate',
        )
      }
      if (kind === 'diagnostics' && diagnosticFrameCount >= MAX_DIAGNOSTIC_FRAMES_PER_WINDOW) {
        throw new RendererIpcRejection(
          'Too many requests at once. Wait a moment and try again.',
          'rate',
        )
      }
      if (kind === 'question-reply') {
        if (questionReplyBytes + bytes > MAX_QUESTION_REPLY_BYTES_PER_WINDOW) {
          throw new RendererIpcRejection('Too many requests at once. Wait a moment and try again.', 'rate')
        }
        questionReplyBytes += bytes
      } else if (bytes > MAX_FRAME_BYTES) {
        if (largeSubmitBytes + bytes > MAX_LARGE_SUBMIT_BYTES_PER_WINDOW) {
          throw new RendererIpcRejection(
            'Images are being sent too quickly. Wait a moment and try again.',
            'rate',
          )
        }
        largeSubmitBytes += bytes
      }
      if (kind === 'diagnostics') diagnosticFrameCount++
      frameCount++
    },
  }
}
