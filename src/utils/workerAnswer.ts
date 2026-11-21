import type { AssistantMessage } from '../types/message.js'

export function workerAnswerText(record: AssistantMessage) {
  if (record.isApiErrorMessage) return []
  return record.message.content.filter((block): block is Extract<typeof block, { type: 'text' }> =>
    block.type === 'text' && (!('phase' in block) || block.phase !== 'commentary'),
  )
}

// Used only while delivering the current worker run. Keep previous answer
// blocks out of the provider request and the persisted assistant records.
export const workerAnswerPrefixes = new WeakMap<object, ReturnType<typeof workerAnswerText>>()
