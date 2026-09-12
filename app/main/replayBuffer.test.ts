/**
 * F2 — main-side renderer attachment lifecycle.
 *
 * The review reproduced, in a real Electron renderer, that a one-shot `ready`
 * frame and the probe were produced BEFORE the renderer subscribed (and again
 * lost across a reload), leaving it stuck at `connecting…` with zero frames.
 * `FrameReplayBuffer` is the fix: main records frames as they arrive and replays
 * them when the renderer announces readiness. These tests exercise that
 * catch-up contract without an Electron process.
 */

import { expect, test } from 'bun:test'

import {
  DEFAULT_MAX_BUFFERED_BYTES,
  DEFAULT_MAX_BUFFERED_FRAMES,
  FrameReplayBuffer,
  isPreviewReplayTruncationFrame,
  isReplayTruncationFrame,
  STICKY_FRAME_KINDS,
} from './replayBuffer.js'
import { PROTOCOL_VERSION, type ServerFrame, type SessionId } from '../shared/protocol.js'
import type { SDKMessage } from '../shared/engine-types.snapshot.js'

const SID: SessionId = 'sess-1'

/**
 * The once-per-attach burst, in the order `SidecarServer.addConnection` sends it
 * (`app/sidecar/sidecarServer.ts`). Written out here rather than derived from
 * the buffer's own table so a reordering or a demotion to the evictable ring is
 * a test failure, not a silently agreeing constant.
 *
 * This is CALL order, not arrival order: the two `void`-invoked async sends
 * (`stats.usage`) awaits before its first send, so that frame
 * land after the synchronous burst. The buffer keys on arrival, and this suite
 * supplies arrival itself, so call order is what the list can honestly mirror.
 *
 * `queued-prompts.snapshot` is the one entry that is NOT sent every time:
 * `addConnection` skips it when nothing is waiting for a running response, which
 * is the ordinary case. It belongs in the list all the same, because what the
 * list is for is retention (every kind here must survive ring eviction), and
 * this suite supplies its own arrivals rather than observing a real attach.
 */
const ATTACH_BURST_KINDS = [
  'permission.context',
  'settings.snapshot',
  'agent-config.snapshot',
  'thread-goal.snapshot',
  'memory.snapshot',
  'tasks.snapshot',
  'workers.snapshot',
  'lease.snapshot',
  'run-controls.snapshot',
  'context-breakdown.snapshot',
  'accounts.snapshot',
  'stats.usage.snapshot',
  'workspace-trust.snapshot',
  'diagnostics.snapshot',
  'extensions.snapshot',
  'remoteSettings.snapshot',
  'slash-catalog.snapshot',
  'queued-prompts.snapshot',
  // LAST in the burst, before history replay (HOST-REQUEST-PLANE §4 step 4a).
  // Its value is derived at ready from the same state the ready payload was
  // built from; it sits here rather than at the head because C3 pins
  // `permission.context` immediately after `ready`.
  'activity',
] as const satisfies readonly ServerFrame['kind'][]

/**
 * Retention keys on `kind` alone, so a snapshot's payload is irrelevant here.
 * One cast beats reconstructing fourteen unrelated engine snapshot shapes;
 * `marker` stands in for "which generation of this snapshot is this".
 */
function attachSnapshotFrame(
  kind: (typeof ATTACH_BURST_KINDS)[number],
  marker = 'v1',
  sessionId: SessionId = SID,
): ServerFrame {
  return {
    kind,
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    marker,
  } as unknown as ServerFrame
}

function markerOf(frame: ServerFrame | undefined): unknown {
  return (frame as unknown as { marker?: unknown } | undefined)?.marker
}

function readyFrame(sessionId: SessionId = SID): ServerFrame {
  return {
    kind: 'ready',
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    engineSessionId: `engine-${sessionId}`,
    payload: {
      type: 'app.ready',
      protocolVersion: 1,
      inputEnabled: true,
      activeTurn: false,
      abort: { status: 'idle' },
      goalSnapshot: null,
      pendingPermissionRequests: [],
    },
  }
}

function pongFrame(nonce: string, sessionId: SessionId = SID): ServerFrame {
  return { kind: 'pong', protocolVersion: PROTOCOL_VERSION, sessionId, nonce }
}

function transcriptResetFrame(sessionId: SessionId = SID): ServerFrame {
  return {
    kind: 'transcript.reset',
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
  }
}

function generatedImagePreviewFrame(
  toolUseId: string,
  data: string,
  sessionId: SessionId = SID,
): ServerFrame {
  return {
    kind: 'generated-image-preview',
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    toolUseId,
    mediaType: 'image/png',
    data,
  }
}

function slashCatalogFrame(sessionId: SessionId = SID): ServerFrame {
  return {
    kind: 'slash-catalog.snapshot',
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    commands: [{ name: 'help', description: 'Show help' }],
  }
}

