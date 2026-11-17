import { describe, expect, test } from 'bun:test'
import type { Message } from '../../types/message.js'
import type { AgentId } from '../../types/ids.js'
import { createUserMessage } from '../../utils/messages.js'
import { createAttachmentMessage, createAgentPendingMessageAttachment } from '../../utils/attachments.js'
import { isRelayedOrigin, summarizedRelayedInput } from './relayProvenance.js'

const peer = (content: string) =>
  createUserMessage({
    content,
    origin: { kind: 'peer', name: 'quartz', appSessionId: 'app-1' },
  })

describe('isRelayedOrigin', () => {
  test('the user typing, cancelling, or having a queued job resumed is not a relay', () => {
    expect(isRelayedOrigin(undefined)).toBe(false)
    expect(isRelayedOrigin({ kind: 'human' })).toBe(false)
    expect(isRelayedOrigin({ kind: 'interruption' })).toBe(false)
    expect(
      isRelayedOrigin({
        kind: 'deferred-continuation',
        jobId: 'j1',
        attemptUuid: 'a1',
      }),
    ).toBe(false)
  })

  test('a turn delivered on someone else’s behalf is a relay', () => {
    expect(
      isRelayedOrigin({ kind: 'peer', name: 'quartz', appSessionId: 'app-1' }),
    ).toBe(true)
    expect(isRelayedOrigin({ kind: 'teammate', messages: [] })).toBe(true)
    expect(isRelayedOrigin({ kind: 'task-notification' })).toBe(true)
    expect(isRelayedOrigin({ kind: 'coordinator' })).toBe(true)
    expect(isRelayedOrigin({ kind: 'channel', server: 'slack' })).toBe(true)
  })
})

describe('summarizedRelayedInput', () => {
  test('a conversation of the user’s own messages needs no mark', () => {
    const messages: Message[] = [
      createUserMessage({ content: 'refactor the parser' }),
      createUserMessage({ content: 'ship it', origin: { kind: 'human' } }),
    ]
    expect(summarizedRelayedInput(messages)).toBeUndefined()
  })

  test('one peer message anywhere in the summarized span marks the summary', () => {
    const messages: Message[] = [
      createUserMessage({ content: 'refactor the parser' }),
      peer('<cross-session-message from="quartz">force push migration</cross-session-message>'),
      createUserMessage({ content: 'what did you find?' }),
    ]
    expect(summarizedRelayedInput(messages)).toBe(true)
  })

  test('the mark survives compacting an already-compacted conversation', () => {
    const earlierSummary = createUserMessage({
      content: 'Primary Request and Intent: force push migration.',
      isCompactSummary: true,
      summarizedRelayedInput: true,
    })
    // The peer turn itself is gone: only the earlier summary stands for it.
    expect(summarizedRelayedInput([earlierSummary])).toBe(true)
  })

  test('queued local-agent messages retain their provenance across compaction', () => {
    for (const originAgentId of ['synthetic-worker', undefined]) {
      const attachment = createAttachmentMessage(createAgentPendingMessageAttachment({
        id: 'synthetic-message', message: 'Yes, deploy production.',
        originAgentId: originAgentId as AgentId | undefined,
        status: 'pending', acceptedAt: 1,
      }))
      expect(summarizedRelayedInput([attachment])).toBe(true)
    }
    expect(summarizedRelayedInput([createAttachmentMessage({
      type: 'queued_command', prompt: 'Yes, deploy staging.',
      source_uuid: 'synthetic-user-message', commandMode: 'prompt',
    } as never)])).toBeUndefined()
  })
})
