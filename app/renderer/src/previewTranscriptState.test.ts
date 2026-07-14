import { expect, test } from 'bun:test'
import type { SDKMessage } from '@cat-code/engine/session-events'
import {
  PROTOCOL_VERSION,
  type ReadyFrame,
  type ServerFrame,
  type TranscriptCache,
} from '../../shared/protocol.js'
import { createConnectionState } from './connectionState.js'
import { createPermissionState } from './permissionState.js'
import {
  createRawMessageLogState,
  reduceServerFrame,
  selectRawMessageLog,
} from './rawMessageLog.js'
import { batch } from './serverFrameBatch.js'
import {
  claimLazyRestore,
  createPreviewTranscriptState,
  previewClosePlan,
  reduceLiveTranscriptState,
  reducePreviewTranscriptState,
  selectPreviewSwapSessions,
  selectPreviewTranscript,
  selectPreviewTruncationMessage,
} from './previewTranscriptState.js'
import {
  createTranscriptState,
  projectServerFrame,
  selectTranscriptRows,
} from './transcriptProjector.js'

const SID = 'preview-session'

function ready(inputEnabled = true): ReadyFrame {
  return {
    kind: 'ready',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SID,
    engineSessionId: 'engine-preview-session',
    payload: {
      type: 'app.ready',
      protocolVersion: PROTOCOL_VERSION,
      inputEnabled,
      activeTurn: false,
      abort: { status: 'idle' },
      goalSnapshot: null,
      pendingPermissionRequests: [],
    },
  }
}

function messageFrame(index: number, replay = true): ServerFrame {
  return {
    kind: 'event',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SID,
    ...(replay ? { replay: true as const } : {}),
    event: {
      type: 'message',
      message: {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `body ${index}` }],
        },
        uuid: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      } as unknown as SDKMessage,
    },
  }
}

function cache(frames: ServerFrame[]): TranscriptCache {
  return {
    header: {
      appSessionId: SID,
      engineSessionId: 'engine-preview-session',
      protocolVersion: PROTOCOL_VERSION,
      appVersion: 'test',
      guardVersion: 1,
      writtenAt: 0,
    },
    frames,
  }
}

test('cache frames project to the same transcript rows as the live projector', () => {
  const frames = [messageFrame(0), messageFrame(1)]
  const preview = reducePreviewTranscriptState(createPreviewTranscriptState(), {
    type: 'preview-load',
    cache: cache(frames),
  })

  let live = projectServerFrame(createTranscriptState(), ready())
  for (const frame of frames) live = projectServerFrame(live, frame)

  const previewTranscript = selectPreviewTranscript(preview, SID)
  expect(previewTranscript).not.toBeNull()
  expect(selectTranscriptRows(previewTranscript!, SID)).toEqual(
    selectTranscriptRows(live, SID),
  )
})

test('preview-reset drops exactly one session', () => {
  const otherCache = {
    ...cache([messageFrame(1)]),
    header: { ...cache([]).header, appSessionId: 'other' },
    frames: [{ ...messageFrame(1), sessionId: 'other' }],
  }
  let state = reducePreviewTranscriptState(createPreviewTranscriptState(), {
    type: 'preview-load',
    cache: cache([messageFrame(0)]),
  })
  state = reducePreviewTranscriptState(state, {
    type: 'preview-load',
    cache: otherCache,
  })
  state = reducePreviewTranscriptState(state, {
    type: 'preview-reset',
    sessionId: SID,
  })

  expect(selectPreviewTranscript(state, SID)).toBeNull()
  expect(selectPreviewTranscript(state, 'other')).not.toBeNull()
})

