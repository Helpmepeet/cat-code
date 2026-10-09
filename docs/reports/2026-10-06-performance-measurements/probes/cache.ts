/**
 * Transcript cache reads and the persistence step main runs at park, close,
 * restart and quit, against private temporary caches with warm files.
 *
 * `persistTranscriptCache` lives inside `app/main/main.ts`; `persist` below
 * mirrors its read, preview carry-forward and write. It builds the cache with
 * `createTranscriptCache` rather than `buildClosedSessionCache`, so the engine
 * transcript run-facts read is not included.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTranscriptCache,
  readCache,
  retainCachedImagePreviews,
  writeCache,
} from '../../../../app/main/transcriptCache.js'
import type { ServerFrame } from '../../../../app/shared/protocol.js'
import { ENGINE_SESSION_ID, fixtureUuid, messageFrames } from '../fixtures.js'
import { emit, median, probeConfig, repeat, round, summarize, type CaseResult } from '../timing.js'

const config = probeConfig()
const cases: CaseResult[] = []

function persist(dir: string, appSessionId: string, frames: ServerFrame[]): { readMs: number; writeMs: number } {
  const cache = createTranscriptCache(appSessionId, ENGINE_SESSION_ID, frames)
  let start = performance.now()
  const previous = readCache(dir, appSessionId)
  const readMs = performance.now() - start
  start = performance.now()
  writeCache(dir, retainCachedImagePreviews(cache, previous))
  return { readMs, writeMs: performance.now() - start }
}

function withDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'catcode-perf-cache-'))
  try {
    return run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const SIZES = config.smoke
  ? [{ count: 100, textCharacters: 300 }]
  : [
    { count: 500, textCharacters: 1_300 }, { count: 1_000, textCharacters: 1_300 },
    { count: 2_000, textCharacters: 1_300 }, { count: 3_000, textCharacters: 1_300 },
    { count: 500, textCharacters: 300 }, { count: 8_000, textCharacters: 300 },
  ]

for (const { count, textCharacters } of SIZES) {
  withDir(dir => {
    const id = fixtureUuid(0xcac0, count)
    const frames = messageFrames(count, textCharacters, { sessionId: id })
    writeCache(dir, createTranscriptCache(id, ENGINE_SESSION_ID, frames))
    const bytes = statSync(join(dir, `${id}.json`)).size
    readCache(dir, id)

    const params = { messages: count, textCharacters, serializedBytes: bytes }
    cases.push(summarize(`read/${textCharacters}-chars/${count}`, params, repeat(config, () => {
      const start = performance.now()
      const cache = readCache(dir, id)
      const ms = performance.now() - start
      if (cache === null) throw new Error('synthetic cache was rejected')
      return ms
    })))

    const reads: number[] = []
    const writes: number[] = []
    cases.push(summarize(`persist/${textCharacters}-chars/${count}`, { ...params, scoredValue: 'read existing + write replacement, ms' }, repeat(config, () => {
      const { readMs, writeMs } = persist(dir, id, frames)
      reads.push(readMs)
      writes.push(writeMs)
      return readMs + writeMs
    }), { readMedianMs: round(median(reads)), writeMedianMs: round(median(writes)) }))
  })
}

// Quit persists every live session in turn; the live-engine cap is 4.
const QUIT = config.smoke ? { sessions: 2, count: 100 } : { sessions: 4, count: 1_000 }
withDir(dir => {
  const sessions = Array.from({ length: QUIT.sessions }, (_, i) => {
    const id = fixtureUuid(0x9017, i)
    const frames = messageFrames(QUIT.count, 1_300, { sessionId: id, namespace: 0x100 + i })
    writeCache(dir, createTranscriptCache(id, ENGINE_SESSION_ID, frames))
    return { id, frames }
  })
  const reads: number[] = []
  cases.push(summarize(`quit/${QUIT.sessions}-sessions/${QUIT.count}`, {
    sessions: QUIT.sessions, messagesPerSession: QUIT.count, textCharacters: 1_300, scoredValue: 'serial persist of every session, ms',
  }, repeat(config, () => {
    let read = 0
    const start = performance.now()
    for (const { id, frames } of sessions) read += persist(dir, id, frames).readMs
    reads.push(read)
    return performance.now() - start
  }), { readShareMedianMs: round(median(reads)) }))
})

emit('cache', cases, [
  'Warm files on the local disk; cold reads were not measured.',
  'Synthetic caches carry no generated-image previews, so the carry-forward finds nothing to keep.',
])
