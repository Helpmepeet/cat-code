import { describe, expect, test } from 'bun:test'
import { compactResumeFixture } from '../../src/utils/conversationRecovery.fixture.js'
import { deserializeMessagesWithInterruptDetection } from '../../src/utils/conversationRecovery.js'
import { createAttachmentMessage, getQueuedCommandAttachments } from '../../src/utils/attachments.js'
import type { QueuedCommand } from '../../src/types/textInputTypes.js'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createUserMessage,
  NO_RESPONSE_REQUESTED,
} from '../../src/utils/messages.js'
import {
  mergeDisplayHistoryWithSeed,
  projectUndeliveredPrompts,
  projectResumedHistory,
} from './historyProjection.js'

describe('restored history projection', () => {
  test('peer snapshots remain model-only and produce no desktop transcript frames', () => {
    const user = createUserMessage({ content: 'Visible prompt' })
    const history = [
      user,
      createAttachmentMessage({
        type: 'peer_coordination_state', asOf: '2026-10-18T00:00:00.000Z',
        peers: [{ name: 'Bear', status: 'live' }],
      }),
      createAttachmentMessage({
        type: 'peer_roster_snapshot', workspace: '/workspace',
        asOf: '2026-10-18T00:00:00.000Z', quotedRoster: '{"peers":[{"name":"Bear","status":"live"}]}',
      }),
    ]
    expect(projectResumedHistory(history)).toEqual(projectResumedHistory([user]))
    expect(projectResumedHistory(history)).toHaveLength(1)
  })

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

  test('a workspace handoff resumes its complete history without a false missing prefix', () => {
    const archival = [
      createUserMessage({ content: 'Work in cat-code' }),
      createAssistantMessage({ content: [{
        type: 'tool_use', id: 'jump-1', name: 'JumpWorkspace', input: {},
      }] }),
      createUserMessage({ content: [{
        type: 'tool_result', tool_use_id: 'jump-1', content: 'Workspace change accepted.',
      }] }),
    ]
    const recovered = deserializeMessagesWithInterruptDetection(archival)
    expect(recovered.turnInterruptionState.kind).toBe('interrupted_prompt')
    const seed = projectResumedHistory(recovered.messages)
    expect(seed.length).toBeGreaterThan(projectResumedHistory(archival).length)

    expect(mergeDisplayHistoryWithSeed(archival, seed)).toEqual({
      history: seed,
      truncated: false,
    })
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

  test('restores drained human text and images verbatim, between the surrounding assistant messages', async () => {
    const image = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'aW1hZ2U=' } }
    const urlImage = { type: 'image' as const, source: { type: 'url' as const, url: 'https://example.test/image.png' } }
    const prompts: QueuedCommand['value'][] = [
      'Oh, work in cat-code workspace. use peer sesion feature',
      'Task notification\nSummary: text the human typed',
      [{ type: 'text', text: 'First' }, image, { type: 'text', text: 'Second' }, urlImage],
      [image],
    ]
    for (const prompt of prompts) for (const origin of [undefined, { kind: 'human' as const }]) {
      const [attachment] = await getQueuedCommandAttachments([{
        mode: 'prompt', value: prompt, origin,
        uuid: '4bbd7120-3ac3-4b66-ac60-726fed3507df',
      }])
      const drained = { ...createAttachmentMessage(attachment!),
        uuid: '8b5abac5-1514-4d8a-a8d2-d638978f7c3d', timestamp: '2026-10-25T05:19:56.243Z' }
      // Both the retained engine seed and archival history have passed through
      // JSONL. The projection must not mutate either into a model user entry.
      const archived = JSON.parse(JSON.stringify([
        createAssistantMessage({ content: 'Before queue drain' }), drained,
        createAssistantMessage({ content: [{ type: 'tool_use', id: 'jump-queued', name: 'JumpWorkspace', input: {} }] }),
        createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'jump-queued', content: 'Workspace change accepted.' }] }),
      ]))
      const recovered = deserializeMessagesWithInterruptDetection(archived)
      const seed = projectResumedHistory(recovered.messages)
      const merged = mergeDisplayHistoryWithSeed(archived, seed)
      const restored = merged.history.filter(message => message.type === 'user' && message.uuid === '4bbd7120-3ac3-4b66-ac60-726fed3507df')
      expect(restored).toHaveLength(1)
      expect(restored[0]).toMatchObject({
        type: 'user', uuid: '4bbd7120-3ac3-4b66-ac60-726fed3507df', timestamp: drained.timestamp,
        message: { role: 'user', content: prompt },
        ...(origin ? { origin } : {}),
      })
      expect(restored[0]?.type === 'user' && restored[0].origin).toEqual(origin)
      expect(restored[0]?.type === 'user' && restored[0].isSynthetic).toBeFalsy()
      expect(merged.history.slice(0, 3).map(message => message.uuid)).toEqual([
        archived[0].uuid, '4bbd7120-3ac3-4b66-ac60-726fed3507df', archived[2].uuid,
      ])
      expect(merged.truncated).toBe(false)
      expect(archived[1]).toEqual(drained)
    }
  })

  test('restores legacy human attachments without queue identity or mode and avoids duplicate saved rows', () => {
    const legacy = peerAttachment({ prompt: 'Legacy human input', commandMode: undefined })
    expect(projectResumedHistory([legacy])).toMatchObject([{
      type: 'user', uuid: legacy.uuid, timestamp: legacy.timestamp,
      message: { content: 'Legacy human input' },
    }])
    const user = createUserMessage({ content: 'Already persisted', uuid: 'saved-human' })
    const duplicate = peerAttachment({ prompt: 'Already persisted', commandMode: 'prompt', source_uuid: user.uuid })
    expect(projectResumedHistory([user, duplicate, duplicate])).toEqual(projectResumedHistory([user]))
    expect(projectResumedHistory([duplicate, duplicate])).toHaveLength(1)
  })

  test('does not promote internal, meta, or unsupported queued content into human rows', () => {
    const hidden = [
      { origin: { kind: 'task-notification', taskId: 'w-1' } },
      { origin: { kind: 'coordinator' } },
      { origin: { kind: 'interruption' } },
      { origin: { kind: 'deferred-continuation', jobId: 'j', attemptUuid: 'a' } },
      { origin: { kind: 'channel', server: 'mcp' } },
      { origin: { kind: 'teammate', messages: [] } },
      { origin: { kind: 'future-internal-origin' } },
      { origin: {} }, { origin: 'human' },
      { isMeta: true }, { origin: { kind: 'human' }, isMeta: true },
      { commandMode: 'task-notification' }, { commandMode: 'unknown-mode' },
      { prompt: [{ type: 'tool_result', tool_use_id: 'internal', content: 'output' }] },
      { prompt: [{ type: 'text', text: 7 }] }, { prompt: [{ type: 'image', source: null }] },
      { prompt: [{ type: 'image', source: {} }] }, { prompt: [null] }, { prompt: [] }, { prompt: 7 },
      { origin: { kind: 'peer', name: 'Pestle' }, prompt: [{ type: 'text', text: 'Not a peer string' }] },
    ]
    for (const fields of hidden) {
      expect(projectResumedHistory([peerAttachment({ prompt: 'Internal content', commandMode: 'prompt', ...fields })])).toEqual([])
    }
  })

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
