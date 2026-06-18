import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID, type UUID } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getSessionId, getSessionProjectDir, switchSession } from '../bootstrap/state.js'
import { asSessionId } from '../types/ids.js'
import { clearSessionMessagesCache, getLastSessionLog, getTranscriptPathForSession } from './sessionStorage.js'

describe('session storage', () => {
  const originalSessionId = getSessionId()
  const originalProjectDir = getSessionProjectDir()

  let tempDir: string
  let sessionId: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'session-storage-'))
    sessionId = randomUUID()
    switchSession(asSessionId(sessionId), tempDir)
  })

  afterEach(() => {
    clearSessionMessagesCache()
    switchSession(asSessionId(originalSessionId), originalProjectDir)
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('last session log restores saved mode', async () => {
    const messageUuid = randomUUID()
    const timestamp = '2026-06-18T00:00:00.000Z'
    const transcript = [
      {
        type: 'mode',
        sessionId,
        mode: 'agent',
      },
      {
        type: 'user',
        uuid: messageUuid,
        parentUuid: null,
        isSidechain: false,
        sessionId,
        cwd: tempDir,
        userType: 'external',
        version: 'test',
        timestamp,
        message: { role: 'user', content: 'resume me' },
      },
    ]
      .map(entry => JSON.stringify(entry))
      .join('\n')

    await writeFile(getTranscriptPathForSession(sessionId), `${transcript}\n`)

    await expect(getLastSessionLog(sessionId as UUID)).resolves.toMatchObject({
      mode: 'agent',
      firstPrompt: 'resume me',
    })
  })
})
