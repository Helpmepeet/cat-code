import type { SubmitOptions } from '../shared/protocol.js'

export function browserSubmitOptions(options: SubmitOptions | undefined, mint: () => string): SubmitOptions {
  return { ...options, submitId: options?.submitId ?? mint() }
}

export class BrowserPaneControl {
  private readonly replies = new Map<string, Map<string, number>>()
  constructor(private readonly browser: { handBack: (id: string) => void }) {}

  questionReply(sessionId: string, requestId: string): void {
    let pending = this.replies.get(sessionId)
    if (!pending) this.replies.set(sessionId, pending = new Map())
    const now = Date.now()
    for (const [id, at] of pending) if (now - at > 60_000) pending.delete(id)
    if (pending.size < 128) pending.set(requestId, now)
  }

  receive(frame: { kind: string; sessionId: string; accepted?: boolean; requestId?: string }): void {
    const reply = frame.kind === 'question.result' && typeof frame.requestId === 'string' &&
      this.replies.get(frame.sessionId)?.delete(frame.requestId)
    if (frame.accepted === true && (frame.kind === 'submit.result' || reply)) {
      this.browser.handBack(frame.sessionId)
    }
  }

  forget(sessionId: string): void { this.replies.delete(sessionId) }
}
