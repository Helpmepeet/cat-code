import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { SessionDescriptor } from '../shared/hostApi.js'
import { PROTOCOL_VERSION } from '../shared/protocol.js'
import type { TranscriptBackfillSessionResult } from '../shared/transcriptBackfill.js'
import { readCache } from './transcriptCache.js'
import {
  persistTranscriptBackfillResult,
  runTranscriptBackfill,
} from './transcriptBackfill.js'

const APP_ID = '11111111-1111-4111-8111-111111111111'
const ENGINE_ID = '22222222-2222-4222-8222-222222222222'
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
    status: restorable ? 'exited' : 'ready',
    restorable,
    createdAt: 1,
    lastAttachedAt: 2,
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
            message: { role: 'user', content: 'backfilled' },
          },
        } as never,
      },
    ],
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
    ],
    command: 'bun',
    args: ['run', join(here, 'transcriptBackfillRunner.fixture.ts')],
    cwd: process.cwd(),
    timeoutMs: 10_000,
    onSession: value => accepted.push(value),
  })
  expect(summary).toEqual({ attempted: 1, accepted: 1, failed: 0, rejected: 0 })
  expect(accepted).toHaveLength(1)
})
