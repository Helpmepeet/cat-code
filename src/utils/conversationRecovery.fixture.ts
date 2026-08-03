import type { Message } from '../types/message.js'
import {
  createAssistantMessage,
  createCompactBoundaryMessage,
  createUserMessage,
} from './messages.js'

/** Actual persisted tail shape produced by manual /compact. */
export function compactResumeFixture(options?: {
  trailingPrompt?: string
}): Message[] {
  const messages: Message[] = [
    createUserMessage({ content: 'completed prompt' }),
    createAssistantMessage({ content: 'completed response' }),
    createCompactBoundaryMessage('manual', 316_672),
    createUserMessage({
      content: 'preserved compact summary',
      isCompactSummary: true,
    }),
    createUserMessage({
      content:
        '<local-command-caveat>Caveat: generated local-command messages must not be answered.</local-command-caveat>',
      isMeta: true,
    }),
    createUserMessage({
      content:
        '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>',
    }),
    createUserMessage({
      content: '<local-command-stdout>Compacted</local-command-stdout>',
    }),
  ]
  if (options?.trailingPrompt !== undefined) {
    messages.push(createUserMessage({ content: options.trailingPrompt }))
  }
  return messages
}
