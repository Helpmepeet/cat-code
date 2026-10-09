/**
 * IS-A — the at-rest transcript cache (docs/migration/specs/
 * 2026-07-14-instant-session-open-design.md M1 + implementation-plan IS-A).
 *
 * Covers the security-load-bearing behavior: the distill ALLOWLIST (transcript
 * frames survive; ready / permission / every snapshot are dropped), the atomic
 * write→read round-trip with 0600 perms, the FAIL-CLOSED read (oversize /
 * corrupt / schema-drift / version mismatch / secret hit ⇒ null + file deleted),
 * and the pure `resolvePreview` boundary (an id the host does not vouch for never
 * reads disk).
 */

import { afterEach, expect, test } from 'bun:test'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PROTOCOL_VERSION,
  HISTORY_REPLAY_TRUNCATION_REQUEST_ID,
  PREVIEW_REPLAY_TRUNCATION_REQUEST_ID,
  REPLAY_BUFFER_TRUNCATION_REQUEST_ID,
  type ServerFrame,
  type SessionId,
  type TranscriptCache,
} from '../shared/protocol.js'
import {
  MAX_TRANSCRIPT_CACHE_BYTES,
  TRANSCRIPT_CACHE_GUARD_VERSION,
  TRANSCRIPT_CACHE_RUN_FACTS_VERSION,
  buildClosedSessionCache,
  cacheHasCurrentRunFacts,
  cacheWrittenAt,
  createTranscriptCache,
  deleteCache,
  distill,
  listCachedSessionIds,
  readCache,
  readCachedHeader,
  readCachedRunFacts,
  retainCachedImagePreviews,
  transcriptCacheDir,
  resolveCacheRunFacts,
  resolvePreview,
  writeCache,
} from './transcriptCache.js'
import { FrameReplayBuffer, STICKY_FRAME_KINDS } from './replayBuffer.js'
import { persistTranscriptBackfillResult } from './transcriptBackfill.js'
import { sessionDescriptorFixture } from '../shared/sessionDescriptor.fixture.js'
import { readTranscriptRunFacts } from '../shared/transcriptRunFacts.js'
import { CODEX_CACHE_IDLE_ESTIMATE_MS } from '../shared/promptCacheEstimate.js'
import { projectPreviewTranscriptCache } from '../renderer/src/previewTranscriptState.js'
import { SDK_MESSAGE_FIXTURE } from '../renderer/src/sdkMessageFixtures.js'

const SID: SessionId = '11111111-1111-4111-8111-111111111111'
/** A session with no cache file at all. */
const OTHER_SID: SessionId = '33333333-3333-4333-8333-333333333333'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'catcode-cache-'))
  tempDirs.push(dir)
  return dir
}

function cachePath(dir: string, id: SessionId = SID): string {
  return join(dir, `${id}.json`)
}

/* --- frame fixtures (the `as never` payloads follow historyReplayReload.test) --- */

function readyFrame(id: SessionId = SID, engine = 'engine-abc'): ServerFrame {
  return {
    kind: 'ready',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: id,
    engineSessionId: engine,
    payload: { type: 'app.ready' } as never,
  }
}

function eventFrame(i: number, id: SessionId = SID): ServerFrame {
  return {
    kind: 'event',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: id,
    event: {
      type: 'message',
      message: {
        type: 'user',
        message: { role: 'user', content: `msg ${i}` },
      },
    } as never,
  }
}

function imageToolFrame(toolUseId = 'toolu_image'): ServerFrame {
  return {
    kind: 'event',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SID,
    event: {
      type: 'message',
      message: {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: toolUseId, name: 'GenerateImage', input: {} }],
        },
      },
    } as never,
  }
}

function permissionFrame(id: SessionId = SID): ServerFrame {
  return {
    kind: 'permission.context',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: id,
    context: { mode: 'default' } as never,
  }
}

function settingsSnapshotFrame(id: SessionId = SID): ServerFrame {
  return {
    kind: 'settings.snapshot',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: id,
    settings: {} as never,
  }
}

function pongFrame(id: SessionId = SID): ServerFrame {
  return { kind: 'pong', protocolVersion: PROTOCOL_VERSION, sessionId: id, nonce: 'x' }
}

function replayTruncationFrame(id: SessionId = SID): ServerFrame {
  return {
    kind: 'error',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: id,
    requestId: REPLAY_BUFFER_TRUNCATION_REQUEST_ID,
    code: 'internal_error',
    message: 'truncated',
    retryable: false,
  }
}

function historyTruncationFrame(id: SessionId = SID): ServerFrame {
  return {
    kind: 'error',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: id,
    requestId: HISTORY_REPLAY_TRUNCATION_REQUEST_ID,
    code: 'internal_error',
    message: 'history truncated',
    retryable: false,
  }
}

function otherErrorFrame(id: SessionId = SID): ServerFrame {
  return {
    kind: 'error',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: id,
    requestId: 'some-turn',
    code: 'bad_request',
    message: 'nope',
    retryable: false,
  }
}

/* ------------------------------------------------------------------------- *
 * distill — the allowlist
 * ------------------------------------------------------------------------- */

test('distill keeps message events + both truncation boundaries; drops ready/permission/snapshot/pong/other-error', () => {
  const cache = distill([
    readyFrame(),
    eventFrame(0),
    permissionFrame(),
    settingsSnapshotFrame(),
    pongFrame(),
    otherErrorFrame(),
    replayTruncationFrame(),
    eventFrame(1),
    historyTruncationFrame(),
  ])

  const kinds = cache.frames.map(f => f.kind)
  // Only events + the two truncation error frames survive, in order.
  expect(kinds).toEqual(['event', 'error', 'event', 'error'])
  expect(cache.frames.every(f => f.kind !== 'ready')).toBe(true)
  expect(cache.frames.some(f => f.kind === 'permission.context')).toBe(false)
  expect(cache.frames.some(f => f.kind === 'settings.snapshot')).toBe(false)
  expect(cache.frames.some(f => f.kind === 'pong')).toBe(false)
  // The dropped error is the non-truncation one; the kept errors are truncation.
  const keptErrorIds = cache.frames
    .filter(f => f.kind === 'error')
    .map(f => (f.kind === 'error' ? f.requestId : undefined))
  expect(keptErrorIds).toEqual([
    REPLAY_BUFFER_TRUNCATION_REQUEST_ID,
    HISTORY_REPLAY_TRUNCATION_REQUEST_ID,
  ])
})

