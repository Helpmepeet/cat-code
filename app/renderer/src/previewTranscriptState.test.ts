import { expect, test } from 'bun:test'
import type { SDKMessage } from '@cat-code/engine/session-events'
import {
  PROTOCOL_VERSION,
  type ReadyFrame,
  type ServerFrame,
  type TranscriptCache,
} from '../../shared/protocol.js'
import { createConnectionState } from './connectionState.js'
import { selectContextPercent } from './contextUsage.js'
import { createPermissionState } from './permissionState.js'
import {
  createRawMessageLogState,
  reduceServerFrame,
  selectRawMessageLog,
} from './rawMessageLog.js'
import { batch } from './serverFrameBatch.js'
import { AttachmentGate } from '../../main/attachmentGate.js'
import {
  applyPreviewHandover,
  claimLazyRestore,
  createPreviewTranscriptState,
  claimPreviewSwaps,
  projectPreviewTranscriptCache,
  previewClosePlan,
  reduceLiveTranscriptState,
  reducePreviewTranscriptState,
  selectPaneTranscript,
  selectPreviewSwapSessions,
  selectPreviewTranscript,
} from './previewTranscriptState.js'
import {
  createTranscriptState,
  projectServerFrame,
  selectNestedTranscriptRows,
  selectTranscriptRows,
} from './transcriptProjector.js'
import {
  HISTORY_REPLAY_TRUNCATION_REQUEST_ID,
  REPLAY_BUFFER_TRUNCATION_REQUEST_ID,
} from '../../shared/protocol.js'

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

test('session removal releases the full live transcript state', () => {
  let state = reduceLiveTranscriptState(createTranscriptState(), ready())
  state = reduceLiveTranscriptState(state, messageFrame(0))

  state = reduceLiveTranscriptState(state, {
    type: 'session-removed',
    sessionId: SID,
  })

  expect(state.sessions).toEqual({})
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

test('a truncation-only cache still reads as incomplete, with no message rows', () => {
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

  const projected = selectPreviewTranscript(preview, SID)!
  expect(selectTranscriptRows(projected, SID)).toEqual([])
  // No surviving row to sit above, so no boundary row: the pane draws its
  // restore/welcome state rather than a hairline over nothing.
  expect(selectNestedTranscriptRows(projected, SID)).toEqual([])

  let liveLog = reduceServerFrame(createRawMessageLogState(), ready())
  liveLog = reduceServerFrame(liveLog, boundary)
  expect(selectRawMessageLog(liveLog, SID).error).toBeNull()
})

test('pane selection uses an admitted cache only for an explicit preview', () => {
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
    cache: cache([boundary, messageFrame(0)]),
  })
  const live = projectServerFrame(createTranscriptState(), ready())

  expect(
    selectPaneTranscript({
      previewState: preview,
      sessionId: SID,
      previewOpen: false,
      liveTranscript: live,
    }),
  ).toEqual({
    transcript: live,
    preview: false,
    runFacts: null,
  })

  const selectedPreview = selectPaneTranscript({
    previewState: preview,
    sessionId: SID,
    previewOpen: true,
    liveTranscript: live,
  })
  expect(selectedPreview.transcript).toBe(preview.bySession[SID]!.transcript)
  expect(selectedPreview.preview).toBe(true)
  expect(
    selectNestedTranscriptRows(selectedPreview.transcript, SID).map(
      row => row.kind,
    ),
  ).toEqual(['history-boundary', 'assistant-text'])
  expect(selectedPreview.runFacts).toBe(preview.bySession[SID]?.runFacts)
})

test('pane selection falls back to live after preview handover resets the cache', () => {
  let preview = reducePreviewTranscriptState(createPreviewTranscriptState(), {
    type: 'preview-load',
    cache: cache([messageFrame(0)]),
  })
  const live = projectServerFrame(createTranscriptState(), ready())

  expect(
    selectPaneTranscript({
      previewState: preview,
      sessionId: SID,
      previewOpen: true,
      liveTranscript: live,
    }).preview,
  ).toBe(true)

  preview = reducePreviewTranscriptState(preview, {
    type: 'preview-reset',
    sessionId: SID,
  })
  expect(
    selectPaneTranscript({
      previewState: preview,
      sessionId: SID,
      previewOpen: true,
      liveTranscript: live,
    }),
  ).toEqual({
    transcript: live,
    preview: false,
    runFacts: null,
  })
})

