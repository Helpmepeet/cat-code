import { describe, expect, test } from 'bun:test'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  NO_RESPONSE_REQUESTED,
} from './messages.js'
import { normalizeMessage } from './queryHelpers.js'

describe('normalizeMessage internal no-response handling', () => {
  test('does not emit the silent API fallback to live SDK consumers', () => {
    const internal = createAssistantAPIErrorMessage({
      content: NO_RESPONSE_REQUESTED,
    })

    expect([...normalizeMessage(internal)]).toEqual([])
  })

  test('still emits genuine assistant-authored text with the same words', () => {
    const genuine = createAssistantMessage({ content: NO_RESPONSE_REQUESTED })

    expect(JSON.stringify([...normalizeMessage(genuine)])).toContain(
      NO_RESPONSE_REQUESTED,
    )
  })
})
