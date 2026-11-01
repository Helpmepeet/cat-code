import type { Message } from '../types/message.js'
import { getSessionId, isSessionPersistenceDisabled } from '../bootstrap/state.js'
import { getInterruptedToolRun, UNRESOLVED_TOOL_MESSAGE } from '../services/tools/interruptedToolRun.js'
import { recordTranscript, flushCurrentTranscriptDurably } from './sessionStorage.js'
import type { QueryGuard } from './QueryGuard.js'

/** The terminal caller owns late receipts, not the already-finished query generator. */
export function createTerminalInterruptedTools(options: {
  sessionId: string
  guard: QueryGuard
  getMessages: () => Message[]
  append: (message: Message) => void
}) {
  const run = getInterruptedToolRun(options.sessionId)
  const disposed = new AbortController()
  const lease = run.attach(async (message, isCurrent) => {
    if (options.guard.isActive) {
      await new Promise<void>(resolve => {
        let unsubscribe = () => {}
        const finish = () => {
          unsubscribe()
          disposed.signal.removeEventListener('abort', finish)
          resolve()
        }
        unsubscribe = options.guard.subscribe(() => {
          if (!options.guard.isActive) finish()
        })
        disposed.signal.addEventListener('abort', finish, { once: true })
        if (disposed.signal.aborted) finish()
      })
    }
    if (!isCurrent() || getSessionId() !== options.sessionId) throw new Error('Tool receipt owner changed')
    const history = options.getMessages()
    if (message.type === 'user' && message.sourceToolAssistantUUID &&
        !history.some(row => row.uuid === message.sourceToolAssistantUUID)) throw new Error('The original tool request is unavailable')
    if (!isSessionPersistenceDisabled()) {
      await recordTranscript(history.some(row => row.uuid === message.uuid) ? history : [...history, message])
      await flushCurrentTranscriptDurably(message.uuid)
    }
    if (!isCurrent() || getSessionId() !== options.sessionId) throw new Error('Tool receipt owner changed')
    if (!options.getMessages().some(row => row.uuid === message.uuid)) options.append(message)
  })
  return {
    run,
    assertAdmission() {
      if (!lease.isCurrent() || getSessionId() !== options.sessionId || run.blocked) {
        run.retryDelivery()
        throw new Error(UNRESOLVED_TOOL_MESSAGE)
      }
    },
    dispose: () => { disposed.abort(); lease.dispose() },
  }
}
