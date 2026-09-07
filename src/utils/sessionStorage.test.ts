import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID, type UUID } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { getAPISessionId, getSessionId, getSessionProjectDir, switchSession } from '../bootstrap/state.js'
import { applyPostCodexAccountSwitchRefresh } from '../services/api/codexAccountPool.js'
import { asAgentId, asSessionId } from '../types/ids.js'
import type { AssistantMessage } from '../types/message.js'
import { createAttachmentMessage, getQueuedCommandAttachments } from './attachments.js'
import { registerActiveSubagent, unregisterActiveSubagent } from './cleanupRegistry.js'
import { createUserMessage } from './messages.js'
import { releaseActiveTranscriptLease } from './transcriptLease.js'
import { clearSessionMessagesCache, enrichLogs, flushCurrentTranscriptDurably, flushSessionStorage, getAgentTranscriptPath, getLastSessionLog, getSessionFilesLite, getTranscriptPathForSession, loadDisplayTranscriptFromJsonlPath, loadTranscriptFile, loadTranscriptFromFile, markActiveConversationTip, recordCodexSendPath, recordCodexStreamSurface, recordDeferredContinuationResult, recordPostTurnStall, recordPromptCacheBreak, recordRunFacts, recordTranscript, removeTranscriptMessage, resetProjectForTesting, resetRunFactsDedupeForTest, setSessionArchived, setSessionFileForTesting } from './sessionStorage.js'

describe('session archive flag', () => {
  const originalSessionId = getSessionId()
  const originalProjectDir = getSessionProjectDir()
  let tempDir: string
  let sessionId: UUID

  beforeEach(async () => {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    await releaseActiveTranscriptLease()
    resetProjectForTesting()
    tempDir = mkdtempSync(join(tmpdir(), 'session-archive-'))
    sessionId = randomUUID()
    switchSession(asSessionId(sessionId), tempDir)
  })

  afterEach(async () => {
    clearSessionMessagesCache()
    resetProjectForTesting()
    await releaseActiveTranscriptLease()
    switchSession(asSessionId(originalSessionId), originalProjectDir)
    rmSync(tempDir, { recursive: true, force: true })
  })

  /**
   * The whole point of archive is that it survives with no live engine for that
   * session, so the round trip through the transcript file IS the feature.
   *
   * Scope of this test: a transcript with no compaction boundary, which is read
   * whole. It does NOT exercise `scanPreBoundaryMetadata` — see the marker test
   * below for that half.
   */
  test('an archived session reads back as archived', async () => {
    const path = getTranscriptPathForSession(sessionId)
    await recordTranscript([createUserMessage({ content: 'hello' })])
    await flushCurrentTranscriptDurably()
    await setSessionArchived(sessionId, true, path)

    const { archived } = await loadTranscriptFile(path)
    expect(archived.get(sessionId)).toBe(true)
  })

  /**
   * Un-archiving writes `false`, which is a VALUE, not an absence — so it
   * cannot use the empty-string-means-cleared convention `tag` and
   * `custom-title` rely on. Last entry must win, or a session could never be
   * brought back out of the archive.
   */
  test('un-archiving wins over an earlier archive', async () => {
    const path = getTranscriptPathForSession(sessionId)
    await recordTranscript([createUserMessage({ content: 'hello' })])
    await flushCurrentTranscriptDurably()
    await setSessionArchived(sessionId, true, path)
    await setSessionArchived(sessionId, false, path)

    const { archived } = await loadTranscriptFile(path)
    expect(archived.get(sessionId)).toBe(false)
  })

  /**
   * `archived` must be in METADATA_TYPE_MARKERS or it is invisible on any
   * transcript with a compaction boundary. That scan (`scanPreBoundaryMetadata`)
   * only runs when a boundary truncated pre-boundary bytes, and its fast path
   * skips a whole chunk when it contains no marker — so a missing marker does
   * not fail loudly, it silently drops the flag on exactly the long sessions
   * most likely to be archived. Asserted structurally because the constant is
   * module-private and building a boundary fixture would not make the
   * invariant any clearer.
   */
  test('the archived entry is registered as a metadata marker', () => {
    const source = readFileSync(
      new URL('./sessionStorage.ts', import.meta.url),
      'utf8',
    )
    const markers = source.slice(
      source.indexOf('const METADATA_TYPE_MARKERS = ['),
      source.indexOf('const METADATA_MARKER_BUFS'),
    )
    expect(markers).toContain('"type":"archived"')
  })

  /** A session nobody archived must not appear archived. */
  test('an untouched session has no archive flag', async () => {
    const path = getTranscriptPathForSession(sessionId)
    await recordTranscript([createUserMessage({ content: 'hello' })])
    await flushCurrentTranscriptDurably()

    const { archived } = await loadTranscriptFile(path)
    expect(archived.get(sessionId)).toBeUndefined()
  })
})

