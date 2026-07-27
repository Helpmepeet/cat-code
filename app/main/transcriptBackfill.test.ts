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

/** Worker results always carry run facts; these fixtures exercise other
 * concerns, so they use the all-null value the boundary requires. */
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
    runFacts: NO_RUN_FACTS,
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
