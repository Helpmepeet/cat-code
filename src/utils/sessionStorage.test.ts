import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID, type UUID } from 'crypto'
import { mkdtempSync, rmSync, utimesSync } from 'fs'
import { writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getSessionId, getSessionProjectDir, switchSession } from '../bootstrap/state.js'
import { asSessionId } from '../types/ids.js'
import { createUserMessage } from './messages.js'
import { clearSessionMessagesCache, enrichLogs, flushCurrentTranscriptDurably, flushSessionStorage, getLastSessionLog, getSessionFilesLite, getTranscriptPathForSession, recordDeferredContinuationResult, recordTranscript, resetProjectForTesting } from './sessionStorage.js'

describe('session storage', () => {
  const originalSessionId = getSessionId()
  const originalProjectDir = getSessionProjectDir()
  const originalTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE

  let tempDir: string
  let sessionId: string

  beforeEach(() => {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    resetProjectForTesting()
    tempDir = mkdtempSync(join(tmpdir(), 'session-storage-'))
    sessionId = randomUUID()
    switchSession(asSessionId(sessionId), tempDir)
  })

  afterEach(() => {
    clearSessionMessagesCache()
    resetProjectForTesting()
    switchSession(asSessionId(originalSessionId), originalProjectDir)
    if (originalTestPersistence === undefined) {
      delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    } else {
      process.env.TEST_ENABLE_SESSION_PERSISTENCE = originalTestPersistence
    }
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

  test('resume tip skips a trailing dangling system frame (nonce survives)', async () => {
    // Regression for the P3-8 restore blocker: the desktop sidecar writes Codex
    // `system` frames (codex_send_path / account.route.selected) with
    // parentUuid:null and a timestamp a few ms LATER than the assistant turn they
    // follow. A tip-selection that only excludes sidechains picks that lone system
    // leaf, so buildConversationChain returns just it and the resumed session loses
    // all prior context. getLastSessionLog must pick the user/assistant tip.
    const userUuid = randomUUID()
    const assistantUuid = randomUUID()
    const transcript = [
      {
        type: 'user',
        uuid: userUuid,
        parentUuid: null,
        isSidechain: false,
        sessionId,
        cwd: tempDir,
        userType: 'external',
        version: 'test',
        timestamp: '2026-07-06T00:00:00.000Z',
        message: { role: 'user', content: 'The magic word is NONCE-XYZ.' },
      },
      {
        type: 'assistant',
        uuid: assistantUuid,
        parentUuid: userUuid,
        isSidechain: false,
        sessionId,
        cwd: tempDir,
        version: 'test',
        timestamp: '2026-07-06T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Acknowledged: NONCE-XYZ.' }],
        },
      },
      // The trap: a dangling system leaf, no parent, timestamp AFTER the assistant.
      {
        type: 'system',
        subtype: 'codex_send_path',
        uuid: randomUUID(),
        parentUuid: null,
        isSidechain: false,
        sessionId: null,
        timestamp: '2026-07-06T00:00:01.100Z',
      },
    ]
      .map(entry => JSON.stringify(entry))
      .join('\n')

    await writeFile(getTranscriptPathForSession(sessionId), `${transcript}\n`)

    const log = await getLastSessionLog(sessionId as UUID)
    expect(log).not.toBeNull()
    // Tip is the user/assistant turn, not the lone system frame.
    expect(log!.firstPrompt).toBe('The magic word is NONCE-XYZ.')
    expect(JSON.stringify(log!.messages)).toContain('Acknowledged: NONCE-XYZ.')
  })

  test('enriched modified tracks last in-file timestamp, not drifted mtime', async () => {
    const lastMessageTs = '2026-06-20T11:53:25.000Z'
    // file-history-snapshot is written during the turn and carries a nested
    // timestamp (FileHistorySnapshot.timestamp). It is the last *timestamped*
    // entry here, so enrichment adopts it — minutes from the message, unlike
    // mtime which the bug let drift by days. This mirrors real JSONL: the
    // extractor is a flat scan, so the nested timestamp is what it finds.
    const snapshotTs = '2026-06-20T11:55:00.000Z'
    const transcript = [
      {
        type: 'user',
        uuid: randomUUID(),
        parentUuid: null,
        isSidechain: false,
        sessionId,
        cwd: tempDir,
        userType: 'external',
        version: 'test',
        timestamp: lastMessageTs,
        message: { role: 'user', content: 'do the thing' },
      },
      // last-prompt carries no timestamp — must not be the source.
      { type: 'last-prompt', lastPrompt: 'do the thing' },
      {
        type: 'file-history-snapshot',
        messageId: randomUUID(),
        snapshot: { trackedFileBackups: {}, timestamp: snapshotTs },
        isSnapshotUpdate: false,
      },
    ]
      .map(entry => JSON.stringify(entry))
      .join('\n')

    const path = getTranscriptPathForSession(sessionId)
    await writeFile(path, `${transcript}\n`)
    // Simulate mtime drift: a metadata rewrite bumps mtime days past the last
    // activity (the bug this guards against would surface this as the time).
    const driftedMtime = new Date('2026-06-23T05:53:00.000Z')
    utimesSync(path, driftedMtime, driftedMtime)

    const lite = await getSessionFilesLite(tempDir)
    expect(lite).toHaveLength(1)
    // Lite (stat-only) still reflects mtime until enriched.
    expect(lite[0]!.modified.toISOString()).toBe(driftedMtime.toISOString())

    const { logs } = await enrichLogs(lite, 0, 1)
    expect(logs).toHaveLength(1)
    // After enrichment, modified is the last in-file timestamp (snapshotTs here),
    // never the drifted mtime — the days-off value can no longer leak through.
    expect(logs[0]!.modified.toISOString()).toBe(snapshotTs)
    expect(logs[0]!.modified.getTime()).toBeLessThan(driftedMtime.getTime())
  })

  test('durable transcript barrier requires the accepted UUID to be readable', async () => {
    const acceptedUuid = randomUUID()
    await writeFile(
      getTranscriptPathForSession(sessionId),
      `${JSON.stringify({ type: 'user', uuid: acceptedUuid })}\n`,
    )
    await expect(flushCurrentTranscriptDurably(acceptedUuid)).resolves.toBeUndefined()
    await expect(flushCurrentTranscriptDurably(randomUUID())).rejects.toThrow(
      'UUID is not durable',
    )
  })

  test('deferred result persistence is exact, sanitized, and session-bound', async () => {
    await recordTranscript([
      createUserMessage({ content: 'accepted', uuid: randomUUID() }),
    ])
    const entry = {
      type: 'deferred-continuation-result' as const,
      version: 1 as const,
      sessionId,
      attemptUuid: randomUUID(),
      outcome: 'completed' as const,
      observedAt: Date.now(),
    }
    await recordDeferredContinuationResult(entry)
    await flushSessionStorage()
    expect(await Bun.file(getTranscriptPathForSession(sessionId)).text()).toContain(
      entry.attemptUuid,
    )
    await expect(
      recordDeferredContinuationResult({
        ...entry,
        rawError: 'must not persist',
      } as typeof entry),
    ).rejects.toThrow('Invalid deferred continuation result entry')
    await expect(
      recordDeferredContinuationResult({ ...entry, sessionId: randomUUID() }),
    ).rejects.toThrow('Invalid deferred continuation result entry')
  })
})