test('a frame produced before attach is delivered on the first snapshot (the F2 failure)', () => {
  const buffer = new FrameReplayBuffer()
  // Sidecar attached and produced its one-shot ready + probe BEFORE any renderer.
  buffer.record(SID, readyFrame())
  buffer.record(SID, pongFrame('probe'))

  // Renderer mounts late and asks to catch up.
  const replayed = buffer.snapshot()
  expect(replayed).toHaveLength(2)
  expect(replayed[0]?.kind).toBe('ready')
  expect(replayed[1]).toMatchObject({ kind: 'pong', nonce: 'probe' })
})

test('the ready frame is a permanent head, so a reload re-receives session state', () => {
  const buffer = new FrameReplayBuffer()
  buffer.record(SID, readyFrame())
  buffer.record(SID, pongFrame('a'))

  // First attach catches up.
  expect(buffer.snapshot().map(f => f.kind)).toEqual(['ready', 'pong'])

  // A reload re-requests the snapshot; the one-shot ready is STILL there.
  const afterReload = buffer.snapshot()
  expect(afterReload[0]?.kind).toBe('ready')
  expect(afterReload).toHaveLength(2)
})

test('a later ready frame replaces the head rather than duplicating it', () => {
  const buffer = new FrameReplayBuffer()
  buffer.record(SID, readyFrame())
  buffer.record(SID, readyFrame()) // e.g. a fresh sidecar re-announced
  const snapshot = buffer.snapshot()
  expect(snapshot.filter(f => f.kind === 'ready')).toHaveLength(1)
})

test('transcript reset is a ring barrier that keeps ready and sticky state', () => {
  const buffer = new FrameReplayBuffer(2)
  buffer.record(SID, readyFrame())
  buffer.record(SID, attachSnapshotFrame('settings.snapshot'))
  buffer.record(SID, pongFrame('discarded-a'))
  buffer.record(SID, pongFrame('discarded-b'))
  buffer.record(SID, pongFrame('discarded-c'))
  buffer.record(SID, generatedImagePreviewFrame('discarded-preview', 'data'))

  const reset = transcriptResetFrame()
  buffer.record(SID, reset)
  buffer.record(SID, pongFrame('retained'))

  const snapshot = buffer.snapshot()
  expect(snapshot.map(frame => frame.kind)).toEqual([
    'ready',
    'settings.snapshot',
    'transcript.reset',
    'pong',
  ])
  expect(snapshot).toContainEqual(reset)
  expect(snapshot).toContainEqual(pongFrame('retained'))
  expect(snapshot.some(isReplayTruncationFrame)).toBe(false)
  expect(snapshot.some(isPreviewReplayTruncationFrame)).toBe(false)
})

test('a generated-image preview larger than the transcript ring stays replayable without evicting transcript frames', () => {
  const buffer = new FrameReplayBuffer(10, 256, 2_048)
  buffer.record(SID, readyFrame())
  buffer.record(SID, pongFrame('before-preview'))
  const preview = generatedImagePreviewFrame(
    'toolu_generate_image_1',
    'A'.repeat(600),
  )
  buffer.record(SID, preview)
  buffer.record(SID, pongFrame('after-preview'))

  const snapshot = buffer.snapshot()
  expect(snapshot).toContainEqual(preview)
  expect(snapshot).toContainEqual(pongFrame('before-preview'))
  expect(snapshot).toContainEqual(pongFrame('after-preview'))
  expect(snapshot.some(isReplayTruncationFrame)).toBe(false)
})

test('generated-image preview retention evicts only its oldest preview when its own budget fills', () => {
  const buffer = new FrameReplayBuffer(10, 512, 1_000)
  buffer.record(SID, readyFrame())
  buffer.record(SID, pongFrame('transcript'))
  buffer.record(
    SID,
    generatedImagePreviewFrame('toolu_old', 'A'.repeat(600)),
  )
  const newest = generatedImagePreviewFrame('toolu_new', 'B'.repeat(600))
  buffer.record(SID, newest)

  const snapshot = buffer.snapshot()
  expect(snapshot).toContainEqual(pongFrame('transcript'))
  expect(snapshot).toContainEqual(newest)
  expect(
    snapshot.some(
      frame =>
        frame.kind === 'generated-image-preview' &&
        frame.toolUseId === 'toolu_old',
    ),
  ).toBe(false)
  expect(snapshot.some(isReplayTruncationFrame)).toBe(false)
  expect(snapshot.some(isPreviewReplayTruncationFrame)).toBe(true)
})

test('generated-image preview retention also bounds entry count', () => {
  const buffer = new FrameReplayBuffer(10, 512, 4_096, 1)
  buffer.record(SID, readyFrame())
  buffer.record(SID, generatedImagePreviewFrame('toolu_old', 'A'))
  const newest = generatedImagePreviewFrame('toolu_new', 'B')
  buffer.record(SID, newest)

  const snapshot = buffer.snapshot()
  expect(snapshot).toContainEqual(newest)
  expect(
    snapshot.some(
      frame =>
        frame.kind === 'generated-image-preview' &&
        frame.toolUseId === 'toolu_old',
    ),
  ).toBe(false)
  expect(snapshot.some(isPreviewReplayTruncationFrame)).toBe(true)
})

