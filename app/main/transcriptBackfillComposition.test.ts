import { afterEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SessionDescriptor } from '../shared/hostApi.js'
import { PROTOCOL_VERSION } from '../shared/protocol.js'
import type { TranscriptBackfillSessionResult } from '../shared/transcriptBackfill.js'
import {
  createPreviewTranscriptState,
  hasPreviewTranscript,
  openPreloadedPreview,
  reducePreviewTranscriptState,
} from '../renderer/src/previewTranscriptState.js'
import { runStartupTranscriptPreload } from '../renderer/src/sessionPreload.js'
import { persistTranscriptBackfillResult } from './transcriptBackfill.js'
import { readCache } from './transcriptCache.js'

const APP_ID = '11111111-1111-4111-8111-111111111111'
const ENGINE_ID = '22222222-2222-4222-8222-222222222222'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('PL-B cache is admitted by PL-A and the later click stays store-first', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'catcode-plab-compose-'))
  dirs.push(cacheDir)
  const descriptor: SessionDescriptor = {
    appSessionId: APP_ID,
    engineSessionId: ENGINE_ID,
    cwd: '/tmp',
    title: null,
    titleUpdatedAt: null,
    status: 'exited',
    restorable: true,
    createdAt: 1,
    lastAttachedAt: 2,
    lastMessageSentAt: null,
  }
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
