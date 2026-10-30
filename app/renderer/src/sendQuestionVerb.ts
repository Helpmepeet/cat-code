import type { CatCodeBridge, SessionId } from '../../shared/protocol.js'
import type { QuestionVerb } from '../../shared/nonblockingQuestions.js'

/** Subscribe before sending; a fast durable receipt must not race registration. */
export function sendQuestionVerb(bridge: CatCodeBridge, sessionId: SessionId, verb: QuestionVerb): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!bridge.questionVerb) { reject(new Error('Question replies are unavailable')); return }
    let unsubscribe = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      unsubscribe()
      if (error) reject(error)
      else resolve()
    }
    unsubscribe = bridge.subscribe(frames => {
      for (const frame of frames) {
        if (frame.sessionId !== sessionId) continue
        if (frame.kind === 'question.result' && frame.requestId === verb.requestId) {
          finish(frame.accepted === true ? undefined : new Error('Question response was not accepted'))
          return
        }
        if (frame.kind === 'error' && frame.requestId === verb.requestId) { finish(new Error(frame.message)); return }
      }
    })
    if (settled) { unsubscribe(); return }
    timer = setTimeout(() => finish(new Error('Question response acknowledgement timed out')), 20_000)
    try { bridge.questionVerb(sessionId, verb) } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
  })
}