// SLASH-6 — the rich slash-catalog snapshot is sent once per connect and is
// the composer picker's only source; it must survive a renderer reload even
// after the ring buffer below has evicted it (main/App.tsx never re-runs
// connect() on reload/reattach, so nothing else would re-send it).

test('the slash-catalog snapshot is a sticky head, like ready, and survives the ring buffer evicting everything else', () => {
  const cap = 2
  const buffer = new FrameReplayBuffer(cap)
  buffer.record(SID, readyFrame())
  buffer.record(SID, slashCatalogFrame())
  for (let i = 0; i < cap + 3; i++) buffer.record(SID, pongFrame(`n${i}`))

  const snapshot = buffer.snapshot()
  expect(snapshot[0]?.kind).toBe('ready')
  expect(snapshot[1]?.kind).toBe('slash-catalog.snapshot')
  expect(isReplayTruncationFrame(snapshot[2])).toBe(true)
  // The catalog frame itself was never counted against the ring buffer's cap.
  const nonces = snapshot.slice(3).map(f => (f.kind === 'pong' ? f.nonce : null))
  expect(nonces).toHaveLength(cap)
})

test('a reload re-request still receives the slash-catalog snapshot after eviction (SLASH-6 failure scenario)', () => {
  const cap = 1
  const buffer = new FrameReplayBuffer(cap)
  buffer.record(SID, readyFrame())
  buffer.record(SID, slashCatalogFrame())
  // A busy session pushes well past the ring-buffer cap.
  for (let i = 0; i < cap + 10; i++) buffer.record(SID, pongFrame(`n${i}`))

  // Renderer reload: main re-arms replay and returns the current buffer
  // snapshot without re-running connect() (AttachmentGate.onRendererReady).
  const afterReload = buffer.snapshot()
  expect(afterReload.some(f => f.kind === 'slash-catalog.snapshot')).toBe(true)
})

test('a later slash-catalog snapshot replaces the sticky slot rather than duplicating it', () => {
  const buffer = new FrameReplayBuffer()
  buffer.record(SID, slashCatalogFrame())
  buffer.record(SID, slashCatalogFrame())
  const snapshot = buffer.snapshot()
  expect(snapshot.filter(f => f.kind === 'slash-catalog.snapshot')).toHaveLength(1)
})

test('no slash-catalog frame recorded means none is replayed (never a fabricated snapshot)', () => {
  const buffer = new FrameReplayBuffer()
  buffer.record(SID, readyFrame())
  const snapshot = buffer.snapshot()
  expect(snapshot.some(f => f.kind === 'slash-catalog.snapshot')).toBe(false)
})

/*
 * Once-per-attach state frames (the operator-reported reattach failure).
 *
 * The sidecar sends each of ATTACH_BURST_KINDS at most once per connect, right
 * after `ready` and before history replay. Main never re-runs connect() on a
 * renderer reload, so whatever this buffer dropped is gone: the operator saw a
 * reattach replay plenty of transcript but leave settings claiming it had read
 * no files, the composer's model/effort chip empty, and permission mode blank —
 * because those frames, being the OLDEST in the ring, were the first evicted
 * once a working session cycled it.
 */

test('every once-per-attach snapshot survives a fully cycled ring, in send order (the blank-state reattach failure)', () => {
  const cap = 4
  const buffer = new FrameReplayBuffer(cap)
  buffer.record(SID, readyFrame())
  for (const kind of ATTACH_BURST_KINDS) {
    buffer.record(SID, attachSnapshotFrame(kind))
  }
  // An ordinary working session: includePartialMessages makes every streamed
  // chunk its own frame, so the ring cycles many times over.
  for (let i = 0; i < cap * 10; i++) buffer.record(SID, pongFrame(`n${i}`))

  const snapshot = buffer.snapshot()
  const burstEnd = 1 + ATTACH_BURST_KINDS.length
  expect(snapshot[0]?.kind).toBe('ready')
  // After `ready`, before the truncation marker and the retained ring, in the
  // order the sidecar sent them.
  expect(snapshot.slice(1, burstEnd).map(f => f.kind)).toEqual([
    ...ATTACH_BURST_KINDS,
  ])
  expect(isReplayTruncationFrame(snapshot[burstEnd])).toBe(true)
  // The sticky slots were never charged against the ring's count budget.
  expect(
    snapshot.slice(burstEnd + 1).map(f => (f.kind === 'pong' ? f.nonce : null)),
  ).toEqual(['n36', 'n37', 'n38', 'n39'])
})

test('a reload replays the identical once-per-attach state (nothing is consumed by the first attach)', () => {
  const cap = 2
  const buffer = new FrameReplayBuffer(cap)
  buffer.record(SID, readyFrame())
  for (const kind of ATTACH_BURST_KINDS) {
    buffer.record(SID, attachSnapshotFrame(kind))
  }
  for (let i = 0; i < cap + 10; i++) buffer.record(SID, pongFrame(`n${i}`))

  const first = buffer.snapshot()
  const afterReload = buffer.snapshot()
  expect(JSON.stringify(afterReload)).toBe(JSON.stringify(first))
})

