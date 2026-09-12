/**
 * F2 — renderer attachment state machine, including the failure modes the first
 * remediation missed: React StrictMode double-signals the mount effect (so the
 * renderer calls `rendererReady` TWICE per load), and a live frame can arrive
 * between those two signals. The gate must replay exactly once per load and
 * never double-deliver.
 */

import { expect, test } from 'bun:test'

import { AttachmentGate } from './attachmentGate.js'
import {
  FrameReplayBuffer,
  isReplayTruncationFrame,
} from './replayBuffer.js'
import {
  HISTORY_REPLAY_TRUNCATION_REQUEST_ID,
  PROTOCOL_VERSION,
  type ServerFrame,
  type SessionId,
} from '../shared/protocol.js'

const SID: SessionId = 'sess-1'

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

function pong(nonce: string): ServerFrame {
  return { kind: 'pong', protocolVersion: PROTOCOL_VERSION, sessionId: SID, nonce }
}

function exited(): ServerFrame {
  return {
    kind: 'lifecycle',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SID,
    status: 'exited',
    exit: { code: null, signal: 'SIGTERM' },
  }
}

function replayFrame(index: number): ServerFrame {
  return {
    kind: 'event',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SID,
    replay: true,
    event: {
      type: 'message',
      message: {
        type: 'assistant',
        uuid: `replay-${index}`,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `history ${index}` }],
        },
      } as never,
    },
  }
}

function tracedReplayFrame(index: number): ServerFrame {
  return {
    ...replayFrame(index),
    deliveryTrace: {
      streamEpoch: '00000000-0000-4000-8000-000000000001',
      sequence: index + 1,
      traceId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      deliveryAttempt: 1,
      replay: false,
      sourceProcessInstanceId: '00000000-0000-4000-8000-000000000002',
      sourceWallTimestamp: '2026-08-24T00:00:00.000Z',
      sourceMonotonicTimestampMs: index + 1,
      connectionEpoch: 1,
    },
  }
}

function transcriptReset(): ServerFrame {
  return {
    kind: 'transcript.reset',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SID,
  }
}

function sessionActionResult(
  verb: Extract<ServerFrame, { kind: 'session-action.result' }>['verb'],
  ok = true,
): ServerFrame {
  return {
    kind: 'session-action.result',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SID,
    requestId: `${verb}-request`,
    verb,
    ok,
    message: `${verb} ${ok ? 'completed' : 'failed'}`,
  }
}

function connectionError(): ServerFrame {
  return {
    kind: 'error',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SID,
    requestId: 'connection-error',
    code: 'internal_error',
    message: 'Connection failed.',
    retryable: false,
  }
}

function historyTruncation(): ServerFrame {
  return {
    kind: 'error',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SID,
    requestId: HISTORY_REPLAY_TRUNCATION_REQUEST_ID,
    code: 'internal_error',
    message: 'Earlier restored-session history was omitted.',
    retryable: false,
  }
}

/** Collect everything the gate would deliver to the renderer, in order. */
function drive(steps: (gate: AttachmentGate, out: ServerFrame[]) => void): ServerFrame[] {
  const gate = new AttachmentGate()
  const out: ServerFrame[] = []
  steps(gate, out)
  return out
}

test('frames produced before readiness are buffered, then replayed once on attach', () => {
  const out = drive((gate, sink) => {
    sink.push(...gate.onFrame(SID, readyFrame())) // pre-attach: nothing live
    sink.push(...gate.onFrame(SID, pong('probe')))
    sink.push(...gate.onRendererReady()) // replay
  })
  expect(out.map(f => f.kind)).toEqual(['ready', 'pong'])
})

test('nothing is delivered live before readiness', () => {
  const gate = new AttachmentGate()
  expect(gate.onFrame(SID, readyFrame())).toEqual([])
  expect(gate.isAttached).toBe(false)
})

test('after attach, frames are forwarded live (not re-buffered for a second replay)', () => {
  const gate = new AttachmentGate()
  gate.onFrame(SID, readyFrame())
  gate.onRendererReady()
  expect(gate.isAttached).toBe(true)
  expect(gate.onFrame(SID, pong('live')).map(f => f.kind)).toEqual(['pong'])
})

test('a duplicate restore claim cannot reset or cancel the winning replay batch', () => {
  const gate = new AttachmentGate()
  gate.onRendererReady()
  gate.startReplayCoalescing(SID)
  expect(gate.onFrame(SID, readyFrame())).toEqual([])

  gate.startReplayCoalescing(SID)

  expect(gate.isReplayCoalescing(SID)).toBe(true)
  expect(gate.flushReplayCoalescing(SID)).toEqual([readyFrame()])
})