test('no sticky once-per-attach snapshot reaches a cached transcript, via the REAL buffer', () => {
  // The buffer keeps each once-per-attach snapshot in a sticky slot so a
  // renderer reload still gets session state. `snapshotSession` is also the
  // persist path's input, so drive the real buffer and prove the allowlist
  // still admits nothing but transcript rows. Driven off STICKY_FRAME_KINDS so
  // a newly-classified sticky kind is covered without editing this test.
  const buffer = new FrameReplayBuffer()
  buffer.record(SID, readyFrame())
  for (const kind of STICKY_FRAME_KINDS) {
    buffer.record(SID, {
      kind,
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SID,
    } as unknown as ServerFrame)
  }
  buffer.record(SID, eventFrame(0))

  const persisted = buffer.snapshotSession(SID)
  // The sticky frames really are in the persist path's input...
  expect(
    STICKY_FRAME_KINDS.every(kind => persisted.some(f => f.kind === kind)),
  ).toBe(true)
  // ...and none of them survives distillation.
  const cache = distill(persisted)
  expect(cache.frames.map(f => f.kind)).toEqual(['event'])
  expect(cache.header.appSessionId).toBe(SID)
})

test('distill reads the two-id header from the ready head, then drops it', () => {
  const cache = distill([readyFrame(SID, 'engine-xyz'), eventFrame(0)])
  expect(cache.header.appSessionId).toBe(SID)
  expect(cache.header.engineSessionId).toBe('engine-xyz')
  expect(cache.header.protocolVersion).toBe(PROTOCOL_VERSION)
  expect(cache.header.guardVersion).toBe(TRANSCRIPT_CACHE_GUARD_VERSION)
  expect(typeof cache.header.writtenAt).toBe('number')
  expect(cache.frames.map(f => f.kind)).toEqual(['event'])
})

test('a generated image preview survives close-cache persistence', () => {
  const dir = tempDir()
  const preview: ServerFrame = {
    kind: 'generated-image-preview',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SID,
    toolUseId: 'toolu_image',
    mediaType: 'image/png',
    data: 'AAAA',
  }
  const buffer = new FrameReplayBuffer()
  buffer.record(SID, readyFrame())
  buffer.record(SID, eventFrame(0))
  buffer.record(SID, preview)

  writeCache(dir, distill(buffer.snapshotSession(SID)))
  expect(readCache(dir, SID)?.frames).toEqual([eventFrame(0), preview])
})

test('the unavailable-image notice survives cache distillation', () => {
  const notice: ServerFrame = {
    kind: 'error', protocolVersion: PROTOCOL_VERSION, sessionId: SID,
    requestId: PREVIEW_REPLAY_TRUNCATION_REQUEST_ID,
    code: 'internal_error',
    message: 'Some earlier generated image previews are no longer available.',
    retryable: false,
  }
  expect(distill([readyFrame(), notice]).frames).toEqual([notice])
  const firstClose = distill([readyFrame(), imageToolFrame(), notice])
  const refresh = distill([readyFrame(), imageToolFrame()])
  expect(retainCachedImagePreviews(refresh, firstClose).frames).toEqual([
    imageToolFrame(), notice,
  ])
})

test('closing a restored chat again retains its earlier generated image', () => {
  const preview: ServerFrame = {
    kind: 'generated-image-preview',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SID,
    toolUseId: 'toolu_image',
    mediaType: 'image/png',
    data: 'AAAA',
  }
  const firstClose = distill([readyFrame(), eventFrame(0), imageToolFrame(), preview])
  const secondClose = distill([readyFrame(), eventFrame(0), imageToolFrame(), eventFrame(1)])

  expect(retainCachedImagePreviews(secondClose, firstClose).frames).toEqual([
    eventFrame(0), imageToolFrame(), eventFrame(1), preview,
  ])
  expect(retainCachedImagePreviews(
    distill([readyFrame(SID, 'engine-new'), eventFrame(0)]),
    firstClose,
  ).frames).toEqual([eventFrame(0)])
})

test('an edit discards an image from the previous cached conversation tail', () => {
  const preview: ServerFrame = {
    kind: 'generated-image-preview', protocolVersion: PROTOCOL_VERSION,
    sessionId: SID, toolUseId: 'toolu_image', mediaType: 'image/png', data: 'AAAA',
  }
  const beforeEdit = distill([readyFrame(), imageToolFrame(), preview])
  const afterEdit = distill([readyFrame(), eventFrame(0)])
  expect(retainCachedImagePreviews(afterEdit, beforeEdit).frames).toEqual([eventFrame(0)])
})

test.each([
  ['replay ring', replayTruncationFrame()],
  ['sidecar history replay', historyTruncationFrame()],
])('a bounded %s keeps previews whose image tool call fell out of the cache', (_source, boundary) => {
  const preview: ServerFrame = {
    kind: 'generated-image-preview', protocolVersion: PROTOCOL_VERSION,
    sessionId: SID, toolUseId: 'toolu_image', mediaType: 'image/png', data: 'AAAA',
  }
  const previous = distill([readyFrame(), imageToolFrame(), preview])
  const current = distill([readyFrame(), eventFrame(2), boundary])

  expect(retainCachedImagePreviews(current, previous).frames).toEqual([
    eventFrame(2), boundary, preview,
  ])
})

function generationDirs() {
  const registryDir = tempDir()
  return {
    current: transcriptCacheDir(registryDir),
    images: join(registryDir, 'transcript-cache-v2'),
    original: join(registryDir, 'transcript-cache'),
  }
}

function imagePreview(): ServerFrame {
  return {
    kind: 'generated-image-preview', protocolVersion: PROTOCOL_VERSION,
    sessionId: SID, toolUseId: 'toolu_image', mediaType: 'image/png', data: 'AAAA',
  }
}

