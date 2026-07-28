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
  isReplayTruncationFrame,
  STICKY_FRAME_KINDS,
} from './replayBuffer.js'
import { PROTOCOL_VERSION, type ServerFrame, type SessionId } from '../shared/protocol.js'

const SID: SessionId = 'sess-1'

/**
 * The once-per-attach burst, in the exact order `SidecarServer.addConnection`
 * sends it (`app/sidecar/sidecarServer.ts:510-566`). Written out here rather
 * than derived from the buffer's own table so a reordering or a demotion to the
 * evictable ring is a test failure, not a silently agreeing constant.
 */
const ATTACH_BURST_KINDS = [
  'permission.context',
  'settings.snapshot',
  'agent-config.snapshot',
  'thread-goal.snapshot',
  'memory.snapshot',
  'tasks.snapshot',
  'agent-mode.snapshot',
  'run-controls.snapshot',
  'accounts.snapshot',
  'workspace-trust.snapshot',
  'diagnostics.snapshot',
  'extensions.snapshot',
  'remoteSettings.snapshot',
  'slash-catalog.snapshot',
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
      protocolVersion: PROTOCOL_VERSION,
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
 * The sidecar sends each of ATTACH_BURST_KINDS exactly once per connect, right
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
// result is delivered rather than dropped, while this ring's budget is 8 MiB —
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
  expect(DEFAULT_MAX_BUFFERED_BYTES).toBe(8 * 1024 * 1024)
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
