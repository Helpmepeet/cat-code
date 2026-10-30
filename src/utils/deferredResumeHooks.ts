import { getSessionId } from '../bootstrap/state.js'
import type { Message } from '../types/message.js'
import { createUserMessage } from './messages.js'
import { processSessionStartHooks, takeInitialUserMessage } from './sessionStart.js'

/** Called only after an explicit fresh review input reaches its admission boundary. */
export async function runDeferredResumeHooks(): Promise<Message[]> {
  const context: Message[] = await processSessionStartHooks('resume', {
    sessionId: getSessionId(), forceSyncExecution: true,
  })
  const initial = takeInitialUserMessage()
  if (initial) context.push(createUserMessage({ content: initial, isMeta: true }))
  return context
}
