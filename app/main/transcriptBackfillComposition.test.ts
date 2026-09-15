import { afterEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SessionDescriptor } from '../shared/hostApi.js'
import { sessionDescriptorFixture } from '../shared/sessionDescriptor.fixture.js'
import { PROTOCOL_VERSION, type ServerFrame } from '../shared/protocol.js'
import type { TranscriptBackfillSessionResult } from '../shared/transcriptBackfill.js'
import { readTranscriptRunFacts } from '../shared/transcriptRunFacts.js'
import {
  createPreviewTranscriptState,
  hasPreviewTranscript,
  openPreloadedPreview,
  reducePreviewTranscriptState,
  selectPreviewRunFacts,
} from '../renderer/src/previewTranscriptState.js'
import { runStartupTranscriptPreload } from '../renderer/src/sessionPreload.js'
import { persistTranscriptBackfillResult } from './transcriptBackfill.js'
import {
  buildClosedSessionCache,
  createTranscriptCache,
  readCache,
  readCachedRunFacts,
  writeCache,
} from './transcriptCache.js'

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
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('PL-B cache is admitted by PL-A and the later click stays store-first', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'catcode-plab-compose-'))
  dirs.push(cacheDir)
  const descriptor: SessionDescriptor = sessionDescriptorFixture({
    appSessionId: APP_ID,
    engineSessionId: ENGINE_ID,
    cwd: '/tmp',
    status: 'exited',
    restorable: true,
    createdAt: 1,
    lastAttachedAt: 2,
  })
  const result: TranscriptBackfillSessionResult = {
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
            message: { role: 'user', content: 'backfilled then preloaded' },
          },
        } as never,
      },
    ],
    runFacts: NO_RUN_FACTS,
  }
  expect(
    persistTranscriptBackfillResult(
      {
        cacheDir,
        getCurrentSession: () => descriptor,
        transcriptExists: () => true,
      },
      result,
    ),
  ).toBe('written')

  let preview = createPreviewTranscriptState()
  const previewSession = mock(async () => readCache(cacheDir, APP_ID))
  await runStartupTranscriptPreload({
    descriptors: [descriptor],
    previewSession,
    onLoad: (cache, projected) => {
      preview = reducePreviewTranscriptState(preview, {
        type: 'preview-load',
        cache,
        projected,
      })
    },
    isEligible: () => true,
    isAlreadyLoaded: id => hasPreviewTranscript(preview, id),
    isCancelled: () => false,
    throttleMs: 0,
    log: () => {},
  })
  expect(hasPreviewTranscript(preview, APP_ID)).toBe(true)
  expect(previewSession).toHaveBeenCalledTimes(1)

  const opened = mock(() => {})
  expect(openPreloadedPreview(preview, APP_ID, opened)).toBe(true)
  expect(opened).toHaveBeenCalledTimes(1)
  expect(previewSession).toHaveBeenCalledTimes(1)
})

/* ------------------------------------------------------------------------- *
 * A session CLOSED after the once-per-process startup backfill already ran
 * ------------------------------------------------------------------------- *
 *
 * The defect these cover: startup backfill is the only thing that had ever read
 * a raw transcript, and it runs once per app process. Every session closed
 * afterwards was persisted by main's distill path, which wrote no run facts at
 * all — and `effort` is the one fact the cached FRAMES cannot recover (the
 * engine's message conversion drops the `codex_send_path` records it rides on).
 * So a session that plainly ran at `high` previewed with a blank effort face
 * until a later launch re-backfilled it, and the close write could flatten a
 * cache an earlier backfill had already enriched.
 *
 * These drive the REAL reader against a real transcript file and the REAL
 * renderer selector, because the contract that matters spans both: what main
 * writes must be exactly what the renderer, which trusts a header wholesale,
 * can honour.
 */

/** One `system`/`run_facts` line, as `recordRunFacts` writes it. */
function runFactsRecord(): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'run_facts',
    sessionId: ENGINE_ID,
    uuid: '55555555-5555-4555-8555-555555555555',
    timestamp: '2026-08-08T16:30:02.845Z',
    model: 'gpt-5.6-sol',
    permissionMode: 'auto',
    effort: 'high',
    contextWindow: 372_000,
  })
}

/** An assistant record carrying the usage the donut sums. */
function assistantRecord(): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: ENGINE_ID,
    message: {
      role: 'assistant',
      model: 'gpt-5.6-sol',
      usage: {
        input_tokens: 140_000,
        cache_read_input_tokens: 3_000,
        cache_creation_input_tokens: 0,
        output_tokens: 841,
      },
    },
  })
}

function writeTranscript(dir: string, lines: string[]): string {
  const path = join(dir, `${ENGINE_ID}.jsonl`)
  writeFileSync(path, `${lines.join('\n')}\n`)
  return path
}