test('v3 isolates deadline-bearing writes from the older strict run-facts key gate', () => {
  const dirs = generationDirs()
  expect(dirs.current).toBe(join(dirs.original, '..', 'transcript-cache-v3'))
  const older = createTranscriptCache(SID, 'engine-abc', [eventFrame(0)], COMPLETE_FACTS)
  older.header.runFactsVersion = 1
  writeCache(dirs.images, older)
  writeCache(dirs.original, distill([readyFrame(), eventFrame(1)]))
  const oldImageBytes = readFileSync(cachePath(dirs.images), 'utf8')
  const oldOriginalBytes = readFileSync(cachePath(dirs.original), 'utf8')
  const deadlineFacts = { ...COMPLETE_FACTS, cacheExpiresAt: 1_735_819_200_000 }
  // The previous parseTranscriptRunFacts rejected any key outside these five.
  // This freezes that rejecting gate without claiming an installed build.
  const oldKeys = ['model', 'permissionMode', 'effort', 'usedTokens', 'contextWindow']
  const passesOldKeyGate = (facts: object) =>
    Object.keys(facts).length === oldKeys.length &&
    oldKeys.every(key => key in facts)
  expect(passesOldKeyGate(COMPLETE_FACTS)).toBe(true)
  expect(passesOldKeyGate(deadlineFacts)).toBe(false)
  expect(passesOldKeyGate({ ...COMPLETE_FACTS, cacheExpiresAt: null })).toBe(false)

  const current = createTranscriptCache(SID, 'engine-abc', [
    eventFrame(2), imageToolFrame(), imagePreview(),
  ], deadlineFacts)
  writeCache(dirs.current, current)
  expect(readCache(dirs.current, SID)).toEqual(current)
  expect(readCache(dirs.images, SID)).toEqual(older)
  expect(readFileSync(cachePath(dirs.images), 'utf8')).toBe(oldImageBytes)
  expect(readFileSync(cachePath(dirs.original), 'utf8')).toBe(oldOriginalBytes)
  expect(current.header.protocolVersion).toBe(older.header.protocolVersion)
  expect(current.header.guardVersion).toBe(older.header.guardVersion)
  // Older readers never search forward into the new writer's directory.
  expect(readCache(dirs.images, OTHER_SID)).toBeNull()
  writeCache(dirs.current, distill([readyFrame(OTHER_SID), eventFrame(3, OTHER_SID)]))
  expect(readCache(dirs.images, OTHER_SID)).toBeNull()
  deleteCache(dirs.images, OTHER_SID)
  expect(fileExists(cachePath(dirs.current, OTHER_SID))).toBe(true)
})

test('v3 and v2 readers retain the original transcript-only fallback without promoting on read', () => {
  const dirs = generationDirs()
  const legacy = distill([readyFrame(), eventFrame(0)])
  writeCache(dirs.original, legacy)
  expect(readCache(dirs.current, SID)).toEqual(legacy)
  expect(readCache(dirs.images, SID)).toEqual(legacy)
  expect(fileExists(cachePath(dirs.current))).toBe(false)
  expect(fileExists(cachePath(dirs.images))).toBe(false)
  expect(readCachedHeader(dirs.current, SID)).toBeNull()
  expect(cacheHasCurrentRunFacts(dirs.current, SID)).toBe(false)
})

test('v3 falls back to v2 before v1, preserving generated-image and transcript frames', () => {
  const dirs = generationDirs()
  writeCache(dirs.original, distill([readyFrame(), eventFrame(0)]))
  const v2 = distill([readyFrame(), eventFrame(1), imageToolFrame(), imagePreview()])
  writeCache(dirs.images, v2)
  expect(readCache(dirs.current, SID)).toEqual(v2)
  expect(readCache(dirs.current, SID)?.frames).toEqual(v2.frames)
  expect(readCache(dirs.original, SID)?.frames).toEqual([eventFrame(0)])
  expect(readCachedHeader(dirs.current, SID)).toBeNull()
  expect(fileExists(cachePath(dirs.current))).toBe(false)
})

test('recursive enumeration and generation-local pruning leave both older generations intact', () => {
  const dirs = generationDirs()
  const thirdId = '55555555-5555-4555-8555-555555555555'
  writeCache(dirs.current, distill([readyFrame(), eventFrame(0)]))
  writeCache(dirs.images, distill([readyFrame(), imageToolFrame(), imagePreview()]))
  writeCache(dirs.images, distill([readyFrame(OTHER_SID), eventFrame(1, OTHER_SID)]))
  writeCache(dirs.original, distill([readyFrame(thirdId), eventFrame(2, thirdId)]))
  const v2Bytes = readFileSync(cachePath(dirs.images), 'utf8')
  const v1Bytes = readFileSync(cachePath(dirs.original, thirdId), 'utf8')
  expect(listCachedSessionIds(dirs.current)).toEqual([SID])
  expect(listCachedSessionIds(dirs.current, true).sort()).toEqual([SID, OTHER_SID, thirdId].sort())
  expect(listCachedSessionIds(dirs.images, true).sort()).toEqual([SID, OTHER_SID, thirdId].sort())
  for (const id of listCachedSessionIds(dirs.current, true)) {
    deleteCache(dirs.current, id, false)
  }
  expect(listCachedSessionIds(dirs.current)).toEqual([])
  expect(readFileSync(cachePath(dirs.images), 'utf8')).toBe(v2Bytes)
  expect(readFileSync(cachePath(dirs.original, thirdId), 'utf8')).toBe(v1Bytes)
  expect(readCache(dirs.current, SID)?.frames).toContainEqual(imagePreview())
  expect(readCache(dirs.current, OTHER_SID)?.frames).toEqual([eventFrame(1, OTHER_SID)])
  expect(readCache(dirs.current, thirdId)?.frames).toEqual([eventFrame(2, thirdId)])
})

test('explicit cache removal deletes every generation so neither transcript nor image can revive', () => {
  const dirs = generationDirs()
  for (const dir of Object.values(dirs)) {
    writeCache(dir, distill(dir === dirs.original
      ? [readyFrame(), eventFrame(0)]
      : [readyFrame(), imageToolFrame(), imagePreview()]))
  }
  writeCache(dirs.images, distill([readyFrame(OTHER_SID), eventFrame(0, OTHER_SID)]))
  deleteCache(dirs.current, SID)
  for (const dir of Object.values(dirs)) {
    expect(fileExists(cachePath(dir))).toBe(false)
  }
  expect(readCache(dirs.current, SID)).toBeNull()
  expect(readCache(dirs.current, OTHER_SID)?.frames).toEqual([eventFrame(0, OTHER_SID)])
  deleteCache(dirs.current, SID)
})