test('lazy restore bootstrap and replay flush as one batch on first post-replay frame', () => {
  const gate = new AttachmentGate()
  gate.onRendererReady()
  gate.startReplayCoalescing(SID)

  expect(gate.onFrame(SID, readyFrame())).toEqual([])
  expect(gate.onFrame(SID, replayFrame(0))).toEqual([])
  expect(gate.onFrame(SID, replayFrame(1))).toEqual([])

  expect(gate.onFrame(SID, pong('live'))).toEqual([
    readyFrame(),
    replayFrame(0),
    replayFrame(1),
    pong('live'),
  ])
  expect(gate.isReplayCoalescing(SID)).toBe(false)
})

test('history truncation boundary stays before retained replay in the same batch', () => {
  const gate = new AttachmentGate()
  gate.onRendererReady()
  gate.startReplayCoalescing(SID)

  expect(gate.onFrame(SID, readyFrame())).toEqual([])
  expect(gate.onFrame(SID, historyTruncation())).toEqual([])
  expect(gate.onFrame(SID, replayFrame(0))).toEqual([])
  expect(gate.onFrame(SID, replayFrame(1))).toEqual([])

  expect(gate.onFrame(SID, pong('live'))).toEqual([
    readyFrame(),
    historyTruncation(),
    replayFrame(0),
    replayFrame(1),
    pong('live'),
  ])
})

test('lazy restore bootstrap and replay flush as one batch on the window', () => {
  const gate = new AttachmentGate()
  gate.onRendererReady()
  gate.startReplayCoalescing(SID)

  gate.onFrame(SID, readyFrame())
  gate.onFrame(SID, replayFrame(0))
  gate.onFrame(SID, replayFrame(1))

  expect(gate.flushReplayCoalescing(SID)).toEqual([
    readyFrame(),
    replayFrame(0),
    replayFrame(1),
  ])
  expect(gate.flushReplayCoalescing(SID)).toEqual([])
})

test('zero-history lazy restore holds ready until the window flush', () => {
  const gate = new AttachmentGate()
  gate.onRendererReady()
  gate.startReplayCoalescing(SID)

  expect(gate.onFrame(SID, readyFrame())).toEqual([])
  expect(gate.flushReplayCoalescing(SID)).toEqual([readyFrame()])
})

test('rewind reset, retained replay, and Edit result deliver as one batch', () => {
  const gate = new AttachmentGate()
  gate.onRendererReady()

  expect(gate.onFrame(SID, transcriptReset())).toEqual([])
  expect(gate.onFrame(SID, replayFrame(0))).toEqual([])
  expect(gate.onFrame(SID, replayFrame(1))).toEqual([])
  expect(gate.isReplayCoalescing(SID)).toBe(true)
  expect(gate.isLazyReplayCoalescing(SID)).toBe(false)

  expect(gate.onFrame(SID, sessionActionResult('editFromMessage'))).toEqual([
    transcriptReset(),
    replayFrame(0),
    replayFrame(1),
    sessionActionResult('editFromMessage'),
  ])
  expect(gate.isReplayCoalescing(SID)).toBe(false)
})

test('rewind byte accounting excludes delivery metadata added after sidecar replay caps', () => {
  const bareReplay = Array.from({ length: 8 }, (_, index) => replayFrame(index))
  const tracedReplay = Array.from(
    { length: bareReplay.length },
    (_, index) => tracedReplayFrame(index),
  )
  const sidecarReplayBytes = bareReplay.reduce(
    (total, frame) => total + serializedBytes(frame),
    0,
  )
  expect(
    tracedReplay.reduce(
      (total, frame) => total + serializedBytes(frame),
      0,
    ),
  ).toBeGreaterThan(sidecarReplayBytes)
  expect(
    Math.max(...tracedReplay.map(frame => serializedBytes(frame))),
  ).toBeLessThan(sidecarReplayBytes)

  const gate = new AttachmentGate(new FrameReplayBuffer(), {
    maxFrames: bareReplay.length,
    maxBytes: sidecarReplayBytes,
  })
  gate.onRendererReady()

  expect(gate.onFrame(SID, transcriptReset())).toEqual([])
  for (const frame of tracedReplay) {
    expect(gate.onFrame(SID, frame)).toEqual([])
  }
  expect(gate.onFrame(SID, sessionActionResult('editFromMessage'))).toEqual([
    transcriptReset(),
    ...tracedReplay,
    sessionActionResult('editFromMessage'),
  ])
})

