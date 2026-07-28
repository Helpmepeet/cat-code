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
  projectPreviewTranscriptCache,
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

test('preview-load retains an already-projected entry without projecting again', () => {
  const cached = cache([messageFrame(0)])
  const projected = projectPreviewTranscriptCache(cached)
  const preview = reducePreviewTranscriptState(createPreviewTranscriptState(), {
    type: 'preview-load',
    cache: cached,
    projected,
  })

  expect(preview.bySession[SID]).toBe(projected)
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

// LAYER HONESTY. This exercises the claim helper alone: the first call for a
// session wins and every later one loses, independently per session. It says
// NOTHING about which interactions reach it. Its previous name promised three
// ("focus, pointer-down, and dwell"), but the body called one function three
// times with identical arguments, so detaching `onPointerDown` from the composer
// would lose click-to-restore with this test still green.
//
// The companion test — render the pane and fire the real handlers — cannot be
// written here. `App`/`SessionPane` call hooks and this suite renders to static
// markup only, so no handler is ever attached to fire. The wiring that is
// therefore UNPROVEN by any test: the composer's `onFocus` and `onPointerDown`
// (both `engagePreviewPane` in App.tsx), and the cache-miss branch of
// `performRestore`. Those are the three live callers today; the 300 ms pane
// dwell the old name referred to was removed (cut-list §I.1, ruling #3).
test('claimLazyRestore is idempotent per session', () => {
  const claimed = new Set<string>()
  expect(claimLazyRestore(claimed, SID)).toBe(true)
  expect(claimLazyRestore(claimed, SID)).toBe(false)
  expect(claimLazyRestore(claimed, SID)).toBe(false)
  // Per session, not global: a second session still gets its one claim.
  expect(claimLazyRestore(claimed, 'other-session')).toBe(true)
  expect(claimLazyRestore(claimed, 'other-session')).toBe(false)
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

/* ── run facts: what the composer rail can say with no engine ─────────────── */

function assistantFrame(model: string, index: number): ServerFrame {
  return {
    kind: 'event',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SID,
    event: {
      type: 'message',
      message: {
        type: 'assistant',
        message: {
          role: 'assistant',
          model,
          content: [{ type: 'text', text: `body ${index}` }],
        },
        uuid: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      } as unknown as SDKMessage,
    },
  }
}

function userFrame(permissionMode: string, index: number): ServerFrame {
  return {
    kind: 'event',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SID,
    event: {
      type: 'message',
      message: {
        type: 'user',
        message: { role: 'user', content: `ask ${index}` },
        permissionMode,
        uuid: `00000000-0000-4000-8000-${String(900 + index).padStart(12, '0')}`,
      } as unknown as SDKMessage,
    },
  }
}

function sendPathFrame(effort: string, index: number): ServerFrame {
  return {
    kind: 'event',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SID,
    event: {
      type: 'message',
      message: {
        type: 'system',
        subtype: 'codex_send_path',
        effort,
        uuid: `00000000-0000-4000-8000-${String(800 + index).padStart(12, '0')}`,
      } as unknown as SDKMessage,
    },
  }
}

function resultFrame(inputTokens: number): ServerFrame {
  return {
    kind: 'event',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SID,
    event: {
      type: 'message',
      message: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        usage: { input_tokens: inputTokens },
        uuid: '00000000-0000-4000-8000-00000000ffff',
      } as unknown as SDKMessage,
    },
  }
}

/**
 * The defect: a previewed session has no sidecar, so the rail read empty live
 * seams and showed no model plus a 0% donut for a session that plainly used
 * context. Both answers are in the session's own cached traffic.
 */
test('run facts come from the cached session: newest model, real context', () => {
  const entry = projectPreviewTranscriptCache(
    cache([
      assistantFrame('claude-sonnet-5', 0),
      assistantFrame('gpt-5.6-terra', 1),
      resultFrame(42_000),
    ]),
  )

  // The NEWEST model, not the first: a session that switched models mid-way
  // ran on the later one.
  expect(entry.runFacts.model).toBe('gpt-5.6-terra')
  expect(entry.runFacts.contextUsage?.usedTokens).toBe(42_000)
  expect(entry.runFacts.contextUsage?.percentUsed).toBeGreaterThan(0)
})

/**
 * The other half of the fix, and the reason `contextUsage` is nullable: with
 * no result cached, the live selector would return a real 0% gauge, which
 * asserts "this session used no context". Null lets the rail render nothing.
 */
test('a cache with no result reports no usage rather than zero', () => {
  const entry = projectPreviewTranscriptCache(
    cache([assistantFrame('claude-sonnet-5', 0)]),
  )
  expect(entry.runFacts.model).toBe('claude-sonnet-5')
  expect(entry.runFacts.contextUsage).toBeNull()
})

test('an empty cache claims nothing at all', () => {
  const entry = projectPreviewTranscriptCache(cache([]))
  expect(entry.runFacts).toEqual({
    model: null,
    contextUsage: null,
    permissionMode: null,
    effort: null,
  })
})

/**
 * Mode and effort are not on the message types that declare them: verified
 * against real transcripts (2026-07-27), `permissionMode` rides USER messages
 * and `effort` rides `system`/`codex_send_path`. Both are read positionally,
 * so this test is the guard that the positions are the REAL ones and not the
 * ones the type snapshot suggests.
 */
test('mode and effort are read from where the engine actually writes them', () => {
  const entry = projectPreviewTranscriptCache(
    cache([
      userFrame('plan', 0),
      sendPathFrame('high', 1),
      userFrame('acceptEdits', 2),
      sendPathFrame('xhigh', 3),
    ]),
  )
  // Newest of each, again: a session that escalated mid-way ran on the later.
  expect(entry.runFacts.permissionMode).toBe('acceptEdits')
  expect(entry.runFacts.effort).toBe('xhigh')
})

/**
 * An engine-internal mode the picker cannot offer (`auto`, permissions.ts:28)
 * is still what the session ran under, and real transcripts are full of it.
 * It must survive to the rail rather than being filtered to null for not
 * being a settable mode.
 */
test('an engine-internal mode survives to the rail', () => {
  const entry = projectPreviewTranscriptCache(cache([userFrame('auto', 0)]))
  expect(entry.runFacts.permissionMode).toBe('auto')
})

/** An Anthropic session has no codex send-path record, so effort stays null. */
test('a session with no effort record reports none', () => {
  const entry = projectPreviewTranscriptCache(
    cache([assistantFrame('claude-sonnet-5', 0)]),
  )
  expect(entry.runFacts.effort).toBeNull()
})

/**
 * The subtype guard is load-bearing, not decoration. Real transcripts carry
 * several `system` subtypes (`turn_duration`, `informational`, …); only
 * `codex_send_path` records the effort a request was SENT with. Reading
 * `effort` off any system message would silently adopt an unrelated field.
 */
test('effort is ignored on a system message of another subtype', () => {
  const stray: ServerFrame = {
    kind: 'event',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SID,
    event: {
      type: 'message',
      message: {
        type: 'system',
        subtype: 'turn_duration',
        effort: 'low',
        uuid: '00000000-0000-4000-8000-0000000000cc',
      } as unknown as SDKMessage,
    },
  }
  const entry = projectPreviewTranscriptCache(
    cache([sendPathFrame('xhigh', 0), stray]),
  )
  // The stray is NEWER, so a missing guard would return its 'low'.
  expect(entry.runFacts.effort).toBe('xhigh')
})

/**
 * The header is the ONLY source that can answer mode/effort for a backfilled
 * cache: its frames are conversation-only, because the engine's `toSDKMessages`
 * conversion drops the telemetry. Measured against real caches (2026-07-28):
 * 1,615 assistant + 889 user frames, 0 result, 0 permissionMode. So a cache
 * whose header carries facts must be believed over its own frames.
 */
test('header run facts win over the frames, which cannot know mode or effort', () => {
  const withHeader: TranscriptCache = {
    ...cache([assistantFrame('claude-sonnet-5', 0)]),
    header: {
      ...cache([]).header,
      runFacts: {
        model: 'gpt-5.6-terra',
        permissionMode: 'auto',
        effort: 'xhigh',
        usedTokens: 50_000,
        contextWindow: 200_000,
      },
    },
  }
  const entry = projectPreviewTranscriptCache(withHeader)
  // The frame says sonnet; the header is the authority and says terra.
  expect(entry.runFacts.model).toBe('gpt-5.6-terra')
  expect(entry.runFacts.permissionMode).toBe('auto')
  expect(entry.runFacts.effort).toBe('xhigh')
  expect(entry.runFacts.contextUsage?.percentUsed).toBe(25)
})

/**
 * The header's window used to be structurally null (the worker declared the
 * field and never assigned it), so every backfilled donut silently divided by
 * the 200k fallback. Now that the worker resolves a real one, the denominator
 * has to follow it rather than the constant.
 */
test('a header window other than 200k drives the donut, not the fallback', () => {
  const withWindow = (contextWindow: number | null): TranscriptCache => ({
    ...cache([assistantFrame('gpt-5.6-terra', 0)]),
    header: {
      ...cache([]).header,
      runFacts: {
        model: 'gpt-5.6-terra',
        permissionMode: null,
        effort: null,
        usedTokens: 186_000,
        contextWindow,
      },
    },
  })

  const real = projectPreviewTranscriptCache(withWindow(372_000)).runFacts
  expect(real.contextUsage?.contextWindow).toBe(372_000)
  expect(real.contextUsage?.percentUsed).toBe(50)

  // A source that stated no window still falls back, so an older cache written
  // before the worker resolved one keeps rendering exactly as it did.
  const unstated = projectPreviewTranscriptCache(withWindow(null)).runFacts
  expect(unstated.contextUsage?.contextWindow).toBe(200_000)
  expect(unstated.contextUsage?.percentUsed).toBe(93)
})

/**
 * A cache written on session CLOSE has no header facts, and its frames still
 * hold a live `result`. The frame scan is that path's answer, not dead code.
 */
test('with no header, the frame scan still answers what the frames can', () => {
  const entry = projectPreviewTranscriptCache(
    cache([assistantFrame('claude-sonnet-5', 0), resultFrame(42_000)]),
  )
  expect(entry.runFacts.model).toBe('claude-sonnet-5')
  expect(entry.runFacts.contextUsage?.usedTokens).toBe(42_000)
})
