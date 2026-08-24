import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { compactResumeFixture } from './conversationRecovery.fixture.js'
import {
  deserializeMessagesWithInterruptDetection,
  loadMessagesFromJsonlPath,
} from './conversationRecovery.js'
import {
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
