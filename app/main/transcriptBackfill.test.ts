import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { SessionDescriptor } from '../shared/hostApi.js'
import { PROTOCOL_VERSION } from '../shared/protocol.js'
import type { TranscriptBackfillSessionResult } from '../shared/transcriptBackfill.js'
import {
  TRANSCRIPT_CACHE_RUN_FACTS_VERSION,
  cacheHasCurrentRunFacts,
  readCache,
  writeCache,
} from './transcriptCache.js'
import {
  persistTranscriptBackfillResult,
  runTranscriptBackfill,
} from './transcriptBackfill.js'

/**
 * What a real worker result carries for a transcript it could read. Fixtures
 * that exercise other concerns use this rather than the all-null object: an
 * all-null result now writes NO header (see the dedicated test below), so using
 * it here would silently stop testing the idempotence it was written for.
 */
const SOME_RUN_FACTS = {
  model: 'gpt-5.6-terra',
  permissionMode: null,
  effort: null,
  usedTokens: null,
  contextWindow: 372_000,
}

/** The boundary's all-null value — a transcript the worker could not read. */
const NO_RUN_FACTS = {
  model: null,
  permissionMode: null,
  effort: null,
  usedTokens: null,
  contextWindow: null,
}


const APP_ID = '11111111-1111-4111-8111-111111111111'
const ENGINE_ID = '22222222-2222-4222-8222-222222222222'
const APP_ID_TWO = '55555555-5555-4555-8555-555555555555'
const ENGINE_ID_TWO = '66666666-6666-4666-8666-666666666666'
const here = dirname(fileURLToPath(import.meta.url))
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function cacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'catcode-plb-cache-'))
  dirs.push(dir)
  return dir
}

function descriptor(restorable: boolean): SessionDescriptor {
  return {
    appSessionId: APP_ID,
    engineSessionId: ENGINE_ID,
    cwd: '/tmp',
    title: null,
    titleUpdatedAt: null,
    status: restorable ? 'exited' : 'ready',
    restorable,
    parked: false,
    createdAt: 1,
    lastAttachedAt: 2,
    lastMessageSentAt: null,
  }
}

function result(): TranscriptBackfillSessionResult {
  return {
    type: 'session',
    appSessionId: APP_ID,
    engineSessionId: ENGINE_ID,
    frames: [
      {
        kind: 'event',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: APP_ID,
        replay: true,
        event: {
          type: 'message',
          message: {
            type: 'user',
            session_id: ENGINE_ID,
            uuid: '44444444-4444-4444-8444-444444444444',
            parent_tool_use_id: null,
            message: { role: 'user', content: 'backfilled' },
          },
        } as never,
      },
    ],
    runFacts: SOME_RUN_FACTS,
  }
}

test('fresh restorable row writes once and round-trips through readCache', () => {
  const dir = cacheDir()
  expect(
    persistTranscriptBackfillResult(
      {
        cacheDir: dir,
        getCurrentSession: () => descriptor(true),
        transcriptExists: () => true,
      },
      result(),
    ),
  ).toBe('written')
  expect(readCache(dir, APP_ID)?.frames).toEqual(result().frames)
  expect(
    persistTranscriptBackfillResult(
      {
        cacheDir: dir,
        getCurrentSession: () => descriptor(true),
        transcriptExists: () => true,
      },
      result(),
    ),
  ).toBe('already_cached')
})

/**
 * The bug this closes, measured on the real registry: 30 of 44 caches carried
 * run facts with `contextWindow: null`, because this gate asked whether a
 * `runFacts` object EXISTED. It did, so every one of them counted as done and
 * the newly-derivable window could never reach them. Keying on the derivation
 * VERSION is what lets a new fact land on caches that already exist.
 */
