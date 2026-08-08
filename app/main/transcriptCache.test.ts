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
  resolveCacheRunFacts,
  resolvePreview,
  writeCache,
} from './transcriptCache.js'
import { FrameReplayBuffer, STICKY_FRAME_KINDS } from './replayBuffer.js'

const SID: SessionId = '11111111-1111-4111-8111-111111111111'
/** A session with no cache file at all. */
const OTHER_SID: SessionId = '33333333-3333-4333-8333-333333333333'
const REPLAY_TRUNCATION_REQUEST_ID = 'catcode.replay-truncated'

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
    requestId: REPLAY_TRUNCATION_REQUEST_ID,
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
    REPLAY_TRUNCATION_REQUEST_ID,
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
  expect(readCachedRunFacts(dir, SID)).toEqual(COMPLETE_FACTS)

  writeFileSync(
    cachePath(dir),
    JSON.stringify({
      header: { ...stamped.header, runFactsVersion: undefined },
      frames: stamped.frames,
    }),
  )
  expect(readCachedRunFacts(dir, SID)).toBeNull()
  expect(readCachedRunFacts(dir, OTHER_SID)).toBeNull()
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
  const cache = buildClosedSessionCache(
    {
      transcriptPath: engineSessionId => `/transcripts/${engineSessionId}.jsonl`,
      readRunFacts: path =>
        path === '/transcripts/engine-abc.jsonl' ? COMPLETE_FACTS : EMPTY,
      readCachedRunFacts: () => null,
    },
    [readyFrame(), permissionFrame(), eventFrame(0)],
  )
  expect(cache?.header.runFacts).toEqual(COMPLETE_FACTS)
  expect(cache?.header.runFactsVersion).toBe(TRANSCRIPT_CACHE_RUN_FACTS_VERSION)
  // The distill allowlist is unchanged by enrichment.
  expect(cache?.frames).toHaveLength(1)
})

test('buildClosedSessionCache skips a session with no transcript frames or no engine id', () => {
  const deps = {
    transcriptPath: (engineSessionId: string) => `/t/${engineSessionId}`,
    readRunFacts: () => COMPLETE_FACTS,
    readCachedRunFacts: () => null,
  }
  // Ready + snapshots only: a session closed before its first turn. A readable
  // cache here would leave the preview holding a loading placeholder forever.
  expect(buildClosedSessionCache(deps, [readyFrame(), permissionFrame()])).toBeNull()
  // Never ready ⇒ never restorable ⇒ the cache would never be served.
  expect(buildClosedSessionCache(deps, [eventFrame(0)])).toBeNull()
})

test('an unknown transcript path degrades to the headerless cache, never a guess', () => {
  const cache = buildClosedSessionCache(
    {
      // The row is gone: nothing to enrich from.
      transcriptPath: () => null,
      readRunFacts: () => COMPLETE_FACTS,
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
