import { createHash } from 'node:crypto'
import type { Message, PriorAssistantContext } from '../../types/message.js'
import { SYNTHETIC_MODEL } from '../messages.js'

// A proposal is consent context only when its entire scope fits. Never hash or
// render a tail as though it represented the complete proposal.
export const MAX_PROPOSAL_CHARS = 16000

export function parsePriorAssistantContext(value: unknown): PriorAssistantContext | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== 2 ||
    typeof record.messageUuid !== 'string' || record.messageUuid.length === 0 ||
    record.messageUuid.length > 200 ||
    typeof record.textHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.textHash)
  ) return null
  return { messageUuid: record.messageUuid, textHash: record.textHash }
}

export function readAssistantProposal(message: Message): {
  binding: PriorAssistantContext
  text: string
} | null {
  if (
    message.type !== 'assistant' || message.isApiErrorMessage ||
    message.isInternalNoResponseSentinel || message.message.model === SYNTHETIC_MODEL ||
    typeof message.uuid !== 'string' || !message.uuid || message.uuid.length > 200
  ) return null
  const prose = message.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  if (!prose.trim() || prose.length > MAX_PROPOSAL_CHARS) return null
  const text = prose
  return {
    binding: {
      messageUuid: message.uuid,
      // A streamed/rebuilt message retaining its UUID cannot expand the
      // proposal after submission and still match this snapshot.
      textHash: createHash('sha256').update(text).digest('hex'),
    },
    text,
  }
}

/** Call synchronously at input acceptance, before awaiting or enqueuing. */
export function capturePriorAssistantContext(messages: readonly Message[]): PriorAssistantContext | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.type === 'assistant') {
      const proposal = readAssistantProposal(message)
      if (proposal) return proposal.binding
      if (
        message.isApiErrorMessage || message.isInternalNoResponseSentinel ||
        message.message.model === SYNTHETIC_MODEL ||
        message.message.content.some(block => block.type === 'text')
      ) return null
    } else if (message.type === 'user') {
      const content = message.message.content
      if (
        message.origin !== undefined || message.isMeta || message.isVirtual ||
        message.isCompactSummary || message.isVisibleInTranscriptOnly ||
        !Array.isArray(content) || content.length === 0 ||
        !content.every(block => block.type === 'tool_result')
      ) return null
    } else if (
      message.type === 'attachment' ||
      (message.type === 'system' && message.subtype === 'compact_boundary')
    ) {
      return null
    }
  }
  return null
}
