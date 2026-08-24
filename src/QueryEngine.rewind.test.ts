import { describe, expect, test } from 'bun:test'
import { randomUUID, type UUID } from 'crypto'
import { QueryEngine } from './QueryEngine.js'
import { getDefaultAppState, type AppState } from './state/AppStateStore.js'
import type { AssistantMessage, AttachmentMessage, Message } from './types/message.js'
import { createFileStateCacheWithSizeLimit } from './utils/fileStateCache.js'
import { createUserMessage, deriveUUID } from './utils/messages.js'

function createEngine(
  initialMessages: Message[],
  markActiveConversationTip: (tipUuid: UUID | null) => Promise<void>,
): { engine: QueryEngine; getState: () => AppState } {
  let state: AppState = getDefaultAppState()
  const engine = new QueryEngine({
    cwd: '/tmp',
    tools: [],
    commands: [],
    mcpClients: [],
    agents: [],
    canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
    getAppState: () => state,
    setAppState: update => {
      state = update(state)
    },
    initialMessages,
    readFileCache: createFileStateCacheWithSizeLimit(20),
    markActiveConversationTip,
  })
  return { engine, getState: () => state }
}

function assistant(parentText: string): AssistantMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: parentText }],
    },
  }
}

describe('QueryEngine conversation rewind', () => {
  test('resolves a normalized producer prefix and returns the complete raw prompt', async () => {
    const firstPrompt = createUserMessage({ content: 'first', uuid: randomUUID() })
    const firstAnswer = assistant('answer')
    const rawUuid = randomUUID()
    const selected = createUserMessage({
      uuid: rawUuid,
      permissionMode: 'plan',
      imagePasteIds: [17],
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'aW1hZ2U=',
          },
        },
        { type: 'text', text: 'edit this complete prompt' },
      ],
    })
    const discarded = assistant('discarded')
    const markers: Array<UUID | null> = []
    const { engine, getState } = createEngine(
      [firstPrompt, firstAnswer, selected, discarded],
      async tipUuid => {
        markers.push(tipUuid)
      },
    )

    const result = await engine.rewindBeforeUserMessage(deriveUUID(rawUuid, 1))

    expect(result.prompt).toBe(selected)
    expect(result.prompt.message.content).toEqual(selected.message.content)
    expect(result.prompt.imagePasteIds).toEqual([17])
    expect(result.retainedMessages).toEqual([firstPrompt, firstAnswer])
    expect(engine.getMessages()).toEqual([firstPrompt, firstAnswer])
    expect(markers).toEqual([firstAnswer.uuid])
    expect(getState().toolPermissionContext.mode).toBe('plan')
  })

  test('allows rewinding before the first prompt and rejects meta targets', async () => {
    const first = createUserMessage({ content: 'first', uuid: randomUUID() })
    const meta = createUserMessage({
      content: 'injected',
      uuid: randomUUID(),
      isMeta: true,
    })
    const markers: Array<UUID | null> = []
    const { engine } = createEngine([first, meta], async tipUuid => {
      markers.push(tipUuid)
    })

    const result = await engine.rewindBeforeUserMessage(first.uuid)
    expect(result.retainedMessages).toEqual([])
    expect(markers).toEqual([null])

    const second = createEngine([meta], async () => undefined).engine
    await expect(second.rewindBeforeUserMessage(meta.uuid)).rejects.toThrow(
      'Selectable user message not found',
    )
  })

  test('records the last retained conversation message instead of attachment metadata', async () => {
    const first = createUserMessage({ content: 'first', uuid: randomUUID() })
    const answer = assistant('answer')
    const attachment: AttachmentMessage = {
      type: 'attachment',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      attachment: { type: 'todo', content: 'metadata' },
    }
    const selected = createUserMessage({
      content: 'edit this',
      uuid: randomUUID(),
    })
    const markers: Array<UUID | null> = []
    const { engine } = createEngine(
      [first, answer, attachment, selected],
      async tipUuid => {
        markers.push(tipUuid)
      },
    )

    await engine.rewindBeforeUserMessage(selected.uuid)

    expect(markers).toEqual([answer.uuid])
  })
})