test('rewind coalescing remains bounded when bare replay limits are exceeded', () => {
  const gate = new AttachmentGate(new FrameReplayBuffer(), {
    maxFrames: 1,
    maxBytes: 1024 * 1024,
  })
  gate.onRendererReady()

  expect(gate.onFrame(SID, transcriptReset())).toEqual([])
  expect(gate.onFrame(SID, tracedReplayFrame(0))).toEqual([])
  expect(gate.onFrame(SID, tracedReplayFrame(1))).toEqual([
    transcriptReset(),
    tracedReplayFrame(0),
    tracedReplayFrame(1),
  ])
  expect(gate.isReplayCoalescing(SID)).toBe(false)
})

test('zero-history rewind delivers reset and Edit result as one batch', () => {
  const gate = new AttachmentGate()
  gate.onRendererReady()

  expect(gate.onFrame(SID, transcriptReset())).toEqual([])
  expect(gate.onFrame(SID, sessionActionResult('editFromMessage'))).toEqual([
    transcriptReset(),
    sessionActionResult('editFromMessage'),
  ])
})

test('Branch results and ordinary live frames do not trigger rewind completion', () => {
  const gate = new AttachmentGate()
  gate.onRendererReady()

  expect(gate.onFrame(SID, sessionActionResult('branchFromMessage'))).toEqual([
    sessionActionResult('branchFromMessage'),
  ])
  expect(gate.onFrame(SID, pong('live'))).toEqual([pong('live')])
  expect(gate.isReplayCoalescing(SID)).toBe(false)

  expect(gate.onFrame(SID, transcriptReset())).toEqual([])
  expect(gate.onFrame(SID, replayFrame(0))).toEqual([])
  expect(gate.onFrame(SID, sessionActionResult('branchFromMessage'))).toEqual([])
  expect(gate.isReplayCoalescing(SID)).toBe(true)

  expect(gate.onFrame(SID, sessionActionResult('editFromMessage'))).toEqual([
    transcriptReset(),
    replayFrame(0),
    sessionActionResult('branchFromMessage'),
    sessionActionResult('editFromMessage'),
  ])
})

test('rewind coalescing is not eligible for the lazy restore flush timer', () => {
  const gate = new AttachmentGate()
  gate.onRendererReady()

  gate.onFrame(SID, transcriptReset())

  expect(gate.hasPendingReplayCoalescing(SID)).toBe(true)
  expect(gate.isLazyReplayCoalescing(SID)).toBe(false)
  expect(gate.flushReplayCoalescing(SID)).toEqual([transcriptReset()])
})

test('rewind lifecycle and error interruptions flush buffered frames', () => {
  for (const interruption of [connectionError(), exited()]) {
    const gate = new AttachmentGate()
    gate.onRendererReady()

    expect(gate.onFrame(SID, transcriptReset())).toEqual([])
    expect(gate.onFrame(SID, replayFrame(0))).toEqual([])
    expect(gate.onFrame(SID, interruption)).toEqual([
      transcriptReset(),
      replayFrame(0),
      interruption,
    ])
    expect(gate.isReplayCoalescing(SID)).toBe(false)
  }
})

test('lazy replay coalescing enforces frame and byte caps', () => {
  const countBounded = new AttachmentGate(new FrameReplayBuffer(), {
    maxFrames: 2,
    maxBytes: 1024 * 1024,
  })
  countBounded.onRendererReady()
  countBounded.startReplayCoalescing(SID)
  countBounded.onFrame(SID, readyFrame())
  countBounded.onFrame(SID, replayFrame(0))
  countBounded.onFrame(SID, replayFrame(1))
  expect(countBounded.onFrame(SID, replayFrame(2))).toEqual([
    readyFrame(),
    replayFrame(0),
    replayFrame(1),
  ])
  expect(countBounded.flushReplayCoalescing(SID)).toEqual([replayFrame(2)])

  const byteBounded = new AttachmentGate(new FrameReplayBuffer(), {
    maxFrames: 10,
    maxBytes: 1,
  })
  byteBounded.onRendererReady()
  byteBounded.startReplayCoalescing(SID)
  byteBounded.onFrame(SID, readyFrame())
  expect(byteBounded.onFrame(SID, replayFrame(0))).toEqual([
    readyFrame(),
    replayFrame(0),
  ])
  expect(byteBounded.isReplayCoalescing(SID)).toBe(false)
})

test('StrictMode double rendererReady replays only ONCE (no duplicate ready/probe)', () => {
  const out = drive((gate, sink) => {
    sink.push(...gate.onFrame(SID, readyFrame()))
    sink.push(...gate.onFrame(SID, pong('probe')))
    sink.push(...gate.onRendererReady()) // signal 1: replay
    sink.push(...gate.onRendererReady()) // signal 2 (StrictMode): must be empty
  })
  expect(out.map(f => f.kind)).toEqual(['ready', 'pong'])
  expect(out.filter(f => f.kind === 'ready')).toHaveLength(1)
})

