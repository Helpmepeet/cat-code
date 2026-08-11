import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import * as growthbook from '../analytics/growthbook.js'
import type { AssistantMessage, Message, UserMessage } from '../../types/message.js'

// Time-based microcompact is disabled by default (tengu_slate_heron); enable it
// through the GrowthBook read so a main-thread turn seeds the sticky set.
const ENABLED_CONFIG = {
  enabled: true,
  gapThresholdMinutes: 60,
  keepRecent: 1,
}

const OLD_TIMESTAMP = '2020-01-01T00:00:00.000Z'
const RESULT_A = `alpha ${'a'.repeat(400)}`
const RESULT_B = `bravo ${'b'.repeat(400)}`

function toolUseAssistant(id: string, timestamp = OLD_TIMESTAMP): AssistantMessage {
  return {
    type: 'assistant',
    uuid: `assistant-${id}`,
    timestamp,
    message: {
      id: `msg-${id}`,
      model: 'claude-sonnet-4-6',
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }],
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

/** Two Bash tool results; with keepRecent 1 the first one gets cleared. */
function conversation(): Message[] {
  return [
    toolUseAssistant('t1'),
    toolResultUser('t1', RESULT_A),
    toolUseAssistant('t2'),
    toolResultUser('t2', RESULT_B),
  ]
}

/** Same conversation plus a just-now assistant turn, so the gap never re-fires. */
function conversationWithFreshTurn(): Message[] {
  return [
    ...conversation(),
    toolUseAssistant('t3', new Date().toISOString()),
    toolResultUser('t3', 'charlie'),
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

/**
 * Seed the sticky cleared-id set with a main-thread time-based microcompact,
 * then report which ids a later main-thread turn still re-applies. That
 * re-application is the only observable the guard protects.
 */
async function stickyIdsAfter(
  cleanup: () => void,
): Promise<string[]> {
  const { microcompactMessages } = await import('./microCompact.js')
  const seeded = await microcompactMessages(
    conversation(),
    undefined,
    'repl_main_thread',
  )
  expect(clearedIds(seeded.messages)).toEqual(['t1'])

  cleanup()

  const later = await microcompactMessages(
    conversationWithFreshTurn(),
    undefined,
    'repl_main_thread',
  )
  return clearedIds(later.messages)
}

describe('runPostCompactCleanup microcompact ownership', () => {
  beforeEach(async () => {
    // Spread the real module: postCompactCleanup pulls in a wider graph than
    // microCompact alone, and a replacement-only factory drops the other
    // growthbook exports that graph imports.
    await mock.module('../analytics/growthbook.js', () => ({
      ...growthbook,
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

  test('a subagent compact leaves the main thread sticky set intact', async () => {
    const { runPostCompactCleanup } = await import('./postCompactCleanup.js')

    expect(await stickyIdsAfter(() => runPostCompactCleanup('agent:custom'))).toEqual(
      ['t1'],
    )
  })

  test('a main-thread compact clears the sticky set', async () => {
    const { runPostCompactCleanup } = await import('./postCompactCleanup.js')

    expect(
      await stickyIdsAfter(() => runPostCompactCleanup('repl_main_thread')),
    ).toEqual([])
  })

  test('an undefined querySource clears the sticky set', async () => {
    // /compact and /clear call in without a source and are main-thread-only.
    const { runPostCompactCleanup } = await import('./postCompactCleanup.js')

    expect(await stickyIdsAfter(() => runPostCompactCleanup())).toEqual([])
  })
})
