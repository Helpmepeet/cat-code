import { describe, expect, test } from 'bun:test'
import { compactResumeFixture } from '../../src/utils/conversationRecovery.fixture.js'
import { deserializeMessagesWithInterruptDetection } from '../../src/utils/conversationRecovery.js'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  NO_RESPONSE_REQUESTED,
} from '../../src/utils/messages.js'
import {
  mergeDisplayHistoryWithSeed,
  projectResumedHistory,
} from './historyProjection.js'

describe('restored history projection', () => {
  test('replays the compact boundary without the internal recovery sentinel', () => {
    const recovered = deserializeMessagesWithInterruptDetection(
      compactResumeFixture(),
    )
    expect(
      recovered.messages.some(
        message =>
          message.type === 'assistant' &&
          message.isInternalNoResponseSentinel,
      ),
    ).toBe(true)

    const replay = projectResumedHistory(recovered.messages)

    expect(
      replay.some(
        message =>
          message.type === 'system' &&
          message.subtype === 'compact_boundary',
      ),
    ).toBe(true)
    expect(JSON.stringify(replay)).not.toContain(NO_RESPONSE_REQUESTED)
  })

  test('does not hide genuine assistant text that happens to match the sentinel', () => {
    const genuine = createAssistantMessage({ content: NO_RESPONSE_REQUESTED })

    expect(JSON.stringify(projectResumedHistory([genuine]))).toContain(
      NO_RESPONSE_REQUESTED,
    )
  })

  test('hides current and legacy silent rate-limit fallback records', () => {
    const current = createAssistantAPIErrorMessage({
      content: NO_RESPONSE_REQUESTED,
    })
    expect(current.isInternalNoResponseSentinel).toBe(true)

    const legacy = {
      ...current,
      isInternalNoResponseSentinel: undefined,
    }

    expect(projectResumedHistory([current])).toEqual([])
    expect(projectResumedHistory([legacy])).toEqual([])
  })

  test('prepends archival history while preserving the exact visible seed tail', () => {
    const recovered = deserializeMessagesWithInterruptDetection(
      compactResumeFixture(),
    )
    const archival = [
      createAssistantMessage({ content: 'archival response before compact' }),
      ...recovered.messages,
      createAssistantMessage({ content: 'raw bookkeeping after normalized seed' }),
    ]
    const seed = projectResumedHistory(recovered.messages)

    const merged = mergeDisplayHistoryWithSeed(archival, seed)

    expect(merged.truncated).toBe(false)
    expect(JSON.stringify(merged.history)).toContain(
      'archival response before compact',
    )
    expect(merged.history.slice(-seed.length)).toEqual(seed)
    expect(JSON.stringify(merged.history)).not.toContain(
      'raw bookkeeping after normalized seed',
    )
  })

  test('falls back to the exact seed when archival history cannot align', () => {
    const seed = projectResumedHistory([
      createAssistantMessage({ content: 'visible model seed' }),
    ])
    const merged = mergeDisplayHistoryWithSeed(
      [createAssistantMessage({ content: 'unrelated archival branch' })],
      seed,
    )

    expect(merged).toEqual({ history: seed, truncated: true })
  })

  test('fails closed when normalization removes the entire visible seed', () => {
    const merged = mergeDisplayHistoryWithSeed(
      [createAssistantMessage({ content: 'raw divergent tail' })],
      [],
    )

    expect(merged).toEqual({ history: [], truncated: true })
  })
})