test('swap observations cover replay batches and ready zero-history batches', () => {
  const previewing = new Set([SID])
  expect(selectPreviewSwapSessions([messageFrame(0)], previewing)).toEqual([SID])
  expect(selectPreviewSwapSessions([ready(true)], previewing)).toEqual([SID])
  expect(selectPreviewSwapSessions([ready(false)], previewing)).toEqual([])
  expect(selectPreviewSwapSessions([messageFrame(0, false)], previewing)).toEqual([])
})

/* ── the preview→live handover, driven the way App's subscription drives it ── */

/**
 * The production ordering under test is `applyPreviewHandover`; only the store
 * wiring is local. Deliberately NOT a hand-rolled copy of App's loop — a
 * reconstruction stays green when the real subscription stops calling it.
 * `previewing` is mutable so a test can change preview membership BETWEEN
 * deliveries, which is what separates the sequences below.
 */
function handover(cached?: TranscriptCache) {
  const claimed = new Set<string>()
  const previewing = new Set<string>()
  let preview = createPreviewTranscriptState()
  if (cached) {
    preview = reducePreviewTranscriptState(preview, {
      type: 'preview-load',
      cache: cached,
    })
  }
  let live = createTranscriptState()
  return {
    claimed,
    previewing,
    deliver(frames: readonly ServerFrame[]) {
      applyPreviewHandover(frames, previewing, claimed, {
        resetLiveSession: sessionId => {
          live = reduceLiveTranscriptState(live, {
            type: 'preview-live-reset',
            sessionId,
          })
        },
        applyFrames: () => {
          live = reduceLiveTranscriptState(live, batch(frames))
        },
        resetPreview: sessionId => {
          preview = reducePreviewTranscriptState(preview, {
            type: 'preview-reset',
            sessionId,
          })
        },
      })
    },
    loadPreview(next: TranscriptCache) {
      // What App does on every `preview-load`: a new cache is a new generation,
      // so the handover claim made against the old one is released.
      claimed.delete(SID)
      preview = reducePreviewTranscriptState(preview, {
        type: 'preview-load',
        cache: next,
      })
    },
    rows: () => selectTranscriptRows(live, SID),
    rowKinds: () => selectNestedTranscriptRows(live, SID).map(row => row.kind),
    cached: () => selectPreviewTranscript(preview, SID),
  }
}

/**
 * The batches main ACTUALLY delivers, from the real gate: coalescing is armed
 * by the restore IPC and the 50 ms timer flushes whatever has arrived, so a
 * replay bigger than one window lands as a head batch plus bare replay batches.
 * `flushAfter` is the frame index the timer fires on.
 */
function deliveredBatches(
  frames: readonly ServerFrame[],
  flushAfter: number,
): ServerFrame[][] {
  const gate = new AttachmentGate()
  gate.onRendererReady()
  gate.startReplayCoalescing(SID)
  const batches: ServerFrame[][] = []
  const push = (delivered: ServerFrame[]): void => {
    if (delivered.length > 0) batches.push(delivered)
  }
  frames.forEach((frame, index) => {
    push(gate.onFrame(SID, frame))
    if (index === flushAfter) push(gate.flushReplayCoalescing(SID))
  })
  push(gate.flushReplayCoalescing(SID))
  return batches
}

// The restore that does not fit one batch (2026-08-05, reported live: 346
// messages replayed, none displayed). An unclaimed second `preview-live-reset`
// empties the live session that only `ready` refills, so every later history
// frame projects into nothing while the cache has already been dropped.
test("a restore outrunning main's coalescing window keeps its history", () => {
  const history = [messageFrame(0), messageFrame(1), messageFrame(2)]
  const batches = deliveredBatches([ready(), ...history], 1)
  expect(batches.length).toBeGreaterThan(1) // the premise: more than one batch

  const h = handover(cache(history))
  h.previewing.add(SID)
  for (const frames of batches) h.deliver(frames)

  expect(h.cached()).toBeNull()
  expect(h.rows()).toHaveLength(3)
})