test('cache ready and permission frames are structurally isolated from operational stores', () => {
  const connection = createConnectionState()
  const permissions = createPermissionState()
  const permissionFrame = {
    kind: 'permission.context',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SID,
    context: null,
  } as unknown as ServerFrame

  const preview = reducePreviewTranscriptState(createPreviewTranscriptState(), {
    type: 'preview-load',
    cache: cache([ready(), permissionFrame, messageFrame(0)]),
  })

  expect(connection).toEqual({ sessions: {} })
  expect(permissions).toEqual(createPermissionState())
  expect(Object.keys(preview)).toEqual(['bySession'])
  expect(selectTranscriptRows(selectPreviewTranscript(preview, SID)!, SID)).toHaveLength(1)
})

test('a truncation-only cache preserves its visible boundary message', () => {
  const boundary: ServerFrame = {
    kind: 'error',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SID,
    requestId: 'catcode.history-truncated',
    code: 'internal_error',
    message: 'Earlier restored history was omitted.',
    retryable: false,
  }
  const preview = reducePreviewTranscriptState(createPreviewTranscriptState(), {
    type: 'preview-load',
    cache: cache([boundary]),
  })

  expect(selectTranscriptRows(selectPreviewTranscript(preview, SID)!, SID)).toEqual([])
  expect(selectPreviewTruncationMessage(preview, SID)).toBe(
    'Earlier restored history was omitted.',
  )

  let liveLog = reduceServerFrame(createRawMessageLogState(), ready())
  liveLog = reduceServerFrame(liveLog, boundary)
  expect(selectRawMessageLog(liveLog, SID).error).toBe(
    'Earlier restored history was omitted.',
  )
})

test('swap observations cover replay batches and ready zero-history batches', () => {
  const previewing = new Set([SID])
  expect(selectPreviewSwapSessions([messageFrame(0)], previewing)).toEqual([SID])
  expect(selectPreviewSwapSessions([ready(true)], previewing)).toEqual([SID])
  expect(selectPreviewSwapSessions([ready(false)], previewing)).toEqual([])
  expect(selectPreviewSwapSessions([messageFrame(0, false)], previewing)).toEqual([])
})

test('focus, pointer-down, and dwell can claim one lazy restore only once', () => {
  const claimed = new Set<string>()
  expect(claimLazyRestore(claimed, SID)).toBe(true)
  expect(claimLazyRestore(claimed, SID)).toBe(false)
  expect(claimLazyRestore(claimed, SID)).toBe(false)
})

test('preview close is local before engagement and cancels or closes after restore starts', () => {
  expect(previewClosePlan(false, false)).toEqual({
    cancelRestore: false,
    closeLive: false,
  })
  expect(previewClosePlan(false, true)).toEqual({
    cancelRestore: true,
    closeLive: false,
  })
  expect(previewClosePlan(true, true)).toEqual({
    cancelRestore: true,
    closeLive: true,
  })
})

test('wholesale swap leaves one live copy and zero-history swaps to empty', () => {
  const frame = messageFrame(0)
  let preview = reducePreviewTranscriptState(createPreviewTranscriptState(), {
    type: 'preview-load',
    cache: cache([frame]),
  })
  let live = projectServerFrame(createTranscriptState(), ready())
  live = projectServerFrame(live, frame)
  live = reduceLiveTranscriptState(live, {
    type: 'preview-live-reset',
    sessionId: SID,
  })
  live = reduceLiveTranscriptState(live, batch([ready(), frame]))
  preview = reducePreviewTranscriptState(preview, {
    type: 'preview-reset',
    sessionId: SID,
  })

  expect(selectPreviewTranscript(preview, SID)).toBeNull()
  expect(selectTranscriptRows(live, SID)).toHaveLength(1)

  let zeroHistoryLive = projectServerFrame(createTranscriptState(), ready())
  zeroHistoryLive = projectServerFrame(zeroHistoryLive, frame)
  zeroHistoryLive = reduceLiveTranscriptState(zeroHistoryLive, {
    type: 'preview-live-reset',
    sessionId: SID,
  })
  zeroHistoryLive = reduceLiveTranscriptState(
    zeroHistoryLive,
    batch([ready()]),
  )
  expect(selectTranscriptRows(zeroHistoryLive, SID)).toEqual([])
})