test.each([
  ['edited tail', 'engine-abc'],
  ['different engine transcript', 'engine-new'],
])('a v3 replacement for an %s does not revive old v2 image bytes', (_label, engineSessionId) => {
  const dirs = generationDirs()
  const previous = distill([readyFrame(), imageToolFrame(), imagePreview()])
  writeCache(dirs.images, previous)
  const current = retainCachedImagePreviews(
    distill([readyFrame(SID, engineSessionId), eventFrame(0)]),
    readCache(dirs.current, SID),
  )
  writeCache(dirs.current, current)
  expect(readCache(dirs.current, SID)?.frames).toEqual([eventFrame(0)])
  expect(readCache(dirs.images, SID)).toEqual(previous)
})

test('an invalid v3 deadline fails closed without deleting or returning an older generation', () => {
  const dirs = generationDirs()
  const previous = distill([readyFrame(), imageToolFrame(), imagePreview()])
  writeCache(dirs.images, previous)
  writeCache(dirs.original, distill([readyFrame(), eventFrame(0)]))
  const olderBytes = [dirs.images, dirs.original].map(dir => readFileSync(cachePath(dir), 'utf8'))
  writeCache(dirs.current, createTranscriptCache(SID, 'engine-abc', [eventFrame(1)], {
    ...COMPLETE_FACTS,
    cacheExpiresAt: -1,
  }))
  expect(readCache(dirs.current, SID)).toBeNull()
  expect(fileExists(cachePath(dirs.current))).toBe(false)
  expect([dirs.images, dirs.original].map(dir => readFileSync(cachePath(dir), 'utf8'))).toEqual(
    olderBytes,
  )
})

test('backfill promotes v2 images and fresh run facts to v3 without changing either older file', () => {
  const dirs = generationDirs()
  const engineSessionId = '22222222-2222-4222-8222-222222222222'
  const previous = createTranscriptCache(
    SID, engineSessionId, [imageToolFrame(), imagePreview()], COMPLETE_FACTS,
  )
  previous.header.runFactsVersion = 1
  writeCache(dirs.images, previous)
  writeCache(dirs.original, distill([readyFrame(SID, engineSessionId), eventFrame(0)]))
  const olderBytes = [dirs.images, dirs.original].map(dir => readFileSync(cachePath(dir), 'utf8'))
  const runFacts = { ...COMPLETE_FACTS, cacheExpiresAt: 1_735_819_200_000 }
  const options = {
    cacheDir: dirs.current,
    getCurrentSession: () => sessionDescriptorFixture({
      appSessionId: SID, engineSessionId, cwd: dirs.current, restorable: true, status: 'exited',
    }),
    transcriptExists: () => true,
  }
  const result = {
    type: 'session' as const,
    appSessionId: SID,
    engineSessionId,
    frames: [imageToolFrame(), eventFrame(1)],
    runFacts,
  }
  expect(persistTranscriptBackfillResult(options, result)).toBe('written')
  expect(readCache(dirs.current, SID)?.frames).toEqual([
    imageToolFrame(), eventFrame(1), imagePreview(),
  ])
  expect(readCachedHeader(dirs.current, SID)?.runFacts).toEqual(runFacts)
  expect(persistTranscriptBackfillResult(options, result)).toBe('already_cached')
  expect([dirs.images, dirs.original].map(dir => readFileSync(cachePath(dir), 'utf8'))).toEqual(
    olderBytes,
  )
})

/* ------------------------------------------------------------------------- *
 * write → read round-trip + perms
 * ------------------------------------------------------------------------- */

test('write→read round-trips a distilled cache and files are 0600', () => {
  const dir = tempDir()
  const cache = distill([readyFrame(), eventFrame(0), eventFrame(1)])
  writeCache(dir, cache)

  const read = readCache(dir, SID)
  expect(read).not.toBeNull()
  expect(read?.header.appSessionId).toBe(SID)
  expect(read?.header.engineSessionId).toBe('engine-abc')
  expect(read?.frames.map(f => f.kind)).toEqual(['event', 'event'])

  const mode = statSync(cachePath(dir)).mode & 0o777
  expect(mode).toBe(0o600)
})

test('listCachedSessionIds enumerates written cache ids', () => {
  const dir = tempDir()
  writeCache(dir, distill([readyFrame(), eventFrame(0)]))
  expect(listCachedSessionIds(dir)).toEqual([SID])
  expect(listCachedSessionIds(join(dir, 'does-not-exist'))).toEqual([])
})

test('deleteCache removes the file and is a no-op when absent', () => {
  const dir = tempDir()
  writeCache(dir, distill([readyFrame(), eventFrame(0)]))
  expect(readCache(dir, SID)).not.toBeNull()
  deleteCache(dir, SID)
  expect(readCache(dir, SID)).toBeNull()
  // Idempotent — deleting an absent file does not throw.
  deleteCache(dir, SID)
})

test('readCache returns null for an absent id and a malformed id without touching disk', () => {
  const dir = tempDir()
  expect(readCache(dir, SID)).toBeNull()
  expect(readCache(dir, 'not-a-uuid')).toBeNull()
})

/* ------------------------------------------------------------------------- *
 * FAIL-CLOSED reads: every failure ⇒ null + file deleted
 * ------------------------------------------------------------------------- */

test('an oversized cache file is rejected before parse and deleted', () => {
  const dir = tempDir()
  const path = cachePath(dir)
  writeFileSync(path, 'x'.repeat(MAX_TRANSCRIPT_CACHE_BYTES + 1))
  expect(readCache(dir, SID)).toBeNull()
  expect(fileExists(path)).toBe(false)
})

test('a corrupt (non-JSON) cache file is discarded and deleted', () => {
  const dir = tempDir()
  const path = cachePath(dir)
  writeFileSync(path, '{ not json ')
  expect(readCache(dir, SID)).toBeNull()
  expect(fileExists(path)).toBe(false)
})

test('an allowlisted event kind with a malformed event payload is discarded and deleted', () => {
  const dir = tempDir()
  const path = cachePath(dir)
  const bad = {
    header: header(),
    frames: [
      {
        kind: 'event',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: SID,
        event: null,
      },
    ],
  }
  writeFileSync(path, JSON.stringify(bad))
  expect(readCache(dir, SID)).toBeNull()
  expect(fileExists(path)).toBe(false)
})