test('a later snapshot replaces its own slot and keeps its original send position', () => {
  const buffer = new FrameReplayBuffer()
  buffer.record(SID, readyFrame())
  for (const kind of ATTACH_BURST_KINDS) {
    buffer.record(SID, attachSnapshotFrame(kind, 'v1'))
  }
  // A live re-broadcast mid-session (settings write, run-control change, …).
  buffer.record(SID, pongFrame('live'))
  buffer.record(SID, attachSnapshotFrame('settings.snapshot', 'v2'))

  const snapshot = buffer.snapshot()
  // Replace, never append: still exactly one slot per kind, still in send order.
  expect(snapshot.filter(f => f.kind === 'settings.snapshot')).toHaveLength(1)
  expect(snapshot.slice(1, 1 + ATTACH_BURST_KINDS.length).map(f => f.kind)).toEqual([
    ...ATTACH_BURST_KINDS,
  ])
  // The newest generation is what replays.
  expect(markerOf(snapshot.find(f => f.kind === 'settings.snapshot'))).toBe('v2')
})

test('a sticky snapshot is not charged against the ring byte budget either', () => {
  const pong = pongFrame('only')
  const budget = Buffer.byteLength(JSON.stringify(pong), 'utf8')
  const buffer = new FrameReplayBuffer(10, budget)
  buffer.record(SID, attachSnapshotFrame('accounts.snapshot'))
  buffer.record(SID, pong)

  const snapshot = buffer.snapshot()
  expect(snapshot.some(isReplayTruncationFrame)).toBe(false)
  expect(snapshot.map(f => f.kind)).toEqual(['accounts.snapshot', 'pong'])
})

test('the sticky table and the attach burst describe the same set of kinds', () => {
  // Drift alarm: a new once-per-attach frame kind must be classified sticky AND
  // placed at its real position in the burst above, or the ordering assertions
  // are testing a stale list.
  expect(new Set(STICKY_FRAME_KINDS)).toEqual(new Set(ATTACH_BURST_KINDS))
})

test('non-ready frames ring-buffer at the cap; ready is never evicted', () => {
  const cap = 4
  const buffer = new FrameReplayBuffer(cap)
  buffer.record(SID, readyFrame())
  for (let i = 0; i < cap + 3; i++) {
    buffer.record(SID, pongFrame(`n${i}`))
  }
  const snapshot = buffer.snapshot()
  // ready head + truncation marker + exactly `cap` recent frames.
  expect(snapshot).toHaveLength(cap + 2)
  expect(snapshot[0]?.kind).toBe('ready')
  expect(isReplayTruncationFrame(snapshot[1])).toBe(true)
  // Oldest non-ready frames were evicted; the newest survive in order.
  const nonces = snapshot.slice(2).map(f => (f.kind === 'pong' ? f.nonce : null))
  expect(nonces).toEqual(['n3', 'n4', 'n5', 'n6'])
})

test('retention uses serialized UTF-8 bytes and marks the lossy replay boundary', () => {
  const first = pongFrame('first')
  const second = pongFrame('second')
  const secondBytes = Buffer.byteLength(JSON.stringify(second), 'utf8')
  const buffer = new FrameReplayBuffer(10, secondBytes)
  buffer.record(SID, readyFrame())
  buffer.record(SID, first)
  buffer.record(SID, second)

  const snapshot = buffer.snapshot()
  expect(snapshot[0]?.kind).toBe('ready')
  expect(isReplayTruncationFrame(snapshot[1])).toBe(true)
  expect(snapshot[2]).toEqual(second)
})

test('a single frame larger than the byte budget is not retained and still marks truncation', () => {
  const buffer = new FrameReplayBuffer(10, 64)
  buffer.record(SID, readyFrame())
  buffer.record(SID, pongFrame('界'.repeat(100)))

  const snapshot = buffer.snapshot()
  expect(snapshot).toHaveLength(2)
  expect(snapshot[0]?.kind).toBe('ready')
  expect(isReplayTruncationFrame(snapshot[1])).toBe(true)
})

// `MAX_OUTBOUND_FRAME_BYTES` is 32 MiB precisely so a base64 image or a big tool
// result is delivered rather than dropped, while this ring's budget is 16 MiB —
// so a single frame over the ring budget is reachable in an ordinary session.
// It must cost that one frame, not the whole conversation: clearing the ring
// here made a renderer reload replay `ready` plus a lone truncation banner, and
// `persistTranscriptCache` then distilled the emptied buffer into a stub cache.
test('an oversized frame drops only itself and keeps the frames recorded before it', () => {
  const buffer = new FrameReplayBuffer(10, 512)
  buffer.record(SID, readyFrame())
  buffer.record(SID, pongFrame('early-1'))
  buffer.record(SID, pongFrame('early-2'))
  buffer.record(SID, pongFrame('界'.repeat(400)))
  buffer.record(SID, pongFrame('late-1'))

  const snapshot = buffer.snapshot()
  expect(snapshot[0]?.kind).toBe('ready')
  expect(isReplayTruncationFrame(snapshot[1])).toBe(true)
  expect(
    snapshot.slice(2).map(frame => (frame.kind === 'pong' ? frame.nonce : null)),
  ).toEqual(['early-1', 'early-2', 'late-1'])
})