test('a live frame between the two StrictMode signals is delivered exactly once', () => {
  // subscribe → ready+probe buffered → signal1 replays → LIVE frame → signal2.
  // The live frame must appear once (delivered live), not again on signal2.
  const out = drive((gate, sink) => {
    gate.onFrame(SID, readyFrame())
    gate.onFrame(SID, pong('probe'))
    sink.push(...gate.onRendererReady()) // replay: ready, probe
    sink.push(...gate.onFrame(SID, pong('live'))) // live: live
    sink.push(...gate.onRendererReady()) // StrictMode repeat: empty
  })
  const nonces = out.filter(f => f.kind === 'pong').map(f => (f.kind === 'pong' ? f.nonce : ''))
  expect(out.map(f => f.kind)).toEqual(['ready', 'pong', 'pong'])
  expect(nonces).toEqual(['probe', 'live'])
  // 'live' appears exactly once.
  expect(nonces.filter(n => n === 'live')).toHaveLength(1)
})

test('reload re-arms: navigation start makes the next rendererReady replay again', () => {
  const out = drive((gate, sink) => {
    gate.onFrame(SID, readyFrame())
    gate.onFrame(SID, pong('probe'))
    sink.push(...gate.onRendererReady()) // first load: ready, probe
    sink.length = 0 // ignore first load's delivery; focus on the reload
    gate.onNavigationStart() // reload begins
    expect(gate.isAttached).toBe(false)
    sink.push(...gate.onRendererReady()) // reloaded renderer catches up again
  })
  expect(out.map(f => f.kind)).toEqual(['ready', 'pong'])
})

test('a frame arriving during a reload (post-nav, pre-ready) is buffered then replayed', () => {
  const out = drive((gate, sink) => {
    gate.onFrame(SID, readyFrame())
    gate.onRendererReady()
    gate.onNavigationStart() // reload; live-forwarding is now off
    sink.push(...gate.onFrame(SID, pong('mid-reload'))) // must NOT go live
    sink.push(...gate.onRendererReady()) // replay includes it
  })
  // The mid-reload frame was not delivered live (empty during reload window)…
  // …and shows up in the post-reload replay after the ready head.
  expect(out.map(f => f.kind)).toEqual(['ready', 'pong'])
  expect(out.some(f => f.kind === 'pong' && f.nonce === 'mid-reload')).toBe(true)
})

test('reset() (macOS window-all-closed) drops the buffer and detaches', () => {
  const gate = new AttachmentGate()
  gate.onFrame(SID, readyFrame())
  gate.onRendererReady()
  gate.reset()
  expect(gate.isAttached).toBe(false)
  // After reset the next readiness signal has nothing to replay.
  expect(gate.onRendererReady()).toEqual([])
})

test('clearSession() drops stale replay while preserving the attached renderer', () => {
  const gate = new AttachmentGate()
  gate.onFrame(SID, readyFrame())
  gate.onFrame(SID, pong('old'))
  gate.onRendererReady()

  gate.clearSession(SID)

  expect(gate.isAttached).toBe(true)
  expect(gate.onFrame(SID, pong('replacement-live'))).toEqual([
    pong('replacement-live'),
  ])
  gate.onNavigationStart()
  expect(gate.onRendererReady()).toEqual([pong('replacement-live')])
})

test('terminal lifecycle can be delivered live and then evicted before reload replay', () => {
  const gate = new AttachmentGate()
  gate.onFrame(SID, readyFrame())
  gate.onFrame(SID, pong('before-exit'))
  gate.onFrame('keep-me', readyFrame('keep-me'))
  gate.onRendererReady()

  expect(gate.onFrame(SID, exited())).toEqual([exited()])
  gate.clearSession(SID)

  gate.onNavigationStart()
  expect(gate.onRendererReady().map(frame => frame.sessionId)).toEqual(['keep-me'])
})

test('an injected buffer is used (cap/retention delegated to FrameReplayBuffer)', () => {
  const gate = new AttachmentGate(new FrameReplayBuffer(1))
  gate.onFrame(SID, readyFrame())
  gate.onFrame(SID, pong('a'))
  gate.onFrame(SID, pong('b')) // evicts 'a' at cap 1
  const out = gate.onRendererReady()
  expect(out.map(f => f.kind)).toEqual(['ready', 'error', 'pong'])
  expect(isReplayTruncationFrame(out[1])).toBe(true)
  expect(out[2]).toMatchObject({ nonce: 'b' })
})

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}