test('a valid raw message event retains its full payload through the cache', () => {
  const dir = tempDir()
  const frame = eventFrame(7)
  writeCache(dir, distill([readyFrame(), frame]))
  const cached = readCache(dir, SID)
  expect(cached?.frames).toEqual([frame])
})

test('a schema-drift cache (a non-allowlisted frame kind) is discarded and deleted', () => {
  const dir = tempDir()
  const path = cachePath(dir)
  const bad: TranscriptCache = {
    header: header(),
    // A snapshot frame must never appear in a cache — schema gate rejects it.
    frames: [settingsSnapshotFrame()],
  }
  writeFileSync(path, JSON.stringify(bad))
  expect(readCache(dir, SID)).toBeNull()
  expect(fileExists(path)).toBe(false)
})

test('a malformed generated image preview cannot be loaded from cache', () => {
  const dir = tempDir()
  writeFileSync(cachePath(dir), JSON.stringify({
    header: header(),
    frames: [{
      kind: 'generated-image-preview',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SID,
      toolUseId: 'toolu_image',
      mediaType: 'image/png',
      data: 'not base64!',
    }],
  }))
  expect(readCache(dir, SID)).toBeNull()
  expect(fileExists(cachePath(dir))).toBe(false)
})

/**
 * Discovery's refresh gate. It reads a bounded byte PREFIX rather than parsing
 * the cache, so the stamp has to survive that scan, and the whole point is that
 * "carries run facts" and "carries CURRENT run facts" are different questions:
 * asking the first is what left 30 of 44 real caches with a null contextWindow.
 */
test('the refresh gate reads the run-facts version from the header prefix', () => {
  const dir = tempDir()
  const runFacts = {
    model: 'gpt-5.6-terra',
    permissionMode: null,
    effort: null,
    usedTokens: 186_000,
    contextWindow: 372_000,
  }

  // No cache at all.
  expect(cacheHasCurrentRunFacts(dir, SID)).toBe(false)

  // A cache with NO run facts (the on-close shape).
  writeCache(dir, createTranscriptCache(SID, 'engine-abc', [eventFrame(0)]))
  expect(cacheHasCurrentRunFacts(dir, SID)).toBe(false)

  // A pre-version cache: run facts present, no stamp. This is the case the old
  // presence check got wrong, and the one that must still refresh.
  const stamped = createTranscriptCache(SID, 'engine-abc', [eventFrame(0)], runFacts)
  const unstamped: TranscriptCache = {
    header: { ...stamped.header, runFactsVersion: undefined },
    frames: stamped.frames,
  }
  writeFileSync(cachePath(dir), JSON.stringify(unstamped))
  expect(readCache(dir, SID)?.header.runFacts).toEqual(runFacts)
  expect(cacheHasCurrentRunFacts(dir, SID)).toBe(false)

  // Current.
  writeCache(dir, stamped)
  expect(cacheHasCurrentRunFacts(dir, SID)).toBe(true)

  // Written by a NEWER build: not churned by this one.
  writeFileSync(
    cachePath(dir),
    JSON.stringify({
      header: {
        ...stamped.header,
        runFactsVersion: TRANSCRIPT_CACHE_RUN_FACTS_VERSION + 1,
      },
      frames: stamped.frames,
    }),
  )
  expect(cacheHasCurrentRunFacts(dir, SID)).toBe(true)
})

/* ------------------------------------------------------------------------- *
 * the close-path run-facts gate — a header must never be thinner than frames
 * ------------------------------------------------------------------------- */

const COMPLETE_FACTS = {
  model: 'gpt-5.6-sol',
  permissionMode: 'auto',
  effort: 'high',
  usedTokens: 143_841,
  contextWindow: 372_000,
}

test.each([0, Date.parse('2025-01-02T12:00:00.000Z'), Number.MAX_SAFE_INTEGER, null])(
  'an optional cache expiry %s round-trips through full and bounded header reads',
  cacheExpiresAt => {
    const dir = tempDir()
    const facts = { ...COMPLETE_FACTS, cacheExpiresAt }
    const cache = createTranscriptCache(SID, 'engine-abc', [eventFrame(0)], facts)
    writeCache(dir, cache)
    expect(readCache(dir, SID)?.header.runFacts).toEqual(facts)
    expect(readCachedHeader(dir, SID)?.runFacts).toEqual(facts)
    expect(readCachedRunFacts(dir, SID, 'engine-abc')).toEqual(facts)
    expect(readCache(dir, SID)?.frames).toEqual(cache.frames)
  },
)

test.each([
  '-1',
  '1.25',
  '9007199254740992',
  '1e400',
  '-1e400',
  '"1735819200000"',
  'true',
  '{}',
  '[]',
])('an invalid cache expiry %s is rejected by both readers', rawDeadline => {
  const dir = tempDir()
  const cache = createTranscriptCache(SID, 'engine-abc', [eventFrame(0)], {
    ...COMPLETE_FACTS,
    cacheExpiresAt: 0,
  })
  writeFileSync(
    cachePath(dir),
    JSON.stringify(cache).replace('"cacheExpiresAt":0', `"cacheExpiresAt":${rawDeadline}`),
  )
  expect(readCachedHeader(dir, SID)).toBeNull()
  expect(readCachedRunFacts(dir, SID, 'engine-abc')).toBeNull()
  expect(readCache(dir, SID)).toBeNull()
  expect(fileExists(cachePath(dir))).toBe(false)
})

test('a new cache-expiry field does not open the remaining run-facts schema', () => {
  const dir = tempDir()
  const cache = createTranscriptCache(SID, 'engine-abc', [eventFrame(0)], {
    ...COMPLETE_FACTS,
    cacheExpiresAt: 0,
  })
  writeFileSync(cachePath(dir), JSON.stringify({
    ...cache,
    header: {
      ...cache.header,
      runFacts: { ...cache.header.runFacts, unknownFact: 1 },
    },
  }))
  expect(readCachedHeader(dir, SID)).toBeNull()
  expect(readCache(dir, SID)).toBeNull()
})