test('buffers each session independently and replays them all', () => {
  const buffer = new FrameReplayBuffer()
  buffer.record('s-a', readyFrame('s-a'))
  buffer.record('s-b', readyFrame('s-b'))
  buffer.record('s-b', pongFrame('b1', 's-b'))

  const snapshot = buffer.snapshot()
  const sessions = new Set(snapshot.map(f => f.sessionId))
  expect(sessions).toEqual(new Set(['s-a', 's-b']))
})

test('clear() drops all buffers (macOS reopen must not replay a dead session)', () => {
  const buffer = new FrameReplayBuffer()
  buffer.record(SID, readyFrame())
  buffer.record(SID, pongFrame('x'))
  buffer.clear()
  expect(buffer.snapshot()).toHaveLength(0)
})

test('clearSession() drops only the restarted session replay state', () => {
  const buffer = new FrameReplayBuffer()
  buffer.record('restart-me', readyFrame('restart-me'))
  buffer.record('restart-me', pongFrame('old', 'restart-me'))
  buffer.record('keep-me', readyFrame('keep-me'))

  buffer.clearSession('restart-me')

  expect(buffer.snapshot().map(frame => frame.sessionId)).toEqual(['keep-me'])
})

test('default cap is the documented value', () => {
  expect(DEFAULT_MAX_BUFFERED_FRAMES).toBe(8_000)
  expect(DEFAULT_MAX_BUFFERED_BYTES).toBe(16 * 1024 * 1024)
})

/**
 * The sizing rule, not just the constant: the frame count must sit far enough
 * above real session volume that the BYTE budget is what binds. Measured
 * 2026-07-27, the largest session in this repo's transcript store was 1,413
 * finished messages, and each becomes several frames once streamed partials
 * are counted. A count that trips before the byte ceiling truncates early
 * while saving no memory, which is the defect this replaced.
 */
test('the frame cap clears real session volume by a wide margin', () => {
  const LARGEST_MEASURED_SESSION_MESSAGES = 1_413
  expect(DEFAULT_MAX_BUFFERED_FRAMES).toBeGreaterThan(
    LARGEST_MEASURED_SESSION_MESSAGES * 4,
  )
})

test('snapshotSession returns exactly one session in delivery order (ready head + recent)', () => {
  const buffer = new FrameReplayBuffer()
  buffer.record('s-a', readyFrame('s-a'))
  buffer.record('s-a', pongFrame('a1', 's-a'))
  buffer.record('s-b', readyFrame('s-b'))
  buffer.record('s-b', pongFrame('b1', 's-b'))

  const only = buffer.snapshotSession('s-a')
  // The permanent ready head is INCLUDED here (distill drops it, not this).
  expect(only.map(f => f.kind)).toEqual(['ready', 'pong'])
  expect(new Set(only.map(f => f.sessionId))).toEqual(new Set(['s-a']))
})

test('snapshotSession is empty for a never-buffered session', () => {
  const buffer = new FrameReplayBuffer()
  expect(buffer.snapshotSession('nope')).toEqual([])
})

test('snapshotSession includes the truncation marker when the session was lossy', () => {
  const cap = 2
  const buffer = new FrameReplayBuffer(cap)
  buffer.record(SID, readyFrame())
  for (let i = 0; i < cap + 2; i++) buffer.record(SID, pongFrame(`n${i}`))

  const only = buffer.snapshotSession(SID)
  expect(only[0]?.kind).toBe('ready')
  expect(isReplayTruncationFrame(only[1])).toBe(true)
  expect(only.slice(2).map(f => (f.kind === 'pong' ? f.nonce : null))).toEqual([
    'n2',
    'n3',
  ])
})

/* ── the retained count in the truncation notice ── */

function assistantEventFrame(index: number, sessionId: SessionId = SID): ServerFrame {
  return {
    kind: 'event',
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    event: {
      type: 'message',
      message: {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: `m${index}` }] },
        uuid: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      } as unknown as SDKMessage,
    },
  }
}

function streamDeltaFrame(index: number, sessionId: SessionId = SID): ServerFrame {
  return {
    kind: 'event',
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    event: {
      type: 'message',
      message: {
        type: 'stream_event',
        uuid: `00000000-0000-4000-8000-1000000000${index}`,
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'x' },
        },
      } as unknown as SDKMessage,
    },
  }
}

/**
 * The defect this pins (2026-08-19 review, finding 3): the notice reported
 * `recent.length`, a FRAME tally including pongs, lifecycle and streamed
 * partials, under the word "messages". On a streaming session that overstated
 * the retained message count several times over.
 */
