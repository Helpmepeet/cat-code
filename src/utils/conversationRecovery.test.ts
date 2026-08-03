import { describe, expect, test } from 'bun:test'
import { compactResumeFixture } from './conversationRecovery.fixture.js'
import { deserializeMessagesWithInterruptDetection } from './conversationRecovery.js'
import {
  NO_RESPONSE_REQUESTED,
  normalizeMessagesForAPI,
  shouldShowUserMessage,
} from './messages.js'

describe('manual compact recovery', () => {
  test('keeps API alternation valid without classifying local command records as an unanswered prompt', () => {
    const recovered = deserializeMessagesWithInterruptDetection(
      compactResumeFixture(),
    )

    expect(recovered.turnInterruptionState).toEqual({ kind: 'none' })

    const sentinel = recovered.messages.find(
      message =>
        message.type === 'assistant' &&
        message.isInternalNoResponseSentinel,
    )
    expect(sentinel?.type).toBe('assistant')
    if (sentinel?.type !== 'assistant') throw new Error('sentinel not found')
    expect(sentinel.message.content).toEqual([
      expect.objectContaining({ type: 'text', text: NO_RESPONSE_REQUESTED }),
    ])

    const apiMessages = normalizeMessagesForAPI(recovered.messages)
    expect(apiMessages.at(-1)?.type).toBe('assistant')
    expect(shouldShowUserMessage(sentinel, false)).toBe(false)
    expect(shouldShowUserMessage(sentinel, true)).toBe(false)
  })

  test('still reports a genuine trailing user prompt as interrupted', () => {
    const prompt = 'please continue with the migration'
    const recovered = deserializeMessagesWithInterruptDetection(
      compactResumeFixture({ trailingPrompt: prompt }),
    )

    expect(recovered.turnInterruptionState.kind).toBe('interrupted_prompt')
    if (recovered.turnInterruptionState.kind !== 'interrupted_prompt') {
      throw new Error('expected interrupted prompt')
    }
    expect(recovered.turnInterruptionState.message.message.content).toBe(prompt)
  })
})
