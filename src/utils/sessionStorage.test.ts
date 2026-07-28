import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID, type UUID } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from 'fs'
import { writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { getSessionId, getSessionProjectDir, switchSession } from '../bootstrap/state.js'
import { asAgentId, asSessionId } from '../types/ids.js'
import { registerActiveSubagent, unregisterActiveSubagent } from './cleanupRegistry.js'
import { createUserMessage } from './messages.js'
import { clearSessionMessagesCache, enrichLogs, flushCurrentTranscriptDurably, flushSessionStorage, getAgentTranscriptPath, getLastSessionLog, getSessionFilesLite, getTranscriptPathForSession, recordCodexSendPath, recordCodexStreamSurface, recordDeferredContinuationResult, recordPromptCacheBreak, recordTranscript, resetProjectForTesting } from './sessionStorage.js'

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
    // Record through the real writer so the session takes ownership of the
    // transcript, which is what the barrier now resolves its target from.
    await recordTranscript([
      createUserMessage({ content: 'accepted', uuid: acceptedUuid }),
    ])
    await expect(flushCurrentTranscriptDurably(acceptedUuid)).resolves.toBeUndefined()
    await expect(flushCurrentTranscriptDurably(randomUUID())).rejects.toThrow(
      'UUID is not durable',
    )
  })

  // Under `cleanupPeriodDays: 0` / `--no-session-persistence` (and the test env)
  // no .jsonl is ever created, but the barrier derived its target from the
  // session id and opened it read-only, so a deferred continuation reaching it
  // died on a bare ENOENT with nothing explaining why. Nothing was written, so
  // there is nothing to make durable.
  test('durable transcript barrier is a no-op when no transcript is owned', async () => {
    delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    await recordTranscript([
      createUserMessage({ content: 'suppressed', uuid: randomUUID() }),
    ])
    await flushSessionStorage()

    expect(existsSync(getTranscriptPathForSession(sessionId))).toBe(false)
    await expect(flushCurrentTranscriptDurably()).resolves.toBeUndefined()
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

  describe('codex diagnostics only write to an owned transcript', () => {
    const sendPathEntry = {
      mode: 'prewarm' as const,
      prev_response_id_prefix: null,
      sent_items: 0,
      prev_sent_items: 0,
      instructions_hash: 'abc123',
      effort: 'low',
      prompt_cache_key_prefix: null,
      session_id_prefix: null,
      account_id_prefix: null,
    }
    const streamSurfaceEntry = {
      transport: 'websocket' as const,
      transport_path: 'websocket' as const,
      conversation_id_prefix: null,
      account_id_prefix: null,
      model: 'gpt-5.6-luna',
      raw_event_count: 0,
      raw_event_types: {},
      had_visible_output: false,
      had_tool_calls: false,
      completed: true,
    }

    // The landmine: both recorders resolved their target with getTranscriptPath(),
    // which derives a path from the current session id whether or not anything
    // owns it. Called before the first user message (prewarm sends do exactly
    // this) they created the file, minting an orphan transcript that surfaced in
    // /resume and the desktop sidebar.
    test('no owning session writes nothing', () => {
      // resetProjectForTesting() in beforeEach left the Project singleton unbuilt,
      // so no session has materialized or adopted a transcript.
      expect(readdirSync(tempDir)).toHaveLength(0)

      recordCodexSendPath(sendPathEntry)
      recordCodexStreamSurface(streamSurfaceEntry)

      expect(existsSync(getTranscriptPathForSession(sessionId))).toBe(false)
      expect(readdirSync(tempDir)).toHaveLength(0)
    })

    test('an owning session writes as before', async () => {
      // Materialize through the real path, not setSessionFileForTesting: the
      // first user/assistant message is what sets Project.sessionFile.
      await recordTranscript([
        createUserMessage({ content: 'real turn', uuid: randomUUID() }),
      ])
      await flushSessionStorage()

      recordCodexSendPath(sendPathEntry)
      recordCodexStreamSurface(streamSurfaceEntry)

      const text = await Bun.file(getTranscriptPathForSession(sessionId)).text()
      expect(text).toContain('"subtype":"codex_send_path"')
      expect(text).toContain('"subtype":"codex_stream_surface"')
      expect(text).toContain('abc123')
      expect(text).toContain('gpt-5.6-luna')
    })
  })

  describe('prompt-cache-break diagnostics only write to an owned transcript', () => {
    const agentId = asAgentId('cache-break-agent')
    // Only the fields recordPromptCacheBreak requires; values are arbitrary —
    // these tests assert where the entry lands, not what it says.
    const breakEntry = {
      querySource: 'test',
      callNumber: 2,
      prevCacheReadTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      tokenDrop: 100,
      messageCount: 2,
      ttlBucket: 'under_5m' as const,
      reason: 'CACHE-BREAK-MARKER',
      contextTruncated: false,
      staleResponseIdRetry: false,
      systemPromptChanged: false,
      toolSchemasChanged: false,
      modelChanged: false,
      fastModeChanged: false,
      cacheControlChanged: false,
      globalCacheStrategyChanged: false,
      betasChanged: false,
      autoModeChanged: false,
      overageChanged: false,
      cachedMCChanged: false,
      effortChanged: false,
      extraBodyChanged: false,
      addedToolCount: 0,
      removedToolCount: 0,
      systemCharDelta: 0,
      addedTools: [],
      removedTools: [],
      changedToolSchemas: [],
      addedBetas: [],
      removedBetas: [],
      previousModel: 'a',
      newModel: 'b',
      prevGlobalCacheStrategy: '',
      newGlobalCacheStrategy: '',
      prevEffortValue: '',
      newEffortValue: '',
    }

    afterEach(() => {
      unregisterActiveSubagent(agentId)
    })

    test('main-session branch: no owning session writes nothing', () => {
      recordPromptCacheBreak(breakEntry)

      expect(existsSync(getTranscriptPathForSession(sessionId))).toBe(false)
      expect(readdirSync(tempDir)).toHaveLength(0)
    })

    test('main-session branch: an owning session writes as before', async () => {
      await recordTranscript([
        createUserMessage({ content: 'real turn', uuid: randomUUID() }),
      ])
      await flushSessionStorage()

      recordPromptCacheBreak(breakEntry)

      const text = await Bun.file(getTranscriptPathForSession(sessionId)).text()
      expect(text).toContain('"subtype":"prompt_cache_break"')
      expect(text).toContain('CACHE-BREAK-MARKER')
    })

    // getAgentTranscriptPath() nests under getSessionId(), so an unowned agent
    // write minted a whole <projectDir>/<sessionId>/subagents/ tree.
    test('agent branch: an unregistered agent writes nothing', () => {
      recordPromptCacheBreak({ ...breakEntry, agentId })

      expect(existsSync(getAgentTranscriptPath(agentId))).toBe(false)
      expect(readdirSync(tempDir)).toHaveLength(0)
    })

    // LocalMainSessionTask.ts:101 links its own agent transcript and passes the
    // same agentId to the API (:125) without ever registering as a subagent.
    // Guarding on the registry alone would silently drop its diagnostics, so an
    // already-existing derived transcript is accepted too — that still cannot
    // mint an orphan, because the diagnostic never creates the file.
    test('agent branch: an unregistered agent that already owns a transcript still writes', async () => {
      const agentTranscriptPath = getAgentTranscriptPath(agentId)
      mkdirSync(dirname(agentTranscriptPath), { recursive: true })
      await writeFile(agentTranscriptPath, '')

      recordPromptCacheBreak({ ...breakEntry, agentId })

      const text = await Bun.file(agentTranscriptPath).text()
      expect(text).toContain('"subtype":"prompt_cache_break"')
    })

    test('agent branch: a live agent writes to the transcript it registered', async () => {
      const agentTranscriptPath = getAgentTranscriptPath(agentId)
      // Same shape AgentTool records at spawn and resumeAgent at resume — the
      // registered transcriptPath is the pointer, not a re-derived path.
      registerActiveSubagent(agentId, {
        startedAt: Date.now(),
        toolUseId: 'toolu_test',
        transcriptPath: agentTranscriptPath,
        agentType: 'general-purpose',
        description: 'test agent',
        sessionId,
      })

      recordPromptCacheBreak({ ...breakEntry, agentId })

      const text = await Bun.file(agentTranscriptPath).text()
      expect(text).toContain('"subtype":"prompt_cache_break"')
      expect(text).toContain('CACHE-BREAK-MARKER')
    })
  })
})