test('the truncation notice counts retained MESSAGES, not retained frames', () => {
  const cap = 6
  const buffer = new FrameReplayBuffer(cap)
  buffer.record(SID, readyFrame())
  // Enough traffic to evict, then a tail of exactly `cap` frames of which only
  // two are finished messages: one pong, one partial, and two assistants.
  for (let i = 0; i < 8; i++) buffer.record(SID, pongFrame(`old${i}`))
  buffer.record(SID, pongFrame('recent'))
  buffer.record(SID, streamDeltaFrame(1))
  buffer.record(SID, assistantEventFrame(1))
  buffer.record(SID, streamDeltaFrame(2))
  buffer.record(SID, assistantEventFrame(2))
  buffer.record(SID, pongFrame('newest'))

  const snapshot = buffer.snapshot()
  const notice = snapshot.find(isReplayTruncationFrame)
  expect(notice?.kind).toBe('error')
  // The ring holds `cap` frames here, which is what the old count printed.
  expect(snapshot.filter(frame => frame.kind === 'pong')).toHaveLength(2)
  expect(notice && notice.kind === 'error' ? notice.message : '').toBe(
    'Only the 2 most recent messages are shown.',
  )
})

/* ── B2: recovered history is never retained (HISTORY-LOAD-EARLIER.md) ── */

/**
 * A frame from one `history.loadEarlier`. Same `kind` and same `replay` as a
 * restore replay — the ONLY difference is `recovered`, which is why the
 * discrimination cannot live in the kind-keyed retention table.
 */
function recoveredEventFrame(
  index: number,
  sessionId: SessionId = SID,
): ServerFrame {
  const base = assistantEventFrame(index, sessionId)
  if (base.kind !== 'event') throw new Error('not an event frame')
  return { ...base, replay: true, recovered: true }
}

function restoreReplayEventFrame(
  index: number,
  sessionId: SessionId = SID,
): ServerFrame {
  const base = assistantEventFrame(index, sessionId)
  if (base.kind !== 'event') throw new Error('not an event frame')
  return { ...base, replay: true }
}

/**
 * The defect this pins (B1/B2 review, 2026-08-20): the ring evicts
 * oldest-by-ARRIVAL, and recovered frames are the OLDEST messages arriving
 * LAST. Retained, a large recovery evicts live frames from the middle of the
 * session while keeping ancient ones, so a reload replays a transcript with a
 * hole in it.
 */
test('a recovered frame is not retained, and does not evict the live tail', () => {
  const buffer = new FrameReplayBuffer(4)
  buffer.record(SID, readyFrame())
  buffer.record(SID, assistantEventFrame(1))
  buffer.record(SID, assistantEventFrame(2))
  for (let index = 90; index < 96; index++) {
    buffer.record(SID, recoveredEventFrame(index))
  }

  const snapshot = buffer.snapshot()
  expect(snapshot.some(frame => frame.kind === 'event' && frame.recovered === true)).toBe(
    false,
  )
  // The live tail is intact AND uncut: nothing was evicted, so no truncation
  // notice was minted either.
  expect(snapshot.map(frame => frame.kind)).toEqual(['ready', 'event', 'event'])
  expect(snapshot.find(isReplayTruncationFrame)).toBeUndefined()
})

/** The other half: `replay` alone is still ordinary retained transcript. */
test('a restore-replay frame IS retained', () => {
  const buffer = new FrameReplayBuffer()
  buffer.record(SID, readyFrame())
  buffer.record(SID, restoreReplayEventFrame(1))

  const snapshot = buffer.snapshot()
  expect(snapshot.map(frame => frame.kind)).toEqual(['ready', 'event'])
  expect(snapshot[1]).toMatchObject({ replay: true })
})

/* ── stream compaction: a stopped stream's partials leave the ring ── */

/**
 * The wire a streaming turn actually produces, in engine order. One `assistant`
 * frame per `content_block_stop` (`src/services/api/claude.ts` yields it there),
 * and `message_stop` only after the last of them — which is what makes
 * `message_stop`, not the first `assistant`, the only safe compaction boundary.
 */
function streamPartialFrame(
  event: Record<string, unknown>,
  seq: number,
  parentToolUseId: string | null = null,
  sessionId: SessionId = SID,
): ServerFrame {
  return {
    kind: 'event',
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    event: {
      type: 'message',
      message: {
        type: 'stream_event',
        uuid: `00000000-0000-4000-8000-2${String(seq).padStart(11, '0')}`,
        parent_tool_use_id: parentToolUseId,
        event,
      } as unknown as SDKMessage,
    },
  }
}

function assistantBlockFrame(
  messageId: string,
  text: string,
  seq: number,
  sessionId: SessionId = SID,
): ServerFrame {
  return {
    kind: 'event',
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    event: {
      type: 'message',
      message: {
        type: 'assistant',
        message: { id: messageId, role: 'assistant', content: [{ type: 'text', text }] },
        parent_tool_use_id: null,
        uuid: `00000000-0000-4000-8000-3${String(seq).padStart(11, '0')}`,
      } as unknown as SDKMessage,
    },
  }
}