// The FIRST handover can itself land on a replay-only batch, when `ready` was
// delivered before preview membership was visible. The claim does nothing here
// — nothing has been claimed yet — so the session must survive being emptied.
test('a handover with no ready frame beside it does not strand the session', () => {
  const h = handover(cache([messageFrame(0)]))
  h.deliver([ready()]) // not previewing yet: no handover
  expect(h.rows()).toHaveLength(0)

  h.previewing.add(SID)
  h.deliver([messageFrame(0), messageFrame(1)])
  expect(h.rows()).toHaveLength(2)

  // And the session stays projectable afterwards — the live turn that followed
  // the reported failure also never appeared.
  h.deliver([messageFrame(2)])
  expect(h.rows()).toHaveLength(3)
})

// What the reset is FOR: a session that already ran this launch, died, and is
// now previewed carries its old rows in the projector. The handover must drop
// them, or the resumed history renders under a stale copy of itself. No-op the
// reset and this test reports 3.
test('the handover drops rows a previous connection left behind', () => {
  const h = handover(cache([messageFrame(0)]))
  h.deliver([ready(), messageFrame(9)]) // an earlier connection, not previewing
  expect(h.rows()).toHaveLength(1)

  h.previewing.add(SID)
  h.deliver([ready(), messageFrame(0), messageFrame(1)])
  expect(h.rows()).toHaveLength(2)
})

// The mirror image, and the reason the reset is scoped to `ready`: a handover
// firing on a LATER batch of one replay must keep what earlier batches of that
// same replay already projected. Resetting unconditionally reports 3 of 5.
test('a late handover keeps the history its earlier batches projected', () => {
  const h = handover(cache([messageFrame(0)]))
  h.deliver([ready(), messageFrame(0), messageFrame(1)]) // not previewing yet

  h.previewing.add(SID)
  h.deliver([messageFrame(2)])
  h.deliver([messageFrame(3)])
  h.deliver([messageFrame(4)])

  expect(h.cached()).toBeNull()
  expect(h.rows()).toHaveLength(5)
})

// A zero-history head batch hands over to an empty pane by design, so the
// conversation blinks. It must not stay gone once the replay lands.
test('history arriving after a ready-only batch still fills the pane', () => {
  const h = handover(cache([messageFrame(0)]))
  h.previewing.add(SID)

  h.deliver([ready()])
  expect(h.cached()).toBeNull()
  expect(h.rows()).toHaveLength(0) // the blink

  h.deliver([messageFrame(0), messageFrame(1)])
  expect(h.rows()).toHaveLength(2)
})

// A session can be previewed, restored, die, and be previewed again from a
// fresh cache. The claim is scoped to the preview generation, not the session,
// or the second pane stays pinned to stale cached rows over a live engine.
test('a second preview generation hands over again', () => {
  const h = handover(cache([messageFrame(0)]))
  h.previewing.add(SID)
  h.deliver([ready(), messageFrame(0)])
  expect(h.cached()).toBeNull()

  h.loadPreview(cache([messageFrame(0), messageFrame(1)]))
  expect(h.cached()).not.toBeNull()
  h.deliver([ready(), messageFrame(0), messageFrame(1)])

  expect(h.cached()).toBeNull()
  expect(h.rows()).toHaveLength(2)
})