test('version-1 facts stay readable and backfill enrichment preserves actual transcript frames', () => {
  const dir = tempDir()
  const engineSessionId = '22222222-2222-4222-8222-222222222222'
  const frames = [eventFrame(0), historyTruncationFrame(), eventFrame(1)]
  const oldCache = createTranscriptCache(SID, engineSessionId, frames, COMPLETE_FACTS)
  oldCache.header.runFactsVersion = 1
  writeCache(dir, oldCache)
  expect(TRANSCRIPT_CACHE_RUN_FACTS_VERSION).toBe(3)
  expect(readCache(dir, SID)).toEqual(oldCache)
  expect(cacheHasCurrentRunFacts(dir, SID)).toBe(false)
  expect(readCachedRunFacts(dir, SID, engineSessionId)).toBeNull()
  expect(fileExists(cachePath(dir))).toBe(true)

  const responseAt = Date.parse('2025-01-01T12:00:00.000Z')
  const transcriptPath = join(dir, 'transcript.jsonl')
  writeFileSync(transcriptPath, [
    JSON.stringify({
      type: 'system',
      subtype: 'run_facts',
      model: COMPLETE_FACTS.model,
      permissionMode: COMPLETE_FACTS.permissionMode,
      effort: COMPLETE_FACTS.effort,
      contextWindow: COMPLETE_FACTS.contextWindow,
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(responseAt).toISOString(),
      message: { model: COMPLETE_FACTS.model, usage: { input_tokens: 2_048 } },
    }),
  ].join('\n'))
  const runFacts = readTranscriptRunFacts(transcriptPath, () => null).facts
  const result = persistTranscriptBackfillResult({
    cacheDir: dir,
    getCurrentSession: () => sessionDescriptorFixture({
      appSessionId: SID,
      engineSessionId,
      cwd: dir,
      restorable: true,
      status: 'exited',
    }),
    transcriptExists: () => true,
  }, {
    type: 'session',
    appSessionId: SID,
    engineSessionId,
    frames,
    runFacts,
  })
  expect(result).toBe('written')
  const refreshed = readCache(dir, SID)!
  expect(refreshed.header.runFactsVersion).toBe(TRANSCRIPT_CACHE_RUN_FACTS_VERSION)
  expect(refreshed.header.guardVersion).toBe(oldCache.header.guardVersion)
  expect(refreshed.header.protocolVersion).toBe(oldCache.header.protocolVersion)
  expect(refreshed.frames).toEqual(oldCache.frames)
  expect(refreshed.header.runFacts?.cacheExpiresAt).toBe(
    responseAt + CODEX_CACHE_IDLE_ESTIMATE_MS,
  )
  expect(refreshed.header.runFacts!.cacheExpiresAt!).toBeLessThan(refreshed.header.writtenAt)
  expect(cacheHasCurrentRunFacts(dir, SID)).toBe(true)
})

test('a complete derivation is written; an incomplete one writes no header at all', () => {
  // The whole point of the gate: `selectPreviewRunFacts` trusts a header
  // WHOLESALE, so a header naming only the effort would cost the preview the
  // model, mode, usage and exact window its frames still carry.
  expect(resolveCacheRunFacts(COMPLETE_FACTS, null)).toEqual(COMPLETE_FACTS)
  expect(
    resolveCacheRunFacts(
      { ...COMPLETE_FACTS, contextWindow: null },
      null,
    ),
  ).toBeUndefined()
  expect(
    resolveCacheRunFacts({ ...COMPLETE_FACTS, permissionMode: null }, null),
  ).toBeUndefined()
  expect(
    resolveCacheRunFacts({ ...COMPLETE_FACTS, usedTokens: null }, null),
  ).toBeUndefined()
})

test('effort is the one fact allowed to stay null: an Anthropic session records none', () => {
  expect(resolveCacheRunFacts({ ...COMPLETE_FACTS, effort: null }, null)).toEqual({
    ...COMPLETE_FACTS,
    effort: null,
  })
})

test('a close retains only a freshly derived cache deadline, never a prior one', () => {
  const prior = { ...COMPLETE_FACTS, cacheExpiresAt: 1_735_819_200_000 }
  const latest = { ...COMPLETE_FACTS, cacheExpiresAt: 1_735_905_600_000 }
  expect(resolveCacheRunFacts(latest, prior)).toEqual(latest)
  expect(resolveCacheRunFacts(COMPLETE_FACTS, prior)).toEqual(COMPLETE_FACTS)
  expect(resolveCacheRunFacts({ ...COMPLETE_FACTS, cacheExpiresAt: null }, prior)).toEqual({
    ...COMPLETE_FACTS,
    cacheExpiresAt: null,
  })
  // Legacy window enrichment still works, but must not revive an invalidated
  // deadline after compaction or an unusable latest response.
  expect(resolveCacheRunFacts({ ...COMPLETE_FACTS, contextWindow: null }, prior)).toEqual(
    COMPLETE_FACTS,
  )
})

test('a different model cannot inherit the preceding model cache deadline', () => {
  const derived = { ...COMPLETE_FACTS, model: 'gpt-5.7-sol' }
  expect(resolveCacheRunFacts(derived, {
    ...COMPLETE_FACTS,
    cacheExpiresAt: 1_735_819_200_000,
  })).toEqual(derived)
})

test('an enriched cache fills what a legacy transcript cannot derive, for the SAME model', () => {
  // The clobber case: a transcript with no `run_facts` record yields no window
  // (main has no resolver), so without the existing facts this close would drop
  // back to a headerless write and lose what a previous launch established.
  const derived = {
    model: 'gpt-5.6-sol',
    permissionMode: 'auto',
    effort: null,
    usedTokens: 200_000,
    contextWindow: null,
  }
  expect(resolveCacheRunFacts(derived, COMPLETE_FACTS)).toEqual({
    model: 'gpt-5.6-sol',
    permissionMode: 'auto',
    // Filled from the enriched cache…
    effort: 'high',
    // …while the FRESH reading of a fact the transcript does state wins.
    usedTokens: 200_000,
    contextWindow: 372_000,
  })
})

test('a silent derivation borrows NOTHING, even from a complete cache', () => {
  // No transcript read (unreadable file, or the row is gone) means no evidence.
  // Borrowing the prior header wholesale would write a complete-LOOKING one
  // whose usedTokens predates the cache's own frames, and the renderer trusts a
  // header wholesale — so the donut would report a count older than the
  // transcript beside it. No header at all is correct: the frame fallback is
  // derived from those very frames.
  expect(resolveCacheRunFacts(EMPTY, COMPLETE_FACTS)).toBeUndefined()
  // Same for a run-facts record that names no model: its window cannot be
  // attributed, so it may not inherit the previous model's.
  expect(
    resolveCacheRunFacts({ ...COMPLETE_FACTS, model: null }, COMPLETE_FACTS),
  ).toBeUndefined()
})

