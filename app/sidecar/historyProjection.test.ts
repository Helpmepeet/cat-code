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
  projectUndeliveredPrompts,
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

  test('replays an undelivered prompt with its producer identity', () => {
    expect(
      projectUndeliveredPrompts(
        [
          {
            uuid: '00000000-0000-4000-8000-000000000901',
            content: 'keep this accepted input',
            timestamp: '2026-08-09T10:00:00.000Z',
          },
        ],
        'engine-session',
      ),
    ).toEqual([
      {
        type: 'user',
        message: { role: 'user', content: 'keep this accepted input' },
        session_id: 'engine-session',
        parent_tool_use_id: null,
        uuid: '00000000-0000-4000-8000-000000000901',
        timestamp: '2026-08-09T10:00:00.000Z',
        isReplay: true,
      },
    ])
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

  /**
   * The persisted shape, copied from a live transcript. A busy recipient's turn
   * drains a peer message itself and folds it into this attachment; the engine
   * writes no user entry for it, so the attachment is everything that survives.
   */
  function peerAttachment(
    attachment: Record<string, unknown>,
  ): Parameters<typeof projectResumedHistory>[0][number] {
    return {
      type: 'attachment',
      uuid: '00000000-0000-4000-8000-000000000902',
      timestamp: '2026-09-04T09:50:18.201Z',
      attachment: {
        type: 'queued_command',
        prompt: '<cross-session-message from="Pestle">\nconclude it\n</cross-session-message>',
        commandMode: 'task-notification',
        ...attachment,
      },
    }
  }

  test('rebuilds the row of a peer message a busy session received', () => {
    const projected = projectResumedHistory([
      peerAttachment({
        source_uuid: '00000000-0000-4000-8000-000000000903',
        origin: { kind: 'peer', name: 'Pestle', appSessionId: 'app-pestle' },
      }),
    ])

    expect(projected).toHaveLength(1)
    expect(projected[0]).toMatchObject({
      type: 'user',
      message: {
        role: 'user',
        content:
          '<cross-session-message from="Pestle">\nconclude it\n</cross-session-message>',
      },
      // The uuid the live frame carried, so a reload lands on the same row
      // rather than minting a second identity for one message.
      uuid: '00000000-0000-4000-8000-000000000903',
      timestamp: '2026-09-04T09:50:18.201Z',
      origin: { kind: 'peer', name: 'Pestle' },
    })
  })

  test('falls back to the attachment uuid for a message written before the fix', () => {
    const projected = projectResumedHistory([
      peerAttachment({ origin: { kind: 'peer', name: 'Pestle' } }),
    ])

    expect(projected).toHaveLength(1)
    expect(projected[0]).toMatchObject({
      uuid: '00000000-0000-4000-8000-000000000902',
      origin: { kind: 'peer', name: 'Pestle' },
    })
  })

  test('leaves every other drained command as the bookkeeping it has always been', () => {
    // A worker result rides the same drain and the same attachment type. The
    // transcript has never shown it, and rebuilding rows for it would invent
    // history rather than restore it.
    expect(
      projectResumedHistory([
        peerAttachment({ origin: { kind: 'task-notification', taskId: 'w-1' } }),
      ]),
    ).toEqual([])
    expect(projectResumedHistory([peerAttachment({})])).toEqual([])
  })

  test('fails closed when normalization removes the entire visible seed', () => {
    const merged = mergeDisplayHistoryWithSeed(
      [createAssistantMessage({ content: 'raw divergent tail' })],
      [],
    )

    expect(merged).toEqual({ history: [], truncated: true })
  })
})
