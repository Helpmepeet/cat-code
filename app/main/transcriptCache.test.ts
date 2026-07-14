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
  deleteCache,
  distill,
  listCachedSessionIds,
  readCache,
  resolvePreview,
  writeCache,
} from './transcriptCache.js'

const SID: SessionId = '11111111-1111-4111-8111-111111111111'
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
      message: { role: 'user', content: `msg ${i}` },
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