describe('session storage', () => {
  const originalSessionId = getSessionId()
  const originalProjectDir = getSessionProjectDir()
  const originalTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE

  let tempDir: string
  let sessionId: string

  beforeEach(async () => {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    await releaseActiveTranscriptLease()
    resetProjectForTesting()
    tempDir = mkdtempSync(join(tmpdir(), 'session-storage-'))
    sessionId = randomUUID()
    switchSession(asSessionId(sessionId), tempDir)
  })

  afterEach(async () => {
    clearSessionMessagesCache()
    resetProjectForTesting()
    await releaseActiveTranscriptLease()
    switchSession(asSessionId(originalSessionId), originalProjectDir)
    if (originalTestPersistence === undefined) {
      delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    } else {
      process.env.TEST_ENABLE_SESSION_PERSISTENCE = originalTestPersistence
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('last session log normalizes legacy `agent` mode', async () => {
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
      mode: 'normal',
      firstPrompt: 'resume me',
    })
    expect(readFileSync(getTranscriptPathForSession(sessionId), 'utf8')).toContain(
      '"mode":"agent"',
    )
  })

  test('last session log preserves coordinator mode', async () => {
    const messageUuid = randomUUID()
    const timestamp = '2026-06-18T00:00:00.000Z'
    const transcript = [
      { type: 'mode', sessionId, mode: 'coordinator' },
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
        message: { role: 'user', content: 'resume coordinator' },
      },
    ]
      .map(entry => JSON.stringify(entry))
      .join('\n')

    await writeFile(getTranscriptPathForSession(sessionId), `${transcript}\n`)

    await expect(getLastSessionLog(sessionId as UUID)).resolves.toMatchObject({
      mode: 'coordinator',
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

  test('active tip survives restart until a branched turn is appended', async () => {
    const firstUser = createUserMessage({
      content: 'first prompt',
      uuid: randomUUID(),
    })
    const firstAssistant: AssistantMessage = {
      type: 'assistant',
      uuid: randomUUID(),
      timestamp: '2026-08-24T00:00:01.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'first answer' }],
      },
    }
    const discardedUser = createUserMessage({
      content: 'discarded prompt',
      uuid: randomUUID(),
    })
    const discardedAssistant: AssistantMessage = {
      type: 'assistant',
      uuid: randomUUID(),
      timestamp: '2026-08-24T00:00:03.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'discarded answer' }],
      },
    }

    await recordTranscript([
      firstUser,
      firstAssistant,
      discardedUser,
      discardedAssistant,
    ])
    await markActiveConversationTip(firstAssistant.uuid as UUID)
    resetProjectForTesting()
    clearSessionMessagesCache()

    const rewound = await getLastSessionLog(sessionId as UUID)
    expect(rewound?.messages.map(message => message.uuid)).toEqual([
      firstUser.uuid,
      firstAssistant.uuid,
    ])
    const explicitPath = await loadTranscriptFromFile(
      getTranscriptPathForSession(sessionId),
    )
    expect(explicitPath.messages.map(message => message.uuid)).toEqual([
      firstUser.uuid,
      firstAssistant.uuid,
    ])

    const branchedUser = createUserMessage({
      content: 'replacement prompt',
      uuid: randomUUID(),
    })
    const branchedAssistant: AssistantMessage = {
      type: 'assistant',
      uuid: randomUUID(),
      timestamp: '2026-08-24T00:00:05.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'replacement answer' }],
      },
    }
    await recordTranscript([
      firstUser,
      firstAssistant,
      branchedUser,
      branchedAssistant,
    ])
    await flushSessionStorage()
    resetProjectForTesting()
    clearSessionMessagesCache()

    const resumedBranch = await getLastSessionLog(sessionId as UUID)
    expect(resumedBranch?.messages.map(message => message.uuid)).toEqual([
      firstUser.uuid,
      firstAssistant.uuid,
      branchedUser.uuid,
      branchedAssistant.uuid,
    ])
  })

  test('a stale writer extending the discarded suffix cannot supersede the active tip', async () => {
    const firstUser = createUserMessage({
      content: 'first prompt',
      uuid: randomUUID(),
    })
    const firstAssistant: AssistantMessage = {
      type: 'assistant',
      uuid: randomUUID(),
      timestamp: '2026-08-24T00:20:01.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'first answer' }],
      },
    }
    const discardedUser = createUserMessage({
      content: 'discarded prompt',
      uuid: randomUUID(),
    })
    const discardedAssistant: AssistantMessage = {
      type: 'assistant',
      uuid: randomUUID(),
      timestamp: '2026-08-24T00:20:03.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'discarded answer' }],
      },
    }
    await recordTranscript([
      firstUser,
      firstAssistant,
      discardedUser,
      discardedAssistant,
    ])
    await markActiveConversationTip(firstAssistant.uuid as UUID)

    const staleWriterPrompt = createUserMessage({
      content: 'stale writer prompt',
      uuid: randomUUID(),
    })
    await recordTranscript([
      firstUser,
      firstAssistant,
      discardedUser,
      discardedAssistant,
      staleWriterPrompt,
    ])
    await flushSessionStorage()
    resetProjectForTesting()
    clearSessionMessagesCache()

    const resumed = await getLastSessionLog(sessionId as UUID)
    expect(resumed?.messages.map(message => message.uuid)).toEqual([
      firstUser.uuid,
      firstAssistant.uuid,
    ])
  })

  test('null active tip resumes with empty retained context', async () => {
    const prompt = createUserMessage({
      content: 'only prompt',
      uuid: randomUUID(),
    })
    const answer: AssistantMessage = {
      type: 'assistant',
      uuid: randomUUID(),
      timestamp: '2026-08-24T00:10:01.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'only answer' }],
      },
    }
    await recordTranscript([prompt, answer])
    await markActiveConversationTip(null)
    resetProjectForTesting()
    clearSessionMessagesCache()

    const resumed = await getLastSessionLog(sessionId as UUID)
    expect(resumed).not.toBeNull()
    expect(resumed?.messages).toEqual([])
  })

  test('active tip selects a retained chain through large-transcript pruning', async () => {
    const firstUserUuid = randomUUID()
    const firstAssistantUuid = randomUUID()
    const discardedUserUuid = randomUUID()
    const discardedAssistantUuid = randomUUID()
    const base = {
      isSidechain: false,
      sessionId,
      cwd: tempDir,
      version: 'test',
    }
    const entries = [
      {
        parentUuid: null,
        ...base,
        type: 'user',
        uuid: firstUserUuid,
        userType: 'external',
        timestamp: '2026-08-24T01:00:00.000Z',
        message: { role: 'user', content: 'retained prompt' },
      },
      {
        parentUuid: firstUserUuid,
        ...base,
        type: 'assistant',
        uuid: firstAssistantUuid,
        timestamp: '2026-08-24T01:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'retained answer' }],
        },
      },
      {
        parentUuid: firstAssistantUuid,
        ...base,
        type: 'user',
        uuid: discardedUserUuid,
        userType: 'external',
        timestamp: '2026-08-24T01:00:02.000Z',
        message: { role: 'user', content: 'discarded prompt' },
      },
      {
        parentUuid: discardedUserUuid,
        ...base,
        type: 'assistant',
        uuid: discardedAssistantUuid,
        timestamp: '2026-08-24T01:00:03.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'x'.repeat(6 * 1024 * 1024) }],
        },
      },
      {
        type: 'active-conversation-tip',
        sessionId,
        tipUuid: firstAssistantUuid,
      },
    ]
    await writeFile(
      getTranscriptPathForSession(sessionId),
      `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`,
    )

    const resumed = await getLastSessionLog(sessionId as UUID)
    expect(resumed?.messages.map(message => message.uuid)).toEqual([
      firstUserUuid,
      firstAssistantUuid,
    ])
  })

  test('invalid active-tip markers fail safely to the newest main leaf', async () => {
    const userUuid = randomUUID()
    const assistantUuid = randomUUID()
    const sidechainUuid = randomUUID()
    const path = getTranscriptPathForSession(sessionId)
    const messages = [
      {
        parentUuid: null,
        isSidechain: false,
        type: 'user',
        uuid: userUuid,
        timestamp: '2026-08-24T02:00:00.000Z',
        message: { role: 'user', content: 'main prompt' },
        sessionId,
        cwd: tempDir,
        userType: 'external',
        version: 'test',
      },
      {
        parentUuid: userUuid,
        isSidechain: false,
        type: 'assistant',
        uuid: assistantUuid,
        timestamp: '2026-08-24T02:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'main answer' }],
        },
        sessionId,
        cwd: tempDir,
        version: 'test',
      },
      {
        parentUuid: null,
        isSidechain: true,
        type: 'assistant',
        uuid: sidechainUuid,
        timestamp: '2026-08-24T02:00:02.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'sidechain answer' }],
        },
        sessionId,
        cwd: tempDir,
        version: 'test',
      },
    ]

    for (const marker of [
      { type: 'active-conversation-tip', sessionId, tipUuid: 'malformed' },
      { type: 'active-conversation-tip', sessionId, tipUuid: randomUUID() },
      { type: 'active-conversation-tip', sessionId, tipUuid: sidechainUuid },
    ]) {
      await writeFile(
        path,
        `${[...messages, marker]
          .map(entry => JSON.stringify(entry))
          .join('\n')}\n`,
      )
      clearSessionMessagesCache()
      const resumed = await getLastSessionLog(sessionId as UUID)
      expect(resumed?.messages.map(message => message.uuid)).toEqual([
        userUuid,
        assistantUuid,
      ])
    }
  })

  test('concurrent tombstones serialize their transcript rewrites', async () => {
    const first = randomUUID()
    const second = randomUUID()
    const surviving = randomUUID()
    const filePath = join(tempDir, 'tombstone-race.jsonl')
    writeFileSync(
      filePath,
      [first, second, surviving]
        .map(uuid => JSON.stringify({ type: 'assistant', uuid, sessionId }))
        .join('\n') + '\n',
    )
    setSessionFileForTesting(filePath)

    await Promise.all([
      removeTranscriptMessage(first as UUID),
      removeTranscriptMessage(second as UUID),
    ])

    const remaining = (await Bun.file(filePath).text())
      .trim()
      .split('\n')
      .map(line => (JSON.parse(line) as { uuid: string }).uuid)
    expect(remaining).toEqual([surviving])
  })

  test('last session log restores metadata across legacy mixed session stamps', async () => {
    const intermediateSessionId = randomUUID()
    const leafSessionId = randomUUID()
    const userUuid = randomUUID()
    const assistantUuid = randomUUID()
    const transcript = [
      { type: 'custom-title', sessionId, customTitle: 'title before login' },
      { type: 'tag', sessionId, tag: 'before-login' },
      { type: 'agent-setting', sessionId, agentSetting: 'plan' },
      { type: 'mode', sessionId, mode: 'plan' },
      {
        type: 'content-replacement',
        sessionId,
        replacements: [
          { kind: 'tool-result', toolUseId: 'before', replacement: 'old stub' },
        ],
      },
      {
        type: 'user',
        uuid: userUuid,
        parentUuid: null,
        isSidechain: false,
        sessionId,
        cwd: tempDir,
        userType: 'external',
        version: 'test',
        timestamp: '2026-07-31T09:11:24.000Z',
        message: { role: 'user', content: 'before login' },
      },
      { type: 'custom-title', sessionId: intermediateSessionId, customTitle: 'title after login' },
      { type: 'tag', sessionId: intermediateSessionId, tag: 'after-login' },
      { type: 'mode', sessionId: intermediateSessionId, mode: 'agent' },
      {
        type: 'content-replacement',
        sessionId: intermediateSessionId,
        replacements: [
          { kind: 'tool-result', toolUseId: 'after', replacement: 'new stub' },
        ],
      },
      {
        type: 'content-replacement',
        sessionId,
        replacements: [
          { kind: 'tool-result', toolUseId: 'latest', replacement: 'latest stub' },
        ],
      },
      {
        type: 'assistant',
        uuid: assistantUuid,
        parentUuid: userUuid,
        isSidechain: false,
        sessionId: leafSessionId,
        cwd: tempDir,
        version: 'test',
        timestamp: '2026-07-31T09:11:25.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'after login' }],
        },
      },
    ]
      .map(entry => JSON.stringify(entry))
      .join('\n')

    await writeFile(getTranscriptPathForSession(sessionId), `${transcript}\n`)

    const log = await getLastSessionLog(sessionId as UUID)
    expect(log).toMatchObject({
      customTitle: 'title after login',
      tag: 'after-login',
      agentSetting: 'plan',
      mode: 'normal',
    })
    expect(log?.contentReplacements).toEqual([
      { kind: 'tool-result', toolUseId: 'before', replacement: 'old stub' },
      { kind: 'tool-result', toolUseId: 'after', replacement: 'new stub' },
      { kind: 'tool-result', toolUseId: 'latest', replacement: 'latest stub' },
    ])
  })

  test('provider account refresh keeps the owned transcript path and record stamps stable', async () => {
    const beforeUuid = randomUUID()
    const afterUuid = randomUUID()
    const initialApiSessionId = getAPISessionId()
    const transcriptPath = getTranscriptPathForSession(sessionId)

    await recordTranscript([
      createUserMessage({ content: 'before account refresh', uuid: beforeUuid }),
    ])
    await flushSessionStorage()

    applyPostCodexAccountSwitchRefresh()
    expect(getSessionId()).toBe(sessionId)
    expect(getAPISessionId()).not.toBe(initialApiSessionId)
    expect(getTranscriptPathForSession(getSessionId())).toBe(transcriptPath)

    await recordTranscript([
      createUserMessage({ content: 'after account refresh', uuid: afterUuid }),
    ])
    await flushSessionStorage()

    const entries = (await Bun.file(transcriptPath).text())
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>)
    const writtenTurns = entries.filter(
      entry => entry.uuid === beforeUuid || entry.uuid === afterUuid,
    )
    expect(writtenTurns).toHaveLength(2)
    expect(writtenTurns.map(entry => entry.sessionId)).toEqual([
      sessionId,
      sessionId,
    ])
    expect(
      readdirSync(dirname(transcriptPath)).filter(name => name.endsWith('.jsonl')),
    ).toEqual([`${sessionId}.jsonl`])
  })

  test('display history crosses compact boundaries without changing the resume chain', async () => {
    const beforeUserUuid = randomUUID()
    const beforeAssistantUuid = randomUUID()
    const boundaryUuid = randomUUID()
    const summaryUuid = randomUUID()
    const commandUuid = randomUUID()
    const transcript = [
      {
        type: 'user',
        uuid: beforeUserUuid,
        parentUuid: null,
        isSidechain: false,
        sessionId,
        cwd: tempDir,
        userType: 'external',
        version: 'test',
        timestamp: '2026-07-31T17:59:00.000Z',
        message: { role: 'user', content: 'recognizable archival prompt' },
      },
      {
        type: 'assistant',
        uuid: beforeAssistantUuid,
        parentUuid: beforeUserUuid,
        isSidechain: false,
        sessionId,
        cwd: tempDir,
        version: 'test',
        timestamp: '2026-07-31T17:59:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'recognizable archival response' }],
        },
      },
      {
        type: 'system',
        subtype: 'compact_boundary',
        content: 'Conversation compacted',
        level: 'info',
        isMeta: false,
        uuid: boundaryUuid,
        parentUuid: null,
        logicalParentUuid: beforeAssistantUuid,
        isSidechain: false,
        sessionId,
        cwd: tempDir,
        version: 'test',
        timestamp: '2026-07-31T18:00:16.000Z',
        compactMetadata: { trigger: 'manual', preTokens: 316_672 },
      },
      {
        type: 'user',
        uuid: summaryUuid,
        parentUuid: boundaryUuid,
        isSidechain: false,
        sessionId,
        cwd: tempDir,
        userType: 'external',
        version: 'test',
        timestamp: '2026-07-31T18:00:17.000Z',
        isCompactSummary: true,
        message: { role: 'user', content: 'compact model summary' },
      },
      {
        type: 'user',
        uuid: commandUuid,
        parentUuid: summaryUuid,
        isSidechain: false,
        sessionId,
        cwd: tempDir,
        userType: 'external',
        version: 'test',
        timestamp: '2026-07-31T18:00:18.000Z',
        message: { role: 'user', content: '<command-name>/compact</command-name>' },
      },
    ]
      .map(entry => JSON.stringify(entry))
      .join('\n')
    const path = getTranscriptPathForSession(sessionId)
    await writeFile(path, `${transcript}\n`)

    const resume = await getLastSessionLog(sessionId as UUID)
    expect(JSON.stringify(resume?.messages)).not.toContain(
      'recognizable archival prompt',
    )

    const display = await loadDisplayTranscriptFromJsonlPath(path, {
      maxMessages: 100,
      maxBytes: 1024 * 1024,
    })
    expect(display.truncated).toBe(false)
    expect(display.messages.map(message => message.uuid)).toEqual([
      beforeUserUuid,
      beforeAssistantUuid,
      boundaryUuid,
      summaryUuid,
      commandUuid,
    ])
  })

  test('display history keeps preserved segments once and places them after the compact seam', async () => {
    const archivalUuid = randomUUID()
    const preservedHeadUuid = randomUUID()
    const preservedTailUuid = randomUUID()
    const boundaryUuid = randomUUID()
    const summaryUuid = randomUUID()
    const postCompactUuid = randomUUID()
    const transcript = [
      {
        type: 'user',
        uuid: archivalUuid,
        parentUuid: null,
        isSidechain: false,
        sessionId,
        cwd: tempDir,
        userType: 'external',
        version: 'test',
        timestamp: '2026-07-31T17:59:00.000Z',
        message: { role: 'user', content: 'archival prefix' },
      },
      {
        type: 'user',
        uuid: preservedHeadUuid,
        parentUuid: archivalUuid,
        isSidechain: false,
        sessionId,
        cwd: tempDir,
        userType: 'external',
        version: 'test',
        timestamp: '2026-07-31T17:59:01.000Z',
        message: { role: 'user', content: 'preserved head' },
      },
      {
        type: 'assistant',
        uuid: preservedTailUuid,
        parentUuid: preservedHeadUuid,
        isSidechain: false,
        sessionId,
        cwd: tempDir,
        version: 'test',
        timestamp: '2026-07-31T17:59:02.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'preserved tail' }],
        },
      },
      {
        type: 'system',
        subtype: 'compact_boundary',
        content: 'Conversation compacted',
        level: 'info',
        isMeta: false,
        uuid: boundaryUuid,
        parentUuid: null,
        logicalParentUuid: preservedTailUuid,
        isSidechain: false,
        sessionId,
        cwd: tempDir,
        version: 'test',
        timestamp: '2026-07-31T18:00:16.000Z',
        compactMetadata: {
          trigger: 'auto',
          preTokens: 180_000,
          preservedSegment: {
            headUuid: preservedHeadUuid,
            anchorUuid: summaryUuid,
            tailUuid: preservedTailUuid,
          },
        },
      },
      {
        type: 'user',
        uuid: summaryUuid,
        parentUuid: boundaryUuid,
        isSidechain: false,
        sessionId,
        cwd: tempDir,
        userType: 'external',
        version: 'test',
        timestamp: '2026-07-31T18:00:17.000Z',
        isCompactSummary: true,
        message: { role: 'user', content: 'compact model summary' },
      },
      {
        type: 'user',
        uuid: postCompactUuid,
        parentUuid: preservedTailUuid,
        isSidechain: false,
        sessionId,
        cwd: tempDir,
        userType: 'external',
        version: 'test',
        timestamp: '2026-07-31T18:00:18.000Z',
        message: { role: 'user', content: 'post compact turn' },
      },
    ]
      .map(entry => JSON.stringify(entry))
      .join('\n')
    const path = getTranscriptPathForSession(sessionId)
    await writeFile(path, `${transcript}\n`)

    const resume = await getLastSessionLog(sessionId as UUID)
    expect(resume?.messages.map(message => message.uuid)).toEqual([
      boundaryUuid,
      summaryUuid,
      preservedHeadUuid,
      preservedTailUuid,
      postCompactUuid,
    ])

    const display = await loadDisplayTranscriptFromJsonlPath(path, {
      maxMessages: 100,
      maxBytes: 1024 * 1024,
    })
    expect(display.truncated).toBe(false)
    expect(display.messages.map(message => message.uuid)).toEqual([
      archivalUuid,
      boundaryUuid,
      summaryUuid,
      preservedHeadUuid,
      preservedTailUuid,
      postCompactUuid,
    ])
  })

  test('explicit preserved-message membership relinks without a legacy segment', async () => {
    const archivalUuid = randomUUID()
    const preservedHeadUuid = randomUUID()
    const preservedTailUuid = randomUUID()
    const boundaryUuid = randomUUID()
    const summaryUuid = randomUUID()
    const postCompactUuid = randomUUID()
    const base = {
      isSidechain: false,
      sessionId,
      cwd: tempDir,
      version: 'test',
    }
    const transcript = [
      {
        ...base,
        type: 'user',
        uuid: archivalUuid,
        parentUuid: null,
        userType: 'external',
        timestamp: '2026-08-12T09:00:00.000Z',
        message: { role: 'user', content: 'archival prefix' },
      },
      {
        ...base,
        type: 'user',
        uuid: preservedHeadUuid,
        parentUuid: archivalUuid,
        userType: 'external',
        timestamp: '2026-08-12T09:00:01.000Z',
        message: { role: 'user', content: 'preserved head' },
      },
      {
        ...base,
        type: 'assistant',
        uuid: preservedTailUuid,
        parentUuid: preservedHeadUuid,
        timestamp: '2026-08-12T09:00:02.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'preserved tail' }],
        },
      },
      {
        ...base,
        type: 'system',
        subtype: 'compact_boundary',
        content: 'Conversation compacted',
        level: 'info',
        isMeta: false,
        uuid: boundaryUuid,
        parentUuid: null,
        logicalParentUuid: preservedTailUuid,
        timestamp: '2026-08-12T09:00:03.000Z',
        // No preservedSegment: only the explicit membership written by
        // annotateBoundaryWithPreservedSegment for new compactions.
        compactMetadata: {
          trigger: 'auto',
          preTokens: 180_000,
          preservedMessages: {
            anchorUuid: summaryUuid,
            durableUuids: [preservedHeadUuid, preservedTailUuid],
          },
        },
      },
      {
        ...base,
        type: 'user',
        uuid: summaryUuid,
        parentUuid: boundaryUuid,
        userType: 'external',
        timestamp: '2026-08-12T09:00:04.000Z',
        isCompactSummary: true,
        message: { role: 'user', content: 'compact model summary' },
      },
      {
        ...base,
        type: 'user',
        uuid: postCompactUuid,
        parentUuid: preservedTailUuid,
        userType: 'external',
        timestamp: '2026-08-12T09:00:05.000Z',
        message: { role: 'user', content: 'post compact turn' },
      },
    ]
      .map(entry => JSON.stringify(entry))
      .join('\n')
    const path = getTranscriptPathForSession(sessionId)
    await writeFile(path, `${transcript}\n`)

    const resume = await getLastSessionLog(sessionId as UUID)
    expect(resume?.messages.map(message => message.uuid)).toEqual([
      boundaryUuid,
      summaryUuid,
      preservedHeadUuid,
      preservedTailUuid,
      postCompactUuid,
    ])
    // The summarized prefix is still pruned from the resume chain.
    expect(resume?.messages.map(message => message.uuid)).not.toContain(
      archivalUuid,
    )
  })

  test('writer and boundary metadata agree when a preserved REPL-only message is dropped', async () => {
    const { annotateBoundaryWithPreservedSegment } = await import(
      '../services/compact/compact.js'
    )
    const { createCompactBoundaryMessage } = await import('./messages.js')
    const archival = createUserMessage({
      content: 'archival prefix',
      uuid: '10000000-0000-4000-8000-000000000001',
    })
    const replOnly = {
      type: 'assistant',
      uuid: '20000000-0000-4000-8000-000000000002',
      timestamp: '2026-08-13T09:00:01.000Z',
      message: {
        id: 'repl-only-message',
        model: 'gpt-5.6-terra',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'repl-only-tool-use',
            name: 'REPL',
            input: { code: '1 + 1' },
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        stop_reason: 'tool_use',
        stop_sequence: null,
      },
    } as AssistantMessage
    const durable = createUserMessage({
      content: 'preserved durable turn',
      uuid: '30000000-0000-4000-8000-000000000003',
    })
    const originalMessages = [archival, replOnly, durable]
    await recordTranscript(
      originalMessages,
      undefined,
      undefined,
      originalMessages,
    )

    const summary = createUserMessage({
      content: 'compact model summary',
      uuid: '40000000-0000-4000-8000-000000000004',
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    })
    const rawBoundary = createCompactBoundaryMessage(
      'auto',
      180_000,
      durable.uuid,
    )
    const boundary = annotateBoundaryWithPreservedSegment(
      rawBoundary,
      summary.uuid,
      [replOnly, durable],
      originalMessages,
    )
    expect(boundary.compactMetadata.preservedMessages).toEqual({
      anchorUuid: summary.uuid,
      durableUuids: [durable.uuid],
      liveUuids: [replOnly.uuid, durable.uuid],
    })

    const compactedMessages = [boundary, summary, replOnly, durable]
    await recordTranscript(
      compactedMessages,
      undefined,
      undefined,
      compactedMessages,
    )
    await flushCurrentTranscriptDurably()
    clearSessionMessagesCache()

    const resume = await getLastSessionLog(sessionId as UUID)
    expect(resume?.messages.map(message => message.uuid)).toEqual([
      boundary.uuid,
      summary.uuid,
      durable.uuid,
    ])
    expect(resume?.messages.map(message => message.uuid)).not.toContain(
      archival.uuid,
    )
    expect(resume?.messages.map(message => message.uuid)).not.toContain(
      replOnly.uuid,
    )
  })

  test('display history retains summarized rows around a prefix-preserved compact seam', async () => {
    const preservedUuid = randomUUID()
    const summarizedUuid = randomUUID()
    const boundaryUuid = randomUUID()
    const summaryUuid = randomUUID()
    const postCompactUuid = randomUUID()
    const transcript = [
      {
        type: 'user',
        uuid: preservedUuid,
        parentUuid: null,
        isSidechain: false,
        sessionId,
        cwd: tempDir,
        userType: 'external',
        version: 'test',
        timestamp: '2026-07-31T17:58:00.000Z',
        message: { role: 'user', content: 'prefix retained by the model' },
      },
      {
        type: 'assistant',
        uuid: summarizedUuid,
        parentUuid: preservedUuid,
        isSidechain: false,
        sessionId,
        cwd: tempDir,
        version: 'test',
        timestamp: '2026-07-31T17:58:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'row summarized by compaction' }],
        },
      },
      {
        type: 'system',
        subtype: 'compact_boundary',
        content: 'Conversation compacted',
        level: 'info',
        isMeta: false,
        uuid: boundaryUuid,
        parentUuid: null,
        logicalParentUuid: summarizedUuid,
        isSidechain: false,
        sessionId,
        cwd: tempDir,
        version: 'test',
        timestamp: '2026-07-31T18:00:16.000Z',
        compactMetadata: {
          trigger: 'manual',
          preTokens: 180_000,
          preservedSegment: {
            headUuid: preservedUuid,
            anchorUuid: boundaryUuid,
            tailUuid: preservedUuid,
          },
        },
      },
      {
        type: 'user',
        uuid: summaryUuid,
        parentUuid: boundaryUuid,
        isSidechain: false,
        sessionId,
        cwd: tempDir,
        userType: 'external',
        version: 'test',
        timestamp: '2026-07-31T18:00:17.000Z',
        isCompactSummary: true,
        message: { role: 'user', content: 'summary after retained prefix' },
      },
      {
        type: 'user',
        uuid: postCompactUuid,
        parentUuid: summaryUuid,
        isSidechain: false,
        sessionId,
        cwd: tempDir,
        userType: 'external',
        version: 'test',
        timestamp: '2026-07-31T18:00:18.000Z',
        message: { role: 'user', content: 'post compact turn' },
      },
    ]
      .map(entry => JSON.stringify(entry))
      .join('\n')
    const path = getTranscriptPathForSession(sessionId)
    await writeFile(path, `${transcript}\n`)

    const display = await loadDisplayTranscriptFromJsonlPath(path, {
      maxMessages: 100,
      maxBytes: 1024 * 1024,
    })
    expect(display.truncated).toBe(false)
    expect(display.messages.map(message => message.uuid)).toEqual([
      summarizedUuid,
      boundaryUuid,
      preservedUuid,
      summaryUuid,
      postCompactUuid,
    ])
    expect(new Set(display.messages.map(message => message.uuid)).size).toBe(
      display.messages.length,
    )
  })

  test('display history keeps a newest contiguous tail when message-capped', async () => {
    const uuids = Array.from({ length: 5 }, () => randomUUID())
    const transcript = uuids
      .map((uuid, index) =>
        JSON.stringify({
          type: 'user',
          uuid,
          parentUuid: index === 0 ? null : uuids[index - 1],
          isSidechain: false,
          sessionId,
          cwd: tempDir,
          userType: 'external',
          version: 'test',
          timestamp: `2026-07-31T18:00:0${index}.000Z`,
          message: { role: 'user', content: `message ${index}` },
        }),
      )
      .join('\n')
    const path = getTranscriptPathForSession(sessionId)
    await writeFile(path, `${transcript}\n`)

    const display = await loadDisplayTranscriptFromJsonlPath(path, {
      maxMessages: 2,
      maxBytes: 1024 * 1024,
    })
    expect(display.truncated).toBe(true)
    expect(display.messages.map(message => message.uuid)).toEqual(uuids.slice(-2))
  })

  test('display history bounds the JSONL read and announces a missing predecessor', async () => {
    const uuids = Array.from({ length: 5 }, () => randomUUID())
    const lines = uuids.map((uuid, index) =>
      JSON.stringify({
        type: 'user',
        uuid,
        parentUuid: index === 0 ? null : uuids[index - 1],
        isSidechain: false,
        sessionId,
        cwd: tempDir,
        userType: 'external',
        version: 'test',
        timestamp: `2026-07-31T18:01:0${index}.000Z`,
        message: { role: 'user', content: `bounded message ${index}` },
      }),
    )
    const path = getTranscriptPathForSession(sessionId)
    await writeFile(path, `${lines.join('\n')}\n`)
    const newestTwoBytes = Buffer.byteLength(`${lines.slice(-2).join('\n')}\n`)

    const display = await loadDisplayTranscriptFromJsonlPath(path, {
      maxMessages: 100,
      maxBytes: newestTwoBytes + 5,
    })
    expect(display.truncated).toBe(true)
    expect(display.messages.map(message => message.uuid)).toEqual(uuids.slice(-2))
  })

  test('display history retains the first complete record at an exact byte boundary', async () => {
    const uuids = Array.from({ length: 3 }, () => randomUUID())
    const lines = uuids.map((uuid, index) =>
      JSON.stringify({
        type: 'user',
        uuid,
        parentUuid: index === 0 ? null : uuids[index - 1],
        isSidechain: false,
        sessionId,
        cwd: tempDir,
        userType: 'external',
        version: 'test',
        timestamp: `2026-07-31T18:02:0${index}.000Z`,
        message: { role: 'user', content: `aligned message ${index}` },
      }),
    )
    const path = getTranscriptPathForSession(sessionId)
    await writeFile(path, `${lines.join('\n')}\n`)

    const display = await loadDisplayTranscriptFromJsonlPath(path, {
      maxMessages: 100,
      maxBytes: Buffer.byteLength(`${lines.slice(-2).join('\n')}\n`),
    })

    expect(display.truncated).toBe(true)
    expect(display.messages.map(message => message.uuid)).toEqual(uuids.slice(-2))
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

  test('enrichment retains the transcript entrypoint for catalog eligibility', async () => {
    const transcript = {
      type: 'user',
      uuid: randomUUID(),
      parentUuid: null,
      isSidechain: false,
      sessionId,
      cwd: tempDir,
      userType: 'external',
      entrypoint: 'sdk-cli',
      version: 'test',
      timestamp: '2026-08-26T13:17:28.345Z',
      message: { role: 'user', content: 'generate an image' },
    }
    const path = getTranscriptPathForSession(sessionId)
    await writeFile(path, `${JSON.stringify(transcript)}\n`)

    const { logs } = await enrichLogs(await getSessionFilesLite(tempDir), 0, 1)
    expect(logs).toHaveLength(1)
    expect(logs[0]?.entrypoint).toBe('sdk-cli')
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

  describe('post-turn stall diagnostics', () => {
    const stallEntry = {
      phase: 'tool_use_summary' as const,
      threshold_ms: 60_000,
      turn_count: 2,
      query_source: 'repl_main_thread',
    }

    test('no owning session writes nothing', () => {
      expect(readdirSync(tempDir)).toHaveLength(0)

      recordPostTurnStall(stallEntry)

      expect(existsSync(getTranscriptPathForSession(sessionId))).toBe(false)
      expect(readdirSync(tempDir)).toHaveLength(0)
    })

    test('an owning session records the phase', async () => {
      await recordTranscript([
        createUserMessage({ content: 'real turn', uuid: randomUUID() }),
      ])
      await flushSessionStorage()

      recordPostTurnStall(stallEntry)

      const text = await Bun.file(getTranscriptPathForSession(sessionId)).text()
      expect(text).toContain('"subtype":"post_turn_stall"')
      expect(text).toContain('"phase":"tool_use_summary"')
      expect(text).toContain('"threshold_ms":60000')
    })
  })

  describe('run facts', () => {
    const facts = {
      model: 'gpt-5.6-luna',
      permissionMode: 'auto',
      effort: 'high',
      contextWindow: 372_000,
    }

    beforeEach(() => {
      resetRunFactsDedupeForTest()
    })

    test('no owning session writes nothing', () => {
      expect(readdirSync(tempDir)).toHaveLength(0)

      recordRunFacts(facts)

      expect(existsSync(getTranscriptPathForSession(sessionId))).toBe(false)
      expect(readdirSync(tempDir)).toHaveLength(0)
    })

    test('an owning session writes all four facts as one record', async () => {
      await recordTranscript([
        createUserMessage({ content: 'real turn', uuid: randomUUID() }),
      ])
      await flushSessionStorage()

      recordRunFacts(facts)

      const text = await Bun.file(getTranscriptPathForSession(sessionId)).text()
      const line = text
        .split('\n')
        .find(l => l.includes('"subtype":"run_facts"'))
      expect(line).toBeDefined()
      // One record carries all four, which is the point: a reader takes the
      // snapshot whole instead of pairing facts from turns that never coexisted.
      const record = JSON.parse(line!)
      expect(record.model).toBe('gpt-5.6-luna')
      expect(record.permissionMode).toBe('auto')
      expect(record.effort).toBe('high')
      expect(record.contextWindow).toBe(372_000)
    })

    test('an unchanged run records once; a change records again', async () => {
      await recordTranscript([
        createUserMessage({ content: 'real turn', uuid: randomUUID() }),
      ])
      await flushSessionStorage()

      recordRunFacts(facts)
      recordRunFacts(facts)
      recordRunFacts({ ...facts, effort: 'low' })

      const text = await Bun.file(getTranscriptPathForSession(sessionId)).text()
      const written = text
        .split('\n')
        .filter(l => l.includes('"subtype":"run_facts"'))
      expect(written).toHaveLength(2)
      expect(written[1]).toContain('"effort":"low"')
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

/**
 * Anything the operator types mid-turn is drained into a `queued_command`
 * attachment and IS sent to the model (attachments.ts
 * getQueuedCommandAttachments, drained in query.ts). The transcript used to
 * drop every attachment for non-ant users, and `scripts/build.ts` hard-defines
 * USER_TYPE='external', so the drop was total: a corpus sweep of 2,060
 * transcripts / 354,456 entries in ~/.cat-code/projects found zero attachment
 * entries. That means the transcript did not record what the model was
 * actually told, and a resumed prefix could not match what was cached.
 *
 * The round trip through the file is the test: the write path (isLoggableMessage
 * inside recordTranscript) and the read path (isTranscriptMessage, which already
 * admits 'attachment' into the parentUuid chain) have to agree.
 */
describe('attachment persistence', () => {
  const originalSessionId = getSessionId()
  const originalProjectDir = getSessionProjectDir()
  let tempDir: string
  let sessionId: UUID

  beforeEach(async () => {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    await releaseActiveTranscriptLease()
    resetProjectForTesting()
    tempDir = mkdtempSync(join(tmpdir(), 'attachment-persist-'))
    sessionId = randomUUID()
    switchSession(asSessionId(sessionId), tempDir)
  })

  afterEach(async () => {
    clearSessionMessagesCache()
    resetProjectForTesting()
    await releaseActiveTranscriptLease()
    switchSession(asSessionId(originalSessionId), originalProjectDir)
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('a queued command typed mid-turn survives to the transcript', async () => {
    // Built by the real producer, not a hand-written shape — the defect is
    // about what this exact path emits.
    const attachments = await getQueuedCommandAttachments([
      { value: 'also check the sidecar', mode: 'prompt', uuid: randomUUID() },
    ])
    expect(attachments).toHaveLength(1)

    await recordTranscript([
      createUserMessage({ content: 'first prompt' }),
      createAttachmentMessage(attachments[0]!),
    ])
    await flushCurrentTranscriptDurably()

    const { messages } = await loadTranscriptFile(
      getTranscriptPathForSession(sessionId),
    )
    const loaded = [...messages.values()]
    const attachment = loaded.find(m => m.type === 'attachment')
    expect(attachment).toBeDefined()
    expect(attachment).toMatchObject({
      attachment: { type: 'queued_command', prompt: 'also check the sidecar' },
    })
  })

  /**
   * hooks.ts:721 writes `content: ''` for the ordinary silent hook success on
   * purpose, so persisting those would add a row per hook per turn carrying no
   * information. Upstream drops exactly this one shape and nothing else (its
   * attachment denylist has been `new Set([])` since at least 2.1.214).
   */
  test('a silent hook_success is dropped, one with output is kept', async () => {
    const base = {
      type: 'hook_success' as const,
      hookName: 'PreToolUse:Bash',
      toolUseID: 'toolu_test',
      hookEvent: 'PreToolUse' as const,
      exitCode: 0,
    }

    await recordTranscript([
      createUserMessage({ content: 'first prompt' }),
      createAttachmentMessage({ ...base, content: '', stdout: '', stderr: '' }),
      createAttachmentMessage({ ...base, content: '', stdout: 'noisy hook\n', stderr: '' }),
    ])
    await flushCurrentTranscriptDurably()

    const { messages } = await loadTranscriptFile(
      getTranscriptPathForSession(sessionId),
    )
    const attachments = [...messages.values()].filter(
      m => m.type === 'attachment',
    )
    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({
      attachment: { stdout: 'noisy hook\n' },
    })
  })
})