test('a cache whose run facts predate the current derivation is refreshed, not kept', () => {
  const dir = cacheDir()
  const stale = result()
  writeCache(dir, {
    header: {
      appSessionId: APP_ID,
      engineSessionId: ENGINE_ID,
      protocolVersion: PROTOCOL_VERSION,
      appVersion: '0.0.0',
      guardVersion: 1,
      writtenAt: 1,
      // Exactly the shape a pre-version build wrote: facts present, no stamp.
      runFacts: NO_RUN_FACTS,
    },
    frames: stale.frames,
  })
  expect(readCache(dir, APP_ID)?.header.runFactsVersion).toBeUndefined()

  const fresh = {
    ...result(),
    runFacts: { ...NO_RUN_FACTS, model: 'gpt-5.6-terra', contextWindow: 372_000 },
  }
  expect(
    persistTranscriptBackfillResult(
      {
        cacheDir: dir,
        getCurrentSession: () => descriptor(true),
        transcriptExists: () => true,
      },
      fresh,
    ),
  ).toBe('written')

  const rewritten = readCache(dir, APP_ID)
  expect(rewritten?.header.runFactsVersion).toBe(TRANSCRIPT_CACHE_RUN_FACTS_VERSION)
  expect(rewritten?.header.runFacts?.contextWindow).toBe(372_000)

  // Now at the current version, so a re-run is a no-op again.
  expect(
    persistTranscriptBackfillResult(
      {
        cacheDir: dir,
        getCurrentSession: () => descriptor(true),
        transcriptExists: () => true,
      },
      fresh,
    ),
  ).toBe('already_cached')
})

test('a row that became live, vanished, lost its transcript, or changed engine id is never mutated', () => {
  const cases: Array<{
    current: SessionDescriptor | undefined
    transcriptExists: boolean
  }> = [
    { current: descriptor(false), transcriptExists: true },
    { current: undefined, transcriptExists: true },
    { current: descriptor(true), transcriptExists: false },
    {
      current: {
        ...descriptor(true),
        engineSessionId: '33333333-3333-4333-8333-333333333333',
      },
      transcriptExists: true,
    },
  ]
  for (const item of cases) {
    const dir = cacheDir()
    expect(
      persistTranscriptBackfillResult(
        {
          cacheDir: dir,
          getCurrentSession: () => item.current,
          transcriptExists: () => item.transcriptExists,
        },
        result(),
      ),
    ).toBe('ineligible')
    expect(readCache(dir, APP_ID)).toBeNull()
  }
})

test('runner accepts several complete NDJSON records coalesced into one stdout chunk and reaps the child', async () => {
  const accepted: TranscriptBackfillSessionResult[] = []
  const summary = await runTranscriptBackfill({
    items: [
      {
        appSessionId: APP_ID,
        engineSessionId: ENGINE_ID,
        transcriptPath: join('/tmp', `${ENGINE_ID}.jsonl`),
      },
      {
        appSessionId: APP_ID_TWO,
        engineSessionId: ENGINE_ID_TWO,
        transcriptPath: join('/tmp', `${ENGINE_ID_TWO}.jsonl`),
      },
    ],
    command: 'bun',
    args: ['run', join(here, 'transcriptBackfillRunner.fixture.ts')],
    cwd: process.cwd(),
    timeoutMs: 10_000,
    onSession: value => accepted.push(value),
  })
  expect(summary).toEqual({ attempted: 2, accepted: 2, failed: 0, rejected: 0 })
  expect(accepted).toHaveLength(2)
})

/**
 * Regression (2026-07-28): a record main cannot parse TERMINATES the run, so a
 * single atypical session abandoned every session queued behind it (30 of 32
 * caches went unrefreshed). The worker now self-checks with main's own parser
 * and reports such a session as a `failure` instead. That downgrade is only
 * worth anything if a `failure` lets the run continue, which is what this pins:
 * the item after a failed one is still accepted.
 */
