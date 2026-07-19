import { expect, mock, test } from 'bun:test'
import type { SDKMessage } from '@cat-code/engine/session-events'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import {
  PROTOCOL_VERSION,
  type ServerFrame,
  type TranscriptCache,
} from '../../shared/protocol.js'
import {
  createPreviewTranscriptState,
  hasPreviewTranscript,
  openPreloadedPreview,
  projectPreviewTranscriptCache,
  reducePreviewTranscriptState,
} from './previewTranscriptState.js'
import { createShellState, reduceShellState } from './shellState.js'
import {
  STARTUP_PRELOAD_MAX_PROJECTED_BYTES,
  STARTUP_PRELOAD_MAX_SESSIONS,
  calculateStartupPreloadCapacity,
  estimateProjectedPreviewBytes,
  estimateProjectedPreviewStateBytes,
  runStartupTranscriptPreload,
  selectStartupPreloadCandidates,
} from './sessionPreload.js'

function descriptor(id: string, lastAttachedAt: number): SessionDescriptor {
  return {
    appSessionId: id,
    engineSessionId: `engine-${id}`,
    cwd: `/tmp/${id}`,
    title: null,
    status: 'exited',
    restorable: true,
    createdAt: lastAttachedAt,
    lastAttachedAt,
    lastMessageSentAt: null,
  }
}

function cache(id: string, body = `cached ${id}`): TranscriptCache {
  const frame: ServerFrame = {
    kind: 'event',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: id,
    replay: true,
    event: {
      type: 'message',
      message: {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: body }],
        },
        uuid: '00000000-0000-4000-8000-000000000001',
      } as unknown as SDKMessage,
    },
  }
  return {
    header: {
      appSessionId: id,
      engineSessionId: `engine-${id}`,
      protocolVersion: PROTOCOL_VERSION,
      appVersion: 'test',
      guardVersion: 1,
      writtenAt: 0,
    },
    frames: [frame],
  }
}

test('startup preload fills the store without panes; a store-first click needs no fetch', async () => {
  const sessions = [descriptor('older', 10), descriptor('newer', 20)]
  let preview = createPreviewTranscriptState()
  let shell = createShellState()
  for (const session of sessions) {
    shell = reduceShellState(shell, { type: 'session-added', session })
  }
  const previewSession = mock(async (id: string) => cache(id))

  await runStartupTranscriptPreload({
    descriptors: sessions,
    previewSession,
    onLoad: (loaded, projected) => {
      preview = reducePreviewTranscriptState(preview, {
        type: 'preview-load',
        cache: loaded,
        projected,
      })
    },
    isEligible: () => true,
    isAlreadyLoaded: id => hasPreviewTranscript(preview, id),
    isCancelled: () => false,
    throttleMs: 0,
    log: () => {},
  })

  expect(hasPreviewTranscript(preview, 'older')).toBe(true)
  expect(hasPreviewTranscript(preview, 'newer')).toBe(true)
  expect(shell.previews).toEqual({})

  const callsBeforeClick = previewSession.mock.calls.length
  const opened = mock(() => {
    shell = reduceShellState(shell, {
      type: 'preview-open',
      sessionId: 'newer',
    })
  })
  if (!openPreloadedPreview(preview, 'newer', opened)) {
    await previewSession('newer')
  }
  expect(shell.previews).toEqual({ newer: true })
  expect(opened).toHaveBeenCalledTimes(1)
  expect(previewSession).toHaveBeenCalledTimes(callsBeforeClick)

  const missFallback = mock(() => {})
  if (!openPreloadedPreview(preview, 'not-loaded', () => {})) missFallback()
  expect(missFallback).toHaveBeenCalledTimes(1)
})

test('store-only previews survive reconciliation; close and reap stay scoped', () => {
  const kept = descriptor('kept', 20)
  const removed = descriptor('removed', 10)
  let shell = createShellState()
  shell = reduceShellState(shell, { type: 'session-added', session: kept })
  shell = reduceShellState(shell, { type: 'session-added', session: removed })
  let preview = createPreviewTranscriptState()
  for (const id of ['kept', 'removed']) {
    preview = reducePreviewTranscriptState(preview, {
      type: 'preview-load',
      cache: cache(id),
    })
  }

  // App's reconciliation iterates shell.previews. A store-only entry owns no
  // pane, so there is nothing to close and the preview state remains resident.
  expect(Object.keys(shell.previews)).toEqual([])
  expect(hasPreviewTranscript(preview, 'kept')).toBe(true)

  shell = reduceShellState(shell, { type: 'preview-open', sessionId: 'kept' })
  shell = reduceShellState(shell, { type: 'preview-close', sessionId: 'kept' })
  expect(hasPreviewTranscript(preview, 'kept')).toBe(true)
  expect(hasPreviewTranscript(preview, 'removed')).toBe(true)

  shell = reduceShellState(shell, {
    type: 'session-removed',
    appSessionId: 'removed',
  })
  preview = reducePreviewTranscriptState(preview, {
    type: 'preview-reset',
    sessionId: 'removed',
  })
  expect(shell.byId.removed).toBeUndefined()
  expect(hasPreviewTranscript(preview, 'removed')).toBe(false)
  expect(hasPreviewTranscript(preview, 'kept')).toBe(true)
})