function resultFrame(
  seq: number,
  parentToolUseId: string | null = null,
  sessionId: SessionId = SID,
): ServerFrame {
  return {
    kind: 'event',
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    event: {
      type: 'message',
      message: {
        type: 'result',
        subtype: 'success',
        parent_tool_use_id: parentToolUseId,
        uuid: `00000000-0000-4000-8000-4${String(seq).padStart(11, '0')}`,
      } as unknown as SDKMessage,
    },
  }
}

function streamEventTypesOf(frames: readonly ServerFrame[]): string[] {
  const types: string[] = []
  for (const frame of frames) {
    if (frame.kind !== 'event') continue
    if (frame.event.type !== 'message') continue
    const message = frame.event.message
    if (message.type !== 'stream_event') continue
    const streamed: unknown = message.event
    types.push(
      typeof streamed === 'object' &&
        streamed !== null &&
        'type' in streamed &&
        typeof streamed.type === 'string'
        ? streamed.type
        : '?',
    )
  }
  return types
}

/**
 * The case the boundary rule exists for (2026-09-02 assessment §5 item 2): a
 * turn with TWO content blocks, reloaded between the two block completions.
 *
 * At the reload the stream has not stopped, so its `message_start` is still in
 * the ring — without it the projector has no stream id to hang block 1's deltas
 * on and the second block streams into nothing. Compacting at the first
 * `assistant` frame (which has already arrived by then) would do exactly that.
 * Once `message_stop` lands, every partial of the turn goes and both finished
 * `assistant` frames stay.
 */
test('a two-block turn keeps its partials across a mid-turn reload, then compacts at message_stop', () => {
  const buffer = new FrameReplayBuffer()
  buffer.record(SID, readyFrame())
  buffer.record(SID, streamPartialFrame({ type: 'message_start', message: { id: 'msg-two-block' } }, 1))
  buffer.record(SID, streamPartialFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 2))
  buffer.record(SID, streamPartialFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'first' } }, 3))
  buffer.record(SID, streamPartialFrame({ type: 'content_block_stop', index: 0 }, 4))
  buffer.record(SID, assistantBlockFrame('msg-two-block', 'first', 1))

  // The reload: block 0 is finished, block 1 has not started.
  const midTurn = buffer.snapshot()
  expect(streamEventTypesOf(midTurn)).toEqual([
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
  ])

  buffer.record(SID, streamPartialFrame({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }, 5))
  buffer.record(SID, streamPartialFrame({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'second' } }, 6))
  buffer.record(SID, streamPartialFrame({ type: 'content_block_stop', index: 1 }, 7))
  buffer.record(SID, assistantBlockFrame('msg-two-block', 'second', 2))
  buffer.record(SID, streamPartialFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, 8))
  buffer.record(SID, streamPartialFrame({ type: 'message_stop' }, 9))

  const stopped = buffer.snapshot()
  expect(streamEventTypesOf(stopped)).toEqual([])
  expect(stopped.map(frame => frame.kind)).toEqual(['ready', 'event', 'event'])
  // Compaction is not truncation: nothing a reader can see was lost, so no
  // boundary row is minted.
  expect(stopped.find(isReplayTruncationFrame)).toBeUndefined()
})

/** The turn's `result` is the fallback boundary for a stream nobody stopped. */
test('an interrupted stream keeps its partials until the turn result', () => {
  const buffer = new FrameReplayBuffer()
  buffer.record(SID, readyFrame())
  buffer.record(SID, streamPartialFrame({ type: 'message_start', message: { id: 'msg-interrupted' } }, 1))
  buffer.record(SID, streamPartialFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half' } }, 2))

  expect(streamEventTypesOf(buffer.snapshot())).toEqual([
    'message_start',
    'content_block_delta',
  ])

  buffer.record(SID, resultFrame(1))
  expect(streamEventTypesOf(buffer.snapshot())).toEqual([])
  // The result itself is a finished message and stays.
  expect(buffer.snapshot().map(frame => frame.kind)).toEqual(['ready', 'event'])
})

/**
 * Partials are keyed by `parent_tool_use_id` so a subagent's stop closes only
 * its own stream. Every partial measured on this wire carries `null`
 * (assessment §10.2), so this pins the guard rather than an observed case.
 */
test('a subagent stream_stop compacts only its own partials', () => {
  const buffer = new FrameReplayBuffer()
  buffer.record(SID, readyFrame())
  buffer.record(SID, streamPartialFrame({ type: 'message_start', message: { id: 'msg-main' } }, 1))
  buffer.record(SID, streamPartialFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'main' } }, 2))
  buffer.record(SID, streamPartialFrame({ type: 'message_start', message: { id: 'msg-sub' } }, 3, 'toolu_sub'))
  buffer.record(SID, streamPartialFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'sub' } }, 4, 'toolu_sub'))
  buffer.record(SID, streamPartialFrame({ type: 'message_stop' }, 5, 'toolu_sub'))

  expect(streamEventTypesOf(buffer.snapshot())).toEqual([
    'message_start',
    'content_block_delta',
  ])

  buffer.record(SID, streamPartialFrame({ type: 'message_stop' }, 6))
  expect(streamEventTypesOf(buffer.snapshot())).toEqual([])
})

