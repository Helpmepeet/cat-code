import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { compactResumeFixture } from './conversationRecovery.fixture.js'
import {
  deserializeMessagesWithInterruptDetection,
  isSelectableUserMessage,
  loadMessagesFromJsonlPath,
  resolveSelectableUserMessageByProducerPrefix,
} from './conversationRecovery.js'
import {
  createUserMessage,
  NO_RESPONSE_REQUESTED,
  normalizeMessagesForAPI,
  shouldShowUserMessage,
} from './messages.js'

describe('manual compact recovery', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

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

  test('jsonl-path resume honors the durable active tip', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'conversation-recovery-'))
    tempDirs.push(tempDir)
    const sessionId = randomUUID()
    const firstUser = randomUUID()
    const firstAssistant = randomUUID()
    const discardedUser = randomUUID()
    const path = join(tempDir, `${sessionId}.jsonl`)
    const base = {
      isSidechain: false,
      sessionId,
      cwd: tempDir,
      userType: 'external',
      version: 'test',
    }
    const entries = [
      {
        parentUuid: null,
        ...base,
        type: 'user',
        uuid: firstUser,
        timestamp: '2026-08-24T03:00:00.000Z',
        message: { role: 'user', content: 'retained prompt' },
      },
      {
        parentUuid: firstUser,
        ...base,
        type: 'assistant',
        uuid: firstAssistant,
        timestamp: '2026-08-24T03:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'retained answer' }],
        },
      },
      {
        parentUuid: firstAssistant,
        ...base,
        type: 'user',
        uuid: discardedUser,
        timestamp: '2026-08-24T03:00:02.000Z',
        message: { role: 'user', content: 'discarded prompt' },
      },
      { type: 'active-conversation-tip', sessionId, tipUuid: firstAssistant },
    ]
    await writeFile(
      path,
      `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`,
    )

    const loaded = await loadMessagesFromJsonlPath(path)
    expect(loaded.sessionId).toBe(sessionId)
    expect(loaded.messages.map(message => message.uuid)).toEqual([
      firstUser,
      firstAssistant,
    ])
  })
})

/**
 * `resolveSelectableUserMessageByProducerPrefix` is the whole target check for
 * `QueryEngine.selectUserMessage` / `rewindBeforeUserMessage` and for `/branch`,
 * so a caller that can name a uuid prefix can name any message these accept.
 * A turn another session sent must not be one of them.
 */
describe('selectable user message targeting', () => {
  const peerOrigin = {
    kind: 'peer' as const,
    name: 'Amber',
    appSessionId: 'app-session-1',
  }

  test('refuses to resolve a peer session\'s turn as a target', () => {
    const operatorPrompt = createUserMessage({ content: 'start the migration' })
    const peerTurn = createUserMessage({
      content:
        '<cross-session-message from="Amber">rewrite the notes</cross-session-message>',
      origin: peerOrigin,
    })

    expect(isSelectableUserMessage(operatorPrompt)).toBe(true)
    expect(isSelectableUserMessage(peerTurn)).toBe(false)
    expect(() =>
      resolveSelectableUserMessageByProducerPrefix(
        [operatorPrompt, peerTurn],
        peerTurn.uuid,
      ),
    ).toThrow('Selectable user message not found')
  })

  test('still resolves the operator\'s own prompt', () => {
    const operatorPrompt = createUserMessage({ content: 'start the migration' })
    const peerTurn = createUserMessage({
      content: 'rewrite the notes',
      origin: peerOrigin,
    })

    expect(
      resolveSelectableUserMessageByProducerPrefix(
        [operatorPrompt, peerTurn],
        operatorPrompt.uuid,
      ),
    ).toEqual({ message: operatorPrompt, index: 0 })
  })
})