test('budget chooses newest rows and caps scans plus projected RAM', async () => {
  const sessions = [
    descriptor('oldest', 10),
    descriptor('newest', 40),
    descriptor('middle', 20),
    descriptor('newer', 30),
  ]
  expect(
    selectStartupPreloadCandidates(sessions, 3).map(row => row.appSessionId),
  ).toEqual(['newest', 'newer', 'middle'])

  const oneProjected = estimateProjectedPreviewBytes(
    projectPreviewTranscriptCache(cache('newest')),
  )
  const requested: string[] = []
  const loaded: string[] = []
  const waits: number[] = []
  const result = await runStartupTranscriptPreload({
    descriptors: sessions,
    previewSession: async id => {
      requested.push(id)
      return cache(id)
    },
    onLoad: loadedCache => loaded.push(loadedCache.header.appSessionId),
    isEligible: () => true,
    isAlreadyLoaded: () => false,
    isCancelled: () => false,
    maxSessions: 3,
    maxProjectedBytes: oneProjected,
    throttleMs: 25,
    wait: async ms => {
      waits.push(ms)
    },
    log: () => {},
  })

  expect(requested).toEqual(['newest', 'newer', 'middle'])
  expect(waits).toEqual([25, 25])
  expect(loaded).toEqual(['newest'])
  expect(result.loaded).toBe(1)
  expect(result.overScanBudget).toBe(1)
  expect(result.overRamBudget).toBe(2)
  expect(result.projectedBytes).toBe(oneProjected)
})

test('retained-state accounting sums the actual projected preview entries', () => {
  let state = createPreviewTranscriptState()
  for (const id of ['one', 'two']) {
    state = reducePreviewTranscriptState(state, {
      type: 'preview-load',
      cache: cache(id),
    })
  }
  const expected = Object.values(state.bySession).reduce(
    (total, entry) => total + estimateProjectedPreviewBytes(entry),
    0,
  )
  expect(estimateProjectedPreviewStateBytes(state)).toBe(expected)
})

test('shared capacity charges pending PL-B reservations without double-counting committed PL-A entries', () => {
  let state = createPreviewTranscriptState()
  state = reducePreviewTranscriptState(state, {
    type: 'preview-load',
    cache: cache('committed'),
  })
  const committedBytes = estimateProjectedPreviewBytes(
    state.bySession.committed!,
  )
  const pendingBytes = committedBytes + 17
  const capacity = calculateStartupPreloadCapacity(
    state,
    new Map([
      ['committed', committedBytes],
      ['pending', pendingBytes],
    ]),
  )

  expect(capacity.retainedSessions).toBe(2)
  expect(capacity.retainedBytes).toBe(committedBytes + pendingBytes)
  expect(capacity.remainingSessions).toBe(STARTUP_PRELOAD_MAX_SESSIONS - 2)
  expect(capacity.remainingBytes).toBe(
    STARTUP_PRELOAD_MAX_PROJECTED_BYTES - committedBytes - pendingBytes,
  )
})

test('miss uses on-click fallback; removal during read discards the result', async () => {
  let eligible = true
  const loaded: string[] = []
  const result = await runStartupTranscriptPreload({
    descriptors: [descriptor('removed', 20), descriptor('miss', 10)],
    previewSession: async id => {
      if (id === 'removed') {
        eligible = false
        return cache(id)
      }
      return null
    },
    onLoad: loadedCache => loaded.push(loadedCache.header.appSessionId),
    isEligible: id => id === 'miss' || eligible,
    isAlreadyLoaded: () => false,
    isCancelled: () => false,
    throttleMs: 0,
    log: () => {},
  })

  expect(loaded).toEqual([])
  expect(result.stale).toBe(1)
  expect(result.misses).toBe(1)
})