test('a failed session does not abandon the sessions queued behind it', async () => {
  const accepted: TranscriptBackfillSessionResult[] = []
  const summary = await runTranscriptBackfill({
    items: [
      {
        appSessionId: APP_ID,
        engineSessionId: ENGINE_ID,
        transcriptPath: join('/tmp', `${ENGINE_ID}.jsonl`),
      },
      {
        appSessionId: APP_ID_TWO,
        engineSessionId: ENGINE_ID_TWO,
        transcriptPath: join('/tmp', `${ENGINE_ID_TWO}.jsonl`),
      },
    ],
    command: 'bun',
    args: ['run', join(here, 'transcriptBackfillRunner.fixture.ts')],
    cwd: process.cwd(),
    env: { CATCODE_FIXTURE_FAIL_FIRST: '1' },
    timeoutMs: 10_000,
    onSession: value => accepted.push(value),
  })
  expect(summary).toEqual({ attempted: 2, accepted: 1, failed: 1, rejected: 0 })
  // The specific claim: the SECOND session survived the first one's failure.
  expect(accepted.map(value => value.appSessionId)).toEqual([APP_ID_TWO])
})

test('runner reports a spawn failure without an unhandled stdin error', async () => {
  await expect(
    runTranscriptBackfill({
      items: [
        {
          appSessionId: APP_ID,
          engineSessionId: ENGINE_ID,
          transcriptPath: join('/tmp', `${ENGINE_ID}.jsonl`),
        },
      ],
      command: join(tmpdir(), 'catcode-missing-backfill-worker'),
      args: [],
      cwd: process.cwd(),
      timeoutMs: 1_000,
      onSession: () => {},
    }),
  ).rejects.toThrow()
})

test('runner contains a throwing cache-writer callback and rejects after reaping the child', async () => {
  await expect(
    runTranscriptBackfill({
      items: [
        {
          appSessionId: APP_ID,
          engineSessionId: ENGINE_ID,
          transcriptPath: join('/tmp', `${ENGINE_ID}.jsonl`),
        },
      ],
      command: 'bun',
      args: ['run', join(here, 'transcriptBackfillRunner.fixture.ts')],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      onSession: () => {
        throw new Error('simulated disk-full write failure')
      },
    }),
  ).rejects.toThrow('result callback failed')
})

test('an all-null worker result writes NO header, and stays re-queueable', () => {
  // The floor both writers share. An all-null header cannot beat any frame
  // fallback, and the renderer stops reading frames the moment a header exists,
  // so stamping one as current is pure loss — and it used to be PERMANENT loss,
  // because `cacheHasCurrentRunFacts` then counted the row as done forever.
  const dir = cacheDir()
  expect(
    persistTranscriptBackfillResult(
      {
        cacheDir: dir,
        getCurrentSession: () => descriptor(true),
        transcriptExists: () => true,
      },
      { ...result(), runFacts: NO_RUN_FACTS },
    ),
  ).toBe('written')
  const cache = readCache(dir, APP_ID)
  expect(cache?.header.runFacts).toBeUndefined()
  expect(cache?.header.runFactsVersion).toBeUndefined()
  // The transcript stays a candidate, so a later launch can try again.
  expect(cacheHasCurrentRunFacts(dir, APP_ID)).toBe(false)
})

test('a PARTIAL worker result is kept, because its frames can answer nothing', () => {
  // Deliberately NOT the close path's completeness rule. A backfilled cache's
  // frames come from `toSDKMessages`, which drops telemetry — measured on real
  // caches: zero `result` frames and zero frame-level `permissionMode`. So the
  // fallback names the model and nothing else, and discarding a partial header
  // would throw away the window and effort only this worker can resolve.
  const dir = cacheDir()
  persistTranscriptBackfillResult(
    {
      cacheDir: dir,
      getCurrentSession: () => descriptor(true),
      transcriptExists: () => true,
    },
    { ...result(), runFacts: { ...NO_RUN_FACTS, effort: 'high' } },
  )
  expect(readCache(dir, APP_ID)?.header.runFacts?.effort).toBe('high')
})
