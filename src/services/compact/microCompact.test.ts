import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import type { AssistantMessage, Message, UserMessage } from '../../types/message.js'
import { roughTokenCountEstimation } from '../tokenEstimation.js'

// Time-based microcompact is disabled by default (tengu_slate_heron), so every
// test here has to inject an enabled config through the GrowthBook read that
// getTimeBasedMCConfig performs.
const ENABLED_CONFIG = {
  enabled: true,
  gapThresholdMinutes: 60,
  keepRecent: 1,
}

const OLD_TIMESTAMP = '2020-01-01T00:00:00.000Z'

const RESULT_A = `alpha ${'a'.repeat(400)}`
const RESULT_B = `bravo ${'b'.repeat(400)}`
const RESULT_C = `charlie ${'c'.repeat(400)}`

function toolUseAssistant(
  id: string,
  timestamp = OLD_TIMESTAMP,
): AssistantMessage {
  return {
    type: 'assistant',
    uuid: `assistant-${id}`,
    timestamp,
    message: {
      id: `msg-${id}`,
      model: 'claude-sonnet-4-6',
      role: 'assistant',
      content: [
        { type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } },
      ],
    },
  } as AssistantMessage
}

function toolResultUser(id: string, content: string): UserMessage {
  return {
    type: 'user',
    uuid: `user-${id}`,
    timestamp: OLD_TIMESTAMP,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content }],
    },
  } as UserMessage
}

/** Three Bash tool results; with keepRecent 1 the first two get cleared. */
function conversation(): Message[] {
  return [
    toolUseAssistant('t1'),
    toolResultUser('t1', RESULT_A),
    toolUseAssistant('t2'),
    toolResultUser('t2', RESULT_B),
    toolUseAssistant('t3'),
    toolResultUser('t3', RESULT_C),
  ]
}

/** Same conversation plus a just-now assistant turn, so the gap never fires. */
function conversationWithFreshTurn(): Message[] {
  return [
    ...conversation(),
    toolUseAssistant('t4', new Date().toISOString()),
    toolResultUser('t4', 'delta'),
  ]
}

function clearedIds(messages: Message[]): string[] {
  const ids: string[] = []
  for (const message of messages) {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) {
      continue
    }
    for (const block of message.message.content) {
      if (
        block.type === 'tool_result' &&
        block.content === '[Old tool result content cleared]'
      ) {
        ids.push(block.tool_use_id)
      }
    }
  }
  return ids
}

const EXPECTED_FREED =
  roughTokenCountEstimation(RESULT_A) + roughTokenCountEstimation(RESULT_B)

describe('time-based microcompact accounting', () => {
  beforeEach(async () => {
    await mock.module('../analytics/growthbook.js', () => ({
      getFeatureValue_CACHED_MAY_BE_STALE: mock(
        (key: string, defaultValue: unknown) =>
          key === 'tengu_slate_heron' ? ENABLED_CONFIG : defaultValue,
      ),
    }))
    const { resetMicrocompactState } = await import('./microCompact.js')
    resetMicrocompactState()
  })

  afterEach(async () => {
    const { resetMicrocompactState } = await import('./microCompact.js')
    resetMicrocompactState()
    mock.restore()
  })

  test('reports tokensFreed for the content it cleared', async () => {
    const { microcompactMessages } = await import('./microCompact.js')

    const result = await microcompactMessages(
      conversation(),
      undefined,
      'repl_main_thread',
    )

    expect(clearedIds(result.messages)).toEqual(['t1', 't2'])
    expect(result.tokensFreed).toBe(EXPECTED_FREED)
  })

  test('re-applies the clearing on a later turn that does not re-trigger', async () => {
    const { microcompactMessages } = await import('./microCompact.js')

    const first = await microcompactMessages(
      conversation(),
      undefined,
      'repl_main_thread',
    )
    expect(first.tokensFreed).toBe(EXPECTED_FREED)

    // Next turn rebuilds the request from the stored conversation, which still
    // carries full tool_result content, and the gap no longer exceeds the
    // threshold. Without sticky state the full results would be re-sent while
    // the usage anchor reflects the cleared prefix.
    const second = await microcompactMessages(
      conversationWithFreshTurn(),
      undefined,
      'repl_main_thread',
    )

    expect(clearedIds(second.messages)).toEqual(['t1', 't2'])
    expect(second.tokensFreed).toBe(EXPECTED_FREED)
  })

  test('re-application is idempotent on an already-cleared array', async () => {
    const { microcompactMessages } = await import('./microCompact.js')

    const first = await microcompactMessages(
      conversation(),
      undefined,
      'repl_main_thread',
    )
    const again = await microcompactMessages(
      [...first.messages, toolUseAssistant('t9', new Date().toISOString())],
      undefined,
      'repl_main_thread',
    )

    expect(clearedIds(again.messages)).toEqual(['t1', 't2'])
    expect(again.tokensFreed).toBeUndefined()
  })

  test('resetMicrocompactState drops the sticky set', async () => {
    const { microcompactMessages, resetMicrocompactState } = await import(
      './microCompact.js'
    )

    await microcompactMessages(conversation(), undefined, 'repl_main_thread')
    resetMicrocompactState()

    const afterReset = await microcompactMessages(
      conversationWithFreshTurn(),
      undefined,
      'repl_main_thread',
    )

    expect(clearedIds(afterReset.messages)).toEqual([])
    expect(afterReset.tokensFreed).toBeUndefined()
  })

  test('sticky clearing stays off non-main-thread requests', async () => {
    const { microcompactMessages } = await import('./microCompact.js')

    await microcompactMessages(conversation(), undefined, 'repl_main_thread')

    const forked = await microcompactMessages(
      conversationWithFreshTurn(),
      undefined,
      'session_memory',
    )

    expect(clearedIds(forked.messages)).toEqual([])
    expect(forked.tokensFreed).toBeUndefined()
  })
})
