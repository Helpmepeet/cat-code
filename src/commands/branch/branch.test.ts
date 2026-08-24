import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID, type UUID } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getSessionId,
  getSessionProjectDir,
  switchSession,
} from '../../bootstrap/state.js'
import { asSessionId } from '../../types/ids.js'
import { deriveUUID } from '../../utils/messages.js'
import {
  getTranscriptPathForSession,
  loadTranscriptFromFile,
  resetProjectForTesting,
} from '../../utils/sessionStorage.js'
import { createFork, createForkBeforeUserMessage } from './branch.js'

describe('conversation branching', () => {
  const originalSessionId = getSessionId()
  const originalProjectDir = getSessionProjectDir()
  let tempDir: string
  let sessionId: UUID

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'conversation-branch-'))
    sessionId = randomUUID()
    switchSession(asSessionId(sessionId), tempDir)
    resetProjectForTesting()
  })

  afterEach(() => {
    resetProjectForTesting()
    switchSession(asSessionId(originalSessionId), originalProjectDir)
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('HEAD forks the canonical active chain instead of file order', async () => {
    const firstUser = randomUUID()
    const firstAssistant = randomUUID()
    const discardedUser = randomUUID()
    const discardedAssistant = randomUUID()
    const entries = [
      messageEntry('user', firstUser, null, '2026-08-24T00:00:00.000Z', {
        role: 'user',
        content: 'retained prompt',
      }),
      messageEntry(
        'assistant',
        firstAssistant,
        firstUser,
        '2026-08-24T00:00:01.000Z',
        { role: 'assistant', content: [{ type: 'text', text: 'retained answer' }] },
      ),
      messageEntry(
        'user',
        discardedUser,
        firstAssistant,
        '2026-08-24T00:00:02.000Z',
        { role: 'user', content: 'discarded prompt' },
      ),
      messageEntry(
        'assistant',
        discardedAssistant,
        discardedUser,
        '2026-08-24T00:00:03.000Z',
        { role: 'assistant', content: [{ type: 'text', text: 'discarded answer' }] },
      ),
      { type: 'active-conversation-tip', sessionId, tipUuid: firstAssistant },
    ]
    await writeTranscript(entries)

    const fork = await createFork()

    expect(fork.title).toMatch(/^retained prompt \(Branch(?: \d+)?\)$/)
    expect(fork.serializedMessages.map(message => message.uuid)).toEqual([
      firstUser,
      firstAssistant,
    ])
  })

  test('forks before a normalized user target and keeps only valid replacements', async () => {
    const firstUser = randomUUID()
    const toolUseAssistant = randomUUID()
    const toolResultUser = randomUUID()
    const targetUuid = randomUUID()
    const targetContent = [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'aW1hZ2U=',
        },
      },
      { type: 'text', text: 'branch before this prompt' },
    ]
    const entries = [
      messageEntry('user', firstUser, null, '2026-08-24T01:00:00.000Z', {
        role: 'user',
        content: 'first prompt',
      }),
      messageEntry(
        'assistant',
        toolUseAssistant,
        firstUser,
        '2026-08-24T01:00:01.000Z',
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_keep', name: 'Read', input: {} },
          ],
        },
      ),
      messageEntry(
        'user',
        toolResultUser,
        toolUseAssistant,
        '2026-08-24T01:00:02.000Z',
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_keep',
              content: 'result',
            },
          ],
        },
      ),
      {
        ...messageEntry(
          'user',
          targetUuid,
          toolResultUser,
          '2026-08-24T01:00:03.000Z',
          { role: 'user', content: targetContent },
        ),
        imagePasteIds: [9],
      },
      {
        type: 'content-replacement',
        sessionId,
        replacements: [
          { kind: 'tool-result', toolUseId: 'toolu_keep', replacement: 'kept' },
          { kind: 'tool-result', toolUseId: 'toolu_drop', replacement: 'dropped' },
        ],
      },
    ]
    await writeTranscript(entries)
    const sourceBefore = await Bun.file(
      getTranscriptPathForSession(sessionId),
    ).text()

    const fork = await createForkBeforeUserMessage(
      deriveUUID(targetUuid, 1),
      'Source title',
    )

    expect(fork.title).toBe('Source title')
    expect(fork.serializedMessages.map(message => message.uuid)).toEqual([
      firstUser,
      toolUseAssistant,
      toolResultUser,
    ])
    expect(fork.sourcePrompt?.message.content).toEqual(targetContent)
    expect(fork.sourcePrompt?.imagePasteIds).toEqual([9])
    expect(fork.contentReplacementRecords).toEqual([
      { kind: 'tool-result', toolUseId: 'toolu_keep', replacement: 'kept' },
    ])
    expect(
      await Bun.file(getTranscriptPathForSession(sessionId)).text(),
    ).toBe(sourceBefore)
    const forkText = await Bun.file(fork.forkPath).text()
    expect(forkText).toContain('"forkedFrom"')
    expect(forkText).toContain(
      `"type":"custom-title","sessionId":"${fork.sessionId}","customTitle":"Source title"`,
    )
    expect((await loadTranscriptFromFile(fork.forkPath)).forked).toBe(true)

    await expect(createForkBeforeUserMessage(firstUser)).rejects.toThrow(
      'Cannot branch before the first prompt',
    )
  })

  function messageEntry(
    type: 'user' | 'assistant',
    uuid: UUID,
    parentUuid: UUID | null,
    timestamp: string,
    message: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      parentUuid,
      isSidechain: false,
      type,
      uuid,
      timestamp,
      message,
      sessionId,
      cwd: tempDir,
      userType: 'external',
      version: 'test',
    }
  }

  async function writeTranscript(entries: Record<string, unknown>[]): Promise<void> {
    await writeFile(
      getTranscriptPathForSession(sessionId),
      `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`,
    )
  }
})