test('facts for a different model are never borrowed — above all the window', () => {
  const derived = {
    model: 'claude-opus-5',
    permissionMode: 'default',
    effort: null,
    usedTokens: 10_000,
    contextWindow: null,
  }
  // 372k is gpt-5.6-sol's window; adopting it for another model would be a
  // fabricated denominator. No window ⇒ no header ⇒ the frame fallback answers.
  expect(resolveCacheRunFacts(derived, COMPLETE_FACTS)).toBeUndefined()
})

test('readCachedRunFacts ignores facts from an older derivation', () => {
  const dir = tempDir()
  const stamped = createTranscriptCache(SID, 'engine-abc', [eventFrame(0)], COMPLETE_FACTS)
  writeCache(dir, stamped)
  expect(readCachedRunFacts(dir, SID, 'engine-abc')).toEqual(COMPLETE_FACTS)

  writeFileSync(
    cachePath(dir),
    JSON.stringify({
      header: { ...stamped.header, runFactsVersion: undefined },
      frames: stamped.frames,
    }),
  )
  expect(readCachedRunFacts(dir, SID, 'engine-abc')).toBeNull()
  expect(readCachedRunFacts(dir, OTHER_SID, 'engine-abc')).toBeNull()
})

test('the header prefix read survives a brace inside a header string', () => {
  // Brace balance, not a regex: a cwd or title carrying `}` must not truncate
  // the header, and every field after it must still be readable.
  const dir = tempDir()
  const cache = createTranscriptCache(SID, 'engine-}-abc', [eventFrame(0)], COMPLETE_FACTS)
  writeCache(dir, cache)
  const header = readCachedHeader(dir, SID)
  expect(header?.engineSessionId).toBe('engine-}-abc')
  expect(header?.runFacts).toEqual(COMPLETE_FACTS)
  expect(cacheWrittenAt(dir, SID)).toBe(cache.header.writtenAt)
})

test('buildClosedSessionCache enriches a distilled close cache from the transcript', () => {
  const facts = { ...COMPLETE_FACTS, cacheExpiresAt: 1_735_819_200_000 }
  const cache = buildClosedSessionCache(
    {
      transcriptPath: engineSessionId => `/transcripts/${engineSessionId}.jsonl`,
      readRunFacts: path => ({
        facts: path === '/transcripts/engine-abc.jsonl' ? facts : EMPTY,
        authoritative: true,
      }),
      readCachedRunFacts: () => null,
    },
    [readyFrame(), permissionFrame(), eventFrame(0)],
  )
  expect(cache?.header.runFacts).toEqual(facts)
  expect(cache?.header.runFactsVersion).toBe(TRANSCRIPT_CACHE_RUN_FACTS_VERSION)
  // The distill allowlist is unchanged by enrichment.
  expect(cache?.frames).toHaveLength(1)
})

test('zero-usage Codex history survives close persistence as an independent preview deadline', () => {
  const dir = tempDir()
  const path = join(dir, 'zero-usage.jsonl')
  const model = 'gpt-6.1-sol'
  const at = Date.parse('2025-01-01T12:00:00.000Z')
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  writeFileSync(path, [
    { type: 'system', subtype: 'run_facts', model, permissionMode: 'auto', effort: 'high', contextWindow: 1_048_576 },
    { type: 'assistant', timestamp: new Date(at).toISOString(), message: { model, usage } },
    { type: 'system', subtype: 'codex_stream_surface', timestamp: new Date(at + 2_000).toISOString(),
      model, completed: true, input_tokens: 2_200, cached_tokens: 2_000, output_tokens: 4 },
  ].map(record => JSON.stringify(record)).join('\n'))
  const assistant = SDK_MESSAGE_FIXTURE.assistant[0]!.message
  const frame: ServerFrame = { kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: SID,
    event: { type: 'message', message: { ...assistant, message: { ...assistant.message, model, usage } } } }
  const cache = buildClosedSessionCache({
    transcriptPath: () => path,
    readRunFacts: path => readTranscriptRunFacts(path, () => null),
    readCachedRunFacts: () => null,
  }, [readyFrame(), frame])!
  expect(cache.header.runFacts).toBeUndefined()
  expect(cache.header.cacheObservation).toEqual({ model, expiresAt: at + 2_000 + CODEX_CACHE_IDLE_ESTIMATE_MS })
  writeCache(dir, cache)
  const preview = projectPreviewTranscriptCache(readCache(dir, SID)!)
  expect(preview.runFacts.cacheExpiresAt).toBe(at + 2_000 + CODEX_CACHE_IDLE_ESTIMATE_MS)
  expect(preview.runFacts.contextUsage).toBeNull()
  expect(readCache(dir, SID)!.frames).toEqual(cache.frames)
})

test.each([
  null, {}, { model: '', expiresAt: 1 }, { model: 'x'.repeat(129), expiresAt: 1 },
  { model: 'gpt-6.1-sol', expiresAt: -1 },
  { model: 'gpt-6.1-sol', expiresAt: '1' },
  { model: 'gpt-6.1-sol', expiresAt: 1, extra: true },
])('invalid independent cache observation %j fails closed', cacheObservation => {
  const dir = tempDir()
  writeFileSync(cachePath(dir), JSON.stringify({ header: { ...header(), cacheObservation }, frames: [] }))
  expect(readCachedHeader(dir, SID)).toBeNull()
  expect(readCache(dir, SID)).toBeNull()
})

test('buildClosedSessionCache skips a session with no transcript frames or no engine id', () => {
  const deps = {
    transcriptPath: (engineSessionId: string) => `/t/${engineSessionId}`,
    readRunFacts: () => ({ facts: COMPLETE_FACTS, authoritative: true }),
    readCachedRunFacts: () => null,
  }
  // Ready + snapshots only: a session closed before its first turn. A readable
  // cache here would leave the preview holding a loading placeholder forever.
  expect(buildClosedSessionCache(deps, [readyFrame(), permissionFrame()])).toBeNull()
  expect(buildClosedSessionCache(deps, [readyFrame(), {
    kind: 'generated-image-preview',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SID,
    toolUseId: 'toolu_orphan',
    mediaType: 'image/png',
    data: 'AAAA',
  }])).toBeNull()
  // Never ready ⇒ never restorable ⇒ the cache would never be served.
  expect(buildClosedSessionCache(deps, [eventFrame(0)])).toBeNull()
})