/**
 * What the close path snapshots: the sticky `ready` head plus this session's
 * transcript frames, including the live `result` the frame fallback reads its
 * usage and exact context window off.
 */
function closeFrames(): ServerFrame[] {
  return [
    {
      kind: 'ready',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: APP_ID,
      engineSessionId: ENGINE_ID,
      payload: { type: 'app.ready' } as never,
    },
    {
      kind: 'event',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: APP_ID,
      event: {
        type: 'message',
        message: {
          type: 'assistant',
          session_id: ENGINE_ID,
          parent_tool_use_id: null,
          permissionMode: 'auto',
          message: {
            role: 'assistant',
            model: 'gpt-5.6-sol',
            usage: {
              input_tokens: 140_000,
              cache_read_input_tokens: 3_000,
              cache_creation_input_tokens: 0,
              output_tokens: 841,
            },
          },
        },
      } as never,
    },
    {
      kind: 'event',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: APP_ID,
      event: {
        type: 'message',
        message: {
          type: 'result',
          session_id: ENGINE_ID,
          parent_tool_use_id: null,
          modelUsage: { 'gpt-5.6-sol': { contextWindow: 372_000 } },
        },
      } as never,
    },
  ]
}

function persistClose(cacheDir: string, transcriptPath: string | null): void {
  const cache = buildClosedSessionCache(
    {
      transcriptPath: () => transcriptPath,
      readRunFacts: path => readTranscriptRunFacts(path, () => null),
      readCachedRunFacts: (id, engineSessionId) =>
        readCachedRunFacts(cacheDir, id, engineSessionId),
    },
    closeFrames(),
  )
  expect(cache).not.toBeNull()
  if (cache) writeCache(cacheDir, cache)
}

test('a session closed AFTER startup backfill still previews with its effort', () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'catcode-close-facts-'))
  dirs.push(cacheDir)
  const transcript = writeTranscript(cacheDir, [
    runFactsRecord(),
    assistantRecord(),
  ])

  persistClose(cacheDir, transcript)

  const cache = readCache(cacheDir, APP_ID)
  expect(cache).not.toBeNull()
  if (!cache) return
  const facts = selectPreviewRunFacts(cache)
  // The fact frames can never carry, now present without a second worker run.
  expect(facts.effort).toBe('high')
  // And nothing the frame fallback used to supply was traded away for it.
  expect(facts.model).toBe('gpt-5.6-sol')
  expect(facts.permissionMode).toBe('auto')
  expect(facts.contextUsage?.contextWindow).toBe(372_000)
  expect(facts.contextUsage?.usedTokens).toBe(143_841)
})

test('a close after backfill does not flatten the cache backfill enriched', () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'catcode-close-clobber-'))
  dirs.push(cacheDir)
  // A LEGACY transcript: written before the engine recorded run facts, so it
  // states no context window and main has no resolver to derive one.
  const transcript = writeTranscript(cacheDir, [assistantRecord()])

  // Startup backfill already enriched this row (the worker HAD the engine's
  // window resolver, and read the effort off the raw transcript).
  writeCache(
    cacheDir,
    createTranscriptCache(APP_ID, ENGINE_ID, closeFrames().slice(1), {
      model: 'gpt-5.6-sol',
      permissionMode: 'auto',
      effort: 'xhigh',
      usedTokens: 100_000,
      contextWindow: 372_000,
    }),
  )

  persistClose(cacheDir, transcript)

  const cache = readCache(cacheDir, APP_ID)
  expect(cache).not.toBeNull()
  if (!cache) return
  const facts = selectPreviewRunFacts(cache)
  expect(facts.effort).toBe('xhigh')
  expect(facts.contextUsage?.contextWindow).toBe(372_000)
  // The transcript's own newer reading still wins where it has one.
  expect(facts.contextUsage?.usedTokens).toBe(143_841)
})

test('with nothing to enrich from, the preview is exactly what the frames say', () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'catcode-close-legacy-'))
  dirs.push(cacheDir)
  const transcript = writeTranscript(cacheDir, [assistantRecord()])

  persistClose(cacheDir, transcript)

  const cache = readCache(cacheDir, APP_ID)
  expect(cache?.header.runFacts).toBeUndefined()
  if (!cache) return
  const facts = selectPreviewRunFacts(cache)
  // No effort — frames never carried it. But the header the gate refused to
  // write would have cost all three of these, and swapped the real window for
  // the renderer's 200k default.
  expect(facts.effort).toBeNull()
  expect(facts.model).toBe('gpt-5.6-sol')
  expect(facts.permissionMode).toBe('auto')
  expect(facts.contextUsage?.contextWindow).toBe(372_000)
})