/**
 * The point of the whole change: the ring's budget stops being spent on
 * partials, so finished messages that the deltas used to evict now survive.
 */
test('compaction frees ring budget that partials would otherwise have evicted', () => {
  // Sized so the live traffic of ONE turn (10 partials) plus the finished
  // messages behind it stays under the cap, which is the state compaction is
  // meant to leave the ring in. The same six turns uncompacted are 66 frames.
  const cap = 20
  const buffer = new FrameReplayBuffer(cap)
  buffer.record(SID, readyFrame())
  for (let turn = 0; turn < 6; turn++) {
    buffer.record(SID, streamPartialFrame({ type: 'message_start', message: { id: `msg-${turn}` } }, turn * 10 + 1))
    for (let delta = 0; delta < 8; delta++) {
      buffer.record(
        SID,
        streamPartialFrame(
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 't' } },
          turn * 10 + 2 + delta,
        ),
      )
    }
    buffer.record(SID, assistantBlockFrame(`msg-${turn}`, `turn ${turn}`, turn))
    buffer.record(SID, streamPartialFrame({ type: 'message_stop' }, turn * 10 + 9))
  }

  const snapshot = buffer.snapshot()
  expect(streamEventTypesOf(snapshot)).toEqual([])
  // All six finished messages survive a 20-frame cap that the 60 partials
  // would have overrun three times over.
  expect(snapshot.filter(frame => frame.kind === 'event')).toHaveLength(6)
  expect(snapshot.find(isReplayTruncationFrame)).toBeUndefined()
})

/** `transcript.reset` clears the ring, so it must clear open-stream tracking too. */
test('a transcript reset forgets open stream partials', () => {
  const buffer = new FrameReplayBuffer()
  buffer.record(SID, readyFrame())
  buffer.record(SID, streamPartialFrame({ type: 'message_start', message: { id: 'msg-reset' } }, 1))
  buffer.record(SID, streamPartialFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'gone' } }, 2))
  buffer.record(SID, transcriptResetFrame())
  buffer.record(SID, assistantBlockFrame('msg-after-reset', 'kept', 1))
  buffer.record(SID, streamPartialFrame({ type: 'message_stop' }, 3))

  const snapshot = buffer.snapshot()
  // The reset barrier itself rides the ring; what must be gone is the cleared
  // stream's partials, which a stop arriving after the reset must not resurrect.
  expect(snapshot.map(frame => frame.kind)).toEqual([
    'ready',
    'transcript.reset',
    'event',
  ])
  expect(streamEventTypesOf(snapshot)).toEqual([])
})

/* ── the load-earlier view anchor (decisions/HISTORY-LOAD-EARLIER.md) ── */

/**
 * The anchor main stamps onto an outbound `history.loadEarlier`. Its whole
 * value is that main, not the sidecar, knows where a reloaded pane starts: the
 * pane is rebuilt from this ring and nothing else, so this ring's oldest
 * retained message is the reader's first row.
 */
test('a whole ring publishes no view anchor', () => {
  const buffer = new FrameReplayBuffer()
  buffer.record(SID, readyFrame())
  buffer.record(SID, assistantEventFrame(1))
  buffer.record(SID, assistantEventFrame(2))

  // Nothing was lost, so the sidecar's own per-connection anchor already
  // describes what this reader holds and an anchor here would say nothing new.
  expect(buffer.viewAnchorUuid(SID)).toBeUndefined()
})

test('a lossy ring publishes its OLDEST retained message', () => {
  const buffer = new FrameReplayBuffer(3)
  buffer.record(SID, readyFrame())
  for (let index = 1; index <= 6; index++) {
    buffer.record(SID, assistantEventFrame(index))
  }

  // Frames 1-3 were evicted; a reloaded pane opens on frame 4.
  expect(buffer.viewAnchorUuid(SID)).toBe(
    '00000000-0000-4000-8000-000000000004',
  )
})

/**
 * A partial is a piece of a message, not one, and it never appears in the
 * display transcript the sidecar diffs against — so anchoring on one would be
 * an anchor the deeper read can never find, which the sidecar answers by
 * refusing. Same exclusion `retainedMessageCount` makes, for the same reason.
 */
test('the view anchor skips streamed partials and non-transcript frames', () => {
  const buffer = new FrameReplayBuffer(3)
  buffer.record(SID, readyFrame())
  for (let index = 1; index <= 4; index++) {
    buffer.record(SID, assistantEventFrame(index))
  }
  // Evicts down to a tail whose oldest frames are a pong and a partial.
  buffer.record(SID, pongFrame('p1'))
  buffer.record(SID, streamDeltaFrame(9))
  buffer.record(SID, assistantEventFrame(7))

  expect(buffer.viewAnchorUuid(SID)).toBe(
    '00000000-0000-4000-8000-000000000007',
  )
})

test('an unbuffered session has no view anchor', () => {
  const buffer = new FrameReplayBuffer()
  expect(buffer.viewAnchorUuid('never-seen')).toBeUndefined()
})