test('claimPreviewSwaps hands over once per session', () => {
  const claimed = new Set<string>()
  expect(claimPreviewSwaps(claimed, [SID, 'other-session'])).toEqual([
    SID,
    'other-session',
  ])
  expect(claimPreviewSwaps(claimed, [SID, 'other-session'])).toEqual([])
  // A session that never swapped is unaffected by its neighbours' claims.
  expect(claimPreviewSwaps(claimed, ['third-session'])).toEqual(['third-session'])
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

/** A cached assistant frame. `usage` is optional because only some of these
 * fixtures care about context size, but it is where a REPLAYED session's context
 * legitimately comes from: the cache was written after the engine's late usage
 * write-back, so these numbers are final (the live wire's are not, S1 §4). The
 * `result` frame's own usage is the session-lifetime accumulator and is never a
 * context reading. */
function assistantFrame(
  model: string,
  index: number,
  usage?: Record<string, number>,
): ServerFrame {
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
          ...(usage ? { usage } : {}),
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
      assistantFrame('claude-sonnet-5', 0, { input_tokens: 8_000 }),
      assistantFrame('gpt-5.6-terra', 1, {
        input_tokens: 2_000,
        cache_read_input_tokens: 39_000,
        output_tokens: 1_000,
      }),
      resultFrame(999_999),
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

  expect(real.contextUsage?.windowIsFallback).toBeUndefined()
  expect(
    real.contextUsage === null ? null : selectContextPercent(real.contextUsage),
  ).toBe(50)

  // A source that stated no window still falls back for the RING, so an older
  // cache written before the worker resolved one keeps drawing exactly as it
  // did. What it must not do is print 93%: that ratio is against a constant
  // this session may never have run under, so the number is withheld here the
  // same way the live path withholds it.
  const unstated = projectPreviewTranscriptCache(withWindow(null)).runFacts
  expect(unstated.contextUsage?.contextWindow).toBe(200_000)
  expect(unstated.contextUsage?.percentUsed).toBe(93)
  expect(unstated.contextUsage?.windowIsFallback).toBe(true)
  expect(
    unstated.contextUsage === null
      ? null
      : selectContextPercent(unstated.contextUsage),
  ).toBeNull()
})

/**
 * A cache written on session CLOSE has no header facts, and its frames still
 * hold a live `result`. The frame scan is that path's answer, not dead code.
 */
test('with no header, the frame scan still answers what the frames can', () => {
  const entry = projectPreviewTranscriptCache(
    cache([
      assistantFrame('claude-sonnet-5', 0, {
        input_tokens: 2_000,
        cache_read_input_tokens: 39_000,
        output_tokens: 1_000,
      }),
      resultFrame(999_999),
    ]),
  )
  expect(entry.runFacts.model).toBe('claude-sonnet-5')
  expect(entry.runFacts.contextUsage?.usedTokens).toBe(42_000)
})

/* ── the retention boundary, across every path into the same pane ── */

function truncationFrame(requestId: string): ServerFrame {
  return {
    kind: 'error',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SID,
    requestId,
    code: 'internal_error',
    message: 'Only the 3 most recent messages are shown.',
    retryable: false,
  }
}

/**
 * The defect this pins (2026-08-19 review, finding 4): the incomplete-history
 * warning was returned only while a pane was a read-only preview, so clicking
 * into the session withdrew it at the exact moment it became actionable. The
 * boundary is now a row of the transcript, restated by the live replay, so the
 * handover cannot take it away.
 */
test('the boundary row survives the preview to live handover', () => {
  const boundary = truncationFrame(REPLAY_BUFFER_TRUNCATION_REQUEST_ID)
  const h = handover(cache([boundary, messageFrame(0)]))

  expect(
    selectNestedTranscriptRows(h.cached()!, SID).map(row => row.kind),
  ).toEqual(['history-boundary', 'assistant-text'])

  h.previewing.add(SID)
  h.deliver([
    ready(),
    truncationFrame(HISTORY_REPLAY_TRUNCATION_REQUEST_ID),
    messageFrame(0),
    messageFrame(1),
  ])

  expect(h.cached()).toBeNull()
  expect(h.rowKinds()).toEqual([
    'history-boundary',
    'assistant-text',
    'assistant-text',
  ])
})

/**
 * The other half of the same rule: absence of the row is the signal that a
 * transcript is whole. A resume that recovers the full history from disk must
 * NOT inherit the boundary the cached preview showed.
 */
test('a complete live replay drops a boundary the cached preview showed', () => {
  const h = handover(
    cache([truncationFrame(REPLAY_BUFFER_TRUNCATION_REQUEST_ID), messageFrame(0)]),
  )
  expect(
    selectNestedTranscriptRows(h.cached()!, SID).map(row => row.kind),
  ).toEqual(['history-boundary', 'assistant-text'])

  h.previewing.add(SID)
  h.deliver([ready(), messageFrame(0), messageFrame(1)])

  expect(h.rowKinds()).toEqual(['assistant-text', 'assistant-text'])
})
