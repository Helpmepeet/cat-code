import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID, type UUID } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { writeFile } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import {
  getOriginalCwd,
  getSessionId,
  getSessionProjectDir,
  setOriginalCwd,
  switchSession,
} from '../../bootstrap/state.js'
import { asSessionId } from '../../types/ids.js'
import { deriveUUID } from '../../utils/messages.js'
import {
  enrichLogs,
  getProjectDir,
  getProjectsDir,
  getSessionFilesLite,
  getTranscriptPathForSession,
  loadTranscriptFromFile,
  resetProjectForTesting,
} from '../../utils/sessionStorage.js'
import { createFork, createForkBeforeUserMessage } from './branch.js'

describe('conversation branching', () => {
  const originalSessionId = getSessionId()
  const originalProjectDir = getSessionProjectDir()
  const originalCwd = getOriginalCwd()
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const realConfigDir = originalConfigDir ?? join(homedir(), '.cat-code')
  let testRoot: string
  let configDir: string
  let tempDir: string
  let sessionId: UUID

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'conversation-branch-'))
    configDir = join(testRoot, 'config')
    tempDir = join(testRoot, 'workspace')
    mkdirSync(tempDir, { recursive: true })
    // Fork output and title lookup use the configured store plus original cwd.
    // Use a fresh cwd because getProjectDir memoizes by cwd, not config dir.
    process.env.CLAUDE_CONFIG_DIR = configDir
    setOriginalCwd(tempDir)
    sessionId = randomUUID()
    switchSession(asSessionId(sessionId), tempDir)
    resetProjectForTesting()
    const sourcePath = getTranscriptPathForSession(sessionId)
    expect(getProjectsDir()).toBe(join(configDir, 'projects'))
    expect(pathIsWithin(sourcePath, testRoot)).toBe(true)
    expect(pathIsWithin(sourcePath, realConfigDir)).toBe(false)
  })

  afterEach(() => {
    try {
      resetProjectForTesting()
    } finally {
      try {
        setOriginalCwd(originalCwd)
        switchSession(asSessionId(originalSessionId), originalProjectDir)
      } finally {
        if (originalConfigDir === undefined) {
          delete process.env.CLAUDE_CONFIG_DIR
        } else {
          process.env.CLAUDE_CONFIG_DIR = originalConfigDir
        }
        rmSync(testRoot, { recursive: true, force: true })
        expect(existsSync(testRoot)).toBe(false)
        expect(getOriginalCwd()).toBe(originalCwd)
        expect(getSessionId()).toBe(originalSessionId)
        expect(getSessionProjectDir()).toBe(originalProjectDir)
        expect(process.env.CLAUDE_CONFIG_DIR).toBe(originalConfigDir)
      }
    }
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

  test('repeated forks use isolated storage for title collision searches', async () => {
    const firstUser = randomUUID()
    await writeTranscript([
      messageEntry('user', firstUser, null, '2026-08-24T00:00:00.000Z', {
        role: 'user',
        content: 'retained prompt',
      }),
    ])

    const expectedProjectDir = getProjectDir(tempDir)

    const first = await createFork()
    const second = await createFork()

    expect(first.title).toBe('retained prompt (Branch)')
    expect(second.title).toBe('retained prompt (Branch 2)')
    expect(new Set([first.title, second.title]).size).toBe(2)
    for (const fork of [first, second]) {
      expect(fork.forkPath).toBe(
        join(expectedProjectDir, `${fork.sessionId}.jsonl`),
      )
      expect(pathIsWithin(fork.forkPath, testRoot)).toBe(true)
      expect(pathIsWithin(fork.forkPath, realConfigDir)).toBe(false)
      expect((await loadTranscriptFromFile(fork.forkPath)).forked).toBe(true)
    }
  })

  test('a branch of a legacy large managed prompt remains a managed catalog entry', async () => {
    const binding = {
      kind: 'managed' as const,
      storageRootId: randomUUID(),
      storageId: randomUUID(),
    }
    await writeTranscript([{
      ...messageEntry('user', randomUUID(), null, '2026-09-26T00:00:00.000Z', {
        role: 'user',
        content: 'x'.repeat(70 * 1024),
      }),
      // Older writers stamped this after the large message payload.
      sessionBinding: binding,
    }])

    const fork = await createFork()
    const lite = await getSessionFilesLite(dirname(fork.forkPath))
    const { logs } = await enrichLogs(lite, 0, lite.length)
    expect(logs.find(row => row.sessionId === fork.sessionId)?.sessionBinding).toEqual(binding)
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
    const path = getTranscriptPathForSession(sessionId)
    mkdirSync(dirname(path), { recursive: true })
    await writeFile(
      path,
      `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`,
    )
  }
})

function pathIsWithin(path: string, root: string): boolean {
  const relativePath = relative(resolve(root), resolve(path))
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  )
}