test('an unknown transcript path degrades to the headerless cache, never a guess', () => {
  const cache = buildClosedSessionCache(
    {
      // The row is gone: nothing to enrich from.
      transcriptPath: () => null,
      readRunFacts: () => ({ facts: COMPLETE_FACTS, authoritative: true }),
      readCachedRunFacts: () => null,
    },
    [readyFrame(), eventFrame(0)],
  )
  expect(cache?.header.runFacts).toBeUndefined()
  expect(cache?.frames).toHaveLength(1)
})

const EMPTY = {
  model: null,
  permissionMode: null,
  effort: null,
  usedTokens: null,
  contextWindow: null,
}

test('a non-integer run-facts stamp is corrupt and fails the read', () => {
  const dir = tempDir()
  const path = cachePath(dir)
  writeFileSync(
    path,
    JSON.stringify({ header: { ...header(), runFactsVersion: 'one' }, frames: [] }),
  )
  expect(readCache(dir, SID)).toBeNull()
  expect(fileExists(path)).toBe(false)
})

test('a protocolVersion mismatch is discarded and deleted', () => {
  const dir = tempDir()
  const path = cachePath(dir)
  const bad = { header: { ...header(), protocolVersion: PROTOCOL_VERSION + 1 }, frames: [] }
  writeFileSync(path, JSON.stringify(bad))
  expect(readCache(dir, SID)).toBeNull()
  expect(fileExists(path)).toBe(false)
})

test('a guardVersion mismatch is discarded and deleted', () => {
  const dir = tempDir()
  const path = cachePath(dir)
  const bad = {
    header: { ...header(), guardVersion: TRANSCRIPT_CACHE_GUARD_VERSION + 1 },
    frames: [],
  }
  writeFileSync(path, JSON.stringify(bad))
  expect(readCache(dir, SID)).toBeNull()
  expect(fileExists(path)).toBe(false)
})

test('an id/header mismatch (file served under the wrong id) is discarded and deleted', () => {
  const dir = tempDir()
  const path = cachePath(dir)
  const bad = { header: { ...header(), appSessionId: 'other' }, frames: [] }
  writeFileSync(path, JSON.stringify(bad))
  expect(readCache(dir, SID)).toBeNull()
  expect(fileExists(path)).toBe(false)
})

test('the read-time secret re-scan closes guard-drift: a secret-bearing cache is discarded and deleted', () => {
  const dir = tempDir()
  const path = cachePath(dir)
  // An allowlisted event frame that (under an OLD guard) carried a secret key.
  const secretEvent: ServerFrame = {
    kind: 'event',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SID,
    event: { type: 'message', message: { accessToken: 'sk-leak' } } as never,
  }
  const withSecret: TranscriptCache = { header: header(), frames: [secretEvent] }
  writeFileSync(path, JSON.stringify(withSecret))
  expect(readCache(dir, SID)).toBeNull()
  expect(fileExists(path)).toBe(false)
})

/* ------------------------------------------------------------------------- *
 * resolvePreview — the boundary: no disk read for an unvouched id
 * ------------------------------------------------------------------------- */

test('resolvePreview never reads disk for an id the host does not vouch for', () => {
  const cache = distill([readyFrame(), eventFrame(0)])
  let readCalls = 0
  const readCacheSpy = () => {
    readCalls++
    return cache
  }

  // canPreview false (an unknown / non-restorable / LIVE id) ⇒ null, no read.
  expect(
    resolvePreview({ canPreview: () => false, readCache: readCacheSpy }, SID),
  ).toBeNull()
  expect(readCalls).toBe(0)

  // Malformed / empty id ⇒ null, canPreview + readCache never consulted.
  expect(
    resolvePreview(
      {
        canPreview: () => {
          throw new Error('canPreview must not run for a bad id')
        },
        readCache: readCacheSpy,
      },
      '',
    ),
  ).toBeNull()
  expect(readCalls).toBe(0)

  // canPreview true ⇒ the cache is read and returned.
  expect(
    resolvePreview({ canPreview: () => true, readCache: readCacheSpy }, SID),
  ).toBe(cache)
  expect(readCalls).toBe(1)
})

/* --- helpers --- */

function header() {
  return {
    appSessionId: SID,
    engineSessionId: 'engine-abc',
    protocolVersion: PROTOCOL_VERSION,
    appVersion: '0.0.0',
    guardVersion: TRANSCRIPT_CACHE_GUARD_VERSION,
    writtenAt: Date.now(),
  }
}

function fileExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

test('an authoritative provider-default effort is never patched from a cache', () => {
  // The run_facts snapshot is one resolved request: `effort: null` there means
  // this run used the PROVIDER DEFAULT, not "no record said". Borrowing a
  // cached `high` over it reports an effort the run never used.
  const authoritative = { ...COMPLETE_FACTS, effort: null }
  expect(resolveCacheRunFacts(authoritative, COMPLETE_FACTS, true)).toEqual(
    authoritative,
  )
  // The legacy tier means the opposite by the same null, so it still borrows.
  expect(
    resolveCacheRunFacts(authoritative, COMPLETE_FACTS, false)?.effort,
  ).toBe('high')
})

test('carry-forward is refused across a re-keyed engine session', () => {
  // An app session resumed into a NEW transcript keeps its appSessionId, so an
  // older cache under that id describes a different run. Borrowing its effort
  // and window would relabel that run as this one.
  const dir = tempDir()
  writeCache(
    dir,
    createTranscriptCache(SID, 'engine-old', [eventFrame(0)], COMPLETE_FACTS),
  )
  expect(readCachedRunFacts(dir, SID, 'engine-old')).toEqual(COMPLETE_FACTS)
  expect(readCachedRunFacts(dir, SID, 'engine-new')).toBeNull()
  expect(readCachedRunFacts(dir, SID, null)).toBeNull()
})
